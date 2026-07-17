/**
 * Susuki (miscanthus / pampas) field — the Ghost-of-Tsushima silver plumes,
 * proven in v3/susuki-lab.html, rebuilt on the HybridGrassSystem skeleton so it
 * costs like the hybrid grass instead of like the lab:
 *
 *   - camera-following wrap tile (infinite field, fixed instance budget)
 *   - ALL per-plant work in ONE compute pass (paint density, slope reject,
 *     radial fade window, frustum cull, wind + player-push bend vector
 *     smoothed across ticks)
 *   - atomic compaction + GPU-written indirect draws: culled plants cost ZERO
 *     vertex work; the CPU never knows or cares how many plants are visible
 *
 * Each instance is a TUSSOCK: `tufts` stems + plumes with baked offsets,
 * per-tuft height variation and phase (aTuft vec4 attribute) — real susuki
 * grows in bunches of 5+, not single stalks.
 *
 * Bending is a WORLD-SPACE vector (bufDir SSBO), not a per-plant yaw:
 * wind pushes every plant the same downwind way — coherent with the grass,
 * which shares the same windTex + grassState wind params — and the player
 * push adds into the same vector, so plumes part radially around you.
 * Per-plant random yaw is baked into the stem geometry only (cosmetic).
 *
 * Two draws total: stems (crossed thin ribbons, opaque) + plumes (3 crossed
 * cards, alpha-tested procedural strand texture, backlit silver-lining
 * emissive). Both read the same compact list, so they always agree.
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
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  floor,
  hash,
  instanceIndex,
  instancedArray,
  length,
  max,
  mix,
  negate,
  normalize,
  normalLocal,
  positionLocal,
  pow,
  sin,
  smoothstep,
  step,
  storage,
  texture,
  time,
  uint,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  PI2,
} from "three/tsl";
import { wrapTileOffsetXZ } from "../../../v2/core/revoGrass/revoGrassTile.js";
import { computeFrustumVisibility } from "../../../v2/core/revoGrass/revoGrassSsboUtils.js";
import { createBladeGeometry } from "../../../v2/core/foliage/grassGemini.js";

function srgb(hex) {
  return new THREE.Color(hex);
}

export const SUSUKI_DEFAULTS = {
  density: 1,
  tufts: 1,              // stems per painted plant (optional bunching)
  plumesPerFlower: 5,    // plumes in the flower head atop each stem
  flowerSpread: 65,      // fan half-angle (deg) of the flower head
  stemHeight: 1.9,
  stemHeightVar: 0.26,   // ± fraction of stemHeight
  stemWidth: 0.03,
  stemFlex: 0.45,
  lean: 0.08,
  stemBase: "#2c4018",
  stemTip: "#6f7a40",
  plumeSize: 1.1,
  plumeWidth: 0.48,
  plumeHeight: 1.2,
  plumeDroop: 0.55,
  plumeBase: "#d0c8b2",
  plumeTip: "#f7f4ea",
  plumeAO: 0.62,
  plumeGlow: 0.2,
  backlitIntensity: 1.7,
  backlitPower: 6,
  flutter: 0.05,
  alphaTest: 0.2,
  windMul: 1,
  interactRadius: 2.2,   // player/horse push radius (m)
  interactStrength: 1.2,
  fadeStart: 150,        // radial plume fade-out window (m from camera)
  fadeEnd: 195,
  slopeMinY: 0.55,       // terrain normal.y below which susuki stops growing
  texStrands: 460,
  texSpread: 52,
  texStrandLen: 0.33,
  texDroop: 0.6,
};

// ── Plume strand texture (canvas) ────────────────────────────────────────────
// Hundreds of fine arcing white strokes fanning up-and-out from a central
// spine, a blurred low-alpha pass underneath for volume, bright dots for seed
// sparkle. Drawn white — tint / AO / backlight happen in the shader off the
// alpha channel only. Deterministic seed so redraws with equal params match.
const PLUME_TEX_W = 256;
const PLUME_TEX_H = 512;

export function drawPlumeTexture(canvas, sp) {
  let seed = 12345;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const W = PLUME_TEX_W, H = PLUME_TEX_H;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.lineCap = "round";
  const cx = W / 2;
  const spreadRad = ((sp.texSpread ?? 52) * Math.PI) / 180;
  const strands = sp.texStrands ?? 460;

  const strand = (soft) => {
    const t = Math.pow(rand(), 0.8);              // 0 base → 1 top of spine
    let x = cx + (rand() - 0.5) * 10;
    let y = H * (1 - 0.05 - t * 0.88);
    const side = rand() < 0.5 ? -1 : 1;
    let theta = -Math.PI / 2 + side * spreadRad * (0.2 + 0.8 * rand());
    const len = H * (sp.texStrandLen ?? 0.33) *
      (0.3 + 0.7 * Math.sin(Math.min(t * 1.2, 1) * Math.PI));
    const segs = 8, stepLen = len / segs;
    const curl = side * (0.04 + rand() * 0.07);
    const droop = (sp.texDroop ?? 0.6) * 0.05;
    let alpha = soft ? 0.07 + rand() * 0.07 : 0.35 + rand() * 0.55;
    let lw = soft ? 6 + rand() * 9 : 0.9 + rand() * 1.5;
    for (let k = 0; k < segs; k++) {
      const nx = x + Math.cos(theta) * stepLen * 0.6;
      const ny = y + Math.sin(theta) * stepLen;
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny); ctx.stroke();
      x = nx; y = ny;
      theta += curl + droop;
      alpha *= soft ? 0.85 : 0.78;
      lw *= 0.9;
    }
    return { x, y };
  };

  for (let i = 0; i < strands * 0.2; i++) strand(true);   // soft volume pass
  const tips = [];
  for (let i = 0; i < strands; i++) tips.push(strand(false));
  for (let i = 0; i < strands * 0.6; i++) {               // seed sparkle
    const tip = tips[(rand() * tips.length) | 0];
    const a = 0.4 + rand() * 0.5;
    ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(tip.x + (rand() - 0.5) * 14, tip.y + (rand() - 0.5) * 14,
            0.5 + rand() * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Tussock layout (shared by stem + plume geometry so they line up) ─────────
function tuftLayout(count) {
  let seed = 777;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const tufts = [];
  for (let i = 0; i < count; i++) {
    // golden-angle spiral: first tuft at the center, rest spread outward
    const r = i === 0 ? 0 : 0.14 + 0.3 * Math.sqrt(i / count);
    const a = i * 2.39996;
    tufts.push({
      ox: Math.cos(a) * r,
      oz: Math.sin(a) * r,
      hMul: 0.82 + rand() * 0.33,   // per-tuft height variation
      phase: rand(),                // per-tuft flutter phase
      yaw: rand() * Math.PI * 2,    // cosmetic ribbon/card rotation
    });
  }
  return tufts;
}

/** Per-vertex vec4 aTuft = (offsetX, offsetZ, heightMul, phase). */
function addTuftAttr(positions, count, t) {
  const arr = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    arr[i * 4] = t.ox; arr[i * 4 + 1] = t.oz;
    arr[i * 4 + 2] = t.hMul; arr[i * 4 + 3] = t.phase;
  }
  return arr;
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Stem cluster: `tufts` crossed thin ribbons, each pre-rotated by its own
 * cosmetic yaw and carrying its tuft offset/height/phase in aTuft. Ribbons
 * are built around the origin — the VS adds the offset AFTER bending so each
 * stem bends around its own base.
 */
