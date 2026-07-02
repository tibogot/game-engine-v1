import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { seededRand } from "./woodUtils.js";

/**
 * Procedural Genshin-style wooden arch bridge along a Catmull-Rom spline.
 *
 * Unlike the road/sidewalk, the deck SPANS a gap: its height interpolates
 * between the two endpoints' ground heights plus an arch, so the middle floats
 * above the terrain instead of conforming to it. Mondstadt natural-wood look:
 * planked deck, post-and-rail railings, an arched truss underneath, stone
 * abutments, and optional emissive lanterns (they bloom via the gallery's
 * selective-bloom pass).
 *
 * Every opaque part bakes its color into vertex colors and merges into ONE
 * mesh (1 draw call, 1 shadow caster); the emissive lantern papers are the
 * only second mesh. Cost: the stone abutments share the wood roughness.
 */

export const BRIDGE_DEFAULTS = {
  width: 3.2,
  pathSegments: 60,

  archHeight: 1.4, // mid-span lift above the endpoint chord
  deckClearance: 0.18, // deck top above the endpoint ground
  deckThickness: 0.14,

  plankGap: 0.04, // gap between planks (along path)
  plankWidth: 0.34, // plank size along the path
  plankToneVar: 0.14, // per-plank colour jitter

  stringerW: 0.16,
  stringerH: 0.26,
  stringerInset: 0.3, // inset from the deck edge

  railHeight: 1.0,
  railRadius: 0.05,
  midRail: true,
  postSpacing: 2.0,
  postW: 0.12,
  postD: 0.12,

  truss: true,
  trussW: 0.2,
  trussH: 0.34,
  trussGap: 0.05, // gap below the deck underside
  trussCross: 5, // cross-beams between the two side arches

  abutments: true,

  lanterns: true,
  lanternSpacing: 6, // metres between lanterns
  lanternSize: 0.26,
  lanternColor: "#ffb86b",
  lanternIntensity: 4.0,

  woodMain: "#8a5a32",
  woodAlt: "#6e4625",
  woodRail: "#7a4e2b",
  stoneColor: "#8d8a82",
  roughness: 0.82,
  metalness: 0.0,
  seed: 11,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

// ── geometry helpers ──────────────────────────────────────────────────────

// Sweep a rectangular cross-section (2*hr wide, 2*hu tall) along an array of
// world-space centre points, oriented by per-point {right, up} frames.
function sweepRect(centers, frames, hr, hu) {
  const rings = centers.length;
  const pos = new Float32Array(rings * 4 * 3);
  const idx = [];
  const r = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();

  let o = 0;
  for (let i = 0; i < rings; i++) {
    const c = centers[i];
    r.copy(frames[i].right);
    u.copy(frames[i].up);
    // corners: top-right, top-left, bottom-left, bottom-right
    const corners = [
      [hr, hu],
      [-hr, hu],
      [-hr, -hu],
      [hr, -hu],
    ];
    for (const [a, b] of corners) {
      v.copy(c).addScaledVector(r, a).addScaledVector(u, b);
      pos[o++] = v.x;
      pos[o++] = v.y;
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
  // end caps
  idx.push(0, 2, 1, 0, 3, 2);
  const last = (rings - 1) * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
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
    buf[i * 3]     = color.r;
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
export function buildBridgeMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...BRIDGE_DEFAULTS, ...params };

  const pts3 = points.map((pt) =>
    pt.isVector3
      ? new THREE.Vector3(pt.x, 0, pt.z)
      : new THREE.Vector3(pt.x, 0, pt.z),
  );
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.4, p.width) * 0.5;
  const arch = p.archHeight;
  const y0 = getWorldHeight(points[0].x, points[0].z);
  const yN = getWorldHeight(
    points[points.length - 1].x,
    points[points.length - 1].z,
  );

  // deck height as a function of path param t (spans, doesn't follow terrain)
  const deckY = (t) =>
    y0 + (yN - y0) * t + p.deckClearance + arch * 4 * t * (1 - t);
  const deckPos = (t) => {
    const c = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    return new THREE.Vector3(c.x, deckY(t), c.z);
  };
  const frameAt = (t) => {
    const e = 0.5 / Math.max(2, p.pathSegments);
    const a = deckPos(Math.max(0, t - e));
    const b = deckPos(Math.min(1, t + e));
    const fwd = b.sub(a).normalize();
    const right = new THREE.Vector3().crossVectors(WORLD_UP, fwd);
    if (right.lengthSq() < 1e-9) right.set(1, 0, 0);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
    return { right, up, fwd };
  };

  const group = new THREE.Group();
  group.name = "Bridge";

  // Everything opaque collects here and merges into one vertex-colored mesh.
  const allGeos = [];
  const _c = new THREE.Color();

  // Unit box template — uv stripped so clones merge with the uv-less sweepRect geos
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  unitBox.deleteAttribute("uv");

  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();

  const pushBox = (matrix, color) => {
    const g = unitBox.clone();
    g.applyMatrix4(matrix);
    bakeColor(g, color);
    allGeos.push(g);
  };

  // ── deck planks (tone + size jitter baked into vertex colors) ──
  const segs = Math.max(20, p.pathSegments | 0);
  const plankPitch = Math.max(0.08, p.plankWidth + p.plankGap);
  const plankCount = Math.max(2, Math.floor(length / plankPitch));
  const baseCol = new THREE.Color(p.woodMain);
  for (let i = 0; i < plankCount; i++) {
    const t = (i + 0.5) / plankCount;
    const f = frameAt(t);
    const pos = deckPos(t).addScaledVector(f.up, p.deckThickness * 0.5);
    const lenJit = 1 + (seededRand(p.seed, i * 3 + 1) - 0.5) * 0.06;
    scl.set(p.width * lenJit, p.deckThickness, p.plankWidth);
    m.makeBasis(f.right, f.up, f.fwd).scale(scl).setPosition(pos);
    const v = (seededRand(p.seed, i * 3 + 2) - 0.5) * 2 * p.plankToneVar;
    // instanceColor used to multiply the material color — bake the same product
    _c.copy(baseCol).offsetHSL(0, v * 0.15, v).multiply(baseCol);
    pushBox(m, _c);
  }

  // helpers to sample a side path (offset on right + up) for sweeps
  const sidePath = (sign, rightOff, upOff) => {
    const centers = [];
    const frames = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const f = frameAt(t);
      const c = deckPos(t)
        .addScaledVector(f.right, sign * rightOff)
        .addScaledVector(f.up, upOff);
      centers.push(c);
      frames.push(f);
    }
    return { centers, frames };
  };
  const addSweep = (sign, rightOff, upOff, hr, hu, colorHex) => {
    const { centers, frames } = sidePath(sign, rightOff, upOff);
    const g = sweepRect(centers, frames, hr, hu);
    bakeColor(g, _c.set(colorHex));
    allGeos.push(g);
  };

  // ── stringers (under both deck edges) ──
  const stringerUp = -p.deckThickness * 0.5 - p.stringerH * 0.5;
  for (const s of [-1, 1]) {
    addSweep(s, halfW - p.stringerInset, stringerUp, p.stringerW * 0.5, p.stringerH * 0.5, p.woodAlt);
  }

  // ── arched truss (two side arches + cross-beams) ──
  if (p.truss) {
    const trussUp =
      -p.deckThickness * 0.5 - p.trussGap - p.stringerH - p.trussH * 0.5;
    for (const s of [-1, 1]) {
      addSweep(s, halfW - p.stringerInset, trussUp, p.trussW * 0.5, p.trussH * 0.5, p.woodAlt);
    }
    const cn = Math.max(2, p.trussCross | 0);
    _c.set(p.woodAlt);
    for (let i = 0; i < cn; i++) {
      const t = (i + 0.5) / cn;
      const f = frameAt(t);
      const pos = deckPos(t).addScaledVector(f.up, trussUp);
      scl.set((halfW - p.stringerInset) * 2, p.trussH * 0.6, p.trussW * 0.8);
      m.makeBasis(f.right, f.up, f.fwd).scale(scl).setPosition(pos);
      pushBox(m, _c);
    }
  }

  // ── railings: posts + rails on both sides ──
  const postCount = Math.max(2, Math.floor(length / Math.max(0.5, p.postSpacing)) + 1);
  _c.set(p.woodRail);
  for (let i = 0; i < postCount; i++) {
    const t = postCount === 1 ? 0 : i / (postCount - 1);
    const f = frameAt(t);
    for (const s of [-1, 1]) {
      const baseP = deckPos(t)
        .addScaledVector(f.right, s * (halfW - 0.06))
        .addScaledVector(f.up, p.railHeight * 0.5 + p.deckThickness * 0.5);
      scl.set(p.postW, p.railHeight, p.postD);
      m.makeBasis(f.right, f.up, f.fwd).scale(scl).setPosition(baseP);
      pushBox(m, _c);
    }
  }

  // horizontal rails (top + optional mid) swept along each side
  const railOffsets = [p.railHeight];
  if (p.midRail) railOffsets.push(p.railHeight * 0.5);
  for (const s of [-1, 1]) {
    for (const ro of railOffsets) {
      addSweep(s, halfW - 0.06, ro + p.deckThickness * 0.5, p.railRadius, p.railRadius, p.woodRail);
    }
  }

  // ── stone abutments at both ends ──
  if (p.abutments) {
    _c.set(p.stoneColor);
    for (const t of [0, 1]) {
      const f = frameAt(t);
      const gY = t === 0 ? y0 : yN;
      const top = deckY(t) - p.deckThickness * 0.5;
      const h = Math.max(0.3, top - gY + 0.4);
      const cx = curve.getPointAt(t);
      scl.set(p.width + 0.5, h, 0.9);
      const pos = new THREE.Vector3(cx.x, gY + h * 0.5 - 0.05, cx.z);
      m.makeBasis(f.right, f.up, f.fwd).scale(scl).setPosition(pos);
      pushBox(m, _c);
    }
  }

  // ── lanterns (emissive papers → bloom; caps join the opaque merge) ──
  if (p.lanterns && length > 1) {
    const count = Math.max(2, Math.floor(length / Math.max(1, p.lanternSpacing)) + 1);
    const ls = p.lanternSize;
    const paperTemplate = new THREE.BoxGeometry(ls * 0.7, ls, ls * 0.7);
    const paperGeos = [];
    const capCol = new THREE.Color("#2a1c12");
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const f = frameAt(t);
      for (const s of [-1, 1]) {
        const top = deckPos(t)
          .addScaledVector(f.right, s * (halfW - 0.06))
          .addScaledVector(f.up, p.railHeight + p.deckThickness * 0.5 + ls * 0.6);
        m.makeScale(ls * 0.6, ls * 0.18, ls * 0.6).setPosition(
          top.x + f.up.x * ls * 0.6,
          top.y + f.up.y * ls * 0.6,
          top.z + f.up.z * ls * 0.6,
        );
        pushBox(m, capCol);
        const pg = paperTemplate.clone();
        pg.translate(top.x, top.y, top.z);
        paperGeos.push(pg);
      }
    }
    paperTemplate.dispose();
    const mergedPapers = mergeGeometries(paperGeos, false);
    paperGeos.forEach((g) => g.dispose());
    if (mergedPapers) {
      const paperMat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.lanternColor).multiplyScalar(0.4),
        emissive: new THREE.Color(p.lanternColor),
        emissiveIntensity: p.lanternIntensity,
        roughness: 0.6,
        metalness: 0,
      });
      group.add(new THREE.Mesh(mergedPapers, paperMat));
    }
  }

  // ── merge everything opaque into ONE vertex-colored mesh ──
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

/** Fixed hero span — a clear arched bridge for close-up tuning. */
export const BRIDGE_HERO_POINTS = [
  { x: -10, y: 0, z: -14 },
  { x: 10, y: 0, z: -14 },
];
