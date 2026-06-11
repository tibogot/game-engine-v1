/**
 * fleur-painter.js
 * Brush-paint low-poly procedural flowers (Genshin-style).
 * - Sub-modes: ground bloom (no stem) vs stemmed (bloom + stem merged — one mesh).
 * - Color slots A / B; bloom shape index 0–2 selects alpha PNG mask.
 * - Chunk InstancedMesh per (chunk, variant, mask, slot).
 */

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  and,
  attribute,
  cos,
  dot,
  float,
  Fn,
  length,
  max,
  min,
  mix,
  modelWorldMatrixInverse,
  negate,
  normalWorld,
  normalize,
  positionLocal,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";

const MAX_FLEURS = 30000;
const CHUNK_SIZE = 64;

/** Alpha textures for bloom silhouettes (fallback to first if a file is missing). */
export const FLEUR_ALPHA_URLS = [
  "textures/flowers/Flower32.png",
  "textures/flowers/Flower33.png",
  "textures/flowers/Flower34.png",
];
export const FLEUR_MASK_COUNT = 3;

/** Bloom layout — must match createBloomGeometry rings (stem attach uses same radii). */
const FLEUR_SHAPE = {
  ringCount: 2,
  centerY: 0.55,
  r1: 0.38,
  r2: 0.78,
  r3: 0.78,
  r4: 0.78,
  y1: 0.16,
  y2: 0.0,
  y3: 0.0,
  y4: 0.0,
};

const FLEUR_STEM = {
  height: 2.5,
  cupInset: 0,
  rimNudge: -0.055,
  coneClearance: 0.29,
  radiusTop: 0.072,
  radiusBottom: 0.034,
  sides: 6,
  segments: 3,
  bend: 0.06,
};

/** World-space Y offset for stemmed instances only (negative = sink into terrain slightly). */
export const FLEUR_STEM_GROUND_BIAS = -0.028;

// ── Color presets (from genshin-flowers2.html) ─────────────────────────────
export const FLEUR_PRESETS = {
  main: { inner: "#fff4b8", outer: "#fb8da0", glow: 0.28 },
  sakura: { inner: "#ffd9ea", outer: "#ff7ab2", glow: 0.32 },
  zeldaBlue: { inner: "#e8fbff", outer: "#7db8ff", glow: 0.24 },
  sunflower: { inner: "#ffe78c", outer: "#ff9f40", glow: 0.26 },
};

