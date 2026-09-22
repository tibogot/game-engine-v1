/**
 * THE HAMLET KIT — what a Vietnamese village is actually made of.
 *
 * `rtsVillageHut.js` already builds the stilt house. This is everything that
 * turns one house into a PLACE: the big-roofed house that sits on the earth,
 * the rice granary, the well, the spirit shrine, woven fences, water jars,
 * drying racks, straw ricks, a cooking hearth and an ox cart.
 *
 * WHAT MAKES A HAMLET READ, in the order the eye takes it in:
 *
 *   1. THE ROOFS. From the RTS camera a village IS its roofs — big, dark,
 *      layered, and each one a different size and angle. Everything here that
 *      has a roof gets deep eaves and real thatch courses (buildThatchSlope),
 *      never a sloped slab with a thatch texture on it.
 *   2. THE CLUTTER AT THE DOORS. A house on bare ground is a model; a house
 *      with jars by the door, a rack of drying chillies, a straw rick and a
 *      cooking fire is somewhere people live. The clutter is half the tris of
 *      this file and most of the reason it works.
 *   3. FENCES AND THE LANE BETWEEN THEM. What makes it an arrangement rather
 *      than scattered props — see games/nam-rts/village.js, which lays it out.
 *   4. Material contrast: dark thatch against pale woven matting against the
 *      green-grey of bamboo, all from the one atlas, all one draw.
 *
 * Same contract as the rest of the kit: real size x 1.3 for the small stuff,
 * one merged geometry on the atlas material, origin at the ground centre on
 * y = 0, `userData.footprint` and `userData.height`.
 */
import * as THREE from "three";
import {
  MAT, assemble, bakeContactAO, buildBambooPole, buildBox, buildCorrugatedPanel,
  buildThatchSlope, rng,
} from "./rtsParts.js";

const S = 1.3;

/**
 * BUILDINGS ARE DRAWN BIGGER THAN LIFE, and by more than the 1.3 the props
 * use — the same call rtsVillageHut.js made and for the same reason: a real
 * 4.4 m house renders smaller than a Huey, and then it reads as an object the
 * units walk past instead of a place they go to. SPANS are scaled; pole, plank
 * and thatch thickness stay real, so it reads as a bigger house rather than a
 * zoomed one.
 */
const B = 1.6;

/** A bamboo pole of `h` metres standing at (x, z), leaning a little. */
function pole(parts, x, z, h, r, { radius = 0.055, tone = null, lean = 0.02 } = {}) {
  parts.push({
    geo: buildBambooPole({ height: h, radius: radius * (0.95 + r() * 0.15), internodes: Math.max(2, Math.round(h * 2.2)), seg: 7 }),
    mat: MAT.bamboo, tone: tone ?? r(),
    pos: [x, 0, z], rot: [(r() - 0.5) * lean, r() * 6.28, (r() - 0.5) * lean],
  });
}

/** A horizontal bamboo rail from (x0, z0) to (x1, z1) at height y. */
function rail(parts, x0, z0, x1, z1, y, r, { radius = 0.04, tone = null } = {}) {
  const dx = x1 - x0, dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  const geo = new THREE.CylinderGeometry(radius, radius * 0.96, len, 6).rotateZ(Math.PI / 2);
  parts.push({
    geo, mat: MAT.bamboo, tone: tone ?? r(),
    pos: [(x0 + x1) / 2, y, (z0 + z1) / 2], rot: [0, -Math.atan2(dz, dx), (r() - 0.5) * 0.03],
  });
}

/**
 * A thatched slope laid from its EAVE line to its RIDGE line.
 *
 * `eave` and `ridge` are the midpoints of those two lines and `along` the
 * direction the eave runs. Stated that way a hip end is the same call as a main
 * slope with different points, and there is no chance of the mistake this made
 * first time round: buildThatchSlope works in its own frame (+Y up the pitch,
 * +Z the outward normal), Euler angles for that are order-dependent, and
 * getting the handedness wrong on one slope face-culls half the roof away.
 */
function thatchAt(parts, { eave, ridge, along, width, topWidth = null, courses = 7, thickness = 0.14, ragged = 0.22, seed = 1, tone = 0.12, toneSpread = 0.36 }) {
  const Y = ridge.clone().sub(eave);
  const len = Y.length();
  Y.normalize();
  let X = along.clone().normalize();
  let Z = new THREE.Vector3().crossVectors(X, Y).normalize();
  // The outward normal must point AWAY from the roof, which here means
  // downhill and outward — the same side the eave overhangs. If the basis came
  // out facing in, flip the width direction: that keeps it right-handed.
  const outward = new THREE.Vector3(eave.x - ridge.x, 0, eave.z - ridge.z).normalize().setY(0.35);
  if (Z.dot(outward) < 0) { X = X.negate(); Z = Z.negate(); }
  const Xf = new THREE.Vector3().crossVectors(Y, Z).normalize();
  const geo = buildThatchSlope({
    width, topWidth, slope: len, courses, thickness, ragged, tone, toneSpread,
    seg: Math.max(6, Math.round(width * 1.3)), seed,
  });
  const m = new THREE.Matrix4().makeBasis(Xf, Y, Z);
  m.setPosition(eave);
  parts.push({ geo, matrix: m });
}

// ── The big-roofed house ─────────────────────────────────────────────────────
/**
 * The house that sits ON THE EARTH — the other half of the hamlet from the
 * stilt house. What it is, is a ROOF: an enormous thatch roof whose eaves come
 * down to head height and reach a metre and a half past the walls, so from
 * above you see roof, a band of shadow, and almost no wall at all. That deep
 * dark overhang is the whole silhouette, and it is what the user means by the
 * big banana-leaf roof.
 *
 * Underneath: a packed-earth plinth, woven walls between bamboo posts, a low
 * plank door on the +Z side (the camera's side), a porch of split bamboo under
 * the front eave, and the water jar every door has beside it.
 */
