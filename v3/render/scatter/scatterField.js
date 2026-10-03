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
 * SHADOWS (opt-in, `shadows: true`). The camera list is culled against the
 * camera, so it cannot cast: a plant just behind you would drop its shadow
 * from the frame the moment it left the screen, and every plant would cast
 * with its full leaf geometry. So the same compute fills a SECOND list per
 * type: every kept plant of a type that casts (uShadowCast) within
 * uShadowDist of the camera, in front or behind. It is drawn with the type's
 * cheapest detail level, on LAYERS.SCATTER_SHADOW, which only the near
 * cascade cameras enable (setShadowCameras) — the main camera never sees it.
 * Plants that only cast (behind the camera) still get their wind, so their
 * shadows move with the rest.
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
  length, max, min, renderGroup, sin, smoothstep, step, storage, texture, time, uint, uniform, uniformArray,
  vec2, vec3, vec4, PI2,
} from "three/tsl";
import { wrapTileOffsetXZ } from "../../../v2/core/revoGrass/revoGrassTile.js";
import { createClipmapGroundY } from "../../../v2/core/terrain/clipmapGroundY.js";
import { scatterClump, scatterRuleKeep } from "./scatterNoise.js";
import { scatterFrustumVisible } from "./gpuCull.js";
import { LAYERS } from "../layers.js";
import { markGpuOnly } from "../gpuOnlyArrays.js";

/** Hash seed of the setThin keep test — shared by the compute and thinScale. */
const THIN_SEED = 6151;
/** Share of the hash range over which a thinned plant shrinks from full to 0. */
const THIN_BAND = 0.1;
/**
 * The hash a plant must be under to stay, from the thin fraction k. Stretched
 * by the band so k = 1 leaves every plant at FULL size (no hash is within a
 * band of 1 + band), and k = 0 still removes them all.
 */
