/**
 * THE FRONT'S BASE CAMP — what an NVA / VC base camp is made of, as opposed to
 * a firebase (rtsFirebaseProps.js). Your ask (2026-09-23): "their base is still
 * empty next to ours … it should feel like Vietnam, like Apocalypse Now."
 *
 * A firebase is steel, sandbags and olive drab on bulldozed ground. A base
 * camp is BAMBOO, THATCH AND EARTH under the trees — lashed, woven, dug, and
 * hidden: camouflage netting slung between trunks, a cook house whose smoke
 * runs out along a covered trench so no column rises (the Hoàng Cầm stove,
 * Điện Biên Phủ), bicycles that carried the rice down the trail, the guard
 * tower lashed from the forest it stands in.
 *
 * Same contract as the rest of the kit (rtsParts.js): one merged geometry on
 * the atlas material, origin at the ground centre on y = 0, `userData.footprint`
 * and `userData.height`; painted markings (the NLF banner) ride in
 * `userData.stencil`. Props are real size x 1.3 (S); building SPANS x 1.6 (B)
 * like the hamlet, pole and thatch thickness real.
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";
import { pole, rail, thatchAt } from "./rtsVillage.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";

const S = 1.3;
const B = 1.6;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** A round member from point a to point b (bamboo, a log, a strut). */
function strut(parts, a, b, radius, mat = MAT.bamboo, tone = 0.4, sides = 6) {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  const geo = new THREE.CylinderGeometry(radius, radius, len, sides);
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.clone().normalize());
  const m = new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, V(1, 1, 1));
  parts.push({ geo, matrix: m, mat, tone });
}

/** A thatched gable roof: ridge along X at `ridgeY`, eaves at `eaveY`, `hx` x `hz` half-spans. */
function gableRoof(parts, hx, hz, eaveY, ridgeY, seed, { courses = 6 } = {}) {
  for (const sz of [-1, 1]) {
    thatchAt(parts, {
      eave: V(0, eaveY, sz * hz), ridge: V(0, ridgeY, 0), along: V(1, 0, 0),
      width: hx * 2, courses, seed: seed + (sz > 0 ? 1 : 0),
    });
  }
  // The ridge cap: a bundle of thatch along the top.
  parts.push({ geo: new THREE.CylinderGeometry(0.16, 0.16, hx * 2 + 0.2, 6).rotateZ(Math.PI / 2), pos: [0, ridgeY + 0.06, 0], mat: MAT.thatch, tone: 0.15 });
}

function finish(parts, footprint, height, ao = {}) {
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.2, radius: 2, strength: 0.45, groundFade: 0.3, floor: 0.5, ...ao });
  geo.userData.footprint = footprint;
  geo.userData.height = height;
  return geo;
}

// ── The guard tower ──────────────────────────────────────────────────────────
/**
 * NOT our steel-and-timber tower: four raked bamboo legs lashed with X braces,
 * a split-bamboo platform with a waist-high rail, a thatch cap, a ladder of
 * lashed rungs, and a length of shell casing hung under the cap to beat as the
 * alarm.
 */
