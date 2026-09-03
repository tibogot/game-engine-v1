// ============================================================================
// WORLD RAIN — drops that actually fall, and actually land on the track.
//
// The lens (modularRoadRainLens.js) says "it is raining" and the wet road
// (modularRoadWet.js) says "it has rained". Nothing fell in between. This is
// the middle of that chain: streaks in the air, and a splash at the exact
// point the deck is, whatever height the deck happens to be at.
//
// Ported from sunag's `webgpu_compute_particles_rain` three.js example (MIT),
// which is the reference implementation of the technique — the same one behind
// threejspunk.vercel.app, credited there to @sea3dformat. The port is not a
// copy: four things had to change to survive a stunt track, and each is marked
// PORT NOTE below.
//
// ── HOW A DROP KNOWS WHERE THE FLOOR IS ─────────────────────────────────────
//
// Not a raycast, not the deck BVH, not the terrain sampler. An orthographic
// camera above the car renders the scene straight down with an override
// material whose colour IS `positionWorld`, into a render target. The result is
// a top-down table of "the world position of the nearest surface above this
// spot", and collision is then ONE TEXTURE FETCH per drop:
//
//     sample = texture(collisionRT, uvFor(drop.xz))
//     if (drop.y < sample.y + offset) -> splash here, respawn at the top
//
// No CPU step, no per-drop query, no acceleration structure, and the cost is
// completely independent of how complicated the track is. It is also, for
// once, exactly right about overhangs: the buffer holds the TOPMOST surface,
// and rain genuinely should stop on the roof of a loop rather than fall
// through it onto the deck below.
//
// ── PORT NOTE 1: THE COLLIDER LAYER IS OPT-IN ───────────────────────────────
//
// The example bakes the whole scene. This bakes only objects that have enabled
// RAIN_COLLIDER_LAYER, exactly like REFLECT_LAYER in modularRoadReflection.js,
// and for the same reason: the cost of the bake is then something you choose
// rather than something you discover. The deck and the rails opt in. The sky,
// the clouds, the god-ray geometry, the terrain and the rain itself never
// enter it — the drops sit on layer 0, so they are excluded for free.
//
// ── PORT NOTE 2: fp32, NOT HALF FLOAT ───────────────────────────────────────
//
// The example uses HalfFloatType and gets away with it because its whole world
// fits in a 100 m box at the origin. Half float has an 11-bit mantissa: at a
// world coordinate of 2000 m the representable spacing is 2 METRES, so on a
// point-to-point track that runs any distance from the start the floor height
// would quantise into visible terraces and the splashes would hover. fp32 at
// the same distance is good to a fraction of a millimetre. 512² RGBA32F is
// 4 MB, which is not a number worth trading correctness for.
//
// ── PORT NOTE 3: ALPHA IS A VALIDITY FLAG ───────────────────────────────────
//
// The example's world has a floor everywhere, so "the buffer says y = 0" and
// "there is nothing here" are the same answer and it never has to tell them
// apart. A stunt track is a ribbon in the sky with a great deal of nothing
// beside it, and in sky mode there is no ground at all. Clearing to black and
// trusting `.y` would make every drop that misses the deck splash on an
// invisible floor at y = 0.
//
// So the target is cleared with alpha 0 and the override material writes alpha
// 1 wherever it draws. `.w > 0.5` means "a real surface"; anything else means
// "no floor here", and the drop falls until the recycle floor catches it.
//
// ── PORT NOTE 4: THE WINDOW MOVES, AND DROPS WRAP AROUND IT ─────────────────
//
// The example's box is nailed to the origin. This one follows the car and is
// pushed `forwardOffset` metres ahead of it, because at 30 m/s the budget is
// much better spent on the road you are about to reach than the road you have
// left. Drops that leave the window are not respawned — they WRAP, modulo the
// window size, so the population is constant and no drop is ever wasted.
//
// ── COST SHAPE, MEASURED ────────────────────────────────────────────────────
//
// world-rain-lab.html, 1920x889, 4000 drops, four interleaved rounds of 40
// frames each, medians. The lab can switch all three parts off independently,
// which is the only way any of these numbers mean anything.
//
// At native resolution the whole system costs +0.131 ms (0.197 -> 0.328, and
// all four rounds agreed exactly) — but the timestamp query quantises to
// ~0.065 ms steps, so that is "two quanta" and not really a measurement. Run
// at pixelRatio 3 (9x the pixels) it separates:
//
//     scene alone                    1.573 ms
//     + collision bake               1.638      +0.065
//     + compute and drops            1.769      +0.131
//     + splashes                     1.901      +0.131
//
// Which says the thing worth knowing:
//
//   • THE BAKE IS RESOLUTION-INDEPENDENT. It is always 512², so it costs the
//     same at 720p and 4K — it did not move at all between 1x and 3x. It is
//     the only part that scales with the SCENE instead, which is why it is the
//     only part with a `frameSkip`. In this lab it renders ten simple objects;
//     in game it will be the merged deck plus the rails, so this is the number
//     that will change and the first place to look.
//   • THE DROPS AND SPLASHES ARE PURE FILL. Both scale with pixel count, and
//     between them they are 80% of the cost. Drop count buys frame time here,
//     not in the compute — measured over the 1.573 baseline at 3x, on an
//     earlier revision of the two fragment shaders: 1000 +0.196, 2000 +0.262,
//     4000 +0.459, 8000 +0.655, 12000 +0.983. The shape is what matters (it is
//     roughly linear above 2000); the absolute figures ran ~0.13 ms high
//     because that sweep predates the current shaders.
//   • THE COMPUTE IS FREE. 0.066 ms on its own timestamp pool at 4000 drops,
//     and it does not move with the count at this scale.
//
// Two caveats on the above. `frameSkip` 1, 2 and 4 were indistinguishable —
// the lab's bake is too cheap to show through the quantisation, so the knob is
// unproven and only justified by the shape of the thing. And the drop material
// is additive-ish blended over a mostly-empty sky here; over a bright city the
// fill cost is the same but the overdraw that matters may not be.
// ============================================================================

