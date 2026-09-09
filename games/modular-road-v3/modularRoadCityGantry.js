// ── OVERHEAD DIRECTION GANTRIES ──────────────────────────────────────────────
//
// The big blue destination boards: a mast on the kerb, a boom out over the
// carriageway, and a wide panel hanging under it naming where the road goes.
//
// WHY THIS IS ONE DRAW CALL FOR THE WHOLE CITY, and the trick is worth stating
// because it is the same one modularRoadCityRoadSigns.js uses. A gantry is a
// steel mast and a printed panel — two materials, on the face of it. It is not:
// the mast and boom have their UVs pinned into a reserved grey patch in the
// corner of the panel atlas, so one texture and one material cover the lot, the
// three parts merge into a single geometry, and every gantry in the city is one
// InstancedMesh. Adding gantries costs instances, never draws.
//
// THE PANELS ARE DRAWN, NOT LOADED, for the same reason the road signs are: a
// canvas is authored here, in code, so there is nothing to ship, nothing to
// wait for, and no 404 to design around — and `loadGantryFolder` still lets a
// real image replace any slot later without touching this file.
//
// The destinations are French because the city is. They are deliberately a
// mixture of the kinds of thing a real board carries — a centre, a ring road,
// an airport, a motorway number — rather than four variations on one, because
// what makes signage read as real is that no two boards say the same KIND of
// thing.

import * as THREE from "three";
import { attribute, texture, uv, vec3, float, floor, fract, step, positionGeometry } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const GANTRY_DEFAULTS = {
  /** Atlas: four panels stacked, each the full width. The TILE'S ASPECT IS
   *  DERIVED from the panel below, never set here — a tile and a board that
   *  disagree stretch the lettering, and that is the kind of wrong that is
   *  obvious on screen and invisible in the source. */
  rows: 4,
  px: 1024,

  /** The structure. Taller than a signal (`lightHeight` 7.6) so a board never
   *  hides behind the lantern that shares its junction. */
  mastHeight: 9.4,
  mastRadius: 0.15,
  boomReach: 9.0,
  boomThick: 0.22,
  /** The panel, hanging under the boom. Tall enough to carry two destinations
   *  at a size you can read at speed; the bottom edge still clears 6 m, which
   *  is well over anything that drives under it. */
  panelWidth: 7.2,
  panelHeight: 2.7,
  panelDrop: 0.18,
  /** How far out along the boom the panel's centre sits. */
  panelOut: 5.2,

  /** Placement. Set well back from `lightSetback` (7.0) so the board is read
   *  BEFORE the lantern, which is the order a driver needs them in. */
  setback: 26.0,
  chance: 0.16,

  /** Optional overrides, same contract as the road signs. */
  dir: "/city-gantry/",
  extensions: ["png", "webp", "jpg"],
};

/** The panels, top line and bottom line, each with an arrow. */
export const GANTRY_PANELS = [
  [["CENTRE-VILLE", "up"], ["LA DÉFENSE", "right"]],
  [["A6  LYON", "up"], ["PORTE D'ITALIE", "right"]],
  [["AÉROPORT", "up"], ["GARE DU NORD", "right"]],
  [["PÉRIPHÉRIQUE", "up"], ["BOULEVARD SAINT-MICHEL", "right"]],
];

const BLUE = "#0b3f8f", WHITE = "#f2f4f7";
/** The reserved patch every non-panel face is pinned to. */
const STEEL_GREY = "#8d9299";
/** Its size and margin, in atlas pixels. */
const PATCH_PX = 28, PATCH_PAD = 3;

/**
 * THE TILE'S SHAPE COMES FROM THE BOARD'S, and the patch's UV comes from the
 * tile's. Both derived, in one place, because the failure when they disagree
 * is not a crash: a tile at the wrong aspect only makes the lettering subtly
 * too narrow, and a pin that lands a pixel outside its patch only shows up as
 * a smear of the board's artwork creeping up the mast at distance, once the
 * mip chain starts averaging. Legible, plausible, and wrong.
 */
export function gantryTileHeight(P) {
  return Math.round(P.px * P.panelHeight / P.panelWidth);
}
/** The patch as [u0, v0, u1, v1] in TILE-local UV, and the pin at its centre. */
export function gantryPatchUV(P) {
  const th = gantryTileHeight(P);
  return {
    rect: [PATCH_PAD / P.px, PATCH_PAD / th, (PATCH_PAD + PATCH_PX) / P.px, (PATCH_PAD + PATCH_PX) / th],
    pin: [(PATCH_PAD + PATCH_PX / 2) / P.px, (PATCH_PAD + PATCH_PX / 2) / th],
  };
}

