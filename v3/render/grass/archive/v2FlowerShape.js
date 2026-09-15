/**
 * ARCHIVE — the first flower mode's flower (v2, "fleur"), kept so it can be
 * brought back. NOT loaded by the engine; nothing imports this file.
 *
 * Copied verbatim 2026-09-15 from v2/core/legacy/fleur-painter.js (lines 9-411)
 * before v2 is deleted. Only `export` was added. The masks it samples are
 * public/textures/flowers/Flower32.png (star), Flower33.png (five petals) and
 * Flower34.png (daisy), listed in FLEUR_ALPHA_URLS.
 *
 * What it is: a low-poly cup (8 sides, 2 rings) whose top-down uv samples an
 * alpha silhouette PNG, coloured centre → edge (FLEUR_PRESETS), optionally
 * merged with a 6-sided stem; one rigid tilt for wind and player push; lit by
 * a fixed light direction; transparent + alpha test.
 *
 * How to use it again (the simple way): build createMergedFlowerGeometry() or
 * createBloomGeometry(), addInteractPivotYAttribute(geo), then
 * createFleurMaterial(inner, outer, glow, alphaTexture) and an InstancedMesh.
 * The InstancedMesh must also carry an `instanceFleurXZ` (vec2) instanced
 * attribute — each flower's world XZ — which the material reads for push.
 * v2's painter placed instances rotated by PI about X (the cup is modelled
 * upside down) with scale 0.4-0.7.
 *
 * Known issues (why v3 flowers replaced it — v3/AUDIT.md #99): faceted
 * shading, alpha-mask edge shimmer and no early depth rejection, fixed light,
 * in-phase wind, and the wind/push axes read the InstancedMesh matrix rather
 * than each instance's.
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
export const FLEUR_SHAPE = {
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

export const FLEUR_STEM = {
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

export function createBloomGeometry() {
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

export function createStemGeometry(shape, stem) {
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

export function createMergedFlowerGeometry() {
  const bloom = createBloomGeometry();
  const stemGeo = createStemGeometry(FLEUR_SHAPE, FLEUR_STEM);
  const merged = mergeGeometries([bloom, stemGeo], false);
  bloom.dispose();
  stemGeo.dispose();
  return merged;
}

/** Local Y of planted foot: min Y for ground blooms; stem-ground ring Y for stemmed (all verts same). */
export function addInteractPivotYAttribute(geo) {
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

export function createFleurMaterial(innerHex, outerHex, glow, alphaTex, matOpts) {
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
