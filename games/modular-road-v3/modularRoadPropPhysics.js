// ============================================================================
// PROP PHYSICS — knock-over cones and push-through gates.
//
// NO SECOND PHYSICS ENGINE. The vehicle already runs a general rigid-body
// integrator (`RigidBody` in v3/play/modularRoadVehicle.js: mass, a real inertia
// tensor, addForceAtPoint, semi-implicit Euler at the same 120 Hz fixed step).
// Adding Rapier would mean a second world to keep in sync — and since the car is
// NOT a Rapier body, the hardest part (car↔prop contact) would still be
// hand-written. So it is hand-written against the engine that is already here.
//
// TWO TIERS, because they are different problems:
//
//  • CONE — a free rigid body. This is the well-behaved 80% of rigid-body
//    dynamics: take an impulse, tumble, settle, sleep. What general engines are
//    HARD at — stacking, resting contact stability, constraint graphs — none of
//    it is needed. (Which is also why a pile of cones resting on each other is
//    explicitly not supported.)
//
//  • GATE — ONE degree of freedom. Simulated directly as hinge angle + angular
//    velocity + spring + damping, NOT as a rigid body with a hinge constraint.
//    Ten lines, cannot explode, no constraint drift, and the swing feel is a
//    parameter instead of an emergent property. A general solver would be more
//    code and LESS control.
//
// ONE-WAY COUPLING. The car shoves props; props never perturb the car. That is
// what racing games do with cones, it keeps the tuned vehicle physics untouched,
// and it removes the only genuinely risky feedback path. A cone that cost you
// lap time would feel wrong anyway.
//
// SLEEPING is mandatory, not an optimisation: without it every settled cone
// integrates forever AND jitters in place. A settled prop costs one comparison.
// ============================================================================
import * as THREE from "three";
import { RigidBody, CHASSIS_HULL } from "../../v3/play/modularRoadVehicle.js";

export const PROP_PHYSICS = {
  enabled: true,
  gravity: 22,           // punchier than 9.81 — arcade props should settle fast
  /** Below this speed AND spin, for `sleepAfter` seconds, a body sleeps. */
  sleepSpeed: 0.25,
  sleepSpin: 0.5,
  sleepAfter: 0.6,
  /** Ground bounce / slide. */
  restitution: 0.28,
  friction: 3.5,
  angularDamping: 1.4,
  /**
   * How hard the car throws a prop, as a fraction of car speed. Under 1 on
   * purpose: at 1.35 a cone left a 25 m/s car doing 33.8 m/s — outrunning the
   * car that hit it, which reads as a glitch rather than a hit.
   */
  hitImpulse: 0.85,
  /** Loft as a fraction of the throw. Enough to leave the ground, not a punt. */
  hitLoft: 0.22,
  /** Tumble rate per m/s of throw, and a hard cap. Uncapped this hit 48 rad/s
   *  (7.7 rev/s) — a blur, not a cartwheel. */
  hitSpin: 0.30,
  maxSpin: 16,
  /** Speed floor (m/s) before a touch counts as a hit at all. */
  minHitSpeed: 1.5,
};

/**
 * Linear scale of the traffic cone, against the ~0.93 m motorway cone the
 * geometry is authored at. 3 puts it at ~2.8 m — an obstacle you aim at rather
 * than street furniture you happen to clip, and big enough to actually see the
 * collision happen from the debug cam.
 *
 * EXPORTED AND SHARED because the cone's size lives in two files: the LOOK in
 * modularRoadProps.js and the collision proxy here. Both read this, so they
 * cannot drift — which they already did once (the hardcoded copy is exactly how
 * the cone ended up half-buried; see the note in the cone's make()).
 */
export const CONE_SCALE = 3;
/**
 * Panel reach of the swing gate, from its hinge (m).
 *
 * Same shared-constant reasoning as CONE_SCALE: the panel MESH is built in
 * modularRoadProps.js and the hinge simulation is here, and a gate whose visual
 * panel is a different length from its physical one swings visibly wrong.
 */
