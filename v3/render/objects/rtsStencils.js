/**
 * STENCILS — painted army markings on props: the medic's red cross, U.S. ARMY,
 * unit codes, the white star.
 *
 * Not decals: the engine's projected decals are ground-only on purpose (they
 * fade out 0.35 m above the terrain, or wheel ruts painted the jeeps). A
 * marking here is a thin patch that FOLLOWS the surface it is painted on — a
 * container's corrugation, a tent's sagging canvas — lifted a few millimetres
 * off it, on one shared cut-out sheet (transparent background, alpha-tested,
 * so no sorting). Every marking in the game is one material; a prop's markings
 * are one merged geometry riding as a child of the prop.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { makeRubbleTexture } from "./rtsTextures.js";

// 1024 wide, 2048 tall. The top 1024 rows are the original sheet (Vietnam,
// every cell where it always was); the bottom half is the French army's
// markings for the Algeria game. UVs divide by these, so a cell only ever
// states its pixels.
const SHEET_W = 1024, SHEET_H = 2048;

/** Cells on the stencil sheet, in pixels. `aspect` = width / height. */
export const STENCILS = {
  // Red cross on a white square: the roof marking of an aid station.
  medicSquare:  { x: 0,   y: 0,   w: 512, h: 512 },
  // The cross alone, for walls and flaps.
  medicCross:   { x: 512, y: 0,   w: 256, h: 256 },
  // The Army star in its ring, white.
  star:         { x: 768, y: 0,   w: 256, h: 256 },
  armyWhite:    { x: 512, y: 256, w: 512, h: 128 },
  armyBlack:    { x: 512, y: 384, w: 512, h: 128 },
  unitCode:     { x: 0,   y: 512, w: 512, h: 128 },
  containerId:  { x: 0,   y: 640, w: 512, h: 128 },
  medical:      { x: 512, y: 512, w: 512, h: 128 },
  noSmoking:    { x: 512, y: 640, w: 512, h: 128 },
  // The landing H in its ring, white, for a helipad's deck.
  helipadH:     { x: 0,   y: 768, w: 256, h: 256 },
  // Red and white bands across the cell (t runs along them): a windsock's cloth.
  sockBands:    { x: 256, y: 768, w: 64,  h: 256 },
  // One PSP plank's punched holes and pressed ribs, laid along a plank.
  pspHoles:     { x: 320, y: 768, w: 512, h: 48 },
  // A vehicle's bumper code, white, for trim vanes and bumpers.
  bumperCode:   { x: 320, y: 832, w: 512, h: 96 },
  // A helicopter's tail number, black, for the fin.
  tailNumber:   { x: 320, y: 928, w: 384, h: 96 },
  // The National Liberation Front's flag as a cloth banner (red over blue, the
  // yellow star), opaque, for hanging off the enemy HQ's loggia.
  nlfBanner:    { x: 832, y: 768, w: 192, h: 128 },
  // The yellow star on a red disc, painted over the pediment's oculus.
  nlfStar:      { x: 832, y: 896, w: 128, h: 128 },
  // A hull number in white, for the other side's armour (PT-76 turret cheeks).
  hullNumber:   { x: 704, y: 928, w: 128, h: 96 },

  // ── FRANCE, 1954-62 (the Algeria game) — the sheet's bottom half ─────────
  // The tricolour, 3:2, opaque: a painted board over a gate, a flag on a mast.
  frTricolore:  { x: 0,   y: 1024, w: 384, h: 256 },
  // The cockade — blue ring, white, red centre: aircraft, helicopters, some armour.
  frCocarde:    { x: 384, y: 1024, w: 256, h: 256 },
  // A post's name board: black capitals on whitewash.
  frPosteSign:  { x: 640, y: 1024, w: 384, h: 128 },
  // A vehicle's registration: the little tricolour, then the number, white on
  // olive-black — the French army plate.
  frPlate:      { x: 640, y: 1152, w: 384, h: 96 },
  frArmeeWhite: { x: 0,   y: 1280, w: 512, h: 96 },
  frArmeeBlack: { x: 512, y: 1280, w: 512, h: 96 },
  // A unit's code, white (parachutists' jeeps, trucks' tailboards).
  frUnitCode:   { x: 0,   y: 1376, w: 384, h: 96 },
  // A helicopter's serial on the tail boom, black.
  frTailSerial: { x: 384, y: 1376, w: 384, h: 96 },
  // An SAS post's board: "S.A.S." — the civil-military section's sign.
  frSasSign:    { x: 768, y: 1376, w: 256, h: 96 },
  // Whitewash fallen off a rubble wall: a ragged patch of the stones behind,
  // with the broken lip of plaster round it. Two shapes, so a wall of them
  // is not one stamp repeated.
  plasterFallA: { x: 0,   y: 1472, w: 256, h: 160 },
  plasterFallB: { x: 256, y: 1472, w: 256, h: 160 },
  // A helicopter's serial in white, for the ALAT's dark olive.
  frSerialWhite: { x: 512, y: 1472, w: 384, h: 96 },
  // WEATHER on whitewash (the buildings lab, 2026-10-07): grime washed down from a coping or a
  // slit — ragged drips, darker at the top; and the dust thrown up the foot of a wall, its top
  // edge wandering. Hard-edged (the sheet is alpha-tested): shapes, not haze.
  rainStreakA:  { x: 0,   y: 1632, w: 128, h: 320 },
  rainStreakB:  { x: 128, y: 1632, w: 128, h: 320 },
  wallFootDust: { x: 256, y: 1632, w: 640, h: 128 },
  // WEATHER on STONE (the village houses, 2026-10-08): the whitewash's light grime read as white
  // icicles on grey rubble — on stone, water leaves DARK stains and the dust is the ground's earth.
  stoneStreak:   { x: 896, y: 1632, w: 128, h: 320 },
  stoneFootDust: { x: 256, y: 1760, w: 640, h: 128 },
};
for (const s of Object.values(STENCILS)) s.aspect = s.w / s.h;

