// ── THE ELEVATED URBAN MOTORWAY ──────────────────────────────────────────────
//
// A road on stilts running the whole width of the city. You drive under it, you
// drive ON it, and there is traffic on it either way.
//
// ── WHY THIS ONE, OUT OF EVERYTHING LEFT ─────────────────────────────────────
//
// Every other thing in the city sits ON the ground plane. Facades, signals,
// signs, markings, traffic, clutter — all of it is street level, and a city
// where nothing is ever overhead reads flat however much detail goes into the
// walls. A viaduct is the only structure that puts something between the player
// and the sky at street level.
//
// ── IT IS A ROAD, BUILT BY THE ROAD KIT ──────────────────────────────────────
//
// The first version was a box. This one is a SWEPT ROAD: a centreline path
// through `computeFrames`, then `buildSweepGeometry` with the game's own road
// profile, exactly as a track piece is built. That is not tidiness, it buys
// four things at once and none of them are optional for a road you drive on:
//
//   · IT IS DRIVABLE. `buildPiece` uses the swept geometry as its own deck
//     collider (modularRoadKit.js), so the mesh IS the collision surface. The
//     precedent is the dock — a non-track static mesh the car drives on, added
//     to the deck list in one line — and, in v3, stuntCarMode baking Smart
//     Road's elevated decks into the very same Vehicle.
//   · IT LOOKS LIKE THE GAME'S ROADS, because it is one. Kerbs, deck lines,
//     the asphalt shader, the wet model — all of it, by sharing the material.
//   · IT SHARES THE TRACK'S PIPELINE. The road material is already compiled by
//     the time the city builds, so a 2.4 km motorway adds no shader compile at
//     all — which matters more here than anywhere, see the note in
//     modularRoadCityFacade.js about what the first frame costs.
//   · THE PATH CAN BEND. The frames come from arbitrary points carrying their
//     own `y`, so curves, grades and ramps are DATA rather than new code. The
//     straight run below is the simplest possible path, not the only one.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
//
// Three draws: deck, guardrail, piers. The piers are one InstancedMesh — column
// and hammerhead merged into a single unit — so their count is free. The
// traffic on it costs nothing extra at all: see the lane note in
// modularRoadCityFurniture.js.
//
// ── THE ONE HEIGHT CONSTRAINT, AND IT IS LOAD-BEARING ────────────────────────
//
// Skybridges cross between towers of at least `bridgeMinHeight` (45 m) at a
// fraction of the shorter one starting at `bridgeLow` (0.35). So the lowest
// skybridge in any city this can generate is at 15.75 m, and as long as the TOP
// OF THE GUARDRAIL stays below that, a skybridge can never intersect the
// viaduct — with no coupling between the two modules, no exclusion test, and no
// ordering constraint on which is built first. viaductTest checks the
// arithmetic still holds, because the alternative is a glazed link through a
// road that nobody notices until they drive under it.

import * as THREE from "three";
import { Fn, float, vec3, uniform, mix, smoothstep, positionWorld, vertexColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  computeFrames, buildSweepGeometry, buildProfile, roadParams,
} from "./modularRoadKit.js";
import { buildRailGeometry, buildRailCollision, railParams } from "./modularRoadRail.js";

