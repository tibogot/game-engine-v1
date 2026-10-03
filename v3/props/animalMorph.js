// ANIMAL MORPH — goats, sheep and camels made from the animal pack's DONKEY.
//
// Moved out of v3/sheep-lab.html (2026-09-27) so the lab and the games build
// the SAME animals: fine-tune in the lab, and what the game gets follows.
// The lab keeps the scene, the preview materials and the GUI; this module
// holds the parameters and the builder.
//
// How an animal is made (the long story is in the lab's header):
//   · the donkey's mesh, welded, its authored quads recovered from its normals;
//   · its skeleton re-proportioned per species (bone offsets AND the matching
//     clip translation tracks), the geometry scaled along each bone with it;
//   · the IK foot bones re-placed to follow the new legs, per clip key, so the
//     hooves stay attached and keep the donkey's flex;
//   · per species: the goat's horns, beard, hanging ears and upturned tail;
//     the sheep's wool and tail nub; the camel's hump, S-neck and pads;
//   · every clip lifted out of the ground where the new body would sink.
// Every build logs its own health: open edges, inside-out faces, hoof flex.
//
// Games: `await initAnimalMorph(donkeyGltf)`, then `createMorphTemplate("goat")`
// → { root, source, clips, walkSpeed, runSpeed, height } for the shared crowd
// herds (games/shared-rts/wildHerd.js). One GPU crowd draw per species.
// A PUBLIC engine module (listed in v3/engine.js): keep its exports stable.
import * as THREE from "three";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { MeshoptSimplifier } from "meshoptimizer";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

// ── Parameters ───────────────────────────────────────────────────────────
export const PRESETS = {
  "Suffolk":      { woolColor: "#e9e2d0", faceColor: "#1b1715", legColor: "#1b1715", headWool: 0.55, horns: false, wool: 1.05, lumps: 0.9, earDroop: 0.55, earSize: 1.0,  head: 0.78 },
  "Texel":        { woolColor: "#efebe2", faceColor: "#ebe5da", legColor: "#e4ddd0", headWool: 0.25, horns: false, wool: 1.02, lumps: 0.7, earDroop: 0.1,  earSize: 0.8,  head: 0.76 },
  "Merino ram":   { woolColor: "#e8dcc2", faceColor: "#eadfcd", legColor: "#dfd3bf", headWool: 1.0,  horns: true,  wool: 1.18, lumps: 1.2, earDroop: 0.35, earSize: 0.85, head: 0.78 },
  "Blackface":    { woolColor: "#dcd4c3", faceColor: "#231f1c", legColor: "#2a2522", headWool: 0.0,  horns: true,  wool: 1.02, lumps: 1.4, earDroop: 0.3,  earSize: 0.9,  head: 0.8 },
  "Black sheep":  { woolColor: "#2e2622", faceColor: "#181412", legColor: "#181412", headWool: 0.6,  horns: false, wool: 1.05, lumps: 0.9, earDroop: 0.55, earSize: 1.0,  head: 0.78 },
};
export const P = {
  preset: "Suffolk",
  legs: 0.8, neck: 0.9, body: 0.72, head: 0.78, wool: 1.05, lumps: 0.9, headWool: 0.55,
  earDroop: 0.55, earSize: 1.0, legThick: 1.0, horns: false, size: 0.85,
  woolColor: "#e9e2d0", faceColor: "#1b1715", legColor: "#1b1715",
  clip: "Walk", speed: 1.0, treadmill: true, donkey: true, skeleton: false, turntable: false,
  flock: false, flockCount: 30,
  curl: 1.0, bump: 1.0, sheen: 0.6,
};

// Arabian camel (dromedary): one hump, long legs, S-neck, level head.
export const PC = {
  legs: 1.3, neck: 1.35, body: 0.88, head: 0.92, girth: 0.9, hump: 1.0, humpLen: 1.0,
  neckThick: 1.0, neckDip: 55, neckRise: 80, headPitch: -4, legThick: 1.0, size: 2.05,
  legSlim: 0.72, neckSlim: 0.8,        // donkey-morph only: pull legs / neck toward the bones
  color: "#c39a6b", dark: "#8c6843", light: "#e2cca6",
};
export const SPECIES = { value: "goat-morph" };
// North African goat (Arbia type): black-brown, leggy, long drooping ears,
// scimitar horns, beard, upturned tail.
// Vietnamese village pig (Móng Cái type): short legs, swayback, pot belly, small
// upright ears, short flat snout; black back, white-pink belly and legs.
export const PPIG = {
  legs: 0.52, neck: 0.45, body: 0.82, head: 0.8, size: 0.6, girth: 1.18, belly: 1.0, legThick: 1.12,
  neckDown: 22, ears: 0.55,
  coat: "#4a403c", pale: "#e6c9bc", pattern: "mongcai",
  // (knobs pig2 turns; these are the values this pig was built with)
  muzzle: -0.3, sway: 0.06, earOut: 0.45, earUp: 0.45, earFwd: 0.75, rim: 0.14, neckSlim: 1.15,
  jowl: 0.18, taper: 0.22, taperY: 0.18, headWide: 1, earWide: 1, jawLift: 0.3, rimY: 0.1,
};
// PIG 2 — after your low-poly pig family (2026-09-28), as a black Vietnamese
// village pig: a long LEVEL barrel (no withers hump, rounded rump), a long head
// held nearly level ending in a big round snout disc, BIG triangular ears
// standing up and out, medium straight legs.
export const PPIG2 = {
  // no neck (the crown continues the back), thick legs to the hoof, big ears
  legs: 0.64, neck: 0.3, body: 1.12, head: 0.94, size: 0.68, girth: 1.18, belly: 0.45, legThick: 1.35,
  neckDown: 24, ears: -0.1,
  coat: "#5a5756", pale: "#3f3c3b", pattern: "black",
  muzzle: -0.42, sway: 0, earOut: 0.9, earUp: 0.35, earFwd: 0.4, rim: 0.02, rimY: 0.45, neckSlim: 1.5,
  flatBack: true, snout: "#e0776b",
  // the pig's head: WIDE (no donkey taper), heavy jowls; broad triangular ears
  jowl: 0.32, taper: 0.02, taperY: 0.0, headWide: 1.4, upperWide: 1.02, earWide: 2.3, jawLift: 0.5, eyeRing: "#efebe5",
  brow: 0.035, cheek: 0.1, dome: 0.09, snoutOut: 0.08, earIn: "#9d968d", bridge: 0.06,
  poll: 1.6, fillGroove: true,
  hoofSlim: 0.72,
};
// ALGERIAN DONKEY: the pack's donkey as it is (shape, clips), in the colours of
// a North African village donkey — ash grey-brown, pale muzzle, eye rings and
// belly, a dark stripe along the spine crossed over the shoulders, dark mane,
// ear tips and tail tuft. (The base for the donkeys that carry loads.)
export const DONKEY_PRESETS = {
  "Aurès grey":  { coat: "#8d8378", pale: "#d9d1c4", dark: "#3a322c", hoof: "#2b2521", nose: "#4a4038" },
  "Brown":       { coat: "#6e5747", pale: "#cdbfae", dark: "#2d231d", hoof: "#241d18", nose: "#3b2f27" },
  "Pale dun":    { coat: "#b3a28a", pale: "#e3dbcd", dark: "#4a3d31", hoof: "#2e2621", nose: "#5a4c40" },
};
export const PDK = {
  preset: "Aurès grey",
  legs: 1, neck: 1, body: 1, head: 1, size: 1.1,        // a small village donkey, ~1.1 m at the back
  hump: 0, humpLen: 1,
  cross: true,                                           // the shoulder cross
  stripeW: 0.07, crossW: 0.06,                           // half-widths (x body radius)
  load: "panniers",                                      // "panniers" (blanket + two baskets) | "none"
  blanket: "#8e2a1e", blanketBand: "#c98a2e", blanketDark: "#211a16", blanketCream: "#e6d3a3",
  basket: "#b58d55", basketDark: "#83633b", rope: "#5e4630",
  ...DONKEY_PRESETS["Aurès grey"], color: "#8d8378", light: "#d9d1c4",
};
// DORCAS GAZELLE (Gazella dorcas — the Saharan edge of Algeria) from the pack's
// DEER (same rig as the donkey): smaller and finer, long thin legs, ringed
// LYRE horns, sandy fawn above a white belly with a dark band along the flank,
// dark cheek stripe, black tail tip.
export const PGZ = {
  legs: 1.08, neck: 1.1, body: 0.9, head: 0.88, ears: -0.3, size: 0.66, legSlim: 0.78, neckSlim: 0.72,
  muzzleNarrow: 0.72,  // the deer's broad muzzle narrowed in front of the eyes
  hump: 0, humpLen: 1,
  horn: 0.75,          // horn length (x head length)
  // pale sand (not the deer's red-brown), a strong dark band on the lower flank
  // (photos, Wikipedia: warm fawn, a rufous-brown flank band, white belly and
  // rump; the face: a WHITE stripe from above the eye to the nose, a DARK one
  // below it, white chin; long densely-ringed lyre horns)
  coat: "#cc9f68", pale: "#f3eee5", band: "#6b3f22", face: "#c99a63", forehead: "#a8683a", hornColor: "#2b231d", hornRing: "#6a5c50", nose: "#2a2320",
  color: "#cc9f68", dark: "#6b3f22", light: "#f3eee5",
};
// STRIPED HYENA (Hyaena hyaena — the one that lives in Algeria) from the pack's
// HUSKY: the same rig as the donkey (same bones, same clips), so the same
// morph pipeline — but real PAWS, a dog's head and a carnivore's gait.
export const PHY = {
  // legsBack: the hind legs shorter → the SLOPE (high shoulders, low hips)
  // (from photos of Hyaena hyaena: high shoulders, low narrow hindquarters,
  // HUGE upright ears, a thick erect mane on the neck and along the back, a
  // long bushy hanging tail, pale buff-grey with ~10 thin black stripes)
  legs: 1.15, legsBack: 0.7, neck: 0.95, body: 0.95, head: 0.9, ears: -1.0, size: 0.8, legSlim: 0.85, neckSlim: 1.3,
  muzzle: 0.12,        // a LONGER, pointed muzzle (in front of the eyes)
  headNarrow: 0.8,     // the head narrower across (the husky's is broad)
  tailDown: 0.9,       // the tail hangs (the husky's curls up over the back)
  tailFluff: 1.9,      // bushy: the tail's girth x this
  crest: 0.55,         // the mane: long hair along the neck and back (x the body radius)
  stripes: 10,         // thin black stripes across the flank (plane-sliced bands)
  stripeW: 0.3,        // a stripe's share of its period
  stripeJit: 0.35,     // each stripe a little different (spacing, width, lean)
  earWide: 1.3,        // broad ears (across their own axis)
  hump: 0, humpLen: 1,
  neckDown: 30,        // head carried low, at the shoulders
  // warm sandy-buff (the photos), near-black stripes
  coat: "#c8b28a", dark: "#1d1712", light: "#dccdae", color: "#c8b28a", face: "#b09c7c",
};
export const PG = {
  legs: 0.95, neck: 0.95, body: 0.78, size: 0.86, girth: 0.86, horn: 0.62, beard: 1.0,
  coat: "#4a3a31", hornColor: "#7a6d60",
};
// LOW-POLY = the pack's own look (donkey, bull, stag): coarse facets,
// flat shading, one colour per face. Smooth = the SDF at full res.
export const STYLE = { lowPoly: true, active: true };

// ── Hooks the lab fills (its preview material and shader uniforms) ──────────
export const hooks = { material: null, uCurl: { value: 1 }, uBump: { value: 0 } };
let defaultMat = null;
function defaultMaterial() {
  return (defaultMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }));
}

// ── The donkey this all starts from ──────────────────────────────────────────
let gltf = null, A = null;
// Other pack animals on the SAME rig (bone names, clips) that some kinds are
// reshaped from; the donkey stays the default. While such a kind builds, `gltf`
// and `A` point at its source (buildAnimal), so the whole pipeline follows.
const SOURCES = {};
const SOURCE_OF = { "hyena-morph": "husky", "gazelle-morph": "deer" };
// their colour zones under the donkey's zone names (the builder paints by them)
const MAT_MAP = {
  husky: { "Material": "Main", "Material.001": "Main_Light", "Material.006": "Muzzle", "Material.002": "Eye_Dark", "Material.003": "Eye_White" },
  deer: { "Eye_Black": "Eye_Dark", "Eye_Lighter": "Eye_Ring" },
};
// The read-only measurements printed while building (hoof flex, walk contact,
// walk smoothness): ~0.15 s a species. On for the labs; a game turns them off
// (setMorphDiagnostics(false)) — the built animal is the same either way.
let MORPH_DIAGNOSTICS = true;
export function setMorphDiagnostics(on) { MORPH_DIAGNOSTICS = !!on; }

/** Measure the donkey once; returns the analysis (`A`). `more`: { husky: gltf } */
export async function initAnimalMorph(donkeyGltf, more = {}) {
  await MeshoptSimplifier.ready;
  gltf = donkeyGltf;
  A = analyzeDonkey(gltf);
  SOURCES.donkey = { gltf, A };
  for (const [name, g] of Object.entries(more)) addMorphSource(name, g);
  return A;
}
/** Another pack animal on the donkey's rig (e.g. "husky") for the kinds built from it. */
export function addMorphSource(name, g) {
  SOURCES[name] = { gltf: g, A: analyzeDonkey(g, MAT_MAP[name]) };
  return SOURCES[name].A;
}

function analyzeDonkey(g, matMap = null) {
  const src = g.scene;
  src.updateMatrixWorld(true);
  const skinned = [];
  src.traverse((o) => o.isSkinnedMesh && skinned.push(o));
  const bones = skinned[0].skeleton.bones;
  const byName = Object.fromEntries(bones.map((b) => [b.name, b]));
  const W0 = (n) => byName[n].getWorldPosition(V());
  const owned = new Map();                 // bone name → rest world verts it dominates
  let ground0 = Infinity;
  const v = V();
  const mesh = { pos: [], nrm: [], skin: [], mat: [], idx: [] };
  for (const p of skinned) {
    const D = new THREE.Matrix4().multiplyMatrices(p.skeleton.bones[0].matrixWorld, p.skeleton.boneInverses[0]).multiply(p.bindMatrix);
    const Pa = p.geometry.attributes.position, SI = p.geometry.attributes.skinIndex, SW = p.geometry.attributes.skinWeight;
    const Na = p.geometry.attributes.normal, NM = new THREE.Matrix3().getNormalMatrix(D), nv = V();
    const base = mesh.pos.length / 3, gi = p.geometry.index;
    for (let i = 0; i < (gi ? gi.count : Pa.count); i++) mesh.idx.push(base + (gi ? gi.getX(i) : i));
    for (let i = 0; i < Pa.count; i++) {
      v.fromBufferAttribute(Pa, i).applyMatrix4(D);
      mesh.pos.push(v.x, v.y, v.z);
      nv.fromBufferAttribute(Na, i).applyMatrix3(NM).normalize();
      mesh.nrm.push(nv.x, nv.y, nv.z);
      mesh.mat.push(matMap?.[p.material.name] ?? p.material.name);
      const sk = [];
      for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > 0) sk.push([p.skeleton.bones[SI.getComponent(i, c)].name, w]); }
      mesh.skin.push(sk);
      ground0 = Math.min(ground0, v.y);
      let bw = -1, bj = 0;
      for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > bw) { bw = w; bj = SI.getComponent(i, c); } }
      const n = p.skeleton.bones[bj].name;
      if (!owned.has(n)) owned.set(n, []);
      owned.get(n).push(v.clone());
    }
  }
  const vs = (...names) => names.flatMap((n) => owned.get(n) ?? []);
  // Hoof tip in each lower-leg bone's own frame (bone +Y runs down the leg).
  const ext = {};
  for (const n of ["FrontLowerLegL", "FrontLowerLegR", "BackLowerLegL", "BackLowerLegR"]) {
    const inv = byName[n].matrixWorld.clone().invert();
    ext[n] = Math.max(...vs(n).map((q) => q.clone().applyMatrix4(inv).y));
  }
  // Muzzle: the Head vert farthest from the Head joint.
  const h0 = W0("Head");
  let tip = h0, far = 0;
  for (const q of vs("Head")) { const d = q.distanceTo(h0); if (d > far) { far = d; tip = q; } }
  const muzzleDir = tip.clone().sub(h0).normalize();
  const muzzleLocal = muzzleDir.clone().applyQuaternion(byName.Head.getWorldQuaternion(new THREE.Quaternion()).invert());
  // Barrel from the mid-torso verts.
  const fwd = W0("Neck1").sub(W0("Back")); fwd.y = 0; fwd.normalize();
  const right = V().crossVectors(fwd, UP).normalize();
  const mid = vs("Torso", "Torso2");
  const t2 = W0("Torso2");
  let minY = Infinity, maxY = -Infinity, side = 0;
  for (const q of mid) { minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); side = Math.max(side, Math.abs(q.clone().sub(t2).dot(right))); }
  return {
    ground0, ext, muzzleDir, muzzleLocal, Lh: far,
    Rv: (maxY - minY) / 2, Rside: side, cyOff: (minY + maxY) / 2 - t2.y,
    backTop: maxY, boneNames: bones.map((b) => b.name),
    mesh: { ...mesh, pos: new Float32Array(mesh.pos) },
    restInv: Object.fromEntries(bones.map((b) => [b.name, b.matrixWorld.clone().invert()])),
  };
}

// ── Geometry helpers ─────────────────────────────────────────────────────
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }

// Inigo Quilez's exact round cone.
function roundCone(a, b, r1, r2) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const ax = a.x, ay = a.y, az = a.z;
  return (px, py, pz) => {
    const pax = px - ax, pay = py - ay, paz = pz - az;
    const y = pax * bax + pay * bay + paz * baz, z = y - l2;
    const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
    const x2 = xx * xx + xy * xy + xz * xz, y2 = y * y * l2, z2 = z * z * l2;
    const k = Math.sign(rr) * rr * rr * x2;
    if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
    if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
    return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
  };
}
function sphere(c, r) { return (x, y, z) => Math.hypot(x - c.x, y - c.y, z - c.z) - r; }
// Oriented ellipsoid (iq's bound).
function ellipsoid(c, e1, e2, e3, r1, r2, r3) {
  return (x, y, z) => {
    const dx = x - c.x, dy = y - c.y, dz = z - c.z;
    const u = (dx * e1.x + dy * e1.y + dz * e1.z) / r1;
    const v = (dx * e2.x + dy * e2.y + dz * e2.z) / r2;
    const w = (dx * e3.x + dy * e3.y + dz * e3.z) / r3;
    const k0 = Math.hypot(u, v, w), k1 = Math.hypot(u / r1, v / r2, w / r3);
    return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(r1, r2, r3);
  };
}

function hash3(i, j, k) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return h >>> 0;
}
function worley(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const h = hash3(xi + dx, yi + dy, zi + dz);
    const fx = xi + dx + (h & 1023) / 1023 - x;
    const fy = yi + dy + ((h >>> 10) & 1023) / 1023 - y;
    const fz = zi + dz + ((h >>> 20) & 1023) / 1023 - z;
    const d = fx * fx + fy * fy + fz * fz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
const dome = (f) => Math.sqrt(Math.max(0, 1 - (f / 0.8) ** 2));

class Box {
  constructor() { this.min = V(Infinity, Infinity, Infinity); this.max = V(-Infinity, -Infinity, -Infinity); }
  add(p, r) { this.min.min(V(p.x - r, p.y - r, p.z - r)); this.max.max(V(p.x + r, p.y + r, p.z + r)); }
}

// Naive surface nets: one vertex per sign-changing cell, a quad per
// sign-changing edge. Then Newton-project every vertex onto the surface.
function surfaceNets(sdf, box, cell, margin) {
  const ox = box.min.x - margin, oy = box.min.y - margin, oz = box.min.z - margin;
  const nx = Math.ceil((box.max.x - box.min.x + 2 * margin) / cell) + 1;
  const ny = Math.ceil((box.max.y - box.min.y + 2 * margin) / cell) + 1;
  const nz = Math.ceil((box.max.z - box.min.z + 2 * margin) / cell) + 1;
  const F = new Float32Array(nx * ny * nz);
  let q = 0;
  for (let k = 0; k < nz; k++) { const z = oz + k * cell;
    for (let j = 0; j < ny; j++) { const y = oy + j * cell;
      for (let i = 0; i < nx; i++) F[q++] = sdf(ox + i * cell, y, z); } }
  const sy = nx, sz = nx * ny, cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cellV = new Int32Array(cx * cy * cz).fill(-1);
  const co = [0, 1, sy, 1 + sy, sz, sz + 1, sz + sy, sz + 1 + sy];
  const cxyz = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  const E = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
  const val = new Float32Array(8);
  const pos = [];
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const base = i + j * sy + k * sz;
    let neg = 0;
    for (let c = 0; c < 8; c++) { val[c] = F[base + co[c]]; if (val[c] < 0) neg++; }
    if (neg === 0 || neg === 8) continue;
    let px = 0, py = 0, pz = 0, n = 0;
    for (const [e0, e1] of E) {
      const a = val[e0], b = val[e1];
      if ((a < 0) !== (b < 0)) {
        const t = a / (a - b), c0 = cxyz[e0], c1 = cxyz[e1];
        px += c0[0] + (c1[0] - c0[0]) * t; py += c0[1] + (c1[1] - c0[1]) * t; pz += c0[2] + (c1[2] - c0[2]) * t; n++;
      }
    }
    cellV[i + j * cx + k * cx * cy] = pos.length / 3;
    pos.push(ox + (i + px / n) * cell, oy + (j + py / n) * cell, oz + (k + pz / n) * cell);
  }
  const C = (i, j, k) => cellV[i + j * cx + k * cx * cy];
  const idx = [];
  const quad = (a, b, c, d) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; idx.push(a, b, c, a, c, d); };
  for (let k = 1; k < cz; k++) for (let j = 1; j < cy; j++) for (let i = 1; i < cx; i++) {
    const g = i + j * sy + k * sz, v0 = F[g] < 0;
    if (v0 !== (F[g + 1] < 0)) quad(C(i, j - 1, k - 1), C(i, j, k - 1), C(i, j, k), C(i, j - 1, k));
    if (v0 !== (F[g + sy] < 0)) quad(C(i - 1, j, k - 1), C(i - 1, j, k), C(i, j, k), C(i, j, k - 1));
    if (v0 !== (F[g + sz] < 0)) quad(C(i - 1, j - 1, k), C(i, j - 1, k), C(i, j, k), C(i - 1, j, k));
  }
  // Project + gradient normals.
  const h = cell * 0.35;
  const nrm = new Float32Array(pos.length);
  const grad = (x, y, z) => {
    const gx = sdf(x + h, y, z) - sdf(x - h, y, z);
    const gy = sdf(x, y + h, z) - sdf(x, y - h, z);
    const gz = sdf(x, y, z + h) - sdf(x, y, z - h);
    const l = Math.hypot(gx, gy, gz) || 1;
    return [gx / l, gy / l, gz / l];
  };
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i], y = pos[i + 1], z = pos[i + 2];
    for (let it = 0; it < 2; it++) {
      const d = sdf(x, y, z), g = grad(x, y, z);
      const s = Math.max(-cell, Math.min(cell, d));
      x -= g[0] * s; y -= g[1] * s; z -= g[2] * s;
    }
    const g = grad(x, y, z);
    pos[i] = x; pos[i + 1] = y; pos[i + 2] = z;
    nrm[i] = g[0]; nrm[i + 1] = g[1]; nrm[i + 2] = g[2];
  }
  // Consistent winding now (outward, by the SDF normal) — the decimator
  // treats mismatched neighbours as borders and refuses to collapse.
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    if (gx * (nrm[a] + nrm[b] + nrm[c]) + gy * (nrm[a + 1] + nrm[b + 1] + nrm[c + 1]) + gz * (nrm[a + 2] + nrm[b + 2] + nrm[c + 2]) < 0) {
      const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s;
    }
  }
  return { pos, nrm, idx };
}

// LOW-POLY: collapse a surface-nets mesh to `targetTris` big faces with
// meshoptimizer (simplifyWithUpdate also slides the survivors to the
// best-fitting spot), then re-take normals from the SDF.
function decimate(m, targetTris, sdf, h) {
  if (m.idx.length / 3 <= targetTris) return m;
  const idx = new Uint32Array(m.idx), pos = new Float32Array(m.pos), nrm = new Float32Array(m.nrm);
  const [count] = MeshoptSimplifier.simplifyWithUpdate(idx, pos, 3, nrm, 3, [0.2, 0.2, 0.2], null, targetTris * 3, 1.0, []);
  const remap = new Map(), P = [], N = [], I = [];
  for (let i = 0; i < count; i++) {
    const v = idx[i];
    let r = remap.get(v);
    if (r === undefined) {
      r = P.length / 3; remap.set(v, r);
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
      const gx = sdf(x + h, y, z) - sdf(x - h, y, z), gy = sdf(x, y + h, z) - sdf(x, y - h, z), gz = sdf(x, y, z + h) - sdf(x, y, z - h);
      const l = Math.hypot(gx, gy, gz) || 1;
      P.push(x, y, z); N.push(gx / l, gy / l, gz / l);
    }
    I.push(r);
  }
  return { pos: P, nrm: N, idx: I };
}

// SDF ambient occlusion along the normal.
function sdfAO(sdf, x, y, z, nx, ny, nz, step) {
  let occ = 0, w = 1;
  for (let i = 1; i <= 5; i++) {
    const t = step * i;
    occ += (t - sdf(x + nx * t, y + ny * t, z + nz * t)) * w;
    w *= 0.6;
  }
  return Math.min(1, Math.max(0.35, 1 - 0.22 * occ / step));
}

// Nearest segment of a joint chain → that bone, blended with its
// neighbour within `bw` (fraction of the segment) of each joint.
const _ab = V(), _ap = V();
function chainWeights(p, J, bones, bw) {
  let best = Infinity, bi = 0, bt = 0;
  for (let i = 0; i < bones.length; i++) {
    _ab.subVectors(J[i + 1], J[i]); _ap.subVectors(p, J[i]);
    const t = Math.min(1, Math.max(0, _ap.dot(_ab) / _ab.lengthSq()));
    const d = _ap.addScaledVector(_ab, -t).lengthSq();
    if (d < best) { best = d; bi = i; bt = t; }
  }
  if (bt < bw && bi > 0) { const w = 0.5 * (1 - bt / bw); return [[bones[bi], 1 - w], [bones[bi - 1], w]]; }
  if (bt > 1 - bw && bi < bones.length - 1) { const w = 0.5 * (1 - (1 - bt) / bw); return [[bones[bi], 1 - w], [bones[bi + 1], w]]; }
  return [[bones[bi], 1]];
}
const segParam = (p, a, b) => { _ab.subVectors(b, a); return _ap.subVectors(p, a).dot(_ab) / _ab.lengthSq(); };

class GeoBuilder {
  constructor(boneIndex) { this.bi = boneIndex; this.pos = []; this.nrm = []; this.col = []; this.wool = []; this.rough = []; this.ao = []; this.fur = []; this.edge = []; this.si = []; this.sw = []; this.idx = []; }
  get count() { return this.pos.length / 3; }
  add(p, n, c, wool, rough, ao, weights, fur = 0, edge = null) {
    const acc = new Map();
    for (const [b, w] of weights) acc.set(b, (acc.get(b) ?? 0) + w);
    const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
    const sum = top.reduce((s, e) => s + e[1], 0) || 1;
    for (let i = 0; i < 4; i++) {
      this.si.push(top[i] ? this.bi[top[i][0]] : 0);
      this.sw.push(top[i] ? top[i][1] / sum : 0);
    }
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b); this.wool.push(wool); this.rough.push(rough); this.ao.push(ao); this.fur.push(fur);
    if (edge) this.edge.push(edge[0], edge[1], edge[2]); else this.edge.push(1, 1, 1);   // (1,1,1) = no wire
    return this.count - 1;
  }
  build() {
    // Wind every triangle to agree with its vertex normals.
    const P = this.pos, N = this.nrm, I = this.idx;
    if (!I.length) return null;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
      const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
      if (gx * nx + gy * ny + gz * nz < 0) { const s = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = s; }
    }
    if (STYLE.active) this.facet();
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("aCol", new THREE.Float32BufferAttribute(this.col, 3));
    // One vec4 (wool, rough, ao, fur): WebGPU caps a pipeline at 8 vertex buffers.
    const mat = new Float32Array(this.wool.length * 4);
    for (let i = 0; i < this.wool.length; i++) {
      mat[i * 4] = this.wool[i]; mat[i * 4 + 1] = this.rough[i]; mat[i * 4 + 2] = this.ao[i]; mat[i * 4 + 3] = this.fur[i];
    }
    g.setAttribute("aMat", new THREE.Float32BufferAttribute(mat, 4));
    // Per-corner barycentrics (+1 on a quad's hidden diagonal) for the wireframe.
    g.setAttribute("aEdge", new THREE.Float32BufferAttribute(this.edge, 3));
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
  // Split every triangle off and give it ONE colour and material (the
  // mean of its corners) — the flat colour zones of the pack's models.
  facet() {
    const I = this.idx, o = new GeoBuilder(this.bi);
    const keys = ["pos", "nrm", "col", "wool", "rough", "ao", "fur", "edge", "si", "sw"];
    const width = { pos: 3, nrm: 3, col: 3, wool: 1, rough: 1, ao: 1, fur: 1, edge: 3, si: 4, sw: 4 };
    for (let t = 0; t < I.length; t += 3) {
      const tri = [I[t], I[t + 1], I[t + 2]];
      for (const v of tri) for (const k of keys) for (let c = 0; c < width[k]; c++) o[k].push(this[k][v * width[k] + c]);
      const base = o.count - 3;
      for (const k of ["col", "wool", "rough", "ao", "fur"]) {
        const w = width[k];
        for (let c = 0; c < w; c++) {
          const m = (o[k][(base) * w + c] + o[k][(base + 1) * w + c] + o[k][(base + 2) * w + c]) / 3;
          for (let j = 0; j < 3; j++) o[k][(base + j) * w + c] = m;
        }
      }
      o.idx.push(base, base + 1, base + 2);
    }
    for (const k of [...keys, "idx"]) this[k] = o[k];
  }
  // A small faceted sphere, rigid on one bone (eyes).
  gem(c, r, col, bone, detail = 0, rough = 0.3) {
    const ico = new THREE.IcosahedronGeometry(r, detail);
    const pa = ico.attributes.position, base = this.count, q = V(), n = V();
    for (let i = 0; i < pa.count; i++) {
      q.fromBufferAttribute(pa, i); n.copy(q).normalize();
      this.add(q.add(c), n, col, 0, rough, 1, [[bone, 1]], 0);
    }
    for (let i = 0; i < pa.count; i++) this.idx.push(base + i);
  }
}

// Tube through rings {p, r, col, rough}; `weightsAt(p)` per ring.
function addTube(G, rings, radial, side, weightsAt, capEnd) {
  const base = G.count;
  const T = V(), Nn = V(), Bn = V(), dir = V(), q = V();
  for (let r = 0; r < rings.length; r++) {
    const a = rings[Math.max(0, r - 1)].p, b = rings[Math.min(rings.length - 1, r + 1)].p;
    T.subVectors(b, a).normalize();
    Nn.crossVectors(T, side); if (Nn.lengthSq() < 1e-6) Nn.set(1, 0, 0); Nn.normalize();
    Bn.crossVectors(T, Nn).normalize();
    const w = weightsAt(rings[r].p, r);
    for (let i = 0; i < radial; i++) {
      const ang = (i / radial) * Math.PI * 2;
      dir.copy(Nn).multiplyScalar(Math.cos(ang)).addScaledVector(Bn, Math.sin(ang));
      q.copy(rings[r].p).addScaledVector(dir, rings[r].r);
      G.add(q, dir, rings[r].col, 0, rings[r].rough, rings[r].ao ?? 1, w, rings[r].fur ?? 0);
    }
  }
  for (let r = 0; r < rings.length - 1; r++) for (let i = 0; i < radial; i++) {
    const a0 = base + r * radial + i, a1 = base + r * radial + (i + 1) % radial;
    G.idx.push(a0, a0 + radial, a1, a1, a0 + radial, a1 + radial);
  }
  if (capEnd) {
    const last = rings[rings.length - 1];
    const Tn = V().subVectors(last.p, rings[rings.length - 2].p).normalize();
    const c = G.add(last.p, Tn, last.col, 0, last.rough, 1, weightsAt(last.p, rings.length - 1), last.fur ?? 0);
    const s = base + (rings.length - 1) * radial;
    for (let i = 0; i < radial; i++) G.idx.push(s + i, c, s + (i + 1) % radial);
  }
}

