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
  minFootprint: 24,
  maxFootprint: 31,
  /** Height range, metres. The instance Y-scale spreads it further at runtime.
   *  `tall = rnd()²` keeps most of the set mid-rise, so a high ceiling buys a
   *  few real towers downtown rather than a wall — and a sky track at 40 m
   *  wants something to fly BETWEEN. */
  minHeight: 26,
  maxHeight: 190,
  /** Chance a tower steps in as it rises, and how hard.
   *
   *  HEIGHT DECIDES, not a flat roll. MEASURED on the old kit: 13 of 21
   *  archetypes stepped in, which sounds healthy — until you look at WHICH.
   *  The 272 m and 301 m landmarks were pure boxes, and they are the three
   *  buildings whose whole job is to give the skyline a shape you recognise,
   *  seen from a track that flies over the rooftops. A flat 62% roll spends
   *  its setbacks on the mid-rise, where nobody reads a silhouette.
   *
   *  So a low block may well be a box — most real ones are — and anything
   *  approaching `maxHeight` almost always steps, more than once. Costs no
   *  extra tier and no extra draw: a stepped tower is the same stack of boxes
   *  with different widths. */
  setbackChance: 0.42,
  setbackChanceTall: 0.97,
  maxSetbacks: 2,
  maxSetbacksTall: 4,
  setbackDepth: 0.16,
  setbackDepthTall: 0.24,
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

  // ── ROOFS ─────────────────────────────────────────────────────────────────
  //
  // THIS IS A SKY-TRACK GAME. The surface of the city you look at most is not
  // the facades — you see those edge-on at 200 km/h — it is the ROOFS, and
  // every one of them was a bare tinted plate.
  //
  // The cheap half of fixing that lives here: a parapet wall round every
  // exposed deck, baked into the archetype. It costs no draw call at all (it
  // merges into geometry that is already instanced) and it is what turns a
  // flat plate into a roof you are looking INTO rather than at.
  //
  // The per-building clutter — plant, tanks, stacks, dishes — cannot live here,
  // because every instance of an archetype would then carry an identical roof.
  // See modularRoadCityRoofs.js.
  parapet: true,
  /** Metres. Deliberately just over a hand-rail: taller reads as a wall. */
  parapetHeight: 1.0,
  parapetThick: 0.3,
  /**
   * ── THE ROOFLINE, MEASURED AGAINST THREE'S CITY ────────────────────────────
   *
   * Its towers finish: a coping on the parapet, finials at the corners, a
   * stepped crown, a real roof on the top of it. Ours stopped at a box with a
   * box on it, and in a game you look at from above that is the difference
   * you see first. All of it merges into the archetype — no draw, a few dozen
   * triangles — and goes into L1 as well, because a roofline is silhouette
   * and the L0/L1 swap happens where a changing one is plainly visible.
   */
  /** A stone coping capping every parapet: slightly wider than the wall,
   *  which is the one line that makes a parapet read as built. */
  coping: true,
  copingHeight: 0.12,
  copingOverhang: 0.08,
  /** Chance a tower's top parapet carries a stepped pinnacle at each corner. */
  finialChance: 0.35,
  /** The mechanical penthouse steps in once or twice as it rises. */
  crownSteps: true,
  /** Chance the top step wears a hipped roof instead of a flat cap. */
  hipRoofChance: 0.30,
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
  addFaceSize(g, w, h, d);
  return g;
}