export const VIADUCT_DEFAULTS = {
  /** Off and nothing is built. */
  viaduct: true,
  /** Which way it runs. The cross streets pass underneath it. */
  viaductAxis: "x",
  /** How many block pitches off the city centre, so it does not sit on top of
   *  whatever is in the middle. Signed. */
  viaductOffset: 2,

  /** The deck. Four lanes, shoulders, and room for the guardrails. */
  deckWidth: 19,
  deckThickness: 1.2,
  /**
   * Underside of the slab above the street.
   *
   * Tall enough to drive under without it feeling like a hazard, and low enough
   * that the guardrail top stays under the lowest possible skybridge — see the
   * header.
   */
  clearance: 10.4,
  /**
   * Distance between centreline stations on a straight, metres.
   *
   * A straight needs almost none — two points would sweep correctly — but this
   * is also the deck's triangle budget and the resolution its collision BVH is
   * built from, so it is a real knob rather than a formality. Curves get their
   * own density from the points that describe them.
   */
  straightStep: 24,

  /** Pier spacing along the run. */
  spanLength: 34,
  pierWidth: 2.6,
  pierDepth: 2.2,
  /** The hammerhead that carries the deck. */
  capWidth: 11.0,
  capHeight: 1.15,
  capDepth: 3.2,
  /** Piers taper: the fraction of the full section left at the top. */
  pierTaper: 0.78,
  /**
   * GUARDRAIL POST SPACING, metres. Wider than the track's 3.6.
   *
   * MEASURED over the full 2.4 km run: the beam itself is 15.3k triangles and
   * the posts are everything else — 87.5k at 3.6 m, 52.5k at 7. Instancing them
   * was the obvious move and it is the wrong one: the same posts still rasterise,
   * so it saves memory and no frame time at all. Spacing them saves both, and a
   * motorway barrier genuinely has fewer posts than a race circuit's.
   */
  railPostSpacing: 7,

  /**
   * ── SLIP ROADS ─────────────────────────────────────────────────────────────
   *
   * Without them the motorway is scenery you can only reach by falling onto it.
   *
   * One per direction, each diverging to ITS OWN RIGHT — which puts them on
   * opposite sides of the deck, exactly as a real pair would be, and means
   * neither ever crosses the opposing carriageway.
   *
   * `rampLength` is the whole descent. 170 m for an 11.6 m drop is a 6.8%
   * average, and because the profile is eased at both ends (a real road has a
   * vertical curve at the crest and at the sag, and a car that meets a grade
   * change as a corner gets thrown) the steepest point is about 10%.
   */
  ramps: true,
  /** Where each ramp's TOP sits along the run, as a fraction of it. */
  rampAt: [0.3, 0.7],
  rampLength: 220,
  /**
   * THE RAMP'S OWN WIDTH AND OFFSET, and the two are locked together by the
   * street, not chosen freely:
   *
   *   the ramp must clear the deck   offset - width/2 >= deckWidth/2
   *   and stay inside the street     offset + width/2 <= streetWidth/2
   *
   * With a 34 m street and a 19 m deck that leaves exactly one usable pair —
   * 7 m wide at 13 m out puts the ramp's inner edge flush with the deck's and
   * its outer edge half a metre inside the kerb. A 9 m ramp does not fit at
   * all, and the version that tried put its outer wheels over the pavement.
   * viaductTest checks both inequalities rather than the numbers.
   */
  rampWidth: 7,
  rampOffset: 13,
  /**
   * ── DIVERGE FIRST, THEN DESCEND ────────────────────────────────────────────
   *
   * These two windows do not overlap, and that is the whole geometry of the
   * thing. A ramp that starts dropping while it is still over the deck drops
   * INTO it — measured on the first attempt, the ramp surface ended up inside
   * the main slab about forty metres along, which draws as a perfectly ordinary
   * road right up until you drive it.
   *
   * So the lateral move finishes at `rampSplit` and the descent does not begin
   * until `rampFall`. Until then the ramp runs flat, two centimetres above the
   * deck it is leaving — the gore area of a real slip road, and the 2 cm is
   * what stops the two coplanar surfaces fighting over it.
   */
  rampSplit: 0.22,
  rampFall: 0.20,
  /** Extra metres of open barrier either end of the gore. */
  gorePad: 12,
  /** Stations per ramp. Ramps bend in two axes at once, so they get their own
   *  density rather than inheriting the straight's. */
  rampSteps: 26,

  /** Traffic. A motorway is busier and faster than the streets under it. */
  viaductTraffic: true,
  viaductCars: 26,
  viaductSpeed: 1.55,

  colorPier: 0x8c8b84,
  colorPierDirt: 0x4c4a44,
};

/**
 * ── WHERE THE VIADUCT IS ─────────────────────────────────────────────────────
 *
 * PURE, and separate from the geometry on purpose: the traffic system and the
 * collision bake both need the same answer, and the only way three systems
 * agree about a structure is if they ask one function rather than each deriving
 * it. Same discipline as the lane table (see `laneTravelDir` in
 * modularRoadCityFurniture.js), for the same reason.
 *
 * Returns null when the chosen street falls outside the city.
 */
