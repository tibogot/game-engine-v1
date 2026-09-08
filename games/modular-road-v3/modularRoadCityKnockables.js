// ============================================================================
// CITY KNOCKABLES — the pedestrian guardrails, sent down the street.
//
// ── WHY THIS IS NOT PropPhysics ──────────────────────────────────────────────
//
// modularRoadPropPhysics.js already tosses cones, and the right instinct is to
// reuse it. It cannot be reused HERE, and the reason is structural rather than
// stylistic: PropPhysics syncs its sim list from `props.instances` — the props a
// designer placed, each a real object with its own transform. The city's rails
// are 8352 matrices inside ONE InstancedMesh, and their collision is a radius
// query over a flat table. Turning them into 8352 prop instances to get physics
// would cost more than the physics.
//
// So this is a POOL. The rails stay one instanced draw and nothing simulates
// until something is hit; a handful of bodies are borrowed, thrown, and left
// where they land. Idle cost is one squared-distance compare per rail near the
// car, which the furniture's own LOD partition has already narrowed.
//
// The body model is deliberately the same shape as PropPhysics' — impulse from
// car speed, loft, tumble, ground bounce, sleep — so a barrier and a cone
// behave like they belong in the same game. Its constants are re-declared here
// rather than imported because they are TUNED PER OBJECT: a 2 m guardrail panel
// is not a traffic cone, and sharing the numbers would mean neither could be
// tuned without moving the other.
//
// ── ONE-WAY COUPLING ─────────────────────────────────────────────────────────
//
// The car shoves rails; rails never push back. Same rule PropPhysics follows,
// for the same two reasons: the tuned vehicle physics stays untouched, and the
// only genuinely risky feedback path never exists. A barrier that cost you the
// corner would feel like a bug even when it was correct.
//
// ── WHAT MAKES IT SAFE ───────────────────────────────────────────────────────
//
// A knocked rail is taken out of the obstacle table the moment it is hit
// (`obstacles.knockRail`). Without that the car bounces off the barrier it just
// sent cartwheeling, which reads as the collision being broken rather than as
// the barrier being gone.
// ============================================================================
import * as THREE from "three";

export const CITY_KNOCK = {
  /**
   * OFF, and the reason is a design one rather than a cost one.
   *
   * These bodies were built for the PEDESTRIAN GUARDRAILS, and a guardrail
   * stands flush against the kerb with the pavement immediately behind it. It
   * has nowhere to go. Driving into one does not send it down the street — the
   * car scrapes along it, the barrier disappears out from under the contact,
   * and what you feel is a collision that stopped working rather than an
   * object you hit. PLAYED, and it is not fun, which is the only test that
   * mattered here.
   *
   * The machinery was right; the target was wrong. It now drives the STREET
   * CLUTTER instead — cones, bins, pallets and water barriers, which stand in
   * the road with room behind them and which hitting is a decision you made.
   * See modularRoadCityClutter.js.
   */
  enabled: true,
  /**
   * How many rails can be in the air at once.
   *
   * The cap is the whole cost model: everything else sleeps or is untouched, so
   * this is the only number that scales work. 32 is far more than a car can
   * realistically have moving, and small enough that the per-frame integrate is
   * unmeasurable.
   */
  pool: 32,
  /** Only rails within this of the car are even distance-tested. */
  range: 16,
  /** Half-width of the swathe the car clears, measured across its heading. A
   *  rail panel is 1.9 m long and a car ~1.9 m wide, so this is generous on
   *  purpose — clipping the end of a barrier should still take it out. */
  hitRadius: 2.4,
  /**
   * How far AHEAD the car clears, as seconds of travel — see the note at the
   * hit test for why this cannot be a plain radius.
   *
   * 0.35 s is about two car lengths at speed. Long enough that the capsule is
   * gone before the bumper arrives, short enough that barriers do not
   * evaporate ahead of a car that was never going to reach them.
   */
  lookahead: 0.35,
  lookaheadMax: 9,
  /** Below this the car is parking, not demolishing. Stops a slow nudge
   *  launching a barrier, which is the thing that reads as a physics glitch. */
  minSpeed: 3.0,

  // ── The toss. Shaped like PROP_PHYSICS but tuned for a heavier panel. ──
  gravity: 22,
  /** Fraction of car speed handed to the rail. Under 1 for the same reason the
   *  cones use 0.85: a barrier that outruns the car that hit it looks wrong. */
  hitImpulse: 0.72,
  /** Loft as a fraction of the throw — enough to leave the ground, not a punt. */
  hitLoft: 0.26,
  /** Tumble per m/s of throw, and a hard cap. A guardrail cartwheels; it does
   *  not spin like a struck cone, so both are below the cone's. */
  spinPerSpeed: 1.1,
  spinMax: 11,
  restitution: 0.22,
  /** Ground friction, per second, applied to horizontal speed on contact. */
  friction: 3.2,
  angularDamping: 1.5,
  /** Below this speed AND spin for `sleepAfter` seconds, a body stops. */
  sleepSpeed: 0.3,
  sleepSpin: 0.6,
  sleepAfter: 0.5,
};

