// OPEN BUG: landing out of a big air roll can shove the car metres SIDEWAYS.
//
// Found while reworking jumpPitchTest's roll sweep. That test asserted a worst
// lateral slide under 1.5 m and passed — but it sampled only four hold
// durations, and the slide turns out to be CHAOTIC in the release angle: it
// depends on the phase of the roll at touchdown, so a few degrees either way
// swings it from centimetres to tens of metres. The four samples missed every
// spike.
//
// This is NOT a regression from the airSteerRate work. Run it with
// `--before` to import the pre-airSteerRate vehicle out of git and see the same
// spikes (the 160° case is in fact far worse there: 24.0 m against 0.0 m).
//
// The mechanism, as far as the numbers go: the car arrives still rolled, one
// side's tyres bite before the other, and the lateral force that produces is
// applied for as long as it takes the stabiliser to level the chassis. The
// landing assist (TIRE.airLandTorque / airLandTime) is what is supposed to have
// levelled it first, and at these angles it runs out of window.
//
// An instrument, not a pass/fail test — it documents an open bug.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BEFORE = process.argv.includes("--before");
const REL = "v3/play/modularRoadVehicle.js";
const raw = BEFORE
  ? execFileSync("git", ["show", `HEAD:${REL}`], { cwd: ROOT, encoding: "utf8" })
  : readFileSync(join(ROOT, REL), "utf8");
const TMP = join(ROOT, `.landingslide.${process.pid}.mjs`);
writeFileSync(TMP, raw
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: 0, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
};
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/** Roll until tilted `release`°, let go, and land. 45 m/s off a 14 m launch. */
function jump(release, throttle) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 14, 0); c.body.vel.set(0, 9, 45); c.body.quat.identity();
  const up = new THREE.Vector3();
  let landed = null, x0 = 0, tilt = 0, lateral = 0, peak = 0, rolling = release > 0;
  for (let i = 0; i < 6 / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    c.tick({
      steerTarget: (landed === null && rolling) ? -1 : 0,
      throttle, handbrake: false, yaw: 0, pitch: 0,
    });
    up.set(0, 1, 0).applyQuaternion(c.body.quat);
    const tl = Math.acos(THREE.MathUtils.clamp(up.y, -1, 1)) * 57.2958;
    if (landed === null) {
      peak = Math.max(peak, tl);
      if (rolling && tl >= release) rolling = false;
    }
    if (landed === null && c.groundedCount >= 3) { landed = t; x0 = c.body.pos.x; tilt = tl; }
    if (landed !== null && t - landed <= 2) lateral = c.body.pos.x - x0;
  }
  return { tilt, lateral: Math.abs(lateral), peak };
}

console.log(`vehicle: ${BEFORE ? "git HEAD (pre-airSteerRate)" : "working tree"}\n`);
console.log("  release   peak    tilt@land   slide (coasting)   slide (throttle)");
let worst = 0;
for (const rel of [0, 20, 40, 60, 80, 100, 120, 140, 160, 180]) {
  const a = jump(rel, 0), b = jump(rel, 1);
  worst = Math.max(worst, a.lateral, b.lateral);
  const spike = Math.max(a.lateral, b.lateral) > 1.5 ? "   <== SPIKE" : "";
  console.log(
    `  ${String(rel).padStart(5)}°  ${a.peak.toFixed(0).padStart(5)}°   ${Math.max(a.tilt, b.tilt).toFixed(0).padStart(6)}°`
    + `   ${a.lateral.toFixed(2).padStart(12)} m ${b.lateral.toFixed(2).padStart(15)} m${spike}`,
  );
}
console.log(`\n  worst lateral slide: ${worst.toFixed(1)} m`);
console.log("  Re-run with --before to confirm the spikes predate the airSteerRate work.");
