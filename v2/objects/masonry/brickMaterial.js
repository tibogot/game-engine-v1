import * as THREE from "three";
import {
  Fn,
  float,
  color,
  vec2,
  vec3,
  sin,
  mix,
  smoothstep,
  mul,
  sub,
  add,
  abs,
  max,
  min,
  fract,
  length,
  normalize,
  div,
  normalWorld,
  normalLocal,
  positionLocal,
  positionWorld,
  dot,
  pow,
  clamp,
  uniform,
  attribute,
} from "three/tsl";
import { fbmPerlin2D, perlinNoise2D } from "../../core/legacy/tsl-noise.js";

/**
 * BRICK MATERIAL — the medieval-arch-showcase / brick-material-lab TSL brick
 * shader as a shared engine module. One uniform set drives every masonry
 * material instance, so all placed structures share the same live-tunable
 * look and the shader permutation count stays at quality × shadow-mode.
 *
 * Quality tiers (colorNode):
 *  - low    (~10 ALU): per-instance tint + sun-side shade, uniform-driven.
 *  - medium (~50 ALU): FBM Perlin stain, triplanar-lite (XY/ZY blend by |n.x|).
 *  - high  (~120 ALU): FBM base + streak/warm/moss/freckle accents, micro
 *                      roughness + rim emissive ("hero" look).
 *
 * positionNode does per-brick pillow bulge + corner chips and runs for the
 * shadow pass too; `lightweightShadows` swaps the shadow-depth pass to plain
 * positionLocal (castShadowPositionNode) — a big shadow-pass win.
 *
 * Requires geometry with a vec4 `brickVar` instanced attribute
 * (shapeMix, warp, grey, grain) — see brickKit.js.
 */

export const BRICK_MATERIAL_DEFAULTS = {
  // Vertex displacement (live uniforms)
  faceBulge: 0,
  chipStrength: 0.025,
  shapeWarp: 1.2,

  // Brick texture (live uniforms — Low + Medium tiers; High reuses most)
  brickColorDark: "#23272d",
  brickColorLight: "#7c818a",
  brickNoiseScale: 1.8, // worldspace noise frequency
  brickNoiseContrast: 0.5, // 0 = soft blobs, 1 = sharp patches
  brickNoiseStrength: 0.2, // 0 = flat colour, 1 = strong dark/light bands
  brickEdgeStrength: 0.08, // -ve = darker corners (worn), +ve = lifted (clean)
  brickShadeStrength: 0.24, // sun-side vs shadow-side brightness range
  brickRoughness: 0.85,
  brickRoughnessVar: 0.15,
  brickNoiseOctaves: 3, // 1..4 (fbmPerlin2D smoothly fades octaves)
  brickNoiseLacunarity: 2.0,
  brickNoiseGain: 0.5,

  // Shader build options (changing these swaps the cached material)
  shaderQuality: "high", // "low" | "medium" | "high"
  lightweightShadows: true,
};

// ── Shared live uniforms (single set for ALL masonry materials) ──
const sunDirUniform = uniform(new THREE.Vector3(0, -1, 0));
const uFaceBulge = uniform(BRICK_MATERIAL_DEFAULTS.faceBulge);
const uChipStrength = uniform(BRICK_MATERIAL_DEFAULTS.chipStrength);
const uShapeWarp = uniform(BRICK_MATERIAL_DEFAULTS.shapeWarp);
const uBrickColorDark = uniform(new THREE.Color(BRICK_MATERIAL_DEFAULTS.brickColorDark));
const uBrickColorLight = uniform(new THREE.Color(BRICK_MATERIAL_DEFAULTS.brickColorLight));
const uBrickNoiseScale = uniform(BRICK_MATERIAL_DEFAULTS.brickNoiseScale);
const uBrickNoiseContrast = uniform(BRICK_MATERIAL_DEFAULTS.brickNoiseContrast);
const uBrickNoiseStrength = uniform(BRICK_MATERIAL_DEFAULTS.brickNoiseStrength);
const uBrickEdgeStrength = uniform(BRICK_MATERIAL_DEFAULTS.brickEdgeStrength);
const uBrickShadeStrength = uniform(BRICK_MATERIAL_DEFAULTS.brickShadeStrength);
const uBrickRoughness = uniform(BRICK_MATERIAL_DEFAULTS.brickRoughness);
const uBrickRoughnessVar = uniform(BRICK_MATERIAL_DEFAULTS.brickRoughnessVar);
const uBrickNoiseOctaves = uniform(BRICK_MATERIAL_DEFAULTS.brickNoiseOctaves);
const uBrickNoiseLacunarity = uniform(BRICK_MATERIAL_DEFAULTS.brickNoiseLacunarity);
const uBrickNoiseGain = uniform(BRICK_MATERIAL_DEFAULTS.brickNoiseGain);

