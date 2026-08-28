// ============================================================================
// "I get stuck at the edges of the shapes, and I see sparks."
//
// Reported after adding the Slope lab and Jump lab groups to a scene. Sparks
// mean the CHASSIS HULL is touching the solids tree, so the question is whether
// it should be, and whether the response then holds the car.
//
// Builds the real lab groups, splits them into deck/solids exactly as
// PropManager.collisionMeshes does (deckGeometry / solidGeometry stand-ins),
// and drives the car up each lane. A/B: stock vs the `_isSupported()` gate on
// SOLID.sitNormalMaxY removed, to say whether this is a regression from that.
//
//   node tools/labEdgeStickRepro.mjs
// ============================================================================
import { registerHeadlessThree } from "./headlessThreeHooks.mjs";

// The lab groups build node materials (parkourMat), so the whole graph needs the
// three/webgpu + three/tsl stubs before anything from the game is imported.
registerHeadlessThree();

const THREE = await import("three");
const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
const { fileURLToPath, pathToFileURL } = await import("node:url");
const { dirname, join } = await import("node:path");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};");

// The one line under test: honouring a mostly-up solid contact when the wheels
// are not carrying the car.
const GATE = `      if (Math.abs(ny) > sitY) {
        if (wheelsCarry) continue;`;
if (!SRC.includes(GATE)) throw new Error("sit gate not found — source moved");

async function load(tag, src) {
  const tmp = join(ROOT, `.labEdge.${tag}.${process.pid}.mjs`);
  writeFileSync(tmp, src);
  const mod = await import(pathToFileURL(tmp).href);
  unlinkSync(tmp);
  mod.Vehicle.prototype._buildMeshes = function () {
    this.group = new THREE.Group();
    this.chassisMesh = new THREE.Object3D();
    this.tireGroups = this.tires.map(() => new THREE.Group());
    this.arrowGroup = new THREE.Group();
    this.arrowGroup.visible = false;
    this.arrows = this.tires.map(() => ({}));
    this.wheelSpin = [0, 0, 0, 0];
    this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
    this._wheelInstances = []; this._wheelParts = [];
  };
  mod.Vehicle.prototype._updateTaillights = function () {};
  return mod;
}

const NOW = await load("now", SRC);
// "old" = every mostly-up solid contact skipped, which is what shipped before.
const OLD = await load("old", SRC.replace(GATE, `      if (Math.abs(ny) > sitY) {
        if (true) continue;`));

const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const parkour = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadParkour.js")).href);

/**
 * Split a lab group into deck/solids meshes the way PropManager does.
 *
 * `useSolidProxy` false reproduces the state where a shape has no solids
 * stand-in, so the WHOLE closed wedge — drive surface included — goes into the
 * solids tree and the chassis collides with the surface the car drives on.
 */
function split(group, useSolidProxy = true) {
  group.updateMatrixWorld(true);
  const deck = [], solids = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    const d = o.geometry?.userData?.deckGeometry;
    deck.push(d ? { geometry: d, matrixWorld: o.matrixWorld, updateMatrixWorld() {} } : o);
    const s = useSolidProxy ? o.geometry?.userData?.solidGeometry : null;
    solids.push(s ? { geometry: s, matrixWorld: o.matrixWorld, updateMatrixWorld() {} } : o);
  });
  return { deck, solids };
}

function bake(meshes, ground) {
  const bvh = new RoadBvh();
  const all = meshes.slice();
  if (ground) {
    const g = new THREE.PlaneGeometry(600, 600);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    m.updateMatrixWorld(true);
    all.push(m);
  }
  bvh.bakeFromMeshes(all);
  return bvh.baked ? bvh : null;
}

const LABS = [
  ["Slope lab", parkour.buildSlopeLabGroup()],
  ["Jump lab", parkour.buildJumpLabGroup()],
];

// Lane centres: the groups lay 5 ramps at x = −42 + i*21, then recentre on XZ.
function laneXs(group) {
  group.updateMatrixWorld(true);
  return group.children.map((c) => c.position.x);
}
function laneZ(group) {
  const box = new THREE.Box3().setFromObject(group);
  return { zNear: box.max.z, zFar: box.min.z, top: box.max.y };
}

/**
 * Drive up one lane and report whether the car got held up.
 *
 * STUCK is measured as the player would feel it: still on the ramp, barely
 * moving, with the throttle down. `sparkTicks` is how long the chassis was in
 * contact with the solids tree at all — that is what draws the sparks.
 */
