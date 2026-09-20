/**
 * Revo grass — the second grass system: one camera-following tile of small
 * camera-facing blades, dense rather than detailed.
 *
 * The look is alezen9/revo-realms (MIT): a jittered grid inside a tile that
 * wraps around the player, stochastic thinning with distance, wind driven by a
 * packed 4-channel noise atlas, and a base-to-tip colour ramp with a wind
 * tint. The PLUMBING is this engine's, and that is where it differs from the
 * v2 port (v2/render/revoGrass/revoGrassSystem.js), which stays untouched:
 *
 *   — it reads the SAME painted density the hybrid grass reads, as a
 *     probability, so a world painted for one system shows in the other, and
 *     painted blade height applies to both;
 *   — blades stand on the clipmap's triangle (shared clipmapGroundY), not on
 *     the heightmap the clipmap only approximates, so they do not float;
 *   — the push field bends them, so cars, wheels and a game's own objects lay
 *     grass down, not only the player;
 *   — visible blades are COMPACTED into a GPU-written indirect draw, so culled
 *     blades cost no vertex work at all (the hybrid grass's trick, which the
 *     original does not do: it pays the vertex shader for all of them);
 *   — the material is MeshStandardNodeMaterial, so the sun, the sky and the
 *     CSM shadows light it like everything else in the world. The original is
 *     an unlit SpriteNodeMaterial, which in a world with a day cycle reads as
 *     grass that never gets the memo that the sun went down.
 *
 * Cylindrical billboarding (yaw toward the camera, never pitch) rather than
 * the original's full sprite: a sprite blade lies down when you look at the
 * field from above, which is exactly when you can see that it did.
 */
import * as THREE from "three";
import {
  Fn,
  If,
  abs,
  asin,
  atomicAdd,
  atomicStore,
  cameraPosition,
  clamp,
  cos,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  instancedArray,
  length,
  max,
  min,
  mix,
  normalize,
  remap,
  sin,
  smoothstep,
  step,
  storage,
  texture,
  time,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  PI2,
  positionLocal,
} from "three/tsl";
import { hash42 } from "../../../v2/core/foliage/tsl-utils.js";
import { createRevoBladeGeometry } from "../../../v2/core/revoGrass/revoGrassGeometry.js";
import { wrapTileOffsetXZ } from "../../../v2/core/revoGrass/revoGrassTile.js";
import {
  computeStochasticKeep,
  computeFrustumVisibility,
} from "../../../v2/core/revoGrass/revoGrassSsboUtils.js";
import { createClipmapGroundY } from "../../../v2/core/terrain/clipmapGroundY.js";
import { worldSizeForPixels } from "../scatter/gpuCull.js";
import { revoGrassConfig } from "../../app/state/revoGrassState.js";

/**
 * Revo Realms' packed RGBA noise atlas (MIT — alezen9/revo-realms). Each
 * channel is a DIFFERENT noise (R super-noise, G perlin, B grainy, A cracks);
 * that variety per channel is what makes the wind read as weather rather than
 * as one FBM at three frequencies.
 */
const NOISE_ATLAS_URL = "/textures/revo_noise_atlas.png";
let _atlasPromise = null;
function loadNoiseAtlas() {
  if (_atlasPromise) return _atlasPromise;
  _atlasPromise = new THREE.TextureLoader().loadAsync(NOISE_ATLAS_URL).then((tex) => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.flipY = false;
    tex.needsUpdate = true;
    return tex;
  });
  return _atlasPromise;
}

const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();