export function buildBigRoofHouse({ seed = 3 } = {}) {
  const r = rng(seed);
  const parts = [];
  const W = 4.6 * B, D = 3.7 * B;             // walls, in plan
  const wallH = 1.55 * B;                      // low: the roof does the work
  const plinth = 0.16 * B;
  const over = 1.05 * B, gableOver = 0.45 * B; // eaves past the wall
  const half = D / 2 + over;
  // 0.62, not 0.92: at the steeper pitch the roof stood taller than the house
  // was wide and the thing read as a tent. A delta house is a LOW WIDE roof
  // with its eaves nearly at head height — wider than it is tall, always.
  const rise = half * 0.62;
  const eaveY = plinth + wallH - 0.28 * B;     // the eave hangs BELOW the wall top
  const ridgeY = eaveY + rise;
  const ridgeLen = W + gableOver * 2;

  // Plinth: the beaten-earth floor pad the house stands on, a little wider
  // than the walls so the wall feet are not standing on grass.
  parts.push({ geo: buildBox(W + 0.5, plinth, D + 0.5), pos: [0, plinth / 2, 0], mat: MAT.earth, tone: 0.28 });

  // Posts: corners and mid-spans, ground to eave.
  for (const x of [-W / 2, 0, W / 2]) for (const z of [-D / 2, D / 2]) pole(parts, x, z, plinth + wallH, r, { radius: 0.07 });
  for (const z of [0]) for (const x of [-W / 2, W / 2]) pole(parts, x, z, plinth + wallH, r, { radius: 0.06 });
  // Wall plates tying the post tops, front and back.
  for (const z of [-D / 2, D / 2]) rail(parts, -W / 2, z, W / 2, z, plinth + wallH - 0.05, r, { radius: 0.05 });

  // Woven walls, with the door in the +Z face. A panel per bay, each leaning
  // its own way — nothing in a village is plumb.
  const bay = W / 4, doorW = 1.05 * B;
  for (const z of [-D / 2, D / 2]) {
    for (let i = 0; i < 4; i++) {
      const x = -W / 2 + bay * (i + 0.5);
      if (z > 0 && Math.abs(x) < doorW / 2 + bay * 0.4) continue;      // the doorway
      parts.push({
        geo: buildCorrugatedPanel({ width: bay * 0.96, height: wallH * 0.98, ribs: 1, ribDepth: 0.004, thickness: 0.03 }),
        mat: MAT.woven, tone: 0.25 + r() * 0.6, pos: [x, plinth, z],
        rot: [(r() - 0.5) * 0.02, (r() - 0.5) * 0.04, (r() - 0.5) * 0.02],
      });
    }
  }
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -D / 2 + (D / 3) * (i + 0.5);
      parts.push({
        geo: buildCorrugatedPanel({ width: (D / 3) * 0.95, height: wallH * 0.97, ribs: 1, ribDepth: 0.004, thickness: 0.028 }),
        mat: MAT.woven, tone: 0.25 + r() * 0.6, pos: [sx * W / 2, plinth, z],
        rot: [(r() - 0.5) * 0.02, Math.PI / 2 + (r() - 0.5) * 0.04, (r() - 0.5) * 0.02],
      });
    }
  }
  // The door: two planks on a frame, one of them ajar. (buildBox is CENTRED on
  // its position — placed at floor height the leaves hang through the ground.)
  const doorH = wallH * 0.86;
  parts.push({ geo: buildBox(doorW * 0.5, doorH, 0.04), pos: [-doorW * 0.26, plinth + doorH / 2, D / 2 + 0.02], rot: [0, 0.35, 0], mat: MAT.timber, tone: 0.22 });
  parts.push({ geo: buildBox(doorW * 0.48, doorH * 0.98, 0.038), pos: [doorW * 0.25, plinth + doorH * 0.49, D / 2 + 0.03], mat: MAT.timber, tone: 0.3 });

  // The roof: two long slopes, a fat ridge bundle, and a half-hip capping each
  // gable — a gable left open reads as a cardboard cut-out end.
  // A TRUE HIP: four slopes meeting one short ridge, the two sides trapezoids
  // and the two ends triangles. (This was a gable with a short "half hip" laid
  // over each end, and those ends stood off the roof as flat triangular shards
  // — the one thing in the village that looked broken.) The hip ends are
  // STEEPER than the sides, which is how a thatcher gets a decent ridge out of
  // a house that is not much longer than it is deep.
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const eaveX = W / 2 + gableOver;
  const hipRun = 1.35 * B;
  const ridgeLenHip = Math.max(1.2, (eaveX - hipRun) * 2);
  for (const side of [-1, 1]) {
    thatchAt(parts, {
      eave: V(0, eaveY, side * half), ridge: V(0, ridgeY, 0), along: V(1, 0, 0),
      width: ridgeLen, topWidth: ridgeLenHip, courses: 9, thickness: 0.15, ragged: 0.24,
      seed: seed * 7 + side,
    });
  }
  for (const sx of [-1, 1]) {
    thatchAt(parts, {
      eave: V(sx * eaveX, eaveY, 0), ridge: V(sx * (eaveX - hipRun), ridgeY, 0), along: V(0, 0, 1),
      width: half * 2, topWidth: 0.25, courses: 7, thickness: 0.14, ragged: 0.2,
      seed: seed * 11 + sx,
    });
  }
  // The ridge bundle spans the ridge and a little past each hip, where a real
  // one is rolled over and pegged down.
  const ridge = new THREE.CylinderGeometry(0.2, 0.2, ridgeLenHip + 0.5, 7).rotateZ(Math.PI / 2);
  parts.push({ geo: ridge, mat: MAT.thatch, tone: 0.1, pos: [0, ridgeY + 0.1, 0], rot: [0, 0, (r() - 0.5) * 0.01] });
  for (const sx of [-1, 1]) {
    parts.push({
      geo: new THREE.SphereGeometry(0.21, 8, 6), pos: [sx * (ridgeLenHip / 2 + 0.25), ridgeY + 0.1, 0],
      mat: MAT.thatch, tone: 0.12,
    });
  }

  // The porch: two posts carrying the front eave, and a platform of split
  // bamboo where everything in village life actually happens.
  for (const sx of [-1, 1]) pole(parts, sx * W * 0.3, D / 2 + over * 0.78, eaveY - 0.06, r, { radius: 0.05 });
  parts.push({ geo: buildBox(W * 0.78, 0.09, over * 0.72), pos: [0, 0.05, D / 2 + over * 0.42], mat: MAT.bamboo, tone: 0.42 });
  for (let i = 0; i < 6; i++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.035, 0.034, over * 0.7, 6).rotateX(Math.PI / 2),
      pos: [-W * 0.34 + i * (W * 0.68 / 5), 0.12, D / 2 + over * 0.42], mat: MAT.bamboo, tone: 0.3 + r() * 0.5,
    });
  }
  // A bench along the front wall, and the jar by the door.
  parts.push({ geo: buildBox(1.5 * B, 0.07, 0.36 * B), pos: [-W * 0.18, plinth + 0.42, D / 2 + 0.3], mat: MAT.timber, tone: 0.3 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.08, 0.42, 0.3 * B), pos: [-W * 0.18 + sx * 0.62 * B, plinth + 0.21, D / 2 + 0.3], mat: MAT.timber, tone: 0.26 });
  parts.push({ geo: jarGeometry(0.34 * B, r), pos: [W * 0.36, plinth, D / 2 + 0.34], mat: MAT.concrete, tone: 0.3 + r() * 0.2 });

  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: 0.5, groundFade: 0.32, floor: 0.46 });
  geo.userData.footprint = { cx: 0, cz: 0.2, hx: W / 2 + 0.35, hz: D / 2 + 0.6 };
  geo.userData.height = ridgeY + 0.3;
  return geo;
}

