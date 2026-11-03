// THE CAR'S LIVERY: sponsors, number, logos (user, 2026-11-03: "decals should also be using some nice brand and the
// logo on the car, you know typical sponsor on cars … everything should be very optimized").
//
// NO DECAL MESHES, NO UVs: the paint shader (thunderCar.js paintMaterial) PROJECTS one livery sheet onto the body —
// from above (hood, roof, deck), from each side, from the front and the rear — choosing the view by the surface's
// facing. One texture, one sample per pixel, nothing else: no draw, no triangle, no state change.
//
// The sheet holds one region per view, drawn here in the car's metres (the file's frame: x ±1.2 across, y up from the
// ground, z −2.4 the nose → +2.2 the tail). The sponsors are MADE UP (a Steam game can't carry real brands unlicensed).
import * as THREE from "three";
import { texture, vec2, vec4, float, abs, select, positionLocal, normalLocal, mix, uniform } from "three/tsl";

// the car's extent in the file (thunder_car.glb "Paint": x ±1.18, y 0.09…1.34, z −2.39…2.20) with a margin
const X = 1.2, Y0 = 0, Y1 = 1.4, ZF = -2.42, ZR = 2.24;
const LEN = ZR - ZF;
const W = 2048, H = 1024, S = 240; // the sheet, px per metre (sides, front, rear)
const ST = 220; // px per metre on the top view (it is the longest)
// the regions: where each view sits on the sheet, its size in metres
const R = {
  right: { x: 0, y: 0, w: LEN, h: Y1 - Y0, s: S },   // the +x side, seen from outside: the nose on the RIGHT of the picture
  left: { x: 0, y: 340, w: LEN, h: Y1 - Y0, s: S },  // the −x side: the nose on the LEFT
  front: { x: 0, y: 680, w: 2 * X, h: Y1 - Y0, s: S },
  rear: { x: 590, y: 680, w: 2 * X, h: Y1 - Y0, s: S },
  top: { x: 1190, y: 0, w: 2 * X, h: LEN, s: ST },   // seen from above, the nose UP (it reads from the chase camera)
};

/** The livery: what goes where. Positions in metres on each view (u from its left, v from its top). */
export const LIVERY = {
  number: "07",
  grid: false, // the measuring grid (laying the livery out)
};

// ---------- the sheet ----------
let sheet = null;
/** The livery sheet (one texture for every car): drawn once the fonts are in. */
export function liverySheet() {
  if (sheet) return sheet;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  sheet = new THREE.CanvasTexture(cv);
  sheet.colorSpace = THREE.SRGBColorSpace;
  sheet.flipY = false;
  sheet.anisotropy = 8;
  sheet.userData.canvas = cv;
  sheet.userData.ready = Promise.all([loadLogo(), ...['800 100px "Barlow Condensed"', '700 100px "Barlow Condensed"', '600 100px "Inter"', '800 100px "Inter"'].map((f) => document.fonts.load(f).catch(() => null))])
    .then(() => redrawLivery());
  return sheet;
}
export function redrawLivery() {
  if (!sheet) return;
  const g = sheet.userData.canvas.getContext("2d");
  g.clearRect(0, 0, W, H);
  drawLivery(g);
  sheet.needsUpdate = true;
}

/** Draw into one region, in its metres (u right, v down from its top). */
function inRegion(g, r, fn) {
  g.save();
  g.beginPath(); g.rect(r.x, r.y, r.w * r.s, r.h * r.s); g.clip();
  g.translate(r.x, r.y);
  g.scale(r.s, r.s);
  fn(g);
  g.restore();
}

function grid(g, r, label) {
  inRegion(g, r, (c) => {
    c.lineWidth = 0.008;
    for (let u = 0; u <= r.w + 1e-6; u += 0.25) { c.strokeStyle = Math.abs(u % 1) < 1e-6 ? "#ff00ff" : "rgba(0,255,255,0.7)"; c.beginPath(); c.moveTo(u, 0); c.lineTo(u, r.h); c.stroke(); }
    for (let v = 0; v <= r.h + 1e-6; v += 0.25) { c.strokeStyle = Math.abs(v % 1) < 1e-6 ? "#ff00ff" : "rgba(0,255,255,0.7)"; c.beginPath(); c.moveTo(0, v); c.lineTo(r.w, v); c.stroke(); }
    c.fillStyle = "#ff00ff";
    c.font = "800 0.14px Inter";
    for (let u = 0; u < r.w; u += 0.5) for (let v = 0; v < r.h; v += 0.5) c.fillText(`${u.toFixed(1)},${v.toFixed(1)}`, u + 0.03, v + 0.16);
  });
}

