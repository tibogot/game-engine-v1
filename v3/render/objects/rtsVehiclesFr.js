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
import { MAT, assemble, bakeContactAO, buildBox, rng } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";
import { VEHICLE_KIT } from "./rtsVehicles.js";

const { S, indexed, axleX, alongZ, trackBand, trackPath, packGear, loftSkin, skinAt, skinPatch, tube, blade } = VEHICLE_KIT;

/**
 * A track run for one side at x = xc: the band round `wheelsZ` from sprocket
 * to idler, the road wheels (rubber, disc, hub, bolts), sprocket teeth, the
 * idler, return rollers. Pushes into G (the rolling gear). Real metres.
 */
function trackSide(G, { xc, tw, t, wheelR, wheelsZ, sprocket, idler, rollers = null, paintTone }) {
  const path = trackPath({ front: sprocket, rear: idler, wheelsZ, wheelR, t, rollers });
  G(indexed(trackBand(path, xc, tw, t)), [0, 0, 0], MAT.steel, 0.03, undefined, [0, 0, 0, 2]);
  const wheel = (cy, cz, r) => [cy, cz, r, 1];
  for (const z of wheelsZ) {
    const w = wheel(wheelR + t, z, wheelR);
    G(axleX(wheelR, tw * 0.8, 16), [xc, wheelR + t, z], MAT.rubber, 0.5, undefined, w);
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
  G(axleX(idler.r, tw * 0.8, 16), [xc, idler.c[1], idler.c[0]], MAT.rubber, 0.45, undefined, iw);
  G(axleX(idler.r * 0.6, tw * 0.82, 12), [xc, idler.c[1], idler.c[0]], MAT.paint, paintTone, undefined, iw);
  for (const r of rollers ?? []) G(axleX(r.r, tw * 0.5, 10), [xc, r.y, r.z], MAT.rubber, 0.4, undefined, wheel(r.y, r.z, r.r));
}

/** Per-part tone of the painted panels (the kit's OD tone, as the US vehicles). */
const VA = 0.15;

/**
 * "Vert armée" under the Aurès sun: the atlas's olive paint multiplied by this
 * (rtsObjectMaterialTinted). The US olive drab went LIME in this light; the
 * French green was browner and duller to begin with.
 */
export const FR_PAINT_TINT = [0.74, 0.66, 0.5];

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

export function buildEBR({ seed = 75 } = {}) {
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

export function buildWillys({ seed = 44 } = {}) {
  const R = rng(seed);
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
  P(buildBox(1.26, 0.05, TL), [0, 0.62, TZ], MAT.paint, VA * 0.9);
  for (const sx of [-1, 1]) {
    P(buildBox(0.05, 0.44, TL), [sx * 0.64, 0.84, TZ], MAT.paint, VA);
    P(buildBox(0.26, 0.3, 0.86), [sx * 0.49, 0.8, AXR], MAT.paint, VA * 0.92);          // rear wheel arch
    P(buildBox(0.08, 0.04, TL), [sx * 0.64, 1.07, TZ], MAT.paint, VA * 0.85);           // rolled lip
  }
  P(buildBox(1.28, 0.44, 0.05), [0, 0.84, TZ1], MAT.paint, VA);
  P(buildBox(1.34, 0.04, 0.08), [0, 1.07, TZ1], MAT.paint, VA * 0.85);
  for (const sx of [-1, 1]) {
    P(buildBox(0.44, 0.1, 0.44), [sx * 0.3, 0.84, -0.3], MAT.canvas, 0.3);
    P(buildBox(0.42, 0.44, 0.08), [sx * 0.3, 1.08, -0.54], MAT.canvas, 0.3);
  }
  P(buildBox(1.1, 0.1, 0.4), [0, 0.98, -1.35], MAT.canvas, 0.3);
  P(buildBox(1.26, 0.36, 0.08), [0, 0.92, TZ0], MAT.paint, VA);                         // cowl
  P(new THREE.TorusGeometry(0.17, 0.018, 5, 16).rotateX(Math.PI / 2 - 0.9), [0.3, 1.12, 0.12], MAT.steel, 0.05);

  // ── Bonnet, the slotted grille with the lamps in it, flat fenders, bumper.
  P(buildBox(0.78, 0.06, 1.2), [0, 1.03, 0.92], MAT.paint, VA * 1.05);
  for (const sx of [-1, 1]) P(buildBox(0.05, 0.4, 1.2), [sx * 0.39, 0.82, 0.92], MAT.paint, VA);
  P(buildBox(0.84, 0.62, 0.05), [0, 0.75, 1.54], MAT.paint, VA);
  for (let k = 0; k < 9; k++) P(buildBox(0.045, 0.4, 0.02), [-0.28 + k * 0.07, 0.77, 1.57], MAT.steel, 0.02);
  for (const sx of [-1, 1]) {
    P(new THREE.CylinderGeometry(0.085, 0.085, 0.05, 12).rotateX(Math.PI / 2), [sx * 0.33, 0.9, 1.56], MAT.steel, 0.2);
    P(new THREE.CylinderGeometry(0.07, 0.07, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.33, 0.9, 1.585], MAT.white, 0.45);
    P(buildBox(0.3, 0.04, 1.05), [sx * 0.6, 0.86, 1.02], MAT.paint, VA);
    P(buildBox(0.28, 0.04, 0.26), [sx * 0.6, 0.77, 1.58], MAT.paint, VA, [0.75, 0, 0]);
    P(buildBox(0.04, 0.24, 0.8), [sx * 0.46, 0.73, 1.0], MAT.paint, VA * 0.9);
  }
  P(buildBox(1.5, 0.12, 0.1), [0, 0.46, 1.66], MAT.paint, VA * 0.9);
  for (const sx of [-1, 1]) P(buildBox(0.08, 0.12, 0.1), [sx * 0.42, 0.46, 1.74], MAT.steel, 0.3);

  // ── Windscreen folded down onto the bonnet (the djebel way).
  P(buildBox(1.2, 0.05, 0.42), [0, 1.09, 0.56], MAT.paint, VA * 0.95);
  P(buildBox(1.08, 0.02, 0.32), [0, 1.12, 0.56], MAT.steel, 0.08);

  // ── Tail: spare wheel and a jerrycan.
  G(axleX(WR * 0.95, 0.18, 18).rotateY(Math.PI / 2), [0.28, 0.86, TZ1 - 0.12], MAT.rubber, 0.5, undefined, [0, 0, 0, 0]);
  G(axleX(0.18, 0.2, 12).rotateY(Math.PI / 2), [0.28, 0.86, TZ1 - 0.12], MAT.paint, VA, undefined, [0, 0, 0, 0]);
  P(buildBox(0.16, 0.46, 0.32), [-0.34, 0.86, TZ1 - 0.13], MAT.paint, 0.4);

  // ── The .30 on its pedestal behind the seats, its ammo box; the whip aerial
  //    bent over and tied down.
  P(new THREE.CylinderGeometry(0.04, 0.05, 0.8, 8), [0, 1.05, -0.8], MAT.steel, 0.25);
  P(buildBox(0.14, 0.14, 0.9), [0, 1.52, -0.55], MAT.steel, 0.12);
  P(alongZ(0.025, 0.025, 0.5, 6), [0, 1.52, -0.05], MAT.steel, 0.1);
  P(buildBox(0.16, 0.14, 0.26), [0.14, 1.44, -0.72], MAT.paint, 0.35);
  P(tube([[-0.58, 0.98, TZ1 + 0.1], [-0.6, 1.9, TZ1 + 0.4], [-0.55, 2.2, -0.6], [-0.5, 2.1, 0.2]], 0.012, 12, 4), [0, 0, 0], MAT.steel, 0.35);

  // ── The crew: the driver, and the gunner standing at the gun.
  soldierSeated(P, 0.3, 0.9, -0.34, R);
  P(buildBox(0.38, 0.58, 0.24), [0, 1.2, -1.05], MAT.canvas, 0.52);
  for (const dx of [-0.18, 0.18]) P(buildBox(0.09, 0.09, 0.4), [dx, 1.45, -0.86], MAT.canvas, 0.5, [0.2, 0, 0]);
  P(new THREE.SphereGeometry(0.1, 10, 7), [0, 1.62, -1.06], MAT.canvas, 0.15);
  P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [0, 1.66, -1.06], MAT.paint, VA * 1.1);

  // ── Wheels.
  const wheelAt = (x, z) => {
    const s = [WR, z, WR, 1];
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

export function buildGMC({ seed = 353 } = {}) {
  const R = rng(seed);
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
    P(buildBox(0.05, 0.56, 1.55), [sx * 0.43, 1.34, 2.18], MAT.paint, VA);
    for (let k = 0; k < 6; k++) P(buildBox(0.02, 0.05, 0.3), [sx * 0.46, 1.44, 1.7 + k * 0.17], MAT.steel, 0.05);
  }
  P(buildBox(0.9, 0.78, 0.06), [0, 1.3, 2.98], MAT.paint, VA * 0.95);
  for (let k = 0; k < 8; k++) P(buildBox(0.05, 0.64, 0.03), [-0.33 + k * 0.094, 1.3, 3.02], MAT.steel, 0.05);
  for (const sx of [-1, 1]) {
    P(buildBox(0.05, 0.9, 0.05), [sx * 0.5, 1.3, 3.16], MAT.steel, 0.25);
    P(new THREE.CylinderGeometry(0.11, 0.12, 0.14, 12).rotateX(Math.PI / 2), [sx * 0.72, 1.46, 2.95], MAT.steel, 0.15);
    P(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.72, 1.46, 3.03], MAT.white, 0.4);
  }
  for (const y of [1.0, 1.72]) P(buildBox(1.04, 0.05, 0.05), [0, y, 3.16], MAT.steel, 0.25);
  P(buildBox(2.2, 0.18, 0.14), [0, 0.8, 3.24], MAT.paint, VA * 0.9);                       // bumper
  P(axleX(0.14, 0.7, 12), [0, 0.95, 3.2], MAT.steel, 0.2);                                  // winch drum
  for (const sx of [-1, 1]) P(buildBox(0.12, 0.14, 0.18), [sx * 0.8, 0.72, 3.33], MAT.steel, 0.3);

  // ── The banjo wings over the front wheels, and running boards to the cab.
  for (const sx of [-1, 1]) {
    P(wing(WR + 0.14, 0.44, 0.1, 2.5), [sx * 0.88, WR, AXF], MAT.paint, VA);
    P(buildBox(0.36, 0.05, 1.05), [sx * 0.92, 0.92, 0.95], MAT.paint, VA * 0.9);          // running board
    P(buildBox(0.36, 0.04, 0.42), [sx * 0.92, 1.08, 1.62], MAT.paint, VA, [0.5, 0, 0]);   // wing's tail down to the board
  }

  // ── The closed cab: body, rounded roof, split windscreen, doors with windows.
  const CZ = 0.72, CW = 1.92, CD = 1.28;
  P(buildBox(CW, 0.95, CD), [0, 1.52, CZ], MAT.paint, VA);
  P(buildBox(CW - 0.04, 0.5, 0.06), [0, 2.24, CZ + CD / 2 - 0.03], MAT.paint, VA * 0.98);   // windscreen frame
  for (const sx of [-1, 1]) P(buildBox(0.82, 0.4, 0.03), [sx * 0.44, 2.24, CZ + CD / 2 + 0.01], MAT.steel, 0.08);
  for (const sx of [-1, 1]) {
    P(buildBox(0.06, 0.5, CD - 0.04), [sx * (CW / 2 - 0.03), 2.24, CZ], MAT.paint, VA);
    P(buildBox(0.03, 0.36, 0.62), [sx * (CW / 2 + 0.005), 2.26, CZ + 0.18], MAT.steel, 0.08);  // door window
    P(buildBox(0.02, 0.04, 0.3), [sx * (CW / 2 + 0.02), 1.72, CZ + 0.3], MAT.steel, 0.3);     // handle
    P(buildBox(0.32, 0.03, 0.03), [sx * (CW / 2 + 0.16), 2.3, CZ + 0.6], MAT.steel, 0.25);    // mirror arm
    P(buildBox(0.03, 0.24, 0.16), [sx * (CW / 2 + 0.32), 2.3, CZ + 0.6], MAT.steel, 0.1);
  }
  P(buildBox(CW, 0.5, 0.06), [0, 2.24, CZ - CD / 2 + 0.03], MAT.paint, VA);
  {
    const roof = new THREE.CylinderGeometry(1, 1, CD + 0.06, 18, 1, false, -Math.PI / 2, Math.PI);
    roof.rotateX(-Math.PI / 2).scale(CW / 2 + 0.02, 0.22, 1);   // -90: the arc on TOP (+90 hangs it below the axis)
    P(roof, [0, 2.48, CZ], MAT.paint, VA * 1.05);
  }
  // Driver behind the glass (left-hand drive: +X).
  P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [0.45, 2.3, CZ + 0.05], MAT.paint, VA * 1.1);
  P(buildBox(0.4, 0.4, 0.24), [0.45, 2.02, CZ], MAT.canvas, 0.5);

  // ── The bed: floor, low sides, and the canvas tilt over its bows.
  const BZ0 = 0.0, BZ1 = -3.55, BL = BZ0 - BZ1, BZ = (BZ0 + BZ1) / 2;
  P(buildBox(2.2, 0.1, BL), [0, 1.22, BZ], MAT.paint, VA * 0.9);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 3; k++) P(buildBox(0.05, 0.13, BL - 0.1), [sx * 1.09, 1.36 + k * 0.16, BZ], MAT.timber, 0.3 + R() * 0.25);
    for (let k = 0; k < 5; k++) P(buildBox(0.08, 0.5, 0.08), [sx * 1.12, 1.52, BZ0 - 0.2 - k * (BL - 0.4) / 4], MAT.paint, VA * 0.9);
  }
  P(buildBox(2.1, 0.5, 0.06), [0, 1.52, BZ1 + 0.03], MAT.paint, VA * 0.95);                 // tailgate
  {
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
    P(buildBox(TW * 2, 0.9, 0.04), [0, SIDE0 + 0.2, BZ0 - 0.07], MAT.canvas, 0.36);
    P(axleX(0.12, TW * 2 - 0.1, 10), [0, TOP - 0.1, BZ1 + 0.05], MAT.canvas, 0.3);
    // Tie-down ropes down the sides.
    for (let k = 0; k < 6; k++) for (const sx of [-1, 1]) P(buildBox(0.02, 0.5, 0.02), [sx * (TW + 0.02), SIDE0 - 0.1, BZ0 - 0.3 - k * (BL - 0.6) / 5], MAT.hessian, 0.4);
  }
  // Seen through the open back: two men on the benches, a crate.
  for (const sx of [-1, 1]) P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [sx * 0.62, 2.1, BZ1 + 0.6], MAT.paint, VA * 1.1);

  // ── Spare wheel behind the cab; mudflaps, tail lights.
  G(axleX(WR * 0.95, 0.26, 18).rotateY(Math.PI / 2), [-0.55, 1.75, 0.05], MAT.rubber, 0.5, undefined, [0, 0, 0, 0]);
  for (const sx of [-1, 1]) {
    P(buildBox(0.5, 0.4, 0.02), [sx * 0.9, 0.7, -2.85], MAT.rubber, 0.4);
    P(buildBox(0.12, 0.1, 0.05), [sx * 1.0, 1.1, BZ1 - 0.03], MAT.steel, 0.15);
  }

  // ── Wheels: singles in front, duals behind.
  const wheelAt = (x, z, w) => {
    const s = [WR, z, WR, 1];
    G(axleX(WR, w, 20), [x, WR, z], MAT.rubber, 0.5, undefined, s);
    G(axleX(0.26, w + 0.02, 14), [x, WR, z], MAT.paint, VA * 0.9, undefined, s);
    G(axleX(0.09, w + 0.05, 8), [x, WR, z], MAT.steel, 0.3, undefined, s);
  };
  for (const sx of [-1, 1]) {
    wheelAt(sx * 0.88, AXF, 0.26);
    for (const z of [AX1, AX2]) { wheelAt(sx * 0.7, z, 0.24); wheelAt(sx * 1.0, z, 0.24); }
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
export function buildAlouette() {
  const st = ALOUETTE_CABIN;
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
    P(buildBox(0.42, 0.55, 0.08), [sx * 0.3, 1.2, 0.62], MAT.canvas, 0.25);
    P(buildBox(0.38, 0.5, 0.26), [sx * 0.3, 1.2, 0.8], MAT.canvas, 0.45);
    P(new THREE.SphereGeometry(0.13, 12, 9), [sx * 0.3, 1.62, 0.84], MAT.white, 0.55);
    P(buildBox(0.1, 0.1, 0.4), [sx * 0.3 + 0.12, 1.3, 1.02], MAT.canvas, 0.45, [0.6, 0, 0]);
  }
  P(buildBox(0.8, 0.34, 0.26), [0, 1.05, 1.75], MAT.steel, 0.12, [0.35, 0, 0]);
  P(new THREE.CylinderGeometry(0.018, 0.018, 0.55, 6), [0.3, 1.0, 1.2], MAT.steel, 0.2, [0.3, 0, 0]);

  // ── The centre body: a solid box behind the cabin, down to the skids'
  //    cross tubes; its side panels, the fuel filler, the step.
  const BZ0 = 0.36, BZ1 = -1.1, BY0 = 0.55, BY1 = 1.98, BW = 0.6;
  P(buildBox(BW * 2, BY1 - BY0, BZ0 - BZ1), [0, (BY0 + BY1) / 2, (BZ0 + BZ1) / 2], MAT.paint, DK);
  for (const sx of [-1, 1]) {
    // Panel seams and a hatch on each side.
    for (const z of [0.0, -0.55]) P(buildBox(0.012, BY1 - BY0 - 0.1, 0.025), [sx * (BW + 0.006), (BY0 + BY1) / 2, z], MAT.steel, 0.1);
    P(buildBox(0.02, 0.5, 0.42), [sx * (BW + 0.01), 1.05, -0.8], MAT.paint, DK * 1.15);
    P(buildBox(0.05, 0.04, 0.3), [sx * (BW + 0.03), 0.62, 0.1], MAT.steel, 0.3);                // step
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
  P(new THREE.TorusGeometry(0.2, 0.05, 6, 16), [0, EY, EZ0 + 0.02], MAT.steel, 0.4);          // intake lip
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
    P(g, [0.018, tEnd.B[1], TZ1 + 0.45], MAT.paint, DK);
  }
  const stabZ = TZ1 + 0.95, stabY = (sec(stabZ).L[1] + sec(stabZ).B[1]) / 2;
  P(buildBox(1.4, 0.035, 0.34), [0, stabY, stabZ], MAT.paint, DK);
  for (const sx of [-1, 1]) P(buildBox(0.035, 0.3, 0.36), [sx * 0.7, stabY + 0.04, stabZ], MAT.paint, DK);
  P(tube([[0, tEnd.B[1] - 0.46, TZ1 + 0.55], [0, 0.55, TZ1 + 0.2], [0, 0.42, TZ1 - 0.25], [0, 0.7, TZ1 - 0.45], [0, tEnd.B[1] - 0.2, TZ1 - 0.1]], 0.028, 16, 5), [0, 0, 0], MAT.steel, 0.3);

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
    const b = blade(BL, 0.3, 0.045, 0.18);
    b.translate(0.28, 0, 0).rotateY(a);
    main.push({ geo: b, mat: MAT.steel, tone: 0.1 });
    const tip = blade(0.28, 0.305, 0.047, 0);
    tip.translate(0.28 + BL - 0.28, -0.17, 0).rotateY(a);
    main.push({ geo: tip, mat: MAT.white, tone: 0.5 });
    main.push({ geo: buildBox(0.4, 0.1, 0.14), pos: [Math.cos(a) * 0.22, 0, -Math.sin(a) * 0.22], rot: [0, a, 0], mat: MAT.steel, tone: 0.28 });
    main.push({ geo: new THREE.CylinderGeometry(0.035, 0.035, 0.3, 6), pos: [Math.cos(a + 0.5) * 0.2, 0.04, -Math.sin(a + 0.5) * 0.2], rot: [0, a, Math.PI / 2], mat: MAT.steel, tone: 0.35 });
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
    mk.push(stencilPatch("frCocarde", flatSurface([sx * (BW + 0.004), 1.45, -0.72], [sx, 0, 0], [0, 0, -sx], 0.46, "frCocarde"), { lift: 0.004 }));
    mk.push(stencilPatch("frSerialWhite", flatSurface([sx * (BW + 0.004), 1.62, -0.1], [sx, 0, 0], [0, 0, -sx], 0.62, "frSerialWhite"), { lift: 0.004 }));
    const { p, n } = skinAt(st, 1.2, sx > 0 ? -0.62 : Math.PI + 0.62);
    mk.push(stencilPatch("frArmeeWhite", flatSurface(p.toArray(), n.toArray(), [0, 0, -sx], 0.9, "frArmeeWhite"), { lift: 0.01 }));
  }
  const stencil = mergeStencils(mk);

  for (const g of [geo, glass, mainGeo, tailGeo, stencil]) g?.scale(S, S, S);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.glass = glass;
  geo.userData.rotors = {
    main: { geo: mainGeo, pivot: [0, hubY * S, hubZ * S] },
    tail: { geo: tailGeo, pivot: tailPivot.map((c) => c * S) },
  };
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
export function buildAMX13({ seed = 13 } = {}) {
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
    rollers: [{ z: 0.95, y: 0.86, r: 0.1 }, { z: -0.6, y: 0.83, r: 0.1 }], paintTone: VA * 0.9,
  });
  trackSide(G, {
    xc: HW + 0.2, tw: 0.35, t, wheelR, wheelsZ: [1.55, 0.78, 0, -0.78, -1.55],
    sprocket: { c: [2.1, 0.72], r: 0.3 }, idler: { c: [-2.15, 0.38], r: 0.3 },
    rollers: [{ z: 0.95, y: 0.86, r: 0.1 }, { z: -0.6, y: 0.83, r: 0.1 }], paintTone: VA * 0.9,
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
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.4 * S, hz: 2.6 * S };
  return geo;
}

