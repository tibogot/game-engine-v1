// ============================================================================
// PROP CONTACT — the rigid-body solver every knockable prop runs on.
//
// ONE SOLVER, TWO OWNERS. The track builder's placed props (PropPhysics) and the
// city's instanced street clutter (modularRoadCityKnockables) are simulated by
// this file. They used to be two hand-tuned copies of a fake model — impulse as
// a fraction of car speed, spin written straight into angVel, one ground sphere
// that never rotated — and the copies had drifted into two different games.
// What differs between the owners is only BOOKKEEPING (a prop root vs a matrix
// in an InstancedMesh); everything that decides how an object moves is here.
//
// THE MODEL. A body is a RigidBody at its centre of mass plus a handful of
// contact POINTS on its real silhouette. Each tick, points touching the ground
// become contacts, the car's hull becomes one more, and sequential impulses with
// Coulomb friction resolve them through the inertia tensor. Tumbling, rolling,
// standing back up and settling on a stable face are what fall out — nothing is
// authored. The car is only ever READ (one-way coupling), but its mass still
// decides how much of its speed a prop can take.
//
// COST. Nothing runs for a sleeping body except the caller's broadphase. An
// awake body is one ground ray plus 8–60 point transforms, and the dense car
// point set is only walked while the hull is actually within reach.
// ============================================================================
import * as THREE from "three";
import { CHASSIS, CHASSIS_HULL } from "../../v3/play/modularRoadVehicle.js";

/**
 * Solver constants. Nothing in here is a feel knob: these keep a
 * sequential-impulse solver stable, and the feel comes from each profile's
 * mass / restitution / friction instead.
 */
export const PROP_CONTACT = {
  /** The car's gravity. The old 22 made every flight look fast-forwarded. */
  gravity: 9.81,
  /** Impulse passes per tick over all of a body's contacts. */
  iterations: 8,
  /** Penetration (m) left alone, so a resting body is not re-projected every tick. */
  slop: 0.004,
  /** A point this close to a surface (m) is already a contact. */
  margin: 0.02,
  /** Impacts slower than this (m/s) do not bounce — resting contact stays resting. */
  bounceThreshold: 0.9,
  /** Longest a point can have been inside the hull and still say which face it
   *  came through (s). Beyond this it is just overlapping: least depth decides. */
  entryWindow: 0.1,
  /** Mass the car presents to a prop. It is never moved (one-way), but each
   *  contact spends a VIRTUAL car's momentum — see _collectCar. */
  carMass: CHASSIS.mass,
  /** Seconds without touching the car before a body forgets its virtual car. */
  carMemory: 0.25,
  /** Real car this much faster (m/s, along the contact) than the virtual one
   *  means the collision's momentum is spent: stop pushing the prop out. */
  carSpentSpeed: 0.5,
  /** Numerical safety net only — no ordinary hit gets near it. */
  maxSpin: 60,
  /** A body this far below where it started (m) has left the world. */
  fallLimit: 200,
  /** A sleeping prop struck by another this fast (m/s, into it) is woken. */
  wakeSpeed: 0.5,
  /** Below this speed AND spin, held for `sleepAfter` s while grounded, a body sleeps. */
  sleepSpeed: 0.25,
  sleepSpin: 0.5,
  sleepAfter: 0.6,
};

/**
 * A flat plane at `y`, in the shape of a collider, for owners that have no real
 * one to share. The city builds its street as a plane and hands the vehicle's
 * BVH in only when there is one, and every owner of this solver then needs the
 * same fallback — so it lives here rather than in each of them.
 */
export function flatGroundAt(y) {
  return {
    baked: true,
    raycastFirst(o, _d, far) {
      const dist = o.y - y;
      if (dist < -1 || dist > far) return null;
      return { distance: dist, point: { x: o.x, y, z: o.z }, normal: { x: 0, y: 1, z: 0 } };
    },
  };
}

/**
 * THE CAR'S NOSE, for prop hits only.
 *
 * CHASSIS_HULL is a box whose front is a flat wall up to the roofline (1.26 m
 * off the road). That wall hit a 1.5 m oil drum dead on its centre of mass, so
 * the drum could only be plowed along upright. The real body is nothing like
 * that at the front — measured off chassis_compressed.glb (centre 1.2 m of
 * width, height above the road, by distance behind the nose):
 *
 *     0.0 m  0.41     0.5 m  0.67     1.0 m  0.84     1.5 m  0.92
 *
 * so the bonnet is a slope starting ~0.45 m up and rising ~0.4 m per metre.
 * Inside that span a prop point above the slope is in the AIR, and one below
 * it can meet the bonnet surface itself — which is what hits a tall object low,
 * tips it back onto the bonnet, and throws it up and over. The box top takes
 * over where the slope reaches the roofline. The rear and the sides stay box.
 */
