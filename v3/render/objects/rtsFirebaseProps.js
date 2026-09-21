/**
 * FIREBASE PROPS — the clutter of a US firebase, built from the parts kit.
 *
 * WHAT THE FIRST ATTEMPTS TAUGHT (two of them, both judged in the game):
 *
 *   · Build at the game's scale. Units are real size x 1.3 (nam-rts
 *     unitTypes.js RTS_SCALE), so props are too; at real size they looked like
 *     toys beside a soldier and were ~8 px wide from the RTS camera.
 *   · Build GROUPS, not single items. A drum is 8 px from above; a fuel dump of
 *     ten on pallets is a shape a player reads. Single pieces are for close-up
 *     and for the orbit camera; the kit's job is the group.
 *   · Build from parts with weight — frames, braces, battens, rims — the way
 *     the Quonset HQ is, not from thin planes: that is what the user judged the
 *     HQ better than every object in the objects lab.
 *   · Wear only where things wear. Rust over the whole of a drum read as
 *     camouflage, then as granite; paint stays clean except at the foot.
 *
 * Every piece is ONE merged geometry on the kit's ONE atlas material
 * (rtsObjectMaterial: per-vertex matId → surface), so a placed piece of any
 * kind is one draw and, instanced, a hundred of them are still one. The sign is
 * the exception — it carries lettering — and has its own small material.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  MAT, assemble, bakeContactAO, buildCorrugatedPanel, buildLadder, buildSandbagRing, buildSandbagWall, rng, triCount,
} from "./rtsParts.js";
import { rtsObjectMaterial } from "./rtsObjectProps.js";

/** Real size x this — the same factor as the game's units. */
export const PROP_SCALE = 1.3;
const S = PROP_SCALE;

// ── The drum: a better part than the kit's plain cylinder ────────────────────
/**
 * A 55-gallon drum: 0.572 m across, 0.851 m tall (real), with the rolled chime
 * at each end and two rolling hoops — the silhouette that says "drum" from
 * above. A lathe, so it is closed (no single-sided rings) and v runs up it,
 * which puts the paint's rust tidemark at the foot.
 */
function drumGeometry(seg = 14) {
  const r = 0.286 * S, h = 0.851 * S, pts = [];
  const hoop = (y) => { pts.push(new THREE.Vector2(r, y - 0.022 * S), new THREE.Vector2(r + 0.014 * S, y), new THREE.Vector2(r, y + 0.022 * S)); };
  pts.push(new THREE.Vector2(0.001, 0.012 * S));
  pts.push(new THREE.Vector2(r - 0.02 * S, 0.012 * S));
  pts.push(new THREE.Vector2(r + 0.008 * S, 0));
  pts.push(new THREE.Vector2(r + 0.01 * S, 0.025 * S));
  pts.push(new THREE.Vector2(r, 0.04 * S));
  hoop(h * 0.33);
  hoop(h * 0.67);
  pts.push(new THREE.Vector2(r, h - 0.04 * S));
  pts.push(new THREE.Vector2(r + 0.01 * S, h - 0.025 * S));
  pts.push(new THREE.Vector2(r + 0.008 * S, h));
  pts.push(new THREE.Vector2(r - 0.02 * S, h - 0.012 * S));
  pts.push(new THREE.Vector2(0.001, h - 0.012 * S));
  const g = new THREE.LatheGeometry(pts, seg);
  // Lathe UVs run 0..1 up the profile, which already puts v = 0 at the foot.
  return g;
}
export const DRUM_HEIGHT = 0.851 * S;
export const DRUM_RADIUS = 0.286 * S;

/** A timber pallet: three runners under a deck of boards. */
function palletParts(x, z, w, d, R) {
  const parts = [];
  const hRun = 0.1 * S, tBoard = 0.025 * S;
  for (const k of [-1, 0, 1]) {
    parts.push({ geo: new THREE.BoxGeometry(0.1 * S, hRun, d), pos: [x + k * (w / 2 - 0.05 * S), hRun / 2, z], mat: MAT.timber, tone: 0.3 + R() * 0.3 });
  }
  const boards = 6;
  for (let k = 0; k < boards; k++) {
    const bz = z - d / 2 + (k + 0.5) * (d / boards);
    parts.push({ geo: new THREE.BoxGeometry(w, tBoard, d / boards * 0.82), pos: [x, hRun + tBoard / 2, bz], mat: MAT.timber, tone: 0.35 + R() * 0.35 });
  }
  return { parts, top: hRun + tBoard };
}

