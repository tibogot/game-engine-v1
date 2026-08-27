/**
 * PLANAR REFLECTION OF THE CAR, for the wet road.
 *
 * ── WHY NOT SSR, AND WHY NOT THE WHOLE WORLD ─────────────────────────────────
 *
 * With only an environment map, a puddle can mirror the sky and nothing else —
 * and a smooth gradient sky mirrors to nothing at all, which is why the wet
 * shading alone reads as "lighter patches" rather than as water. The missing
 * ingredient is reflection CONTENT, and on a road the nearest, brightest, most
 * obviously-attached thing to reflect is the player's own car.
 *
 * Screen-space reflections would get the car AND the guardrails AND the lamps
 * for one cost, and the ray-march is already written (v3/render/water/
 * lakeMaterial.js). But the road is OPAQUE and drawn early, so SSR needs the
 * grabbed backbuffer to exist first — a transparent second pass over the deck —
 * plus edge fade, thickness tuning and the usual screen-border artefacts.
 *
 * This is the bounded version: mirror the camera about the plane of the deck
 * UNDER THE CAR, render only what is on the reflection layer into a small
 * target, and project it back onto the road. What it costs is exactly what you
 * choose to put on that layer, which is the property SSR does not have.
 *
 * ── THE PLANE ────────────────────────────────────────────────────────────────
 *
 * Not y=0, and not the piece — the deck frame under the car, handed in per
 * frame. That is what makes this work on a stunt track: a banked hold, the
 * inside of a loop and a half-pipe all have a perfectly good local plane, it
 * just is not horizontal. The reflection is only geometrically correct ON that
 * plane, so it fades out with distance from the contact point (`fadeStart` /
 * `fadeEnd` in the material) rather than smearing across a curve.
 *
 * ── RESOLUTION ───────────────────────────────────────────────────────────────
 *
 * Deliberately small. The reflection lands on a surface with a roughness of
 * 0.02–0.22, so it is a blurred image no matter how sharply it was rendered;
 * paying for a full-resolution one throws the pixels away. Half scale is the
 * default and quarter is usually indistinguishable in motion.
 */

import * as THREE from "three";

/**
 * The layer reflection-only geometry lives on.
 *
 * Objects ENABLE this layer rather than being moved to it, so the car renders
 * in both the main view and the reflection with no clone, no second material
 * and no transform to keep in sync. Anything that does not enable it — the
 * road, the ground, the sky — simply is not in the reflection pass, which is
 * how the cost stays bounded.
 *
 * Lights must enable it too: three tests `light.layers` against the object's,
 * so a light left on layer 0 lights the car in the main view and leaves it
 * black in the mirror.
 */
export const REFLECT_LAYER = 1;

/**
 * The layer for geometry that is ALREADY MIRRORED, drawn with the REAL camera.
 *
 * A planar mirror is a camera trick, and camera tricks are only true on the
 * plane. The alternative is older and has no plane in it at all: build the
 * reflected object, and look at it with the ordinary eye. Whatever shape the
 * road is, a mirrored guardrail sits where its reflection belongs, because it
 * was mirrored per-vertex about the deck at its own station rather than about
 * one plane fitted under the car. See buildMirroredRailGeometry.
 *
 * Because the real camera renders it, the result lands at the fragment's own
 * screen position — so the road samples this target at screenUV, with no
 * texture matrix and no projection to get wrong.
 *
 * Objects here SET the layer instead of enabling it: a mirrored rail must never
 * appear in the main view.
 */
export const PREMIRROR_LAYER = 2;

/**
 * Clip → 0..1 texture space, WITH V FLIPPED.
 *
 * The −0.5 in the second row is the WebGPU difference and it is not optional.
 * three's WebGL Reflector uses +0.5 there, because GL's framebuffer origin and
 * its texture origin agree; under WebGPU the render target is written
 * top-down while `texture()` samples v=0 at the top, so an unflipped matrix
 * projects the deck to the half of the target the car is never in. Measured:
 * the car occupied v 0.64–1.00 while the deck in front of the camera projected
 * to v 0.08–0.41 — no overlap at all, which reads on screen as a reflection
 * that is simply missing rather than as one that is upside down.
 */
