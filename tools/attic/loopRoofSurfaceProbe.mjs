// ============================================================================
// WHAT ARMS THE ROOF GUARD AT THE TOP OF A LOOP?
//
// ROOF.suspensionGuard is shipped OFF, and its own doc block says why: it fixes
// inverted landings but "also arms at the TOP OF A LOOP — measured at y 48–49.7,
// car inverted, against a surface whose normal points UP (n.y 1.00) within 5 cm
// of a roof sample. WHICH SURFACE THAT IS HAS NOT BEEN IDENTIFIED."
//
// That unidentified surface is the whole blocker. If it can be named it can be
// discriminated, the guard can be turned on, and the inverted-landing launcher
// (tools/attic/invertedLaunchProbe.mjs) stops being unfixable.
//
// So: drive a real loop, and at every substep where the arming condition is
// true, dump the corner, the surface point, its normal, and where that point
// sits relative to the loop's own geometry.
//
// Run:  node tools/attic/loopRoofSurfaceProbe.mjs
// ============================================================================
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = join(ROOT, `.loopRoofProbe.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT, ROOF, DECK } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece } = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
unlinkSync(TMP);

Vehicle.prototype._buildMeshes = function () {
  this.group = new THREE.Group(); this.chassisMesh = new THREE.Object3D();
  this.tireGroups = [0, 0, 0, 0].map(() => new THREE.Group());
  this.arrowGroup = new THREE.Group(); this.arrowGroup.visible = false;
  this.arrows = [0, 0, 0, 0].map(() => ({})); this.wheelSpin = [0, 0, 0, 0];
  this.headlights = []; this.headlightTargets = []; this.headlamps = []; this.taillights = [];
  this._wheelInstances = []; this._wheelParts = [];
};
Vehicle.prototype._updateTaillights = function () {};

// ── Track: straight run-up, then one loop. Deck only; rails are irrelevant. ──
let conn = new THREE.Matrix4();
const deckGeos = [];
const named = []; // {name, box} so a surface point can be attributed to a piece
const push = (p, name) => {
  for (const g of [p.geometry, p.shellGeometry]) {
    if (!g) continue;
    const c = g.clone(); c.applyMatrix4(p.world);
    c.computeBoundingBox();
    deckGeos.push(c);
    named.push({ name, box: c.boundingBox.clone(), geo: c });
  }
};
for (let i = 0; i < 8; i++) { const p = buildPiece("straight", conn); push(p, `straight${i}`); conn = p.connectorOut; }
const loopPiece = buildPiece("loop", conn);
push(loopPiece, "LOOP");

const deck = new RoadBvh();
const meshes = deckGeos.map((g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
for (const m of meshes) m.updateMatrixWorld(true);
deck.bakeFromMeshes(meshes);

const loopBox = named.find((n) => n.name === "LOOP").box;
console.log(`loop bounds  y ${loopBox.min.y.toFixed(2)} .. ${loopBox.max.y.toFixed(2)}`);
console.log(`             x ${loopBox.min.x.toFixed(2)} .. ${loopBox.max.x.toFixed(2)}`);
console.log(`             z ${loopBox.min.z.toFixed(2)} .. ${loopBox.max.z.toFixed(2)}`);
console.log(`DECK.searchRadius ${DECK.searchRadius}  ROOF.dot ${ROOF.dot}  ROOF.guardUpMin ${ROOF.guardUpMin}\n`);

const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
car.setBvh(deck, null);
car.getFloorY = () => -50;
car.enabled = true;
car.body.pos.set(0, 0.6, 0);
car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); // nose down −Z
car.body.vel.set(0, 0, -55);

// Re-run the EXACT arming test from _applyDeckContact against every deck
// contact corner, reporting instead of acting.
const _w = new THREE.Vector3(), _n = new THREE.Vector3(), _up = new THREE.Vector3();
const hits = new Map();

function inspect(tick) {
  const body = car.body;
  _up.set(0, 1, 0).applyQuaternion(body.quat);
  if (_up.y > ROOF.dot) return; // only care while inverted
  car.DECK_CONTACT_POINTS.forEach((corner, idx) => {
    car._geomToWorld(corner, _w);
    const res = deck.closestPointWithNormal(_w.x, _w.y, _w.z, DECK.searchRadius, _n);
    if (!res) return;
    const sd = (_w.x - res.x) * _n.x + (_w.y - res.y) * _n.y + (_w.z - res.z) * _n.z;
    const opposesUp = _n.dot(_up) < ROOF.dot;
    const facesUpWorld = _n.y > ROOF.guardUpMin;
    if (!(opposesUp && facesUpWorld)) return;
    const key = `corner${idx}`;
    if (!hits.has(key)) {
      hits.set(key, {
        tick,
        corner: corner.clone(),
        cornerWorld: _w.clone(),
        surf: new THREE.Vector3(res.x, res.y, res.z),
        n: _n.clone(),
        sd,
        carY: body.pos.y,
        upY: _up.y,
        count: 0,
      });
    }
    hits.get(key).count++;
  });
}

for (let i = 0; i < Math.round(6 / FIXED_DT); i++) {
  car.tick({ steerTarget: 0, throttle: 1, handbrake: false, yaw: 0, pitch: 0 });
  inspect(i);
  if (car.body.pos.y < -10) break;
}

if (!hits.size) {
  console.log("The arming condition never became true. Nothing to identify.");
} else {
  console.log(`${hits.size} deck-contact corner(s) satisfied the arming test:\n`);
  for (const [key, h] of hits) {
    console.log(`${key}  (fired on ${h.count} substeps, first at tick ${h.tick})`);
    console.log(`  corner in chassis space   (${h.corner.x.toFixed(2)}, ${h.corner.y.toFixed(2)}, ${h.corner.z.toFixed(2)})`
      + `   ${h.corner.y > 0 ? "<- this is a ROOF sample" : "(underside sample)"}`);
    console.log(`  corner in world           (${h.cornerWorld.x.toFixed(2)}, ${h.cornerWorld.y.toFixed(2)}, ${h.cornerWorld.z.toFixed(2)})`);
    console.log(`  surface point found       (${h.surf.x.toFixed(2)}, ${h.surf.y.toFixed(2)}, ${h.surf.z.toFixed(2)})`);
    console.log(`  its normal                (${h.n.x.toFixed(2)}, ${h.n.y.toFixed(2)}, ${h.n.z.toFixed(2)})`);
    console.log(`  signed distance           ${h.sd.toFixed(3)} m      car y ${h.carY.toFixed(2)}  chassis-up.y ${h.upY.toFixed(2)}`);
    // Attribute the surface point to a piece.
    const owners = named.filter((nm) => {
      const b = nm.box.clone().expandByScalar(0.05);
      return b.containsPoint(h.surf);
    }).map((nm) => nm.name);
    console.log(`  lies inside the bounds of ${owners.length ? owners.join(", ") : "(no piece bbox!)"}`);
    const r = Math.hypot(h.surf.x - 0, h.surf.z - (loopBox.min.z + loopBox.max.z) / 2);
    console.log(`  loop-frame: y ${h.surf.y.toFixed(2)} of ${loopBox.max.y.toFixed(2)} top`
      + `,  horizontal offset from loop axis ${r.toFixed(2)} m\n`);
  }
}
