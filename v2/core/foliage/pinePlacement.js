/**
 * Shared pine/whorl placement math — single source of truth for
 * v2/pine-editor33.html (authoring) and presetLoader.js (v2/v3 runtime).
 *
 * A "pine" foliage layout is rings (whorls) of oriented leaf cards around a
 * procedural trunk spine. The same layout also covers palms, conifers and
 * trunk-less ground plants (ferns = rings near baseY with the trunk hidden).
 *
 * All math here must stay byte-identical between editor and runtime so a
 * preset authored in the editor reproduces exactly in-game. Do not "improve"
 * formulas in one place only.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const DEG = Math.PI / 180;

/** Slider floor — was 0.02 and looked too thick at the tip. */
export const TRUNK_RADIUS_MIN = 0.003;

// ── Trunk spine ──────────────────────────────────────────────────────────────

export function trunkHeightT(y, trunk) {
  const H = Math.max(0.15, trunk.height);
  const y0 = trunk.yOffset;
  return THREE.MathUtils.clamp((y - y0) / H, 0, 1);
}

export function trunkRadiusAtT(t, trunk) {
  return THREE.MathUtils.lerp(
    trunk.radiusBottom,
    trunk.radiusTop,
    THREE.MathUtils.clamp(t, 0, 1),
  );
}

/** Lateral bow along trunk; base + tip stay on vertical axis (not tip-lean). */
export function trunkSpineParams(trunk) {
  let bend = trunk.curveBend ?? 0;
  let s = trunk.curveS ?? 0;
  let angleRad = (trunk.curveAngleDeg ?? 0) * DEG;
  const lx = trunk.curveX ?? 0;
  const lz = trunk.curveZ ?? 0;
  if (
    bend < 1e-6 &&
    s < 1e-6 &&
    (Math.abs(lx) > 1e-5 || Math.abs(lz) > 1e-5)
  ) {
    bend = Math.hypot(lx, lz) * 0.45;
    angleRad = Math.atan2(lz, lx);
  }
  return { bend, s, angleRad };
}

export function trunkHasSpineCurve(trunk) {
  const { bend, s } = trunkSpineParams(trunk);
  return bend > 1e-5 || Math.abs(s) > 1e-5;
}

export function trunkCenterAtT(t, trunk, target) {
  const H = Math.max(0.15, trunk.height);
  const y0 = trunk.yOffset;
  const u = THREE.MathUtils.clamp(t, 0, 1);
  const { bend, s, angleRad } = trunkSpineParams(trunk);
  const wC = Math.sin(Math.PI * u);
  const wS = s * Math.sin(2 * Math.PI * u);
  const lateral = bend * (wC + wS);
  const cx = Math.cos(angleRad);
  const cz = Math.sin(angleRad);
  return target.set(cx * lateral, y0 + H * u, cz * lateral);
}

export function trunkTangentAtT(t, trunk, target) {
  const H = Math.max(0.15, trunk.height);
  const u = THREE.MathUtils.clamp(t, 0, 1);
  const { bend, s, angleRad } = trunkSpineParams(trunk);
  const dLateral =
    bend *
    (Math.PI * Math.cos(Math.PI * u) +
      s * 2 * Math.PI * Math.cos(2 * Math.PI * u));
  const cx = Math.cos(angleRad);
  const cz = Math.sin(angleRad);
  target.set(cx * dLateral, H, cz * dLateral);
  const len = target.length();
  if (len > 1e-6) target.multiplyScalar(1 / len);
  else target.set(0, 1, 0);
  return target;
}

const _yAxis = new THREE.Vector3(0, 1, 0);
const _tan = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();

export function trunkOutwardAtT(t, thetaRad, trunk, target) {
  trunkTangentAtT(t, trunk, _tan);
  _right.crossVectors(_yAxis, _tan);
  if (_right.lengthSq() < 1e-8) _right.set(1, 0, 0);
  _right.normalize();
  _fwd.crossVectors(_tan, _right).normalize();
  return target
    .copy(_right)
    .multiplyScalar(Math.cos(thetaRad))
    .addScaledVector(_fwd, Math.sin(thetaRad));
}

