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
import { RigidBody, CHASSIS } from "../../v3/play/modularRoadVehicle.js";

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

/** Per-type physics profile. `kind` selects the simulation, not the look. */
export const PHYSICS_PROP_TYPES = {
  cone: {
    kind: "body",
    mass: 2.2,
    /** Collision proxy: a sphere at the centre of mass. A cone is close enough
     *  to a sphere for being punted by a car, and it never gets stuck on edges
     *  the way a hull would. */
    radius: 0.42,
    size: { width: 0.54, height: 0.9, length: 0.54 },
    comY: -0.27, // low CoM so it rights itself and settles base-down
  },
  gate: {
    kind: "hinge",
    /** Panel reach from the hinge (m) and its height. */
    width: 2.2,
    height: 1.6,
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
     * through with a knock rather than bouncing off a wall. Measured: 5.5 took
     * a 20 m/s car down to 6.2 — a wall, not a gate. 1.8 costs about a third of
     * your speed, which reads as shouldering through something.
     *
     * The ONLY place a prop touches the car — cones stay strictly one-way. A
     * gate that cost you nothing would not be an obstacle.
     */
    resistance: 0.9,
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
    const hw = CHASSIS.width * 0.5, hh = CHASSIS.height * 0.5, hl = CHASSIS.length * 0.5;
    _closest.set(
      Math.max(-hw, Math.min(hw, _local.x)),
      Math.max(-hh, Math.min(hh, _local.y)),
      Math.max(-hl, Math.min(hl, _local.z)),
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
      const r = Math.hypot(_v.x, _v.z);
      // Plan-view radius of the car — what the panel actually has to clear.
      const carR = CHASSIS.width * 0.5 + 0.35;

      if (r < p.width + carR && Math.abs(_v.y) < p.height + 0.6) {
        // Angle from the hinge to the car, and how wide the car looks from there.
        // Close to the hinge a car subtends nearly 90°, far out it is a sliver —
        // which is exactly why a door has to swing further when you are near it.
        const carAng = Math.atan2(-_v.z, _v.x);
        const halfW = Math.atan2(carR, Math.max(0.4, r));

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
        let want = carAng + side * halfW;
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
