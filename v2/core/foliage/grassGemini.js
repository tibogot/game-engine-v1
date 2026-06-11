/**
 * Gemini grass — arc-bending, Voronoi clumping, crossed ribbons, SSS, dual specular.
 * Drop-in replacement for grass-painter7.js with the same editor interface pattern.
 *
 * Exports:
 *   createBladeGeometry(height, baseWidth, ySegments, taperStart)
 *   createFieldInstancedGeometry(baseBlade, patchSize, numGrass, bladeHeight, includeCross)
 *   createGrassMaterial(ctx)
 *   createGrassMaterialMega(ctx) — distant ring: cheap sway, no clump/spec/SSS
 *   setupGrassPatches(scene, camera, grassGroup, geosAndMats, options)
 */
import * as THREE from "three";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  attribute,
  varying,
  uniform,
  texture,
  mix,
  smoothstep,
  clamp,
  abs,
  sin,
  cos,
  fract,
  floor,
  dot,
  normalize,
  length,
  negate,
  add,
  sub,
  div,
  max,
  min,
  pow,
  step,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  cameraPosition,
  normalLocal,
  positionLocal,
  time,
  uv,
  atan,
  PI,
  mx_noise_float,
  reflect,
} from "three/tsl";
import { hash42, hash22 } from "./tsl-utils.js";

// ─── Constants ───
export const GRASS_PATCH_SIZE = 10; // default patch size (world units)

