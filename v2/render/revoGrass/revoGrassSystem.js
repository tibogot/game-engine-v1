/**
 * Revo-style camera/player-following fluffy grass tile (WebGPU + TSL compute + SpriteNodeMaterial).
 */
import * as THREE from "three";
import { SpriteNodeMaterial } from "three/webgpu";
import {
  Fn,
  mix,
  uniform,
  uv,
  instancedArray,
  instanceIndex,
  hash,
  float,
  floor,
  vec2,
  vec3,
  vec4,
  texture,
  smoothstep,
  sin,
  abs,
  clamp,
  remap,
  time,
  PI2,
  length,
  step,
  fract,
  If,
} from "three/tsl";
import { hash42 } from "../../core/foliage/tsl-utils.js";

/**
 * Revo Realms' packed RGBA noise atlas (MIT — alezen9/revo-realms).
 * Each channel is a different noise (R: super_noise_low / G: super_perlin /
 * B: grainy / A: cracks) — that variety per-channel is what gives the wind
 * its organic feel, vs. same FBM at different frequencies.
 */
const REVO_NOISE_ATLAS_URL = "/textures/revo_noise_atlas.png";
let _revoNoiseAtlasPromise = null;
function loadRevoNoiseAtlas() {
  if (_revoNoiseAtlasPromise) return _revoNoiseAtlasPromise;
  _revoNoiseAtlasPromise = new THREE.TextureLoader()
    .loadAsync(REVO_NOISE_ATLAS_URL)
    .then((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.NoColorSpace;
      tex.flipY = false;
      tex.needsUpdate = true;
      return tex;
    });
  return _revoNoiseAtlasPromise;
}
import { getRevoGrassConfig } from "../../core/revoGrass/revoGrassConfig.js";
import { RevoGrassMask } from "../../core/revoGrass/revoGrassMask.js";
import { createRevoBladeGeometry } from "../../core/revoGrass/revoGrassGeometry.js";
import { wrapTileOffsetXZ } from "../../core/revoGrass/revoGrassTile.js";
import {
  computeStochasticKeep,
  computeFrustumVisibility,
  computeGrassShadowFactor,
} from "../../core/revoGrass/revoGrassSsboUtils.js";

function srgbColor(hex) {
  return new THREE.Color(hex).convertSRGBToLinear();
}

