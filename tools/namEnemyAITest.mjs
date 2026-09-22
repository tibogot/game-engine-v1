/**
 * NAM-RTS ENEMY COMMANDER (games/nam-rts/enemyAI.js), driven with stand-in
 * units, points and structures — its rules, not its pathfinding:
 *
 *   · the opening army deploys, and its squads go to DIFFERENT neutral points
 *   · the purse recruits one man at a time; five make a squad
 *   · a worn-down squad falls back, holding fire, to the HQ
 *   · it attacks your point only with enough men for what it can SEE there —
 *     alone it declines, with idle squads to join it goes
 *   · it does not see what none of its men can see
 *   · a man chasing too far from his post is called back
 *   · same seed, same game
 *
 * Squads think on their own step of each tick (spread, not all at once), so
 * anything waiting on a decision runs a whole tick.
 *
 *   node tools/namEnemyAITest.mjs
 */
import { createEnemyAI, ENEMY_AI } from "../games/nam-rts/enemyAI.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

function world({ points = [], enemyBase = true, tunnels = [] } = {}) {
  const list = [];
  const units = {
    list,
    near(x, z, r, out = []) {
      out.length = 0;
      for (const u of list) if (u.alive && Math.hypot(u.position.x - x, u.position.z - z) <= r + 1) out.push(u);
      return out;
    },
    spawn(typeKey, x, z, { team = "player" } = {}) {
      const u = man(team, x, z, typeKey);
      list.push(u);
      return u;
    },
  };
  const eb = { alive: enemyBase, team: "enemy", range: 0, position: { x: 0, y: 0, z: 400 }, type: { navRadius: 24, doorApproach: { dirX: 0, dirZ: -1 } } };
  const base = { alive: true, team: "player", range: 0, position: { x: 0, y: 0, z: -380 } };
  const tun = tunnels.map(([x, z]) => ({ alive: true, team: "enemy", range: 0, typeKey: "tunnel", position: { x, y: 0, z } }));
  const structures = {
    list: [eb, base, ...tun], enemyBase: eb, base,
    get tunnels() { return tun.filter((t) => t.alive); },
    get zpus() { return this.list.filter((s) => s.typeKey === "zpu" && s.alive); },
  };
  const requisition = { points };
  return { units, structures, requisition };
}
function man(team, x, z, typeKey = "soldier") {
  return {
    typeKey, team, alive: true, hp: 60, maxHp: 60, isAir: false,
    position: { x, y: 0, z }, target: null, attackTarget: null, isMoving: false, holdFire: false,
    orders: [],
    orderTo(tx, tz) { this.orders.push(["to", tx, tz]); this.dest = { x: tx, z: tz }; },
    moveOrder(tx, tz) { this.target = null; this.orders.push(["move", tx, tz]); this.dest = { x: tx, z: tz }; },
  };
}
const point = (id, x, z, owner = null) => ({ id, letter: "ABCDEFG"[id], name: `P${id}`, position: { x, y: 0, z }, radius: 16, owner, progress: owner === "player" ? 1 : owner === "enemy" ? -1 : 0 });
/** Everyone walks to where they were last sent. */
const arrive = (w) => { for (const u of w.units.list) if (u.dest) { u.position.x = u.dest.x; u.position.z = u.dest.z; } };
const run = (ai, seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) ai.step(dt); };
const enemySoldiers = (w) => w.units.list.filter((u) => u.team === "enemy" && u.alive);

console.log("deploy");
{
  const w = world({ points: [point(0, -150, 150), point(1, 170, 150), point(2, 10, 40), point(3, 100, -230)] });
  const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startingStock: 0 } });
  run(ai, ENEMY_AI.tick);
  ok("three squads of five on the field", ai.squads.length === ENEMY_AI.startSquads && enemySoldiers(w).length === ENEMY_AI.startSquads * ENEMY_AI.squadSize,
    `${ai.squads.length} squads, ${enemySoldiers(w).length} men`);
  const pts = ai.squads.map((s) => s.point?.id);
  ok("each squad goes for a different neutral point", new Set(pts).size === pts.length && pts.every((p) => p != null), pts.join(","));
  ok("the far point is left for later", !pts.includes(3));
}