// ── 1. Fuel dump ─────────────────────────────────────────────────────────────
export function buildFuelDump({ seed = 3 } = {}) {
  const R = rng(seed);
  const drum = drumGeometry();
  const parts = [];
  const pw = 1.25 * S, pd = 1.25 * S;
  const pitch = DRUM_RADIUS * 2.08;
  // Two pallets side by side, four drums on each.
  for (const px of [-pw * 0.55, pw * 0.55]) {
    const pal = palletParts(px, 0, pw, pd, R);
    parts.push(...pal.parts);
    for (const [ix, iz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const bare = R() < 0.15;
      parts.push({ geo: drum, pos: [px + ix * pitch, pal.top, iz * pitch], rot: [0, R() * 6.28, 0],
        mat: bare ? MAT.metal : MAT.paint, tone: 0.35 + R() * 0.4 });
    }
  }
  // Loose drums on the ground beside them, one fallen over.
  parts.push({ geo: drum, pos: [pw * 1.35, 0, -0.25 * S], rot: [0, R() * 6.28, 0], mat: MAT.paint, tone: 0.5 });
  parts.push({ geo: drum, pos: [pw * 1.3, 0, 0.62 * S], rot: [0, R() * 6.28, 0], mat: MAT.metal, tone: 0.4 });
  parts.push({ geo: drum, pos: [-pw * 1.45, DRUM_RADIUS, 0.35 * S], rot: [Math.PI / 2, 0, 0.5], mat: MAT.paint, tone: 0.45 });
  const geo = assemble(parts);
  drum.dispose();
  bakeContactAO(geo, { cell: 0.18 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  return geo;
}

// ── 3. Crate stack ───────────────────────────────────────────────────────────
/** A small-arms ammo crate: painted box, overhanging lid, end battens. */
function crateParts(x, y, z, rotY, R) {
  const L = 0.82 * S, W = 0.42 * S, H = 0.34 * S;
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const at = (lx, ly, lz) => [x + lx * c + lz * s, y + ly, z - lx * s + lz * c];
  const tone = 0.35 + R() * 0.4;
  const parts = [
    { geo: new THREE.BoxGeometry(L, H - 0.04 * S, W), pos: at(0, (H - 0.04 * S) / 2, 0), rot: [0, rotY, 0], mat: MAT.paint, tone },
    { geo: new THREE.BoxGeometry(L + 0.02 * S, 0.04 * S, W + 0.02 * S), pos: at(0, H - 0.02 * S, 0), rot: [0, rotY, 0], mat: MAT.paint, tone: tone * 0.9 },
  ];
  for (const sx of [-1, 1]) {
    for (const by of [0.06 * S, H - 0.1 * S]) {
      parts.push({ geo: new THREE.BoxGeometry(0.035 * S, 0.06 * S, W + 0.03 * S), pos: at(sx * (L / 2 + 0.017 * S), by, 0), rot: [0, rotY, 0], mat: MAT.timber, tone: 0.3 });
    }
  }
  return { parts, h: H };
}

export function buildCrateStack({ seed = 5 } = {}) {
  const R = rng(seed);
  const pw = 1.9 * S, pd = 1.25 * S;
  const pal = palletParts(0, 0, pw, pd, R);
  const parts = [...pal.parts];
  const L = 0.82 * S, W = 0.42 * S;
  // Two layers, the upper one crosswise — how a stack is interlocked to stay up.
  let top = pal.top;
  for (let layer = 0; layer < 3; layer++) {
    const cross = layer % 2 === 1;
    const n = layer === 2 ? 2 : 4;
    for (let i = 0; i < n; i++) {
      let x, z;
      if (!cross) { x = (i % 2 - 0.5) * (L + 0.03 * S); z = (Math.floor(i / 2) - 0.5) * (W + 0.1 * S); }
      else { x = (i - (n - 1) / 2) * (W + 0.08 * S); z = 0; }
      const c = crateParts(x + (R() - 0.5) * 0.04, top, z + (R() - 0.5) * 0.04, (cross ? Math.PI / 2 : 0) + (R() - 0.5) * 0.08, R);
      parts.push(...c.parts);
    }
    top += 0.34 * S;
  }
  // One crate down on the ground, lid off beside it.
  const lone = crateParts(pw * 0.85, 0, pd * 0.35, 0.5, R);
  parts.push(...lone.parts.filter((_, k) => k !== 1));
  parts.push({ geo: new THREE.BoxGeometry(L, 0.04 * S, W), pos: [pw * 0.95, 0.02 * S, pd * 0.9], rot: [0, 0.9, 0], mat: MAT.paint, tone: 0.5 });
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.14 * S, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5 });
  return geo;
}

// ── 2. Gun pit ───────────────────────────────────────────────────────────────
export function buildGunPit({ seed = 7 } = {}) {
  const R = rng(seed);
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S };
  const radius = 2.6 * S;
  const parts = [];
  parts.push({ geo: buildSandbagRing({ radius, courses: 4, seed, bag, gapDeg: 44 }), mat: null });
  // The ring's floor is scraped earth, a little below the grass.
  parts.push({ geo: new THREE.CylinderGeometry(radius - 0.25, radius - 0.25, 0.06, 20), pos: [0, 0.03, 0], mat: MAT.earth, tone: 0.35 });
  // Inside: ammo crates against the back wall and a drum of water.
  const c1 = crateParts(-0.6 * S, 0.06, radius * 0.45, 0.2, R);
  const c2 = crateParts(0.35 * S, 0.06, radius * 0.5, -0.15, R);
  const c3 = crateParts(-0.55 * S, 0.06 + 0.34 * S, radius * 0.47, 0.35, R);
  parts.push(...c1.parts, ...c2.parts, ...c3.parts);
  const drum = drumGeometry();
  parts.push({ geo: drum, pos: [radius * 0.55, 0.06, -radius * 0.1], rot: [0, R() * 6.28, 0], mat: MAT.paint, tone: 0.45 });
  const geo = assemble(parts);
  drum.dispose();
  bakeContactAO(geo, { cell: 0.16 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  return geo;
}

// ── 4. The MINES sign: its own sheet, since it carries lettering ────────────
let _signMat = null;
function signMaterial() {
  if (_signMat) return _signMat;
  const cv = document.createElement("canvas");
  cv.width = 512; cv.height = 512;
  const g = cv.getContext("2d");
  const R = rng(99);
  // Left half: weathered plank (posts, board edges and back). Right: the face.
  g.fillStyle = "#6b5a44"; g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 160; i++) {
    g.strokeStyle = `rgba(${40 + R() * 30},${30 + R() * 20},${20 + R() * 15},${0.25 + R() * 0.3})`;
    g.lineWidth = 1 + R() * 2;
    const x = R() * 256;
    g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + (R() - 0.5) * 10, 170, x + (R() - 0.5) * 10, 340, x, 512); g.stroke();
  }
  const x = 256, y = 0, w = 256, h = 512;
  g.fillStyle = "#d8d0bb"; g.fillRect(x, y, w, h);
  for (let i = 0; i < 500; i++) { g.fillStyle = `rgba(90,80,60,${R() * 0.12})`; g.fillRect(x + R() * w, y + R() * h, 2 + R() * 8, 1 + R() * 3); }
  g.strokeStyle = "#8e1b16"; g.lineWidth = 12; g.strokeRect(x + 12, y + 12, w - 24, h - 24);
  g.fillStyle = "#9b1d17"; g.textAlign = "center"; g.textBaseline = "middle";
  // The face cell is 256 x 512 px and lands on a 0.95 x 0.55 m board, so a
  // pixel covers 3.46x less board vertically than horizontally: the lettering
  // is drawn stretched by exactly that, and the board's UVs squash it square.
  const STRETCH = (512 / 0.55) / (256 / 0.95);
  g.save(); g.translate(x + w / 2, 0); g.scale(1, STRETCH);
  g.font = "bold 76px Impact, 'Arial Black', sans-serif"; g.fillText("MINES", 0, 50);
  g.font = "bold 38px 'Arial Black', Arial, sans-serif"; g.fillText("CÓ MÌN", 0, 117);
  g.restore();
  // Paint runs under the big letters: done in a hurry, by hand.
  // Short, so they read as runs under MINES and not as marks above CÓ MÌN.
  for (let i = 0; i < 8; i++) g.fillRect(x + w * (0.16 + R() * 0.68), 296, 3, 6 + R() * 16);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _signMat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.85, metalness: 0 });
  _signMat.name = "RtsSign";
  return _signMat;
}

