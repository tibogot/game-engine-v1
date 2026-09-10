// ── THE UNDERPASS ────────────────────────────────────────────────────────────
//
// A road that dips below the city, runs under two or three cross streets, and
// comes back up. The streets above it carry on at grade, unaware.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
//
// It is not the track kit's `Road tunnel` piece, which already exists and is
// excellent — vaulted concrete, wall LEDs, the lot — and which the player can
// place on their own track today. That is a tunnel you BUILD. This is a tunnel
// the CITY HAS, cut into the ground it is already standing on.
//
// ── THREE OF THE FOUR PIECES ALREADY EXISTED ─────────────────────────────────
//
// The road is `computeFrames` + `buildSweepGeometry`, exactly as the viaduct
// is, and the swept mesh IS its own collision surface. The vault is
// `buildVaultTunnel`, which sweeps along arbitrary frames and hands back a
// shell, a decimated collision proxy and the LED glow. Both materials are
// already built and compiled in the game, because the track's tunnel piece
// uses them — so the whole interior costs no new pipeline.
//
// The fourth piece is the only new idea here, and it is a hole in the ground.
//
// ── THE HOLE ─────────────────────────────────────────────────────────────────
//
// The city's street is TWO TRIANGLES at y = 0 with everything else done in the
// shader, and `streetHeightAt` is a flat `groundY`. Both have to stop being
// true inside the trench, in two completely different ways:
//
//   · VISUALLY the street plane draws straight over the hole, so the street
//     shader discards inside the trench rectangles. That is the one new
//     per-pixel cost in this feature, and it is a couple of rectangle tests on
//     a plane that is mostly off-screen anyway.
//   · PHYSICALLY `streetHeightAt` returns NaN there, which is a mechanism it
//     ALREADY HAS — it returns NaN outside the city and with terrain on, and
//     everything downstream reads NaN as "no ground here". Without it the car
//     drives across the hole on the street it is supposed to be under.
//
// AND THE COVERED SECTION NEEDS NO HOLE AT ALL, which is the nice part: the
// street plane IS the tunnel's lid. Only the open trench at each end is cut.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
//
// Four draws: road, vault shell, its LED glow, and the trench walls. Materials
// shared with the track throughout, so no compile.

import * as THREE from "three";
import { Fn, uniform, vec3, mix, smoothstep, float, positionWorld, vertexColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  computeFrames, buildSweepGeometry, buildProfile, buildVaultTunnel, vaultProfiles,
  roadParams, pieceParams,
} from "./modularRoadKit.js";
import { createPortalSigns } from "./modularRoadCityPortalSign.js";
import { concreteDetail } from "./modularRoadCityViaduct.js";

export const UNDERPASS_DEFAULTS = {
  /** Off and nothing is built. */
  underpass: true,
  /** Which street it runs along. Defaulted across the viaduct's axis so the
   *  two structures cross rather than fight over the same street. */
  underpassAxis: "z",
  /** Which street, in block pitches off centre. */
  underpassOffset: 0,

  /**
   * ── THE DEPTH, AND WHY IT IS THIS NUMBER ───────────────────────────────────
   *
   * Three things stack up and there is very little slack in them.
   *
   * The vault's crown stands `tunnelHeight` above the road with about 0.45 m of
   * shell on it, so the road has to be at least that far down or the tunnel's
   * back breaks through the street it runs under — which from above does not
   * read as a bug, it reads as a concrete kerb nobody ordered.
   *
   * And the ramp has to reach that depth INSIDE ONE BLOCK. See `blockSpan`
   * below: that is 136 m to lose the whole depth in, which at a tolerable
   * gradient is about six and a half metres. Deeper is not better here; deeper
   * is a ramp that does not fit and a hole across somebody's street.
   */
  depth: 6.5,
  tunnelHeight: 5.6,

  /**
   * ── THE ROOF STARTS AT THE FIRST JUNCTION ──────────────────────────────────
   *
   * `coverBlocks` is how many block pitches the roofed part spans, and it is
   * counted in BLOCKS rather than metres for the reason the whole structure is
   * laid out on the grid: an underpass that ends wherever a length ran out puts
   * its open trench across a cross street, and a cross street with a hole in it
   * is a road the player drives along and falls into.
   */
  coverBlocks: 3,
  /**
   * The open descent. Must be no longer than a block — checked, not assumed —
   * and set very close to it, because the block is the only budget there is and
   * every metre left unused comes back as gradient.
   */
  rampLength: 134,
  /**
   * Fraction of the ramp still level before it starts down.
   *
   * Small, and it is not the crest smoothing — `ease` is a smoothstep and
   * already leaves the top and bottom flat. This is only breathing room at the
   * mouth, and it is expensive: it shortens the run the descent actually has,
   * and at a fixed depth that is a steeper road. At 0.10 this came out at 8.6%.
   */
  rampHold: 0.04,

  /** Road width down there. Narrower than the street above it. */
  roadWidth: 15,
  /** Station spacing. Tight through the portals, where the eye is. */
  step: 10,

  /**
   * ── THE TRENCH WALL'S INNER FACE ───────────────────────────────────────────
   *
   * 0.34, and it is not a taste value: it is exactly where the VAULT puts its
   * own wall. `_vaultInnerProfile` springs from `hw + 0.34`, so matching it
   * means the open trench's wall and the tunnel's wall are one continuous
   * surface through the portal instead of two surfaces a centimetre apart.
   *
   * A centimetre apart is worse than it sounds. Two solids in almost the same
   * place give the chassis two conflicting pushes in one frame, and the car is
   * thrown into the air — which is exactly what this did before the walls were
   * confined to the open trench.
   */
  wallGap: 0.34,
  wallThick: 0.5,
  /**
   * ── THE PARAPET ROUND THE HOLE ─────────────────────────────────────────────
   *
   * The trench is 18 m of missing street in a 34 m road, so there is still
   * street either side of it — and nothing stopping a car that drifts across
   * from dropping six and a half metres into a road it cannot see. A real one
   * has a wall; so does this. It is part of the wall mesh, which is already in
   * the solids channel, so it costs no draw and no new collision.
   */
  lipWidth: 0.7,
  parapetHeight: 0.95,

  /**
   * ── THE VAULT'S SHELL IS SOLID ─────────────────────────────────────────────
   *
   * True, and it stays true: without it the tunnel wall is a curtain you drive
   * through into the earth.
   *
   * It was switched off for an afternoon while the entry launch was being
   * hunted, because switching it off made the launch smaller — 41 m/s of
   * vertical became 12. That was real and it was also a red herring: the
   * heightfield was lifting the car up INTO the vault, so removing the vault
   * removed the second half of a collision the first half had already caused.
   * Chasing the bigger number would have cost the tunnel its walls and fixed
   * nothing. The cause was `streetHeightAt` — see `coveredRect`.
   */
  vaultCollides: true,

  colorWall: 0x8d8c85,
  colorWallDirt: 0x46443f,
};

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * ── WHERE THE UNDERPASS IS ───────────────────────────────────────────────────
 *
 * PURE. The geometry, the collision, the hole in the street plane and the
 * height function all need the same answer, and four systems only agree about a
 * structure if they ask one function rather than each deriving it.
 */