export function trunkPathSegmentCount(trunk) {
  const manual = Math.round(trunk.pathSegs ?? 0);
  if (manual >= 4) return Math.min(64, manual);
  const H = Math.max(0.15, trunk.height);
  const { bend, s } = trunkSpineParams(trunk);
  const curve = bend + Math.abs(s) * 0.5;
  return THREE.MathUtils.clamp(
    Math.ceil(H * 4) + Math.ceil(curve * 12),
    4,
    48,
  );
}

// ── Trunk geometry ───────────────────────────────────────────────────────────

/** Cap disc perpendicular to `dir` at `center` (used to close the trunk tube). */
function trunkCapGeometry(radius, radialSegs, center, dir) {
  const geo = new THREE.CircleGeometry(radius, radialSegs);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    dir,
  );
  geo.applyQuaternion(q);
  geo.translate(center.x, center.y, center.z);
  return geo;
}

const _segP0 = new THREE.Vector3();
const _segP1 = new THREE.Vector3();
const _segDir = new THREE.Vector3();
const _segCenter = new THREE.Vector3();
const _segQuat = new THREE.Quaternion();
const _segMat = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _capDir = new THREE.Vector3();

/**
 * Procedural pine trunk in trunk-local space (base sits at trunk.yOffset —
 * no mesh offset needed; the mesh position should stay at the origin).
 *
 * Curved spines merge OPEN-ENDED cylinder segments plus one base and one tip
 * cap. Per-segment closed caps (the old editor path) buried ~radialSegs×2
 * hidden triangles inside the trunk for EVERY segment — on a default curved
 * trunk that was ~half of all trunk triangles.
 */
export function buildPineTrunkGeometry(trunk) {
  const H = Math.max(0.15, trunk.height);
  const radialSegs = Math.max(6, Math.round(trunk.radialSegs ?? 20));
  const r0 = Math.max(TRUNK_RADIUS_MIN, trunk.radiusBottom);
  const r1 = Math.max(TRUNK_RADIUS_MIN, trunk.radiusTop);

  const straightGeo = () => {
    const geo = new THREE.CylinderGeometry(r1, r0, H, radialSegs);
    geo.translate(0, trunk.yOffset + H * 0.5, 0);
    return geo;
  };
  if (!trunkHasSpineCurve(trunk)) return straightGeo();

  const segs = trunkPathSegmentCount(trunk);
  const parts = [];
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs;
    const t1 = (i + 1) / segs;
    trunkCenterAtT(t0, trunk, _segP0);
    trunkCenterAtT(t1, trunk, _segP1);
    const sr0 = Math.max(TRUNK_RADIUS_MIN, trunkRadiusAtT(t0, trunk));
    const sr1 = Math.max(TRUNK_RADIUS_MIN, trunkRadiusAtT(t1, trunk));
    _segDir.subVectors(_segP1, _segP0);
    const len = _segDir.length();
    if (len < 1e-5) continue;
    _segDir.normalize();
    _segCenter.addVectors(_segP0, _segP1).multiplyScalar(0.5);
    // openEnded — the tube is closed once at the base and once at the tip below.
    const cyl = new THREE.CylinderGeometry(sr1, sr0, len, radialSegs, 1, true);
    _segQuat.setFromUnitVectors(_yAxis, _segDir);
    _segMat.compose(_segCenter, _segQuat, _one);
    cyl.applyMatrix4(_segMat);
    parts.push(cyl);
  }
  if (parts.length === 0) return straightGeo();

  trunkCenterAtT(0, trunk, _segP0);
  trunkTangentAtT(0, trunk, _capDir).negate();
  parts.push(trunkCapGeometry(r0, radialSegs, _segP0, _capDir));
  trunkCenterAtT(1, trunk, _segP1);
  trunkTangentAtT(1, trunk, _capDir);
  parts.push(trunkCapGeometry(r1, radialSegs, _segP1, _capDir));

  const merged = mergeGeometries(parts);
  for (const g of parts) {
    if (g !== merged) g.dispose();
  }
  return merged ?? straightGeo();
}

