// DOES THE PARK PIPE DROP THE CAR BACK ONTO THE WALL IT LEFT?
//
// That is the whole question, and the FIRST version of this test could not ask
// it. It measured "did the car stay in the pipe", which a car flung clean across
// to the far wall passes — so a 200° half tube shipped, and came straight back:
// "the car falls back at the centre of the pipe, it should fall on the slope
// like the park bowl does." Right, and for the reason a rider who lands in the
// flat breaks their legs: the flat takes the whole drop, the transition doesn't.
//
// So the metric here is the SIGNED launch x against the SIGNED landing x. Same
// sign and similar magnitude = came down on the wall it left. Opposite sign =
// crossed the pipe. Absolute values cannot see the difference, and on a curled
// rim neither can |x| alone, because near the top the wall bends back inward so
// a low landing and a high one sit at the same x. Both are checked.
//
// WHY A VERT, not an arc. On a bare arc the only vertical point is the very top,
// so where you leave decides where you go:
//
//   span < 180°   you leave before vertical, still moving OUTWARD -> over the deck
//   span = 180°   vertical for an instant; the right answer but a knife edge
//   span > 180°   the rim has curled over, you leave moving INWARD -> across the pipe
//
// MEASURED on a 26 m pipe, launch x -> landing x:
//
//     200° half tube    +25.4 -> -21.4    crossed to the far wall
//     vert half-pipe    -31.1 -> -30.6    same wall, just under the lip
//
// A vert is the wall carrying on straight up above the transition, so sideways
// velocity is zero for the whole last stretch and the car leaves going STRAIGHT
// UP. It is also what turns the knife edge into a section with margin: anywhere
// in the vert gives the same launch.
//
// THE VERT HEIGHT IS THE AIR-TIME CONTROL. The car arrives with a fixed amount
// of climb in it — it apexes at 47–52 m however the pipe is built — and the
// flight only starts at the lip, so raising the lip eats the difference.
// MEASURED at Rt=26, apex over the lip / air:
//
//     vert  4   +17.7 to +21.4 m   4.2–4.7 s
//     vert 12    +9.8 to +13.4 m   2.7–4.0 s
//     vert 17    +4.3 to  +9.3 m   1.4–2.4 s    <- the preset
//     vert 20    +3.8 to  +5.4 m   1.2–1.7 s, but 28 m/s cannot reach the lip
//
// Run: node tools/parkPipeTest.mjs
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.pp.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { Vehicle, FIXED_DT } = await import(pathToFileURL(TMP).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);
const { buildPiece, pieceParams, buildOpenLipCollision } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { CATEGORY_PRESETS } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadBuilder.js")).href);
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

