/**
 * VEHICLES — the US side's vehicles, built on the parts kit.
 *
 * Same rules as the buildings: parts with weight (plates with edges, wheels
 * with hubs, a track made of shoes), one atlas material so a vehicle is ONE
 * draw and a hundred of them, instanced, are still one; markings on the shared
 * stencil sheet. Built in REAL metres and scaled by 1.3 at the end, like the
 * units. Front is +Z (the game's unit forward), origin at the ground centre.
 *
 *   · M113 ACAV — the armoured cavalry M113 of the war: the aluminium box with
 *     its sloped glacis and folded trim vane, five road wheels a side, and the
 *     ACAV kit — a shielded .50 cal at the commander's cupola and two shielded
 *     M60s over the cargo hatch — with what crews piled on it
 */
import * as THREE from "three";
import { MAT, assemble, bakeContactAO, buildBox, buildSandbagWall, rng } from "./rtsParts.js";
import { flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";
import { rtsAtlasColor } from "./rtsObjectProps.js";
import {
  attribute, cos, float, fract, instancedBufferAttribute, max, mix, positionLocal, sin, step, uv, vec2, vec3,
} from "three/tsl";

const S = 1.3;

/** Instance capacity of a vehicle type (the unit renderer's MAX_PER_TYPE). */
export const MAX_VEHICLES = 256;
const SHOE = 0.16;   // track shoe pitch, real metres

let _gearMat = null;
/**
 * The running gear's material: the kit's atlas colour, and the gear ROLLS in
 * the vertex shader from a per-instance odometer (world metres travelled,
 * signed; the unit renderer writes it). A vertex's aSpin says how it moves:
 * a wheel (kind 1) turns about its own centre by odometer / radius; the track
 * (kind 2) scrolls its shoes along the loop. One draw for every vehicle's
 * wheels and tracks, and no CPU per wheel.
 * material.userData.odometer is the InstancedBufferAttribute to write.
 */
export function rtsRunningGearMaterial() {
  if (_gearMat) return _gearMat;
  const odoAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VEHICLES), 1);
  odoAttr.setUsage(THREE.DynamicDrawUsage);
  const odo = instancedBufferAttribute(odoAttr);
  const spin = attribute("aSpin", "vec4");
  const isWheel = step(0.5, spin.w).mul(step(spin.w, 1.5));
  const isTrack = step(1.5, spin.w);
  // A wheel rolling forward turns its top forward: +angle about +X.
  const ang = odo.div(max(spin.z, float(0.01))).mul(isWheel);
  const c = cos(ang), s = sin(ang);
  const dy = positionLocal.y.sub(spin.x), dz = positionLocal.z.sub(spin.y);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  m.name = "RtsRunningGear";
  m.positionNode = vec3(positionLocal.x, spin.x.add(dy.mul(c)).sub(dz.mul(s)), spin.y.add(dy.mul(s)).add(dz.mul(c)));
  // The band's u runs along the loop in REAL metres (the geometry is scaled
  // after its UVs were laid), forward along the top run: the shoes move with it.
  const u = uv().x.sub(odo.div(S).mul(isTrack));
  const shoeGap = step(0.8, fract(u.div(SHOE))).mul(isTrack);
  m.colorNode = rtsAtlasColor(vec2(u, uv().y)).mul(mix(float(1), float(0.45), shoeGap));
  m.userData.odometer = odoAttr;
  _gearMat = m;
  return m;
}

/** mergeGeometries needs every part indexed; extrusions and ribbons are not. */
function indexed(g) {
  if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
  return g;
}

/** A cylinder lying along X (wheels, rollers, the tarp). */
const axleX = (r, w, seg = 16) => new THREE.CylinderGeometry(r, r, w, seg).rotateZ(Math.PI / 2);
/** A cylinder lying along Z (barrels). */
const alongZ = (r0, r1, len, seg = 8) => new THREE.CylinderGeometry(r0, r1, len, seg).rotateX(Math.PI / 2);

/**
 * A closed track loop swept from a (z, y) path: a band `w` wide and `t`
 * thick, centred on x = xc. Indexed, u along the loop in metres.
 */