export function underpassLayout({ P, originCellX = 0, originCellZ = 0, params = {} }) {
  const U = { ...UNDERPASS_DEFAULTS, ...params };
  if (!U.underpass) return null;

  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const streetW = Math.max(P.streetLots * P.lotSize, 1);
  const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
  const half = P.extent;
  const axis = U.underpassAxis === "x" ? "x" : "z";

  const oAcross = axis === "x" ? oz : ox;
  const cAcross = axis === "x" ? P.centerZ : P.centerX;
  const cAlong = axis === "x" ? P.centerX : P.centerZ;
  const k = Math.round((cAcross - oAcross - blockW - streetW / 2) / pitch) + U.underpassOffset;
  const across = oAcross + k * pitch + blockW + streetW / 2;
  if (Math.abs(across - cAcross) > half) return null;

  const roadY = P.groundY - U.depth;
  const oAlong = axis === "x" ? ox : oz;

  /*
   * ── SNAPPED TO THE BLOCK GRID ──────────────────────────────────────────────
   *
   * A cell is a block then a junction: [j·pitch, j·pitch + blockW) is the
   * block, and the rest is where two streets cross. The roof therefore has to
   * start at the END of a block and end at the START of one, so that every
   * junction in between is under it — and the open trench, which is the part
   * with no roof, falls entirely inside the block before it.
   *
   * The first version measured the whole thing in metres from the centre and a
   * 135 m trench starting mid-block reached straight across the next junction.
   * The hole was correct, the geometry was correct, and driving along that
   * cross street dropped the car seven metres into a road it could not see.
   */
  const jMid = Math.round((cAlong - oAlong - blockW / 2) / pitch);
  const nCov = Math.max(1, Math.round(U.coverBlocks));
  const j0 = jMid - Math.floor(nCov / 2);
  const j1 = j0 + nCov;
  const portalIn = oAlong + j0 * pitch + blockW;
  const portalOut = oAlong + j1 * pitch;
  /*
   * ── AND THE MOUTH DOES NOT OPEN ON A ZEBRA ─────────────────────────────────
   *
   * The block-grid snapping above keeps the TRENCH clear of the junctions. It
   * says nothing about the crossings, which are painted in the first and last
   * `crossInset` metres of every block — and a ramp of exactly `rampLength`
   * put this mouth 2.0 m into its block and the far one 134 of 136, so both
   * opened in the middle of a pedestrian crossing and cut the bars in half.
   *
   * So each mouth is nudged to the nearest edge of the safe band inside its
   * own block. It shortens the ramp by a few metres rather than moving it a
   * whole cell, which is the smallest change that gets the paint out of the
   * way — the gradient absorbs it without anyone noticing.
   */
  const CROSS_CLEAR = (P.streetParams?.crossInset ?? 5.0) + 1.5;
  /** Nudge `a` clear of the crossings in the block it sits in, moving `dir`. */
  const clearOfCrossing = (a, dir) => {
    const rel = a - oAlong;
    const cell = Math.floor(rel / pitch);
    const into = rel - cell * pitch;
    if (into >= CROSS_CLEAR && into <= blockW - CROSS_CLEAR) return a;
    // Inside a crossing (or in the junction): pull toward the block's middle,
    // which always shortens the ramp rather than lengthening it into a junction.
    const want = into < blockW / 2 ? CROSS_CLEAR : blockW - CROSS_CLEAR;
    void dir;
    return oAlong + cell * pitch + want;
  };
  const a0 = clearOfCrossing(portalIn - U.rampLength, 1);
  const a1 = clearOfCrossing(portalOut + U.rampLength, -1);
  /** What the ramp actually turned out to be, after that nudge. */
  const rampIn = portalIn - a0;
  const rampOut = a1 - portalOut;
  // The ramp has to fit in the block it descends through, or the hole reaches
  // the junction again and we are back where we started.
  if (U.rampLength > blockW) return null;
  if (rampIn <= 1 || rampOut <= 1) return null;
  if (a0 < cAlong - half || a1 > cAlong + half) return null;

  /*
   * THE CENTRELINE. Down, along, and back up. The 2 cm at each end is the same
   * lip the viaduct's slip roads land on: a road ending exactly coplanar with
   * the street plane is a z-fight across the whole mouth, and 2 cm is far below
   * anything the suspension notices.
   */
  const top = P.groundY + 0.02;
  const path = [];
  const at = (a, y) => (axis === "x" ? new THREE.Vector3(a, y, across)
    : new THREE.Vector3(across, y, a));
  const depthAt = (a) => {
    // 0 at both mouths, 1 by the portal and all the way between them. The two
    // ramps are measured SEPARATELY because the crossing nudge can shorten one
    // and not the other; using a single nominal length made the shorter ramp
    // reach full depth before its portal.
    const dIn = (a - a0) / rampIn;
    const dOut = (a1 - a) / rampOut;
    const t = Math.min(dIn, dOut);
    if (t >= 1) return 1;
    return ease((t - U.rampHold) / (1 - U.rampHold));
  };
  /*
   * STATIONS, AND TWO OF THEM ARE NOT NEGOTIABLE.
   *
   * A sweep can only start or stop AT a station, and the roof has to start
   * exactly at the portal. Left to an even spacing it does not: the nearest
   * station to `cov0` was six metres inside it, so there was a six-metre
   * stretch of trench with no roof AND no wall — and because the street plane
   * above is single-sided, standing in the tunnel you looked up through it at
   * the sky.
   *
   * So the portals are stations by construction, and the rest fill in around
   * them.
   */
  /*
   * WHERE THE ROOF IS: from the end of one block to the start of another, so
   * the portals stand at the two junctions and every crossing between them is
   * roofed. It is also exactly where the road reaches full depth, which is not
   * a coincidence — the ramp length was chosen to fit the block.
   */
  const cov0 = portalIn;
  const cov1 = portalOut;

  const total = a1 - a0;
  const n = Math.max(8, Math.round(total / U.step));
  const stations = new Set([a0, a1, cov0, cov1]);
  for (let i = 0; i <= n; i++) stations.add(a0 + ((a1 - a0) * i) / n);
  for (const a of [...stations].sort((p1, p2) => p1 - p2)) {
    path.push(at(a, top - (top - roadY) * depthAt(a)));
  }

  /*
   * ── THE HOLE ───────────────────────────────────────────────────────────────
   *
   * Two rectangles, one per open trench, in world XZ. Deliberately NOT one
   * rectangle over the whole run: the covered middle needs no hole because the
   * street plane is the tunnel's lid, and cutting it there would open a slot
   * down the middle of a street that is supposed to be intact.
   *
   * They start where the road has actually dropped below the plane. Cutting
   * from the very first station would leave a hole around a road still at
   * street level, which reads as the street simply missing.
   */
  const holeHalf = U.roadWidth / 2 + U.wallGap + U.wallThick + U.lipWidth;

  /*
   * ── THE MOUTH HAS NO STEP ──────────────────────────────────────────────────
   *
   * The hole used to begin only once the road was 0.35 m down, which left the
   * street plane lying on top of the first twenty-odd metres of ramp. Driving
   * IN that is a 35 cm drop; driving OUT it is a 35 cm wall, and at speed the
   * car climbs it and is thrown. It is the "thin piece of road going straight
   * while the ramp goes down" — the street, still there, over the ramp.
   *
   * So the hole starts at the mouth, where the road IS the street to within
   * two centimetres. It cannot start at full width, though: the trench is
   * wider than the road, and at the mouth there are no walls yet to fill the
   * difference — that would be an open slot beside the road. So it starts road
   * wide and widens once the walls have height to stand in it, which is also
   * what a real cut looks like from above.
   */
  const roadHalf = U.roadWidth / 2;
  const wallFrom = 0.30;               // the depth at which a wall is worth building
  const depthAtA = (a) => top - (top - roadY) * depthAt(a);
  let wIn = a0, wOut = a1;
  for (const q of path) {
    const a = axis === "x" ? q.x : q.z;
    if (top - q.y > wallFrom) { wIn = a; break; }
  }
  for (let i = path.length - 1; i >= 0; i--) {
    const q = path[i];
    const a = axis === "x" ? q.x : q.z;
    if (top - q.y > wallFrom) { wOut = a; break; }
  }
  void depthAtA;
  const rect = (lo, hi, h) => (axis === "x"
    ? { minX: lo, maxX: hi, minZ: across - h, maxZ: across + h }
    : { minX: across - h, maxX: across + h, minZ: lo, maxZ: hi });
  /*
   * ── THE MOUTH TUCKS UNDER THE ROAD ─────────────────────────────────────────
   *
   * The hole used to start exactly at `a0`, where the road also starts, so the
   * street's cut edge and the road's end edge met precisely — two boundaries on
   * the same line, and the rasteriser drops a pixel row between them. It showed
   * as a hairline of daylight straight across the mouth.
   *
   * The road's first station is 2 cm PROUD of the street (the same lip the
   * viaduct's slip roads land on), so a few centimetres of street left in place
   * under it is hidden by the road itself. Only along the axis: insetting the
   * SIDES would pull the street's edge inboard of the riser that covers the
   * step, and trade this seam for a worse one.
   */
  const MOUTH_TUCK = 0.3;
  const openRects = [
    rect(a0 + MOUTH_TUCK, wIn, roadHalf), rect(wIn, cov0, holeHalf),
    rect(cov1, wOut, holeHalf), rect(wOut, a1 - MOUTH_TUCK, roadHalf),
  ];

  /*
   * ── THE COVERED RECT, WHICH IS NOT A HOLE AND NOT SOLID EITHER ─────────────
   *
   * Between the portals the street is intact — you drive over it — but there is
   * no ground under it for six and a half metres, and that is a distinction the
   * city's height function structurally cannot make. `streetHeightAt` is a
   * height FUNCTION: it answers "the surface here is at y" with no notion of
   * above or below, so inside the tunnel it kept insisting the surface was at
   * street level and the wheels obediently tried to climb to it. MEASURED: the
   * car reached the portal at 12 m/s and left it at +12 m/s VERTICAL.
   *
   * So this rect is where the heightfield must shut up, and the lid below is
   * what gives the street back to the traffic driving over the top. A mesh can
   * do what a height function cannot, because a mesh has a direction: a ray
   * cast downward from inside the tunnel starts BELOW the lid and misses it
   * entirely, which is exactly the answer we need and exactly the answer the
   * analytic surface has no way to give.
   */
  const coveredRect = rect(cov0, cov1, holeHalf);

  return {
    axis, across, roadY, top, a0, a1, cov0, cov1, path, openRects, holeHalf,
    /*
     * Where the hole stops being road-wide and widens to the wall line. Between
     * the mouth and here the street is cut at the ROAD's edge, and the step
     * down to the descending road needs a face on it — see the riser.
     */
    wIn, wOut,
    coveredRect, blockSpan: blockW, params: U,
  };
}