export function buildBambooWatchtower({ seed = 101 } = {}) {
  const r = rng(seed);
  const parts = [];
  const H = 6.2 * S, foot = 1.9 * S, top = 1.15 * S;
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const base = legs.map(([x, z]) => V(x * foot, 0, z * foot));
  const head = legs.map(([x, z]) => V(x * top, H, z * top));
  for (let k = 0; k < 4; k++) strut(parts, base[k], head[k].clone().setY(H + 1.6), 0.085, MAT.bamboo, 0.3 + r() * 0.4, 7);
  // X braces on every face, two storeys.
  const at = (k, t) => base[k].clone().lerp(head[k], t);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    for (const [t0, t1] of [[0.08, 0.5], [0.5, 0.92]]) {
      strut(parts, at(k, t0), at(k2, t1), 0.04, MAT.bamboo, 0.4 + r() * 0.3, 5);
      strut(parts, at(k2, t0), at(k, t1), 0.04, MAT.bamboo, 0.4 + r() * 0.3, 5);
    }
  }
  // The platform: split-bamboo slats on two bearers.
  const pw = top * 2 + 0.5;
  for (const z of [-top, top]) strut(parts, V(-pw / 2, H - 0.05, z), V(pw / 2, H - 0.05, z), 0.06, MAT.bamboo, 0.3);
  for (let i = 0; i < 11; i++) {
    const x = -pw / 2 + (i + 0.5) * (pw / 11);
    parts.push({ geo: buildBox(pw / 11 - 0.02, 0.05, pw), pos: [x, H + 0.03, 0], rot: [0, 0, (r() - 0.5) * 0.04], mat: MAT.bamboo, tone: 0.45 + r() * 0.35 });
  }
  // The rail, and woven screens on the two sides that face the enemy.
  for (let k = 0; k < 4; k++) {
    const a = head[k].clone().setY(H + 1.0), b = head[(k + 1) % 4].clone().setY(H + 1.0);
    strut(parts, a, b, 0.035, MAT.bamboo, 0.5);
  }
  parts.push({ geo: buildBox(pw, 0.9, 0.05), pos: [0, H + 0.5, -top - 0.02], mat: MAT.woven, tone: 0.4 });
  parts.push({ geo: buildBox(0.05, 0.9, pw), pos: [-top - 0.02, H + 0.5, 0], mat: MAT.woven, tone: 0.5 });
  // The thatch cap, a four-way pyramid.
  const capY = H + 1.6, eave = top + 0.9, peak = capY + 1.3;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const out = V(Math.sin(a), 0, Math.cos(a));
    thatchAt(parts, {
      eave: out.clone().multiplyScalar(eave).setY(capY), ridge: V(0, peak, 0),
      along: V(Math.cos(a), 0, -Math.sin(a)), width: eave * 2.05, topWidth: 0.1, courses: 5, seed: seed + k,
    });
  }
  // The ladder up the front leg pair (-Z), rungs lashed across two rails.
  const lx = 0.32;
  for (const sx of [-1, 1]) strut(parts, V(sx * lx, 0, -foot - 0.5), V(sx * lx, H + 0.1, -top - 0.05), 0.035, MAT.bamboo, 0.35);
  for (let i = 1; i < 14; i++) {
    const t = i / 14;
    const y = H * t, z = -foot - 0.5 + (foot + 0.5 - top - 0.05) * t;
    strut(parts, V(-lx, y, z), V(lx, y, z), 0.025, MAT.bamboo, 0.55);
  }
  // The alarm: a shell casing on a cord under the cap, and its beater.
  parts.push({ geo: new THREE.CylinderGeometry(0.09, 0.1, 0.55, 10), pos: [top * 0.6, capY - 0.55, top * 0.6], mat: MAT.metal, tone: 0.7 });
  parts.push({ geo: new THREE.CylinderGeometry(0.008, 0.008, 0.3, 4), pos: [top * 0.6, capY - 0.13, top * 0.6], mat: MAT.timber, tone: 0.2 });
  return finish(parts, { cx: 0, cz: 0, hx: foot + 0.2, hz: foot + 0.6 }, peak + 0.1, { cell: 0.25, radius: 2 });
}

// ── The long house (barracks) ────────────────────────────────────────────────
/**
 * Where the platoon sleeps: a long low house on the earth, woven walls to
 * shoulder height, a thatch roof down to head height, an open doorway in the
 * long side (+Z, the camera's), and the hammocks' line of rolled sleeping
 * mats along the eave. `bays` sets its length.
 */