let failed = 0;
const check = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? "  ok   " : "  FAIL "}${msg}`); };

const mkBvh = (gs) => {
  const b = new RoadBvh();
  b.bakeFromMeshes(gs.map((geo) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    m.updateMatrixWorld(true); return m;
  }));
  return b.baked ? b : null;
};

/**
 * Ride the pipe and carve into one wall.
 *
 * The steering is a PULSE, not a hold — turn into the wall, then let the
 * transition stand the car up and bring it back, which is how a pipe is ridden.
 * Holding lock all the way up is a wall-ride: it keeps feeding the speed down
 * the pipe into the climb, and that is the input that fires the car out.
 *
 * `span` switches to the plain half tube so the failing shape can be asserted
 * against the shipping one.
 */
function ride({ Rt, flat = 0, vert = 0, span = 0, len = 200, speed, steer }) {
  const pp = { ...pieceParams, tubeRadius: Rt, tubeWall: 0.6,
    halfPipeFlat: flat, halfPipeVert: vert, halfTubeSpan: span || 180,
    straightLength: len };
  const pieceId = span ? "half_tube" : "half_pipe";
  let conn = new THREE.Matrix4();
  const deck = [], rails = [];
  for (let k = 0; k < 3; k++) {
    const p = buildPiece(pieceId, conn, pp);
    for (const g of [p.geometry, p.shellGeometry]) {
      if (!g) continue;
      // The rim caps render but are not road — bake what the game bakes.
      const c = (buildOpenLipCollision(g) ?? g).clone();
      c.applyMatrix4(p.world); deck.push(c);
    }
    if (p.railGeometry) { const r = p.railGeometry.clone(); r.applyMatrix4(p.world); rails.push(r); }
    conn = p.connectorOut;
  }
  // Well below the pipe floor, so "fell out" is unambiguous.
  const floor = new THREE.PlaneGeometry(1200, 1600);
  floor.rotateX(-Math.PI / 2); floor.translate(0, -80, -500);
  deck.push(floor);

  const lipX = span ? Rt * Math.abs(Math.sin((Math.PI * span) / 360)) : flat / 2 + Rt;
  const lipY = span ? Rt * (1 - Math.cos((Math.PI * span) / 360)) : Rt + vert;

  const car = new Vehicle({ scene: new THREE.Scene(), showArrows: false });
  car.setBvh(mkBvh(deck), mkBvh(rails));
  car.getFloorY = () => -300;
  car.enabled = true;
  car.body.pos.set(0, 0.65, -6);
  car.body.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  car.body.vel.set(0, 0, -Math.min(speed, 40));
  car._resetInterpolation();

  let air = false, tAir = 0, bestAir = 0, apex = -Infinity;
  let launchX = null, landX = null, landY = null, escaped = false;
  for (let i = 0; i < Math.round(12 / FIXED_DT); i++) {
    const t = i * FIXED_DT;
    const sp = car.body.vel.length();
    car.tick({ steerTarget: t > 0.5 && t < 1.4 ? steer : 0,
      throttle: sp < speed ? 1 : 0, handbrake: false, yaw: 0, pitch: 0 });
    car.syncVisuals(FIXED_DT, 1);
    const grounded = car.tires.some((tt) => tt.grounded);
    if (!grounded) {
      if (!air) { air = true; tAir = 0; launchX = car.body.pos.x; }
      tAir += FIXED_DT;
      apex = Math.max(apex, car.body.pos.y);
      if (tAir > bestAir) bestAir = tAir;
    } else if (air) {
      air = false;
      // A real hop off the lip, not a wheel skipping across the flat.
      if (tAir > 0.35 && landX === null && apex > lipY - 2) {
        landX = car.body.pos.x; landY = car.body.pos.y;
      }
    }
    // Stop AT the landing: past it the car simply drives on and would eventually
    // run off the end of a finite test pipe, which is not an escape.
    if (landX !== null) break;
    if (car.body.pos.y < -3 || Math.abs(car.body.pos.x) > lipX + 12) { escaped = true; break; }
  }
  return {
    lipX, lipY, launchX, landX, landY, escaped, bestAir,
    over: apex === -Infinity ? null : apex - lipY,
    // The two things that make it a pipe hit rather than a crash landing.
    sameWall: launchX !== null && landX !== null && launchX * landX > 0,
    // How far up the wall it came down, 1.0 = at the lip height.
    highOnWall: landY === null ? null : landY / lipY,
  };
}

const BAND = [40, 34, 28];
const CARVE = [0.5, 0.7, 0.9];

console.log("\n═══ PARK PIPE — does the car drop back onto the wall it left? ═══");
console.log("  launch x -> land x: same sign = same wall; opposite = flung across\n");

for (const id of ["half_pipe_park", "half_pipe_park_long"]) {
  const preset = Object.values(CATEGORY_PRESETS).flat().find((p) => p.id === id);
  if (!preset) { check(false, `preset "${id}" is missing from the palette`); continue; }
  const cfg = { Rt: preset.params.tubeRadius, flat: preset.params.halfPipeFlat,
    vert: preset.params.halfPipeVert, len: preset.params.straightLength };
  check(cfg.vert > 0,
    `"${preset.label}" has a VERT — without one the lip is a single vertical point and the
         car gets thrown across the pipe (that is the bug this piece exists to fix)`);
  const rows = [];
  for (const speed of BAND) for (const steer of CARVE) rows.push({ speed, steer, r: ride({ ...cfg, speed, steer }) });

  console.log(`  ${preset.label}  Rt=${cfg.Rt} flat=${cfg.flat} vert=${cfg.vert}  (lip y ${cfg.Rt + cfg.vert})`);
  for (const speed of BAND) {
    console.log(`      ${String(speed).padStart(2)} m/s  ` + rows.filter((x) => x.speed === speed).map(({ steer, r }) =>
      `${steer.toFixed(1)}: ${r.landX === null ? "  no landing " : `${r.launchX.toFixed(0).padStart(3)}->${r.landX.toFixed(0).padStart(4)}`}` +
      ` ${r.over === null ? "" : `+${r.over.toFixed(0)}m/${r.bestAir.toFixed(1)}s`}${r.escaped ? " OUT" : ""}`).join("   "));
  }

  const label = ({ speed, steer }) => `${speed} m/s @ ${steer}`;
  const crossed = rows.filter(({ r }) => r.landX !== null && !r.sameWall).map(label);
  check(crossed.length === 0,
    `"${preset.label}" lands on the wall it LEFT, never flung across into the flat
         ${crossed.length ? `— CROSSED at ${crossed.join(", ")}` : ""}`);

  const low = rows.filter(({ r }) => r.highOnWall !== null && r.highOnWall < 0.45).map(label);
  check(low.length === 0,
    `"${preset.label}" comes down HIGH on the transition, near the lip, not down in the
         bottom${low.length ? ` — landed low at ${low.join(", ")}` : ""}`);

  // ESCAPES FIRST, and separately — because the two checks above only inspect
  // runs that LANDED (`landX !== null`), so a run that leaves the pipe entirely
  // passes both of them vacuously. On the short Park Pipe most of the 34–40 m/s
  // grid now flies out, and the only thing that used to catch it was the airtime
  // bound reporting "hung too long" — which reads as a tuning threshold and
  // invites exactly the re-baselining that would have hidden it.
  const out = rows.filter(({ r }) => r.escaped || r.landX === null).map(label);
  check(out.length === 0,
    `"${preset.label}" keeps the car IN the pipe at every speed on the grid${
      out.length ? ` — left the pipe at ${out.join(", ")}` : ""}`);

  // Then the hang time, on the runs that stayed in. Comparative by intent — a
  // pipe pops you short where the bowl floats you — so it is bounded against
  // the bowl's 5 s rather than frozen at the 3.0 s one tune measured.
  const BOWL_AIR = 5.0;
  const CAP = 0.8 * BOWL_AIR;
  const long = rows.filter(({ r }) => !r.escaped && r.landX !== null && r.bestAir > CAP).map(label);
  check(long.length === 0,
    `"${preset.label}" pops SHORT — comfortably under the park bowl's ${BOWL_AIR} s
         (cap ${CAP} s)${long.length ? `, ${long.join(", ")} hung too long` : ""}`);
}

// The failing shape, asserted over the SAME grid rather than one sample. A 200°
// half tube is the intuitive "pipe" and it is what shipped first — but it does
// not throw the car across on every input, only on some, so a single run of it
// is a coin flip that would make this check flap. Counting bad landings across
// the grid is the stable comparison, and it is also the honest claim: the curled
// rim is unreliable, the vert is not.
console.log("");
{
  const bad = [];
  for (const speed of BAND) for (const steer of CARVE) {
    const r = ride({ Rt: 26, span: 200, speed, steer });
    if (r.landX === null || !r.sameWall || (r.highOnWall ?? 1) < 0.45) {
      bad.push(`${speed}@${steer}${r.landX !== null && !r.sameWall ? " crossed" : r.landX === null ? " no landing" : " landed low"}`);
    }
  }
  const total = BAND.length * CARVE.length;
  check(bad.length > 0,
    `a 200° half tube does NOT hold the line — ${bad.length} of ${total} runs came down across the
         pipe or low in the bottom (${bad.join("; ")}). Its rim curls back over the
         rider, so you leave the lip moving INWARD. That is the landing reported as
         "falls in the centre", and the vert pipe above takes the same grid clean`);
}
{
  // And the other half of the same coin: no vert at all on the new profile.
  const bare = ride({ Rt: 26, flat: 12, vert: 0, speed: 40, steer: 0.8 });
  check(bare.landX === null || bare.escaped || (bare.over ?? 0) > 15,
    `and the same pipe with NO vert does not hold the line either (${bare.escaped ? "escaped"
      : bare.landX === null ? "never popped the lip" : `+${bare.over.toFixed(0)} m over the lip`}) — the
         vert is the piece of it that matters, not just the flat bottom`);
}

console.log(`\n${failed ? `FAIL — ${failed} check(s)` : "all checks green"}\n`);
process.exit(failed ? 1 : 0);
