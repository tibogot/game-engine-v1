// DOES A SWING GATE SURVIVE A SAVE/LOAD ROUND TRIP?
//
// Reported: "a track I saved with some swing gate obstacles — when loading back
// the track the swing gate doesn't have collision any more and it's not in the
// rotation I placed it."
//
// Both halves are checked here against the REAL PropManager export/import and
// the REAL PropPhysics sync, because the two symptoms have different suspects:
//
//   ROTATION — exportInstances() writes `inst.root.quaternion`, which for a
//     simulated prop is not the authored pose but `home × swing`, written every
//     tick by PropPhysics._tickHinge.
//   COLLISION — the gate's post is a CAPSULE (userData.capsule) and its panel is
//     excluded from the static bake (userData.noCollide), so a gate that loses
//     either flag silently stops being solid while still looking right.
//
// Run: node tools/gateSaveLoadTest.mjs
import { registerHeadlessThree } from "./headlessThreeHooks.mjs";
registerHeadlessThree();

import * as THREE from "three";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const game = (f) => pathToFileURL(join(ROOT, "games/modular-road-v3", f)).href;

const { PropManager, PROP_BY_ID } = await import(game("modularRoadProps.js"));
const { PropPhysics } = await import(game("modularRoadPropPhysics.js"));

let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "  ok   " : "  FAIL "}${msg}`); };

/**
 * A PropManager with no DOM, so the REAL add()/export/import run.
 *
 * Only the gizmo and the selection box are stubbed — they are the parts that
 * need a canvas, and neither is under test. Everything the save path touches is
 * the shipping code.
 */
function bareManager() {
  const m = Object.create(PropManager.prototype);
  m.scene = new THREE.Scene();
  m.group = new THREE.Group();
  m.scene.add(m.group);
  m.instances = [];
  m.selected = null;
  m.orbit = null;
  m.onChange = null;
  m.onSelect = null;
  m.onSelectionChange = null;
  m.getSurfaceY = null;             // "free" placement: no snapping to fight
  // getHelper() is what actually shows/hides the arrows, so the stand-in needs a
  // stable helper — PropManager pushes its suspend state onto it (suspendGizmo).
  m.gizmo = { attach() {}, detach() {}, enabled: false, visible: false, axis: null,
    _helper: { visible: false }, getHelper() { return this._helper; } };
  m.selBox = { setFromObject() {}, visible: false };
  m._disposeInstance = () => {};
  return m;
}

const YAW = THREE.MathUtils.degToRad(37);     // the "rotation I placed it in"
const POS = new THREE.Vector3(12, 40.5, -63); // on an elevated deck

/** Place a prop through the real add(), then rotate it as a gizmo drag would. */
function place(mgr, id, pos, yaw) {
  const inst = mgr.add(id, pos.clone());
  inst.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  // What the gizmo's "mouseUp" listener does — the drag is an authoring act.
  mgr.captureAuthored(inst);
  return inst;
}

console.log("\n═══ SWING GATE SAVE / LOAD ═══\n");

const authored = bareManager();
place(authored, "gate", POS, YAW);

const gateOf = (mgr) => mgr.instances.find((i) => i.id === "gate");
const yawOf = (inst) => new THREE.Euler().setFromQuaternion(inst.root.quaternion, "YXZ").y;

// ── Round trip. ────────────────────────────────────────────────────────────
const saved = JSON.parse(JSON.stringify(authored.exportInstances()));
const loaded = bareManager();
loaded.importInstances(saved);

const g = gateOf(loaded);
check(!!g, `the gate survives the round trip at all (${loaded.instances.length} prop(s) back)`);

if (g) {
  check(Math.abs(yawOf(g) - YAW) < 1e-4,
    `rotation is preserved: placed ${THREE.MathUtils.radToDeg(YAW).toFixed(1)}°, loaded ${
      THREE.MathUtils.radToDeg(yawOf(g)).toFixed(1)}°`);
  check(g.root.position.distanceTo(POS) < 1e-4,
    `position is preserved: ${g.root.position.toArray().map((n) => n.toFixed(1)).join(", ")}`);
  check(g.collision === "solid",
    `the instance keeps its collision role: "${g.collision}"`);
}

// ── COLLISION. The post is a capsule; the panel must stay out of the bake. ──
loaded.scene.updateMatrixWorld(true);
const caps = loaded.collisionCapsules();
check(caps.length === 1,
  `the hinge POST comes back as a capsule collider (${caps.length} found — this is the
         only thing making the gate solid, the panel is deliberately excluded)`);
if (caps.length) {
  const mid = new THREE.Vector3().addVectors(caps[0].a, caps[0].b).multiplyScalar(0.5);
  check(Math.hypot(mid.x - POS.x, mid.z - POS.z) < 0.5,
    `and it is at the gate's hinge, not the origin: (${mid.x.toFixed(1)}, ${mid.z.toFixed(1)})
         vs placed (${POS.x}, ${POS.z})`);
}
const { solids } = loaded.collisionMeshes();
check(!solids.some((o) => o.userData.noCollide || o.userData.capsule),
  `the swinging PANEL stays out of the static bake (a baked panel is an invisible
         wall across the doorway)`);

// ── PHYSICS. No sim entry = no swing, which reads as "no collision". ────────
const physics = new PropPhysics({ props: loaded });
const n = physics.sync();
const sim = physics.sims.find((s) => s.inst?.id === "gate");
check(!!sim, `PropPhysics.sync() picks the gate up as a hinge (${n} simulated prop(s))`);
if (sim) {
  const homeYaw = new THREE.Euler().setFromQuaternion(sim.home.quat, "YXZ").y;
  check(Math.abs(homeYaw - YAW) < 1e-4,
    `and its HOME pose is the placed rotation, not identity: ${
      THREE.MathUtils.radToDeg(homeYaw).toFixed(1)}°
         (home is what the sim writes back every tick — a wrong home snaps the gate
         to the wrong angle the instant play starts)`);
}

// ── THE SAVE SIDE. This is the actual bug. ─────────────────────────────────
// Drive through a gate, switch to build (nothing used to put props back on the
// way in), save. The panel's swing angle went into the file as the gate's
// rotation, and on load that became its new resting pose.
console.log("\n═══ SAVING WHILE THE GATE IS SWUNG OPEN ═══\n");
const SWING = 0.9; // rad ≈ 51.6°, a gate the car is halfway through
if (sim) {
  const swingOpen = () => {
    sim.angle = SWING;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), sim.angle);
    sim.inst.root.quaternion.copy(sim.home.quat).multiply(q);
  };
  swingOpen();
  check(Math.abs(yawOf(sim.inst) - (YAW + SWING)) < 1e-3,
    `the live root really is displaced while the gate is open: ${
      THREE.MathUtils.radToDeg(yawOf(sim.inst)).toFixed(1)}° vs authored ${
      THREE.MathUtils.radToDeg(YAW).toFixed(1)}° (so the check below has teeth)`);

  const savedOpen = JSON.parse(JSON.stringify(loaded.exportInstances()));
  const reloaded = bareManager();
  reloaded.importInstances(savedOpen);
  const yaw2 = yawOf(gateOf(reloaded));
  check(Math.abs(yaw2 - YAW) < 1e-3,
    `a gate saved mid-swing reloads at its AUTHORED angle: placed ${
      THREE.MathUtils.radToDeg(YAW).toFixed(1)}°, reloaded ${
      THREE.MathUtils.radToDeg(yaw2).toFixed(1)}°
         (the live root carries home × swing, so exporting it baked the swing in
         permanently — 37° saved as 88.6°)`);

  // Re-syncing while the gate is open must not re-home it either. PropPhysics
  // syncs itself from tick() whenever the prop count changes, which CAN happen
  // mid-drive, and homing off the live root there had the same effect.
  swingOpen();
  physics.sync();
  const reSim = physics.sims.find((s) => s.inst?.id === "gate");
  const reHome = new THREE.Euler().setFromQuaternion(reSim.home.quat, "YXZ").y;
  check(Math.abs(reHome - YAW) < 1e-4,
    `and a re-sync while it is open keeps the authored home: ${
      THREE.MathUtils.radToDeg(reHome).toFixed(1)}°`);
}

// ── THE SAME BUG CLASS ON A CONE. Free body rather than a hinge, so it is a
// different code path in PropPhysics, but the same exported-live-root mistake.
console.log("\n═══ A KNOCKED-OVER CONE ═══\n");
{
  const mgr = bareManager();
  const cone = place(mgr, "cone", new THREE.Vector3(-8, 0, 20), 0);
  const phys = new PropPhysics({ props: mgr });
  phys.sync();
  const cs = phys.sims.find((s) => s.inst === cone);
  check(!!cs?.body, "a cone is simulated as a free body");
  if (cs) {
    // Punt it: on its side and 6 m away, the way a car leaves one.
    cone.root.position.set(-2, 0.4, 26);
    cone.root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

    const out = JSON.parse(JSON.stringify(mgr.exportInstances()));
    const back = bareManager();
    back.importInstances(out);
    const c2 = back.instances[0];
    check(c2.root.position.distanceTo(new THREE.Vector3(-8, 0, 20)) < 1e-3,
      `a cone saved after being punted reloads where it was PLACED: ${
        c2.root.position.toArray().map((n) => n.toFixed(1)).join(", ")} (placed -8, 0, 20)`);
    check(Math.abs(new THREE.Euler().setFromQuaternion(c2.root.quaternion, "YXZ").x) < 1e-3,
      "and standing up, not on its side");
  }
}

// ── EVERY EDITOR MOVE MUST RE-AUTHOR, or the save is right for the paths that
// were remembered and quietly wrong for the rest. These are the three that were
// missed on the first pass, and each loses a DIFFERENT edit.
console.log("\n═══ EDITOR MOVES THAT ARE NOT THE GIZMO ═══\n");
{
  // 1. snapAll() — runs after every track load and on a snap-mode change.
  const mgr = bareManager();
  mgr.getSurfaceY = () => 12; // a surface 12 m up
  const cone = mgr.add("cone", new THREE.Vector3(5, 60, 5));
  mgr.snapAll();
  const out = mgr.exportInstances();
  check(Math.abs(out[0].position[1] - cone.root.position.y) < 1e-6,
    `snapAll() re-authors: saved y ${out[0].position[1].toFixed(2)} matches the snapped
         y ${cone.root.position.y.toFixed(2)} (this runs on every track load)`);

  // 2. A bare snapToSurface() on the selection — the game's snap-mode shortcut.
  mgr.getSurfaceY = () => 30;
  mgr.snapToSurface(cone);
  check(Math.abs(mgr.exportInstances()[0].position[1] - cone.root.position.y) < 1e-6,
    `a lone snapToSurface() re-authors too: saved y ${
      mgr.exportInstances()[0].position[1].toFixed(2)}`);

  // 3. Stack-on-placement, where the game moves the root AFTER add() returned.
  const stacked = mgr.add("cone", new THREE.Vector3(0, 0, 0));
  stacked.root.position.set(40, 3, -40);
  stacked.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.2);
  mgr.captureAuthored(stacked); // what roadGame does after aligning to the stack
  const s = mgr.exportInstances()[1];
  check(Math.abs(s.position[0] - 40) < 1e-6 && Math.abs(s.position[2] + 40) < 1e-6,
    `a stacked prop saves where it was STACKED, not where add() first put it: ${
      s.position.map((v) => v.toFixed(1)).join(", ")}`);
}

console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
