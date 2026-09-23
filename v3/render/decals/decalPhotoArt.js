/**
 * PHOTOGRAPHIC DECAL ART — ground wear cut out of real ground photographs, with
 * a normal map, instead of painted flat colour.
 *
 * WHY decalArt.js WAS NOT ENOUGH
 * ------------------------------
 * The decal shader REPLACES the ground's colour and normal under the decal's
 * alpha (decalSystem.js: colorNode = albedo, normalNode = the slot's map). So a
 * decal that is a smooth tinted patch does not add wear — it deletes the
 * photographic ground under it and puts a sticker there. With no normal map,
 * nothing it draws catches the light either: a rut is a darker stripe, not a
 * groove. That is why the old set was invisible at play zoom (toggling all 510
 * off gave an identical frame) and synthetic where it did show.
 *
 * Company of Heroes' splats read because they are photographic AND lit. So
 * every recipe here:
 *
 *   1. SAMPLES A PHOTO IN METRES. The source is a Poly Haven ground set, sampled
 *      at `tileM` metres a repeat — the same scale the terrain layers use — so
 *      the grain under a decal matches the grain around it, whatever the size
 *      or aspect of the decal box. (A square image stretched over a 25 × 6 m
 *      box was 4x coarser along its length than across it.)
 *   2. MODELS A HEIGHT FIELD IN METRES — a 5 cm rut, a 3 cm grouser imprint, a
 *      clod of thrown earth — and derives the normal from its true slope, then
 *      folds in the photo's own normal. Wear is shape first, colour second.
 *   3. KEEPS decalArt.js's THREE RULES: alpha is zero all round the border; the
 *      mask is noise, never a bare gradient; and colour stays within a stop or
 *      so of the photo (darkening, not painting) — the contrast comes from the
 *      shape catching the sun.
 *
 * Strips (ruts, track marks, paths) are baked for boxes laid END TO END with an
 * overlap: every lateral wander is enveloped to zero at both ends, so segment
 * n's ruts meet segment n+1's, and both ends fade over ENDFADE_M.
 *
 * Runs in the browser (it needs a canvas to decode the photos). Deterministic
 * for a given recipe + seed + source photo.
 */
import { makeValueNoise, fbm } from "./decalArt.js";
import { DECAL_LAYER_SIZE } from "./decalTextures.js";

const PH = (slug) => ({
  diff: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${slug}/${slug}_diff_1k.jpg`,
  nor: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${slug}/${slug}_nor_gl_1k.jpg`,
});

/**
 * Source photographs, by role. Poly Haven serves these with CORS `*`, which is
 * what lets a canvas read their pixels. They are BAKE inputs only — the game
 * ships the baked decals, never these.
 */
export const PHOTO_SOURCES = {
  road:     PH("red_dirt_mud_01"),        // the Dirt road layer's own set
  laterite: PH("red_laterite_soil_stones"),
  gravel:   PH("gravel_ground_01"),
  burned:   PH("burned_ground_01"),
  stones:   PH("red_mud_stones"),
};

/** How far each strip end fades, in metres. Placement overlaps segments by this. */
export const ENDFADE_M = 1.5;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, t) => {
  const x = clamp01((t - a) / (b - a || 1e-6));
  return x * x * (3 - 2 * x);
};
const gauss = (x, w) => Math.exp(-(x * x) / (w * w));

function rng(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── photographs ─────────────────────────────────────────────────────────────

const _photoCache = new Map();

async function imagePixels(url) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, px: ctx.getImageData(0, 0, c.width, c.height).data };
}

/**
 * The mean slope of a normal map, in this module's frame (y = image down).
 *
 * A normal map should average to flat. Not all of Poly Haven's do:
 * gravel_ground_01's averages (184, 183, 244) where flat is (128, 128, 255) —
 * the whole map leans ~25°, and baked straight in it painted every gravel
 * decal as one tilted plane (a uniform cyan normal map). Subtracting the mean
 * slope keeps the local relief and drops the lean; on a correct map the mean is
 * ~0 and this changes nothing.
 */