// ── Build an animal template ─────────────────────────────────────────────
function buildAnimal() {
  const src = SOURCE_OF[SPECIES.value];
  if (!src) return buildAnimalFrom();                 // the donkey: unchanged path
  if (!SOURCES[src]) throw new Error(`animalMorph: ${SPECIES.value} is built from the ${src} — initAnimalMorph(donkey, { ${src}: gltf })`);
  const keep = [gltf, A];
  ({ gltf, A } = SOURCES[src]);
  try { return buildAnimalFrom(); } finally { [gltf, A] = keep; }
}
function buildAnimalFrom() {
  const t0 = performance.now();
  const isCamel = SPECIES.value.startsWith("camel"), isMorph = SPECIES.value === "camel-morph";
  const isSheepMorph = SPECIES.value === "sheep-morph", isGoatMorph = SPECIES.value === "goat-morph";
  const isPig2Morph = SPECIES.value === "pig2-morph";
  const isPigMorph = SPECIES.value === "pig-morph" || isPig2Morph;   // pig2 = the pig's code, its own params
  const isHyena = SPECIES.value === "hyena-morph", isDonkey = SPECIES.value === "donkey-morph", isGazelle = SPECIES.value === "gazelle-morph";
  const PQ = isPig2Morph ? PPIG2 : PPIG;
  const Q = isCamel ? PC : isGoatMorph ? PG : isPigMorph ? PQ : isHyena ? PHY : isDonkey ? PDK : isGazelle ? PGZ : P;
  const legF = (n) => (Q.legsBack && /^(Back|IKBack|FFB)/.test(n) ? Q.legsBack : Q.legs);
  const LEGS = Q.legsBack ? legF : Q.legs;           // feetFollow: one length, or per leg
  const root = cloneSkinned(gltf.scene);
  const kill = [];
  root.traverse((o) => { if (o.isMesh) kill.push(o); });
  kill.forEach((o) => o.removeFromParent());
  const B = {};
  root.traverse((o) => { if (o.isBone) B[o.name] = o; });

  // 1. Proportions: scale child-bone rest offsets.
  const F = {};
  for (const s of ["L", "R"]) {
    F["FrontLowerLeg" + s] = Q.legs;            // = upper front leg length
    F["BackUpperLeg" + s] = legF("BackUpperLeg");   // = thigh length
    F["BackLowerLeg" + s] = legF("BackLowerLeg");   // = shank length
    F["Ear2" + s] = F["Ear3" + s] = F["Ear4" + s] = 0.5;
  }
  F.Neck2 = F.Neck3 = F.Head = Q.neck;
  F.Torso = F.Torso2 = F.Torso3 = Q.body;       // the donkey is long in the back
  // A very short sheep tail. Not Tail2 (= Tail1's length): Tail1 also carries the
  // RUMP (measured: 350 verts), and shrinking it squashed the rump.
  if (isSheepMorph || isGoatMorph) for (let i = 3; i <= 7; i++) F["Tail" + i] = 0.1;
  if (isPigMorph) for (let i = 2; i <= 7; i++) F["Tail" + i] = 0.3;          // a pig's thin short tail
  for (const [n, f] of Object.entries(F)) B[n].position.multiplyScalar(f);
  root.updateMatrixWorld(true);

  const FEET = ["FrontLowerLegL", "FrontLowerLegR", "BackLowerLegL", "BackLowerLegR"];
  const tipLocal = (n) => V(0, A.ext[n] * legF(n), 0);
  const tipOf = (n) => B[n].localToWorld(tipLocal(n));

  // 1b. THE SLOPE (hyena): with the hind legs shorter the back feet hang in
  // the air. Pitch the whole spine (Body) about the side axis until the front
  // and back feet stand on one ground, and turn each leg's root back by the
  // same angle so the legs stay upright. Rest AND every clip key (RD, like the
  // camel's neck); solved, not guessed.
  const RDtilt = {};
  if (Q.legsBack && Q.legsBack !== Q.legs) {
    const fwd0 = B.Neck1.getWorldPosition(V()).sub(B.Back.getWorldPosition(V())).setY(0).normalize();
    const right0 = V().crossVectors(fwd0, UP).normalize();
    const roots = ["FrontShoulderL", "FrontShoulderR", "BackShoulderL", "BackShoulderR"].filter((n) => B[n]);
    const q0 = new Map([B.Body, ...roots.map((n) => B[n])].map((b) => [b, b.quaternion.clone()]));
    const turnW = (bone, ang) => {
      const Qb = bone.getWorldQuaternion(new THREE.Quaternion());
      const d = Qb.clone().invert().multiply(new THREE.Quaternion().setFromAxisAngle(right0, ang)).multiply(Qb);
      bone.quaternion.multiply(d); root.updateMatrixWorld(true);
      return d;
    };
    const tilt = (ang) => {
      for (const [b, q] of q0) b.quaternion.copy(q);
      root.updateMatrixWorld(true);
      const out = { Body: turnW(B.Body, ang) };
      for (const n of roots) out[n] = turnW(B[n], -ang);
      const f = (tipOf("FrontLowerLegL").y + tipOf("FrontLowerLegR").y) / 2, b = (tipOf("BackLowerLegL").y + tipOf("BackLowerLegR").y) / 2;
      return { gap: b - f, out };
    };
    let a0 = 0, g0 = tilt(0).gap, a1 = 0.05, g1 = tilt(a1).gap;
    for (let it = 0; it < 12 && Math.abs(g1) > 1e-6 && g1 !== g0; it++) { const a2 = a1 - (g1 * (a1 - a0)) / (g1 - g0); a0 = a1; g0 = g1; a1 = a2; g1 = tilt(a1).gap; }
    Object.assign(RDtilt, tilt(a1).out);
    console.log(`[slope] spine pitched ${THREE.MathUtils.radToDeg(a1).toFixed(1)} deg, feet gap ${(g1 / A.Rv).toExponential(1)} Rv`);
  }

  // 2. Drop the body by what the legs lost.
  const delta = Math.min(...FEET.map((n) => tipOf(n).y)) - A.ground0;
  const bodyRest = B.Body.position.clone();
  const bw = B.Body.getWorldPosition(V());
  const la = B.Body.parent.worldToLocal(bw.clone());
  const lb = B.Body.parent.worldToLocal(bw.clone().add(V(0, -delta, 0)));
  const dLocal = lb.sub(la);
  B.Body.position.add(dLocal);
  root.updateMatrixWorld(true);

  // 2b. Camel: bend the straight donkey neck into an S and level the
  // head. A fixed bone-local rotation d per bone, right-multiplied onto
  // the rest AND onto every key of that bone's rotation track, so the
  // donkey's motion plays on top of the new shape.
  const RD = { ...RDtilt };
  if (isCamel) {
    const fwd0 = B.Neck1.getWorldPosition(V()).sub(B.Back.getWorldPosition(V())).setY(0).normalize();
    const tq = new THREE.Quaternion();
    const headY = () => { root.updateMatrixWorld(true); return B.Head.getWorldPosition(V()).y; };
    const muzzle = () => { root.updateMatrixWorld(true); return A.muzzleLocal.clone().applyQuaternion(B.Head.getWorldQuaternion(new THREE.Quaternion())); };
    const bestAxis = (bone, measure) => {
      const q0 = bone.quaternion.clone(), m0 = measure();
      let best = null;
      for (const ax of [V(1, 0, 0), V(0, 1, 0), V(0, 0, 1)]) {
        bone.quaternion.copy(q0).multiply(tq.setFromAxisAngle(ax, 0.05));
        const g = (measure() - m0) / 0.05;
        if (!best || Math.abs(g) > Math.abs(best.g)) best = { ax, g };
      }
      bone.quaternion.copy(q0);
      return best;
    };
    const bend = (name, deg) => {
      const bone = B[name], { ax, g } = bestAxis(bone, headY);
      const d = new THREE.Quaternion().setFromAxisAngle(ax, THREE.MathUtils.degToRad(deg) * Math.sign(g));
      bone.quaternion.multiply(d);
      RD[name] = d;
    };
    // the dip is shared by Neck1 and Neck2 (all on Neck1 folded the chest)
    bend("Neck1", -Q.neckDip * (window.__dipSplit ?? 0.6));
    bend("Neck2", -Q.neckDip * (1 - (window.__dipSplit ?? 0.6)) + Q.neckRise * 0.35);
    bend("Neck3", Q.neckRise * 0.65);
    // Head: scan for the pitch that puts the muzzle at headPitch, still pointing forward.
    const hb = B.Head, q0 = hb.quaternion.clone();
    const { ax } = bestAxis(hb, () => muzzle().y);
    const target = Math.sin(THREE.MathUtils.degToRad(Q.headPitch));
    let bestA = 0, bestE = Infinity;
    for (let an = -1.6; an <= 1.6; an += 0.01) {
      hb.quaternion.copy(q0).multiply(tq.setFromAxisAngle(ax, an));
      const m = muzzle();
      if (m.dot(fwd0) <= 0) continue;
      const e = Math.abs(m.y - target);
      if (e < bestE) { bestE = e; bestA = an; }
    }
    RD.Head = new THREE.Quaternion().setFromAxisAngle(ax, bestA);
    hb.quaternion.copy(q0).multiply(RD.Head);
    root.updateMatrixWorld(true);
  }
  if (isPigMorph || (isHyena && Q.neckDown)) {
    // (the hyena too: it carries its head at shoulder level, the neck reaching
    // forward — the husky holds it high like a wolf)
    // A pig carries its head LOW, nearly without a neck: bend Neck1 down about
    // the body's side axis (the sign that lowers the head), rest AND keys.
    const fwd0 = B.Neck1.getWorldPosition(V()).sub(B.Back.getWorldPosition(V())).setY(0).normalize();
    const right0 = V().crossVectors(fwd0, UP).normalize();
    const n1 = B.Neck1, q0 = n1.quaternion.clone();
    const headY = (ang) => {
      const Rw = new THREE.Quaternion().setFromAxisAngle(right0, ang);
      const Qb = n1.getWorldQuaternion(new THREE.Quaternion());
      n1.quaternion.copy(q0).multiply(Qb.clone().invert().multiply(Rw).multiply(Qb));
      root.updateMatrixWorld(true);
      const y = B.Head.getWorldPosition(V()).y;
      n1.quaternion.copy(q0); root.updateMatrixWorld(true);
      return y;
    };
    const ang = THREE.MathUtils.degToRad(isPigMorph ? PQ.neckDown : Q.neckDown) * (headY(0.2) < headY(-0.2) ? 1 : -1);
    const Rw = new THREE.Quaternion().setFromAxisAngle(right0, ang);
    const Qb = n1.getWorldQuaternion(new THREE.Quaternion());
    RD.Neck1 = Qb.clone().invert().multiply(Rw).multiply(Qb);
    n1.quaternion.multiply(RD.Neck1);
    root.updateMatrixWorld(true);
  }
  if (isGoatMorph || isPigMorph) {
    // The goat's ears hang far DOWN; the pig's point FORWARD. Turn the Ear1 BONE, so the
    // rig's own weights do the bending — bending the geometry folded the
    // ear roots inside-out (measured: 5 → 15 flipped faces).
    const fwd0 = B.Neck1.getWorldPosition(V()).sub(B.Back.getWorldPosition(V())).setY(0).normalize();
    const right0 = V().crossVectors(fwd0, UP).normalize();
    const hw = B.Head.getWorldPosition(V());
    for (const sd of ["L", "R"]) {
      const e1 = B["Ear1" + sd];
      const p1 = e1.getWorldPosition(V()), p4 = B["Ear4" + sd].getWorldPosition(V());
      const axis0 = p4.sub(p1).normalize();
      const out = Math.sign(p1.clone().sub(hw).dot(right0)) || 1;
      const target = isGoatMorph
        ? right0.clone().multiplyScalar(out * 0.5).addScaledVector(UP, -0.85).addScaledVector(fwd0, 0.18).normalize()
        : isPigMorph
          ? right0.clone().multiplyScalar(out * PQ.earOut).addScaledVector(UP, PQ.earUp).addScaledVector(fwd0, PQ.earFwd).normalize()
          : right0.clone().multiplyScalar(out).addScaledVector(UP, -0.3).addScaledVector(fwd0, 0.15).normalize();
      const Rw = new THREE.Quaternion().setFromUnitVectors(axis0, target);
      const Qb = e1.getWorldQuaternion(new THREE.Quaternion());
      const d = Qb.clone().invert().multiply(Rw).multiply(Qb);          // world turn → bone-local
      e1.quaternion.multiply(d);
      RD["Ear1" + sd] = d;
    }
    root.updateMatrixWorld(true);
  }

  if (isHyena && Q.tailDown && B.Tail1) {
    // A hyena's bushy tail HANGS; the husky's curls up over its back. Turn the
    // Tail1 bone so the tail points down and back (rest AND every key: the
    // swish still plays round the new rest).
    const fwd0 = B.Neck1.getWorldPosition(V()).sub(B.Back.getWorldPosition(V())).setY(0).normalize();
    let end = "Tail1"; for (let i = 2; B["Tail" + i]; i++) end = "Tail" + i;
    // Tail2, not Tail1: Tail1 also carries the rump (turning it folded 2 faces)
    const t1 = B.Tail2 ?? B.Tail1, axis0 = B[end].getWorldPosition(V()).sub(t1.getWorldPosition(V())).normalize();
    const target = UP.clone().multiplyScalar(-Q.tailDown).addScaledVector(fwd0, -(1 - Q.tailDown * 0.6)).normalize();
    const Rw = new THREE.Quaternion().setFromUnitVectors(axis0, target);
    const Qb = t1.getWorldQuaternion(new THREE.Quaternion());
    RD[t1.name] = Qb.clone().invert().multiply(Rw).multiply(Qb);
    t1.quaternion.multiply(RD[t1.name]);
    root.updateMatrixWorld(true);
  }

  // Foot bones follow the NEW legs. The donkey's hooves are skinned to its
  // IK foot bones (IKFrontLegL + FFL …), which carry the hoof FLEX but sit
  // at donkey-leg positions. Put each at the same spot relative to its
  // lower-leg bone as on the donkey (the tip moved by the leg change); the
  // hooves then keep their own weights — attached AND flexing.
  const FOOTPAIRS = [["FrontLowerLegL", "IKFrontLegL"], ["FrontLowerLegR", "IKFrontLegR"], ["BackLowerLegL", "IKBackLegL"], ["BackLowerLegR", "IKBackLegR"]];
  {
    const src = gltf.scene; src.updateMatrixWorld(true);
    const SB = {}; src.traverse((o) => { if (o.isBone) SB[o.name] = o; });
    for (const [leg, ik] of FOOTPAIRS) {
      const dl = SB[leg].worldToLocal(SB[ik].getWorldPosition(V()));
      dl.y += (legF(leg) - 1) * A.ext[leg];
      const w = B[leg].localToWorld(dl);
      B[ik].position.copy(B[ik].parent.worldToLocal(w));
    }
    root.updateMatrixWorld(true);
  }
  // Clips: same rotations; scaled translations; Body bob scaled with the legs.
  const clips = gltf.animations.map((c) => {
    const cc = c.clone();
    for (const tr of cc.tracks) {
      const dot = tr.name.lastIndexOf(".");
      const node = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
      if (prop === "quaternion" && (isSheepMorph || isGoatMorph || isPigMorph) && node.startsWith("Ear")) {
        // The sheep's ears are turned out sideways in its rest; the
        // donkey's big ear swings (laid back, pricked up) would stand them
        // up. Keep a quarter of the motion — a flick — around the rest.
        const rest = B[node].quaternion, vals = tr.values.slice(), q = new THREE.Quaternion(), key = new THREE.Quaternion();
        for (let i = 0; i < vals.length; i += 4) {
          key.fromArray(vals, i);
          if (RD[node]) key.multiply(RD[node]);                          // the rest turn rides on every key
          q.copy(rest).slerp(key, 0.25).toArray(vals, i);
        }
        tr.values = vals;
        continue;
      }
      if (prop === "quaternion" && RD[node]) {
        const vals = tr.values.slice(), q = new THREE.Quaternion();
        for (let i = 0; i < vals.length; i += 4) {
          q.fromArray(vals, i).multiply(RD[node]).normalize().toArray(vals, i);
        }
        tr.values = vals;
        continue;
      }
      if (prop !== "position") continue;
      const vals = tr.values.slice();
      if (F[node]) for (let i = 0; i < vals.length; i++) vals[i] *= F[node];
      else if (node === "Body") {
        for (let i = 0; i < vals.length; i += 3) {
          vals[i]     = bodyRest.x + dLocal.x + (vals[i]     - bodyRest.x) * Q.legs;
          vals[i + 1] = bodyRest.y + dLocal.y + (vals[i + 1] - bodyRest.y) * Q.legs;
          vals[i + 2] = bodyRest.z + dLocal.z + (vals[i + 2] - bodyRest.z) * Q.legs;
        }
      } else continue;
      tr.values = vals;
    }
    return cc;
  });

  // 3. Geometry in the new rest pose.
  const W = (n) => B[n].getWorldPosition(V());
  const fwd = W("Neck1").sub(W("Back")); fwd.y = 0; fwd.normalize();
  const right = V().crossVectors(fwd, UP).normalize();
  const boneIndex = Object.fromEntries(A.boneNames.map((n, i) => [n, i]));
  const G = new GeoBuilder(boneIndex);
  let topY = -Infinity, curlR = 1;
  const headFrame = (Lh) => {
    const H = W("Head");
    const a = A.muzzleLocal.clone().applyQuaternion(B.Head.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const hu = UP.clone().addScaledVector(a, -UP.dot(a)).normalize();
    const hs = V().crossVectors(hu, a).normalize();
    const Hp = (x, y, z) => H.clone().addScaledVector(hs, x * Lh).addScaledVector(hu, y * Lh).addScaledVector(a, z * Lh);
    return { H, a, hu, hs, Hp };
  };
  if (!isCamel && !isSheepMorph && !isGoatMorph && !isPigMorph && !isHyena && !isDonkey && !isGazelle) {
  const woolC = new THREE.Color(P.woolColor), faceC = new THREE.Color(P.faceColor), legC = new THREE.Color(P.legColor);
  const dirtC = woolC.clone().multiply(new THREE.Color(0.72, 0.64, 0.5));
  const hoofC = new THREE.Color("#161310"), eyeC = new THREE.Color("#0c0907"), hornC = new THREE.Color("#c9b894");

  // ── Wool body ──
  const R = A.Rv * P.wool;
  const off = V(0, A.cyOff, 0);
  const Lb = W("Torso3").sub(W("Back")).setY(0).length();
  const c0 = W("Back").add(off).addScaledVector(fwd, -0.06 * Lb);
  const c1 = W("Torso").add(off), c2 = W("Torso2").add(off);
  const c3 = W("Torso3").add(off).addScaledVector(fwd, 0.04 * Lb);
  const c4 = W("Torso3").add(off).addScaledVector(fwd, 0.14 * Lb).addScaledVector(UP, -0.08 * R);
  const bJ = [c0, c1, c2, c3, c4], bR = [0.9, 1.0, 1.04, 0.97, 0.74].map((r) => r * R);
  const bBones = ["Back", "Torso", "Torso2", "Torso3"];
  const nJ = [c3.clone().lerp(W("Neck1"), 0.5), W("Neck1"), W("Neck2"), W("Neck3"), W("Neck3").lerp(W("Head"), 0.45)];
  const nR = [0.74, 0.6, 0.48, 0.38, 0.3].map((r) => r * R);
  const nBones = ["Torso3", "Neck1", "Neck2", "Neck3"];
  const prims = [];            // { d, k, weights(p) }
  const box = new Box();
  const chainPrims = (J, Rr, bones, k) => {
    for (let i = 0; i < J.length - 1; i++) {
      prims.push({ d: roundCone(J[i], J[i + 1], Rr[i], Rr[i + 1]), k, weights: (p) => chainWeights(p, J, bones, 0.5) });
      box.add(J[i], Rr[i]); box.add(J[i + 1], Rr[i + 1]);
    }
  };
  chainPrims(bJ, bR, bBones, 0.35 * R);
  chainPrims(nJ, nR, nBones, 0.3 * R);
  for (const s of ["L", "R"]) {
    const ta = W("BackLeg" + s), tb = W("BackLeg" + s).lerp(W("BackUpperLeg" + s), 0.85);
    prims.push({ d: roundCone(ta, tb, 0.46 * R, 0.3 * R), k: 0.3 * R,
      weights: (p) => { const t = smoothstep01(-0.2, 0.8, segParam(p, ta, tb)); return [["Back", 1 - t], ["BackLeg" + s, t]]; } });
    box.add(ta, 0.46 * R); box.add(tb, 0.3 * R);
    const fa = W("FrontUpperLeg" + s), fb = W("FrontUpperLeg" + s).lerp(W("FrontLowerLeg" + s), 0.5);
    prims.push({ d: roundCone(fa, fb, 0.36 * R, 0.24 * R), k: 0.3 * R,
      weights: (p) => { const t = smoothstep01(-0.2, 0.8, segParam(p, fa, fb)); return [["Torso3", 1 - t], ["FrontUpperLeg" + s, t]]; } });
    box.add(fa, 0.36 * R); box.add(fb, 0.24 * R);
  }
  // Tail stub on the rump, on whichever tail bone sits nearest its root.
  const tBase = c0.clone().addScaledVector(fwd, -0.72 * R).addScaledVector(UP, 0.28 * R);
  const tEnd = tBase.clone().addScaledVector(fwd, -0.22 * R).addScaledVector(UP, -0.42 * R);
  let tailBone = "Tail1", tbd = Infinity;
  for (let i = 1; i <= 7; i++) { const d = W("Tail" + i).distanceTo(tBase); if (d < tbd) { tbd = d; tailBone = "Tail" + i; } }
  prims.push({ d: roundCone(tBase, tEnd, 0.2 * R, 0.13 * R), k: 0.12 * R,
    weights: (p) => { const t = smoothstep01(0, 0.4, segParam(p, tBase, tEnd)); return [["Back", 1 - t], [tailBone, t]]; } });
  box.add(tBase, 0.2 * R); box.add(tEnd, 0.2 * R);

  const L1 = 1 / (0.5 * R), L2 = 1 / (0.22 * R), A1 = 0.1 * R * P.lumps, A2 = 0.035 * R * P.lumps;
  const baseBody = (x, y, z) => { let d = 1e9; for (const pr of prims) d = smin(d, pr.d(x, y, z), pr.k); return d; };
  const bodySDF = (x, y, z) => {
    const d = baseBody(x, y, z);
    if (d > 0.45 * R || d < -0.45 * R) return d;
    return d - A1 * dome(worley(x * L1 + 0.31, y * L1 + 0.17, z * L1)) - A2 * dome(worley(x * L2 + 7.1, y * L2 + 3.3, z * L2 + 1.9));
  };
  const bodyMesh = surfaceNets(bodySDF, box, R / 16, 0.3 * R);
  for (let i = 1; i < bodyMesh.pos.length; i += 3) topY = Math.max(topY, bodyMesh.pos[i]);
  curlR = R;
  const bodyBottom = c2.y - R;
  {
    const base = G.count, p = V(), n = V(), c = new THREE.Color();
    const sig = 0.14 * R, pd = new Float64Array(prims.length);
    for (let i = 0; i < bodyMesh.pos.length; i += 3) {
      p.fromArray(bodyMesh.pos, i); n.fromArray(bodyMesh.nrm, i);
      let dmin = Infinity;
      for (let k = 0; k < prims.length; k++) { pd[k] = prims[k].d(p.x, p.y, p.z); dmin = Math.min(dmin, pd[k]); }
      const ws = [];
      for (let k = 0; k < prims.length; k++) {
        const s = Math.exp(-(pd[k] - dmin) / sig);
        if (s < 0.02) continue;
        for (const [b, w] of prims[k].weights(p)) ws.push([b, w * s]);
      }
      const belly = smoothstep01(bodyBottom - 0.1 * R, bodyBottom + 0.9 * R, p.y);
      c.copy(dirtC).lerp(woolC, belly);
      const ao = sdfAO(bodySDF, p.x, p.y, p.z, n.x, n.y, n.z, 0.07 * R);
      G.add(p, n, c, 1, 0.95, ao, ws);
    }
    for (const i of bodyMesh.idx) G.idx.push(base + i);
  }

  // ── Head ──
  const Lh = A.Lh * P.head;
  const { H, a, hu, hs, Hp } = headFrame(Lh);
  const hprims = [];             // { d, k, tag, bones }
  const hbox = new Box();
  const addH = (d, k, tag, bones, bc, br) => { hprims.push({ d, k, tag, bones }); hbox.add(bc, br); };
  const skullC = Hp(0, 0.02, 0.27);
  addH(ellipsoid(skullC, hs, hu, a, 0.23 * Lh, 0.26 * Lh, 0.31 * Lh), 0.12 * Lh, "skin", null, skullC, 0.33 * Lh);
  const m0 = Hp(0, 0.0, 0.42), m1 = Hp(0, -0.08, 0.8);
  addH(roundCone(m0, m1, 0.2 * Lh, 0.15 * Lh), 0.12 * Lh, "skin", null, m1, 0.22 * Lh);
  const jawC = Hp(0, -0.12, 0.47);
  addH(ellipsoid(jawC, hs, hu, a, 0.17 * Lh, 0.13 * Lh, 0.28 * Lh), 0.1 * Lh, "skin", null, jawC, 0.3 * Lh);
  if (P.headWool > 0.05) {
    const pc = Hp(0, 0.2, 0.1);
    addH(sphere(pc, 0.2 * Lh * P.headWool), 0.06 * Lh, "wool", null, pc, 0.22 * Lh);
  }
  for (const sx of [-1, 1]) {
    // Eye on the skull surface.
    const d = V(0.78 * sx, 0.3, 0.55);
    const e = 1 / Math.hypot(d.x / 0.21, d.y / 0.25, d.z / 0.3);
    const eyeLocal = V(d.x * e, 0.02 + d.y * e, 0.27 + d.z * e);
    const ec = Hp(eyeLocal.x * 0.99, eyeLocal.y, eyeLocal.z);
    addH(sphere(ec, 0.042 * Lh), 0.008 * Lh, "eye", null, ec, 0.05 * Lh);
    // Ear: a flat leaf pointing out sideways, drooping.
    const s = sx < 0 ? "L" : "R";
    const earSide = (W("Ear1" + s).sub(H).dot(hs) < 0) === (sx < 0) ? s : (s === "L" ? "R" : "L");
    const eb = Hp(0.2 * sx, 0.12, 0.18);
    const e1 = hs.clone().multiplyScalar(sx).addScaledVector(hu, 0.15 - 0.6 * P.earDroop).addScaledVector(a, 0.02).normalize();
    const len = 0.44 * Lh * P.earSize;
    const e2 = V().crossVectors(e1, hu).normalize(), e3 = V().crossVectors(e1, e2).normalize();
    const ecn = eb.clone().addScaledVector(e1, len * 0.5);
    addH(ellipsoid(ecn, e1, e2, e3, len * 0.5, 0.11 * Lh * P.earSize, 0.03 * Lh), 0.04 * Lh, "ear", { bone: "Ear1" + earSide, base: eb, dir: e1, len }, ecn, len * 0.6);
  }
  const headSDF = (x, y, z) => { let d = 1e9; for (const pr of hprims) d = smin(d, pr.d(x, y, z), pr.k); return d; };
  const headMesh = surfaceNets(headSDF, hbox, Lh / 56, 0.08 * Lh);
  {
    const base = G.count, p = V(), n = V(), c = new THREE.Color(), rel = V();
    for (let i = 0; i < headMesh.pos.length; i += 3) {
      p.fromArray(headMesh.pos, i); n.fromArray(headMesh.nrm, i);
      let best = null, bd = Infinity;
      for (const pr of hprims) { const d = pr.d(p.x, p.y, p.z); if (d < bd) { bd = d; best = pr; } }
      rel.subVectors(p, H);
      const lz = rel.dot(a) / Lh, ly = rel.dot(hu) / Lh;
      let wool = 0, rough = 0.7, ws = [["Head", 1]];
      if (best.tag === "wool") { c.copy(woolC); wool = 1; rough = 0.95; }
      else if (best.tag === "eye") { c.copy(eyeC); rough = 0.12; }
      else {
        c.copy(faceC);
        if (lz > 0.84) c.multiplyScalar(0.55);                                  // nose
        if (lz > 0.62 && Math.abs(ly + 0.16) < 0.018) c.multiplyScalar(0.45);  // mouth line
        if (best.tag === "ear") {
          const t = segParam(p, best.bones.base, best.bones.base.clone().addScaledVector(best.bones.dir, best.bones.len));
          const ew = smoothstep01(0.02, 0.25, t);
          ws = [["Head", 1 - ew], [best.bones.bone, ew]];
        }
      }
      const ao = sdfAO(headSDF, p.x, p.y, p.z, n.x, n.y, n.z, 0.03 * Lh);
      G.add(p, n, c, wool, rough, ao, ws);
    }
    for (const i of headMesh.idx) G.idx.push(base + i);
  }

  // ── Legs ──
  const R0 = A.Rv * P.legThick;
  const legRings = (J, prof, bones) => {
    // prof: [segmentIndex, t, radius, colour, rough]
    const rings = [];
    const P0 = (si, t) => J[si].clone().lerp(J[si + 1], t);
    for (let k = 0; k < prof.length - 1; k++) {
      const [sa, ta, ra, ca, ga] = prof[k], [sb, tb, rb] = prof[k + 1];
      const pa = P0(sa, ta), pb = P0(sb, tb);
      const steps = Math.max(1, Math.round(pa.distanceTo(pb) / (0.05 * R0 * 6)));
      for (let s = 0; s < steps; s++) { const u = s / steps; rings.push({ p: pa.clone().lerp(pb, u), r: ra + (rb - ra) * u, col: ca, rough: ga }); }
    }
    const lp = prof[prof.length - 1];
    rings.push({ p: P0(lp[0], lp[1]), r: lp[2], col: lp[3], rough: lp[4] });
    addTube(G, rings, 12, fwd, (p) => chainWeights(p, J, bones, 0.12), true);
  };
  for (const s of ["L", "R"]) {
    const Jf = [W("FrontUpperLeg" + s), W("FrontLowerLeg" + s), tipOf("FrontLowerLeg" + s)];
    legRings(Jf, [
      [0, 0.22, 0.13 * R0, woolC, 0.9], [0, 0.45, 0.13 * R0, legC, 0.8], [0, 1, 0.105 * R0, legC, 0.8],
      [1, 0.25, 0.075 * R0, legC, 0.8], [1, 0.76, 0.07 * R0, legC, 0.8], [1, 0.84, 0.085 * R0, legC, 0.8],
      [1, 0.9, 0.08 * R0, hoofC, 0.45], [1, 1, 0.095 * R0, hoofC, 0.45],
    ], ["FrontUpperLeg" + s, "FrontLowerLeg" + s]);
    const Jb = [W("BackLeg" + s), W("BackUpperLeg" + s), W("BackLowerLeg" + s), tipOf("BackLowerLeg" + s)];
    legRings(Jb, [
      [0, 0.45, 0.17 * R0, woolC, 0.9], [0, 0.9, 0.14 * R0, legC, 0.8], [1, 0.1, 0.12 * R0, legC, 0.8],
      [1, 0.9, 0.085 * R0, legC, 0.8], [2, 0.05, 0.1 * R0, legC, 0.8],
      [2, 0.25, 0.075 * R0, legC, 0.8], [2, 0.76, 0.07 * R0, legC, 0.8], [2, 0.84, 0.085 * R0, legC, 0.8],
      [2, 0.9, 0.08 * R0, hoofC, 0.45], [2, 1, 0.095 * R0, hoofC, 0.45],
    ], ["BackLeg" + s, "BackUpperLeg" + s, "BackLowerLeg" + s]);
  }

  // ── Horns: a ram's curl round each ear ──
  if (P.horns) {
    for (const sx of [-1, 1]) {
      const rings = [], N = 44;
      const c = new THREE.Color();
      for (let i = 0; i <= N; i++) {
        const u = i / N, th = u * Math.PI * 1.75, r = 0.34 * (1 - 0.55 * u);
        const loc = V(sx * (0.12 + 0.3 * u), 0.2 + r * Math.sin(th), 0.18 - r * (1 - Math.cos(th)) + 0.1 * u);
        const stripe = 0.82 + 0.18 * Math.abs(Math.sin(u * 70));
        c.copy(hornC).multiplyScalar(stripe * (0.75 + 0.25 * u));
        rings.push({ p: Hp(loc.x, loc.y, loc.z), r: (0.11 - 0.085 * u) * Lh, col: c.clone(), rough: 0.55 });
      }
      addTube(G, rings, 10, hs, () => [["Head", 1]], true);
    }
  }
  } else {
    ({ topY, curlR } = isMorph || isSheepMorph || isGoatMorph || isPigMorph || isHyena || isDonkey || isGazelle
      ? buildCamelMorph({ B, W, fwd, right, G, tipOf, F }, isSheepMorph ? "sheep" : isGoatMorph ? "goat" : isPig2Morph ? "pig2" : isPigMorph ? "pig" : isHyena ? "hyena" : isDonkey ? "donkey" : isGazelle ? "gazelle" : "camel")
      : buildCamelParts({ B, W, fwd, right, G, tipOf, headFrame }));
  }

  const geo = G.build();
  const mesh = new THREE.SkinnedMesh(geo, hooks.material ?? defaultMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  root.add(mesh);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(A.boneNames.map((n) => B[n]));
  mesh.bind(skeleton);

  // Real-world size: the top of the body (wool / hump) at Q.size metres.
  const scale = Q.size / (topY - A.ground0);
  root.scale.setScalar(scale);
  root.position.y = -A.ground0 * scale;
  root.updateMatrixWorld(true);

  hooks.uCurl.value = 1 / (0.11 * curlR) * P.curl;
  hooks.uBump.value = 0.004 * P.bump;

  const tpl = { root, mesh, clips, scale, fwd, curlR, isCamel, height0: Q.size, k: Q.size / 0.85, yaw0: Math.atan2(fwd.x, fwd.z), tris: geo.index.count / 3, feet: FEET.map((n) => ({ bone: n, local: tipLocal(n) })) };
  if (isCamel && !window.__noPace) tpl.pace = paceWalk(tpl);
  tpl.feetFollow = feetFollow(tpl, LEGS);
  if (isPigMorph || isMorph || isHyena) {
    // Front and back HOOVES must reach the same lowest point over the walk:
    // the ground clamp lifts the body by the deepest one, so a pair that sits
    // shallower floated by the difference (measured: pig2 back 3.8 cm deeper
    // than front → front feet planted 0-3% of the walk; the donkey plants all
    // four ~57%). Shift the deeper pair's foot bones up by the gap and re-run.
    const lo = hoofLows(tpl);
    const f = Math.min(lo.FL, lo.FR), bk = Math.min(lo.BL, lo.BR);
    const gap = (f - bk) / tpl.scale;                     // world → donkey units
    const off = gap > 0 ? { F: 0, B: -gap } : { F: gap, B: 0 };
    tpl.feetFollow = feetFollow(tpl, LEGS, off);
    tpl.footOff = off;
    const lo2 = hoofLows(tpl);
    console.log(`[feet] hooves front/back gap ${(100 * (f - bk)).toFixed(1)} cm → ${(100 * (Math.min(lo2.FL, lo2.FR) - Math.min(lo2.BL, lo2.BR))).toFixed(1)} cm`);
  }
  // Measured, not eyeballed: how far each hoof bends against its lower leg
  // over the Walk — the animal vs the donkey (same clip).
  if (MORPH_DIAGNOSTICS) {
    const flex = (src, clip) => {
      const r = cloneSkinned(src), b = {};
      r.traverse((o) => { if (o.isBone) b[o.name] = o; });
      const m = new THREE.AnimationMixer(r);
      m.clipAction(clip).play();
      const out = {}, q = new THREE.Quaternion();
      for (const [leg, ff] of [["BackLowerLegL", "FFBL"], ["FrontLowerLegL", "FFL"]]) {
        let lo = 1e9, hi = -1e9;
        for (let k = 0; k <= 60; k++) {
          m.setTime((clip.duration * k) / 60); r.updateMatrixWorld(true);
          const yl = V(0, 1, 0).applyQuaternion(b[leg].getWorldQuaternion(q)), yf = V(0, 1, 0).applyQuaternion(b[ff].getWorldQuaternion(q));
          const ang = (Math.acos(Math.max(-1, Math.min(1, yl.dot(yf)))) * 180) / Math.PI;
          lo = Math.min(lo, ang); hi = Math.max(hi, ang);
        }
        out[ff] = Math.round(hi - lo) + " deg";
      }
      m.stopAllAction();
      return out;
    };
    const wA = tpl.clips.find((c) => c.name === "Walk"), wD = gltf.animations.find((c) => c.name === "Walk");
    if (wA && wD) { tpl.hoofFlex = { animal: flex(tpl.root, wA), donkey: flex(gltf.scene, wD) }; console.log("[hoof flex over Walk]", JSON.stringify(tpl.hoofFlex)); }
  }
  tpl.ground = window.__noClamp ? {} : groundClamp(tpl);
  if (isMorph && !window.__noPlant) {
    tpl.planted = plantFrontFeet(tpl, Q.legs);
    // the foot bones follow the corrected legs (after the clamp's lift: they
    // follow the lifted legs too)
    tpl.feetFollow = feetFollow(tpl, Q.legs, tpl.footOff ?? { F: 0, B: 0 });
  }
  // Measured contact (read-only): over the Walk, how close does each foot's
  // lowest point come to the ground? A planted foot reaches ~0; a foot whose
  // minimum stays above it FLOATS for the whole cycle.
  if (MORPH_DIAGNOSTICS) {
    const r = cloneSkinned(tpl.root);
    let mesh = null; r.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
    const clip = tpl.clips.find((c) => c.name === "Walk");
    if (mesh && clip) {
      const names = mesh.skeleton.bones.map((b) => b.name);
      const G2 = mesh.geometry, SI = G2.attributes.skinIndex, SW = G2.attributes.skinWeight, n = G2.attributes.position.count;
      const footOf = (i) => { let best = -1, bw = 0; for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > bw) { bw = w; best = SI.getComponent(i, c); } } const nm = names[best] ?? "";
        const m = /(Front|Back)(LowerLeg|Leg)?([LR])$/.exec(nm) || /^IK(Front|Back)Leg([LR])$/.exec(nm) || /^FF(B?)([LR])$/.exec(nm);
        if (/^FFB[LR]$/.test(nm)) return "B" + nm.slice(-1); if (/^FF[LR]$/.test(nm)) return "F" + nm.slice(-1);
        if (/^IKFrontLeg/.test(nm)) return "F" + nm.slice(-1); if (/^IKBackLeg/.test(nm)) return "B" + nm.slice(-1);
        if (/^FrontLowerLeg/.test(nm)) return "F" + nm.slice(-1); if (/^BackLowerLeg/.test(nm)) return "B" + nm.slice(-1); return null; };
      const grp = Array.from({ length: n }, (_, i) => footOf(i));
      const mix = new THREE.AnimationMixer(r); mix.clipAction(clip).play();
      const lo = { FL: Infinity, FR: Infinity, BL: Infinity, BR: Infinity }, q = V();
      const down = { FL: 0, FR: 0, BL: 0, BR: 0 };
      for (let k = 0; k < 60; k++) {
        mix.setTime((clip.duration * k) / 60); r.updateMatrixWorld(true); mesh.skeleton.update();
        const f = { FL: Infinity, FR: Infinity, BL: Infinity, BR: Infinity };
        for (let i = 0; i < n; i += 2) { const g = grp[i]; if (!g) continue; mesh.getVertexPosition(i, q); q.applyMatrix4(mesh.matrixWorld); if (q.y < f[g]) f[g] = q.y; }
        for (const g in f) { lo[g] = Math.min(lo[g], f[g]); if (f[g] < 0.015) down[g]++; }
      }
      tpl.footPlanted = Object.fromEntries(Object.entries(down).map(([k, v]) => [k, Math.round((100 * v) / 60) + "%"]));
      mix.stopAllAction();
      tpl.footMinCm = Object.fromEntries(Object.entries(lo).map(([k, v]) => [k, +(v * 100).toFixed(1)]));
      console.log("[walk contact: each foot's lowest point, cm above ground]", JSON.stringify(tpl.footMinCm));
      window.__footMin = { lowestCm: tpl.footMinCm, planted: tpl.footPlanted };
      // the donkey itself, same measure (the yardstick)
      if (!window.__donkeyFoot) {
        const dr = cloneSkinned(gltf.scene), dm = [];
        dr.traverse((o) => { if (o.isSkinnedMesh) dm.push(o); });
        const dclip = gltf.animations.find((c) => c.name === "Walk");
        const cls = (m, i) => { const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight; let best = -1, bw = 0; for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > bw) { bw = w; best = si.getComponent(i, c); } } const nm = m.skeleton.bones[best]?.name ?? "";
          if (/^FFB[LR]$/.test(nm) || /^IKBackLeg/.test(nm) || /^BackLowerLeg/.test(nm)) return "B" + nm.slice(-1); if (/^FF[LR]$/.test(nm) || /^IKFrontLeg/.test(nm) || /^FrontLowerLeg/.test(nm)) return "F" + nm.slice(-1); return null; };
        const groups = dm.map((m) => Array.from({ length: m.geometry.attributes.position.count }, (_, i) => cls(m, i)));
        const dmx = new THREE.AnimationMixer(dr); dmx.clipAction(dclip).play();
        const dlo = { FL: Infinity, FR: Infinity, BL: Infinity, BR: Infinity }, dd = { FL: 0, FR: 0, BL: 0, BR: 0 }, q2 = V();
        let g0 = Infinity; const frames = [];
        for (let k = 0; k < 60; k++) {
          dmx.setTime((dclip.duration * k) / 60); dr.updateMatrixWorld(true);
          const f = { FL: Infinity, FR: Infinity, BL: Infinity, BR: Infinity };
          dm.forEach((m, mi) => { m.skeleton.update(); const n2 = m.geometry.attributes.position.count; for (let i = 0; i < n2; i += 2) { const g = groups[mi][i]; if (!g) continue; m.getVertexPosition(i, q2); q2.applyMatrix4(m.matrixWorld); if (q2.y < f[g]) f[g] = q2.y; } });
          frames.push(f); for (const g in f) g0 = Math.min(g0, f[g]);
        }
        const H0 = A.Rv * 3;   // donkey units → a relative 1.5 cm on a 0.85 m animal ≈ 0.018 of its height
        for (const f of frames) for (const g in f) { dlo[g] = Math.min(dlo[g], f[g] - g0); if (f[g] - g0 < 0.018 * (A.backTop - A.ground0)) dd[g]++; }
        window.__donkeyFoot = { planted: Object.fromEntries(Object.entries(dd).map(([k, v]) => [k, Math.round((100 * v) / 60) + "%"])) };
        dmx.stopAllAction();
      }
    }
  }
  // Measured smoothness (read-only): sample the Walk finely and find the
  // sharpest kink in the hind hoof's path and in the Body's height — the
  // biggest acceleration against the typical one. The donkey is the yardstick.
  if (MORPH_DIAGNOSTICS) {
    const kinks = (src, clip, legs) => {
      const r = cloneSkinned(src), b = {};
      r.traverse((o) => { if (o.isBone) b[o.name] = o; });
      const m = new THREE.AnimationMixer(r);
      m.clipAction(clip).play();
      const N = 240, hoof = [], body = [];
      const tip = V(0, A.ext.BackLowerLegL * legs, 0);
      for (let k = 0; k < N; k++) {
        m.setTime((clip.duration * k) / N); r.updateMatrixWorld(true);
        hoof.push(b.BackLowerLegL.localToWorld(tip.clone()));
        body.push(b.Body.getWorldPosition(V()).y);
      }
      m.stopAllAction();
      const ratio = (acc) => { const s2 = [...acc].sort((x, y) => x - y); const med = s2[s2.length >> 1] || 1e-9; return +(Math.max(...acc) / med).toFixed(1); };
      const aH = [], aB = [];
      for (let k = 0; k < N; k++) {
        const p0 = hoof[(k + N - 1) % N], p1 = hoof[k], p2 = hoof[(k + 1) % N];
        aH.push(p2.clone().add(p0).sub(p1.clone().multiplyScalar(2)).length());
        aB.push(Math.abs(body[(k + 1) % N] + body[(k + N - 1) % N] - 2 * body[k]));
      }
      return { hindHoofKink: ratio(aH), bodyKink: ratio(aB) };
    };
    const wA = tpl.clips.find((c) => c.name === "Walk"), wD = gltf.animations.find((c) => c.name === "Walk");
    if (wA && wD) { tpl.smooth = { animal: kinks(tpl.root, wA, Q.legs), donkey: kinks(gltf.scene, wD, 1) }; console.log("[walk smoothness: max/typical acceleration]", JSON.stringify(tpl.smooth)); window.__smooth = tpl.smooth; }
  }
  tpl.speed = {
    Walk: measureGroundSpeed(tpl, "Walk"),
    Gallop: measureGroundSpeed(tpl, "Gallop"),
  };
  tpl.buildMs = performance.now() - t0;
  return tpl;
}
// ── Camel (Arabian / dromedary) parts ────────────────────────────────────
// Same rig, no wool: smooth-skinned SDF body (barrel squashed sideways,
// ONE hump, sternal callus), an S-neck over the bent neck bones, SDF
// thighs/forearms, tube legs with knee calluses, broad two-toed pads,
// a tufted tail on the donkey's tail chain, and a level head with the
// droopy split upper lip and hanging lower lip.
function smax(a, b, k) { return -smin(-a, -b, k); }
function buildCamelParts({ W, fwd, right, G, tipOf, headFrame }) {
  const Q = PC;
  const baseC = new THREE.Color(Q.color), darkC = new THREE.Color(Q.dark), lightC = new THREE.Color(Q.light);
  const legC = baseC.clone().lerp(lightC, 0.3);
  const callusC = new THREE.Color("#4e3c2b"), padC = new THREE.Color("#51463c"), nailC = new THREE.Color("#1f1812");
  const eyeC = new THREE.Color("#0a0705"), tuftC = darkC.clone().multiplyScalar(0.55);
  const muzzleC = lightC.clone().lerp(new THREE.Color("#a89a88"), 0.35);
  const R = A.Rv * Q.girth, R0 = A.Rv * Q.legThick;
  const LP = STYLE.active;

  const unionSDF = (prims) => (x, y, z) => {
    let d = 1e9;
    for (const pr of prims) { const v = pr.d(x, y, z); d = pr.sub ? smax(d, -v, pr.k) : smin(d, v, pr.k); }
    return d;
  };
  // Mesh one SDF part; per vertex: soft skin weights over the prims,
  // nearest prim's tag → shade(p, n, tag, colour) → { rough, fur }.
  const emit = (prims, box, cell, margin, sig, aoStep, shade, target = 0) => {
    const sdf = unionSDF(prims);
    let m = surfaceNets(sdf, box, cell, margin);
    if (LP && target) m = decimate(m, target, sdf, cell * 0.5);
    const base = G.count, p = V(), n = V(), c = new THREE.Color(), pd = new Float64Array(prims.length);
    let top = -Infinity;
    for (let i = 0; i < m.pos.length; i += 3) {
      p.fromArray(m.pos, i); n.fromArray(m.nrm, i);
      top = Math.max(top, p.y);
      let dmin = Infinity, best = 0;
      for (let k = 0; k < prims.length; k++) {
        if (prims[k].sub) { pd[k] = Infinity; continue; }
        pd[k] = prims[k].d(p.x, p.y, p.z);
        if (pd[k] < dmin) { dmin = pd[k]; best = k; }
      }
      const ws = [];
      for (let k = 0; k < prims.length; k++) {
        if (prims[k].sub) continue;
        const s = Math.exp(-(pd[k] - dmin) / sig);
        if (s < 0.02) continue;
        for (const [b, w] of prims[k].weights(p)) ws.push([b, w * s]);
      }
      const sh = shade(p, n, prims[best].tag, c);
      const ao = sdfAO(sdf, p.x, p.y, p.z, n.x, n.y, n.z, aoStep);
      G.add(p, n, c, 0, sh.rough, ao, ws, sh.fur);
    }
    for (const i of m.idx) G.idx.push(base + i);
    return top;
  };

  // ── Body ──
  const off = V(0, A.cyOff, 0);
  const Lb = W("Torso3").sub(W("Back")).setY(0).length();
  const c0 = W("Back").add(off).addScaledVector(fwd, -0.1 * Lb).addScaledVector(UP, -0.06 * R);
  const c1 = W("Torso").add(off);
  const c2 = W("Torso2").add(off);
  const c3 = W("Torso3").add(off).addScaledVector(fwd, 0.02 * Lb).addScaledVector(UP, -0.06 * R);
  const c4 = W("Torso3").add(off).addScaledVector(fwd, 0.17 * Lb).addScaledVector(UP, -0.14 * R);
  const bJ = [c0, c1, c2, c3, c4], bR = [0.7, 0.8, 0.92, 1.0, 0.76].map((r) => r * R);
  const bBones = ["Back", "Torso", "Torso2", "Torso3"];
  const bodyW = (p) => chainWeights(p, bJ, bBones, 0.5);
  const narrow = 0.82;                         // a camel is deep, not wide
  const squash = (fn, o) => (x, y, z) => {
    const s = ((x - o.x) * right.x + (y - o.y) * right.y + (z - o.z) * right.z) * (1 / narrow - 1);
    return fn(x + right.x * s, y + right.y * s, z + right.z * s) * narrow;
  };
  const prims = [], box = new Box();
  for (let i = 0; i < 4; i++) {
    prims.push({ d: squash(roundCone(bJ[i], bJ[i + 1], bR[i], bR[i + 1]), c2), k: 0.35 * R, tag: "body", weights: bodyW });
    box.add(bJ[i], bR[i]); box.add(bJ[i + 1], bR[i + 1]);
  }
  // The hump: one, a little behind the middle of the back.
  const hc = c2.clone().lerp(c3, 0.12).addScaledVector(UP, 0.92 * R);
  const hr = [0.36 * Lb * Q.humpLen, 0.78 * R * Q.hump, 0.52 * R];
  prims.push({ d: ellipsoid(hc, fwd, UP, right, hr[0], hr[1], hr[2]), k: 0.45 * R, tag: "hump", weights: bodyW });
  box.add(hc, Math.max(...hr));
  // Sternal callus — the pad the camel kneels on.
  const pc = c3.clone().addScaledVector(UP, -0.9 * R).addScaledVector(fwd, -0.02 * Lb);
  prims.push({ d: ellipsoid(pc, fwd, UP, right, 0.26 * R, 0.13 * R, 0.2 * R), k: 0.18 * R, tag: "callus", weights: bodyW });
  box.add(pc, 0.3 * R);
  // Neck along the bent neck chain.
  const n0 = c3.clone().addScaledVector(UP, 0.2 * R).addScaledVector(fwd, 0.12 * Lb);
  const nJ = [n0, W("Neck1"), W("Neck2"), W("Neck3"), W("Head")];
  const nR = [0.6, 0.4, 0.31, 0.26, 0.22].map((r) => r * R * Q.neckThick);
  const nBones = ["Torso3", "Neck1", "Neck2", "Neck3"];
  for (let i = 0; i < 4; i++) {
    prims.push({ d: roundCone(nJ[i], nJ[i + 1], nR[i], nR[i + 1]), k: 0.25 * R, tag: "neck", weights: (p) => chainWeights(p, nJ, nBones, 0.5) });
    box.add(nJ[i], nR[i]); box.add(nJ[i + 1], nR[i + 1]);
  }
  // Thighs and forearms.
  for (const s of ["L", "R"]) {
    const ta = W("BackLeg" + s), tb = W("BackUpperLeg" + s);
    prims.push({ d: roundCone(ta, tb, 0.32 * R, 0.18 * R), k: 0.3 * R, tag: "leg",
      weights: (p) => { const t = smoothstep01(0.15, 0.95, segParam(p, ta, tb)); return [["Back", 1 - t], ["BackLeg" + s, t]]; } });
    box.add(ta, 0.32 * R); box.add(tb, 0.18 * R);
    const fa = W("FrontUpperLeg" + s).addScaledVector(UP, 0.12 * R), fb = W("FrontUpperLeg" + s).lerp(W("FrontLowerLeg" + s), 0.62);
    prims.push({ d: roundCone(fa, fb, 0.32 * R, 0.15 * R), k: 0.25 * R, tag: "leg",
      weights: (p) => { const t = smoothstep01(0.0, 0.45, segParam(p, fa, fb)); return [["Torso3", 1 - t], ["FrontUpperLeg" + s, t]]; } });
    box.add(fa, 0.32 * R); box.add(fb, 0.15 * R);
  }
  const mottle = (p) => 0.94 + 0.12 * dome(worley(p.x / (0.7 * R) + 3.1, p.y / (0.7 * R), p.z / (0.7 * R) + 1.7));
  const topY = emit(prims, box, R / (LP ? 14 : 22), 0.15 * R, 0.22 * R, 0.07 * R, (p, n, tag, c) => {
    if (tag === "callus") { c.copy(callusC); return { rough: 0.95, fur: 0.15 }; }
    const top = smoothstep01(0.25, 0.95, n.y), under = smoothstep01(0.15, 0.8, -n.y);
    c.copy(baseC).lerp(darkC, top * (tag === "hump" ? 0.55 : 0.3)).lerp(lightC, under * 0.55);
    if (tag === "neck" && n.y < -0.1) c.lerp(darkC, 0.3 * smoothstep01(0.1, 0.6, -n.y));   // shaggy throat
    c.multiplyScalar(mottle(p));
    return { rough: 0.85, fur: 1 };
  }, 1000);

  // ── Legs (tubes) ──
  const legRings = (J, prof, bones) => {
    const rings = [];
    const at = (si, t) => J[si].clone().lerp(J[si + 1], t);
    for (let k = 0; k < prof.length - 1; k++) {
      const [sa, ta, ra, ca] = prof[k], [sb, tb, rb] = prof[k + 1];
      const pa = at(sa, ta), pb = at(sb, tb);
      const steps = Math.max(1, Math.round(pa.distanceTo(pb) / ((LP ? 0.75 : 0.3) * R0)));
      for (let s = 0; s < steps; s++) { const u = s / steps; rings.push({ p: pa.clone().lerp(pb, u), r: ra + (rb - ra) * u, col: ca, rough: 0.85, fur: ca === callusC ? 0.1 : 0.8 }); }
    }
    const lp = prof[prof.length - 1];
    rings.push({ p: at(lp[0], lp[1]), r: lp[2], col: lp[3], rough: 0.85, fur: 0.8 });
    addTube(G, rings, LP ? 6 : 14, fwd, (p) => chainWeights(p, J, bones, 0.12), false);
  };
  const hockC = legC.clone().multiplyScalar(0.85);
  for (const s of ["L", "R"]) {
    const Jf = [W("FrontUpperLeg" + s), W("FrontLowerLeg" + s), tipOf("FrontLowerLeg" + s)];
    legRings(Jf, [
      [0, 0.5, 0.16 * R0, legC], [0, 0.8, 0.12 * R0, legC], [0, 0.94, 0.11 * R0, legC],
      [1, 0.0, 0.13 * R0, callusC], [1, 0.07, 0.12 * R0, callusC], [1, 0.15, 0.08 * R0, legC],
      [1, 0.7, 0.064 * R0, legC], [1, 0.8, 0.076 * R0, legC], [1, 0.9, 0.07 * R0, legC], [1, 0.97, 0.08 * R0, legC],
    ], ["FrontUpperLeg" + s, "FrontLowerLeg" + s]);
    const Jb = [W("BackLeg" + s), W("BackUpperLeg" + s), W("BackLowerLeg" + s), tipOf("BackLowerLeg" + s)];
    legRings(Jb, [
      [0, 0.6, 0.19 * R0, legC], [0, 1, 0.15 * R0, legC], [1, 0.35, 0.115 * R0, legC], [1, 0.85, 0.088 * R0, legC],
      [1, 1.0, 0.1 * R0, hockC], [2, 0.1, 0.085 * R0, hockC], [2, 0.2, 0.064 * R0, legC],
      [2, 0.72, 0.062 * R0, legC], [2, 0.82, 0.075 * R0, legC], [2, 0.9, 0.07 * R0, legC], [2, 0.97, 0.08 * R0, legC],
    ], ["BackLeg" + s, "BackUpperLeg" + s, "BackLowerLeg" + s]);
  }

  // ── Feet: broad soft pads, two toes with small nails ──
  for (const foot of ["FrontLowerLegL", "FrontLowerLegR", "BackLowerLegL", "BackLowerLegR"]) {
    const T = tipOf(foot), FW = () => [[foot, 1]];
    const pp = [], pb = new Box();
    const P1 = (f, sd, u) => T.clone().addScaledVector(fwd, f * R0).addScaledVector(right, sd * R0).addScaledVector(UP, u * R0);
    pp.push({ d: ellipsoid(P1(0.04, 0, 0.075), fwd, UP, right, 0.21 * R0, 0.075 * R0, 0.165 * R0), k: 0.04 * R0, tag: "sole", weights: FW });
    pp.push({ d: roundCone(P1(0, 0, 0.32), P1(0, 0, 0.1), 0.068 * R0, 0.1 * R0), k: 0.06 * R0, tag: "skin", weights: FW });
    for (const sx of [-1, 1]) {
      pp.push({ d: sphere(P1(0.17, 0.075 * sx, 0.065), 0.07 * R0), k: 0.04 * R0, tag: "toe", weights: FW });
      pp.push({ d: sphere(P1(0.235, 0.075 * sx, 0.09), 0.028 * R0), k: 0.01 * R0, tag: "nail", weights: FW });
    }
    pp.push({ d: ellipsoid(P1(0.22, 0, 0.07), fwd, UP, right, 0.1 * R0, 0.1 * R0, 0.012 * R0), k: 0.015 * R0, tag: "cut", weights: FW, sub: true });
    pb.add(P1(0.04, 0, 0.12), 0.3 * R0); pb.add(P1(0, 0, 0.3), 0.12 * R0);
    emit(pp, pb, (LP ? 0.03 : 0.016) * R0, 0.06 * R0, 0.02 * R0, 0.02 * R0, (p, n, tag, c) => {
      if (tag === "nail") { c.copy(nailC); return { rough: 0.4, fur: 0 }; }
      if (tag === "skin") { c.copy(legC); return { rough: 0.85, fur: 0.7 }; }
      c.copy(padC).lerp(legC, tag === "toe" ? 0.25 : 0.1);
      if (n.y < -0.5) c.multiplyScalar(0.7);
      return { rough: 0.9, fur: 0.1 };
    }, 40);
  }

  // ── Tail: thin, on the donkey's tail chain, dark tuft at the end ──
  {
    const tj = [1, 2, 3, 4, 5, 6, 7].map((i) => W("Tail" + i));
    tj.push(tj[6].clone().multiplyScalar(2).sub(tj[5]));
    const tb = [1, 2, 3, 4, 5, 6, 7].map((i) => "Tail" + i);
    const pts = [tj[0].clone().lerp(tj[1], 0.5)];
    for (let i = 1; i < tj.length; i++) { pts.push(tj[i - 1].clone().lerp(tj[i], i === 1 ? 0.75 : 0.5)); pts.push(tj[i]); }
    let total = 0; const acc = [0];
    for (let i = 1; i < pts.length; i++) { total += pts[i].distanceTo(pts[i - 1]); acc.push(total); }
    const rings = pts.map((p, i) => {
      const u = acc[i] / total, tuft = u > 0.72;
      const r = tuft ? 0.055 * R * (1 - 0.8 * ((u - 0.72) / 0.28) ** 2) : (0.05 - 0.022 * u) * R;
      return { p, r, col: tuft ? tuftC : baseC.clone().lerp(darkC, 0.25), rough: 0.9, fur: 1 };
    });
    addTube(G, rings, LP ? 5 : 10, right, (p) => chainWeights(p, tj, tb, 0.3), true);
  }

  // ── Head ──
  const Lh = A.Lh * Q.head;
  const { H, a, hu, hs, Hp } = headFrame(Lh);
  const hp = [], hbx = new Box();
  const HW = () => [["Head", 1]];
  const addP = (d, k, tag, c, r, extra = {}) => { hp.push({ d, k, tag, weights: extra.weights ?? HW, sub: extra.sub }); hbx.add(c, r); };
  const E = (x, y, z, rx, ry, rz) => ellipsoid(Hp(x, y, z), hs, hu, a, rx * Lh, ry * Lh, rz * Lh);
  addP(E(0, 0.06, 0.2, 0.19, 0.19, 0.24), 0.1 * Lh, "skin", Hp(0, 0.06, 0.2), 0.26 * Lh);
  addP(sphere(Hp(0, 0.02, 0.04), 0.17 * Lh), 0.1 * Lh, "skin", Hp(0, 0.02, 0.04), 0.18 * Lh);
  addP(roundCone(Hp(0, 0.03, 0.36), Hp(0, -0.01, 0.8), 0.155 * Lh, 0.1 * Lh), 0.1 * Lh, "skin", Hp(0, 0, 0.6), 0.4 * Lh);
  addP(E(0, -0.1, 0.42, 0.15, 0.13, 0.3), 0.1 * Lh, "skin", Hp(0, -0.1, 0.42), 0.32 * Lh);
  addP(E(0, -0.05, 0.88, 0.115, 0.1, 0.105), 0.06 * Lh, "muzzle", Hp(0, -0.05, 0.88), 0.13 * Lh);
  addP(E(0, -0.165, 0.82, 0.085, 0.055, 0.13), 0.05 * Lh, "muzzle", Hp(0, -0.165, 0.82), 0.15 * Lh);
  addP(E(0, -0.08, 0.975, 0.018, 0.075, 0.05), 0.02 * Lh, "cut", Hp(0, -0.08, 0.975), 0.08 * Lh, { sub: true });
  for (const sx of [-1, 1]) addP(E(0.06 * sx, 0.0, 0.955, 0.014, 0.034, 0.03), 0.012 * Lh, "cut", Hp(0.06 * sx, 0, 0.955), 0.05 * Lh, { sub: true });
  const eyes = [];
  for (const sx of [-1, 1]) {
    addP(sphere(Hp(0.12 * sx, 0.15, 0.34), 0.07 * Lh), 0.06 * Lh, "brow", Hp(0.12 * sx, 0.15, 0.34), 0.08 * Lh);
    const d = V(0.82 * sx, 0.3, 0.5);
    const e = 1 / Math.hypot(d.x / 0.19, d.y / 0.19, d.z / 0.24);
    const el = V(d.x * e * 0.97, 0.06 + d.y * e, 0.2 + d.z * e);
    if (!LP) addP(sphere(Hp(el.x, el.y, el.z), 0.04 * Lh), 0.008 * Lh, "eye", Hp(el.x, el.y, el.z), 0.05 * Lh);
    eyes.push(Hp(el.x, el.y, el.z));
    addP(sphere(Hp(el.x * 0.98, el.y + 0.035, el.z - 0.005), 0.04 * Lh), 0.02 * Lh, "lid", Hp(el.x, el.y + 0.035, el.z), 0.05 * Lh);
    // Small rounded ears, up and back.
    const s = sx < 0 ? "L" : "R";
    const earSide = (W("Ear1" + s).sub(H).dot(hs) < 0) === (sx < 0) ? s : (s === "L" ? "R" : "L");
    const eb = Hp(0.11 * sx, 0.19, 0.07);
    const e1 = hs.clone().multiplyScalar(0.55 * sx).addScaledVector(hu, 0.75).addScaledVector(a, -0.35).normalize();
    const len = (LP ? 0.13 : 0.15) * Lh;
    const e2 = V().crossVectors(e1, a).normalize(), e3 = V().crossVectors(e1, e2).normalize();
    const ec = eb.clone().addScaledVector(e1, len * 0.5);
    addP(ellipsoid(ec, e1, e2, e3, len * 0.5, (LP ? 0.05 : 0.06) * Lh, (LP ? 0.035 : 0.028) * Lh), 0.03 * Lh, "ear", ec, len * 0.6, {
      weights: (p) => { const t = smoothstep01(0.05, 0.4, segParam(p, eb, eb.clone().addScaledVector(e1, len))); return [["Head", 1 - t], ["Ear1" + earSide, t]]; },
    });
  }
  const rel = V();
  emit(hp, hbx, Lh / (LP ? 32 : 84), 0.06 * Lh, 0.02 * Lh, 0.03 * Lh, (p, n, tag, c) => {
    if (!LP && eyes.some((e) => e.distanceTo(p) < 0.043 * Lh)) { c.copy(eyeC); return { rough: 0.1, fur: 0 }; }
    rel.subVectors(p, H);
    const lz = rel.dot(a) / Lh;
    c.copy(baseC).lerp(lightC, 0.2).lerp(darkC, 0.25 * smoothstep01(0.3, 0.95, n.y));
    c.lerp(muzzleC, smoothstep01(0.62, 0.86, lz));
    if (tag === "brow") c.multiplyScalar(0.92);
    if (tag === "lid") c.multiplyScalar(0.8);
    if (tag === "ear") c.lerp(darkC, 0.3);
    return { rough: 0.8, fur: 0.8 };
  }, 380);

  if (LP) {
    const skull = Hp(0, 0.06, 0.2);
    for (const e of eyes) {
      const out = e.clone().sub(skull).normalize();
      G.gem(e.clone().addScaledVector(out, 0.01 * Lh), 0.05 * Lh, new THREE.Color("#e9e1d2"), "Head", 0, 0.4);
      G.gem(e.clone().addScaledVector(out, 0.036 * Lh), 0.032 * Lh, eyeC, "Head", 0, 0.15);
    }
  }
  return { topY, curlR: R };
}

