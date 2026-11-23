"use strict";
const CFG = {"url": "https://laektajfojnzcnchddiy.supabase.co", "key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhZWt0YWpmb2puemNuY2hkZGl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzOTMwMDAsImV4cCI6MjExMDk2OTAwMH0.l2TgPsp_LGM7CnhPg2jNJly3ic5TWRVGWO4tcBdSH60"};
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gbScale = g => clamp(0.48 + Math.sqrt(Math.max(0.25, +g || 0.25)) * 0.26, 0.45, 1.85);
const keys = new Set();

// ------------------------------------------------------------------ cloud access (website build only)
let sess = null; try { sess = JSON.parse(sessionStorage.getItem("legpt") || "null"); } catch (e) {}
async function raw(path, opt = {}, auth = true, retry = true) {
  const h = { apikey: CFG.key, "Content-Type": "application/json", ...(opt.headers || {}) };
  if (auth) { await ensure(); h.Authorization = "Bearer " + sess.access; }
  const r = await fetch(CFG.url + path, { method: opt.method || "GET", headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined, cache: "no-store" });
  if (r.status === 401 && auth && retry) { sess.exp = 0; return raw(path, opt, auth, false); }
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) {}
  if (!r.ok) throw new Error((j && (j.msg || j.message)) || "HTTP " + r.status);
  return j;
}
async function ensure() {
  if (!sess) throw new Error("signed out");
  if (Date.now() < sess.exp - 60000) return;
  const j = await raw("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: sess.refresh } }, false);
  sess = { access: j.access_token, refresh: j.refresh_token, exp: j.expires_at ? j.expires_at * 1000 : Date.now() + j.expires_in * 1000, uid: (j.user || {}).id || sess.uid };
  sessionStorage.setItem("legpt", JSON.stringify(sess));       // the control page shares this tab's session: keep its refresh token current
}

// ------------------------------------------------------------------ state
const DEMO = { agent_name: "Le GPT", model_name: "Llama 3.2 3B Instruct", state: "IDLE", goal: "", say: "", active_site: "",
  ram: { total: 16384, used: 6144, free: 10240, os: 2200, lm: 2450, agent: 350, other: 1400 }, apps: [], workspace_files: [], allowed_cmds: [], ports: [], vault: {}, events: [], pc2: {} };
let S = DEMO, live = false, firstLoad = true, lastSeq = 0, intentSeen = 0, queue = [];
const pc2 = { name: "Second PC", ip: "10.10.0.2", usedGb: 4, freeGb: 12, online: false, configured: false };
try { Object.assign(pc2, JSON.parse(localStorage.getItem("legpt_pc2_manual") || "{}")); } catch (e) {}
const msgs = [], packets = [];
function pushMsg(dir, text) {
  msgs.unshift({ dir, text: String(text).slice(0, 90), t: new Date().toLocaleTimeString([], { hour12: false }) }); msgs.length = Math.min(msgs.length, 10);
  packets.push({ dir, p: 0 });
  $("msgLog").innerHTML = msgs.map(m => `<li class="${m.dir === "rx" ? "rx" : ""}"><b>${m.dir === "tx" ? "TX LM→PC2" : "RX PC2→LM"}</b> [${esc(m.t)}] ${esc(m.text)}</li>`).join("");
}
function syncPc2() {
  const p = S.pc2 || {};
  if (live) {
    pc2.configured = !!p.configured;
    if (p.configured) { pc2.name = String(p.name || pc2.name).slice(0, 28); pc2.ip = String(p.ip || pc2.ip); pc2.online = !!p.online;
      if (p.online && p.ram && p.ram.total) { pc2.usedGb = Math.round(p.ram.used / 512) / 2; pc2.freeGb = Math.max(0.5, Math.round(p.ram.free / 512) / 2); } }
  }
  document.querySelectorAll(".sim").forEach(e => e.classList.toggle("hide", live));
  ["p2name", "p2ip", "p2used", "p2free"].forEach(id => { $(id).disabled = live; });
  if (document.activeElement !== $("p2name")) { $("p2name").value = pc2.name; $("p2ip").value = pc2.ip; $("p2used").value = pc2.usedGb; $("p2free").value = pc2.freeGb; }
  const state = live ? (pc2.configured ? (pc2.online ? "online" : "OFFLINE") : "not set up (/pc2 add ...)") : "demo values";
  $("bridgeSummary").textContent = `${pc2.name} (${pc2.ip}) — ${state}: ${pc2.freeGb.toFixed(1)} GB free, ${pc2.usedGb.toFixed(1)} GB used`;
  $("hdrP2").textContent = live && !pc2.configured ? "—" : pc2.freeGb.toFixed(1) + " GB";
}
$("p2apply").onclick = () => {
  if (live) return;
  Object.assign(pc2, { name: ($("p2name").value || "Second PC").slice(0, 28), ip: ($("p2ip").value || "10.10.0.2").slice(0, 24),
    usedGb: clamp(+$("p2used").value || 4, 0.5, 512), freeGb: clamp(+$("p2free").value || 12, 0.5, 512) });
  try { localStorage.setItem("legpt_pc2_manual", JSON.stringify(pc2)); } catch (e) {}
  syncPc2(); refresh();
};
$("sendMsg").onclick = () => pushMsg("tx", `Msg → ${pc2.ip}: "${(S.goal || "task payload").slice(0, 30)}"`);
$("simReply").onclick = () => pushMsg("rx", `Reply ← ${pc2.name}: ack`);

// ------------------------------------------------------------------ numbers -> sizes
let M = {}, L = {};
function lmUsable() {
  const allowed = new Set((S.allowed_cmds || []).map(c => String(c).toLowerCase()));
  const ws = (S.workspace_files || []).map(f => String(f.name || f).toLowerCase().replace(/\.[^.]+$/, "")).filter(Boolean);
  const items = []; let total = 0;
  for (const a of S.apps || []) {
    const raw = String(a.name || ""), low = raw.toLowerCase().replace(/\.exe$/, ""), mb = Math.max(0, +a.mb || 0);
    if (mb > 0 && (allowed.has(low) || allowed.has(raw.toLowerCase()) || /notepad|calc|python|chrome|playwright/.test(low) || ws.some(w => low.includes(w)))) { items.push({ name: raw, mb }); total += mb; }
  }
  const ag = Math.max(0, +((S.ram || {}).agent) || 0);
  if (ag > 1) { items.unshift({ name: `${S.agent_name || "Le GPT"} runtime`, mb: ag }); total += ag; }
  return { items: items.slice(0, 8), total };
}
function compute() {
  const r = S.ram || {}, totalMb = Math.max(1024, +r.total || 16384), usedMb = Math.max(0, +r.used || 0), lmMb = Math.max(0, +r.lm || 0), u = lmUsable();
  const totalGb = totalMb / 1024, pcGb = Math.min(totalGb, Math.max(256, usedMb - u.total - lmMb) / 1024), lmGb = Math.max(0.5, totalGb - pcGb);
  M = { totalGb, pcGb, lmGb, lmS: clamp(0.65 + Math.sqrt(lmGb) * 0.28, 0.8, 1.95), pcS: gbScale(pcGb), p2u: gbScale(pc2.usedGb), p2f: gbScale(pc2.freeGb),
    items: u.items.map(i => ({ ...i, share: clamp(i.mb / Math.max(512, lmGb * 1024), 0.03, 0.45) })), usableMb: u.total };
  $("ovLm").textContent = M.lmGb.toFixed(2) + " GB"; $("ovPc").textContent = M.pcGb.toFixed(2) + " GB";
  $("ovP2u").textContent = pc2.usedGb.toFixed(1) + " GB"; $("ovP2f").textContent = pc2.freeGb.toFixed(1) + " GB"; $("ovItems").textContent = M.items.length;
}
function layout() {
  const w = Math.round(460 * M.lmS), h = Math.round(340 * M.lmS), x = 760, y = 230, T = 18;
  const pw = Math.round(250 * M.pcS), ph = Math.round(190 * M.pcS), uw = Math.round(250 * M.p2u), uh = Math.round(190 * M.p2u), fw = Math.round(380 * M.p2f), fh = Math.round(250 * M.p2f);
  const by = y + h + 165, cx = x + w / 2 - (uw + 36 + fw) / 2, boxes = [];
  M.items.forEach((it, i) => {
    const bw = clamp(82 + Math.sqrt(it.share) * 240, 96, w * 0.32), bh = clamp(36 + Math.sqrt(it.share) * 120, 40, h * 0.22);
    const bx = x + T + 20 + (i % 2) * w * 0.44, byy = y + T + 38 + Math.floor(i / 2) * (bh + 16);
    if (byy + bh < y + h - T - 12) boxes.push({ x: bx, y: byy, w: bw, h: bh, name: it.name, mb: it.mb });
  });
  L = { lm: { x, y, w, h }, pc1: { x: x + w + 175, y: y + (h - ph) / 2, w: pw, h: ph }, p2u: { x: cx, y: by + (fh - uh) / 2, w: uw, h: uh }, p2f: { x: cx + uw + 36, y: by, w: fw, h: fh },
    bridge: { x: x + w / 2 - 52, y: y + h - T, w: 104, h: T }, resp: { x: x + w - T, y: y + h / 2 - 32, w: T, h: 64 }, boxes, T };
}

// ------------------------------------------------------------------ what the LM is doing: look around, announce, approach, act
const A = { x: 980, y: 390, trail: [] }, B = { phase: "LOOKING", t: 1.5, ang: 0, tgt: null };
function targetFor(kind, label, text) {
  const l = String(label || "").toLowerCase(), c = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  if (kind === "bridge") return { text, x: L.bridge.x + L.bridge.w / 2, y: L.bridge.y - 26 };
  if (kind === "google" || kind === "response") return { text, x: L.resp.x - 28, y: L.resp.y + L.resp.h / 2 };
  if (kind === "port") { const ps = S.ports || []; let i = ps.findIndex(p => l && (String(p.site || "").toLowerCase().includes(l) || l.includes(String(p.site || "").toLowerCase()) || String(p.label || "").toLowerCase() === l)); if (i < 0) i = 0; return { text, x: L.lm.x + 24, y: L.lm.y + 52 + i * 38 }; }
  if (kind === "app" || kind === "workspace") { const b = L.boxes.find(b => l && b.name.toLowerCase().includes(l)); if (b) return { text, ...c(b) }; }
  return { text, ...c(L.lm) };
}
function randomTarget() {
  const c = [targetFor("bridge", "", `Will send a bridge message to ${pc2.name} (${pc2.freeGb.toFixed(1)} GB free)`), targetFor("response", "", "Will send the answer through the response door"), targetFor("port", "", "Will look at a link port")];
  L.boxes.forEach(b => c.push(targetFor("app", b.name, `Will use "${b.name}" (${Math.round(b.mb)} MB)`)));
  return c[Math.floor(Math.random() * c.length)];
}
function addIntent(e) { if (!e || !(e.i > intentSeen)) return; intentSeen = e.i; e._at = performance.now(); queue.push(e); }
function nextTarget() {
  if (!live) { B.t = 1.8; return randomTarget(); }
  while (queue.length) {
    const e = queue.shift(); if (performance.now() - e._at > (e.ms || 1500) + 3500) continue;     // too late to be useful
    B.t = clamp((e.ms || 1500) / 1000 * 0.6, 0.5, 5); return targetFor(e.d, e.label, e.t);
  }
  return null;
}
function behave(dt) {
  if (String(S.state).toUpperCase() === "PAUSED") return;
  if (B.phase === "LOOKING") {
    B.ang += dt * (live && !B.tgt ? 0.8 : 3.2);
    if (!B.tgt) B.tgt = nextTarget();
    if (B.tgt && (B.t -= dt) <= 0) B.phase = "APPROACHING";
  } else if (B.phase === "APPROACHING") {
    const dx = B.tgt.x - A.x, dy = B.tgt.y - A.y, d = Math.hypot(dx, dy);
    if (d > 8) { const s = Math.min(d, 125 * dt); A.x += dx / d * s; A.y += dy / d * s; B.ang = Math.atan2(dy, dx); }
    else { B.phase = "ACTING"; B.t = 0.9; if (!live && B.tgt.text.includes("bridge message")) pushMsg("tx", `Bridged msg → ${pc2.ip}`); }
  } else {
    B.t -= dt; B.ang += dt * 4.5;
    if (B.t <= 0) { B.phase = "LOOKING"; B.tgt = null; B.t = 1.5; }
  }
  A.trail.push({ x: A.x, y: A.y }); if (A.trail.length > 30) A.trail.shift();
  const label = B.phase === "LOOKING" ? (B.tgt || !live ? "LOOKING AROUND" : "IDLE") : B.phase === "APPROACHING" ? "ABOUT TO ACT" : "ACTING";
  const txt = B.tgt ? B.tgt.text : "Idle — waiting for the next action";
  $("phase").textContent = label; $("intentTxt").textContent = txt; $("infoPhase").textContent = label; $("infoIntent").textContent = txt;
  $("banner").classList.toggle("quiet", !B.tgt);
}
function ingest(evs) {
  const mx = (evs || []).reduce((m, e) => Math.max(m, e.i || 0), 0);
  if (firstLoad) { lastSeq = mx; intentSeen = Math.max(intentSeen, mx); firstLoad = false; return; }
  for (const e of evs || []) {
    if (!(e.i > lastSeq)) continue;
    if (e.k === "intent") addIntent(e);
    else if (e.k === "bridge_tx") pushMsg("tx", e.cargo || e.d || "message");
    else if (e.k === "bridge_rx") pushMsg("rx", e.cargo || e.d || "reply");
  }
  lastSeq = Math.max(lastSeq, mx);
}

// ------------------------------------------------------------------ 2D
const cv = $("cv"), ctx = cv.getContext("2d"), cam = { x: 420, y: 260, z: 1, drag: false, lx: 0, ly: 0 };
let is3D = true;
function clampCam() { cam.x = clamp(cam.x, 0, Math.max(0, 2400 - cv.width / cam.z)); cam.y = clamp(cam.y, 0, Math.max(0, 1600 - cv.height / cam.z)); if (!is3D) $("zoomTxt").textContent = "2D zoom " + Math.round(cam.z * 100) + "%"; }
cv.addEventListener("pointerdown", e => { cam.drag = true; cam.lx = e.clientX; cam.ly = e.clientY; });
addEventListener("pointerup", () => { cam.drag = false; });
addEventListener("pointermove", e => { if (!cam.drag || is3D) return; cam.x -= (e.clientX - cam.lx) / cam.z; cam.y -= (e.clientY - cam.ly) / cam.z; cam.lx = e.clientX; cam.ly = e.clientY; clampCam(); });
cv.addEventListener("wheel", e => { if (is3D) return; e.preventDefault(); const p = cam.z, r = cv.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * cv.width, sy = (e.clientY - r.top) / r.height * cv.height, wx = cam.x + sx / p, wy = cam.y + sy / p; cam.z = clamp(cam.z * (e.deltaY > 0 ? 0.9 : 1.1), 0.5, 2.2); cam.x = wx - sx / cam.z; cam.y = wy - sy / cam.z; clampCam(); }, { passive: false });
function box(r, col, lw) { ctx.strokeStyle = col; ctx.lineWidth = lw || 2.5; ctx.strokeRect(r.x, r.y, r.w, r.h); }
function txt(s, x, y, col, size, bold, align) { ctx.fillStyle = col; ctx.font = `${bold ? "700 " : ""}${size}px system-ui,sans-serif`; ctx.textAlign = align || "left"; ctx.fillText(s, x, y); ctx.textAlign = "left"; }
function draw2D() {
  ctx.save(); ctx.fillStyle = "#04070e"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.scale(cam.z, cam.z); ctx.translate(-cam.x, -cam.y);
  ctx.strokeStyle = "rgba(56,189,248,.045)"; ctx.lineWidth = 1;
  for (let g = 0; g <= 2400; g += 60) { ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, 1600); ctx.stroke(); }
  for (let g = 0; g <= 1600; g += 60) { ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(2400, g); ctx.stroke(); }
  const { lm, pc1, resp, bridge } = L;
  box(lm, "#a78bfa"); txt(`LM BOX • ${M.lmGb.toFixed(2)} GB`, lm.x + 16, lm.y + 26, "#ddd6fe", 13, true);
  (S.ports && S.ports.length ? S.ports.slice(0, 6) : [{ label: "Default link port" }]).forEach((p, i) => { const py = lm.y + 52 + i * 38; if (py < lm.y + lm.h - 28) { box({ x: lm.x - 9, y: py - 8, w: 18, h: 16 }, p.bad ? "#f87171" : p.active ? "#38bdf8" : "#34d399", 2); txt("← " + String(p.label || p.site || "port").slice(0, 18), lm.x - 140, py + 4, "#6ee7b7", 11); } });
  ctx.fillStyle = "#04070e"; ctx.fillRect(resp.x, resp.y, resp.w, resp.h); box(resp, "#38bdf8"); txt("RESPONSE DOOR →", lm.x + lm.w + 14, resp.y + 36, "#7dd3fc", 11, true);
  ctx.fillStyle = "#04070e"; ctx.fillRect(bridge.x, bridge.y, bridge.w, bridge.h); box(bridge, "#f59e0b"); txt("MSG BRIDGE DOOR", bridge.x + 4, bridge.y + bridge.h + 15, "#fcd34d", 10.5, true);
  const sx = bridge.x + bridge.w / 2, sy = bridge.y + bridge.h, ex = L.p2u.x + L.p2u.w / 2, ey = L.p2u.y;
  ctx.strokeStyle = pc2.online || !live ? "#f59e0b" : "#52617f"; ctx.lineWidth = 3; ctx.setLineDash([8, 6]); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke(); ctx.setLineDash([]);
  for (const k of packets) { const t = k.dir === "tx" ? k.p : 1 - k.p; ctx.fillStyle = k.dir === "tx" ? "#fbbf24" : "#34d399"; ctx.beginPath(); ctx.arc(sx + (ex - sx) * t, sy + (ey - sy) * t, 6, 0, 7); ctx.fill(); }
  txt(`ETHERNET MSG BRIDGE (${pc2.ip})`, sx + 12, (sy + ey) / 2, "#fbbf24", 11, true);
  for (const b of L.boxes) { box(b, "#2dd4bf", 1.8); txt(b.name.slice(0, 18), b.x + 8, b.y + 17, "#99f6e4", 11, true); txt(Math.round(b.mb) + " MB", b.x + 8, b.y + 31, "#cbd5e1", 10); }
  ctx.strokeStyle = "rgba(251,191,36,.45)"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.arc(A.x, A.y, 68, B.ang - 0.35, B.ang + 0.35); ctx.closePath(); ctx.stroke();
  if (B.tgt) { ctx.setLineDash([5, 5]); ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.tgt.x, B.tgt.y); ctx.stroke(); ctx.setLineDash([]); }
  for (let i = 1; i < A.trail.length; i++) { ctx.strokeStyle = `rgba(251,191,36,${i / A.trail.length * 0.35})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(A.trail[i - 1].x, A.trail[i - 1].y); ctx.lineTo(A.trail[i].x, A.trail[i].y); ctx.stroke(); }
  ctx.fillStyle = "#fbbf24"; ctx.strokeStyle = "#fef08a"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(A.x, A.y, 14, 0, 7); ctx.fill(); ctx.stroke();
  txt(S.agent_name || "Le GPT", A.x, A.y - 20, "#fef08a", 11, true, "center");
  box(pc1, "#60a5fa"); txt(`PC #1 USED • ${M.pcGb.toFixed(2)} GB`, pc1.x + 12, pc1.y + 24, "#bfdbfe", 12, true);
  box(L.p2u, pc2.online || !live ? "#f59e0b" : "#52617f"); txt(`${pc2.name} USED`, L.p2u.x + 12, L.p2u.y + 22, "#fde68a", 12, true); txt(pc2.usedGb.toFixed(2) + " GB", L.p2u.x + 12, L.p2u.y + 40, "#cbd5e1", 11);
  box(L.p2f, "#38bdf8"); txt(`PC #2 FREE (BRIDGEABLE) • ${pc2.freeGb.toFixed(2)} GB`, L.p2f.x + 14, L.p2f.y + 24, "#bae6fd", 12, true);
  txt(live && pc2.configured && !pc2.online ? "PC #2 is offline" : "Room for messages from the LM (no LM runs on PC #2)", L.p2f.x + 14, L.p2f.y + 44, "#94a3b8", 11);
  ctx.restore();
}

