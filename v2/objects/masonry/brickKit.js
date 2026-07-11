import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/**
 * BRICK KIT — portable procedural masonry generator (wall + arched opening).
 *
 * Canonical port of claude-zelda/brickBuildingKit.js + the arch-ring builder
 * from brick-material-lab.html (itself the medieval-arch-showcase layout).
 * Pure geometry: given params and an instanced-aware material it lays
 * GPU-instanced bricks and returns exact-count InstancedMeshes (one draw call
 * per mesh). Knows nothing about scene/UI/gizmos.
 *
 * Layout is collected into placement arrays first, then uploaded into an
 * exact-size InstancedMesh — no over-allocated capacity buffers, and the
 * placement arrays are kept on mesh.userData.brickPlacements so a future
 * erosion/destruction pass can re-order or evict bricks without re-running
 * the layout.
 *
 * Consumed by v2/masonry-lab.html first; the same module then backs the
 * objects-registry masonry entries (wall spline, towers, house, chapel).
 */

// ── Deterministic RNG (a given colorSeed always lays the same bricks) ──
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Defaults (layout only; texture/quality live in brickMaterial.js) ──
export const BRICK_WALL_DEFAULTS = {
  // Opening
  doorInnerHalfW: 1.15,
  masonryShell: 0.42,
  legHeight: 2.35,
  sillY: 0.02,
  closeBottom: false,
  spacingMul: 1.02,
  archAlong: 0,
  archAlongZ: -0.22,
  archRingDepthScale: 1.09,
  archShape: "round", // "round" | "pointed"
  archPointedness: 1.0,

  // Brick unit
  brickW: 0.52,
  brickH: 0.38,
  brickD: 0.55,
  brickRound: 0.02,
  roundSegments: 4, // lab default; drop to 1–2 for in-game vertex budget

  // Wall field
  wallEnabled: true,
  wallWidth: 15,
  wallHeight: 6.2,
  wallDepth: 0.62,
  wallZ: -0.22,
  wallMortar: 0.001,
  wallSeamInset: 0.038,
  wallMinBrickScale: 0.26,
  wallCrownSquash: 0.78,
  wallAnchorY: 0.02,
  planVariety: 0.35,
  depthRecess: 0.28,
  depthSpread: 0.75,
  // The showcase/lab shipped contour-hugging bricks (shrink near the arch
  // curve, crown squash, tuck) permanently disabled by a smoothstep argument-
  // order bug. 0 reproduces that approved look exactly; raise to fade the
  // repaired feature in.
  archContour: 0,

  // Caps + determinism
  maxBricks: 2200,
  maxWallBricks: 22000,
  colorSeed: 31415,
};

// ── Arch path math (round / pointed openings) ──
export function pointedArchGeom(R, k) {
  const c = R * Math.max(0, k);
  const r = c + R;
  const apexDy = Math.sqrt(Math.max(0, R * (R + 2 * c)));
  return { c, r, apexDy };
}

function pointedArcHalfLen(R, k) {
  const { c, r, apexDy } = pointedArchGeom(R, k);
  if (apexDy <= 1e-6) return 0;
  const thetaSpring = Math.atan2(0, c + R);
  const thetaApex = Math.atan2(apexDy, c);
  return r * Math.abs(thetaApex - thetaSpring);
}

export function pathULength(p) {
  const Lj = Math.max(1e-6, p.springY - p.sillY);
  if (p.archShape === "pointed") {
    return 2 * Lj + 2 * pointedArcHalfLen(p.ringRadius, p.archPointedness);
  }
  return 2 * Lj + Math.PI * p.ringRadius;
}

function sampleSill(s, R, y0) {
  const t = s / (2 * R);
  const x = THREE.MathUtils.lerp(-R, R, t);
  return { x, y: y0, tx: 1, ty: 0 };
}