const CAR_NOSE = {
  /** Height of the nose's top edge above the road (m). */
  top: 0.45,
  /** Bonnet rise per metre back from the nose. */
  slope: 0.4,
  /** Chassis origin above the road (CHASSIS_GLB.offsetY), to put `top` in hull axes. */
  originY: 0.5,
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _cv = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _gn = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _dv = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _rimDir = new THREE.Vector3();
const _local = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _hullC = new THREE.Vector3();
const _castFrom = new THREE.Vector3();
const _pw = new THREE.Vector3();
const _pn = new THREE.Vector3();
const _pl = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Contact points of a profile's shape, CoM-local, as flat xyz arrays.
 *
 * Shapes are authored relative to the object's ROOT (the prop root, or the
 * city instance matrix) with `baseY` the height of the bottom face; `comY` is
 * the centre of mass above the root. Three kinds:
 *
 *   cone      square base plate (`base` half-width), flat top of radius `top`,
 *             `rings` [[heightAboveBase, radius]] for the taper in between
 *   cylinder  closed, Y up, dimensions from `profile.size`
 *   box       `width` (X) × `height` × `length` (Z)
 *
 * `ground` lists only the silhouette's EXTREMES — an interior point can never
 * be lowest. `car` is denser: the bumper meets a cone halfway up its taper and
 * a drum anywhere up its side, where no ground point is. Three rings on a 1.5 m
 * drum left the bumper band (0.2–0.45 m) with no points at all, and only the
 * bonnet ever met it — so it rode up the slope and stood there.
 */
export function buildContactShape(profile) {
  const sh = profile.shape;
  const comY = profile.comY ?? 0;
  const ground = [], car = [];
  /*
   * `pair`: the points tested against ANOTHER body's exact shape. Kept off the
   * silhouette's sharp edges on purpose: a tyre stacked squarely on another has
   * its bottom rim exactly over the lower one's rim edge, where the distance
   * field's normal is undefined — up on one tick, sideways the next, and a
   * stack shuffled itself apart. Inset cap rings sit over the face, never the
   * edge, and the tread rings stay on the tread for tyres side by side.
   */
  const pair = [];
  /** Exact shape, root-relative, for the signed distance a neighbour's points are tested against. */
  const sdf = { kind: sh.kind, comY };
  const pt = (out, x, y, z) => out.push(x, y - comY, z);
  const ring = (out, y, r, n, phase = 0) => {
    for (let i = 0; i < n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      pt(out, Math.cos(a) * r, y, Math.sin(a) * r);
    }
  };
  let rims = null;
  if (sh.kind === "cone") {
    const y0 = sh.baseY;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      pt(ground, sx * sh.base, y0, sz * sh.base);
      pt(car, sx * sh.base, y0, sz * sh.base);
    }
    ring(ground, y0 + sh.height, sh.top, 6);
    for (const [h, r] of sh.rings) ring(car, y0 + h, r, 8, Math.PI / 8);
    ring(car, y0 + sh.height, sh.top, 6);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) pt(pair, sx * sh.base * 0.9, y0, sz * sh.base * 0.9);
    for (const [h, r] of sh.rings) ring(pair, y0 + h, r, 8, Math.PI / 8);
    ring(pair, y0 + sh.height, sh.top * 0.8, 4);
    // Radius by height above the base, for the distance field: the plate, the
    // taper rings, the top.
    sdf.y0 = y0;
    sdf.height = sh.height;
    sdf.profile = [[0, sh.base], ...sh.rings, [sh.height, sh.top]];
  } else if (sh.kind === "cylinder") {
    const r = profile.size.width * 0.5, h = profile.size.height * 0.5;
    const cy = (sh.baseY ?? -h) + h; // axis centre, root-relative
    rims = { r, h, cy: cy - comY };
    ring(ground, cy + h, r, 8);
    ring(ground, cy - h, r, 8);
    const n = Math.max(3, Math.round((2 * h) / 0.2) + 1);
    for (let k = 0; k < n; k++) ring(car, cy - h + (2 * h * k) / (n - 1), r, 12);
    pt(car, 0, cy + h, 0);
    pt(car, 0, cy - h, 0);
    ring(pair, cy + h, r * 0.85, 8);
    ring(pair, cy - h, r * 0.85, 8);
    for (const f of [-0.8, 0, 0.8]) ring(pair, cy + f * h, r, 12, Math.PI / 12);
    Object.assign(sdf, { r, h, cy });
  } else if (sh.kind === "box") {
    const hx = sh.width * 0.5, hz = sh.length * 0.5, y0 = sh.baseY;
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
      pt(ground, sx * hx, y0 + sy * sh.height, sz * hz);
    }
    Object.assign(sdf, { hx, hy: sh.height * 0.5, hz, cy: y0 + sh.height * 0.5 });
    // A surface grid: ~0.25 m across, ~0.2 m up. Only the SURFACE — an
    // interior point is never the first thing a bumper reaches.
    const nx = Math.max(2, Math.round(sh.width / 0.25) + 1);
    const ny = Math.max(2, Math.round(sh.height / 0.2) + 1);
    const nz = Math.max(2, Math.round(sh.length / 0.25) + 1);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) for (let k = 0; k < nz; k++) {
      if (i && j && k && i < nx - 1 && j < ny - 1 && k < nz - 1) continue;
      pt(car, -hx + (2 * hx * i) / (nx - 1), y0 + (sh.height * j) / (ny - 1), -hz + (2 * hz * k) / (nz - 1));
    }
    // A box's faces are flat, so its pair points are the same grid pulled in
    // off the edges by a few centimetres.
    for (let i = 0; i < car.length; i += 3) {
      const yc = car[i + 1] + comY - (y0 + sh.height * 0.5);
      pt(pair, car[i] * 0.94, y0 + sh.height * 0.5 + yc * 0.94, car[i + 2] * 0.94);
    }
  } else {
    throw new Error(`[PropContact] unknown shape kind "${sh.kind}"`);
  }
  let reach = 0;
  for (const list of [ground, car]) {
    for (let i = 0; i < list.length; i += 3) reach = Math.max(reach, Math.hypot(list[i], list[i + 1], list[i + 2]));
  }
  if (rims) reach = Math.max(reach, Math.hypot(rims.r, Math.abs(rims.cy) + rims.h));
  return {
    ground: new Float32Array(ground),
    car: new Float32Array(car),
    pair: new Float32Array(pair),
    sdf,
    rims,
    reach,
    /** World-space ground points for the current pose, refilled per query. */
    gp: new Float32Array(ground.length + 6),
    /** Per-point scratch for the car patch: xyz, face, depth. */
    carScratch: new Float32Array((car.length / 3) * 5),
  };
}

