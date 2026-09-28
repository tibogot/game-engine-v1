// THE ALN — this game's enemy commander. NOT nam's AI: the katiba does not
// hold ground or trade blows with the post. It strikes where the French are
// thin and is gone before they can answer:
//
//   GATHER    the cave sends men out (its producer's queue) until a band of
//             4-7 stands at the rally;
//   APPROACH  it picks French troops out in the OPEN — away from the post
//             first — and an AMBUSH SPOT 40-65 m from them on its own side:
//             scrub and tall plants to hide in, higher ground better. It
//             moves there HOLDING FIRE (a muzzle flash would give it away);
//   AMBUSH    it waits, still, until the French walk within 32 m — or, after
//             a minute of nothing, goes in anyway if they are near, or
//             re-plans;
//   STRIKE    fire, for 12-22 s. It breaks off early when it has lost 40% of
//             its men or when French ARMOUR comes within 55 m;
//   WITHDRAW  holding fire (it runs, it does not stop to shoot), back into
//             the cave mouth, where the survivors go to ground: they vanish,
//             and count toward the next band.
//
// Or, about half the time when there is one worth taking, POLITICAL WORK:
// the band goes into a VILLAGE it does not hold (algEconomy.js) — French-held
// first, then neutral; near the cave and far from French troops — and stays,
// holding fire, which swings the village its way. French coming within 35 m
// of it: it STRIKES, then melts away as ever. The player has to garrison or
// patrol the villages, and every patrol can walk into an ambush.
//
// The pace: the first band after ~45 s, then one every 80-140 s, never more
// than 18 fighters out at once. Orders, paths and the fighting are the shared
// machinery (units.orderTo, navGrid, combat.js's holdFire).
//
// French on a TRACK (the piste, a mule path — algTracks.js) get the road
// ambush: the band lies up along that track, 15-45 m off it.
//
// Or, about a third of the time, a MINE (algMines.js): the band walks to a
// stretch of PISTE far from any French, works there a few seconds, holding
// fire, and goes home. The French find out when a truck goes up.
import { TRACK_LINES, nearestTrack } from "./algTracks.js";

const P = {
  firstBandAt: 45,
  bandEvery: [80, 140],
  bandSize: [4, 7],
  maxLive: 18,
  ambushRing: [40, 65],       // metres from the target group
  onTrack: 12,                // French this near a track are "on" it (algTracks.js)
  roadBonus: 0.8,             // a spot lining that track, 15-45 m off it
  trigger: 32,                // French this close to the band: open fire
  waitMax: 60,                // seconds in ambush before going in or re-planning
  strikeTime: [12, 22],
  breakLoss: 0.4,             // share of the band lost: break off
  armourNear: 55,             // French armour this close: break off
  postKeepOff: 60,            // French within this of the post count as "at home"
  replanEvery: 10,
  villageShare: 0.55,         // of the bands, when a village is worth taking
  villageTrigger: 35,         // French this close to an occupying band: open fire
  mineShare: 0.3,             // of the bands (while the map has room for a mine)
  mineWork: 8,                // seconds at the spot to lay it
  mineKeepOff: 90,            // no French within this of the spot
  mineApart: 45,              // from the other mines
};

const rand = (a, b) => a + Math.random() * (b - a);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units      the shared units
 * @param {object} o.cave       the cave's producer (algProducer.js)
 * @param {{x:number,z:number}} o.post   the French post's centre
 * @param {{x:number,z:number}} o.caveMouth  where fighters go to ground (world)
 */
