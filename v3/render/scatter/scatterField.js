/**
 * The GPU scatter field — the machinery every painted plant shares (flowers,
 * foliage, and whatever comes next). It owns WHERE plants are; a plant module
 * owns what they look like.
 *
 * How it works
 *   - A camera-following WRAP TILE: a fixed instance budget whatever is
 *     painted. Plants sit on a jittered grid inside the tile, and the tile
 *     re-wraps around the camera as it moves, so the field is endless and the
 *     cost is constant.
 *   - ONE compute pass per frame does all per-plant work: painted density and
 *     type, clumping, slope, the type's own rules (height band, paint layer,
 *     near a river), map edge, distance fade, frustum cull, near/far detail,
 *     wind and player push.
 *   - Every (type × detail) is its own indirect draw, and all of them share ONE
 *     compact list and ONE indirect buffer: each draw's `firstInstance` points
 *     at its own slice, so `instance_index` in the vertex shader already
 *     addresses the right plants. Culled plants cost nothing.
 *   - A draw can have several PARTS — meshes with their own geometry and
 *     material that show the same plants (susuki: opaque stems + alpha-tested
 *     plumes). Every part of a draw gets the same instance count and slice.
 *
 * Per-plant state is two vec4s:
 *   bufPos  (tile x, tile z, type, terrain Y)
 *   bufDir  (bend x, bend z, distance fade 1→0, lift above painted grass in m)
 * Size, yaw, colour jitter and lean come from hash(plant id) in the shader, so
 * nothing else has to be stored.
 *
 * A plant module supplies: its per-type uniform rows, a geometry factory per
 * (type, detail level), and the material nodes. It reads the buffers through
 * `field.nodes`.
 */
import * as THREE from "three";
import {
  Fn, If, abs, atomicAdd, atomicStore, float, floor, hash, instanceIndex, instancedArray, int,
  length, max, min, sin, smoothstep, step, storage, texture, time, uint, uniform, uniformArray,
  vec2, vec3, vec4, PI2,
} from "three/tsl";
import { wrapTileOffsetXZ } from "../../../v2/core/revoGrass/revoGrassTile.js";
import { scatterClump, scatterRuleKeep } from "./scatterNoise.js";

/**
 * Is a plant of this radius at this base point on screen? The base is
 * projected, then the screen edges are pushed OUT by the plant's radius on
 * every side (the grass's test only padded the bottom and pulled the top IN,
 * which culled every fern within a few metres of a camera looking down).
 * A plant closer to the camera than its own radius is always kept: its
 * projection is meaningless there and it is certainly in view.
 */
const scatterFrustumVisible = Fn(([worldPos, cameraMatrix, fx, fy, radius, padX, padYNear, padYFar]) => {
  const clip = cameraMatrix.mul(vec4(worldPos, 1));
  const depth = clip.w.abs().max(1e-4);
  const ndc = clip.xyz.div(depth);
  const rX = fx.mul(radius).div(depth).add(padX);
  const rY = fy.mul(radius).div(depth);
  const inX = step(float(-1).sub(rX), ndc.x).mul(step(ndc.x, float(1).add(rX)));
  const inY = step(float(-1).sub(rY).sub(padYNear), ndc.y).mul(step(ndc.y, float(1).add(rY).add(padYFar)));
  const inFront = step(float(0), clip.w).mul(step(ndc.z, float(1)));
  const nearCamera = step(clip.w.abs(), radius);
  return max(nearCamera, inX.mul(inY).mul(inFront));
});

