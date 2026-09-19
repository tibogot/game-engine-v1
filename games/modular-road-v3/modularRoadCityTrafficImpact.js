// ============================================================================
// TRAFFIC IMPACTS — the moving cars you can actually hit.
//
// ── WHY THE TRAFFIC IS NOT SIMPLY MADE SOLID ─────────────────────────────────
//
// The cheap build is to hand the traffic to the ground aggregation the way the
// buildings are handed to it (modularRoadCityCollider.js): the crash then comes
// free, because the vehicle arms `_crashYield` off any solid hit and does not
// care what it hit. It is also wrong, and obviously so the first time you see
// it: you slam into a moving wall, and the wall drives on through your wreck at
// 11 m/s. A car is the one object in the street with visible mass and visible
// momentum, so it is the one object that cannot be scenery with a collider.
//
// So a struck car becomes a RIGID BODY on the same solver as the cones, the
// bins and the concrete — modularRoadPropContact.js — and the only thing this
// file adds to that is the bookkeeping of a car that has stopped being traffic.
//
// ── A CAR THAT IS HIT MUST LEAVE ITS LANE ────────────────────────────────────
//
// The traffic model is one-dimensional: a car is a scalar `u` along a lane plus
// a place in that lane's ring, and the ring is what makes red lights work (see
// the note on `laneCars` in modularRoadCityFurniture.js). A car knocked ten
// metres sideways has no valid `u` and no meaningful place in the queue — if it
// stayed in the ring it would still be somebody's leader, braking a whole lane
// for a position it no longer occupies. So the impact DETACHES it: spliced out
// of its ring and out of the fleet, in one place, outside the step.
//
// The queue behind it simply closes up, and the wreck is then just an object in
// the road that the remaining traffic drives through. That is a deliberate
// omission rather than an oversight: making the sim queue behind a wreck costs
// an order of magnitude more than the two seconds you spend looking at it at
// 40 m/s. What is NOT acceptable — and is what the detach avoids — is a lane
// that quietly deadlocks because one of its cars is lying on its roof.
//
// A detached car is never given back. The fleet is ~1100 cars and `keep` is 14,
// so a long session loses a few dozen out of a thousand, which is invisible.
// Re-inserting one would mean choosing an arc of a ring at a point the player
// cannot see — exactly the operation the ring's own comments record getting
// wrong twice — for nothing anybody would notice.
//
// ── THE TEST IS AN OVERLAP, NOT A PROXIMITY ──────────────────────────────────
//
// The clutter pool activates a body as soon as the hull is within the shape's
// reach, and for a cone that is right: a cone that wakes a few centimetres
// early and is not touched just sits there. A CAR that wakes early stops
// driving — it leaves the lane, coasts, and rolls to a halt beside you for no
// reason. Reach for a saloon is ~2.6 m, so "near" would fire while you are
// still a car's width away.
//
// So `carNear` is only the broad phase here, and the detach needs a real
// overlap: each box's corners tested against the other box, both ways round.
// Edge-crossing with no corner inside is the known gap in that test, and it
// cannot matter here — both boxes are road vehicles of similar height, so any
// configuration that crosses an edge puts a corner inside first.
//
// Plus a CLOSING SPEED floor, which is what stops a queue that creeps into a
// stopped player from turning a red light into a scrapyard. Below it you simply
// overlap, which is what the traffic has always done.
//
// ── THE PLAYER PAYS, AND THE SOLVER ALREADY KNEW HOW MUCH ────────────────────
//
// One-way coupling means the car is read and never written, and against a 3 kg
// cone that is invisible. Against 1.4 tonnes it is the whole collision: driving
// through a car at unchanged speed reads worse than no collision at all.
//
// The number is already computed. `_collectCar` gives every body a VIRTUAL car
// — the car's velocity at first touch — and takes each impulse back out of it
// at the car's mass, which is what stops the real car being an infinite-mass
// pusher. The speed that virtual car loses in a tick is, by construction,
// exactly the speed a real car would have lost. So the scrub is a subtraction,
// not a tuning parameter: whatever the virtual car spent, the real one pays.
//
// Taken off the SPEED, never along the contact normal — see the same decision
// in the gate (modularRoadPropPhysics.js): removing a through-normal component
// injects a sideways one and steers the car. A `minPushSpeed` floor keeps a
// wreck nudgeable at a crawl.
//
// ── AND THEN IT IS SOLID, WHICH THE SOLVER ALONE CANNOT DO ───────────────────
//
// One-way coupling has a limit, and on 1.4 tonnes you see it immediately. The
// virtual car is spent after a fraction of a second (`carSpentSpeed`), and from
// then on the real car — still at whatever speed it has left — passes straight
// through, exactly as clutter always has. Hitting a car and then driving
// through the wreck is worse than either behaviour on its own.
//
// The fix is not more solver. It is the channel the city ALREADY uses to stop
// you driving through a PARKED car: `Vehicle.setSolidCapsules`, an exact
// analytic de-collision against a rounded sausage, solved every substep with no
// thinness limit (see modularRoadCityObstacles.js). A wreck is a car lying in
// the road, so it becomes exactly what a parked car already is.
//
// Two things make it cheap. The capsule's dimensions are DERIVED from the same
// profile the collider box comes from, and land on the parked car's own
// constants to the centimetre (radius 0.80, half-length 1.45 for a saloon), so
// there is no second table to disagree. And `setSolidCapsules` keeps the
// objects it is given, so a wreck that owns its capsule and rewrites the two
// endpoints in place MOVES in the vehicle's list for free — no re-push, no
// re-slice, nothing per frame but two vector writes.
//
// The one thing the owner must do is force the capsule window to refresh on the
// frame a car is struck; the window normally only rebuilds every 18 m, and a
// wreck made at the bumper would otherwise not be solid for most of a block.
// That is what `update()` returns.
//
// ── COST ─────────────────────────────────────────────────────────────────────
//
// Idle, with nothing hit: one squared-distance compare per DRAWN car per frame,
// and nothing else — no bodies, no rays, no solver. The traffic sim has already
// computed every position, so the broad phase is a filter over numbers that
// exist. Awake: what the solver costs, for at most `pool` bodies, on the
// vehicle's own 120 Hz clock.
// ============================================================================
import * as THREE from "three";
import { RigidBody, FIXED_DT, CHASSIS_HULL } from "../../v3/play/modularRoadVehicle.js";
import {
  PropContactSolver, buildContactShape, setShapeInertia, PROP_CONTACT, flatGroundAt,
} from "./modularRoadPropContact.js";