export function buildLongHouse({ seed = 111, bays = 5 } = {}) {
  const r = rng(seed);
  const parts = [];
  const bay = 1.7 * B, hx = (bays * bay) / 2, hz = 2.2 * B;
  const wallH = 1.5 * B * 0.8, eaveY = wallH + 0.05, ridgeY = eaveY + 2.1 * B * 0.7;
  // Earth floor, a hand's width proud.
  parts.push({ geo: buildBox(hx * 2 + 0.6, 0.1, hz * 2 + 0.6), pos: [0, 0.05, 0], mat: MAT.earth, tone: 0.3 });
  // Posts at every bay, both long sides, and the ridge posts at the ends.
  for (let i = 0; i <= bays; i++) {
    const x = -hx + i * bay;
    for (const sz of [-1, 1]) pole(parts, x, sz * hz, eaveY, r, { radius: 0.07 });
  }
  for (const sx of [-1, 1]) pole(parts, sx * hx, 0, ridgeY, r, { radius: 0.08 });
  // Woven walls between the posts; a doorway in the middle bay of the +Z side.
  const door = Math.floor(bays / 2);
  for (let i = 0; i < bays; i++) {
    const x = -hx + (i + 0.5) * bay;
    parts.push({ geo: buildBox(bay - 0.12, wallH, 0.06), pos: [x, wallH / 2 + 0.1, -hz], mat: MAT.woven, tone: 0.3 + r() * 0.4 });
    if (i !== door) parts.push({ geo: buildBox(bay - 0.12, wallH, 0.06), pos: [x, wallH / 2 + 0.1, hz], mat: MAT.woven, tone: 0.3 + r() * 0.4 });
  }
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.06, wallH, hz * 2 - 0.1), pos: [sx * hx, wallH / 2 + 0.1, 0], mat: MAT.woven, tone: 0.45 });
  // Wall plates and the roof, overhanging a metre all round.
  for (const sz of [-1, 1]) rail(parts, -hx - 0.3, sz * hz, hx + 0.3, sz * hz, eaveY, r, { radius: 0.06 });
  gableRoof(parts, hx + 1.0, hz + 1.2, eaveY - 0.35, ridgeY, seed, { courses: 7 });
  // Gable ends: woven triangles closing the roof.
  for (const sx of [-1, 1]) {
    const tri = new THREE.BufferGeometry().setFromPoints([V(0, eaveY, -hz), V(0, ridgeY, 0), V(0, eaveY, hz)]);
    tri.setIndex(sx > 0 ? [0, 1, 2] : [0, 2, 1]);
    tri.computeVertexNormals();
    parts.push({ geo: tri, pos: [sx * hx, 0, 0], mat: MAT.woven, tone: 0.35 });
  }
  // Rolled sleeping mats and packs by the door, a rifle leaning on the post.
  for (let k = 0; k < 4; k++) {
    parts.push({ geo: new THREE.CylinderGeometry(0.12, 0.12, 0.7, 8).rotateZ(Math.PI / 2), pos: [(door - bays / 2 + 0.5) * bay + (k - 1.5) * 0.4, 0.22, hz + 0.45 + (k % 2) * 0.1], mat: MAT.woven, tone: 0.55 + r() * 0.3 });
  }
  parts.push({ geo: buildBox(0.5, 0.45, 0.3), pos: [(door - bays / 2 + 0.5) * bay + 1.3, 0.33, hz + 0.4], rot: [0, 0.3, 0], mat: MAT.canvas, tone: 0.4 });
  return finish(parts, { cx: 0, cz: 0, hx: hx + 0.4, hz: hz + 0.4 }, ridgeY + 0.3, { cell: 0.3, radius: 2 });
}

// ── The cook house ───────────────────────────────────────────────────────────
/**
 * A thatch roof on four posts over a clay hearth — and the Hoàng Cầm stove's
 * whole point: the smoke does not go UP. It runs out along a covered trench
 * dug downhill, under a lid of branches and earth, and seeps out over twenty
 * metres of ground as a thin haze a spotter plane cannot see. The trench is
 * the long low ridge of earth and leaves leaving the back of the house.
 */
