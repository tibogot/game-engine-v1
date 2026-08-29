// "The front wheels go inside the chassis — NOT on flat ground, but on bumps,
//  jumps, and when the car TILTS in a turn. Raising the GLB fit Y fixes it."
//
// The report is right and the earlier suspension-travel fix only covered the
// small half of it. There are TWO independent things closing the arch gap, and
// the body lean is the bigger one:
//
//   (a) SUSPENSION — the wheel rises toward its hub. Clamped by TIRE.minSuspExt
//       to 5.7 cm of visible bump travel.
//
//   (b) BODY LEAN — _updateBodyLean rotates the CHASSIS MESH ONLY (the wheels
//       are placed from the unleaned _renderQuat on purpose, "so they stay
//       planted while the body rolls over them"). Rolling the body about its
//       own origin drives the OUTER arch DOWN onto the wheel by
//           halfTrack · sin(leanRoll)
//       and pitching it drives the FRONT arch down by
//           frontZ · sin(leanPitch)
//       Neither is capped against the arch gap, and neither happens on flat
//       ground at constant speed — which is exactly the reported pattern.
//
// This measures (b), which nothing in the codebase had measured before.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.archrepro.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, WHEEL, WHEEL_LOCAL, WHEEL_LAYOUT, BODYLEAN, FIXED_DT } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;
const FRONT_Z = Math.abs(WHEEL_LOCAL[0].pos.z);

const makeGround = (h = 0, at = Infinity) => ({
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const surf = o.z >= at ? h : 0;
    const t = (o.y - surf) / -d.y;
    if (t < 0 || t > far) return null;
    return { point: { x: o.x, y: surf, z: o.z }, distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 } };
  },
  spherecast() { return null; },
  closestPointWithNormal() { return null; },
});
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const make = (ground, y = 0.6) => {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, y, 0); c.body.quat.identity();
  return c;
};
/** Drawn suspension extension — the renderer's clamp chain. */
const drawnExt = (t) => {
  const target = t.grounded ? t.hitDistance : TIRE.rayLength;
  const e = Math.max(0, target - WHEEL.radius);
  if (e > TIRE.maxDroop) return TIRE.maxDroop;
  if (e < TIRE.minSuspExt) return TIRE.minSuspExt;
  return e;
};
const REST_EXT = 0.137;

/**
 * How far the body has come DOWN toward the front-outer wheel, in cm, split
 * into its two causes. Positive = arch gap closing.
 */
function archClosure(c) {
  const susp = REST_EXT - drawnExt(c.tires[0]);            // wheel rising
  const roll = WHEEL_LAYOUT.halfTrack * Math.abs(Math.sin(c._leanRoll ?? 0));
  const pitch = FRONT_Z * Math.abs(Math.sin(c._leanPitch ?? 0));
  const lift = c._leanLift ?? 0;                            // compensation, if any
  return { susp, roll, pitch, lift, total: susp + roll + pitch - lift };
}
/** _updateBodyLean lives on the render path, which the mesh stub never runs. */
const step = (c, input) => {
  c.tick(input);
  c._updateBodyLean(FIXED_DT);
  // Mirror syncVisuals' lift so `archClosure` sees what is actually drawn.
  c._leanLift = BODYLEAN.archCompensate > 0
    ? BODYLEAN.archCompensate * (
      WHEEL_LAYOUT.halfTrack * Math.abs(Math.sin(c._leanRoll))
      + FRONT_Z * Math.abs(Math.sin(c._leanPitch))
    )
    : 0;
};

console.log("=== HOW MUCH DOES THE BODY LEAN CLOSE THE ARCH GAP? ===\n");
console.log(`  geometry: halfTrack ${WHEEL_LAYOUT.halfTrack} m, front hub z ${FRONT_Z} m`);
console.log(`  limits:   maxRoll ${(BODYLEAN.maxRoll * R2D).toFixed(1)}°`
  + `  maxPitch ${(BODYLEAN.maxPitch * R2D).toFixed(1)}°`);
console.log(`  so at the caps the body drops`
  + ` ${(WHEEL_LAYOUT.halfTrack * Math.sin(BODYLEAN.maxRoll) * 100).toFixed(1)} cm (roll)`
  + ` + ${(FRONT_Z * Math.sin(BODYLEAN.maxPitch) * 100).toFixed(1)} cm (pitch)`);
console.log(`  against ${((REST_EXT - TIRE.minSuspExt) * 100).toFixed(1)} cm of suspension travel.\n`);