// ── Camel by MORPHING THE DONKEY ─────────────────────────────────────────
// The pack's own mesh, so the pack's own look: its quad-modelled faces,
// its colour zones, its skin weights.
//   1. Pose the donkey's rest mesh with the camel's rest skeleton (long
//      legs, S-neck, short ears) through its own weights — linear blend
//      skinning does the big reshaping — and bake that as the new rest.
//   2. Weld by position, cut extra loops into the back (red-green
//      refinement: split edges are shared, so no cracks), raise the hump.
//   3. Hooves spread into pads, mane flattened, head resized, camel
//      palette on the donkey's material zones.
// kind "camel" | "sheep": the same donkey → quads pipeline; the camel adds
// face / slimming / pads / hump, the sheep adds wool, sideways ears, a
// stub tail and a Suffolk palette (your low-poly reference).
function buildCamelMorph({ B, W, fwd, right, G, tipOf, F }, kind = "camel") {
  const SHEEP = kind === "sheep", GOAT = kind === "goat", CAMEL = kind === "camel";
  const PIG2 = kind === "pig2", PIG = kind === "pig" || PIG2;   // pig2 = the pig's code, its own params
  const PQ = PIG2 ? PPIG2 : PPIG;
  const SMALL = SHEEP || GOAT;           // the sheep-like head / ear handling
  const HYENA = kind === "hyena";        // from the HUSKY (A / gltf = the husky's)
  const DONKEY = kind === "donkey";      // the donkey itself: shape untouched, its own colours
  const GAZELLE = kind === "gazelle";    // from the DEER (A / gltf = the deer's)
  const Q = SHEEP ? P : GOAT ? PG : PIG ? PQ : HYENA ? PHY : DONKEY ? PDK : GAZELLE ? PGZ : PC, src = A.mesh;
  const legSlim = SHEEP ? 0.72 : GOAT ? 0.66 : PIG ? PQ.legThick : HYENA ? PHY.legSlim : DONKEY ? 1 : GAZELLE ? PGZ.legSlim : PC.legSlim, neckSlim = SHEEP ? 1 : GOAT ? 0.85 : PIG ? PQ.neckSlim : HYENA ? PHY.neckSlim : DONKEY ? 1 : GAZELLE ? PGZ.neckSlim : PC.neckSlim;
  const hash = (i) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
  const capSet = new Set();               // sheep: head vertices under the wool cap
  // 1. Donkey rest → camel rest through the skin.
  // Each bone's LENGTH change = the scale given to its child's offset (the
  // lower legs: the leg factor). A vertex is taken into its bone's frame,
  // its position ALONG the bone (+Y) scaled by that, and carried out by
  // the new bone — so a shortened thigh's own geometry shortens with it
  // instead of poking past the knee (measured: knee rings 0.43 → 0.9).
  const lenScale = {};
  for (const n of A.boneNames) {
    const kid = B[n].children.find((c) => c.isBone && F[c.name] !== undefined);
    lenScale[n] = kid ? F[kid.name] : /LowerLeg/.test(n) ? (Q.legsBack && n.startsWith("Back") ? Q.legsBack : Q.legs) : 1;
  }
  const M = {}, Minv0 = A.restInv;
  for (const n of A.boneNames) M[n] = B[n].matrixWorld.clone();
  const nV = src.pos.length / 3, v = V(), t = V(), acc = V();
  const along = (b, w) => {
    t.copy(v).applyMatrix4(Minv0[b]);           // donkey bone space
    t.y *= lenScale[b];
    return t.applyMatrix4(M[b]).multiplyScalar(w);
  };
  // The donkey's hooves and pasterns are skinned to its IK FOOT bones,
  // which the clips keep planted at DONKEY stride positions. With longer
  // legs the leg bones and the foot bones disagree and the foot bends
  // between them — so the foot goes to its own lower-leg bone.
  const FOOT = {
    FFL: "FrontLowerLegL", IKFrontLegL: "FrontLowerLegL", FFR: "FrontLowerLegR", IKFrontLegR: "FrontLowerLegR",
    FFBL: "BackLowerLegL", IKBackLegL: "BackLowerLegL", FFBR: "BackLowerLegR", IKBackLegR: "BackLowerLegR",
  };
  const footToLeg = (sk) => {
    const m = new Map();
    for (const [b, w] of sk) { const n = FOOT[b] ?? b; m.set(n, (m.get(n) ?? 0) + w); }
    return [...m];
  };
  // 2a. Weld (the pack's faces are split per face / material). By DISTANCE,
  // not by rounding: Draco quantisation leaves coincident vertices a hair
  // apart, and a rounding key left ~330 open seams that every later edit
  // could tear. At this tolerance the donkey is a closed mesh.
  const TOL = 5e-3, grid = new Map(), SRC = [];
  const cellKey = (x, y, z) => `${x},${y},${z}`;
  const weldId = (x, y, z) => {
    const cx = Math.floor(x / TOL), cy = Math.floor(y / TOL), cz = Math.floor(z / TOL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(cellKey(cx + dx, cy + dy, cz + dz));
      if (list) for (const id of list) { const q = SRC[id]; if (Math.hypot(q[0] - x, q[1] - y, q[2] - z) < TOL) return id; }
    }
    const id = SRC.length;
    SRC.push([x, y, z]);
    const k = cellKey(cx, cy, cz);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(id);
    return id;
  };
  const WP = [], WS = [], WM = [], WIK = [], remap = new Int32Array(nV);
  for (let i = 0; i < nV; i++) {
    v.fromArray(src.pos, i * 3);
    acc.set(0, 0, 0);
    // Pose with the SAME remapped weights the animal will be skinned with:
    // the donkey's IK foot bones stay at donkey-leg positions, so posing
    // through them sheared every hoof into shards (measured: spike 0.14 → 0.88).
    const sk = src.skin[i];   // the IK foot bones now follow the legs (see "Foot bones follow")
    for (const [b, w] of sk) acc.add(along(b, w));
    const id = weldId(src.pos[i * 3], src.pos[i * 3 + 1], src.pos[i * 3 + 2]);
    if (id === WP.length) {
      WP.push(acc.clone()); WS.push(src.skin[i]); WM.push(new Set());
      WIK.push(src.skin[i].reduce((sum, [b, w]) => sum + (FOOT[b] ? w : 0), 0));   // how much the DONKEY foot bones owned it
    }
    WM[id].add(src.mat[i]);
    remap[i] = id;
  }
  // Back to QUADS. The donkey was modelled in quads and triangulated on
  // export: each quad is two triangles sharing their LONGEST edge,
  // coplanar in the donkey's rest pose (SRC). Pair them up again — the
  // camel is then cut and shaded by quads, like the donkey. A face is
  // [v0, v1, v2, (v3), material].
  let faces = [];
  {
    const tris = [];
    for (let i = 0; i < src.idx.length; i += 3) {
      const a = remap[src.idx[i]], b = remap[src.idx[i + 1]], c = remap[src.idx[i + 2]];
      if (a !== b && b !== c && a !== c) tris.push([a, b, c, src.mat[src.idx[i]]]);
    }
    // The donkey is flat-shaded: every corner of an authored POLYGON carries
    // that polygon's normal. Triangles sharing an edge AND that normal were
    // one polygon — group them (union-find) and walk each group's outline.
    const tn = [];
    for (let i = 0; i < src.idx.length; i += 3) {
      const a = remap[src.idx[i]], b = remap[src.idx[i + 1]], c = remap[src.idx[i + 2]];
      if (a !== b && b !== c && a !== c) tn.push(V().fromArray(src.nrm, src.idx[i] * 3));
    }
    const ek = (x, y) => (x < y ? `${x}_${y}` : `${y}_${x}`);
    const parent = tris.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const byEdge = new Map();
    tris.forEach((t, ti) => {
      for (const [x, y] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) {
        const k = ek(x, y);
        if (!byEdge.has(k)) byEdge.set(k, []);
        byEdge.get(k).push(ti);
      }
    });
    for (const list of byEdge.values()) {
      if (list.length !== 2) continue;
      const [ti, tj] = list;
      if (tris[ti][3] !== tris[tj][3] || tn[ti].dot(tn[tj]) < 0.9999) continue;
      parent[find(ti)] = find(tj);
    }
    const groups = new Map();
    tris.forEach((t, ti) => { const r = find(ti); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(ti); });
    let ngons = 0;
    for (const g of groups.values()) {
      const t0 = tris[g[0]];
      if (g.length === 1) { faces.push([t0[0], t0[1], t0[2], t0[3]]); continue; }
      // outline = directed edges not cancelled by their reverse
      const dir = new Map();
      for (const ti of g) { const t = tris[ti]; for (const [x, y] of [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]]) dir.set(`${x}>${y}`, [x, y]); }
      const next = new Map();
      let ok = true;
      for (const [k, [x, y]] of dir) if (!dir.has(`${y}>${x}`)) { if (next.has(x)) ok = false; next.set(x, y); }
      const loop = [];
      if (ok && next.size) {
        let v0 = next.keys().next().value, v1 = v0;
        do { loop.push(v1); v1 = next.get(v1); } while (v1 !== undefined && v1 !== v0 && loop.length <= next.size);
        ok = v1 === v0 && loop.length === next.size;
      }
      if (!ok || loop.length < 3) { for (const ti of g) { const t = tris[ti]; faces.push([t[0], t[1], t[2], t[3]]); } continue; }
      if (loop.length > 4) ngons++;
      faces.push([...loop, t0[3]]);
    }
    const nq = faces.filter((f) => f.length === 5).length, nt = faces.filter((f) => f.length === 4).length;
    console.log(`[camel-morph] donkey: ${tris.length} tris → ${nq} quads + ${nt} tris + ${ngons} n-gons (from its authored normals)`);
  }
  const fv = (f) => f.slice(0, -1), fm = (f) => f[f.length - 1];
  const wOf = (i, pred) => WS[i].reduce((s, [b, w]) => s + (pred(b) ? w : 0), 0);

  const flipReport = {};
  const countFlips = (label) => {
    const nrm = (f) => {
      const vs = fv(f), L = vs.length, n = V();
      for (let k = 0; k < L; k++) { const p0 = WP[vs[k]], p1 = WP[vs[(k + 1) % L]]; n.x += (p0.y - p1.y) * (p0.z + p1.z); n.y += (p0.z - p1.z) * (p0.x + p1.x); n.z += (p0.x - p1.x) * (p0.y + p1.y); }
      return n.normalize();
    };
    const N = faces.map(nrm), byE = new Map();
    faces.forEach((f, fi) => { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length], key = x < y ? `${x}_${y}` : `${y}_${x}`; (byE.get(key) ?? byE.set(key, []).get(key)).push(fi); } });
    const nb = faces.map(() => V());
    for (const l of byE.values()) if (l.length === 2) { nb[l[0]].add(N[l[1]]); nb[l[1]].add(N[l[0]]); }
    let flips = 0; const where = {};
    faces.forEach((f, fi) => {
      if (nb[fi].lengthSq() < 1e-12 || N[fi].dot(nb[fi].normalize()) > -0.2) return;
      flips++;
      const b = WS[fv(f)[0]].reduce((m, e) => (e[1] > m[1] ? e : m), ["", 0])[0];
      where[b] = (where[b] ?? 0) + 1;
      if (b === "Head") {   // where on the head (for tracing see-through slits)
        const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length).sub(W("Head"));
        (where.headAt ??= []).push({ mat: fm(f), fwd: +c.dot(fwd).toFixed(3), up: +c.y.toFixed(3), side: +c.dot(right).toFixed(3) });
      }
    });
    flipReport[label] = { flips, where };
  };
  countFlips("posed");
  // 2b. Head: resize about the Head joint, a little longer along the muzzle.
  const H = W("Head");
  const a = A.muzzleLocal.clone().applyQuaternion(B.Head.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const hu = UP.clone().addScaledVector(a, -UP.dot(a)).normalize();
  const hs = V().crossVectors(hu, a).normalize();
  const headW = (i) => wOf(i, (b) => b === "Head" || b.startsWith("Ear"));
  let LmH = 0;
  for (let i = 0; i < WP.length; i++) if (headW(i) > 0.5) LmH = Math.max(LmH, WP[i].clone().sub(H).dot(a));
  for (let i = 0; i < WP.length; i++) {
    const w = headW(i);
    if (w <= 0) continue;
    const d = WP[i].clone().sub(H);
    const along = d.dot(a);
    // sheep: a shorter muzzle, but only IN FRONT of the eyes — shortening
    // the whole head squashed the eye into a slit
    const muz = SMALL || PIG || HYENA ? smoothstep01(0.4, 0.75, along / LmH) : 1;
    d.multiplyScalar(1 + ((SHEEP ? 0.92 : GOAT ? 0.86 : PIG ? PQ.head : HYENA ? PHY.head : DONKEY ? 1 : GAZELLE ? PGZ.head : Q.head * 0.92) - 1) * w)
      .addScaledVector(a, (along - (SMALL || PIG || HYENA ? 0.4 * LmH : 0)) * (SHEEP ? -0.35 * muz : GOAT ? -0.18 * muz : PIG ? PQ.muzzle * muz : HYENA ? PHY.muzzle * muz : DONKEY || GAZELLE ? 0 : 0.14) * w);
    // hyena: a NARROW head (the husky's is broad and round — "the face looks
    // way too large"), the ears keep their spread
    if (HYENA && PHY.headNarrow) d.addScaledVector(hs, d.dot(hs) * (PHY.headNarrow - 1) * Math.min(1, wOf(i, (b) => b === "Head")));
    if (GAZELLE && PGZ.muzzleNarrow) d.addScaledVector(hs, d.dot(hs) * (PGZ.muzzleNarrow - 1) * smoothstep01(0.45, 0.8, along / LmH) * Math.min(1, wOf(i, (b) => b === "Head")));
    WP[i].copy(H).add(d);
  }
  // (camel only) Camel face, in head space (z along the muzzle 0..1, y up, x across):
  //   · a shallower jaw — the donkey's deep cheek lifted;
  //   · a longer, slimmer snout, less bulbous at the end;
  //   · the end droops, the upper lip overhangs, the lower lip hangs;
  //   · heavy brows over the eyes.
  if (CAMEL) {
    let Lm = 0;
    for (let i = 0; i < WP.length; i++) if (headW(i) > 0.5) Lm = Math.max(Lm, WP[i].clone().sub(H).dot(a));
    const bump = (x, a0, a1, b0, b1) => smoothstep01(a0, a1, x) * (1 - smoothstep01(b0, b1, x));
    for (let i = 0; i < WP.length; i++) {
      const w = Math.min(1, headW(i));
      if (w <= 0 || wOf(i, (b) => b.startsWith("Ear")) > 0.2) continue;
      const d = WP[i].clone().sub(H);
      const z0 = d.dot(a) / Lm;
      let z = z0, y = d.dot(hu) / Lm, x = d.dot(hs) / Lm;
      if (y < -0.02) y += (-0.02 - y) * 0.4 * bump(z0, 0.1, 0.3, 0.7, 0.95);      // shallower jaw
      const t = smoothstep01(0.4, 1.0, z0);
      z += 0.14 * t * (z0 - 0.4);                                                // longer snout
      x *= 1 - 0.28 * t;                                                         // slimmer
      const yc = -0.06; y = yc + (y - yc) * (1 - 0.18 * t);                      // less bulbous
      y -= 0.08 * t * t;                                                         // droops
      if (z0 > 0.78 && y < -0.1) y -= 0.07 * smoothstep01(0.78, 1, z0);          // lower lip hangs
      if (z0 > 0.88 && y > -0.06) z += 0.04 * smoothstep01(0.88, 1, z0);         // upper lip overhangs
      const brow = bump(z0, 0.15, 0.28, 0.42, 0.55) * smoothstep01(0.02, 0.12, y) * smoothstep01(0.08, 0.16, Math.abs(x));
      x *= 1 + 0.1 * brow; y += 0.03 * brow;                                     // heavy brows
      const q = H.clone().addScaledVector(a, z * Lm).addScaledVector(hu, y * Lm).addScaledVector(hs, x * Lm);
      WP[i].lerp(q, w);
    }
  }

  countFlips("head+face");
  // Thinner than a donkey: pull leg and neck vertices toward their bone
  // axis, weighted by how much each vertex belongs to that chain.
  const nearest = (J, p) => {
    let best = null, bd = Infinity, bs = 0, run = 0, bt = null;
    for (let j = 0; j < J.length - 1; j++) {
      const ab = J[j + 1].clone().sub(J[j]), L = ab.length();
      const u = Math.min(1, Math.max(0, p.clone().sub(J[j]).dot(ab) / (L * L)));
      const q = J[j].clone().addScaledVector(ab, u), d = q.distanceTo(p);
      if (d < bd) { bd = d; best = q; bs = run + u * L; bt = ab.clone().normalize(); }
      run += L;
    }
    return { c: best, s: bs, t: bt };
  };
  const towardChain = (J, bonesOf, k) => {
    for (let i = 0; i < WP.length; i++) {
      const w = wOf(i, bonesOf);
      if (w <= 0.05) continue;
      const { c } = nearest(J, WP[i]);
      WP[i].sub(c).multiplyScalar(1 + (k - 1) * Math.min(1, w)).add(c);
    }
  };
  for (const sd of ["L", "R"]) {
    towardChain([W("FrontUpperLeg" + sd), W("FrontLowerLeg" + sd), tipOf("FrontLowerLeg" + sd)],
      (b) => b === "FrontLowerLeg" + sd, legSlim);
    towardChain([W("FrontUpperLeg" + sd), W("FrontLowerLeg" + sd)], (b) => b === "FrontUpperLeg" + sd, 0.5 + 0.5 * legSlim);
    towardChain([W("BackUpperLeg" + sd), W("BackLowerLeg" + sd), tipOf("BackLowerLeg" + sd)],
      (b) => b === "BackLowerLeg" + sd || b === "BackUpperLeg" + sd, legSlim);
    // Ears: small and rounded, shrunk onto their base.
    const e0 = W("Ear1" + sd);
    for (let i = 0; i < WP.length; i++) {
      const w = wOf(i, (b) => b.startsWith("Ear") && b.endsWith(sd));
      if (w > 0.05) WP[i].sub(e0).multiplyScalar(1 - (SHEEP ? 0 : GOAT ? 0.1 : PIG ? PQ.ears : HYENA ? PHY.ears : DONKEY ? 0 : GAZELLE ? PGZ.ears : 0.45) * Math.min(1, w)).add(e0);   // sheep ears keep their size: they must clear the wool
    }
    const earWideK = PIG2 ? PQ.earWide : HYENA ? (PHY.earWide ?? 1) : 1;
    if ((PIG2 || HYENA) && earWideK !== 1) {
      // A pig's ear is a BROAD triangle: widen it across its own axis, most at
      // the base, back to the point at the tip.
      const tipC = V(); let nw = 0;
      for (let i = 0; i < WP.length; i++) if (wOf(i, (b) => /^Ear[34]/.test(b) && b.endsWith(sd)) > 0.5) { tipC.add(WP[i]); nw++; }
      if (nw) {
        const ax = tipC.multiplyScalar(1 / nw).sub(e0), len = ax.length(); ax.normalize();
        for (let i = 0; i < WP.length; i++) {
          const w = wOf(i, (b) => /^Ear[1-4]/.test(b) && b.endsWith(sd));
          // by a SMOOTH weight: a hard cut at 0.3 left the ear root's
          // half-weighted vertices behind and tore a see-through slit under it
          if (w < 0.05) continue;
          const d = WP[i].clone().sub(e0), t = Math.min(1, Math.max(0, d.dot(ax) / len));
          const perp = d.clone().addScaledVector(ax, -d.dot(ax));
          const k = 1 + (earWideK - 1) * (1 - t) * smoothstep01(0.05, 0.7, w) * smoothstep01(0.02, 0.2, t);
          WP[i].copy(e0).addScaledVector(ax, d.dot(ax)).addScaledVector(perp, k);
        }
      }
    }
    if (SMALL) {
      // A sheep's ears stick out sideways and droop: turn them about the
      // body axis from the donkey's upright, out to their own side.
      const out = Math.sign(e0.clone().sub(H).dot(right)) || 1;
      const tipC = V(); let nw = 0;
      for (let i = 0; i < WP.length; i++) {
        const w = wOf(i, (b) => /^Ear[34]/.test(b) && b.endsWith(sd));
        if (w > 0.5) { tipC.add(WP[i]); nw++; }
      }
      const axis0 = nw ? tipC.multiplyScalar(1 / nw).sub(e0).normalize() : UP.clone();
      // sheep: out and a little down; goat (Arbia): long ears hanging DOWN beside the face
      const target = GOAT
        ? right.clone().multiplyScalar(out * 0.5).addScaledVector(UP, -0.85).addScaledVector(fwd, 0.18).normalize()
        : right.clone().multiplyScalar(out).addScaledVector(UP, -0.3).addScaledVector(fwd, 0.15).normalize();
      const qEar = new THREE.Quaternion().setFromUnitVectors(axis0, target);
      const qi = new THREE.Quaternion();
      // Bend by DISTANCE along the ear (root still, then a smooth hinge),
      // not by skin weight: partly-head / partly-ear root vertices turned
      // part-way folded faces inside-out = see-through slits (measured).
      let earLen = 0;
      for (let i = 0; i < WP.length; i++) if (wOf(i, (b) => b.startsWith("Ear") && b.endsWith(sd)) > 0.5) earLen = Math.max(earLen, WP[i].clone().sub(e0).dot(axis0));
      for (let i = 0; i < WP.length; i++) {
        const ew = wOf(i, (b) => b.startsWith("Ear") && b.endsWith(sd));
        if (SHEEP) {
          // The sheep keeps the ears it was approved with (2026-09-27): the ear
          // geometry turned out sideways by its skin weight, slid out past the
          // wool collar. (The goat's bone turn laid them across its face.)
          if (ew > 0.05) {
            WP[i].sub(e0).applyQuaternion(qi.identity().slerp(qEar, Math.min(1, ew))).add(e0);
            WP[i].addScaledVector(target, 0.38 * A.Rv * P.wool * Math.min(1, ew));
          }
          continue;
        }
        const w = ew > 0.05 ? smoothstep01(0.08, 0.35, WP[i].clone().sub(e0).dot(axis0) / earLen) : 0;
        if (w > 0.001) WP[i].addScaledVector(right.clone().multiplyScalar(out), 0.07 * A.Rv * Math.min(1, w));   // clear the cheek
      }
    }
  }
  const neckJ = [W("Torso3"), W("Neck1"), W("Neck2"), W("Neck3"), W("Head"), W("Head").addScaledVector(a, 0.3 * A.Lh)];
  towardChain(neckJ.slice(0, 5), (b) => b.startsWith("Neck"), neckSlim);

  countFlips("slim+ears");
  // No mohawk. The donkey's mane is PART of the neck surface (dropping its
  // faces opens a hole), and the neck under it is a trough. So: keep the
  // mane faces, coat-coloured, and make every neck cross-section convex
  // on top — the upper half lies ON an ellipse through the neck's own
  // sides: trough vertices pushed out, mane-fin vertices pulled in.
  if (!HYENA && !DONKEY && !GAZELLE) {   // (the husky has no mane; the donkey keeps its own; the deer has none)
    const isMane = (i) => WM[i].has("Main_Dark")
      && wOf(i, (b) => b.startsWith("Neck") || b === "Head" || b === "Torso3") > 0.5
      && wOf(i, (b) => b.startsWith("Ear")) < 0.2;
    // The forelock is rigged to Ear1 / Head (never Ear2-4, which carry the
    // dark ear tips), so the ear test above misses it: its own classifier.
    const isForelock = (i) => WM[i].has("Main_Dark") && wOf(i, (b) => /^Ear[234]/.test(b)) < 0.5
      && wOf(i, (b) => b.startsWith("Neck")) < 0.5 && headW(i) > 0.5;
    for (const f of faces) if (fm(f) === "Main_Dark" && fv(f).every((i) => isMane(i) || isForelock(i))) f[f.length - 1] = "Main";
    const used = new Set();
    for (const f of faces) for (const i of fv(f)) used.add(i);
    const neckIds = [...used].filter((i) => wOf(i, (b) => b.startsWith("Neck") || b === "Torso3") > 0.4 && wOf(i, (b) => b === "Head" || b.startsWith("Ear")) < 0.3);
    const info = neckIds.map((i) => {
      const { c, s: sp, t } = nearest(neckJ, WP[i]);
      const up = UP.clone().addScaledVector(t, -UP.dot(t)).normalize(), sd = V().crossVectors(t, up);
      const d = WP[i].clone().sub(c);
      return { i, c, sp, r: d.length(), th: Math.atan2(d.dot(sd), d.dot(up)), mane: isMane(i) };
    });
    const span = 0.06 * A.Lh;
    const moves = [];
    for (const v of info) {
      if (v.mane || Math.abs(v.th) > 1.1) continue;              // upper half of the NECK (the fin is relaxed below)
      let rs = 0, n = 0;
      for (let sp = span; !n && sp < 4 * span; sp *= 2) {
        for (const o of info) if (!o.mane && Math.abs(o.sp - v.sp) < sp && Math.abs(Math.abs(o.th) - 1.5) < 0.35) { rs += o.r; n++; }
      }
      if (!n) continue;
      rs /= n;
      const rt = rs * 1.08;
      const th = v.mane ? Math.max(-1.1, Math.min(1.1, v.th)) : v.th;
      const want = 1 / Math.sqrt((Math.cos(th) / rt) ** 2 + (Math.sin(th) / rs) ** 2);
      if (v.mane || v.r < want) {
        // direction at the clamped angle, in the plane of this cross-section
        const d = WP[v.i].clone().sub(v.c);
        const { t } = nearest(neckJ, WP[v.i]);
        const up = UP.clone().addScaledVector(t, -UP.dot(t)).normalize(), sd = V().crossVectors(t, up);
        const along = d.dot(t);
        moves.push([v.i, v.c.clone().addScaledVector(t, along).addScaledVector(up, Math.cos(th) * want).addScaledVector(sd, Math.sin(th) * want)]);
      }
    }
    for (const [i, q] of moves) WP[i].copy(q);

    // The mane + forelock form a thin FIN (two sheets joined at a ridge).
    // Pressing single vertices left a pit and a blade. Instead: hold every
    // other vertex still and relax the fin's vertices to the mean of their
    // neighbours until they settle — the fin becomes a smooth bridge over
    // its own base, no folds.
    if (GOAT) {
      // (goat only: the sheep's forelock sits under its wool cap and was fine)
      // The forelock relaxed into a triangular peak between the ears. Cut
      // its faces and close the opening with a fan whose centre sits ON
      // the skull (the loop's mean, pulled toward the head joint).
      faces = faces.filter((f) => !fv(f).every(isForelock));
      const dir = new Map();
      for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) dir.set(`${vs[k]}>${vs[(k + 1) % vs.length]}`, [vs[k], vs[(k + 1) % vs.length]]); }
      const nxt = new Map();
      for (const [, [x, y]] of dir) if (!dir.has(`${y}>${x}`)) nxt.set(y, x);
      const seen = new Set();
      for (const st of nxt.keys()) {
        if (seen.has(st)) continue;
        const loop = [];
        for (let v = st; v !== undefined && !seen.has(v); v = nxt.get(v)) { seen.add(v); loop.push(v); }
        if (loop.length < 3 || loop.every((i) => headW(i) < 0.3)) continue;
        for (const i of loop) if (isForelock(i)) WP[i].lerp(H, 0.12);          // no rim ridge left standing
        const cen = V();
        for (const i of loop) cen.add(WP[i]);
        cen.multiplyScalar(1 / loop.length).lerp(H, 0.1);
        const ci = WP.length;
        WP.push(cen); WS.push([["Head", 1]]); WM.push(new Set(["Main"]));
        for (let k = 0; k < loop.length; k++) faces.push([loop[k], loop[(k + 1) % loop.length], ci, "Main"]);
      }
    }
    const fin = [...used].filter((i) => isMane(i) || (!GOAT && isForelock(i)));
    const finSet = new Set(fin), nb = new Map();
    for (const f of faces) {
      const vs = fv(f);
      for (let k = 0; k < vs.length; k++) {
        const x = vs[k], y = vs[(k + 1) % vs.length];
        if (finSet.has(x)) { if (!nb.has(x)) nb.set(x, new Set()); nb.get(x).add(y); }
        if (finSet.has(y)) { if (!nb.has(y)) nb.set(y, new Set()); nb.get(y).add(x); }
      }
    }
    const tmp = new Map();
    for (let it = 0; it < 200; it++) {
      for (const i of fin) {
        const ns = nb.get(i);
        if (!ns || !ns.size) continue;
        const m = V();
        for (const n of ns) m.add(WP[n]);
        tmp.set(i, m.multiplyScalar(1 / ns.size));
      }
      for (const [i, q] of tmp) WP[i].copy(q);
    }
    console.log(`[camel-morph] fin relaxed: ${fin.length} verts`);
  }

  countFlips("mane");
  // Chest fold (camel): the neck base is bent ~55° down; the band of
  // vertices blended between Torso3 and Neck1 collapses into a crease.
  // Relax just that band toward its neighbours' mean (others hold).
  const creaseAt = (pred) => {
    const nrm = (f) => { const vs = fv(f), L = vs.length, n = V(); for (let k = 0; k < L; k++) { const p0 = WP[vs[k]], p1 = WP[vs[(k + 1) % L]]; n.x += (p0.y - p1.y) * (p0.z + p1.z); n.y += (p0.z - p1.z) * (p0.x + p1.x); n.z += (p0.x - p1.x) * (p0.y + p1.y); } return n.normalize(); };
    const byE = new Map();
    faces.forEach((f, fi) => { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length], key = x < y ? `${x}_${y}` : `${y}_${x}`; (byE.get(key) ?? byE.set(key, []).get(key)).push(fi); } });
    let worst = 0, sharp = 0;
    for (const [key, l] of byE) {
      if (l.length !== 2) continue;
      const [x, y] = key.split("_").map(Number);
      if (!pred(x) || !pred(y)) continue;
      const ang = (Math.acos(Math.max(-1, Math.min(1, nrm(faces[l[0]]).dot(nrm(faces[l[1]]))))) * 180) / Math.PI;
      worst = Math.max(worst, ang);
      if (ang > 60) sharp++;
    }
    return { worstDeg: Math.round(worst), edgesOver60: sharp };
  };
  const chestPred = (i) => wOf(i, (b) => b === "Torso3" || b === "Neck1") > 0.5;
  if (CAMEL) console.log("[camel-morph] chest crease before relax", JSON.stringify(creaseAt(chestPred)));
  if (CAMEL) {
    const band = new Set();
    for (let i = 0; i < WP.length; i++) {
      const t3 = wOf(i, (b) => b === "Torso3"), n1 = wOf(i, (b) => b === "Neck1" || b === "Neck2");
      if (t3 > 0.12 && n1 > 0.12) band.add(i);
    }
    const nb = new Map();
    for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; if (band.has(x)) (nb.get(x) ?? nb.set(x, []).get(x)).push(y); if (band.has(y)) (nb.get(y) ?? nb.set(y, []).get(y)).push(x); } }
    for (let it = 0; it < 8; it++) {
      const upd = [];
      for (const i of band) { const ns = nb.get(i); if (!ns) continue; const m = V(); for (const j of ns) m.add(WP[j]); upd.push([i, m.multiplyScalar(1 / ns.length)]); }
      for (const [i, m] of upd) WP[i].lerp(m, 0.6);
    }
    console.log(`[camel-morph] chest band relaxed: ${band.size} verts`);
    const cr = creaseAt(chestPred);
    console.log("[camel-morph] chest crease after relax", JSON.stringify(cr));
    window.__chest = cr;
  }

  // Camel feet instead of hooves, GROWN FROM THE LEG: drop the hoof faces,
  // find the open rim each leaves (a loop of the leg's own vertices), and
  // extrude that loop down and out — ring by ring — into a broad two-toed
  // cushion, closed by a sole fan. Connected to the leg, so no pinch and no
  // open edges (the old separate pad left 64).
  if (CAMEL) {
    // where each hoof's BOTTOM was (the pad reaches down to there)
    const hoofLo = {};
    for (const f of faces) if (fm(f) === "Hooves") for (const i of fv(f)) {
      const leg = footToLeg(WS[i]).reduce((m, e) => (e[1] > m[1] ? e : m), ["", 0])[0];
      hoofLo[leg] = Math.min(hoofLo[leg] ?? Infinity, WP[i].y);
    }
    faces = faces.filter((f) => fm(f) !== "Hooves");
    const dir = new Map();
    for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) dir.set(`${vs[k]}>${vs[(k + 1) % vs.length]}`, [vs[k], vs[(k + 1) % vs.length]]); }
    const next = new Map();
    for (const [, [x, y]] of dir) if (!dir.has(`${y}>${x}`)) next.set(y, x);   // walked so a new face (rim[k], rim[k+1], ...) closes it
    const seen = new Set();
    let pads = 0;
    for (const start of next.keys()) {
      if (seen.has(start)) continue;
      const rim = [];
      for (let v = start; v !== undefined && !seen.has(v); v = next.get(v)) { seen.add(v); rim.push(v); }
      if (rim.length < 3) continue;
      // the leg, counting its foot bones as part of it (the hooves ride on IK/FF bones)
      const legOf = (i, b) => footToLeg(WS[i]).reduce((s0, [x, w]) => s0 + (x === b ? w : 0), 0);
      const foot = ["FrontLowerLegL", "FrontLowerLegR", "BackLowerLegL", "BackLowerLegR"]
        .find((b) => rim.reduce((s0, i) => s0 + legOf(i, b), 0) / rim.length > 0.5);
      if (!foot) continue;
      const c = V();
      for (const i of rim) c.add(WP[i]);
      c.multiplyScalar(1 / rim.length);
      const rimLo = Math.min(...rim.map((i) => WP[i].y));
      // a THICK cushion: down past where the hoof bottom was (the ground clamp lifts the camel onto it)
      const lo = Math.min(hoofLo[foot] ?? rimLo - 0.05 * A.Rv, rimLo - 0.05 * A.Rv) - 0.07 * A.Rv;
      // skinned like the rim it grows from, so the pad FLEXES with the hoof
      const acc = new Map();
      for (const i of rim) for (const [b, w] of WS[i]) acc.set(b, (acc.get(b) ?? 0) + w / rim.length);
      const skin = [...acc];
      // profile: [height above sole (× Rv), radius (× Rv) fore, sideways, toe notch]
      const Hp2 = (rimLo - lo) / A.Rv;                         // pad height, in Rv
      const prof = [
        [0.85 * Hp2, 0.15, 0.13, 1],   // the leg starts to widen
        [0.6 * Hp2, 0.24, 0.2, 0.92],  // swelling
        [0.32 * Hp2, 0.29, 0.245, 0.86], // widest
        [0.1 * Hp2, 0.28, 0.235, 0.82],  // rounding under
        [0.0, 0.22, 0.18, 0.8],          // sole, bevelled in: a cushion, not a plate
      ];
      const at = (i) => {           // rim vertex's direction round the leg (horizontal)
        const d = WP[i].clone().sub(c); d.y = 0;
        return d.lengthSq() > 1e-12 ? d.normalize() : fwd.clone();
      };
      const ctr = V(c.x, lo, c.z).addScaledVector(fwd, 0.03 * A.Rv);
      let prev = rim;
      const padStart = faces.length;
      prof.forEach(([h, rf, rs, toe], ri) => {
        const ring = rim.map((i) => {
          const d = at(i), cf = d.dot(fwd), cs = d.dot(right);
          const notch = cf > 0.92 ? toe : 1;                  // the cleft between the toes, at the front
          const q = V(ctr.x, lo + h * A.Rv, ctr.z)
            .addScaledVector(fwd, cf * rf * A.Rv * notch)
            .addScaledVector(right, cs * rs * A.Rv);
          const id = WP.length;
          WP.push(q); WS.push(skin); WM.push(new Set(["Pad"]));
          return id;
        });
        const mt = ri === prof.length - 1 ? "Sole" : "Main";
        for (let k = 0; k < rim.length; k++) {
          const k1 = (k + 1) % rim.length;
          faces.push([prev[k], prev[k1], ring[k1], ring[k], mt]);
        }
        prev = ring;
      });
      const sc = WP.length;
      WP.push(ctr.clone()); WS.push(skin); WM.push(new Set(["Pad"]));
      for (let k = 0; k < rim.length; k++) faces.push([prev[k], prev[(k + 1) % rim.length], sc, "Sole"]);
      // The rim loop can run either way round: the sole must face DOWN,
      // else the whole pad is inside-out (culled → the leg ends in a stump).
      {
        const f = faces[faces.length - 1], a0 = WP[f[0]], a1 = WP[f[1]], a2 = WP[f[2]];
        const ny = a1.clone().sub(a0).cross(a2.clone().sub(a0)).y;
        if (ny > 0) for (let k = padStart; k < faces.length; k++) { const vs = fv(faces[k]).reverse(); faces[k] = [...vs, fm(faces[k])]; }
      }
      pads++;
    }
    console.log(`[camel-morph] pads grown from ${pads} leg rims`);
  }

  // 2c. The hump — mid-back, rump low. Loops first, then the lift.
  const Lb = W("Torso3").sub(W("Back")).setY(0).length();
  const hc = W("Torso2").lerp(W("Torso3"), 0.12);
  const cy = W("Torso2").y + A.cyOff;
  const halfLen = 0.46 * Lb * Q.humpLen, Hh = 0.72 * A.Rv * Q.hump, halfW = 1.7 * A.Rside;
  const humpU = (p) => (p.clone().sub(hc).dot(fwd)) / halfLen;
  const humpV = (p) => (p.clone().sub(hc).dot(right)) / halfW;
  const topW = (p) => smoothstep01(cy - 0.35 * A.Rv, cy + 0.75 * A.Rv, p.y);
  const humpAt = (p) => {
    const u = humpU(p), s = humpV(p);
    if (Math.abs(u) >= 1 || Math.abs(s) >= 1) return 0;
    // dome: rounded crown lengthwise, broad across
    return Hh * (1 - u * u) ** 0.75 * (1 - s * s) ** 0.9 * topW(p);
  };
  // Loop cuts, the modeller's way: a new ring of quads round the body,
  // on a plane across the spine. Start at the lengthwise edge on top of
  // the back that crosses the plane, walk the edge ring both ways
  // (quad → its opposite edge → the next quad), split every quad it
  // crosses in two. The ring stops where the plane no longer crosses
  // (or at a triangle); only there does a triangle appear.
  const ek = (x, y) => (x < y ? `${x}_${y}` : `${y}_${x}`);
  const mixSkinT = (s1, s2, t) => {
    const m = new Map();
    for (const [b, w] of s1) m.set(b, (m.get(b) ?? 0) + w * (1 - t));
    for (const [b, w] of s2) m.set(b, (m.get(b) ?? 0) + w * t);
    return [...m];
  };
  const loopCut = (sPlane) => {
    const side = (i) => WP[i].dot(fwd) - sPlane;
    const EF = new Map();
    faces.forEach((f, fi) => {
      const vs = fv(f);
      for (let k = 0; k < vs.length; k++) {
        const e = ek(vs[k], vs[(k + 1) % vs.length]);
        if (!EF.has(e)) EF.set(e, []);
        EF.get(e).push(fi);
      }
    });
    let seed = null, best = -Infinity;
    for (const [e, fl] of EF) {
      if (fl.length !== 2 || !fl.every((fi) => faces[fi].length === 5)) continue;
      const [x, y] = e.split("_").map(Number);
      if (side(x) * side(y) >= 0) continue;
      const mid = WP[x].clone().lerp(WP[y], 0.5);
      const score = mid.y - 3 * Math.abs(mid.clone().sub(hc).dot(right));
      if (score > best) { best = score; seed = [x, y]; }
    }
    if (!seed) return 0;
    const split = new Map();                        // face → split edge keys
    const walk = (x, y, enterNot) => {
      let prev = enterNot;
      for (let step = 0; step < 400; step++) {
        const fi = (EF.get(ek(x, y)) ?? []).find((f) => f !== prev);
        if (fi === undefined || split.has(fi)) return;
        const vs = fv(faces[fi]);
        if (vs.length !== 4) { split.set(fi, [ek(x, y)]); return; }
        const [ox, oy] = vs.filter((v) => v !== x && v !== y);
        // the opposite edge, oriented like (x, y): ox is x's neighbour
        const xi = vs.indexOf(x), nx = vs[(xi + 1) % 4] === y ? vs[(xi + 3) % 4] : vs[(xi + 1) % 4];
        const nyv = nx === ox ? oy : ox;
        if (side(nx) * side(nyv) >= 0) { split.set(fi, [ek(x, y)]); return; }
        split.set(fi, [ek(x, y), ek(nx, nyv)]);
        prev = fi; x = nx; y = nyv;
      }
    };
    const f0 = EF.get(ek(...seed));
    walk(seed[0], seed[1], f0[1]);
    walk(seed[0], seed[1], f0[0]);
    const made = new Map();
    const cutV = (x, y) => {
      const k = ek(x, y);
      if (made.has(k)) return made.get(k);
      const sx = side(x), sy = side(y);
      let t = Math.abs(sx - sy) > 1e-9 ? sx / (sx - sy) : 0.5;
      t = Math.min(0.85, Math.max(0.15, t));
      const id = WP.length;
      WP.push(WP[x].clone().lerp(WP[y], t)); WS.push(mixSkinT(WS[x], WS[y], t));
      WM.push(new Set([...WM[x]].filter((q) => WM[y].has(q))));
      made.set(k, id);
      return id;
    };
    const out = [];
    faces.forEach((f, fi) => {
      const sp = split.get(fi);
      if (!sp) { out.push(f); return; }
      let q = fv(f);
      const mt = fm(f), L = q.length;
      // rotate so the (first) split edge is q0-q1
      for (let r = 0; r < L && !sp.includes(ek(q[0], q[1])); r++) q = [...q.slice(1), q[0]];
      const m1 = cutV(q[0], q[1]);
      if (L === 4 && sp.length === 2 && sp.includes(ek(q[2], q[3]))) {
        const m2 = cutV(q[2], q[3]);
        out.push([q[0], m1, m2, q[3], mt], [m1, q[1], q[2], m2, mt]);
      } else if (L === 4) {
        out.push([q[0], m1, q[3], mt], [m1, q[1], q[2], q[3], mt]);   // ring ends here
      } else {
        out.push([q[0], m1, q[2], mt], [m1, q[1], q[2], mt]);
      }
    });
    faces = out;
    return split.size;
  };
  // PLANE SLICE: split every face the plane (normal nP, offset d) crosses,
  // one shared new vertex per crossed edge (the mesh stays closed); a bent
  // polygon is cut as triangles. Markings then follow straight clean edges.
  const planeSlice = (nP, d) => {
    const side = (i) => WP[i].dot(nP) - d;
    const made = new Map();
    const cutV = (x, y) => {
      const k = ek(x, y);
      if (made.has(k)) return made.get(k);
      const sx = side(x), sy = side(y);
      const t = Math.min(0.95, Math.max(0.05, sx / (sx - sy)));
      const id = WP.length;
      WP.push(WP[x].clone().lerp(WP[y], t)); WS.push(mixSkinT(WS[x], WS[y], t));
      WM.push(new Set([...WM[x]].filter((q) => WM[y].has(q))));
      made.set(k, id);
      return id;
    };
    const cutPoly = (vs, mt, out) => {
      const L = vs.length, sg = vs.map((i) => side(i) >= 0);
      let nx = 0; for (let k = 0; k < L; k++) if (sg[k] !== sg[(k + 1) % L]) nx++;
      if (nx === 0) { out.push([...vs, mt]); return; }
      if (nx > 2) { for (let k = 1; k < L - 1; k++) cutPoly([vs[0], vs[k], vs[k + 1]], mt, out); return; }   // bent: as triangles
      const A0 = [], A1 = [];
      for (let k = 0; k < L; k++) {
        const x = vs[k], y = vs[(k + 1) % L];
        (sg[k] ? A0 : A1).push(x);
        if (sg[k] !== sg[(k + 1) % L]) { const m = cutV(x, y); A0.push(m); A1.push(m); }
      }
      if (A0.length >= 3) out.push([...A0, mt]);
      if (A1.length >= 3) out.push([...A1, mt]);
    };
    const out = [];
    let n = 0;
    for (const f of faces) { const before = out.length; cutPoly(fv(f), fm(f), out); if (out.length - before > 1) n++; }
    faces = out;
    return n;
  };
  const s0 = hc.dot(fwd);
  // Sheep wool: which vertices it covers (body, neck, thighs, tail — not
  // the head, not below the knees).
  let LmS = 0;
  for (let i = 0; i < WP.length; i++) if (headW(i) > 0.5) LmS = Math.max(LmS, WP[i].clone().sub(H).dot(a));
  const headZ = (i) => WP[i].clone().sub(H).dot(a) / LmS;           // 0 at the poll, 1 at the nose
  const woolW = (i) => Math.min(1,
    wOf(i, (b) => b === "Body" || b === "Back" || b.startsWith("Torso"))
    + 0.95 * wOf(i, (b) => b.startsWith("Neck"))
    + 0.85 * wOf(i, (b) => /^(BackShoulder|BackLeg[LR]|FrontShoulder)/.test(b))
    + 0.2 * wOf(i, (b) => /^FrontUpperLeg/.test(b))
    + 1.0 * wOf(i, (b) => b.startsWith("Tail"))   // the tail rides out with the rump wool
    // the back of the head, and the forelock (rigged to Ear1 only) — not the ears (Ear2-4)
    + (SHEEP ? (wOf(i, (b) => b === "Head") + (wOf(i, (b) => /^Ear[234]/.test(b)) < 0.1 ? wOf(i, (b) => /^Ear1/.test(b)) : 0))
      * (1 - smoothstep01(0.02, 0.2, headZ(i))) : 0));
  let lift;
  const hyBands = [];                    // hyena: the stripe bands [plane normal, d0, d1]
  const dkStripe = {};                   // donkey: where its stripe / cross were sliced
  const dkLoad = {};                     // donkey: the blanket's cuts
  const gzBand = {};                     // gazelle: the flank band's two heights
  if (SHEEP) {
    // Loop cuts along the torso for square wool facets, a stub tail, then
    // the wool: every covered vertex pushed out from the spine / neck
    // chain, with a per-vertex jitter so the facets vary like the
    // reference's patchwork of whites.
    const sB = W("Back").dot(fwd), sF = W("Torso3").dot(fwd);
    const rings = [0.1, 0.35, 0.6, 0.85].map((u) => loopCut(sB + (sF - sB) * u));
    console.log(`[sheep-morph] wool loop cuts: ${rings.join(", ")} quads per ring`);
    // Tail: the donkey's long tail + tuft (Tail2-7, ~320 verts) sat BEHIND
    // the wool surface once the rump was woolled (measured). A sheep's
    // tail is a short woolly nub: drop those faces, close each opening
    // with a fan to a centre pushed out and down a little — the nub. It
    // is skinned to Tail1, so it still twitches.
    {
      const tailW = (i) => wOf(i, (b) => /^Tail[2-7]$/.test(b));
      const drop = (f) => fv(f).reduce((sum, i) => sum + tailW(i), 0) / fv(f).length > 0.5;
      faces = faces.filter((f) => !drop(f));
      const dir = new Map();                           // directed edges of what remains
      for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) dir.set(`${vs[k]}>${vs[(k + 1) % vs.length]}`, [vs[k], vs[(k + 1) % vs.length]]); }
      const next = new Map();
      for (const [, [x, y]] of dir) if (!dir.has(`${y}>${x}`)) next.set(y, x);   // boundary, walked backwards = the cap's winding
      const seen = new Set();
      let caps = 0;
      for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const loop = [];
        let v = start;
        while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = next.get(v); }
        if (loop.length < 3) continue;
        const cen = V();
        for (const i of loop) cen.add(WP[i]);
        cen.multiplyScalar(1 / loop.length).addScaledVector(fwd, -0.18 * A.Rv).addScaledVector(UP, -0.06 * A.Rv);
        const ci = WP.length;
        WP.push(cen); WS.push([["Tail1", 1]]); WM.push(new Set(["Main"]));
        for (let k = 0; k < loop.length; k++) faces.push([loop[k], loop[(k + 1) % loop.length], ci, "Main"]);
        caps++;
      }
      console.log(`[sheep-morph] tail: donkey tail removed, ${caps} cap(s)`);
    }
    const Lbs = W("Torso3").sub(W("Back")).setY(0).length();
    const bodyJ = [W("Back").addScaledVector(fwd, -0.2 * Lbs), W("Torso"), W("Torso2"), W("Torso3"), W("Neck1"), W("Neck2"), W("Neck3")];
    const T = 0.42 * A.Rv * P.wool;
    const used = new Set();
    for (const f of faces) for (const i of fv(f)) used.add(i);
    const moves = [];
    for (const i of used) {
      const w = woolW(i);
      if (w < 0.05) continue;
      const { c } = nearest(bodyJ, WP[i]);
      const d = WP[i].clone().sub(c), r = d.length();
      if (r < 1e-6) continue;
      const jit = 1 + (hash(i) - 0.5) * 0.3 * P.lumps;
      moves.push([i, d.multiplyScalar(T * w * jit / r)]);                // displacement, not position
    }
    // Neighbours that picked different spine segments push in different
    // directions and fold the surface: relax the displacement field over
    // the mesh first (unwooled vertices hold 0, so the wool edge tapers).
    const disp = new Map(moves);
    const adj = new Map();
    for (const f of faces) {
      const vs = fv(f);
      for (let k = 0; k < vs.length; k++) {
        const x = vs[k], y = vs[(k + 1) % vs.length];
        if (!adj.has(x)) adj.set(x, []);
        if (!adj.has(y)) adj.set(y, []);
        adj.get(x).push(y); adj.get(y).push(x);
      }
    }
    for (let it = 0; it < 6; it++) {
      const next = new Map();
      for (const [i, dv] of disp) {
        const m = dv.clone();
        let n = 1;
        for (const j of adj.get(i) ?? []) { const dj = disp.get(j); if (dj) m.add(dj); n++; }
        next.set(i, m.multiplyScalar(1 / n));
      }
      for (const [i, dv] of next) disp.set(i, dv);
    }
    for (const [i, dv] of disp) WP[i].add(dv);
    // Wool cap: the top and back of the skull, behind the eyes.
    let Lm = 0;
    for (let i = 0; i < WP.length; i++) if (headW(i) > 0.5) Lm = Math.max(Lm, WP[i].clone().sub(H).dot(a));
    const skullC = H.clone().addScaledVector(a, 0.22 * Lm);
    for (const i of used) {
      if (headW(i) < 0.5 || wOf(i, (b) => b.startsWith("Ear")) > 0.2) continue;
      const d = WP[i].clone().sub(H);
      const z = d.dot(a) / Lm, y = d.dot(hu) / Lm;
      const k = smoothstep01(0.08, 0.18, y) * (1 - smoothstep01(0.12, 0.24, z));
      if (k <= 0.05) continue;
      const dir = WP[i].clone().sub(skullC).normalize();
      WP[i].addScaledVector(dir, T * 0.35 * k * (1 + (hash(i) - 0.5) * 0.3));
      if (k > 0.5) capSet.add(i);
    }
    lift = WP.map(() => 0);
  } else if (GOAT) {
    // GOAT (North African / Arbia type): slim body, the donkey's tail
    // swapped for a short upturned one, scimitar horns swept back, a beard.
    // Horns and beard are new quads/tris on the Head bone; the mesh stays closed.
    const replaceTail = (back, up) => {
      const tailW = (i) => wOf(i, (b) => /^Tail[2-7]$/.test(b));
      const drop = (f) => fv(f).reduce((sum, i) => sum + tailW(i), 0) / fv(f).length > 0.5;
      faces = faces.filter((f) => !drop(f));
      const dir = new Map();
      for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) dir.set(`${vs[k]}>${vs[(k + 1) % vs.length]}`, [vs[k], vs[(k + 1) % vs.length]]); }
      const next = new Map();
      for (const [, [x, y]] of dir) if (!dir.has(`${y}>${x}`)) next.set(y, x);
      const seen = new Set();
      for (const start of next.keys()) {
        if (seen.has(start)) continue;
        const loop = [];
        for (let v = start; v !== undefined && !seen.has(v); v = next.get(v)) { seen.add(v); loop.push(v); }
        if (loop.length < 3) continue;
        const cen = V();
        for (const i of loop) cen.add(WP[i]);
        cen.multiplyScalar(1 / loop.length).addScaledVector(fwd, -back * A.Rv).addScaledVector(UP, up * A.Rv);
        const ci = WP.length;
        WP.push(cen); WS.push([["Tail1", 1]]); WM.push(new Set(["Main_Dark"]));
        for (let k = 0; k < loop.length; k++) faces.push([loop[k], loop[(k + 1) % loop.length], ci, "Main_Dark"]);
      }
    };
    replaceTail(0.3, 0.22);                 // a goat's tail flicks UP
    // Slimmer barrel than the donkey (goats are narrow and bony).
    const Lbg = W("Torso3").sub(W("Back")).setY(0).length();
    const spineJ = [W("Back").addScaledVector(fwd, -0.2 * Lbg), W("Torso"), W("Torso2"), W("Torso3")];
    towardChain(spineJ, (b) => b === "Back" || b.startsWith("Torso") || b === "Body", PG.girth);

    // Head frame measurements: the skull top and width behind the eyes.
    let topY = -Infinity, maxX = 0;
    for (let i = 0; i < WP.length; i++) {
      if (headW(i) < 0.5 || wOf(i, (b) => b.startsWith("Ear")) > 0.2) continue;
      const z = headZ(i);
      if (z < 0.08 || z > 0.4) continue;
      const d = WP[i].clone().sub(H);
      topY = Math.max(topY, d.dot(hu) / LmS);
      maxX = Math.max(maxX, Math.abs(d.dot(hs)) / LmS);
    }
    const Hp = (x, y, z) => H.clone().addScaledVector(hs, x * LmS).addScaledVector(hu, y * LmS).addScaledVector(a, z * LmS);
    const headSkin = [["Head", 1]];
    const addV = (p, mt) => { WP.push(p); WS.push(headSkin); WM.push(new Set([mt])); return WP.length - 1; };
    // Horns: a tube along a curve that rises from the poll and sweeps back
    // over the neck, diverging a little, tapering to a point.
    const SIDES = 6, RINGS = 8, L = PG.horn;
    for (const sx of [-1, 1]) {
      // skull surface right under this horn's base
      const bx = sx * 0.34 * maxX, bz = 0.2;
      let surf = -Infinity;
      for (let rad = 0.06; surf === -Infinity && rad < 0.5; rad *= 1.5) {
        for (let i = 0; i < WP.length; i++) {
          if (headW(i) < 0.5 || wOf(i, (b) => b.startsWith("Ear")) > 0.2) continue;
          const d = WP[i].clone().sub(H), x = d.dot(hs) / LmS, z = d.dot(a) / LmS;
          if (Math.hypot(x - bx, z - bz) < rad) surf = Math.max(surf, d.dot(hu) / LmS);
        }
      }
      const baseY = (surf === -Infinity ? topY : surf) - 0.035;       // a little INTO the skull
      const pts = [];
      for (let r = 0; r <= RINGS; r++) {
        const u = r / RINGS, th = u * Math.PI * 0.62;
        pts.push(Hp(bx + sx * 0.14 * L * u, baseY + 0.52 * L * Math.sin(th), bz - 0.95 * L * (1 - Math.cos(th)) - 0.2 * L * u));
      }
      const rings = [];
      for (let r = 0; r < RINGS; r++) {
        const u = r / RINGS, rad = (0.075 - 0.058 * u) * LmS;
        const T = pts[r + 1].clone().sub(pts[Math.max(0, r - 1)]).normalize();
        const N1 = V().crossVectors(T, hs).normalize(), N2 = V().crossVectors(T, N1).normalize();
        const ring = [];
        for (let k = 0; k < SIDES; k++) {
          const an = (k / SIDES) * Math.PI * 2;
          ring.push(addV(pts[r].clone().addScaledVector(N1, Math.cos(an) * rad).addScaledVector(N2, Math.sin(an) * rad), r % 2 ? "Horn" : "Horn2"));
        }
        rings.push(ring);
      }
      const tip = addV(pts[RINGS].clone(), "Horn");
      // base: sink it into the skull and close it underneath
      const base = addV(pts[0].clone().addScaledVector(hu, -0.06 * LmS), "Horn");
      for (let k = 0; k < SIDES; k++) faces.push([rings[0][(k + 1) % SIDES], rings[0][k], base, "Horn"]);
      for (let r = 0; r < RINGS - 1; r++) for (let k = 0; k < SIDES; k++) {
        const k1 = (k + 1) % SIDES;
        faces.push([rings[r][k], rings[r][k1], rings[r + 1][k1], rings[r + 1][k], r % 2 ? "Horn" : "Horn2"]);
      }
      for (let k = 0; k < SIDES; k++) faces.push([rings[RINGS - 1][k], rings[RINGS - 1][(k + 1) % SIDES], tip, "Horn"]);
    }
    // Beard: a small closed pyramid hanging from the chin.
    {
      let chin = null, best = Infinity;
      for (let i = 0; i < WP.length; i++) {
        if (headW(i) < 0.5) continue;
        const z = headZ(i);
        if (z < 0.6 || z > 0.85) continue;
        const y = WP[i].clone().sub(H).dot(hu);
        if (y < best) { best = y; chin = WP[i].clone(); }
      }
      if (chin) {
        const c0 = chin.addScaledVector(hu, 0.02 * LmS);
        const w = 0.06 * LmS, len = 0.32 * LmS * PG.beard;
        const q = [addV(c0.clone().addScaledVector(hs, w).addScaledVector(a, w), "Beard"), addV(c0.clone().addScaledVector(hs, -w).addScaledVector(a, w), "Beard"),
          addV(c0.clone().addScaledVector(hs, -w).addScaledVector(a, -w), "Beard"), addV(c0.clone().addScaledVector(hs, w).addScaledVector(a, -w), "Beard")];
        const tip = addV(c0.clone().addScaledVector(UP, -len).addScaledVector(a, 0.04 * LmS), "Beard");
        faces.push([q[3], q[2], q[1], q[0], "Beard"]);
        for (let k = 0; k < 4; k++) faces.push([q[k], q[(k + 1) % 4], tip, "Beard"]);
      }
    }
    console.log("[goat-morph] tail, horns, beard added");
    lift = WP.map(() => 0);
  } else if (PIG) {
    // PIG: a fat barrel (out from the spine), a POT BELLY sagging between the
    // legs, a slight swayback — one displacement field, smoothed over the mesh
    // before it is applied (as the wool: neighbours on different spine segments
    // must not pull apart). Then the snout: its end flattened into a disc.
    const sB = W("Back").dot(fwd), sF = W("Torso3").dot(fwd);
    const rings = [0.25, 0.5, 0.75].map((u) => loopCut(sB + (sF - sB) * u));
    const Lbp = W("Torso3").sub(W("Back")).setY(0).length();
    const spine = [W("Back").addScaledVector(fwd, -0.15 * Lbp), W("Torso"), W("Torso2"), W("Torso3")];
    const bodyW = (i) => Math.min(1, wOf(i, (b) => b === "Body" || b === "Back" || b.startsWith("Torso"))
      + 0.6 * wOf(i, (b) => /^(BackShoulder|BackLeg[LR]|FrontShoulder)/.test(b)) + 0.35 * wOf(i, (b) => b === "Neck1"));
    const used = new Set();
    for (const f of faces) for (const i of fv(f)) used.add(i);
    const disp = new Map();
    for (const i of used) {
      const w = bodyW(i);
      if (w < 0.05) continue;
      const { c, s: sp } = nearest(spine, WP[i]);
      const d = WP[i].clone().sub(c), r = d.length();
      if (r < 1e-6) continue;
      const dir = d.clone().multiplyScalar(1 / r);
      const mid = Math.sin(Math.PI * Math.min(1, Math.max(0, sp / (Lbp * 1.15))));   // 0 at the ends, 1 mid-body
      const v = dir.multiplyScalar((PQ.girth - 1) * r * w);
      if (dir.y < 0) v.y -= 0.2 * A.Rv * PQ.belly * w * mid * Math.min(1, -dir.y * 1.6);   // the belly sags
      if (dir.y > 0.3) v.y -= PQ.sway * A.Rv * w * mid;                                           // swayback
      disp.set(i, v);
    }
    const adj = new Map();
    for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (adj.get(x) ?? adj.set(x, []).get(x)).push(y); (adj.get(y) ?? adj.set(y, []).get(y)).push(x); } }
    for (let it = 0; it < 6; it++) {
      const next = new Map();
      for (const [i, dv] of disp) { const m = dv.clone(); let n = 1; for (const j of adj.get(i) ?? []) { const dj = disp.get(j); if (dj) m.add(dj); n++; } next.set(i, m.multiplyScalar(1 / n)); }
      for (const [i, dv] of next) disp.set(i, dv);
    }
    for (const [i, dv] of disp) WP[i].add(dv);
    if (PIG2 && PQ.flatBack) {
      // pig2: a LEVEL back — the donkey's withers stand above the line from the
      // rump to the neck; nothing on the back may rise above the mid-back height
      // (measured per vertex), so the back is one long straight line.
      let midTop = -Infinity;
      const s2 = W("Torso2").dot(fwd);
      for (const i of used) if (bodyW(i) > 0.5 && Math.abs(WP[i].dot(fwd) - s2) < 0.25 * Lbp) midTop = Math.max(midTop, WP[i].y);
      for (const i of used) {
        const w = Math.min(1, bodyW(i) + wOf(i, (b) => b === "Neck1"));
        if (w < 0.2 || WP[i].y <= midTop) continue;
        WP[i].y = midTop + (WP[i].y - midTop) * (1 - w);
      }
    }
    // The head as a pig's WEDGE (head space: z along the muzzle 0..1, y up,
    // x across): heavy jowls low at the back, a shallow jaw, the muzzle
    // tapering straight down to the snout; the snout's end cut flat into a
    // disc with a slight rim.
    const headIds = [...used].filter((i) => headW(i) > 0.5 && wOf(i, (b) => b.startsWith("Ear")) < 0.2);
    const yAxis = (() => { let lo = Infinity, hi = -Infinity; for (const i of headIds) { const y = WP[i].clone().sub(H).dot(hu) / LmS; lo = Math.min(lo, y); hi = Math.max(hi, y); } return (lo + hi) / 2; })();
    const wedge = (p0, w) => {
      const d = p0.clone().sub(H);
      let z = d.dot(a) / LmS, y = d.dot(hu) / LmS, x = d.dot(hs) / LmS;
      if (y < yAxis) y += (yAxis - y) * PQ.jawLift * smoothstep01(0.25, 0.6, z) * w;   // shallower jaw
      const jowl = (1 - smoothstep01(0.2, 0.45, z)) * smoothstep01(0.0, 0.08, yAxis - y);
      x *= 1 + PQ.jowl * jowl * w;                                                     // jowls, low at the back
      // pig2: wide LOW (cheeks, jowls), narrower up at the eyes — a uniformly
      // wide head set the eyes too far apart. (pig: upperWide = headWide = 1.)
      const low = smoothstep01(-0.02, 0.12, yAxis - y);
      x *= 1 + ((PQ.upperWide ?? PQ.headWide) + (PQ.headWide - (PQ.upperWide ?? PQ.headWide)) * low - 1) * w;
      const taper = smoothstep01(0.4, 0.85, z);
      x *= 1 - PQ.taper * taper * w;                                                   // the wedge narrows to the snout
      y = yAxis + (y - yAxis) * (1 - PQ.taperY * taper * w);
      if (z > 0.78) {                                                                  // the disc
        const t = smoothstep01(0.78, 0.9, z);
        const rim = 1 + PQ.rim * t;
        x *= rim; y = yAxis + (y - yAxis) * (1 + (PQ.rimY ?? 0.1) * t);
        z = Math.min(z, 0.9);
      }
      return H.clone().addScaledVector(a, z * LmS).addScaledVector(hu, y * LmS).addScaledVector(hs, x * LmS);
    };
    // pig2: each eye and the ring of faces round it move as ONE piece (the
    // eye centre's own shift) — the jowl's steep ramp crossed the eye and
    // folded its small faces into see-through slits (measured at both eyes).
    const eyeOf = new Map(), eyeC = [];
    if (PIG2) {
      const eyeV = new Set();
      for (const f of faces) if (fm(f) === "Eye_Dark" || fm(f) === "Eye_White") for (const i of fv(f)) eyeV.add(i);
      for (const sgn of [-1, 1]) {
        const ids = [...eyeV].filter((i) => Math.sign(WP[i].clone().sub(H).dot(hs)) === sgn);
        if (!ids.length) continue;
        const c = V(); for (const i of ids) c.add(WP[i]); c.multiplyScalar(1 / ids.length);
        let r = 0; for (const i of ids) r = Math.max(r, WP[i].distanceTo(c));
        eyeC.push({ sgn, c0: c.clone(), c1: wedge(c, 1), r });
      }
      // how much each vertex moves WITH its eye: 1 on the eye and just round
      // it, fading to 0 over a band (a hard edge tore a slit above the eye)
      for (const i of headIds) {
        const sgn = Math.sign(WP[i].clone().sub(H).dot(hs));
        const e = eyeC.find((q) => q.sgn === sgn);
        if (!e) continue;
        const k = 1 - smoothstep01(e.r * 1.6, e.r * 3.4, WP[i].distanceTo(e.c0));
        if (k > 0) eyeOf.set(i, { e, k });
      }
    }
    const newPos = new Map();
    for (const i of headIds) {
      const face = wedge(WP[i], Math.min(1, headW(i)));
      const q = eyeOf.get(i);
      newPos.set(i, q ? WP[i].clone().add(q.e.c1.clone().sub(q.e.c0)).lerp(face, 1 - q.k) : face);
    }
    for (const [i, q] of newPos) WP[i].copy(q);
    if (PIG2) {
      // FACE VOLUME (your black-pig references): a domed forehead, a brow
      // bulge over each eye, full cheeks under it, the snout pushed out into a
      // short cylinder. Smooth bumps in head space; the eyes ride with them.
      const bump = (p, c, r) => { const d = p.distanceTo(c) / r; return d >= 1 ? 0 : (1 - d * d) ** 2; };
      const upIn = (v) => v.clone().normalize();
      const moves = new Map();
      for (const i of headIds) {
        const p = WP[i], m = V();
        for (const e of eyeC) {
          const out = hs.clone().multiplyScalar(e.sgn);
          const brow = e.c1.clone().addScaledVector(hu, 0.09 * LmS).addScaledVector(a, -0.02 * LmS);
          m.addScaledVector(upIn(out.clone().multiplyScalar(0.5).addScaledVector(hu, 0.6).addScaledVector(a, 0.25)), PQ.brow * LmS * bump(p, brow, 0.13 * LmS));
          const cheek = e.c1.clone().addScaledVector(hu, -0.12 * LmS).addScaledVector(a, 0.02 * LmS).addScaledVector(out, -0.02 * LmS);
          m.addScaledVector(upIn(out.clone().addScaledVector(hu, -0.2)), PQ.cheek * LmS * bump(p, cheek, 0.17 * LmS));
        }
        const dome = H.clone().addScaledVector(hu, 0.2 * LmS).addScaledVector(a, 0.3 * LmS);
        m.addScaledVector(hu, PQ.dome * LmS * bump(p, dome, 0.28 * LmS));
        // a CURVED nose bridge: the forehead rounds down into the snout (a
        // straight bridge read long and flat — your references are round)
        if (PQ.bridge) {
          const br = H.clone().addScaledVector(hu, 0.12 * LmS).addScaledVector(a, 0.55 * LmS);
          m.addScaledVector(hu.clone().addScaledVector(a, 0.35).normalize(), PQ.bridge * LmS * bump(p, br, 0.26 * LmS));
        }
        const z = p.clone().sub(H).dot(a) / LmS;
        m.addScaledVector(a, PQ.snoutOut * LmS * smoothstep01(0.7, 0.88, z));             // the snout sticks out
        if (m.lengthSq() > 0) moves.set(i, m);
      }
      for (const [i, m] of moves) WP[i].add(m);
      // The eyeball out of its socket: the donkey's eye is set deep (it read as
      // a hole); your pigs' eyes sit flush and bulge a little under the lid.
      if (PQ.eyeOut) {
        const ev = new Set();
        for (const f of faces) if (fm(f) === "Eye_Dark" || fm(f) === "Eye_White") for (const i of fv(f)) ev.add(i);
        for (const e of eyeC) {
          const out = hs.clone().multiplyScalar(e.sgn).addScaledVector(a, 0.35).normalize();
          for (const i of ev) if (Math.sign(WP[i].clone().sub(H).dot(hs)) === e.sgn) WP[i].addScaledVector(out, PQ.eyeOut * LmS);
        }
      }
      if (PQ.fillGroove) {
        // THE GROOVE under the ears: the thick neck met a head narrower just in
        // front of it, and from behind you looked PAST the head's side under the
        // ear (magenta-background test: slits both sides). A pig's head flows
        // out of its neck: per height band and side, the side width from the
        // neck to the eye plane may not dip below the straight line between the
        // two — side-surface vertices are pushed out to it.
        const hf = (p) => { const d = p.clone().sub(H); return { z: d.dot(a) / LmS, y: d.dot(hu) / LmS, x: d.dot(hs) / LmS }; };
        const za = hf(W("Neck2")).z, zb = eyeC.length ? eyeC.reduce((m, e) => m + hf(e.c0).z, 0) / eyeC.length : 0.35;
        const isEar = (i) => wOf(i, (b) => /^Ear[234]/.test(b)) >= 0.2;
        const ids = [...used].filter((i) => wOf(i, (b) => b.startsWith("Neck") || b === "Head" || b.startsWith("Ear")) > 0.5 && !isEar(i));
        const zb2 = 0.04, yb2 = 0.05;
        const mx = new Map();
        const key = (z, y, sg) => `${Math.round(z / zb2)}|${Math.round(y / yb2)}|${sg}`;
        const P0 = new Map();
        for (const i of ids) { const q = hf(WP[i]); P0.set(i, q); const sg = q.x >= 0 ? 1 : -1, k = key(q.z, q.y, sg); mx.set(k, Math.max(mx.get(k) ?? 0, Math.abs(q.x))); }
        const widthAt = (z, y, sg) => { let m = 0; for (let dz = -1; dz <= 1; dz++) m = Math.max(m, mx.get(key(z + dz * zb2, y, sg)) ?? 0); return m; };
        const deltas = new Map();
        let pushed = 0, most = 0;
        for (const i of ids) {
          const q = P0.get(i);
          if (q.z <= za || q.z >= zb) continue;
          const sg = q.x >= 0 ? 1 : -1;
          const wa = widthAt(za, q.y, sg), wb = widthAt(zb, q.y, sg), here = mx.get(key(q.z, q.y, sg)) ?? 0;
          if (!wa || !wb || !here) continue;
          const u = (q.z - za) / (zb - za), env = wa + (wb - wa) * u;
          if (env <= here) continue;
          const k = smoothstep01(0.55, 1, Math.abs(q.x) / here);            // the side surface, not the inside
          const dx = (env - here) * k * Math.sin(Math.PI * u) ** 0.5;        // nothing at either end
          if (dx <= 1e-5) continue;
          deltas.set(i, hs.clone().multiplyScalar(sg * dx * LmS));
          pushed++; most = Math.max(most, dx);
        }
        // relax the pushes over the surface so no single vertex stands out
        const nb = new Map();
        for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (nb.get(x) ?? nb.set(x, []).get(x)).push(y); (nb.get(y) ?? nb.set(y, []).get(y)).push(x); } }
        let D = deltas;
        for (let it = 0; it < 2; it++) {
          const N2 = new Map();
          for (const [i, d] of D) { const m = d.clone(); let n = 1; for (const j of nb.get(i) ?? []) { const dj = D.get(j); if (dj) { m.add(dj); n++; } } N2.set(i, m.multiplyScalar(1 / n)); }
          D = N2;
        }
        for (const [i, d] of D) WP[i].add(d);
        // the ear sheets ride with their root
        for (const e of eyeC) {
          const root = [...D].filter(([i]) => wOf(i, (b) => b.startsWith("Ear1")) > 0.2 && Math.sign(WP[i].clone().sub(H).dot(hs)) === e.sgn);
          if (!root.length) continue;
          const m = V(); for (const [, d] of root) m.add(d); m.multiplyScalar(1 / root.length);
          for (const i of used) if (isEar(i) && Math.sign(WP[i].clone().sub(H).dot(hs)) === e.sgn) WP[i].add(m);
        }
        window.__groove = { pushed, most: +most.toFixed(3) };
        console.log(`[pig2-morph] groove under the ears filled: ${pushed} verts, most ${most.toFixed(3)} head lengths`);
      }
      // Repair: any head face still inside-out is relaxed toward its neighbours
      // until it is not (measured, not assumed — logged).
      const nrmF = (f) => { const vs = fv(f), L = vs.length, n = V(); for (let k = 0; k < L; k++) { const p0 = WP[vs[k]], p1 = WP[vs[(k + 1) % L]]; n.x += (p0.y - p1.y) * (p0.z + p1.z); n.y += (p0.z - p1.z) * (p0.x + p1.x); n.z += (p0.x - p1.x) * (p0.y + p1.y); } return n.normalize(); };
      const headF = faces.filter((f) => fv(f).every((i) => headW(i) > 0.5));
      const nbr = new Map();
      for (const f of headF) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (nbr.get(x) ?? nbr.set(x, new Set()).get(x)).add(y); (nbr.get(y) ?? nbr.set(y, new Set()).get(y)).add(x); } }
      let fixedRounds = 0;
      for (let it = 0; it < 30; it++) {
        const byE = new Map(), N = headF.map(nrmF);
        headF.forEach((f, fi) => { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; const key = x < y ? `${x}_${y}` : `${y}_${x}`; (byE.get(key) ?? byE.set(key, []).get(key)).push(fi); } });
        const nb = headF.map(() => V());
        for (const l of byE.values()) if (l.length === 2) { nb[l[0]].add(N[l[1]]); nb[l[1]].add(N[l[0]]); }
        // folded against its neighbours, OR turned to face into the head (a
        // half-fold the neighbour test misses — the slit above the eye)
        const hcR = H.clone().addScaledVector(a, 0.4 * LmS);
        const inwardF = (f, fi) => { if (fv(f).some((i) => wOf(i, (b) => b.startsWith("Ear")) > 0.2)) return false; const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length); return N[fi].dot(c.sub(hcR).normalize()) < -0.05; };
        const bad = headF.filter((f, fi) => (nb[fi].lengthSq() > 1e-12 && N[fi].dot(nb[fi].normalize()) < -0.2) || inwardF(f, fi));
        if (!bad.length) break;
        fixedRounds++;
        for (const f of bad) for (const i of fv(f)) { const ns = nbr.get(i); if (!ns) continue; const c = V(); for (const j of ns) c.add(WP[j]); WP[i].lerp(c.multiplyScalar(1 / ns.size), 0.5); }
      }
      {
        const hc = H.clone().addScaledVector(a, 0.4 * LmS);
        let inward = 0;
        for (const f of headF) {
          if (fv(f).some((i) => wOf(i, (b) => b.startsWith("Ear")) > 0.2)) continue;   // ears are thin sheets
          const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length);
          if (nrmF(f).dot(c.clone().sub(hc).normalize()) < -0.05) inward++;
        }
        window.__pig2Inward = inward;
        console.log(`[pig2-morph] face volume: brow, cheeks, dome, snout; fold repair rounds ${fixedRounds}; head faces turned inward: ${inward}`);
      }
      if (PQ.poll) {
        // THE POLL: behind the ears the neck's top rose into a bump (measured on
        // the walking pig's midline: back 0.73 m, a dip to 0.68, up again to
        // 0.73 at Neck3, then down into the forehead) — the donkey's poll and
        // forelock. A pig has no neck line: the back runs on into the brow.
        // Measured in the NECK'S OWN FRAME (height of the top above the bone
        // chain, per arc length — the rest neck is not yet bent down, the clips
        // bend it): the top height is made one smooth ramp from Torso3 to the
        // ear roots; each section's upper part shifts, its shape kept.
        // the NECK's own vertices only (the body round the shoulders is not
        // touched: taking it in raised a spike over the withers — measured)
        const cand = [...used].filter((i) => wOf(i, (b) => /^Ear[234]/.test(b)) < 0.2
          && wOf(i, (b) => b.startsWith("Torso") || b === "Back") < 0.2 && wOf(i, (b) => b.startsWith("Neck") || b === "Head" || b.startsWith("Ear1")) > 0.6);
        const info = new Map();
        for (const i of cand) {
          const { c, s: sp, t } = nearest(neckJ, WP[i]);
          const up = UP.clone().addScaledVector(t, -UP.dot(t)).normalize(), sd = V().crossVectors(t, up);
          const d = WP[i].clone().sub(c);
          info.set(i, { sp, up, h: d.dot(up), lat: d.dot(sd) });
        }
        const earS = nearest(neckJ, W("Ear1L").add(W("Ear1R")).multiplyScalar(0.5)).s;
        const s1 = nearest(neckJ, W("Neck1")).s, se = earS, bin = 0.06 * (se - s1);
        const topAt = new Map();
        for (const [, v] of info) if (v.h > 0 && Math.abs(v.lat) < 0.35 * v.h) { const k = Math.round(v.sp / bin); topAt.set(k, Math.max(topAt.get(k) ?? -Infinity, v.h)); }
        const top = (sv) => { const k = Math.round(sv / bin); for (let d = 0; d < 4; d++) { const t = topAt.get(k + d) ?? topAt.get(k - d); if (t !== undefined) return t; } return null; };
        // the ramp starts at the first section that has neck vertices on top
        let sb = s1;
        { let k0 = Infinity; for (const k of topAt.keys()) if (k * bin >= s1 - bin && k < k0) k0 = k; if (k0 < Infinity) sb = k0 * bin; }
        const hb = top(sb), he = top(se);
        const prof = [];
        for (let k = Math.round(s1 / bin); k * bin <= se; k += 1) prof.push((top(k * bin) ?? 0).toFixed(3));
        let moved = 0, most = 0;
        if (hb !== null && he !== null) {
          const want = (sv) => { const u = Math.min(1, Math.max(0, (sv - sb) / (se - sb))); return hb + (he - hb) * smoothstep01(0, 1, u); };
          // pressed DOWN only (the poll bump); a low spot is left alone
          const shift = (sv) => { let m = 0, n = 0; for (let d = -2; d <= 2; d++) { const x = sv + d * bin, t = top(x); if (t === null || x < sb || x > se) continue; m += Math.min(0, want(x) - t); n++; } return n ? m / n : 0; };
          for (const i of cand) {
            const v = info.get(i);
            if (v.sp <= sb || v.sp >= se) continue;
            const u = (v.sp - sb) / (se - sb), edge = smoothstep01(0, 0.15, u);
            const t = top(v.sp);
            if (t === null || t <= 0 || v.h <= 0) continue;
            const dh = shift(v.sp) * smoothstep01(0.25, 0.9, v.h / t) * edge;          // the upper part of the section
            if (Math.abs(dh) > 1e-6) { WP[i].addScaledVector(v.up, dh); moved++; most = Math.max(most, Math.abs(dh)); }
          }
        }
        const prof2 = [];
        // (re-measure for the log)
        const topAt2 = new Map();
        for (const i of cand) { const { c, s: sp, t } = nearest(neckJ, WP[i]); const up = UP.clone().addScaledVector(t, -UP.dot(t)).normalize(), sd = V().crossVectors(t, up), d = WP[i].clone().sub(c), h = d.dot(up); if (h > 0 && Math.abs(d.dot(sd)) < 0.35 * h) { const k = Math.round(sp / bin); topAt2.set(k, Math.max(topAt2.get(k) ?? -Infinity, h)); } }
        for (let k = Math.round(s1 / bin); k * bin <= se; k += 1) prof2.push((topAt2.get(k) ?? 0).toFixed(3));
        window.__poll = { before: prof, after: prof2, moved };
        console.log(`[pig2-morph] poll: neck-top height along the neck ${prof.join(" ")} → ${prof2.join(" ")}; ${moved} verts, most ${(most / A.Rv).toFixed(3)} Rv`);
      }
      {
        // NECK / THROAT: the neck bent down and the back flattened can pinch the
        // throat into half-folded faces (a see-through hollow). Same test as the
        // head, measured from the neck's own axis; relaxed until none face in.
        const chain = [W("Torso2"), W("Torso3"), W("Neck1"), W("Neck2"), W("Neck3"), W("Head")];
        const neckF = faces.filter((f) => fv(f).reduce((sum, i) => sum + wOf(i, (b) => b.startsWith("Neck") || b === "Torso3"), 0) / fv(f).length > 0.4
          && fv(f).every((i) => wOf(i, (b) => b.startsWith("Ear")) < 0.2));
        const nbN = new Map();
        for (const f of neckF) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (nbN.get(x) ?? nbN.set(x, new Set()).get(x)).add(y); (nbN.get(y) ?? nbN.set(y, new Set()).get(y)).add(x); } }
        const inwardN = () => neckF.filter((f) => { const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length); const { c: q } = nearest(chain, c); return nrmF(f).dot(c.sub(q).normalize()) < -0.05; });
        const before = inwardN().length;
        let rounds = 0;
        for (let it = 0; it < 30; it++) {
          const bad = inwardN();
          if (!bad.length) break;
          rounds++;
          for (const f of bad) for (const i of fv(f)) { const ns = nbN.get(i); if (!ns) continue; const c = V(); for (const j of ns) c.add(WP[j]); WP[i].lerp(c.multiplyScalar(1 / ns.size), 0.5); }
        }
        window.__pig2Neck = { before, after: inwardN().length, rounds };
        // THE EAR COLLAR: faces joining an ear's root to the neck/head. Both
        // passes above skip anything touching an ear, and one such face per side
        // folded inside-out (the see-through slit behind the ear: found by a
        // ray through the slit — a back face, Ear1 root + two Neck3 vertices).
        // Tested from the neck/head axis; only the NON-ear corners move (the
        // ear keeps its shape).
        {
          const chainH = [...chain, W("Head").addScaledVector(a, 0.5 * LmS)];
          const ear1 = (i) => wOf(i, (b) => b.startsWith("Ear1")) > 0.2, earT = (i) => wOf(i, (b) => /^Ear[234]/.test(b)) > 0.2;
          const collar = faces.filter((f) => fv(f).some(ear1) && !fv(f).some(earT) && !fv(f).every(ear1));
          const nbC = new Map();
          for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (nbC.get(x) ?? nbC.set(x, new Set()).get(x)).add(y); (nbC.get(y) ?? nbC.set(y, new Set()).get(y)).add(x); } }
          const inwardC = () => collar.filter((f) => { const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length); const { c: q } = nearest(chainH, c); return nrmF(f).dot(c.sub(q).normalize()) < -0.05; });
          const c0 = inwardC().length;
          let rc = 0;
          for (let it = 0; it < 30; it++) {
            const bad = inwardC();
            if (!bad.length) break;
            rc++;
            for (const f of bad) for (const i of fv(f)) { if (ear1(i)) continue; const ns = nbC.get(i); if (!ns) continue; const c = V(); for (const j of ns) c.add(WP[j]); WP[i].lerp(c.multiplyScalar(1 / ns.size), 0.5); }
          }
          window.__pig2Collar = { faces: collar.length, before: c0, after: inwardC().length, rounds: rc };
          console.log(`[pig2-morph] ear collar faces turned inward: ${c0} → ${window.__pig2Collar.after} (${rc} rounds, of ${collar.length})`);
        }
        console.log(`[pig2-morph] neck/throat faces turned inward: ${before} → ${window.__pig2Neck.after} (${rounds} rounds)`);
      }
    }
    console.log(`[pig-morph] body loop cuts: ${rings.join(", ")} quads per ring; fat, belly, swayback, snout`);
    lift = WP.map(() => 0);
  } else if (GAZELLE) {
    // THE FLANK BAND: the dark band between the fawn back and the white belly,
    // two horizontal planes sliced through the body so it paints as one clean
    // band of faces (the shared plane slicer).
    const yMid = W("Torso2").y + A.cyOff;
    gzBand.lo = yMid - 0.46 * A.Rv; gzBand.hi = yMid - 0.14 * A.Rv;
    planeSlice(UP, gzBand.lo); planeSlice(UP, gzBand.hi);
    // THE HORNS: ringed lyres rising from the poll — back, out, and the tips
    // turning forward and in (the goat's horn tube, a gazelle's curve).
    let LmS = 0;
    for (let i = 0; i < WP.length; i++) if (headW(i) > 0.5) LmS = Math.max(LmS, WP[i].clone().sub(H).dot(a));
    let topY = -Infinity, maxX = 0;
    for (let i = 0; i < WP.length; i++) {
      if (headW(i) < 0.5 || wOf(i, (b) => b.startsWith("Ear")) > 0.2) continue;
      const d = WP[i].clone().sub(H);
      topY = Math.max(topY, d.dot(hu) / LmS); maxX = Math.max(maxX, Math.abs(d.dot(hs)) / LmS);
    }
    const Hp = (x, y, z) => H.clone().addScaledVector(hs, x * LmS).addScaledVector(hu, y * LmS).addScaledVector(a, z * LmS);
    const headSkin = [["Head", 1]];
    const addV = (q, mt) => { WP.push(q); WS.push(headSkin); WM.push(new Set([mt])); return WP.length - 1; };
    const SIDES = 6, RINGS = 18, L = PGZ.horn;
    for (const sx of [-1, 1]) {
      const bx = sx * 0.26 * maxX, bz = 0.24;
      let surf = -Infinity;
      for (let rad = 0.06; surf === -Infinity && rad < 0.5; rad *= 1.5) {
        for (let i = 0; i < WP.length; i++) {
          if (headW(i) < 0.5 || wOf(i, (b) => b.startsWith("Ear")) > 0.2) continue;
          const d = WP[i].clone().sub(H), x = d.dot(hs) / LmS, z = d.dot(a) / LmS;
          if (Math.hypot(x - bx, z - bz) < rad) surf = Math.max(surf, d.dot(hu) / LmS);
        }
      }
      const baseY = (surf === -Infinity ? topY : surf) - 0.03;
      const pts = [];
      for (let r = 0; r <= RINGS; r++) {
        const u = r / RINGS;
        pts.push(Hp(bx + sx * L * (0.2 * Math.sin(Math.PI * u) + 0.03 * u),     // out, then in: the lyre
          baseY + L * 0.95 * u,                                                  // up
          bz - L * 0.45 * Math.sin(Math.PI * 0.8 * u) + L * 0.1 * u ** 3));       // back, then the tips a little forward
      }
      const rings = [];
      for (let r = 0; r < RINGS; r++) {
        const u = r / RINGS, rad = (0.07 - 0.058 * u) * LmS;
        const T = pts[r + 1].clone().sub(pts[Math.max(0, r - 1)]).normalize();
        const N1 = V().crossVectors(T, hs).normalize(), N2 = V().crossVectors(T, N1).normalize();
        const ring = [];
        for (let k = 0; k < SIDES; k++) { const an = (k / SIDES) * Math.PI * 2; ring.push(addV(pts[r].clone().addScaledVector(N1, Math.cos(an) * rad).addScaledVector(N2, Math.sin(an) * rad), r % 2 ? "Horn" : "Horn2")); }
        rings.push(ring);
      }
      const tip = addV(pts[RINGS].clone(), "Horn");
      const base = addV(pts[0].clone().addScaledVector(hu, -0.05 * LmS), "Horn");
      for (let k = 0; k < SIDES; k++) faces.push([rings[0][(k + 1) % SIDES], rings[0][k], base, "Horn"]);
      for (let r = 0; r < RINGS - 1; r++) for (let k = 0; k < SIDES; k++) { const k1 = (k + 1) % SIDES; faces.push([rings[r][k], rings[r][k1], rings[r + 1][k1], rings[r + 1][k], r % 2 ? "Horn" : "Horn2"]); }
      for (let k = 0; k < SIDES; k++) faces.push([rings[RINGS - 1][k], rings[RINGS - 1][(k + 1) % SIDES], tip, "Horn"]);
    }
    console.log(`[gazelle-morph] flank band sliced, two lyre horns`);
    lift = WP.map(() => 0);
  } else if (DONKEY) {
    // the dorsal stripe (two planes along the spine) and the shoulder cross
    // (two planes across the withers), sliced so they paint as clean bands
    const mid = W("Torso2").dot(right), s3 = W("Torso3").dot(fwd);
    dkStripe.half = PDK.stripeW * A.Rside; dkStripe.mid = mid;
    planeSlice(right, mid - dkStripe.half); planeSlice(right, mid + dkStripe.half);
    if (PDK.cross) { dkStripe.s3 = s3; dkStripe.crossHalf = PDK.crossW * A.Rv; planeSlice(fwd, s3 - dkStripe.crossHalf); planeSlice(fwd, s3 + dkStripe.crossHalf); }
    if (PDK.load === "panniers") {
      // THE LOAD: a woven blanket over the back and two baskets on the flanks,
      // part of the donkey's own mesh (one draw), skinned to the back bones so
      // it rides through every clip.
      const Lb = W("Torso3").dot(fwd) - W("Back").dot(fwd);
      const sA = W("Back").dot(fwd) + 0.22 * Lb, sB = W("Torso3").dot(fwd) - 0.02 * Lb, sM = (sA + sB) / 2;
      let bodyTop = -Infinity;
      for (let i = 0; i < WP.length; i++) { const sv = WP[i].dot(fwd); if (sv > sA && sv < sB && wOf(i, (b) => b === "Back" || b === "Body" || b.startsWith("Torso")) > 0.5) bodyTop = Math.max(bodyTop, WP[i].y); }
      const yLow = bodyTop - 0.95 * A.Rv;                     // the blanket's lower edge, mid-flank
      // 1. the blanket's outline and bands, sliced into the body first
      const bw = 0.045 * (sB - sA) * 2;                        // a border band's width
      const cuts = [sA, sA + bw, sA + 2 * bw, sM - 0.04 * Lb, sM + 0.04 * Lb, sB - 2 * bw, sB - bw, sB];
      for (const c of cuts) planeSlice(fwd, c);
      planeSlice(UP, yLow); planeSlice(UP, yLow + 0.12 * A.Rv);
      dkLoad.sA = sA; dkLoad.sB = sB; dkLoad.bw = bw; dkLoad.sM = sM; dkLoad.rope = 0.04 * Lb; dkLoad.yLow = yLow; dkLoad.border = 0.12 * A.Rv;
      // 2. the shell: the back faces between the cuts, lifted along their normal
      const isBody = (f) => fv(f).every((i) => wOf(i, (b) => b === "Back" || b === "Body" || b.startsWith("Torso") || /Shoulder|BackLeg[LR]/.test(b)) > 0.5);
      const region = faces.filter((f) => {
        if (!/^Main/.test(fm(f)) || !isBody(f)) return false;
        const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length);
        const sv = c.dot(fwd); return sv > sA && sv < sB && c.y > yLow;
      });
      const nrmOf = (f) => { const vs = fv(f), L = vs.length, n = V(); for (let k = 0; k < L; k++) { const p0 = WP[vs[k]], p1 = WP[vs[(k + 1) % L]]; n.x += (p0.y - p1.y) * (p0.z + p1.z); n.y += (p0.z - p1.z) * (p0.x + p1.x); n.z += (p0.x - p1.x) * (p0.y + p1.y); } return n.normalize(); };
      const vn = new Map();
      for (const f of region) { const n = nrmOf(f); for (const i of fv(f)) (vn.get(i) ?? vn.set(i, V()).get(i)).add(n); }
      const thick = 0.045 * A.Rv, shell = new Map();
      for (const [i, n] of vn) {
        const id = WP.length;
        WP.push(WP[i].clone().addScaledVector(n.normalize(), thick)); WS.push(WS[i].map((e) => [...e])); WM.push(new Set(["Blanket"]));
        shell.set(i, id);
      }
      const edgeUse = new Map();
      for (const f of region) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; const key = ek(x, y); edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1); } }
      for (const f of region) {
        const vs = fv(f);
        faces.push([...vs.map((i) => shell.get(i)), "Blanket"]);
        for (let k = 0; k < vs.length; k++) {                  // the rim: a wall down to the body
          const x = vs[k], y = vs[(k + 1) % vs.length];
          if (edgeUse.get(ek(x, y)) === 1) faces.push([x, y, shell.get(y), shell.get(x), "BlanketRim"]);
        }
      }
      // 3. the baskets: flared, woven, open-rimmed, hanging on each flank
      const len = 0.5 * Lb, hgt = 1.05 * A.Rv, dep = 0.3 * A.Rv;
      const yT = bodyTop - 0.5 * A.Rv, yB = yT - hgt;
      // the body's half-width at a height, where they hang (the TORSO only:
      // the legs' tops stood out and pushed the baskets off the body)
      const hwAt = (y, band) => {
        let m = 0;
        for (let i = 0; i < WP.length; i++) {
          if (Math.abs(WP[i].dot(fwd) - sM) > len / 2 || Math.abs(WP[i].y - y) > band) continue;
          if (wOf(i, (b) => b === "Back" || b === "Body" || b.startsWith("Torso")) > 0.6) m = Math.max(m, Math.abs(WP[i].dot(right) - mid));
        }
        return m;
      };
      // the basket LEANS on the flank: its inner wall from the width at its top
      // to the width at its bottom (the barrel narrows below — a gap showed)
      const hwTop = hwAt(yT, 0.2 * A.Rv), hwBot = Math.max(0.5 * hwTop, hwAt(yB + 0.15 * A.Rv, 0.2 * A.Rv));
      const hw = hwTop;
      const bone = [["Torso2", 1]];
      const N = 10, RINGS = 7;
      for (const sd of [-1, 1]) {
        const C = W("Torso2").addScaledVector(fwd, sM - W("Torso2").dot(fwd)).addScaledVector(right, mid - W("Torso2").dot(right) + sd * (hw + thick + dep + 0.02 * A.Rv));
        const ring = (y, k) => {
          const out = [];
          const lean = sd * (hwBot - hwTop) * Math.min(1, Math.max(0, (yT - y) / hgt));   // in toward the body, lower down
          for (let j = 0; j < N; j++) {
            const th = (j / N) * Math.PI * 2, id = WP.length;
            WP.push(C.clone().setY(y).addScaledVector(right, lean).addScaledVector(fwd, Math.cos(th) * (len / 2) * k).addScaledVector(right, Math.sin(th) * dep * k));
            WS.push(bone.map((e) => [...e])); WM.push(new Set(["Basket"]));
            out.push(id);
          }
          return out;
        };
        const rings = [];
        for (let r = 0; r <= RINGS; r++) { const u = r / RINGS; rings.push(ring(yB + u * hgt, 0.82 + 0.18 * u)); }
        const rimIn = ring(yT - 0.02 * A.Rv, 0.88);             // the rim turns in…
        const fill = ring(yT - 0.12 * A.Rv, 0.86);              // …down to the load inside
        const quad = (r0, r1, j, mt) => [r0[j], r0[(j + 1) % N], r1[(j + 1) % N], r1[j], mt];
        const bands = [];
        for (let r = 0; r < RINGS; r++) for (let j = 0; j < N; j++) bands.push(quad(rings[r], rings[r + 1], j, r % 2 ? "BasketDark" : "Basket"));
        for (let j = 0; j < N; j++) bands.push(quad(rings[RINGS], rimIn, j, "BasketRim"), quad(rimIn, fill, j, "BasketRim"));
        // outward winding: test one wall quad against its radial direction
        const t = bands[0], nq = nrmOf(t), cq = V(); for (const i of fv(t)) cq.add(WP[i]); cq.multiplyScalar(0.25);
        const flip = nq.dot(cq.sub(C).setY(0)) < 0;
        for (const q of bands) faces.push(flip ? [...fv(q).reverse(), fm(q)] : q);
        // bottom and the load's top, as fans
        for (const [r, mt, up] of [[rings[0], "BasketDark", false], [fill, "BasketLoad", true]]) {
          const c = V(); for (const i of r) c.add(WP[i]); c.multiplyScalar(1 / N);
          const ci = WP.length; WP.push(c); WS.push(bone.map((e) => [...e])); WM.push(new Set([mt]));
          for (let j = 0; j < N; j++) {
            const tri = [r[j], r[(j + 1) % N], ci];
            const nt = nrmOf([...tri, mt]);
            faces.push((nt.y > 0) === up ? [...tri, mt] : [...tri.reverse(), mt]);
          }
        }
      }
      console.log(`[donkey-morph] load: blanket ${region.length} faces, two baskets leaning on the flanks (half-width ${(hwTop / A.Rv).toFixed(2)} → ${(hwBot / A.Rv).toFixed(2)} Rv)`);
    }
    lift = WP.map(() => 0);
  } else if (HYENA) {
    // BUSHY TAIL: the tail's vertices pushed out from the tail bones (not the
    // root, which carries the rump), most at the middle of the tail.
    {
      const tj = []; for (let i = 1; B["Tail" + i]; i++) tj.push(W("Tail" + i));
      let n = 0;
      if (tj.length > 2) for (let i = 0; i < WP.length; i++) {
        const w = wOf(i, (b) => /^Tail[2-9]/.test(b));
        if (w < 0.3) continue;
        const { c, s: sp } = nearest(tj, WP[i]);
        const L = nearest(tj, tj[tj.length - 1]).s || 1, u = sp / L;
        const k = 1 + (PHY.tailFluff - 1) * Math.min(1, w) * Math.sin(Math.PI * Math.min(1, 0.15 + 0.85 * u)) ** 0.6;
        WP[i].sub(c).multiplyScalar(k).add(c); n++;
      }
      console.log(`[hyena-morph] bushy tail: ${n} verts`);
    }
    // THE CREST: a striped hyena's mane of long hair stands along the whole
    // spine, highest over the shoulders and the neck. The top-line vertices
    // (above the spine chain, near the midline) are pushed UP, the push
    // smoothed over the surface so it reads as a ridge of hair, not spikes.
    const spine = [W("Back"), W("Torso"), W("Torso2"), W("Torso3"), W("Neck1"), W("Neck2"), W("Neck3")];
    const sT = nearest(spine, W("Torso3")).s, sEnd = nearest(spine, W("Neck3")).s;
    const disp = new Map();
    for (let i = 0; i < WP.length; i++) {
      if (wOf(i, (b) => b === "Back" || b.startsWith("Torso") || b.startsWith("Neck")) < 0.5) continue;
      const { c, s: sp, t } = nearest(spine, WP[i]);
      const up = UP.clone().addScaledVector(t, -UP.dot(t)).normalize(), sd = V().crossVectors(t, up);
      const d = WP[i].clone().sub(c), h = d.dot(up), lat = Math.abs(d.dot(sd));
      if (h <= 0 || lat > 0.5 * h) continue;
      // along the spine: rising from the rump to the shoulders, carried up the neck
      const along = sp < sT ? 0.35 + 0.55 * smoothstep01(0, sT, sp) : 0.9 - 0.45 * smoothstep01(sT, sEnd, sp);
      disp.set(i, up.multiplyScalar(Q.crest * A.Rv * along * (1 - lat / (0.5 * h))));
    }
    const adj = new Map();
    for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (adj.get(x) ?? adj.set(x, []).get(x)).push(y); (adj.get(y) ?? adj.set(y, []).get(y)).push(x); } }
    let D = disp;
    {
      // one pass, among the crest's own vertices only (averaging with the
      // unmoved neighbours thinned it to nothing — measured, not visible)
      const N2 = new Map();
      for (const [i, dv] of D) { const m = dv.clone(); let n = 1; for (const j of adj.get(i) ?? []) { const dj = D.get(j); if (dj) { m.add(dj); n++; } } N2.set(i, m.multiplyScalar(1 / n)); }
      D = N2;
    }
    let most = 0; for (const [i, dv] of D) { WP[i].add(dv); most = Math.max(most, dv.length()); }
    window.__crest = +(most / A.Rv).toFixed(2);
    console.log(`[hyena-morph] crest up to ${(most / A.Rv).toFixed(2)} Rv, ${D.size} top-line verts raised`);
    // STRIPES that follow the facets: each stripe is the strip between two
    // PLANES, and every face a plane crosses is split along it (one shared new
    // vertex per crossed edge, so the mesh stays closed). A face then lies
    // wholly inside or outside a stripe — clean straight-edged bands across the
    // facets, painted dark below. (The quad-walking loop cut stopped short on
    // the husky's irregular torso: half-split faces, 16 open edges, blocks.)
    {
      const sB = W("Back").dot(fwd), sF = W("Torso3").dot(fwd), u0 = -0.1, u1 = 1.15;
      const per = (u1 - u0) / PHY.stripes, th = THREE.MathUtils.degToRad(PHY.stripeTilt ?? 8);
      const slice = planeSlice;
      let split = 0;
      for (let k = 0; k < PHY.stripes; k++) {
        const j = (q) => (hash(k * 7 + q) - 0.5) * PHY.stripeJit;              // fixed per stripe
        const wk = PHY.stripeW * (1 + j(1)), a0 = u0 + (k + 0.5 + j(2) * 0.6 - wk / 2) * per, a1 = a0 + wk * per;
        const tk = th + j(3) * 0.5;
        const nK = fwd.clone().multiplyScalar(Math.cos(tk)).addScaledVector(UP, Math.sin(tk)).normalize();
        // the plane through the stripe edge's point on the body axis (at Torso2's height)
        const P0 = W("Torso2").addScaledVector(fwd, sB + a0 * (sF - sB) - W("Torso2").dot(fwd));
        const P1 = W("Torso2").addScaledVector(fwd, sB + a1 * (sF - sB) - W("Torso2").dot(fwd));
        const d0 = P0.dot(nK), d1 = P1.dot(nK);
        split += slice(nK, d0) + slice(nK, d1);
        hyBands.push([nK, d0, d1]);
      }
      console.log(`[hyena-morph] stripe planes: ${2 * PHY.stripes}, ${split} faces split`);
    }
    lift = WP.map(() => 0);
  } else {
  const ringSizes = [-0.7, -0.25, 0.25, 0.7].map((u) => loopCut(s0 + u * halfLen));
  console.log(`[camel-morph] hump loop cuts: ${ringSizes.join(", ")} quads per ring`);
  lift = WP.map((p) => humpAt(p));
  for (let i = 0; i < WP.length; i++) {
    if (!lift[i]) continue;
    // up, and the hump's flanks swell outward a little — volume, not a ridge
    const sd = humpV(WP[i]);
    WP[i].y += lift[i];
    WP[i].addScaledVector(right, Math.sign(sd) * Math.min(1, Math.abs(sd) * 1.6) * lift[i] * 0.22);
  }
  }

  if (PIG2 && PQ.hoofSlim) {
    // PIG2 FEET (your references): a pig's leg runs STRAIGHT down into a
    // small hoof. The donkey's pastern angles forward below the fetlock into
    // a broad hoof — on the pig it read as a horse's boot with a knuckle
    // (A/B measured: narrowing the hoof alone changed nothing visible). Per
    // leg: every height slice below the fetlock slides back under the shin
    // (the pastern stands straight), then the radius tapers smoothly from the
    // shin to a small hoof. Slices, not single vertices: each slice keeps its
    // own shape.
    const allV = new Set(); for (const f of faces) for (const i of fv(f)) allV.add(i);
    const hoofV = new Set(); for (const f of faces) if (fm(f) === "Hooves") for (const i of fv(f)) hoofV.add(i);
    const legOfV = (i) => footToLeg(WS[i]).reduce((m, e) => (e[1] > m[1] ? e : m), ["", 0]);
    const rep = [];
    for (const leg of ["FrontLowerLegL", "FrontLowerLegR", "BackLowerLegL", "BackLowerLegR"]) {
      const ids = [...allV].filter((i) => { const [b, w] = legOfV(i); return b === leg && w > 0.5; });
      if (!ids.some((i) => hoofV.has(i))) continue;
      const knee = W(leg), tip = tipOf(leg);
      let y0 = Infinity; for (const i of ids) y0 = Math.min(y0, WP[i].y);
      const yTop = tip.y + 0.3 * (knee.y - tip.y);                       // above: untouched
      if (!(yTop > y0)) continue;
      const axisAt = (y) => (y >= tip.y ? tip.clone().lerp(knee, (y - tip.y) / (knee.y - tip.y)) : tip.clone());
      const nb = 12, sl = (y) => Math.min(nb, Math.max(0, ((y - y0) / (yTop - y0)) * nb));
      // 1. straighten: each slice's centre onto the axis (fading out above the fetlock)
      const cen = Array.from({ length: nb + 1 }, () => [0, 0, 0]);
      for (const i of ids) { if (WP[i].y > yTop) continue; const k = Math.round(sl(WP[i].y)); cen[k][0] += WP[i].x; cen[k][1] += WP[i].z; cen[k][2]++; }
      const sh = cen.map((c, k) => {
        if (!c[2]) return null;
        const y = y0 + (k / nb) * (yTop - y0), ax = axisAt(y);
        const blend = 1 - smoothstep01(tip.y, yTop, y);
        return [(ax.x - c[0] / c[2]) * blend, (ax.z - c[1] / c[2]) * blend];
      });
      for (let k = 0; k <= nb; k++) if (!sh[k]) { let lo = k - 1, hi = k + 1; while (lo >= 0 && !sh[lo]) lo--; while (hi <= nb && !sh[hi]) hi++; sh[k] = lo >= 0 && hi <= nb ? [(sh[lo][0] + sh[hi][0]) / 2, (sh[lo][1] + sh[hi][1]) / 2] : (sh[lo] ?? sh[hi] ?? [0, 0]); }
      sh[nb] = [0, 0];
      let moved = 0;
      for (const i of ids) {
        if (WP[i].y > yTop) continue;
        const f = sl(WP[i].y), k = Math.floor(f), u = f - k, a0 = sh[k], a1 = sh[Math.min(nb, k + 1)];
        const dx = a0[0] + (a1[0] - a0[0]) * u, dz = a0[1] + (a1[1] - a0[1]) * u;
        WP[i].x += dx; WP[i].z += dz; moved = Math.max(moved, Math.hypot(dx, dz));
      }
      // 2. taper: radius per slice about the axis → one smooth line, shin → small hoof
      const r = new Array(nb + 1).fill(0);
      const off = (i) => { const c = axisAt(WP[i].y); return [WP[i].x - c.x, WP[i].z - c.z]; };
      for (const i of ids) { if (WP[i].y > yTop) continue; const k = Math.round(sl(WP[i].y)), o = off(i); r[k] = Math.max(r[k], Math.hypot(o[0], o[1])); }
      // below the fetlock only; its width from the fullest slices there (a
      // near-empty top slice pinched the back legs to spikes — measured 91%)
      const kTip = Math.round(sl(tip.y));
      const rTop = Math.max(...r.slice(Math.max(0, kTip - 1), kTip + 2)), rHoof = Math.max(...r.slice(0, 3)) * PQ.hoofSlim;
      let slim = 0;
      for (const i of ids) {
        if (WP[i].y > tip.y) continue;
        const k = Math.round(sl(WP[i].y)); if (!r[k]) continue;
        const want = rHoof + (rTop - rHoof) * smoothstep01(0, 1, (WP[i].y - y0) / (tip.y - y0));
        const f = Math.max(0.55, Math.min(1, want / r[k])), o = off(i);
        WP[i].x -= o[0] * (1 - f); WP[i].z -= o[1] * (1 - f);
        slim = Math.max(slim, 1 - f);
      }
      // 2b. spurs: the donkey's fetlock tuft stuck out behind the straight
      // pastern — no vertex in a slice below the fetlock may stand further out
      // than 1.2x that slice's median radius
      {
        const rs = Array.from({ length: nb + 1 }, () => []);
        for (const i of ids) { if (WP[i].y > tip.y) continue; const o = off(i); rs[Math.round(sl(WP[i].y))].push(Math.hypot(o[0], o[1])); }
        const med = rs.map((l) => { if (l.length < 3) return 0; const q = l.slice().sort((x, y) => x - y); return q[q.length >> 1]; });
        for (const i of ids) {
          if (WP[i].y > tip.y || hoofV.has(i)) continue;
          const k = Math.round(sl(WP[i].y)), o = off(i), ri = Math.hypot(o[0], o[1]);
          if (!med[k] || ri <= 1.2 * med[k]) continue;
          const f = (1.2 * med[k]) / ri;
          WP[i].x -= o[0] * (1 - f); WP[i].z -= o[1] * (1 - f);
        }
      }
      // 3. folds: a lower-leg face folded against its neighbours, or a side
      // face turned in toward the leg's axis (the heel flaps), is relaxed
      // toward its neighbours until none is left (counted, not assumed)
      const idS = new Set(ids.filter((i) => WP[i].y <= yTop));
      const legF = faces.filter((f) => fv(f).every((i) => idS.has(i)));
      const nbL = new Map();
      for (const f of faces) { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length]; (nbL.get(x) ?? nbL.set(x, new Set()).get(x)).add(y); (nbL.get(y) ?? nbL.set(y, new Set()).get(y)).add(x); } }
      const nrmL = (f) => { const vs = fv(f), L = vs.length, n = V(); for (let k = 0; k < L; k++) { const p0 = WP[vs[k]], p1 = WP[vs[(k + 1) % L]]; n.x += (p0.y - p1.y) * (p0.z + p1.z); n.y += (p0.z - p1.z) * (p0.x + p1.x); n.z += (p0.x - p1.x) * (p0.y + p1.y); } return n.normalize(); };
      const badL = () => {
        const N = legF.map(nrmL), byE = new Map();
        legF.forEach((f, fi) => { const vs = fv(f); for (let k = 0; k < vs.length; k++) { const x = vs[k], y = vs[(k + 1) % vs.length], key = x < y ? `${x}_${y}` : `${y}_${x}`; (byE.get(key) ?? byE.set(key, []).get(key)).push(fi); } });
        const nbn = legF.map(() => V());
        for (const l of byE.values()) if (l.length === 2) { nbn[l[0]].add(N[l[1]]); nbn[l[1]].add(N[l[0]]); }
        return legF.filter((f, fi) => {
          if (nbn[fi].lengthSq() > 1e-12 && N[fi].dot(nbn[fi].clone().normalize()) < -0.2) return true;
          if (Math.abs(N[fi].y) > 0.7) return false;                    // soles / tops: no side test
          const c = V(); for (const i of fv(f)) c.add(WP[i]); c.multiplyScalar(1 / fv(f).length);
          const ax = axisAt(c.y), d = V(c.x - ax.x, 0, c.z - ax.z);
          return d.lengthSq() > 1e-12 && V(N[fi].x, 0, N[fi].z).dot(d.normalize()) < -0.1;
        });
      };
      const b0 = badL().length;
      let lr = 0;
      for (let it = 0; it < 30; it++) {
        const bad = badL(); if (!bad.length) break; lr++;
        for (const f of bad) for (const i of fv(f)) { const ns = nbL.get(i); if (!ns) continue; const c = V(); for (const j of ns) c.add(WP[j]); WP[i].lerp(c.multiplyScalar(1 / ns.size), 0.5); }
      }
      const b1 = badL().length;
      rep.push(`${leg.replace("LowerLeg", "")} straightened ${(moved / A.Rv).toFixed(2)} Rv, slimmed up to ${(100 * slim).toFixed(0)}%, folds ${b0} → ${b1}`);
    }
    console.log(`[pig2-morph] feet: ${rep.join("; ")}`);
    window.__pig2Feet = rep;
  }

  if (GOAT) {
    // THE HEAD/NECK SEAM (you, 2026-09-29: "a hollow gap at the top of its
    // face" while EATING). The back of the skull (the poll) is skinned to the
    // EAR bone — the donkey's ear root is huge — so when the goat bends its
    // head down to graze, that patch swung with the ear and tore against the
    // neck: see-through folds, found by ray-scanning every pose (the first hit
    // a BACK face). Measured at exact clip times, 6 views (see-through px):
    //   as built                    Eating 371 · Gallop 342
    //   poll → Head + seam x2       Eating  93 · Gallop  28
    //   + ear sheets kept out of it (this) — you: "looks nice" eating
    //   (x4 passes worse; blending without the poll move folded Neck2; a
    //   pose-aware quad diagonal choice gained nothing — all measured)
    // 1. every Ear1 vertex that is not the ear sheet (no Ear2-4) → Head
    const earT = (i) => wOf(i, (b) => /^Ear[234]/.test(b)) >= 0.05;
    let polled = 0;
    for (let i = 0; i < WP.length; i++) {
      if (earT(i) || wOf(i, (b) => b.startsWith("Ear1")) < 0.05) continue;
      const m = new Map();
      for (const [b, w] of WS[i]) { const nb2 = b.startsWith("Ear1") ? "Head" : b; m.set(nb2, (m.get(nb2) ?? 0) + w); }
      WS[i] = [...m]; polled++;
    }
    // 2. the head/neck seam and its neighbours (not the ears): 2 smoothing passes
    // (neighbours = every corner of each face round a vertex, across the quad's
    // diagonal too — the edge ring alone was too narrow: Eating 123, Gallop 128)
    const nbS = new Map();
    for (const f of faces) { const vs = fv(f); for (const x of vs) for (const y of vs) if (x !== y) (nbS.get(x) ?? nbS.set(x, new Set()).get(x)).add(y); }
    const seam = new Set();
    for (let i = 0; i < WP.length; i++) if (nbS.has(i) && !earT(i) && wOf(i, (b) => b === "Head") > 0.05 && wOf(i, (b) => b === "Neck3") > 0.05) seam.add(i);
    for (const i of [...seam]) for (const j of nbS.get(i)) if (!earT(j)) seam.add(j);
    for (let it = 0; it < 2; it++) {
      const next = new Map();
      for (const i of seam) {
        const acc = new Map(); let k = 0;
        // the ear sheets are not averaged in: their ear weight flowed back into
        // the skull and the same two triangles still folded (measured)
        for (const j of [i, ...nbS.get(i)]) { if (j !== i && earT(j)) continue; for (const [b, w] of WS[j]) acc.set(b, (acc.get(b) ?? 0) + w); k++; }
        const top = [...acc].map(([b, w]) => [b, w / k]).sort((x, y) => y[1] - x[1]).slice(0, 4);
        const sum = top.reduce((s0, e) => s0 + e[1], 0);
        next.set(i, top.map(([b, w]) => [b, w / sum]));
      }
      for (const [i, sk] of next) WS[i] = sk;
    }
    console.log(`[goat-morph] head/neck seam: ${polled} poll verts ear → Head, ${seam.size} seam verts smoothed`);
  }

  countFlips("final");
  console.log(`[${kind}-morph] inside-out faces per step:`, JSON.stringify(flipReport));
  window.__flips = flipReport;
  // Proof, not eyeballing: the donkey welds to a mesh with a handful of
  // open edges (eyes); anything more means an edit tore something.
  {
    const E = new Map();
    for (const f of faces) {
      const vs = fv(f);
      for (let k = 0; k < vs.length; k++) {
        const e = ek(vs[k], vs[(k + 1) % vs.length]);
        E.set(e, (E.get(e) ?? 0) + 1);
      }
    }
    let open = 0, feet = 0;
    const footY = A.ground0 + 0.5 * A.Rv;
    for (const [k, n] of E) if (n === 1) {
      open++;
      const [x, y] = k.split("_").map(Number);
      if (WP[x].y < footY && WP[y].y < footY) feet++;
    }
    const nq = faces.filter((f) => f.length === 5).length;
    console.log(`[${kind}-morph] ${nq} quads + ${faces.length - nq} tris, open edges ${open} (${feet} of them near the ground)`);
    window.__morphFaces = { quads: nq, tris: faces.length - nq };
    window.__morphOpenEdges = { open, feet };
  }

  if (SHEEP) {   // measurement: where do the ear tips point, finally?
    const out = {};
    for (const sd of ["L", "R"]) {
      const e0 = W("Ear1" + sd), tipC = V(); let nw = 0;
      for (let i = 0; i < WP.length; i++) if (wOf(i, (b) => /^Ear[34]/.test(b) && b.endsWith(sd)) > 0.5) { tipC.add(WP[i]); nw++; }
      const d = tipC.multiplyScalar(1 / Math.max(1, nw)).sub(e0);
      const len = d.length(); d.normalize();
      out[sd] = { n: nw, len: +(len / A.Rv).toFixed(2), right: +d.dot(right).toFixed(2), up: +d.dot(UP).toFixed(2), fwd: +d.dot(fwd).toFixed(2) };
    }
    console.log("[sheep-morph] ear tips", JSON.stringify(out));
    window.__ears = out;
  }
  // 3. Colours on the pack's zones, camel palette.
  const baseC = new THREE.Color(Q.color), darkC = new THREE.Color(Q.dark), lightC = new THREE.Color(Q.light);
  const PAL = {
    Main: baseC, Main_Light: lightC, Main_Dark: baseC.clone().lerp(darkC, 0.6),
    Hooves: new THREE.Color("#51463c"), Sole: new THREE.Color("#4a3a2c"),
    Muzzle: lightC.clone().lerp(baseC, 0.2),
    Eye_Dark: new THREE.Color("#0b0806"), Eye_White: new THREE.Color("#e9e1d2"),
  };
  const callusC = new THREE.Color("#4e3c2b");
  // Sheep: white patchwork wool, dark face / ears / legs, darker hooves.
  const sWool = new THREE.Color(P.woolColor);
  const sFace = new THREE.Color(P.faceColor).lerp(new THREE.Color("#5e5956"), 0.7);
  const sRing = sFace.clone().lerp(new THREE.Color("#b9b3ad"), 0.45);   // the lid ring round the eye, like the donkey's
  const eyeV = new Set();
  for (const f of faces) if (fm(f) === "Eye_Dark") for (const i of fv(f)) eyeV.add(i);
  const sLeg = new THREE.Color(P.legColor).lerp(new THREE.Color("#625d59"), 0.45);
  const sHoof = new THREE.Color("#262220");
  const sheepPaint = (vs, mt, nn, cc) => {
    const L = vs.length, avg = (fn) => vs.reduce((sum, i) => sum + fn(i), 0) / L;
    // Eye_Dark = the black eye, Eye_White = the donkey's small catchlight in it.
    if (mt === "Eye_Dark" || mt === "Eye_White") { cc.set(mt === "Eye_Dark" ? "#0b0908" : "#f2efe9"); return; }
    if (mt === "Hooves") { cc.copy(sHoof); return; }
    if (avg((i) => wOf(i, (b) => /^Ear[234]/.test(b))) > 0.15) { cc.copy(sFace); return; }   // the ears (Ear2-4) stay dark
    if (vs.every((i) => capSet.has(i)) || avg(woolW) > 0.45) {
      cc.copy(sWool).multiplyScalar(0.84 + 0.16 * hash(vs[0] * 31 + vs[1] * 7 + vs[2]));
      if (nn.y < -0.4) cc.multiplyScalar(0.9);
      return;
    }
    if (avg((i) => headW(i)) > 0.4) {
      cc.copy(vs.some((i) => eyeV.has(i)) ? sRing : sFace);
      return;
    }
    cc.copy(sLeg);
  };
  const knees = ["L", "R"].map((s) => W("FrontLowerLeg" + s));
  // Goat: one black-brown coat on the donkey's zones (lighter muzzle and
  // belly hair, darker mane line / tail), grey-brown ridged horns.
  const gCoat = new THREE.Color(PG.coat), gHorn = new THREE.Color(PG.hornColor);
  const goatPaint = (vs, mt, nn, cc) => {
    const L = vs.length;
    if (mt === "Eye_Dark") { cc.set("#070605"); return; }
    if (mt === "Eye_White") { cc.set("#f2efe9"); return; }
    if (mt === "Horn") { cc.copy(gHorn); return; }
    if (mt === "Horn2") { cc.copy(gHorn).multiplyScalar(0.8); return; }
    if (mt === "Beard") { cc.copy(gCoat).multiplyScalar(0.7); return; }
    if (mt === "Hooves") { cc.set("#15110e"); return; }
    cc.copy(gCoat);
    if (mt === "Main_Light") cc.lerp(new THREE.Color("#8a7361"), 0.45);
    if (mt === "Muzzle") cc.lerp(new THREE.Color("#8a7b6d"), 0.45);
    if (mt === "Main_Dark") cc.multiplyScalar(0.7);
    if (vs.some((i) => eyeVg.has(i))) cc.lerp(new THREE.Color("#9a8c7f"), 0.3);   // lid ring round the eye
    cc.multiplyScalar(0.94 + 0.12 * hash(vs[0] * 31 + vs[1] * 7 + vs[L - 1]));      // the pack's faint per-face variation
  };
  // Pig (Móng Cái): black back and head; the belly, the lower legs and a band
  // round the middle pale pink-white; a pinkish-grey snout disc.
  const pCoat = new THREE.Color(PQ.coat), pPale = new THREE.Color(PQ.pale);
  const pigPaint = (vs, mt, nn, cc) => {
    const L = vs.length, avg = (fn) => vs.reduce((sum, i) => sum + fn(i), 0) / L;
    if (mt === "Eye_Dark") {
      // pig2: the eye in bands, as your references — a white eye, a brown
      // iris, a black pupil (measured from each eye's own centre)
      if (PQ.sclera && pigEyes.length) {
        const c = V(); for (const i of vs) c.add(WP[i]); c.multiplyScalar(1 / L);
        const e = pigEyes.reduce((m, q) => (q.c.distanceTo(c) < m.c.distanceTo(c) ? q : m));
        const d = e.c.distanceTo(c) / e.r;
        cc.set(d > 0.62 ? PQ.sclera : d > 0.3 ? PQ.eyeColor : "#0b0706");
        return;
      }
      cc.set(PQ.eyeColor ?? "#070605"); return;
    }
    if (mt === "Eye_White") { cc.set("#f2efe9"); return; }
    if (mt === "Hooves") { cc.set("#2a2320"); return; }
    cc.copy(pCoat);
    if (PQ.pattern === "black") {
      if (PQ.eyeRing && mt !== "Eye_Dark" && vs.some((i) => eyeVg.has(i))) { cc.set(PQ.eyeRing); return; }   // lid ring
      if (nn.y < -0.35) cc.lerp(pPale, 0.6);                                           // paler underside
      if (avg((i) => wOf(i, (b) => /^Ear[234]/.test(b))) > 0.4 && nn.dot(fwd) > 0.2) cc.set(PQ.earIn ?? PQ.snout);   // inner ear
    }
    if (PQ.pattern === "mongcai") {
      const legs = avg((i) => wOf(i, (b) => /LowerLeg|FF|IK/.test(b)));
      const torso = avg((i) => wOf(i, (b) => b === "Back" || b.startsWith("Torso")));
      // the saddle: the middle third of the body, all the way round
      const along = avg((i) => (WP[i].dot(fwd) - pigSB) / (pigSF - pigSB));
      const saddle = torso > 0.4 && along > 0.28 && along < 0.62;
      if (legs > 0.5 || saddle || (torso > 0.4 && nn.y < -0.3)) cc.copy(pPale);
    }
    if (avg((i) => headW(i)) > 0.5 && avg((i) => { const d = WP[i].clone().sub(H); return d.dot(a); }) > 0.86 * LmP) cc.set(PQ.snout ?? "#6e5550");   // snout disc
    cc.multiplyScalar(0.95 + 0.1 * hash(vs[0] * 31 + vs[1] * 7 + vs[L - 1]));
  };
  const pigSB = W("Back").dot(fwd), pigSF = W("Torso3").dot(fwd);
  // Hyena (striped): sandy-grey coat, pale belly and legs, dark muzzle.
  const hCoat = new THREE.Color(PHY.coat), hDark = new THREE.Color(PHY.dark), hLight = new THREE.Color(PHY.light), hFace = new THREE.Color(PHY.face);
  // Dorcas gazelle: sandy fawn back, the dark flank band, white belly and
  // rump, a fawn face with the deer's dark markings, dark nose, black horns,
  // a black tail tip.
  const zCoat = new THREE.Color(PGZ.coat), zPale = new THREE.Color(PGZ.pale), zBand = new THREE.Color(PGZ.band), zFace = new THREE.Color(PGZ.face), zFore = new THREE.Color(PGZ.forehead);
  // each eye's centre (Eye_Dark vertices, by side): the face stripes start there
  const gzEyes = [];
  if (GAZELLE) {
    const ev = new Set(); for (const f of faces) if (fm(f) === "Eye_Dark") for (const i of fv(f)) ev.add(i);
    for (const sgn of [-1, 1]) {
      const ids = [...ev].filter((i) => Math.sign(WP[i].clone().sub(H).dot(hs)) === sgn);
      if (!ids.length) continue;
      const c = V(); for (const i of ids) c.add(WP[i]); gzEyes.push({ c: c.multiplyScalar(1 / ids.length) });
    }
  }
  const gazellePaint = (vs, mt, nn, cc) => {
    const L = vs.length, avg = (fn) => vs.reduce((sum, i) => sum + fn(i), 0) / L;
    const cen = V(); for (const i of vs) cen.add(WP[i]); cen.multiplyScalar(1 / L);
    if (mt === "Eye_Dark") { cc.set("#0d0a08"); return; }
    if (mt === "Eye_White") { cc.set("#ece6dc"); return; }
    if (mt === "Eye_Ring") { cc.copy(zFace).lerp(zPale, 0.45); return; }                 // a lighter ring round the eye (the deer's white one read as a cartoon)
    if (mt === "Horn") { cc.set(PGZ.hornColor); return; }
    if (mt === "Horn2") { cc.set(PGZ.hornRing); return; }                                // the rings, lighter: they must read
    const head = avg((i) => headW(i));
    if (mt === "Hooves") { cc.set(head > 0.5 ? PGZ.nose : "#1f1a17"); return; }
    if (avg((i) => wOf(i, (b) => /^Tail[23]/.test(b))) > 0.5) { cc.set("#1d1815"); return; }   // the black tail tip
    if (head > 0.5) {
      // fawn like the body, the deer's dark face zone only a rufous forehead
      cc.copy(mt === "Main_Dark" ? zFore : mt === "Main_Light" ? zPale : zFace);
      // the face stripes, measured from each eye (head frame, head lengths)
      const e = gzEyes.reduce((m2, q) => (!m2 || q.c.distanceTo(cen) < m2.c.distanceTo(cen) ? q : m2), null);
      if (e && (mt === "Main" || mt === "Main_Dark" || mt === "Main_Light")) {
        const d = cen.clone().sub(e.c), z = d.dot(a) / LmP, y = d.dot(hu) / LmP;
        const zAbs = cen.clone().sub(H).dot(a) / LmP;
        // how far out to its own side the face is (0 = the midline, 1 = the eye):
        // the stripes run down each SIDE of the face — across it they read as bars
        const side = cen.clone().sub(H).dot(hs) / (e.c.clone().sub(H).dot(hs) || 1);
        // they converge toward the nose: the band follows the eye's line inwards
        const lane = side - (1 - 0.55 * smoothstep01(0, 0.5, z));
        // The deer's facets are coarse: the white stripe takes the top row of
        // what was the dark band (a thinner band caught 2-3 faces and read as
        // nothing), and stays off the middle of the face (a bar across the
        // bridge from the front: only faces turned SIDEWAYS take it — tried live).
        if (z > -0.06 && y > -0.03 && y < 0.15 && lane > -0.45 && lane < 0.25 && side > 0.2 && Math.abs(nn.dot(hs)) > 0.12) cc.copy(zPale);   // white stripe above the eye line, to the nose
        else if (z > -0.02 && y <= 0.0 && y > -0.1 && lane > -0.1 && zAbs < 0.88) cc.copy(zBand); // dark stripe from the eye down the muzzle
        else if (zAbs > 0.8 && y < -0.1) cc.copy(zPale);                                           // white lips and chin
      }
    } else {
      // the neck is fawn all round (the deer's white throat strip read as a bib)
      const neck = avg((i) => wOf(i, (b) => b.startsWith("Neck")));
      cc.copy(mt === "Main_Light" && neck < 0.5 ? zPale : zCoat);
      const torso = avg((i) => wOf(i, (b) => b === "Back" || b === "Body" || b.startsWith("Torso")));
      if (torso > 0.4 && gzBand.lo !== undefined) {
        if (cen.y > gzBand.lo && cen.y < gzBand.hi && Math.abs(nn.dot(right)) > 0.25) cc.copy(zBand);   // the flank band
        else if (cen.y <= gzBand.lo) cc.copy(zPale);                                                   // the white belly
      }
    }
    cc.multiplyScalar(0.95 + 0.1 * hash(vs[0] * 31 + vs[1] * 7 + vs[L - 1]));
  };
  // Algerian donkey: coat, pale muzzle / eye rings / belly, the dark stripe
  // along the spine and its cross over the shoulders, dark mane and tuft.
  const dCoat = new THREE.Color(PDK.coat), dPale = new THREE.Color(PDK.pale), dDark = new THREE.Color(PDK.dark);
  const donkeyPaint = (vs, mt, nn, cc) => {
    const L = vs.length, avg = (fn) => vs.reduce((sum, i) => sum + fn(i), 0) / L;
    if (mt === "Eye_Dark") { cc.set("#120e0b"); return; }
    if (mt === "Eye_White") { cc.set("#e9e3da"); return; }
    if (mt === "Hooves") { cc.set(PDK.hoof); return; }
    if (mt === "Muzzle") { cc.set(PDK.nose); return; }
    if (mt === "Main_Dark") { cc.copy(dDark); return; }                               // mane, ear tips, tail tuft
    if (mt.startsWith("Basket")) {
      cc.set(mt === "Basket" ? PDK.basket : mt === "BasketLoad" ? "#6f5a3e" : PDK.basketDark);
      cc.multiplyScalar(0.92 + 0.16 * hash(vs[0] * 13 + vs[1] * 5));                   // the weave's unevenness
      return;
    }
    if (mt === "Blanket" || mt === "BlanketRim") {
      const cen = V(); for (const i of vs) cen.add(WP[i]); cen.multiplyScalar(1 / L);
      const sv = cen.dot(fwd), { sA, sB, bw, sM, rope, yLow, border } = dkLoad;
      cc.set(PDK.blanket);
      if (sv < sA + bw || sv > sB - bw) cc.set(PDK.blanketDark);                          // the end borders
      else if (sv < sA + 2 * bw || sv > sB - 2 * bw) cc.set(PDK.blanketBand);
      if (cen.y < yLow + border) cc.set(PDK.blanketCream);                               // the lower border
      if (Math.abs(sv - sM) < rope) cc.set(PDK.rope);                                    // the rope over it
      if (mt === "BlanketRim") cc.multiplyScalar(0.7);
      return;
    }
    cc.copy(mt === "Main_Light" ? dPale : dCoat);
    if (mt === "Main") {
      const cen = V(); for (const i of vs) cen.add(WP[i]); cen.multiplyScalar(1 / L);
      const torso = avg((i) => wOf(i, (b) => b === "Back" || b === "Body" || b.startsWith("Torso")));
      // the dorsal stripe: between its two planes, on top, rump to withers
      const lat = cen.dot(right) - dkStripe.mid, spine = torso + avg((i) => wOf(i, (b) => b.startsWith("Tail1") || b === "Neck1"));
      if (dkStripe.half && Math.abs(lat) < dkStripe.half && nn.y > 0.2 && spine > 0.5) cc.copy(dDark);
      // the shoulder cross: between its planes, down the upper shoulders
      if (dkStripe.crossHalf && torso > 0.3 && Math.abs(cen.dot(fwd) - dkStripe.s3) < dkStripe.crossHalf
        && (cen.y - W("Torso3").y) / A.Rv > -0.45 && nn.y > -0.2) cc.lerp(dDark, 0.85);
    }
    cc.multiplyScalar(0.95 + 0.1 * hash(vs[0] * 31 + vs[1] * 7 + vs[L - 1]));
  };
  // Striped: the flanks carry dark VERTICAL stripes, the legs horizontal
  // bands, the throat a black patch, the muzzle is dark, the crest darker.
  // One colour per face (from its centre), so the stripes follow the facets.
  const hSB = W("Back").dot(fwd), hSF = W("Torso3").dot(fwd);
  const hyenaPaint = (vs, mt, nn, cc) => {
    const L = vs.length, avg = (fn) => vs.reduce((sum, i) => sum + fn(i), 0) / L;
    if (mt === "Eye_Dark") { cc.set("#0b0806"); return; }
    if (mt === "Eye_White") { cc.set("#f2efe9"); return; }
    const cen = V(); for (const i of vs) cen.add(WP[i]); cen.multiplyScalar(1 / L);
    // the husky's dark zone is its nose AND its eyebrow / ear markings: only
    // the nose stays dark, the rest is face
    if (mt === "Muzzle") { const z = cen.clone().sub(H).dot(a) / Math.max(1e-6, LmP); cc.copy(z > 0.8 ? hDark : hFace); return; }
    cc.copy(hCoat).lerp(hLight, mt === "Main_Light" && avg((i) => headW(i)) <= 0.5 ? 0.5 : 0);
    const head = avg((i) => headW(i)), legs = avg((i) => wOf(i, (b) => /LowerLeg|UpperLeg|FF|IK|BackLeg/.test(b)));
    const torso = avg((i) => wOf(i, (b) => b === "Back" || b.startsWith("Torso")));
    const neck = avg((i) => wOf(i, (b) => b.startsWith("Neck")));
    if (head > 0.5) {
      const z = cen.clone().sub(H).dot(a) / Math.max(1e-6, LmP);
      cc.copy(hFace);                                                                   // grey-brown face (no husky mask)
      if (z > 0.55) cc.lerp(hDark, smoothstep01(0.55, 0.85, z) * 0.8);               // the dark muzzle
    } else if (neck > 0.4) {
      const { c, t } = nearest(neckJ, cen);
      const upN = UP.clone().addScaledVector(t, -UP.dot(t)).normalize(), dN = cen.clone().sub(c);
      const toHead = (nearest(neckJ, cen).s) / Math.max(1e-6, nearest(neckJ, W("Head")).s);
      if (dN.dot(upN) < -0.45 * dN.length() && toHead > 0.7) cc.copy(hDark);          // the black throat (under the jaw)
      else if (dN.dot(upN) > 0.6 * dN.length()) cc.lerp(hDark, 0.45);                // the crest
    } else if (avg((i) => wOf(i, (b) => /LowerLeg|FF|IK/.test(b))) > 0.5) {
      // thin horizontal bands down the legs (not the paws)
      const band = Math.sin((cen.y - A.ground0) / (0.075 * A.Rv) * Math.PI);
      if (band > 0.55 && cen.y > A.ground0 + 0.15 * A.Rv) cc.copy(hDark);
    } else {
      // the body: the stripe bands (every face between one stripe's two cuts)
      const inBand = hyBands.some(([nb, d0b, d1b]) => { const q = cen.dot(nb); return q > d0b && q < d1b; });
      if (nn.y > 0.8 && torso > 0.3) cc.lerp(hDark, 0.55);                              // the mane along the back
      else if (inBand && torso > 0.45 && nn.y > -0.7) cc.copy(hDark);
    }
    cc.multiplyScalar(0.95 + 0.1 * hash(vs[0] * 31 + vs[1] * 7 + vs[L - 1]));
  };
  // each eye's centre and radius (Eye_Dark vertices, split by side)
  const pigEyes = [];
  if (PIG) {
    const ev = new Set(); for (const f of faces) if (fm(f) === "Eye_Dark") for (const i of fv(f)) ev.add(i);
    for (const sgn of [-1, 1]) {
      const ids = [...ev].filter((i) => Math.sign(WP[i].clone().sub(W("Head")).dot(right)) === sgn);
      if (!ids.length) continue;
      const c = V(); for (const i of ids) c.add(WP[i]); c.multiplyScalar(1 / ids.length);
      let r = 0; for (const i of ids) r = Math.max(r, WP[i].distanceTo(c));
      pigEyes.push({ c, r });
    }
  }
  let LmP = 0;
  for (let i = 0; i < WP.length; i++) if (headW(i) > 0.5) LmP = Math.max(LmP, WP[i].clone().sub(H).dot(a));
  const eyeVg = new Set();
  for (const f of faces) if (fm(f) === "Eye_Dark") for (const i of fv(f)) eyeVg.add(i);
  const c = new THREE.Color(), n = V(), e1 = V(), e2 = V();
  let topY = -Infinity, swapped = 0;
  for (const p of WP) topY = Math.max(topY, p.y);
  for (const f of faces) {
    const vs = fv(f), mt = fm(f), L = vs.length;
    // Newell normal: the face's own plane, shared by both of a quad's triangles.
    n.set(0, 0, 0);
    for (let k = 0; k < L; k++) {
      const p0 = WP[vs[k]], p1 = WP[vs[(k + 1) % L]];
      n.x += (p0.y - p1.y) * (p0.z + p1.z); n.y += (p0.z - p1.z) * (p0.x + p1.x); n.z += (p0.x - p1.x) * (p0.y + p1.y);
    }
    n.normalize();
    const cen = V();
    for (const i of vs) cen.add(WP[i]);
    cen.multiplyScalar(1 / L);
    c.copy(PAL[mt] ?? baseC);
    if (SHEEP) sheepPaint(vs, mt, n, c); else if (GOAT) goatPaint(vs, mt, n, c); else if (PIG) pigPaint(vs, mt, n, c); else if (HYENA) hyenaPaint(vs, mt, n, c); else if (DONKEY) donkeyPaint(vs, mt, n, c); else if (GAZELLE) gazellePaint(vs, mt, n, c); else {
    // The donkey's pale throat / chest zone, stretched by the long neck,
    // reads as a white collar: coat colour there, pale only on belly + legs.
    if (mt === "Main_Light") {
      const tt = Math.max(...vs.map((i) => wOf(i, (b) => b.startsWith("Neck") || b === "Head" || b === "Torso3")));
      c.lerp(baseC, smoothstep01(0.2, 0.6, tt));
    }
    const hl = vs.reduce((sum, i) => sum + lift[i], 0) / L;
    const avgW = (pred) => vs.reduce((sum, i) => sum + wOf(i, pred), 0) / L;
    if (mt === "Main" || mt === "Main_Light") {
      // Throat band: one clean pale stripe down the underside of the neck,
      // chin to chest (both references have it), cut along the quads.
      if (avgW((b) => b.startsWith("Neck") || b === "Torso3" || b === "Head") > 0.45) {
        const { c: cc, t: tt2 } = nearest(neckJ, cen);
        const upN = UP.clone().addScaledVector(tt2, -UP.dot(tt2)).normalize();
        const dN = cen.clone().sub(cc);
        if (dN.dot(upN) < -0.45 * dN.length()) c.copy(lightC);
      }
      // Hair: the hump crown and the top of the shoulders darker, shaggier.
      if (hl > 0.35 * Hh) c.lerp(darkC, 0.38);
      else if (n.y > 0.55 && avgW((b) => b === "Torso3" || b === "Torso2") > 0.5) c.lerp(darkC, 0.18);
      // Paler lower legs.
      if (avgW((b) => /LowerLeg/.test(b)) > 0.5) c.lerp(lightC, 0.35);
    }
    if (mt !== "Sole" && knees.some((k) => k.distanceTo(cen) < 0.13 * A.Rv)) c.copy(callusC);
    }
    const rough = mt.startsWith("Eye") ? 0.2 : 0.9;
    // pig2: a BENT quad split on v0-v2 can leave one triangle wound
    // backwards — culled, a see-through slit — while the quad's own normal
    // (every check above) looks fine: found by a ray through the slit behind
    // the ear. Split such a quad on the other diagonal (v1-v3) instead.
    let vq = vs;
    if (PIG2 && L === 4) {
      const tn = (x, y, z) => WP[y].clone().sub(WP[x]).cross(WP[z].clone().sub(WP[x])).normalize().dot(n);
      const a02 = Math.min(tn(vs[0], vs[1], vs[2]), tn(vs[0], vs[2], vs[3])), a13 = Math.min(tn(vs[1], vs[2], vs[3]), tn(vs[1], vs[3], vs[0]));
      if (a02 < 0 && a13 > a02) { vq = [vs[1], vs[2], vs[3], vs[0]]; swapped++; }
    }
    // fan; a quad's diagonal (v0-v2) is hidden in the wireframe
    for (let k = 1; k < L - 1; k++) {
      const tri = [vq[0], vq[k], vq[k + 1]];
      const hide = [0, 0, 0];
      if (L === 4) { if (k === 1) hide[1] = 1; else hide[2] = 1; }
      tri.forEach((i, ci) => {
        const e = [ci === 0 ? 1 : 0, ci === 1 ? 1 : 0, ci === 2 ? 1 : 0].map((b, j) => b + hide[j]);
        G.add(WP[i], n, c, 0, rough, 1, WS[i], 0, e);
      });
      G.idx.push(G.count - 3, G.count - 2, G.count - 1);
    }
  }
  if (PIG2) { window.__pig2Swapped = swapped; console.log(`[pig2-morph] bent quads split on their other diagonal: ${swapped}`); }
  return { topY, curlR: A.Rv };
}

