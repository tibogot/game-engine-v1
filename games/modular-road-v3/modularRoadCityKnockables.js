// ============================================================================
// CITY KNOCKABLES — the street clutter you can send down the road.
//
// ── THE SAME PHYSICS AS THE TRACK BUILDER, NOT A COPY OF IT ──────────────────
//
// Cones, bins, pallets, water barriers and concrete jerseys run on the contact
// solver in modularRoadPropContact.js — the one the track builder's placed props
// use. This file used to carry its own model (throw = fraction of car speed,
// spin written in, a flat ground plane, a "hit" strip ahead of the car) with its
// own tuning table, and a cone in the city behaved like a different object from
// a cone on a track. What is left here is only what is genuinely the city's:
// the BOOKKEEPING of bodies that live as matrices inside an InstancedMesh.
//
// ── WHY THIS IS STILL A POOL ─────────────────────────────────────────────────
//
// PropPhysics syncs a body for every placed prop. The city has thousands of
// clutter placements inside a handful of InstancedMeshes, and a body each would
// cost more than the physics. So nothing simulates until the car's hull is
// within reach: a body is borrowed, simulated until it settles, and returned —
// its final pose stays on the instance (`liveM`), and it can be hit again.
//
// COST. Idle: one squared-distance compare per placement per frame, for the
// broadphase. Awake: what the solver costs, for at most `pool` bodies.
//
// ── ONE-WAY COUPLING, AND NOTHING HERE IS SOLID ──────────────────────────────
//
// The car shoves clutter; clutter never pushes back, exactly as on a track. None
// of these kinds is in the city's obstacle table (see modularRoadCityClutter.js),
// so there is no capsule to race and no de-collision to do.
// ============================================================================
import * as THREE from "three";
import { RigidBody, FIXED_DT } from "../../v3/play/modularRoadVehicle.js";
import { PropContactSolver, buildContactShape, setShapeInertia } from "./modularRoadPropContact.js";

export const CITY_KNOCK = {
  enabled: true,
  /**
   * Most bodies simulated at once. The cap is the whole cost model — every
   * other placement is a distance compare — and a settled body returns its
   * slot, so this bounds what is MOVING, not what has ever been hit.
   */
  pool: 32,
  /**
   * Fixed steps per frame, at most. The solver runs on the vehicle's 120 Hz
   * clock (this used to integrate on the render frame, so a hit depended on the
   * frame rate); a long frame drops time rather than spiralling.
   */
  maxSubsteps: 8,
};

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _v = new THREE.Vector3();
const _r = new THREE.Vector3();
const _zero = new THREE.Vector3();
/** Hull half-diagonal in plan (m) — a placement farther than this plus its own
 *  reach from the car's origin cannot be touching it. */
const HULL_PLAN_REACH = 2.8;

/**
 * @param {object} o
 * @param {Array<{list:Array, mesh:THREE.InstancedMesh, profile:object}>} o.groups
 *        each kind's placements ({ m, x, z }), its mesh, and its physics profile
 *        (see CLUTTER_PHYSICS).
 * @param {number} o.groundY  street height — only used when no ground collider
 *        is handed to update()
 * @param {object} [o.params] CITY_KNOCK overrides
 */
