/**
 * Interactive Ground Fog — TSL port of adammyhre's Unity URP effect
 * (gist 192275218a61156680e1186752418a1f: FogSim.compute, FogSimulation.cs,
 * FogVolume.shader, FogObstacle.cs).
 *
 * It looks like a fluid sim and is not one. There is no stored velocity field,
 * no divergence, no pressure solve — the only persistent state is ONE scalar
 * density texture over the ground plane. Each step evaluates an ANALYTIC
 * velocity per texel (constant wind + a radial push away from the player scaled
 * by the player's own speed + a tangential swirl whose sin() term is what sheds
 * the wake), advects density along it with a single semi-Lagrangian back-trace,
 * multiplies in soft holes for the player and the obstacles, then lerps toward a
 * drifting two-octave value-noise target so the carved wake heals over.
 *
 * That is why it ports cleanly and costs nothing: 65k texels of state and one
 * dependent texture fetch per texel.
 *
 * Port notes — what changed, and why:
 *
 *   compute kernel → fragment pass. The original dispatches CSMain over an
 *     RWTexture2D. Here it is a QuadMesh writing into one of two ping-ponged
 *     RenderTargets. A TSL compute kernel would be closer to 1:1, but the
 *     advection back-trace depends on BILINEAR filtering of the previous state
 *     (that filter is what makes the wake smooth rather than blocky), and a
 *     sampled render target gets it free where a storage texture does not.
 *     `uv()` at a fragment centre is exactly the kernel's (id.xy + 0.5) / res.
 *
 *   StructuredBuffer<Obstacle> → one baked mask texture. WebGPU does have
 *     storage buffers, but FogSimulation.cs uploads the obstacle list once in
 *     Start() and never touches it again, so the per-texel loop collapses into
 *     a single R8 texture baked on the CPU: the same product of the same
 *     smoothsteps, no loop, and it scales to hundreds of obstacles for free.
 *     Obstacles that MOVE would need the loop back — see setObstacles().
 *
 *   RFloat → RGBA16F. Sampling an fp32 target with a linear filter needs the
 *     float32-filterable feature, and this field is re-sampled every step. fp16
 *     across 0..1.4 carries far more precision than a density the eye only ever
 *     sees integrated through ~16 raymarch steps.
 *
 * Kept faithful on purpose, including the parts that are technically wrong:
 *
 *   - The raymarch runs in OBJECT space on a non-uniformly scaled cube, so a
 *     30 m horizontal traversal and a 3 m vertical one are both 1.0 of optical
 *     depth. Physically indefensible, and precisely what keeps the fog reading
 *     the same from a grazing angle as from overhead. It is the original's look.
 *   - Front faces are culled and the volume depth-tests normally, so anything
 *     standing inside the volume removes all the fog in front of it. The design
 *     hides that: the player and every obstacle carve a hole around themselves,
 *     so there is almost no fog there to lose. See GroundFog.setHeight() for the
 *     one place this bites (the ground plane itself).
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Break, Fn, If, Loop, cameraPosition, dot, exp, float, floor, fract, length,
  max, min, mix, modelWorldMatrixInverse, normalize, positionGeometry, saturate,
  sin, smoothstep, texture, uniform, uv, varying, vec2, vec3, vec4,
} from "three/tsl";

/** Straight from the gist's serialized fields and shader properties. */
export const GROUND_FOG_DEFAULTS = {
  resolution: 256,
  areaSize: 30, // metres across the simulated square
  // Metres of vertical slab. Not a gist parameter — that is just the box's scale
  // in the Unity scene. Density is full for the bottom fifth and fades out by the
  // top, so 2.4 m puts the dense core at knee height and the last wisps at head
  // height on a 2 m character.
  height: 2.4,
  playerRadius: 1.8, // metres
  wind: [0.02, 0.008], // UV per second
  push: 4.5,
  swirl: 1.5,
  regrow: 0.25,
  densityScale: 6,
  steps: 16,
  // Shader-side (linear) values, NOT sRGB hex. Unity hands a URP shader the
  // linear form of a Color property, so these are the numbers the HLSL saw.
  fogColor: [0.85, 0.9, 1.0],
  shadowColor: [0.45, 0.5, 0.62],
};

/**
 * Raymarch loop is unrolled to a constant bound with a dynamic break, the same
 * shape volumetricCloudSystem uses: WGSL needs a static trip count, and the
 * live step count is a uniform so the branch stays uniform across the wave.
 */
export const MAX_VOLUME_STEPS = 64;

/**
 * The volume's bottom face is lifted this far above the ground. Front faces are
 * culled, so the fragment being shaded lies on the FAR side of the box — if the
 * bottom face sat at or below the ground plane, the ground would win the depth
 * test for every downward-looking pixel and the fog would vanish completely.
 */
