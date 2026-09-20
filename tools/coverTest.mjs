/**
 * COVER, CONCEALMENT and ABILITIES — the rules, without a browser.
 *
 * These are the two systems a player loses a match to and cannot see, so they
 * are the ones that have to be checked by number rather than by eye. The point
 * of most of what follows is not that the maths works — it is that the two
 * ideas stay SEPARATE: concealment must never reduce damage and cover must
 * never hide anyone, because the moment they blur, the map stops teaching
 * anything.
 *
 *   node tools/coverTest.mjs
 */
import { createCover, COVER } from "../games/nam-rts/cover.js";
import { createAbilities, ABILITIES } from "../games/nam-rts/abilities.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

const WORLD = 2048;

/** A fake engine: painted jungle in a disc, and a list of props. */
function fakeApp({ jungle = [], props = [], buildings = [] } = {}) {
  return {
    worldSize: WORLD,
    sampleFoliageDensity(x, z) {
      let best = 0;
      for (const j of jungle) {
        const d = Math.hypot(x - j.x, z - j.z);
        if (d < j.r) best = Math.max(best, j.v * (1 - d / j.r));
      }
      return best;
    },
    sampleTallPlantDensity: () => 0,
    propStore: {
      types: props.map(() => ({
        live: false,
        mergedBox: { min: { x: -1, z: -1 }, max: { x: 1, z: 1 } },
      })),
      instances: props.map((p, i) => ({ typeIdx: i, px: p.x, pz: p.z, sx: p.r, sz: p.r })),
    },
    buildings: { list: buildings },
    structures: { list: [] },
  };
}

const unit = (x, z, o = {}) => ({
  alive: true, team: "player", position: { x, y: 0, z }, revealed: 0, ...o,
});

console.log("concealment: vegetation, not props");
{
  const c = createCover({ app: fakeApp({ jungle: [{ x: 0, z: 0, r: 40, v: 1 }] }), worldSize: WORLD });
  c.bake();
  const deep = c.concealmentAt(0, 0);
  const edge = c.concealmentAt(0, 34);
  const open = c.concealmentAt(0, 200);
  ok("deep jungle conceals", deep > 0.5, `= ${deep.toFixed(3)}`);
  ok("thin scrub does not", edge === 0, `at 85% out = ${edge}`);
  ok("open ground does not", open === 0);
  ok("concealment never exceeds its cap", deep <= COVER.maxConcealment + 1e-9,
    `${deep.toFixed(3)} <= ${COVER.maxConcealment}`);

  // THE SEPARATION. Jungle must not stop a bullet.
  ok("jungle gives NO cover", c.coverAt(0, 0) === 0, "foliage has never stopped anything");
}

console.log("cover: props, not vegetation");
{
  const c = createCover({ app: fakeApp({ props: [{ x: 0, z: 0, r: 2.5 }] }), worldSize: WORLD });
  ok("bake finds the prop", c.bake() === 1);
  const behind = c.coverAt(0, 4);
  const far = c.coverAt(0, 40);
  ok("beside a boulder is cover", behind > 0, `= ${behind.toFixed(3)}`);
  ok("forty metres away is not", far === 0);
  // THE SEPARATION, the other way. A rock must not hide you.
  ok("a boulder gives NO concealment", c.concealmentAt(0, 4) === 0);

  // Debris is not cover.
  const tiny = createCover({ app: fakeApp({ props: [{ x: 0, z: 0, r: 0.4 }] }), worldSize: WORLD });
  ok("a pebble is not cover", tiny.bake() === 0);
}

console.log("cover is DIRECTIONAL — the whole point of it");
{
  // A boulder to the SOUTH of the target (+z). A shot from the south is
  // blocked by it; a shot from the north has a clear line.
  const c = createCover({ app: fakeApp({ props: [{ x: 0, z: 6, r: 2.5 }] }), worldSize: WORLD });
  c.bake();
  const tx = 0, tz = 0;
  const fromSouth = c.coverBetween(0, 60, tx, tz);   // shooter at +z, rock between
  const fromNorth = c.coverBetween(0, -60, tx, tz);  // shooter at -z, rock behind them
  ok("sheltered from the side the rock is on", fromSouth > 0, `= ${fromSouth.toFixed(3)}`);
  ok("exposed to the flank", fromNorth < fromSouth,
    `${fromNorth.toFixed(3)} < ${fromSouth.toFixed(3)}`);
  ok("cover never exceeds its cap", fromSouth <= COVER.maxCover + 1e-9,
    `${fromSouth.toFixed(3)} <= ${COVER.maxCover}`);
  ok("an ownerless hit is sheltered from nothing", c.coverBetween(tx, tz, tx, tz) === 0);
}

