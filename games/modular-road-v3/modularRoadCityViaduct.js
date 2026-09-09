// ── THE ELEVATED URBAN MOTORWAY ──────────────────────────────────────────────
//
// A concrete viaduct running the whole width of the city, above one street.
//
// ── WHY THIS ONE, OUT OF EVERYTHING LEFT ─────────────────────────────────────
//
// Every other thing in the city sits ON the ground plane. Facades, signals,
// signs, markings, traffic, clutter — all of it is street level, and a city
// where nothing is ever overhead reads flat however much detail goes into the
// walls. A viaduct is the only structure that puts something between the player
// and the sky at street level, and the only one you both drive UNDER and see
// traffic moving along ABOVE you.
//
// ── WHAT IT COSTS: TWO DRAWS ─────────────────────────────────────────────────
//
// The DECK is one merged mesh for the entire run — slab, both parapets, the
// whole 2.4 km. It is about sixty triangles, so there is nothing to gain by
// splitting it for culling and something to lose: a chain of instanced spans
// would be one draw too, but with a visible seam wherever two segments met and
// a per-instance matrix to upload. One mesh has no seams because there are no
// joins.
//
// The PIERS are one InstancedMesh — column and hammerhead cap merged into a
// single unit — so the count does not matter. Around fifty-five of them.
//
// The traffic on it costs NOTHING extra at all: see the note on lanes below.
//
// ── THE ONE HEIGHT CONSTRAINT, AND IT IS LOAD-BEARING ────────────────────────
//
// Skybridges cross between towers of at least `bridgeMinHeight` (45 m) at a
// fraction of the shorter one starting at `bridgeLow` (0.35). So the lowest
// skybridge in any city this can generate is at 15.75 m, and as long as the
// TOP OF THE PARAPET stays below that, a skybridge can never intersect the
// viaduct — with no coupling between the two modules, no exclusion test, and
// no ordering constraint on which is built first. viaductTest checks the
// arithmetic still holds, because the alternative is a bridge through a road
// that nobody notices until they drive under it.

import * as THREE from "three";
import { Fn, float, vec3, vec4, uniform, mix, smoothstep, abs, positionWorld, vertexColor } from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const VIADUCT_DEFAULTS = {
  /** Off and nothing is built. */
  viaduct: true,
  /** Which way it runs. The cross streets pass underneath it. */
  viaductAxis: "x",
  /** How many block pitches off the city centre, so it does not sit on top of
   *  whatever is in the middle. Signed. */
  viaductOffset: 2,

  /** The deck, metres. Four lanes, shoulders, and a central reserve. */
  deckWidth: 19,
  deckThickness: 1.5,
  parapetHeight: 1.1,
  parapetThickness: 0.42,
  /**
   * Underside of the deck above the street.
   *
   * Tall enough to drive under without it feeling like a hazard, and low
   * enough that the parapet top stays under the lowest possible skybridge —
   * see the header. 10.5 + 1.5 + 1.1 = 13.1 against 15.75.
   */
  clearance: 10.5,

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

  /** Traffic. A motorway is busier and faster than the streets under it. */
  viaductTraffic: true,
  viaductCars: 26,
  viaductSpeed: 1.55,

  colorDeck: 0x9d9c95,
  colorParapet: 0xb0aea6,
  colorPier: 0x8c8b84,
  /** The parapet's edge line, lit at night. A dark viaduct over a lit street
   *  reads as a mistake rather than as a structure. */
  edgeGlow: 1.5,
};

/** Vertex-colour keys for the three parts, so one material serves all of them. */
const PART = { deck: 0, parapet: 1, pier: 2 };
const PART_COLOR = [
  new THREE.Color(1, 0, 0), new THREE.Color(0, 1, 0), new THREE.Color(0, 0, 1),
];

function tag(geo, part) {
  const n = geo.attributes.position.count;
  const c = new Float32Array(n * 3);
  const col = PART_COLOR[part];
  for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  geo.setAttribute("color", new THREE.BufferAttribute(c, 3));
  return geo;
}

function box(w, h, d, x, y, z, part) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tag(g, part);
}

