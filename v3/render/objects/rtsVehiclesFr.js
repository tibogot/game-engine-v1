/**
 * FRENCH VEHICLES, 1954-62 — the playable side's vehicles in the Algeria game,
 * on the same parts kit as the American ones (rtsVehicles.js VEHICLE_KIT):
 * hull and running gear as two geometries (the gear rolls in the vertex
 * shader from the unit's odometer), one atlas material, markings on the
 * stencil sheet's French half. Real metres, scaled by 1.3 at the end. Front is
 * +Z, origin at the ground centre.
 *
 *   · PANHARD EBR — the armoured car of the war in Algeria: a boat-shaped hull
 *     with a driver at EACH end (it drives as fast backwards as forwards), four
 *     big tyred wheels at the corners and four steel wheels in the middle that
 *     come down for rough ground, and the FL-11 oscillating turret with its
 *     long 75 mm gun
 *   · WILLYS MB — the jeep the French army had by the thousand from 1944: the
 *     slotted grille, flat front fenders, windscreen folded down on the bonnet
 *     (the djebel way), spare wheel and jerrycan on the tail, a .30 on its
 *     pedestal behind the seats; a driver and a gunner in khaki
 *   · SUD-AVIATION ALOUETTE II — the ALAT's turbine helicopter, the first of
 *     its kind, flying casualties and commandos out of the djebel: the glass
 *     BUBBLE cabin (see-through, crew inside), the solid centre body, the
 *     bare Artouste turbine up top with its big exhaust, the long OPEN
 *     LATTICE tail boom with its hoop skid, three blades, long low skids
 *   · AMX-13 — the French light tank: low hull, engine and driver side by
 *     side up front, the FL-10 OSCILLATING turret set far back with its long
 *     75 mm overhanging the nose and the big autoloader bustle behind
 *   · M3 HALF-TRACK — the armoured personnel carrier of every mechanised
 *     column: the armoured bonnet and roller bumper, wheels in front, a
 *     track unit behind, the open armoured box with its men and a .50
 *   · GMC CCKW 353 — the 2½-ton 6x6 the convoys ran on: long bonnet, the
 *     rounded "banjo" front wings, the closed steel cab, dual rear wheels, and
 *     the canvas tilt over the bed (the big khaki shape that reads from above)
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";
import { VEHICLE_KIT } from "./rtsVehicles.js";

const { S, indexed, axleX, alongZ, trackBand, trackPath, packGear, loftSkin, skinAt, skinPatch, tube, blade } = VEHICLE_KIT;

/**
 * A track run for one side at x = xc: the band round `wheelsZ` from sprocket
 * to idler, the road wheels (rubber, disc, hub, bolts), sprocket teeth, the
 * idler, return rollers. Pushes into G (the rolling gear). Real metres.
 */
function trackSide(G, { xc, tw, t, wheelR, wheelsZ, sprocket, idler, rollers = null, paintTone, d2 = false, bogies = null, frameY = 0.72 }) {
  const path = trackPath({ front: sprocket, rear: idler, wheelsZ, wheelR, t, rollers });
  G(indexed(trackBand(path, xc, tw, t)), [0, 0, 0], MAT.steel, 0.03, undefined, [0, 0, 0, 2]);
  const wheel = (cy, cz, r) => [cy, cz, r, 1];
  for (const z of wheelsZ) {
    const w = wheel(wheelR + t, z, wheelR);
    G(d2 ? tyre(wheelR, tw * 0.8, wheelR * 0.6, 14, true) : axleX(wheelR, tw * 0.8, 16), [xc, wheelR + t, z], MAT.rubber, 0.5, undefined, w);
    G(axleX(wheelR * 0.62, tw * 0.82, 12), [xc, wheelR + t, z], MAT.paint, paintTone, undefined, w);
    G(axleX(0.07, tw * 0.9, 8), [xc, wheelR + t, z], MAT.steel, 0.3, undefined, w);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      G(buildBox(tw * 0.88, 0.035, 0.035), [xc, wheelR + t + Math.sin(a) * wheelR * 0.4, z + Math.cos(a) * wheelR * 0.4], MAT.steel, 0.35, undefined, w);
    }
  }
  const sw = wheel(sprocket.c[1], sprocket.c[0], sprocket.r);
  G(axleX(sprocket.r - 0.03, tw * 0.7, 16), [xc, sprocket.c[1], sprocket.c[0]], MAT.paint, paintTone, undefined, sw);
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    G(buildBox(tw * 0.6, 0.07, 0.07), [xc, sprocket.c[1] + Math.sin(a) * (sprocket.r - 0.01), sprocket.c[0] + Math.cos(a) * (sprocket.r - 0.01)], MAT.steel, 0.25, [a, 0, 0], sw);
  }
  const iw = wheel(idler.c[1], idler.c[0], idler.r);
  G(d2 ? tyre(idler.r, tw * 0.8, idler.r * 0.6, 14, true) : axleX(idler.r, tw * 0.8, 16), [xc, idler.c[1], idler.c[0]], MAT.rubber, 0.45, undefined, iw);
  G(axleX(idler.r * 0.6, tw * 0.82, 12), [xc, idler.c[1], idler.c[0]], MAT.paint, paintTone, undefined, iw);
  for (const r of rollers ?? []) G(axleX(r.r, tw * 0.5, 10), [xc, r.y, r.z], MAT.rubber, 0.4, undefined, wheel(r.y, r.z, r.r));
  // BOGIES (detail 2, the reference photos): each pair of road wheels on a bracket inboard of
  // them, hung from the frame on an arm — the M3's two-bogie run, not a row of loose wheels.
  const still = [0, 0, 0, 0], inX = xc - Math.sign(xc) * tw * 0.62, cy = wheelR + t;
  for (const [za, zb] of bogies ?? []) {
    const zm = (za + zb) / 2;
    G(roundedPlate(0.07, 0.2, Math.abs(za - zb) + 0.16, 0.025), [inX, cy + 0.03, zm], MAT.paint, paintTone * 0.85, undefined, still);
    G(buildBox(0.09, frameY - cy, 0.14), [inX, (frameY + cy) / 2 + 0.05, zm], MAT.paint, paintTone * 0.8, undefined, still);
    G(axleX(0.06, 0.12, 10), [inX - Math.sign(xc) * 0.02, cy + 0.06, zm], MAT.steel, 0.25, undefined, still);   // the pivot
  }
}

/** Per-part tone of the painted panels (the kit's OD tone, as the US vehicles). */
const VA = 0.15;

/**
 * DETAIL 2 (the vehicle lab, 2026-10-06 — "less low-poly"): an armour PLATE with its edges
 * rounded a few cm (they catch the light, as real plate does: a razor box edge is what reads
 * as low-poly), its UVs in metres from the position like buildBox's (the atlas tiles at size).
 */
function roundedPlate(w, h, d, r = 0.028) {
  const rr = Math.min(r, Math.min(w, h, d) * 0.45);
  const g = new RoundedBoxGeometry(w, h, d, 2, rr);
  // UVs as buildBox's: each face's 0..1 scaled to its size in metres (/2). A position-based
  // projection switched axis on the rounded edges and smeared the atlas there (white dashes).
  const uv = g.attributes.uv, span = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  if (g.groups.length) {
    const done = new Set();
    for (const grp of g.groups) {
      const [a, b] = span[grp.materialIndex] ?? [1, 1];
      for (let k = grp.start; k < grp.start + grp.count; k++) {
        const vi = g.index ? g.index.getX(k) : k;
        if (done.has(vi)) continue;
        done.add(vi);
        uv.setXY(vi, (uv.getX(vi) * a) / 2, (uv.getY(vi) * b) / 2);
      }
    }
  }
  return g.index ? g : indexed(g);   // (RoundedBoxGeometry has no index; the kit merges indexed parts)
}
/**
 * A TYRE (detail 2; you, 2026-10-06: "those vertical lines look bad"): a cylinder's flat caps
 * stretched the whole rubber cell across the sidewall — its stripes, a metre wide. Turned from
 * a profile instead: the sidewall bulging out of the rim to a rounded shoulder, the tread flat;
 * UVs a few cm of the cell, so the rubber reads plain. Axis along X, indexed.
 */
function tyre(R, w, rim = R * 0.58, seg = 28, lite = false) {
  const h = w / 2, prof = (lite
    // LITE (the truck: ten wheels): the sidewall's bulge and the shoulder in 6 rings, not 10.
    ? [[rim, -h * 0.9], [R - 0.05, -h], [R, -h * 0.55], [R, h * 0.55], [R - 0.05, h], [rim, h * 0.9]]
    : [
      [rim, -h * 0.9], [rim + (R - rim) * 0.45, -h], [R - 0.045, -h * 0.94], [R - 0.012, -h * 0.72], [R, -h * 0.42],
      [R, h * 0.42], [R - 0.012, h * 0.72], [R - 0.045, h * 0.94], [rim + (R - rim) * 0.45, h], [rim, h * 0.9],
    ]).map(([r, y]) => new THREE.Vector2(r, y));   // this order faces OUT (checked: 504 / 504)
  const g = new THREE.LatheGeometry(prof, seg).rotateZ(Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.45 + uv.getX(i) * 0.06, 0.45 + uv.getY(i) * 0.03);   // mid-cell: its edge is pale
  return g;
}
/**
 * The TREAD of a tyre(R, w) (you, 2026-10-06: "from close the wheels look bad" — loose plates
 * stood off the round tyre like a cog's teeth): chevron BARS that lie ON the tyre, each from just
 * past the centre line over the shoulder and down the sidewall, following its curve and sunk 1 cm
 * into it. Alternate bars start from either side (the NDT's staggered chevron). Axis along X.
 */
function chevronTread(R, w, { bars = 30, depth = 0.016, skew = 0.22, fill = 0.42 } = {}) {
  const h = w / 2;
  // The tyre's surface (tyre()'s profile, one half), centre → shoulder → sidewall: [y, r].
  const half = [[0, R], [h * 0.42, R], [h * 0.72, R - 0.012], [h * 0.94, R - 0.045]];
  const pos = [];
  const at = (y, r, a) => [y, Math.cos(a) * r, Math.sin(a) * r];
  const pitch = (Math.PI * 2) / bars, wA = pitch * fill;
  for (let k = 0; k < bars; k++) {
    const s = k % 2 ? 1 : -1, a0 = k * pitch;
    // Sections along the bar: from 0.15 h past the centre (on the far side) out to the sidewall.
    const prof = [[-0.15 * h, R], ...half.slice(1)].map(([y, r]) => [s * y, r]);
    const sec = prof.map(([y, r]) => {
      const a = a0 + skew * (y * s) / h;
      return [at(y, r - 0.01, a - wA / 2), at(y, r + depth, a - wA / 2), at(y, r + depth, a + wA / 2), at(y, r - 0.01, a + wA / 2)];
    });
    const tris = [];
    const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d]);
    for (let j = 0; j < sec.length - 1; j++) {
      const A = sec[j], B = sec[j + 1];
      quad(A[1], B[1], B[2], A[2]);   // top
      quad(A[0], B[0], B[1], A[1]);   // one flank
      quad(A[2], B[2], B[3], A[3]);   // the other
    }
    const f = sec[0], l = sec[sec.length - 1];
    quad(f[0], f[1], f[2], f[3]);
    quad(l[0], l[1], l[2], l[3]);
    // Every face OUT of its own bar: wound so its normal points away from the bar's centre.
    const all = sec.flat(), cen = [0, 1, 2].map((i) => all.reduce((t, q) => t + q[i], 0) / all.length);
    for (const [p0, p1, p2] of tris) {
      const e1 = [0, 1, 2].map((i) => p1[i] - p0[i]), e2 = [0, 1, 2].map((i) => p2[i] - p0[i]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const m = [0, 1, 2].map((i) => (p0[i] + p1[i] + p2[i]) / 3 - cen[i]);
      pos.push(...p0, ...(n[0] * m[0] + n[1] * m[1] + n[2] * m[2] >= 0 ? [...p1, ...p2] : [...p2, ...p1]));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const uv = new Float32Array((pos.length / 3) * 2).fill(0.47);
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return indexed(g);
}
/**
 * A COMBAT RIM (detail 2), turned: the lip at the tyre's bead, the dished face, the raised ring
 * the bolts sit on, the domed hub cap — both faces. Axis along X, the bead at radius `rim`.
 */
function combatRim(rim, w, seg = 14, lite = false) {
  const h = w / 2;
  // LITE: the inner face flat, the outer face's lip, dish, bolt ring and cap in 10 rings.
  const prof = (lite ? [
    [0.001, -h * 0.75], [rim, -h * 0.9], [rim, h * 0.9], [rim + 0.008, h * 0.98], [rim * 0.9, h * 0.75],
    [rim * 0.66, h * 0.5], [rim * 0.5, h * 0.62], [rim * 0.36, h * 0.5], [rim * 0.24, h * 0.88], [0.001, h * 0.95],
  ] : [
    [0.001, -h * 0.75], [0.06, -h * 0.72], [0.13, -h * 0.62], [rim - 0.02, -h * 0.8], [rim + 0.008, -h * 0.98], [rim, -h * 0.9],
    [rim, h * 0.9], [rim + 0.008, h * 0.98], [rim - 0.02, h * 0.8], [rim * 0.74, h * 0.48], [rim * 0.62, h * 0.6],
    [rim * 0.52, h * 0.62], [rim * 0.44, h * 0.52], [rim * 0.34, h * 0.5], [rim * 0.28, h * 0.82], [rim * 0.16, h * 0.95], [0.001, h * 0.98],
  ]).map(([r, y]) => new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(prof, seg).rotateZ(Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.45 + uv.getX(i) * 0.05, 0.45 + uv.getY(i) * 0.05);
  return g;
}
/** A small part's UVs moved to the middle of its atlas cell (near 0 they sample the pale edge). */
function midCell(g) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.45 + uv.getX(i) * 0.2, 0.45 + uv.getY(i) * 0.2);
  return g;
}
/** A jerrycan: the can, its three-bar handle, the pressed X a shade darker. */
function jerrycan(P, x, y, z, rotY = 0, tone = 0.42) {
  P(roundedPlate(0.3, 0.44, 0.15, 0.02), [x, y, z], MAT.paint, tone, [0, rotY, 0]);
  P(buildBox(0.16, 0.04, 0.05), [x, y + 0.24, z], MAT.paint, tone * 0.85, [0, rotY, 0]);
}

/**
 * "Vert armée" under the Aurès sun: the atlas's olive paint multiplied by this
 * (rtsObjectMaterialTinted). The US olive drab went LIME in this light; the
 * French green was browner and duller to begin with.
 * OLIVE BRUN (the vehicle lab, 2026-10-06, against photos of French M3s). First (92, 88, 62):
 * red over green, and the blue sky in the shade turned it lilac; now green just over red.
 * The old [0.74, 0.66, 0.5] kept almost no blue and still read yellow-green in the sun; it is
 * FR_PAINT_TINT_OLD, a button in the lab while the choice is open.
 */
export const FR_PAINT_TINT = [0.62, 0.58, 0.81];   // ~ (86, 89, 58): green kept over red, or the shade goes LILAC (lab, measured)
export const FR_PAINT_TINT_OLD = [0.74, 0.66, 0.5];

// ── PANHARD EBR ──────────────────────────────────────────────────────────────

