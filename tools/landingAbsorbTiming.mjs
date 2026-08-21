// Diagnostic: WHEN does the touchdown absorption fire, relative to the wheels
// actually taking load?
//
// Reported symptom: the car "floats" or gets "placed" on the last stretch of a
// jump, like a magnet caught it. `landingAbsorb` deletes a fraction of the
// closing speed in ONE tick, so if it fires early the car visibly stops falling
// while still in the air, then glides down the remainder.
//
// A tyre reports `grounded` as soon as its RAY finds a surface, which on a
// descent is well before the wheel touches; `_isSupported()` (grounded AND
// compression > 0) is the honest arrival. This measures the gap between them,
// and how much velocity was deleted inside it.
//
// DETECTION IS UNAMBIGUOUS: while no wheel carries load and the chassis is clear
// of the deck, nothing in the vehicle can add UPWARD velocity — gravity is
// negative and drag is negligible. So any positive single-tick jump in vy under
// those conditions is the absorption impulse and nothing else.
//
// An instrument, not a pass/fail test.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.landabsorb.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

/** Flat ground at y = 0, deck bvh only — the ordinary-landing case. */
const ground = {
  baked: true,
  raycastFirst(o, d, far) {
    if (d.y >= -1e-6) return null;
    const t = o.y / -d.y;
    if (t < 0 || t > far) return null;
    return {
      point: { x: o.x + d.x * t, y: 0, z: o.z + d.z * t },
      distance: t, faceIndex: 0, normal: { x: 0, y: 1, z: 0 },
    };
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

/**
 * One jump onto flat ground, launched mid-flight so the descent is controlled.
 * Reports the absorption impulse and where it happened.
 */
function drop({ height = 14, vy = 2, vz = 30 }) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground; c.enabled = true;
  c.body.pos.set(0, height, 0);
  c.body.vel.set(0, vy, vz);
  c.body.angVel.set(0, 0, 0);
  c.body.quat.identity();
  c._resetInterpolation();
  for (const t of c.tires) t._hadGround = false;
  c._airTime = 0.2; c._rackAirTime = 0.2;

  let t = 0;
  let firstProbe = -1;   // first tick any tyre RAY found the ground
  let supportedAt = -1;  // first tick a tyre actually carried load
  let impulse = 0;       // biggest upward vy step taken while unsupported
  let impulseY = 0, impulseT = 0, impulseVy = 0;
  let peakLoad = 0;      // deepest suspension compression reached on arrival
  let vAtLoad = 0;       // closing speed the springs actually saw

  for (let i = 0; i < 900; i++) {
    const beforeVy = c.body.vel.y;
    c.tick({ steerTarget: 0, rollTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    t += FIXED_DT;

    const probes = c.tires.reduce((n, x) => n + (x.grounded ? 1 : 0), 0);
    const load = Math.max(...c.tires.map((x) => x.compression || 0));
    const supported = load > 0;
    if (probes > 0 && firstProbe < 0) firstProbe = t;
    if (supported && supportedAt < 0) { supportedAt = t; vAtLoad = beforeVy; }
    peakLoad = Math.max(peakLoad, load);

    // The impulse only counts as "early" if it landed before any wheel loaded.
    const step = c.body.vel.y - beforeVy;
    if (!supported && step > impulse) {
      impulse = step; impulseY = c.body.pos.y; impulseT = t; impulseVy = c.body.vel.y;
    }
    if (supportedAt > 0 && t - supportedAt > 0.5) break;
  }

  // Height of the LOWEST wheel above the deck at the moment of the impulse is
  // the number that matters — chassis y includes ride height and tells you less.
  return {
    impulse, impulseY, impulseVy, peakLoad, vAtLoad,
    earlyBy: supportedAt > 0 && impulseT > 0 ? supportedAt - impulseT : 0,
    firstProbe, supportedAt,
    probeLead: supportedAt > 0 && firstProbe > 0 ? supportedAt - firstProbe : 0,
  };
}

console.log("Touchdown absorption — does it fire before the wheels take load?\n");
console.log("case                        | impulse | fired at | early by | glide | probe lead | v@load | peak comp");
const cases = [
  ["gentle  (14 m, 30 m/s)", { height: 14, vy: 2, vz: 30 }],
  ["fast    (14 m, 45 m/s)", { height: 14, vy: 2, vz: 45 }],
  ["high    (30 m, 30 m/s)", { height: 30, vy: 2, vz: 30 }],
  ["lobbed  (14 m, +8 vy) ", { height: 14, vy: 8, vz: 30 }],
  ["short hop (2 m, 30)   ", { height: 2, vy: 0, vz: 30 }],
];
for (const [name, cfg] of cases) {
  const r = drop(cfg);
  // Forward distance covered between the impulse and real support.
  const glide = r.earlyBy * cfg.vz;
  console.log(
    `${name} | ${r.impulse.toFixed(2).padStart(6)} m/s`
    + ` | y=${r.impulseY.toFixed(2).padStart(5)} m`
    + ` | ${(r.earlyBy * 1000).toFixed(0).padStart(5)} ms`
    + ` | ${glide.toFixed(2).padStart(5)} m`
    + ` | ${(r.probeLead * 1000).toFixed(0).padStart(5)} ms`
    + ` | ${r.vAtLoad.toFixed(1).padStart(5)}` 
    + ` | ${r.peakLoad.toFixed(3).padStart(6)} m`,
  );
}
console.log(`
impulse   = upward velocity added in ONE tick while NO wheel carried load
early by  = how long before real support that happened
glide     = forward distance travelled in that window, at reduced fall speed
probe lead= gap between the tyre RAY finding ground and the wheel taking load

An impulse of 0.00 means absorption waited for the wheels — which is the goal.`);
