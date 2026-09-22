/**
 * THE ENEMY'S KIT — what the Front dug, not what it built. Everything here is
 * low, earthen and meant NOT to be seen, the opposite of the American kit's
 * sandbag walls and masts; it has to read from the RTS camera only once you
 * are looking for it.
 *
 *   · TUNNEL ENTRANCE — the Cu Chi trapdoor: a square shaft framed in timber,
 *     its lid (a board box with the jungle floor glued to it) propped open, a
 *     low ring of spoil, cut fronds laid over it. Where the Front's men come up
 *     behind you (enemyAI.js recruits at the most forward safe one).
 *   · MORTAR PIT — an 82 mm tube on its baseplate in a sandbagged pit, with
 *     its two-man crew. The one weapon here that shoots at GROUND it cannot
 *     see (enemyAI.js aims it; projectiles.spawnArc throws the shell).
 *   · ZPU-4 — the quad 14.5 mm anti-aircraft gun the helicopter crews feared
 *     most, dug into an earth pit on its four-wheel carriage. Three pieces, as
 *     the game draws it: the BODY (pit, carriage, ammunition — still), the
 *     MOUNT (turntable, gunner's seat and the gunner — turns) and the GUNS
 *     (four barrels, two over two — turn and elevate at the trunnions).
 *
 * Same contract as the rest of the kit: real size x 1.3, one merged geometry
 * on the atlas material, origin at the ground centre on y = 0,
 * `userData.footprint`.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, buildSandbagRing, rng } from "./rtsParts.js";

const S = 1.3;

export function buildTunnelEntrance({ seed = 7 } = {}) {
  const R = rng(seed);
  const parts = [];
  const hole = 0.8 * S;                     // the shaft's clear opening
  const frameW = 0.16 * S;
  // Spoil: a low ring of earth thrown up round the shaft, open on one side
  // (the side the lid falls to). Lathe profile runs OUTSIDE-IN so the faces
  // point up (the DShK nest's lesson: the other way round is culled from above).
  const rOut = 2.6 * S, rIn = hole * 0.75;
  const prof = [[rOut, 0], [rOut - 0.5 * S, 0.12 * S], [rIn + 0.5 * S, 0.34 * S], [rIn + 0.1, 0.3 * S], [rIn, 0.02]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  parts.push({ geo: new THREE.LatheGeometry(prof, 18), mat: MAT.earth, tone: 0.35 });
  // The shaft: a dark box sunk into the ground, its mouth just above the
  // spoil's inner lip, so the opening reads as a hole, not a black tile.
  parts.push({ geo: buildBox(hole, 0.5, hole), pos: [0, 0.3 * S - 0.25 + 0.012, 0], mat: MAT.steel, tone: 0.0 });
  // The frame: four timbers round the mouth, a little proud of the earth.
  const fy = 0.3 * S + 0.03;
  for (const [x, z, w, d] of [[0, (hole + frameW) / 2, hole + 2 * frameW, frameW], [0, -(hole + frameW) / 2, hole + 2 * frameW + 0.02, frameW],
    [(hole + frameW) / 2, 0, frameW, hole], [-(hole + frameW) / 2, 0, frameW, hole - 0.02]]) {
    parts.push({ geo: buildBox(w, 0.12 * S, d), pos: [x, fy, z], mat: MAT.timber, tone: 0.2 + R() * 0.2 });
  }
  // The lid: a shallow board box with the jungle floor on top, hinged on the
  // +Z edge and thrown open past upright (~110°) so it rests leaning back, its
  // underside (timber) toward the camera. A positive turn about X: the other
  // sign swings it down into the ground. A hair narrower than the frame: the
  // same width puts their sides in one plane.
  const lidT = 0.1 * S, lidS = hole + 2 * frameW - 0.06;
  const hingeZ = (hole / 2 + frameW), open = 1.9;
  const lid = assemble([
    { geo: buildBox(lidS, lidT, lidS), pos: [0, lidT / 2, -lidS / 2], mat: MAT.timber, tone: 0.3 },
    { geo: buildBox(lidS - 0.06, 0.08 * S, lidS - 0.06), pos: [0, lidT + 0.04 * S, -lidS / 2], mat: MAT.earth, tone: 0.45 },
    { geo: buildBox(lidS * 0.9, 0.05, lidS * 0.6), pos: [0.05, lidT + 0.1 * S, -lidS / 2 + 0.05], rot: [0, 0.4, 0], mat: MAT.thatch, tone: 0.4 },
  ]);
  parts.push({ geo: lid, pos: [0, fy + 0.06 * S, hingeZ], rot: [open, 0, 0], mat: null });
  // The top of a bamboo ladder standing in the shaft, against its far side.
  // Leaning its top back against the shaft's far edge (+Z), as a ladder rests.
  const lean = 0.18;
  const lz = hole / 2 - 0.2, ly0 = fy - 0.35, ly1 = fy + 0.75 * S, lmid = (ly0 + ly1) / 2;
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildBox(0.06 * S, ly1 - ly0, 0.06 * S), pos: [sx * 0.2 * S, lmid, lz], rot: [lean, 0, 0], mat: MAT.bamboo, tone: 0.45 + sx * 0.05 });
  }
  for (let k = 0; k < 3; k++) {
    const y = ly0 + 0.3 + k * 0.32 * S;
    parts.push({ geo: buildBox(0.5 * S, 0.045 * S, 0.045 * S), pos: [0, y, lz + Math.tan(lean) * (y - lmid) - 0.035 * S], mat: MAT.bamboo, tone: 0.55 });
  }
  // Cut fronds laid on the spoil, and one across the open side.
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + R() * 0.5, r = rIn + 0.9 * S + R() * 0.6 * S;
    parts.push({ geo: buildBox(1.3 * S, 0.05, 0.5 * S), pos: [Math.cos(a) * r, 0.2 * S + R() * 0.06, Math.sin(a) * r], rot: [0, -a + R() * 0.6, -0.12 - R() * 0.1], mat: MAT.thatch, tone: 0.25 + R() * 0.45 });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.12 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.2 * S, hz: 1.2 * S };
  geo.userData.height = 1.6 * S;
  return geo;
}

// ── 82 mm mortar ─────────────────────────────────────────────────────────────
const MG = S * 1.5;                       // the weapon, drawn up so it reads
/** The tube's pivot height above the pit floor, and its muzzle in the tube's own frame. */
export const MORTAR_TUBE_Y = 0.2 * S;
const TUBE_LEN = 1.5 * MG, TUBE_TILT = 0.35;   // ~70° elevation, leaning toward +Z
export const MORTAR_MUZZLE = new THREE.Vector3(0, MORTAR_TUBE_Y + TUBE_LEN * Math.cos(TUBE_TILT), TUBE_LEN * Math.sin(TUBE_TILT));

