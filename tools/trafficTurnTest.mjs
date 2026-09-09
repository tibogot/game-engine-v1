// ============================================================================
// CITY TRAFFIC: do cars TURN at junctions, and is the turn legal?
//
// Without turning, every lane is an infinite straight line and the city reads
// as a set of parallel conveyor belts — nothing ever leaves the street it
// started on. Turning fixes that and breaks two invariants on the way, both of
// which are silent in the game:
//
//   • THE RING. A lane's cars are in cyclic order and each one follows the next
//     round; that is the only reason a red light produces a queue instead of a
//     pile. A car joining a lane has to be spliced into the arc it actually
//     occupies. Sort it by `u` instead and every car that has lapped gets a
//     leader BEHIND it — which does not throw, it just makes that lane's queue
//     silently run backwards.
//   • THE SIDE OF THE ROAD. `turnTo` and `lanePairFor` are derived from the one
//     lane table, but a sign error would send right-turners into oncoming
//     traffic on one axis only — the exact shape of every previous bug in this
//     file, and invisible unless you happen to be driving on that axis.
//
// So this steps the real simulation and watches what the cars DO.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
await import("three/webgpu");
const furniture = await import("../games/modular-road-v3/modularRoadCityFurniture.js");
const { createCityFurniture, laneDirForIndex, lanePairFor, turnTo, LANE_FRACS,
  FURNITURE_DEFAULTS } = furniture;
