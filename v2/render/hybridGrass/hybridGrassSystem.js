/**
 * Hybrid grass — Revo skeleton (camera-following wrap tile + compute SSBO +
 * indirect-draw compaction, tiny vertex shader) wearing the Gemini skin
 * (crossed ribbons, arc bend, world-space Voronoi clumps, hue/sat/dry color
 * variation, AO gradient, terrain tint, SSS — manual lighting, no PBR).
 *
 * Per-blade work happens ONCE per blade in the compute pass (height, density,
 * clump, wind, culls, atomic compaction append); culled blades cost zero
 * vertex work. Gemini recomputes all per-blade work per VERTEX (15×/blade).
 * Proven in grass-lab.html: ~3× cheaper GPU at look parity, 6 draws vs ~400.
 * Instantiate as concentric rings (near/mid/far) — see grass-lab.html or
 * main.js for the ring parameters.
 */
import * as THREE from "three";
import {
  Fn,
  If,
  abs,
  atan,
  atomicAdd,
  atomicStore,
  attribute,
  clamp,
  cos,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedArray,
  storage,
  uint,
  length,
  log2,
  max,
  mix,
  normalize,
  pow,
  reflect,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  dot,
  negate,
  positionLocal,
  normalLocal,
  cameraPosition,
  PI2,
} from "three/tsl";
import { hash42 } from "../../core/foliage/tsl-utils.js";
import { createBladeGeometry } from "../../core/foliage/grassGemini.js";
import { wrapTileOffsetXZ } from "../../core/revoGrass/revoGrassTile.js";
import { computeFrustumVisibility } from "../../core/revoGrass/revoGrassSsboUtils.js";
import { grassTintBlend, grassFieldAlbedo } from "./grassFieldColor.js";

/**
 * Map the Gemini LOD sliders (lodMidDistance/lodFarDistance/lodMaxDistance/
 * lodMegaMaxDistance) onto the hybrid rings' radial windows — live, no
 * rebuild (the windows are uniforms). Scale factors reproduce the proven
 * default ring table at the default slider values (40/80/200/400).
 * Radii are capped just inside each ring's tile half-size.
 */
export function syncHybridGrassLod(rings, gp) {
  const mid = gp.lodMidDistance ?? 40;
  const far = gp.lodFarDistance ?? 80;
  const max = gp.lodMaxDistance ?? 200;
  const mega = gp.lodMegaMaxDistance ?? 400;
  for (const r of rings) {
    const u = r.u;
    const cap = r.tileSize * 0.5 - 2;
    const c = (v) => Math.min(v, cap);
    const inWin = (r0, r1) => {
      u.uInnerR0.value = c(r0);
      u.uInnerR1.value = Math.max(c(r1), c(r0) + 0.001);
    };
    const outWin = (r0, r1) => {
      u.uOuterR0.value = c(r0);
      u.uOuterR1.value = Math.max(c(r1), c(r0) + 0.001);
    };
    switch (r.group.name) {
      case "HybridNear":
      case "HybridCliffNear":
        outWin(mid * 0.9, mid * 1.55);
        break;
      case "HybridMidThin":
        inWin(mid * 0.9, mid * 1.4);
        outWin(far * 0.875, far * 1.1);
        break;
      case "HybridMid":
      case "HybridCliffMid":
        inWin(far * 0.8, far * 1.1);
        outWin(max * 0.9, max * 1.09);
        break;
      case "HybridFar":
        inWin(max * 0.875, max * 1.075);
        outWin(mega * 0.9, mega * 0.995);
        break;
    }
  }
  return syncHybridGrassHandoff(rings, gp);
}

/**
 * Hand-over from blades to the ground colour (Ghost of Tsushima's far LOD:
 * past the last ring the terrain carries the grass). The LAST ring — Far, or
 * Mid when `gp.farBlades` is false — shrinks its blades across its outer band,
 * and the far rings converge their colour to the field colour before it.
 *
 * @returns {{ convStart:number, convEnd:number, fadeStart:number, fadeEnd:number }}
 *   fadeStart..fadeEnd is where the ground takes over — hand it to the terrain.
 */
export function syncHybridGrassHandoff(rings, gp) {
  const farOn = gp.farBlades !== false;
  const isFar = (r) => r.group.name.endsWith("Far");
  const isMid = (r) => r.group.name.endsWith("Mid");
  const last = rings.find(farOn ? isFar : isMid) ?? rings[rings.length - 1];
  const fadeStart = last.u.uOuterR0.value;
  const fadeEnd = last.u.uOuterR1.value;
  const convEnd = fadeStart;
  const convStart = farOn
    ? (gp.lodMaxDistance ?? 200) * 0.9
    : (gp.lodFarDistance ?? 80);
  for (const r of rings) {
    r.u.uEdgeShrink.value = r === last ? 1 : 0;
    r.u.uConvStart.value = Math.min(convStart, convEnd - 1);
    r.u.uConvEnd.value = convEnd;
  }
  return { convStart, convEnd, fadeStart, fadeEnd };
}

/**
 * Rebuild blade geometry on all rings from the Gemini editor sliders —
 * geometry-baked params (bladeWidth, segments, tipTaperStart) can't be
 * uniforms. Mirrors Gemini's per-tier slider mapping: near/midThin use the
 * main blade params, mid uses lodFar*, far uses lodMega*. Call from the
 * grassRebuildGeos editor callback, same as GrassManager.rebuildGeometries.
 */
export function rebuildHybridGrassGeometries(rings, gp) {
  for (const ring of rings) {
    const n = ring.group.name;
    if (n === "HybridNear" || n === "HybridCliffNear") {
      ring.rebuildGeometry({
        bladeWidth: gp.bladeWidth,
        segments: gp.bladeYSegments,
        taperStart: gp.tipTaperStart,
        crossed: gp.crossed !== false,
      });
    } else if (n === "HybridMidThin") {
      ring.rebuildGeometry({
        bladeWidth: gp.bladeWidth,
        segments: gp.lodMidSegments,
        taperStart: gp.tipTaperStart,
        crossed: gp.crossed !== false,
      });
    } else if (n === "HybridMid" || n === "HybridCliffMid") {
      ring.rebuildGeometry({
        bladeWidth: gp.lodFarBladeWidth ?? gp.bladeWidth,
        segments: gp.lodFarSegments,
        taperStart: gp.tipTaperStart,
      });
    } else if (n === "HybridFar") {
      ring.rebuildGeometry({
        bladeWidth: gp.lodMegaBladeWidth ?? gp.bladeWidth,
        segments: gp.lodMegaSegments,
        taperStart: gp.tipTaperStart,
      });
    }
  }
}

function srgb(hex) {
  // ColorManagement already converts sRGB hex → linear working space in the
  // constructor; adding convertSRGBToLinear() here would gamma twice and
  // crush dark greens to near-black (matches Gemini's plain .set(hex)).
  return new THREE.Color(hex);
}

/** lodDebug tints per ring — Gemini's tier convention (HIGH green, MID
 *  yellow, FAR blue, MEGA purple) + distinct colors for the cliff rings. */
const LOD_DEBUG_TINTS = {
  HybridNear: [0.2, 1.0, 0.2],
  HybridMidThin: [1.0, 1.0, 0.2],
  HybridMid: [0.2, 0.4, 1.0],
  HybridFar: [0.85, 0.35, 1.0],
  HybridCliffNear: [1.0, 0.5, 0.15],
  HybridCliffMid: [0.15, 0.9, 0.9],
};

/**
 * Gemini-style crossed blade: the ribbon duplicated with aCross = 1; the VS
 * rotates the second copy +90° around the spine. With FrontSide culling this
 * is exactly Gemini's look (their aIsCross instance flag, folded into the
 * geometry so instance count stays 1× per blade).
 */