export function buildCookHouse({ seed = 121 } = {}) {
  const r = rng(seed);
  const parts = [];
  const hx = 2.0 * B, hz = 1.6 * B, eaveY = 1.6 * B * 0.85, ridgeY = eaveY + 1.3 * B;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pole(parts, sx * hx, sz * hz, eaveY, r, { radius: 0.07 });
  gableRoof(parts, hx + 0.8, hz + 0.9, eaveY - 0.2, ridgeY, seed, { courses: 6 });
  // The hearth: a clay firebox with two pot holes, the pots on it.
  parts.push({ geo: buildBox(1.6, 0.55, 0.9), pos: [0, 0.28, -0.3], mat: MAT.earth, tone: 0.55 });
  for (const sx of [-0.4, 0.4]) {
    parts.push({ geo: new THREE.CylinderGeometry(0.28, 0.2, 0.32, 12), pos: [sx, 0.7, -0.3], mat: MAT.steel, tone: 0.15 });
    parts.push({ geo: new THREE.CylinderGeometry(0.3, 0.3, 0.04, 12), pos: [sx, 0.87, -0.3], mat: MAT.metal, tone: 0.35 });
  }
  // Firewood stack and a rice sack.
  for (let k = 0; k < 9; k++) {
    parts.push({ geo: new THREE.CylinderGeometry(0.06, 0.06, 0.9, 5).rotateZ(Math.PI / 2), pos: [hx - 0.7, 0.07 + Math.floor(k / 3) * 0.12, 0.6 + (k % 3) * 0.13], mat: MAT.timber, tone: 0.3 + r() * 0.4 });
  }
  parts.push({ geo: buildBox(0.55, 0.65, 0.4), pos: [-hx + 0.8, 0.33, 0.7], rot: [0, 0.4, 0.05], mat: MAT.hessian, tone: 0.65 });
  // THE SMOKE TRENCH: out the back (-Z), a low ridge of earth with branches
  // laid over it, 7 m long, forking twice.
  const trench = (x0, z0, x1, z1, w) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const a = Math.atan2(x1 - x0, z1 - z0);
    parts.push({ geo: buildBox(w, 0.28, len), pos: [(x0 + x1) / 2, 0.12, (z0 + z1) / 2], rot: [0, a, 0], mat: MAT.earth, tone: 0.35 });
    for (let k = 0; k < Math.round(len / 0.7); k++) {
      const t = (k + 0.5) / Math.round(len / 0.7);
      parts.push({
        geo: buildBox(w * 1.3, 0.05, 0.12), pos: [x0 + (x1 - x0) * t, 0.28, z0 + (z1 - z0) * t],
        rot: [0, a + (r() - 0.5) * 0.9, 0], mat: MAT.timber, tone: 0.2 + r() * 0.3,
      });
    }
  };
  trench(0, -0.8, 0.3, -hz - 3.5, 0.8);
  trench(0.3, -hz - 3.5, -1.4, -hz - 7.5, 0.55);
  trench(0.3, -hz - 3.5, 2.0, -hz - 7.0, 0.55);
  return finish(parts, { cx: 0, cz: -1.5, hx: hx + 0.3, hz: hz + 2.5 }, ridgeY + 0.3, { cell: 0.25 });
}

// ── Weapons rack ─────────────────────────────────────────────────────────────
/** An A-frame of bamboo with the platoon's rifles stood in it, butts in the dirt. */
export function buildWeaponsRack({ seed = 131, rifles = 7 } = {}) {
  const r = rng(seed);
  const parts = [];
  const w = 2.4 * S, h = 1.2 * S;
  for (const sx of [-1, 1]) {
    strut(parts, V(sx * w / 2, 0, -0.4), V(sx * w / 2, h, 0), 0.04, MAT.bamboo, 0.4);
    strut(parts, V(sx * w / 2, 0, 0.4), V(sx * w / 2, h, 0), 0.04, MAT.bamboo, 0.45);
  }
  strut(parts, V(-w / 2, h, 0), V(w / 2, h, 0), 0.04, MAT.bamboo, 0.5);
  strut(parts, V(-w / 2, h * 0.45, 0.2), V(w / 2, h * 0.45, 0.2), 0.03, MAT.bamboo, 0.5);
  for (let k = 0; k < rifles; k++) {
    const x = -w / 2 + 0.2 + (k * (w - 0.4)) / (rifles - 1);
    const lean = 0.28 + (r() - 0.5) * 0.08;
    // Stock (timber) and barrel + magazine (steel), one rifle as two boxes.
    const len = 0.9 * S;
    parts.push({ geo: buildBox(0.05, len * 0.4, 0.09).translate(0, len * 0.2, 0), pos: [x, 0, 0.42], rot: [-lean, 0, 0], mat: MAT.timber, tone: 0.35 + r() * 0.2 });
    parts.push({ geo: buildBox(0.035, len * 0.62, 0.05).translate(0, len * 0.4 + len * 0.31, 0), pos: [x, 0, 0.42], rot: [-lean, 0, 0], mat: MAT.steel, tone: 0.2 });
  }
  return finish(parts, { cx: 0, cz: 0.1, hx: w / 2 + 0.2, hz: 0.7 }, h + 0.1, { cell: 0.12, radius: 1 });
}

