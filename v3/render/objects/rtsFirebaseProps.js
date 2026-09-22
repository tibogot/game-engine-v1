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
  MAT, assemble, bakeContactAO, buildBox, buildCorrugatedPanel, buildLadder, buildSandbagRing, buildSandbagWall,
  buildTrapezoidPanel, rng, trapezoidProfile, triCount,
} from "./rtsParts.js";
import { STENCILS, flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";
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
      // End to end, the gap has to clear both crates' end battens (each stands 0.035 proud)
      // plus the random twist each crate gets: closer, their top faces overlapped in one plane.
      if (!cross) { x = (i % 2 - 0.5) * (L + 0.14 * S); z = (Math.floor(i / 2) - 0.5) * (W + 0.1 * S); }
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
    // The second diagonal of each X is nailed OVER the first, one brace
    // thickness further out — in the same plane their faces z-fought where
    // they cross.
    const out = new THREE.Vector3(ax + bx, 0, az + bz).normalize().multiplyScalar(0.1 * S);
    for (const [t0, t1] of [[0.04, 0.5], [0.5, 0.96]]) {
      parts.push({ geo: beamGeo(leg(ax, az, t0), leg(bx, bz, t1), 0.1 * S), mat: MAT.timber, tone: 0.4 + R() * 0.25 });
      parts.push({ geo: beamGeo(leg(bx, bz, t0).add(out), leg(ax, az, t1).add(out), 0.1 * S), mat: MAT.timber, tone: 0.4 + R() * 0.25 });
    }
    // Ledger stops at the legs' faces: run centre to centre, the four ledgers overlapped inside each leg.
    { const a = leg(ax, az, 0.5), b = leg(bx, bz, 0.5), d = b.clone().sub(a).setLength(0.1 * S); parts.push({ geo: beamGeo(a.add(d), b.sub(d), 0.12 * S), mat: MAT.timber, tone: 0.35 }); }
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
    // Standing ON the deck planks: from the planks' underside, the post feet shared its plane.
    parts.push({ geo: new THREE.BoxGeometry(0.14 * S, (roofY - H - 0.06) * S, 0.14 * S), pos: [sx * (dh - 0.08) * S, (H + 0.06 + (roofY - H - 0.06) / 2) * S, sz * (dh - 0.08) * S], mat: MAT.timber, tone: 0.35 });
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

// ── 6. GP Medium tent ────────────────────────────────────────────────────────
/**
 * The canvas roof of a hipped tent as a sagging surface: height from the
 * hip-roof plan (ridge along Z, hips at the ends), minus a sag that is zero on
 * the ridge and the eave and deepest mid-slope, and dips again between ridge
 * poles. Returned closed (top + underside), since the walls are rolled up and
 * the roof is seen from below through them.
 */
/** Height of the sagging hip roof at (x, z), with its slope position and sag. */
function tentRoofAt(x, z, { hw, hl, eave, ridge, sag }) {
  const rz = Math.max(0.01, hl - hw);
  const a = Math.abs(x) / hw, b = Math.max(0, (Math.abs(z) - rz) / hw);
  const t = 1 - Math.max(a, b);                         // 1 on the ridge, 0 at the eave
  const tc = Math.min(1, Math.max(0, t));
  const between = Math.sin((Math.PI * z) / rz) ** 2;    // 0 at each ridge pole
  const s = sag * Math.sin(Math.PI * tc) * (0.6 + 0.4 * between) + sag * 0.5 * (1 - tc) * between;
  return { y: eave + (ridge - eave) * Math.max(-0.12, t) - s, tc, s };
}

function tentRoofGeometry({ hw, hl, eave, ridge, sag, over, nx = 18, nz = 32 }) {
  const pos = [], uvs = [], idx = [], shade = [];
  for (let j = 0; j <= nz; j++) {
    const z = -hl - over + ((2 * (hl + over)) * j) / nz;
    for (let i = 0; i <= nx; i++) {
      const x = -hw - over + ((2 * (hw + over)) * i) / nx;
      const { y, tc, s } = tentRoofAt(x, z, { hw, hl, eave, ridge, sag });
      pos.push(x, y, z);
      uvs.push(z / (2 * S), 0.3 + 0.62 * tc);
      // Darkness of the dip, for the roof's AO: at midday both slopes take the
      // same light, so the drape has to be painted in to show from above.
      // The ridge line itself is kept bright — it is the tent's silhouette.
      shade.push(Math.max(0.62, 1 - (s / (sag * 1.2)) * 0.38) * (tc > 0.94 ? 1.08 : 1));
    }
  }
  const row = nx + 1;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const p = j * row + i;
    idx.push(p, p + row, p + 1, p + 1, p + row, p + row + 1);
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  top.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  top.setIndex(idx);
  top.computeVertexNormals();
  // Flip the top if its normals came out facing down.
  if (top.attributes.normal.getY(Math.floor(nz / 2) * row + Math.floor(nx / 4)) < 0) {
    const ix = top.index;
    for (let k = 0; k < ix.count; k += 3) { const t = ix.getX(k + 1); ix.setX(k + 1, ix.getX(k + 2)); ix.setX(k + 2, t); }
    top.computeVertexNormals();
  }
  const under = top.clone();
  under.translate(0, -0.03 * S, 0);
  const ix = under.index;
  for (let k = 0; k < ix.count; k += 3) { const t = ix.getX(k + 1); ix.setX(k + 1, ix.getX(k + 2)); ix.setX(k + 2, t); }
  under.computeVertexNormals();
  const g = mergeGeometries([top, under], false);
  top.dispose(); under.dispose();
  // Per vertex of the merged pair (top, then its underside copy).
  g.userData.shade = Float32Array.from([...shade, ...shade]);
  return g;
}

/**
 * A GP Medium tent (16 x 32 ft, real) as it stood in-country: hipped canvas
 * sagging between its poles, the walls rolled up for air, a timber floor, and a
 * sandbag blast wall round it with a door gap at each end — guy ropes run out
 * over the bags to stakes. `blastWall: false` for a tent in the open.
 */
export function buildTent({ seed = 17, blastWall = true, medic = false } = {}) {
  const R = rng(seed);
  const hw = 2.45 * S, hl = 4.9 * S, eave = 1.7 * S, ridge = 3.2 * S;
  const parts = [];
  // A generous sag: at midday both slopes take the same light, and the dips
  // between the poles are most of what shows the roof's shape from above.
  const roofPrm = { hw, hl, eave, ridge, sag: 0.24 * S };
  const roof = tentRoofGeometry({ ...roofPrm, over: 0.12 * S });
  parts.push({ geo: roof, mat: MAT.canvas, tone: 0.5 });
  const roll = 0.13 * S, ry = eave - 0.14 * S;
  const wt = 0.03 * S, wx = hw + 0.03 * S, wz = hl + 0.03 * S;
  const door = 1.5 * S;
  if (!medic) {
    // Rolled walls: a canvas roll under the eave on every side.
    for (const sx of [-1, 1]) parts.push({ geo: new THREE.CylinderGeometry(roll, roll, hl * 2, 8).rotateX(Math.PI / 2), pos: [sx * hw, ry, 0], mat: MAT.canvas, tone: 0.4 });
    for (const sz of [-1, 1]) parts.push({ geo: new THREE.CylinderGeometry(roll, roll, hw * 2, 8).rotateZ(Math.PI / 2), pos: [0, ry, sz * hl], mat: MAT.canvas, tone: 0.4 });
  } else {
    // An aid station keeps its walls DOWN, a door in the front end with its
    // flap rolled up over it. The end walls stop inside the side walls' faces
    // (coplanar corner faces z-fight).
    const wh = eave - 0.04 * S;
    for (const sx of [-1, 1]) parts.push({ geo: buildBox(wt, wh, 2 * wz), pos: [sx * wx, 0.02 * S + wh / 2, 0], mat: MAT.canvas, tone: 0.45 });
    const ew = 2 * hw + 0.07 * S;
    parts.push({ geo: buildBox(ew, wh, wt), pos: [0, 0.02 * S + wh / 2, -wz], mat: MAT.canvas, tone: 0.45 });
    const pw = (ew - door) / 2;
    for (const sx of [-1, 1]) parts.push({ geo: buildBox(pw, wh, wt), pos: [sx * (door / 2 + pw / 2), 0.02 * S + wh / 2, wz], mat: MAT.canvas, tone: 0.45 });
    parts.push({ geo: new THREE.CylinderGeometry(roll * 0.8, roll * 0.8, door + 0.2 * S, 8).rotateZ(Math.PI / 2), pos: [0, eave - 0.2 * S, wz + 0.08 * S], mat: MAT.canvas, tone: 0.4 });
  }
  // Floor: planks along the length on a low frame.
  const planks = 8, fy = 0.12 * S;
  for (let i = 0; i < planks; i++) {
    const x = -hw + ((i + 0.5) * 2 * hw) / planks;
    parts.push({ geo: new THREE.BoxGeometry((2 * hw / planks) * 0.92, 0.05 * S, hl * 2), pos: [x, fy, 0], mat: MAT.timber, tone: 0.35 + R() * 0.35 });
  }
  // Poles: three up the ridge, and the eave poles every ~2.4 m round the edge.
  const rzp = hl - hw;
  for (const z of [-rzp, 0, rzp]) parts.push({ geo: new THREE.CylinderGeometry(0.06 * S, 0.07 * S, ridge, 7).translate(0, ridge / 2, 0), pos: [0, 0, z], mat: MAT.timber, tone: 0.4 });
  const eavePole = new THREE.CylinderGeometry(0.04 * S, 0.05 * S, eave, 6).translate(0, eave / 2, 0);
  const n = Math.round((2 * hl) / (2.4 * S));
  for (let k = 0; k <= n; k++) {
    const z = -hl + (2 * hl * k) / n;
    for (const sx of [-1, 1]) parts.push({ geo: eavePole, pos: [sx * hw, 0, z], mat: MAT.timber, tone: 0.45 });
  }
  for (const sz of [-1, 1]) for (const x of [-hw / 2, hw / 2]) parts.push({ geo: eavePole, pos: [x, 0, sz * hl], mat: MAT.timber, tone: 0.45 });
  // Blast wall, a little out from the eave, open at the middle of each end.
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S, segU: 6, segV: 4 };
  const wo = 0.6 * S, courses = 5;
  if (blastWall) {
    for (const sx of [-1, 1]) parts.push({ geo: buildSandbagWall({ length: 2 * hl + wo * 2, courses, seed: seed + (sx > 0 ? 1 : 2), bag, batter: 0.03 }), pos: [sx * (hw + wo), 0, 0], rot: [0, Math.PI / 2, 0], mat: null });
    const gap = 1.7 * S, run = hw + wo - gap / 2;
    for (const sz of [-1, 1]) for (const sx of [-1, 1]) {
      parts.push({ geo: buildSandbagWall({ length: run, courses, seed: seed + 5 + sz + sx * 3, bag, batter: 0.03 }), pos: [sx * (gap / 2 + run / 2), 0, sz * (hl + wo)], mat: null });
    }
  }
  // Guy ropes from the eave, out over the wall to stakes.
  const out = blastWall ? wo + 1.2 * S : 1.4 * S;
  for (let k = 0; k <= n; k++) {
    const z = -hl + (2 * hl * k) / n;
    for (const sx of [-1, 1]) {
      const a = new THREE.Vector3(sx * hw, eave - 0.05 * S, z), b = new THREE.Vector3(sx * (hw + out), 0.1 * S, z);
      if (blastWall) b.y = Math.max(b.y, 0.1 * S);
      parts.push({ geo: beamGeo(a, b, 0.025 * S), mat: MAT.hessian, tone: 0.8 });
      parts.push({ geo: new THREE.BoxGeometry(0.05 * S, 0.3 * S, 0.05 * S), pos: [b.x, 0.08 * S, b.z], rot: [0, 0, -sx * 0.3], mat: MAT.timber, tone: 0.3 });
    }
  }
  const geo = assemble(parts);
  eavePole.dispose();
  bakeContactAO(geo, { cell: 0.22 * S, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  // The roof went in first, so its vertices lead the merged buffer: fold its
  // drape shading into the baked AO.
  const ao = geo.attributes.ao, shade = roof.userData.shade;
  for (let i = 0; i < shade.length; i++) ao.setX(i, Math.min(1, ao.getX(i) * shade[i]));
  roof.dispose();
  // Level ground: the floor and the blast wall, not the guy stakes.
  const edge = blastWall ? wo + 0.4 * S : 0.4 * S;
  geo.userData.footprint = { cx: 0, cz: 0, hx: hw + edge, hz: hl + edge };

  // A marking on each long slope, laid ON the sagging canvas (the same height
  // function the roof is built from), so it dips with the cloth.
  const onRoof = (cell, sx, zc = 0) => {
    const x0 = sx * 0.2 * hw, x1 = sx * 0.88 * hw;           // eave-ward to ridge-ward, in plan
    // Width from the length UP THE SLOPE, so the ring stays round.
    const w = Math.hypot(x1 - x0, tentRoofAt(x1, zc, roofPrm).y - tentRoofAt(x0, zc, roofPrm).y) * STENCILS[cell].aspect;
    return stencilPatch(cell, (s, t) => {
      const x = x1 + (x0 - x1) * t, z = zc + (s - 0.5) * w * -sx;
      const e = 0.05;
      const y = tentRoofAt(x, z, roofPrm).y;
      const dx = (tentRoofAt(x + e, z, roofPrm).y - tentRoofAt(x - e, z, roofPrm).y) / (2 * e);
      const dz = (tentRoofAt(x, z + e, roofPrm).y - tentRoofAt(x, z - e, roofPrm).y) / (2 * e);
      return { p: new THREE.Vector3(x, y, z), n: new THREE.Vector3(-dx, 1, -dz).normalize() };
    }, { segS: 10, segT: 10, lift: 0.015 * S });
  };
  if (!medic) {
    // The Army star in its ring on both slopes: from the air, an American tent.
    geo.userData.stencil = mergeStencils([onRoof("star", -1), onRoof("star", 1)]);
  } else {
    // The white square with the red cross: the marking an aid station wore so
    // it could be seen from the air.
    const st = [onRoof("medicSquare", -1), onRoof("medicSquare", 1)];
    // Crosses high on both long walls, clear of the sandbags.
    for (const sx of [-1, 1]) {
      st.push(stencilPatch("medicCross", flatSurface([sx * (wx + wt / 2), 1.22 * S, 0], [sx, 0, 0], [0, 0, -sx], 0.9 * S, "medicCross"), { lift: 0.006 * S }));
    }
    // The station's name on the front, beside the door.
    const pw = (2 * hw + 0.07 * S - door) / 2;
    st.push(stencilPatch("medical", flatSurface([-(door / 2 + pw / 2), 1.3 * S, wz + wt / 2], [0, 0, 1], [1, 0, 0], pw * 0.9, "medical"), { lift: 0.006 * S }));
    geo.userData.stencil = mergeStencils(st);
  }
  return geo;
}

// ── 7. Conex box ─────────────────────────────────────────────────────────────
/**
 * A CONEX container (8.5 x 6.25 x 6.83 ft, real): the Army's steel box, used
 * for storage, as a bunker, as an office. Corrugated steel sides between a
 * frame of corner posts and rails, double doors on one end with their locking
 * bars, two skids underneath, olive paint. Doors face +Z.
 */
export function buildConex({ seed = 19, mat = MAT.paint } = {}) {
  const R = rng(seed);
  const L = 2.6 * S, W = 1.9 * S, H = 2.08 * S;
  const parts = [];
  const skid = 0.1 * S, y0 = skid;
  const hw = W / 2, hl = L / 2, h = H - skid;
  const tone = 0.4 + R() * 0.25;
  // Skids.
  for (const sx of [-0.33, 0.33]) parts.push({ geo: buildBox(0.12 * S, skid, L * 0.98), pos: [sx * W, skid / 2, 0], mat: MAT.metal, tone: 0.3 });
  // Floor and roof plates. The roof runs 3 cm out, into the top rails: at
  // +1 cm its edge was flush with the corner posts' faces and z-fought.
  // Floor plate a little inside the walls: flush, its side faces shared a plane with the wall crests.
  parts.push({ geo: buildBox(W - 0.1 * S, 0.06 * S, L - 0.1 * S), pos: [0, y0 + 0.04 * S, 0], mat, tone });   // 1 cm up: clear of the posts' feet (5 mm)
  parts.push({ geo: buildBox(W + 0.06 * S, 0.05 * S, L + 0.06 * S), pos: [0, y0 + h - 0.015 * S, 0], mat, tone: tone * 0.95 });   // top 1 cm over the posts' tops
  // Corrugated walls: ribs run vertically, v up the wall (paint's rust at the foot).
  const panel = (w, ribs) => buildCorrugatedPanel({ width: w, height: h - 0.1 * S, thickness: 0.02 * S, ribs, ribDepth: 0.025 * S });
  const side = panel(L - 0.12 * S, 14), back = panel(W - 0.12 * S, 10);
  for (const sx of [-1, 1]) parts.push({ geo: side, pos: [sx * (hw - 0.02 * S), y0 + 0.05 * S, 0], rot: [0, Math.PI / 2, 0], mat, tone });
  parts.push({ geo: back, pos: [0, y0 + 0.05 * S, -(hl - 0.02 * S)], mat, tone });
  // Frame: corner posts and top/bottom rails, a touch proud of the walls.
  const post = 0.1 * S;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // From 1 cm below every rail to 2 cm under the top rails: level with either,
    // the post ends shared the rails' planes.
    parts.push({ geo: buildBox(post, h - 0.01 * S, post), pos: [sx * (hw - post / 2 + 0.01 * S), y0 - 0.01 * S + (h - 0.01 * S) / 2, sz * (hl - post / 2 + 0.01 * S)], mat, tone: tone * 0.9 });
  }
  for (const yy of [y0 + 0.05 * S, y0 + h - 0.05 * S]) {
    for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.08 * S, 0.1 * S, L), pos: [sx * (hw + 0.005 * S), yy, 0], mat, tone: tone * 0.9 });
    // End rails 1 cm shallower than the side rails they cross at the corners: level, their tops shared a plane.
    for (const sz of [-1, 1]) parts.push({ geo: buildBox(W, 0.09 * S, 0.08 * S), pos: [0, yy, sz * (hl + 0.005 * S)], mat, tone: tone * 0.9 });
  }
  // Doors: two leaves on +Z, a seam between them, two locking bars each.
  const leafW = (W - 2 * post) / 2;
  for (const sx of [-1, 1]) {
    const cx = sx * (leafW / 2 + 0.01 * S);
    parts.push({ geo: buildBox(leafW - 0.02 * S, h - 0.2 * S, 0.04 * S), pos: [cx, y0 + h / 2, hl - 0.01 * S], mat, tone: tone * 1.05 });
    for (const bx of [-0.25, 0.25]) {
      parts.push({ geo: new THREE.CylinderGeometry(0.018 * S, 0.018 * S, h - 0.12 * S, 6), pos: [cx + bx * leafW, y0 + h / 2, hl + 0.04 * S], mat: MAT.metal, tone: 0.35 });
      parts.push({ geo: buildBox(0.03 * S, 0.14 * S, 0.05 * S), pos: [cx + bx * leafW + 0.04 * S, y0 + h * 0.45, hl + 0.06 * S], mat: MAT.metal, tone: 0.3 });
    }
  }
  const geo = assemble(parts);
  side.dispose(); back.dispose();
  bakeContactAO(geo, { cell: 0.16 * S, radius: 2, strength: 0.35, groundFade: 0.3, floor: 0.55 });

  // U.S. ARMY down both sides, on the corrugation. Both side sheets were turned
  // +90°, so their local x runs down world -Z and on the -X side the outward
  // face is the sheet's BACK (its thickness is on the other side of the wave).
  const pw = L - 0.12 * S, ribs = 14, rd = 0.025 * S, pt = 0.02 * S;
  const tw = 1.9 * S, th = tw / STENCILS.armyWhite.aspect, ty = y0 + h * 0.58;
  const stencils = [];
  for (const sx of [-1, 1]) {
    const n = new THREE.Vector3(sx, 0, 0);
    stencils.push(stencilPatch("armyWhite", (s, t) => {
      const z = -sx * (s - 0.5) * tw;                      // left to right, seen from outside
      const lx = -z;
      const wave = Math.sin(((lx + pw / 2) / pw) * Math.PI * 2 * ribs) * rd;
      return { p: new THREE.Vector3(sx * (hw - 0.02 * S) + wave + sx * pt / 2, ty + (t - 0.5) * th, z), n };
    }, { segS: 64, segT: 1, lift: 0.006 * S }));
  }
  geo.userData.stencil = mergeStencils(stencils);
  return geo;
}