/** Push param values into the shared uniforms (cheap, call on any UI change). */
export function syncBrickUniforms(params) {
  uFaceBulge.value = params.faceBulge;
  uChipStrength.value = params.chipStrength;
  uShapeWarp.value = params.shapeWarp;
  uBrickColorDark.value.set(params.brickColorDark);
  uBrickColorLight.value.set(params.brickColorLight);
  uBrickNoiseScale.value = params.brickNoiseScale;
  uBrickNoiseContrast.value = params.brickNoiseContrast;
  uBrickNoiseStrength.value = params.brickNoiseStrength;
  uBrickEdgeStrength.value = params.brickEdgeStrength;
  uBrickShadeStrength.value = params.brickShadeStrength;
  uBrickRoughness.value = params.brickRoughness;
  uBrickRoughnessVar.value = params.brickRoughnessVar;
  uBrickNoiseOctaves.value = params.brickNoiseOctaves;
  uBrickNoiseLacunarity.value = params.brickNoiseLacunarity;
  uBrickNoiseGain.value = params.brickNoiseGain;
}

const _sunDir = new THREE.Vector3();

/** Feed the sun direction (target − position, normalized) from a DirectionalLight. */
export function updateBrickSunDirection(sun) {
  _sunDir.copy(sun.target.position).sub(sun.position).normalize();
  sunDirUniform.value.copy(_sunDir);
}

export function setBrickSunDirection(dir) {
  sunDirUniform.value.copy(dir).normalize();
}