export const TRAFFIC_IMPACT = {
  enabled: true,
  /**
   * Bodies simulated at once. Anything past this is FROZEN, not dropped: it
   * keeps its pose and its slot and stops being stepped, which for a car that
   * has already come to rest is what it was going to look like anyway.
   */
  pool: 8,
  /** Wrecks kept in the world at all. Past this the farthest one is removed. */
  keep: 14,
  /** Fixed steps per frame, at most; a long frame drops time rather than spiralling. */
  maxSubsteps: 8,
  /**
   * How far from the car a wreck must be before it may be removed to make room
   * (m). Well past the chase camera's reach, so nothing ever vanishes in frame
   * — and with `keep` at 14 you would have to crash fourteen times before the
   * first one is even a candidate.
   */
  dropRange: 160,
  /** Search radius for the broad phase (m). A car plus a hull plus slack. */
  searchRadius: 9,
  /** Overlap slack on the exact test (m). */
  hitMargin: 0.06,
  /**
   * Closing speed (m/s) below which a touch is not an impact. Traffic creeping
   * into a stopped player at a light is not a crash; a car arriving at 11 m/s
   * is, and it clears this by a factor of seven.
   */
  minImpactSpeed: 1.5,
  /** Whether the player pays for the momentum the wreck takes. */
  scrub: true,
  /**
   * THE ONE FEEL KNOB. 1 is the physical answer — near-equal masses, so a
   * square-on hit into a stationary car costs the player about half its speed,
   * which is what actually happens and which an arcade racer may not want.
   * Lower it to keep the shove and soften the cost; 0 is `scrub: false`.
   */
  scrubScale: 1,
  /** Floor on the speed a scrub may leave the car with (m/s). */
  minPushSpeed: 3.0,
};

/**
 * Mass by body name, in kg. A body the table does not name falls back to
 * `MASS_PER_METRE` × its length, which is about what the four named ones
 * average — so a new archetype behaves sensibly before anybody has thought
 * about it, rather than weighing whatever a default happened to be.
 */
const BODY_MASS = { saloon: 1380, hatchback: 1120, van: 2150, taxi: 1450 };
const MASS_PER_METRE = 290;