function buildUniforms(rp) {
  const windRad = ((rp.windAngle ?? 0) * Math.PI) / 180;
  return {
    uAnchorDeltaXZ: uniform(new THREE.Vector2()),
    uAnchorPosition: uniform(new THREE.Vector3()),
    uTerrainSize: uniform(0),
    uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3)),
    uCameraMatrix: uniform(new THREE.Matrix4()),
    uFx: uniform(1),
    uFy: uniform(1),
    uCullPadNdcX: uniform(rp.cullPadNdcX ?? 0.075),
    uCullPadNdcYNear: uniform(rp.cullPadNdcYNear ?? 0.75),
    uCullPadNdcYFar: uniform(rp.cullPadNdcYFar ?? 0.2),
    uFrustumCullEnabled: uniform(rp.frustumCullEnabled !== false ? 1 : 0),
    uBladeBoundsRadius: uniform(rp.bladeHeight ?? 1.75),
    uBladeMinScale: uniform(rp.bladeMinScale ?? 0.75),
    uBladeMaxScale: uniform(rp.bladeMaxScale ?? 2),
    uClumpStrength: uniform(rp.clumpStrength ?? 0),
    uClumpScale: uniform(rp.clumpScale ?? 2.0),
    uTrailGrowthRate: uniform(rp.trailGrowthRate ?? 0.04),
    uTrailMinScale: uniform(rp.trailMinScale ?? 0.25),
    uTrailRadius: uniform(rp.trailRadius ?? 1),
    uTrailRadiusSq: uniform((rp.trailRadius ?? 1) ** 2),
    uKDown: uniform(rp.trailCrushSpeed ?? 0.4),
    uWindStrength: uniform(rp.windStrength ?? 0.4),
    uWindSpeed: uniform(rp.windSpeed ?? 0.25),
    uWindIntensity: uniform(rp.windIntensity ?? 1),
    uWindDir: uniform(new THREE.Vector2(Math.cos(windRad), Math.sin(windRad))),
    uUvWindScale: uniform(rp.uvWindScale ?? 1.75),
    uBaseColor: uniform(srgbColor(rp.baseColor ?? "#8c6b30")),
    uTipColor: uniform(srgbColor(rp.tipColor ?? "#4a780a")),
    uColorMixFactor: uniform(rp.colorMixFactor ?? 0.125),
    uColorVariationStrength: uniform(rp.colorVariationStrength ?? 2.75),
    uWindColorStrength: uniform(rp.windColorStrength ?? 0.6),
    uColorBrightness: uniform(rp.colorBrightness ?? 1),
    uAoScale: uniform(rp.aoScale ?? 0.5),
    uAoRimSmoothness: uniform(rp.aoRimSmoothness ?? 5),
    uAoRadiusSq: uniform((rp.aoRadius ?? 25) ** 2),
    uBaseWindShade: uniform(rp.baseWindShade ?? 0.75),
    uBaseShadeHeight: uniform(rp.baseShadeHeight ?? 1),
    uBaseBending: uniform(rp.baseBending ?? 2),
    uStochasticR0: uniform(rp.stochasticR0 ?? 10),
    uStochasticR1: uniform(rp.stochasticR1 ?? 60),
    uStochasticPMin: uniform(rp.stochasticPMin ?? 0.1),
    uPlayerRadius: uniform(rp.playerRadius ?? 0.5),
    uTileSize: uniform(0),
    uBakedShadowWeight: uniform(rp.bakedShadowWeight ?? 1),
    uPlayerShadowEnabled: uniform(rp.playerShadowEnabled !== false ? 1 : 0),
    uExclusionEnabled: uniform(rp.exclusionEnabled ? 1 : 0),
    uExclusionThreshold: uniform(rp.exclusionThreshold ?? 0.25),
    // Slope rejection (same semantics as Gemini/Hybrid): grass fades out as
    // terrainNormal.y drops through [uSlopeMax .. uSlopeMin]. Stochastic keep
    // because revo visibility is binary.
    uSlopeEnabled: uniform(rp.slopeEnabled !== false ? 1 : 0),
    uSlopeMin: uniform(rp.slopeMin ?? 0.65),
    uSlopeMax: uniform(rp.slopeMax ?? 0.85),
  };
}