function meanSlope(nor) {
  let sx = 0, sy = 0, n = 0;
  const p = nor.px;
  for (let i = 0; i < p.length; i += 4 * 7) {
    const gz = Math.max(0.2, p[i + 2] / 127.5 - 1);
    sx += (p[i] / 127.5 - 1) / gz;
    sy += -(p[i + 1] / 127.5 - 1) / gz;
    n++;
  }
  return [sx / n, sy / n];
}

/** `{ diff, nor, lean }` of one source, decoded once per page. */
export async function loadPhoto(key) {
  if (_photoCache.has(key)) return _photoCache.get(key);
  const src = PHOTO_SOURCES[key];
  if (!src) throw new Error(`no photo source "${key}"`);
  const job = Promise.all([imagePixels(src.diff), imagePixels(src.nor)])
    .then(([diff, nor]) => ({ diff, nor, lean: meanSlope(nor) }));
  _photoCache.set(key, job);
  return job;
}

/** Bilinear, wrapping. Writes 3 channels 0..1 into `out`. */
function sample3(img, x, y, out) {
  const { w, h, px } = img;
  x = ((x % w) + w) % w; y = ((y % h) + h) % h;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = (x0 + 1) % w, y1 = (y0 + 1) % h;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
  const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  for (let c = 0; c < 3; c++) {
    const top = px[i00 + c] * (1 - fx) + px[i10 + c] * fx;
    const bot = px[i01 + c] * (1 - fx) + px[i11 + c] * fx;
    out[c] = (top * (1 - fy) + bot * fy) / 255;
  }
  return out;
}

// ── strip helpers ───────────────────────────────────────────────────────────

/** 0 at both ends of a strip, 1 through the middle: wander × this chains. */
const chainEnvelope = (v) => Math.sin(Math.PI * v) ** 2;

/** Both ends fade over ENDFADE_M, broken by noise so the join is not a line. */
function endFade(vm, L, n) {
  const e = Math.min(vm, L - vm);
  return smoothstep(0, ENDFADE_M, e + (n - 0.5) * 0.6);
}

// ── the recipes ─────────────────────────────────────────────────────────────
//
// Each returns per-pixel { a, h, mul, sat, nW }:
//   a    coverage 0..1
//   h    height in METRES (normal comes from its real slope)
//   mul  brightness multiplier on the photo
//   sat  saturation multiplier (wet earth is darker AND more saturated)
//   nW   how much of the photo's own normal survives (a tyre flattens grain)

/**
 * WHEEL RUTS — a truck (M35, M151) that went this way more than once.
 * Two grooves 1.85 m apart (an M35's track), each ~0.32 m wide and ~5 cm deep,
 * with the soil it pushed aside heaped as a berm along both lips, a faint
 * chevron tread printed in the floor, and a second, shallower pair a hand's
 * width to one side: one set of ruts reads as one vehicle, two as a road.
 */
