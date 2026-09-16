/**
 * Meadow flowers — real petal geometry, placed and culled on the GPU.
 *
 *   - camera-following wrap tile: a fixed instance budget, however much is painted
 *   - ONE compute pass per frame does all per-plant work: painted type and
 *     density (blocking paint layers and holes already masked out), clumping,
 *     slope, grass height, radial fade, frustum cull, near/far detail, wind and
 *     player push
 *   - every (type × detail) is its own indirect draw — at most 8 — and all of
 *     them share ONE compact list and ONE indirect buffer: each draw's
 *     `firstInstance` points at its own slice, so `instance_index` in the vertex
 *     shader already addresses the right plants. Culled plants cost nothing.
 *
 * Per-plant state is two vec4s (tile position, terrain Y, type; bend vector,
 * fade, grass height); size, yaw, colour jitter and lean come from hash(id).
 *
 * Why geometry rather than alpha-masked cards: the petals' outline is exact at
 * every distance and never shimmers, MSAA smooths it like any mesh edge, and
 * no fragment is discarded, so hidden flowers are rejected by the depth test
 * before shading. See flowerGeometry.js.
 */
import * as THREE from "three";
import {
  Fn,
  If,
  abs,
  atomicAdd,
  atomicStore,
  attribute,
  cameraPosition,
  cameraViewMatrix,
  cos,
  dot,
  exp,
  faceDirection,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedArray,
  int,
  length,
  max,
  min,
  mix,
  normalLocal,
  normalize,
  pow,
  positionLocal,
  saturate,
  select,
  sin,
  smoothstep,
  step,
  storage,
  texture,
  time,
  uint,
  uniform,
  uniformArray,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
  PI2,
} from "three/tsl";
import { wrapTileOffsetXZ } from "../../../v2/core/revoGrass/revoGrassTile.js";
import { computeFrustumVisibility } from "../../../v2/core/revoGrass/revoGrassSsboUtils.js";
import { FLOWER_TYPE_COUNT } from "../../app/state/flowerState.js";
import { createFlowerTypeGeometry } from "./flowerGeometry.js";
import { scatterClump, scatterRuleKeep } from "../scatter/scatterNoise.js";

const LODS = 2;
const DRAWS = FLOWER_TYPE_COUNT * LODS;
const ROWS = 5; // uniform rows per type