// ── 8. Shipping container (ISO 20 ft) ───────────────────────────────────────
/**
 * A 20 ft ISO container (6.06 x 2.44 x 2.59 m, real) — the Sea-Land boxes that
 * came in-country from 1967. Built the way one is: trapezoid-corrugated steel
 * walls between a frame of corner posts and rails, corner castings standing
 * proud at all eight corners, a corrugated roof, and on the +Z end the double
 * doors with four full-height locking bars, their cam keepers and handles.
 *
 * Every face is offset from its neighbours (castings > posts > rails >
 * panels): coplanar faces z-fight, and this one is looked at from every side.
 * `mat` picks the paint: MAT.paint olive, MAT.camo, or MAT.metal bare/rusted.
 */
export function buildContainer({ seed = 29, mat = MAT.paint } = {}) {
  const R = rng(seed);
  const L = 6.06 * S, W = 2.44 * S, H = 2.59 * S;
  const hl = L / 2, hw = W / 2;
  const post = 0.16 * S, cast = 0.18 * S;
  const railT = 0.12 * S, railB = 0.16 * S, railD = 0.1 * S;
  const tone = 0.4 + R() * 0.25;
  const parts = [];
  const P = (geo, pos, t = tone, m = mat, rot) => parts.push({ geo, pos, rot, mat: m, tone: t });

  // Corner castings: the eight blocks the whole box is lifted and stacked by.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [cast / 2, H - cast / 2]) {
    P(buildBox(cast, cast, cast), [sx * (hw - cast / 2 + 0.01 * S), y, sz * (hl - cast / 2 + 0.01 * S)], tone * 0.85);
  }
  // Corner posts between the castings, 1 cm inside their faces.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    P(buildBox(post, H - 2 * cast, post), [sx * (hw - post / 2), H / 2, sz * (hl - post / 2)], tone * 0.9);
  }
  // Rails: top and bottom along the sides and across the ends, inset again.
  const inset = 0.012 * S;
  for (const sx of [-1, 1]) {
    P(buildBox(railD, railB, L - 2 * cast), [sx * (hw - railD / 2 - inset), railB / 2, 0], tone * 0.9);
    P(buildBox(railD, railT, L - 2 * cast), [sx * (hw - railD / 2 - inset), H - railT / 2, 0], tone * 0.9);
  }
  for (const sz of [-1, 1]) {
    P(buildBox(W - 2 * cast, railB, railD), [0, railB / 2, sz * (hl - railD / 2 - inset)], tone * 0.9);
    P(buildBox(W - 2 * cast, railT * 1.6, railD), [0, H - railT * 0.8, sz * (hl - railD / 2 - inset)], tone * 0.9);
  }
  // Walls: trapezoid corrugation, crests a further centimetre inside the rails.
  const wallH = H - railB - railT + 0.04 * S, wallY = railB - 0.02 * S, dep = 0.036 * S;
  const wallIn = hw - inset - dep / 2 - 0.02 * S;
  // Walls run 1 cm into the corner posts: ending on their faces, they shared the plane.
  const side = buildTrapezoidPanel({ width: L - 2 * post + 0.02 * S, height: wallH, thickness: 0.02 * S, pitch: 0.28 * S, depth: dep });
  for (const sx of [-1, 1]) P(side, [sx * wallIn, wallY, 0], tone, mat, [0, sx * Math.PI / 2, 0]);
  const end = buildTrapezoidPanel({ width: W - 2 * post + 0.02 * S, height: wallH, thickness: 0.02 * S, pitch: 0.28 * S, depth: dep });
  P(end, [0, wallY, -(hl - inset - dep / 2 - 0.02 * S)], tone, mat, [0, Math.PI, 0]);
  // Roof: shallow sine corrugation across the width, laid just under the rails' tops.
  // Stops 1 cm short of the castings: ended on their inner faces, it shared their plane.
  const roof = buildCorrugatedPanel({ width: L - 2 * cast - 0.02 * S, height: W - 2 * railD, thickness: 0.015 * S, ribs: 22, ribDepth: 0.012 * S });
  // Laid flat, then turned so its length runs down the box (+Z) and the ribs
  // run across it, as a container roof's do.
  roof.rotateX(-Math.PI / 2).translate(0, 0, (W - 2 * railD) / 2).rotateY(Math.PI / 2).translate(0, H - 0.035 * S, 0);
  P(roof, [0, 0, 0], tone * 1.05);
  // Floor, so the box is closed from any angle.
  P(buildBox(W - 2 * post, 0.03 * S, L - 2 * post), [0, railB - 0.03 * S, 0], 0.3, MAT.timber);

  // Doors on +Z: two leaves of shallower corrugation, recessed in the end frame.
  const leafW = (W - 2 * post) / 2 - 0.006 * S, leafH = H - railB - railT * 1.6;
  const doorZ = hl - inset - railD - 0.01 * S;
  const leaf = buildTrapezoidPanel({ width: leafW, height: leafH, thickness: 0.03 * S, pitch: 0.2 * S, depth: 0.02 * S });
  for (const sx of [-1, 1]) {
    const cx = sx * (leafW / 2 + 0.003 * S);
    P(leaf, [cx, railB, doorZ], tone * 1.02);
    // Two locking bars per leaf, full height, standing off the corrugation.
    for (const bx of [-0.28, 0.22]) {
      const x = cx + bx * leafW * sx;
      P(new THREE.CylinderGeometry(0.021 * S, 0.021 * S, H - 0.1 * S, 7), [x, H / 2, doorZ + 0.06 * S], 0.3, MAT.metal);
      // Cam keepers at the ends, and the handle a third of the way up.
      for (const y of [0.1 * S, H - 0.1 * S]) P(buildBox(0.08 * S, 0.07 * S, 0.06 * S), [x, y, doorZ + 0.05 * S], 0.3, MAT.metal);
      P(buildBox(0.05 * S, 0.24 * S, 0.035 * S), [x + 0.06 * S * sx, H * 0.38, doorZ + 0.095 * S], 0.35, MAT.metal);
      for (const y of [H * 0.3, H * 0.62, H * 0.9]) P(buildBox(0.07 * S, 0.035 * S, 0.05 * S), [x, y, doorZ + 0.04 * S], 0.3, MAT.metal);
    }
    // Hinges on the outer edge.
    for (const y of [H * 0.18, H * 0.4, H * 0.62, H * 0.84]) P(buildBox(0.06 * S, 0.1 * S, 0.06 * S), [sx * (hw - post - 0.02 * S), y, doorZ + 0.05 * S], 0.3, MAT.metal);
  }
  const geo = assemble(parts);
  side.dispose(); end.dispose(); roof.dispose(); leaf.dispose();
  bakeContactAO(geo, { cell: 0.2 * S, radius: 2, strength: 0.3, groundFade: 0.3, floor: 0.6 });

  // Markings, following the corrugation corner to corner (a flat patch would
  // bridge the troughs and hang in the air): U.S. ARMY down both sides, the
  // owner code on the right-hand door leaf.
  const stencils = [];
  const sideProf = trapezoidProfile({ width: L - 2 * post + 0.02 * S, thickness: 0.02 * S, pitch: 0.28 * S, depth: dep });
  const tw = 3.3 * S, th = tw / STENCILS.armyWhite.aspect, ty = wallY + wallH * 0.6;
  for (const sx of [-1, 1]) {
    // Seen from outside, "right" along this wall is -sx·Z; the panel's own x
    // runs the other way (it was turned sx·90°), so local x = -sx·z.
    const zOf = (s) => -sx * (s - 0.5) * tw;
    const sList = [0, 1, ...sideProf.corners.map((c) => (-sx * c) / (-sx * tw) + 0.5)]
      .filter((s) => s >= 0 && s <= 1).sort((a, b) => a - b);
    const n = new THREE.Vector3(sx, 0, 0);
    stencils.push(stencilPatch("armyWhite", (s, t) => {
      const z = zOf(s);
      return { p: new THREE.Vector3(sx * (wallIn + sideProf.zAt(-sx * z)), ty + (t - 0.5) * th, z), n };
    }, { sList, segT: 1, lift: 0.004 * S }));
  }
  {
    const cx = leafW / 2 + 0.003 * S, lw = leafW * 0.78, lh = lw / STENCILS.containerId.aspect;
    const lp = trapezoidProfile({ width: leafW, thickness: 0.03 * S, pitch: 0.2 * S, depth: 0.02 * S });
    const sList = [0, 1, ...lp.corners.map((c) => c / lw + 0.5)].filter((s) => s >= 0 && s <= 1).sort((a, b) => a - b);
    const n = new THREE.Vector3(0, 0, 1);
    stencils.push(stencilPatch("containerId", (s, t) => {
      const lx = (s - 0.5) * lw;
      return { p: new THREE.Vector3(cx + lx, H * 0.74 + (t - 0.5) * lh, doorZ + lp.zAt(lx)), n };
    }, { sList, segT: 1, lift: 0.004 * S }));
  }
  geo.userData.stencil = mergeStencils(stencils);
  return geo;
}