/** A seated or kneeling figure of the Front, in his pith helmet. `s` scales him. */
function crewman(parts, x, z, face, { kneeling = true, scale = 1, tone = 0.35 } = {}) {
  const g = (v) => v * MG * scale;
  const q = (geo, px, py, pz, mat, t, rot) => parts.push({ geo, pos: [x + px, py, z + pz], mat, tone: t, rot: rot ?? [0, face, 0] });
  // Sized against the game's own soldiers (2.34 m at RTS scale), not life:
  // at real proportions the crew came out half the height of the men round them.
  const h = kneeling ? 0.72 : 1.05;
  q(buildBox(g(0.26), g(h * 0.55), g(0.2)), 0, g(h * 0.72), 0, MAT.canvas, tone);                     // torso
  q(buildBox(g(0.12), g(h * 0.5), g(0.12)), g(-0.08), g(h * 0.25), 0, MAT.canvas, tone + 0.05);       // legs
  q(buildBox(g(0.12), g(h * 0.5), g(0.12)), g(0.08), g(h * 0.25), 0, MAT.canvas, tone + 0.05);
  q(new THREE.SphereGeometry(g(0.085), 10, 8), 0, g(h * 1.06), 0, MAT.hessian, 0.6);                  // head
  q(new THREE.SphereGeometry(g(0.15), 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.62, 1.1), 0, g(h * 1.1), 0, MAT.paint, 0.7);
  q(new THREE.CylinderGeometry(g(0.19), g(0.19), g(0.018), 14).scale(1, 1, 1.12), 0, g(h * 1.09), 0, MAT.paint, 0.68);
}

