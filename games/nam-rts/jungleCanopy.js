// THE CANOPY — where the rainforest stands. GAME code, nam-rts only.
//
// The map had palms, bamboo and ferns and no canopy at all: from the RTS
// camera it read as savanna. The canopy tree is the engine's DIPTEROCARP
// (dipterocarpGeometry.js), in the tall-plant field's fourth slot (the alpha
// channel, reserved for jungle trees); this file decides where it grows.
//
// YOUR CALL (2026-09-24): "FRAME THE FIGHT". Canopy hides whatever is under
// it, and an RTS has to be read from above, so the forest goes where nobody
// fights:
//
//   · SLOPE BELTS  dense on the slopes units cannot climb (the nav rule, 34°),
//                  spilling a few metres onto the walkable ground at their
//                  edge (the crowns overhang ~10 m more), so every open
//                  fighting ground is RIMMED by jungle.
//   · MAP EDGES    forest in from the border: the valley sits in jungle.
//   · GROVES       a few clumps out on the open ground, from low-frequency
//                  noise — landmarks and cover, not a wall.
//   · THE FRINGE   palms (coconut and fan) and traveller's palms along the
//                  sunlit margin outside the canopy — where palms really
//                  grow; added on top of the map's own palm paint.
//   · CLEARINGS    none of it round the camp, the enemy HQ, the points, the
//                  hamlets, the temple, the enemy's nests, or in water. The
//                  engine's paint mask already keeps the field off painted
//                  trails (paint layers that block grass).
//
// Runtime, like clearVegetation: painted after every level load, not saved.
// The paint is 2 m texels (512² over 1024 m); the tree's own density sets its
// spacing: 0.1 (the field) × the value here per 1.4 m grid cell.
import { NAV_MAX_SLOPE_DEG } from "./navGrid.js";

export const CANOPY = {
  channel: 3,
  /** Paint value in the forest proper, and in a grove. */
  forest: 0.16,
  grove: 0.11,
  /**
   * Walkable metres the forest spills onto from a steep slope's edge. 4, not
   * 12: a crown is ~20 m across, so a trunk at the belt's edge already
   * shades 10 m further — at 12 the open centre of the map went under canopy
   * (the first try).
   */
  belt: 4,
  /** Metres from the map edge where the edge forest starts and is full. */
  edgeStart: 85, edgeFull: 45,
  /** Metres beyond the belt that the sunlit fringe (the palms) reaches. */
  fringe: 28,
  /** The palm fringe: which tall-plant channels, and their paint there. */
  palms: { coconutChannel: 2, coconut: 0.3, fanChannel: 0, fan: 0.18 },
  /**
   * The forest floor: ground-foliage channel (the map's order: 0 card fern,
   * 1 bush, 3 banana, 7 giant fern), its paint, and where — under the
   * canopy or on its sunlit fringe. Seeds keep each plant in its own drifts.
   */
  undergrowth: [
    { channel: 7, value: 0.7, where: "forest", seed: 3 },
    { channel: 0, value: 0.45, where: "forest", seed: 11 },
    { channel: 1, value: 0.6, where: "forest", seed: 23 },
    { channel: 3, value: 0.3, where: "fringe", seed: 37 },
  ],
  /** Traveller's palms: grid step, chance per cell on the fringe, min gap. */
  travellers: { step: 16, chance: 0.12, minGap: 20 },
  /** Clearing radii, metres, and how far they feather. */
  // gun: nests, towers, ZPUs — a crown overhangs ~10 m past its trunk, and a
  // gun needs its field of fire (at 16 a watchtower stood under a crown).
  // nest: everything else the Front digs (tunnels, spider holes, pits): kept
  // small — the jungle is what hides them.
  clear: { base: 75, enemyBase: 60, point: 30, gun: 28, nest: 12, hamlet: 55, temple: 70, feather: 18 },
};

