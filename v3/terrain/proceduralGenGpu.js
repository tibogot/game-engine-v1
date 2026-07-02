/**
 * GPU procedural terrain generator — TSL port of
 * v2/core/terrain/proceduralTerrainGen.js + the v3 caldera/boundary-fade logic
 * from proceduralGen.js.
 *
 * Renders the whole heightmap in one fragment pass via
 * sculptBrush.runGeneratorPass(quad), which makes the procedural sliders live:
 * regenerating 1024² costs a fraction of a millisecond on GPU vs the ~0.5 s
 * main-thread freeze of the CPU path.
 *
 * Differences vs the CPU generator (intentional):
 *  - Perlin FBM (mx_noise_float) instead of sin-hash value noise. The sin-hash
 *    breaks down in f32 on the GPU for large seed offsets; Perlin also just
 *    looks better. Same parameter ranges, slightly different terrain character.
 *  - Seeds shift the noise through the 3rd dimension instead of offsetting x/y,
 *    so coordinates stay small and precise at every octave.
 *  - Octave count is a live uniform: 8 octaves are always evaluated, gated by
 *    step() — branchless and cheap for a one-shot full-map pass.
 *  - tiltX/tiltZ are not ported (no UI, always 0 in v3).
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  abs,
  clamp,
  length,
  max,
  mix,
  pow,
  step,
  uniform,
  uv,
  mx_noise_float,
} from "three/tsl";
import { MAX_HEIGHT } from "./heightmapTexture.js";

const SHAPE_IDS = {
  circle:    0,
  noise:     1,
  box:       2,
  caldera:   3,
  ring:      4,
  noiseRing: 5,
};

export function createProceduralGenPass() {
  const uScale   = uniform(4.0);
  const uOctaves = uniform(6.0);   // 1..8, gates the unrolled octave chain
  const uHeight  = uniform(120.0); // world metres
  const uWarp    = uniform(0.0);
  const uDropoff = uniform(1.2);
  const uPlains  = uniform(0.0);
  const uMode    = uniform(0.0);   // 0 = fbm, 1 = ridge
  const uShapeId = uniform(0.0);
  const uCenter  = uniform(new THREE.Vector2(0.5, 0.5)); // falloff center (0.5 + offset)
  const uSeedZ   = uniform(0.0);   // seed as a z-slice through the 3D noise

  /** Fixed-octave signed FBM (≈ [-1,1]); zBase decorrelates the noise fields. */
  function fbmSigned(px, py, octaves, zBase) {
    let acc = null;
    let m = 0, amp = 0.5, f = 1;
    for (let i = 0; i < octaves; i++) {
      const n = mx_noise_float(vec3(
        px.mul(float(f)),
        py.mul(float(f)),
        uSeedZ.add(float(zBase + i * 13.7)),
      ));
      acc = acc ? acc.add(n.mul(float(amp))) : n.mul(float(amp));
      m += amp;
      amp *= 0.5;
      f *= 2;
    }
    return acc.div(float(m));
  }

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.fragmentNode = Fn(() => {
    const uvCoord = uv();
    const nx = uvCoord.x;
    const nz = uvCoord.y;

    // ── Domain warp (matches CPU: fbm4 in [0,1] × warp × 0.08) ───────────────
    const wpx = nx.mul(uScale).mul(float(3));
    const wpz = nz.mul(uScale).mul(float(3));
    const wxp = fbmSigned(wpx, wpz, 4, 131.3).mul(float(0.5)).add(float(0.5)).mul(uWarp).mul(float(0.08));
    const wzp = fbmSigned(wpx, wpz, 4, 217.9).mul(float(0.5)).add(float(0.5)).mul(uWarp).mul(float(0.08));

    const sx = nx.mul(uScale).add(wxp);
    const sz = nz.mul(uScale).add(wzp);

    // ── Main FBM / ridge, 8 octaves gated by uOctaves ────────────────────────
    let accV = null, accR = null, accM = null;
    let amp = 0.5, f = 1;
    for (let i = 0; i < 8; i++) {
      const gate = step(float(i + 0.5), uOctaves);
      const s = mx_noise_float(vec3(
        sx.mul(float(f)),
        sz.mul(float(f)),
        uSeedZ.add(float(5.1 + i * 13.7)),
      ));
      const v = s.mul(float(0.5)).add(float(0.5)); // fbm variant   (0..1)
      const r = float(1).sub(abs(s));              // ridge variant (0..1)
      const a = float(amp).mul(gate);
      accV = accV ? accV.add(v.mul(a)) : v.mul(a);
      accR = accR ? accR.add(r.mul(a)) : r.mul(a);
      accM = accM ? accM.add(a) : a;
      amp *= 0.5;
      f *= 2;
    }
    const raw = mix(accV, accR, uMode).div(max(accM, float(1e-6)));

    // ── Dropoff falloff shapes ───────────────────────────────────────────────
    const dx = nx.sub(uCenter.x).mul(float(2));
    const dz = nz.sub(uCenter.y).mul(float(2));
    const rCircle = length(vec2(dx, dz));
    const rBox    = max(abs(dx), abs(dz));

    // Organic-edge noise (CPU: fbm3 in [0,1] × 0.45).
    const nr = fbmSigned(nx.mul(float(3.1)), nz.mul(float(3.1)), 3, 313.1)
      .mul(float(0.5)).add(float(0.5)).mul(float(0.45));

    const SQRT2 = Math.SQRT2;
    const fCircle = max(float(0), float(1).sub(pow(rCircle, uDropoff)));
    const fNoise  = max(float(0), float(1).sub(pow(max(rCircle.sub(nr), float(0)), uDropoff)));
    const fBox    = max(float(0), float(1).sub(pow(rBox, uDropoff)));
    const fRing   = pow(clamp(rCircle.div(float(SQRT2)), float(0), float(1)), uDropoff);
    const fNRing  = pow(clamp(rCircle.add(nr).div(float(SQRT2 + 0.55)), float(0), float(1)), uDropoff);

    // Caldera: wide circle base (fixed dropoff 0.7) × ring mask around the TRUE
    // center — rises to the rim at 52% of the map radius, falls to 0 at the edge.
    const tdx = nx.sub(float(0.5)).mul(float(2));
    const tdz = nz.sub(float(0.5)).mul(float(2));
    const rTrue  = length(vec2(tdx, tdz)).div(float(SQRT2));
    const rim    = float(0.52);
    const rise   = pow(rTrue.div(rim), float(2));
    const outer  = rTrue.sub(rim).div(float(1).sub(rim));
    const fall   = pow(max(float(0), float(1).sub(outer)), float(1.5));
    const calderaMask = mix(rise, fall, step(rim, rTrue));
    const fCaldera = max(float(0), float(1).sub(pow(rCircle, float(0.7)))).mul(calderaMask);

    const pick = (k) => step(abs(uShapeId.sub(float(k))), float(0.5));
    const falloff = fCircle.mul(pick(0))
      .add(fNoise .mul(pick(1)))
      .add(fBox   .mul(pick(2)))
      .add(fCaldera.mul(pick(3)))
      .add(fRing  .mul(pick(4)))
      .add(fNRing .mul(pick(5)));

    // ── Height, plains cut, boundary fade, normalize ─────────────────────────
    let h = raw.mul(uHeight).mul(falloff);
    h = max(float(0), h.sub(uPlains.mul(uHeight).mul(float(0.6))));

    // Fade to 0 at the inscribed-circle world boundary so the far LOD ring
    // stays flat for every dropoff shape (same as the CPU v3 generator).
    const rB = length(vec2(tdx, tdz));
    h = h.mul(clamp(float(1).sub(rB).div(float(0.05)), float(0), float(1)));

    return vec4(max(h.div(float(MAX_HEIGHT)), float(0)), float(0), float(0), float(1));
  })();

  const quad = new QuadMesh(mat);

  /** Push CPU-side gen params (same object shape as DEFAULT_GEN) into uniforms. */
  function sync(gen) {
    uScale.value   = gen.scale;
    uOctaves.value = Math.max(1, Math.min(8, Math.round(gen.octaves)));
    uHeight.value  = gen.height;
    uWarp.value    = gen.domainWarp;
    uDropoff.value = Math.max(0.01, gen.dropoff);
    uPlains.value  = gen.plains;
    uMode.value    = gen.mode === "ridge" ? 1 : 0;
    uShapeId.value = SHAPE_IDS[gen.dropoffShape] ?? 0;
    uCenter.value.set(0.5 + gen.offsetX, 0.5 + gen.offsetZ);
    // Seed rides the 3rd noise dimension; ×1.618 keeps consecutive seeds ≥1 apart.
    uSeedZ.value = ((gen.seed >>> 0) % 65536) * 1.618;
  }

  return { quad, sync, dispose() { mat.dispose(); } };
}
