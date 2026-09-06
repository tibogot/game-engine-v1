// ============================================================================
// CITY FURNITURE — what makes a street a street rather than a corridor.
//
// Parked cars along the kerbs, trees on the pavements, traffic lights at every
// junction, pedestrian guardrails by the crossings. Each kind is ONE
// InstancedMesh — five draws for the whole city — placed deterministically on
// the same block grid the streets and the lamps use, so nothing has to be
// authored and nothing moves when the city is rebuilt or the corridor changes.
//
// ── WHAT IS DELIBERATELY CHEAP ───────────────────────────────────────────────
//
// The car is a body box and a cabin box, ~40 triangles. From the chase camera
// at 40 m it is a coloured block the right size in the right place with a
// shadow under it, which is all a parked car IS from up there. Trees are a
// trunk and a one-subdivision icosphere. No textures anywhere: per-instance
// tint rides `instanceColor`, which NodeMaterial multiplies into the colour
// slot for free.
//
// Counts scale with kerb length: a 2.4 km city is ~55 km of kerb, which lands
// around 3k cars and 3k trees. That is ~600k triangles across five draws —
// vertex work, and the vertex stage is nowhere near the bottleneck here.
// ============================================================================
import * as THREE from "three";
import { Fn, float, vec3, uniform, positionWorld, smoothstep, mix } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const FURNITURE_DEFAULTS = {
  /** Parked cars: station pitch along the kerb, occupancy, and how far the
   *  parking lane sits in from the kerb. */
  carPitch: 7.2,
  carOccupancy: 0.5,
  carInset: 1.35,
  /** Trees on the pavement: pitch, distance in from the kerb, canopy size. */
  treePitch: 18,
  treeInset: 2.3,
  treeOccupancy: 0.8,
  treeHeight: 4.8,
  treeCanopy: 2.6,
  /** Pedestrian guardrail either side of every crossing, metres. */
  railRun: 9,
  /** Traffic lights: one per junction corner. */
  lightHeight: 4.6,
  /** Keep clear of the crossings at block ends, metres. */
  crossClear: 6.5,
  nightAmount: 0,
};

/** Deterministic per-station hash. */
function h2(a, b, k) {
  let x = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(k | 0, 83492791)) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0; x = Math.imul(x, 3266489917) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A box sitting on y = 0 with its centre at (x, z). */
function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

/** Real cars are mostly white, silver, grey and black. Weighted. */
const CAR_PALETTE = [
  [0xc9cbcf, 2.5], [0x9a9ea3, 3], [0x5e6266, 2.5], [0x202225, 3],
  [0x6e1c1c, 1], [0x1d2b4f, 1], [0x2b3f2a, 0.5], [0x7a5a34, 0.5],
];
function pickCarColor(r) {
  const total = CAR_PALETTE.reduce((s, [, w]) => s + w, 0);
  let t = r * total;
  for (const [hex, w] of CAR_PALETTE) { if ((t -= w) <= 0) return hex; }
  return CAR_PALETTE[0][0];
}

/**
 * @param {object} o
 * @param {object} o.P            city params (grid, extent, centre, groundY)
 * @param {number} o.originCellX
 * @param {number} o.originCellZ
 * @param {object} [o.params]
 */
