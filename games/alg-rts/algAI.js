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
// Or, about 45% of the time when one is worth it, a SUPPLY RAID (2026-10-04, you: "the ALN goes
// for the supply points and cuts the lines"): the band goes for a French fuel / munitions point
// (algEconomy.js supply) — the one the most other points hang on first (take it and the far ones
// are CUT OFF from the post), lightly guarded, not under the post's guns — stands in its ring
// holding fire until it turns, loots the depot (the ALN purse) and melts away. A keystone point
// keeps a cell of two to hold it. French coming: it strikes, as a village band does.
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
import { ARMOUR, faceHit } from "./algArmour.js";
import { TRACK_LINES, nearestTrack } from "./algTracks.js";
import { PLAY } from "./layout.js";

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
  strikeTime: [18, 30],
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
  mgPerCache: 2,              // FM teams each standing arms cache arms
  seeMen: 50, seeLookout: 110, seeVillage: 90,   // what the FLN knows (knownFrench)
  lookoutHurry: 12,           // s: a lookout spots French → the next band within this
  convoyFirst: 150,           // s to the first mule train
  convoyEvery: [200, 280],    // s between mule trains
  convoyEscort: 3,            // porters with the donkeys
  convoyPace: 0.45,           // their walk (donkey pace)
  convoyLoad: 150,            // supplies the load is worth
  // ── 2026-10-02: the approach routes (coverRoute) and new caches ──
  routeCell: 12,              // m: the route grid
  routePad: 70,               // m round both ends the route may swing through
  routeMax: 56,               // cells a side at most (a long way: coarser cells)
  routeSight: 110,            // m: French this near a cell see it (less through scrub)
  routeEvery: 4,              // cells between waypoints
  cacheFirst: 120,            // s before the FLN first checks for a lost cache
  cacheEvery: 45,             // s between its checks
  cacheMin: 2,                // it keeps at least this many (or as many as it started with)
  // ── 2026-10-02: an enemy that fights back ──
  fireBackAt: 0.1,            // suppression that counts as "under fire" (rifles add 0.12 a round)
  strikeMax: 50,              // s a strike may run while the band is not losing
  strikeExtend: 8,            // s added each time it is still winning
  rearguard: [6, 10],         // s a band running home turns and fights, once
  rearguardNear: 35,          // m: French this close to a band running home
  defendRadius: 90,           // m: French this near a held village = it is threatened
  defendDivert: 450,          // m: a band out this near may be sent to defend
  defendSoon: 8,              // s: otherwise the next band within this
  defendQuiet: 25,            // s with no French near before a defending band moves on
  assaultFirst: 330,          // s to the first assault
  assaultEvery: [220, 320],   // s between assaults
  assaultSize: [8, 11],       // men (two FMs while the caches allow)
  assaultBreak: 0.55,         // share lost: the assault breaks
  assaultMax: 150,            // s an assault lasts at most
  // ── 2026-10-04: supply raids ──
  raidShare: 0.45,            // of the bands, when a supply point is worth raiding
  raidLoot: 60,               // supplies the ALN takes from a depot it turns
  raidMin: 0.4,               // the least score worth a raid (pickRaid)
  emptyAmbushHome: 2,         // empty ambushes in a row (nobody came): the band goes home
  // ── 2026-10-06: FIRE AND MANOEUVRE (the assault no longer walks in as one blob) ──
  baseRing: [28, 40],         // m from the target: the base of fire (in cover, a line on it)
  flankRing: [20, 30],        // m from the target: the manoeuvre group's flank
  flankAngle: [1.2, 1.9],     // rad off the base's line round the target
  suppressedShare: 0.5,       // of the French there suppressed / pinned: the flank goes in
  baseFireMax: 25,            // s of covering fire before it goes in anyway
  deployMax: 90,              // s to get into place at all
  houseThrow: 18,             // m from a French-held house the grenadiers go to
  smokeNear: 45,              // m: French this close when the band withdraws / goes in → smoke
  // THE CAP FOLLOWS THE VILLAGES (balance 2026-10-04: the purse piled up past 2000 unspent —
  // the cap was the only limit, so taking FLN villages cost it nothing): fighters out at most =
  // maxLive × (capBase + capPerVillage × villages it holds) — Normal 18 → 34.
  capBase: 0.7, capPerVillage: 0.15,
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

  // HOME: where a man goes to ground — the nearest REFUGE (a casemate the
  // French have not found and destroyed: algLandmarks.js), or the cave.
  const refugeMouths = new Map();
  // The cave's mouth on open ground: on the 2 m grid (2026-10-06) its point fell on a blocked
  // cell — men withdrawing had no path home and were re-sent every tick.
  let caveHome = null;
  function homeFor(p) {
    caveHome ??= app.navGrid?.nearestOpenWorld?.(caveMouth.x, caveMouth.z, true) ?? caveMouth;
    let best = caveHome, bd = dist(p, caveHome);
    for (const s of app.algStructures?.list ?? []) {
      if (s.typeKey !== "refuge" || !s.alive) continue;
      let m = refugeMouths.get(s);
      if (!m) { m = app.navGrid?.nearestOpenWorld?.(s.position.x, s.position.z, true) ?? s.position; refugeMouths.set(s, m); }
      const d = dist(p, m);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  const sendHome = (u) => { u.home = homeFor(u.position); u.orderTo(u.home.x, u.home.z); };
  const atHome = (u) => dist(u.position, u.home ?? caveMouth) < 5;

  const alive = (b) => b.members.filter((u) => u.alive);
  const centre = (list) => {
    let x = 0, z = 0;
    for (const u of list) { x += u.position.x; z += u.position.z; }
    return { x: x / Math.max(1, list.length), z: z / Math.max(1, list.length) };
  };
  const french = () => units.list.filter((u) => u.alive && u.team === "player");
  const liveFighters = () => units.list.filter((u) => u.alive && u.team === "enemy").length;
  const cap = () => Math.round(P.maxLive * (P.capBase + P.capPerVillage * (app.algEconomy?.heldByEnemy ?? 0)));

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

  /**
   * WHAT THE FLN KNOWS (2026-10-01): French its own men can see, French near
   * a village that backs it (the villagers talk), and French a LOOKOUT on a
   * crest can see. It used to know every French unit on the map; now the
   * lookouts are its eyes — destroy them and its ambushes go blind.
   */
  function knownFrench() {
    const eyes = [];
    for (const u of units.list) if (u.alive && u.team === "enemy" && !u.ghost) eyes.push({ x: u.position.x, z: u.position.z, r: P.seeMen });
    for (const s of app.algStructures?.list ?? []) if (s.alive && s.typeKey === "lookout") eyes.push({ x: s.position.x, z: s.position.z, r: P.seeLookout });
    for (const v of app.algEconomy?.points ?? []) if (v.owner === "enemy") eyes.push({ x: v.position.x, z: v.position.z, r: P.seeVillage });
    return french().filter((f) => !f.isAir && eyes.some((e) => (f.position.x - e.x) ** 2 + (f.position.z - e.z) ** 2 < e.r * e.r));
  }

  /** The French to hit: a group out in the open, away from the post first. */
  function pickTarget(from) {
    const fr = knownFrench();
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
    const from = centre(alive(b));
    b.route = coverRoute(from, to);
    if (b.route == null) { const v = detour(from, to, frenchMGs()); b.route = v ? [v] : []; }
    b.via = b.route[0] ?? null;
    moveBand(b, b.via ?? to);
  }

  /**
   * THE APPROACH IS THE AMBUSH (2026-10-02, the TODO's "hug the gullies and
   * scrub"): the band's way to `to` is a ROUTE found on a coarse grid
   * (P.routeCell m) round both ends, each cell priced by what a man crossing
   * it risks — inside an MG's reach; in sight of French the FLN knows of (the
   * nearer and the more open, the worse); on a crest against the sky — and
   * what helps him: scrub and tall plants (the cover map's concealment), LOW
   * ground (a gully, a wadi: lower than the ground round it). A*, then
   * thinned to a few waypoints the band walks one by one (stepBand). Null: no
   * route (the caller falls back to the MG detour). [] : straight is fine.
   */
  function coverRoute(from, to) {
    const C = P.routeCell, pad = P.routePad;
    const spanX = Math.abs(to.x - from.x) + 2 * pad, spanZ = Math.abs(to.z - from.z) + 2 * pad;
    const cs = Math.max(C, spanX / (P.routeMax - 1), spanZ / (P.routeMax - 1));
    const nx = Math.ceil(spanX / cs) + 1, nz = Math.ceil(spanZ / cs) + 1;
    const x0 = Math.min(from.x, to.x) - pad, z0 = Math.min(from.z, to.z) - pad;
    const wx = (i) => x0 + i * cs, wz = (j) => z0 + j * cs;
    const mgs = frenchMGs(), seen = knownFrench().map((f) => f.position);
    const H = (x, z) => app.getWorldHeight(x, z);
    const N = nx * nz;
    const price = new Float32Array(N).fill(-1);
    const priceAt = (i, j) => {
      const k = j * nx + i;
      if (price[k] >= 0) return price[k];
      const x = wx(i), z = wz(j);
      if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) return (price[k] = 1e9);
      const conceal = Math.min(1, cover(x, z));
      // Low ground: below the mean of a ring round it (a gully < 0 < a crest).
      const h = H(x, z), r = cs * 1.4;
      const rel = h - (H(x + r, z) + H(x - r, z) + H(x, z + r) + H(x, z - r)) / 4;
      let sight = 0;
      for (const f of seen) {
        const d = Math.hypot(f.x - x, f.z - z);
        if (d < P.routeSight) sight += 1 - d / P.routeSight;
      }
      const c = 1
        + mgExposure(x, z, mgs, 6) * 6
        + sight * 3 * (1 - conceal * 0.7) * (rel > 0.5 ? 1.5 : 1)
        - conceal * 0.45
        + Math.max(-0.4, Math.min(0.8, rel * 0.25));
      return (price[k] = Math.max(0.35, c));
    };
    const cellOf = (p) => [
      Math.max(0, Math.min(nx - 1, Math.round((p.x - x0) / cs))),
      Math.max(0, Math.min(nz - 1, Math.round((p.z - z0) / cs))),
    ];
    // An end on a blocked cell (a house, the cave's rock): the nearest open one.
    const openNear = ([i, j]) => {
      if (priceAt(i, j) < 1e9) return [i, j];
      for (let r = 1; r < 6; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const a = i + di, c = j + dj;
        if (a >= 0 && c >= 0 && a < nx && c < nz && priceAt(a, c) < 1e9) return [a, c];
      }
      return [i, j];
    };
    const [si, sj] = openNear(cellOf(from)), [ti, tj] = openNear(cellOf(to));
    const g = new Float32Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
    const goal = tj * nx + ti;
    const hcost = (k) => Math.hypot((k % nx) - ti, Math.floor(k / nx) - tj) * 0.35;
    const open = [[0, sj * nx + si]];
    g[sj * nx + si] = 0;
    let found = false;
    while (open.length) {
      // A plain open list (grids are at most routeMax²: fast enough).
      let bi = 0;
      for (let q = 1; q < open.length; q++) if (open[q][0] < open[bi][0]) bi = q;
      const k = open[bi][1];
      open[bi] = open[open.length - 1]; open.pop();
      if (done[k]) continue;
      done[k] = 1;
      if (k === goal) { found = true; break; }
      const i = k % nx, j = (k - i) / nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, c = j + dj;
        if (a < 0 || c < 0 || a >= nx || c >= nz) continue;
        const n = c * nx + a;
        if (done[n]) continue;
        const p = priceAt(a, c);
        if (p >= 1e9) continue;
        const ng = g[k] + p * (di && dj ? 1.414 : 1);
        if (ng < g[n]) { g[n] = ng; prev[n] = k; open.push([ng + hcost(n), n]); }
      }
    }
    if (!found) return null;
    const path = [];
    for (let k = goal; k >= 0; k = prev[k]) path.push(k);
    path.reverse();
    const pts = [];
    for (let q = P.routeEvery; q < path.length - 1; q += P.routeEvery) pts.push({ x: wx(path[q] % nx), z: wz(Math.floor(path[q] / nx)) });
    // Nearly straight anyway: not worth the stops.
    const L = dist(from, to) || 1;
    let off = 0;
    for (const p of pts) off = Math.max(off, Math.abs(((to.x - from.x) * (from.z - p.z) - (from.x - p.x) * (to.z - from.z)) / L));
    lastRoute = { from, to, pts, off: Math.round(off), cells: N };
    return off < cs * 1.2 ? [] : pts;
  }
  let lastRoute = null;   // dev: the last route found

  /**
   * NEW ARMS CACHES (2026-10-02, the TODO's "the FLN building new caches in
   * villages it holds"). Each standing cache arms two FM teams (mgRoom), so
   * destroying them was a one-way win. Now: while it has fewer caches than it
   * started with, every P.cacheEvery s the FLN looks for a village it HOLDS
   * with a cell in it (garrisonOf), and the cell hides a new one among the
   * houses — the most concealed spot round the village that will take it
   * (algBuild survey) — paid from the ALN purse, raised by the cell's men in
   * P.cacheTime s. Hidden from the French (fog) until seen, site and cache
   * alike; found, it is the same objective as the first ones. So holding
   * villages back from the FLN is how the caches stop coming back.
   */
  let cacheT = P.cacheFirst, cacheSite = null, cacheWhy = null, cacheStart = -1;
  const liveCaches = () => (app.algStructures?.list ?? []).filter((s) => s.typeKey === "armsCache" && s.alive).length;
  function stepCaches(dt, force = false) {
    if (cacheStart < 0) cacheStart = Math.max(P.cacheMin, liveCaches());
    // A site under way: hidden while the French cannot see it.
    if (cacheSite) {
      const fog = app.fogOfWar;
      if (!cacheSite.done && cacheSite.alive) {
        const seen = !fog?.enabled || fog.canSeeEntity?.(cacheSite);
        if (seen) cacheSite.wasSeen = true;
        cacheSite.mesh.visible = seen || !!cacheSite.wasSeen;
        return;
      }
      cacheSite = null;
    }
    cacheT -= dt;
    if (cacheT > 0 && !force) return;
    cacheT = P.cacheEvery;
    if (liveCaches() >= cacheStart) { cacheWhy = "enough caches"; return; }
    const build = app.algBuild, aln = app.algEconomy?.aln;
    if (!build || !aln) { cacheWhy = "no build"; return; }
    if (!aln.canAfford(build.costOf("armsCache"))) { cacheWhy = "ALN cannot afford it"; return; }
    const held = (app.algEconomy?.points ?? []).filter((v) => v.owner === "enemy" && garrisonOf(v));
    if (!held.length) { cacheWhy = "no village held with a cell"; return; }
    // The held village furthest from the post (deepest in FLN country).
    held.sort((a, b) => dist(b.position, post) - dist(a.position, post));
    for (const v of held) {
      const g = garrisonOf(v), men = alive(g);
      const spots = [];
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2 + rand(-0.12, 0.12), r = rand(14, 34);
        const x = v.position.x + Math.cos(a) * r, z = v.position.z + Math.sin(a) * r;
        spots.push({ x, z, s: cover(x, z) + rand(0, 0.15) + dist({ x, z }, post) * 0.0005 });
      }
      spots.sort((p, q) => q.s - p.s);
      for (const p of spots) {
        const yaw = rand(0, Math.PI * 2);
        if (!build.survey("armsCache", p.x, p.z, yaw).ok) continue;
        build.place("armsCache", p.x, p.z, yaw, men).then((site) => {
          if (!site) return;
          cacheSite = site;
          site.mesh.visible = false;
          // Under fog from the first frame (stepCaches shows it once seen).
        });
        cacheWhy = `hiding one at ${v.name}`;
        return;
      }
    }
    cacheWhy = "no spot round the held villages";
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

  function newBand({ size: want = null, mission = null } = {}) {
    const size = want ?? Math.round(rand(...P.bandSize));
    // MEN ALREADY OUT, idle (the head start, stragglers, a convoy's escort): a band of them
    // first, whatever the cap — 19 standing at the rally over a cap of 18 never formed one.
    const idle = units.list.filter((u) => u.alive && u.team === "enemy" && !inBand.has(u) && !homebound.has(u) && !u.ghost && !u.inside && (u.typeKey === "moudjahid" || u.typeKey === "fmTeam")).length;
    if (idle >= 3) { bands.push({ state: "gather", size: Math.min(idle, size), members: [], t: 0, start: 0, mission }); return true; }
    const room = cap() - liveFighters();
    const n = Math.min(size, room);
    if (n < 3) return;
    // MEN GONE TO GROUND come back out FREE (already paid for): three or more
    // waiting → the band forms at the REFUGE nearest the front (the cave if
    // none stands) — refuges keep the katiba close and cheap; destroy them.
    if (pool >= 3) {
      const k = Math.min(pool, n);
      const front = (app.algStructures?.list ?? []).filter((s) => s.typeKey === "refuge" && s.alive)
        .map((s) => homeFor(s.position)).sort((a, b) => dist(a, post) - dist(b, post))[0] ?? cave.structure.rally;
      for (let i = 0; i < k; i++) {
        const a = (i / k) * Math.PI * 2;
        units.spawn("moudjahid", front.x + Math.cos(a) * 3, front.z + Math.sin(a) * 3, { team: "enemy" });
      }
      pool -= k;
      bands.push({ state: "gather", size: k, members: [], t: 0, start: 0, from: front, mission });
      return true;
    }
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
    // THE FM GUNNER: one in the band while the ARMS CACHES allow it (two
    // MG teams per standing cache) — the French take the caches, the MGs stop.
    let mg = 0;
    // An assault takes two FMs when the caches allow (a base of fire).
    for (let k = mission === "assault" ? 2 : 1; k > 0; k--) if (mgRoom() > 0 && cave.structure.enqueue("fmTeam")) mg++;
    bands.push({ state: "gather", size: paid + mg, members: [], t: 0, start: 0, mission });
    return true;
  }
  /** MG teams the caches still allow (out on the map + on the cave's queue counted). */
  function mgRoom() {
    const caches = (app.algStructures?.list ?? []).filter((s) => s.typeKey === "armsCache" && s.alive).length;
    const out = units.list.filter((u) => u.alive && u.team === "enemy" && u.typeKey === "fmTeam").length;
    const queued = cave.structure.queue.filter((k) => k === "fmTeam").length;
    const extra = (app.algStructures?.list ?? []).reduce((n, s) => n + (s.typeKey === "armsCache" && s.alive ? s.extraMG ?? 0 : 0), 0);
    return caches * P.mgPerCache + extra - out - queued;
  }

  function setState(b, s) { b.state = s; b.t = 0; }

  /**
   * UNDER A FLARE (algFlares.js): a band caught in the light — seen, concealment gone — that is
   * not fighting gets out of it, to just past the circle's edge on its own side. An ambush sets
   * up again there; an approach takes up its route once the flare has burnt out. Returns true
   * while it is dodging (the state's own logic waits).
   */
  function dodgeFlare(b, m) {
    const F = app.algFlares;
    if (!F?.count && !b.dodging) return false;
    const c = centre(m);
    const lit = F?.litAt(c.x, c.z);
    if (!lit) {
      // out of the light (or it burnt out): an approach goes on where it was going
      if (b.dodging) { b.dodging = false; if (b.state === "approach") moveBand(b, b.via ?? b.spot); }
      return false;
    }
    if (b.dodging && t < b.dodgeUntil) return true;   // already on the way out
    const dx = c.x - lit.x, dz = c.z - lit.z, d = Math.hypot(dx, dz) || 1;
    const to = { x: lit.x + (dx / d) * (lit.r + 12), z: lit.z + (dz / d) * (lit.r + 12) };
    moveBand(b, to);
    if (b.state === "ambush") b.spot = to;
    b.dodging = true;
    b.dodgeUntil = t + 4;
    return true;
  }

  function stepBand(b, dt) {
    b.t += dt;
    const m = alive(b);
    switch (b.state) {
      case "gather": {
        // Men out of the cave, standing (not still walking out), in no band.
        for (const u of units.list) {
          if (b.members.length >= b.size) break;
          if (!u.alive || u.team !== "enemy" || inBand.has(u) || u.ghost || u.isMoving) continue;
          if (u.typeKey !== "moudjahid" && u.typeKey !== "fmTeam") continue;
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
        // Found on the way in — fired on: it opens up (any band, 2026-10-02:
        // a village band walking on under fire read as "they never shoot").
        if (underFire(b, m)) { if (b.mission === "assault") goIn(b); else strike(b); break; }
        // Caught under a flare: out of the light first.
        if (dodgeFlare(b, m)) break;
        // Round the guns: at the via point (most of the band), on to the spot.
        if (b.via) {
          const past = m.filter((u) => dist(u.position, b.via) < 15 || !u.isMoving);
          if (past.length >= Math.ceil(m.length * 0.6)) {
            b.route?.shift();
            b.via = b.route?.[0] ?? null;
            moveBand(b, b.via ?? b.spot);
          }
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
            else { b.members.splice(b.members.indexOf(u), 1); inBand.delete(u); u.holdFire = true; homebound.add(u); sendHome(u); }
          }
          if (b.mission === "assault") { goIn(b); break; }
          setState(b, b.mission === "village" || b.mission === "defend" || b.mission === "raid" ? "occupy" : b.mission === "mine" ? "lay" : "ambush");
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
        if (b.t > P.replanEvery && b.target?.lead && dist(b.target.lead.position, b.target.at) > 35) plan(b);
        break;
      }
      case "ambush": {
        if (!m.length) return setState(b, "done");
        // The centre of the men AT the spot (a late straggler still walking in
        // is not where the ambush is).
        const near = m.filter((u) => dist(u.position, b.spot) < 15);
        const c = centre(near.length ? near : m);
        const close = french().some((u) => !u.isAir && dist(u.position, c) < P.trigger);
        if (close || underFire(b, m)) { strike(b); break; }
        // A flare over the ambush: no hiding in the light — set up again just outside it.
        if (dodgeFlare(b, m)) break;
        // Waiting: cut scrub stood up in front of them — an AMBUSH SCREEN
        // (algBuild.js, paid from the ALN purse): they are hidden behind it
        // until they fire (algCover concealment).
        if (b.t > P.screenWait && !b.screened && b.target) { b.screened = true; buildScreen(b, near.length ? near : m, c); }
        if (b.t > P.waitMax) {
          const tg = pickTarget(c);
          if (tg && dist(tg.at, c) < 80) { strike(b); for (const u of m) u.orderTo(tg.at.x, tg.at.z); }
          else {
            // NOBODY CAME (balance run 2026-10-04: two bands lay in the same scrub from minute 3
            // to 12, holding the live cap — no band, no assault after it): a new mission (a raid,
            // a village, a mine); two empty ambushes in a row, home — the cap frees for a fresh band.
            b.emptyAmbushes = (b.emptyAmbushes ?? 0) + 1;
            if (b.emptyAmbushes >= P.emptyAmbushHome) withdraw(b);
            else { b.mission = null; plan(b); }
          }
        }
        break;
      }
      case "occupy": {
        // Among the houses, holding fire: the village swings their way while
        // they stay. The French coming: open up, then go as ever.
        if (!m.length) return setState(b, "done");
        const c = centre(m);
        // DEFENDING a village it holds: it stays and fights from the houses
        // (no melting away), and moves on only once the French have gone.
        if (b.mission === "defend") {
          const near = french().some((u) => !u.isAir && dist(u.position, c) < P.villageTrigger + 25);
          holdFire(b, !near && !underFire(b, m));
          if (near) {
            b.quiet = 0;
            b.tact = (b.tact ?? 0) - dt;
            if (b.tact <= 0) { b.tact = P.tactEvery; tactics(b, m, dt); }
          } else if ((b.quiet = (b.quiet ?? 0) + dt) > P.defendQuiet || b.village?.owner !== "enemy") { defending.delete(b.village); b.mission = null; plan(b); }
          if (1 - m.length / Math.max(1, b.start) >= P.breakLoss + 0.15) withdraw(b);
          break;
        }
        if (underFire(b, m) || french().some((u) => !u.isAir && dist(u.position, c) < P.villageTrigger)) { strike(b); break; }
        // A RAID: the point turned — the depot looted, the line cut. A keystone keeps a cell of
        // two to hold it; the rest (all of them, elsewhere) melt away.
        if (b.mission === "raid") {
          if (b.village?.owner === "enemy") {
            app.algEconomy?.aln.earn(P.raidLoot);
            raids++;
            if (b.keystone && m.length >= P.cellMinBand) leaveCell(b, b.village);
            withdraw(b);
          }
          break;
        }
        // TURNED: leave a cell to hold it, the rest go on (a band that sat in
        // a won village forever was a band the war no longer had). Already
        // held (a second band arrived): on to something else. Too small to
        // split: it becomes the cell itself.
        if (b.village?.owner === "enemy") {
          if (garrisonOf(b.village)) { b.mission = null; plan(b); }
          else if (m.length >= P.cellMinBand) { leaveCell(b, b.village); b.mission = null; plan(b); }
          else { b.mission = "garrison"; b.start = m.length; holdFire(b, true); placeCell(b.village, m); setState(b, "garrison"); }
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
        const shot = underFire(b, m);
        holdFire(b, !close && !shot);
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
        if (underFire(b, m)) { strike(b); break; }
        if (!b.wire?.parent || b.t > 25) { setState(b, "approach"); sendBand(b, b.spot); }
        break;
      }
      case "lay": {
        // At the piste, holding fire: the mine goes in, and they go. French
        // turning up first: fight, then go as ever (no mine).
        if (!m.length) return setState(b, "done");
        const c = centre(m);
        if (underFire(b, m) || french().some((u) => !u.isAir && dist(u.position, c) < P.trigger)) { strike(b); break; }
        if (b.t > P.mineWork) { app.algMines?.lay(b.minePt.x, b.minePt.z); withdraw(b); }
        break;
      }
      case "strike": {
        const lost = 1 - m.length / Math.max(1, b.start);
        const c = centre(m);
        const armour = french().some((u) => !u.type?.foot && !u.isAir && dist(u.position, c) < P.armourNear);
        if (!m.length) return setState(b, "done");
        const pinned = m.filter((u) => u.pinned).length / m.length;
        // Still winning (few lost, French still there): fight on, up to strikeMax.
        if (b.t > b.strikeFor && !b.rearguardOnly && lost < P.breakLoss * 0.6 && b.t < P.strikeMax
          && french().some((u) => !u.isAir && dist(u.position, c) < P.villageTrigger + 20)) b.strikeFor += P.strikeExtend;
        if (b.t > b.strikeFor || lost >= P.breakLoss || armour || pinned >= P.pinnedBreak) { withdraw(b); break; }
        b.tact = (b.tact ?? 0) - dt;
        if (b.tact <= 0) { b.tact = P.tactEvery; tactics(b, m, dt); }
        break;
      }
      case "deploy": {
        // FIRE AND MANOEUVRE, getting into place (planFireManoeuvre).
        if (!m.length) return setState(b, "done");
        const tg = b.assault, base = b.base.filter((u) => u.alive), flank = b.flank.filter((u) => u.alive);
        const lost = 1 - m.length / Math.max(1, b.start);
        if (lost >= P.assaultBreak || b.t > P.deployMax) { if (flank.length >= 2 && b.t > P.deployMax) { goIn(b); break; } withdraw(b); break; }
        // In place: within 9 m, or stopped within 25 m (a stop far off is not "there": once more).
        const there = (list, spot) => list.length && list.filter((u) => dist(u.position, spot) < 9 || (!u.isMoving && dist(u.position, spot) < 25)).length >= Math.ceil(list.length * 0.6);
        for (const [list, spot] of [[base, b.baseSpot], [flank, b.flankSpot]]) {
          for (const u of list) {
            if (u.isMoving || dist(u.position, spot) < 25 || u._resent > t - 6) continue;
            u._resent = t;
            const q = app.navGrid?.nearestOpenWorld?.(spot.x + rand(-3, 3), spot.z + rand(-3, 3), true) ?? spot;
            u.orderTo(q.x, q.z);
          }
        }
        // The base in place (or fired on): it opens up.
        if (b.fireT == null && (there(base, b.baseSpot) || underFire(b, base))) {
          b.fireT = 0;
          for (const u of base) { u.holdFire = false; u.haltMovement?.(); }
        }
        if (b.fireT != null) b.fireT += dt;
        // The flank fired on on its way: it fires back, and keeps going.
        if (flank.some((u) => (u.suppression ?? 0) > P.fireBackAt)) for (const u of flank) u.holdFire = false;
        // In: the flank in place and the French there suppressed — or the base has fired long enough.
        if (there(flank, b.flankSpot) && b.fireT != null) {
          const fr = french().filter((u) => !u.isAir && u.type?.foot && dist(u.position, tg.at) < 22);
          const sup = fr.length ? fr.filter((u) => u.pinned || u.suppressed || (u.suppression ?? 0) > 0.3 || u.inside).length / fr.length : 1;
          if (sup >= P.suppressedShare || b.fireT > P.baseFireMax) {
            // A French-held house: grenades at it first (the garrison bails out after two).
            if (tg.house?.men.length && app.algGrenades) {
              const g = app.algGrenades;
              const gu = flank.find((u) => u.type?.grenade && !(u.grenadeCd > 0));
              if (gu) { g.order(gu, tg.house.x + rand(-1, 1), tg.house.z + rand(-1, 1)); tg.house._grenT = t; }
            }
            goIn(b);
          }
        }
        b.tact = (b.tact ?? 0) - dt;
        if (b.tact <= 0) { b.tact = P.tactEvery; tactics(b, m, dt); }
        break;
      }
      case "assault": {
        // In among them, firing: until the band breaks, the target falls
        // (a structure destroyed, a village turned: a cell is left in it), or
        // time runs out. Men who reach the target with nobody to shoot push on
        // to the nearest French in reach.
        if (!m.length) return setState(b, "done");
        const lost = 1 - m.length / Math.max(1, b.start);
        const pinned = m.filter((u) => u.pinned).length / m.length;
        const tg = b.assault;
        b.tact = (b.tact ?? 0) - dt;
        if (b.tact <= 0) {
          b.tact = P.tactEvery;
          tactics(b, m, dt);
          for (const u of m) {
            if (u._base || u.isMoving || u.target?.alive || u.attackTarget?.alive || u.pinned) continue;   // the base stays and fires
            let best = null, bd = 80;
            for (const f of french()) { if (f.isAir) continue; const d = dist(f.position, u.position); if (d < bd) { bd = d; best = f; } }
            // AN FM GUNNER (algMgTeam.js) is the band's base of fire, not a stormer: in reach, it
            // swings its arc onto him; out of reach, it goes only as far as firing range.
            if (best && u.typeKey === "fmTeam" && app.algMgTeams) {
              if (bd <= u.range * 1.05) { app.algMgTeams.aimAt(u, best.position.x, best.position.z); continue; }
              const k = (bd - u.range * 0.75) / bd;
              u.orderTo(u.position.x + (best.position.x - u.position.x) * k, u.position.z + (best.position.z - u.position.z) * k);
              continue;
            }
            if (best) u.orderTo(best.position.x, best.position.z);
          }
        }
        if (tg.village?.owner === "enemy") { leaveCell(b, tg.village); withdraw(b); break; }
        if (tg.structure && !tg.structure.alive) { withdraw(b); break; }
        if (lost >= P.assaultBreak || pinned >= 0.6 || b.t > P.assaultMax) withdraw(b);
        break;
      }
      case "withdraw": {
        if (!m.length) return setState(b, "done");
        // PRESSED on the way home: they turn and fight once (a rearguard),
        // then run on. Not when armour is on them (they just run).
        {
          const c = centre(m);
          const pressed = underFire(b, m) && french().some((u) => !u.isAir && u.type?.foot && dist(u.position, c) < P.rearguardNear);
          if (pressed && !b.rearguarded) {
            b.rearguarded = true; b.rearguardOnly = true;
            for (const u of m) u.haltMovement?.();
            strike(b, rand(...P.rearguard));
            break;
          }
        }
        // Into the mouth: gone to ground. They count toward the next band.
        for (const u of m) if (atHome(u)) goToGround(u);
        if (!alive(b).length) setState(b, "done");
        else if (b.t > 150) { for (const u of alive(b)) if (!u.isMoving) goToGround(u); }   // no way home (a pocket, measured: 2 men stood 6 min): they slip away into the djebel
        else if (b.t > 90 && (b.resent = (b.resent ?? 0) - dt) <= 0) { b.resent = 5; for (const u of alive(b)) sendHome(u); }   // stragglers, every 5 s (not every tick)
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
      // A set-up machine gun stays and fires (algMgTeam.js): it does not run for cover.
      if (app.algMgTeams?.stateOf(u) === "set") continue;
      // ARMOUR BY FACING (algArmour.js): a man shooting at an armoured vehicle's FRONT goes round to
      // its side (every 6 s at most) — his rounds glance off the front.
      const tv = u.target;
      if (tv?.alive && ARMOUR.types[tv.typeKey] && (u._flankT ?? -99) < t - 6 && faceHit(tv, u.position.x, u.position.z) === 0) {
        u._flankT = t;
        const d = Math.max(14, Math.min(u.range * 0.8, dist(u.position, tv.position)));
        // To the side he is already nearer (the shortest way off the front).
        const rel = Math.atan2(u.position.x - tv.position.x, u.position.z - tv.position.z) - (tv.heading ?? 0);
        const side = (Math.sin(rel) >= 0 ? 1 : -1) * Math.PI / 2;
        const a = (tv.heading ?? 0) + side + (Math.random() - 0.5) * 0.5;
        const q = app.navGrid?.nearestOpenWorld?.(tv.position.x + Math.sin(a) * d, tv.position.z + Math.cos(a) * d, true);
        if (q) { u.orderTo(q.x, q.z); continue; }
      }
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
    // A house the French hold (algGarrison.js): a grenade in it is worth the most.
    // (one grenade a house every 10 s: they pile up otherwise — the bail-out is what clears it)
    for (const h of app.algGarrison?.houses ?? []) if (h.team === "player" && h.men.length && t - (h._grenT ?? -1e9) > 10) fr.push({ alive: true, team: "player", house: h, position: { x: h.x, y: 0, z: h.z } });
    let best = null, bestS = 0;
    for (const u of m) {
      if (!u.type?.grenade || u.grenadeCd > 0 || u.throwing || u.pinned) continue;
      for (const f of fr) {
        if (!f.alive || f.team !== "player" || f.isAir) continue;
        const d = dist(f.position, u.position);
        if (d > R || d < blast + 1) continue;   // not on his own head
        let s;
        if (f.house) s = 2 + f.house.men.length * 0.6;
        else if (f.isStructure) s = (f.weapon ?? f.type?.weapon) === "mg" ? 2.5 : 0;
        else if (!f.type?.foot) s = 0;
        else {
          // Men round him in the blast; worth it bunched or in cover.
          let n = 0;
          for (const o of units.near(f.position.x, f.position.z, blast, _near)) if (o.alive && o.team === "player" && o.type?.foot && dist(o.position, f.position) < blast) n++;
          s = n + (f.inCover || f.posture === "kneel" ? 1.5 : 0) - 1.2;
        }
        if (s > bestS) { bestS = s; best = { u, x: f.position.x, z: f.position.z, house: f.house ?? null }; }
      }
    }
    if (!best) return;
    if (best.house) best.house._grenT = t;
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

  // ── THE SUPPLY RAIDS (2026-10-04) ───────────────────────────────────────
  /** How many French points hang on `s`: linked now, cut off from the post were it to fall. */
  function cutsOff(s) {
    const E = app.algEconomy;
    if (!E || !post) return 0;
    const held = E.allPoints.filter((v) => v.owner === "player" && v !== s);
    const reach = new Set(), front = [{ position: post }];
    for (let i = 0; i < front.length; i++) {
      for (const v of held) if (!reach.has(v) && dist(v.position, front[i].position) <= E.params.link) { reach.add(v); front.push(v); }
    }
    return held.filter((v) => v.linked && !reach.has(v)).length;
  }
  /**
   * A supply point worth raiding (or null): French-held and linked first, more for each point
   * that hangs on it; neutral ones a little (deny them); fewer guards, nearer, better; none
   * under the post's guns, none another band is already raiding.
   */
  function pickRaid(from) {
    let best = null, bestS = P.raidMin;
    for (const s of app.algEconomy?.supply ?? []) {
      if (s.owner === "enemy") continue;
      if (bands.some((b) => b.mission === "raid" && b.village === s && alive(b).length)) continue;
      const guards = french().filter((u) => !u.isAir && dist(u.position, s.position) < 60).length;
      let sc = s.owner === "player" ? (s.linked ? 1.6 + 0.7 * cutsOff(s) : 0.7) : 0.5;
      sc -= guards * 0.6 + dist(from, s.position) / 700;
      if (dist(s.position, post) < P.postKeepOff + 40) sc -= 1;
      if (sc > bestS) { bestS = sc; best = s; }
    }
    return best;
  }
  function planRaid(b, s) {
    if (!planVillage(b, s)) return false;
    b.mission = "raid";
    b.keystone = cutsOff(s) > 0;
    return true;
  }
  let raids = 0;

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
      const sup = v.kind === "supply";   // a supply point's ring is 22 m, not 40
      const r = (sup ? 6 : 12) + i * (sup ? 1 : 1.5), aa = a + (i % 2 ? 1 : -1) * i * 0.25;
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

  // ── THE MULE TRAIN (2026-10-01): arms from the frontier to a cache ────────
  // An escort of porters (units: it can be ambushed) walks the donkeys
  // (algHerds.js convoy, their anchor on the escort) from the map's edge on
  // the FLN's side to the cache furthest from the French, holding fire. It
  // arrives: the ALN purse gets the load, the cache arms one more gunner.
  // French close: the escort fights; all of it dead: the load is lost.
  let convoy = null, nextConvoy = P.convoyFirst;
  /**
   * Where a mule train enters: a point just inside the play box's edge on the
   * FLN's side, far from the post — and one with a ROUTE to the cache (the
   * first try picked the box's corner, a cliff: the escort never moved).
   */
  const frontier = (to) => {
    const cands = [];
    for (let k = 1; k < 40; k++) {
      const f = k / 40;
      for (const p of [{ x: PLAY.x0 + 14, z: PLAY.z0 + f * (PLAY.z1 - PLAY.z0) }, { x: PLAY.x0 + f * (PLAY.x1 - PLAY.x0), z: PLAY.z0 + 14 }]) {
        if (app.navGrid?.isBlockedAtWorld?.(p.x, p.z, true)) continue;
        if ((app.getWorldNormal?.(p.x, p.z)?.y ?? 1) < 0.85) continue;
        if (dist(p, to) < 90) continue;
        cands.push({ ...p, s: dist(p, post) - 0.5 * dist(p, caveMouth) + rand(0, 40) });
      }
    }
    cands.sort((a, b) => b.s - a.s);
    for (const p of cands.slice(0, 8)) {
      const path = app.navGrid?.findPath?.(p.x, p.z, to.x, to.z, { foot: true });
      if (path?.length) return p;
    }
    return null;
  };
  function startConvoy() {
    const caches = (app.algStructures?.list ?? []).filter((s) => s.typeKey === "armsCache" && s.alive);
    const herd = app.algHerds?.convoy;
    if (!caches.length) return;
    const to = caches.reduce((a, b) => (dist(b.position, post) > dist(a.position, post) ? b : a));
    const from = frontier(to.position);
    if (!from) return;
    const men = [];
    for (let i = 0; i < P.convoyEscort; i++) {
      const u = units.spawn("moudjahid", from.x + (i - 1) * 2.5, from.z + (i % 2) * 2.5, { team: "enemy" });
      if (!u) continue;
      u.speedScale = P.convoyPace; u.holdFire = true; inBand.add(u);   // (moveMul is the posture's, reset each tick)
      u.orderTo(to.position.x + (i - 1) * 3, to.position.z + 6);
      men.push(u);
    }
    if (!men.length) return;
    convoy = { men, to, t: 0, fighting: false, seen: false };
    if (herd) { herd.place?.(from.x, from.z); herd.anchor.moving = true; }
    // The porters walk at the DONKEYS' pace (a loaded donkey on a lead, ~1 m/s).
    const pace = Math.min(1, (herd?.walk ?? 1) * 0.85 / 6);   // a little under the donkeys: they keep up
    for (const u of men) u.speedScale = pace;
  }
  function stepConvoy(dt) {
    if (!convoy) {
      if ((nextConvoy -= dt) <= 0) { nextConvoy = rand(...P.convoyEvery); startConvoy(); }
      return;
    }
    convoy.t += dt;
    const live = convoy.men.filter((u) => u.alive);
    const herd = app.algHerds?.convoy;
    const end = (ok) => {
      if (ok) {
        app.algEconomy?.aln.earn(P.convoyLoad);
        convoy.to.extraMG = (convoy.to.extraMG ?? 0) + 1;
        for (const u of live) { u.holdFire = true; u.speedScale = 1; homebound.add(u); sendHome(u); }
      }
      convoy.outcome = ok ? "arrived" : "lost";
      lastConvoy = convoy;
      if (herd) herd.anchor.moving = false;
      for (const u of convoy.men) inBand.delete(u);
      convoy = null;
    };
    if (!live.length || !convoy.to.alive) return end(false);
    const c = centre(live);
    // The donkeys walk behind the escort's middle, facing its way.
    if (herd) {
      const A = herd.anchor, dx = c.x - A.x, dz = c.z - A.z, d = Math.hypot(dx, dz);
      // As fast as the escort (6 m/s × convoyPace), a little more to close up.
      const st = Math.min(Math.max(0, d - 3), (herd.walk ?? 1) * 0.9 * dt);
      if (d > 0.01) { A.x += (dx / d) * st; A.z += (dz / d) * st; A.yaw = Math.atan2(dx, dz); }
      A.moving = st > 0.01;
    }
    // French close: the escort fights (the donkeys stand); clear again: on.
    const near = french().some((u) => !u.isAir && dist(u.position, c) < P.villageTrigger);
    if (near !== convoy.fighting) {
      convoy.fighting = near;
      for (const u of live) { u.holdFire = !near; if (near) u.haltMovement?.(); else u.orderTo(convoy.to.position.x, convoy.to.position.z + 6); }
    }
    if (dist(c, convoy.to.position) < 14) end(true);
  }
  let lastConvoy = null;

  // ── Garrisons, retakes, building (2026-10-01) ─────────────────────────────
  const garrisonOf = (v) => bands.find((g) => g.state === "garrison" && g.village === v && alive(g).length);
  /** A village's cell: INTO A HOUSE when one is free near its middle (algGarrison.js — the
   *  French need grenades or the mortar to get it out), else spots in cover among the houses. */
  function placeCell(v, men) {
    const G = app.algGarrison;
    const h = G?.houseNear(v.position.x, v.position.z, 34, "enemy", men.length);
    if (h && G.order(men, h, { ai: true })) return;
    cellSpots(v, men.length).forEach((p, i) => men[i]?.orderTo(p.x, p.z));
  }
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
    placeCell(v, cell);
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

  // THE LOOKOUTS' SIGNAL: a lookout that starts seeing French hurries the
  // next band out (it goes for them: pickTarget knows them now).
  const lookoutSaw = new WeakMap();
  let lastSignal = null;
  function watchLookouts() {
    const fr = french().filter((f) => !f.isAir);
    for (const s of app.algStructures?.list ?? []) {
      if (s.typeKey !== "lookout" || !s.alive) continue;
      const sees = fr.some((f) => dist(f.position, s.position) < P.seeLookout);
      if (sees && !lookoutSaw.get(s)) { nextBand = Math.min(nextBand, P.lookoutHurry); lastSignal = { at: { x: s.position.x, z: s.position.z }, t }; }
      lookoutSaw.set(s, sees);
    }
  }

  function plan(b) {
    const m = alive(b);
    const c = centre(m);
    // A village of ours with French at the door: go and hold it (defend).
    if (b.mission === "defend" || (!b.mission && defendNeed())) {
      const v = b.mission === "defend" ? b.village : defendNeed();
      if (v && v.owner === "enemy" && planVillage(b, v)) { b.mission = "defend"; b.village = v; defending.add(v); return; }
      b.mission = null;
    }
    // An ASSAULT: a big band against what the French hold.
    if (b.mission === "assault") {
      if (planAssault(b)) return;
      b.mission = null;
    }
    // A village the French just took from us comes first: go and take it back.
    if (!b.mission || b.mission === "retake") {
      const lost = lostVillages.find((l) => l.v.owner !== "enemy");
      if (lost && planVillage(b, lost.v)) { b.mission = "village"; b.retake = true; return; }
    }
    // A SUPPLY RAID, about 45% of the time one is worth it (or still on: re-planned on the way).
    if (b.mission === "raid") {
      const s = b.village && b.village.owner !== "enemy" ? b.village : pickRaid(c);
      if (s && planRaid(b, s)) return;
      b.mission = null;
    }
    if (!b.mission && Math.random() < P.raidShare) {
      const s = pickRaid(c);
      if (s && planRaid(b, s)) return;
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
    // NOBODY KNOWN (the FLN sees only what its men, villages and lookouts
    // see): work a village if one is there to take; otherwise lie in wait by
    // a PISTE, 150-380 m from the post — where the French patrols must come.
    let tgt = tg;
    if (!tgt) {
      const v = pickVillage(c);
      if (v && planVillage(b, v)) return;
      const pts = TRACK_LINES.filter((t) => t.kind === "piste").flatMap((t) => t.line).filter((p) => { const d = dist(p, post); return d > 150 && d < 380; });
      if (!pts.length) { setState(b, "gather"); b.t = 0; return; }
      const p = pts.sort((p1, p2) => dist(p1, c) - dist(p2, c))[Math.floor(Math.random() * Math.min(8, pts.length))];
      tgt = { lead: null, at: { x: p.x, z: p.z }, size: 0 };
    }
    const spot = ambushSpot(c, tgt.at);
    if (!spot) { withdraw(b); return; }
    b.target = tgt; b.spot = spot;
    holdFire(b, true);
    sendBand(b, spot);
    setState(b, "approach");
  }

  function strike(b, secs = null) {
    holdFire(b, false);
    b.strikeFor = secs ?? rand(...P.strikeTime);
    setState(b, "strike");
  }

  // ── 2026-10-02: AN ENEMY THAT FIGHTS (you: "the enemies don't even try to
  // fire at me"). Bands held their fire walking, occupying, laying mines and
  // running home, and broke off after 12-22 s. Now: FIRED ON, they fire back
  // whatever they were doing; a strike goes on while they are not losing; a
  // band running home turns and fights a rearguard once when pressed; the
  // villages they hold are DEFENDED (the next band, or one on its way, goes
  // there); and every few minutes they ASSAULT what the French hold. ──

  /** Hit since the last look, or under fire (suppression), or shot at just now. */
  function underFire(b, m) {
    let hp = 0;
    for (const u of m) hp += u.hp ?? 0;
    const hit = b.lastHp != null && hp < b.lastHp - 0.5;
    b.lastHp = hp;
    return hit || m.some((u) => (u.suppression ?? 0) > P.fireBackAt || (u.firedOnBy?.alive && u.firedOnBy.team === "player" && dist(u.firedOnBy.position, u.position) < 60 && (u.suppression ?? 0) > 0.02));
  }

  /** A held village with French at its door and nobody yet sent (or null). */
  const defending = new Set();
  function defendNeed() {
    for (const v of app.algEconomy?.points ?? []) {
      if (v.owner !== "enemy") { defending.delete(v); continue; }
      if (defending.has(v) && bands.some((b) => b.mission === "defend" && b.village === v && alive(b).length)) continue;
      defending.delete(v);
      if (french().some((u) => !u.isAir && dist(u.position, v.position) < P.defendRadius)) return v;
    }
    return null;
  }
  /** Divert a band already out (not fighting, not retaking) to a threatened village. */
  function sendDefence() {
    const v = defendNeed();
    if (!v) return;
    let best = null, bd = P.defendDivert;
    for (const b of bands) {
      if (b.state !== "approach" && b.state !== "ambush") continue;
      if (b.mission === "assault" || b.mission === "defend" || b.retake) continue;
      const d = dist(centre(alive(b)), v.position);
      if (d < bd && alive(b).length >= 3) { bd = d; best = b; }
    }
    if (best && planVillage(best, v)) { best.mission = "defend"; best.village = v; defending.add(v); }
    else nextBand = Math.min(nextBand, P.defendSoon);
  }

  /**
   * An ASSAULT's target: a village the French hold (fewest guards, nearest
   * the cave), else one of their outposts (a nest, a mirador, a mortar pit,
   * sandbags… nearest the cave), else their troops in the field, else the
   * post's outskirts. Stage 50-70 m short (ambushSpot, cover), then go in.
   */
  /** A line of fire from a spot on the ground to `at` (algSight: ridges and tall buildings). */
  const sightFrom = (x, z, at) => {
    const S = app.algSight;
    if (!S) return true;
    const a = { position: { x, y: app.getWorldHeight(x, z), z }, type: { foot: true } };
    const b2 = { position: { x: at.x, y: app.getWorldHeight(at.x, at.z), z: at.z }, type: { foot: true } };
    return !S.blocker(a, b2);
  };
  /** A spot round `at`, `ring` m out, around angle `a0` ± `spread`: open, out of the MGs, scored. */
  function spotAround(at, a0, spread, ring, { needSight = false, mgs = frenchMGs(), from = null } = {}) {
    let best = null, bestS = -Infinity;
    for (let i = 0; i < 32; i++) {
      const a = a0 + rand(-spread, spread), r = rand(...ring);
      const x = at.x + Math.cos(a) * r, z = at.z + Math.sin(a) * r;
      if (app.navGrid?.isBlockedAtWorld?.(x, z, true)) continue;
      // REACHABLE from the band (open but cut off, the flank stood 163 m away for 90 s).
      if (from && app.navGrid?.sameRegion && !app.navGrid.sameRegion(from.x, from.z, x, z)) continue;
      if (dist({ x, z }, post) < P.postKeepOff) continue;
      if (mgExposure(x, z, mgs, 4) > 0) continue;
      if (needSight && !sightFrom(x, z, at)) continue;
      const s = cover(x, z) * 2 + Math.max(-1, Math.min(1, (app.getWorldHeight(x, z) - app.getWorldHeight(at.x, at.z)) / 15)) - r / 200 + rand(0, 0.2);
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    return best;
  }
  /**
   * SMOKE (2026-10-06, the FLN's brain): one man throws a smoke grenade a third of the way from
   * the band toward the nearest French within smokeNear — a screen across their line of fire
   * (algSmoke: nobody sees or shoots through it). When it withdraws under fire, when its flank
   * goes in. Free for the ALN (no purse).
   */
  function throwSmoke(men) {
    const g = app.algGrenades;
    if (!g || !men.length) return false;
    const c = centre(men);
    let near = null, nd = P.smokeNear;
    for (const f of french()) { if (f.isAir) continue; const d = dist(f.position, c); if (d < nd) { nd = d; near = f; } }
    if (!near) return false;
    const u = men.find((x) => x.alive && x.type?.grenade && !(x.smokeCd > 0) && !x.throwing && !x.pinned);
    if (!u) return false;
    const k = Math.min(0.4, 12 / Math.max(nd, 1));
    g.order(u, c.x + (near.position.x - c.x) * k, c.z + (near.position.z - c.z) * k, "smoke");
    return true;
  }
  /** Men to a spot, spread round it. */
  const moveGroup = (men, to, spread = 2.5) => men.forEach((u, i) => {
    const a = (i / Math.max(1, men.length)) * Math.PI * 2, r = i === 0 ? 0 : spread + (i % 2) * 1.2;
    u.orderTo(to.x + Math.cos(a) * r, to.z + Math.sin(a) * r);
  });

  function planAssault(b) {
    const c = centre(alive(b));
    let tgt = null;
    const fr = french().filter((u) => !u.isAir);
    const guards = (p) => fr.filter((u) => dist(u.position, p) < 60).length;
    const mgs = frenchMGs();
    let best = -Infinity;
    for (const v of app.algEconomy?.points ?? []) {
      if (v.owner !== "player") continue;
      // WEAK SPOTS: few guards, near, and not under the French MGs.
      const s = 3 - guards(v.position) * 0.5 - dist(c, v.position) / 400 - mgExposure(v.position.x, v.position.z, mgs) * 1.5;
      if (s > best) { best = s; tgt = { at: v.position, name: v.name, village: v }; }
    }
    if (!tgt) {
      const outposts = (app.algStructures?.list ?? []).filter((s) => s.alive && s.team === "player" && s.typeKey !== "post" && s.typeKey !== "motorPool" && s.typeKey !== "helipad");
      outposts.sort((a, b2) => dist(a.position, c) - dist(b2.position, c));
      if (outposts[0]) tgt = { at: outposts[0].position, name: outposts[0].name ?? "un avant-poste", structure: outposts[0] };
    }
    if (!tgt) { const t2 = pickTarget(c); if (t2) tgt = { at: t2.at, name: "des troupes françaises" }; }
    if (!tgt) {
      const a = Math.atan2(c.z - post.z, c.x - post.x);
      tgt = { at: { x: post.x + Math.cos(a) * 70, z: post.z + Math.sin(a) * 70 }, name: "le poste" };
    }
    // A HOUSE the French hold in it (algGarrison.js): the flank's grenadiers go for it.
    tgt.house = (app.algGarrison?.houses ?? []).filter((h) => h.team === "player" && h.men.length && dist(h, tgt.at) < 45)
      .sort((h1, h2) => dist(h1, tgt.at) - dist(h2, tgt.at))[0] ?? null;
    b.assault = tgt; b.target = { lead: null, at: tgt.at, size: 0 };
    if (planFireManoeuvre(b, c, tgt, mgs)) return true;
    // Too few to split, or no ground for it: as before, one group.
    const spot = ambushSpot(c, tgt.at) ?? { x: tgt.at.x + (c.x - tgt.at.x) * 0.25, z: tgt.at.z + (c.z - tgt.at.z) * 0.25 };
    b.spot = spot;
    holdFire(b, true);
    sendBand(b, spot);
    setState(b, "approach");
    return true;
  }

  /**
   * FIRE AND MANOEUVRE (2026-10-06 — the assault walked in as one group and lost 3 to 1: 18
   * dead to 6, the village taken once in 4): the FMs and a rifleman or two are the BASE OF
   * FIRE, lying up 28-40 m off in cover with a line on the target; the rest go round to a FLANK
   * 20-30 m out at 70-110° from the base's line, out of the French MGs, holding fire; when the
   * French there are suppressed or pinned (or after baseFireMax s of fire) the flank goes in,
   * grenades first — at a French-held house, its grenadiers go for the house.
   */
  function planFireManoeuvre(b, c, tgt, mgs) {
    const m = alive(b);
    const fms = m.filter((u) => u.typeKey === "fmTeam"), rifles = m.filter((u) => u.typeKey !== "fmTeam");
    const base = [...fms, ...rifles.slice(0, fms.length ? 1 : 2)];
    const flank = m.filter((u) => !base.includes(u));
    if (flank.length < 3 || base.length < 1) return false;
    const a0 = Math.atan2(c.z - tgt.at.z, c.x - tgt.at.x);
    const baseSpot = spotAround(tgt.at, a0, 0.7, P.baseRing, { needSight: true, mgs, from: c });
    if (!baseSpot) return false;
    const aBase = Math.atan2(baseSpot.z - tgt.at.z, baseSpot.x - tgt.at.x);
    const focus = tgt.house ?? tgt.at;
    const ring = tgt.house ? [P.houseThrow - 4, P.houseThrow + 2] : P.flankRing;
    let flankSpot = null;
    for (const side of Math.random() < 0.5 ? [1, -1] : [-1, 1]) {
      flankSpot = spotAround(focus, aBase + side * rand(...P.flankAngle), 0.35, ring, { mgs, from: c });
      if (flankSpot) break;
    }
    if (!flankSpot) return false;
    for (const u of base) u._base = true;
    b.base = base; b.flank = flank; b.baseSpot = baseSpot; b.flankSpot = flankSpot;
    b.fireT = null;
    holdFire(b, true);
    moveGroup(base, baseSpot);
    moveGroup(flank, flankSpot);
    setState(b, "deploy");
    return true;
  }

  /** In they go: everyone at the target, firing (split: the flank; the base keeps firing). */
  function goIn(b) {
    const m = alive(b).filter((u) => !u._base), tg = b.assault;
    throwSmoke(m);   // a screen across the defenders' line as they go
    holdFire(b, false);
    m.forEach((u, i) => {
      const a = (i / Math.max(1, m.length)) * Math.PI * 2, r = 4 + (i % 3) * 3;
      u.orderTo(tg.at.x + Math.cos(a) * r, tg.at.z + Math.sin(a) * r);
    });
    app.algBattle?.say?.(`<b>Attaque du FLN</b> sur ${tg.name} !`, tg.at.x, tg.at.z, "bad", "hq_contact");
    setState(b, "assault");
  }

  let nextAssault = P.assaultFirst, defT = 0;
  function stepAssaults(dt) {
    nextAssault -= dt;
    if (nextAssault > 0) return;
    if (bands.some((b) => b.mission === "assault" && alive(b).length)) { nextAssault = 30; return; }
    if (cap() - liveFighters() < P.assaultSize[0]) { nextAssault = 30; return; }   // room for a real one, or wait
    if (newBand({ size: Math.round(rand(...P.assaultSize)), mission: "assault" })) nextAssault = rand(...P.assaultEvery);
    else nextAssault = 40;
  }

  function withdraw(b) {
    app.algGarrison?.exitAll(alive(b));   // out of a house first (algGarrison.js)
    if (underFire(b, alive(b))) throwSmoke(alive(b));   // pressed: a screen to run behind
    for (const u of b.members) u._base = false;
    holdFire(b, true);
    for (const u of alive(b)) { u.attackTarget = null; u.target = null; sendHome(u); }
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
      for (const u of homebound) { if (!u.alive) homebound.delete(u); else if (atHome(u)) goToGround(u); }
      for (let i = bands.length - 1; i >= 0; i--) {
        stepBand(bands[i], dt);
        if (bands[i].state === "done") { for (const u of bands[i].members) inBand.delete(u); bands.splice(i, 1); }
      }
      if (!enabled) return;
      watchVillages();
      watchLookouts();
      stepConvoy(dt);
      stepCaches(dt);
      // Twice a second: villages to defend, assaults to launch.
      defT -= dt;
      if (defT <= 0) { defT = 0.5; sendDefence(); }
      stepAssaults(dt);
      nextBand -= dt;
      if (nextBand <= 0) {
        nextBand = rand(...P.bandEvery) * (pool > 6 ? 0.7 : 1);
        // (the pool is spent by newBand: men gone to ground come back out free)
        newBand();
      }
    },
    /** Dev: a band now. */
    bandNow() { newBand(); },
    /** Dev: an assault band now. */
    assaultNow() { return newBand({ size: Math.round(rand(...P.assaultSize)), mission: "assault" }); },
    /** The next band in `s` seconds (algDifficulty.js, at the start). */
    restartClock(s) { nextBand = s; },
    /** Dev: where a man at (x, z) goes to ground (the nearest refuge or the cave). */
    homeFor: (x, z) => homeFor({ x, z }),
    /** The last lookout signal ({ at, t }) and men waiting to come back out. */
    get lastSignal() { return lastSignal; },
    get pool() { return pool; },
    /** The fighters it may have out now (the cap follows its villages). */
    get cap() { return cap(); },
    knownFrench: () => knownFrench(),
    /** The mule train under way (null: none) and the last one's outcome. */
    get convoy() { return convoy; },
    get lastConvoy() { return lastConvoy; },
    /** Dev: supply raids that turned their point; the point a band at (x, z) would raid now. */
    get raids() { return raids; },
    raidFor: (x, z) => pickRaid({ x, z }),
    /** Dev: a band now, sent to raid (the best point, or none). */
    raidNow() { return newBand({ mission: "raid" }); },
    /** Dev: a mule train now. */
    convoyNow() { if (!convoy) startConvoy(); },
    /** Dev: the last ambush-screen attempt ("placed" or why not). */
    get lastScreen() { return lastScreen; },
    /** Dev: the ambush spot a band at `from` would take on French at `tgt`. */
    ambushSpotFor: (from, tgt) => ambushSpot(from, tgt),
    /** Dev: the via point a band at `from` would take round the French MGs to `to` (null: straight). */
    routeFor: (from, to) => detour(from, to, frenchMGs()),
    /** Dev: the cover route a band at `from` would walk to `to` ([] straight, null none) and the last one found. */
    coverRouteFor: (from, to) => coverRoute(from, to),
    get lastRoute() { return lastRoute; },
    /** Dev: the cache being hidden now (null: none) and why the last try did not start one. */
    get cacheSite() { return cacheSite; },
    get cacheWhy() { return cacheWhy; },
    /** Dev: try to hide a new cache now (ignores the clock). */
    cacheNow() { cacheT = 0; stepCaches(0, true); return cacheWhy; },
    /** Dev: what each band is doing. */
    describe() {
      return bands.map((b) => `${b.state}${b.via ? ` (route: ${b.route?.length ?? 0} legs)` : ""}${(b.mission === "village" || b.mission === "defend" || b.mission === "raid") && b.village ? ` (${b.mission === "defend" ? "defend " : b.mission === "raid" ? "raid " : ""}${b.village.name})` : b.mission === "mine" ? " (mine)" : b.mission === "assault" ? ` (assault${b.assault ? ` ${b.assault.name}` : ""})` : ""} ${alive(b).length}/${b.state === "gather" ? b.size : b.start}`).join(" · ") || "no band out";
    },
  };
}