/** The pit, its bags, the ammunition and the crew — everything that stays put. */
export function buildMortarPit({ seed = 82 } = {}) {
  const R = rng(seed);
  const parts = [];
  const rIn = 2.3 * S, rOut = 3.5 * S, crest = 0.5 * S;
  const prof = [[rOut, 0], [rOut - 0.5 * S, 0.18 * S], [rIn + 0.4 * S, crest], [rIn + 0.1, crest * 0.85], [rIn - 0.05, 0.02]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const gap = 1.0;
  parts.push({ geo: new THREE.LatheGeometry(prof, 24, Math.PI + gap / 2, Math.PI * 2 - gap), mat: MAT.earth, tone: 0.38 });
  parts.push({ geo: new THREE.CylinderGeometry(rIn, rIn, 0.04, 20), pos: [0, 0.02, 0], mat: MAT.earth, tone: 0.24 });
  // Bags round the lip, open at the back where the crew works.
  parts.push({
    geo: buildSandbagRing({ radius: rIn + 0.45 * S, courses: 2, seed, gapDeg: 84, batter: 0.05, bag: { length: 0.52 * S, width: 0.3 * S, height: 0.19 * S, segU: 6, segV: 4 } }),
    pos: [0, crest * 0.7, 0], rot: [0, Math.PI, 0], mat: null,
  });
  // The baseplate the tube stands on.
  parts.push({ geo: new THREE.CylinderGeometry(0.42 * MG, 0.46 * MG, 0.08 * MG, 12), pos: [0, 0.04 * MG, 0], mat: MAT.steel, tone: 0.22 });
  // Ammunition: a crate, an open one, and three bombs stood up in the earth.
  for (let k = 0; k < 2; k++) {
    parts.push({ geo: buildBox(0.62 * S, 0.3 * S - k * 0.02, 0.36 * S), pos: [(k - 0.5) * 0.8 * S, 0.15 * S, -rIn + 0.55 * S], rot: [0, (R() - 0.5) * 0.3, 0], mat: MAT.paint, tone: 0.3 + R() * 0.25 });
  }
  for (let k = 0; k < 3; k++) {
    const x = 0.95 * S + k * 0.22 * S, z = -rIn + 0.9 * S + (R() - 0.5) * 0.2;
    parts.push({ geo: new THREE.CylinderGeometry(0.05 * MG, 0.055 * MG, 0.42 * MG, 8), pos: [x, 0.21 * MG, z], rot: [0.1, 0, 0.06], mat: MAT.steel, tone: 0.15 });
    parts.push({ geo: new THREE.ConeGeometry(0.05 * MG, 0.13 * MG, 8), pos: [x, 0.48 * MG, z], mat: MAT.steel, tone: 0.18 });
  }
  // The crew: the gunner kneeling at the tube's left, the loader behind him.
  crewman(parts, -0.62 * MG, 0.15 * MG, 1.4, { kneeling: true, tone: 0.32 });
  crewman(parts, 0.5 * MG, -1.15 * MG, 2.6, { kneeling: false, tone: 0.4 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.16 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: rIn + 0.4 * S, hz: rIn + 0.4 * S };
  geo.userData.height = 2.2 * S;
  return geo;
}

/** The tube on its bipod: turns about the baseplate, fixed at its firing elevation. */
export function buildMortarTube() {
  const g = (v) => v * MG;
  const parts = [];
  const tube = new THREE.CylinderGeometry(0.075 * MG, 0.085 * MG, TUBE_LEN, 12);
  const half = TUBE_LEN / 2;
  parts.push({ geo: tube, pos: [0, MORTAR_TUBE_Y + half * Math.cos(TUBE_TILT), half * Math.sin(TUBE_TILT)], rot: [TUBE_TILT, 0, 0], mat: MAT.steel, tone: 0.12 });
  // The muzzle ring and the ball at the foot, in its socket on the plate.
  parts.push({ geo: new THREE.CylinderGeometry(0.095 * MG, 0.09 * MG, 0.1 * MG, 12), pos: [MORTAR_MUZZLE.x, MORTAR_MUZZLE.y - 0.04 * MG, MORTAR_MUZZLE.z - 0.02 * MG], rot: [TUBE_TILT, 0, 0], mat: MAT.steel, tone: 0.2 });
  parts.push({ geo: new THREE.SphereGeometry(0.1 * MG, 10, 8), pos: [0, MORTAR_TUBE_Y + 0.02 * MG, 0], mat: MAT.steel, tone: 0.18 });
  // Bipod: two legs forward to the ground, and the elevating screw between them.
  const legTop = [0, MORTAR_TUBE_Y + 0.62 * TUBE_LEN * Math.cos(TUBE_TILT), 0.62 * TUBE_LEN * Math.sin(TUBE_TILT)];
  for (const sx of [-1, 1]) {
    const foot = [sx * g(0.42), 0, g(0.62)];
    const mid = [(legTop[0] + foot[0]) / 2, (legTop[1] + foot[1]) / 2, (legTop[2] + foot[2]) / 2];
    const len = Math.hypot(foot[0] - legTop[0], foot[1] - legTop[1], foot[2] - legTop[2]);
    const leg = buildBox(g(0.05), len, g(0.05));
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(foot[0] - legTop[0], foot[1] - legTop[1], foot[2] - legTop[2]).normalize(),
    );
    parts.push({ geo: leg, matrix: new THREE.Matrix4().compose(new THREE.Vector3(...mid), q, new THREE.Vector3(1, 1, 1)), mat: MAT.steel, tone: 0.2 });
  }
  parts.push({ geo: buildBox(g(0.06), g(0.34), g(0.06)), pos: [g(0.12), legTop[1] - g(0.2), legTop[2] - g(0.06)], mat: MAT.steel, tone: 0.28 });
  // The sight on its bracket, to the left.
  parts.push({ geo: buildBox(g(0.07), g(0.16), g(0.07)), pos: [-g(0.24), legTop[1] + g(0.04), legTop[2] - g(0.04)], mat: MAT.paint, tone: 0.5 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.06 * MG, radius: 1, strength: 0.25, groundFade: 0.2, floor: 0.6 });
  return geo;
}

// ── ZPU-4 ────────────────────────────────────────────────────────────────────
/**
 * The gun and its mount are drawn 1.4x their size: at the RTS camera's
 * ~14 px a metre a real KPV barrel (3 cm) is under a pixel, and the four
 * barrels are what tell this from the DShK nest. The pit and carriage stay at
 * the kit's 1.3.
 */
const ZG = S * 1.4;
/** Heights above the pit's ground origin: the turntable (the mount turns about it) and the trunnions (the guns elevate about them). */
export const ZPU_MOUNT_Y = 0.42 * S;
export const ZPU_TRUNNION_Y = ZPU_MOUNT_Y + 0.62 * ZG;
/** The muzzle, in the guns' own frame (trunnion at the origin, barrels along +Z). */
export const ZPU_MUZZLE = new THREE.Vector3(0, 0, 1.62 * ZG);

/** The pit, the carriage on its jacks, the ammunition: everything that stays still. */
export function buildZpuBody({ seed = 145 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The pit: a ring of spoil round a flat floor, open at the back (-Z) for the
  // crew and the ammunition. Profile OUTSIDE-IN so the faces point up.
  const rIn = 3.3 * S, rOut = 5.6 * S, crest = 0.95 * S;
  const prof = [[rOut, 0], [rOut - 0.8 * S, 0.3 * S], [rIn + 0.7 * S, crest], [rIn + 0.15 * S, crest * 0.9], [rIn - 0.05, 0.02]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  // Lathe angles run from +Z (x = sin φ, z = cos φ): the back (-Z) is φ = π.
  const gap = 0.9;                                          // radians of opening at the back
  parts.push({ geo: new THREE.LatheGeometry(prof, 30, Math.PI + gap / 2, Math.PI * 2 - gap), mat: MAT.earth, tone: 0.42 });
  parts.push({ geo: new THREE.CylinderGeometry(rIn, rIn, 0.04, 24), pos: [0, 0.02, 0], mat: MAT.earth, tone: 0.25 });
  // The carriage: two side rails and the cross members, on four jacks, the
  // wheels lifted off the ground either side as they are in firing position.
  const cw = 0.85 * S, cl = 2.1 * S, railY = 0.3 * S;
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildBox(0.14 * S, 0.16 * S, cl * 2), pos: [sx * cw, railY, 0], mat: MAT.steel, tone: 0.3 });
    for (const sz of [-1, 1]) {
      parts.push({ geo: buildBox(0.1 * S, railY - 0.08, 0.1 * S), pos: [sx * (cw + 0.02), (railY - 0.08) / 2, sz * (cl - 0.15)], mat: MAT.steel, tone: 0.25 });
      parts.push({ geo: buildBox(0.34 * S, 0.05, 0.34 * S), pos: [sx * (cw + 0.02), 0.025, sz * (cl - 0.15)], mat: MAT.steel, tone: 0.2 });
      // A wheel, lifted: turned flat-side out beside the rail.
      const wheel = new THREE.CylinderGeometry(0.42 * S, 0.42 * S, 0.24 * S, 14).rotateZ(Math.PI / 2);
      parts.push({ geo: wheel, pos: [sx * (cw + 0.3 * S), 0.5 * S, sz * (cl - 0.75 * S)], mat: MAT.rubber, tone: 0.4 });
      parts.push({ geo: new THREE.CylinderGeometry(0.16 * S, 0.16 * S, 0.27 * S, 10).rotateZ(Math.PI / 2), pos: [sx * (cw + 0.3 * S), 0.5 * S, sz * (cl - 0.75 * S)], mat: MAT.paint, tone: 0.45 });
    }
  }
  for (const z of [-cl + 0.1, -0.6 * S, 0.6 * S, cl - 0.1]) {
    parts.push({ geo: buildBox(cw * 2 - 0.1, 0.12 * S, 0.12 * S), pos: [0, railY + 0.01, z], mat: MAT.steel, tone: 0.28 });
  }
  // The towing bar forward, resting on the pit floor.
  parts.push({ geo: buildBox(0.1 * S, 0.1 * S, 1.2 * S), pos: [0, 0.14 * S, cl + 0.55 * S], rot: [0.12, 0, 0], mat: MAT.steel, tone: 0.3 });
  // Ammunition: the green boxes stacked at the pit's open back, a couple open.
  for (let k = 0; k < 7; k++) {
    const x = -1.4 * S + (k % 4) * 0.62 * S + (R() - 0.5) * 0.1, z = -rIn + 0.7 * S + ((k / 4) | 0) * 0.45 * S;
    const y = k >= 4 ? 0.3 * S : 0;
    parts.push({ geo: buildBox(0.56 * S, 0.3 * S - 0.01, 0.34 * S), pos: [x, y + 0.15 * S, z], rot: [0, (R() - 0.5) * 0.2, 0], mat: MAT.paint, tone: 0.3 + R() * 0.3 });
  }
  // Leaves and a few cut fronds over the spoil — dug in, not parked.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + R() * 0.4;
    // (x = cos a, z = sin a here: the opening at -Z is a = -π/2.)
    if (Math.abs(Math.atan2(Math.sin(a + Math.PI / 2), Math.cos(a + Math.PI / 2))) < gap) continue;
    const r = rIn + 1.1 * S + R() * 0.6 * S;
    parts.push({ geo: buildBox(1.6 * S, 0.06, 0.6 * S), pos: [Math.cos(a) * r, crest * 0.75 + R() * 0.1, Math.sin(a) * r], rot: [0, -a + R() * 0.5, -0.3], mat: MAT.thatch, tone: 0.25 + R() * 0.4 });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.18 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: rIn + 0.5 * S, hz: rIn + 0.5 * S };
  geo.userData.height = 2.8 * S;
  return geo;
}