// ── Card geometry ────────────────────────────────────────────────────────────

/** Rotate UVs in 90° steps (geometry.rotateY does not update uv). */
export function rotateGeometryUV(geo, quarterTurns) {
  const uv = geo.attributes.uv;
  if (!uv) return;
  const n = ((Math.round(quarterTurns) % 4) + 4) % 4;
  if (n === 0) return;
  for (let i = 0; i < uv.count; i++) {
    let u = uv.getX(i);
    let v = uv.getY(i);
    for (let t = 0; t < n; t++) {
      const nu = v;
      const nv = 1 - u;
      u = nu;
      v = nv;
    }
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}

/**
 * Build in centered XY (normal +Z), deform, move chosen edge midpoint to origin, then rotate +90° Y so:
 * — plane is perpendicular to trunk (world Y): lies in XZ… after rot, spans Y + tangential Z, normal ≈ −X toward trunk.
 * — pivot sits on the short-edge center (default: left edge if width ≥ height) for a clean trunk attach.
 */
export function createRectangleGeometry(w, h, segX, segY, shape, pivotEdge) {
  const { bendX, bendY, skewX, skewY, taperX } = shape;
  const geo = new THREE.PlaneGeometry(w, h, segX, segY);
  const pos = geo.attributes.position;
  const hw = w * 0.5;
  const hh = h * 0.5;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    const nx = hw > 1e-6 ? x / hw : 0;
    const ny = hh > 1e-6 ? y / hh : 0;
    const scaleX = 1 + taperX * ny;
    x *= scaleX;
    x += skewX * ny * hh;
    y += skewY * nx * hw;
    let z = pos.getZ(i);
    z += bendX * nx * nx;
    z += bendY * ny * ny;
    pos.setXYZ(i, x, y, z);
  }

  let edge = pivotEdge;
  if (edge === "auto") edge = w >= h ? "left" : "bottom";
  let px = 0;
  let py = 0;
  const pz = 0;
  switch (edge) {
    case "bottom":
      px = 0;
      py = hh;
      break;
    case "top":
      px = 0;
      py = -hh;
      break;
    case "left":
      px = hw;
      py = 0;
      break;
    case "right":
      px = -hw;
      py = 0;
      break;
    default:
      px = hw;
      py = 0;
  }
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i, pos.getX(i) + px, pos.getY(i) + py, pos.getZ(i) + pz);
  }

  geo.rotateY(Math.PI / 2);
  rotateGeometryUV(geo, 1);
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Card geometry from a pine preset's rect/grid/shape blocks (clamps + bendY seg guard). */
export function createPineCardGeometry(rect, grid, shape) {
  const w = Math.max(0.05, rect.width);
  const h = Math.max(0.05, rect.height);
  const sx = Math.max(1, Math.round(grid.segX));
  let sy = Math.max(1, Math.round(grid.segY));
  // bendY uses ny² — needs an interior row (ny≈0). segY=1 puts every vert on y=±hh so ny²=1 everywhere.
  if (Math.abs(shape.bendY) > 1e-8) sy = Math.max(sy, 2);
  return createRectangleGeometry(w, h, sx, sy, shape, rect.pivotEdge ?? "auto");
}

// ── Ring / card distribution ─────────────────────────────────────────────────

/** Extra pitch (°) at this whorl, on top of transform.rotXDeg (see Card tilt). */
export function pineLevelPitchExtraDeg(level, levels, foliage) {
  if (foliage.pitchCurveEnabled === false) return 0;
  const tLin = levels <= 1 ? 0 : level / (levels - 1);
  const pow = Math.max(0.05, foliage.pitchCurvePower ?? 1);
  const t = Math.pow(tLin, pow);
  const b = foliage.pitchBottomDeg ?? 0;
  const top = foliage.pitchTopDeg ?? 0;
  return THREE.MathUtils.lerp(b, top, t);
}

