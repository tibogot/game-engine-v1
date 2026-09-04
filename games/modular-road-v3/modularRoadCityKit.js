// ============================================================================
// CITY KIT — the ARCHETYPE geometry. A small fixed set of towers, generated
// once at load, reused by every instance in the city.
//
// ── WHAT THIS TAKES FROM THE three.js CITY GENERATOR, AND WHAT IT DOES NOT ───
//
// three's `examples/jsm/generators/CityGenerator.js` + `SkyscraperGenerator`
// (dev branch — NOT in r184, there is no examples/jsm/generators in the
// installed copy) has a genuinely good massing parameterisation: totalHeight,
// floorHeight, setbackDepth, stringCourseEvery. That is the hard part of making
// towers that do not read as stacked Lego, and it is what is borrowed here.
//
// What is deliberately NOT borrowed is its scene assembly. It builds one plain
// `Mesh` per building and `group.add( building )`s it, with a default of 12
// buildings and no LOD. At the 500–2000 towers a skyline needs, that is
// thousands of draw calls — the same shape of problem as the rts-v3 364-draw
// bake. So the generator output is treated as a BAKING step that produces a
// handful of shared geometries, and placement is somebody else's job
// (modularRoadCity.js).
//
// ── THE TRIANGLE BUDGET IS NOT THE POINT, BUT IT IS FREE ─────────────────────
//
// Every facade detail that could be geometry is a shader instead
// (modularRoadCityFacade.js), so geometry here only has to carry SILHOUETTE:
// setbacks, podiums, ledges, crowns, masts. A full-detail tower lands around
// 60–250 triangles. A 2400-building city is therefore well under a million
// triangles even before LOD, which for a car game passing at 45 m/s is nothing
// — measured, the workload is not triangle-bound at all (the instanced backend
// submits 2.3× the triangles of the batched one and is still faster).
//
// ── LOD TIERS ────────────────────────────────────────────────────────────────
//
//   L0  full — tiers, setback ledges, string courses, crown, roof clutter
//   L1  tiers + roof furniture. Same ROOFLINE exactly, fewer facade ledges.
//   L2  one box of the massing envelope (mast excluded). Beyond ~800 m a
//       tower IS a box; the facade shader has already dissolved to a flat tint
//       by then, so there is nothing left for the geometry to say.
//
// L0 and L1 share their roofline to the float, because the L0->L1 swap happens
// at ~220 m where a changing roofline is plainly visible. L2 is the massing
// height WITHOUT the mast: a 0.5 m needle scaled up into a full-width box would
// make every distant tower read 20 m too tall.
//
// ── ATTRIBUTE NORMALISATION ──────────────────────────────────────────────────
//
// mergeGeometries returns NULL, silently, if the inputs disagree on attributes.
// Everything here is BoxGeometry (position/normal/uv, identical layout), which
// keeps it out of that trap — but the merge result is asserted rather than
// trusted, because a silent null mesh is a very expensive thing to debug.
// ============================================================================
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Deterministic RNG — same seed, same city, every reload. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const KIT_DEFAULTS = {
  /** How many distinct towers to bake. More = less repetition, more pipeline
   *  state on the instanced backend (one InstancedMesh per archetype per tier).
   *  Measured at 14: 34 draws for a whole city. 18 is still nothing. */
  archetypes: 18,
  /** Footprint range, metres. Kept BELOW the lot size so buildings are inset —
   *  the facade's per-building hash is the lot cell, and a tower that spilled
   *  into its neighbour's lot would change tint halfway up. */
  minFootprint: 16,
  maxFootprint: 28,
  /** Height range, metres. The instance Y-scale spreads it further at runtime.
   *  `tall = rnd()²` keeps most of the set mid-rise, so a high ceiling buys a
   *  few real towers downtown rather than a wall — and a sky track at 40 m
   *  wants something to fly BETWEEN. */
  minHeight: 24,
  maxHeight: 300,
  /** Chance a tower steps in as it rises, and how hard. */
  setbackChance: 0.62,
  maxSetbacks: 3,
  setbackDepth: 0.16,
  /** Chance of a PODIUM: a wide low base with a narrower tower on it. The
   *  commonest tall-building form there is, and the one that reads best from
   *  a road at its foot — the podium is what you drive past. */
  podiumChance: 0.32,
  /** A ledge slab at every setback, and a thin band every N storeys. */
  ledgeOverhang: 0.55,
  stringCourseEvery: 9,
  floorHeight: 3.7,
  /** Roof furniture — mechanical penthouse, water tank, mast. */
  crownChance: 0.8,
  mastChance: 0.45,
  /** LANDMARKS: extra archetypes forced well above the ceiling, so the skyline
   *  has a shape you recognise. The layout places them only near downtown. */
  landmarks: 3,
  landmarkHeight: 1.6,   // × maxHeight, upper end
};

