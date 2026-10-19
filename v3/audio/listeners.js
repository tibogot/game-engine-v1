// THE LISTENER — where the mixer hears from (v3/AUDIO_PLAN.md). The mixer asks it, per sound, how loud,
// how dull and where left/right a point is: spatial(x, y, z, ref, out) → out { gain, cutoff, pan, eff }.
//   gain    1 inside `ref` metres, then 1 / (1 + (eff − ref) / ref)
//   cutoff  the low-pass: air eats the top end, halving every ~1.3 refs past the first (a far crack
//           is a thump)
//   pan     −1 … 1, left / right
//   eff     the effective distance (m), for the game's own rules (far variants, echo sends)
import * as THREE from "three";

function falloff(eff, ref, out) {
  out.gain = 1 / (1 + Math.max(0, eff - ref) / ref);
  out.cutoff = Math.max(650, 20000 * Math.pow(0.5, Math.max(0, eff - ref) / (ref * 1.3)));
  out.eff = eff;
  return out;
}

/**
 * The RTS listener (rtsAudio.js's rule, unchanged): the point the camera LOOKS AT, with the camera's
 * height folded into the distance (zoomed out, the whole fight is a little quieter and duller, as in
 * Company of Heroes); left / right from where the thing is ON SCREEN.
 * @param getView  () => { focus: {x, z}, height } | null
 * @param camera   the view camera (for the screen position)
 */
export function rtsListener({ getView, camera }) {
  const v = new THREE.Vector3();
  return {
    spatial(x, y, z, ref, out = {}) {
      const view = getView();
      const f = view?.focus;
      if (!f) { out.gain = 1; out.cutoff = 20000; out.pan = 0; out.eff = 0; return out; }
      falloff(Math.hypot(x - f.x, z - f.z, (view.height ?? 60) * 0.55), ref, out);
      v.set(x, y, z).project(camera);
      out.pan = THREE.MathUtils.clamp(v.x * 0.75, -0.85, 0.85);
      return out;
    },
  };
}

/**
 * The chase listener (a racer): the ear is the CAMERA (it follows the car), so what passes the
 * camera pans across it; `velocity` (the camera's, m/s) is there for a Doppler shift (measured
 * before it is used, AUDIO_PLAN.md step 6).
 * @param camera  the chase camera
 */
export function chaseListener({ camera }) {
  const right = new THREE.Vector3(), to = new THREE.Vector3();
  return {
    spatial(x, y, z, ref, out = {}) {
      to.set(x, y, z).sub(camera.position);
      const d = to.length();
      falloff(d, ref, out);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      out.pan = d > 1e-3 ? THREE.MathUtils.clamp((to.dot(right) / d) * 0.8, -0.85, 0.85) : 0;
      return out;
    },
  };
}