// ─── Tapered blade geometry ───
// Triangular tip cap, smooth taper from taperStart to apex.
export function createBladeGeometry(
  height,
  baseWidth,
  ySegments,
  taperStart = 0.7,
) {
  const taper = THREE.MathUtils.clamp(taperStart, 0.05, 0.999);
  const baseHalf = baseWidth * 0.5;
  const positions = [];
  const uvs = [];
  const indices = [];
  const rowVertCount = [];
  const rowBase = [];
  let v = 0;

  for (let j = 0; j <= ySegments; j++) {
    const t = j / ySegments;
    const y = t * height;
    rowBase[j] = v;

    if (j === ySegments) {
      // Apex — single vertex
      positions.push(0, y, 0);
      uvs.push(0.5, t);
      rowVertCount.push(1);
      v += 1;
    } else {
      const s = THREE.MathUtils.smoothstep(t, taper, 1);
      const w = baseHalf * (1 - s);
      positions.push(-w, y, 0, w, y, 0);
      uvs.push(0, t, 1, t);
      rowVertCount.push(2);
      v += 2;
    }
  }

  for (let j = 0; j < ySegments; j++) {
    const a0 = rowBase[j];
    const a1 = rowBase[j] + 1;
    const b0 = rowBase[j + 1];
    if (rowVertCount[j + 1] === 2) {
      const b1 = b0 + 1;
      indices.push(a0, a1, b1, a0, b1, b0);
    } else {
      indices.push(a0, a1, b0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ─── Instanced field geometry ───
// Grid + jitter placement. `includeCross` adds a second ribbon at +90°.
export function createFieldInstancedGeometry(
  baseBlade,
  patchSize,
  numGrass,
  bladeHeight,
  includeCross = true,
) {
  const numCellsX = Math.max(1, Math.ceil(Math.sqrt(numGrass)));
  const numCellsZ = Math.max(1, Math.ceil(numGrass / numCellsX));
  const cellW = patchSize / numCellsX;
  const cellH = patchSize / numCellsZ;
  const total = includeCross ? numGrass * 2 : numGrass;
  const offsets = new Float32Array(total * 3);
  const phases = new Float32Array(total);
  const isCrossArr = new Float32Array(total);

  for (let i = 0; i < numGrass; i++) {
    const col = i % numCellsX;
    const row = Math.floor(i / numCellsX);
    const x = -patchSize * 0.5 + col * cellW + Math.random() * cellW;
    const z = -patchSize * 0.5 + row * cellH + Math.random() * cellH;
    const phase = Math.random() * Math.PI * 2;
    offsets[i * 3] = x;
    offsets[i * 3 + 1] = 0;
    offsets[i * 3 + 2] = z;
    phases[i] = phase;
    isCrossArr[i] = 0;
    if (includeCross) {
      offsets[(i + numGrass) * 3] = x;
      offsets[(i + numGrass) * 3 + 1] = 0;
      offsets[(i + numGrass) * 3 + 2] = z;
      phases[i + numGrass] = phase;
      isCrossArr[i + numGrass] = 1;
    }
  }

  const ig = new THREE.InstancedBufferGeometry();
  if (baseBlade.index) ig.index = baseBlade.index.clone();
  ig.setAttribute("position", baseBlade.attributes.position.clone());
  ig.setAttribute("uv", baseBlade.attributes.uv.clone());
  if (baseBlade.attributes.normal) {
    ig.setAttribute("normal", baseBlade.attributes.normal.clone());
  }
  ig.setAttribute("offset", new THREE.InstancedBufferAttribute(offsets, 3));
  ig.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  ig.setAttribute(
    "aIsCross",
    new THREE.InstancedBufferAttribute(isCrossArr, 1),
  );
  ig.instanceCount = total;

  const half = patchSize * 0.5;
  const r = Math.sqrt(half * half * 2 + bladeHeight * bladeHeight) + 2;
  ig.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, bladeHeight * 0.5, 0),
    r,
  );
  return ig;
}

// ─── TSL Material ───
// All uniforms come from the caller (editor) via `ctx`.
//
// Required ctx fields:
//   heightTex, grassDensityTex      — DataTexture objects
//   terrainRes                      — number (heightmap resolution, for texel size)
// Optional ctx fields (cliff layer — merged into single system):
//   cliffHeightTex                  — DataTexture (cliff surface Y, -9999 elsewhere)
//   cliffDensityTex                 — Texture (painted cliff grass density)
//   uTerrainSize                    — uniform(float)
//   uSunDir                         — uniform(Vector3)
//   uPlayerPos                      — uniform(Vector3)
//   uBladeHeight                    — uniform(float)
//   uGrassDensity                   — uniform(float)
//   uWindSpeed, uWindStrength       — uniform(float)
//   uMaxAngle, uNaturalLean         — uniform(float)
//   uWindDirX, uWindDirZ            — uniform(float)
//   uWindWaveScale, uWindGust       — uniform(float)
//   uBendFocus, uStiffness          — uniform(float)
//   uClumpScale, uClumpStrength     — uniform(float)
//   uCrossed                        — uniform(float) 0/1
//   uBladeCol, uTipCol              — uniform(Color)
//   uSkyBlend                       — uniform(float)
//   uCylindrical                    — uniform(float)
//   uViewThicken                    — uniform(float)
//   uAoBase, uAoPower               — uniform(float)
//   uColorVar                       — uniform(float) 0/1
//   uCvHueSpread, uCvSatSpread      — uniform(float)
//   uCvDryAmount, uCvDryCol         — uniform(Color)
//   uBssCol                         — uniform(Color)
//   uBssIntensity, uBssPower        — uniform(float)
//   uFrontScatter, uRimSSS          — uniform(float)
//   uSpecV1Enabled, uSpecV1Intensity — uniform(float)
//   uSpecV1Col                      — uniform(Color)
//   uSpecV1Dir                      — uniform(Vector3)
//   uSpecV1Power                    — uniform(float)
//   uSpecV2Enabled, uSpecV2Intensity — uniform(float)
//   uSpecV2Col                      — uniform(Color)
//   uSpecV2Dir                      — uniform(Vector3)
//   uSpecV2NoiseScale, uSpecV2NoiseStr — uniform(float)
//   uSpecV2Power, uSpecV2TipBias    — uniform(float)
//   uLodEnabled                     — uniform(float) 0/1
//   uLodMidDist, uLodFarDist        — uniform(float)
//   uLodMaxDist, uLodFadeStart      — uniform(float)
//   uLodDebug                       — uniform(float) 0/1
//   uInteractionEnabled             — uniform(float) 0/1
//   uInteractionRadius              — uniform(float)
//   uInteractionStrength            — uniform(float)
// Optional terrain color tint (splatmap-chunks):
//   groundColorAtWorldXZ            — (xz: vec2) => vec3 TSL, from createGroundTslBundle
//   uTerrainTintMode                — uniform(float) 0 off, 1 procedural tslGround, 2 imgTex albedo
//   uTerrainTintStrength            — uniform(float)
//   uTerrainTintRootBias            — uniform(float) 0 = full blade, 1 = tint strongest at blade root
//   gemGrassTintPlaceholderTex      — THREE.Texture (1×1 ok); swapped via material.userData._gemTintTexNode.value
//   uGemImgTexUVScale               — uniform(float) same as shared imgTex slot uv scale
//
// 1×1 dummy textures for optional cliff layer (reused across calls)
let _dummyCliffHTex = null;
let _dummyCliffDTex = null;
function _getDummyCliffHTex() {
  if (!_dummyCliffHTex) {
    const d = new Float32Array(4);
    d[0] = d[1] = d[2] = -99999;
    d[3] = 1;
    _dummyCliffHTex = new THREE.DataTexture(
      d,
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    _dummyCliffHTex.needsUpdate = true;
  }
  return _dummyCliffHTex;
}
function _getDummyCliffDTex() {
  if (!_dummyCliffDTex) {
    const d = new Float32Array(4);
    _dummyCliffDTex = new THREE.DataTexture(
      d,
      1,
      1,
      THREE.RGBAFormat,
      THREE.FloatType,
    );
    _dummyCliffDTex.needsUpdate = true;
  }
  return _dummyCliffDTex;
}

let _dummySpecNoiseTex = null;
function _getDummySpecNoiseTex() {
  if (!_dummySpecNoiseTex) {
    const d = new Float32Array([0.5, 0.5, 0.5, 1]);
    _dummySpecNoiseTex = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat, THREE.FloatType);
    _dummySpecNoiseTex.wrapS = _dummySpecNoiseTex.wrapT = THREE.RepeatWrapping;
    _dummySpecNoiseTex.needsUpdate = true;
  }
  return _dummySpecNoiseTex;
}

let _grassTintPlaceholderTex = null;
function _getGrassTintPlaceholderTex() {
  if (!_grassTintPlaceholderTex) {
    const d = new Uint8Array([255, 255, 255, 255]);
    _grassTintPlaceholderTex = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
    _grassTintPlaceholderTex.colorSpace = THREE.SRGBColorSpace;
    _grassTintPlaceholderTex.needsUpdate = true;
  }
  return _grassTintPlaceholderTex;
}

export function createGrassMaterial(ctx) {
  const {
    heightTex,
    grassDensityTex,
    cliffHeightTex: _cliffHTex,
    cliffDensityTex: _cliffDTex,
    terrainNormalTex: _terrainNormalTex,
    terrainRes,
    uTerrainSize,
    uSunDir,
    uPlayerPos,
    uBladeHeight,
    uGrassDensity,
    uWindSpeed,
    uWindStrength,
    uMaxAngle,
    uNaturalLean,
    uWindDirX,
    uWindDirZ,
    uWindWaveScale,
    uWindGust,
    uBendFocus,
    uStiffness,
    uClumpScale,
    uClumpStrength,
    uCrossed,
    uBladeCol,
    uTipCol,
    uSkyBlend,
    uCylindrical,
    uViewThicken,
    uAoBase,
    uAoPower,
    uColorVar,
    uCvHueSpread,
    uCvSatSpread,
    uCvDryAmount,
    uCvDryCol,
    uBssCol,
    uBssIntensity,
    uBssPower,
    uFrontScatter,
    uRimSSS,
    uSpecV1Enabled,
    uSpecV1Intensity,
    uSpecV1Col,
    uSpecV1Dir,
    uSpecV1Power,
    uSpecV2Enabled,
    uSpecV2Intensity,
    uSpecV2Col,
    uSpecV2Dir,
    uSpecV2NoiseScale,
    uSpecV2NoiseStr,
    uSpecV2Power,
    uSpecV2TipBias,
    uLodEnabled,
    uLodMidDist,
    uLodFarDist,
    uLodMaxDist,
    uLodFadeStart,
    uLodDebug,
    uInteractionEnabled,
    uInteractionRadius,
    uInteractionStrength,
    windTex: _windTex,
    specNoiseTex: _specNoiseTex,
    groundColorAtWorldXZ: _groundColorAtWorldXZ,
    uTerrainTintMode: _uTerrainTintMode,
    uTerrainTintStrength: _uTerrainTintStrength,
    uTerrainTintRootBias: _uTerrainTintRootBias,
    gemGrassTintPlaceholderTex: _gemGrassTintPh,
    uGemImgTexUVScale: _uGemImgTexUVScale,
    uSlopeEnabled: _uSlopeEnabled,
    uSlopeMin: _uSlopeMin,
    uSlopeMax: _uSlopeMax,
    cliffMode: _cliffMode,
  } = ctx;

  const cliffMode = _cliffMode ?? false;
  const groundColorAtWorldXZ =
    _groundColorAtWorldXZ ?? ((_xz) => vec3(1, 1, 1));
  const uTerrainTintMode = _uTerrainTintMode ?? uniform(0);
  const uTerrainTintStrength = _uTerrainTintStrength ?? uniform(0);
  const uTerrainTintRootBias = _uTerrainTintRootBias ?? uniform(0);
  const uGemImgTexUVScale = _uGemImgTexUVScale ?? uniform(1);
  const gemGrassTintPh = _gemGrassTintPh ?? _getGrassTintPlaceholderTex();
  const uSlopeEnabled = _uSlopeEnabled ?? uniform(0);
  const uSlopeMin = _uSlopeMin ?? uniform(0.65);
  const uSlopeMax = _uSlopeMax ?? uniform(0.85);

  const cliffHTex = _cliffHTex ?? _getDummyCliffHTex();
  const cliffDTex = _cliffDTex ?? _getDummyCliffDTex();
  const specNoiseTex = _specNoiseTex ?? _getDummySpecNoiseTex();
  const terrainNormalTex = _terrainNormalTex ?? null;
  const useWindTex = !!_windTex;

  // Packed varyings: WebGPU allows 16 user interpolants; MeshStandardNodeMaterial
  // uses many internally, so keep custom outputs minimal (was 8 → now 3 nodes).
  // vPackGrass0: x=lodMorph, y=distFade, z=clumpShade, w=randomShade
  // vPackGrass1: xyz=color tint, w=h5 (same as old vSatHash; drives sat + dry)
  const vPackGrass0 = varying(vec4(0, 0, 0, 1), "v_gm_p0");
  const vPackGrass1 = varying(vec4(1, 1, 1, 0), "v_gm_p1");
  const vCustomNormal = varying(vec3(0, 1, 0), "v_gm_cn");

  // Blade root world XZ (same as vertex height sampling). `positionWorld` in the fragment
  // graph is unreliable with a custom `positionNode` on instanced grass, so we rebuild from
  // the instanced `offset` attribute + `modelWorldMatrix`.
  const offRoot = attribute("offset", "vec3");
  const grassWorldXZ = modelWorldMatrix.mul(
    vec4(offRoot.x, float(0), offRoot.z, float(1)),
  ).xz;
  const gemImgTintUv = grassWorldXZ.div(uTerrainSize).mul(uGemImgTexUVScale);
  const gemTintTexNode = texture(gemGrassTintPh, gemImgTintUv);

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.FrontSide,
    roughness: 0.92,
    metalness: 0,
  });
  material.envMapIntensity = 0;
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  material.userData._gemTintTexNode = gemTintTexNode;

  const vUv = uv();

  // Y-axis rotation helper
  const rotY = (ang, v) => {
    const c = cos(ang),
      s = sin(ang);
    return vec3(
      v.x.mul(c).add(v.z.mul(s)),
      v.y,
      negate(v.x).mul(s).add(v.z.mul(c)),
    );
  };

  // ════════════════════════════════════════════════════════════
  // POSITION NODE — vertex shader
  // ════════════════════════════════════════════════════════════
  material.positionNode = Fn(() => {
    const off = attribute("offset", "vec3");
    const aPhase = attribute("aPhase", "float");
    const aIsCross = attribute("aIsCross", "float");
    const tBase = time.mul(uWindSpeed);
    const tBlade = tBase.add(aPhase);

    // World-space blade root
    const bladeWorld = modelWorldMatrix.mul(
      vec4(off.x, float(0), off.z, float(1)),
    ).xyz;
    const bladeXZ = vec2(bladeWorld.x, bladeWorld.z);

    // ── Heightmap sampling ──
    const terrainUV = add(div(bladeXZ, uTerrainSize), vec2(0.5));
    const terrainH = texture(heightTex, terrainUV).x;

    // ── Cliff layer sampling ──
    const cliffSample = texture(cliffHTex, terrainUV);
    const cliffH = cliffSample.x;
    const cliffD = texture(cliffDTex, terrainUV).x;
    const cliffValid = smoothstep(float(-9990), float(-9000), cliffH);
    const cliffPainted = smoothstep(float(0.01), float(0.03), cliffD);

    // ── Normals ──
    const tNorm = terrainNormalTex
      ? normalize(texture(terrainNormalTex, terrainUV).xyz)
      : (() => {
          const texelSize = float(1).div(float(terrainRes));
          const hL = texture(heightTex, terrainUV.add(vec2(negate(texelSize), float(0)))).x;
          const hR = texture(heightTex, terrainUV.add(vec2(texelSize, float(0)))).x;
          const hD = texture(heightTex, terrainUV.add(vec2(float(0), negate(texelSize)))).x;
          const hU = texture(heightTex, terrainUV.add(vec2(float(0), texelSize))).x;
          const worldStep = uTerrainSize.div(float(terrainRes));
          return normalize(vec3(hL.sub(hR), worldStep.mul(float(2)), hD.sub(hU)));
        })();
    const cNorm = normalize(vec3(cliffSample.y, cliffSample.z, cliffSample.w));

    // ── Surface selection (compile-time: terrain-only or cliff-only) ──
    const finalH = cliffMode ? cliffH : terrainH;
    const terrainNormal = cliffMode ? cNorm : tNorm;

    // ── LOD morph + distance fade ──
    const lodFocusXZ = vec2(uPlayerPos.x, uPlayerPos.z);
    const bladeCamDist = length(bladeXZ.sub(lodFocusXZ));
    const morphToMid = smoothstep(
      uLodMidDist.mul(float(0.6)),
      uLodMidDist,
      bladeCamDist,
    );
    const morphToFar = smoothstep(
      uLodFarDist.mul(float(0.8)),
      uLodFarDist,
      bladeCamDist,
    );
    const lodMorph = uLodEnabled.mul(
      mix(
        morphToMid.mul(float(0.5)),
        float(0.5).add(morphToFar.mul(float(0.5))),
        morphToFar,
      ),
    );
    const farMorph = smoothstep(float(0.5), float(1.0), lodMorph);

    // Per-blade stochastic distance fade — dissolves outer boundary per blade
    const edgeHash = hash22(bladeXZ.add(vec2(317.7, 519.3))).x;
    const edgeScatter = float(10.0);
    const personalMaxDist = uLodMaxDist.sub(edgeHash.mul(edgeScatter));
    const fadeBegin = personalMaxDist.mul(uLodFadeStart);
    const distFadeLinear = smoothstep(personalMaxDist, fadeBegin, bladeCamDist);
    const distFade = distFadeLinear.mul(distFadeLinear);

    // ── Per-blade randomization (4 decorrelated outputs) ──
    const hv = hash42(bladeXZ);
    const h0 = hv.x; // yaw
    const h1 = hv.y; // shade
    const h2 = hv.z; // height scale
    const h3 = hv.w; // lean angle

    // Stochastic density culling (decorrelated hash)
    const densityHv = hash22(bladeXZ.add(vec2(853.1, 137.9)));
    const densityHash = densityHv.x;

    // ── Density (terrain-only or cliff-only, never mixed) ──
    const paintedDensity = cliffMode
      ? cliffD
      : texture(grassDensityTex, terrainUV).x;
    const hasDensity = cliffMode
      ? cliffValid.mul(cliffPainted)
      : smoothstep(float(0.0), float(0.005), paintedDensity);

    let densityCull = smoothstep(
      uGrassDensity.mul(paintedDensity),
      uGrassDensity.mul(paintedDensity).add(float(0.01)),
      densityHash,
    )
      .oneMinus()
      .mul(hasDensity);

    // Fade blades near / past the playable terrain square
    const mapHalf = uTerrainSize.mul(0.5);
    const mapEdgeW = max(float(1.5), uTerrainSize.mul(0.004));
    const outMax = max(abs(bladeXZ.x), abs(bladeXZ.y));
    const mapStay = float(1).sub(
      smoothstep(mapHalf.sub(mapEdgeW), mapHalf.add(float(0.35)), outMax),
    );
    densityCull = densityCull.mul(mapStay);

    // ── Slope rejection — terrain mode only ──
    if (!cliffMode) {
      const slopeGrass = smoothstep(uSlopeMin, uSlopeMax, terrainNormal.y);
      densityCull = densityCull.mul(mix(float(1), slopeGrass, uSlopeEnabled));
    }

    // ── Voronoi clumping ──
    const cellP = bladeXZ.div(uClumpScale);
    const cellID = cellP.floor();
    const cellFrac = fract(cellP);
    const cv = hash42(cellID);
    const cA = cv.x;
    const cB = cv.y;
    const cC = cv.z;
    const cD = cv.w;
    const clumpDist = length(vec2(cA, cB).sub(cellFrac));
    const clumpInfluence = smoothstep(float(0.75), float(0.05), clumpDist)
      .mul(uClumpStrength)
      .mul(float(1).sub(farMorph));

    const randomYaw = mix(h0.mul(PI.mul(2)), cC.mul(PI.mul(2)), clumpInfluence);
    const hScale = mix(float(0.75), float(1.5), h2);
    const clumpHeightScale = mix(float(0.6), float(1.4), cA);
    const naturalLean = mix(
      h3.mul(uNaturalLean),
      cD.mul(uNaturalLean),
      clumpInfluence,
    );
    const bladeH = uBladeHeight.mul(
      mix(hScale, clumpHeightScale, clumpInfluence),
    );

    // Cross ribbon: +90° yaw, collapsed when uCrossed=0
    const crossedYaw = randomYaw.add(aIsCross.mul(PI.mul(0.5)));
    const crossedBladeH = bladeH.mul(mix(float(1.0), uCrossed, aIsCross));
    const finalBladeH = crossedBladeH.mul(distFade).mul(densityCull);

    const clumpShadeV = mix(
      float(1.0),
      mix(float(0.82), float(1.18), cB),
      clumpInfluence,
    );

    // ── Color variation hashes (vertex-side for precision) ──
    const hv2 = hash22(bladeXZ.add(vec2(537.3, 197.1)));
    const h4 = hv2.x;
    const h5 = hv2.y;
    const warmCol = vec3(0.18, 0.28, 0.02);
    const coolCol = vec3(0.02, 0.18, 0.08);
    const tintTarget = mix(warmCol, coolCol, h4);
    const tintRgbV = mix(tintTarget, vec3(1, 1, 1), farMorph);
    const randomShadeV = mix(float(0.75), float(1.0), h1);
    vPackGrass0.assign(vec4(lodMorph, distFade, clumpShadeV, randomShadeV));
    vPackGrass1.assign(vec4(tintRgbV.x, tintRgbV.y, tintRgbV.z, h5));

    // ── Arc bending ──
    const baseStiffness = smoothstep(0.0, uStiffness, vUv.y);
    const curveWeight = vUv.y.pow(uBendFocus).mul(baseStiffness);

    // Wind computation — baked texture path (1 fetch) or fallback (4 mx_noise_float)
    let wave, gustRaw, windMicro, zRollRaw;
    if (useWindTex) {
      // Divide UVs by baked frequency to match original mx_noise_float spatial rate
      // R baked at u*8, G at u*3, B at u*6, A at u*12
      const waveTexUV = vec2(
        bladeWorld.x.mul(uWindWaveScale).add(uWindDirX.mul(tBase)).div(8.0),
        bladeWorld.z.mul(uWindWaveScale).add(uWindDirZ.mul(tBase)).div(8.0),
      );
      const gustTexUV = vec2(
        bladeWorld.x.mul(uWindWaveScale).mul(0.25).add(uWindDirX.mul(tBase).mul(0.3)).div(3.0),
        bladeWorld.z.mul(uWindWaveScale).mul(0.25).add(uWindDirZ.mul(tBase).mul(0.3)).div(3.0),
      );
      const zTexUV = vec2(
        bladeWorld.z.mul(uWindWaveScale).add(uWindDirZ.mul(tBase)).add(17.3).div(6.0),
        bladeWorld.x.mul(uWindWaveScale).sub(uWindDirX.mul(tBase)).add(31.7).div(6.0),
      );
      const microTexUV = vec2(tBlade.mul(4.0).div(12.0), bladeWorld.x.mul(0.07).add(bladeWorld.z.mul(0.11)).div(12.0));
      wave = texture(_windTex, waveTexUV).x.mul(2.0).sub(1.0);
      gustRaw = texture(_windTex, gustTexUV).y.mul(2.0).sub(1.0);
      zRollRaw = texture(_windTex, zTexUV).z.mul(2.0).sub(1.0);
      windMicro = texture(_windTex, microTexUV).w.mul(2.0).sub(1.0).mul(0.15);
    } else {
      const waveUV = vec3(
        bladeWorld.x.mul(uWindWaveScale).add(uWindDirX.mul(tBase)),
        float(0),
        bladeWorld.z.mul(uWindWaveScale).add(uWindDirZ.mul(tBase)),
      );
      wave = mx_noise_float(waveUV);
      const gustUV = vec3(
        bladeWorld.x.mul(uWindWaveScale).mul(float(0.25)).add(uWindDirX.mul(tBase).mul(float(0.3))),
        float(0),
        bladeWorld.z.mul(uWindWaveScale).mul(float(0.25)).add(uWindDirZ.mul(tBase).mul(float(0.3))),
      );
      gustRaw = mx_noise_float(gustUV);
      const zWaveUV = vec3(
        bladeWorld.z.mul(uWindWaveScale).add(uWindDirZ.mul(tBase)).add(float(17.3)),
        float(0),
        bladeWorld.x.mul(uWindWaveScale).sub(uWindDirX.mul(tBase)).add(float(31.7)),
      );
      zRollRaw = mx_noise_float(zWaveUV);
      windMicro = mx_noise_float(tBlade.mul(float(4.0))).mul(float(0.15));
    }

    const gustStr = smoothstep(float(0.5), float(0.9), gustRaw).mul(uWindGust);
    const windBase = wave.add(float(0.4)).add(gustStr);
    const windMicroLod = windMicro.mul(float(1).sub(lodMorph));

    // Room = remaining angle budget after natural lean
    const room = max(float(0), uMaxAngle.sub(naturalLean));
    const windScaled = windBase
      .add(windMicroLod)
      .mul(uWindStrength)
      .mul(room.div(uMaxAngle));
    const totalForce = naturalLean.add(windScaled);
    const angle = totalForce.mul(curveWeight);

    // Arc position
    const L = vUv.y.mul(finalBladeH);
    const arcX = sin(angle).mul(L);
    const arcY = cos(angle).mul(L);

    // Cross-direction sway
    const zRollPhase = zRollRaw.mul(float(0.4)).sub(float(0.2));
    const arcZ = sin(zRollPhase)
      .mul(L)
      .mul(curveWeight)
      .mul(0.2)
      .mul(float(1).sub(lodMorph));

    // ── Spine tangent + cylindrical normals ──
    const ty = vUv.y;
    const eps = float(0.02);
    const tp = min(ty.add(eps), float(1));
    const tm = max(ty.sub(eps), float(0));

    const bsP = smoothstep(0.0, uStiffness, tp);
    const cwP = tp.pow(uBendFocus).mul(bsP);
    const angP = totalForce.mul(cwP);
    const lenP = tp.mul(finalBladeH);
    const sP = vec3(
      sin(angP).mul(lenP),
      cos(angP).mul(lenP),
      sin(zRollPhase).mul(lenP).mul(cwP).mul(0.2),
    );

    const bsM = smoothstep(0.0, uStiffness, tm);
    const cwM = tm.pow(uBendFocus).mul(bsM);
    const angM = totalForce.mul(cwM);
    const lenM = tm.mul(finalBladeH);
    const sM = vec3(
      sin(angM).mul(lenM),
      cos(angM).mul(lenM),
      sin(zRollPhase).mul(lenM).mul(cwM).mul(0.2),
    );

    const T = normalize(sub(sP, sM));
    const gvn = normalize(vec3(float(0), negate(T.z), T.y));

    // Cylindrical normals — fan spread, killed at FAR
    const cylSpread = uCylindrical
      .mul(float(Math.PI * 0.5))
      .mul(float(1).sub(farMorph));
    const nL = normalize(rotY(cylSpread, gvn));
    const nR = normalize(rotY(negate(cylSpread), gvn));
    const fanN = normalize(mix(nL, nR, vUv.x));

    // ── View thickening ──
    const midLocal = vec3(off.x, finalBladeH.mul(float(0.5)), off.z);
    const worldMid = modelWorldMatrix.mul(vec4(midLocal, 1)).xyz;
    const toCamW = normalize(sub(cameraPosition, worldMid));
    const viewL = normalize(
      modelWorldMatrixInverse.mul(vec4(toCamW, float(0))).xyz,
    );
    const lenXZ = length(vec2(viewL.x, viewL.z));
    const faceZ = abs(dot(viewL, vec3(float(0), float(0), float(1))));
    const edgeOn = smoothstep(float(0.12), float(0.55), sub(1, faceZ)).mul(
      smoothstep(float(0.08), float(0.35), lenXZ),
    );
    const yawMax = float(0.55);
    const deltaYaw = uViewThicken
      .mul(edgeOn)
      .mul(yawMax)
      .mul(atan(viewL.x, viewL.z))
      .mul(float(1).sub(farMorph));

    // Compose position — zero out width when density is 0
    const pArc = vec3(
      arcX.add(positionLocal.x.mul(densityCull)),
      arcY,
      arcZ.add(positionLocal.z.mul(densityCull)),
    );
    const pYaw = rotY(crossedYaw, pArc);
    const nYaw = normalize(rotY(crossedYaw, fanN));
    const pOut = rotY(deltaYaw, pYaw);
    const nOut = normalize(rotY(deltaYaw, nYaw));

    // ── Player interaction ──
    const playerXZ = vec2(uPlayerPos.x, uPlayerPos.z);
    const toBlade = bladeXZ.sub(playerXZ);
    const pDist = length(toBlade);
    const distFalloff = mix(
      float(1),
      float(0),
      smoothstep(float(0.5), uInteractionRadius, pDist),
    );
    const pFall = distFalloff.mul(uInteractionEnabled);
    const pAng = negate(mix(float(0), uInteractionStrength, pFall));
    const pTo = normalize(
      vec3(playerXZ.x.sub(bladeXZ.x), float(0), playerXZ.y.sub(bladeXZ.y)).add(
        vec3(0.001, 0, 0.001),
      ),
    );
    const pAx = vec3(pTo.z, float(0), negate(pTo.x));

    // Rodrigues rotation for interaction
    const intAngle = pAng.mul(vUv.y);
    const cI = cos(intAngle),
      sI = sin(intAngle);
    const pDotAx = dot(vec3(pOut.x, pOut.y, pOut.z), pAx);
    const pCrossAx = vec3(
      pAx.y.mul(pOut.z).sub(pAx.z.mul(pOut.y)),
      pAx.z.mul(pOut.x).sub(pAx.x.mul(pOut.z)),
      pAx.x.mul(pOut.y).sub(pAx.y.mul(pOut.x)),
    );
    const pRotated = vec3(
      pOut.x
        .mul(cI)
        .add(pCrossAx.x.mul(sI))
        .add(pAx.x.mul(pDotAx).mul(float(1).sub(cI))),
      pOut.y
        .mul(cI)
        .add(pCrossAx.y.mul(sI))
        .add(pAx.y.mul(pDotAx).mul(float(1).sub(cI))),
      pOut.z
        .mul(cI)
        .add(pCrossAx.z.mul(sI))
        .add(pAx.z.mul(pDotAx).mul(float(1).sub(cI))),
    );
    // Rotate normal too
    const nDotAx = dot(nOut, pAx);
    const nCrossAx = vec3(
      pAx.y.mul(nOut.z).sub(pAx.z.mul(nOut.y)),
      pAx.z.mul(nOut.x).sub(pAx.x.mul(nOut.z)),
      pAx.x.mul(nOut.y).sub(pAx.y.mul(nOut.x)),
    );
    const nRotated = vec3(
      nOut.x
        .mul(cI)
        .add(nCrossAx.x.mul(sI))
        .add(pAx.x.mul(nDotAx).mul(float(1).sub(cI))),
      nOut.y
        .mul(cI)
        .add(nCrossAx.y.mul(sI))
        .add(pAx.y.mul(nDotAx).mul(float(1).sub(cI))),
      nOut.z
        .mul(cI)
        .add(nCrossAx.z.mul(sI))
        .add(pAx.z.mul(nDotAx).mul(float(1).sub(cI))),
    );

    // Sky blend — tilt normals toward terrain normal
    const lodSkyBlend = mix(uSkyBlend, max(uSkyBlend, float(0.7)), lodMorph);
    const nFinal = normalize(mix(nRotated, terrainNormal, lodSkyBlend));
    normalLocal.assign(nFinal);
    vCustomNormal.assign(nFinal);

    // Compensate terrain height for mesh scaleY (used for temporal fade-in)
    const meshScaleY = length(modelWorldMatrix.mul(vec4(float(0), float(1), float(0), float(0))).xyz);
    const compensatedH = finalH.div(max(meshScaleY, float(0.01)));
    return vec3(
      pRotated.x.add(off.x),
      pRotated.y.add(compensatedH),
      pRotated.z.add(off.z),
    );
  })();

  // ════════════════════════════════════════════════════════════
  // COLOR NODE — fragment shader (base color)
  // ════════════════════════════════════════════════════════════
  material.colorNode = Fn(() => {
    const lodMorph = vPackGrass0.x;
    const distFade = vPackGrass0.y;
    const clumpShade = vPackGrass0.z;
    const randomShade = vPackGrass0.w;
    const colorTint = vPackGrass1.xyz;
    const cvH5 = vPackGrass1.w;
    const farMorphFrag = smoothstep(float(0.5), float(1.0), lodMorph);
    const dryBlendBase = smoothstep(uCvDryAmount, float(0), cvH5).mul(
      float(1).sub(farMorphFrag),
    );

    // AO: LOD-modulated (weaker at distance)
    const aoLod = uAoBase.mul(
      mix(float(0.5), float(1.0), smoothstep(float(0.5), float(0.0), lodMorph)),
    );
    const ao = mix(aoLod, float(1.0), pow(vUv.y, uAoPower));
    const baseCol = mix(uBladeCol, uTipCol, vUv.y);

    // ── Color variation ──
    const hueCol = mix(baseCol, colorTint, uCvHueSpread);
    const lum = dot(hueCol, vec3(0.299, 0.587, 0.114));
    const satFactor = float(1.0).sub(cvH5.mul(uCvSatSpread));
    const satCol = mix(vec3(lum, lum, lum), hueCol, satFactor);
    const dryBlend = dryBlendBase.mul(
      float(1.0).sub(vUv.y).mul(float(0.5)).add(float(0.5)),
    );
    const dryCol = mix(satCol, uCvDryCol, dryBlend);
    const variedCol = mix(baseCol, dryCol, uColorVar);

    const procTint = groundColorAtWorldXZ(grassWorldXZ);
    const imgTint = gemTintTexNode.rgb;
    const isImgMode = step(float(1.49), uTerrainTintMode);
    const isProcMode = step(float(0.49), uTerrainTintMode).mul(
      float(1).sub(isImgMode),
    );
    const tintRgb = procTint.mul(isProcMode).add(imgTint.mul(isImgMode));
    const hasMode = isProcMode.add(isImgMode);
    const rootW = mix(float(1), float(1).sub(vUv.y), uTerrainTintRootBias);
    const tintAmt = clamp(
      uTerrainTintStrength.mul(rootW).mul(hasMode),
      float(0),
      float(1),
    );
    // Match terrain hue without multiplicative crush (dark×dark → black).
    const lumB = max(dot(variedCol, vec3(0.299, 0.587, 0.114)), float(0.02));
    const lumT = max(dot(tintRgb, vec3(0.299, 0.587, 0.114)), float(0.1));
    const tintMatched = clamp(
      tintRgb.mul(lumB.div(lumT)),
      float(0),
      float(2.5),
    );
    const tintMixed = mix(tintMatched, tintRgb, float(0.45));
    const tintedVaried = mix(variedCol, tintMixed, tintAmt);

    // Distance fade + clump shade
    const finalCol = tintedVaried.mul(
      vec3(randomShade.mul(clumpShade).mul(ao).mul(distFade)),
    );

    // LOD debug tint
    const dbHigh = vec3(0.2, 1.0, 0.2);
    const dbMid = vec3(1.0, 1.0, 0.2);
    const dbFar = vec3(0.2, 0.4, 1.0);
    const midBlend = smoothstep(float(0.2), float(0.5), lodMorph);
    const farBlend = smoothstep(float(0.6), float(0.9), lodMorph);
    const debugTint = mix(mix(dbHigh, dbMid, midBlend), dbFar, farBlend);
    return mix(finalCol, debugTint, uLodDebug);
  })();

  // ════════════════════════════════════════════════════════════
  // EMISSIVE NODE — SSS + dual specular
  // ════════════════════════════════════════════════════════════
  material.emissiveNode = Fn(() => {
    const lodMorph = vPackGrass0.x;
    const N = normalize(vCustomNormal);
    const viewDir = normalize(sub(cameraPosition, positionLocal));
    const heightPct = vUv.y;

    // Thickness: base thick, tip thin
    const thickness = float(1).sub(heightPct).mul(float(0.7)).add(float(0.3));
    const transmitCol = mix(
      uBssCol,
      uBssCol.mul(vec3(1.3, 1.1, 0.7)),
      float(1).sub(thickness),
    );

    // 3-component SSS
    const backScat = max(dot(negate(uSunDir), N), float(0));
    const frontScat = max(dot(uSunDir, N), float(0));
    const rim = float(1).sub(max(dot(N, viewDir), float(0)));
    const totalSSS = clamp(
      pow(backScat, uBssPower)
        .mul(thickness)
        .add(pow(frontScat, float(1.5)).mul(thickness).mul(uFrontScatter))
        .add(pow(rim, float(3.0)).mul(thickness).mul(uRimSSS)),
      float(0),
      float(1),
    );

    const farFade = smoothstep(float(0.5), float(1.0), lodMorph);
    const sssResult = transmitCol
      .mul(float(0.35))
      .mul(totalSSS)
      .mul(uBssIntensity)
      .mul(float(1).sub(farFade));

    // ── Specular V1: sharp directional highlights ──
    const specDistFade = smoothstep(
      float(10),
      float(2),
      length(sub(cameraPosition, positionLocal)),
    );
    const lodSpecFade = float(1).sub(
      smoothstep(float(0.2), float(0.5), lodMorph),
    );
    const tipFade1 = smoothstep(float(0.5), float(1.0), heightPct);

    const reflV1 = reflect(uSpecV1Dir, N);
    const specDot1 = pow(max(dot(viewDir, reflV1), float(0)), uSpecV1Power);
    const spec1 = uSpecV1Col
      .mul(specDot1)
      .mul(uSpecV1Intensity)
      .mul(specDistFade)
      .mul(tipFade1)
      .mul(lodSpecFade)
      .mul(float(3.0))
      .mul(uSpecV1Enabled);

    // ── Specular V2: noisy textured highlights (baked noise texture) ──
    const worldPos = positionLocal;
    const specNoiseUV = vec2(
      worldPos.x.mul(uSpecV2NoiseScale).mul(0.125),
      worldPos.z.mul(uSpecV2NoiseScale).mul(0.125),
    );
    const specNoiseSamp = texture(specNoiseTex, specNoiseUV);
    const noiseCombined = specNoiseSamp.x
      .add(specNoiseSamp.y)
      .add(specNoiseSamp.z)
      .mul(float(0.333))
      .mul(2.0)
      .sub(1.0);
    const perturbedN = normalize(
      mix(N, vec3(noiseCombined, float(1), noiseCombined), uSpecV2NoiseStr),
    );

    const reflV2 = reflect(uSpecV2Dir, perturbedN);
    const specDot2 = pow(max(dot(viewDir, reflV2), float(0)), uSpecV2Power);
    const tipFade2 = smoothstep(
      float(1).sub(uSpecV2TipBias),
      float(1),
      heightPct,
    );
    const spec2 = uSpecV2Col
      .mul(specDot2)
      .mul(uSpecV2Intensity)
      .mul(specDistFade)
      .mul(tipFade2)
      .mul(lodSpecFade)
      .mul(uSpecV2Enabled);

    return sssResult.add(spec1).add(spec2);
  })();

  return material;
}