/** The belly profile of a glazed water jar, `h` tall — lathed, so it is round. */
function jarGeometry(h, r) {
  const wob = 0.94 + r() * 0.12;
  const prof = [[0.0, 0], [0.26, 0.02], [0.3, 0.1], [0.42, 0.34], [0.44, 0.5], [0.36, 0.76], [0.27, 0.9], [0.3, 0.97], [0.26, 1]]
    .map(([x, y]) => new THREE.Vector2(x * h * wob, y * h));
  return new THREE.LatheGeometry(prof, 12);
}

// ── Rice granary ─────────────────────────────────────────────────────────────
/**
 * The rice store, and the most distinctive silhouette in a hamlet: a round
 * woven bin lifted clear of the ground on four short legs, each capped with a
 * RAT GUARD — the flat disc that stops anything climbing the leg — under a
 * conical thatch cap. Nothing else on the map is a cone on legs.
 */
export function buildGranary({ seed = 5 } = {}) {
  const r = rng(seed);
  const parts = [];
  const legH = 0.62 * B, binR = 0.95 * B, binH = 1.25 * B;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const x = sx * binR * 0.62, z = sz * binR * 0.62;
    parts.push({ geo: new THREE.CylinderGeometry(0.075, 0.085, legH, 7), pos: [x, legH / 2, z], mat: MAT.timber, tone: 0.2 + r() * 0.2 });
    // The rat guard: a disc the animal cannot get round.
    parts.push({ geo: new THREE.CylinderGeometry(0.3, 0.26, 0.035, 12), pos: [x, legH + 0.02, z], mat: MAT.metal, tone: 0.45 + r() * 0.3 });
  }
  // The floor and the woven bin above it.
  parts.push({ geo: new THREE.CylinderGeometry(binR * 0.98, binR * 0.98, 0.08, 14), pos: [0, legH + 0.08, 0], mat: MAT.timber, tone: 0.26 });
  parts.push({ geo: new THREE.CylinderGeometry(binR, binR * 0.92, binH, 14, 1, true), pos: [0, legH + 0.12 + binH / 2, 0], mat: MAT.woven, tone: 0.34 + r() * 0.4 });
  // Bamboo hoops binding it, top and bottom.
  for (const t of [0.12, 0.55, 0.92]) {
    parts.push({
      geo: new THREE.TorusGeometry(binR * (1 - t * 0.06) + 0.02, 0.035, 5, 14).rotateX(Math.PI / 2),
      pos: [0, legH + 0.12 + binH * t, 0], mat: MAT.bamboo, tone: 0.4 + r() * 0.3,
    });
  }
  // The cap: a cone of thatch courses, steeper than it needs to be, with a
  // tuft tied at the point.
  const capR = binR + 0.34, capH = 0.95 * B;
  for (let c = 0; c < 5; c++) {
    const t = c / 5;
    parts.push({
      geo: new THREE.ConeGeometry(capR * (1 - t * 0.82), capH * 0.34, 14, 1, true),
      pos: [0, legH + 0.12 + binH + capH * t * 0.78 + 0.1, 0], mat: MAT.thatch, tone: 0.25 + r() * 0.5,
    });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.11, 0.26, 7), pos: [0, legH + 0.12 + binH + capH * 0.86, 0], mat: MAT.thatch, tone: 0.2 });
  // A short ladder leaning on it, because the door is above head height.
  for (const sx of [-1, 1]) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.04, 0.04, legH + binH * 0.9, 6), pos: [sx * 0.2, (legH + binH * 0.9) / 2, binR + 0.3],
      rot: [-0.22, 0, 0], mat: MAT.bamboo, tone: 0.45,
    });
  }
  for (let k = 0; k < 4; k++) {
    const y = 0.28 + k * 0.36;
    parts.push({ geo: new THREE.CylinderGeometry(0.03, 0.03, 0.46, 5).rotateZ(Math.PI / 2), pos: [0, y, binR + 0.3 + (y - (legH + binH * 0.9) / 2) * 0.22], mat: MAT.bamboo, tone: 0.5 });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.14, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: capR, hz: capR };
  geo.userData.height = legH + binH + capH + 0.3;
  return geo;
}

// ── The well ─────────────────────────────────────────────────────────────────
/**
 * The well: where a hamlet's paths meet and where its people stand. A kerb of
 * mortared brick (laid as separate blocks — a smooth ring reads as concrete
 * pipe), a bamboo A-frame, a rope over the crossbar, the bucket sitting on the
 * kerb, and the spill of wet dark earth everyone's feet have made round it.
 */