function run(mod, { deck, solids }, { x, z0, speed, secs = 6 }) {
  const car = new mod.Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(deck, solids);
  car.getFloorY = () => -50;
  car.enabled = true;
  car.body.pos.set(x, 0.55, z0);
  car.body.vel.set(0, 0, -speed);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car._resetInterpolation?.();

  let sparkTicks = 0, minSpeed = Infinity, stalled = 0, maxY = 0;
  const n = Math.round(secs / mod.FIXED_DT);
  for (let i = 0; i < n; i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (car.hitSolid) sparkTicks++;
    maxY = Math.max(maxY, car.body.pos.y);
    const sp = Math.hypot(car.body.vel.x, car.body.vel.z);
    // Only count a stall once the car has actually reached the ramp.
    if (car.body.pos.y > 0.9) {
      minSpeed = Math.min(minSpeed, sp);
      if (sp < 2.0) stalled++;
    }
    if (car.body.pos.y < -5) break;
  }
  return {
    sparkTicks,
    stalledTime: stalled * mod.FIXED_DT,
    minSpeed: minSpeed === Infinity ? -1 : minSpeed,
    maxY,
  };
}

for (const [label, group] of LABS) {
  // PROXY = the drive surface kept OUT of solids (what the kicker ramps always
  // did, and what rampGeometry now does too). FULL = the whole closed wedge in
  // solids, i.e. the chassis colliding with its own drive surface.
  const withProxy = split(group, true);
  const fullSolid = split(group, false);
  const deck = bake(withProxy.deck, true);
  const solids = bake(withProxy.solids, false);
  const solidsFull = bake(fullSolid.solids, false);
  const xs = laneXs(group);
  const { zNear } = laneZ(group);
  console.log(`\n=== ${label} ===`);
  console.log(`  solids tris: proxy ${solids?.triCount ?? 0} vs full ${solidsFull?.triCount ?? 0}, deck ${deck?.triCount ?? 0}`);
  // THE EDGES, which is what was reported. The ramps are 12 m wide, so the side
  // edge is 6 m off the lane centre; offsets straddle it, and the last one runs
  // up the 9 m gap between neighbouring lanes.
  console.log("  lane  offs speed |    NOW: spark  stalled  minSpd  peakY |    WAS: spark  stalled  minSpd  peakY");
  let pSpark = 0, pStall = 0, fSpark = 0, fStall = 0;
  for (let i = 0; i < xs.length; i++) {
    for (const offs of [0, 4.5, 5.5, 6, 6.5, 8, 10.5]) {
      for (const speed of [18, 32]) {
        const cfg = { x: xs[i] + offs, z0: zNear + 26, speed };
        const a = run(NOW, { deck, solids }, cfg);
        const b = run(OLD, { deck, solids }, cfg);
        pSpark += a.sparkTicks; pStall += a.stalledTime;
        fSpark += b.sparkTicks; fStall += b.stalledTime;
        // Only print rows where something actually happened — a clean pass up a
        // lane is not the report.
        if (a.sparkTicks === 0 && b.sparkTicks === 0
          && a.stalledTime <= 0.1 && b.stalledTime <= 0.1) continue;
        let flag = "";
        if (a.stalledTime > b.stalledTime + 0.3) flag = "  <<< WORSE NOW";
        else if (b.stalledTime > a.stalledTime + 0.3) flag = "  <<< better now";
        else if (a.stalledTime > 0.4) flag = "  (stalls in BOTH — pre-existing)";
        console.log(
          `  ${String(i + 1).padStart(4)} ${offs.toFixed(1).padStart(5)} ${String(speed).padStart(5)} |`
          + ` ${String(a.sparkTicks).padStart(11)} ${a.stalledTime.toFixed(2).padStart(8)}s`
          + ` ${a.minSpeed.toFixed(1).padStart(7)} ${a.maxY.toFixed(1).padStart(6)} |`
          + ` ${String(b.sparkTicks).padStart(11)} ${b.stalledTime.toFixed(2).padStart(8)}s`
          + ` ${b.minSpeed.toFixed(1).padStart(7)} ${b.maxY.toFixed(1).padStart(6)}${flag}`,
        );
      }
    }
  }
  console.log(`  TOTALS  now: ${pSpark} spark ticks, ${pStall.toFixed(2)}s stalled`
    + `   |   was: ${fSpark} spark ticks, ${fStall.toFixed(2)}s stalled`);
}

console.log("\n  NOW = shipped code. WAS = every mostly-up solid contact skipped,");
console.log("  i.e. the behaviour before the guardrail-lid work. `spark` is ticks");
console.log("  of chassis-vs-solids contact, which is exactly what draws sparks.");
