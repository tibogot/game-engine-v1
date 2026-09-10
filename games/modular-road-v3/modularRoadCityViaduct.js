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
import {
  Fn, float, vec2, vec3, vec4, uniform, mix, smoothstep, positionWorld,
  vertexColor, normalWorldGeometry, abs, fract, sin, step, max,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  computeFrames, buildSweepGeometry, buildProfile, roadParams, NO_CHECKER,
} from "./modularRoadKit.js";
import { buildRailGeometry, buildRailCollision, railParams } from "./modularRoadRail.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { createRoadMarkings, MARK } from "./modularRoadCityMarkings.js";

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
  /** Station spacing through a gore. Fine enough to end the kerb AND taper it
   *  down inside the mouth — see the note on the centreline. */
  goreStep: 6,
  /** Stations over which a kerb rises or falls where it starts and stops. */
  kerbTaper: 3,
  /** Stations per ramp. Ramps bend in two axes at once, so they get their own
   *  density rather than inheriting the straight's. */
  rampSteps: 26,

  /**
   * ── THE ROUTE ──────────────────────────────────────────────────────────────
   *
   * Straight over its street through the middle of town, then a curve at each
   * end and a run out past the edge. A grid city where every line is one of two
   * directions reads as a grid; the one structure tall enough to be seen from
   * everywhere is the one worth bending.
   *
   * The straight part is where the grid arithmetic lives — piers dodging
   * junctions, slip roads, lane offsets — so `straightSpan` is how much of the
   * city keeps that, and the curves happen outside it. Pull it in and more of
   * the viaduct curves; the buildings under the curve are demolished for it,
   * which is what an urban motorway actually does to a block.
   */
  straightSpan: 0.66,
  curveRadius: 260,
  curveAngle: 38,
  /** Which way both ends bend, in world across. Same sign at both, so the whole
   *  thing is one shallow arc rather than an S. */
  curveTurn: 1,
  /**
   * How far it runs after the curve, out past the edge of town — and DOWN.
   *
   * A motorway that stops in mid-air eleven metres up is the one thing about an
   * elevated road you cannot explain away, and it is what the player sees the
   * moment they follow it to the end. So the tail is a descent: the same eased
   * profile the slip roads use, over a much longer run, landing on the ground
   * outside the city where it can simply carry on as a street.
   */
  tailLength: 420,
  /** The fraction of the tail spent still level, before it starts down. */
  tailHold: 0.12,
  /** Station spacing on a curve. Tighter than the straight's, because this is
   *  where the deck's silhouette is actually read. */
  curveStep: 12,

  /** Traffic. A motorway is busier and faster than the streets under it. */
  viaductTraffic: true,
  viaductCars: 26,
  viaductSpeed: 1.55,

  colorPier: 0x8c8b84,
  colorPierDirt: 0x4c4a44,
  /**
   * ── CONCRETE, FAKED ────────────────────────────────────────────────────────
   *
   * MEASURED at 20.7 kB of WGSL before, and this is what it costs to add — see
   * the note on `concreteDetail`. A 1K texture set for the same job packs to
   * about 850 kB, which is nine per cent of this game's entire boot payload for
   * one material, and the whole city around it is procedural anyway: one
   * textured object among two thousand shader-built ones tends to read as MORE
   * out of place, not less.
   *
   * `formPanel` is the size of the shuttering the pour was cast against, and it
   * is the single most recognisable thing about structural concrete — the grid
   * of faint seams where the panels met. Everything else here is dirt.
   */
  formPanelW: 2.4,
  formPanelH: 1.25,
  formSeam: 0.2,
  concreteBlotch: 0.13,
  concreteSpeckle: 0.07,

  /**
   * ── LIGHTING COLUMNS ───────────────────────────────────────────────────────
   *
   * Down the central reserve, two heads each, one over either carriageway —
   * which is where a real motorway puts them, and it halves the count against
   * a column on each shoulder.
   *
   * They do not CAST light. The lamp field the streets run is a shader pool
   * keyed to the street grid, and an elevated road is not on it; this is the
   * structure drawing its own line of lights at night, which is what actually
   * reads from below. One instanced mesh either way.
   */
  columns: true,
  columnSpacing: 46,
  columnHeight: 8.5,
  columnReach: 4.6,
  columnGlow: 3.2,
  colorColumn: 0x9ea3a6,

  /**
   * ── EXPANSION JOINTS ───────────────────────────────────────────────────────
   *
   * A dark band across the deck at every pier. Two hundred metres of unbroken
   * asphalt is the one thing that says "this is not really a bridge", and the
   * joints are what break it into spans you can count as you drive.
   *
   * Geometry rather than a stripe in the road shader, because that shader is
   * shared with the whole track and a viaduct's joints have no business
   * appearing on a race circuit.
   */
  /**
   * Destination boards over the deck. They ride the CITY'S gantry mesh — see
   * the note in modularRoadCityFurniture.js — so they cost instances, not draws.
   */
  gantries: true,
  gantrySpacing: 420,
  /** How far before a slip road its warning board stands. Far enough to be a
   *  warning rather than an announcement. */
  gantryWarn: 240,

  /**
   * ── PAINT ON THE DECK ──────────────────────────────────────────────────────
   *
   * A motorway exit is signed three times over in reality — a board, then paint
   * in the lane, then the gore itself — and the paint is the one that tells you
   * WHICH LANE. Without it the slip road is a hole in a barrier that you either
   * happen to be lined up for or you do not.
   */
  markings: true,
  markWidth: 3.4,
  markLength: 9.0,

  joints: true,
  jointWidth: 0.42,
  /** How far above the deck they sit. Enough to win the depth test at range
   *  without being a lip the suspension can feel. */
  jointLift: 0.014,
  colorJoint: 0x2c2b29,
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
/** Unit tangent from the last two points of a run. */
function headOf(pts) {
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1;
  return { x: dx / L, z: dz / L };
}