/**
 * Stamp each vertex with the EXACT size of the face it belongs to, in metres.
 *
 * The facade shader needs the face's width to lay out its bays. It used to
 * solve that from screen derivatives — the ratio of d(world)/d(uv) across a
 * 2x2 pixel quad. That ratio is a per-face constant in theory, but a finite
 * difference over four pixels carries a fraction of a percent of noise, and
 * the shader feeds it straight into
 *     count = floor((W - pierWidth) / bayWidth)
 * When that quotient happens to sit ON an integer — which it does, because
 * both the footprints and the bay width are ordinary numbers that sometimes
 * divide — the noise flips `count` between neighbouring quads. Every bay
 * boundary on the face then moves, and adjacent pixels resolve to pier or to
 * glass at random: a coloured, dithered band running the wall's full height,
 * on one building and not the identical-looking one beside it.
 *
 * three.js's own city generator never does this. It computes the bay count on
 * the CPU from the authored face length, and passes per-face data to the
 * shader as an attribute, with the note "a per-face id must not interpolate,
 * or equal() below misses on the rounding". This is that fix: an exact number,
 * decided once, where it is actually known.
 *
 * No FLAT interpolation qualifier is needed. Every vertex of a face carries
 * the same pair, and interpolating a constant gives the constant back.
 *
 * Instances are translation plus a Y-scale only (`matrixFor` composes with an
 * identity quaternion and `(1, scaleY, 1)`), so the WIDTH written here is the
 * width in world space no matter where the building is placed. The height is
 * not — it scales — which is why the shader still measures that one itself.
 */
function addFaceSize(g, w, h, d) {
  const n = g.attributes.normal;
  const out = new Float32Array(n.count * 2);
  for (let i = 0; i < n.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    // Which face this vertex sits on, and therefore which two edges bound it.
    let fw, fh;
    if (ax >= ay && ax >= az) { fw = d; fh = h; }        // the ±X walls span depth
    else if (az >= ay) { fw = w; fh = h; }               // the ±Z walls span width
    else { fw = w; fh = d; }                             // roof / underside
    out[i * 2] = fw;
    out[i * 2 + 1] = fh;
  }
  g.setAttribute("aFace", new THREE.BufferAttribute(out, 2));
}

/**
 * Drop a geometry's DOWNWARD faces outright.
 *
 * For things that stand on something — a coping on its parapet, a finial on
 * its coping, a roof on its penthouse. `dropBuriedFaces` only removes an
 * underside that a single upward face completely contains, and a coping
 * oversails the wall it caps, a finial straddles two coping runs, a hip roof
 * has no underside anyone could ever see. Their bottoms would otherwise be
 * opposed coplanar faces, which is a z-fight on the roofline — exactly the
 * class of thing the kit test guards against.
 */
function stripDown(g) {
  const nrm = g.attributes.normal, idx = g.index;
  const keep = [];
  for (let t = 0; t + 2 < idx.count; t += 3) {
    if (nrm.getY(idx.getX(t)) < -0.9) continue;
    keep.push(idx.getX(t), idx.getX(t + 1), idx.getX(t + 2));
  }
  g.setIndex(keep);
  return g;
}

/**
 * A hipped roof over a `w` x `d` deck at height `y`, rising `h` to a ridge
 * along the longer axis (a pyramid when the deck is square). Two trapezoids
 * and two triangles, wound outward from the vertices rather than by hand —
 * the same rule every other piece of this codebase learned to follow.
 *
 * The facade shader reads |n.y| > 0.5 as roof and paints it the roof colour,
 * which a 30° pitch is comfortably inside; `aFace` gets the deck size like
 * any other horizontal face. No underside: it sits on the penthouse.
 */