export const GATE_WIDTH = 4.4;
/**
 * Panel height, and how far its BOTTOM sits above the hinge root (m).
 *
 * Shared for the same reason as GATE_WIDTH, and it was NOT before: the mesh was
 * 1.5 tall spanning y 0.15..1.65 while the profile said `height: 1.6` measured
 * about the root, i.e. the "physical" panel ran −0.8..+0.8 and was a metre out
 * of place vertically. Invisible in play (the car's y always fell inside both)
 * but it is what the collider wireframe was drawing, which is how it showed up.
 */
export const GATE_HEIGHT = 1.5;
export const GATE_BASE_Y = 0.15;
/** Hinge post radius and height (m). The post is a STATIC solid, not part of the
 *  hinge sim — see the gate entry in modularRoadProps.js. */
export const GATE_POST_RADIUS = 0.11;
export const GATE_POST_HEIGHT = 1.9;

/** Per-type physics profile. `kind` selects the simulation, not the look. */
export const PHYSICS_PROP_TYPES = {
  cone: {
    kind: "body",
    /**
     * Mass scales with the SQUARE of size, not the cube.
     *
     * Cubic (×27 → 59 kg) is the physically honest answer for a solid object 3×
     * bigger, and it is the wrong one here: the whole point of a cone is that
     * hitting it is spectacular and free, and at 59 kg against a 1400 kg car it
     * stops flying and starts feeling like a bollard. A real cone is also mostly
     * hollow shell plus a weighted base, so its mass grows nearer area than
     * volume anyway — ×9 → 19.8 kg is both the better-playing and the more
     * defensible number. Raise it if you want them to shrug the car off.
     */
    mass: 2.2 * CONE_SCALE * CONE_SCALE,
    /** Collision proxy: a sphere at the centre of mass. A cone is close enough
     *  to a sphere for being punted by a car, and it never gets stuck on edges
     *  the way a hull would. */
    radius: 0.42 * CONE_SCALE,
    size: {
      width: 0.54 * CONE_SCALE,
      height: 0.9 * CONE_SCALE,
      length: 0.54 * CONE_SCALE,
    },
    comY: -0.27 * CONE_SCALE, // low CoM so it rights itself and settles base-down
  },
  gate: {
    kind: "hinge",
    /** Panel reach from the hinge (m), its height, and its bottom edge above the
     *  hinge root. All three are the MESH's numbers — see GATE_HEIGHT. */
    width: GATE_WIDTH,
    height: GATE_HEIGHT,
    baseY: GATE_BASE_Y,
    /** Radians the panel may swing either way. */
    maxAngle: 1.5,
    /** Spring back to closed (1/s²) and its damping (1/s). Together these ARE
     *  the feel: stiff+damped = a shop door, soft+loose = a saloon door. */
    spring: 14,
    damping: 2.2,
    /** Angular kick per m/s of car speed through the panel. Big enough that a
     *  gate visibly flies open rather than easing aside. */
    kick: 2.6,
    /**
     * How hard a CLOSED gate resists (1/s of exponential speed scrub on the
     * through-panel component only). This is the half that was missing: the
     * panel swung but the car sailed through untouched, so it read as "the gate
     * does nothing". Scaled by how closed the gate still is, so you shove
     * through with a knock rather than bouncing off a wall.
     *
     * RECALIBRATED when the contact test started using the car's real footprint
     * (see _carFootprint). The gate now begins swinging when the BONNET reaches
     * it rather than when the car's middle does — 2.4 m earlier — so it is
     * already part-open by the time the car arrives and `closedness` has faded.
     * At the old 0.9 that dropped the cost of a 20 m/s pass from 1.3 m/s to
     * 0.89, i.e. the geometry fix quietly made gates softer. Re-measured across
     * the range (the old figures in this comment predate two contact fixes and
     * no longer describe anything):
     *
     *     resistance   4 m/s exit   20 m/s cost   45 m/s kept
     *        0.9          3.43         0.89          98%
     *        1.4          3.20         1.38          96%     <- here
     *        2.4          2.89         2.37          94%
     *        4.0          2.68         3.92          90%
     *
     * 1.4 restores the tuned feel exactly: same cost as before, and a crawling
     * car still clears `minPushSpeed`.
     *
     * The ONLY place a prop touches the car — cones stay strictly one-way. A
     * gate that cost you nothing would not be an obstacle.
     */
    resistance: 1.4,
    /**
     * Floor on the through-panel speed the resistance may scrub to (m/s).
     *
     * Without it the penalty compounds with TIME IN CONTACT, so a SLOW car is
     * punished hardest — measured at resistance 1.8: 45 m/s kept 88% of its
     * speed while 6 m/s kept 14%, i.e. crawling into a gate nearly stopped you
     * dead. Physically defensible (a fixed amount of work is a bigger fraction
     * of a small kinetic energy) and horrible to play. The floor guarantees you
     * can always nose a gate open.
     */
    minPushSpeed: 2.5,
  },
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _local = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _carVel = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

export class PropPhysics {
  /**
   * @param {object} o
   * @param {import("./modularRoadProps.js").PropManager} o.props
   * @param {() => object|null} o.getGroundBvh  deck BVH, for props to rest on
   */
  constructor({ props, getGroundBvh }) {
    this.props = props;
    this.getGroundBvh = getGroundBvh;
    /** @type {Array<object>} */
    this.sims = [];
    this._enabled = true;
    this._lastPropCount = -1;
  }

  /**
   * Rebuild the sim list from the CURRENT prop instances.
   *
   * Must be called after add / delete / track import. The authored transform is
   * captured here and is what reset() restores — so "where the designer put it"
   * survives any amount of being knocked around.
   */
  sync() {
    this.sims = [];
    this._lastPropCount = this.props.instances?.length ?? 0;
    for (const inst of this.props.instances ?? []) {
      const profile = PHYSICS_PROP_TYPES[inst.id];
      if (!profile) continue;
      const home = {
        pos: inst.root.position.clone(),
        quat: inst.root.quaternion.clone(),
      };
      if (profile.kind === "body") {
        const body = new RigidBody({
          mass: profile.mass,
          size: { ...profile.size, comY: profile.comY ?? 0 },
        });
        body.pos.copy(home.pos);
        body.quat.copy(home.quat);
        this.sims.push({ inst, profile, home, body, asleep: true, stillFor: 0 });
      } else {
        this.sims.push({ inst, profile, home, angle: 0, angVel: 0, pushSide: 0 });
      }
    }
    return this.sims.length;
  }

  /** Put every prop back where it was authored. Called on lap reset / respawn. */
  reset() {
    for (const s of this.sims) {
      s.inst.root.position.copy(s.home.pos);
      s.inst.root.quaternion.copy(s.home.quat);
      if (s.body) {
        s.body.pos.copy(s.home.pos);
        s.body.quat.copy(s.home.quat);
        s.body.vel.set(0, 0, 0);
        s.body.angVel.set(0, 0, 0);
        s.asleep = true;
        s.stillFor = 0;
      } else {
        s.angle = 0;
        s.angVel = 0;
        s.pushSide = 0;
      }
    }
  }

  setEnabled(on) { this._enabled = !!on; }

  /** Awake body count — for the stats readout. */
  get awakeCount() {
    let n = 0;
    for (const s of this.sims) if (s.body && !s.asleep) n++;
    return n;
  }

  /**
   * @param {number} dt fixed step
   * @param {import("../../v3/play/modularRoadVehicle.js").Vehicle} vehicle
   */
  tick(dt, vehicle) {
    if (!this._enabled || !PROP_PHYSICS.enabled) return;
    // SELF-HEAL. PropManager owns its own Delete key (modularRoadProps.js
    // handles "Delete"/"Backspace" internally), so there is no single choke
    // point a caller can hook to know the set changed. An O(1) length check each
    // tick means a prop deleted by any path cannot leave a ghost body behind
    // still shoving the car's cone around.
    //
    // It cannot catch an add and a delete in the SAME frame — the count is
    // unchanged — but that self-corrects on the next change, and explicit
    // sync() calls cover the paths the game does control.
    const n = this.props.instances?.length ?? 0;
    if (n !== this._lastPropCount) {
      this._lastPropCount = n;
      this.sync();
    }
    if (!this.sims.length) return;
    const car = vehicle?.enabled ? vehicle.body : null;
    for (const s of this.sims) {
      if (s.profile.kind === "hinge") this._tickHinge(s, dt, car, vehicle);
      else this._tickBody(s, dt, car, vehicle);
    }
  }

  // ── FREE BODY (cones) ───────────────────────────────────────────────────────

  _tickBody(s, dt, car, vehicle) {
    const P = PROP_PHYSICS;
    const hit = car ? this._carImpulse(s, car, vehicle) : false;
    if (s.asleep && !hit) return;   // a settled prop costs exactly this
    s.asleep = false;

    const b = s.body;
    b.vel.y -= P.gravity * dt;
    b.pos.addScaledVector(b.vel, dt);

    // Spin: integrate the quaternion from angular velocity, then bleed it off.
    const w = b.angVel;
    if (w.lengthSq() > 1e-9) {
      _q.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(b.quat);
      b.quat.set(b.quat.x + _q.x, b.quat.y + _q.y, b.quat.z + _q.z, b.quat.w + _q.w).normalize();
      w.multiplyScalar(Math.max(0, 1 - P.angularDamping * dt));
    }

    this._groundContact(s, dt);

    // SLEEP — needs BOTH linear and angular stillness held for a while. Either
    // alone false-triggers: a cone spinning on the spot has no velocity, and one
    // sliding flat has no spin.
    if (b.vel.lengthSq() < P.sleepSpeed * P.sleepSpeed && w.lengthSq() < P.sleepSpin * P.sleepSpin) {
      s.stillFor += dt;
      if (s.stillFor >= P.sleepAfter) {
        s.asleep = true;
        b.vel.set(0, 0, 0);
        w.set(0, 0, 0);
      }
    } else {
      s.stillFor = 0;
    }

    s.inst.root.position.copy(b.pos);
    s.inst.root.quaternion.copy(b.quat);
  }

  /** Rest on whatever the car drives on, using the same BVH. */
  _groundContact(s, dt) {
    const bvh = this.getGroundBvh?.();
    const b = s.body;
    const r = s.profile.radius;
    let floorY = null;
    if (bvh?.baked) {
      // Cast from above the body so a prop that has sunk still finds the surface.
      const hit = bvh.raycastFirst(
        { x: b.pos.x, y: b.pos.y + 1.2, z: b.pos.z }, _down, 4,
      );
      if (hit) floorY = hit.point.y;
    }
    if (floorY === null) return;      // off the track: let it fall away

    const pen = floorY + r - b.pos.y;
    if (pen <= 0) return;
    b.pos.y = floorY + r;
    if (b.vel.y < 0) {
      b.vel.y = -b.vel.y * PROP_PHYSICS.restitution;
      // A bounce should also scrub some spin, or cones skitter forever.
      b.angVel.multiplyScalar(0.7);
    }
    // Tangential friction — this is what actually brings it to rest.
    const k = Math.exp(-PROP_PHYSICS.friction * dt);
    b.vel.x *= k;
    b.vel.z *= k;
  }

  /**
   * Car → prop impulse. ONE-WAY: the car is never touched.
   *
   * Sphere (prop) vs oriented box (chassis). The contact point is offset from
   * the prop's centre, so `addForceAtPoint`-style torque falls out naturally and
   * the cone cartwheels rather than sliding away flat.
   */
  _carImpulse(s, car, vehicle) {
    const P = PROP_PHYSICS;
    const b = s.body;
    const r = s.profile.radius;

    // Prop centre in chassis-local space.
    _qi.copy(car.quat).invert();
    _local.copy(b.pos).sub(car.pos).applyQuaternion(_qi);
    // THE HULL, not the core box: this is "what shape does the car hit things
    // with", which is exactly the question CHASSIS_HULL answers. The core box
    // stops 0.6 m short of the nose, so cones were being punted by an invisible
    // bumper set back inside the bodywork.
    const hw = CHASSIS_HULL.width * 0.5;
    const hh = CHASSIS_HULL.height * 0.5;
    const hl = CHASSIS_HULL.length * 0.5;
    _closest.set(
      Math.max(-hw, Math.min(hw, _local.x)),
      CHASSIS_HULL.offsetY + Math.max(-hh, Math.min(hh, _local.y - CHASSIS_HULL.offsetY)),
      CHASSIS_HULL.offsetZ + Math.max(-hl, Math.min(hl, _local.z - CHASSIS_HULL.offsetZ)),
    );
    const d2 = _closest.distanceToSquared(_local);
    if (d2 > r * r) return false;

    // PUSH ALONG THE CAR'S TRAVEL, NOT THE SHORTEST SEPARATION.
    //
    // Shortest-separation is the right normal for resolving penetration and the
    // WRONG one for throwing something. A traffic cone is short, so its centre
    // sits just below the chassis box: the nearest point on the box is on its
    // FLOOR and that normal points straight DOWN. Dotted against a car driving
    // forward it gives a closing speed of zero — measured, the impulse never
    // fired once. A bumper does not push a cone downward, it sweeps it along.
    _v.copy(car.vel);
    _v.y = 0;
    const speed = _v.length();
    if (speed < P.minHitSpeed) return false;
    _n.copy(_v).multiplyScalar(1 / speed);

    // Where along the bumper it was struck decides how far it is thrown SIDEWAYS
    // — clip one with the corner and it should spin off to that side, not fly
    // straight down the road like one hit dead centre.
    _v2.set(1, 0, 0).applyQuaternion(car.quat);
    const lateral = Math.max(-1, Math.min(1, _local.x / hw));
    _n.addScaledVector(_v2, lateral * 0.7).normalize();

    const closing = speed;

    const j = closing * P.hitImpulse;
    b.vel.addScaledVector(_n, j);
    b.vel.y += Math.abs(j) * P.hitLoft; // a little loft — flat-sliding cones look dead

    // TUMBLE. A body struck near its BASE by something moving horizontally
    // rotates about the axis perpendicular to the push and to up — that is what
    // makes a cone cartwheel end-over-end instead of skating away upright, and
    // it is most of what sells the effect.
    _v2.crossVectors(_up, _n).normalize().multiplyScalar(j * P.hitSpin);
    b.angVel.add(_v2);
    // A touch of asymmetry so a row of cones does not tumble in lockstep.
    b.angVel.x += (Math.random() - 0.5) * j * 0.12;
    b.angVel.z += (Math.random() - 0.5) * j * 0.12;
    const spin = b.angVel.length();
    if (spin > P.maxSpin) b.angVel.multiplyScalar(P.maxSpin / spin);

    s.asleep = false;
    s.stillFor = 0;
    return true;
  }

  // ── HINGE (gates) ───────────────────────────────────────────────────────────

  /**
   * The car's plan-view footprint as seen from the hinge, in the hinge's HOME
   * frame. `_v` must already hold the car centre in that frame.
   *
   * Returns the angular WEDGE the bodywork occupies — because that is the actual
   * question a swing gate asks: "through what range of angles is the panel
   * inside the car?" A radius-and-bearing pair cannot express it for a shape
   * three times longer than it is wide.
   *
   * @returns {{lo:number, hi:number, rel:number, dist:number, full:boolean}}
   *   `lo`/`hi` bracket the wedge and `rel` is the panel's current angle, all
   *   relative to the same arbitrary base so no caller has to unwrap anything.
   *   `dist` is how close the bodywork gets to the hinge; `full` means the hinge
   *   is INSIDE the car, where every angle is blocked and there is no wedge.
   */
  _carFootprint(car, angle) {
    const H = CHASSIS_HULL;
    // The car's plan axes in the home frame. Projected, then re-normalised: a
    // pitched or rolled car casts a SHORTER shadow, and using the full extents
    // on unit axes keeps the footprint conservative rather than letting a car
    // mid-barrel-roll slip through a gate it is visibly hitting.
    _right.set(1, 0, 0).applyQuaternion(car.quat).applyQuaternion(_qi);
    _fwd.set(0, 0, 1).applyQuaternion(car.quat).applyQuaternion(_qi);
    let rx = _right.x, rz = _right.z, fx = _fwd.x, fz = _fwd.z;
    const rl = Math.hypot(rx, rz), fl = Math.hypot(fx, fz);
    if (rl < 1e-3 || fl < 1e-3) {
      // Car exactly nose-down or on its side — the footprint degenerates to a
      // line and the axes are noise. Fall back to a circle, which is what this
      // whole function replaced but is still the right answer for a shape with
      // no meaningful plan orientation.
      const r = Math.hypot(_v.x, _v.z);
      const half = Math.atan2(H.width * 0.5 + 0.35, Math.max(0.4, r));
      return { lo: -half, hi: half, rel: 0, dist: Math.max(0, r - H.width * 0.5), full: r < 0.4 };
    }
    rx /= rl; rz /= rl; fx /= fl; fz /= fl;

    const hw = H.width * 0.5, hl = H.length * 0.5;
    // Hull centre, not car.pos — the hull is offset along the car's own forward.
    const cx = _v.x + fx * H.offsetZ, cz = _v.z + fz * H.offsetZ;

    // Hinge in the CAR's plan frame, so "how close does the bodywork get" and
    // "is the hinge inside the car" are the same clamp.
    const u = -cx * rx - cz * rz;
    const w = -cx * fx - cz * fz;
    const cu = Math.max(-hw, Math.min(hw, u));
    const cw = Math.max(-hl, Math.min(hl, w));
    const dist = Math.hypot(u - cu, w - cw);
    if (dist < 1e-4) return { lo: 0, hi: 0, rel: 0, dist: 0, full: true };

    // Corner bearings, unwrapped against the FIRST corner rather than against
    // the panel — with the hinge outside the rectangle the wedge is always under
    // π wide, so this is unambiguous wherever the car happens to be.
    let lo = 0, hi = 0, base = 0;
    for (let i = 0; i < 4; i++) {
      const sx = i & 1 ? 1 : -1, sz = i & 2 ? 1 : -1;
      const px = cx + rx * hw * sx + fx * hl * sz;
      const pz = cz + rz * hw * sx + fz * hl * sz;
      const a = Math.atan2(-pz, px);
      if (i === 0) { base = a; continue; }
      let d = a - base;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    let rel = angle - base;
    if (rel > Math.PI) rel -= 2 * Math.PI;
    else if (rel < -Math.PI) rel += 2 * Math.PI;
    return { lo, hi, rel, dist, full: false };
  }

  _tickHinge(s, dt, car, vehicle) {
    const p = s.profile;
    _q.setFromAxisAngle(_up, s.angle);

    // Panel frame at the CURRENT angle: `alongDir` runs hinge → free edge,
    // `_n` is the face normal.
    _v2.set(1, 0, 0).applyQuaternion(s.home.quat).applyQuaternion(_q); // along
    _n.set(0, 0, 1).applyQuaternion(s.home.quat).applyQuaternion(_q);  // normal

    s.blocking = 0;
    let held = false;
    if (car) {
      // Work in the hinge's HOME frame: at angle 0 the panel lies along +X and
      // its normal is +Z. A POSITIVE rotation about +Y sweeps the panel toward
      // −Z, which is the sign convention everything below depends on.
      _qi.copy(s.home.quat).invert();
      _v.copy(car.pos).sub(s.home.pos).applyQuaternion(_qi);

      // Vertical band the panel actually occupies, plus a car's worth of slack
      // below (car.pos is the chassis origin, ~0.5 m up) and a little above. A
      // car cleanly OVER the gate has to miss it — this used to be measured
      // symmetrically about the root, so the band sat half a metre low.
      const overPanel = _v.y > -1.0 && _v.y < p.baseY + p.height + 0.4;

      // THE CAR IS A RECTANGLE, NOT A DOT WITH A RADIUS.
      //
      // This was a circle of `hull.width/2 + 0.35` centred on `car.pos` — and
      // `car.pos` is the chassis ORIGIN, i.e. the middle of a 4.85 m car. The
      // bonnet sticks out 2.5 m in front of the only point the gate was looking
      // at, so the panel could not react until the car's MIDDLE had nearly
      // arrived. Measured in tools/gateFootprintRepro.mjs: the nose was 1.2–1.8 m
      // PAST the panel plane before the gate moved at all, at every speed and
      // every crossing point. That is precisely the "I drive through it" feel,
      // and no amount of tuning spring/kick/resistance could have fixed it —
      // the contact test was looking in the wrong place.
      //
      // So use the hull's actual plan-view footprint. The nose now reaches the
      // panel when the nose reaches the panel.
      const fp = this._carFootprint(car, s.angle);
      const atPanel = fp.dist < p.width && fp.rel >= fp.lo && fp.rel <= fp.hi;

      if (overPanel && atPanel) {
        // Which way the panel is being shoved: with the car's travel through the
        // doorway, never into it. Latched for the whole contact so a car that
        // yaws mid-pass cannot flip the gate back through itself.
        _v2.copy(car.vel).applyQuaternion(_qi);
        if (!s.pushSide) {
          s.pushSide = _v2.z > 0 ? -1 : 1;
          if (Math.abs(_v2.z) < 0.2) s.pushSide = s.angle >= 0 ? 1 : -1;
        }
        const side = s.pushSide;

        // THE CONSTRAINT, and the whole fix. Impulses alone cannot do this:
        // the spring kept closing the panel INTO the car mid-pass, and at speed
        // the car was through the doorway before an impulse had built. A door
        // does not get nudged — it is DISPLACED, and stays displaced for exactly
        // as long as something is in its way.
        // Swing to whichever EDGE of the car's footprint the panel is being
        // pushed toward — the angle at which the panel just clears the bodywork.
        // Expressed as a delta from the current angle so nothing here has to
        // worry about which turn of ±π the bearings landed on.
        let want = fp.full
          ? side * p.maxAngle // hinge is inside the car: nothing to clear to
          : s.angle + ((side > 0 ? fp.hi : fp.lo) - fp.rel);
        if (want > p.maxAngle) want = p.maxAngle;
        else if (want < -p.maxAngle) want = -p.maxAngle;
        // Push ONLY — never drag the gate closed toward the car.
        if ((side > 0 && s.angle < want) || (side < 0 && s.angle > want)) {
          // Panel speed needed to keep up; carried into angVel so the gate keeps
          // swinging past the car instead of stopping dead the instant it clears.
          const dNeed = want - s.angle;
          s.angVel = dNeed / Math.max(dt, 1e-4) * 0.35 + s.angVel * 0.2;
          s.angle = want;
          held = true;
          s.blocking = 1 - Math.min(1, Math.abs(s.angle) / p.maxAngle);
        }

        // RESIST — the car pays for shoving it. Scaled by how CLOSED the gate
        // still is, so it fades to nothing once open: a knock, not a wall.
        const closedness = 1 - Math.min(1, Math.abs(s.angle) / p.maxAngle);
        const closing = car.vel.dot(_n);
        if (vehicle && closedness > 0.02 && Math.abs(closing) > p.minPushSpeed) {
          const brake = Math.exp(-p.resistance * closedness * dt);
          // Only the THROUGH-panel component is scrubbed — sliding along the
          // gate face must stay free, or it grabs the car sideways. And never
          // below minPushSpeed, so a gate can always be nosed open.
          const vN = car.vel.dot(_n);
          const target = Math.sign(vN) * Math.max(p.minPushSpeed, Math.abs(vN) * brake);
          car.vel.addScaledVector(_n, target - vN);
        }
      } else {
        s.pushSide = 0; // out of range: next contact re-picks a side
      }
    }

    // Spring back to closed, damped — but NOT while the car is holding it open,
    // or the panel closes through the car it is supposed to be blocked by.
    if (!held) s.angVel += -p.spring * s.angle * dt;
    s.angVel *= Math.max(0, 1 - p.damping * dt);
    s.angle += s.angVel * dt;
    if (s.angle > p.maxAngle) { s.angle = p.maxAngle; s.angVel *= -0.3; }
    else if (s.angle < -p.maxAngle) { s.angle = -p.maxAngle; s.angVel *= -0.3; }

    _q.setFromAxisAngle(_up, s.angle);
    s.inst.root.quaternion.copy(s.home.quat).multiply(_q);
  }
}
