/**
 * The substrate — sculpted soil, its cross-section, and the caustics on the water floor.
 *
 * Built as a closed solid rather than a plane: the surface grid, a skirt dropping to the
 * tank floor, and a cap. The skirt is not busywork — through the glass you are looking
 * at a *cross-section* of the soil, and the layered strata in that edge is one of the
 * most convincing details in the whole scene. A bare plane hovering with nothing under
 * it destroys the illusion instantly from any low angle.
 *
 * Surface detail is split by frequency: a baked albedo map carries the low-frequency
 * colour story (damp ring, sand patches, grit drift) at footprint scale, and a separate
 * tiling grain normal map carries the high-frequency relief. Trying to do both in one
 * map at this camera distance would need an impractical resolution.
 */
import * as THREE from "three/webgpu";
import {
  vec2, vec3, float, uniform, texture, uv, positionWorld, normalWorld,
  mix, smoothstep, oneMinus, abs, pow, clamp, time, mx_noise_float,
} from "three/tsl";
import {
  fbm, ridged, makeDataTexture, bakeNormalMap, clamp01, lerp,
  smoothstep as sstep,
} from "./terrariumTextures.js";
import { TANK } from "./terrariumGlass.js";

/** The water dish, in tank-local metres. Shared with the water module. */
export const DISH = {
  x: 0.235,
  z: 0.085,
  r: 0.088,
  floor: 0.026,
  level: 0.041,
};

/** Where the basking rock sits, under the lamp. Decor and lighting both key off this. */
export const BASK = { x: -0.265, z: -0.020 };

export const SUBSTRATE_DEFAULTS = {
  // Halved once the lake material landed. Seen through real absorption and refraction
  // the same caustics read far stronger — and tinted cyan, because the water eats red —
  // so at the old strength they looked like neon rather than focused light.
  caustics: 0.45,
  dampness: 1.0,
  grain: 1.0,
};

const SURF_MIN = TANK.glass + 0.004;

/**
 * Soil surface height at a tank-local point, in metres above the tank floor.
 *
 * Hand-authored rather than brush-sculpted: this page is about look, and a fixed
 * landscape that reads well beats a sculpt tool with nothing sculpted into it. The
 * shapes are chosen to give the scene the three zones a real vivarium has — a warm
 * raised basking end, a cool humid end with standing water, and a flat middle to cross.
 */
export function substrateHeight(x, z) {
  // Gentle rise toward the basking (-X) end.
  const rise = sstep(-0.40, 0.28, -x);
  let h = 0.048 + rise * 0.050;

  // Dunes. Low amplitude — at 45 cm viewing distance a 1.5 cm undulation is plenty.
  h += (fbm(x * 7 + 10, z * 7 + 3, { octaves: 4, seed: 3 }) - 0.5) * 0.016;
  h += (fbm(x * 19 + 4, z * 19 + 8, { octaves: 3, seed: 23 }) - 0.5) * 0.005;

  // A ridge behind the basking spot, so the hot end has some vertical interest and the
  // lamp has something to throw a shadow off.
  const ridgeD = Math.hypot((x + 0.30) / 0.17, (z + 0.09) / 0.14);
  h += Math.max(0, 1 - ridgeD) ** 2 * 0.030;

  // The basin. Dug out, with a slightly raised lip where the displaced soil piled up.
  const dr = Math.hypot(x - DISH.x, z - DISH.z);
  const bowl = sstep(DISH.r * 1.30, DISH.r * 0.30, dr);
  const lip = Math.exp(-(((dr - DISH.r * 1.16) / (DISH.r * 0.26)) ** 2));
  h = lerp(h, DISH.floor + (fbm(x * 40, z * 40, { seed: 9 }) - 0.5) * 0.004, bowl);
  h += lip * 0.011 * (1 - bowl);

  return Math.max(SURF_MIN, Math.min(0.15, h));
}

// ── baked maps ───────────────────────────────────────────────────────────────────────