function trackBand(path, xc, w, t) {
  const n = path.length;
  const pos = [], nrm = [], uvs = [], idx = [];
  // Outward normal at each point: the average of its two segments' normals
  // (the loop runs clockwise seen from +X, so outward is (dy, -dz) rotated).
  const out = path.map((p, i) => {
    const a = path[(i - 1 + n) % n], b = path[(i + 1) % n];
    const dz = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dz, dy) || 1;
    return [-dy / l, dz / l];   // (nz, ny)
  });
  let u = 0;
  const ring = [];   // 4 vertices per point: outer-left, outer-right, inner-right, inner-left
  for (let i = 0; i <= n; i++) {
    const k = i % n, p = path[k], o = out[k];
    if (i > 0) { const q = path[(i - 1) % n]; u += Math.hypot(p[0] - q[0], p[1] - q[1]); }
    const oz = p[0] + o[0] * t / 2, oy = p[1] + o[1] * t / 2, iz = p[0] - o[0] * t / 2, iy = p[1] - o[1] * t / 2;
    const base = pos.length / 3;
    pos.push(xc - w / 2, oy, oz, xc + w / 2, oy, oz, xc + w / 2, iy, iz, xc - w / 2, iy, iz);
    nrm.push(0, o[1], o[0], 0, o[1], o[0], 0, -o[1], -o[0], 0, -o[1], -o[0]);
    uvs.push(u, 0, u, w, u, w, u, 0);
    ring.push(base);
  }
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[i + 1];
    // outer face (0-1), inner face (2-3), and the two sides (1-2, 3-0)
    for (const [p0, p1] of [[0, 1], [2, 3], [1, 2], [3, 0]]) {
      idx.push(a + p0, b + p0, a + p1, a + p1, b + p0, b + p1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Points of the track loop round the front wheel, the road wheels and the
 * rear wheel, in (z, y). Which end drives (sprocket) does not matter to the
 * loop. `rollers`: return rollers [{ z, y, r }] the top run rests on; without
 * them it runs straight, sagging onto the road wheels.
 */
function trackPath({ front, rear, wheelsZ, wheelR, t, rollers = null }) {
  const sprocket = front, idler = rear;
  const pts = [];
  const arc = (c, r, a0, a1, steps) => {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      pts.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
    }
  };
  const d2r = Math.PI / 180;
  // Clockwise seen from +X: over the sprocket's top and down its front…
  arc(sprocket.c, sprocket.r + t / 2, 90 * d2r, -35 * d2r, 7);
  // …down to the ground under the first wheel, along the ground…
  const ground = t / 2;
  for (const z of wheelsZ) pts.push([z, ground]);
  // …up round the idler at the back…
  arc(idler.c, idler.r + t / 2, -100 * d2r, -270 * d2r, 9);
  // …and forward along the top, resting on the wheels, back to the sprocket.
  const top = (z) => {
    const a = idler.c[1] + idler.r + t / 2, b = sprocket.c[1] + sprocket.r + t / 2;
    const f = (z - idler.c[0]) / (sprocket.c[0] - idler.c[0]);
    return Math.max(a + (b - a) * f - 0.035 * Math.sin(f * Math.PI), wheelR * 2 + t / 2 + 0.05);
  };
  if (rollers) for (let i = rollers.length - 1; i >= 0; i--) pts.push([rollers[i].z, rollers[i].y + rollers[i].r + t / 2]);
  else for (let i = wheelsZ.length - 1; i >= 0; i--) pts.push([wheelsZ[i], top(wheelsZ[i])]);
  return pts;
}

/**
 * Give a SCALED running-gear geometry its aSpin (centre y, centre z, radius,
 * kind — 0 still, 1 wheel, 2 track; parts merge in order, so the ranges line
 * up) and pack matId/tone/ao/aSpin into ONE interleaved buffer.
 *
 * WebGPU allows 8 vertex BUFFERS per draw. The gear needs position, normal,
 * uv, the kit's matId/tone/ao, aSpin, and instancing's matrix, colour and
 * odometer — 10 as separate buffers (the pipeline failed and the M113 drew
 * nothing). Interleaved: 7.
 */
function packGear(gearGeo, spins) {
  const nv = gearGeo.attributes.position.count;
  const packed = new Float32Array(nv * 7);
  const mid = gearGeo.attributes.matId, ton = gearGeo.attributes.tone, ao = gearGeo.attributes.ao;
  let v = 0;
  for (const { spin: sp, n } of spins) {
    for (let k = 0; k < n; k++, v++) {
      packed.set([mid.getX(v), ton.getX(v), ao.getX(v), sp[0] * S, sp[1] * S, sp[2] * S, sp[3]], v * 7);
    }
  }
  const ib = new THREE.InterleavedBuffer(packed, 7);
  gearGeo.setAttribute("matId", new THREE.InterleavedBufferAttribute(ib, 1, 0));
  gearGeo.setAttribute("tone", new THREE.InterleavedBufferAttribute(ib, 1, 1));
  gearGeo.setAttribute("ao", new THREE.InterleavedBufferAttribute(ib, 1, 2));
  gearGeo.setAttribute("aSpin", new THREE.InterleavedBufferAttribute(ib, 4, 3));
}

// ── M113 ACAV ────────────────────────────────────────────────────────────────
export function buildM113({ seed = 113 } = {}) {
  const R = rng(seed);
  const parts = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => parts.push({ geo, pos, mat, tone, rot });
  // The cupola TURNS (the whole ACAV cupola did, shield and gun together):
  // its parts are built round the pivot and returned as their own geometry.
  const turret = [];
  let pivot = [0, 0, 0];
  const T = (geo, pos, mat, tone = 0.5, rot) => turret.push({ geo, pos: [pos[0] - pivot[0], pos[1] - pivot[1], pos[2] - pivot[2]], mat, tone, rot });
  // The running gear ROLLS: each part remembers how it moves (spin: a wheel
  // round its centre, or the track band along its loop) for the vertex shader.
  const gear = [], spins = [];
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  // Olive drab is DARK: at 0.5 the atlas paint read lime under the midday sun.
  const OD = 0.16;
  const HW = 1.0, BELLY = 0.43, ROOF = 1.83, ZR = -2.43, ZF = 2.43;
  const GZ = 1.3, NOSE = 0.95;            // glacis: from the roof at z = GZ down to the nose

  // ── Hull: the side silhouette extruded across the width, bevelled edges.
  const shape = new THREE.Shape();
  shape.moveTo(ZR, BELLY);
  shape.lineTo(ZF - 0.38, BELLY);
  shape.lineTo(ZF, NOSE);
  shape.lineTo(GZ, ROOF);
  shape.lineTo(ZR, ROOF);
  shape.closePath();
  const bev = 0.03;
  const hull = new THREE.ExtrudeGeometry(shape, { depth: 2 * HW - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 1 });
  hull.rotateY(-Math.PI / 2);
  hull.computeBoundingBox();
  hull.translate(-(hull.boundingBox.min.x + hull.boundingBox.max.x) / 2, 0, 0);   // centred on x = 0, whatever the bevel adds
  P(indexed(hull), [0, 0, 0], MAT.paint, OD);
  const roofY = ROOF + bev;

  // Glacis frame: its direction down the slope, and its outward normal.
  const gd = new THREE.Vector2(ZF - GZ, NOSE - ROOF).normalize();       // (dz, dy)
  const gn = new THREE.Vector3(0, gd.x, -gd.y).normalize();               // outward: up and forward
  const glacisAt = (f, lift) => new THREE.Vector3(0, ROOF + (NOSE - ROOF) * f, GZ + (ZF - GZ) * f).addScaledVector(gn, lift + bev);
  // Tilts a box's thin Y axis onto the glacis normal (rotateX takes +Y to (0, cos, sin)).
  const slopeRot = [Math.atan2(ROOF - NOSE, ZF - GZ), 0, 0];

  // Trim vane: the folded board on the glacis, ribbed.
  const vane = glacisAt(0.52, 0.05);
  P(buildBox(1.9, 0.05, 0.78), [vane.x, vane.y, vane.z], MAT.paint, OD * 0.9, slopeRot);
  for (const f of [0.3, 0.52, 0.74]) {
    const c = glacisAt(f, 0.09);
    P(buildBox(1.86, 0.035, 0.05), [c.x, c.y, c.z], MAT.paint, OD * 0.8, slopeRot);
  }
  // Headlight guards at the nose corners, and the tow hooks.
  for (const sx of [-1, 1]) {
    const c = glacisAt(0.93, 0.07);
    P(buildBox(0.2, 0.14, 0.12), [sx * 0.78, c.y, c.z], MAT.steel, 0.15, slopeRot);
    const g = glacisAt(0.93, 0.16);
    P(buildBox(0.26, 0.025, 0.025), [sx * 0.78, g.y + 0.06, g.z], MAT.paint, OD);
    P(buildBox(0.1, 0.12, 0.14), [sx * 0.55, NOSE - 0.18, ZF + 0.02], MAT.steel, 0.3);
  }
  // Exhaust: the muffler on the glacis's right side, under a guard.
  const ex = glacisAt(0.22, 0.12);
  P(axleX(0.07, 0.5, 10), [0.72, ex.y, ex.z], MAT.metal, 0.08);
  P(buildBox(0.56, 0.03, 0.22), [0.72, ex.y + 0.1, ex.z], MAT.paint, OD * 0.85, slopeRot);

  // ── Roof: driver's hatch with periscopes (front left), engine grille
  //    (front right), the cupola, the big cargo hatch at the back.
  P(buildBox(0.62, 0.08, 0.62), [-0.5, roofY + 0.04, 0.95], MAT.paint, OD * 1.05);
  for (let k = 0; k < 4; k++) P(buildBox(0.1, 0.08, 0.06), [-0.72 + k * 0.145, roofY + 0.11, 1.28], MAT.steel, 0.02);
  for (let k = 0; k < 6; k++) P(buildBox(0.62, 0.03, 0.05), [0.52, roofY + 0.015, 0.85 + k * 0.08], MAT.steel, 0.1);
  const cup = [0.25, 0.22];   // cupola (x, z)
  P(new THREE.CylinderGeometry(0.44, 0.47, 0.26, 16), [cup[0], roofY + 0.13, cup[1]], MAT.paint, OD * 1.02);
  pivot = [cup[0], roofY + 0.26, cup[1]];
  T(new THREE.CylinderGeometry(0.38, 0.38, 0.05, 14), [cup[0] - 0.05, roofY + 0.42, cup[1] - 0.42], MAT.paint, OD, [1.25, 0, 0]);   // hatch lid, open back
  P(buildBox(1.5, 0.05, 1.55), [0, roofY + 0.025, -1.35], MAT.paint, OD * 0.95);    // cargo hatch
  P(buildBox(1.5, 0.06, 0.06), [0, roofY + 0.03, -0.55], MAT.steel, 0.3);           // its hinge

  // ── ACAV kit. The .50 cal behind its shield at the cupola…
  const gunY = roofY + 0.62;
  T(buildBox(0.95, 0.5, 0.03), [cup[0], roofY + 0.52, cup[1] + 0.48], MAT.paint, OD * 0.92, [-0.12, 0, 0]);
  for (const sx of [-1, 1]) {
    T(buildBox(0.42, 0.5, 0.03), [cup[0] + sx * 0.62, roofY + 0.52, cup[1] + 0.32], MAT.paint, OD * 0.92, [-0.1, sx * 0.72, 0]);
  }
  T(buildBox(0.16, 0.14, 0.52), [cup[0], gunY, cup[1] + 0.12], MAT.steel, 0.06);                       // receiver
  T(alongZ(0.045, 0.045, 0.36, 8), [cup[0], gunY + 0.01, cup[1] + 0.55], MAT.steel, 0.08);             // barrel jacket
  T(alongZ(0.025, 0.025, 0.85, 8), [cup[0], gunY + 0.01, cup[1] + 0.95], MAT.steel, 0.06);             // barrel
  T(buildBox(0.1, 0.16, 0.26), [cup[0] - 0.16, gunY - 0.04, cup[1] + 0.1], MAT.paint, 0.4);            // ammo can
  T(new THREE.CylinderGeometry(0.03, 0.04, 0.34, 6), [cup[0], roofY + 0.37, cup[1] + 0.1], MAT.steel, 0.2);  // pintle
  // …and an M60 each side over the cargo hatch, behind its own plate.
  for (const sx of [-1, 1]) {
    const x = sx * 0.78, z = -1.05, y = roofY + 0.5;
    P(buildBox(0.03, 0.48, 0.62), [x + sx * 0.12, roofY + 0.4, z], MAT.paint, OD * 0.92, [0, 0, sx * 0.08]);
    P(buildBox(0.4, 0.09, 0.08), [x + sx * 0.22, y, z], MAT.steel, 0.06);          // receiver, pointing out
    P(axleX(0.02, 0.5, 6), [x + sx * 0.66, y + 0.01, z], MAT.steel, 0.06);          // barrel
    P(new THREE.CylinderGeometry(0.025, 0.03, 0.42, 6), [x, roofY + 0.21, z], MAT.steel, 0.2);
  }

  // ── What the crew carried: rucksacks and ammo cans on the hatch, a tarp
  //    rolled across the back, a row of sandbags along the roof's front edge,
  //    jerry cans on the rear.
  for (let k = 0; k < 3; k++) {
    P(buildBox(0.34, 0.26, 0.28), [-0.45 + k * 0.42 + R() * 0.05, roofY + 0.18, -1.95 + R() * 0.04], MAT.canvas, 0.35 + R() * 0.3, [0, R() * 0.4 - 0.2, 0]);
  }
  for (let k = 0; k < 4; k++) P(buildBox(0.1, 0.18, 0.28), [0.25 + k * 0.12, roofY + 0.14, -0.72], MAT.paint, 0.35 + R() * 0.1);
  P(axleX(0.13, 1.75, 10), [0, roofY + 0.13, ZR + 0.16], MAT.canvas, 0.45);
  const bag = { length: 0.52, width: 0.30, height: 0.17, segU: 5, segV: 3 };
  // Behind the driver's hatch, clear of it and of the cupola.
  parts.push({ geo: buildSandbagWall({ length: 0.8, courses: 1, seed, bag }), pos: [-0.6, roofY, 0.35], mat: null });
  for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) {
    P(buildBox(0.17, 0.47, 0.34), [sx * (0.62 + k * 0.19), 1.05, ZR - 0.21], MAT.paint, 0.42);
  }
  // Rear: the ramp's outline and its door, tail lights.
  P(buildBox(1.78, 1.2, 0.04), [0, 1.08, ZR - bev - 0.02], MAT.paint, OD * 0.96);
  P(buildBox(0.62, 0.98, 0.03), [0.42, 1.08, ZR - bev - 0.05], MAT.paint, OD * 1.05);
  for (const sx of [-1, 1]) P(buildBox(0.12, 0.1, 0.05), [sx * 0.85, 1.6, ZR - bev - 0.03], MAT.steel, 0.15);
  // Whip antennas at the back corners, leaning a little aft.
  for (const sx of [-1, 1]) {
    P(new THREE.CylinderGeometry(0.05, 0.06, 0.14, 8), [sx * 0.93, roofY + 0.07, -2.15], MAT.steel, 0.25);
    P(new THREE.CylinderGeometry(0.008, 0.016, 3.0, 4).translate(0, 1.5, 0), [sx * 0.93, roofY + 0.14, -2.15], MAT.steel, 0.3, [-0.1, 0, sx * 0.06]);
  }

  // ── Running gear, both sides: five road wheels, sprocket at the front,
  //    idler at the back, and the track round them. It ROLLS in the vertex
  //    shader (rtsRunningGearMaterial): wheels turn round their own centres and
  //    the track's shoes run along the loop, from each vehicle's odometer.
  const wheelR = 0.3, t = 0.05;
  const wheelsZ = [1.45, 0.72, 0, -0.72, -1.45];
  const sprocket = { c: [1.95, 0.64], r: 0.28 }, idler = { c: [-2.02, 0.5], r: 0.26 };
  const path = trackPath({ front: sprocket, rear: idler, wheelsZ, wheelR, t });
  const wheel = (cy, cz, r) => [cy, cz, r, 1];
  const TRACK = [0, 0, 0, 2];
  for (const sx of [-1, 1]) {
    const xc = sx * (HW + 0.2), tw = 0.37;
    G(indexed(trackBand(path, xc, tw, t)), [0, 0, 0], MAT.steel, 0.03, undefined, TRACK);
    for (const z of wheelsZ) {
      const w = wheel(wheelR + t, z, wheelR);
      G(axleX(wheelR, 0.3, 16), [xc, wheelR + t, z], MAT.rubber, 0.5, undefined, w);                  // rubber
      G(axleX(0.19, 0.31, 12), [xc, wheelR + t, z], MAT.paint, OD * 0.9, undefined, w);               // wheel disc
      G(axleX(0.07, 0.34, 8), [xc, wheelR + t, z], MAT.steel, 0.3, undefined, w);                     // hub
      // Six bolts on the disc, so the turning shows.
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        G(buildBox(0.33, 0.035, 0.035), [xc, wheelR + t + Math.sin(a) * 0.12, z + Math.cos(a) * 0.12], MAT.steel, 0.35, undefined, w);
      }
    }
    const sw = wheel(sprocket.c[1], sprocket.c[0], sprocket.r);
    G(axleX(sprocket.r - 0.03, 0.26, 16), [xc, sprocket.c[1], sprocket.c[0]], MAT.paint, OD * 0.85, undefined, sw);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      G(buildBox(0.22, 0.07, 0.07), [xc, sprocket.c[1] + Math.sin(a) * (sprocket.r - 0.01), sprocket.c[0] + Math.cos(a) * (sprocket.r - 0.01)], MAT.steel, 0.25, [a, 0, 0], sw);
    }
    const iw = wheel(idler.c[1], idler.c[0], idler.r);
    G(axleX(idler.r, 0.3, 16), [xc, idler.c[1], idler.c[0]], MAT.rubber, 0.45, undefined, iw);
    G(axleX(0.16, 0.31, 12), [xc, idler.c[1], idler.c[0]], MAT.paint, OD * 0.9, undefined, iw);
    // Mud flap over the front of the track: part of the hull, it does not move.
    P(buildBox(tw + 0.02, 0.03, 0.55), [xc, sprocket.c[1] + sprocket.r + 0.1, sprocket.c[0] + 0.02], MAT.paint, OD * 0.9, [-0.25, 0, 0]);
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const turretGeo = assemble(turret);
  bakeContactAO(turretGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0, floor: 0.6 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.1, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // ── Markings: the star in its ring on both sides and on the cargo hatch,
  //    the bumper code across the trim vane.
  const st = [];
  for (const sx of [-1, 1]) {
    st.push(stencilPatch("star", flatSurface([sx * (HW + 0.004), 1.38, -0.75], [sx, 0, 0], [0, 0, -sx], 0.72, "star"), { lift: 0.004 }));
  }
  st.push(stencilPatch("star", flatSurface([0, roofY + 0.05, -1.3], [0, 1, 0], [-1, 0, 0], 0.9, "star"), { lift: 0.004 }));
  const vc = glacisAt(0.52, 0.05 + 0.025);
  st.push(stencilPatch("bumperCode", flatSurface([vc.x, vc.y, vc.z], [gn.x, gn.y, gn.z], [1, 0, 0], 1.5, "bumperCode"), { lift: 0.004 }));
  const stencil = mergeStencils(st);

  geo.scale(S, S, S);
  stencil?.scale(S, S, S);
  turretGeo.scale(S, S, S);
  gearGeo.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  // The .50 cal's muzzle, in the turret's frame (pivot at its origin).
  const muzzle = [cup[0] - pivot[0], gunY + 0.01 - pivot[1], cup[1] + 1.38 - pivot[2]].map((c) => c * S);
  geo.userData.turret = { geo: turretGeo, pivot: pivot.map((c) => c * S), muzzle };
  geo.userData.gear = gearGeo;
  geo.userData.length = (geo.boundingBox.max.z - geo.boundingBox.min.z);
  return geo;
}

