import * as THREE from "three";

/**
 * The launch-arc solver behind the build-mode jump preview.
 *
 * Kept in its own module, with nothing but plain THREE in it, because three
 * callers need the MATH and only one of them can afford the rendering stack:
 * gapPreview.js draws it (TSL node materials, bloom MRT), modularRoadBuilder.js
 * sizes generated demo jumps with it, and tools/gapPreviewAccuracyTest.mjs
 * measures it headlessly under node, where `three` is not aliased to
 * `three/webgpu` and LineBasicNodeMaterial does not exist.
 *
 * Connector convention (modularRoadKit.socketMatrix): the matrix's Z column is
 * −travel, so the launch direction is the NEGATED Z axis. For a jump ramp the
 * exit tangent points up-and-forward, so the launch already carries the ramp's
 * pitch.
 *
 * ── WHAT COUNTS AS "LANDING" ────────────────────────────────────────────────
 * Two tests, whichever the arc reaches first.
 *
 *   1. THE AUTHOR'S PLANE — the first DESCENDING crossing of
 *      `exit.y − landingDrop`. This is the intent "I am going to put a deck this
 *      far below the lip", and on a sky track it is almost always what fires.
 *
 *   2. THE WORLD — the first solid thing the arc actually goes through, via the
 *      caller's `surfaceHit` (roadGame casts the road-deck BVH, then falls back
 *      to the terrain heightfield).
 *
 * TEST 2 EXISTS BECAUSE TEST 1 ALONE SILENTLY GIVES UP ON A LEVEL LAUNCH, and a
 * level open end is the single most common thing to be looking at in build mode.
 * `prev.y > targetY` cannot be true on the first step when the launch is level
 * and landingDrop is 0 — prev.y IS targetY — so the crossing was never detected,
 * the solve ran to its 500 m floor, and the aid drew a red line 459 m into the
 * terrain with no marker at the end of it. Measured on an empty track: launch
 * pitch 0.0°, 314 arc points, last point at y = −459 with the terrain at y = 0.
 *
 * ── WHY THIS IS NOT A CLOSED-FORM PARABOLA ──────────────────────────────────
 * It used to be (x = x0 + v0·t + ½g·t²), and that is wrong by a knowable amount:
 * AERO.drag applies in the air exactly as it does on the ground, so the car
 * always lands SHORT of a vacuum arc. Measured by
 * tools/gapPreviewAccuracyTest.mjs, flying the real Vehicle from the exact
 * launch state the preview assumes, so drag is the ONLY difference:
 *
 *     ramp / speed     vacuum arc    real car    vacuum err    this solver
 *      12° / 40 m/s      66.0 m       65.2 m       −1.2 %         +0.3 %
 *      20° / 50 m/s     163.4 m      158.0 m       −3.3 %         +0.1 %
 *      28° / 50 m/s     210.9 m      201.6 m       −4.4 %         +0.1 %
 *
 * A 9 m overshoot on a 200 m jump is the difference between landing on the ramp
 * you placed and driving off the end of it. Integrating the vehicle's own
 * −drag·|v|·v takes that under 1 % everywhere.
 *
 * (Interpolating the ground crossing rather than snapping to a sample was worth
 * another ~0.5 m on its own, and it stops the marker stepping as you nudge the
 * ramp.)
 *
 * ── WHAT IS STILL NOT MODELLED, and cannot usefully be ──────────────────────
 * The launch STATE. The car is a sprung 4-wheeled body, not a point at the
 * connector: driven up the real kit ramp it leaves the deck ~2 m PAST the lip
 * (it pivots over it) at 0.5–4° FLATTER than the exit tangent (the suspension is
 * still rebounding). Those two push opposite ways and partly cancel, leaving the
 * marker about 4 % long on average with ±3–5 % scatter around that.
 *
 * The scatter is not something a connector matrix can predict — the same 28°
 * ramp leaves at −0.7°, −4.2°, −1.8° and −0.8° off tangent at 25/30/40/50 m/s,
 * depending purely on where the suspension is in its cycle when the lip arrives.
 * Nor is a flat 4 % fudge honest: the bias is 2.6 % on the 28° ramp and 6.3 % on
 * the 8° one. So the marker is the CENTRE OF A LANDING ZONE, not a survey point.
 *
 * The single biggest thing an author can do about it is set refSpeed to the
 * speed they actually hit the ramp at — range goes as v², so the default 40
 * against a real 48 m/s approach is 40 % of range on its own.
 */
const _exit = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _segFrom = new THREE.Vector3();

