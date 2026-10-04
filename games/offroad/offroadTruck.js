// THE OFF-ROAD TRUCK — a procedural expedition 4x4 in the spirit of the
// reference ("over the hill": a boxy Defender-like truck, flat colours, white
// roof, chunky tyres). Built from rounded boxes and lathed tyres, no textures.
//
// Every proportion and colour is in TRUCK_DEFAULTS: tune by passing overrides
// to buildOffroadTruck(), nothing else needs editing.
//
// Axes: +Z forward, +Y up, so +X is the truck's LEFT (three is right-handed;
// the same convention as the Apex Rush car), metres. The root's
// origin is on the GROUND, midway between the axles; the body sits on it at
// ride height. The physics (games/offroad/, to come) moves the root as the
// chassis and each wheel group for steer, spin and suspension travel.
//
// Draw calls: the body is merged into ONE mesh per material (paint, roof,
// trim, glass, lights, metal); each wheel is a group of 2 meshes (tyre, rim).
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const TRUCK_DEFAULTS = {
  // ── Proportions (m) ──
  wheelbase: 2.8,
  track: 1.62,            // wheel centre to wheel centre, across
  wheelRadius: 0.42,      // tyre outer radius
  tyreWidth: 0.32,
  rimRadius: 0.24,
  bodyWidth: 1.86,
  bodyLength: 4.45,
  clearance: 0.42,        // ground to the underside of the tub at rest
  tubHeight: 0.62,        // the lower body
  bonnetLength: 1.25,
  bonnetRise: 0.22,       // bonnet top above the tub
  cabinHeight: 0.86,
  cabinInset: 0.04,       // the cabin a little narrower than the tub
  bevel: 0.07,            // rounded-box radius: the soft stylised edges
  overhangFront: 0.72,    // front of body ahead of the front axle
  // ── Colours ──
  paint: "#d2552e",       // body
  roof: "#f1efe8",        // roof + window frames
  trim: "#2b2b2e",        // bumpers, arches, grille, rack
  glass: "#2e3a45",
  lights: "#fff3d6",
  tail: "#c8302a",
  metal: "#9aa0a6",
  tyre: "#262626",
  rim: "#d9d9d6",
  // ── Kit ──
  roofRack: true,
  snorkel: true,
  spareWheel: true,
  winch: true,
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** A part: geometry placed by position / rotation (radians) / scale. */
function place(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(1, 1, 1));
  g.applyMatrix4(_m);
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") g.deleteAttribute(k);
  return g;
}
// Rounding segments by size: the big panels get 3 (their soft edges ARE the
// look), small parts 1 — a rounded box costs ~2 x 6 x (2s+1)^2 triangles.
const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, Math.max(w, h, d) > 0.8 ? 3 : 1, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, seg = 20) => new THREE.CylinderGeometry(r0, r1, h, seg);

/**
 * A tyre: a lathed profile (rounded shoulders) with chunky tread blocks
 * around it, axis along X. Radius `R`, width `W`.
 */
function tyreGeometry(R, W, rimR) {
  const half = W / 2, sh = Math.min(0.07, W * 0.25);
  // Profile in (radius, x) — lathe spins it round Y; rotated to X after.
  const pts = [
    new THREE.Vector2(rimR * 0.98, -half * 0.86),
    new THREE.Vector2(R - sh, -half),
    new THREE.Vector2(R - sh * 0.25, -half + sh * 0.35),
    new THREE.Vector2(R - 0.035, -half + sh),
    new THREE.Vector2(R - 0.035, half - sh),
    new THREE.Vector2(R - sh * 0.25, half - sh * 0.35),
    new THREE.Vector2(R - sh, half),
    new THREE.Vector2(rimR * 0.98, half * 0.86),
  ];
  const parts = [place(new THREE.LatheGeometry(pts, 36), 0, 0, 0, 0, 0, Math.PI / 2)];
  // Tread: two staggered rows of blocks, 18 each — the chunky off-road read.
  const N = 18, bw = W * 0.4, bh = 0.045, bl = (2 * Math.PI * R) / N * 0.55;
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < N; i++) {
      const a = ((i + row * 0.5) / N) * Math.PI * 2;
      const xo = (row === 0 ? -1 : 1) * W * 0.22;
      const r = R - 0.035 + bh / 2 - 0.004;
      const g = box(bw, bh, bl);
      parts.push(place(g, xo, Math.sin(a) * r, Math.cos(a) * r, -a + Math.PI / 2, 0, 0));
    }
  }
  return mergeGeometries(parts);
}