/** Top whorl (level = levels−1) uses trunk tip; lower whorls lerp from baseY. */
export function pineRingTrunkT(level, levels, f, tr) {
  const n = Math.max(1, levels);
  if (n <= 1) return 1;
  const tLin = level / (n - 1);
  const yBase = f.baseY + (f.offsetY ?? 0);
  const tBottom = THREE.MathUtils.clamp(trunkHeightT(yBase, tr), 0, 1);
  const hPow = Math.max(0.05, f.heightPower ?? 1);
  return THREE.MathUtils.lerp(tBottom, 1, Math.pow(tLin, hPow));
}

/** Stable 0…1 hash for ring / card randomization (seed changes → reshuffle). */
export function foliageHash01(a, b, seed) {
  const s = Math.sin(a * 12.9898 + b * 78.233 + seed * 43.758) * 43758.5453;
  return s - Math.floor(s);
}

export function foliageRandomSignedDeg(a, b, seed, amount) {
  if (!amount) return 0;
  return (foliageHash01(a, b, seed) * 2 - 1) * amount;
}

// ── Placement ────────────────────────────────────────────────────────────────

const _euler = new THREE.Euler();
const _qCard = new THREE.Quaternion();
const _qAz = new THREE.Quaternion();
const _cardTan = new THREE.Vector3();

/**
 * Card orientation at azimuth theta: preset transform rotation (plus per-level
 * pitch) spun around the trunk tangent at that height.
 */
export function pineCardQuaternion(
  transform,
  trunk,
  thetaRad,
  pitchExtraDeg,
  trunkT,
  target,
) {
  _euler.set(
    (transform.rotXDeg + pitchExtraDeg) * DEG,
    transform.rotYDeg * DEG,
    transform.rotZDeg * DEG,
    "XYZ",
  );
  _qCard.setFromEuler(_euler);
  trunkTangentAtT(trunkT, trunk, _cardTan);
  _qAz.setFromAxisAngle(_cardTan, thetaRad);
  return target.copy(_qAz).multiply(_qCard);
}

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _out = new THREE.Vector3();
const _jitTan = new THREE.Vector3();

/**
 * Visit each card placement in trunk-local space.
 * pine = { foliage, trunk, transform } (the preset's `pine` block).
 * options: { keepFraction = 1, xOffset = 0, scaleMul = 1 }.
 * visit(position: Vector3, quaternion: Quaternion, scale: number) — position
 * and quaternion are scratch objects, copy them if you keep references.
 * Returns the number of cards visited.
 */
