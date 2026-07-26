// Guardrail sparks: emission gating, pool discipline, and the bloom-node trap.
//
// THE TRAP, which cost a crash: `applyBloomMRT(mat, materialEmissive)` is the
// pattern used everywhere else in this project, but `materialEmissive` is a
// reference to `material.emissive` — a property UNLIT materials do not have. On
// a MeshBasicNodeMaterial the uniform resolves to undefined and the renderer
// dies with "Cannot read properties of undefined (reading 'r')" inside
// NodeUniformsGroup.updateColor. It only works elsewhere because every other
// caller is a MeshStandardNodeMaterial.
//
// That is a whole-project invariant, so it is checked across the source rather
// than only for this module.
import * as THREE from "three";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

console.log("=== BLOOM SOURCE MUST MATCH THE MATERIAL TYPE ===");
{
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (e.endsWith(".js")) out.push(p);
    }
    return out;
  };
  const files = [
    ...walk(join(ROOT, "games")),
    ...walk(join(ROOT, "v3")),
  ].filter((f) => readFileSync(f, "utf8").includes("applyBloomMRT("));

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Only flag a file that BOTH builds an unlit node material AND leans on
    // materialEmissive — the combination is what crashes.
    const unlit = /new THREE\.MeshBasicNodeMaterial|new MeshBasicNodeMaterial/.test(src);
    const usesRef = /applyBloomMRT\([^,)]+,\s*materialEmissive\s*\)/.test(src);
    if (unlit && usesRef) offenders.push(f.replace(ROOT, "").replace(/\\/g, "/"));
  }
  console.log(`  ${files.length} files call applyBloomMRT`);
  check("no unlit material is bloomed via materialEmissive",
    offenders.length === 0, offenders.join(", ") || "clean");

  const sparkSrc = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadSparks.js"), "utf8");
  check("sparks bloom from `output`, not a material property reference",
    /applyBloomMRT\(material,\s*output\)/.test(sparkSrc));
  // The IMPORT line specifically — the identifier still appears in the comment
  // explaining why it must not be used.
  check("sparks do not IMPORT materialEmissive",
    !/^import[^;]*materialEmissive/m.test(sparkSrc));
}

