// THE ALGERIA GAME'S MINIMAP — a tactical map, Company of Heroes style
// (rebuilt 2026-09-30, your ask: "better looking and better optimized").
// The HUD bar's left slot (hudBar.js).
//
//   • ORIENTED LIKE COMPANY OF HEROES: up on the map = the start camera's
//     forward (`upYaw`, layout.js VIEW_YAW), so our post sits at the bottom
//     and the katiba at the top. The playable square is diagonal to that
//     view, so it is a DIAMOND; the corners around it show the real terrain
//     beyond the play area, dimmed — the whole square is map.
//   • The terrain is BAKED once, at the slot's real pixel size (crisp on a
//     high-DPI screen): hill-shaded ground (light from the top left), rust on
//     the steep slopes, water, the tracks, and the buildings' own plan (their
//     roofs and wall tops, from the meshes).
//   • LAYERS, each redrawn only when it has to be — the old map redrew
//     everything every frame (0.8 ms at 600 men):
//       base    the bake: never again
//       fog     the shroud: 4 times a second (when fog of war is on)
//       units   villages, built defences, units, combat pulses: 12 a second
//       camera  the view's outline: when the camera moves
//   • Units by kind: infantry dots, vehicles squares, aircraft arrows; the
//     selection white, on top. A red pulse where a unit fires or is hit — a
//     fight starting off screen shows here.
//   • Left click / drag: the camera goes there. RIGHT click: the selection
//     moves there (selection.orderMove — the same order as on the ground).
//   • No intel (a game hook — nam's radio station): a dead screen, NO RADIO.
import * as THREE from "three";
import { TRACK_LINES } from "../algTracks.js";

const UNITS_HZ = 12;
const FOG_HZ = 4;
const PULSE_S = 1.4;          // a combat pulse's life
const PULSE_MERGE_M = 30;     // a new pulse this close to a young one is the same fight

const _plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
const _NDC_CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * World ↔ minimap for a map turned so world direction (sin upYaw, cos upYaw)
 * points up. Right on the minimap = the camera's screen-right, (-cos, sin).
 * It frames `area` (the PLAYABLE box, {x0, x1, z0, z1}) scaled so the whole
 * turned square fits `px` canvas pixels. `world`: the terrain's edge (the fog
 * of war's image covers all of it).
 */
function makeFrame(area, upYaw, px, world) {
  const fx = Math.sin(upYaw), fz = Math.cos(upYaw), rx = -fz, rz = fx;
  const cx = (area.x0 + area.x1) / 2, cz = (area.z0 + area.z1) / 2;
  const size = Math.max(area.x1 - area.x0, area.z1 - area.z0);
  const k = px / (size * (Math.abs(fx) + Math.abs(fz)));   // world m → minimap px
  const c = px / 2;
  return {
    area, upYaw, k,
    toMini: (x, z) => ({ x: c + ((x - cx) * rx + (z - cz) * rz) * k, y: c - ((x - cx) * fx + (z - cz) * fz) * k }),
    toWorld: (mx, my) => {
      const u = (mx - c) / k, v = (c - my) / k;
      return { x: cx + rx * u + fx * v, z: cz + rz * u + fz * v };
    },
    /**
     * The canvas transform that draws a WORLD-ALIGNED image of the whole map
     * (the fog of war's miniCanvas: pixel (u, v) = world x = map/2 − u·m,
     * z = map/2 − v·m, m = map / its width) onto this turned minimap.
     */
    worldImageTransform(imgPx) {
      const m = world / imgPx, h = world / 2;
      return [-k * m * rx, k * m * fx, -k * m * rz, k * m * fz,
        c + k * ((h - cx) * rx + (h - cz) * rz), c - k * ((h - cx) * fx + (h - cz) * fz)];
    },
  };
}

