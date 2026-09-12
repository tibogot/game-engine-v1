/**
 * Procedural paint layers — a slot's texture GENERATED on the GPU instead of
 * loaded from an image, then written into the same 1024² albedo + ORM array
 * layers an image would use.
 *
 * WHY BAKE INSTEAD OF RUNNING THE NOISE LIVE. Measured 2026-09-13 at 4.76 Mpx:
 * the live procedural ground cost +3.1 ms and the live meadow +2.8 ms, and the
 * meadow was paid on every terrain pixel as soon as anything was painted. A
 * texture tap is close to free by comparison. A baked layer is an ordinary
 * layer: painting, auto-paint, brush filters, triplanar and height blend all
 * work on it, and the frame cost is the same as an image layer's — the terrain
 * shader does not change at all.
 *
 * THE BAKE (three passes, one slot, only on edit):
 *   1. colour  → RGBA8, sRGB-encoded bytes, written verbatim (fragmentNode)
 *   2. height  → float RT, the pattern's relief in 0..1
 *   3. ORM     → RGBA8 from the height RT: roughness, AO, and a normal from
 *                wrap-around central differences
 * then both RGBA8 targets are read back and copied into the TextureLibrary.
 *
 * SEAMLESS BY CONSTRUCTION. Every noise lattice is periodic in the tile: cells
 * are wrapped modulo an integer period before hashing, every octave doubles the
 * period, and ripples use an integer frequency. The texture repeats across the
 * terrain, so a seam would show on every tile.
 *
 * NORMAL ENCODING matches the imported NormalGL images (see loadNormalMap):
 * ORM.b = −dh/dcolumn, ORM.a = +dh/drow in DATA order, i.e. "image up" is
 * row 0. Procedural and image layers therefore light the same way.
 *
 * COLOURS are interpolated in sRGB on purpose. This is a stylized palette tool:
 * the author picks the three shades they want to see, and a ramp between those
 * exact picks reads more predictably than one in linear light.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, uv, floor, fract, mix, smoothstep, clamp,
  sin, cos, dot, min, max, pow, length, uniform, texture, hash, uint, normalize,
} from "three/tsl";

export const PROC_RES = 1024;

export const PROC_PATTERNS = {
  painted: { label: "Painted ground", feature: "Mottles" },
  grass: { label: "Grass",  feature: "Clumps"  },
  dirt:  { label: "Dirt",   feature: "Pebbles" },
  rock:  { label: "Rock",   feature: "Cracks"  },
  sand:  { label: "Sand",   feature: "Ripples" },
};

/** Every field a procedural slot stores. Presets and saved data fill these. */
const BASE_PARAMS = {
  preset:  "stylizedGrass",
  pattern: "grass",
  dark:    "#3f7d3a",
  mid:     "#6fae45",
  light:   "#a9d15a",
  accent:  "#f2e27a",
  scale:   24,    // features per tile (integer — keeps the tile seamless)
  patches: 0.5,   // large soft colour patches
  feature: 0.6,   // the pattern's own shape: clumps / pebbles / cracks / ripples
  detail:  0.35,  // fine grain
  accentAmt: 0,   // speckles of the accent colour (flowers, shells, moss)
  rough:   0.9,
  bump:    0.5,
  ao:      0.5,
  seed:    1,
  uvScale: 20,    // suggested terrain UV tile for this preset
};