export class FlowerSystem {
  /**
   * @param {object} opts
   *   scene, renderer
   *   heightTex         RGBA float, .x = terrain world Y (grassHeightTex)
   *   terrainNormalTex  RGBA float, .xyz = terrain normal
   *   densityTex        masked flower density, one type per channel
   *   grassDensityTex   masked grass density (.x) — flowers rise above painted grass
   *   splatTex          SplatMap.tex — for the "grows on paint layer" rule
   *   riverNearTex      River v2 distance field (.r = distance² in UV), or null
   *   windTex           shared wind texture (grass / susuki)
   *   worldSize         terrain edge (m)
   *   fp                flower state (createFlowerState shape)
   *   gp                grassState (wind params, blade height)
   *   tileSize, plantsPerSide  wrap tile (default 192 m / 384 ≈ 147k slots, 0.5 m apart)
   */
  constructor({ scene, renderer, heightTex, terrainNormalTex, densityTex, grassDensityTex, splatTex, riverNearTex = null, windTex, worldSize, fp, gp, tileSize = 192, plantsPerSide = 384 }) {
    this.renderer = renderer;
    this.group = new THREE.Group();
    this.group.name = "Flowers";
    scene.add(this.group);
    const count = (this.count = plantsPerSide * plantsPerSide);
    // No River v2 yet: a field that reads "no river anywhere".
    const noRiver = new THREE.DataTexture(new Float32Array([1e9, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    noRiver.needsUpdate = true;
    const riverTex = riverNearTex ?? noRiver;

    // Per type: (petalBase.rgb, translucency) (petalTip.rgb, size) (centre.rgb, stemHeight) (veins, 0, 0, 0)
    //           (heightMin, heightMax, paint layer or -1, river distance m or 0) — scatterRuleKeep
    this._typeRows = Array.from({ length: FLOWER_TYPE_COUNT * ROWS }, () => new THREE.Vector4());
    const u = (this.u = {
      uAnchorPos: uniform(new THREE.Vector3()),
      uAnchorDeltaXZ: uniform(new THREE.Vector2()),
      uTileSize: uniform(tileSize),
      uTerrainSize: uniform(worldSize),
      uCameraMatrix: uniform(new THREE.Matrix4()),
      uFx: uniform(1),
      uFy: uniform(1),
      uWindSpeed: uniform(0.2),
      uWindStrength: uniform(1.4),
      uWindGust: uniform(0.3),
      uWindWaveScale: uniform(0.12),
      uWindDir: uniform(new THREE.Vector2(1, 0)),
      uPlayerPos: uniform(new THREE.Vector3()),
      uInteractRadius: uniform(1.2),
      uInteractStrength: uniform(0.9),
      uDensity: uniform(0.55),
      uSizeVar: uniform(0.25),
      uColorVar: uniform(0.1),
      uClumping: uniform(0.7),
      uClumpFreq: uniform(0.25),
      uGrassHeight: uniform(1),
      uGrassLift: uniform(0.8),
      uFlex: uniform(0.5),
      uFlutter: uniform(0.6),
      uGlowLight: uniform(0.08),
      uTransMul: uniform(1),
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
      uStemBase: uniform(new THREE.Color()),
      uStemTop: uniform(new THREE.Color()),
      uLodDist: uniform(18),
      uOuterR0: uniform(62),
      uOuterR1: uniform(88),
      uSlopeMinY: uniform(0.7),
      uCullPadNdcX: uniform(0.35),
      uCullPadNdcYNear: uniform(0.6),
      uCullPadNdcYFar: uniform(0.35),
      uTypes: uniformArray(this._typeRows, "vec4"),
    });

    // ── SSBOs ──
    // bufPos: x,y = tile-local offset, z = type, w = terrain Y
    // bufDir: x,y = smoothed world-space bend, z = distance fade (1 near → 0), w = grass lift (m)
    const bufPos = instancedArray(count, "vec4");
    const bufDir = instancedArray(count, "vec4");
    // One compact list, DRAWS slices of `count` each.
    const compactBuf = instancedArray(count * DRAWS, "uint");

    // One indirect buffer: 5 args per draw; firstInstance = the draw's slice.
    const args = new Uint32Array(DRAWS * 5);
    for (let k = 0; k < DRAWS; k++) args[k * 5 + 4] = k * count;
    const indirect = new THREE.IndirectStorageBufferAttribute(args, 5);
    this._indirect = indirect;
    const indirectStorage = storage(indirect, "uint", DRAWS * 5).toAtomic();

    this.computeReset = Fn(() => {
      for (let k = 0; k < DRAWS; k++) atomicStore(indirectStorage.element(k * 5 + 1), uint(0));
    })().compute(1, [1]);

    const fSide = float(plantsPerSide);
    const fSpacing = float(tileSize / plantsPerSide);
    const fHalf = float(tileSize * 0.5);

    this.computeInit = Fn(() => {
      const p = bufPos.element(instanceIndex);
      const row = floor(float(instanceIndex).div(fSide));
      const col = float(instanceIndex).mod(fSide);
      p.x.assign(col.mul(fSpacing).sub(fHalf).add(hash(instanceIndex.add(4321)).mul(fSpacing)));
      p.y.assign(row.mul(fSpacing).sub(fHalf).add(hash(instanceIndex.add(1234)).mul(fSpacing)));
      p.z.assign(0);
      p.w.assign(0);
      const d = bufDir.element(instanceIndex);
      d.assign(vec4(0));
    })().compute(count, [64]);

    // ── UPDATE: once per plant ──
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

      // Paint: the total decides whether a plant grows; a second hash picks
      // WHICH type, weighted by each channel's share.
      const paint = texture(densityTex, terrainUV);
      const total = paint.r.add(paint.g).add(paint.b).add(paint.a).toVar();
      // Clumps and gaps — the same noise the far-field terrain tint uses.
      const clump = scatterClump(vec2(worldX, worldZ), u.uClumpFreq, u.uClumping);
      const densityKeep = step(hash(instanceIndex.add(7919)), u.uDensity.mul(min(total, 1)).mul(clump))
        .mul(smoothstep(0.0, 0.005, total));
      const pick = hash(instanceIndex.add(2711)).mul(total);
      const typeIdx = step(paint.r, pick)
        .add(step(paint.r.add(paint.g), pick))
        .add(step(paint.r.add(paint.g).add(paint.b), pick)).toVar();

      const mapHalf = u.uTerrainSize.mul(0.5);
      const mapStay = float(1).sub(smoothstep(mapHalf.sub(2), mapHalf.add(0.35), max(abs(worldX), abs(worldZ))));

      const dxA = worldX.sub(u.uAnchorPos.x);
      const dzA = worldZ.sub(u.uAnchorPos.z);
      const distSq = dxA.mul(dxA).add(dzA.mul(dzA)).toVar();
      const near = float(1).sub(smoothstep(u.uOuterR0.mul(u.uOuterR0), u.uOuterR1.mul(u.uOuterR1), distSq)).toVar();
      const slopeProb = smoothstep(u.uSlopeMinY, u.uSlopeMinY.add(0.12), tN.y);
      // The picked type's own rules: height band, paint layer, near a river.
      const rule = u.uTypes.element(int(floor(typeIdx.add(0.5))).mul(ROWS).add(4));
      const bandKeep = scatterRuleKeep(
        rule, terrainY,
        texture(splatTex, terrainUV).depth(int(0)), texture(splatTex, terrainUV).depth(int(1)),
        texture(riverTex, terrainUV).r, float(worldSize),
      );
      const stochasticKeep = step(hash(instanceIndex.add(31337)), near.mul(1.6).min(1).mul(slopeProb).mul(bandKeep));

      const frustumVis = computeFrustumVisibility(
        vec3(worldX, terrainY, worldZ), u.uCameraMatrix, u.uFx, u.uFy,
        float(2), u.uCullPadNdcX, u.uCullPadNdcYNear, u.uCullPadNdcYFar,
      );

      If(densityKeep.mul(mapStay).mul(stochasticKeep).mul(frustumVis).greaterThan(0.5), () => {
        // Near or far detail. The switch distance is spread ±2 m per plant so
        // the change never forms a visible ring.
        const lodR = u.uLodDist.add(hash(instanceIndex.add(555)).mul(4).sub(2));
        const lod = step(lodR.mul(lodR), distSq);
        const drawK = int(typeIdx.mul(LODS).add(lod));
        for (let k = 0; k < DRAWS; k++) {
          If(drawK.equal(k), () => {
            const slot = atomicAdd(indirectStorage.element(k * 5 + 1), uint(1));
            compactBuf.element(slot.add(uint(k * count))).assign(instanceIndex);
          });
        }

        // Wind — the same baked channels as the grass and susuki.
        const tBase = time.mul(u.uWindSpeed);
        const dirX = u.uWindDir.x, dirZ = u.uWindDir.y;
        const waveUV = vec2(
          worldX.mul(u.uWindWaveScale).add(dirX.mul(tBase)).div(8.0),
          worldZ.mul(u.uWindWaveScale).add(dirZ.mul(tBase)).div(8.0),
        );
        const gustUV = vec2(
          worldX.mul(u.uWindWaveScale).mul(0.25).add(dirX.mul(tBase).mul(0.3)).div(3.0),
          worldZ.mul(u.uWindWaveScale).mul(0.25).add(dirZ.mul(tBase).mul(0.3)).div(3.0),
        );
        const wave = texture(windTex, waveUV).x.mul(2).sub(1);
        const gust = smoothstep(0.5, 0.9, texture(windTex, gustUV).y.mul(2).sub(1)).mul(u.uWindGust);
        const micro = sin(tBase.add(hash(instanceIndex).mul(PI2)).mul(4.1)).mul(0.1);
        const windMag = wave.mul(0.5).add(0.5).add(gust).add(micro).mul(u.uWindStrength).mul(u.uFlex).mul(0.3);

        const toPlant = vec2(worldX.sub(u.uPlayerPos.x), worldZ.sub(u.uPlayerPos.z));
        const pDist = length(toPlant);
        const pFall = float(1).sub(smoothstep(0.2, u.uInteractRadius, pDist));
        const pushDir = toPlant.div(max(pDist, 0.001));
        const pushMag = pFall.mul(u.uInteractStrength);

        const d = bufDir.element(instanceIndex);
        const kF = float(0.18);
        d.x.assign(d.x.add(dirX.mul(windMag).add(pushDir.x.mul(pushMag)).sub(d.x).mul(kF)));
        d.y.assign(d.y.add(dirZ.mul(windMag).add(pushDir.y.mul(pushMag)).sub(d.y).mul(kF)));
        d.z.assign(near);
        // Rise above painted grass, by its blade height.
        d.w.assign(texture(grassDensityTex, terrainUV).x.mul(u.uGrassHeight).mul(u.uGrassLift));
        p.z.assign(typeIdx);
        p.w.assign(terrainY);
      });
    })().compute(count, [64]);

    // ── Material (shared by every draw) ──
    const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.72, metalness: 0 });
    mat.envMapIntensity = 0.5;
    this._mat = mat;