function ruts({ xm, vm, W, L, v, n }) {
  const sway = (fbm(n, vm * 0.09, 3.7, 3) - 0.5) * 0.28 * chainEnvelope(v);
  const cx = W / 2 + sway;
  let floor = 0, berm = 0, tread = 0;
  const passes = [[0, 1], [0.19, 0.45]];
  for (const [off, depth] of passes) {
    for (const side of [-1, 1]) {
      const wob = (fbm(n, vm * 0.35, side * 9.1 + off * 40, 2) - 0.5) * 0.06 * chainEnvelope(v);
      const d = Math.abs(xm - (cx + off + side * 0.925 + wob));
      const f = (1 - smoothstep(0.09, 0.17, d)) * depth;
      if (f > floor) floor = f;
      const b = gauss(d - 0.23, 0.07) * depth * (0.45 + 0.55 * fbm(n, xm * 4, vm * 4, 3));
      if (b > berm) berm = b;
      // Chevron tread: a pulse along travel, skewed by distance from centre.
      const ph = vm / 0.11 + Math.abs(xm - (cx + off + side * 0.925)) * 3.2;
      const pulse = smoothstep(0.15, 0.3, ph % 1) * (1 - smoothstep(0.5, 0.65, ph % 1));
      tread = Math.max(tread, pulse * f * (0.5 + 0.5 * n(vm * 1.3, xm * 1.3 + side * 7)));
    }
  }
  // Wet low spots along the floor: where water stood, it is darker still.
  const wet = floor * smoothstep(0.58, 0.72, fbm(n, vm * 0.45, xm * 0.45 + 31, 3));
  const halo = 1 - smoothstep(0.2, 0.6, Math.abs(Math.abs(xm - cx) - 0.925));
  let a = Math.max(floor * 0.95, berm * 0.8, halo * 0.28);
  a *= 0.78 + 0.22 * fbm(n, xm * 2.2, vm * 2.2, 3);
  a *= endFade(vm, L, n(vm * 0.7, 5.5)) * smoothstep(0, 0.35, Math.min(xm, W - xm));
  return {
    a,
    h: -0.05 * floor + 0.022 * berm + 0.007 * tread - 0.006 * wet,
    // Berms are dry, crumbled lips and a clear step lighter; the tread prints a
    // faint light/dark rhythm into the floor. Without both, the colour was two
    // flat stripes and all the rut's shape lived in the normal alone.
    mul: (1 - 0.36 * floor + 0.2 * berm + 0.1 * tread) * (1 - 0.22 * wet),
    sat: 1 + 0.25 * floor,
    nW: 1 - 0.55 * floor - 0.4 * wet,
  };
}

/**
 * TANK TRACKS — an M48 / PT-76 belt: two 0.56 m bands 2.8 m apart, the soil
 * squeezed up between the grousers every 16 cm (so the ladder is REAL relief
 * that catches the sun, at the true pitch — the old art's rungs were ~0.74 m
 * apart), a centre-guide groove down each band, and low berms outside.
 */
function tankTracks({ xm, vm, W, L, v, n }) {
  const sway = (fbm(n, vm * 0.08, 2.1, 3) - 0.5) * 0.3 * chainEnvelope(v);
  const cx = W / 2 + sway;
  let band = 0, pad = 0, groove = 0, berm = 0;
  for (const side of [-1, 1]) {
    const d = Math.abs(xm - (cx + side * 1.4));
    const b = 1 - smoothstep(0.24, 0.31, d);
    if (b > band) {
      band = b;
      const ph = (vm / 0.16 + side * 0.37) % 1;
      pad = smoothstep(0.05, 0.18, ph) * (1 - smoothstep(0.52, 0.7, ph));
      groove = 1 - smoothstep(0.018, 0.045, d);
    }
    berm = Math.max(berm, gauss(d - 0.36, 0.07) * (0.4 + 0.6 * fbm(n, xm * 5, vm * 5, 3)));
  }
  // A slewing tank tears the imprint: let noise break the pads in places.
  const torn = smoothstep(0.55, 0.75, fbm(n, vm * 0.6, xm * 0.6 + 17, 3));
  pad *= 1 - 0.7 * torn;
  const halo = 1 - smoothstep(0.3, 0.75, Math.abs(Math.abs(xm - cx) - 1.4));
  let a = Math.max(band * 0.95, berm * 0.75, halo * 0.3);
  a *= 0.8 + 0.2 * fbm(n, xm * 2, vm * 2, 3);
  a *= endFade(vm, L, n(vm * 0.7, 8.5)) * smoothstep(0, 0.35, Math.min(xm, W - xm));
  return {
    a,
    h: band * (-0.035 + 0.022 * pad - 0.01 * groove) + 0.02 * berm,
    mul: 1 - 0.3 * band + 0.1 * band * pad + 0.06 * berm,
    sat: 1 + 0.18 * band,
    nW: 1 - 0.65 * band,
  };
}