export function buildWell({ seed = 7 } = {}) {
  const r = rng(seed);
  const parts = [];
  const rIn = 0.62 * B, kerbH = 0.52 * B;
  // The trodden apron, a hair proud of the ground so it never z-fights.
  parts.push({ geo: new THREE.CylinderGeometry(rIn + 1.5, rIn + 1.7, 0.05, 18), pos: [0, 0.025, 0], mat: MAT.earth, tone: 0.22 });
  // Kerb blocks, each its own brick with its own lean.
  const n = 16;
  for (let k = 0; k < n; k++) {
    for (let course = 0; course < 3; course++) {
      const a = (k / n) * Math.PI * 2 + course * 0.1;
      const rr = rIn + 0.14 - course * 0.012;
      parts.push({
        geo: buildBox(0.3 - course * 0.01, kerbH / 3 - 0.01, 0.26),
        pos: [Math.sin(a) * rr, 0.05 + kerbH / 6 + course * (kerbH / 3), Math.cos(a) * rr],
        rot: [(r() - 0.5) * 0.05, -a + (r() - 0.5) * 0.06, (r() - 0.5) * 0.06],
        mat: MAT.brick ?? MAT.concrete, tone: 0.24 + r() * 0.5,
      });
    }
  }
  // The dark of the shaft, drawn just inside the kerb: a hole in the ground
  // cannot be dug downward (the terrain is not excavated), so it is a dark disc
  // sunk a little below the kerb top.
  parts.push({ geo: new THREE.CylinderGeometry(rIn - 0.02, rIn - 0.1, 0.5, 14), pos: [0, 0.05 + kerbH * 0.5 - 0.26, 0], mat: MAT.steel, tone: 0.02 });
  // A-frame over it, the crossbar, the rope and the bucket.
  const topY = 1.9 * B;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (rIn + 0.5), z = sz * 0.42;
      const len = Math.hypot(topY, rIn + 0.5);
      const geo = new THREE.CylinderGeometry(0.055, 0.065, len, 7);
      const dir = new THREE.Vector3(-x, topY, -z * 0.5).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      const m = new THREE.Matrix4().compose(new THREE.Vector3(x / 2, topY / 2, z * 0.75), q, new THREE.Vector3(1, 1, 1));
      parts.push({ geo, matrix: m, mat: MAT.bamboo, tone: 0.3 + r() * 0.4 });
    }
  }
  rail(parts, -0.5, 0, 0.5, 0, topY, r, { radius: 0.05 });
  parts.push({ geo: new THREE.CylinderGeometry(0.012, 0.012, topY * 0.55, 5), pos: [0.1, topY - topY * 0.28, 0], mat: MAT.timber, tone: 0.15 });
  // The bucket, on the kerb where it was left.
  parts.push({ geo: new THREE.CylinderGeometry(0.2, 0.17, 0.3, 10, 1, true), pos: [rIn * 0.75, 0.05 + kerbH + 0.15, 0.3], rot: [0.06, 0, 0.1], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: new THREE.TorusGeometry(0.2, 0.018, 4, 10).rotateX(Math.PI / 2), pos: [rIn * 0.75, 0.05 + kerbH + 0.29, 0.3], mat: MAT.metal, tone: 0.4 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.16, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: rIn + 0.8, hz: rIn + 0.8 };
  geo.userData.height = topY + 0.2;
  return geo;
}

// ── Spirit shrine ────────────────────────────────────────────────────────────
/**
 * The bàn thờ ông thiên — a miniature house on a post in the yard, for the
 * spirits of the land. Tiny, and worth every triangle: it is the one piece
 * that says somebody's grandmother lives here.
 */
export function buildShrine({ seed = 11 } = {}) {
  const r = rng(seed);
  const parts = [];
  const postH = 1.15 * B, w = 0.62 * B, d = 0.5 * B, h = 0.44 * B;
  parts.push({ geo: buildBox(0.16, postH, 0.16), pos: [0, postH / 2, 0], mat: MAT.timber, tone: 0.24 });
  parts.push({ geo: buildBox(w + 0.12, 0.07, d + 0.12), pos: [0, postH + 0.035, 0], mat: MAT.timber, tone: 0.3 });
  // The little house: three walls, an open front, a tiled roof in two slopes.
  parts.push({ geo: buildBox(w, h, 0.04), pos: [0, postH + 0.07 + h / 2, -d / 2], mat: MAT.stucco, tone: 0.55 + r() * 0.3 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.04, h - 0.01, d * 0.96), pos: [sx * w / 2, postH + 0.07 + h / 2, 0], mat: MAT.stucco, tone: 0.5 + r() * 0.3 });
  for (const sx of [-1, 1]) {
    parts.push({
      geo: buildBox(w * 0.62, 0.05, d * 1.3), pos: [sx * w * 0.28, postH + 0.07 + h + 0.1, 0],
      rot: [0, 0, sx * 0.55], mat: MAT.tile, tone: 0.35 + r() * 0.35,
    });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, w * 0.7, 6).rotateZ(Math.PI / 2), pos: [0, postH + 0.07 + h + 0.24, 0], mat: MAT.tile, tone: 0.3 });
  // Offerings: a bowl, three sticks of incense, a scrap of red cloth.
  parts.push({ geo: new THREE.CylinderGeometry(0.09, 0.07, 0.07, 10), pos: [0, postH + 0.1, 0.06], mat: MAT.concrete, tone: 0.6 });
  for (let k = 0; k < 3; k++) {
    parts.push({ geo: new THREE.CylinderGeometry(0.008, 0.008, 0.26, 4), pos: [(k - 1) * 0.035, postH + 0.23, 0.06], rot: [0, 0, (k - 1) * 0.06], mat: MAT.timber, tone: 0.1 });
  }
  parts.push({ geo: buildBox(0.18, 0.012, 0.2), pos: [-w * 0.2, postH + 0.085, -0.04], rot: [0, 0.3, 0], mat: MAT.paint, tone: 0.75 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.1, radius: 1, strength: 0.3, groundFade: 0.25, floor: 0.55 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: w * 0.8, hz: d * 0.8 };
  geo.userData.height = postH + h + 0.4;
  return geo;
}

// ── Fences ───────────────────────────────────────────────────────────────────
/**
 * A run of village fence, `length` metres along X, built at the origin's centre
 * so it can be dropped anywhere and turned. Bamboo uprights, three rails, and
 * split canes woven between them — the thing that turns open ground into
 * yards, lanes and a pig pen, and the reason a hamlet reads as an arrangement
 * rather than as houses on grass.
 */