// The Aurès palette: ochre valley floors going pale on the heights, rust on
// the steep ground, the oasis water green-blue.
const LOW = [164, 128, 86], HIGH = [216, 194, 150];
const STEEP = [128, 86, 58], WATER = [58, 118, 112], VOID = [20, 19, 15];
const LIGHT = (() => { const l = [-1, -1, 1.6], n = Math.hypot(...l); return l.map((v) => v / n); })();

/** The terrain, tracks and building plan at `px` × `px`, once. */
function bakeBase(app, frame, px, world) {
  const half = world / 2;
  const A = frame.area;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(px, px);
  const data = img.data;

  // Heights (and water) at every pixel's world point; NaN off the world.
  const H = new Float32Array(px * px), W = new Uint8Array(px * px), IN = new Uint8Array(px * px);
  let minH = Infinity, maxH = -Infinity;
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const i = y * px + x, w = frame.toWorld(x + 0.5, y + 0.5);
    if (Math.abs(w.x) > half || Math.abs(w.z) > half) { H[i] = NaN; continue; }
    const h = app.getWorldHeight(w.x, w.z);
    H[i] = h;
    if (app.getWaterLevelAt && app.getWaterLevelAt(w.x, w.z) > h) W[i] = 1;
    if (w.x >= A.x0 && w.x <= A.x1 && w.z >= A.z0 && w.z <= A.z1) {
      IN[i] = 1;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  const span = Math.max(1, maxH - minH);
  const mPerPx = 1 / frame.k;
  const at = (x, y) => {
    const v = H[Math.min(px - 1, Math.max(0, y)) * px + Math.min(px - 1, Math.max(0, x))];
    return Number.isNaN(v) ? H[y * px + x] : v;
  };
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const i = y * px + x, p = i * 4, h = H[i];
    let rgb;
    if (Number.isNaN(h)) rgb = VOID;
    else if (W[i]) rgb = WATER;
    else {
      // Screen-space gradient → a normal; the relief exaggerated a little so
      // the gullies read at this size.
      const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * mPerPx);
      const gy = (at(x, y + 1) - at(x, y - 1)) / (2 * mPerPx);
      const ex = 1.8, nl = Math.hypot(gx * ex, gy * ex, 1);
      const shade = Math.min(1.3, Math.max(0.45, ((-gx * ex) * LIGHT[0] + (-gy * ex) * LIGHT[1] + LIGHT[2]) / nl / LIGHT[2]));
      const slope = 1 - 1 / Math.hypot(gx, gy, 1);
      rgb = lerp3(LOW, HIGH, clamp01((h - minH) / span));
      if (slope > 0.2) rgb = lerp3(rgb, STEEP, clamp01((slope - 0.2) / 0.3));
      rgb = rgb.map((c) => c * shade);
    }
    if (!IN[i] && rgb !== VOID) {
      // Beyond the play area: the same land, greyed and dimmed.
      const g = (rgb[0] + rgb[1] + rgb[2]) / 3;
      rgb = rgb.map((c) => (c * 0.35 + g * 0.65) * 0.42);
    }
    data[p] = rgb[0]; data[p + 1] = rgb[1]; data[p + 2] = rgb[2]; data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const s = px / 160;   // line widths were tuned on a 160 px map
  // The tracks (algTracks.js), as a CoH map shows its roads: the piste a pale
  // line, the mule paths a thin dashed one.
  ctx.lineJoin = ctx.lineCap = "round";
  for (const t of TRACK_LINES) {
    const piste = t.kind === "piste";
    ctx.strokeStyle = piste ? "rgba(240, 228, 200, 0.85)" : "rgba(84, 58, 36, 0.75)";
    ctx.lineWidth = (piste ? 1.6 : 0.9) * s;
    ctx.setLineDash(piste ? [] : [3 * s, 2 * s]);
    ctx.beginPath();
    t.line.forEach((q, i) => { const m = frame.toMini(q.x, q.z); ctx[i ? "lineTo" : "moveTo"](m.x, m.y); });
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // THE BUILDINGS' PLAN: every face of a placed building that looks UP and
  // stands over a metre above the ground — roofs, wall tops, towers, not the
  // yards — RASTERIZED here into a 2×-supersampled mask, then blended in with
  // a soft shadow down-right. (The canvas's own path filler, handed ~190k
  // building triangles as one path, took over 3 s at boot. Plain arithmetic,
  // no per-triangle objects, ONE ground sample per building — they stand on
  // levelled pads.)
  const SS = 2, mw = px * SS;
  const mask = new Uint8Array(mw * mw);
  const P = new Float64Array(9);
  const plan = {
    moveTo(x, y) { this.t = [x * SS, y * SS]; },
    lineTo(x, y) { this.t.push(x * SS, y * SS); },
    closePath() {
      const [x0, y0, x1, y1, x2, y2] = this.t;
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) return;
      const sg = area > 0 ? 1 : -1;
      const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(mw - 1, Math.ceil(Math.max(x0, x1, x2)));
      const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(mw - 1, Math.ceil(Math.max(y0, y1, y2)));
      let hit = false;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5, cy = y + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * sg;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * sg;
        const w2 = ((x0 - cx) * (y1 - cy) - (x1 - cx) * (y0 - cy)) * sg;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) { mask[y * mw + x] = 1; hit = true; }
      }
      // smaller than a sample (a wall top seen from far): its centre's sample
      if (!hit) {
        const x = Math.floor((x0 + x1 + x2) / 3), y = Math.floor((y0 + y1 + y2) / 3);
        if (x >= 0 && y >= 0 && x < mw && y < mw) mask[y * mw + x] = 1;
      }
    },
  };
  app.scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.name?.startsWith("showroom:")) return;
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    const idx = o.geometry.index;
    const n = idx ? idx.count : pos.count;
    o.updateMatrixWorld(true);
    const m = o.matrixWorld.elements;
    const ground = app.getWorldHeight(o.position.x, o.position.z) + 1;
    for (let t = 0; t < n; t += 3) {
      for (let j = 0; j < 3; j++) {
        const vi = idx ? idx.getX(t + j) : t + j;
        const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
        P[j * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
        P[j * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
        P[j * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      }
      if ((P[1] + P[4] + P[7]) / 3 < ground) continue;   // at the yard, not a top
      const ax = P[3] - P[0], ay = P[4] - P[1], az = P[5] - P[2];
      const bx = P[6] - P[0], by = P[7] - P[1], bz = P[8] - P[2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6 || Math.abs(ny) / len < 0.6) continue;   // walls, not tops (either winding)
      const a = frame.toMini(P[0], P[2]), b = frame.toMini(P[3], P[5]), c = frame.toMini(P[6], P[8]);
      plan.moveTo(a.x, a.y); plan.lineTo(b.x, b.y); plan.lineTo(c.x, c.y); plan.closePath();
    }
  });
  // Coverage per map pixel (the SS × SS samples), the shadow one pixel
  // down-right, then plaster over it.
  const cover = (x, y) => {
    if (x < 0 || y < 0 || x >= px || y >= px) return 0;
    let c = 0;
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) c += mask[(y * SS + j) * mw + x * SS + i];
    return c / (SS * SS);
  };
  const out = ctx.getImageData(0, 0, px, px), od = out.data;
  const sh = Math.max(1, Math.round(s));
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const p = (y * px + x) * 4, shadow = cover(x - sh, y - sh) * 0.45, roof = cover(x, y);
    if (!shadow && !roof) continue;
    for (let k = 0; k < 3; k++) {
      let v = od[p + k] * (1 - shadow) + [20, 14, 8][k] * shadow;
      v = v * (1 - roof) + [228, 217, 196][k] * roof;
      od[p + k] = v;
    }
  }
  ctx.putImageData(out, 0, 0);

  // The play area's edge: a thin bright line over a dark one.
  const corners = [[A.x0, A.z0], [A.x1, A.z0], [A.x1, A.z1], [A.x0, A.z1]].map(([x, z]) => frame.toMini(x, z));
  const edge = () => { ctx.beginPath(); corners.forEach((m, i) => ctx[i ? "lineTo" : "moveTo"](m.x, m.y)); ctx.closePath(); };
  edge(); ctx.strokeStyle = "rgba(0, 0, 0, 0.55)"; ctx.lineWidth = 2.2 * s; ctx.stroke();
  edge(); ctx.strokeStyle = "rgba(246, 232, 200, 0.7)"; ctx.lineWidth = 0.9 * s; ctx.stroke();

  // A soft vignette, so the map sits IN its frame.
  const g = ctx.createRadialGradient(px / 2, px / 2, px * 0.42, px / 2, px / 2, px * 0.72);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.45)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);
  return canvas;
}

