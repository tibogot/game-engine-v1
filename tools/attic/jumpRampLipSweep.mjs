// jumpRampLipRepro showed a dead-clean 29.7° launch straight up the middle.
// So the bug is in the approaches a hand-placed prop ACTUALLY gets: off-centre,
// at an angle, and (the big one) with the prop's own SIDE WALLS + END CAP in the
// same deck BVH as the drive surface.
//
// Metric that matters: LAUNCH ANGLE. 29.7° is the lip. Anything approaching 90°
// is the "big jump straight up" the car is doing.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.jumprampsweep.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry } =
  await import(new URL("../../games/modular-road-v3/modularRoadParkour.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const W = 14, L = 22, H = 8;
const R2D = 57.2958;
const LIP_DEG = Math.atan((H * Math.PI / 2) / L) * R2D;

function classify(geo) {
  const p = geo.getAttribute("position");
  const g = { top: [], bottom: [], side: [], endcap: [] };
  const hw = W / 2;
  for (let i = 0; i < p.count; i += 3) {
    const xs = [p.getX(i), p.getX(i + 1), p.getX(i + 2)];
    const ys = [p.getY(i), p.getY(i + 1), p.getY(i + 2)];
    const zs = [p.getZ(i), p.getZ(i + 1), p.getZ(i + 2)];
    if (zs.every((z) => Math.abs(z + L) < 1e-4)) g.endcap.push(i, i + 1, i + 2);
    else if (ys.every((y) => y < 1e-6)) g.bottom.push(i, i + 1, i + 2);
    else if (xs.every((x) => Math.abs(x - hw) < 1e-4) || xs.every((x) => Math.abs(x + hw) < 1e-4))
      g.side.push(i, i + 1, i + 2);
    else g.top.push(i, i + 1, i + 2);
  }
  return g;
}

const base = jumpRampGeometry(W, L, H, 32);
const groups = classify(base);

function makeGround({ deck, solids }) {
  const mk = (keys) => {
    if (!keys.length) return null;
    const g = base.clone();
    g.setIndex(keys.flatMap((k) => groups[k]));
    const m = new THREE.Mesh(g);
    m.updateMatrixWorld(true);
    const bvh = new RoadBvh();
    bvh.bakeFromMeshes([m]);
    return bvh;
  };
  const g = createVehicleGround({ getTerrainHeight: () => 0 });
  g.setRoadBvh(mk(deck));
  g.setRoadSolidsBvh(mk(solids));
  return g;
}

const ALL = ["top", "bottom", "side", "endcap"];

/**
 * @param x0      lateral offset of the approach line (m); |x|>7 misses the ramp
 * @param headDeg heading away from straight-on (deg)
 */
function run(ground, speed, x0 = 0, headDeg = 0, throttle = 1) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground; c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  const h = headDeg / R2D;
  c.body.pos.set(x0, WHEEL.radius + 0.18, 24);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + h);
  c.body.vel.set(-Math.sin(h) * speed, 0, -Math.cos(h) * speed);

  let peakY = -1e9, launch = null, wasG = true;
  const n = Math.round(6 / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos, v = c.body.vel;
    peakY = Math.max(peakY, p.y);
    // First airborne moment past the ramp's own footprint.
    if (wasG && c.groundedCount === 0 && p.z < -L * 0.6 && !launch) {
      launch = { vy: v.y, vh: Math.hypot(v.x, v.z), y: p.y };
    }
    wasG = c.groundedCount > 0;
    if (p.y < -20 || p.z < -L - 60) break;
  }
  const deg = launch ? Math.atan2(launch.vy, launch.vh) * R2D : NaN;
  return { peakY, deg, vy: launch?.vy ?? NaN, vh: launch?.vh ?? NaN };
}

const gAll = makeGround({ deck: ALL, solids: ALL });
const gTop = makeGround({ deck: ["top"], solids: ALL });

console.log(`Lip angle is ${LIP_DEG.toFixed(1)}°. A launch angle far above that is the bug.\n`);

console.log("=== A. LATERAL OFFSET (straight-on, 24 m/s). Ramp spans x ±7. ===");
console.log("      x0      deck=ALL (shipped)        deck=top only");
for (const x0 of [0, 2, 4, 5, 6, 6.5, 7, 7.5, 8]) {
  const a = run(gAll, 24, x0), b = run(gTop, 24, x0);
  console.log(
    `   ${String(x0).padStart(5)}   ${a.deg.toFixed(1).padStart(6)}°  peak ${a.peakY.toFixed(1).padStart(6)} m` +
    `      ${b.deg.toFixed(1).padStart(6)}°  peak ${b.peakY.toFixed(1).padStart(6)} m`,
  );
}

console.log("\n=== B. HEADING (centred, 24 m/s) ===");
console.log("    head      deck=ALL (shipped)        deck=top only");
for (const hd of [0, 5, 10, 15, 20, 30, 45]) {
  const a = run(gAll, 24, 0, hd), b = run(gTop, 24, 0, hd);
  console.log(
    `   ${String(hd).padStart(5)}°  ${a.deg.toFixed(1).padStart(6)}°  peak ${a.peakY.toFixed(1).padStart(6)} m` +
    `      ${b.deg.toFixed(1).padStart(6)}°  peak ${b.peakY.toFixed(1).padStart(6)} m`,
  );
}

console.log("\n=== C. SPEED (centred, straight) ===");
console.log("   speed      deck=ALL (shipped)        deck=top only");
for (const s of [8, 12, 16, 20, 24, 28, 34, 40]) {
  const a = run(gAll, s), b = run(gTop, s);
  console.log(
    `   ${String(s).padStart(5)}   ${a.deg.toFixed(1).padStart(6)}°  peak ${a.peakY.toFixed(1).padStart(6)} m` +
    `      ${b.deg.toFixed(1).padStart(6)}°  peak ${b.peakY.toFixed(1).padStart(6)} m`,
  );
}

console.log("\n=== D. OFF-CENTRE *AND* ANGLED (24 m/s, deck=ALL) — the realistic case ===");
console.log("        head→   " + [0, 8, 15, 25].map((h) => `${h}°`.padStart(9)).join(""));
for (const x0 of [0, 3, 5, 6.5]) {
  const cells = [0, 8, 15, 25].map((h) => `${run(gAll, 24, x0, h).deg.toFixed(1)}°`.padStart(9));
  console.log(`   x0=${String(x0).padStart(4)}     ${cells.join("")}`);
}
console.log("");