export function buildFence({ length = 6, seed = 13, height = 1.1, gate = false } = {}) {
  const r = rng(seed);
  const parts = [];
  const h = height * B * 0.72;
  const posts = Math.max(2, Math.round(length / 1.5));
  const step = length / posts;
  for (let i = 0; i <= posts; i++) {
    const x = -length / 2 + i * step;
    pole(parts, x, 0, h * (0.98 + r() * 0.12), r, { radius: 0.05, lean: 0.05 });
  }
  for (const t of [0.32, 0.72]) rail(parts, -length / 2, 0, length / 2, 0, h * t, r, { radius: 0.035 });
  // The infill: split canes standing between the rails, gappy and uneven,
  // skipping a stretch in the middle when this run is a gateway.
  const canes = Math.round(length * 3.4);
  for (let i = 0; i < canes; i++) {
    const x = -length / 2 + (i + 0.5) * (length / canes) + (r() - 0.5) * 0.06;
    if (gate && Math.abs(x) < length * 0.14) continue;
    if (r() < 0.06) continue;                                  // one missing here and there
    parts.push({
      geo: new THREE.CylinderGeometry(0.022, 0.02, h * (0.72 + r() * 0.26), 5),
      pos: [x, h * (0.36 + r() * 0.1), (r() - 0.5) * 0.035],
      rot: [(r() - 0.5) * 0.07, 0, (r() - 0.5) * 0.09], mat: MAT.bamboo, tone: 0.28 + r() * 0.55,
    });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.12, radius: 1, strength: 0.28, groundFade: 0.3, floor: 0.58 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: length / 2, hz: 0.25 };
  geo.userData.height = h;
  return geo;
}

// ── Yard clutter ─────────────────────────────────────────────────────────────
/** Water jars and a wash basin by a doorway — three sizes, none of them square on. */
export function buildJarCluster({ seed = 17 } = {}) {
  const r = rng(seed);
  const parts = [];
  const spots = [[0, 0, 0.74], [0.62, 0.22, 0.52], [0.28, -0.55, 0.4]];
  for (const [x, z, h] of spots) {
    parts.push({ geo: jarGeometry(h * B, r), pos: [x * B, 0, z * B], rot: [0, r() * 3, (r() - 0.5) * 0.04], mat: MAT.concrete, tone: 0.2 + r() * 0.4 });
  }
  // A wooden lid on the big one, and a dipper hooked over the rim.
  parts.push({ geo: new THREE.CylinderGeometry(0.22 * B, 0.21 * B, 0.03, 10), pos: [0, 0.74 * B + 0.01, 0.74 * B * 0 + 0], mat: MAT.timber, tone: 0.3 });
  parts.push({ geo: new THREE.CylinderGeometry(0.1, 0.09, 0.09, 8), pos: [0.62 * B + 0.16, 0.52 * B, 0.22 * B], rot: [0.3, 0, 0], mat: MAT.concrete, tone: 0.5 });
  // The aluminium basin everybody washes in, upended against them.
  parts.push({
    geo: new THREE.CylinderGeometry(0.42, 0.34, 0.14, 14, 1, true), pos: [-0.62 * B, 0.3, -0.18 * B],
    rot: [1.35, 0.4, 0], mat: MAT.metal, tone: 0.72,
  });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.1, radius: 1, strength: 0.35, groundFade: 0.28, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.1 * B, hz: 0.95 * B };
  geo.userData.height = 0.8 * B;
  return geo;
}

/**
 * A drying rack: the flat woven trays of rice, chillies and split fish that
 * stand in every yard. Colour is the point — the chillies are the only red on
 * the map that is not a health bar.
 */
export function buildDryingRack({ seed = 19 } = {}) {
  const r = rng(seed);
  const parts = [];
  const w = 2.1 * B * 0.8, d = 1.15 * B * 0.8, top = 0.72 * B;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    pole(parts, sx * w / 2, sz * d / 2, top, r, { radius: 0.045 });
  }
  for (const sz of [-1, 1]) rail(parts, -w / 2, sz * d / 2, w / 2, sz * d / 2, top - 0.06, r, { radius: 0.035 });
  // The tray, and the mats laid on it.
  parts.push({ geo: buildBox(w * 0.98, 0.04, d * 0.96), pos: [0, top, 0], mat: MAT.woven, tone: 0.44 });
  parts.push({ geo: buildBox(w * 0.52, 0.035, d * 0.72), pos: [-w * 0.2, top + 0.04, 0.02], rot: [0, 0.05, 0], mat: MAT.thatch, tone: 0.62 });
  // Chillies: a scatter of small red beans on the near half.
  for (let k = 0; k < 26; k++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.018, 0.012, 0.11, 4).rotateZ(Math.PI / 2),
      pos: [w * (0.06 + r() * 0.36), top + 0.055, (r() - 0.5) * d * 0.78],
      rot: [0, r() * 3, 0], mat: MAT.paint, tone: 0.86 + r() * 0.1,
    });
  }
  // Fish split and hung from a pole between the near posts.
  rail(parts, -w / 2, -d / 2, w / 2, -d / 2, top + 0.52, r, { radius: 0.03 });
  for (let k = 0; k < 5; k++) {
    parts.push({
      geo: buildBox(0.1, 0.3, 0.02), pos: [-w * 0.34 + k * (w * 0.17), top + 0.34, -d / 2 - 0.02],
      rot: [0, 0, (r() - 0.5) * 0.25], mat: MAT.hessian, tone: 0.7 + r() * 0.2,
    });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.12, radius: 1, strength: 0.32, groundFade: 0.3, floor: 0.54 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: w / 2 + 0.1, hz: d / 2 + 0.1 };
  geo.userData.height = top + 0.6;
  return geo;
}

/**
 * A rice-straw rick round a central pole: the round golden haystack that
 * stands beside every delta house after the harvest, built as thatch courses
 * so it layers instead of reading as a cone primitive.
 */