export function forEachPineCardPlacement(pine, options, visit) {
  const f = pine.foliage;
  const tr = pine.trunk;
  const transform = pine.transform;
  const levels = Math.max(1, Math.round(f.levels));
  const perRing = Math.max(1, Math.round(f.perRing));
  const keepFraction = options.keepFraction ?? 1;
  const keepStep =
    keepFraction >= 1 ? 1 : Math.max(1, Math.round(1 / keepFraction));
  const xOffset = options.xOffset ?? 0;
  const scaleMul = options.scaleMul ?? 1;
  const pow = Math.max(0.05, f.scalePower);
  const gScale =
    Number.isFinite(f.globalScale) && f.globalScale > 0 ? f.globalScale : 1;
  let logical = 0;
  let count = 0;

  for (let level = 0; level < levels; level++) {
    const tLin = levels <= 1 ? 1 : level / (levels - 1);
    const u = Math.pow(tLin, pow);
    const sRing = (f.scaleBottom * (1 - u) + f.scaleTop * u) * gScale;
    const trunkT = pineRingTrunkT(level, levels, f, tr);
    const R = Math.max(0.001, trunkRadiusAtT(trunkT, tr) - f.radialInset);
    const along = THREE.MathUtils.clamp(
      Number.isFinite(f.pivotAlongRadius) ? f.pivotAlongRadius : 0,
      0,
      1,
    );
    const ringRand = foliageRandomSignedDeg(
      level,
      0,
      f.ringRandomSeed,
      f.ringRandomDeg,
    );
    for (let k = 0; k < perRing; k++) {
      if (keepFraction >= 1 || logical % keepStep === 0) {
        const cardRand = foliageRandomSignedDeg(
          level,
          k + 1,
          f.ringRandomSeed,
          f.cardRandomDeg,
        );
        const thetaDeg =
          f.azimuthOffsetDeg +
          (k * 360) / perRing +
          f.staggerDeg * level +
          ringRand +
          cardRand;
        const theta = thetaDeg * DEG;
        const seed = f.ringRandomSeed;
        const pitchJit = foliageRandomSignedDeg(
          level,
          k + 40,
          seed,
          f.leafPitchRandomDeg,
        );
        const levelPitch = pineLevelPitchExtraDeg(level, levels, f);
        const yJit = foliageRandomSignedDeg(level, k + 50, seed, f.leafYRandom);
        const scaleJit = foliageRandomSignedDeg(
          level,
          k + 60,
          seed,
          f.leafScaleRandom,
        );
        trunkCenterAtT(trunkT, tr, _pos);
        if (level === levels - 1) {
          const slide = f.tipRingSlide ?? 0;
          if (Math.abs(slide) > 1e-6) {
            trunkTangentAtT(trunkT, tr, _jitTan);
            _pos.addScaledVector(_jitTan, slide);
          }
        }
        trunkOutwardAtT(trunkT, theta, tr, _out);
        _pos.addScaledVector(_out, along * R);
        _pos.x += f.offsetX + xOffset;
        _pos.z += f.offsetZ;
        if (Math.abs(yJit) > 1e-6) {
          trunkTangentAtT(trunkT, tr, _jitTan);
          _pos.addScaledVector(_jitTan, yJit);
        }
        const s = Math.max(0.02, sRing * (1 + scaleJit) * scaleMul);
        pineCardQuaternion(transform, tr, theta, levelPitch + pitchJit, trunkT, _quat);
        visit(_pos, _quat, s);
        count++;
      }
      logical++;
    }
  }

  return count;
}

export function countPineCards(pine, keepFraction = 1) {
  return forEachPineCardPlacement(pine, { keepFraction }, () => {});
}

/**
 * Canopy bounds from card placements (same margins as the editor).
 * invS converts authored space → trunk-local slot space (see buildPineFoliageLods).
 */
export function computePineFoliageBounds(pine, rect, invS = 1) {
  const cardExt =
    Math.max(Math.max(0.05, rect.width), Math.max(0.05, rect.height)) *
    0.55 *
    invS;
  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity,
    zMin = Infinity,
    zMax = -Infinity;
  let n = 0;
  forEachPineCardPlacement(pine, {}, (pos, quat, scale) => {
    const e = cardExt * scale;
    const px = pos.x * invS;
    const py = pos.y * invS;
    const pz = pos.z * invS;
    xMin = Math.min(xMin, px - e);
    xMax = Math.max(xMax, px + e);
    yMin = Math.min(yMin, py - e);
    yMax = Math.max(yMax, py + e);
    zMin = Math.min(zMin, pz - e);
    zMax = Math.max(zMax, pz + e);
    n++;
  });
  if (n === 0) return null;
  const cx = (xMin + xMax) * 0.5;
  const cy = (yMin + yMax) * 0.5;
  const cz = (zMin + zMax) * 0.5;
  const ext = Math.max(xMax - xMin, yMax - yMin, zMax - zMin);
  return {
    yMin: yMin - 0.3,
    yMax: yMax + 0.5,
    canopyCenter: new THREE.Vector3(cx, cy, cz),
    aoRadius: ext * 0.62,
  };
}

// ── Runtime LOD builder (foliageSampler lods contract) ───────────────────────

