import * as THREE from "three";
import {
  mulberry32,
  sampleUPath,
  pathULength,
  wallOpeningHalfX,
  pickBrickShaderVar,
  BrickPlacements,
  createBrickBaseGeometry,
} from "./brickKit.js";

/**
 * GOTHIC CHURCH — procedural cruciform cathedral, every brick / voussoir /
 * slate / pinnacle laid as instances into ONE InstancedMesh (single draw call,
 * shared brick material).
 *
 * Massing: west facade (archivolt portal, rose window, gable, corner turrets)
 * → nave with clerestory + lean-to side aisles → transept with rose gables →
 * choir → polygonal apse, plus stepped buttresses with pinnacles, flying
 * buttresses, pitched slate roofs and an octagonal crossing spire.
 *
 * Polychromy is free: slates get a dark per-instance `grey`, window/portal
 * trim a light one — the shared brick shader turns those into dark slate and
 * limestone without a second material.
 *
 * Coordinate frame: crossing center at (0,0,0), nave runs west (-X) → east
 * (+X), Y up. Every element is laid through a {origin, yaw} panel transform.
 */

export const GOTHIC_CHURCH_DEFAULTS = {
  // Plan
  naveBays: 4,
  bayLength: 4.7,
  naveHalfW: 4.75, // outer plane of nave/clerestory walls
  aisleW: 3.45, // aisle outer plane sits at naveHalfW + aisleW
  transeptHalfL: 11.8,
  choirLen: 5.0,

  // Elevation
  naveEaveY: 13.4,
  naveRidgeY: 19.6,
  aisleEaveY: 6.3,
  aisleAttachY: 8.5, // lean-to roof attach height on the nave wall
  apseEaveY: 10.4,
  apseApexY: 16.6,

  // Features
  spireEnabled: true,
  spireR: 3.0,
  spireTopY: 33.5,
  flyersEnabled: true,
  turretsEnabled: true,
  portalHalfW: 1.5,
  portalRings: 3,
  portalSpringY: 4.6,
  portalPointedness: 1.05,
  roseR: 2.45,
  windowPointedness: 1.3,

  // Perf
  brickScale: 1.0, // scales the masonry unit — bigger bricks = fewer instances
  maxChurchBricks: 90000,

  // LOD hints — used by hosts (lab / engine LOD manager), ignored by the
  // generator itself. LOD1 = same church rebuilt at brickScale × lod1BrickMul.
  lodEnabled: true,
  lodDistance: 85, // metres from the structure center where LOD1 takes over
  lod1BrickMul: 2.0,
};

const DEG = Math.PI / 180;
const _o = new THREE.Object3D();

// ── Tones (per-instance shader personality through the shared material) ──
const stoneTone = (rnd) => pickBrickShaderVar(rnd);
const trimTone = (rnd) => ({
  shapeMix: 0.55 + rnd() * 0.15,
  warp: 0.12 + rnd() * 0.15,
  grey: 0.68 + rnd() * 0.28,
  grain: rnd(),
});
const slateTone = (rnd) => ({
  shapeMix: 0.5 + rnd() * 0.1,
  warp: 0.06 + rnd() * 0.08,
  grey: 0.04 + rnd() * 0.14,
  grain: rnd(),
});
const doorTone = (rnd) => ({
  shapeMix: 0.5,
  warp: 0.05,
  grey: 0.02 + rnd() * 0.05,
  grain: rnd(),
});

/**
 * Everything below works in ABSOLUTE world sizes; this context converts them
 * to instance scales against the base brick geometry and applies the
 * {origin, yaw} panel transform.
 */
class Layouter {
  constructor(placements, brick) {
    this.pl = placements;
    this.b = brick; // { w, h, d } world size of the base geometry
    this.origin = new THREE.Vector3();
    this.yaw = 0;
  }

  setPanel(ox, oz, yaw) {
    this.origin.set(ox, 0, oz);
    this.yaw = yaw;
    this._cos = Math.cos(yaw);
    this._sin = Math.sin(yaw);
    return this;
  }

  /** Panel-local (lx, y, lz) → world. Local +z is the panel's outward normal. */
  _world(lx, y, lz) {
    return {
      x: this.origin.x + this._cos * lx + this._sin * lz,
      y,
      z: this.origin.z - this._sin * lx + this._cos * lz,
    };
  }

  /**
   * One brick. rx/rz are panel-local pitch (about local X) and roll (about
   * local Z); sizes are world metres.
   */
  box(lx, y, lz, rx, rz, sizeX, sizeY, sizeZ, tone) {
    const p = this._world(lx, y, lz);
    _o.position.set(p.x, p.y, p.z);
    _o.rotation.set(rx, this.yaw, rz, "YXZ");
    _o.scale.set(sizeX / this.b.w, sizeY / this.b.h, sizeZ / this.b.d);
    _o.updateMatrix();
    return this.pl.pushMatrix(_o.matrix, tone.shapeMix, tone.warp, tone.grey, tone.grain);
  }
}

// ── Openings (each is y → {cx, half} in panel-local coords, or null) ──
function lancetOpening(cx, sill, spring, R, k, seam = 0.035) {
  return (y) => {
    const half = wallOpeningHalfX(y, R, sill, spring, seam, "pointed", k);
    return half > 1e-5 ? { cx, half } : null;
  };
}

function circleOpening(cx, cy, R, seam = 0.035) {
  return (y) => {
    const dy = Math.abs(y - cy);
    const r = R + seam;
    if (dy >= r) return null;
    return { cx, half: Math.sqrt(r * r - dy * dy) };
  };
}