/**
 * Is (x, z) over open trench? Used by the street's height function, which has
 * to answer "no ground here" there — see the header.
 */
export function underpassOpenAt(layout) {
  if (!layout) return null;
  const r = layout.openRects;
  return (x, z) => {
    for (let i = 0; i < r.length; i++) {
      const q = r[i];
      if (x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ) return true;
    }
    return false;
  };
}

/**
 * Is (x, z) over the ROOFED section? The street is real up there and the height
 * function must still not claim it — see `coveredRect`. Paired with the lid
 * mesh, which is the surface that actually holds the traffic up.
 */
export function underpassRoofAt(layout) {
  if (!layout) return null;
  const q = layout.coveredRect;
  return (x, z) => x >= q.minX && x <= q.maxX && z >= q.minZ && z <= q.maxZ;
}

/**
 * ── THE ROAD'S HEIGHT, AS A FUNCTION OF HOW FAR ALONG YOU ARE ────────────────
 *
 * For the city's traffic, which drives this street too.
 *
 * The traffic model's lane is a straight line across the whole city with one
 * constant height, and it knew nothing about any of this: the two inner lanes
 * of the street the tunnel replaces drove straight over the open trench, six
 * metres up, on a road that is not there. They were being HIDDEN over the hole,
 * which was honest about being a compromise and looked like one — cars winking
 * out at the portal and back in at the far end.
 *
 * A lane can already carry its own height (that is how the viaduct's traffic
 * works), so all this has to hand over is the profile. Outside the run it
 * answers street level, so a lane can call it along its entire length without
 * knowing where the tunnel starts.
 */
export function underpassDip(layout) {
  if (!layout) return null;
  const { axis, across, top, a0, a1, path, params: U } = layout;
  // The path is already sorted along the axis and is straight in XZ — only y
  // changes — so this is a plain 1-D lookup, not a polyline walk.
  const as = path.map((q) => (axis === "x" ? q.x : q.z));
  const ys = path.map((q) => q.y);
  const yAt = (a) => {
    if (a <= a0 || a >= a1) return top;
    let lo = 0, hi = as.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (as[m] <= a) lo = m; else hi = m; }
    const seg = as[hi] - as[lo] || 1e-6;
    return ys[lo] + (ys[hi] - ys[lo]) * ((a - as[lo]) / seg);
  };
  return { axis, across, half: U.roadWidth / 2, a0, a1, top, yAt };
}

/** The whole run's footprint, for keeping buildings and furniture off it. */
export function underpassFootprint(layout, pad = 0) {
  if (!layout) return null;
  const h = layout.holeHalf + pad;
  const lo = Math.min(layout.a0, layout.a1), hi = Math.max(layout.a0, layout.a1);
  const axis = layout.axis;
  return (x, z) => {
    const along = axis === "x" ? x : z;
    const acr = axis === "x" ? z : x;
    return along >= lo && along <= hi && Math.abs(acr - layout.across) <= h;
  };
}

/** Concrete for the trench walls — the same faked pour the viaduct's piers use. */
function wallMaterial(U) {
  const detail = concreteDetail(U);
  /*
   * ── vertexColors STAYS OFF, AND THE CONCRETE IS GREY BECAUSE OF IT ─────────
   *
   * The `color` attribute here is not a colour. It is a shading SCALAR packed
   * into the red channel — `(shade, 0, 0)` — which `colorNode` reads back as
   * `vertexColor().rgb.r`. That is a fine way to carry one number per vertex,
   * right up until the material also declares `vertexColors: true`: three then
   * multiplies the whole diffuse colour by that attribute as if it were a
   * colour, green and blue are multiplied by ZERO, and every retaining wall in
   * the underpass renders bright red. `colorWall` is 0x8d8c85 — grey.
   *
   * `vertexColor()` reads the attribute directly and does not need the flag,
   * so turning it off changes nothing except stopping the second, unwanted
   * multiply.
   */
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: false, roughness: 0.9, metalness: 0.0 });
  m.name = "CityUnderpassWall";
  const base = uniform(new THREE.Color(U.colorWall));
  const dirt = uniform(new THREE.Color(U.colorWallDirt));
  const uTop = uniform(0);
  m.colorNode = Fn(() => {
    /*
     * A TRENCH WALL STAINS FROM THE BOTTOM, which is the opposite of a pier.
     * A pier is streaked by rain running off the deck above it; a retaining
     * wall stands in the water that collects at its foot, so the dark is at the
     * road and it fades upward.
     */
    const up = positionWorld.y.sub(uTop).toVar();
    const damp = smoothstep(float(2.6), float(0.0), up).mul(0.34);
    const cast = base.mul(vertexColor().rgb.r.mul(0.2).add(0.8)).mul(detail());
    return mix(cast, dirt, damp);
  })();
  return { material: m, uTop };
}