/** The mount: turntable, the gunner's seat and the gunner in his pith helmet. Turns about its origin. */
export function buildZpuMount() {
  const g = (x) => x * ZG;
  const parts = [];
  const P = (geo, pos, mat, tone, rot) => parts.push({ geo, pos, mat, tone, rot });
  P(new THREE.CylinderGeometry(g(0.46), g(0.5), g(0.1), 18), [0, g(0.05), 0], MAT.steel, 0.25);
  P(new THREE.CylinderGeometry(g(0.2), g(0.26), g(0.34), 12), [0, g(0.27), 0], MAT.steel, 0.2);
  // The side frames that carry the trunnions.
  for (const sx of [-1, 1]) P(buildBox(g(0.06), g(0.42), g(0.36)), [sx * g(0.34), g(0.4), 0], MAT.steel, 0.22);
  // The gunner, behind the guns, on his seat, hands up to the sight.
  const sz = -g(0.52);
  P(buildBox(g(0.3), g(0.05), g(0.28)), [0, g(0.42), sz], MAT.steel, 0.3);                  // seat
  P(buildBox(g(0.28), g(0.28), g(0.04)), [0, g(0.58), sz - g(0.16)], MAT.steel, 0.3);       // backrest
  P(buildBox(g(0.26), g(0.34), g(0.18)), [0, g(0.62), sz], MAT.canvas, 0.35);               // torso
  P(new THREE.SphereGeometry(g(0.085), 10, 8), [0, g(0.86), sz + g(0.02)], MAT.hessian, 0.6); // face
  // The pith helmet: the NVA's silhouette — a wide flat-topped dome.
  P(new THREE.SphereGeometry(g(0.15), 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.62, 1.1), [0, g(0.9), sz + g(0.02)], MAT.paint, 0.7);
  P(new THREE.CylinderGeometry(g(0.19), g(0.19), g(0.018), 14).scale(1, 1, 1.12), [0, g(0.89), sz + g(0.02)], MAT.paint, 0.68);
  for (const sx of [-1, 1]) {
    P(buildBox(g(0.06), g(0.06), g(0.3)), [sx * g(0.125), g(0.72), sz + g(0.18)], MAT.canvas, 0.3, [0.5, 0, 0]); // arms to the sight
    P(buildBox(g(0.09), g(0.2), g(0.09)), [sx * g(0.08), g(0.34), sz + g(0.1)], MAT.canvas, 0.3);             // legs down
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.06 * ZG, radius: 1, strength: 0.25, groundFade: 0, floor: 0.6 });
  return geo;
}