function createSsbo(config, uniforms, { heightTex, windTex, exclusionTex, terrainNormalTex }) {
  const buffer1 = instancedArray(config.count, "vec4");
  const buffer2 = instancedArray(config.count, "vec4");
  /** Packed per-blade scratch — .x = visibility, .y = shadow, .z = wind noise,
   *  .w = reserved. One vec4 read in the VS instead of three separate floats. */
  const bufferAux = instancedArray(config.count, "vec4");

  const fBladesPerSide = float(config.bladesPerSide);
  const fSpacing = float(config.spacing);
  const fTileHalf = float(config.tileHalfSize);
  const fTileSize = float(config.tileSize);
  const fSpacingJitter = fSpacing.mul(0.5);

  const computeInit = Fn(() => {
    const data1 = buffer1.element(instanceIndex);
    const data2 = buffer2.element(instanceIndex);
    const row = floor(float(instanceIndex).div(fBladesPerSide));
    const col = float(instanceIndex).mod(fBladesPerSide);
    const randX = hash(instanceIndex.add(4321));
    const randZ = hash(instanceIndex.add(1234));
    const offsetX = col
      .mul(fSpacing)
      .sub(fTileHalf)
      .add(randX.mul(fSpacingJitter));
    const offsetZ = row
      .mul(fSpacing)
      .sub(fTileHalf)
      .add(randZ.mul(fSpacingJitter));
    const noiseUv = vec2(offsetX, offsetZ)
      .add(fTileHalf)
      .div(fTileSize)
      .abs()
      .fract();
    const noise = texture(windTex, noiseUv);
    // Per-instance hashes for position-jitter and scale instead of texture
    // samples. Any FBM channel of windTex is too low-frequency relative to
    // blade spacing → adjacent blades get correlated values and clump into
    // visible bands. Hash gives true per-blade randomness so the tile fills
    // uniformly. posNoise (color/sway-phase) stays on the texture because
    // spatial coherence there reads as natural wind-waves, not as bald spots.
    const hashPosX = hash(instanceIndex.add(8521));
    const hashPosZ = hash(instanceIndex.add(3197));
    data1.x.assign(offsetX.add(hashPosX));
    data1.y.assign(offsetZ.add(hashPosZ));
    data1.z.assign(float(0));
    data1.w.assign(float(0));
    const posNoise = noise.g;
    data2.x.assign(float(0));
    // Voronoi-cell clumping: each uClumpScale-sized cell has a random anchor;
    // blades close to it share the cell's scale, blades far blend back to their
    // per-instance random. clumpStrength = 0 → pure per-blade uniform (no
    // patches). clumpStrength = 1 → tight scale clumps of cell size. Falloff is
    // soft so adjacent cells blend rather than showing hard boundaries.
    const cellP = vec2(offsetX, offsetZ).div(uniforms.uClumpScale);
    const cellID = floor(cellP);
    const cellFrac = fract(cellP);
    const cv = hash42(cellID);
    const anchor = vec2(cv.x, cv.y);
    const cellSeed = cv.z;
    const clumpDist = length(anchor.sub(cellFrac));
    const clumpInfluence = smoothstep(0.75, 0.05, clumpDist).mul(
      uniforms.uClumpStrength,
    );
    const perBladeRand = hash(instanceIndex.add(7919));
    const n = mix(perBladeRand, cellSeed, clumpInfluence);
    const shaped = n.mul(n);
    const randomScale = remap(
      shaped,
      0,
      1,
      uniforms.uBladeMinScale,
      uniforms.uBladeMaxScale,
    );
    data2.y.assign(randomScale);
    data2.z.assign(randomScale);
    data2.w.assign(posNoise);
    const aux = bufferAux.element(instanceIndex);
    aux.x.assign(float(1));
    aux.y.assign(float(1));
    aux.z.assign(float(0));
    aux.w.assign(float(0));
  })().compute(config.count, [config.workgroupSize]);

  const computeWind = Fn(([prevWind, worldPos, posNoise]) => {
    const dir = uniforms.uWindDir.negate();
    const speed = uniforms.uWindSpeed.mul(posNoise.remap(0, 1, 0.95, 2.05));
    const uvBase = worldPos.xz.mul(0.01).mul(uniforms.uUvWindScale);
    const scroll = dir.mul(speed).mul(time);
    const uvA = uvBase.add(scroll);
    const nA = texture(windTex, uvA).mul(2).sub(1);
    const uvB = uvBase.mul(1.37).add(scroll.mul(1.11));
    const nB = texture(windTex, uvB).mul(2).sub(1);
    const mixRand = fract(sin(posNoise.mul(12.9898)).mul(78.233));
    const mixTime = sin(time.mul(0.4).add(posNoise.mul(0.1))).mul(0.25);
    const w = clamp(mixRand.add(mixTime), 0.2, 0.8);
    const n = mix(nA, nB, w);
    // Revo's intensity ramp: strength climbs from uWindStrength (calm) to 1.5
    // (full gust) by uWindIntensity. Without it, wind has the right shape but
    // ~4× too little amplitude at intensity = 1.
    const strength = mix(
      uniforms.uWindStrength,
      float(1.5),
      uniforms.uWindIntensity,
    );
    const windFactor = n.r.mul(strength).add(n.g.mul(strength).mul(0.35));
    const target = dir.mul(windFactor);
    const k = mix(0.08, 0.25, abs(n.b));
    const newWind = prevWind.add(target.sub(prevWind).mul(k));
    return vec3(newWind.x, newWind.y, windFactor);
  });

  const computeTrailScale = Fn(([originalScale, currentScale, stepped]) => {
    const up = currentScale.add(
      originalScale.sub(currentScale).mul(uniforms.uTrailGrowthRate),
    );
    const down = currentScale.add(
      uniforms.uTrailMinScale.sub(currentScale).mul(uniforms.uKDown),
    );
    return mix(up, down, stepped);
  });

  const computeUpdate = Fn(() => {
    const data1 = buffer1.element(instanceIndex);
    const data2 = buffer2.element(instanceIndex);
    const aux = bufferAux.element(instanceIndex);

    const wrapped = wrapTileOffsetXZ(
      vec2(data1.x, data1.y),
      uniforms.uAnchorDeltaXZ,
      uniforms.uTileSize,
    );
    data1.x.assign(wrapped.x);
    data1.y.assign(wrapped.y);

    /** Sample terrain height first so the frustum cull tests the blade where it
     *  actually renders. Using y=0 here was a latent bug: blades on hilly terrain
     *  projected far below NDC center in chase cam and got culled around the player. */
    const worldXZ = vec2(
      wrapped.x.add(uniforms.uAnchorPosition.x),
      wrapped.y.add(uniforms.uAnchorPosition.z),
    );
    const terrainUV = worldXZ.div(uniforms.uTerrainSize).add(0.5);
    const yOffset = texture(heightTex, terrainUV).x;
    data2.x.assign(yOffset);

    const worldPos = vec3(worldXZ.x, yOffset, worldXZ.y);

    const stochasticKeep = computeStochasticKeep(
      worldPos,
      uniforms.uAnchorPosition,
      uniforms.uStochasticR0,
      uniforms.uStochasticR1,
      uniforms.uStochasticPMin,
    );

    const frustumVis = mix(
      float(1),
      computeFrustumVisibility(
        worldPos,
        uniforms.uCameraMatrix,
        uniforms.uFx,
        uniforms.uFy,
        uniforms.uBladeBoundsRadius,
        uniforms.uCullPadNdcX,
        uniforms.uCullPadNdcYNear,
        uniforms.uCullPadNdcYFar,
      ),
      uniforms.uFrustumCullEnabled,
    );

    const exclAlpha = mix(
      float(1),
      step(uniforms.uExclusionThreshold, texture(exclusionTex, terrainUV).g),
      uniforms.uExclusionEnabled,
    );

    /** Slope rejection — keep-probability from the precomputed terrain normal
     *  (same texture Gemini/Hybrid use, rebuilt on sculpt). Stochastic step
     *  keeps revo's binary visibility model. */
    const slopeProb = mix(
      float(1),
      smoothstep(uniforms.uSlopeMin, uniforms.uSlopeMax, texture(terrainNormalTex, terrainUV).y),
      uniforms.uSlopeEnabled,
    );
    const slopeKeep = step(hash(instanceIndex.add(60493)), slopeProb);

    const isVisible = stochasticKeep
      .mul(frustumVis)
      .mul(exclAlpha)
      .mul(slopeKeep)
      .mul(step(float(-500), yOffset));

    /** Write defaults so culled blades skip the expensive trail/wind/shadow work.
     *  Material reads aux.x to mask scale to 0 → culled blades are invisible and
     *  the rest of aux is ignored for them. data2.y (current trail scale) is
     *  intentionally preserved across cull/uncull so a blade's crushed-grass
     *  memory survives going off-screen. */
    aux.x.assign(isVisible);
    aux.y.assign(float(1));
    aux.z.assign(float(0));

    If(isVisible, () => {
      const diff = worldPos.xz.sub(uniforms.uAnchorPosition.xz);
      const distSq = diff.dot(diff);
      const inner = uniforms.uTrailRadiusSq.mul(0.35);
      const outer = uniforms.uTrailRadiusSq;
      const grounded = step(
        float(0.1),
        float(1).sub(uniforms.uAnchorPosition.y.sub(yOffset)),
      );
      const contact = float(1)
        .sub(smoothstep(inner, outer, distSq))
        .mul(grounded);

      const currentScale = data2.y;
      const originalScale = data2.z;
      data2.y.assign(computeTrailScale(originalScale, currentScale, contact));

      const posNoise = data2.w;
      const prevWind = vec2(data1.z, data1.w);
      const newWind = computeWind(prevWind, worldPos, posNoise);
      data1.z.assign(newWind.x);
      data1.w.assign(newWind.y);
      aux.z.assign(newWind.z);

      const shadowFactor = mix(
        float(1),
        computeGrassShadowFactor(
          worldPos,
          uniforms.uAnchorPosition,
          uniforms.uPlayerRadius,
          uniforms.uBakedShadowWeight,
        ),
        uniforms.uPlayerShadowEnabled,
      );
      aux.y.assign(shadowFactor);
    });
  })().compute(config.count, [config.workgroupSize]);

  return {
    buffer1,
    buffer2,
    bufferAux,
    computeInit,
    computeUpdate,
  };
}

