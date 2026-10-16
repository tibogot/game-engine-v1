/**
 * TSL noise library: Value, Perlin, Simplex, Voronoi, White.
 * Use for procedural textures (e.g. tsl-texture-editor).
 */
import {
  Fn,
  vec2,
  float,
  floor,
  fract,
  sin,
  cos,
  dot,
  mix,
  min,
  length,
  sub,
  add,
  mul,
  clamp,
} from "three/tsl";

// ─── Hashes ──────────────────────────────────────────────────────────────────
const hash21 = Fn(([p]) =>
  fract(sin(dot(vec2(p), vec2(12.9898, 78.233))).mul(43758.5453)),
);
const hash22 = Fn(([p]) => {
  const px = dot(p, vec2(127.1, 311.7));
  const py = dot(p, vec2(269.5, 183.3));
  return fract(sin(vec2(px, py)).mul(43758.5453));
});

// ─── Value noise (smooth interpolated hash) ───────────────────────────────────
export const valueNoise2D = Fn(([p_in]) => {
  const p = vec2(p_in);
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(sub(3.0, f.mul(2.0)));
  return mix(
    mix(hash21(i), hash21(add(i, vec2(1, 0))), u.x),
    mix(hash21(add(i, vec2(0, 1))), hash21(add(i, vec2(1, 1))), u.x),
    u.y,
  );
});

// ─── Perlin (gradient noise) ─────────────────────────────────────────────────
export const perlinNoise2D = Fn(([p_in]) => {
  const p = vec2(p_in);
  const i = floor(p);
  const f = fract(p);
  const quintic = (t) => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
  const u = quintic(f);
  const grad = Fn(([ip]) => {
    const a = hash21(ip).mul(Math.PI * 2);
    return vec2(cos(a), sin(a));
  });
  const d00 = dot(grad(i), f);
  const d10 = dot(grad(add(i, vec2(1, 0))), sub(f, vec2(1, 0)));
  const d01 = dot(grad(add(i, vec2(0, 1))), sub(f, vec2(0, 1)));
  const d11 = dot(grad(add(i, vec2(1, 1))), sub(f, vec2(1, 1)));
  return mix(mix(d00, d10, u.x), mix(d01, d11, u.x), u.y).mul(0.5).add(0.5);
});

// ─── Simplex 2D (hash-based gradients, no perm table) ─────────────────────────
const F2 = 0.366025403784439;  // 0.5*(sqrt(3)-1)
const G2 = 0.211324865405187;  // (3-sqrt(3))/6
export const simplexNoise2D = Fn(([p_in]) => {
  const p = vec2(p_in);
  const s = dot(p, vec2(F2, F2));
  const i = floor(add(p, s));
  const t = dot(i, vec2(G2, G2));
  const x0 = sub(sub(p, i), t);
  const gi = Fn(([ii]) => {
    const a = hash21(ii).mul(Math.PI * 2);
    return vec2(cos(a), sin(a));
  });
  const falloff = (v) => {
    const d = dot(v, v);
    const f = sub(0.5, d).max(0);
    return f.mul(f).mul(f).mul(f);
  };
  let n = falloff(x0).mul(dot(gi(i), x0));
  const x1 = add(x0, vec2(1 - G2, -G2));
  n = n.add(falloff(x1).mul(dot(gi(add(i, vec2(1, 0))), x1)));
  const x2 = add(x0, vec2(-G2, 1 - G2));
  n = n.add(falloff(x2).mul(dot(gi(add(i, vec2(0, 1))), x2)));
  const x3 = add(x0, vec2(1 - 2 * G2, 1 - 2 * G2));
  n = n.add(falloff(x3).mul(dot(gi(add(i, vec2(1, 1))), x3)));
  return clamp(n.mul(70).add(0.5), 0, 1);
});

