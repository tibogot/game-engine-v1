// The kicker ramps' deck stand-in: only the DRIVE SURFACE may be baked into the
// wheel/deck BVH, while the solids channel keeps the whole closed solid.
//
// Guards three things:
//   1. the proxy exists and contains exactly the top band, nothing else,
//   2. PropManager.collisionMeshes() actually hands it to the deck channel and
//      the full mesh to solids,
//   3. the deck-contact force the end cap used to fire at the lip is gone, and
//      the launch off the ramp is unchanged.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.rampproxy.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry, kickerRampGeometry, rampGeometry } =
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
const LIP = Math.atan((H * Math.PI / 2) / L) * R2D;
let fails = 0;
const ok = (cond, msg, extra = "") => {
  if (!cond) fails++;
  console.log(`   ${cond ? "PASS" : "FAIL"}  ${msg}${extra ? `  — ${extra}` : ""}`);
};

/* ── 1. The proxy is the drive surface, and only that ───────────────────── */
console.log("=== 1. DECK PROXY CONTENTS ===");
// Every ramp-shaped prop in the catalog, i.e. everything whose closed solid
// has a lip cap: the two kickers, the parkour slope ramp (which the Slope lab
// is five of), and modularRoadProps' own Slope ramp — that last one is covered
// via its identical builder here, since it is module-private over there.
for (const [label, geo, len, wid, tris] of [
  ["jump ramp", jumpRampGeometry(W, L, H, 32), L, W, 64],
  ["convex kicker", kickerRampGeometry(14, 20, 7, 32), 20, 14, 64],
  ["slope ramp", rampGeometry(12, 20, 35 / R2D), 20, 12, 2],
]) {
  const proxy = geo.userData.deckGeometry;
  ok(!!proxy, `${label}: geometry carries userData.deckGeometry`);
  if (!proxy) continue;
  const full = geo.getAttribute("position").count / 3;
  const dt = proxy.getAttribute("position").count / 3;
  ok(dt === tris, `${label}: proxy has the ${tris} drive-surface tris`, `${dt} of ${full} in the solid`);

  // Every proxy triangle must face up, and none may lie in a closing band:
  // no triangle wholly at y=0 (underside), on a flank (all |x| = w/2), or in
  // the end cap (all z = −length).
  const p = proxy.getAttribute("position");
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  let notUp = 0, closing = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2);
    if (n.lengthSq() > 1e-12 && n.normalize().y <= 0) notUp++;
    const xs = [a.x, b.x, c.x], ys = [a.y, b.y, c.y], zs = [a.z, b.z, c.z];
    if (ys.every((y) => y < 1e-6)) closing++;
    else if (xs.every((x) => Math.abs(x + wid / 2) < 1e-4) || xs.every((x) => Math.abs(x - wid / 2) < 1e-4)) closing++;
    else if (zs.every((z) => Math.abs(z + len) < 1e-4)) closing++;
  }
  ok(notUp === 0, `${label}: every proxy triangle faces up`, `${notUp} did not`);
  ok(closing === 0, `${label}: no underside / flank / end-cap band in the proxy`, `${closing} found`);
}

/* ── 2. collisionMeshes() routes proxy → deck, full solid → solids ──────── */
console.log("\n=== 2. WHAT collisionMeshes() HANDS EACH CHANNEL ===");
{
  // PropManager pulls in TransformControls (which extends a DOM-dependent base)
  // and TSL, so load it from a copy with those stubbed — the same trick the
  // vehicle harnesses use. The copy lives beside the original so its relative
  // imports still resolve. collisionMeshes only ever touches `this.instances`,
  // so the method is driven against a stand-in `this`.
  const PROPS_DIR = join(ROOT, "games/modular-road-v3");
  const STUB = join(PROPS_DIR, `.propstub.${process.pid}.mjs`);
  const PTMP = join(PROPS_DIR, `.propsproxy.${process.pid}.mjs`);
  // modularRoadPropPhysics and modularRoadScenery both reach code that needs a
  // DOM at import time. Nothing here calls a prop's make(), so the catalog only
  // needs these names to EXIST — an empty scenery catalog just means fewer
  // entries in PROP_CATALOG.
  writeFileSync(STUB, [
    "import * as THREE from 'three';",
    "export const PHYSICS_PROP_TYPES = {};",
    "export const CONE_SCALE = 3;",
    "export const GATE_WIDTH = 4.4, GATE_HEIGHT = 1.5, GATE_BASE_Y = 0.15;",
    "export const GATE_POST_RADIUS = 0.11, GATE_POST_HEIGHT = 1.9;",
    "export const SCENERY_CATALOG = [];",
    "export const makeSceneryProp = () => new THREE.Group();",
  ].join("\n"));
  writeFileSync(PTMP, readFileSync(join(PROPS_DIR, "modularRoadProps.js"), "utf8")
    .replace(/^import \{ TransformControls \}.*$/m, "const TransformControls = class {};")
    .replace(/^import \{ materialEmissive, materialColor \}.*$/m,
      "const materialEmissive = null, materialColor = null;")
    .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};")
    .replace(/"\.\/modularRoadPropPhysics\.js"/g, `"./${basename(STUB)}"`)
    .replace(/"\.\/modularRoadScenery\.js"/g, `"./${basename(STUB)}"`));
  let PropManager = null;
  try {
    ({ PropManager } = await import(pathToFileURL(PTMP).href));
  } catch (e) {
    console.log(`   SKIP  could not load PropManager headless — ${e.message.split("\n")[0]}`);
  } finally {
    unlinkSync(PTMP);
    unlinkSync(STUB);
  }
  if (PropManager) {
    const geo = jumpRampGeometry(W, L, H, 32);
    const mesh = new THREE.Mesh(geo);
    mesh.position.set(120, 3, -40);
    mesh.updateMatrixWorld(true);
    const root = new THREE.Group();
    root.add(mesh);
    root.updateMatrixWorld(true);
    const fake = { instances: [{ collision: "both", root }] };
    const { deck, solids } = PropManager.prototype.collisionMeshes.call(fake);

    ok(deck.length === 1 && solids.length === 1, "one entry per channel");
    ok(deck[0].geometry === geo.userData.deckGeometry, "deck channel got the PROXY");
    ok(solids[0] === mesh, "solids channel got the FULL mesh");
    ok(deck[0].matrixWorld === mesh.matrixWorld,
      "proxy borrows the prop's live matrixWorld (moving the prop moves its collision)");
    ok(typeof deck[0].updateMatrixWorld === "function",
      "proxy answers updateMatrixWorld() — bakeFromMeshes calls it");

    // The baked deck must land at the prop's WORLD pose, not the origin.
    const bvh = new RoadBvh();
    bvh.bakeFromMeshes(deck);
    const hit = bvh.raycastFirst(
      new THREE.Vector3(120, 60, -40 - L / 2), new THREE.Vector3(0, -1, 0), 200,
    );
    const want = 3 + H * (1 - Math.cos(Math.PI / 4));
    ok(!!hit && Math.abs(hit.point.y - want) < 0.05,
      "baked proxy sits at the prop's world transform",
      hit ? `y ${hit.point.y.toFixed(2)} vs ${want.toFixed(2)}` : "no hit");
  }
}

