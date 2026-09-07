// ============================================================================
// THE LOD VIEW — one frustum, built once per LOD tick, shared by every consumer.
//
// ── WHY PER-INSTANCE, AND WHY IT HAS TO BE OURS ─────────────────────────────
//
// Every mesh in the city carries `frustumCulled = false`, and each of those was
// the right call: a mesh whose instances span 2.4 km has a bounding sphere the
// size of the city, so three's own test would pass it every frame and cost a
// sphere check for the privilege. The consequence was that NOTHING in the city
// was frustum-culled at all. At street level, looking down one avenue, every
// tower behind the camera and every lamp post beside it still went through the
// vertex stage — roughly two thirds of everything in range.
//
// So the cull is done where the information is: the LOD tick already computes
// a distance for every building, every piece of furniture and every roof item.
// Six plane tests per item on a pass that already runs is the whole cost.
//
// ── THE MARGIN, AND THE TURN TRIGGER ────────────────────────────────────────
//
// This runs on a THROTTLED tick (5 Hz, or every 12 m). A cull that is exact at
// tick time is wrong by the next frame if the camera has turned — instances
// missing at the edge of the frame for up to 200 ms, which is precisely the
// kind of pop the eye is tuned to catch. Two defences, both cheap: the test is
// padded by `margin` metres so a fast pan has something to pan INTO, and the
// tick also fires on a heading change (see `lodTurnAngle` in the city), not
// only on translation — and a turn-triggered tick runs every consumer, not
// the staggered one.
//
// ── WHAT IS NEVER CULLED ────────────────────────────────────────────────────
//
// Anything that CASTS a shadow. The shadow pass draws the same InstancedMesh
// with the same `count`, so an off-screen tower dropped here also drops its
// shadow from the view — and a low sun throws shadows a long way into frame
// from things well outside it. Casters are culled by range only. That is the
// L0 tower tier (45 buildings — nothing to save), the parked cars, the tree
// canopies and the moving traffic. When casting is restricted to a short
// radius (the shadow-caster work), those become cullable too.
//
// A camera with no projection matrix (the tests hand in `{ position }`) gets a
// view with the frustum disabled: everything is in view, range culling only.
// ============================================================================
import * as THREE from "three";

const _inv = new THREE.Matrix4();
const _projScreen = new THREE.Matrix4();

export function createLodView() {
  const pos = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, -1);
  const frustum = new THREE.Frustum();
  const planes = frustum.planes;
  let hasFrustum = false;

  const view = {
    pos,
    fwd,
    /** Metres of padding on every test. Set by the city from `lodMargin`. */
    margin: 30,
    /** True when a real camera was supplied and the planes are valid. */
    get hasFrustum() { return hasFrustum; },

    /**
     * Snapshot the camera. The view matrix is inverted from `matrixWorld`
     * here rather than read from `matrixWorldInverse`, because this runs in a
     * pre-render hook — three writes matrixWorldInverse inside render(), so at
     * this point it would be last frame's.
     */
    update(camera) {
      pos.copy(camera.position);
      hasFrustum = !!(camera.projectionMatrix && camera.matrixWorld);
      if (!hasFrustum) return view;
      camera.updateMatrixWorld?.();
      _inv.copy(camera.matrixWorld).invert();
      // Forward = -Z of the camera's world matrix.
      const e = camera.matrixWorld.elements;
      fwd.set(-e[8], -e[9], -e[10]).normalize();
      _projScreen.multiplyMatrices(camera.projectionMatrix, _inv);
      frustum.setFromProjectionMatrix(_projScreen);
      return view;
    },

    /**
     * Is a sphere at (x, y, z) of radius `r` inside the padded view?
     * No allocation: six signed distances against the planes.
     */
    inView(x, y, z, r) {
      if (!hasFrustum) return true;
      const reach = -(r + view.margin);
      for (let i = 0; i < 6; i++) {
        const p = planes[i];
        if (p.normal.x * x + p.normal.y * y + p.normal.z * z + p.constant < reach) return false;
      }
      return true;
    },
  };
  return view;
}