/** A rim: a dish with five spokes and a hub, facing +X (outward) by default. */
function rimGeometry(rimR, W) {
  const parts = [];
  parts.push(place(cyl(rimR, rimR, W * 0.8, 24), 0, 0, 0, 0, 0, Math.PI / 2));
  // face plate inset, hub, spokes on the outer face
  const face = W * 0.4;
  parts.push(place(cyl(rimR * 0.86, rimR * 0.86, 0.02, 24), face - 0.01, 0, 0, 0, 0, Math.PI / 2));
  parts.push(place(cyl(rimR * 0.3, rimR * 0.34, 0.07, 14), face + 0.02, 0, 0, 0, 0, Math.PI / 2));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(place(box(0.03, rimR * 0.62, 0.075), face + 0.005, Math.sin(a) * rimR * 0.5, Math.cos(a) * rimR * 0.5, a, 0, 0));
  }
  return mergeGeometries(parts);
}

/**
 * Build the truck. Returns:
 *   root     THREE.Group — origin on the ground between the axles
 *   body     THREE.Group — the sprung mass (the physics may lean / pitch it)
 *   wheels   [{ name, group, spin, rest: Vector3, front, side }] FL, FR, RL, RR —
 *            `group` moves for suspension + steer (rotation.y), `spin` turns
 *            about X for rolling
 *   dims     the resolved parameters
 */
