// Hole walls — the straight menu's Hole Road stood up, as two obstacle props.
//
// Both are one claim: MISS the port and the plate stops you, HIT it and nothing
// touches the car. That claim is geometry, and geometry is exactly what nobody
// re-checks after nudging a number — bump the drive-through wall's `centerY` up
// by a metre and its port silently grows a wheel-height ledge across the mouth,
// which looks fine in a screenshot and is unplayable.
//
// The two walls differ in ONE field, `mouthY`, and each has its own failure:
//
//   Hole wall      chord, so the port opens at the deck. A centred full circle
//                  (the deck piece's own hole, merely rotated) is the bug: the
//                  "opening" would start above the car. Tested by driving a
//                  car-sized box through the middle at deck level.
//   Hole gate air  full circle, lifted out of reach, so the only way in is a
//                  jump. Its failure is the opposite — a port that has quietly
//                  drifted down to where you could drive into it, or a plate
//                  that has grown down and blocked the road underneath. Tested
//                  at BOTH heights: clear on the ground, solid except the ring
//                  at port height.
//
// The third section is about LOOKS, and it is here because the flicker it
// guards is invisible in every still image: each trim piece was first authored
// flush with the plate, which is a pair of exactly coplanar faces and therefore
// a z-fight that crawls as the camera moves. Coincidence is a property of the
// numbers, so it can be asserted — see the coplanar-face sweep at the end.
//
// modularRoadProps.js can't be imported here (TransformControls + TSL need a
// DOM/GPU), so the shape maths is transcribed and the constants are read back
// out of the source — a transcription that has drifted fails on them first.
import * as THREE from "three";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

