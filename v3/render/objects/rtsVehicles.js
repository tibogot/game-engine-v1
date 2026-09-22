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
import { STENCILS, flatSurface, mergeStencils, stencilPatch } from "./rtsStencils.js";
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

// ── UH-1H Huey ───────────────────────────────────────────────────────────────
/**
 * A LOFTED body: one smooth skin from the nose, through the cabin, down the
 * tapering tail boom — a rounded-box (superellipse) cross-section at each
 * station, Catmull-Rom between them. Everything else is laid ONTO that skin
 * with the same (z, angle) parametrisation — the glazing, the frames, the
 * open cargo doorway, the slid-back door, the markings — so it follows the
 * curve instead of being a box stuck on it.
 */
const HUEY_STATIONS = [
  // z (+ forward), cy centre height, w half-width, h top, hb bottom, n exponent
  { z: 4.36, cy: 1.58, w: 0.12, h: 0.1, hb: 0.1, n: 2.0 },
  { z: 4.22, cy: 1.62, w: 0.55, h: 0.42, hb: 0.44, n: 2.1 },
  { z: 3.95, cy: 1.7, w: 0.92, h: 0.68, hb: 0.62, n: 2.3 },
  { z: 3.55, cy: 1.78, w: 1.1, h: 0.84, hb: 0.74, n: 2.6 },
  { z: 3.0, cy: 1.84, w: 1.19, h: 0.92, hb: 0.82, n: 3.0 },
  { z: 2.0, cy: 1.86, w: 1.22, h: 0.92, hb: 0.87, n: 3.4 },
  { z: 0.0, cy: 1.86, w: 1.22, h: 0.92, hb: 0.89, n: 3.6 },
  { z: -1.5, cy: 1.88, w: 1.2, h: 0.9, hb: 0.86, n: 3.4 },
  { z: -2.3, cy: 1.99, w: 1.04, h: 0.8, hb: 0.62, n: 3.0 },
  { z: -3.0, cy: 2.13, w: 0.74, h: 0.6, hb: 0.38, n: 2.6 },
  { z: -3.6, cy: 2.21, w: 0.52, h: 0.45, hb: 0.3, n: 2.3 },
  { z: -6.0, cy: 2.31, w: 0.38, h: 0.34, hb: 0.24, n: 2.2 },
  { z: -8.0, cy: 2.41, w: 0.27, h: 0.26, hb: 0.18, n: 2.2 },
  { z: -8.35, cy: 2.43, w: 0.2, h: 0.2, hb: 0.14, n: 2.2 },
];