console.log("recruiting");
{
  const w = world({ points: [point(0, -150, 150)] });
  const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: 0, startingStock: 1000 } });
  // The first man comes at once, then one every recruitTime: four by 3.5 of them.
  run(ai, ENEMY_AI.recruitTime * 3.5);
  ok("one man per recruitTime, no squad yet at four", enemySoldiers(w).length === 4 && ai.squads.length === 0,
    `${enemySoldiers(w).length} men, ${ai.squads.length} squads`);
  run(ai, ENEMY_AI.recruitTime * 1.2);
  ok("the fifth man makes a squad", ai.squads.length === 1 && ai.squads[0].members.length === 5);
  const w2 = world({ points: [point(0, -150, 150)] });
  const ai2 = createEnemyAI({ ...w2, params: { ...ENEMY_AI, startSquads: 0, startingStock: 120 } });
  run(ai2, 30);
  ok("no money, no men", enemySoldiers(w2).length === 2, `${enemySoldiers(w2).length} men from 120 supplies`);
  const w3 = world({ points: [point(0, -150, 150)], enemyBase: false });
  const ai3 = createEnemyAI({ ...w3, params: { ...ENEMY_AI, startingStock: 1000 } });
  run(ai3, 30);
  ok("no HQ, no recruits", enemySoldiers(w3).length === 0);
}

console.log("falling back");
{
  const w = world({ points: [point(0, 0, 100)] });
  const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: 1, startingStock: 0 } });
  run(ai, ENEMY_AI.tick);
  arrive(w);
  const s = ai.squads[0];
  const foe = man("player", 0, 90);
  w.units.list.push(foe);
  s.members.forEach((u, i) => { if (i < 3) { u.alive = false; u.hp = 0; } else { u.hp = 30; u.target = foe; } });
  run(ai, ENEMY_AI.tick * 1.5);
  ok("worn down → retreat", s.state === "retreat", s.state);
  ok("holding fire while it goes", s.members.every((u) => !u.alive || u.holdFire));
  const runner = s.members.find((u) => u.alive);
  const last = runner.orders.at(-1);
  ok("toward its HQ, its target dropped", last[2] > 300 && !runner.target, JSON.stringify(last));
  arrive(w);
  run(ai, ENEMY_AI.tick * 1.5);
  ok("home: refitting, firing again", s.state === "refit" && s.members.every((u) => !u.holdFire), s.state);
}

console.log("attacking your points");
{
  // Your point, ten of your men on it, and an enemy scout close enough to see them.
  const setup = (squadsN) => {
    const P = point(0, 0, 0, "player");
    const w = world({ points: [P] });
    for (let i = 0; i < 10; i++) w.units.list.push(man("player", (i % 5) * 3, Math.floor(i / 5) * 3));
    const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: squadsN, startingStock: 0 } });
    // Deploy, then put the squads 40 m off the point, where they can see it.
    ai.step(1 / 60);
    for (const s of ai.squads) { s.state = "idle"; s.point = null; s.members.forEach((u, i) => { u.position.x = i * 2; u.position.z = 40; u.dest = null; }); }
    return { w, ai, P };
  };
  {
    const { ai } = setup(1);
    run(ai, ENEMY_AI.tick * 1.5);
    ok("alone against ten: it does not attack", ai.squads[0].state === "idle", ai.squads[0].state);
  }
  {
    const { ai } = setup(3);
    run(ai, ENEMY_AI.tick * 1.5);
    const st = ai.squads.map((s) => s.state);
    ok("three squads idle: they attack together", st.filter((x) => x === "stage").length >= 2, st.join(","));
  }
}

console.log("what it can see");
{
  const P = point(0, 0, 0, "player");
  const w = world({ points: [P] });
  for (let i = 0; i < 10; i++) w.units.list.push(man("player", i, 0));
  const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: 0, startingStock: 0 } });
  ok("nobody of ours near: the point looks empty", ai._threatAt(P) === 0);
  w.units.list.push(man("enemy", 0, 40));
  ok("a scout at 40 m sees all ten", Math.abs(ai._threatAt(P) - 10) < 1e-9, `${ai._threatAt(P)}`);
}

console.log("leash");
{
  const w = world({ points: [point(0, 0, 100)] });
  const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: 1, startingStock: 0 } });
  run(ai, ENEMY_AI.tick);
  arrive(w);
  const s = ai.squads[0];
  const u = s.members[0];
  u.target = man("player", 0, 0);
  u.position.z = 100 - ENEMY_AI.leash - 10;
  run(ai, ENEMY_AI.tick * 1.5);
  // Called back (a moveOrder, dropping the target), then walked to his spot.
  const back = u.orders.some((o) => o[0] === "move");
  const last = u.orders.at(-1);
  ok("a man chasing too far is called back to his spot", back && !u.target && Math.hypot(last[1], last[2] - 100) < 16, JSON.stringify(last));
}

