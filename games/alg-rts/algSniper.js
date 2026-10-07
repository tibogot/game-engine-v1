// THE FLN'S SNIPERS (2026-10-07, the FLN asymmetry, you: "go ahead"). The katiba's first unit
// that is NOT a mirror of a French one: a "tireur d'élite" (algUnitTypes.js `tireur`) kept out
// of the bands and run here.
//
//   RECRUITED   at the cave, at most P.max out (one more on Difficile), the first after
//               P.firstAt s, then every P.every s while there is room — paid from the ALN purse
//               like any fighter (algEconomy COSTS.tireur).
//   PERCH       a spot 46-54 m from the French he knows of (algAI knownFrench: what his men,
//               lookouts and villages see; else a French-held village or point, else the post's
//               outskirts): open ground he can reach, a line of fire to them (algSight), out of
//               every French MG's reach, no French within 45 m (beyond their 42 m sight),
//               scored on CONCEALMENT (the scrub) and HEIGHT above them.
//   GOING THERE holding fire (concealed: he does not give himself away on the way).
//   ON THE PERCH he fires at men on foot only (`footOnly`), never chases (`noChase`): 62 m, one
//               aimed round every 4.5 s; a shot shows him for 1.2 s (`revealTime`).
//   MOVES ON    after P.shotsPerPerch shots (CoH's "shoot and scoot"), or the moment French on
//               foot come within P.closeFrench m (away from them), or hurt below half → home
//               (the nearest refuge or the cave: gone to ground).
//
// FAIR TO THE PLAYER: every round is a tracer (algCombat ALG_FIRE.sniper), and a shot from out
// of sight drops a "last seen" marker on the spot (algLastSeen) + an alert the first time each
// sniper fires (then once a minute) — you always know roughly where it came from. Found, he is
// fragile (45 hp): a rifleman's 30 m reach is too short, so you go up to him or use a flare,
// a mortar, a vehicle.

import { t } from "./i18n/i18n.js";

export const SNIPER = {
  firstAt: 240,          // s into the war
  every: [150, 220],     // s between recruits
  max: 2,                // out at once (algDifficulty may raise it)
  perch: [46, 54],       // m from the French he aims at (inside his 62 m: a section spreads ~8 m)
  keepOff: 45,           // m: no French nearer — beyond what they see (42 m), so he stays unseen
  scoot: 25,             // m: moving on, the next perch within this of the last (his own side)
  shotsPerPerch: 3,
  closeFrench: 24,       // m: French on foot this near → move
  hurtHome: 0.5,         // hp fraction → home
  idleRepick: 40,        // s on a perch with nothing to shoot → a new one
  alertEvery: 60,        // s between alerts per sniper
};

// The alert, built out here: inside createAlgSnipers `t` is the clock, not the translator.
const sniperAlert = () => t("<b>Tireur embusqué !</b> Les tirs viennent de là — montez-y, ou éclairez-le (fusée).");

