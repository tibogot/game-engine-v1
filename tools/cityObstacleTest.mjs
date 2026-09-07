// ============================================================================
// CITY OBSTACLES — do the capsules describe the furniture you can SEE?
//
// A collider you cannot see is the easy kind to get wrong: a post that is one
// metre from where it is drawn, or lying down instead of standing up, feels
// like a physics bug rather than a placement bug, and nothing in a screenshot
// says which. So this checks the capsules against the very placement matrices
// the meshes are instanced from — the only source that cannot disagree with
// what is on screen.
//
// It also checks the RADIUS QUERY does its job, because the whole design rests
// on it: hand the vehicle 10k capsules and the frame dies, hand it too few and
// the car drives through a lamp post.
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { createCityStreets } = await import("../games/modular-road-v3/modularRoadCityStreets.js");
const { createCityFurniture } = await import("../games/modular-road-v3/modularRoadCityFurniture.js");
const { createCityObstacles } = await import("../games/modular-road-v3/modularRoadCityObstacles.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

const P = CITY_DEFAULTS;
const streets = createCityStreets({ P, originCellX: 0, originCellZ: 0 });
const furn = createCityFurniture({
  P, originCellX: 0, originCellZ: 0,
  lamp: { pool: streets.lampPoolFree, color: streets.lampColor },
});

check("the street exposes its lamp placements",
  Array.isArray(streets.lampMatrices) && streets.lampMatrices.length > 100,
  `${streets.lampMatrices?.length ?? 0} posts`);
check("the furniture exposes its placement lists",
  !!furn.lists?.cars && !!furn.lists?.trees && !!furn.lists?.lights && !!furn.lists?.rails,
  Object.keys(furn.lists ?? {}).join(","));

const obs = createCityObstacles({
  lampMatrices: streets.lampMatrices,
  lists: furn.lists,
  groundY: P.groundY,
});
check("every placement reached the table",
  obs.stats.total === streets.lampMatrices.length + furn.lists.cars.length
    + furn.lists.trees.length + furn.lists.lights.length + furn.lists.rails.length,
  `${obs.stats.total} obstacles`);

// ── THE RADIUS QUERY ────────────────────────────────────────────────────────
const near = obs.capsulesNear(0, 0, 70);
check("a query returns a workable handful, not the whole city",
  near.length > 0 && near.length < 400, `${near.length} within 70 m of the origin`);
check("a query far outside the city is empty",
  obs.capsulesNear(9e5, 9e5, 70).length === 0);

// Growing the radius can only ever ADD.
const wide = obs.capsulesNear(0, 0, 140);
check("a wider query is a superset", wide.length >= near.length,
  `${near.length} at 70 m → ${wide.length} at 140 m`);

// Nothing returned may be beyond the radius by more than its own extent. The
// query pads by 2.5 m so a parked car whose CENTRE is just outside still comes
// back — anything past that is a bug in the compare.
let tooFar = 0, worst = 0;
for (const c of near) {
  const mx = (c.a.x + c.b.x) / 2, mz = (c.a.z + c.b.z) / 2;
  const d = Math.hypot(mx, mz);
  worst = Math.max(worst, d);
  if (d > 70 + 3.0) tooFar++;
}
check("nothing outside the radius comes back", tooFar === 0,
  `worst centre distance ${worst.toFixed(1)} m`);

// ── THE SHAPES ──────────────────────────────────────────────────────────────
// Upright posts stand up; cars and rails lie down. Getting this backwards
// makes a lamp post a 9 m wall across the street.
let upright = 0, lying = 0, badRadius = 0, underground = 0;
for (const c of near) {
  const dy = Math.abs(c.b.y - c.a.y);
  const dxz = Math.hypot(c.b.x - c.a.x, c.b.z - c.a.z);
  if (dy > dxz) upright++; else lying++;
  if (!(c.radius > 0.02 && c.radius < 1.5)) badRadius++;
  if (Math.min(c.a.y, c.b.y) < P.groundY - 0.01) underground++;
}
check("there are both upright and lying capsules", upright > 0 && lying > 0,
  `${upright} upright, ${lying} lying`);
check("every radius is sane", badRadius === 0, `${badRadius} bad`);
check("nothing is buried below the street", underground === 0, `${underground} below ${P.groundY}`);

// ── AGREEMENT WITH THE MESHES ───────────────────────────────────────────────
// Every lamp post placement within the radius must have a capsule standing at
// its (x, z). This is the check that catches a yaw/axis mix-up in the table.
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
let missing = 0, lampsInRange = 0;
for (const m of streets.lampMatrices) {
  m.decompose(_p, _q, _s);
  if (Math.hypot(_p.x, _p.z) > 60) continue;      // inside the 70 m query, with margin
  lampsInRange++;
  const hit = near.some((c) => Math.abs(c.b.y - c.a.y) > 4
    && Math.hypot(c.a.x - _p.x, c.a.z - _p.z) < 0.05);
  if (!hit) missing++;
}
check("every lamp post in range has a capsule standing at it",
  lampsInRange > 3 && missing === 0, `${missing} of ${lampsInRange} missing`);

// A parked car's capsule must lie ALONG the car, not across it: the axis it
// spans has to agree with the yaw the mesh was placed with.
let carsChecked = 0, carAxisWrong = 0;
for (const e of furn.lists.cars) {
  e.m.decompose(_p, _q, _s);
  if (Math.hypot(_p.x, _p.z) > 60) continue;
  const cap = near.find((c) => Math.abs(c.b.y - c.a.y) < 0.01
    && Math.hypot((c.a.x + c.b.x) / 2 - _p.x, (c.a.z + c.b.z) / 2 - _p.z) < 0.05
    && c.radius > 0.5);
  if (!cap) continue;
  carsChecked++;
  const yaw = new THREE.Euler().setFromQuaternion(_q, "YXZ").y;
  // The model's nose is at local -Z, so its long axis in world is
  // (-sin yaw, 0, -cos yaw); the capsule's axis must be parallel to it.
  const ax = -Math.sin(yaw), az = -Math.cos(yaw);
  const cx = cap.b.x - cap.a.x, cz = cap.b.z - cap.a.z;
  const len = Math.hypot(cx, cz) || 1;
  if (Math.abs((cx / len) * ax + (cz / len) * az) < 0.98) carAxisWrong++;
}
check("a parked car's capsule lies along the car", carsChecked > 2 && carAxisWrong === 0,
  `${carAxisWrong} of ${carsChecked} across instead of along`);

// ── THE TOGGLES ─────────────────────────────────────────────────────────────
obs.params.lamps = false;
const noLamps = obs.capsulesNear(0, 0, 70);
check("turning a kind off removes exactly that kind",
  noLamps.length < near.length, `${near.length} → ${noLamps.length}`);
obs.params.lamps = true;
check("turning it back on restores the set", obs.capsulesNear(0, 0, 70).length === near.length);

for (const k of ["lamps", "lights", "trees", "cars", "rails"]) obs.params[k] = false;
check("all kinds off returns nothing", obs.capsulesNear(0, 0, 70).length === 0);
for (const k of ["lamps", "lights", "trees", "cars", "rails"]) obs.params[k] = true;

// ── THE SPAWN ───────────────────────────────────────────────────────────────
// The bug that shipped: the lamp grid knows nothing about where the car
// appears, the default spawn sits on that grid, and the car spawned impaled on
// a post and could not move.
//
// The first fix punched a hole in the collision around the spawn. That was the
// wrong trade — two lamp posts you can see and drive straight through, at the
// one place the player looks hardest — so nothing is exempt any more and the
// CAR moves instead, onto the middle of the nearest carriageway.
//
// Which makes this the check that matters: is that point actually clear?
const { createModularRoadCity } = await import("../games/modular-road-v3/modularRoadCity.js");
const city = createModularRoadCity({ params: { extent: 400 } });
check("the city offers a street spawn", typeof city.streetSpawnNear === "function");

const spot = city.streetSpawnNear(0, 0);
check("the street spawn is somewhere sensible",
  Number.isFinite(spot.x) && Number.isFinite(spot.z) && Number.isFinite(spot.yaw),
  `(${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}) yaw ${spot.yaw.toFixed(2)}`);

// It has to be ON a carriageway: streets are the band [blockW, pitch) of each
// period, and the point should sit at its centre, not on a block or a kerb.
const pitch = (P.blockLots + P.streetLots) * P.lotSize;
const blockW = P.blockLots * P.lotSize;
const streetW = P.streetLots * P.lotSize;
const bandOf = (v) => (((v % pitch) + pitch) % pitch);
const onStreet = (v) => { const b = bandOf(v); return b >= blockW && b <= pitch; };
check("the spawn point is on a carriageway",
  spot.yaw === 0 ? onStreet(spot.x) : onStreet(spot.z),
  `across-street band ${(spot.yaw === 0 ? bandOf(spot.x) : bandOf(spot.z)).toFixed(1)} of [${blockW}, ${pitch}]`);
check("and mid-carriageway, not against a kerb",
  Math.abs((spot.yaw === 0 ? bandOf(spot.x) : bandOf(spot.z)) - (blockW + streetW / 2)) < 0.01);

// And — the whole point — nothing solid is standing in it. The car is ~4.5 m
// long and 1.8 wide, so a 4 m clearance is what "you can drive away" means.
const CAR_CLEAR = 4.0;
const around = city.obstacleCapsulesNear(spot.x, spot.z, 30);
let onTop = 0, nearest = Infinity;
for (const c of around) {
  // Distance from the spawn to the capsule's SEGMENT, not to its centre — a
  // parked car 4 m long is not described by its middle.
  const ax = c.a.x, az = c.a.z, bx = c.b.x, bz = c.b.z;
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((spot.x - ax) * dx + (spot.z - az) * dz) / len2)) : 0;
  const px = ax + dx * t, pz = az + dz * t;
  const d = Math.hypot(spot.x - px, spot.z - pz) - c.radius;
  nearest = Math.min(nearest, d);
  if (d < CAR_CLEAR) onTop++;
}
check("nothing solid is standing in the spawn", onTop === 0,
  `${onTop} within ${CAR_CLEAR} m; nearest obstacle ${nearest.toFixed(2)} m away`);

// ── THE TRACK CORRIDOR ──────────────────────────────────────────────────────
// Baked, not live: a lamp post inside the corridor was drawn but harmless while
// it was scenery, and is a post you cannot see coming now that it is solid.
const corridor = createCityObstacles({
  lampMatrices: streets.lampMatrices,
  lists: furn.lists,
  groundY: P.groundY,
  // A 120 m band along x = 0, expressed the way the game's cityAvoid does it.
  avoid: (x) => (Math.abs(x) < 60 ? -1 : Infinity),
  avoidRadius: 40,
});
check("the corridor drops furniture from the table",
  corridor.stats.dropped > 0 && corridor.stats.total < obs.stats.total,
  `${corridor.stats.dropped} dropped, ${corridor.stats.total} left of ${obs.stats.total}`);
let inCorridor = 0;
for (const c of corridor.capsulesNear(0, 0, 200)) {
  if (Math.abs((c.a.x + c.b.x) / 2) < 60) inCorridor++;
}
check("nothing solid is left standing in the corridor", inCorridor === 0, `${inCorridor} left`);

console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
