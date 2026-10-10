// THE FRENCH COMMANDER (2026-10-10, "play the FLN", step 2b) — the company's AI when YOU are the
// FLN (?side=fln). Not the katiba's war turned round: the French HOLD ground. A captain who
//
//   BUILDS    from the post's card (squads of appelés, an FM team every third, paras once the
//             helipad is open) and the motor pool (a jeep, then half-tracks) — within the pop cap,
//             the purse paying as yours does; buys the tiers when their villages are held;
//   TAKES     the nearest point not his (villages first), a squad to each — two where FLN men are
//             seen inside or the FLN holds it;
//   HOLDS     a held village keeps a squad, in a house when there is a free one (algGarrison.js);
//   RETAKES   a point of his losing its needle, or with FLN men seen in it: two squads at once;
//   DEFENDS   the post under fire: everyone within 160 m comes back;
//   PULLS BACK a squad under 40% (algSquads.js retreat) — reinforced at the post, then free again;
//   CALLS     the T-6 (algAirStrike.js) on a knot of FLN men seen away from his own;
//   ASSAULTS  the cave once he has the squads to spare (and the clock says so).
//
// He sees what his men see — no more: an FLN man is KNOWN within 16 m of a French unit, or 40 m
// when he moves or fires (the scrub ambush works on him as it does on you). Re-plans each second.
import { SQUADS } from "./algSquads.js";

const P = {
  tick: 1,
  squadsMax: 6,          // infantry squads kept in the field (algDifficulty.js sets it)
  vehiclesMax: 2,
  firstVehicleAt: 150,   // s
  tierAt: [0, 240, 480], // s before tier 2 / 3 (their villages and price still needed)
  assaultAt: 5,          // squads in hand before the cave
  assaultFrom: 420,      // s
  retreatBelow: 0.4,
  ring: 7,               // m: men round a point
  sight: 40, closeSight: 16,
  defendR: 160,
  airMin: 4, airR: 20, airEvery: 75, airSafe: 28, airMun: 120,
  holdHouseR: 30,
};

