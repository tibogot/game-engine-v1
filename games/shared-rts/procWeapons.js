// Procedural small arms for the RTS soldiers — low-poly, vertex-coloured.
//
// Seen from an RTS camera a rifle is a few pixels wide, so what has to be right
// is its SILHOUETTE: length, where the wood ends, the magazine, the muzzle. Each
// weapon is a few boxes, tapered blocks and 8-sided cylinders (~150–250 tris),
// flat-shaded, one material for all of them (colour per vertex).
//
// FRAME (every builder): metres; the origin is where the RIGHT HAND closes
// (the stock's wrist, or the pistol grip); +Z toward the muzzle, +Y up, +X to
// the soldier's left. That is the frame of the soldier's WEAPON bone, which
// tools/packMixamo.mjs adds under the right hand and aims, per clip, at the
// left hand — so a weapon hung on it sits in both hands.
//
// Sizes are from the real weapons (overall length, barrel, magazine), rounded.
import * as THREE from "three";

const COLORS = {
  wood: 0x6e4526,     // MAS 49/56 beech/walnut, oiled
  darkWood: 0x55361f, // MAS 36, older and darker
  metal: 0x2d2e2f,    // phosphated steel
  bakelite: 0x2a2320, // MAT 49 grip
};

// ── Primitive builders: each returns { pos: number[], col: number[] } ────────
// Positions are unindexed triangles so every face gets a flat normal.

function part(color) { return { pos: [], col: [], color: new THREE.Color(color) }; }

function tri(p, a, b, c) {
  p.pos.push(...a, ...b, ...c);
  for (let i = 0; i < 3; i++) p.col.push(p.color.r, p.color.g, p.color.b);
}
function quad(p, a, b, c, d) { tri(p, a, b, c); tri(p, a, c, d); }

/**
 * A six-faced block between two cross-sections along Z (a tapered stock, a
 * forestock). Each section: { z, top, bot, w, x = 0 }.
 */
function block(color, back, front) {
  const p = part(color);
  const c = (s, sx, sy) => [(s.x ?? 0) + sx * s.w / 2, sy > 0 ? s.top : s.bot, s.z];
  const b0 = c(back, -1, -1), b1 = c(back, 1, -1), b2 = c(back, 1, 1), b3 = c(back, -1, 1);
  const f0 = c(front, -1, -1), f1 = c(front, 1, -1), f2 = c(front, 1, 1), f3 = c(front, -1, 1);
  quad(p, b0, b3, b2, b1); // back
  quad(p, f0, f1, f2, f3); // front
  quad(p, b3, f3, f2, b2); // top
  quad(p, b0, b1, f1, f0); // bottom
  quad(p, b1, b2, f2, f1); // +x
  quad(p, b0, f0, f3, b3); // -x
  return p;
}

/** Axis-aligned box from its centre and size. */
function box(color, [x, y, z], [w, h, d]) {
  return block(color, { z: z - d / 2, top: y + h / 2, bot: y - h / 2, w, x }, { z: z + d / 2, top: y + h / 2, bot: y - h / 2, w, x });
}

/** Cylinder along Z at (x, y), z0 → z1, radius r (or r → r1 for a cone). */
function cyl(color, x, y, z0, z1, r, r1 = r, segs = 8) {
  const p = part(color);
  const ring = (z, rad) => Array.from({ length: segs }, (_, i) => {
    const a = (i / segs) * Math.PI * 2;
    return [x + Math.cos(a) * rad, y + Math.sin(a) * rad, z];
  });
  const A = ring(z0, r), B = ring(z1, r1);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % segs;
    quad(p, A[i], A[j], B[j], B[i]);
    if (i > 0 && i < segs - 1) { tri(p, A[0], A[j], A[i]); tri(p, B[0], B[i], B[j]); }
  }
  return p;
}

/** Rotate a part about the X axis (a tilted magazine or grip) around a pivot. */
function tiltX(p, angle, [py, pz]) {
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let i = 0; i < p.pos.length; i += 3) {
    const y = p.pos[i + 1] - py, z = p.pos[i + 2] - pz;
    p.pos[i + 1] = py + y * c - z * s;
    p.pos[i + 2] = pz + y * s + z * c;
  }
  return p;
}