const _biasMatrix = /*#__PURE__*/ new THREE.Matrix4().set(
  0.5, 0.0, 0.0, 0.5,
  0.0, -0.5, 0.0, 0.5,
  0.0, 0.0, 0.5, 0.5,
  0.0, 0.0, 0.0, 1.0,
);

export function createCarReflection({
  renderer,
  scene,
  width = 512,
  height = 512,
} = {}) {
  // TWO TARGETS, PING-PONGED, AND THIS IS NOT AN OPTIMISATION.
  //
  // The road SAMPLES this texture and the mirror pass WRITES it, and WebGPU
  // forbids a texture being bound readable and writable in the same
  // synchronization scope:
  //
  //   [Texture "CarReflection"] usage (TextureBinding|RenderAttachment) includes
  //   writable usage and another usage in the same synchronization scope.
  //   [Invalid CommandBuffer] is invalid due to a previous error.
  //
  // The whole command buffer is then discarded. It cost a long time to find
  // because it is a WARNING, not a throw, and because the symptom is a
  // reflection that is simply never there — indistinguishable from one that is
  // too dim, mis-projected or multiplied to zero.
  //
  // It does NOT reproduce in wet-road-lab, which renders straight to the canvas
  // and so gets a natural boundary between the two passes. road.html runs the
  // v3 post pipeline, which batches the mirror pass and the scene that samples
  // it into one command encoder — same scope, instant conflict.
  //
  // So: write into the back buffer, hand the front one to the material, swap.
  // The material samples a texture nothing is writing this frame, which is the
  // standard fix and the reason every planar-reflection implementation
  // double-buffers.
  /**
   * @param {boolean} [readableDepth] attach a DepthTexture, so a shader can
   *   sample how far away what it drew actually was. Only the PRE-MIRROR pass
   *   needs it — see the occlusion note on `preTargets`.
   */
  const makeTarget = (i, readableDepth = false) => {
    const t = new THREE.RenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 0,
    });
    if (readableDepth) {
      // FLOAT, not the default unsigned int: the road linearises this back to
      // metres and compares it against its own view depth, and a 24-bit integer
      // depth quantises hard enough at distance to make that comparison jitter.
      const d = new THREE.DepthTexture(width, height);
      d.type = THREE.FloatType;
      d.name = `MirrorDepth${i}`;
      t.depthTexture = d;
    }
    t.texture.name = `CarReflection${i}`;
    t.texture.minFilter = THREE.LinearFilter;
    t.texture.magFilter = THREE.LinearFilter;
    t.texture.generateMipmaps = false;
    t.texture.wrapS = THREE.ClampToEdgeWrapping;
    t.texture.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };
  const targets = [makeTarget(0), makeTarget(1)];
  /** Index of the target the material should SAMPLE — the one written last. */
  let front = 0;

  // Second pair, for the pre-mirrored pass. Ping-ponged for the same
  // read/write-in-one-scope reason as the first; the road samples this one too.
  /**
   * THE PRE-MIRROR PASS HAS NO OCCLUDERS, and that is why it needs readable
   * depth.
   *
 * `updatePreMirrored` sets the camera to PREMIRROR_LAYER, on which ONLY the
 * already-mirrored geometry lives (the rail, and tall props like the neon
 * arm) — no road, no terrain, nothing. So the pass cannot hide
 * anything behind anything, and the road then samples it at screenUV with no
 * test: whatever mirrored content lands on a pixel is shown by whatever deck
 * fragment is at that pixel. Over a crest that means the mirrored rail of the
 * road BEYOND the hill draws straight through the hill.
   *
   * Depth-testing the pass against the real road does NOT fix it, and the
   * reason is worth writing down because it is the obvious thing to try: the
   * mirrored rail sits BELOW its own deck (buildMirroredRailGeometry negates
   * `up`), so the deck is between the eye and its own reflection. Testing
   * against the real road would occlude every reflection, the correct ones
   * included. Ignoring depth is not an oversight in this pass, it is required.
   *
   * What separates the two cases is HOW FAR the mirrored geometry is from the
   * fragment displaying it. A correct reflection is a metre or two away — the
   * rail is about that far above its deck, so its mirror is about that far
   * below. A see-through is tens of metres. So the road samples this depth and
   * rejects anything too far from its own, which is the same "how many metres
   * wrong is this" test `reflectErrTol` already applies to the planar mirror.
   */
  const preTargets = [makeTarget("Pre0", true), makeTarget("Pre1", true)];
  let preFront = 0;
  let preActive = false;

  const virtualCamera = new THREE.PerspectiveCamera();
  virtualCamera.layers.set(REFLECT_LAYER);

  // ── THE SLAB ───────────────────────────────────────────────────────────────
  //
  // A planar mirror is only truthful about geometry NEAR its plane. Reflecting
  // something `h` above the plane puts its image `h` below; if the surface it
  // lands on has meanwhile curved away, the image is wrong by roughly 2h — and
  // wrong in a direction, not a blur. That is the inverted guardrail: measured
  // on Apex Parkour's banked dip, rails 20-40 m from the car sit up to 12 m off
  // the plane, so their reflections are displaced by ~24 m and run downhill
  // while the real rail climbs.
  //
  // No fade applied to the RECEIVING fragment can fix this. The floor near the
  // car is legitimately on the plane; it is the content of the mirror that does
  // not belong there. Three successive fades — plane distance, coplanarity
  // angle, metres of error — all measured the wrong end and all failed.
  //
  // So the mirror pass clips to a slab around the plane. Geometry outside it is
  // never drawn into the target, which is both correct and cheaper. The car
  // lives at the plane by construction and always survives; a guardrail
  // survives while the road is locally flat and drops out the moment the piece
  // starts to curve away, which is exactly when its reflection stopped being
  // true.
  const _slabAbove = new THREE.Plane();
  const _slabBelow = new THREE.Plane();
  const _slabPoint = new THREE.Vector3();
  /** Half-height of that slab, in metres. Comfortably clears a car (~1.3 m) and
   *  cuts rails once a crest, dip or bank has lifted them away. */
  let slabHalf = 3.0;

  const textureMatrix = new THREE.Matrix4();

  const _planePoint = new THREE.Vector3();
  const _normal = new THREE.Vector3();
  const _camPos = new THREE.Vector3();
  const _view = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _lookAt = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _rot = new THREE.Matrix4();

  let enabled = true;

  return {
    /** The texture to SAMPLE this frame. Changes identity every frame, so the
     *  material must follow it — see `_reflectTextureNode` on the road material
     *  and the `.sample(uv)` form that makes a swappable texture node legal. */
    get texture() { return targets[front].texture; },
    /** Exposed for readback when debugging an empty mirror. */
    get target() { return targets[front]; },
    textureMatrix,
    camera: virtualCamera,
    get enabled() { return enabled; },
    set enabled(v) { enabled = v; },

    /** Half-height of the clipping slab around the mirror plane, in metres. */
    get slab() { return slabHalf; },
    set slab(v) { slabHalf = Math.max(0.2, +v || 0.2); },

    setSize(w, h) {
      const W = Math.max(2, w | 0);
      const H = Math.max(2, h | 0);
      for (const t of targets) t.setSize(W, H);
      // The pre-mirrored pass is sampled at screenUV, so unlike the planar
      // mirror it wants the VIEW's aspect ratio, not just some small square.
      for (const t of preTargets) {
        t.setSize(W, H);
        // RenderTarget.setSize resizes an attached depthTexture, but its image
        // dimensions are what the sampler uses — keep them in step explicitly.
        if (t.depthTexture) {
          t.depthTexture.image.width = W;
          t.depthTexture.image.height = H;
          t.depthTexture.needsUpdate = true;
        }
      }
    },

    /**
     * Render the reflection for this frame.
     *
     * @param {THREE.Camera} camera     the real view camera
     * @param {THREE.Vector3} point     a point ON the mirror plane (world)
     * @param {THREE.Vector3} normal    the plane's unit normal (world)
     * @returns {boolean} false if the camera is behind the plane and nothing
     *   was rendered — the caller should then fade the reflection out rather
     *   than sample a stale frame.
     */
    update(camera, point, normal) {
      if (!enabled) return false;

      _planePoint.copy(point);
      _normal.copy(normal).normalize();
      _camPos.setFromMatrixPosition(camera.matrixWorld);

      // Camera under the plane: there is no reflection to see, and mirroring
      // anyway produces a camera pointing into the deck.
      _view.subVectors(_camPos, _planePoint);
      if (_view.dot(_normal) <= 0) return false;

      // MIRROR THE EYE POINT. The operand order matters and is not the
      // intuitive one: `Vector3.reflect` already flips the normal component, so
      // reflecting (camera − plane) gives the mirrored offset directly and a
      // `.negate()` on top of it undoes the mirror and flips the whole vector
      // instead. Written the other way round — (plane − camera), reflect,
      // negate — the two negations cancel and it is correct. That is the order
      // three's own Reflector uses, and getting it wrong here left the virtual
      // camera at the real camera's HEIGHT with its Z mirrored, which renders a
      // plausible-looking image of nothing useful.
      _view.subVectors(_planePoint, _camPos).reflect(_normal).negate().add(_planePoint);

      // ...and mirror what it is looking at, so the virtual camera keeps the
      // real one's orientation rather than just its position.
      _rot.extractRotation(camera.matrixWorld);
      _lookAt.set(0, 0, -1).applyMatrix4(_rot).add(_camPos);
      _target.subVectors(_planePoint, _lookAt).reflect(_normal).negate().add(_planePoint);

      _up.set(0, 1, 0).applyMatrix4(_rot).reflect(_normal);

      virtualCamera.position.copy(_view);
      virtualCamera.up.copy(_up);
      virtualCamera.lookAt(_target);
      virtualCamera.near = camera.near;
      virtualCamera.far = camera.far;
      virtualCamera.updateMatrixWorld(true);
      // COPIED, not rebuilt from fov/aspect: the projection has to match the
      // real camera's exactly, and copying survives anything the caller has
      // done to it that fov and aspect do not describe.
      virtualCamera.projectionMatrix.copy(camera.projectionMatrix);
      virtualCamera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);

      textureMatrix
        .copy(_biasMatrix)
        .multiply(virtualCamera.projectionMatrix)
        .multiply(virtualCamera.matrixWorldInverse);

      // The pass wants a TRANSPARENT clear and no fog: the target holds the car
      // on nothing, and the road adds `rgb * a`, so anywhere the car is not is
      // simply left alone. A fogged or sky-filled target would instead paint a
      // second, wrongly-parallaxed sky over the deck's own reflection.
      const prevTarget = renderer.getRenderTarget();
      const prevBackground = scene.background;
      const prevFog = scene.fog;
      const prevAlpha = renderer.getClearAlpha();
      const prevClear = renderer.getClearColor(new THREE.Color());
      // Shadow maps are rebuilt once per render() call, so without this the
      // reflection pass pays for a full cascade update that the main pass is
      // about to redo a millisecond later. The main render re-enables it.
      const prevShadowAuto = renderer.shadowMap.autoUpdate;

      const prevClipping = renderer.clippingPlanes;

      // Clip to the slab — see the note where the planes are declared.
      _slabPoint.copy(_planePoint).addScaledVector(_normal, slabHalf);
      _slabAbove.setFromNormalAndCoplanarPoint(_normal.clone().negate(), _slabPoint);
      _slabPoint.copy(_planePoint).addScaledVector(_normal, -slabHalf);
      _slabBelow.setFromNormalAndCoplanarPoint(_normal, _slabPoint);

      scene.background = null;
      scene.fog = null;
      renderer.clippingPlanes = [_slabAbove, _slabBelow];
      renderer.shadowMap.autoUpdate = false;
      renderer.setClearColor(0x000000, 0);
      // Write to the BACK buffer; the material is still sampling the front one.
      const back = front ^ 1;
      renderer.setRenderTarget(targets[back]);
      renderer.clear();
      renderer.render(scene, virtualCamera);
      front = back;

      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.clippingPlanes = prevClipping;
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      scene.background = prevBackground;
      scene.fog = prevFog;
      return true;
    },

    /** The pre-mirrored target to SAMPLE this frame (screenUV, not textureMatrix). */
    get mirrorTexture() { return preTargets[preFront].texture; },
    /** Depth of whatever the pre-mirror pass drew, for the road's occlusion
     *  test. Follows the same ping-pong as `mirrorTexture` — always the buffer
     *  written LAST, never the one being written now. */
    get mirrorDepthTexture() { return preTargets[preFront].depthTexture; },

    /**
     * Draw the pre-mirrored geometry from the REAL camera.
     *
     * Independent of `update()` and of the mirror plane: there is no plane in
     * this path. It is skipped only when nothing is on the layer, which is the
     * common case (rails off) and costs one flag test.
     *
     * The camera's layer mask is swapped rather than a second camera built, so
     * the projection, the near/far and anything else the caller has done to it
     * match the main pass by construction — the failure mode of a rebuilt
     * camera is a reflection offset by a fraction of a degree, which reads as
     * the rail sliding as you steer.
     */
    updatePreMirrored(camera) {
      if (!enabled || !preActive) return false;

      const prevTarget = renderer.getRenderTarget();
      const prevBackground = scene.background;
      const prevFog = scene.fog;
      const prevAlpha = renderer.getClearAlpha();
      const prevClear = renderer.getClearColor(new THREE.Color());
      const prevShadowAuto = renderer.shadowMap.autoUpdate;
      const prevMask = camera.layers.mask;

      scene.background = null;
      scene.fog = null;
      renderer.shadowMap.autoUpdate = false;
      renderer.setClearColor(0x000000, 0);
      camera.layers.set(PREMIRROR_LAYER);

      const back = preFront ^ 1;
      renderer.setRenderTarget(preTargets[back]);
      renderer.clear();
      renderer.render(scene, camera);
      preFront = back;

      camera.layers.mask = prevMask;
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClear, prevAlpha);
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      scene.background = prevBackground;
      scene.fog = prevFog;
      return true;
    },

    /** Whether anything is on the pre-mirror layer worth a pass. */
    get preMirrorActive() { return preActive; },
    set preMirrorActive(v) { preActive = !!v; },

    dispose() {
      for (const t of targets) t.dispose();
      for (const t of preTargets) t.dispose();
    },
  };
}

/**
 * Put an object into the reflection.
 *
 * ENABLE, never `set`: the car has to stay on layer 0 as well or it disappears
 * from the main view. Skipping a subtree (the wheels, say) is the cheap LOD
 * lever here — a wheel is a rotor, a caliper, a rim and a tyre, and none of
 * that survives a roughness-0.2 reflection.
 */
export function addToReflection(object, on = true) {
  object.traverse((o) => {
    if (on) o.layers.enable(REFLECT_LAYER);
    else o.layers.disable(REFLECT_LAYER);
  });
}

/**
 * Lights must see the reflection layers or everything in the mirror is black.
 *
 * BOTH layers: three tests `light.layers` against the object's, so a sun left
 * on layer 0 lights the real rail and leaves its mirrored twin unlit — which
 * looks exactly like the pre-mirrored pass having failed to run.
 */
export function lightReflection(light) {
  light.layers.enable(REFLECT_LAYER);
  light.layers.enable(PREMIRROR_LAYER);
}
