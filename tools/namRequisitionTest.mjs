/**
 * NAM-RTS REQUISITION POINTS: capture, contest, loss, income.
 *
 * The rules (games/nam-rts/requisition.js), driven with stand-in units:
 *   · one man in the zone takes a neutral point in captureTime seconds
 *   · more men take it faster, capped
 *   · both sides in the zone: nothing moves
 *   · a held point is lost only when pulled back to neutral, and the other
 *     side must then run it all the way to take it
 *   · vehicles capture nothing
 *   · a held point pays incomePerPoint every second
 *
 *   node tools/namRequisitionTest.mjs
 */
import * as THREE from "three";
import { createRequisition, REQUISITION } from "../games/nam-rts/requisition.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

const man = (team, x = 0, z = 0) => ({ alive: true, isAir: false, typeKey: "soldier", team, position: new THREE.Vector3(x, 0, z) });
const jeep = (team) => ({ alive: true, isAir: false, typeKey: "jeep", team, position: new THREE.Vector3(0, 0, 0) });

function setup() {
  let stock = 0;
  const events = [];
  const resources = { earn: (n) => { stock += n; } };
  const req = createRequisition({
    app: {}, resources,
    onCapture: (p, team) => events.push(`capture:${team}`),
    onLost: (p, team) => events.push(`lost:${team}`),
  });
  req.points.push({ position: new THREE.Vector3(0, 0, 0), radius: REQUISITION.radius, progress: 0, owner: null, contested: false, capturing: 0 });
  return { req, p: req.points[0], events, get stock() { return stock; } };
}
const run = (req, units, seconds, dt = 1 / 60) => { for (let t = 0; t < seconds; t += dt) req.step(dt, units); };
const T = REQUISITION.captureTime;

console.log("capture");
{
  const s = setup();
  run(s.req, [man("player")], T * 0.98);
  ok("one man: not yet held just before captureTime", s.p.owner === null, `progress ${s.p.progress.toFixed(3)}`);
  run(s.req, [man("player")], T * 0.05);
  ok("one man: held after captureTime", s.p.owner === "player");
  ok("capture fires once", s.events.join() === "capture:player", s.events.join());
}
{
  const s = setup();
  const squad = [man("player"), man("player"), man("player"), man("player"), man("player"), man("player")];
  run(s.req, squad, T / (1 + REQUISITION.crowdBonus * (REQUISITION.crowdCap - 1)) + 0.05);
  ok("a squad takes it faster (capped at crowdCap)", s.p.owner === "player");
}
{
  const s = setup();
  run(s.req, [man("player", REQUISITION.radius + 1, 0)], T * 2);
  ok("a man outside the zone captures nothing", s.p.progress === 0);
  run(s.req, [jeep("player")], T * 2);
  ok("a vehicle captures nothing", s.p.progress === 0);
}

console.log("contest and loss");
{
  const s = setup();
  run(s.req, [man("player")], T * 0.5);
  const mid = s.p.progress;
  run(s.req, [man("player"), man("enemy")], T);
  ok("both sides in: nothing moves", Math.abs(s.p.progress - mid) < 1e-9 && s.p.contested);
}
{
  const s = setup();
  run(s.req, [man("player")], T * 1.05);
  run(s.req, [man("enemy")], T * 0.5);
  ok("half pulled back: still yours", s.p.owner === "player", `progress ${s.p.progress.toFixed(3)}`);
  run(s.req, [man("enemy")], T * 0.55);
  ok("pulled to neutral: lost", s.p.owner === null && s.events.includes("lost:player"));
  run(s.req, [man("enemy")], T * 0.9);
  ok("not theirs until they run it to the end", s.p.owner === null);
  run(s.req, [man("enemy")], T * 0.15);
  ok("then theirs", s.p.owner === "enemy");
}

console.log("income");
{
  const s = setup();
  run(s.req, [man("player")], T * 1.001);
  const before = s.stock;
  run(s.req, [], 10);
  ok("a held point pays incomePerPoint a second", Math.abs(s.stock - before - 10 * REQUISITION.incomePerPoint) < 0.05,
    `${(s.stock - before).toFixed(2)} in 10 s`);
  ok("an empty zone keeps its owner", s.p.owner === "player");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