// ------------------------------------------------------------------ 3D
let T3 = null;
function outline(w, h, d, col) {
  const g = new THREE.Group(), e = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), new THREE.LineBasicMaterial({ color: col }));
  e.position.y = h / 2; g.add(e);
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2], [-w / 2, -d / 2]].map(p => new THREE.Vector3(p[0], 0.03, p[1]))), new THREE.LineBasicMaterial({ color: col })));
  return g;
}
function line3(a, b, col) { return new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), new THREE.LineBasicMaterial({ color: col })); }
function frame3(w, h, d, col, x, y, z) { const f = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), new THREE.LineBasicMaterial({ color: col })); f.position.set(x, y, z); return f; }
function disposeTree(o) { o.traverse(n => { if (n.geometry) n.geometry.dispose(); if (n.material) n.material.dispose(); }); }
let sig3 = "";
function build3D() {
  const s = JSON.stringify([M.lmS.toFixed(2), M.pcS.toFixed(2), M.p2u.toFixed(2), M.p2f.toFixed(2), M.items.map(i => [i.name, i.share.toFixed(2)]), (S.ports || []).map(p => [p.label, p.active, p.bad])]);
  if (!T3 || s === sig3) return; sig3 = s;
  if (T3.world) { T3.scene.remove(T3.world); disposeTree(T3.world); }
  const W = new THREE.Group(), lmW = 8.4 * M.lmS, lmD = 7.2 * M.lmS, lmH = 3.2 * clamp(M.lmS * 0.9, 0.85, 1.5), lx = -2.8, lz = -1.8;
  const lm = outline(lmW, lmH, lmD, 0xa78bfa); lm.position.set(lx, 0, lz); W.add(lm);
  const ports = (S.ports && S.ports.length ? S.ports.slice(0, 8) : [{}]);
  ports.forEach((p, i) => { const z = (ports.length === 1 ? 0 : i / (ports.length - 1) - 0.5) * lmD * 0.72, c = p.bad ? 0xf87171 : p.active ? 0x38bdf8 : 0x34d399;
    lm.add(frame3(0.45, 1.15, 1.15, c, -lmW / 2, 0.85, z)); lm.add(line3([-lmW / 2, 0.85, z], [-lmW / 2 - 0.85, 0.85, z], c)); });
  lm.add(frame3(0.5, 1.8, 1.6, 0x38bdf8, lmW / 2, 1, 0)); lm.add(line3([lmW / 2, 1, 0], [lmW / 2 + 1.4, 1, 0], 0x38bdf8));
  lm.add(frame3(1.6, 1.6, 0.5, 0xf59e0b, 0, 0.9, lmD / 2));
  const cols = Math.min(3, M.items.length || 1), rows = Math.ceil(M.items.length / cols);
  M.items.forEach((it, i) => { const f = clamp(0.55 + Math.sqrt(it.share) * 3.1, 0.65, 2.4), bw = Math.min(lmW * 0.26, 0.95 * f), bd = Math.min(lmD * 0.26, 0.95 * f), bh = Math.min(2.2, 0.55 + it.share * 3.5);
    const o = outline(bw, bh, bd, 0x2dd4bf); o.position.set(-lmW * 0.34 + lmW * 0.68 / cols * (i % cols + 0.5), 0, -lmD * 0.34 + lmD * 0.68 / rows * (Math.floor(i / cols) + 0.5)); lm.add(o); });
  const pcW = 5.4 * M.pcS, pcH = 2.6 * clamp(M.pcS * 0.92, 0.75, 1.45), pc = outline(pcW, pcH, pcW, 0x60a5fa); pc.position.set(lx + 2.2 + lmW / 2 + pcW / 2, 0, lz); W.add(pc);
  const uw = 5.4 * M.p2u, uh = 2.6 * clamp(M.p2u * 0.92, 0.75, 1.45), fw = 7.6 * M.p2f, fh = 3 * clamp(M.p2f * 0.92, 0.8, 1.5), fd = 6.6 * M.p2f;
  const z2 = lz + lmD / 2 + 3.4 + Math.max(uw, fd) / 2, gap = 1.4 + uw / 2 + fw / 2, cx = lx - gap * 0.35;
  const u = outline(uw, uh, uw, 0xf59e0b); u.position.set(cx - gap / 2, 0, z2); W.add(u);
  const f = outline(fw, fh, fd, 0x38bdf8); f.position.set(cx + gap / 2, 0, z2); W.add(f);
  W.add(line3([lx, 0.7, lz + lmD / 2], [u.position.x, 0.7, z2 - uw / 2], 0xf59e0b));
  T3.world = W; T3.scene.add(W); T3.lm = { x: lx, z: lz, w: lmW, d: lmD }; T3.bridge = { sx: lx, sz: lz + lmD / 2, ex: u.position.x, ez: z2 - uw / 2 };
}
function initThree() {
  if (T3 || !window.THREE) return;
  const host = $("host"), scene = new THREE.Scene(); scene.background = new THREE.Color(0x04070e);
  const w = host.clientWidth || 1000, h = host.clientHeight || 600, camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 200), renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(w, h); host.innerHTML = ""; host.appendChild(renderer.domElement); scene.add(new THREE.GridHelper(60, 60, 0x243656, 0x0d1628));
  const agent = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(0.46, 16, 16)), new THREE.LineBasicMaterial({ color: 0xfbbf24 })); scene.add(agent);
  const scan = line3([0, 0, 0], [2.2, 0, 0], 0xfbbf24); scene.add(scan);
  const pool = []; for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.28, 0), new THREE.MeshBasicMaterial({ color: 0xfbbf24, wireframe: true })); m.visible = false; scene.add(m); pool.push(m); }
  T3 = { scene, camera, renderer, agent, scan, pool, tgt: new THREE.Vector3(1.5, 0.8, 1), yaw: -0.35, pitch: 0.56, r: 28, ax: -2.8, az: -1.8 };
  cam3(); build3D();
  let drag = false, btn = 0, lx = 0, ly = 0; const el = renderer.domElement;
  el.addEventListener("contextmenu", e => e.preventDefault()); el.addEventListener("pointerdown", e => { drag = true; btn = e.button; lx = e.clientX; ly = e.clientY; });
  addEventListener("pointerup", () => { drag = false; });
  addEventListener("pointermove", e => { if (!drag || !is3D) return; const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    if (btn === 2 || e.shiftKey) { T3.tgt.x -= dx * 0.025; T3.tgt.z += dy * 0.025; } else { T3.yaw -= dx * 0.0075; T3.pitch = clamp(T3.pitch + dy * 0.0075, 0.14, 1.32); } cam3(); });
  el.addEventListener("wheel", e => { if (!is3D) return; e.preventDefault(); T3.r = clamp(T3.r + (e.deltaY > 0 ? 1.8 : -1.8), 7, 56); cam3(); }, { passive: false });
  addEventListener("resize", () => { const nw = host.clientWidth || 1000, nh = host.clientHeight || 600; camera.aspect = nw / nh; camera.updateProjectionMatrix(); renderer.setSize(nw, nh); });
}
function cam3() { const c = T3.camera, hz = T3.r * Math.cos(T3.pitch); c.position.set(T3.tgt.x + hz * Math.sin(T3.yaw), Math.max(1.8, T3.tgt.y + T3.r * Math.sin(T3.pitch)), T3.tgt.z + hz * Math.cos(T3.yaw)); c.lookAt(T3.tgt); }
function frame3D(dt, now) {
  if (!T3) return; const pan = 14 * dt; let mv = false;
  if (keys.has("a") || keys.has("arrowleft")) { T3.tgt.x -= pan; mv = true; } if (keys.has("d") || keys.has("arrowright")) { T3.tgt.x += pan; mv = true; }
  if (keys.has("w") || keys.has("arrowup")) { T3.tgt.z -= pan; mv = true; } if (keys.has("s") || keys.has("arrowdown")) { T3.tgt.z += pan; mv = true; }
  if (mv) cam3(); behave(dt); build3D(); const l = T3.lm || { x: -2.8, z: -1.8, w: 8, d: 7 };
  const u = clamp((A.x - L.lm.x) / L.lm.w - 0.5, -0.46, 0.46), v = clamp((A.y - L.lm.y) / L.lm.h - 0.5, -0.46, 0.46);    // where the 2D square is, shown inside the 3D box
  T3.ax += (l.x + u * l.w - T3.ax) * Math.min(1, dt * 6); T3.az += (l.z + v * l.d - T3.az) * Math.min(1, dt * 6);
  T3.agent.position.set(T3.ax, 0.55, T3.az); T3.agent.rotation.y += dt * 1.4; T3.scan.position.copy(T3.agent.position); T3.scan.rotation.y = -B.ang;
  const b = T3.bridge; T3.pool.forEach((m, i) => { const k = packets[i]; m.visible = !!(k && b); if (k && b) { const t = k.dir === "tx" ? k.p : 1 - k.p; m.position.set(b.sx + (b.ex - b.sx) * t, 0.7, b.sz + (b.ez - b.sz) * t); m.material.color.set(k.dir === "tx" ? 0xfbbf24 : 0x34d399); } });
  T3.renderer.render(T3.scene, T3.camera);
}
function setMode(three) {
  is3D = three; $("m3d").classList.toggle("active", three); $("m2d").classList.toggle("active", !three); $("host").style.display = three ? "block" : "none"; cv.style.display = three ? "none" : "block";
  if (three) { initThree(); $("zoomTxt").textContent = "3D"; $("hint").textContent = "3D: drag to orbit • wheel to zoom • right-drag or WASD to pan"; }
  else { resetView(); $("hint").textContent = "2D: drag to pan • wheel to zoom • WASD / arrows to pan"; }
}
function resetView() { if (is3D && T3) { T3.tgt.set(1.5, 0.8, 1); T3.yaw = -0.35; T3.pitch = 0.56; T3.r = 28; cam3(); } else { cam.z = 1; cam.x = Math.max(0, L.lm.x + L.lm.w / 2 - cv.width * 0.48); cam.y = Math.max(0, L.lm.y + L.lm.h / 2 - cv.height * 0.36); clampCam(); } }
$("m3d").onclick = () => setMode(true); $("m2d").onclick = () => setMode(false); $("resetCam").onclick = resetView;
addEventListener("keydown", e => { if (!/INPUT|TEXTAREA/.test((e.target || {}).tagName || "")) keys.add(e.key.toLowerCase()); }); addEventListener("keyup", e => keys.delete(e.key.toLowerCase()));

