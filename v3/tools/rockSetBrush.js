/**
 * Rock-set brush — paint a natural rock field in one stroke with the
 * procedural rock kit (props/proceduralRock.js ROCK_KIT).
 *
 * Every candidate position picks a SIZE CLASS by the mix weights, then a random
 * shape of that class, a tilt (small rocks tilt more), an uneven scale and a
 * sink into the ground. Spacing is size-aware: two rocks of similar size keep
 * apart by their footprints, but a pebble may sit right against a boulder's
 * base. Big rocks also drop a few small "satellites" around themselves, which
 * is most of what makes a field look natural instead of evenly sprinkled.
 *
 * Pure planning: returns instance records, PropSystem pushes them (one store
 * bump, inside the stroke's undo step).
 */

/** Per class: rank (size order), base scale range, tilt (deg), sink (fraction of height), satellites. */
export const ROCK_SET_CLASSES = {
  boulder: { rank: 3, scale: [1.4, 3.0], tilt: 6,  sink: 0.12, satellites: [3, 6] },
  lump:    { rank: 2, scale: [1.1, 2.4], tilt: 8,  sink: 0.10, satellites: [2, 4] },
  rock:    { rank: 1, scale: [0.8, 1.8], tilt: 18, sink: 0.10, satellites: [0, 0] },
  pebble:  { rank: 0, scale: [0.7, 2.0], tilt: 30, sink: 0.12, satellites: [0, 0] },
};

export const ROCK_SET_DEFAULTS = {
  enabled: false,
  /** Relative weights of each class (normalised per stamp). */
  boulder: 0.08,
  lump: 0.12,
  rock: 0.3,
  pebble: 0.5,
  /** Small rocks scattered around each boulder / lump. */
  satellites: true,
  /** Multiplies every class's tilt (0 = upright). */
  tilt: 1,
  /** Footprint gap between rocks of similar size (1 = touching). */
  spread: 1.1,
};

/**
 * @param {object} o
 * @param {number} o.wx, o.wz, o.radius   stamp centre and brush radius (m)
 * @param {number} o.density               brush density (same meaning as the prop brush)
 * @param {number} o.scaleMin, o.scaleMax  brush scale range, multiplies the class ranges
 * @param {object} o.settings              ROCK_SET_DEFAULTS-shaped
 * @param {Record<string, number[]>} o.typesByClass  class → registered typeIdx list
 * @param {{ types: any[], instances: any[] }} o.store
 * @param {(x:number, z:number) => number} o.getWorldHeight
 * @param {number} o.halfWorld
 * @param {() => number} [o.rng]
 * @returns {object[]} instance records { typeIdx, px, py, pz, rx, ry, rz, sx, sy, sz }
 */
export function planRockStamp(o) {
  const rng = o.rng ?? Math.random;
  const s = o.settings;
  const classes = Object.keys(ROCK_SET_CLASSES).filter((c) => o.typesByClass[c]?.length && s[c] > 0);
  if (!classes.length) return [];
  const totalW = classes.reduce((a, c) => a + s[c], 0);

  const typeInfo = (t) => {
    const b = o.store.types[t]?.mergedBox;
    if (!b) return { r: 0.5, h: 1 };
    return { r: Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.5, h: b.max.y - b.min.y };
  };
  const rankOfType = new Map();
  for (const c of Object.keys(ROCK_SET_CLASSES)) {
    for (const t of o.typesByClass[c] ?? []) rankOfType.set(t, ROCK_SET_CLASSES[c].rank);
  }

  // Existing rocks near the stamp, once: { x, z, r, rank }. Non-kit props block
  // like a boulder so rocks do not grow through houses.
  const reach = o.radius + 12;
  const near = [];
  for (const inst of o.store.instances) {
    const dx = inst.px - o.wx, dz = inst.pz - o.wz;
    if (dx * dx + dz * dz > reach * reach) continue;
    const info = typeInfo(inst.typeIdx);
    near.push({ x: inst.px, z: inst.pz, r: info.r * Math.max(inst.sx, inst.sz), rank: rankOfType.get(inst.typeIdx) ?? 3 });
  }

  const blocked = (x, z, r, rank, ignore = null) => {
    for (const e of near) {
      if (e === ignore) continue;
      // similar sizes keep their footprints apart; a much smaller rock may
      // tuck against a big one's base
      const k = Math.abs(e.rank - rank) >= 2 ? 0.55 : s.spread;
      const d = (e.r + r) * k;
      const dx = e.x - x, dz = e.z - z;
      if (dx * dx + dz * dz < d * d) return true;
    }
    return false;
  };

  const out = [];
  const place = (cls, x, z, ignore) => {
    if (x < -o.halfWorld || x > o.halfWorld || z < -o.halfWorld || z > o.halfWorld) return null;
    const C = ROCK_SET_CLASSES[cls];
    const types = o.typesByClass[cls];
    const typeIdx = types[Math.floor(rng() * types.length)];
    const info = typeInfo(typeIdx);
    const brushScale = o.scaleMin + (o.scaleMax - o.scaleMin) * rng();
    const base = (C.scale[0] + (C.scale[1] - C.scale[0]) * rng()) * brushScale;
    const sx = base * (0.85 + rng() * 0.3);
    const sy = base * (0.8 + rng() * 0.4);
    const sz = base * (0.85 + rng() * 0.3);
    const r = info.r * Math.max(sx, sz);
    if (blocked(x, z, r, C.rank, ignore)) return null;
    const tilt = C.tilt * s.tilt;
    const rec = {
      typeIdx,
      px: x,
      py: o.getWorldHeight(x, z) - C.sink * info.h * sy,
      pz: z,
      rx: (rng() - 0.5) * 2 * tilt,
      ry: rng() * 360,
      rz: (rng() - 0.5) * 2 * tilt,
      sx, sy, sz,
    };
    const entry = { x, z, r, rank: C.rank };
    near.push(entry);
    out.push(rec);
    return entry;
  };

  const pickClass = () => {
    let t = rng() * totalW;
    for (const c of classes) { t -= s[c]; if (t <= 0) return c; }
    return classes[classes.length - 1];
  };

  const attempts = Math.ceil(Math.PI * o.radius * o.radius * o.density * 0.01);
  for (let i = 0; i < attempts; i++) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * o.radius;
    const cls = pickClass();
    const placed = place(cls, o.wx + Math.cos(a) * d, o.wz + Math.sin(a) * d, null);
    if (!placed || !s.satellites) continue;
    const [nMin, nMax] = ROCK_SET_CLASSES[cls].satellites;
    const n = nMin + Math.floor(rng() * (nMax - nMin + 1));
    const small = classes.filter((c) => ROCK_SET_CLASSES[c].rank <= 1);
    if (!small.length) continue;
    for (let j = 0; j < n; j++) {
      const sa = rng() * Math.PI * 2, sd = placed.r * (0.8 + rng() * 0.8);
      const sc = small.includes("pebble") && (rng() < 0.7 || !small.includes("rock")) ? "pebble" : small[0];
      place(sc, placed.x + Math.cos(sa) * sd, placed.z + Math.sin(sa) * sd, placed);
    }
  }
  return out;
}