const { createCityStreets } = await import("../games/modular-road-v3/modularRoadCityStreets.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// ── The lane table, on its own ──────────────────────────────────────────────
// Cheap, exact, and it pins the geometry the simulation below can only sample.
{
  // Right of +Z is -X; right of +X is +Z. `right = forward x up`.
  const t1 = turnTo("z", 1, 1);
  const t2 = turnTo("x", 1, 1);
  check("a right turn out of +Z heads -X", t1.axis === "x" && t1.dir === -1, JSON.stringify(t1));
  check("a right turn out of +X heads +Z", t2.axis === "z" && t2.dir === 1, JSON.stringify(t2));
  const t3 = turnTo("z", 1, -1);
  check("a left turn out of +Z heads +X", t3.axis === "x" && t3.dir === 1, JSON.stringify(t3));

  // Turn right four times and you are back where you started, on the lane you
  // started in. Anything that is only wrong on one axis fails this.
  let a = "z", d = 1;
  for (let i = 0; i < 4; i++) { const t = turnTo(a, d, 1); a = t.axis; d = t.dir; }
  check("four right turns come back to the start", a === "z" && d === 1, `${a}${d > 0 ? "+" : "-"}`);

  // Every lane belongs to exactly one direction's pair, kerb-most or median.
  for (const axis of ["x", "z"]) {
    for (let fi = 0; fi < 4; fi++) {
      const pair = lanePairFor(axis, laneDirForIndex(axis, fi));
      if (!pair.includes(fi)) check(`lane ${axis}${fi} is in its own direction's pair`, false);
    }
  }
  check("every lane is in the pair for its own direction", true, "8 lanes");

  // The kerb-most lane is the one FURTHER from the street's centre line.
  for (const axis of ["x", "z"]) {
    for (const dir of [1, -1]) {
      const [kerb, med] = lanePairFor(axis, dir);
      const dk = Math.abs(LANE_FRACS[kerb] - 0.5), dm = Math.abs(LANE_FRACS[med] - 0.5);
      if (dk <= dm) check(`kerb-most is outermost on ${axis}${dir}`, false, `${dk} vs ${dm}`);
    }
  }
  check("the kerb-most lane is the outer one, both axes, both directions", true);
}

// ── The simulation ──────────────────────────────────────────────────────────
const streets = createCityStreets({ P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0 });
const furn = createCityFurniture({
  P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0,
  lamp: { pool: streets.lampPoolFree, color: streets.lampColor },
  params: { trafficRange: 1e6 },
});
const cars = furn.traffic;
const lanes = furn.lanes;
check("there is traffic to watch", cars.length > 0 && lanes.length > 0,
  `${cars.length} cars on ${lanes.length} lanes`);

/** A camera far from everything: `updateTraffic` still steps the model. */
const cam = { x: 0, z: 0 };
const before = cars.map((c) => ({ li: c.li, axis: c.lane.axis, dir: c.lane.dir, fi: c.lane.fi }));

// Long enough that a car at 7.5 m/s covers several block pitches.
let turns = 0;
let lastLi = cars.map((c) => c.li);
const illegalHand = [];
const illegalTarget = [];
const seen = new Map();
for (let step = 0; step < 900; step++) {
  const t = step * 0.05;
  // Watch every car that is mid-turn, and record what the turn CLAIMS to be.
  for (const c of cars) {
    if (!c.turn || seen.has(c)) continue;
    seen.set(c, true);
    const from = c.lane;
    const pair = lanePairFor(from.axis, from.dir);
    const hand = from.fi === pair[0] ? 1 : -1;
    const to = turnTo(from.axis, from.dir, hand);
    const target = lanes[c.turn.li];
    if (!target) { illegalTarget.push("missing lane"); continue; }
    if (target.axis !== to.axis || target.dir !== to.dir) {
      illegalTarget.push(`${from.axis}${from.dir} ${hand > 0 ? "R" : "L"} -> ${target.axis}${target.dir}`);
    }
    const tPair = lanePairFor(target.axis, target.dir);
    if (target.fi !== (hand === 1 ? tPair[0] : tPair[1])) {
      illegalHand.push(`${hand > 0 ? "right" : "left"} into lane ${target.fi}`);
    }
  }
  furn.updateTraffic(t, cam);
  // A completed turn IS a lane change; counting those needs no extra bookkeeping
  // inside the model and cannot miss one that finished between two samples.
  for (let i = 0; i < cars.length; i++) {
    if (cars[i].li !== lastLi[i]) { turns++; lastLi[i] = cars[i].li; }
  }
}

check("cars actually turn", turns > 0, `${turns} completed turns in 45 s`);
const moved = cars.filter((c, i) => c.lane.axis !== before[i].axis).length;
check("cars end up on the OTHER street axis", moved > 0, `${moved} of ${cars.length} changed axis`);
check("every turn goes to the axis and direction the lane table says",
  illegalTarget.length === 0, illegalTarget.slice(0, 3).join("; "));
check("a right turn lands in the kerb-most lane and a left in the median-most",
  illegalHand.length === 0, illegalHand.slice(0, 3).join("; "));

// ── THE RING, after all that splicing ───────────────────────────────────────
// Forward gaps around a correctly ordered ring sum to exactly 1. If a car were
// spliced into the wrong arc the sum would come out an integer greater than 1,
// because the walk would lap more than once.
{
  const bad = [];
  for (let li = 0; li < lanes.length; li++) {
    const row = furn.laneCars[li];
    if (!row || row.length < 2) continue;
    let sum = 0;
    for (let i = 0; i < row.length; i++) {
      const a = row[i].u, b = row[(i + 1) % row.length].u;
      let d = (b - a) % 1;
      if (d < 0) d += 1;
      sum += d;
    }
    if (Math.abs(sum - 1) > 1e-6) bad.push(`lane ${li}: ${sum.toFixed(3)}`);
  }
  check("every lane's ring still walks round exactly once",
    bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${lanes.length} lanes`);
}

// ── NOBODY IS INSIDE ANYBODY ────────────────────────────────────────────────
// The point of the ring is that a queue forms instead of a pile. A turning car
// joins a lane it was not in, so this is the check that its arrival did not
// land it on top of somebody.
{
  let worst = Infinity, worstLane = -1;
  for (let li = 0; li < lanes.length; li++) {
    const row = furn.laneCars[li];
    if (!row || row.length < 2) continue;
    const span = lanes[li].span;
    for (let i = 0; i < row.length; i++) {
      const a = row[i].u, b = row[(i + 1) % row.length].u;
      let d = (b - a) % 1;
      if (d < 0) d += 1;
      if (d * span < worst) { worst = d * span; worstLane = li; }
    }
  }
  // Half the standstill gap: cars legitimately close up at red lights, and the
  // model's own cap allows a little less than `trafficGap` while they settle.
  // Cars legitimately close right up at a red light, and the model's own step
  // cap lets them settle a little inside the standstill gap. Half of it is the
  // line between "a queue" and "one car inside another".
  check("no car has been dropped on top of another",
    worst > FURNITURE_DEFAULTS.trafficGap * 0.5,
    `closest pair ${worst.toFixed(2)} m (lane ${worstLane}), gap is ${FURNITURE_DEFAULTS.trafficGap} m`);
}

// ── THE TURN IS DRAWN WHERE IT HAPPENS ──────────────────────────────────────
// The arc is a render-time curve around the corner; the corner has to be inside
// the junction box, or cars would swing through a building.
{
  const P = CITY_DEFAULTS;
  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const bad = [];
  for (const c of cars) {
    if (!c.turn) continue;
    // originCell is 0 here, so a cell starts at a multiple of `pitch`; within
    // it, [0, blockW) is the block and [blockW, pitch) is the junction.
    for (const v of [c.turn.cx, c.turn.cz]) {
      let f = v % pitch;
      if (f < 0) f += pitch;
      if (f < blockW - 1e-6) bad.push(`${v.toFixed(1)} sits ${f.toFixed(1)} into a block`);
    }
  }
  check("every corner is inside a junction, not inside a block",
    bad.length === 0, bad.length ? bad.slice(0, 2).join("; ") : "all corners in the box");
}

// ── MID-CORNER, DOES IT STILL FACE THE WAY IT IS GOING? ─────────────────────
//
// On the straights the yaw comes from a four-case table that trafficHeadingTest
// already locks down. On the arc it comes from the curve's own tangent, which
// is new code, and "the car drives backwards" is the failure this file has
// shipped twice. So: find cars actually mid-corner, and compare where the nose
// points with where the car MOVED.
{
  const { CAR_BODIES, CAR_NOSE_Z } = furniture;
  const meshes = [];
  furn.group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const i = CAR_BODIES.findIndex((b) => o.name === "CityTraffic_" + b.name);
    if (i >= 0) meshes[i] = o;
  });
  // Every car is in range (trafficRange 1e6), so updateTraffic fills slots in
  // `traffic` order within each body — which is what makes a car nameable here.
  const slotOf = new Map();
  const nextSlot = [];
  for (const c of cars) {
    const bi = c.body ?? 0;
    nextSlot[bi] = nextSlot[bi] || 0;
    slotOf.set(c, { bi, slot: nextSlot[bi]++ });
  }
  const poseOf = (c) => {
    const { bi, slot } = slotOf.get(c);
    const e = meshes[bi].instanceMatrix.array;
    const o = slot * 16;
    // Column 3 is the translation; column 2 is the model's local +Z in world.
    return { x: e[o + 12], z: e[o + 14], nx: e[o + 8], nz: e[o + 10] };
  };

  let sampled = 0, worst = 1, worstId = -1;
  const sg = CAR_NOSE_Z > 0 ? 1 : -1;
  for (let step = 900; step < 1500 && sampled < 300; step++) {
    const t = step * 0.05;
    furn.updateTraffic(t, cam);
    const mid = cars.filter((c) => c.turn);
    const a = new Map(mid.map((c) => [c, poseOf(c)]));
    furn.updateTraffic(t + 0.05, cam);
    for (const c of mid) {
      if (!c.turn) continue;                    // finished between the samples
      const p0 = a.get(c), p1 = poseOf(c);
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.05) continue;                 // stopped, or barely moving
      sampled++;
      const dot = ((dx / len) * p1.nx + (dz / len) * p1.nz) * sg;
      if (dot < worst) { worst = dot; worstId = c.id; }
    }
  }
  check("cars were caught mid-corner to check", sampled > 20, sampled + " samples");
  // Not 1.0, and it should not be: the nose reads the tangent at the END of the
  // step while the measured travel is the chord ACROSS it, so on a real corner
  // the two differ by half the step's turn. Backwards would be negative.
  check("a turning car faces the way it is turning", worst > 0.97,
    "worst nose-travel " + worst.toFixed(3) + " (car " + worstId + ")");
}

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
