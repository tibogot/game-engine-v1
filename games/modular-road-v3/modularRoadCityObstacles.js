// ============================================================================
// CITY OBSTACLES — the things in the street you can hit, as CAPSULES.
//
// ── WHY CAPSULES AND NOT TRIANGLES ──────────────────────────────────────────
//
// The chassis hull is SAMPLED against the collision BVH: a ring of points is
// tested, and anything thinner than the sample spacing falls between them. A
// 22 cm lamp post is exactly that — the car drives through it at some approach
// angles and stops dead at others, which is worse than no collision at all.
// The engine already solves this for gate posts, palm trunks and gantry legs
// (see PropManager.collisionCapsules): a capsule is solved as an exact
// closest-point, so a thin round thing registers at every angle and speed.
//
// So the city hands the vehicle the same `{a, b, radius}` primitives, in world
// space, on the same channel.
//
// ── WHY "NEAR", AND WHY THAT IS NOT A COMPROMISE ────────────────────────────
//
// There are ~4300 lamp posts, ~3000 parked cars and ~3000 trees. Handing all
// of them to a per-tick solver would be absurd, and pointless: a capsule 300 m
// away cannot be touched before the next refresh. So this answers a RADIUS
// QUERY, and the game re-asks when the car has moved far enough to matter.
//
// The scan is linear over a flat Float32Array of (x, z, kind, yaw) — about 10k
// entries, four floats each. At the refresh rate the game actually uses that is
// tens of thousands of compares a second, which is nothing, and it beats a
// grid here because the answer set is tiny and the build cost is zero.
//
// ── THE SHAPES ──────────────────────────────────────────────────────────────
//
// Every one is the COLLIDABLE part, not the visual silhouette — the same rule
// the palm follows (trunk, never foliage):
//
//   lamp post      upright, the pole only; the head is 9 m up
//   traffic light  upright, the pole only
//   tree           upright, the TRUNK only — a canopy you can drive under
//   parked car     horizontal, along the car; a rounded 4 m sausage
//   crossing rail  horizontal, along the panel
//
// A car is not a capsule, but a capsule the length of a car with an 0.8 m
// radius is a much better parked car than four triangles the hull sampler can
// miss, and it costs one closest-point solve.
// ============================================================================
import * as THREE from "three";

/** Which kind each entry is. Kept as a number so the table stays a Float32Array. */
const KIND = { LAMP: 0, LIGHT: 1, TREE: 2, CAR: 3, RAIL: 4, PIER: 5, COLUMN: 6 };

export const OBSTACLE_DEFAULTS = {
  /** Per kind, because a snagging fallen car is a real failure mode and the
   *  street furniture is where it would happen. Each can go off on its own. */
  lamps: true,
  lights: true,
  trees: true,
  cars: true,
  /** Pedestrian guardrail at the crossings. The most likely thing to snag on,
   *  and also the one barrier that is THERE to stop you — on by default, but
   *  the first thing to turn off if a wreck starts catching. */
  rails: true,

  /** Metres. Everything inside this of the query point is returned. */
  radius: 70,

  // ── The shapes. Each is (radius, base y, top y) for an upright, or
  //    (radius, y, half-length) for one lying along its own yaw.
  lampRadius: 0.13,
  lampHeight: 9.0,
  lightRadius: 0.11,
  lightHeight: 4.6,
  treeRadius: 0.15,
  treeHeight: 2.64,
  carRadius: 0.80,
  carHalfLength: 1.45,
  carY: 0.80,
  railRadius: 0.17,
  railHalfLength: 0.95,
  railY: 0.76,
  /**
   * VIADUCT PIERS. Two orders of magnitude more massive than anything else in
   * here, and the only obstacle in the city that would stop a car dead — which
   * is exactly why it cannot be the one thing you drive through. The radius and
   * the height are handed in from the structure that was actually built rather
   * than guessed here, because a default that drifts from the geometry is an
   * invisible column or an invisible hole.
   */
  /**
   * VIADUCT LIGHTING COLUMNS. Thin, and standing in the central reserve of a
   * road eleven metres up — so the only thing that ever meets one is a car
   * already on the deck, at speed, with nowhere to go. Exactly the reason it
   * cannot be the one piece of the structure you pass through.
   *
   * Unlike a pier, the base is NOT the ground: it is the deck. That is carried
   * on the row, because the deck comes down to street level at both ends.
   */
  columns: true,
  columnRadius: 0.22,
  columnHeight: 8.5,

  piers: true,
  pierRadius: 1.5,
  /** Fallback only. Every pier carries its OWN height — see the note in
   *  `capsulesNear` on what the fourth table slot means for a pier. */
  pierHeight: 10.5,
};

