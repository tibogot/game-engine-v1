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
 *
 * Same contract as the rest of the kit: real size x 1.3, one merged geometry
 * on the atlas material, origin at the ground centre on y = 0,
 * `userData.footprint`.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";

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