function smoothstep01(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

// Camels PACE: both legs on one side swing together — the rolling sway —
// where the donkey walks with diagonal pairs. Re-time the donkey's Walk:
// find each hoof's swing phase (first harmonic of its height over the
// cycle), time-shift the FRONT legs' tracks so each front leg swings with
// the hind leg on its own side, and roll the body gently toward the side
// that stands. Logs the phases before/after — a measurement, not a guess.
function footHeights(tpl, clip, N) {
  const r = cloneSkinned(tpl.root);
  const Bs = {};
  r.traverse((o) => { if (o.isBone) Bs[o.name] = o; });
  const mixer = new THREE.AnimationMixer(r);
  mixer.clipAction(clip).play();
  const ys = tpl.feet.map(() => []);
  for (let k = 0; k < N; k++) {
    mixer.setTime((clip.duration * k) / N);
    r.updateMatrixWorld(true);
    tpl.feet.forEach((f, i) => ys[i].push(Bs[f.bone].localToWorld(f.local.clone()).y));
  }
  mixer.stopAllAction();
  return ys;
}
const swingPhase = (ys) => {
  let sx = 0, sy = 0;
  ys.forEach((y, i) => { const an = (2 * Math.PI * i) / ys.length; sx += y * Math.cos(an); sy += y * Math.sin(an); });
  return ((Math.atan2(sy, sx) / (2 * Math.PI)) % 1 + 1) % 1;
};
function paceWalk(tpl, rollDeg = 3) {
  const clip = tpl.clips.find((c) => c.name === "Walk");
  if (!clip) return null;
  const N = 120, T = clip.duration;
  const wrap = (x) => ((x % 1) + 1.5) % 1 - 0.5;                    // → [-0.5, 0.5)
  const ph0 = footHeights(tpl, clip, N).map(swingPhase);            // FL, FR, BL, BR
  const shift = { L: wrap(ph0[2] - ph0[0]), R: wrap(ph0[3] - ph0[1]) };
  for (const tr of clip.tracks) {
    const node = tr.name.slice(0, tr.name.lastIndexOf("."));
    // the front legs AND their feet (IK + FF bones: the hoof flex) — the feet
    // left on the donkey's beat flexed at the wrong time and floated
    const m = /^(?:Front(?:Shoulder|UpperLeg|LowerLeg)|IKFrontLeg|FF)([LR])$/.exec(node);
    if (!m) continue;
    const dt = shift[m[1]] * T;                                     // new(t) = old(t − dt)
    const it = tr.createInterpolant(), w = tr.getValueSize();
    const vals = new tr.values.constructor(tr.values.length);
    for (let k = 0; k < tr.times.length; k++) {
      const out = it.evaluate((((tr.times[k] - dt) % T) + T) % T);
      for (let c = 0; c < w; c++) vals[k * w + c] = out[c];
    }
    tr.values = vals;
  }
  const ph1 = footHeights(tpl, clip, N).map(swingPhase);
  // Roll toward the standing side: the left pair stands half a cycle
  // after it swings. +angle about fwd tilts the top toward +right, and
  // the L legs sit on −right, so leaning left is a negative angle.
  let body = null;
  tpl.root.traverse((o) => { if (o.isBone && o.name === "Body") body = o; });
  const bodyTr = clip.tracks.find((tr) => tr.name === "Body.quaternion");
  if (body && bodyTr && rollDeg) {
    const axis = tpl.fwd.clone().applyQuaternion(body.parent.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
    const standL = (ph1[2] + 0.5) % 1, amp = THREE.MathUtils.degToRad(rollDeg);
    const q = new THREE.Quaternion(), r = new THREE.Quaternion();
    const vals = bodyTr.values.slice();
    for (let k = 0; k < bodyTr.times.length; k++) {
      const roll = -amp * Math.cos(2 * Math.PI * (bodyTr.times[k] / T - standL));
      r.setFromAxisAngle(axis, roll);
      q.fromArray(vals, k * 4).premultiply(r).normalize().toArray(vals, k * 4);
    }
    bodyTr.values = vals;
  }
  const f2 = (x) => x.toFixed(2);
  tpl.paceShift = shift;                                           // feetFollow reads the paced timing
  const res = {
    before: { FLvsBL: f2(wrap(ph0[0] - ph0[2])), FRvsBR: f2(wrap(ph0[1] - ph0[3])), LvsR: f2(wrap(ph0[2] - ph0[3])) },
    after: { FLvsBL: f2(wrap(ph1[0] - ph1[2])), FRvsBR: f2(wrap(ph1[1] - ph1[3])), LvsR: f2(wrap(ph1[2] - ph1[3])) },
  };
  console.log("[pace] phase gaps (cycles; 0 = together, ±0.5 = opposite)", JSON.stringify(res));
  window.__pace = res;
  return res;
}

// A planted hoof slides backwards at exactly the ground speed of the
// in-place clip. Sample the clip, keep frames where a hoof is at its
// lowest, take the median backward speed.
// Keep the animal OUT of the ground. The clips were made for the donkey's
// body; a wider animal (wool) lying down (Death) or kneeling sinks where
// the donkey just touches. For every key of every clip: skin the mesh,
// find its lowest point, and if it is under the ground raise the Body
// bone by that much at that key. Only lifts, only past a tolerance.
// Per clip key: where is each donkey IK foot bone relative to its own
// lower-leg bone (donkey clip, donkey rig)? Put the animal's IK bone at
// that spot on the animal's lower leg (same clip time) — its rotation
// track (the hoof flex) is kept as it is.
const DONKEY_REFS = new Map();                         // per source rig
function donkeyRef() {
  if (DONKEY_REFS.has(gltf)) return DONKEY_REFS.get(gltf);
  const r = cloneSkinned(gltf.scene); r.traverse((o) => { if (o.isMesh) o.visible = false; });
  const b = {}; r.traverse((o) => { if (o.isBone) b[o.name] = o; });
  const ref = { r, b, mixer: new THREE.AnimationMixer(r) };
  DONKEY_REFS.set(gltf, ref);
  return ref;
}
function feetFollow(tpl, legs, off = { F: 0, B: 0 }) {
  const PAIRS = [["FrontLowerLegL", "IKFrontLegL"], ["FrontLowerLegR", "IKFrontLegR"], ["BackLowerLegL", "IKBackLegL"], ["BackLowerLegR", "IKBackLegR"]];
  const r = cloneSkinned(tpl.root), Bn = {};
  r.traverse((o) => { if (o.isBone) Bn[o.name] = o; });
  const mixer = new THREE.AnimationMixer(r), D = donkeyRef();
  let n = 0;
  for (const clip of tpl.clips) {
    const dclip = gltf.animations.find((c) => c.name === clip.name);
    if (!dclip) continue;
    const a = mixer.clipAction(clip).reset().play(), da = D.mixer.clipAction(dclip).reset().play();
    for (const [leg, ik] of PAIRS) {
      const tr = clip.tracks.find((t) => t.name === ik + ".position");
      if (!tr) continue;
      const vals = tr.values.slice();
      for (let k = 0; k < tr.times.length; k++) {
        const t = tr.times[k];
        // a paced clip: the front feet follow the donkey foot of the SHIFTED time
        const dtS = clip.name === "Walk" && tpl.paceShift && leg.startsWith("Front") ? tpl.paceShift[leg.slice(-1)] * dclip.duration : 0;
        const td = dtS ? (((t - dtS) % dclip.duration) + dclip.duration) % dclip.duration : t;
        D.mixer.setTime(Math.min(td, dclip.duration)); D.r.updateMatrixWorld(true);
        const dl = D.b[leg].worldToLocal(D.b[ik].getWorldPosition(V()));
        dl.y += ((typeof legs === "function" ? legs(leg) : legs) - 1) * A.ext[leg] + (leg.startsWith("Front") ? off.F : off.B);
        mixer.setTime(t); r.updateMatrixWorld(true);
        const w = Bn[leg].localToWorld(dl);
        Bn[ik].parent.worldToLocal(w).toArray(vals, k * 3);
        n++;
      }
      tr.values = vals;
    }
    a.stop(); da.stop();
  }
  mixer.stopAllAction(); D.mixer.stopAllAction();
  return n;
}

// THE CAMEL'S FRONT FEET, PLANTED — by leg IK. With FK clips a planted foot
// swings on an arc round the shoulder; the camel's legs are 1.3x the donkey's,
// so the arc is bigger than the donkey's body motion cancels, and during its
// stance the front foot rose 5-10 cm (measured per key; the front feet were
// planted 7-13% of the walk against 43% behind — the donkey ~57%). Body bob and
// chest re-timing were tried and measured: they only traded front for back.
// At every Walk key where a front foot is near the ground, a two-bone IK bends
// the shoulder (upper leg) and knee (lower leg) so the foot lands exactly on
// the ground; the weight fades out as the foot lifts into its swing.
function plantFrontFeet(tpl, legs) {
  const clip = tpl.clips.find((c) => c.name === "Walk");
  if (!clip) return null;
  const r = cloneSkinned(tpl.root);
  let mesh = null; r.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
  const Bn = {}; r.traverse((o) => { if (o.isBone) Bn[o.name] = o; });
  const names = mesh.skeleton.bones.map((b) => b.name);
  const G2 = mesh.geometry, SI = G2.attributes.skinIndex, SW = G2.attributes.skinWeight, n = G2.attributes.position.count;
  const grp = Array.from({ length: n }, (_, i) => {
    let best = -1, bw = 0; for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > bw) { bw = w; best = SI.getComponent(i, c); } }
    const nm = names[best] ?? "";
    if (/^FF[LR]$/.test(nm) || /^IKFrontLeg/.test(nm) || /^FrontLowerLeg/.test(nm)) return nm.slice(-1);
    return null;
  });
  const mix = new THREE.AnimationMixer(r); mix.clipAction(clip).play();
  const b0 = 0.055 * tpl.height0, b1 = 0.085 * tpl.height0, q = V();   // full plant below ~11 cm on a 2 m camel (its measured stance), fading to ~17
  const wq = new THREE.Quaternion(), pq = new THREE.Quaternion(), dq = new THREE.Quaternion();
  const turn = (bone, from, to) => {          // rotate a bone (world) so direction `from` becomes `to`
    dq.setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
    bone.getWorldQuaternion(wq); bone.parent.getWorldQuaternion(pq);
    bone.quaternion.copy(pq.invert().multiply(dq.multiply(wq)));
    bone.updateMatrixWorld(true);
  };
  let keys = 0, most = 0;
  for (const sd of ["L", "R"]) {
    const up = Bn["FrontUpperLeg" + sd], lo = Bn["FrontLowerLeg" + sd];
    const tu = clip.tracks.find((t) => t.name === "FrontUpperLeg" + sd + ".quaternion");
    const tl = clip.tracks.find((t) => t.name === "FrontLowerLeg" + sd + ".quaternion");
    if (!tu || !tl) continue;
    const vu = tu.values.slice(), vl = tl.values.slice();
    const tipL = V(0, A.ext["FrontLowerLeg" + sd] * legs, 0);
    for (let k = 0; k < tu.times.length; k++) {
      const t = tu.times[k];
      const kl = tl.times.findIndex((x) => Math.abs(x - t) < 1e-5);
      if (kl < 0) continue;
      mix.setTime(t); r.updateMatrixWorld(true); mesh.skeleton.update();
      let h = Infinity;
      for (let i = 0; i < n; i += 2) { if (grp[i] !== sd) continue; mesh.getVertexPosition(i, q); q.applyMatrix4(mesh.matrixWorld); if (q.y < h) h = q.y; }
      const w = 1 - smoothstep01(b0, b1, h);
      if (!(h > 1e-4) || w <= 0) continue;
      const hip = up.getWorldPosition(V()), knee = lo.getWorldPosition(V()), tip = lo.localToWorld(tipL.clone());
      const target = tip.clone(); target.y -= h * w;
      const L1 = hip.distanceTo(knee), L2 = knee.distanceTo(tip);
      const nrm = knee.clone().sub(hip).cross(tip.clone().sub(hip));
      if (nrm.lengthSq() < 1e-12) continue;
      nrm.normalize();
      const d = Math.min(L1 + L2 - 1e-4, Math.max(Math.abs(L1 - L2) + 1e-4, hip.distanceTo(target)));
      const dir = target.clone().sub(hip).normalize();
      const ang = Math.acos(Math.min(1, Math.max(-1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d))));
      const kA = hip.clone().addScaledVector(dir.clone().applyAxisAngle(nrm, ang), L1);
      const kB = hip.clone().addScaledVector(dir.clone().applyAxisAngle(nrm, -ang), L1);
      const newKnee = kA.distanceTo(knee) < kB.distanceTo(knee) ? kA : kB;    // keep the knee bending its own way
      turn(up, knee.clone().sub(hip), newKnee.clone().sub(hip));
      const k2 = lo.getWorldPosition(V()), tip2 = lo.localToWorld(tipL.clone());
      turn(lo, tip2.clone().sub(k2), target.clone().sub(k2));
      up.quaternion.toArray(vu, k * 4); lo.quaternion.toArray(vl, kl * 4);
      keys++; most = Math.max(most, h * w);
    }
    tu.values = vu; tl.values = vl;
  }
  mix.stopAllAction();
  console.log(`[camel] front legs IK-planted: ${keys} keys, feet lowered up to ${(100 * most).toFixed(1)} cm`);
  return { keys, mostCm: +(100 * most).toFixed(1) };
}

