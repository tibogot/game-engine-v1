// Half tube, REAL MESH — the same launch question as halfTubeAirRepro, but on
// the geometry the game actually bakes: kit `buildPiece("half_tube")` → RoadBvh
// → createVehicleGround → the real Vehicle. The analytic file proves what the
// PHYSICS can do; this one proves what the PIECE does.
//
// The three things that only exist here (and so are the only things a difference
// can be blamed on): the arc is a 7.5° faceted polyline, the OUTER shell and the
// rim caps are in the same deck BVH as the drivable bore, and the ground adapter
// blends an analytic terrain plane underneath the whole thing.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.halftubemesh.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, TIRE, AERO, CHASSIS, WHEEL, FIXED_DT, GRAVITY, SURFACE_GRIP } =
  await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { buildPiece, pieceParams, initialConnector } =
  await import(new URL("../games/modular-road-v3/modularRoadKit.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);
const { createVehicleGround } = await import(new URL("../v3/play/modularRoadGround.js", import.meta.url).href);

const R2D = 57.2958;
const R = 8;
const CY = R;

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

/**
 * Drop every triangle that is not entirely on the drivable bore (aZone 3).
 * That leaves the inner arc alone — no outer shell, no rim caps, no end caps —
 * which is the analytic surface, built out of the real vertices.
 */
function boreOnly(geo) {
  const zone = geo.getAttribute("aZone");
  const idx = geo.getIndex();
  const keep = [];
  const n = idx ? idx.count : geo.getAttribute("position").count;
  for (let i = 0; i < n; i += 3) {
    const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
    if (zone.getX(a) === 3 && zone.getX(b) === 3 && zone.getX(c) === 3) keep.push(a, b, c);
  }
  const out = geo.clone();
  out.setIndex(keep);
  return out;
}

/**
 * Bake one half-tube piece exactly as the game does. Axis runs down -Z.
 * `raw: true` ignores the piece's collision proxy and bakes the VISIBLE mesh —
 * i.e. the pre-fix behaviour, kept so the two are comparable in one run.
 */
function makeGround({ span = 180, length = 160, terrain = true, tubeRadius = R, bore = false, raw = false }) {
  const pp = { ...pieceParams, straightLength: length, tubeRadius, tubeWall: 0.6, halfTubeSpan: span };
  const built = buildPiece("half_tube", initialConnector(), pp);
  const collide = bore ? boreOnly(built.geometry)
    : raw ? built.geometry
    : (built.deckCollision ?? built.geometry);
  const mesh = new THREE.Mesh(collide);
  mesh.applyMatrix4(built.world);
  mesh.updateMatrixWorld(true);
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes([mesh]);
  const g = createVehicleGround({ getTerrainHeight: () => (terrain ? 0 : -1e4) });
  g.setRoadBvh(bvh.baked ? bvh : null);
  return { g, tris: bvh.triCount, mesh };
}

function makeCar(ground, speed, headingDeg, z0 = -6) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground;
  c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4;
  c.enabled = true;
  const h = headingDeg / R2D;
  c.body.pos.set(0, WHEEL.radius + 0.18, z0);
  // identity quat = forward +Z; the pipe runs down -Z, so 180° + heading yaws
  // the nose off-axis toward the -x wall.
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI + h);
  c.body.vel.set(-Math.sin(h) * speed, 0, -Math.cos(h) * speed);
  c.body.angVel.set(0, 0, 0);
  return c;
}

const lipY = (span) => CY - Math.cos((span / 2) / R2D) * R;