// ── 9. Radio station ─────────────────────────────────────────────────────────
/**
 * A signals post: a communications shelter (the S-280 kind, 3.7 x 2.2 x 2.2 m
 * real) set on timber blocks, its side windows open under propped flaps, an
 * air-conditioner on the back end, a door and step on the front (+Z). Beside
 * it a guyed sectional mast with an RC-292 ground-plane head — the silhouette
 * that says RADIO from the air — whips on the roof, a generator on skids with
 * its cable run, and a low sandbag wall on the generator side.
 */
export function buildRadioStation({ seed = 41 } = {}) {
  const R = rng(seed);
  const v = (x, y, z) => new THREE.Vector3(x * S, y * S, z * S);
  const parts = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => parts.push({ geo, pos, rot, mat, tone });
  const L = 3.7 * S, W = 2.2 * S, H = 2.2 * S, lift = 0.35 * S;
  const hl = L / 2, hw = W / 2;
  const tone = 0.45 + R() * 0.2;

  // Blocks, then the shelter body with its seam strips (panels are riveted
  // sheets on a frame; the strips are what read as "shelter", not "box").
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) P(buildBox(0.3 * S, lift, 0.3 * S), [sx * (hw - 0.2 * S), lift / 2, sz * (hl - 0.3 * S)], MAT.timber, 0.3);
  P(buildBox(W, H, L), [0, lift + H / 2, 0], MAT.paint, tone);
  for (const z of [-hl + 0.02 * S, -hl / 3, hl / 3, hl - 0.02 * S]) {
    P(buildBox(W + 0.04 * S, 0.06 * S, 0.07 * S), [0, lift + H + 0.01 * S, z], MAT.paint, tone * 0.85);       // roof rib
    for (const sx of [-1, 1]) P(buildBox(0.03 * S, H - 0.1 * S, 0.07 * S), [sx * (hw + 0.015 * S), lift + H / 2, z], MAT.paint, tone * 0.85);
  }
  // Side windows (+X), open: dark glass, a frame, and the flap propped out.
  for (const z of [-hl / 2 + 0.1 * S, hl / 2 - 0.3 * S]) {
    P(buildBox(0.02 * S, 0.6 * S, 0.8 * S), [hw + 0.012 * S, lift + H * 0.62, z], MAT.metal, 0.02);
    // Hinged at the window head and propped out as an awning, 20 degrees below level.
    const hinge = new THREE.Vector3(hw + 0.03 * S, lift + H * 0.62 + 0.33 * S, z);
    const f = buildBox(0.62 * S, 0.035 * S, 0.84 * S).translate(0.31 * S, 0, 0).rotateZ(-0.35).translate(hinge.x, hinge.y, hinge.z);
    P(f, [0, 0, 0], MAT.paint, tone * 1.05);
    for (const dz of [-0.36, 0.36]) {
      parts.push({ geo: beamGeo(new THREE.Vector3(hw + 0.02 * S, lift + H * 0.42, z + dz * S), new THREE.Vector3(hinge.x + 0.58 * S * Math.cos(0.35), hinge.y - 0.58 * S * Math.sin(0.35), z + dz * S), 0.025 * S), mat: MAT.metal, tone: 0.3 });
    }
  }
  // Door and step on +Z.
  P(buildBox(0.85 * S, 1.8 * S, 0.04 * S), [-hw / 3, lift + 0.95 * S, hl + 0.02 * S], MAT.paint, tone * 1.08);
  P(buildBox(0.3 * S, 0.25 * S, 0.02 * S), [-hw / 3, lift + 1.45 * S, hl + 0.045 * S], MAT.metal, 0.02);          // door window
  P(buildBox(0.04 * S, 0.12 * S, 0.05 * S), [-hw / 3 + 0.32 * S, lift + 0.95 * S, hl + 0.06 * S], MAT.metal, 0.4);  // handle
  P(buildBox(1.0 * S, 0.18 * S, 0.5 * S), [-hw / 3, 0.09 * S, hl + 0.3 * S], MAT.timber, 0.4);
  P(buildBox(1.0 * S, 0.18 * S, 0.3 * S), [-hw / 3, 0.27 * S, hl + 0.2 * S], MAT.timber, 0.45);
  // Air-conditioner on the back end: housing and a darker grille.
  P(buildBox(0.9 * S, 0.7 * S, 0.5 * S), [0, lift + H * 0.55, -hl - 0.25 * S], MAT.paint, tone * 0.95);
  P(buildBox(0.7 * S, 0.5 * S, 0.02 * S), [0, lift + H * 0.55, -hl - 0.51 * S], MAT.metal, 0.12);
  // Roof whips: two thin antennas on base insulators.
  for (const [x, z, h] of [[hw / S - 0.25, hl / S - 0.3, 3.2], [-hw / S + 0.25, -hl / S + 0.4, 2.6]]) {
    P(new THREE.CylinderGeometry(0.05 * S, 0.06 * S, 0.15 * S, 6), [x * S, lift + H + 0.08 * S, z * S], MAT.metal, 0.2);
    P(new THREE.CylinderGeometry(0.008 * S, 0.014 * S, h * S, 4).translate(0, (h * S) / 2, 0), [x * S, lift + H + 0.15 * S, z * S], MAT.metal, 0.25);
  }

  // The mast, off the -X side: tapering sections, a ground plane at the head,
  // three guys to stakes.
  const mx = -hw - 3.2 * S, mz = -0.4 * S, mH = 11 * S;
  P(new THREE.CylinderGeometry(0.05 * S, 0.075 * S, mH, 6).translate(0, mH / 2, 0), [mx, 0, mz], MAT.metal, 0.35);
  for (const y of [0.25, 0.5, 0.75]) P(new THREE.CylinderGeometry(0.085 * S, 0.085 * S, 0.12 * S, 6), [mx, mH * y, mz], MAT.metal, 0.3);  // section joints
  P(buildBox(0.5 * S, 0.1 * S, 0.5 * S), [mx, 0.05 * S, mz], MAT.timber, 0.35);                                                            // base plate
  const head = v(mx / S, mH / S, mz / S);
  parts.push({ geo: new THREE.CylinderGeometry(0.012 * S, 0.02 * S, 2.2 * S, 4).translate(0, 1.1 * S, 0), pos: [head.x, head.y, head.z], mat: MAT.metal, tone: 0.3 });
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    const tip = head.clone().add(new THREE.Vector3(Math.cos(a) * 1.6 * S, -1.0 * S, Math.sin(a) * 1.6 * S));
    parts.push({ geo: beamGeo(head, tip, 0.02 * S), mat: MAT.metal, tone: 0.3 });              // drooping radials
    const ga = a + Math.PI / 3;
    for (const y of [0.55, 0.95]) {
      const from = new THREE.Vector3(mx, mH * y, mz);
      const stake = new THREE.Vector3(mx + Math.cos(ga) * 5.5 * S, 0.1 * S, mz + Math.sin(ga) * 5.5 * S);
      parts.push({ geo: beamGeo(from, stake, 0.012 * S), mat: MAT.metal, tone: 0.2 });        // guy wire
    }
    P(buildBox(0.08 * S, 0.35 * S, 0.08 * S), [mx + Math.cos(ga) * 5.5 * S, 0.12 * S, mz + Math.sin(ga) * 5.5 * S], MAT.timber, 0.3);
  }
  // Feed cable from the mast foot to the shelter.
  parts.push({ geo: beamGeo(v(mx / S + 0.1, 0.05, mz / S), v(-hw / S - 0.02, lift / S + 0.5, -0.2), 0.03 * S), mat: MAT.metal, tone: 0.05 });

  // Generator on skids behind the shelter, cable run to the back end.
  const gx = 0.4 * S, gz = -hl - 2.3 * S;
  for (const sx of [-1, 1]) P(buildBox(0.1 * S, 0.1 * S, 1.3 * S), [gx + sx * 0.35 * S, 0.05 * S, gz], MAT.metal, 0.3);
  P(buildBox(0.85 * S, 0.75 * S, 1.2 * S), [gx, 0.1 * S + 0.375 * S, gz], MAT.paint, tone * 0.9);
  P(buildBox(0.6 * S, 0.3 * S, 0.02 * S), [gx, 0.55 * S, gz + 0.61 * S], MAT.metal, 0.1);                                  // grille
  P(new THREE.CylinderGeometry(0.04 * S, 0.04 * S, 0.5 * S, 6), [gx + 0.25 * S, 0.1 * S + 0.75 * S + 0.25 * S, gz - 0.3 * S], MAT.metal, 0.1);  // exhaust
  parts.push({ geo: beamGeo(v(gx / S, 0.3, gz / S + 0.6), v(0.1, 0.03, -hl / S - 0.6), 0.03 * S), mat: MAT.metal, tone: 0.05 });
  parts.push({ geo: beamGeo(v(0.1, 0.03, -hl / S - 0.6), v(0.1, lift / S + 0.6, -hl / S - 0.02), 0.03 * S), mat: MAT.metal, tone: 0.05 });
  // A drum of fuel for it.
  const drum = drumGeometry();
  P(drum, [gx + 1.0 * S, 0, gz + 0.2 * S], MAT.paint, 0.5, [0, R() * 6, 0]);

  // Low sandbag wall on the generator's open side.
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S, segU: 6, segV: 4 };
  parts.push({ geo: buildSandbagWall({ length: 2.4 * S, courses: 3, seed, bag, batter: 0.03 }), pos: [gx + 1.0 * S, 0, gz - 1.0 * S], mat: null });
  const geo = assemble(parts);
  drum.dispose();
  bakeContactAO(geo, { cell: 0.2 * S, radius: 2, strength: 0.35, groundFade: 0.3, floor: 0.55 });
  // The ground the piece stands on (local metres), for levelling its pad —
  // shelter, step and generator. NOT the bounding box: the mast's guys reach
  // 7 m out and a pad that size cut a pit into the slope.
  const z0 = gz - 1.4 * S, z1 = hl + 0.7 * S;
  geo.userData.footprint = { cx: 0.2 * S, cz: (z0 + z1) / 2, hx: hw + 0.9 * S, hz: (z1 - z0) / 2 };
  return geo;
}