function hoofLows(tpl) {
  const r = cloneSkinned(tpl.root);
  let mesh = null; r.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
  const clip = tpl.clips.find((c) => c.name === "Walk");
  const out = { FL: 0, FR: 0, BL: 0, BR: 0 };
  if (!mesh || !clip) return out;
  const names = mesh.skeleton.bones.map((b) => b.name);
  const G2 = mesh.geometry, SI = G2.attributes.skinIndex, SW = G2.attributes.skinWeight, n = G2.attributes.position.count;
  const grp = Array.from({ length: n }, (_, i) => {
    let best = -1, bw = 0; for (let c = 0; c < 4; c++) { const w = SW.getComponent(i, c); if (w > bw) { bw = w; best = SI.getComponent(i, c); } }
    const nm = names[best] ?? "";
    if (/^FFB[LR]$/.test(nm) || /^IKBackLeg/.test(nm) || /^BackLowerLeg/.test(nm)) return "B" + nm.slice(-1);
    if (/^FF[LR]$/.test(nm) || /^IKFrontLeg/.test(nm) || /^FrontLowerLeg/.test(nm)) return "F" + nm.slice(-1);
    return null;
  });
  for (const k in out) out[k] = Infinity;
  const mix = new THREE.AnimationMixer(r); mix.clipAction(clip).play();
  const q = V();
  for (let k = 0; k < 60; k++) {
    mix.setTime((clip.duration * k) / 60); r.updateMatrixWorld(true); mesh.skeleton.update();
    for (let i = 0; i < n; i += 2) { const g = grp[i]; if (!g) continue; mesh.getVertexPosition(i, q); q.applyMatrix4(mesh.matrixWorld); if (q.y < out[g]) out[g] = q.y; }
  }
  mix.stopAllAction();
  return out;
}

