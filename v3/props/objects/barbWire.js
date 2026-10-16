import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";

/**
 * Procedural concertina / barbed wire obstacle along a spline.
 *
 * A ground obstacle, so unlike the bridges it CONFORMS to the terrain: the
 * coil centreline re-samples ground height at every ring. The wire is a
 * true helix swept along the path (square cross-section — at 1cm nobody can
 * tell), with per-ring rust patches baked into vertex colors, crossed barb
 * spikes at intervals, and optional metal picket stakes pinning the run
 * down. Stacking modes: single coil, double row, or the classic 2+1
 * pyramid.
 *
 * Everything merges into ONE vertex-colored mesh (1 draw call, 1 shadow
 * caster). Barbs dominate the vertex budget — thin the spacing slider for
 * huge RTS-scale runs.
 */

export const BARB_WIRE_DEFAULTS = {
  coilRadius: 0.45,
  coilPitch: 0.22, // metres of path per full revolution
  segsPerRev: 10, // rings per revolution (wire smoothness)
  squash: 0.85, // vertical squash — coils sag under their own weight
  radiusJitter: 0.05, // per-ring radius wobble (battle-worn look)

  stacking: "single", // "single" | "double" | "pyramid" (2+1)

  wireRadius: 0.01,

  barbs: true,
  barbSpacing: 0.7, // metres of WIRE (not path) between barbs
  barbSize: 0.055,

  stakes: true,
  stakeSpacing: 4, // metres between pickets
  stakeLean: 4, // random lean in degrees
  stakeWidth: 0.05,

  wireColor: "#9aa0a6", // galvanized steel
  rustColor: "#6e4a33",
  rust: 0.35, // 0..1 — how rusty the run is
  stakeColor: "#4a4038",
  roughness: 0.55,
  metalness: 0.6,
  seed: 3,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Sweep a square cross-section along world-space ring centres, with a color
// baked PER RING (rust patches). Frames give the cross-section orientation.
function sweepWire(centers, frames, r, ringColors) {
  const rings = centers.length;
  const pos = new Float32Array(rings * 4 * 3);
  const col = new Float32Array(rings * 4 * 3);
  const idx = [];
  const rt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const v = new THREE.Vector3();

  let o = 0;
  for (let i = 0; i < rings; i++) {
    const c = centers[i];
    rt.copy(frames[i].right);
    up.copy(frames[i].up);
    const cr = ringColors[i * 3];
    const cg = ringColors[i * 3 + 1];
    const cb = ringColors[i * 3 + 2];
    const corners = [
      [r, r],
      [-r, r],
      [-r, -r],
      [r, -r],
    ];
    for (const [a, b] of corners) {
      v.copy(c).addScaledVector(rt, a).addScaledVector(up, b);
      col[o] = cr;
      pos[o++] = v.x;
      col[o] = cg;
      pos[o++] = v.y;
      col[o] = cb;
      pos[o++] = v.z;
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const A = i * 4 + k;
      const B = i * 4 + k2;
      const C = (i + 1) * 4 + k2;
      const D = (i + 1) * 4 + k;
      idx.push(A, B, C, A, C, D);
    }
  }
  idx.push(0, 2, 1, 0, 3, 2);
  const last = (rings - 1) * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// Bake a solid color into every vertex of a geometry (in-place).
function bakeColor(geo, color) {
  const n = geo.attributes.position.count;
  const buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = color.r;
    buf[i * 3 + 1] = color.g;
    buf[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(buf, 3));
  return geo;
}

// ── builder ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x,y,z}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildBarbWireMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...BARB_WIRE_DEFAULTS, ...params };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();

  const group = new THREE.Group();
  group.name = "BarbWire";

  const allGeos = [];
  const _c = new THREE.Color();
  const wireCol = new THREE.Color(p.wireColor);
  const rustCol = new THREE.Color(p.rustColor);

  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");
  const m = new THREE.Matrix4();
  const rot = new THREE.Matrix4();
  const eul = new THREE.Euler();
  const scl = new THREE.Vector3();
  const deg = Math.PI / 180;

  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };

  // path frame (right = horizontal, perpendicular to travel)
  const frameAt = (t) => {
    const e = 0.002;
    const a = curve.getPointAt(THREE.MathUtils.clamp(t - e, 0, 1));
    const b = curve.getPointAt(THREE.MathUtils.clamp(t + e, 0, 1));
    const fwd = b.sub(a).setY(0).normalize();
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
    const right = new THREE.Vector3().crossVectors(WORLD_UP, fwd).normalize();
    return { right, fwd };
  };

  // coil rows by stacking mode: [lateral offset (× coilRadius), vertical
  // offset (× coil height)]
  const rows =
    p.stacking === "double"
      ? [
          [-0.95, 0],
          [0.95, 0],
        ]
      : p.stacking === "pyramid"
        ? [
            [-0.95, 0],
            [0.95, 0],
            [0, 0.82],
          ]
        : [[0, 0]];

  const coilH = 2 * p.coilRadius * p.squash;
  const segsRev = Math.max(6, p.segsPerRev | 0);
  const revs = Math.max(2, Math.floor(length / Math.max(0.05, p.coilPitch)));
  const rings = Math.min(24000, revs * segsRev);
  const wirePerRing = (2 * Math.PI * p.coilRadius) / segsRev; // approx metres of wire per ring
  const barbEveryRings = Math.max(1, Math.round(p.barbSpacing / wirePerRing));

  const barbT = p.wireRadius * 1.7;
  const barbDir = new THREE.Vector3();
  const barbX = new THREE.Vector3();
  const barbY = new THREE.Vector3();

  for (let row = 0; row < rows.length; row++) {
    const [latK, vertK] = rows[row];
    const phase = seededRand(p.seed, row * 131 + 17) * Math.PI * 2;

    const centers = [];
    const frames = [];
    const ringColors = new Float32Array((rings + 1) * 3);

    for (let k = 0; k <= rings; k++) {
      const t = k / rings;
      const f = frameAt(t);
      const c = curve.getPointAt(t);
      const gY = getWorldHeight(c.x, c.z);
      const jit =
        1 + (seededRand(p.seed, row * 7919 + (k >> 2)) - 0.5) * 2 * p.radiusJitter;
      const r = p.coilRadius * jit;
      const th = phase + (k / segsRev) * Math.PI * 2;

      const cx = c.x + f.right.x * (latK * p.coilRadius + Math.cos(th) * r);
      const cz = c.z + f.right.z * (latK * p.coilRadius + Math.cos(th) * r);
      const cy =
        gY + coilH * 0.5 + vertK * coilH + Math.sin(th) * r * p.squash;
      centers.push(new THREE.Vector3(cx, cy, cz));
      frames.push({ right: f.right, up: WORLD_UP });

      // rust in patches (every ~8 rings) + a little per-ring flicker
      const patch = seededRand(p.seed, row * 517 + (k >> 3));
      const rustAmt =
        Math.pow(patch, 1.5) * p.rust +
        (seededRand(p.seed, row * 613 + k) - 0.5) * 0.06;
      _c.copy(wireCol).lerp(rustCol, THREE.MathUtils.clamp(rustAmt, 0, 1));
      ringColors[k * 3] = _c.r;
      ringColors[k * 3 + 1] = _c.g;
      ringColors[k * 3 + 2] = _c.b;

      // crossed barb spikes, spaced along the WIRE length
      if (p.barbs && k > 0 && k < rings && k % barbEveryRings === 0) {
        barbDir.subVectors(centers[k], centers[k - 1]).normalize();
        barbX.crossVectors(barbDir, WORLD_UP);
        if (barbX.lengthSq() < 1e-9) barbX.copy(f.right);
        barbX.normalize();
        barbY.crossVectors(barbDir, barbX).normalize();
        _c.copy(wireCol).lerp(rustCol, Math.pow(patch, 1.5) * p.rust);
        for (const a of [45, -45]) {
          scl.set(p.barbSize, barbT, barbT);
          m.makeBasis(barbX, barbY, barbDir)
            .multiply(rot.makeRotationFromEuler(eul.set(0, 0, a * deg)))
            .scale(scl)
            .setPosition(centers[k]);
          pushBox(m, _c);
        }
      }
    }

    allGeos.push(sweepWire(centers, frames, p.wireRadius, ringColors));
  }

  // ── picket stakes pinning the run down ──
  if (p.stakes) {
    const stakeCol = new THREE.Color(p.stakeColor);
    const n = Math.max(2, Math.floor(length / Math.max(1, p.stakeSpacing)) + 1);
    const topH = p.stacking === "pyramid" ? coilH * 1.8 : coilH;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const f = frameAt(t);
      const c = curve.getPointAt(t);
      const gY = getWorldHeight(c.x, c.z);
      const sink = 0.3;
      const h = topH * 0.98 + sink;
      const leanA = (seededRand(p.seed, i * 11 + 5) - 0.5) * 2 * p.stakeLean * deg;
      const leanB = (seededRand(p.seed, i * 11 + 6) - 0.5) * 2 * p.stakeLean * deg;
      scl.set(p.stakeWidth, h, p.stakeWidth * 1.5);
      m.makeRotationFromEuler(eul.set(leanA, 0, leanB))
        .scale(scl)
        .setPosition(c.x, gY - sink + h * 0.5, c.z);
      const v = (seededRand(p.seed, i * 11 + 7) - 0.5) * 0.15;
      _c.copy(stakeCol).offsetHSL(0, 0, v);
      pushBox(m, _c);
    }
  }

  // ── merge everything into ONE vertex-colored mesh ──
  unitBox.dispose();
  const merged = mergeGeometries(allGeos, false);
  allGeos.forEach((g) => g.dispose());
  if (merged) {
    const mesh = new THREE.Mesh(
      merged,
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: p.roughness,
        metalness: p.metalness,
      }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  return group;
}

/** Fixed hero span — a straight run for close-up tuning. */
export const BARB_WIRE_HERO_POINTS = [
  { x: -8, y: 0, z: -14 },
  { x: 8, y: 0, z: -14 },
];
