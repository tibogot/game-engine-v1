// ============================================================================
// DRIVE THE SIDE ROADS THROUGH THE PORTAL — the real underpass geometry, the
// real car, no models.
//
// Reported, and reported again after two "fixes": "an invisible mesh blocks the
// car at the tunnel portal, on both side roads", sparks when hit fast, blocking
// backward too. Each earlier fix was tested by inspecting geometry; this one is
// tested by driving. The underpass's own `collisionMeshes()` are baked into the
// same BVHs the game bakes, the car is put in the lane beside the trench and
// driven through both portals, forward and backward, at speed, hugging the
// barrier with its outer half-metre over the lip strip — exactly the reported
// line — and it must arrive on the far side untouched by the solids channel.
//
// The cause, for the record: the parapet's end cap and the portal headwall top
// out flush with the street, buried under the lip strip, and the chassis
// resolver's walled-in recovery reached them (SOLID.buriedBelow in the vehicle;
// tools/buriedSolidTest.mjs for the isolated case). Before it, the wall across
// the mouth also spanned the lip strips (modularRoadCityUnderpass.js).
//
// Run:  node tools/underpassDriveTest.mjs
// ============================================================================
import { register } from "node:module";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { underpassLayout, createCityUnderpass } =
  await import("../games/modular-road-v3/modularRoadCityUnderpass.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");
const { RoadBvh } = await import("../v3/play/modularRoadBvh.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.underpassDriveTest.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, CHASSIS_HULL } = await import(pathToFileURL(TMP).href).finally(() => unlinkSync(TMP));

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = this.tires.map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group();
  this.arrowGroup.visible = false;
  this.arrows = this.tires.map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

const P = CITY_DEFAULTS;
const L = underpassLayout({ P, originCellX: 0, originCellZ: 0 });
const built = createCityUnderpass({ layout: L });
built.group.updateMatrixWorld(true);
const col = built.collisionMeshes();
const U = L.params;
const inner = U.roadWidth / 2 + U.wallGap;
const outer = inner + U.wallThick;

/**
 * The street beside the trench is a height FUNCTION in the game, not a mesh,
 * so the lane the car drives in needs a floor here: a flat plate at street
 * level from the lip edge outward, both sides, long enough for the run.
 */
const streetPlates = [];
for (const s of [-1, 1]) {
  // The whole trench, mouth to mouth, plus a run-up at each end.
  const w = 30, len = (L.a1 - L.a0) + 200, mid = (L.a0 + L.a1) / 2;
  const g = new THREE.PlaneGeometry(w, len).rotateX(-Math.PI / 2);
  const acr = s * (L.holeHalf + w / 2);
  if (L.axis === "x") g.rotateY(Math.PI / 2).translate(mid, L.top, L.across + acr);
  else g.translate(L.across + acr, L.top, mid);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.updateMatrixWorld(true);
  streetPlates.push(m);
}
const mk = (meshes) => { const b = new RoadBvh(); b.bakeFromMeshes(meshes); return b; };
const deck = mk([...col.deck, ...streetPlates]);
const solids = mk(col.solids);
console.log(`axis ${L.axis}, across ${L.across}, portals at ${L.cov0} / ${L.cov1}, lip edge ±${L.holeHalf.toFixed(2)}, wall ${inner.toFixed(2)}..${outer.toFixed(2)}`);
console.log(`deck ${deck.triCount} tris (${col.deck.map((m) => m.name).join(", ")} + 2 street plates), solids ${solids.triCount} tris (${col.solids.map((m) => m.name).join(", ")})\n`);

const world = (along, acr) => (L.axis === "x"
  ? new THREE.Vector3(along, 0, L.across + acr)
  : new THREE.Vector3(L.across + acr, 0, along));

/**
 * Drive through the portal at `portal` (cov0 or cov1), in the lane on side
 * `s`, with the hull's inner edge `edgeIn` metres INSIDE the lip edge (so 0.5
 * = the outer half-metre of the car over the lip strip). `dir` +1 goes from
 * the roof out into the open trench side, −1 the other way; `reverse` drives
 * the same path backward. Reports crossing and solid touches.
 */
function run({ portal, s, edgeIn = 0.5, speed = 20, dir = 1, reverse = false, secs = 4 }) {
  const acr = s * (L.holeHalf - edgeIn + CHASSIS_HULL.width / 2);
  // Which way along the axis is "out of the roof" at this portal.
  const outward = portal === L.cov1 ? 1 : -1;
  const travel = outward * dir;
  const start = portal - travel * 35;
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  const p0 = world(start, acr);
  car.body.pos.set(p0.x, L.top + 0.55, p0.z);
  // Nose along the travel direction, or away from it when reversing.
  const nose = reverse ? -travel : travel;
  const yaw = L.axis === "x" ? (nose > 0 ? Math.PI / 2 : -Math.PI / 2) : (nose > 0 ? 0 : Math.PI);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  // Settle, then launch.
  for (let i = 0; i < 30; i++) car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  car.body.pos.set(p0.x, car.body.pos.y, p0.z);
  const v = world(travel, 0).sub(world(0, 0)).normalize().multiplyScalar(speed);
  car.body.vel.copy(v);
  const throttle = (speed < 10 ? 0.35 : 0) * (reverse ? -1 : 1);

  let crossed = false, touched = 0, minSpeed = Infinity;
  const alongOf = () => (L.axis === "x" ? car.body.pos.x : car.body.pos.z);
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    if (car._solidTouch) touched++;
    const a = alongOf();
    if (process.env.DRIVE_DEBUG && i % 15 === 0) {
      console.log(`  t${i} along ${a.toFixed(1)} y ${(car.body.pos.y - L.top).toFixed(2)} v ${car.body.vel.length().toFixed(1)} `
        + car.tires.map((t) => `${t.grounded ? "G" : "-"}${t.grounded ? (t.hitPoint.y - L.top).toFixed(2) : ""}`).join(" ")
        + ` touch ${car._solidTouch ? 1 : 0}`);
    }
    if (Math.abs(a - portal) < 8) minSpeed = Math.min(minSpeed, Math.hypot(car.body.vel.x, car.body.vel.z));
    if ((a - portal) * travel > 8) { crossed = true; break; }
    if (car.body.pos.y < L.top - 2) break; // fell into the trench
  }
  return { crossed, touched, minSpeed, kept: speed < 10 ? 1 : minSpeed / speed, y: car.body.pos.y - L.top };
}