export function createStemGeometry(width, tufts = 5) {
  const base = createBladeGeometry(1.0, width, 4, 0.9);
  const srcPos = base.attributes.position.array;
  const srcUv = base.attributes.uv.array;
  const srcIdx = base.index.array;
  const n = base.attributes.position.count;
  const layout = tuftLayout(tufts);

  const positions = [], uvs = [], normals = [], tuftArr = [], indices = [];
  let vertBase = 0;
  for (const t of layout) {
    // crossed ribbon = the blade + a copy pre-rotated 90°, both then rotated
    // by the tuft's cosmetic yaw (bend direction comes from the VS, in world
    // space, so this rotation is purely visual variety)
    const ca = Math.cos(t.yaw), sa = Math.sin(t.yaw);
    for (let i = 0; i < n; i++) {
      const x = srcPos[i * 3], z = srcPos[i * 3 + 2];
      positions.push(x * ca + z * sa, srcPos[i * 3 + 1], -x * sa + z * ca);
      uvs.push(srcUv[i * 2], srcUv[i * 2 + 1]);
      normals.push(0, 1, 0);
    }
    for (let i = 0; i < n; i++) {
      const x = srcPos[i * 3 + 2], z = -srcPos[i * 3]; // 90° cross
      positions.push(x * ca + z * sa, srcPos[i * 3 + 1], -x * sa + z * ca);
      uvs.push(srcUv[i * 2], srcUv[i * 2 + 1]);
      normals.push(0, 1, 0);
    }
    for (let i = 0; i < srcIdx.length; i++) indices.push(vertBase + srcIdx[i]);
    for (let i = 0; i < srcIdx.length; i++) indices.push(vertBase + n + srcIdx[i]);
    for (let i = 0; i < n * 2; i++) tuftArr.push(t.ox, t.oz, t.hMul, t.phase);
    vertBase += n * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute("aTuft", new THREE.BufferAttribute(new Float32Array(tuftArr), 4));
  geo.setIndex(indices);
  base.dispose();
  return geo;
}

/**
 * Flower head: per stem, `plumesPerFlower` plumes ALL JOINED AT THE ORIGIN
 * (the stem tip) and fanning out around local +X — a feather spray, like the
 * real miscanthus flower (the GoT reference shows ~5 plumes per head).
 * Each plume is 2 crossed cards drooping along its own fan direction, with
 * per-plume length/droop variation. The VS rotates the whole head so +X
 * points DOWNWIND, so the fan spreads around the wind direction.
 */
export function createPlumeGeometry(sp, tufts = 1) {
  const W = sp.plumeWidth, H = sp.plumeHeight, droop = sp.plumeDroop;
  const plumes = Math.max(1, Math.round(sp.plumesPerFlower ?? 5));
  const spreadRad = ((sp.flowerSpread ?? 65) * Math.PI) / 180;
  const crossAngles = [0, Math.PI / 2];
  const ws = 2, hs = 6;
  const layout = tuftLayout(tufts);
  const positions = [], uvs = [], normals = [], tuftArr = [], indices = [];
  let vertBase = 0;

  // deterministic per-plume jitter
  let seed = 4242;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (const t of layout) {
    for (let k = 0; k < plumes; k++) {
      // fan angles centered on +X (downwind after the VS rotation)
      const fk = plumes === 1 ? 0 : (k / (plumes - 1)) * 2 - 1; // -1..1
      const yawK = fk * spreadRad + (rand() - 0.5) * 0.25;
      const lenMul = 0.82 + rand() * 0.28;
      const droopMul = 0.85 + rand() * 0.4 + Math.abs(fk) * 0.25; // outer droop more
      const cy = Math.cos(yawK), sy = Math.sin(yawK);

      for (const a of crossAngles) {
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let j = 0; j <= hs; j++) {
          const v = j / hs;
          const y = v * H * lenMul;
          const arc = droop * droopMul * H * lenMul * v * v;
          for (let i = 0; i <= ws; i++) {
            const u01 = i / ws;
            const x0 = (u01 - 0.5) * W * 0.85; // slightly narrower per plume
            // card in plume-local space (droop along +X), then fan-rotate
            const px = x0 * ca + arc;
            const pz = -x0 * sa;
            positions.push(px * cy + pz * sy, y, -px * sy + pz * cy);
            uvs.push(u01, v);
            normals.push(sa, 0, ca);
            tuftArr.push(t.ox, t.oz, t.hMul, t.phase + k * 0.13);
          }
        }
        for (let j = 0; j < hs; j++) {
          for (let i = 0; i < ws; i++) {
            const r0 = vertBase + j * (ws + 1) + i, r1 = r0 + ws + 1;
            indices.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
          }
        }
        vertBase += (hs + 1) * (ws + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute("aTuft", new THREE.BufferAttribute(new Float32Array(tuftArr), 4));
  geo.setIndex(indices);
  return geo;
}

// ── System ───────────────────────────────────────────────────────────────────

export class SusukiSystem {
  /**
   * @param {object} opts
   *   scene, renderer        — three
   *   heightTex              — RGBA float, .x = terrain world Y (grassHeightTex)
   *   terrainNormalTex       — RGBA float, .xyz = terrain normal
   *   densityTex             — painted susuki density (.x)
   *   windTex                — v2 createWindTexture() output (shared with grass)
   *   worldSize              — terrain world size (m)
   *   sp                     — susuki state (SUSUKI_DEFAULTS shape)
   *   gp                     — grassState (wind params shared with the grass)
   *   tileSize, plantsPerSide — wrap-tile config (default 400 / 288 ≈ 83k)
   */
  constructor({
    scene,
    renderer,
    heightTex,
    terrainNormalTex,
    densityTex,
    windTex,
    worldSize,
    sp,
    gp,
    tileSize = 400,
    plantsPerSide = 288,
  }) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = "Susuki";
    scene.add(this.group);

    this.count = plantsPerSide * plantsPerSide;
    this.tileSize = tileSize;
    this._tufts = Math.max(1, Math.round(sp.tufts ?? 5));

    const windRad = ((gp.windAngle ?? 0) * Math.PI) / 180;
    const u = (this.u = {
      uAnchorPos: uniform(new THREE.Vector3()),
      uAnchorDeltaXZ: uniform(new THREE.Vector2()),
      uTileSize: uniform(tileSize),
      uTerrainSize: uniform(worldSize),
      uCameraMatrix: uniform(new THREE.Matrix4()),
      uFx: uniform(1),
      uFy: uniform(1),
      uCameraPos: uniform(new THREE.Vector3()),
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
      // wind — synced from grassState so grass + plumes move together
      uWindSpeed: uniform(gp.windSpeed ?? 0.2),
      uWindStrength: uniform((gp.windStrength ?? 1.4) * (sp.windMul ?? 1)),
      uWindGust: uniform(gp.windGust ?? 0.3),
      uWindWaveScale: uniform(gp.windWaveScale ?? 0.12),
      uWindDir: uniform(new THREE.Vector2(Math.cos(windRad), Math.sin(windRad))),
      // player interaction (same anchor the grass uses)
      uPlayerPos: uniform(new THREE.Vector3()),
      uInteractRadius: uniform(sp.interactRadius ?? 2.2),
      uInteractStrength: uniform(sp.interactStrength ?? 1.2),
      // plant
      uDensity: uniform(sp.density ?? 1),
      uStemH: uniform(sp.stemHeight ?? 1.9),
      uStemHVar: uniform(sp.stemHeightVar ?? 0.26),
      uStemFlex: uniform(sp.stemFlex ?? 0.45),
      uLean: uniform(sp.lean ?? 0.08),
      uStemBase: uniform(srgb(sp.stemBase ?? "#2c4018")),
      uStemTip: uniform(srgb(sp.stemTip ?? "#6f7a40")),
      // plume
      uPlumeSize: uniform(sp.plumeSize ?? 1.1),
      uPlumeBase: uniform(srgb(sp.plumeBase ?? "#d0c8b2")),
      uPlumeTip: uniform(srgb(sp.plumeTip ?? "#f7f4ea")),
      uPlumeAO: uniform(sp.plumeAO ?? 0.62),
      uPlumeGlow: uniform(sp.plumeGlow ?? 0.2),
      uBacklitInt: uniform(sp.backlitIntensity ?? 1.7),
      uBacklitPow: uniform(sp.backlitPower ?? 6),
      uFlutter: uniform(sp.flutter ?? 0.05),
      // windows / culls
      uOuterR0: uniform(sp.fadeStart ?? 150),
      uOuterR1: uniform(sp.fadeEnd ?? 195),
      uSlopeMinY: uniform(sp.slopeMinY ?? 0.55),
      uCullPadNdcX: uniform(0.45),
      uCullPadNdcYNear: uniform(0.75),
      uCullPadNdcYFar: uniform(0.45),
    });

    // ── Plume strand texture ──
    this._plumeCanvas = document.createElement("canvas");
    this._plumeCanvas.width = PLUME_TEX_W;
    this._plumeCanvas.height = PLUME_TEX_H;
    drawPlumeTexture(this._plumeCanvas, sp);
    this.plumeTex = new THREE.CanvasTexture(this._plumeCanvas);
    this.plumeTex.colorSpace = THREE.SRGBColorSpace;
    this.plumeTex.anisotropy = 8;

    // ── Geometry ──
    const stemGeo = createStemGeometry(sp.stemWidth ?? 0.03, this._tufts);
    const plumeGeo = createPlumeGeometry(sp, this._tufts);

    // ── SSBOs ──
    // bufPos: x,y = tile-local offset (wraps with anchor), z free, w = terrain Y
    // bufDir: x,y = smoothed WORLD-SPACE bend vector (wind + player push);
    //         its length is the bend angle, its direction the lean direction
    const bufPos = instancedArray(this.count, "vec4");
    const bufDir = instancedArray(this.count, "vec4");
    const compactBuf = instancedArray(this.count, "uint");
    this._buffers = { bufPos, bufDir, compactBuf };

    // ── Indirect draw args, one per mesh (index counts differ) ──
    const mkIndirect = (geo) => {
      const data = new Uint32Array(5);
      data[0] = geo.index.count;
      const attr = new THREE.IndirectStorageBufferAttribute(data, 5);
      if (typeof geo.setIndirect === "function") geo.setIndirect(attr);
      else geo.indirect = attr;
      return attr;
    };
    this._stemIndirect = mkIndirect(stemGeo);
    this._plumeIndirect = mkIndirect(plumeGeo);
    const stemIndirectStorage = storage(this._stemIndirect, "uint", 5).toAtomic();
    const plumeIndirectStorage = storage(this._plumeIndirect, "uint", 5).toAtomic();

    this.computeReset = Fn(() => {
      atomicStore(stemIndirectStorage.element(1), uint(0));
      atomicStore(plumeIndirectStorage.element(1), uint(0));
    })().compute(1, [1]);

    const fSide = float(plantsPerSide);
    const fSpacing = float(tileSize / plantsPerSide);
    const fHalf = float(tileSize * 0.5);

    // ── INIT: jittered grid ──
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
      const d = bufDir.element(instanceIndex);
      d.x.assign(float(0));
      d.y.assign(float(0));
    })().compute(this.count, [64]);

    // Per-plant stem height — MUST match the VS's derivation exactly.
    const stemHOf = (id) =>
      u.uStemH.mul(
        mix(float(1).sub(u.uStemHVar), float(1).add(u.uStemHVar), hash(id.add(911))),
      );

    // ── UPDATE: once per plant — density, slope, window, bend vector, culls ──
    this.computeUpdate = Fn(() => {
      const p = bufPos.element(instanceIndex);

      const wrapped = wrapTileOffsetXZ(vec2(p.x, p.y), u.uAnchorDeltaXZ, u.uTileSize);
      p.x.assign(wrapped.x);
      p.y.assign(wrapped.y);

      const worldX = wrapped.x.add(u.uAnchorPos.x);
      const worldZ = wrapped.y.add(u.uAnchorPos.z);
      const terrainUV = vec2(worldX, worldZ).div(u.uTerrainSize).add(0.5);

      const terrainY = texture(heightTex, terrainUV).x;
      const tN = texture(terrainNormalTex, terrainUV).xyz;
      const painted = texture(densityTex, terrainUV).x;
      const hasDensity = smoothstep(float(0.0), float(0.005), painted);
      const worldPos = vec3(worldX, terrainY, worldZ);

      const densityKeep = step(
        hash(instanceIndex.add(7919)),
        u.uDensity.mul(painted),
      ).mul(hasDensity);

      // playable-map edge fade
      const mapHalf = u.uTerrainSize.mul(0.5);
      const outMax = max(abs(worldX), abs(worldZ));
      const mapStay = float(1).sub(smoothstep(mapHalf.sub(2), mapHalf.add(0.35), outMax));

      // radial fade-out window (dist² like Revo)
      const dxA = worldX.sub(u.uAnchorPos.x);
      const dzA = worldZ.sub(u.uAnchorPos.z);
      const distSqA = dxA.mul(dxA).add(dzA.mul(dzA));
      const tOut = smoothstep(u.uOuterR0.mul(u.uOuterR0), u.uOuterR1.mul(u.uOuterR1), distSqA);
      const pKeep = float(1).sub(tOut);

      // slope rejection — susuki grows on flat-ish ground
      const slopeProb = smoothstep(u.uSlopeMinY, u.uSlopeMinY.add(0.15), tN.y);

      const stochasticKeep = step(hash(instanceIndex.add(31337)), pKeep.mul(slopeProb));

      const stemH = stemHOf(instanceIndex);
      const frustumVis = computeFrustumVisibility(
        worldPos,
        u.uCameraMatrix,
        u.uFx,
        u.uFy,
        stemH.add(u.uPlumeSize.mul(1.6)).add(float(0.5)), // tussock spread pad
        u.uCullPadNdcX,
        u.uCullPadNdcYNear,
        u.uCullPadNdcYFar,
      );

      const vis = densityKeep.mul(mapStay).mul(stochasticKeep).mul(frustumVis);

      If(vis.greaterThan(0.5), () => {
        const slot = atomicAdd(stemIndirectStorage.element(1), uint(1));
        atomicAdd(plumeIndirectStorage.element(1), uint(1));
        compactBuf.element(slot).assign(instanceIndex);

        // ── Wind (same baked windTex channels as the hybrid grass) ──
        const tBase = time.mul(u.uWindSpeed);
        const dirX = u.uWindDir.x;
        const dirZ = u.uWindDir.y;
        const waveUV = vec2(
          worldX.mul(u.uWindWaveScale).add(dirX.mul(tBase)).div(8.0),
          worldZ.mul(u.uWindWaveScale).add(dirZ.mul(tBase)).div(8.0),
        );
        const gustUV = vec2(
          worldX.mul(u.uWindWaveScale).mul(0.25).add(dirX.mul(tBase).mul(0.3)).div(3.0),
          worldZ.mul(u.uWindWaveScale).mul(0.25).add(dirZ.mul(tBase).mul(0.3)).div(3.0),
        );
        const wave = texture(windTex, waveUV).x.mul(2).sub(1);
        const gustRaw = texture(windTex, gustUV).y.mul(2).sub(1);
        const micro = sin(tBase.add(hash(instanceIndex).mul(PI2)).mul(3.5)).mul(0.07);
        const gustStr = smoothstep(float(0.5), float(0.9), gustRaw).mul(u.uWindGust);
        const windScaled = wave.mul(0.5).add(0.5).add(gustStr).add(micro)
          .mul(u.uWindStrength);

        // Wind bend magnitude (tall stiff stems: scaled by flex)
        const windMag = u.uLean.add(windScaled.mul(u.uStemFlex).mul(0.35));

        // ── Player push: radial part around the anchor (walk/ride through) ──
        const toPlant = vec2(worldX.sub(u.uPlayerPos.x), worldZ.sub(u.uPlayerPos.z));
        const pDist = length(toPlant);
        const pFall = float(1).sub(smoothstep(float(0.3), u.uInteractRadius, pDist));
        const pushDir = toPlant.div(max(pDist, float(0.001)));
        const pushMag = pFall.mul(u.uInteractStrength);

        // ── World-space bend vector: downwind + away from player, eased
        // across compute ticks so throttled updates never step visibly ──
        const targetX = dirX.mul(windMag).add(pushDir.x.mul(pushMag));
        const targetZ = dirZ.mul(windMag).add(pushDir.y.mul(pushMag));
        const d = bufDir.element(instanceIndex);
        const kF = float(0.18);
        d.x.assign(d.x.add(targetX.sub(d.x).mul(kF)));
        d.y.assign(d.y.add(targetZ.sub(d.y).mul(kF)));

        p.w.assign(terrainY);
      });
    })().compute(this.count, [64]);

    // ── Materials ──
    // — stems —
    const stemMat = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
    });
    stemMat.envMapIntensity = 0;
    stemMat.positionNode = Fn(() => {
      const id = compactBuf.element(instanceIndex);
      const p = bufPos.element(id);
      const d = bufDir.element(id);
      const tuft = attribute("aTuft", "vec4");
      const h = uv().y;
      const stemH = stemHOf(id).mul(tuft.z);

      const mag = length(vec2(d.x, d.y));
      const invMag = float(1).div(max(mag, float(1e-4)));
      const bendX = d.x.mul(invMag);
      const bendZ = d.y.mul(invMag);

      const angle = mag.mul(pow(max(h, 1e-4), 1.6)); // bend high up only
      const L = h.mul(stemH);
      const horiz = sin(angle).mul(L);
      normalLocal.assign(vec3(0, 1, 0));
      return vec3(
        positionLocal.x.add(horiz.mul(bendX)).add(tuft.x).add(p.x),
        cos(angle).mul(L).add(p.w),
        positionLocal.z.add(horiz.mul(bendZ)).add(tuft.y).add(p.y),
      );
    })();
    stemMat.colorNode = mix(u.uStemBase, u.uStemTip, pow(uv().y, 1.4));

    this.stemMesh = new THREE.Mesh(stemGeo, stemMat);
    this.stemMesh.count = this.count;
    this.stemMesh.frustumCulled = false;
    this.stemMesh.castShadow = false;
    this.stemMesh.receiveShadow = false;
    this.group.add(this.stemMesh);

    // — plumes —
    const plumeMat = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      alphaTest: sp.alphaTest ?? 0.2,
      alphaToCoverage: true,
    });
    plumeMat.envMapIntensity = 0;
    const vPWorld = varying(vec3(0), "v_su_w");
    const vPHue = varying(float(0), "v_su_hue");

    const rotY = (ang, v) => {
      const cc = cos(ang);
      const ss = sin(ang);
      return vec3(
        v.x.mul(cc).add(v.z.mul(ss)),
        v.y,
        negate(v.x).mul(ss).add(v.z.mul(cc)),
      );
    };

    plumeMat.positionNode = Fn(() => {
      const id = compactBuf.element(instanceIndex);
      const p = bufPos.element(id);
      const d = bufDir.element(id);
      const tuft = attribute("aTuft", "vec4");
      const stemH = stemHOf(id).mul(tuft.z);
      const scale = mix(float(0.8), float(1.2), hash(id.add(577))).mul(u.uPlumeSize);

      const mag = length(vec2(d.x, d.y));
      const invMag = float(1).div(max(mag, float(1e-4)));
      const bendX = d.x.mul(invMag);
      const bendZ = d.y.mul(invMag);
      // rotY(a, (1,0,0)) = (cos a, 0, -sin a) → a = atan2(-z, x) points the
      // plume's droop (+X) along the bend/wind direction — the whole field
      // leans the same way, and parts around the player with the push vector.
      // Small per-tuft jitter keeps it organic.
      const yawA = atan(negate(bendZ), bendX)
        .add(tuft.w.sub(0.5).mul(0.5));

      // ride the stem tip: rotate the plume by the tip angle (≈ mag at h=1)
      // in the bend plane, then translate to the arc tip
      const local = positionLocal.mul(scale);
      const ca = cos(mag), sa = sin(mag);
      const bent = vec3(
        local.x.mul(ca).add(local.y.mul(sa)),
        local.y.mul(ca).sub(local.x.mul(sa)),
        local.z,
      );
      const tip = vec3(sin(mag).mul(stemH), cos(mag).mul(stemH), 0);
      const fl = sin(time.mul(5.2).add(tuft.w.mul(37)).add(positionLocal.y.mul(2.5)))
        .mul(u.uFlutter).mul(uv().y.add(0.15));
      const pR = rotY(yawA, bent.add(tip).add(vec3(fl, 0, fl.mul(0.6))));
      normalLocal.assign(vec3(0, 1, 0)); // soft top-lit fluff
      const out = vec3(
        pR.x.add(tuft.x).add(p.x),
        pR.y.add(p.w),
        pR.z.add(tuft.y).add(p.y),
      );
      vPWorld.assign(out.add(vec3(u.uAnchorPos.x, 0, u.uAnchorPos.z)));
      vPHue.assign(hash(id.add(3197)));
      return out;
    })();

    const plumeSample = texture(this.plumeTex, uv());
    plumeMat.opacityNode = plumeSample.a;
    plumeMat.colorNode = Fn(() => {
      const v = uv().y;
      const col = mix(u.uPlumeBase, u.uPlumeTip, smoothstep(0.1, 0.85, v));
      const warm = mix(col, col.mul(vec3(1.07, 1.0, 0.88)), vPHue); // straw tint
      // dense strand cores brighter than the fringe → soft interior depth
      const strandShade = mix(float(0.8), float(1), plumeSample.a);
      return warm.mul(strandShade).mul(mix(u.uPlumeAO, float(1), smoothstep(0.0, 0.5, v)));
    })();
    plumeMat.emissiveNode = Fn(() => {
      const viewDir = normalize(cameraPosition.sub(vPWorld));
      // silver lining: light traveling -sunDir continues into the camera
      const backlit = pow(max(dot(viewDir, negate(u.uSunDir)), 0), u.uBacklitPow)
        .mul(u.uBacklitInt);
      const col = mix(u.uPlumeBase, u.uPlumeTip, uv().y);
      return col.mul(backlit.add(u.uPlumeGlow));
    })();
    this._plumeMat = plumeMat;

    this.plumeMesh = new THREE.Mesh(plumeGeo, plumeMat);
    this.plumeMesh.count = this.count;
    this.plumeMesh.frustumCulled = false;
    this.plumeMesh.castShadow = false;
    this.plumeMesh.receiveShadow = false;
    this.group.add(this.plumeMesh);

    this._lastAnchor = new THREE.Vector3();
    this._anchorDelta = new THREE.Vector2();
    this._cameraMatrix = new THREE.Matrix4();
    this._initDone = false;
    this._enabled = false;
    this.group.visible = false;
  }

  async init(camera) {
    await this.renderer.computeAsync(this.computeInit);
    await this.renderer.computeAsync([this.computeReset, this.computeUpdate]);
    this._initDone = true;
    await this.renderer.compileAsync(this.stemMesh, camera);
    await this.renderer.compileAsync(this.plumeMesh, camera);
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled;
  }

  /** Redraw the plume strand texture after texStrands/texSpread/... changes. */
  redrawPlumeTexture(sp) {
    drawPlumeTexture(this._plumeCanvas, sp);
    this.plumeTex.needsUpdate = true;
  }

  /** Swap plume geometry (plumeWidth/Height/Droop + tufts are baked). */
  rebuildPlumeGeometry(sp) {
    this._tufts = Math.max(1, Math.round(sp.tufts ?? this._tufts));
    const geo = createPlumeGeometry(sp, this._tufts);
    this._plumeIndirect.array[0] = geo.index.count;
    this._plumeIndirect.needsUpdate = true;
    if (typeof geo.setIndirect === "function") geo.setIndirect(this._plumeIndirect);
    else geo.indirect = this._plumeIndirect;
    const old = this.plumeMesh.geometry;
    this.plumeMesh.geometry = geo;
    old?.dispose();
  }

  /** Swap stem geometry (stemWidth + tufts are baked). */
  rebuildStemGeometry(sp) {
    this._tufts = Math.max(1, Math.round(sp.tufts ?? this._tufts));
    const geo = createStemGeometry(sp.stemWidth ?? 0.03, this._tufts);
    this._stemIndirect.array[0] = geo.index.count;
    this._stemIndirect.needsUpdate = true;
    if (typeof geo.setIndirect === "function") geo.setIndirect(this._stemIndirect);
    else geo.indirect = this._stemIndirect;
    const old = this.stemMesh.geometry;
    this.stemMesh.geometry = geo;
    old?.dispose();
  }

  /** Live sync — sp = susuki state, gp = grassState (shared wind), sunDir. */
  syncFromState(sp, gp, sunDir) {
    const u = this.u;
    u.uWindSpeed.value = gp.windSpeed ?? 0.2;
    u.uWindStrength.value = (gp.windStrength ?? 1.4) * (sp.windMul ?? 1);
    u.uWindGust.value = gp.windGust ?? 0.3;
    u.uWindWaveScale.value = gp.windWaveScale ?? 0.12;
    const wr = ((gp.windAngle ?? 0) * Math.PI) / 180;
    u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));

    u.uDensity.value = sp.density ?? 1;
    u.uStemH.value = sp.stemHeight ?? 1.9;
    u.uStemHVar.value = sp.stemHeightVar ?? 0.26;
    u.uStemFlex.value = sp.stemFlex ?? 0.45;
    u.uLean.value = sp.lean ?? 0.08;
    u.uStemBase.value.copy(srgb(sp.stemBase ?? "#2c4018"));
    u.uStemTip.value.copy(srgb(sp.stemTip ?? "#6f7a40"));
    u.uPlumeSize.value = sp.plumeSize ?? 1.1;
    u.uPlumeBase.value.copy(srgb(sp.plumeBase ?? "#d0c8b2"));
    u.uPlumeTip.value.copy(srgb(sp.plumeTip ?? "#f7f4ea"));
    u.uPlumeAO.value = sp.plumeAO ?? 0.62;
    u.uPlumeGlow.value = sp.plumeGlow ?? 0.2;
    u.uBacklitInt.value = sp.backlitIntensity ?? 1.7;
    u.uBacklitPow.value = sp.backlitPower ?? 6;
    u.uFlutter.value = sp.flutter ?? 0.05;
    u.uInteractRadius.value = sp.interactRadius ?? 2.2;
    u.uInteractStrength.value = sp.interactStrength ?? 1.2;
    u.uOuterR0.value = sp.fadeStart ?? 150;
    u.uOuterR1.value = Math.max(sp.fadeEnd ?? 195, (sp.fadeStart ?? 150) + 1);
    u.uSlopeMinY.value = sp.slopeMinY ?? 0.55;
    if (this._plumeMat.alphaTest !== (sp.alphaTest ?? 0.2)) {
      this._plumeMat.alphaTest = sp.alphaTest ?? 0.2;
      this._plumeMat.needsUpdate = true;
    }
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
    this.stemMesh.position.set(anchorPos.x, 0, anchorPos.z);
    this.plumeMesh.position.set(anchorPos.x, 0, anchorPos.z);
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

    // Synchronous per-frame compute, queued ahead of this frame's render —
    // same cadence the hybrid grass runs at (see hybridGrassSystem.update).
    this.renderer.compute([this.computeReset, this.computeUpdate]);
  }
}
