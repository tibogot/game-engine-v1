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
  const makeTarget = (i) => {
    const t = new THREE.RenderTarget(width, height, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 0,
    });
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

  const virtualCamera = new THREE.PerspectiveCamera();
  virtualCamera.layers.set(REFLECT_LAYER);

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

    setSize(w, h) {
      const W = Math.max(2, w | 0);
      const H = Math.max(2, h | 0);
      for (const t of targets) t.setSize(W, H);
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

      scene.background = null;
      scene.fog = null;
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
      renderer.shadowMap.autoUpdate = prevShadowAuto;
      scene.background = prevBackground;
      scene.fog = prevFog;
      return true;
    },

    dispose() {
      for (const t of targets) t.dispose();
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

/** Lights must see the reflection layer or everything in the mirror is black. */
export function lightReflection(light) {
  light.layers.enable(REFLECT_LAYER);
}