export function createAlgAI(app, { units, cave, post, caveMouth }) {
  const bands = [];
  let t = 0, nextBand = P.firstBandAt, enabled = true, pool = 0;
  const inBand = new Set();
  const homebound = new Set();   // men sent back to the cave on their own (stragglers)

  /** Into the cave mouth: gone to ground. He counts toward the next band. */
  function goToGround(u) {
    u.alive = false; u.vanished = true; inBand.delete(u); homebound.delete(u); pool++;
    app.selection?.remove?.(u);
  }

  const alive = (b) => b.members.filter((u) => u.alive);
  const centre = (list) => {
    let x = 0, z = 0;
    for (const u of list) { x += u.position.x; z += u.position.z; }
    return { x: x / Math.max(1, list.length), z: z / Math.max(1, list.length) };
  };
  const french = () => units.list.filter((u) => u.alive && u.team === "player");
  const liveFighters = () => units.list.filter((u) => u.alive && u.team === "enemy").length;

  /**
   * How good a spot is to lie up in: CONCEALMENT round it (the game's own
   * rule, algCover.js — the scrub that really hides you) and COVER there
   * (stone, walls). 0-2.
   */
  function cover(x, z) {
    const c = app.algCover;
    if (!c) return (app.sampleFoliageDensity?.(x, z) ?? 0) + (app.sampleTallPlantDensity?.(x, z) ?? 0);
    let s = 0;
    for (const [dx, dz] of [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]]) s += c.concealmentAt(x + dx, z + dz) / c.params.maxConcealment;
    return s / 5 + c.coverAt(x, z);
  }

  /** The French to hit: a group out in the open, away from the post first. */
  function pickTarget(from) {
    const fr = french().filter((u) => !u.isAir);
    if (!fr.length) return null;
    const outside = fr.filter((u) => dist(u.position, post) > P.postKeepOff);
    const pool2 = outside.length ? outside : fr;
    let best = null, bestD = Infinity;
    for (const u of pool2) { const d = dist(u.position, from); if (d < bestD) { bestD = d; best = u; } }
    // The group round that man.
    const group = pool2.filter((u) => dist(u.position, best.position) < 25);
    return { lead: best, at: centre(group), size: group.length };
  }

  /**
   * An ambush spot for a band at `from` on a target at `tgt`: a ring round the
   * target, on the band's side (±70°), open for men on foot, scored for cover
   * and height. Never inside the post's reach.
   */
  function ambushSpot(from, tgt) {
    const base = Math.atan2(from.z - tgt.z, from.x - tgt.x);
    const gy = app.getWorldHeight(tgt.x, tgt.z);
    // French ON a track (the piste, a mule path): the band lines THAT track,
    // 15-45 m off it — the road ambush, where the patrol has to come.
    const onTrack = nearestTrack(tgt.x, tgt.z);
    const road = onTrack && onTrack.d < P.onTrack ? onTrack.track : null;
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 28; i++) {
      const a = base + rand(-1.2, 1.2), r = rand(...P.ambushRing);
      const x = tgt.x + Math.cos(a) * r, z = tgt.z + Math.sin(a) * r;
      if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) continue;
      if (dist({ x, z }, post) < P.postKeepOff) continue;
      let s = cover(x, z) * 2 + Math.max(-1, Math.min(1, (app.getWorldHeight(x, z) - gy) / 15)) - r / 200;
      if (road) {
        const d = road.line.reduce((m, p) => Math.min(m, Math.hypot(p.x - x, p.z - z)), Infinity);
        if (d >= 15 && d <= 45) s += P.roadBonus;
        else if (d < 8) s -= 2;   // never lie up ON the track
      }
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    return best;
  }

  /** Orders the band to `to`, spread out a little (a loose file, not a knot). */
  function moveBand(b, to) {
    const m = alive(b);
    m.forEach((u, i) => {
      const a = (i / Math.max(1, m.length)) * Math.PI * 2;
      const r = i === 0 ? 0 : 2.5 + (i % 2) * 1.5;
      u.orderTo(to.x + Math.cos(a) * r, to.z + Math.sin(a) * r);
    });
  }

  const holdFire = (b, on) => { for (const u of b.members) u.holdFire = on; };

  function newBand() {
    const size = Math.round(rand(...P.bandSize));
    const room = P.maxLive - liveFighters();
    const n = Math.min(size, room);
    if (n < 3) return;
    // Only the men the katiba can PAY for (algEconomy.js: the cave's queue
    // charges the ALN purse): a band of however many that is, or none.
    let paid = 0;
    for (let i = 0; i < n; i++) if (cave.structure.enqueue("moudjahid")) paid++;
    if (paid < 3) {
      // Too few to be a band: take them off the queue and give the money back.
      cave.structure.queue.length = Math.max(0, cave.structure.queue.length - paid);
      app.algEconomy?.aln.earn(paid * (app.algEconomy.costs?.moudjahid ?? 40));
      return;
    }
    bands.push({ state: "gather", size: paid, members: [], t: 0, start: 0 });
  }

  function setState(b, s) { b.state = s; b.t = 0; }

  function stepBand(b, dt) {
    b.t += dt;
    const m = alive(b);
    switch (b.state) {
      case "gather": {
        // Men out of the cave, standing (not still walking out), in no band.
        for (const u of units.list) {
          if (b.members.length >= b.size) break;
          if (!u.alive || u.team !== "enemy" || inBand.has(u) || u.ghost || u.isMoving) continue;
          if (u.typeKey !== "moudjahid") continue;
          b.members.push(u); inBand.add(u);
        }
        if (b.members.length >= b.size || (b.t > 40 && b.members.length >= 3)) {
          b.start = b.members.length;
          holdFire(b, true);
          plan(b);
        }
        break;
      }
      case "approach": {
        if (!m.length) return setState(b, "done");
        // Arrived when most of the band is there — not the average: one man
        // stuck on the way (no route) dragged the band's centre 100 m back
        // and it never arrived (measured).
        const there = m.filter((u) => dist(u.position, b.spot) < 12);
        if (there.length >= Math.ceil(m.length * 0.6)) {
          for (const u of m) {
            if (there.includes(u)) { u.haltMovement(); continue; }
            // A straggler: once more toward the band; stuck again, he leaves it
            // for the cave (he is no use to an ambush 500 m away).
            if (u.isMoving) continue;
            if (!u.retried) { u.retried = true; u.orderTo(b.spot.x, b.spot.z); }
            else { b.members.splice(b.members.indexOf(u), 1); inBand.delete(u); u.holdFire = true; homebound.add(u); u.orderTo(caveMouth.x, caveMouth.z); }
          }
          setState(b, b.mission === "village" ? "occupy" : b.mission === "mine" ? "lay" : "ambush");
          break;
        }
        // Everyone stopped short (no route for anyone): try another spot.
        if (b.t > 20 && m.every((u) => !u.isMoving)) { plan(b); break; }
        // The French moved on: a new spot every few seconds.
        if (b.t > P.replanEvery && b.target && dist(b.target.lead.position, b.target.at) > 35) plan(b);
        break;
      }
      case "ambush": {
        if (!m.length) return setState(b, "done");
        // The centre of the men AT the spot (a late straggler still walking in
        // is not where the ambush is).
        const near = m.filter((u) => dist(u.position, b.spot) < 15);
        const c = centre(near.length ? near : m);
        const close = french().some((u) => !u.isAir && dist(u.position, c) < P.trigger);
        if (close) { strike(b); break; }
        if (b.t > P.waitMax) {
          const tg = pickTarget(c);
          if (tg && dist(tg.at, c) < 80) { strike(b); for (const u of m) u.orderTo(tg.at.x, tg.at.z); }
          else plan(b);
        }
        break;
      }
      case "occupy": {
        // Among the houses, holding fire: the village swings their way while
        // they stay. The French coming: open up, then go as ever.
        if (!m.length) return setState(b, "done");
        const c = centre(m);
        if (french().some((u) => !u.isAir && dist(u.position, c) < P.villageTrigger)) { strike(b); break; }
        break;
      }
      case "lay": {
        // At the piste, holding fire: the mine goes in, and they go. French
        // turning up first: fight, then go as ever (no mine).
        if (!m.length) return setState(b, "done");
        const c = centre(m);
        if (french().some((u) => !u.isAir && dist(u.position, c) < P.trigger)) { strike(b); break; }
        if (b.t > P.mineWork) { app.algMines?.lay(b.minePt.x, b.minePt.z); withdraw(b); }
        break;
      }
      case "strike": {
        const lost = 1 - m.length / Math.max(1, b.start);
        const c = centre(m);
        const armour = french().some((u) => !u.type?.foot && !u.isAir && dist(u.position, c) < P.armourNear);
        if (!m.length) return setState(b, "done");
        if (b.t > b.strikeFor || lost >= P.breakLoss || armour) withdraw(b);
        break;
      }
      case "withdraw": {
        if (!m.length) return setState(b, "done");
        // Into the mouth: gone to ground. They count toward the next band.
        for (const u of m) if (dist(u.position, caveMouth) < 5) goToGround(u);
        if (!alive(b).length) setState(b, "done");
        else if (b.t > 90) for (const u of alive(b)) u.orderTo(caveMouth.x, caveMouth.z);   // stragglers
        break;
      }
    }
  }

  /**
   * A village to work: one the ALN does not hold. French-held counts most,
   * then neutral; nearer the band better; French troops round it worse.
   */
  function pickVillage(from) {
    const pts = app.algEconomy?.points ?? [];
    let best = null, bestS = -Infinity;
    for (const v of pts) {
      if (v.owner === "enemy") continue;
      const guards = french().filter((u) => !u.isAir && dist(u.position, v.position) < 60).length;
      const s = (v.owner === "player" ? 2 : 1) - dist(from, v.position) / 600 - guards * 0.6;
      if (s > bestS) { bestS = s; best = v; }
    }
    return best;
  }

  function planVillage(b, v) {
    const c = centre(alive(b));
    // In among the houses, on the band's side, somewhere a man can stand.
    const a = Math.atan2(c.z - v.position.z, c.x - v.position.x);
    let spot = null;
    for (let i = 0; i < 16 && !spot; i++) {
      const r = 12 + i * 1.5, aa = a + (i % 2 ? 1 : -1) * i * 0.25;
      const x = v.position.x + Math.cos(aa) * r, z = v.position.z + Math.sin(aa) * r;
      if (!app.navGrid?.isBlockedAtWorld?.(x, z, true)) spot = { x, z };
    }
    if (!spot) return false;
    b.mission = "village"; b.village = v; b.spot = spot; b.target = null;
    holdFire(b, true);
    moveBand(b, spot);
    setState(b, "approach");
    return true;
  }

  /**
   * A stretch of piste to mine: no French within mineKeepOff, clear of the
   * post and of the other mines; nearer the band better. False if none.
   */
  function planMine(b) {
    const mines = app.algMines;
    if (!mines || mines.count >= mines.params.max) return false;
    const c = centre(alive(b));
    const fr = french().filter((u) => !u.isAir);
    let best = null, bestS = -Infinity;
    for (const t of TRACK_LINES) {
      if (t.kind !== "piste") continue;
      for (let i = 2; i < t.line.length - 2; i += 3) {
        const p = t.line[i];
        if (dist(p, post) < P.mineKeepOff) continue;
        if (fr.some((u) => dist(u.position, p) < P.mineKeepOff)) continue;
        if (mines.list.some((q) => dist(q, p) < P.mineApart)) continue;
        const s = -dist(p, c) / 400 + Math.random() * 0.4;
        if (s > bestS) { bestS = s; best = p; }
      }
    }
    if (!best) return false;
    b.mission = "mine"; b.minePt = { x: best.x, z: best.z }; b.target = null;
    // The band stands beside the road, the mine goes in the wheel track.
    b.spot = { x: best.x, z: best.z };
    holdFire(b, true);
    moveBand(b, b.spot);
    setState(b, "approach");
    return true;
  }

  function plan(b) {
    const m = alive(b);
    const c = centre(m);
    // A mine on the piste, about a third of the time there is room for one.
    if (!b.mission && Math.random() < P.mineShare && planMine(b)) return;
    if (b.mission === "mine") {
      if (planMine(b)) return;
      b.mission = "ambush";
    }
    // Political work, about half the time a village is worth it.
    if (!b.mission) {
      const v = pickVillage(c);
      if (v && Math.random() < P.villageShare && planVillage(b, v)) return;
      b.mission = "ambush";
    }
    if (b.mission === "village") {
      const v = b.village && b.village.owner !== "enemy" ? b.village : pickVillage(c);
      if (v && planVillage(b, v)) return;
      b.mission = "ambush";
    }
    const tg = pickTarget(c);
    if (!tg) { setState(b, "gather"); b.t = 0; return; }   // nobody to hit: wait at the rally
    const spot = ambushSpot(c, tg.at);
    if (!spot) { withdraw(b); return; }
    b.target = tg; b.spot = spot;
    holdFire(b, true);
    moveBand(b, spot);
    setState(b, "approach");
  }

  function strike(b) {
    holdFire(b, false);
    b.strikeFor = rand(...P.strikeTime);
    setState(b, "strike");
  }

  function withdraw(b) {
    holdFire(b, true);
    for (const u of alive(b)) { u.attackTarget = null; u.target = null; u.orderTo(caveMouth.x, caveMouth.z); }
    setState(b, "withdraw");
  }

  return {
    params: P,
    get bands() { return bands; },
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; },
    /** On the fixed sim clock. */
    step(dt) {
      t += dt;
      for (const u of homebound) { if (!u.alive) homebound.delete(u); else if (dist(u.position, caveMouth) < 5) goToGround(u); }
      for (let i = bands.length - 1; i >= 0; i--) {
        stepBand(bands[i], dt);
        if (bands[i].state === "done") { for (const u of bands[i].members) inBand.delete(u); bands.splice(i, 1); }
      }
      if (!enabled) return;
      nextBand -= dt;
      if (nextBand <= 0) {
        nextBand = rand(...P.bandEvery) * (pool > 6 ? 0.7 : 1);
        if (pool > 0) pool = Math.max(0, pool - 4);
        newBand();
      }
    },
    /** Dev: a band now. */
    bandNow() { newBand(); },
    /** Dev: the ambush spot a band at `from` would take on French at `tgt`. */
    ambushSpotFor: (from, tgt) => ambushSpot(from, tgt),
    /** Dev: what each band is doing. */
    describe() {
      return bands.map((b) => `${b.state}${b.mission === "village" && b.village ? ` (${b.village.name})` : b.mission === "mine" ? " (mine)" : ""} ${alive(b).length}/${b.state === "gather" ? b.size : b.start}`).join(" · ") || "no band out";
    },
  };
}