export const PROC_PRESETS = {
  genshinGrass:  { label: "Genshin grass",  pattern: "painted", dark: "#42b03f", mid: "#5ace4e", light: "#64df57", accent: "#cdd86a", scale: 8, patches: 0.5,  feature: 0.5,  detail: 0.04, accentAmt: 0,    rough: 0.95, bump: 0.05, ao: 0.1, uvScale: 12 },
  stylizedGrass: { label: "Stylized grass", pattern: "grass", dark: "#3f7d3a", mid: "#6fae45", light: "#a9d15a", accent: "#f2e27a", scale: 24, patches: 0.3,  feature: 0.6, detail: 0.3, accentAmt: 0,    rough: 0.92, bump: 0.3,  ao: 0.45, uvScale: 40 },
  flowerMeadow:  { label: "Flower meadow",  pattern: "grass", dark: "#467f33", mid: "#79b447", light: "#b7d766", accent: "#fff3a8", scale: 24, patches: 0.35, feature: 0.5, detail: 0.3, accentAmt: 0.35, rough: 0.92, bump: 0.4,  ao: 0.4,  uvScale: 40 },
  dirtPath:      { label: "Dirt path",      pattern: "dirt",  dark: "#6b4a2f", mid: "#9b7450", light: "#c9a57a", accent: "#7d8f4a", scale: 16, patches: 0.3,  feature: 0.5, detail: 0.4, accentAmt: 0.1,  rough: 0.95, bump: 0.6,  ao: 0.55, uvScale: 40 },
  paintedRock:   { label: "Painted rock",   pattern: "rock",  dark: "#4a4a52", mid: "#7d7f86", light: "#b3b5b8", accent: "#6f8f47", scale: 4,  patches: 0.35, feature: 0.45, detail: 0.3, accentAmt: 0,   rough: 0.8,  bump: 0.8,  ao: 0.6,  uvScale: 25 },
  mossyRock:     { label: "Mossy rock",     pattern: "rock",  dark: "#44484a", mid: "#767a78", light: "#a9ada6", accent: "#5f8a3c", scale: 4,  patches: 0.4,  feature: 0.45, detail: 0.3, accentAmt: 0.45, rough: 0.85, bump: 0.8,  ao: 0.6,  uvScale: 25 },
  beachSand:     { label: "Beach sand",     pattern: "sand",  dark: "#c9ad7f", mid: "#e2c99b", light: "#f3e3bf", accent: "#fffaf0", scale: 20, patches: 0.3,  feature: 0.5, detail: 0.35, accentAmt: 0.08, rough: 0.9,  bump: 0.35, ao: 0.3,  uvScale: 30 },
  softSnow:      { label: "Soft snow",      pattern: "sand",  dark: "#b9c8dc", mid: "#e3ecf5", light: "#ffffff", accent: "#ffffff", scale: 10, patches: 0.35, feature: 0.2, detail: 0.2, accentAmt: 0,    rough: 0.7,  bump: 0.25, ao: 0.2,  uvScale: 20 },
};

/** Complete, validated params for a preset id (unknown ids fall back to grass). */
export function procParamsFromPreset(presetId) {
  const p = PROC_PRESETS[presetId] ?? PROC_PRESETS.stylizedGrass;
  const { label: _label, ...fields } = p;
  return normalizeProcParams({ ...fields, preset: PROC_PRESETS[presetId] ? presetId : "stylizedGrass" });
}

/** Fill missing fields and clamp ranges — used for saved data and UI edits. */
export function normalizeProcParams(src) {
  const out = { ...BASE_PARAMS };
  if (!src || typeof src !== "object") return out;
  const hex = (v, d) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
  const num = (v, d, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  if (typeof src.preset === "string") out.preset = src.preset;
  if (PROC_PATTERNS[src.pattern]) out.pattern = src.pattern;
  out.dark   = hex(src.dark, out.dark);
  out.mid    = hex(src.mid, out.mid);
  out.light  = hex(src.light, out.light);
  out.accent = hex(src.accent, out.accent);
  out.scale     = Math.round(num(src.scale, out.scale, 2, 64));
  out.patches   = num(src.patches, out.patches, 0, 1);
  out.feature   = num(src.feature, out.feature, 0, 1);
  out.detail    = num(src.detail, out.detail, 0, 1);
  out.accentAmt = num(src.accentAmt, out.accentAmt, 0, 1);
  out.rough     = num(src.rough, out.rough, 0, 1);
  out.bump      = num(src.bump, out.bump, 0, 2);
  out.ao        = num(src.ao, out.ao, 0, 1);
  out.seed      = Math.round(num(src.seed, out.seed, 0, 9999));
  out.uvScale   = num(src.uvScale, out.uvScale, 1, 200);
  return out;
}

// ── Periodic noise primitives (all in tile space, period P = integer) ────────

const wrapCell = (c, P) => c.sub(P.mul(floor(c.div(P))));

/** [0,1) hash of an integer lattice cell, wrapped to the period, salted. */
function cellHash(c, P, salt) {
  const w = wrapCell(c, P);
  const idx = w.x.add(w.y.mul(4096.0)).toUint();
  return hash(idx.bitXor(salt.toUint().mul(uint(747796405))));
}

function valueNoise(p, P, salt) {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0));
  const a = cellHash(i, P, salt);
  const b = cellHash(i.add(vec2(1, 0)), P, salt);
  const c = cellHash(i.add(vec2(0, 1)), P, salt);
  const d = cellHash(i.add(vec2(1, 1)), P, salt);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Octaves double the period, so every octave tiles too. */