/**
 * The hull, lofted: symmetric fore and aft (the EBR has no back), a pointed
 * boat nose at both ends, flat-sided, the widest point at the middle. Boxy
 * superellipse sections (n 5-6) so the plates read as plates.
 */
const EBR_HULL = [
  { z: 2.78, cy: 0.98, w: 0.34, h: 0.18, hb: 0.22, n: 4.0 },
  { z: 2.55, cy: 1.02, w: 0.72, h: 0.36, hb: 0.44, n: 5.0 },
  { z: 2.1, cy: 1.08, w: 0.86, h: 0.56, hb: 0.56, n: 6.0 },
  { z: 1.2, cy: 1.12, w: 0.9, h: 0.64, hb: 0.6, n: 6.0 },
  { z: 0.0, cy: 1.12, w: 0.9, h: 0.66, hb: 0.6, n: 6.0 },
  { z: -1.2, cy: 1.12, w: 0.9, h: 0.64, hb: 0.6, n: 6.0 },
  { z: -2.1, cy: 1.08, w: 0.86, h: 0.56, hb: 0.56, n: 6.0 },
  { z: -2.55, cy: 1.02, w: 0.72, h: 0.36, hb: 0.44, n: 5.0 },
  { z: -2.78, cy: 0.98, w: 0.34, h: 0.18, hb: 0.22, n: 4.0 },
];

export function buildEBR({ seed = 75, detail = 1 } = {}) {
  // DETAIL 2 (the vehicle lab, 2026-10-07): the corner wheels on the turned tyre with its chevron
  // tread and a combat rim (the cylinder's caps stretched the rubber into stripes). 1 = the game's.
  const D2 = detail >= 2;
  const R = rng(seed);
  const hull = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const deck = 1.12 + 0.66;               // hull top

  // ── Hull ────────────────────────────────────────────────────────────────────
  P(loftSkin(EBR_HULL, { segs: 32, sub: 4 }), [0, 0, 0], MAT.paint, VA);
  // The deck plate over the middle, a hair proud, and the turret ring under it.
  P(buildBox(1.5, 0.05, 2.6), [0, deck + 0.005, 0], MAT.paint, VA * 1.05);
  P(new THREE.CylinderGeometry(0.86, 0.9, 0.12, 24), [0, deck + 0.06, 0], MAT.paint, VA * 0.95);
  // A driver at each end: hatch, three vision blocks, a headlight pair in guards.
  for (const e of [1, -1]) {
    const z = e * 2.05;
    P(buildBox(0.62, 0.08, 0.5), [0.25, deck - 0.1, z], MAT.paint, VA * 1.1, [e * -0.35, 0, 0]);
    for (let k = -1; k <= 1; k++) P(buildBox(0.14, 0.08, 0.05), [0.25 + k * 0.18, deck - 0.02, z + e * 0.28], MAT.steel, 0.05, [e * -0.35, 0, 0]);
    for (const sx of [-1, 1]) {
      P(new THREE.CylinderGeometry(0.09, 0.1, 0.14, 12).rotateX(Math.PI / 2), [sx * 0.55, 1.36, e * 2.5], MAT.steel, 0.15);
      P(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.55, 1.36, e * 2.58], MAT.white, 0.45);
      P(tube([[sx * 0.44, 1.28, e * 2.48], [sx * 0.46, 1.5, e * 2.6], [sx * 0.64, 1.5, e * 2.6], [sx * 0.66, 1.28, e * 2.48]], 0.02, 8, 5), [0, 0, 0], MAT.steel, 0.3);
    }
    // Towing eyes low on each nose.
    for (const sx of [-1, 1]) P(new THREE.TorusGeometry(0.07, 0.025, 5, 10), [sx * 0.3, 0.84, e * 2.62], MAT.steel, 0.25);
  }
  // Stowage bins along both sides over the middle wheels, and on them what a
  // crew carries: jerrycans, a pick and a shovel, a rolled tarpaulin.
  for (const sx of [-1, 1]) {
    P(buildBox(0.3, 0.42, 1.9), [sx * 1.02, 1.42, 0], MAT.paint, VA * 0.95);
    P(buildBox(0.34, 0.04, 1.96), [sx * 1.03, 1.65, 0], MAT.paint, VA * 1.1);
    for (let k = 0; k < 3; k++) P(buildBox(0.16, 0.44, 0.32), [sx * 1.25, 1.44, -0.7 + k * 0.36], MAT.paint, 0.4 + R() * 0.15);
    P(buildBox(0.04, 0.04, 1.1), [sx * 1.2, 1.2, 0.55], MAT.timber, 0.3, [0, 0, 0.1]);
    P(buildBox(0.04, 0.04, 1.0), [sx * 1.2, 1.1, 0.5], MAT.timber, 0.35, [0, 0, -0.1]);
    // Mudguards over the corner wheels, flat and angled down at the ends.
    for (const e of [1, -1]) {
      P(buildBox(0.36, 0.04, 0.9), [sx * 1.06, 1.28, e * 1.85], MAT.paint, VA);
      P(buildBox(0.34, 0.04, 0.34), [sx * 1.06, 1.18, e * 2.38], MAT.paint, VA, [e * 0.6, 0, 0]);
    }
  }
  P(axleX(0.2, 2.2, 12).rotateX(Math.PI / 2), [0, deck + 0.1, -1.35], MAT.canvas, 0.45);   // tarp roll on the rear deck

  // ── The FL-11 turret: a fixed collar and the oscillating upper part, which
  //    carries the gun rigidly (the whole top pivots to elevate it).
  const ty = deck + 0.12;
  P(new THREE.CylinderGeometry(0.78, 0.84, 0.28, 24), [0, ty + 0.14, 0], MAT.paint, VA * 1.05);
  // Trunnion cheeks either side, the upper part pivoting between them.
  for (const sx of [-1, 1]) P(buildBox(0.18, 0.4, 0.62), [sx * 0.7, ty + 0.46, 0.05], MAT.paint, VA);
  {
    // The upper part, a low faceted box: long glacis forward, bustle behind.
    const top = new THREE.Shape([
      new THREE.Vector2(-0.95, 0), new THREE.Vector2(0.72, 0), new THREE.Vector2(0.98, 0.14),
      new THREE.Vector2(0.62, 0.46), new THREE.Vector2(-0.7, 0.46), new THREE.Vector2(-1.05, 0.2),
    ]);
    const g = new THREE.ExtrudeGeometry(top, { depth: 1.12, bevelEnabled: false });
    g.translate(0, 0, -0.56).rotateY(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
    if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
    P(g, [0, ty + 0.3, 0], MAT.paint, VA * 1.08);
  }
  // The 75 mm: mantlet, a long thin barrel, the muzzle brake.
  P(buildBox(0.42, 0.3, 0.3), [0, ty + 0.5, 1.02], MAT.paint, VA * 0.9);
  P(alongZ(0.07, 0.065, 3.1, 12), [0, ty + 0.5, 2.7], MAT.paint, VA * 0.95);
  P(alongZ(0.1, 0.1, 0.34, 12), [0, ty + 0.5, 4.2], MAT.steel, 0.2);
  for (const sx of [-1, 1]) P(buildBox(0.05, 0.14, 0.22), [sx * 0.11, ty + 0.5, 4.2], MAT.steel, 0.15);
  // Commander's cupola and a periscope; the co-axial MG port; smoke dischargers.
  P(new THREE.CylinderGeometry(0.26, 0.29, 0.18, 14), [-0.3, ty + 0.85, -0.2], MAT.paint, VA);
  P(new THREE.CylinderGeometry(0.27, 0.27, 0.04, 14), [-0.3, ty + 0.96, -0.2], MAT.steel, 0.25);
  P(buildBox(0.14, 0.14, 0.1), [0.35, ty + 0.84, 0.3], MAT.steel, 0.1);
  for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) P(alongZ(0.045, 0.045, 0.22, 8), [sx * 0.62, ty + 0.62 + k * 0.1, 0.6], MAT.steel, 0.25, [-0.5, 0, 0]);
  // A bustle rack with a jerrycan and a bedroll, the aerial on its base.
  P(buildBox(1.0, 0.04, 0.4), [0, ty + 0.5, -1.2], MAT.steel, 0.3);
  P(buildBox(0.34, 0.44, 0.16), [0.25, ty + 0.72, -1.2], MAT.paint, 0.42);
  P(axleX(0.14, 0.7, 10), [-0.2, ty + 0.66, -1.22], MAT.canvas, 0.35);
  P(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8), [0.5, ty + 0.54, -0.85], MAT.steel, 0.2);
  P(new THREE.CylinderGeometry(0.008, 0.012, 2.4, 5), [0.5, ty + 1.8, -0.85], MAT.steel, 0.4, [0.12, 0, -0.05]);

  // ── Running gear: four tyred wheels at the corners, four steel in the middle.
  const WR = 0.53, CR = 0.47;
  const wheelAt = (x, z, r, w, steel) => {
    const s = [r, z, r, 1];
    if (steel) {
      // A steel wheel with grousers (the cleats across its rim).
      G(axleX(r, w, 20), [x, r, z], MAT.steel, 0.3, undefined, s);
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        G(buildBox(w + 0.04, 0.05, 0.08), [x, r + Math.sin(a) * (r + 0.01), z + Math.cos(a) * (r + 0.01)], MAT.steel, 0.2, [a, 0, 0], s);
      }
      G(axleX(0.2, w + 0.04, 12), [x, r, z], MAT.paint, VA, undefined, s);
    } else if (D2) {
      G(tyre(r, w, 0.3, 18, true), [x, r, z], MAT.rubber, 0.5, undefined, s);
      G(chevronTread(r, w, { bars: 18, fill: 0.5, depth: 0.025 }), [x, r, z], MAT.rubber, 0.3, undefined, s);
      G(combatRim(0.3, w, 12, true), [x, r, z], MAT.paint, VA * 0.95, undefined, s);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        G(new THREE.CylinderGeometry(0.018, 0.018, w * 0.8, 4).rotateZ(Math.PI / 2).translate(0, Math.cos(a) * 0.17, Math.sin(a) * 0.17), [x, r, z], MAT.steel, 0.35, undefined, s);
      }
    } else {
      G(axleX(r, w, 22), [x, r, z], MAT.rubber, 0.5, undefined, s);
      G(axleX(0.3, w + 0.02, 16), [x, r, z], MAT.paint, VA * 0.95, undefined, s);
      G(axleX(0.1, w + 0.05, 8), [x, r, z], MAT.steel, 0.3, undefined, s);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        G(buildBox(w + 0.04, 0.045, 0.045), [x, r + Math.sin(a) * 0.2, z + Math.cos(a) * 0.2], MAT.steel, 0.35, undefined, s);
      }
    }
  };
  for (const sx of [-1, 1]) {
    for (const e of [1, -1]) wheelAt(sx * 1.05, e * 1.85, WR, 0.3, false);
    // The middle pair sit a few centimetres up: on the road they are raised.
    for (const e of [1, -1]) wheelAt(sx * 0.98, e * 0.55, CR, 0.26, true);
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: the registration plate front and back, a small tricolour on the
  // turret's flanks, the cockade on the turret roof for the aircraft.
  const st = [];
  for (const e of [1, -1]) st.push(stencilPatch("frPlate", flatSurface([0, 0.98, e * 2.66], [0, 0, e], [e, 0, 0], 0.5, "frPlate"), { lift: 0.006 }));
  for (const sx of [-1, 1]) st.push(stencilPatch("frTricolore", flatSurface([sx * 0.8, ty + 0.46, -0.45], [sx, 0, 0], [0, 0, -sx], 0.36, "frTricolore"), { lift: 0.01 }));
  st.push(stencilPatch("frCocarde", flatSurface([0.15, ty + 0.77, -0.45], [0, 1, 0], [1, 0, 0], 0.5, "frCocarde"), { lift: 0.006 }));
  const stencil = mergeStencils(st);

  for (const g of [geo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.gear = gearGeo;
  // WHERE ITS GUN FIRES (the weapons pass): the 75 mm's brake (the FL-11 turret is fixed here).
  geo.userData.muzzles = [{ p: [0, (ty + 0.5) * S, 4.4 * S] }];
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.3 * S, hz: 2.9 * S };
  return geo;
}

// ── WILLYS MB ────────────────────────────────────────────────────────────────

/** A seated soldier in khaki drill with the M51 helmet: torso, thighs, arms, head. */
function soldierSeated(P, x, y, z, R) {
  P(buildBox(0.38, 0.5, 0.24), [x, y + 0.25, z], MAT.canvas, 0.5 + R() * 0.1);
  P(buildBox(0.34, 0.14, 0.42), [x, y - 0.02, z + 0.16], MAT.canvas, 0.45);
  for (const dx of [-0.16, 0.16]) P(buildBox(0.09, 0.09, 0.34), [x + dx, y + 0.34, z + 0.25], MAT.canvas, 0.5, [0.45, 0, 0]);
  P(new THREE.SphereGeometry(0.1, 10, 7), [x, y + 0.62, z], MAT.canvas, 0.15);
  P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [x, y + 0.66, z], MAT.paint, VA * 1.1);
  P(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 14).scale(1, 1, 1.1), [x, y + 0.66, z], MAT.paint, VA);
}

/**
 * The jeep's SIDE with its door CUTOUT (detail 2, the reference photos): no doors, the tub's top
 * edge dips in a curve between the cowl and the rear wheel — THE jeep line. A (z, y) profile
 * extruded 5 cm across; UVs in metres / 2 like buildBox's.
 */
function jeepSide(z0, z1, yb, yt, cut) {
  const sh = new THREE.Shape();
  sh.moveTo(z1, yb); sh.lineTo(z0, yb); sh.lineTo(z0, yt);
  for (const [z, y] of cut) sh.lineTo(z, y);
  sh.lineTo(z1, yt); sh.lineTo(z1, yb);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.05, bevelEnabled: false, curveSegments: 4 }).rotateY(-Math.PI / 2);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
  return indexed(g);
}