/**
 * Build the underpass.
 *
 * @param {object} opts
 * @param {ReturnType<typeof underpassLayout>} opts.layout
 * @param {THREE.Material} [opts.roadMaterial]   the game's road surface
 * @param {THREE.Material} [opts.vaultMaterial]  the track tunnel's shell
 * @param {THREE.Material} [opts.glowMaterial]   its LED battens
 */
export function createCityUnderpass({
  layout, roadMaterial = null, vaultMaterial = null, glowMaterial = null,
  castShadows = false, uNight = null,
}) {
  if (!layout) return null;
  const U = layout.params;
  const group = new THREE.Group();
  group.name = "CityUnderpass";
  const owned = [];
  const fallback = (name, opts) => {
    const m = new THREE.MeshStandardNodeMaterial(opts);
    m.name = name;
    owned.push(m);
    return m;
  };

  const rp = { ...roadParams, width: U.roadWidth };
  const profile = buildProfile(rp, true);
  const frames = computeFrames(layout.path);

  /*
   * ── NO KERBS WHERE IT IS STILL A STREET ────────────────────────────────────
   *
   * The road is swept with the game's kerbed section, which is right for the
   * six metres of it that are in a trench and wrong for the first and last
   * twenty, where it is at grade and simply IS the street. A pair of red and
   * white kerbs running across an ordinary road is the give-away.
   *
   * Same two mechanisms as the viaduct's gore, and they are still not the same
   * mechanism: the SHAPE comes from `profileAt` and can change per station, so
   * the kerb ramps down; the PAINT comes from the reference profile's zone and
   * cannot, so the red has to end at a segment boundary. Hence two sweeps.
   */
  const kerbLerp = (pd, k, repaint) => ({
    hw: pd.hw,
    pts: pd.pts.map((q) => (q.zone === 2
      ? { ...q, y: q.y * k, zone: repaint ? 1 : q.zone } : q)),
  });
  const flat = kerbLerp(profile, 0, true);
  /*
   * Where the kerb starts, measured as the ROAD's depth below the street.
   *
   * Deeper than it looks like it needs to be, because a kerb stands
   * `railHeight` ABOVE the road it is on — start them at 0.6 m down and their
   * tops are still only 0.4 m below the street, which is close enough to grade
   * to read as kerbs across an ordinary road. The first thirty metres of the
   * ramp having none is also just correct: it is still a street there.
   */
  const kerbFrom = 1.2;
  const alongOfFrame = (i) => (layout.axis === "x" ? frames[i].pos.x : frames[i].pos.z);
  let kIn = 0, kOut = frames.length - 1;
  for (let i = 0; i < frames.length; i++) {
    if (layout.top - frames[i].pos.y > kerbFrom) { kIn = i; break; }
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    if (layout.top - frames[i].pos.y > kerbFrom) { kOut = i; break; }
  }
  const taper = 3;
  const roadParts = [];
  if (kIn >= 2) {
    roadParts.push(buildSweepGeometry(frames.slice(0, kIn + 1), flat, {
      profileAt: (t, i) => kerbLerp(profile,
        Math.min(1, Math.max(0, (i - (kIn - taper)) / taper)), true),
    }));
  }
  roadParts.push(buildSweepGeometry(frames.slice(kIn, kOut + 1), profile));
  if (kOut <= frames.length - 3) {
    const tail = frames.slice(kOut);
    const n2 = tail.length - 1;
    roadParts.push(buildSweepGeometry(tail, flat, {
      profileAt: (t, i) => kerbLerp(profile, 1 - Math.min(1, i / taper), true),
    }));
    void n2;
  }
  const roadGeo = roadParts.length === 1 ? roadParts[0] : mergeGeometries(roadParts, false);
  if (roadParts.length > 1) for (const g of roadParts) g.dispose();
  {
    // The road material reads per-PIECE constants the sweep does not write —
    // see the same note in the viaduct. Without them the whole underpass reads
    // zero and its surface grain lines up with every other run that also has
    // none.
    const c = roadGeo.getAttribute("position").count;
    const d = new Float32Array(c * 2);
    const h = Math.abs(Math.sin(layout.a0 * 12.9898 + layout.across * 78.233) * 43758.5453);
    for (let i = 0; i < c; i++) { d[i * 2] = (h - Math.floor(h)) * 100; d[i * 2 + 1] = -1e4; }
    roadGeo.setAttribute("aPiece", new THREE.Float32BufferAttribute(d, 2));
  }
  const road = new THREE.Mesh(roadGeo,
    roadMaterial || fallback("UnderpassRoadFallback", { color: 0x3b3b3e, roughness: 0.92 }));
  road.name = "CityUnderpassRoad";
  road.receiveShadow = true;
  road.castShadow = false;
  road.frustumCulled = false;
  group.add(road);

  /*
   * ── THE VAULT ──────────────────────────────────────────────────────────────
   *
   * Swept along the covered stations only. `buildVaultTunnel` hands back the
   * shell, a DECIMATED collision proxy and the LED glow as three separate
   * geometries — the proxy matters here for the same reason the guardrail's
   * does: the thing the chassis is sampled against should not be the thing with
   * the ribs and the portal bevels on it.
   */
  const alongOf = (i) => (layout.axis === "x" ? frames[i].pos.x : frames[i].pos.z);
  const covFrames = frames.filter((_, i) => alongOf(i) >= layout.cov0 - 1e-6
    && alongOf(i) <= layout.cov1 + 1e-6);
  let vault = null, glow = null, vaultCollider = null;
  if (covFrames.length > 2) {
    /*
     * NO PORTAL REVEAL. The headwall IS the portal face here, and the reveal's
     * set-back bore would leave a ring of nothing behind it that you can see
     * the sky through from inside — see `portalReveal` in the kit.
     */
    const pp = { ...pieceParams, tunnelHeight: U.tunnelHeight, portalReveal: 0 };
    const built = buildVaultTunnel(covFrames, profile, pp);
    if (built?.shell) {
      vault = new THREE.Mesh(built.shell,
        vaultMaterial || fallback("UnderpassVaultFallback", { color: 0x6f6f6b, roughness: 0.95 }));
      vault.name = "CityUnderpassVault";
      vault.receiveShadow = true;
      vault.castShadow = castShadows;
      vault.frustumCulled = false;
      group.add(vault);
    }
    if (built?.glow) {
      glow = new THREE.Mesh(built.glow,
        glowMaterial || fallback("UnderpassGlowFallback", { color: 0xfff0d0 }));
      glow.name = "CityUnderpassGlow";
      glow.frustumCulled = false;
      group.add(glow);
    }
    if (built?.collision) {
      // Never drawn, only collided with — the same arrangement the viaduct's
      // guardrail proxy uses.
      vaultCollider = new THREE.Mesh(built.collision, road.material);
      vaultCollider.name = "CityUnderpassVaultCollision";
      vaultCollider.visible = false;
      vaultCollider.updateMatrixWorld();
    }
  }

  /*
   * ── THE TRENCH WALLS ───────────────────────────────────────────────────────
   *
   * Built by hand rather than with the kit's `channel`, and the reason is one
   * line of that function: its wall height is `channelRadius`, a constant. A
   * trench's wall height IS its depth, which is the whole point of a trench and
   * changes at every station. So this sweeps a wall from the road edge up to
   * street level, per station, which costs about thirty lines and is correct.
   *
   * A box rather than a sheet, because the chassis is SAMPLED against triangles
   * and a single-sided plane is something a fast car can find its way through.
   */
  const { material: wallMat, uTop } = wallMaterial(U);
  owned.push(wallMat);
  uTop.value = layout.roadY;
  let walls = null;
  {
    const inner = U.roadWidth / 2 + U.wallGap;
    const outer = inner + U.wallThick;
    const lip = outer + U.lipWidth;
    const pos = [], col = [], idx = [], rowAlong = [];
    const push = (p, shade) => {
      pos.push(p.x, p.y, p.z);
      col.push(shade, 0, 0);
      return pos.length / 3 - 1;
    };
    const quad = (a, b, c, d) => { idx.push(a, b, c, a, c, d); };
    /**
     * The same quad, wound so its face points the way you asked for.
     *
     * Winding has been the bug three times in this file now — the trench wall
     * backfacing, the portal headwall invisible from the trench — and every
     * time it was someone reasoning about `right x up` and getting it wrong.
     * The vertices already know the answer, so ask them.
     */
    const quadFacing = (a, b, c, d, wx, wy, wz) => {
      const ux = pos[b * 3] - pos[a * 3];
      const uy = pos[b * 3 + 1] - pos[a * 3 + 1];
      const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3];
      const vy = pos[c * 3 + 1] - pos[a * 3 + 1];
      const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * wx + ny * wy + nz * wz >= 0) quad(a, b, c, d);
      else quad(a, d, c, b);
    };
    const V = new THREE.Vector3();
    const atFrame = (i, lat, y) => {
      const f = frames[i];
      return V.copy(f.pos).addScaledVector(f.right, lat).setY(y);
    };
    /*
     * FIVE POINTS PER SIDE, bottom to outside:
     *   0 inner foot, at the road
     *   1 inner top of the parapet   ← the face a car meets
     *   2 outer top of the parapet
     *   3 outer, back down at street level
     *   4 the lip edge, flush with the street
     *
     * The parapet only exists where the trench is OPEN. Over the covered
     * section there is no hole to fall into and a wall down the middle of an
     * intact street would be a barrier across a road with nothing wrong with it.
     */
    const alongAt = (i) => (layout.axis === "x" ? frames[i].pos.x : frames[i].pos.z);
    const isOpen = (i) => {
      const a = alongAt(i);
      return a < layout.cov0 + 1e-6 || a > layout.cov1 - 1e-6;
    };
    /*
     * ── ONLY WHERE THE TRENCH IS OPEN ──────────────────────────────────────────
     *
     * Under the roof the VAULT is the wall, and building a second one there was
     * wrong in three separate ways at once:
     *
     *   · its inner face landed a centimetre from the vault's, so the chassis
     *     got two conflicting pushes in a frame and the car was thrown;
     *   · its lip ran at street level along a section that still HAS a street,
     *     so two coplanar surfaces fought over the same pixels — the strip of
     *     "floating road" over the tunnel;
     *   · and it was several hundred metres of geometry doing nothing that the
     *     tunnel around it was not already doing.
     *
     * The range is inclusive at both portals so the trench wall and the vault
     * meet rather than leaving a gap you can see daylight through.
     */
    /*
     * ── THE BARRIER STARTS WHERE THE RAMP DOES ─────────────────────────────────
     *
     * It used to start at 30 cm of depth, which is where the HOLE widens to the
     * wall line — a sensible-looking rule that left the first thirty metres of
     * descending ramp with nothing beside it at all. There is a drop there the
     * moment the road starts going down, so that is where the barrier belongs.
     *
     * What genuinely cannot start early is the LIP: it lies flush with the
     * street, and for that first stretch the street is still there (the hole is
     * only as wide as the road), so a lip would be two coplanar surfaces
     * fighting over the same pixels — the "floating road" bug again. So the lip
     * collapses onto the wall's outer face until the hole widens to meet it,
     * and only then opens out. Degenerate quads have no area and cost nothing.
     */
    for (let i = 0; i < frames.length; i++) {
      const y = frames[i].pos.y;
      /*
       * FROM THE VERY FIRST STATION. There used to be a 2 cm threshold here —
       * "no drop yet, nothing to fall off" — and it left a sliver at the mouth
       * where the road has begun to curve away but the barrier has not started,
       * with nothing on the step between them. The barrier simply begins where
       * the ramp does; where the drop is nil the section is degenerate and
       * costs nothing, and a metre later it is a real wall.
       */
      if (!isOpen(i)) continue;
      const a = alongAt(i);
      const wide = a > layout.wIn - 1e-6 && a < layout.wOut + 1e-6;
      const lipHere = wide ? lip : outer;
      const capY = layout.top + U.parapetHeight;
      /*
       * ── THE FOOT GOES UNDER BOTH SURFACES ──────────────────────────────────
       *
       * It used to sit at `y`, the ROAD's height at this station — which is
       * where the wall meets the road down in the trench, and wrong at the
       * mouth. Out there the wall stands on the STREET, laterally clear of the
       * road; and for the first few metres the road is up to 2 cm PROUD of the
       * street (the mouth lip). So the wall's foot was placed 2 cm above the
       * ground it stands on, and it floated: a hairline of daylight under the
       * whole barrier, exactly as reported.
       *
       * A quarter metre below the lower of the two costs four triangles' worth
       * of buried wall and cannot leave a gap however the ramp is regraded. The
       * road and the gutter hide it from inside the trench.
       */
      const footY = Math.min(y, layout.top) - 0.25;
      rowAlong.push(a);
      for (const s of [-1, 1]) {
        push(atFrame(i, s * inner, footY), 1.0);    // 0 inner foot
        push(atFrame(i, s * inner, capY), 1.0);     // 1 inner top
        push(atFrame(i, s * outer, capY), 0.9);     // 2 outer top
        push(atFrame(i, s * outer, layout.top), 0.9); // 3 outer at street
        push(atFrame(i, s * lipHere, layout.top), 0.8); // 4 lip edge
      }
    }
    /*
     * Stitch consecutive stations. FIVE verts per side per station, laid out
     * side -1 then side +1, so the stride is ten.
     *
     * `rowAlong` is what stops the two ends being sewn together. Stations are
     * skipped — at grade, and under the roof — so consecutive ROWS are not
     * always consecutive frames, and joining a row at the entry trench to one
     * at the exit trench would sweep a wall the length of the tunnel through
     * everything between them.
     */
    const per = 10;
    const rows = pos.length / 3 / per;
    /*
     * ── AND ITS ENDS ARE CLOSED ────────────────────────────────────────────────
     *
     * The wall is a swept RIBBON — five points per side, stitched station to
     * station — so where a run begins or ends the cross-section is an open
     * edge, and a ribbon seen end-on is a surface with nothing behind it. You
     * could look straight into the parapet and out the far side of the world.
     *
     * `runEnds` finds them properly rather than assuming there are two: rows
     * are skipped at grade and under the roof, so the mesh holds several
     * separate runs and each one has two ends of its own.
     */
    const runEnds = [];
    for (let r = 0; r < rows; r++) {
      const prev = r > 0 && Math.abs(rowAlong[r] - rowAlong[r - 1]) <= U.step * 2.5;
      const next = r + 1 < rows && Math.abs(rowAlong[r + 1] - rowAlong[r]) <= U.step * 2.5;
      if (!prev) runEnds.push([r, -1]);
      if (!next) runEnds.push([r, 1]);
    }
    for (const [r, dir] of runEnds) {
      for (let s = 0; s < 2; s++) {
        const o = r * per + s * 5;
        // The five points close back to the foot, so the cap is the wall's
        // actual section: fan it from there.
        const want = [dir * (layout.axis === "x" ? 1 : 0), 0, dir * (layout.axis === "x" ? 0 : 1)];
        quadFacing(o + 0, o + 1, o + 2, o + 3, want[0], want[1], want[2]);
        quadFacing(o + 0, o + 3, o + 4, o + 0, want[0], want[1], want[2]);
      }
    }
    for (let r = 0; r + 1 < rows; r++) {
      const gap = Math.abs(rowAlong[r + 1] - rowAlong[r]);
      if (gap > U.step * 2.5) continue;
      for (let s = 0; s < 2; s++) {
        const o0 = r * per + s * 5, o1 = (r + 1) * per + s * 5;
        // The two sides face opposite ways, so their winding is mirrored — a
        // trench wall backfacing is a trench you can see straight through.
        for (let k = 0; k < 4; k++) {
          if (s === 0) quad(o0 + k + 1, o0 + k, o1 + k, o1 + k + 1);
          else quad(o0 + k, o0 + k + 1, o1 + k + 1, o1 + k);
        }
      }
    }
    /*
     * ── THE PORTAL HEADWALL: A ROUND BORE THROUGH A SQUARE BLOCK ─────────────
     *
     * The vault is a SHELL — a curved surface, not a solid. Above its crown,
     * between the arch and the street half a metre over it, there was no
     * geometry at all, and the street plane up there is single-sided. So from
     * the open trench you looked OVER the top of the arch, through the earth,
     * and out at the far side of the city; from the ramp the same void showed
     * you the sky.
     *
     * Filling that void with a solid would be the wrong shape of fix — nobody
     * can ever get inside it, so it is hundreds of metres of triangles that
     * exist to be invisible. The void is only EXPOSED where the tunnel is cut
     * open, which is its two ends. So each end gets a flat wall with the arch
     * cut out of it: the cheapest way to close the hole, and exactly what a
     * real underpass is — a round bore through a square concrete block.
     *
     * It is written into the trench wall's OWN arrays rather than made into a
     * mesh of its own, which buys two things for nothing: it is the same
     * material so it costs no extra draw, and the trench wall is already in
     * the SOLIDS channel, so the headwall stops a car like the wall it is.
     *
     * The outline is the vault's own outer profile, taken from the kit instead
     * of re-derived here — a hole computed twice is a hole that drifts away
     * from the thing it has to fit. The rectangle around it runs wall to wall
     * and from under the road up to street level, so it also caps the open
     * ends the trench walls leave behind when they stop at the portal.
     *
     * Between the two, a fan: each arch point is pushed straight out from the
     * centre of the bore until it lands on the rectangle, and consecutive
     * pairs make a quad. Radial projection preserves the order around the
     * boundary, so the ring closes without a triangulator.
     */
    if (covFrames.length > 2) {
      const { inner, outer } = vaultProfiles(profile, { ...pieceParams, tunnelHeight: U.tunnelHeight });
      /*
       * ── THE HOLE IS THE BORE, NOT THE OUTSIDE OF THE SHELL ─────────────────
       *
       * `inner`, and the difference is 78 cm of open ring round the mouth.
       *
       * Cutting the shell's OUTER outline out of the wall leaves the whole
       * thickness of the vault uncovered at the portal, and that ring is a way
       * in: a sight line entering it near the crown passes through the outer
       * shell from the inside — which is a BACK face, so it is not drawn and
       * does not stop anything — into the void above the tunnel, and out
       * through the single-sided street plane to the sky. MEASURED in the
       * running game: rays crossing the portal plane at y = -0.27, above the
       * bore's ceiling at -0.90 and below the shell's crown at -0.12, still
       * reached the sky.
       *
       * So the wall closes everything except the hole you actually drive
       * through. The vault's own mouth bevel ends up behind it and is no
       * longer the thing holding that ring shut, which is the point — a
       * reveal is a decoration, and this has to be a wall.
       */
      const hole = inner;
      const yTop = layout.top - layout.roadY;
      let yBot = 0, aLo = Infinity, aHi = -Infinity, aWide = 0;
      for (const q of hole) {
        yBot = Math.min(yBot, q.y);
        aLo = Math.min(aLo, q.y);
        aHi = Math.max(aHi, q.y);
      }
      // The block still has to CONTAIN the shell, which is wider than the bore
      // — and the trench it plugs, which is wider than both.
      for (const q of outer) aWide = Math.max(aWide, Math.abs(q.x));
      aWide = Math.max(aWide, layout.holeHalf);
      yBot -= 0.15;
      /*
       * THE BLOCK HAS TO BE WIDER THAN THE BORE, and the trench wall is not.
       *
       * The obvious width is the trench wall's outer face — but the vault's
       * SHELL is thick, and its outside (8.62 m) reaches past that wall
       * (8.34 m). Sized to the wall, the ring inverted around the springing:
       * the arch was already outside the rectangle there, the projection had
       * nowhere to push it, and the quads collapsed — leaving a 4.3 m tall
       * slot down each side of the portal, which is precisely the gap you
       * could see the city through. So the rectangle is sized off the arch it
       * has to contain, never off the wall beside it.
       */
      const W = Math.max(profile.hw + U.wallGap + U.wallThick, aWide + 0.5);
      void outer;
      // The point to push out FROM. The middle of the bore's own height, on
      // the centreline: inside the arch for any profile this can produce.
      const cy = (aLo + aHi) / 2;
      const toRect = (q) => {
        const dx = q.x, dy = q.y - cy;
        let t = Infinity;
        if (Math.abs(dx) > 1e-9) t = Math.min(t, (dx > 0 ? W : -W) / dx);
        if (Math.abs(dy) > 1e-9) t = Math.min(t, ((dy > 0 ? yTop : yBot) - cy) / dy);
        if (!Number.isFinite(t) || t < 1) t = 1;   // already outside: leave it
        return { x: dx * t, y: cy + dy * t };
      };
      /*
       * ── AND THE RING HAS TO GO ROUND THE CORNERS ────────────────────────────
       *
       * Projecting each arch point outward and joining consecutive pairs makes
       * a strip whose outer edge is a straight CHORD between the two landing
       * points. Wherever those two land on different sides of the rectangle,
       * that chord cuts the corner off, and the triangle it cuts away is a
       * hole. MEASURED: 9 of 261 probes at the top corners still saw straight
       * through a portal that was otherwise closed.
       *
       * So the corner is inserted where it belongs. Every point — arch and
       * corner alike — has an angle about the centre of the bore, the arch's
       * angles decrease monotonically along the profile, and a corner is put
       * into whichever gap its own angle falls in. Each span then fans from
       * the arch point through however many corners it swept past.
       */
      const angOf = (x, y) => Math.atan2(y - cy, x);
      const th = hole.map((q) => angOf(q.x, q.y));
      // Unwrapped, because atan2 comes back in (-PI, PI] and this outline
      // starts below the left skirt and ends below the right one — it crosses
      // the branch cut, and an angle that jumps by 2PI is not comparable.
      for (let k = 1; k < th.length; k++) {
        while (th[k] > th[k - 1]) th[k] -= Math.PI * 2;
      }
      const corners = [
        { x: W, y: yTop }, { x: -W, y: yTop }, { x: -W, y: yBot }, { x: W, y: yBot },
      ].map((q) => ({ q, a: angOf(q.x, q.y) }));
      /** The corners swept between two arch angles, in the order they occur. */
      const between = (hi, lo) => {
        const got = [];
        for (const c of corners) {
          for (const k of [-2, -1, 0, 1, 2]) {
            const a = c.a + k * Math.PI * 2;
            if (a < hi - 1e-9 && a > lo + 1e-9) got.push({ a, q: c.q });
          }
        }
        return got.sort((p1, p2) => p2.a - p1.a).map((e) => e.q);
      };

      const _hv = new THREE.Vector3();
      const capAt = (fr, outward) => {
        const put = (q) => {
          const at = pos.length / 3;
          _hv.copy(fr.pos).addScaledVector(fr.right, q.x).addScaledVector(fr.up, q.y);
          pos.push(_hv.x, _hv.y, _hv.z);
          col.push(1, 1, 1);
          return at;
        };
        /*
         * WINDING FROM THE FRAME, NOT FROM A GUESS. The two ends face opposite
         * ways, so one of them has to be wound backwards — and a headwall
         * wound the wrong way is invisible from precisely the side you stand
         * on to look at it, which is the same trap the trench walls hit.
         */
        const tri = (a, b, c) => {
          if (outward > 0) idx.push(a, c, b);
          else idx.push(a, b, c);
        };
        let pA = put(hole[0]), qA = put(toRect(hole[0]));
        for (let k = 0; k + 1 < hole.length; k++) {
          const pB = put(hole[k + 1]), qB = put(toRect(hole[k + 1]));
          let prev = qA;
          for (const c of between(th[k], th[k + 1])) {
            const ci = put(c);
            tri(pA, prev, ci);
            prev = ci;
          }
          tri(pA, prev, qB);
          tri(pA, qB, pB);
          pA = pB; qA = qB;
        }
      };
      /*
       * WHICH WAY EACH CAP FACES, and it was backwards.
       *
       * A back face is not drawn, so a headwall wound the wrong way is
       * invisible from precisely the side you stand on to look at it — and
       * the first version of this test could not tell, because it only asked
       * whether the ray hit ANYTHING: the vault three tenths of a metre
       * further on caught every ray and the wall was never missed. Measured
       * from a fixed eye in the trench: nearest hit 12.314 m for a portal at
       * 12.000 m, on `CityUnderpassVault`.
       */
      capAt(covFrames[0], 1);
      capAt(covFrames[covFrames.length - 1], -1);
    }

    /*
     * ── THE RISER AT THE MOUTH: A STEP IS NOT A SURFACE ────────────────────────
     *
     * From the mouth to `wIn` the street is cut at the ROAD's edge (7.50 m),
     * because there is no wall yet to fill anything wider. Meanwhile the road
     * is already going down. So the street's cut edge and the road below it are
     * separated by a step — nought to thirty centimetres over about thirty
     * metres — and NOTHING was on the vertical face of that step.
     *
     * A step with no face is a hole. The street plane is single-sided, so from
     * a low camera on the ramp you looked in through the slot, under the
     * street, and straight out at the world beyond: the two bright wedges down
     * either side of the ramp, widening exactly as the road drops away.
     *
     * Found by painting the sky magenta and looking, which is worth writing
     * down: the ground here is the terrain CLIPMAP, a displaced grid whose hole
     * is cut in the shader, so raycasting the scene says "closed" for a surface
     * that is not drawn. Geometry probes cannot see this class of bug at all.
     */
    {
      const half = U.roadWidth / 2;
      const rRow = [], rAlong = [];
      for (let i = 0; i < frames.length; i++) {
        const y = frames[i].pos.y;
        const a = alongAt(i);
        // Only where the hole is still road-wide: past `wIn` the wall and its
        // lip cover the step, and doubling up there would fight them.
        if (a > layout.wIn + 1e-6 && a < layout.wOut - 1e-6) continue;
        // No threshold, for the same reason the wall has none: the sliver of
        // step right at the mouth is exactly where a threshold leaves a hole.
        rAlong.push(a);
        const row = [];
        for (const s2 of [-1, 1]) {
          row.push(push(atFrame(i, s2 * half, y), 0.5));
          row.push(push(atFrame(i, s2 * half, layout.top), 0.65));
        }
        rRow.push(row);
      }
      for (let r = 0; r + 1 < rRow.length; r++) {
        if (Math.abs(rAlong[r + 1] - rAlong[r]) > U.step * 2.5) continue;
        const a = rRow[r], b = rRow[r + 1];
        const f = frames[0];
        // Facing IN, toward the road, which is the only side anyone stands on.
        for (const [s2, i0, i1] of [[-1, 0, 1], [1, 2, 3]]) {
          quadFacing(a[i0], a[i1], b[i1], b[i0],
            f.right.x * -s2, 0, f.right.z * -s2);
        }
      }
    }

    /*
     * ── THE GUTTER, WHICH IS THE 34 cm NOBODY OWNED ────────────────────────────
     *
     * The road is swept `roadWidth` wide, so its edge is at 7.50 m. The wall's
     * inner face is at `roadWidth / 2 + wallGap` = 7.84, because that is where
     * the VAULT springs from and the two have to be one surface through the
     * portal. Which left a 34 cm slot between the road and the wall, running
     * the whole length of the trench with nothing under it — you looked down
     * it and out at the sky, which is what "at the kerbs it's open" was.
     *
     * Neither side was wrong to be where it is, so the fix is not to move
     * either: it is to floor the gap. A real cut has exactly this — a drainage
     * channel at the foot of the retaining wall — so it costs two triangles a
     * station a side and looks like something rather than like a patch.
     *
     * Built over the WHOLE run rather than only the open part, because the
     * same 34 cm exists under the roof; there the vault's skirt hides it from
     * most angles, which is not the same as closing it.
     */
    {
      const gRow = [];
      const gAlong = [];
      const gFrame = [];
      for (let i = 0; i < frames.length; i++) {
        const y = frames[i].pos.y;
        if (layout.top - y < 0.30) continue;   // at grade the street IS the floor
        gAlong.push(alongAt(i));
        gFrame.push(i);
        const row = [];
        for (const s of [-1, 1]) {
          row.push(push(atFrame(i, s * (U.roadWidth / 2), y), 0.55));
          row.push(push(atFrame(i, s * inner, y), 0.7));
        }
        gRow.push(row);
      }
      /*
       * ── AND A FACE ON THE STEP WHERE THE GUTTER BEGINS ─────────────────────
       *
       * The hole in the street widens from the road's edge to the wall line at
       * exactly this station. On the mouth side of it the street covers that
       * 34 cm strip; on the tunnel side the gutter does, thirty centimetres
       * lower. Between the two is a transverse step, and a step with no face is
       * a hole — twelve pixels of it, which is what was left of "you can see
       * the sky at the kerbs" after the long wedges were closed.
       *
       * MEASURED by counting magenta pixels against a magenta sky and
       * unprojecting them: both specks crossed street level at across +/-7.83,
       * along -135.8, which is the wall line at the station where it starts.
       */
      for (const [r, dir] of [[0, -1], [gRow.length - 1, 1]]) {
        if (r < 0 || !gRow[r]) continue;
        const i = gFrame[r], f = frames[i], y = f.pos.y;
        if (layout.top - y < 0.02) continue;
        for (const s of [-1, 1]) {
          const a0i = push(atFrame(i, s * (U.roadWidth / 2), y), 0.5);
          const a1i = push(atFrame(i, s * inner, y), 0.5);
          const b1i = push(atFrame(i, s * inner, layout.top), 0.65);
          const b0i = push(atFrame(i, s * (U.roadWidth / 2), layout.top), 0.65);
          quadFacing(a0i, a1i, b1i, b0i,
            f.tangent.x * dir, f.tangent.y * dir, f.tangent.z * dir);
        }
      }
      for (let r = 0; r + 1 < gRow.length; r++) {
        if (Math.abs(gAlong[r + 1] - gAlong[r]) > U.step * 2.5) continue;
        const a = gRow[r], b = gRow[r + 1];
        // Up, on both sides. The winding mirrors between them, which is the
        // trap the trench walls fell into twice — so it is DERIVED here rather
        // than written out, and cannot be got backwards.
        quadFacing(a[0], a[1], b[1], b[0], 0, 1, 0);
        quadFacing(a[2], a[3], b[3], b[2], 0, 1, 0);
      }
    }

    /*
     * ── AND A WALL ACROSS THE MOUTH ────────────────────────────────────────────
     *
     * The parapet runs down both sides of the trench and then simply stopped
     * at the portal, so the street above the tunnel ended at a bare edge over
     * a six-metre drop. Nothing real is built like that: the wall turns the
     * corner and runs across the top of the arch.
     *
     * It is a barrier in the honest sense too — the trench wall is in the
     * SOLIDS channel, so this stops a car on the street from driving off the
     * end of the hole, which until now only the two side walls did.
     */
    /*
      * The sign is which way the ROOF is from that portal: into the tunnel, so
      * the wall stands on solid roof rather than hanging over the trench it is
      * there to fence off. Entry looks forward, exit looks back.
      */
    for (const [fr, sgn] of [[covFrames[0], 1], [covFrames[covFrames.length - 1], -1]]) {
      if (!fr) continue;
      const y0 = layout.top, y1 = layout.top + U.parapetHeight;
      const d0 = 0, d1 = U.wallThick;
      const box = [];
      // Eight corners: two depths into the roofed side, two heights, two ends.
      for (const d of [d0, d1]) {
        for (const yy of [y0, y1]) {
          for (const lat of [-lip, lip]) {
            const f = fr;
            const v = new THREE.Vector3().copy(f.pos)
              .addScaledVector(f.right, lat)
              .addScaledVector(f.tangent, sgn * d)
              .setY(yy);
            box.push(push(v, 0.9));
          }
        }
      }
      // d0: 0=(y0,-) 1=(y0,+) 2=(y1,-) 3=(y1,+)   d1: 4..7 likewise
      const faces = [
        [0, 2, 3, 1],   // over the trench
        [4, 6, 7, 5],   // over the street
        [2, 6, 7, 3],   // the top
        [0, 1, 5, 4],   // the underside
        [1, 3, 7, 5],   // one end
        [0, 2, 6, 4],   // the other
      ];
      // Each face is wound to point AWAY from the middle of the box, worked
      // out from the vertices rather than reasoned about: `right`, `up` and
      // `tangent` do not have a handedness I am willing to assume, and a face
      // wound inwards is a hole you can only see from one particular angle.
      let cx = 0, cy = 0, cz = 0;
      for (const bi of box) { cx += pos[bi * 3]; cy += pos[bi * 3 + 1]; cz += pos[bi * 3 + 2]; }
      cx /= box.length; cy /= box.length; cz /= box.length;
      for (const f of faces) {
        const i0 = box[f[0]] * 3, i1 = box[f[1]] * 3, i2 = box[f[2]] * 3, i3 = box[f[3]] * 3;
        const mx = (pos[i0] + pos[i1] + pos[i2] + pos[i3]) / 4 - cx;
        const my = (pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1] + pos[i3 + 1]) / 4 - cy;
        const mz = (pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2] + pos[i3 + 2]) / 4 - cz;
        quadFacing(box[f[0]], box[f[1]], box[f[2]], box[f[3]], mx, my, mz);
      }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      /*
       * ── FLAT NORMALS, BECAUSE THIS IS A CONCRETE BOX ───────────────────────
       *
       * `computeVertexNormals` on an INDEXED mesh averages every face that
       * shares a vertex. Every corner here is a true 90-degree edge — the
       * parapet's top, the lip, the gutter, the end caps — so averaging bent
       * the normal round each of them and smeared the lighting across faces
       * that are physically at right angles. On the end cap it showed as a soft
       * cross of highlight where four averaged corners met, which is what
       * "check the normals" was pointing at.
       *
       * Splitting to non-indexed first gives one normal per FACE, which is the
       * truth for a prismatic solid: every surface in this mesh is flat. It
       * triples the vertex count of a mesh with about a thousand triangles in
       * it, which is nothing, and it is the only way to get a hard edge out of
       * a shared-vertex mesh.
       *
       * The VAULT is deliberately not treated this way — it is a swept arch and
       * wants its normals averaged, which is why it looks round.
       */
      const flat = g.toNonIndexed();
      g.dispose();
      flat.computeVertexNormals();
      walls = new THREE.Mesh(flat, wallMat);
      walls.name = "CityUnderpassWalls";
      walls.receiveShadow = true;
      walls.castShadow = false;
      walls.frustumCulled = false;
      group.add(walls);
    }
  }

  /*
   * ── THE LID: TWO TRIANGLES OF STREET THAT NOBODY CAN SEE ───────────────────
   *
   * Invisible, in the DECK channel only, lying at street level across the
   * roofed section. It exists because the heightfield had to be switched off
   * there (see `coveredRect`) and something still has to hold up whatever is
   * driving over the tunnel.
   *
   * Invisible because the street plane is already drawn there — this is
   * collision, not scenery. Deck-only because a solid would be a wall the
   * chassis fights inside the tunnel; the deck channel is probed by a downward
   * wheel ray, and a wheel ray fired from six metres under it never reaches it.
   * That asymmetry IS the fix.
   */
  let lid = null;
  {
    const q = layout.coveredRect;
    const y = layout.top;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute([
      q.minX, y, q.minZ, q.maxX, y, q.minZ, q.maxX, y, q.maxZ, q.minX, y, q.maxZ,
    ], 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);   // wound up, so the drivable face is the top
    g.computeVertexNormals();
    lid = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    lid.name = "CityUnderpassLid";
    lid.visible = false;
    lid.frustumCulled = false;
    group.add(lid);
  }

  /*
   * ── THE BOARD OVER THE MOUTH ───────────────────────────────────────────────
   *
   * The blue direction band on the headwall. It lives in its own module because
   * it is signage rather than structure, and because the headwall's proportions
   * decide its shape — see the note there on why a gantry panel cannot go here.
   */
  const signs = createPortalSigns({ layout, uNight, params: U.signParams });
  if (signs) group.add(signs.mesh);

  const tri = (m) => (m ? (m.geometry.index ? m.geometry.index.count / 3
    : m.geometry.attributes.position.count / 3) : 0);

  return {
    group,
    layout,
    /** `{deck, solids}` — the shape the game's collision bake collects. */
    collisionMeshes() {
      const solids = [];
      if (vaultCollider && U.vaultCollides) solids.push(vaultCollider);
      if (walls) solids.push(walls);
      return { deck: lid ? [road, lid] : [road], solids };
    },
    stats: {
      draws: 1 + (vault ? 1 : 0) + (glow ? 1 : 0) + (walls ? 1 : 0) + (signs ? 1 : 0),
      lengthM: Math.round(layout.a1 - layout.a0),
      coveredM: Math.round(layout.cov1 - layout.cov0),
      depthM: +(layout.top - layout.roadY).toFixed(1),
      roadTris: tri(road),
      vaultTris: tri(vault),
      wallTris: tri(walls),
    },
    dispose() {
      roadGeo.dispose();
      if (vault) vault.geometry.dispose();
      if (glow) glow.geometry.dispose();
      if (vaultCollider) vaultCollider.geometry.dispose();
      if (walls) walls.geometry.dispose();
      signs?.dispose();
      for (const m of owned) m.dispose();
    },
  };
}