export function createCityKnockables({ groups = [], groundY = 0, params = {} }) {
  const K = { ...CITY_KNOCK, ...params };
  // Disabled means ABSENT, not idle: no pool, no per-frame scan, and the city's
  // updateKnockables returns 0 without touching anything.
  if (!K.enabled) return null;
  const G = groups.filter((g) => g && g.mesh && g.list?.length && g.profile)
    .map((g) => ({ ...g, shape: buildContactShape(g.profile) }));
  if (!G.length) return null;

  const solver = new PropContactSolver();
  /** @type {Array<object>} simulated bodies */
  const active = [];
  const stats = { knocked: 0, active: 0 };
  let acc = 0;

  /** A flat street at groundY, for callers that have no collider to share. */
  const flatGround = {
    baked: true,
    raycastFirst(o, _d, far) {
      const dist = o.y - groundY;
      if (dist < -1 || dist > far) return null;
      return { distance: dist, point: { x: o.x, y: groundY, z: o.z }, normal: { x: 0, y: 1, z: 0 } };
    },
  };

  /**
   * The car as the solver sees it during one substep. The vehicle has already
   * finished this frame's ticks, so earlier substeps rewind its position along
   * its velocity instead of hitting everything against where it ENDED.
   */
  const carView = {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    getVelocityAtPoint(p, out) {
      _r.subVectors(p, this.pos);
      return out.crossVectors(this.angVel, _r).add(this.vel);
    },
  };

  /** Broadphase results for this frame: placements near the car, with their pose. */
  const near = [];
  /** Reused probe objects — the broadphase allocates nothing per frame. */
  const probes = [];
  const probeAt = (i) => probes[i] ??= {
    g: null, e: null, shape: null,
    root: new THREE.Vector3(), pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: new THREE.Vector3(),
    body: null,
  };
  /** Bodies released this frame, whose resting pose still has to be uploaded. */
  const settled = [];
  const wrote = new Set();

  function poseOf(g, e, out) {
    (e.liveM ?? e.m).decompose(_pos, _quat, _scl);
    out.root.copy(_pos);
    out.quat.copy(_quat);
    out.scale.copy(_scl);
    // Centre of mass: `comY` up the object's own axis from its base.
    out.pos.set(0, g.profile.comY ?? 0, 0).applyQuaternion(_quat).add(_pos);
  }

  function activate(g, e, pose) {
    const p = g.profile;
    const body = new RigidBody({
      mass: p.mass,
      size: { width: p.shape.width ?? 0.5, height: p.shape.height ?? 0.5, length: p.shape.length ?? 0.5 },
    });
    setShapeInertia(body, p);
    body.pos.copy(pose.pos);
    body.quat.copy(pose.quat);
    const sim = {
      g, e, body, profile: p, shape: g.shape,
      com: new THREE.Vector3(0, p.comY ?? 0, 0),
      scale: pose.scale.clone(),
      startY: pose.pos.y,
      grounded: false, hasPlane: false, stillFor: 0,
    };
    e.active = true;
    active.push(sim);
    stats.knocked++;
  }

  /** The instance pose from the body: root = CoM minus the rotated offset. */
  function writePose(sim) {
    const b = sim.body;
    _v.copy(sim.com).applyQuaternion(b.quat);
    _pos.copy(b.pos).sub(_v);
    const e = sim.e;
    e.liveM = (e.liveM ?? new THREE.Matrix4()).compose(_pos, b.quat, sim.scale);
    // Culling and the broadphase read x/z; a cone thrown 30 m must be culled
    // and found where it LANDED, not where it was placed.
    e.x = _pos.x;
    e.z = _pos.z;
  }

  function release(i) {
    const sim = active[i];
    sim.e.active = false;
    active[i] = active[active.length - 1];
    active.pop();
    settled.push(sim);
  }

  /**
   * Every frame. `car` is the vehicle body (read only, or null); `ground` the
   * collider the vehicle drives on, so clutter lands on bridges, ramps and the
   * underpass the way the car does.
   */
  function update(dt, car, ground) {
    acc = Math.min(acc + Math.max(0, dt), FIXED_DT * K.maxSubsteps);
    const steps = Math.floor(acc / FIXED_DT);
    if (!steps) return;
    acc -= steps * FIXED_DT;
    const gnd = ground ?? flatGround;

    // ── BROADPHASE, once per frame ────────────────────────────────────────────
    near.length = 0;
    if (car && active.length < K.pool) {
      const travel = car.vel.length() * steps * FIXED_DT;
      for (const g of G) {
        const r = HULL_PLAN_REACH + g.shape.reach + travel + 0.25;
        const r2 = r * r;
        for (const e of g.list) {
          if (e.active) continue;
          const dx = e.x - car.pos.x, dz = e.z - car.pos.z;
          if (dx * dx + dz * dz > r2) continue;
          const probe = probeAt(near.length);
          probe.g = g;
          probe.e = e;
          probe.shape = g.shape;
          poseOf(g, e, probe);
          probe.body ??= { pos: probe.pos };
          near.push(probe);
        }
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
        view.angVel.copy(car.angVel ?? _zero);
        for (const probe of near) {
          if (probe.e.active || active.length >= K.pool) continue;
          if (solver.carNear(probe, view)) activate(probe.g, probe.e, probe);
        }
      }
      for (let i = active.length - 1; i >= 0; i--) {
        const sim = active[i];
        if (!solver.step(sim, FIXED_DT, view, gnd)) {
          // Left the world or went non-finite: a NaN pose must never reach the
          // instance buffer, so that one goes back to where it was placed.
          if (!Number.isFinite(sim.body.pos.x + sim.body.pos.y + sim.body.pos.z + sim.body.quat.w)) {
            sim.e.liveM = null;
          } else {
            writePose(sim);
          }
          release(i);
          continue;
        }
        solver.project(sim);
        if (solver.sleep(sim, FIXED_DT)) {
          writePose(sim);
          release(i);
        }
      }
    }

    // ── WRITE WHAT MOVED ──────────────────────────────────────────────────────
    /*
     * STRAIGHT INTO THE INSTANCE, because the furniture's LOD only rewrites
     * matrices five times a second and a body in the air needs every frame.
     * `idx` is where the last LOD tick put this entry, and -1 when it culled it
     * — writing to a stale index would move somebody else's cone.
     */
    for (const sim of active) writePose(sim);
    wrote.clear();
    const upload = (sim) => {
      const slot = sim.e.idx ?? -1;
      const mesh = sim.g.mesh;
      if (slot < 0 || slot >= mesh.count) return;
      mesh.setMatrixAt(slot, sim.e.liveM ?? sim.e.m);
      wrote.add(mesh);
    };
    for (const sim of active) upload(sim);
    // Bodies that settled this frame: their resting pose, once.
    for (const sim of settled) upload(sim);
    settled.length = 0;
    for (const m of wrote) m.instanceMatrix.needsUpdate = true;
    stats.active = active.length;
  }

  return { update, stats, params: K };
}