const label = (c) => `${c.portal === L.cov1 ? "exit" : "entry"} portal, ${c.s > 0 ? "+" : "−"} side, ${c.dir > 0 ? "roof→open" : "open→roof"}${c.reverse ? " in REVERSE" : ""}, ${c.speed} m/s, ${c.edgeIn ?? 0.5} m over the lip`;

console.log("— hugging the barrier through both portals —");
for (const portal of [L.cov0, L.cov1]) {
  for (const s of [-1, 1]) {
    for (const c of [
      { speed: 20, dir: 1 }, { speed: 45, dir: 1 }, { speed: 20, dir: -1 }, { speed: 45, dir: -1 },
      { speed: 20, dir: 1, reverse: true }, { speed: 20, dir: -1, reverse: true },
      { speed: 6, dir: 1 },
    ]) {
      const r = run({ portal, s, ...c });
      check(r.crossed && r.touched === 0 && r.kept > 0.8,
        `${label({ portal, s, ...c })}: ${r.crossed ? "crossed" : "BLOCKED"}, touched ${r.touched} ticks, kept ${(r.kept * 100).toFixed(0)}%, ${r.y.toFixed(2)} m above street`);
    }
  }
}

console.log("\n— and the barrier is still a barrier —");
{
  // Hull edge 15 cm INSIDE the wall's outer face, past the nose: must touch.
  const r = run({ portal: L.cov1, s: 1, edgeIn: (L.holeHalf - outer) + 0.15, speed: 20, dir: 1, secs: 4 });
  check(r.touched > 0, `overlapping the parapet by 15 cm touches it (${r.touched} ticks)`);
  // Straight at the wall across the mouth, from the roof: blocked.
  const acr = 0;
  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  const p0 = world(L.cov1 - 30, acr);
  car.body.pos.set(p0.x, L.top + 0.55, p0.z);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), L.axis === "x" ? Math.PI / 2 : 0);
  for (let i = 0; i < 30; i++) car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
  car.body.pos.set(p0.x, car.body.pos.y, p0.z);
  car.body.vel.copy(world(1, 0).sub(world(0, 0)).normalize().multiplyScalar(20));
  let touched = 0, fell = false;
  for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    if (car._solidTouch) touched++;
    if (car.body.pos.y < L.top - 2) { fell = true; break; }
  }
  const a = L.axis === "x" ? car.body.pos.x : car.body.pos.z;
  check(touched > 0 && !fell && a < L.cov1 + 1,
    `driving off the deck edge into the open trench is stopped by the wall across the mouth (touched ${touched} ticks, ended ${(a - L.cov1).toFixed(2)} m past the portal, ${fell ? "FELL IN" : "did not fall"})`);
}

built.dispose();
console.log(failed ? `\n${failed} FAILURE(S)` : "\nALL PASS");
process.exit(failed ? 1 : 0);
