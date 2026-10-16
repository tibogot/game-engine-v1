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
// AND (2026-10-13, B — the AI using the whole French toolkit):
//   FORTIFIES  one team of sapeurs: a mortar pit by the post, then a mirador, then an MG nest in each
//              village he holds (algBuild place — the same price, the same work);
//   SHELLS     a knot of FLN men he sees in a pit's reach with its BARRAGE (algBarrage fire);
//   LIGHTS     the night over a fight with the pit's FLARES (algFlares fire);
//   THROWS     grenades at FLN men bunched or in a house (algGrenades order, munitions paid);
//   CARRIES    a squad sent far (>180 m) in a half-track, a GMC or the H-21 standing near it
//              (algTransports: aboard, driven there, set down); buys an H-21 once the helipad is open.
//   COMMANDS   a DOCTRINE of his own (algDoctrines.js, no strip): picked at random; its abilities
//              unlocked as his points come, cheapest first, and used where his men see a reason.
// AND (2026-10-16): a MORTAR TEAM of 81 (algMortarTeam.js, mortierFr) — one, a second later on; kept
//   ~60 m behind his hottest fight (it sets up there by itself), its rounds and BARRAGES only on FLN men
//   his men see (setSight), his own clear of the salvo.
//
// He sees what his men see — no more: an FLN man is KNOWN within 16 m of a French unit, or 40 m
// when he moves or fires (the scrub ambush works on him as it does on you). Re-plans each second.
import { SQUADS } from "./algSquads.js";
import { BUILD_COSTS } from "./algBuild.js";

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
  // B (2026-10-13): the whole toolkit
  sappersAt: 60,         // s: the sapeurs bought
  miradorAt: 240,        // s: the mirador after the pit
  nestR: 45,             // m: a village with an MG nest within this has one
  barrageKnot: 3, barrageR: 12, barrageSafe: 22,   // FLN men in a knot, French clear of it
  flareNight: 0.3, flareR: 90,                     // app.sky.night; m from his men in contact
  grenadeEvery: 8,       // s between two throws of a squad
  liftFar: 180, liftNear: 60, liftDrop: 35, liftBoard: 40,   // m / s: the transports
  heliAt: 300,           // s: an H-21 bought once the helipad is open
  // The mortar team (2026-10-16)
  mortarAt: 200, mortar2At: 600,   // s: the first team bought, the second
  mortarBack: 60,                  // m behind the fight it supports (toward the post)
  mortarMove: 25,                  // m: a new place only when the fight has moved this much
};