/**
 * Lightweight grass material for the MEGA LOD ring — reuses the same ctx uniforms
 * as createGrassMaterial so editor updates apply to both.
 */
export function createGrassMaterialMega(ctx) {
  const {
    heightTex,
    grassDensityTex,
    cliffHeightTex: _cliffHTex,
    cliffDensityTex: _cliffDTex,
    terrainNormalTex: _terrainNormalTexMega,
    terrainRes,
    uTerrainSize,
    uSunDir,
    uBladeHeight,
    uGrassDensity,
    uWindSpeed,
    uWindStrength,
    uBendFocus,
    uCrossed,
    uBladeCol,
    uTipCol,
    uSkyBlend,
    uAoBase,
    uAoPower,
    uLodMaxDist,
    uLodFadeStart,
    uLodDebug,
    uPlayerPos,
    groundColorAtWorldXZ: _groundColorAtWorldXZMega,
    uTerrainTintMode: _uTerrainTintModeMega,
    uTerrainTintStrength: _uTerrainTintStrengthMega,
    uTerrainTintRootBias: _uTerrainTintRootBiasMega,
    gemGrassTintPlaceholderTex: _gemGrassTintPhMega,
    uGemImgTexUVScale: _uGemImgTexUVScaleMega,
    uSlopeEnabled: _uSlopeEnabledMega,
    uSlopeMin: _uSlopeMinMega,
    uSlopeMax: _uSlopeMaxMega,
    cliffMode: _cliffModeMega,
  } = ctx;

  const cliffMode = _cliffModeMega ?? false;
  const groundColorAtWorldXZ =
    _groundColorAtWorldXZMega ?? ((_xz) => vec3(1, 1, 1));
  const uTerrainTintMode = _uTerrainTintModeMega ?? uniform(0);
  const uTerrainTintStrength = _uTerrainTintStrengthMega ?? uniform(0);
  const uTerrainTintRootBias = _uTerrainTintRootBiasMega ?? uniform(0);
  const uGemImgTexUVScale = _uGemImgTexUVScaleMega ?? uniform(1);
  const gemGrassTintPh = _gemGrassTintPhMega ?? _getGrassTintPlaceholderTex();
  const uSlopeEnabled = _uSlopeEnabledMega ?? uniform(0);
  const uSlopeMin = _uSlopeMinMega ?? uniform(0.65);
  const uSlopeMax = _uSlopeMaxMega ?? uniform(0.85);
  const terrainNormalTex = _terrainNormalTexMega ?? null;

  const cliffHTex = _cliffHTex ?? _getDummyCliffHTex();
  const cliffDTex = _cliffDTex ?? _getDummyCliffDTex();

  const vDistFade = varying(float(1), "v_gm_mg_df");
  const vCustomNormal = varying(vec3(0, 1, 0), "v_gm_mg_cn");
  const vRandomShade = varying(float(1), "v_gm_mg_rs");

  const offRootMega = attribute("offset", "vec3");
  const grassWorldXZMega = modelWorldMatrix.mul(
    vec4(offRootMega.x, float(0), offRootMega.z, float(1)),
  ).xz;
  const gemImgTintUvMega = grassWorldXZMega
    .div(uTerrainSize)
    .mul(uGemImgTexUVScale);
  const gemTintTexNodeMega = texture(gemGrassTintPh, gemImgTintUvMega);

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.FrontSide,
    roughness: 0.92,
    metalness: 0,
  });
  material.envMapIntensity = 0;
  material.polygonOffset = true;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
  material.userData._gemTintTexNode = gemTintTexNodeMega;

  const vUv = uv();

  const rotY = (ang, v) => {
    const c = cos(ang),
      s = sin(ang);
    return vec3(
      v.x.mul(c).add(v.z.mul(s)),
      v.y,
      negate(v.x).mul(s).add(v.z.mul(c)),
    );
  };

  material.positionNode = Fn(() => {
    const off = attribute("offset", "vec3");
    const aPhase = attribute("aPhase", "float");
    const aIsCross = attribute("aIsCross", "float");
    const tBase = time.mul(uWindSpeed);
    const tBlade = tBase.add(aPhase);

    const bladeWorld = modelWorldMatrix.mul(
      vec4(off.x, float(0), off.z, float(1)),
    ).xyz;
    const bladeXZ = vec2(bladeWorld.x, bladeWorld.z);

    const terrainUV = add(div(bladeXZ, uTerrainSize), vec2(0.5));
    const terrainH = texture(heightTex, terrainUV).x;

    const cliffSample = texture(cliffHTex, terrainUV);
    const cliffH = cliffSample.x;
    const cliffD = texture(cliffDTex, terrainUV).x;
    const cliffValid = smoothstep(float(-9990), float(-9000), cliffH);
    const cliffPainted = smoothstep(float(0.01), float(0.03), cliffD);

    const tNorm = terrainNormalTex
      ? normalize(texture(terrainNormalTex, terrainUV).xyz)
      : (() => {
          const texelSize = float(1).div(float(terrainRes));
          const hL = texture(heightTex, terrainUV.add(vec2(negate(texelSize), float(0)))).x;
          const hR = texture(heightTex, terrainUV.add(vec2(texelSize, float(0)))).x;
          const hD = texture(heightTex, terrainUV.add(vec2(float(0), negate(texelSize)))).x;
          const hU = texture(heightTex, terrainUV.add(vec2(float(0), texelSize))).x;
          const worldStep = uTerrainSize.div(float(terrainRes));
          return normalize(vec3(hL.sub(hR), worldStep.mul(float(2)), hD.sub(hU)));
        })();
    const cNorm = normalize(vec3(cliffSample.y, cliffSample.z, cliffSample.w));

    const finalH = cliffMode ? cliffH : terrainH;
    const terrainNormal = cliffMode ? cNorm : tNorm;

    const lodFocusXZMega = vec2(uPlayerPos.x, uPlayerPos.z);
    const bladeCamDist = length(bladeXZ.sub(lodFocusXZMega));
    const edgeHash = hash22(bladeXZ.add(vec2(317.7, 519.3))).x;
    const edgeScatter = float(10.0);
    const personalMaxDist = uLodMaxDist.sub(edgeHash.mul(edgeScatter));
    const fadeBegin = personalMaxDist.mul(uLodFadeStart);
    const distFadeLinear = smoothstep(personalMaxDist, fadeBegin, bladeCamDist);
    const distFade = distFadeLinear.mul(distFadeLinear);
    vDistFade.assign(distFade);

    const densityHv = hash22(bladeXZ.add(vec2(853.1, 137.9)));
    const densityHash = densityHv.x;

    const paintedDensity = cliffMode
      ? cliffD
      : texture(grassDensityTex, terrainUV).x;
    const hasDensity = cliffMode
      ? cliffValid.mul(cliffPainted)
      : smoothstep(float(0.0), float(0.005), paintedDensity);

    let densityCull = smoothstep(
      uGrassDensity.mul(paintedDensity),
      uGrassDensity.mul(paintedDensity).add(float(0.01)),
      densityHash,
    )
      .oneMinus()
      .mul(hasDensity);

    const mapHalfM = uTerrainSize.mul(0.5);
    const mapEdgeWM = max(float(1.5), uTerrainSize.mul(0.004));
    const outMaxM = max(abs(bladeXZ.x), abs(bladeXZ.y));
    const mapStayM = float(1).sub(
      smoothstep(mapHalfM.sub(mapEdgeWM), mapHalfM.add(float(0.35)), outMaxM),
    );
    densityCull = densityCull.mul(mapStayM);

    if (!cliffMode) {
      const slopeGrassM = smoothstep(uSlopeMin, uSlopeMax, terrainNormal.y);
      densityCull = densityCull.mul(mix(float(1), slopeGrassM, uSlopeEnabled));
    }

    const hv = hash42(bladeXZ);
    const h0 = hv.x;
    const h1 = hv.y;
    const h2 = hv.z;
    const randomYaw = h0.mul(PI.mul(2));
    const bladeH = uBladeHeight.mul(mix(float(0.82), float(1.08), h2));
    const crossedYaw = randomYaw.add(aIsCross.mul(PI.mul(0.5)));
    const crossedBladeH = bladeH.mul(mix(float(1.0), uCrossed, aIsCross));
    const finalBladeH = crossedBladeH.mul(distFade).mul(densityCull);

    vRandomShade.assign(mix(float(0.78), float(1.0), h1));

    const sway = sin(
      tBlade.add(bladeWorld.x.mul(0.06)).add(bladeWorld.z.mul(0.05)),
    )
      .mul(float(0.2))
      .mul(clamp(uWindStrength, float(0), float(2)));
    const curveWeight = vUv.y.pow(uBendFocus);
    const angle = sway.mul(curveWeight);
    const L = vUv.y.mul(finalBladeH);
    const arcX = sin(angle).mul(L);
    const arcY = cos(angle).mul(L);

    const pLocal = vec3(
      positionLocal.x.mul(densityCull).add(arcX),
      arcY,
      positionLocal.z.mul(densityCull),
    );
    const pYaw = rotY(crossedYaw, pLocal);

    const nUp = vec3(float(0), float(1), float(0));
    const nBlend = normalize(mix(nUp, terrainNormal, uSkyBlend));
    normalLocal.assign(nBlend);
    vCustomNormal.assign(nBlend);

    const meshScaleY = length(modelWorldMatrix.mul(vec4(float(0), float(1), float(0), float(0))).xyz);
    const compensatedH = finalH.div(max(meshScaleY, float(0.01)));
    return vec3(pYaw.x.add(off.x), pYaw.y.add(compensatedH), pYaw.z.add(off.z));
  })();

  material.colorNode = Fn(() => {
    const aoFar = uAoBase.mul(float(0.55));
    const ao = mix(aoFar, float(1.0), pow(vUv.y, uAoPower));
    const baseCol = mix(uBladeCol, uTipCol, vUv.y);
    const procTint = groundColorAtWorldXZ(grassWorldXZMega);
    const imgTint = gemTintTexNodeMega.rgb;
    const isImgModeM = step(float(1.49), uTerrainTintMode);
    const isProcModeM = step(float(0.49), uTerrainTintMode).mul(
      float(1).sub(isImgModeM),
    );
    const tintRgb = procTint.mul(isProcModeM).add(imgTint.mul(isImgModeM));
    const hasMode = isProcModeM.add(isImgModeM);
    const rootW = mix(float(1), float(1).sub(vUv.y), uTerrainTintRootBias);
    const tintAmt = clamp(
      uTerrainTintStrength.mul(rootW).mul(hasMode),
      float(0),
      float(1),
    );
    const lumBm = max(dot(baseCol, vec3(0.299, 0.587, 0.114)), float(0.02));
    const lumTm = max(dot(tintRgb, vec3(0.299, 0.587, 0.114)), float(0.1));
    const tintMatchedM = clamp(
      tintRgb.mul(lumBm.div(lumTm)),
      float(0),
      float(2.5),
    );
    const tintMixedM = mix(tintMatchedM, tintRgb, float(0.45));
    const tintedBase = mix(baseCol, tintMixedM, tintAmt);
    const finalCol = tintedBase.mul(vec3(vRandomShade.mul(ao).mul(vDistFade)));
    const dbMega = vec3(0.85, 0.35, 1.0);
    return mix(finalCol, dbMega, uLodDebug);
  })();

  material.emissiveNode = Fn(() => vec3(float(0), float(0), float(0)))();

  return material;
}