function subtractOpenings(intervals, openings, y) {
  let out = intervals;
  for (const op of openings) {
    const o = op(y);
    if (!o) continue;
    const next = [];
    for (const [a, b] of out) {
      if (b <= a + 1e-6) continue;
      const lo = o.cx - o.half;
      const hi = o.cx + o.half;
      if (hi <= a || lo >= b) {
        next.push([a, b]);
        continue;
      }
      if (lo > a + 1e-4) next.push([a, Math.min(lo, b)]);
      if (hi < b - 1e-4) next.push([Math.max(hi, a), b]);
    }
    out = next;
  }
  return out;
}

/**
 * Coursed wall panel with running bond, optional profile (gable etc.) and
 * openings. halfW: number, or (y) => half width at that course.
 */
function layPanel(L, rnd, P) {
  const { y0, y1, tone = stoneTone } = P;
  const bw = P.bw, bh = P.bh, bd = P.bd;
  const j = P.mortar ?? 0.012;
  const minScale = P.minScale ?? 0.3;
  const rowH = bh + j;
  const halfWFn = typeof P.halfW === "function" ? P.halfW : () => P.halfW;
  const openings = P.openings || [];
  const zBase = P.zFace ?? 0;

  const rows = Math.max(1, Math.floor((y1 - y0) / rowH));
  for (let iy = 0; iy < rows; iy++) {
    const y = y0 + rowH * (iy + 0.5);
    const hw = halfWFn(y);
    if (hw === null || hw < bw * 0.28) continue;
    let intervals = [[-hw, hw]];
    intervals = subtractOpenings(intervals, openings, y);

    for (const [segLo0, segHi0] of intervals) {
      let lo = segLo0 + j * 0.5;
      let hi = segHi0 - j * 0.5;
      if (iy % 2 === 1) {
        const shift = Math.min((bw + j) * 0.5, Math.max(0, hi - lo - bw) * 0.4);
        lo += shift;
      }
      const len = hi - lo;
      if (len < bw * minScale * 0.8) continue;

      let n = Math.max(1, Math.round(len / (bw + j)));
      let w = (len - (n - 1) * j) / n;
      while (w < bw * minScale && n > 1) {
        n--;
        w = (len - (n - 1) * j) / n;
      }
      while (w > bw * 1.18 && n < 4000) {
        n++;
        w = (len - (n - 1) * j) / n;
      }
      if (w < bw * minScale * 0.85) continue;

      for (let bi = 0; bi < n; bi++) {
        const cx = lo + w * 0.5 + bi * (w + j);
        const recess = Math.pow(rnd(), 1.4) * (P.depthJitter ?? 0.045);
        const sy = bh * (0.985 + rnd() * 0.025);
        const sz = bd * (0.94 + rnd() * 0.06);
        if (
          !L.box(cx, y, zBase - sz * 0.5 - recess, 0, 0, w, sy, sz, tone(rnd))
        )
          return false;
      }
    }
  }
  return true;
}

/** Pointed-arch voussoir ring framing a lancet window/portal. */
function layLancetRing(L, rnd, o) {
  const { cx, sill, spring, R, k } = o;
  const bw = o.bw, bh = o.bh, bd = o.bd;
  const rp = {
    ringRadius: R,
    sillY: sill,
    springY: spring,
    archShape: "pointed",
    archPointedness: k,
  };
  const Lu = pathULength(rp);
  const jr = 0.008;
  const mod = bw * (o.spacing ?? 0.86) + jr;
  let n = Math.max(5, Math.round(Lu / mod));
  if (n % 2 === 1) n += 1;
  const along = (Lu - (n - 1) * jr) / n;
  const depth = bd * (o.ringDepth ?? 1.25);
  const zC = (o.zFace ?? 0) + (o.proud ?? 0.05) - depth * 0.5;
  const tone = o.tone ?? trimTone;
  for (let i = 0; i < n; i++) {
    const s = jr * i + along * (i + 0.5);
    const pt = sampleUPath(s, rp);
    const roll = Math.atan2(pt.ty, pt.tx);
    if (
      !L.box(
        cx + pt.x, pt.y, zC, 0, roll,
        along * (0.98 + rnd() * 0.04),
        bh * (0.92 + rnd() * 0.08),
        depth,
        tone(rnd),
      )
    )
      return false;
  }
  // Sloped sill slab under the opening
  if (o.sillSlab !== false) {
    L.box(
      cx, sill - 0.1, (o.zFace ?? 0) + 0.1 - bd * 0.55,
      -30 * DEG, 0,
      R * 2 + 0.3, 0.16, bd * 1.1,
      tone(rnd),
    );
  }
  return true;
}

/** Circular voussoir ring (rose windows, oculi) + optional spokes and hub. */
function layCircleRing(L, rnd, o) {
  const { cx, cy, R } = o;
  const bw = o.bw, bh = o.bh, bd = o.bd;
  const circ = 2 * Math.PI * R;
  const n = Math.max(8, Math.round(circ / (bw * 0.82 + 0.008)));
  const along = circ / n - 0.008;
  const depth = bd * (o.ringDepth ?? 1.2);
  const zC = (o.zFace ?? 0) + (o.proud ?? 0.05) - depth * 0.5;
  const tone = o.tone ?? trimTone;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    if (
      !L.box(
        cx + R * Math.cos(a), cy + R * Math.sin(a), zC,
        0, a + Math.PI / 2,
        along * (0.98 + rnd() * 0.04),
        bh * (0.9 + rnd() * 0.1),
        depth,
        tone(rnd),
      )
    )
      return false;
  }
  if (o.spokes) {
    const hubR = R * 0.22;
    const zS = (o.zFace ?? 0) - bd * 0.42;
    for (let i = 0; i < o.spokes; i++) {
      const a = (i / o.spokes) * Math.PI * 2 + Math.PI / o.spokes;
      const rIn = hubR + bh * 0.3;
      const rOut = R - bh * 0.45;
      const m = Math.max(1, Math.round((rOut - rIn) / (bw * 0.9)));
      const step = (rOut - rIn) / m;
      for (let k2 = 0; k2 < m; k2++) {
        const r = rIn + step * (k2 + 0.5);
        L.box(
          cx + r * Math.cos(a), cy + r * Math.sin(a), zS,
          0, a,
          step * 0.96, bh * 0.42, bd * 0.5,
          tone(rnd),
        );
      }
    }
    // hub ring
    const nh = Math.max(6, Math.round((2 * Math.PI * hubR) / (bw * 0.7)));
    for (let i = 0; i < nh; i++) {
      const a = (i / nh) * Math.PI * 2;
      L.box(
        cx + hubR * Math.cos(a), cy + hubR * Math.sin(a), zS,
        0, a + Math.PI / 2,
        (2 * Math.PI * hubR) / nh - 0.006, bh * 0.5, bd * 0.55,
        tone(rnd),
      );
    }
  }
  return true;
}