// ---------- the sponsors (made up) and the marks ----------
const BOLT = "#9dff00", INK = "#111214", WHITE = "#f4f4f2";
const COND = '"Barlow Condensed", "Arial Narrow", sans-serif';
/** Write `str` centred at (cx, cy), `h` tall, squeezed to `maxW` if wider. */
function word(c, str, cx, cy, h, { weight = 800, fill = INK, italic = false, maxW = Infinity, family = COND, spacing = 0 } = {}) {
  c.save();
  c.font = `${italic ? "italic " : ""}${weight} ${h}px ${family}`;
  c.textAlign = "center"; c.textBaseline = "middle";
  if (spacing) c.letterSpacing = `${spacing * h}px`;
  const w = c.measureText(str).width;
  c.translate(cx, cy);
  if (italic) c.transform(1, 0, -0.18, 1, 0, 0);
  if (w > maxW) c.scale(maxW / w, 1);
  c.fillStyle = fill;
  c.fillText(str, 0, h * 0.04);
  c.restore();
}
const box = (c, x, y, w, h, fill) => { c.fillStyle = fill; c.fillRect(x, y, w, h); };
function roundRect(c, x, y, w, h, r, fill, stroke, lw) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = lw; c.stroke(); }
}
// FLUXOR · energy drink — the main sponsor: a black slanted plate, the name in white, a bolt-green slash
function fluxor(c, cx, cy, w) {
  const h = w / 3.6, x = cx - w / 2, y = cy - h / 2, k = h * 0.35;
  c.beginPath(); c.moveTo(x + k, y); c.lineTo(x + w, y); c.lineTo(x + w - k, y + h); c.lineTo(x, y + h); c.closePath();
  c.fillStyle = INK; c.fill();
  c.beginPath(); c.moveTo(x + k * 0.55, y + h * 0.22); c.lineTo(x + k * 1.25, y + h * 0.22); c.lineTo(x + k * 0.75, y + h * 0.78); c.lineTo(x + k * 0.05, y + h * 0.78); c.closePath();
  c.fillStyle = BOLT; c.fill();
  word(c, "FLUXOR", cx + w * 0.07, cy, h * 0.78, { fill: WHITE, italic: true, maxW: w * 0.72, spacing: 0.04 });
}
// KESTRA · performance tyres: a white tag, a red-orange wing mark, the name in black
function kestra(c, cx, cy, w) {
  const h = w / 3.4, x = cx - w / 2, y = cy - h / 2;
  roundRect(c, x, y, w, h, h * 0.18, WHITE);
  c.beginPath(); c.moveTo(x + h * 0.15, y + h * 0.72); c.lineTo(x + h * 0.55, y + h * 0.22); c.lineTo(x + h * 0.95, y + h * 0.22); c.lineTo(x + h * 0.58, y + h * 0.72); c.closePath();
  c.fillStyle = "#ff4b1f"; c.fill();
  word(c, "KESTRA", x + w * 0.6, y + h * 0.42, h * 0.62, { maxW: w * 0.62, spacing: 0.06 });
  word(c, "PERFORMANCE TYRES", x + w * 0.6, y + h * 0.82, h * 0.2, { weight: 700, maxW: w * 0.62, spacing: 0.1 });
}
// ORVANE · motor oil: a black oval, a white ring, the name in white
function orvane(c, cx, cy, w) {
  const h = w / 2.6;
  c.beginPath(); c.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); c.fillStyle = INK; c.fill();
  c.beginPath(); c.ellipse(cx, cy, w / 2 - h * 0.08, h / 2 - h * 0.08, 0, 0, Math.PI * 2); c.strokeStyle = WHITE; c.lineWidth = h * 0.04; c.stroke();
  word(c, "ORVANE", cx, cy - h * 0.06, h * 0.46, { fill: WHITE, maxW: w * 0.7, spacing: 0.08 });
  word(c, "MOTOR OIL", cx, cy + h * 0.25, h * 0.15, { fill: BOLT, weight: 700, maxW: w * 0.5, spacing: 0.2 });
}
// THUNDERLINE · the game's own wordmark (public/games/thunderline/logo.svg — the menu's and the loading screen's, white),
// as the UI wears it: black, the white logo, a #9DFF00 bar. `ink`: the logo alone in that colour, straight on the paint
const LOGO_URL = "/games/thunderline/logo.svg", LOGO_ASPECT = 1041 / 255;
let logo = null;
const inked = new Map(); // colour → the logo recoloured (a canvas)
function loadLogo() {
  return new Promise((done) => {
    const im = new Image();
    im.onload = () => { logo = im; done(); };
    im.onerror = () => done(); // (no logo: the plates are drawn without it)
    im.src = LOGO_URL;
  });
}
function logoIn(colour) {
  if (!logo) return null;
  if (!inked.has(colour)) {
    const cv = document.createElement("canvas");
    cv.width = 1041; cv.height = 255;
    const c = cv.getContext("2d");
    c.drawImage(logo, 0, 0, cv.width, cv.height);
    c.globalCompositeOperation = "source-in";
    c.fillStyle = colour; c.fillRect(0, 0, cv.width, cv.height);
    inked.set(colour, cv);
  }
  return inked.get(colour);
}
function thunderline(c, cx, cy, w, { ink = null } = {}) {
  if (ink) { const im = logoIn(ink); if (im) c.drawImage(im, cx - w / 2, cy - w / LOGO_ASPECT / 2, w, w / LOGO_ASPECT); return; }
  const lw = w * 0.82, lh = lw / LOGO_ASPECT, h = lh * 1.55, x = cx - w / 2, y = cy - h / 2;
  box(c, x, y, w, h, INK);
  if (logo) c.drawImage(logo, cx - lw / 2, y + h * 0.12, lw, lh);
  box(c, x, y + h * 0.86, w, h * 0.14, BOLT);
}
// the race number: a white roundel, black ring, black figures
function roundel(c, cx, cy, d, num) {
  c.beginPath(); c.arc(cx, cy, d / 2, 0, Math.PI * 2); c.fillStyle = WHITE; c.fill();
  c.lineWidth = d * 0.06; c.strokeStyle = INK; c.beginPath(); c.arc(cx, cy, d / 2 - d * 0.03, 0, Math.PI * 2); c.stroke();
  word(c, num, cx, cy, d * 0.72, { maxW: d * 0.74 });
}