// ── 10. Camp gate ────────────────────────────────────────────────────────────
/**
 * The way into a firebase: an opening `width` metres wide (real) across X,
 * the road running through it along Z, sandbag walls flanking it on the
 * perimeter line, a sandbagged guard booth inside on the -X side, and a
 * striped barrier boom on a pivot post — RAISED, so units driving through
 * never pass through it.
 */
export function buildGate({ seed = 43, width = 5 } = {}) {
  const R = rng(seed);
  const parts = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => parts.push({ geo, pos, rot, mat, tone });
  const hw = (width * S) / 2;
  const bag = { length: 0.52 * S, width: 0.30 * S, height: 0.19 * S, segU: 6, segV: 4 };
  // Flanking walls on the perimeter line.
  for (const sx of [-1, 1]) {
    parts.push({ geo: buildSandbagWall({ length: 3.2 * S, courses: 5, seed: seed + (sx > 0 ? 1 : 2), bag, batter: 0.03 }), pos: [sx * (hw + 1.8 * S), 0, 0], mat: null });
  }
  // Guard booth: posts, plank half-walls, open above them, a single-slope roof.
  const bx = -(hw + 2.2 * S), bz = 2.6 * S, bw = 1.9 * S, bd = 1.9 * S, bh = 2.3 * S;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) P(buildBox(0.12 * S, bh, 0.12 * S), [bx + sx * (bw / 2 - 0.06 * S), bh / 2, bz + sz * (bd / 2 - 0.06 * S)], MAT.timber, 0.35);
  const wallH = 1.05 * S;
  // Walls set in between the posts: flush with their outer faces, they z-fought.
  P(buildBox(bw - 0.12 * S, wallH, 0.05 * S), [bx, wallH / 2, bz - bd / 2 + 0.06 * S], MAT.timber, 0.45 + R() * 0.2);
  P(buildBox(bw - 0.12 * S, wallH, 0.05 * S), [bx, wallH / 2, bz + bd / 2 - 0.06 * S], MAT.timber, 0.45 + R() * 0.2);
  P(buildBox(0.05 * S, wallH - 0.01 * S, bd - 0.12 * S), [bx - bw / 2 + 0.06 * S, (wallH - 0.01 * S) / 2, bz], MAT.timber, 0.45 + R() * 0.2);
  // The road side stays open above a sill, where the guard leans out.
  P(buildBox(0.05 * S, 0.35 * S, bd - 0.12 * S), [bx + bw / 2 - 0.06 * S, wallH - 0.185 * S, bz], MAT.white, 0.5);
  const roof = buildCorrugatedPanel({ width: bd + 0.5 * S, height: bw + 0.5 * S, thickness: 0.02 * S, ribs: 8, ribDepth: 0.03 * S });
  // Laid flat (height → -Z), turned so the sheet runs across X, pitched to
  // shed toward the road.
  roof.rotateX(-Math.PI / 2).translate(0, 0, (bw + 0.5 * S) / 2).rotateY(Math.PI / 2).rotateZ(-0.12).translate(bx, bh + 0.08 * S, bz);
  P(roof, [0, 0, 0], MAT.metal, 0.45);
  parts.push({ geo: buildSandbagRing({ radius: 1.55 * S, courses: 3, seed: seed + 5, bag, gapDeg: 70 }), pos: [bx, 0, bz], rot: [0, -Math.PI / 2, 0], mat: null });
  // Barrier: pivot post with its counterweight, the boom raised 72°.
  const px = -hw + 0.15 * S, pz = -0.6 * S, ph = 1.0 * S;
  P(buildBox(0.22 * S, ph, 0.22 * S), [px, ph / 2, pz], MAT.white, 0.5);
  const boomL = width * S + 0.6 * S, seg = 0.55 * S, n = Math.ceil(boomL / seg), up = 1.25;
  const dir = new THREE.Vector3(Math.cos(up), Math.sin(up), 0);
  for (let k = 0; k < n; k++) {
    const a = new THREE.Vector3(px, ph + 0.06 * S, pz).addScaledVector(dir, k * seg);
    const b = a.clone().addScaledVector(dir, Math.min(seg, boomL - k * seg));
    parts.push({ geo: beamGeo(a, b, 0.09 * S), mat: k % 2 ? MAT.paint : MAT.white, tone: k % 2 ? 0.3 : 0.55 });
  }
  const cw = new THREE.Vector3(px, ph + 0.06 * S, pz).addScaledVector(dir, -0.55 * S);
  P(buildBox(0.3 * S, 0.3 * S, 0.3 * S), [cw.x, cw.y, cw.z], MAT.concrete, 0.4);
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.18 * S, radius: 2, strength: 0.35, groundFade: 0.3, floor: 0.55 });
  geo.userData.footprint = { cx: -1.2 * S, cz: 1.0 * S, hx: hw + 4 * S, hz: 3 * S };
  return geo;
}