    const vPart = varying(float(0), "v_fl_part");
    const vT = varying(float(0), "v_fl_t");
    const vType = varying(float(0), "v_fl_type");
    const vRand = varying(float(0), "v_fl_rand");
    const vPlant = varying(float(0), "v_fl_plant");
    const vWorld = varying(vec3(0), "v_fl_world");
    const vNormal = varying(vec3(0, 1, 0), "v_fl_normal");

    // ROUND the type, never truncate: an interpolated 1 can arrive as 0.99999.
    const row = (t, r) => u.uTypes.element(int(floor(t.add(0.5))).mul(ROWS).add(r));

    /** Rotate v so +Y leans toward (bx, bz) by angle a. */
    const tilt = (v, a, bx, bz) => {
      const along = v.x.mul(bx).add(v.z.mul(bz));
      const ca = cos(a), sa = sin(a);
      const shift = along.mul(ca).add(v.y.mul(sa)).sub(along);
      return vec3(v.x.add(bx.mul(shift)), along.negate().mul(sa).add(v.y.mul(ca)), v.z.add(bz.mul(shift)));
    };
    const yawRot = (v, c, s) => vec3(v.x.mul(c).sub(v.z.mul(s)), v.y, v.x.mul(s).add(v.z.mul(c)));

    mat.positionNode = Fn(() => {
      const id = instanceIndex.toVar();
      const plant = compactBuf.element(id);
      const p = bufPos.element(plant);
      const d = bufDir.element(plant);
      const a = attribute("aFlower", "vec4");
      const part = a.x, t = a.y, along = a.w;
      const r1 = row(p.z, 1);
      const r2 = row(p.z, 2);

      const fade = mix(float(0.3), float(1), d.z);
      const size = r1.w.mul(mix(float(1).sub(u.uSizeVar), float(1).add(u.uSizeVar), hash(plant.add(577)))).mul(fade);
      const hasStem = step(0.001, r2.w);
      // ±35%: a field of equal stems reads as planted lollipops.
      const stemH = r2.w.mul(mix(float(0.65), float(1.35), hash(plant.add(911)))).mul(fade).add(d.w.mul(hasStem));
      // Stemless blooms: their own small height each (overlapping neighbours
      // never share a depth) plus the grass they stand in.
      const groundLift = float(0.02).add(hash(plant.add(71)).mul(size).mul(0.25)).add(d.w).mul(float(1).sub(hasStem));

      const mag = length(vec2(d.x, d.y));
      const inv = float(1).div(max(mag, 1e-4));
      const bx = d.x.mul(inv), bz = d.y.mul(inv);
      const lean = mag.add(hash(plant.add(313)).mul(0.14));

      const yaw = hash(plant.add(131)).mul(PI2);
      const cy = cos(yaw), sy = sin(yaw);

      // Stem: thin tube, bending more toward its top, running into the bloom.
      const stemAngle = lean.mul(pow(max(t, 1e-4), 1.6));
      const radius = float(0.004).add(size.mul(0.022)).mul(hasStem);
      const stemPos = tilt(vec3(positionLocal.x.mul(radius), t.mul(stemH.add(size.mul(0.05))), positionLocal.z.mul(radius)), stemAngle, bx, bz);
      const stemN = tilt(normalLocal, stemAngle, bx, bz);

      // Bloom (petals + centre): sized, turned, flutter on the petals, riding the tip.
      const flutter = sin(time.mul(6.5).add(a.z.mul(31)).add(hash(plant).mul(17)))
        .mul(u.uFlutter).mul(0.05).mul(along).mul(step(part, 0.5));
      const bloomLocal = yawRot(positionLocal.mul(size), cy, sy).add(vec3(0, flutter.mul(size), 0));
      const tip = tilt(vec3(0, stemH, 0), lean, bx, bz);
      const bloomPos = tilt(bloomLocal, lean, bx, bz).add(tip);
      const bloomN = tilt(yawRot(normalLocal, cy, sy), lean, bx, bz);

      // Leaf: attached at its stem height, riding the bent stem.
      const leafAngle = lean.mul(pow(max(t, 1e-4), 1.6));
      const leafBase = tilt(vec3(0, t.mul(stemH), 0), leafAngle, bx, bz);
      const leafFlutter = sin(time.mul(4.2).add(a.z.mul(23)).add(hash(plant).mul(11))).mul(u.uFlutter).mul(0.03).mul(along);
      const leafLocal = yawRot(positionLocal.mul(size).mul(hasStem), cy, sy).add(vec3(0, leafFlutter.mul(size), 0));
      const leafPos = tilt(leafLocal, leafAngle.add(0.1), bx, bz).add(leafBase);
      const leafN = tilt(yawRot(normalLocal, cy, sy), leafAngle, bx, bz);

      const isStem = part.greaterThan(1.5).and(part.lessThan(2.5));
      const isLeaf = part.greaterThan(2.5);
      const pos = select(isLeaf, leafPos, select(isStem, stemPos, bloomPos));
      const nrm = select(isLeaf, leafN, select(isStem, stemN, bloomN));

      vPart.assign(part);
      vT.assign(select(part.lessThan(1.5), along, t));
      vType.assign(p.z);
      vRand.assign(a.z);
      vPlant.assign(hash(plant.add(3197)));
      vNormal.assign(nrm);
      const out = vec3(pos.x.add(p.x), pos.y.add(p.w).add(groundLift), pos.z.add(p.y));
      vWorld.assign(out.add(vec3(u.uAnchorPos.x, 0, u.uAnchorPos.z)));
      return out;
    })();