function groundClamp(tpl, tolM = 0.015) {
  const r = cloneSkinned(tpl.root);
  let mesh = null, body = null;
  r.traverse((o) => { if (o.isSkinnedMesh) mesh = o; if (o.isBone && o.name === "Body") body = o; });
  r.updateMatrixWorld(true);
  const mixer = new THREE.AnimationMixer(r);
  const pos = mesh.geometry.attributes.position, stride = 5, q = V();
  // three's getVertexPosition rebuilds bone × inverse for every vertex: ~3 s
  // of boot for the six species (audit 2026-10-03). The same sum with each
  // bone's matrix built once per pose (bone · boneInverse · bindMatrix), then
  // only the world-y row of matrixWorld · bindMatrixInverse — the formula of
  // SkinnedMesh.applyBoneTransform, regrouped. window.__slowClamp = the old.
  const bones = mesh.skeleton.bones, inv = mesh.skeleton.boneInverses;
  const fast = !mesh.geometry.morphAttributes.position?.length && !window.__slowClamp;
  // Read through the attributes once (normalized weights, interleaving).
  const SIa = mesh.geometry.attributes.skinIndex, SWa = mesh.geometry.attributes.skinWeight;
  const P = new Float32Array(pos.count * 3), SI = new Uint16Array(pos.count * 4), SW = new Float32Array(pos.count * 4);
  if (fast) for (let i = 0; i < pos.count; i++) {
    P[i * 3] = pos.getX(i); P[i * 3 + 1] = pos.getY(i); P[i * 3 + 2] = pos.getZ(i);
    for (let c = 0; c < 4; c++) { SI[i * 4 + c] = SIa.getComponent(i, c); SW[i * 4 + c] = SWa.getComponent(i, c); }
  }
  const BM = new Float32Array(bones.length * 12), _m = new THREE.Matrix4(), _r = new THREE.Matrix4();
  const lowest = () => {
    r.updateMatrixWorld(true);
    mesh.skeleton.update();
    let lo = Infinity;
    if (!fast) {
      for (let i = 0; i < pos.count; i += stride) {
        mesh.getVertexPosition(i, q);
        q.applyMatrix4(mesh.matrixWorld);
        if (q.y < lo) lo = q.y;
      }
      return lo;
    }
    for (let b = 0; b < bones.length; b++) {
      const e = _m.multiplyMatrices(bones[b].matrixWorld, inv[b]).multiply(mesh.bindMatrix).elements, o = b * 12;
      BM[o] = e[0]; BM[o + 1] = e[4]; BM[o + 2] = e[8]; BM[o + 3] = e[12];
      BM[o + 4] = e[1]; BM[o + 5] = e[5]; BM[o + 6] = e[9]; BM[o + 7] = e[13];
      BM[o + 8] = e[2]; BM[o + 9] = e[6]; BM[o + 10] = e[10]; BM[o + 11] = e[14];
    }
    const w = _r.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).elements;
    const r0 = w[1], r1 = w[5], r2 = w[9], r3 = w[13];   // the world-y row
    for (let i = 0; i < pos.count; i += stride) {
      const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let c = 0; c < 4; c++) {
        const wt = SW[i * 4 + c];
        if (wt === 0) continue;
        const o = SI[i * 4 + c] * 12;
        sx += wt * (BM[o] * px + BM[o + 1] * py + BM[o + 2] * pz + BM[o + 3]);
        sy += wt * (BM[o + 4] * px + BM[o + 5] * py + BM[o + 6] * pz + BM[o + 7]);
        sz += wt * (BM[o + 8] * px + BM[o + 9] * py + BM[o + 10] * pz + BM[o + 11]);
      }
      const y = r0 * sx + r1 * sy + r2 * sz + r3;
      if (y < lo) lo = y;
    }
    return lo;
  };
  const report = {};
  for (const clip of tpl.clips) {
    const tr = clip.tracks.find((t) => t.name === "Body.position");
    if (!tr) continue;
    // the IK foot bones hang from the rig ROOT, not from Body: lift them by
    // the same amount or the hooves/pads stay behind while the legs rise
    const ikTr = clip.tracks.filter((t) => /^IK(Front|Back)Leg[LR]\.position$/.test(t.name));
    const ikVals = ikTr.map((t) => t.values.slice());
    const act = mixer.clipAction(clip);
    act.reset().play();
    const vals = tr.values.slice();
    let worst = 0, fixed = 0;
    // Pass 1: how deep is the lowest point at each key?
    const K = tr.times.length, need = new Float64Array(K);
    for (let k = 0; k < K; k++) { mixer.setTime(tr.times[k]); need[k] = Math.max(0, -lowest()); }
    // Pass 2: a SMOOTH lift that is never less than the need. Lifting each key
    // by exactly its own depth made corners (the lowest point jumps from hoof
    // to hoof, or to the belly) — the legs visibly stepped (measured: the pig's
    // hind-hoof kink 15 → 28). Widen (max over ±w keys), then box-blur ±w:
    // every blurred value averages windows that all contain the key → ≥ need.
    // Only the SLOW LOOPING clips (walk, idles, eating — where a step shows,
    // and the hover this costs measured <= 1 cm, 3.5 cm on the camel). Every
    // other clip (gallop, death, attacks, jumps) keeps the exact per-key lift:
    // smoothing them made a dying sheep hover 27 cm before it landed.
    const loop = /^(Walk|Idle|Idle_2|Idle_Headlow|Eating)$/.test(clip.name);
    const w = loop ? Math.max(1, Math.round(K * 0.06)) : 0;
    if (!loop) for (let k = 0; k < K; k++) if (need[k] <= tolM) need[k] = 0;   // the old rule, exactly
    const at = (arr, j) => (loop ? arr[((j % K) + K) % K] : arr[Math.min(K - 1, Math.max(0, j))]);
    const wide = Float64Array.from({ length: K }, (_, k) => { let m = 0; for (let j = k - w; j <= k + w; j++) m = Math.max(m, at(need, j)); return m; });
    const lift = Float64Array.from({ length: K }, (_, k) => { let sum = 0; for (let j = k - w; j <= k + w; j++) sum += at(wide, j); return sum / (2 * w + 1); });
    for (let k = 0; k < K; k++) {
      mixer.setTime(tr.times[k]);
      r.updateMatrixWorld(true);
      const lo = -lift[k];
      if (lift[k] > 1e-5) {
        // world lift → Body's parent space (includes the root's scale)
        const bw = body.getWorldPosition(V());
        const la = body.parent.worldToLocal(bw.clone()), lb = body.parent.worldToLocal(bw.clone().add(V(0, -lo, 0)));
        const d = lb.sub(la);
        vals[k * 3] += d.x; vals[k * 3 + 1] += d.y; vals[k * 3 + 2] += d.z;
        ikTr.forEach((t, j) => {
          let kk = k;
          if (t.times[kk] !== tr.times[k]) { kk = t.times.findIndex((x) => Math.abs(x - tr.times[k]) < 1e-5); if (kk < 0) return; }
          const pw = new THREE.Vector3(); const ikb = r.getObjectByName(t.name.split(".")[0]);
          const la2 = ikb.parent.worldToLocal(pw.set(0, 0, 0)), lb2 = ikb.parent.worldToLocal(new THREE.Vector3(0, -lo, 0)).sub(la2);
          ikVals[j][kk * 3] += lb2.x; ikVals[j][kk * 3 + 1] += lb2.y; ikVals[j][kk * 3 + 2] += lb2.z;
        });
        worst = Math.min(worst, -need[k]); if (need[k] > tolM) fixed++;
      }
    }
    act.stop();
    tr.values = vals;
    ikTr.forEach((t, j) => { t.values = ikVals[j]; });
    // how much the smoothing lifts ABOVE the need somewhere (a hoof could hover by this)
    let hover = 0; for (let k = 0; k < K; k++) hover = Math.max(hover, lift[k] - need[k]);
    if (fixed) report[clip.name] = { keys: fixed, deepest_m: +(-worst).toFixed(3), hover_m: +hover.toFixed(3) };
  }
  mixer.stopAllAction();
  console.log("[ground] lifted out of the ground:", JSON.stringify(report));
  window.__groundFix = report;
  return report;
}