export function buildWillys({ seed = 44, detail = 1, crew = true } = {}) {
  const R = rng(seed);
  // DETAIL 2 (the vehicle lab): the cutout sides, curled fenders, turned tyres, the seats and
  // the gun at a real man's height, the wire cutter; 1 = the game's, unchanged.
  const D2 = detail >= 2;
  const seats = [];
  // The GUN MOUNT turns (detail 2; the weapons pass, 2026-10-07: the gunner tracks his target, as
  // CoH's): its parts in their own geometry, built about the pedestal's top (userData.turret).
  const mount = [], MP = [0, 1.9, -0.68];
  const M = (geo, pos, mat, tone) => mount.push({ geo, pos: [pos[0] - MP[0], pos[1] - MP[1], pos[2] - MP[2]], mat, tone });
  const hull = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const WR = 0.36, AXF = 1.0, AXR = -1.03;

  // ── Chassis and axles.
  for (const sx of [-1, 1]) P(buildBox(0.08, 0.14, 3.1), [sx * 0.38, 0.5, -0.05], MAT.paint, VA * 0.8);
  for (const z of [AXF, AXR]) P(axleX(0.06, 1.25, 8), [0, WR, z], MAT.steel, 0.2);
  for (const z of [AXF, AXR]) P(new THREE.CylinderGeometry(0.15, 0.15, 0.2, 10).rotateX(Math.PI / 2), [0.1, WR, z], MAT.steel, 0.15);

  // ── The tub: floor, sides, the rear panel, the seats.
  const TZ0 = 0.3, TZ1 = -1.62, TL = TZ0 - TZ1, TZ = (TZ0 + TZ1) / 2;
  P(buildBox(1.26, 0.05, TL - 0.04), [0, 0.62, TZ], MAT.paint, VA * 0.9);   // short of the sides' ends
  // The cutout's top edge, front (the cowl) to back (ahead of the rear wheel).
  const CUT = [[0.22, 1.05], [0.12, 1.0], [0.02, 0.92], [-0.1, 0.86], [-0.25, 0.84], [-0.4, 0.87], [-0.5, 0.95], [-0.58, 1.03], [-0.64, 1.06]];
  for (const sx of [-1, 1]) {
    if (D2) {
      P(jeepSide(TZ0, TZ1, 0.62, 1.06, CUT), [sx * 0.64 + 0.025, 0, 0], MAT.paint, VA);
      // The rolled lip along the cut and on along the rear, a shade darker: it draws the line.
      P(tube([[sx * 0.645, 1.065, TZ0], ...CUT.map(([z, y]) => [sx * 0.645, y + 0.01, z]), [sx * 0.645, 1.07, -1.0], [sx * 0.645, 1.07, TZ1 + 0.03]], 0.022, 28, 5), [0, 0, 0], MAT.paint, VA * 0.8);
      P(buildBox(0.26, 0.3, 0.86), [sx * 0.49, 0.8, AXR], MAT.paint, VA * 0.92);        // rear wheel arch
    } else {
      P(buildBox(0.05, 0.44, TL), [sx * 0.64, 0.84, TZ], MAT.paint, VA);
      P(buildBox(0.26, 0.3, 0.86), [sx * 0.49, 0.8, AXR], MAT.paint, VA * 0.92);          // rear wheel arch
      P(buildBox(0.08, 0.04, TL - 0.06), [sx * 0.64, 1.07, TZ], MAT.paint, VA * 0.85);   // rolled lip (short of the side's ends)
    }
  }
  P(buildBox(1.28, 0.41, 0.05), [0, 0.835, TZ1], MAT.paint, VA);   // 2 cm under the sides' top
  P(buildBox(1.34, 0.04, 0.08), [0, 1.075, TZ1], MAT.paint, VA * 0.85);   // 5 mm over the side lips
  if (D2) {
    // Seats at a SEATED MAN's height (the Mixamo poses: hips ~0.5 m over the feet): canvas
    // cushions on painted boxes, their backs; the bench at the back.
    for (const sx of [-1, 1]) {
      P(buildBox(0.4, 0.4, 0.4), [sx * 0.3, 0.86, -0.3], MAT.paint, VA * 0.75);
      P(roundedPlate(0.46, 0.09, 0.46, 0.03), [sx * 0.3, 1.1, -0.3], MAT.canvas, 0.3);
      P(roundedPlate(0.44, 0.48, 0.08, 0.03), [sx * 0.3, 1.38, -0.55], MAT.canvas, 0.3, [-0.1, 0, 0]);
    }
    P(roundedPlate(1.1, 0.1, 0.4, 0.03), [0, 0.98, -1.4], MAT.canvas, 0.3);
    P(buildBox(1.26, 0.36, 0.08), [0, 0.92, TZ0], MAT.paint, VA);                         // cowl
    // The WHEEL where the Driving clip's hands close (0.82 up, 0.29 ahead of the driver's feet).
    P(new THREE.TorusGeometry(0.19, 0.018, 6, 20), [0.27, 1.39, 0.04], MAT.rubber, 0.3, [0.64, 0, 0]);
    P(alongZ(0.022, 0.022, 0.5, 6), [0.27, 1.25, 0.22], MAT.steel, 0.15, [0.64, 0, 0]);
  } else {
    for (const sx of [-1, 1]) {
      P(buildBox(0.44, 0.1, 0.44), [sx * 0.3, 0.84, -0.3], MAT.canvas, 0.3);
      P(buildBox(0.42, 0.44, 0.08), [sx * 0.3, 1.08, -0.54], MAT.canvas, 0.3);
    }
    P(buildBox(1.1, 0.1, 0.4), [0, 0.98, -1.35], MAT.canvas, 0.3);
    P(buildBox(1.26, 0.36, 0.08), [0, 0.92, TZ0], MAT.paint, VA);                         // cowl
    P(new THREE.TorusGeometry(0.17, 0.018, 5, 16).rotateX(Math.PI / 2 - 0.9), [0.3, 1.12, 0.12], MAT.steel, 0.05);
  }

  // ── Bonnet, the slotted grille with the lamps in it, flat fenders, bumper.
  P(buildBox(0.78, 0.06, 1.2), [0, 1.03, 0.92], MAT.paint, VA * 1.05);
  for (const sx of [-1, 1]) P(buildBox(0.05, 0.4, 1.16), [sx * 0.39, 0.82, 0.92], MAT.paint, VA);   // short of the bonnet top's ends
  P(buildBox(0.84, 0.62, 0.05), [0, 0.75, 1.54], MAT.paint, VA);
  for (let k = 0; k < 9; k++) P(buildBox(0.045, 0.4, 0.02), [-0.28 + k * 0.07, 0.77, 1.57], MAT.steel, 0.02);
  for (const sx of [-1, 1]) {
    P(new THREE.CylinderGeometry(0.085, 0.085, 0.05, 12).rotateX(Math.PI / 2), [sx * 0.33, 0.9, 1.56], MAT.steel, 0.2);
    P(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.33, 0.9, 1.585], MAT.white, 0.45);
    if (D2) {
      // The FENDER (the photos): flat by the bonnet, its front curled down — a chain of plates.
      const fp = [[0.36, 0.86], [1.3, 0.86], [1.43, 0.845], [1.54, 0.8], [1.61, 0.72], [1.64, 0.64]];
      for (let k = 0; k < fp.length - 1; k++) {
        const [z0, y0] = fp[k], [z1, y1] = fp[k + 1], L = Math.hypot(z1 - z0, y1 - y0);
        P(buildBox(0.3, 0.04, L + 0.02), [sx * 0.6, (y0 + y1) / 2, (z0 + z1) / 2], MAT.paint, VA, [Math.atan2(-(y1 - y0), z1 - z0), 0, 0]);
      }
    } else {
      P(buildBox(0.3, 0.04, 1.05), [sx * 0.6, 0.86, 1.02], MAT.paint, VA);
      P(buildBox(0.28, 0.04, 0.26), [sx * 0.6, 0.77, 1.58], MAT.paint, VA, [0.75, 0, 0]);
    }
    P(buildBox(0.04, 0.24, 0.8), [sx * 0.46, 0.73, 1.0], MAT.paint, VA * 0.9);
  }
  P(buildBox(1.5, 0.12, 0.1), [0, 0.46, 1.66], MAT.paint, VA * 0.9);
  for (const sx of [-1, 1]) P(buildBox(0.08, 0.15, 0.1), [sx * 0.42, 0.46, 1.74], MAT.steel, 0.3);   // taller than the bumper

  // ── Windscreen folded down onto the bonnet (the djebel way).
  P(buildBox(1.2, 0.05, 0.42), [0, 1.09, 0.56], MAT.paint, VA * 0.95);
  P(buildBox(1.08, 0.02, 0.32), [0, 1.12, 0.56], MAT.steel, 0.08);

  // ── Tail: spare wheel and a jerrycan.
  // The jeep's WHEEL at detail 2 (axis along X, at the origin): the turned tyre, the combat rim,
  // the hub, the chevron tread, the rim's bolts — ONE, for the four wheels and the spare (you:
  // "it should use the same wheel").
  const jeepWheel = () => {
    // Optimised (you: "optimise the jeep"): 20 segments round the tyre, 22 bars a touch wider,
    // a 14-segment rim — 13.0k → see the lab's count; the same read at any zoom we play at.
    const parts = [[tyre(WR, 0.2, 0.2, 16, true), MAT.rubber, 0.5], [chevronTread(WR, 0.2, { bars: 18, fill: 0.5 }), MAT.rubber, 0.3], [combatRim(0.2, 0.2, 12, true), MAT.paint, VA * 0.9]];   // OPTIMISED 2 (lite profiles)
    // The five bolts on the rim's raised ring, a centimetre proud of it on both faces.
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      parts.push([new THREE.CylinderGeometry(0.013, 0.013, 0.145, 6).rotateZ(Math.PI / 2).translate(0, Math.cos(a) * 0.11, Math.sin(a) * 0.11), MAT.steel, 0.35]);
    }
    return parts;
  };
  if (D2) {
    // The spare, on the tail, standing across the back (turned a quarter about Y).
    for (const [g, m, t] of jeepWheel()) G(g.rotateY(Math.PI / 2), [0.28, 0.86, TZ1 - 0.14], m, t, undefined, [0, 0, 0, 0]);
  } else {
    G(axleX(WR * 0.95, 0.18, 18).rotateY(Math.PI / 2), [0.28, 0.86, TZ1 - 0.12], MAT.rubber, 0.5, undefined, [0, 0, 0, 0]);
    G(axleX(0.18, 0.2, 12).rotateY(Math.PI / 2), [0.28, 0.86, TZ1 - 0.12], MAT.paint, VA, undefined, [0, 0, 0, 0]);
  }
  P(buildBox(0.16, 0.46, 0.32), [-0.34, 0.875, TZ1 - 0.13], MAT.paint, 0.4);

  // ── The .30 on its pedestal behind the seats, its ammo box; the whip aerial
  //    bent over and tied down.
  if (D2) {
    // The gun at a STANDING man's chest (the gunner behind it, on the floor).
    P(new THREE.CylinderGeometry(0.04, 0.06, 1.25, 8), [0, 1.27, -0.68], MAT.steel, 0.25);
    M(new THREE.CylinderGeometry(0.07, 0.07, 0.1, 10), [0, 1.9, -0.68], MAT.steel, 0.2);      // the cradle
    M(buildBox(0.14, 0.14, 0.9), [0, 1.95, -0.42], MAT.steel, 0.12);
    M(alongZ(0.025, 0.025, 0.5, 6), [0, 1.95, 0.28], MAT.steel, 0.1);
    M(buildBox(0.16, 0.14, 0.26), [0.14, 1.87, -0.6], MAT.paint, 0.35);
  } else {
    P(new THREE.CylinderGeometry(0.04, 0.05, 0.8, 8), [0, 1.05, -0.8], MAT.steel, 0.25);
    P(buildBox(0.14, 0.14, 0.9), [0, 1.52, -0.55], MAT.steel, 0.12);
    P(alongZ(0.025, 0.025, 0.5, 6), [0, 1.52, -0.05], MAT.steel, 0.1);
    P(buildBox(0.16, 0.14, 0.26), [0.14, 1.44, -0.72], MAT.paint, 0.35);
  }
  // (Detail 2 drops it — you, 2026-10-06: the bent whip read as "a long curved tube".)
  if (!D2) P(tube([[-0.58, 0.98, TZ1 + 0.1], [-0.6, 1.9, TZ1 + 0.4], [-0.55, 2.2, -0.6], [-0.5, 2.1, 0.2]], 0.012, 12, 4), [0, 0, 0], MAT.steel, 0.35);

  // ── The crew: the driver, and the gunner standing at the gun.
  if (crew) {
    soldierSeated(P, 0.3, 0.9, -0.34, R);
    P(buildBox(0.38, 0.58, 0.24), [0, 1.2, -1.05], MAT.canvas, 0.52);
    for (const dx of [-0.18, 0.18]) P(buildBox(0.09, 0.09, 0.4), [dx, 1.45, -0.86], MAT.canvas, 0.5, [0.2, 0, 0]);
    P(new THREE.SphereGeometry(0.1, 10, 7), [0, 1.62, -1.06], MAT.canvas, 0.15);
    P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [0, 1.66, -1.06], MAT.paint, VA * 1.1);
  } else {
    // SEATS for real soldiers (feet on the floor): the driver (left: a left-hand drive), the man
    // beside him, the gunner standing behind the gun.
    seats.push(
      { p: [0.3, 0.57, -0.25], yaw: 0, clip: "drive" },
      { p: [-0.3, 0.6, -0.25], yaw: 0, clip: "sit" },
      // The gunner rides the mount (turret: in its frame — he turns with the gun).
      D2 ? { p: [0, 0.645 - MP[1], -1.05 - MP[2]], yaw: 0, clip: "rifle_aim_idle", turret: true } : { p: [0, 0.645, -1.05], yaw: 0, clip: "rifle_aim_idle" },
    );
  }
  if (D2) {
    // The tools on the left flank under the cut. (No wire cutter: you, 2026-10-06, "remove".)
    P(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6).rotateX(Math.PI / 2), [0.69, 0.72, -0.9], MAT.timber, 0.4);
    P(buildBox(0.02, 0.2, 0.18), [0.69, 0.72, -1.45], MAT.steel, 0.25);
    P(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6).rotateX(Math.PI / 2), [0.69, 0.8, -0.95], MAT.timber, 0.35);
    P(buildBox(0.03, 0.2, 0.1), [0.69, 0.8, -0.6], MAT.steel, 0.25);
  }

  // ── Wheels.
  const wheelAt = (x, z) => {
    const s = [WR, z, WR, 1];
    if (D2) { for (const [g, m, t] of jeepWheel()) G(g, [x, WR, z], m, t, undefined, s); return; }
    G(axleX(WR, 0.19, 20), [x, WR, z], MAT.rubber, 0.5, undefined, s);
    G(axleX(0.2, 0.2, 14), [x, WR, z], MAT.paint, VA * 0.9, undefined, s);
    G(axleX(0.07, 0.22, 8), [x, WR, z], MAT.steel, 0.3, undefined, s);
  };
  for (const sx of [-1, 1]) for (const z of [AXF, AXR]) wheelAt(sx * 0.62, z);

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.08, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.06, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: the plate front and back, a tricolour on the bonnet's flanks,
  // the unit code on the bumper.
  const st = [];
  st.push(stencilPatch("frPlate", flatSurface([0.36, 0.46, 1.715], [0, 0, 1], [1, 0, 0], 0.46, "frPlate"), { lift: 0.004 }));
  st.push(stencilPatch("frPlate", flatSurface([0.2, 0.72, TZ1 - 0.03], [0, 0, -1], [-1, 0, 0], 0.46, "frPlate"), { lift: 0.004 }));
  for (const sx of [-1, 1]) st.push(stencilPatch("frTricolore", flatSurface([sx * 0.42, 0.88, 1.1], [sx, 0, 0], [0, 0, -sx], 0.22, "frTricolore"), { lift: 0.004 }));
  st.push(stencilPatch("frUnitCode", flatSurface([-0.4, 0.46, 1.715], [0, 0, 1], [1, 0, 0], 0.5, "frUnitCode"), { lift: 0.004 }));
  const stencil = mergeStencils(st);

  for (const g of [geo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.gear = gearGeo;
  geo.userData.seats = seats.map((q) => ({ ...q, p: q.p.map((v) => v * S) }));
  // WHERE ITS GUN FIRES (the weapons pass): the pedestal MG's muzzle.
  geo.userData.muzzles = [D2 ? { p: [0, (1.95 - MP[1]) * S, (0.55 - MP[2]) * S], turret: true } : { p: [0, 1.52 * S, 0.22 * S] }];
  if (D2) {
    const mountGeo = assemble(mount);
    bakeContactAO(mountGeo, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
    mountGeo.scale(S, S, S);
    geo.userData.turret = { geo: mountGeo, pivot: MP.map((c) => c * S), muzzle: geo.userData.muzzles[0].p };
  }
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 0.8 * S, hz: 1.8 * S };
  return geo;
}

// ── GMC CCKW 353 ─────────────────────────────────────────────────────────────

/**
 * A curved wing over a wheel: a strip of a cylinder along X (radius r, width
 * w), from angle a0 to a1 measured from the front (+Z) over the top.
 */
function wing(r, w, a0 = 0.15, a1 = 2.4, seg = 12) {
  const g = new THREE.CylinderGeometry(r, r, w, seg, 1, true, a0, a1 - a0);
  g.rotateZ(Math.PI / 2);
  return g;
}

export function buildGMC({ seed = 353, detail = 1, crew = true, tilt = true } = {}) {
  const R = rng(seed);
  // DETAIL 2 (the vehicle lab, 2026-10-07, from CCKW photos): the FLAT-TOPPED front wings (the
  // banjo arches were the silhouette's mistake), the TILT's flat roof on rounded shoulders, the
  // leaf springs, the winch's rope; light wheels. `tilt`: closed (no one in the back — you: "a
  // closed version, we don't have to add soldiers inside") or off, its bows over men on
  // benches. 1 = the game's, unchanged.
  const D2 = detail >= 2;
  const seats = [];
  const hull = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const WR = 0.46, AXF = 2.15, AX1 = -1.05, AX2 = -2.25;

  // ── Chassis, axles, differentials, fuel tank.
  for (const sx of [-1, 1]) P(buildBox(0.1, 0.22, 6.2), [sx * 0.44, 0.78, -0.1], MAT.paint, VA * 0.8);
  for (const z of [2.9, 1.1, -0.4, -1.65, -2.9]) P(buildBox(0.78, 0.1, 0.1), [0, 0.78, z], MAT.paint, VA * 0.8);
  for (const z of [AXF, AX1, AX2]) P(axleX(0.08, 1.6, 8), [0, WR, z], MAT.steel, 0.2);
  for (const z of [AX1, AX2]) P(new THREE.CylinderGeometry(0.24, 0.24, 0.28, 12).rotateX(Math.PI / 2), [0.05, WR, z], MAT.steel, 0.15);
  P(alongZ(0.22, 0.22, 0.9, 14), [-0.72, 0.9, 0.55], MAT.paint, VA * 0.9);

  // ── Bonnet: narrow, flat-topped, louvred sides; the grille and its brush guard.
  P(buildBox(0.86, 0.06, 1.55), [0, 1.62, 2.18], MAT.paint, VA * 1.05);
  for (const sx of [-1, 1]) {
    P(buildBox(0.05, 0.56, 1.51), [sx * 0.43, 1.34, 2.18], MAT.paint, VA);   // short of the bonnet top's ends
    for (let k = 0; k < 6; k++) P(buildBox(0.02, 0.05, 0.13), [sx * 0.46, 1.44, 1.7 + k * 0.17], MAT.steel, 0.05);   // louvres, not overlapping
  }
  P(buildBox(0.9, 0.78, 0.06), [0, 1.3, 2.98], MAT.paint, VA * 0.95);
  for (let k = 0; k < 8; k++) P(buildBox(0.05, 0.64, 0.03), [-0.33 + k * 0.094, 1.3, 3.02], MAT.steel, 0.05);
  for (const sx of [-1, 1]) {
    P(buildBox(0.05, 0.9, 0.05), [sx * 0.5, 1.3, 3.16], MAT.steel, 0.25);
    P(new THREE.CylinderGeometry(0.11, 0.12, 0.14, 12).rotateX(Math.PI / 2), [sx * 0.72, 1.46, 2.95], MAT.steel, 0.15);
    P(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.72, 1.46, 3.03], MAT.white, 0.4);
  }
  for (const y of [1.0, 1.72]) P(buildBox(1.04, 0.05, 0.05), [0, y, 3.19], MAT.steel, 0.25);   // in front of the uprights
  P(buildBox(2.2, 0.18, 0.14), [0, 0.8, 3.24], MAT.paint, VA * 0.9);                       // bumper
  P(axleX(0.14, 0.7, 12), [0, 0.95, 3.2], MAT.steel, 0.2);                                  // winch drum
  for (const sx of [-1, 1]) P(buildBox(0.12, 0.14, 0.18), [sx * 0.8, 0.72, 3.33], MAT.steel, 0.3);

  // ── The banjo wings over the front wheels, and running boards to the cab.
  for (const sx of [-1, 1]) {
    if (D2) {
      // The CCKW's WING (the photos): the running board under the door, up over the wheel, FLAT
      // beside the bonnet, the front curled down — a chain of plates, its rolled outer lip darker.
      const fp = [[0.2, 1.0], [1.05, 1.0], [1.22, 1.08], [1.38, 1.3], [1.55, 1.38], [2.62, 1.38], [2.86, 1.33], [3.0, 1.2], [3.06, 1.02]];
      for (let k = 0; k < fp.length - 1; k++) {
        const [z0, y0] = fp[k], [z1, y1] = fp[k + 1], L = Math.hypot(z1 - z0, y1 - y0);
        P(buildBox(0.58, 0.04, L + 0.02), [sx * 0.85, (y0 + y1) / 2, (z0 + z1) / 2], MAT.paint, VA, [Math.atan2(-(y1 - y0), z1 - z0), 0, 0]);
      }
      P(tube(fp.map(([z, y]) => [sx * 1.14, y - 0.015, z]), 0.026, 24, 4), [0, 0, 0], MAT.paint, VA * 0.8);
      P(buildBox(0.03, 0.4, 1.5), [sx * 0.56, 1.18, 2.22], MAT.paint, VA * 0.85);   // the inner skirt by the bonnet
    } else {
      P(wing(WR + 0.14, 0.44, 0.1, 2.5), [sx * 0.88, WR, AXF], MAT.paint, VA);
      P(buildBox(0.36, 0.05, 1.05), [sx * 0.92, 0.92, 0.95], MAT.paint, VA * 0.9);          // running board
      P(buildBox(0.36, 0.04, 0.42), [sx * 0.92, 1.08, 1.62], MAT.paint, VA, [0.5, 0, 0]);   // wing's tail down to the board
    }
  }
  if (D2) {
    // The winch's rope wound on its drum; the LEAF SPRINGS between the rear axles.
    P(axleX(0.18, 0.56, 12), [0, 0.95, 3.2], MAT.hessian, 0.35);
    for (const sx of [-1, 1]) {
      P(buildBox(0.1, 0.05, 1.55), [sx * 0.85, 0.7, (AX1 + AX2) / 2], MAT.steel, 0.2);
      P(buildBox(0.1, 0.05, 1.1), [sx * 0.85, 0.65, (AX1 + AX2) / 2], MAT.steel, 0.18);
      P(buildBox(0.14, 0.2, 0.24), [sx * 0.85, 0.82, (AX1 + AX2) / 2], MAT.paint, VA * 0.8);   // the hanger
    }
  }

  // ── The closed cab: body, rounded roof, split windscreen, doors with windows.
  const CZ = 0.72, CW = 1.92, CD = 1.28;
  P(buildBox(CW, 0.95, CD), [0, 1.52, CZ], MAT.paint, VA);
  P(buildBox(CW - 0.04, 0.52, 0.06), [0, 2.24, CZ + CD / 2 - 0.02], MAT.paint, VA * 0.98);   // proud of the door frames top and bottom   // windscreen frame
  for (const sx of [-1, 1]) P(buildBox(0.82, 0.4, 0.03), [sx * 0.44, 2.24, CZ + CD / 2 + 0.01], MAT.steel, 0.08);
  for (const sx of [-1, 1]) {
    P(buildBox(0.06, 0.5, CD - 0.04), [sx * (CW / 2 - 0.03), 2.24, CZ], MAT.paint, VA);
    P(buildBox(0.03, 0.36, 0.62), [sx * (CW / 2 + 0.005), 2.26, CZ + 0.18], MAT.steel, 0.08);  // door window
    P(buildBox(0.02, 0.04, 0.3), [sx * (CW / 2 + 0.02), 1.72, CZ + 0.3], MAT.steel, 0.3);     // handle
    P(buildBox(0.32, 0.03, 0.03), [sx * (CW / 2 + 0.16), 2.3, CZ + 0.6], MAT.steel, 0.25);    // mirror arm
    P(buildBox(0.03, 0.24, 0.16), [sx * (CW / 2 + 0.32), 2.3, CZ + 0.6], MAT.steel, 0.1);
  }
  P(buildBox(CW - 0.1, 0.5, 0.06), [0, 2.24, CZ - CD / 2 + 0.03], MAT.paint, VA);   // between the door frames
  {
    const roof = new THREE.CylinderGeometry(1, 1, CD + 0.06, 18, 1, false, -Math.PI / 2, Math.PI);
    roof.rotateX(-Math.PI / 2).scale(CW / 2 + 0.02, 0.22, 1);   // -90: the arc on TOP (+90 hangs it below the axis)
    P(roof, [0, 2.48, CZ], MAT.paint, VA * 1.05);
  }
  // Driver behind the glass (left-hand drive: +X). Closed (tilt on) at detail 2: the cheap
  // figure — behind the cab's glass a real man adds 3k triangles nobody sees.
  if (crew || (D2 && tilt)) {
    P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [0.45, 2.3, CZ + 0.05], MAT.paint, VA * 1.1);
    P(buildBox(0.4, 0.4, 0.24), [0.45, 2.02, CZ], MAT.canvas, 0.5);
  } else {
    // The driver and the man beside him, on the cab floor (the clips' hips ~0.5 m up).
    seats.push({ p: [0.45, 1.04, CZ - 0.05], yaw: 0, clip: "drive" }, { p: [-0.45, 1.1, CZ - 0.05], yaw: 0, clip: "sit" });
  }
  if (D2) {
    // The wheel where the Driving clip's hands close (0.82 up, 0.29 ahead of his feet).
    P(new THREE.TorusGeometry(0.21, 0.02, 6, 20), [0.41, 1.86, CZ + 0.24], MAT.rubber, 0.3, [0.64, 0, 0]);
    P(alongZ(0.025, 0.025, 0.5, 6), [0.41, 1.72, CZ + 0.42], MAT.steel, 0.15, [0.64, 0, 0]);
    for (const sx of [-1, 1]) P(buildBox(0.5, 0.5, 0.45), [sx * 0.45, 1.3, CZ - 0.3], MAT.canvas, 0.3);   // the seat
  }

  // ── The bed: floor, low sides, and the canvas tilt over its bows.
  const BZ0 = 0.0, BZ1 = -3.55, BL = BZ0 - BZ1, BZ = (BZ0 + BZ1) / 2;
  P(buildBox(2.2, 0.1, BL), [0, 1.22, BZ], MAT.paint, VA * 0.9);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) P(buildBox(0.05, 0.13, BL - 0.1), [sx * 1.09, 1.36 + k * 0.16, BZ], MAT.timber, 0.3 + R() * 0.25);
    for (let k = 0; k < 5; k++) P(buildBox(0.08, 0.5, 0.08), [sx * 1.12, 1.52, BZ0 - 0.2 - k * (BL - 0.4) / 4], MAT.paint, VA * 0.9);
  }
  P(buildBox(2.1, 0.5, 0.06), [0, 1.52, BZ1 + 0.03], MAT.paint, VA * 0.95);                 // tailgate
  // The TILT's section (the photos): straight sides, rounded SHOULDERS, a near-flat crowned roof.
  const TW = 1.13, TTOP = 2.84, SH = 0.3, TBOT = 1.42;
  const tiltSection = (n = 5) => {
    const pts = [[-TW, TBOT], [-TW, TTOP - SH]];
    for (let i = 1; i < n; i++) { const a = Math.PI - (i / n) * (Math.PI / 2); pts.push([-TW + SH + Math.cos(a) * SH, TTOP - SH + Math.sin(a) * SH]); }
    pts.push([-TW + SH, TTOP], [0, TTOP + 0.05], [TW - SH, TTOP]);
    for (let i = 1; i < n; i++) { const a = Math.PI / 2 - (i / n) * (Math.PI / 2); pts.push([TW - SH + Math.cos(a) * SH, TTOP - SH + Math.sin(a) * SH]); }
    pts.push([TW, TTOP - SH], [TW, TBOT]);
    return pts;
  };
  if (D2 && tilt) {
    // CLOSED: the canvas as one skin over the section, sagging between the five bows; both ends
    // closed (the front against the cab, the rear curtain down with its roll on top).
    const sec = tiltSection(), Z0 = BZ0 - 0.06, Z1 = BZ1 + 0.04, STEPS = 16;
    const pos = [], uv = [], idx = [];
    let u = 0; const us = [0];
    for (let i = 1; i < sec.length; i++) us.push(u += Math.hypot(sec[i][0] - sec[i - 1][0], sec[i][1] - sec[i - 1][1]));
    for (let j = 0; j <= STEPS; j++) {
      const t = j / STEPS, z = Z0 + (Z1 - Z0) * t;
      const sag = Math.abs(Math.sin(t * 4 * Math.PI)) * 0.045;   // the bows at the quarters
      sec.forEach(([x, y], i) => {
        const roof = Math.max(0, (y - (TTOP - SH)) / SH);
        pos.push(x * (1 - sag * 0.15 * roof), y - sag * roof, z);
        uv.push(us[i] / 2, (z - Z0) / 2);
      });
    }
    const W = sec.length;
    for (let j = 0; j < STEPS; j++) for (let i = 0; i < W - 1; i++) {
      const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, b, c, b, d, c);   // outward (the lab: the other way showed the inside)
    }
    const skin = new THREE.BufferGeometry();
    skin.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    skin.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    skin.setIndex(idx);
    skin.computeVertexNormals();
    P(skin, [0, 0, 0], MAT.canvas, 0.44);
    // The ends: the section filled.
    const shape = new THREE.Shape(sec.map(([x, y]) => new THREE.Vector2(x, y)));
    const end = (z, flip) => {
      const g = new THREE.ShapeGeometry(shape, 2);
      const a = g.attributes.uv;
      for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) / 2, a.getY(i) / 2);
      if (flip) g.rotateY(Math.PI);
      return g.translate(0, 0, z);
    };
    P(end(Z0, false), [0, 0, 0], MAT.canvas, 0.4);
    P(end(Z1, true), [0, 0, 0], MAT.canvas, 0.4);
    P(axleX(0.1, TW * 2 - 0.2, 10), [0, TTOP - 0.12, Z1 - 0.06], MAT.canvas, 0.32);   // the curtain's roll
    // Lashings down the sides, the hem's rope.
    for (let k = 0; k < 6; k++) for (const sx of [-1, 1]) P(buildBox(0.02, 0.32, 0.03), [sx * (TW + 0.012), TBOT + 0.14, Z0 - 0.3 - k * (Z0 - Z1 - 0.6) / 5], MAT.hessian, 0.4);
    for (const sx of [-1, 1]) P(buildBox(0.025, 0.03, Z0 - Z1), [sx * (TW + 0.012), TBOT + 0.02, (Z0 + Z1) / 2], MAT.hessian, 0.35);
  } else if (D2) {
    // OPEN: the BOWS without their tilt — five steel hoops on the tilt's section, the ridge.
    const sec = tiltSection(3);
    for (let k = 0; k < 5; k++) {
      const z = BZ0 - 0.2 - k * (BL - 0.4) / 4;
      P(tube(sec.map(([x, y]) => [x * 0.985, Math.max(y, 1.62), z]), 0.022, 18, 4), [0, 0, 0], MAT.paint, VA * 0.85);
    }
    P(tube([[0, TTOP + 0.05, BZ0 - 0.2], [0, TTOP + 0.05, BZ1 + 0.2]], 0.02, 2, 4), [0, 0, 0], MAT.paint, VA * 0.85);   // the ridge
    // The troop seats down both sides (the side racks folded down), on brackets.
    for (const sx of [-1, 1]) {
      P(roundedPlate(0.34, 0.06, BL - 0.7, 0.02), [sx * 0.86, 1.71, BZ - 0.15], MAT.timber, 0.4);
      for (let k = 0; k < 4; k++) P(buildBox(0.05, 0.42, 0.05), [sx * 0.75, 1.48, BZ0 - 0.6 - k * (BL - 1.3) / 3], MAT.steel, 0.2);
    }
    // Stowage against the cab: jerrycans, an ammunition box, a crate.
    for (const x of [-0.25, 0.05]) jerrycan(P, x, 1.49, BZ0 - 0.2, 0, 0.38 + R() * 0.08);
    P(roundedPlate(0.42, 0.34, 0.36, 0.015), [0.42, 1.44, BZ0 - 0.3], MAT.timber, 0.45, [0, 0.15, 0]);
    P(roundedPlate(0.32, 0.18, 0.18, 0.012), [0.38, 1.7, BZ0 - 0.3], MAT.paint, 0.32);
    // The men on the benches, facing in (a gap or two: not a full load).
    if (!crew) {
      [-0.7, -1.3, -1.9, -2.5, -3.05].forEach((z, k) => {
        for (const sx of [-1, 1]) {
          if ((k + (sx > 0 ? 1 : 0)) % 4 === 3) continue;
          seats.push({ p: [sx * 0.86, 1.27, z], yaw: -sx * Math.PI / 2, clip: (k + (sx > 0 ? 1 : 0)) % 2 ? "sit_talk" : "sit" });
        }
      });
    }
  } else {
    // The tilt: straight sides and a rounded top, one skin, sagging a little
    // between the bows; the rear flap rolled up.
    const TW = 1.13, TOP = 2.78, SIDE0 = 1.75;
    const tilt = new THREE.CylinderGeometry(1, 1, BL - 0.1, 20, 6, true, -Math.PI / 2, Math.PI);
    tilt.rotateX(-Math.PI / 2).scale(TW, TOP - SIDE0 - 0.25, 1);
    const p = tilt.attributes.position;
    for (let i = 0; i < p.count; i++) {
      // Sag between the bows (five bows along the bed).
      const f = (p.getZ(i) / (BL - 0.1) + 0.5) * 4;
      const sag = Math.abs(Math.sin(f * Math.PI)) * 0.05;
      p.setY(i, p.getY(i) - sag * Math.max(0, p.getY(i)) / (TOP - SIDE0));
    }
    tilt.computeVertexNormals();
    P(tilt, [0, SIDE0 + 0.25, BZ], MAT.canvas, 0.38);
    for (const sx of [-1, 1]) P(buildBox(0.03, 0.62, BL - 0.1), [sx * TW, SIDE0 - 0.05, BZ], MAT.canvas, 0.34);
    // The front of the tilt closed against the cab, the rear flap rolled up.
    P(buildBox(TW * 2, 0.9, 0.04), [0, SIDE0 + 0.2, BZ0 - 0.1], MAT.canvas, 0.36);   // clear of the slats' ends
    P(axleX(0.12, TW * 2 - 0.1, 10), [0, TOP - 0.1, BZ1 + 0.05], MAT.canvas, 0.3);
    // Tie-down ropes down the sides.
    for (let k = 0; k < 6; k++) for (const sx of [-1, 1]) P(buildBox(0.02, 0.5, 0.02), [sx * (TW + 0.02), SIDE0 - 0.1, BZ0 - 0.3 - k * (BL - 0.6) / 5], MAT.hessian, 0.4);
  }
  // Seen through the open back: two men on the benches, a crate.
  if (!D2) for (const sx of [-1, 1]) P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [sx * 0.62, 2.1, BZ1 + 0.6], MAT.paint, VA * 1.1);

  // The truck's WHEEL at detail 2 (the jeep's, at R 0.46): tyre, chevron tread, combat rim,
  // six bolts; `inner` (the inside of a dual pair): the tyre and tread only.
  // OPTIMISED (you: "as much as possible"): the lite tyre (6 rings, 14 round), 15 tread bars, the
  // lite rim, bolts as 4-sided studs; the INNER of a dual pair a bare tyre (the outer hides it).
  const truckWheel = (w, inner = false) => {
    const parts = [[tyre(WR, w, 0.27, 14, true), MAT.rubber, 0.5]];
    if (inner) return parts;
    parts.push([chevronTread(WR, w, { bars: 15, fill: 0.5, depth: 0.022 }), MAT.rubber, 0.3], [combatRim(0.27, w, 12, true), MAT.paint, VA * 0.9]);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      parts.push([new THREE.CylinderGeometry(0.016, 0.016, w * 0.8, 4).rotateZ(Math.PI / 2).translate(0, Math.cos(a) * 0.15, Math.sin(a) * 0.15), MAT.steel, 0.35]);
    }
    return parts;
  };
  // ── Spare wheel behind the cab; mudflaps, tail lights.
  if (D2) for (const [g, m, t] of truckWheel(0.26)) G(g.rotateY(Math.PI / 2), [-0.55, 1.75, 0.05], m, t, undefined, [0, 0, 0, 0]);
  else G(axleX(WR * 0.95, 0.26, 18).rotateY(Math.PI / 2), [-0.55, 1.75, 0.05], MAT.rubber, 0.5, undefined, [0, 0, 0, 0]);
  for (const sx of [-1, 1]) {
    P(buildBox(0.5, 0.4, 0.02), [sx * 0.9, 0.7, -2.85], MAT.rubber, 0.4);
    P(buildBox(0.12, 0.1, 0.05), [sx * 1.0, 1.1, BZ1 - 0.03], MAT.steel, 0.15);
  }

  // ── Wheels: singles in front, duals behind.
  const wheelAt = (x, z, w, inner = false) => {
    const s = [WR, z, WR, 1];
    if (D2) { for (const [g, m, t] of truckWheel(w, inner)) G(g, [x, WR, z], m, t, undefined, s); return; }
    G(axleX(WR, w, 20), [x, WR, z], MAT.rubber, 0.5, undefined, s);
    G(axleX(0.26, w + 0.02, 14), [x, WR, z], MAT.paint, VA * 0.9, undefined, s);
    G(axleX(0.09, w + 0.05, 8), [x, WR, z], MAT.steel, 0.3, undefined, s);
  };
  for (const sx of [-1, 1]) {
    wheelAt(sx * 0.88, AXF, 0.26);
    for (const z of [AX1, AX2]) { wheelAt(sx * 0.7, z, 0.24, true); wheelAt(sx * 1.0, z, 0.24); }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: plates front and back, tricolours on the bonnet's sides, the
  // unit code on the tailgate.
  const st = [];
  st.push(stencilPatch("frPlate", flatSurface([0.55, 0.8, 3.315], [0, 0, 1], [1, 0, 0], 0.55, "frPlate"), { lift: 0.004 }));
  st.push(stencilPatch("frUnitCode", flatSurface([0, 1.55, BZ1 - 0.005], [0, 0, -1], [-1, 0, 0], 1.3, "frUnitCode"), { lift: 0.004 }));
  st.push(stencilPatch("frPlate", flatSurface([0.6, 1.1, BZ1 - 0.02], [0, 0, -1], [-1, 0, 0], 0.5, "frPlate"), { lift: 0.004 }));
  for (const sx of [-1, 1]) st.push(stencilPatch("frTricolore", flatSurface([sx * 0.46, 1.36, 2.6], [sx, 0, 0], [0, 0, -sx], 0.3, "frTricolore"), { lift: 0.004 }));
  const stencil = mergeStencils(st);

  for (const g of [geo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.gear = gearGeo;
  geo.userData.seats = seats.map((q) => ({ ...q, p: q.p.map((v) => v * S) }));
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.2 * S, hz: 3.5 * S };
  return geo;
}

// ── SUD-AVIATION SE 3130 ALOUETTE II ─────────────────────────────────────────

/** A straight tube from a to b (world points), radius r — lattice members, skids. */
function strut(a, b, r, seg = 5) {
  return tube([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], b], r, 2, seg);
}

