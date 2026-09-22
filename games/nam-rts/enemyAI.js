// The enemy commander — GAME LOGIC (mesh-free). The opponent that PLAYS: it
// takes and holds requisition points, attacks yours, falls back, and fights
// from cover. It gives orders only through the same unit API the player uses
// (orderTo / moveOrder), and combat.js does the fighting — this file decides
// WHERE men go and WHEN, never who hits whom.
//
// It thinks in SQUADS of men (`squadSize`), once a `tick` on the sim clock:
//
//   recruit   its own purse (requisition pays it for points it holds, and its
//             HQ's trickle), one man every `recruitTime` s, coming up at the
//             most forward TUNNEL nobody of yours is watching (the HQ's door
//             if there is none); a full squad goes out
//   choose    each free squad scores every point — take a neutral one, relieve
//             a threatened one of its own, attack one of yours IF it is strong
//             enough for what it knows is there — and the nearest, least-claimed
//             best one wins. Nothing left to take: it goes for your HQ
//   stage     an attack does not trickle in. The squad gathers `stageDist` out,
//             on the most CONCEALED open ground on its side, then goes in together
//   hold      a point it holds (or is taking) is held from the best cover and
//             concealment inside the zone, one man to a spot
//   leash     a man chasing a target further than `leash` from his post is
//             called back — or one jeep drives the whole garrison off the hill
//   retreat   a squad worn down to `retreatAt` of its strength, or badly
//             outnumbered, breaks off (holding fire, so combat cannot halt it
//             to shoot), goes home — the nearest safe tunnel, or the HQ — and
//             refills from recruits who come up right there
//
//   shelling  82 mm mortars dug in behind held points (`emplace`), each
//             dropping a round every `mortarReload` s on the thickest knot of
//             your men ITS OWN MEN CAN SEE, inside 28–130 m and never on its
//             own (the `fireMortar` hook → projectiles.spawnArc)
//   supply    a Molotova shuttling HQ → the forward point it holds; every run
//             that gets through pays `truckPay`, so the road between is worth
//             cutting (`truckKey`, `truckCost`, `truckMax`)
//   armour    a PT-76 bought at the HQ (not a tunnel — a tank does not climb
//             out of a hole) and attached to the squad that most needs one:
//             the one gathering for an attack, else the one nearest your HQ.
//             It holds the spot facing you while the men take the cover
//             (`armourKey`, `armourCost`, `armourMax`)
//   AA        a ZPU-4 dug in (the `emplace` hook, paid from its purse) at the
//             held point your helicopters were seen near — or, holding three
//             or more, at the most forward one; up in `zpuDigTime` s
//
// WHAT IT KNOWS is what it could see: your units near a point count only if
// one of its own men or buildings is within `seeRange` of them, and a sighting
// is remembered for `memory` seconds. It does not read your army from memory.
//
// DETERMINISTIC: it runs on the fixed sim clock and draws from a seeded
// random, never Math.random.
import { UNIT_COST } from "./resources.js";

export const ENEMY_AI = {
  tick: 1.0,            // seconds between decisions
  squadSize: 5,
  maxSquads: 8,
  startSquads: 3,       // on the field at the start (free)
  startingStock: 250,
  recruitTime: 3.0,     // seconds per man at the HQ
  incomeMul: 1.0,       // difficulty: multiplies what its points pay it
  retreatAt: 0.35,      // share of full strength left → fall back
  rejoinAt: 0.8,        // refilled to this share → back out
  outnumbered: 2.5,     // known enemy power this many times ours → fall back
  attackMargin: 1.3,    // our power must beat the known defence by this
  holdFor: 40,          // seconds a squad garrisons a point it took before it is free again
  stageDist: 70,
  stageWait: 30,        // gathered and still not strong enough: call it off after 3x this
  groupWait: 60,        // other squads still walking up to the stage: wait this long for them
  leash: 55,
  seeRange: 45,
  threatRadius: 40,
  memory: 60,
  pathBudget: 1500,     // A* cells expanded per sim step for the squads' queued searches (MEASURED 3,000 ≈ 2.3 ms)
  // ZPU-4s dug in at points it holds (the `emplace` hook).
  zpuCost: 220,
  zpuReserve: 100,      // kept back for recruits
  zpuMax: 5,
  zpuDigTime: 20,       // seconds from the first spade to the first burst
  zpuEvery: 5,          // seconds between decisions
  airMemory: 120,       // a helicopter seen near a point is remembered this long
  // 82 mm mortars behind its line (the `emplace` and `fireMortar` hooks).
  mortarCost: 180,
  mortarMax: 3,
  mortarDigTime: 18,
  mortarReload: 7,      // seconds between rounds
  mortarRange: 130,     // and it cannot drop one closer than mortarMin
  mortarMin: 28,
  mortarDamage: 34,
  mortarSplash: 9,
  // Armour: PT-76s, bought at the HQ and attached to squads.
  armourKey: "pt76",
  armourCost: 300,
  armourMax: 4,
  armourMinPoints: 2,   // it holds this much ground before it buys a tank
  armourEvery: 8,       // seconds between decisions
  // The cheap nasty kit (traps.js): pits and wire on the ways into what it
  // holds, a spider hole to cover them, caches in the rear that pay it. All of
  // it costs less than one rifleman and none of it can be seen until it is
  // walked into, which is the point.
  trapCost: 35,
  trapMax: 10,
  holeCost: 80,
  holeMax: 4,
  cacheCost: 110,
  cacheMax: 3,
  kitEvery: 11,         // seconds between decisions
  kitReserve: 60,       // never dug out of the last of the purse
  // Supply trucks: the Molotova's run pays when it gets through.
  truckKey: "molotova",
  truckCost: 120,
  truckMax: 2,
  truckPay: 170,        // per delivery — it repays itself on its second run
  truckDwell: 8,        // seconds unloading at the point
  truckEvery: 10,
};

export const DIFFICULTY = {
  easy:   { incomeMul: 0.7, recruitTime: 4.0, retreatAt: 0.45, attackMargin: 1.6 },
  normal: { incomeMul: 1.0, recruitTime: 3.0, retreatAt: 0.35, attackMargin: 1.3 },
  hard:   { incomeMul: 1.35, recruitTime: 2.2, retreatAt: 0.25, attackMargin: 1.1 },
};

/** A seeded random in [0, 1) — mulberry32. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What a unit is worth in a fight, in riflemen: its health over a rifleman's. */
const power = (u) => (u.alive ? u.hp / 60 : 0);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * `emplace(typeKey, x, z)`: dig a structure in, in play (namGame stamps its
 * nav and clears its pit) — returns it, with `deploy` 0 for this AI to bring
 * up. Optional: without it the commander builds nothing.
 */