/** Diagonal inverse inertia about the centre of mass, from the profile. */
export function setShapeInertia(body, p) {
  const m = p.mass, sh = p.shape;
  let xx, yy, zz;
  if (sh.kind === "cone") {
    xx = zz = m * p.inertia.xx;
    yy = m * p.inertia.yy;
  } else if (sh.kind === "cylinder") {
    const r = p.size.width * 0.5, h = p.size.height;
    xx = zz = m * (3 * r * r + h * h) / 12;
    yy = m * r * r * 0.5;
  } else {
    const w = sh.width, h = sh.height, l = sh.length;
    xx = m * (h * h + l * l) / 12;
    yy = m * (w * w + l * l) / 12;
    zz = m * (w * w + h * h) / 12;
  }
  body.localInvInertia.set(1 / xx, 0, 0, 0, 1 / yy, 0, 0, 0, 1 / zz);
  body._wiQx = NaN; // drop the cached world tensor
}

/**
 * The solver. Holds nothing between ticks but a reused contact pool.
 *
 * A "sim" is any object carrying:
 *   body     RigidBody at the centre of mass
 *   profile  mass, restitution, friction, carRestitution, carFriction,
 *            bumperGive, rollingDrag, dragArea, spinDrag, shape
 *   shape    buildContactShape(profile)
 *   startY   height it started from (for the fall limit)
 *   asleep   (only read by addPair: a sleeping neighbour is immovable)
 * and gets `grounded`, `hasPlane`, `planeN`, `planeD`, `stillFor` written to it,
 * plus `wakeMe` when something hits it hard enough while it sleeps.
 *
 * ONE BODY: step(). SEVERAL THAT TOUCH (a tyre stack): begin(), addBody() for
 * each awake one, addPair() for each pair within reach, solve() once so every
 * contact in the stack is iterated together, then finish() each. Solving the
 * bodies of a stack one after another cannot hold it up: the lower tyre is
 * settled before the upper one's weight has been applied to it.
 */
export class PropContactSolver {
  constructor() {
    this.contacts = [];
    this.count = 0;
  }

  /**
   * Advance one body by `dt`. `car` is a body-like {pos, quat, vel,
   * getVelocityAtPoint?} or null; `ground` a collider with raycastFirst.
   * @returns {boolean} false if the body left the world or went non-finite —
   *   the caller decides what that means for its bookkeeping.
   */
  step(s, dt, car, ground) {
    this.begin();
    this.addBody(s, dt, car, ground);
    this.solve();
    return this.finish(s, dt);
  }

  /** Start a tick: forget last tick's contacts. */
  begin() {
    this.count = 0;
  }

  /** Gravity, the car and the ground for one awake body. */
  addBody(s, dt, car, ground) {
    s.body.vel.y -= PROP_CONTACT.gravity * dt;
    s._carC = null;
    if (car && this.carNear(s, car)) this._collectCar(s, car, dt);
    this._collectGround(s, dt, ground);
  }