export function createMinimap({
  app, units, selection = null, structures = null, fogOfWar = null, requisition = null,
  mount = document.body, intel = null, upYaw = 0, area = null,
}) {
  const world = app.worldSize ?? 1000;
  const box = area ?? { x0: -world / 2, x1: world / 2, z0: -world / 2, z1: world / 2 };

  const root = document.createElement("div");
  root.id = "rts-minimap";
  mount.appendChild(root);
  // The canvases at the slot's REAL pixel size (a 160 px canvas stretched by
  // CSS was soft on a high-DPI screen).
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = root.clientWidth || 160;
  const px = Math.max(96, Math.round(css * dpr));
  const s = px / 160;
  const frame = makeFrame(box, upYaw, px, world);

  const layer = (name) => {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    c.className = name;
    root.appendChild(c);
    return { c, ctx: c.getContext("2d") };
  };
  const base = layer("base"), fog = layer("fog"), dyn = layer("units"), cam = layer("camera");
  base.ctx.drawImage(bakeBase(app, frame, px, world), 0, 0);

  const style = document.createElement("style");
  style.textContent = `
    #rts-minimap { position: relative; width: 100%; height: 100%; cursor: crosshair;
      border: 1px solid var(--hud-edge-hi); border-radius: var(--hud-radius); overflow: hidden;
      box-shadow: inset 0 0 0 1px rgba(0,0,0,0.6); }
    #rts-minimap canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    #rts-minimap.locked { cursor: default; }
  `;
  document.head.appendChild(style);

  // ── Input: left = the camera, right = the selection ──────────────────────
  const worldAt = (ev) => {
    const r = root.getBoundingClientRect();
    const w = frame.toWorld((ev.clientX - r.left) / r.width * px, (ev.clientY - r.top) / r.height * px);
    return { x: Math.max(box.x0, Math.min(box.x1, w.x)), z: Math.max(box.z0, Math.min(box.z1, w.z)) };
  };
  let dragging = false;
  const jump = (ev) => { const w = worldAt(ev); app.rtsCamera?.focusOn?.(w.x, w.z); };
  const onDown = (e) => {
    if (!hasIntel() || e.button !== 0) return;
    dragging = true; jump(e); e.preventDefault();
  };
  const onMove = (e) => { if (dragging) jump(e); };
  const onUp = () => { dragging = false; };
  const onContext = (e) => {
    e.preventDefault();
    if (!hasIntel()) return;
    const w = worldAt(e);
    selection?.orderMove?.(w.x, w.z);
  };
  root.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  root.addEventListener("contextmenu", onContext);

  function hasIntel() { return intel ? intel() : true; }

  // ── Camera outline ───────────────────────────────────────────────────────
  function cameraFootprint() {
    _plane.constant = -(app.controls?.target?.y ?? 0);
    const pts = [];
    for (const [nx, ny] of _NDC_CORNERS) {
      _ndc.set(nx, ny);
      _ray.setFromCamera(_ndc, app.camera);
      if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
      pts.push({ x: _hit.x, z: _hit.z });
    }
    // The top corners of a low camera meet the ground near the horizon: cap
    // the far edge at 2.5x the near edge's reach, so the view reads as a
    // trapezoid (CoH), not a wedge across the whole map.
    const t = app.controls?.target ?? { x: 0, z: 0 };
    const near = Math.max(Math.hypot(pts[0].x - t.x, pts[0].z - t.z), Math.hypot(pts[1].x - t.x, pts[1].z - t.z));
    const cap = near * 2.5;
    for (const q of pts) {
      const d = Math.hypot(q.x - t.x, q.z - t.z);
      if (d > cap) { q.x = t.x + (q.x - t.x) * cap / d; q.z = t.z + (q.z - t.z) * cap / d; }
    }
    return pts.map((q) => frame.toMini(q.x, q.z));
  }
  let lastCam = null;
  function drawCamera() {
    const fp = cameraFootprint();
    const same = fp && lastCam && fp.every((q, i) => Math.abs(q.x - lastCam[i].x) + Math.abs(q.y - lastCam[i].y) < 0.3);
    if (same) return;
    lastCam = fp;
    const c = cam.ctx;
    c.clearRect(0, 0, px, px);
    if (!fp) return;
    c.beginPath();
    fp.forEach((q, i) => c[i ? "lineTo" : "moveTo"](q.x, q.y));
    c.closePath();
    c.fillStyle = "rgba(255,255,255,0.08)";
    c.fill();
    c.strokeStyle = "rgba(0,0,0,0.5)"; c.lineWidth = 2.6 * s; c.stroke();
    c.strokeStyle = "rgba(255,255,255,0.92)"; c.lineWidth = 1.2 * s; c.stroke();
  }

  // ── Fog ──────────────────────────────────────────────────────────────────
  let fogT = 0, fogShown = false;
  function drawFog(now) {
    const on = !!(fogOfWar?.enabled && fogOfWar.miniCanvas);
    if (!on) { if (fogShown) { fog.ctx.clearRect(0, 0, px, px); fogShown = false; } return; }
    if (fogShown && now - fogT < 1000 / FOG_HZ) return;
    fogT = now; fogShown = true;
    const c = fog.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, px, px);
    c.setTransform(...frame.worldImageTransform(fogOfWar.miniCanvas.width));
    c.imageSmoothingEnabled = true;
    c.drawImage(fogOfWar.miniCanvas, 0, 0);
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ── Combat pulses: a unit firing (its cooldown reset) or hit (hp down) ───
  const seen = new WeakMap();   // unit → { cd, hp }
  const pulses = [];            // { x, y, t }
  const visible = (u) => u.team === "player" || !fogOfWar?.enabled || fogOfWar.isVisible(u.position.x, u.position.z);
  function watchCombat(now) {
    for (const u of units.list) {
      const last = seen.get(u);
      const cd = u.cooldown ?? 0, hp = u.hp ?? 0;
      if (!last) { seen.set(u, { cd, hp }); continue; }
      const fought = u.alive && (cd > last.cd + 1e-6 || hp < last.hp - 1e-6);
      last.cd = cd; last.hp = hp;
      if (!fought || !visible(u)) continue;
      const m = frame.toMini(u.position.x, u.position.z);
      const r2 = (PULSE_MERGE_M * frame.k) ** 2;
      if (pulses.some((p) => now - p.t < PULSE_S * 400 && (p.x - m.x) ** 2 + (p.y - m.y) ** 2 < r2)) continue;
      pulses.push({ x: m.x, y: m.y, t: now });
    }
    for (let i = pulses.length - 1; i >= 0; i--) if (now - pulses[i].t > PULSE_S * 1000) pulses.splice(i, 1);
  }

  // ── Units, villages, defences ────────────────────────────────────────────
  const COL = { enemy: "#ff5f4e", player: "#5aaeff", air: "#6fe6d6", sel: "#ffffff" };
  const _foot = { enemy: [], player: [], sel: [] }, _veh = { enemy: [], player: [], sel: [] }, _air = { enemy: [], player: [], sel: [] };
  function drawUnits(now) {
    const c = dyn.ctx;
    c.clearRect(0, 0, px, px);

    // Villages / requisition points: a diamond in the owner's colour, the
    // capture as an arc round it.
    for (const p of requisition?.points ?? []) {
      if (fogOfWar?.enabled && !fogOfWar.isExplored(p.position.x, p.position.z)) continue;
      const m = frame.toMini(p.position.x, p.position.z), r = 4.2 * s;
      c.fillStyle = p.owner === "player" ? COL.player : p.owner === "enemy" ? COL.enemy : "#e2d7b8";
      c.strokeStyle = "rgba(10,12,8,0.85)"; c.lineWidth = 1 * s;
      c.beginPath(); c.moveTo(m.x, m.y - r); c.lineTo(m.x + r, m.y); c.lineTo(m.x, m.y + r); c.lineTo(m.x - r, m.y); c.closePath();
      c.fill(); c.stroke();
      if (Math.abs(p.progress ?? 0) > 0.01 && Math.abs(p.progress) < 0.999) {
        c.strokeStyle = p.progress > 0 ? COL.player : COL.enemy; c.lineWidth = 1.6 * s;
        c.beginPath(); c.arc(m.x, m.y, 7 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.abs(p.progress)); c.stroke();
      }
    }

    // Built defences and buildings that are units of play (a mirador, a nest).
    const list = typeof structures === "function" ? structures() : structures?.list;
    if (list) {
      c.lineWidth = 0.8 * s; c.strokeStyle = "rgba(10,12,8,0.8)";
      for (const b of list) {
        if (!b.alive || !b.position) continue;
        if (b.team !== "player" && fogOfWar?.enabled && !fogOfWar.isExplored(b.position.x, b.position.z)) continue;
        const m = frame.toMini(b.position.x, b.position.z), r = 2.2 * s;
        c.fillStyle = b.team === "player" ? "#8fc8ff" : "#ff8f80";
        c.fillRect(m.x - r, m.y - r, r * 2, r * 2); c.strokeRect(m.x - r, m.y - r, r * 2, r * 2);
      }
    }

    // Combat pulses, under the units.
    for (const p of pulses) {
      const a = (now - p.t) / (PULSE_S * 1000);
      c.strokeStyle = `rgba(255, 96, 64, ${(1 - a) * 0.9})`;
      c.lineWidth = 1.4 * s;
      c.beginPath(); c.arc(p.x, p.y, (3 + 9 * a) * s, 0, Math.PI * 2); c.stroke();
    }

    // Units, bucketed by kind and colour, then one path per bucket.
    for (const b of [_foot, _veh, _air]) for (const k in b) b[k].length = 0;
    for (const u of units.list) {
      if (!u.alive) continue;
      if (u.team !== "player" && fogOfWar?.enabled && !fogOfWar.isVisible(u.position.x, u.position.z)) continue;
      const m = frame.toMini(u.position.x, u.position.z);
      const key = u.selected ? "sel" : u.team === "player" ? "player" : "enemy";
      if (u.isAir) _air[key].push(m.x, m.y, frame.upYaw - (u.heading ?? 0));
      else if (u.type?.foot) _foot[key].push(m.x, m.y);
      else _veh[key].push(m.x, m.y);
    }
    // Outline FIRST, fill over it: a packed squad reads as one coloured mass
    // with a dark rim, not as a black knot of outlines.
    c.strokeStyle = "rgba(8,12,20,0.85)";
    c.lineWidth = 1.4 * s;
    for (const key of ["enemy", "player", "sel"]) {
      const fill = key === "sel" ? COL.sel : COL[key];
      // infantry: dots
      const f = _foot[key];
      if (f.length) {
        c.beginPath();
        const r = 1.55 * s;
        for (let i = 0; i < f.length; i += 2) { c.moveTo(f[i] + r, f[i + 1]); c.arc(f[i], f[i + 1], r, 0, Math.PI * 2); }
        c.fillStyle = fill; c.stroke(); c.fill();
      }
      // vehicles: squares
      const v = _veh[key];
      if (v.length) {
        c.beginPath();
        const r = 2.6 * s;
        for (let i = 0; i < v.length; i += 2) c.rect(v[i] - r, v[i + 1] - r, r * 2, r * 2);
        c.fillStyle = fill; c.stroke(); c.fill();
      }
      // aircraft: arrows along their heading
      const w = _air[key];
      if (w.length) {
        c.beginPath();
        const r = 4 * s;
        for (let i = 0; i < w.length; i += 3) {
          const x = w[i], y = w[i + 1], cs = Math.cos(w[i + 2]), sn = Math.sin(w[i + 2]);
          c.moveTo(x + r * sn, y - r * cs);
          c.lineTo(x - 0.7 * r * cs - 0.8 * r * sn, y - 0.7 * r * sn + 0.8 * r * cs);
          c.lineTo(x + 0.7 * r * cs - 0.8 * r * sn, y + 0.7 * r * sn + 0.8 * r * cs);
          c.closePath();
        }
        c.fillStyle = key === "sel" ? COL.sel : key === "player" ? COL.air : COL.enemy; c.stroke(); c.fill();
      }
    }
  }

  // ── No intel: a dead screen, a few times a second ────────────────────────
  let lockT = 0, locked = false;
  function drawLocked(now) {
    if (now - lockT < 180) return;
    lockT = now;
    const c = dyn.ctx;
    c.fillStyle = "#15170f";
    c.fillRect(0, 0, px, px);
    for (let i = 0; i < 420; i++) {
      const v = 30 + Math.random() * 40;
      c.fillStyle = `rgb(${v},${v + 4},${v - 6})`;
      c.fillRect(Math.random() * px, Math.random() * px, (1 + Math.random() * 2) * s, s);
    }
    c.fillStyle = "rgba(0,0,0,0.25)";
    for (let y = 0; y < px; y += 3 * s) c.fillRect(0, y, px, s);
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillStyle = "#8d8a78";
    c.font = `bold ${15 * s}px 'Segoe UI', system-ui, sans-serif`;
    c.fillText("NO  RADIO", px / 2, px / 2 - 8 * s);
    c.font = `${9 * s}px 'Segoe UI', system-ui, sans-serif`;
    c.fillStyle = "#6b6a5c";
    c.fillText("BUILD A RADIO STATION", px / 2, px / 2 + 12 * s);
  }

  let unitsT = 0;
  /** Once a frame (algUnits.js): each layer decides whether it has anything to redraw. */
  function draw() {
    const now = performance.now();
    if (!hasIntel()) {
      if (!locked) { locked = true; root.classList.add("locked"); fog.ctx.clearRect(0, 0, px, px); cam.ctx.clearRect(0, 0, px, px); lastCam = null; fogShown = false; }
      drawLocked(now);
      return;
    }
    if (locked) { locked = false; root.classList.remove("locked"); unitsT = 0; }
    drawFog(now);
    if (now - unitsT >= 1000 / UNITS_HZ) {
      unitsT = now;
      watchCombat(now);
      drawUnits(now);
    }
    drawCamera();
  }

  return {
    root,
    draw,
    hasRadioIntel: hasIntel,
    /** Re-bake the terrain (after the ground or the buildings change). */
    rebuildTerrain() { base.ctx.clearRect(0, 0, px, px); base.ctx.drawImage(bakeBase(app, frame, px, world), 0, 0); },
    dispose() {
      root.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      root.removeEventListener("contextmenu", onContext);
      root.remove(); style.remove();
    },
  };
}