// ─── 4-Tier LOD Streaming (HIGH / MID / FAR / MEGA) ───
// Camera-relative grid, frustum culling, pooling, hysteresis.
// MEGA ring: maxDistance < megaMaxDistance, optional geoMega on geosAndMats.
// Returns { update(charPos) } — call every frame.
//
// options.mapWorldHalf — if set (e.g. worldSize * 0.5 for a centered 1600 map),
// skip grass patch meshes whose footprint does not intersect the playable xz square
// [-half, +half]². Per-blade fade at edges is handled in the shader via uTerrainSize.
export function setupGrassPatches(
  scene,
  camera,
  grassGroup,
  geosAndMats,
  options,
) {
  // Read geos via geosAndMats so updateGeometries() can swap them live
  let geoHigh = geosAndMats.geoHigh;
  let geoMid = geosAndMats.geoMid;
  let geoFar = geosAndMats.geoFar;
  let geoMega = geosAndMats.geoMega;
  const material = geosAndMats.material;
  const materialMega = geosAndMats.materialMega ?? material;
  const {
    patchSize = 10,
    lodMidDistance = 40,
    lodFarDistance = 80,
    maxDistance = 200,
    megaMaxDistance = maxDistance,
    lodHysteresis = 2,
    lodEnabled = true,
    grassReceiveShadow = true,
    grassCastShadow = false,
    patchSizeMid = patchSize,
    patchSizeFar = patchSize,
    patchSizeMega = 60,
    mapWorldHalf: initialMapWorldHalf = null,
    patchHasData = null,
  } = options;

  const poolHigh = { meshes: [], idx: 0 };
  const poolMid = { meshes: [], idx: 0 };
  const poolFar = { meshes: [], idx: 0 };
  const poolMega = { meshes: [], idx: 0 };

  // Temporal fade-in: track when each patch cell first becomes visible
  const _fadeDur = 0.35;
  const _birthMap = new Map();
  const _aliveKeys = new Set();

  // Reusable objects — zero allocation per frame
  const _cellPos = new THREE.Vector3();
  const _camPosXZ = new THREE.Vector3();
  const _aabb = new THREE.Box3();
  const _aabbSize = new THREE.Vector3();
  const _frustum = new THREE.Frustum();
  const _projScreenMatrix = new THREE.Matrix4();

  function getMesh(pool, geo, matOverride) {
    const mat = matOverride ?? material;
    if (pool.idx < pool.meshes.length) {
      const m = pool.meshes[pool.idx++];
      m.material = mat;
      return m;
    }
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    grassGroup.add(m);
    pool.meshes.push(m);
    pool.idx++;
    return m;
  }

  let lastPatchCount = 0;
  let lastHighCount = 0,
    lastMidCount = 0,
    lastFarCount = 0,
    lastMegaCount = 0;

  function patchOverlapsPlayableMap(cellX, cellZ, patchW, mapHalf) {
    if (mapHalf == null || !Number.isFinite(mapHalf)) return true;
    const h = patchW * 0.5;
    const minX = cellX - h;
    const maxX = cellX + h;
    const minZ = cellZ - h;
    const maxZ = cellZ + h;
    return !(
      maxX < -mapHalf ||
      minX > mapHalf ||
      maxZ < -mapHalf ||
      minZ > mapHalf
    );
  }

  function update(opts = {}) {
    const {
      patchSize: ps = patchSize,
      lodMidDistance: midDist = lodMidDistance,
      lodFarDistance: farDist = lodFarDistance,
      maxDistance: maxDist = maxDistance,
      megaMaxDistance: megaMax = megaMaxDistance,
      lodEnabled: useLod = lodEnabled,
      grassReceiveShadow: recvShadow = grassReceiveShadow,
      grassCastShadow: castShadow = grassCastShadow,
      patchSizeMid: psMid = patchSizeMid,
      patchSizeFar: psFar = patchSizeFar,
      patchSizeMega: psMega = patchSizeMega,
    } = opts;

    const mapHalf =
      opts.mapWorldHalf !== undefined ? opts.mapWorldHalf : initialMapWorldHalf;

    const focusX = opts.focusPoint ? opts.focusPoint.x : camera.position.x;
    const focusZ = opts.focusPoint ? opts.focusPoint.z : camera.position.z;

    // Hide all, reset pools
    for (const child of grassGroup.children) child.visible = false;
    poolHigh.idx = 0;
    poolMid.idx = 0;
    poolFar.idx = 0;
    poolMega.idx = 0;

    // Frustum
    _projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    _frustum.setFromProjectionMatrix(_projScreenMatrix);

    _camPosXZ.set(focusX, 0, focusZ);

    const _now = performance.now() * 0.001;
    _aliveKeys.clear();

    let patchCount = 0;
    let highCount = 0,
      midCount = 0,
      farCount = 0,
      megaCount = 0;

    // ── HIGH tier grid (spacing = ps) — world-aligned ──
    const highMaxEdge = useLod ? midDist + lodHysteresis : maxDist;
    {
      const camX = focusX;
      const camZ = focusZ;
      const minCellX = Math.floor((camX - highMaxEdge) / ps) * ps;
      const maxCellX = Math.floor((camX + highMaxEdge) / ps) * ps;
      const minCellZ = Math.floor((camZ - highMaxEdge) / ps) * ps;
      const maxCellZ = Math.floor((camZ + highMaxEdge) / ps) * ps;
      _aabbSize.set(ps, 1000, ps);

      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += ps) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += ps) {
          _cellPos.set(cellX, 0, cellZ);
          _aabb.setFromCenterAndSize(_cellPos, _aabbSize);
          const dist = _aabb.distanceToPoint(_camPosXZ);
          if (dist > highMaxEdge) continue;
          if (!_frustum.intersectsBox(_aabb)) continue;
          if (!patchOverlapsPlayableMap(cellX, cellZ, ps, mapHalf)) continue;
          if (patchHasData && !patchHasData(cellX - ps * 0.5, cellX + ps * 0.5, cellZ - ps * 0.5, cellZ + ps * 0.5)) continue;

          const _pk = `H${cellX},${cellZ}`;
          _aliveKeys.add(_pk);
          if (!_birthMap.has(_pk)) _birthMap.set(_pk, _now);
          const _fi = Math.min((_now - _birthMap.get(_pk)) / _fadeDur, 1.0);

          const mesh = getMesh(poolHigh, geoHigh);
          mesh.geometry = geoHigh;
          mesh.visible = true;
          mesh.position.set(cellX, 0, cellZ);
          mesh.scale.set(1, Math.max(_fi, 0.01), 1);
          mesh.receiveShadow = recvShadow;
          mesh.castShadow = castShadow;
          highCount++;
          patchCount++;
        }
      }
    }

    // ── MID tier grid (spacing = psMid) — world-aligned ──
    // Skip cells whose farthest corner is inside HIGH zone (fully covered).
    const midMaxEdge = farDist + lodHysteresis;
    if (useLod) {
      const camX = focusX;
      const camZ = focusZ;
      const minCellX = Math.floor((camX - midMaxEdge - psMid) / psMid) * psMid;
      const maxCellX = Math.floor((camX + midMaxEdge + psMid) / psMid) * psMid;
      const minCellZ = Math.floor((camZ - midMaxEdge - psMid) / psMid) * psMid;
      const maxCellZ = Math.floor((camZ + midMaxEdge + psMid) / psMid) * psMid;
      _aabbSize.set(psMid, 1000, psMid);
      const halfMid = psMid * 0.5;

      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += psMid) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += psMid) {
          _cellPos.set(cellX, 0, cellZ);
          _aabb.setFromCenterAndSize(_cellPos, _aabbSize);
          const dist = _aabb.distanceToPoint(_camPosXZ);
          if (dist > midMaxEdge) continue;
          // Skip if the farthest corner of this cell is still inside HIGH zone
          const farthestCornerDist = Math.sqrt(
            Math.pow(
              Math.max(Math.abs(cellX - focusX) + halfMid, 0),
              2,
            ) +
              Math.pow(
                Math.max(Math.abs(cellZ - focusZ) + halfMid, 0),
                2,
              ),
          );
          if (farthestCornerDist < midDist - lodHysteresis) continue;
          if (!_frustum.intersectsBox(_aabb)) continue;
          if (!patchOverlapsPlayableMap(cellX, cellZ, psMid, mapHalf)) continue;
          if (patchHasData && !patchHasData(cellX - psMid * 0.5, cellX + psMid * 0.5, cellZ - psMid * 0.5, cellZ + psMid * 0.5)) continue;

          const _pk = `M${cellX},${cellZ}`;
          _aliveKeys.add(_pk);
          if (!_birthMap.has(_pk)) _birthMap.set(_pk, _now);
          const _fi = Math.min((_now - _birthMap.get(_pk)) / _fadeDur, 1.0);

          const mesh = getMesh(poolMid, geoMid);
          mesh.geometry = geoMid;
          mesh.visible = true;
          mesh.position.set(cellX, 0, cellZ);
          mesh.scale.set(1, Math.max(_fi, 0.01), 1);
          mesh.receiveShadow = recvShadow;
          mesh.castShadow = castShadow;
          midCount++;
          patchCount++;
        }
      }
    }

    // ── FAR tier grid (spacing = psFar) — world-aligned ──
    if (useLod) {
      const camX = focusX;
      const camZ = focusZ;
      const minCellX = Math.floor((camX - maxDist - psFar) / psFar) * psFar;
      const maxCellX = Math.floor((camX + maxDist + psFar) / psFar) * psFar;
      const minCellZ = Math.floor((camZ - maxDist - psFar) / psFar) * psFar;
      const maxCellZ = Math.floor((camZ + maxDist + psFar) / psFar) * psFar;
      _aabbSize.set(psFar, 1000, psFar);
      const halfFar = psFar * 0.5;

      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += psFar) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += psFar) {
          _cellPos.set(cellX, 0, cellZ);
          _aabb.setFromCenterAndSize(_cellPos, _aabbSize);
          const dist = _aabb.distanceToPoint(_camPosXZ);
          if (dist > maxDist) continue;
          // Skip if the farthest corner is still inside MID zone
          const farthestCornerDist = Math.sqrt(
            Math.pow(
              Math.max(Math.abs(cellX - focusX) + halfFar, 0),
              2,
            ) +
              Math.pow(
                Math.max(Math.abs(cellZ - focusZ) + halfFar, 0),
                2,
              ),
          );
          if (farthestCornerDist < farDist - lodHysteresis) continue;
          if (!_frustum.intersectsBox(_aabb)) continue;
          if (!patchOverlapsPlayableMap(cellX, cellZ, psFar, mapHalf)) continue;
          if (patchHasData && !patchHasData(cellX - psFar * 0.5, cellX + psFar * 0.5, cellZ - psFar * 0.5, cellZ + psFar * 0.5)) continue;

          const _pk = `F${cellX},${cellZ}`;
          _aliveKeys.add(_pk);
          if (!_birthMap.has(_pk)) _birthMap.set(_pk, _now);
          const _fi = Math.min((_now - _birthMap.get(_pk)) / _fadeDur, 1.0);

          const mesh = getMesh(poolFar, geoFar, materialMega);
          mesh.geometry = geoFar;
          mesh.material = materialMega;
          mesh.visible = true;
          mesh.position.set(cellX, 0, cellZ);
          mesh.scale.set(1, Math.max(_fi, 0.01), 1);
          mesh.receiveShadow = false;
          mesh.castShadow = castShadow;
          farCount++;
          patchCount++;
        }
      }
    }

    // ── MEGA tier grid (spacing = psMega) — world-aligned, beyond FAR until megaMax ──
    if (useLod && geoMega && megaMax > maxDist) {
      const camX = focusX;
      const camZ = focusZ;
      const minCellX = Math.floor((camX - megaMax - psMega) / psMega) * psMega;
      const maxCellX = Math.floor((camX + megaMax + psMega) / psMega) * psMega;
      const minCellZ = Math.floor((camZ - megaMax - psMega) / psMega) * psMega;
      const maxCellZ = Math.floor((camZ + megaMax + psMega) / psMega) * psMega;
      _aabbSize.set(psMega, 1000, psMega);
      const halfMega = psMega * 0.5;

      for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ += psMega) {
        for (let cellX = minCellX; cellX <= maxCellX; cellX += psMega) {
          _cellPos.set(cellX, 0, cellZ);
          _aabb.setFromCenterAndSize(_cellPos, _aabbSize);
          const dist = _aabb.distanceToPoint(_camPosXZ);
          if (dist > megaMax) continue;
          const farthestCornerDist = Math.sqrt(
            Math.pow(
              Math.max(Math.abs(cellX - focusX) + halfMega, 0),
              2,
            ) +
              Math.pow(
                Math.max(Math.abs(cellZ - focusZ) + halfMega, 0),
                2,
              ),
          );
          if (farthestCornerDist < maxDist - lodHysteresis) continue;
          if (!_frustum.intersectsBox(_aabb)) continue;
          if (!patchOverlapsPlayableMap(cellX, cellZ, psMega, mapHalf))
            continue;
          if (patchHasData && !patchHasData(cellX - psMega * 0.5, cellX + psMega * 0.5, cellZ - psMega * 0.5, cellZ + psMega * 0.5)) continue;

          const _pk = `G${cellX},${cellZ}`;
          _aliveKeys.add(_pk);
          if (!_birthMap.has(_pk)) _birthMap.set(_pk, _now);
          const _fi = Math.min((_now - _birthMap.get(_pk)) / _fadeDur, 1.0);

          const mesh = getMesh(poolMega, geoMega, materialMega);
          mesh.geometry = geoMega;
          mesh.material = materialMega;
          mesh.visible = true;
          mesh.position.set(cellX, 0, cellZ);
          mesh.scale.set(1, Math.max(_fi, 0.01), 1);
          mesh.receiveShadow = false;
          mesh.castShadow = castShadow;
          megaCount++;
          patchCount++;
        }
      }
    }

    // Purge birth times for patches no longer visible
    for (const k of _birthMap.keys()) {
      if (!_aliveKeys.has(k)) _birthMap.delete(k);
    }

    lastPatchCount = patchCount;
    lastHighCount = highCount;
    lastMidCount = midCount;
    lastFarCount = farCount;
    lastMegaCount = megaCount;

    return { patchCount, highCount, midCount, farCount, megaCount };
  }

  // Allow updating geometries after rebuild
  function updateGeometries(newGeos) {
    if (newGeos.geoHigh) {
      geoHigh = newGeos.geoHigh;
      poolHigh.meshes.forEach((m) => {
        m.geometry = newGeos.geoHigh;
      });
      geosAndMats.geoHigh = newGeos.geoHigh;
    }
    if (newGeos.geoMid) {
      geoMid = newGeos.geoMid;
      poolMid.meshes.forEach((m) => {
        m.geometry = newGeos.geoMid;
      });
      geosAndMats.geoMid = newGeos.geoMid;
    }
    if (newGeos.geoFar) {
      geoFar = newGeos.geoFar;
      poolFar.meshes.forEach((m) => {
        m.geometry = newGeos.geoFar;
      });
      geosAndMats.geoFar = newGeos.geoFar;
    }
    if (newGeos.geoMega) {
      geoMega = newGeos.geoMega;
      poolMega.meshes.forEach((m) => {
        m.geometry = newGeos.geoMega;
      });
      geosAndMats.geoMega = newGeos.geoMega;
    }
  }

  return { update, updateGeometries };
}
