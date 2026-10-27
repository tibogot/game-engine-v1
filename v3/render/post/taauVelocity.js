/**
 * TAAU's switch and the CAMERA-ONLY motion vector for materials at WebGPU's varying limit.
 *
 * TAAU (postFxPipeline.js, three r186 TAAUNode) needs every pixel's motion. three's `velocity` node
 * computes it in the VERTEX stage and passes two clip positions down — two more varyings. The plants
 * (foliageSystem createFoliageMaterial: ground plants, tall plants, placed palms / broom / agave) were
 * already at 15-16 of WebGPU's 16, went over, and their pipelines failed: every plant vanished (alg,
 * 2026-10-27). A plant barely moves (it sways), so its motion is the CAMERA's: computed here in the
 * FRAGMENT stage from the view position the material already carries (v_positionView, its lighting's):
 *   world = cameraWorld · view position
 *   now   = the unjittered projection · view position     (TAAU hands velocity that projection)
 *   then  = last frame's projection · last frame's view · world
 *   motion = now.xy / now.w − then.xy / then.w            (three's VelocityNode convention)
 * No varying added. The sway is not in it: a swaying leaf leans on TAAU's history clamp.
 */
import * as THREE from "three";
import { Fn, cameraWorldMatrix, positionView, uniform, vec4, velocity } from "three/tsl";
import { BloomMRTNode } from "../bloomMRT.js";

const _q = typeof location !== "undefined" ? new URLSearchParams(location.search) : null;
/** ?taau=1 — TAAU on (no MSAA: main.js). */
export const TAAU_ON = _q?.get("taau") === "1";
/** ?taauScale=0.7 — the scene's share of the screen per axis (0.5-1). */
export const TAAU_SCALE = Math.min(1, Math.max(0.5, Number(_q?.get("taauScale")) || 0.7));

// The projection WITHOUT TAAU's sub-pixel jitter (TAAU gives it to `velocity`); the camera's own before.
const _unjittered = /*@__PURE__*/ uniform(new THREE.Matrix4()).onRenderUpdate(({ camera }, self) => {
  self.value.copy(velocity.projectionMatrix ?? camera.projectionMatrix);
});

/** This fragment's screen motion since last frame, from the camera's motion alone. */
export const cameraOnlyVelocity = /*@__PURE__*/ Fn(() => {
  const view = vec4(positionView, 1);
  const world = cameraWorldMatrix.mul(view);
  const now = _unjittered.mul(view);
  const then = velocity.previousProjectionMatrix.mul(velocity.previousCameraViewMatrix).mul(world);
  return now.xy.div(now.w).sub(then.xy.div(then.w));
})();

/**
 * With TAAU on, `material` writes the camera-only motion instead of three's (no extra varyings).
 * BloomMRTNode: on a render target without a velocity attachment (bakes, thumbnails) it falls back to
 * the plain output instead of an empty output struct.
 */
export function applyCameraOnlyVelocity(material) {
  if (!TAAU_ON || !THREE.MRTNode) return material;
  const own = material.mrtNode?.outputNodes ?? {};
  material.mrtNode = new BloomMRTNode({ ...own, velocity: cameraOnlyVelocity });
  material.userData.v3CameraOnlyVelocity = true;
  return material;
}

/*
 * …and no previous-frame data for it. r186 gives EVERY instanced mesh last frame's instance matrices
 * (one more vertex buffer) as soon as the scene's MRT has a velocity target (NodeBuilder
 * .needsPreviousData) — whatever its material writes. The army's kit meshes were at 8 buffers, the
 * limit: "Vertex buffer count (9) exceeds the maximum" and every vehicle vanished. A camera-only
 * material reads no previous data, so it is exempt. TAAU only.
 */
const NB = THREE.NodeBuilder?.prototype;
if (TAAU_ON && NB && !NB._v3CameraOnlyVelocity) {
  NB._v3CameraOnlyVelocity = true;
  const needsPreviousData = NB.needsPreviousData;
  NB.needsPreviousData = function () {
    if (this.material?.userData?.v3CameraOnlyVelocity === true) return false;
    return needsPreviousData.call(this);
  };
}