function createBrickMaterial(quality, lightweightShadows) {
  const brickVarA = attribute("brickVar", "vec4");
  const shapeM = brickVarA.x;
  const warpS = brickVarA.y;
  const greyK = brickVarA.z;
  const grain = brickVarA.w;

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.015 });

  const isHigh = quality === "high";
  const isLow = quality === "low";

  // ===== colorNode — three quality tiers =====
  if (isLow) {
    mat.colorNode = Fn(() => {
      const base = mix(uBrickColorDark, uBrickColorLight, greyK);
      const nd = clamp(dot(normalWorld, sunDirUniform), 0, 1);
      const halfShade = uBrickShadeStrength.mul(0.5);
      const shade = mix(
        sub(float(1), halfShade),
        add(float(1), halfShade),
        nd.mul(0.5).add(0.5),
      );
      const shapeTone = mix(float(0.96), float(1.04), shapeM);
      return mul(mul(base, shade), shapeTone);
    })();
  } else if (!isHigh) {
    // Medium: real FBM Perlin, triplanar-lite blend so noise reads correctly
    // on any wall orientation (no streak-on-diagonal-faces artifact).
    mat.colorNode = Fn(() => {
      const pw = positionWorld;
      const seed = grain.mul(6.283).add(greyK.mul(12.7));
      const seedOffset = vec2(seed, seed.mul(0.71));

      const pXY = pw.xy.mul(uBrickNoiseScale).add(seedOffset);
      const pZY = pw.zy.mul(uBrickNoiseScale).add(seedOffset);
      const nXY = fbmPerlin2D(pXY, uBrickNoiseOctaves, uBrickNoiseLacunarity, uBrickNoiseGain);
      const nZY = fbmPerlin2D(pZY, uBrickNoiseOctaves, uBrickNoiseLacunarity, uBrickNoiseGain);
      const blendW = abs(normalWorld.x);
      const n1 = mix(nXY, nZY, blendW);

      const base = mix(uBrickColorDark, uBrickColorLight, greyK);

      // Contrast control: tighter smoothstep window → harder dark/light bands
      const halfWin = sub(float(0.5), uBrickNoiseContrast.mul(0.45));
      const stain = smoothstep(halfWin, sub(float(1), halfWin), n1);
      const body = mul(
        base,
        mix(
          sub(float(1), uBrickNoiseStrength),
          add(float(1), uBrickNoiseStrength),
          stain,
        ),
      );

      const nd = clamp(dot(normalWorld, sunDirUniform), 0, 1);
      const halfShade = uBrickShadeStrength.mul(0.5);
      const shade = mix(
        sub(float(1), halfShade),
        add(float(1), halfShade),
        nd.mul(0.55).add(0.45),
      );

      const ax = abs(normalWorld.x);
      const ay = abs(normalWorld.y);
      const az = abs(normalWorld.z);
      const edgeFac = pow(max(ax, max(ay, az)), float(2.4));
      const edgeAdj = add(float(1), uBrickEdgeStrength.mul(edgeFac));
      const shapeTone = mix(float(0.96), float(1.04), shapeM);
      return mul(mul(mul(body, shade), edgeAdj), shapeTone);
    })();
  } else {
    // High: FBM Perlin base + stylistic accent layers (streak, warm, moss,
    // freckle) for the "hero" look.
    mat.colorNode = Fn(() => {
      const pw = positionWorld;
      const seed = grain.mul(6.283).add(greyK.mul(12.7));
      const seedOffset = vec2(seed, seed.mul(0.71));

      const pXY = pw.xy.mul(uBrickNoiseScale).add(seedOffset);
      const pZY = pw.zy.mul(uBrickNoiseScale).add(seedOffset);
      const fbmXY = fbmPerlin2D(pXY, uBrickNoiseOctaves, uBrickNoiseLacunarity, uBrickNoiseGain);
      const fbmZY = fbmPerlin2D(pZY, uBrickNoiseOctaves, uBrickNoiseLacunarity, uBrickNoiseGain);
      const fbm = mix(fbmXY, fbmZY, abs(normalWorld.x));
      // Higher-frequency single Perlin for moss accent (cheap)
      const w2 = perlinNoise2D(pXY.mul(2.35));
      const w3 = perlinNoise2D(pZY.mul(5.1).add(vec2(7, 13)));
      const streak = sin(
        pw.x.mul(2.8).add(pw.y.mul(4.2)).add(pw.z.mul(1.6)).add(grain.mul(24)),
      ).mul(0.5).add(0.5);

      const dark = uBrickColorDark;
      const light = uBrickColorLight;
      const mid = mix(dark, light, float(0.5));
      const body0 = mix(dark, mix(mid, light, greyK), float(0.58));
      const halfWinH = sub(float(0.5), uBrickNoiseContrast.mul(0.35));
      const stain = smoothstep(halfWinH, sub(float(1), halfWinH), fbm);
      const body1 = mul(
        body0,
        mix(
          sub(float(1), uBrickNoiseStrength),
          add(float(1), uBrickNoiseStrength),
          stain,
        ),
      );
      const warm = mix(color(0x5c5248), color(0x6a6056), streak);
      const body2 = mix(
        body1,
        mul(body1, warm),
        float(0.07).mul(smoothstep(0.35, 0.72, streak)),
      );
      const moss = smoothstep(float(0.62), float(0.94), w2.mul(w3));
      const body3 = mix(
        body2,
        mul(body2, color(0x9aa898)),
        moss.mul(0.045).mul(warpS.mul(0.4).add(0.6)),
      );

      const speck = fract(
        sin(dot(pw.xz, vec2(12.9898, 78.233))).mul(43758.5453),
      );
      const freckle = smoothstep(float(0.72), float(0.96), speck).mul(0.11);
      const baseCol = mul(body3, sub(float(1), freckle));
      const nd = clamp(dot(normalWorld, sunDirUniform), 0, 1);
      const halfShadeH = uBrickShadeStrength.mul(0.5);
      const coolShade = mix(
        sub(float(1), halfShadeH),
        add(float(1), halfShadeH),
        nd.mul(0.55).add(0.45),
      );
      const ax = abs(normalWorld.x);
      const ay = abs(normalWorld.y);
      const az = abs(normalWorld.z);
      const edgeFac = pow(max(ax, max(ay, az)), float(2.35));
      const edgeLift = add(float(1), uBrickEdgeStrength.mul(edgeFac));
      const shapeTone = mix(float(0.96), float(1.04), shapeM.mul(0.35).add(0.65));
      return mul(mul(mul(baseCol, coolShade), edgeLift), shapeTone);
    })();
  }

  // ===== roughnessNode — only adds cost on high =====
  if (isHigh) {
    mat.roughnessNode = Fn(() => {
      const pw = positionWorld
        .mul(2.4)
        .add(vec3(grain.mul(9), greyK.mul(6), shapeM.mul(3)));
      const pit = sin(dot(pw, vec3(2.1, 1.7, 2.4))).mul(0.5).add(0.5);
      const pit2 = sin(dot(pw.mul(1.7), vec3(1.6, 2.2, 1.9))).mul(0.5).add(0.5);
      const microRough = pit.mul(0.55).add(pit2.mul(0.45));
      const baseR = mix(
        float(0.82),
        float(0.97),
        greyK.mul(0.38).add(grain.mul(0.24)),
      );
      return clamp(baseR.add(microRough.mul(0.07)), float(0.44), float(0.995));
    })();
  } else {
    mat.roughnessNode = Fn(() => {
      const variation = sub(greyK.mul(2), float(1)).mul(uBrickRoughnessVar);
      return clamp(add(uBrickRoughness, variation), float(0.3), float(0.99));
    })();
  }

  // ===== emissiveNode — only on high =====
  if (isHigh) {
    mat.emissiveNode = Fn(() => {
      const nd = clamp(dot(normalWorld, sunDirUniform), 0, 1);
      const rim = pow(
        sub(float(1), abs(dot(normalWorld, vec3(0, 1, 0)))),
        float(2.15),
      );
      const g0 = mix(color(0x4a4d52), color(0x686c72), nd);
      return mul(g0, mul(rim, float(0.032))).mul(warpS.mul(0.55).add(0.45));
    })();
  }

  // ===== positionNode (vertex displacement, runs for color AND shadow) =====
  mat.positionNode = Fn(() => {
    const pl = positionLocal;
    const nl = normalLocal;
    const ax = abs(pl.x);
    const ay = abs(pl.y);
    const az = abs(pl.z);
    const mn = min(ax, min(ay, az));
    const mx = max(ax, max(ay, az));
    const edgeShell = smoothstep(float(0.14), float(0.44), mx);
    const cornerBand = smoothstep(float(0.022), float(0.095), mn).mul(
      smoothstep(float(0.33), float(0.48), mx),
    );
    const plLen = length(pl);
    const cenW = smoothstep(float(0.01), float(0.05), plLen);

    // Flatness of vertex normal — ~1 on flat faces, lower on the fillet ring.
    // Push flat faces outward (pillow bulge) without touching rounded edges
    // (which would flip triangle winding).
    const nFlat = max(abs(nl.x), max(abs(nl.y), abs(nl.z)));
    const filletGuard = smoothstep(float(0.78), float(0.99), nFlat);

    // Per-brick warp strength (driven by per-instance attribute)
    const wv = warpS.mul(shapeM.mul(0.55).add(0.45)).mul(uShapeWarp);

    // Pillow mask: 1 when off-axis distance (mn) is small vs dominant (mx).
    const pillowMask = sub(
      float(1),
      smoothstep(float(0.05), float(0.27), mn),
    ).mul(filletGuard);

    // High-frequency bump for surface texture variation
    const bump = sin(
      pl.x.mul(11).add(pl.y.mul(9)).add(pl.z.mul(7)).add(grain.mul(40)),
    ).mul(0.5).add(0.5);

    // Outward face bulge — always positive, along the vertex normal.
    const bulgeAmp = uFaceBulge
      .mul(pillowMask)
      .mul(wv.mul(0.5).add(0.5)) // even no-warp bricks get some bulge
      .mul(mix(float(0.55), float(1.15), bump))
      .mul(cenW);

    // Inward chip at random corners, along the radial direction so it stays
    // smooth on the rounded fillet (no winding flips).
    const chipPick = fract(
      grain.mul(47.13).add(greyK.mul(91.7)).add(shapeM.mul(23.1)),
    );
    const chipMask = smoothstep(float(0.84), float(0.96), chipPick)
      .mul(cornerBand)
      .mul(edgeShell)
      .mul(cenW);
    const chipMag = uChipStrength.mul(chipMask).mul(warpS.mul(0.42).add(0.58));
    const rlen = max(length(pl), float(1e-5));
    const radial = normalize(div(pl, rlen));
    const chip = mul(radial, float(-1)).mul(chipMag);

    return positionLocal.add(nl.mul(bulgeAmp)).add(chip);
  })();

  // Big shadow-pass win: skip bulge/chip displacement during shadow render.
  if (lightweightShadows) {
    mat.castShadowPositionNode = positionLocal;
  }

  return mat;
}