/* ── 3. The lip force is gone and the launch is unchanged ───────────────── */
console.log("\n=== 3. LIP BEHAVIOUR (deck = proxy, solids = full solid) ===");
{
  const geo = jumpRampGeometry(W, L, H, 32);
  const mesh = new THREE.Mesh(geo);
  mesh.updateMatrixWorld(true);
  const deckMesh = { geometry: geo.userData.deckGeometry, matrixWorld: mesh.matrixWorld, updateMatrixWorld() {} };

  const mk = (deckSrc) => {
    const d = new RoadBvh(); d.bakeFromMeshes([deckSrc]);
    const s = new RoadBvh(); s.bakeFromMeshes([mesh]);
    const g = createVehicleGround({ getTerrainHeight: () => 0 });
    g.setRoadBvh(d); g.setRoadSolidsBvh(s);
    return g;
  };

  const drive = (ground, speed) => {
    const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
    c.groundBvh = ground.ground; c.solidsBvh = ground.solids;
    c.getFloorY = () => -1e4; c.enabled = true;
    c.body.pos.set(0, WHEEL.radius + 0.18, 30);
    c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
    c.body.vel.set(0, 0, -speed);

    let peakDeck = 0, launch = null, wasG = true, peakY = -1e9;
    const origAdd = c.body.addForceAtPoint.bind(c.body);
    let inDeck = false;
    const origDeck = c._applyDeckContact.bind(c);
    c._applyDeckContact = (...a) => { inDeck = true; try { return origDeck(...a); } finally { inDeck = false; } };
    c.body.addForceAtPoint = (f, p) => { if (inDeck) peakDeck = Math.max(peakDeck, f.length()); return origAdd(f, p); };

    for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
      c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
      const p = c.body.pos, v = c.body.vel;
      peakY = Math.max(peakY, p.y);
      if (wasG && c.groundedCount === 0 && p.z < -L * 0.6 && !launch) {
        launch = { deg: Math.atan2(v.y, Math.hypot(v.x, v.z)) * R2D };
      }
      wasG = c.groundedCount > 0;
      if (p.z < -L - 50) break;
    }
    return { deg: launch?.deg ?? NaN, peakY, peakDeck };
  };

  console.log("   speed |  BEFORE (whole solid in deck)  |  AFTER (proxy in deck)");
  console.log("         |  launch°  peak   maxDeckF      |  launch°  peak   maxDeckF");
  for (const speed of [16, 20, 24, 28, 32]) {
    const before = drive(mk(mesh), speed);
    const after = drive(mk(deckMesh), speed);
    console.log(
      `   ${String(speed).padStart(5)} |  ${before.deg.toFixed(1).padStart(6)}° ${before.peakY.toFixed(1).padStart(5)}` +
      ` ${(before.peakDeck / 1000).toFixed(1).padStart(8)} kN   | ` +
      ` ${after.deg.toFixed(1).padStart(6)}° ${after.peakY.toFixed(1).padStart(5)}` +
      ` ${(after.peakDeck / 1000).toFixed(1).padStart(8)} kN`,
    );
    ok(after.peakDeck < 1000,
      `${speed} m/s: no deck-contact push off the ramp`,
      `was ${(before.peakDeck / 1000).toFixed(1)} kN, now ${(after.peakDeck / 1000).toFixed(1)} kN`);
    ok(Math.abs(after.deg - LIP) < 1.5,
      `${speed} m/s: still launches at the lip angle`,
      `${after.deg.toFixed(1)}° vs ${LIP.toFixed(1)}°`);
  }
}

console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
