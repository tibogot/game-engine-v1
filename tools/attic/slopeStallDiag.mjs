// Why the climb STALLS: force budget, tick by tick, on a 45° slope entered at
// 20 m/s (which the closed-form model says should accelerate to ~30).
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.stall.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const M = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const { Vehicle, TIRE, CHASSIS, GRAVITY, FIXED_DT, DRIVETRAIN } = M;

const D2R = 1 / 57.2958;
const DEG = Number(process.argv[2] ?? 45);
const V0 = Number(process.argv[3] ?? 20);

function slopeGround(deg) {
  const t = Math.tan(deg * D2R);
  const n = { x: 0, y: Math.cos(deg * D2R), z: Math.sin(deg * D2R) };
  return {
    baked: true,
    raycastFirst(o, d, far) {
      const den = d.y + t * d.z;
      if (Math.abs(den) < 1e-9) return null;
      const s = -(o.y + t * o.z) / den;
      if (s < 0 || s > far) return null;
      return { point: { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s }, distance: s, faceIndex: 0, normal: n };
    },
    spherecast() { return null; },
    closestPointWithNormal() { return null; },
  };
}
Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

console.log(`drivetrain ${DRIVETRAIN.layout}  bias ${DRIVETRAIN.powerBias}`);
console.log(`weight ${(CHASSIS.mass * GRAVITY / 1000).toFixed(2)} kN  →  along a ${DEG}° slope ` +
  `${(CHASSIS.mass * GRAVITY * Math.sin(DEG * D2R) / 1000).toFixed(2)} kN, ` +
  `into the road ${(CHASSIS.mass * GRAVITY * Math.cos(DEG * D2R) / 1000).toFixed(2)} kN\n`);

const th = DEG * D2R;
const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
c.groundBvh = slopeGround(DEG); c.enabled = true;
c.body.pos.set(0, 0.65 / Math.cos(th), 0);
c.body.quat.setFromEuler(new THREE.Euler(-th, Math.PI, 0, "YXZ"));
c.body.vel.set(0, V0 * Math.sin(th), -V0 * Math.cos(th));

console.log("  t     v    load(kN per wheel FL FR RL RR)   ΣN    Fx sum   compress(m)      pitch°  wheels");
for (let i = 0; i <= Math.round(10 / FIXED_DT); i++) {
  if (i % Math.round(0.5 / FIXED_DT) === 0) {
    const loads = c.tires.map((t) => t.lastSuspension.length());
    const fx = c.tires.reduce((s, t) => s + t.lastAccel.length(), 0);
    const comp = c.tires.map((t) => t.compression);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.body.quat);
    const pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1)) * 57.2958;
    console.log(
      `${(i * FIXED_DT).toFixed(1).padStart(5)} ${c.body.vel.length().toFixed(1).padStart(5)}  ` +
      loads.map((l) => (l / 1000).toFixed(2).padStart(6)).join("") +
      `  ${(loads.reduce((a, b) => a + b, 0) / 1000).toFixed(2).padStart(6)}k` +
      ` ${(fx / 1000).toFixed(2).padStart(7)}k  ` +
      comp.map((v) => v.toFixed(3).padStart(7)).join("") +
      ` ${pitch.toFixed(1).padStart(8)} ${String(c.tires.filter((t) => t.grounded).length).padStart(5)}`,
    );
  }
  c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
}