// ── Map table under a tarp ───────────────────────────────────────────────────
/** The command post: a plank table with a map, stools, and a canvas tarp on four poles. */
export function buildMapTable({ seed = 141 } = {}) {
  const r = rng(seed);
  const parts = [];
  const tw = 2.0 * S, td = 1.0 * S, th = 0.75 * S;
  parts.push({ geo: buildBox(tw, 0.06, td), pos: [0, th, 0], mat: MAT.timber, tone: 0.45 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push({ geo: buildBox(0.07, th, 0.07), pos: [sx * (tw / 2 - 0.1), th / 2, sz * (td / 2 - 0.1)], mat: MAT.timber, tone: 0.35 });
  // The map, and the stones holding its corners down.
  parts.push({ geo: buildBox(tw * 0.7, 0.01, td * 0.75), pos: [0, th + 0.035, 0], rot: [0, 0.08, 0], mat: MAT.white, tone: 0.6 });
  for (const [x, z] of [[-0.7, -0.35], [0.75, 0.35]]) parts.push({ geo: new THREE.SphereGeometry(0.06, 5, 4), pos: [x * S, th + 0.07, z * S], mat: MAT.concrete, tone: 0.4 });
  // Stools.
  for (const [x, z] of [[-0.6, 0.95], [0.5, 1.0], [1.4, -0.2]]) {
    parts.push({ geo: new THREE.CylinderGeometry(0.2, 0.22, 0.45, 8), pos: [x * S, 0.23, z * S], mat: MAT.timber, tone: 0.3 + r() * 0.3 });
  }
  // The tarp: four poles, the canvas sagging between them.
  const px = tw / 2 + 0.9, pz = td / 2 + 1.0, ph = 2.2 * S;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pole(parts, sx * px, sz * pz, ph + (sz > 0 ? 0 : 0.25), r, { radius: 0.045 });
  const tarp = new THREE.PlaneGeometry(px * 2 + 0.4, pz * 2 + 0.4, 8, 6).rotateX(-Math.PI / 2);
  const p = tarp.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (px + 0.2), z = p.getZ(i) / (pz + 0.2);
    p.setY(i, ph - 0.25 * (1 - x * x) * (1 - z * z) - z * 0.12);
  }
  tarp.computeVertexNormals();
  parts.push({ geo: tarp, mat: MAT.canvas, tone: 0.35 });
  return finish(parts, { cx: 0, cz: 0, hx: px + 0.3, hz: pz + 0.3 }, ph + 0.3, { cell: 0.18 });
}

// ── Camouflage netting ───────────────────────────────────────────────────────
/**
 * A net slung between bamboo poles over a work area, sagging, with cut
 * branches thrown on it — what hides a base camp from the air. Drawn as a
 * draped sheet in the camo cell with leafy lumps on it.
 */
export function buildCamoNet({ seed = 151, w = 9, d = 7 } = {}) {
  const r = rng(seed);
  const parts = [];
  const hx = (w * S) / 2, hz = (d * S) / 2, hy = 2.6 * S;
  const posts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1.05], [0, 1.05]];
  for (const [x, z] of posts) pole(parts, x * hx, z * hz, hy + r() * 0.3, r, { radius: 0.05 });
  const net = new THREE.PlaneGeometry(hx * 2 + 1, hz * 2 + 1, 12, 10).rotateX(-Math.PI / 2);
  const p = net.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (hx + 0.5), z = p.getZ(i) / (hz + 0.5);
    // Sags between posts, droops at the free edges.
    const sag = 0.55 * (1 - x * x) * (1 - z * z) + 0.35 * Math.max(0, Math.abs(z) - 0.9) * 10;
    p.setY(i, hy - sag + (r() - 0.5) * 0.12);
  }
  net.computeVertexNormals();
  parts.push({ geo: net, mat: MAT.camo, tone: 0.45 });
  // Branches thrown on top: flattened leafy lumps.
  for (let k = 0; k < 16; k++) {
    const x = (r() * 2 - 1) * hx * 0.9, z = (r() * 2 - 1) * hz * 0.9;
    const sag = 0.55 * (1 - (x / hx) ** 2) * (1 - (z / hz) ** 2);
    parts.push({ geo: new THREE.SphereGeometry(0.5 + r() * 0.4, 5, 4).scale(1.4, 0.35, 1), pos: [x, hy - sag + 0.12, z], rot: [0, r() * 6, 0], mat: MAT.thatch, tone: 0.1 + r() * 0.2 });
  }
  return finish(parts, { cx: 0, cz: 0, hx: hx + 0.2, hz: hz + 0.2 }, hy + 0.4, { cell: 0.3, strength: 0.3 });
}

