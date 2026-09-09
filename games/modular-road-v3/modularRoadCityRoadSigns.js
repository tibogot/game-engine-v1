// ============================================================================
// CITY ROAD SIGNS — one mesh, one atlas, every sign in the city.
//
// ── HOW THE IMAGES ARE HANDLED, WHICH IS THE INTERESTING PART ────────────────
//
// TWO SOURCES, AND THE PROCEDURAL ONE IS THE DEFAULT.
//
// Every tile is DRAWN IN CODE with Canvas2D at boot — a red octagon with STOP
// on it, a white disc with a red ring and a number, a downward triangle. That
// is not a placeholder: a road sign is flat vector art made of circles,
// triangles and one piece of text, which is exactly what a 2D canvas is good
// at, and drawing it means the city ships with correct signage and ZERO
// asset files. Nothing to author, nothing to load, nothing to 404.
//
// Then any tile can be REPLACED by dropping a file in `public/city-signs/` —
// `sign-01.png` … `sign-16.png`, numbered by the label the placeholder draws.
// Exactly the mechanism the hero adverts already use (loadHeroAdFolder), for
// the same reason: the texture object never changes identity or size, so a
// swap costs no new draw, no new texture and no shader rebuild. Author at
// 256x256 with transparency and it lands undistorted.
//
// So: it works with no images at all, and every sign is individually
// replaceable by a real one the moment you have it.
//
// ── ALPHA, AND WHY IT IS A DISCARD AND NOT A BLEND ───────────────────────────
//
// Signs are round, triangular and octagonal, so the plate needs a shape. It
// gets one with alphaTest — a DISCARD — and never with blending, because r184
// blends only the `output` MRT attachment: a transparent surface erases the
// emissive buffer behind it and kills the bloom of every lit window it covers.
// A discarded fragment writes to no attachment at all, which is exactly right.
//
// ── THE BACK OF A SIGN IS GREY ───────────────────────────────────────────────
//
// The plate is a box, and only its +Z face carries the artwork; every other
// face is pinned to a reserved grey patch in the corner of each tile. That is
// what keeps this to ONE geometry and ONE draw while still having a sign that
// is a sign from the front and a grey plate from behind — rather than the same
// artwork mirrored, which is what a naive box gives you.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  Fn, float, vec3, vec4, uniform, attribute, texture, uv, fract, floor,
  mix, positionGeometry, step,
} from "three/tsl";

export const ROAD_SIGN_DEFAULTS = {
  /** Atlas geometry. 16 tiles of 256 px in one 1024² texture — a sign is well
   *  under a metre and read from under 60 m, so 256 is already generous. */
  cols: 4,
  rows: 4,
  px: 1024,
  /** Post height to the bottom of the plate, and the plate's size, in metres. */
  postHeight: 2.05,
  plateSize: 0.72,
  /** How far onto the pavement, from the kerb. */
  inset: 0.75,
  /**
   * Chance a block side carries a mid-block sign.
   *
   * WAS 0.55 for ONE sign per block side. A block edge is ~136 m, so that was
   * a sign every ~250 m of frontage — placed, counted in the stats, and never
   * actually seen from the car. Real streets carry signage every junction and
   * often twice between. 0.9, and a second one at the far end of the run.
   */
  signChance: 1.0,
  /** Chance of a SECOND sign on the same block side, at the other end. Signage
   *  is one of the things a real street has a LOT of, and it was still reading
   *  as sparse from the car at 0.55. */
  signChanceSecond: 0.9,
  /** Where the folder overrides live. */
  dir: "/city-signs/",
  extensions: ["png", "webp", "jpg"],
};

/**
 * WHICH SIGN IS WHICH. Index = atlas slot = the number in the filename that
 * overrides it, so `sign-03.png` replaces NO_ENTRY. Order is deliberate: the
 * ones a placement picks at random come first, and the ones placed for a
 * REASON (works ahead) sit at fixed indices the placer names.
 */