console.log("concealment shortens ACQUISITION, and firing spends it");
{
  const c = createCover({ app: fakeApp({ jungle: [{ x: 0, z: 0, r: 40, v: 1 }] }), worldSize: WORLD });
  c.bake();
  const hidden = unit(0, 0);
  const exposed = unit(300, 0);

  const sHidden = c.acquireRangeScale(0, 60, hidden);
  const sExposed = c.acquireRangeScale(300, 60, exposed);
  ok("a concealed unit is picked up later", sHidden < 1, `scale ${sHidden.toFixed(3)}`);
  ok("a unit in the open is not", sExposed === 1);

  // Point blank beats any bush.
  const sClose = c.acquireRangeScale(0, 4, hidden);
  ok("you cannot hide from someone standing in the bush with you", sClose === 1);

  // THE RULE THAT MAKES IT A MECHANIC.
  c.reveal(hidden);
  ok("firing gives you away", c.acquireRangeScale(0, 60, hidden) === 1,
    `revealed for ${COVER.revealTime}s`);
  // ...and it wears off, on the sim clock.
  for (let i = 0; i < 60 * 5; i++) c.step(1 / 60, [hidden]);
  ok("and it wears off", c.acquireRangeScale(0, 60, hidden) < 1);
  ok("the timer never goes negative", hidden.revealed === 0);
}

console.log("abilities");
{
  let spent = 0, stock = 1000;
  const casts = [];
  const res = { canAfford: (n) => stock >= n, spend: (n) => (stock >= n ? (stock -= n, spent += n, true) : false) };
  const game = {
    smoke: { spawn: (o) => casts.push(["smoke", o]) },
    napalm: { strike: (o) => casts.push(["napalm", o]) },
  };
  const A = createAbilities({ game, resources: res });

  const sol = unit(0, 0, { typeKey: "soldier" });
  const tank = unit(0, 0, { typeKey: "tank" });
  const radio = unit(0, 0, { typeKey: "radio", isStructure: true });

  ok("a soldier has smoke", A.forEntity(sol).some((a) => a.key === "smokeGrenade"));
  ok("a tank does not", A.forEntity(tank).length === 0);
  ok("the radio calls napalm", A.forEntity(radio).some((a) => a.key === "napalmRun"));

  // Cast, and the cooldown lands on the CASTER.
  ok("smoke casts", A.cast(ABILITIES.smokeGrenade, [sol], { x: 10, z: 0 }) === true);
  ok("...and threw one", casts.length === 1 && casts[0][0] === "smoke");
  ok("...and is now cooling", A.check(ABILITIES.smokeGrenade, [sol]).ok === false);

  // THE BUG THIS PREVENTS: a per-ability timer would have put the whole army
  // on cooldown when one soldier threw a grenade.
  const sol2 = unit(0, 0, { typeKey: "soldier" });
  ok("another soldier still has his", A.check(ABILITIES.smokeGrenade, [sol2]).ok === true);

  // Selecting both must use the one who is READY.
  ok("a mixed selection uses whoever has one",
    A.pickCaster(ABILITIES.smokeGrenade, [sol, sol2]) === sol2);

  // Range is enforced at cast, and nothing is spent on a refusal.
  const before = stock;
  ok("out of range is refused",
    A.cast(ABILITIES.napalmRun, [radio], { x: 100000, z: 0, dirX: 0, dirZ: 1 }) === false);
  ok("...and costs nothing", stock === before);

  // Cost.
  ok("napalm casts and is paid for",
    A.cast(ABILITIES.napalmRun, [radio], { x: 40, z: 0, dirX: 0, dirZ: 1 }) === true
    && spent === ABILITIES.napalmRun.cost, `spent ${spent}`);

  // GLOBAL scope: one aircraft, so a SECOND radio is also out.
  const radio2 = unit(0, 0, { typeKey: "radio", isStructure: true });
  ok("a second radio shares the one aircraft", A.check(ABILITIES.napalmRun, [radio2]).ok === false);

  // Broke.
  stock = 0;
  const poorSol = unit(0, 0, { typeKey: "soldier" });
  ok("smoke is free even when broke", A.check(ABILITIES.smokeGrenade, [poorSol]).ok === true,
    "a losing player must still be able to break contact");

  // Cooldowns run on the sim clock and expire.
  for (let i = 0; i < 60 * 40; i++) A.step(1 / 60, [sol, sol2]);
  ok("a caster cooldown expires", A.check(ABILITIES.smokeGrenade, [sol]).ok === true);
  ok("...and the record is cleaned up", !sol.abilityCd?.smokeGrenade);
}

console.log("cost");
{
  // One acquire scan is O(combatants); cover is asked once per shot. Both run
  // inside the fixed step, so a slow answer is a slow game.
  const props = Array.from({ length: 1312 }, (_, i) => ({
    x: (i % 40) * 20 - 400, z: Math.floor(i / 40) * 20 - 400, r: 1.6,
  }));
  const t0 = performance.now();
  const c = createCover({ app: fakeApp({ props, jungle: [{ x: 0, z: 0, r: 300, v: 1 }] }), worldSize: WORLD });
  const n = c.bake();
  const bakeMs = performance.now() - t0;
  ok("baking 1312 props is a load-time cost", bakeMs < 400, `${bakeMs.toFixed(0)} ms for ${n}`);

  const N = 200000;
  const t1 = performance.now();
  let sink = 0;
  for (let i = 0; i < N; i++) sink += c.coverBetween(i % 300, -200, (i % 300) + 5, 0);
  const ms = performance.now() - t1;
  ok("cover queries are free", ms < 300,
    `${ms.toFixed(0)} ms for ${N} = ${(ms * 1000 / N).toFixed(2)} us (sink ${sink.toFixed(0)})`);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