export function viaductLayout({ P, originCellX = 0, originCellZ = 0, params = {} }) {
  const V = { ...VIADUCT_DEFAULTS, ...params };
  if (!V.viaduct) return null;

  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const streetW = Math.max(P.streetLots * P.lotSize, 1);
  const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
  const half = P.extent;
  const axis = V.viaductAxis === "z" ? "z" : "x";

  // The street it runs above. `across` is measured on the OTHER axis — an
  // x-running viaduct is placed by its z, exactly like a lane.
  const oAcross = axis === "x" ? oz : ox;
  const cAcross = axis === "x" ? P.centerZ : P.centerX;
  const cAlong = axis === "x" ? P.centerX : P.centerZ;
  const k = Math.round((cAcross - oAcross - blockW - streetW / 2) / pitch) + V.viaductOffset;
  const across = oAcross + k * pitch + blockW + streetW / 2;
  if (Math.abs(across - cAcross) > half) return null;

  /*
   * `deckY` IS THE DRIVING SURFACE, and every other height is measured from it.
   *
   * The road profile puts the deck at y = 0 and hangs the slab BELOW it, so the
   * centreline path is at the surface the car sits on — not at the underside,
   * and not at the middle of the slab. Getting this backwards would put the car
   * a slab's thickness inside its own road.
   */
  const deckBottom = P.groundY + V.clearance;
  const deckY = deckBottom + V.deckThickness;
  const railTop = deckY + roadParams.railHeight + railParams.gap + railParams.height;

  // Lane centres across the deck: two each side of the central reserve.
  const laneAcross = [-0.34, -0.13, 0.13, 0.34].map((f) => across + f * V.deckWidth);

  const alongMin = cAlong - half, alongMax = cAlong + half;

  /*
   * THE CENTRELINE, as points.
   *
   * A straight line today. It is a POLYLINE rather than two endpoints because
   * everything the viaduct is going to grow — curves, grades, a run out past
   * the edge of town, ramps peeling off it — is a different set of points
   * through the same sweep, and none of it needs this file to change shape.
   */
  const path = [];
  const steps = Math.max(1, Math.round((alongMax - alongMin) / V.straightStep));
  for (let i = 0; i <= steps; i++) {
    const a = alongMin + ((alongMax - alongMin) * i) / steps;
    path.push(axis === "x" ? new THREE.Vector3(a, deckY, across)
      : new THREE.Vector3(across, deckY, a));
  }

  /*
   * ── THE SLIP ROADS ─────────────────────────────────────────────────────────
   *
   * Also just points. A ramp diverges sideways while it descends, which is two
   * curves at once and would be fiddly as geometry — as a path it is two eased
   * interpolations sampled together, and `computeFrames` turns the result into
   * a properly banked, properly twisted road with no further help.
   *
   * `ease` is smoothstep, and it is doing real work in BOTH axes. Vertically it
   * is the crest and sag curve every road has, because a car meeting an abrupt
   * grade change meets it as a corner and gets thrown. Laterally it is the
   * diverge, which has to start and end parallel or the ramp leaves the deck at
   * an angle and rejoins the street at one.
   */
  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const ramps = [];
  if (V.ramps) {
    // It leaves from the deck's own outer edge, flush, so the gore is a lane
    // widening rather than a road appearing beside another one.
    const startOff = (V.deckWidth - V.rampWidth) / 2;
    const topY = deckY + 0.02;
    for (let r = 0; r < V.rampAt.length; r++) {
      // Alternate direction, so there is one slip road for each carriageway.
      const dir = r % 2 === 0 ? 1 : -1;
      // RIGHT of the direction of travel: right of +x is +z, right of +z is -x.
      const side = axis === "x" ? dir : -dir;
      const a0 = alongMin + (alongMax - alongMin) * V.rampAt[r];
      const rPath = [];
      for (let i = 0; i <= V.rampSteps; i++) {
        const t = i / V.rampSteps;
        const a = a0 + dir * V.rampLength * t;
        // A 2 cm lip at the bottom rather than exactly groundY: coplanar with
        // the street plane is a z-fight across the whole ramp mouth, and 2 cm
        // is far below anything the suspension notices.
        const fall = ease((t - V.rampFall) / (1 - V.rampFall));
        const y = topY - (topY - (P.groundY + 0.02)) * fall;
        const off = across + side * (startOff
          + (V.rampOffset - startOff) * ease(t / V.rampSplit));
        rPath.push(axis === "x" ? new THREE.Vector3(a, y, off)
          : new THREE.Vector3(off, y, a));
      }
      /*
       * THE MOUTH — the along-axis window in which the ramp is still over the
       * deck it is leaving. The deck's barrier has to be ABSENT here, or the
       * slip road is a road you can see and cannot enter. A little margin
       * either side, because a gap that ends exactly where the ramp clears is
       * a gap you have to hit perfectly.
       */
      const aSplit = a0 + dir * V.rampLength * V.rampSplit;
      const pad = V.gorePad;
      ramps.push({
        path: rPath, dir, side,
        mouthMin: Math.min(a0, aSplit) - pad,
        mouthMax: Math.max(a0, aSplit) + pad,
      });
    }
  }

  /*
   * ── PIERS ──────────────────────────────────────────────────────────────────
   *
   * Each carries its own top height, because the ramps descend and a column
   * under one is shorter than a column under the deck. The shaft is instanced
   * at unit height and scaled, so any height costs the same nothing.
   *
   * TWO PLACES A PIER MAY NOT STAND. A junction, because that is exactly where
   * cars turn and a real viaduct spans what it cannot stand in. And anywhere
   * the road above it is too low to be worth holding up — the bottom of a ramp
   * is a road ON the ground, and a stub column under it is a bollard in the
   * street.
   */
  const oAlong = axis === "x" ? ox : oz;
  const inJunction = (along) => {
    let f = (along - oAlong) % pitch;
    if (f < 0) f += pitch;
    return f >= blockW;
  };
  const piers = [];
  const first = Math.ceil((alongMin - oAlong) / V.spanLength);
  const last = Math.floor((alongMax - oAlong) / V.spanLength);
  for (let i = first; i <= last; i++) {
    const a = oAlong + i * V.spanLength;
    if (inJunction(a)) continue;
    piers.push(axis === "x" ? { x: a, z: across, top: deckBottom }
      : { x: across, z: a, top: deckBottom });
  }
  const minPier = V.capHeight + 1.5;
  for (const rm of ramps) {
    let acc = 0;
    for (let i = 1; i < rm.path.length; i++) {
      const p0 = rm.path[i - 1], p1 = rm.path[i];
      acc += p0.distanceTo(p1);
      if (acc < V.spanLength) continue;
      acc = 0;
      const top = p1.y - V.deckThickness;
      if (top - P.groundY < minPier) continue;
      if (inJunction(axis === "x" ? p1.x : p1.z)) continue;
      piers.push({ x: p1.x, z: p1.z, top });
    }
  }

  return {
    axis, across, alongMin, alongMax,
    deckY, deckBottom, railTop,
    path, ramps, laneAcross, piers, params: V,
  };
}