console.log("tunnels");
{
  const recruitsAt = (w) => {
    const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: 0, startingStock: 1000 } });
    run(ai, 0.1);
    return enemySoldiers(w)[0]?.position;
  };
  // Your HQ is at z = -380: the tunnel at z = 100 is the forward one.
  const p = recruitsAt(world({ tunnels: [[0, 300], [0, 100]] }));
  ok("recruits come up at the most forward tunnel", p && Math.abs(p.z - 96) < 6, p && `z ${p.z.toFixed(1)}`);
  // Something of yours next to it, seen (the tunnel itself watches): not that one.
  const w = world({ tunnels: [[0, 300], [0, 100]] });
  w.units.list.push(man("player", 5, 104));
  const q = recruitsAt(w);
  ok("…but not at a tunnel you are standing on", q && Math.abs(q.z - 296) < 6, q && `z ${q.z.toFixed(1)}`);
  const r = recruitsAt(world());
  ok("no tunnels: at the HQ", r && r.z > 350, r && `z ${r.z.toFixed(1)}`);
}
{
  const w = world({ points: [point(0, 0, 140)], tunnels: [[0, 100]] });
  const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startSquads: 1, startingStock: 0 } });
  run(ai, ENEMY_AI.tick);
  arrive(w);
  const s = ai.squads[0];
  const foe = man("player", 0, 150);
  w.units.list.push(foe);
  s.members.forEach((u, i) => { if (i < 3) { u.alive = false; u.hp = 0; } else { u.hp = 30; u.target = foe; } });
  run(ai, ENEMY_AI.tick * 1.5);
  const last = s.members.find((u) => u.alive).orders.at(-1);
  ok("a beaten squad falls back to the nearest tunnel, not the HQ", s.state === "retreat" && Math.abs(last[2] - 96) < 12, JSON.stringify(last));
}

console.log("AA");
{
  const setup = ({ heli = true, stock = 1000, held = 1 } = {}) => {
    const pts = [point(0, 0, 100, "enemy"), point(1, 200, 250, held > 1 ? "enemy" : null), point(2, -200, 250, held > 2 ? "enemy" : null)];
    const w = world({ points: pts });
    w.units.list.push(man("enemy", 2, 104));                 // a sentry on the point
    if (heli) { const h = man("player", 10, 120, "helicopter"); h.isAir = true; w.units.list.push(h); }
    const dug = [];
    const emplace = (typeKey, x, z) => {
      const s = { typeKey, alive: true, team: "enemy", range: 62, position: { x, y: 0, z }, deploy: 0 };
      w.structures.list.push(s); dug.push(s); return s;
    };
    const ai = createEnemyAI({ ...w, emplace, params: { ...ENEMY_AI, startSquads: 0, startingStock: stock, maxSquads: 0 } });
    return { w, ai, dug };
  };
  {
    const { ai, dug } = setup();
    run(ai, ENEMY_AI.zpuEvery + ENEMY_AI.tick);
    const d = dug[0] && Math.hypot(dug[0].position.x, dug[0].position.z - 100);
    ok("a helicopter seen over a held point: a ZPU is dug in there", dug.length === 1 && d >= 10 && d <= 17, dug.length ? `${d.toFixed(1)} m off the mast` : "none");
    ok("it starts in the ground, not firing", dug[0]?.deploy < 0.5, `deploy ${dug[0]?.deploy.toFixed(2)}`);
    run(ai, ENEMY_AI.zpuDigTime);
    ok("and is up after zpuDigTime", dug[0]?.deploy === 1);
    run(ai, ENEMY_AI.zpuEvery * 3);
    ok("one to a point", dug.length === 1, `${dug.length}`);
  }
  {
    const { ai, dug } = setup({ heli: false });
    run(ai, ENEMY_AI.zpuEvery * 3);
    ok("no helicopters, one point held: nothing dug", dug.length === 0);
    const b = setup({ heli: false, held: 3 });
    run(b.ai, ENEMY_AI.tick);
    ok("holding three points, it digs one in anyway", b.dug.length === 1);
    run(b.ai, ENEMY_AI.zpuEvery * 6);
    ok("…but stays thin without a reason: one per three points held", b.dug.length === Math.floor(3 / 3) + 1, `${b.dug.length} guns`);
  }
  {
    const { ai, dug } = setup({ stock: ENEMY_AI.zpuCost + ENEMY_AI.zpuReserve - 1 });
    run(ai, ENEMY_AI.zpuEvery * 3);
    ok("not with the recruits' money", dug.length === 0);
  }
}

console.log("determinism");
{
  const game = () => {
    const w = world({ points: [point(0, -150, 150), point(1, 170, 150), point(2, 10, 40)] });
    const ai = createEnemyAI({ ...w, params: { ...ENEMY_AI, startingStock: 600 } });
    for (let k = 0; k < 8; k++) { run(ai, 5); arrive(w); }
    return JSON.stringify(w.units.list.map((u) => [u.position.x.toFixed(3), u.position.z.toFixed(3)])) + ai.summary().join();
  };
  ok("same seed, same game", game() === game());
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