function createMaterial(ssbo, uniforms) {
  class RevoGrassMaterial extends SpriteNodeMaterial {
    constructor() {
      super();
      this.precision = "lowp";
      this.transparent = false;
      this.stencilWrite = false;
      this.forceSinglePass = true;

      const data1 = ssbo.buffer1.element(instanceIndex);
      const data2 = ssbo.buffer2.element(instanceIndex);
      const aux = ssbo.bufferAux.element(instanceIndex);
      const isVisible = aux.x;
      const shadowFactor = aux.y;
      const windNoiseFactor = aux.z;
      const offsetX = data1.x;
      const offsetY = data2.x;
      const offsetZ = data1.y;
      const windXZ = vec2(data1.z, data1.w);
      const scaleY = data2.y;
      const positionNoise = data2.w;

      this.opacityNode = isVisible;
      const scaleX = positionNoise.remap(0, 1, 0.5, 1.5);
      const bladeScale = vec3(scaleX, scaleY, 1);
      this.scaleNode = mix(vec3(0), bladeScale, isVisible);

      const instanceNoise = hash(instanceIndex.add(196.4356))
        .sub(0.5)
        .mul(0.25);
      const h = uv().y;
      const bendProfile = h.mul(h).mul(uniforms.uBaseBending);
      const baseBending = positionNoise
        .sub(0.5)
        .mul(0.25)
        .add(instanceNoise)
        .mul(bendProfile);
      this.rotationNode = vec3(baseBending, 0, 0);

      /** Culled blades are already collapsed to a point via scaleNode = 0; the
       *  rasterizer drops the degenerate triangle. No need to also push to
       *  infinity (which risked clip-space NaN on some drivers). */
      const bladePosition = vec3(offsetX, offsetY, offsetZ);
      const randomPhase = positionNoise.mul(PI2);
      const swayAmount = sin(time.mul(5).add(randomPhase)).mul(0.15);
      const swayFactor = h.mul(windNoiseFactor);
      const swayOffset = swayAmount.mul(swayFactor);
      const dirXZ = uniforms.uWindDir;
      const perp = vec2(dirXZ.y.negate(), dirXZ.x);
      const phase = hash(instanceIndex).mul(PI2);
      const flutter = sin(
        time.mul(uniforms.uWindSpeed.mul(1.7)).add(phase.mul(1.3)),
      )
        .mul(0.06)
        .mul(bendProfile);
      const flutterOffset = vec3(perp.x, 0, perp.y).mul(flutter);
      const windY = float(1)
        .sub(h.mul(h))
        .mul(uniforms.uWindIntensity)
        .mul(0.25);
      const windOffset = vec3(windXZ.x, windY, windXZ.y).mul(bendProfile);

      this.positionNode = bladePosition
        .add(swayOffset)
        .add(flutterOffset)
        .add(windOffset);

      const r2 = offsetX.mul(offsetX).add(offsetZ.mul(offsetZ));
      const near = float(1).sub(smoothstep(0, uniforms.uAoRadiusSq, r2));
      const edge = uv().x.mul(2).sub(1).abs();
      const rim = smoothstep(
        uniforms.uAoRimSmoothness.negate(),
        uniforms.uAoRimSmoothness,
        edge,
      );
      const hWeight = float(1).sub(smoothstep(0.1, 0.85, h));
      const aoStrength = uniforms.uAoScale.mul(0.25);
      const ao = float(1).sub(aoStrength.mul(near.mul(rim).mul(hWeight)));

      const colorProfile = h.mul(uniforms.uColorMixFactor);
      const jitter = smoothstep(
        0,
        uniforms.uColorVariationStrength,
        positionNoise,
      );
      const baseColorJittered = uniforms.uBaseColor.mul(jitter);
      const baseToTip = mix(
        baseColorJittered,
        uniforms.uTipColor,
        colorProfile,
      );
      const baseMask = float(1).sub(
        smoothstep(0, uniforms.uBaseShadeHeight, h),
      );
      const windAo = mix(
        1,
        float(1).sub(uniforms.uBaseWindShade),
        baseMask.mul(smoothstep(0, 1, swayFactor)),
      );
      const windTint = mix(
        float(1),
        float(1).add(uniforms.uWindColorStrength.mul(0.15)),
        swayFactor.mul(0.35),
      );
      const withShadow = mix(baseToTip.mul(0.5), baseToTip, shadowFactor);
      this.colorNode = withShadow
        .mul(windAo)
        .mul(windTint)
        .mul(ao)
        .mul(uniforms.uColorBrightness);
    }
  }
  return new RevoGrassMaterial();
}

