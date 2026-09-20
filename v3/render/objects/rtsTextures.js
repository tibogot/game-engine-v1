/**
 * RTS OBJECT TEXTURES — canvas-baked surfaces for the parts kit.
 *
 * THE LESSON THIS FILE EXISTS FOR. The first pass at these objects shipped
 * geometry with a flat colour on it and looked like untextured greybox, because
 * on a procedural asset the surface is most of the read — a sandbag is hessian
 * weave and filth far more than it is a rounded box. The plants in this engine
 * work for exactly this reason: palmFrondTexture, bambooSprayTexture and
 * broadleafTextures do the heavy lifting, not the geometry.
 *
 * All tileable, all generated at load (no files to ship, no CDN, nothing to
 * keep in sync with the .v3proj).
 *
 * UV CONVENTION: v runs UP the object and 0 is the ground. Rust bleeds and
 * streaks run down v, dirt gathers at v=0. Get this backwards and corrugated
 * iron rusts at the ridge instead of the gutter, which reads instantly wrong.
 */
import * as THREE from "three";

// ── noise ────────────────────────────────────────────────────────────────────
// Math.imul, not `*`: a plain 32-bit multiply overflows to double, drops the low
// bits the xor-shift mixes, and the hash comes back one-sided — noise that never
// crosses 0.5 makes every (n - 0.5) term the same sign and the pattern vanishes.
function hash2(x, y) {
  let n = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

/** Value noise on a WRAPPING lattice, so every texture below tiles. */
function vnoise(x, y, period) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (i, p) => ((i % p) + p) % p;
  const a = hash2(w(xi, period), w(yi, period));
  const b = hash2(w(xi + 1, period), w(yi, period));
  const c = hash2(w(xi, period), w(yi + 1, period));
  const d = hash2(w(xi + 1, period), w(yi + 1, period));
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, period, octaves = 4) {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise(x * f, y * f, period * f) * amp;
    amp *= 0.5; f *= 2;
  }
  return sum;
}