/**
 * The cabin, lofted (the Huey's machinery, rtsVehicles.js): a tall teardrop,
 * full-bodied to its rear, closing to a rounded nose. Built to ALAT photos
 * (2026-09-26): the bubble's top sits level with the centre body's, the
 * lower nose is solid, the glass runs from the waist over the top.
 */
const ALOUETTE_CABIN = [
  { z: 2.52, cy: 1.08, w: 0.1, h: 0.1, hb: 0.1, n: 2.0 },
  { z: 2.42, cy: 1.12, w: 0.44, h: 0.52, hb: 0.42, n: 2.2 },
  { z: 2.15, cy: 1.2, w: 0.61, h: 0.76, hb: 0.56, n: 2.3 },
  { z: 1.7, cy: 1.25, w: 0.68, h: 0.86, hb: 0.62, n: 2.5 },
  { z: 1.0, cy: 1.26, w: 0.69, h: 0.88, hb: 0.64, n: 2.7 },
  { z: 0.45, cy: 1.24, w: 0.66, h: 0.86, hb: 0.63, n: 3.2 },
  { z: 0.3, cy: 1.24, w: 0.64, h: 0.84, hb: 0.62, n: 3.4 },
];

/**
 * userData: stencil, glass (the canopy, for a glass material — see
 * games/alg-rts/showroom.js), rotors { main, tail } (the buildUH1 contract:
 * the renderer spins MainRotor about Y and TailRotor about X round their
 * pivots), length. Real: 9.66 m overall, 2.75 m high, 10.2 m rotor.
 */