/**
 * An arc of `total` radians off `pos` heading `head`, bending toward `want`.
 *
 * WHICH WAY IT BENDS IS CHOSEN BY TRYING BOTH. The centre of an arc is ninety
 * degrees off the heading, and which ninety depends on a sign convention that
 * is easy to state and easy to get backwards — and getting it backwards does
 * not throw, it curves the viaduct into the city instead of out of it. So both
 * are built and the one that ends up further along `want` is kept.
 */
function arcRun(pos, head, radius, total, want, step, y) {
  const build = (sign) => {
    const perp = { x: -head.z * sign, z: head.x * sign };
    const cx = pos.x + perp.x * radius, cz = pos.z + perp.z * radius;
    const a0 = Math.atan2(pos.z - cz, pos.x - cx);
    const n = Math.max(2, Math.ceil((radius * total) / step));
    const pts = [];
    for (let i = 1; i <= n; i++) {
      /*
       * PLUS, not minus. Position on the circle is c + R(cos a, sin a), so the
       * tangent is R(-sin a, cos a) — which equals `head` at the start angle
       * only when `a` INCREASES for sign +1 and decreases for sign -1. Walking
       * it the other way sends the arc back the way the road came.
       *
       * "Try both signs" below could not catch this: BOTH candidates were wrong
       * the same way, so it picked the less bad of two arcs that curved
       * backwards, and the tails came out five hundred metres inside the city
       * instead of a kilometre outside it. A chooser only helps when one of the
       * choices is right.
       */
      const a = a0 + sign * total * (i / n);
      pts.push(new THREE.Vector3(cx + Math.cos(a) * radius, y, cz + Math.sin(a) * radius));
    }
    return pts;
  };
  const A = build(1), B = build(-1);
  const score = (pts) => {
    const e = pts[pts.length - 1];
    return (e.x - pos.x) * want.x + (e.z - pos.z) * want.z;
  };
  return score(A) >= score(B) ? A : B;
}

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

  // Lane centres across the deck: two each side of the central reserve. Kept as
  // absolute coordinates as well as offsets, because on the STRAIGHT they are
  // what the grid-side checks talk about.
  const LANE_OFF = [-0.34, -0.13, 0.13, 0.34];
  const laneAcross = LANE_OFF.map((f) => across + f * V.deckWidth);

  // The STRAIGHT run's extent. Not the whole viaduct any more — the curves and
  // the tails live outside it — but it is still where every piece of grid
  // arithmetic happens, so it keeps the plain name.
  const alongMin = cAlong - half * V.straightSpan;
  const alongMax = cAlong + half * V.straightSpan;

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
   * ── THE CENTRELINE ─────────────────────────────────────────────────────────
   *
   * Tail, curve, straight, curve, tail. Built as three runs and concatenated,
   * because the two ends are walked OUTWARD from the straight — that is the
   * only way the straight lands exactly on its street, which everything else
   * about the viaduct depends on.
   *
   * NOT EVENLY SPACED, and on purpose in two different places. A sweep can only
   * change its cross-section AT a station, and the kerb has to stop where a
   * slip road crosses it — at the plain 24 m spacing a gore is three stations,
   * which is not enough to both end the kerb and taper it down. Curves get
   * their own tighter spacing for a different reason: that is where the deck's
   * silhouette is actually read.
   */
  const path = [];
  let straightI0 = 0, straightI1 = 0;
  {
    const alongUnit = axis === "x" ? { x: 1, z: 0 } : { x: 0, z: 1 };
    const acrossUnit = axis === "x" ? { x: 0, z: 1 } : { x: 1, z: 0 };
    const want = { x: acrossUnit.x * V.curveTurn, z: acrossUnit.z * V.curveTurn };
    const at = (a) => (axis === "x" ? new THREE.Vector3(a, deckY, across)
      : new THREE.Vector3(across, deckY, a));

    // The straight, with extra stations wherever a kerb has to change.
    const stations = new Set();
    const steps = Math.max(1, Math.round((alongMax - alongMin) / V.straightStep));
    for (let i = 0; i <= steps; i++) {
      stations.add(alongMin + ((alongMax - alongMin) * i) / steps);
    }
    for (const rmp of ramps) {
      const a = rmp.mouthMin - V.goreStep, b = rmp.mouthMax + V.goreStep;
      for (let x = a; x <= b + 1e-6; x += V.goreStep) {
        if (x > alongMin && x < alongMax) stations.add(x);
      }
    }
    const mid = [...stations].sort((p1, p2) => p1 - p2).map(at);

    const ang = (V.curveAngle * Math.PI) / 180;
    /** Curve then run, walking away from one end of the straight. */
    const wing = (from, head) => {
      if (ang <= 0 || V.curveRadius <= 0) return [];
      const arc = arcRun(from, head, V.curveRadius, ang, want, V.curveStep, deckY);
      if (V.tailLength > 0) {
        const h = headOf(arc.length > 1 ? arc : [from, arc[0]]);
        const n = Math.max(1, Math.round(V.tailLength / V.straightStep));
        const last = arc[arc.length - 1];
        const land = P.groundY + 0.02;   // the same 2 cm the slip roads land on
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const fall = ease((t - V.tailHold) / (1 - V.tailHold));
          arc.push(new THREE.Vector3(
            last.x + h.x * (V.tailLength * t),
            deckY - (deckY - land) * fall,
            last.z + h.z * (V.tailLength * t),
          ));
        }
      }
      return arc;
    };
    const hi = wing(mid[mid.length - 1], alongUnit);
    const lo = wing(mid[0], { x: -alongUnit.x, z: -alongUnit.z });

    for (let i = lo.length - 1; i >= 0; i--) path.push(lo[i]);
    straightI0 = path.length;
    for (const q of mid) path.push(q);
    straightI1 = path.length - 1;
    for (const q of hi) path.push(q);
  }

  /** Cumulative arc length, so anything can be placed by distance travelled
   *  rather than by a coordinate that stops being monotonic once it bends. */
  const cum = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + path[i - 1].distanceTo(path[i]);
  const pathLength = cum[path.length - 1] || 0;

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
  /*
   * A junction test in WORLD terms, so it keeps working once the deck bends
   * away from the axis it was laid out on.
   *
   * BOTH axes, not either. A junction is where two streets CROSS. The viaduct
   * runs along a street, so its across coordinate sits in a street band for its
   * whole length — an `||` here reads every metre of it as a junction and
   * refuses to plant a single pier, which is exactly what the first version
   * did: seventeen piers for two and a half kilometres, none under a ramp.
   */
  const inJunction = (x, z) => {
    const fx = ((x - ox) % pitch + pitch) % pitch;
    const fz = ((z - oz) % pitch + pitch) % pitch;
    return fx >= blockW && fz >= blockW;
  };

  const piers = [];
  const minPier = V.capHeight + 1.5;
  /** Walk a run by arc length and drop a pier every `spanLength`. */
  const pierWalk = (pts, topOf) => {
    let acc = V.spanLength;
    for (let i = 1; i < pts.length; i++) {
      acc += pts[i - 1].distanceTo(pts[i]);
      if (acc < V.spanLength) continue;
      acc = 0;
      const q = pts[i];
      const top = topOf(q);
      if (top - P.groundY < minPier) continue;
      if (inJunction(q.x, q.z)) continue;
      piers.push({ x: q.x, z: q.z, top });
    }
  };
  // The deck is no longer flat — the tails come down — so a pier under it takes
  // its height from the road above it exactly like a pier under a ramp does.
  pierWalk(path, (q) => q.y - V.deckThickness);
  for (const rm of ramps) pierWalk(rm.path, (q) => q.y - V.deckThickness);

  /*
   * ── EVERYTHING ELSE BOLTED TO THE DECK ─────────────────────────────────────
   *
   * Stationed here rather than where it is drawn, for the reason the piers are:
   * the lighting columns are SOLID, and the list the collision reads has to be
   * the same list the geometry was built from or there is an invisible column
   * somewhere, or a visible one you drive through.
   */
  const stationWalk = (pts, spacing) => {
    const out = [];
    let acc = spacing;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      acc += a.distanceTo(b);
      if (acc < spacing) continue;
      acc = 0;
      out.push({ x: b.x, y: b.y, z: b.z, yaw: Math.atan2(b.x - a.x, b.z - a.z) });
    }
    return out;
  };
  const columns = V.columns ? stationWalk(path, V.columnSpacing) : [];
  const joints = V.joints ? stationWalk(path, V.spanLength) : [];

  /*
   * ── THE EXIT, PAINTED ──────────────────────────────────────────────────────
   *
   * In the lane that leaves, reading up to the gore: the word first, then two
   * diverge arrows closing on the mouth. All of it on the STRAIGHT, where the
   * deck is axis-aligned and an along coordinate still means something.
   */
  const marks = [];
  if (V.markings) {
    const laneOut = axis === "x" ? 1 : -1;   // +along is which world across?
    for (const rmp of ramps) {
      // The lane that leaves is the outer one on the ramp's side.
      const lane = rmp.side > 0 ? laneAcross[3] : laneAcross[0];
      const a0 = rmp.dir > 0 ? rmp.mouthMin + V.gorePad : rmp.mouthMax - V.gorePad;
      // Yaw so the shape's +Z reads along the direction of travel.
      const yaw = axis === "x"
        ? (rmp.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
        : (rmp.dir > 0 ? 0 : Math.PI);
      const at = (back, tile, w, h) => {
        const a = a0 - rmp.dir * back;
        if (a < alongMin || a > alongMax) return;
        marks.push({
          x: axis === "x" ? a : lane,
          z: axis === "x" ? lane : a,
          y: deckY,
          yaw, tile, w, h,
        });
      };
      at(150, MARK.sortie, V.markWidth * 1.25, V.markLength * 1.5);
      at(90, MARK.arrowDiverge, V.markWidth, V.markLength);
      at(40, MARK.arrowDiverge, V.markWidth, V.markLength);
    }
    void laneOut;
  }

  /*
   * ── A POLYLINE PER LANE ────────────────────────────────────────────────────
   *
   * The traffic model drives a lane, and a lane used to be "an axis, an across
   * and a direction" — three numbers that describe a straight line and nothing
   * else. The moment the deck bends, cars on it fly off into the air, still
   * perfectly spaced and perfectly obeying each other.
   *
   * So an elevated lane is a PATH: the deck's centreline offset sideways by the
   * lane's own distance. The offset is taken in the local frame, so it follows
   * the bend; on the straight it reduces to exactly the old numbers, which is
   * why the driving-side rule can still be read off `laneDirForIndex`.
   */
  const lanePaths = LANE_OFF.map((f) => {
    const off = f * V.deckWidth;
    const pts = path.map((q, i) => {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      // right = (-t.z, t.x): for a run along +x that is +z, which is the sense
      // `across` is measured in, so the straight case matches to the metre.
      return new THREE.Vector3(q.x + (-dz / L) * off, q.y, q.z + (dx / L) * off);
    });
    const c = new Float64Array(pts.length);
    for (let i = 1; i < pts.length; i++) c[i] = c[i - 1] + pts[i - 1].distanceTo(pts[i]);
    return { pts, cum: c, length: c[c.length - 1] || 0 };
  });

  return {
    axis, across, alongMin, alongMax,
    deckY, deckBottom, railTop,
    path, cum, pathLength, straightI0, straightI1,
    ramps, laneAcross, lanePaths, piers, columns, joints, marks, params: V,
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
  return corridorTest(layout.ramps.map((r) => r.path), layout.params.rampWidth / 2 + 3.0);
}

/**
 * ── THE DECK'S OWN FOOTPRINT, FOR THE BUILDINGS UNDER IT ─────────────────────
 *
 * The straight runs over a street, where there is nothing to hit. The CURVES do
 * not — they leave the grid and fly over blocks, and a tower is three hundred
 * metres of solid geometry through a road eleven metres up.
 *
 * So the blocks under the curve come down, which is exactly what an urban
 * motorway does to the city it is cut through, and reads as deliberate rather
 * than as a mistake. Half a lot wider than the deck, because a lot is placed by
 * its centre and a building whose centre just clears the deck still has most of
 * itself underneath it.
 */
export function viaductFootprint(layout, lotSize = 34) {
  if (!layout) return null;
  return corridorTest([layout.path], layout.params.deckWidth / 2 + lotSize * 0.55);
}

/** Distance-to-polyline test, flattened to plain numbers because it is asked
 *  once per candidate lot and once per candidate placement — tens of thousands
 *  of times per rebuild. */
function corridorTest(paths, halfW) {
  const h2 = halfW * halfW;
  const segs = [];
  for (const path of paths) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      segs.push(a.x, a.z, b.x - a.x, b.z - a.z);
    }
  }
  if (!segs.length) return null;
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