/** Walk the U-shaped opening path (left leg → arch → right leg) at arclength s. */
export function sampleUPath(s, p) {
  const R = p.ringRadius;
  const y0 = p.sillY;
  const ys = p.springY;
  const Lj = Math.max(1e-6, ys - y0);
  const isPointed = p.archShape === "pointed";
  let u = s;

  if (u <= Lj) {
    const t = u / Lj;
    const y = THREE.MathUtils.lerp(y0, ys, t);
    return { x: -R, y, tx: 0, ty: 1 };
  }
  u -= Lj;

  if (isPointed) {
    const pg = pointedArchGeom(R, p.archPointedness);
    const alpha = Math.atan2(pg.apexDy, Math.max(1e-6, pg.c));
    const oneArc = pg.r * alpha;
    if (u <= oneArc) {
      const t = u / oneArc;
      const ang = Math.PI - t * alpha;
      const x = pg.c + pg.r * Math.cos(ang);
      const y = ys + pg.r * Math.sin(ang);
      const tx = Math.sin(ang);
      const ty = -Math.cos(ang);
      const inv = 1 / Math.hypot(tx, ty);
      return { x, y, tx: tx * inv, ty: ty * inv };
    }
    u -= oneArc;
    if (u <= oneArc) {
      const t = u / oneArc;
      const ang = alpha * (1 - t);
      const x = -pg.c + pg.r * Math.cos(ang);
      const y = ys + pg.r * Math.sin(ang);
      const tx = Math.sin(ang);
      const ty = -Math.cos(ang);
      const inv = 1 / Math.hypot(tx, ty);
      return { x, y, tx: tx * inv, ty: ty * inv };
    }
    u -= oneArc;
  } else {
    const La = Math.PI * R;
    if (u <= La) {
      const t = u / La;
      const ang = Math.PI * (1 - t);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const x = R * ca;
      const y = ys + R * sa;
      const tx = sa;
      const ty = -ca;
      const inv = 1 / Math.hypot(tx, ty);
      return { x, y, tx: tx * inv, ty: ty * inv };
    }
    u -= La;
  }

  const t = THREE.MathUtils.clamp(u / Lj, 0, 1);
  const y = THREE.MathUtils.lerp(ys, y0, t);
  return { x: R, y, tx: 0, ty: -1 };
}

// ── Interval math (rows minus the opening) ──
function subtractIntervals(intervals, holeLo, holeHi) {
  if (holeHi <= holeLo) return intervals;
  const out = [];
  for (const [a, b] of intervals) {
    if (b <= a + 1e-6) continue;
    if (holeHi <= a || holeLo >= b) {
      out.push([a, b]);
      continue;
    }
    if (holeLo > a + 1e-4) out.push([a, Math.min(holeLo, b)]);
    if (holeHi < b - 1e-4) out.push([Math.max(holeHi, a), b]);
  }
  return out;
}

export function wallOpeningHalfX(y, R_out, y0, ys, seam, archShape, pointedness) {
  if (y < y0 - 1e-6) return 0;
  if (y < ys - 1e-6) return R_out + seam;
  const dy = y - ys;
  if (archShape === "pointed") {
    const { c, r, apexDy } = pointedArchGeom(R_out, pointedness);
    if (dy > apexDy + 1e-6) return 0;
    const inner = r * r - dy * dy;
    if (inner <= 0) return 0;
    const halfW = -c + Math.sqrt(inner);
    if (halfW <= 0) return 0;
    return halfW + seam;
  }
  if (dy > R_out + 1e-6) return 0;
  const inner = R_out * R_out - dy * dy;
  if (inner <= 0) return 0;
  return Math.sqrt(inner) + seam;
}

function wallOpeningCurvature(y, R_out, y0, ys, seam, archShape, pointedness) {
  const e = 0.06;
  const a = wallOpeningHalfX(y + e, R_out, y0, ys, seam, archShape, pointedness);
  const b = wallOpeningHalfX(y - e, R_out, y0, ys, seam, archShape, pointedness);
  return Math.abs(a - b) / e;
}