export function createCityFurniture({ P, originCellX, originCellZ, params: overrides = {} }) {
  const F = { ...FURNITURE_DEFAULTS, ...overrides };
  const group = new THREE.Group();
  group.name = "CityFurniture";

  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const streetW = Math.max(P.streetLots * P.lotSize, 1);
  const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
  const half = P.extent;
  const gy = P.groundY;
  const inside = (x, z) => Math.abs(x - P.centerX) <= half && Math.abs(z - P.centerZ) <= half;

  const uNight = uniform(F.nightAmount);

  // ── Geometry ───────────────────────────────────────────────────────────────
  // THE CAR IS A SIDE PROFILE, not two boxes. A box read as a box even from
  // 40 m — the eye keys on the hood/windscreen/roof/trunk silhouette, so that
  // is what is modelled: one extruded outline across the body width, four
  // wheel cylinders. VERTEX COLOURS split it into paint / glass / rubber, and
  // `instanceColor` multiplies all three, so a white car gets grey wheels and
  // a black car black ones, from one draw. ~150 triangles.
  const carGeo = (() => {
    const L = 4.5, W = 1.82;
    // (z along the car, y up) — nose at −z. Sills sit 0.32 above the road.
    const pts = [
      [-2.25, 0.32], [-2.25, 0.62], [-2.05, 0.72], [-0.95, 0.80],   // bumper, hood
      [-0.35, 1.32], [0.75, 1.36],                                   // windscreen, roof
      [1.45, 1.10], [2.05, 0.95], [2.25, 0.70], [2.25, 0.32],        // rear glass, trunk, tail
    ];
    const shape = new THREE.Shape();
    shape.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
    shape.closePath();
    const body = new THREE.ExtrudeGeometry(shape, { depth: W, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.08, bevelSegments: 1, steps: 1 });
    body.rotateY(Math.PI / 2);          // extrusion axis (z) → across the car (x)
    body.translate(-W / 2, 0, 0);
    // Glass band: vertices between the belt line and the roof, on the cabin.
    const bp = body.getAttribute("position");
    const bc = new Float32Array(bp.count * 3);
    for (let i = 0; i < bp.count; i++) {
      const y = bp.getY(i), z = bp.getZ(i);
      const glass = y > 0.86 && y < 1.34 && z > -0.55 && z < 1.65;
      const k = glass ? 0.16 : 1.0;   // glass: dark, tinted by the paint only faintly
      bc[i * 3] = k; bc[i * 3 + 1] = glass ? 0.18 : 1.0; bc[i * 3 + 2] = glass ? 0.22 : 1.0;
    }
    body.setAttribute("color", new THREE.BufferAttribute(bc, 3));
    const wheels = [];
    for (const [x, z] of [[-0.86, -1.45], [0.86, -1.45], [-0.86, 1.45], [0.86, 1.45]]) {
      // ExtrudeGeometry is NON-indexed and CylinderGeometry is indexed, and
      // mergeGeometries returns null (silently) for a mixed set — the trap
      // proj_merge_geometries_gotchas records. Everything goes non-indexed.
      const w = new THREE.CylinderGeometry(0.33, 0.33, 0.24, 8, 1, false).toNonIndexed();
      w.rotateZ(Math.PI / 2);
      w.translate(x, 0.33, z);
      const wc = new Float32Array(w.getAttribute("position").count * 3).fill(0.05);
      w.setAttribute("color", new THREE.BufferAttribute(wc, 3));
      wheels.push(w);
    }
    // All non-indexed, all position/normal/uv/color — merge needs identical
    // layouts AND identical indexing.
    const g = mergeGeometries([body, ...wheels], false);
    body.dispose(); wheels.forEach((w) => w.dispose());
    return g;
  })();
  const trunkGeo = box(0.24, F.treeHeight * 0.55, 0.24);
  // A crown, not a lollipop: two icospheres, subdivided, with every vertex
  // pushed in or out by a hash so the silhouette is ragged, and the second
  // crown offset so no tree is symmetric.
  const canopyGeo = (() => {
    const crown = (r, ox, oy, oz, seed) => {
      const g = new THREE.IcosahedronGeometry(r, 1);
      const p = g.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = 0.82 + 0.36 * h2(Math.round(x * 37 + seed), Math.round(y * 41), Math.round(z * 43));
        p.setXYZ(i, x * n + ox, y * n * 0.78 + oy, z * n + oz);
      }
      g.computeVertexNormals();
      return g;
    };
    const base = F.treeHeight * 0.55 + F.treeCanopy * 0.62;
    const a = crown(F.treeCanopy, 0, base, 0, 1);
    const b = crown(F.treeCanopy * 0.72, F.treeCanopy * 0.45, base + F.treeCanopy * 0.35, -F.treeCanopy * 0.3, 7);
    const g = mergeGeometries([a, b], false);
    a.dispose(); b.dispose();
    return g;
  })();
  const lightGeo = mergeGeometries([
    box(0.16, F.lightHeight, 0.16),                       // pole
    box(0.34, 1.05, 0.30, 0, F.lightHeight - 0.2, 0.12),  // head
  ], false);
  const railGeo = mergeGeometries([
    box(0.06, 1.05, 0.06, -0.95, 0, 0), box(0.06, 1.05, 0.06, 0.95, 0, 0),   // posts
    box(2.0, 0.05, 0.05, 0, 1.0, 0), box(2.0, 0.05, 0.05, 0, 0.55, 0),        // rails
  ], false);
  for (const g of [carGeo, trunkGeo, canopyGeo, lightGeo, railGeo]) if (!g) throw new Error("[CityFurniture] merge returned null");

  // ── Materials ──────────────────────────────────────────────────────────────
  // Plain colours: NodeMaterial multiplies `instanceColor` into the slot, so
  // per-instance tint costs nothing.
  const carMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.45, vertexColors: true });
  carMat.name = "CityCars";
  const trunkMat = new THREE.MeshStandardNodeMaterial({ color: 0x3b2c20, roughness: 0.95 });
  trunkMat.name = "CityTrunks";
  const canopyMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95 });
  canopyMat.name = "CityCanopies";
  const railMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3d42, roughness: 0.45, metalness: 0.7 });
  railMat.name = "CityRails";
  // Traffic light: dark pole and head; the lens glows in the instance's colour,
  // brighter at night, and into the bloom MRT.
  const lightMat = new THREE.MeshStandardNodeMaterial({ color: 0x1a1c1f, roughness: 0.5, metalness: 0.5 });
  lightMat.name = "CityTrafficLights";
  const lensGlow = Fn(() => {
    const y = positionWorld.y.sub(uniform(gy));
    const isHead = smoothstep(F.lightHeight - 0.55, F.lightHeight - 0.35, y);
    return vec3(1.0).mul(isHead).mul(mix(float(1.2), float(3.5), uNight));
  })();
  // instanceColor multiplies colorNode, not emissiveNode — so the lens colour
  // is carried by making the emissive read the tinted colour slot.
  lightMat.emissiveNode = lensGlow;
  applyBloomMRT(lightMat, lensGlow.mul(uNight));

  // ── Placement ──────────────────────────────────────────────────────────────
  const cars = [], trees = [], lights = [], rails = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);
  const place = (list, x, z, yaw, extra) => {
    if (!inside(x, z)) return;
    _p.set(x, gy, z);
    _q.setFromAxisAngle(UP, yaw);
    list.push({ m: _m.compose(_p, _q, _s).clone(), ...extra });
  };

  const kMin = Math.floor((-half - ox) / pitch) - 1, kMax = Math.ceil((half - ox) / pitch) + 1;
  for (let kx = kMin; kx <= kMax; kx++) {
    for (let kz = kMin; kz <= kMax; kz++) {
      // One street run along Z and one along X per period cell; each has two
      // kerbs, and each kerb runs the length of one block (blockW), stopping
      // short of the crossings at both ends.
      const runs = [
        // [axis, fixed coordinate of the -side kerb, run start, run end]
        ["z", ox + kx * pitch + blockW, oz + kz * pitch, oz + kz * pitch + blockW],
        ["x", oz + kz * pitch + blockW, ox + kx * pitch, ox + kx * pitch + blockW],
      ];
      for (const [axis, kerb0, a0, a1] of runs) {
        for (let side = 0; side < 2; side++) {
          const dir = side === 0 ? -1 : 1;                 // which way "into the block" is
          const kerb = side === 0 ? kerb0 : kerb0 + streetW;
          const carAcross = kerb - dir * F.carInset;        // into the road
          const treeAcross = kerb + dir * F.treeInset;      // onto the pavement
          const yawAlong = axis === "z" ? 0 : Math.PI / 2;
          const seedA = Math.round(kerb * 3), seedB = Math.round(a0);
          const at = (across, along) => axis === "z" ? [across, along] : [along, across];

          // Parked cars, in the lane by the kerb, clear of the crossings.
          for (let s = a0 + F.crossClear + F.carPitch * 0.5; s < a1 - F.crossClear; s += F.carPitch) {
            const st = Math.round(s / F.carPitch);
            if (h2(seedA, st, 1) > F.carOccupancy) continue;
            const jitter = (h2(seedA, st, 2) - 0.5) * 0.9;
            const [x, z] = at(carAcross, s + jitter);
            const flip = h2(seedA, st, 3) < 0.5 ? 0 : Math.PI;
            place(cars, x, z, yawAlong + flip + (h2(seedA, st, 4) - 0.5) * 0.06, { color: pickCarColor(h2(seedA, st, 5)) });
          }
          // Trees on the pavement, staggered off the lamp stations.
          for (let s = a0 + F.crossClear + 4; s < a1 - F.crossClear; s += F.treePitch) {
            const st = Math.round(s / F.treePitch);
            if (h2(seedA, st, 11) > F.treeOccupancy) continue;
            const [x, z] = at(treeAcross, s);
            const scale = 0.85 + h2(seedA, st, 12) * 0.35;
            const green = new THREE.Color().setHSL(0.26 + (h2(seedA, st, 13) - 0.5) * 0.07, 0.34, 0.16 + h2(seedA, st, 14) * 0.09);
            place(trees, x, z, h2(seedA, st, 15) * 6.283, { color: green.getHex(), scale });
          }
          // Guardrail either side of each crossing, on the kerb line.
          for (const end of [a0, a1]) {
            const from = end === a0 ? a0 + 1.2 : a1 - F.railRun - 1.2;
            for (let s = from; s < from + F.railRun; s += 2.0) {
              const [x, z] = at(kerb + dir * 0.25, s + 1.0);
              place(rails, x, z, yawAlong, {});
            }
          }
          // A traffic light on the corner at each end of the run, facing the road.
          for (const end of [a0, a1]) {
            const s = end === a0 ? a0 - 1.0 : a1 + 1.0;
            const [x, z] = at(kerb + dir * 0.9, s);
            const phase = h2(Math.round(x), Math.round(z), 21);
            const lens = phase < 0.45 ? 0xff2a1a : phase < 0.55 ? 0xffb020 : 0x35ff6a;
            place(lights, x, z, yawAlong + (end === a0 ? Math.PI : 0), { color: lens });
          }
        }
      }
    }
  }

  // ── Meshes ─────────────────────────────────────────────────────────────────
  const _c = new THREE.Color();
  function instanced(list, geo, mat, name, { shadows = true } = {}) {
    if (!list.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    im.name = name;
    im.frustumCulled = false;
    im.castShadow = shadows;
    im.receiveShadow = true;
    list.forEach((e, i) => {
      if (e.scale && e.scale !== 1 && !e.scaled) { _s.set(e.scale, e.scale, e.scale); e.m.scale(_s); _s.set(1, 1, 1); e.scaled = true; }
      im.setMatrixAt(i, e.m);
      if (e.color != null) im.setColorAt(i, _c.set(e.color));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
    return im;
  }
  const carMesh = instanced(cars, carGeo, carMat, "CityCars");
  const trunkMesh = instanced(trees, trunkGeo, trunkMat, "CityTrunks", { shadows: false });
  const canopyMesh = instanced(trees, canopyGeo, canopyMat, "CityCanopies");
  const lightMesh = instanced(lights, lightGeo, lightMat, "CityTrafficLights", { shadows: false });
  const railMesh = instanced(rails, railGeo, railMat, "CityRails", { shadows: false });

  // ── DISTANCE CULL ──────────────────────────────────────────────────────────
  // Every kind is one mesh with `frustumCulled = false`, so without this the
  // whole city's furniture draws every frame from anywhere — measured 6.7 M
  // triangles from street level. A car 800 m away is under a pixel. So, on
  // the city's LOD timer, each list is partitioned near-first and `count` is
  // cut at the kind's range. A partial sort of ~7k items at 5 Hz is nothing;
  // the re-upload is ~0.4 MB per kind per tick.
  const kinds = [
    { mesh: carMesh, list: cars, range: 420 },
    { mesh: trunkMesh, list: trees, range: 650 },
    { mesh: canopyMesh, list: trees, range: 650 },
    { mesh: lightMesh, list: lights, range: 380 },
    { mesh: railMesh, list: rails, range: 260 },
  ];
  const _pos = new THREE.Vector3();
  for (const e of [...cars, ...trees, ...lights, ...rails]) { _pos.setFromMatrixPosition(e.m); e.x = _pos.x; e.z = _pos.z; }
  function applyLod(cam) {
    for (const k of kinds) {
      if (!k.mesh) continue;
      const r2 = k.range * k.range;
      let n = 0;
      // Partition in place: near instances to the front.
      const list = k.list;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const dx = e.x - cam.x, dz = e.z - cam.z;
        if (dx * dx + dz * dz < r2) { if (i !== n) { const t = list[n]; list[n] = e; list[i] = t; } n++; }
      }
      for (let i = 0; i < n; i++) {
        k.mesh.setMatrixAt(i, list[i].m);
        if (list[i].color != null && k.mesh.instanceColor) k.mesh.setColorAt(i, _c.set(list[i].color));
      }
      k.mesh.count = n;
      k.mesh.instanceMatrix.needsUpdate = true;
      if (k.mesh.instanceColor) k.mesh.instanceColor.needsUpdate = true;
    }
  }

  return {
    group,
    params: F,
    stats: { cars: cars.length, trees: trees.length, lights: lights.length, rails: rails.length },
    setNight(n) { uNight.value = Math.max(0, Math.min(1, n || 0)); },
    /** Cut each kind at its range from the camera. Call on the LOD timer. */
    applyLod,
    dispose() {
      for (const m of [carMesh, trunkMesh, canopyMesh, lightMesh, railMesh]) { if (!m) continue; group.remove(m); m.dispose(); }
      for (const g of [carGeo, trunkGeo, canopyGeo, lightGeo, railGeo]) g.dispose();
      for (const m of [carMat, trunkMat, canopyMat, lightMat, railMat]) m.dispose();
    },
  };
}