function toGeometry(parts) {
  const pos = parts.flatMap((p) => p.pos), col = parts.flatMap((p) => p.col);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

// ── The weapons ─────────────────────────────────────────────────────────────

/** MAS 49/56 — the French army's semi-auto rifle in Algeria. 1.02 m, 10-round box. */
function mas49_56() {
  const W = COLORS.wood, M = COLORS.metal, bore = 0.045;
  return toGeometry([
    // Buttstock: deep at the butt, slim at the wrist, comb just under the bore.
    block(W, { z: -0.33, top: 0.03, bot: -0.105, w: 0.042 }, { z: -0.02, top: 0.035, bot: -0.022, w: 0.036 }),
    box(M, [0, -0.037, -0.334], [0.043, 0.135, 0.008]),               // butt plate
    box(W, [0, -0.034, -0.005], [0.032, 0.03, 0.05]),                 // semi-pistol swell under the wrist
    // Receiver, magazine, trigger.
    box(M, [0, 0.048, 0.12], [0.034, 0.054, 0.24]),
    tiltX(box(M, [0, -0.04, 0.11], [0.028, 0.075, 0.07]), 0.08, [0, 0.11]),
    box(M, [0, -0.034, 0.045], [0.008, 0.005, 0.06]),                 // trigger guard
    box(M, [0, -0.022, 0.03], [0.006, 0.02, 0.006]),                  // trigger
    box(M, [-0.026, 0.056, 0.16], [0.02, 0.01, 0.018]),               // charging handle (left side)
    box(M, [0, 0.082, 0.215], [0.022, 0.016, 0.03]),                  // rear sight
    // Wood forward: forestock under the barrel, handguard on top.
    block(W, { z: 0.02, top: 0.03, bot: -0.016, w: 0.04 }, { z: 0.46, top: 0.036, bot: 0.004, w: 0.033 }),
    box(W, [0, 0.058, 0.35], [0.03, 0.024, 0.18]),
    box(M, [0, 0.032, 0.3], [0.044, 0.066, 0.012]),                   // barrel bands
    box(M, [0, 0.036, 0.445], [0.038, 0.058, 0.012]),
    // Barrel, grenade-launcher muzzle, front sight with its ears.
    cyl(M, 0, bore, 0.24, 0.63, 0.011),
    cyl(M, 0, bore, 0.62, 0.69, 0.015),
    cyl(M, 0, bore, 0.652, 0.664, 0.018),
    box(M, [0, 0.07, 0.6], [0.006, 0.026, 0.01]),
    box(M, [0.009, 0.07, 0.6], [0.003, 0.03, 0.014]),
    box(M, [-0.009, 0.07, 0.6], [0.003, 0.03, 0.014]),
  ]);
}

/** MAT 49 — the 9 mm submachine gun of NCOs, paras and crews. Stock out: 0.72 m. */
function mat49() {
  const M = COLORS.metal, G = COLORS.bakelite, bore = 0.072;
  return toGeometry([
    tiltX(box(G, [0, -0.005, 0], [0.03, 0.1, 0.04]), -0.26, [0.04, 0]), // pistol grip, raked back
    box(M, [0, 0.074, 0.07], [0.046, 0.056, 0.3]),                     // stamped receiver
    box(M, [0, 0.03, 0.125], [0.034, 0.04, 0.05]),                     // magazine well (it folds forward)
    tiltX(box(M, [0, -0.08, 0.125], [0.022, 0.18, 0.034]), 0.2, [0.01, 0.125]), // magazine, raked forward
    box(M, [0, 0.036, 0.048], [0.008, 0.005, 0.06]),                   // trigger guard
    cyl(M, 0, bore, 0.22, 0.36, 0.02),                                  // perforated barrel jacket
    cyl(M, 0, bore, 0.36, 0.4, 0.008),
    box(M, [0, 0.102, 0.34], [0.006, 0.02, 0.01]),                     // front sight
    box(M, [0, 0.106, -0.04], [0.02, 0.012, 0.02]),                    // rear sight
    // Wire stock, extended.
    block(M, { z: -0.32, top: 0.052, bot: 0.046, w: 0.006, x: 0.02 }, { z: -0.08, top: 0.086, bot: 0.08, w: 0.006, x: 0.02 }),
    block(M, { z: -0.32, top: 0.052, bot: 0.046, w: 0.006, x: -0.02 }, { z: -0.08, top: 0.086, bot: 0.08, w: 0.006, x: -0.02 }),
    box(M, [0, 0.03, -0.325], [0.048, 0.085, 0.01]),                   // butt plate
  ]);
}

/** MAS 36 — bolt-action, 1.02 m; the ALN carried many (captured or from depots). */
function mas36() {
  const W = COLORS.darkWood, M = COLORS.metal, bore = 0.045;
  return toGeometry([
    block(W, { z: -0.33, top: 0.028, bot: -0.1, w: 0.042 }, { z: -0.02, top: 0.034, bot: -0.02, w: 0.035 }),
    box(M, [0, -0.036, -0.334], [0.043, 0.128, 0.008]),
    box(M, [0, 0.048, 0.1], [0.03, 0.036, 0.2]),                       // receiver
    box(M, [0.03, 0.035, 0.025], [0.03, 0.008, 0.01]),                 // bolt handle, right side, bent forward
    box(M, [0.046, 0.022, 0.035], [0.014, 0.014, 0.014]),              // bolt knob
    box(M, [0, -0.024, 0.11], [0.022, 0.012, 0.06]),                   // floorplate (internal magazine)
    box(M, [0, -0.028, 0.045], [0.008, 0.005, 0.05]),                  // trigger guard
    box(M, [0, 0.074, 0.19], [0.02, 0.016, 0.03]),                     // rear sight on the receiver bridge
    // Long one-piece wood to near the muzzle.
    block(W, { z: 0.02, top: 0.03, bot: -0.014, w: 0.039 }, { z: 0.55, top: 0.036, bot: 0.006, w: 0.03 }),
    box(W, [0, 0.056, 0.38], [0.028, 0.022, 0.3]),
    box(M, [0, 0.034, 0.34], [0.042, 0.062, 0.012]),
    box(M, [0, 0.036, 0.54], [0.036, 0.056, 0.03]),                    // front band
    cyl(M, 0, bore, 0.22, 0.69, 0.009),
    cyl(M, 0, 0.02, 0.55, 0.63, 0.006),                                 // bayonet tube under the barrel
    box(M, [0, 0.062, 0.675], [0.006, 0.022, 0.01]),
  ]);
}

/**
 * FM 24/29 — the French section's light machine gun (from memory: 1.08 m,
 * 25-round box magazine on TOP, pistol grip, bipod near the muzzle, carrying
 * handle). The top magazine and the bipod make it the most recognisable gun in
 * a section from the RTS camera. Origin at the pistol grip.
 */
function fm2429() {
  const W = COLORS.wood, M = COLORS.metal, bore = 0.055;
  return toGeometry([
    block(W, { z: -0.36, top: 0.045, bot: -0.085, w: 0.04 }, { z: -0.07, top: 0.05, bot: 0.0, w: 0.036 }), // butt
    box(M, [0, -0.02, -0.362], [0.041, 0.13, 0.008]),                              // butt plate
    tiltX(box(W, [0, -0.035, 0], [0.028, 0.09, 0.04]), -0.3, [0.01, 0]),           // pistol grip
    box(M, [0, 0.055, 0.1], [0.042, 0.065, 0.34]),                                 // receiver
    box(M, [0, 0.012, 0.035], [0.008, 0.005, 0.06]),                               // trigger guard
    tiltX(box(M, [0, 0.16, 0.13], [0.03, 0.15, 0.075]), 0.35, [0.09, 0.13]),       // curved top magazine
    box(W, [0, 0.04, 0.35], [0.038, 0.035, 0.14]),                                 // forestock
    cyl(M, 0, bore, 0.27, 0.64, 0.012),                                             // barrel
    cyl(M, 0, 0.028, 0.27, 0.56, 0.007),                                            // gas tube
    cyl(M, 0, bore, 0.62, 0.67, 0.012, 0.018),                                      // flash hider
    box(M, [0, 0.095, 0.3], [0.012, 0.03, 0.05]),                                  // carrying handle
    box(M, [0, 0.078, 0.62], [0.006, 0.03, 0.01]),                                 // front sight
    // bipod, folded back along the barrel
    block(M, { z: 0.34, top: 0.034, bot: 0.028, w: 0.006, x: 0.016 }, { z: 0.6, top: 0.05, bot: 0.044, w: 0.006, x: 0.012 }),
    block(M, { z: 0.34, top: 0.034, bot: 0.028, w: 0.006, x: -0.016 }, { z: 0.6, top: 0.05, bot: 0.044, w: 0.006, x: -0.012 }),
  ]);
}

/**
 * Mauser Kar 98k — bolt action, 1.11 m; many reached the ALN (from memory:
 * through Egypt, Tunisia, Morocco). Its tell: the barrel shows well past a
 * short handguard, a turned-DOWN bolt handle, a flush floorplate.
 */
function mauser98() {
  const W = 0x7a4a2a, M = COLORS.metal, bore = 0.045;
  return toGeometry([
    block(W, { z: -0.34, top: 0.028, bot: -0.105, w: 0.043 }, { z: -0.02, top: 0.034, bot: -0.022, w: 0.035 }),
    box(M, [0, -0.038, -0.344], [0.044, 0.132, 0.008]),
    box(M, [0, 0.048, 0.1], [0.03, 0.036, 0.2]),                        // receiver
    box(M, [0.028, 0.03, 0.035], [0.028, 0.008, 0.01]),                 // bolt handle, turned down
    box(M, [0.042, 0.012, 0.038], [0.016, 0.016, 0.016]),               // bolt knob
    box(M, [0, -0.02, 0.11], [0.022, 0.008, 0.07]),                     // flush floorplate
    box(M, [0, -0.026, 0.045], [0.008, 0.005, 0.05]),                   // trigger guard
    block(W, { z: 0.02, top: 0.03, bot: -0.014, w: 0.039 }, { z: 0.5, top: 0.035, bot: 0.006, w: 0.03 }),
    box(W, [0, 0.056, 0.3], [0.028, 0.022, 0.2]),                       // short upper handguard
    box(M, [0, 0.036, 0.36], [0.041, 0.06, 0.012]),                     // barrel band
    box(M, [0, 0.034, 0.49], [0.036, 0.055, 0.03]),                     // nose cap
    cyl(M, 0, bore, 0.2, 0.74, 0.0095),                                  // barrel, long past the wood
    box(M, [0, 0.064, 0.725], [0.012, 0.018, 0.012]),                   // hooded front sight
  ]);
}

/**
 * SMLE (Lee-Enfield No. 1 Mk III) — 1.13 m; the ALN had many (from memory).
 * Its tells: wood to the muzzle with a snub nose cap, and a 10-round box
 * magazine hanging under the receiver.
 */
function enfield() {
  const W = 0x6b4125, M = COLORS.metal, bore = 0.045;
  return toGeometry([
    block(W, { z: -0.33, top: 0.026, bot: -0.1, w: 0.042 }, { z: -0.02, top: 0.032, bot: -0.03, w: 0.034 }),
    box(M, [0, -0.035, -0.334], [0.043, 0.128, 0.008]),
    box(M, [0, 0.046, 0.1], [0.03, 0.036, 0.2]),                        // receiver
    box(M, [0.03, 0.05, 0.01], [0.03, 0.008, 0.01]),                    // bolt handle, straight out
    box(M, [0.046, 0.05, 0.012], [0.016, 0.016, 0.016]),
    tiltX(box(M, [0, -0.04, 0.12], [0.026, 0.07, 0.07]), 0.12, [0, 0.12]), // box magazine
    box(M, [0, -0.028, 0.04], [0.008, 0.005, 0.05]),
    block(W, { z: 0.02, top: 0.03, bot: -0.014, w: 0.039 }, { z: 0.66, top: 0.036, bot: 0.012, w: 0.03 }), // to the muzzle
    box(W, [0, 0.057, 0.4], [0.028, 0.022, 0.5]),                       // full upper handguard
    box(M, [0, 0.036, 0.66], [0.036, 0.05, 0.03]),                      // snub nose cap
    box(M, [0, 0.036, 0.4], [0.041, 0.058, 0.012]),                     // band
    cyl(M, 0, bore, 0.66, 0.69, 0.0095),
    box(M, [0, 0.07, 0.668], [0.01, 0.022, 0.012]),                     // front sight ears
  ]);
}

export const WEAPONS = {
  mas49_56: { label: "MAS 49/56", faction: "French — rifle", build: mas49_56 },
  mat49: { label: "MAT 49", faction: "French — SMG (NCO, paras)", build: mat49 },
  mas36: { label: "MAS 36", faction: "ALN — bolt rifle", build: mas36 },
  fm2429: { label: "FM 24/29", faction: "French — section LMG", build: fm2429 },
  mauser98: { label: "Mauser 98k", faction: "ALN — bolt rifle", build: mauser98 },
  enfield: { label: "Lee-Enfield", faction: "ALN — bolt rifle", build: enfield },
};

/**
 * A long-handled shovel for the digging clip, in the weapon frame: origin at
 * the right hand, +Z toward the left hand, the blade beyond it (the lower hand
 * in a dig is nearer the blade). ~1 m, a D-grip at the top.
 */
function shovel() {
  const wood = 0x8a6440, steel = 0x4a4c4a;
  return toGeometry([
    cyl(wood, 0, 0, -0.2, 0.62, 0.016),                                  // handle
    box(wood, [0, 0, -0.235], [0.1, 0.02, 0.02]),                       // D-grip crossbar
    block(steel, { z: 0.6, top: 0.012, bot: -0.012, w: 0.05 }, { z: 0.66, top: 0.006, bot: -0.006, w: 0.19 }), // socket
    block(steel, { z: 0.66, top: 0.006, bot: -0.006, w: 0.2 }, { z: 0.9, top: 0.003, bot: -0.003, w: 0.17 }),  // blade
  ]);
}

/** Tools the soldier bones can carry (the TOOL bone shows one per clip). */
export const TOOLS = { shovel: { label: "Shovel", build: shovel } };

/** The shape helpers, for other low-poly kit (soldierLooks.js headgear). */
export const prim = { part, tri, quad, block, box, cyl, tiltX, toGeometry };

/** One material for every weapon: the colour is per vertex. */
export function weaponMaterial() {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.25, name: "weapon" });
}