/* ── Constants, read from the source so the test tracks the real props ────── */
function readConfig(name) {
  const block = SRC.match(new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\};`))?.[1] ?? "";
  const cfg = {};
  for (const [, key, val] of block.matchAll(/\n\s*(\w+):\s*(-?[\d.]+|null|true|false)/g)) {
    cfg[key] = val === "null" ? null : val === "true" ? true : val === "false" ? false : Number(val);
  }
  return cfg;
}
const local = (name) => Number(SRC.match(new RegExp(`\\n\\s*const ${name} = ([\\d.]+);`))?.[1]);
const GROUND = readConfig("HOLE_WALL");
const AIR = readConfig("HOLE_WALL_AIR");
const BITE = local("BITE"); // clearance between parts that would otherwise be flush
const SINK = local("SINK"); // how far trim sinks below the deck / into the port

const KEYS = ["width", "bottom", "top", "depth", "radius", "centerY", "rim"];
check("HOLE_WALL constants parsed out of the source",
  KEYS.every((k) => Number.isFinite(GROUND[k])) && GROUND.mouthY < 0, JSON.stringify(GROUND));
check("HOLE_WALL_AIR constants parsed out of the source",
  KEYS.every((k) => Number.isFinite(AIR[k])) && AIR.mouthY === null, JSON.stringify(AIR));
check("anti-coincidence offsets parsed out of the source",
  Number.isFinite(BITE) && Number.isFinite(SINK), `BITE ${BITE} m, SINK ${SINK} m`);

/* ── Transcription of holeWallPort + the parts ────────────────────────────── */
function holeWallPort(target, cfg, R, bottomY) {
  const cy = cfg.centerY;
  if (bottomY == null) {
    target.absarc(0, cy, R, 0, Math.PI * 2, false);
    return target;
  }
  const s = THREE.MathUtils.clamp((bottomY - cy) / R, -1, 1);
  const a0 = Math.asin(s);
  target.absarc(0, cy, R, a0, Math.PI - a0, false);
  target.lineTo(Math.cos(a0) * R, cy + Math.sin(a0) * R);
  target.closePath();
  return target;
}

function extrude(shape, depth) {
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 48 });
  geo.translate(0, 0, -depth / 2);
  return geo;
}

/** The plate: rectangle minus the port. */
function plateOf(cfg) {
  const hw = cfg.width / 2;
  const outline = new THREE.Shape();
  outline.moveTo(-hw, cfg.bottom);
  outline.lineTo(hw, cfg.bottom);
  outline.lineTo(hw, cfg.top);
  outline.lineTo(-hw, cfg.top);
  outline.closePath();
  outline.holes.push(holeWallPort(new THREE.Path(), cfg, cfg.radius, cfg.mouthY));
  return extrude(outline, cfg.depth);
}

/** The rim band — inner edge BITES INTO the port by SINK, see the source. */
function rimOf(cfg) {
  const shape = holeWallPort(new THREE.Shape(), cfg, cfg.radius + cfg.rim,
    cfg.mouthY == null ? null : cfg.mouthY - cfg.rim);
  shape.holes.push(holeWallPort(new THREE.Path(), cfg, cfg.radius - SINK, cfg.mouthY));
  return extrude(shape, cfg.depth + 0.24);
}

/** Every box part, as named world-space AABBs — what the coplanar sweep reads. */
function boxPartsOf(cfg) {
  const hw = cfg.width / 2;
  const { depth: D, bottom: B, top: T } = cfg;
  const box = (name, cx, cy, cz, sx, sy, sz) => ({
    name,
    box: new THREE.Box3(
      new THREE.Vector3(cx - sx / 2, cy - sy / 2, cz - sz / 2),
      new THREE.Vector3(cx + sx / 2, cy + sy / 2, cz + sz / 2),
    ),
  });
  const parts = [
    // The plate's OUTER boundary is exactly its bounding box (the port is a hole
    // in the middle, so it never touches an outer face).
    box("plate", 0, (T + B) / 2, 0, cfg.width, T - B, D),
    box("column+", hw - 0.3 - BITE, (T + B) / 2, 0, 0.6, T - B - 2 * BITE, D + 0.16),
    box("column-", -(hw - 0.3 - BITE), (T + B) / 2, 0, 0.6, T - B - 2 * BITE, D + 0.16),
    box("beamTop", 0, T + (BITE - 0.25), 0, cfg.width + 2 * BITE, 0.5, D + 0.34),
  ];
  if (cfg.mouthY == null) {
    parts.push(box("beamBottom", 0, B - (BITE - 0.25), 0, cfg.width + 2 * BITE, 0.5, D + 0.34));
  }
  return parts;
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const finite = (geo) => {
  const p = geo.getAttribute("position").array;
  for (let i = 0; i < p.length; i++) if (!Number.isFinite(p[i])) return false;
  return p.length > 0;
};
const triCount = (geo) => (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3;

/** Does any triangle of any `geos` touch `box`? The car-vs-wall question. */
function boxHits(geos, box) {
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const tri = new THREE.Triangle();
  for (const geo of [geos].flat()) {
    const p = geo.getAttribute("position");
    const idx = geo.index;
    const n = idx ? idx.count : p.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(p, i0); b.fromBufferAttribute(p, i1); c.fromBufferAttribute(p, i2);
      if (box.intersectsTriangle(tri.set(a, b, c))) return true;
    }
  }
  return false;
}

/** The car's swept box: 2.0 m wide, 1.4 m tall, straddling the plate in Z.
 *  `yBottom` is where its floor is — 1 mm for driving, port height for flying. */
const carBox = (cx, yBottom) => new THREE.Box3(
  new THREE.Vector3(cx - 1.0, yBottom, -3),
  new THREE.Vector3(cx + 1.0, yBottom + 1.4, 3),
);
const HALF_CAR = 1.0;

/** Half-width of the port at height y, as the CAR meets it — i.e. the rim's
 *  inner edge, which bites SINK into the plate's own circle. 0 outside it. */
const portHalfAt = (cfg, y) => {
  const R = cfg.radius - SINK;
  const d = Math.abs(y - cfg.centerY);
  return d <= R ? Math.sqrt(R * R - d * d) : 0;
};

/** Lowest centre line at which the car's flank leaves the port and hits metal. */
function firstBlockedX(geos, yBottom) {
  for (let cx = 0; cx <= 20; cx += 0.1) if (boxHits(geos, carBox(cx, yBottom))) return cx;
  return null;
}

/* ══ Hole wall — drive through it ═════════════════════════════════════════ */
console.log("\n— Hole wall (drive through) —");
const gPlate = plateOf(GROUND);
const gRim = rimOf(GROUND);
const gWall = [gPlate, gRim]; // what the car actually meets
check("plate extrudes to finite geometry", finite(gPlate), `${triCount(gPlate)} tris`);
check("rim extrudes to finite geometry", finite(gRim), `${triCount(gRim)} tris`);

gPlate.computeBoundingBox();
const gb = gPlate.boundingBox;
check("plate is VERTICAL by default (tall in Y, thin in Z)",
  gb.max.y - gb.min.y > 10 && Math.abs(gb.max.z - gb.min.z - GROUND.depth) < 1e-3,
  `${(gb.max.y - gb.min.y).toFixed(2)} m tall, ${(gb.max.z - gb.min.z).toFixed(2)} m thick`);
check("plate spans a default 16 m road", gb.max.x - gb.min.x >= 16,
  `${(gb.max.x - gb.min.x).toFixed(1)} m wide`);
check("plate skirt is buried in the 0.8 m road slab",
  GROUND.bottom < 0 && GROUND.bottom > -0.8, `bottom at ${GROUND.bottom} m`);

// This is the test. Anything blocked here means the "hole" is a wall.
check("port is clear straight down the middle", !boxHits(gWall, carBox(0, 0.001)));
check("port is clear off-centre (±3 m)",
  !boxHits(gWall, carBox(3, 0.001)) && !boxHits(gWall, carBox(-3, 0.001)));

const mouthHalf = portHalfAt(GROUND, 0);
check("mouth is wide enough to aim at, not a slot", mouthHalf * 2 > 6,
  `${(mouthHalf * 2).toFixed(2)} m of clearance at deck level`);
check("the circle is CLIPPED, not centred (no ledge under the port)",
  GROUND.centerY < GROUND.radius && GROUND.mouthY < 0,
  `centreY ${GROUND.centerY} < radius ${GROUND.radius}, chord at ${GROUND.mouthY} m`);
check("mouth chord sits below the deck, so no face is coplanar with the road",
  GROUND.mouthY < 0 && GROUND.mouthY > -0.25, `${GROUND.mouthY} m`);

check("wall blocks the car outside the port",
  boxHits(gWall, carBox(GROUND.width / 2 - 2, 0.001)) &&
  boxHits(gWall, carBox(-(GROUND.width / 2 - 2), 0.001)));
// The car is blocked as soon as its OUTER FLANK passes the port edge, so the
// last clear centre line is (port half-width − half a car), not the port edge.
// The mouth is the narrowest part of the port — it widens with height — so this
// is the deck-level chord that decides it.
const gFirst = firstBlockedX(gWall, 0.001);
check("blocking starts exactly where the car's flank leaves the port",
  gFirst !== null && Math.abs(gFirst - (mouthHalf - HALF_CAR)) < 0.25,
  `first blocked at x=${gFirst?.toFixed(1)} m (port edge ${mouthHalf.toFixed(2)} − half a car)`);

/* ══ Hole gate (air) — jump into it ═══════════════════════════════════════ */
console.log("\n— Hole gate (air) —");
const aPlate = plateOf(AIR);
const aRim = rimOf(AIR);
const aWall = [aPlate, aRim];
check("plate extrudes to finite geometry", finite(aPlate), `${triCount(aPlate)} tris`);
check("rim extrudes to finite geometry", finite(aRim), `${triCount(aRim)} tris`);

aPlate.computeBoundingBox();
const ab = aPlate.boundingBox;
check("gate is VERTICAL by default (tall in Y, thin in Z)",
  ab.max.y - ab.min.y > 10 && Math.abs(ab.max.z - ab.min.z - AIR.depth) < 1e-3,
  `${(ab.max.y - ab.min.y).toFixed(2)} m tall, ${(ab.max.z - ab.min.z).toFixed(2)} m thick`);

// The port is a FULL circle — the whole point of the second prop.
check("port is a full circle (no chord cutting it open)", AIR.mouthY === null);
check("port is clear of the deck by a jump, not a kerb",
  AIR.centerY - AIR.radius > 3,
  `ring floor ${(AIR.centerY - AIR.radius).toFixed(1)} m up`);
check("plate floats: you can drive underneath it", AIR.bottom > 1.4 + 0.5,
  `bottom edge ${AIR.bottom} m up`);
check("nothing of the gate is in the road at deck level",
  !boxHits(aWall, carBox(0, 0.001)) && !boxHits(aWall, carBox(AIR.width / 2 - 1, 0.001)),
  "driving under touches nothing");

// At port height it is a wall with exactly one way through.
const flyY = AIR.centerY - 0.7; // car centred on the ring
check("a car flying at ring height threads the middle", !boxHits(aWall, carBox(0, flyY)));
check("a car flying at ring height is stopped either side of the ring",
  boxHits(aWall, carBox(AIR.width / 2 - 1.5, flyY)) && boxHits(aWall, carBox(-(AIR.width / 2 - 1.5), flyY)));
const aFirst = firstBlockedX(aWall, flyY);
const flyHalf = Math.min(portHalfAt(AIR, flyY), portHalfAt(AIR, flyY + 1.4));
check("blocking starts exactly where the car's flank leaves the ring",
  aFirst !== null && Math.abs(aFirst - (flyHalf - HALF_CAR)) < 0.3,
  `first blocked at x=${aFirst?.toFixed(1)} m (ring edge ${flyHalf.toFixed(2)} − half a car)`);
check("a car flying UNDER the ring hits the plate rather than sailing through",
  boxHits(aWall, carBox(0, AIR.bottom + 0.5)),
  "miss low and you are stopped");

/* ══ No coincident surfaces — the flicker guard ═══════════════════════════ */
//
// Two faces on the SAME plane FACING THE SAME WAY are a z-fight: the depth
// buffer cannot order them and the winner changes with the camera. Faces that
// merely touch back-to-back (one part's +X against another's −X) are fine —
// only one of the pair is ever front-facing — so the sweep compares min-to-min
// and max-to-max only, and only when the other two axes actually overlap.
console.log("\n— no coincident surfaces —");
const EPS = 1e-4;
const AXES = ["x", "y", "z"];
function coincidences(parts) {
  const hits = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const A = parts[i].box, Bx = parts[j].box;
      for (const ax of AXES) {
        const others = AXES.filter((o) => o !== ax);
        const overlaps = others.every((o) =>
          Math.min(A.max[o], Bx.max[o]) - Math.max(A.min[o], Bx.min[o]) > EPS);
        if (!overlaps) continue;
        for (const end of ["min", "max"]) {
          if (Math.abs(A[end][ax] - Bx[end][ax]) < EPS) {
            hits.push(`${parts[i].name}/${parts[j].name} share ${end}.${ax}=${A[end][ax].toFixed(3)}`);
          }
        }
      }
    }
  }
  return hits;
}
for (const [label, cfg] of [["Hole wall", GROUND], ["Hole gate (air)", AIR]]) {
  const parts = boxPartsOf(cfg);
  const hits = coincidences(parts);
  check(`${label}: no two parts share a face plane`, hits.length === 0,
    hits.length ? hits.join("; ") : `${parts.length} parts checked`);
  // The road is a surface too, and the one the car is pressed against.
  const onDeck = parts.filter((p) => Math.abs(p.box.min.y) < EPS || Math.abs(p.box.max.y) < EPS);
  check(`${label}: nothing rests exactly on the deck plane`, onDeck.length === 0,
    onDeck.map((p) => p.name).join(", ") || "all parts clear y=0");
}
// The rim and the plate share the port CURVE, which no bounding box can see.
check("rim bites into the port instead of sitting on it", SINK > 0,
  `rim inner radius is ${SINK} m under the plate's own port`);

/* ══ Catalog wiring ═══════════════════════════════════════════════════════ */
console.log("\n— catalog —");
for (const [id, label] of [["holewall", "Hole wall"], ["holewall_air", "Hole gate (air)"]]) {
  const entry = SRC.match(new RegExp(`\\{[^{}]*id: "${id}"[\\s\\S]*?\\n  \\},`))?.[0] ?? "";
  check(`"${id}" is in PROP_CATALOG, so it saves/loads like any prop`, entry.length > 0, label);
  check(`"${id}" bakes into the SOLID BVH (miss it and you are stopped)`,
    /collision: "solid"/.test(entry));
  check(`"${id}" lands on the Obstacles tab (no explicit category = obstacles)`,
    entry.length > 0 && !/category:/.test(entry));
}

console.log(fail === 0 ? "\nAll hole-wall checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