/**
 * ── WHERE NOTHING MAY STAND ──────────────────────────────────────────────────
 *
 * A predicate over the RAMPS, and only the ramps. Under the main deck there is
 * 10.4 m of headroom and a lamp post is 9 — the street below it carries on as a
 * street. A ramp is different: it descends from eleven metres to the pavement,
 * so somewhere along it, it passes through the height of everything the city
 * puts on a kerb. In the first version it did exactly that, and because street
 * furniture is solid the signals and lamps it passed through became a wall
 * across the slip road.
 *
 * Height-aware would be more precise and is not worth it: the strip is thirteen
 * metres wide and a couple of hundred long, twice, and a lamp post under a ramp
 * is wrong at any height it would fit under.
 *
 * @returns {(x:number, z:number) => boolean} true where the ground is spoken for
 */
export function viaductKeepOut(layout) {
  if (!layout || !(layout.ramps ?? []).length) return null;
  const V = layout.params;
  const halfW = V.rampWidth / 2 + 3.0;
  const h2 = halfW * halfW;
  // Flattened to plain numbers: this is asked once per candidate placement, of
  // which there are tens of thousands.
  const segs = [];
  for (const rmp of layout.ramps) {
    for (let i = 1; i < rmp.path.length; i++) {
      const a = rmp.path[i - 1], b = rmp.path[i];
      segs.push(a.x, a.z, b.x - a.x, b.z - a.z);
    }
  }
  return (x, z) => {
    for (let i = 0; i < segs.length; i += 4) {
      const px = x - segs[i], pz = z - segs[i + 1];
      const dx = segs[i + 2], dz = segs[i + 3];
      const len2 = dx * dx + dz * dz;
      let t = len2 > 0 ? (px * dx + pz * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = px - dx * t, qz = pz - dz * t;
      if (qx * qx + qz * qz < h2) return true;
    }
    return false;
  };
}

/** Concrete for the piers. The deck is the game's own road material. */
function pierMaterial(V) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0 });
  m.name = "CityViaductPier";
  const base = uniform(new THREE.Color(V.colorPier));
  const dirt = uniform(new THREE.Color(V.colorPierDirt));
  const uTop = uniform(0);
  m.colorNode = Fn(() => {
    /*
     * Concrete streaks DOWNWARD, and on a structure this size that is most of
     * what sells it as concrete rather than as grey plastic. Rain runs off the
     * deck edge onto the pier tops, so the dirt is keyed to distance BELOW the
     * deck rather than to height above the ground.
     */
    const below = uTop.sub(positionWorld.y).toVar();
    const streak = smoothstep(float(0.0), float(2.6), below)
      .mul(smoothstep(float(9.0), float(3.0), below)).mul(0.28);
    // `vertexColor()` is a vec4; the alpha is not a part id and never was.
    return mix(base.mul(vertexColor().rgb.r.mul(0.25).add(0.75)), dirt, streak);
  })();
  return { material: m, uTop };
}