export function buildStrawRick({ seed = 23 } = {}) {
  const r = rng(seed);
  const parts = [];
  const h = 1.85 * B * 0.8, rad = 0.95 * B * 0.8;
  parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.06, h * 1.12, 6), pos: [0, h * 0.56, 0], mat: MAT.bamboo, tone: 0.3 });
  const courses = 7;
  for (let c = 0; c < courses; c++) {
    const t = c / courses;
    const rr = rad * Math.sin((1 - t * 0.92) * Math.PI * 0.5) * (0.96 + r() * 0.08);
    parts.push({
      geo: new THREE.ConeGeometry(rr, h * 0.3, 13, 1, true),
      pos: [0, h * (t * 0.86 + 0.08), 0], rot: [(r() - 0.5) * 0.04, r() * 3, (r() - 0.5) * 0.04],
      mat: MAT.thatch, tone: 0.5 + r() * 0.45,
    });
  }
  // The tuft tied off at the top, and loose straw kicked round the foot.
  parts.push({ geo: new THREE.ConeGeometry(0.16, 0.34, 8), pos: [0, h * 0.99, 0], mat: MAT.thatch, tone: 0.42 });
  for (let k = 0; k < 5; k++) {
    const a = r() * 6.28, rr = rad * (1.05 + r() * 0.45);
    parts.push({
      geo: buildBox(0.5 + r() * 0.4, 0.04, 0.2), pos: [Math.sin(a) * rr, 0.03 + r() * 0.02, Math.cos(a) * rr],
      rot: [0, a + (r() - 0.5), (r() - 0.5) * 0.1], mat: MAT.thatch, tone: 0.55 + r() * 0.35,
    });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.14, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: rad * 1.1, hz: rad * 1.1 };
  geo.userData.height = h + 0.3;
  return geo;
}

/**
 * The cooking hearth: three stones, a blackened pot, a stack of firewood, a
 * low stool and the ash everyone's cooking has left. Its smoke is the village's
 * best ambient effect, and namGame can hang one off this point.
 */
export function buildCookHearth({ seed = 29 } = {}) {
  const r = rng(seed);
  const parts = [];
  parts.push({ geo: new THREE.CylinderGeometry(0.62, 0.7, 0.05, 14), pos: [0, 0.025, 0], mat: MAT.earth, tone: 0.16 });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.4;
    parts.push({
      geo: new THREE.SphereGeometry(0.16, 7, 5).scale(1, 0.8, 1.1), pos: [Math.sin(a) * 0.3, 0.09, Math.cos(a) * 0.3],
      rot: [(r() - 0.5) * 0.3, r() * 3, (r() - 0.5) * 0.3], mat: MAT.concrete, tone: 0.1 + r() * 0.15,
    });
  }
  // Charred wood between them, and the pot over it all.
  for (let k = 0; k < 4; k++) {
    const a = r() * 6.28;
    parts.push({
      geo: new THREE.CylinderGeometry(0.035, 0.03, 0.5 + r() * 0.2, 5).rotateZ(Math.PI / 2),
      pos: [Math.sin(a) * 0.1, 0.06, Math.cos(a) * 0.1], rot: [0, a, 0.04], mat: MAT.timber, tone: 0.05 + r() * 0.1,
    });
  }
  parts.push({ geo: new THREE.SphereGeometry(0.28, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62).scale(1, 0.85, 1), pos: [0, 0.32, 0], mat: MAT.steel, tone: 0.06 });
  parts.push({ geo: new THREE.TorusGeometry(0.27, 0.022, 4, 12).rotateX(Math.PI / 2), pos: [0, 0.35, 0], mat: MAT.steel, tone: 0.12 });
  // Firewood stacked to one side, and the stool.
  for (let k = 0; k < 7; k++) {
    parts.push({
      geo: new THREE.CylinderGeometry(0.045, 0.04, 0.8, 5).rotateZ(Math.PI / 2),
      pos: [-1.05 + (k % 3) * 0.02, 0.05 + ((k / 3) | 0) * 0.09, -0.5 + (k % 3) * 0.1],
      rot: [0, 0.2 + (r() - 0.5) * 0.3, (r() - 0.5) * 0.06], mat: MAT.timber, tone: 0.2 + r() * 0.3,
    });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.17, 0.16, 0.05, 10), pos: [0.85, 0.3, 0.3], mat: MAT.timber, tone: 0.34 });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    parts.push({ geo: new THREE.CylinderGeometry(0.025, 0.028, 0.3, 5), pos: [0.85 + Math.sin(a) * 0.11, 0.15, 0.3 + Math.cos(a) * 0.11], rot: [Math.cos(a) * 0.1, 0, -Math.sin(a) * 0.1], mat: MAT.timber, tone: 0.28 });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.1, radius: 1, strength: 0.35, groundFade: 0.25, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.3, hz: 0.9 };
  geo.userData.height = 0.7;
  return geo;
}

/**
 * The ox cart: two tall spoked wheels, a plank bed with slatted rails, and the
 * shafts and yoke resting on the ground where it was unhitched. The one piece
 * of village machinery, and a good silhouette from above.
 */