import * as THREE from "three";
import {
  Fn, If, uniform, texture, uv, float, vec2, vec3, mix, attribute,
  instancedArray, instanceIndex, hash, deltaTime, time,
  positionWorld, positionGeometry, billboarding, cameraPosition,
} from "three/tsl";

/**
 * The layer a mesh must enable to STOP RAIN.
 *
 * 1 and 2 are REFLECT_LAYER and PREMIRROR_LAYER (modularRoadReflection.js),
 * 18 and 19 are the two cloud decks. 3 is free.
 *
 * Objects ENABLE this rather than being moved to it, so a deck piece collides
 * with rain and still draws normally, with no clone and no second material.
 */
export const RAIN_COLLIDER_LAYER = 3;

/**
 * Authored defaults. Everything the look depends on is a uniform, so the lab
 * drives it live; the three that are NOT (`count`, `resolution`, `maxCount`)
 * are allocation sizes and rebuild.
 */
export const WORLD_RAIN_DEFAULTS = {
  /** Drops alive at once. Also the splash population — they are paired. */
  count: 4000,
  /** Hard ceiling the storage buffers are allocated at. Changing `count`
   *  below this is free of allocation; crossing it is not allowed. */
  maxCount: 12000,

  /* ── THE WINDOW ─────────────────────────────────────────────────────────── */
  /** Side of the square patch of world that has rain in it, metres. Also the
   *  ortho camera's extent, so it trades directly against texel size:
   *  `area / resolution` is the collision map's ground resolution. */
  area: 100,
  /** Collision map side, texels. 512 over a 100 m window is 0.2 m/texel —
   *  about a fifth of a kerb. Below 256 the splashes start missing rail feet. */
  resolution: 512,
  /** How far ahead of the focus point the window sits, metres. At 30 m/s a
   *  centred window spends half its drops behind the car. */
  forwardOffset: 18,
  /** Bake every Nth frame. The buffer is only wrong by however far the car
   *  moved in the meantime, and the drops it feeds are 1 cm wide. */
  frameSkip: 1,
  /** Ortho camera height above the focus, and how deep it sees. Together they
   *  are the altitude band that can collide: [focusY - depth + height,
   *  focusY + height]. Wide enough for a loop, tight enough for fp32. */
  cameraHeight: 40,
  depth: 140,

  /* ── FALL ───────────────────────────────────────────────────────────────── */
  /** Spawn height above the focus, metres. */
  spawnHeight: 26,
  /** Terminal velocity, m/s. Real rain is 5-9; this is faster because a game
   *  frame is 16 ms and slow rain reads as snow. */
  fallSpeed: 16,
  /** Per-drop spread on the above, so the field does not fall as a sheet. */
  fallJitter: 4,
  /** Horizontal drift, m/s, world space. The game drives this from car
   *  velocity so rain leans into the windscreen. */
  leanX: 0,
  leanZ: 0,
  /** Below focusY - this, a drop is recycled even if it never hit anything.
   *  The only thing that catches drops falling beside the deck. */
  recycleDrop: 60,

  /* ── LOOK ───────────────────────────────────────────────────────────────── */
  dropWidth: 0.05,
  dropLength: 1.6,
  dropOpacity: 0.32,
  /** Drops closer than `nearFadeStart` are invisible and fade in by
   *  `nearFadeEnd`. A drop that reaches the camera otherwise covers the screen
   *  for a frame; on a chase camera that happens constantly. */
  nearFadeStart: 1.2,
  nearFadeEnd: 4.5,
  /**
   * Where the window's soft edge begins, as a fraction of its half-extent.
   *
   * Without this the rain stops dead at the wrap boundary and you can see the
   * square: a wall of drops with dry air beyond it, moving with the car. The
   * fade runs from here out to 1.0, which inscribes a CIRCLE in the square —
   * so the corners (which reach 1.41) are gone entirely and there is no
   * straight edge left to notice.
   *
   * The cost of that is about a fifth of the drops rendered invisible, so the
   * effective rain radius is `area / 2`, not the diagonal. That is the honest
   * reading of this number: the window's half-extent IS the rain draw
   * distance.
   */
  edgeFadeStart: 0.55,
  /**
   * Optional distance fade, metres from the camera. Off by default — with a
   * 100 m window nothing can be further than 50 m away, so there is nothing to
   * fade and the scene's own fog would never reach it either.
   *
   * It exists for the case where `area` is raised past the fog's near plane.
   * The drops CANNOT use `material.fog` to solve that: fog is computed from
   * `positionView`, and billboarding() replaces the vertex position wholesale,
   * so every drop would be fogged as though it were at the mesh's origin.
   */
  farFadeStart: 9000,
  farFadeEnd: 10000,
  /** Tint. Rain is not white — it is a slightly cool grey lens on whatever is
   *  behind it, and pure white reads as sparks. */
  dropColor: 0xdce8f2,

  /* ── SPLASH ─────────────────────────────────────────────────────────────── */
  splashes: true,
  /** Metres across at full expansion. */
  splashSize: 0.55,
  /** How fast a splash plays out; 1/lifetime, roughly. */
  splashRate: 3.4,
  splashOpacity: 0.45,
  /** How far above the sampled surface the splash and the hit test sit. Stops
   *  z-fighting with the deck and hides the collision map's texel size. */
  surfaceOffset: 0.05,
};