export function createAlgFrenchAI(app, { units, squads, economy, producers, tiers = null, garrison = null, airStrike = null }) {
  const prod = (k) => producers.find((p) => p.structure.typeKey === k) ?? null;
  const post = prod("post"), pool = prod("motorPool"), pad = prod("helipad"), cave = prod("caveEntrance");
  const home = post?.centre ?? post?.structure.position ?? { x: 0, z: 0 };
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const tasks = new Map();     // squad → { kind, at, point, since, orderedAt, quietSince }
  const vTasks = new Map();    // vehicle → { at, orderedAt }
  const lastValue = new Map(); // point → its needle a second ago
  let clock = 0, acc = 0, built = 0, lastAir = -1e9, postHp = post?.structure.hp ?? 0, postHitAt = -1e9;

  const mine = (u) => u.alive && u.team === "player";
  const strength = (s) => s.members.length / ((SQUADS[s.typeKey]?.size ?? s.members.length) || 1);
  const centreOf = (s) => {
    let x = 0, z = 0;
    for (const u of s.members) { x += u.position.x; z += u.position.z; }
    return { x: x / s.members.length, z: z / s.members.length };
  };

  /** FLN men a French unit can see now. */
  function knownFln() {
    const eyes = units.list.filter((u) => mine(u) && !u.inside);
    for (const p of producers) if (p.structure.team === "player" && p.structure.alive) eyes.push(p.structure);
    const out = [];
    for (const u of units.list) {
      if (!u.alive || u.team !== "enemy" || u.inside || u.isStructure) continue;
      const r = u.isMoving || u.target ? P.sight : P.closeSight;
      if (eyes.some((e) => Math.abs(e.position.x - u.position.x) < r && Math.abs(e.position.z - u.position.z) < r && dist(e.position, u.position) < r)) out.push(u);
    }
    return out;
  }
  const flnNear = (known, at, r) => known.filter((u) => dist(u.position, at) < r).length;

  function order(s, at, k = 0) {
    s.members.forEach((u, i) => {
      if (u.garrison) garrison?.exit?.(u, 2);
      const a = i * 2.39996 + s.id * 0.7 + k, r = i === 0 ? 1.5 : P.ring * (0.45 + 0.55 * ((i % 3) / 2));
      u.holdFire = false;
      u.orderTo(at.x + Math.cos(a) * r, at.z + Math.sin(a) * r);
    });
  }
  function assign(s, kind, at, point = null) {
    const prev = tasks.get(s);
    if (prev && prev.kind === kind && prev.point === point && dist(prev.at, at) < 3) return;
    tasks.set(s, { kind, at: { x: at.x, z: at.z }, point, since: clock, orderedAt: clock, quietSince: clock });
    order(s, at);
    // Holding a village: a free house in it, when there is one.
    if (kind === "hold" && garrison?.houseNear) {
      const h = garrison.houseNear(at.x, at.z, P.holdHouseR, "player", s.members.length);
      if (h) garrison.order(s.members, h, { ai: true });
    }
  }

  // ── PRODUCTION ──────────────────────────────────────────────────────────
  function produce(mySquads) {
    const queued = (p) => (p?.structure.queue.length ?? 0);
    const inQueue = (p) => (p?.structure.queue ?? []).filter((k) => SQUADS[k]).length;
    const infantry = mySquads.length + inQueue(post) + inQueue(pad);
    // (The company grows as the war goes on — a squad more every 3 minutes, up to four — and when
    // the effectifs pile up.)
    const cap = P.squadsMax + Math.min(4, Math.floor(clock / 180)) + (economy.french.stock > 600 ? 1 : 0);
    if (infantry < cap && post?.structure.alive && queued(post) < 2) {
      const paras = pad?.structure.alive && tiers?.unlocked("para") && built % 3 === 1;
      const key = built % 3 === 2 ? "piece" : tiers?.unlocked("legion") && built % 4 === 3 ? "legion" : "appele";
      if (paras ? pad.structure.enqueue("para") : post.structure.enqueue(key)) built++;
    }
    // Vehicles: the best the tiers allow (a jeep to start), one more per tier.
    const tier = tiers?.unlocked("amx13") ? 3 : tiers?.unlocked("halftrack") ? 2 : 1;
    const vehs = units.list.filter((u) => mine(u) && !u.type?.foot && !u.isAir && !u.isStructure);
    const veh = vehs.length + queued(pool);
    if (clock > P.firstVehicleAt && veh < P.vehiclesMax + tier - 1 && pool?.structure.alive && queued(pool) < 1) {
      const best = tier === 3 ? (vehs.some((v) => v.typeKey === "amx13") ? "ebr" : "amx13") : tier === 2 ? "halftrack" : "willys";
      pool.structure.enqueue(veh === 0 ? "willys" : best);
    }
    const tn = tiers?.next?.();
    if (tn && clock > (P.tierAt[tn.n - 1] ?? 1e9) && !tiers.blockedBy(tn)) tiers.unlock();
    // Munitions to spare (the T-6's price kept back): an FM for a squad that has none.
    if (economy.french.mun > P.airMun + 60) {
      const s = mySquads.find((q) => squads.upgradeCost?.(q, "lmg"));
      if (s) squads.upgrade(s, "lmg");
    }
  }

  // ── THE PLAN ─────────────────────────────────────────────────────────────
  function think() {
    const known = knownFln();
    const mySquads = squads.list.filter((s) => s.team === "player" && s.members.length);
    for (const s of [...tasks.keys()]) if (!mySquads.includes(s)) tasks.delete(s);
    produce(mySquads);

    // Reinforce at the post; pull back the broken.
    for (const s of mySquads) {
      if (s.retreating) { tasks.delete(s); continue; }
      if (strength(s) < P.retreatBelow && !squads.inBase?.(centreOf(s).x, centreOf(s).z)) { squads.retreat(s); tasks.delete(s); continue; }
      for (let k = 0; k < 6 && strength(s) + squads.pendingFor(s) / (SQUADS[s.typeKey]?.size ?? 6) < 1; k++) if (!squads.reinforce(s)) break;
    }
    const ready = (s) => !s.retreating && (strength(s) >= 0.6 || !squads.inBase?.(centreOf(s).x, centreOf(s).z));

    // Tasks finished?
    for (const [s, tk] of tasks) {
      const p = tk.point;
      const near = flnNear(known, tk.at, 30);
      if (near) tk.quietSince = clock;
      let done = false;
      if (tk.kind === "take" && p?.owner === "player") done = true;
      else if (tk.kind === "retake" && p?.owner === "player" && clock - tk.quietSince > 20) done = true;
      else if (tk.kind === "defend" && clock - tk.quietSince > 20) done = true;
      else if (tk.kind === "hold" && p?.owner !== "player" && p?.value < 0.2) tk.kind = "retake";
      else if (tk.kind === "assault" && !cave?.structure.alive) done = true;
      else if (tk.kind === "patrol" && dist(centreOf(s), tk.at) < 12) done = true;
      if (done) tasks.delete(s);
      // Chased off, stuck, or a man lost his way: send them again.
      else if (clock - tk.orderedAt > 15 && s.members.every((u) => !u.isMoving) && dist(centreOf(s), tk.at) > P.ring * 2.5) { tk.orderedAt = clock; order(s, tk.at, clock); }
    }

    const free = () => mySquads.filter((s) => ready(s) && (!tasks.has(s) || tasks.get(s).kind === "patrol"));
    const take = (want, kind, at, point = null) => {
      const have = [...tasks.entries()].filter(([, tk]) => tk.point === point && tk.kind === kind && (point || dist(tk.at, at) < 20)).length;
      for (let n = want - have; n > 0; n--) {
        const c = free().sort((a, b) => dist(centreOf(a), at) - dist(centreOf(b), at))[0];
        if (!c) return;
        assign(c, kind, at, point);
      }
    };

    // 1. The post under fire.
    const ps = post?.structure;
    if (ps?.alive) {
      if (ps.hp < postHp - 1e-6) postHitAt = clock;
      postHp = ps.hp;
      if (clock - postHitAt < 10 || flnNear(known, home, 60) >= 3) {
        for (const s of mySquads) if (ready(s) && tasks.get(s)?.kind !== "defend" && dist(centreOf(s), home) < P.defendR) assign(s, "defend", home);
      }
    }
    // 2. Points of his slipping away.
    const pts = economy.allPoints;
    for (const p of pts) {
      const was = lastValue.get(p) ?? p.value;
      lastValue.set(p, p.value);
      if (p.owner !== "player") continue;
      // FLN men seen in it, or its needle going their way (someone unseen is working it).
      if (flnNear(known, p.position, p.radius + 6) || p.value < was - 1e-4) take(2, "retake", p.position, p);
    }
    // 3. The VILLAGES to take (the score), nearest first; 4. a squad sits in each held one (from the
    // third squad on: the first two keep moving); 5. then the depots, with what is left.
    const byHome = (a, b) => dist(a.position, home) - dist(b.position, home);
    const want = (p) => (p.owner === "enemy" || flnNear(known, p.position, p.radius + 6) ? 2 : 1);
    for (const p of economy.points.filter((v) => v.owner !== "player").sort(byHome)) take(want(p), "take", p.position, p);
    if (mySquads.length >= 3) for (const p of economy.points.filter((v) => v.owner === "player").sort(byHome)) take(1, "hold", p.position, p);
    for (const p of economy.supply.filter((v) => v.owner !== "player").sort(byHome)) take(want(p), "take", p.position, p);
    // 6. The cave, with what is left over.
    const spare = free();
    if (cave?.structure.alive && clock > P.assaultFrom && mySquads.length >= P.assaultAt && spare.length >= 3) {
      for (const s of spare) assign(s, "assault", cave.structure.position);
    } else {
      // Or walk between the held villages (they meet the bands working them).
      const held = economy.points.filter((p) => p.owner === "player");
      for (const s of spare) if (!tasks.has(s) && held.length) {
        const p = held[(s.id + Math.floor(clock / 60)) % held.length];
        if (dist(centreOf(s), p.position) > 25) assign(s, "patrol", p.position, null);
      }
    }

    // Vehicles go with the most urgent task.
    const urgent = [...tasks.values()].sort((a, b) => rank(a.kind) - rank(b.kind))[0];
    for (const v of units.list) {
      if (!mine(v) || v.type?.foot || v.isAir || v.isStructure || v.carrier) continue;
      const tk = vTasks.get(v), at = urgent?.at;
      if (!at) continue;
      if (!tk || dist(tk.at, at) > 15 || (clock - tk.orderedAt > 20 && !v.isMoving && dist(v.position, at) > 25)) {
        vTasks.set(v, { at, orderedAt: clock });
        v.orderTo(at.x + 9, at.z + 9);
      }
    }

    // The T-6: on a knot of FLN men, clear of his own.
    if (airStrike && ps?.alive && clock - lastAir > P.airEvery) {
      const french = units.list.filter((u) => mine(u) && !u.isAir);
      for (const u of known) {
        if (flnNear(known, u.position, P.airR) < P.airMin) continue;
        if (french.some((f) => dist(f.position, u.position) < P.airSafe)) continue;
        if (airStrike.call(ps, u.position.x, u.position.z)) { lastAir = clock; break; }
      }
    }
  }
  const rank = (k) => ({ defend: 0, retake: 1, assault: 2, take: 3, hold: 4, patrol: 5 }[k] ?? 9);

  return {
    params: P,
    tasks,
    /** On the fixed sim clock. */
    step(dt) {
      clock += dt;
      if ((acc += dt) < P.tick) return;
      acc = 0;
      think();
    },
    /** What each squad is doing (dev: __ALG.algFrenchAI.report()). */
    report: () => [...tasks.entries()].map(([s, tk]) => `${s.typeKey}#${s.id} ${tk.kind} ${tk.point?.name ?? ""} (${s.members.length})`),
  };
}