export class RevoGrassSystem {
  constructor({ scene, config }) {
    this.scene = scene;
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = "RevoGrass";
    scene.add(this.group);

    this._mesh = null;
    this._ssbo = null;
    this._uniforms = null;
    this._revoConfig = null;
    this._windTex = null;
    this.mask = new RevoGrassMask(512);
    this._exclusionTex = this.mask.texture;
    this._exclusionSource = "mask";
    this._initialized = false;
    this._enabled = false;
    this._lastAnchor = new THREE.Vector3();
    this._anchorDelta = new THREE.Vector2();
    this._cameraMatrix = new THREE.Matrix4();
    this._playWindIntensity = 1;
    this._playWindAngleDeg = null;
  }

  resolveExclusionTexture(rp, geminiDensityTex) {
    const src = rp.exclusionSource ?? "mask";
    this._exclusionSource = src;
    if (src === "gemini" && geminiDensityTex) return geminiDensityTex;
    return this.mask.texture;
  }

  async init(renderer, heightTex, sunDir, toolState, opts = {}) {
    if (this._initialized) return;
    this._renderer = renderer;
    this._heightTex = heightTex;
    this._geminiDensityTex = opts.geminiDensityTex ?? null;
    this._terrainNormalTex = opts.terrainNormalTex ?? null;
    if (!this._terrainNormalTex) {
      // fallback: flat up-normal → slope rejection becomes a no-op
      const d = new Float32Array([0, 1, 0, 1]);
      this._terrainNormalTex = new THREE.DataTexture(
        d, 1, 1, THREE.RGBAFormat, THREE.FloatType,
      );
      this._terrainNormalTex.needsUpdate = true;
    }
    this._exclusionTex = this.resolveExclusionTexture(
      toolState.revoGrass,
      this._geminiDensityTex,
    );
    if (!this._windTex) {
      try {
        this._windTex = await loadRevoNoiseAtlas();
      } catch (err) {
        console.error(
          `[RevoGrass] failed to load ${REVO_NOISE_ATLAS_URL}:`,
          err,
        );
      }
    }
    this._initialized = true;
    this.setEnabled(toolState.revoGrass?.enabled);
    if (toolState.revoGrass?.enabled) {
      await this.rebuild(toolState.revoGrass, sunDir);
    }
  }