/** Marks (or unmarks) an object and its descendants as something rain lands on. */
export function markRainCollider(object, on = true) {
  object.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh && !o.isBatchedMesh) return;
    if (on) o.layers.enable(RAIN_COLLIDER_LAYER);
    else o.layers.disable(RAIN_COLLIDER_LAYER);
  });
  return object;
}

/**
 * Three quads: one lying flat, two standing and crossed.
 *
 * The flat one carries the ring spreading across the surface; the crossed pair
 * carries the crown going up. They need DIFFERENT shading — a ring drawn on a
 * vertical quad reads as a fuzzy eye, which is exactly what the first version
 * looked like from close to the ground — so each vertex carries a `part` flag
 * and the material branches on it.
 *
 * Built by hand rather than through mergeGeometries because the whole thing is
 * 18 vertices and an addons import for that is silly — and because merging
 * geometries whose attribute sets disagree is a documented way to get a silent
 * empty mesh in this repo.
 */
function makeSplashGeometry() {
  const quads = [
    // part 0 — flat: spans x/z, sits at y = 0
    { part: 0, v: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5], [-0.5, 0, 0.5]] },
    // part 1 — crown A: spans x/y, base at y = 0
    { part: 1, v: [[-0.28, 0, 0], [0.28, 0, 0], [0.28, 1, 0], [-0.28, 1, 0]] },
    // part 1 — crown B: spans z/y
    { part: 1, v: [[0, 0, -0.28], [0, 0, 0.28], [0, 1, 0.28], [0, 1, -0.28]] },
  ];
  const pos = [];
  const uvs = [];
  const parts = [];
  for (const q of quads) {
    // two triangles, 0-1-2 and 0-2-3
    for (const i of [0, 1, 2, 0, 2, 3]) { pos.push(...q.v[i]); parts.push(q.part); }
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]) uvs.push(u, v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("part", new THREE.Float32BufferAttribute(parts, 1));
  // Never culled: every instance is somewhere else entirely, so the geometry's
  // own bounds are meaningless. See the same note on the drop mesh.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return g;
}

/**
 * The top-down world-position buffer.
 *
 * Deliberately a plain object rather than a class with a scene reference: the
 * bake borrows the caller's scene for the duration of one render and gives it
 * back, and that is easier to audit when the scene arrives as an argument.
 */