export class RevoGrassSystem {
  /**
   * @param {object} o
   * @param {THREE.Scene} o.scene
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {number} o.worldSize          terrain edge in metres
   * @param {THREE.Texture} o.heightTex   .x = terrain height in metres
   * @param {THREE.Texture} o.terrainNormalTex  .xyz world normal
   * @param {THREE.Texture} o.densityTex  painted grass density, already masked
   * @param {THREE.Texture} o.bladeHeightTex   painted blade height (.x/128)
   * @param {THREE.Texture} o.waterMapTex  waterSurfaceMap (.r = water surface Y), or null
   * @param {object} o.pushField          { textureNode, center, worldSize }
   * @param {object} o.terrainSurface     the clipmap description (see clipmapGroundY)
   * @param {object} o.terrainShadow      { shade(colorNode, vis), visibilityHere() }
   * @param {object} o.rp                 revo grass state
   * @param {object} o.gp                 grass state (the shared slope rule)
   */
  constructor({
    scene, renderer, name = "RevoGrass", worldSize,
    heightTex, terrainNormalTex, densityTex, bladeHeightTex, waterMapTex = null,
    pushField = null, terrainSurface = null, terrainShadow = null,
    rp, gp,
  }) {
    this.scene = scene;
    this.renderer = renderer;
    this.worldSize = worldSize;
    this._heightTex = heightTex;
    this._terrainNormalTex = terrainNormalTex;
    this._densityTex = densityTex;
    this._bladeHeightTex = bladeHeightTex;
    // No water map: one texel far below any terrain, so the dry test below is a
    // constant 1 for the cost of a 1x1 tap.
    if (!waterMapTex) {
      const dry = new THREE.DataTexture(new Float32Array([-1e4, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
      dry.needsUpdate = true;
      waterMapTex = dry;
    }
    this._waterMapTex = waterMapTex;
    this._pushField = pushField;
    this._terrainSurface = terrainSurface;
    this._terrainShadow = terrainShadow;
    this.rp = rp;
    this.gp = gp;

    this.group = new THREE.Group();
    this.group.name = name;
    this.group.visible = false;
    scene.add(this.group);

    this.mesh = null;
    this.material = null;
    this.config = null;
    this._noiseTex = null;
    this._enabled = false;
    this._built = false;
    this._lastAnchor = new THREE.Vector3(NaN, NaN, NaN);
    this._anchorDelta = new THREE.Vector2();
    this._cameraMatrix = new THREE.Matrix4();
    this._clipGroundY = terrainSurface ? createClipmapGroundY(terrainSurface) : null;
    this._uPushCenter = null;

    this.u = this._buildUniforms();
  }

  _buildUniforms() {
    const rp = this.rp;
    const rad = ((rp.windAngle ?? 0) * Math.PI) / 180;
    return {
      uAnchorDeltaXZ: uniform(new THREE.Vector2()),
      uAnchorPos:     uniform(new THREE.Vector3()),
      uTerrainSize:   uniform(this.worldSize),
      uTileSize:      uniform(rp.tileSize ?? 130),
      uCameraMatrix:  uniform(new THREE.Matrix4()),
      uFx:            uniform(1),
      uFy:            uniform(1),
      uCullPadX:      uniform(0.35),
      uCullPadYNear:  uniform(0.75),
      uCullPadYFar:   uniform(0.35),
      uBladeRadius:   uniform(rp.bladeHeight ?? 1.1),

      uDensity:       uniform(rp.density ?? 1),
      uFadeStart:     uniform(rp.fadeStart ?? 22),
      uFadeEnd:       uniform(rp.fadeEnd ?? 70),
      uFadeKeep:      uniform(rp.fadeKeep ?? 0.12),
      uMinScale:      uniform(rp.bladeMinScale ?? 0.75),
      uMaxScale:      uniform(rp.bladeMaxScale ?? 1.9),
      uClumpStrength: uniform(rp.clumpStrength ?? 0.35),
      uClumpScale:    uniform(rp.clumpScale ?? 2),

      uSlopeEnabled:  uniform(0),
      uSlopeMin:      uniform(0.65),
      uSlopeMax:      uniform(0.85),

      uWindStrength:  uniform(rp.windStrength ?? 0.4),
      uWindSpeed:     uniform(rp.windSpeed ?? 0.25),
      uWindIntensity: uniform(rp.windIntensity ?? 1),
      uWindDir:       uniform(new THREE.Vector2(Math.cos(rad), Math.sin(rad))),
      uWindScale:     uniform(rp.windScale ?? 1.75),

      uPushBend:      uniform(rp.pushBend ?? 1),
      uCrushMin:      uniform(rp.crushMin ?? 0.35),
      uLean:          uniform(rp.lean ?? 0.3),
      uFaceCamera:    uniform(rp.faceCamera ?? 0),
      uMinPixels:     uniform(rp.minPixels ?? 1.4),
      uViewportH:     uniform(1080),

      uBaseColor:     uniform(srgb(rp.baseColor ?? "#3d4f1c")),
      uTipColor:      uniform(srgb(rp.tipColor ?? "#8fb84a")),
      uColorMix:      uniform(rp.colorMix ?? 0.55),
      uColorVar:      uniform(rp.colorVariation ?? 2.75),
      uWindColor:     uniform(rp.windColor ?? 0.6),
      uBrightness:    uniform(rp.brightness ?? 1),
      uAoScale:       uniform(rp.aoScale ?? 0.5),
      uAoRadiusSq:    uniform((rp.aoRadius ?? 25) ** 2),
      uBaseWindShade: uniform(rp.baseWindShade ?? 0.75),
      uBaseShadeH:    uniform(rp.baseShadeHeight ?? 1),
      uBend:          uniform(rp.bend ?? 2),
    };
  }

  async init(camera) {
    if (!this._noiseTex) {
      try {
        this._noiseTex = await loadNoiseAtlas();
      } catch (err) {
        console.error(`[RevoGrass] ${NOISE_ATLAS_URL} did not load:`, err);
        return;
      }
    }
    await this.rebuild();
    this._camera = camera;
  }

  /** Blade shape, grid size or tile size changed: new geometry and buffers. */
  async rebuild() {
    if (!this._noiseTex) return;
    this._disposeMesh();
    this.config = revoGrassConfig(this.rp);
    this.u.uTileSize.value = this.config.tileSize;
    this.u.uBladeRadius.value = this.config.bladeHeight;
    this._build();
    this._built = true;
    await this.renderer.computeAsync(this.computeInit);
    // A wrapped tile is meaningless until it has been placed once: the first
    // update() must move every blade from the origin to the player, so the
    // delta it applies is the whole anchor, not a frame's worth of walking.
    this._lastAnchor.set(NaN, NaN, NaN);
    this.group.visible = this._enabled;
  }

  _build() {
    const cfg = this.config;
    const u = this.u;
    const geom = createRevoBladeGeometry(cfg);

    // buf1: x,y = tile offset XZ; z,w = bend XZ (wind + push, smoothed)
    // buf2: x = ground Y; y = height scale; z = wind factor; w = position noise
    const buf1 = instancedArray(cfg.count, "vec4");
    const buf2 = instancedArray(cfg.count, "vec4");
    const compactBuf = instancedArray(cfg.count, "uint");

    // GPU-written indirect args: [indexCount, instanceCount, firstIndex,
    // baseVertex, firstInstance]. The compute decides the instance count.
    const indirectData = new Uint32Array(5);
    indirectData[0] = geom.index.count;
    this._indirectAttr = new THREE.IndirectStorageBufferAttribute(indirectData, 5);
    if (typeof geom.setIndirect === "function") geom.setIndirect(this._indirectAttr);
    else geom.indirect = this._indirectAttr;
    const indirectStorage = storage(this._indirectAttr, "uint", 5).toAtomic();

    this._buffers = { buf1, buf2, compactBuf };

    const fSide = float(cfg.bladesPerSide);
    const fSpacing = float(cfg.spacing);
    const fHalf = float(cfg.tileHalfSize);
    const fTile = float(cfg.tileSize);

    this.computeReset = Fn(() => {
      atomicStore(indirectStorage.element(1), uint(0));
    })().compute(1, [1]);

    // ── INIT: the jittered grid, and one noise read per blade ──
    this.computeInit = Fn(() => {
      const d1 = buf1.element(instanceIndex);
      const d2 = buf2.element(instanceIndex);
      const row = floor(float(instanceIndex).div(fSide));
      const col = float(instanceIndex).mod(fSide);
      const offX = col.mul(fSpacing).sub(fHalf).add(hash(instanceIndex.add(4321)).mul(fSpacing));
      const offZ = row.mul(fSpacing).sub(fHalf).add(hash(instanceIndex.add(1234)).mul(fSpacing));
      d1.x.assign(offX);
      d1.y.assign(offZ);
      d1.z.assign(float(0));
      d1.w.assign(float(0));
      // Spatially coherent noise, unlike the per-blade hashes: it drives the
      // colour and the sway phase, where coherence reads as wind passing over
      // the field. Placement must NOT use it — an FBM at blade spacing
      // correlates neighbours and the tile grows bald patches.
      const noiseUv = vec2(offX, offZ).add(fHalf).div(fTile).abs().fract();
      d2.x.assign(float(0));
      d2.y.assign(float(0));
      d2.z.assign(float(0));
      d2.w.assign(texture(this._noiseTex, noiseUv).g);
    })().compute(cfg.count, [cfg.workgroupSize]);

    // ── UPDATE: one pass, everything per blade, then the draw list ──
    this.computeUpdate = Fn(() => {
      const d1 = buf1.element(instanceIndex);
      const d2 = buf2.element(instanceIndex);

      const wrapped = wrapTileOffsetXZ(vec2(d1.x, d1.y), u.uAnchorDeltaXZ, u.uTileSize);
      d1.x.assign(wrapped.x);
      d1.y.assign(wrapped.y);

      const worldX = wrapped.x.add(u.uAnchorPos.x);
      const worldZ = wrapped.y.add(u.uAnchorPos.z);
      const worldXZ = vec2(worldX, worldZ);
      const terrainUV = worldXZ.div(u.uTerrainSize).add(0.5);

      // The MESH height, not the heightmap's: see clipmapGroundY.
      const groundY = this._clipGroundY
        ? this._clipGroundY(worldX, worldZ, this._heightTex, u.uTerrainSize)
        : texture(this._heightTex, terrainUV).x;
      d2.x.assign(groundY);

      const worldPos = vec3(worldX, groundY, worldZ);

      // ── Where grass is allowed: paint × slope, as ONE probability ──
      // A probability rather than a threshold is what makes a soft brush edge
      // thin the field out instead of ending it on a line.
      const painted = texture(this._densityTex, terrainUV).x;
      const slopeProb = mix(
        float(1),
        smoothstep(u.uSlopeMin, u.uSlopeMax, texture(this._terrainNormalTex, terrainUV).y),
        u.uSlopeEnabled,
      );
      const inMap = step(float(0), terrainUV.x).mul(step(terrainUV.x, float(1)))
        .mul(step(float(0), terrainUV.y)).mul(step(terrainUV.y, float(1)));
      // Nothing grows under water: .r of the water-surface map is the water's
      // world Y here (far below any terrain where there is none), so one tap
      // against the ground this blade stands on keeps the field out of the
      // river. Soft over the first 0.4 m of bank so it thins toward the water
      // rather than ending on a drawn line.
      const waterY = texture(this._waterMapTex, terrainUV).r;
      const dry = smoothstep(waterY.add(0.02), waterY.add(0.42), groundY);
      /*
       * THE TILE'S OWN EDGE, which is a SQUARE.
       *
       * The distance fade floors at `fadeKeep` — by design, so the far field
       * thins to a floor rather than vanishing. But the tile WRAPS per axis at
       * +/-tileSize/2, so that floor was still ~30% alive when it reached the
       * boundary and then stopped dead. Zoomed out far enough for the boundary
       * to be on screen, that reads as a square of grass sliding around with
       * the camera.
       *
       * The giveaway is the shape: the distance fade is radial and can only
       * ever draw a CIRCLE. A straight edge is the wrap, nothing else.
       *
       * So the last fifth of the tile takes whatever the distance fade left
       * down to nothing. Folded into the keep PROBABILITY rather than applied
       * to the result, so blades dissolve stochastically instead of a soft
       * edge appearing — and `visible` below stays the 0/1 it has to be.
       */
      const tileHalf = u.uTileSize.mul(0.5);
      const edgeDist = max(abs(wrapped.x), abs(wrapped.y));
      const edgeKeep = float(1).sub(smoothstep(tileHalf.mul(0.78), tileHalf.mul(0.97), edgeDist));
      const keep = step(
        hash(instanceIndex.add(60493)),
        painted.mul(u.uDensity).mul(slopeProb).mul(dry).mul(edgeKeep),
      ).mul(inMap);

      const stochastic = computeStochasticKeep(
        worldPos, u.uAnchorPos, u.uFadeStart, u.uFadeEnd, u.uFadeKeep,
      );
      const frustum = computeFrustumVisibility(
        worldPos, u.uCameraMatrix, u.uFx, u.uFy, u.uBladeRadius,
        u.uCullPadX, u.uCullPadYNear, u.uCullPadYFar,
      );
      const visible = keep.mul(stochastic).mul(frustum);

      If(visible.greaterThan(0.5), () => {
        // This blade earns a slot in the draw list.
        const slot = atomicAdd(indirectStorage.element(1), uint(1));
        compactBuf.element(slot).assign(instanceIndex);

        const posNoise = d2.w;

        // ── Size: per-blade random, pulled toward a clump's own size ──
        // Voronoi cells in WORLD space (the v2 port used tile-local offsets,
        // so its clumps slid across the ground as the player walked).
        const cellP = worldXZ.div(u.uClumpScale);
        const cellID = floor(cellP);
        const cv = hash42(cellID);
        const clumpDist = length(vec2(cv.x, cv.y).sub(fract(cellP)));
        const clumpPull = smoothstep(0.75, 0.05, clumpDist).mul(u.uClumpStrength);
        const n = mix(hash(instanceIndex.add(7919)), cv.z, clumpPull);
        const randomScale = remap(n.mul(n), 0, 1, u.uMinScale, u.uMaxScale);

        // Painted blade height (the Grass panel's Height brush), shared with
        // the hybrid grass so the same stroke means the same thing.
        const paintedH = this._bladeHeightTex
          ? texture(this._bladeHeightTex, terrainUV).x.mul(255 / 128)
          : float(1);

        // ── Wind: a gust PATTERN crossing the field, eased frame to frame ──
        // Three things here were the difference between a field that waves and
        // one that shivers, and all three came from the original:
        //   · the noise scrolled at a PER-BLADE rate (posNoise remapped 0.95 →
        //     2.05), so every blade had its own private weather and neighbours
        //     were decorrelated IN TIME. One rate for everyone: a gust is a
        //     pattern that travels, and you can watch it arrive.
        //   · it travelled at ~15 m/s, which at this noise scale is a gust
        //     front crossing a blade every fraction of a second. 0.2 makes the
        //     slider read in the low metres per second.
        //   · the two taps were blended with a weight that MOVED (a sine on
        //     time), which is a second, faster wind underneath the first. The
        //     blend is now per blade and constant, so it only varies in space.
        const dir = u.uWindDir.negate();
        const uvBase = worldXZ.mul(0.01).mul(u.uWindScale);
        const scroll = dir.mul(u.uWindSpeed.mul(0.2)).mul(time);
        const nA = texture(this._noiseTex, uvBase.add(scroll)).mul(2).sub(1);
        const nB = texture(this._noiseTex, uvBase.mul(1.37).add(scroll.mul(0.83))).mul(2).sub(1);
        const nMix = mix(nA, nB, clamp(fract(sin(posNoise.mul(12.9898)).mul(78.233)), 0.2, 0.8));
        // Intensity ramps the calm strength up to a full gust; without it the
        // wind has the right shape at a quarter of the amplitude.
        const strength = mix(u.uWindStrength, float(1.5), u.uWindIntensity);
        const windFactor = nMix.r.mul(strength).add(nMix.g.mul(strength).mul(0.35));
        const target = dir.mul(windFactor);
        // A fixed, slow ease — about a third of a second to follow. The
        // original varied it per frame off a noise channel, which modulated
        // the smoothing itself and put back the jitter it was there to remove.
        const prevBend = vec2(d1.z, d1.w);
        const windBend = prevBend.add(target.sub(prevBend).mul(float(0.05)));

        // ── Push: the field every other system writes to (player, wheels,
        // a game's own objects). It carries its own recovery, so the blade
        // needs no crushed-grass memory of its own.
        let push = vec2(0, 0);
        if (this._pushField) {
          const pf = this._pushField;
          this._uPushCenter ??= uniform(pf.center);
          const puv = worldXZ.sub(this._uPushCenter).div(float(pf.worldSize)).add(0.5);
          const edge = max(abs(puv.x.sub(0.5)), abs(puv.y.sub(0.5)));
          const fade = float(1).sub(smoothstep(float(0.42), float(0.5), edge));
          push = pf.textureNode.sample(puv.clamp(0, 1)).xy.mul(fade).mul(u.uPushBend);
        }
        const pushMag = length(push);
        // Laid over AND shortened: grass a wheel went through is flat, not
        // merely leaning.
        const crush = mix(float(1), u.uCrushMin, clamp(pushMag, 0, 1));

        d1.z.assign(windBend.x.add(push.x));
        d1.w.assign(windBend.y.add(push.y));
        d2.y.assign(randomScale.mul(paintedH).mul(crush));
        d2.z.assign(windFactor);
      });
    })().compute(cfg.count, [cfg.workgroupSize]);

    // ── Material ──
    // FrontSide, and the billboard basis is built so the front IS the side
    // facing the camera: right = (f.z, 0, -f.x) makes the strip's winding
    // normal come out as f. DoubleSide would cost a flipped normal on the back
    // face (faceDirection), which on a mostly-up grass normal renders black.
    const mat = new THREE.MeshStandardNodeMaterial({
      side: THREE.FrontSide,
      roughness: 0.95,
      metalness: 0,
    });
    mat.envMapIntensity = 0;
    this._assignNodes(mat);
    this.material = mat;

    // Plain Mesh: the instance count comes from the indirect buffer and every
    // per-blade value lives in a storage buffer, so an InstancedMesh would only
    // add a count×64B identity matrix (16 MB at Ultra) and a pointless fetch.
    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = this.rp.receiveShadow !== false;
    this.group.add(this.mesh);
  }

  _assignNodes(mat) {
    const u = this.u;
    const { buf1, buf2, compactBuf } = this._buffers;

    // instanceIndex here is the DRAW slot; the blade it belongs to is whatever
    // the compaction pass put in that slot.
    const bladeId = compactBuf.element(instanceIndex);
    const d1 = buf1.element(bladeId);
    const d2 = buf2.element(bladeId);

    const offX = d1.x, offZ = d1.y;
    const bendXZ = vec2(d1.z, d1.w);
    const groundY = d2.x, heightScale = d2.y, windFactor = d2.z, posNoise = d2.w;

    const h = uv().y;                       // 0 at the root, 1 at the tip
    const bendProfile = h.mul(h);           // a blade bends from its own height up

    // ── Billboard: yaw toward the camera, and pitch toward it by `faceCamera` ──
    // Yaw alone (a cylindrical billboard) is right for a camera standing in
    // the field: the blade turns to show its face and keeps its own up. From
    // an RTS camera it is wrong for exactly the same reason — you are looking
    // DOWN the blade's length, so every blade is an edge and the field reads
    // as bare ground with hairs on it. The original (revo-realms) is a full
    // sprite, which is why its field holds up from above.
    //
    // So the blade's up axis rolls about its own width axis, toward lying
    // down and showing its face. At `faceCamera` 1 and the full angle the
    // card's normal IS the view direction, which is the sprite exactly; at 0
    // it stands up as before. The angle is the camera's ELEVATION over this
    // blade, so the knob needs no companion "is this an RTS camera" toggle:
    // a camera in the grass has almost no elevation over the field it is
    // looking across, and nothing happens on its own.
    const worldXZ = vec2(offX.add(u.uAnchorPos.x), offZ.add(u.uAnchorPos.z));
    const toCam = cameraPosition.xz.sub(worldXZ);
    const facing = toCam.div(max(length(toCam), float(1e-3)));
    const right = vec3(facing.y, 0, facing.x.negate());
    const toCam3 = cameraPosition.sub(vec3(worldXZ.x, groundY, worldXZ.y));
    const elevation = asin(clamp(toCam3.normalize().y, float(-0.999), float(0.999)));
    // Gated so the blades under your feet in a walking camera are left alone
    // (they have a high elevation too, and flattening them reads as the grass
    // getting out of the way), and capped short of flat so a blade always
    // keeps some height to catch the light.
    const faceAmt = u.uFaceCamera.mul(smoothstep(float(0.17), float(0.7), elevation));
    const tilt = min(elevation.mul(faceAmt), float(1.31));    // 75 degrees
    // Roll the frame about `right`: up' = up·cos - n·sin, where n (the card's
    // normal) is the horizontal facing. Blending the up vector toward the
    // camera instead passes through the zero vector overhead and explodes —
    // the ambient cards' lesson, so this is a rotation, not a mix.
    const upAxis = vec3(0, 1, 0).mul(cos(tilt))
      .sub(vec3(facing.x, 0, facing.y).mul(sin(tilt)));

    // ── Width, with a floor in PIXELS ──
    // A 7 cm blade is under a pixel wide by 25 m, and a sub-pixel triangle
    // does not fade — it crawls, and a field of them shimmers even standing
    // still. So past that distance the blade GROWS in world space to hold a
    // constant screen width: the birds' and the ambient cards' trick
    // (gpuCull.worldSizeForPixels), and the same argument — either it is drawn
    // wide enough to be drawn honestly or it is not worth drawing.
    const widthScale = posNoise.remap(0, 1, 0.5, 1.5);
    const camDist = max(length(cameraPosition.sub(vec3(worldXZ.x, groundY, worldXZ.y))), float(0.1));
    const authoredW = float(this.config.bladeWidth).mul(widthScale);
    const floorW = worldSizeForPixels(u.uMinPixels, camDist, u.uFy, u.uViewportH);
    const widthFix = max(float(1), floorW.div(authoredW));
    const lateral = right.mul(positionLocal.x.mul(widthScale).mul(widthFix));

    // Everything that moves the blade sideways is a FRACTION OF ITS OWN
    // HEIGHT, never an absolute distance: a 30 cm blade and a 2 m one lean by
    // the same angle, not by the same metre. The wind vector out of the
    // compute is unbounded (gusts stack), so the lean is capped before it is
    // scaled — otherwise a gust lays the whole field flat and stretches it.
    const bladeMetres = float(this.config.bladeHeight).mul(heightScale);
    // A blade that only moves with the wind stands to attention between
    // gusts, which no field does. Each one keeps its OWN resting lean, in its
    // own direction, and the wind bends it from there.
    const restAngle = hash(bladeId.add(4177)).mul(PI2);
    const rest = vec2(cos(restAngle), sin(restAngle))
      .mul(u.uLean.mul(hash(bladeId.add(911)).mul(0.6).add(0.4)));
    const wanted = bendXZ.mul(u.uBend).mul(0.32).add(rest);
    const wantedMag = length(wanted);
    const leanFrac = min(wantedMag, float(0.8));
    const leanDir = wanted.div(max(wantedMag, float(1e-4)));

    // Sway is the slow small motion on top of the eased bend; flutter is the
    // sideways flick that keeps a field from moving like one sheet. Both are
    // deliberately SLOW: the original's 5 rad/s per blade, each on its own
    // random phase, is not wind — it is every blade vibrating independently,
    // which reads as the field shivering even while it stands straight.
    // Both ride on how hard the wind is actually blowing, so calm air leaves
    // the field still instead of humming.
    const gust = abs(windFactor);
    const phase = posNoise.mul(PI2);
    const sway = sin(time.mul(1.4).add(phase)).mul(0.07).mul(h).mul(gust);
    const perp = vec2(u.uWindDir.y.negate(), u.uWindDir.x);
    const flutter = sin(time.mul(0.9).add(hash(bladeId).mul(PI2)))
      .mul(0.05).mul(gust);
    const lean = leanDir.mul(leanFrac).add(perp.mul(flutter)).add(u.uWindDir.mul(sway))
      .mul(bendProfile).mul(bladeMetres);

    // A blade that leans loses height — without this the whole field grows as
    // the wind picks up, which reads as stretching rather than as bending.
    const drop = float(1).sub(leanFrac.mul(leanFrac).mul(0.35).mul(bendProfile));
    const stand = vec3(offX, groundY, offZ)
      .add(upAxis.mul(positionLocal.y.mul(heightScale).mul(drop)));

    mat.positionNode = stand.add(lateral).add(vec3(lean.x, 0, lean.y));

    // A card's own normal would light the field like a wall of mirrors facing
    // the camera; grass reads as a soft surface, so the normal leans most of
    // the way back to straight up (the foliage cards' lesson). The flatter the
    // blade lies for an overhead camera, the more straight up is also the
    // TRUE answer — which is why this survives `faceCamera` without the baked
    // lightmap the original needs.
    const nLift = float(0.45).mul(cos(tilt));
    mat.normalNode = normalize(vec3(facing.x.mul(nLift), 1, facing.y.mul(nLift)));

    // ── Colour: root-to-tip ramp, per-blade jitter, root AO, wind tint ──
    const albedo = Fn(() => {
      const jitter = smoothstep(0, u.uColorVar, posNoise);
      const baseToTip = mix(
        u.uBaseColor.mul(jitter),
        u.uTipColor,
        h.mul(u.uColorMix),
      );
      // Root darkening, strongest right around the camera where you can see it.
      const r2 = offX.mul(offX).add(offZ.mul(offZ));
      const near = float(1).sub(smoothstep(0, u.uAoRadiusSq, r2));
      const hWeight = float(1).sub(smoothstep(0.1, 0.85, h));
      const ao = float(1).sub(u.uAoScale.mul(0.25).mul(near.mul(hWeight)));
      // Moving grass shows its lighter underside and its roots go dark.
      const swayShow = smoothstep(0, 1, h.mul(windFactor));
      const baseMask = float(1).sub(smoothstep(0, u.uBaseShadeH, h));
      const windAo = mix(float(1), float(1).sub(u.uBaseWindShade), baseMask.mul(swayShow));
      const windTint = mix(float(1), float(1).add(u.uWindColor.mul(0.15)), swayShow.mul(0.35));
      return baseToTip.mul(ao).mul(windAo).mul(windTint).mul(u.uBrightness);
    })();

    // Mountain shade: the same terrain shadow the hybrid blades take.
    const ts = this._terrainShadow;
    mat.colorNode = ts ? ts.shade(albedo, ts.visibilityHere()) : albedo;
  }

  setEnabled(on) {
    this._enabled = !!on;
    this.group.visible = this._enabled && !!this.mesh;
  }

  get enabled() { return this._enabled; }

  /** Panel values → uniforms. Geometry keys are the caller's job (rebuild). */
  syncFromState(rp, gp, sunDir) {
    this.rp = rp;
    if (gp) this.gp = gp;
    const u = this.u;
    u.uDensity.value = rp.density ?? 1;
    u.uFadeStart.value = rp.fadeStart ?? 22;
    u.uFadeEnd.value = Math.max(rp.fadeStart ?? 22, rp.fadeEnd ?? 70);
    u.uFadeKeep.value = rp.fadeKeep ?? 0.12;
    u.uMinScale.value = rp.bladeMinScale ?? 0.75;
    u.uMaxScale.value = rp.bladeMaxScale ?? 1.9;
    u.uClumpStrength.value = rp.clumpStrength ?? 0.35;
    u.uClumpScale.value = Math.max(0.2, rp.clumpScale ?? 2);
    u.uWindStrength.value = rp.windStrength ?? 0.4;
    u.uWindSpeed.value = rp.windSpeed ?? 0.25;
    u.uWindIntensity.value = rp.windIntensity ?? 1;
    u.uWindScale.value = rp.windScale ?? 1.75;
    const rad = ((rp.windAngle ?? 0) * Math.PI) / 180;
    u.uWindDir.value.set(Math.cos(rad), Math.sin(rad));
    u.uPushBend.value = rp.pushBend ?? 1;
    u.uCrushMin.value = rp.crushMin ?? 0.35;
    u.uLean.value = rp.lean ?? 0.3;
    u.uFaceCamera.value = rp.faceCamera ?? 0;
    u.uMinPixels.value = rp.minPixels ?? 1.4;
    u.uBaseColor.value.copy(srgb(rp.baseColor ?? "#3d4f1c"));
    u.uTipColor.value.copy(srgb(rp.tipColor ?? "#8fb84a"));
    u.uColorMix.value = rp.colorMix ?? 0.55;
    u.uColorVar.value = rp.colorVariation ?? 2.75;
    u.uWindColor.value = rp.windColor ?? 0.6;
    u.uBrightness.value = rp.brightness ?? 1;
    u.uAoScale.value = rp.aoScale ?? 0.5;
    u.uAoRadiusSq.value = (rp.aoRadius ?? 25) ** 2;
    u.uBaseWindShade.value = rp.baseWindShade ?? 0.75;
    u.uBaseShadeH.value = rp.baseShadeHeight ?? 1;
    u.uBend.value = rp.bend ?? 2;
    u.uBladeRadius.value = rp.bladeHeight ?? 1.1;
    // The slope rule belongs to the world, not to one grass system: both read
    // the Grass panel's Terrain section, so switching systems cannot change
    // where grass is allowed to grow.
    const gpv = this.gp ?? {};
    u.uSlopeEnabled.value = gpv.slopeEnabled ? 1 : 0;
    u.uSlopeMin.value = gpv.slopeMin ?? 0.65;
    u.uSlopeMax.value = gpv.slopeMax ?? 0.85;
    if (this.mesh) this.mesh.receiveShadow = rp.receiveShadow !== false;
    this._sunDir = sunDir ?? this._sunDir;
  }

  /** Per frame, before the render: move the tile, then one compute pass. */
  update(anchorPos, camera) {
    if (!this._built || !this._enabled || !this.mesh) return;
    const u = this.u;

    const first = Number.isNaN(this._lastAnchor.x);
    this._anchorDelta.set(
      first ? anchorPos.x : anchorPos.x - this._lastAnchor.x,
      first ? anchorPos.z : anchorPos.z - this._lastAnchor.z,
    );
    u.uAnchorDeltaXZ.value.copy(this._anchorDelta);
    u.uAnchorPos.value.copy(anchorPos);
    this.mesh.position.set(anchorPos.x, 0, anchorPos.z);
    this._lastAnchor.copy(anchorPos);

    if (camera) {
      this._cameraMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      u.uCameraMatrix.value.copy(this._cameraMatrix);
      u.uFx.value = camera.projectionMatrix.elements[0];
      u.uFy.value = camera.projectionMatrix.elements[5];
    }
    // The pixel floor on blade width is in PIXELS, so it needs the size of the
    // thing the pixels are on. Drawing-buffer height, not CSS height.
    const vh = this.renderer.domElement?.height;
    if (vh) u.uViewportH.value = vh;

    // Synchronous, queued ahead of this frame's render: the wind is a
    // per-frame simulation and a throttle shows as stepping, not as saving.
    this.renderer.compute([this.computeReset, this.computeUpdate]);
  }

  precompile(renderer, camera) {
    if (!this.mesh) return Promise.resolve();
    return renderer.compileAsync(this.mesh, camera);
  }

  _disposeMesh() {
    if (!this.mesh) return;
    this.group.remove(this.mesh);
    this.mesh.geometry?.dispose();
    this.mesh.material?.dispose();
    this.mesh = null;
    this.material = null;
    this._built = false;
  }

  dispose() {
    this._disposeMesh();
    this.scene.remove(this.group);
    this._buffers = null;
  }
}