  /** Build GPU mesh on first enable — avoids ~1M instances allocated while Revo is off. */
  async ensureBuilt(rp, sunDir) {
    if (!this._initialized || !this._heightTex) return;
    if (this._mesh) return;
    await this.rebuild(rp, sunDir);
  }

  async rebuild(rp, sunDir) {
    this.disposeMesh();
    if (!this._heightTex || !this._windTex) {
      console.warn(
        "[RevoGrass] rebuild skipped — height/wind texture not ready",
      );
      return;
    }
    this._exclusionTex = this.resolveExclusionTexture(
      rp,
      this._geminiDensityTex,
    );
    this._revoConfig = getRevoGrassConfig(rp);
    const cfg = this._revoConfig;
    if (cfg.count >= 500_000) {
      console.warn(
        `[RevoGrass] ${cfg.count.toLocaleString()} instances — expect low FPS. Use Quality Balanced/High or lower Grid side.`,
      );
    }
    this._uniforms = buildUniforms(rp);
    const u = this._uniforms;
    u.uTerrainSize.value = this.config.world.size;
    u.uTileSize.value = cfg.tileSize;
    u.uBladeBoundsRadius.value = cfg.bladeHeight;
    if (sunDir) u.uSunDir.value.copy(sunDir);

    this._ssbo = createSsbo(cfg, u, {
      heightTex: this._heightTex,
      windTex: this._windTex,
      exclusionTex: this._exclusionTex,
      terrainNormalTex: this._terrainNormalTex,
    });
    const geom = createRevoBladeGeometry(cfg);
    const mat = createMaterial(this._ssbo, u);
    this._mesh = new THREE.InstancedMesh(geom, mat, cfg.count);
    this._mesh.frustumCulled = false;
    this._mesh.receiveShadow = rp.receiveShadow === true;
    this._mesh.castShadow = false;
    this.group.add(this._mesh);

    await this._renderer.computeAsync(this._ssbo.computeInit);
    this.setEnabled(rp.enabled);
  }