function createCrossedBladeGeometry(height, width, segs, taper, includeCross = true) {
  const base = createBladeGeometry(height, width, segs, taper);
  if (!includeCross) {
    // Single ribbon (Gemini FAR/MEGA tiers) — aCross attr still required
    const n0 = base.attributes.position.count;
    base.setAttribute(
      "aCross",
      new THREE.BufferAttribute(new Float32Array(n0), 1),
    );
    return base;
  }
  const srcPos = base.attributes.position.array;
  const srcUv = base.attributes.uv.array;
  const srcNorm = base.attributes.normal.array;
  const srcIdx = base.index.array;
  const n = base.attributes.position.count;

  const positions = new Float32Array(n * 2 * 3);
  positions.set(srcPos, 0);
  positions.set(srcPos, n * 3);
  const uvs = new Float32Array(n * 2 * 2);
  uvs.set(srcUv, 0);
  uvs.set(srcUv, n * 2);
  // Normals MUST be copied — a missing normal attribute binds zeros and the
  // standard material lights the ribbon with garbage (near-black blades that
  // shift while orbiting; the single-ribbon path never had this bug because
  // createBladeGeometry's computeVertexNormals survives untouched).
  const normals = new Float32Array(n * 2 * 3);
  normals.set(srcNorm, 0);
  normals.set(srcNorm, n * 3);
  const aCross = new Float32Array(n * 2);
  aCross.fill(1, n);
  const indices = new Uint16Array(srcIdx.length * 2);
  indices.set(srcIdx, 0);
  for (let i = 0; i < srcIdx.length; i++) {
    indices[srcIdx.length + i] = srcIdx[i] + n;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("aCross", new THREE.BufferAttribute(aCross, 1));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  base.dispose();
  return geo;
}

export class HybridGrassSystem {
  /**
   * @param {object} opts
   *   scene, renderer       — three
   *   heightTex             — RGBA float, .x = terrain height (v2 uv convention)
   *   terrainNormalTex      — RGBA float, .xyz = terrain normal
   *   densityTex            — painted grass density (.x)
   *   windTex               — v2 createWindTexture() output
   *   worldSize             — terrain world size
   *   gp                    — grassState (v2 toolState.grass shape)
   *   tileSize, bladesPerSide — tile config (default 130 / 512 ≈ 262k)
   *   Ring options (lets one class serve as near tile / mid shell / far shell):
   *   bladeWidth, segments, bladeHeightMul — geometry overrides
   *   innerR0..innerR1      — density ramps IN over this radial band (shells)
   *   outerR0..outerR1      — density ramps OUT to pMin over this band
   *   pMin                  — residual keep probability past outerR1
   */
  constructor({
    scene,
    renderer,
    heightTex,
    terrainNormalTex,
    densityTex,
    windTex,
    worldSize,
    gp,
    tileSize = 130,
    bladesPerSide = 512,
    bladeWidth = null,
    segments = null,
    bladeHeightMul = 1,
    innerR0 = 0,
    innerR1 = 0,
    outerR0 = null,
    outerR1 = null,
    pMin = 0,
    name = "HybridGrass",
    // Lighting normal is ALWAYS flat (Gemini-observed). normalMode only
    // selects the EMISSIVE (SSS/spec) normal:
    // "blade" = per-blade yawed normals → backlit tip speckles (near rings);
    // "flat"  = same as lighting (mid/far rings, Gemini mega has no emissive).
    normalMode = "blade",
    crossed = true, // cross ribbon — near rings only, like Gemini HIGH/MID
    crossFadeR0 = 40, // cross ribbon fades out over this radial band
    crossFadeR1 = 62,
    groundColorAtWorldXZ = null, // TSL fn (xz)=>vec3 — terrain tint "proc" mode
    tintTex = null, //              texture — terrain tint "img" mode
    specNoiseTex = null, //         texture — spec V2 noisy highlights
    cliffMode = false, //           sample cliff surface instead of terrain
    cliffHeightTex = null, //       RGBA float: .x cliff Y (-9999 invalid), .yzw normal
    cliffDensityTex = null, //      painted cliff grass density (.x)
    // Optional terrain self-shadow hooks from v3 (render/lighting/terrainSunShadow.js):
    // { shade(colorNode, vis), visibilityHere() }. Absent in v2 — nothing changes.
    terrainShadow = null,
    // Optional: stand blades on the terrain MESH instead of the exact heightmap.
    // { centerXZ: Vector2 (the clipmap's live centre), baseStep, levels, halfCells }.
    // A clipmap only approximates the heightmap — its vertices sit on texel
    // corners and its outer rings use 2-16 m quads — so exact-heightmap blades
    // float over crests and sink into dips (MEASURED up to +1.5 m / -5.1 m).
    // Requires heightTex at heightmap resolution. Absent = exact heightmap.
    terrainSurface = null,
    // Optional painted blade height (RGBA8, .r / 128 = height multiplier,
    // 128 = 1×). Terrain rings only. Absent = no extra texture read.
    bladeHeightTex = null,
    // Optional push field (Ghost of Tsushima's displacement buffer):
    // { textureNode, center: Vector2 (live), worldSize } — rg = push XZ.
    // Near rings only. Absent = only the one-point player push below.
    pushField = null,
  }) {
    this.renderer = renderer;
    this._terrainShadow = terrainShadow;
    this._terrainSurface = terrainSurface;
    this._bladeHeightTex = bladeHeightTex;
    this._pushField = pushField;
    this.group = new THREE.Group();
    this.group.name = name;
    scene.add(this.group);

    this.count = bladesPerSide * bladesPerSide;
    this.tileSize = tileSize;
    this.bladesPerSide = bladesPerSide;

    const windRad = ((gp.windAngle ?? 0) * Math.PI) / 180;
    const u = (this.u = {
      uAnchorPos: uniform(new THREE.Vector3()),
      uAnchorDeltaXZ: uniform(new THREE.Vector2()),
      uTileSize: uniform(tileSize),
      uTerrainSize: uniform(worldSize),
      uCameraMatrix: uniform(new THREE.Matrix4()),
      uFx: uniform(1),
      uFy: uniform(1),
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
      // blade / bend
      uBladeHeight: uniform((gp.bladeHeight ?? 1) * bladeHeightMul),
      uBendFocus: uniform(gp.bendFocus ?? 0.5),
      uStiffness: uniform(gp.stiffness ?? 0),
      uLodDebug: uniform(gp.lodDebug ? 1 : 0),
      uMaxAngle: uniform(gp.maxAngle ?? 1.4),
      uNaturalLean: uniform(gp.naturalLean ?? 0.9),
      // wind
      uWindSpeed: uniform(gp.windSpeed ?? 0.2),
      uWindStrength: uniform(gp.windStrength ?? 1.4),
      uWindGust: uniform(gp.windGust ?? 0.3),
      uWindWaveScale: uniform(gp.windWaveScale ?? 0.12),
      uWindDir: uniform(
        new THREE.Vector2(Math.cos(windRad), Math.sin(windRad)),
      ),
      // clump
      uClumpScale: uniform(gp.clumpScale ?? 1.5),
      uClumpStrength: uniform(gp.clumpStrength ?? 0.7),
      uClumpPull: uniform(gp.clumpPull ?? 0),
      // density / culls — radial ring window [innerR0..innerR1 ramp in,
      // outerR0..outerR1 ramp out to pMin]
      uGrassDensity: uniform(gp.grassDensity ?? 1),
      uInnerR0: uniform(innerR0),
      uInnerR1: uniform(Math.max(innerR1, innerR0 + 0.001)),
      uOuterR0: uniform(outerR0 ?? tileSize * 0.28),
      uOuterR1: uniform(outerR1 ?? tileSize * 0.5),
      uPMin: uniform(pMin),
      // Hand-over to the ground (see grassFieldColor.js). Far rings converge
      // their colour to the field colour across [uConvStart..uConvEnd]; the
      // LAST ring also shrinks its blades across its outer band (uEdgeShrink).
      // Defaults leave the look untouched.
      uConvStart: uniform(1e6),
      uConvEnd: uniform(1e6 + 1),
      uEdgeShrink: uniform(0),
      uCullPadNdcX: uniform(0.1),
      uCullPadNdcYNear: uniform(0.75),
      uCullPadNdcYFar: uniform(0.2),
      // color
      uBladeCol: uniform(srgb(gp.bladeColor ?? "#0e300e")),
      uTipCol: uniform(srgb(gp.tipColor ?? "#004d05")),
      uAoBase: uniform(gp.aoBase ?? 0.25),
      uAoPower: uniform(gp.aoPower ?? 2),
      uFarAoMul: uniform(gp.farAoMul ?? 0.55),
      uColorVar: uniform(gp.colorVariation ? 1 : 0),
      uCvHueSpread: uniform(gp.cvHueSpread ?? 0.08),
      uCvSatSpread: uniform(gp.cvSatSpread ?? 0.3),
      uCvDryAmount: uniform(gp.cvDryAmount ?? 0.15),
      uCvDryCol: uniform(srgb(gp.cvDryColor ?? "#8a7a3a")),
      uSkyBlend: uniform(gp.skyBlend ?? 0.8),
      uCylindrical: uniform(gp.cylindrical ?? 0.3),
      uViewThicken: uniform(gp.viewThicken ?? 0.45),
      uFoldBelow: uniform(gp.foldBelow ?? 0),
      uCameraPos: uniform(new THREE.Vector3()),
      // SSS (emissive — lighting itself comes from the standard pipeline)
      uBssCol: uniform(srgb(gp.bssColor ?? "#2d7a2d")),
      uBssIntensity: uniform(gp.bssIntensity ?? 1.2),
      uBssPower: uniform(gp.bssPower ?? 2),
      uFrontScatter: uniform(gp.frontScatter ?? 0.3),
      uRimSSS: uniform(gp.rimSSS ?? 0.25),
      // slope rejection (terrain normal .y window, like Gemini)
      uSlopeEnabled: uniform(gp.slopeEnabled ? 1 : 0),
      uSlopeMin: uniform(gp.slopeMin ?? 0.65),
      uSlopeMax: uniform(gp.slopeMax ?? 0.85),
      // terrain tint (Gemini: 0 off / 1 proc / 2 img)
      uTerrainTintMode: uniform(0),
      uTerrainTintStrength: uniform(gp.terrainTintStrength ?? 0.5),
      uTerrainTintRootBias: uniform(gp.terrainTintRootBias ?? 0.35),
      // dual specular (Gemini emissive)
      uSpecV1Enabled: uniform(gp.specV1Enabled ? 1 : 0),
      uSpecV1Intensity: uniform(gp.specV1Intensity ?? 1.5),
      uSpecV1Col: uniform(srgb(gp.specV1Color ?? "#ffffff")),
      uSpecV1Dir: uniform(
        new THREE.Vector3(
          gp.specV1DirX ?? -1,
          gp.specV1DirY ?? 1,
          gp.specV1DirZ ?? 0.5,
        ).normalize(),
      ),
      uSpecV1Power: uniform(gp.specV1Power ?? 25.6),
      uSpecV2Enabled: uniform(gp.specV2Enabled ? 1 : 0),
      uSpecV2Intensity: uniform(gp.specV2Intensity ?? 1),
      uSpecV2Col: uniform(srgb(gp.specV2Color ?? "#ffffff")),
      uSpecV2Dir: uniform(
        new THREE.Vector3(
          gp.specV2DirX ?? -1,
          gp.specV2DirY ?? 0.45,
          gp.specV2DirZ ?? 1,
        ).normalize(),
      ),
      uSpecV2NoiseScale: uniform(gp.specV2NoiseScale ?? 3),
      uSpecV2NoiseStr: uniform(gp.specV2NoiseStr ?? 0.6),
      uSpecV2Power: uniform(gp.specV2Power ?? 12),
      uSpecV2TipBias: uniform(gp.specV2TipBias ?? 0.5),
      // interaction — mode 0 = agitation (bend along own yaw),
      //               mode 1 = radial parting (Gemini Rodrigues feel)
      uPlayerPos: uniform(new THREE.Vector3()),
      uInteractionRadius: uniform(gp.interactionRadius ?? 1.5),
      uInteractionStrength: uniform(gp.interactionStrength ?? 0.7),
      uInteractionMode: uniform(gp.interactionMode ?? 0),
      uTrailStrength: uniform(gp.trailStrength ?? 1),
    });
    this._bladeHeightMul = bladeHeightMul;
    this._groundColorAtWorldXZ = groundColorAtWorldXZ ?? ((_xz) => vec3(1, 1, 1));
    if (!tintTex) {
      const d = new Uint8Array([255, 255, 255, 255]);
      tintTex = new THREE.DataTexture(d, 1, 1, THREE.RGBAFormat);
      tintTex.needsUpdate = true;
    }
    this._tintTex = tintTex;
    if (!specNoiseTex) {
      const d = new Float32Array([0.5, 0.5, 0.5, 1]);
      specNoiseTex = new THREE.DataTexture(
        d,
        1,
        1,
        THREE.RGBAFormat,
        THREE.FloatType,
      );
      specNoiseTex.wrapS = specNoiseTex.wrapT = THREE.RepeatWrapping;
      specNoiseTex.needsUpdate = true;
    }
    this._specNoiseTex = specNoiseTex;
    this._cliffMode = !!cliffMode && !!cliffHeightTex && !!cliffDensityTex;
    this._cliffHeightTex = cliffHeightTex;
    this._cliffDensityTex = cliffDensityTex;
    this._normalMode = normalMode;
    this._crossed = crossed;
    this._crossFadeR0 = crossFadeR0;
    this._crossFadeR1 = crossFadeR1;

    // ── Geometry (needed before compaction buffers for indexCount) ──
    this._bladeWidth = bladeWidth ?? gp.bladeWidth ?? 0.15;
    this._segments = Math.max(1, Math.round(segments ?? gp.bladeYSegments ?? 7));
    this._taperStart = gp.tipTaperStart ?? 0.5;
    const geom = createCrossedBladeGeometry(
      1.0, // unit height — bladeH from SSBO scales it
      this._bladeWidth,
      this._segments,
      this._taperStart,
      crossed,
    );

    // ── SSBOs ──
    // bufPos: x,y = tile-local offset (wraps with anchor), z = bendAng, w free
    // bufA:   x = visibility, y = bend force (lean+wind), z = zRoll, w = terrainY
    // bufB:   x = bladeH, y = yaw, z = clumpShade, w = shadeRand
    // bufC:   x,y = clump pull offset XZ, z = terrainNx, w = terrainNz
    const bufPos = instancedArray(this.count, "vec4");
    const bufA = instancedArray(this.count, "vec4");
    const bufB = instancedArray(this.count, "vec4");
    const bufC = instancedArray(this.count, "vec4");

    // ── Compaction: visible blade ids + GPU-written indirect draw args ──
    // Layout: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
    // Compute atomically appends visible blade ids; the GPU decides its own
    // instance count — culled blades cost ZERO vertex work.
    const compactBuf = instancedArray(this.count, "uint");
    const indirectData = new Uint32Array(5);
    indirectData[0] = geom.index.count;
    this._indirectAttr = new THREE.IndirectStorageBufferAttribute(
      indirectData,
      5,
    );
    if (typeof geom.setIndirect === "function") {
      geom.setIndirect(this._indirectAttr);
    } else {
      geom.indirect = this._indirectAttr;
    }
    const indirectStorage = storage(this._indirectAttr, "uint", 5).toAtomic();

    this._buffers = { bufPos, bufA, bufB, bufC, compactBuf };

    // Reset visible-instance counter (runs right before each cull pass)
    this.computeReset = Fn(() => {
      atomicStore(indirectStorage.element(1), uint(0));
    })().compute(1, [1]);

    const fSide = float(bladesPerSide);
    const fSpacing = float(tileSize / bladesPerSide);
    const fHalf = float(tileSize * 0.5);

    // ── INIT: jittered grid, everything else derived per-frame ──
    this.computeInit = Fn(() => {
      const p = bufPos.element(instanceIndex);
      const row = floor(float(instanceIndex).div(fSide));
      const col = float(instanceIndex).mod(fSide);
      const jx = hash(instanceIndex.add(4321));
      const jz = hash(instanceIndex.add(1234));
      p.x.assign(col.mul(fSpacing).sub(fHalf).add(jx.mul(fSpacing)));
      p.y.assign(row.mul(fSpacing).sub(fHalf).add(jz.mul(fSpacing)));
      p.z.assign(float(0));
      p.w.assign(float(0));
      const a = bufA.element(instanceIndex);
      a.x.assign(float(0));
    })().compute(this.count, [64]);

    // ── UPDATE: once per blade — height, density, clump, wind, culls ──
    this.computeUpdate = Fn(() => {
      const p = bufPos.element(instanceIndex);
      const a = bufA.element(instanceIndex);
      const b = bufB.element(instanceIndex);
      const c = bufC.element(instanceIndex);

      const wrapped = wrapTileOffsetXZ(
        vec2(p.x, p.y),
        u.uAnchorDeltaXZ,
        u.uTileSize,
      );
      p.x.assign(wrapped.x);
      p.y.assign(wrapped.y);

      const worldX = wrapped.x.add(u.uAnchorPos.x);
      const worldZ = wrapped.y.add(u.uAnchorPos.z);
      const worldXZ = vec2(worldX, worldZ);
      const terrainUV = worldXZ.div(u.uTerrainSize).add(0.5);

      // Surface selection — compile-time branch like Gemini's cliffMode:
      // terrain rings sample heightTex/terrainNormalTex/densityTex; the cliff
      // ring samples cliffHeightTex (.x = Y, -9999 invalid, .yzw = normal).
      let terrainY, tN, painted, hasDensity;
      if (this._cliffMode) {
        const cliffSample = texture(this._cliffHeightTex, terrainUV);
        terrainY = cliffSample.x;
        tN = normalize(vec3(cliffSample.y, cliffSample.z, cliffSample.w));
        painted = texture(this._cliffDensityTex, terrainUV).x;
        const cliffValid = smoothstep(
          float(-9990),
          float(-9000),
          cliffSample.x,
        );
        const cliffPainted = smoothstep(float(0.01), float(0.03), painted);
        hasDensity = cliffValid.mul(cliffPainted);
      } else {
        terrainY = texture(heightTex, terrainUV).x;
        tN = texture(terrainNormalTex, terrainUV).xyz;
        painted = texture(densityTex, terrainUV).x;
        hasDensity = smoothstep(float(0.0), float(0.005), painted);
      }
      const worldPos = vec3(worldX, terrainY, worldZ);
      const densityHash = hash(instanceIndex.add(7919));
      const densityKeep = step(densityHash, u.uGrassDensity.mul(painted)).mul(
        hasDensity,
      );

      // playable-map edge fade
      const mapHalf = u.uTerrainSize.mul(0.5);
      const outMax = max(abs(worldX), abs(worldZ));
      const mapStay = float(1).sub(
        smoothstep(mapHalf.sub(2), mapHalf.add(0.35), outMax),
      );

      // Ring-window stochastic keep (dist² like Revo): density ramps in over
      // [innerR0..innerR1] (shells) and out to pMin over [outerR0..outerR1].
      const dxA = worldX.sub(u.uAnchorPos.x);
      const dzA = worldZ.sub(u.uAnchorPos.z);
      const distSqA = dxA.mul(dxA).add(dzA.mul(dzA));
      const pIn = smoothstep(
        u.uInnerR0.mul(u.uInnerR0),
        u.uInnerR1.mul(u.uInnerR1),
        distSqA,
      );
      const tOut = smoothstep(
        u.uOuterR0.mul(u.uOuterR0),
        u.uOuterR1.mul(u.uOuterR1),
        distSqA,
      );
      // Slope rejection: Gemini fades blades on steep terrain (normal.y below
      // the slopeMin..slopeMax window). Compaction needs a binary keep, so the
      // fade becomes a keep-probability — same look, stochastic thinning.
      // Cliff surfaces are exempt (they're steep by definition), like Gemini.
      const slopeProb = this._cliffMode
        ? float(1)
        : mix(
            float(1),
            smoothstep(u.uSlopeMin, u.uSlopeMax, tN.y),
            u.uSlopeEnabled,
          );

      const pKeep = pIn.mul(mix(float(1), u.uPMin, tOut)).mul(slopeProb);
      const stochasticKeep = step(hash(instanceIndex.add(31337)), pKeep);
      const frustumVis = computeFrustumVisibility(
        worldPos,
        u.uCameraMatrix,
        u.uFx,
        u.uFy,
        // Painted height can reach 2×: pad the cull for it so tall blades at
        // the bottom of the screen are not dropped while still visible.
        u.uBladeHeight.mul(this._bladeHeightTex && !this._cliffMode ? 3.2 : 1.6),
        u.uCullPadNdcX,
        u.uCullPadNdcYNear,
        u.uCullPadNdcYFar,
      );
      const vis = densityKeep
        .mul(mapStay)
        .mul(stochasticKeep)
        .mul(frustumVis);

      If(vis.greaterThan(0.5), () => {
        // Compaction append: this blade earns a slot in the draw list
        const slot = atomicAdd(indirectStorage.element(1), uint(1));
        compactBuf.element(slot).assign(instanceIndex);

        // Clumps (near rings only): the nearest clump, and how far this blade
        // is pulled toward its centre. Before the ground height, because a
        // pulled blade stands somewhere else.
        const clump = this._normalMode === "flat" ? null : this._nearestClump(worldXZ, u);
        const pull = clump ? clump.toCentre.mul(u.uClumpPull) : vec2(0, 0);
        const standX = worldX.add(pull.x);
        const standZ = worldZ.add(pull.y);

        // The cull above keeps the cheap one-tap height; only blades that
        // survive it pay for the mesh-matching one (3 taps).
        // (Cliff tops keep their own surface height: a pull is well under a
        // metre and the cliff height texture is 4 m per texel.)
        const groundY = this._cliffMode
          ? terrainY
          : this._terrainSurface
            ? this._clipmapGroundY(standX, standZ, heightTex, u.uTerrainSize)
            : clump
              ? texture(heightTex, vec2(standX, standZ).div(u.uTerrainSize).add(0.5)).x
              : terrainY;

        a.x.assign(vis);
        a.w.assign(groundY);
        // ── Per-blade identity (travels with the blade as the tile wraps) ──
        const h0 = hash(instanceIndex.add(196));
        const h1 = hash(instanceIndex.add(8521));
        const h2 = hash(instanceIndex.add(3197));
        const h3 = hash(instanceIndex.add(577));

        // ── Per-blade shape — Gemini HIGH (clumped) vs FAR/MEGA (uniform) ──
        // Far rings skip Voronoi clumping entirely like Gemini's mega path:
        // uniform 0.82–1.08 heights, no clump shade — the distant field reads
        // as a consistent dense carpet instead of patchy holes.
        let yaw, naturalLean, bladeH, clumpShade;
        if (this._normalMode === "flat") {
          yaw = h0.mul(PI2);
          naturalLean = h3.mul(u.uNaturalLean);
          bladeH = u.uBladeHeight.mul(mix(float(0.82), float(1.08), h2));
          clumpShade = float(1.0);
        } else {
          // World-space Voronoi clumping: the nearest clump's own randoms
          // (see _nearestClump) steer facing, lean, height and shade.
          const cv = clump.params;
          const clumpInfluence = smoothstep(0.75, 0.05, clump.dist).mul(
            u.uClumpStrength,
          );
          yaw = mix(h0, cv.z, clumpInfluence).mul(PI2);
          const hScale = mix(float(0.75), float(1.5), h2);
          const clumpHeightScale = mix(float(0.6), float(1.4), cv.x);
          naturalLean = mix(h3, cv.w, clumpInfluence).mul(u.uNaturalLean);
          bladeH = u.uBladeHeight.mul(
            mix(hScale, clumpHeightScale, clumpInfluence),
          );
          clumpShade = mix(
            float(1.0),
            mix(float(0.82), float(1.18), cv.y),
            clumpInfluence,
          );
        }
        // Last ring: blades shrink to nothing as they thin out, so the field
        // ends in the ground colour instead of a line of full-height blades.
        bladeH = bladeH.mul(float(1).sub(tOut.mul(u.uEdgeShrink)));
        // Painted blade height (short lawn, tall meadow). Cliff tops keep theirs.
        if (this._bladeHeightTex && !this._cliffMode) {
          bladeH = bladeH.mul(texture(this._bladeHeightTex, terrainUV).x.mul(255 / 128));
        }

        // ── Wind (Gemini formulas, baked windTex channels) ──
        const tBase = time.mul(u.uWindSpeed);
        const dirX = u.uWindDir.x;
        const dirZ = u.uWindDir.y;
        const waveUV = vec2(
          worldX.mul(u.uWindWaveScale).add(dirX.mul(tBase)).div(8.0),
          worldZ.mul(u.uWindWaveScale).add(dirZ.mul(tBase)).div(8.0),
        );
        const gustUV = vec2(
          worldX
            .mul(u.uWindWaveScale)
            .mul(0.25)
            .add(dirX.mul(tBase).mul(0.3))
            .div(3.0),
          worldZ
            .mul(u.uWindWaveScale)
            .mul(0.25)
            .add(dirZ.mul(tBase).mul(0.3))
            .div(3.0),
        );
        const zUV = vec2(
          worldZ.mul(u.uWindWaveScale).add(dirZ.mul(tBase)).add(17.3).div(6.0),
          worldX.mul(u.uWindWaveScale).sub(dirX.mul(tBase)).add(31.7).div(6.0),
        );
        const wave = texture(windTex, waveUV).x.mul(2).sub(1);
        const gustRaw = texture(windTex, gustUV).y.mul(2).sub(1);
        const zRollRaw = texture(windTex, zUV).z.mul(2).sub(1);
        const micro = sin(tBase.add(h0.mul(PI2)).mul(4.0)).mul(0.15);

        const gustStr = smoothstep(float(0.5), float(0.9), gustRaw).mul(
          u.uWindGust,
        );
        const windBase = wave.add(0.4).add(gustStr);
        const room = max(float(0), u.uMaxAngle.sub(naturalLean));
        const windScaled = windBase
          .add(micro)
          .mul(u.uWindStrength)
          .mul(room.div(u.uMaxAngle));

        // ── Player interaction ──
        // mode 0 "agitation": force added to the blade's own-yaw bend.
        // mode 1 "radial parting": world-space push vector away from the
        // player, applied as a tilt in the VS — Gemini's Rodrigues feel,
        // computed once per blade instead of per vertex.
        const toBlade = worldXZ.sub(vec2(u.uPlayerPos.x, u.uPlayerPos.z));
        const pDist = length(toBlade);
        const pFall = float(1).sub(
          smoothstep(float(0.5), u.uInteractionRadius, pDist),
        );
        // Only while the pusher is down among the blades: a jumping player
        // (or a camera above the field) no longer bends grass it cannot touch.
        const pusherAbove = u.uPlayerPos.y.sub(groundY);
        const pContact = float(1).sub(
          smoothstep(u.uBladeHeight.mul(0.4), u.uBladeHeight.mul(0.95), pusherAbove),
        );
        const pushAmt = pFall.mul(u.uInteractionStrength).mul(pContact);
        const pushForce = pushAmt
          .mul(1.4)
          .mul(float(1).sub(u.uInteractionMode));
        const pushDirW = toBlade.div(max(pDist, float(0.001)));

        // ── Push field: every other object, with trails that recover ──
        // One tap, near rings, visible blades only; it tilts the blade like
        // radial parting whatever the interaction mode.
        let trail = null;
        if (this._pushField && this._normalMode !== "flat" && !this._cliffMode) {
          const pf = this._pushField;
          this._uPushCenter ??= uniform(pf.center);
          const puv = worldXZ.sub(this._uPushCenter).div(float(pf.worldSize)).add(0.5);
          const edge = max(abs(puv.x.sub(0.5)), abs(puv.y.sub(0.5)));
          const fade = float(1).sub(smoothstep(float(0.42), float(0.5), edge));
          trail = pf.textureNode.sample(puv.clamp(0, 1)).xy.mul(fade).mul(u.uTrailStrength);
        }

        // ── Gemini-style scalar bend force, temporally smoothed ──
        // Bend happens along the blade's own yaw (rotated in the VS), exactly
        // like Gemini — FrontSide culling is what makes that read coherent.
        // Both force AND zRoll are eased across compute ticks so the throttled
        // 30/10 Hz updates never step visibly (raw zRoll was the wind jitter).
        const targetForce = naturalLean.add(windScaled).add(pushForce);
        const prevForce = p.z;
        const kF = float(0.18);
        const newForce = prevForce.add(targetForce.sub(prevForce).mul(kF));
        p.z.assign(newForce);

        const targetZRoll = zRollRaw.mul(0.4).sub(0.2);
        const prevZRoll = p.w;
        const newZRoll = prevZRoll.add(targetZRoll.sub(prevZRoll).mul(kF));
        p.w.assign(newZRoll);

        // a.x / b.w carry the radial push vector (zero in agitation mode)
        const pushX = pushDirW.x.mul(pushAmt).mul(u.uInteractionMode);
        a.x.assign(trail ? pushX.add(trail.x) : pushX);
        a.y.assign(newForce);
        a.z.assign(newZRoll);

        // View-thicken (Gemini): rotate edge-on blades toward the camera so
        // they keep width AND camera-facing (lit) normals from any view
        // angle — without it some camera azimuths read much darker. Done
        // per-blade here vs per-vertex in Gemini.
        const viewL = normalize(
          vec3(
            u.uCameraPos.x.sub(worldX),
            u.uCameraPos.y.sub(groundY),
            u.uCameraPos.z.sub(worldZ),
          ),
        );
        const lenXZ = length(viewL.xz);
        const faceZ = abs(viewL.z);
        const edgeOn = smoothstep(
          float(0.12),
          float(0.55),
          float(1).sub(faceZ),
        ).mul(smoothstep(float(0.08), float(0.35), lenXZ));
        const deltaYaw = u.uViewThicken
          .mul(edgeOn)
          .mul(0.55)
          .mul(atan(viewL.x, viewL.z));

        b.x.assign(bladeH);
        b.y.assign(yaw.add(deltaYaw));
        b.z.assign(clumpShade);
        const pushZ = pushDirW.y.mul(pushAmt).mul(u.uInteractionMode);
        b.w.assign(trail ? pushZ.add(trail.y) : pushZ);

        // x,y = clump pull offset (metres); the colour-variation randoms that
        // used to live here are recomputed from the blade index in the VS.
        c.x.assign(pull.x);
        c.y.assign(pull.y);
        c.z.assign(tN.x);
        c.w.assign(tN.z);
      });
    })().compute(this.count, [64]);

    // ── Material — tiny VS, Gemini-style standard lighting ──
    // Same base as Gemini (MeshStandardNodeMaterial): scene lights, CSM
    // shadows, day/night all come from the engine's pipeline — exact lighting
    // parity for free. colorNode = albedo stack, emissiveNode = SSS + spec.
    // FrontSide like Gemini: back-face culling hides "opposing" bends so the
    // field reads coherent; the cross ribbon covers rear viewing angles.
    const mat = new THREE.MeshStandardNodeMaterial({
      side: THREE.FrontSide,
      roughness: 0.92,
      metalness: 0,
    });
    mat.envMapIntensity = 0;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    this._assignNodes(mat, u, { bufPos, bufA, bufB, bufC, compactBuf });
    this.material = mat;

    // Plain Mesh, NOT InstancedMesh: the instance count comes from the
    // GPU-written indirect buffer and all per-blade data lives in SSBOs
    // (indexed by the instanceIndex builtin). InstancedMesh would allocate a
    // count×64B identity instanceMatrix (~70 MB across all rings, GPU+CPU)
    // and inject a useless per-vertex matrix fetch+multiply.
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = gp.receiveShadow !== false;
    this.group.add(this.mesh);

    this._lastAnchor = new THREE.Vector3();
    this._anchorDelta = new THREE.Vector2();
    this._cameraMatrix = new THREE.Matrix4();
    this._initDone = false;
    this._enabled = false;
    this.group.visible = false;
  }

  /**
   * Height of the terrain MESH at world XZ: the exact triangle the clipmap
   * draws there, rebuilt from the same inputs (see terrainLOD.js).
   *
   * - Level: level 0 spans ±halfCells·baseStep around the centre; ring L ≥ 1
   *   spans [halfCells/2, halfCells)·baseStep·2^L.
   * - Vertices sit on a world lattice of that level's step (the centre is
   *   snapped to the coarsest step), and each samples the heightmap LINEARLY
   *   at its own UV — so a vertex height is one filtered tap at that point.
   * - A normal quad splits along the B–C diagonal (indices A,C,B / B,C,D).
   * - The row of quads bordering a ring's hole is a 3-triangle FAN around a
   *   midpoint M on the hole edge (T-junction stitching). All four sides are
   *   the same fan after a swap/flip of the local axes, so one canonical fan
   *   covers them: apex (0,0), M (0.5,1), triangles {apex,(0,1),M},
   *   {apex,M,(1,1)}, {apex,(1,1),(1,0)}.
   * - Every case is one triangle, so it is always exactly 3 taps — the case
   *   only changes WHERE they are taken and how they are weighted.
   * - Vertices outside the map read 0, like the terrain's hmInBounds.
   */
  /**
   * Nearest clump centre (true Voronoi over the 3×3 neighbouring cells, like
   * Ghost of Tsushima). Checking only the blade's own cell cut any clump whose
   * centre sat near a cell edge along a straight line, so the field showed a
   * faint square grid. Branchless running minimum, compute stage only.
   *
   * @returns {{ dist, toCentre, params }} dist in cell units (as before),
   *   toCentre in metres, params = the clump's own randoms: x height, y shade,
   *   z facing, w lean — a hash of the cell id that is NOT the one that places
   *   the centre, so a clump's height no longer follows where its centre sits.
   */
  _nearestClump(worldXZ, u) {
    const cellP = worldXZ.div(u.uClumpScale);
    const base = floor(cellP);
    const frac = cellP.sub(base);
    let bestD = float(1e4);
    let bestRel = vec2(0, 0);
    let bestCell = base;
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const off = vec2(ox, oz);
        const cell = base.add(off);
        const rel = off.add(hash42(cell).xy).sub(frac);
        const d = length(rel);
        const closer = step(d, bestD);
        bestD = mix(bestD, d, closer);
        bestRel = mix(bestRel, rel, closer);
        bestCell = mix(bestCell, cell, closer);
      }
    }
    return {
      dist: bestD,
      toCentre: bestRel.mul(u.uClumpScale),
      params: hash42(bestCell.add(vec2(37.17, 91.73))),
    };
  }

  _clipmapGroundY(worldX, worldZ, heightTex, uTerrainSize) {
    const s = this._terrainSurface;
    this._uClipCenter ??= uniform(s.centerXZ); // same Vector2 → tracks lod.update()
    const c = this._uClipCenter;
    const base = float(s.baseStep);
    const inner = s.halfCells * 0.5;
    const one = float(1);

    const m = max(abs(worldX.sub(c.x)), abs(worldZ.sub(c.y)));
    const lvl = clamp(
      floor(log2(max(m, float(1e-3)).div(base.mul(inner)))),
      float(0),
      float(s.levels - 1),
    );
    // round: pow(2, n) is not guaranteed exact on every driver
    const stepW = base.mul(floor(pow(float(2), lvl).add(0.5)));

    const gx = worldX.div(stepW);
    const gz = worldZ.div(stepW);
    const cellX = floor(gx);
    const cellZ = floor(gz);
    const fx = gx.sub(cellX);
    const fz = gz.sub(cellZ);

    // ── Normal quad: triangle A,B,C below the diagonal, D,C,B above ──
    const k = step(one, fx.add(fz));
    const nP0 = vec2(k, k);                 // A (0,0) or D (1,1)
    const nW0 = abs(fx.add(fz).sub(1));
    const nW1 = mix(fx, one.sub(fz), k);    // B (1,0)
    const nW2 = mix(fz, one.sub(fx), k);    // C (0,1)

    // ── Fan row? Cell offset from the centre, in cells of this level ──
    const rx = cellX.sub(floor(c.x.div(stepW).add(0.5)));
    const rz = cellZ.sub(floor(c.y.div(stepW).add(0.5)));
    const eq = (a, n) => step(float(n - 0.5), a).mul(step(a, float(n + 0.5)));
    const span = (a) => step(float(-inner - 0.5), a).mul(step(a, float(inner - 0.5)));
    const bot = eq(rz, -inner - 1).mul(span(rx));
    const top = eq(rz, inner).mul(span(rx));
    const left = eq(rx, -inner - 1).mul(span(rz));
    const right = eq(rx, inner).mul(span(rz));
    const fan = bot.add(top).add(left).add(right).mul(step(float(0.5), lvl)); // level 0 is a full grid
    // canonical frame: swap = left|right, flip = top|right
    const swap = left.add(right);
    const flip = top.add(right);
    const ca = mix(fx, fz, swap);
    const cb = mix(fz, fx, swap);
    const cu = ca;
    const cv = mix(cb, one.sub(cb), flip);
    const t1 = step(cu, cv.mul(0.5));                 // {apex,(0,1),M}
    const t3 = step(cv, cu).mul(one.sub(t1));         // {apex,(1,1),(1,0)}
    const t2 = one.sub(t1).sub(t3);                   // {apex,M,(1,1)}
    const cV1 = vec2(t2.mul(0.5).add(t3), one);
    const cV2 = vec2(t1.mul(0.5).add(t2).add(t3), t1.add(t2));
    const fW0 = t1.add(t2).mul(one.sub(cv)).add(t3.mul(one.sub(cu)));
    const fW1 = t1.mul(cv.sub(cu.mul(2))).add(t2.mul(cv.sub(cu).mul(2))).add(t3.mul(cv));
    const fW2 = t1.mul(cu.mul(2)).add(t2.mul(cu.mul(2).sub(cv))).add(t3.mul(cu.sub(cv)));
    // canonical (u,v) → local cell (fx,fz)
    const toLocal = (p) => {
      const b = mix(p.y, one.sub(p.y), flip);
      return vec2(mix(p.x, b, swap), mix(b, p.x, swap));
    };

    const p0 = mix(nP0, toLocal(vec2(0, 0)), fan);
    const p1 = mix(vec2(1, 0), toLocal(cV1), fan);
    const p2 = mix(vec2(0, 1), toLocal(cV2), fan);
    const w0 = mix(nW0, fW0, fan);
    const w1 = mix(nW1, fW1, fan);
    const w2 = mix(nW2, fW2, fan);

    const tap = (p) => {
      const wx = cellX.add(p.x).mul(stepW);
      const wz = cellZ.add(p.y).mul(stepW);
      const tu = wx.div(uTerrainSize).add(0.5);
      const tv = wz.div(uTerrainSize).add(0.5);
      const inB = step(float(0), tu).mul(step(tu, one))
        .mul(step(float(0), tv)).mul(step(tv, one));
      return texture(heightTex, vec2(tu, tv)).x.mul(inB);
    };
    return tap(p0).mul(w0).add(tap(p1).mul(w1)).add(tap(p2).mul(w2));
  }

  _assignNodes(mat, u, { bufPos, bufA, bufB, bufC, compactBuf }) {
    const vData = varying(vec4(1, 1, 0, 0), "v_hg_data"); // clumpShade, shadeRand, h4, h5
    const vNormal = varying(vec3(0, 1, 0), "v_hg_n");
    const vWorld = varying(vec3(0), "v_hg_w");

    const rotY = (ang, v) => {
      const cc = cos(ang);
      const ss = sin(ang);
      return vec3(
        v.x.mul(cc).add(v.z.mul(ss)),
        v.y,
        negate(v.x).mul(ss).add(v.z.mul(cc)),
      );
    };

    mat.positionNode = Fn(() => {
      // Compacted draw: instanceIndex is a slot in the visible list — remap
      // to the real blade id. Culled blades are never vertex-shaded at all.
      const bladeIdx = compactBuf.element(instanceIndex);
      const p = bufPos.element(bladeIdx);
      const a = bufA.element(bladeIdx);
      const b = bufB.element(bladeIdx);
      const c = bufC.element(bladeIdx);

      const totalForce = a.y;
      const zRoll = a.z;
      const terrainY = a.w;
      const bladeH = b.x;
      const yaw = b.y;

      // shadeRand recomputed from hash — its old slot (b.w) carries push Z
      const shadeRand = mix(float(0.75), float(1.0), hash(bladeIdx.add(8521)));
      // h4 / h5 colour-variation randoms: same hashes the compute used to store.
      vData.assign(vec4(b.z, shadeRand, hash(bladeIdx.add(911)), hash(bladeIdx.add(2741))));

      // Gemini bend: arc along local X, whole blade (incl. cross ribbon at
      // +90°) rotated by yaw. FrontSide culling makes the field read coherent.
      const isCross = attribute("aCross", "float");
      // Blade folding (Ghost of Tsushima: a short blade's vertices make TWO
      // blades). Here the cross ribbon is the second blade: for blades shorter
      // than uFoldBelow × the ring's blade height it leaves the shared root
      // and stands on its own — own spot within the blade cell, own facing,
      // own height. Twice the visible blades for the same vertices.
      // Relative, so the same share of blades folds at any Blade height.
      // uFoldBelow 0 = off.
      const fold = isCross.mul(step(bladeH, u.uFoldBelow.mul(u.uBladeHeight)));
      const crossedYaw = mix(
        yaw.add(isCross.mul(Math.PI * 0.5)),
        hash(bladeIdx.add(4409)).mul(PI2),
        fold,
      );
      const bladeHV = bladeH.mul(
        mix(float(1), mix(float(0.6), float(1), hash(bladeIdx.add(7013))), fold),
      );
      const cell = float(this.tileSize / this.bladesPerSide);
      const foldOffX = hash(bladeIdx.add(1531)).sub(0.5).mul(cell).mul(fold);
      const foldOffZ = hash(bladeIdx.add(2657)).sub(0.5).mul(cell).mul(fold);

      // Distance LOD morph (Gemini's lodMorph equivalent). Gemini keeps the
      // cross ribbon through HIGH+MID (to ~80m) and goes single-ribbon beyond;
      // the near ring ends at ~62m, so the cross only fades right at the
      // ring handoff (40→62m) to blend into the single-ribbon mid ring.
      const distXZ = length(vec2(p.x, p.y)); // tile-local = dist from anchor
      const lodK = this._crossed
        ? smoothstep(
            float(this._crossFadeR0),
            float(this._crossFadeR1),
            distXZ,
          )
        : float(1);

      const h = uv().y;
      // Gemini's base stiffness: roots resist bending up to the stiffness
      // fraction of the blade (eps guard — smoothstep(0,0,x) is undefined)
      const baseStiff = smoothstep(
        float(0),
        max(u.uStiffness, float(1e-4)),
        h,
      );
      const curveWeight = pow(max(h, 1e-4), u.uBendFocus).mul(baseStiff);
      const angle = totalForce.mul(curveWeight);
      const L = h.mul(bladeHV);
      const arcX = sin(angle).mul(L);
      const arcY = cos(angle).mul(L);
      const arcZ = sin(zRoll).mul(L).mul(curveWeight).mul(0.2);

      // Per-frame sway (VS, always 60 fps): the compute pass supplies the
      // smoothed low-frequency gust field; this adds continuous high-frequency
      // motion between compute ticks — tip-weighted, world-space along wind
      // dir + perpendicular flutter.
      const phase = hash(bladeIdx).mul(PI2);
      const swayAmp = clamp(u.uWindStrength, float(0), float(2)).mul(0.5);
      const swayA = sin(time.mul(2.3).add(phase)).mul(0.06).mul(swayAmp);
      const flutterA = sin(time.mul(4.1).add(phase.mul(1.7)))
        .mul(0.025)
        .mul(swayAmp);
      const windPerp = vec2(negate(u.uWindDir.y), u.uWindDir.x);
      const hh = h.mul(h).mul(bladeHV);
      const swayX = u.uWindDir.x.mul(swayA).add(windPerp.x.mul(flutterA)).mul(hh);
      const swayZ = u.uWindDir.y.mul(swayA).add(windPerp.y.mul(flutterA)).mul(hh);

      // Cross ribbon fades out with distance (Gemini FAR/MEGA = single ribbon)
      const crossWidth = float(1).sub(isCross.mul(lodK));
      const pArc = vec3(
        arcX.add(positionLocal.x.mul(crossWidth)),
        arcY,
        arcZ.add(positionLocal.z),
      );
      const pRot = rotY(crossedYaw, pArc);

      // Push (radial parting + the push field): the blade ROTATES about its
      // root toward the push, more toward the tip, so it lies over instead
      // of stretching. (It used to shear the tip sideways and squash the
      // height, which made pushed grass look rubbery.) Up to ~75° at a full
      // push. No push = tilt 0 = exactly the unpushed blade.
      const pushV = vec2(a.x, b.w);
      const pushLen = length(pushV);
      const pushDir = pushV.div(max(pushLen, float(1e-4)));
      const tilt = clamp(pushLen, float(0), float(1)).mul(1.3).mul(h.mul(0.6).add(0.4));
      const sT = sin(tilt);
      const cT = cos(tilt);
      const along = pRot.x.mul(pushDir.x).add(pRot.z.mul(pushDir.y));
      const alongShift = along.mul(cT).add(pRot.y.mul(sT)).sub(along);
      const pYaw = vec3(
        pRot.x.add(swayX).add(pushDir.x.mul(alongShift)),
        pRot.y.mul(cT).sub(along.mul(sT)),
        pRot.z.add(swayZ).add(pushDir.y.mul(alongShift)),
      );

      // Normal: flat blade normal fanned cylindrically, blended to terrain
      const spread = uv()
        .x.mul(2)
        .sub(1)
        .mul(u.uCylindrical)
        .mul(Math.PI * 0.5);
      const bladeN = rotY(crossedYaw.add(spread), vec3(0, 0, 1));
      const tNy = sqrt(
        max(float(0), float(1).sub(c.z.mul(c.z)).sub(c.w.mul(c.w))),
      );
      const terrainN = vec3(c.z, tNy, c.w);
      // Lighting vs emissive normals — Gemini's OBSERVED behavior (verified
      // by A/B in grass-lab): its diffuse lighting acts FLAT (uniform field,
      // no per-blade/no view reaction), while its SSS emissive uses the
      // per-blade normal (vCustomNormal) — that's where the backlit tip
      // speckles and near-field life come from.
      const nFlat = normalize(mix(vec3(0, 1, 0), terrainN, u.uSkyBlend));
      normalLocal.assign(nFlat); // lighting: ALWAYS flat
      const nEmissive =
        this._normalMode === "blade"
          ? normalize(
              mix(normalize(mix(bladeN, terrainN, u.uSkyBlend)), nFlat, lodK),
            )
          : nFlat;
      vNormal.assign(nEmissive); // emissive SSS/spec: per-blade on near rings

      const outPos = vec3(
        pYaw.x.add(p.x).add(foldOffX).add(c.x),
        pYaw.y.add(terrainY),
        pYaw.z.add(p.y).add(foldOffZ).add(c.y),
      );
      vWorld.assign(outPos.add(vec3(u.uAnchorPos.x, 0, u.uAnchorPos.z)));
      return outPos;
    })();

    // Mountain shade: one visibility read per blade vertex, shared by colour and
    // emissive. Grass that receives shadows loses direct sun through the sun's
    // shadow term; `shade` only darkens rings that do not.
    const ts = this._terrainShadow;
    const sunVis = ts ? ts.visibilityHere() : null;
    const albedoNode = Fn(() => {
      const clumpShade = vData.x;
      const shadeRand = vData.y;
      const h4 = vData.z;
      const h5 = vData.w;
      const hPct = uv().y;
      const N = normalize(vNormal);

      // ── Gemini color stack ──
      // Far rings darken the AO floor by uFarAoMul (Gemini mega used 0.55,
      // its darker distant tone). Shared with the field colour.
      // the slightly darker distant tone Gemini has.
      const aoFloor =
        this._normalMode === "flat" ? u.uAoBase.mul(u.uFarAoMul) : u.uAoBase;
      const ao = mix(aoFloor, float(1.0), pow(hPct, u.uAoPower));
      const baseCol = mix(u.uBladeCol, u.uTipCol, hPct);

      const warmCol = vec3(0.18, 0.28, 0.02);
      const coolCol = vec3(0.02, 0.18, 0.08);
      const tintTarget = mix(warmCol, coolCol, h4);
      const hueCol = mix(baseCol, tintTarget, u.uCvHueSpread);
      const lum = dot(hueCol, vec3(0.299, 0.587, 0.114));
      const satFactor = float(1.0).sub(h5.mul(u.uCvSatSpread));
      const satCol = mix(vec3(lum, lum, lum), hueCol, satFactor);
      const dryBlend = smoothstep(u.uCvDryAmount, float(0), h5).mul(
        float(1.0).sub(hPct).mul(0.5).add(0.5),
      );
      const dryCol = mix(satCol, u.uCvDryCol, dryBlend);
      const variedCol = mix(baseCol, dryCol, u.uColorVar);

      // ── Terrain tint (Gemini): match grass to ground hue without
      // multiplicative crush (dark×dark → black). Mode 1 = procedural ground
      // color fn, mode 2 = image texture. Root-biased so tips keep identity.
      const procTint = this._groundColorAtWorldXZ(vWorld.xz);
      const tintUv = vWorld.xz.div(u.uTerrainSize).add(0.5);
      const imgTint = texture(this._tintTex, tintUv).rgb;
      const isImgMode = step(float(1.49), u.uTerrainTintMode);
      const isProcMode = step(float(0.49), u.uTerrainTintMode).mul(
        float(1).sub(isImgMode),
      );
      const tintRgb = procTint.mul(isProcMode).add(imgTint.mul(isImgMode));
      const hasMode = isProcMode.add(isImgMode);
      // Tint maths shared with the far field (grassFieldColor.js).
      const tintedVaried = grassTintBlend(
        variedCol, tintRgb, hasMode, hPct,
        u.uTerrainTintStrength, u.uTerrainTintRootBias,
      );

      // Lighting comes from the standard material pipeline (scene lights,
      // CSM shadows) — colorNode is pure albedo, exactly like Gemini.
      let finalAlbedo = tintedVaried.mul(clumpShade).mul(shadeRand).mul(ao);
      if (this._normalMode === "flat") {
        // Far rings converge to the colour the ground paints past the last
        // ring, so the hand-over has no seam. Near rings never reach the band.
        const field = grassFieldAlbedo(tintRgb, {
          bladeCol: u.uBladeCol, tipCol: u.uTipCol,
          aoBase: u.uAoBase, aoPower: u.uAoPower, farAoMul: u.uFarAoMul,
          tintOn: hasMode, tintStrength: u.uTerrainTintStrength,
          tintRootBias: u.uTerrainTintRootBias,
        });
        const distA = length(vWorld.xz.sub(u.uAnchorPos.xz));
        finalAlbedo = mix(finalAlbedo, field, smoothstep(u.uConvStart, u.uConvEnd, distA));
      }
      const dbg = LOD_DEBUG_TINTS[this.group.name] ?? [1, 0, 1];
      return mix(finalAlbedo, vec3(dbg[0], dbg[1], dbg[2]), u.uLodDebug);
    })();
    mat.colorNode = ts ? ts.shade(albedoNode, sunVis) : albedoNode;
    // Hand the same node to the sun's shadow term (wrapSunShadow), so a
    // shadow-receiving ring reads the map ONCE per pixel, not twice.
    if (sunVis) mat.terrainSunShadowNode = sunVis;

    // ── EMISSIVE — SSS + dual specular (Gemini's emissiveNode, verbatim
    // except viewDir/dist use the correct vWorld instead of positionLocal).
    // Far rings: none at all, like Gemini's mega material (also cheaper). ──
    if (this._normalMode === "flat") {
      mat.emissiveNode = vec3(0, 0, 0);
      return;
    }
    mat.emissiveNode = Fn(() => {
      const hPct = uv().y;
      const N = normalize(vNormal);
      const viewDir = normalize(cameraPosition.sub(vWorld));

      // Thickness: base thick, tip thin
      const thickness = float(1).sub(hPct).mul(0.7).add(0.3);
      const transmitCol = mix(
        u.uBssCol,
        u.uBssCol.mul(vec3(1.3, 1.1, 0.7)),
        float(1).sub(thickness),
      );

      // 3-component SSS: back, front, rim
      const backScat = max(dot(negate(u.uSunDir), N), float(0));
      const frontScat = max(dot(u.uSunDir, N), float(0));
      const rim = float(1).sub(max(dot(N, viewDir), float(0)));
      const totalSSS = clamp(
        pow(backScat, u.uBssPower)
          .mul(thickness)
          .add(pow(frontScat, float(1.5)).mul(thickness).mul(u.uFrontScatter))
          .add(pow(rim, float(3.0)).mul(thickness).mul(u.uRimSSS)),
        float(0),
        float(1),
      );
      const sssCol = transmitCol
        .mul(float(0.35))
        .mul(totalSSS)
        .mul(u.uBssIntensity);

      // ── Dual specular (Gemini emissive) — near-camera only ──
      const specDistFade = smoothstep(
        float(10),
        float(2),
        length(cameraPosition.sub(vWorld)),
      );
      const tipFade1 = smoothstep(float(0.5), float(1.0), hPct);
      const reflV1 = reflect(u.uSpecV1Dir, N);
      const specDot1 = pow(
        max(dot(viewDir, reflV1), float(0)),
        u.uSpecV1Power,
      );
      const spec1 = u.uSpecV1Col
        .mul(specDot1)
        .mul(u.uSpecV1Intensity)
        .mul(specDistFade)
        .mul(tipFade1)
        .mul(float(3.0))
        .mul(u.uSpecV1Enabled);

      const specNoiseUV = vWorld.xz.mul(u.uSpecV2NoiseScale).mul(0.125);
      const specNoiseSamp = texture(this._specNoiseTex, specNoiseUV);
      const noiseCombined = specNoiseSamp.x
        .add(specNoiseSamp.y)
        .add(specNoiseSamp.z)
        .mul(float(0.333))
        .mul(2.0)
        .sub(1.0);
      const perturbedN = normalize(
        mix(N, vec3(noiseCombined, float(1), noiseCombined), u.uSpecV2NoiseStr),
      );
      const reflV2 = reflect(u.uSpecV2Dir, perturbedN);
      const specDot2 = pow(
        max(dot(viewDir, reflV2), float(0)),
        u.uSpecV2Power,
      );
      const tipFade2 = smoothstep(
        float(1).sub(u.uSpecV2TipBias),
        float(1),
        hPct,
      );
      const spec2 = u.uSpecV2Col
        .mul(specDot2)
        .mul(u.uSpecV2Intensity)
        .mul(specDistFade)
        .mul(tipFade2)
        .mul(u.uSpecV2Enabled);

      const sunLit = sssCol.add(spec1).add(spec2);
      // SSS and specular are both sunlight; emissive never passes a shadow.
      return sunVis ? sunLit.mul(sunVis) : sunLit;
    })();
  }

  async init(camera) {
    await this.renderer.computeAsync(this.computeInit);
    // Prime the compact list so the first frame draws something sensible
    await this.renderer.computeAsync([this.computeReset, this.computeUpdate]);
    this._initDone = true;
    await this.renderer.compileAsync(this.mesh, camera);
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled;
  }

  setSunDir(dir) {
    this.u.uSunDir.value.copy(dir);
  }

  /** Swap in new blade geometry (geometry-baked editor params: width,
   *  segments, taper). Keeps the SAME indirect attribute — the compute
   *  reset/cull nodes are bound to it — and just updates its indexCount. */
  rebuildGeometry({ bladeWidth, segments, taperStart, crossed } = {}) {
    if (!this.mesh) return;
    this._bladeWidth = bladeWidth ?? this._bladeWidth;
    if (segments != null) this._segments = Math.max(1, Math.round(segments));
    this._taperStart = taperStart ?? this._taperStart;
    // Only rings BUILT crossed can toggle the cross (the cross-fade shader
    // path is baked at construction); single-ribbon rings stay single.
    const useCross =
      this._crossedAtBuild ?? (this._crossedAtBuild = this._crossed);
    const wantCross = useCross && crossed !== false;
    const geom = createCrossedBladeGeometry(
      1.0,
      this._bladeWidth,
      this._segments,
      this._taperStart,
      wantCross,
    );
    this._indirectAttr.array[0] = geom.index.count;
    this._indirectAttr.needsUpdate = true;
    if (typeof geom.setIndirect === "function") {
      geom.setIndirect(this._indirectAttr);
    } else {
      geom.indirect = this._indirectAttr;
    }
    const old = this.mesh.geometry;
    this.mesh.geometry = geom;
    old?.dispose();
  }

  /** Live editor sync — same grassState (toolState.grass) shape v2's
   *  GrassManager.syncUniforms consumes, so the existing grass UI drives the
   *  hybrid directly. Geometry-baked params (bladeWidth, segments, counts)
   *  still need a rebuild and are intentionally not handled here. */
  syncFromState(gp, sunDir) {
    const u = this.u;
    u.uBladeHeight.value = (gp.bladeHeight ?? 1) * this._bladeHeightMul;
    u.uBendFocus.value = gp.bendFocus ?? 0.5;
    u.uStiffness.value = gp.stiffness ?? 0;
    u.uLodDebug.value = gp.lodDebug ? 1 : 0;
    u.uMaxAngle.value = gp.maxAngle ?? 1.4;
    u.uNaturalLean.value = gp.naturalLean ?? 0.9;
    u.uWindSpeed.value = gp.windSpeed ?? 0.2;
    u.uWindStrength.value = gp.windStrength ?? 1.4;
    u.uWindGust.value = gp.windGust ?? 0.3;
    u.uWindWaveScale.value = gp.windWaveScale ?? 0.12;
    const wr = ((gp.windAngle ?? 0) * Math.PI) / 180;
    u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
    u.uClumpScale.value = gp.clumpScale ?? 1.5;
    u.uClumpStrength.value = gp.clumpStrength ?? 0.7;
    u.uClumpPull.value = gp.clumpPull ?? 0;
    u.uGrassDensity.value = gp.grassDensity ?? 1;
    u.uBladeCol.value.copy(srgb(gp.bladeColor ?? "#0e300e"));
    u.uTipCol.value.copy(srgb(gp.tipColor ?? "#004d05"));
    u.uAoBase.value = gp.aoBase ?? 0.25;
    u.uAoPower.value = gp.aoPower ?? 2;
    u.uFarAoMul.value = gp.farAoMul ?? 0.55;
    u.uColorVar.value = gp.colorVariation ? 1 : 0;
    u.uCvHueSpread.value = gp.cvHueSpread ?? 0.08;
    u.uCvSatSpread.value = gp.cvSatSpread ?? 0.3;
    u.uCvDryAmount.value = gp.cvDryAmount ?? 0.15;
    u.uCvDryCol.value.copy(srgb(gp.cvDryColor ?? "#8a7a3a"));
    u.uSkyBlend.value = gp.skyBlend ?? 0.8;
    u.uCylindrical.value = gp.cylindrical ?? 0.3;
    u.uViewThicken.value = gp.viewThicken ?? 0.45;
    u.uFoldBelow.value = gp.foldBelow ?? 0;
    u.uBssCol.value.copy(srgb(gp.bssColor ?? "#2d7a2d"));
    u.uBssIntensity.value = gp.bssIntensity ?? 1.2;
    u.uBssPower.value = gp.bssPower ?? 2;
    u.uFrontScatter.value = gp.frontScatter ?? 0.3;
    u.uRimSSS.value = gp.rimSSS ?? 0.25;
    if (this.mesh) this.mesh.receiveShadow = gp.receiveShadow !== false;
    u.uSlopeEnabled.value = gp.slopeEnabled ? 1 : 0;
    u.uSlopeMin.value = gp.slopeMin ?? 0.65;
    u.uSlopeMax.value = gp.slopeMax ?? 0.85;
    // terrain tint mode resolution — same logic as v2 GrassManager.syncUniforms
    if (gp.terrainTintEnabled) {
      u.uTerrainTintMode.value = gp.terrainTintAutoSource
        ? 1
        : Math.max(0, Math.min(2, gp.terrainTintManualMode | 0));
    } else {
      u.uTerrainTintMode.value = 0;
    }
    u.uTerrainTintStrength.value = gp.terrainTintStrength ?? 0.5;
    u.uTerrainTintRootBias.value = gp.terrainTintRootBias ?? 0.35;
    u.uSpecV1Enabled.value = gp.specV1Enabled ? 1 : 0;
    u.uSpecV1Intensity.value = gp.specV1Intensity ?? 1.5;
    u.uSpecV1Col.value.copy(srgb(gp.specV1Color ?? "#ffffff"));
    u.uSpecV1Dir.value
      .set(gp.specV1DirX ?? -1, gp.specV1DirY ?? 1, gp.specV1DirZ ?? 0.5)
      .normalize();
    u.uSpecV1Power.value = gp.specV1Power ?? 25.6;
    u.uSpecV2Enabled.value = gp.specV2Enabled ? 1 : 0;
    u.uSpecV2Intensity.value = gp.specV2Intensity ?? 1;
    u.uSpecV2Col.value.copy(srgb(gp.specV2Color ?? "#ffffff"));
    u.uSpecV2Dir.value
      .set(gp.specV2DirX ?? -1, gp.specV2DirY ?? 0.45, gp.specV2DirZ ?? 1)
      .normalize();
    u.uSpecV2NoiseScale.value = gp.specV2NoiseScale ?? 3;
    u.uSpecV2NoiseStr.value = gp.specV2NoiseStr ?? 0.6;
    u.uSpecV2Power.value = gp.specV2Power ?? 12;
    u.uSpecV2TipBias.value = gp.specV2TipBias ?? 0.5;
    u.uInteractionRadius.value = gp.interactionRadius ?? 1.5;
    u.uInteractionStrength.value = gp.interactionStrength ?? 0.7;
    u.uInteractionMode.value = gp.interactionMode ?? 0;
    u.uTrailStrength.value = gp.trailStrength ?? 1;
    if (sunDir) u.uSunDir.value.copy(sunDir);
  }

  update(anchorPos, camera) {
    if (!this._initDone || !this._enabled) return;
    const u = this.u;

    const dx = anchorPos.x - this._lastAnchor.x;
    const dz = anchorPos.z - this._lastAnchor.z;
    this._anchorDelta.set(dx, dz);
    u.uAnchorDeltaXZ.value.copy(this._anchorDelta);
    u.uAnchorPos.value.copy(anchorPos);
    u.uPlayerPos.value.copy(anchorPos);
    this.mesh.position.set(anchorPos.x, 0, anchorPos.z);
    this._lastAnchor.copy(anchorPos);

    this._cameraMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    u.uCameraMatrix.value.copy(this._cameraMatrix);
    u.uCameraPos.value.setFromMatrixPosition(camera.matrixWorld);
    const e = camera.projectionMatrix.elements;
    u.uFx.value = e[0];
    u.uFy.value = e[5];

    // Per-frame SYNCHRONOUS compute, queued ahead of this frame's render.
    // The old computeAsync + busy-flag pattern waited a full GPU round-trip
    // before allowing the next dispatch → effective 20–30 Hz wind = stepped
    // motion. Gemini is smooth because it evaluates wind every rendered
    // frame; dispatching synchronously gives the hybrid the same cadence
    // (~0.3 ms GPU for all rings — the architecture makes this affordable).
    this.renderer.compute([this.computeReset, this.computeUpdate]);
  }
}
