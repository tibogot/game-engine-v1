// ============================================================================
// CITY TRAFFIC: does a car FACE THE WAY IT IS GOING?
//
// It did not, on half the streets. `updateTraffic` derives the world position
// from the lane's axis and direction, and the yaw from a separate hand-written
// table — two expressions of the same fact, and the Z-lane half of the table
// was 180 degrees out. The car drove tail-first, so its RED tail lamps led.
//
// A table cannot be checked by reading it; that is how it got written wrong.
// So this checks it the only way that means anything: step the simulation,
// see where the car actually MOVED, and compare that with where its nose ends
// up pointing. It also checks the head/tail lamp ends, because "red at the
// front" is the symptom that has to stay fixed even if the yaw convention
// changes again.
// ============================================================================
// `three/webgpu` behind the hook, not plain `three`: the furniture's materials
// reach for THREE.MRTNode via applyBloomMRT, which only exists on the WebGPU
// build. Same setup as cityShaderTest.mjs.
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { createCityFurniture, CAR_NOSE_Z } = await import("../games/modular-road-v3/modularRoadCityFurniture.js");
const { createCityStreets } = await import("../games/modular-road-v3/modularRoadCityStreets.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// The REAL lamp field, not a stub: `lamp.pool()` returns a TSL node that the
// furniture's emissive multiplies, so a plain number throws on `.mul`.
const streets = createCityStreets({ P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0 });
const furn = createCityFurniture({
  P: CITY_DEFAULTS, originCellX: 0, originCellZ: 0,
  lamp: { pool: streets.lampPoolFree, color: streets.lampColor },
  // A range that keeps EVERY car. `updateTraffic` compacts in-range cars into
  // the low instance slots, so at the default 380 m one car leaving the range
  // shifts every slot after it and the two samples stop describing the same
  // cars — the comparison below would then be nonsense that happens to pass.
  params: { trafficRange: 1e6 },
});

let traffic = null;
furn.group.traverse((o) => { if (o.name === "CityTraffic") traffic = o; });
check("the traffic mesh exists", traffic !== null);

/** Every instance's pose at time `t`, keyed by its instance slot. */
function poseAt(t) {
  // A camera at the centre with a huge range, so the distance cull keeps
  // everything and instance slots stay comparable between the two samples.
  furn.updateTraffic(t, new THREE.Vector3(0, 0, 0));
  const out = [];
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (let i = 0; i < traffic.count; i++) {
    traffic.getMatrixAt(i, m);
    m.decompose(p, q, s);
    out.push({ pos: p.clone(), quat: q.clone() });
  }
  return out;
}

const a = poseAt(0);
const b = poseAt(0.25);
check("cars are actually placed", a.length > 20, `${a.length} in range`);
check("every car is in range, so instance slots mean the same car in both samples",
  a.length === b.length, `${a.length} → ${b.length}`);

// ── WHICH END IS THE NOSE ───────────────────────────────────────────────────
// Not asserted from a comment — MEASURED off the built geometry, then checked
// against the constant the lamps and the yaw are both derived from. The bug
// this file exists for was exactly a disagreement between those two.
let carMesh = null;
furn.group.traverse((o) => { if (o.name === "CityCars") carMesh = o; });
check("the parked-car mesh exists", carMesh !== null);
{
  const pos = carMesh.geometry.getAttribute("position");
  // Tallest point of the BODY in each half, ignoring the lamp boxes beyond the
  // bevel. The bonnet half is the low one; the cabin sits over the boot half.
  let hiPos = 0, hiNeg = 0;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i), y = pos.getY(i);
    if (Math.abs(z) > 2.36) continue;          // lamp boxes, not body
    if (z > 1.2) hiPos = Math.max(hiPos, y);
    else if (z < -1.2) hiNeg = Math.max(hiNeg, y);
  }
  // The end with the LOWER roofline is the bonnet.
  const measuredNose = hiPos < hiNeg ? 1 : -1;
  check("the model's nose is where CAR_NOSE_Z says it is",
    measuredNose === CAR_NOSE_Z,
    `geometry says ${measuredNose > 0 ? "+Z" : "-Z"} (heights ${hiNeg.toFixed(2)} / ${hiPos.toFixed(2)}), constant says ${CAR_NOSE_Z > 0 ? "+Z" : "-Z"}`);

  // And the WHITE lamps are on that end. Told apart by EACH BOX's own width —
  // headlights are 0.50 across, tail lights 0.46. Not by the pair's overall
  // span: the tails sit further outboard (±0.64 vs ±0.60), so the narrower
  // boxes make the wider pair, which is a trap this check first fell into.
  const boxes = new Map();                 // (z sign, x sign) → x extent
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i), x = pos.getX(i);
    if (Math.abs(z) <= 2.36) continue;
    const k = `${z > 0 ? "+" : "-"}${x > 0 ? "+" : "-"}`;
    const e = boxes.get(k) ?? { minX: 9, maxX: -9 };
    e.minX = Math.min(e.minX, x);
    e.maxX = Math.max(e.maxX, x);
    boxes.set(k, e);
  }
  const widthAt = (zs) => {
    let w = 0;
    for (const [k, e] of boxes) if (k[0] === zs) w = Math.max(w, e.maxX - e.minX);
    return w;
  };
  const wPos = widthAt("+"), wNeg = widthAt("-");
  const headZ = wPos > wNeg ? 1 : -1;
  check("the headlights are on the bonnet, not the boot", headZ === CAR_NOSE_Z,
    `single-box width ${wNeg.toFixed(2)} at -Z vs ${wPos.toFixed(2)} at +Z; nose is at ${CAR_NOSE_Z > 0 ? "+Z" : "-Z"}`);
}