/**
 * ── CONCRETE, WITHOUT A TEXTURE ──────────────────────────────────────────────
 *
 * Three things, in this order of how much they matter:
 *
 *   FORM PANEL SEAMS. Structural concrete is cast against panels, and the faint
 *   grid where they met is what makes a grey surface read as concrete rather
 *   than as painted plastic. It is also the cheapest of the three, being
 *   straight lines.
 *
 *   BLOTCHING, from two sine fields at incommensurate frequencies rather than
 *   real value noise. Proper FBM is eight hash lookups an octave; this is two
 *   sines and a multiply, and for the soft irregular staining on a pour that is
 *   genuinely all it needs. Concrete is the easy case — no hard edges and no
 *   repeating structure, which is exactly the opposite of the diamond plate,
 *   and exactly why THAT one earned a real texture and this one does not.
 *
 *   AGGREGATE SPECKLE, one hash. The arguments are wrapped into a small range
 *   first: `sin()` fed coordinates in the tens of thousands bands rather than
 *   hashes, which is what made this game's starfield invisible.
 *
 * NO normalNode, and that is a deliberate omission rather than a shortcut.
 * three builds that slot in its own sub-build, so a bumped normal would run
 * every one of the above a SECOND time — for a surface the player passes at
 * fifty metres a second. The seams are dark lines, not grooves.
 */