export function buildOffroadTruck(overrides = {}) {
  const P = { ...TRUCK_DEFAULTS, ...overrides };
  const mats = {
    paint: new THREE.MeshStandardMaterial({ color: P.paint, roughness: 0.55, metalness: 0.05 }),
    roof: new THREE.MeshStandardMaterial({ color: P.roof, roughness: 0.6 }),
    trim: new THREE.MeshStandardMaterial({ color: P.trim, roughness: 0.85 }),
    glass: new THREE.MeshStandardMaterial({ color: P.glass, roughness: 0.15, metalness: 0.3 }),
    lights: new THREE.MeshStandardMaterial({ color: P.lights, roughness: 0.3, emissive: P.lights, emissiveIntensity: 0.15 }),
    tail: new THREE.MeshStandardMaterial({ color: P.tail, roughness: 0.4, emissive: P.tail, emissiveIntensity: 0.1 }),
    metal: new THREE.MeshStandardMaterial({ color: P.metal, roughness: 0.4, metalness: 0.6 }),
    tyre: new THREE.MeshStandardMaterial({ color: P.tyre, roughness: 0.95 }),
    rim: new THREE.MeshStandardMaterial({ color: P.rim, roughness: 0.45, metalness: 0.3 }),
  };
  const parts = Object.fromEntries(Object.keys(mats).map((k) => [k, []]));
  const add = (mat, geo) => parts[mat].push(geo);

  const W = P.bodyWidth, L = P.bodyLength, hw = W / 2;
  const zFront = P.wheelbase / 2 + P.overhangFront, zBack = zFront - L;
  const yTub0 = P.clearance, yTub1 = P.clearance + P.tubHeight;
  const tubMidZ = (zFront + zBack) / 2;
  const zCabFront = zFront - P.bonnetLength, cabLen = zCabFront - zBack;
  const yCab1 = yTub1 + P.cabinHeight;
  const cw = W - 2 * P.cabinInset;

  // ── Body: tub, bonnet, cabin, roof ──
  add("paint", place(rbox(W, P.tubHeight, L, P.bevel), 0, (yTub0 + yTub1) / 2, tubMidZ));
  add("paint", place(rbox(W * 0.94, P.bonnetRise + 0.1, P.bonnetLength + 0.1, P.bevel), 0, yTub1 + (P.bonnetRise - 0.1) / 2, zFront - P.bonnetLength / 2 - 0.02));
  add("paint", place(rbox(cw, P.cabinHeight, cabLen, P.bevel), 0, yTub1 + P.cabinHeight / 2, zBack + cabLen / 2));
  // the white roof cap, overhanging a hair (the reference's signature)
  add("roof", place(rbox(cw + 0.04, 0.12, cabLen + 0.04, 0.05), 0, yCab1 + 0.02, zBack + cabLen / 2));
  // window pillars read as the roof colour: a thin white band under the cap
  add("roof", place(rbox(cw + 0.012, 0.07, cabLen + 0.012, 0.03), 0, yCab1 - 0.08, zBack + cabLen / 2));

  // ── Glass: windscreen, side windows (3 per side), rear window ──
  const gy = yTub1 + P.cabinHeight * 0.58, gh = P.cabinHeight * 0.48;
  add("glass", place(rbox(cw * 0.86, gh, 0.04, 0.02), 0, gy, zCabFront + 0.005, -0.12));
  add("glass", place(rbox(cw * 0.78, gh * 0.9, 0.04, 0.02), 0, gy, zBack - 0.005));
  const panes = 3, paneGap = 0.12, paneL = (cabLen - 0.35 - paneGap * (panes - 1)) / panes;
  for (const side of [-1, 1]) {
    for (let i = 0; i < panes; i++) {
      const z = zCabFront - 0.2 - paneL / 2 - i * (paneL + paneGap);
      add("glass", place(rbox(0.04, gh, paneL, 0.02), side * (cw / 2 + 0.003), gy, z));
    }
  }

  // ── Trim: bumpers, grille, wheel arches, sills, mirrors ──
  add("trim", place(rbox(W + 0.08, 0.2, 0.22, 0.04), 0, yTub0 + 0.08, zFront + 0.06));
  add("trim", place(rbox(W + 0.04, 0.2, 0.2, 0.04), 0, yTub0 + 0.08, zBack - 0.06));
  add("trim", place(rbox(W * 0.62, P.tubHeight * 0.55, 0.05, 0.02), 0, yTub1 - P.tubHeight * 0.38, zFront + 0.005));
  const yAxle = P.wheelRadius;
  for (const z of [P.wheelbase / 2, -P.wheelbase / 2]) {
    for (const side of [-1, 1]) {
      // a flared arch: an arc of short boxes round the top of the wheel
      const R = P.wheelRadius + 0.09;
      for (let k = 0; k <= 8; k++) {
        const a = Math.PI * (0.08 + 0.84 * (k / 8));
        add("trim", place(rbox(0.14, 0.07, 0.2, 0.02), side * (hw + 0.035), yAxle + Math.sin(a) * R, z + Math.cos(a) * R, -(a - Math.PI / 2)));
      }
    }
  }
  for (const side of [-1, 1]) {
    add("trim", place(rbox(0.1, 0.07, L * 0.42, 0.02), side * (hw + 0.02), yTub0 + 0.02, tubMidZ - 0.05));
    add("trim", place(rbox(0.04, 0.1, 0.16, 0.02), side * (cw / 2 + 0.12), yTub1 + 0.15, zCabFront - 0.05));
    add("trim", place(box(0.12, 0.03, 0.03), side * (cw / 2 + 0.05), yTub1 + 0.15, zCabFront - 0.05));
  }

  // ── Lights ──
  for (const side of [-1, 1]) {
    add("lights", place(cyl(0.085, 0.085, 0.05, 18), side * (W / 2 - 0.27), yTub1 - 0.17, zFront + 0.01, Math.PI / 2));
    add("trim", place(cyl(0.105, 0.105, 0.04, 18), side * (W / 2 - 0.27), yTub1 - 0.17, zFront - 0.005, Math.PI / 2));
    add("tail", place(rbox(0.1, 0.22, 0.04, 0.015), side * (W / 2 - 0.1), yTub1 - 0.2, zBack - 0.005));
  }

  // ── Kit: winch, roof rack, snorkel, spare wheel ──
  if (P.winch) {
    add("metal", place(cyl(0.07, 0.07, 0.5, 14), 0, yTub0 + 0.08, zFront + 0.2, 0, 0, Math.PI / 2));
    add("trim", place(rbox(0.7, 0.16, 0.12, 0.02), 0, yTub0 + 0.08, zFront + 0.18));
  }
  if (P.roofRack) {
    const ry = yCab1 + 0.2, rl = cabLen * 0.92, rw = cw * 0.96;
    for (const side of [-1, 1]) add("trim", place(box(0.04, 0.04, rl), side * rw / 2, ry, zBack + cabLen / 2));
    for (let i = 0; i < 5; i++) add("trim", place(box(rw, 0.03, 0.03), 0, ry, zBack + cabLen / 2 - rl / 2 + (i / 4) * rl));
    for (const z of [zBack + cabLen * 0.15, zBack + cabLen * 0.85]) for (const side of [-1, 1]) add("trim", place(box(0.03, 0.14, 0.03), side * rw / 2, ry - 0.08, z));
    // a jerrycan and a duffel on the rack
    add("paint", place(rbox(0.36, 0.22, 0.5, 0.03), -rw * 0.22, ry + 0.13, zBack + cabLen * 0.35));
    add("trim", place(rbox(0.5, 0.2, 0.34, 0.08), rw * 0.18, ry + 0.12, zBack + cabLen * 0.62));
  }
  if (P.snorkel) {
    const sx = hw + 0.06, sz = zCabFront + 0.05;
    add("trim", place(cyl(0.05, 0.05, P.cabinHeight + 0.15, 12), sx, yTub1 + (P.cabinHeight + 0.15) / 2, sz, -0.1));
    add("trim", place(rbox(0.12, 0.1, 0.16, 0.03), sx, yCab1 + 0.1, sz + 0.04));
  }

  // Merge each material's parts into one mesh: the sprung body.
  const body = new THREE.Group();
  body.name = "TruckBody";
  for (const [k, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(list), mats[k]);
    mesh.name = `Truck:${k}`;
    mesh.castShadow = mesh.receiveShadow = true;
    body.add(mesh);
  }

  // ── Wheels (and the spare, which hangs on the body) ──
  const tyreGeo = tyreGeometry(P.wheelRadius, P.tyreWidth, P.rimRadius);
  const rimGeo = rimGeometry(P.rimRadius, P.tyreWidth);
  const makeWheel = (outward) => {
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, mats.tyre);
    const rim = new THREE.Mesh(rimGeo, mats.rim);
    rim.scale.x = outward;   // the spoked face looks outward on both sides
    tyre.castShadow = rim.castShadow = true;
    tyre.receiveShadow = rim.receiveShadow = true;
    spin.add(tyre, rim);
    return spin;
  };
  if (P.spareWheel) {
    const spare = makeWheel(1);
    spare.rotation.y = Math.PI / 2;     // its face on the rear door, looking back
    spare.position.set(0.1, yTub1 + 0.05, zBack - P.tyreWidth / 2 - 0.03);
    spare.scale.setScalar(0.92);
    body.add(spare);
  }
  const root = new THREE.Group();
  root.name = "OffroadTruck";
  root.add(body);
  const wheels = [];
  // side +1 = +X = the LEFT of the truck
  for (const [name, front, side] of [["FL", true, 1], ["FR", true, -1], ["RL", false, 1], ["RR", false, -1]]) {
    const group = new THREE.Group();
    group.name = `Wheel${name}`;
    const rest = new THREE.Vector3(side * P.track / 2, P.wheelRadius, (front ? 1 : -1) * P.wheelbase / 2);
    group.position.copy(rest);
    const spin = makeWheel(side);
    group.add(spin);
    root.add(group);
    wheels.push({ name, group, spin, rest, front, side });
  }

  let tris = 0;
  root.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return { root, body, wheels, dims: { ...P, zFront, zBack, roofY: yCab1 + 0.08, triangles: Math.round(tris) }, materials: mats };
}