function measureGroundSpeed(tpl, clipName) {
  const clip = tpl.clips.find((c) => c.name === clipName);
  if (!clip) return 0;
  const r = cloneSkinned(tpl.root);
  const Bs = {};
  r.traverse((o) => { if (o.isBone) Bs[o.name] = o; });
  const mixer = new THREE.AnimationMixer(r);
  mixer.clipAction(clip).play();
  const N = Math.max(40, Math.round(clip.duration * 120)), dt = clip.duration / N;
  const tracks = tpl.feet.map(() => []);
  for (let s = 0; s <= N; s++) {
    mixer.setTime(s * dt);
    r.updateMatrixWorld(true);
    tpl.feet.forEach((f, i) => tracks[i].push(Bs[f.bone].localToWorld(f.local.clone())));
  }
  const speeds = [], perFoot = [];
  for (const arr of tracks) {
    const before = speeds.length;
    const ys = arr.map((p) => p.y), lo = Math.min(...ys), hi = Math.max(...ys);
    const thr = lo + (hi - lo) * 0.1 + 1e-5;
    for (let s = 0; s < N; s++) {
      if (arr[s].y < thr && arr[s + 1].y < thr) speeds.push(-arr[s + 1].clone().sub(arr[s]).dot(tpl.fwd) / dt);
    }
    const mine = speeds.slice(before).sort((x, y) => x - y);
    perFoot.push(mine.length ? +mine[mine.length >> 1].toFixed(2) : 0);
  }
  mixer.stopAllAction();
  (window.__speedPerFoot ??= {})[clipName] = perFoot;   // FL, FR, BL, BR — should agree, else feet slide
  speeds.sort((x, y) => x - y);
  return speeds.length ? Math.max(0, speeds[speeds.length >> 1]) : 0;
}

