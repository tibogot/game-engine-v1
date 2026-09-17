/**
 * PLACED PLANTS — imported GLB plants painted from Vegetation mode.
 *
 * Painted foliage, flowers and susuki are GPU scatter fields: endless, cheap,
 * but made of procedural shapes and stored as a density texture. An artist's
 * GLB bush or shrub needs the other model: real instances with a position,
 * a turn and a size each, drawn by the prop instancer (LOD, per-instance cull,
 * per-cascade shadows). So a placed plant IS a prop type whose slot carries
 * `plant` settings; this file plans where a brush stamp puts them.
 *
 * Pure (no scene, no DOM): the app passes the height sampler and the spacing
 * grid, so tools/placedPlantsTest.mjs runs it headless.
 */
import * as THREE from "three";

/** Per-plant brush settings, stored on the prop slot as `slot.plant`. */
export const PLACED_PLANT_DEFAULTS = Object.freeze({
  /** Plants per 100 m² at full brush strength (before spacing rejects some). */
  density: 12,
  /** No two plants closer than this, trunk to trunk (m). */
  minSpacing: 1.5,
  scaleMin: 0.8,
  scaleMax: 1.25,
  /** 0 = always upright, 1 = leans fully with the ground. */
  alignToNormal: 0.25,
  /** Steeper ground than this (degrees) grows nothing. */
  maxSlope: 40,
  /** Share of the plant's height pushed below the ground, so it never floats. */
  sink: 0.04,
  /** Plants do not block the player unless asked. */
  collide: false,
  /** Wind sway, as a multiple of the world's wind. 0 = dead still. */
  wind: 1,
});

/**
 * A grid of occupied points for the spacing test. The store's own hasNearby
 * walks every prop per attempt; a stroke tests hundreds of attempts against
 * thousands of props, so the stroke builds this once and adds as it places.
 */
export class SpacingGrid {
  constructor(cell = 2) {
    this.cell = Math.max(0.25, cell);
    this.map = new Map();
  }
  _key(ix, iz) { return `${ix},${iz}`; }
  add(x, z) {
    const k = this._key(Math.floor(x / this.cell), Math.floor(z / this.cell));
    let list = this.map.get(k);
    if (!list) this.map.set(k, (list = []));
    list.push(x, z);
  }
  hasWithin(x, z, d) {
    const d2 = d * d;
    const r = Math.ceil(d / this.cell);
    const ix = Math.floor(x / this.cell), iz = Math.floor(z / this.cell);
    for (let a = ix - r; a <= ix + r; a++) {
      for (let b = iz - r; b <= iz + r; b++) {
        const list = this.map.get(this._key(a, b));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 2) {
          const dx = list[i] - x, dz = list[i + 1] - z;
          if (dx * dx + dz * dz < d2) return true;
        }
      }
    }
    return false;
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _qTilt = new THREE.Quaternion();
const _qYaw = new THREE.Quaternion();
const _e = new THREE.Euler();
const DEG = 180 / Math.PI;

/** Ground normal from four height samples 1 m apart. */
export function groundNormal(getHeight, x, z, out = new THREE.Vector3()) {
  const hL = getHeight(x - 1, z), hR = getHeight(x + 1, z);
  const hD = getHeight(x, z - 1), hU = getHeight(x, z + 1);
  return out.set((hL - hR) * 0.5, 1, (hD - hU) * 0.5).normalize();
}

/**
 * Plan one brush stamp.
 * @param {object} o
 *   wx, wz, radius, strength   the stamp (m, 0..1)
 *   settings                   PLACED_PLANT_DEFAULTS shape
 *   typeIdx, typeHeight        the prop type and its unscaled height (m)
 *   getHeight(x, z)            terrain height (m)
 *   grid                       SpacingGrid of everything already standing; planned plants are added to it
 *   worldSize                  terrain edge (m) — nothing is placed off the map
 *   rand                       () => [0, 1), for tests
 * @returns {object[]} instance records for PropStore.instances
 */
export function planPlacedPlants({
  wx, wz, radius, strength = 1, settings, typeIdx, typeHeight = 1,
  getHeight, grid, worldSize, rand = Math.random,
}) {
  const s = { ...PLACED_PLANT_DEFAULTS, ...settings };
  const area = Math.PI * radius * radius;
  const attempts = Math.ceil((area / 100) * s.density * Math.max(0, Math.min(1, strength)));
  const half = worldSize * 0.5;
  const cosMax = Math.cos(Math.min(89.9, Math.max(0, s.maxSlope)) / DEG);
  const out = [];
  for (let i = 0; i < attempts; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radius;
    const x = wx + Math.cos(a) * r;
    const z = wz + Math.sin(a) * r;
    if (x < -half || x > half || z < -half || z > half) continue;
    if (grid.hasWithin(x, z, s.minSpacing)) continue;
    groundNormal(getHeight, x, z, _n);
    if (_n.y < cosMax) continue;

    const scale = s.scaleMin + rand() * Math.max(0, s.scaleMax - s.scaleMin);
    const yaw = rand() * Math.PI * 2;
    // Lean part of the way toward the ground normal, THEN turn about the
    // plant's own up — so the yaw never swings the lean off the slope.
    const lean = _n.clone().lerp(_up, 1 - Math.max(0, Math.min(1, s.alignToNormal))).normalize();
    _qTilt.setFromUnitVectors(_up, lean);
    _qYaw.setFromAxisAngle(_up, yaw);
    _e.setFromQuaternion(_qTilt.multiply(_qYaw), "XYZ");

    out.push({
      typeIdx,
      px: x,
      py: getHeight(x, z) - s.sink * typeHeight * scale,
      pz: z,
      rx: _e.x * DEG, ry: _e.y * DEG, rz: _e.z * DEG,
      sx: scale, sy: scale, sz: scale,
    });
    grid.add(x, z);
  }
  return out;
}

/**
 * Remove the placed plants inside a disc.
 * @param {object[]} instances   PropStore.instances (edited in place, swap-remove)
 * @param {(typeIdx:number) => boolean} matches   which types this erase may remove
 * @returns {number} how many were removed
 */
export function removePlantsInRadius(instances, wx, wz, radius, matches) {
  const r2 = radius * radius;
  let removed = 0;
  for (let i = instances.length - 1; i >= 0; i--) {
    const p = instances[i];
    if (!matches(p.typeIdx)) continue;
    const dx = p.px - wx, dz = p.pz - wz;
    if (dx * dx + dz * dz >= r2) continue;
    const last = instances.length - 1;
    if (i !== last) instances[i] = instances[last];
    instances.pop();
    removed++;
  }
  return removed;
}