const NOSE_LOCAL = new THREE.Vector3(0, 0, CAR_NOSE_Z);
const travel = new THREE.Vector3();
const nose = new THREE.Vector3();

let worst = 1, worstIdx = -1, moved = 0, wrongWay = 0;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  travel.subVectors(b[i].pos, a[i].pos);
  // A wrapping car jumps the whole city in one step; it is not moving backwards.
  if (travel.length() < 1e-4 || travel.length() > 50) continue;
  travel.normalize();
  nose.copy(NOSE_LOCAL).applyQuaternion(a[i].quat).normalize();
  const d = nose.dot(travel);
  moved++;
  if (d < 0.99) wrongWay++;
  if (d < worst) { worst = d; worstIdx = i; }
}
check("cars actually moved between the two samples", moved > 10, `${moved} moving`);
check("EVERY car faces the way it is going", wrongWay === 0,
  `${wrongWay} of ${moved} reversed; worst nose·travel = ${worst.toFixed(3)} (instance ${worstIdx})`);

// Both axes have to be covered, or a table that is right on one and wrong on
// the other passes — which is precisely the bug this file exists for.
let alongX = 0, alongZ = 0;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  travel.subVectors(b[i].pos, a[i].pos);
  if (travel.length() < 1e-4 || travel.length() > 50) continue;
  if (Math.abs(travel.x) > Math.abs(travel.z)) alongX++; else alongZ++;
}
check("both street axes are exercised", alongX > 3 && alongZ > 3, `${alongX} on X, ${alongZ} on Z`);

// And each direction on each axis, so a sign error in one of the four cases
// cannot hide behind the other three.
const seen = new Set();
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  travel.subVectors(b[i].pos, a[i].pos);
  if (travel.length() < 1e-4 || travel.length() > 50) continue;
  travel.normalize();
  seen.add(Math.abs(travel.x) > Math.abs(travel.z) ? (travel.x > 0 ? "+X" : "-X") : (travel.z > 0 ? "+Z" : "-Z"));
}
check("all four lane directions are exercised", seen.size === 4, [...seen].sort().join(" "));

// RIGHT-HAND TRAFFIC: a car's own right-hand side should point AWAY from the
// centre line of its street — the lane it is in should be on its right.
// forward x up is the right-hand vector for this handedness.
const right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
const pitch = (CITY_DEFAULTS.blockLots + CITY_DEFAULTS.streetLots) * CITY_DEFAULTS.lotSize;
const blockW = CITY_DEFAULTS.blockLots * CITY_DEFAULTS.lotSize;
const streetW = CITY_DEFAULTS.streetLots * CITY_DEFAULTS.lotSize;
let wrongSide = 0, sided = 0;
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  travel.subVectors(b[i].pos, a[i].pos);
  if (travel.length() < 1e-4 || travel.length() > 50) continue;
  travel.normalize();
  right.crossVectors(travel, up).normalize();
  // Where across its own street is it? 0 at one kerb, 1 at the other.
  const acrossWorld = Math.abs(travel.x) > Math.abs(travel.z) ? a[i].pos.z : a[i].pos.x;
  const f = (((acrossWorld % pitch) + pitch) % pitch - blockW) / streetW;
  if (f < 0 || f > 1) continue;             // not on a carriageway this frame
  sided++;
  // The centre of the street is f = 0.5. "Right of centre" means the vector
  // from the centre to the car agrees with the car's right-hand vector.
  const toCarSign = Math.sign(f - 0.5);
  const rightSign = Math.sign(Math.abs(travel.x) > Math.abs(travel.z) ? right.z : right.x);
  if (toCarSign !== rightSign) wrongSide++;
}
check("traffic keeps right", sided > 5 && wrongSide === 0, `${wrongSide} of ${sided} on the wrong side`);

furn.dispose?.();
console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
