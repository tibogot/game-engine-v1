// Diagnostic: WHERE does the lateral slide on a rolled landing come from?
//
// tools/landingSlideRepro.mjs documents the bug (metres of sideways travel after
// landing out of a big air roll) but not its origin. Two very different stories
// fit the same end number:
//   (a) the car ALREADY has lateral velocity when it arrives, built in the air,
//       and the tyres simply cannot scrub it off in time; or
//   (b) the car arrives travelling straight and the CONTACT generates the
//       sideways push, because one side bites before the other.
// The fix is opposite in each case — (a) wants the air phase corrected, (b)
// wants the contact softened — so guessing is expensive. An attempt at (b),
// fading lateral grip through the arrival transient, made the slide WORSE
// (6.4 m → 8.3 m): lateral grip is also what ARRESTS a slide.
//
// This traces world-lateral velocity across touchdown for the worst cases.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.slidetrace.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const R2D = 57.2958;

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

/** Same launch as landingSlideRepro: 45 m/s, 14 m up, roll held to `release`°. */
function trace(release) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, 14, 0); c.body.vel.set(0, 9, 45); c.body.quat.identity();
  const up = new THREE.Vector3();
  let rolling = release > 0, landed = null;
  let vxAtLand = 0, tiltAtLand = 0, x0 = 0, headAtLand = 0;
  let vxPeakAir = 0, vxPeakGround = 0, lateral = 0;
  // Decompose the LATERAL SLIP the tyre model actually sees, at touchdown.
  // vLat is `_tireVel · _wheelRight` with nothing projected out, so on a tilted
  // car the INTO-SURFACE closing velocity leaks into it. `vLatPlane` is the same
  // quantity with the contact-normal component removed — the honest in-plane
  // slip. The gap between them is phantom cornering demand.
  let vLatRaw = 0, vLatPlane = 0, phantom = 0;
  const _v = new THREE.Vector3(), _r = new THREE.Vector3(), _n = new THREE.Vector3();

  for (let i = 0; i < 6 / FIXED_DT; i++) {
    const t = i * FIXED_DT;
    c.tick({
      steerTarget: (landed === null && rolling) ? -1 : 0,
      throttle: 0, handbrake: false, yaw: 0, pitch: 0,
    });
    up.set(0, 1, 0).applyQuaternion(c.body.quat);
    const tl = Math.acos(Math.min(1, Math.max(-1, up.y))) * R2D;
    const vx = c.body.vel.x;
    if (landed === null) {
      if (rolling && tl >= release) rolling = false;
      vxPeakAir = Math.max(vxPeakAir, Math.abs(vx));
      if (c.groundedCount >= 3) {
        landed = t; x0 = c.body.pos.x; tiltAtLand = tl; vxAtLand = vx;
        for (const tire of c.tires) {
          if (!tire.grounded) continue;
          c.body.getVelocityAtPoint(tire.worldPos, _v);
          _r.copy(tire._wheelRight);
          _n.copy(tire.hitNormal);
          const raw = _v.dot(_r);
          // Remove the into-surface component from BOTH the velocity and the
          // axis, which is what "slip in the contact plane" means.
          const vP = _v.clone().addScaledVector(_n, -_v.dot(_n));
          const rP = _r.clone().addScaledVector(_n, -_r.dot(_n));
          if (rP.lengthSq() > 1e-9) rP.normalize();
          const plane = vP.dot(rP);
          if (Math.abs(raw) > Math.abs(vLatRaw)) {
            vLatRaw = raw; vLatPlane = plane; phantom = raw - plane;
          }
        }
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(c.body.quat);
        headAtLand = Math.atan2(f.x, f.z) * R2D;
      }
    } else {
      vxPeakGround = Math.max(vxPeakGround, Math.abs(vx));
      if (t - landed <= 2) lateral = c.body.pos.x - x0;
    }
  }
  return {
    tiltAtLand, vxAtLand, vxPeakAir, vxPeakGround,
    lateral: Math.abs(lateral), headAtLand, vLatRaw, vLatPlane, phantom,
  };
}

console.log("Where does the rolled-landing slide come from?\n");
console.log("release | tilt@land | vx AT land | vx peak after |  slide | vLat raw | vLat in-plane | phantom");
for (const rel of [0, 60, 80, 100, 120, 160, 180]) {
  const r = trace(rel);
  console.log(
    `${String(rel).padStart(6)}° | ${r.tiltAtLand.toFixed(0).padStart(8)}°`
    + ` | ${r.vxAtLand.toFixed(2).padStart(9)}`
    + ` | ${r.vxPeakGround.toFixed(2).padStart(12)}`
    + ` | ${r.lateral.toFixed(2).padStart(5)} m`
    + ` | ${r.vLatRaw.toFixed(2).padStart(7)}`
    + ` | ${r.vLatPlane.toFixed(2).padStart(12)}`
    + ` | ${r.phantom.toFixed(2).padStart(7)}`,
  );
}
console.log(`
vx in air     = biggest world-lateral speed reached BEFORE touchdown
vx AT land    = world-lateral speed at the moment 3 wheels are down
vx peak after = biggest world-lateral speed reached ON THE GROUND

If "vx AT land" is already large, the slide was built in the AIR and the contact
model is only failing to scrub it. If it is ~0 and "vx peak after" is large, the
CONTACT is generating the push.`);