export function createEnemyAI({
  units, structures, requisition, navGrid = null, cover = null, emplace = null, fireMortar = null,
  params = { ...ENEMY_AI }, seed = 1337, unitKey = "soldier",
}) {
  const rand = seeded(seed);
  const squads = [];
  let nextId = 1;
  let enabled = true;
  let clock = 0, tickT = 0, recruitT = 0;
  let stock = params.startingStock;
  let earnedTotal = 0;
  const forming = [];           // recruits waiting to make up a squad
  const known = new Map();      // point id → { power, t } last sighting
  const holdSpots = new Map();  // point id → [{x, z}] best-first
  const log = [];               // recent decisions, for the dev panel

  // First-use costs at BOOT, not in the fight: the region labels and the path
  // queue's own scratch (MEASURED 22.7 ms on one step 9 s into a game).
  navGrid?.sameRegion?.(0, 0, 0, 0);
  navGrid?.pumpPaths?.(0);

  const purse = {
    get stock() { return stock; },
    earn(n) { const k = n * params.incomeMul; stock += k; earnedTotal += k; },
    spend(n) { if (stock < n) return false; stock -= n; return true; },
  };

  const say = (msg) => { log.push(`${clock.toFixed(0).padStart(4)}s  ${msg}`); if (log.length > 12) log.shift(); };

  /**
   * WHAT IT IS SAVING FOR. Without this it never bought a tank: recruits cost
   * 50 every few seconds and drain the purse faster than seven points fill it,
   * so the 300 for a PT-76 was never on the table (MEASURED: 5 minutes, 7
   * points held, 0 tanks). So it plans like a player — men enough to hold the
   * line first, then armour — and everything cheaper waits rather than eating
   * the fund. `null` means nothing is being saved for: spend freely.
   */
  function plan() {
    const men = squads.reduce((n, s) => n + menOf(s).length, 0);
    if (men < params.squadSize * 2) return null;                 // two squads before anything
    const held = requisition.points.filter((p) => p.owner === "enemy").length;
    // A truck before a tank: it pays for itself and everything after it.
    if (params.truckKey && trucks.length < params.truckMax && held >= 1) {
      return { kind: "truck", cost: params.truckCost };
    }
    if (params.armourKey && allArmour() < params.armourMax && held >= params.armourMinPoints) {
      return { kind: "armour", cost: params.armourCost };
    }
    return null;
  }
  /** Can it spend `cost` on `kind` without robbing what it is saving for? */
  function canSpend(cost, kind) {
    if (stock < cost) return false;
    const p = plan();
    return !p || p.kind === kind || stock - cost >= p.cost;
  }
  const hq = () => (structures.enemyBase?.alive ? structures.enemyBase : null);
  const open = (x, z) => (navGrid ? navGrid.nearestOpenWorld(x, z) : { x, z });
  const living = (s) => s.members.filter((u) => u.alive);

  function centroid(s) {
    const m = living(s);
    if (!m.length) return null;
    let x = 0, z = 0;
    for (const u of m) { x += u.position.x; z += u.position.z; }
    return { x: x / m.length, z: z / m.length };
  }
  const squadPower = (s) => living(s).reduce((n, u) => n + power(u), 0);
  /** Its armour, and its men. A squad is men plus (sometimes) a tank riding with them. */
  const armourOf = (s) => living(s).filter((u) => u.typeKey === params.armourKey);
  const menOf = (s) => living(s).filter((u) => u.typeKey === unitKey);
  /**
   * The retreat gauge, counted on the MEN only: a tank is worth four riflemen
   * in `squadPower`, so counting it here would show a squad whose infantry is
   * dead as still fit to fight.
   */
  const strength = (s) => menOf(s).reduce((n, u) => n + power(u), 0) / params.squadSize;

  // ── Recruiting ─────────────────────────────────────────────────────────────
  function doorOf(base) {
    const r = (base.type?.navRadius ?? base.radius ?? 14) + 8;
    const ap = base.type?.doorApproach;
    return { x: base.position.x + (ap?.dirX ?? 0) * r, z: base.position.z + (ap?.dirZ ?? -1) * r };
  }
  function spawnMan(at, key = unitKey) {
    const u = units.spawn(key, at.x + (rand() - 0.5) * 6, at.z + (rand() - 0.5) * 6, { team: "enemy" });
    return u;
  }
  function makeSquad(members) {
    const s = { id: nextId++, members, state: "idle", point: null, since: clock, spots: null, stage: null };
    for (const u of members) u.squad = s;
    squads.push(s);
    return s;
  }
  // ── Tunnels: where the men come up ─────────────────────────────────────────
  const tunnels = () => structures.tunnels ?? [];
  /** A tunnel's mouth, on open ground a few metres off the shaft. */
  const mouthOf = (t) => open(t.position.x, t.position.z - 4);
  /** Nothing of yours seen within threatRadius of it. */
  const safeAt = (p) => visiblePowerAt(p.x, p.z, params.threatRadius) === 0;
  /**
   * Where recruits come up: the safe tunnel nearest YOUR HQ — the most forward
   * one — so a new squad starts at the front instead of a 400 m walk from the
   * résidence. No tunnel, or all of them watched: the HQ's door.
   */
  function musterPoint() {
    const target = structures.base?.position;
    let best = null, bestD = Infinity;
    for (const t of tunnels()) {
      if (!safeAt(t.position)) continue;
      const d = target ? dist(t.position, target) : 0;
      if (d < bestD) { bestD = d; best = t; }
    }
    if (best) return mouthOf(best);
    const base = hq();
    return base ? doorOf(base) : null;
  }
  /** Where a squad falls back to: the nearest safe tunnel if it beats the HQ. */
  function homeFor(s) {
    const c = centroid(s);
    const base = hq();
    let best = base ? doorOf(base) : c, bestD = base && c ? dist(c, best) : Infinity;
    if (!c) return best;
    for (const t of tunnels()) {
      if (!safeAt(t.position)) continue;
      const m = mouthOf(t), d = dist(c, m);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  function recruit(dt) {
    const base = hq();
    if (!base) return;
    const men = squads.reduce((n, s) => n + menOf(s).length, 0) + forming.filter((u) => u.alive).length;
    if (men >= params.maxSquads * params.squadSize) return;
    recruitT -= dt;
    if (recruitT > 0) return;
    const cost = UNIT_COST[unitKey] ?? 50;
    if (!canSpend(cost, "men") || !purse.spend(cost)) return;
    recruitT = params.recruitTime;
    // A squad at home refitting takes the recruit first — and he comes up
    // where it is waiting (its post IS a tunnel mouth or the HQ's door).
    const refit = squads.find((s) => s.state === "refit" && menOf(s).length < params.squadSize);
    const at = refit?.post ?? musterPoint();
    if (!at) return;
    const u = spawnMan(at);
    if (!u) return;
    if (refit) { refit.members.push(u); u.squad = refit; u.orderTo(at.x, at.z); return; }
    forming.push(u);
    u.orderTo(at.x + (rand() - 0.5) * 16, at.z - 6 - rand() * 10);
    const ready = forming.filter((m) => m.alive);
    if (ready.length >= params.squadSize) {
      forming.length = 0;
      const s = makeSquad(ready);
      say(`squad ${s.id} formed`);
    }
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  const _near = [];
  /** Is `u` (a player unit) seen by any of ours? */
  function seen(u) {
    for (const o of units.near(u.position.x, u.position.z, params.seeRange, _near)) {
      if (o.team === "enemy" && o.alive && dist(o.position, u.position) <= params.seeRange) return true;
    }
    for (const s of structures.list) {
      if (s.team === "enemy" && s.alive && dist(s.position, u.position) <= params.seeRange + (s.range ?? 0) * 0.5) return true;
    }
    return false;
  }
  /** Player power we can SEE around (x, z) right now. */
  function visiblePowerAt(x, z, r = params.threatRadius) {
    let n = 0;
    for (const u of units.near(x, z, r, _near)) {
      if (u.team !== "player" || !u.alive || u.isAir) continue;
      if (Math.hypot(u.position.x - x, u.position.z - z) > r) continue;
      if (seen(u)) n += power(u);
    }
    return n;
  }
  /** Is one of ours within `r` of (x, z)? */
  function watching(x, z, r) {
    for (const o of units.near(x, z, r, _near)) {
      if (o.team === "enemy" && o.alive && Math.hypot(o.position.x - x, o.position.z - z) <= r) return true;
    }
    return false;
  }
  /**
   * What we believe is defending point p. A sighting from the edge sees only
   * part of a defence, so the belief is the MOST seen lately (MEASURED: taking
   * the latest partial count sent a lone squad into ten men). It resets only
   * when men of ours stand ON the point and see the whole of it, and is
   * forgotten `memory` seconds after the last sighting.
   */
  function threatAt(p) {
    const now = visiblePowerAt(p.position.x, p.position.z);
    const k = known.get(p.id);
    const fresh = k && clock - k.t <= params.memory;
    if (watching(p.position.x, p.position.z, p.radius + 4)) {
      known.set(p.id, { power: now, t: clock });
      return now;
    }
    if (now > 0) {
      const v = Math.max(now, fresh ? k.power : 0);
      known.set(p.id, { power: v, t: clock });
      return v;
    }
    return fresh ? k.power : 0;
  }

  // ── Ground ─────────────────────────────────────────────────────────────────
  /** The best places to stand inside a point's zone: concealment and cover first. */
  function spotsFor(p) {
    let spots = holdSpots.get(p.id);
    if (spots) return spots;
    const cand = [];
    const R = Math.max(4, p.radius - 3);
    for (const r of [R * 0.35, R * 0.7, R]) {
      const n = Math.max(6, Math.round(r * 0.9));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r;
        const x = p.position.x + Math.cos(a) * r, z = p.position.z + Math.sin(a) * r;
        if (navGrid?.isBlockedAtWorld(x, z)) continue;
        const score = (cover?.concealmentAt?.(x, z) ?? 0) + 0.8 * (cover?.coverAt?.(x, z) ?? 0) + rand() * 0.02;
        cand.push({ x, z, score });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    spots = cand.length ? cand : [{ x: p.position.x, z: p.position.z, score: 0 }];
    holdSpots.set(p.id, spots);
    return spots;
  }

  /**
   * Where to gather before going in: `stageDist` out on our side, the most
   * concealed open ground that the squad can actually WALK to (an open cell on
   * a cliff-ringed shelf passes the blocked test and is never reached —
   * MEASURED: squads waited there for minutes). Every squad attacking the same
   * point gathers at ONE stage, or "together" means nothing.
   */
  function stagingFor(target, from, point = null) {
    if (point) {
      const other = attackers(point).find((o) => o.stage);
      if (other) return other.stage;
    }
    const dx = from.x - target.x, dz = from.z - target.z;
    const base = Math.atan2(dz, dx);
    const cand = [];
    for (let k = -4; k <= 4; k++) {
      const a = base + k * 0.25;
      const x = target.x + Math.cos(a) * params.stageDist, z = target.z + Math.sin(a) * params.stageDist;
      if (navGrid?.isBlockedAtWorld(x, z)) continue;
      cand.push({ x, z, score: (cover?.concealmentAt?.(x, z) ?? 0) - Math.abs(k) * 0.05 });
    }
    cand.sort((a, b) => b.score - a.score);
    // Reachable = same connected region (two lookups; a trial path search to
    // an unreachable spot floods the map — MEASURED 31 ms).
    for (const c of cand) {
      if (!navGrid?.sameRegion || navGrid.sameRegion(from.x, from.z, c.x, c.z)) return c;
    }
    return open(from.x + (target.x - from.x) * 0.5, from.z + (target.z - from.z) * 0.5);
  }

  // ── Orders ─────────────────────────────────────────────────────────────────
  /**
   * Send the squad's men to their own destinations along ONE path: searched
   * once from the squad's middle to (x, z), each man's copy ending on his own
   * spot. A search across the river is several ms, and five of them landed on
   * one frame. A man more than 15 m from the group searches his own.
   */
  //
  // The searches go through the nav grid's QUEUE (requestPath), which runs a
  // budget of cells a sim step: a search into the walled camp was 13–27 ms in
  // one frame. The men start a few frames later; nobody sees that. A newer
  // order for the squad cancels one still waiting.
  function orderSquad(s, x, z, dests, { holdFire = false } = {}) {
    const m = living(s);
    const c = centroid(s);
    for (const u of m) u.holdFire = holdFire;
    for (const j of s.pathJobs ?? []) j.cancel();
    s.pathJobs = [];
    if (!c || !navGrid?.requestPath) {
      m.forEach((u, i) => u.orderTo(dests[i].x, dests[i].z));
      return;
    }
    const near = m.filter((u) => dist(u.position, c) < 15);
    s.pathJobs.push(navGrid.requestPath(c.x, c.z, x, z, (shared) => {
      m.forEach((u, i) => {
        if (!u.alive || !near.includes(u)) return;
        const d = dests[i];
        if (shared?.length) u.orderTo(d.x, d.z, [...shared.slice(0, -1), { x: d.x, z: d.z }]);
      });
    }));
    // Stragglers: a search of their own each, queued too.
    m.forEach((u, i) => {
      if (near.includes(u)) return;
      const d = dests[i];
      s.pathJobs.push(navGrid.requestPath(u.position.x, u.position.z, d.x, d.z, (path) => {
        if (u.alive && path?.length) u.orderTo(d.x, d.z, path);
      }));
    });
  }
  function sendTo(s, x, z, spread = 5) {
    const m = living(s);
    orderSquad(s, x, z, m.map((u, i) => {
      const a = (i / m.length) * Math.PI * 2;
      return open(x + Math.cos(a) * spread, z + Math.sin(a) * spread);
    }));
    s.post = { x, z };
  }
  /** Each man to his own spot in the zone (squads sharing a point take different spots). */
  function takeSpots(s, p) {
    const spots = spotsFor(p);
    const sharing = squads.filter((o) => o !== s && o.point === p && (o.state === "hold" || o.state === "move"));
    const offset = (sharing.length * params.squadSize) % spots.length;
    // The tank stands where it can shoot: the spot of this squad's share that
    // faces YOUR side. Concealment is for the men; armour wants the field.
    const front = structures.base?.position;
    const mine = living(s);
    const picks = mine.map((u, i) => spots[(offset + i) % spots.length]);
    if (front) {
      const armour = mine.map((u, i) => (u.typeKey === params.armourKey ? i : -1)).filter((i) => i >= 0);
      if (armour.length) {
        const order = picks.map((sp, i) => ({ i, d: Math.hypot(sp.x - front.x, sp.z - front.z) }))
          .sort((a, b) => a.d - b.d);
        for (let k = 0; k < armour.length && k < order.length; k++) {
          const a = armour[k], b = order[k].i;
          [picks[a], picks[b]] = [picks[b], picks[a]];
        }
      }
    }
    s.spots = picks;
    orderSquad(s, p.position.x, p.position.z, s.spots);
    s.post = { x: p.position.x, z: p.position.z };
  }

  function setTask(s, state, point = null) {
    s.state = state; s.point = point; s.since = clock; s.stage = null; s.gatheredAt = null;
  }

  // ── Choosing ───────────────────────────────────────────────────────────────
  /** Has squad `o` gathered at its stage — most of its men within reach of it? */
  const atStage = (o) => {
    const m = living(o);
    return !!o.stage && m.filter((u) => dist(u.position, o.stage) <= 18).length >= Math.ceil(m.length * 0.6);
  };
  /** Squads other than `s` gathering for, or going in on, point p. */
  const attackers = (p, s = null) =>
    squads.filter((o) => o !== s && o.point === p && (o.state === "stage" || o.state === "assault" || o.state === "withdraw"));
  /** How much squad `s` (at `c`, worth `P`) wants point p, or -Infinity. Exported for the test. */
  function scorePoint(s, c, P, p) {
    const T = threatAt(p);
    const claimed = squads.filter((o) => o !== s && o.point === p && o.state !== "retreat" && o.state !== "refit").length;
    const d = dist(c, p.position) / 400;
    let score;
    if (p.owner === "enemy") {
      if (T > 0) score = 3.2;                               // ours, and threatened: relieve it
      else if (claimed === 0) score = 1.0;                  // ours, unguarded: garrison it
      else return -Infinity;
    } else if (p.owner === null) {
      if (T > 0 && P < T * params.attackMargin) return -Infinity;
      score = 2.6 - (p.progress < 0 ? -p.progress * 0.5 : 0) + (p.progress > 0 ? 0.3 : 0);
    } else {
      // Theirs. Only with enough men for what we know is on it — counting the
      // squads already gathering for it, and the ones standing idle who would
      // come (they score this same attack next, with us counted as allies).
      // Help that can come: idle squads, and garrisons of points nobody is
      // threatening (they come free after holdFor and join the attack under
      // way). Counting only idle squads, MEASURED: an AI holding all seven
      // points, every squad on a quiet hill, never attacked the HQ at all.
      const allies = attackers(p, s).reduce((n, o) => n + squadPower(o), 0);
      const idle = squads.filter((o) => o !== s && (o.state === "idle" ||
        (o.state === "hold" && o.point && o.point !== p && threatAt(o.point) === 0)))
        .reduce((n, o) => n + squadPower(o), 0);
      if (P + allies + idle < T * params.attackMargin) return -Infinity;
      score = 2.2 + (T === 0 ? 0.4 : 0) + (allies > 0 ? 0.6 : 0);  // join an attack under way
      return score - d - Math.max(0, claimed - 2) * 1.2;
    }
    return score - d - claimed * 1.2;
  }

  /**
   * The player's HQ as one more objective, run through the SAME machinery as
   * a point — gather out of sight, weigh what is defending it, go in together.
   * It had its own "send a squad at it" branch, and MEASURED over ten minutes
   * that fed it one squad at a time, each worn down in turn.
   */
  const hqObjective = {
    // radius 34: its hold spots ring OUTSIDE the HQ's 24 m nav footprint.
    id: "hq", letter: "HQ", name: "the HQ", radius: 34, progress: 1,
    get position() { return structures.base.position; },
    get owner() { return structures.base?.alive ? "player" : null; },
  };
  function objectives() {
    const pts = requisition.points;
    // Only once it holds at least half the map: the HQ is the last objective.
    const held = pts.filter((p) => p.owner === "enemy").length;
    return structures.base?.alive && held >= Math.ceil(pts.length / 2) ? [...pts, hqObjective] : pts;
  }

  function choose(s) {
    const c = centroid(s);
    if (!c) return;
    const P = squadPower(s);
    let best = null, bestScore = -Infinity;
    for (const p of objectives()) {
      if (s.avoid?.point === p && clock < s.avoid.until) continue;
      // The HQ scores below any point: points first, then the HQ.
      const sc = scorePoint(s, c, P, p) - (p === hqObjective ? 0.8 : 0);
      if (sc > bestScore) { bestScore = sc; best = p; }
    }
    if (!best) return;
    if (best.owner === "player") {
      setTask(s, "stage", best);
      s.stage = stagingFor(best.position, c, best);
      sendTo(s, s.stage.x, s.stage.z, 6);
      say(`squad ${s.id} → attack ${best.name} (stage)`);
    } else {
      setTask(s, "move", best);
      takeSpots(s, best);
      say(`squad ${s.id} → ${best.owner === "enemy" ? "hold" : "take"} ${best.name}`);
    }
  }

  // ── Driving each squad ─────────────────────────────────────────────────────
  function retreat(s, why) {
    const home = homeFor(s);
    setTask(s, "retreat");
    const m = living(s);
    // Stop where they stand until the path comes: no targets, no chasing.
    for (const u of m) { u.target = null; u.attackTarget = null; u.stop?.(); }
    orderSquad(s, home.x, home.z, m.map(() => ({ x: home.x + (rand() - 0.5) * 12, z: home.z - rand() * 10 })), { holdFire: true });
    s.post = home;
    say(`squad ${s.id} falls back (${why})`);
  }

  function leash(s) {
    if (!s.post) return;
    living(s).forEach((u, i) => {
      if (!(u.target || u.attackTarget)) return;
      if (dist(u.position, s.post) <= params.leash) return;
      const back = s.spots?.[i] ?? s.post;
      u.moveOrder(back.x, back.z);
    });
  }

  function drive(s) {
    const m = living(s);
    if (!m.length) return;
    const c = centroid(s);
    const P = squadPower(s);

    // Falling back beats everything but a retreat already under way.
    if (s.state !== "retreat" && s.state !== "refit") {
      if (strength(s) < params.retreatAt && m.some((u) => u.target)) return retreat(s, "worn down");
      // (An assault that meets too much pulls back to its stage instead, below —
      // it is 70 m away, where home is 400 m of open ground under fire.)
      const around = visiblePowerAt(c.x, c.z, params.threatRadius);
      if (s.state !== "assault" && around > P * params.outnumbered && P < params.squadSize * 0.9) return retreat(s, "outnumbered");
    }

    switch (s.state) {
      case "idle": choose(s); break;

      case "move": {
        const p = s.point;
        if (p.owner === "player") { setTask(s, "idle"); choose(s); break; }
        const inZone = m.filter((u) => dist(u.position, p.position) <= p.radius).length;
        if (inZone >= Math.ceil(m.length * 0.6)) setTask(s, "hold", p);
        leash(s);
        break;
      }

      case "hold": {
        const p = s.point;
        // Lost it while holding (pulled to neutral or theirs): fight for it again.
        if (p.owner === "player") { setTask(s, "idle"); choose(s); break; }
        // Men who wandered or got shoved back to their spots — not while
        // fighting, at most every 5 s each (a man who cannot get there was
        // re-ordered EVERY tick: MEASURED 23–28 ms a step, seconds on end), and
        // only a short way: men far off rejoin with the squad's shared path.
        if (!s.spots || s.spots.length !== m.length) takeSpots(s, p);
        else {
          let far = 0;
          m.forEach((u, i) => {
            if (u.target || u.isMoving || (u._aiReorderAt ?? -1e9) > clock - 5) return;
            const sp = s.spots[i];
            const d = Math.hypot(u.position.x - sp.x, u.position.z - sp.z);
            if (d > 40) far++;
            else if (d > 4) { u._aiReorderAt = clock; u.orderTo(sp.x, sp.z); }
          });
          if (far && clock - (s.regroupAt ?? -1e9) > 15) { s.regroupAt = clock; takeSpots(s, p); }
        }
        leash(s);
        // Held and quiet long enough: free to go elsewhere (it may well choose to stay).
        if (p.owner === "enemy" && clock - s.since > params.holdFor && threatAt(p) === 0) {
          const others = squads.filter((o) => o !== s && (o.state === "idle" || o.state === "move")).length;
          if (others === 0 || rand() < 0.5) { setTask(s, "idle"); s.point = null; }
          else s.since = clock;
        }
        break;
      }

      case "stage": {
        if (!s.point || s.point.owner !== "player") { setTask(s, "idle"); break; }
        {
          // Go in together, and only with enough: every squad GATHERED for this
          // point counts, against what we know is on it now.
          if (!atStage(s)) {
            if (clock - s.since > 120) {
              // Not this objective again for a minute: it re-chose the same
              // unreachable stage at once, a long path search each time.
              s.avoid = { point: s.point, until: clock + 60 };
              setTask(s, "idle"); say(`squad ${s.id} never reached its stage`);
            }
            break;
          }
          s.gatheredAt ??= clock;
          const gathered = [s, ...attackers(s.point, s)].filter((o) => o.state === "stage" && atStage(o));
          const power = gathered.reduce((n, o) => n + squadPower(o), 0);
          const T = threatAt(s.point);
          // Everyone called to this attack goes in together: wait for squads
          // still on their way (up to groupWait) — one squad going in blind
          // while two more walked up was MEASURED as a squad lost for nothing.
          const coming = attackers(s.point, s).filter((o) => o.state === "stage" && !atStage(o)).length;
          const waitedHere = clock - s.gatheredAt;
          if (power >= T * params.attackMargin && waitedHere > 3 && (coming === 0 || waitedHere > params.groupWait)) {
            for (const o of gathered) { o.state = "assault"; o.since = clock; o.gatheredAt = null; takeSpots(o, s.point); }
            say(`squad${gathered.length > 1 ? "s " + gathered.map((o) => o.id).join("+") : " " + s.id} go in on ${s.point.name}`);
          } else if (clock - s.gatheredAt > params.stageWait * 3) {
            say(`squad ${s.id} calls off ${s.point.name} (too strong)`);
            s.avoid = { point: s.point, until: clock + 60 };
            setTask(s, "idle");
          }
        }
        break;
      }

      case "assault": {
        if (s.point) {
          if (s.point === hqObjective && s.point.owner !== "player") { setTask(s, "idle"); break; }   // it fell
          if (s.point.owner !== "player") { setTask(s, "move", s.point); takeSpots(s, s.point); break; }
          // Walked into more than was known (the stage is out of sight of the
          // point, so the first go is a probe): break it off before it is a
          // massacre — back to the stage, holding fire, knowing now what is
          // there, to wait for help or call it off.
          // "More than was known" = more than it would have agreed to attack.
          const group = [s, ...attackers(s.point, s)].reduce((n, o) => n + squadPower(o), 0);
          if (visiblePowerAt(s.point.position.x, s.point.position.z) * params.attackMargin > group * 1.5 && s.stage) {
            s.state = "withdraw"; s.since = clock;
            for (const u of m) { u.target = null; u.attackTarget = null; u.stop?.(); }
            orderSquad(s, s.stage.x, s.stage.z, m.map(() => ({ x: s.stage.x + (rand() - 0.5) * 10, z: s.stage.z + (rand() - 0.5) * 10 })), { holdFire: true });
            say(`squad ${s.id} repulsed at ${s.point.name}, pulls back`);
            break;
          }
          leash(s);
        } else setTask(s, "idle");
        break;
      }

      case "withdraw": {
        if (dist(c, s.stage) < 18 || clock - s.since > 30) {
          for (const u of m) u.holdFire = false;
          s.state = "stage"; s.since = clock;
        }
        break;
      }

      case "retreat": {
        if (!s.post || dist(c, s.post) < 20) {
          for (const u of m) u.holdFire = false;
          s.state = "refit"; s.since = clock;
        }
        break;
      }

      case "refit": {
        if (menOf(s).length / params.squadSize >= params.rejoinAt && strength(s) >= params.rejoinAt * 0.8) {
          setTask(s, "idle");
          say(`squad ${s.id} back in the fight`);
        }
        break;
      }
    }
  }

  // ── AA: where your helicopters have been seen, and ZPUs dug in there ──────
  const airSeen = new Map();   // point id → last time a helicopter of yours was seen near it
  let zpuT = 0;
  function watchTheSky() {
    for (const u of units.list) {
      if (!u.alive || !u.isAir || u.team !== "player" || !seen(u)) continue;
      let best = null, bd = 150;
      for (const p of requisition.points) { const d = dist(u.position, p.position); if (d < bd) { bd = d; best = p; } }
      if (best) airSeen.set(best.id, clock);
    }
  }
  const zpuNear = (p, r = 35) => (structures.zpus ?? []).some((z) => dist(z.position, p) < r);
  /** Dig a ZPU in at the held point that most needs one — if there is one, and the money. */
  function digInAA() {
    if (!emplace || !hq()) return;
    if ((structures.zpus ?? []).length >= params.zpuMax) return;
    if (purse.stock < params.zpuCost + params.zpuReserve || !canSpend(params.zpuCost, "zpu")) return;
    const held = requisition.points.filter((p) => p.owner === "enemy");
    const front = structures.base?.position;
    // Without a helicopter seen, AA "just in case" stays thin: about one gun
    // per three points held (the HQ's own counts). Seen helicopters are a reason.
    const spare = (structures.zpus ?? []).length < Math.floor(held.length / 3) + 1;
    let best = null, bestScore = 0;
    for (const p of held) {
      if (zpuNear(p.position) || !safeAt(p.position)) continue;
      const air = clock - (airSeen.get(p.id) ?? -1e9) <= params.airMemory;
      if (!air && (held.length < 3 || !spare)) continue;
      // Helicopters seen there first; then the point nearest your HQ (the front).
      const score = (air ? 3 : 1) + (front ? 1 - Math.min(1, dist(p.position, front) / 800) : 0);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) return;
    // Its pit: 11–16 m off the mast, open ground you can walk to, clear of
    // other works, the most concealed of those.
    let site = null;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 + rand() * 0.4, r = 11 + rand() * 5;
      const x = best.position.x + Math.cos(a) * r, z = best.position.z + Math.sin(a) * r;
      if (navGrid?.isBlockedAtWorld(x, z)) continue;
      if (navGrid?.sameRegion && !navGrid.sameRegion(x, z, best.position.x, best.position.z)) continue;
      if (structures.list.some((s) => s.alive && dist(s.position, { x, z }) < 9)) continue;
      const score = (cover?.concealmentAt?.(x, z) ?? 0) + rand() * 0.05;
      if (!site || score > site.score) site = { x, z, score };
    }
    if (!site || !purse.spend(params.zpuCost)) return;
    const s = emplace("zpu", site.x, site.z);
    if (s) say(`ZPU-4 dug in at ${best.name}`);
  }

  // ── Mortars: shelling ground its own men have eyes on ─────────────────────
  const _barrage = [];
  /**
   * Where this tube should drop its next round: the thickest knot of your men
   * it can SEE, inside its arc (mortarMin..mortarRange) and clear of its own.
   * It aims where they are, not where they will be — a mortar is for ground
   * you have to hold, and moving off it is the answer.
   */
  function aimPoint(m) {
    const near = units.near(m.position.x, m.position.z, params.mortarRange, _barrage);
    let best = null, bestN = 0;
    for (const u of near) {
      if (u.team !== "player" || !u.alive || u.isAir) continue;
      const d = dist(u.position, m.position);
      if (d > params.mortarRange || d < params.mortarMin) continue;
      if (!seen(u)) continue;
      let n = 0, mine = false;
      for (const o of near) {
        if (!o.alive || o.isAir) continue;
        const dd = dist(o.position, u.position);
        if (dd > params.mortarSplash) continue;
        if (o.team === "player") n++;
        else if (o.team === "enemy") mine = true;           // never on its own men
      }
      if (!mine && n > bestN) { bestN = n; best = u; }
    }
    return best ? { x: best.position.x, z: best.position.z, men: bestN } : null;
  }
  function workTheTubes(dt) {
    if (!fireMortar) return;
    for (const m of structures.mortars ?? []) {
      if ((m.deploy ?? 1) < 1) continue;
      m.reload = (m.reload ?? rand() * params.mortarReload) - dt;
      if (m.reload > 0) continue;
      const at = aimPoint(m);
      if (!at) { m.reload = 1.5; continue; }               // nothing seen: look again shortly
      m.turretYaw = Math.atan2(at.x - m.position.x, at.z - m.position.z);
      fireMortar(m, at.x, at.z, { damage: params.mortarDamage, splash: params.mortarSplash });
      m.reload = params.mortarReload;
    }
  }
  /** Dig a tube in BEHIND a held point — away from your HQ, where it can work unseen. */
  function digInMortar() {
    if (!emplace || !hq()) return;
    if ((structures.mortars ?? []).length >= params.mortarMax) return;
    if (purse.stock < params.mortarCost + params.zpuReserve || !canSpend(params.mortarCost, "mortar")) return;
    const held = requisition.points.filter((p) => p.owner === "enemy");
    if (held.length < 2) return;
    const front = structures.base?.position;
    let best = null, bestD = Infinity;
    for (const p of held) {
      if ((structures.mortars ?? []).some((m) => dist(m.position, p.position) < 60)) continue;
      const d = front ? dist(p.position, front) : 0;        // the point nearest you: the one being fought over
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) return;
    // Its pit: 14–22 m on the far side of the point from your HQ.
    const away = front
      ? Math.atan2(best.position.x - front.x, best.position.z - front.z)
      : rand() * Math.PI * 2;
    let site = null;
    for (let k = 0; k < 10; k++) {
      const a = away + (rand() - 0.5) * 1.2, r = 14 + rand() * 8;
      const x = best.position.x + Math.sin(a) * r, z = best.position.z + Math.cos(a) * r;
      if (navGrid?.isBlockedAtWorld(x, z)) continue;
      if (navGrid?.sameRegion && !navGrid.sameRegion(x, z, best.position.x, best.position.z)) continue;
      if (structures.list.some((s) => s.alive && dist(s.position, { x, z }) < 9)) continue;
      const score = (cover?.concealmentAt?.(x, z) ?? 0) + rand() * 0.05;
      if (!site || score > site.score) site = { x, z, score };
    }
    if (!site || !purse.spend(params.mortarCost)) return;
    if (emplace("mortar", site.x, site.z)) say(`mortar dug in behind ${best.name}`);
  }

  // ── The cheap nasty kit ───────────────────────────────────────────────────
  // Everything the Front can dig with a spade. It lays it where you have to
  // walk: pits and wire on the side of its points that FACES your HQ, spider
  // holes beside them to shoot whoever stops to look, and rice caches on the
  // far side, in its own rear, where they can pay for a while before you find
  // them. Cheap enough to come out of spare change, capped so the map never
  // turns into a minefield.
  let kitT = 0;
  const countOf = (key) => structures.list.filter((s) => s.alive && s.typeKey === key).length;
  /** A buildable spot near `p`, `r0`..`r1` out, on the bearing `aim` ± spread. */
  function digSite(p, aim, spread, r0, r1, tries = 10) {
    let site = null;
    for (let k = 0; k < tries; k++) {
      const a = aim + (rand() - 0.5) * spread, r = r0 + rand() * (r1 - r0);
      const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
      if (navGrid?.isBlockedAtWorld(x, z)) continue;
      if (navGrid?.sameRegion && !navGrid.sameRegion(x, z, p.x, p.z)) continue;
      if (structures.list.some((s) => s.alive && dist(s.position, { x, z }) < 8)) continue;
      const score = (cover?.concealmentAt?.(x, z) ?? 0) + rand() * 0.05;
      if (!site || score > site.score) site = { x, z, score };
    }
    return site;
  }
  function layCheapKit() {
    if (!emplace || !hq()) return;
    const held = requisition.points.filter((p) => p.owner === "enemy");
    if (!held.length) return;
    // Whichever part of the kit is furthest from its cap goes down next, so it
    // does not lay ten pits before the first hole.
    const want = [
      { kind: "trap", n: countOf("punji") + countOf("boobyTrap"), max: params.trapMax, cost: params.trapCost },
      { kind: "spiderHole", n: countOf("spiderHole"), max: params.holeMax, cost: params.holeCost },
      { kind: "cache", n: countOf("cache"), max: params.cacheMax, cost: params.cacheCost },
    ].filter((w) => w.n < w.max).sort((a, b) => a.n / a.max - b.n / b.max);
    const pick = want.find((w) => purse.stock >= w.cost + params.kitReserve && canSpend(w.cost, "kit"));
    if (!pick) return;

    const front = structures.base?.position;
    const bearing = (p, toward) => (front
      ? Math.atan2((toward ? front.x - p.x : p.x - front.x), (toward ? front.z - p.z : p.z - front.z))
      : rand() * Math.PI * 2);
    let best = null, bestD = pick.kind === "cache" ? -Infinity : Infinity;
    for (const p of held) {
      const d = front ? dist(p.position, front) : 0;
      // Traps go on the point closest to you; a cache on the one furthest away.
      if (pick.kind === "cache" ? d > bestD : d < bestD) { bestD = d; best = p; }
    }
    if (!best) return;
    const toward = pick.kind !== "cache";
    const site = digSite(best.position, bearing(best.position, toward), toward ? 1.5 : 1.1,
      toward ? 12 : 14, toward ? 26 : 28);
    if (!site || !purse.spend(pick.cost)) return;
    const typeKey = pick.kind === "trap" ? (rand() < 0.62 ? "punji" : "boobyTrap") : pick.kind;
    const s = emplace(typeKey, site.x, site.z);
    if (s) say(`${typeKey === "cache" ? "cache hidden behind" : typeKey === "spiderHole" ? "hole dug at" : "trap laid on the way into"} ${best.name}`);
  }

  // ── Supply trucks ─────────────────────────────────────────────────────────
  // A Molotova shuttles between the HQ and the forward point it holds. Each
  // run that GETS THROUGH pays — so the road between their base and the front
  // is worth watching, and a truck burning on it is supplies they never got.
  const trucks = [];          // { unit, state: "out" | "unload" | "back", t, point }
  let truckT = 0;
  /** Send one unit somewhere on a queued path (the budget, not a search now). */
  function sendUnit(u, x, z) {
    if (!navGrid?.requestPath) { u.orderTo(x, z); return; }
    navGrid.requestPath(u.position.x, u.position.z, x, z, (path) => {
      if (u.alive) u.orderTo(x, z, path?.length ? path : null);
    });
  }
  /** The point it is running to: the one it holds nearest YOUR HQ — the front. */
  function forwardHeld() {
    const front = structures.base?.position;
    let best = null, bd = Infinity;
    for (const p of requisition.points) {
      if (p.owner !== "enemy") continue;
      const d = front ? dist(p.position, front) : 0;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function buyTruck() {
    const base = hq();
    if (!base || !params.truckKey) return;
    if (trucks.length >= params.truckMax || !forwardHeld()) return;
    if (!canSpend(params.truckCost, "truck") || !purse.spend(params.truckCost)) return;
    const u = spawnMan(doorOf(base), params.truckKey);
    if (!u) return;
    trucks.push({ unit: u, state: "out", t: 0, point: null });
    say("a Molotova rolls out");
  }
  function runTrucks(dt) {
    for (let i = trucks.length - 1; i >= 0; i--) {
      const tr = trucks[i];
      const u = tr.unit;
      if (!u.alive) { trucks.splice(i, 1); say("supply truck destroyed"); continue; }
      const base = hq();
      if (tr.state === "out") {
        const to = forwardHeld();
        if (!to) { tr.state = "back"; continue; }
        if (tr.point !== to) { tr.point = to; sendUnit(u, to.position.x, to.position.z); }
        else if (dist(u.position, to.position) < 14) { tr.state = "unload"; tr.t = params.truckDwell; }
        else if (!u.isMoving) sendUnit(u, to.position.x, to.position.z);
      } else if (tr.state === "unload") {
        tr.t -= dt;
        if (tr.t > 0) continue;
        purse.earn(params.truckPay);
        say(`supplies delivered to ${tr.point?.name ?? "the front"}`);
        tr.state = "back";
        if (base) sendUnit(u, doorOf(base).x, doorOf(base).z);
      } else {
        if (!base) { tr.state = "out"; tr.point = null; continue; }
        const home = doorOf(base);
        if (dist(u.position, home) < 16) { tr.state = "out"; tr.point = null; }
        else if (!u.isMoving) sendUnit(u, home.x, home.z);
      }
    }
  }

  // ── Armour ────────────────────────────────────────────────────────────────
  let armourT = 0;
  const allArmour = () => squads.reduce((n, s) => n + armourOf(s).length, 0);
  /**
   * Buy a PT-76 and send it to the squad that most needs one. It comes out of
   * the HQ — not a tunnel; a tank does not climb out of a hole — and drives to
   * join them (orderSquad gives a straggler its own path). Preference: a squad
   * gathering for an attack first, then the squad nearest YOUR HQ, so armour
   * goes where the fighting is instead of guarding a quiet hill.
   */
  function buyArmour() {
    const base = hq();
    if (!base || !params.armourKey) return;
    if (allArmour() >= params.armourMax) return;
    if (!canSpend(params.armourCost, "armour")) return;
    const held = requisition.points.filter((p) => p.owner === "enemy").length;
    if (held < params.armourMinPoints) return;
    const front = structures.base?.position;
    const want = squads.filter((s) => armourOf(s).length === 0 && menOf(s).length >= 2
      && s.state !== "retreat" && s.state !== "refit");
    if (!want.length) return;
    const rank = (s) => {
      const c = centroid(s);
      const staging = s.state === "stage" || s.state === "assault" ? -1000 : 0;
      return staging + (c && front ? Math.hypot(c.x - front.x, c.z - front.z) : 1e6);
    };
    want.sort((a, b) => rank(a) - rank(b));
    const s = want[0];
    if (!purse.spend(params.armourCost)) return;
    const u = spawnMan(doorOf(base), params.armourKey);
    if (!u) return;
    s.members.push(u);
    u.squad = s;
    u.orderTo(s.post?.x ?? doorOf(base).x, s.post?.z ?? doorOf(base).z);
    say(`PT-76 joins squad ${s.id}`);
  }

  function prune() {
    for (let i = squads.length - 1; i >= 0; i--) {
      const s = squads[i];
      s.members = s.members.filter((u) => u.alive);
      if (!s.members.length) { squads.splice(i, 1); say(`squad ${s.id} wiped out`); }
    }
    // Two remnants refitting at home become one squad.
    const refit = squads.filter((s) => s.state === "refit");
    while (refit.length >= 2 && refit[0].members.length + refit[1].members.length <= params.squadSize) {
      const [a, b] = refit;
      for (const u of b.members) { a.members.push(u); u.squad = a; }
      squads.splice(squads.indexOf(b), 1);
      refit.splice(1, 1);
    }
  }

  /** The opening army: `startSquads` squads at the HQ door, free. */
  function deploy() {
    const base = hq();
    if (!base) return false;
    const door = doorOf(base);
    for (let k = 0; k < params.startSquads; k++) {
      const men = [];
      for (let i = 0; i < params.squadSize; i++) {
        const u = spawnMan({ x: door.x + (k - (params.startSquads - 1) / 2) * 14, z: door.z - 8 });
        if (u) men.push(u);
      }
      if (men.length) makeSquad(men);
    }
    say(`${params.startSquads} squads deployed`);
    return true;
  }
  let deployed = false;

  /** FIXED-STEP. */
  function step(dt) {
    if (!enabled) return;
    clock += dt;
    // The queued searches (orderSquad): a budget of cells a step — ~1 ms,
    // where one search into the camp was 13–27 ms at once.
    navGrid?.pumpPaths?.(params.pathBudget);
    if (!deployed) deployed = deploy();
    recruit(dt);
    // Works being dug in come up over their dig time (they hold fire till then).
    for (const z of structures.zpus ?? []) if ((z.deploy ?? 1) < 1) z.deploy = Math.min(1, z.deploy + dt / params.zpuDigTime);
    for (const m of structures.mortars ?? []) if ((m.deploy ?? 1) < 1) m.deploy = Math.min(1, m.deploy + dt / params.mortarDigTime);
    workTheTubes(dt);
    tickT -= dt;
    if (tickT <= 0) { tickT = params.tick; prune(); watchTheSky(); }
    zpuT -= dt;
    if (zpuT <= 0) { zpuT = params.zpuEvery; digInAA(); digInMortar(); }
    kitT -= dt;
    if (kitT <= 0) { kitT = params.kitEvery; layCheapKit(); }
    armourT -= dt;
    if (armourT <= 0) { armourT = params.armourEvery; buyArmour(); }
    runTrucks(dt);
    truckT -= dt;
    if (truckT <= 0) { truckT = params.truckEvery; buyTruck(); }
    // Each squad thinks once a tick, but on ITS OWN step of it, not all on the
    // same one: a squad's orders cost a path search per man, and MEASURED with
    // nine squads that was 3.2 ms landing in one frame every second — a hitch.
    // Spread by id over the tick, it is a squad a few frames apart.
    for (const s of [...squads]) {
      s.thinkT = (s.thinkT ?? ((s.id * 0.137) % 1) * params.tick) - dt;
      if (s.thinkT > 0) continue;
      s.thinkT += params.tick;
      if (s.members.some((u) => u.alive)) drive(s);
    }
  }

  return {
    step,
    purse,
    squads,
    params,
    get log() { return log; },
    get enabled() { return enabled; },
    setEnabled(on) { enabled = !!on; },
    setDifficulty(name) { Object.assign(params, DIFFICULTY[name] ?? DIFFICULTY.normal); },
    get earned() { return earnedTotal; },
    /** For the dev panel: one line per squad. */
    summary() {
      return squads.map((s) => `S${s.id} ${s.state}${s.point ? " " + s.point.name : ""} ${menOf(s).length}/${params.squadSize}${armourOf(s).length ? "+" + armourOf(s).length + "T" : ""} ${(strength(s) * 100) | 0}%`);
    },
    // Exposed for tests.
    _scorePoint: scorePoint,
    _threatAt: threatAt,
  };
}