/**
 * MUD — a churned wet patch. The outline is domain-warped noise with lobes (a
 * circle is the most "decal" shape there is), the core is dark, saturated and
 * SMOOTH (wet mud loses the photo's grain), and water stands in its low pockets.
 */
function mud({ xm, vm, W, L, n }) {
  const x = xm - W / 2, z = vm - L / 2;
  const wx = x + (fbm(n, xm * 0.35, vm * 0.35, 3) - 0.5) * 2.4;
  const wz = z + (fbm(n, xm * 0.35 + 50, vm * 0.35, 3) - 0.5) * 2.4;
  const r = Math.hypot(wx, wz) / (Math.min(W, L) * 0.42);
  // Low octaves only in the outline, and a NARROW edge: mud has a rim you
  // could point at. Four octaves over a wide ramp came out as smoke.
  const shape = (1 - r) * 0.8 + (fbm(n, xm * 0.7, vm * 0.7, 2) - 0.5) * 0.6;
  const inside = smoothstep(0.0, 0.07, shape);
  const core = smoothstep(0.2, 0.5, shape);
  const pocket = core * smoothstep(0.6, 0.72, fbm(n, xm * 1.1 + 9, vm * 1.1, 3));
  // Splatter just outside the rim: flung drops, which is what sells "churned".
  const drop = (1 - inside) * smoothstep(-0.12, 0, shape) * smoothstep(0.72, 0.8, n(xm * 5, vm * 5));
  const a = Math.max(inside, drop) * (0.9 + 0.1 * fbm(n, xm * 4, vm * 4, 3));
  return {
    a,
    h: -0.015 * core - 0.012 * pocket + 0.006 * (fbm(n, xm * 6, vm * 6, 3) - 0.5),
    mul: (1 - 0.3 * inside - 0.18 * core) * (1 - 0.3 * pocket),
    sat: 1 + 0.35 * core - 0.4 * pocket,
    nW: 1 - 0.6 * core - 0.4 * pocket,
  };
}

/**
 * PUDDLE — standing water with a wide damp margin. The water is FLAT (nW 0, no
 * relief) so, placed at low roughness, it mirrors the sky; the damp band is the
 * photo darkened, which is what tells the eye "wet" rather than "hole".
 */
function puddle({ xm, vm, W, L, n }) {
  const x = xm - W / 2, z = vm - L / 2;
  const th = Math.atan2(z, x);
  const wob = 1 + 0.3 * (fbm(n, xm * 0.5, vm * 0.5, 3) - 0.5) + 0.1 * Math.sin(th * 3 + 1.3);
  const r = Math.hypot(x, z) / (Math.min(W, L) * 0.36) / wob;
  const water = 1 - smoothstep(0.5, 0.56, r);
  // Damp margin: wide, but its outer edge is a contour, not a haze.
  const damp = 1 - smoothstep(0.95, 1.1, r + (fbm(n, xm * 0.9, vm * 0.9, 2) - 0.5) * 0.45);
  // Water is MUDDY and fairly light: a monsoon puddle on laterite is ochre
  // silt, and its brightness from above is mostly the sky it mirrors. A dark
  // albedo read as a tar-black hole in the game (reflections there are 0.45,
  // not a mirror), so the colour carries it and the low roughness adds sheen.
  const w = smoothstep(0.35, 0.65, water);
  return {
    a: Math.max(water, damp * 0.8),
    h: -0.01 * water,
    mul: (1 - w) * (1 - 0.3 * damp) + w * 0.78,
    sat: (1 - w) * (1 + 0.2 * damp) + w * 0.75,
    nW: 1 - water,
  };
}