/** GLSL-order smoothstep(edge0, edge1, x) — THREE.MathUtils takes (x, min, max). */
function smoothstepGL(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// ── Shared param helpers (lab + engine + gizmo all clamp the same way) ──
export function ringParamsFrom(params) {
  const R_in = Math.max(0.08, params.doorInnerHalfW);
  const R_out = R_in + Math.max(0.05, params.masonryShell);
  const springY = params.sillY + Math.max(0.05, params.legHeight);
  return {
    ringRadius: R_out,
    sillY: params.sillY,
    springY,
    archShape: params.archShape || "round",
    archPointedness: Number.isFinite(params.archPointedness)
      ? params.archPointedness
      : 1.0,
  };
}

export function clampArchAlong(params) {
  const R_in = Math.max(0.08, params.doorInnerHalfW);
  const R_out = R_in + Math.max(0.05, params.masonryShell);
  const halfW = params.wallWidth * 0.5;
  const margin = 0.28;
  const lim = Math.max(0.15, halfW - R_out - margin);
  params.archAlong = THREE.MathUtils.clamp(params.archAlong, -lim, lim);
}

export function clampArchAlongZ(params) {
  const d = Math.max(0.06, params.wallDepth);
  const lim = d * 0.55 + 0.42 + Math.abs(params.wallZ || 0) * 0.35;
  params.archAlongZ = THREE.MathUtils.clamp(params.archAlongZ, -lim, lim);
}

export function clampDoorSillInWall(params) {
  const R_in = Math.max(0.08, params.doorInnerHalfW);
  const R_out = R_in + Math.max(0.05, params.masonryShell);
  const leg = Math.max(0.05, params.legHeight);
  const w0 = params.wallAnchorY;
  const w1 = params.wallAnchorY + params.wallHeight;
  const margin = 0.1;
  let archHeight = R_out;
  if (params.archShape === "pointed") {
    const k = Number.isFinite(params.archPointedness) ? params.archPointedness : 1.0;
    archHeight = pointedArchGeom(R_out, k).apexDy;
  }
  const maxSill = w1 - margin - leg - archHeight;
  const minSill = w0 - 0.12;
  params.sillY = THREE.MathUtils.clamp(params.sillY, minSill, maxSill);
}

// ── Per-brick variation ──

/** Arch ring: tight coherent voussoirs (medieval-arch-showcase "door" mode). */
function pickBrickVariation(rnd, baseSx, baseSy, baseSz, ringDepthScale) {
  let sx = baseSx * (1 + (rnd() - 0.5) * 0.055);
  let sy = baseSy * (0.97 + rnd() * 0.05);
  let sz = baseSz * (0.97 + rnd() * 0.05);
  const bump =
    typeof ringDepthScale === "number" &&
    ringDepthScale > 0 &&
    !Number.isNaN(ringDepthScale)
      ? ringDepthScale
      : 1.09;
  sz *= bump;
  return {
    sx,
    sy,
    sz,
    shapeMix: 0.56 + rnd() * 0.07,
    warp: 0.16 + rnd() * 0.2,
    grey: 0.32 + rnd() * 0.34,
    grain: rnd(),
  };
}

/** Shader-only per-brick personality for wall field bricks. */
export function pickBrickShaderVar(rnd) {
  let shapeMix, warp;
  const u = rnd();
  if (u < 0.18) {
    shapeMix = 0.28 + rnd() * 0.12;
    warp = 0.45 + rnd() * 0.4;
  } else if (u < 0.4) {
    shapeMix = 0.4 + rnd() * 0.15;
    warp = 0.28 + rnd() * 0.3;
  } else {
    shapeMix = 0.55 + rnd() * 0.2;
    warp = 0.18 + rnd() * 0.22;
  }
  return { shapeMix, warp, grey: 0.28 + rnd() * 0.5, grain: rnd() };
}

/**
 * Front-face recession: bricks sit at varying depth into the shell while row
 * mortar gaps stay fixed on the wall plane. Bias toward flush bricks.
 */
function pickDepthPlacement(rnd, params) {
  const spread = THREE.MathUtils.clamp(params.depthSpread, 0, 1);
  const recessFrac = Math.max(0, params.depthRecess);
  if (spread <= 0 || recessFrac <= 0) {
    return { sz: 1, z: -params.brickD * 0.5, recess: 0 };
  }
  const u = Math.pow(rnd(), 0.88);
  const sz = 1 - u * recessFrac * 0.22;
  let recess = u * recessFrac * params.brickD * spread;
  recess = Math.min(recess, Math.max(0, params.wallDepth - params.brickD * sz));
  const z = -recess - (params.brickD * sz) * 0.5;
  return { sz, z, recess };
}

function pickPlanSy(rnd, params) {
  const v = THREE.MathUtils.clamp(params.planVariety, 0, 1);
  if (v <= 0) return 1;
  return THREE.MathUtils.lerp(1, 0.94 + rnd() * 0.06, v);
}

// ── Geometry ──
export function createBrickBaseGeometry(params) {
  const rRound = Math.max(0.0001, params.brickRound);
  const segs = Math.max(1, Math.min(6, params.roundSegments | 0));
  return new RoundedBoxGeometry(params.brickW, params.brickH, params.brickD, segs, rRound);
}

/**
 * Placement collector: layout code pushes transforms + shader vars here, then
 * `toInstancedMesh` uploads them into an exact-count InstancedMesh. Storage
 * grows geometrically up to `hardMax`, so callers don't pre-allocate the
 * worst case.
 */
export class BrickPlacements {
  constructor(initialCap, hardMax = initialCap) {
    this.cap = Math.max(16, initialCap | 0);
    this.hardMax = Math.max(this.cap, hardMax | 0);
    this.count = 0;
    this.matrices = new Float32Array(this.cap * 16);
    this.vars = new Float32Array(this.cap * 4);
    this._o = new THREE.Object3D();
  }

  _ensure(n) {
    if (n <= this.cap) return true;
    if (n > this.hardMax) return false;
    const newCap = Math.min(this.hardMax, Math.max(n, this.cap * 2));
    const m = new Float32Array(newCap * 16);
    m.set(this.matrices.subarray(0, this.count * 16));
    this.matrices = m;
    const v = new Float32Array(newCap * 4);
    v.set(this.vars.subarray(0, this.count * 4));
    this.vars = v;
    this.cap = newCap;
    return true;
  }

  /** @returns {boolean} false when hardMax is hit (caller stops laying bricks) */
  push(x, y, z, yaw, sx, sy, sz, shapeMix, warp, grey, grain) {
    const o = this._o;
    o.position.set(x, y, z);
    o.rotation.set(0, 0, yaw);
    o.scale.set(sx, sy, sz);
    o.updateMatrix();
    return this.pushMatrix(o.matrix, shapeMix, warp, grey, grain);
  }

  /** Push a fully composed transform (any orientation). */
  pushMatrix(matrix, shapeMix, warp, grey, grain) {
    if (!this._ensure(this.count + 1)) return false;
    matrix.toArray(this.matrices, this.count * 16);
    const vo = this.count * 4;
    this.vars[vo] = shapeMix;
    this.vars[vo + 1] = warp;
    this.vars[vo + 2] = grey;
    this.vars[vo + 3] = grain;
    this.count++;
    return true;
  }

  toInstancedMesh(baseGeo, material) {
    const n = Math.max(1, this.count);
    const geo = baseGeo.clone();
    const varAtt = new THREE.InstancedBufferAttribute(
      this.vars.slice(0, n * 4),
      4,
    );
    // Uploaded once per build; only destruction events would rewrite it.
    varAtt.setUsage(THREE.StaticDrawUsage);
    geo.setAttribute("brickVar", varAtt);

    const mesh = new THREE.InstancedMesh(geo, material, n);
    mesh.instanceMatrix.array.set(this.matrices.subarray(0, n * 16));
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.count = this.count;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.userData.brickPlacements = this;
    return mesh;
  }
}

/**
 * Arched opening ring (voussoirs + optional sill course) as one InstancedMesh.
 * Positioned at z = params.archAlongZ; the ring is centered on params.archAlong
 * in X. Caller adds to scene and sets shadow flags.
 */
export function generateArchRing(params, material, opts = {}) {
  const baseGeo = opts.baseGeo || createBrickBaseGeometry(params);
  const rp = ringParamsFrom(params);
  const R = rp.ringRadius;
  const Lu = pathULength(rp);
  const Ls = params.closeBottom ? 2 * R : 0;
  const jRing = THREE.MathUtils.clamp(params.brickW * 0.022, 0.0045, 0.012);
  const targetMod =
    params.brickW * THREE.MathUtils.clamp(params.spacingMul, 0.82, 1.08) + jRing;

  let nU = Math.max(5, Math.round(Lu / targetMod));
  if (rp.archShape === "pointed" && nU % 2 === 1) nU += 1;
  let nS = Ls > 0 ? Math.max(2, Math.round(Ls / targetMod)) : 0;
  const maxBricks = params.maxBricks ?? 2200;
  if (nU + nS > maxBricks) {
    const room = maxBricks - nS;
    nU = Math.max(4, Math.min(nU, room));
    if (nU + nS > maxBricks) nS = Math.max(0, maxBricks - nU);
  }

  let alongU = nU > 0 ? (Lu - Math.max(0, nU - 1) * jRing) / nU : params.brickW;
  let alongS = nS > 0 ? (Ls - Math.max(0, nS - 1) * jRing) / nS : params.brickW;
  const minAlong = params.brickW * 0.44;
  while (nU > 4 && alongU < minAlong) {
    nU--;
    alongU = nU > 0 ? (Lu - Math.max(0, nU - 1) * jRing) / nU : params.brickW;
  }
  while (nS > 2 && alongS < minAlong) {
    nS--;
    alongS = nS > 0 ? (Ls - Math.max(0, nS - 1) * jRing) / nS : params.brickW;
  }

  const placements = new BrickPlacements(nU + nS);
  const rnd = mulberry32(params.colorSeed | 0);
  const gx = params.archAlong;

  const placeBrick = (x, y, tx, ty, along) => {
    const yaw = Math.atan2(ty, tx);
    const baseSx = THREE.MathUtils.clamp(along / params.brickW, 0.86, 1.12);
    const baseSy = 0.94 + rnd() * 0.05;
    const baseSz = 0.94 + rnd() * 0.05;
    const v = pickBrickVariation(rnd, baseSx, baseSy, baseSz, params.archRingDepthScale);
    placements.push(x + gx, y, 0, yaw, v.sx, v.sy, v.sz, v.shapeMix, v.warp, v.grey, v.grain);
  };

  for (let i = 0; i < nU; i++) {
    const s = jRing * i + alongU * (i + 0.5);
    const o = sampleUPath(s, rp);
    placeBrick(o.x, o.y, o.tx, o.ty, alongU);
  }
  for (let i = 0; i < nS; i++) {
    const s = jRing * i + alongS * (i + 0.5);
    const o = sampleSill(s, R, rp.sillY);
    placeBrick(o.x, o.y, o.tx, o.ty, alongS);
  }

  const mesh = placements.toInstancedMesh(baseGeo, material);
  mesh.position.set(0, 0, params.archAlongZ);
  return mesh;
}

/**
 * Wall field with the arched opening subtracted, as one InstancedMesh.
 * Positioned at z = params.wallZ. Caller adds to scene and sets shadow flags.
 */
export function generateBrickWall(params, material, opts = {}) {
  const baseGeo = opts.baseGeo || createBrickBaseGeometry(params);
  const rp = ringParamsFrom(params);

  const R_in = Math.max(0.08, params.doorInnerHalfW);
  const R_out = R_in + Math.max(0.05, params.masonryShell);
  const doorSill = params.sillY;
  const ys = rp.springY;
  const seam = params.wallSeamInset;
  const mortar = params.wallMortar;
  const nomH = params.brickH;
  const nomW = params.brickW;
  const rowH = nomH + mortar;
  const wallLo = -params.wallWidth * 0.5;
  const wallHi = params.wallWidth * 0.5;
  const wallBase = params.wallAnchorY;
  const baseY = wallBase + mortar * 0.5 + nomH * 0.5;
  const topY = wallBase + Math.max(nomH * 2, params.wallHeight);
  const ny = Math.min(220, Math.max(3, Math.ceil((topY - baseY) / rowH)));

  const placements = new BrickPlacements(2048, params.maxWallBricks ?? 22000);
  const rnd = mulberry32((params.colorSeed ^ 91379) | 0);
  const gx = params.archAlong;

  const placeWallBrick = (cx, cy, sx, crownSy) => {
    const shader = pickBrickShaderVar(rnd);
    const depth = pickDepthPlacement(rnd, params);
    const sy = pickPlanSy(rnd, params) * crownSy;
    const sz = depth.sz * (0.92 + rnd() * 0.06);
    return placements.push(
      cx, cy, depth.z, 0, sx, sy, sz,
      shader.shapeMix, shader.warp, shader.grey, shader.grain,
    );
  };

  outer: for (let iy = 0; iy < ny; iy++) {
    const yMid = baseY + iy * rowH;
    if (yMid > topY - nomH * 0.2) break;

    const openH = wallOpeningHalfX(
      yMid, R_out, doorSill, ys, seam, rp.archShape, rp.archPointedness,
    );
    let intervals = [[wallLo, wallHi]];
    if (openH > 1e-5) {
      intervals = subtractIntervals(intervals, gx - openH, gx + openH);
    }

    // archContour = 0 reproduces the showcase/lab output exactly (their
    // smoothstep argument order kept curveT/haunch at a constant 0).
    const contour = THREE.MathUtils.clamp(params.archContour ?? 0, 0, 1);
    const curv = wallOpeningCurvature(
      yMid, R_out, doorSill, ys, seam, rp.archShape, rp.archPointedness,
    );
    const curveT = smoothstepGL(0.06, 1.15, curv) * contour;
    const nomWCurve =
      nomW *
      THREE.MathUtils.lerp(
        1,
        THREE.MathUtils.clamp(params.wallMinBrickScale, 0.16, 0.95),
        Math.pow(curveT, 1.08),
      );

    const haunch =
      yMid >= ys - mortar * 1.5 && yMid <= ys + R_out * 1.05
        ? smoothstepGL(ys - 0.12, ys + R_out * 0.82, yMid) * contour
        : 0;
    const crownSy =
      1 -
      (1 - THREE.MathUtils.clamp(params.wallCrownSquash, 0.42, 1)) *
        Math.pow(haunch, 1.28);

    for (const [segLo, segHi] of intervals) {
      const span = segHi - segLo;
      if (span < nomW * params.wallMinBrickScale * 0.45) continue;

      const minW = nomW * params.wallMinBrickScale;
      const jMin = 0.0035;
      const jMax = Math.min(mortar, Math.max(jMin, span * 0.014 + jMin * 0.6));
      const j = THREE.MathUtils.clamp(mortar, jMin, jMax);
      const hj = j * 0.5;
      let innerLo = segLo + hj;
      let innerHi = segHi - hj;
      if (iy % 2 === 1) {
        const shift = Math.min(
          (nomWCurve + j) * 0.48,
          Math.max(0, innerHi - innerLo - minW * 1.2) * 0.35,
        );
        const eps = Math.max(1e-3, nomW * 0.025);
        const rightOfOpening = openH > 1e-5 && segLo >= gx + openH - eps;
        const leftOfOpening = openH > 1e-5 && segHi <= gx - openH + eps;
        if (rightOfOpening) innerHi -= shift;
        else if (leftOfOpening) innerLo += shift;
        else innerLo += shift;
      }

      const innerLen = innerHi - innerLo;
      if (innerLen < minW * 0.72) continue;

      let nBricks = Math.max(1, Math.round(innerLen / (nomWCurve + j)));
      let wEq = (innerLen - (nBricks - 1) * j) / nBricks;
      for (let it = 0; it < 96; it++) {
        wEq = (innerLen - (nBricks - 1) * j) / nBricks;
        if (wEq < minW * 0.998) {
          if (nBricks <= 1) break;
          nBricks--;
        } else if (wEq > nomWCurve * 1.075 && nBricks < 1600) {
          nBricks++;
        } else break;
      }
      wEq = (innerLen - (nBricks - 1) * j) / nBricks;
      if (wEq < minW * 0.88) continue;

      for (let bi = 0; bi < nBricks; bi++) {
        const cx = innerLo + wEq * 0.5 + bi * (wEq + j);
        if (cx > innerHi - wEq * 0.5 + 1e-4) break;

        let tuckY = 0;
        if (openH > 1e-4 && curveT > 0.04) {
          const gap = Math.max(0, Math.abs(cx - gx) - openH);
          const band = params.brickW * 3.8;
          if (gap < band) {
            const t = 1 - smoothstepGL(0, 1, gap / band);
            tuckY = -nomH * 0.12 * Math.pow(t, 1.2) * Math.pow(curveT, 0.55);
          }
        }

        const sx = wEq / nomW;
        if (!placeWallBrick(cx, yMid + tuckY, sx, crownSy)) break outer;
      }
    }
  }

  const mesh = placements.toInstancedMesh(baseGeo, material);
  mesh.position.set(0, 0, params.wallZ);
  return mesh;
}

/**
 * Convenience: wall + arch ring sharing one base brick geometry.
 * @returns {{ group: THREE.Group, wallMesh: THREE.InstancedMesh|null,
 *             archMesh: THREE.InstancedMesh, brickCount: number }}
 */
export function buildWallWithArch(params, material, opts = {}) {
  const baseGeo = opts.baseGeo || createBrickBaseGeometry(params);
  const group = new THREE.Group();
  group.name = "brickWallWithArch";

  const archMesh = generateArchRing(params, material, { baseGeo });
  group.add(archMesh);

  let wallMesh = null;
  if (params.wallEnabled !== false) {
    wallMesh = generateBrickWall(params, material, { baseGeo });
    group.add(wallMesh);
  }

  const brickCount =
    (wallMesh ? wallMesh.count : 0) + (archMesh ? archMesh.count : 0);
  return { group, wallMesh, archMesh, brickCount };
}