// ─── Voronoi F1 (distance to nearest site) ───────────────────────────────────
// Returns ~0..1.4; use smoothstep in the editor to get cells/edges.
export const voronoiF1 = Fn(([p_in, jitter]) => {
  const p = vec2(p_in);
  const ip = floor(p);
  const fp = fract(p);
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [0, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  let md = float(10);
  for (const [nx, ny] of neighbors) {
    const cellOffset = vec2(float(nx), float(ny));
    const rnd = hash22(add(ip, cellOffset));
    const pt = mix(vec2(0.5, 0.5), rnd, jitter);
    const d = length(sub(add(cellOffset, pt), fp));
    md = min(md, d);
  }
  return md;
});

// Voronoi F1 normalized to 0..1 (F1 is typically 0..~1.4)
export const voronoiF1Normalized = Fn(([p_in, jitter]) =>
  clamp(voronoiF1(p_in, jitter).mul(1 / 1.5), 0, 1),
);

// Voronoi as 0..1 "cell" value: 1 - F1 for cell interiors
export const voronoiCell2D = Fn(([p_in, jitter]) => {
  const f1 = voronoiF1(p_in, jitter);
  return sub(1, clamp(f1, 0, 1));
});

// ─── White noise (blocky, no interpolation) ──────────────────────────────────
export const whiteNoise2D = Fn(([p_in]) => hash21(floor(p_in)));

// ─── FBM Perlin (multi-octave, for gradient-masked layers) ───────────────────
export const fbmPerlin2D = Fn(([p_in, octaves, lacunarity, gain]) => {
  const p = vec2(p_in);
  const v = perlinNoise2D(p).toVar();
  const amp = float(1).toVar();
  const frq = float(1).toVar();
  const totalAmp = float(1).toVar();
  const d2 = clamp(sub(octaves, 1.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(perlinNoise2D(p.mul(frq))).mul(d2));
  totalAmp.addAssign(amp.mul(d2));
  const d3 = clamp(sub(octaves, 2.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(perlinNoise2D(p.mul(frq))).mul(d3));
  totalAmp.addAssign(amp.mul(d3));
  const d4 = clamp(sub(octaves, 3.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(perlinNoise2D(p.mul(frq))).mul(d4));
  totalAmp.addAssign(amp.mul(d4));
  return v.div(totalAmp);
});

export const fbmValue2D = Fn(([p_in, octaves, lacunarity, gain]) => {
  const p = vec2(p_in);
  const v = valueNoise2D(p).toVar();
  const amp = float(1).toVar();
  const frq = float(1).toVar();
  const totalAmp = float(1).toVar();
  const d2 = clamp(sub(octaves, 1.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(valueNoise2D(p.mul(frq))).mul(d2));
  totalAmp.addAssign(amp.mul(d2));
  const d3 = clamp(sub(octaves, 2.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(valueNoise2D(p.mul(frq))).mul(d3));
  totalAmp.addAssign(amp.mul(d3));
  const d4 = clamp(sub(octaves, 3.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(valueNoise2D(p.mul(frq))).mul(d4));
  totalAmp.addAssign(amp.mul(d4));
  return v.div(totalAmp);
});

export const fbmSimplex2D = Fn(([p_in, octaves, lacunarity, gain]) => {
  const p = vec2(p_in);
  const v = simplexNoise2D(p).toVar();
  const amp = float(1).toVar();
  const frq = float(1).toVar();
  const totalAmp = float(1).toVar();
  const d2 = clamp(sub(octaves, 1.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(simplexNoise2D(p.mul(frq))).mul(d2));
  totalAmp.addAssign(amp.mul(d2));
  const d3 = clamp(sub(octaves, 2.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(simplexNoise2D(p.mul(frq))).mul(d3));
  totalAmp.addAssign(amp.mul(d3));
  const d4 = clamp(sub(octaves, 3.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(simplexNoise2D(p.mul(frq))).mul(d4));
  totalAmp.addAssign(amp.mul(d4));
  return v.div(totalAmp);
});

export const fbmVoronoiF1_2D = Fn(([p_in, jitter, octaves, lacunarity, gain]) => {
  const p = vec2(p_in);
  const v = voronoiF1Normalized(p, jitter).toVar();
  const amp = float(1).toVar();
  const frq = float(1).toVar();
  const totalAmp = float(1).toVar();
  const d2 = clamp(sub(octaves, 1.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(voronoiF1Normalized(p.mul(frq), jitter)).mul(d2));
  totalAmp.addAssign(amp.mul(d2));
  const d3 = clamp(sub(octaves, 2.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(voronoiF1Normalized(p.mul(frq), jitter)).mul(d3));
  totalAmp.addAssign(amp.mul(d3));
  const d4 = clamp(sub(octaves, 3.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(voronoiF1Normalized(p.mul(frq), jitter)).mul(d4));
  totalAmp.addAssign(amp.mul(d4));
  return v.div(totalAmp);
});

export const fbmWhite2D = Fn(([p_in, octaves, lacunarity, gain]) => {
  const p = vec2(p_in);
  const v = whiteNoise2D(p).toVar();
  const amp = float(1).toVar();
  const frq = float(1).toVar();
  const totalAmp = float(1).toVar();
  const d2 = clamp(sub(octaves, 1.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(whiteNoise2D(p.mul(frq))).mul(d2));
  totalAmp.addAssign(amp.mul(d2));
  const d3 = clamp(sub(octaves, 2.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(whiteNoise2D(p.mul(frq))).mul(d3));
  totalAmp.addAssign(amp.mul(d3));
  const d4 = clamp(sub(octaves, 3.5).mul(2), 0, 1);
  frq.mulAssign(lacunarity);
  amp.mulAssign(gain);
  v.addAssign(amp.mul(whiteNoise2D(p.mul(frq))).mul(d4));
  totalAmp.addAssign(amp.mul(d4));
  return v.div(totalAmp);
});