const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Cheap deterministic value noise in 2-D (Math.imul, see ref_js_value_noise_imul). */
function valueNoise(seed) {
  const h = (x, z) => {
    let n = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(seed, 2147483647);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  return (x, z) => {
    const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sz;
  };
}

/**
 * The forest RULE, built once: `forest(x, z)` 0-1 (the canopy proper),
 * `fringe(x, z)` 0-1 (the band just outside it, where the light reaches the
 * ground: palms), `open(x, z)` 0-1 (1 = not in any clearing), `wet(x, z)`.
 */
export function canopyField(app, sites, params = CANOPY) {
  const world = app.worldSize ?? 1024;
  const half = world / 2;
  const cosMax = Math.cos((NAV_MAX_SLOPE_DEG * Math.PI) / 180);

  // Steep mask on a 4 m grid, then its distance field out past the belt and
  // the fringe, so the forest spills onto the walkable ground beside a slope
  // and the palms stand just beyond it.
  const g = 4, n = Math.ceil(world / g);
  const steep = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * g, z = -half + (j + 0.5) * g;
      if (app.getWorldNormal(x, z).y < cosMax) steep[j * n + i] = 1;
    }
  }
  const reach = Math.ceil((params.belt + params.fringe) / g);
  const near = new Float32Array(n * n).fill(1e9);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (!steep[j * n + i]) continue;
      for (let dj = -reach; dj <= reach; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= n) continue;
        for (let di = -reach; di <= reach; di++) {
          const ii = i + di; if (ii < 0 || ii >= n) continue;
          const d = Math.hypot(di, dj) * g;
          if (d < near[jj * n + ii]) near[jj * n + ii] = d;
        }
      }
    }
  }
  const steepDist = (x, z) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor((x + half) / g)));
    const j = Math.min(n - 1, Math.max(0, Math.floor((z + half) / g)));
    return near[j * n + i];
  };

  const grove = valueNoise(911), wob = valueNoise(313);
  const edgeDist = (x, z) => half - Math.max(Math.abs(x), Math.abs(z)) + (wob(x / 60, z / 60) - 0.5) * 50;
  const groveV = (x, z) => grove(x / 120, z / 120) * 0.7 + grove(x / 40 + 7, z / 40) * 0.3;
  const feather = params.clear.feather;

  const raw = {
    open(x, z) {
      let o = 1;
      for (const s of sites) {
        const d = Math.hypot(x - s.x, z - s.z);
        if (d < s.r + feather) o = Math.min(o, smooth(s.r, s.r + feather, d));
        if (o === 0) return 0;
      }
      return o;
    },
    wet(x, z) {
      const wl = app.getWaterLevelAt?.(x, z) ?? -Infinity;
      return wl > app.getWorldHeight(x, z) - 0.3;
    },
    /** The canopy proper: slope belts, the map's edge (wobbled), groves. */
    forest(x, z) {
      const belt = 1 - smooth(params.belt * 0.5, params.belt + 1e-3, steepDist(x, z));
      const edge = 1 - smooth(params.edgeFull, params.edgeStart, edgeDist(x, z));
      const clump = smooth(0.66, 0.74, groveV(x, z));
      return Math.max(belt, edge, clump * (params.grove / params.forest));
    },
    /**
     * Just outside the canopy: the sunlit margin, where the palms grow — and
     * NOT under any crown: a grove or another slope's forest overlapping the
     * band put palms (and traveller's palms) under the canopy. No forest
     * within 10 m (a crown's overhang) of the point.
     */
    fringe(x, z) {
      let under = this.forest(x, z);
      for (let k = 0; k < 6 && under < 0.5; k++) {
        const a = (k / 6) * Math.PI * 2;
        under = Math.max(under, this.forest(x + Math.cos(a) * 10, z + Math.sin(a) * 10));
      }
      return this.margin(x, z) * (1 - smooth(0.2, 0.5, under));
    },
    /** The margin band itself, before the under-canopy test. */
    margin(x, z) {
      const d = steepDist(x, z), b = params.belt, f = params.fringe;
      // From ~9 m out, past the edge trees' overhanging crowns (the first
      // try started at the belt and its palms stood under the canopy).
      const slope = smooth(b + 7, b + 10, d) * (1 - smooth(b + f * 0.7, b + f, d));
      const e = edgeDist(x, z);
      const edge = smooth(params.edgeStart + 4, params.edgeStart + 9, e) * (1 - smooth(params.edgeStart + f * 0.7, params.edgeStart + f, e));
      const gv = groveV(x, z);
      const grv = smooth(0.54, 0.58, gv) * (1 - smooth(0.61, 0.64, gv));
      return Math.max(slope, edge, grv);
    },
  };

  // BAKED ONCE onto a 2 m grid (the tall paint's own texel): every painter
  // reads the grid, not the rule. Evaluated per texel, the fringe's
  // under-canopy test (7 forest samples) and the clearing loop made the
  // jungle 2.9 s of the boot; baked, it is a fraction of that.
  const gs = 2, gn = Math.ceil(world / gs);
  const bake = (fn) => {
    const a = new Float32Array(gn * gn);
    for (let j = 0; j < gn; j++) {
      const z = -half + (j + 0.5) * gs;
      for (let i = 0; i < gn; i++) a[j * gn + i] = fn.call(raw, -half + (i + 0.5) * gs, z);
    }
    return (x, z) => {
      const i = Math.min(gn - 1, Math.max(0, Math.floor((x + half) / gs)));
      const j = Math.min(gn - 1, Math.max(0, Math.floor((z + half) / gs)));
      return a[j * gn + i];
    };
  };
  const open = bake(raw.open), forest = bake(raw.forest), fringe = bake(raw.fringe);
  const wetGrid = bake((x, z) => (raw.wet(x, z) ? 1 : 0));
  return { open, forest, fringe, wet: (x, z) => wetGrid(x, z) > 0.5 };
}

/**
 * Paint the canopy. `sites` are the clearings: { x, z, r } in metres.
 * Returns the field (for the palms) and the number of forest texels.
 */
export function paintCanopy(app, sites, params = CANOPY) {
  if (!app.paintTallPlantChannel) return { field: null, texels: 0 };
  const field = canopyField(app, sites, params);
  const texels = app.paintTallPlantChannel(params.channel, (x, z) => {
    if (field.wet(x, z)) return 0;
    const o = field.open(x, z);
    return o && Math.min(1, field.forest(x, z)) * params.forest * o;
  });
  return { field, texels };
}