export const SIGN = {
  LIMIT_30: 0,
  LIMIT_50: 1,
  NO_ENTRY: 2,
  NO_PARKING: 3,
  GIVE_WAY: 4,
  STOP: 5,
  PEDESTRIAN: 6,
  ONE_WAY: 7,
  WORKS: 8,
};
/** The ones a mid-block placement may roll. Never STOP or GIVE WAY: those mean
 *  a junction, and putting one mid-block is the kind of wrong that reads as
 *  carelessness rather than as decoration. */
export const MIDBLOCK_SIGNS = [
  SIGN.LIMIT_30, SIGN.LIMIT_50, SIGN.NO_PARKING, SIGN.PEDESTRIAN, SIGN.ONE_WAY,
];

const RED = "#c8102e", BLUE = "#0a4ea3", WHITE = "#f4f4f0", DARK = "#1a1c1f";
/** The reserved back-of-sign patch, bottom-left of every tile. */
const BACK_GREY = "#7e838a";

function poly(ctx, cx, cy, r, n, rot) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function disc(ctx, cx, cy, r, fill, ring, ringW) {
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  if (ring) { ctx.lineWidth = ringW; ctx.strokeStyle = ring; ctx.stroke(); }
}

function label(ctx, cx, cy, text, size, colour) {
  ctx.fillStyle = colour;
  ctx.font = `700 ${size}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
}

/**
 * Draw one sign into a tile. `s` is the tile size in pixels; the caller has
 * already translated the origin, so everything here is tile-local.
 */
function drawSign(ctx, slot, s) {
  const c = s / 2, R = s * 0.44;
  switch (slot) {
    case SIGN.LIMIT_30:
    case SIGN.LIMIT_50:
      disc(ctx, c, c, R, WHITE, RED, s * 0.085);
      label(ctx, c, c + s * 0.015, slot === SIGN.LIMIT_30 ? "30" : "50", s * 0.44, DARK);
      break;
    case SIGN.NO_ENTRY:
      disc(ctx, c, c, R, RED);
      ctx.fillStyle = WHITE;
      ctx.fillRect(c - R * 0.62, c - s * 0.075, R * 1.24, s * 0.15);
      break;
    case SIGN.NO_PARKING:
      disc(ctx, c, c, R, BLUE, RED, s * 0.085);
      ctx.strokeStyle = RED; ctx.lineWidth = s * 0.085; ctx.lineCap = "butt";
      ctx.beginPath();
      ctx.moveTo(c - R * 0.62, c + R * 0.62); ctx.lineTo(c + R * 0.62, c - R * 0.62);
      ctx.stroke();
      break;
    case SIGN.GIVE_WAY:
      // Point DOWN. The shape alone is the message; getting it up the wrong
      // way is the single most obvious mistake a road sign can make.
      poly(ctx, c, c + s * 0.03, R * 1.06, 3, Math.PI / 2);
      ctx.fillStyle = WHITE; ctx.fill();
      ctx.lineWidth = s * 0.075; ctx.strokeStyle = RED; ctx.lineJoin = "round"; ctx.stroke();
      break;
    case SIGN.STOP:
      poly(ctx, c, c, R * 1.04, 8, Math.PI / 8);
      ctx.fillStyle = RED; ctx.fill();
      ctx.lineWidth = s * 0.035; ctx.strokeStyle = WHITE; ctx.stroke();
      label(ctx, c, c + s * 0.01, "STOP", s * 0.25, WHITE);
      break;
    case SIGN.PEDESTRIAN: {
      // Blue square, white triangle, zebra bars — readable at 20 px, which is
      // the size it will actually be seen at.
      ctx.fillStyle = BLUE;
      ctx.fillRect(c - R, c - R, R * 2, R * 2);
      poly(ctx, c, c - s * 0.02, R * 0.78, 3, -Math.PI / 2);
      ctx.fillStyle = WHITE; ctx.fill();
      ctx.fillStyle = BLUE;
      for (let i = 0; i < 3; i++) ctx.fillRect(c - R * 0.34 + i * R * 0.26, c + s * 0.06, R * 0.13, R * 0.3);
      break;
    }
    case SIGN.ONE_WAY: {
      ctx.fillStyle = BLUE;
      ctx.fillRect(c - R, c - R * 0.52, R * 2, R * 1.04);
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      ctx.moveTo(c + R * 0.62, c);
      ctx.lineTo(c + R * 0.16, c - R * 0.32);
      ctx.lineTo(c + R * 0.16, c - R * 0.12);
      ctx.lineTo(c - R * 0.66, c - R * 0.12);
      ctx.lineTo(c - R * 0.66, c + R * 0.12);
      ctx.lineTo(c + R * 0.16, c + R * 0.12);
      ctx.lineTo(c + R * 0.16, c + R * 0.32);
      ctx.closePath(); ctx.fill();
      break;
    }
    case SIGN.WORKS: {
      // Warning triangle, point UP, with the digger figure as a solid mass —
      // a literal little man is illegible at this size and reads as noise.
      poly(ctx, c, c - s * 0.03, R * 1.06, 3, -Math.PI / 2);
      ctx.fillStyle = WHITE; ctx.fill();
      ctx.lineWidth = s * 0.075; ctx.strokeStyle = RED; ctx.lineJoin = "round"; ctx.stroke();
      ctx.fillStyle = DARK;
      ctx.beginPath(); ctx.arc(c - s * 0.02, c + s * 0.02, s * 0.045, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(c - s * 0.06, c + s * 0.07, s * 0.09, s * 0.12);
      ctx.save();
      ctx.translate(c + s * 0.05, c + s * 0.10); ctx.rotate(-0.6);
      ctx.fillRect(0, 0, s * 0.115, s * 0.028);
      ctx.restore();
      break;
    }
    default:
      // An unassigned slot still says which file would replace it.
      disc(ctx, c, c, R, "#2b2e33", "#5a5f66", s * 0.04);
      label(ctx, c, c, String(slot + 1).padStart(2, "0"), s * 0.30, "#8b9099");
  }
}

/**
 * The atlas: every tile drawn now, any of them replaceable later.
 * Mirrors makeHeroAtlas's row convention — UV row 0 is the canvas BOTTOM row.
 */
export function makeRoadSignAtlas(P) {
  const n = P.cols * P.rows;
  const tw = P.px / P.cols, th = P.px / P.rows;
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    t.needsUpdate = true;
    return { texture: t, cols: P.cols, rows: P.rows, setImage: () => true, slots: n };
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = P.px;
  const ctx = canvas.getContext("2d");
  const rect = (i) => [(i % P.cols) * tw, (P.rows - 1 - Math.floor(i / P.cols)) * th];
  function paintTile(i) {
    const [x0, y0] = rect(i);
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, tw, th); ctx.clip();
    ctx.clearRect(x0, y0, tw, th);
    ctx.translate(x0, y0);
    drawSign(ctx, i, tw);
    // THE RESERVED BACK PATCH. Every face of the plate except the front is
    // pinned here, so the back of a sign is grey rather than mirrored art.
    // Opaque, or alphaTest would discard the back of every sign in the city.
    ctx.fillStyle = BACK_GREY;
    ctx.fillRect(2, th - 14, 12, 12);
    ctx.restore();
  }
  for (let i = 0; i < n; i++) paintTile(i);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return {
    texture: tex, cols: P.cols, rows: P.rows, slots: n,
    setImage(slot, img) {
      const i = ((slot | 0) % n + n) % n;
      const [x0, y0] = rect(i);
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, tw, th); ctx.clip();
      ctx.clearRect(x0, y0, tw, th);
      ctx.drawImage(img, x0, y0, tw, th);
      ctx.fillStyle = BACK_GREY;
      ctx.fillRect(x0 + 2, y0 + th - 14, 12, 12);
      ctx.restore();
      tex.needsUpdate = true;
      return true;
    },
    repaint(slot) { paintTile(((slot | 0) % n + n) % n); tex.needsUpdate = true; },
  };
}

/**
 * Post plus plate, built once.
 *
 * Only the +Z face of the plate carries artwork; every other face's UVs are
 * pinned to the reserved grey patch. BoxGeometry lays its faces out
 * px, nx, py, ny, pz, nz with four vertices each, so the front is 16..19.
 */
export function buildRoadSignGeometry(P) {
  const S = P.plateSize, H = P.postHeight;
  const post = new THREE.CylinderGeometry(0.045, 0.055, H, 6);
  post.translate(0, H / 2, 0);
  const plate = new THREE.BoxGeometry(S, S, 0.035);
  plate.translate(0, H + S / 2 - 0.06, 0.03);
  const uvA = plate.getAttribute("uv");
  const BX = 0.028, BY = 0.028;          // inside the reserved grey patch
  for (let i = 0; i < uvA.count; i++) {
    if (i >= 16 && i < 20) continue;     // +Z: leave the 0..1 artwork mapping
    uvA.setXY(i, BX, BY);
  }
  uvA.needsUpdate = true;
  // The post has no artwork either.
  const uvP = post.getAttribute("uv");
  for (let i = 0; i < uvP.count; i++) uvP.setXY(i, BX, BY);
  uvP.needsUpdate = true;
  const g = mergeGeometries([post, plate], false);
  post.dispose(); plate.dispose();
  if (!g) throw new Error("[CityRoadSigns] merge returned null");
  return g;
}

/**
 * The material. One tile per instance, picked by `aTile`.
 *
 * `aTile` is ROUNDED before use — an instanced attribute reaches the fragment
 * stage as a varying and is INTERPOLATED, so a constant 4.0 arrives as
 * 3.9999998 and `fract(4/4)` returns 0.99999995 instead of 0. That put a
 * stretched column of the wrong tile across every hero board once; the same
 * arithmetic is here, so the same rounding is too.
 */
export function makeRoadSignMaterial(atlas, uNight) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.0 });
  mat.name = "CityRoadSigns";
  const aTile = attribute("aTile", "float");
  const tex = texture(atlas.texture);
  const tile = floor(aTile.add(0.5));
  const tx = fract(tile.div(atlas.cols));
  const ty = floor(tile.div(atlas.cols)).div(atlas.rows);
  const base = uv();
  const auv = vec3(
    tx.add(base.x.div(atlas.cols)),
    ty.add(base.y.div(atlas.rows)),
    0,
  ).xy;
  const texel = tex.sample(auv);
  mat.colorNode = texel.rgb;
  // DISCARD, never blend — see the note at the top of this file.
  mat.opacityNode = texel.a;
  mat.alphaTest = 0.5;
  /*
   * RETROREFLECTIVE, which is most of what makes a sign look like a sign at
   * night: real sheeting throws the headlights straight back at you, so the
   * face lifts out of the dark instead of falling into it with the wall
   * behind. Approximated as a small night-only emissive of the face's own
   * colour — no light, no second pass, about four ALU. The post is excluded
   * by the same z test that keeps the artwork on the front.
   */
  const face = step(float(0.02), positionGeometry.z);
  mat.emissiveNode = texel.rgb.mul(face).mul(uNight.mul(0.42));
  return mat;
}

/**
 * Fill slots from `public/city-signs/`. MISSING FILES ARE NOT AN ERROR — a
 * slot with no file keeps the drawn one, which is the whole point.
 */
export async function loadRoadSignFolder(atlas, opts = {}) {
  const dir = opts.dir ?? ROAD_SIGN_DEFAULTS.dir;
  const exts = opts.extensions ?? ROAD_SIGN_DEFAULTS.extensions;
  if (typeof Image === "undefined" || !atlas?.setImage) return { loaded: 0 };
  let loaded = 0;
  await Promise.all(Array.from({ length: atlas.slots }, async (_, slot) => {
    const label = String(slot + 1).padStart(2, "0");
    for (const ext of exts) {
      try {
        const img = await new Promise((res, rej) => {
          const im = new Image();
          im.crossOrigin = "anonymous";
          im.onload = () => res(im);
          im.onerror = rej;
          im.src = `${dir}sign-${label}.${ext}`;
        });
        atlas.setImage(slot, img);
        loaded++;
        return;
      } catch (_) { /* not this extension — try the next */ }
    }
  }));
  return { loaded };
}