/**
 * Stepped buttress rising against a wall. Panel origin = point on the wall's
 * outer plane at ground level; local +z = outward. Steps reduce depth with a
 * sloped coping; optional pinnacle + finial spike on top.
 */
function layButtress(L, rnd, o) {
  const bw = o.bw, bh = o.bh, bd = o.bd;
  const j = 0.012;
  const rowH = bh + j;
  let w = o.w, d = o.d;
  const steps = o.steps || [];
  let si = 0;
  const rows = Math.max(1, Math.round(o.h / rowH));
  for (let iy = 0; iy < rows; iy++) {
    const y = rowH * (iy + 0.5) + (o.y0 ?? 0);
    if (si < steps.length && y > steps[si].y) {
      // sloped coping slab on the ledge, then recede
      L.box(0, y - rowH * 0.4, d * 0.62, -38 * DEG, 0, w + 0.14, 0.15, d * 0.52, trimTone(rnd));
      w = Math.max(0.3, w - steps[si].insetW);
      d = Math.max(0.3, d - steps[si].insetD);
      si++;
    }
    const n = Math.max(1, Math.round(w / bw));
    const wEq = (w - (n - 1) * j) / n;
    const phase = iy % 2 === 1 ? wEq * 0.32 : 0;
    for (let bi = 0; bi < n; bi++) {
      const cx = -w / 2 + wEq * 0.5 + bi * (wEq + j) + phase * (n > 1 ? 1 : 0);
      L.box(
        Math.min(w / 2 - wEq * 0.4, cx), y, d * 0.5,
        0, 0,
        wEq, bh * (0.985 + rnd() * 0.02), d * (0.95 + rnd() * 0.05),
        stoneTone(rnd),
      );
    }
  }
  const topY = (o.y0 ?? 0) + rows * rowH;
  if (o.pinH > 0) {
    layPinnacle(L, rnd, { cx: 0, cz: d * 0.5, y0: topY, w: Math.min(w, o.pinW ?? w), h: o.pinH, bw, bh, bd });
  } else {
    // plain sloped cap
    L.box(0, topY + 0.06, d * 0.5, -35 * DEG, 0, w + 0.12, 0.16, d + 0.12, trimTone(rnd));
  }
  return topY;
}

/** Slim tapering pinnacle with a finial spike (trim tone). */
function layPinnacle(L, rnd, o) {
  const bh = o.bh;
  const j = 0.01;
  const rowH = bh * 0.82 + j;
  const rows = Math.max(2, Math.round(o.h / rowH));
  for (let iy = 0; iy < rows; iy++) {
    const t = iy / rows;
    const w = THREE.MathUtils.lerp(o.w, o.w * 0.24, Math.pow(t, 1.15));
    const y = o.y0 + rowH * (iy + 0.5);
    L.box(o.cx, y, o.cz, 0, (iy % 2) * 45 * DEG * 0 , w, bh * 0.8, w, trimTone(rnd));
  }
  const tipY = o.y0 + rows * rowH;
  L.box(o.cx, tipY + o.w * 0.55, o.cz, 0, 0, o.w * 0.2, o.w * 1.5, o.w * 0.2, trimTone(rnd));
}

/** Flying buttress: bulged arc + sloped coping from clerestory wall to pier. */
function layFlyer(L, rnd, o) {
  const { yHigh, yLow, run } = o;
  const bw = o.bw, bh = o.bh, bd = o.bd;
  const drop = yHigh - yLow;
  const R = (run * run + drop * drop) / (2 * drop);
  const aEnd = Math.atan2(R - drop, run);
  const arc = R * (Math.PI / 2 - aEnd);
  const n = Math.max(6, Math.round(arc / (bw * 0.78)));
  const along = arc / n;
  const tone = stoneTone;
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 - ((i + 0.5) / n) * (Math.PI / 2 - aEnd);
    const lx = R * Math.cos(a);
    const y = yHigh - R + R * Math.sin(a);
    const roll = Math.atan2(-Math.cos(a), Math.sin(a));
    L.box(0, y, lx, roll, 0, bd * 0.72, along * 1.02, bh * 1.35, tone(rnd));
  }
  // straight sloped coping above the arc
  const cLen = Math.hypot(run, drop * 0.82);
  const m = Math.max(4, Math.round(cLen / (bw * 0.95)));
  const slope = Math.atan2(-(drop * 0.82), run);
  for (let i = 0; i < m; i++) {
    const t = (i + 0.5) / m;
    const lx = t * run;
    const y = yHigh + 0.42 + t * -(drop * 0.82);
    L.box(0, y, lx, slope, 0, bd * 0.8, 0.3, cLen / m + 0.02, trimTone(rnd));
  }
}