/** A small Conex yard: two side by side, one stacked, one turned. */
export function buildConexYard({ seed = 23 } = {}) {
  const R = rng(seed);
  const W = 1.9 * S, H = 2.08 * S;
  const a = buildConex({ seed: seed + 1 }), b = buildConex({ seed: seed + 2 }), c = buildConex({ seed: seed + 3 }), d = buildConex({ seed: seed + 4 });
  const parts = [
    { geo: a, pos: [0, 0, 0], rot: [0, (R() - 0.5) * 0.04, 0], mat: null },
    { geo: b, pos: [W + 0.25 * S, 0, 0.1 * S], rot: [0, (R() - 0.5) * 0.06, 0], mat: null },
    { geo: c, pos: [0.15 * S, H + 0.015 * S, 0.05 * S], rot: [0, 0.03, 0], mat: null },   // on the raised roof plate
    { geo: d, pos: [-W * 1.6, 0, 1.2 * S], rot: [0, Math.PI / 2 + 0.2, 0], mat: null },
  ];
  const geo = assemble(parts);
  // Each box's markings go where the box went.
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  geo.userData.stencil = mergeStencils(parts.map((p) => {
    const st = p.geo.userData.stencil;
    if (!st) return null;
    q.setFromEuler(new THREE.Euler(...p.rot));
    return st.clone().applyMatrix4(m.compose(new THREE.Vector3(...p.pos), q, one));
  }));
  for (const p of parts) { p.geo.userData.stencil?.dispose(); p.geo.dispose(); }
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