function drawLivery(g) {
  if (LIVERY.grid) { for (const k of Object.keys(R)) grid(g, R[k], k[0].toUpperCase()); return; }
  const n = LIVERY.number;
  // FROM ABOVE (u across, 1.2 the centre line; v back from the nose): the hood, the deck behind the glass roof, the tail
  inRegion(g, R.top, (c) => {
    // (the hood's reads from in FRONT of the car, as on a real one — the showroom and the camera ahead; the rest from behind)
    c.save(); c.translate(1.2, 0.7); c.rotate(Math.PI); fluxor(c, 0, 0, 0.95); c.restore();
    roundel(c, 1.2, 2.45, 0.62, n);
    thunderline(c, 1.2, 4.08, 1.0);
  });
  // EACH SIDE (a back from the nose; v down from 1.4 m): the number on the door, FLUXOR along its foot, the tyre and oil
  // stickers over the arches. Laid out once in `a`, placed on each side (the right side's picture runs nose-right)
  for (const side of ["left", "right"]) {
    const r = R[side], u = (a) => (side === "left" ? a : r.w - a);
    inRegion(g, r, (c) => {
      roundel(c, u(2.05), 0.68, 0.42, n);
      fluxor(c, u(2.1), 0.99, 0.62);
      kestra(c, u(0.98), 0.52, 0.4);
      orvane(c, u(3.74), 0.5, 0.34);
      thunderline(c, u(3.02), 0.94, 0.5, { ink: INK }); // (under the intake, before the rear arch)
    });
  }
  // FROM AHEAD: FLUXOR on the nose's lip
  inRegion(g, R.front, (c) => thunderline(c, 1.2, 0.98, 0.5));
  // (FROM BEHIND: nothing — under the lamps the tail is the vent and the diffuser, trim not paint)
}

// ---------- the projection (in the paint shader) ----------
/**
 * The livery over the paint: `paint` the paint's colour node → the colour with the livery on it. The view is chosen by
 * the surface's facing (normalLocal: the node's scale is uniform), its sheet region read once. `meshMatrix`: the
 * paint mesh's matrix in the car file's frame.
 */
export function liveryNode(paint, tex, meshMatrix) {
  // (the paint mesh's own transform: the shipped file stores quantized positions under a scaled node — its metres back)
  const p = uniform(meshMatrix.clone()).mul(vec4(positionLocal, 1)).xyz;
  const n = normalLocal;
  const ax = abs(n.x), ay = abs(n.y), az = abs(n.z);
  // each view: [col, row] in px on the sheet
  const at = (r, u, v) => vec2(float(r.x).add(u.mul(r.s)), float(r.y).add(v.mul(r.s)));
  const vSide = float(Y1).sub(p.y);
  const right = at(R.right, float(ZR).sub(p.z), vSide);  // (+x side: the nose, −z, to the right)
  const left = at(R.left, p.z.sub(ZF), vSide);
  const front = at(R.front, float(X).sub(p.x), vSide);   // (seen from ahead: −x to the right)
  const rear = at(R.rear, p.x.add(X), vSide);
  const top = at(R.top, p.x.add(X), p.z.sub(ZF));        // (the nose at the top: reads from behind the car)
  const isTop = n.y.greaterThan(0.45).and(ay.greaterThan(ax)).and(ay.greaterThan(az));
  const isSide = ax.greaterThanEqual(az);
  const px = select(isTop, top, select(isSide, select(n.x.greaterThan(0), right, left), select(n.z.lessThan(0), front, rear)));
  const facing = select(isTop, ay, select(isSide, ax, az)).greaterThan(0.35); // (no smear on a face nearly edge-on to its view)
  const c = texture(tex, px.div(vec2(W, H)));
  const a = c.a.mul(select(facing, float(1), float(0)));
  return mix(paint, c.rgb, a);
}