/** An arrow, drawn as a mass rather than a glyph so it survives being small. */
function arrow(ctx, cx, cy, s, dir) {
  ctx.save();
  ctx.translate(cx, cy);
  if (dir === "right") ctx.rotate(Math.PI / 2);
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.5);
  ctx.lineTo(s * 0.42, -s * 0.04);
  ctx.lineTo(s * 0.17, -s * 0.04);
  ctx.lineTo(s * 0.17, s * 0.5);
  ctx.lineTo(-s * 0.17, s * 0.5);
  ctx.lineTo(-s * 0.17, -s * 0.04);
  ctx.lineTo(-s * 0.42, -s * 0.04);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * One panel into a tile `w` x `h`. Two lines, each an arrow and a destination,
 * with the text SHRUNK TO FIT rather than clipped — a board that runs its own
 * name off the edge is the one mistake that reads as fake immediately, and
 * "BOULEVARD SAINT-MICHEL" is long enough to do it.
 */
function drawPanel(ctx, slot, w, h) {
  const lines = GANTRY_PANELS[slot];
  ctx.fillStyle = BLUE;
  ctx.fillRect(0, 0, w, h);
  // The white border every French directional board carries.
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = h * 0.035;
  ctx.strokeRect(h * 0.05, h * 0.05, w - h * 0.10, h - h * 0.10);
  if (!lines) return;
  const rowH = (h - h * 0.16) / lines.length;
  lines.forEach(([text, dir], i) => {
    const cy = h * 0.08 + rowH * (i + 0.5);
    arrow(ctx, h * 0.30, cy, rowH * 0.58, dir);
    let size = rowH * 0.52;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const room = w - h * 0.62;
    ctx.font = `700 ${size}px Arial, Helvetica, sans-serif`;
    const wide = ctx.measureText(text).width;
    if (wide > room) {
      size *= room / wide;
      ctx.font = `700 ${size}px Arial, Helvetica, sans-serif`;
    }
    ctx.fillStyle = WHITE;
    ctx.fillText(text, h * 0.56, cy);
  });
}

export function makeGantryAtlas(P) {
  const n = P.rows;
  /*
   * THE TILE'S SHAPE COMES FROM THE BOARD'S. A fixed square canvas cut into
   * four made the tile 4:1 while the panel it maps onto is nearer 8:3, and the
   * only symptom is lettering that is subtly too narrow — legible, plausible,
   * and wrong. Deriving it means the two cannot disagree, whatever the panel
   * is resized to later.
   */
  const th = gantryTileHeight(P);
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return { texture: t, rows: n, slots: n, setImage: () => true, repaint: () => {} };
  }
  const canvas = document.createElement("canvas");
  canvas.width = P.px;
  canvas.height = th * n;
  const ctx = canvas.getContext("2d");
  // UV row 0 is the canvas BOTTOM row, matching the sign and hero atlases.
  const top = (i) => (n - 1 - i) * th;
  function paintTile(i) {
    const y0 = top(i);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, y0, P.px, th); ctx.clip();
    ctx.clearRect(0, y0, P.px, th);
    ctx.translate(0, y0);
    drawPanel(ctx, i, P.px, th);
    // THE RESERVED STEEL PATCH. The mast and boom are pinned here, so the
    // structure is painted steel rather than a smear of the board's artwork.
    // Measured from the tile's BOTTOM, which is where UV v = 0 sits.
    ctx.fillStyle = STEEL_GREY;
    ctx.fillRect(PATCH_PAD, th - PATCH_PAD - PATCH_PX, PATCH_PX, PATCH_PX);
    ctx.restore();
  }
  for (let i = 0; i < n; i++) paintTile(i);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return {
    texture: tex, rows: n, slots: n,
    setImage(slot, img) {
      const i = ((slot | 0) % n + n) % n;
      const y0 = top(i);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, y0, P.px, th); ctx.clip();
      ctx.clearRect(0, y0, P.px, th);
      ctx.drawImage(img, 0, y0, P.px, th);
      ctx.fillStyle = STEEL_GREY;
      ctx.fillRect(PATCH_PAD, y0 + th - PATCH_PAD - PATCH_PX, PATCH_PX, PATCH_PX);
      ctx.restore();
      tex.needsUpdate = true;
      return true;
    },
    repaint(slot) { paintTile(((slot | 0) % n + n) % n); tex.needsUpdate = true; },
  };
}