// ── The bicycle park ─────────────────────────────────────────────────────────
/**
 * The supply bicycles that carried the Trail: heavy black frames leaning on a
 * bamboo rail, each loaded with rice sacks slung either side and a steering
 * pole lashed to the handlebar.
 */
export function buildBicycleRow({ seed = 161, bikes = 4 } = {}) {
  const r = rng(seed);
  const parts = [];
  const gap = 1.0 * S, R = 0.34 * S;
  const len = (bikes - 1) * gap;
  for (const sx of [-1, 1]) pole(parts, sx * (len / 2 + 0.6), -0.55, 1.0 * S, r, { radius: 0.045 });
  rail(parts, -len / 2 - 0.6, -0.55, len / 2 + 0.6, -0.55, 0.9 * S, r, { radius: 0.035 });
  for (let k = 0; k < bikes; k++) {
    const x = -len / 2 + k * gap;
    const lean = 0.18 + (r() - 0.5) * 0.06;
    const bp = [];
    // Two wheels (in the Y-Z plane, the bike runs along Z) and the frame.
    for (const z of [-0.55 * S, 0.55 * S]) bp.push({ geo: new THREE.TorusGeometry(R, 0.03, 5, 16).rotateY(Math.PI / 2), pos: [0, R, z], mat: MAT.rubber, tone: 0.2 });
    const a = V(0, R, -0.55 * S), b = V(0, R, 0.55 * S), seat = V(0, R + 0.55, -0.15), bar = V(0, R + 0.62, 0.42 * S);
    strut(bp, a, seat, 0.025, MAT.steel, 0.1); strut(bp, seat, bar, 0.025, MAT.steel, 0.1);
    strut(bp, V(0, R + 0.05, 0), seat, 0.025, MAT.steel, 0.1); strut(bp, V(0, R + 0.05, 0), bar, 0.025, MAT.steel, 0.1);
    strut(bp, bar, b, 0.025, MAT.steel, 0.1);
    // The load: two rice sacks either side of the frame, and the steering pole.
    for (const sx of [-1, 1]) bp.push({ geo: buildBox(0.28, 0.5, 0.55), pos: [sx * 0.2, R + 0.35, -0.05], rot: [0, 0, sx * 0.12], mat: MAT.hessian, tone: 0.5 + r() * 0.3 });
    strut(bp, V(0, R + 0.62, 0.42 * S), V(0.5, R + 0.95, 0.9 * S), 0.02, MAT.bamboo, 0.4);
    // Leaning on the rail: the whole bike rolled onto its side a little.
    const sub = assemble(bp);
    parts.push({ geo: sub, pos: [x, 0, 0.1], rot: [0, 0, lean] });
  }
  return finish(parts, { cx: 0, cz: 0, hx: len / 2 + 0.8, hz: 1.0 }, 1.4 * S, { cell: 0.12, radius: 1 });
}

// ── Propaganda board ─────────────────────────────────────────────────────────
/**
 * The camp's notice board: a woven panel on two posts carrying the NLF
 * banner, a bench before it for the political officer's meetings, and a
 * loudspeaker horn on a pole beside it.
 */