export class ScatterField {
  /**
   * @param {object} o
   *   scene, renderer
   *   name              group and mesh name prefix ("Flowers", "Foliage"…)
   *   typeCount         plant types (one painted density channel each)
   *   lods              detail levels per type (default 2: near, far)
   *   rows              uniform vec4 rows per type — the plant module's own packing
   *   ruleRow           which row holds (heightMin, heightMax, layer, riverDist), or null for no rules
   *   worldSize         terrain edge (m)
   *   tileSize, plantsPerSide   wrap tile (192 m / 384 ≈ 147k slots, 0.5 m apart)
   *   heightTex         RGBA float, .x = terrain world Y
   *   terrainNormalTex  RGBA float, .xyz = terrain normal
   *   densityTex        masked painted density, one type per channel — a single
   *                     texture, or an array of them when there are more than
   *                     four types (four fit in one RGBA page)
   *   splatTex          SplatMap.tex — the "grows on paint layer" rule
   *   riverNearTex      River v2 distance field (.r = distance² in UV), or null
   *   windTex           shared wind texture (grass / susuki / flowers)
   *   grassDensityTex   masked grass density (.x), or null — plants rise above painted grass
   *   parts             meshes per draw that show the same plants (default 1)
   *   cullRadius        metres of slack in the frustum test (a tall plant needs
   *                     more) — a number, or a float node
   *   fadeKeepGain      how early the distance fade starts thinning plants out
   *                     (keep = fade × gain, capped at 1; 1 = thin across the
   *                     whole fade window)
   *   slopeBand         normal.y width of the slope cut-off's soft edge
   *   onKeep            optional hook, called inside the compute for plants that
   *                     survive: ({ worldX, worldZ, terrainUV, terrainY, normal,
   *                     typeIdx, near, distSq, p, d }) => void
   */
  constructor({
    scene, renderer, name = "Scatter", typeCount, lods = 2, parts = 1, rows, ruleRow = null,
    worldSize, tileSize = 192, plantsPerSide = 384,
    heightTex, terrainNormalTex, densityTex, splatTex, riverNearTex = null, windTex,
    grassDensityTex = null, cullRadius = 2, fadeKeepGain = 1.6, slopeBand = 0.12, onKeep = null,
  }) {
    this.renderer = renderer;
    this.name = name;
    this.typeCount = typeCount;
    this.lods = lods;
    this.parts = parts;
    this.rows = rows;
    const draws = (this.draws = typeCount * lods);
    // One mesh (and one indirect entry) per draw × part.
    const meshCount = (this.meshCount = draws * parts);
    const count = (this.count = plantsPerSide * plantsPerSide);

    this.group = new THREE.Group();
    this.group.name = name;
    this.group.visible = false;
    scene.add(this.group);

    // No River v2 in the scene: a field that reads "no river anywhere".
    const noRiver = new THREE.DataTexture(new Float32Array([1e9, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    noRiver.needsUpdate = true;
    const riverTex = riverNearTex ?? noRiver;
    const densityPages = Array.isArray(densityTex) ? densityTex : [densityTex];

    this.typeRows = Array.from({ length: typeCount * rows }, () => new THREE.Vector4());
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
      uLodDist: uniform(18),
      uLodDist2: uniform(40),   // second switch, when lods = 3
      uOuterR0: uniform(62),
      uOuterR1: uniform(88),
      uSlopeMinY: uniform(0.7),
      uCullPadNdcX: uniform(0.35),
      uCullPadNdcYNear: uniform(0.6),
      uCullPadNdcYFar: uniform(0.35),
      uTypes: uniformArray(this.typeRows, "vec4"),
    });

    const bufPos = instancedArray(count, "vec4");
    const bufDir = instancedArray(count, "vec4");
    // One compact list, `draws` slices of `count` each.
    const compactBuf = instancedArray(count * draws, "uint");
    this.nodes = { bufPos, bufDir, compactBuf };

    // One indirect buffer: 5 args per mesh; firstInstance = its draw's slice.
    const args = new Uint32Array(meshCount * 5);
    for (let m = 0; m < meshCount; m++) args[m * 5 + 4] = Math.floor(m / parts) * count;
    const indirect = new THREE.IndirectStorageBufferAttribute(args, 5);
    this._indirect = indirect;
    const indirectStorage = storage(indirect, "uint", meshCount * 5).toAtomic();

    this.computeReset = Fn(() => {
      for (let m = 0; m < meshCount; m++) atomicStore(indirectStorage.element(m * 5 + 1), uint(0));
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
      bufDir.element(instanceIndex).assign(vec4(0));
    })().compute(count, [64]);

    // ── UPDATE: once per plant, every frame ──
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
      // WHICH type, weighted by each channel's share. Four types live in one
      // texture, so more than four means more than one page.
      const weights = [];
      for (const tex of densityPages) {
        const paint = texture(tex, terrainUV);
        weights.push(paint.r, paint.g, paint.b, paint.a);
      }
      const used = weights.slice(0, typeCount);
      const total = used.reduce((a, w) => a.add(w)).toVar();
      const clump = scatterClump(vec2(worldX, worldZ), u.uClumpFreq, u.uClumping);
      const densityKeep = step(hash(instanceIndex.add(7919)), u.uDensity.mul(min(total, 1)).mul(clump))
        .mul(smoothstep(0.0, 0.005, total));
      // Walk the running sum: the pick lands in exactly one type's share.
      const pick = hash(instanceIndex.add(2711)).mul(total);
      let running = used[0];
      let idx = step(running, pick);
      for (let i = 1; i < used.length - 1; i++) {
        running = running.add(used[i]);
        idx = idx.add(step(running, pick));
      }
      const typeIdx = idx.toVar();

      const mapHalf = u.uTerrainSize.mul(0.5);
      const mapStay = float(1).sub(smoothstep(mapHalf.sub(2), mapHalf.add(0.35), max(abs(worldX), abs(worldZ))));

      const dxA = worldX.sub(u.uAnchorPos.x);
      const dzA = worldZ.sub(u.uAnchorPos.z);
      const distSq = dxA.mul(dxA).add(dzA.mul(dzA)).toVar();
      const near = float(1).sub(smoothstep(u.uOuterR0.mul(u.uOuterR0), u.uOuterR1.mul(u.uOuterR1), distSq)).toVar();
      const slopeProb = smoothstep(u.uSlopeMinY, u.uSlopeMinY.add(slopeBand), tN.y);
      // The picked type's own rules: height band, paint layer, near a river.
      const bandKeep = ruleRow === null ? float(1) : scatterRuleKeep(
        u.uTypes.element(int(floor(typeIdx.add(0.5))).mul(rows).add(ruleRow)), terrainY,
        texture(splatTex, terrainUV).depth(int(0)), texture(splatTex, terrainUV).depth(int(1)),
        texture(riverTex, terrainUV).r, float(worldSize),
      );
      const stochasticKeep = step(hash(instanceIndex.add(31337)), near.mul(fadeKeepGain).min(1).mul(slopeProb).mul(bandKeep));

      const frustumVis = scatterFrustumVisible(
        vec3(worldX, terrainY, worldZ), u.uCameraMatrix, u.uFx, u.uFy,
        typeof cullRadius === "number" ? float(cullRadius) : cullRadius,
        u.uCullPadNdcX, u.uCullPadNdcYNear, u.uCullPadNdcYFar,
      );

      If(densityKeep.mul(mapStay).mul(stochasticKeep).mul(frustumVis).greaterThan(0.5), () => {
        // Near or far detail. The switch distance is spread ±2 m per plant so
        // the change never forms a visible ring.
        const dither = hash(instanceIndex.add(555)).mul(4).sub(2);
        const lodR = u.uLodDist.add(dither);
        let lod = lods > 1 ? step(lodR.mul(lodR), distSq) : float(0);
        if (lods > 2) {
          const lodR2 = u.uLodDist2.add(dither.mul(2));
          lod = lod.add(step(lodR2.mul(lodR2), distSq));
        }
        const drawK = int(typeIdx.mul(lods).add(lod));
        for (let k = 0; k < draws; k++) {
          If(drawK.equal(k), () => {
            const slot = atomicAdd(indirectStorage.element(k * parts * 5 + 1), uint(1));
            compactBuf.element(slot.add(uint(k * count))).assign(instanceIndex);
            // The other parts only need the same count.
            for (let q = 1; q < parts; q++) atomicAdd(indirectStorage.element((k * parts + q) * 5 + 1), uint(1));
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
        // Smoothed over frames: wind and push arrive as a bend vector, never a jump.
        const kF = float(0.18);
        d.x.assign(d.x.add(dirX.mul(windMag).add(pushDir.x.mul(pushMag)).sub(d.x).mul(kF)));
        d.y.assign(d.y.add(dirZ.mul(windMag).add(pushDir.y.mul(pushMag)).sub(d.y).mul(kF)));
        d.z.assign(near);
        d.w.assign(grassDensityTex
          ? texture(grassDensityTex, terrainUV).x.mul(u.uGrassHeight).mul(u.uGrassLift)
          : float(0));
        p.z.assign(typeIdx);
        p.w.assign(terrainY);

        onKeep?.({ worldX, worldZ, terrainUV, terrainY, normal: tN, typeIdx, near, distSq, p, d });
      });
    })().compute(count, [64]);

    this.meshes = [];
    this.triangles = new Array(meshCount).fill(0);
    this._lastAnchor = new THREE.Vector3();
    this._cameraMatrix = new THREE.Matrix4();
    this._initDone = false;
    this._enabled = false;
  }

  /** The uniform row `r` of the type a plant carries (rounded — an interpolated 1 can arrive as 0.99999). */
  rowOf(typeNode, r) {
    return this.u.uTypes.element(int(floor(typeNode.add(0.5))).mul(this.rows).add(r));
  }

  /** Mesh index of (type, detail level, part). */
  meshIndex(type, lod = 0, part = 0) { return (type * this.lods + lod) * this.parts + part; }

  /**
   * Create the meshes once the plant module's material exists.
   * @param {THREE.Material|THREE.Material[]} material one for every part, or one per part
   */
  attachMaterial(material) {
    const mats = Array.isArray(material) ? material : [material];
    this.material = mats[0];
    for (let m = 0; m < this.meshCount; m++) {
      const part = m % this.parts;
      const k = Math.floor(m / this.parts);
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mats[Math.min(part, mats.length - 1)]);
      mesh.count = this.count;
      mesh.frustumCulled = false;   // the compute culls, per plant
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `${this.name}:type${Math.floor(k / this.lods)}:lod${k % this.lods}` +
        (this.parts > 1 ? `:part${part}` : "");
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /**
   * Rebuild one type's meshes after a shape setting changed.
   * @param {number} i type index
   * @param {(lod:number, part:number) => { geometry: THREE.BufferGeometry, triangles: number }} makeGeometry
   * @param {number[]} [onlyParts] rebuild just these parts (default: all)
   */
  rebuildType(i, makeGeometry, onlyParts = null) {
    for (let lod = 0; lod < this.lods; lod++) {
      for (let part = 0; part < this.parts; part++) {
        if (onlyParts && !onlyParts.includes(part)) continue;
        const m = this.meshIndex(i, lod, part);
        const { geometry, triangles } = makeGeometry(lod, part);
        this._indirect.array[m * 5] = geometry.index.count;
        geometry.setIndirect(this._indirect, m * 5 * 4);
        const mesh = this.meshes[m];
        const old = mesh.geometry;
        mesh.geometry = geometry;
        old?.dispose();
        this.triangles[m] = triangles;
      }
    }
    this._indirect.needsUpdate = true;
  }

  /** Shadows on the near detail level only, and only when asked. */
  setReceiveShadows(on) {
    for (let m = 0; m < this.meshCount; m++) {
      this.meshes[m].receiveShadow = !!on && Math.floor(m / this.parts) % this.lods === 0;
    }
  }

  /**
   * Hide the draws of types nobody painted. An indirect draw with no instances
   * still costs a submission, and most scenes use two or three plants of eight.
   * @param {boolean[]} used one flag per type
   */
  setUsedTypes(used) {
    const key = used.map((u) => (u ? 1 : 0)).join("");
    if (key === this._usedKey) return;
    this._usedKey = key;
    for (let m = 0; m < this.meshCount; m++) this.meshes[m].visible = !!used[Math.floor(m / (this.parts * this.lods))];
  }

  /**
   * The settings every scattered plant has. A plant module passes its own state
   * plus grassState for the shared wind.
   */
  syncCommon({ wind = null, density, sizeVar, colorVar, clumping, clumpSize, grassLift, flex,
    interactRadius, interactStrength, lodDistance, lodDistance2, fadeStart, fadeEnd, slopeMinY }) {
    const u = this.u;
    if (wind) {
      u.uWindSpeed.value = wind.windSpeed ?? 0.2;
      u.uWindStrength.value = (wind.windStrength ?? 1.4) * (wind.windMul ?? 1);
      u.uWindGust.value = wind.windGust ?? 0.3;
      u.uWindWaveScale.value = wind.windWaveScale ?? 0.12;
      const wr = ((wind.windAngle ?? 0) * Math.PI) / 180;
      u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
      u.uGrassHeight.value = wind.bladeHeight ?? 1;
    }
    const set = (uni, v) => { if (v !== undefined) uni.value = v; };
    set(u.uDensity, density);
    set(u.uSizeVar, sizeVar);
    set(u.uColorVar, colorVar);
    set(u.uClumping, clumping);
    if (clumpSize !== undefined) u.uClumpFreq.value = 1 / Math.max(0.5, clumpSize);
    set(u.uGrassLift, grassLift);
    set(u.uFlex, flex);
    set(u.uInteractRadius, interactRadius);
    set(u.uInteractStrength, interactStrength);
    set(u.uLodDist, lodDistance);
    if (lodDistance2 !== undefined) u.uLodDist2.value = Math.max(lodDistance2, (lodDistance ?? 0) + 2);
    set(u.uOuterR0, fadeStart);
    if (fadeEnd !== undefined) u.uOuterR1.value = Math.max(fadeEnd, (fadeStart ?? 0) + 1);
    set(u.uSlopeMinY, slopeMinY);
  }

  async init(camera) {
    await this.renderer.computeAsync(this.computeInit);
    await this.renderer.computeAsync([this.computeReset, this.computeUpdate]);
    this._initDone = true;
    for (const m of this.meshes) await this.renderer.compileAsync(m, camera);
  }

  get ready() { return this._initDone; }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled;
  }

  /** Per frame: move the tile with the anchor, then run the compute. */
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