/** Catmull-Rom through the stations, by station index t (0 .. n-1). */
function stationAt(st, t) {
  const n = st.length;
  const i = Math.min(n - 2, Math.max(0, Math.floor(t)));
  const f = t - i;
  const p0 = st[Math.max(0, i - 1)], p1 = st[i], p2 = st[i + 1], p3 = st[Math.min(n - 1, i + 2)];
  const cr = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f * f + (-a + 3 * b - 3 * c + d) * f * f * f);
  const o = {};
  for (const k of ["z", "cy", "w", "h", "hb", "n"]) o[k] = cr(p0[k], p1[k], p2[k], p3[k]);
  return o;
}
/** Station parameter t for a body z (the stations' z falls monotonically). */
function stationT(st, z) {
  let lo = 0, hi = st.length - 1;
  if (z >= st[0].z) return 0;
  if (z <= st[hi].z) return hi;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (stationAt(st, mid).z > z) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
/** A point on a superellipse ring; angle 0 = +X (the right side), PI/2 = the top. */
function ringPoint(s, a) {
  const c = Math.cos(a), sn = Math.sin(a), e = 2 / s.n;
  const x = s.w * Math.sign(c) * Math.abs(c) ** e;
  const y = s.cy + (sn >= 0 ? s.h : s.hb) * Math.sign(sn) * Math.abs(sn) ** e;
  return new THREE.Vector3(x, y, s.z);
}

/** The skin at body (z, angle), and its outward normal. */
function skinAt(st, z, a) {
  const t = stationT(st, z);
  const p = ringPoint(stationAt(st, t), a);
  const e = 0.004;
  const pa = ringPoint(stationAt(st, t), a + e).sub(ringPoint(stationAt(st, t), a - e));
  const tz = stationT(st, z - 0.02);
  const pz = ringPoint(stationAt(st, t), a).sub(ringPoint(stationAt(st, tz), a));
  const n = new THREE.Vector3().crossVectors(pa, pz).normalize();
  // Outward: away from the section's centre line.
  if (n.x * p.x + n.y * (p.y - stationAt(st, t).cy) < 0) n.negate();
  return { p, n };
}

/** The lofted skin as one indexed mesh, nose and tail closed. */
function loftSkin(st, { segs = 36, sub = 5 } = {}) {
  const rings = [];
  for (let i = 0; i < st.length - 1; i++) for (let k = 0; k < sub; k++) rings.push(stationAt(st, i + k / sub));
  rings.push(st[st.length - 1]);
  const pos = [], uvs = [], idx = [];
  const row = segs + 1;
  rings.forEach((s) => {
    for (let j = 0; j <= segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const p = ringPoint(s, a);
      pos.push(p.x, p.y, p.z);
      uvs.push((j / segs) * 2 * (s.w + (s.h + s.hb) / 2), -s.z);
    }
  });
  for (let r = 0; r < rings.length - 1; r++) {
    for (let j = 0; j < segs; j++) {
      const a = r * row + j, b = a + 1, c = a + row, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  // Caps: a centre point each end, fanned to its ring.
  const cap = (ringIdx, flip) => {
    const s = rings[ringIdx];
    const ci = pos.length / 3;
    pos.push(0, s.cy, s.z + (flip ? -0.02 : 0.03));
    uvs.push(0, -s.z);
    for (let j = 0; j < segs; j++) {
      const a = ringIdx * row + j, b = a + 1;
      if (flip) idx.push(ci, b, a); else idx.push(ci, a, b);
    }
  };
  cap(0, false);
  cap(rings.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  // The winding must face out: check one face against the outward normal.
  g.computeVertexNormals();
  const A = new THREE.Vector3().fromArray(pos, (2 * row + 3) * 3), B = new THREE.Vector3().fromArray(pos, (2 * row + 4) * 3), C = new THREE.Vector3().fromArray(pos, (3 * row + 3) * 3);
  const f = new THREE.Vector3().subVectors(C, A).cross(new THREE.Vector3().subVectors(B, A));
  const out = new THREE.Vector3(A.x, A.y - rings[2].cy, 0);
  if (f.dot(out) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

/**
 * A patch laid on the skin over body z0..z1 and angles a0..a1, lifted `off`
 * along the skin's normal — glass, frames, the doorway. Outward-wound.
 */
function skinPatch(st, z0, z1, a0, a1, off, { nz = 8, na = 8 } = {}) {
  const pos = [], nrm = [], uvs = [], idx = [];
  for (let i = 0; i <= nz; i++) {
    const z = z0 + ((z1 - z0) * i) / nz;
    for (let j = 0; j <= na; j++) {
      const a = a0 + ((a1 - a0) * j) / na;
      const { p, n } = skinAt(st, z, a);
      p.addScaledVector(n, off);
      pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z); uvs.push(a, z);
    }
  }
  const row = na + 1;
  for (let i = 0; i < nz; i++) for (let j = 0; j < na; j++) {
    const a = i * row + j;
    idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  const A = new THREE.Vector3().fromArray(pos, 0), B = new THREE.Vector3().fromArray(pos, 3), C = new THREE.Vector3().fromArray(pos, row * 3);
  const f = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A));
  if (f.dot(new THREE.Vector3(nrm[0], nrm[1], nrm[2])) < 0) {
    for (let k = 0; k < idx.length; k += 3) { const tmp = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = tmp; }
    g.setIndex(idx);
  }
  return g;
}

/** A tube along a smooth path (skids, cross tubes, exhaust, tail skid). */
const tube = (pts, r, seg = 20, radial = 8) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), seg, r, radial, false);

/** An airfoil-section blade along +X, `len` long, drooping `droop` at its tip. */
function blade(len, chord, thick, droop = 0) {
  const sh = new THREE.Shape();
  sh.absellipse(0, 0, chord / 2, thick / 2, 0, Math.PI * 2, false, 0);
  const g = new THREE.ExtrudeGeometry(sh, { depth: len, steps: 8, bevelEnabled: false, curveSegments: 10 });
  // Shape XY = (chord, thickness), extruded along Z. One turn about Y lays the
  // length along +X, the chord along Z and the thickness along Y: FLAT. (A
  // second turn about X stood the chord up on edge — the rotor looked vertical.)
  g.rotateY(Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setY(i, p.getY(i) - droop * (x / len) ** 2);
  }
  g.computeVertexNormals();
  return indexed(g);
}

/**
 * The UH-1H. 12.7 m fuselage, 14.6 m rotor (real). What makes it a Huey:
 * the rounded cabin with its glazed nose and roof and chin windows; the cargo
 * doors slid back, a door gunner with his M60 in each; the engine cowling and
 * curved exhaust; the TWO-blade rotor with its stabiliser bar; the long
 * tapering boom, the elevators, the fin and the tail rotor on its left; skids.
 *
 * userData: stencil, rotors { main: { geo, pivot }, tail: { geo, pivot } },
 * length. The unit renderer spins meshes named MainRotor (about Y) and
 * TailRotor (about X) round their own pivots.
 */
export function buildUH1() {
  const st = HUEY_STATIONS;
  const OD = 0.16, FATIGUE = 0.25;
  const hull = [], main = [], tail = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const at = (z, a, off = 0) => { const { p, n } = skinAt(st, z, a); return p.addScaledVector(n, off); };
  const D = Math.PI / 180;
  const ROOF = 2.78;

  // ── The skin.
  P(loftSkin(st), [0, 0, 0], MAT.paint, OD);

  // ── Glazing: windscreen and cockpit roof (the upper nose), the chin
  //    windows (the lower nose each side of the keel), the cockpit doors'
  //    windows. Frames over them: the centre post, the windscreen's top edge.
  const GL = 0.012, FR = 0.024;
  P(skinPatch(st, 2.55, 4.12, 18 * D, 162 * D, GL, { nz: 14, na: 18 }), [0, 0, 0], MAT.steel, 0.12);
  for (const [a0, a1] of [[-72 * D, -28 * D], [-152 * D, -108 * D]]) {
    P(skinPatch(st, 3.3, 4.12, a0, a1, GL, { nz: 8, na: 6 }), [0, 0, 0], MAT.steel, 0.12);
  }
  for (const [a0, a1] of [[-12 * D, 30 * D], [150 * D, 192 * D]]) {
    P(skinPatch(st, 1.3, 2.45, a0, a1, GL, { nz: 6, na: 6 }), [0, 0, 0], MAT.steel, 0.12);
  }
  P(skinPatch(st, 2.55, 4.15, 87 * D, 93 * D, FR, { nz: 12, na: 1 }), [0, 0, 0], MAT.paint, OD * 0.9);      // centre post
  P(skinPatch(st, 2.5, 2.62, 12 * D, 168 * D, FR, { nz: 1, na: 18 }), [0, 0, 0], MAT.paint, OD * 0.9);     // top of the windscreen
  for (const a of [52 * D, 128 * D]) P(skinPatch(st, 2.55, 3.9, a - 2 * D, a + 2 * D, FR, { nz: 10, na: 1 }), [0, 0, 0], MAT.paint, OD * 0.9);   // side posts
  for (const a of [-50 * D, -130 * D]) P(skinPatch(st, 3.3, 4.12, a - 2 * D, a + 2 * D, FR, { nz: 6, na: 1 }), [0, 0, 0], MAT.paint, OD * 0.9);   // chin window frames
  // Wipers on the windscreen.
  for (const sx of [-1, 1]) { const w = at(3.85, (90 - sx * 28) * D, 0.03); P(buildBox(0.03, 0.02, 0.5), [w.x, w.y, w.z], MAT.steel, 0.1, [0.9, 0, 0]); }

  // ── The cargo doorway, open (dark cabin) each side, and the door slid back
  //    along the aft fuselage with its window.
  for (const [a0, a1] of [[-40 * D, 44 * D], [136 * D, 220 * D]]) {
    P(skinPatch(st, -0.95, 1.05, a0, a1, GL, { nz: 8, na: 10 }), [0, 0, 0], MAT.steel, 0.0);
  }
  for (const [a0, a1, aw0, aw1] of [[-38 * D, 42 * D, 5 * D, 35 * D], [138 * D, 218 * D, 145 * D, 175 * D]]) {
    P(skinPatch(st, -2.15, -0.9, a0, a1, 0.05, { nz: 8, na: 10 }), [0, 0, 0], MAT.paint, OD * 1.08);
    P(skinPatch(st, -1.85, -1.2, aw0, aw1, 0.062, { nz: 3, na: 4 }), [0, 0, 0], MAT.steel, 0.12);   // its window
  }
  // Door rails, above and below the doorway.
  for (const sx of [-1, 1]) for (const y of [2.62, 1.12]) P(alongZ(0.022, 0.022, 3.4, 6), [sx * 1.22, y, -0.5], MAT.steel, 0.25);

  // ── Engine cowling (a smooth hump), the transmission fairing in front of
  //    the mast, the intake screens, the curved exhaust.
  const cowl = [
    { z: 1.0, cy: ROOF - 0.05, w: 0.1, h: 0.05, hb: 0.05, n: 2.2 },
    { z: 0.85, cy: ROOF - 0.02, w: 0.5, h: 0.28, hb: 0.2, n: 2.6 },
    { z: 0.2, cy: ROOF, w: 0.66, h: 0.42, hb: 0.2, n: 3.0 },
    { z: -1.2, cy: ROOF, w: 0.68, h: 0.48, hb: 0.2, n: 3.2 },
    { z: -2.4, cy: ROOF - 0.05, w: 0.6, h: 0.42, hb: 0.2, n: 3.0 },
    { z: -2.9, cy: ROOF - 0.12, w: 0.42, h: 0.28, hb: 0.16, n: 2.6 },
    { z: -3.05, cy: ROOF - 0.14, w: 0.3, h: 0.18, hb: 0.12, n: 2.4 },
  ];
  P(loftSkin(cowl, { segs: 24, sub: 3 }), [0, 0, 0], MAT.paint, OD * 0.95);
  for (const sx of [-1, 1]) {
    P(skinPatch(cowl, -0.2, 0.7, (sx > 0 ? 8 : 140) * D, (sx > 0 ? 40 : 172) * D, 0.012, { nz: 5, na: 4 }), [0, 0, 0], MAT.steel, 0.05);   // intake screens
    P(skinPatch(cowl, -2.3, -1.3, (sx > 0 ? 10 : 150) * D, (sx > 0 ? 30 : 170) * D, 0.012, { nz: 5, na: 3 }), [0, 0, 0], MAT.steel, 0.1);   // louvres
  }
  P(tube([[0, ROOF + 0.3, -2.85], [0, ROOF + 0.4, -3.2], [0, ROOF + 0.72, -3.42]], 0.19, 12, 12), [0, 0, 0], MAT.steel, 0.02);   // exhaust, heat-blackened
  // Mast, swashplate and the pitch-change links.
  P(new THREE.CylinderGeometry(0.1, 0.13, 0.62, 12), [0, ROOF + 0.72, -0.3], MAT.steel, 0.25);
  P(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 16), [0, ROOF + 0.62, -0.3], MAT.steel, 0.3);
  // Anti-collision beacon on the cowl, the VHF whip, the pitot tube and
  // landing light on the nose, FM homing antennas on its cheeks.
  P(new THREE.SphereGeometry(0.08, 10, 6), [0, ROOF + 0.5, -2.2], MAT.white, 0.3);
  P(new THREE.CylinderGeometry(0.008, 0.014, 1.3, 4).translate(0, 0.65, 0), [0.35, ROOF + 0.18, -3.5], MAT.steel, 0.3, [-0.35, 0, 0]);
  const pit = at(3.0, 90 * D, 0.02);
  P(alongZ(0.018, 0.018, 0.9, 6), [0.18, pit.y + 0.02, pit.z + 0.9], MAT.steel, 0.35, [-0.3, 0, 0]);
  const ll = at(3.7, -90 * D, 0.03);
  P(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 12), [ll.x, ll.y, ll.z], MAT.steel, 0.2);
  P(new THREE.CylinderGeometry(0.075, 0.075, 0.02, 12), [ll.x, ll.y - 0.045, ll.z], MAT.white, 0.4);
  for (const sx of [-1, 1]) { const q = at(3.6, (sx > 0 ? 8 : 172) * D, 0.03); P(buildBox(0.02, 0.28, 0.22), [q.x, q.y, q.z], MAT.steel, 0.2, [0, 0, sx * 0.2]); }
  // Cargo hook under the belly.
  P(buildBox(0.3, 0.1, 0.3), [0, 0.93, -0.3], MAT.steel, 0.2);

  // ── Tail: elevators (rounded airfoils) halfway down the boom, the fin with
  //    its tail-rotor gearbox, the tail skid, the "towel rack" antenna.
  for (const sx of [-1, 1]) {
    const e = blade(1.35, 0.5, 0.07);
    P(e, [sx * 0.3 - (sx < 0 ? 1.35 : 0), 2.33, -5.4], MAT.paint, OD * 0.95);
    P(buildBox(0.05, 0.24, 0.42), [sx * 1.66, 2.33, -5.4], MAT.paint, OD * 0.95);     // tip plates
  }
  const fin = new THREE.Shape();
  fin.moveTo(-0.5, 0); fin.lineTo(0.42, 0); fin.quadraticCurveTo(0.1, 1.0, -0.12, 1.72); fin.lineTo(-0.72, 1.72); fin.quadraticCurveTo(-0.62, 0.8, -0.5, 0);
  const finG = new THREE.ExtrudeGeometry(fin, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.03, bevelSegments: 2, curveSegments: 8 });
  finG.rotateY(-Math.PI / 2);
  finG.computeBoundingBox();
  finG.translate(-(finG.boundingBox.min.x + finG.boundingBox.max.x) / 2, 0, 0);
  P(indexed(finG), [0, 2.36, -8.05], MAT.paint, OD);
  P(new THREE.CylinderGeometry(0.13, 0.15, 0.3, 12).rotateZ(Math.PI / 2), [-0.12, 3.62, -8.52], MAT.paint, OD * 0.9);   // gearbox
  P(new THREE.SphereGeometry(0.12, 10, 6), [-0.27, 3.62, -8.52], MAT.steel, 0.2);
  P(tube([[0, 2.22, -7.7], [0, 1.95, -8.1], [0, 1.9, -8.4]], 0.03, 10, 6), [0, 0, 0], MAT.steel, 0.25);   // tail skid
  P(buildBox(0.035, 0.3, 0.035), [0, 2.78, -3.9], MAT.steel, 0.2);
  P(buildBox(0.045, 0.035, 0.9), [0, 2.93, -4.1], MAT.steel, 0.2);

  // ── Skids: tubes with turned-up toes on two bowed cross tubes, steps.
  for (const sx of [-1, 1]) {
    const x = sx * 1.32;
    P(tube([[x, 0.08, -2.1], [x, 0.08, 0.0], [x, 0.08, 1.9], [x, 0.2, 2.45], [x, 0.45, 2.7]], 0.055, 24, 8), [0, 0, 0], MAT.steel, 0.28);
    for (const z of [1.05, -1.3]) {
      P(tube([[x, 0.08, z], [sx * 1.3, 0.5, z], [sx * 1.08, 0.86, z], [sx * 0.6, 0.97, z]], 0.06, 10, 8), [0, 0, 0], MAT.steel, 0.28);
    }
    P(buildBox(0.34, 0.03, 0.22), [sx * 1.28, 0.62, 0.4], MAT.steel, 0.3);    // step
  }
  for (const z of [1.05, -1.3]) P(axleX(0.06, 1.2, 8), [0, 0.97, z], MAT.steel, 0.28);

  // ── Door gunners: in the doorway each side, seated facing out behind an
  //    M60 on a post, flight helmet with its dark visor.
  const K = 1.4;
  for (const sx of [-1, 1]) {
    const gx = sx * 1.1, gz = -0.05;
    P(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 6), [gx, 1.5, gz + 0.35], MAT.steel, 0.2);                   // mount post
    P(buildBox(0.42 * K, 0.13 * K, 0.09 * K), [gx + sx * 0.14, 1.94, gz + 0.35], MAT.steel, 0.06);              // M60 receiver
    P(axleX(0.022 * K, 0.56 * K, 8), [gx + sx * (0.14 + 0.48 * K), 1.95, gz + 0.35], MAT.steel, 0.06);          // barrel
    P(buildBox(0.1 * K, 0.18 * K, 0.28 * K), [gx - sx * 0.06, 1.82, gz + 0.52], MAT.paint, 0.4);                // ammo can
    const bx = sx * 0.68;
    P(buildBox(0.3, 0.52, 0.42), [bx, 1.55, gz], MAT.canvas, FATIGUE);                                          // torso
    P(buildBox(0.42, 0.18, 0.34), [bx + sx * 0.24, 1.18, gz], MAT.canvas, FATIGUE * 0.9);                       // thighs, out the door
    P(buildBox(0.16, 0.42, 0.3), [bx + sx * 0.46, 0.94, gz], MAT.canvas, FATIGUE * 0.9);                        // shins, dangling
    for (const dz of [-0.13, 0.13]) P(buildBox(0.44, 0.09, 0.09), [bx + sx * 0.26, 1.72, gz + 0.2 + dz], MAT.canvas, FATIGUE);   // arms to the gun
    P(new THREE.SphereGeometry(0.16, 12, 8), [bx, 1.95, gz], MAT.paint, OD * 0.8);                               // flight helmet
    P(new THREE.SphereGeometry(0.14, 10, 6, -Math.PI / 3, (2 * Math.PI) / 3, Math.PI * 0.32, Math.PI * 0.26), [bx + sx * 0.03, 1.94, gz], MAT.steel, 0.02, [0, sx > 0 ? Math.PI / 2 : -Math.PI / 2, 0]);   // visor
  }

  // ── Main rotor (about Y, pivot on the hub): airfoil blades drooping to
  //    their tips, grips and pitch horns, the trunnion, the stabiliser bar.
  const hubY = ROOF + 1.12, hubZ = -0.3;
  const BL = 7.1;
  for (const sx of [-1, 1]) {
    const b = blade(BL, 0.53, 0.07, 0.22);
    if (sx < 0) b.rotateY(Math.PI);
    main.push({ geo: b, pos: [sx * 0.2, 0, 0], mat: MAT.steel, tone: 0.1 });
    const tip = blade(0.45, 0.535, 0.072, 0);
    if (sx < 0) tip.rotateY(Math.PI);
    main.push({ geo: tip, pos: [sx * (0.2 + BL - 0.44), -0.215, 0], mat: MAT.white, tone: 0.4 });            // tip stripe
    main.push({ geo: buildBox(0.5, 0.14, 0.2), pos: [sx * 0.42, 0, 0], mat: MAT.steel, tone: 0.25 });        // grip
    main.push({ geo: buildBox(0.06, 0.28, 0.06), pos: [sx * 0.42, -0.14, 0.14], mat: MAT.steel, tone: 0.3 });   // pitch link
  }
  main.push({ geo: new THREE.CylinderGeometry(0.16, 0.18, 0.26, 14), pos: [0, 0, 0], mat: MAT.steel, tone: 0.2 });
  main.push({ geo: alongZ(0.035, 0.035, 2.5, 8), pos: [0, 0.2, 0], mat: MAT.steel, tone: 0.2 });           // stabiliser bar
  for (const sz of [-1, 1]) main.push({ geo: alongZ(0.07, 0.07, 0.4, 10), pos: [0, 0.2, sz * 1.25], mat: MAT.steel, tone: 0.15 });

  // ── Tail rotor (about X): two airfoil blades on the gearbox's left.
  for (const sy of [-1, 1]) {
    const b = blade(0.62, 0.2, 0.04, 0);
    b.rotateZ(Math.PI / 2);
    if (sy < 0) b.rotateX(Math.PI);
    tail.push({ geo: b, pos: [0, sy * 0.05, 0], mat: MAT.steel, tone: 0.1 });
  }
  tail.push({ geo: axleX(0.07, 0.12, 10), pos: [0, 0, 0], mat: MAT.steel, tone: 0.25 });
  const tailPivot = [-0.36, 3.62, -8.52];

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.35, groundFade: 0.2, floor: 0.55 });
  const mainGeo = assemble(main);
  bakeContactAO(mainGeo, { cell: 0.1, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });
  const tailGeo = assemble(tail);
  bakeContactAO(tailGeo, { cell: 0.05, radius: 1, strength: 0.2, groundFade: 0, floor: 0.7 });

  // ── Markings, laid on the curving skin: U.S. ARMY down both sides of the
  //    boom, the star on the aft fuselage, the tail number on the fin.
  const mk = [];
  const onSkin = (cell, zc, ac, width, sx) => {
    const aspect = STENCILS[cell].aspect;
    return stencilPatch(cell, (s, t) => {
      // s along the body (the viewer's right is -Z on +X, +Z on -X), t up it.
      const z = zc - sx * (s - 0.5) * width;
      const { p, n } = skinAt(st, z, ac + sx * (t - 0.5) * (width / aspect) / Math.max(0.3, skinAt(st, z, ac).p.distanceTo(new THREE.Vector3(0, stationAt(st, stationT(st, z)).cy, z))));
      return { p, n };
    }, { segS: 12, segT: 4, lift: 0.014 });
  };
  for (const sx of [-1, 1]) {
    const a = sx > 0 ? 0 : Math.PI;
    mk.push(onSkin("armyBlack", -4.7, a, 1.6, sx));
    mk.push(onSkin("star", -2.35, sx > 0 ? 5 * D : 175 * D, 0.72, sx));
    mk.push(stencilPatch("tailNumber", flatSurface([sx * 0.085, 2.95, -8.15], [sx, 0, 0], [0, 0, -sx], 0.62, "tailNumber"), { lift: 0.004 }));
  }
  const stencil = mergeStencils(mk);

  for (const g of [geo, mainGeo, tailGeo, stencil]) g?.scale(S, S, S);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.rotors = {
    main: { geo: mainGeo, pivot: [0, hubY * S, hubZ * S] },
    tail: { geo: tailGeo, pivot: tailPivot.map((c) => c * S) },
  };
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  return geo;
}