const uvRemap = (geo, u0, u1) => {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * (u1 - u0));
  return geo;
};

/** One merged geometry: a post and a board, the board's +Z face on the sign cell. */
export function buildMinesSignGeometry() {
  const bw = 0.95 * S, bh = 0.55 * S, bt = 0.035 * S, postH = 1.4 * S;
  const post = uvRemap(new THREE.BoxGeometry(0.09 * S, postH, 0.09 * S), 0, 0.5).translate(0, postH / 2, -0.03 * S);
  const board = new THREE.BoxGeometry(bw, bh, bt).translate(0, postH - bh / 2 + 0.05 * S, bt / 2 + 0.02 * S);
  // A BoxGeometry's faces are groups +x, -x, +y, -y, +z, -z with four vertices
  // each of their own, so a face's UVs can be pointed at its cell vertex by
  // vertex: +Z (group 4) at the lettered half, the rest at the plank half.
  const uv = board.attributes.uv;
  const done = new Set();
  for (const grp of board.groups) {
    const u0 = grp.materialIndex === 4 ? 0.5 : 0;
    for (let k = grp.start; k < grp.start + grp.count; k++) {
      const vi = board.index.getX(k);
      if (done.has(vi)) continue;
      done.add(vi);
      uv.setX(vi, u0 + uv.getX(vi) * 0.5);
    }
  }
  post.clearGroups();
  board.clearGroups();
  const geo = mergeGeometries([post, board], false);
  post.dispose(); board.dispose();
  // Leaning a little, the way a stake driven by hand stands.
  geo.rotateZ(0.03);
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0);
  return geo;
}