    // Smooth analytic normals, in view space, facing the camera on both sides.
    // Petals and leaves: bent halfway to UP and never flipped for back faces. A
    // true curved-petal normal lights a white daisy grey from the side and its
    // underside near black; foliage in games is lit "from above" so a bloom
    // reads bright from any angle. Stems and centres keep their real normal.
    const thin = vPart.lessThan(0.5).or(vPart.greaterThan(2.5));
    const nW = normalize(vNormal);
    const nThin = normalize(mix(nW, vec3(0, 1, 0), 0.55));
    mat.normalNode = select(thin,
      cameraViewMatrix.mul(vec4(nThin, 0)).xyz.normalize(),
      cameraViewMatrix.mul(vec4(nW, 0)).xyz.normalize().mul(faceDirection));

    const baseColor = Fn(() => {
      const r0 = row(vType, 0);
      const r1 = row(vType, 1);
      const r2 = row(vType, 2);
      const r3 = row(vType, 3);
      const c = uv();
      // Petal: base → tip, a soft midrib vein, darker at the root, per petal and per plant jitter.
      const along = vT;
      const petal = mix(r0.xyz, r1.xyz, smoothstep(0.0, 0.85, along)).toVar();
      const vein = exp(c.x.sub(0.5).mul(c.x.sub(0.5)).mul(-160)).mul(float(1).sub(along)).mul(r3.x);
      petal.mulAssign(float(1).sub(vein.mul(0.35)));
      petal.mulAssign(mix(float(0.62), float(1), smoothstep(0.0, 0.3, along)));
      petal.mulAssign(float(0.92).add(vRand.mul(0.16)));
      // Centre: seeds speckle, darker rim.
      const cr = length(c.sub(0.5)).mul(2);
      const speckle = step(0.62, fract(sin(dot(floor(c.mul(22)), vec2(12.9898, 78.233))).mul(43758.5453)));
      const centre = r2.xyz.mul(mix(float(1.15), float(0.7), cr)).mul(float(1).sub(speckle.mul(0.25)));
      // Stem and leaf.
      const stem = mix(u.uStemBase, u.uStemTop, vT);
      const leaf = mix(u.uStemBase, u.uStemTop, float(0.35).add(uv().y.mul(0.5)))
        .mul(float(0.85).add(exp(c.x.sub(0.5).mul(c.x.sub(0.5)).mul(-200)).mul(0.25)));
      const col = select(vPart.lessThan(0.5), petal, select(vPart.lessThan(1.5), centre, select(vPart.lessThan(2.5), stem, leaf)));
      const j = vPlant.sub(0.5).mul(2).mul(u.uColorVar);
      return col.mul(vec3(float(1).add(j), float(1).add(j.mul(0.4)), float(1).sub(j.mul(0.3))));
    });
    const col = baseColor();
    mat.colorNode = col;

