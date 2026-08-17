// "At the tip of the jump ramp the car makes a big jump STRAIGHT UP."
//
// The Jump ramp prop is `collision: "both"`, which means the WHOLE solid — the
// drive surface, the underside, the two side walls and the vertical end cap at
// the lip — is baked into the deck BVH *and* into the solids BVH. This drives
// the real Vehicle over the real prop geometry and reports, per tick:
//
//   • the launch: vertical vs forward velocity at the moment it leaves,
//   • which channel produced it (ablation: deck-only / solids-only / top-only),
//   • the contact points + normals through the lip window.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jumpramplip.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry, kickerRampGeometry } =
  await import(new URL("../games/modular-road-v3/modularRoadParkour.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

// The shipped prop: jumpRampGeometry(14, 22, 8, 32) — w 14, length 22, rise 8.
const W = 14, L = 22, H = 8;

/**
 * The prop is one non-indexed mesh. Split its triangles by which FACE of the
 * solid they belong to, so parts can be removed one at a time.
 *   top    the concave drive surface
 *   bottom the y=0 underside
 *   side   the two |x| = w/2 walls
 *   endcap the vertical quad at the lip (z = -L, y 0..H)
 */
function classify(geo) {
  const p = geo.getAttribute("position");
  const groups = { top: [], bottom: [], side: [], endcap: [] };
  const v = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
  for (let i = 0; i < p.count; i += 3) {
    const a = v(i), b = v(i + 1), c = v(i + 2);
    const ys = [a[1], b[1], c[1]];
    const xs = [a[0], b[0], c[0]];
    const zs = [a[2], b[2], c[2]];
    const hw = W / 2;
    if (zs.every((z) => Math.abs(z + L) < 1e-4)) groups.endcap.push(i, i + 1, i + 2);
    else if (ys.every((y) => y < 1e-6)) groups.bottom.push(i, i + 1, i + 2);
    else if (xs.every((x) => Math.abs(x - hw) < 1e-4) || xs.every((x) => Math.abs(x + hw) < 1e-4))
      groups.side.push(i, i + 1, i + 2);
    else groups.top.push(i, i + 1, i + 2);
  }
  return groups;
}

const base = jumpRampGeometry(W, L, H, 32);
const groups = classify(base);

console.log("=== JUMP RAMP TRIANGLE CENSUS (what `collision:\"both\"` bakes) ===");
for (const [k, t] of Object.entries(groups)) console.log(`   ${k.padEnd(7)} ${t.length / 3} tris`);
console.log(`   The ramp runs z 0 (base, y=0) → z ${-L} (lip, y=${H}).`);
console.log(`   Lip slope = ${(Math.atan((H * Math.PI / 2) / L) * 57.2958).toFixed(1)}°.\n`);

/** A ground adapter with the named face groups in the deck and/or solids BVH. */
function makeGround({ deck, solids }) {
  const mk = (keys) => {
    if (!keys.length) return null;
    const g = base.clone();
    g.setIndex(keys.flatMap((k) => groups[k]));
    const m = new THREE.Mesh(g);
    m.position.set(0, 0, 0);
    m.updateMatrixWorld(true);
    const bvh = new RoadBvh();
    bvh.bakeFromMeshes([m]);
    return bvh;
  };
  // Flat floor at y=0 under everything, like the road the prop is dropped on.
  const g = createVehicleGround({ getTerrainHeight: () => 0 });
  g.setRoadBvh(mk(deck));
  g.setRoadSolidsBvh(mk(solids));
  return g;
}

function makeCar(ground, speed, z0 = 24) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground;
  c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4;
  c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, z0);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // facing -Z
  c.body.vel.set(0, 0, -speed);
  return c;
}

/** Run until the car is well past the ramp; report the launch. */
function run(ground, speed, { dump = false } = {}) {
  const c = makeCar(ground, speed);
  const n = Math.round(5 / FIXED_DT);
  let peakY = -1e9, peakVy = -1e9, vyAtLaunch = null, vzAtLaunch = null;
  let launchTick = -1, wasGrounded = true;
  const rows = [];
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos, v = c.body.vel;
    peakY = Math.max(peakY, p.y);
    peakVy = Math.max(peakVy, v.y);
    if (wasGrounded && c.groundedCount === 0 && p.z < 0) {
      launchTick = i; vyAtLaunch = v.y; vzAtLaunch = v.z;
    }
    wasGrounded = c.groundedCount > 0;
    if (dump && p.z < -L + 6 && p.z > -L - 8) {
      rows.push({ t: i * FIXED_DT, p: p.clone(), v: v.clone(), g: c.groundedCount, car: c });
    }
    if (p.z < -L - 40) break;
  }
  return { peakY, peakVy, vyAtLaunch, vzAtLaunch, launchTick, rows, c };
}

const SPEEDS = [12, 18, 24, 30, 40];

console.log("=== ABLATION: peak height / peak +Vy over the lip (lip is y=8) ===");
console.log("   Ballistic Vy for a clean 29.7° launch is shown as `expect`.\n");
const combos = [
  ["SHIPPED  deck=all  solids=all", { deck: ["top", "bottom", "side", "endcap"], solids: ["top", "bottom", "side", "endcap"] }],
  ["deck=all  solids=NONE        ", { deck: ["top", "bottom", "side", "endcap"], solids: [] }],
  ["deck=top  solids=all         ", { deck: ["top"], solids: ["top", "bottom", "side", "endcap"] }],
  ["deck=top  solids=side+endcap ", { deck: ["top"], solids: ["side", "endcap"] }],
  ["deck=top  solids=NONE        ", { deck: ["top"], solids: [] }],
];
console.log(`   ${"config".padEnd(30)} ${SPEEDS.map((s) => `${s} m/s`.padStart(14)).join("")}`);
for (const [label, cfg] of combos) {
  const g = makeGround(cfg);
  const cells = SPEEDS.map((s) => {
    const r = run(g, s);
    return `${r.peakY.toFixed(1)}m/${r.peakVy.toFixed(1)}`.padStart(14);
  });
  console.log(`   ${label.padEnd(30)} ${cells.join("")}`);
}
console.log("");
{
  const expect = SPEEDS.map((s) => (s * Math.sin(Math.atan((H * Math.PI / 2) / L))).toFixed(1));
  console.log(`   ${"expect (v·sin29.7°)".padEnd(30)} ${SPEEDS.map((e, i) => `  —  /${expect[i]}`.padStart(14)).join("")}`);
}

console.log("\n=== CONTACT DUMP THROUGH THE LIP (shipped config, 24 m/s) ===");
{
  const g = makeGround(combos[0][1]);
  const r = run(g, 24, { dump: true });
  const c = r.c;
  for (let k = 0; k < r.rows.length; k += 2) {
    const row = r.rows[k];
    console.log(
      `  t=${row.t.toFixed(3)}  pos(y ${row.p.y.toFixed(2)}, z ${row.p.z.toFixed(2)})` +
      `  v(y ${row.v.y.toFixed(2)}, z ${row.v.z.toFixed(2)})  grounded ${row.g}`,
    );
  }
  console.log(`  launch: Vy ${r.vyAtLaunch?.toFixed(2)}  Vz ${r.vzAtLaunch?.toFixed(2)}  peakY ${r.peakY.toFixed(2)}`);
}
console.log("");