export function buildOxCart({ seed = 31 } = {}) {
  const r = rng(seed);
  const parts = [];
  const wheelR = 0.62 * B, axleY = wheelR, bedW = 1.05 * B, bedL = 1.9 * B;
  for (const sx of [-1, 1]) {
    const x = sx * (bedW / 2 + 0.12);
    parts.push({ geo: new THREE.TorusGeometry(wheelR, 0.06, 5, 16).rotateY(Math.PI / 2), pos: [x, axleY, 0], mat: MAT.timber, tone: 0.24 + r() * 0.2 });
    parts.push({ geo: new THREE.CylinderGeometry(0.13, 0.13, 0.16, 10).rotateZ(Math.PI / 2), pos: [x, axleY, 0], mat: MAT.timber, tone: 0.3 });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + sx * 0.2;
      parts.push({
        geo: new THREE.CylinderGeometry(0.028, 0.03, wheelR * 0.94, 5), pos: [x, axleY + Math.sin(a) * wheelR * 0.47, Math.cos(a) * wheelR * 0.47],
        rot: [a + Math.PI / 2, 0, Math.PI / 2], mat: MAT.timber, tone: 0.2 + r() * 0.35,
      });
    }
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, bedW + 0.34, 7).rotateZ(Math.PI / 2), pos: [0, axleY, 0], mat: MAT.timber, tone: 0.22 });
  // The bed: planks, each its own width, and the rails around three sides.
  for (let k = 0; k < 5; k++) {
    parts.push({
      geo: buildBox(bedW / 5 - 0.02, 0.05, bedL * (0.98 - (k % 2) * 0.02)), pos: [-bedW / 2 + (k + 0.5) * (bedW / 5), axleY + 0.14, 0],
      mat: MAT.timber, tone: 0.24 + r() * 0.35,
    });
  }
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 6; k++) {
      parts.push({ geo: new THREE.CylinderGeometry(0.026, 0.026, 0.42, 5), pos: [sx * bedW / 2, axleY + 0.36, -bedL / 2 + 0.16 + k * (bedL - 0.32) / 5], mat: MAT.timber, tone: 0.3 });
    }
    // The top rail runs down ITS OWN SIDE — written without the `sx` it was
    // built twice in the same place, one rail exactly inside the other.
    rail(parts, sx * bedW / 2, -bedL / 2 + 0.16, sx * bedW / 2, bedL / 2 - 0.16, axleY + 0.56, r, { radius: 0.034 });
  }
  parts.push({ geo: buildBox(bedW * 0.96, 0.4, 0.05), pos: [0, axleY + 0.36, -bedL / 2], mat: MAT.timber, tone: 0.26 });
  // Shafts down to the ground, and the yoke across their ends.
  for (const sx of [-1, 1]) {
    const len = 1.9 * B;
    const geo = new THREE.CylinderGeometry(0.05, 0.045, len, 6);
    const from = new THREE.Vector3(sx * bedW * 0.36, axleY + 0.12, bedL / 2 - 0.1);
    const to = new THREE.Vector3(sx * bedW * 0.3, 0.1, bedL / 2 + len * 0.94);
    const dir = to.clone().sub(from).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    parts.push({ geo, matrix: new THREE.Matrix4().compose(from.clone().add(to).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)) });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.06, 0.055, bedW * 0.9, 6).rotateZ(Math.PI / 2), pos: [0, 0.12, bedL / 2 + 1.75 * B], rot: [0, 0, 0.03], mat: MAT.timber, tone: 0.2 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.12, radius: 1, strength: 0.35, groundFade: 0.3, floor: 0.5 });
  geo.userData.footprint = { cx: 0, cz: 0.4, hx: bedW / 2 + 0.3, hz: bedL };
  geo.userData.height = axleY + 0.7;
  return geo;
}

// ── What people planted ──────────────────────────────────────────────────────
/**
 * A hamlet is not a clearing with houses in it: it is GREEN. Bamboo stands
 * round the edge of it (planted as a windbreak, a fence and a building supply
 * at once) and banana grows in every back yard. Both are built here as KIT
 * pieces rather than as painted jungle, because they belong to the village's
 * arrangement — they stand where somebody put them — and because that keeps
 * them in the same merged draw as the houses.
 */
export function buildBambooClump({ seed = 37, poles = 11 } = {}) {
  const r = rng(seed);
  const parts = [];
  for (let k = 0; k < poles; k++) {
    const a = (k / poles) * Math.PI * 2 + r() * 0.8;
    const rad = (0.1 + r() * 0.75) * B;
    const x = Math.sin(a) * rad, z = Math.cos(a) * rad;
    const h = (3.4 + r() * 2.6) * B * 0.62;
    const lean = 0.03 + rad * 0.06;
    parts.push({
      geo: buildBambooPole({ height: h, radius: 0.045 + r() * 0.02, internodes: Math.round(h * 1.6), taper: 0.5, seg: 6 }),
      mat: MAT.bamboo, tone: 0.35 + r() * 0.5,
      pos: [x, 0, z], rot: [Math.cos(a) * -lean, r() * 6.28, Math.sin(a) * lean],
    });
    // Leaf sprays down the top third: thin blades in the camo sheet's greens,
    // the only green in a full atlas (rtsEnemyKit's cut branches, same trick).
    const sprays = 3 + Math.floor(r() * 3);
    for (let s = 0; s < sprays; s++) {
      const t = 0.62 + (s / sprays) * 0.36;
      const y = h * t, sa = r() * 6.28;
      for (let b = 0; b < 3; b++) {
        const len = (0.5 + r() * 0.5) * B;
        parts.push({
          geo: buildBox(0.055, 0.012, len).translate(0, 0, len / 2),
          mat: MAT.camo, tone: 0.45 + r() * 0.4,
          // Every blade its own roll and its own centimetre of height: two
          // blades that happen to land in one plane z-fight, and with a hundred
          // of them per clump that happens by chance.
          pos: [x + Math.sin(a) * y * lean * 0.5, y + (r() - 0.5) * 0.14, z + Math.cos(a) * y * lean * 0.5],
          rot: [-0.25 - r() * 0.5, sa + b * 2.1 + r() * 0.4, (r() - 0.5) * 0.5],
        });
      }
    }
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.16, radius: 2, strength: 0.3, groundFade: 0.4, floor: 0.55 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.1 * B, hz: 1.1 * B };
  geo.userData.height = 4.5 * B;
  return geo;
}

/**
 * A stand of banana: fat pseudostems with big paddle leaves spiralling off the
 * top, the newest standing up as a rolled spear, the oldest hanging below
 * horizontal and torn. The leaves are what read from the RTS camera — long,
 * wide and at every angle — so they are drawn as full-length blades rather
 * than as a canopy blob.
 */