console.log("  scenario                     susp    roll   pitch   lift    TOTAL closure");
const row = (name, r) => console.log(
  `  ${name.padEnd(26)} ${(r.susp * 100).toFixed(1).padStart(5)}  `
  + `${(r.roll * 100).toFixed(1).padStart(5)}  ${(r.pitch * 100).toFixed(1).padStart(5)}  `
  + `${(r.lift * 100).toFixed(1).padStart(5)}  ${(r.total * 100).toFixed(1).padStart(8)} cm`,
);

// 1) The case that is FINE — flat ground, constant speed.
{
  const c = make(makeGround());
  for (let i = 0; i < 3 / FIXED_DT; i++) step(c, { steerTarget: 0, throttle: 0.3, handbrake: false, yaw: 0, pitch: 0 });
  row("flat, cruising", archClosure(c));
}
// 2) THE REPORTED CASE — a fast turn, body tilted.
for (const [speed, steer] of [[20, 0.35], [30, 0.25], [35, 0.3]]) {
  const c = make(makeGround());
  for (let i = 0; i < 12 / FIXED_DT; i++) {
    if (Math.abs(c.body.vel.z) >= speed) break;
    step(c, { steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  }
  let worst = null;
  for (let i = 0; i < 1.5 / FIXED_DT; i++) {
    step(c, { steerTarget: steer, throttle: 0.4, handbrake: false, yaw: 0, pitch: 0 });
    const r = archClosure(c);
    if (!worst || r.total > worst.total) worst = r;
  }
  row(`turn ${speed} m/s, ${steer} lock`, worst);
}
// 3) Hard braking — pitch dive alone.
{
  const c = make(makeGround());
  for (let i = 0; i < 12 / FIXED_DT; i++) {
    if (Math.abs(c.body.vel.z) >= 35) break;
    step(c, { steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  }
  let worst = null;
  for (let i = 0; i < 1.5 / FIXED_DT; i++) {
    step(c, { steerTarget: 0, throttle: -1, handbrake: false, yaw: 0, pitch: 0 });
    const r = archClosure(c);
    if (!worst || r.total > worst.total) worst = r;
  }
  row("braking from 35 m/s", worst);
}
// 4) Braking INTO a turn — roll and dive together, the real worst case.
{
  const c = make(makeGround());
  for (let i = 0; i < 12 / FIXED_DT; i++) {
    if (Math.abs(c.body.vel.z) >= 38) break;
    step(c, { steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  }
  let worst = null;
  for (let i = 0; i < 2 / FIXED_DT; i++) {
    step(c, { steerTarget: 0.3, throttle: -1, handbrake: false, yaw: 0, pitch: 0 });
    const r = archClosure(c);
    if (!worst || r.total > worst.total) worst = r;
  }
  row("brake + turn (worst case)", worst);
}
// 5) Landing a jump — compression AND dive.
{
  const c = make(makeGround(), 8);
  c.body.vel.set(0, 0, 30);
  let worst = null;
  for (let i = 0; i < 4 / FIXED_DT; i++) {
    step(c, { steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (!c.tires[0].grounded) continue;
    const r = archClosure(c);
    if (!worst || r.total > worst.total) worst = r;
  }
  row("landing an 8 m drop", worst);
}
// 6) Landing a jump WHILE turning.
{
  const c = make(makeGround(), 8);
  c.body.vel.set(0, 0, 34);
  let worst = null;
  for (let i = 0; i < 4 / FIXED_DT; i++) {
    step(c, { steerTarget: 0.5, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (!c.tires[0].grounded) continue;
    const r = archClosure(c);
    if (!worst || r.total > worst.total) worst = r;
  }
  row("landing INTO a turn", worst);
}
// 7) Driving onto a step while turning — the "obstacle" case.
{
  const c = make(makeGround(0.15, 6));
  let worst = null;
  for (let i = 0; i < 4 / FIXED_DT; i++) {
    step(c, { steerTarget: 0.4, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (!c.tires[0].grounded) continue;
    const r = archClosure(c);
    if (!worst || r.total > worst.total) worst = r;
  }
  row("0.15 m step, turning", worst);
}

console.log("\n  'roll' and 'pitch' are pure BODY LEAN — the wheel has not moved, the");
console.log("  body has come down onto it. Compare them against 'susp', which is the");
console.log("  only term the previous fix touched.");
console.log("\n  Raising CHASSIS_GLB.offsetY buys exactly this clearance, which is why");
console.log("  it works — it just pays for it at rest as well, where none is needed.");