export function createAlgFrenchAI(app, { units, squads, economy, producers, tiers = null, garrison = null, airStrike = null, build = null, barrage = null, flares = null, grenades = null, transports = null, doctrine = null, mortarTeams = null }) {
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
    // The SAPEURS (one team: the fortifications) and an H-21 (the lifts).
    const sappers = mySquads.some((s) => s.typeKey === "sapeur") || (post?.structure.queue ?? []).includes("sapeur");
    if (!sappers && clock > P.sappersAt && post?.structure.alive && queued(post) < 2) post.structure.enqueue("sapeur");
    // The MORTAR TEAM(S): one from P.mortarAt, two from P.mortar2At (the post's card, its own price).
    const mortars = mySquads.filter((s) => s.typeKey === "mortierFr").length + (post?.structure.queue ?? []).filter((k) => k === "mortierFr").length;
    const wantMortars = !mortarTeams ? 0 : clock > P.mortar2At ? 2 : clock > P.mortarAt ? 1 : 0;
    if (mortars < wantMortars && post?.structure.alive && queued(post) < 2) post.structure.enqueue("mortierFr");
    const h21s = units.list.filter((u) => mine(u) && u.typeKey === "h21").length + (pad?.structure.queue ?? []).filter((k) => k === "h21").length;
    if (!h21s && clock > P.heliAt && pad?.structure.alive && tiers?.unlocked("h21") && queued(pad) < 1) pad.structure.enqueue("h21");
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

    const free = () => mySquads.filter((s) => ready(s) && s.typeKey !== "sapeur" && s.typeKey !== "mortierFr" && !lifts.has(s) && (!tasks.has(s) || tasks.get(s).kind === "patrol"));
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
        for (const s of mySquads) if (ready(s) && s.typeKey !== "sapeur" && s.typeKey !== "mortierFr" && tasks.get(s)?.kind !== "defend" && dist(centreOf(s), home) < P.defendR) assign(s, "defend", home);
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
      if (!mine(v) || v.type?.foot || v.isAir || v.isStructure || v.carrier || lifting(v) || v.typeKey === "h21") continue;
      const tk = vTasks.get(v), at = urgent?.at;
      if (!at) continue;
      if (!tk || dist(tk.at, at) > 15 || (clock - tk.orderedAt > 20 && !v.isMoving && dist(v.position, at) > 25)) {
        vTasks.set(v, { at, orderedAt: clock });
        v.orderTo(at.x + 9, at.z + 9);
      }
    }

    fortify(mySquads);
    support(known, mySquads);
    mortars(known, mySquads);
    lift(mySquads);
    command(known, mySquads);

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

  // ── B. FORTIFY: the sapeurs build, one site at a time ──────────────────────
  let building = null;   // { key, x, z, since, pending, site } — ONE at a time, until it stands or fails
  const french = (key) => (app.algStructures?.list ?? []).filter((s) => s.alive && s.team === "player" && s.typeKey === key);
  function spotFor(key, at, rMin, rMax) {
    for (let r = rMin; r <= rMax; r += 4) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2 + r * 0.37, x = at.x + Math.cos(a) * r, z = at.z + Math.sin(a) * r;
        const yaw = Math.atan2(x - home.x, z - home.z) + Math.PI;   // facing out from the post
        if (build.survey(key, x, z, yaw).ok) return { x, z, yaw };
      }
    }
    return null;
  }
  function fortify(mySquads) {
    if (!build) return;
    const sap = mySquads.find((s) => s.typeKey === "sapeur" && !s.retreating);
    if (!sap) return;
    // A placement still resolving (a pad levels the ground first: the site appears only then — 4 s was
    // not enough, he paid for ten sites at once, 2026-10-13), or his site still rising: wait for it.
    if (building?.pending) return;
    if (building?.site && !building.site.done && building.site.alive !== false) {
      // The team sent back to it now and then (a defence pulled them off; they walked between sites).
      if (clock - (building.sentAt ?? 0) > 20 && sap.members.every((u) => !u.isMoving)) { building.sentAt = clock; for (const u of sap.members) u.orderTo(building.site.x + (Math.random() - 0.5) * 4, building.site.z + (Math.random() - 0.5) * 4); }
      return;
    }
    building = null;
    const cost = (k) => economy.french.canAfford(BUILD_COSTS[k] ?? 0);
    let job = null;
    if (!french("mortarPit").length && cost("mortarPit")) job = { key: "mortarPit", at: home, r: [30, 70] };
    else if (clock > P.miradorAt && !french("mirador").length && cost("mirador")) job = { key: "mirador", at: home, r: [35, 80] };
    else if (cost("mgNest")) {
      const held = economy.points.filter((v) => v.owner === "player" && !french("mgNest").some((n) => dist(n.position, v.position) < P.nestR));
      const v = held.sort((a, b) => dist(a.position, home) - dist(b.position, home))[0];
      if (v) job = { key: "mgNest", at: v.position, r: [10, 34] };
    }
    if (!job) return;
    const sp = spotFor(job.key, job.at, job.r[0], job.r[1]);
    if (!sp) return;
    const b = building = { key: job.key, x: sp.x, z: sp.z, since: clock, pending: true, site: null, sentAt: clock };
    tasks.delete(sap);
    Promise.resolve(build.place(job.key, sp.x, sp.z, sp.yaw, sap.members)).then((site) => { b.pending = false; b.site = site ?? null; }, () => { b.pending = false; });
  }

  // ── THE MORTAR TEAM: behind the hottest fight, shelling what his men see ──────
  // His eyes for its rounds: an FLN man known (knownFln) within 6 m of the spot.
  let knownNow = [];
  mortarTeams?.setSight?.("player", (x, z) => knownNow.some((u) => Math.abs(u.position.x - x) < 6 && Math.abs(u.position.z - z) < 6));
  const mortarAt = new Map();   // team -> the place it was sent
  function mortars(known, mySquads) {
    knownNow = known;
    if (!mortarTeams) return;
    // THE FIGHT IT SUPPORTS: where his men see the most FLN men (a task's place, 45 m round); none seen,
    // the nearest defend / retake / take to the post (by rank it followed a far depot's "take" across
    // the map, 2026-10-16); none, the post.
    const all = [...tasks.values()].filter((tk) => tk.kind !== "patrol" && tk.kind !== "hold");
    const hot = [...tasks.values()].map((tk) => ({ tk, n: flnNear(known, tk.at, 45) })).filter((e) => e.n > 0).sort((a, b) => b.n - a.n || rank(a.tk.kind) - rank(b.tk.kind))[0]?.tk;
    const fight = hot ?? all.sort((a, b) => dist(a.at, home) - dist(b.at, home))[0] ?? null;
    // Measured from the ENEMY seen there (their middle), not the task's point: from a village's centre
    // the team stopped 160 m from the FLN men attacking it, out of its reach.
    let aim = fight?.at ?? null;
    if (hot) {
      const near = known.filter((u) => dist(u.position, hot.at) < 45);
      aim = { x: near.reduce((a, u) => a + u.position.x, 0) / near.length, z: near.reduce((a, u) => a + u.position.z, 0) / near.length };
    }
    let n = 0;
    for (const s of mySquads) {
      if (s.typeKey !== "mortierFr" || s.retreating || !s.members.length) continue;
      const side = n++ === 0 ? 0 : n % 2 ? 12 : -12;   // a second team 12 m to the side (not on one spot)
      tasks.delete(s);
      const c = centreOf(s);
      // ITS PLACE: P.mortarBack short of the fight, on the post's side (by the post with no fight).
      let to = home;
      if (aim) {
        const dx = home.x - aim.x, dz = home.z - aim.z, d = Math.hypot(dx, dz) || 1, back = Math.min(P.mortarBack, d);
        to = { x: aim.x + (dx / d) * back - (dz / d) * side, z: aim.z + (dz / d) * back + (dx / d) * side };
      } else to = { x: home.x + side, z: home.z };
      const was = mortarAt.get(s), state = mortarTeams.stateOf(s);
      // (not while a salvo is going: a move order packs the piece up)
      if ((!was || dist(was, to) > P.mortarMove) && dist(c, to) > 12 && !mortarTeams.recordOf(s)?.salvo) {
        mortarAt.set(s, to);
        s.members.forEach((u, i) => { u.holdFire = false; u.orderTo(to.x + (i - 1) * 1.6, to.z + (i % 2) * 1.2); });
      }
      // ITS BARRAGE: a knot of FLN men seen in its reach, his own clear of the salvo.
      if (state !== "set") continue;
      const R = mortarTeams.reachOf(s), g = s.members[0];
      for (const u of known) {
        const d = dist(u.position, g.position);
        if (d < R.min || d > R.max || flnNear(known, u.position, P.barrageR) < P.barrageKnot) continue;
        if (units.list.some((f) => mine(f) && !f.isAir && dist(f.position, u.position) < P.barrageSafe)) continue;
        if (mortarTeams.fireBarrage(s, u.position.x, u.position.z)) break;
      }
    }
  }

  // ── B. SUPPORT: the pit's barrage and flares, the squads' grenades ─────────
  const grenadeT = new Map();   // squad → clock of its last throw
  function support(known, mySquads) {
    for (const pit of french("mortarPit")) {
      if (pit.constructing) continue;
      // THE BARRAGE: a knot of FLN men in its reach, his own clear of it.
      if (barrage && !(pit.barrageCd > 0)) {
        for (const u of known) {
          const d = dist(u.position, pit.position);
          if (d < 30 || d > (barrage.params?.range ?? 150)) continue;
          if (flnNear(known, u.position, P.barrageR) < P.barrageKnot) continue;
          if (units.list.some((f) => mine(f) && !f.isAir && dist(f.position, u.position) < P.barrageSafe)) continue;
          if (barrage.fire(pit, u.position.x, u.position.z)) break;
        }
      }
      // THE FLARES: night, and his men in a fight.
      if (flares && (app.sky?.night ?? 0) >= P.flareNight && !(pit.flareCd > 0)) {
        const fight = known.filter((u) => units.list.some((f) => mine(f) && f.type?.foot && dist(f.position, u.position) < P.flareR));
        if (fight.length && !flares.litAt?.(fight[0].position.x, fight[0].position.z)) {
          const c = fight.reduce((a, u) => ({ x: a.x + u.position.x / fight.length, z: a.z + u.position.z / fight.length }), { x: 0, z: 0 });
          if (dist(c, pit.position) < (flares.params?.range ?? 150)) flares.fire(pit, c.x, c.z);
        }
      }
    }
    // GRENADES: a man of a squad in a fight, at FLN men bunched or in a house.
    if (!grenades) return;
    const R = grenades.params?.range ?? 22, blast = grenades.params?.blast ?? 5;
    for (const s of mySquads) {
      if (s.retreating || clock - (grenadeT.get(s) ?? -1e9) < P.grenadeEvery) continue;
      let done = false;
      for (const u of s.members) {
        if (done || !u.type?.grenade || u.grenadeCd > 0 || u.throwing || u.pinned || u.inside) continue;
        for (const h of garrison?.houses ?? []) {
          if (h.team !== "enemy" || !h.men?.length || dist({ x: h.x, z: h.z }, u.position) > R) continue;
          grenades.order(u, h.x, h.z); done = true; break;
        }
        if (done) break;
        for (const e of known) {
          const d = dist(e.position, u.position);
          if (d > R || d < blast + 1 || flnNear(known, e.position, blast) < 2) continue;
          if (units.list.some((f) => mine(f) && f !== u && dist(f.position, e.position) < blast + 1)) continue;
          grenades.order(u, e.position.x, e.position.z); done = true; break;
        }
      }
      if (done) grenadeT.set(s, clock);
    }
  }

  // ── B. COMMAND: his doctrine ───────────────────────────────────────────────
  if (doctrine && !doctrine.doctrine) doctrine.choose(["paras", "legion", "air"][Math.floor(Math.random() * 3)]);
  /** A knot of n+ FLN he sees, his own `safe` m clear: its centre, or null. */
  function knot(known, n, safe) {
    for (const u of known) {
      if (flnNear(known, u.position, 14) < n) continue;
      if (units.list.some((f) => mine(f) && !f.isAir && dist(f.position, u.position) < safe)) continue;
      return { x: u.position.x, z: u.position.z };
    }
    return null;
  }
  function command(known, mySquads) {
    if (!doctrine?.doctrine) return;
    const abs = doctrine.abilities;
    // Unlock: the cheapest still locked, as soon as the points allow.
    const next = abs.filter((a) => !doctrine.unlocked.has(a.key)).sort((a, b) => a.cp - b.cp)[0];
    if (next) doctrine.unlock(next.key);
    const urgent = [...tasks.values()].filter((tk) => tk.kind === "retake" || tk.kind === "defend").sort((a, b) => rank(a.kind) - rank(b.kind))[0];
    const fieldCap = P.squadsMax + Math.min(4, Math.floor(clock / 180));
    for (const a of abs) {
      if (a.passive || !doctrine.ready(a.key)) continue;
      let at = null, go = false;
      switch (a.key) {
        case "paraDrop": if (urgent) { at = { x: urgent.at.x + 12, z: urgent.at.z + 12 }; go = true; } break;
        case "commando": case "legionCall": go = mySquads.length < fieldCap; break;
        case "airSupply": go = economy.french.mun < 60 || economy.french.fuel < 30; break;
        case "mortar120": case "gunship": at = knot(known, 3, 22); go = !!at; break;
        case "t6Pair": at = knot(known, 4, 28); go = !!at; break;
        case "recon": {
          // Over the point he is losing, or the cave when he has never seen it lately.
          at = urgent?.at ?? (cave?.structure.alive ? cave.structure.position : null); go = !!at && clock % 60 < 1; break;
        }
        case "medevac": {
          const hurt = units.list.filter((u) => mine(u) && u.type?.foot && u.hp < u.maxHp * 0.6);
          const c = hurt.find((u) => hurt.filter((o) => dist(o.position, u.position) < 25).length >= 3);
          if (c) { at = { x: c.position.x, z: c.position.z }; go = true; }
          break;
        }
      }
      if (go) doctrine.use(a.key, at);
    }
  }

  // ── B. LIFT: a squad sent far rides a half-track, a GMC or the H-21 ────────
  const lifts = new Map();   // squad → { v, to, phase, since }
  const CARRIERS = new Set(["halftrack", "gmc", "gmcOpen", "h21"]);
  const lifting = (v) => [...lifts.values()].some((l) => l.v === v);
  function lift(mySquads) {
    if (!transports) return;
    for (const [s, l] of [...lifts]) {
      const men = s.members, v = l.v, tk = tasks.get(s);
      const end = () => { lifts.delete(s); if (tk) { tk.orderedAt = clock; order(s, tk.at); } };
      if (!v.alive || !men.length || !tk) { if (v.alive) transports.unloadAll(v); lifts.delete(s); continue; }
      if (l.phase === "board") {
        if (men.every((u) => u.carrier === v)) { l.phase = "drive"; l.since = clock; v.orderTo(l.to.x, l.to.z); }
        else if (clock - l.since > P.liftBoard) { for (const u of men) if (u.carrier === v) transports.exitAll([u]); end(); }
      } else if (l.phase === "drive") {
        if (dist(v.position, l.to) < P.liftDrop || (clock - l.since > 10 && !v.isMoving && dist(v.position, l.to) < P.liftDrop * 2)) { transports.unloadAll(v); l.phase = "out"; l.since = clock; }
        else if (clock - l.since > 8 && !v.isMoving) v.orderTo(l.to.x, l.to.z);
      } else if (l.phase === "out") {
        if (men.every((u) => !u.carrier)) end();
        else if (clock - l.since > 25) end();
      }
    }
    // New lifts: a squad with a far task, a carrier of his near it, empty and idle.
    for (const s of mySquads) {
      const tk = tasks.get(s);
      if (!tk || lifts.has(s) || s.retreating || !["take", "retake", "assault"].includes(tk.kind) || !s.members.length) continue;
      const c = centreOf(s);
      if (dist(c, tk.at) < P.liftFar) continue;
      const v = units.list.find((u) => mine(u) && CARRIERS.has(u.typeKey) && !lifting(u) && !(transports.menOf(u)?.length) && dist(u.position, c) < P.liftNear
        && (transports.params.cap[u.typeKey] ?? 0) >= s.members.length);
      if (!v) continue;
      if (!transports.order(s.members, v)) continue;
      // Set down short of the point (not into it under fire).
      const dx = tk.at.x - c.x, dz = tk.at.z - c.z, d = Math.hypot(dx, dz) || 1;
      lifts.set(s, { v, to: { x: tk.at.x - (dx / d) * 30, z: tk.at.z - (dz / d) * 30 }, phase: "board", since: clock });
    }
  }

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
    report: () => [...tasks.entries()].map(([s, tk]) => `${s.typeKey}#${s.id} ${tk.kind} ${tk.point?.name ?? ""} (${s.members.length})${lifts.has(s) ? ` · ${lifts.get(s).v.typeKey} ${lifts.get(s).phase}` : ""}`),
    /** His doctrine (dev). */
    get doctrine() { return doctrine; },
    /** Dev: what the sapeurs build, the lifts in progress. */
    get building() { return building; },
    get lifts() { return lifts; },
  };
}