/**
 * How far the car may sink into a wreck's contact box before its solid capsule
 * stops it (m). See the note in trafficCarProfile — without it the contact
 * solver never sees a penetration and a settled wreck cannot be pushed at all.
 */
const CAPSULE_GIVE = 0.22;

/**
 * A contact profile from a CAR_BODIES entry — the SAME table the mesh is built
 * from, read the same way, so the collider cannot disagree with the shape you
 * can see. `pts` are (along, up) in metres about the model origin, and the
 * origin sits on the road, so the box runs from the tyres to the roof.
 *
 * The box is centred on the root in Z; the hatchback's profile is 4 cm
 * off-centre and nothing else is, which is below the margin.
 *
 * `comY` at 36% of the height is a car: low, because the mass is the engine,
 * the floor and the tank. It is what makes a struck car spin and slide instead
 * of cartwheeling, and it is the one number here that is chosen rather than
 * measured.
 */
export function trafficCarProfile(B) {
  let zMin = Infinity, zMax = -Infinity, yMax = 0;
  for (const [z, y] of B.pts) {
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    if (y > yMax) yMax = y;
  }
  const length = zMax - zMin;
  const height = yMax;
  const mass = BODY_MASS[B.name] ?? Math.round(MASS_PER_METRE * length);
  /*
   * THE SOLID CAPSULE, AND WHY IT IS DELIBERATELY SMALLER THAN THE BOX.
   *
   * Sized like the parked car's (OBSTACLE_DEFAULTS.carRadius 0.80,
   * carHalfLength 1.45 for a saloon) and then INSET by `CAPSULE_GIVE` on every
   * axis. The inset is the whole point and it was found by measurement.
   *
   * Fitted flush to the box, the capsule works — and a settled wreck becomes a
   * bollard. MEASURED: driving into one at 9 m/s stopped the car dead and moved
   * the wreck 0.00 m, because the de-collision runs inside the vehicle's
   * substep and never lets the car penetrate, so `_collectCar` finds no point
   * inside the hull, raises no contact, and the body is never pushed.
   *
   * Inset, the car sinks `CAPSULE_GIVE` into the box first: the contact solver
   * gets its penetration, pushes the wreck and charges the car, and the capsule
   * is only the BACKSTOP that stops the car continuing through once the virtual
   * car's momentum is spent. Soft shell, hard core — in that order.
   */
  const capRadius = Math.min(B.width * 0.44, B.width * 0.5 - CAPSULE_GIVE);
  return {
    name: B.name,
    mass,
    comY: height * 0.36,
    capsule: {
      radius: capRadius,
      half: Math.max(0.05, length * 0.5 - capRadius - CAPSULE_GIVE),
      axisY: capRadius,
    },
    shape: { kind: "box", width: B.width, height, length, baseY: 0 },
    // Sheet metal on rubber: it barely bounces, and it grips.
    restitution: 0.05, friction: 0.85,
    carRestitution: 0.08, carFriction: 0.4,
    /** Low: a car shoves and spins, it does not tumble off a bumper. */
    bumperGive: 0.02,
    /** Frontal area; at this mass the quadratic term is noise, which is right. */
    dragArea: 2.2,
    rollingDrag: 2.6, spinDrag: 0.01,
  };
}

const UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const _v = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _root = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);

/** Scratch for the separating-axis test. Built once; the test allocates nothing. */
const _axA = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _axB = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _R = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
const _absR = [new Float64Array(3), new Float64Array(3), new Float64Array(3)];
const _tA = new Float64Array(3);
const _eA = new Float64Array(3);
const _eB = new Float64Array(3);
const _cA = new THREE.Vector3();
const _cB = new THREE.Vector3();
const _d = new THREE.Vector3();
/** Parallel axes make a cross product zero-length; this keeps the test stable. */
const SAT_EPS = 1e-6;