// ── M551 Sheridan ────────────────────────────────────────────────────────────
/**
 * The armoured cavalry's light tank in Vietnam (11th ACR and others). What
 * makes it a Sheridan: the flat aluminium hull with a long shallow glacis and
 * the FLOTATION SCREEN rolled up as a canvas tube round its top edge; a low,
 * rounded turret (lofted, like the Huey's body); the short, fat 152 mm
 * gun-launcher under its heavy mantlet; a searchlight box on the turret's
 * left, smoke dischargers on its cheeks; the commander's .50 behind an ACAV
 * shield; the bustle rack piled with gear; five road wheels a side, no return
 * rollers, the drive sprocket at the back. 6.3 m, 2.82 m wide (real).
 *
 * userData: stencil, turret { geo, stencil, pivot, muzzle }, gear, length.
 */
export function buildM551({ seed = 551 } = {}) {
  const R = rng(seed);
  const OD = 0.16;
  const hull = [], turret = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const T = (geo, pos, mat, tone = 0.5, rot) => turret.push({ geo, pos, mat, tone, rot });    // turret-local
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const HW = 0.97, DECK = 1.55;
  const pivot = [0, DECK, 0.1];

  // ── Hull: the side profile — flat belly, the lower nose plate, the long
  //    shallow glacis, the deck, the rear plate — bevelled.
  const shape = new THREE.Shape();
  shape.moveTo(-3.0, 0.45);
  shape.lineTo(2.45, 0.45);
  shape.lineTo(3.15, 0.95);
  shape.lineTo(1.45, DECK);
  shape.lineTo(-3.05, DECK);
  shape.lineTo(-3.1, 0.72);
  shape.closePath();
  const bev = 0.05;
  const body = new THREE.ExtrudeGeometry(shape, { depth: 2 * HW - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2 });
  body.rotateY(-Math.PI / 2);
  body.computeBoundingBox();
  body.translate(-(body.boundingBox.min.x + body.boundingBox.max.x) / 2, 0, 0);
  P(indexed(body), [0, 0, 0], MAT.paint, OD);
  const deckY = DECK + bev;
  const gl = new THREE.Vector2(3.15 - 1.45, 0.95 - DECK).normalize();
  const glN = new THREE.Vector3(0, gl.x, -gl.y).normalize();
  const glRot = [Math.atan2(DECK - 0.95, 3.15 - 1.45), 0, 0];
  const glacisAt = (f, lift) => new THREE.Vector3(0, DECK + (0.95 - DECK) * f, 1.45 + (3.15 - 1.45) * f).addScaledVector(glN, lift + bev);

  // The flotation screen, rolled up: a canvas tube along both deck edges and
  // across the top of the glacis, on its stanchions.
  for (const sx of [-1, 1]) {
    P(tube([[sx * (HW + 0.02), deckY + 0.1, -2.9], [sx * (HW + 0.03), deckY + 0.1, 0], [sx * (HW + 0.02), deckY + 0.09, 1.3], [sx * 0.9, deckY + 0.05, 1.55]], 0.12, 24, 10), [0, 0, 0], MAT.canvas, 0.38);
    for (const z of [-2.4, -1.2, 0, 1.1]) P(buildBox(0.05, 0.2, 0.05), [sx * (HW + 0.02), deckY, z], MAT.steel, 0.25);
  }
  const fr = glacisAt(0.08, 0.08);
  P(axleX(0.12, 1.75, 10), [0, fr.y + 0.05, fr.z], MAT.canvas, 0.38);
  // Glacis: driver's hatch and periscopes, spare track shoes hung across it,
  // headlight clusters in their guards, tow hooks.
  const dh = glacisAt(0.12, 0.02);
  P(new THREE.CylinderGeometry(0.3, 0.32, 0.07, 14), [0, dh.y + 0.03, dh.z], MAT.paint, OD * 1.05, glRot);
  for (let k = 0; k < 3; k++) { const q = glacisAt(0.04, 0.05); P(buildBox(0.12, 0.07, 0.06), [-0.2 + k * 0.2, q.y + 0.02, q.z - 0.05], MAT.steel, 0.02); }
  for (let k = 0; k < 5; k++) { const q = glacisAt(0.55, 0.03); P(buildBox(0.36, 0.05, 0.14), [-0.9 + k * 0.45, q.y, q.z], MAT.steel, 0.1, glRot); }
  for (const sx of [-1, 1]) {
    const hl = glacisAt(0.8, 0.07);
    P(buildBox(0.22, 0.16, 0.14), [sx * 0.75, hl.y, hl.z], MAT.steel, 0.12, glRot);
    P(buildBox(0.3, 0.025, 0.025), [sx * 0.75, hl.y + 0.12, hl.z + 0.05], MAT.paint, OD);
    P(buildBox(0.14, 0.14, 0.18), [sx * 0.55, 0.7, 3.12], MAT.steel, 0.3);
  }
  // Engine deck: louvres, the exhaust grille on the right, jerry cans and
  // ammo boxes on the back deck, tail lights.
  for (let k = 0; k < 6; k++) P(buildBox(1.3, 0.035, 0.06), [-0.1, deckY + 0.02, -1.6 - k * 0.18], MAT.steel, 0.1);
  P(buildBox(0.55, 0.12, 0.9), [0.55, deckY + 0.06, -2.6], MAT.steel, 0.05);
  for (let k = 0; k < 3; k++) P(buildBox(0.17, 0.47, 0.34), [-0.6 + k * 0.2, deckY + 0.24, -2.75], MAT.paint, 0.42);
  P(buildBox(0.1, 0.18, 0.28), [0.15, deckY + 0.09, -2.2], MAT.paint, 0.4);
  for (const sx of [-1, 1]) P(buildBox(0.12, 0.1, 0.05), [sx * 0.8, 1.35, -3.14], MAT.steel, 0.15);

  // ── Turret, lofted (turret-local: pivot at the ring's centre on the deck).
  const TS = [
    { z: 1.42, cy: 0.3, w: 0.45, h: 0.08, hb: 0.25, n: 2.2 },
    { z: 1.22, cy: 0.33, w: 0.98, h: 0.3, hb: 0.3, n: 2.6 },
    { z: 0.7, cy: 0.36, w: 1.14, h: 0.4, hb: 0.36, n: 3.0 },
    { z: -0.6, cy: 0.36, w: 1.12, h: 0.42, hb: 0.36, n: 3.2 },
    { z: -1.15, cy: 0.35, w: 0.98, h: 0.38, hb: 0.34, n: 3.0 },
    { z: -1.32, cy: 0.33, w: 0.6, h: 0.2, hb: 0.2, n: 2.4 },
  ];
  T(loftSkin(TS, { segs: 32, sub: 4 }), [0, 0, 0], MAT.paint, OD * 1.04);
  // Mantlet and the fat 152 mm gun-launcher; the mantlet in its dust cover.
  T(buildBox(0.9, 0.52, 0.36), [0, 0.34, 1.42], MAT.canvas, 0.3);
  T(alongZ(0.19, 0.17, 0.5, 14), [0, 0.34, 1.7], MAT.paint, OD * 0.9);
  T(alongZ(0.12, 0.115, 1.75, 14), [0, 0.34, 2.8], MAT.paint, OD * 0.9);
  T(alongZ(0.13, 0.13, 0.1, 14), [0, 0.34, 3.66], MAT.steel, 0.05);                                  // muzzle ring
  // The searchlight box on the turret's left.
  T(buildBox(0.5, 0.42, 0.5), [-0.72, 0.9, 0.72], MAT.paint, OD * 1.05);
  T(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 16).rotateX(Math.PI / 2), [-0.72, 0.9, 0.985], MAT.white, 0.35);
  T(buildBox(0.08, 0.2, 0.08), [-0.72, 0.64, 0.72], MAT.steel, 0.2);
  // Smoke dischargers: four tubes each cheek, angled up and out.
  for (const sx of [-1, 1]) for (let k = 0; k < 4; k++) {
    T(new THREE.CylinderGeometry(0.045, 0.045, 0.28, 8), [sx * (0.8 + k * 0.06), 0.62, 1.0 - k * 0.1], MAT.steel, 0.1, [0.8, 0, -sx * 0.4]);
  }
  // Commander's cupola, right-rear, with the .50 behind its ACAV shield.
  const cx = 0.48, cz = -0.35, cy = 0.78;
  T(new THREE.CylinderGeometry(0.38, 0.4, 0.16, 16), [cx, cy, cz], MAT.paint, OD * 1.02);
  T(buildBox(0.85, 0.46, 0.03), [cx, cy + 0.3, cz + 0.45], MAT.paint, OD * 0.92, [-0.12, 0, 0]);
  for (const sx of [-1, 1]) T(buildBox(0.38, 0.46, 0.03), [cx + sx * 0.56, cy + 0.3, cz + 0.3], MAT.paint, OD * 0.92, [-0.1, sx * 0.72, 0]);
  T(buildBox(0.15, 0.13, 0.5), [cx, cy + 0.38, cz + 0.08], MAT.steel, 0.06);
  T(alongZ(0.042, 0.042, 0.34, 8), [cx, cy + 0.39, cz + 0.5], MAT.steel, 0.08);
  T(alongZ(0.024, 0.024, 0.8, 8), [cx, cy + 0.39, cz + 0.88], MAT.steel, 0.06);
  T(new THREE.CylinderGeometry(0.03, 0.04, 0.3, 6), [cx, cy + 0.16, cz + 0.08], MAT.steel, 0.2);
  T(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 12), [-0.4, 0.8, -0.4], MAT.paint, OD * 1.05);      // loader's hatch
  // Bustle rack: a rail frame behind the turret, packs and a rolled tarp in it.
  for (const y of [0.3, 0.6]) T(buildBox(1.9, 0.04, 0.04), [0, y, -1.72], MAT.steel, 0.25);
  for (const x of [-0.94, -0.3, 0.3, 0.94]) T(buildBox(0.05, 0.4, 0.05), [x, 0.44, -1.72], MAT.steel, 0.25);
  for (const sx of [-1, 1]) T(buildBox(0.04, 0.04, 0.4), [sx * 0.97, 0.6, -1.5], MAT.steel, 0.25);
  T(axleX(0.14, 1.6, 10), [0, 0.46, -1.55], MAT.canvas, 0.35);
  for (let k = 0; k < 3; k++) T(buildBox(0.32, 0.26, 0.26), [-0.55 + k * 0.55, 0.7, -1.45], MAT.canvas, 0.3 + R() * 0.35, [0, R() * 0.4 - 0.2, 0]);
  // Antennas at the turret's rear corners.
  for (const sx of [-1, 1]) {
    T(new THREE.CylinderGeometry(0.045, 0.055, 0.12, 8), [sx * 0.8, 0.76, -1.0], MAT.steel, 0.25);
    T(new THREE.CylinderGeometry(0.008, 0.015, 3.0, 4).translate(0, 1.5, 0), [sx * 0.8, 0.82, -1.0], MAT.steel, 0.3, [-0.12, 0, sx * 0.05]);
  }

  // ── Running gear: raised idler in front, five road wheels, no return
  //    rollers (the top run rides the wheels), the sprocket at the back.
  const wheelR = 0.33, t = 0.05;
  const wheelsZ = [1.75, 0.9, 0.05, -0.8, -1.65];
  const idler = { c: [2.45, 0.62], r: 0.28 }, sprocket = { c: [-2.55, 0.66], r: 0.3 };
  const path = trackPath({ front: idler, rear: sprocket, wheelsZ, wheelR, t });
  const wheel = (cy, cz, r) => [cy, cz, r, 1];
  for (const sx of [-1, 1]) {
    const xc = sx * (HW + 0.24), tw = 0.44;
    G(indexed(trackBand(path, xc, tw, t)), [0, 0, 0], MAT.steel, 0.05, undefined, [0, 0, 0, 2]);
    for (const z of wheelsZ) {
      const w = wheel(wheelR + t, z, wheelR);
      G(axleX(wheelR, 0.36, 18), [xc, wheelR + t, z], MAT.rubber, 0.5, undefined, w);
      G(axleX(0.22, 0.38, 14), [xc, wheelR + t, z], MAT.paint, OD * 0.9, undefined, w);
      G(axleX(0.08, 0.41, 8), [xc, wheelR + t, z], MAT.steel, 0.3, undefined, w);
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        G(buildBox(0.4, 0.035, 0.035), [xc, wheelR + t + Math.sin(a) * 0.14, z + Math.cos(a) * 0.14], MAT.steel, 0.35, undefined, w);
      }
    }
    const iw = wheel(idler.c[1], idler.c[0], idler.r);
    G(axleX(idler.r, 0.36, 16), [xc, idler.c[1], idler.c[0]], MAT.rubber, 0.45, undefined, iw);
    G(axleX(0.17, 0.38, 12), [xc, idler.c[1], idler.c[0]], MAT.paint, OD * 0.9, undefined, iw);
    const sw = wheel(sprocket.c[1], sprocket.c[0], sprocket.r);
    G(axleX(sprocket.r - 0.03, 0.32, 16), [xc, sprocket.c[1], sprocket.c[0]], MAT.paint, OD * 0.85, undefined, sw);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      G(buildBox(0.28, 0.07, 0.07), [xc, sprocket.c[1] + Math.sin(a) * (sprocket.r - 0.01), sprocket.c[0] + Math.cos(a) * (sprocket.r - 0.01)], MAT.steel, 0.25, [a, 0, 0], sw);
    }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const turretGeo = assemble(turret);
  bakeContactAO(turretGeo, { cell: 0.1, radius: 2, strength: 0.35, groundFade: 0, floor: 0.55 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: the star on both turret sides (laid on the lofted skin, it
  // turns with the turret), the bumper code on the rear plate.
  const tst = [];
  for (const sx of [-1, 1]) {
    tst.push(stencilPatch("star", (s, tt) => {
      const z = -0.25 - sx * (s - 0.5) * 0.62;
      const a = (sx > 0 ? 0 : Math.PI) + sx * (tt - 0.5) * 0.9;
      return skinAt(TS, z, a);
    }, { segS: 8, segT: 6, lift: 0.012 }));
  }
  const turretStencil = mergeStencils(tst);
  const stencil = mergeStencils([stencilPatch("bumperCode", flatSurface([0, 1.18, -3.1 - bev - 0.004], [0, 0, -1], [-1, 0, 0], 1.4, "bumperCode"), { lift: 0.004 })]);

  for (const g of [geo, turretGeo, gearGeo, stencil, turretStencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.turret = {
    geo: turretGeo, stencil: turretStencil,
    pivot: pivot.map((c) => c * S),
    muzzle: [0, 0.34 * S, 3.72 * S],
  };
  geo.userData.gear = gearGeo;
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  return geo;
}

// ── PT-76 (the other side's light tank) ──────────────────────────────────────
/**
 * The NVA's amphibious light tank — the armour that came down the trail and
 * overran Lang Vei. What makes it a PT-76 and not one of ours: a BOAT hull,
 * tall-sided and slab-flat, with a folded trim vane across the bow and two
 * water-jet outlets at the stern; a low truncated CONE of a turret set well
 * forward; the long 76 mm with its bore evacuator and a double-baffle muzzle
 * brake; six big road wheels a side and no return rollers. 6.9 m, 3.1 m wide
 * (real) — longer and wider than the Sheridan, and it reads that way from the
 * RTS camera, which is the point: you should know at a glance whose it is.
 *
 * Its green is the other side's: a flat dark khaki, not olive drab, with the
 * white hull number the NVA painted on the turret.
 *
 * userData: stencil, turret { geo, stencil, pivot, muzzle }, gear, length.
 */
export function buildPT76({ seed = 76 } = {}) {
  const R = rng(seed);
  const NVA = 0.30;                       // lighter, greyer green than US OD (0.16)
  const hull = [], turret = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const T = (geo, pos, mat, tone = 0.5, rot) => turret.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const HW = 1.06, DECK = 1.62;
  const pivot = [0, DECK, 0.55];          // the turret sits forward of centre

  // ── Hull: the boat. Flat bottom, a long sloped bow, vertical sides, a flat
  //    deck — the shape that lets it swim, and the one thing you cannot mistake.
  const shape = new THREE.Shape();
  shape.moveTo(-3.35, 0.30);
  shape.lineTo(2.55, 0.30);
  shape.lineTo(3.45, 0.86);               // the cutwater
  shape.lineTo(3.12, DECK);
  shape.lineTo(-3.4, DECK);
  shape.lineTo(-3.45, 0.62);
  shape.closePath();
  const bev = 0.05;
  const body = new THREE.ExtrudeGeometry(shape, { depth: 2 * HW - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2 });
  body.rotateY(-Math.PI / 2);
  body.computeBoundingBox();
  body.translate(-(body.boundingBox.min.x + body.boundingBox.max.x) / 2, 0, 0);
  P(indexed(body), [0, 0, 0], MAT.paint, NVA);
  const deckY = DECK + bev;

  // The trim vane, folded flat down the bow (raised, it is the swimming board).
  P(buildBox(1.9, 0.07, 1.25), [0, 1.3, 2.86], MAT.paint, NVA * 0.92, [0.52, 0, 0]);
  for (const sx of [-1, 1]) P(buildBox(0.05, 0.05, 0.5), [sx * 0.8, 1.42, 2.55], MAT.steel, 0.25, [0.52, 0, 0]);
  // Driver's hatch on the bow deck, with its periscopes.
  P(new THREE.CylinderGeometry(0.31, 0.33, 0.08, 14), [0, deckY + 0.04, 2.0], MAT.paint, NVA * 1.06);
  for (let k = 0; k < 3; k++) P(buildBox(0.13, 0.07, 0.07), [-0.22 + k * 0.22, deckY + 0.12, 2.18], MAT.steel, 0.04);
  // Headlight and its guard, on the left bow as the Soviets fitted it.
  P(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12).rotateX(Math.PI / 2), [-0.72, deckY + 0.14, 2.92], MAT.white, 0.4);
  P(new THREE.TorusGeometry(0.16, 0.02, 4, 10), [-0.72, deckY + 0.14, 2.96], MAT.steel, 0.2);
  // Engine deck: louvred grilles, fuel drums lashed at the stern, tow hooks.
  for (let k = 0; k < 7; k++) P(buildBox(1.5, 0.035, 0.07), [0, deckY + 0.02, -1.35 - k * 0.2], MAT.steel, 0.1);
  for (const sx of [-1, 1]) P(axleX(0.26, 0.9, 12).rotateY(Math.PI / 2), [sx * 0.62, deckY + 0.28, -2.75], MAT.paint, NVA * 0.85);
  for (const sx of [-1, 1]) P(buildBox(0.16, 0.16, 0.2), [sx * 0.62, 0.62, 3.2], MAT.steel, 0.3);
  // The water jets: two round outlets in the stern plate — the amphibian's tell.
  for (const sx of [-1, 1]) {
    P(new THREE.CylinderGeometry(0.26, 0.28, 0.16, 14).rotateX(Math.PI / 2), [sx * 0.62, 0.75, -3.45], MAT.steel, 0.12);
    P(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 14).rotateX(Math.PI / 2), [sx * 0.62, 0.75, -3.52], MAT.metal, 0.02);
  }
  // Spare track shoes and a tarp roll across the rear deck.
  for (let k = 0; k < 4; k++) P(buildBox(0.4, 0.06, 0.15), [-0.75 + k * 0.5, deckY + 0.05, -1.05], MAT.steel, 0.1);
  P(axleX(0.15, 1.5, 10), [0, deckY + 0.16, -3.05], MAT.canvas, 0.32);

  // ── Turret: a truncated cone, low and forward, with a single big hatch.
  T(new THREE.CylinderGeometry(0.88, 1.04, 0.56, 22), [0, 0.28, 0], MAT.paint, NVA * 1.04);
  T(new THREE.CylinderGeometry(0.86, 0.88, 0.07, 22), [0, 0.59, 0], MAT.paint, NVA * 1.1);
  T(new THREE.CylinderGeometry(0.34, 0.36, 0.07, 14), [-0.3, 0.64, -0.12], MAT.paint, NVA * 1.14);   // hatch
  T(buildBox(0.14, 0.1, 0.1), [0.34, 0.64, 0.3], MAT.steel, 0.06);                                    // periscope
  // Mantlet and the 76 mm: bore evacuator a third along, double-baffle brake.
  T(buildBox(0.66, 0.4, 0.3), [0, 0.3, 0.95], MAT.paint, NVA * 0.96);
  T(alongZ(0.115, 0.1, 0.55, 14), [0, 0.3, 1.25], MAT.paint, NVA * 0.9);
  T(alongZ(0.075, 0.07, 2.5, 14), [0, 0.3, 2.65], MAT.paint, NVA * 0.9);
  T(alongZ(0.13, 0.13, 0.34, 14), [0, 0.3, 2.05], MAT.paint, NVA * 0.95);                             // bore evacuator
  for (const z of [3.62, 3.86]) T(alongZ(0.12, 0.12, 0.12, 12), [0, 0.3, z], MAT.steel, 0.06);        // muzzle brake baffles
  T(alongZ(0.055, 0.055, 0.3, 10), [0, 0.3, 3.74], MAT.steel, 0.06);
  // Coaxial machine gun, to the gun's right.
  T(alongZ(0.035, 0.035, 0.7, 8), [0.26, 0.26, 1.5], MAT.steel, 0.06);
  // Grab rails round the turret, and the aerial at its left rear.
  for (const sx of [-1, 1]) for (const z of [0.25, -0.35]) {
    T(buildBox(0.04, 0.12, 0.34), [sx * 0.94, 0.36, z], MAT.steel, 0.24);
  }
  T(new THREE.CylinderGeometry(0.05, 0.06, 0.1, 8), [-0.72, 0.62, -0.6], MAT.steel, 0.25);
  T(new THREE.CylinderGeometry(0.008, 0.016, 2.6, 4).translate(0, 1.3, 0), [-0.72, 0.66, -0.6], MAT.steel, 0.3, [-0.1, 0, 0.05]);

  // ── Running gear: six road wheels a side, idler forward, sprocket at the
  //    back, and no return rollers — the top run rides on the wheels.
  const wheelR = 0.36, t = 0.05;
  const wheelsZ = [2.05, 1.23, 0.41, -0.41, -1.23, -2.05];
  const idler = { c: [2.85, 0.6], r: 0.3 }, sprocket = { c: [-2.9, 0.68], r: 0.32 };
  const path = trackPath({ front: idler, rear: sprocket, wheelsZ, wheelR, t });
  const wheel = (cy, cz, r) => [cy, cz, r, 1];
  for (const sx of [-1, 1]) {
    const xc = sx * (HW + 0.22), tw = 0.46;
    G(indexed(trackBand(path, xc, tw, t)), [0, 0, 0], MAT.steel, 0.05, undefined, [0, 0, 0, 2]);
    for (const z of wheelsZ) {
      const w = wheel(wheelR + t, z, wheelR);
      G(axleX(wheelR, 0.38, 18), [xc, wheelR + t, z], MAT.rubber, 0.5, undefined, w);
      G(axleX(0.24, 0.4, 14), [xc, wheelR + t, z], MAT.paint, NVA * 0.9, undefined, w);
      G(axleX(0.09, 0.43, 8), [xc, wheelR + t, z], MAT.steel, 0.3, undefined, w);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        G(buildBox(0.42, 0.04, 0.04), [xc, wheelR + t + Math.sin(a) * 0.15, z + Math.cos(a) * 0.15], MAT.steel, 0.35, undefined, w);
      }
    }
    const iw = wheel(idler.c[1], idler.c[0], idler.r);
    G(axleX(idler.r, 0.38, 16), [xc, idler.c[1], idler.c[0]], MAT.rubber, 0.45, undefined, iw);
    G(axleX(0.18, 0.4, 12), [xc, idler.c[1], idler.c[0]], MAT.paint, NVA * 0.9, undefined, iw);
    const sw = wheel(sprocket.c[1], sprocket.c[0], sprocket.r);
    G(axleX(sprocket.r - 0.03, 0.34, 16), [xc, sprocket.c[1], sprocket.c[0]], MAT.paint, NVA * 0.85, undefined, sw);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      G(buildBox(0.3, 0.07, 0.07), [xc, sprocket.c[1] + Math.sin(a) * (sprocket.r - 0.01), sprocket.c[0] + Math.cos(a) * (sprocket.r - 0.01)], MAT.steel, 0.25, [a, 0, 0], sw);
    }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const turretGeo = assemble(turret);
  bakeContactAO(turretGeo, { cell: 0.1, radius: 2, strength: 0.35, groundFade: 0, floor: 0.55 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: the white hull number on both turret cheeks, painted on the cone.
  const tst = [];
  for (const sx of [-1, 1]) {
    const nx = sx * 0.99, nz = -0.05;
    tst.push(stencilPatch("hullNumber", flatSurface([nx, 0.33, nz], [sx * 0.97, 0.24, 0], [0, 0, -sx], 0.78, "hullNumber"), { lift: 0.012 }));
  }
  const turretStencil = mergeStencils(tst);

  for (const g of [geo, turretGeo, gearGeo, turretStencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = null;
  geo.userData.turret = {
    geo: turretGeo, stencil: turretStencil,
    pivot: pivot.map((c) => c * S),
    muzzle: [0, 0.3 * S, 3.95 * S],
  };
  geo.userData.gear = gearGeo;
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  return geo;
}

// ── M35A2 "deuce-and-a-half" (engineer truck) ────────────────────────────────
/**
 * The 2½-ton truck that carried the war. Built as the builder's truck: what
 * makes it an M35 is the narrow hood between FLAT fenders with the headlights
 * on top in their brush guards, the vertical grille, the exhaust stack
 * standing beside the open cab under its canvas top, and six wheels on three
 * axles, duals behind. The bed carries an engineer's stores — timbers,
 * sandbags, coils of concertina, pickets, tools — under bare canvas bows.
 * 6.7 m long, 2.4 m wide (real).
 *
 * userData: stencil, gear (the wheels, rolling), length. No turret: unarmed.
 */
export function buildM35({ seed = 35 } = {}) {
  const R = rng(seed);
  const OD = 0.16, FATIGUE = 0.25;
  const hull = [], gear = [], spins = [];
  const P = (geo, pos, mat, tone = 0.5, rot) => hull.push({ geo, pos, mat, tone, rot });
  const G = (geo, pos, mat, tone, rot, spin) => { gear.push({ geo, pos, mat, tone, rot }); spins.push({ spin, n: geo.attributes.position.count }); };
  const WR = 0.54;
  const AXF = 2.3, AX1 = -0.95, AX2 = -2.25;

  // ── Chassis: frame rails, cross members, the fuel tank under the cab.
  for (const sx of [-1, 1]) P(buildBox(0.12, 0.26, 6.3), [sx * 0.46, 0.86, -0.05], MAT.paint, OD * 0.8);
  for (const z of [2.9, 1.2, -0.3, -1.6, -2.95]) P(buildBox(0.8, 0.12, 0.12), [0, 0.86, z], MAT.paint, OD * 0.8);
  P(alongZ(0.24, 0.24, 1.0, 14), [0.72, 0.95, 0.75], MAT.paint, OD * 0.9);                            // fuel tank
  for (const z of [AXF, AX1, AX2]) P(axleX(0.09, 1.7, 8), [0, WR, z], MAT.steel, 0.2);               // axles
  for (const z of [AX1, AX2]) P(new THREE.CylinderGeometry(0.28, 0.28, 0.3, 12).rotateX(Math.PI / 2), [0, WR, z], MAT.steel, 0.15);   // differentials

  // ── Front: the narrow hood (a loft, nearly square in section), flat fenders
  //    with their front edges turned down, the grille, bumper, winch.
  const HOOD = [
    { z: 3.18, cy: 1.42, w: 0.46, h: 0.3, hb: 0.42, n: 5 },
    { z: 3.1, cy: 1.44, w: 0.47, h: 0.33, hb: 0.42, n: 5 },
    { z: 1.45, cy: 1.47, w: 0.47, h: 0.36, hb: 0.42, n: 5 },
    { z: 1.35, cy: 1.47, w: 0.4, h: 0.3, hb: 0.36, n: 5 },
  ];
  P(loftSkin(HOOD, { segs: 28, sub: 3 }), [0, 0, 0], MAT.paint, OD * 1.02);
  for (const sx of [-1, 1]) {
    P(buildBox(0.66, 0.05, 1.75), [sx * 0.86, 1.22, 2.28], MAT.paint, OD);                            // fender top
    P(buildBox(0.64, 0.05, 0.4), [sx * 0.86, 1.08, 3.28], MAT.paint, OD, [0.65, 0, 0]);             // turned down in front (narrower: equal widths z-fought)
    P(buildBox(0.05, 0.42, 1.2), [sx * 1.17, 1.02, 2.28], MAT.paint, OD * 0.95);                     // fender skirt
    // Headlight on the fender, in its brush guard.
    P(new THREE.CylinderGeometry(0.11, 0.12, 0.14, 12).rotateX(Math.PI / 2), [sx * 0.85, 1.36, 3.05], MAT.steel, 0.15);
    P(new THREE.CylinderGeometry(0.095, 0.095, 0.02, 12).rotateX(Math.PI / 2), [sx * 0.85, 1.36, 3.13], MAT.white, 0.4);
    for (const dx of [-0.13, 0.13]) P(buildBox(0.025, 0.3, 0.025), [sx * 0.85 + dx, 1.4, 3.22], MAT.steel, 0.25);
    P(buildBox(0.3, 0.025, 0.025), [sx * 0.85, 1.56, 3.22], MAT.steel, 0.25);
  }
  for (let k = 0; k < 7; k++) P(buildBox(0.05, 0.72, 0.04), [-0.36 + k * 0.12, 1.37, 3.2], MAT.steel, 0.08);   // grille bars
  P(buildBox(0.9, 0.06, 0.05), [0, 1.73, 3.2], MAT.paint, OD);
  P(buildBox(2.3, 0.2, 0.14), [0, 0.8, 3.36], MAT.paint, OD * 0.9);                                  // bumper
  P(axleX(0.14, 0.7, 12), [0, 0.92, 3.3], MAT.steel, 0.2);                                           // winch drum
  for (const sx of [-1, 1]) P(buildBox(0.12, 0.14, 0.18), [sx * 0.8, 0.72, 3.45], MAT.steel, 0.3);  // tow shackles

  // ── Cab: open, a canvas top on its bows, half doors, the windshield up.
  // Cab parts all a little different in width: equal widths put their side
  // faces in one plane wherever they meet.
  P(buildBox(2.24, 0.06, 1.1), [0, 1.24, 0.72], MAT.paint, OD * 0.85);                              // cab floor
  P(buildBox(2.2, 0.55, 0.1), [0, 1.52, 1.3], MAT.paint, OD);                                        // cowl / dash
  P(buildBox(2.2, 0.08, 0.1), [0, 2.52, 1.28], MAT.paint, OD);                                       // windshield frame, top
  for (const sx of [-1, 0, 1]) P(buildBox(0.07, 0.72, 0.07), [sx * 1.07, 2.16, 1.28], MAT.paint, OD);
  for (const sx of [-1, 1]) P(buildBox(1.0, 0.68, 0.025), [sx * 0.54, 2.16, 1.27], MAT.steel, 0.12);   // glass
  P(buildBox(2.3, 0.05, 1.18), [0, 2.62, 0.72], MAT.canvas, 0.4);                                    // canvas top
  for (const sx of [-1, 1]) {
    P(buildBox(0.05, 0.62, 0.05), [sx * 1.12, 2.3, 0.2], MAT.steel, 0.25);                           // rear bow posts
    P(buildBox(0.05, 0.56, 0.95), [sx * 1.15, 1.54, 0.74], MAT.paint, OD * 1.02);                    // half door
    P(buildBox(0.3, 0.03, 0.03), [sx * 1.3, 1.95, 1.18], MAT.steel, 0.25);                           // mirror arm
    P(buildBox(0.03, 0.22, 0.14), [sx * 1.44, 1.95, 1.18], MAT.steel, 0.1);                          // mirror
  }
  P(buildBox(2.2, 0.9, 0.06), [0, 1.7, 0.16], MAT.paint, OD);                                        // cab back
  P(buildBox(2.0, 0.12, 0.45), [0, 1.52, 0.42], MAT.canvas, 0.3);                                    // bench seat
  P(buildBox(1.96, 0.45, 0.08), [0, 1.8, 0.22], MAT.canvas, 0.3);
  P(new THREE.TorusGeometry(0.2, 0.02, 5, 16).rotateX(Math.PI / 2 - 0.9), [0.55, 1.95, 1.0], MAT.steel, 0.05);   // steering wheel
  // The driver (left-hand drive: +X), helmet in its camouflage cover.
  P(buildBox(0.4, 0.5, 0.24), [0.55, 1.83, 0.52], MAT.canvas, FATIGUE);
  for (const dz of [-0.14, 0.14]) P(buildBox(0.09, 0.09, 0.36), [0.55 + dz, 1.95, 0.76], MAT.canvas, FATIGUE, [0.5, 0, 0]);
  P(new THREE.SphereGeometry(0.15, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.85, 1.1), [0.55, 2.22, 0.52], MAT.camo, 0.4);
  P(new THREE.CylinderGeometry(0.175, 0.175, 0.02, 14).scale(1, 1, 1.1), [0.55, 2.22, 0.52], MAT.camo, 0.35);
  P(new THREE.SphereGeometry(0.1, 8, 6), [0.55, 2.16, 0.52], MAT.canvas, 0.15);
  // The exhaust stack standing beside the cab, right side, with its guard.
  P(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 10), [-1.25, 2.0, 0.1], MAT.steel, 0.05);
  P(new THREE.CylinderGeometry(0.09, 0.09, 0.9, 10), [-1.25, 1.95, 0.1], MAT.steel, 0.12);
  // Spare wheel hung behind the cab.
  G(axleX(WR * 0.95, 0.28, 18).rotateY(Math.PI / 2), [0.3, 1.7, 0.02], MAT.rubber, 0.5, undefined, [0, 0, 0, 0]);

  // ── Cargo bed: floor, wooden slat sides on stakes, tailgate, canvas bows.
  const BZ0 = -0.1, BZ1 = -3.35, BZ = (BZ0 + BZ1) / 2, BL = BZ0 - BZ1;
  P(buildBox(2.36, 0.1, BL), [0, 1.22, BZ], MAT.paint, OD * 0.9);
  for (const sx of [-1, 1]) {
    for (let k = 0; k < 4; k++) P(buildBox(0.05, 0.12, BL - 0.1), [sx * 1.16, 1.4 + k * 0.17, BZ], MAT.timber, 0.3 + R() * 0.3);
    for (let k = 0; k < 6; k++) P(buildBox(0.08, 0.72, 0.08), [sx * 1.2, 1.62, BZ0 - 0.15 - k * (BL - 0.3) / 5], MAT.paint, OD * 0.9);
  }
  P(buildBox(2.2, 0.62, 0.06), [0, 1.58, BZ1 + 0.03], MAT.paint, OD * 0.95);                         // tailgate
  P(buildBox(2.2, 0.62, 0.06), [0, 1.58, BZ0 - 0.07], MAT.paint, OD * 0.95);                         // headboard
  for (let k = 0; k < 4; k++) {
    const z = BZ0 - 0.3 - k * (BL - 0.6) / 3;
    P(tube([[-1.2, 1.95, z], [-1.1, 2.55, z], [-0.6, 2.8, z], [0, 2.85, z], [0.6, 2.8, z], [1.1, 2.55, z], [1.2, 1.95, z]], 0.025, 16, 6), [0, 0, 0], MAT.steel, 0.25);
  }
  // The engineer's stores: timbers, sandbags, concertina coils, pickets,
  // a toolbox, jerry cans.
  for (let k = 0; k < 6; k++) P(buildBox(0.2, 0.12, 2.0), [-0.75 + (k % 3) * 0.22, 1.33 + Math.floor(k / 3) * 0.12, -1.3], MAT.timber, 0.35 + R() * 0.3);
  const bag = { length: 0.52, width: 0.30, height: 0.17, segU: 5, segV: 3 };
  P(buildSandbagWall({ length: 1.1, courses: 3, seed, bag }), [0.45, 1.27, -0.6], null);
  // Concertina coils, the second set off and tilted (identical rings at one x z-fought where they cross).
  for (let k = 0; k < 2; k++) P(new THREE.TorusGeometry(0.34, 0.05, 6, 18).rotateY(Math.PI / 2), [0.55 + k * 0.07, 1.65, -2.1 - k * 0.3], MAT.steel, 0.25, [0, k * 0.2, 0]);
  for (let k = 0; k < 5; k++) P(buildBox(0.05, 0.05, 1.6), [0.2 + k * 0.08, 1.3, -2.4], MAT.steel, 0.2);                                          // pickets
  P(buildBox(0.6, 0.3, 0.35), [-0.6, 1.42, -2.8], MAT.paint, 0.35);                                                                                // toolbox
  for (let k = 0; k < 2; k++) P(buildBox(0.17, 0.47, 0.34), [-0.95 + k * 0.2, 1.5, -2.2], MAT.paint, 0.42);

  // ── Rear: mudflaps, tail lights, the pintle hook.
  for (const sx of [-1, 1]) {
    P(buildBox(0.5, 0.4, 0.02), [sx * 0.95, 0.72, -2.95], MAT.rubber, 0.4);
    P(buildBox(0.12, 0.1, 0.05), [sx * 1.0, 1.1, -3.38], MAT.steel, 0.15);
  }
  P(buildBox(0.14, 0.14, 0.2), [0, 0.8, -3.38], MAT.steel, 0.3);

  // ── Wheels: singles in front, duals on both rear axles; they roll.
  const wheelAt = (x, z, w) => {
    const s = [WR, z, WR, 1];
    G(axleX(WR, w, 20), [x, WR, z], MAT.rubber, 0.5, undefined, s);
    G(axleX(0.3, w + 0.02, 14), [x, WR, z], MAT.paint, OD * 0.9, undefined, s);
    G(axleX(0.1, w + 0.05, 8), [x, WR, z], MAT.steel, 0.3, undefined, s);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      G(buildBox(w + 0.04, 0.04, 0.04), [x, WR + Math.sin(a) * 0.2, z + Math.cos(a) * 0.2], MAT.steel, 0.35, undefined, s);
    }
  };
  for (const sx of [-1, 1]) {
    wheelAt(sx * 0.98, AXF, 0.3);
    // Duals spaced so the two tyres' bolt rings do not share a plane.
    for (const z of [AX1, AX2]) { wheelAt(sx * 0.78, z, 0.27); wheelAt(sx * 1.12, z, 0.27); }
  }

  const geo = assemble(hull);
  bakeContactAO(geo, { cell: 0.12, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  const gearGeo = assemble(gear);
  bakeContactAO(gearGeo, { cell: 0.08, radius: 1, strength: 0.3, groundFade: 0.2, floor: 0.55 });

  // Markings: the star on both doors and on the hood, the bumper code.
  const st = [];
  for (const sx of [-1, 1]) st.push(stencilPatch("star", flatSurface([sx * 1.18, 1.55, 0.74], [sx, 0, 0], [0, 0, -sx], 0.46, "star"), { lift: 0.004 }));
  st.push(stencilPatch("star", flatSurface([0, 1.83 + 0.004, 2.2], [0, 1, 0], [-1, 0, 0], 0.6, "star"), { lift: 0.004 }));
  st.push(stencilPatch("bumperCode", flatSurface([0, 0.8, 3.43 + 0.004], [0, 0, 1], [1, 0, 0], 1.6, "bumperCode"), { lift: 0.004 }));
  const stencil = mergeStencils(st);

  for (const g of [geo, gearGeo, stencil]) g?.scale(S, S, S);
  packGear(gearGeo, spins);
  geo.computeBoundingBox();
  geo.userData.stencil = stencil;
  geo.userData.gear = gearGeo;
  geo.userData.length = geo.boundingBox.max.z - geo.boundingBox.min.z;
  return geo;
}