export function buildBananaClump({ seed = 41, plants = 3 } = {}) {
  const r = rng(seed);
  const parts = [];
  for (let p = 0; p < plants; p++) {
    const a = (p / plants) * Math.PI * 2 + r();
    const rad = p === 0 ? 0 : (0.5 + r() * 0.5) * B;
    const px = Math.sin(a) * rad, pz = Math.cos(a) * rad;
    const h = (1.0 + r() * 0.6) * B;   // a banana is 2-4 m, not a tree
    parts.push({
      geo: new THREE.CylinderGeometry(0.1 * B, 0.17 * B, h, 9), pos: [px, h / 2, pz],
      rot: [(r() - 0.5) * 0.08, 0, (r() - 0.5) * 0.08], mat: MAT.bamboo, tone: 0.5 + r() * 0.3,
    });
    const leaves = 7 + Math.floor(r() * 3);
    for (let k = 0; k < leaves; k++) {
      const age = k / leaves;                       // 0 newest (up) → 1 oldest (hanging)
      const len = (0.85 + r() * 0.45) * B * (1 - age * 0.2);
      const pitch = -1.25 + age * 1.9 + r() * 0.2;  // up, then out, then down
      const yaw = k * 2.39 + r() * 0.3;             // a spiral, not a whorl
      parts.push({
        geo: buildBox(0.34 * B * (0.8 + r() * 0.4), 0.025, len).translate(0, 0, len / 2),
        mat: MAT.camo, tone: age > 0.85 ? 0.2 + r() * 0.15 : 0.5 + r() * 0.45,
        pos: [px, h * (0.94 - age * 0.06), pz], rot: [pitch, yaw, (r() - 0.5) * 0.3],
      });
    }
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.16, radius: 2, strength: 0.3, groundFade: 0.4, floor: 0.55 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.3 * B, hz: 1.3 * B };
  geo.userData.height = 2.8 * B;
  return geo;
}

/**
 * The pig pen: a low woven hurdle round a patch of churned mud, a lean-to of
 * thatch in the corner for shade, and the trough. Every house has one, and it
 * is the piece that makes a yard read as a working yard.
 */
export function buildPigPen({ seed = 43 } = {}) {
  const r = rng(seed);
  const parts = [];
  const w = 3.2 * B * 0.7, d = 2.4 * B * 0.7, h = 0.62 * B;
  parts.push({ geo: new THREE.CylinderGeometry(w * 0.62, w * 0.66, 0.05, 14).scale(1, 1, d / w), pos: [0, 0.025, 0], mat: MAT.earth, tone: 0.14 });
  // The hurdles: uprights and two rails a side, with the gate side left low.
  for (const [dx, dz, len, rot] of [[0, -d / 2, w, 0], [0, d / 2, w, 0], [-w / 2, 0, d, Math.PI / 2], [w / 2, 0, d, Math.PI / 2]]) {
    const n = Math.max(2, Math.round(len / 0.9));
    for (let i = 0; i <= n; i++) {
      const t = -len / 2 + (i * len) / n;
      const x = dx + (rot ? 0 : t), z = dz + (rot ? t : 0);
      pole(parts, x, z, h * (0.9 + r() * 0.2), r, { radius: 0.04, lean: 0.06 });
    }
    for (const t of [0.4, 0.78]) {
      const c = Math.cos(rot), s = Math.sin(rot);
      rail(parts, dx - (len / 2) * c, dz - (len / 2) * s, dx + (len / 2) * c, dz + (len / 2) * s, h * t, r, { radius: 0.03 });
    }
  }
  // The lean-to: four short posts and a thatch slope over the far corner.
  const sx = -w * 0.28, sz = -d * 0.24, sw = w * 0.42, sd = d * 0.44;
  for (const ox of [-1, 1]) for (const oz of [-1, 1]) {
    pole(parts, sx + ox * sw / 2, sz + oz * sd / 2, 0.85 * B + oz * 0.12, r, { radius: 0.045 });
  }
  thatchAt(parts, {
    eave: new THREE.Vector3(sx, 0.78 * B, sz + sd / 2 + 0.2), ridge: new THREE.Vector3(sx, 0.95 * B, sz - sd / 2),
    along: new THREE.Vector3(1, 0, 0), width: sw + 0.4, courses: 4, thickness: 0.1, ragged: 0.25, seed,
    tone: 0.16, toneSpread: 0.4,
  });
  // The trough, and the mud wallow.
  parts.push({ geo: buildBox(0.9 * B, 0.18, 0.3 * B), pos: [w * 0.22, 0.09, d * 0.2], rot: [0, 0.2, 0], mat: MAT.timber, tone: 0.22 });
  parts.push({ geo: new THREE.SphereGeometry(0.5, 10, 6).scale(1.3, 0.06, 1), pos: [w * 0.05, 0.03, d * 0.1], mat: MAT.earth, tone: 0.06 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.12, radius: 1, strength: 0.32, groundFade: 0.3, floor: 0.54 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: w / 2 + 0.2, hz: d / 2 + 0.2 };
  geo.userData.height = 1.1 * B;
  return geo;
}

/**
 * A washing line between two poles. Two hundred triangles, and the only strong
 * colour in the hamlet that is not a health bar — which is exactly why it is
 * worth having: the eye finds the village by it.
 */
export function buildWashingLine({ seed = 47 } = {}) {
  const r = rng(seed);
  const parts = [];
  const span = 4.2 * B * 0.8, hy = 1.5 * B * 0.8;
  for (const sx of [-1, 1]) pole(parts, sx * span / 2, sx * 0.1, hy + sx * 0.05, r, { radius: 0.05 });
  parts.push({ geo: buildBox(span, 0.012, 0.012), pos: [0, hy - 0.08, 0.05], rot: [0, 0.03, -0.01], mat: MAT.steel, tone: 0.2 });
  const n = 5 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const x = -span * 0.4 + (k * span * 0.8) / (n - 1) + (r() - 0.5) * 0.15;
    const w = (0.3 + r() * 0.3) * B, h = (0.4 + r() * 0.45) * B;
    parts.push({
      geo: buildBox(w, h, 0.02).translate(0, -h / 2, 0), pos: [x, hy - 0.1, 0.05 + (r() - 0.5) * 0.04],
      rot: [(r() - 0.5) * 0.1, (r() - 0.5) * 0.25, (r() - 0.5) * 0.12],
      // Whites, indigo work shirts and one red — a village line, not a flag.
      mat: r() < 0.45 ? MAT.white : MAT.paint, tone: 0.2 + r() * 0.75,
    });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.1, radius: 1, strength: 0.25, groundFade: 0.2, floor: 0.6 });
  geo.userData.footprint = { cx: 0, cz: 0, hx: span / 2 + 0.2, hz: 0.4 };
  geo.userData.height = hy + 0.2;
  return geo;
}