// One material per quality × shadow-mode, shared by every masonry mesh.
const _materialCache = new Map();

export function getBrickMaterial(quality, lightweightShadows) {
  const key = `${quality}|${lightweightShadows ? 1 : 0}`;
  let mat = _materialCache.get(key);
  if (!mat) {
    mat = createBrickMaterial(quality, !!lightweightShadows);
    _materialCache.set(key, mat);
  }
  return mat;
}

/** Grit-shaded mortar backing material (fills brick gaps behind the wall). */
export function createBrickMortarMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  m.colorNode = Fn(() => {
    const pw = positionWorld;
    const n1 = sin(dot(pw.mul(8.0), vec3(2.1, 1.7, 1.3))).mul(0.5).add(0.5);
    const n2 = sin(dot(pw.mul(20.0).add(vec3(7.0, 13.0, 3.0)), vec3(1.7, 2.4, 1.9)))
      .mul(0.5)
      .add(0.5);
    const grit = n1.mul(0.65).add(n2.mul(0.35));
    return mix(color(0x24201a), color(0x342d24), grit);
  })();
  m.roughnessNode = Fn(() => {
    const pw = positionWorld;
    const n = sin(dot(pw.mul(15.0), vec3(2.3, 1.9, 1.5))).mul(0.5).add(0.5);
    return clamp(float(0.94).add(n.mul(0.04)), float(0.6), float(0.99));
  })();
  return m;
}