// ------------------------------------------------------------------ sidebar
function sidebar() {
  const st = String(S.state || "IDLE").toUpperCase(); $("hdrAgent").textContent = S.agent_name || "Le GPT"; $("hdrModel").textContent = S.active_model || S.model_name || "model";
  $("hdrState").textContent = st; $("stateDot").className = "dot" + (/PAUS/.test(st) ? " paused" : /WAIT|APPROV/.test(st) ? " waiting" : /ERR|STOP|SIGNED/.test(st) ? " error" : "");
  $("hdrLm").textContent = M.lmGb.toFixed(2) + " GB"; $("hdrPc").textContent = M.pcGb.toFixed(2) + " / " + M.totalGb.toFixed(1) + " GB";
  $("infoSite").textContent = S.active_site || "none"; $("infoGoal").textContent = S.goal || "None"; $("infoSay").textContent = S.say || "—";
  $("lmFiles").innerHTML = M.items.length ? M.items.map(i => `<div>• <b>${esc(i.name)}</b> — ${Math.round(i.mb)} MB</div>`).join("") : "None running (the LM floor is open).";
  $("portList").innerHTML = (S.ports || []).length ? S.ports.slice(0, 8).map(p => `<div>• <b>${esc(String(p.label || p.site).slice(0, 22))}</b> (${esc(p.site)})</div>`).join("") : "No saved links yet (/link add ...).";
  const v = S.vault || {}; $("vault").innerHTML = [["Links", v.link], ["Recipes", v.recipe], ["Findings", v.finding], ["Notes", v.user], ["Pages", v.page]].map(([k, n]) => `<div class="vi"><span>${k}</span><b>${+n || 0}</b></div>`).join("");
  $("events").innerHTML = (S.events || []).slice(-14).reverse().map(e => `<li class="${e.k === "blocked" ? "blocked" : e.k === "deposit" ? "deposit" : e.k === "wait" ? "wait" : ""}"><b>${esc(e.k)}</b> ${esc(e.d || e.label || "")} ${e.cargo ? "• " + esc(e.cargo) : ""}${e.t ? " — " + esc(e.t) : ""}</li>`).join("") || "<li>Waiting for events…</li>";
}
function refresh() { compute(); layout(); sidebar(); }

