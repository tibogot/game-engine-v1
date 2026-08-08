// WHAT is the wheel touching at the rim? halfTubeAirMeshRepro showed the car
// losing 28 m/s of climb in one 50 ms window at the lip and then staying
// "grounded" at y ~9.7 forever. This dumps the actual contact point + normal per
// wheel through that window, and re-runs with individual parts of the piece
// deleted, so the offending triangles are named rather than guessed.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.halftubelip.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, FIXED_DT, CHASSIS, GRAVITY } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { buildPiece, pieceParams, initialConnector } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

const R2D = 57.2958;
const R = 8, CY = 8;

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const built = buildPiece("half_tube", initialConnector(),
  { ...pieceParams, straightLength: 160, tubeRadius: R, tubeWall: 0.6, halfTubeSpan: 180 });

/** Triangle classes in the swept annulus, by the aZone of its three vertices. */
function classify(geo) {
  const zone = geo.getAttribute("aZone");
  const idx = geo.getIndex();
  const groups = { bore: [], outer: [], rim: [] };
  for (let i = 0; i < idx.count; i += 3) {
    const t = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
    const z = t.map((v) => zone.getX(v));
    const all3 = z.every((v) => v === 3), all4 = z.every((v) => v === 4);
    (all3 ? groups.bore : all4 ? groups.outer : groups.rim).push(...t);
  }
  return groups;
}
const groups = classify(built.geometry);
console.log("=== TRIANGLE CENSUS (deck BVH contents for ONE half_tube) ===");
for (const [k, v] of Object.entries(groups)) console.log(`   ${k.padEnd(6)} ${v.length / 3} tris`);
console.log("   'rim' = the caps that close the profile at each lip: a flat 0.6 m ledge");
console.log("   at exactly lip height, running the whole length of the piece.");

function groundFrom(keys) {
  const geo = built.geometry.clone();
  geo.setIndex(keys.flatMap((k) => groups[k]));
  const mesh = new THREE.Mesh(geo);
  mesh.applyMatrix4(built.world);
  mesh.updateMatrixWorld(true);
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes([mesh]);
  const g = createVehicleGround({ getTerrainHeight: () => 0 });
  g.setRoadBvh(bvh);
  return g;
}

function makeCar(ground, speed, headingDeg) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground; c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  const h = headingDeg / R2D;
  c.body.pos.set(0, WHEEL.radius + 0.18, -6);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + h);
  c.body.vel.set(-Math.sin(h) * speed, 0, -Math.cos(h) * speed);
  return c;
}

function peak(ground, speed, heading, secs = 4) {
  const c = makeCar(ground, speed, heading);
  let py = -1e9, air = 0;
  const n = Math.round(secs / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    py = Math.max(py, c.body.pos.y);
    if (c.groundedCount === 0) air++;
  }
  return { py, airPct: (100 * air) / n };
}

console.log("\n=== WHICH PART TRAPS THE CAR? (peak y, lip is y=8) ===");
console.log("   parts in the deck BVH            35 m/s @90°   35 m/s @60°   25 m/s @45°");
const combos = [
  // This first row is the BUG: the whole visible mesh in the deck BVH, which is
  // what baking p.mesh directly used to do. The fix ships row 2.
  ["bore + outer + rim (THE BUG)", ["bore", "outer", "rim"]],
  ["bore + outer (no rim caps)", ["bore", "outer"]],
  ["bore + rim (no outer shell)", ["bore", "rim"]],
  ["bore only", ["bore"]],
];
for (const [label, keys] of combos) {
  const g = groundFrom(keys);
  const a = peak(g, 35, 90), b = peak(g, 35, 60), c = peak(g, 25, 45);
  console.log(`   ${label.padEnd(32)} ${a.py.toFixed(1).padStart(9)} m ${b.py.toFixed(1).padStart(11)} m ${c.py.toFixed(1).padStart(11)} m`);
}

console.log("\n=== CONTACT DUMP THROUGH THE RIM (shipped piece, 35 m/s straight at the wall) ===");
console.log("  per grounded wheel: contact point, contact normal, hub distance.\n");
{
  const g = groundFrom(["bore", "outer", "rim"]);
  const c = makeCar(g, 35, 90);
  for (let i = 0; i < Math.round(0.7 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const t = i * FIXED_DT;
    if (t < 0.33 || t > 0.55) continue;
    if (i % 2) continue;
    const p = c.body.pos;
    console.log(`  t=${t.toFixed(3)}  pos(${p.x.toFixed(2)}, ${p.y.toFixed(2)})  v=${c.body.vel.length().toFixed(1)}  grounded ${c.groundedCount}`);
    for (let w = 0; w < c.tires.length; w++) {
      const tire = c.tires[w];
      if (!tire.grounded) continue;
      const hp = tire.hitPoint, hn = tire.hitNormal;
      // Radius from the tube axis tells the part apart: 8.0 = bore, 8.6 = outer
      // shell, in between at y=8 = the rim ledge.
      const rad = Math.hypot(hp.x, hp.y - CY);
      const where = Math.abs(hp.y - 8) < 0.02 && rad > R + 0.02 ? "RIM LEDGE"
        : Math.abs(rad - R) < 0.05 ? "bore"
        : Math.abs(rad - (R + 0.6)) < 0.05 ? "OUTER SHELL" : "?";
      console.log(
        `      wheel ${w}  hit(${hp.x.toFixed(2)}, ${hp.y.toFixed(2)})  r=${rad.toFixed(2)}`
        + `  n=(${hn.x.toFixed(2)}, ${hn.y.toFixed(2)}, ${hn.z.toFixed(2)})`
        + `  hubDist ${tire.hitDistance.toFixed(3)}  comp ${tire.compression.toFixed(3)}   ${where}`,
      );
    }
  }
}
console.log("");