function hipRoof(w, d, h, y) {
  const hw = w / 2, hd = d / 2;
  const alongX = w >= d;
  const rl = Math.abs(w - d) / 2;
  const r0 = alongX ? [-rl, y + h, 0] : [0, y + h, -rl];
  const r1 = alongX ? [rl, y + h, 0] : [0, y + h, rl];
  const c0 = [-hw, y, -hd], c1 = [hw, y, -hd], c2 = [hw, y, hd], c3 = [-hw, y, hd];
  const polys = alongX
    ? [[c0, c1, r1, r0], [c2, c3, r0, r1], [c3, c0, r0], [c1, c2, r1]]
    : [[c1, c2, r1, r0], [c3, c0, r0, r1], [c0, c1, r0], [c2, c3, r1]];
  const pos = [], nrm = [], uvs = [], face = [], idx = [];
  const centre = [0, y + h * 0.3, 0];
  for (const p of polys) {
    // Face normal from the first three vertices; flip the winding if it looks
    // into the roof instead of out of it.
    const ax = p[1][0] - p[0][0], ay = p[1][1] - p[0][1], az = p[1][2] - p[0][2];
    const bx = p[2][0] - p[0][0], by = p[2][1] - p[0][1], bz = p[2][2] - p[0][2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const mx = p.reduce((s, v) => s + v[0], 0) / p.length - centre[0];
    const my = p.reduce((s, v) => s + v[1], 0) / p.length - centre[1];
    const mz = p.reduce((s, v) => s + v[2], 0) / p.length - centre[2];
    const verts = (nx * mx + ny * my + nz * mz) < 0 ? [...p].reverse() : p;
    if (verts !== p) { nx = -nx; ny = -ny; nz = -nz; }
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(v[0], v[1], v[2]);
      nrm.push(nx, ny, nz);
      uvs.push((v[0] + hw) / w, (v[2] + hd) / d);
      face.push(w, d);
    }
    for (let i = 1; i + 1 < verts.length; i++) idx.push(base, base + i, base + i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("aFace", new THREE.Float32BufferAttribute(face, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Remove horizontal faces that are buried under a coplanar one.
 *
 * A building is a pile of boxes, and a pile of boxes puts surfaces in the same
 * plane for free: every tier's TOP face is exactly where the next tier's BOTTOM
 * face is, and every parapet, penthouse and roof box rests its bottom face on
 * the deck it stands on. Two coplanar faces have equal depth to the bit, so
 * which one the rasteriser keeps is undefined and flips as the camera moves —
 * z-fighting, on the roofline, on every archetype. Measured before this pass:
 * 916 opposed coplanar triangle pairs across all 21 archetypes, 21 of 21
 * affected. three.js's own city generator places its parts specifically "so
 * they never sit coplanar with the walls, spandrels or piers and z-fight".
 *
 * The rule is conservative on purpose: a downward face is dropped only when an
 * upward face in the SAME plane completely contains it. An upward face means
 * solid material immediately below that plane, so anything resting on it is
 * genuinely invisible — this can only remove triangles nobody could see. The
 * upward faces themselves are always kept: a deck under a parapet ring is
 * covered in a thin strip and exposed everywhere else, so it is never
 * contained, and it is the roof you actually look at.
 *
 * Each axis-aligned quad is two triangles that share the quad's diagonal, so a
 * triangle's bounding box IS its quad's bounding box, and containment can be
 * decided per triangle without reassembling faces.
 */
function dropBuriedFaces(g) {
  if (!g || !g.index) return g;
  const pos = g.attributes.position, nrm = g.attributes.normal, idx = g.index;
  const tri = [];
  for (let t = 0; t + 2 < idx.count; t += 3) {
    const v = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    const ny = nrm.getY(v[0]);
    tri.push({
      t, up: ny > 0.9, down: ny < -0.9, y: pos.getY(v[0]),
      minX: Math.min(pos.getX(v[0]), pos.getX(v[1]), pos.getX(v[2])),
      maxX: Math.max(pos.getX(v[0]), pos.getX(v[1]), pos.getX(v[2])),
      minZ: Math.min(pos.getZ(v[0]), pos.getZ(v[1]), pos.getZ(v[2])),
      maxZ: Math.max(pos.getZ(v[0]), pos.getZ(v[1]), pos.getZ(v[2])),
    });
  }
  // Upward faces bucketed by plane, so each downward face only compares against
  // the handful that could possibly be under it.
  const ups = new Map();
  for (const f of tri) {
    if (!f.up) continue;
    const key = f.y.toFixed(4);
    if (!ups.has(key)) ups.set(key, []);
    ups.get(key).push(f);
  }
  const E = 1e-4;
  const keep = [];
  let dropped = 0;
  for (const f of tri) {
    let buried = false;
    if (f.down) {
      for (const u of ups.get(f.y.toFixed(4)) ?? []) {
        if (u.minX <= f.minX + E && u.maxX >= f.maxX - E &&
            u.minZ <= f.minZ + E && u.maxZ >= f.maxZ - E) { buried = true; break; }
      }
    }
    if (buried) { dropped++; continue; }
    keep.push(idx.getX(f.t), idx.getX(f.t + 1), idx.getX(f.t + 2));
  }
  if (dropped === 0) return g;
  g.setIndex(keep);
  return g;
}

/**
 * Generate one archetype at three levels of detail.
 *
 * @param {() => number} rnd seeded RNG
 * @param {object} K kit params
 */
function buildArchetype(rnd, K, forceH = null) {
  // NEARLY FILL THE LOT. The example sizes every footprint at `lot - 1 -
  // rnd()*4` — 83-97% of its lot — so neighbours sit close and the streets
  // read as canyons. Ours were 16-28 m in a 34 m lot (47-82%), which spaced
  // every tower out into its own island of empty ground and is a large part
  // of why the city looked like scattered blocks rather than a city.
  const w0 = K.minFootprint + rnd() * (K.maxFootprint - K.minFootprint);
  // Slabs (a wide, shallow footprint) read very differently from square towers
  // and are what stop a skyline looking like a bundle of pencils.
  const slab = rnd() < 0.3;
  const d0 = slab ? w0 * (0.5 + rnd() * 0.22) : w0 * (0.88 + rnd() * 0.12);

  // Height distribution skewed low — a real skyline is mostly mid-rise with a
  // few towers. A flat distribution gives you a wall, not a skyline.
  const tall = rnd() * rnd();
  const H = forceH ?? (K.minHeight + tall * (K.maxHeight - K.minHeight));

  const podium = H > 60 && rnd() < K.podiumChance;
  /*
   * HOW TALL IS THIS, AS A FRACTION OF THE KIT'S CEILING. The landmarks are
   * forced well ABOVE that ceiling, so this saturates at 1 for them — which is
   * the point: they are the buildings the skyline is read by.
   */
  const tallT = Math.max(0, Math.min(1, (H - K.minHeight) / Math.max(1, K.maxHeight - K.minHeight)));
  const chance = K.setbackChance + (K.setbackChanceTall - K.setbackChance) * tallT;
  const maxSet = K.maxSetbacks + (K.maxSetbacksTall - K.maxSetbacks) * tallT;
  const depth = K.setbackDepth + (K.setbackDepthTall - K.setbackDepth) * tallT;
  const nSet = rnd() < chance ? 1 + Math.floor(rnd() * maxSet) : 0;

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
    w *= 1 - depth * (0.6 + rnd() * 0.8);
    d *= 1 - depth * (0.6 + rnd() * 0.8);
  }

  /*
   * ── THE ROOFLINE ROLLS ITS OWN DICE ─────────────────────────────────────
   *
   * Every `rnd()` call shifts the sequence for every archetype after it. When
   * the coping, finials, crown steps and hip roofs first drew from the main
   * stream, the 21 archetypes came out with different heights and footprints
   * from the ones the city had — four more of them over 42 m, which put hero
   * adverts on 250 buildings instead of a handful and failed the signage
   * tests for a reason that had nothing to do with signage. A roof detail
   * must not move the building under it.
   *
   * So the roofline has a stream of its own, seeded from numbers this
   * archetype has already drawn. Deterministic per seed, and invisible to
   * everything that came before.
   */
  const rnd2 = mulberry32(Math.floor(w0 * 1013 + d0 * 7919 + H * 104729) >>> 0);

  const full = [];
  const mid = [];

  for (const t of tiers) {
    const g = box(t.w, t.h, t.d, t.y);
    full.push(g);
    mid.push(g.clone());
  }

  /**
   * A parapet wall round a deck of `w` x `d` at height `y`.
   *
   * Four boxes. The facade shader needs no special case for them: it measures
   * a face's height from the screen derivatives and treats anything under
   * 2.5 m as flat, so a 1 m parapet gets the stone paint and no window relief,
   * which is exactly right. Its top face reads |n.y| > 0.5 and takes the roof
   * colour, same as the deck it stands on.
   */
  const parapetRing = (w, d, y) => {
    if (!K.parapet) return [];
    const h = K.parapetHeight, t = K.parapetThick;
    if (w <= t * 3 || d <= t * 3) return [];      // too small to read as a wall
    return [
      box(w, h, t, y, 0, (d - t) / 2),
      box(w, h, t, y, 0, -(d - t) / 2),
      box(t, h, d - t * 2, y, (w - t) / 2, 0),
      box(t, h, d - t * 2, y, -(w - t) / 2, 0),
    ];
  };

  // EVERY exposed deck, not just the top one. A setback tower is a stack of
  // roofs, and from above each ledge reads as one — leaving them bare is what
  // made a wedding-cake tower look like a solid extrusion from the air.
  /**
   * The coping on that wall: a thin stone cap oversailing it by `overhang` on
   * both sides. Four mitred runs, undersides stripped (they stand on the wall
   * and oversail it, so `dropBuriedFaces` could never prove them buried).
   * Into L1 too, or the two tiers' rooflines would differ by 12 cm and the
   * finials standing on it would jump at the LOD swap.
   */
  const copingRing = (w, d, y) => {
    if (!K.parapet || !K.coping) return [];
    const pt = K.parapetThick, o = K.copingOverhang, h = K.copingHeight, t = pt + o * 2;
    if (w <= pt * 3 || d <= pt * 3) return [];
    const cy = y + K.parapetHeight;
    return [
      box(w + o * 2, h, t, cy, 0, (d - pt) / 2),
      box(w + o * 2, h, t, cy, 0, -(d - pt) / 2),
      box(t, h, d - pt * 2 - o * 2, cy, (w - pt) / 2, 0),
      box(t, h, d - pt * 2 - o * 2, cy, -(w - pt) / 2, 0),
    ].map(stripDown);
  };

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    // The deck exposed at this tier's TOP: the tier above sits in the middle
    // of it, so the ring goes round this tier's own footprint.
    const ringY = t.y + t.h;
    for (const g of parapetRing(t.w, t.d, ringY)) {
      full.push(g);
      mid.push(g.clone());
    }
    for (const g of copingRing(t.w, t.d, ringY)) {
      full.push(g);
      mid.push(g.clone());
    }
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
  /** The mechanical penthouse's footprint, so roof clutter can keep out of it. */
  let crownFootW = 0, crownFootD = 0;

  /*
   * ── FINIALS ────────────────────────────────────────────────────────────────
   * A stepped pinnacle at each corner of the top parapet, standing on the
   * coping. Two boxes, the upper one narrower; undersides stripped. Pure
   * silhouette, so L1 carries them too.
   */
  const capTop = K.parapet ? topY + K.parapetHeight + (K.coping ? K.copingHeight : 0) : topY;
  if (K.parapet && rnd2() < K.finialChance && Math.min(top.w, top.d) > 8) {
    const fw = 0.7, fh = 1.4, fw2 = 0.36, fh2 = 1.1;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const fx = sx * (top.w - fw) / 2, fz = sz * (top.d - fw) / 2;
        for (const list of [full, mid]) {
          list.push(stripDown(box(fw, fh, fw, capTop, fx, fz)));
          list.push(stripDown(box(fw2, fh2, fw2, capTop + fh, fx, fz)));
        }
      }
    }
    spireTop = Math.max(spireTop, capTop + fh + fh2);
  }

  if (rnd() < K.crownChance) {
    /*
     * THE CROWN STEPS IN. One box was a mechanical penthouse; two or three,
     * each narrower, is a crown — the top of a tower drawn by someone who
     * meant it. The keep-out the roof clutter respects is the FIRST step, the
     * widest; the tank and the roof sit on the last.
     */
    let cw = top.w * (0.4 + rnd() * 0.28);
    let cd = top.d * (0.4 + rnd() * 0.28);
    crownFootW = cw; crownFootD = cd;
    const steps = K.crownSteps ? 1 + Math.floor(rnd2() * 3) : 1;
    let cy = topY;
    for (let st = 0; st < steps; st++) {
      // The first step's height is the old penthouse roll, on the main stream.
      const ch = st === 0 ? 2.5 + rnd() * 5.5 : 1.8 + rnd2() * 2.5;
      full.push(box(cw, ch, cd, cy));
      mid.push(box(cw, ch, cd, cy));
      cy += ch;
      if (st < steps - 1) {
        cw *= 0.62 + rnd2() * 0.2;
        cd *= 0.62 + rnd2() * 0.2;
      }
    }
    massTop = cy;
    spireTop = massTop;

    /*
     * A HIPPED ROOF on some of them, instead of a flat cap: the one shape that
     * says "roof" from any distance, and the example's towers have real roofs
     * where ours had lids. It takes the tank's place — nothing stands on a
     * pitched roof — and the mast, if any, rises from its ridge.
     */
    const hip = rnd2() < K.hipRoofChance && Math.min(cw, cd) > 4;
    const hipH = hip ? Math.min(cw, cd) * 0.3 : 0;
    if (hip) {
      full.push(hipRoof(cw, cd, hipH, massTop));
      mid.push(hipRoof(cw, cd, hipH, massTop));
      spireTop = Math.max(spireTop, massTop + hipH);
    }

    const tankRoll = rnd();
    if (!hip && tankRoll < 0.5) {
      // Water tank, offset — asymmetry on the roofline is worth 2 triangles.
      //
      // Its offset is a fraction of the TIER's width, but it stands on the
      // mechanical penthouse, which is only 40-68% of that. So the tank could
      // hang over the penthouse edge: a sliver of it floating unsupported, and
      // its underside left coplanar with the roof it mostly sits on, which
      // z-fights. Fit it to the roof it is actually standing on — shrink it if
      // the penthouse is small, then keep the offset inside what is left. The
      // asymmetry survives wherever there is room for it.
      const th = 2.5 + rnd() * 2;
      const tw = Math.min(2 + rnd() * 2, Math.min(cw, cd) * 0.6);
      const fit = (v, span) => {
        const room = Math.max(0, (span - tw) / 2);
        return Math.max(-room, Math.min(room, v));
      };
      const tx = fit(top.w * 0.22, cw), tz = fit(-top.d * 0.2, cd);
      full.push(box(tw, th, tw, massTop, tx, tz));
      mid.push(box(tw, th, tw, massTop, tx, tz));
      spireTop = Math.max(spireTop, massTop + th);
    }
    if (rnd() < K.mastChance) {
      // A mast is nearly free and is the thing that reads at 2 km. ONE height,
      // used by both tiers — drawing it twice from `rnd()` gave L0 and L1
      // different masts and made the tower visibly grow at the LOD boundary.
      // From the ridge when there is a roof; undersides stripped, it stands
      // on something either way.
      const mh = 6 + rnd() * 18;
      const mastBase = massTop + hipH;
      full.push(stripDown(box(0.5, mh, 0.5, mastBase)));
      mid.push(stripDown(box(0.5, mh, 0.5, mastBase)));
      spireTop = Math.max(spireTop, mastBase + mh);
      mastTop = mastBase + mh;
    }
  }

  // ── Merge ──────────────────────────────────────────────────────────────────
  const l0 = dropBuriedFaces(mergeGeometries(full, false));
  const l1 = dropBuriedFaces(mergeGeometries(mid, false));
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
    /**
     * THE TIER STACK, in archetype-local space — `y` and `h` local (multiply by
     * a placed building's `scaleY`), `w`/`d` in world metres already, because X
     * and Z are never scaled.
     *
     * Exposed because anything mounted on a WALL has to know which wall is
     * actually there at that height. A setback tower is narrower higher up, so
     * a sign placed against the base footprint at fifty metres is bolted to
     * thin air — which is exactly what the city's hero adverts were doing.
     */
    tiers: tiers.map((t) => ({ y: t.y, h: t.h, w: t.w, d: t.d })),
    /**
     * THE TOP DECK, in archetype-local space — where the roof clutter goes.
     *
     * `y` is local, so a placed building's roof is at `b.y + roof.y * b.scaleY`
     * (X and Z are never scaled; see CITY_DEFAULTS). `crownW`/`crownD` are the
     * mechanical penthouse's footprint, 0 when there is none — clutter has to
     * keep out of it or it grows through the box.
     */
    roof: {
      y: topY,
      w: top.w,
      d: top.d,
      crownW: crownFootW,
      crownD: crownFootD,
      inset: K.parapetThick + 0.6,
    },
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