// ------------------------------------------------------------------ data
let beat = 0;
function goLive() { if (!live) { live = true; B.tgt = null; B.phase = "LOOKING"; B.t = 1.5; packets.length = 0; } }      // drop the demo animation the moment real data arrives
async function poll() {
  let wait = 1000;
  try {
    if (CFG) {
      if (!sess) { $("auth").classList.remove("hide"); $("hdrConn").textContent = "Not signed in"; return setTimeout(poll, 2000); }
      const rows = await raw(`/rest/v1/status?user_id=eq.${sess.uid}&select=data,updated_at`), row = rows && rows[0], d = (row && row.data) || {}, age = row ? (Date.now() - Date.parse(row.updated_at)) / 1000 : 1e9;
      if (d.box && d.box.box) { S = d.box.box; goLive(); ingest(S.events); }
      $("hdrConn").textContent = !row ? "No data yet - start app.py" : age < 25 ? "Live (cloud)" : "PC quiet " + (age > 3600 ? Math.round(age / 3600) + " h" : Math.round(age / 60) + " min");
      if (Date.now() - beat > 8000) { beat = Date.now(); raw("/rest/v1/control?on_conflict=user_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: { user_id: sess.uid, viewer_at: new Date().toISOString() } }).catch(() => {}); }   // tells the PC someone is watching
    } else {
      const r = await fetch("/state", { cache: "no-store" }); if (!r.ok) throw new Error("HTTP " + r.status);
      S = await r.json(); goLive(); ingest(S.events); $("hdrConn").textContent = "Live (/state)";
    }
  } catch (e) { $("hdrConn").textContent = CFG ? "Cloud error: " + String(e.message).slice(0, 40) : "Preview mode"; if (/signed out|Invalid Refresh/i.test(e.message)) { sess = null; } wait = 3000; }
  syncPc2(); refresh(); setTimeout(poll, wait);
}
let last = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  for (let i = packets.length - 1; i >= 0; i--) { packets[i].p += dt * 0.85; if (packets[i].p >= 1) packets.splice(i, 1); }
  if (is3D) frame3D(dt, now); else {
    const sp = 560 * dt / cam.z; if (keys.has("a") || keys.has("arrowleft")) cam.x -= sp; if (keys.has("d") || keys.has("arrowright")) cam.x += sp; if (keys.has("w") || keys.has("arrowup")) cam.y -= sp; if (keys.has("s") || keys.has("arrowdown")) cam.y += sp;
    clampCam(); behave(dt); draw2D();
  }
  requestAnimationFrame(loop);
}
syncPc2(); refresh(); B.tgt = randomTarget(); setMode(!!window.THREE); poll(); requestAnimationFrame(loop);