/** The four barrels, two over two, in their cradle; trunnion at the origin, barrels along +Z. */
export function buildZpuGuns() {
  const g = (x) => x * ZG;
  const parts = [];
  const P = (geo, pos, mat, tone, rot) => parts.push({ geo, pos, mat, tone, rot });
  const alongZ = (r0, r1, len, seg = 8) => new THREE.CylinderGeometry(r0, r1, len, seg).rotateX(Math.PI / 2);
  // The cradle and the trunnion axle.
  P(buildBox(g(0.6), g(0.08), g(0.5)), [0, 0, g(0.05)], MAT.steel, 0.2);
  P(alongZ(g(0.035), g(0.035), g(0.74)).rotateY(Math.PI / 2), [0, 0, 0], MAT.steel, 0.15);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = sx * g(0.14), y = sy * g(0.1) + g(0.02);
    P(buildBox(g(0.1), g(0.12), g(0.56)), [x, y, g(-0.02)], MAT.steel, 0.08);            // receiver
    P(alongZ(g(0.024), g(0.03), g(1.3)), [x, y, g(0.9)], MAT.steel, 0.05);                // barrel
    P(alongZ(g(0.04), g(0.04), g(0.1)), [x, y, g(0.4)], MAT.steel, 0.1);                  // barrel jacket
    P(alongZ(g(0.036), g(0.03), g(0.12)), [x, y, g(1.58)], MAT.steel, 0.05);              // flash hider
    P(buildBox(g(0.1), g(0.16), g(0.24)), [sx * g(0.3), y, g(-0.02)], MAT.paint, 0.32);   // ammunition box
  }
  // The ring sight on its post, forward over the barrels.
  P(buildBox(g(0.015), g(0.2), g(0.015)), [0, g(0.2), g(0.3)], MAT.steel, 0.1);
  P(new THREE.TorusGeometry(g(0.11), g(0.008), 4, 18), [0, g(0.32), g(0.3)], MAT.steel, 0.15);
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.05 * ZG, radius: 1, strength: 0.25, groundFade: 0, floor: 0.6 });
  return geo;
}

// ── The cheap nasty kit ──────────────────────────────────────────────────────
/**
 * What the Front could make out of a spade, a length of bamboo and whatever the
 * Americans threw away: the war that cost them almost nothing and cost you men,
 * time and nerve. None of it wins a fight — all of it makes walking somewhere
 * expensive.
 *
 * Everything here is drawn ONLY once it has been found (structures.js keeps it
 * hidden, traps.js decides when your men see it), so these are the SPRUNG or
 * DISCOVERED states: the pit uncovered, the wire spotted, the cache opened, the
 * hole with its lid thrown back and the man in it looking at you.
 */

/** A cut palm frond lying flat: what everything here was hidden under. */
function frondOnGround(parts, x, y, z, a, len, R, tone = 0.3) {
  parts.push({
    geo: buildBox(len, 0.05, len * 0.42), pos: [x, y, z],
    rot: [0, a, (R() - 0.5) * 0.24], mat: MAT.thatch, tone: tone + R() * 0.35,
  });
}

/**
 * PUNJI PIT, uncovered. A deep hole under a woven mat with fire-hardened
 * bamboo lining the bottom. It kills nobody outright: it takes one man out of
 * the line and the friends who carry him out with it.
 *
 * The hole is drawn ABOVE ground inside its own spoil lip, the way the tunnel
 * mouth is: the terrain is not really excavated, so anything below y = 0 is
 * simply hidden by the ground it is meant to be a hole in.
 */
