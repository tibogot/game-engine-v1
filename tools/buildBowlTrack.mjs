// BUILD "PARK BOWL SHOWCASE" — a run-up and a bowl, for judging the camera.
//
//     start ──────── run-up ────────┐
//                                    \___  park bowl (small, R40)
//
// The point of this track is the RE-ENTRY: hit the bowl fast enough to reach the
// lip, and the car comes back DOWN the wall nearly vertical on partial contact.
// `tools/bowlCamProbe.mjs` measures the camera swinging fully in front of the
// car there (astern +0.96 at 30 m/s, against a rig that is supposed to stay
// behind), so this builds the same event at the same speeds somewhere it can be
// driven by hand and judged by eye — which is the only way to settle whether a
// number that looks wrong actually reads as wrong.
//
// Both bowls are here on separate chains so they can be compared: the small one
// fails from ~30 m/s, the big one needs ~38.
//
//   node tools/buildBowlTrack.mjs
import * as THREE from "three";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GAME = join(ROOT, "games/modular-road-v3");
const { ModularRoadBuilder, CATEGORY_PRESETS } = await import(
  pathToFileURL(join(GAME, "modularRoadBuilder.js")).href);
const { exportTrack } = await import(pathToFileURL(join(GAME, "modularRoadTrackIO.js")).href);
const { createChaseCamera } = await import(pathToFileURL(join(GAME, "chaseCamera.js")).href);
const KIT = await import(pathToFileURL(join(GAME, "modularRoadKit.js")).href);