function createLcg(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Build the 3-tier lods array consumed by FoliageLodRenderer, from a pine
 * preset's `pine` block. Mirrors buildAllFoliageLods' output contract:
 *   { geometry, matrices, count, randData, centerData, scaleData, billboard:false }
 *
 * Tier densities match the pine editor's LOD preview: LOD0 = all cards,
 * LOD1 = every 2nd card at 1.414×, LOD2 = same subset as LOD1 (far shading
 * comes from the shared material's distance behavior, not a separate pass).
 *
 * trunkScale semantics match arborist: card placements are divided by
 * trunkScale so the tree instance matrix (which re-applies the slot scale)
 * lands them back in authored world size. Pine presets default to 1.
 */
export function buildPineFoliageLods(pine, options = {}) {
  const trunkScale = options.trunkScale ?? 1;
  const invS = trunkScale > 0.001 ? 1 / trunkScale : 1;
  const rect = options.rect ?? { width: 2, height: 0.95, pivotEdge: "auto" };
  const grid = options.grid ?? { segX: 4, segY: 2 };
  const shape =
    options.shape ?? { bendX: 0, bendY: 0, skewX: 0, skewY: 0, taperX: 0 };

  // Gather LOD0 placements once; tiers subset by the same logical stride the
  // editor uses (keepFraction), so LOD1/LOD2 are true subsets of LOD0.
  const placements = [];
  forEachPineCardPlacement(pine, { keepFraction: 1 }, (pos, quat, s) => {
    placements.push({
      x: pos.x * invS,
      y: pos.y * invS,
      z: pos.z * invS,
      qx: quat.x,
      qy: quat.y,
      qz: quat.z,
      qw: quat.w,
      s: s * invS,
    });
  });
  const n = placements.length;
  if (n === 0) return [null, null, null];

  // Per-card 2D random for the shared foliage shader (wind phase / color var).
  const rng = createLcg(77777);
  const rands = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    rands[i * 2] = rng();
    rands[i * 2 + 1] = rng();
  }

  const cardGeo = createPineCardGeometry(rect, grid, shape);
  const dummy = new THREE.Object3D();

  // (indices into placements, scale multiplier) per tier — LOD2 mirrors LOD1.
  const lod1Idx = [];
  for (let i = 0; i < n; i += 2) lod1Idx.push(i);
  const tiers = [
    { indices: null, sMul: 1 },
    { indices: lod1Idx, sMul: Math.SQRT2 },
    { indices: lod1Idx, sMul: Math.SQRT2 },
  ];

  const lods = [];
  for (const tier of tiers) {
    const idxList = tier.indices;
    const count = idxList ? idxList.length : n;
    if (count === 0) {
      lods.push(null);
      continue;
    }
    const mats = new Float32Array(count * 16);
    const rd = new Float32Array(count * 2);
    const cd = new Float32Array(count * 3);
    const sd = new Float32Array(count);
    for (let j = 0; j < count; j++) {
      const src = idxList ? idxList[j] : j;
      const p = placements[src];
      dummy.position.set(p.x, p.y, p.z);
      dummy.quaternion.set(p.qx, p.qy, p.qz, p.qw);
      dummy.scale.setScalar(p.s * tier.sMul);
      dummy.updateMatrix();
      dummy.matrix.toArray(mats, j * 16);
      rd[j * 2] = rands[src * 2];
      rd[j * 2 + 1] = rands[src * 2 + 1];
      cd[j * 3] = p.x;
      cd[j * 3 + 1] = p.y;
      cd[j * 3 + 2] = p.z;
      sd[j] = p.s * tier.sMul; // unused by the non-billboard shader path
    }
    const geo = cardGeo.clone();
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rd, 2));
    geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(cd, 3));
    geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(sd, 1));
    lods.push({
      geometry: geo,
      matrices: mats,
      count,
      randData: rd,
      centerData: cd,
      scaleData: sd,
      billboard: false,
    });
  }
  cardGeo.dispose(); // tiers cloned it; the template is no longer needed

  return lods;
}