/**
 * One box, centred in XZ, sitting on `y`.
 * Returns a geometry already translated into archetype-local space (origin at
 * the building's base centre) — which is what the facade shader assumes when it
 * reads `positionGeometry` for the across-facade axis.
 */
function box(w, h, d, y, x = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

/**
 * Generate one archetype at three levels of detail.
 *
 * @param {() => number} rnd seeded RNG
 * @param {object} K kit params
 */
function buildArchetype(rnd, K, forceH = null) {
  const w0 = K.minFootprint + rnd() * (K.maxFootprint - K.minFootprint);
  // Slabs (a wide, shallow footprint) read very differently from square towers
  // and are what stop a skyline looking like a bundle of pencils.
  const slab = rnd() < 0.3;
  const d0 = slab ? w0 * (0.45 + rnd() * 0.25) : w0 * (0.85 + rnd() * 0.3);

  // Height distribution skewed low — a real skyline is mostly mid-rise with a
  // few towers. A flat distribution gives you a wall, not a skyline.
  const tall = rnd() * rnd();
  const H = forceH ?? (K.minHeight + tall * (K.maxHeight - K.minHeight));

  const podium = H > 60 && rnd() < K.podiumChance;
  const nSet = rnd() < K.setbackChance ? 1 + Math.floor(rnd() * K.maxSetbacks) : 0;

  // ── Tier stack ─────────────────────────────────────────────────────────────
  // Each tier is a box from `y` up to the next setback, narrower than the last.
  const tiers = [];
  let y = 0, w = w0, d = d0;

  if (podium) {
    // Three to five storeys of full-footprint base, then a tower on roughly
    // half the footprint. The step is big and low — the opposite of a setback.
    const ph = K.floorHeight * (3 + Math.floor(rnd() * 3));
    tiers.push({ y: 0, h: ph, w: w0, d: d0 });
    y = ph;
    w = w0 * (0.5 + rnd() * 0.18);
    d = d0 * (0.5 + rnd() * 0.18);
  }

  for (let i = 0; i <= nSet; i++) {
    // Setbacks bunch toward the top: the first tier carries most of the height.
    const remaining = H - y;
    const frac = i === nSet ? 1 : 0.35 + rnd() * 0.3;
    const h = remaining * frac;
    tiers.push({ y, h, w, d });
    y += h;
    w *= 1 - K.setbackDepth * (0.6 + rnd() * 0.8);
    d *= 1 - K.setbackDepth * (0.6 + rnd() * 0.8);
  }

  const full = [];
  const mid = [];

  for (const t of tiers) {
    const g = box(t.w, t.h, t.d, t.y);
    full.push(g);
    mid.push(g.clone());
  }

  // ── Setback / podium ledges (L0 only) ──────────────────────────────────────
  // A thin slab overhanging each step. Without them a setback is a bare notch
  // and the tower reads as a stack of boxes, which is exactly what it is.
  for (let i = 1; i < tiers.length; i++) {
    const t = tiers[i];
    const o = K.ledgeOverhang;
    full.push(box(t.w + o * 2, 0.5, t.d + o * 2, t.y - 0.25));
  }

  // ── String courses (L0 only) ───────────────────────────────────────────────
  // A band every N storeys. Cheap horizontal rhythm, and it gives the eye
  // something to measure the building's height against at speed.
  if (K.stringCourseEvery > 0) {
    const step = K.stringCourseEvery * K.floorHeight;
    for (const t of tiers) {
      for (let by = step; by < t.h - step * 0.5; by += step) {
        full.push(box(t.w + 0.35, 0.35, t.d + 0.35, t.y + by));
      }
    }
  }

  // ── Crown + roof clutter ───────────────────────────────────────────────────
  // ALL of it goes into L1 as well as L0. Roof furniture is SILHOUETTE, and the
  // L0->L1 swap happens at ~220 m where a changing roofline is plainly visible.
  // The only things L1 drops are the ledges and string courses, which are
  // facade detail and change nothing about the outline.
  const top = tiers[tiers.length - 1];
  const topY = top.y + top.h;
  // The massing envelope — tiers plus the mechanical penthouse. This, and NOT
  // the mast, is what L2's single box has to match.
  let massTop = topY;
  let spireTop = topY;
  /** Height of the mast tip, or null — where an aviation beacon goes. */
  let mastTop = null;

  if (rnd() < K.crownChance) {
    const cw = top.w * (0.4 + rnd() * 0.28);
    const cd = top.d * (0.4 + rnd() * 0.28);
    const ch = 2.5 + rnd() * 5.5;
    full.push(box(cw, ch, cd, topY));
    mid.push(box(cw, ch, cd, topY));
    massTop = topY + ch;
    spireTop = massTop;

    if (rnd() < 0.5) {
      // Water tank, offset — asymmetry on the roofline is worth 2 triangles.
      const tw = 2 + rnd() * 2;
      const th = 2.5 + rnd() * 2;
      full.push(box(tw, th, tw, massTop, top.w * 0.22, -top.d * 0.2));
      mid.push(box(tw, th, tw, massTop, top.w * 0.22, -top.d * 0.2));
      spireTop = Math.max(spireTop, massTop + th);
    }
    if (rnd() < K.mastChance) {
      // A mast is nearly free and is the thing that reads at 2 km. ONE height,
      // used by both tiers — drawing it twice from `rnd()` gave L0 and L1
      // different masts and made the tower visibly grow at the LOD boundary.
      const mh = 6 + rnd() * 18;
      full.push(box(0.5, mh, 0.5, massTop));
      mid.push(box(0.5, mh, 0.5, massTop));
      spireTop = Math.max(spireTop, massTop + mh);
      mastTop = massTop + mh;
    }
  }

  // ── Merge ──────────────────────────────────────────────────────────────────
  const l0 = mergeGeometries(full, false);
  const l1 = mergeGeometries(mid, false);
  const l2 = box(w0, massTop, d0, 0);

  if (!l0 || !l1) {
    // See the header — merge failure is silent and returns null.
    throw new Error("[CityKit] mergeGeometries returned null — attribute mismatch");
  }
  for (const g of full) g.dispose();
  for (const g of mid) g.dispose();

  l0.computeBoundingSphere();
  l1.computeBoundingSphere();
  l2.computeBoundingSphere();

  const tris = [l0, l1, l2].map((g) => (g.index ? g.index.count : g.attributes.position.count) / 3);

  return {
    lods: [l0, l1, l2],
    /** Full height including the mast — what the skyline reads. */
    height: spireTop,
    /** Massing height, mast excluded — what L2's box is, and what the facade's
     *  lot texture carries as the building top (crown lights sit under it). */
    massHeight: massTop,
    footprint: Math.max(w0, d0),
    /** Footprint per axis — the signs need the face they hang on. */
    width: w0,
    depth: d0,
    mastTop,
    landmark: forceH != null,
    tris,
  };
}

/**
 * Bake the whole archetype set.
 *
 * @param {object} [opts]
 * @param {number} [opts.seed]
 * @param {object} [opts.params] overrides on KIT_DEFAULTS
 * @returns {{ archetypes: Array, params: object, stats: object }}
 */
export function buildCityKit({ seed = 1337, params = {} } = {}) {
  const K = { ...KIT_DEFAULTS, ...params };
  const rnd = mulberry32(seed);
  const t0 = performance.now();

  const archetypes = [];
  for (let i = 0; i < K.archetypes; i++) archetypes.push(buildArchetype(rnd, K));
  // Landmarks: forced heights above the ceiling. They sort to the END, and the
  // layout keeps them out of the ordinary height pick (see `normalCount`).
  for (let i = 0; i < K.landmarks; i++) {
    archetypes.push(buildArchetype(rnd, K, K.maxHeight * (1.2 + rnd() * (K.landmarkHeight - 1.2))));
  }

  // Sorted by height so the layout can pick "a tall one" / "a short one" by
  // index without re-scanning, which is what gives the downtown falloff its
  // shape rather than a random scatter.
  archetypes.sort((a, b) => a.height - b.height);

  const totalTris = archetypes.reduce((s, a) => s + a.tris[0], 0);
  const stats = {
    count: archetypes.length,
    landmarks: K.landmarks,
    bakeMs: performance.now() - t0,
    trisL0: totalTris,
    avgTrisL0: Math.round(totalTris / archetypes.length),
    avgTrisL1: Math.round(archetypes.reduce((s, a) => s + a.tris[1], 0) / archetypes.length),
    avgTrisL2: Math.round(archetypes.reduce((s, a) => s + a.tris[2], 0) / archetypes.length),
    minHeight: archetypes[0].height,
    maxHeight: archetypes[archetypes.length - 1].height,
  };

  return { archetypes, params: K, stats };
}

/** Free every geometry in a kit. */
export function disposeCityKit(kit) {
  for (const a of kit.archetypes) for (const g of a.lods) g.dispose();
}
