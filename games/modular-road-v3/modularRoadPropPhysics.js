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
//  • CONE / BARREL / TYRE — free rigid bodies on the contact-point solver in
//    modularRoadPropContact.js, shared with the city's street clutter: points
//    on each object's real shape against the road, the car's hull and each
//    other, so a tyre wall stands on itself and comes down when it is hit.
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
//
// CONTACT BODIES. The old sphere proxy could not tip, roll or right itself:
// spin was WRITTEN into angVel on a hit and bled off by damping, and the one
// ground sphere never rotated with the body, so a barrel on its side floated
// 0.75 m up, a cone could freeze standing on its tip, and a tyre knocked onto
// its tread hovered at half its thickness.
import * as THREE from "three";
import { RigidBody, CHASSIS_HULL } from "../../v3/play/modularRoadVehicle.js";
import {
  PROP_CONTACT, PropContactSolver, buildContactShape, setShapeInertia,
} from "./modularRoadPropContact.js";

/** Master switch (the dev panel reads it). The feel lives in each profile. */
export const PROP_PHYSICS = {
  enabled: true,
};

/** Solver constants live with the solver; re-exported for existing importers. */
export { PROP_CONTACT };

/**
 * Linear scale of the traffic cone, against the ~0.93 m motorway cone the
 * geometry is authored at. 1 is that real size. (A brief 3× experiment put
 * them at ~2.8 m — cartoon obstacles, not street furniture.)
 *
 * EXPORTED AND SHARED because the cone's size lives in two files: the LOOK in
 * modularRoadProps.js and the collision proxy here. Both read this, so they
 * cannot drift — which they already did once (the hardcoded copy is exactly how
 * the cone ended up half-buried; see the note in the cone's make()).
 */
export const CONE_SCALE = 1;
/**
 * Linear scale of a barrier tyre, against a real ~0.70 m OD / ~0.22 m wide
 * racing tyre. 2 puts it at 1.4 m across — still a tyre, not a doughnut the
 * car is. Lying flat, three-high is a ~1.3 m wall, which is how a real tyre
 * barrier is built. Shared with the mesh in modularRoadProps.js so the visual,
 * the stack snap, and the collision proxy cannot drift.
 */
export const TIRE_SCALE = 2;
/** Outer radius of the disc (m). Horizontal: this is the footprint radius. */
export const TIRE_OUTER_R = 0.35 * TIRE_SCALE;
/** Half-thickness of a tyre lying flat (m). Also `restY` and the ground-proxy
 *  radius — a stack of N is `N * 2 * TIRE_TUBE_R` tall. */
export const TIRE_TUBE_R = 0.112 * TIRE_SCALE;
/** Footprint + course height for editor stacking. Root sits at the centre
 *  (`restY = TIRE_TUBE_R`), so `height` is the thickness: the next tyre's
 *  centre lands on `base.y + height` and the sidewalls touch. */
export const TIRE_SIZE = {
  length: 2 * TIRE_OUTER_R,
  height: 2 * TIRE_TUBE_R,
  width: 2 * TIRE_OUTER_R,
};
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
/**
 * Target height of the oil barrel mesh (m). A real 200 L drum is ~0.88 m; at
 * true scale it reads as street furniture beside a 4.85 m car. 1.5 m keeps it
 * an obstacle you aim at — same reason CONE_SCALE exists — without matching
 * the cone's cartoon bulk. Shared with modularRoadBarrel.js so the look and
 * the collision proxy cannot drift.
 */
export const BARREL_HEIGHT = 1.5;