export function buildPunjiPit({ seed = 11 } = {}) {
  const R = rng(seed);
  const parts = [];
  const mouth = 2.0 * S, lip = 0.32 * S;
  // Spoil thrown up round the edge (lathe profile OUTSIDE-IN: faces point up).
  const rOut = 2.3 * S, rIn = mouth * 0.62;
  const prof = [[rOut, 0], [rOut - 0.45 * S, 0.1 * S], [rIn + 0.4 * S, lip], [rIn + 0.08, lip * 0.9], [rIn, 0.02]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  parts.push({ geo: new THREE.LatheGeometry(prof, 16), mat: MAT.earth, tone: 0.33 });
  // The hole. A pit cannot be dug DOWN — the terrain is not really excavated,
  // and anything under y = 0 is hidden by the ground it is supposed to be a
  // hole in — so it is built UP, inside the spoil: four earth walls falling
  // inward to a dark floor. (A flat dark square at the rim, which is what this
  // was, reads as a panel lying on the ground, not as depth.)
  // Near-VERTICAL walls (the floor only a little smaller than the rim). Drawn
  // with a wide funnel instead, the four walls read as a mound with a dimple
  // in it — from the RTS camera's pitch you never see down into a slope.
  const rimS = 1.85 * S, floorS = 1.5 * S, floorY = 0.06 * S;
  const inset = (rimS - floorS) / 2, drop = lip - floorY;
  const slant = Math.hypot(inset, drop), tilt = Math.asin(drop / slant);
  const midY = (lip + floorY) / 2, midR = (rimS + floorS) / 4;
  for (const sz of [-1, 1]) {
    parts.push({
      geo: buildBox(rimS, 0.1 * S, slant), pos: [0, midY, sz * midR],
      rot: [-sz * tilt, 0, 0], mat: MAT.earth, tone: 0.2 + (sz + 1) * 0.03,
    });
  }
  for (const sx of [-1, 1]) {
    parts.push({
      geo: buildBox(slant, 0.1 * S - 0.01, rimS - 0.12), pos: [sx * midR, midY, 0],
      rot: [0, 0, sx * tilt], mat: MAT.earth, tone: 0.24 + (sx + 1) * 0.03,
    });
  }
  parts.push({ geo: buildBox(floorS + 0.06, 0.06 * S, floorS + 0.04), pos: [0, floorY, 0], mat: MAT.steel, tone: 0.02 });
  // The stakes: a jittered grid standing on that floor, points up and leaning
  // inward, so whatever comes through the mat is funnelled onto them. They
  // stand well proud of the rim — from the RTS camera the spikes ARE the tell.
  // Nine, not thirteen, and each one as thick as a wrist: a real punji stake is
  // 3 cm across, which at the RTS camera's ~14 px a metre is half a pixel — the
  // same reason the kit's guns are drawn up. Pale bamboo, too, so they stand
  // against the dark of the pit instead of disappearing into it.
  for (let k = 0; k < 9; k++) {
    const gx = (k % 3) - 1, gz = ((k / 3) | 0) - 1;
    const x = (gx * 0.42 + (R() - 0.5) * 0.2) * S, z = (gz * 0.44 + (R() - 0.5) * 0.2) * S;
    const h = (0.75 + R() * 0.5) * S;
    parts.push({
      geo: new THREE.ConeGeometry(0.085 * S, h, 6), pos: [x, floorY + 0.02 + h / 2, z],
      // Fire-hardened, so DRY timber and not green bamboo: against grass and
      // the dark of the pit, a green spike is another blade of grass.
      rot: [z * 0.3, R() * 2, -x * 0.3], mat: MAT.timber, tone: 0.45 + R() * 0.4,
    });
  }
  // The mat that covered it, dragged back off the near edge: a woven frame, its
  // bamboo cross-sticks, and the jungle floor still stuck to it.
  const matS = mouth + 0.5 * S;
  const cover = assemble([
    { geo: buildBox(matS, 0.06 * S, matS), pos: [0, 0.03 * S, 0], mat: MAT.woven, tone: 0.4 },
    { geo: buildBox(matS - 0.14, 0.05 * S, 0.09 * S), pos: [0, 0.08 * S, -0.3 * S], mat: MAT.bamboo, tone: 0.5 },
    { geo: buildBox(0.08 * S, 0.045 * S, matS - 0.2), pos: [0.35 * S, 0.085 * S, 0], mat: MAT.bamboo, tone: 0.45 },
  ]);
  parts.push({ geo: cover, pos: [0.3 * S, 0.02, -(rIn + 1.5 * S)], rot: [0, 0.3, 0.06], mat: null });
  // Fronds off the mat, scattered where it was pulled clear.
  for (let k = 0; k < 5; k++) {
    const a = Math.PI + (R() - 0.5) * 1.6, r = rIn + (0.9 + R() * 1.2) * S;
    frondOnGround(parts, Math.sin(a) * r, 0.06 + R() * 0.04, Math.cos(a) * r, R() * 3, (0.9 + R() * 0.5) * S, R);
  }
  const geo = assemble(parts);
  // A gentler bake than the rest of the kit: the stakes stand in a hole, so
  // contact AO buries the one thing anybody needs to see.
  bakeContactAO(geo, { cell: 0.11 * S, radius: 2, strength: 0.28, groundFade: 0.3, floor: 0.64 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.2 * S, hz: 1.2 * S };
  geo.userData.height = 0.9 * S;
  return geo;
}

/**
 * BOOBY TRAP, spotted. A grenade in a ration tin wired across a trail: the pin
 * is out and the tin holds the spoon, so the wire pulls the grenade free and
 * four seconds later the trail is a bad place to be standing. Made entirely of
 * things the other side dropped.
 */
export function buildBoobyTrap({ seed = 13 } = {}) {
  const R = rng(seed);
  const parts = [];
  const span = 1.5 * S, stakeH = 0.62 * S;
  for (const sx of [-1, 1]) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.035 * S, 0.045 * S, stakeH + sx * 0.04, 6),
      pos: [sx * span / 2, (stakeH + sx * 0.04) / 2, sx * 0.05], rot: [0, 0, sx * 0.06],
      mat: MAT.bamboo, tone: 0.34 + R() * 0.3,
    });
  }
  // The wire, at a shin's height and drawn a little off true.
  parts.push({ geo: buildBox(span - 0.06, 0.016, 0.016), pos: [0, 0.4 * S, 0.02], rot: [0, 0.02, -0.02], mat: MAT.steel, tone: 0.1 });
  // The tin lashed to the right-hand stake, with the grenade sitting in it.
  const tinY = 0.44 * S;
  parts.push({ geo: new THREE.CylinderGeometry(0.075 * S, 0.07 * S, 0.19 * S, 10), pos: [span / 2 - 0.09 * S, tinY, 0.05], mat: MAT.metal, tone: 0.42 });
  parts.push({ geo: new THREE.CylinderGeometry(0.05 * S, 0.055 * S, 0.17 * S, 8), pos: [span / 2 - 0.09 * S, tinY + 0.1 * S, 0.05], mat: MAT.steel, tone: 0.16 });
  parts.push({ geo: new THREE.SphereGeometry(0.052 * S, 8, 6), pos: [span / 2 - 0.09 * S, tinY + 0.2 * S, 0.05], mat: MAT.steel, tone: 0.2 });
  // The leaves it was under, pushed aside.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + R();
    frondOnGround(parts, Math.sin(a) * (0.7 + R() * 0.5) * S, 0.05 + R() * 0.03, Math.cos(a) * (0.7 + R() * 0.5) * S, R() * 3, (0.7 + R() * 0.4) * S, R, 0.22);
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.08 * S, radius: 1, strength: 0.3, groundFade: 0.25, floor: 0.55 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 0.9 * S, hz: 0.5 * S };
  geo.userData.height = 0.8 * S;
  return geo;
}

