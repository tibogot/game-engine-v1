import * as THREE from "three";
import { seededRand } from "./woodUtils.js";

/**
 * Garden hedge along a spline — a swept rounded-box body (vertical green
 * gradient + gently noisy top) dressed with instanced leaf-billboard cards
 * (alpha-cut, colour-jittered, biased to the top + side edges so the silhouette
 * reads as leaves, not a box). MVP: no wind. Body is solid (collidable); the
 * leaf cards are flagged noCollision so only the body bakes into the BVH.
 */

export const HEDGE_DEFAULTS = {
  width: 1.3,
  height: 1.4,
  pathSegments: 64,
  topNoise: 0.12, // ± fraction wobble on the top edge
  cornerRadius: 0.34, // rounded-top corner (fraction)

  leafTexture: "/textures/leaves/Leaf-Billboard-Texture-1.png",
  leafSize: 0.5,
  leafDensity: 16, // leaf cards per metre of length
  colorVar: 0.12,

  bodyColorBottom: "#1b3a18",
  bodyColorTop: "#3c7a2c",
  leafColorBottom: "#356b26",
  leafColorTop: "#8fce58",

  roughness: 0.92,
  seed: 5,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);

const _texCache = new Map();
function getLeafTexture(url) {
  if (_texCache.has(url)) return _texCache.get(url);
  const tex = new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  _texCache.set(url, tex);
  return tex;
}

// normalized rounded-rect cross-section loop {r:-1..1, u:0..1}
function makeProfile(cornerFrac, arc) {
  const c = THREE.MathUtils.clamp(cornerFrac, 0, 0.49);
  const pts = [];
  pts.push({ r: 1, u: 0 });
  pts.push({ r: 1, u: 1 - c });
  for (let k = 1; k <= arc; k++) {
    const a = (k / arc) * (Math.PI / 2);
    pts.push({ r: 1 - c + c * Math.cos(a), u: 1 - c + c * Math.sin(a) });
  }
  pts.push({ r: -(1 - c), u: 1 });
  for (let k = 1; k <= arc; k++) {
    const a = Math.PI / 2 + (k / arc) * (Math.PI / 2);
    pts.push({ r: -(1 - c) + c * Math.cos(a), u: 1 - c + c * Math.sin(a) });
  }
  pts.push({ r: -1, u: 0 });
  return pts;
}