const _v = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();

/**
 * SEVERAL KINDS, ONE POOL.
 *
 * A cone and a water-filled barrier are the same simulation with different
 * numbers, so they share the bodies and the per-frame scan; what they do not
 * share is MASS, which is the only thing that makes one of them fly and the
 * other shove. Each group carries its own overrides and the body remembers
 * which group threw it.
 *
 * One pool rather than one per kind because the pool cap IS the cost model: 32
 * bodies is the ceiling on all the work this system can ever do in a frame,
 * and four pools of 32 would quietly make that 128.
 *
 * @param {object} o
 * @param {Array<{list:Array, mesh:THREE.InstancedMesh, params?:object, solid?:object}>} o.groups
 *        each kind's placements ({ m, x, z }), its mesh, and its overrides.
 *        `solid` is an optional obstacle table with `knockRail(i)` — a kind
 *        without one is never in the collision table and needs no de-collision.
 * @param {number} o.groundY
 * @param {object} [o.params]  defaults shared by every group
 */
export function createCityKnockables({ groups = [], groundY = 0, params = {} }) {
  const K = { ...CITY_KNOCK, ...params };
  // Disabled means ABSENT, not idle: no pool, no per-frame scan, and the city's
  // updateKnockables returns 0 without touching anything.
  if (!K.enabled) return null;
  const G = groups.filter((g) => g && g.mesh && g.list?.length)
    .map((g) => ({ ...g, K: { ...K, ...(g.params ?? {}) } }));
  if (!G.length) return null;
  /** @type {Array<{g:object, idx:number, e:object, pos:THREE.Vector3, vel:THREE.Vector3,
   *   quat:THREE.Quaternion, spin:THREE.Vector3, still:number, done:boolean}>} */
  const active = [];
  const stats = { knocked: 0, active: 0 };

  function knock(g, idx, carVel, speed) {
    if (active.length >= K.pool) return false;
    // Collision first, for a kind that HAS collision: if the table has already
    // dropped this one (it sat in the track corridor and was never solid),
    // there is nothing to knock. A kind with no table is always knockable.
    if (g.solid && !g.solid.knockRail?.(idx)) return false;
    const e = g.list[idx];
    // NOT `K` — the outer K is read on this function's first line, and a
    // same-named const here puts that read inside its own dead zone.
    const gk = g.K;
    e.m.decompose(_pos, _quat, _scl);

    const throwSpeed = speed * gk.hitImpulse;
    const dir = _v.copy(carVel).setY(0);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1); else dir.normalize();

    active.push({
      g,
      idx,
      e,
      pos: _pos.clone(),
      vel: dir.multiplyScalar(throwSpeed).setY(throwSpeed * gk.hitLoft),
      quat: _quat.clone(),
      // Tumble about a horizontal axis across the throw — a panel hit side-on
      // goes end over end, which a random axis does not give you.
      spin: new THREE.Vector3(-dir.z, 0, dir.x)
        .multiplyScalar(Math.min(throwSpeed * gk.spinPerSpeed, gk.spinMax)),
      still: 0,
      done: false,
    });
    e.knocked = true;
    stats.knocked++;
    return true;
  }

  /**
   * Every frame. `car` is the vehicle body — position and velocity only; this
   * never writes to it.
   */
  function update(dt, car) {
    if (!car) return;
    const step = Math.min(dt, 1 / 30);   // a long frame must not launch anything

    /*
     * ── WHAT THE CAR IS ABOUT TO HIT, not what it is touching ────────────────
     *
     * A radius test around the car does not work here, and the reason is an
     * ordering one. The vehicle resolves its capsule collisions in its own
     * step; by the time a rail is close enough to be "hit" it has ALREADY
     * stopped the car. MEASURED: driving a run of guardrails at 16 m/s knocked
     * exactly one and arrived at the next at 1.4 m/s — the car was demolishing
     * a barrier and being stopped by it in the same instant.
     *
     * So the test looks AHEAD along the velocity, by a distance that scales
     * with speed. A rail is knocked and de-collided a few frames before the car
     * reaches it, which is what makes a fast car plough through a run and a
     * slow one still get stopped — which is the correct answer to both.
     *
     * Measured along the car's own axis: `ahead` is how far down the velocity
     * the rail sits, `side` how far off it. A rail behind the car (ahead < 0)
     * is left alone however close it is, or reversing into a kerb would clear
     * the barrier you already drove past.
     */
    const speed = car.vel ? car.vel.length() : 0;
    if (speed >= K.minSpeed && active.length < K.pool) {
      const cx = car.pos.x, cz = car.pos.z;
      const ux = car.vel.x / speed, uz = car.vel.z / speed;
      scan: for (const g of G) {
        const GK = g.K;
        if (speed < GK.minSpeed) continue;
        const r2 = GK.range * GK.range;
        // A kind with no collision needs no lookahead: nothing is going to
        // stop the car before the body is launched, so the honest test is
        // "did the car reach it", not "is it about to".
        const reach = g.solid ? Math.min(speed * GK.lookahead, GK.lookaheadMax) : 0;
        const list = g.list;
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (e.knocked) continue;
          const dx = e.x - cx, dz = e.z - cz;
          if (dx * dx + dz * dz > r2) continue;
          const ahead = dx * ux + dz * uz;
          if (ahead < -GK.hitRadius || ahead > reach + GK.hitRadius) continue;
          const side = Math.abs(dx * uz - dz * ux);
          if (side <= GK.hitRadius) { if (!knock(g, i, car.vel, speed)) break scan; }
        }
      }
    }

    // ── INTEGRATE WHAT IS MOVING ─────────────────────────────────────────────
    const wrote = new Set();
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i];
      if (b.done) continue;
      const bk = b.g.K;
      b.vel.y -= bk.gravity * step;
      b.pos.addScaledVector(b.vel, step);

      if (b.pos.y <= groundY) {
        b.pos.y = groundY;
        if (b.vel.y < 0) b.vel.y = -b.vel.y * bk.restitution;
        const damp = Math.max(0, 1 - bk.friction * step);
        b.vel.x *= damp; b.vel.z *= damp;
        b.spin.multiplyScalar(Math.max(0, 1 - bk.angularDamping * step));
      }

      const spinLen = b.spin.length();
      if (spinLen > 1e-5) {
        _axis.copy(b.spin).multiplyScalar(1 / spinLen);
        _dq.setFromAxisAngle(_axis, spinLen * step);
        b.quat.premultiply(_dq).normalize();
      }

      // Sleep: a settled panel must stop integrating AND stop jittering.
      if (b.vel.lengthSq() < bk.sleepSpeed * bk.sleepSpeed && spinLen < bk.sleepSpin) {
        b.still += step;
        if (b.still > bk.sleepAfter) { b.done = true; b.vel.set(0, 0, 0); b.spin.set(0, 0, 0); }
      } else {
        b.still = 0;
      }

      // The live pose the LOD writer picks up instead of the authored one.
      b.e.liveM = (b.e.liveM ?? new THREE.Matrix4())
        .compose(b.pos, b.quat, _scl.set(1, 1, 1));
      /*
       * WRITTEN STRAIGHT INTO THE INSTANCE, because the furniture's LOD only
       * rewrites matrices five times a second and a body in the air needs every
       * frame. `idx` is where the last LOD tick put this entry, and -1 when it
       * culled it — writing to a stale index would move somebody else's rail.
       */
      const slot = b.e.idx ?? -1;
      const mesh = b.g.mesh;
      if (slot >= 0 && slot < mesh.count) { mesh.setMatrixAt(slot, b.e.liveM); wrote.add(mesh); }
    }
    for (const m of wrote) m.instanceMatrix.needsUpdate = true;

    // Retire finished bodies — the rail keeps `liveM`, so it stays where it
    // fell for as long as the city lives.
    for (let i = active.length - 1; i >= 0; i--) if (active[i].done) active.splice(i, 1);
    stats.active = active.length;
  }

  return { update, stats, params: K };
}
