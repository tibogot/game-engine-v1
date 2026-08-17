// HUNT the intermittent "big jump straight up at the tip".
//
// Setup is exactly what the player did: the `jumpkicker` obstacle prop
// (jumpRampGeometry(14, 22, 8), collision:"both" → the WHOLE solid in the deck
// BVH *and* the solids BVH) dropped on flat ground. No road anywhere.
//
// The straight-down-the-middle run launches at a clean 29.7° (= the lip angle),
// so this randomises the things a player varies — entry speed, line, heading,
// throttle, a bit of steering — and reports the runs whose launch angle is
// nowhere near 29.7°. Then it ablates the same seeds to name the triangles.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jumprampop.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry } =
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

const W = 14, L = 22, H = 8, R2D = 57.2958;
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
const ALL = ["top", "bottom", "side", "endcap"];

function makeGround({ deck = ALL, solids = ALL } = {}) {
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

/** One approach. Returns the launch and the worst upward velocity SPIKE seen. */
function run(ground, { speed, x0, headDeg, throttle, steer }, trace = false) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground; c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  const h = headDeg / R2D;
  c.body.pos.set(x0, WHEEL.radius + 0.18, 30);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + h);
  c.body.vel.set(-Math.sin(h) * speed, 0, -Math.cos(h) * speed);

  let peakY = -1e9, launch = null, wasG = true;
  let maxDVy = 0, maxDVyAt = null; // biggest ONE-TICK vertical velocity jump
  let prevVy = 0;
  const rows = [];
  const n = Math.round(6 / FIXED_DT);
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: steer, throttle, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos, v = c.body.vel;
    peakY = Math.max(peakY, p.y);
    const dVy = v.y - prevVy;
    // Gravity alone is −0.163 m/s per tick; a real surface push is what we want.
    if (dVy > maxDVy && p.z < 0) { maxDVy = dVy; maxDVyAt = { z: p.z, y: p.y, t: i * FIXED_DT }; }
    prevVy = v.y;
    if (wasG && c.groundedCount === 0 && p.z < -L * 0.6 && !launch) {
      launch = { vy: v.y, vh: Math.hypot(v.x, v.z), y: p.y, z: p.z };
    }
    wasG = c.groundedCount > 0;
    if (trace && p.z < -L + 8 && p.z > -L - 10) {
      rows.push({ t: i * FIXED_DT, z: p.z, y: p.y, vy: v.y, vh: Math.hypot(v.x, v.z), g: c.groundedCount, dVy });
    }
    if (p.y < -30 || p.z < -L - 70) break;
  }
  return {
    deg: launch ? Math.atan2(launch.vy, launch.vh) * R2D : NaN,
    vy: launch?.vy ?? NaN, vh: launch?.vh ?? NaN, peakY, maxDVy, maxDVyAt, rows,
  };
}

// Deterministic RNG so a bad case can be replayed.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const g = makeGround();
const cases = [];
for (let i = 0; i < 600; i++) {
  cases.push({
    speed: 6 + rnd() * 34,
    x0: (rnd() * 2 - 1) * 7.5,
    headDeg: (rnd() * 2 - 1) * 18,
    throttle: rnd() < 0.7 ? 1 : rnd(),
    steer: (rnd() * 2 - 1) * 0.25,
  });
}

const results = cases.map((cs) => ({ cs, r: run(g, cs) })).filter((o) => isFinite(o.r.deg));
results.sort((a, b) => b.r.deg - a.r.deg);

console.log(`Lip angle = ${LIP_DEG.toFixed(1)}°. ${results.length}/600 runs launched.\n`);
const degs = results.map((o) => o.r.deg);
const pct = (q) => degs[Math.min(degs.length - 1, Math.floor(q * degs.length))].toFixed(1);
console.log(`launch angle:  max ${degs[0].toFixed(1)}°   p95 ${pct(0.05)}°   median ${pct(0.5)}°   min ${degs[degs.length - 1].toFixed(1)}°`);
const bad = results.filter((o) => o.r.deg > LIP_DEG + 8);
console.log(`runs launching more than 8° steeper than the lip: ${bad.length} / ${results.length}\n`);

console.log("=== WORST 12 BY LAUNCH ANGLE ===");
console.log("   speed   x0    head  thr   steer |  launch°   Vy     Vh    peakY   worst +ΔVy/tick @ z");
for (const o of results.slice(0, 12)) {
  const c = o.cs, r = o.r;
  console.log(
    `  ${c.speed.toFixed(1).padStart(5)} ${c.x0.toFixed(1).padStart(5)} ${c.headDeg.toFixed(1).padStart(6)}` +
    ` ${c.throttle.toFixed(2)} ${c.steer.toFixed(2).padStart(6)} | ${r.deg.toFixed(1).padStart(7)}°` +
    ` ${r.vy.toFixed(1).padStart(6)} ${r.vh.toFixed(1).padStart(6)} ${r.peakY.toFixed(1).padStart(7)}` +
    `   ${r.maxDVy.toFixed(2).padStart(6)} @ ${r.maxDVyAt ? r.maxDVyAt.z.toFixed(1) : "—"}`,
  );
}

// Same seeds, geometry removed one face-group at a time.
console.log("\n=== ABLATION on the worst 12 (launch angle) ===");
const variants = [
  ["SHIPPED deck=ALL solids=ALL", { deck: ALL, solids: ALL }],
  ["deck=top+side  solids=ALL  ", { deck: ["top", "side"], solids: ALL }],
  ["deck=top       solids=ALL  ", { deck: ["top"], solids: ALL }],
  ["deck=ALL       solids=NONE ", { deck: ALL, solids: [] }],
  ["deck=top       solids=NONE ", { deck: ["top"], solids: [] }],
];
const gv = variants.map(([label, cfg]) => [label, makeGround(cfg)]);
console.log(`   ${"variant".padEnd(28)}` + results.slice(0, 8).map((_, i) => `#${i + 1}`.padStart(8)).join(""));
for (const [label, gg] of gv) {
  const cells = results.slice(0, 8).map((o) => {
    const r = run(gg, o.cs);
    return `${isFinite(r.deg) ? r.deg.toFixed(0) + "°" : "—"}`.padStart(8);
  });
  console.log(`   ${label.padEnd(28)}${cells.join("")}`);
}

console.log("\n=== TICK TRACE of the single worst run ===");
{
  const o = results[0];
  console.log(`   ${JSON.stringify(o.cs, (k, v) => (typeof v === "number" ? +v.toFixed(2) : v))}`);
  const r = run(g, o.cs, true);
  console.log("     t       z       y      Vy      Vh   grounded   ΔVy");
  for (const row of r.rows) {
    const flag = row.dVy > 0.5 ? "  <== PUSH" : "";
    console.log(
      `  ${row.t.toFixed(3)} ${row.z.toFixed(2).padStart(8)} ${row.y.toFixed(2).padStart(7)}` +
      ` ${row.vy.toFixed(2).padStart(7)} ${row.vh.toFixed(2).padStart(7)} ${String(row.g).padStart(6)}` +
      ` ${row.dVy.toFixed(3).padStart(8)}${flag}`,
    );
  }
}
console.log("");