export function createAlgSnipers(app, { units, cave, params = SNIPER }) {
  const P = params;
  const S = new Map();          // sniper → { state, perch, shots, t, lastShot, alertAt, aim }
  let t = 0, nextRecruit = P.firstAt, enabled = true, lastWhy = null;
  const rand = (a, b) => a + Math.random() * (b - a);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

  const french = () => units.list.filter((u) => u.alive && u.team === "player" && !u.isAir);
  const frenchFoot = () => french().filter((u) => u.type?.foot);
  function frenchMGs() {
    const out = [];
    for (const u of [...units.list, ...(app.algStructures?.list ?? [])]) {
      if (!u.alive || u.team !== "player" || u.isAir) continue;
      if ((u.weapon ?? u.type?.weapon) !== "mg") continue;
      out.push({ x: u.position.x, z: u.position.z, r: (u.range ?? u.type?.range ?? 40) + 6 });
    }
    return out;
  }
  /** What he aims at: the nearest French the katiba knows of, else a French-held place, else the post. */
  function aimFor(from) {
    const known = app.algAI?.knownFrench?.() ?? [];
    let best = null, bd = Infinity;
    for (const f of known) {
      if (!f.type?.foot) continue;
      const d = dist(from, f.position);
      if (d < bd) { bd = d; best = { x: f.position.x, z: f.position.z }; }
    }
    if (best) return best;
    for (const v of [...(app.algEconomy?.points ?? []), ...(app.algEconomy?.supply ?? [])]) {
      if (v.owner !== "player") continue;
      const d = dist(from, v.position);
      if (d < bd) { bd = d; best = { x: v.position.x, z: v.position.z }; }
    }
    if (best) return best;
    const post = (app.algStructures?.list ?? []).find((s) => s.typeKey === "post" && s.alive);
    return post ? { x: post.position.x, z: post.position.z } : null;
  }
  /** A line of fire from a spot on the ground to `at` (ridges, tall buildings). */
  function sightFrom(x, z, at) {
    const blocker = app.algSight?.blocker;
    if (!blocker) return true;
    const a = { position: { x, y: app.getWorldHeight(x, z), z }, type: { foot: true } };
    const b = { position: { x: at.x, y: app.getWorldHeight(at.x, at.z), z: at.z }, type: { foot: true } };
    return !blocker(a, b);
  }
  /** The best perch round `aim` for a sniper at `from` (null: none). `away`: prefer the side away from it. */
  function perchFor(from, aim, { away = null, within = Infinity, minMove = 0 } = {}) {
    const nav = app.navGrid, c = app.algCover, mgs = frenchMGs(), foot = frenchFoot();
    const a0 = Math.atan2(from.z - aim.z, from.x - aim.x);
    let best = null, bestS = -Infinity;
    const why = (lastWhy = { blocked: 0, region: 0, mg: 0, french: 0, sight: 0, ok: 0 });
    for (let i = 0; i < 48; i++) {
      const a = a0 + rand(-1.3, 1.3), r = rand(...P.perch);
      const x = aim.x + Math.cos(a) * r, z = aim.z + Math.sin(a) * r;
      const moved = Math.hypot(x - from.x, z - from.z);
      if (moved > within || moved < minMove) continue;
      if (nav?.isBlockedAtWorld?.(x, z, true)) { why.blocked++; continue; }
      if (nav?.sameRegion && !nav.sameRegion(from.x, from.z, x, z)) { why.region++; continue; }
      if (mgs.some((g) => Math.hypot(g.x - x, g.z - z) < g.r)) { why.mg++; continue; }
      if (foot.some((f) => Math.hypot(f.position.x - x, f.position.z - z) < P.keepOff)) { why.french++; continue; }
      if (!sightFrom(x, z, aim)) { why.sight++; continue; }
      why.ok++;
      const conceal = c ? c.concealmentAt(x, z) / c.params.maxConcealment : 0;
      const height = Math.max(-1, Math.min(1.5, (app.getWorldHeight(x, z) - app.getWorldHeight(aim.x, aim.z)) / 12));
      let s = conceal * 2 + height - Math.hypot(x - from.x, z - from.z) / 300 + rand(0, 0.15);
      if (away) s += Math.min(1, Math.hypot(x - away.x, z - away.z) / 60);
      if (s > bestS) { bestS = s; best = { x, z }; }
    }
    return best;
  }

  function goTo(u, st, perch) {
    st.state = "go"; st.perch = perch; st.t = 0; st.shots = 0;
    u.holdFire = true; u.noChase = true;
    u.orderTo(perch.x, perch.z);
  }
  function sendHome(u, st) {
    st.state = "home"; st.t = 0;
    u.holdFire = true;
    st.home = app.algAI?.homeFor?.(u.position.x, u.position.z) ?? cave?.outside ?? u.position;
    u.orderTo(st.home.x, st.home.z);
  }
  function replan(u, st, away = null, scoot = false) {
    const aim = aimFor(u.position);
    // Shoot and scoot: the next perch near the last, on his side — never across to the French.
    // (Nothing there: anywhere round the aim, as a fresh search.)
    const perch = aim && ((scoot && perchFor(u.position, aim, { away, within: P.scoot, minMove: 10 })) || perchFor(u.position, aim, { away }));
    st.aim = aim;
    if (perch) goTo(u, st, perch);
    else { st.state = "wait"; st.t = 0; u.holdFire = true; }
  }

  function step(dt) {
    if (!enabled) return;
    t += dt;
    // RECRUIT: room for one more and the purse can pay (the cave's queue charges it).
    nextRecruit -= dt;
    if (nextRecruit <= 0 && cave?.structure?.alive) {
      nextRecruit = rand(...P.every);
      const out = units.list.filter((u) => u.alive && u.team === "enemy" && u.typeKey === "tireur").length;
      const queued = cave.structure.queue.filter((k) => k === "tireur").length;
      if (out + queued < P.max) cave.structure.enqueue("tireur");
    }
    for (const u of units.list) {
      if (u.typeKey !== "tireur" || u.team !== "enemy") continue;
      let st = S.get(u);
      if (!u.alive) { if (st) S.delete(u); continue; }
      if (!st) {
        // Out of the cave (still walking out: wait for him to stand).
        if (u.isMoving) continue;
        st = { state: "wait", t: 0, shots: 0, lastShot: -1e9, alertAt: -1e9, perch: null, aim: null };
        S.set(u, st);
        replan(u, st);
        continue;
      }
      st.t += dt;
      if (st.state !== "home" && u.hp < u.maxHp * P.hurtHome) { sendHome(u, st); continue; }
      switch (st.state) {
        case "wait":
          if (st.t > 6) replan(u, st);
          break;
        case "go":
          if (dist(u.position, st.perch) < 3 || (!u.isMoving && st.t > 2)) {
            st.state = "perch"; st.t = 0; st.shots = 0;
            u.holdFire = false;
            u.stop?.();
          } else if (st.t > 90) replan(u, st);
          break;
        case "perch": {
          // French on foot coming up: away from them before they are on him.
          const near = frenchFoot().find((f) => dist(f.position, u.position) < P.closeFrench);
          if (near) { replan(u, st, near.position); break; }
          // Shoot and scoot.
          if (st.shots >= P.shotsPerPerch && t - st.lastShot > 1.5) { replan(u, st, u.position, true); break; }
          if (st.t > P.idleRepick && t - st.lastShot > P.idleRepick) replan(u, st);
          break;
        }
        case "home":
          if (dist(u.position, st.home) < 5) {
            // Gone to ground: he is not a band's man; his place on the cave's list is free again.
            u.alive = false; u.vanished = true; S.delete(u);
            app.selection?.remove?.(u);
          } else if (!u.isMoving && st.t > 3) u.orderTo(st.home.x, st.home.z);
          break;
      }
    }
  }

  /** combat's onShot (algUnits.js): count his shots, and mark where an unseen shot came from. */
  function onShot(e) {
    if (e.typeKey !== "tireur") return;
    const st = S.get(e);
    if (st) { st.shots++; st.lastShot = t; }
    const fog = app.fogOfWar;
    const { x, z } = e.position;
    if (fog?.enabled && fog.isVisible(x, z)) return;
    // Roughly where (a few metres off: the player hears and sees the tracer, not the man).
    const jx = x + rand(-4, 4), jz = z + rand(-4, 4);
    app.algLastSeen?.addGhost?.(jx, jz);
    if (st && t - st.alertAt > P.alertEvery) {
      st.alertAt = t;
      app.algBattle?.say?.(sniperAlert(), jx, jz, "bad", "hq_contact", "alertAttack");
    }
  }

  return {
    params: P,
    step,
    onShot,
    get list() { return [...S.entries()].map(([u, s]) => ({ u, ...s })); },
    setEnabled(on) { enabled = !!on; },
    /** Dev: one now (at the cave's mouth, free). */
    spawnNow() {
      const at = cave?.outside ?? cave?.structure?.rally;
      return at ? units.spawn("tireur", at.x, at.z, { team: "enemy" }) : null;
    },
    /** Dev: why the last perch search took or refused its spots. */
    get lastWhy() { return lastWhy; },
    /** Dev: what each sniper is doing. */
    describe() { return [...S.entries()].map(([u, s]) => `${s.state} shots ${s.shots} hp ${Math.round(u.hp)}`).join(" · ") || "no sniper out"; },
  };
}
