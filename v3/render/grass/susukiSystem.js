/**
 * Susuki (miscanthus / pampas) field — the Ghost-of-Tsushima silver plumes,
 * proven in v3/susuki-lab.html, rebuilt on the HybridGrassSystem skeleton so it
 * costs like the hybrid grass instead of like the lab:
 *
 *   - camera-following wrap tile (infinite field, fixed instance budget)
 *   - ALL per-plant work in ONE compute pass (paint density, slope reject,
 *     radial fade window, frustum cull, wind force smoothed across ticks)
 *   - atomic compaction + GPU-written indirect draws: culled plants cost ZERO
 *     vertex work; the CPU never knows or cares how many plants are visible
 *   - per-plant identity derived from hash(instanceIndex) — the only SSBO is
 *     one vec4 per plant (tile offset, smoothed force, terrain Y)
 *
 * Two draws total: stems (crossed thin ribbons, opaque) + plumes (3 crossed
 * cards, alpha-tested procedural strand texture, backlit silver-lining
 * emissive). Both read the same compact list, so they always agree.
 *
 * Wind is the same baked windTex the hybrid grass samples, driven by the SAME
 * grassState wind params — gusts sweep the plumes and the grass together.
 */
import * as THREE from "three";
import {
  Fn,
  If,
  abs,
  atomicAdd,
  atomicStore,
  cameraPosition,
  clamp,
  cos,
  dot,
  float,
  floor,
  hash,
  instanceIndex,
  instancedArray,
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

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Crossed thin ribbon for the stem — second copy pre-rotated 90° (baked). */
export function createStemGeometry(width) {
  const base = createBladeGeometry(1.0, width, 4, 0.9);
  const srcPos = base.attributes.position.array;
  const srcUv = base.attributes.uv.array;
  const srcNorm = base.attributes.normal.array;
  const srcIdx = base.index.array;
  const n = base.attributes.position.count;

  const positions = new Float32Array(n * 2 * 3);
  positions.set(srcPos, 0);
  for (let i = 0; i < n; i++) {
    positions[(n + i) * 3 + 0] = srcPos[i * 3 + 2];
    positions[(n + i) * 3 + 1] = srcPos[i * 3 + 1];
    positions[(n + i) * 3 + 2] = -srcPos[i * 3 + 0];
  }
  const uvs = new Float32Array(n * 2 * 2);
  uvs.set(srcUv, 0); uvs.set(srcUv, n * 2);
  const normals = new Float32Array(n * 2 * 3);
  normals.set(srcNorm, 0); normals.set(srcNorm, n * 3);
  const indices = new Uint16Array(srcIdx.length * 2);
  indices.set(srcIdx, 0);
  for (let i = 0; i < srcIdx.length; i++) indices[srcIdx.length + i] = srcIdx[i] + n;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  base.dispose();
  return geo;
}

/**
 * Plume tuft: 3 crossed cards that all droop the same local +X.
 * (Rotating an already-drooped card would fan the tuft into a fountain;
 * rotating flat cards THEN adding the shared +X arc keeps it one coherent
 * tuft from every view angle — the GoT read.)
 */
export function createPlumeGeometry(sp) {
  const W = sp.plumeWidth, H = sp.plumeHeight, droop = sp.plumeDroop;
  const angles = [0, Math.PI / 3, (2 * Math.PI) / 3];
  const ws = 2, hs = 6;
  const positions = [], uvs = [], normals = [], indices = [];
  let base = 0;
  for (const a of angles) {
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let j = 0; j <= hs; j++) {
      const v = j / hs;
      const y = v * H;
      const arc = droop * H * v * v;
      for (let i = 0; i <= ws; i++) {
        const u01 = i / ws;
        const x0 = (u01 - 0.5) * W;
        positions.push(x0 * ca + arc, y, -x0 * sa);
        uvs.push(u01, v);
        normals.push(sa, 0, ca);
      }
    }
    for (let j = 0; j < hs; j++) {
      for (let i = 0; i < ws; i++) {
        const r0 = base + j * (ws + 1) + i, r1 = r0 + ws + 1;
        indices.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
      }
    }
    base += (hs + 1) * (ws + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(normals), 3));
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
    const stemGeo = createStemGeometry(sp.stemWidth ?? 0.03);
    const plumeGeo = createPlumeGeometry(sp);

    // ── SSBOs ──
    // bufPos: x,y = tile-local offset (wraps with anchor),
    //         z = smoothed wind force, w = terrain Y
    const bufPos = instancedArray(this.count, "vec4");
    const compactBuf = instancedArray(this.count, "uint");
    this._buffers = { bufPos, compactBuf };

    // ── Indirect draw args, one per mesh (index counts differ) ──
    // Layout: [indexCount, instanceCount, firstIndex, baseVertex, firstInstance]
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
    })().compute(this.count, [64]);

    // Per-plant stem height — MUST match the VS's derivation exactly.
    const stemHOf = (id) =>
      u.uStemH.mul(
        mix(float(1).sub(u.uStemHVar), float(1).add(u.uStemHVar), hash(id.add(911))),
      );

    // ── UPDATE: once per plant — density, slope, window, wind, culls ──
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
        stemH.add(u.uPlumeSize.mul(1.6)),
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

        // Tall stiff stems: scaled by flex, eased across compute ticks so
        // throttled updates never step visibly (hybrid's k=0.18 smoothing).
        const targetForce = u.uLean.add(windScaled.mul(u.uStemFlex).mul(0.35));
        const prevForce = p.z;
        p.z.assign(prevForce.add(targetForce.sub(prevForce).mul(float(0.18))));
        p.w.assign(terrainY);
      });
    })().compute(this.count, [64]);

    // ── Materials ──
    const rotY = (ang, v) => {
      const cc = cos(ang);
      const ss = sin(ang);
      return vec3(
        v.x.mul(cc).add(v.z.mul(ss)),
        v.y,
        negate(v.x).mul(ss).add(v.z.mul(cc)),
      );
    };

    // — stems —
    const stemMat = new THREE.MeshStandardNodeMaterial({
      side: THREE.FrontSide,
      roughness: 0.9,
      metalness: 0,
    });
    stemMat.envMapIntensity = 0;
    stemMat.positionNode = Fn(() => {
      const id = compactBuf.element(instanceIndex);
      const p = bufPos.element(id);
      const h = uv().y;
      const stemH = stemHOf(id);
      const force = p.z;
      const yaw = hash(id.add(196)).mul(PI2);
      const angle = force.mul(pow(max(h, 1e-4), 1.6)); // bend high up only
      const L = h.mul(stemH);
      const pArc = vec3(
        sin(angle).mul(L).add(positionLocal.x),
        cos(angle).mul(L),
        positionLocal.z,
      );
      const pR = rotY(yaw, pArc);
      normalLocal.assign(vec3(0, 1, 0));
      return vec3(pR.x.add(p.x), pR.y.add(p.w), pR.z.add(p.y));
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

    plumeMat.positionNode = Fn(() => {
      const id = compactBuf.element(instanceIndex);
      const p = bufPos.element(id);
      const stemH = stemHOf(id);
      const force = p.z;
      const yaw = hash(id.add(196)).mul(PI2);
      const scale = mix(float(0.8), float(1.2), hash(id.add(577))).mul(u.uPlumeSize);

      // ride the stem tip: rotate the plume by the tip angle (≈ force at h=1)
      // in the bend plane, then translate to the arc tip
      const local = positionLocal.mul(scale);
      const ca = cos(force), sa = sin(force);
      const bent = vec3(
        local.x.mul(ca).add(local.y.mul(sa)),
        local.y.mul(ca).sub(local.x.mul(sa)),
        local.z,
      );
      const tip = vec3(sin(force).mul(stemH), cos(force).mul(stemH), 0);
      const phase = hash(id.add(2741));
      const fl = sin(time.mul(5.2).add(phase.mul(37)).add(positionLocal.y.mul(2.5)))
        .mul(u.uFlutter).mul(uv().y.add(0.15));
      const pR = rotY(yaw, bent.add(tip).add(vec3(fl, 0, fl.mul(0.6))));
      normalLocal.assign(vec3(0, 1, 0)); // soft top-lit fluff
      const out = vec3(pR.x.add(p.x), pR.y.add(p.w), pR.z.add(p.y));
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

  /** Swap plume geometry (plumeWidth/plumeHeight/plumeDroop are baked). */
  rebuildPlumeGeometry(sp) {
    const geo = createPlumeGeometry(sp);
    this._plumeIndirect.array[0] = geo.index.count;
    this._plumeIndirect.needsUpdate = true;
    if (typeof geo.setIndirect === "function") geo.setIndirect(this._plumeIndirect);
    else geo.indirect = this._plumeIndirect;
    const old = this.plumeMesh.geometry;
    this.plumeMesh.geometry = geo;
    old?.dispose();
  }

  /** Swap stem geometry (stemWidth is baked). */
  rebuildStemGeometry(sp) {
    const geo = createStemGeometry(sp.stemWidth ?? 0.03);
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