console.log("\n=== CONSTRUCTION AND POOL ===");
// Bare "three" is aliased to three/webgpu by vite, but not in node — and the
// bloom MRT node needs a GPU-side class hierarchy that does not exist here. Same
// temp-rewrite the vehicle tests use; the bloom wiring is covered statically above.
const { writeFileSync, unlinkSync } = await import("node:fs");
const TMP = join(ROOT, `.sparks.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadSparks.js"), "utf8")
  .replace(/^import \* as THREE from "three";$/m, 'import * as THREE from "three/webgpu";')
  .replace(/^import \{ output \}.*$/m, "const output = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { ModularRoadSparks, DEFAULT_SPARK_SETTINGS } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const scene = new THREE.Scene();
const sparks = new ModularRoadSparks(scene, { ...DEFAULT_SPARK_SETTINGS });
const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1000);
cam.position.set(0, 3, -8);
cam.updateMatrixWorld();

check("one mesh — the whole point of the pooled design", sparks.mesh.isMesh === true);
check("starts hidden and empty", sparks.mesh.visible === false
  && sparks.geometry.drawRange.count === 0);
check("additive, and writes no depth (sparks emit, they must not occlude)",
  sparks.material.blending === THREE.AdditiveBlending && sparks.material.depthWrite === false);
check("not tone mapped — it is a bloom source", sparks.material.toneMapped === false);
check("no texture, so no sampler slot is consumed",
  !sparks.material.map, "v3 is near the Windows WebGPU 16-sampler cap");
check("buffers are pre-allocated, never grown",
  sparks.positions.length > 0 && sparks.colors.length > 0,
  `${(sparks.positions.length * 4 / 1024).toFixed(0)}KB pos + ${(sparks.colors.length * 4 / 1024).toFixed(0)}KB col`);

console.log("\n=== EMISSION GATING ===");
/** Minimal vehicle stand-in — sparks only read this surface. */
function fakeVehicle({ touching = true, vel = new THREE.Vector3(0, 0, 20), impact = 0 } = {}) {
  const n = new THREE.Vector3(1, 0, 0);            // wall on the car's right
  const tangent = vel.clone().addScaledVector(n, -vel.dot(n)).length();
  return {
    enabled: true,
    // The LATCHED surface the sparks read — the vehicle computes scrapeSpeed as
    // the tangential component, with impact speed as a floor.
    scraping: touching,
    scrapePoint: new THREE.Vector3(0, 0.5, 0),
    scrapeNormal: n,
    scrapeSpeed: touching ? Math.max(tangent, impact) : 0,
    body: { vel, pos: new THREE.Vector3(0, 0.6, 0) },
  };
}
const live = () => sparks.particles.filter((p) => p.life > 0).length;

sparks.reset();
sparks.updateFromVehicle(fakeVehicle({ touching: false }), cam, 1 / 60);
check("no contact ⇒ nothing emitted", live() === 0);

sparks.reset();
// Head-on nudge: velocity is INTO the wall, so there is almost no scrape.
sparks.updateFromVehicle(fakeVehicle({ vel: new THREE.Vector3(0, 0, 0.2) }), cam, 1 / 60);
check("contact below minSpeed ⇒ still nothing", live() === 0);

sparks.reset();
// Sliding ALONG the rail — velocity tangent to the normal. This is the case
// that must spark hardest, and its impact speed is ~0.
for (let i = 0; i < 10; i++) {
  sparks.updateFromVehicle(fakeVehicle({ vel: new THREE.Vector3(0, 0, 30) }), cam, 1 / 60);
}
const scraping = live();
check("scraping along a rail emits, despite ZERO impact speed", scraping > 0, `${scraping} alive`);
check("sparks read the LATCHED contact, never the raw per-tick flag",
  !/vehicle\.hitSolid|vehicle\.solidPoint|vehicle\.solidNormal/.test(
    readFileSync(join(ROOT, "games/modular-road-v3/modularRoadSparks.js"), "utf8")),
  "raw solid* is a 120Hz pulse a 60Hz frame mostly misses");
check("the mesh becomes visible once something is alive", sparks.mesh.visible === true);
check("draw range tracks the live count exactly",
  sparks.geometry.drawRange.count === scraping * 6, `${sparks.geometry.drawRange.count} verts`);

sparks.reset();
for (let i = 0; i < 10; i++) {
  sparks.updateFromVehicle(fakeVehicle({ vel: new THREE.Vector3(0, 0, 8) }), cam, 1 / 60);
}
const slow = live();
check("a faster scrape throws more sparks than a slow one", scraping > slow, `${slow} vs ${scraping}`);

console.log("\n=== LIFECYCLE ===");
{
  sparks.reset();
  for (let i = 0; i < 6; i++) sparks.updateFromVehicle(fakeVehicle({ vel: new THREE.Vector3(0, 0, 30) }), cam, 1 / 60);
  const peak = live();
  // Let everything age out with no further contact.
  for (let i = 0; i < 200; i++) sparks.updateFromVehicle(fakeVehicle({ touching: false }), cam, 1 / 60);
  check("sparks die off and the pool drains", live() === 0, `peaked at ${peak}`);
  check("an idle car costs a hidden mesh and nothing else",
    sparks.mesh.visible === false && sparks.geometry.drawRange.count === 0);

  // Overrun: emit far more than the pool holds, for many frames.
  sparks.reset();
  for (let i = 0; i < 400; i++) sparks.updateFromVehicle(fakeVehicle({ vel: new THREE.Vector3(0, 0, 40) }), cam, 1 / 60);
  check("a long scrape never exceeds the pool (ring buffer, no growth)",
    live() <= sparks.particles.length, `${live()} / ${sparks.particles.length}`);
  check("vertex writes stay inside the allocated buffer",
    sparks.geometry.drawRange.count * 3 <= sparks.positions.length);
  check("no NaN leaked into the position buffer",
    !Array.from(sparks.positions.slice(0, sparks.geometry.drawRange.count * 3)).some(Number.isNaN));

  sparks.settings.enabled = false;
  sparks.reset();
  for (let i = 0; i < 10; i++) sparks.updateFromVehicle(fakeVehicle({ vel: new THREE.Vector3(0, 0, 30) }), cam, 1 / 60);
  check("the enabled flag actually stops emission", live() === 0);
  sparks.settings.enabled = true;
}

console.log("\n=== THE CONTACT LATCH (why sparks looked intermittent) ===");
// Physics ticks at 120 Hz, rendering at 60, and `_solidTouch` is reset at the
// TOP of every tick — so a frame only ever sees the last of two. Worse, solid
// response is projection-based: it pushes the car out, so the next tick is not
// penetrating. A continuous rail scrape is really an on/off flicker at tick
// rate, and sampling it once per frame can miss it ENTIRELY.
{
  const VTMP = join(ROOT, `.vlatch.${process.pid}.mjs`);
  writeFileSync(VTMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
    .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
    .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
  const { Vehicle, SOLID, FIXED_DT } = await import(pathToFileURL(VTMP).href);
  unlinkSync(VTMP);
  Vehicle.prototype._buildMeshes = function () {
    this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
    this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
    this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
    this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
    this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
    this._wheelInstances = []; this._wheelParts = [];
  };
  Vehicle.prototype._updateTaillights = function () {};

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.body.vel.set(0, 0, 25); // travelling ALONG a wall whose normal is +X

  /** Replay a per-tick contact pattern; report what each sampling sees. */
  const replay = (pattern, frames = 30) => {
    car._scrapeHold = 0; car._scrapeSpeed = 0;
    let tick = 0, rawFrames = 0, latchedFrames = 0;
    for (let f = 0; f < frames; f++) {
      for (let k = 0; k < 2; k++) {           // 2 physics ticks per rendered frame
        car._solidTouch = pattern[tick % pattern.length];
        car._solidN.set(1, 0, 0);
        car._solidPoint.set(0, 0.5, 0);
        car._solidImpactSpeed = 0;
        car._updateScrapeLatch();
        tick++;
      }
      if (car._solidTouch) rawFrames++;       // what sampling hitSolid would see
      if (car.scraping) latchedFrames++;
    }
    return { rawFrames, latchedFrames, frames };
  };

  const cases = [
    ["every tick", [true]],
    ["every other tick", [true, false]],
    ["1 in 3", [true, false, false]],
    ["1 in 5", [true, false, false, false, false]],
    ["1 in 8", [true, false, false, false, false, false, false, false]],
  ];
  console.log("  contact pattern     raw frames   latched frames");
  let allSeen = true, anyRawMiss = false;
  for (const [name, pat] of cases) {
    const r = replay(pat);
    console.log(`  ${name.padEnd(18)} ${String(r.rawFrames).padStart(6)}/${r.frames}     ${String(r.latchedFrames).padStart(6)}/${r.frames}`);
    if (r.latchedFrames !== r.frames) allSeen = false;
    if (r.rawFrames < r.frames) anyRawMiss = true;
  }
  check("raw per-tick sampling DOES lose contact at frame rate (the bug)", anyRawMiss);
  check("the latch sees a flickering scrape as continuous, at every duty cycle", allSeen);

  // Held, but not sticky — the shower must stop when you leave the rail.
  car._scrapeHold = 0;
  car._solidTouch = true;
  car._solidN.set(1, 0, 0); car._solidPoint.set(0, 0.5, 0);
  car._updateScrapeLatch();
  check("scrapeSpeed is TANGENTIAL — 25 m/s along a wall whose normal is +X",
    Math.abs(car.scrapeSpeed - 25) < 0.01, `${car.scrapeSpeed.toFixed(1)} m/s`);
  car._solidTouch = false;
  let ticks = 0;
  while (car.scraping && ticks < 500) { car._updateScrapeLatch(); ticks++; }
  const ms = ticks * FIXED_DT * 1000;
  check("it releases promptly once contact ends (not sticky)", ms > 0 && ms < 250,
    `${ms.toFixed(0)}ms`);
  check("release time matches SOLID.scrapeHold",
    Math.abs(ms / 1000 - SOLID.scrapeHold) < 0.02, `hold = ${SOLID.scrapeHold}s`);
  check("speed is cleared on release, so nothing emits afterwards",
    car.scrapeSpeed === 0);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
