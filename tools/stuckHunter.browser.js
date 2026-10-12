// THE STUCK HUNTER (alg-rts, 2026-10-12 — you: "be sure soldiers NEVER get stuck"). A BROWSER tool, not a
// test (runAll runs *Test.mjs / *.run.mjs only): paste it into the console of the running game
// (alg.html?brief=0), or run it from the Chrome dev tools, then read window.__hunt when it is done.
//
// Every squad is sent to a random capture point (± 35 m) every 14 s for HUNT_S seconds. A man is STUCK
// when he has an order, is not fighting (no target), not in a house, more than 6 m from his goal, and in
// 4 s has neither got 1 m closer to it nor moved 1.5 m. Each episode is recorded with his state and his
// trail of the last 4 s (position, stuck-ladder rung, Reversing / Ghost, posture speed).
//
// Its record (the Aurès): before the corner fixes 2 episodes per 200 s; after (round-the-corner step,
// the wide line of walk, a corner's waypoint reached only with the next in a clear line) 0 in 600 s.
(async () => {
  const HUNT_S = 400, SEED = 99991;
  window.__hunt = null;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.__ALG.app ?? window.__ALG;
  const sel = app.selection, M = app.algSquadMarch;
  const qs = () => app.algSquads.list.filter((q) => q.team === "player" && q.count);
  const spots = app.algEconomy.allPoints.map((p) => p.position);
  let rnd = SEED;
  const R = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const track = new Map(), trail = new Map(), episodes = [];
  const tEnd = performance.now() + HUNT_S * 1000;
  let nextOrder = 0, orders = 0;
  while (performance.now() < tEnd) {
    const now = performance.now();
    if (now > nextOrder) {
      for (const q of qs()) {
        const c = spots[Math.floor(R() * spots.length)], a = R() * 6.283, d = R() * 35;
        sel.select(q.members); sel.orderMove(c.x + Math.cos(a) * d, c.z + Math.sin(a) * d); orders++;
      }
      sel.select([]);
      nextOrder = now + 14000;
    }
    await wait(250);
    for (const q of qs()) for (const u of q.members) {
      if (!u.alive) continue;
      let tl = trail.get(u); if (!tl) trail.set(u, (tl = []));
      const s0 = u.debugState();
      tl.push(`${u.position.x.toFixed(1)},${u.position.z.toFixed(1)} e${s0.escalation}${s0.reversing ? "R" : ""}${u.ghost ? "G" : ""} m${(u.moveMul ?? 1).toFixed(2)}`);
      if (tl.length > 16) tl.shift();
      const gp = u.goalPoint;
      const busy = u.inside || u.target || u.attackTarget || !gp;
      const dGoal = gp ? Math.hypot(gp.x - u.position.x, gp.z - u.position.z) : 0;
      const tr = track.get(u);
      if (!tr || busy || dGoal < 6 || (gp && Math.hypot(tr.gx - gp.x, tr.gz - gp.z) > 8)) {
        track.set(u, { x: u.position.x, z: u.position.z, t: now, gx: gp?.x, gz: gp?.z, best: dGoal, logged: false });
        continue;
      }
      if (dGoal < tr.best - 1 || Math.hypot(u.position.x - tr.x, u.position.z - tr.z) > 1.5) { tr.best = Math.min(tr.best, dGoal); tr.t = now; tr.x = u.position.x; tr.z = u.position.z; continue; }
      if (!tr.logged && now - tr.t > 4000) {
        tr.logged = true;
        const s = u.debugState(), m = M?.marches.get(q);
        episodes.push({ pos: s.pos, goalD: +dGoal.toFixed(1), leader: q.members[0] === u, march: !!m, shape: m?.ctx, formMul: +(u.formMul ?? 1).toFixed(2), moveMul: u.moveMul, posture: u.posture, waypoints: s.waypoints, rung: s.escalation, route: (u.route ?? []).slice(0, 2).map((w) => [Math.round(w.x), Math.round(w.z)]), trail: [...tl] });
      }
    }
  }
  sel.select([]);
  window.__hunt = { orders, episodes };
  console.log("[stuck hunter]", window.__hunt);
})();
