// DOES A COARSER TIRE RAY RING STILL SEE AN EDGE?
//
// The tire probe casts TIRE.rayRingCount rays in a semicircle through the
// wheel's contact patch, plus an optional sphere sweep. Dropping the ring from
// 10 rays saves real time (measured in-game: open-road physics tick 0.73 ->
// 0.49 ms, tube 3.43 -> 2.77 ms), and a replay of 800 poses from a normal lap
// showed a max contact error of 12 mm.
//
// But that lap is the EASY case. A smooth deck is exactly where a sparse ring
// cannot be caught out: the sphere sweep alone would find the same contact.
// The ring earns its keep at DISCONTINUITIES — the lip of a gap, the lip of a
// jump — where a ray that lands one step too far forward reports air and a ray
// one step back reports deck. That is what this measures, and it is the case
// the lap replay could not prove.
//
// `gap` is noMesh, so `straight -> gap -> straight` is a literal hole with a
// hard edge at each end: the sternest test the kit can build.
//
// FAILURE SIGNAL. Not "the numbers moved" — a lip legitimately produces large
// contact differences, because on one side there IS no ground. What matters is
// whether the coarser ring reports GROUNDED where the reference does not (or
// vice versa) anywhere except within one ray-spacing of the edge itself, and
// whether it ever reports a contact that is WORSE (further away) than the dense
// ring found — i.e. it missed geometry the dense ring saw.
import * as THREE from "three";
import { register } from "node:module";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);

const kit = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { RoadBvh } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, roadParams, guardrailParams, pieceParams, initialConnector,
  PIECE_BY_ID } = kit;