/**
 * Mast, boom and panel as one geometry.
 *
 * The boom is local +X, matching the traffic signal's arm, so a gantry and a
 * lantern take the SAME yaw and the shared driving-side rule places both
 * without a second convention to keep in step.
 *
 * Only the panel's -Z face carries artwork — the side the oncoming traffic
 * sees, which is the same face the signal head shows its lenses on. Every
 * other face is pinned into the steel patch.
 */
export function buildGantryGeometry(P) {
  const H = P.mastHeight;
  const mast = new THREE.CylinderGeometry(P.mastRadius * 0.85, P.mastRadius, H, 8);
  mast.translate(0, H / 2, 0);
  const boom = new THREE.BoxGeometry(P.boomReach, P.boomThick, P.boomThick);
  boom.translate(P.boomReach / 2, H - P.boomThick, 0);
  const panel = new THREE.BoxGeometry(P.panelWidth, P.panelHeight, 0.09);
  panel.translate(P.panelOut, H - P.boomThick - P.panelDrop - P.panelHeight / 2, 0);

  const [BX, BY] = gantryPatchUV(P).pin;   // the middle of the reserved patch
  const pinAll = (g) => {
    const a = g.getAttribute("uv");
    for (let i = 0; i < a.count; i++) a.setXY(i, BX, BY);
    a.needsUpdate = true;
  };
  pinAll(mast);
  pinAll(boom);
  /*
   * BoxGeometry lays its faces out px, nx, py, ny, pz, nz with four vertices
   * each, so -Z is 20..23. Everything else on the panel is pinned; the artwork
   * mapping is left alone only there.
   */
  const up = panel.getAttribute("uv");
  for (let i = 0; i < up.count; i++) {
    if (i >= 20 && i < 24) continue;
    up.setXY(i, BX, BY);
  }
  up.needsUpdate = true;

  const g = mergeGeometries([mast, boom, panel], false);
  mast.dispose(); boom.dispose(); panel.dispose();
  if (!g) throw new Error("[CityGantry] merge returned null");
  return g;
}

/**
 * One tile per instance, picked by `aTile`.
 *
 * `aTile` is ROUNDED before use. An instanced attribute reaches the fragment
 * stage as a VARYING and is interpolated, so a constant 3.0 can arrive as
 * 2.9999998 and the row decode lands a whole tile out. That bug once put a
 * stretched band of the wrong picture across every hero board in the city; the
 * same arithmetic is here, so the same rounding is too.
 */
export function makeGantryMaterial(atlas, uNight) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.1 });
  mat.name = "CityGantry";
  const aTile = attribute("aTile", "float");
  const tex = texture(atlas.texture);
  const tile = floor(aTile.add(0.5));
  const base = uv();
  const auv = vec3(base.x, tile.add(base.y).div(atlas.rows), 0).xy;
  const texel = tex.sample(auv);
  mat.colorNode = texel.rgb;
  /*
   * RETROREFLECTIVE, night only — real sheeting throws the headlights back at
   * you, so the board lifts out of the dark instead of falling into it with
   * the tower behind. The structure is excluded by the same z test that keeps
   * the artwork on the front face.
   */
  const face = step(positionGeometry.z, float(-0.02));
  mat.emissiveNode = texel.rgb.mul(face).mul(uNight.mul(0.38));
  return mat;
}

/**
 * Replace any panel with a real image, if one is there. Never throws and never
 * logs a miss: the drawn panel is the product, and a file is an override.
 */
export async function loadGantryFolder(atlas, opts = {}) {
  if (typeof document === "undefined") return 0;
  const P = { ...GANTRY_DEFAULTS, ...opts };
  let found = 0;
  for (let i = 0; i < atlas.slots; i++) {
    for (const ext of P.extensions) {
      const url = `${P.dir}${i + 1}.${ext}`;
      const ok = await new Promise((res) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => res(null);
        img.src = url;
      });
      if (ok) { atlas.setImage(i, ok); found++; break; }
    }
  }
  return found;
}
