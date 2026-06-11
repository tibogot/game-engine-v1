import * as THREE from "three";

/**
 * Max capsule segments uploaded to the interior shader (WGSL loop count).
 * Long tunnels use a larger spacing automatically so the full path stays covered.
 */
export const INTERIOR_MAX_SEGMENTS = 192;
/** Max axis-aligned interior boxes (caves, future houses). */
export const INTERIOR_MAX_BOXES = 16;
/** Max open tunnel endpoints that fade to outdoor lighting. */
export const INTERIOR_MAX_OPEN_ENDS = 16;

const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _closest = new THREE.Vector3();

/**
 * CPU registry for world-stable interior lighting (tunnels, caves, manual boxes).
 * Rebuilt when splines/caves change; sampled each frame for ambient scaling.
 */
export class InteriorVolumeRegistry {
  constructor() {
    /** @type {Array<{ ax:number, ay:number, az:number, bx:number, by:number, bz:number, radius:number, softness:number }>} */
    this.segments = [];
    /** @type {Array<{ cx:number, cy:number, cz:number, hx:number, hy:number, hz:number, softness:number }>} */
    this.boxes = [];
    /** @type {Array<{ x:number, y:number, z:number }>} */
    this.openEnds = [];
  }

  clear() {
    this.segments.length = 0;
    this.boxes.length = 0;
    this.openEnds.length = 0;
  }

  /**
   * @param {import("../../tools/spline/splineSystem.js").SplineSystem | null} splineSystem
   * @param {import("../../core/cave/caveStore.js").CaveStore | null} caveStore
   * @param {object} interior — `toolState.interior`
   */
  rebuild(splineSystem, caveStore, interior) {
    this.clear();
    if (!interior?.enabled) return;

    const radiusScale = interior.tunnelRadiusScale ?? 0.92;
    const segStep = Math.max(1, interior.segmentStep ?? 4);
    const edgeSoft = THREE.MathUtils.clamp(interior.edgeSoftness ?? 0.35, 0.02, 0.9);
    const openingLen = Math.max(0, interior.openingLength ?? 8);

    const tunnels = (splineSystem?.tunnels ?? []).filter(
      (t) => Array.isArray(t.points) && t.points.length >= 2,
    );
    const tunnelMeta = tunnels.map((tunnel) => {
      const closed = !!tunnel.closed;
      const curve = new THREE.CatmullRomCurve3(
        tunnel.points.map((p) => new THREE.Vector3(p.x, p.y, p.z)),
        closed,
        "catmullrom",
        0.5,
      );
      return { tunnel, closed, curve, length: curve.getLength() };
    });
    const totalLength = tunnelMeta.reduce((s, m) => s + m.length, 0);
    let segmentsLeft = INTERIOR_MAX_SEGMENTS;

    for (const { tunnel, closed, curve, length } of tunnelMeta) {
      if (segmentsLeft <= 0) break;
      const radius = Math.max(0.5, (tunnel.radius ?? 6) * radiusScale);
      const idealSegs = Math.max(1, Math.ceil(length / segStep));
      let budget = idealSegs;
      if (tunnelMeta.length === 1) {
        budget = Math.min(idealSegs, segmentsLeft);
      } else if (totalLength > 1e-4) {
        budget = Math.min(
          idealSegs,
          Math.max(4, Math.round((INTERIOR_MAX_SEGMENTS * length) / totalLength)),
          segmentsLeft,
        );
      } else {
        budget = Math.min(idealSegs, segmentsLeft);
      }
      const sampleCount = Math.max(2, budget + 1);
      const samples = curve.getSpacedPoints(sampleCount);
      const startIdx = this.segments.length;
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        this.segments.push({
          ax: a.x,
          ay: a.y,
          az: a.z,
          bx: b.x,
          by: b.y,
          bz: b.z,
          radius,
          softness: edgeSoft,
        });
      }
      segmentsLeft -= this.segments.length - startIdx;

      if (!closed) {
        const capStart = tunnel.capStart === true;
        const capEnd = tunnel.capEnd === true;
        const mouthA = samples[0];
        const mouthB = samples[samples.length - 1];
        if (!capStart && this.openEnds.length < INTERIOR_MAX_OPEN_ENDS) {
          this.openEnds.push({
            x: mouthA.x,
            y: mouthA.y,
            z: mouthA.z,
            fade: openingLen,
          });
        }
        if (!capEnd && this.openEnds.length < INTERIOR_MAX_OPEN_ENDS) {
          this.openEnds.push({
            x: mouthB.x,
            y: mouthB.y,
            z: mouthB.z,
            fade: openingLen,
          });
        }
      }
    }

