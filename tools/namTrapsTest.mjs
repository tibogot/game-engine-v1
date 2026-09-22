/**
 * THE CHEAP NASTY KIT (games/nam-rts/traps.js), driven with stand-in units and
 * structures — the rules of the Front's cheap war:
 *
 *   · nothing is drawn, shot at or walked around until it is FOUND
 *   · a squad sweeping past usually finds a pit; one man hurrying often doesn't
 *   · a vehicle finds nothing — no eyes, so the column drives into everything
 *   · a pit takes one man and leaves him limping; it does not touch armour
 *   · a booby trap is spent when it goes off, and barely dents a tank
 *   · a found trap is stamped into the nav grid: from then on you walk round it
 *   · a cache pays the Front every second it stands, and pays YOU when it burns
 *
 *   node tools/namTrapsTest.mjs
 */
import { createTraps } from "../games/nam-rts/traps.js";
import { STRUCTURE_TYPES } from "../games/nam-rts/structures.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

// ── Stand-ins ────────────────────────────────────────────────────────────────
// A structure exactly as structures.makeStructure builds a concealed one: the
// hidden flags, and reveal() putting them back.
function kitPiece(typeKey, x, z) {
  const type = STRUCTURE_TYPES[typeKey];
  const s = {
    typeKey, type, name: type.name, team: "enemy", isStructure: true,
    position: { x, y: 0, z }, radius: type.radius, maxHp: type.maxHp, hp: type.maxHp,
    alive: true, range: type.range ?? 0, concealed: type.concealed,
    hidden: true, passive: true, deploy: 0,
    reveal() {
      if (!this.hidden) return false;
      this.hidden = false; this.passive = false; this.deploy = 1;
      return true;
    },
  };
  return s;
}
function unit(typeKey, x, z, { team = "player", hp = 60 } = {}) {
  return {
    typeKey, team, alive: true, hp, maxHp: hp, isAir: false, speedScale: 1,
    type: { name: typeKey }, position: { x, y: 0, z },
  };
}
function world(pieces = [], units = []) {
  const list = [...units];
  const u = {
    list,
    near(x, z, r, out = []) {
      out.length = 0;
      for (const o of list) if (o.alive && Math.hypot(o.position.x - x, o.position.z - z) <= r) out.push(o);
      return out;
    },
  };
  const structures = { list: [...pieces] };
  return { units: u, structures };
}
/** A combat stand-in: records what was hurt, and does the damage honestly. */
function combatStub() {
  const hits = [];
  const hurt = (o, n) => { o.hp -= n; if (o.hp <= 0) { o.hp = 0; o.alive = false; } };
  return {
    hits,
    onImpact(target, amount) { hits.push([target, amount]); hurt(target, amount); },
    splashAt(at, damage, radius, owner, { vehicleMul = 1 } = {}) {
      for (const o of this._units) {
        if (!o.alive || o.team === owner?.team) continue;
        const d = Math.hypot(o.position.x - at.x, o.position.z - at.z);
        if (d > radius) continue;
        const soft = o.typeKey === "soldier";
        const amount = damage * (1 - (d / radius) ** 1.5) * (soft ? 1 : vehicleMul);
        hits.push([o, amount]);
        hurt(o, amount);
      }
    },
    _units: [],
  };
}
const run = (t, seconds, dt = 1 / 60) => { for (let s = 0; s < seconds; s += dt) t.step(dt); };

// ── Hidden until found ───────────────────────────────────────────────────────
console.log("hidden");
{
  const pit = kitPiece("punji", 0, 0);
  const w = world([pit], [unit("soldier", 0, 60)]);
  const t = createTraps({ ...w });
  run(t, 5);
  ok("a pit nobody is near stays hidden", pit.hidden && t.revealed.length === 0);
  ok("hidden means not targetable and not firing", pit.passive === true && pit.deploy === 0);
}

// ── Who notices ──────────────────────────────────────────────────────────────
console.log("\nfinding it");
{
  // Five men standing in the spotting ring: they find it within a second or two.
  let foundIn = null;
  for (let seed = 1; seed <= 20 && foundIn === null; seed++) {
    const pit = kitPiece("punji", 0, 0);
    const men = [0, 1, 2, 3, 4].map((i) => unit("soldier", 6 + i * 0.4, 6));
    const w = world([pit], men);
    const t = createTraps({ ...w, seed });
    for (let s = 0; s < 3; s += 1 / 60) { t.step(1 / 60); if (!pit.hidden) { foundIn = s; break; } }
  }
  ok("a squad standing near a pit finds it", foundIn !== null && foundIn < 2, foundIn === null ? "never" : `${foundIn.toFixed(2)}s`);
}
{
  // Twenty runs of one man walking past at rifleman's pace: some find it, some
  // do not. That spread IS the mechanic — a certainty either way would be a
  // rule the player could stop thinking about.
  let seen = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const pit = kitPiece("punji", 0, 0);
    const man = unit("soldier", 0, 14);
    const w = world([pit], [man]);
    const t = createTraps({ ...w, seed, combat: combatStub() });
    for (let s = 0; s < 1.1; s += 1 / 60) { man.position.z -= 11 / 60; t.step(1 / 60); }
    if (!pit.hidden) seen++;
  }
  ok("one man hurrying past: sometimes yes, sometimes no", seen > 2 && seen < 18, `${seen}/20 found it`);
}
{
  // A tank drives the same ground. It has no eyes for this at all.
  const pit = kitPiece("punji", 0, 0);
  const tank = unit("tank", 0, 14);
  const w = world([pit], [tank]);
  const t = createTraps({ ...w, combat: combatStub() });
  for (let s = 0; s < 1.6; s += 1 / 60) { tank.position.z -= 11 / 60; t.step(1 / 60); }
  ok("armour with no infantry finds nothing", pit.hidden, `at ${tank.position.z.toFixed(1)} m`);
}