/** Per-type physics profile. `kind` selects the simulation, not the look. */
export const PHYSICS_PROP_TYPES = {
  cone: {
    kind: "body",
    /**
     * A real motorway cone: ~2 kg of PVC shell on a ~2.5 kg rubber base. Mass
     * scales with the SQUARE of CONE_SCALE (a shell grows by area, not volume).
     * It now decides the throw — see PROP_CONTACT.carMass — so a heavier cone
     * really does leave the bumper slower.
     */
    mass: 4.5 * CONE_SCALE * CONE_SCALE,
    /**
     * Height of the ROOT above the base. The mesh is dropped by this and the
     * root lifted by it (modularRoadProps.js), so the base is ground-flush.
     * No longer a collision sphere — the contact shape below is.
     */
    radius: 0.42 * CONE_SCALE,
    size: {
      width: 0.54 * CONE_SCALE,
      height: 0.9 * CONE_SCALE,
      length: 0.54 * CONE_SCALE,
    },
    /**
     * Centre of mass below the root (m): 0.15 m above the base, because the
     * rubber base is over half the mass. LIVE now — gravity acts here, which is
     * what stands a tilted cone back up and lays a toppled one on its side.
     */
    comY: -0.27 * CONE_SCALE,
    /** Contact silhouette, from the lathe in modularRoadProps.js: square base
     *  plate half-width, flat-top radius, overall height, the taper as
     *  [height above base, radius], and the base 0.42 m below the root. */
    shape: {
      kind: "cone",
      height: 0.93 * CONE_SCALE,
      base: 0.275 * CONE_SCALE,
      top: 0.051 * CONE_SCALE,
      rings: [[0.21, 0.150], [0.42, 0.119], [0.66, 0.083]].map(([h, r]) => [h * CONE_SCALE, r * CONE_SCALE]),
      baseY: -0.42 * CONE_SCALE,
    },
    /** Inertia per kg (m²) about the CoM — weighted base + thin shell. */
    inertia: { xx: 0.077 * CONE_SCALE * CONE_SCALE, yy: 0.034 * CONE_SCALE * CONE_SCALE },
    /** PVC/rubber on asphalt. */
    restitution: 0.25,
    friction: 0.7,
    /** Against the bumper: a soft plastic knock, and a little grip so a corner
     *  clip spins it off to the side. */
    carRestitution: 0.2,
    carFriction: 0.4,
    /**
     * How far behind the deepest point the bumper still touches (m) — PVC and
     * bumper give. It decides how high up the taper the hit lands, and that
     * lever arm over the centre of mass IS the tumble. Measured with the probe
     * (car leaving after the hit):
     *
     *     give    8 m/s            25 m/s             45 m/s
     *     0.05    knocked over     flips, 1.2 m up    2.5 m up, 28 rad/s   <- here
     *     0.07    flips            5.0 m up           10 m up, spin capped
     *
     * 0.05 is windscreen-to-roof height at motorway speed, which is what real
     * footage shows; 0.07 launches cones like mortars.
     */
    bumperGive: 0.05,
    /** Spin lost per second while touching the ground (1/s). A square base
     *  does not roll far. */
    rollingDrag: 1.2,
    /** Air: Cd·A (m²) of a tumbling cone, and spin drag (per rad/s, per s). */
    dragArea: 0.2,
    spinDrag: 0.06,
  },
  tyre: {
    kind: "body",
    /**
     * ~32 kg: a 1.4 m barrier tyre at TIRE_SCALE 2, mass scaled by area (a
     * tyre is a rubber shell, not a solid), so a wall is spectacular to smash
     * rather than a row of bollards.
     */
    mass: 8 * TIRE_SCALE * TIRE_SCALE,
    /** Height of the root above the base: the root is the tyre's centre. */
    radius: TIRE_TUBE_R,
    size: {
      width: TIRE_SIZE.width,
      height: TIRE_SIZE.height,
      length: TIRE_SIZE.length,
    },
    comY: 0,
    /**
     * A closed short cylinder, Y up, lying flat. On its tread it rolls on the
     * rims' exact lowest points, exactly as the barrel does on its side; the
     * hole is not modelled — nothing on a track fits through it.
     */
    shape: { kind: "cylinder" },
    /** Rubber: it bounces, and it grips — which is what holds a wall up. */
    restitution: 0.45,
    friction: 0.9,
    carRestitution: 0.35,
    carFriction: 0.6,
    bumperGive: 0.04,
    /** Rolls a long way on its tread, like a real loose wheel. */
    rollingDrag: 0.3,
    dragArea: 0.5,
    spinDrag: 0.01,
  },
  barrel: {
    kind: "body",
    /**
     * ~120 kg, a half-full drum. Mass is what makes it heavy now: against the
     * 1400 kg car it takes noticeably less speed than a 4.5 kg cone, and its
     * inertia makes it tumble slowly rather than cartwheel.
     */
    mass: 120,
    /**
     * Height of the root above the base (the root is the drum's centre).
     * Seeded from BARREL_HEIGHT; modularRoadBarrel refines size/radius once the
     * GLB is measured, and the contact shape is rebuilt from `size` on sync().
     */
    radius: BARREL_HEIGHT * 0.5,
    hitRadius: BARREL_HEIGHT * 0.5,
    size: {
      width: BARREL_HEIGHT * 0.66,
      height: BARREL_HEIGHT,
      length: BARREL_HEIGHT * 0.66,
    },
    comY: 0,
    /** A closed cylinder, Y up; dimensions come from `size`. */
    shape: { kind: "cylinder" },
    /** Steel on asphalt: a dull thunk, not a bounce. */
    restitution: 0.15,
    friction: 0.5,
    carRestitution: 0.1,
    carFriction: 0.3,
    bumperGive: 0.03,
    /** A drum on its side should roll a good way — low, but not frictionless. */
    rollingDrag: 0.6,
    dragArea: 0.8,
    spinDrag: 0.002,
  },
  gate: {
    kind: "hinge",
    /** Panel reach from the hinge (m), its height, and its bottom edge above the
     *  hinge root. All three are the MESH's numbers — see GATE_HEIGHT. */
    width: GATE_WIDTH,
    height: GATE_HEIGHT,
    baseY: GATE_BASE_Y,
    /**
     * Radians the panel may swing either way.
     *
     * Past 90°, deliberately. At exactly 90° the panel lies along the doorway
     * and is only just out of the way; anything approaching off-centre needs
     * more than that, and 1.5 rad (85.9°) never even reached parallel — so the
     * clamp bound constantly and the car was left pressing on a panel that had
     * run out of travel. 1.75 rad is 100°: the panel lays back past the opening
     * the way a real gate swings against its stop.
     */
    maxAngle: 1.75,
    /** Spring back to closed (1/s²) and its damping (1/s) — the door closer.
     *  Stiff+damped = a shop door, soft+loose = a saloon door. */
    spring: 14,
    damping: 2.2,
    /**
     * Mass of the panel (kg) — a 4.4 m steel field gate. With the width it IS
     * the gate's weight in the hit: the swing a car gives it and the speed the
     * car pays for it both come from it (see panelInertia). It replaced the
     * tuned `resistance` scrub, which charged the car for how CLOSED the gate
     * was rather than for anything the panel did. Measured through the middle
     * of the doorway:
     *
     *     mass   4 m/s exit   10 m/s exit   20 m/s cost   45 m/s kept
     *      50       2.50          8.59          0.76          95.9%
     *      70       2.50          7.97          1.05          94.3%
     *      90       2.50          7.28          1.33          92.7%   <- here
     *     120       2.50          6.18          1.83          90.5%
     *
     * 90 kg costs a 20 m/s pass what the tuned scrub did (1.38). A slower car
     * now pays more of its speed — it holds the gate against its closer for
     * longer, which is real — and the minPushSpeed floor still lets a crawl
     * through.
     */
    mass: 90,
    /** A real hit bangs the panel open a little faster than the car (steel). */
    restitution: 0.3,
    /** Swing kept, reversed, when the panel hits its stop at ±maxAngle. */
    stopRestitution: 0.3,
    /**
     * Floor on the car speed the gate may scrub to (m/s).
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

/** Moment of inertia of a gate panel about its hinge: a uniform plate, m·w²/3. */
const panelInertia = (p) => p.mass * p.width * p.width / 3;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
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
    /** The shared contact solver — see modularRoadPropContact.js. */
    this.solver = new PropContactSolver();
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
      // HOME IS THE AUTHORED POSE, not the live root — PropManager keeps the
      // two apart precisely because this class overwrites the root every tick
      // (see PropManager._captureAuthored). Re-syncing from the root re-homed a
      // gate to whatever angle it was swung to at that instant, so a sync
      // triggered mid-drive by the prop-count self-heal below could leave a
      // gate permanently part-open. The fallback keeps callers that build a
      // PropManager-shaped object by hand working unchanged.
      const home = {
        pos: (inst.authoredPos ?? inst.root.position).clone(),
        quat: (inst.authoredQuat ?? inst.root.quaternion).clone(),
      };
      if (profile.kind === "body") {
        const body = new RigidBody({
          mass: profile.mass,
          size: { ...profile.size, comY: profile.comY ?? 0 },
        });
        // The body lives at the CENTRE OF MASS; the root is written back
        // offset from it (_writeRoot). The shape is rebuilt here so a barrel
        // measured after its GLB loaded gets its real diameter.
        const sim = {
          inst, profile, home, body, asleep: true, stillFor: 0,
          shape: buildContactShape(profile),
          com: new THREE.Vector3(0, profile.comY ?? 0, 0),
          grounded: false,
          startY: home.pos.y,
        };
        setShapeInertia(body, profile);
        this._homeBody(sim);
        this.sims.push(sim);
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
        this._homeBody(s);
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

  /** Body at the authored pose — offset to the centre of mass for shaped props. */
  _homeBody(s) {
    s.body.quat.copy(s.home.quat);
    s.body.pos.copy(s.home.pos);
    if (s.com) s.body.pos.add(_v.copy(s.com).applyQuaternion(s.home.quat));
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
    const S = this.solver;
    const ground = this.getGroundBvh?.();

    // Gates, and waking whatever the car has reached. A settled prop costs one
    // bounding test here and nothing else.
    for (const s of this.sims) {
      if (s.profile.kind === "hinge") { this._tickHinge(s, dt, car, vehicle); continue; }
      if (s.wakeMe) { s.wakeMe = false; if (s.asleep) this._wakeCluster(s); }
      if (s.asleep && car && S.carNear(s, car)) this._wakeCluster(s);
    }

    // ONE SOLVE for every awake body and every pair within reach, so a stack's
    // contacts are iterated together. Sleeping neighbours take part as
    // immovable surfaces.
    const awake = this._awake ??= [];
    awake.length = 0;
    S.begin();
    for (const s of this.sims) {
      if (!s.body || s.asleep) continue;
      s._ai = awake.length;
      awake.push(s);
      S.addBody(s, dt, car, ground);
    }
    if (!awake.length) return;
    for (const a of awake) {
      for (const o of this.sims) {
        if (!o.body || o === a) continue;
        if (!o.asleep && o._ai < a._ai) continue;   // each awake pair once
        S.addPair(a, o, dt);
      }
    }
    // A stack needs more passes than a lone cone to carry weight down to the road.
    S.solve(awake.length > 1 ? PROP_CONTACT.iterations * 2 : PROP_CONTACT.iterations);

    for (const s of awake) {
      if (S.finish(s, dt)) continue;
      // Left the world, or the numbers did: stop integrating, and never hand a
      // non-finite pose to the renderer.
      if (!Number.isFinite(s.body.pos.x + s.body.pos.y + s.body.pos.z + s.body.quat.w)) this._homeBody(s);
      s.body.vel.set(0, 0, 0);
      s.body.angVel.set(0, 0, 0);
      s.asleep = true;
    }
    for (const s of awake) {
      if (!s.asleep) {
        S.project(s);
        if (S.sleep(s, dt)) s.asleep = true;
      }
      this._writeRoot(s);
      s._ai = -1;
    }
  }

  /** Root from body: shaped props are simulated at their centre of mass. */
  _writeRoot(s) {
    const root = s.inst.root;
    root.quaternion.copy(s.body.quat);
    root.position.copy(s.body.pos);
    if (s.com) root.position.sub(_v.copy(s.com).applyQuaternion(s.body.quat));
  }

  /**
   * Hitting one tyre in a wall has to wake the ones resting on it, or the
   * struck tyre flies off and the rest hang in the air at their authored pose.
   */
  _wakeCluster(s) {
    const q = [s];
    s.asleep = false;
    s.stillFor = 0;
    for (let i = 0; i < q.length; i++) {
      const cur = q[i];
      for (const o of this.sims) {
        if (!o.body || o === cur) continue;
        let seen = false;
        for (let k = 0; k < q.length; k++) if (q[k] === o) { seen = true; break; }
        if (seen) continue;
        if (!this._bodiesNearby(cur, o, 0.2)) continue;
        o.asleep = false;
        o.stillFor = 0;
        q.push(o);
      }
    }
  }

  /** True if two bodies' reach spheres overlap with `pad` metres of slack. */
  _bodiesNearby(a, b, pad) {
    const max = a.shape.reach + b.shape.reach + pad;
    return a.body.pos.distanceToSquared(b.body.pos) < max * max;
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
    let contact = null;
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
        contact = { side, fp };

        // THE HIT, as a real exchange between a panel with inertia and a car
        // with mass. `u` is the panel's swing rate in the push direction and
        // `rho` the lever where the bodywork meets it: the middle of the stretch
        // of panel the car's footprint covers. The car closes on that point at
        // `vc`; if it is faster than the panel there, the impulse that brings
        // them together (plus a metal bang for a real hit) is shared out by
        // the effective masses — the panel through rho²/I, the car through 1/M.
        // A crawl nudges it open, a fast hit slams it against its stop, and the
        // car pays exactly the momentum the panel took.
        const I = panelInertia(p);
        const rho = Math.min(p.width, Math.max(0.5, (fp.dist + p.width) * 0.5));
        _v2.copy(_n).multiplyScalar(-side);                     // push direction, world
        const vc = car.vel.dot(_v2);
        const u = side * s.angVel;
        const closing = vc - u * rho;
        if (closing > 0) {
          const e = closing > PROP_CONTACT.bounceThreshold ? p.restitution : 0;
          const J = (1 + e) * closing / (rho * rho / I + 1 / PROP_CONTACT.carMass);
          s.angVel += side * J * rho / I;
          // THE CAR PAYS — the only prop that ever touches it. J/M off its
          // speed, and never below minPushSpeed, so a gate can always be nosed
          // open: without the floor the cost compounds with time in contact and
          // a SLOW car is punished hardest (measured once: 45 m/s kept 88%, 6 m/s
          // kept 14%).
          //
          // SCRUB SPEED, DO NOT STEER. Taking it along the panel normal swings
          // with the panel, so removing a through-panel component injected a
          // sideways one — 4.4 m of lateral drift against the same run with no
          // gate. Taking the same amount off the SPEED leaves the heading alone.
          if (vehicle) {
            const speed = car.vel.length();
            const floor = Math.min(speed, p.minPushSpeed);
            const drop = Math.min(J / PROP_CONTACT.carMass, speed - floor);
            if (drop > 0 && speed > 1e-4) {
              car.vel.multiplyScalar(Math.max(0, (speed - drop) / speed));
            }
          }
        }
      } else {
        s.pushSide = 0; // out of range: next contact re-picks a side
      }
    }

    // The door closer: a spring back to closed, damped. It acts while the car
    // holds the gate open too — pushing it back is what the car keeps paying for.
    s.angVel += -p.spring * s.angle * dt;
    s.angVel *= Math.max(0, 1 - p.damping * dt);
    s.angle += s.angVel * dt;
    if (s.angle > p.maxAngle) { s.angle = p.maxAngle; s.angVel *= -p.stopRestitution; }
    else if (s.angle < -p.maxAngle) { s.angle = -p.maxAngle; s.angVel *= -p.stopRestitution; }

    // THE DISPLACEMENT FLOOR. The impulse lands at one lever, but a car sweeps
    // the whole stretch of panel it covers, and at speed the far end of the car
    // is through the doorway before a single contact point could keep up. So if
    // the panel is still inside the footprint on the side it is being pushed
    // toward, it is put at that edge — the angle at which it just clears the
    // bodywork — and its swing is raised to keep pace with the car. It never
    // drags the gate closed toward the car, and it charges the car nothing.
    if (contact) {
      const { side } = contact;
      const fp = this._carFootprint(car, s.angle);
      if (fp.full || (fp.rel >= fp.lo && fp.rel <= fp.hi)) {
        let want = fp.full
          ? side * p.maxAngle // hinge is inside the car: nothing to clear to
          : s.angle + ((side > 0 ? fp.hi : fp.lo) - fp.rel);
        if (want > p.maxAngle) want = p.maxAngle;
        else if (want < -p.maxAngle) want = -p.maxAngle;
        if ((side > 0 && s.angle < want) || (side < 0 && s.angle > want)) {
          const keepUp = (want - s.angle) / Math.max(dt, 1e-4);
          if (side * s.angVel < side * keepUp) s.angVel = keepUp;
          s.angle = want;
          s.blocking = 1 - Math.min(1, Math.abs(s.angle) / p.maxAngle);
        }
      }
    }

    _q.setFromAxisAngle(_up, s.angle);
    s.inst.root.quaternion.copy(s.home.quat).multiply(_q);

    // KEEP THE PANEL OUT OF THE CAR — by moving the PANEL, never the car.
    //
    // The spring is what puts it there. The displacement floor above acts only
    // while the car's footprint still overlaps the panel's own ray, and a car that has
    // driven most of the way through is past that while its TAIL is still in the
    // doorway — so the gate swung shut through the back of the car. Measured in
    // the running page at every crossing point: ~1.0 m of panel inside the
    // bodywork, which is half a car width, i.e. the panel sweeping across the
    // centreline.
    //
    // An earlier attempt fixed this by pushing the CAR out instead, and that was
    // worse than the bug: the panel is being swung by the car, so the overlap it
    // has to correct can be enormous, and it flung the car sideways out of the
    // doorway — 12.6 m of displacement over one pass, 1.87 m in a single tick.
    // A gate is allowed to stop moving. It is not allowed to drive the car.
    if (car) this._keepPanelClearOfCar(s, car);

    _q.setFromAxisAngle(_up, s.angle);
    s.inst.root.quaternion.copy(s.home.quat).multiply(_q);
  }

  /**
   * Back the panel off to the edge of the car if the swing put it inside.
   *
   * Costs the car nothing: this only ever writes `s.angle`. The panel stops
   * against the bodywork exactly as a real gate would, and the car carries on
   * with its speed and its heading untouched.
   */
  _keepPanelClearOfCar(s, car) {
    const p = s.profile;
    _qi.copy(s.home.quat).invert();
    _v.copy(car.pos).sub(s.home.pos).applyQuaternion(_qi);
    if (_v.y < -1.0 || _v.y > p.baseY + p.height + 0.4) return; // over or under it

    const fp = this._carFootprint(car, s.angle);
    if (fp.dist >= p.width) return;      // bodywork out of the panel's reach
    // Hinge inside the car: the panel's own root is under the bodywork, so no
    // angle can clear it. Nothing to yield to — go straight to blocking.
    if (fp.full) { this._blockCarAtPanel(s, car); return; }
    if (fp.rel <= fp.lo || fp.rel >= fp.hi) return; // already clear

    // Out to whichever edge of the wedge is nearer — the shortest way back to
    // not intersecting, which is also the side it swung in from.
    const toLo = fp.rel - fp.lo, toHi = fp.hi - fp.rel;
    const useLo = toLo < toHi;
    let next = s.angle + (useLo ? -toLo : toHi);
    // RAN OUT OF SWING. This is the whole case the gate could never handle: the
    // panel is against its stop and still inside the car, so yielding further is
    // not available and something has to hold the car out.
    let jammed = false;
    if (next > p.maxAngle) { next = p.maxAngle; jammed = true; }
    else if (next < -p.maxAngle) { next = -p.maxAngle; jammed = true; }
    s.angle = next;
    // It stopped against something; carrying the closing speed would just drive
    // it straight back in on the next tick.
    if (s.angVel * (useLo ? -1 : 1) < 0) s.angVel = 0;
    s.blocking = 1;
    if (jammed) this._blockCarAtPanel(s, car);
  }

  /**
   * Stop the car at a panel that has run out of swing.
   *
   * STOPPING IS NOT PUSHING, and the difference is the whole point. This cancels
   * the component of velocity carrying the car INTO the panel and does nothing
   * else: no repositioning, no energy added, tangential motion untouched. The car
   * cannot advance into the panel, can slide along it, and can always reverse
   * back out — which is exactly how the chassis already behaves against a wall.
   *
   * An earlier attempt at this repositioned the car instead and flung it 12.6 m
   * sideways over a single pass. Velocity-only cannot do that: penetration only
   * deepens while the car is still moving inward, and that is precisely what is
   * being removed here.
   */
  _blockCarAtPanel(s, car) {
    const p = s.profile;
    // Panel frame at the settled angle, plan view. `_n` ends up as the outward
    // face normal on whichever side the car is on.
    const ax = Math.cos(s.angle), az = -Math.sin(s.angle);
    const nx = -az, nz = ax;
    _qi.copy(s.home.quat).invert();
    _v.copy(car.pos).sub(s.home.pos).applyQuaternion(_qi);
    _fwd.set(0, 0, 1).applyQuaternion(car.quat).applyQuaternion(_qi);
    const fl = Math.hypot(_fwd.x, _fwd.z);
    const cx = _v.x + (fl > 1e-6 ? (_fwd.x / fl) * CHASSIS_HULL.offsetZ : 0);
    const cz = _v.z + (fl > 1e-6 ? (_fwd.z / fl) * CHASSIS_HULL.offsetZ : 0);
    const d = cx * nx + cz * nz;
    if (Math.abs(d) < 1e-6) return; // dead on the panel plane: no side to hold
    _n.set(nx, 0, nz).applyQuaternion(s.home.quat).multiplyScalar(d >= 0 ? 1 : -1);
    const vIn = car.vel.dot(_n);
    if (vIn < 0) car.vel.addScaledVector(_n, -vIn);
    void p;
  }
}