/** Integration step. Matches the vehicle's FIXED_DT so the two agree. */
export const SOLVE_DT = 1 / 120;
/** Emit one line vertex every N steps — 1/30 s of arc per segment. */
const SAMPLE_EVERY = 4;
/** Absolute give-up time (s) and drop (m) for an arc that never comes back. */
const MAX_T = 12;
const MAX_DROP = 500;
/**
 * Metres of arc that are exempt from the surface test.
 *
 * The launch point sits exactly ON the deck it is leaving, so without this a
 * track that curls back over itself — or any grazing first segment — can report
 * a "landing" at the lip. There is nothing useful to mark inside the first few
 * metres anyway.
 */
const SURFACE_MIN_DIST = 3;

/**
 * Integrate a launch arc and return where it comes back down.
 *
 * @param {THREE.Matrix4} connector  open-end connector (Z col = −travel)
 * @param {number} speed             launch speed (m/s)
 * @param {object} [opts]
 * @param {number} [opts.gravity]    m/s²
 * @param {number} [opts.dragK]      quadratic drag per unit mass: AERO.drag / CHASSIS.mass.
 *                                   0 gives the old vacuum parabola.
 * @param {number} [opts.landingDrop] metres BELOW launch height to land (0 = level)
 * @param {(from:THREE.Vector3,to:THREE.Vector3)=>({x,y,z}|null)} [opts.surfaceHit]
 *        first solid surface struck by the segment from→to, or null. See the
 *        LANDING ON THE WORLD note above. Called once per SAMPLE_EVERY steps
 *        (~1.3 m of arc at 40 m/s), so it may be a real raycast.
 * @param {(x:number,y:number,z:number)=>boolean} [opts.sample]
 *        called at the launch point and every SAMPLE_EVERY steps after; return
 *        false to stop sampling. The solve continues either way, so a caller
 *        that runs out of vertices still gets the correct landing.
 * @returns {{pos:THREE.Vector3, vel:THREE.Vector3, dist:number, time:number,
 *            onSurface:boolean} | null}
 */
export function solveGapArc(connector, speed, opts = {}) {
  const {
    gravity = 9.81, dragK = 0, landingDrop = 0, sample = null, surfaceHit = null,
  } = opts;
  const e = connector.elements;
  _exit.setFromMatrixPosition(connector);
  _dir.set(-e[8], -e[9], -e[10]).normalize(); // launch = −Z column
  _v.copy(_dir).multiplyScalar(speed);
  _p.copy(_exit);

  const targetY = _exit.y - landingDrop;
  const minY = _exit.y - MAX_DROP;
  let sampling = sample ? sample(_p.x, _p.y, _p.z) !== false : false;
  _segFrom.copy(_p);

  for (let i = 1; i * SOLVE_DT < MAX_T; i++) {
    _prev.copy(_p);
    // Semi-implicit Euler with the vehicle's own force model: gravity plus
    // −drag·|v|·v (Vehicle._applyAero), both summed before the position update.
    const sp = _v.length();
    const k = dragK * sp * SOLVE_DT;
    _v.x -= _v.x * k;
    _v.y -= _v.y * k + gravity * SOLVE_DT;
    _v.z -= _v.z * k;
    _p.addScaledVector(_v, SOLVE_DT);

    // Landing = first DESCENDING crossing of the target height, interpolated so
    // the marker does not step between ticks as the ramp is nudged.
    if (_prev.y > targetY && _p.y <= targetY) {
      const a = (_prev.y - targetY) / (_prev.y - _p.y);
      const lx = _prev.x + (_p.x - _prev.x) * a;
      const lz = _prev.z + (_p.z - _prev.z) * a;
      if (sampling) sample(lx, targetY, lz);
      return {
        pos: new THREE.Vector3(lx, targetY, lz),
        vel: _v.clone(),
        dist: Math.hypot(lx - _exit.x, lz - _exit.z),
        time: (i - 1 + a) * SOLVE_DT,
        onSurface: false,
      };
    }
    if (i % SAMPLE_EVERY === 0) {
      // Did this segment of arc go through anything solid? Checked per SAMPLE
      // rather than per step so `surfaceHit` can afford to be a raycast.
      if (surfaceHit && _segFrom.distanceTo(_exit) > SURFACE_MIN_DIST) {
        const hit = surfaceHit(_segFrom, _p);
        if (hit) {
          if (sampling) sample(hit.x, hit.y, hit.z);
          return {
            pos: new THREE.Vector3(hit.x, hit.y, hit.z),
            vel: _v.clone(),
            dist: Math.hypot(hit.x - _exit.x, hit.z - _exit.z),
            time: i * SOLVE_DT,
            onSurface: true,
          };
        }
      }
      _segFrom.copy(_p);
      if (sampling) sampling = sample(_p.x, _p.y, _p.z) !== false;
    }
    if (_p.y < minY) break;
  }
  return null;
}