function concreteDetail(V) {
  const uPanelW = uniform(V.formPanelW);
  const uPanelH = uniform(V.formPanelH);
  const uSeam = uniform(V.formSeam);
  const uBlotch = uniform(V.concreteBlotch);
  const uSpeckle = uniform(V.concreteSpeckle);

  /** 1 on a seam line, 0 between. */
  const lineAt = (v, period) => {
    const d = abs(fract(v.div(period)).sub(0.5)).mul(period);
    return smoothstep(float(0.055), float(0.008), d);
  };

  return Fn(() => {
    const p = positionWorld;
    /*
     * THE ACROSS COORDINATE HAS TO VARY ACROSS THE FACE.
     *
     * A pier is a box. On the face whose normal is ±x, `p.x` is CONSTANT — so a
     * seam line keyed to it is either absent from that face or covers the whole
     * of it, depending on where the pier happens to stand. Picking whichever of
     * x and z actually moves costs an abs, a step and a mix.
     */
    const n = normalWorldGeometry;
    const across = mix(p.x, p.z, step(float(0.5), abs(n.x))).toVar();

    const seam = max(lineAt(across, uPanelW), lineAt(p.y, uPanelH)).mul(uSeam);

    const b1 = sin(p.x.mul(0.71).add(p.z.mul(0.43)).add(p.y.mul(0.27)));
    const b2 = sin(p.x.mul(0.19).sub(p.z.mul(0.31)).add(p.y.mul(0.13)));
    const blot = b1.mul(b2).mul(0.5).add(0.5);

    const q = vec2(fract(across.mul(0.0731)), fract(p.y.mul(0.0917)));
    const grain = fract(sin(q.x.mul(127.1).add(q.y.mul(311.7))).mul(43758.5453));

    return float(1.0)
      .sub(seam)
      .mul(float(1.0).sub(uBlotch.mul(0.5)).add(blot.mul(uBlotch)))
      .mul(float(1.0).sub(uSpeckle.mul(0.5)).add(grain.mul(uSpeckle)));
  });
}