function createBloomGeometry() {
  const sides = 8;
  const ringR = [0.0, 0.38, 0.78];
  const ringY = [0.55, 0.16, 0.0];
  const rOuter = ringR[2];

  const positions = [],
    uvs = [],
    indices = [];
  positions.push(0, ringY[0], 0);
  uvs.push(0.5, 0.5);

  const ringStart = [0, 0, 0];
  let vc = 1;
  for (let r = 1; r < ringR.length; r++) {
    ringStart[r] = vc;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + Math.PI / 8;
      const px = Math.cos(a) * ringR[r];
      const pz = Math.sin(a) * ringR[r];
      positions.push(px, ringY[r], pz);
      uvs.push(px / (rOuter * 2) + 0.5, pz / (rOuter * 2) + 0.5);
      vc++;
    }
  }

  const idx = (r, s) => ringStart[r] + (s % sides);
  for (let s = 0; s < sides; s++)
    indices.push(0, idx(1, s + 1), idx(1, s));
  for (let s = 0; s < sides; s++) {
    const a = idx(1, s),
      b = idx(1, s + 1),
      c = idx(2, s),
      d = idx(2, s + 1);
    indices.push(a, b, c, b, d, c);
  }

  const nVert = positions.length / 3;
  const flowerPart = new Float32Array(nVert);
  const stemT = new Float32Array(nVert);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("flowerPart", new THREE.Float32BufferAttribute(flowerPart, 1));
  geo.setAttribute("stemT", new THREE.Float32BufferAttribute(stemT, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createStemGeometry(shape, stem) {
  const nRings = Math.min(4, Math.max(2, shape.ringCount | 0) || 4);
  const ringR = [0.0];
  const ringY = [shape.centerY];
  for (let i = 1; i <= nRings; i++) {
    ringR.push(shape[`r${i}`]);
    ringY.push(shape[`y${i}`]);
  }
  const yTip = ringY[0];
  const y1 = ringY[1];
  const r1 = ringR[1];

  const inset = Math.max(0, Math.min(1, stem.cupInset));
  let yAttach = yTip + (y1 - yTip) * inset + stem.rimNudge;
  const yLo = Math.min(yTip, y1);
  const yHi = Math.max(yTip, y1);
  yAttach = Math.max(yLo, Math.min(yHi, yAttach));

  const denom = y1 - yTip;
  const tAlong =
    Math.abs(denom) < 1e-8
      ? 0
      : Math.max(0, Math.min(1, (yAttach - yTip) / denom));
  const rFrustum = r1 * tAlong;
  const tipBlend = 1 - tAlong;
  const maxR = Math.max(
    0.0025,
    rFrustum * stem.coneClearance +
      r1 * stem.coneClearance * 0.06 * tipBlend,
  );
  const rTopEff = Math.min(stem.radiusTop, maxR);

  const yFar = yAttach + stem.height;

  const sides = Math.max(3, stem.sides | 0);
  const segs = Math.max(1, stem.segments | 0);
  const positions = [],
    uvs = [],
    indices = [],
    flowerPart = [],
    stemT = [];

  for (let j = 0; j <= segs; j++) {
    const t = j / segs;
    const y = yAttach + (yFar - yAttach) * t;
    const r = rTopEff + (stem.radiusBottom - rTopEff) * t;
    const bendOff = stem.bend * t * t;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + Math.PI / sides;
      positions.push(Math.cos(a) * r + bendOff, y, Math.sin(a) * r);
      uvs.push(0.5, 0.5);
      flowerPart.push(1);
      stemT.push(1 - t);
    }
  }

  const row = (j) => j * sides;
  for (let j = 0; j < segs; j++) {
    for (let s = 0; s < sides; s++) {
      const a = row(j) + s;
      const b = row(j) + ((s + 1) % sides);
      const c = row(j + 1) + s;
      const d = row(j + 1) + ((s + 1) % sides);
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute(
    "flowerPart",
    new THREE.Float32BufferAttribute(new Float32Array(flowerPart), 1),
  );
  geo.setAttribute(
    "stemT",
    new THREE.Float32BufferAttribute(new Float32Array(stemT), 1),
  );
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function createMergedFlowerGeometry() {
  const bloom = createBloomGeometry();
  const stemGeo = createStemGeometry(FLEUR_SHAPE, FLEUR_STEM);
  const merged = mergeGeometries([bloom, stemGeo], false);
  bloom.dispose();
  stemGeo.dispose();
  return merged;
}

/** Local Y of planted foot: min Y for ground blooms; stem-ground ring Y for stemmed (all verts same). */
function addInteractPivotYAttribute(geo) {
  const pos = geo.attributes.position;
  const fp = geo.attributes.flowerPart;
  let minY = Infinity;
  let maxStemY = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    minY = Math.min(minY, y);
    if (fp.getX(i) > 0.5) maxStemY = Math.max(maxStemY, y);
  }
  const pivotY = Number.isFinite(maxStemY) ? maxStemY : minY;
  const arr = new Float32Array(pos.count);
  arr.fill(pivotY);
  geo.setAttribute(
    "interactPivotY",
    new THREE.Float32BufferAttribute(arr, 1),
  );
}

function createFleurMaterial(innerHex, outerHex, glow, alphaTex, matOpts) {
  const uStemStaticCurve = matOpts?.uStemStaticCurve ?? uniform(0.1);
  const uRepulseGain =
    matOpts?.uFleurRepulseGain ?? uniform(0.85);
  const uFleurTime = matOpts?.uFleurTime ?? uniform(0);
  const uWindAmp = matOpts?.uWindAmp ?? uniform(0.042);
  const uWindSpeed = matOpts?.uWindSpeed ?? uniform(1.12);

  const uPlayerPos = matOpts?.uPlayerPos ?? uniform(new THREE.Vector3(0, 9999, 0));
  const uInteractionRadius =
    matOpts?.uInteractionRadius ?? uniform(1.5);
  const uInteractionStrength =
    matOpts?.uInteractionStrength ?? uniform(0.7);

  const uInner = uniform(new THREE.Color(innerHex));
  const uOuter = uniform(new THREE.Color(outerHex));
  const uGlow = uniform(float(glow));
  const uStemBase = uniform(new THREE.Color("#1f5c32"));
  const uStemTop = uniform(new THREE.Color("#6bae6e"));
  const uLightDir = uniform(new THREE.Vector3(5, 10, 5).normalize());
  const uAmbient = uniform(float(0.45));
  const uDiffuse = uniform(float(0.55));
  const uBacklit = uniform(float(0.65));
  const uAlphaCutoff = uniform(float(0.35));
  const uAlphaSoft = uniform(float(0.08));

  const aFlowerPart = attribute("flowerPart", "float");
  const aStemT = attribute("stemT", "float");
  /** Per-instance world XZ (ground contact); InstancedMesh + positionNode lacks reliable instance world matrix. */
  const aInstanceXZ = attribute("instanceFleurXZ", "vec2");
  const aPivotY = attribute("interactPivotY", "float");
  const isStem = aFlowerPart.greaterThan(float(0.5));

  const uvCoord = uv();

  const texSample = texture(alphaTex, uvCoord);
  const inBounds = and(
    uvCoord.x.greaterThan(0),
    uvCoord.x.lessThan(1),
    uvCoord.y.greaterThan(0),
    uvCoord.y.lessThan(1),
  );
  const rgbMax = texSample.r.max(texSample.g).max(texSample.b);
  const alphaFromTex = texSample.a.add(
    rgbMax.mul(float(1).sub(step(float(0.001), texSample.a))),
  );
  const safeAlpha = inBounds.select(alphaFromTex, float(0));
  const softMask = smoothstep(
    uAlphaCutoff.sub(uAlphaSoft),
    uAlphaCutoff.add(uAlphaSoft),
    safeAlpha,
  );

  const radial = uvCoord.sub(vec2(0.5, 0.5)).length().mul(2).clamp(0, 1);
  const base = mix(uInner, uOuter, radial);
  const centerBoost = mix(float(1.0), float(1.6), radial.oneMinus().mul(uGlow));
  const procColor = base.mul(centerBoost);

  const nDotL = normalWorld.normalize().dot(uLightDir.normalize()).toVar();
  const front = nDotL.max(float(0.0));
  const back = nDotL.negate().max(float(0.0));
  const litFac = uAmbient.add(front.mul(uDiffuse)).add(back.mul(uBacklit));

  const stemBaseColor = mix(uStemBase, uStemTop, aStemT);
  const baseForLit = isStem.select(stemBaseColor, procColor);
  const litCol = baseForLit.mul(litFac);

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.colorNode = litCol;
  mat.opacityNode = isStem.select(float(1), softMask);
  mat.alphaTestNode = float(0.02);
  mat.transparent = true;
  mat.depthWrite = true;
  mat.side = THREE.DoubleSide;

  // Static stem lean (vertex-varying) + rigid whole-fleur tilt vs player (same angle on stem + bloom).
  mat.positionNode = Fn(() => {
    const flex = aStemT
      .mul(pow(float(1).sub(aStemT), float(1.75)))
      .mul(float(8.35));
    const amp = flex.mul(aFlowerPart);
    const staticLean = vec3(uStemStaticCurve.mul(amp), float(0), float(0));

    const pivot = vec3(float(0), aPivotY, float(0));

    const playerXZ = vec2(uPlayerPos.x, uPlayerPos.z);
    const bladeXZ = aInstanceXZ;
    const pDist = length(bladeXZ.sub(playerXZ));
    const pFall = mix(
      float(1),
      float(0),
      smoothstep(float(0.35), uInteractionRadius, pDist),
    );
    const pAng = negate(mix(float(0), uInteractionStrength, pFall)).mul(
      uRepulseGain,
    );
    const pTo = normalize(
      vec3(
        playerXZ.x.sub(bladeXZ.x),
        float(0),
        playerXZ.y.sub(bladeXZ.y),
      ).add(vec3(float(0.001), float(0), float(0.001))),
    );
    const pAxW = vec3(pTo.z, float(0), negate(pTo.x));
    const pAx = normalize(
      modelWorldMatrixInverse.mul(vec4(pAxW, float(0))).xyz,
    );

    // Idle wind: small rigid sway about the foot pivot (before player tilt).
    const windAx = normalize(
      modelWorldMatrixInverse.mul(vec4(float(1), float(0), float(0), float(0))).xyz,
    );
    const tW = uFleurTime.mul(uWindSpeed);
    const windAng = sin(tW)
      .mul(uWindAmp)
      .add(sin(tW.mul(float(2.17))).mul(uWindAmp).mul(float(0.31)));
    const pArmW = positionLocal.sub(pivot);
    const cW = cos(windAng);
    const sW = sin(windAng);
    const pDotW = dot(pArmW, windAx);
    const pCrossW = vec3(
      windAx.y.mul(pArmW.z).sub(windAx.z.mul(pArmW.y)),
      windAx.z.mul(pArmW.x).sub(windAx.x.mul(pArmW.z)),
      windAx.x.mul(pArmW.y).sub(windAx.y.mul(pArmW.x)),
    );
    const pWindRel = vec3(
      pArmW.x.mul(cW).add(pCrossW.x.mul(sW)).add(windAx.x.mul(pDotW).mul(float(1).sub(cW))),
      pArmW.y.mul(cW).add(pCrossW.y.mul(sW)).add(windAx.y.mul(pDotW).mul(float(1).sub(cW))),
      pArmW.z.mul(cW).add(pCrossW.z.mul(sW)).add(windAx.z.mul(pDotW).mul(float(1).sub(cW))),
    );
    const pAfterWind = pWindRel.add(pivot);

    // Player tilt: same rigid rod, stacked on wind.
    const intAngle = pAng;
    const pArm = pAfterWind.sub(pivot);
    const cI = cos(intAngle);
    const sI = sin(intAngle);
    const pDotAx = dot(pArm, pAx);
    const pCrossAx = vec3(
      pAx.y.mul(pArm.z).sub(pAx.z.mul(pArm.y)),
      pAx.z.mul(pArm.x).sub(pAx.x.mul(pArm.z)),
      pAx.x.mul(pArm.y).sub(pAx.y.mul(pArm.x)),
    );
    const pRotRel = vec3(
      pArm.x.mul(cI).add(pCrossAx.x.mul(sI)).add(pAx.x.mul(pDotAx).mul(float(1).sub(cI))),
      pArm.y.mul(cI).add(pCrossAx.y.mul(sI)).add(pAx.y.mul(pDotAx).mul(float(1).sub(cI))),
      pArm.z.mul(cI).add(pCrossAx.z.mul(sI)).add(pAx.z.mul(pDotAx).mul(float(1).sub(cI))),
    );
    const pRigid = pRotRel.add(pivot);

    return pRigid.add(staticLean);
  })();

  mat._uInner = uInner;
  mat._uOuter = uOuter;
  mat._uGlow = uGlow;
  mat._uStemBase = uStemBase;
  mat._uStemTop = uStemTop;
  mat._uStemStaticCurve = uStemStaticCurve;

  return mat;
}

function configureAlphaTexture(t) {
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
}

function cellKey(cx, cz, variant, maskIndex, colorSlot) {
  const letter = colorSlot === 0 ? "A" : "B";
  return `${cx}|${cz}|${variant}|${maskIndex}|${letter}`;
}

function parseCellKey(key) {
  const p = key.split("|");
  return {
    cx: parseInt(p[0], 10),
    cz: parseInt(p[1], 10),
    variant: p[2],
    maskIndex: parseInt(p[3], 10),
    letter: p[4],
  };
}

export function createFleurSystem(
  scene,
  sampleHeight,
  onReady,
) {
  let positions = [];
  const dummy = new THREE.Object3D();

  // ── Spatial hash for fast min-spacing checks ──
  const _GRID_CELL = 2; // cell size ≥ max minSpacing you'd ever use
  const _spatialGrid = new Map(); // "gx|gz" → [index, ...]
  function _gridKey(gx, gz) { return gx + "|" + gz; }
  function _toGrid(v) { return Math.floor(v / _GRID_CELL); }
  function _spatialRebuild() {
    _spatialGrid.clear();
    for (let i = 0; i < positions.length; i++) {
      const gx = _toGrid(positions[i].x), gz = _toGrid(positions[i].z);
      const k = _gridKey(gx, gz);
      let arr = _spatialGrid.get(k);
      if (!arr) { arr = []; _spatialGrid.set(k, arr); }
      arr.push(i);
    }
  }
  function _spatialAdd(idx) {
    const p = positions[idx];
    const gx = _toGrid(p.x), gz = _toGrid(p.z);
    const k = _gridKey(gx, gz);
    let arr = _spatialGrid.get(k);
    if (!arr) { arr = []; _spatialGrid.set(k, arr); }
    arr.push(idx);
  }
  function _spatialHasTooClose(x, z, minSq) {
    const gx = _toGrid(x), gz = _toGrid(z);
    const r = Math.ceil(Math.sqrt(minSq) / _GRID_CELL);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const arr = _spatialGrid.get(_gridKey(gx + dx, gz + dz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const p = positions[arr[i]];
          const ex = p.x - x, ez = p.z - z;
          if (ex * ex + ez * ez < minSq) return true;
        }
      }
    }
    return false;
  }

  // ── Debounced rebuild — at most once per frame ──
  let _rebuildScheduled = false;
  function _scheduleRebuild() {
    if (_rebuildScheduled) return;
    _rebuildScheduled = true;
    requestAnimationFrame(() => {
      _rebuildScheduled = false;
      rebuild();
    });
  }

  const uStemStaticCurve = uniform(0.1);
  /** Fleur-only interaction scale (subtle repulse). */
  const uFleurRepulseGain = uniform(0.85);

  // ── Own interaction uniforms (independent of gemini grass) ──
  const uPlayerPos = uniform(new THREE.Vector3(0, 9999, 0));
  const uInteractionRadius = uniform(1.5);
  const uInteractionStrength = uniform(0.4);
  const uFleurTime = uniform(0);
  /** Max wind sway (radians), rigid about pivot. */
  const uWindAmp = uniform(0.042);
  const uWindSpeed = uniform(1.12);

  let geoGround = null;
  let geoStemmed = null;
  /** Cached local positions of merged stem mesh (for accurate ground contact per rot/scale). */
  let stemLocalVerts = null;

  const _fleurZero = new THREE.Vector3(0, 0, 0);
  const _fleurEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const _fleurQuat = new THREE.Quaternion();
  const _fleurScaleV = new THREE.Vector3();
  const _fleurMatRS = new THREE.Matrix4();
  const _fleurTmpV = new THREE.Vector3();

  function stemMinRelY(scale, rot) {
    if (!stemLocalVerts || stemLocalVerts.length === 0) return 0;
    _fleurEuler.set(Math.PI, rot, 0, "XYZ");
    _fleurQuat.setFromEuler(_fleurEuler);
    _fleurScaleV.set(scale, scale, scale);
    _fleurMatRS.compose(_fleurZero, _fleurQuat, _fleurScaleV);
    let minY = Infinity;
    for (let i = 0; i < stemLocalVerts.length; i++) {
      _fleurTmpV.copy(stemLocalVerts[i]).applyMatrix4(_fleurMatRS);
      if (_fleurTmpV.y < minY) minY = _fleurTmpV.y;
    }
    return Number.isFinite(minY) ? minY : 0;
  }

  const matsA = [];
  const matsB = [];
  const chunks = new Map();

  function chunkCoord(x, z) {
    return {
      cx: Math.floor(x / CHUNK_SIZE),
      cz: Math.floor(z / CHUNK_SIZE),
    };
  }

  function makeIM(geo, mat, cap) {
    const g = geo.clone();
    g.setAttribute(
      "instanceFleurXZ",
      new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2),
    );
    const im = new THREE.InstancedMesh(g, mat, cap);
    im.castShadow = false;
    im.receiveShadow = false;
    im.frustumCulled = true;
    im.count = 0;
    scene.add(im);
    return im;
  }

  function getGeo(variant) {
    return variant === "stem" ? geoStemmed : geoGround;
  }

  function getMat(colorSlot, maskIndex) {
    const m = Math.max(0, Math.min(FLEUR_MASK_COUNT - 1, maskIndex | 0));
    return colorSlot === 0 ? matsA[m] : matsB[m];
  }

  function rebuild() {
    if (!geoGround || matsA.length === 0) return;
    const groups = new Map();
    positions.forEach((pos, idx) => {
      const { cx, cz } = chunkCoord(pos.x, pos.z);
      const variant = pos.variant === "stem" ? "stem" : "ground";
      const maskIndex = Math.max(
        0,
        Math.min(FLEUR_MASK_COUNT - 1, pos.maskIndex | 0),
      );
      const k = cellKey(cx, cz, variant, maskIndex, pos.colorSlot);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(idx);
    });

    for (const key of [...chunks.keys()]) {
      if (!groups.has(key)) {
        scene.remove(chunks.get(key).im);
        chunks.delete(key);
      }
    }

    for (const [key, indices] of groups) {
      const { variant, maskIndex, letter } = parseCellKey(key);
      const colorSlot = letter === "A" ? 0 : 1;
      const count = indices.length;
      let cell = chunks.get(key);
      const geo = getGeo(variant);
      const mat = getMat(colorSlot, maskIndex);

      if (!cell || count > cell.cap) {
        if (cell) scene.remove(cell.im);
        const cap = count + 32;
        cell = { im: makeIM(geo, mat, cap), cap };
        chunks.set(key, cell);
      } else if (cell.im.geometry !== geo || cell.im.material !== mat) {
        scene.remove(cell.im);
        cell.im = makeIM(geo, mat, cell.cap);
        chunks.set(key, cell);
      }

      cell.im.count = count;
      const im = cell.im;
      const ixAttr = im.geometry.getAttribute("instanceFleurXZ");
      const stemChunk = variant === "stem";
      for (let i = 0; i < count; i++) {
        const { x, z, rot, scale, yOffset } = positions[indices[i]];
        let groundY = sampleHeight(x, z) + (stemChunk ? 0 : yOffset);
        if (stemChunk)
          groundY += -stemMinRelY(scale, rot) + FLEUR_STEM_GROUND_BIAS;
        dummy.position.set(x, groundY, z);
        dummy.rotation.set(Math.PI, rot, 0);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
        ixAttr.setXY(i, x, z);
      }
      im.instanceMatrix.needsUpdate = true;
      ixAttr.needsUpdate = true;
      im.computeBoundingSphere();
    }
  }

  function addInBrush(
    cx,
    cz,
    radius,
    perStroke,
    minSpacing,
    scaleMin,
    scaleMax,
    hoverBase,
    hoverVariance,
    colorSlot,
    variant,
    maskIndex,
  ) {
    const v = variant === "stem" ? "stem" : "ground";
    const m = Math.max(0, Math.min(FLEUR_MASK_COUNT - 1, maskIndex | 0));
    const minSq = minSpacing * minSpacing;
    let added = 0;
    for (let attempt = 0; attempt < perStroke * 4 && added < perStroke; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const x = cx + Math.cos(angle) * r;
      const z = cz + Math.sin(angle) * r;

      if (_spatialHasTooClose(x, z, minSq)) continue;

      const yOffset =
        v === "stem"
          ? 0
          : hoverBase + (Math.random() - 0.5) * 2 * hoverVariance;
      const idx = positions.length;
      positions.push({
        x,
        z,
        rot: Math.random() * Math.PI * 2,
        scale: scaleMin + Math.random() * (scaleMax - scaleMin),
        yOffset,
        colorSlot,
        variant: v,
        maskIndex: m,
      });
      _spatialAdd(idx);
      added++;
      if (positions.length >= MAX_FLEURS) break;
    }
    if (added > 0) _scheduleRebuild();
    return added;
  }

  function removeInBrush(cx, cz, radius) {
    const rSq = radius * radius;
    const before = positions.length;
    positions = positions.filter(({ x, z }) => {
      const dx = x - cx,
        dz = z - cz;
      return dx * dx + dz * dz > rSq;
    });
    if (positions.length !== before) {
      _spatialRebuild();
      _scheduleRebuild();
    }
  }

  function syncHeights() {
    rebuild();
  }

  function setColorA(innerHex, outerHex, glow) {
    for (const mat of matsA) {
      mat._uInner.value.set(innerHex);
      mat._uOuter.value.set(outerHex);
      mat._uGlow.value = glow;
    }
  }

  function setColorB(innerHex, outerHex, glow) {
    for (const mat of matsB) {
      mat._uInner.value.set(innerHex);
      mat._uOuter.value.set(outerHex);
      mat._uGlow.value = glow;
    }
  }

  function setStemColors(baseHex, topHex) {
    if (matsA.length === 0) return;
    for (const mat of [...matsA, ...matsB]) {
      mat._uStemBase.value.set(baseHex);
      mat._uStemTop.value.set(topHex);
    }
  }

  function setStemStaticCurve(v) {
    uStemStaticCurve.value = v;
  }

  function getPositions() {
    return positions.map((p) => ({ ...p }));
  }

  function setPositions(arr) {
    positions = arr.map((p) => {
      const stem = p.variant === "stem";
      return {
        x: p.x,
        z: p.z,
        rot: p.rot,
        scale: p.scale,
        yOffset: stem ? 0 : (p.yOffset ?? 0.15),
        colorSlot: p.colorSlot ?? 0,
        variant: stem ? "stem" : "ground",
        maskIndex: Math.max(
          0,
          Math.min(FLEUR_MASK_COUNT - 1, p.maskIndex ?? 0),
        ),
      };
    });
    _spatialRebuild();
    rebuild();
  }

  function clear() {
    positions = [];
    _spatialGrid.clear();
    rebuild();
  }

  function getCount() {
    return positions.length;
  }

  const _frustum = new THREE.Frustum();
  const _projScreenMatrix = new THREE.Matrix4();

  function getChunkStats(camera) {
    if (chunks.size === 0) return { visible: 0, total: 0 };
    _projScreenMatrix.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    _frustum.setFromProjectionMatrix(_projScreenMatrix);

    const occupied = new Set();
    const visibleBases = new Set();
    for (const [fk, { im }] of chunks) {
      if (im.count <= 0) continue;
      const p = parseCellKey(fk);
      const base = `${p.cx}|${p.cz}`;
      occupied.add(base);
      if (
        im.boundingSphere &&
        _frustum.intersectsSphere(im.boundingSphere)
      ) {
        visibleBases.add(base);
      }
    }
    return { visible: visibleBases.size, total: occupied.size };
  }

  const textures = [];
  for (let i = 0; i < FLEUR_MASK_COUNT; i++) {
    const t = new THREE.Texture();
    configureAlphaTexture(t);
    textures.push(t);
  }

  function bootstrapMaterials() {
    if (geoGround) return;
    geoGround = createBloomGeometry();
    addInteractPivotYAttribute(geoGround);
    geoStemmed = createMergedFlowerGeometry();
    addInteractPivotYAttribute(geoStemmed);
    const sp = geoStemmed.attributes.position;
    stemLocalVerts = [];
    for (let i = 0; i < sp.count; i++) {
      stemLocalVerts.push(
        new THREE.Vector3(sp.getX(i), sp.getY(i), sp.getZ(i)),
      );
    }
    const matOpts = {
      uPlayerPos,
      uInteractionRadius,
      uInteractionStrength,
      uStemStaticCurve,
      uFleurRepulseGain,
      uFleurTime,
      uWindAmp,
      uWindSpeed,
    };
    for (let i = 0; i < FLEUR_MASK_COUNT; i++) {
      matsA.push(
        createFleurMaterial(
          FLEUR_PRESETS.main.inner,
          FLEUR_PRESETS.main.outer,
          FLEUR_PRESETS.main.glow,
          textures[i],
          matOpts,
        ),
      );
      matsB.push(
        createFleurMaterial(
          FLEUR_PRESETS.sakura.inner,
          FLEUR_PRESETS.sakura.outer,
          FLEUR_PRESETS.sakura.glow,
          textures[i],
          matOpts,
        ),
      );
    }
    if (positions.length > 0) {
      _spatialRebuild();
      rebuild();
    }
    if (typeof onReady === "function") onReady();
  }

  const im0 = new Image();
  im0.onload = () => {
    for (const t of textures) {
      t.image = im0;
      t.needsUpdate = true;
    }
    bootstrapMaterials();
    for (let i = 1; i < FLEUR_MASK_COUNT; i++) {
      const im = new Image();
      const slot = i;
      im.onload = () => {
        textures[slot].image = im;
        textures[slot].needsUpdate = true;
      };
      im.onerror = () => {};
      im.src = FLEUR_ALPHA_URLS[i];
    }
  };
  im0.onerror = () => {
    console.warn(
      "[fleur-painter] Alpha texture missing — fleurs may be invisible:",
      FLEUR_ALPHA_URLS[0],
    );
    bootstrapMaterials();
  };
  im0.src = FLEUR_ALPHA_URLS[0];

  return {
    addInBrush,
    removeInBrush,
    syncHeights,
    setColorA,
    setColorB,
    setStemColors,
    setStemStaticCurve,
    setRepulseGain(g) {
      uFleurRepulseGain.value = g;
    },
    /**
     * @param {THREE.Vector3|null|undefined} playerWorldPos
     * @param {number} [timeSec] — clock elapsed for wind; omit to leave time unchanged
     */
    update(playerWorldPos, timeSec) {
      if (timeSec !== undefined && timeSec !== null)
        uFleurTime.value = timeSec;
      if (playerWorldPos) {
        uPlayerPos.value.set(playerWorldPos.x, playerWorldPos.y, playerWorldPos.z);
      } else {
        uPlayerPos.value.set(0, 9999, 0);
      }
    },
    setInteractionRadius(r) { uInteractionRadius.value = r; },
    setInteractionStrength(s) { uInteractionStrength.value = s; },
    setWindAmp(a) { uWindAmp.value = a; },
    setWindSpeed(s) { uWindSpeed.value = s; },
    getPositions,
    setPositions,
    clear,
    getCount,
    getChunkStats,
  };
}