function createCollisionMap(renderer, params) {
  const renderTarget = new THREE.RenderTarget(params.resolution, params.resolution, {
    // PORT NOTE 2. fp32, and Nearest because a filtered surface height is a
    // height that exists nowhere — halfway between the deck and the void is
    // not a place a drop should land.
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
  });
  renderTarget.texture.name = "RainCollisionMap";
  renderTarget.texture.colorSpace = THREE.NoColorSpace;

  const half = params.area / 2;
  const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, params.depth);
  // PORT NOTE 1: opt-in. disableAll() first, so layer 0 — where every ordinary
  // object including the rain itself lives — is excluded by construction.
  camera.layers.disableAll();
  camera.layers.enable(RAIN_COLLIDER_LAYER);

  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = positionWorld;
  // Fog would blend the stored WORLD POSITION toward the fog colour, which is
  // not a subtle error — it would drag every distant surface toward the origin.
  material.fog = false;
  material.toneMapped = false;
  material.side = THREE.DoubleSide;

  const centre = new THREE.Vector3();
  /** The centre the CURRENT contents were baked at. With frameSkip > 1 this is
   *  not `centre`, and the compute must decode against this one. */
  const bakedCentre = uniform(new THREE.Vector3());
  const areaU = uniform(params.area);

  const _prevClear = new THREE.Color();

  function setArea(a) {
    const h = a / 2;
    camera.left = -h; camera.right = h; camera.top = h; camera.bottom = -h;
    camera.updateProjectionMatrix();
    areaU.value = a;
  }

  function setDepth(d) {
    camera.far = d;
    camera.updateProjectionMatrix();
  }

  /**
   * Render the collider layer straight down into the target.
   *
   * Synchronous from start to finish ON PURPOSE: it leaves renderer state dirty
   * (render target, MRT, clear colour) for the duration, and this repo has
   * already been bitten once by a bake that held dirty global renderer state
   * across an `await`. Nothing in here may become async.
   */
  function bake(scene) {
    bakedCentre.value.copy(centre);

    camera.position.set(centre.x, centre.y + params.cameraHeight, centre.z);
    // Straight down. Matrix4.lookAt's degenerate-axis fallback resolves this to
    // right = +X, up = -Z, and the render target's V flip cancels the up sign —
    // which is why uvFor() below is a plain (p - centre)/area + 0.5 on BOTH
    // axes even though that looks like it is missing a flip.
    camera.lookAt(centre.x, centre.y, centre.z);
    camera.updateMatrixWorld(true);

    const prevRT = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT ? renderer.getMRT() : null;
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevAutoClear = renderer.autoClear;
    const prevAlpha = renderer.getClearAlpha();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(_prevClear);

    // three refreshes shadow maps once per render() call, so without this the
    // bake pays for a SECOND full shadow pass every frame it runs — which on a
    // scene with a 2048² directional shadow is far more than the bake itself.
    // modularRoadReflection.js does the same thing around its mirror render.
    renderer.shadowMap.autoUpdate = false;

    // A background would fill the target with opaque pixels and defeat the
    // alpha validity flag entirely — every "no floor here" texel would read as
    // a floor at whatever the sky's colour happens to decode to.
    scene.background = null;
    scene.overrideMaterial = material;
    if (renderer.setMRT) renderer.setMRT(null);
    // PORT NOTE 3: alpha 0 is "nothing here".
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);

    renderer.setRenderTarget(prevRT);
    if (renderer.setMRT) renderer.setMRT(prevMRT);
    renderer.setClearColor(_prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
  }

  return {
    renderTarget, camera, material, centre, bakedCentre, areaU,
    setArea, setDepth, bake,
    dispose() { renderTarget.dispose(); material.dispose(); },
  };
}

/**
 * @param {Object}          opts
 * @param {THREE.Scene}     opts.scene
 * @param {THREE.Renderer}  opts.renderer
 * @param {Object}         [opts.params]  overrides on WORLD_RAIN_DEFAULTS
 */