/**
 * ── WHERE THE VIADUCT IS ─────────────────────────────────────────────────────
 *
 * PURE, and separate from the geometry on purpose: the traffic system needs the
 * same answer, and the only way two systems agree about a structure is if they
 * ask one function rather than each deriving it. It is the same discipline the
 * lane table is under (see `laneTravelDir` in modularRoadCityFurniture.js), for
 * the same reason.
 *
 * Returns null when the chosen street falls outside the city.
 *
 * @returns {null | {
 *   axis: "x"|"z", across: number, alongMin: number, alongMax: number,
 *   deckBottom: number, deckTop: number, railTop: number,
 *   laneAcross: number[], piers: {x: number, z: number}[],
 * }}
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

  const deckBottom = P.groundY + V.clearance;
  const deckTop = deckBottom + V.deckThickness;
  const railTop = deckTop + V.parapetHeight;

  // Lane centres across the deck: two each side of a central reserve.
  const laneAcross = [-0.34, -0.13, 0.13, 0.34].map((f) => across + f * V.deckWidth);

  const alongMin = cAlong - half, alongMax = cAlong + half;

  /*
   * PIERS SKIP THE JUNCTIONS.
   *
   * A pier on the centre line of a crossroads would sit exactly where cars
   * turn, and the viaduct would be planting columns in the middle of every
   * intersection it crosses. Real viaducts span their junctions instead, so
   * this drops any pier landing in a junction band and lets the deck — which
   * is one continuous mesh and does not care — carry the longer span.
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

  return { axis, across, alongMin, alongMax, deckBottom, deckTop, railTop, laneAcross, piers, params: V };
}

/**
 * Build the viaduct. Two draws.
 *
 * @param {object} opts
 * @param {ReturnType<typeof viaductLayout>} opts.layout
 * @param {object} [opts.uNight]  the city's night uniform, for the edge line
 */
