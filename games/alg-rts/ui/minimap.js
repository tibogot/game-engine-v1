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
//   • TERRITORY (2026-10-03, CoH's sectors): each capture point owns the
//     ground nearest it, tinted in its holder's colour with the sector
//     borders; redrawn only when a point changes hands. The SUPPLY LINES
//     (algEconomy.js) run from the post to every linked point; a point held
//     but cut off is amber.
//   • Units by kind: a FRENCH SQUAD is ONE marker (CoH), the ALN's men dots,
//     vehicles squares, aircraft arrows; the selection white, on top. A red pulse where a unit fires or is hit — a
//     fight starting off screen shows here.
//   • Left click / drag: the camera goes there. RIGHT click: the selection
//     moves there (selection.orderMove — the same order as on the ground).
//   • No intel (a game hook — nam's radio station): a dead screen, NO RADIO.
import * as THREE from "three";
import { TRACK_LINES } from "../algTracks.js";
import { drawIcon } from "./resourceIcons.js";

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
  // A 4% margin round the play area (the land beyond it, dimmed, frames it).
  const k = px / (size * (Math.abs(fx) + Math.abs(fz)) * 1.03);   // world m → minimap px
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

  // THE FIELDS (algFields.js): the worked land round the villages, in its
  // own colours, walled — a CoH map's patchwork of plots.
  const FIELD = { plough: "rgba(96, 70, 48, 0.62)", stubble: "rgba(196, 170, 112, 0.62)", green: "rgba(112, 128, 72, 0.62)" };
  for (const b of app.algFields?.plots ?? []) {
    const c = Math.cos(b.yaw), sn = Math.sin(b.yaw);
    const pts = [[-b.hx, -b.hz], [b.hx, -b.hz], [b.hx, b.hz], [-b.hx, b.hz]].map(([lx, lz]) => frame.toMini(b.x + lx * c + lz * sn, b.z - lx * sn + lz * c));
    ctx.beginPath(); pts.forEach((m, i) => ctx[i ? "lineTo" : "moveTo"](m.x, m.y)); ctx.closePath();
    ctx.fillStyle = FIELD[b.kind] ?? FIELD.plough; ctx.fill();
    ctx.strokeStyle = "rgba(70, 58, 44, 0.7)"; ctx.lineWidth = 0.6 * s; ctx.stroke();
  }

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

  // A soft vignette, so the map sits IN its frame (lighter: the play area
  // reaches the corners now).
  const g = ctx.createRadialGradient(px / 2, px / 2, px * 0.5, px / 2, px / 2, px * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.3)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, px, px);

  // NORTH: a small arrow in the top-right corner (the map is turned in 90°
  // steps, so north may not be up).
  const n0 = frame.toMini(0, 0), n1 = frame.toMini(0, -100);
  const nl = Math.hypot(n1.x - n0.x, n1.y - n0.y) || 1, ux = (n1.x - n0.x) / nl, uy = (n1.y - n0.y) / nl;
  // In the shape's topmost corner, pulled in (the corners outside it are cut away).
  const top = corners.reduce((p, q) => (q.y < p.y ? q : p));
  const ox = top.x + (px / 2 - top.x) * 0.17, oy = top.y + (px / 2 - top.y) * 0.17 + 6 * s, L = 6 * s;
  ctx.fillStyle = "rgba(246, 232, 200, 0.9)"; ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(ox + ux * L, oy + uy * L);
  ctx.lineTo(ox - ux * L * 0.6 - uy * L * 0.55, oy - uy * L * 0.6 + ux * L * 0.55);
  ctx.lineTo(ox - ux * L * 0.6 + uy * L * 0.55, oy - uy * L * 0.6 - ux * L * 0.55);
  ctx.closePath(); ctx.stroke(); ctx.fill();
  ctx.font = `bold ${Math.round(6.5 * s)}px 'Segoe UI', system-ui, sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineWidth = 2 * s; ctx.strokeText("N", ox - ux * L * 1.7, oy - uy * L * 1.7);
  ctx.fillText("N", ox - ux * L * 1.7, oy - uy * L * 1.7);
  return canvas;
}

export function createMinimap({
  app, units, selection = null, structures = null, fogOfWar = null, requisition = null,
  mount = document.body, intel = null, upYaw = 0, area = null, squadOf = null,
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
  // TURNED WITH THE CAMERA, and SHAPED LIKE THE PLAY AREA (you, 2026-10-01:
  // the view outline must read as the game does — so the map turns with the
  // start camera — but "a rotated map shouldn't sit inside a non-rotated
  // parent"): the minimap IS the play area's shape, clipped to it, its own
  // border round it. The land beyond the play area is cut away.
  const frame = makeFrame(box, upYaw, px, world);
  const shape = [[box.x0, box.z0], [box.x1, box.z0], [box.x1, box.z1], [box.x0, box.z1]].map(([x, z]) => frame.toMini(x, z));
  const fpx = Math.round(10.5 * dpr);   // label size, device px

  const layer = (name) => {
    const c = document.createElement("canvas");
    c.width = c.height = px;
    c.className = name;
    root.appendChild(c);
    return { c, ctx: c.getContext("2d") };
  };
  const base = layer("base"), terr = layer("territory"), fog = layer("fog"), dyn = layer("units"), cam = layer("camera");
  base.ctx.drawImage(bakeBase(app, frame, px, world), 0, 0);

  // The clip and the frame: the play area's outline, in % of the box.
  const pct = (q) => `${((q.x / px) * 100).toFixed(2)}% ${((q.y / px) * 100).toFixed(2)}%`;
  root.style.clipPath = `polygon(${shape.map(pct).join(", ")})`;
  const svgNS = "http://www.w3.org/2000/svg";
  const outline = document.createElementNS(svgNS, "svg");
  outline.setAttribute("viewBox", `0 0 ${px} ${px}`);
  outline.setAttribute("class", "frame");
  const pts = shape.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(" ");
  outline.innerHTML = `<polygon points="${pts}" fill="none" stroke="rgba(0,0,0,0.7)" stroke-width="${(5 * s).toFixed(1)}"/>`
    + `<polygon points="${pts}" fill="none" stroke="#59623f" stroke-width="${(2.4 * s).toFixed(1)}"/>`;
  root.appendChild(outline);

  const style = document.createElement("style");
  style.textContent = `
    #rts-minimap { position: relative; width: 100%; height: 100%; cursor: crosshair; }
    #rts-minimap canvas, #rts-minimap svg.frame { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
    #rts-minimap svg.frame { pointer-events: none; }
    #rts-minimap.locked { cursor: default; }
    /* The HUD corner holds a SHAPED map: no square panel behind it, a shadow
       that follows the shape instead. */
    #alg-hud .block-left { background: transparent !important; border: 0 !important; box-shadow: none !important;
      filter: drop-shadow(0 4px 10px rgba(0,0,0,0.55)); }
  `;
  document.head.appendChild(style);
  // Inside the shape? (labels, the north arrow)
  const inside = (x, y) => {
    let s2 = 0;
    for (let i = 0; i < 4; i++) {
      const a = shape[i], b = shape[(i + 1) % 4];
      const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
      if (cr !== 0) { if (s2 && Math.sign(cr) !== s2) return false; s2 = Math.sign(cr); }
    }
    return true;
  };

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

  // ── Territory: the sectors, redrawn when a point changes hands ───────────
  // Each sample of the map belongs to its NEAREST point (a Voronoi of the
  // points, CoH's sectors drawn from them); tinted by its holder, with a
  // border where two sectors meet. A cell grid of TERR_CELL device px.
  const TERR_CELL = Math.max(2, Math.round(2 * dpr));
  let terrKey = "";
  function drawTerritory() {
    const pts = requisition?.points ?? [];
    const key = pts.map((p) => `${p.owner}${p.linked ? 1 : 0}`).join("|");
    if (key === terrKey) return;
    terrKey = key;
    const c = terr.ctx;
    c.clearRect(0, 0, px, px);
    if (!pts.length) return;
    const n = Math.ceil(px / TERR_CELL);
    const own = new Int16Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const w = frame.toWorld((i + 0.5) * TERR_CELL, (j + 0.5) * TERR_CELL);
      let best = 0, bd = Infinity;
      for (let k = 0; k < pts.length; k++) {
        const d = (pts[k].position.x - w.x) ** 2 + (pts[k].position.z - w.z) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      own[j * n + i] = best;
    }
    const tint = (p) => (p.owner === "player" ? (p.linked === false ? "rgba(224,160,64,0.16)" : "rgba(90,174,255,0.17)")
      : p.owner === "enemy" ? "rgba(255,95,78,0.17)" : null);
    for (let k = 0; k < pts.length; k++) {
      const f = tint(pts[k]);
      if (!f) continue;
      c.fillStyle = f;
      c.beginPath();
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (own[j * n + i] === k) c.rect(i * TERR_CELL, j * TERR_CELL, TERR_CELL, TERR_CELL);
      c.fill();
    }
    // The borders: a cell whose right or lower neighbour is another sector.
    c.fillStyle = "rgba(236,228,204,0.4)";
    c.beginPath();
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const o = own[j * n + i];
      if (own[j * n + i + 1] !== o || own[(j + 1) * n + i] !== o) c.rect(i * TERR_CELL + TERR_CELL * 0.25, j * TERR_CELL + TERR_CELL * 0.25, TERR_CELL * 0.5 + 0.5, TERR_CELL * 0.5 + 0.5);
    }
    c.fill();
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
    // Half-strength: unexplored ground stays READABLE (CoH) — the land is
    // known, what is on it is not.
    c.globalAlpha = 0.55;
    c.drawImage(fogOfWar.miniCanvas, 0, 0);
    c.globalAlpha = 1;
    c.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ── Combat pulses: a unit firing (its cooldown reset) or hit (hp down) ───
  const seen = new WeakMap();   // unit → { cd, hp }
  const pulses = [];            // { x, y, t }
  const pings = [];             // { x, z, t } — alerts (world coords)
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
  /** A name on the map: light, with a dark halo so it reads on any ground. */
  const _labels = [];
  /** Queue a name; drawn last, on top of the units, kept inside the map. */
  function label(c, text, x, y) { _labels.push(text, x, y); }
  function flushLabels(c) {
    c.font = `600 ${fpx}px 'Segoe UI', system-ui, sans-serif`;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.lineJoin = "round"; c.lineWidth = 3 * dpr; c.strokeStyle = "rgba(10,12,8,0.85)"; c.fillStyle = "#f2ead6";
    for (let i = 0; i < _labels.length; i += 3) {
      const text = _labels[i], w = c.measureText(text).width / 2 + 3 * dpr;
      // Inside the map's shape: slid toward its centre until all of it fits.
      let x = _labels[i + 1], y = _labels[i + 2];
      const h = fpx * 0.6;
      for (let k = 0; k < 20 && !(inside(x - w, y - h) && inside(x + w, y - h) && inside(x - w, y + h) && inside(x + w, y + h)); k++) {
        x += (px / 2 - x) * 0.12; y += (px / 2 - y) * 0.12;
      }
      c.strokeText(text, x, y); c.fillText(text, x, y);
    }
    _labels.length = 0;
  }
  const _foot = { enemy: [], player: [], sel: [] }, _veh = { enemy: [], player: [], sel: [] }, _air = { enemy: [], player: [], sel: [] };
  const _squad = { enemy: [], player: [], sel: [] }, _sq = new Map();
  function drawUnits(now) {
    const c = dyn.ctx;
    c.clearRect(0, 0, px, px);

    // VILLAGES (the victory points) as TERRITORY: the capture ring itself, its
    // ground tinted in the holder's colour, the capture arc round its rim,
    // a marker and the name — what the whole war is about, readable at a
    // glance (the old 4 px diamond read as a speck).
    const R = requisition?.params?.radius ?? 40;
    // THE SUPPLY LINES: post → each linked point (algEconomy.js linkFrom).
    // Dashed blue on a dark rim: they must not read as one more track.
    c.beginPath();
    for (const p of requisition?.points ?? []) {
      if (!p.linkFrom) continue;
      const a = frame.toMini(p.linkFrom.x, p.linkFrom.z), b = frame.toMini(p.position.x, p.position.z);
      c.moveTo(a.x, a.y); c.lineTo(b.x, b.y);
    }
    c.lineCap = "round";
    c.lineWidth = 3.4 * s; c.strokeStyle = "rgba(6,14,28,0.75)"; c.stroke();
    c.setLineDash([5 * s, 3.5 * s]);
    c.lineWidth = 1.7 * s; c.strokeStyle = "#7cc4ff"; c.stroke();
    c.setLineDash([]);
    c.lineCap = "butt";
    for (const p of requisition?.points ?? []) {
      // Always shown: the French know their own valley's villages (who
      // holds one is known from the economy, as in CoH).
      const m = frame.toMini(p.position.x, p.position.z), rr = (p.radius ?? R) * frame.k;
      // Held but cut off from the post (algEconomy.js supply lines): amber.
      const col = p.owner === "player" ? (p.linked === false ? "#e0a040" : COL.player) : p.owner === "enemy" ? COL.enemy : "#e8dcbc";
      c.beginPath(); c.arc(m.x, m.y, rr, 0, Math.PI * 2);
      c.fillStyle = p.owner === "player" ? "rgba(90,174,255,0.14)" : p.owner === "enemy" ? "rgba(255,95,78,0.16)" : "rgba(232,220,188,0.1)";
      c.fill();
      c.strokeStyle = "rgba(10,12,8,0.6)"; c.lineWidth = 2.4 * s; c.stroke();
      c.strokeStyle = col; c.lineWidth = 1 * s; c.globalAlpha = 0.75; c.stroke(); c.globalAlpha = 1;
      const v = p.progress ?? 0;
      if (Math.abs(v) > 0.01 && Math.abs(v) < 0.999) {
        c.strokeStyle = v > 0 ? COL.player : COL.enemy; c.lineWidth = 2.6 * s;
        c.beginPath(); c.arc(m.x, m.y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.abs(v)); c.stroke();
      }
      // A SUPPLY POINT (fuel / munitions): a round token with its letter, no name.
      if (p.kind === "supply") {
        const r = 3.6 * s;
        c.fillStyle = col; c.strokeStyle = "rgba(10,12,8,0.9)"; c.lineWidth = 1.2 * s;
        c.beginPath(); c.arc(m.x, m.y, r, 0, Math.PI * 2); c.fill(); c.stroke();
        drawIcon(c, p.res, m.x, m.y, r * 1.5, "rgba(10,12,8,0.9)");   // its resource's icon (ui/resourceIcons.js)
        // The resource's colour round it: fuel amber, munitions rust.
        c.strokeStyle = p.res === "fuel" ? "#e2b25a" : "#d48a6a"; c.lineWidth = 1 * s;
        c.beginPath(); c.arc(m.x, m.y, r + 1.4 * s, 0, Math.PI * 2); c.stroke();
        continue;
      }
      // The marker: the victory point's STAR (ui/resourceIcons.js), on a dark disc, bigger than any unit.
      const r = 5 * s;
      c.fillStyle = "rgba(10,12,8,0.85)";
      c.beginPath(); c.arc(m.x, m.y, r, 0, Math.PI * 2); c.fill();
      drawIcon(c, "vp", m.x, m.y, r * 1.7, col);
      label(c, p.name.replace(/^(Mechta|Dechra|Ksar)\s+/, ""), m.x, m.y + rr + fpx * 0.75);
    }
    // THE OBJECTIVES: our post (blue) and the FLN's cave (red, always shown —
    // the briefing names it), each with its name.
    const all = typeof structures === "function" ? structures() : structures?.list;
    for (const b of all ?? []) {
      if (!b.alive || (b.typeKey !== "post" && b.typeKey !== "caveEntrance")) continue;
      const m = frame.toMini(b.position.x, b.position.z), r = 5.5 * s, fr = b.typeKey === "post";
      c.fillStyle = fr ? COL.player : COL.enemy; c.strokeStyle = "rgba(10,12,8,0.9)"; c.lineWidth = 1.4 * s;
      c.beginPath();
      if (fr) c.rect(m.x - r, m.y - r, r * 2, r * 2);
      else { c.moveTo(m.x, m.y - r * 1.2); c.lineTo(m.x + r * 1.1, m.y + r * 0.8); c.lineTo(m.x - r * 1.1, m.y + r * 0.8); c.closePath(); }
      c.fill(); c.stroke();
      label(c, fr ? "POSTE" : "GROTTE", m.x, m.y + r + fpx * 0.85);
    }

    // Built defences and buildings that are units of play (a mirador, a nest).
    const list = typeof structures === "function" ? structures() : structures?.list;
    if (list) {
      c.lineWidth = 0.8 * s; c.strokeStyle = "rgba(10,12,8,0.8)";
      for (const b of list) {
        if (!b.alive || !b.position || b.typeKey === "post" || b.typeKey === "caveEntrance") continue;   // their own markers (above)
        if (b.team !== "player" && fogOfWar?.enabled && !fogOfWar.isExplored(b.position.x, b.position.z)) continue;
        const m = frame.toMini(b.position.x, b.position.z), r = 2.2 * s;
        c.fillStyle = b.team === "player" ? "#8fc8ff" : "#ff8f80";
        c.fillRect(m.x - r, m.y - r, r * 2, r * 2); c.strokeRect(m.x - r, m.y - r, r * 2, r * 2);
      }
    }

    // Alert pings (algBattle.js): brass rings closing in on the place, 3 s.
    for (let i = pings.length - 1; i >= 0; i--) {
      const p = pings[i], a = (now - p.t) / 3000;
      if (a >= 1) { pings.splice(i, 1); continue; }
      const m = frame.toMini(p.x, p.z);
      c.strokeStyle = `rgba(233, 196, 96, ${1 - a})`;
      c.lineWidth = 1.6 * s;
      for (const k of [0, 0.33]) {
        const f = (a * 3 + k) % 1;
        c.beginPath(); c.arc(m.x, m.y, (16 - 12 * f) * s, 0, Math.PI * 2); c.stroke();
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
    for (const b of [_foot, _veh, _air, _squad]) for (const k in b) b[k].length = 0;
    _sq.clear();
    for (const u of units.list) {
      if (!u.alive) continue;
      if (u.team !== "player" && fogOfWar?.enabled && !fogOfWar.isVisible(u.position.x, u.position.z)) continue;
      // A French squad: one marker at its men's centre (gathered below).
      const sq = u.team === "player" && u.type?.foot ? squadOf?.(u) : null;
      if (sq) {
        const g = _sq.get(sq) ?? { x: 0, z: 0, n: 0, sel: false };
        g.x += u.position.x; g.z += u.position.z; g.n++; g.sel ||= !!u.selected;
        _sq.set(sq, g);
        continue;
      }
      const m = frame.toMini(u.position.x, u.position.z);
      const key = u.selected ? "sel" : u.team === "player" ? "player" : "enemy";
      if (u.isAir) _air[key].push(m.x, m.y, frame.upYaw - (u.heading ?? 0));
      else if (u.type?.foot) _foot[key].push(m.x, m.y);
      else _veh[key].push(m.x, m.y);
    }
    for (const g of _sq.values()) {
      const m = frame.toMini(g.x / g.n, g.z / g.n);
      _squad[g.sel ? "sel" : "player"].push(m.x, m.y);
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
        const r = 1.9 * s;     // (1.55: a speck at play)
        for (let i = 0; i < f.length; i += 2) { c.moveTo(f[i] + r, f[i + 1]); c.arc(f[i], f[i + 1], r, 0, Math.PI * 2); }
        c.fillStyle = fill; c.stroke(); c.fill();
      }
      // squads: a bigger round badge with a dark centre (one per squad, CoH)
      const q = _squad[key];
      if (q.length) {
        c.beginPath();
        const r = 3.6 * s;
        for (let i = 0; i < q.length; i += 2) { c.moveTo(q[i] + r, q[i + 1]); c.arc(q[i], q[i + 1], r, 0, Math.PI * 2); }
        c.fillStyle = fill; c.stroke(); c.fill();
        c.beginPath();
        for (let i = 0; i < q.length; i += 2) { c.moveTo(q[i] + r * 0.38, q[i + 1]); c.arc(q[i], q[i + 1], r * 0.38, 0, Math.PI * 2); }
        c.fillStyle = "rgba(8,12,20,0.8)"; c.fill();
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
    flushLabels(c);   // names last: on top of the units
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
      if (!locked) { locked = true; root.classList.add("locked"); terr.ctx.clearRect(0, 0, px, px); terrKey = ""; fog.ctx.clearRect(0, 0, px, px); cam.ctx.clearRect(0, 0, px, px); lastCam = null; fogShown = false; }
      drawLocked(now);
      return;
    }
    if (locked) { locked = false; root.classList.remove("locked"); unitsT = 0; }
    drawFog(now);
    if (now - unitsT >= 1000 / UNITS_HZ) {
      unitsT = now;
      drawTerritory();
      watchCombat(now);
      drawUnits(now);
    }
    drawCamera();
  }

  return {
    root,
    draw,
    hasRadioIntel: hasIntel,
    /** An alert's place (algBattle.js): brass rings over it for 3 s. */
    ping(x, z) { pings.push({ x, z, t: performance.now() }); },
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