export function buildPropagandaBoard({ seed = 171 } = {}) {
  const r = rng(seed);
  const parts = [];
  const w = 3.0 * S, h = 1.6 * S, y0 = 0.9 * S;
  for (const sx of [-1, 1]) pole(parts, sx * (w / 2 + 0.05), 0, y0 + h + 0.3, r, { radius: 0.06 });
  parts.push({ geo: buildBox(w, h, 0.06), pos: [0, y0 + h / 2, 0], mat: MAT.woven, tone: 0.55 });
  // The bench.
  parts.push({ geo: buildBox(w * 0.9, 0.06, 0.35), pos: [0, 0.45, -1.6], mat: MAT.bamboo, tone: 0.5 });
  for (const sx of [-1, 1]) parts.push({ geo: buildBox(0.06, 0.45, 0.3), pos: [sx * w * 0.4, 0.22, -1.6], mat: MAT.bamboo, tone: 0.45 });
  // The loudspeaker: a horn on its own pole, cable down it.
  pole(parts, w / 2 + 1.2, 0.3, 3.4 * S, r, { radius: 0.05 });
  parts.push({ geo: new THREE.CylinderGeometry(0.28, 0.06, 0.55, 12, 1, true).rotateX(-Math.PI / 2), pos: [w / 2 + 1.2, 3.4 * S - 0.1, 0.05], mat: MAT.metal, tone: 0.55 });
  const geo = finish(parts, { cx: 0.6, cz: -0.6, hx: w / 2 + 1.4, hz: 1.2 }, 3.5 * S, { cell: 0.2 });
  // The banner, painted on the board's face toward -Z (the bench, and the camera
  // coming from the south).
  geo.userData.stencil = mergeStencils([
    stencilPatch("nlfBanner", flatSurface([0, y0 + h / 2, -0.04], [0, 0, -1], [-1, 0, 0], w * 0.86, "nlfBanner"), { lift: 0.004 }),
    stencilPatch("nlfBanner", flatSurface([0, y0 + h / 2, 0.04], [0, 0, 1], [1, 0, 0], w * 0.86, "nlfBanner"), { lift: 0.004 }),
  ]);
  return geo;
}

// (The camp's FLAG is the engine's Verlet cloth flag, like the one over the
// US camp — games/nam-rts/enemyCamp.js plants it — not a flat panel.)

// ── Tiger cages ──────────────────────────────────────────────────────────────
/**
 * Low bamboo cages on the mud, a man could not stand in one: a frame, bars on
 * every side, a lashed lid, and a water jar outside the bars. One is occupied
 * (`prisoner`: a crouched figure inside) — a possible objective later.
 */