/**
 * Do these two boxes overlap? Fifteen separating axes: three faces each and the
 * nine edge pairs.
 *
 * ── WHY NOT THE CHEAP TEST ───────────────────────────────────────────────────
 *
 * The first version put each box's corners inside the other and skipped the
 * edge axes, on the argument that two road vehicles of similar height cannot
 * cross an edge without a corner entering first. That is FALSE, and it is false
 * for the most ordinary hit in the game: the player's hull is 2.10 m wide and
 * 1.06 m tall, a saloon is 1.82 m wide and 1.36 m tall, so in a square-on
 * rear-end the hull's corners are outside the saloon in X while the saloon's
 * corners are outside the hull in Y — the two boxes interpenetrate with no
 * corner of either inside the other. MEASURED: every rear-end in the test
 * suite read as a clean miss, while a T-bone (where the aspect ratios line up
 * differently) hit correctly. The nine edge axes are not an edge case here,
 * they are the main case.
 */
function boxesOverlap() {
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      _R[i][j] = _axA[i].dot(_axB[j]);
      _absR[i][j] = Math.abs(_R[i][j]) + SAT_EPS;
    }
  }
  for (let i = 0; i < 3; i++) _tA[i] = _d.dot(_axA[i]);
  // A's faces.
  for (let i = 0; i < 3; i++) {
    const rb = _eB[0] * _absR[i][0] + _eB[1] * _absR[i][1] + _eB[2] * _absR[i][2];
    if (Math.abs(_tA[i]) > _eA[i] + rb) return false;
  }
  // B's faces.
  for (let j = 0; j < 3; j++) {
    const ra = _eA[0] * _absR[0][j] + _eA[1] * _absR[1][j] + _eA[2] * _absR[2][j];
    const t = _tA[0] * _R[0][j] + _tA[1] * _R[1][j] + _tA[2] * _R[2][j];
    if (Math.abs(t) > ra + _eB[j]) return false;
  }
  // The nine edge pairs.
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3, i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      const ra = _eA[i1] * _absR[i2][j] + _eA[i2] * _absR[i1][j];
      const rb = _eB[j1] * _absR[i][j2] + _eB[j2] * _absR[i][j1];
      if (Math.abs(_tA[i2] * _R[i1][j] - _tA[i1] * _R[i2][j]) > ra + rb) return false;
    }
  }
  return true;
}

/**
 * @param {object} o
 * @param {object} o.fleet   the traffic, as three calls — see createCityFurniture:
 *        `list()` the live cars, `frame()` the counter updateTraffic stamps a
 *        drawn car's pose with, `detach(car)` to take one out of its ring.
 * @param {Array<THREE.InstancedMesh|null>} o.meshes  one per body, by index
 * @param {Array<object>} o.bodies  CAR_BODIES
 * @param {number} o.groundY  street height, for when no collider is handed in
 * @param {object} [o.params] TRAFFIC_IMPACT overrides
 */