/**
 * SUPPLY CACHE, opened. Rice in hessian, ammunition in the crates it came in,
 * bundles of bamboo and a couple of stolen jerry cans, in a shallow scrape
 * under a palm mat. It pays the Front every second it stands, and burning one
 * is worth the walk.
 */
export function buildSupplyCache({ seed = 19 } = {}) {
  const R = rng(seed);
  const parts = [];
  // The scrape: a low bank round it, open at the front (-Z) where they work.
  const rIn = 1.9 * S, rOut = 3.0 * S, crest = 0.36 * S;
  const prof = [[rOut, 0], [rOut - 0.5 * S, 0.12 * S], [rIn + 0.4 * S, crest], [rIn + 0.1, crest * 0.88], [rIn - 0.05, 0.02]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const gap = 1.1;
  parts.push({ geo: new THREE.LatheGeometry(prof, 20, Math.PI + gap / 2, Math.PI * 2 - gap), mat: MAT.earth, tone: 0.34 });
  parts.push({ geo: new THREE.CylinderGeometry(rIn, rIn, 0.04, 18), pos: [0, 0.02, 0], mat: MAT.earth, tone: 0.22 });
  // Rice sacks: two courses, each one squashed and turned its own way, so the
  // stack reads as full bags and not a wall of boxes.
  for (let k = 0; k < 9; k++) {
    const course = k >= 5 ? 1 : 0;
    const i = course ? k - 5 : k;
    const n = course ? 4 : 5;
    const x = (-0.62 + (i / (n - 1)) * 1.24) * S + (R() - 0.5) * 0.1;
    const z = (0.42 + course * 0.1) * S + (R() - 0.5) * 0.12;
    parts.push({
      geo: new THREE.SphereGeometry(0.3 * S, 8, 6).scale(1.15, 0.52, 0.78),
      pos: [x, (0.17 + course * 0.31) * S, z], rot: [(R() - 0.5) * 0.2, (R() - 0.5) * 0.7, (R() - 0.5) * 0.25],
      mat: MAT.hessian, tone: 0.3 + R() * 0.45,
    });
  }
  // Ammunition crates, each a different size so no two stack face to face.
  const crates = [[0.74, 0.3, 0.44, -0.95, 0.15, -0.55, 0.1], [0.68, 0.28, 0.4, -0.9, 0.44, -0.6, -0.16],
    [0.8, 0.32, 0.46, 0.85, 0.16, -0.5, -0.24]];
  for (const [w, h, d, x, y, z, a] of crates) {
    parts.push({ geo: buildBox(w * S, h * S, d * S), pos: [x * S, y * S, z * S], rot: [0, a, 0], mat: MAT.paint, tone: 0.26 + R() * 0.2 });
  }
  // One of them open, its lid leaning back against the bank.
  parts.push({ geo: buildBox(0.76 * S, 0.05 * S, 0.42 * S), pos: [0.88 * S, 0.5 * S, -0.78 * S], rot: [-1.1, -0.24, 0], mat: MAT.timber, tone: 0.3 });
  // Jerry cans and bundled bamboo along the bank.
  for (let k = 0; k < 2; k++) {
    parts.push({ geo: buildBox(0.2 * S, 0.42 * S, 0.3 * S - k * 0.02), pos: [(1.15 - k * 0.26) * S, 0.21 * S, 0.55 * S], rot: [0, 0.2 - k * 0.5, 0], mat: MAT.paint, tone: 0.44 + k * 0.1 });
  }
  for (let k = 0; k < 3; k++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.09 * S, 0.085 * S, 1.5 * S, 7).rotateZ(Math.PI / 2),
      pos: [-1.05 * S, (0.09 + k * 0.17) * S, (0.9 + k * 0.03) * S], rot: [0, 0.12 + k * 0.1, 0],
      mat: MAT.bamboo, tone: 0.4 + R() * 0.3,
    });
  }
  // The palm mat thrown half back off the stack — what made it a cache and not
  // a dump. Laid at an angle over the sacks, its near edge on the ground.
  for (let k = 0; k < 5; k++) {
    parts.push({
      geo: buildBox((1.5 + R() * 0.5) * S, 0.05, 0.46 * S), pos: [(-0.55 + k * 0.3) * S, (0.72 - k * 0.11) * S, (-0.1 - k * 0.22) * S],
      rot: [0.55 + R() * 0.12, (R() - 0.5) * 0.5, (R() - 0.5) * 0.2], mat: MAT.thatch, tone: 0.24 + R() * 0.4,
    });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.14 * S, radius: 2, strength: 0.42, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 2.0 * S, hz: 2.0 * S };
  geo.userData.height = 1.4 * S;
  return geo;
}