/**
 * Albedo + roughness for the soil surface.
 *
 * RGB is colour, A is roughness. Packing roughness in alpha keeps it to one sampler —
 * worth caring about, because WebGPU's per-stage sampler ceiling is real and this page
 * already spends several on glass, grain and ripples.
 */
function bakeSoilAlbedo(size = 1024) {
  const data = new Uint8Array(size * size * 4);
  const HUMUS = [0.055, 0.038, 0.026];
  const SOIL = [0.115, 0.078, 0.050];
  // Kept deliberately dark. Soil albedo is genuinely low — dry sand is around 0.20 —
  // and authoring it brighter blows the patches to pure white the moment the basking
  // lamp lands on them, which reads as a shader bug rather than as sunlit sand.
  const SAND = [0.170, 0.138, 0.098];
  const GRIT = [0.170, 0.155, 0.140];

  for (let py = 0; py < size; py++) {
    // Texture v maps to tank z. Convert to tank-local metres so the damp ring lands
    // exactly where the basin is.
    const v = py / (size - 1);
    const z = (v - 0.5) * TANK.id;
    for (let px = 0; px < size; px++) {
      const u = px / (size - 1);
      const x = (u - 0.5) * TANK.iw;

      // Two soil families drifting into each other, plus a sand wash on the dry end.
      const mixN = fbm(u * 9, v * 9, { octaves: 5, seed: 2 });
      const sandN = clamp01((fbm(u * 4 + 3, v * 4, { octaves: 4, seed: 14 }) - 0.44) * 3.0);
      const dryBias = sstep(0.05, -0.35, x);   // more sand at the warm -X end

      let col = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        let c = lerp(HUMUS[k], SOIL[k], sstep(0.35, 0.72, mixN));
        c = lerp(c, SAND[k], sandN * (0.22 + 0.40 * dryBias));
        col[k] = c;
      }

      // Grit: sparse pale specks, the thing that stops soil reading as a brown fog.
      const gritN = ridged(u * 130, v * 130, { octaves: 2, seed: 33 });
      const grit = clamp01((gritN - 0.86) * 8.0);
      for (let k = 0; k < 3; k++) col[k] = lerp(col[k], GRIT[k], grit * 0.85);

      let rough = 0.93 - grit * 0.18 + (mixN - 0.5) * 0.06;

      // Damp halo around the basin. Wet soil is much darker and much glossier — this one
      // gradient does more for "there is water here" than the water surface itself.
      const dr = Math.hypot(x - DISH.x, z - DISH.z);
      const damp = sstep(DISH.r * 2.05, DISH.r * 0.95, dr);
      for (let k = 0; k < 3; k++) col[k] *= lerp(1.0, 0.46, damp);
      rough = lerp(rough, 0.30, damp);

      const i = (py * size + px) * 4;
      data[i] = clamp01(col[0]) * 255;
      data[i + 1] = clamp01(col[1]) * 255;
      data[i + 2] = clamp01(col[2]) * 255;
      data[i + 3] = clamp01(rough) * 255;
    }
  }
  const tex = makeDataTexture(data, size, { colorSpace: THREE.SRGBColorSpace });
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;  // it maps 1:1 to the footprint
  return tex;
}

/** Tiling grain relief: coarse grit over a fine tooth. */
function bakeSoilGrain(size = 512) {
  return bakeNormalMap(size, (x, y) => {
    const u = (x / size) * 8, v = (y / size) * 8;
    const coarse = ridged(u * 4, v * 4, { octaves: 3, seed: 51, period: 32 });
    const fine = fbm(u * 16, v * 16, { octaves: 3, seed: 77, period: 128 });
    return coarse * 0.7 + fine * 0.3;
  }, 2.4);
}

/** Ripple relief for the water surface. Lives here because it shares the noise basis. */
export function bakeRippleNormal(size = 512) {
  return bakeNormalMap(size, (x, y) => {
    const u = (x / size) * 8, v = (y / size) * 8;
    return fbm(u * 2.0, v * 2.0, { octaves: 4, seed: 5, period: 16 });
  }, 1.1);
}