export function buildMinesSign() {
  const m = new THREE.Mesh(buildMinesSignGeometry(), signMaterial());
  m.name = "MinesSign";
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ── 5. Guard tower ───────────────────────────────────────────────────────────
/** A squared timber from a to b (world metres), `s` square. */
function beamGeo(a, b, s) {
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.BoxGeometry(s, d.length(), s);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  const m = a.clone().add(b).multiplyScalar(0.5);
  return g.translate(m.x, m.y, m.z);
}

/**
 * A firebase guard tower: four splayed timber legs, X-braced in two tiers, a
 * plank deck behind a sandbag parapet, corner posts carrying a corrugated
 * roof, and a ladder up to a gap in the bags. What was built on every perimeter
 * in-country — timber and bags, not the clean concrete of the old model.
 */
export function buildGuardTower({ seed = 13, deckHeight = 5.2 } = {}) {
  const R = rng(seed);
  const v = (x, y, z) => new THREE.Vector3(x * S, y * S, z * S);
  const H = deckHeight, b0 = 1.75, b1 = 1.4; // leg half-spread at the foot / at the deck
  const parts = [];
  const leg = (sx, sz, t) => v(sx * (b0 + (b1 - b0) * t), H * t, sz * (b0 + (b1 - b0) * t));
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of corners) {
    parts.push({ geo: beamGeo(leg(sx, sz, -0.06), leg(sx, sz, 1), 0.2 * S), mat: MAT.timber, tone: 0.3 + R() * 0.2 });
  }
  // X-braces on every side, two tiers, and a ledger at the tier line.
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
    for (const [t0, t1] of [[0.04, 0.5], [0.5, 0.96]]) {
      parts.push({ geo: beamGeo(leg(ax, az, t0), leg(bx, bz, t1), 0.1 * S), mat: MAT.timber, tone: 0.4 + R() * 0.25 });
      parts.push({ geo: beamGeo(leg(bx, bz, t0), leg(ax, az, t1), 0.1 * S), mat: MAT.timber, tone: 0.4 + R() * 0.25 });
    }
    parts.push({ geo: beamGeo(leg(ax, az, 0.5), leg(bx, bz, 0.5), 0.12 * S), mat: MAT.timber, tone: 0.35 });
  }
  // Deck: joists, then planks running across them, overhanging the legs.
  const dh = 1.75; // deck half-width
  for (const z of [-1.3, 0, 1.3]) parts.push({ geo: new THREE.BoxGeometry(dh * 2 * S, 0.16 * S, 0.14 * S), pos: [0, (H - 0.08) * S, z * S], mat: MAT.timber, tone: 0.3 });
  const planks = 9;
  for (let i = 0; i < planks; i++) {
    const x = (-dh + (i + 0.5) * (2 * dh / planks)) * S;
    parts.push({ geo: new THREE.BoxGeometry((2 * dh / planks) * 0.9 * S, 0.06 * S, dh * 2 * S), pos: [x, (H + 0.03) * S, 0], mat: MAT.timber, tone: 0.35 + R() * 0.35 });
  }
  // Sandbag parapet round the deck edge, a gap at the ladder (-Z).
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S, segU: 6, segV: 4 };
  const top = (H + 0.06) * S, edge = (dh - 0.17) * S, courses = 5;
  const wall = (len, x, z, ry, s2) => ({ geo: buildSandbagWall({ length: len * S, courses, seed: seed + s2, bag, batter: 0.02 }), pos: [x, top, z], rot: [0, ry, 0], mat: null });
  parts.push(wall(dh * 2, 0, edge, 0, 1));
  parts.push(wall(dh * 2 - 0.3, edge, 0, Math.PI / 2, 2));
  parts.push(wall(dh * 2 - 0.3, -edge, 0, Math.PI / 2, 3));
  const side = dh - 0.45; // the -Z wall in two runs either side of the gap
  parts.push(wall(side, -(dh - side / 2) * S, -edge, 0, 4));
  parts.push(wall(side, (dh - side / 2) * S, -edge, 0, 5));
  // Corner posts carrying the roof, and the roof itself.
  const roofY = H + 2.35;
  for (const [sx, sz] of corners) {
    parts.push({ geo: new THREE.BoxGeometry(0.14 * S, (roofY - H) * S, 0.14 * S), pos: [sx * (dh - 0.08) * S, (H + (roofY - H) / 2) * S, sz * (dh - 0.08) * S], mat: MAT.timber, tone: 0.35 });
  }
  // A low gable of two corrugated sheets, ridge along X. (The kit's
  // buildSheetRoof stands its sheets on edge — its Euler order turns the
  // sheet's width vertical — so the sheets are laid here explicitly.)
  const half = dh + 0.35, rise = 0.45, slope = Math.hypot(half, rise), tilt = Math.atan2(rise, half);
  for (const s of [-1, 1]) {
    const sheet = buildCorrugatedPanel({ width: (dh * 2 + 0.7) * S, height: slope * S, thickness: 0.025 * S, ribs: 12, ribDepth: 0.035 * S, offset: s * 0.004 });
    // Built standing in XY; laid so its height runs from the ridge out along ±Z,
    // then dropped at the eave.
    sheet.rotateX(s > 0 ? Math.PI / 2 : -Math.PI / 2).rotateX(s * tilt).translate(0, (roofY + rise) * S, 0);
    parts.push({ geo: sheet, mat: MAT.metal, tone: s > 0 ? 0.5 : 0.4 });
  }
  parts.push({ geo: new THREE.BoxGeometry((dh * 2 + 0.8) * S, 0.08 * S, 0.22 * S), pos: [0, (roofY + rise + 0.04) * S, 0], mat: MAT.metal, tone: 0.35 });
  // Rafters under the sheets, from the corner posts' tops to the ridge.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push({ geo: beamGeo(v(sx * (dh - 0.08), roofY, sz * (dh - 0.08)), v(sx * (dh - 0.08), roofY + rise - 0.06, 0), 0.1 * S), mat: MAT.timber, tone: 0.35 });
  }
  // Ladder up the -Z face to the gap, leaning in.
  const lad = buildLadder({ height: (H + 0.9) * S, width: 0.55 * S, rail: 0.08 * S, rungs: 14, rung: 0.05 * S });
  parts.push({ geo: lad, pos: [0, -0.1 * S, -(dh + 0.55) * S], rot: [0.1, 0, 0], mat: MAT.timber, tone: 0.5 });
  // A searchlight on the front corner and a drum of water at the foot.
  parts.push({ geo: new THREE.CylinderGeometry(0.2 * S, 0.24 * S, 0.34 * S, 12).rotateX(Math.PI / 2 - 0.3), pos: [(dh - 0.3) * S, top + (courses * 0.17 + 0.15) * S, (dh - 0.3) * S], rot: [0, 0.6, 0], mat: MAT.metal, tone: 0.3 });
  const drum = drumGeometry();
  parts.push({ geo: drum, pos: [(b0 + 0.6) * S, 0, -(b0 - 0.2) * S], rot: [0, R() * 6.28, 0], mat: MAT.paint, tone: 0.5 });
  const geo = assemble(parts);
  for (const p of parts) if (p.geo !== drum) p.geo.dispose();
  drum.dispose();
  bakeContactAO(geo, { cell: 0.2 * S, radius: 2, strength: 0.4, groundFade: 0.25, floor: 0.5 });
  return geo;
}

/** Every piece as a ready mesh (the sign as a small group), for previews. */
export function buildFirebasePreviewSet() {
  const mat = rtsObjectMaterial();
  const mk = (geo, name) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name; m.castShadow = m.receiveShadow = true;
    return { mesh: m, tris: triCount(geo) };
  };
  return {
    fuelDump: mk(buildFuelDump(), "FuelDump"),
    gunPit: mk(buildGunPit(), "GunPit"),
    crateStack: mk(buildCrateStack(), "CrateStack"),
    sign: { mesh: buildMinesSign(), tris: 24 },
  };
}