function makeTexture(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── corrugated iron ──────────────────────────────────────────────────────────

/**
 * Rusted sheet metal. The corrugation itself is GEOMETRY (buildCorrugatedPanel
 * extrudes a real sine profile), so this supplies only what geometry cannot:
 * where the rust has taken hold, where it has bled downward, and the rows of
 * fixings. Painting corrugation shading in here as well would double it up and
 * fight the real lighting.
 */
export function makeCorrugatedIronTexture({ size = 512, rust = 0.55, seed = 3 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;                                   // noise period = tiles cleanly
    for (let y = 0; y < S; y++) {
      // v = 0 at the BOTTOM of the sheet, which is where water sits.
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        const nx = u * P, ny = v * P;

        // Base steel: a cool grey-green, faintly mottled.
        const mott = fbm(nx * 2.1 + seed, ny * 2.1, P * 2, 3);
        let r = lerp(96, 122, mott), gg = lerp(102, 126, mott), b = lerp(94, 112, mott);

        // Rust takes hold in blotches, heavily biased to the lower third.
        const blotch = fbm(nx * 1.3 + seed * 3, ny * 1.3, P, 4);
        const lowBias = clamp01(1.25 - v * 1.7);
        let corrosion = clamp01((blotch - (1 - rust) * 0.72) * 3.0) * clamp01(0.35 + lowBias);

        // Bleed: rust runs DOWN from wherever it started. Sampling the same
        // field a little higher up and carrying it down is what makes a streak.
        const above = fbm(nx * 1.3 + seed * 3, (ny + 0.55) * 1.3, P, 4);
        const streak = clamp01((above - (1 - rust) * 0.78) * 2.6)
                     * clamp01(0.85 - v * 0.35)
                     * (0.45 + 0.55 * fbm(nx * 9, ny * 1.4, P * 4, 2));
        corrosion = clamp01(corrosion + streak * 0.7);

        // Two rust tones: fresh orange over old dark brown.
        const tone = fbm(nx * 4.4 + 9, ny * 4.4, P * 2, 2);
        const rr = lerp(96, 168, tone), rg = lerp(52, 92, tone), rb = lerp(30, 44, tone);
        r = lerp(r, rr, corrosion); gg = lerp(gg, rg, corrosion); b = lerp(b, rb, corrosion);

        // Dirt splash at the very bottom.
        const splash = clamp01(1 - v * 6) * (0.4 + 0.6 * fbm(nx * 7, ny * 7, P * 4, 2));
        r = lerp(r, 62, splash * 0.5); gg = lerp(gg, 58, splash * 0.5); b = lerp(b, 48, splash * 0.5);

        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    // Fixings: rows of bolt heads across the sheet, rusty haloes below them.
    const rows = 4, cols = 9;
    for (let ry = 0; ry < rows; ry++) {
      for (let cx = 0; cx < cols; cx++) {
        const px = ((cx + 0.5) / cols) * S;
        const py = ((ry + 0.5) / rows) * S;
        const grd = g.createRadialGradient(px, py + 3, 0, px, py + 3, 9);
        grd.addColorStop(0, "rgba(120,62,34,0.55)");
        grd.addColorStop(1, "rgba(120,62,34,0)");
        g.fillStyle = grd;
        g.fillRect(px - 10, py - 4, 20, 20);
        g.fillStyle = "rgba(48,44,40,0.85)";
        g.beginPath(); g.arc(px, py, 2.1, 0, 7); g.fill();
        g.fillStyle = "rgba(190,190,185,0.30)";
        g.beginPath(); g.arc(px - 0.6, py - 0.7, 1.0, 0, 7); g.fill();
      }
    }
  });
}

// ── weathered timber ─────────────────────────────────────────────────────────

/** Grain along v (posts stand up), with knots and a grey sun-bleached cast. */
export function makeTimberTexture({ size = 512, seed = 11 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;
    for (let y = 0; y < S; y++) {
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        // Grain: stretched hard along v so it reads as sawn timber, not marble.
        const grain = fbm(u * P * 3.2 + seed, v * P * 0.30, P * 4, 4);
        const fine = vnoise(u * P * 26, v * P * 1.4, P * 26);
        const t = clamp01(grain * 0.78 + fine * 0.22);
        let r = lerp(84, 138, t), gg = lerp(64, 108, t), b = lerp(44, 76, t);
        // Sun bleaches the exposed face grey.
        const bleach = clamp01(fbm(u * P + 4, v * P + 4, P, 3) * 1.4 - 0.35);
        r = lerp(r, 132, bleach * 0.35); gg = lerp(gg, 126, bleach * 0.35); b = lerp(b, 112, bleach * 0.35);
        // Damp and dirt at the foot of the post.
        const foot = clamp01(1 - v * 5);
        r = lerp(r, 46, foot * 0.55); gg = lerp(gg, 38, foot * 0.55); b = lerp(b, 28, foot * 0.55);
        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    // A few knots.
    let s = seed;
    const rnd = () => { s = Math.imul(s ^ (s >>> 15), 2246822519); s = (s ^ (s >>> 13)) >>> 0; return s / 4294967296; };
    for (let i = 0; i < 7; i++) {
      const px = rnd() * S, py = rnd() * S, rad = 4 + rnd() * 7;
      const grd = g.createRadialGradient(px, py, 0, px, py, rad);
      grd.addColorStop(0, "rgba(38,26,16,0.85)");
      grd.addColorStop(0.55, "rgba(62,44,26,0.45)");
      grd.addColorStop(1, "rgba(62,44,26,0)");
      g.fillStyle = grd;
      g.beginPath(); g.ellipse(px, py, rad, rad * 1.7, 0, 0, 7); g.fill();
    }
  });
}

// ── hessian ──────────────────────────────────────────────────────────────────

/** Coarse woven sacking, sun-faded on top and filthy at the bottom. */
export function makeHessianTexture({ size = 512, seed = 5 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;
    const threads = 46;                            // integer => the weave tiles
    for (let y = 0; y < S; y++) {
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        // Plain weave: two square waves a quarter-phase apart.
        const wu = Math.sin(u * Math.PI * 2 * threads);
        const wv = Math.sin(v * Math.PI * 2 * threads);
        const weave = 0.5 + 0.5 * Math.sign(wu * wv) * 0.55;
        const slub = fbm(u * P * 5 + seed, v * P * 5, P * 4, 3);   // uneven yarn
        const t = clamp01(weave * 0.62 + slub * 0.38);
        let r = lerp(118, 168, t), gg = lerp(104, 150, t), b = lerp(76, 114, t);
        // Grime, heaviest low down where the bag meets the ground.
        const grime = clamp01(fbm(u * P * 1.6 + 21, v * P * 1.6, P, 4) * 1.5 - 0.35)
                    * clamp01(1.15 - v * 0.85);
        r = lerp(r, 62, grime * 0.68); gg = lerp(gg, 56, grime * 0.68); b = lerp(b, 42, grime * 0.68);
        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

// ── thatch ───────────────────────────────────────────────────────────────────

/**
 * Palm / nipa thatch — the roof of a Vietnamese village house, and the most
 * recognisable surface in the whole set.
 *
 * Strands run DOWN the slope, so they run along v. Bundles lap every few
 * courses and the lap line is darker, which is what stops thatch reading as a
 * brown carpet. The ragged lower EDGE is geometry, not texture — see
 * buildThatchRoof.
 */
export function makeThatchTexture({ size = 512, seed = 17 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;
    const strands = 120;                        // integer => tiles
    for (let y = 0; y < S; y++) {
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        // Each stalk is a narrow band with its own tone and a slight wander, so
        // the roof is made of stalks rather than stripes.
        const wander = (vnoise(u * P * 2, v * P * 0.7, P * 2) - 0.5) * 0.02;
        const su = u + wander;
        const idx = Math.floor(su * strands);
        const within = su * strands - idx;
        const strandTone = hash2(idx, seed);
        const edge = Math.min(within, 1 - within);
        const crease = clamp01(edge * 5.5);      // dark between stalks
        let r = lerp(126, 186, strandTone), gg = lerp(98, 152, strandTone), b = lerp(56, 96, strandTone);
        const age = fbm(u * P * 1.2 + seed, v * P * 1.2, P, 3);
        r = lerp(r, 104, age * 0.45); gg = lerp(gg, 92, age * 0.45); b = lerp(b, 70, age * 0.45);
        const fibre = vnoise(su * strands, v * P * 34, P * 34);
        const f = (0.58 + 0.42 * crease) * (0.88 + 0.12 * fibre);
        r *= f; gg *= f; b *= f;
        // Courses: every few rows a bundle laps the one below and casts a line.
        const course = Math.abs(Math.sin(v * Math.PI * 7));
        const lap = clamp01(1 - course * 4.5) * 0.45;
        r = lerp(r, 58, lap); gg = lerp(gg, 48, lap); b = lerp(b, 34, lap);
        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

// ── bamboo pole ──────────────────────────────────────────────────────────────

/** A culm: pale green-gold, vertical fibre, damp low down. Nodes are geometry. */
export function makeBambooPoleTexture({ size = 512, seed = 23 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;
    for (let y = 0; y < S; y++) {
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        const fibre = vnoise(u * P * 40, v * P * 1.1, P * 40);
        const patch = fbm(u * P * 1.4 + seed, v * P * 1.4, P, 3);
        let r = lerp(150, 196, patch), gg = lerp(152, 190, patch), b = lerp(96, 126, patch);
        // Cut bamboo dries from green to straw.
        const dry = clamp01(fbm(u * P * 0.9 + 3, v * P * 0.9, P, 2) * 1.5 - 0.4);
        r = lerp(r, 178, dry * 0.5); gg = lerp(gg, 158, dry * 0.5); b = lerp(b, 96, dry * 0.5);
        const f = 0.9 + 0.1 * fibre;
        r *= f; gg *= f; b *= f;
        const foot = clamp01(1 - v * 4.5);       // mould at the foot
        r = lerp(r, 92, foot * 0.45); gg = lerp(gg, 96, foot * 0.45); b = lerp(b, 62, foot * 0.45);
        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

// ── woven bamboo matting ─────────────────────────────────────────────────────

/**
 * Plaited bamboo wall panel. Wide flat splits crossing over and under — the
 * over/under IS the character, so the shadow on the under-strip is drawn
 * explicitly rather than left to noise.
 */
export function makeWovenBambooTexture({ size = 512, seed = 31 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;
    const strips = 11;                          // integer => tiles
    for (let y = 0; y < S; y++) {
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        const iu = Math.floor(u * strips), iv = Math.floor(v * strips);
        const fu = u * strips - iu, fv = v * strips - iv;
        const over = ((iu + iv) & 1) === 0;      // plain weave, like a chequerboard
        const tone = hash2(over ? iu : iv, seed + (over ? 0 : 7));
        let r = lerp(150, 198, tone), gg = lerp(126, 172, tone), b = lerp(84, 120, tone);
        const acrossU = Math.min(fu, 1 - fu), acrossV = Math.min(fv, 1 - fv);
        const under = over ? clamp01(1 - acrossV * 3.4) : clamp01(1 - acrossU * 3.4);
        const f = 1 - under * 0.42;
        r *= f; gg *= f; b *= f;
        const gap = clamp01(Math.min(acrossU, acrossV) * 9);
        const gf = 0.55 + 0.45 * gap;            // splits between strips
        r *= gf; gg *= gf; b *= gf;
        const dirt = clamp01(fbm(u * P * 1.5 + 11, v * P * 1.5, P, 3) * 1.4 - 0.45) * clamp01(1.1 - v * 0.7);
        r = lerp(r, 84, dirt * 0.5); gg = lerp(gg, 74, dirt * 0.5); b = lerp(b, 54, dirt * 0.5);
        const i = (y * S + x) * 4;
        d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** Trodden earth, for platforms and floors. */
export function makeEarthTexture({ size = 512, seed = 41 } = {}) {
  return makeTexture(size, (g, S) => {
    const img = g.createImageData(S, S);
    const d = img.data;
    const P = 8;
    for (let y = 0; y < S; y++) {
      const v = 1 - y / (S - 1);
      for (let x = 0; x < S; x++) {
        const u = x / (S - 1);
        const t = fbm(u * P * 2.2 + seed, v * P * 2.2, P * 2, 4);
        const grit = vnoise(u * P * 30, v * P * 30, P * 30);
        const f = 0.9 + 0.1 * grit;
        const i = (y * S + x) * 4;
        d[i] = lerp(86, 132, t) * f;
        d[i + 1] = lerp(68, 106, t) * f;
        d[i + 2] = lerp(48, 76, t) * f;
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

// ── atlas ────────────────────────────────────────────────────────────────────

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 2;
/** Fraction of a cell kept clear at its border, so mips cannot bleed across. */
export const ATLAS_PAD = 0.004;

/**
 * Every surface in ONE texture, 4x2 cells, indexed by MAT.
 *
 * WHY. The shader picks a surface per vertex from `matId`. With seven separate
 * textures and a select() chain the GPU evaluates EVERY arm — select is not a
 * branch — so a pixel costs seven texture fetches to use one. An atlas is a
 * single fetch whatever the surface is.
 *
 * The price is that RepeatWrapping cannot tile within a cell, so the shader
 * fracts the UV itself, and mips want to bleed between neighbouring cells at
 * the seam. ATLAS_PAD is the inset that stops it.
 */
export function makeSurfaceAtlas({ cell = 512 } = {}) {
  const c = document.createElement("canvas");
  c.width = ATLAS_COLS * cell;
  c.height = ATLAS_ROWS * cell;
  const g = c.getContext("2d");
  // Order MUST match MAT in rtsParts.js.
  const sources = [
    makeHessianTexture({ size: cell }),
    makeCorrugatedIronTexture({ size: cell }),
    makeTimberTexture({ size: cell }),
    makeEarthTexture({ size: cell }),
    makeThatchTexture({ size: cell }),
    makeBambooPoleTexture({ size: cell }),
    makeWovenBambooTexture({ size: cell }),
  ];
  sources.forEach((t, i) => {
    const col = i % ATLAS_COLS, row = (i / ATLAS_COLS) | 0;
    g.drawImage(t.image, col * cell, row * cell);
    t.dispose();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;   // the shader does the tiling
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

let atlasCache = null;
export function rtsAtlas() {
  if (!atlasCache) atlasCache = makeSurfaceAtlas({});
  return atlasCache;
}

/** Built once, shared by every object in the lab and the engine. */
let cache = null;
export function rtsTextures() {
  if (!cache) {
    cache = {
      hessian: makeHessianTexture({}),
      metal: makeCorrugatedIronTexture({}),
      timber: makeTimberTexture({}),
    };
  }
  return cache;
}