const GROUND_CLEARANCE = 0.02;

// ── the gist's Hash/Noise, kept bit-for-bit ────────────────────────────────
// sin()-based hashing is precision-sensitive, but WGSL and GLSL ES 3.0 are both
// f32 here, same as the HLSL, so the lattice matches. Swap in a noise texture
// if this ever has to run at mediump.
const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const valueNoise = Fn(([p]) => {
  const i = floor(p).toVar();
  const f = fract(p).toVar();
  const w = f.mul(f).mul(float(3).sub(f.mul(2))).toVar();
  const a = hash(i);
  const b = hash(i.add(vec2(1, 0)));
  const c = hash(i.add(vec2(0, 1)));
  const d = hash(i.add(vec2(1, 1)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
});

export class GroundFog {
  /**
   * @param {THREE.WebGPURenderer} renderer
   * @param {object} [options] - Any of GROUND_FOG_DEFAULTS, plus `center`
   *   (THREE.Vector3; x/z pick the simulated square, y is the ground height).
   */
  constructor(renderer, options = {}) {
    const p = { ...GROUND_FOG_DEFAULTS, ...options };

    this.renderer = renderer;
    this.resolution = p.resolution;
    this.areaSize = p.areaSize;
    this.center = options.center ? options.center.clone() : new THREE.Vector3();

    /** Seconds of simulated time. Drives the swirl phase and the noise drift. */
    this.simTime = 0;

    this._current = 0;
    this._previousPlayer = new THREE.Vector3().copy(this.center);
    this._uv = new THREE.Vector2(0.5, 0.5);
    this._previousUv = new THREE.Vector2(0.5, 0.5);

    this.uniforms = {
      playerUv: uniform(new THREE.Vector2(0.5, 0.5)),
      playerVel: uniform(new THREE.Vector2(0, 0)),
      playerRadius: uniform(p.playerRadius / p.areaSize),
      wind: uniform(new THREE.Vector2(p.wind[0], p.wind[1])),
      push: uniform(p.push),
      swirl: uniform(p.swirl),
      regrow: uniform(p.regrow),
      time: uniform(0),
      dt: uniform(0),
      densityScale: uniform(p.densityScale),
      steps: uniform(p.steps),
      fogColor: uniform(new THREE.Color().setRGB(...p.fogColor)),
      shadowColor: uniform(new THREE.Color().setRGB(...p.shadowColor)),
    };

    this._targets = [0, 1].map(() => {
      const rt = new THREE.RenderTarget(this.resolution, this.resolution, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.NoColorSpace,
        // The linearClampSampler the kernel advects with. Both halves matter:
        // NEAREST would blockify the wake, and repeat wrapping would make fog
        // cleared at one edge reappear at the opposite one.
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.wrapS = THREE.ClampToEdgeWrapping;
      rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      rt.texture.name = "groundFogDensity";
      return rt;
    });

    this._maskData = new Uint8Array(this.resolution * this.resolution).fill(255);
    this.obstacleTexture = new THREE.DataTexture(
      this._maskData,
      this.resolution,
      this.resolution,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.obstacleTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.obstacleTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.obstacleTexture.minFilter = THREE.LinearFilter;
    this.obstacleTexture.magFilter = THREE.LinearFilter;
    this.obstacleTexture.needsUpdate = true;

    // One material per source target rather than one material whose texture is
    // reassigned: a TextureNode is baked into the compiled shader's bind group,
    // and swapping the mesh's material is the cheapest way to stay honest about
    // which half of the ping-pong is being read this frame.
    this._simMaterials = this._targets.map((rt) => this._createSimMaterial(rt.texture));
    this._simQuad = new QuadMesh(this._simMaterials[0]);

    this._volumeMaterials = this._targets.map((rt) => this._createVolumeMaterial(rt.texture));

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this._volumeMaterials[0]);
    this.mesh.name = "groundFogVolume";
    this.mesh.renderOrder = 10;
    this.setHeight(p.height);
  }

  /** Index of the target holding the newest density. Ping-pong is observable. */
  get currentIndex() {
    return this._current;
  }

  /** Both density textures, so callers can build their own material pair. */
  get densityTextures() {
    return this._targets.map((rt) => rt.texture);
  }

  setHeight(height) {
    this.height = height;
    this.mesh.scale.set(this.areaSize, height, this.areaSize);
    this.mesh.position.set(
      this.center.x,
      this.center.y + height * 0.5 + GROUND_CLEARANCE,
      this.center.z,
    );
  }

  /** Volume parity switch: off is the physically nicer read, on is Unity's. */
  setDepthTest(enabled) {
    for (const material of this._volumeMaterials) {
      material.depthTest = enabled;
      material.needsUpdate = true;
    }
  }

  /** World XZ → simulation UV. FogSimulation.WorldToUv, verbatim. */
  worldToUv(world, target = new THREE.Vector2()) {
    return target.set(
      (world.x - this.center.x) / this.areaSize + 0.5,
      (world.z - this.center.z) / this.areaSize + 0.5,
    );
  }

  /**
   * Bake the static obstacle discs into the mask. This is the CPU mirror of the
   * kernel's `for (obstacles) density *= smoothstep(r * 0.6, r, dist)` loop —
   * same product, same falloff, evaluated once instead of every texel every
   * frame. Radii are in metres.
   *
   * @param {Array<{x: number, z: number, radius: number}>} obstacles
   */
  setObstacles(obstacles) {
    const res = this.resolution;
    const data = this._maskData;
    data.fill(255);

    for (const obstacle of obstacles) {
      const cu = (obstacle.x - this.center.x) / this.areaSize + 0.5;
      const cv = (obstacle.z - this.center.z) / this.areaSize + 0.5;
      const outer = obstacle.radius / this.areaSize;
      const inner = outer * 0.6;
      if (outer <= inner) continue;

      // Only the disc's texel window, so obstacle count costs what it should.
      const x0 = Math.max(0, Math.floor((cu - outer) * res - 1));
      const x1 = Math.min(res - 1, Math.ceil((cu + outer) * res));
      const y0 = Math.max(0, Math.floor((cv - outer) * res - 1));
      const y1 = Math.min(res - 1, Math.ceil((cv + outer) * res));

      for (let y = y0; y <= y1; y++) {
        const v = (y + 0.5) / res;
        for (let x = x0; x <= x1; x++) {
          const u = (x + 0.5) / res;
          const dist = Math.hypot(u - cu, v - cv);
          if (dist >= outer) continue;
          const t = Math.min(1, Math.max(0, (dist - inner) / (outer - inner)));
          const falloff = t * t * (3 - 2 * t);
          const index = y * res + x;
          data[index] = Math.round((data[index] / 255) * falloff * 255);
        }
      }
    }

    this.obstacleTexture.needsUpdate = true;
  }

  /**
   * Run the field forward without a moving player, so the first frame shows
   * fully grown fog instead of an empty texture (FogSimulation.Start's 90×0.1s
   * loop). Unlike the original this advances simTime, which lets the noise
   * target drift while priming — the field settles less uniformly, for free.
   */
  prime(playerWorld, steps = 90, dt = 0.1) {
    this._previousPlayer.copy(playerWorld);
    for (let i = 0; i < steps; i++) this.update(dt, playerWorld);
  }

  /**
   * One simulation step. Call before rendering the scene — it binds its own
   * render target.
   *
   * @param {number} dt - Seconds. Clamp it upstream: advection distance and the
   *   regrow lerp are both dt-scaled, so a frame spike visibly lengthens the
   *   wake and then over-heals it.
   * @param {THREE.Vector3} playerWorld
   */
  update(dt, playerWorld) {
    const u = this.uniforms;

    this.worldToUv(playerWorld, this._uv);
    this.worldToUv(this._previousPlayer, this._previousUv);
    u.playerUv.value.copy(this._uv);
    u.playerVel.value.set(
      dt > 0 ? (this._uv.x - this._previousUv.x) / dt : 0,
      dt > 0 ? (this._uv.y - this._previousUv.y) / dt : 0,
    );

    this.simTime += dt;
    u.time.value = this.simTime;
    u.dt.value = dt;

    const next = 1 - this._current;
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;

    renderer.autoClear = false;
    renderer.setRenderTarget(this._targets[next]);
    this._simQuad.material = this._simMaterials[this._current];
    this._simQuad.render(renderer);
    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;

    this._current = next;
    this.mesh.material = this._volumeMaterials[next];
    this._previousPlayer.copy(playerWorld);
  }

  dispose() {
    for (const rt of this._targets) rt.dispose();
    for (const material of this._simMaterials) material.dispose();
    for (const material of this._volumeMaterials) material.dispose();
    this.obstacleTexture.dispose();
    this.mesh.geometry.dispose();
  }

  // ── FogSim.compute ───────────────────────────────────────────────────────
  _createSimMaterial(sourceTexture) {
    const u = this.uniforms;
    const source = texture(sourceTexture);
    const obstacles = texture(this.obstacleTexture);

    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const p = uv().toVar();

      // Analytic velocity field: wind + radial push away from the player +
      // tangential swirl for the wake. Nothing here reads the previous
      // velocity, which is exactly why the whole sim is one texture.
      const toTexel = p.sub(u.playerUv).toVar();
      const dist = length(toTexel).toVar();
      const dir = toTexel.div(max(dist, float(1e-5))).toVar();
      const influence = exp(
        dist.mul(dist).negate().div(u.playerRadius.mul(u.playerRadius).mul(8)),
      ).toVar();
      const speed = length(u.playerVel).toVar();
      const velocity = u.wind
        .add(dir.mul(speed.mul(u.push).mul(influence)))
        .add(
          vec2(dir.y.negate(), dir.x).mul(
            speed
              .mul(u.swirl)
              .mul(influence)
              .mul(sin(u.time.mul(3).add(dist.mul(60)))),
          ),
        )
        .toVar();

      // Semi-Lagrangian advection: back-trace along the velocity and sample
      // where the fog came from.
      const density = source.sample(p.sub(velocity.mul(u.dt))).level(0).r.toVar();

      // The player body itself carves a hole in the fog; the obstacles carve
      // theirs through the pre-baked mask.
      density.mulAssign(smoothstep(u.playerRadius.mul(0.6), u.playerRadius, dist));
      density.mulAssign(obstacles.sample(p).level(0).r);

      // Slowly regrow toward a drifting two-octave noise target so the wake
      // heals over. Squaring the noise is what keeps the field patchy instead
      // of an even haze.
      const drift = u.wind.mul(u.time).toVar();
      const n = valueNoise(p.mul(6).add(drift.mul(4)))
        .mul(0.65)
        .add(valueNoise(p.mul(14).sub(drift.mul(2))).mul(0.35));

      return vec4(mix(density, n.mul(n).mul(1.4), saturate(u.regrow.mul(u.dt))), 0, 0, 1);
    })();

    return material;
  }

  // ── FogVolume.shader ─────────────────────────────────────────────────────
  _createVolumeMaterial(densityTexture) {
    const u = this.uniforms;
    const density = texture(densityTexture);

    // Object space IS the unit cube: the mesh is a 1×1×1 box scaled to the fog
    // area, so the slab test below is against ±0.5 and the density lookup is
    // p.xz + 0.5, exactly as in the HLSL.
    const rayOrigin = varying(
      vec3(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz),
      "groundFogRayOrigin",
    );
    const rayDirection = varying(positionGeometry.sub(rayOrigin), "groundFogRayDir");

    const material = new THREE.MeshBasicNodeMaterial();
    material.fragmentNode = Fn(() => {
      const ro = rayOrigin.toVar();
      const rd = normalize(rayDirection).toVar();

      // Slab intersection against the unit cube.
      const t0 = vec3(-0.5).sub(ro).div(rd);
      const t1 = vec3(0.5).sub(ro).div(rd);
      const tmin = min(t0, t1).toVar();
      const tmax = max(t0, t1).toVar();
      const near = max(max(tmin.x, tmin.y), tmin.z).max(0).toVar(); // camera may be inside
      const far = min(min(tmax.x, tmax.y), tmax.z).toVar();

      const stepSize = far.sub(near).div(u.steps).toVar();
      const p = ro.add(rd.mul(near.add(stepSize.mul(0.5)))).toVar();
      const dp = rd.mul(stepSize).toVar();

      const color = vec3(0).toVar();
      const transmittance = float(1).toVar();

      Loop(MAX_VOLUME_STEPS, ({ i }) => {
        If(float(i).greaterThanEqual(u.steps), () => {
          Break();
        });

        // Explicit LOD, like the original's SAMPLE_TEXTURE2D_LOD: there are no
        // meaningful derivatives inside a raymarch, and an explicit level is
        // also what keeps the sample legal under WGSL's uniformity rules.
        const d = density.sample(p.xz.add(0.5)).level(0).r.toVar();

        // Fog thins toward the top of the slab. Written as 1 - smoothstep(lo,
        // hi) because the HLSL relies on smoothstep(0.5, -0.3, y) with the
        // edges reversed, which WGSL leaves undefined. Same curve, defined.
        d.mulAssign(
          float(1).sub(smoothstep(float(-0.3), float(0.5), p.y)).mul(u.densityScale),
        );

        const a = float(1).sub(exp(d.mul(stepSize).negate())).toVar(); // Beer-Lambert
        color.addAssign(
          mix(u.shadowColor, u.fogColor, saturate(p.y.add(0.7))).mul(a.mul(transmittance)),
        );
        transmittance.mulAssign(float(1).sub(a));
        p.addAssign(dp);
      });

      return vec4(color, float(1).sub(transmittance));
    })();

    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.BackSide; // Cull Front
    material.fog = false;

    // `Blend One OneMinusSrcAlpha`. The accumulator above already weights each
    // step by its own transmittance, so the colour leaving the shader is
    // premultiplied and must not be scaled by alpha a second time.
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendSrcAlpha = THREE.OneFactor;
    material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;

    return material;
  }
}