// ── M48A3 Patton ─────────────────────────────────────────────────────────────
/**
 * The US Army's and the Marines' tank in Vietnam. What makes it an M48 from
 * the air and from the side: the rounded CAST hull and the egg-shaped turret,
 * the 90 mm gun with its bore evacuator and T-shaped muzzle brake, the big
 * xenon searchlight over the gun, the tall commander's cupola with its .50,
 * wide tracks under full-length fenders with stowage boxes, six road wheels,
 * return rollers, a raised idler at the front and the drive sprocket at the
 * back. Hull 6.4 m, 3.63 m wide, 9.3 m with the gun forward (real).
 *
 * userData: stencil, turret { geo, stencil, pivot, muzzle }, gear, length.
 */
export function buildM48({ seed = 48 } = {}) {
  const R = rng(seed);
  const OD = 0.16;
  const hull = [], turret = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const pivot = [0, 1.62, 0.25];
  const T = (geo, pos, mat, tone = 0.5, rot) => turret.push({ geo, pos, mat, tone, rot });    // turret-local
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const HW = 1.1, DECK = 1.6, FENDER = 1.22;

  // ── Hull: the cast side profile, rounded nose and glacis, heavily bevelled.
  const shape = new THREE.Shape();
  shape.moveTo(-3.05, 0.5);
  shape.lineTo(2.3, 0.5);
  shape.quadraticCurveTo(3.25, 0.55, 3.18, 1.05);
  shape.quadraticCurveTo(3.02, 1.52, 2.0, DECK);
  shape.lineTo(-3.18, DECK);
  shape.lineTo(-3.2, 0.95);
  shape.closePath();
  const bev = 0.1;
  const body = new THREE.ExtrudeGeometry(shape, { depth: 2 * HW - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 10 });
  body.rotateY(-Math.PI / 2);
  body.computeBoundingBox();
  body.translate(-(body.boundingBox.min.x + body.boundingBox.max.x) / 2, 0, 0);
  P(indexed(body), [0, 0, 0], MAT.paint, OD);
  const deckY = DECK + bev;

  // Fenders over the tracks, full length, turned down at the front and back,
  // with stowage boxes and the headlight clusters.
  for (const sx of [-1, 1]) {
    const x = sx * (HW + 0.39);
    P(buildBox(0.8, 0.04, 5.6), [x, FENDER, -0.15], MAT.paint, OD * 0.95);
    P(buildBox(0.8, 0.04, 0.55), [x, FENDER - 0.16, 2.88], MAT.paint, OD * 0.95, [0.55, 0, 0]);
    P(buildBox(0.8, 0.04, 0.4), [x, FENDER - 0.1, -3.1], MAT.paint, OD * 0.95, [-0.5, 0, 0]);
    for (const z of [1.0, -0.15, -1.3]) {
      P(buildBox(0.6, 0.34, 0.95), [sx * (HW + 0.42), FENDER + 0.19, z], MAT.paint, OD * (0.9 + R() * 0.15));
      P(buildBox(0.62, 0.03, 0.97), [sx * (HW + 0.42), FENDER + 0.37, z], MAT.paint, OD * 0.8);   // lid
    }
    // Headlight cluster on the front fender, in its guard.
    P(buildBox(0.3, 0.22, 0.2), [sx * (HW + 0.45), FENDER + 0.13, 2.55], MAT.steel, 0.15);
    P(buildBox(0.4, 0.03, 0.03), [sx * (HW + 0.45), FENDER + 0.3, 2.68], MAT.paint, OD);
    // Jerry cans on the rear fender.
    for (let k = 0; k < 2; k++) P(buildBox(0.17, 0.47, 0.34), [sx * (HW + 0.25 + k * 0.2), FENDER + 0.25, -2.55], MAT.paint, 0.42);
  }
  // Engine deck: two banks of louvred grilles, the exhausts at the back.
  // Six bars: a seventh ran into the exhaust box, their undersides coplanar.
  for (const sx of [-1, 1]) for (let k = 0; k < 6; k++) {
    P(buildBox(0.8, 0.04, 0.06), [sx * 0.5, deckY + 0.02, -1.55 - k * 0.2], MAT.steel, 0.1);
  }
  for (const sx of [-1, 1]) {
    P(buildBox(0.55, 0.3, 0.35), [sx * 0.62, deckY + 0.15, -2.95], MAT.steel, 0.12);          // exhaust box
    P(buildBox(0.5, 0.03, 0.3), [sx * 0.62, deckY + 0.31, -2.95], MAT.steel, 0.3);
  }
  // Driver's hatch and periscopes in the glacis, tow cable along the deck.
  P(new THREE.CylinderGeometry(0.3, 0.32, 0.06, 12), [-0.45, deckY + 0.02, 1.9], MAT.paint, OD * 1.05);
  for (let k = 0; k < 3; k++) P(buildBox(0.12, 0.07, 0.06), [-0.65 + k * 0.2, deckY + 0.06, 2.12], MAT.steel, 0.02);
  P(axleX(0.04, 3.0, 6).rotateY(Math.PI / 2), [HW - 0.2, deckY + 0.04, -0.8], MAT.steel, 0.2);
  // Tow hooks and the rear plate's tail lights.
  for (const sx of [-1, 1]) {
    P(buildBox(0.14, 0.16, 0.2), [sx * 0.75, 0.75, 3.12], MAT.steel, 0.3);
    P(buildBox(0.14, 0.1, 0.05), [sx * 0.85, 1.35, -3.23], MAT.steel, 0.15);
  }

  // ── Turret (turret-local, pivot at the ring's centre on the deck).
  const dome = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1.36, 0.72, 1.62);
  T(dome, [0, 0.02, 0.05], MAT.paint, OD * 1.05);
  T(new THREE.CylinderGeometry(1.34, 1.37, 0.14, 28).scale(1, 1, 1.19), [0, 0.06, 0.05], MAT.paint, OD * 0.9);   // ring skirt
  T(buildBox(2.1, 0.55, 0.9), [0, 0.3, -1.45], MAT.paint, OD);                                                 // bustle
  // Stowage basket behind the bustle: a rail frame round canvas and packs.
  for (const y of [0.18, 0.5]) T(buildBox(2.1, 0.04, 0.04), [0, y, -2.25], MAT.steel, 0.25);
  // Posts a little thicker and taller than the rails: equal sizes put their
  // faces in one plane where they cross, and they z-fought.
  for (const x of [-1.02, -0.34, 0.34, 1.02]) T(buildBox(0.05, 0.4, 0.05), [x, 0.34, -2.25], MAT.steel, 0.25);
  // Side rails stop short of the back rail (overlapping, their tops z-fought).
  for (const sx of [-1, 1]) T(buildBox(0.04, 0.04, 0.35), [sx * 1.04, 0.5, -2.03], MAT.steel, 0.25);
  T(axleX(0.14, 1.7, 10), [0, 0.3, -2.07], MAT.canvas, 0.35);
  for (let k = 0; k < 3; k++) T(buildBox(0.34, 0.28, 0.26), [-0.6 + k * 0.6, 0.48, -1.95], MAT.canvas, 0.3 + R() * 0.35, [0, R() * 0.4 - 0.2, 0]);
  // Rangefinder blisters on the cheeks.
  for (const sx of [-1, 1]) T(new THREE.SphereGeometry(0.14, 10, 6), [sx * 1.22, 0.34, 0.6], MAT.paint, OD);
  // The mantlet under its canvas dust cover, and the 90 mm.
  T(buildBox(1.02, 0.6, 0.45), [0, 0.34, 1.62], MAT.canvas, 0.28);
  // Painted olive drab like the rest of the tank (bare metal read rust-brown);
  // the muzzle brake scorched dark.
  T(alongZ(0.088, 0.078, 3.95, 12), [0, 0.34, 3.8], MAT.paint, OD * 0.9);              // barrel
  T(alongZ(0.13, 0.13, 0.52, 12), [0, 0.34, 3.2], MAT.paint, OD * 0.8);                // bore evacuator
  T(buildBox(0.5, 0.15, 0.3), [0, 0.34, 5.78], MAT.steel, 0.04);                       // T muzzle brake
  T(alongZ(0.1, 0.1, 0.36, 10), [0, 0.34, 5.78], MAT.steel, 0.04);
  // The xenon searchlight over the gun: the M48's signature in Vietnam.
  T(buildBox(0.72, 0.55, 0.42), [0, 0.98, 1.5], MAT.paint, OD * 1.05);
  T(new THREE.CylinderGeometry(0.25, 0.25, 0.03, 18).rotateX(Math.PI / 2), [0, 0.98, 1.725], MAT.white, 0.35);  // lens
  T(buildBox(0.1, 0.3, 0.1), [0, 0.7, 1.45], MAT.steel, 0.2);                          // bracket
  // Commander's cupola (right rear) with its .50, the loader's hatch (left).
  T(new THREE.CylinderGeometry(0.44, 0.47, 0.42, 16), [0.55, 0.86, -0.25], MAT.paint, OD * 1.02);
  T(new THREE.CylinderGeometry(0.4, 0.44, 0.1, 16), [0.55, 1.12, -0.25], MAT.paint, OD * 0.95);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2 + 0.3;
    T(buildBox(0.14, 0.09, 0.05), [0.55 + Math.sin(a) * 0.46, 0.98, -0.25 + Math.cos(a) * 0.46], MAT.steel, 0.02, [0, a, 0]);
  }
  T(alongZ(0.03, 0.03, 1.0, 8), [0.55, 0.92, 0.55], MAT.steel, 0.06);
  T(new THREE.CylinderGeometry(0.3, 0.3, 0.05, 12), [-0.55, 0.7, -0.35], MAT.paint, OD * 1.05);
  // Antennas on the bustle's rear corners.
  for (const sx of [-1, 1]) {
    T(new THREE.CylinderGeometry(0.05, 0.06, 0.12, 8), [sx * 0.9, 0.62, -1.75], MAT.steel, 0.25);
    T(new THREE.CylinderGeometry(0.008, 0.016, 3.0, 4).translate(0, 1.5, 0), [sx * 0.9, 0.68, -1.75], MAT.steel, 0.3, [-0.12, 0, sx * 0.05]);
  }

  // ── Running gear: raised idler at the front, sprocket at the back, six road
  //    wheels, five return rollers under the top run. It rolls in the shader.
  const wheelR = 0.33, t = 0.06;
  const wheelsZ = [1.85, 1.1, 0.35, -0.4, -1.15, -1.9];
  const idler = { c: [2.55, 0.64], r: 0.3 }, sprocket = { c: [-2.72, 0.7], r: 0.33 };
  const rollers = [1.55, 0.8, 0.05, -0.7, -1.45].map((z) => ({ z, y: 1.0, r: 0.1 }));
  const path = trackPath({ front: idler, rear: sprocket, wheelsZ, wheelR, t, rollers });
  const wheel = (cy, cz, r) => [cy, cz, r, 1];
  for (const sx of [-1, 1]) {
    const xc = sx * (HW + 0.36), tw = 0.71;
    G(indexed(trackBand(path, xc, tw, t)), [0, 0, 0], MAT.steel, 0.03, undefined, [0, 0, 0, 2]);
    for (const z of wheelsZ) {
      const w = wheel(wheelR + t, z, wheelR);
      G(axleX(wheelR, 0.56, 16), [xc, wheelR + t, z], MAT.rubber, 0.5, undefined, w);                 // dual tyres
      G(axleX(0.21, 0.58, 12), [xc, wheelR + t, z], MAT.paint, OD * 0.9, undefined, w);               // discs
      G(axleX(0.08, 0.61, 8), [xc, wheelR + t, z], MAT.steel, 0.3, undefined, w);                     // hub
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        G(buildBox(0.6, 0.035, 0.035), [xc, wheelR + t + Math.sin(a) * 0.14, z + Math.cos(a) * 0.14], MAT.steel, 0.35, undefined, w);
      }
    }
    for (const r of rollers) G(axleX(r.r, 0.3, 10), [xc - sx * 0.14, r.y, r.z], MAT.steel, 0.08, undefined, wheel(r.y, r.z, r.r));
    const iw = wheel(idler.c[1], idler.c[0], idler.r);
    G(axleX(idler.r, 0.56, 16), [xc, idler.c[1], idler.c[0]], MAT.rubber, 0.45, undefined, iw);
    G(axleX(0.18, 0.58, 12), [xc, idler.c[1], idler.c[0]], MAT.paint, OD * 0.9, undefined, iw);
    const sw = wheel(sprocket.c[1], sprocket.c[0], sprocket.r);
    G(axleX(sprocket.r - 0.03, 0.5, 16), [xc, sprocket.c[1], sprocket.c[0]], MAT.paint, OD * 0.85, undefined, sw);
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2;
      G(buildBox(0.44, 0.08, 0.08), [xc, sprocket.c[1] + Math.sin(a) * (sprocket.r - 0.01), sprocket.c[0] + Math.cos(a) * (sprocket.r - 0.01)], MAT.steel, 0.25, [a, 0, 0], sw);
    }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.14, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const turretGeo = assemble(turret);
  bakeContactAO(turretGeo, { cell: 0.12, radius: 2, strength: 0.35, groundFade: 0, floor: 0.55 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.1, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: the star on both sides of the bustle (it turns with the turret),
  // the bumper code across the rear plate.
  const tst = [];
  for (const sx of [-1, 1]) tst.push(stencilPatch("star", flatSurface([sx * 1.054, 0.3, -1.45], [sx, 0, 0], [0, 0, -sx], 0.5, "star"), { lift: 0.004 }));
  const turretStencil = mergeStencils(tst);
  const stencil = mergeStencils([stencilPatch("bumperCode", flatSurface([0, 1.25, -3.2 - bev - 0.004], [0, 0, -1], [-1, 0, 0], 1.6, "bumperCode"), { lift: 0.004 })]);

  for (const g of [geo, turretGeo, gearGeo, stencil, turretStencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.turret = {
    geo: turretGeo, stencil: turretStencil,
    pivot: pivot.map((c) => c * S),
    muzzle: [0, 0.34 * S, 5.98 * S],
  };
  geo.userData.gear = gearGeo;
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  return geo;
}

// ── M151A1 MUTT ──────────────────────────────────────────────────────────────
/**
 * The jeep of the Vietnam war — not the WWII Willys: the M151's flat slotted
 * grille and flat hood, no doors, a pressed-steel tub. Rigged the way it ran
 * in-country: an M60 on a pedestal in the back with its gunner, the driver at
 * the wheel (M1 helmets under camouflage covers — from above, the helmets ARE
 * the crew), the windshield folded down on the hood under canvas, the big star
 * on the hood, and the wire-cutter bar standing up off the front bumper
 * against wire strung across the road. 3.37 m long, 1.63 m wide (real).
 *
 * userData: stencil, turret { geo, pivot, muzzle } (the M60 and its gunner),
 * gear (the four wheels, rolling), length.
 */
export function buildM151({ seed = 151 } = {}) {
  const R = rng(seed);
  const OD = 0.16;
  const FATIGUE = 0.25;                  // canvas tone for the crew's fatigues
  const hull = [], turret = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const pivot = [0, 1.46, -0.95];
  const T = (geo, pos, mat, tone = 0.5, rot) => turret.push({ geo, pos: [pos[0] - pivot[0], pos[1] - pivot[1], pos[2] - pivot[2]], mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const HW = 0.78, AXF = 1.08, AXR = -1.08, WR = 0.37, TRACK = 0.67;

  // ── Body sides: one pressed panel each side — the wheel arches, the low
  //    entry cut-out between the front fender and the rear quarter.
  const side = new THREE.Shape();
  side.moveTo(-1.66, 0.48);
  side.lineTo(-1.53, 0.48);
  side.absarc(AXR, 0.37, 0.45, Math.PI, 0, true);
  side.lineTo(0.63, 0.48);
  side.absarc(AXF, 0.37, 0.45, Math.PI, 0, true);
  side.lineTo(1.69, 0.48);
  side.lineTo(1.69, 0.93);
  side.lineTo(0.55, 0.98);
  side.lineTo(0.38, 0.78);
  side.lineTo(-0.42, 0.78);
  side.lineTo(-0.58, 0.98);
  side.lineTo(-1.66, 0.98);
  side.closePath();
  for (const sx of [-1, 1]) {
    const g = new THREE.ExtrudeGeometry(side, { depth: 0.05, bevelEnabled: false, curveSegments: 10 });
    g.rotateY(-Math.PI / 2);
    g.translate(sx > 0 ? HW : -HW + 0.05, 0, 0);
    P(indexed(g), [0, 0, 0], MAT.paint, OD);
  }
  // Hood (flat, a hair of slope), grille with its slots and the headlights
  // inside it, the cowl and dash, the floor pan, the rear panel.
  // Everything that meets a side panel stops a centimetre short of its face or
  // laps over it (the hood): cut to the panel's width, their faces z-fought.
  P(buildBox(2 * HW + 0.03, 0.04, 1.1), [0, 0.975, 1.11], MAT.paint, OD * 1.05, [0.03, 0, 0]);
  P(buildBox(1.44, 0.45, 0.05), [0, 0.705, 1.665], MAT.paint, OD * 0.95);
  // Four slots, all below the headlights (a fifth ran behind them, coplanar).
  for (let k = 0; k < 4; k++) P(buildBox(1.1, 0.035, 0.03), [0, 0.52 + k * 0.065, 1.695], MAT.steel, 0.03);
  for (const sx of [-1, 1]) P(new THREE.CylinderGeometry(0.085, 0.085, 0.04, 12).rotateX(Math.PI / 2), [sx * 0.52, 0.83, 1.7], MAT.white, 0.4);
  P(buildBox(2 * HW - 0.12, 0.24, 0.1), [0, 0.87, 0.52], MAT.paint, OD);                 // cowl / dash
  P(buildBox(2 * HW - 0.16, 0.05, 2.18), [0, 0.5, -0.56], MAT.paint, OD * 0.8);         // floor pan
  P(buildBox(2 * HW - 0.12, 0.5, 0.05), [0, 0.73, -1.635], MAT.paint, OD);              // rear panel
  // Rear wheel wells inside the tub.
  for (const sx of [-1, 1]) P(buildBox(0.22, 0.3, 0.92), [sx * (HW - 0.175), 0.68, AXR], MAT.paint, OD * 0.85);
  // Bumpers; the wire cutter off the front one.
  P(buildBox(1.66, 0.12, 0.08), [0, 0.46, 1.74], MAT.paint, OD * 0.9);
  P(buildBox(1.5, 0.1, 0.06), [0, 0.46, -1.7], MAT.paint, OD * 0.9);
  P(buildBox(0.05, 1.62, 0.05), [0.0, 1.31, 1.76], MAT.steel, 0.25);
  P(buildBox(0.04, 0.34, 0.04), [0.07, 2.03, 1.8], MAT.steel, 0.25, [0.45, 0, 0]);     // the hook at its top
  // The windshield folded down on the hood under its canvas cover.
  P(buildBox(1.42, 0.05, 0.5), [0, 1.02, 0.86], MAT.canvas, 0.4, [0.03, 0, 0]);
  // Seats: two up front (the driver on the left, +X), a bench each side at the back.
  for (const sx of [-1, 1]) {
    P(buildBox(0.44, 0.09, 0.44), [sx * 0.34, 0.6, 0.08], MAT.canvas, 0.3);
    P(buildBox(0.42, 0.42, 0.07), [sx * 0.34, 0.84, -0.17], MAT.canvas, 0.3, [-0.12, 0, 0]);   // narrower than the cushion: equal widths z-fought
    P(buildBox(0.3, 0.09, 0.7), [sx * 0.5, 0.86, -1.1], MAT.canvas, 0.3);
  }
  // Steering wheel and column.
  P(new THREE.TorusGeometry(0.17, 0.018, 5, 16).rotateX(Math.PI / 2 - 0.55), [0.34, 1.0, 0.36], MAT.steel, 0.05);
  P(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6).rotateX(-0.55), [0.34, 0.86, 0.44], MAT.steel, 0.05);
  // Spare wheel on the back, a jerry can in its rack, tail lights, the whip.
  P(axleX(0.34, 0.2, 14).rotateY(Math.PI / 2), [-0.38, 0.84, -1.79], MAT.rubber, 0.5);
  P(axleX(0.2, 0.21, 10).rotateY(Math.PI / 2), [-0.38, 0.84, -1.79], MAT.paint, OD * 0.9);
  P(buildBox(0.17, 0.47, 0.34), [0.42, 0.84, -1.84], MAT.paint, 0.42);
  for (const sx of [-1, 1]) P(buildBox(0.1, 0.08, 0.04), [sx * 0.66, 0.9, -1.67], MAT.steel, 0.15);
  P(new THREE.CylinderGeometry(0.045, 0.055, 0.12, 8), [HW - 0.12, 1.02, -1.5], MAT.steel, 0.25);
  P(new THREE.CylinderGeometry(0.007, 0.014, 2.8, 4).translate(0, 1.4, 0), [HW - 0.12, 1.08, -1.5], MAT.steel, 0.3, [-0.18, 0, 0.05]);
  // Rucksacks and an ammo can on the floor by the pedestal.
  P(buildBox(0.34, 0.26, 0.28), [-0.4, 0.67, -0.45], MAT.canvas, 0.35 + R() * 0.2, [0, 0.3, 0]);   // clear of the wheel well
  P(buildBox(0.1, 0.18, 0.28), [0.2, 0.62, -1.35], MAT.paint, 0.4);
  // The pedestal the M60 rides on.
  P(new THREE.CylinderGeometry(0.05, 0.07, 0.92, 8), [pivot[0], 0.98, pivot[2]], MAT.steel, 0.2);

  // ── Crew. The driver, seated…
  const helmet = (x, y, z, list) => {
    const h = new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1);
    list(h, [x, y, z], MAT.camo, 0.4);
    list(new THREE.CylinderGeometry(0.175, 0.175, 0.02, 14).scale(1, 1, 1.1), [x, y, z], MAT.camo, 0.35);   // brim
    list(new THREE.SphereGeometry(0.1, 8, 6), [x, y - 0.06, z], MAT.canvas, 0.15);                         // head under it
  };
  P(buildBox(0.4, 0.5, 0.24), [0.34, 0.92, -0.02], MAT.canvas, FATIGUE);
  for (const sx of [-1, 1]) P(buildBox(0.09, 0.09, 0.36), [0.34 + sx * 0.2, 1.02, 0.18], MAT.canvas, FATIGUE, [0.5, 0, 0]);
  helmet(0.34, 1.3, -0.02, P);
  // …and the gunner standing behind the M60 — they turn together.
  // Standing tall behind it: the stock meets his shoulder, his head clear above.
  T(buildBox(0.42, 0.56, 0.26), [0, 1.24, -1.55], MAT.canvas, FATIGUE);
  T(buildBox(0.36, 0.5, 0.22), [0, 0.78, -1.58], MAT.canvas, FATIGUE * 0.9);
  for (const sx of [-1, 1]) T(buildBox(0.09, 0.09, 0.42), [sx * 0.2, 1.36, -1.33], MAT.canvas, FATIGUE, [0.3, 0, 0]);
  helmet(0, 1.76, -1.55, T);
  // The M60 on its cradle (drawn a little larger than life, so it reads).
  const gz = pivot[2], gy = pivot[1] + 0.06, K = 1.4;
  T(buildBox(0.08, 0.1, 0.16), [0, pivot[1] - 0.02, gz], MAT.steel, 0.2);
  T(buildBox(0.09 * K, 0.13 * K, 0.42 * K), [0, gy, gz + 0.05], MAT.steel, 0.06);
  T(alongZ(0.022 * K, 0.024 * K, 0.56 * K, 8), [0, gy + 0.01, gz + 0.54 * K], MAT.steel, 0.06);
  T(alongZ(0.032 * K, 0.03 * K, 0.09 * K, 8), [0, gy + 0.01, gz + 0.87 * K], MAT.steel, 0.06);
  T(buildBox(0.065 * K, 0.11 * K, 0.3 * K), [0, gy - 0.02, gz - 0.3 * K], MAT.steel, 0.03);
  T(buildBox(0.1 * K, 0.18 * K, 0.28 * K), [-0.12 * K, gy - 0.07, gz + 0.05], MAT.paint, 0.45);

  // ── Wheels: tyre, rim, hub and lugs — they roll (the running-gear shader).
  for (const z of [AXF, AXR]) for (const sx of [-1, 1]) {
    const w = [WR, z, WR, 1], x = sx * TRACK;
    G(axleX(WR, 0.22, 18), [x, WR, z], MAT.rubber, 0.5, undefined, w);
    G(axleX(0.22, 0.23, 12), [x, WR, z], MAT.paint, OD * 0.9, undefined, w);
    G(axleX(0.08, 0.25, 8), [x, WR, z], MAT.steel, 0.3, undefined, w);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      G(buildBox(0.24, 0.035, 0.035), [x, WR + Math.sin(a) * 0.14, z + Math.cos(a) * 0.14], MAT.steel, 0.35, undefined, w);
    }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.08, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const turretGeo = assemble(turret);
  bakeContactAO(turretGeo, { cell: 0.06, radius: 1, strength: 0.3, groundFade: 0, floor: 0.55 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.06, radius: 1, strength: 0.25, groundFade: 0.2, floor: 0.6 });

  // Markings: the big star on the hood, the bumper code across the front bumper.
  const st = [];
  st.push(stencilPatch("star", flatSurface([0, 0.998, 1.25], [0, 1, 0.03], [-1, 0, 0], 0.8, "star"), { lift: 0.004 }));
  st.push(stencilPatch("bumperCode", flatSurface([0, 0.46, 1.78 + 0.004], [0, 0, 1], [1, 0, 0], 1.25, "bumperCode"), { lift: 0.004 }));
  const stencil = mergeStencils(st);

  for (const g of [geo, turretGeo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.turret = {
    geo: turretGeo,
    pivot: pivot.map((c) => c * S),
    muzzle: [0, (gy + 0.01 - pivot[1]) * S, (gz + 0.92 * K - pivot[2]) * S],
  };
  geo.userData.gear = gearGeo;
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  return geo;
}