const thinThreshold = (k) => k.mul(1 + THIN_BAND);

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
   *   waterMapTex       waterSurfaceMap (.r = water surface world Y, NO_WATER_Y
   *                     where dry), or null — nothing grows under water
   *   windTex           shared wind texture (grass / susuki / flowers)
   *   grassDensityTex   masked grass density (.x), or null — plants rise above painted grass
   *   parts             meshes per draw that show the same plants (default 1)
   *   cullRadius        metres of slack in the frustum test (a tall plant needs
   *                     more) — a number, or a float node
   *   fadeKeepGain      how early the distance fade starts thinning plants out
   *                     (keep = fade × gain, capped at 1; 1 = thin across the
   *                     whole fade window)
   *   slopeBand         normal.y width of the slope cut-off's soft edge
   *   shadows           build the shadow-only lists (see the header)
   *   nearFade          metres: plants this close to the camera thin out
   *   onKeep            optional hook, called inside the compute for plants that
   *                     survive: ({ worldX, worldZ, terrainUV, terrainY, normal,
   *                     typeIdx, near, distSq, p, d }) => void
   */
  constructor({
    scene, renderer, name = "Scatter", typeCount, lods = 2, parts = 1, rows, ruleRow = null,
    // SHAPE VARIANTS per type (2026-09-27): each plant picks one by its own
    // hash, and every variant is its own mesh — so a grove is not one clump
    // turned round. 1 = exactly the old field (no extra draws, same compute).
    variants = 1,
    worldSize, tileSize = 192, plantsPerSide = 384,
    heightTex, terrainNormalTex, densityTex, splatTex, riverNearTex = null, windTex,
    waterMapTex = null,
    grassDensityTex = null, cullRadius = 2, fadeKeepGain = 1.6, slopeBand = 0.12, shadows = false,
    nearFade = 0.9, onKeep = null,
    // Detail levels that RECEIVE shadows, nearest first (setReceiveShadows).
    receiveLods = 1,
    // The clipmap description ({ centerXZ, baseStep, levels, halfCells,
    // gridOffset }), as the grass takes it. Omit it and plants fall back to
    // the raw heightmap and float wherever the mesh is coarse.
    terrainSurface = null,
  }) {
    const clipGroundY = terrainSurface ? createClipmapGroundY(terrainSurface) : null;
    this.renderer = renderer;
    this.name = name;
    this.typeCount = typeCount;
    this.lods = lods;
    this.parts = parts;
    this.rows = rows;
    this._ruleRow = ruleRow;   // the CPU cull reads the height band from it
    this.tileSize = tileSize;
    this.receiveLods = receiveLods;
    const V = (this.variants = Math.max(1, Math.round(variants)));
    const subTypes = typeCount * V;
    const draws = (this.draws = subTypes * lods);
    // One mesh (and one indirect entry) per draw × part.
    const meshCount = (this.meshCount = draws * parts);
    // Shadow lists: one slice per type after the draws' slices, and one mesh
    // (and indirect entry) per type × part after the draws' meshes.
    this.shadows = !!shadows;
    const shadowCount = (this.shadowMeshCount = shadows ? subTypes * parts : 0);
    const slices = draws + (shadows ? subTypes : 0);
    const count = (this.count = plantsPerSide * plantsPerSide);

    this.group = new THREE.Group();
    this.group.name = name;
    this.group.visible = false;
    scene.add(this.group);

    // No River v2 in the scene: a field that reads "no river anywhere".
    const noRiver = new THREE.DataTexture(new Float32Array([1e9, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    noRiver.needsUpdate = true;
    const riverTex = riverNearTex ?? noRiver;
    // No water map: one texel far below any terrain, so the dry test is a
    // constant 1 and costs a single tap of a 1×1 texture.
    const noWater = new THREE.DataTexture(new Float32Array([-1e4, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    noWater.needsUpdate = true;
    const waterTex = waterMapTex ?? noWater;
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
      // In three's SHARED render group, not the default per-object one: there
      // every draw of every pass got its own copy, uploaded again each frame
      // (alg 2026-10-03: ~1,070 uploads, 1.1 MB a frame, nearly all these
      // tables). Shared = one buffer per material, sent once per render pass.
      uTypes: uniformArray(this.typeRows, "vec4").setGroup(renderGroup),
      uShadowDist: uniform(35),
      // World XZ the shadow radius is measured from — see setShadowCentre.
      uShadowCentre: uniform(new THREE.Vector2()),
      // Plants closer than this to the CAMERA thin out (see the compute).
      uNearFade: uniform(nearFade),
      // Fraction of the plants that survive, on top of density — see setThin.
      uThin: uniform(1),
      uCamPos: uniform(new THREE.Vector3()),
    });
    // 1 per type that casts; read by the compute, set by setShadowCasters().
    this._shadowCastValues = new Array(typeCount).fill(0);
    u.uShadowCast = uniformArray(this._shadowCastValues, "float").setGroup(renderGroup);   // shared: see uTypes

    const bufPos = instancedArray(count, "vec4");
    const bufDir = instancedArray(count, "vec4");
    // One compact list: a slice of `count` per draw, then one per type's shadow list.
    const compactBuf = instancedArray(count * slices, "uint");
    this.nodes = { bufPos, bufDir, compactBuf };
    // GPU-only (computeInit fills them): a game may drop the CPU copies (gpuOnlyArrays).
    markGpuOnly(bufPos.value, bufDir.value, compactBuf.value);

    // One indirect buffer: 5 args per mesh; firstInstance = its slice.
    const entries = meshCount + shadowCount;
    const args = new Uint32Array(entries * 5);
    for (let m = 0; m < meshCount; m++) args[m * 5 + 4] = Math.floor(m / parts) * count;
    for (let m = 0; m < shadowCount; m++) args[(meshCount + m) * 5 + 4] = (draws + Math.floor(m / parts)) * count;
    const indirect = new THREE.IndirectStorageBufferAttribute(args, 5);
    this._indirect = indirect;
    const indirectStorage = storage(indirect, "uint", entries * 5).toAtomic();

    this.computeReset = Fn(() => {
      for (let m = 0; m < entries; m++) atomicStore(indirectStorage.element(m * 5 + 1), uint(0));
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
      // Stand on the MESH, not the heightmap. They are different surfaces: a
      // clipmap vertex sits on its level's lattice and reads one filtered tap,
      // so a plant placed at the exact heightmap height floats over any crest
      // the coarse mesh cuts under — which is what a river bank is made of.
      // Grass has stood on the triangles since hybridGrassSystem; this is the
      // same helper, so foliage and the tall plants now agree with it.
      const terrainY = clipGroundY
        ? clipGroundY(worldX, worldZ, heightTex, u.uTerrainSize)
        : texture(heightTex, terrainUV).x;
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
      // Which shape variant (a mesh of its own): its own hash, fixed per plant.
      const subIdx = V > 1
        ? typeIdx.mul(V).add(min(floor(hash(instanceIndex.add(4441)).mul(V)), float(V - 1))).toVar()
        : typeIdx;

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
      /*
       * NOTHING GROWS UNDER WATER. The rules above can say "within N metres of
       * a river", which is what a reed bed wants, but nothing said "and not IN
       * it" — so a painted band across a valley put a hedge straight down the
       * middle of the channel, plants standing on the riverbed with the water
       * drawn through them.
       *
       * The water-surface map already holds the answer: .r is the water's world
       * Y at this XZ, or far below any terrain where there is none, on the same
       * worldXZ/worldSize + 0.5 UV as every other world map here. So the test is
       * one tap and one compare against the ground the plant is standing on.
       *
       * Soft over the first 0.6 m of bank rather than hard at the waterline:
       * folded into the stochastic keep, it thins out toward the water instead
       * of ending on a drawn line, and it still leaves the margin for the reeds
       * and the nipa palm that are meant to have their feet wet.
       */
      const waterY = texture(waterTex, terrainUV).r;
      const dryKeep = smoothstep(waterY.add(0.05), waterY.add(0.65), terrainY);
      const stochasticKeep = step(hash(instanceIndex.add(31337)),
        near.mul(fadeKeepGain).min(1).mul(slopeProb).mul(bandKeep).mul(dryKeep));

      // RIGHT AT THE CAMERA a plant is a wall of leaves, and a leaf turned
      // edge-on is a flat sheet: it draws as a hairline streak across the
      // view. Plants inside uNearFade thin out stochastically (no pop, like
      // the detail switch), so you never end up inside one. They keep casting:
      // the shadow list below ignores this.
      const camDist = length(vec2(worldX.sub(u.uCamPos.x), worldZ.sub(u.uCamPos.z)));
      const nearKeep = step(hash(instanceIndex.add(9137)),
        smoothstep(u.uNearFade.mul(0.35), u.uNearFade, camDist));

      const frustumVis = scatterFrustumVisible(
        vec3(worldX, terrainY, worldZ), u.uCameraMatrix, u.uFx, u.uFy,
        typeof cullRadius === "number" ? float(cullRadius) : cullRadius,
        u.uCullPadNdcX, u.uCullPadNdcYNear, u.uCullPadNdcYFar,
      );

      // Casts a shadow: its type casts and it is within the shadow distance of
      // the shadow centre — on screen or not. The distance is spread ±3 m per
      // plant so the last shadows fade out instead of ending on a circle.
      const shadowR = u.uShadowDist.add(hash(instanceIndex.add(777)).mul(6).sub(3));
      const dxS = worldX.sub(u.uShadowCentre.x);
      const dzS = worldZ.sub(u.uShadowCentre.y);
      const castsShadow = shadows
        ? u.uShadowCast.element(int(floor(typeIdx.add(0.5)))).mul(step(dxS.mul(dxS).add(dzS.mul(dzS)), shadowR.mul(shadowR)))
        : float(0);
      const inView = frustumVis.greaterThan(0.5);
      // A runtime thinning, independent of the painted density: its own hash,
      // so the plants that go are always the same ones and a still camera never
      // flickers. 1 keeps every plant — bit for bit the old field. The vertex
      // stage shrinks a plant to nothing on its way out (thinScale), so this
      // cut happens at zero size and never shows as a pop.
      const thinKeep = step(hash(instanceIndex.add(THIN_SEED)), thinThreshold(u.uThin));

      If(densityKeep.mul(mapStay).mul(stochasticKeep).mul(thinKeep).mul(max(frustumVis, castsShadow)).greaterThan(0.5), () => {
        If(inView.and(nearKeep.greaterThan(0.5)), () => {
          // Near or far detail. The switch distance is spread ±2 m per plant so
          // the change never forms a visible ring.
          const dither = hash(instanceIndex.add(555)).mul(4).sub(2);
          const lodR = u.uLodDist.add(dither);
          // From the CAMERA (detail is screen size): the same as the anchor
          // wherever the anchor is the camera, and right when it leads the view.
          const camDistSq = camDist.mul(camDist);
          let lod = lods > 1 ? step(lodR.mul(lodR), camDistSq) : float(0);
          if (lods > 2) {
            const lodR2 = u.uLodDist2.add(dither.mul(2));
            lod = lod.add(step(lodR2.mul(lodR2), camDistSq));
          }
          const drawK = int(subIdx.mul(lods).add(lod));
          for (let k = 0; k < draws; k++) {
            If(drawK.equal(k), () => {
              const slot = atomicAdd(indirectStorage.element(k * parts * 5 + 1), uint(1));
              compactBuf.element(slot.add(uint(k * count))).assign(instanceIndex);
              // The other parts only need the same count.
              for (let q = 1; q < parts; q++) atomicAdd(indirectStorage.element((k * parts + q) * 5 + 1), uint(1));
            });
          }
        });
        if (shadows) {
          If(castsShadow.greaterThan(0.5), () => {
            const typeK = int(floor(subIdx.add(0.5)));
            for (let t = 0; t < subTypes; t++) {
              If(typeK.equal(t), () => {
                const slot = atomicAdd(indirectStorage.element((meshCount + t * parts) * 5 + 1), uint(1));
                compactBuf.element(slot.add(uint((draws + t) * count))).assign(instanceIndex);
                for (let q = 1; q < parts; q++) atomicAdd(indirectStorage.element((meshCount + t * parts + q) * 5 + 1), uint(1));
              });
            }
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
        // Scaled by the plant's flex, like the wind above: walking through
        // stiff canes must not fold them flat when it only bows a fern.
        const pushMag = pFall.mul(u.uInteractStrength).mul(u.uFlex);

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
    this.shadowMeshes = [];
    this.triangles = new Array(meshCount).fill(0);
    this._shadowCams = new Set();
    this._usedTypes = new Array(typeCount).fill(true);
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
  meshIndex(type, lod = 0, part = 0, variant = 0) { return ((type * this.variants + variant) * this.lods + lod) * this.parts + part; }

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
      // ONE, not the plant count: the draw is INDIRECT (the GPU writes the
      // instance count; three only skips a draw whose count is 0). three puts
      // the object's uuid into the shader cache key of anything with count > 1,
      // so every mesh of a field built its own copy of the same shader — alg-
      // rts: 579 builds at boot for 178 distinct shaders, the plant meshes most
      // of the 401 repeats (100-147 KB of WGSL each). All a field's meshes read
      // the same storage buffers (firstInstance picks the slice): one build.
      mesh.count = 1;
      mesh.frustumCulled = false;   // the compute culls, per plant
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const sub = Math.floor(k / this.lods);
      mesh.name = `${this.name}:type${Math.floor(sub / this.variants)}${this.variants > 1 ? `:v${sub % this.variants}` : ""}:lod${k % this.lods}` +
        (this.parts > 1 ? `:part${part}` : "");
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    for (let m = 0; m < this.shadowMeshCount; m++) {
      const part = m % this.parts;
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mats[Math.min(part, mats.length - 1)]);
      mesh.count = 1;   // indirect: see the drawn meshes above (one shader build)
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = false;   // never seen, only rendered into the shadow map
      mesh.layers.set(LAYERS.SCATTER_SHADOW);
      mesh.visible = false;         // until its type casts (setShadowCasters)
      mesh.name = `${this.name}:type${Math.floor(m / this.parts / this.variants)}:shadow` + (this.parts > 1 ? `:part${part}` : "");
      this.shadowMeshes.push(mesh);
      this.group.add(mesh);
    }
  }

  /** Shadow mesh index of (type, part). */
  shadowMeshIndex(type, part = 0, variant = 0) { return (type * this.variants + variant) * this.parts + part; }

  /**
   * Rebuild one type's meshes after a shape setting changed.
   * @param {number} i type index
   * @param {(lod:number, part:number, o:{shadow:boolean}) => { geometry: THREE.BufferGeometry, triangles: number }} makeGeometry
   *   called with `{ shadow: true }` (and the cheapest lod) for the shadow list,
   *   so a module can hand the shadow an even cheaper shape
   * @param {number[]} [onlyParts] rebuild just these parts (default: all)
   */
  rebuildType(i, makeGeometry, onlyParts = null) {
    for (let variant = 0; variant < this.variants; variant++) this._rebuildVariant(i, variant, makeGeometry, onlyParts);
    this._indirect.needsUpdate = true;
  }

  _rebuildVariant(i, variant, makeGeometry, onlyParts) {
    for (let lod = 0; lod < this.lods; lod++) {
      for (let part = 0; part < this.parts; part++) {
        if (onlyParts && !onlyParts.includes(part)) continue;
        const m = this.meshIndex(i, lod, part, variant);
        const { geometry, triangles } = makeGeometry(lod, part, { shadow: false, variant });
        this._indirect.array[m * 5] = geometry.index.count;
        geometry.setIndirect(this._indirect, m * 5 * 4);
        const mesh = this.meshes[m];
        const old = mesh.geometry;
        mesh.geometry = geometry;
        old?.dispose();
        this.triangles[m] = triangles;
      }
    }
    // The shadow list draws the cheapest detail level: a shadow shows no leaflet.
    for (let part = 0; part < this.parts && this.shadows; part++) {
      if (onlyParts && !onlyParts.includes(part)) continue;
      const s = this.shadowMeshIndex(i, part, variant);
      const { geometry } = makeGeometry(this.lods - 1, part, { shadow: true, variant });
      this._indirect.array[(this.meshCount + s) * 5] = geometry.index.count;
      geometry.setIndirect(this._indirect, (this.meshCount + s) * 5 * 4);
      const mesh = this.shadowMeshes[s];
      const old = mesh.geometry;
      mesh.geometry = geometry;
      old?.dispose();
    }
  }

  /**
   * Which types cast, and how far from the camera plants still cast (m).
   * @param {boolean[]} casts one flag per type
   */
  setShadowCasters(casts, distance) {
    if (!this.shadows) return;
    for (let t = 0; t < this.typeCount; t++) this._shadowCastValues[t] = casts[t] ? 1 : 0;
    if (distance !== undefined) this.u.uShadowDist.value = distance;
    this._syncShadowVisibility();
  }

  /**
   * Where the shadow radius is measured from, world XZ; `null` = the anchor.
   *
   * THE ANCHOR IS THE WRONG CENTRE FOR A CAMERA THAT LOOKS DOWN AND AHEAD. It
   * is the camera's own XZ, and an RTS camera never sees the ground under
   * itself: at alg-rts's play zoom the nearest visible ground is 12 m out and
   * the screen centre 41 m, so a 35 m circle around the camera spent a third of
   * its casters behind the bottom of the screen and none past its middle —
   * plants in the upper half of the view cast nothing. The caller centres the
   * circle on the ground the camera actually sees (main.js, scatterShadowCentre).
   */
  setShadowCentre(x, z) {
    this._shadowCentreSet = x != null && Number.isFinite(x) && Number.isFinite(z);
    if (this._shadowCentreSet) this.u.uShadowCentre.value.set(x, z);
  }

  _syncShadowVisibility() {
    for (let m = 0; m < this.shadowMeshCount; m++) {
      const t = Math.floor(m / this.parts / this.variants);
      this.shadowMeshes[m].visible = this._shadowCastValues[t] > 0.5 && !!this._usedTypes[t];
    }
  }

  /**
   * The shadow cameras that should draw the shadow lists — the near cascades.
   * Called every frame with the live list: a CSM rebuilds its cameras when the
   * cascade count changes, and the ones no longer passed are given back.
   * @param {THREE.Camera[]} cams
   */
  setShadowCameras(cams) {
    if (!this.shadows) return;
    for (const cam of this._shadowCams) {
      if (!cams.includes(cam)) { cam.layers.disable(LAYERS.SCATTER_SHADOW); this._shadowCams.delete(cam); }
    }
    for (const cam of cams) {
      // Enabled every call: three may hand a cascade camera a fresh mask.
      cam.layers.enable(LAYERS.SCATTER_SHADOW);
      this._shadowCams.add(cam);
    }
  }

  /**
   * Shadows on the nearest `receiveLods` detail levels, and only when asked.
   * 1 (the default) = the near level only. An RTS camera sees every level at
   * once, and the line where plants stop receiving (their own leaves, a
   * building's shadow) was a band of flat bright crowns that followed the
   * camera (alg-rts, 2026-10-01): a game looking down asks for all of them.
   */
  setReceiveShadows(on) {
    this._receiveOn = !!on;
    for (let m = 0; m < this.meshCount; m++) {
      this.meshes[m].receiveShadow = this._receiveOn && Math.floor(m / this.parts) % this.lods < this.receiveLods;
    }
  }

  setReceiveLods(n) {
    this.receiveLods = Math.max(0, n | 0);
    if (this._receiveOn !== undefined) this.setReceiveShadows(this._receiveOn);
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
    this._usedTypes = used.slice();
    for (let m = 0; m < this.meshCount; m++) this.meshes[m].visible = !!used[Math.floor(m / (this.parts * this.lods * this.variants))];
    this._syncShadowVisibility();
  }

  /**
   * CPU CULL OF EMPTY DRAWS (2026-10-03). Every mesh is an indirect draw whose
   * instance count the GPU decides — often 0 (a species that grows nowhere
   * near, the near detail level of a field seen from far): measured at the
   * alg-rts post, 26 of 36 tall-plant meshes and 13 of 24 foliage meshes drew
   * nothing, yet each cost a full submission (~25 µs, ×2 with the depth
   * pre-pass). With the field's PAINTED density on the CPU (`pages`: the raw
   * DataTextures — the GPU reads them masked, which only removes plants, so
   * these are a superset), each frame decides per type × detail level whether
   * ANY plant could land there, from the same rules the compute uses: inside
   * the tile round the anchor, within uOuterR1 of it, and the detail band by
   * flat distance to the camera (± the compute's dither). Draws that cannot
   * have a plant are hidden; anything that might stays — it never hides a
   * plant, so it cannot pop. Shadow lists likewise, by uShadowDist round the
   * shadow centre. null = off (the default: every mesh draws as before).
   * @param {THREE.DataTexture[] | null} pages  RGBA, 4 types a page, in type order
   */
  setCpuDensity(pages, { heightAt = null, reach = 30 } = {}) {
    this._cpuPages = pages?.length ? pages : null;
    this._occ = null;
    // With the ground's height (heightAt(x, z) → world Y) a cell is also tested
    // against the camera's frustum for the drawn lists (the compute keeps only
    // plants in view): a box from the cell's lowest to highest ground, grown by
    // `reach` metres (the tallest plant's height and crown) on every side, so a
    // plant standing off screen whose crown leans in still counts.
    this._heightAt = heightAt;
    this._reach = reach;
    if (!this._cpuPages) {
      // Back to the used-types visibility.
      const used = this._usedTypes ?? [];
      for (let m = 0; m < this.meshCount; m++) this.meshes[m].visible = !!used[Math.floor(m / (this.parts * this.lods * this.variants))];
      this._syncShadowVisibility();
    }
  }

  // Occupancy: per type, which 16 m cells of the map hold any painted density
  // (dilated by a cell: the compute samples the texture bilinearly).
  _buildOccupancy() {
    const size = this.u.uTerrainSize.value, N = Math.max(8, Math.round(size / 16)), cell = size / N;
    const T = this.typeCount, occ = Array.from({ length: T }, () => new Uint8Array(N * N));
    this._cpuPages.forEach((tex, pi) => {
      const d = tex.image?.data, w = tex.image?.width, h = tex.image?.height;
      if (!d || !w || !h) return;
      for (let y = 0; y < h; y++) {
        const cz = Math.min(N - 1, Math.floor(((y + 0.5) / h) * N)) * N;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (!(d[i] | d[i + 1] | d[i + 2] | d[i + 3])) continue;
          const c = cz + Math.min(N - 1, Math.floor(((x + 0.5) / w) * N));
          for (let ch = 0; ch < 4; ch++) { const t = pi * 4 + ch; if (t < T && d[i + ch] > 0) occ[t][c] = 1; }
        }
      }
    });
    for (const o of occ) {   // dilate one cell
      const src = o.slice();
      for (let z = 0; z < N; z++) for (let x = 0; x < N; x++) {
        if (!src[z * N + x]) continue;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const zz = z + dz, xx = x + dx;
          if (zz >= 0 && zz < N && xx >= 0 && xx < N) o[zz * N + xx] = 1;
        }
      }
    }
    // The ground's height range per cell (5×5 samples + 3 m for what falls
    // between them, craters and pads): the frustum test's boxes.
    let hMin = null, hMax = null;
    if (this._heightAt) {
      hMin = new Float32Array(N * N); hMax = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        let lo = Infinity, hi = -Infinity;
        for (let b = 0; b <= 4; b++) for (let a = 0; a <= 4; a++) {
          const y = this._heightAt(i * cell - size / 2 + (a / 4) * cell, j * cell - size / 2 + (b / 4) * cell);
          if (y < lo) lo = y; if (y > hi) hi = y;
        }
        hMin[j * N + i] = lo - 3; hMax[j * N + i] = hi + 3;
      }
    }
    this._occ = { N, cell, size, occ, hMin, hMax, versions: this._cpuPages.map((t) => t.version) };
  }

  _cpuCull(anchorPos) {
    if (!this._occ || this._cpuPages.some((t, i) => t.version !== this._occ.versions[i])) this._buildOccupancy();
    const { N, cell, size, occ, hMin, hMax } = this._occ, u = this.u, L = this.lods, T = this.typeCount;
    // THE COMPUTE'S OWN FRUSTUM TEST (gpuCull.frustumVisibleAtClip), as planes:
    // its padded NDC bounds (uCullPadNdc*, 0.35-0.6 of the half-screen — far
    // wider than the screen) with the radius term are linear in the world
    // position, so each is a plane a·p + d ≥ 0 (clip rows of the camera
    // matrix). A plain frustum here hid plants the compute kept (measured:
    // foliage near detail, 1-7 plants for 4 frames in a fast zoom).
    const R = this._reach;
    let planes = null;
    if (hMin) {
      const e = this._cameraMatrix.elements;
      const row = (i) => [e[i], e[4 + i], e[8 + i], e[12 + i]];
      const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
      const kX = 1 + u.uCullPadNdcX.value, kYn = 1 + u.uCullPadNdcYNear.value, kYf = 1 + u.uCullPadNdcYFar.value;
      const fxr = u.uFx.value * R, fyr = u.uFy.value * R;
      const comb = (a, sa, b, sb, add) => [0, 1, 2, 3].map((k) => sa * a[k] + sb * b[k] + (k === 3 ? add : 0));
      planes = [
        comb(r0, 1, r3, kX, fxr), comb(r0, -1, r3, kX, fxr),     // left, right
        comb(r1, 1, r3, kYn, fyr), comb(r1, -1, r3, kYf, fyr),   // bottom (near), top (far)
        comb(r3, 1, r3, 0, 0), comb(r3, 1, r2, -1, 0),           // in front, before the far plane
      ];
    }
    let drawDone = 0;   // per type: every detail level already proven possible
    const ax = anchorPos.x, az = anchorPos.z, cx = u.uCamPos.value.x, cz = u.uCamPos.value.z;
    const half = u.uTileSize.value * 0.5, R1 = u.uOuterR1.value;
    const sx = u.uShadowCentre.value.x, sz = u.uShadowCentre.value.y, sR = u.uShadowDist.value + 3;
    // Detail bands by flat camera distance: the compute's dither (±2, ±4) plus
    // 10% + 4 m, so a switch distance moved later in the frame (zooming) is
    // still inside the margin.
    const l1 = u.uLodDist.value, l2 = u.uLodDist2.value;
    const lo = (d, k) => d * 0.9 - k, hi = (d, k) => d * 1.1 + k;
    const bands = L === 1 ? [[0, Infinity]] : L === 2 ? [[0, hi(l1, 6)], [lo(l1, 6), Infinity]]
      : [[0, hi(l1, 6)], [lo(l1, 6), hi(l2, 8)], [lo(l2, 8), Infinity]];
    // Cells the tile ∩ outer circle can touch.
    const reach = Math.min(half, R1);
    const i0 = Math.max(0, Math.floor((ax - reach + size / 2) / cell)), i1 = Math.min(N - 1, Math.floor((ax + reach + size / 2) / cell));
    const j0 = Math.max(0, Math.floor((az - reach + size / 2) / cell)), j1 = Math.min(N - 1, Math.floor((az + reach + size / 2) / cell));
    const possible = (this._possible ??= new Uint8Array(T * L)), shadowOk = (this._shadowOk ??= new Uint8Array(T));
    possible.fill(0); shadowOk.fill(0);
    const used = this._usedTypes;
    for (let t = 0; t < T; t++) {
      if (used && !used[t]) continue;
      const o = occ[t];
      let need = L + (this.shadows ? 1 : 0);
      // The type's HEIGHT BAND (scatterRuleKeep: smoothstep over min-2..max+2
      // of the ground height): a cell whose ground range misses it grows none.
      const rule = hMin && this._ruleRow != null ? this.typeRows[t * this.rows + this._ruleRow] : null;
      const bandLo = rule ? rule.x - 2 : -Infinity, bandHi = rule ? rule.y + 2 : Infinity;
      for (let j = j0; j <= j1 && need > 0; j++) {
        const zMin = j * cell - size / 2, zMax = zMin + cell;
        for (let i = i0; i <= i1 && need > 0; i++) {
          if (!o[j * N + i]) continue;
          const xMin = i * cell - size / 2, xMax = xMin + cell;
          // The tile square round the anchor, and the outer circle.
          if (xMax < ax - half || xMin > ax + half || zMax < az - half || zMin > az + half) continue;
          const ndx = Math.max(xMin - ax, 0, ax - xMax), ndz = Math.max(zMin - az, 0, az - zMax);
          if (ndx * ndx + ndz * ndz > R1 * R1) continue;
          if (rule && (hMax[j * N + i] <= bandLo || hMin[j * N + i] >= bandHi)) continue;
          // In view (the drawn lists only): the cell's ground box grown by the
          // plants' reach, against the camera frustum.
          drawDone = 0;
          for (let l = 0; l < L; l++) drawDone += possible[t * L + l];
          let inView = drawDone < L;
          if (inView && planes) {
            const yMin = hMin[j * N + i], yMax = hMax[j * N + i];
            // The compute keeps anything whose DEPTH |clip.w| is within its
            // radius — a slab through the camera, unbounded sideways (for a
            // high camera it cuts the ground behind it): the box against that slab.
            const w = planes[4];
            const wMax = w[0] * (w[0] >= 0 ? xMax : xMin) + w[1] * (w[1] >= 0 ? yMax : yMin) + w[2] * (w[2] >= 0 ? zMax : zMin) + w[3];
            const wMin = w[0] * (w[0] >= 0 ? xMin : xMax) + w[1] * (w[1] >= 0 ? yMin : yMax) + w[2] * (w[2] >= 0 ? zMin : zMax) + w[3];
            if (!(wMin <= R && wMax >= -R)) {
              for (const p of planes) {
                // The box corner furthest along the plane's normal.
                const v = p[0] * (p[0] >= 0 ? xMax : xMin) + p[1] * (p[1] >= 0 ? yMax : yMin) + p[2] * (p[2] >= 0 ? zMax : zMin) + p[3];
                if (v < 0) { inView = false; break; }
              }
            }
          }
          if (inView) {
            // Nearest and farthest flat distance from the camera to the cell.
            const mdx = Math.max(xMin - cx, 0, cx - xMax), mdz = Math.max(zMin - cz, 0, cz - zMax);
            const dMin = Math.hypot(mdx, mdz);
            const dMax = Math.hypot(Math.max(Math.abs(xMin - cx), Math.abs(xMax - cx)), Math.max(Math.abs(zMin - cz), Math.abs(zMax - cz)));
            for (let l = 0; l < L; l++) {
              if (possible[t * L + l]) continue;
              if (dMax >= bands[l][0] && dMin < bands[l][1]) { possible[t * L + l] = 1; need--; }
            }
          }
          if (this.shadows && !shadowOk[t]) {
            const sdx = Math.max(xMin - sx, 0, sx - xMax), sdz = Math.max(zMin - sz, 0, sz - zMax);
            if (sdx * sdx + sdz * sdz <= sR * sR) { shadowOk[t] = 1; need--; }
          }
        }
      }
    }
    const P = this.parts, V = this.variants;
    for (let m = 0; m < this.meshCount; m++) {
      const t = Math.floor(m / (P * L * V)), l = Math.floor(m / P) % L;
      this.meshes[m].visible = !!possible[t * L + l];
    }
    for (let m = 0; m < this.shadowMeshCount; m++) {
      const t = Math.floor(m / P / V);
      this.shadowMeshes[m].visible = this._shadowCastValues[t] > 0.5 && !!(used ? used[t] : true) && !!shadowOk[t];
    }
  }

  /**
   * Keep only this fraction of the plants the paint and density would grow,
   * 0..1. A RUNTIME lever, not a look setting: it is not saved and syncCommon
   * never touches it, so a game can drive it every frame — e.g. from camera
   * zoom, because a plant's cost is its screen pixels and a zoomed-out view
   * stacks thousands of them. Which plants go is fixed per plant, so the field
   * only changes while the value does.
   */
  setThin(k) {
    this.u.uThin.value = Math.max(0, Math.min(1, Number.isFinite(k) ? k : 1));
  }

  /**
   * Size multiplier (0..1) for a plant under setThin, for the plant module's
   * vertex stage: 1 for a plant well inside the kept share, falling to 0 at
   * the point the compute drops it. So while the camera zooms, plants grow in
   * and shrink away instead of popping. The same hash as the compute's keep,
   * on the same plant id (the compact buffer's value), so the two agree.
   * @param {Node} plant  the plant's index into bufPos / bufDir
   */
  thinScale(plant) {
    return smoothstep(0, THIN_BAND, thinThreshold(this.u.uThin).sub(hash(plant.add(THIN_SEED))));
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

  /**
   * THE CAMERA DECIDES THE DISTANCES.
   *
   * LOD steps and the fade window are answers to one question — "how far away
   * is the ground I can see" — and storing them per MAP means hand-fitting
   * them to one zoom and watching them go stale the moment the camera changes.
   * They did: the ground foliage once had its LOD steps at 18 m and 45 m on a
   * camera whose nearest visible ground was 53 m, so every plant drew at its
   * cheapest shape and never once at full detail. Hand-fitting them again just
   * moves the staleness.
   *
   * @param {number} near  nearest visible ground, metres from the anchor
   * @param {number} far   farthest visible ground, metres from the anchor
   *
   * The LOD steps land INSIDE the visible band, so both switches are somewhere
   * a player can actually see, and the fade starts past the far edge so plants
   * are not thinning where they are still being looked at. Everything is
   * capped against the wrap tile: a plant fading at more than half the tile
   * width is a plant popping as it wraps.
   */
  setViewDistances(near, far, footprint = null) {
    if (!(far > 0)) return;
    const u = this.u;
    const n = Math.max(0, near);
    const span = Math.max(far - n, 1);
    // The tile wraps at half its width; keep everything clear of that edge.
    const cap = this.tileSize * 0.45;
    if (footprint) {
      // THE TILE FOLLOWS THE VIEW (main.js viewFootprint): the anchor is the
      // centre of the ground on screen and `footprint.radius` holds every
      // corner of it. The LOD steps are measured from the CAMERA (screen size)
      // and need no cap — only the fade is measured from the anchor, and it
      // starts past the last visible corner and ends inside the wrap.
      u.uLodDist.value  = n + span * 0.55;
      u.uLodDist2.value = n + span * 0.85 + 2;
      const wrap = this.tileSize * 0.5 - 2;
      const r1 = Math.min(Math.max(footprint.radius * 1.15, footprint.radius + 12), wrap);
      u.uOuterR0.value = Math.min(footprint.radius, r1 - 4);
      u.uOuterR1.value = r1;
      return;
    }
    u.uLodDist.value  = Math.min(n + span * 0.55, cap);
    u.uLodDist2.value = Math.min(n + span * 0.85, cap) + 2;
    u.uOuterR0.value  = Math.min(far * 1.05, cap);
    u.uOuterR1.value  = Math.min(far * 1.35, cap) + 1;
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
    // Nothing to cast while hidden: hand the cascade cameras their layer back.
    if (!this._enabled) this.setShadowCameras([]);
  }

  /** Per frame: move the tile with the anchor, then run the compute. */
  update(anchorPos, camera, pushPos = anchorPos) {
    if (!this._initDone || !this._enabled) return;
    const u = this.u;
    u.uAnchorDeltaXZ.value.set(anchorPos.x - this._lastAnchor.x, anchorPos.z - this._lastAnchor.z);
    u.uAnchorPos.value.copy(anchorPos);
    // What the plants bend away from: the walker in play mode. The anchor is not
    // a walker when it leads the camera over the view (main.js viewFootprint):
    // null parks the push far away.
    if (pushPos) u.uPlayerPos.value.copy(pushPos); else u.uPlayerPos.value.set(1e7, 0, 1e7);
    if (!this._shadowCentreSet) u.uShadowCentre.value.set(anchorPos.x, anchorPos.z);
    for (const m of this.meshes) m.position.set(anchorPos.x, 0, anchorPos.z);
    for (const m of this.shadowMeshes) m.position.set(anchorPos.x, 0, anchorPos.z);
    this._lastAnchor.copy(anchorPos);

    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    this._cameraMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.uCameraMatrix.value.copy(this._cameraMatrix);
    const e = camera.projectionMatrix.elements;
    u.uFx.value = e[0];
    u.uFy.value = e[5];
    if (this._cpuPages) this._cpuCull(anchorPos);
    this.renderer.compute([this.computeReset, this.computeUpdate]);
  }
}