// ── geometry ─────────────────────────────────────────────────────────────────────────

/**
 * Closed soil solid: surface grid, perimeter skirt, floor cap.
 *
 * The skirt gets its own vertices rather than sharing the surface's boundary ring. If
 * they were shared, computeVertexNormals would average the up-facing surface with the
 * out-facing wall and round off the top edge into a soft blob — exactly the wrong read
 * for a cut soil face pressed against glass.
 */
function buildSubstrateGeometry(nx = 200, nz = 100) {
  const iw = TANK.iw, id = TANK.id;
  const pos = [], nrm = [], uvs = [], idx = [];

  const px = (i) => (i / nx - 0.5) * iw;
  const pz = (j) => (j / nz - 0.5) * id;

  // Surface, with normals differenced straight off the height function so they are
  // exact rather than an average of the triangles that approximate it.
  const eps = 0.0015;
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = px(i), z = pz(j);
      const y = substrateHeight(x, z);
      pos.push(x, y, z);
      const dx = (substrateHeight(x + eps, z) - substrateHeight(x - eps, z)) / (2 * eps);
      const dz = (substrateHeight(x, z + eps) - substrateHeight(x, z - eps)) / (2 * eps);
      const n = new THREE.Vector3(-dx, 1, -dz).normalize();
      nrm.push(n.x, n.y, n.z);
      uvs.push(i / nx, j / nz);
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  // Skirt. Four strips, each with an outward normal, walking the boundary in a
  // consistent winding so the faces point out of the block.
  const baseY = TANK.glass;
  const addStrip = (samples, normal) => {
    const start = pos.length / 3;
    for (let s = 0; s < samples.length; s++) {
      const [x, z] = samples[s];
      const y = substrateHeight(x, z);
      pos.push(x, y, z, x, baseY, z);
      nrm.push(normal.x, normal.y, normal.z, normal.x, normal.y, normal.z);
      const t = s / (samples.length - 1);
      uvs.push(t, 1, t, 0);
    }
    for (let s = 0; s < samples.length - 1; s++) {
      const a = start + s * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
  };
  const front = [], back = [], left = [], right = [];
  for (let i = 0; i <= nx; i++) { front.push([px(i), pz(nz)]); back.push([px(nx - i), pz(0)]); }
  for (let j = 0; j <= nz; j++) { left.push([px(0), pz(j)]); right.push([px(nx), pz(nz - j)]); }
  addStrip(front, new THREE.Vector3(0, 0, 1));
  addStrip(back, new THREE.Vector3(0, 0, -1));
  addStrip(left, new THREE.Vector3(-1, 0, 0));
  addStrip(right, new THREE.Vector3(1, 0, 0));

  // Floor cap. Never seen through the glass, but it closes the solid so nothing shows
  // hollow from a low angle through the base pane.
  const cs = pos.length / 3;
  for (const [x, z] of [[-iw / 2, -id / 2], [iw / 2, -id / 2], [iw / 2, id / 2], [-iw / 2, id / 2]]) {
    pos.push(x, baseY, z); nrm.push(0, -1, 0); uvs.push(0, 0);
  }
  idx.push(cs, cs + 1, cs + 2, cs, cs + 2, cs + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

// ── material ─────────────────────────────────────────────────────────────────────────

export function createSubstrate(params = SUBSTRATE_DEFAULTS) {
  const albedoTex = bakeSoilAlbedo();
  const grainTex = bakeSoilGrain();
  grainTex.repeat.set(26, 13);

  const u = {
    caustics: uniform(params.caustics),
    dampness: uniform(params.dampness),
    waterLevel: uniform(DISH.level),
  };

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  mat.normalMap = grainTex;
  mat.normalScale = new THREE.Vector2(params.grain, params.grain);

  const soil = texture(albedoTex, uv());

  // Strata for the cut face. Keyed off world Y so the bands stay horizontal regardless
  // of which wall you are looking at, which is what makes them read as deposited layers
  // rather than as a texture wrapped round the block.
  const wy = positionWorld.y;
  const band = mx_noise_float(vec3(positionWorld.x.mul(6), wy.mul(150), positionWorld.z.mul(6)))
    .mul(0.5).add(0.5);
  const fleck = mx_noise_float(vec3(positionWorld.x.mul(180), wy.mul(320), positionWorld.z.mul(180)))
    .mul(0.5).add(0.5);
  const strata = mix(vec3(0.030, 0.021, 0.015), vec3(0.075, 0.050, 0.034), band)
    .add(vec3(0.05).mul(smoothstep(0.86, 1.0, fleck)));

  // Blend surface against cut face by how up-facing the normal is.
  const upness = smoothstep(0.30, 0.78, normalWorld.y);
  let albedo = mix(strata, soil.rgb, upness);
  let rough = mix(float(0.96), soil.a, upness);

  // ── submerged shading ─────────────────────────────────────────────────────────────
  const pxz = vec2(positionWorld.x, positionWorld.z);
  const dDish = pxz.sub(vec2(DISH.x, DISH.z)).length();
  const inDish = oneMinus(smoothstep(DISH.r * 0.80, DISH.r * 1.02, dDish));
  // 1 below the waterline, 0 above, with a couple of millimetres of feathering so the
  // shoreline is a damp band rather than a hard cut.
  //
  // Two masks, not one. `underWater` is geometry — is this texel below the waterline —
  // and `damp` is that times an artistic knob. They were the same value at first, which
  // silently coupled them: turning the wet-soil slider down also faded out the caustics,
  // because caustics are a fact about being underwater, not a shading preference.
  const underWater = oneMinus(smoothstep(u.waterLevel.sub(0.005), u.waterLevel.add(0.003), wy))
    .mul(inDish);
  const damp = underWater.mul(u.dampness);

  // Only a mild darkening now. The lake material above this does its own per-channel
  // Beer-Lambert absorption over the water column, so a heavy wet-soil darkening here
  // double-counts it and the dish turns into a black hole with caustics floating in it.
  albedo = albedo.mul(mix(float(1.0), float(0.78), damp));
  rough = mix(rough, float(0.14), damp.mul(0.92));

  // ── caustics ──────────────────────────────────────────────────────────────────────
  // The bright net comes from the ZERO CROSSINGS of a noise field, not its peaks:
  // 1 - |n| raised to a high power leaves thin filaments where n passes through zero,
  // which is exactly the shape of light focused through a rippled surface. Two layers at
  // different scales and drift directions give the slow interference that sells it.
  const t = time;
  const q1 = pxz.mul(52).add(vec2(t.mul(0.09), t.mul(-0.065)));
  const n1 = mx_noise_float(vec3(q1.x, q1.y, t.mul(0.22)));
  const c1 = pow(oneMinus(abs(n1)), 14);
  const q2 = pxz.mul(83).add(vec2(t.mul(-0.12), t.mul(0.085)));
  const n2 = mx_noise_float(vec3(q2.x, q2.y, t.mul(0.17).add(31.7)));
  const c2 = pow(oneMinus(abs(n2)), 22);

  // Added to albedo rather than emitted, so the caustics take the colour and direction
  // of whatever light is actually on the tank — warm under the basking lamp, red at
  // night. An emissive caustic would glow just as brightly with the lamp switched off.
  const caustic = c1.mul(0.85).add(c2.mul(0.55)).mul(underWater).mul(u.caustics);
  albedo = albedo.add(vec3(0.85, 0.95, 0.90).mul(caustic));

  mat.colorNode = albedo;
  mat.roughnessNode = clamp(rough, 0.05, 1.0);

  const mesh = new THREE.Mesh(buildSubstrateGeometry(), mat);
  mesh.name = "substrate";
  mesh.receiveShadow = true;
  mesh.castShadow = true;

  return { mesh, material: mat, uniforms: u, albedoTex, grainTex };
}