    if (caveStore) {
      const boxSoft = THREE.MathUtils.clamp(interior.boxEdgeSoftness ?? 0.25, 0.02, 0.9);
      for (const a of caveStore.getAll()) {
        if (this.boxes.length >= INTERIOR_MAX_BOXES) break;
        const hx = a.width * 0.5 * (interior.caveShrink ?? 0.94);
        const hy = a.height * 0.5 * (interior.caveShrink ?? 0.94);
        const hz = a.depth * 0.5 * (interior.caveShrink ?? 0.94);
        const cy = a.surfaceY - a.ceilingOffset - hy;
        this.boxes.push({
          cx: a.x,
          cy,
          cz: a.z,
          hx,
          hy,
          hz,
          softness: boxSoft,
        });
      }
    }

    for (const box of interior.manualBoxes ?? []) {
      if (this.boxes.length >= INTERIOR_MAX_BOXES) break;
      if (box.hx == null || box.hy == null || box.hz == null) continue;
      this.boxes.push({
        cx: box.cx ?? 0,
        cy: box.cy ?? 0,
        cz: box.cz ?? 0,
        hx: box.hx,
        hy: box.hy,
        hz: box.hz,
        softness: THREE.MathUtils.clamp(box.softness ?? interior.boxEdgeSoftness ?? 0.25, 0.02, 0.9),
      });
    }
  }

  /**
   * Interior factor 0 = outdoor, 1 = deep inside (matches shader logic).
   * @param {THREE.Vector3} worldPos
   */
  sampleFactorAt(worldPos, interior) {
    if (!interior?.enabled) return 0;
    let factor = 0;

    for (const s of this.segments) {
      _v0.set(s.ax, s.ay, s.az);
      _v1.set(s.bx, s.by, s.bz);
      const f = _capsuleFactor(worldPos, _v0, _v1, s.radius, s.softness);
      if (f > factor) factor = f;
    }

    for (const b of this.boxes) {
      const f = _boxFactor(worldPos, b);
      if (f > factor) factor = f;
    }

    if (factor > 1e-4) {
      let openingMul = 1;
      for (const end of this.openEnds) {
        const fade = Math.max(0.001, end.fade ?? 8);
        const d = worldPos.distanceTo(_closest.set(end.x, end.y, end.z));
        const m = THREE.MathUtils.smoothstep(0, fade, d);
        if (m < openingMul) openingMul = m;
      }
      factor *= openingMul;
    }

    return THREE.MathUtils.clamp(factor, 0, 1);
  }
}

function _capsuleFactor(p, a, b, radius, softness) {
  const ab = _v1.subVectors(b, a);
  const lenSq = ab.lengthSq();
  let t = 0;
  if (lenSq > 1e-8) {
    t = THREE.MathUtils.clamp(_v0.subVectors(p, a).dot(ab) / lenSq, 0, 1);
  }
  _closest.copy(a).addScaledVector(ab, t);
  const dist = p.distanceTo(_closest);
  const edge = radius * softness;
  const inner = Math.max(0, radius - edge);
  const outer = radius + edge;
  if (dist <= inner) return 1;
  if (dist >= outer) return 0;
  return 1 - THREE.MathUtils.smoothstep(inner, outer, dist);
}

function _boxFactor(p, box) {
  const lx = Math.abs(p.x - box.cx);
  const ly = Math.abs(p.y - box.cy);
  const lz = Math.abs(p.z - box.cz);
  const hx = box.hx;
  const hy = box.hy;
  const hz = box.hz;
  const soft = box.softness;
  const sx = hx * soft;
  const sy = hy * soft;
  const sz = hz * soft;
  const fx =
    lx <= hx - sx
      ? 1
      : lx >= hx
        ? 0
        : 1 - THREE.MathUtils.smoothstep(hx - sx, hx, lx);
  const fy =
    ly <= hy - sy
      ? 1
      : ly >= hy
        ? 0
        : 1 - THREE.MathUtils.smoothstep(hy - sy, hy, ly);
  const fz =
    lz <= hz - sz
      ? 1
      : lz >= hz
        ? 0
        : 1 - THREE.MathUtils.smoothstep(hz - sz, hz, lz);
  return fx * fy * fz;
}