// ── What a pit does ──────────────────────────────────────────────────────────
console.log("\nthe pit");
{
  const pit = kitPiece("punji", 0, 0);
  const man = unit("soldier", 0, 2);
  const w = world([pit], [man]);
  const c = combatStub(); c._units = w.units.list;
  const t = createTraps({ ...w, combat: c });
  run(t, 0.5);
  ok("the man who steps in it is hurt", man.hp === 60 - STRUCTURE_TYPES.punji.trap.damage, `${man.hp} hp`);
  ok("and he limps", man.speedScale < 1, `x${man.speedScale}`);
  ok("the pit is now visible", !pit.hidden && pit.alive);
  run(t, STRUCTURE_TYPES.punji.trap.limp + 0.5);
  ok("the limp wears off", man.speedScale === 1);
}
{
  const pit = kitPiece("punji", 0, 0);
  const tank = unit("tank", 0, 1.5, { hp: 380 });
  const w = world([pit], [tank]);
  const c = combatStub(); c._units = w.units.list;
  const t = createTraps({ ...w, combat: c });
  run(t, 1);
  ok("a stake pit does nothing to a tank", tank.hp === 380 && pit.hidden);
}

// ── What a charge does ───────────────────────────────────────────────────────
console.log("\nthe booby trap");
{
  const bomb = kitPiece("boobyTrap", 0, 0);
  const men = [unit("soldier", 0, 2), unit("soldier", 3, 3), unit("soldier", 40, 40)];
  const w = world([bomb], men);
  const c = combatStub(); c._units = w.units.list;
  const t = createTraps({ ...w, combat: c });
  run(t, 0.5);
  ok("it takes the man who walked into it", men[0].hp < 10, `${men[0].hp | 0} hp`);
  ok("and hurts the one bunched up behind him", men[1].hp < 60 && men[1].hp > 0, `${men[1].hp | 0} hp`);
  ok("the man across the map is fine", men[2].hp === 60);
  ok("and the charge is spent", !bomb.alive);
}
{
  const bomb = kitPiece("boobyTrap", 0, 0);
  const tank = unit("bigtank", 0, 1, { hp: 240 });
  const w = world([bomb], [tank]);
  const c = combatStub(); c._units = w.units.list;
  const t = createTraps({ ...w, combat: c });
  run(t, 0.5);
  const took = 240 - tank.hp;
  ok("a grenade in a tin barely dents armour", took > 0 && took < 12, `${took.toFixed(1)} damage`);
}

// ── Found ground is walkable-around ──────────────────────────────────────────
console.log("\nonce it is found");
{
  const pit = kitPiece("punji", 10, 10);
  const w = world([pit], []);
  const stamped = [];
  const t = createTraps({ ...w, navGrid: { cell: 4, addStructureObstacle: (s) => stamped.push(s) } });
  t.reveal(pit, "test");
  ok("a found pit is stamped into the nav grid", stamped.length === 1 && stamped[0] === pit);
  // The grid blocks a cell when the cell CENTRE is inside the rectangle, and
  // its cells are 4 m — so a rectangle narrower than half a cell can stamp
  // nothing at all. It is grown to fit, or the pit stays walk-through.
  ok("the stamp is at least half a nav cell wide", pit.footprint.hx >= 2 && pit.footprint.hz >= 2,
    `${pit.footprint.hx} x ${pit.footprint.hz}`);
  // navGrid stamps at `wx + fp.cx`: a footprint with no centre makes that NaN
  // and the stamp silently does nothing — which is how the first version
  // shipped a "found" trap that men still walked straight through.
  const whole = Object.values(STRUCTURE_TYPES).filter((t) => t.navBlock)
    .every((t) => Number.isFinite(t.navBlock.cx) && Number.isFinite(t.navBlock.cz));
  ok("every navBlock declares its centre (or the stamp is NaN)", whole);
}

// ── The hole that opens up ───────────────────────────────────────────────────
console.log("\nthe spider hole");
{
  const hole = kitPiece("spiderHole", 0, 0);
  const man = unit("soldier", 0, 40);
  const w = world([hole], [man]);
  const t = createTraps({ ...w });
  run(t, 0.5);
  ok("at 40 m he is still in the hole", hole.hidden);
  man.position.z = 28;
  run(t, 0.5);
  ok("at 28 m he throws the lid back", !hole.hidden && hole.deploy === 1);
  ok("he opens up BEFORE he can hit anything", STRUCTURE_TYPES.spiderHole.concealed.ambush > STRUCTURE_TYPES.spiderHole.range);
}

// ── The cache ────────────────────────────────────────────────────────────────
console.log("\nthe cache");
{
  const cache = kitPiece("cache", 0, 0);
  const w = world([cache], []);
  let theirs = 0, mine = 0;
  const t = createTraps({ ...w, enemyEarn: (n) => { theirs += n; }, resources: { earn: (n) => { mine += n; } } });
  run(t, 60);
  ok("it pays the Front while it stands", Math.abs(theirs - STRUCTURE_TYPES.cache.income * 60) < 0.5, `${theirs.toFixed(0)} a minute`);
  cache.alive = false;
  run(t, 0.5);
  ok("burning it pays you", mine === STRUCTURE_TYPES.cache.loot, `+${mine}`);
  run(t, 2);
  ok("and it only pays once", mine === STRUCTURE_TYPES.cache.loot);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