const TMP = join(ROOT, `.bowltrack.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { createVehicleGround } = await import(
  pathToFileURL(join(ROOT, "v3/play/modularRoadGround.js")).href);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

const START_HEIGHT = 70;
const R2D = 180 / Math.PI;
const pos = (m) => new THREE.Vector3().setFromMatrixPosition(m);
const say = (s) => console.log(`  ${s}`);

/* ── BUILD ───────────────────────────────────────────────────────────────── */

function build() {
  const b = new ModularRoadBuilder({
    scene: new THREE.Scene(),
    material: new THREE.MeshBasicMaterial(),
    railMaterial: new THREE.MeshBasicMaterial(),
    shellMaterial: new THREE.MeshBasicMaterial(),
    decorMaterial: new THREE.MeshBasicMaterial(),
  });
  const tile = (id) => {
    for (const list of Object.values(CATEGORY_PRESETS)) {
      const t = list.find((x) => x.id === id);
      if (t) return t.preset ?? t;
    }
    throw new Error(`no tile ${id}`);
  };
  const put = (id, n = 1) => { b.setActivePreset(tile(id)); for (let i = 0; i < n; i++) b.place(); };
  const putBase = (id) => { b.setActivePiece(id); b.place(); };

  b.setSnap({ enabled: true, step: 8, yawDeg: 15 });

  // ── THE SMALL BOWL, R40 — the one that fails from about 30 m/s ───────────
  // Three long straights of run-up. Two arrive around 32 m/s on the flip ramp's
  // chain and that is already past where the camera lets go here, so this is
  // deliberately not a gentle approach: the failure needs speed to show.
  b.beginNewChain(new THREE.Vector3(0, START_HEIGHT, 0), 0, { exact: true });
  putBase("start");
  put("straight_long", 3);
  put("quarterpipe_bowl_small");
  putBase("finish");

  // ── THE BIG BOWL, R60 — same run-up, alongside ───────────────────────────
  // Its wall is half as steep for the same height, so it holds the shot much
  // longer; it only lets go around 38 m/s. Side by side, the difference is the
  // whole point.
  b.beginNewChain(new THREE.Vector3(90, START_HEIGHT, 0), 0, { exact: true });
  putBase("start");
  put("straight_long", 3);
  put("quarterpipe_bowl");
  putBase("finish");

  return b;
}

/* ── DRIVE, AND WATCH THE CAMERA ─────────────────────────────────────────── */

function bakeGround(b) {
  b.scene.updateMatrixWorld(true);
  const decks = [], solids = [];
  for (const p of b.pieces) {
    const m = p.mesh;
    if (m && !m.userData.noCollision) {
      const proxy = m.userData.collisionGeometry;
      decks.push(proxy
        ? { geometry: proxy, matrixWorld: m.matrixWorld, userData: m.userData, updateMatrixWorld() {} }
        : m);
    }
    for (const extra of [p.railMesh, p.shellMesh]) {
      if (!extra) continue;
      const proxy = extra.userData.collisionGeometry;
      solids.push(proxy
        ? { geometry: proxy, matrixWorld: extra.matrixWorld, updateMatrixWorld() {} }
        : extra);
    }
  }
  const d = new RoadBvh(); d.bakeFromMeshes(decks);
  const g = createVehicleGround({ getTerrainHeight: () => -1e4 });
  g.setRoadBvh(d);
  if (solids.length) { const s = new RoadBvh(); s.bakeFromMeshes(solids); g.setRoadSolidsBvh(s); }
  return g;
}

/** Hold the throttle from a start line and report the ride AND the shot. */
function drive(b, chainIdx) {
  const ground = bakeGround(b);
  const starts = b.pieces.filter((p) => p.id === "start");
  const startM = starts[chainIdx].connectorOut;
  const startRot = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().extractRotation(startM));
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(startRot);

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.groundBvh = ground.ground; car.solidsBvh = ground.solids;
  car.getFloorY = () => -1e4; car.enabled = true;
  car.body.pos.copy(pos(startM)).addScaledVector(fwd, 4);
  car.body.pos.y += WHEEL.radius + 0.25;
  car.body.quat.copy(startRot).multiply(
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  const chase = createChaseCamera({ camera, vehicle: car });
  chase.snap?.();

  const view = new THREE.Vector3(), prev = new THREE.Vector3();
  const carFwd = new THREE.Vector3(), rel = new THREE.Vector3();
  let apex = 0, entry = 0, peakRate = 0, worstAstern = -1, asternAt = null;
  let onWall = false, t = 0;
  for (let i = 0; i < Math.round(16 / FIXED_DT); i++) {
    car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0, airSteer: 0 });
    car._renderPos.copy(car.body.pos);
    car._renderQuat.copy(car.body.quat);
    chase.update(FIXED_DT);
    t += FIXED_DT;

    const h = car.body.pos.y - START_HEIGHT;
    if (!onWall && h > 1.5) { onWall = true; entry = car.body.vel.length(); }
    apex = Math.max(apex, h);
    camera.getWorldDirection(view);
    carFwd.set(0, 0, 1).applyQuaternion(car.body.quat);
    rel.copy(camera.position).sub(car.body.pos).normalize();
    // Positive means the camera has got IN FRONT of the car, which the rig is
    // built never to do — see the swing in chaseCamera.
    const ast = rel.dot(carFwd);
    if (onWall && ast > worstAstern) {
      worstAstern = ast;
      asternAt = { t, h, gnd: car.groundedCount, vy: car.body.vel.y };
    }
    if (i > 0 && onWall) peakRate = Math.max(peakRate, prev.angleTo(view) * R2D / FIXED_DT);
    prev.copy(view);
    if (h < -25) break;
  }
  return { apex, entry, peakRate, worstAstern, asternAt };
}

/* ── RUN ─────────────────────────────────────────────────────────────────── */

console.log("\nBUILDING PARK BOWL SHOWCASE\n");
const b = build();

let fail = 0;
const check = (name, ok, note = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
};

const runs = [
  { label: "small bowl, R40", r: drive(b, 0) },
  { label: "big bowl,   R60", r: drive(b, 1) },
];
for (const { label, r } of runs) {
  say(`${label}   enters at ${r.entry.toFixed(0)} m/s   rides to ${r.apex.toFixed(0)} m   `
    + `camera peak ${r.peakRate.toFixed(0)}°/s   `
    + `worst astern ${r.worstAstern.toFixed(2)}`
    + `${r.worstAstern > 0 ? "  <-- IN FRONT OF THE CAR" : ""}`
    + (r.asternAt
      ? `  [at ${r.asternAt.h.toFixed(0)} m, ${r.asternAt.gnd} wheels, `
        + `${r.asternAt.vy < 0 ? "falling" : "rising"}]`
      : ""));
}
console.log("");

// The track only has to be RIDEABLE. Whether the camera is wrong is the thing
// being handed over to be judged by eye, so it is reported and never asserted —
// a generator that refused to write a track because the camera misbehaves would
// refuse to build the very thing needed to look at it.
for (const { label, r } of runs) {
  check(`${label}: the car gets up the wall`, r.apex > 8, `${r.apex.toFixed(0)} m`);
}

let worstSeam = 0;
for (const c of b.chains) {
  const ps = b.pieces.filter((p) => p.chainId === c.id);
  for (let i = 1; i < ps.length; i++) {
    if (ps[i].detached) continue;
    worstSeam = Math.max(worstSeam, pos(ps[i - 1].connectorOut).distanceTo(pos(ps[i].connectorIn)));
  }
}
check("every seam inside every chain is tight", worstSeam < 1e-6,
  `worst ${worstSeam.toExponential(2)} m`);
const ys = b.pieces.flatMap((p) => [pos(p.connectorIn).y, pos(p.connectorOut).y]);
check(`nothing sinks underground (lowest ${Math.min(...ys).toFixed(0)} m)`, Math.min(...ys) > 15);

const empty = { exportInstances: () => [], exportLayout: () => [] };
const out = exportTrack({
  builder: b,
  props: empty, movers: empty, portals: empty,
  roadParams: KIT.roadParams,
  guardrailParams: KIT.guardrailParams,
  pieceParams: KIT.pieceParams,
  portalParams: KIT.portalParams,
  defaults: {
    roadParams: KIT.ROAD_PARAM_DEFAULTS,
    guardrailParams: KIT.GUARDRAIL_PARAM_DEFAULTS,
    pieceParams: KIT.PIECE_PARAM_DEFAULTS,
  },
});
out.spawn = null;

if (fail) {
  console.log(`\n${fail} FAILURE(S) — not written\n`);
  process.exit(1);
}
writeFileSync(join(GAME, "bowl-showcase.json"), JSON.stringify(out, null, 1));
console.log(`\nwrote games/modular-road-v3/bowl-showcase.json — ${out.pieces.length} pieces\n`);