/**
 * FOOT PATH — ground worn by feet in single file: a narrow compacted strip, a
 * touch lighter and greyer than the soil (trodden dust), grain flattened, with
 * a faint second track where people step aside.
 */
function footPath({ xm, vm, W, L, v, n }) {
  const cx = W / 2 + (fbm(n, vm * 0.12, 4.4, 3) - 0.5) * 0.7 * chainEnvelope(v);
  const d = Math.abs(xm - cx);
  const main = 1 - smoothstep(0.18, 0.42, d + (n(vm * 2, xm * 2) - 0.5) * 0.12);
  const side = (1 - smoothstep(0.08, 0.2, Math.abs(xm - cx - 0.55))) * smoothstep(0.55, 0.7, fbm(n, vm * 0.3, 2.2, 2));
  let a = Math.max(main, side * 0.5) * (0.75 + 0.25 * fbm(n, xm * 3, vm * 3, 3));
  a *= endFade(vm, L, n(vm * 0.7, 3.3)) * smoothstep(0, 0.25, Math.min(xm, W - xm));
  return {
    a,
    h: -0.015 * main,
    mul: 1 + 0.07 * main,
    sat: 1 - 0.18 * main,
    nW: 1 - 0.45 * main,
  };
}

/**
 * APRON — the made ground round a building: gravel laid in a rounded
 * RECTANGLE (a built thing has corners; an oval under a hut is the tell of a
 * decal), its edge eaten by noise where the gravel thins out into dirt, and a
 * few trodden-dirt patches through it. Full photo normal — gravel is all relief.
 */
function apron({ xm, vm, W, L, n }) {
  const x = (xm - W / 2) / (W * 0.4), z = (vm - L / 2) / (L * 0.4);
  const sq = Math.pow(Math.pow(Math.abs(x), 4) + Math.pow(Math.abs(z), 4), 0.25);
  const edge = sq + (fbm(n, xm * 0.8, vm * 0.8, 4) - 0.5) * 0.35 + (n(xm * 6, vm * 6) - 0.5) * 0.12;
  const inside = 1 - smoothstep(0.82, 1.02, edge);
  const worn = smoothstep(0.58, 0.72, fbm(n, xm * 0.5 + 21, vm * 0.5, 3));
  return {
    a: inside * (0.9 + 0.1 * fbm(n, xm * 3, vm * 3, 2)),
    h: 0.008 * inside,
    mul: 1 - 0.15 * worn,
    sat: 1 - 0.15 * worn,
    nW: 1 - 0.5 * worn,
  };
}

/**
 * SCORCH — burned ground: a charred core fading through ash-grey to a ragged,
 * streaky edge. Colour mostly comes from the burned-ground photo itself.
 */
function scorch({ xm, vm, W, L, n }) {
  const x = xm - W / 2, z = vm - L / 2;
  const th = Math.atan2(z, x);
  const reach = 0.36 + 0.14 * (n(Math.floor((th + Math.PI) * 4) + 0.5, 3.3) - 0.5)
    + 0.1 * (fbm(n, xm * 0.4, vm * 0.4, 3) - 0.5);
  const r = Math.hypot(x, z) / Math.min(W, L) / reach;
  const burn = 1 - smoothstep(0.55, 1.0, r + (fbm(n, xm * 2.5, vm * 2.5, 3) - 0.5) * 0.35);
  const core = 1 - smoothstep(0.1, 0.55, r);
  return {
    a: burn,
    h: -0.005 * core,
    mul: 1 - 0.35 * core,
    sat: 1 - 0.5 * burn,
    nW: 1 - 0.3 * core,
  };
}

/**
 * DEBRIS — earth a shell threw out: spokes of different lengths (a hash per
 * spoke, never a wave), and in them real CLODS — little heaps of fresh, darker
 * earth from a cellular field, each one catching the sun on one side.
 */