    // Light through petals and leaves when the sun is behind them.
    mat.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(vWorld));
      const behind = pow(saturate(dot(V, u.uSunDir.negate())), 3);
      const thin = select(vPart.lessThan(0.5), row(vType, 0).w, select(vPart.greaterThan(2.5), float(0.45), float(0)));
      return col.mul(behind.mul(thin).mul(u.uTransMul).mul(1.4).add(u.uGlowLight));
    })();

    // ── Meshes: one per (type × detail), sharing the material, buffer and list ──
    this.meshes = [];
    for (let k = 0; k < DRAWS; k++) {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.count = count;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `Flowers:type${Math.floor(k / LODS)}:lod${k % LODS}`;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.triangles = new Array(DRAWS).fill(0);
    for (let i = 0; i < FLOWER_TYPE_COUNT; i++) this.rebuildType(i, fp.types[i]);

    this._lastAnchor = new THREE.Vector3();
    this._cameraMatrix = new THREE.Matrix4();
    this._initDone = false;
    this._enabled = false;
    this.group.visible = false;
    this.syncFromState(fp, gp);
  }

  /** Rebuild one type's near + far meshes after a shape setting changed. */
  rebuildType(i, type) {
    for (let lod = 0; lod < LODS; lod++) {
      const k = i * LODS + lod;
      const { geometry, triangles } = createFlowerTypeGeometry(type, { lod });
      this._indirect.array[k * 5] = geometry.index.count;
      geometry.setIndirect(this._indirect, k * 5 * 4);
      const mesh = this.meshes[k];
      const old = mesh.geometry;
      mesh.geometry = geometry;
      old?.dispose();
      this.triangles[k] = triangles;
    }
    this._indirect.needsUpdate = true;
  }

  async init(camera) {
    await this.renderer.computeAsync(this.computeInit);
    await this.renderer.computeAsync([this.computeReset, this.computeUpdate]);
    this._initDone = true;
    for (const m of this.meshes) await this.renderer.compileAsync(m, camera);
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled;
  }

  /** fp = flower state, gp = grassState (shared wind, blade height), sunDir toward the sun. */
  syncFromState(fp, gp, sunDir) {
    const u = this.u;
    u.uWindSpeed.value = gp.windSpeed ?? 0.2;
    u.uWindStrength.value = (gp.windStrength ?? 1.4) * (fp.windMul ?? 1);
    u.uWindGust.value = gp.windGust ?? 0.3;
    u.uWindWaveScale.value = gp.windWaveScale ?? 0.12;
    const wr = ((gp.windAngle ?? 0) * Math.PI) / 180;
    u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
    u.uGrassHeight.value = gp.bladeHeight ?? 1;

    u.uDensity.value = fp.density;
    u.uSizeVar.value = fp.sizeVar;
    u.uColorVar.value = fp.colorVar;
    u.uClumping.value = fp.clumping;
    u.uClumpFreq.value = 1 / Math.max(0.5, fp.clumpSize);
    u.uGrassLift.value = fp.grassLift;
    u.uFlex.value = fp.flex;
    u.uFlutter.value = fp.flutter;
    u.uGlowLight.value = fp.glowLight;
    u.uTransMul.value = fp.translucencyMul;
    u.uStemBase.value.set(fp.stemBase);
    u.uStemTop.value.set(fp.stemTop);
    u.uInteractRadius.value = fp.interactRadius;
    u.uInteractStrength.value = fp.interactStrength;
    u.uLodDist.value = fp.lodDistance;
    u.uOuterR0.value = fp.fadeStart;
    u.uOuterR1.value = Math.max(fp.fadeEnd, fp.fadeStart + 1);
    u.uSlopeMinY.value = fp.slopeMinY;
    if (sunDir) u.uSunDir.value.copy(sunDir).normalize();

    const c = new THREE.Color();
    for (let i = 0; i < FLOWER_TYPE_COUNT; i++) {
      const t = fp.types[i];
      const o = i * ROWS;
      c.set(t.petalBase); this._typeRows[o].set(c.r, c.g, c.b, t.translucency);
      c.set(t.petalTip);  this._typeRows[o + 1].set(c.r, c.g, c.b, t.size);
      c.set(t.centre);    this._typeRows[o + 2].set(c.r, c.g, c.b, t.stemHeight);
      this._typeRows[o + 3].set(t.veins, 0, 0, 0);
      this._typeRows[o + 4].set(t.heightMin ?? -1e5, t.heightMax ?? 1e5, t.onLayer ?? -1, t.nearRiver ?? 0);
    }
    for (let k = 0; k < DRAWS; k++) this.meshes[k].receiveShadow = !!fp.receiveShadows && k % LODS === 0;
  }

  update(anchorPos, camera) {
    if (!this._initDone || !this._enabled) return;
    const u = this.u;
    u.uAnchorDeltaXZ.value.set(anchorPos.x - this._lastAnchor.x, anchorPos.z - this._lastAnchor.z);
    u.uAnchorPos.value.copy(anchorPos);
    u.uPlayerPos.value.copy(anchorPos);
    for (const m of this.meshes) m.position.set(anchorPos.x, 0, anchorPos.z);
    this._lastAnchor.copy(anchorPos);

    this._cameraMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uCameraMatrix.value.copy(this._cameraMatrix);
    const e = camera.projectionMatrix.elements;
    u.uFx.value = e[0];
    u.uFy.value = e[5];
    this.renderer.compute([this.computeReset, this.computeUpdate]);
  }
}