  disposeMesh() {
    if (this._mesh) {
      this.group.remove(this._mesh);
      this._mesh.geometry?.dispose();
      this._mesh.material?.dispose();
      this._mesh = null;
    }
    this._ssbo = null;
  }

  dispose() {
    this.disposeMesh();
    this.mask?.dispose();
    this.scene.remove(this.group);
    this._initialized = false;
  }

  setEnabled(on) {
    this._enabled = !!on;
    if (!on) {
      this.disposeMesh();
      this.group.visible = false;
      return;
    }
    this.group.visible = !!this._mesh;
  }

  syncFromState(rp, sunDir) {
    if (!this._uniforms) return;
    const u = this._uniforms;
    u.uBladeMinScale.value = rp.bladeMinScale ?? 0.75;
    u.uBladeMaxScale.value = rp.bladeMaxScale ?? 2;
    u.uClumpStrength.value = rp.clumpStrength ?? 0;
    u.uClumpScale.value = rp.clumpScale ?? 2.0;
    u.uBladeBoundsRadius.value = rp.bladeHeight ?? 1.75;
    u.uTrailGrowthRate.value = rp.trailGrowthRate ?? 0.04;
    u.uTrailMinScale.value = rp.trailMinScale ?? 0.25;
    const tr = rp.trailRadius ?? 1;
    u.uTrailRadius.value = tr;
    u.uTrailRadiusSq.value = tr * tr;
    u.uKDown.value = rp.trailCrushSpeed ?? 0.4;
    u.uWindStrength.value = rp.windStrength ?? 0.4;
    u.uWindSpeed.value = rp.windSpeed ?? 0.25;
    u.uWindIntensity.value = rp.windIntensity ?? 1;
    const wr = ((rp.windAngle ?? 0) * Math.PI) / 180;
    u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
    u.uUvWindScale.value = rp.uvWindScale ?? 1.75;
    u.uBaseColor.value.copy(srgbColor(rp.baseColor ?? "#8c6b30"));
    u.uTipColor.value.copy(srgbColor(rp.tipColor ?? "#4a780a"));
    u.uColorMixFactor.value = rp.colorMixFactor ?? 0.125;
    u.uColorVariationStrength.value = rp.colorVariationStrength ?? 2.75;
    u.uWindColorStrength.value = rp.windColorStrength ?? 0.6;
    u.uColorBrightness.value = rp.colorBrightness ?? 1;
    u.uAoScale.value = rp.aoScale ?? 0.5;
    u.uAoRimSmoothness.value = rp.aoRimSmoothness ?? 5;
    const aoR = rp.aoRadius ?? 25;
    u.uAoRadiusSq.value = aoR * aoR;
    u.uBaseWindShade.value = rp.baseWindShade ?? 0.75;
    u.uBaseShadeHeight.value = rp.baseShadeHeight ?? 1;
    u.uBaseBending.value = rp.baseBending ?? 2;
    u.uStochasticR0.value = rp.stochasticR0 ?? 10;
    u.uStochasticR1.value = rp.stochasticR1 ?? 60;
    u.uStochasticPMin.value = rp.stochasticPMin ?? 0.1;
    u.uPlayerRadius.value = rp.playerRadius ?? 0.5;
    u.uCullPadNdcX.value = rp.cullPadNdcX ?? 0.075;
    u.uCullPadNdcYNear.value = rp.cullPadNdcYNear ?? 0.75;
    u.uCullPadNdcYFar.value = rp.cullPadNdcYFar ?? 0.2;
    u.uFrustumCullEnabled.value = rp.frustumCullEnabled !== false ? 1 : 0;
    u.uBakedShadowWeight.value = rp.bakedShadowWeight ?? 1;
    u.uPlayerShadowEnabled.value = rp.playerShadowEnabled !== false ? 1 : 0;
    u.uExclusionEnabled.value = rp.exclusionEnabled ? 1 : 0;
    u.uExclusionThreshold.value = rp.exclusionThreshold ?? 0.25;
    u.uSlopeEnabled.value = rp.slopeEnabled !== false ? 1 : 0;
    u.uSlopeMin.value = rp.slopeMin ?? 0.65;
    u.uSlopeMax.value = rp.slopeMax ?? 0.85;
    if (sunDir) u.uSunDir.value.copy(sunDir);
    this.setEnabled(rp.enabled);
  }

