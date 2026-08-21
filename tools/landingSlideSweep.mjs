// Dense version of tools/landingSlideRepro.mjs, for judging a CHANGE.
//
// landingSlideRepro samples ten release angles. It says itself that the slide is
// chaotic in that angle — a few degrees swings it from centimetres to metres —
// so ten cells cannot tell you whether an edit helped: any single cell can move
// a long way on noise, and the worst-of-ten is the noisiest statistic of all.
//
// This sweeps finely and reports DISTRIBUTION, which is what actually answers
// "is the car better to land now": mean, median, 90th percentile, worst, and how
// many samples exceeded 1.5 m.
//
// Point it at any vehicle source so a change can be isolated from everything
// else in the working tree:
//     node tools/landingSlideSweep.mjs                    # working tree
//     node tools/landingSlideSweep.mjs --src /path/to.js  # some other copy
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcArg = process.argv.indexOf("--src");
const SRC = srcArg >= 0 ? process.argv[srcArg + 1] : join(ROOT, "v3/play/modularRoadVehicle.js");
const TMP = join(ROOT, `.slidesweep.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(SRC, "utf8")
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
Vehicle.prototype._syncWheelInstances = function () {};

/** Identical launch to landingSlideRepro so the two are directly comparable. */
function jump(release, throttle) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 14, 0); c.body.vel.set(0, 9, 45); c.body.quat.identity();
  const up = new THREE.Vector3();
  let landed = null, x0 = 0, lateral = 0, tilt = 0, rolling = release > 0;
  for (let i = 0; i < 6 / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    c.tick({
      steerTarget: (landed === null && rolling) ? -1 : 0,
      throttle, handbrake: false, yaw: 0, pitch: 0,
    });
    up.set(0, 1, 0).applyQuaternion(c.body.quat);
    const tl = Math.acos(Math.min(1, Math.max(-1, up.y))) * 57.2958;
    if (landed === null) {
      if (rolling && tl >= release) rolling = false;
      if (c.groundedCount >= 3) { landed = t; x0 = c.body.pos.x; tilt = tl; }
    } else if (t - landed <= 2) lateral = c.body.pos.x - x0;
  }
  return { lateral: Math.abs(lateral), tilt };
}

const slides = [];
const tilts = [];
for (let rel = 0; rel <= 180; rel += 4) {
  for (const thr of [0, 1]) {
    const r = jump(rel, thr);
    slides.push(r.lateral);
    tilts.push(r.tilt);
  }
}
slides.sort((a, b) => a - b);
const at = (p) => slides[Math.min(slides.length - 1, Math.floor(p * slides.length))];
const mean = slides.reduce((a, b) => a + b, 0) / slides.length;
const spikes = slides.filter((v) => v > 1.5).length;
const bad = slides.filter((v) => v > 4).length;

console.log(`source: ${SRC === join(ROOT, "v3/play/modularRoadVehicle.js") ? "working tree" : SRC}`);
console.log(`samples: ${slides.length}  (release 0..180° step 4, coasting + throttle)\n`);
console.log(`  mean slide       ${mean.toFixed(2)} m`);
console.log(`  median           ${at(0.5).toFixed(2)} m`);
console.log(`  90th percentile  ${at(0.9).toFixed(2)} m`);
console.log(`  worst            ${slides[slides.length - 1].toFixed(2)} m`);
console.log(`  over 1.5 m       ${spikes} / ${slides.length}  (${(100 * spikes / slides.length).toFixed(0)}%)`);
console.log(`  over 4 m         ${bad} / ${slides.length}  (${(100 * bad / slides.length).toFixed(0)}%)`);
console.log(`  mean tilt@land   ${(tilts.reduce((a, b) => a + b, 0) / tilts.length).toFixed(1)}°`);