  /** Iterate every contact added since begin(). */
  solve(iterations = PROP_CONTACT.iterations) {
    // Car contacts are added before a body's ground contacts, so within each
    // pass the ground has the last word — a prop the car is crushing stays
    // above the road.
    const n = this.count;
    for (let it = 0; it < iterations && n; it++) {
      for (let i = 0; i < n; i++) this._solve(this.contacts[i]);
    }
  }

  /**
   * Integrate one body after solve().
   * @returns {boolean} false if it left the world or went non-finite
   */
  finish(s, dt) {
    const C = PROP_CONTACT;
    const b = s.body;
    if (s._carC) {
      s.carVel.copy(s._carC.cv);   // what the virtual car has left
      s.carGap = 0;
      s._carC = null;
    } else {
      s.carGap = (s.carGap ?? Infinity) + dt;
    }

    b.pos.addScaledVector(b.vel, dt);
    const w = b.angVel;
    const spin = w.length();
    if (spin > C.maxSpin) w.multiplyScalar(C.maxSpin / spin);
    if (spin > 1e-9) {
      _q.set(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 0).multiply(b.quat);
      b.quat.set(b.quat.x + _q.x, b.quat.y + _q.y, b.quat.z + _q.z, b.quat.w + _q.w).normalize();
    }
    // QUADRATIC air drag, ½ρ·CdA·v²/m. It is what stops a light cone
    // outrunning the car that hit it — it sheds speed in the air within metres —
    // while a heavy drum barely notices. Linear drag cannot do both.
    const p = s.profile;
    const speed = b.vel.length();
    if (speed > 1e-4) b.vel.multiplyScalar(1 / (1 + 0.6 * p.dragArea / p.mass * speed * dt));
    const spinNow = w.length();
    if (spinNow > 1e-4) w.multiplyScalar(1 / (1 + p.spinDrag * spinNow * dt));
    if (s.grounded) w.multiplyScalar(Math.exp(-p.rollingDrag * dt));

    return b.pos.y > s.startY - C.fallLimit && Number.isFinite(b.pos.x + b.pos.y + b.pos.z + b.quat.w);
  }

  /** Remove penetration the step (or a neighbour) left, along the plane normal. */
  project(s) {
    if (!s.hasPlane) return;
    const n = s.planeN, d = s.planeD, gp = s.shape.gp;
    const count = this.groundPoints(s);
    let minSep = Infinity;
    for (let i = 0; i < count; i += 3) {
      const sep = n.x * gp[i] + n.y * gp[i + 1] + n.z * gp[i + 2] - d;
      if (sep < minSep) minSep = sep;
    }
    if (minSep < -PROP_CONTACT.slop) s.body.pos.addScaledVector(n, -minSep - PROP_CONTACT.slop);
  }

  /**
   * Sleep bookkeeping. Needs BOTH linear and angular stillness, held, and the
   * body resting on something — a hop is momentarily still at its apex.
   * @returns {boolean} true on the tick the body falls asleep
   */
  sleep(s, dt) {
    const C = PROP_CONTACT, b = s.body;
    if (s.grounded
      && b.vel.lengthSq() < C.sleepSpeed * C.sleepSpeed
      && b.angVel.lengthSq() < C.sleepSpin * C.sleepSpin) {
      s.stillFor = (s.stillFor ?? 0) + dt;
      if (s.stillFor >= C.sleepAfter) {
        b.vel.set(0, 0, 0);
        b.angVel.set(0, 0, 0);
        return true;
      }
    } else {
      s.stillFor = 0;
    }
    return false;
  }

  /** Bounding sphere of the shape against the car's hull box. */
  carNear(s, car) {
    const H = CHASSIS_HULL;
    _qi.copy(car.quat).invert();
    _local.copy(s.body.pos).sub(car.pos).applyQuaternion(_qi);
    _closest.set(
      Math.max(-H.width * 0.5, Math.min(H.width * 0.5, _local.x)),
      H.offsetY + Math.max(-H.height * 0.5, Math.min(H.height * 0.5, _local.y - H.offsetY)),
      H.offsetZ + Math.max(-H.length * 0.5, Math.min(H.length * 0.5, _local.z - H.offsetZ)),
    );
    const r = s.shape.reach + PROP_CONTACT.margin;
    return _closest.distanceToSquared(_local) < r * r;
  }