/**
 * Build the viaduct. Three draws.
 *
 * @param {object} opts
 * @param {ReturnType<typeof viaductLayout>} opts.layout
 * @param {THREE.Material} [opts.roadMaterial]  the game's road surface. Passing
 *   it is what makes the viaduct look like the track AND costs no new pipeline.
 * @param {THREE.Material} [opts.railMaterial]  the game's guardrail material.
 */
export function createCityViaduct({
  layout, roadMaterial = null, railMaterial = null, castShadows = true,
}) {
  if (!layout) return null;
  const V = layout.params;
  const group = new THREE.Group();
  group.name = "CityViaduct";
  const owned = [];

  // ── The deck: the road kit's own sweep ─────────────────────────────────────
  // A wider, thicker section than the track's, and otherwise identical — same
  // kerbs, same deck lines, same shader.
  const rp = { ...roadParams, width: V.deckWidth, thickness: V.deckThickness };
  const profile = buildProfile(rp, true);
  const rampRp = { ...roadParams, width: V.rampWidth, thickness: V.deckThickness };
  const rampProfile = buildProfile(rampRp, true);

  /*
   * ── ONE MESH FOR THE WHOLE INTERCHANGE ─────────────────────────────────────
   *
   * The main deck and every slip road are swept separately — they are different
   * paths and different section widths — and then merged. They share a material,
   * so merging costs nothing and saves a draw per ramp; and because the merged
   * mesh IS the collision surface, it also means one BVH covering the deck and
   * its ramps rather than three that have to agree at the joins.
   */
  const runs = [{ frames: computeFrames(layout.path), rp, profile }];
  for (const rm of layout.ramps ?? []) {
    runs.push({ frames: computeFrames(rm.path), rp: rampRp, profile: rampProfile });
  }
  const deckParts = runs.map((r) => buildSweepGeometry(r.frames, r.profile));
  const deckGeo = deckParts.length === 1 ? deckParts[0] : mergeGeometries(deckParts, false);
  if (deckParts.length > 1) for (const g of deckParts) g.dispose();

  let deckMat = roadMaterial;
  if (!deckMat) {
    deckMat = new THREE.MeshStandardNodeMaterial({ color: 0x3b3b3e, roughness: 0.92 });
    deckMat.name = "CityViaductDeckFallback";
    owned.push(deckMat);
  }
  const deck = new THREE.Mesh(deckGeo, deckMat);
  deck.name = "CityViaductDeck";
  deck.castShadow = castShadows;
  deck.receiveShadow = true;
  // One mesh spanning the city: there is no camera position from which culling
  // it is correct.
  deck.frustumCulled = false;
  group.add(deck);

  /*
   * ── THE GUARDRAIL, ON THE SAME FRAMES ──────────────────────────────────────
   *
   * The game's own rail, not the kit's older W-beam sweep — so the viaduct's
   * barrier is the one that was actually tuned to look right, and so it comes
   * with the thing that matters more here than on the track: a COLLISION PROXY
   * that is two vertical walls on decimated frames rather than every post and
   * corrugation. Measured on this run, the visible beam is 9816 triangles; the
   * proxy is a fraction of that, and it is the one the chassis is sampled
   * against on a road eleven metres in the air.
   */
  let rail = null;
  let railCollider = null;
  const railP = { ...railParams, postSpacing: V.railPostSpacing };

  /*
   * ── THE BARRIER, WITH THE GORE LEFT OPEN ───────────────────────────────────
   *
   * A rail down both edges of everything is what the first version did, and it
   * walled the slip roads off completely: the ramp diverged from the deck with
   * a barrier on the deck's edge AND one on the ramp's, so the one place a car
   * has to cross was the one place it could not. The road was visibly there and
   * unreachable.
   *
   * So the rails are built A SIDE AT A TIME over sub-ranges of the frames:
   *   · the DECK keeps both barriers except on the side a ramp leaves from,
   *     where it stops before the mouth and starts again after it;
   *   · a RAMP has its outer barrier for its whole length — that is the edge of
   *     a road eleven metres up — and its inner one only once it has diverged
   *     far enough to be a separate road.
   *
   * WHICH LOCAL SIDE IS WHICH IS MEASURED, NOT ASSUMED. `computeFrames` picks
   * its own frame, so `right` is not guaranteed to point at +across; dotting it
   * with the across axis once tells us, and getting it wrong would open the
   * barrier on the far edge of the deck instead — a hole with nothing beside it
   * and nothing to see.
   */
  const acrossUnit = layout.axis === "x"
    ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const sideSignOf = (fr) => (fr[0].right.dot(acrossUnit) >= 0 ? 1 : -1);

  /** {frames, rp, sides} — one call to the rail builder each. */
  const railRuns = [];
  {
    const F = runs[0].frames;
    const span = layout.alongMax - layout.alongMin;
    const idxOf = (a) => Math.max(0, Math.min(F.length - 1,
      Math.round(((a - layout.alongMin) / span) * (F.length - 1))));
    const deckSign = sideSignOf(F);
    for (const localSide of [-1, 1]) {
      // The world-across side this local side sits on.
      const worldSide = localSide * deckSign;
      const gaps = (layout.ramps ?? [])
        .filter((r) => r.side === worldSide)
        .map((r) => [idxOf(r.mouthMin), idxOf(r.mouthMax)])
        .sort((a, b) => a[0] - b[0]);
      let cur = 0;
      for (const [g0, g1] of gaps) {
        if (g0 - cur >= 2) railRuns.push({ frames: F.slice(cur, g0 + 1), rp, sides: [localSide] });
        cur = Math.max(cur, g1);
      }
      if (F.length - 1 - cur >= 2) railRuns.push({ frames: F.slice(cur), rp, sides: [localSide] });
    }
  }
  (layout.ramps ?? []).forEach((rmp, i) => {
    const F = runs[i + 1].frames;
    const sign = sideSignOf(F);
    // Inner = toward the deck centre, i.e. the opposite world side to the one
    // the ramp diverged to.
    const inner = -rmp.side * sign;
    const k = Math.min(F.length - 2, Math.ceil(V.rampSplit * (F.length - 1)));
    railRuns.push({ frames: F, rp: rampRp, sides: [-inner] });
    railRuns.push({ frames: F.slice(k), rp: rampRp, sides: [inner] });
  });

  const railParts = [], railColParts = [];
  for (const r of railRuns) {
    const g = buildRailGeometry(r.frames, r.rp, railP, { sides: r.sides });
    if (g) railParts.push(g);
    const c = buildRailCollision(r.frames, r.rp, railP, { sides: r.sides });
    if (c) railColParts.push(c);
  }
  const merge1 = (parts) => {
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0];
    const m = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    return m;
  };
  const railGeo = merge1(railParts);
  const railColGeo = merge1(railColParts);
  if (railGeo) {
    let rm = railMaterial;
    if (!rm) {
      rm = new THREE.MeshStandardNodeMaterial({ color: 0x9aa0a6, roughness: 0.45, metalness: 0.7 });
      rm.name = "CityViaductRailFallback";
      owned.push(rm);
    }
    rail = new THREE.Mesh(railGeo, rm);
    rail.name = "CityViaductRail";
    rail.castShadow = castShadows;
    rail.receiveShadow = true;
    rail.frustumCulled = false;
    group.add(rail);
  }
  if (railColGeo) {
    // NOT added to the group: it is never drawn, only collided with. A real
    // Mesh rather than a duck-typed stand-in so `bakeFromMeshes` finds exactly
    // what it expects, and left at the identity because the geometry is already
    // in world space.
    railCollider = new THREE.Mesh(railColGeo, deckMat);
    railCollider.name = "CityViaductRailCollision";
    railCollider.visible = false;
    railCollider.updateMatrixWorld();
  }

  /*
   * ── THE PIERS ──────────────────────────────────────────────────────────────
   *
   * TWO instanced meshes, and the split is the whole reason ramps work. Every
   * pier under the main deck is the same height; every pier under a ramp is a
   * different one, because the ramp is descending. So the SHAFT is built at
   * unit height and scaled per instance — the taper survives it untouched,
   * being entirely in X and Z — while the CAP, which must not stretch, is its
   * own mesh translated to whatever height its shaft reached.
   *
   * The alternative was one geometry per distinct height, which is a draw call
   * per pier on a structure that has sixty of them.
   */
  const { material: pierMat, uTop } = pierMaterial(V);
  owned.push(pierMat);
  uTop.value = layout.deckBottom;
  let shafts = null, caps = null;
  const mk = (w, h, d, y, shade) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, y, 0);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3).fill(shade);
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    return g;
  };
  if (layout.piers.length) {
    // A tapered shaft as two stacked boxes rather than a lathe: the taper reads
    // at forty metres and beyond, and two boxes is 24 triangles against a
    // cylinder's hundreds. Built 1 m tall; the instance matrix does the rest.
    const lowerF = 0.55;
    const shaftParts = [mk(V.pierWidth, lowerF, V.pierDepth, lowerF * 0.5, 1.0)];
    const tw = V.pierWidth * V.pierTaper, td = V.pierDepth * V.pierTaper;
    shaftParts.push(mk(tw, 1 - lowerF, td, lowerF + (1 - lowerF) * 0.5, 1.0));
    const shaftGeo = mergeGeometries(shaftParts, false);
    for (const g of shaftParts) g.dispose();

    const [cw, cd] = layout.axis === "x" ? [V.capDepth, V.capWidth] : [V.capWidth, V.capDepth];
    const capGeo = mk(cw, V.capHeight, cd, V.capHeight * 0.5, 0.86);

    shafts = new THREE.InstancedMesh(shaftGeo, pierMat, layout.piers.length);
    shafts.name = "CityViaductPiers";
    caps = new THREE.InstancedMesh(capGeo, pierMat, layout.piers.length);
    caps.name = "CityViaductPierCaps";
    const m = new THREE.Matrix4();
    layout.piers.forEach((p, i) => {
      const colH = Math.max(0.5, p.top - V.capHeight);
      m.makeScale(1, colH, 1);
      m.setPosition(p.x, 0, p.z);
      shafts.setMatrixAt(i, m);
      m.identity();
      m.setPosition(p.x, colH, p.z);
      caps.setMatrixAt(i, m);
    });
    for (const im of [shafts, caps]) {
      im.castShadow = castShadows;
      im.receiveShadow = true;
      im.frustumCulled = false;
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
    }
  }
  const piers = shafts;

  return {
    group,
    layout,
    /**
     * ── WHAT THE CAR IS RESOLVED AGAINST ──────────────────────────────────────
     *
     * The same shape the dock hands over, and consumed the same way: the deck
     * meshes go into the drive-surface BVH, the guardrail into solids. `RoadBvh`
     * reads only `.geometry` and `.matrixWorld`, so these are the real meshes
     * with no proxy and no copy — the surface you see IS the surface you are on.
     */
    collisionMeshes() {
      return { deck: [deck], solids: railCollider ? [railCollider] : [] };
    },
    stats: {
      piers: layout.piers.length,
      ramps: (layout.ramps ?? []).length,
      draws: 1 + (rail ? 1 : 0) + (piers ? 2 : 0),
      lengthM: Math.round(layout.alongMax - layout.alongMin),
      deckTris: deckGeo.index ? deckGeo.index.count / 3 : 0,
      railTris: railGeo ? (railGeo.index ? railGeo.index.count / 3 : 0) : 0,
      railColTris: railColGeo ? (railColGeo.index ? railColGeo.index.count / 3
        : railColGeo.attributes.position.count / 3) : 0,
    },
    dispose() {
      deckGeo.dispose();
      if (railGeo) railGeo.dispose();
      if (railColGeo) railColGeo.dispose();
      if (shafts) { shafts.geometry.dispose(); shafts.dispose(); }
      if (caps) { caps.geometry.dispose(); caps.dispose(); }
      for (const m of owned) m.dispose();
    },
  };
}