/**
 * THE PALM FRINGE (your ask, 2026-09-24: "more palm trees in the jungle").
 * Palms are light-demanding: they do not grow UNDER a closed canopy but along
 * its sunlit margin — the forest's edge, a grove's rim. Painted ON TOP of the
 * map's own palm paint (blend "max"), coconut and fan palm in separate
 * patches so each makes its own stands. Returns the texels touched.
 */
export function paintPalmFringe(app, field, params = CANOPY) {
  const P = params.palms, split = valueNoise(577);
  let n = 0;
  for (const [channel, value, pick] of [[P.coconutChannel, P.coconut, 1], [P.fanChannel, P.fan, 0]]) {
    n += app.paintTallPlantChannel(channel, (x, z) => {
      if (field.wet(x, z)) return 0;
      const o = field.open(x, z);
      if (!o) return 0;
      const s = split(x / 70, z / 70);
      const mine = pick ? smooth(0.35, 0.55, s) : 1 - smooth(0.45, 0.65, s);
      return field.fringe(x, z) * mine * value * o;
    }, { blend: "max" });
  }
  return n;
}

/**
 * THE UNDERGROWTH (your order, 2026-09-24): the forest floor under the canopy
 * — giant ferns, card ferns and shrubs, thick and patchy, so what shows in the
 * cracks between crowns and under the edge is jungle, not grass or bare
 * slope; and wild banana on the sunlit fringe. ADDED on top of the map's own
 * paint (blend "max"). The field's own slope rule still thins it past ~44°,
 * so the steepest rock keeps saying "no one walks here".
 */
export function paintUndergrowth(app, field, params = CANOPY) {
  if (!app.paintFoliageChannel) return 0;
  const U = params.undergrowth;
  const patch = valueNoise(2203), patch2 = valueNoise(719);
  let n = 0;
  for (const { channel, value, where, seed } of U) {
    n += app.paintFoliageChannel(channel, (x, z) => {
      if (field.wet(x, z)) return 0;
      const o = field.open(x, z);
      if (!o) return 0;
      const zone = where === "fringe" ? field.fringe(x, z) : smooth(0.2, 0.6, field.forest(x, z));
      if (zone <= 0) return 0;
      // Patchy: each plant in its own drifts, so the floor is not a carpet.
      const p = patch(x / 26 + seed, z / 26) * 0.65 + patch2(x / 9, z / 9 + seed) * 0.35;
      return zone * smooth(0.35, 0.6, p) * value * o;
    }, { blend: "max" });
  }
  return n;
}

/**
 * TRAVELLER'S PALMS out in the wild (your ask, 2026-09-24): they were only at
 * the hamlet and the temple. Scattered along the same sunlit fringe, sparse,
 * never in a clearing, on water or on a slope. Returns the points.
 */
export function travellerPalmSpots(app, field, params = CANOPY) {
  const T = params.travellers, out = [];
  const world = app.worldSize ?? 1024, half = world / 2;
  const cosMax = Math.cos((NAV_MAX_SLOPE_DEG * Math.PI) / 180);
  let seed = 4099;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let z = -half + T.step; z < half - T.step; z += T.step) {
    for (let x = -half + T.step; x < half - T.step; x += T.step) {
      const px = x + (rand() - 0.5) * T.step, pz = z + (rand() - 0.5) * T.step;
      const r = rand();
      if (field.fringe(px, pz) < 0.4 || r > T.chance) continue;
      if (field.wet(px, pz) || field.open(px, pz) < 1) continue;
      if (app.getWorldNormal(px, pz).y < cosMax) continue;
      if (out.some((p) => Math.hypot(p.x - px, p.z - pz) < T.minGap)) continue;
      out.push({ x: px, z: pz, rotY: rand() * Math.PI * 2, scale: 0.8 + rand() * 0.4 });
    }
  }
  return out;
}

/**
 * The clearings nam-rts needs: the camp, the enemy HQ, the points, the
 * enemy's nests, the hamlets and the temple.
 */
export function canopyClearings({ structures, requisition, hamlets = [], temples = [] }, params = CANOPY) {
  const c = params.clear, out = [];
  const at = (p, r) => p && out.push({ x: p.x, z: p.z, r });
  at(structures.base?.position, c.base);
  at(structures.enemyBase?.position, c.enemyBase);
  for (const p of requisition?.points ?? []) at(p.position, c.point);
  for (const s of structures.list ?? []) {
    if (s === structures.base || s === structures.enemyBase) continue;
    if (s.team !== "enemy" || s.typeKey === "trainingDummy") continue;
    const gun = s.typeKey === "turret" || s.typeKey === "tower" || s.typeKey === "zpu";
    at(s.position, gun ? c.gun : c.nest);
  }
  for (const h of hamlets) at(h, c.hamlet);
  for (const t of temples) at(t, c.temple);
  return out;
}