// ── Spider hole ──────────────────────────────────────────────────────────────
/** The rifle's muzzle in the fighter's own frame (he turns about the hole's centre). */
export const SPIDER_MUZZLE = new THREE.Vector3(0.12 * S, 0.9 * S, 1.0 * S);

/** The hole, its lip and the lid thrown back: everything that stays still. */
export function buildSpiderHole({ seed = 23 } = {}) {
  const R = rng(seed);
  const parts = [];
  const rHole = 0.62 * S, lip = 0.28 * S;
  const rOut = 1.75 * S;
  const prof = [[rOut, 0], [rOut - 0.4 * S, 0.09 * S], [rHole + 0.34 * S, lip], [rHole + 0.06, lip * 0.92], [rHole, 0.02]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  parts.push({ geo: new THREE.LatheGeometry(prof, 18), mat: MAT.earth, tone: 0.36 });
  // The shaft, dark, its mouth at the lip.
  parts.push({ geo: new THREE.CylinderGeometry(rHole, rHole * 0.9, 0.7, 14), pos: [0, lip - 0.35 + 0.01, 0], mat: MAT.steel, tone: 0.0 });
  // Bamboo lining the rim, as a ring of short lengths.
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2;
    parts.push({
      geo: new THREE.CylinderGeometry(0.05 * S, 0.048 * S, 0.44 * S, 6).rotateZ(Math.PI / 2),
      pos: [Math.sin(a) * (rHole + 0.05 * S), lip - 0.02, Math.cos(a) * (rHole + 0.05 * S)],
      rot: [0, -a, 0], mat: MAT.bamboo, tone: 0.32 + R() * 0.35,
    });
  }
  // The lid: a round bamboo frame with the jungle floor on it, thrown back on
  // the -Z side and resting on its own edge.
  const lidR = rHole + 0.22 * S;
  const lid = assemble([
    { geo: new THREE.CylinderGeometry(lidR, lidR, 0.07 * S, 14), pos: [0, 0.035 * S, 0], mat: MAT.woven, tone: 0.38 },
    { geo: new THREE.CylinderGeometry(lidR - 0.06, lidR - 0.06, 0.06 * S, 12), pos: [0, 0.1 * S, 0], mat: MAT.earth, tone: 0.44 },
    { geo: buildBox(lidR * 1.5, 0.05, lidR * 0.8), pos: [0.04 * S, 0.15 * S, 0], rot: [0, 0.5, 0], mat: MAT.thatch, tone: 0.3 },
  ]);
  parts.push({ geo: lid, pos: [0, lip * 0.6, -(rHole + 0.85 * S)], rot: [1.15, 0.2, 0], mat: null });
  for (let k = 0; k < 4; k++) {
    const a = Math.PI + (R() - 0.5) * 2.2, r = rHole + (0.8 + R() * 0.9) * S;
    frondOnGround(parts, Math.sin(a) * r, 0.05 + R() * 0.03, Math.cos(a) * r, R() * 3, (0.8 + R() * 0.5) * S, R, 0.24);
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.1 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.0 * S, hz: 1.0 * S };
  geo.userData.height = 1.2 * S;
  return geo;
}

/**
 * The man in the hole: head, shoulders and an SKS over the rim, under the
 * conical leaf hat that is the whole silhouette of him. He turns to his target
 * about the hole's centre, so the rifle points where he is shooting.
 */
export function buildSpiderMan() {
  const g = (v) => v * MG;
  const parts = [];
  const P = (geo, pos, mat, tone, rot) => parts.push({ geo, pos, mat, tone, rot });
  const y0 = 0.3 * S;                       // the rim: everything under this is in the hole
  P(buildBox(g(0.3), g(0.42), g(0.22)), [0, y0 + g(0.2), -g(0.04)], MAT.canvas, 0.3);       // torso
  P(new THREE.SphereGeometry(g(0.088), 10, 8), [0, y0 + g(0.46), 0], MAT.hessian, 0.6);     // head
  // The nón lá: a wide shallow cone of palm leaf, and its brim.
  P(new THREE.ConeGeometry(g(0.3), g(0.2), 14), [0, y0 + g(0.56), 0], MAT.thatch, 0.46);
  P(new THREE.CylinderGeometry(g(0.29), g(0.3), g(0.02), 14), [0, y0 + g(0.455), 0], MAT.thatch, 0.4);
  // Arms forward over the rim, and the rifle they hold.
  for (const sx of [-1, 1]) {
    P(buildBox(g(0.075), g(0.075), g(0.34)), [sx * g(0.15), y0 + g(0.26), g(0.16)], MAT.canvas, 0.33, [0.22, 0, 0]);
  }
  const rifleZ = g(0.42);
  P(buildBox(g(0.06), g(0.09), g(0.56)), [g(0.09), y0 + g(0.32), rifleZ], MAT.timber, 0.26, [0.06, 0, 0]);          // stock
  P(new THREE.CylinderGeometry(g(0.018), g(0.02), g(0.5), 7).rotateX(Math.PI / 2), [g(0.09), y0 + g(0.36), rifleZ + g(0.5)], MAT.steel, 0.12, [0.06, 0, 0]);
  P(buildBox(g(0.05), g(0.06), g(0.13)), [g(0.09), y0 + g(0.28), rifleZ - g(0.17)], MAT.timber, 0.3);               // magazine
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.06 * MG, radius: 1, strength: 0.25, groundFade: 0, floor: 0.6 });
  return geo;
}
