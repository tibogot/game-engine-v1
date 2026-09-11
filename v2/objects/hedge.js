import * as THREE from "three";
import { seededRand } from "./woodUtils.js";
import {
  createFoliageMaterial,
  setFoliageTexture,
  updateFoliageBounds,
} from "../render/foliage/foliageMaterial.js";
import {
  computeLeafTrimPolygon,
  buildLeafCardGeometry,
} from "../core/foliage/leafCardTrim.js";

/**
 * Garden hedge along a spline — a dark collidable core wrapped in an arborist
 * canopy (cluster-card atlas + SSS/rim/AO foliage shader). Cards are sampled
 * on a rounded-rect shell with overlapping puffs so the silhouette reads as
 * leaves, not a painted box. Inspector knobs stay the same: leaf textures
 * pick an atlas cell, density fills the volume, colours feed the foliage mat.
 */

export const HEDGE_DEFAULTS = {
  width: 1.3,
  height: 1.4,
  pathSegments: 64,
  topNoise: 0.12, // ± fraction wobble on the envelope
  cornerRadius: 0.34, // rounded-top corner (fraction)

  leafTexture: "/textures/leaves/Leaf-Billboard-Texture-1.png",
  leafSize: 0.6,
  leafDensity: 24, // inspector 0–40; mapped to a full canopy, not garnish
  colorVar: 0.14,

  bodyColorBottom: "#0c1c0b",
  bodyColorTop: "#173214",
  leafColorBottom: "#1e4014",
  leafColorTop: "#8bd24e",

  roughness: 0.92,
  seed: 5,
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const ATLAS_PATH = "/textures/leaves/leaf_atlas.png";
const ATLAS_COLS = 4;
const ATLAS_CELL_PX = 256;
const ATLAS_SIZE = 1024;
const ATLAS_GUTTER = 12;
const ATLAS_GRID = [
  ATLAS_COLS,
  ATLAS_CELL_PX / ATLAS_SIZE,
  ATLAS_GUTTER / ATLAS_SIZE,
  (ATLAS_CELL_PX - 2 * ATLAS_GUTTER) / ATLAS_SIZE,
];
// Leaf 1–5 dropdown → hedge-friendly atlas clumps (boxwood ovals first).
const ATLAS_CELL_BY_LEAF = [7, 0, 2, 4, 8];
const MAX_CARDS = 28000;
const CORE_SCALE = 0.9;

const _texCache = new Map();
const _trimCache = new Map();
const _matPool = [];

function atlasCellFromLeafTex(url) {
  const m = String(url || "").match(/Texture-(\d)/i);
  if (!m) return 7;
  return ATLAS_CELL_BY_LEAF[(+m[1] || 1) - 1] ?? 7;
}

function atlasCellRect(cell) {
  const cols = ATLAS_GRID[0];
  const cellStep = ATLAS_GRID[1];
  const gutterFrac = ATLAS_GRID[2];
  const innerFrac = ATLAS_GRID[3];
  const col = cell % cols;
  const row = Math.floor(cell / cols);
  const ox = col * cellStep + gutterFrac;
  const oy = (cols - 1 - row) * cellStep + gutterFrac;
  return { x: ox, y: 1 - oy - innerFrac, w: innerFrac, h: innerFrac };
}

function isTexReady(tex) {
  const img = tex?.image;
  if (!img) return false;
  if (img.complete === false) return false;
  return !!(img.width || img.naturalWidth);
}

let _placeholderTex = null;
function placeholderTex() {
  if (_placeholderTex) return _placeholderTex;
  const t = new THREE.DataTexture(new Uint8Array([40, 80, 24, 255]), 1, 1);
  t.needsUpdate = true;
  t.colorSpace = THREE.SRGBColorSpace;
  _placeholderTex = t;
  return t;
}

function getTexture(url, onReady) {
  const fire = (t) => {
    if (!isTexReady(t)) return;
    onReady?.(t);
  };
  if (_texCache.has(url)) {
    const tex = _texCache.get(url);
    if (isTexReady(tex)) fire(tex);
    else if (onReady) (tex.userData._hedgeReady ??= []).push(onReady);
    return tex;
  }
  const tex = new THREE.TextureLoader().load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    const cbs = t.userData._hedgeReady;
    t.userData._hedgeReady = [];
    if (cbs) for (const cb of cbs) cb?.(t);
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.userData._hedgeReady = onReady ? [onReady] : [];
  _texCache.set(url, tex);
  return tex;
}

function cardGeometryFor(tex, cell, useAtlas) {
  const img = tex?.image;
  if (!img || !(img.width || img.naturalWidth)) {
    return new THREE.PlaneGeometry(1, 1);
  }
  const key = `${useAtlas ? "a" : "t"}:${cell}:${img.width}x${img.height}`;
  let poly = _trimCache.get(key);
  if (poly === undefined) {
    poly = computeLeafTrimPolygon(img, {
      maskInAlpha: !useAtlas,
      cellRect: useAtlas ? atlasCellRect(cell) : null,
    });
    _trimCache.set(key, poly);
  }
  return poly ? buildLeafCardGeometry(poly) : new THREE.PlaneGeometry(1, 1);
}

function acquireFoliage() {
  let slot = _matPool.find((s) => !s.inUse);
  if (!slot) {
    const foliage = createFoliageMaterial({
      billboard: false,
      useAtlas: true,
      atlasGrid: ATLAS_GRID,
      atlasCell: 7,
      sssColor: "#c8e070",
      sssStr: 0.24,
      sssPow: 2.0,
      rimColor: "#c8ffaa",
      rimStr: 0.11,
      rimPow: 2.4,
      aoStr: 0.52,
      normalBias: 0.72,
      leafWarp: 0.28,
      alphaCutoff: 0.45,
      windSpeed: 0.85,
      windStr: 0.0,
      windMicro: 0.0,
    });
    const mat = foliage.material;
    setFoliageTexture(foliage, placeholderTex());
    foliage.uniforms.maskInAlpha.value = 0;
    slot = { inUse: false, foliage };
    mat.dispose = () => {
      slot.inUse = false;
    };
    _matPool.push(slot);
  }
  slot.inUse = true;
  slot.foliage.uniforms.windStr.value = 0;
  slot.foliage.uniforms.windMicro.value = 0;
  return slot;
}

function bindFoliageTick(mesh, uniforms) {
  let light = null;
  mesh.onBeforeRender = (renderer, scene) => {
    // Foliage materials use castShadowNode (alpha-cut leaf shadows).
    if (renderer?.shadowMap) renderer.shadowMap.transmitted = true;
    uniforms.time.value = performance.now() * 0.001;
    if (!light || light.parent == null) {
      light = null;
      for (const child of scene.children) {
        if (child.isDirectionalLight) {
          light = child;
          break;
        }
      }
    }
    if (light) uniforms.sunDir.value.copy(light.position).normalize();
  };
}

function irreg(t, seed, n) {
  return (
    Math.sin(t * 6.2 + seed * 0.17 + n) * 0.52 +
    Math.sin(t * 14.1 + seed * 0.41 + n * 1.7) * 0.31 +
    Math.sin(t * 29.3 + seed * 0.73 + n * 2.3) * 0.17
  );
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

function buildOutline(cornerFrac) {
  const prof = makeProfile(cornerFrac, 6);
  const segs = [];
  for (let i = 0; i < prof.length; i++) {
    const a = prof[i];
    const b = prof[(i + 1) % prof.length];
    if (a.u < 0.1 && b.u < 0.1) continue; // skip the ground edge
    const dr = b.r - a.r;
    const du = b.u - a.u;
    const len = Math.hypot(dr, du);
    if (len < 1e-6) continue;
    // Clockwise outline → outward is (du, -dr).
    segs.push({
      a,
      dr,
      du,
      len,
      nr: du / len,
      nu: -dr / len,
    });
  }
  let total = 0;
  for (const s of segs) total += s.len;
  return { segs, total };
}

function sampleOutline(outline, rnd) {
  let x = rnd * outline.total;
  for (const s of outline.segs) {
    if (x > s.len) {
      x -= s.len;
      continue;
    }
    const f = x / s.len;
    return {
      r: s.a.r + s.dr * f,
      u: s.a.u + s.du * f,
      nr: s.nr,
      nu: s.nu,
    };
  }
  const s = outline.segs[outline.segs.length - 1];
  return { r: s.a.r + s.dr, u: s.a.u + s.du, nr: s.nr, nu: s.nu };
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

    const wMul = 1 + p.topNoise * 0.35 * irreg(t, p.seed, 0.2);
    const hMul = 1 + p.topNoise * irreg(t, p.seed, 1.1);
    const hh = height * hMul;
    const hw = halfW * wMul;
    for (let j = 0; j < P; j++) {
      const pr = profile[j];
      const px = center.x + right.x * (pr.r * hw);
      const py = center.y + pr.u * hh;
      const pz = center.z + right.z * (pr.r * hw);
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
  const last = segs * P;
  for (let j = 1; j < P - 1; j++) {
    idx.push(0, j + 1, j);
    idx.push(last, last + j, last + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function frameAt(curve, segs, t, p, center, fwd, right) {
  const cp = curve.getPointAt(THREE.MathUtils.clamp(t, 0, 1));
  center.set(cp.x, p.getWorldHeight(cp.x, cp.z), cp.z);
  const e = 0.5 / segs;
  const a = curve.getPointAt(THREE.MathUtils.clamp(t - e, 0, 1));
  const b = curve.getPointAt(THREE.MathUtils.clamp(t + e, 0, 1));
  fwd.set(b.x - a.x, 0, b.z - a.z);
  if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
  fwd.normalize();
  right.crossVectors(WORLD_UP, fwd).normalize();
}

function placeLeaves(curve, length, segs, halfW, height, p, closed) {
  const shellCount = THREE.MathUtils.clamp(
    Math.round(length * p.leafDensity * 7.2),
    0,
    MAX_CARDS,
  );
  const faceArea = Math.max(0.2, p.width) * Math.max(0.3, p.height);
  const capEach = closed
    ? 0
    : THREE.MathUtils.clamp(Math.round(160 * faceArea / 1.82), 80, 500);
  const count = THREE.MathUtils.clamp(shellCount + capEach * 2, 0, MAX_CARDS);
  if (count <= 0) return null;

  const outline = buildOutline(p.cornerRadius);
  if (!outline.segs.length) return null;

  const puffN = Math.max(2, Math.round(length / Math.max(0.55, p.width * 0.62)));
  const puffs = [];
  const puffCenter = new THREE.Vector3();
  const puffFwd = new THREE.Vector3();
  const puffRight = new THREE.Vector3();
  for (let i = 0; i < puffN; i++) {
    const t = closed
      ? (i + 0.5) / puffN
      : puffN === 1
        ? 0.5
        : i / (puffN - 1);
    const tj = t + (seededRand(p.seed, i * 3 + 8) - 0.5) * 0.04;
    frameAt(curve, segs, tj, p, puffCenter, puffFwd, puffRight);
    puffs.push({
      x: puffCenter.x,
      y: puffCenter.y + height * 0.52,
      z: puffCenter.z,
    });
  }

  const dummy = new THREE.Object3D();
  dummy.rotation.order = "YXZ";
  const nrm = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const center = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const xc = new THREE.Vector3();
  const yc = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const roll = new THREE.Quaternion();

  const matrices = new Float32Array(count * 16);
  const rands = new Float32Array(count * 2);
  const centers = new Float32Array(count * 3);
  const scales = new Float32Array(count * 2);
  const treeCenters = new Float32Array(count * 3);

  let placed = 0;

  const nearestPuff = () => {
    let puff = puffs[0];
    let bestD = Infinity;
    for (let k = 0; k < puffs.length; k++) {
      const c = puffs[k];
      const dx = pos.x - c.x;
      const dy = pos.y - c.y;
      const dz = pos.z - c.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) {
        bestD = d;
        puff = c;
      }
    }
    return puff;
  };

  const commit = (s, hh, seedK) => {
    if (placed >= count) return false;
    xc.crossVectors(WORLD_UP, nrm);
    if (xc.lengthSq() < 1e-6) xc.copy(fwd);
    xc.normalize();
    yc.crossVectors(nrm, xc).normalize();
    basis.makeBasis(xc, yc, nrm);
    q.setFromRotationMatrix(basis);
    roll.setFromAxisAngle(nrm, seededRand(p.seed, seedK + 1) * Math.PI * 2);
    q.premultiply(roll);
    dummy.position.copy(pos);
    dummy.quaternion.copy(q);
    dummy.scale.setScalar(s);
    dummy.updateMatrix();
    dummy.matrix.toArray(matrices, placed * 16);
    const i = placed;
    rands[i * 2] = seededRand(p.seed, seedK + 3);
    rands[i * 2 + 1] = seededRand(p.seed, seedK + 4);
    centers[i * 3] = pos.x;
    centers[i * 3 + 1] = pos.y;
    centers[i * 3 + 2] = pos.z;
    scales[i * 2] = s;
    scales[i * 2 + 1] = THREE.MathUtils.clamp(
      (pos.y - center.y) / Math.max(hh, 0.001),
      0,
      1,
    );
    const puff = nearestPuff();
    treeCenters[i * 3] = puff.x;
    treeCenters[i * 3 + 1] = puff.y;
    treeCenters[i * 3 + 2] = puff.z;
    placed++;
    return true;
  };

  const envelopeAt = (t) => {
    frameAt(curve, segs, t, p, center, fwd, right);
    const wMul = 1 + p.topNoise * 0.45 * irreg(t, p.seed, 0.2);
    const hMul = 1 + p.topNoise * irreg(t, p.seed, 1.1);
    return { hw: halfW * wMul, hh: height * hMul };
  };

  // End plugs: fill the whole rounded-rect face (not just the rim) so the
  // hedge reads as a solid volume instead of a leafy tunnel.
  if (!closed && capEach > 0) {
    for (const sign of [-1, 1]) {
      const tCap = sign < 0 ? 0 : 1;
      const env = envelopeAt(tCap);
      for (let n = 0; n < capEach && placed < count; n++) {
        const pick = sampleOutline(outline, seededRand(p.seed, n * 11 + sign * 17 + 3));
        const rim = Math.pow(seededRand(p.seed, n * 11 + 4), 0.38);
        const rr = pick.r * rim;
        const uu = THREE.MathUtils.lerp(0.36, pick.u, rim);
        nrm.copy(fwd).multiplyScalar(sign);
        nrm.addScaledVector(right, pick.nr * rim * 0.7);
        nrm.addScaledVector(WORLD_UP, pick.nu * rim * 0.55);
        if (nrm.lengthSq() < 1e-8) nrm.copy(fwd).multiplyScalar(sign);
        nrm.normalize();

        const poke = p.leafSize * (0.06 + 0.22 * seededRand(p.seed, n * 11 + 5));
        const plug = p.leafSize * 0.55 * seededRand(p.seed, n * 11 + 6);
        pos.copy(center)
          .addScaledVector(right, rr * env.hw)
          .addScaledVector(WORLD_UP, uu * env.hh)
          .addScaledVector(fwd, sign * poke)
          .addScaledVector(fwd, -sign * plug);

        const fringe = rim > 0.78 && seededRand(p.seed, n * 11 + 7) < 0.45;
        const s =
          p.leafSize *
          (fringe ? 0.62 : 1.05) *
          (0.82 + 0.4 * seededRand(p.seed, n * 11 + 8));
        if (pos.y < center.y + s * 0.08) continue;
        commit(s, env.hh, n * 13 + sign * 29);
      }
    }
  }

  let tries = 0;
  const maxTry = shellCount * 10;
  while (placed < count && tries++ < maxTry) {
    const t = seededRand(p.seed, tries * 5 + 1);
    const env = envelopeAt(t);
    const fringe = seededRand(p.seed, tries * 5 + 2) < 0.3;
    const pick = sampleOutline(outline, seededRand(p.seed, tries * 5 + 3));
    const overshoot =
      (fringe ? 0.2 : 0.1) + 0.1 * seededRand(p.seed, tries * 5 + 6);

    nrm.copy(right).multiplyScalar(pick.nr).addScaledVector(WORLD_UP, pick.nu);
    if (nrm.lengthSq() < 1e-8) nrm.copy(WORLD_UP);
    nrm.normalize();

    pos.copy(center)
      .addScaledVector(right, pick.r * env.hw)
      .addScaledVector(WORLD_UP, pick.u * env.hh)
      .addScaledVector(nrm, p.leafSize * overshoot);

    const puffAmp = Math.min(env.hw, env.hh) * (0.14 + p.topNoise * 0.45);
    pos.addScaledVector(nrm, puffAmp * (seededRand(p.seed, tries * 7 + 1) - 0.22));
    pos.addScaledVector(fwd, puffAmp * 0.4 * (seededRand(p.seed, tries * 7 + 2) * 2 - 1));
    pos.addScaledVector(right, puffAmp * 0.16 * (seededRand(p.seed, tries * 7 + 3) * 2 - 1));
    // Pull some cards into the volume so glancing views don't show a hollow.
    if (seededRand(p.seed, tries * 7 + 4) < 0.28) {
      pos.addScaledVector(nrm, -p.leafSize * (0.35 + 0.45 * seededRand(p.seed, tries * 7 + 5)));
    }

    if (pos.y < center.y + p.leafSize * 0.1) continue;

    const s =
      p.leafSize *
      (fringe ? 0.56 : 1) *
      (0.8 + 0.45 * seededRand(p.seed, tries * 9 + 2));
    commit(s, env.hh, tries * 17);
  }

  if (placed <= 0) return null;
  const shrink = (arr, n) => (arr.length === n ? arr : arr.subarray(0, n));
  return {
    count: placed,
    matrices: shrink(matrices, placed * 16),
    rands: shrink(rands, placed * 2),
    centers: shrink(centers, placed * 3),
    scales: shrink(scales, placed * 2),
    treeCenters: shrink(treeCenters, placed * 3),
  };
}

export function buildHedgeMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const p = { ...HEDGE_DEFAULTS, ...params, getWorldHeight };

  const pts3 = points.map((pt) => new THREE.Vector3(pt.x, 0, pt.z));
  const curve = new THREE.CatmullRomCurve3(pts3, !!closed, "catmullrom", 0.5);
  const length = curve.getLength();
  const halfW = Math.max(0.2, p.width) * 0.5;
  const height = Math.max(0.3, p.height);
  const segs = Math.max(16, p.pathSegments | 0);

  const group = new THREE.Group();
  group.name = "Hedge";

  const coreHalf = halfW * CORE_SCALE;
  const coreH = height * CORE_SCALE;
  const bodyGeo = buildBodyGeometry(
    curve,
    segs,
    coreHalf,
    coreH,
    p,
    p.bodyColorBottom,
    p.bodyColorTop,
  );
  const bodyMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: Math.min(1, p.roughness + 0.04),
    metalness: 0,
    envMapIntensity: 0.15,
  });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const placed = placeLeaves(curve, length, segs, halfW, height, p, !!closed);
  if (!placed) return group;

  const useAtlas = /Leaf-Billboard-Texture-\d/i.test(p.leafTexture) || !p.leafTexture;
  const cell = atlasCellFromLeafTex(p.leafTexture);
  const slot = acquireFoliage();
  const { material, uniforms } = slot.foliage;

  const bindLeafTex = (readyTex) => {
    if (!isTexReady(readyTex)) return;
    setFoliageTexture(slot.foliage, readyTex);
    if (useAtlas) uniforms.maskInAlpha.value = 0;
  };

  const tex = getTexture(useAtlas ? ATLAS_PATH : p.leafTexture, bindLeafTex);
  uniforms.useAtlas.value = useAtlas ? 1 : 0;
  uniforms.atlasCell.value = cell;
  uniforms.billboard.value = 0;
  uniforms.bottomColor.value.set(p.leafColorBottom);
  uniforms.topColor.value.set(p.leafColorTop);
  uniforms.colorVar.value = p.colorVar;
  uniforms.treeColorVar.value = 0.08;
  uniforms.sssStr.value = 0.24;
  uniforms.rimStr.value = 0.11;
  uniforms.aoStr.value = 0.52;
  uniforms.normalBias.value = 0.72;
  uniforms.windStr.value = 0;
  uniforms.windMicro.value = 0;
  material.roughness = p.roughness;
  updateFoliageBounds(
    slot.foliage,
    0,
    height,
    new THREE.Vector3(0, height * 0.5, 0),
    Math.max(halfW, height * 0.5) * 1.15,
  );

  const attachCardAttrs = (geo) => {
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(placed.rands, 2));
    geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(placed.centers, 3));
    geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(placed.scales, 2));
    geo.setAttribute("aTreeCenter", new THREE.InstancedBufferAttribute(placed.treeCenters, 3));
    return geo;
  };

  const cardGeo = attachCardAttrs(cardGeometryFor(tex, cell, useAtlas));
  const cards = new THREE.InstancedMesh(cardGeo, material, placed.count);
  cards.instanceMatrix.array.set(placed.matrices);
  cards.instanceMatrix.needsUpdate = true;
  cards.castShadow = true;
  cards.receiveShadow = true;
  cards.frustumCulled = true;
  cards.computeBoundingSphere();
  cards.userData.noCollision = true;
  bindFoliageTick(cards, uniforms);
  group.add(cards);

  getTexture(useAtlas ? ATLAS_PATH : p.leafTexture, (readyTex) => {
    if (!cards.parent) return;
    bindLeafTex(readyTex);
    const trimmed = attachCardAttrs(cardGeometryFor(readyTex, cell, useAtlas));
    const prev = cards.geometry;
    cards.geometry = trimmed;
    if (prev !== trimmed) prev.dispose();
  });

  group.userData.hedgeRelease = () => {
    slot.inUse = false;
  };

  return group;
}

export const HEDGE_HERO_POINTS = [
  { x: -12, y: 0, z: -14 },
  { x: 0, y: 0, z: -14 },
  { x: 12, y: 0, z: -14 },
];