function buildBodyGeometry(curve, segs, halfW, height, p, colBottom, colTop) {
  const profile = makeProfile(p.cornerRadius, 3);
  const P = profile.length;
  const rings = segs + 1;
  const positions = new Float32Array(rings * P * 3);
  const colors = new Float32Array(rings * P * 3);
  const idx = [];

  const center = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const cb = new THREE.Color(colBottom);
  const ct = new THREE.Color(colTop);
  const col = new THREE.Color();

  const posAt = (t, out) => {
    const cp = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
    out.set(cp.x, p.getWorldHeight(cp.x, cp.z), cp.z);
    return out;
  };

  let o = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    posAt(t, center);
    const e = 0.5 / segs;
    posAt(Math.max(0, t - e), a);
    posAt(Math.min(1, t + e), b);
    fwd.subVectors(b, a);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
    fwd.normalize();
    right.crossVectors(WORLD_UP, fwd).normalize();

    const hh = height * (1 + p.topNoise * Math.sin(i * 0.7 + p.seed));
    for (let j = 0; j < P; j++) {
      const pr = profile[j];
      const px = center.x + right.x * (pr.r * halfW);
      const py = center.y + pr.u * hh;
      const pz = center.z + right.z * (pr.r * halfW);
      positions[o] = px;
      positions[o + 1] = py;
      positions[o + 2] = pz;
      col.copy(cb).lerp(ct, pr.u);
      colors[o] = col.r;
      colors[o + 1] = col.g;
      colors[o + 2] = col.b;
      o += 3;
    }
  }

  for (let i = 0; i < segs; i++) {
    const r0 = i * P;
    const r1 = (i + 1) * P;
    for (let j = 0; j < P; j++) {
      const j2 = (j + 1) % P;
      idx.push(r0 + j, r0 + j2, r1 + j2, r0 + j, r1 + j2, r1 + j);
    }
  }
  // end caps (convex loop fan)
  const last = segs * P;
  for (let j = 1; j < P - 1; j++) {
    idx.push(0, j + 1, j); // front
    idx.push(last, last + j, last + j + 1); // back
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export function buildHedgeMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...HEDGE_DEFAULTS, ...params, getWorldHeight };

  const pts3 = points.map((pt) =>
    new THREE.Vector3(pt.x, 0, pt.z),
  );
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.2, p.width) * 0.5;
  const height = Math.max(0.3, p.height);
  const segs = Math.max(16, p.pathSegments | 0);

  const group = new THREE.Group();
  group.name = "Hedge";

  // ── body ──
  const bodyGeo = buildBodyGeometry(curve, segs, halfW, height, p, p.bodyColorBottom, p.bodyColorTop);
  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: p.roughness,
    metalness: 0,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // ── leaf cards (instanced, alpha-cut billboards) ──
  const count = THREE.MathUtils.clamp(Math.round(length * p.leafDensity), 0, 20000);
  if (count > 0) {
    const cardGeo = new THREE.PlaneGeometry(1, 1);
    const cardMat = new THREE.MeshStandardMaterial({
      map: getLeafTexture(p.leafTexture),
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      roughness: p.roughness,
      metalness: 0,
    });
    const cards = new THREE.InstancedMesh(cardGeo, cardMat, count);
    cards.castShadow = true;
    cards.userData.noCollision = true; // decoration: keep out of the BVH

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const roll = new THREE.Quaternion();
    const basis = new THREE.Matrix4();
    const sclv = new THREE.Vector3();
    const center = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const aPt = new THREE.Vector3();
    const bPt = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    const xc = new THREE.Vector3();
    const yc = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const cb = new THREE.Color(p.leafColorBottom);
    const ct = new THREE.Color(p.leafColorTop);
    const col = new THREE.Color();

    const posAt = (t, out) => {
      const cp = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
      out.set(cp.x, p.getWorldHeight(cp.x, cp.z), cp.z);
      return out;
    };

    for (let i = 0; i < count; i++) {
      const t = seededRand(p.seed, i * 5 + 1);
      posAt(t, center);
      const e = 0.5 / segs;
      posAt(Math.max(0, t - e), aPt);
      posAt(Math.min(1, t + e), bPt);
      fwd.subVectors(bPt, aPt);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
      fwd.normalize();
      right.crossVectors(WORLD_UP, fwd).normalize();

      const pick = seededRand(p.seed, i * 5 + 2);
      let uu;
      if (pick < 0.62) {
        // top — spread across, can poke above the top edge
        const ac = (seededRand(p.seed, i * 5 + 3) * 2 - 1) * halfW * 1.08;
        uu = height * (0.92 + (seededRand(p.seed, i * 5 + 4) - 0.5) * 0.22);
        pos.copy(center).addScaledVector(right, ac).addScaledVector(WORLD_UP, uu);
        nrm.copy(WORLD_UP).addScaledVector(right, (ac / halfW) * 0.55).normalize();
      } else {
        // sides
        const side = pick < 0.81 ? -1 : 1;
        uu = height * (0.32 + 0.7 * seededRand(p.seed, i * 5 + 3));
        pos.copy(center).addScaledVector(right, side * halfW * 1.04).addScaledVector(WORLD_UP, uu);
        nrm.copy(right).multiplyScalar(side).addScaledVector(WORLD_UP, 0.28).normalize();
      }
      pos.addScaledVector(nrm, p.leafSize * 0.22);

      // orient quad (+Z) outward along nrm, with a random roll
      xc.crossVectors(WORLD_UP, nrm);
      if (xc.lengthSq() < 1e-6) xc.copy(fwd);
      xc.normalize();
      yc.crossVectors(nrm, xc).normalize();
      basis.makeBasis(xc, yc, nrm);
      q.setFromRotationMatrix(basis);
      roll.setFromAxisAngle(nrm, seededRand(p.seed, i * 5 + 4) * Math.PI * 2);
      q.premultiply(roll);

      const s = p.leafSize * (0.7 + 0.6 * seededRand(p.seed, i * 7 + 5));
      sclv.set(s, s, s);
      m.compose(pos, q, sclv);
      cards.setMatrixAt(i, m);

      col.copy(cb).lerp(ct, THREE.MathUtils.clamp(uu / height, 0, 1));
      const v = (seededRand(p.seed, i * 7 + 6) - 0.5) * 2 * p.colorVar;
      col.offsetHSL(v * 0.1, 0, v);
      cards.setColorAt(i, col);
    }
    cards.instanceMatrix.needsUpdate = true;
    if (cards.instanceColor) cards.instanceColor.needsUpdate = true;
    group.add(cards);
  }

  return group;
}

export const HEDGE_HERO_POINTS = [
  { x: -12, y: 0, z: -14 },
  { x: 0, y: 0, z: -14 },
  { x: 12, y: 0, z: -14 },
];