/**
 * ── ONE MATERIAL FOR EVERYTHING THAT IS NOT THE ROAD ─────────────────────────
 *
 * Piers, lighting columns and expansion joints all run on this. They look
 * nothing alike, and they do not need to: the vertex colour carries three
 * independent channels —
 *
 *   .r  concrete shade, 0..1
 *   .g  lantern: emissive at night, and the only thing here that glows
 *   .b  joint: flat dark, no streaking
 *
 * One material is one pipeline, and in this game a pipeline is the expensive
 * unit — the first frame is spent compiling, not drawing. Three tidy materials
 * would be three compiles for three things that are collectively a few hundred
 * triangles.
 */
function pierMaterial(V, uNightU, uGlow) {
  const detail = concreteDetail(V);
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0 });
  m.name = "CityViaductParts";
  const base = uniform(new THREE.Color(V.colorPier));
  const dirt = uniform(new THREE.Color(V.colorPierDirt));
  const colu = uniform(new THREE.Color(V.colorColumn));
  const joint = uniform(new THREE.Color(V.colorJoint));
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
    const vc = vertexColor().rgb;
    // The cast surface itself, then the weather on top of it.
    const cast = base.mul(vc.r.mul(0.25).add(0.75)).mul(detail());
    const concrete = mix(cast, dirt, streak);
    // A lantern is not concrete and a joint is not weathered — both step out of
    // the streak, which is keyed to the deck above and means nothing to either.
    return mix(mix(concrete, colu, vc.g), joint, vc.b);
  })();
  /*
   * THE LIGHTS COME ON. Emissive only on the lantern channel, only at night,
   * and through the bloom MRT so the heads flare the way the street lamps do —
   * a line of hard dots along an unlit structure reads as a mistake.
   */
  const glow = Fn(() => vertexColor().rgb.g
    .mul(uNightU).mul(uGlow).mul(vec3(1.0, 0.86, 0.62)));
  m.emissiveNode = glow();
  applyBloomMRT(m, Fn(() => vec4(glow(), 1.0))());
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
  /** The world's night value, 0 day … 1 night. Drives the lantern heads. */
  uNight = null,
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
  /*
   * ── aPiece, WHICH THE ROAD MATERIAL READS AND THE SWEEP DOES NOT WRITE ─────
   *
   * `buildSweepGeometry` emits position, uv, aLateral and aZone. The per-PIECE
   * constants are stamped a level up, by the builder, for every track piece —
   * so sharing the road material without them logs "Vertex attribute aPiece not
   * found on geometry" and the shader reads zero for the whole viaduct.
   *
   *   .x is an along-offset that decorrelates the surface noise from every other
   *      run. All-zero means this road's grain lines up exactly with any track
   *      piece that also has none, which is a visible repeat where two roads
   *      meet.
   *   .y is where the start/finish line goes, and a motorway has none — that is
   *      what NO_CHECKER is for.
   */
  const stampPiece = (geo, offset) => {
    const n = geo.getAttribute("position").count;
    const d = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { d[i * 2] = offset; d[i * 2 + 1] = NO_CHECKER; }
    geo.setAttribute("aPiece", new THREE.Float32BufferAttribute(d, 2));
    return geo;
  };

  /*
   * WHICH LOCAL SIDE IS WHICH IS MEASURED, NOT ASSUMED. `computeFrames` picks
   * its own frame, so the profile's local +x is not guaranteed to point at
   * +across; dotting `right` with the across axis once settles it. Getting this
   * backwards would end the kerb on the far edge of the deck instead.
   */
  const acrossUnit = layout.axis === "x"
    ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const sideSignOf = (fr) => (fr[0].right.dot(acrossUnit) >= 0 ? 1 : -1);

  /**
   * ── A KERB THAT STOPS ──────────────────────────────────────────────────────
   *
   * Where a slip road crosses the deck, both roads were sweeping their full
   * section straight through each other, so the two red-and-white kerbs met in
   * an X across the open tarmac — a 22 cm lip diagonally over the one place a
   * car has to cross, painted as if it were a boundary.
   *
   * A kerb is two profile points per side, identifiable by zone 2 and the sign
   * of their local x, so this lowers them and repaints them as deck. Two things
   * have to happen and they are NOT the same thing:
   *
   *   · THE SHAPE, which comes from `profileAt` and so can change per station —
   *     the kerb ramps down over a few stations rather than stepping 22 cm.
   *   · THE PAINT, which comes from the REFERENCE profile's zone and cannot
   *     change per station at all (buildSweepGeometry takes shape from the
   *     morph and zone from the reference). So the red has to end at a segment
   *     boundary, which is why the deck is swept in pieces rather than in one.
   */
  const kerbLerp = (pd, localSide, k, repaint) => ({
    hw: pd.hw,
    pts: pd.pts.map((q) => (q.zone === 2 && Math.sign(q.x) === localSide
      ? { ...q, y: q.y * k, zone: repaint ? 1 : q.zone } : q)),
  });

  const runs = [{ frames: computeFrames(layout.path), rp, profile }];
  for (const rm of layout.ramps ?? []) {
    runs.push({ frames: computeFrames(rm.path), rp: rampRp, profile: rampProfile });
  }
  // A different offset per run, derived from where the run starts, so it is
  // stable across rebuilds and different between the deck and each ramp.
  const offsetFor = (fr, i) => {
    const p0 = fr[0].pos;
    const h = Math.abs(Math.sin(p0.x * 12.9898 + p0.z * 78.233 + i * 37.719) * 43758.5453);
    return (h - Math.floor(h)) * 100;
  };
  /** Along-axis coordinate of a frame, and the nearest station to a coordinate.
   *  A SEARCH, because the stations are not evenly spaced — they bunch up at
   *  every gore. Interpolating an index from the along coordinate is what the
   *  first version did, and it put the rail gaps in the wrong place the moment
   *  the path stopped being uniform. */
  const alongOfFrame = (fr, i) => (layout.axis === "x" ? fr[i].pos.x : fr[i].pos.z);
  /*
   * SEARCHED, AND ONLY OVER THE STRAIGHT.
   *
   * Two reasons, and they arrived one after the other. The stations are not
   * evenly spaced — they bunch up at every gore — so an index cannot be
   * interpolated from a coordinate. And once the deck curves away at each end,
   * the along coordinate stops being monotonic and starts REPEATING: a search
   * over the whole path happily matches a station out on a wing, which put the
   * rail gaps and the kerb ends hundreds of metres from the ramps they belong
   * to. Everything that is placed by an along coordinate belongs to the
   * straight by construction, so the search is bounded to it.
   */
  const nearestStation = (fr, a) => {
    const lo = layout.straightI0 ?? 0;
    const hi = Math.min(layout.straightI1 ?? fr.length - 1, fr.length - 1);
    let best = lo, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = Math.abs(alongOfFrame(fr, i) - a);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  const deckParts = [];
  const sweep = (fr, pd, opts, off) => stampPiece(buildSweepGeometry(fr, pd, opts), off);
  {
    const F = runs[0].frames;
    const off = offsetFor(F, 0);
    const sign = sideSignOf(F);
    const gores = (layout.ramps ?? [])
      .map((r) => ({
        i0: nearestStation(F, r.mouthMin),
        i1: nearestStation(F, r.mouthMax),
        local: r.side * sign,
      }))
      .sort((a, b) => a.i0 - b.i0);
    let cur = 0;
    for (const g of gores) {
      if (g.i0 > cur) deckParts.push(sweep(F.slice(cur, g.i0 + 1), profile, {}, off));
      const seg = F.slice(g.i0, g.i1 + 1);
      const n = seg.length - 1;
      const tf = Math.max(1, Math.min(Math.floor(n / 3), V.kerbTaper));
      // Full kerb at both ends of the gore so it meets the kerbed segments
      // either side exactly, flat across the middle where the ramp crosses.
      deckParts.push(sweep(seg, kerbLerp(profile, g.local, 0, true), {
        profileAt: (t, i) => kerbLerp(profile, g.local,
          Math.max(1 - Math.min(1, i / tf), 1 - Math.min(1, (n - i) / tf)), true),
      }, off));
      cur = g.i1;
    }
    if (cur < F.length - 1) deckParts.push(sweep(F.slice(cur), profile, {}, off));
  }
  (layout.ramps ?? []).forEach((rmp, ri) => {
    const F = runs[ri + 1].frames;
    const off = offsetFor(F, ri + 1);
    const inner = -rmp.side * sideSignOf(F);
    const k = Math.min(F.length - 2, Math.ceil(V.rampSplit * (F.length - 1)));
    const tf = Math.max(1, Math.min(Math.floor(k / 3), V.kerbTaper));
    // The inner kerb starts flat — at the mouth this edge is in the middle of
    // the deck, and a kerb there is a lip across the traffic — and rises to
    // full by the time the ramp is a road of its own.
    deckParts.push(sweep(F.slice(0, k + 1), kerbLerp(rampProfile, inner, 0, true), {
      profileAt: (t, i) => kerbLerp(rampProfile, inner,
        Math.min(1, Math.max(0, (i - (k - tf)) / tf)), true),
    }, off));
    deckParts.push(sweep(F.slice(k), rampProfile, {}, off));
  });
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
  /** {frames, rp, sides} — one call to the rail builder each. */
  const railRuns = [];
  {
    const F = runs[0].frames;
    const idxOf = (a) => nearestStation(F, a);
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
  const uNightU = uNight || uniform(0);
  const uGlow = uniform(V.columnGlow);
  const { material: pierMat, uTop } = pierMaterial(V, uNightU, uGlow);
  owned.push(pierMat);
  uTop.value = layout.deckBottom;
  let shafts = null, caps = null;
  /** Paint every vertex of `g` with the three channels the parts material
   *  reads: concrete shade, lantern, joint. See `pierMaterial`. */
  const tint = (g, r, gg, b) => {
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b; }
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    return g;
  };
  const mk = (w, h, d, y, shade) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, y, 0);
    return tint(g, shade, 0, 0);
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

  // ── Lighting columns, down the central reserve ─────────────────────────────
  let columns = null;
  if (V.columns) {
    const parts = [];
    const post = mk(0.26, V.columnHeight, 0.26, V.columnHeight * 0.5, 0.0);
    parts.push(tint(post, 0.55, 0, 0));
    for (const s2 of [-1, 1]) {
      const arm = new THREE.BoxGeometry(V.columnReach, 0.16, 0.16);
      arm.translate((s2 * V.columnReach) / 2, V.columnHeight - 0.1, 0);
      parts.push(tint(arm, 0.55, 0, 0));
      const head = new THREE.BoxGeometry(0.86, 0.16, 0.34);
      head.translate(s2 * V.columnReach, V.columnHeight - 0.2, 0);
      parts.push(tint(head, 0, 1, 0));
    }
    const geo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    const at = layout.columns;
    if (at.length) {
      columns = new THREE.InstancedMesh(geo, pierMat, at.length);
      columns.name = "CityViaductColumns";
      const m = new THREE.Matrix4(), qt = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
      at.forEach((c, i) => {
        qt.setFromAxisAngle(up, c.yaw);
        // `c.y`, not `deckY`: the tails descend, and a column that ignores that
        // stands eleven metres over a road that has already reached the ground.
        m.compose(new THREE.Vector3(c.x, c.y, c.z), qt, one);
        columns.setMatrixAt(i, m);
      });
      columns.castShadow = false;      // 300 triangles of shadow at 12 m up
      columns.receiveShadow = true;
      columns.frustumCulled = false;
      columns.instanceMatrix.needsUpdate = true;
      group.add(columns);
    } else { geo.dispose(); }
  }

  // ── Expansion joints, one per span ─────────────────────────────────────────
  let joints = null;
  if (V.joints) {
    const g0 = new THREE.BoxGeometry(V.deckWidth - roadParams.railWidth * 2, 0.02, V.jointWidth);
    g0.translate(0, 0, 0);
    const geo = tint(g0, 0, 0, 1);
    const at = layout.joints;
    if (at.length) {
      joints = new THREE.InstancedMesh(geo, pierMat, at.length);
      joints.name = "CityViaductJoints";
      const m = new THREE.Matrix4(), qt = new THREE.Quaternion();
      const up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
      at.forEach((c, i) => {
        qt.setFromAxisAngle(up, c.yaw);
        m.compose(new THREE.Vector3(c.x, c.y + V.jointLift, c.z), qt, one);
        joints.setMatrixAt(i, m);
      });
      joints.castShadow = false;
      joints.receiveShadow = false;
      joints.frustumCulled = false;
      joints.instanceMatrix.needsUpdate = true;
      group.add(joints);
    } else { geo.dispose(); }
  }

  // ── The paint ──────────────────────────────────────────────────────────────
  const markings = createRoadMarkings({
    marks: layout.marks ?? [], name: "CityViaductMarkings",
  });
  if (markings) group.add(markings.mesh);

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
      draws: 1 + (rail ? 1 : 0) + (piers ? 2 : 0) + (columns ? 1 : 0)
        + (joints ? 1 : 0) + (markings ? 1 : 0),
      columns: columns ? columns.count : 0,
      joints: joints ? joints.count : 0,
      marks: markings ? markings.stats.marks : 0,
      lengthM: Math.round(layout.pathLength ?? (layout.alongMax - layout.alongMin)),
      straightM: Math.round(layout.alongMax - layout.alongMin),
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
      if (columns) { columns.geometry.dispose(); columns.dispose(); }
      if (joints) { joints.geometry.dispose(); joints.dispose(); }
      markings?.dispose();
      for (const m of owned) m.dispose();
    },
  };
}