// ── For the games ────────────────────────────────────────────────────────────
const KIND_PARAMS = { goat: () => PG, sheep: () => P, camel: () => PC, pig: () => PPIG, pig2: () => PPIG2, hyena: () => PHY, donkey: () => PDK, gazelle: () => PGZ };
/**
 * A species as a crowd template: { root, source, clips, walkSpeed, runSpeed,
 * height }. `source` is a SkinnedMesh with position / normal / skin / colour
 * (the donkey-pack format the crowd skinning reads), bound at identity; the
 * clips are the species' own (re-proportioned, ground-clamped, feet following).
 */
export function createMorphTemplate(kind, overrides = {}) {
  if (!gltf) throw new Error("animalMorph: call initAnimalMorph(donkeyGltf) first");
  const Qk = KIND_PARAMS[kind]?.() ?? P;
  const prevSpecies = SPECIES.value, prevActive = STYLE.active, prevQ = { ...Qk };
  SPECIES.value = `${kind}-morph`;
  STYLE.active = true;
  Object.assign(Qk, overrides);                     // a game's own breed (colours, size…)
  let tpl;
  try { tpl = buildAnimal(); } finally { SPECIES.value = prevSpecies; STYLE.active = prevActive; Object.assign(Qk, prevQ); }
  const root = tpl.root;
  // Its full height (horns, ears, head) at the built size: the crowd sizes by it.
  root.updateMatrixWorld(true);
  const height = new THREE.Box3().setFromObject(tpl.mesh).getSize(V()).y;
  // The crowd places and sizes each animal itself: an unscaled root, feet at 0.
  root.scale.setScalar(1); root.position.set(0, 0, 0); root.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const g0 = tpl.mesh.geometry, g = new THREE.BufferGeometry();
  for (const n of ["position", "normal", "skinIndex", "skinWeight"]) g.setAttribute(n, g0.getAttribute(n));
  g.setAttribute("color", g0.getAttribute("aCol"));
  g.setIndex(g0.index);
  g.computeBoundingSphere();
  const mesh = new THREE.SkinnedMesh(g, defaultMaterial());
  mesh.name = `${kind}Template`;
  root.remove(tpl.mesh);
  root.add(mesh);
  mesh.bind(new THREE.Skeleton(tpl.mesh.skeleton.bones, tpl.mesh.skeleton.boneInverses), new THREE.Matrix4());
  return {
    root, source: mesh, clips: tpl.clips, kind,
    walkSpeed: tpl.speed.Walk, runSpeed: tpl.speed.Gallop, height,
    health: { openEdges: window.__morphOpenEdges?.open, flips: window.__flips?.final?.flips, hoofFlex: tpl.hoofFlex?.animal },
  };
}

export { analyzeDonkey, buildAnimal, measureGroundSpeed };