export function createCityViaduct({ layout, uNight = null, castShadows = true }) {
  if (!layout) return null;
  const V = layout.params;
  const group = new THREE.Group();
  group.name = "CityViaduct";

  const alongLen = layout.alongMax - layout.alongMin;
  const alongMid = (layout.alongMin + layout.alongMax) * 0.5;
  const xz = (along, across) => (layout.axis === "x" ? [along, across] : [across, along]);

  // ── Material: one, for all three parts ──────────────────────────────────────
  const uNightU = uNight || uniform(0);
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.0 });
  mat.name = "CityViaduct";
  const cDeck = uniform(new THREE.Color(V.colorDeck));
  const cRail = uniform(new THREE.Color(V.colorParapet));
  const cPier = uniform(new THREE.Color(V.colorPier));
  const uGlow = uniform(V.edgeGlow);
  const uRailTop = uniform(layout.railTop);

  /** `vertexColor()` is a vec4 — the alpha is not a part id and never was. */
  const partOf = () => vertexColor().rgb;

  mat.colorNode = Fn(() => {
    const p = partOf();
    const base = cDeck.mul(p.r).add(cRail.mul(p.g)).add(cPier.mul(p.b)).toVar();
    /*
     * Concrete streaks DOWNWARD, and on a structure this size that is most of
     * what sells it as concrete rather than as grey plastic. Rain runs off the
     * deck edge and stains the fascia and the pier tops, so the dirt is keyed
     * to distance BELOW the deck rather than to height above the ground.
     */
    const below = uRailTop.sub(positionWorld.y).toVar();
    const streak = smoothstep(float(0.0), float(3.2), below)
      .mul(smoothstep(float(11.0), float(4.0), below)).mul(0.22);
    return mix(base, vec3(0.30, 0.29, 0.27), streak);
  })();

  mat.roughnessNode = float(0.86);
  /*
   * THE EDGE LINE. A strip of emissive along the very top of the parapet, on
   * at night only. It is not a lamp — there is no light cast and no draw — it
   * is the structure drawing its own silhouette, which is what actually reads
   * from the road below at night. Costs one smoothstep.
   */
  const edge = Fn(() => {
    const p = partOf();
    const nearTop = smoothstep(float(0.18), float(0.02), abs(uRailTop.sub(positionWorld.y)));
    return vec3(1.0, 0.72, 0.42).mul(nearTop).mul(p.g).mul(uNightU).mul(uGlow);
  });
  mat.emissiveNode = edge();
  // vec4, not vec3: the MRT attachment is a vec4 struct member and WGSL will
  // not widen an assignment. A vec3 here is an invalid ShaderModule and a
  // viaduct that silently never draws.
  applyBloomMRT(mat, Fn(() => vec4(edge(), 1.0))());

  // ── The deck: ONE mesh, the whole run ──────────────────────────────────────
  const parts = [];
  const dY = layout.deckBottom + V.deckThickness * 0.5;
  {
    const [w, d] = layout.axis === "x" ? [alongLen, V.deckWidth] : [V.deckWidth, alongLen];
    const [x, z] = xz(alongMid, layout.across);
    parts.push(box(w, V.deckThickness, d, x, dY, z, PART.deck));
  }
  // Parapets, one each side, plus a central reserve barrier.
  const rY = layout.deckTop + V.parapetHeight * 0.5;
  for (const off of [-0.5, 0.5]) {
    const across = layout.across + off * (V.deckWidth - V.parapetThickness);
    const [w, d] = layout.axis === "x" ? [alongLen, V.parapetThickness] : [V.parapetThickness, alongLen];
    const [x, z] = xz(alongMid, across);
    parts.push(box(w, V.parapetHeight, d, x, rY, z, PART.parapet));
  }
  {
    // The central reserve is lower — it is a barrier, not a wall, and a full
    // parapet up the middle would hide the oncoming traffic that is half the
    // point of putting cars up here.
    const h = V.parapetHeight * 0.62;
    const [w, d] = layout.axis === "x" ? [alongLen, V.parapetThickness * 1.3] : [V.parapetThickness * 1.3, alongLen];
    const [x, z] = xz(alongMid, layout.across);
    parts.push(box(w, h, d, x, layout.deckTop + h * 0.5, z, PART.parapet));
  }
  const deckGeo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  const deck = new THREE.Mesh(deckGeo, mat);
  deck.name = "CityViaductDeck";
  deck.castShadow = castShadows;
  deck.receiveShadow = true;
  // One mesh spanning the city: there is no camera position from which culling
  // it is correct, and at ~60 triangles there is nothing to gain by trying.
  deck.frustumCulled = false;
  group.add(deck);

  // ── The piers: one instanced unit ──────────────────────────────────────────
  let pierMesh = null;
  if (layout.piers.length) {
    const colH = layout.deckBottom - V.capHeight;
    const pieces = [];
    // A tapered shaft, as two stacked boxes rather than a lathe: the taper is
    // read at 40 m and beyond, and two boxes is 24 triangles against a
    // cylinder's hundreds.
    const lower = colH * 0.55;
    pieces.push(box(V.pierWidth, lower, V.pierDepth, 0, lower * 0.5, 0, PART.pier));
    const tw = V.pierWidth * V.pierTaper, td = V.pierDepth * V.pierTaper;
    pieces.push(box(tw, colH - lower, td, 0, lower + (colH - lower) * 0.5, 0, PART.pier));
    // The hammerhead, across the deck.
    const [cw, cd] = layout.axis === "x" ? [V.capDepth, V.capWidth] : [V.capWidth, V.capDepth];
    pieces.push(box(cw, V.capHeight, cd, 0, colH + V.capHeight * 0.5, 0, PART.pier));
    const pierGeo = mergeGeometries(pieces, false);
    for (const g of pieces) g.dispose();

    pierMesh = new THREE.InstancedMesh(pierGeo, mat, layout.piers.length);
    pierMesh.name = "CityViaductPiers";
    pierMesh.castShadow = castShadows;
    pierMesh.receiveShadow = true;
    pierMesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    layout.piers.forEach((p, i) => {
      m.makeTranslation(p.x, 0, p.z);
      pierMesh.setMatrixAt(i, m);
    });
    pierMesh.instanceMatrix.needsUpdate = true;
    group.add(pierMesh);
  }

  return {
    group,
    layout,
    stats: { piers: layout.piers.length, draws: pierMesh ? 2 : 1, lengthM: Math.round(alongLen) },
    dispose() {
      deckGeo.dispose();
      if (pierMesh) { pierMesh.geometry.dispose(); pierMesh.dispose(); }
      mat.dispose();
    },
  };
}