export function createWorldRain({ scene, renderer, params: overrides = {} } = {}) {
  if (!scene || !renderer) throw new Error("createWorldRain needs { scene, renderer }");

  const params = { ...WORLD_RAIN_DEFAULTS, ...overrides };
  const maxCount = Math.max(1, Math.round(params.maxCount));
  let count = Math.min(maxCount, Math.max(1, Math.round(params.count)));

  const collision = createCollisionMap(renderer, params);

  /* ── UNIFORMS ─────────────────────────────────────────────────────────── */
  const uCentre = collision.bakedCentre;   // shared: decode against the BAKE
  const uArea = collision.areaU;
  const uLive = uniform(new THREE.Vector3());   // where the window is THIS frame
  const uSpawnHeight = uniform(params.spawnHeight);
  const uFallSpeed = uniform(params.fallSpeed);
  const uFallJitter = uniform(params.fallJitter);
  const uLean = uniform(new THREE.Vector2(params.leanX, params.leanZ));
  const uRecycle = uniform(params.recycleDrop);
  const uSurfaceOffset = uniform(params.surfaceOffset);
  const uSplashRate = uniform(params.splashRate);
  const uDropOpacity = uniform(params.dropOpacity);
  const uSplashOpacity = uniform(params.splashOpacity);
  const uSplashSize = uniform(params.splashSize);
  const uNearFadeStart = uniform(params.nearFadeStart);
  const uNearFadeEnd = uniform(params.nearFadeEnd);
  const uEdgeFadeStart = uniform(params.edgeFadeStart);
  const uFarFadeStart = uniform(params.farFadeStart);
  const uFarFadeEnd = uniform(params.farFadeEnd);

  /**
   * The soft boundary, shared by drops and splashes so they cannot disagree
   * about where the rain stops. Takes the WORLD position of the thing being
   * shaded (a storage-buffer attribute, which becomes a varying) and returns
   * 1 in the middle of the window, 0 at its inscribed circle.
   *
   * `uLive`, not `uCentre`: this is where the window is NOW, whereas the baked
   * centre may be a frame or two stale under frameSkip. A fade that lagged the
   * window would let drops pop at the trailing edge.
   */
  const windowFade = (worldPos) => {
    const d = worldPos.xz.sub(uLive.xz).length().div(uArea.mul(0.5));
    return d.smoothstep(uEdgeFadeStart, float(1)).oneMinus();
  };

  /* ── STATE ────────────────────────────────────────────────────────────── */
  // Allocated at maxCount once. `count` only changes how many are dispatched
  // and drawn, so the slider is free of allocation.
  const positionBuffer = instancedArray(maxCount, "vec3");
  const velocityBuffer = instancedArray(maxCount, "vec3");
  const splashBuffer = instancedArray(maxCount, "vec3");
  const splashTimeBuffer = instancedArray(maxCount, "vec3");

  /** A splash whose clock is past this is finished and draws nothing. */
  const SPLASH_DEAD = 1000;

  /**
   * Time-varying per-drop random in [0,1).
   *
   * `hash` truncates its seed to a uint, so `instanceIndex.add(time)` — which
   * is what the reference does — only produces a new value when `time` crosses
   * a whole second: every drop that respawns inside the same second lands on
   * the same lattice. Scaling time up fixes it. Exact to ~2.7 hours of uptime
   * in fp32, which is longer than a session.
   */
  const rand = (salt) => hash(instanceIndex.toFloat().add(salt).add(time.mul(1731)));
  /** Fixed per-drop random — same value every frame, for per-drop character. */
  const fixed = (salt) => hash(instanceIndex.toFloat().add(salt));

  /** World XZ -> collision map UV. See the lookAt note in bake(). */
  const uvFor = (xz) => xz.sub(uCentre.xz).div(uArea).add(0.5);

  /* ── COMPUTE ──────────────────────────────────────────────────────────── */

  const computeInit = Fn(() => {
    const pos = positionBuffer.element(instanceIndex);
    const vel = velocityBuffer.element(instanceIndex);
    const st = splashTimeBuffer.element(instanceIndex);

    const rx = fixed(0);
    const ry = fixed(101);
    const rz = fixed(202);

    pos.x = rx.sub(0.5).mul(uArea).add(uLive.x);
    pos.z = rz.sub(0.5).mul(uArea).add(uLive.z);
    pos.y = ry.mul(uSpawnHeight).add(uLive.y);

    vel.x = uLean.x;
    vel.z = uLean.y;
    vel.y = uFallSpeed.add(rx.mul(uFallJitter)).negate();

    st.x = float(SPLASH_DEAD);
  })().compute(maxCount);

  const computeUpdate = Fn(() => {
    const pos = positionBuffer.element(instanceIndex);
    const vel = velocityBuffer.element(instanceIndex);
    const sp = splashBuffer.element(instanceIndex);
    const st = splashTimeBuffer.element(instanceIndex);

    // Clamped: a tab that comes back from the background hands you a delta of
    // several seconds, and an unclamped step teleports the whole field through
    // the deck in one frame — every drop misses the test and nothing splashes.
    const dt = deltaTime.min(0.05).toVar();

    // Lean is a uniform, not stored state, so changing it steers drops already
    // in the air rather than only the ones yet to spawn.
    vel.x = uLean.x;
    vel.z = uLean.y;
    pos.addAssign(vel.mul(dt));

    st.x = st.x.add(dt.mul(uSplashRate));

    // PORT NOTE 4: wrap, do not respawn. fract() of the offset from the window
    // centre keeps the population constant as the window chases the car.
    const rel = pos.xz.sub(uLive.xz).add(uArea.mul(0.5)).div(uArea).fract().sub(0.5).mul(uArea).toVar();
    pos.x = uLive.x.add(rel.x);
    pos.z = uLive.z.add(rel.y);

    const hit = texture(collision.renderTarget.texture, uvFor(pos.xz)).toVar();
    const solid = hit.w.greaterThan(0.5);
    const floorY = hit.y.add(uSurfaceOffset);

    If(solid.and(pos.y.lessThan(floorY)), () => {
      // Land: hand the splash this exact point, start its clock.
      sp.x = pos.x;
      sp.y = floorY;
      sp.z = pos.z;
      st.x = float(0);

      // ...and put the drop back at the top somewhere else, so the field does
      // not develop bald patches where it has already rained.
      pos.x = rand(11).sub(0.5).mul(uArea).add(uLive.x);
      pos.z = rand(22).sub(0.5).mul(uArea).add(uLive.z);
      pos.y = uLive.y.add(uSpawnHeight).add(rand(33).mul(4));
      vel.y = uFallSpeed.add(rand(44).mul(uFallJitter)).negate();
    });

    // Nothing under it and still falling: the recycle floor. Without this,
    // every drop that misses the deck falls forever and the field thins out
    // to nothing in about four seconds.
    If(pos.y.lessThan(uLive.y.sub(uRecycle)), () => {
      pos.y = uLive.y.add(uSpawnHeight).add(rand(55).mul(4));
      pos.x = rand(66).sub(0.5).mul(uArea).add(uLive.x);
      pos.z = rand(77).sub(0.5).mul(uArea).add(uLive.z);
      vel.y = uFallSpeed.add(rand(88).mul(uFallJitter)).negate();
    });

    // A splash sits on a surface that may have MOVED — this track has movers
    // and a called lift. Re-read the map under the splash and kill it if the
    // floor is no longer where it was standing, rather than leave a ring
    // hanging in the air where a platform used to be.
    const under = texture(collision.renderTarget.texture, uvFor(sp.xz)).toVar();
    If(under.w.lessThan(0.5).or(sp.y.sub(under.y).abs().greaterThan(0.5)), () => {
      st.x = float(SPLASH_DEAD);
    });
  });

  let computeStep = computeUpdate().compute(count);

  /* ── DROPS ────────────────────────────────────────────────────────────── */

  const dropMaterial = new THREE.MeshBasicNodeMaterial();
  dropMaterial.colorNode = vec3(
    ((params.dropColor >> 16) & 255) / 255,
    ((params.dropColor >> 8) & 255) / 255,
    (params.dropColor & 255) / 255,
  );
  {
    // No texture, deliberately — a rain streak is a soft-edged gradient and a
    // 64×64 png of one is strictly worse than the arithmetic. Across: a squared
    // falloff from the centre line. Along: faded at both ends so the quad's
    // corners never show.
    const t = uv();
    const across = t.x.sub(0.5).abs().mul(2).oneMinus().pow(2);
    const along = t.y.smoothstep(0, 0.16).mul(t.y.oneMinus().smoothstep(0, 0.34));

    // NEAR FADE, and it is not optional. A 1.6 m billboard that passes within
    // a metre of the camera covers the entire screen for one frame and reads
    // as a white bar across the picture — which is exactly what a chase camera
    // driving through a rain field does, several times a second.
    //
    // The distance has to come from the drop's WORLD position, not positionView:
    // billboarding() replaces the vertex position wholesale, so positionView
    // describes where the quad would have been, not where it is. Reading the
    // storage buffer's attribute in the fragment stage makes it a varying.
    const dropWorld = positionBuffer.toAttribute();
    const toCam = dropWorld.sub(cameraPosition).length().toVar();
    const nearFade = toCam.smoothstep(uNearFadeStart, uNearFadeEnd);
    const farFade = toCam.smoothstep(uFarFadeStart, uFarFadeEnd).oneMinus();

    dropMaterial.opacityNode = across.mul(along)
      .mul(nearFade).mul(farFade).mul(windowFade(dropWorld))
      .mul(uDropOpacity);
  }
  dropMaterial.vertexNode = billboarding({ position: positionBuffer.toAttribute() });
  dropMaterial.transparent = true;
  dropMaterial.depthWrite = false;
  dropMaterial.depthTest = true;
  dropMaterial.side = THREE.DoubleSide;
  dropMaterial.forceSinglePass = true;
  dropMaterial.toneMapped = false;
  dropMaterial.fog = false;

  // Unit quad, pivot at the BOTTOM so a drop's tail trails upward from the
  // point the buffer holds; size comes from mesh.scale, which billboarding()
  // reads off the world matrix — so the sliders never rebuild the geometry.
  const dropGeometry = new THREE.PlaneGeometry(1, 1);
  dropGeometry.translate(0, 0.5, 0);
  dropGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

  const dropMesh = new THREE.Mesh(dropGeometry, dropMaterial);
  dropMesh.count = count;
  dropMesh.scale.set(params.dropWidth, params.dropLength, 1);
  // Every instance is somewhere else, so the object's own bounds say nothing
  // about where it draws. Culling on them empties the sky at random.
  dropMesh.frustumCulled = false;
  dropMesh.renderOrder = 12;
  dropMesh.matrixAutoUpdate = true;

  /* ── SPLASHES ─────────────────────────────────────────────────────────── */

  const splashClock = splashTimeBuffer.element(instanceIndex).x;

  const splashMaterial = new THREE.MeshBasicNodeMaterial();
  splashMaterial.colorNode = vec3(0.86, 0.92, 1.0);
  {
    // The reference example shades all three quads with ONE radial pulse. Seen
    // from a distance in a demo that is fine; from a metre off the deck it is
    // two soft grey blobs — a smeared ellipse on the ground and a lens-shaped
    // eye standing up out of it, because a radial ring drawn on a VERTICAL
    // quad is an eye. So the two parts get different shapes.
    const t = uv();
    const part = attribute("part", "float");
    const clock = splashClock.toVar();
    // Everything is over by clock = 1; `life` is the master envelope.
    const life = clock.oneMinus().clamp().toVar();

    // ── RING, on the flat quad ──────────────────────────────────────────────
    // A THIN annulus whose radius chases the clock. Thin is the whole point:
    // the fat triangular pulse is what read as a smoke ring rather than water.
    // At a grazing angle a thin ring foreshortens into a thin ellipse, which is
    // simply what a ring on the ground looks like from there.
    const r = t.sub(vec2(0.5)).length().mul(2).toVar();
    const front = clock.pow(0.6).toVar();          // fast at first, then eases
    const w = float(0.09).add(clock.mul(0.1));     // softens slightly as it goes
    // NOTE the `.oneMinus()` on the outer edge rather than a smoothstep with
    // its arguments swapped. WGSL leaves `smoothstep(low, high, x)` UNDEFINED
    // when low >= high; the reversed form happened to work on this GPU, which
    // is the worst way for it to be wrong.
    const ring = r.smoothstep(front.sub(w), front)
      .mul(r.smoothstep(front, front.add(w)).oneMinus())
      .mul(front.oneMinus().clamp().pow(0.5));     // thins out as it spreads

    // ── CROWN, on the crossed vertical quads ────────────────────────────────
    // A short upward burst: a cone that opens with height, with a front that
    // travels up and is gone by a third of the life. Brief and small, because
    // the ring is what reads as "a drop landed" and the crown is only there to
    // stop the splash being flat.
    const h = t.y.toVar();
    const across = t.x.sub(0.5).abs().mul(2);
    const cone = across.div(h.mul(1.5).add(0.22)).oneMinus().clamp().pow(1.5);
    const top = clock.mul(3.2).toVar();             // the front, travelling up
    const rise = h.smoothstep(top.sub(0.55), top).oneMinus();   // same UB note
    const crown = cone.mul(rise).mul(clock.mul(3).oneMinus().clamp());

    // Same soft boundary as the drops, off the splash's own world position —
    // otherwise the drops fade into a circle and the splashes keep landing in
    // a square, which is the tell that gives the window away.
    splashMaterial.opacityNode = mix(ring, crown, part)
      .mul(life)
      .mul(windowFade(splashBuffer.toAttribute()))
      .mul(uSplashOpacity);
  }
  // positionGeometry, NOT positionLocal: anything that instances writes into
  // positionLocal, and reading it back here gets the modified value.
  //
  // The buffer holds WORLD positions and this is a LOCAL position node, so the
  // group below must stay at the identity transform. Moving it would slide
  // every splash off its surface. (The drops do not care — billboarding()
  // overwrites the world matrix's translation outright.)
  splashMaterial.positionNode = positionGeometry
    .mul(uSplashSize)
    .add(splashBuffer.toAttribute());
  splashMaterial.transparent = true;
  splashMaterial.depthWrite = false;
  splashMaterial.depthTest = true;
  splashMaterial.side = THREE.DoubleSide;
  splashMaterial.forceSinglePass = true;
  splashMaterial.toneMapped = false;
  splashMaterial.fog = false;

  const splashMesh = new THREE.Mesh(makeSplashGeometry(), splashMaterial);
  splashMesh.count = count;
  splashMesh.frustumCulled = false;
  splashMesh.renderOrder = 11;
  splashMesh.visible = params.splashes;

  const group = new THREE.Group();
  group.name = "WorldRain";
  group.add(dropMesh, splashMesh);
  scene.add(group);

  /* ── DRIVE ────────────────────────────────────────────────────────────── */

  const _fwd = new THREE.Vector3();
  let frame = 0;
  let enabled = true;
  let bakeEnabled = true;
  let dropsEnabled = true;
  let seeded = false;

  /**
   * @param {THREE.Vector3} focusPos   where the car is
   * @param {THREE.Vector3} [focusDir] which way it faces; flattened, used only
   *                                   to push the window ahead
   */
  function update(focusPos, focusDir = null) {
    if (!enabled) return;

    _fwd.set(0, 0, 0);
    if (focusDir) {
      _fwd.copy(focusDir);
      _fwd.y = 0;
      if (_fwd.lengthSq() > 1e-6) _fwd.normalize().multiplyScalar(params.forwardOffset);
      else _fwd.set(0, 0, 0);
    }

    collision.centre.set(focusPos.x + _fwd.x, focusPos.y, focusPos.z + _fwd.z);
    uLive.value.copy(collision.centre);

    if (!seeded) {
      // Seed AFTER the first centre is known, or the whole field spawns around
      // the origin and takes a window-width of travel to catch up.
      uCentre.value.copy(collision.centre);
      renderer.compute(computeInit);
      seeded = true;
    }

    const skip = Math.max(1, Math.round(params.frameSkip));
    if (bakeEnabled && frame % skip === 0) collision.bake(scene);
    frame += 1;

    if (dropsEnabled) renderer.compute(computeStep);
  }

  /* ── CONTROLS ─────────────────────────────────────────────────────────── */

  function setCount(n) {
    const next = Math.min(maxCount, Math.max(1, Math.round(n)));
    if (next === count) return;
    count = next;
    dropMesh.count = count;
    splashMesh.count = count;
    // A new dispatch size is a new pipeline, so this recompiles. Fine on a
    // slider release; do not call it per frame.
    computeStep = computeUpdate().compute(count);
  }

  function setEnabled(on) {
    enabled = !!on;
    group.visible = enabled;
  }

  function setSplashesEnabled(on) {
    params.splashes = !!on;
    splashMesh.visible = params.splashes;
  }

  function setLean(x, z) {
    uLean.value.set(x, z);
  }

  return {
    group, dropMesh, splashMesh,
    collisionTexture: collision.renderTarget.texture,
    /** Exposed for readback: the only way to assert what the bake actually
     *  contains rather than infer it from where the splashes ended up. */
    collisionTarget: collision.renderTarget,
    collisionCamera: collision.camera,
    /** World XZ -> texel, for a readback. Mirrors uvFor() exactly. */
    texelFor(x, z) {
      const c = collision.bakedCentre.value;
      const res = params.resolution;
      return [
        Math.floor(((x - c.x) / params.area + 0.5) * res),
        Math.floor(((z - c.z) / params.area + 0.5) * res),
      ];
    },
    params,
    layer: RAIN_COLLIDER_LAYER,

    update,
    setEnabled,
    setCount,
    setSplashesEnabled,
    setLean,
    getCount: () => count,

    /** Isolation switches — the lab measures each third of the cost with these. */
    setBakeEnabled: (on) => { bakeEnabled = !!on; },
    setDropsEnabled: (on) => { dropsEnabled = !!on; dropMesh.visible = !!on; },

    setArea: (a) => { params.area = a; collision.setArea(a); },
    setDepth: (d) => { params.depth = d; collision.setDepth(d); },
    setSpawnHeight: (v) => { params.spawnHeight = v; uSpawnHeight.value = v; },
    setFallSpeed: (v) => { params.fallSpeed = v; uFallSpeed.value = v; },
    setFallJitter: (v) => { params.fallJitter = v; uFallJitter.value = v; },
    setRecycle: (v) => { params.recycleDrop = v; uRecycle.value = v; },
    setSurfaceOffset: (v) => { params.surfaceOffset = v; uSurfaceOffset.value = v; },
    setSplashRate: (v) => { params.splashRate = v; uSplashRate.value = v; },
    setDropOpacity: (v) => { params.dropOpacity = v; uDropOpacity.value = v; },
    setSplashOpacity: (v) => { params.splashOpacity = v; uSplashOpacity.value = v; },
    setSplashSize: (v) => { params.splashSize = v; uSplashSize.value = v; },
    setNearFade: (start, end) => {
      params.nearFadeStart = start; params.nearFadeEnd = end;
      uNearFadeStart.value = start; uNearFadeEnd.value = end;
    },
    setEdgeFade: (v) => { params.edgeFadeStart = v; uEdgeFadeStart.value = v; },
    setFarFade: (start, end) => {
      params.farFadeStart = start; params.farFadeEnd = end;
      uFarFadeStart.value = start; uFarFadeEnd.value = end;
    },
    setDropSize: (w, l) => {
      params.dropWidth = w; params.dropLength = l;
      dropMesh.scale.set(w, l, 1);
    },

    dispose() {
      scene.remove(group);
      dropGeometry.dispose();
      dropMaterial.dispose();
      splashMesh.geometry.dispose();
      splashMaterial.dispose();
      collision.dispose();
    },
  };
}