// Vehicle pulls in TSL/bloom, which have no meaning headless — same strip the
// other vehicle tests use.
const TMP = join(ROOT, `.ringedge.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group();
  this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({}));
  this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = [];
  this.taillights = []; this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) fail++;
};

/** Chain piece ids into one baked collision tree, exactly as the game does. */
function bakeChain(ids) {
  let conn = initialConnector();
  const meshes = [];
  for (const id of ids) {
    const def = PIECE_BY_ID.get(id);
    const pp = { ...pieceParams, ...(def.params ?? {}) };
    const built = buildPiece(id, conn, pp, roadParams, guardrailParams, false);
    const geo = built.deckCollision ?? built.geometry;
    if (geo) meshes.push({ geometry: geo, matrixWorld: built.world, updateMatrixWorld() {} });
    conn = built.connectorOut;
  }
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(meshes, { force: true });
  return { bvh, end: conn };
}

/** One car, parked on the tree, ready to be posed anywhere. */
function makeCar(bvh) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = bvh;
  c.solidsBvh = null;
  c.getFloorY = null;
  c.enabled = true;
  return c;
}

/**
 * Sweep the car along the chain and read every tyre's probe answer.
 * The pose is RESTORED at each station, so each sample is independent and the
 * result is a property of the geometry rather than of an accumulating drive.
 */
function sweep(car, z0, z1, step, y) {
  const out = [];
  for (let z = z0; z >= z1; z -= step) {
    car.body.pos.set(0, y, z);
    car.body.vel.set(0, 0, -18);
    car.body.quat.identity();
    if (car.body.angVel) car.body.angVel.set(0, 0, 0);
    for (const t of car.tires) t._clearContact?.();
    car.tick({ steerTarget: 0, throttle: 0, handbrake: false, yaw: 0, pitch: 0 });
    out.push({
      z: +z.toFixed(3),
      tires: car.tires.map((t) => ({ g: t.grounded ? 1 : 0, d: t.hitDistance })),
    });
  }
  return out;
}

/** Ring spacing along the contact arc, metres — the resolution being traded. */
const ringSpacing = (n) => {
  const WHEELR = 0.374;
  const arc = Math.PI * WHEELR * (TIRE.rayRingScale ?? 0.92);
  return arc / Math.max(1, n - 1);
};

for (const scenario of [
  { name: "GAP lip (straight -> gap -> straight)", ids: ["straight", "gap", "straight"] },
  { name: "JUMP lip (straight -> jump -> gap -> landing)", ids: ["straight", "jump", "gap", "landing"] },
]) {
  console.log(`\n=== ${scenario.name} ===`);
  const { bvh, end } = bakeChain(scenario.ids);
  const zEnd = new THREE.Vector3().setFromMatrixPosition(end).z;
  const car = makeCar(bvh);

  const STEP = 0.05; // 5 cm — far finer than any ring spacing under test
  const base = { ring: 10 };
  TIRE.rayRingCount = base.ring;
  const ref = sweep(car, -1, zEnd + 1, STEP, 0.65);

  for (const n of [8, 6, 5, 4]) {
    TIRE.rayRingCount = n;
    const got = sweep(car, -1, zEnd + 1, STEP, 0.65);
    const spacing = ringSpacing(n);

    let groundedMismatch = 0;
    let mismatchAwayFromEdge = 0;
    let worseContact = 0;      // coarser ring found ground FURTHER than dense did
    let worstWorse = 0;
    const mismatchZ = [];

    for (let i = 0; i < ref.length; i++) {
      for (let t = 0; t < 4; t++) {
        const a = ref[i].tires[t], b = got[i].tires[t];
        if (a.g !== b.g) {
          groundedMismatch++;
          // Is there an edge nearby? An edge shows up as the reference itself
          // changing grounded state within one ring-spacing of here.
          const w = Math.ceil(spacing / STEP) + 1;
          let nearEdge = false;
          for (let k = Math.max(0, i - w); k <= Math.min(ref.length - 1, i + w); k++) {
            if (ref[k].tires[t].g !== a.g) { nearEdge = true; break; }
          }
          if (!nearEdge) { mismatchAwayFromEdge++; mismatchZ.push(ref[i].z); }
          continue;
        }
        if (!a.g) continue;
        // Both grounded: a coarser ring must never report ground FURTHER away
        // than the dense ring found. That would mean it missed real geometry.
        const worse = b.d - a.d;
        if (worse > 0.02) { worseContact++; worstWorse = Math.max(worstWorse, worse); }
      }
    }

    console.log(`  ring ${n}  (spacing ${(spacing * 100).toFixed(1)} cm)  ` +
      `grounded-mismatches ${groundedMismatch} (${mismatchAwayFromEdge} away from an edge), ` +
      `missed-geometry ${worseContact}${worstWorse ? ` (worst ${(worstWorse * 100).toFixed(1)} cm)` : ""}`);

    check(`ring ${n}: no grounded flip away from an edge — ${scenario.ids.join("+")}`,
      mismatchAwayFromEdge === 0,
      mismatchAwayFromEdge ? `at z = ${mismatchZ.slice(0, 6).join(", ")}` : `${ref.length} stations x 4 tyres`);
    check(`ring ${n}: never misses ground the dense ring found — ${scenario.ids.join("+")}`,
      worstWorse <= 0.05,
      worstWorse ? `worst ${(worstWorse * 100).toFixed(1)} cm` : "exact");
  }
  TIRE.rayRingCount = base.ring;
}

// ── IS THIS TEST CAPABLE OF FAILING? ───────────────────────────────────────
// Every assertion above passed with "missed-geometry 0, exact", which is the
// shape of a result that would look identical if the harness were simply not
// measuring anything. So prove it can detect degradation: turn the SPHERE SWEEP
// off, leaving the ring as the only probe, and a coarse ring must then visibly
// lose contacts a dense one found. If this control does not fire, nothing above
// is worth believing.
console.log("\n=== CONTROL: sphere sweep OFF (the ring is now the only probe) ===");
{
  const { bvh, end } = bakeChain(["straight", "gap", "straight"]);
  const zEnd = new THREE.Vector3().setFromMatrixPosition(end).z;
  const car = makeCar(bvh);
  const sweepWas = TIRE.useSphereSweep;
  TIRE.useSphereSweep = false;

  TIRE.rayRingCount = 10;
  const ref = sweep(car, -1, zEnd + 1, 0.05, 0.65);
  TIRE.rayRingCount = 4;
  const got = sweep(car, -1, zEnd + 1, 0.05, 0.65);

  let diffs = 0, worst = 0;
  for (let i = 0; i < ref.length; i++) {
    for (let t = 0; t < 4; t++) {
      const a = ref[i].tires[t], b = got[i].tires[t];
      if (a.g !== b.g) { diffs++; continue; }
      if (!a.g) continue;
      const d = Math.abs(b.d - a.d);
      if (d > 0.005) diffs++;
      worst = Math.max(worst, d);
    }
  }
  TIRE.useSphereSweep = sweepWas;
  TIRE.rayRingCount = 10;
  check("the harness CAN see a coarse ring degrade (control)", diffs > 0,
    `${diffs} differing samples, worst ${(worst * 100).toFixed(1)} cm with the sweep off`);
  console.log("  ⇒ with the sweep ON those differences vanish, which is the actual finding:");
  console.log("    the sphere sweep, not the ring, is what resolves these edges.");
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
