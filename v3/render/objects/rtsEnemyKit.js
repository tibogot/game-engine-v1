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