function debris({ xm, vm, W, L, n, seed }) {
  const x = xm - W / 2, z = vm - L / 2;
  const r = Math.hypot(x, z) / (Math.min(W, L) * 0.5);
  const th = Math.atan2(z, x);
  const rays = 22;
  const s = ((th / (Math.PI * 2)) + 1) * rays;
  const i = Math.floor(s), f = s - i;
  const len = 0.35 + 0.6 * Math.pow(n(i * 17.3 + 0.5, 11.5), 0.85);
  const wedge = 1 - smoothstep(0.2, 0.85, Math.abs(f - 0.5) * 2);
  const bias = 0.78 + 0.22 * Math.cos(th - 0.9);
  const ray = wedge * (1 - smoothstep(len * bias * 0.35, len * bias, r)) * smoothstep(0.06, 0.18, r);
  // Clods: cells 0.3 m; each may hold one, likelier inside a ray.
  const cell = 0.3;
  const gx = Math.floor(xm / cell), gz = Math.floor(vm / cell);
  let clod = 0;
  for (let oz = -1; oz <= 1; oz++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = gx + ox, cz = gz + oz;
      const hsh = (k) => n(cx * 3.17 + k * 91.7 + seed, cz * 5.31 + k * 13.1);
      const px = (cx + hsh(1)) * cell, pz = (cz + hsh(2)) * cell;
      const rad = 0.05 + 0.1 * hsh(3);
      const d = Math.hypot(xm - px, vm - pz);
      if (d < rad) {
        // Clods only where earth was thrown: in a spoke, or near the centre.
        // A base chance everywhere came out as sprinkles to the box's edge.
        const keep = hsh(4) < 0.85 * ray + 0.25 * (1 - smoothstep(0.15, 0.4, r));
        if (keep) clod = Math.max(clod, rad * Math.sqrt(1 - (d / rad) ** 2));
      }
    }
  }
  const lump = smoothstep(0, 0.03, clod);
  return {
    a: Math.max(ray * 0.75, lump * 0.95) * (0.7 + 0.3 * fbm(n, xm * 3, vm * 3, 3)),
    h: clod,
    mul: 0.86 - 0.08 * lump,
    sat: 1.15,
    nW: 0.8,
  };
}

/**
 * The catalogue. `size` is the decal box [width, length] in metres that the art
 * is baked FOR — placement must use the same, or the grain stretches. `tileM`
 * matches the terrain layers (5-8 m) so the grain agrees with the ground.
 */
export const PHOTO_RECIPES = {
  ruts:       { fn: ruts,       photo: "road",     size: [3.2, 10],  tileM: 5 },
  tankTracks: { fn: tankTracks, photo: "road",     size: [4.4, 10],  tileM: 5 },
  // Mud and puddles from the ROAD's own red soil: the grey-brown mud photo
  // turned every damp ring blue-grey against the laterite round it.
  mud:        { fn: mud,        photo: "road",     size: [8, 8],     tileM: 5 },
  puddle:     { fn: puddle,     photo: "road",     size: [6, 6],     tileM: 5 },
  footPath:   { fn: footPath,   photo: "laterite", size: [2.4, 10],  tileM: 6 },
  // Compacted LATERITE, not grey gravel: grey read as a foreign pale patch on
  // the red soil at play zoom. A Vietnam firebase pad was red earth and stones.
  apron:      { fn: apron,      photo: "laterite", size: [12, 12],   tileM: 5 },
  scorch:     { fn: scorch,     photo: "burned",   size: [10, 10],   tileM: 6 },
  debris:     { fn: debris,     photo: "stones",   size: [16, 16],   tileM: 6 },
};

/**
 * Bake one decal. Returns `{ albedo, normal }` as canvases at DECAL_LAYER_SIZE:
 * albedo is sRGB colour + alpha, normal is tangent-space in the decal shader's
 * convention (x along the box's width = image right, y along its length = image
 * DOWN, since image row 0 is the box's +z end; see decalSystem uvD).
 */