  /**
   * World-space points that can touch the current plane, into `shape.gp`.
   * A cylinder's rim contributes its EXACT lowest point, so a drum on its side
   * rolls on a circle instead of thumping round a polygon; its sampled rim
   * points only count near upright, where the whole rim is lowest at once.
   * @returns {number} length used in `shape.gp` (3 per point)
   */
  groundPoints(s) {
    const b = s.body, n = s.planeN ?? _up; // no ray cast yet: world up
    const { ground, rims, gp } = s.shape;
    let upright = 1, o = 0;
    if (rims) {
      _axis.set(0, 1, 0).applyQuaternion(b.quat);
      upright = Math.abs(_axis.dot(n));
    }
    if (!rims || upright > 0.9) {
      for (let i = 0; i < ground.length; i += 3) {
        _w.set(ground[i], ground[i + 1], ground[i + 2]).applyQuaternion(b.quat).add(b.pos);
        gp[o++] = _w.x; gp[o++] = _w.y; gp[o++] = _w.z;
      }
    }
    if (rims && upright < 0.999) {
      // Direction within the rim plane that points most "down" the normal.
      _rimDir.copy(n).multiplyScalar(-1).addScaledVector(_axis, _axis.dot(n)).normalize();
      for (const side of [1, -1]) {
        _w.copy(b.pos).addScaledVector(_axis, rims.cy + side * rims.h).addScaledVector(_rimDir, rims.r);
        gp[o++] = _w.x; gp[o++] = _w.y; gp[o++] = _w.z;
      }
    }
    return o;
  }

  /** Visit ground points as Vector3s — convenience for tests and tools, not the hot path. */
  forGroundPoints(s, fn) {
    const gp = s.shape.gp, count = this.groundPoints(s);
    for (let i = 0; i < count; i += 3) fn(_t.set(gp[i], gp[i + 1], gp[i + 2]));
  }

  /**
   * A fresh contact on `body`. The other side is one of: the ground (`b2`
   * null, `cv` zero), the car (`car`, `cv` the virtual car), or another prop
   * (`b2`, pushed the opposite way).
   */
  _push(body) {
    let c = this.contacts[this.count];
    if (!c) {
      c = { p: new THREE.Vector3(), n: new THREE.Vector3(), cv: new THREE.Vector3(), lt: new THREE.Vector3() };
      this.contacts.push(c);
    }
    this.count++;
    c.body = body;
    c.b2 = null;
    c.ln = 0;
    c.lt.set(0, 0, 0);
    c.cv.set(0, 0, 0);
    c.car = false;
    return c;
  }

  /** Velocity of the contact's first body relative to whatever it touches, at p. */
  _relVel(c, out) {
    c.body.getVelocityAtPoint(c.p, out);
    if (c.b2) return out.sub(c.b2.getVelocityAtPoint(c.p, _cv));
    return out.sub(c.cv);
  }

  /** Inverse effective mass of the contact along `dir`. */
  _invMass(c, dir) {
    _v.subVectors(c.p, c.body.pos);
    let k = c.body.effectiveInvMass(_v, dir);
    if (c.b2) {
      _w.subVectors(c.p, c.b2.pos);
      k += c.b2.effectiveInvMass(_w, dir);
    } else if (c.car) {
      k += 1 / PROP_CONTACT.carMass;
    }
    return k;
  }

  /**
   * A contact's velocity target. `sep` > 0 is a gap, < 0 penetration. A CAR
   * contact (`c.car`) is solved as a real two-body exchange against the virtual
   * car in `c.cv`: its inverse mass joins the effective mass, and _solve takes
   * each impulse back out of `c.cv`. A PAIR contact is the same exchange
   * against the other prop, which receives the opposite impulse.
   */
  _init(c, sep, dt, e, mu) {
    const C = PROP_CONTACT;
    const vn = this._relVel(c, _vr).dot(c.n);
    c.k = this._invMass(c, c.n);
    c.mu = mu;
    if (vn < -C.bounceThreshold && sep + vn * dt < 0) {
      c.target = -e * vn;
    } else {
      // Speculative: may close the gap this step, never more.
      c.target = sep > 0 ? -sep / dt : 0;
    }
    // Two props already overlapping are pushed apart gently here — there is no
    // position projection between bodies, and a stack must not pop.
    if (c.b2 && sep < -C.slop) c.target = Math.max(c.target, Math.min(1, 0.2 * (-sep - C.slop) / dt));
  }

  _apply(c, impulse) {
    c.body.applyImpulseAtPoint(impulse, c.p);
    if (c.b2) c.b2.applyImpulseAtPoint(_t.copy(impulse).negate(), c.p);
    else if (c.car) c.cv.addScaledVector(impulse, -1 / PROP_CONTACT.carMass);
  }

  _solve(c) {
    const vn = this._relVel(c, _vr).dot(c.n);
    let dl = (c.target - vn) / c.k;
    const ln = Math.max(0, c.ln + dl);
    dl = ln - c.ln;
    c.ln = ln;
    if (dl !== 0) this._apply(c, _dv.copy(c.n).multiplyScalar(dl));

    // Coulomb friction, accumulated as a vector and clamped to the cone mu·λn.
    if (!(c.mu > 0) || c.ln <= 0) return;
    this._relVel(c, _vr);
    _vr.addScaledVector(c.n, -_vr.dot(c.n));
    const vt = _vr.length();
    if (vt < 1e-6) return;
    _n.copy(_vr).multiplyScalar(-1 / vt);
    const kt = this._invMass(c, _n);
    _dv.copy(c.lt);
    c.lt.addScaledVector(_n, vt / kt);
    const max = c.mu * c.ln;
    const len = c.lt.length();
    if (len > max) c.lt.multiplyScalar(max / len);
    _dv.subVectors(c.lt, _dv);
    this._apply(c, _dv);
  }