/**
 * @param {object}  opts
 * @param {THREE.Matrix4[]} [opts.lampMatrices]  the street's own lamp placements
 * @param {object}  [opts.lists]      the furniture's { cars, trees, lights, rails }
 * @param {number}  [opts.groundY]
 * @param {(x:number,z:number)=>number} [opts.avoid]  the SAME keep-out query the
 *   buildings use. A tower inside the track corridor is never built; a lamp
 *   post inside it was still DRAWN, which was fine while it was scenery and is
 *   not fine now that you can hit it. Obstacles in the corridor are dropped.
 * @param {number}  [opts.avoidRadius]
 * @param {object}  [opts.params]     overrides on OBSTACLE_DEFAULTS
 */
export function createCityObstacles({
  lampMatrices = null, lists = null, groundY = 0,
  avoid = null, avoidRadius = 40, params = {}, piers = null, columns = null,
} = {}) {
  const O = { ...OBSTACLE_DEFAULTS, ...params };
  if (piers) {
    if (piers.radius != null) O.pierRadius = piers.radius;
    if (piers.height != null) O.pierHeight = piers.height;
  }
  if (columns) {
    if (columns.radius != null) O.columnRadius = columns.radius;
    if (columns.height != null) O.columnHeight = columns.height;
  }

  // NOTE: there is deliberately no "keep clear" hole-punching here.
  //
  // The first fix for "the car spawns impaled on a lamp post" was a circle
  // around the spawn where nothing was solid. That is the wrong trade: it
  // leaves two posts you can see and drive straight through, at the one place
  // the player looks hardest. The spawn moves to a clear stretch of road
  // instead — see `streetSpawnNear` in modularRoadCity.js.

  // ── ONE FLAT TABLE ────────────────────────────────────────────────────────
  // Four floats per obstacle: x, z, kind, yaw. Built once. Nothing here is
  // ever removed, so the only per-query work is the distance compare.
  const rows = [];
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const _e = new THREE.Euler();
  /** Yaw out of a placement matrix — every one of these is an upright Y rotation. */
  const yawOf = (m) => { m.decompose(_p, _q, _s); _e.setFromQuaternion(_q, "YXZ"); return _e.y; };

  let dropped = 0;
  const push = (m, kind) => {
    const yaw = yawOf(m);
    // The track corridor, baked: it is static for a layout, and dropping it
    // here keeps the table smaller. A tower in the corridor is never built; a
    // lamp post in it was still drawn, which was fine while it was scenery.
    if (avoid && avoid(_p.x, _p.z) < avoidRadius) { dropped++; return; }
    rows.push(_p.x, _p.z, kind, yaw);
  };

  /**
   * The same drop rules as `push`, for things placed by position not matrix.
   *
   * `w` lands in the row's fourth slot. For everything with a direction that is
   * a YAW; for a pier — which is square in plan and has no meaningful yaw — it
   * is the pier's own HEIGHT. See the note in `capsulesNear`.
   */
  const pushAt = (x, z, kind, w = 0) => {
    if (avoid && avoid(x, z) < avoidRadius) { dropped++; return; }
    rows.push(x, z, kind, w);
  };

  for (const m of lampMatrices ?? []) push(m, KIND.LAMP);
  /*
   * EACH PIER CARRIES ITS OWN HEIGHT, and it has to.
   *
   * The first version passed ONE height for all of them — the main deck's
   * underside — which is right for the piers under the deck and badly wrong for
   * the ones under a slip road, because a ramp descends. Every short ramp pier
   * got a 10.4 m capsule, so each stood several metres THROUGH the ramp it was
   * holding up: an invisible column in the middle of the road, at four places
   * on every ramp, hit at speed by anyone using it.
   */
  if (O.piers) {
    for (const q of piers?.list ?? []) {
      pushAt(q.x, q.z, KIND.PIER, Math.max(0.5, (q.top ?? 0) - groundY));
    }
  }
  // A column's row carries the height of the DECK it stands on, not its own —
  // see the note on the params. Its own height is the same for all of them.
  if (O.columns) {
    for (const q of columns?.list ?? []) pushAt(q.x, q.z, KIND.COLUMN, q.y ?? 0);
  }
  for (const e of lists?.lights ?? []) push(e.m, KIND.LIGHT);
  for (const e of lists?.trees ?? []) push(e.m, KIND.TREE);
  for (const e of lists?.cars ?? []) push(e.m, KIND.CAR);
  /*
   * RAILS KEEP A BACK-REFERENCE, because they are the ones you can knock down.
   *
   * The list index and the table row are NOT the same number: `push` silently
   * drops anything inside the track corridor, so every dropped rail shifts
   * every later one. A knockable that de-collided the wrong barrier — or, once
   * the corridor moved, a different one each rebuild — is exactly the kind of
   * fault that looks like flaky physics, so the mapping is recorded rather than
   * assumed.
   */
  const railRow = new Int32Array(lists?.rails?.length ?? 0).fill(-1);
  {
    let i = 0;
    for (const e of lists?.rails ?? []) {
      const row = rows.length / 4;
      push(e.m, KIND.RAIL);
      if (rows.length / 4 > row) railRow[i] = row;
      i++;
    }
  }

  const table = new Float32Array(rows);
  const count = table.length / 4;
  /** Set once a rail has been knocked over: it stops being something to hit.
   *  Without this the car bounces off the barrier it just sent down the road. */
  const knocked = new Uint8Array(count);

  /** Per kind: is it on, and what shape does it make. Rebuilt when a flag moves. */
  /*
   * ── WHICH KINDS ARE SOLID, KEYED BY KIND ───────────────────────────────────
   *
   * This was `[O.lamps, O.lights, O.trees, O.cars, O.rails]` — a POSITIONAL
   * array indexed by `KIND`. Adding `KIND.PIER = 5` to a five-element array
   * made `on[5]` undefined, so every viaduct pier was written into the table,
   * counted in the stats, and then skipped by the one line that decides what
   * is solid. The result was a structure you could see, could park under, and
   * could drive straight through — with nothing anywhere reporting a problem.
   *
   * Keyed by KIND, an id with no flag is now a hole you cannot open by
   * accident, and `everyKindHasAnEnableFlag` in tools/viaductTest.mjs fails if
   * one ever appears again.
   */
  const enabled = () => {
    const on = [];
    on[KIND.LAMP] = O.lamps;
    on[KIND.LIGHT] = O.lights;
    on[KIND.TREE] = O.trees;
    on[KIND.CAR] = O.cars;
    on[KIND.RAIL] = O.rails;
    on[KIND.PIER] = O.piers;
    on[KIND.COLUMN] = O.columns;
    return on;
  };

  const stats = {
    total: count,
    /** How many were inside the track corridor or a keep-clear circle. */
    dropped,
    lamps: (lampMatrices ?? []).length,
    lights: (lists?.lights ?? []).length,
    trees: (lists?.trees ?? []).length,
    cars: (lists?.cars ?? []).length,
    rails: (lists?.rails ?? []).length,
    piers: (piers?.list ?? []).length,
    columns: (columns?.list ?? []).length,
    lastNear: 0,
  };

  /**
   * Every capsule within `radius` of (x, z), in world space.
   *
   * @param {number} x
   * @param {number} z
   * @param {number} [radius]  defaults to `params.radius`
   * @returns {{a:THREE.Vector3, b:THREE.Vector3, radius:number}[]}
   */
  function capsulesNear(x, z, radius = O.radius) {
    const on = enabled();
    const out = [];
    // The query radius has to allow for the obstacle's own extent, or a parked
    // car whose CENTRE is just outside is dropped while its nose is inside.
    const r2 = (radius + 2.5) * (radius + 2.5);
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const ox = table[o], oz = table[o + 1];
      const dx = ox - x, dz = oz - z;
      if (dx * dx + dz * dz > r2) continue;
      if (knocked[i]) continue;              // already on the floor — see `knocked`
      const kind = table[o + 2];
      if (!on[kind]) continue;
      const yaw = table[o + 3];

      if (kind === KIND.CAR || kind === KIND.RAIL) {
        // Lying down, along its own yaw. A placement yaw of 0 points the model
        // down -Z for a car and along X for a rail panel, so each takes its own
        // axis — getting this wrong makes a parked car block the lane it is
        // parked beside instead of the space it occupies.
        const isCar = kind === KIND.CAR;
        const half = isCar ? O.carHalfLength : O.railHalfLength;
        const y = groundY + (isCar ? O.carY : O.railY);
        const ax = isCar ? -Math.sin(yaw) : Math.cos(yaw);
        const az = isCar ? -Math.cos(yaw) : -Math.sin(yaw);
        out.push({
          a: new THREE.Vector3(ox - ax * half, y, oz - az * half),
          b: new THREE.Vector3(ox + ax * half, y, oz + az * half),
          radius: isCar ? O.carRadius : O.railRadius,
        });
        continue;
      }

      // Upright: the pole only.
      const rad = kind === KIND.LAMP ? O.lampRadius
        : kind === KIND.LIGHT ? O.lightRadius
          : kind === KIND.PIER ? O.pierRadius
            : kind === KIND.COLUMN ? O.columnRadius : O.treeRadius;
      /*
       * A PIER'S HEIGHT COMES OFF ITS OWN ROW, not out of the params.
       *
       * The fourth slot is a yaw for everything that has a direction; a pier is
       * square in plan and has none, so it carries its height there instead.
       * Every other kind is one shape repeated, and a pier is not: the ones
       * under a slip road are shorter than the ones under the deck, because the
       * road above them is coming down.
       */
      const h = kind === KIND.PIER ? (yaw > 0 ? yaw : O.pierHeight)
        : kind === KIND.COLUMN ? O.columnHeight
          : kind === KIND.LAMP ? O.lampHeight
            : kind === KIND.LIGHT ? O.lightHeight : O.treeHeight;
      // Capsule ends are the SPHERE CENTRES, so they sit a radius inside each
      // flat end of the post the geometry actually draws.
      // A column stands on the DECK; everything else stands on the ground.
      const foot = kind === KIND.COLUMN ? yaw : groundY;
      const lo = foot + rad;
      const hi = foot + Math.max(h - rad, rad + 0.01);
      out.push({
        a: new THREE.Vector3(ox, lo, oz),
        b: new THREE.Vector3(ox, hi, oz),
        radius: rad,
      });
    }
    stats.lastNear = out.length;
    return out;
  }

  const params_ = new Proxy(O, {
    set(t, k, v) { if (k in t) t[k] = v; return true; },
  });

  return {
    capsulesNear, params: params_, stats, KIND,
    /** Which kinds are currently solid, indexed by KIND. A hole here is a kind
     *  that draws and does not collide — see the note on `enabled`. */
    enabledByKind: enabled,
    /**
     * Take one rail out of collision, by its index in the FURNITURE's rail
     * list. Returns false when that rail was never in the table at all (it sat
     * in the track corridor), which the caller can treat as "already gone".
     */
    knockRail(railIndex) {
      const row = railRow[railIndex] ?? -1;
      if (row < 0 || knocked[row]) return false;
      knocked[row] = 1;
      return true;
    },
    /** How many are down — for the panel, and for a test to assert against. */
    get knockedCount() { let n = 0; for (let i = 0; i < count; i++) n += knocked[i]; return n; },
  };
}
