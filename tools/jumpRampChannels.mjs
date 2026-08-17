// WHICH CHANNEL PUSHES THE CAR AT THE LIP?
//
// Instruments the three things that can put force into the chassis — the
// SUSPENSION (per tyre), the DECK contact spring (chassis corners vs the deck
// BVH) and the SOLIDS resolver (hull samples vs the solids BVH) — and drives the
// jumpkicker prop on flat ground while logging each one per tick.
//
// First it asserts the harness is actually exercising all three (a stubbed
// _buildMeshes must not have emptied the contact-point lists).
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jumprampch.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, WHEEL, FIXED_DT, CHASSIS, GRAVITY } = await import(pathToFileURL(TMP).href);
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
const base = jumpRampGeometry(W, L, H, 32);

// ── Is the geometry consistently wound? (the probe scan saw normals flip) ──
{
  const p = base.getAttribute("position");
  let up = 0, down = 0, flippedZ = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    // Top-surface triangles only: none of the three at y=0, not the end cap.
    const ys = [a.y, b.y, c.y], zs = [a.z, b.z, c.z], xs = [a.x, b.x, c.x];
    if (zs.every((z) => Math.abs(z + L) < 1e-4)) continue;
    if (ys.every((y) => y < 1e-6)) continue;
    if (xs.every((x) => Math.abs(Math.abs(x) - W / 2) < 1e-4)) continue;
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2).normalize();
    if (n.y >= 0) up++; else { down++; flippedZ.push(((a.z + b.z + c.z) / 3).toFixed(1)); }
  }
  console.log("=== TOP-SURFACE WINDING ===");
  console.log(`   ${up} triangles wound normal-UP, ${down} wound normal-DOWN`);
  if (down) console.log(`   flipped near z = ${[...new Set(flippedZ)].join(", ")}`);
  console.log("");
}

function makeGround() {
  const m = new THREE.Mesh(base);
  m.updateMatrixWorld(true);
  const deck = new RoadBvh(); deck.bakeFromMeshes([m]);
  const sol = new RoadBvh(); sol.bakeFromMeshes([m]);
  const g = createVehicleGround({ getTerrainHeight: () => 0 });
  g.setRoadBvh(deck); g.setRoadSolidsBvh(sol);
  return g;
}

const ground = makeGround();
const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
console.log("=== HARNESS SANITY (are all three channels live?) ===");
console.log(`   DECK_CONTACT_POINTS : ${car.DECK_CONTACT_POINTS?.length ?? "MISSING"}`);
console.log(`   hull samples        : ${car._hullSamples?.length ?? car.HULL_SAMPLES?.length ?? "?"}`);
console.log(`   tires               : ${car.tires?.length}`);
console.log(`   CHASSIS mass        : ${CHASSIS.mass} kg   (1 g = ${(CHASSIS.mass * GRAVITY / 1000).toFixed(1)} kN)\n`);

/** Wrap the three force sinks so every push is attributed. */
function instrument(c) {
  const tally = { deck: new THREE.Vector3(), solid: new THREE.Vector3(), susp: new THREE.Vector3() };
  let phase = "susp";
  const origAddF = c.body.addForceAtPoint.bind(c.body);
  const origAddImp = c.body.applyImpulseAtPoint?.bind(c.body);
  c.body.addForceAtPoint = (f, p) => { tally[phase].add(f); return origAddF(f, p); };
  if (origAddImp) c.body.applyImpulseAtPoint = (j, p) => { tally[phase].addScaledVector(j, 1 / FIXED_DT); return origAddImp(j, p); };

  const wrap = (name, ph) => {
    const orig = c[name]?.bind(c);
    if (!orig) return;
    c[name] = (...a) => { const was = phase; phase = ph; try { return orig(...a); } finally { phase = was; } };
  };
  wrap("_applyDeckContact", "deck");
  wrap("_resolveSolids", "solid");
  return {
    tally,
    reset() { tally.deck.set(0, 0, 0); tally.solid.set(0, 0, 0); tally.susp.set(0, 0, 0); },
  };
}

function drive(speed) {
  const c = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  c.groundBvh = ground.ground; c.solidsBvh = ground.solids;
  c.getFloorY = () => -1e4; c.enabled = true;
  c.body.pos.set(0, WHEEL.radius + 0.18, 30);
  c.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  c.body.vel.set(0, 0, -speed);
  const inst = instrument(c);

  const rows = [];
  let prevVy = 0;
  for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
    inst.reset();
    c.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
    const p = c.body.pos, v = c.body.vel;
    if (p.z < -L + 7 && p.z > -L - 6) {
      rows.push({
        z: p.z, y: p.y, vy: v.y, dvy: v.y - prevVy, g: c.groundedCount,
        deck: inst.tally.deck.clone(), solid: inst.tally.solid.clone(), susp: inst.tally.susp.clone(),
      });
    }
    prevVy = v.y;
    if (p.z < -L - 8) break;
  }
  return rows;
}

for (const speed of [20, 28]) {
  console.log(`=== FORCE ATTRIBUTION THROUGH THE LIP — entry ${speed} m/s (kN, y-component) ===`);
  console.log("       z      y     Vy    ΔVy   gr |  suspY    deckY   solidY  |  deck|F|  solid|F|");
  for (const r of drive(speed)) {
    const k = (v) => (v / 1000).toFixed(1).padStart(7);
    const flag = Math.abs(r.deck.y) > 5000 || Math.abs(r.solid.y) > 5000 ? "  <== SPIKE" : "";
    console.log(
      `  ${r.z.toFixed(2).padStart(7)} ${r.y.toFixed(2).padStart(6)} ${r.vy.toFixed(2).padStart(6)}` +
      ` ${r.dvy.toFixed(2).padStart(6)} ${String(r.g).padStart(4)} |${k(r.susp.y)} ${k(r.deck.y)} ${k(r.solid.y)}` +
      `  | ${(r.deck.length() / 1000).toFixed(1).padStart(7)} ${(r.solid.length() / 1000).toFixed(1).padStart(8)}${flag}`,
    );
  }
  console.log("");
}