  /**
   * Contacts between two props. Each body's `pair` points are tested against
   * the OTHER body's exact shape (a signed distance field), both ways round, so
   * a corner into a face and a face onto a corner are both caught.
   *
   * A sleeping neighbour is immovable for this tick — a flying cone lands on a
   * sleeping stack without the whole stack waking — unless it is struck hard,
   * in which case it is flagged `wakeMe` for the owner to wake next tick.
   */
  addPair(a, b, dt) {
    if (a.asleep && b.asleep) return;
    const reach = a.shape.reach + b.shape.reach + PROP_CONTACT.margin;
    if (a.body.pos.distanceToSquared(b.body.pos) > reach * reach) return;
    const e = Math.max(a.profile.restitution, b.profile.restitution);
    const mu = Math.sqrt(a.profile.friction * b.profile.friction);
    this._pointsInto(a, b, dt, e, mu, 1);
    this._pointsInto(b, a, dt, e, mu, -1);
  }

  /**
   * `from`'s pair points against `into`'s shape. A point inside `into` pushes
   * `into` back along its outward normal and `from` forward.
   */
  _pointsInto(from, into, dt, e, mu, _order) {
    const C = PROP_CONTACT;
    const pts = from.shape.pair, fb = from.body;
    for (let i = 0; i < pts.length; i += 3) {
      _pw.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(fb.quat).add(fb.pos);
      const sep = this._sdf(into, _pw, _pn);
      if (sep > C.margin) continue;
      // Put the contact on an AWAKE body, pushed away from the other one:
      // `into`'s outward normal pushes `from` out, and its reverse pushes `into`.
      const main = from.asleep ? into : from;
      const other = main === from ? into : from;
      const c = this._push(main.body);
      c.n.copy(_pn);
      if (main !== from) c.n.negate();
      if (!other.asleep) c.b2 = other.body;
      c.p.copy(_pw);
      this._init(c, sep, dt, e, mu);
      // Resting on another prop counts as support, for sleep and rolling drag.
      if (c.n.y > 0.5) main.grounded = true;
      else if (c.b2 && c.n.y < -0.5) other.grounded = true;
      if (other.asleep && this._relVel(c, _vr).dot(c.n) < -C.wakeSpeed) other.wakeMe = true;
    }
  }

  /**
   * Signed distance from world point `p` to sim `s`'s shape (negative inside),
   * with the outward surface normal written to `outN` in world space.
   */
  _sdf(s, p, outN) {
    const b = s.body, d = s.shape.sdf;
    _pq.copy(b.quat).invert();
    _pl.copy(p).sub(b.pos).applyQuaternion(_pq);
    const x = _pl.x, z = _pl.z;
    const y = _pl.y + d.comY;                 // root-relative height
    let dist;
    if (d.kind === "box") {
      const qx = Math.abs(x) - d.hx, qy = Math.abs(y - d.cy) - d.hy, qz = Math.abs(z) - d.hz;
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
      const out = Math.hypot(ox, oy, oz);
      if (out > 0) {
        dist = out;
        outN.set(Math.sign(x) * ox, Math.sign(y - d.cy) * oy, Math.sign(z) * oz).multiplyScalar(1 / out);
      } else {
        dist = Math.max(qx, qy, qz);
        if (qy >= qx && qy >= qz) outN.set(0, Math.sign(y - d.cy) || 1, 0);
        else if (qx >= qz) outN.set(Math.sign(x) || 1, 0, 0);
        else outN.set(0, 0, Math.sign(z) || 1);
      }
    } else {
      // Cylinder, or a cone as a cylinder whose radius follows the taper.
      let r, cy, h;
      if (d.kind === "cylinder") {
        r = d.r; cy = d.cy; h = d.h;
      } else {
        const hb = Math.min(Math.max(y - d.y0, 0), d.height);
        const prof = d.profile;
        r = prof[prof.length - 1][1];
        for (let k = 1; k < prof.length; k++) {
          if (hb <= prof[k][0]) {
            const [h0, r0] = prof[k - 1], [h1, r1] = prof[k];
            r = r0 + (r1 - r0) * ((hb - h0) / Math.max(h1 - h0, 1e-6));
            break;
          }
        }
        h = d.height * 0.5;
        cy = d.y0 + h;
      }
      const rad = Math.hypot(x, z);
      const rx = rad > 1e-6 ? x / rad : 1, rz = rad > 1e-6 ? z / rad : 0;
      const sy = Math.sign(y - cy) || 1;
      const dR = rad - r, dA = Math.abs(y - cy) - h;
      if (dR > 0 || dA > 0) {
        const oR = Math.max(dR, 0), oA = Math.max(dA, 0);
        dist = Math.hypot(oR, oA);
        outN.set(rx * oR, sy * oA, rz * oR).multiplyScalar(1 / dist);
      } else if (dA >= dR) {
        dist = dA;
        outN.set(0, sy, 0);
      } else {
        dist = dR;
        outN.set(rx, 0, rz);
      }
    }
    outN.applyQuaternion(b.quat);
    return dist;
  }