/**
 * Pitched slate plane. Panel-local: x runs along the ridge, +z from the ridge
 * toward the eave. halfLen: number, or (t 0=ridge→1=eave) => half length —
 * lets the same code do rectangular roofs and triangular spire/apse facets.
 */
function laySlatePlane(L, rnd, o) {
  const { ridgeY, eaveY, run } = o;
  const pitch = Math.atan2(ridgeY - eaveY, run);
  const slant = Math.hypot(ridgeY - eaveY, run);
  const sw = o.slateW, sl = o.slateL, st = o.slateT;
  const courseStep = sl * 0.7;
  const rows = Math.max(1, Math.round(slant / courseStep));
  const halfFn = typeof o.halfLen === "function" ? o.halfLen : () => o.halfLen;
  for (let iy = 0; iy < rows; iy++) {
    const s = (iy + 0.5) * (slant / rows);
    const t = s / slant;
    const half = halfFn(t);
    if (half < sw * 0.3) continue;
    const y = ridgeY - s * Math.sin(pitch);
    const lz = (o.zRidge ?? 0) + s * Math.cos(pitch);
    let n = Math.max(1, Math.round((half * 2) / (sw * 1.02)));
    const w = (half * 2) / n;
    const phase = iy % 2 === 1 ? w * 0.5 : 0;
    for (let bi = 0; bi < n; bi++) {
      let cx = -half + w * 0.5 + bi * w + phase;
      if (cx > half - w * 0.25) continue;
      L.box(
        cx, y + st * 1.4, lz, pitch, 0,
        w * 0.98, st, sl * (0.97 + rnd() * 0.06),
        slateTone(rnd),
      );
    }
  }
  // ridge caps for rectangular roofs
  if (o.ridgeCaps) {
    const half0 = halfFn(0);
    const n = Math.max(2, Math.round((half0 * 2) / (sw * 1.15)));
    const w = (half0 * 2) / n;
    for (let bi = 0; bi < n; bi++) {
      L.box(-half0 + w * 0.5 + bi * w, ridgeY + st * 2.2, o.zRidge ?? 0, 0, 0, w * 0.96, st * 1.6, sl * 0.62, slateTone(rnd));
    }
  }
}

/** Cross finial (trim tone): shaft + arm + small top. */
function layCross(L, rnd, cx, yBase, cz, h = 1.5) {
  L.box(cx, yBase + h * 0.5, cz, 0, 0, 0.17, h, 0.17, trimTone(rnd));
  L.box(cx, yBase + h * 0.66, cz, 0, 0, h * 0.55, 0.16, 0.16, trimTone(rnd));
  L.box(cx, yBase - 0.12, cz, 0, 0, 0.42, 0.24, 0.42, trimTone(rnd));
}

// ═══════════════════════════════════════════════════════════════════════════