export function buildAlouette({ detail = 1, crew = true } = {}) {
  const st = ALOUETTE_CABIN;
  // DETAIL 2 (the vehicle lab, 2026-10-07, from Alouette II photos): the centre body OPEN above
  // the tank (the fuel tank and the gearbox in their frame, as the real one), an AA-52 on its
  // side mount (the game's gunship); `crew: false` — the pilot and his passenger real soldiers
  // in the bubble, not white balls on boxes. 1 = the game's, unchanged.
  const D2 = detail >= 2;
  const seats = [];
  const hull = [], main = [], tail = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const DK = VA * 0.72;                 // the ALAT's dark olive, darker than the ground vehicles
  const WAIST = 0.32;                   // radians below the equator where the glass starts

  // ── Cabin: the lower nose solid, the glass over it ──────────────────────
  P(skinPatch(st, 2.52, 0.3, Math.PI + WAIST, 2 * Math.PI - WAIST, 0, { nz: 16, na: 12 }), [0, 0, 0], MAT.paint, DK);
  const glass = skinPatch(st, 2.52, 0.3, -WAIST, Math.PI + WAIST, 0, { nz: 18, na: 22 });
  // Frame: bows over the top along the body, the waist rails, three hoops
  // (windscreen, door front, door rear) — the dark lines the bubble reads by.
  const along = (a, z0 = 2.46, z1 = 0.3, off = 0.018) => {
    const pts = [];
    for (let k = 0; k <= 14; k++) {
      const z = z0 + ((z1 - z0) * k) / 14;
      const { p, n } = skinAt(st, z, a);
      pts.push(p.addScaledVector(n, off).toArray());
    }
    return pts;
  };
  const hoop = (z, off = 0.018) => {
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const a = -WAIST + ((Math.PI + 2 * WAIST) * k) / 16;
      const { p, n } = skinAt(st, z, a);
      pts.push(p.addScaledVector(n, off).toArray());
    }
    return pts;
  };
  for (const a of [Math.PI / 2, Math.PI / 2 - 0.62, Math.PI / 2 + 0.62]) P(tube(along(a, 2.4), 0.022, 20, 5), [0, 0, 0], MAT.paint, DK);
  for (const a of [-WAIST, Math.PI + WAIST]) P(tube(along(a), 0.03, 20, 5), [0, 0, 0], MAT.paint, DK);
  for (const z of [1.95, 1.0, 0.4]) P(tube(hoop(z), 0.028, 16, 5), [0, 0, 0], MAT.paint, DK);
  // Inside, seen through the glass: floor, two seats, the pilot and a
  // passenger in their helmets, the instrument console, the cyclic.
  P(buildBox(1.2, 0.05, 1.9), [0, 0.66, 1.35], MAT.paint, DK * 0.8);
  for (const sx of [-1, 1]) {
    P(buildBox(0.42, 0.1, 0.44), [sx * 0.3, 0.9, 0.85], MAT.canvas, 0.25);
    P(buildBox(0.38, 0.55, 0.08), [sx * 0.3, 1.2, 0.6], MAT.canvas, 0.25);
    if (crew) {
      P(buildBox(0.38, 0.5, 0.26), [sx * 0.3, 1.2, 0.8], MAT.canvas, 0.45);
      P(new THREE.SphereGeometry(0.13, 12, 9), [sx * 0.3, 1.62, 0.84], MAT.white, 0.55);
      P(buildBox(0.1, 0.1, 0.4), [sx * 0.3 + 0.12, 1.3, 1.02], MAT.canvas, 0.45, [0.6, 0, 0]);
    }
  }
  // The pilot (the Driving pose: hands forward, on the cyclic and the collective) and the man
  // beside him; feet below the cushions (the clips' hips ~0.5 m over the feet), hidden by the nose.
  if (!crew) seats.push({ p: [0.3, 0.47, 0.82], yaw: 0, clip: "drive" }, { p: [-0.3, 0.5, 0.82], yaw: 0, clip: "sit" });
  P(buildBox(0.8, 0.34, 0.26), [0, 1.05, 1.75], MAT.steel, 0.12, [0.35, 0, 0]);
  P(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), [0.3, 1.0, 1.2], MAT.steel, 0.2, [0.3, 0, 0]);

  // ── The centre body: a solid box behind the cabin, down to the skids'
  //    cross tubes; its side panels, the fuel filler, the step.
  const BZ0 = 0.36, BZ1 = -1.1, BY0 = 0.55, BY1 = 1.98, BW = 0.6;
  if (D2) {
    // OPEN above the tank: the body to 1.5 m, the fuel tank across it, the gearbox's frame up to
    // the fairing — four corner tubes and their diagonals.
    const TOPB = 1.5;
    P(buildBox(BW * 2, TOPB - BY0, BZ0 - BZ1), [0, (BY0 + TOPB) / 2, (BZ0 + BZ1) / 2], MAT.paint, DK);
    P(axleX(0.26, 1.0, 14), [0, TOPB + 0.24, -0.45], MAT.paint, DK * 1.12);
    for (const sx of [-1, 1]) for (const [z0, z1] of [[BZ0 - 0.06, 0.45], [BZ1 + 0.06, -0.35]]) {
      P(strut([sx * (BW - 0.06), TOPB, z0], [sx * 0.3, BY1, z1], 0.03, 6), [0, 0, 0], MAT.steel, 0.3);
    }
    for (const sx of [-1, 1]) P(strut([sx * (BW - 0.06), TOPB, BZ0 - 0.06], [sx * 0.3, BY1, -0.35], 0.022, 5), [0, 0, 0], MAT.steel, 0.28);
    P(buildBox(0.66, 0.05, 0.9), [0, BY1 - 0.02, 0.05], MAT.steel, 0.22);   // the gearbox deck
  } else {
    P(buildBox(BW * 2, BY1 - BY0, BZ0 - BZ1), [0, (BY0 + BY1) / 2, (BZ0 + BZ1) / 2], MAT.paint, DK);
  }
  for (const sx of [-1, 1]) {
    // Panel seams and a hatch on each side.
    for (const z of [0.0, -0.55]) P(buildBox(0.012, BY1 - BY0 - 0.1, 0.025), [sx * (BW + 0.006), (BY0 + BY1) / 2, z], MAT.steel, 0.1);
    P(buildBox(0.02, 0.5, 0.42), [sx * (BW + 0.01), 1.05, -0.8], MAT.paint, DK * 1.15);
    P(buildBox(0.05, 0.04, 0.3), [sx * (BW + 0.03), 0.64, 0.1], MAT.steel, 0.3);                // step
  }
  // The top of the body: the gearbox fairing, the mast.
  P(buildBox(0.7, 0.28, 0.9), [0, BY1 + 0.14, 0.05], MAT.paint, DK * 1.05);
  const hubY = 2.95, hubZ = 0.1;
  P(new THREE.CylinderGeometry(0.075, 0.1, hubY - BY1 - 0.28, 10), [0, (hubY + BY1 + 0.28) / 2, hubZ], MAT.steel, 0.3);
  // Control rods up the mast, the swashplate.
  P(new THREE.CylinderGeometry(0.2, 0.2, 0.05, 14), [0, 2.55, hubZ], MAT.steel, 0.35);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    P(buildBox(0.025, 0.4, 0.025), [Math.cos(a) * 0.16, 2.75, hubZ + Math.sin(a) * 0.16], MAT.steel, 0.3);
  }

  // ── The Artouste turbine on top, uncowled: intake, the casing with its
  //    rings, the accessories, and the BIG round exhaust facing aft.
  const EY = 2.32, EZ0 = -0.25, EZ1 = -1.25;
  for (const sx of [-1, 1]) for (const z of [EZ0, EZ1 + 0.1]) P(strut([sx * 0.4, BY1, z], [sx * 0.2, EY - 0.1, z], 0.03), [0, 0, 0], MAT.steel, 0.3);
  P(alongZ(0.24, 0.22, EZ0 - EZ1, 18), [0, EY, (EZ0 + EZ1) / 2], MAT.steel, 0.62);
  for (let k = 0; k < 5; k++) P(alongZ(0.255, 0.255, 0.035, 18), [0, EY, EZ0 - 0.08 - k * 0.2], MAT.steel, 0.35);
  P(new THREE.TorusGeometry(0.2, 0.05, 6, 16), [0, EY, EZ0 + 0.05], MAT.steel, 0.4);          // intake lip
  P(buildBox(0.26, 0.24, 0.36), [0.3, EY + 0.08, -0.6], MAT.steel, 0.25);                        // accessories
  P(new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8), [-0.3, EY - 0.05, -0.8], MAT.steel, 0.3, [Math.PI / 2, 0, 0]);
  {
    // Exhaust: flares from the casing to a wide round mouth, tipped up.
    const ex = new THREE.CylinderGeometry(0.34, 0.22, 0.55, 20, 1, true).rotateX(-Math.PI / 2 - 0.12);
    P(ex, [0, EY + 0.03, EZ1 - 0.25], MAT.steel, 0.2);
    P(new THREE.TorusGeometry(0.34, 0.03, 6, 20).rotateX(0.12), [0, EY + 0.06, EZ1 - 0.52], MAT.steel, 0.25);
    P(new THREE.CircleGeometry(0.32, 20).rotateY(Math.PI).rotateX(0.12), [0, EY + 0.06, EZ1 - 0.5], MAT.steel, 0.0);
  }
  // A fuel/oil pipe or two from the body up to the engine.
  P(tube([[0.35, BY1, -0.3], [0.38, BY1 + 0.2, -0.5], [0.24, EY - 0.1, -0.7]], 0.025, 8, 5), [0, 0, 0], MAT.steel, 0.3);

  // ── The lattice tail boom: two top longerons and one bottom one,
  //    converging aft, verticals and diagonals in every bay (an N truss).
  const TZ0 = BZ1 + 0.02, TZ1 = -6.35;
  const sec = (z) => {
    const f = (TZ0 - z) / (TZ0 - TZ1);
    const w = 0.34 * (1 - f) + 0.07 * f;
    return { L: [-w, 1.92 - 0.3 * f, z], R: [w, 1.92 - 0.3 * f, z], B: [0, 1.0 + 0.44 * f, z] };
  };
  const bays = 10;
  for (let k = 0; k < bays; k++) {
    const za = TZ0 + (TZ1 - TZ0) * (k / bays), zb = TZ0 + (TZ1 - TZ0) * ((k + 1) / bays);
    const a = sec(za), b = sec(zb);
    const r = 0.034 - 0.014 * (k / bays), rd = r * 0.62;
    for (const key of ["L", "R", "B"]) P(strut(a[key], b[key], r), [0, 0, 0], MAT.paint, DK);
    // The frame at the bay's front: the top cross-member, the two sides down.
    P(strut(a.L, a.R, rd, 4), [0, 0, 0], MAT.paint, DK);
    P(strut(a.L, a.B, rd, 4), [0, 0, 0], MAT.paint, DK);
    P(strut(a.R, a.B, rd, 4), [0, 0, 0], MAT.paint, DK);
    // A diagonal across each side face, and one across the top.
    P(strut(a.L, b.B, rd * 0.8, 4), [0, 0, 0], MAT.paint, DK);
    P(strut(a.R, b.B, rd * 0.8, 4), [0, 0, 0], MAT.paint, DK);
    P(strut(k % 2 ? a.L : a.R, k % 2 ? b.R : b.L, rd * 0.8, 4), [0, 0, 0], MAT.paint, DK);
  }
  // The tail-rotor drive shaft along the top of the lattice.
  P(strut([0, 1.95, TZ0], [0, 1.64, TZ1 + 0.1], 0.03, 6), [0, 0, 0], MAT.metal, 0.6);
  // ── The tail: gearbox, the small fin under it, the stabiliser with its
  //    end plates, and the tail skid — a hoop of tube under the end.
  const tEnd = sec(TZ1);
  P(buildBox(0.24, 0.24, 0.3), [0, tEnd.L[1] - 0.02, TZ1], MAT.paint, DK);
  {
    const fin = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0.62, -0.5), new THREE.Vector2(0.2, -0.46)]);
    const g = indexed(new THREE.ExtrudeGeometry(fin, { depth: 0.035, bevelEnabled: false }));
    g.rotateY(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
    P(g, [0.06, tEnd.B[1], TZ1 + 0.45], MAT.paint, DK);   // clear of the lattice tubes
  }
  const stabZ = TZ1 + 0.95, stabY = (sec(stabZ).L[1] + sec(stabZ).B[1]) / 2;
  P(buildBox(1.4, 0.035, 0.34), [0, stabY, stabZ], MAT.paint, DK);
  for (const sx of [-1, 1]) P(buildBox(0.035, 0.3, 0.36), [sx * 0.7, stabY + 0.04, stabZ], MAT.paint, DK);
  P(tube([[0, tEnd.B[1] - 0.46, TZ1 + 0.55], [0, 0.55, TZ1 + 0.2], [0, 0.42, TZ1 - 0.25], [0, 0.7, TZ1 - 0.45], [0, tEnd.B[1] - 0.2, TZ1 - 0.1]], 0.028, 16, 5), [0, 0, 0], MAT.steel, 0.3);

  if (D2) {
    // The AA-52 on its mount off the left side (the gunship): the cradle on the front cross tube,
    // the gun along the cabin, its ammunition box; the barrel's jacket and the flash hider.
    P(strut([1.0, 0.42, 1.25], [0.98, 0.95, 1.3], 0.03, 6), [0, 0, 0], MAT.steel, 0.3);
    P(buildBox(0.1, 0.12, 0.62), [0.98, 1.0, 1.42], MAT.steel, 0.12);
    P(alongZ(0.028, 0.028, 0.55, 8), [0.98, 1.02, 2.0], MAT.steel, 0.1);
    P(alongZ(0.04, 0.04, 0.1, 8), [0.98, 1.02, 2.3], MAT.steel, 0.15);
    P(buildBox(0.14, 0.16, 0.24), [0.98, 0.86, 1.3], MAT.paint, 0.35);
  }

  // ── Skids: long, low, turned up at the front; two arched cross tubes.
  for (const sx of [-1, 1]) {
    const x = sx * 1.02;
    P(tube([[x, 0.3, 2.05], [x, 0.14, 1.85], [x, 0.05, 1.5], [x, 0.05, -1.3], [x, 0.08, -1.5]], 0.045, 18, 6), [0, 0, 0], MAT.steel, 0.25);
  }
  for (const z of [1.25, -0.75]) {
    P(tube([[-1.02, 0.06, z], [-0.95, 0.42, z], [-0.5, BY0 - 0.02, z], [0.5, BY0 - 0.02, z], [0.95, 0.42, z], [1.02, 0.06, z]], 0.04, 18, 6), [0, 0, 0], MAT.paint, DK);
  }

  // ── Main rotor: three long thin blades, the hub with its drag dampers ───
  const BL = 4.9;
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    // The blade stops where its white tip begins (the tip laid OVER the
    // blade's end z-fought): same droop curve, carried on by the tip.
    const bl = BL - 0.28, droop = 0.18 * (bl / BL) ** 2;
    const b = blade(bl, 0.3, 0.045, droop);
    b.translate(0.28, 0, 0).rotateY(a);
    main.push({ geo: b, mat: MAT.steel, tone: 0.1 });
    const tip = blade(0.28, 0.305, 0.047, 0);
    tip.translate(0.28 + bl, -droop, 0).rotateY(a);
    main.push({ geo: tip, mat: MAT.white, tone: 0.5 });
    // Each grip 1 cm higher than the last: they overlap by the hub.
    main.push({ geo: buildBox(0.4, 0.1, 0.14), pos: [Math.cos(a) * 0.22, k * 0.01, -Math.sin(a) * 0.22], rot: [0, a, 0], mat: MAT.steel, tone: 0.28 });
    main.push({ geo: new THREE.CylinderGeometry(0.035, 0.035, 0.3, 6), pos: [Math.cos(a + 0.5) * 0.2, 0.085, -Math.sin(a + 0.5) * 0.2], rot: [0, a, Math.PI / 2], mat: MAT.steel, tone: 0.35 });
  }
  main.push({ geo: new THREE.CylinderGeometry(0.15, 0.17, 0.2, 14), mat: MAT.steel, tone: 0.2 });
  main.push({ geo: new THREE.SphereGeometry(0.09, 10, 6), pos: [0, 0.13, 0], mat: MAT.steel, tone: 0.3 });

  // ── Tail rotor (about X), on the left: three blades.
  for (let k = 0; k < 3; k++) {
    const b = blade(0.85, 0.13, 0.03, 0);
    b.rotateZ(Math.PI / 2).rotateX((k / 3) * Math.PI * 2);
    tail.push({ geo: b, mat: MAT.steel, tone: 0.12 });
  }
  tail.push({ geo: axleX(0.07, 0.12, 10), mat: MAT.steel, tone: 0.25 });
  const tailPivot = [-0.2, tEnd.L[1] - 0.02, TZ1];

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.08, radius: 2, strength: 0.3, groundFade: 0.2, floor: 0.55 });
  const mainGeo = assemble(main);
  bakeContactAO(mainGeo, { cell: 0.1, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
  const tailGeo = assemble(tail);
  bakeContactAO(tailGeo, { cell: 0.05, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });

  // Markings: the cockade and the serial on both sides of the centre body,
  // ARMÉE DE TERRE down the lower nose.
  const mk = [];
  for (const sx of [-1, 1]) {
    // (Detail 2: the body stops at 1.5 m — the cockade and serial come down onto it.)
    mk.push(stencilPatch("frCocarde", flatSurface([sx * (BW + 0.004), D2 ? 1.04 : 1.45, D2 ? -0.3 : -0.72], [sx, 0, 0], [0, 0, -sx], 0.46, "frCocarde"), { lift: 0.004 }));
    mk.push(stencilPatch("frSerialWhite", flatSurface([sx * (BW + 0.004), D2 ? 1.38 : 1.62, -0.1], [sx, 0, 0], [0, 0, -sx], 0.62, "frSerialWhite"), { lift: 0.004 }));
    const { p, n } = skinAt(st, 1.2, sx > 0 ? -0.62 : Math.PI + 0.62);
    mk.push(stencilPatch("frArmeeWhite", flatSurface(p.toArray(), n.toArray(), [0, 0, -sx], 0.9, "frArmeeWhite"), { lift: 0.01 }));
  }
  const stencil = mergeStencils(mk);

  for (const g of [geo, glass, mainGeo, tailGeo, stencil]) g?.scale(S, S, S);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.glass = glass;
  geo.userData.seats = seats.map((q) => ({ ...q, p: q.p.map((v) => v * S) }));
  geo.userData.rotors = {
    main: { geo: mainGeo, pivot: [0, hubY * S, hubZ * S] },
    tail: { geo: tailGeo, pivot: tailPivot.map((c) => c * S) },
  };
  // WHERE ITS GUN FIRES (the weapons pass): the AA-52's flash hider on the side mount (detail 2),
  // else under the cabin's nose.
  geo.userData.muzzles = [{ p: D2 ? [0.98 * S, 1.02 * S, 2.38 * S] : [0.7 * S, 0.9 * S, 2.0 * S] }];
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: -2 * S, hx: 1.3 * S, hz: 4.5 * S };
  return geo;
}