  /**
   * The car's hull against the prop, as ONE contact at the centre of the patch.
   *
   * Each prop point inside the hull is assigned the face it ENTERED through —
   * not the nearest face: a cone is short, so a point just under the bumper is
   * nearest the hull FLOOR, and a downward normal would stuff it into the road
   * instead of sweeping it along. The floor is never a candidate. A face only
   * counts if the point could have crossed it within `entryWindow`: without
   * that, gravity's 0.08 m/s alone made a drum level with the bumper "enter
   * through the roof", and it was popped onto the hull and carried there.
   *
   * ONE contact, not one per point, and that is what makes things tumble. A flat
   * bumper touching points at several heights is a set of constraints pure
   * TRANSLATION satisfies, so the solver cancels any spin and the prop skates
   * away upright. Real bumpers and plastic give, so the patch is every point
   * within `bumperGive` of the deepest — counting points that far OUTSIDE the
   * hull too, or on the first tick only a cone's widest ring is inside and the
   * patch lands level with its centre of mass.
   *
   * The penetration is removed by moving the PROP (a fast car can be 0.3 m into
   * it on the first tick). The car is only ever read.
   */
  _collectCar(s, car, dt) {
    const C = PROP_CONTACT, H = CHASSIS_HULL, p = s.profile, b = s.body;
    const hw = H.width * 0.5, hh = H.height * 0.5, hl = H.length * 0.5;
    const pts = s.shape.car, scratch = s.shape.carScratch;
    _hullC.set(0, H.offsetY, H.offsetZ);
    _qi.copy(car.quat).invert();
    const reach = C.margin + p.bumperGive;
    // Bonnet slope in hull axes: surface height above the hull centre at `back`
    // metres behind the nose, and its outward normal (up and forward).
    const noseY0 = CAR_NOSE.top - CAR_NOSE.originY - H.offsetY;
    const noseSpan = (hh - noseY0) / CAR_NOSE.slope;
    const bonnetCos = 1 / Math.hypot(1, CAR_NOSE.slope);

    let count = 0, deepest = -Infinity, deepFace = 0;
    for (let i = 0; i < pts.length; i += 3) {
      _w.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(b.quat).add(b.pos);
      _local.copy(_w).sub(car.pos).applyQuaternion(_qi).sub(_hullC);
      const dx = hw - Math.abs(_local.x), dy = hh - Math.abs(_local.y), dz = hl - Math.abs(_local.z);
      if (dx < -reach || dy < -reach || dz < -reach) continue;
      const back = hl - _local.z;
      const onNose = back < noseSpan;
      const dB = onNose ? (noseY0 + CAR_NOSE.slope * Math.max(0, back) - _local.y) * bonnetCos : Infinity;
      if (dB < -reach) continue;        // above the bonnet: air, not car
      if (car.getVelocityAtPoint) car.getVelocityAtPoint(_w, _cv); else _cv.copy(car.vel);
      b.getVelocityAtPoint(_w, _vr).sub(_cv).applyQuaternion(_qi); // relative, hull axes
      const sx = Math.sign(_local.x) || 1, sz = Math.sign(_local.z) || 1;
      // Face code: ±1 = ±X, ±3 = ±Z, 2 = top, 4 = bonnet.
      let face = 0, depth = 0, bestT = C.entryWindow;
      let inward = -sx * _vr.x;
      if (inward > 0.05 && dx / inward < bestT) { bestT = dx / inward; face = sx; depth = dx; }
      inward = -sz * _vr.z;
      if (inward > 0.05 && dz / inward < bestT) { bestT = dz / inward; face = 3 * sz; depth = dz; }
      if (onNose) {
        inward = -(_vr.y + CAR_NOSE.slope * _vr.z) * bonnetCos;
        if (inward > 0.05 && dB / inward < bestT) { bestT = dB / inward; face = 4; depth = dB; }
      } else if (_local.y > 0) {
        inward = -_vr.y;
        if (inward > 0.05 && dy / inward < bestT) { bestT = dy / inward; face = 2; depth = dy; }
      }
      if (!face) {
        // Not closing on any face (resting against it): least depth wins.
        if (dx < dz) { face = sx; depth = dx; } else { face = 3 * sz; depth = dz; }
        if (onNose) { if (dB < depth) { face = 4; depth = dB; } }
        else if (_local.y > 0 && dy < depth) { face = 2; depth = dy; }
      }
      const o = count * 5;
      scratch[o] = _w.x; scratch[o + 1] = _w.y; scratch[o + 2] = _w.z;
      scratch[o + 3] = face; scratch[o + 4] = depth;
      if (depth > deepest) { deepest = depth; deepFace = face; }
      count++;
    }
    if (!count || deepest < -C.margin) return;

    // The patch: points on the deepest point's face, within the give of it.
    _w.set(0, 0, 0);
    let m = 0;
    for (let k = 0; k < count; k++) {
      const o = k * 5;
      if (scratch[o + 3] !== deepFace || scratch[o + 4] < deepest - p.bumperGive) continue;
      _w.x += scratch[o]; _w.y += scratch[o + 1]; _w.z += scratch[o + 2];
      m++;
    }
    _w.multiplyScalar(1 / m);
    const ax = Math.abs(deepFace);
    if (deepFace === 4) _gn.set(0, bonnetCos, CAR_NOSE.slope * bonnetCos);
    else _gn.set(ax === 1 ? deepFace : 0, ax === 2 ? 1 : 0, ax === 3 ? Math.sign(deepFace) : 0);
    _gn.applyQuaternion(car.quat);

    /*
     * THE VIRTUAL CAR. The real car is never slowed, so against it every tick
     * of overlap is a push from an INFINITE mass: a 2 t concrete block the car
     * drove into at 20 m/s was dragged up to 20 m/s and plowed 27 m. So a body
     * remembers the car it met — its velocity at first touch — and every impulse
     * the prop takes is taken back out of that memory at the car's mass. The
     * prop ends up with what a real 1.4 t collision gives it; once that
     * momentum is spent, the real car (still at full speed) simply passes
     * through, as clutter always has. A cone barely dents it; concrete uses it
     * up in a fraction of a second.
     */
    if (car.getVelocityAtPoint) car.getVelocityAtPoint(_w, _cv); else _cv.copy(car.vel);
    if (!s.carVel || !((s.carGap ?? Infinity) <= C.carMemory)) {
      s.carVel = (s.carVel ?? new THREE.Vector3()).copy(_cv);
    }
    // The WHOLE velocity gap, not its share along this tick's normal: once the
    // car is inside something wider than itself the deepest point picks a SIDE
    // face, the gap along that normal is zero, and a "not spent" there pushed a
    // concrete block a metre sideways in one tick.
    const spent = _cv.distanceTo(s.carVel) > C.carSpentSpeed;
    if (!spent && deepest > C.slop) {
      _v.copy(_gn).multiplyScalar(deepest - C.slop);
      b.pos.add(_v);
      _w.add(_v);
    }

    const c = this._push(b);
    c.car = true;
    c.p.copy(_w);
    c.n.copy(_gn);
    c.cv.copy(s.carVel);
    s._carC = c;
    this._init(c, -Math.min(deepest, C.slop), dt, p.carRestitution, p.carFriction);
  }