export async function bakePhotoDecal(kind, { seed = 1, size = DECAL_LAYER_SIZE } = {}) {
  const R = PHOTO_RECIPES[kind];
  if (!R) throw new Error(`no photo decal recipe "${kind}"`);
  const { diff, nor, lean } = await loadPhoto(R.photo);
  const [W, L] = R.size;
  const S = size;
  const n = makeValueNoise(seed * 7919 + 17);
  const rand = rng(seed);
  // Each variant takes its own patch of the photo, turned: two variants never
  // share grain, and nothing lines up with the photo's axes.
  const ang = rand() * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
  const offX = rand() * diff.w, offY = rand() * diff.h;
  const pxPerM = diff.w / R.tileM;

  const N = S * S;
  const A = new Float32Array(N), H = new Float32Array(N);
  const MUL = new Float32Array(N), SAT = new Float32Array(N), NW = new Float32Array(N);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S, v = (y + 0.5) / S;
      const o = R.fn({ u, v, xm: u * W, vm: v * L, W, L, n, seed });
      const k = y * S + x;
      A[k] = clamp01(o.a); H[k] = o.h; MUL[k] = o.mul; SAT[k] = o.sat; NW[k] = clamp01(o.nW);
    }
  }

  const dxm = W / S, dym = L / S;
  const albedo = document.createElement("canvas");
  const normal = document.createElement("canvas");
  albedo.width = albedo.height = normal.width = normal.height = S;
  const aImg = new ImageData(S, S), nImg = new ImageData(S, S);
  const c3 = [0, 0, 0], n3 = [0, 0, 0];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const k = y * S + x, i = k * 4;
      const xm = (x + 0.5) * dxm, vm = (y + 0.5) * dym;
      const px = (xm * ca - vm * sa) * pxPerM + offX;
      const py = (xm * sa + vm * ca) * pxPerM + offY;

      // Colour: the photo, darkened / lightened, saturation pushed about luma.
      sample3(diff, px, py, c3);
      const lum = 0.299 * c3[0] + 0.587 * c3[1] + 0.114 * c3[2];
      for (let c = 0; c < 3; c++) {
        const s = lum + (c3[c] - lum) * SAT[k];
        aImg.data[i + c] = clamp01(s * MUL[k]) * 255;
      }
      aImg.data[i + 3] = A[k] * 255;

      // Normal from the height's real slope (metres per metre)...
      const hx = H[y * S + Math.min(S - 1, x + 1)] - H[y * S + Math.max(0, x - 1)];
      const hy = H[Math.min(S - 1, y + 1) * S + x] - H[Math.max(0, y - 1) * S + x];
      let hnx = -hx / (2 * dxm), hny = -hy / (2 * dym);
      // ...plus the photo's own, turned back into the decal's frame. nor_gl
      // has green = image UP; this frame's y is image DOWN, hence the minus.
      sample3(nor, px, py, n3);
      const gz = Math.max(0.2, n3[2] * 2 - 1);
      const gx = (n3[0] * 2 - 1) / gz - lean[0], gy = -(n3[1] * 2 - 1) / gz - lean[1];
      // Photo frame -> decal frame is the transpose of the sampling turn.
      const pnx = (gx * ca + gy * sa) * NW[k];
      const pny = (-gx * sa + gy * ca) * NW[k];
      // Whiteout blend in slope space: slopes add.
      const sx = hnx + pnx, sy = hny + pny;
      const inv = 1 / Math.hypot(sx, sy, 1);
      nImg.data[i] = (sx * inv * 0.5 + 0.5) * 255;
      nImg.data[i + 1] = (sy * inv * 0.5 + 0.5) * 255;
      nImg.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      nImg.data[i + 3] = 255;
    }
  }
  albedo.getContext("2d").putImageData(aImg, 0, 0);
  normal.getContext("2d").putImageData(nImg, 0, 0);
  return { albedo, normal, size: [W, L] };
}