export function createTrafficImpacts({ fleet, meshes, bodies, groundY = 0, params = {} }) {
  const K = { ...TRAFFIC_IMPACT, ...params };
  // Disabled means ABSENT: no profiles, no per-frame scan, no call site left
  // doing nothing. The furniture's updateTrafficImpacts returns 0 on its first
  // line when this is null.
  if (!K.enabled || !meshes?.some(Boolean)) return null;

  const profiles = bodies.map(trafficCarProfile);
  const shapes = profiles.map(buildContactShape);
  const solver = new PropContactSolver();
  const flat = flatGroundAt(groundY);

  /** @type {Array<object>} every wreck in the world, newest last. */
  const wrecks = [];
  /** Candidates this frame — reused, so the broad phase allocates nothing. */
  const cand = [];
  const stats = { hit: 0, wrecks: 0, awake: 0 };
  let acc = 0;
  let seq = 0;

  /** The car as the solver sees it during one substep — see the note in
   *  modularRoadCityKnockables.js: the vehicle has already finished its ticks,
   *  so earlier substeps rewind it along its velocity. */
  const carView = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    getVelocityAtPoint(p, out) {
      _v.subVectors(p, this.pos);
      return out.crossVectors(this.angVel, _v).add(this.vel);
    },
  };

  /**
   * Does the live car's box overlap the player's hull?
   *
   * A = the hull, which may be at any attitude, so its axes come off the
   * vehicle's quaternion. B = the traffic car, which the sim can only ever
   * produce upright and yawed, so its axes are one sine and one cosine. The
   * margin is added to A, once.
   */
  function overlaps(c, view) {
    const sh = profiles[c.body ?? 0].shape;
    const H = CHASSIS_HULL, m = K.hitMargin;
    const cos = Math.cos(c.yaw), sin = Math.sin(c.yaw);

    _cA.set(0, H.offsetY, H.offsetZ).applyQuaternion(view.quat).add(view.pos);
    _axA[0].set(1, 0, 0).applyQuaternion(view.quat);
    _axA[1].set(0, 1, 0).applyQuaternion(view.quat);
    _axA[2].set(0, 0, 1).applyQuaternion(view.quat);
    _eA[0] = H.width * 0.5 + m; _eA[1] = H.height * 0.5 + m; _eA[2] = H.length * 0.5 + m;

    _cB.set(c.wx, c.wy + sh.baseY + sh.height * 0.5, c.wz);
    // A yaw about Y sends local x to (cos, 0, -sin) and local z to (sin, 0, cos)
    // — the same convention the instance matrix is composed with.
    _axB[0].set(cos, 0, -sin); _axB[1].set(0, 1, 0); _axB[2].set(sin, 0, cos);
    _eB[0] = sh.width * 0.5; _eB[1] = sh.height * 0.5; _eB[2] = sh.length * 0.5;

    _d.subVectors(_cB, _cA);
    return boxesOverlap();
  }

  /**
   * How fast the two are closing, along the line between them in plan.
   *
   * In plan on purpose: the vertical component of a car landing on another is
   * not what this floor is for, and counting it would let a hard landing
   * beside a stopped queue wreck a car it never touched laterally.
   */
  function closingSpeed(c, view) {
    _rel.set(c.wx - view.pos.x, 0, c.wz - view.pos.z);
    const d = _rel.length();
    if (d < 1e-4) return Infinity;
    _rel.multiplyScalar(1 / d);
    // The traffic car's velocity: its nose points along travel, and the yaw
    // drawn this frame is what put it there — so this cannot disagree with
    // the direction the car is seen to be going.
    const tvx = Math.sin(c.yaw) * c.v, tvz = Math.cos(c.yaw) * c.v;
    return (view.vel.x - tvx) * _rel.x + (view.vel.z - tvz) * _rel.z;
  }

  /** Instance matrix from the body: root = CoM minus the rotated offset. */
  function writeMatrix(w) {
    _v.copy(w.com).applyQuaternion(w.body.quat);
    _root.copy(w.body.pos).sub(_v);
    w.matrix.compose(_root, w.body.quat, _one);
  }

  /**
   * The solid capsule, IN PLACE. The vehicle keeps the object it was handed
   * (`setSolidCapsules` shallow-copies the list), so rewriting these two
   * endpoints is the whole of making a wreck move as a collider — there is no
   * push, no rebuild, and no per-frame allocation.
   *
   * It runs along the body's own Z, so a wreck on its roof or its side presents
   * the sausage it actually occupies rather than the one it was parked as.
   */
  function writeCapsule(w) {
    const cp = w.profile.capsule;
    const dy = cp.axisY - w.profile.comY;
    _v.set(0, dy, -cp.half).applyQuaternion(w.body.quat);
    w.cap.a.copy(w.body.pos).add(_v);
    _v.set(0, dy, cp.half).applyQuaternion(w.body.quat);
    w.cap.b.copy(w.body.pos).add(_v);
  }

  /** A live car stops being traffic and becomes a body. */
  function wreck(c, view) {
    const bi = c.body ?? 0;
    const p = profiles[bi];
    const body = new RigidBody({
      mass: p.mass,
      size: { width: p.shape.width, height: p.shape.height, length: p.shape.length },
    });
    setShapeInertia(body, p);
    body.pos.set(c.wx, c.wy + p.comY, c.wz);
    body.quat.setFromAxisAngle(UP, c.yaw);
    /*
     * IT ARRIVES MOVING. A car hit from behind at 40 m/s that started from rest
     * is a parked car, and it reads as one — the whole difference between
     * hitting traffic and hitting street furniture is that traffic had
     * somewhere to be. `c.v` is the speed the queueing model had it at this
     * tick, and the yaw is the direction it was drawn going.
     */
    body.vel.set(Math.sin(c.yaw) * c.v, 0, Math.cos(c.yaw) * c.v);
    const w = {
      bi, body, profile: p, shape: shapes[bi],
      com: new THREE.Vector3(0, p.comY, 0),
      color: new THREE.Color(c.color),
      startY: body.pos.y,
      grounded: false, hasPlane: false, stillFor: 0,
      asleep: false,
      /*
       * IT INHERITS THE LIVE CAR'S INSTANCE SLOT. updateTraffic drew the car
       * this frame and will not draw it again; without this the wreck has no
       * slot until the next frame's compaction, and the instance it used to
       * occupy holds a stale matrix for one frame — a car that jumps back to
       * where it was hit, then forward again.
       */
      slot: c.slot ?? -1,
      seq: seq++,
      matrix: new THREE.Matrix4(),
      /** Handed to the vehicle and then rewritten in place — see writeCapsule. */
      cap: {
        a: new THREE.Vector3(),
        b: new THREE.Vector3(),
        radius: p.capsule.radius,
        /*
         * THE CAPSULE IS NOT A WALL, and saying so is what stops it feeling
         * like one. Without this the vehicle reads its closing speed against
         * the WORLD, so a wreck you have just shoved away at 20 m/s is still a
         * 20 m/s impact and the de-collision kills all of it — you stop dead
         * against the thing you are pushing. With it the contact is resolved in
         * the wreck's own frame: shoving it costs almost nothing (you are
         * barely closing on it), and a wreck flung back INTO you hits harder,
         * which is the same trade the movers already make.
         *
         * The exact rigid-body answer, not just the linear velocity — a wreck
         * spinning about its centre has a nose going one way and a tail going
         * the other, and the bumper meets one of them.
         */
        velAt: (p2, out) => {
          out.subVectors(p2, body.pos).cross(body.angVel).multiplyScalar(-1).add(body.vel);
          return out;
        },
      },
    };
    fleet.detach(c);
    wrecks.push(w);
    writeMatrix(w);
    writeCapsule(w);
    upload(w);
    stats.hit++;

    // Over the simulation cap: the oldest awake one stops being stepped. It
    // keeps its pose, so nothing moves or disappears.
    let awake = 0;
    for (const o of wrecks) if (!o.asleep) awake++;
    if (awake > K.pool) {
      let oldest = null;
      for (const o of wrecks) if (!o.asleep && o !== w && (!oldest || o.seq < oldest.seq)) oldest = o;
      if (oldest) freeze(oldest);
    }
    if (wrecks.length > K.keep) dropFarthest(view.pos);
  }

  function freeze(w) {
    w.asleep = true;
    w.body.vel.set(0, 0, 0);
    w.body.angVel.set(0, 0, 0);
  }

  /** Make room: the farthest wreck past `dropRange`, or nothing at all. */
  function dropFarthest(from) {
    let far = -1, at = -1;
    for (let i = 0; i < wrecks.length; i++) {
      const b = wrecks[i].body.pos;
      const dx = b.x - from.x, dz = b.z - from.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > far) { far = d2; at = i; }
    }
    if (at < 0 || far < K.dropRange * K.dropRange) return;
    wrecks.splice(at, 1);
  }

  /**
   * One substep of one body, and the player's share of it.
   *
   * begin/addBody/solve/finish rather than `step()`, because the scrub has to
   * read the virtual car BETWEEN addBody (which creates or refreshes it) and
   * finish (which writes back what is left of it). That difference is the
   * momentum this contact took, at the car's own mass.
   */
  function stepWreck(w, dt, view, gnd, car) {
    solver.begin();
    solver.addBody(w, dt, view, gnd);
    const touching = !!w._carC;
    const before = touching ? w.carVel.length() : 0;
    solver.solve();
    const alive = solver.finish(w, dt);
    if (touching && K.scrub && car) {
      const lost = (before - w.carVel.length()) * K.scrubScale;
      if (lost > 0) {
        const speed = car.vel.length();
        const floor = Math.min(speed, K.minPushSpeed);
        const drop = Math.min(lost, speed - floor);
        if (drop > 0 && speed > 1e-4) car.vel.multiplyScalar((speed - drop) / speed);
      }
    }
    return alive;
  }

  const wrote = new Set();
  /** Straight into the instance — see the same note in the knockable pool: the
   *  furniture's compaction runs once per frame and a body in the air needs
   *  every one. A slot past `count` belongs to nobody yet. */
  function upload(w) {
    const mesh = meshes[w.bi];
    if (!mesh || w.slot < 0 || w.slot >= mesh.count) return;
    mesh.setMatrixAt(w.slot, w.matrix);
    wrote.add(mesh);
  }

  /**
   * Every frame. `car` is the vehicle body (read, and its speed scrubbed);
   * `ground` the collider the vehicle drives on, so a wreck lands on the
   * viaduct and in the underpass the way the car does.
   * @returns {number} cars struck THIS frame
   */
  function update(dt, car, ground) {
    if (!car && !wrecks.length) return 0;
    acc = Math.min(acc + Math.max(0, dt), FIXED_DT * K.maxSubsteps);
    const steps = Math.floor(acc / FIXED_DT);
    if (!steps) return 0;
    acc -= steps * FIXED_DT;
    const gnd = ground ?? flat;
    const hit0 = stats.hit;

    // ── BROADPHASE ────────────────────────────────────────────────────────────
    // Only cars DRAWN this frame are candidates, and that is the rule rather
    // than an optimisation: a lane passing over the underpass trench is not
    // drawn there, and a car you cannot see is not a car you can hit.
    cand.length = 0;
    if (car) {
      const list = fleet.list();
      const frame = fleet.frame();
      const r = K.searchRadius + car.vel.length() * steps * FIXED_DT;
      const r2 = r * r;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.poseF !== frame) continue;
        const dx = c.wx - car.pos.x, dz = c.wz - car.pos.z;
        if (dx * dx + dz * dz > r2) continue;
        cand.push(c);
      }
    }

    // ── FIXED STEPS ───────────────────────────────────────────────────────────
    for (let k = 0; k < steps; k++) {
      let view = null;
      if (car) {
        view = carView;
        view.pos.copy(car.pos).addScaledVector(car.vel, -(steps - 1 - k) * FIXED_DT);
        view.quat.copy(car.quat);
        view.vel.copy(car.vel);
        view.angVel.copy(car.angVel ?? ZERO);
        for (let i = cand.length - 1; i >= 0; i--) {
          const c = cand[i];
          if (!overlaps(c, view) || closingSpeed(c, view) < K.minImpactSpeed) continue;
          cand[i] = cand[cand.length - 1];
          cand.pop();
          wreck(c, view);
        }
        // A wreck the car comes back to. `carNear` is the whole test here —
        // a body already off its wheels has no lane left to be taken out of,
        // so waking it early costs nothing.
        for (const w of wrecks) if (w.asleep && solver.carNear(w, view)) w.asleep = false;
      }
      for (let i = wrecks.length - 1; i >= 0; i--) {
        const w = wrecks[i];
        if (w.asleep) continue;
        if (!stepWreck(w, FIXED_DT, view, gnd, car)) {
          // Left the world or went non-finite. A NaN pose must never reach the
          // instance buffer, so that one leaves rather than being drawn.
          wrecks.splice(i, 1);
          continue;
        }
        solver.project(w);
        if (solver.sleep(w, FIXED_DT)) w.asleep = true;
      }
    }

    // ── WRITE WHAT MOVED ──────────────────────────────────────────────────────
    wrote.clear();
    let awake = 0;
    for (const w of wrecks) {
      if (w.asleep) continue;
      awake++;
      writeMatrix(w);
      writeCapsule(w);
      upload(w);
    }
    for (const m of wrote) m.instanceMatrix.needsUpdate = true;
    stats.wrecks = wrecks.length;
    stats.awake = awake;
    return stats.hit - hit0;
  }

  /**
   * The wrecks, for the frame's instance compaction. updateTraffic packs the
   * live cars of each body to the front of that body's mesh and then calls this
   * for the rest — a wreck is drawn by the same mesh, in a slot the car it used
   * to be has vacated, so capacity can never be exceeded.
   */
  function forEach(fn) {
    for (const w of wrecks) fn(w);
  }

  /**
   * The wrecks' solid capsules within `radius` of (x, z), for the city's
   * obstacle window. The objects are the wrecks' OWN — handing out copies would
   * freeze every wreck at the pose it had when the window was last rebuilt,
   * which is 18 m of driving.
   */
  function capsulesNear(x, z, radius) {
    const out = [];
    for (const w of wrecks) {
      const b = w.body.pos;
      const dx = b.x - x, dz = b.z - z;
      // Its own length counts: a wreck whose CENTRE is just outside the window
      // can still have its nose inside it.
      const r = radius + w.profile.capsule.half + w.profile.capsule.radius;
      if (dx * dx + dz * dz <= r * r) out.push(w.cap);
    }
    return out;
  }

  return { update, forEach, capsulesNear, wrecks, stats, params: K };
}