export function buildTigerCage({ seed = 191, prisoner = false } = {}) {
  const r = rng(seed);
  const parts = [];
  const hx = 1.1 * S, hz = 0.8 * S, hy = 1.0 * S;
  parts.push({ geo: buildBox(hx * 2 + 0.6, 0.05, hz * 2 + 0.6), pos: [0, 0.025, 0], mat: MAT.earth, tone: 0.2 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) pole(parts, sx * hx, sz * hz, hy + 0.1, r, { radius: 0.05, lean: 0 });
  for (const y of [0.1, hy]) {
    for (const sz of [-1, 1]) rail(parts, -hx, sz * hz, hx, sz * hz, y, r, { radius: 0.035 });
    for (const sx of [-1, 1]) rail(parts, sx * hx, -hz, sx * hx, hz, y, r, { radius: 0.035 });
  }
  // Bars: every 16 cm round the sides.
  const bar = (x, z) => parts.push({ geo: new THREE.CylinderGeometry(0.022, 0.022, hy - 0.1, 5), pos: [x, 0.1 + (hy - 0.1) / 2, z], mat: MAT.bamboo, tone: 0.3 + r() * 0.4 });
  for (let x = -hx + 0.16; x < hx; x += 0.16) { bar(x, -hz); bar(x, hz); }
  for (let z = -hz + 0.16; z < hz; z += 0.16) { bar(-hx, z); bar(hx, z); }
  // The lid: slats across the top.
  for (let x = -hx; x <= hx; x += 0.14) parts.push({ geo: buildBox(0.08, 0.04, hz * 2 + 0.1), pos: [x, hy + 0.03, 0], mat: MAT.bamboo, tone: 0.45 + r() * 0.3 });
  if (prisoner) {
    // A crouched man in black: back, head, knees drawn up.
    parts.push({ geo: new THREE.SphereGeometry(0.28, 8, 6).scale(1, 1.2, 0.9), pos: [0.1, 0.42, 0], mat: MAT.steel, tone: 0.05 });
    parts.push({ geo: new THREE.SphereGeometry(0.12, 8, 6), pos: [0.12, 0.82, 0.05], mat: MAT.timber, tone: 0.75 });
  }
  parts.push({ geo: new THREE.CylinderGeometry(0.2, 0.16, 0.45, 10), pos: [hx + 0.45, 0.23, 0.2], mat: MAT.earth, tone: 0.6 });
  return finish(parts, { cx: 0, cz: 0, hx: hx + 0.3, hz: hz + 0.3 }, hy + 0.1, { cell: 0.14, radius: 1 });
}

// ── Fighting positions ───────────────────────────────────────────────────────
/**
 * A one-man fighting hole: a dark ring of dug earth, its spoil thrown up as a
 * low parapet on the enemy side, a few logs laid across the front. (The ground
 * is not excavated — the hole is a dark disc sunk below the rim.)
 */
export function buildFoxhole({ seed = 201 } = {}) {
  const r = rng(seed);
  const parts = [];
  const R = 0.75 * S;
  parts.push({ geo: new THREE.CylinderGeometry(R, R * 0.9, 0.3, 14), pos: [0, -0.12, 0], mat: MAT.steel, tone: 0.02 });
  // The parapet: a crescent of spoil on the -Z side (toward the enemy, i.e.
  // the player coming from the south).
  for (let k = 0; k < 9; k++) {
    const a = Math.PI + (k / 8 - 0.5) * 2.4;
    parts.push({ geo: new THREE.SphereGeometry(0.45 + r() * 0.12, 7, 5).scale(1, 0.45, 0.8), pos: [Math.sin(a) * (R + 0.3), 0.08, Math.cos(a) * (R + 0.3)], rot: [0, -a, 0], mat: MAT.earth, tone: 0.3 + r() * 0.3 });
  }
  for (let k = 0; k < 2; k++) strut(parts, V(-0.9, 0.3 + k * 0.18, -R - 0.35), V(0.9, 0.28 + k * 0.18, -R - 0.4), 0.09, MAT.timber, 0.3 + r() * 0.3);
  return finish(parts, { cx: 0, cz: -0.3, hx: R + 0.7, hz: R + 0.8 }, 0.7, { cell: 0.15, radius: 1 });
}

/**
 * A length of trench: the spoil bank on the enemy side, faced with a row of
 * logs pegged in, a dark slot behind it (the trench itself), and cut branches
 * laid along the top as camouflage. `length` in metres, along X.
 */
export function buildTrenchBerm({ seed = 211, length = 10 } = {}) {
  const r = rng(seed);
  const parts = [];
  const L = length * S;
  // The slot.
  parts.push({ geo: buildBox(L, 0.3, 0.9), pos: [0, -0.1, 0.35], mat: MAT.steel, tone: 0.02 });
  // The bank: overlapping mounds.
  const n = Math.max(3, Math.round(L / 1.4));
  for (let k = 0; k < n; k++) {
    const x = -L / 2 + (k + 0.5) * (L / n);
    parts.push({ geo: new THREE.SphereGeometry(1.0, 8, 5).scale(L / n * 0.75, 0.42, 0.9), pos: [x, 0.05, -0.55], mat: MAT.earth, tone: 0.3 + r() * 0.35 });
  }
  // Log facing, a peg every two metres.
  for (let k = 0; k < 2; k++) strut(parts, V(-L / 2, 0.15 + k * 0.2, -0.05), V(L / 2, 0.14 + k * 0.2, -0.05), 0.1, MAT.timber, 0.3 + r() * 0.3, 7);
  for (let x = -L / 2 + 0.5; x < L / 2; x += 2) parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 0.7, 5), pos: [x, 0.3, 0.05], mat: MAT.timber, tone: 0.4 });
  // Camouflage: cut branches along the top of the bank.
  for (let k = 0; k < Math.round(L / 1.2); k++) {
    parts.push({ geo: new THREE.SphereGeometry(0.4 + r() * 0.3, 5, 4).scale(1.5, 0.35, 0.8), pos: [-L / 2 + r() * L, 0.45, -0.6 + (r() - 0.5) * 0.4], rot: [0, r() * 6, 0], mat: MAT.thatch, tone: 0.08 + r() * 0.2 });
  }
  return finish(parts, { cx: 0, cz: -0.2, hx: L / 2 + 0.2, hz: 1.4 }, 0.9, { cell: 0.2 });
}