function fbm(p, P, salt, octaves) {
  let sum = float(0), amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const k = 2 ** o;
    sum = sum.add(valueNoise(p.mul(k), P.mul(k), salt.add(o * 7)).mul(amp));
    norm += amp;
    amp *= 0.5;
  }
  return sum.div(norm);
}

/**
 * Periodic gradient (Perlin-style) noise in [0,1]. Smoother and free of the
 * faint lattice look value noise has, which matters for soft cloudy mottling.
 */
function gradNoise(p, P, salt) {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(f).mul(f.mul(f.mul(6.0).sub(15.0)).add(10.0));
  const corner = (o) => {
    const a = cellHash(i.add(o), P, salt).mul(6.2831853);
    return dot(vec2(cos(a), sin(a)), f.sub(o));
  };
  const n = mix(
    mix(corner(vec2(0, 0)), corner(vec2(1, 0)), u.x),
    mix(corner(vec2(0, 1)), corner(vec2(1, 1)), u.x),
    u.y,
  );
  return n.mul(0.75).add(0.5); // ±~0.7 → about [0,1]
}

function gradFbm(p, P, salt, octaves) {
  let sum = float(0), amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const k = 2 ** o;
    sum = sum.add(gradNoise(p.mul(k), P.mul(k), salt.add(o * 7)).mul(amp));
    norm += amp;
    amp *= 0.5;
  }
  return sum.div(norm);
}

/** Periodic Worley: vec4(F1, F2, id of the nearest cell, 0). 9 cells, unrolled. */
const voronoi = Fn(([p, P, salt]) => {
  const base = floor(p);
  const f1 = float(8).toVar();
  const f2 = float(8).toVar();
  const id = float(0).toVar();
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cell = base.add(vec2(dx, dy));
      const hx = cellHash(cell, P, salt);
      const hy = cellHash(cell, P, salt.add(1));
      const pt = cell.add(vec2(hx, hy).mul(0.8).add(0.1));
      const d = length(pt.sub(p)).toVar();
      const closer = d.lessThan(f1);
      f2.assign(closer.select(f1, min(f2, d)));
      id.assign(closer.select(cellHash(cell, P, salt.add(2)), id));
      f1.assign(closer.select(d, f1));
    }
  }
  return vec4(f1, f2, id, 0);
});

const sat = (x) => clamp(x, 0.0, 1.0);
const ramp3 = (t, c0, c1, c2) => mix(mix(c0, c1, sat(t.mul(2))), c2, sat(t.mul(2).sub(1)));

// ── Patterns ────────────────────────────────────────────────────────────────
// Each returns { col, h } nodes for tile coordinate `q` in [0,1). The colour
// and height materials call the same function and only read the half they
// need; TSL generates only what the output references.