  /** One ray per body for the surface under it, treated as a plane at the body's scale. */
  _plane(s, ground) {
    s.grounded = false;
    s.hasPlane = false;
    if (!ground?.baked) return false;
    const b = s.body, reach = s.shape.reach;
    _castFrom.set(b.pos.x, b.pos.y + reach, b.pos.z);
    const hit = ground.raycastFirst(_castFrom, _down, reach * 2 + 2);
    if (!hit) return false;
    const nrm = hit.normal;
    _gn.set(nrm?.x ?? 0, nrm?.y ?? 1, nrm?.z ?? 0);
    if (_gn.y < 0) _gn.negate();          // decks are double-sided
    if (_gn.y < 0.3) _gn.set(0, 1, 0);    // a wall under a downward ray: not a floor
    else _gn.normalize();
    s.planeN = (s.planeN ?? new THREE.Vector3()).copy(_gn);
    s.planeD = _gn.x * hit.point.x + _gn.y * hit.point.y + _gn.z * hit.point.z;
    s.hasPlane = true;
    return true;
  }

  _collectGround(s, dt, ground) {
    if (!this._plane(s, ground)) return;
    const C = PROP_CONTACT, p = s.profile, b = s.body, n = s.planeN, d = s.planeD;
    const gp = s.shape.gp, count = this.groundPoints(s);
    for (let i = 0; i < count; i += 3) {
      _t.set(gp[i], gp[i + 1], gp[i + 2]);
      const sep = n.dot(_t) - d;
      if (sep > C.margin) {
        b.getVelocityAtPoint(_t, _vr);
        if (sep + Math.min(0, _vr.dot(n)) * dt > C.margin) continue;
      }
      const c = this._push(b);
      c.p.copy(_t);
      c.n.copy(n);
      this._init(c, sep, dt, p.restitution, p.friction);
      s.grounded = true;
    }
  }
}