  setPlayWind({ intensityMul, angleDeg } = {}) {
    if (intensityMul != null) this._playWindIntensity = intensityMul;
    if (angleDeg != null) this._playWindAngleDeg = angleDeg;
  }

  update(rp, anchorPos, camera, opts = {}) {
    if (!this._initialized || !this._enabled || !this._mesh || !this._ssbo)
      return;

    const u = this._uniforms;
    // Effective wind intensity = slider (max-gust scale) × gust state machine
    // (opts.gustMul, revo-realms WindManager cycle) × play-mode ambient wind.
    let _intensityMul = opts.gustMul ?? 1;
    if (opts.playMode && rp.useGlobalWindInPlay !== false) {
      _intensityMul *= this._playWindIntensity;
      if (this._playWindAngleDeg != null) {
        const wr = (this._playWindAngleDeg * Math.PI) / 180;
        u.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
      }
    }
    u.uWindIntensity.value = (rp.windIntensity ?? 1) * _intensityMul;
    if (opts.slopeWindow) {
      // linked to auto-cliff: caller supplies converted normal.y thresholds
      u.uSlopeMin.value = opts.slopeWindow.min;
      u.uSlopeMax.value = opts.slopeWindow.max;
    }

    const dx = anchorPos.x - this._lastAnchor.x;
    const dz = anchorPos.z - this._lastAnchor.z;
    this._anchorDelta.set(dx, dz);
    u.uAnchorDeltaXZ.value.copy(this._anchorDelta);
    u.uAnchorPosition.value.copy(anchorPos);
    this._mesh.position.set(anchorPos.x, 0, anchorPos.z);

    if (camera) {
      this._cameraMatrix.multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      );
      u.uCameraMatrix.value.copy(this._cameraMatrix);
      const e = camera.projectionMatrix.elements;
      u.uFx.value = e[0];
      u.uFy.value = e[5];
    }

    this._lastAnchor.copy(anchorPos);

    // Per-frame SYNCHRONOUS compute, queued ahead of this frame's render.
    // The old three-tier throttle + computeAsync busy-flag capped the wind
    // sim at an effective 10–30 Hz (stepped/laggy motion — the original
    // revo-realms computes every frame). Proven fix in the hybrid grass:
    // same cadence as the renderer, ~0.1–0.4 ms even at Ultra density.
    this._renderer.compute(this._ssbo.computeUpdate);
  }

  precompile(renderer, camera) {
    if (!this._mesh) return Promise.resolve();
    return renderer.compileAsync(this._mesh, camera);
  }
}