function pattern(name, U, q) {
  const P    = U.scale;
  const bigP = U.bigScale;
  const seed = U.seed.mul(64);
  // Domain-warped patches: plain value noise on a coarse lattice lines its
  // blobs up on a visible grid. The warp is itself periodic, so the tile still
  // wraps: f(q + w(q)) repeats whenever f and w both do.
  const warp = vec2(
    fbm(q.mul(bigP), bigP, seed.add(50), 2),
    fbm(q.mul(bigP), bigP, seed.add(60), 2),
  ).sub(0.5).mul(float(0.9).div(bigP));
  const big  = fbm(q.add(warp).mul(bigP), bigP, seed.add(1), 3);
  const fine = fbm(q.mul(P.mul(4)), P.mul(4), seed.add(40), 2);
  const patchT = big.sub(0.5).mul(U.patches.mul(1.6));
  const fineT  = fine.sub(0.5).mul(U.detail.mul(0.5));

  if (name === "painted") {
    // Hand-painted ground, the Genshin open-field look, matched to a close-up
    // of the real thing (2026-09-13). What that reference actually contains:
    //   - isotropic cloud noise ("Photoshop Clouds"): several octaves from big
    //     soft blobs down to small smudges, NO direction, no lines, no cells
    //   - lopsided: an even mid green, with the structure mostly DARKER mottles;
    //     the light side stays flat
    //   - very low contrast, very soft edges, next to no relief
    // A first version with stretched "brush streaks" looked nothing like it.
    //
    // Gradient noise, not value noise: value noise keeps a faint lattice feel
    // that the reference does not have.
    const mq = q.add(warp.mul(0.5));
    const n = gradFbm(mq.mul(P), P, seed.add(70), 5);
    // Summed gradient octaves huddle around 0.5, so spread them before
    // shading. MEASURED without this: the green channel's p5 was 176 against
    // a median of 185, i.e. nothing varied but a rare dark tail, where the
    // reference varies continuously everywhere.
    const nn = sat(n.sub(0.5).mul(2.4).add(0.5));
    // Continuous cloudy variation everywhere, plus a soft extra darkening of
    // the low side so the mottles lean dark like the reference.
    const mottle = float(1).sub(smoothstep(0.05, 0.6, nn));
    const t = sat(float(0.55)
      .add(nn.sub(0.5).mul(U.patches.mul(0.6)))
      .sub(mottle.mul(U.feature.mul(0.35)))
      .add(fineT));
    let col = ramp3(t, U.dark, U.mid, U.light);
    // Dry patches: a second warped wash, thresholded softly, pulled toward the
    // accent (a sun-bleached yellow-green).
    const wash = fbm(q.sub(warp).mul(bigP), bigP, seed.add(80), 3);
    const dry = smoothstep(float(0.95).sub(U.accentAmt.mul(0.4)), float(1.1).sub(U.accentAmt.mul(0.4)), wash)
      .mul(U.accentAmt.greaterThan(0.001).select(1.0, 0.0));
    col = mix(col, U.accent, dry.mul(0.75));
    const h = sat(n.mul(0.8).add(fine.mul(0.2)));
    return { col, h };
  }

  if (name === "grass") {
    // Painted clumps: each Worley cell is one clump with its own shade and a
    // soft dome that is lightest at its centre. Shading from the cell CENTRE
    // (F1), not from the border distance (F2−F1), matters: border shading
    // draws a dark outline around every cell and the grass reads as scales.
    const v = voronoi(q.mul(P), P, seed.add(10));
    const edge = float(1).sub(smoothstep(0.0, 0.75, v.x));
    const clumpT = v.z.sub(0.5).mul(0.3).add(edge.sub(0.5).mul(0.18)).mul(U.feature);
    const t = sat(float(0.5).add(patchT).add(clumpT).add(fineT));
    let col = ramp3(t, U.dark, U.mid, U.light);
    // Flower speckles: small dots in a sparse subset of a finer lattice.
    const s = voronoi(q.mul(P.mul(3)), P.mul(3), seed.add(20));
    const dot = float(1).sub(smoothstep(0.08, 0.16, s.x))
      .mul(smoothstep(float(1).sub(U.accentAmt.mul(0.6)), float(1).sub(U.accentAmt.mul(0.6)).add(0.02), s.z));
    col = mix(col, U.accent, dot);
    const h = sat(edge.mul(0.45).mul(U.feature).add(big.mul(0.3)).add(fine.mul(0.25)).add(dot.mul(0.2)));
    return { col, h };
  }

  if (name === "dirt") {
    // Soil tone with scattered pebbles: a light stone, a dark rim around it.
    const v = voronoi(q.mul(P), P, seed.add(10));
    // Only some cells hold a stone (more with Pebbles), each its own size.
    const has = smoothstep(float(1).sub(U.feature.mul(0.9)), float(1.05).sub(U.feature.mul(0.9)), v.z.mul(0.93).add(0.07));
    const r = float(0.2).add(v.z.mul(0.25)).mul(has);
    const pebble = float(1).sub(smoothstep(r.sub(0.05), r, v.x)).mul(has);
    const rim = float(1).sub(smoothstep(r, r.add(0.07), v.x)).sub(pebble);
    const t = sat(float(0.45).add(patchT).add(fineT));
    let col = ramp3(t, U.dark, U.mid, U.light);
    col = mix(col, U.dark, sat(rim).mul(0.55));
    col = mix(col, mix(U.mid, U.light, v.z), pebble);
    // Sparse grass tufts where the big noise peaks.
    const tuft = smoothstep(float(1).sub(U.accentAmt.mul(0.45)), float(1.02).sub(U.accentAmt.mul(0.45)).add(0.08), big)
      .mul(U.accentAmt.greaterThan(0.001).select(1.0, 0.0));
    col = mix(col, U.accent, tuft.mul(0.85));
    const dome = sqrt01(float(1).sub(sat(v.x.div(max(r, 0.001)))));
    const h = sat(pebble.mul(dome).mul(0.7).add(big.mul(0.2)).add(fine.mul(0.1)));
    return { col, h };
  }

  if (name === "rock") {
    // Faceted stylized rock: flat-shaded Worley plates, dark painted cracks.
    // Big plates, each split again by thinner secondary cracks, so it reads as
    // fractured stone rather than laid paving.
    const qw = q.add(warp.mul(0.6));
    const v = voronoi(qw.mul(P), P, seed.add(10));
    const w = U.feature.mul(0.14).add(0.015);
    const gap = v.y.sub(v.x);
    const v2 = voronoi(qw.mul(P.mul(3)), P.mul(3), seed.add(30));
    const crack2 = float(1).sub(smoothstep(w.mul(0.15), w.mul(0.45), v2.y.sub(v2.x))).mul(0.55);
    const crack = max(float(1).sub(smoothstep(w.mul(0.4), w, gap)), crack2);
    const facetT = v.z.sub(0.5).mul(0.35).add(v2.z.sub(0.5).mul(0.15));
    const t = sat(float(0.52).add(facetT).add(patchT.mul(0.7)).add(fineT));
    let col = ramp3(t, U.dark, U.mid, U.light);
    col = mix(col, U.dark.mul(0.8), crack);
    // Moss collects on the big noise's high ground, never inside a crack.
    const moss = smoothstep(float(0.62).sub(U.accentAmt.mul(0.35)), float(0.8).sub(U.accentAmt.mul(0.35)), big)
      .mul(U.accentAmt.greaterThan(0.001).select(1.0, 0.0)).mul(float(1).sub(crack));
    col = mix(col, U.accent, moss.mul(0.9));
    const plate = smoothstep(0.0, w.mul(2.5), gap);
    const h = sat(plate.mul(float(0.55).add(v.z.mul(0.35))).sub(crack2.mul(0.25)).add(fine.mul(0.1)));
    return { col, h };
  }

  // sand: wind ripples along the tile's X, warped by the big noise. An integer
  // ripple count and a periodic warp keep it seamless.
  const rippleWarp = big.sub(0.5).mul(1.5);
  const phase = q.x.mul(P).add(rippleWarp);
  const ripple = sin(phase.mul(6.2831853)).mul(0.5).add(0.5);
  const sharp = pow(ripple, 1.6);
  const t = sat(float(0.5).add(sharp.sub(0.5).mul(U.feature.mul(0.35))).add(patchT).add(fineT));
  let col = ramp3(t, U.dark, U.mid, U.light);
  const s = voronoi(q.mul(P.mul(2)), P.mul(2), seed.add(20));
  const dot = float(1).sub(smoothstep(0.05, 0.1, s.x))
    .mul(smoothstep(float(1).sub(U.accentAmt.mul(0.5)), float(1.02).sub(U.accentAmt.mul(0.5)), s.z))
    .mul(U.accentAmt.greaterThan(0.001).select(1.0, 0.0));
  col = mix(col, U.accent, dot);
  const h = sat(sharp.mul(U.feature).mul(0.8).add(fine.mul(0.2)).add(dot.mul(0.3)));
  return { col, h };
}