// ── M3 HALF-TRACK ────────────────────────────────────────────────────────────

/** Real: 6.2 m long with the roller, 2.2 m wide. userData: stencil, gear, length. */
export function buildHalfTrack({ seed = 3 } = {}) {
  const R = rng(seed);
  const hull = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const WR = 0.46, AXF = 1.95;

  // ── Chassis and the front axle.
  for (const sx of [-1, 1]) P(buildBox(0.1, 0.2, 5.2), [sx * 0.46, 0.72, -0.2], MAT.paint, VA * 0.8);
  P(axleX(0.08, 1.7, 8), [0, WR, AXF], MAT.steel, 0.2);

  // ── The armoured bonnet with its radiator louvres, flat wings over the wheels.
  P(buildBox(0.95, 0.62, 1.5), [0, 1.24, 1.95], MAT.paint, VA);
  P(buildBox(1.0, 0.05, 1.5), [0, 1.57, 1.95], MAT.paint, VA * 1.05);
  P(buildBox(0.9, 0.55, 0.06), [0, 1.24, 2.73], MAT.paint, VA * 0.95);
  for (let k = 0; k < 6; k++) P(buildBox(0.72, 0.04, 0.03), [0, 1.04 + k * 0.08, 2.77], MAT.steel, 0.05);
  for (const sx of [-1, 1]) {
    P(buildBox(0.44, 0.05, 1.3), [sx * 0.8, 1.2, 2.0], MAT.paint, VA);
    P(buildBox(0.42, 0.05, 0.36), [sx * 0.8, 1.08, 2.72], MAT.paint, VA, [0.6, 0, 0]);
    P(new THREE.CylinderGeometry(0.1, 0.11, 0.14, 12).rotateX(Math.PI / 2), [sx * 0.62, 1.34, 2.78], MAT.steel, 0.15);
    P(new THREE.CylinderGeometry(0.08, 0.08, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.62, 1.34, 2.86], MAT.white, 0.45);
  }
  // The roller on its frame in front: the half-track's nose.
  P(axleX(0.26, 1.25, 16), [0, 0.72, 3.2], MAT.steel, 0.2);
  for (const sx of [-1, 1]) P(buildBox(0.06, 0.12, 0.6), [sx * 0.66, 0.72, 2.95], MAT.paint, VA * 0.9);

  // ── The armoured box: sides, the cab's armoured windscreen (plates up,
  //    vision slits), the rear door, all open on top.
  const BZ0 = 1.2, BZ1 = -2.85, BL = BZ0 - BZ1, BZ = (BZ0 + BZ1) / 2, BW = 1.0, TOPY = 2.05;
  P(buildBox(BW * 2, 0.08, BL), [0, 1.05, BZ], MAT.paint, VA * 0.85);                             // floor
  for (const sx of [-1, 1]) P(buildBox(0.06, TOPY - 1.05, BL), [sx * BW, (TOPY + 1.05) / 2, BZ], MAT.paint, VA);
  P(buildBox(BW * 2, TOPY - 1.05, 0.06), [0, (TOPY + 1.05) / 2, BZ1], MAT.paint, VA);
  P(buildBox(0.6, 0.72, 0.03), [0, 1.5, BZ1 - 0.035], MAT.paint, VA * 1.08);                     // rear door
  P(buildBox(BW * 2, 0.5, 0.06), [0, 1.5, BZ0], MAT.paint, VA);                                  // dash
  P(buildBox(BW * 2, 0.55, 0.06), [0, 2.02, BZ0 - 0.05], MAT.paint, VA * 1.02, [-0.25, 0, 0]);   // windscreen armour, raised
  for (const sx of [-1, 1]) P(buildBox(0.5, 0.05, 0.02), [sx * 0.45, 2.02, BZ0 - 0.01], MAT.steel, 0.02, [-0.25, 0, 0]);
  // Cab doors cut lower.
  for (const sx of [-1, 1]) P(buildBox(0.06, 0.4, 0.9), [sx * (BW + 0.01), 1.3, 0.65], MAT.paint, VA * 1.04);
  // The .50 on its pulpit ring over the cab, the men in the back, stowage.
  P(new THREE.TorusGeometry(0.42, 0.04, 6, 20).rotateX(Math.PI / 2), [0.45, 2.45, 0.6], MAT.steel, 0.2);
  for (const sx of [-1, 1]) P(buildBox(0.05, 0.9, 0.05), [0.45 + sx * 0.4, 2.0, 0.6], MAT.steel, 0.2);
  P(buildBox(0.14, 0.14, 1.1), [0.45, 2.55, 1.0], MAT.steel, 0.12);
  P(alongZ(0.025, 0.025, 0.4, 6), [0.45, 2.55, 1.7], MAT.steel, 0.1);
  soldierSeated(P, -0.45, 1.2, 0.6, R);                                                           // driver
  for (let k = 0; k < 4; k++) {
    const sx = k % 2 ? 1 : -1, z = -0.5 - Math.floor(k / 2) * 1.0;
    P(buildBox(0.36, 0.5, 0.24), [sx * 0.6, 1.55, z], MAT.canvas, 0.5 + R() * 0.1, [0, sx * Math.PI / 2, 0]);
    P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [sx * 0.6, 1.95, z], MAT.paint, VA * 1.1);
  }
  for (const sx of [-1, 1]) P(buildBox(0.1, 0.25, 1.8), [sx * (BW + 0.08), 1.75, -1.6], MAT.canvas, 0.35);     // bedrolls on the rails
  P(buildBox(0.3, 0.44, 0.14), [0.6, 1.4, BZ1 - 0.1], MAT.paint, 0.42);                          // jerrycan
  // Mine racks on the sides, the M3's tell.
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) P(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 12).rotateZ(Math.PI / 2), [sx * (BW + 0.08), 1.25, -0.2 - k * 0.35], MAT.paint, VA * 0.8);

  // ── Front wheels (they roll), the rear track unit.
  const wheelAt = (x, z) => {
    const s = [WR, z, WR, 1];
    G(axleX(WR, 0.26, 20), [x, WR, z], MAT.rubber, 0.5, undefined, s);
    G(axleX(0.27, 0.28, 14), [x, WR, z], MAT.paint, VA * 0.9, undefined, s);
    G(axleX(0.09, 0.3, 8), [x, WR, z], MAT.steel, 0.3, undefined, s);
  };
  for (const sx of [-1, 1]) wheelAt(sx * 0.84, AXF);
  for (const sx of [-1, 1]) {
    trackSide(G, {
      xc: sx * 0.82, tw: 0.3, t: 0.04, wheelR: 0.23, wheelsZ: [-0.55, -1.0, -1.45, -1.9],
      sprocket: { c: [0.05, 0.56], r: 0.26 }, idler: { c: [-2.5, 0.52], r: 0.24 }, paintTone: VA * 0.9,
    });
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
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  geo.userData.footprint = { cx: 0, cz: 0, hx: 1.2 * S, hz: 3.2 * S };
  return geo;
}