export function generateGothicChurch(params, material, opts = {}) {
  const p = { ...GOTHIC_CHURCH_DEFAULTS, ...params };
  const bs = Math.max(0.5, p.brickScale);
  const bw = (params.brickW ?? 0.52) * bs;
  const bh = (params.brickH ?? 0.38) * bs;
  const bd = (params.brickD ?? 0.55) * bs;
  const B = { bw, bh, bd };
  const k = p.windowPointedness;
  const seed = (params.colorSeed ?? 31415) | 0;

  const baseGeo =
    opts.baseGeo ||
    createBrickBaseGeometry({
      brickW: params.brickW ?? 0.52,
      brickH: params.brickH ?? 0.38,
      brickD: params.brickD ?? 0.55,
      brickRound: params.brickRound ?? 0.02,
      roundSegments: params.roundSegments ?? 2,
    });

  const pl = new BrickPlacements(16384, p.maxChurchBricks);
  const L = new Layouter(pl, {
    w: params.brickW ?? 0.52,
    h: params.brickH ?? 0.38,
    d: params.brickD ?? 0.55,
  });
  const rnd = mulberry32(seed ^ 0x9e3779b9);

  // ── Derived plan ──
  const tHW = p.naveHalfW; // transept half width along X == nave half width
  const zNave = p.naveHalfW; // nave/clerestory outer plane
  const zA = p.naveHalfW + p.aisleW; // aisle outer plane
  const naveLen = p.naveBays * p.bayLength;
  const xWest = -tHW - naveLen;
  const xApse = tHW + p.choirLen;
  const THL = p.transeptHalfL;

  const slate = { slateW: bw * 1.05, slateL: bd * 0.85, slateT: 0.06 * bs };
  const wall = (over) => ({
    bw, bh, bd, mortar: 0.012, tone: stoneTone, ...over,
  });

  // Window specs — absolute metres (NOT brick-relative), so every LOD built
  // at a different brickScale keeps the same openings and silhouette.
  const cler = { r: 0.68, sill: p.naveEaveY - 3.9, spring: p.naveEaveY - 1.45 };
  const aisle = { r: 0.8, sill: 1.6, spring: 4.35 };
  const choirW = { r: 0.83, sill: 2.6, spring: 9.6 };
  const apseW = { r: 0.75, sill: 2.3, spring: 8.2 };
  const tGab = { r: 0.65, sill: 1.6, spring: 6.6 };

  // Ring shell (and thus every opening cut = r + ringShell) tracks the BASE
  // brick height, not the LOD-scaled one — keeps openings identical across
  // LODs; the bigger LOD bricks simply overlap the path more.
  const ringShell = (params.brickH ?? 0.38) * 0.55;
  const lancetHole = (spec, cx) =>
    lancetOpening(cx, spec.sill, spec.spring, spec.r + ringShell, k);
  const ringFor = (spec, cx, extra = {}) => ({
    cx, sill: spec.sill, spring: spec.spring, R: spec.r + ringShell, k,
    bw, bh, bd, ...extra,
  });

  const bayCenters = [];
  for (let i = 0; i < p.naveBays; i++)
    bayCenters.push(-naveLen / 2 + p.bayLength * (i + 0.5));
  const bayLines = [];
  for (let i = 0; i <= p.naveBays; i++) bayLines.push(-naveLen / 2 + p.bayLength * i);

  const gableProfile = (halfBase, eave, ridge) => (y) =>
    y <= eave ? halfBase : Math.max(0, halfBase * (1 - (y - eave) / (ridge - eave)));

  // ═══ WEST FACADE ═══════════════════════════════════════════════════════
  {
    L.setPanel(xWest, 0, -Math.PI / 2); // outward = -X, local +x = +Z
    const kPort = p.portalPointedness;
    const portR = p.portalHalfW + p.portalRings * (ringShell * 2.1);
    // Portal apex height (pointed arch geometry) → keep the rose clear of it
    // AND inside the gable rake, whatever the sliders say.
    const cPort = portR * kPort;
    const portalTopY =
      p.portalSpringY + Math.sqrt(Math.max(0, portR * (portR + 2 * cPort)));
    let roseR = p.roseR;
    let roseCy = Math.max(p.naveEaveY - 2.0, portalTopY + roseR + ringShell + 0.5);
    const rakeHalfAt = gableProfile(zNave, p.naveEaveY, p.naveRidgeY);
    for (let i = 0; i < 8; i++) {
      const need = roseR + ringShell + 0.3;
      if (rakeHalfAt(roseCy + roseR + ringShell) >= need) break;
      roseR *= 0.92;
      roseCy = Math.max(p.naveEaveY - 2.0, portalTopY + roseR + ringShell + 0.5);
    }
    // Full width → sloped half-gable shoulders (closing the aisle lean-to
    // roof ends) → central gable.
    const shoulderY0 = p.aisleEaveY + 0.9;
    const shoulderY1 = p.aisleAttachY + 0.7;
    const facadeProfile = (y) => {
      if (y <= shoulderY0) return zA;
      if (y <= shoulderY1) {
        return THREE.MathUtils.lerp(
          zA, zNave, (y - shoulderY0) / (shoulderY1 - shoulderY0),
        );
      }
      return gableProfile(zNave, p.naveEaveY, p.naveRidgeY)(y);
    };
    const openings = [
      lancetOpening(0, 0, p.portalSpringY, portR + 0.04, kPort),
      circleOpening(0, roseCy, roseR + ringShell),
      lancetOpening(-(zNave + p.aisleW * 0.52), aisle.sill, aisle.spring, aisle.r + ringShell, k),
      lancetOpening(zNave + p.aisleW * 0.52, aisle.sill, aisle.spring, aisle.r + ringShell, k),
    ];
    layPanel(L, rnd, wall({ y0: 0, y1: p.naveRidgeY, halfW: facadeProfile, openings }));

    // Archivolt portal: nested pointed rings, stepping back into the wall
    for (let ri = p.portalRings - 1; ri >= 0; ri--) {
      const R = p.portalHalfW + ringShell + ri * (ringShell * 2.1);
      layLancetRing(L, rnd, {
        cx: 0, sill: 0, spring: p.portalSpringY, R, k: kPort, bw, bh, bd,
        ringDepth: 1.5, proud: 0.14 - (p.portalRings - 1 - ri) * 0.22,
        spacing: 0.8,
        tone: ri % 2 === 0 ? trimTone : stoneTone,
        sillSlab: false,
      });
    }
    // Tympanum fill + door planks
    const lintelY = 2.75;
    const tympR = p.portalHalfW + ringShell - bh * 0.55;
    layPanel(L, rnd, wall({
      y0: lintelY, y1: p.portalSpringY + tympR * 1.9,
      halfW: (y) => {
        const h = wallOpeningHalfX(y, tympR, 0, p.portalSpringY, 0, "pointed", kPort);
        return h > 1e-5 ? h : null;
      },
      zFace: -0.42, bw: bw * 0.7, bh: bh * 0.7, tone: trimTone, depthJitter: 0.02,
    }));
    const doorHalf = p.portalHalfW + ringShell - bh * 0.5;
    const planks = Math.max(4, Math.round((doorHalf * 2) / 0.3));
    const pw = (doorHalf * 2) / planks;
    for (let i = 0; i < planks; i++) {
      L.box(-doorHalf + pw * (i + 0.5), lintelY / 2 + 0.05, -0.52, 0, 0, pw * 0.94, lintelY, 0.1, doorTone(rnd));
    }
    L.box(0, lintelY + 0.09, -0.32, 0, 0, doorHalf * 2 + 0.3, 0.24, bd * 0.9, trimTone(rnd));

    // Rose window
    layCircleRing(L, rnd, { cx: 0, cy: roseCy, R: roseR + ringShell, bw, bh, bd, spokes: 12, ringDepth: 1.35, proud: 0.08 });
    // Aisle-front lancet rings
    layLancetRing(L, rnd, ringFor(aisle, -(zNave + p.aisleW * 0.52)));
    layLancetRing(L, rnd, ringFor(aisle, zNave + p.aisleW * 0.52));
    // Gable cross
    layCross(L, rnd, 0, p.naveRidgeY + 0.05, 0.0, 1.7);

    // Facade buttresses flanking the portal
    for (const sx of [-1, 1]) {
      L.setPanel(xWest, sx * (zNave - 0.35), -Math.PI / 2);
      layButtress(L, rnd, {
        bw, bh, bd, w: 1.15, d: 1.2, h: p.naveEaveY - 2.2, y0: 0,
        steps: [{ y: 4.6, insetW: 0.16, insetD: 0.3 }, { y: 8.6, insetW: 0.16, insetD: 0.3 }],
        pinH: 2.6, pinW: 0.62,
      });
    }
  }

  // ═══ CORNER TURRETS (octagonal, on the facade corners) ═════════════════
  if (p.turretsEnabled) {
    for (const sz of [-1, 1]) {
      const cx = xWest + 0.15;
      const cz = sz * (zA - 0.15);
      const r = 0.95;
      const facetW = 2 * r * Math.tan(Math.PI / 8);
      const rowH = bh + 0.012;
      const rows = Math.round((p.aisleEaveY + 5.4) / rowH);
      for (let iy = 0; iy < rows; iy++) {
        const y = rowH * (iy + 0.5);
        const twist = (iy % 2) * (Math.PI / 8);
        for (let f = 0; f < 8; f++) {
          const a = (f / 8) * Math.PI * 2 + twist;
          const px = cx + Math.cos(a) * r * 0.82;
          const pz = cz + Math.sin(a) * r * 0.82;
          L.setPanel(px, pz, -a - Math.PI / 2);
          L.box(0, y, -bd * 0.35, 0, 0, facetW * 0.92, bh, bd * 0.7, stoneTone(rnd));
        }
      }
      // cap cornice, then spirelet
      const y1 = rows * rowH;
      L.setPanel(cx, cz, 0);
      L.box(0, y1 + 0.06, 0, 0, 0, r * 2.15, 0.16, r * 2.15, trimTone(rnd));
      const spRows = Math.round(3.4 / (bh * 0.8));
      for (let iy = 0; iy < spRows; iy++) {
        const t = iy / spRows;
        const rr = Math.max(0.08, r * (1 - t));
        const y = y1 + 0.14 + (bh * 0.8) * (iy + 0.5);
        const nfac = rr > 0.3 ? 8 : 4;
        for (let f = 0; f < nfac; f++) {
          const a = (f / nfac) * Math.PI * 2 + (iy % 2) * (Math.PI / nfac);
          L.setPanel(cx + Math.cos(a) * rr * 0.78, cz + Math.sin(a) * rr * 0.78, -a - Math.PI / 2);
          L.box(0, y, 0, 0, 0, Math.max(0.18, 2 * rr * Math.tan(Math.PI / nfac) * 0.95), bh * 0.78, Math.max(0.14, bd * 0.55 * (1 - t)), slateTone(rnd));
        }
      }
      L.setPanel(cx, cz, 0);
      L.box(0, y1 + 3.4 + 0.5, 0, 0, 0, 0.13, 1.0, 0.13, trimTone(rnd));
    }
  }

  // ═══ NAVE: clerestory + aisles ═════════════════════════════════════════
  const naveMidX = xWest + naveLen / 2;
  for (const s of [-1, 1]) {
    const yawSide = s === 1 ? 0 : Math.PI; // outward +Z (north) / -Z (south)
    // clerestory
    L.setPanel(naveMidX, s * zNave, yawSide);
    layPanel(L, rnd, wall({
      y0: p.aisleAttachY - 0.25, y1: p.naveEaveY, halfW: naveLen / 2,
      openings: bayCenters.map((c) => lancetHole(cler, s * -c)),
    }));
    for (const c of bayCenters) layLancetRing(L, rnd, ringFor(cler, s * -c));
    // aisle outer wall
    L.setPanel(naveMidX, s * zA, yawSide);
    layPanel(L, rnd, wall({
      y0: 0, y1: p.aisleEaveY, halfW: naveLen / 2,
      openings: bayCenters.map((c) => lancetHole(aisle, s * -c)),
    }));
    for (const c of bayCenters) layLancetRing(L, rnd, ringFor(aisle, s * -c));

    // aisle buttresses at bay lines + clerestory pilasters + flyers
    for (const xl of bayLines) {
      const wx = naveMidX + xl;
      L.setPanel(wx, s * zA, yawSide);
      const top = layButtress(L, rnd, {
        bw, bh, bd, w: 0.88, d: 1.0, h: p.aisleEaveY + 1.9, y0: 0,
        steps: [{ y: 3.3, insetW: 0.1, insetD: 0.26 }, { y: p.aisleEaveY - 0.4, insetW: 0.1, insetD: 0.26 }],
        pinH: 2.3, pinW: 0.55,
      });
      L.setPanel(wx, s * zNave, yawSide);
      layButtress(L, rnd, {
        bw, bh, bd, w: 0.7, d: 0.5, h: p.naveEaveY - p.aisleAttachY + 0.6, y0: p.aisleAttachY - 0.25,
        steps: [], pinH: 2.2, pinW: 0.5,
      });
      if (p.flyersEnabled) {
        L.setPanel(wx, s * zNave, yawSide);
        layFlyer(L, rnd, {
          bw, bh, bd,
          yHigh: p.naveEaveY - 1.0,
          yLow: top + 0.35,
          run: p.aisleW - 0.35,
        });
      }
    }
  }

  // ═══ TRANSEPT ══════════════════════════════════════════════════════════
  {
    // side walls (west & east faces of both arms)
    for (const sArm of [-1, 1]) {
      for (const sFace of [-1, 1]) {
        const yawF = sFace === 1 ? Math.PI / 2 : -Math.PI / 2; // outward ±X
        const zc = sArm * (zNave + (THL - zNave) / 2);
        const halfSpan = (THL - zNave) / 2;
        L.setPanel(sFace * tHW, zc, yawF);
        const cxl = 0;
        layPanel(L, rnd, wall({
          y0: 0, y1: p.naveEaveY, halfW: halfSpan,
          openings: [
            lancetHole(aisle, cxl),
            lancetHole(cler, cxl),
          ],
        }));
        layLancetRing(L, rnd, ringFor(aisle, cxl));
        layLancetRing(L, rnd, ringFor(cler, cxl));
      }
      // gable end
      const yawG = sArm === 1 ? 0 : Math.PI;
      L.setPanel(0, sArm * THL, yawG);
      const roseCy = p.naveEaveY - 1.15;
      const roseR2 = p.roseR * 0.82;
      layPanel(L, rnd, wall({
        y0: 0, y1: p.naveRidgeY,
        halfW: gableProfile(tHW, p.naveEaveY, p.naveRidgeY),
        openings: [
          circleOpening(0, roseCy, roseR2 + ringShell),
          lancetHole(tGab, -2.5), lancetHole(tGab, 0), lancetHole(tGab, 2.5),
        ],
      }));
      layCircleRing(L, rnd, { cx: 0, cy: roseCy, R: roseR2 + ringShell, bw, bh, bd, spokes: 10, ringDepth: 1.3, proud: 0.07 });
      for (const c of [-2.5, 0, 2.5]) layLancetRing(L, rnd, ringFor(tGab, c));
      layCross(L, rnd, 0, p.naveRidgeY + 0.05, 0, 1.5);

      // corner buttresses (perpendicular pair per corner)
      for (const sFace of [-1, 1]) {
        L.setPanel(sFace * tHW, sArm * (THL - 0.65), sFace === 1 ? Math.PI / 2 : -Math.PI / 2);
        layButtress(L, rnd, {
          bw, bh, bd, w: 0.85, d: 0.95, h: p.naveEaveY - 2.6, y0: 0,
          steps: [{ y: 4.2, insetW: 0.12, insetD: 0.26 }, { y: 8.6, insetW: 0.12, insetD: 0.26 }],
          pinH: 2.3, pinW: 0.52,
        });
        L.setPanel(sFace * (tHW - 0.65), sArm * THL, sArm === 1 ? 0 : Math.PI);
        layButtress(L, rnd, {
          bw, bh, bd, w: 0.85, d: 0.95, h: p.naveEaveY - 2.6, y0: 0,
          steps: [{ y: 4.2, insetW: 0.12, insetD: 0.26 }, { y: 8.6, insetW: 0.12, insetD: 0.26 }],
          pinH: 2.3, pinW: 0.52,
        });
      }
    }
  }

  // ═══ CHOIR + EAST GABLE + APSE ═════════════════════════════════════════
  {
    const choirMid = tHW + p.choirLen / 2;
    for (const s of [-1, 1]) {
      const yawSide = s === 1 ? 0 : Math.PI;
      L.setPanel(choirMid, s * zNave, yawSide);
      const cxs = [-p.choirLen / 4, p.choirLen / 4];
      layPanel(L, rnd, wall({
        y0: 0, y1: p.naveEaveY, halfW: p.choirLen / 2,
        openings: cxs.map((c) => lancetHole(choirW, c)),
      }));
      for (const c of cxs) layLancetRing(L, rnd, ringFor(choirW, c));
      // mid buttress
      L.setPanel(choirMid, s * zNave, yawSide);
      layButtress(L, rnd, {
        bw, bh, bd, w: 0.8, d: 0.9, h: p.naveEaveY - 2.4, y0: 0,
        steps: [{ y: 4.4, insetW: 0.1, insetD: 0.24 }, { y: 8.8, insetW: 0.1, insetD: 0.24 }],
        pinH: 2.2, pinW: 0.5,
      });
    }
    // east gable above the apse roof
    L.setPanel(xApse, 0, Math.PI / 2);
    layPanel(L, rnd, wall({
      y0: p.apseEaveY - 0.4, y1: p.naveRidgeY,
      halfW: gableProfile(zNave, p.naveEaveY, p.naveRidgeY),
      openings: [circleOpening(0, p.naveEaveY + 0.8, 0.85 + ringShell * 0.8)],
    }));
    layCircleRing(L, rnd, { cx: 0, cy: p.naveEaveY + 0.8, R: 0.85 + ringShell * 0.8, bw, bh, bd, ringDepth: 1.2, proud: 0.05 });
    layCross(L, rnd, 0, p.naveRidgeY + 0.05, 0, 1.4);

    // apse: half-octagon of 4 facets, east of xApse
    const Rap = zNave;
    const Rf = Rap * Math.cos(Math.PI / 8);
    const facetHalf = Rap * Math.sin(Math.PI / 8);
    const thetas = [-67.5, -22.5, 22.5, 67.5].map((d) => d * DEG);
    for (const th of thetas) {
      const px = xApse + Math.cos(th) * Rf;
      const pz = Math.sin(th) * Rf;
      // outward normal (cos th, sin th) → yaw with local z → that direction
      const yawF = Math.PI / 2 - th;
      L.setPanel(px, pz, yawF);
      layPanel(L, rnd, wall({
        y0: 0, y1: p.apseEaveY, halfW: facetHalf,
        openings: [lancetHole(apseW, 0)],
      }));
      layLancetRing(L, rnd, ringFor(apseW, 0));
    }
    // apse vertex buttresses
    const vAngles = [-90, -45, 0, 45, 90].map((d) => d * DEG);
    for (const th of vAngles) {
      const px = xApse + Math.cos(th) * (Rap - 0.1);
      const pz = Math.sin(th) * (Rap - 0.1);
      L.setPanel(px, pz, Math.PI / 2 - th);
      layButtress(L, rnd, {
        bw, bh, bd, w: 0.62, d: 0.72, h: p.apseEaveY - 1.2, y0: 0,
        steps: [{ y: 4.0, insetW: 0.08, insetD: 0.2 }],
        pinH: 1.7, pinW: 0.42,
      });
    }
  }

  // ═══ ROOFS ═════════════════════════════════════════════════════════════
  {
    const runMain = zNave + 0.55;
    // nave + choir main roof (ridge along X, through the crossing)
    const ridgeHalf = (xApse - xWest) / 2 + 0.4;
    const ridgeMid = (xApse + xWest) / 2;
    for (const s of [-1, 1]) {
      L.setPanel(ridgeMid, 0, s === 1 ? 0 : Math.PI);
      laySlatePlane(L, rnd, {
        ...slate, ridgeY: p.naveRidgeY, eaveY: p.naveEaveY - 0.15, run: runMain,
        halfLen: ridgeHalf, ridgeCaps: s === 1,
      });
    }
    // transept roof (ridge along Z)
    const tRidgeHalf = THL + 0.4;
    for (const s of [-1, 1]) {
      L.setPanel(0, 0, s === 1 ? Math.PI / 2 : -Math.PI / 2);
      laySlatePlane(L, rnd, {
        ...slate, ridgeY: p.naveRidgeY, eaveY: p.naveEaveY - 0.15, run: tHW + 0.55,
        halfLen: tRidgeHalf, ridgeCaps: s === 1,
      });
    }
    // aisle lean-tos
    for (const s of [-1, 1]) {
      L.setPanel(naveMidX, s * (zNave - 0.05), s === 1 ? 0 : Math.PI);
      laySlatePlane(L, rnd, {
        ...slate, ridgeY: p.aisleAttachY, eaveY: p.aisleEaveY - 0.1, run: p.aisleW + 0.5,
        halfLen: naveLen / 2 + 0.25,
      });
    }
    // apse faceted half-cone
    const RfR = zNave * Math.cos(Math.PI / 8) + 0.35;
    for (const th of [-67.5, -22.5, 22.5, 67.5].map((d) => d * DEG)) {
      L.setPanel(xApse, 0, Math.PI / 2 - th);
      laySlatePlane(L, rnd, {
        ...slate, ridgeY: p.apseApexY, eaveY: p.apseEaveY - 0.1, run: RfR,
        halfLen: (t) => (zNave * Math.sin(Math.PI / 8) + 0.3) * t,
      });
    }
    L.setPanel(xApse, 0, 0);
    L.box(0, p.apseApexY + 0.35, 0, 0, 0, 0.16, 0.9, 0.16, trimTone(rnd));
  }

  // ═══ CROSSING SPIRE ════════════════════════════════════════════════════
  if (p.spireEnabled) {
    const r = p.spireR;
    const baseY = p.naveRidgeY - 1.2;
    const drumTop = p.naveRidgeY + 1.6;
    // octagonal drum
    const facetW = 2 * r * Math.tan(Math.PI / 8);
    const rowH = bh + 0.012;
    const rows = Math.round((drumTop - baseY) / rowH);
    for (let iy = 0; iy < rows; iy++) {
      const y = baseY + rowH * (iy + 0.5);
      const twist = (iy % 2) * (Math.PI / 8);
      for (let f = 0; f < 8; f++) {
        const a = (f / 8) * Math.PI * 2 + twist;
        L.setPanel(Math.cos(a) * r * 0.88, Math.sin(a) * r * 0.88, -a + Math.PI / 2);
        L.box(0, y, 0, 0, 0, facetW * 0.9, bh, bd * 0.72, stoneTone(rnd));
      }
    }
    // 8 spire facets
    const runSp = r * Math.cos(Math.PI / 8) + 0.2;
    for (let f = 0; f < 8; f++) {
      const a = (f / 8) * Math.PI * 2;
      L.setPanel(0, 0, -a + Math.PI / 2);
      laySlatePlane(L, rnd, {
        ...slate, slateL: slate.slateL * 0.8,
        ridgeY: p.spireTopY, eaveY: drumTop - 0.15, run: runSp,
        halfLen: (t) => (r * Math.sin(Math.PI / 8) + 0.18) * t,
      });
    }
    // corner pinnacles around the drum + top cross
    for (let f = 0; f < 4; f++) {
      const a = (f / 4) * Math.PI * 2 + Math.PI / 4;
      L.setPanel(Math.cos(a) * (r + 0.55), Math.sin(a) * (r + 0.55), -a + Math.PI / 2);
      layPinnacle(L, rnd, { cx: 0, cz: 0, y0: baseY + 0.4, w: 0.52, h: 3.2, bw, bh, bd });
    }
    L.setPanel(0, 0, 0);
    layCross(L, rnd, 0, p.spireTopY - 0.05, 0, 2.1);
  }

  // ═══ Finish: one InstancedMesh ═════════════════════════════════════════
  const mesh = pl.toInstancedMesh(baseGeo, material);
  mesh.name = "gothicChurch";
  // toInstancedMesh clones the base geometry; release ours if we created it.
  if (!opts.baseGeo) baseGeo.dispose();

  // Dark interior core so windows read as depth, not sky (3 tiny meshes)
  const group = new THREE.Group();
  group.name = "gothicChurchGroup";
  group.add(mesh);
  if (opts.coreMaterial) {
    const mkCore = (w, h, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), opts.coreMaterial);
      m.position.set(x, h / 2 + 0.02, z);
      group.add(m);
    };
    mkCore(xApse - xWest - 1.2, p.naveEaveY + 0.8, zNave * 2 - 1.1, (xApse + xWest) / 2, 0);
    mkCore(tHW * 2 - 1.1, p.naveEaveY + 0.8, THL * 2 - 1.2, 0, 0);
    // Apse core is a cylinder so it stays inside the polygonal facets.
    const apseCore = new THREE.Mesh(
      new THREE.CylinderGeometry(zNave * 0.78, zNave * 0.78, p.apseEaveY - 0.6, 12),
      opts.coreMaterial,
    );
    apseCore.position.set(xApse, (p.apseEaveY - 0.6) / 2 + 0.02, 0);
    group.add(apseCore);
  }

  return { group, mesh, brickCount: mesh.count };
}
