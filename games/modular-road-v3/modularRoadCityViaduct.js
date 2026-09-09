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
   * PIERS SKIP THE JUNCTIONS.
   *
   * A pier on the centre line of a crossroads would sit exactly where cars
   * turn, and the viaduct would be planting columns in the middle of every
   * intersection it crosses. Real viaducts span their junctions instead, so
   * this drops any pier landing in a junction band and lets the deck carry the
   * longer span.
   */
  const oAlong = axis === "x" ? ox : oz;
  const piers = [];
  const first = Math.ceil((alongMin - oAlong) / V.spanLength);
  const last = Math.floor((alongMax - oAlong) / V.spanLength);
  for (let i = first; i <= last; i++) {
    const a = oAlong + i * V.spanLength;
    let f = (a - oAlong) % pitch;
    if (f < 0) f += pitch;
    if (f >= blockW) continue;                       // in a junction: span it
    piers.push(axis === "x" ? { x: a, z: across } : { x: across, z: a });
  }

  return {
    axis, across, alongMin, alongMax,
    deckY, deckBottom, railTop,
    path, laneAcross, piers, params: V,
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
  const frames = computeFrames(layout.path);
  const deckGeo = buildSweepGeometry(frames, profile);

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
  const railGeo = buildRailGeometry(frames, rp, railP);
  const railColGeo = buildRailCollision(frames, rp, railP);
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

  // ── The piers: one instanced unit ──────────────────────────────────────────
  const { material: pierMat, uTop } = pierMaterial(V);
  owned.push(pierMat);
  uTop.value = layout.deckBottom;
  let piers = null;
  if (layout.piers.length) {
    const colH = layout.deckBottom - V.capHeight;
    const pieces = [];
    // A tapered shaft as two stacked boxes rather than a lathe: the taper reads
    // at forty metres and beyond, and two boxes is 24 triangles against a
    // cylinder's hundreds.
    const lower = colH * 0.55;
    const mk = (w, h, d, y, shade) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(0, y, 0);
      const n = g.attributes.position.count;
      const c = new Float32Array(n * 3).fill(shade);
      g.setAttribute("color", new THREE.BufferAttribute(c, 3));
      return g;
    };
    pieces.push(mk(V.pierWidth, lower, V.pierDepth, lower * 0.5, 1.0));
    const tw = V.pierWidth * V.pierTaper, td = V.pierDepth * V.pierTaper;
    pieces.push(mk(tw, colH - lower, td, lower + (colH - lower) * 0.5, 1.0));
    const [cw, cd] = layout.axis === "x" ? [V.capDepth, V.capWidth] : [V.capWidth, V.capDepth];
    pieces.push(mk(cw, V.capHeight, cd, colH + V.capHeight * 0.5, 0.86));
    const pierGeo = mergeGeometries(pieces, false);
    for (const g of pieces) g.dispose();

    piers = new THREE.InstancedMesh(pierGeo, pierMat, layout.piers.length);
    piers.name = "CityViaductPiers";
    piers.castShadow = castShadows;
    piers.receiveShadow = true;
    piers.frustumCulled = false;
    const m = new THREE.Matrix4();
    layout.piers.forEach((p, i) => { m.makeTranslation(p.x, 0, p.z); piers.setMatrixAt(i, m); });
    piers.instanceMatrix.needsUpdate = true;
    group.add(piers);
  }

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
      draws: 1 + (rail ? 1 : 0) + (piers ? 1 : 0),
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
      if (piers) { piers.geometry.dispose(); piers.dispose(); }
      for (const m of owned) m.dispose();
    },
  };
}
