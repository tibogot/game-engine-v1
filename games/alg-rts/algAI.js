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
//
// THE COMPANY OF HEROES MECHANICS (your ask, 2026-09-30) — the band fights
// with what the French have:
//   MGs     it knows where the French machine guns are (the post, miradors,
//           nests, jeeps and half-tracks) and keeps out of their reach: no
//           ambush spot inside one, and on the way there it goes ROUND —
//           a detour through scrub and gullies, out of the arc;
//   COVER   a man fired on who is not in cover crawls/runs to the best
//           shelter a few metres off, the side AWAY from who shot at him;
//           a band fired on while sneaking in is found — it opens up;
//   PINNED  half the band pinned (infantryPosture.js): it pulls back, as it
//           does when it loses men — a band does not die on its bellies;
//   GRENADE a man with one ready throws it (algGrenades.js) at French men
//           in cover or bunched up, or at an MG nest, within his throw — one
//           grenade per band every few seconds, not a hail.
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
  mgKeepOff: 8,               // metres past an MG's range an ambush spot must keep
  pinnedBreak: 0.5,           // share of the band pinned: pull back
  tactEvery: 0.5,             // seconds between a band's tactical looks (cover, grenades)
  grenadeEvery: 6,            // seconds between one band's grenades
  coverSeek: 12,              // metres a man fired on looks for shelter
  // ── 2026-10-01: the FLN holds what it takes, comes back for what it loses,
  // and builds (you: "of course you should work on [the AI]") ──
  cellSize: [2, 3],           // men left as a village's GARRISON once it turns
  cellMinBand: 4,             // a band this big or more leaves a cell
  cellBreak: 0.7,             // share of the cell lost: the rest run for the cave
  retakeWindow: 300,          // s a lost village stays the next band's mission
  retakeSoon: 15,             // the next band comes within this after a loss
  screenWait: 3,              // s in ambush before it puts up a screen (8: they struck first)
  screenApart: 45,            // m between two ambush screens
  stuckCut: 30,               // m: a band stuck this near wire cuts it
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

  /**
   * The French MACHINE GUNS: the post, miradors, nests, jeeps, half-tracks
   * ({ x, z, r }: their reach). Looked up once per plan, not per sample.
   */
  function frenchMGs() {   // (the buildings are not in units.list: algStructures)
    const out = [];
    for (const u of [...units.list, ...(app.algStructures?.list ?? [])]) {
      if (!u.alive || u.team !== "player" || u.isAir) continue;
      const w = u.weapon ?? u.type?.weapon;
      if (w !== "mg") continue;
      out.push({ x: u.position.x, z: u.position.z, r: (u.range ?? u.type?.range ?? 40) });
    }
    return out;
  }
  /** How deep (0..1+) a point lies inside the MGs' reach (0: out of it). */
  function mgExposure(x, z, mgs, pad = 0) {
    let e = 0;
    for (const g of mgs) {
      const d = Math.hypot(g.x - x, g.z - z), r = g.r + pad;
      if (d < r) e += 1 - d / r * 0.5;
    }
    return e;
  }

  /**
   * The way from `from` to `to`: straight, unless the straight line crosses
   * an MG's reach — then round it, via a point off to one side that is out
   * of the guns and in cover (scrub, a gully's low ground). Null: straight.
   */
  function detour(from, to, mgs) {
    if (!mgs.length) return null;
    const L = dist(from, to);
    if (L < 30) return null;
    let straight = 0;
    for (let k = 1; k < 8; k++) {
      const f = k / 8;
      straight += mgExposure(from.x + (to.x - from.x) * f, from.z + (to.z - from.z) * f, mgs);
    }
    if (straight <= 0) return null;
    const nx = -(to.z - from.z) / L, nz = (to.x - from.x) / L;
    const mx = (from.x + to.x) / 2, mz = (from.z + to.z) / 2;
    let best = null, bestS = -Infinity;
    for (const side of [-1, 1]) {
      for (const off of [0.25, 0.4, 0.6, 0.8]) {
        const x = mx + nx * side * off * L, z = mz + nz * side * off * L;
        if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) continue;
        // Both legs sampled for the guns; low ground and cover count.
        let e = 0;
        for (let k = 1; k < 5; k++) {
          const f = k / 5;
          e += mgExposure(from.x + (x - from.x) * f, from.z + (z - from.z) * f, mgs);
          e += mgExposure(x + (to.x - x) * f, z + (to.z - z) * f, mgs);
        }
        const low = (app.getWorldHeight(mx, mz) - app.getWorldHeight(x, z)) / 10;
        const s = -e * 3 + cover(x, z) + Math.max(-0.5, Math.min(0.5, low)) - off;
        if (s > bestS) { bestS = s; best = { x, z, e }; }
      }
    }
    // Only worth it when it really is out of the guns' way.
    return best && best.e < straight * 0.8 ? { x: best.x, z: best.z } : null;
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
    const mgs = frenchMGs();
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 28; i++) {
      const a = base + rand(-1.2, 1.2), r = rand(...P.ambushRing);
      const x = tgt.x + Math.cos(a) * r, z = tgt.z + Math.sin(a) * r;
      if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) continue;
      if (dist({ x, z }, post) < P.postKeepOff) continue;
      if (mgExposure(x, z, mgs, P.mgKeepOff) > 0) continue;   // never lie up under an MG
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

  /**
   * Sends the band to `to` — round the French MGs when the straight way
   * crosses one (detour): first to the via point, then on (stepBand).
   */
  function sendBand(b, to) {
    b.via = detour(centre(alive(b)), to, frenchMGs());
    moveBand(b, b.via ?? to);
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
        // Found on the way in — fired on: it opens up (a mine band, too).
        if (b.mission !== "village" && m.some((u) => (u.suppression ?? 0) > 0.3)) { strike(b); break; }
        // Round the guns: at the via point (most of the band), on to the spot.
        if (b.via) {
          const past = m.filter((u) => dist(u.position, b.via) < 15 || !u.isMoving);
          if (past.length >= Math.ceil(m.length * 0.6)) { b.via = null; moveBand(b, b.spot); }
          break;
        }
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
        // Everyone stopped short (no route for anyone): wire in the way? Cut
        // it (algWire.js) and go on. Otherwise try another spot.
        if (b.t > 20 && m.every((u) => !u.isMoving)) {
          const c0 = centre(m), w = app.algWire?.nearest(c0.x, c0.z, P.stuckCut);
          if (w && !b.cutTried) { b.cutTried = true; b.wire = w.m; app.algWire.cut(m, w); setState(b, "cut"); break; }
          plan(b); break;
        }
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
        if (close || m.some((u) => (u.suppression ?? 0) > 0.3)) { strike(b); break; }
        // Waiting: cut scrub stood up in front of them — an AMBUSH SCREEN
        // (algBuild.js, paid from the ALN purse): they are hidden behind it
        // until they fire (algCover concealment).
        if (b.t > P.screenWait && !b.screened && b.target) { b.screened = true; buildScreen(b, near.length ? near : m, c); }
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
        // TURNED: leave a cell to hold it, the rest go on (a band that sat in
        // a won village forever was a band the war no longer had). Already
        // held (a second band arrived): on to something else. Too small to
        // split: it becomes the cell itself.
        if (b.village?.owner === "enemy") {
          if (garrisonOf(b.village)) { b.mission = null; plan(b); }
          else if (m.length >= P.cellMinBand) { leaveCell(b, b.village); b.mission = null; plan(b); }
          else { b.mission = "garrison"; b.start = m.length; holdFire(b, true); cellSpots(b.village, m.length).forEach((p, i) => m[i]?.orderTo(p.x, p.z)); setState(b, "garrison"); }
        }
        break;
      }
      case "garrison": {
        // A village's cell: in cover among the houses, holding fire until the
        // French come; then it FIGHTS in place (it does not melt away like a
        // band — the village is what it is for). Nearly wiped out: run.
        if (!m.length) return setState(b, "done");
        const c = centre(m);
        const close = french().some((u) => !u.isAir && dist(u.position, c) < P.villageTrigger + 10);
        holdFire(b, !close);
        if (close) {
          b.tact = (b.tact ?? 0) - dt;
          if (b.tact <= 0) { b.tact = P.tactEvery; tactics(b, m, dt); }
        }
        if (1 - m.length / Math.max(1, b.start) >= P.cellBreak || b.village.owner === "player") withdraw(b);
        break;
      }
      case "cut": {
        // Stuck at wire: the men cut it (algWire.js), then on to the spot.
        if (!m.length) return setState(b, "done");
        if (!b.wire?.parent || b.t > 25) { setState(b, "approach"); sendBand(b, b.spot); }
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
        const pinned = m.filter((u) => u.pinned).length / m.length;
        if (b.t > b.strikeFor || lost >= P.breakLoss || armour || pinned >= P.pinnedBreak) { withdraw(b); break; }
        b.tact = (b.tact ?? 0) - dt;
        if (b.tact <= 0) { b.tact = P.tactEvery; tactics(b, m, dt); }
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
   * A striking band's looks, every tactEvery: a man fired on out in the open
   * gets to cover; one man throws a grenade where it pays.
   */
  const _near = [];
  function tactics(b, m) {
    b.grenT = (b.grenT ?? rand(1, 3)) - P.tactEvery;
    for (const u of m) {
      if (u.throwing || u.isMoving || u.pinned) continue;
      const s = u.firedOnBy;
      if (!s?.alive || (u.suppression ?? 0) < 0.15 || u.inCover) continue;
      if (u.coverSought > t - 6) continue;   // he looked just now
      u.coverSought = t;
      const spot = shelter(u, s);
      if (spot) u.orderTo(spot.x, spot.z);
    }
    if (b.grenT > 0) return;
    const g = app.algGrenades;
    if (!g) return;
    const R = g.params.range, blast = g.params.blast;
    const fr = french().filter((f) => !f.isAir);
    for (const st of app.algStructures?.list ?? []) if (st.alive && st.team === "player" && st.weapon === "mg") fr.push(st);
    let best = null, bestS = 0;
    for (const u of m) {
      if (!u.type?.grenade || u.grenadeCd > 0 || u.throwing || u.pinned) continue;
      for (const f of fr) {
        if (!f.alive || f.team !== "player" || f.isAir) continue;
        const d = dist(f.position, u.position);
        if (d > R || d < blast + 1) continue;   // not on his own head
        let s;
        if (f.isStructure) s = (f.weapon ?? f.type?.weapon) === "mg" ? 2.5 : 0;
        else if (!f.type?.foot) s = 0;
        else {
          // Men round him in the blast; worth it bunched or in cover.
          let n = 0;
          for (const o of units.near(f.position.x, f.position.z, blast, _near)) if (o.alive && o.team === "player" && o.type?.foot && dist(o.position, f.position) < blast) n++;
          s = n + (f.inCover || f.posture === "kneel" ? 1.5 : 0) - 1.2;
        }
        if (s > bestS) { bestS = s; best = { u, x: f.position.x, z: f.position.z }; }
      }
    }
    if (!best) return;
    g.order(best.u, best.x + rand(-0.8, 0.8), best.z + rand(-0.8, 0.8));
    b.grenT = P.grenadeEvery;
  }

  /** Shelter for `u` from `from`: the best cover within coverSeek, on the side away from him. */
  function shelter(u, from) {
    const c = app.algCover;
    if (!c) return null;
    const x0 = u.position.x, z0 = u.position.z;
    const away = Math.atan2(z0 - from.position.z, x0 - from.position.x);
    let best = null, bestS = c.coverBetween(from.position.x, from.position.z, x0, z0) + 0.1;
    for (let i = 0; i < 10; i++) {
      const a = away + rand(-1.6, 1.6), r = rand(3, P.coverSeek);
      const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
      if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) continue;
      const s = c.coverBetween(from.position.x, from.position.z, x, z) - r / 60;
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    return best;
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
    sendBand(b, spot);
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
    sendBand(b, b.spot);
    setState(b, "approach");
    return true;
  }

  // ── Garrisons, retakes, building (2026-10-01) ─────────────────────────────
  const garrisonOf = (v) => bands.find((g) => g.state === "garrison" && g.village === v && alive(g).length);
  /** Spots among a village's houses where a man has cover: the best few of a ring. */
  function cellSpots(v, n) {
    const c = app.algCover, out = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + rand(-0.1, 0.1), r = rand(10, 26);
      const x = v.position.x + Math.cos(a) * r, z = v.position.z + Math.sin(a) * r;
      if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) continue;
      out.push({ x, z, s: (c ? c.coverAt(x, z) : 0) + (c ? c.concealmentAt(x, z) : 0) + rand(0, 0.2) });
    }
    return out.sort((p, q) => q.s - p.s).slice(0, n);
  }
  function leaveCell(b, v) {
    const m = alive(b);
    const k = Math.min(m.length - 2, Math.round(rand(...P.cellSize)));
    if (k < 1) return;
    const cell = m.slice(0, k);
    b.members = b.members.filter((u) => !cell.includes(u));
    const g = { state: "garrison", village: v, members: cell, size: k, start: k, t: 0, mission: "garrison" };
    bands.push(g);
    holdFire(g, true);
    cellSpots(v, k).forEach((p, i) => cell[i]?.orderTo(p.x, p.z));
    // A sangar at the village's edge, facing the post: what the cell falls
    // back behind (algBuild.js, paid from the ALN purse; the cell raises it).
    const build = app.algBuild, aln = app.algEconomy?.aln;
    // One per village: a village that changes hands again keeps its old one.
    const hasOne = Object.entries(app.showroom ?? {}).some(([k, o]) => /sangar/i.test(o?.userData?.kitKey ?? k) && o.parent && Math.hypot(o.position.x - v.position.x, o.position.z - v.position.z) < 70)
      || (build?.sites ?? []).some((s) => s.key === "sangar" && Math.hypot(s.x - v.position.x, s.z - v.position.z) < 70);
    if (build && !hasOne && aln?.canAfford(build.costOf?.("sangar") ?? 60)) {
      // Out past the houses (a ksar's own walls blocked every spot within
      // 40 m straight toward the post — measured): further out, and either side.
      const a0 = Math.atan2(post.z - v.position.z, post.x - v.position.x);
      search: for (let r = 20; r <= 60; r += 4) {
        for (const da of [0, 0.3, -0.3, 0.6, -0.6, 0.9, -0.9]) {
          const x = v.position.x + Math.cos(a0 + da) * r, z = v.position.z + Math.sin(a0 + da) * r;
          // The sangar's open back toward the village: its front (-Z) to the post.
          const yaw = Math.atan2(-(post.x - x), -(post.z - z));
          if (build.survey("sangar", x, z, yaw).ok) { build.place("sangar", x, z, yaw, cell); break search; }
        }
      }
    }
  }
  /** An ambush screen a few metres in front of a band lying up, toward its target. */
  function buildScreen(b, men, c) {
    const build = app.algBuild, aln = app.algEconomy?.aln;
    if (!build || !aln?.canAfford(build.costOf?.("ambushScreen") ?? 25)) return;
    const shown = Object.entries(app.showroom ?? {}).some(([k, o]) => /ambushScreen/.test(o?.userData?.kitKey ?? k) && o.parent && Math.hypot(o.position.x - c.x, o.position.z - c.z) < P.screenApart);
    if (shown) return;
    const tg = b.target.at, a0 = Math.atan2(tg.z - c.z, tg.x - c.x);
    // A few spots in front of the band (a hillside in scrub refuses many:
    // too steep, a bush's footprint).
    for (const r of [4, 6, 3, 8]) {
      for (const da of [0, 0.35, -0.35, 0.7, -0.7]) {
        const x = c.x + Math.cos(a0 + da) * r, z = c.z + Math.sin(a0 + da) * r;
        // The screen's +Z (its men's side) toward the band: its front (-Z) faces the target.
        const yaw = Math.atan2(-(tg.x - x), -(tg.z - z));
        const sv = build.survey("ambushScreen", x, z, yaw);
        if (sv.ok) { build.place("ambushScreen", x, z, yaw, men, { stay: true }); lastScreen = "placed"; return; }
        lastScreen = sv.why;
      }
    }
  }
  let lastScreen = null;       // dev: the last screen attempt's result
  // Villages the French took back: the next band's mission (newest first).
  const lostVillages = [];
  const lastOwner = new Map();
  function watchVillages() {
    for (const v of app.algEconomy?.points ?? []) {
      const was = lastOwner.get(v);
      if (was === "enemy" && v.owner !== "enemy") {
        lostVillages.unshift({ v, at: t });
        nextBand = Math.min(nextBand, P.retakeSoon);
      }
      lastOwner.set(v, v.owner);
    }
    while (lostVillages.length && t - lostVillages.at(-1).at > P.retakeWindow) lostVillages.pop();
  }

  function plan(b) {
    const m = alive(b);
    const c = centre(m);
    // A village the French just took from us comes first: go and take it back.
    if (!b.mission || b.mission === "retake") {
      const lost = lostVillages.find((l) => l.v.owner !== "enemy");
      if (lost && planVillage(b, lost.v)) { b.mission = "village"; b.retake = true; return; }
    }
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
    sendBand(b, spot);
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
      watchVillages();
      nextBand -= dt;
      if (nextBand <= 0) {
        nextBand = rand(...P.bandEvery) * (pool > 6 ? 0.7 : 1);
        if (pool > 0) pool = Math.max(0, pool - 4);
        newBand();
      }
    },
    /** Dev: a band now. */
    bandNow() { newBand(); },
    /** The next band in `s` seconds (algDifficulty.js, at the start). */
    restartClock(s) { nextBand = s; },
    /** Dev: the last ambush-screen attempt ("placed" or why not). */
    get lastScreen() { return lastScreen; },
    /** Dev: the ambush spot a band at `from` would take on French at `tgt`. */
    ambushSpotFor: (from, tgt) => ambushSpot(from, tgt),
    /** Dev: the via point a band at `from` would take round the French MGs to `to` (null: straight). */
    routeFor: (from, to) => detour(from, to, frenchMGs()),
    /** Dev: what each band is doing. */
    describe() {
      return bands.map((b) => `${b.state}${b.via ? " (round the guns)" : ""}${b.mission === "village" && b.village ? ` (${b.village.name})` : b.mission === "mine" ? " (mine)" : ""} ${alive(b).length}/${b.state === "gather" ? b.size : b.start}`).join(" · ") || "no band out";
    },
  };
}