// ── AMX-13 ───────────────────────────────────────────────────────────────────

/**
 * Real: hull 4.88 m, 2.5 m wide, 2.3 m to the turret roof. userData: stencil,
 * gear, turret { geo, pivot, muzzle } (the M113 contract: the renderer turns
 * the turret about Y round its pivot).
 */
export function buildAMX13({ seed = 13, detail = 1 } = {}) {
  // DETAIL 2 (the vehicle lab, 2026-10-07): the road wheels and idler on the turned rubber tyre.
  const D2 = detail >= 2;
  const R = rng(seed);
  const hull = [], turret = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const T = (geo, pos, mat, tone = 0.5, rot) => turret.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const HW = 0.92, HB = 0.42, HT = 1.45;          // hull half-width, belly, deck

  // ── Hull: a box with a long sloped glacis to the nose, a short rear slope.
  {
    const side = new THREE.Shape([
      new THREE.Vector2(-2.35, HB), new THREE.Vector2(1.7, HB), new THREE.Vector2(2.45, HB + 0.35),
      new THREE.Vector2(1.35, HT), new THREE.Vector2(-2.2, HT), new THREE.Vector2(-2.45, HT - 0.3),
    ]);
    const g = indexed(new THREE.ExtrudeGeometry(side, { depth: HW * 2, bevelEnabled: false }));
    g.translate(0, 0, -HW).rotateY(-Math.PI / 2);   // -90: the profile's +x (the nose) to +Z
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
    P(g, [0, 0, 0], MAT.paint, VA);
  }
  // Track guards/sponsons over the tracks, with stowage bins.
  for (const sx of [-1, 1]) {
    P(buildBox(0.44, 0.05, 4.6), [sx * (HW + 0.2), HT - 0.3, -0.1], MAT.paint, VA * 0.95);
    for (let k = 0; k < 3; k++) P(buildBox(0.36, 0.28, 0.9), [sx * (HW + 0.2), HT - 0.13, -1.2 + k * 1.0], MAT.paint, VA * (0.9 + R() * 0.2));
    P(buildBox(0.4, 0.04, 0.5), [sx * (HW + 0.2), HT - 0.42, 2.3], MAT.paint, VA, [-0.5, 0, 0]);
  }
  // The engine decks up front right (louvres), the driver's hatch front left.
  for (let k = 0; k < 5; k++) P(buildBox(0.7, 0.03, 0.08), [-0.4, HT + 0.01 - k * 0.04, 1.2 - k * 0.14], MAT.steel, 0.1, [0.62, 0, 0]);
  P(buildBox(0.5, 0.06, 0.6), [0.42, HT + 0.02, 1.05], MAT.paint, VA * 1.1);
  for (let k = -1; k <= 1; k++) P(buildBox(0.1, 0.07, 0.04), [0.42 + k * 0.14, HT + 0.07, 1.36], MAT.steel, 0.05);
  // Headlights in guards, a towing pintle, exhausts on the rear.
  for (const sx of [-1, 1]) {
    P(new THREE.CylinderGeometry(0.08, 0.09, 0.12, 10).rotateX(Math.PI / 2), [sx * 0.62, 1.02, 2.12], MAT.steel, 0.15);
    P(new THREE.CylinderGeometry(0.065, 0.065, 0.02, 10).rotateX(Math.PI / 2), [sx * 0.62, 1.02, 2.19], MAT.white, 0.45);
    P(alongZ(0.05, 0.05, 0.4, 8), [sx * 0.4, 1.0, -2.5], MAT.steel, 0.05);
  }
  // Spare track links on the glacis, a tow cable, a jerrycan rack at the back.
  for (let k = 0; k < 4; k++) P(buildBox(0.38, 0.04, 0.14), [0.35, 1.25 - k * 0.1, 1.6 + k * 0.16], MAT.steel, 0.1, [0.62, 0, 0]);
  P(tube([[-0.8, HT + 0.03, -1.9], [-0.8, HT + 0.03, 0.8], [-0.5, HT + 0.03, 1.2]], 0.03, 8, 5), [0, 0, 0], MAT.steel, 0.25);
  for (let k = 0; k < 3; k++) P(buildBox(0.34, 0.44, 0.14), [-0.5 + k * 0.38, 1.1, -2.5], MAT.paint, 0.42);

  // ── Running gear: big sprocket in FRONT, five road wheels, the idler at
  //    the back on the ground, two return rollers.
  const wheelR = 0.29, t = 0.05;
  trackSide(G, {
    xc: -(HW + 0.2), tw: 0.35, t, wheelR, wheelsZ: [1.55, 0.78, 0, -0.78, -1.55],
    sprocket: { c: [2.1, 0.72], r: 0.3 }, idler: { c: [-2.15, 0.38], r: 0.3 },
    rollers: [{ z: 0.95, y: 0.86, r: 0.1 }, { z: -0.6, y: 0.83, r: 0.1 }], paintTone: VA * 0.9, d2: D2,
  });
  trackSide(G, {
    xc: HW + 0.2, tw: 0.35, t, wheelR, wheelsZ: [1.55, 0.78, 0, -0.78, -1.55],
    sprocket: { c: [2.1, 0.72], r: 0.3 }, idler: { c: [-2.15, 0.38], r: 0.3 },
    rollers: [{ z: 0.95, y: 0.86, r: 0.1 }, { z: -0.6, y: 0.83, r: 0.1 }], paintTone: VA * 0.9, d2: D2,
  });

  // ── The FL-10 turret, set BACK on the hull: fixed collar + oscillating top.
  //    Built in its own frame, pivot at the ring centre.
  const pivot = [0, HT, -0.55];
  T(new THREE.CylinderGeometry(0.82, 0.86, 0.2, 24), [0, 0.1, 0], MAT.paint, VA);
  for (const sx of [-1, 1]) T(buildBox(0.22, 0.42, 0.7), [sx * 0.72, 0.38, 0.1], MAT.paint, VA * 0.95);   // trunnion blocks
  {
    // The upper part: tall and narrow, a sharp glacis, the long bustle behind.
    const top = new THREE.Shape([
      new THREE.Vector2(-1.55, 0.05), new THREE.Vector2(0.85, 0.05), new THREE.Vector2(1.0, 0.25),
      new THREE.Vector2(0.55, 0.72), new THREE.Vector2(-1.35, 0.72), new THREE.Vector2(-1.6, 0.4),
    ]);
    const g = indexed(new THREE.ExtrudeGeometry(top, { depth: 1.26, bevelEnabled: false }));
    g.translate(0, 0, -0.63).rotateY(-Math.PI / 2);
    const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / 2, uv.getY(i) / 2);
    T(g, [0, 0.22, 0], MAT.paint, VA * 1.06);
  }
  // Two cupolas with their periscopes, the gunner's sight.
  for (const sx of [-1, 1]) {
    T(new THREE.CylinderGeometry(0.22, 0.24, 0.16, 14), [sx * 0.3, 1.02, -0.25], MAT.paint, VA);
    T(new THREE.CylinderGeometry(0.23, 0.23, 0.04, 14), [sx * 0.3, 1.11, -0.25], MAT.steel, 0.25);
    for (let k = 0; k < 3; k++) T(buildBox(0.09, 0.07, 0.05), [sx * 0.3 + (k - 1) * 0.12, 1.06, -0.05], MAT.steel, 0.05);
  }
  T(buildBox(0.16, 0.18, 0.26), [0.45, 0.98, 0.45], MAT.steel, 0.1);
  // The gun: mantlet, the long 75 mm (61.5 calibres!) and its double-baffle brake.
  T(buildBox(0.36, 0.3, 0.3), [0, 0.55, 1.05], MAT.paint, VA * 0.9);
  T(alongZ(0.068, 0.06, 3.6, 12), [0, 0.55, 2.95], MAT.paint, VA * 0.95);
  T(alongZ(0.1, 0.1, 0.36, 12), [0, 0.55, 4.9], MAT.steel, 0.2);
  for (const sx of [-1, 1]) T(buildBox(0.05, 0.16, 0.26), [sx * 0.12, 0.55, 4.9], MAT.steel, 0.12);
  // A .30 on the commander's cupola, smoke dischargers, the aerial, bustle stowage.
  T(alongZ(0.02, 0.02, 0.7, 6), [-0.3, 1.25, 0.1], MAT.steel, 0.1);
  for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) T(alongZ(0.045, 0.045, 0.22, 8), [sx * 0.66, 0.6 + k * 0.1, 0.62], MAT.steel, 0.25, [-0.5, 0, 0]);
  T(new THREE.CylinderGeometry(0.008, 0.012, 2.4, 5), [0.45, 2.1, -1.2], MAT.steel, 0.4, [0.1, 0, -0.05]);
  T(axleX(0.14, 1.0, 10), [0, 0.98, -1.35], MAT.canvas, 0.35);
  T(buildBox(0.3, 0.36, 0.14), [-0.4, 0.95, -1.62], MAT.paint, 0.42);
  const gunY = 0.55, muzzleZ = 5.1;

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const turretGeo = assemble(turret);
  bakeContactAO(turretGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0, floor: 0.6 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.1, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: plate on the glacis, a tricolour on the bins' rear, the cockade
  // on the engine deck for the aircraft. (The turret's own are left clean.)
  const st = [];
  st.push(stencilPatch("frPlate", flatSurface([-0.45, 0.98, 2.3], [0, 0.4, 0.92], [1, 0, 0], 0.5, "frPlate"), { lift: 0.006 }));
  for (const sx of [-1, 1]) st.push(stencilPatch("frTricolore", flatSurface([sx * (HW + 0.39), HT - 0.13, -1.2], [sx, 0, 0], [0, 0, -sx], 0.3, "frTricolore"), { lift: 0.006 }));
  st.push(stencilPatch("frCocarde", flatSurface([-0.4, HT + 0.012, 0.3], [0, 1, 0], [1, 0, 0], 0.6, "frCocarde"), { lift: 0.006 }));
  const stencil = mergeStencils(st);

  for (const g of [geo, turretGeo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.gear = gearGeo;
  geo.userData.turret = { geo: turretGeo, pivot: pivot.map((c) => c * S), muzzle: [0, gunY * S, muzzleZ * S] };
  // WHERE ITS GUN FIRES (the weapons pass): the 75 mm's brake, in the TURRET's frame.
  geo.userData.muzzles = [{ p: [0, gunY * S, (muzzleZ + 0.1) * S], turret: true }];
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.4 * S, hz: 2.6 * S };
  return geo;
}

// ── M3 HALF-TRACK ────────────────────────────────────────────────────────────

/** Real: 6.2 m long with the roller, 2.2 m wide. userData: stencil, gear, length. */
export function buildHalfTrack({ seed = 3, detail = 1, crew = true } = {}) {
  const R = rng(seed);
  // DETAIL 2 (the vehicle lab): rounded plates, rivets and seams, stowage, tyre treads; 1 = the
  // game's, unchanged (every part and every R() call as before).
  const D2 = detail >= 2;
  // crew: false — no box men; the SEATS go out in userData.seats for real (animated) soldiers.
  const seats = [];
  // The .50's MOUNT turns round its pulpit ring (detail 2; the weapons pass).
  const mount = [], MP = [0.45, 2.45, 0.6];
  const M = (geo, pos, mat, tone) => mount.push({ geo, pos: [pos[0] - MP[0], pos[1] - MP[1], pos[2] - MP[2]], mat, tone });
  const plate = (w, h, d) => (D2 ? roundedPlate(w, h, d) : buildBox(w, h, d));
  const vt = (t) => (D2 ? t * (0.94 + R() * 0.12) : t);   // plates a shade apart
  const hull = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const WR = 0.46, AXF = 1.95;

  // ── Chassis and the front axle.
  for (const sx of [-1, 1]) P(buildBox(0.1, 0.2, 5.2), [sx * 0.46, 0.72, -0.2], MAT.paint, VA * 0.8);
  P(axleX(0.08, 1.7, 8), [0, WR, AXF], MAT.steel, 0.2);

  // ── The armoured bonnet with its radiator louvres, flat wings over the wheels.
  P(plate(0.95, 0.62, 1.5), [0, 1.24, 1.95], MAT.paint, vt(VA));
  P(plate(1.0, 0.05, 1.5), [0, 1.57, 1.95], MAT.paint, vt(VA * 1.05));
  P(plate(0.9, 0.55, 0.06), [0, 1.24, 2.73], MAT.paint, vt(VA * 0.95));
  for (let k = 0; k < 6; k++) P(buildBox(0.72, 0.04, 0.03), [0, 1.04 + k * 0.08, 2.77], MAT.steel, 0.05);
  for (const sx of [-1, 1]) {
    if (D2) {
      // The M3's MUDGUARD (the reference photos, 2026-10-06): curled down at the nose, flat by the
      // bonnet, sweeping down behind the wheel into the step under the door — a chain of plates.
      const path = [[2.98, 0.9], [2.9, 1.04], [2.74, 1.13], [2.45, 1.16], [1.75, 1.16], [1.52, 1.12], [1.36, 1.02], [1.24, 0.9], [1.08, 0.84], [0.55, 0.84]];
      const ft = vt(VA);
      for (let k = 0; k < path.length - 1; k++) {
        const [z0, y0] = path[k], [z1, y1] = path[k + 1], L = Math.hypot(z1 - z0, y1 - y0);
        P(buildBox(0.6, 0.045, L + 0.03), [sx * 0.8, (y0 + y1) / 2, (z0 + z1) / 2], MAT.paint, ft, [Math.atan2(-(y1 - y0), z1 - z0), 0, 0]);
      }
      // Its rolled outer edge, a shade darker: what draws the curve at a distance.
      for (let k = 0; k < path.length - 1; k++) {
        const [z0, y0] = path[k], [z1, y1] = path[k + 1], L = Math.hypot(z1 - z0, y1 - y0);
        P(buildBox(0.04, 0.09, L + 0.03), [sx * 1.09, (y0 + y1) / 2 - 0.02, (z0 + z1) / 2], MAT.paint, ft * 0.8, [Math.atan2(-(y1 - y0), z1 - z0), 0, 0]);
      }
    } else {
      P(plate(0.44, 0.05, 1.3), [sx * 0.8, 1.2, 2.0], MAT.paint, vt(VA));
      P(buildBox(0.42, 0.05, 0.36), [sx * 0.8, 1.08, 2.72], MAT.paint, VA, [0.6, 0, 0]);
    }
    P(new THREE.CylinderGeometry(0.1, 0.11, 0.14, 12).rotateX(Math.PI / 2), [sx * 0.62, 1.34, 2.78], MAT.steel, 0.15);
    P(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.62, 1.34, 2.86], MAT.white, 0.45);
  }
  // The roller on its frame in front: the half-track's nose.
  P(axleX(0.26, 1.25, 16), [0, 0.72, 3.2], MAT.steel, 0.2);
  for (const sx of [-1, 1]) P(buildBox(0.06, 0.12, 0.6), [sx * 0.66, 0.72, 2.95], MAT.paint, VA * 0.9);

  // ── The armoured box: sides, the cab's armoured windscreen (plates up,
  //    vision slits), the rear door, all open on top.
  const BZ0 = 1.2, BZ1 = -2.85, BL = BZ0 - BZ1, BZ = (BZ0 + BZ1) / 2, BW = 1.0, TOPY = 2.05;
  P(plate(BW * 2, 0.08, BL), [0, 1.05, BZ], MAT.paint, vt(VA * 0.85));                             // floor
  // The CAB (detail 2, the reference photos): its sides cut down to the door line in front of
  // the troop box, as the M3's are.
  const CABZ = 0.15, DOORY = 1.62;
  for (const sx of [-1, 1]) {
    if (D2) {
      P(plate(0.06, TOPY - 1.05, CABZ - BZ1 + 0.02), [sx * BW, (TOPY + 1.05) / 2, (CABZ + BZ1 - 0.02) / 2], MAT.paint, vt(VA));
      P(plate(0.06, DOORY - 1.05, BZ0 - CABZ + 0.02), [sx * BW, (DOORY + 1.05) / 2, (BZ0 + CABZ + 0.02) / 2], MAT.paint, vt(VA));
    } else P(plate(0.06, TOPY - 1.05, BL + 0.04), [sx * BW, (TOPY + 1.05) / 2, BZ], MAT.paint, vt(VA));   // past the floor's ends
  }
  P(plate(BW * 2, TOPY - 1.11, 0.06), [0, (TOPY + 1.05) / 2, BZ1], MAT.paint, vt(VA));   // 3 cm under the sides' top
  P(buildBox(0.6, 0.72, 0.03), [0, 1.5, BZ1 - 0.035], MAT.paint, VA * 1.08);                     // rear door
  P(plate(BW * 2, 0.5, 0.06), [0, 1.5, BZ0], MAT.paint, vt(VA));                                  // dash
  if (D2) {
    // The WINDSCREEN: a frame on the dash, two panes, the armour flap hinged on top and raised
    // like a visor (the French photo); the wheel, the dash's dials, the cab's seats.
    const WY0 = 1.75, WY1 = 2.2, WZ = BZ0 - 0.02;
    for (const x of [-BW + 0.03, 0, BW - 0.03]) P(buildBox(0.06, WY1 - WY0, 0.06), [x, (WY0 + WY1) / 2, WZ], MAT.paint, VA * 0.9);
    P(buildBox(BW * 2, 0.06, 0.07), [0, WY1, WZ], MAT.paint, VA * 0.9);
    for (const sx of [-1, 1]) P(buildBox(BW - 0.08, WY1 - WY0 - 0.04, 0.015), [sx * (BW / 2), (WY0 + WY1) / 2, WZ], MAT.steel, 0.05);
    const fa = 1.15, fh = 0.48;
    P(plate(BW * 2 + 0.02, fh, 0.05), [0, WY1 + 0.03 + Math.cos(fa) * fh / 2, WZ + Math.sin(fa) * fh / 2], MAT.paint, vt(VA * 1.02), [fa, 0, 0]);
    for (const sx of [-1, 1]) P(buildBox(0.04, 0.05, 0.1), [sx * 0.8, WY1 + 0.03, WZ + 0.03], MAT.steel, 0.2);   // hinges
    P(buildBox(BW * 2 - 0.1, 0.06, 0.3), [0, 1.73, BZ0 - 0.17], MAT.paint, VA * 0.7);                       // dash top
    for (const x of [-0.6, -0.45, -0.3]) P(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 10).rotateX(Math.PI / 2), [x, 1.62, BZ0 - 0.04], MAT.white, 0.35);
    // The WHEEL where the Driving clip's hands close (measured in the lab: 1.85 up, 0.77 along,
    // 0.52 apart), its column down to the dash; the board under the dash his boots stop at.
    const WH = [-0.49, 1.85, 0.77], WA = 0.64, cd = [0, -Math.sin(WA), Math.cos(WA)];
    P(new THREE.TorusGeometry(0.25, 0.02, 6, 22), WH, MAT.rubber, 0.3, [WA, 0, 0]);
    P(alongZ(0.025, 0.025, 0.55, 6), [WH[0], WH[1] + cd[1] * 0.28, WH[2] + cd[2] * 0.28], MAT.steel, 0.15, [WA, 0, 0]);
    P(buildBox(BW * 2 - 0.1, 0.2, 0.05), [0, 1.16, BZ0], MAT.paint, VA * 0.7);
    for (const x of [-0.45, 0.45]) {
      P(roundedPlate(0.5, 0.1, 0.42, 0.03), [x, 1.42, 0.5], MAT.canvas, 0.3);                                // seat
      P(roundedPlate(0.5, 0.45, 0.08, 0.03), [x, 1.7, 0.27], MAT.canvas, 0.28, [-0.12, 0, 0]);              // back
      P(buildBox(0.4, 0.33, 0.36), [x, 1.25, 0.5], MAT.paint, VA * 0.7);
    }
    // Cab doors, cut low, with their hinges.
    for (const sx of [-1, 1]) {
      P(plate(0.05, DOORY - 1.12, 0.86), [sx * (BW + 0.03), (DOORY + 1.12) / 2, 0.66], MAT.paint, vt(VA * 1.04));
      for (const y of [1.25, 1.5]) P(buildBox(0.03, 0.06, 0.05), [sx * (BW + 0.06), y, 1.07], MAT.steel, 0.2);
    }
    // The troop box's benches: lockers along each side, cushions on top.
    for (const sx of [-1, 1]) {
      P(buildBox(0.34, 0.38, 2.45), [sx * (BW - 0.2), 1.28, -1.42], MAT.paint, VA * 0.8);
      P(roundedPlate(0.36, 0.07, 2.45, 0.025), [sx * (BW - 0.2), 1.5, -1.42], MAT.canvas, 0.32);
    }
  } else {
    P(plate(BW * 2, 0.55, 0.06), [0, 2.02, BZ0 - 0.05], MAT.paint, vt(VA * 1.02), [-0.25, 0, 0]);   // windscreen armour, raised
    for (const sx of [-1, 1]) P(buildBox(0.5, 0.05, 0.02), [sx * 0.45, 2.02, BZ0 - 0.01], MAT.steel, 0.02, [-0.25, 0, 0]);
    // Cab doors cut lower.
    for (const sx of [-1, 1]) P(plate(0.06, 0.4, 0.9), [sx * (BW + 0.01), 1.3, 0.65], MAT.paint, vt(VA * 1.04));
  }
  // The .50 on its pulpit ring over the cab, the men in the back, stowage.
  P(new THREE.TorusGeometry(0.42, 0.04, 6, 20).rotateX(Math.PI / 2), [0.45, 2.45, 0.6], MAT.steel, 0.2);
  for (const sx of [-1, 1]) P(buildBox(0.05, 0.9, 0.05), [0.45 + sx * 0.4, 2.0, 0.6], MAT.steel, 0.2);
  ((D2 ? M : P))(buildBox(0.14, 0.14, 1.1), [0.45, 2.55, 1.0], MAT.steel, 0.12);
  ((D2 ? M : P))(alongZ(0.025, 0.025, 0.4, 6), [0.45, 2.55, 1.7], MAT.steel, 0.1);
  if (D2) M(buildBox(0.1, 0.12, 0.3), [0.45, 2.5, 0.75], MAT.steel, 0.2);   // the carriage on the ring
  if (crew) {
    soldierSeated(P, -0.45, 1.2, 0.6, R);                                                         // driver
    for (let k = 0; k < 4; k++) {
      const sx = k % 2 ? 1 : -1, z = -0.5 - Math.floor(k / 2) * 1.0;
      P(buildBox(0.36, 0.5, 0.24), [sx * 0.6, 1.55, z], MAT.canvas, 0.5 + R() * 0.1, [0, sx * Math.PI / 2, 0]);
      P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [sx * 0.6, 1.95, z], MAT.paint, VA * 1.1);
    }
  } else {
    // SEATS (feet on the floor, facing yaw; the soldier at the game's height): the driver at
    // the wheel, a man beside him, men on the benches facing in — a gap or two, not a full load.
    seats.push({ p: [-0.45, 1.03, 0.48], yaw: 0, clip: "drive" }, { p: [0.45, 1.09, 0.6], yaw: 0, clip: "sit" });
    [-0.45, -1.15, -1.85, -2.45].forEach((z, k) => {
      for (const sx of [-1, 1]) {
        if ((k + (sx > 0 ? 1 : 0)) % 3 === 2) continue;
        seats.push({ p: [sx * (BW - 0.2), 1.09, z], yaw: -sx * Math.PI / 2, clip: (k + (sx > 0 ? 1 : 0)) % 2 ? "sit_talk" : "sit" });
      }
    });
  }
  for (const sx of [-1, 1]) P(buildBox(0.1, 0.25, 1.8), [sx * (BW + 0.08), 1.75, -1.6], MAT.canvas, 0.35);     // bedrolls on the rails
  P(buildBox(0.3, 0.44, 0.14), [0.6, 1.4, BZ1 - 0.1], MAT.paint, 0.42);                          // jerrycan
  // Mine racks on the sides, the M3's tell.
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) P(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 12).rotateZ(Math.PI / 2), [sx * (BW + 0.08), 1.25, -0.2 - k * 0.35], MAT.paint, VA * 0.8);

  if (D2) {
    // (NO RIVETS as geometry: 2 cm heads caught the sun and read as white dashes at the RTS's
    //  distance — measured in the lab; small detail belongs in the texture.)
    for (const sx of [-1, 1]) {
      // Plate SEAMS: the cab's join and the door's edges, a strap of plate a little proud.
      P(buildBox(0.014, TOPY - 1.12, 0.05), [sx * (BW + 0.038), (TOPY + 1.1) / 2, 0.15], MAT.paint, VA * 0.78);
      P(buildBox(0.014, 0.42, 0.04), [sx * (BW + 0.045), 1.3, 1.1], MAT.paint, VA * 0.78);
    }
    // STOWAGE, as every half-track in the field carried it.
    // A rack of jerrycans on the back plate (the old one at 0.6 stays) with its strap.
    for (const x of [-0.62, -0.28]) jerrycan(P, x, 1.4, BZ1 - 0.12, 0, 0.38 + R() * 0.08);
    P(buildBox(1.6, 0.03, 0.03), [0, 1.48, BZ1 - 0.2], MAT.canvas, 0.25);
    // A rolled tarpaulin across the bonnet, strapped.
    P(new THREE.CylinderGeometry(0.13, 0.13, 0.86, 12).rotateZ(Math.PI / 2), [0, 1.72, 2.45], MAT.canvas, 0.42);
    for (const x of [-0.25, 0.25]) P(new THREE.TorusGeometry(0.135, 0.012, 4, 12).rotateY(Math.PI / 2), [x, 1.72, 2.45], MAT.canvas, 0.2);
    // Pioneer tools on the left side: a shovel and a pick on their brackets.
    P(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 6).rotateX(Math.PI / 2), [-(BW + 0.07), 1.62, -2.05], MAT.timber, 0.4);
    P(buildBox(0.02, 0.24, 0.2), [-(BW + 0.07), 1.62, -2.65], MAT.steel, 0.25);
    P(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6).rotateX(Math.PI / 2), [-(BW + 0.07), 1.45, -2.0], MAT.timber, 0.35);
    P(buildBox(0.03, 0.42, 0.04), [-(BW + 0.07), 1.45, -2.48], MAT.steel, 0.2);
    for (const z of [-1.7, -2.4]) P(buildBox(0.05, 0.3, 0.03), [-(BW + 0.05), 1.53, z], MAT.steel, 0.2);
    // In the back: ammunition boxes and a crate.
    for (let k = 0; k < 3; k++) P(roundedPlate(0.3, 0.17, 0.16, 0.012), [0.2 - k * 0.04, 1.18 + k * 0.17, -2.55 + (k % 2) * 0.05], MAT.paint, 0.3 + R() * 0.08, [0, R() * 0.3, 0]);
    P(roundedPlate(0.4, 0.36, 0.4, 0.015), [-0.25, 1.27, -2.5], MAT.timber, 0.45, [0, 0.12, 0]);
    // A helmet hung on the right side, the radio's whip at the back corner.
    P(new THREE.SphereGeometry(0.15, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1).rotateZ(-Math.PI / 2), [BW + 0.08, 1.85, 0.0], MAT.paint, VA * 1.1);
    P(new THREE.CylinderGeometry(0.008, 0.012, 2.2, 4), [-(BW - 0.08), TOPY + 1.05, BZ1 + 0.1], MAT.steel, 0.1);
    // The front BUMPER, a channel across the full width, the roller's frame behind it.
    P(roundedPlate(2.24, 0.18, 0.14, 0.02), [0, 0.8, 3.0], MAT.paint, VA * 0.85);
    // Brush guards over the headlights.
    for (const sx of [-1, 1]) for (const dx of [-0.07, 0, 0.07]) P(buildBox(0.012, 0.24, 0.012), [sx * 0.62 + dx, 1.34, 2.92], MAT.steel, 0.18);
  }

  // ── Front wheels (they roll), the rear track unit.
  const wheelAt = (x, z) => {
    const s = [WR, z, WR, 1];
    if (D2) {
      // The jeep's wheel at the half-track's size (you: "yes" — the plate lugs read as a cog).
      G(tyre(WR, 0.27, 0.265, 18, true), [x, WR, z], MAT.rubber, 0.5, undefined, s);
      G(chevronTread(WR, 0.27, { bars: 18, fill: 0.5, depth: 0.02 }), [x, WR, z], MAT.rubber, 0.3, undefined, s);
      G(combatRim(0.265, 0.27, 12, true), [x, WR, z], MAT.paint, VA * 0.9, undefined, s);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        G(new THREE.CylinderGeometry(0.016, 0.016, 0.19, 6).rotateZ(Math.PI / 2).translate(0, Math.cos(a) * 0.145, Math.sin(a) * 0.145), [x, WR, z], MAT.steel, 0.35, undefined, s);
      }
      return;
    }
    G(axleX(WR, 0.26, 20), [x, WR, z], MAT.rubber, 0.5, undefined, s);
    G(axleX(0.27, 0.28, 14), [x, WR, z], MAT.paint, VA * 0.9, undefined, s);
    G(axleX(0.09, 0.3, 8), [x, WR, z], MAT.steel, 0.3, undefined, s);
  };
  for (const sx of [-1, 1]) wheelAt(sx * 0.84, AXF);
  for (const sx of [-1, 1]) {
    if (D2) {
      // The M3's run (the photos): the sprocket up front and the idler behind both RAISED off
      // the ground, two bogies of paired wheels between, one return roller under the top run.
      trackSide(G, {
        xc: sx * 0.82, tw: 0.3, t: 0.04, wheelR: 0.2, wheelsZ: [-0.52, -0.98, -1.52, -1.98],
        sprocket: { c: [0.08, 0.6], r: 0.27 }, idler: { c: [-2.56, 0.58], r: 0.24 }, paintTone: VA * 0.9,
        rollers: [{ z: -1.25, y: 0.77, r: 0.08 }], d2: true, bogies: [[-0.52, -0.98], [-1.52, -1.98]],
      });
    } else {
      trackSide(G, {
        xc: sx * 0.82, tw: 0.3, t: 0.04, wheelR: 0.2, wheelsZ: [-0.55, -1.0, -1.45, -1.9],   // 0.23 overlapped its neighbours side to side
        sprocket: { c: [0.05, 0.56], r: 0.26 }, idler: { c: [-2.5, 0.52], r: 0.24 }, paintTone: VA * 0.9,
      });
    }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  const st = [];
  st.push(stencilPatch("frPlate", flatSurface([0.45, 1.06, 2.795], [0, 0, 1], [1, 0, 0], 0.46, "frPlate"), { lift: 0.004 }));
  for (const sx of [-1, 1]) {
    st.push(stencilPatch("frTricolore", flatSurface([sx * (BW + 0.035), 1.75, -0.3], [sx, 0, 0], [0, 0, -sx], 0.32, "frTricolore"), { lift: 0.004 }));
    st.push(stencilPatch("frUnitCode", flatSurface([sx * (BW + 0.035), 1.45, -2.2], [sx, 0, 0], [0, 0, -sx], 0.8, "frUnitCode"), { lift: 0.004 }));
  }
  const stencil = mergeStencils(st);

  for (const g of [geo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.gear = gearGeo;
  geo.userData.seats = seats.map((q) => ({ ...q, p: q.p.map((v) => v * S) }));
  // WHERE ITS GUN FIRES (the weapons pass): the .50 on its ring over the cab.
  geo.userData.muzzles = [D2 ? { p: [0, (2.55 - MP[1]) * S, (1.92 - MP[2]) * S], turret: true } : { p: [0.45 * S, 2.55 * S, 1.92 * S] }];
  if (D2) {
    const mountGeo = assemble(mount);
    bakeContactAO(mountGeo, { cell: 0.06, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
    mountGeo.scale(S, S, S);
    geo.userData.turret = { geo: mountGeo, pivot: MP.map((c) => c * S), muzzle: geo.userData.muzzles[0].p };
  }
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.2 * S, hz: 3.2 * S };
  return geo;
}