const sqrt01 = (x) => pow(max(x, 0.0), 0.5);

// ── Baker ───────────────────────────────────────────────────────────────────

function hexToVec3(hex) {
  const n = parseInt(hex.slice(1), 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export class ProceduralLayerBaker {
  /** @param {THREE.WebGPURenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    const N = PROC_RES;
    this.U = {
      dark: uniform(new THREE.Vector3()), mid: uniform(new THREE.Vector3()),
      light: uniform(new THREE.Vector3()), accent: uniform(new THREE.Vector3()),
      scale: uniform(24), bigScale: uniform(4), seed: uniform(1),
      patches: uniform(0.5), feature: uniform(0.5), detail: uniform(0.3),
      accentAmt: uniform(0), rough: uniform(0.9), bump: uniform(0.5), ao: uniform(0.5),
    };

    const rgba8 = () => {
      const rt = new THREE.RenderTarget(N, N, { type: THREE.UnsignedByteType, depthBuffer: false });
      rt.texture.generateMipmaps = false;
      return rt;
    };
    this._rtColor = rgba8();
    this._rtOrm   = rgba8();
    this._rtHeight = new THREE.RenderTarget(N, N, { type: THREE.FloatType, depthBuffer: false });
    const ht = this._rtHeight.texture;
    ht.generateMipmaps = false;
    ht.minFilter = ht.magFilter = THREE.NearestFilter;
    ht.wrapS = ht.wrapT = THREE.RepeatWrapping;

    this._patternMats = new Map(); // pattern → { color: QuadMesh, height: QuadMesh }
    this._ormQuad = new QuadMesh(this._makeOrmMaterial());
  }

  _baseMaterial() {
    const m = new THREE.MeshBasicNodeMaterial();
    m.toneMapped = m.fog = false;
    m.depthTest = m.depthWrite = false;
    return m;
  }

  _quadsFor(name) {
    let q = this._patternMats.get(name);
    if (q) return q;
    const U = this.U;
    const cMat = this._baseMaterial();
    cMat.fragmentNode = Fn(() => vec4(pattern(name, U, uv()).col, 1))();
    const hMat = this._baseMaterial();
    hMat.fragmentNode = Fn(() => vec4(pattern(name, U, uv()).h, 0, 0, 1))();
    q = { color: new QuadMesh(cMat), height: new QuadMesh(hMat) };
    this._patternMats.set(name, q);
    return q;
  }

  _makeOrmMaterial() {
    const U = this.U;
    const m = this._baseMaterial();
    const ht = this._rtHeight.texture;
    const d = 1 / PROC_RES;
    m.fragmentNode = Fn(() => {
      const c = uv();
      // Repeat wrapping on the height target makes the differences seamless.
      const hC = texture(ht, c).r;
      const hL = texture(ht, c.sub(vec2(d, 0))).r;
      const hR = texture(ht, c.add(vec2(d, 0))).r;
      const hD = texture(ht, c.sub(vec2(0, d))).r;
      const hU = texture(ht, c.add(vec2(0, d))).r;
      // Slope in height-units per texel, scaled so bump 1 is a firm relief.
      const k = U.bump.mul(24.0);
      const nx = hL.sub(hR).mul(k);  // −dh/dcolumn
      // +dh/drow. VERIFIED: readback row j is uv.y = (j+0.5)/N, so +v IS +row.
      const ny = hU.sub(hD).mul(k);
      const n = normalize(vec3(nx, ny, 1.0));
      const ao = mix(float(1), smoothstep(0.0, 0.55, hC).mul(0.55).add(0.45), U.ao);
      return vec4(U.rough, ao, n.x.mul(0.5).add(0.5), n.y.mul(0.5).add(0.5));
    })();
    return m;
  }

  _setUniforms(p) {
    const U = this.U;
    U.dark.value.copy(hexToVec3(p.dark));
    U.mid.value.copy(hexToVec3(p.mid));
    U.light.value.copy(hexToVec3(p.light));
    U.accent.value.copy(hexToVec3(p.accent));
    U.scale.value = p.scale;
    U.bigScale.value = Math.max(1, Math.round(p.scale / 6));
    U.seed.value = p.seed;
    U.patches.value = p.patches;
    U.feature.value = p.feature;
    U.detail.value = p.detail;
    U.accentAmt.value = p.accentAmt;
    U.rough.value = p.rough;
    U.bump.value = p.bump;
    U.ao.value = p.ao;
  }

  /**
   * Bake one layer. Resolves to { albedo, orm } — PROC_RES² RGBA8 arrays in
   * the TextureLibrary's data layout.
   *
   * Renderer state is set and restored synchronously around the renders and
   * never held across the awaits (see proj_async_bake_renderer_state).
   */
  async bake(params) {
    const p = normalizeProcParams(params);
    const R = this.renderer;
    const quads = this._quadsFor(p.pattern);
    this._setUniforms(p);

    const prevRT = R.getRenderTarget();
    const prevAutoClear = R.autoClear;
    R.autoClear = false;
    R.setRenderTarget(this._rtColor);  quads.color.render(R);
    R.setRenderTarget(this._rtHeight); quads.height.render(R);
    R.setRenderTarget(this._rtOrm);    this._ormQuad.render(R);
    R.setRenderTarget(prevRT);
    R.autoClear = prevAutoClear;

    const N = PROC_RES;
    const [col, orm] = await Promise.all([
      R.readRenderTargetPixelsAsync(this._rtColor, 0, 0, N, N),
      R.readRenderTargetPixelsAsync(this._rtOrm, 0, 0, N, N),
    ]);
    return {
      albedo: new Uint8Array(col.buffer, col.byteOffset, N * N * 4),
      orm:    new Uint8Array(orm.buffer, orm.byteOffset, N * N * 4),
    };
  }

  dispose() {
    this._rtColor.dispose(); this._rtOrm.dispose(); this._rtHeight.dispose();
    for (const q of this._patternMats.values()) { q.color.material.dispose(); q.height.material.dispose(); }
    this._ormQuad.material.dispose();
  }
}

/** Small data-URL preview of a baked albedo, for layer cards and the editor. */
export function albedoThumbnailUrl(albedo, size = 96) {
  const N = PROC_RES;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(size, size);
  const step = N / size;
  for (let y = 0; y < size; y++) {
    const sy = Math.floor((y + 0.5) * step);
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x + 0.5) * step);
      const si = (sy * N + sx) * 4, di = (y * size + x) * 4;
      img.data[di] = albedo[si]; img.data[di + 1] = albedo[si + 1]; img.data[di + 2] = albedo[si + 2]; img.data[di + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}