function launch({ ground, speed = 30, heading = 90, secs = 4, span = 180, sgGain = null, steer = 0 }) {
  const s = SURFACE_GRIP.gain;
  if (sgGain !== null) SURFACE_GRIP.gain = sgGain;
  const c = makeCar(ground, speed, heading);
  const n = Math.round(secs / FIXED_DT);
  let peakY = -1e9, airTicks = 0, vAtLip = null, sgAtLip = 0, lastG = 4;
  let maxSg = 0;
  for (let i = 0; i < n; i++) {
    c.tick({ steerTarget: steer, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const y = c.body.pos.y;
    if (y > peakY) peakY = y;
    maxSg = Math.max(maxSg, c._sgMag);
    const g = c.groundedCount;
    if (g === 0) {
      airTicks++;
      if (lastG > 0 && vAtLip === null) { vAtLip = c.body.vel.clone(); sgAtLip = c._sgMag; }
    }
    lastG = g;
  }
  SURFACE_GRIP.gain = s;
  return {
    peakY, aboveLip: peakY - lipY(span), airPct: (100 * airTicks) / n,
    vAtLip, sgAtLip, maxSg, endY: c.body.pos.y,
  };
}

const base = makeGround({});
const raw = makeGround({ raw: true });
console.log("=== SETUP ===");
console.log(`  real kit half_tube, r=${R}, span 180°, ${base.tris} tris in the deck BVH`);
console.log(`  (the visible mesh has ${raw.tris} — the difference is the rim caps)`);

console.log("\n=== 0. THE FIX: SHIPPED COLLISION PROXY vs BAKING THE VISIBLE MESH ===");
console.log("  'visible mesh' is the pre-fix behaviour: rim caps in the deck BVH.\n");
console.log("   heading  speed   visible mesh   with proxy   gained");
for (const heading of [30, 45, 60, 90]) {
  for (const speed of [25, 35, 45]) {
    const a = launch({ ground: raw.g, speed, heading });
    const b = launch({ ground: base.g, speed, heading });
    console.log(
      `   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
      + `   ${a.peakY.toFixed(1).padStart(12)} m   ${b.peakY.toFixed(1).padStart(8)} m`
      + `   ${(b.peakY - a.peakY).toFixed(1).padStart(6)} m`,
    );
  }
}
console.log(`  lip y=${lipY(180).toFixed(2)}   terrain plane at y=0 under the piece`);
console.log(`  SURFACE_GRIP gain ${SURFACE_GRIP.gain} maxG ${SURFACE_GRIP.maxG}   downforce ${AERO.downforce}`);

console.log("\n=== 1. REAL MESH — DOES THE CAR CLEAR THE LIP? ===");
console.log("  No steering, full throttle, nose `heading`° off the pipe axis.\n");
console.log("   heading  speed   peak y   above lip   air%   speed at lip   peak sg");
for (const heading of [15, 30, 45, 60, 90]) {
  for (const speed of [15, 25, 35, 45]) {
    const r = launch({ ground: base.g, speed, heading });
    console.log(
      `   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
      + `   ${r.peakY.toFixed(2).padStart(6)}   ${r.aboveLip.toFixed(2).padStart(8)}`
      + `   ${r.airPct.toFixed(0).padStart(4)}%`
      + `   ${r.vAtLip ? r.vAtLip.length().toFixed(1).padStart(9) : "        -"}`
      + `   ${(r.maxSg / (CHASSIS.mass * GRAVITY)).toFixed(1).padStart(6)}g`,
    );
  }
  console.log("");
}

console.log("=== 2. IS THE TERRAIN PLANE UNDER THE PIECE INTERFERING? ===");
console.log("  Same runs with the analytic terrain removed from the ground adapter.\n");
const noTerr = makeGround({ terrain: false });
console.log("   heading  speed   with terrain   without   delta");
for (const heading of [30, 60, 90]) {
  for (const speed of [25, 35]) {
    const a = launch({ ground: base.g, speed, heading });
    const b = launch({ ground: noTerr.g, speed, heading });
    console.log(
      `   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
      + `   ${a.peakY.toFixed(2).padStart(11)}   ${b.peakY.toFixed(2).padStart(7)}`
      + `   ${(b.peakY - a.peakY).toFixed(2).padStart(6)}`,
    );
  }
}

console.log("\n=== 3. SURFACE_GRIP GAIN SWEEP ON THE REAL MESH ===");
console.log("   gain   heading  speed   peak y   above lip   air%");
for (const g of [0, 0.85]) {
  for (const heading of [30, 60, 90]) {
    for (const speed of [25, 35]) {
      const r = launch({ ground: base.g, speed, heading, sgGain: g });
      console.log(
        `   ${g.toFixed(2).padStart(4)}   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
        + `   ${r.peakY.toFixed(2).padStart(6)}   ${r.aboveLip.toFixed(2).padStart(8)}   ${r.airPct.toFixed(0).padStart(4)}%`,
      );
    }
  }
  console.log("");
}

console.log("=== 4. SPAN (the four shipped tiles use 180 and 240) ===");
console.log("   span   lip y   heading  speed   peak y   above lip   air%");
for (const span of [120, 180, 240]) {
  const gr = makeGround({ span });
  for (const heading of [30, 90]) {
    for (const speed of [25, 35]) {
      const r = launch({ ground: gr.g, speed, heading, span });
      console.log(
        `   ${String(span).padStart(4)}°  ${lipY(span).toFixed(2).padStart(5)}`
        + `   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
        + `   ${r.peakY.toFixed(2).padStart(6)}   ${r.aboveLip.toFixed(2).padStart(8)}   ${r.airPct.toFixed(0).padStart(4)}%`,
      );
    }
  }
}

console.log("\n=== 4b. FULL PIECE vs BORE ONLY (outer shell + rim caps deleted) ===");
console.log("  The bore is the drivable arc. Everything else — the 0.6 m rim ledge at");
console.log("  the lip, the outer shell, the end caps — is in the SAME deck BVH, and");
console.log("  the wheel probes cannot tell them apart. If deleting them restores the");
console.log("  launch, they are what the car is hitting at the rim.\n");
const boreG = makeGround({ bore: true });
console.log(`  full piece ${base.tris} tris / bore only ${boreG.tris} tris\n`);
console.log("   heading  speed   full piece   bore only   delta");
for (const heading of [30, 45, 60, 90]) {
  for (const speed of [25, 35, 45]) {
    const a = launch({ ground: base.g, speed, heading });
    const b = launch({ ground: boreG.g, speed, heading });
    console.log(
      `   ${String(heading).padStart(6)}°  ${String(speed).padStart(4)}`
      + `   ${a.peakY.toFixed(2).padStart(10)}   ${b.peakY.toFixed(2).padStart(9)}`
      + `   ${(b.peakY - a.peakY).toFixed(2).padStart(7)}`,
    );
  }
}

console.log("\n=== 5. TRACE — real mesh, 35 m/s, nose 30° off axis (a hard carve) ===");
{
  const c = makeCar(base.g, 35, 30);
  console.log("      t      x       y    wheels   bank    vy    sg(g)   comp");
  for (let i = 0; i < Math.round(3 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (i % Math.round(0.1 / FIXED_DT)) continue;
    const p = c.body.pos;
    const bank = Math.atan2(p.x, -(p.y - CY)) * R2D;
    const comp = c.tires.reduce((s, t) => s + (t.grounded ? t.compression : 0), 0) / 4;
    console.log(
      `   ${(i * FIXED_DT).toFixed(2).padStart(5)} ${p.x.toFixed(2).padStart(6)}  ${p.y.toFixed(2).padStart(6)}`
      + `     ${c.groundedCount}    ${bank.toFixed(0).padStart(5)}° ${c.body.vel.y.toFixed(1).padStart(6)}`
      + `   ${(c._sgMag / (CHASSIS.mass * GRAVITY)).toFixed(2).padStart(5)}  ${comp.toFixed(3).padStart(6)}`,
    );
  }
}

console.log("\n=== 6. TRACE — the failing case: 35 m/s straight AT the wall (90°) ===");
console.log("  This is the pure half-pipe hit, and on the real mesh it tops out at the");
console.log("  rim. Watch the speed: it should still be ~30 m/s when it gets there.\n");
for (const [label, gr] of [["full piece", base.g], ["bore only", boreG.g]]) {
  console.log(`  -- ${label} --`);
  const c = makeCar(gr, 35, 90);
  console.log("      t      x       y    wheels    vy    speed   sg(g)   comp");
  for (let i = 0; i < Math.round(1.6 / FIXED_DT); i++) {
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    if (i % Math.round(0.05 / FIXED_DT)) continue;
    const p = c.body.pos;
    const comp = c.tires.reduce((s, t) => s + (t.grounded ? t.compression : 0), 0) / 4;
    console.log(
      `   ${(i * FIXED_DT).toFixed(2).padStart(5)} ${p.x.toFixed(2).padStart(6)}  ${p.y.toFixed(2).padStart(6)}`
      + `     ${c.groundedCount}  ${c.body.vel.y.toFixed(1).padStart(6)}  ${c.body.vel.length().toFixed(1).padStart(6)}`
      + `   ${(c._sgMag / (CHASSIS.mass * GRAVITY)).toFixed(2).padStart(5)}  ${comp.toFixed(3).padStart(6)}`,
    );
  }
  console.log("");
}
