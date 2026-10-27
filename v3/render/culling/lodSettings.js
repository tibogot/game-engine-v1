/**
 * ONE LOD SETTINGS SHAPE (v3/CULLING_LOD_SPEC.md, R3) — and every name it had before.
 *
 *   { distances: [d0, d1, …], hysteresis, fade, impostorFrom, cullFrom, floors }   (metres)
 *
 *   distances     the tier boundaries, nearest first: tier 0 inside d0, 1 up to d1, …
 *   hysteresis    ± fraction around a boundary (cpuCull.lodTier), default LOD_HYSTERESIS
 *   fade          metres of cross-fade at a boundary (R4) — null where a system has none
 *   impostorFrom  where the impostor takes over (R5) — null: no impostor tier
 *   cullFrom      beyond it nothing draws — null: never culled by distance
 *   floors        the nearest each boundary may come (an RTS camera's zoom) — null: none
 *
 * Every system named these its own way, and saved levels / presets keep those names, so they
 * are all read here (a field missing stays null; the caller keeps its own default):
 *
 *   lodDistances: [a, b]                    placedFoliage, gpuInstanceField
 *   lodDistances: { lod1: a, lod2: b }      tree presets (public/tree-presets/*.json)
 *   lod0Distance / lod1Distance             props, trees, leaf clouds (levels, main.js propLod)
 *   lodDistance / lodDistance2              the plant fields (scatterField, foliage / flower state)
 *   lod0Dist / lod1Dist                     older labs
 *   fadeOutDistance / fadeDistance / cullDistance   → cullFrom
 *   impostorDistance                        → impostorFrom
 *   lodFloors                               → floors
 *
 * The new name wins over an old one when both are given.
 */
import { LOD_HYSTERESIS } from "./cpuCull.js";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const firstNum = (...vs) => { for (const v of vs) { const n = num(v); if (n !== null) return n; } return null; };

function distancesOf(s) {
  if (Array.isArray(s.distances)) return s.distances.map(num).filter((v) => v !== null);
  const ld = s.lodDistances;
  if (Array.isArray(ld)) return ld.map(num).filter((v) => v !== null);
  if (ld && typeof ld === "object") {
    const out = [];
    for (let i = 1; num(ld[`lod${i}`]) !== null; i++) out.push(ld[`lod${i}`]);
    return out;
  }
  for (const [a, b] of [["lod0Distance", "lod1Distance"], ["lodDistance", "lodDistance2"], ["lod0Dist", "lod1Dist"]]) {
    const d0 = num(s[a]), d1 = num(s[b]);
    if (d0 !== null || d1 !== null) return d0 !== null && d1 !== null ? [d0, d1] : d0 !== null ? [d0] : [null, d1];
  }
  return [];
}

/**
 * Any LOD settings object (new shape, old names, or both) → the one shape.
 * @param {object|null|undefined} settings
 * @returns {{ distances: (number|null)[], hysteresis: number, fade: number|null, impostorFrom: number|null,
 *             cullFrom: number|null, floors: number[]|null }}
 */
export function readLod(settings) {
  const s = settings ?? {};
  const floors = s.floors ?? s.lodFloors;
  return {
    distances: distancesOf(s),
    hysteresis: firstNum(s.hysteresis) ?? LOD_HYSTERESIS,
    fade: firstNum(s.fade),
    impostorFrom: firstNum(s.impostorFrom, s.impostorDistance),
    cullFrom: firstNum(s.cullFrom, s.fadeOutDistance, s.fadeDistance, s.cullDistance),
    floors: Array.isArray(floors) ? floors.map(num) : null,
  };
}
