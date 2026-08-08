// Where the guardrail's triangles actually go, and what a shipping budget costs.
//
//   node tools/railBudget.mjs
import * as THREE from "three";
import { buildPiece, roadParams, pieceParams, guardrailParams } from "../games/modular-road-v3/modularRoadKit.js";
import * as lab from "../games/modular-road-v3/modularRoadRail.js";

/** Hero settings — what the lab shipped with before any budget existed. */
const HERO = {
  mirrorSides: true, flipW: false, style: 2,
  height: 0.8, depth: 0.26, gap: 0.18, valleyGap: 0.3, backAmp: 0.35, plateau: 0.22,
  bendRadius: 0.05, bendSeg: 4, beadSeg: 10,
  frameStep: 0, frameAngle: 0, // 0 = no decimation
  posts: true, postShape: "ibeam", postSpacing: 2.8, postWidth: 0.15, postDepth: 0.17,
  flangeT: 0.022, webT: 0.018, postRise: 0.06, blockout: 0.11,
  basePlate: true, bolts: true, boltRadius: 0.034, bevel: 0.006,
};
const SHIP = {
  ...HERO, bendSeg: 2, beadSeg: 6, frameStep: 4.0, frameAngle: 7,
  postShape: "slab", postSpacing: 3.6,
};
const BASE = SHIP;
const tris = (g) => (g ? Math.round((g.index ? g.index.count : g.attributes.position.count) / 3) : 0);

const pp = { ...pieceParams, straightLength: 32 };
const built = buildPiece("straight", new THREE.Matrix4(), pp, roadParams, guardrailParams, true);
const frames = built.frames;
// The old flat-sheet rail, which is now the COLLISION proxy — still the right
// baseline to compare rendering cost against.
const kit = tris(built.railCollision);
const PIECES = 80;

/** Split one config into beam-only and post-only triangle counts. */
function split(r) {
  const whole = lab.buildRailGeometry(frames, roadParams, r);
  const beamOnly = lab.buildRailGeometry(frames, roadParams, { ...r, posts: false });
  const total = tris(whole);
  const beam = tris(beamOnly);
  whole?.dispose();
  beamOnly?.dispose();
  // one post template, and how many get placed on this piece
  const prof = lab.railProfile({ ...r, humps: r.style, flip: r.flipW });
  const centerV = roadParams.railHeight + r.gap + r.height * 0.5;
  const tpl = r.posts ? lab.buildPostTemplate(prof, r, roadParams.railHeight, centerV) : null;
  const per = tris(tpl);
  tpl?.dispose();
  const count = per ? Math.round((total - beam) / per) : 0;
  return { total, beam, posts: total - beam, per, count };
}

const CONFIGS = [
  ["HERO (was the default)", HERO],
  ["  + coarse bends 2/6", { ...HERO, bendSeg: 2, beadSeg: 6 }],
  ["  + frame decimation", { ...HERO, bendSeg: 2, beadSeg: 6, frameStep: 4, frameAngle: 7 }],
  ["  + slab posts", { ...HERO, bendSeg: 2, beadSeg: 6, frameStep: 4, frameAngle: 7, postShape: "slab" }],
  ["SHIP (all of the above, 3.6 m)", SHIP],
  ["  − bolts, − base plate", { ...SHIP, bolts: false, basePlate: false }],
];

console.log(`collision proxy (old kit rail): ${kit} tris/piece → ${(kit * PIECES).toLocaleString()} over ${PIECES} pieces`);
console.log("config                          total    beam   posts  (per post × n)   80-piece track");
for (const [name, r] of CONFIGS) {
  const s = split(r);
  console.log(
    `${name.padEnd(30)} ${String(s.total).padStart(6)} ${String(s.beam).padStart(7)} ` +
    `${String(s.posts).padStart(7)}  (${s.per} × ${s.count})`.padEnd(18) +
    `  ${(s.total * PIECES).toLocaleString().padStart(10)}`,
  );
}

// What instancing the posts would actually save, in GEOMETRY (not draws).
const s = split(BASE);
console.log(`\nIf posts were one InstancedMesh for the whole track:`);
console.log(`  geometry uploaded : ${s.per.toLocaleString()} tris once, not ${(s.posts * PIECES).toLocaleString()}`);
console.log(`  → ${((1 - s.per / (s.posts * PIECES)) * 100).toFixed(1)}% less post geometry in memory and in the BVH`);
console.log(`  vertices SHADED per frame are unchanged (${(s.posts * PIECES).toLocaleString()} tris still rasterise)`);