const FONT = "'Stencil', 'Stencil Std', Impact, 'Arial Black', sans-serif";

function drawSheet() {
  const cv = document.createElement("canvas");
  cv.width = SHEET_W; cv.height = SHEET_H;
  const g = cv.getContext("2d");
  g.clearRect(0, 0, SHEET_W, SHEET_H);
  const cross = (cx, cy, arm, w, col) => {
    g.fillStyle = col;
    g.fillRect(cx - w / 2, cy - arm, w, arm * 2);
    g.fillRect(cx - arm, cy - w / 2, arm * 2, w);
  };
  // Worn paint: knock small holes out of what was just drawn in a cell.
  const wear = (x, y, w, h, n = 260) => {
    g.save();
    g.globalCompositeOperation = "destination-out";
    let s = x * 7 + y * 13 + 1;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) { g.globalAlpha = 0.3 + r() * 0.7; g.fillRect(x + r() * w, y + r() * h, 1 + r() * 5, 1 + r() * 3); }
    g.restore();
  };
  const text = (str, x, y, w, h, col, px) => {
    g.fillStyle = col;
    g.font = `bold ${px}px ${FONT}`;
    g.textAlign = "center"; g.textBaseline = "middle";
    const m = g.measureText(str).width;
    g.save(); g.translate(x + w / 2, y + h / 2 + px * 0.04);
    if (m > w * 0.92) g.scale((w * 0.92) / m, 1);
    g.fillText(str, 0, 0); g.restore();
  };
  let c = STENCILS.medicSquare;
  g.fillStyle = "#ece8dc"; g.fillRect(c.x + 8, c.y + 8, c.w - 16, c.h - 16);
  cross(c.x + c.w / 2, c.y + c.h / 2, 190, 128, "#b3201b");
  wear(c.x, c.y, c.w, c.h, 400);
  c = STENCILS.medicCross;
  cross(c.x + c.w / 2, c.y + c.h / 2, 110, 74, "#b3201b");
  wear(c.x, c.y, c.w, c.h, 120);
  c = STENCILS.star;
  {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    g.strokeStyle = "#e9e6dc"; g.lineWidth = 12;
    g.beginPath(); g.arc(cx, cy, 112, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#e9e6dc"; g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 === 0 ? 100 : 38;
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    wear(c.x, c.y, c.w, c.h, 150);
  }
  c = STENCILS.armyWhite; text("U.S. ARMY", c.x, c.y, c.w, c.h, "#e9e6dc", 104); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.armyBlack; text("U.S. ARMY", c.x, c.y, c.w, c.h, "#1d1d1a", 104); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.unitCode; text("1-35 INF   HQ 7", c.x, c.y, c.w, c.h, "#e9e6dc", 76); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.containerId; text("USAU 204518", c.x, c.y, c.w, c.h, "#e9e6dc", 84); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.medical; text("BN AID STATION", c.x, c.y, c.w, c.h, "#b3201b", 72); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.noSmoking; text("NO SMOKING", c.x, c.y, c.w, c.h, "#b3201b", 88); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.helipadH;
  {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    g.strokeStyle = "#e9e6dc"; g.lineWidth = 14;
    g.beginPath(); g.arc(cx, cy, 108, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#e9e6dc";
    g.fillRect(cx - 52, cy - 66, 26, 132);
    g.fillRect(cx + 26, cy - 66, 26, 132);
    g.fillRect(cx - 26, cy - 12, 52, 24);
    wear(c.x, c.y, c.w, c.h, 260);
  }
  c = STENCILS.sockBands;
  // Canvas y runs DOWN the cell and t runs UP it: band 0 (the mouth, t = 0)
  // is the bottom one. Five bands, red at the mouth and the tail. Opaque, so
  // the cloth is solid under the alpha test.
  for (let k = 0; k < 5; k++) {
    g.fillStyle = k % 2 === 0 ? "#c4401e" : "#e9e6dc";
    g.fillRect(c.x, c.y + c.h - ((k + 1) * c.h) / 5, c.w, c.h / 5 + 1);
  }
  c = STENCILS.tailNumber; text("69-15078", c.x, c.y, c.w, c.h, "#1d1d1a", 70); wear(c.x, c.y, c.w, c.h, 60);
  c = STENCILS.hullNumber; text("555", c.x, c.y, c.w, c.h, "#e9e6dc", 78); wear(c.x, c.y, c.w, c.h, 90);
  c = STENCILS.bumperCode; text("11 ACR   A-13", c.x, c.y, c.w, c.h, "#e9e6dc", 64); wear(c.x, c.y, c.w, c.h, 140);
  const star5 = (cx, cy, R, col) => {
    g.fillStyle = col; g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 === 0 ? R : R * 0.382;
      g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
  };
  c = STENCILS.nlfBanner;
  g.fillStyle = "#b8141f"; g.fillRect(c.x + 2, c.y + 2, c.w - 4, c.h / 2 - 2);
  g.fillStyle = "#1a5aa8"; g.fillRect(c.x + 2, c.y + c.h / 2, c.w - 4, c.h / 2 - 2);
  star5(c.x + c.w / 2, c.y + c.h / 2, c.h * 0.3, "#f2c31a");
  c = STENCILS.nlfStar;
  g.fillStyle = "#b8141f"; g.beginPath(); g.arc(c.x + c.w / 2, c.y + c.h / 2, c.w / 2 - 4, 0, Math.PI * 2); g.fill();
  star5(c.x + c.w / 2, c.y + c.h / 2 + 3, c.w * 0.36, "#f2c31a");
  wear(c.x, c.y, c.w, c.h, 60);
  c = STENCILS.pspHoles;
  {
    // M8A1 plank: a row of punched holes down the middle, each with the lip
    // the punch pressed up round it catching the light, and a pressed rib
    // either side. Dark earth shows through the holes.
    const n = 16, cy = c.y + c.h / 2;
    g.fillStyle = "#8d8474";
    g.fillRect(c.x + 6, c.y + 5, c.w - 12, 4);
    g.fillRect(c.x + 6, c.y + c.h - 9, c.w - 12, 4);
    for (let k = 0; k < n; k++) {
      const cx = c.x + ((k + 0.5) * c.w) / n;
      g.fillStyle = "#9a907e";
      g.beginPath(); g.ellipse(cx, cy, 13, 12, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#231d15";
      g.beginPath(); g.ellipse(cx, cy, 10, 9, 0, 0, Math.PI * 2); g.fill();
    }
  }
  drawFrench(g, text, wear);
  return cv;
}

// The French army's colours, as painted (not the modern screen values): a
// dark ultramarine and a vermilion that sun and dust have both taken down.
const FR_BLUE = "#1f3f8f", FR_WHITE = "#ece8dc", FR_RED = "#c1272d";

/** The bottom half of the sheet: France, 1954-62. */
function drawFrench(g, text, wear) {
  let c = STENCILS.frTricolore;
  // Opaque, edge to edge: a flag or a painted board is solid under the alpha test.
  [FR_BLUE, FR_WHITE, FR_RED].forEach((col, k) => {
    g.fillStyle = col;
    g.fillRect(c.x + (k * c.w) / 3, c.y, c.w / 3 + 1, c.h);
  });
  c = STENCILS.frCocarde;
  {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2, R = c.w / 2 - 4;
    for (const [r, col] of [[R, FR_BLUE], [R * 0.66, FR_WHITE], [R * 0.33, FR_RED]]) {
      g.fillStyle = col; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    }
    wear(c.x, c.y, c.w, c.h, 90);
  }
  c = STENCILS.frPosteSign;
  g.fillStyle = "#e6e0d0"; g.fillRect(c.x + 4, c.y + 4, c.w - 8, c.h - 8);
  g.strokeStyle = "#2a2622"; g.lineWidth = 6; g.strokeRect(c.x + 12, c.y + 12, c.w - 24, c.h - 24);
  text("POSTE DE TIGHANIMINE", c.x + 16, c.y + 16, c.w - 32, c.h - 32, "#1d1b18", 58);
  wear(c.x, c.y, c.w, c.h, 160);
  c = STENCILS.frPlate;
  g.fillStyle = "#26281f"; g.fillRect(c.x + 2, c.y + 8, c.w - 4, c.h - 16);
  [FR_BLUE, FR_WHITE, FR_RED].forEach((col, k) => {
    g.fillStyle = col; g.fillRect(c.x + 14 + k * 16, c.y + 22, 16, c.h - 44);
  });
  text("6 124 578", c.x + 72, c.y, c.w - 80, c.h, FR_WHITE, 62);
  wear(c.x, c.y, c.w, c.h, 120);
  c = STENCILS.frArmeeWhite; text("ARMÉE DE TERRE", c.x, c.y, c.w, c.h, "#e9e6dc", 76); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.frArmeeBlack; text("ARMÉE DE TERRE", c.x, c.y, c.w, c.h, "#1d1d1a", 76); wear(c.x, c.y, c.w, c.h);
  c = STENCILS.frUnitCode; text("9e R.C.P.   3", c.x, c.y, c.w, c.h, "#e9e6dc", 70); wear(c.x, c.y, c.w, c.h, 140);
  c = STENCILS.frTailSerial; text("F-MBJK", c.x, c.y, c.w, c.h, "#1d1d1a", 74); wear(c.x, c.y, c.w, c.h, 60);
  c = STENCILS.frSerialWhite; text("MBJ", c.x, c.y, c.w, c.h, "#ece8dc", 86); wear(c.x, c.y, c.w, c.h, 60);
  c = STENCILS.frSasSign;
  g.fillStyle = "#e6e0d0"; g.fillRect(c.x + 4, c.y + 4, c.w - 8, c.h - 8);
  text("S.A.S.", c.x + 10, c.y + 8, c.w - 20, c.h - 16, "#1f3f8f", 70);
  wear(c.x, c.y, c.w, c.h, 90);
  plasterFall(g, STENCILS.plasterFallA, 5);
  plasterFall(g, STENCILS.plasterFallB, 11);
  rainStreak(g, STENCILS.rainStreakA, 3);
  rainStreak(g, STENCILS.rainStreakB, 17);
  footDust(g, STENCILS.wallFootDust, 23);
  rainStreak(g, STENCILS.stoneStreak, 29, { top: [62, 56, 48], end: [92, 84, 72], wash: [70, 63, 54] });
  footDust(g, STENCILS.stoneFootDust, 31, { top: [138, 116, 88], foot: [112, 92, 68], splash: [130, 110, 84] });
}

/** Grime washed down a wall: a few ragged drips from the top, each its own length and width. */
function rainStreak(g, c, seed, { top = [168, 158, 142], end = [194, 184, 168], wash = [158, 146, 124] } = {}) {
  let s = seed * 2654435761 >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  // (First cut: thin and near-black — a comb. Fewer, wider, lighter washes.)
  const n = 2 + Math.floor(r() * 2);
  for (let k = 0; k < n; k++) {
    const x0 = c.x + 6 + r() * (c.w - 50), w0 = 18 + r() * 22, len = c.h * (0.3 + r() * 0.55);
    // Down the drip in short steps: it narrows and wanders, the colour fades from grime to stain.
    let x = x0, w = w0;
    for (let y = 0; y < len; y += 4) {
      const t = y / len;
      g.fillStyle = `rgb(${[0, 1, 2].map((i) => Math.round(top[i] + (end[i] - top[i]) * t)).join(", ")})`;
      g.fillRect(x, c.y + y, Math.max(2, w), 5);
      x += (r() - 0.5) * 1.6;
      w = w0 * (1 - t * 0.75) + (r() - 0.5) * 2;
    }
    // A wider wash at the top, where the water left the coping.
    g.fillStyle = `rgb(${wash.join(", ")})`;
    g.fillRect(x0 - 4, c.y, w0 + 8, 10 + r() * 10);
  }
}

/** Dust up a wall's foot: ochre, the top edge a wandering line, splashes above it. */
function footDust(g, c, seed, { top: c0 = [186, 170, 142], foot: c1 = [164, 146, 118], splash = [184, 168, 140] } = {}) {
  let s = seed * 2654435761 >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const ph = [r() * 6, r() * 6, r() * 6];
  for (let x = 0; x < c.w; x += 2) {
    const top = c.h * (0.25 + 0.2 * Math.sin(x * 0.013 + ph[0]) + 0.12 * Math.sin(x * 0.041 + ph[1]) + 0.06 * Math.sin(x * 0.17 + ph[2]));
    for (let y = Math.max(0, Math.floor(top)); y < c.h; y += 4) {
      const t = (y - top) / (c.h - top);
      g.fillStyle = `rgb(${[0, 1, 2].map((i) => Math.round(c0[i] + (c1[i] - c0[i]) * t)).join(", ")})`;
      g.fillRect(c.x + x, c.y + y, 2, 4);
    }
    if (r() < 0.08) {   // a splash above the line
      g.fillStyle = `rgb(${splash.join(", ")})`;
      g.fillRect(c.x + x, c.y + top - 6 - r() * 18, 3 + r() * 4, 3 + r() * 4);
    }
  }
}

/**
 * A patch of fallen whitewash: a ragged outline (a noisy ellipse), inside it
 * rough limestone blocks with earth joints — the wall under the plaster — and
 * round the edge the broken lip of plaster, lighter where it catches the sun
 * and a dark line where it stands off the stone. Transparent outside, so the
 * alpha test cuts the outline.
 */
function plasterFall(g, c, seed) {
  let s = seed * 2654435761 >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2, rx = c.w * 0.46, ry = c.h * 0.44;
  // Broken, not blobby: a slow wobble (the patch's shape) plus a fast jag
  // (plaster breaks along short straight cracks).
  const N = 72, rad = [];
  for (let k = 0; k < N; k++) rad.push(0.6 + r() * 0.4);
  for (let p = 0; p < 3; p++) for (let k = 0; k < N; k++) rad[k] = (rad[k] + rad[(k + 1) % N] + rad[(k + N - 1) % N]) / 3;
  for (let k = 0; k < N; k++) rad[k] += (r() - 0.5) * 0.12;
  const outline = (scale) => {
    g.beginPath();
    for (let k = 0; k < N; k++) {
      const a = (k / N) * Math.PI * 2;
      g.lineTo(cx + Math.cos(a) * rx * rad[k] * scale, cy + Math.sin(a) * ry * rad[k] * scale);
    }
    g.closePath();
  };
  // The lip of broken plaster: slightly larger, pale.
  outline(1.0); g.fillStyle = "#d9d2c2"; g.fill();
  outline(0.9); g.fillStyle = "#3a3026"; g.fill();       // the shadow line under the lip
  // The stones, clipped to the inner outline: the SAME rubble surface the
  // walls' footings are drawn in, so the stone behind the plaster is the
  // stone below it. A patch is ~2-4 m wide over 256 px and the rubble tile is
  // 2 m over 512 px: drawn at a third so its stones stay ~30 cm.
  g.save(); outline(0.88); g.clip();
  const rub = rubbleCanvas();
  const tile = 180;
  for (let y = c.y - (seed % 5) * 20; y < c.y + c.h; y += tile) {
    for (let x = c.x - (seed % 7) * 20; x < c.x + c.w; x += tile) g.drawImage(rub, x, y, tile, tile);
  }
  // Shade the stone a little deeper than the footings: it is recessed.
  g.fillStyle = "rgba(40, 30, 20, 0.22)"; g.fillRect(c.x, c.y, c.w, c.h);
  g.restore();
}

let _rubble = null;
function rubbleCanvas() {
  if (!_rubble) _rubble = makeRubbleTexture({ size: 512 }).image;
  return _rubble;
}

let _mat = null;
/** The one material every stencil in the game shares. */
export function stencilMaterial() {
  if (_mat) return _mat;
  const tex = new THREE.CanvasTexture(drawSheet());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  _mat = new THREE.MeshStandardNodeMaterial({
    map: tex, alphaTest: 0.5, roughness: 0.9, metalness: 0,
    // Belt and braces on top of the lift off the surface: paint is a
    // coplanar layer by nature, and at RTS distance millimetres are nothing.
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  _mat.name = "RtsStencil";
  return _mat;
}

/**
 * Whether a mesh with this material may cast a shadow. A stencil must NOT,
 * and not only because paint on a surface has no shadow of its own:
 *
 * THE SHADOW PASS IS SHARED STATE. three renders every caster through ONE
 * shadow material and copies each caster's `alphaTest` onto it, and flipping
 * `alphaTest` between zero and non-zero bumps that material's `version`. With
 * the stencils (alphaTest 0.5) interleaved among ~110 alpha-0 casters, the
 * version moved every frame, so EVERY shadow draw failed its render-object
 * check and rebuilt its material cache key: 112 rebuilds a frame, ~1 ms of
 * CPU in a fight (measured 2026-09-24). With them out it is under one.
 * Any caster with `alphaTest` > 0 does this, the stencils were just the most.
 */
export function mayCastShadow(material) {
  const m = Array.isArray(material) ? material[0] : material;
  return !(m?.alphaTest > 0);
}

/**
 * A stencil laid on a surface. `surface(s, t)` maps the patch's own
 * coordinates (s across, t up, both 0..1) to `{ p: Vector3, n: Vector3 }` on
 * the object — a flat face, a corrugated wall, a sagging roof — and the patch
 * is lifted `lift` metres along n. `segS` x `segT` is how finely it follows.
 */
export function stencilPatch(cell, surface, { segS = 1, segT = 1, lift = 0.006, sList = null } = {}) {
  const c = STENCILS[cell];
  const u0 = c.x / SHEET_W, u1 = (c.x + c.w) / SHEET_W;
  const v0 = 1 - (c.y + c.h) / SHEET_H, v1 = 1 - c.y / SHEET_H;
  // `sList`: explicit s stations (sorted 0..1) — put a column on every corner
  // of a folded surface, so the paint does not cut across it.
  const ss = sList ?? Array.from({ length: segS + 1 }, (_, i) => i / segS);
  segS = ss.length - 1;
  const pos = [], nrm = [], uvs = [], idx = [];
  for (let j = 0; j <= segT; j++) {
    for (let i = 0; i <= segS; i++) {
      const s = ss[i], t = j / segT;
      const { p, n } = surface(s, t);
      pos.push(p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift);
      nrm.push(n.x, n.y, n.z);
      uvs.push(u0 + (u1 - u0) * s, v0 + (v1 - v0) * t);
    }
  }
  const row = segS + 1;
  for (let j = 0; j < segT; j++) {
    for (let i = 0; i < segS; i++) {
      const a = j * row + i;
      idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  // Winding follows the surface's own normal, whichever way s and t run.
  const a = new THREE.Vector3().fromArray(pos, 0), b = new THREE.Vector3().fromArray(pos, 3), d = new THREE.Vector3().fromArray(pos, row * 3);
  const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a));
  if (face.dot(new THREE.Vector3(nrm[0], nrm[1], nrm[2])) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    g.setIndex(idx);
  }
  return g;
}

/**
 * A flat face: centre, the face's outward normal and its "right" direction;
 * `width` metres wide, height from the cell's aspect.
 */
export function flatSurface(center, normal, right, width, cell) {
  const n = new THREE.Vector3(...normal).normalize();
  const r = new THREE.Vector3(...right).normalize();
  const up = new THREE.Vector3().crossVectors(n, r).normalize();
  const h = width / STENCILS[cell].aspect;
  const c = new THREE.Vector3(...center);
  return (s, t) => ({ p: c.clone().addScaledVector(r, (s - 0.5) * width).addScaledVector(up, (t - 0.5) * h), n });
}

/** Merge a prop's stencil patches into the one geometry its child mesh draws. */
export function mergeStencils(patches) {
  const list = patches.filter(Boolean);
  if (!list.length) return null;
  const g = mergeGeometries(list, false);
  for (const p of list) p.dispose();
  return g;
}

/**
 * STENCILS CARRIED IN A PARTS LIST (2026-10-08, the village weathering): a builder pushes
 * `{ stencil: geo, pos: [0, 0, 0] }` among its parts (assemble skips them: no `geo`), so anything
 * that moves the parts afterwards — a dechra seating a house on the slope (rtsAlgVillage lift) —
 * moves the paint with them. This collects them, each moved by its `pos`, merged and `scale`d
 * like the piece. Null when there are none.
 */
export function stencilsOf(parts, scale = 1) {
  const list = [];
  for (const p of parts) {
    if (!p?.stencil) continue;
    const [x, y, z] = p.pos ?? [0, 0, 0];
    if (x || y || z) p.stencil.translate(x, y, z);
    list.push(p.stencil);
  }
  const g = mergeStencils(list);
  if (g && scale !== 1) g.scale(scale, scale, scale);
  return g;
}

/** A mesh for a prop's merged stencils (null-safe), ready to add as its child. */
export function stencilMesh(geo) {
  if (!geo) return null;
  const m = new THREE.Mesh(geo, stencilMaterial());
  m.name = "Stencils";
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}
