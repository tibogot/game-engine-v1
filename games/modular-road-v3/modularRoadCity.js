// ============================================================================
// CITY — layout, batching and LOD for the skyline the track flies through.
//
// One material (modularRoadCityFacade.js), a handful of shared archetype
// geometries (modularRoadCityKit.js), N transforms, plus the signage
// (modularRoadCitySigns.js) and the aviation beacons. This file decides WHERE
// everything goes and HOW it reaches the GPU.
//
// ── TWO BACKENDS — AND THE MEASUREMENT THAT PICKED ONE ───────────────────────
//
// INSTANCED IS THE DEFAULT, and the reason is not the one you would expect.
//
// BatchedMesh is advertised as collapsing a whole batch into ONE draw call.
// That is a WebGL2 property, not a WebGPU one: it rides on the
// `WEBGL_multi_draw` extension (see the check in three.webgpu.js). WebGPU has
// no multi-draw in the base spec, so the WebGPU backend issues ONE DRAW PER
// VISIBLE INSTANCE. Measured in city-lab, 2411 buildings, deck viewpoint:
//
//   backend                draws    GPU        triangles
//   instanced, no shadows     34    0.47 ms    60k
//   batched,   no shadows   1150    0.69 ms    26k
//   city off (baseline)        5    0.22 ms     1k
//
// In the GAME, build camera over downtown on terrain: city OFF 3.92 ms →
// city ON 2.69 ms. Cheaper WITH the city — towers occlude the fragment-bound
// terrain. Batched is kept as the runtime control (B in the lab).
//
// ── SHADOWS ──────────────────────────────────────────────────────────────────
//
// ON by default now: tower-on-tower and tower-on-street shadows are the
// biggest depth cue a city has, and they are most of why three's example reads
// as solid rather than as painted boxes. Only the L0 tier ever casts, and only
// on the instanced backend (castShadow is per mesh; BatchedMesh cannot gate per
// tier). The engine fits its shadow camera to the VIEW, so the city does not
// inflate a cascade.
//
// Those are the shadows one building throws on another. The shadows a building
// throws ON ITSELF — a pier onto its own spandrel, a window head onto its own
// glass — are analytic, in the facade shader, and cost no map at all.
//
// ── LAYOUT: THE GLOBAL LOT GRID ──────────────────────────────────────────────
//
// One building per LOT CELL of the global grid `floor(worldXZ / lotSize)` —
// the cells the facade hashes and reads the lot texture by. Streets are an
// INTEGER number of cells (`streetLots`), never a metre width: a 22 m street
// between 34 m lots drifts every second block off the cell grid, and a tower
// straddling two cells changes tint halfway up.
//
// ── EVERY LOT ROLLS ITS OWN DICE ─────────────────────────────────────────────
//
// Each lot gets an RNG seeded from (seed, cellX, cellZ) and draws ALL of its
// numbers before any test decides whether it is built. So removing a lot —
// the track corridor, a slope cull, a density change — leaves every other
// building exactly where it was. That is what lets the player BUILD THE TRACK
// AROUND THE CITY: placing a piece clears the lots under it and nothing else
// moves. tools/cityKitTest.mjs guards it.
//
// ── DISTRICTS AND LANDMARKS ──────────────────────────────────────────────────
//
// Distance from downtown (plus noise) picks a district — glass core, masonry
// midtown, low industrial fringe — and writes it to the lot texture's B
// channel, where the facade reads it for wall style and window proportions.
// The three tallest "landmark" archetypes are placed by a post-pass on the
// lots nearest the centre, so the skyline has a silhouette rather than a hump.
//
// ── TERRAIN ──────────────────────────────────────────────────────────────────
//
// `heightAt(x, z)` is the game's ground sampler. Each lot samples its footprint
// corners: base = LOWEST corner minus a sink; a lot spanning more than
// `slopeLimit` is skipped (no towers on cliffs). The heightmap is never
// written. Base and top go into the lot texture (R, G).
// ============================================================================
import * as THREE from "three";
import {
  Fn, vec3, vec4, uniform, positionWorld, fract, abs, max, smoothstep, mix, fwidth,
  floor, dot, sin, vec2, step,
} from "three/tsl";
import { buildCityKit, disposeCityKit, mulberry32 } from "./modularRoadCityKit.js";
import { createCityFacadeMaterial, LOT_TEX_SIZE, DISTRICT, BUILDING_TYPE } from "./modularRoadCityFacade.js";
import {
  createCityViaduct, viaductLayout, viaductKeepOut, viaductFootprint,
} from "./modularRoadCityViaduct.js";
import {
  createCityUnderpass, underpassLayout, underpassOpenAt, underpassFootprint,
  underpassRoofAt, underpassDip,
} from "./modularRoadCityUnderpass.js";
import { createCitySigns, loadHeroAdFolder } from "./modularRoadCitySigns.js";
import { placeCityPrism, pickPrismPlaza, CITY_PRISM_DEFAULTS } from "./modularRoadCityPrism.js";
import { planCarParks, buildCarParkGround, CARPARK_DEFAULTS } from "./modularRoadCityCarPark.js";
import { planParks, buildParkGround, PARK_DEFAULTS } from "./modularRoadCityPark.js";
import { placeCityBridges, BRIDGE_DEFAULTS } from "./modularRoadCityBridges.js";
import { createCityStreets, STREET_DEFAULTS } from "./modularRoadCityStreets.js";
import { createCityFurniture } from "./modularRoadCityFurniture.js";
import { createCityCollider } from "./modularRoadCityCollider.js";
import { createCityObstacles } from "./modularRoadCityObstacles.js";
import { createCityKnockables } from "./modularRoadCityKnockables.js";
import { createCityRoofs } from "./modularRoadCityRoofs.js";
import { createLodView } from "./modularRoadCityLodView.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";

export const CITY_DEFAULTS = {
  /** Half-extent of the built area, metres. 1200 = a 2.4 km city. */
  extent: 1200,
  /** Lot pitch. The facade hashes this same grid. */
  lotSize: 34,
  /** Lots per block edge, and street width IN LOTS between blocks. */
  blockLots: 4,
  streetLots: 1,
  /** Chance a lot gets a building at all. Gaps read as yards, plazas, car parks. */
  density: 0.86,

  /** Downtown: heights bias toward this point, falling off over `extent`. */
  centerX: 0,
  centerZ: 0,
  downtownPower: 2.2,
  heightNoise: 0.55,

  /** Districts, as fractions of `extent` from the centre: glass inside
   *  `districtCore`, masonry out to `districtMid`, industrial beyond. Noise
   *  breaks the rings so the boundary is not a circle. */
  districtCore: 0.50,
  districtMid: 0.88,
  districtNoise: 0.22,
  /** Landmark archetypes go on the lots nearest the centre, within this radius. */
  landmarkRadius: 200,

  /** BUILDING TYPE MIX. The wall rhythm, not the palette — see BUILDING_TYPE.
   *  Downtown is mostly curtain wall; midtown is mostly punched masonry with
   *  some 60s ribbon slabs; anything short or industrial is always punched,
   *  because a curtain wall on a four-storey shed reads as a mistake. */
  typeMinHeight: 22,
  curtainInCore: 0.70,
  ribbonInCore: 0.16,
  curtainInMid: 0.38,
  ribbonInMid: 0.24,

  /** Per-instance Y-scale range. X and Z are NEVER scaled.
   *  Kept narrow on purpose: stretching a 30 m footprint to 400 m gives a
   *  13:1 pencil, and a skyline of pencils is what the first pass looked
   *  like. Real supertalls top out near 10:1. */
  scaleYMin: 0.8,
  scaleYMax: 1.22,

  /** Keep-out corridor half-width around whatever `avoid` describes, metres. */
  avoidRadius: 40,

  /** PLAZAS. Whole blocks left unbuilt, rolled per block — a square rather
   *  than a gap. `plazaMaxR` keeps them off the fringe, where an empty block
   *  is a field rather than a place. Cheaper than the block they replace. */
  plazas: true,
  plazaChance: 0.05,
  plazaMaxR: 0.62,

  /** World half-size the city may occupy (the terrain's edge). */
  bounds: Infinity,
  boundsMargin: 80,

  /** Terrain fit. */
  slopeLimit: 6,
  sinkBias: 0.6,

  /** LOD ring radii, metres, with hysteresis and a recompute throttle. */
  lod0Dist: 220,
  /**
   * WAS 850, and 850 was paying for detail nobody could see.
   *
   * MEASURED in road.html (interleaved A/B, five 2 s rounds each, medians, at
   * pixel ratio 2.0 so the frame is GPU-bound rather than vsync-locked):
   *
   *   450   20.0 ms      850   21.5 ms      1400   22.0 ms
   *
   * — so the ring was costing 1.5 ms of a 21.5 ms frame in the WORST case, an
   * elevated view with the whole city in shot. And it buys nothing: at 450 the
   * L1 population drops 342 → 88 in a wide street view and 821 → 290 at street
   * level, and both frames are indistinguishable from the 850 ones. At 850 m a
   * tower is a few hundred pixels tall; L2's massing box already carries its
   * silhouette and the cheap facade already carries its window grid, and the
   * bay relief L1 adds on top of that is far under a pixel.
   *
   * The two shader knobs tested alongside it — `lodRelief` and `interior` —
   * came back as EXACT NULLS: 67 frames / 2 s at 0.04, 0.09, 0.18, and 67
   * again with relief and interior switched off entirely. The facade's
   * screen-space work is not what the frame is spending its time on, so those
   * two stay where they are and stay at full quality.
   */
  lod1Dist: 450,
  lodHysteresis: 30,
  lodInterval: 0.2,
  lodMoveDist: 12,
  /**
   * PER-INSTANCE FRUSTUM CULL, on the same tick. Every mesh here is
   * `frustumCulled = false` (each spans the whole city), so nothing was
   * culled at all: at street level two thirds of everything in range was
   * behind or beside the camera and still went through the vertex stage.
   * See modularRoadCityLodView.js for what is exempt and why.
   *
   * `lodMargin` pads the test so a pan has something to pan into before the
   * next tick; `lodTurnAngle` (degrees) makes a heading change fire the tick
   * the way a 12 m move does, so the padding only has to cover ONE frame of
   * turning rather than 200 ms of it.
   */
  lodMargin: 35,
  lodTurnAngle: 6,
  /** Pack each tier mesh near-first so early-Z rejects hidden facade
   *  fragments. A runtime switch so it can be MEASURED — off restores layout
   *  order, which is what it drew in before. */
  lodSort: true,

  /** SHADOWS ON. Tower-on-tower and tower-on-street is the single biggest
   *  depth cue the city has, it is what makes three's example read as solid,
   *  and measured here it costs ~0.04 ms because only the L0 tier casts. */
  castShadows: true,

  /** Streets + sidewalk ground plane — flat ground only (with terrain on, the
   *  terrain IS the ground and this is skipped). One draw; see
   *  modularRoadCityStreets.js for why it is a material and not Smart Road. */
  /** Rooftop plant, tanks, stacks and dishes. Four instanced draws, hard
   *  distance-culled — and unlike the street, roofs are what a SKY TRACK
   *  actually looks at. See modularRoadCityRoofs.js. */
  roofs: true,
  roofParams: {},

  ground: true,
  groundY: 0,
  streetParams: {},
  /** Lamp posts, traffic lights, tree trunks, parked cars and the crossing
   *  guardrail, as capsules the car can hit. See modularRoadCityObstacles.js
   *  for why capsules and not triangles. */
  obstacleParams: {},
  /** Parked cars, pavement trees, traffic lights, crossing guardrails — five
   *  instanced draws on the same grid. Flat ground only, like the streets. */
  furniture: true,
  furnitureParams: {},

  /** Signage: HERO ADVERTS only by default — few, building-scale, street-
   *  facing, framed, lit, and each a slot for a REAL image
   *  (`city.signs.loadHeroImage(slot, url)`). The old procedural layers
   *  (banners, LED bands, marquees, neon) are still in the module behind
   *  fractions that default to 0 — see modularRoadCitySigns.js. */
  signs: true,
  signParams: {},
  /** ONE trivision board on a downtown roof — a landmark, not a class of
   *  signage. Four draws and no per-frame CPU; off and the prop is never
   *  built. See modularRoadCityPrism.js. */
  prism: true,
  prismParams: {},
  /** Glazed links thrown across a street between two towers. One draw; a
   *  handful of them in a city. See modularRoadCityBridges.js. */
  bridges: true,
  bridgeParams: {},
  /**
   * THE ELEVATED MOTORWAY. Everything else in the city is on the ground plane,
   * and a city with nothing ever overhead reads flat however good the walls
   * are. Two draws, and its traffic is free — see the lane note in
   * modularRoadCityFurniture.js.
   */
  viaduct: true,
  viaductParams: {},
  /**
   * THE UNDERPASS. A road that dips under the city and comes back up — the one
   * structure that uses the space BELOW the ground plane, which until now was
   * simply not a place. See modularRoadCityUnderpass.js.
   */
  underpass: true,
  underpassParams: {},
  /** Some of the squares become surface car parks — painted bays and cars
   *  standing in them. One draw for the paint, none for the cars. */
  carParks: true,
  carParkParams: {},
  /** And some become parks — grass, gravel paths, trees and benches. One draw
   *  for the ground, none for the trees. See modularRoadCityPark.js. */
  parks: true,
  parkParams: {},
  beacons: true,
  beaconColor: 0xff2a1a,

  /** 'batched' | 'instanced'. Instanced by default — see the header. */
  backend: "instanced",
  /**
   * Compile the facade once PER BUILDING TYPE instead of once for all three.
   *
   * OFF, and the measurement is why. Pinning the type does shrink each shader
   * — punched 4435, curtain and ribbon 3311 lines against 4833 combined — but
   * the city draws all three types at once, so the driver compiles all three
   * pipelines rather than one. Per-pipeline size is what buys occupancy at
   * RUN time; total emitted code is what the ~29 s first-frame compile pays.
   * This trade moves 200 kB of compile to 466 kB to save register pressure,
   * and until that shows up as GPU ms it is the wrong side of the trade.
   *
   * Kept wired, off, so it is one flag to A/B rather than a rewrite to redo.
   */
  facadeTypeSplit: false,
  perObjectFrustumCulled: true,
  sortObjects: false,
};

/**
 * Aviation beacons: one small emissive octahedron per mast tip, blinking on
 * its own phase, brighter at night. One InstancedMesh, one draw. The phase is
 * a hash of the beacon's own world position, so no attribute is needed.
 */
function createBeacons(list, P, uTime, uNight) {
  if (!list.length) return null;
  const geo = new THREE.OctahedronGeometry(0.7, 0);
  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "CityBeacon";
  const uColor = uniform(new THREE.Color(P.beaconColor));
  const col = Fn(() => {
    const cellId = floor(positionWorld.xz.div(6.0));
    const phase = fract(sin(dot(cellId, vec2(127.1, 311.7))).mul(43758.5453));
    const blink = step(0.55, fract(uTime.mul(0.9).add(phase)));
    const level = mix(0.8, 6.0, uNight);
    return uColor.mul(blink.mul(level).add(0.08));
  })();
  mat.colorNode = vec4(col, 1.0);
  applyBloomMRT(mat, vec4(col, 1.0));
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  im.name = "CityBeacons";
  im.frustumCulled = false;
  const m = new THREE.Matrix4();
  list.forEach((p, i) => im.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  im.instanceMatrix.needsUpdate = true;
  return im;
}

/**
 * @param {object}   [opts]
 * @param {number}   [opts.seed]
 * @param {object}   [opts.params]       overrides on CITY_DEFAULTS
 * @param {object}   [opts.facadeParams] overrides on FACADE_DEFAULTS
 * @param {object}   [opts.kitParams]    overrides on KIT_DEFAULTS
 * @param {(x:number,z:number)=>number} [opts.avoid]    keep-out distance query
 * @param {(x:number,z:number)=>number} [opts.heightAt] ground sampler, null = flat
 * @param {THREE.Texture} [opts.reflectionTexture] the game's car-reflection
 *   target. Handing it in makes the wet street mirror the car — no second
 *   pass, because the road already renders one and, when the car is on the
 *   street, its mirror plane IS the street. Omit it and the street is built
 *   with no reflection code at all.
 */
export function createModularRoadCity({
  seed = 20260902,
  params = {},
  facadeParams = {},
  kitParams = {},
  avoid = null,
  heightAt = null,
  /** Called with the rain-collider surfaces after EVERY build, including
   *  the first. See `rainSurfaces` for why it is told rather than asked. */
  onRebuilt = null,
  reflectionTexture = null,
  /**
   * The engine's tree environment (app.treeEnv from startV3App).
   *
   * Handed in rather than imported because the city is a GAME system and the
   * tree stack is the ENGINE's — the city publishes placements into it, it does
   * not own it. Without one, furniture falls back to its procedural tree, so a
   * headless build or a host with no tree stack still works.
   */
  treeEnv = null,
  /**
   * The GAME'S road and guardrail materials, for the viaduct.
   *
   * Handed in rather than made here for two reasons, and the second is the one
   * that matters: the viaduct then reads as the same road as the track, and it
   * costs NO shader compile, because both materials are already built and
   * compiled by the time the city exists.
   */
  viaductMaterials = null,
} = {}) {
  const P = { ...CITY_DEFAULTS, ...params };

  const group = new THREE.Group();
  group.name = "City";

  const facade = createCityFacadeMaterial({
    typeSplit: P.facadeTypeSplit === true,
    params: { lotSize: P.lotSize, groundY: P.groundY, ...facadeParams },
  });

  let kit = buildCityKit({ seed, params: kitParams });

  let ground = null;
  let furniture = null;
  /** Rooftop clutter. Unlike the streets it does NOT need flat ground — it
   *  rides the buildings, which exist with terrain on or off. */
  let roofs = null;
  /** Street furniture you can hit. Null with no ground plane, same as the rest. */
  let obstacles = null;
  /** Guardrails currently being thrown, and the pool that throws them. */
  let knockables = null;
  /** Set when the city builds — see buildingClearance on the handle. */
  let clearanceAt = null;
  /** Buildings you cannot drive through. Built lazily — a city that is never
   *  collided against never pays for the trees. */
  let collider = null;
  /** Last wetness the game pushed — survives a ground rebuild. */
  let wetAmount = 0;
  let buildings = [];
  let batched = null, batchGeomIds = null, batchInstIds = null;
  let instanced = null;
  let signs = null;
  let prism = null;
  let bridges = null;
  let viaduct = null;
  /** The pure layout, shared by the geometry and the traffic. */
  let viaductAt = null;
  /** Where a ramp is overhead, so nothing tall is placed under it. */
  let viaductClear = null;
  /** Where the DECK is overhead, so no tower is built into it. */
  let viaductUnder = null;
  let underpass = null;
  /** The pure layout, shared by the geometry, the collision and the hole. */
  let underAt = null;
  /** True over an OPEN trench — where the street plane has to stop existing,
   *  both to the eye and to the vehicle. */
  let underOpen = null;
  /** The whole run, for keeping street furniture off it. */
  let underUnder = null;
  let underRoof = null;
  let carParkGround = null;
  let carParks = [];
  let parkGround = null;
  let parks = [];
  let beacons = null;
  let enabled = true;
  let originCellX = 0, originCellZ = 0;
  const uTime = uniform(0);
  const uNight = uniform(0);
  let _clock = 0;

  const stats = {
    buildings: 0, lod: [0, 0, 0], meshes: 0, kit: kit.stats,
    lastLodMs: 0, lastBuildMs: 0,
    culledCorridor: 0, culledSlope: 0, culledBounds: 0, culledPlaza: 0, culledViaduct: 0, underpass: null, plazas: 0, plazaList: [], bridges: 0, bridgeSpans: [], viaduct: null, carParks: 0, parkedInParks: 0, carParkList: [], parks: 0, parkList: [],
    lotTexCells: [0, 0], landmarks: 0, beacons: 0,
    signs: { banners: 0, screens: 0, bands: 0 },
    districts: [0, 0, 0],
  };

  // ── Per-lot RNG ────────────────────────────────────────────────────────────
  function lotRng(cx, cz) {
    const h = (seed ^ Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cz | 0, 0x165667b1)) >>> 0;
    return mulberry32(h);
  }
  /** A single deterministic draw for (lot, purpose k) — the signs use it. */
  function lotRand(cx, cz, k) {
    const h = (seed ^ Math.imul(cx | 0, 0x27d4eb2d) ^ Math.imul(cz | 0, 0x165667b1) ^ Math.imul(k | 0, 0x85ebca6b)) >>> 0;
    return mulberry32(h)();
  }
  /**
   * A single draw for (BLOCK, purpose k). Blocks, not lots, because a plaza is
   * a whole city block and rolling it per lot would give holes in a block
   * rather than a square. Keyed the same way as `lotRand`, so it inherits the
   * property everything here depends on: the answer for one block cannot be
   * changed by anything that happens in another.
   */
  function blockRand(bx, bz, k) {
    const h = (seed ^ Math.imul(bx | 0, 0x2545f491) ^ Math.imul(bz | 0, 0x9e3779b1) ^ Math.imul(k | 0, 0xc2b2ae35)) >>> 0;
    return mulberry32(h)();
  }
  const pmod = (a, n) => ((a % n) + n) % n;

  // ── Layout ─────────────────────────────────────────────────────────────────
  function layout() {
    const out = [];
    const L = P.lotSize;
    const pitch = P.blockLots + P.streetLots;
    originCellX = Math.floor(P.centerX / L);
    originCellZ = Math.floor(P.centerZ / L);

    const extent = Number.isFinite(P.bounds)
      ? Math.min(P.extent, Math.max(0, P.bounds - P.boundsMargin))
      : P.extent;
    stats.extent = extent;

    const cellsHalf = Math.ceil(extent / L) + 1;
    const minCx = originCellX - cellsHalf, minCz = originCellZ - cellsHalf;
    const countX = Math.min(cellsHalf * 2 + 1, LOT_TEX_SIZE);
    const countZ = Math.min(cellsHalf * 2 + 1, LOT_TEX_SIZE);
    if (cellsHalf * 2 + 1 > LOT_TEX_SIZE) {
      console.warn(`[City] extent ${extent} m needs ${cellsHalf * 2 + 1} lot cells; lot texture holds ${LOT_TEX_SIZE}.`);
    }
    facade.lotHeights.clear(P.groundY);
    facade.lotHeights.setOrigin(minCx, minCz, countX, countZ);
    stats.lotTexCells = [countX, countZ];
    // The window's ORIGIN as well as its size. Without it the lot texture is
    // un-relocatable: the data alone says nothing about which cell index 0 is,
    // so nothing outside this function can stand a second facade on this city.
    stats.lotTexOrigin = [minCx, minCz];

    // Landmarks sort to the end of the kit; the ordinary pick excludes them.
    const normalCount = kit.archetypes.length - (kit.stats.landmarks ?? 0);

    let culledViaduct = 0;
  let culledCorridor = 0, culledSlope = 0, culledBounds = 0, culledPlaza = 0;
    const plazaList = [], plazaSeen = new Set();
    const districts = [0, 0, 0];
    const types = [0, 0, 0];
    const foot = L * 0.42;

    for (let cx = originCellX - cellsHalf; cx <= originCellX + cellsHalf; cx++) {
      if (pmod(cx - originCellX, pitch) >= P.blockLots) continue;
      for (let cz = originCellZ - cellsHalf; cz <= originCellZ + cellsHalf; cz++) {
        if (pmod(cz - originCellZ, pitch) >= P.blockLots) continue;

        const x = (cx + 0.5) * L;
        const z = (cz + 0.5) * L;
        const dx = x - P.centerX, dz = z - P.centerZ;
        const r = Math.hypot(dx, dz);
        if (r > extent) continue;
        if (Number.isFinite(P.bounds)
          && (Math.abs(x) > P.bounds - P.boundsMargin || Math.abs(z) > P.bounds - P.boundsMargin)) {
          culledBounds++;
          continue;
        }

        // ALL the dice, before any test — see the header.
        const rnd = lotRng(cx, cz);
        const rDensity = rnd();
        const rHeight = rnd();
        const rScale = rnd();
        const rDistrict = rnd();
        const rType = rnd();

        if (rDensity > P.density) continue;
        /*
         * ── A PLAZA: ONE WHOLE BLOCK LEFT UNBUILT ────────────────────────
         *
         * Every block in this city is the same size, which is most of why a
         * grid reads as generated rather than as a place. One square breaks
         * that for almost nothing — and it costs LESS than the block it
         * replaces, because the buildings simply are not built.
         *
         * It needs no paving of its own: the street shader already draws the
         * walk surface across a whole block and only stops for a building, so
         * an empty block comes out as a paved square for free.
         *
         * ROLLED PER BLOCK, NOT PER LOT. A per-lot roll at the same rate
         * gives scattered holes in a block, which reads as a bug; the point
         * of a plaza is that it is the whole block.
         *
         * And not out on the fringe, where an empty block is just a field —
         * measured from the BLOCK'S centre, not this lot's. Testing the lot's
         * own radius let a plaza that straddles the limit empty the lots
         * inside it and keep the ones outside, which is precisely the ragged
         * half-block this whole decision exists to avoid.
         */
        if (P.plazas) {
          const bx = Math.floor((cx - originCellX) / pitch);
          const bz = Math.floor((cz - originCellZ) / pitch);
          const bcx = (originCellX + bx * pitch + (P.blockLots - 1) * 0.5 + 0.5) * L - P.centerX;
          const bcz = (originCellZ + bz * pitch + (P.blockLots - 1) * 0.5 + 0.5) * L - P.centerZ;
          if (Math.hypot(bcx, bcz) < extent * P.plazaMaxR
            && blockRand(bx, bz, 31) < P.plazaChance) {
            culledPlaza++;
            // Recorded once per block, with its world centre: an empty square
            // is open ground, and open ground is the one thing anything else
            // in this city can be asked to stand in.
            const pk = bx + "," + bz;
            if (!plazaSeen.has(pk)) {
              plazaSeen.add(pk);
              plazaList.push({ bx, bz, x: bcx + P.centerX, z: bcz + P.centerZ, y: P.groundY });
            }
            continue;
          }
        }

        let baseY = P.groundY;
        if (heightAt) {
          const h0 = heightAt(x, z);
          const h1 = heightAt(x - foot, z - foot);
          const h2 = heightAt(x + foot, z - foot);
          const h3 = heightAt(x - foot, z + foot);
          const h4 = heightAt(x + foot, z + foot);
          const lo = Math.min(h0, h1, h2, h3, h4);
          const hi = Math.max(h0, h1, h2, h3, h4);
          if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
          if (hi - lo > P.slopeLimit) { culledSlope++; continue; }
          baseY = lo - P.sinkBias;
        }

        // District from noisy distance.
        const rn = r / extent + (rDistrict - 0.5) * P.districtNoise;
        const district = rn < P.districtCore ? DISTRICT.glass
          : rn < P.districtMid ? DISTRICT.masonry : DISTRICT.industrial;
        districts[district]++;

        const fall = Math.pow(Math.max(0, 1 - r / extent), P.downtownPower);
        let t = THREE.MathUtils.clamp(
          fall * (1 - P.heightNoise) + rHeight * P.heightNoise * fall * 1.6, 0, 0.999,
        );
        // Industrial sheds are low whatever the falloff says.
        if (district === DISTRICT.industrial) t *= 0.35;
        const arch = Math.floor(t * normalCount);
        const scaleY = P.scaleYMin + rScale * (P.scaleYMax - P.scaleYMin);
        const top = baseY + kit.archetypes[arch].massHeight * scaleY;

        /*
         * THE TRACK'S KEEP-OUT, ASKED AFTER THE HEIGHT IS KNOWN.
         *
         * This test used to sit up with the density roll, where all it could
         * say was "a piece passes over this lot" — so a track three hundred
         * metres in the air stamped out the block underneath it exactly as
         * hard as one at street level, for a collision that could never
         * happen. Handing `top` to the query lets the corridor answer the
         * question it was always really being asked: is the track low enough
         * HERE to meet a building THIS tall.
         *
         * Moving it below the dice is free by construction: `lotRng(cx, cz)`
         * is a fresh generator per lot, so where a lot bails out cannot
         * disturb any other lot. That is the same property that lets a piece
         * clear the towers under it without reshuffling the city, and
         * cityKitTest guards it.
         */
        if (avoid && avoid(x, z, top) < P.avoidRadius) { culledCorridor++; continue; }
        // And the same for the elevated motorway, for the same reason: it is a
        // road at eleven metres and every building here is taller than that.
        if (viaductUnder && viaductUnder(x, z)) { culledViaduct++; continue; }

        // ── BUILDING TYPE ────────────────────────────────────────────────────
        // The wall RHYTHM, which is what you read at distance — separate from
        // the district, which is only palette and height. Weighted by district
        // and by height: a curtain wall is a tall-building technology, a low
        // industrial shed is always punched, and a mid-rise slab is where the
        // ribbon band belongs.
        const h = top - baseY;
        let btype = BUILDING_TYPE.punched;
        if (district === DISTRICT.industrial || h < P.typeMinHeight) {
          btype = BUILDING_TYPE.punched;
        } else if (district === DISTRICT.glass) {
          btype = rType < P.curtainInCore ? BUILDING_TYPE.curtain
            : rType < P.curtainInCore + P.ribbonInCore ? BUILDING_TYPE.ribbon
              : BUILDING_TYPE.punched;
        } else {
          btype = rType < P.curtainInMid ? BUILDING_TYPE.curtain
            : rType < P.curtainInMid + P.ribbonInMid ? BUILDING_TYPE.ribbon
              : BUILDING_TYPE.punched;
        }
        types[btype]++;

        out.push({ x, y: baseY, z, top, arch, scaleY, cx, cz, r, district, btype, tier: -1 });
      }
    }

    // ── Landmarks: the lots nearest downtown, in the glass district ──────────
    const nL = kit.stats.landmarks ?? 0;
    if (nL > 0) {
      const cands = out.filter((b) => b.r <= P.landmarkRadius && b.district === DISTRICT.glass)
        .sort((a, b) => a.r - b.r);
      for (let i = 0; i < Math.min(nL, cands.length); i++) {
        const b = cands[i];
        b.arch = normalCount + i;
        b.scaleY = 1.0;
        b.top = b.y + kit.archetypes[b.arch].massHeight;
        b.landmark = true;
      }
      stats.landmarks = Math.min(nL, cands.length);
    }

    // ── Lot texture ──────────────────────────────────────────────────────────
    for (const b of out) {
      const ix = b.cx - minCx, iz = b.cz - minCz;
      if (ix >= 0 && iz >= 0 && ix < countX && iz < countZ) {
        const i = (iz * LOT_TEX_SIZE + ix) * 4;
        facade.lotHeights.data[i] = b.y;
        facade.lotHeights.data[i + 1] = b.top;
        facade.lotHeights.data[i + 2] = b.district;
        facade.lotHeights.data[i + 3] = b.btype;
      }
    }
    facade.lotHeights.texture.needsUpdate = true;
    stats.culledCorridor = culledCorridor;
    stats.culledViaduct = culledViaduct;
    stats.culledSlope = culledSlope;
    stats.culledBounds = culledBounds;
    stats.culledPlaza = culledPlaza;
    // Lots, not squares: blockLots^2 lots make one plaza.
    stats.plazas = plazaList.length;
    stats.plazaList = plazaList;
    stats.districts = districts;
    stats.types = types;
    return out;
  }

  // ── Backends ───────────────────────────────────────────────────────────────
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl = new THREE.Vector3();

  function matrixFor(b, out) {
    _pos.set(b.x, b.y, b.z);
    _scl.set(1, b.scaleY, 1);
    return out.compose(_pos, _quat, _scl);
  }

  function buildBatched() {
    let verts = 0, idx = 0;
    for (const a of kit.archetypes) {
      for (const g of a.lods) {
        verts += g.attributes.position.count;
        idx += g.index ? g.index.count : 0;
      }
    }
    batched = new THREE.BatchedMesh(Math.max(1, buildings.length), verts, idx, facade.material);
    batched.name = "CityBatched";
    batched.perObjectFrustumCulled = P.perObjectFrustumCulled;
    batched.sortObjects = P.sortObjects;
    batched.castShadow = P.castShadows;
    batched.receiveShadow = true;
    batched.frustumCulled = false;
    batchGeomIds = kit.archetypes.map((a) => a.lods.map((g) => batched.addGeometry(g)));
    batchInstIds = new Array(buildings.length);
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      b.tier = 2;
      const id = batched.addInstance(batchGeomIds[b.arch][2]);
      batchInstIds[i] = id;
      batched.setMatrixAt(id, matrixFor(b, _m));
    }
    group.add(batched);
    stats.meshes = 1;
  }

  /**
   * ONE ROW PER (ARCHETYPE, BUILDING TYPE).
   *
   * With the type split off this is exactly the old layout — `types` is 1 and
   * the row index IS the archetype. With it on, an instance can only sit in a
   * mesh whose material was compiled for its own wall system, so the archetype
   * alone is no longer enough to place it.
   */
  const rowTypes = () => (facade.typeSplit ? 3 : 1);
  const rowOf = (b) => (facade.typeSplit ? b.arch * 3 + b.btype : b.arch);

  function buildInstanced() {
    const types = rowTypes();
    const rows = kit.archetypes.length * types;
    const perRow = new Array(rows).fill(0);
    for (const b of buildings) perRow[rowOf(b)]++;
    instanced = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const ai = Math.floor(r / types);
      const btype = types === 1 ? 0 : r % types;
      const a = kit.archetypes[ai];
      instanced[r] = a.lods.map((g, tier) => {
        if (perRow[r] === 0) return null;
        // L2 gets the CHEAP facade variant. The distance work was already
        // being skipped by a per-pixel branch, but a 3300-line shader carries
        // its register pressure whether the branch is taken or not, and that
        // costs occupancy on every pixel of every far tower. Splitting it is
        // free here because the tiers are already separate meshes.
        const mat = facade.materialFor(btype, tier === 2);
        const im = new THREE.InstancedMesh(g, mat, perRow[r]);
        im.name = `CityInst_a${ai}${facade.typeSplit ? `_t${btype}` : ""}_l${tier}`;
        im.count = 0;
        im.frustumCulled = false;
        im.receiveShadow = true;
        im.castShadow = P.castShadows && tier === 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        group.add(im);
        return im;
      });
    }
    stats.meshes = instanced.flat().filter(Boolean).length;
  }

  /**
   * Rooftop clutter, rebuilt with the layout.
   *
   * NOT part of syncGround: the streets need flat ground (with terrain on the
   * terrain IS the ground), but roofs ride the buildings and exist either way.
   * That distinction is the whole reason this is a separate function.
   */
  function syncRoofs() {
    if (roofs) {
      group.remove(roofs.group);
      roofs.dispose();
      roofs = null;
      stats.roofs = null;
    }
    if (!P.roofs) return;
    roofs = createCityRoofs({
      P, buildings, archetypes: kit.archetypes, params: P.roofParams,
    });
    group.add(roofs.group);
    stats.roofs = roofs.stats;
  }

  function clearBackend() {
    if (batched) {
      group.remove(batched);
      batched.dispose();
      batched = null;
      batchGeomIds = batchInstIds = null;
    }
    if (instanced) {
      for (const row of instanced) for (const im of row) {
        if (!im) continue;
        group.remove(im);
        im.dispose();
      }
      instanced = null;
    }
    if (signs) { group.remove(signs.group); signs.dispose(); signs = null; }
    if (prism) { group.remove(prism.group); prism.dispose(); prism = null; }
    if (bridges) { group.remove(bridges.group); bridges.dispose(); bridges = null; }
    if (viaduct) { group.remove(viaduct.group); viaduct.dispose(); viaduct = null; }
    if (underpass) { group.remove(underpass.group); underpass.dispose(); underpass = null; }
    viaductAt = null;
    viaductClear = null;
    viaductUnder = null;
    underAt = null;
    underOpen = null;
    underUnder = null;
    underRoof = null;
    if (carParkGround) { group.remove(carParkGround.mesh); carParkGround.dispose(); carParkGround = null; }
    carParks = [];
    if (parkGround) { group.remove(parkGround.mesh); parkGround.dispose(); parkGround = null; }
    parks = [];
    if (beacons) {
      group.remove(beacons);
      beacons.geometry.dispose();
      beacons.material.dispose();
      beacons.dispose();
      beacons = null;
    }
  }

  // ── Extras: signs and beacons ──────────────────────────────────────────────
  function buildExtras() {
    if (P.signs) {
      signs = createCitySigns({
        buildings, archetypes: kit.archetypes, seed,
        lobbyHeight: facade.params.floorHeight * 3, lotRand,
        params: { blockLots: P.blockLots, streetLots: P.streetLots, ...P.signParams },
      });
      group.add(signs.group);
      stats.signs = signs.stats;
      /*
       * REAL ADVERTS, if any have been dropped into public/city-ads/.
       *
       * Fire-and-forget: the atlas already carries readable placeholders, so a
       * board is never blank while this is in flight, and a slot with no file
       * simply keeps the one it has. Repainting a tile changes no draw call, no
       * texture identity and no shader — which is the whole reason the atlas is
       * built this way — so it is safe to land whenever it lands.
       *
       * `signs` is captured rather than read from the outer binding: a rebuild
       * can replace it while these are loading, and painting into the atlas of
       * a disposed sign set would be a silent leak.
       */
      const signsAtBuild = signs;
      loadHeroAdFolder(signsAtBuild)
        .then(({ loaded, missing }) => {
          if (loaded) console.log(`[CitySigns] ${loaded} hero advert${loaded === 1 ? "" : "s"} loaded`
            + (missing.length ? `; still placeholders: ${missing.join(", ")}` : ""));
        })
        .catch((e) => console.warn("[CitySigns] hero advert folder:", e));
    } else {
      stats.signs = { banners: 0, screens: 0, bands: 0 };
    }
    /*
     * THE ROOFTOP PRISM. One landmark, four draws, no per-frame CPU — the
     * slats turn in a vertex shader off a shared clock. Built after the signs
     * so it can be scored against a skyline the signs have already read.
     */
    prism = placeCityPrism({
      buildings, archetypes: kit.archetypes, plazas: stats.plazaList,
      params: { ...CITY_PRISM_DEFAULTS, ...P.prismParams, prism: P.prism },
    });
    if (prism) { group.add(prism.group); stats.prism = prism.at; }
    else stats.prism = null;
    /*
     * SKYBRIDGES. A grid reads as a grid because the space between the blocks
     * is always empty; one link across a street says the two sides were built
     * to relate to each other. One draw, and the best value on the list from
     * the track — you fly over the canyons, and a bridge is the only thing
     * that ever crosses one.
     */
    bridges = placeCityBridges({
      buildings, archetypes: kit.archetypes, rand: lotRand,
      params: {
        ...BRIDGE_DEFAULTS, streetLots: P.streetLots, uNight,
        ...P.bridgeParams, bridges: P.bridges,
      },
    });
    if (bridges) {
      group.add(bridges.group);
      stats.bridges = bridges.count;
      stats.bridgeSpans = bridges.spans;
    } else { stats.bridges = 0; stats.bridgeSpans = []; }
    /*
     * THE VIADUCT. Built here rather than with the ground because it belongs to
     * the SKYLINE, not to the street surface: with terrain on there is no city
     * ground plane, and an elevated motorway is still exactly as valid.
     *
     * The layout is computed first and kept, because the traffic needs the same
     * answer and two systems only agree about a structure if they ask one
     * function rather than each deriving it.
     */
    /*
     * NO PIER IN THE RACING LINE.
     *
     * A viaduct crosses the whole city, so it crosses the track corridor too,
     * and a 2.6 m concrete column standing in it is not an obstacle — it is a
     * wall the player meets at speed with no way round. The deck is one
     * continuous mesh, so dropping the piers there costs nothing and looks
     * right: a real viaduct spans what it cannot stand in.
     *
     * The corridor is only known here, which is why this is not in the pure
     * layout. Note it does NOT move the deck: a track that climbs above 13 m
     * on this street will still meet it. `viaductOffset` moves the whole thing
     * to another street, and `viaduct: false` turns it off.
     */
    if (viaductAt && avoid) {
      viaductAt.piers = viaductAt.piers.filter(
        (q) => avoid(q.x, q.z, viaductAt.deckBottom) >= P.avoidRadius);
    }
    /*
     * AND NOT IN THE UNDERPASS EITHER. The two structures cross — one over the
     * city, one under it — and a viaduct pier landing in the trench would be a
     * column standing in a road seven metres below the ground it was founded
     * on. The deck spans it, which is what a viaduct does.
     */
    if (viaductAt && underUnder) {
      viaductAt.piers = viaductAt.piers.filter((q) => !underUnder(q.x, q.z));
    }
    viaduct = createCityViaduct({
      layout: viaductAt, castShadows: P.castShadows, uNight,
      // The GAME'S road and rail materials. Sharing them is what makes the
      // viaduct read as the same road as the track — and what stops a 2.4 km
      // motorway costing a shader compile, since both are already built.
      roadMaterial: viaductMaterials?.road ?? null,
      railMaterial: viaductMaterials?.rail ?? null,
    });
    if (viaduct) { group.add(viaduct.group); stats.viaduct = viaduct.stats; }
    else stats.viaduct = null;

    underpass = createCityUnderpass({
      layout: underAt,
      roadMaterial: viaductMaterials?.road ?? null,
      vaultMaterial: viaductMaterials?.vaultShell ?? null,
      glowMaterial: viaductMaterials?.tunnelGlow ?? null,
      /*
       * THE ROOF HAS TO BLOCK THE SUN, and it was never asked to.
       *
       * This argument was simply not passed, so it defaulted to false and the
       * vault was a shadow RECEIVER that cast nothing. Sunlight went straight
       * through the roof onto the tunnel floor — and with it the shadow of
       * every car, lamp and building standing on the street above, projected
       * down into a tunnel they are nowhere near. The tunnel was lit like an
       * open road with other people's shadows sliding across it.
       *
       * The track's own tunnel shell has always cast (see the merged-track
       * material table); this is the city catching up with it.
       */
      castShadows: P.castShadows,
      // The portal boards are retroreflective after dark, like every real one.
      uNight,
    });
    if (underpass) { group.add(underpass.group); stats.underpass = underpass.stats; }
    else stats.underpass = null;
    if (P.beacons) {
      const tips = [];
      for (const b of buildings) {
        const a = kit.archetypes[b.arch];
        if (a.mastTop == null) continue;
        tips.push({ x: b.x, y: b.y + a.mastTop * b.scaleY, z: b.z });
      }
      beacons = createBeacons(tips, P, uTime, uNight);
      if (beacons) group.add(beacons);
      stats.beacons = tips.length;
    } else {
      stats.beacons = 0;
    }
  }

  // ── LOD ────────────────────────────────────────────────────────────────────
  function tierFor(dist, current) {
    const h = P.lodHysteresis;
    const d0 = current === 0 ? P.lod0Dist + h : P.lod0Dist - h;
    const d1 = current === 1 ? P.lod1Dist + h : P.lod1Dist - h;
    if (dist < d0) return 0;
    if (dist < d1) return 1;
    return 2;
  }

  /** Per-tier lists of building indices for this tick, sorted near-first. */
  const _tierIdx = [[], [], []];
  let _dist = new Float32Array(0);
  const _byDist = (p, q) => _dist[p] - _dist[q];

  function applyLod(view) {
    const t0 = performance.now();
    const camPos = view.pos;
    let changed = 0, culled = 0;
    const counts = [0, 0, 0];
    if (_dist.length < buildings.length) _dist = new Float32Array(buildings.length);
    for (const l of _tierIdx) l.length = 0;

    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      const dx = b.x - camPos.x, dz = b.z - camPos.z;
      const cy = (b.y + b.top) * 0.5;
      const dy = cy - camPos.y;
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
      _dist[i] = dist;
      const t = tierFor(dist, b.tier);
      if (t !== b.tier) {
        b.tier = t;
        changed++;
        if (batched) batched.setGeometryIdAt(batchInstIds[i], batchGeomIds[b.arch][t]);
      }
      counts[t]++;
      if (!instanced) continue;
      // FRUSTUM — L1 and L2 only. L0 casts shadows into the frame from
      // outside it, and there are 45 of them; not worth the shadow bug.
      if (t !== 0) {
        const a = kit.archetypes[b.arch];
        // Bounding sphere: half the footprint diagonal by half the height,
        // about the building's midpoint. Y is the scaled axis; X/Z never are.
        const r = Math.hypot(a.footprint * 0.71, a.height * b.scaleY * 0.5);
        if (!view.inView(b.x, cy, b.z, r)) { culled++; continue; }
      }
      _tierIdx[t].push(i);
    }

    if (instanced) {
      // FRONT TO BACK, within each tier. Instances draw in buffer order, and
      // the facade is the most expensive shader in the game: drawn back to
      // front it runs in full on every fragment a nearer tower then covers.
      // Sorted near-first, early-Z rejects those fragments before the shader
      // runs — most of what an occlusion-culling pass would buy, for the cost
      // of sorting ~2000 indices five times a second. The repack therefore
      // happens EVERY tick now, not only when a tier changed.
      if (P.lodSort) for (let t = 0; t < 3; t++) _tierIdx[t].sort(_byDist);
      for (const row of instanced) for (const im of row) if (im) im.count = 0;
      for (let t = 0; t < 3; t++) {
        const idx = _tierIdx[t];
        for (let k = 0; k < idx.length; k++) {
          const b = buildings[idx[k]];
          const im = instanced[rowOf(b)][t];
          if (!im) continue;
          im.setMatrixAt(im.count++, matrixFor(b, _m));
        }
      }
      for (const row of instanced) for (const im of row) {
        if (!im) continue;
        im.instanceMatrix.needsUpdate = true;
        im.visible = im.count > 0;
      }
    }
    stats.lod = counts;
    stats.culled = culled;
    stats.lastLodMs = performance.now() - t0;
    return changed;
  }

  // ── Ground ─────────────────────────────────────────────────────────────────
  function syncGround() {
    if (ground) {
      group.remove(ground.mesh);
      group.remove(ground.lampMesh);
      ground.dispose();
      ground = null;
    }
    if (furniture) {
      group.remove(furniture.group);
      furniture.dispose();
      furniture = null;
      stats.furniture = null;
    }
    obstacles = null;
    stats.obstacles = null;
    knockables = null;
    clearanceAt = null;
    stats.knockables = null;
    if (P.ground) {
      ground = createCityStreets({
        P, originCellX, originCellZ, params: P.streetParams, reflectionTexture,
        // `buildExtras` runs before this, so the viaduct's keep-out is already
        // known. Lamp posts are placed in the streets module, not in furniture,
        // so the gate has to exist in both or half of them come back.
        keepOut: cityKeepOut,
        // The open trenches, cut out of the ground plane rather than discarded
        // per pixel — see `planeWithHoles`.
        holes: underAt ? underAt.openRects : [],
      });
      // The street material is rebuilt with the ground, so the weather it was
      // last told about has to be re-applied or every rebuild dries the city.
      ground.setWet(wetAmount);
      group.add(ground.mesh);
      group.add(ground.lampMesh);
      stats.lamps = ground.lampCount;
      if (P.furniture) {
        /*
         * HOW MUCH ROOM IS THERE HERE? — for the pavement trees.
         *
         * MEASURED, before this existed: 63% of tree canopies intersected a
         * building and 259 trees had their trunk INSIDE one. The placement was
         * never checked against the buildings at all; it only survived the
         * procedural tree because that canopy was 2.6 m and the gap is usually
         * a bit more than that. A real tree preset is 6 m and the gap does not
         * move, so the moment the trees got good the fault became obvious.
         *
         * Footprints are 24-31 m in a 34 m lot, so a building sits only
         * 1.5-5.0 m back from the kerb while trees sit 1.2 m out from it —
         * there genuinely is not room for a full-size tree everywhere, which is
         * why the answer is to SIZE each tree to its own spot rather than to
         * shrink them all (measured: no global size fixes it — even a 3 m
         * canopy at the kerb still overlaps 29% of the time).
         *
         * A uniform grid over the lot pitch: one bucket per lot, each holding
         * the buildings whose footprint can reach it. Built once per city
         * build, queried ~4.6k times. Buildings are axis-aligned boxes centred
         * on their lot, so the query is an exact box distance, not an estimate.
         */
        const CLEAR_CELL = P.lotSize;
        const clearGrid = new Map();
        const ckey = (i, j) => `${i},${j}`;
        for (const b of buildings) {
          const a = kit.archetypes[b.arch];
          if (!a) continue;
          const rec = { x: b.x, z: b.z, hw: a.width * 0.5, hd: a.depth * 0.5 };
          const ci = Math.floor(b.x / CLEAR_CELL), cj = Math.floor(b.z / CLEAR_CELL);
          // Spill into the 8 neighbours so a query never has to look further
          // than its own bucket — a footprint is smaller than a lot, so one
          // ring is enough and the test can stay a single lookup.
          for (let di = -1; di <= 1; di++) {
            for (let dj = -1; dj <= 1; dj++) {
              const k = ckey(ci + di, cj + dj);
              let arr = clearGrid.get(k);
              if (!arr) clearGrid.set(k, (arr = []));
              arr.push(rec);
            }
          }
        }
        /** Metres from (x, z) to the nearest building wall. Infinity if none
         *  is near; NEGATIVE when the point is inside a footprint. */
        const buildingClearance = (x, z) => {
          const arr = clearGrid.get(ckey(Math.floor(x / CLEAR_CELL), Math.floor(z / CLEAR_CELL)));
          if (!arr) return Infinity;
          let best = Infinity;
          for (const b of arr) {
            const dx = Math.abs(x - b.x) - b.hw;
            const dz = Math.abs(z - b.z) - b.hd;
            const d = (dx < 0 && dz < 0)
              ? Math.max(dx, dz)                                   // inside: negative
              : Math.hypot(Math.max(dx, 0), Math.max(dz, 0));      // outside: true distance
            if (d < best) best = d;
          }
          return best;
        };
        // Exposed so a harness (and the dev console) can ask the same question
        // the placement asks: is this point inside a building?
        clearanceAt = buildingClearance;
        /*
         * CAR PARKS, PLANNED BEFORE THE FURNITURE. An empty paved block breaks
         * the grid, which was the point of plazas — but a bare one reads as
         * MISSING rather than as open, and the eye tells the difference. The
         * cars go in as extra instances of the four bodies the street already
         * draws, so a few hundred more parked cars is a few hundred matrices
         * and not one more draw. The paint is one instanced quad per park.
         *
         * The square the prism took is excluded through the prism's OWN
         * picker: a second copy of "nearest to downtown" would agree until
         * either rule was tuned, and the symptom would be a hundred cars
         * parked around a billboard.
         */
        const blockWm = P.blockLots * P.lotSize;
        const prismSquare = P.prism
          && (P.prismParams?.prismSite ?? CITY_PRISM_DEFAULTS.prismSite) === "plaza"
          ? pickPrismPlaza(stats.plazaList) : null;
        /*
         * PARKS ROLL FIRST, and deliberately. Every block in this city is
         * built or paved; a park is the only square that is neither, and a
         * city can afford one green one more easily than it can afford none.
         * The car parks then take what is left.
         */
        const greenP = { ...PARK_DEFAULTS, ...P.parkParams, parks: P.parks };
        parks = planParks({
          plazas: stats.plazaList, blockW: blockWm, rand: blockRand,
          skip: [prismSquare], params: greenP,
        });
        parkGround = buildParkGround(parks, greenP, blockWm);
        if (parkGround) group.add(parkGround.mesh);
        stats.parks = parks.length;
        stats.parkList = parks;

        const parkP = { ...CARPARK_DEFAULTS, ...P.carParkParams, carParks: P.carParks };
        carParks = planCarParks({
          plazas: stats.plazaList,
          blockW: blockWm,
          rand: blockRand,
          skip: [prismSquare, ...parks],
          params: parkP,
        });
        carParkGround = buildCarParkGround(carParks, parkP, blockWm);
        if (carParkGround) group.add(carParkGround.mesh);
        stats.carParks = carParks.length;
        stats.parkedInParks = carParks.reduce((a, pk) => a + pk.bays.length, 0);
        // The bays themselves, so a harness can check the cars against the
        // paint rather than against a count that cannot tell them apart.
        stats.carParkList = carParks;
        furniture = createCityFurniture({
          buildingClearance,
          parkBays: carParks,
          parkTrees: parks,
          P, originCellX, originCellZ, params: P.furnitureParams,
          // Nothing tall under a descending ramp. Signals and lamps are SOLID,
          // so one left standing is not scenery clipping a road, it is a wall
          // across the only way onto the motorway.
          keepOut: cityKeepOut,
          // Where the street has an actual hole in it, so the lanes that cross
          // it stop putting cars in mid-air.
          holeAt: underOpen,
          // ...and the street whose lanes go down it, so the two inner ones
          // follow the road rather than being hidden over the hole.
          underpass: underpassDip(underAt),
          // The motorway's lanes come from the same layout the deck was built
          // from, so the cars cannot end up beside the road they drive on.
          viaduct: viaductAt,
          // The street's OWN lamp field, so a car is lit by the lamp whose
          // pool it is parked in and the two can never drift apart.
          lamp: { pool: ground.lampPoolFree, color: ground.lampColor },
          treeEnv,
        });
        group.add(furniture.group);
        stats.furniture = furniture.stats;
      }
      // Built from the placements above, so it can never describe furniture
      // that is not there — it is rebuilt with them or not at all.
      obstacles = createCityObstacles({
        lampMatrices: ground.lampMatrices,
        lists: furniture?.lists ?? null,
        // Derived from the viaduct that was actually built, so the capsule can
        // never describe a pier of a different size than the one you can see.
        // Each entry carries its own `top`, because a pier under a descending
        // ramp is shorter than one under the deck — see the note in
        // modularRoadCityObstacles.js on what that got wrong.
        piers: viaductAt ? {
          list: viaductAt.piers,
          radius: Math.max(viaductAt.params.pierWidth, viaductAt.params.pierDepth) * 0.5 + 0.2,
        } : null,
        // The lighting columns down the central reserve. Same list the geometry
        // was built from, so there can be no invisible one and no ghost.
        columns: viaductAt ? {
          list: viaductAt.columns,
          radius: 0.22,
          height: viaductAt.params.columnHeight,
        } : null,
        groundY: P.groundY,
        // The same corridor the towers respect, so a track at street level is
        // not lined with posts you cannot see coming — plus whatever the game
        // asked to be kept clear, which is where the car appears.
        avoid,
        avoidRadius: P.avoidRadius,
        params: P.obstacleParams,
      });
      stats.obstacles = obstacles.stats;
      /*
       * KNOCKABLES. Built after the obstacle table because a knocked body has
       * to be able to take itself OUT of it — something you have just sent
       * down the street must stop being something to hit.
       *
       * Pointed at the STREET CLUTTER, not at the guardrails: a rail stands
       * flush against the kerb and cannot be knocked anywhere, which is why
       * they went back to being static walls. Cones, bins, pallets and water
       * barriers stand in the road with room behind them, and none of them is
       * in the obstacle table at all — see modularRoadCityClutter.js.
       */
      knockables = furniture
        ? createCityKnockables({
          groups: furniture.knockableGroups,
          groundY: P.groundY,
          params: P.knockParams,
        })
        : null;
      stats.knockables = knockables?.stats ?? null;
    }
  }

  // ── Build / rebuild ────────────────────────────────────────────────────────
  /**
   * THE SURFACES RAIN LANDS ON — the street, the buildings and the roofs.
   *
   * Deliberately not everything. The rain collider is a top-down render of a
   * layer, EVERY frame, so each tagged mesh is a draw in that pass: the ground
   * you drive on and the roofs you fly over are worth it, and a splash on a
   * bin at 60 km/h is not. Nothing else in the city is tagged, and an untagged
   * object costs the bake exactly nothing — the bake camera does
   * `disableAll()` first, so it is opt-in by construction.
   */
  function rainSurfaces() {
    const out = [];
    if (ground?.mesh) out.push(ground.mesh);
    if (batched) out.push(batched);
    if (instanced) {
      for (const row of instanced) {
        if (!row) continue;
        // L0 only. The far tiers are the same towers with coarser tops, and a
        // second copy of a roof in the height buffer is a draw for nothing.
        if (row[0]) out.push(row[0]);
      }
    }
    if (roofs?.group) out.push(roofs.group);
    return out;
  }

  /**
   * Everywhere a placement must not go: under a viaduct ramp, and anywhere over
   * the underpass. ONE predicate, because the furniture module and the streets
   * module each take exactly one and there is no sense in them disagreeing.
   */
  const cityKeepOut = (x, z) => (viaductClear ? viaductClear(x, z) : false)
    || (underUnder ? underUnder(x, z) : false);

  function rebuild() {
    const t0 = performance.now();
    clearBackend();
    /*
     * THE VIADUCT IS PLANNED BEFORE THE CITY IS.
     *
     * It used to be worked out in `buildExtras`, which runs after the
     * buildings — fine while it was a straight line over a street, because a
     * street has no buildings on it. It curves now, and a curve leaves the
     * grid: the deck flies over blocks, and a tower is three hundred metres of
     * solid geometry through a road eleven metres up. The layout is pure and
     * cheap, so it is worked out first and the towers under it are never built.
     */
    viaductAt = P.viaduct
      ? viaductLayout({ P, originCellX, originCellZ, params: P.viaductParams })
      : null;
    viaductClear = viaductKeepOut(viaductAt);
    viaductUnder = viaductFootprint(viaductAt, P.lotSize);
    /*
     * AN UNDERPASS IS A HOLE IN THE CITY'S GROUND PLANE, so it needs one to
     * exist. With terrain ON there is none — the terrain IS the ground, and it
     * is a heightfield this city does not cut — so the whole structure would be
     * buried seven metres under a hillside, drawn, collidable and invisible.
     *
     * Same condition `streetHeightAt` already uses to decide whether the city
     * has a floor at all.
     */
    underAt = P.underpass && P.ground
      ? underpassLayout({ P, originCellX, originCellZ, params: P.underpassParams })
      : null;
    underOpen = underpassOpenAt(underAt);
    underRoof = underpassRoofAt(underAt);
    // A metre of margin: a lamp post ON the lip of a trench is a lamp post
    // hanging over a hole.
    underUnder = underpassFootprint(underAt, 1.0);
    buildings = layout();
    stats.buildings = buildings.length;
    // The collider's BVHs belong to the ARCHETYPES, so a rebuild only refills
    // its cell map — see modularRoadCityCollider.js for why that matters.
    if (collider) collider.setBuildings(buildings);
    if (P.backend === "instanced") buildInstanced();
    else buildBatched();
    buildExtras();
    syncGround();
    syncRoofs();
    _lodT = 1e9;
    stats.lastBuildMs = performance.now() - t0;
    /*
     * TOLD, NOT ASKED. Every mutator on this city funnels through `rebuild()`
     * — reseed, a param change, and the track corridor on every build settle —
     * and each of them REPLACES these meshes. A caller that tagged them once
     * after construction would be tagging objects that no longer exist the
     * first time the player nudged a track piece, and the symptom is rain
     * falling through a road that worked a minute ago.
     *
     * The surfaces are handed over rather than fetched, because on the first
     * call this object has not been returned yet and the caller has nothing to
     * ask.
     */
    onRebuilt?.(rainSurfaces());
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  let _lodT = 1e9;
  /** Which of the heavy LOD consumers gets this tick — see `update`. */
  let _lodTurn = 2;
  const _lastLodPos = new THREE.Vector3(1e9, 1e9, 1e9);
  const _lastLodFwd = new THREE.Vector3(0, 0, 0);
  const _lodView = createLodView();

  function update(dt, camera) {
    if (!enabled) return;
    // One clock for the window churn, the screens and the beacons; one night
    // value, read off the facade proxy the game already drives.
    _clock += dt;
    uTime.value = _clock;
    facade.setTime(_clock);
    const night = facade.params.nightAmount;
    uNight.value = night;
    roofs?.setNight(night);
    if (signs) { signs.setNight(night); signs.setTime(_clock); }
    ground?.setNight(night);
    furniture?.setNight(night);
    // Traffic moves EVERY frame — it is the one thing here that is not static,
    // and it is throttled by distance rather than by the LOD timer.
    furniture?.updateTraffic(_clock, camera.position);

    _lodT += dt;
    const moved = camera.position.distanceTo(_lastLodPos);
    // A heading change is a trigger too: with a per-instance frustum cull,
    // a fast pan otherwise shows the edge of the frame empty until the clock
    // or the odometer fires.
    _lodView.margin = P.lodMargin;
    _lodView.update(camera);
    const turnedDeg = _lodView.hasFrustum
      ? Math.acos(Math.min(1, Math.max(-1, _lodView.fwd.dot(_lastLodFwd)))) * 57.2958
      : 0;
    const byTurn = turnedDeg >= P.lodTurnAngle;
    if (_lodT < P.lodInterval && moved < P.lodMoveDist && !byTurn) return;
    _lodT = 0;
    _lastLodPos.copy(camera.position);
    _lastLodFwd.copy(_lodView.fwd);

    // ── THE EXPENSIVE PAIR TAKE TURNS ─────────────────────────────────────
    //
    // These three together walk ~35k items and re-upload every instance
    // matrix they decide to keep. Run in the same frame — which is what they
    // used to do — that is one long frame every time the car moves 12 m, and
    // it showed up as a p95 frame time of 20.4 ms against a 16.7 ms budget
    // while the median sat exactly on vsync.
    //
    // Nothing here needs to be current. The tiers have 30 m of hysteresis and
    // the furniture and roofs cull at 420-620 m, so being one or two ticks
    // stale — a few tens of metres at racing speed — cannot be seen. Spreading
    // them makes the worst tick a third of the size for no visible cost.
    // The tier pass runs EVERY tick: it decides which buildings draw at all,
    // it is only 2150 distance tests, and it re-packs instance matrices solely
    // when a tier actually changed. Staggering it made towers pop.
    applyLod(_lodView);
    // The heavy consumers — ~37k items between them, each re-uploading every
    // matrix it keeps — take turns on a clock or odometer tick. A TURN tick
    // runs all of them: they are every bit as frustum-sensitive as the towers,
    // and a stale one shows as furniture missing from the edge of a pan.
    if (byTurn) {
      furniture?.applyLod(_lodView);
      roofs?.applyLod(_lodView);
      ground?.applyLampLod?.(_lodView);
    } else {
      _lodTurn = (_lodTurn + 1) % 3;
      if (_lodTurn === 0) furniture?.applyLod(_lodView);
      else if (_lodTurn === 1) roofs?.applyLod(_lodView);
      else ground?.applyLampLod?.(_lodView);
    }
  }

  rebuild();

  return {
    group,
    rainSurfaces,
    params: P,
    facade: facade.params,
    facadeMaterial: facade.material,
    /** The L2 tier's cheaper variant, sharing the near one's uniforms. */
    facadeFarMaterial: facade.farMaterial,
    /**
     * Street furniture you can hit, as capsules, near a point.
     *
     * A RADIUS QUERY rather than a list: there are ~4300 lamp posts and ~3000
     * parked cars, and a capsule 300 m away cannot be reached before the next
     * refresh. The caller re-asks as the car moves. Empty with no ground plane
     * — with terrain on, the terrain is the ground and none of this exists.
     */
    obstacleCapsulesNear(x, z, radius) {
      return obstacles ? obstacles.capsulesNear(x, z, radius) : [];
    },
    /**
     * Drive the knockable guardrails. EVERY FRAME — a body in the air cannot
     * wait for the LOD tick. `car` is the vehicle body; this only reads it.
     * @returns {number} how many rails were knocked THIS frame, so the caller
     *   can refresh its capsule window (they have just stopped being solid).
     */
    updateKnockables(dt, car) {
      if (!knockables) return 0;
      const before = knockables.stats.knocked;
      knockables.update(dt, car);
      return knockables.stats.knocked - before;
    },
    /** The furniture handle — its placement lists are what the obstacle table
     *  and the knockable pool both read. */
    get furniture() { return furniture; },
    /** Metres to the nearest building wall; NEGATIVE inside a footprint.
     *  Null until the city has been built. */
    buildingClearance(x, z) { return clearanceAt ? clearanceAt(x, z) : null; },
    /** Live knockable params, or null when there is no furniture. */
    get knockables() { return knockables ? knockables.params : null; },
    /** Live per-kind toggles: lamps / lights / trees / cars / rails / radius. */
    get obstacles() { return obstacles ? obstacles.params : null; },
    /** Live rooftop-clutter params, or null when roofs are off. */
    get roofs() { return roofs ? roofs.params : null; },
    setRoofs(on) { P.roofs = !!on; syncRoofs(); },

    /**
     * A clear stretch of ROAD near (x, z) — where to put the car.
     *
     * The alternative was a hole in the collision around the spawn, and that
     * is a bad trade: it leaves two lamp posts you can see and drive straight
     * through, at the one place the player is looking hardest. Move the car
     * instead. Nothing about the city changes, and nothing stops being solid.
     *
     * The grid makes this exact rather than a search. Streets are the band
     * [blockW, pitch) of each period, so the centre line of the nearest one is
     * a snap, not a scan — and the point returned is mid-carriageway, clear of
     * the kerbs the lamps and trees stand on and of the parking lane.
     *
     * @returns {{x:number, z:number, yaw:number}} yaw points ALONG the street.
     */
    streetSpawnNear(x = 0, z = 0) {
      const pitch = (P.blockLots + P.streetLots) * P.lotSize;
      const blockW = P.blockLots * P.lotSize;
      const streetW = Math.max(P.streetLots * P.lotSize, 1);
      const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
      /** Centre of the street band nearest `v` on one axis. */
      const centre = (v, o) => {
        const k = Math.round((v - o - blockW - streetW / 2) / pitch);
        return o + k * pitch + blockW + streetW / 2;
      };
      const cx = centre(x, ox), cz = centre(z, oz);
      // Take the axis whose street is NEARER, and run along it — the other
      // coordinate stays where it was, so the car lands on the length of a
      // street rather than in the middle of a junction.
      const dx = Math.abs(cx - x), dz = Math.abs(cz - z);
      return dx <= dz
        // A street running along Z: fix x at its centre, keep z, face +Z.
        ? { x: cx, z, yaw: 0 }
        // One running along X: fix z, keep x, face +X.
        : { x, z: cz, yaw: Math.PI / 2 };
    },

    /**
     * The facade's lot height field — base, top, district and type per cell.
     * It IS the city as far as the shader is concerned, so exposing it lets a
     * harness stand a SECOND facade material on exactly this city (an A/B of
     * two shader builds inside one page load, which is the only way to compare
     * them without a reload's order effects) and lets a test read back what
     * the towers actually told the shader.
     */
    get lotHeights() { return facade.lotHeights; },
    /** Live street-material params, or null when there is no ground plane. */
    get streets() { return ground ? ground.params : null; },
    /**
     * The checkpoint ring, straight through to the street's uniforms.
     *
     * NOT via applyStreetParams: the marker values live in RUNTIME_UNIFORMS,
     * which that path deliberately skips so the dev panel cannot clobber
     * something driven per frame. This is the exception, so it gets its own
     * door rather than a hole in the rule. Three uniform writes, and a no-op
     * on the shader when the street's `markerOn` gate is 0.
     */
    setCheckpointMarker(x, z, amount) { ground?.setMarker?.(x, z, amount); },
    /**
     * Push edits to `streets` into the live uniforms — a uniform write, no
     * rebuild, so it is safe to call from a slider's input event.
     *
     * Returns true when a BUILD-TIME gate moved and the street has to be
     * rebuilt for the change to mean anything; the caller decides when to pay
     * that (~7 s), because doing it silently mid-drag would be worse than the
     * slider appearing to do nothing for a moment.
     */
    applyStreetParams(patch) {
      if (!ground) return false;
      const needsRebuild = ground.applyParams(patch);
      if (needsRebuild) P.streetParams = { ...P.streetParams, ...ground.params };
      return needsRebuild;
    },
    /**
     * Back to the authored look. Clears `P.streetParams` too, or the next
     * rebuild would resurrect the overrides this just undid.
     * @returns {boolean} true if a rebuild is needed (a build-time gate moved)
     */
    resetStreetParams() {
      if (!ground) return false;
      P.streetParams = {};
      return ground.applyParams(STREET_DEFAULTS);
    },
    /**
     * This frame's mirror, forwarded to the street. Hand it exactly what the
     * road deck gets — the pass is shared, and the street's own fades decide
     * whether any of it survives down here.
     */
    setReflection(tex, matrix, center, normal, on) {
      ground?.setReflection?.(tex, matrix, center, normal, on);
    },
    get canReflect() { return !!ground?.canReflect; },
    /**
     * WHAT THE WET STREET SHOULD MIRROR — and it is not the car.
     *
     * A planar reflection of the car lands directly underneath the car, which
     * the car itself hides. On the sky track that does not matter, because
     * what you actually see reflected there is the guardrails. A city street
     * has no rails, so on its own the mirror had nothing visible in it at all.
     *
     * What a wet street mirrors is the LAMPS — a column of light stretched
     * down the road is the single image everyone recognises as "wet city" —
     * then the traffic lights, the parked cars and the crossing rails.
     *
     * All of them are already ONE InstancedMesh each, so putting the whole set
     * in the mirror is four or five extra draws on a pass that already runs at
     * half resolution, not a draw per lamp post.
     */
    get reflectables() {
      const out = [];
      if (ground?.lampMesh) out.push(ground.lampMesh);
      if (furniture?.group) {
        for (const o of furniture.group.children) {
          if (!o.isInstancedMesh) continue;
          // Tree canopies are 6-9 m of alpha-tested foliage and read as a
          // smear at this roughness; the trunks under them do not earn a draw
          // on their own. Everything else is street-level and sells the wet.
          if (o.name === "CityCanopies" || o.name === "CityTrunks") continue;
          out.push(o);
        }
      }
      return out;
    },
    stats,
    get kit() { return kit; },
    get enabled() { return enabled; },
    get buildings() { return buildings; },
    get signs() { return signs; },

    rebuild,
    update,

    rebuildKit(kitOverrides) {
      clearBackend();
      disposeCityKit(kit);
      kit = buildCityKit({ seed, params: { ...kitParams, ...kitOverrides } });
      stats.kit = kit.stats;
      rebuild();
    },

    setSeed(s) { seed = s >>> 0; rebuild(); },
    get seed() { return seed; },

    /** The gradient the glass mirrors — hand it the sky's own look each frame. */
    setSkyColors(zenith, horizon, ground) { facade.setSkyColors(zenith, horizon, ground); },
    /**
     * Direction TO the sun, world space. The facade casts its OWN shadows from
     * this — piers onto spandrels, window heads onto glass, string courses
     * onto the wall below — so it has to be the same sun the scene's light
     * uses or the relief will be lit from one side and shadowed from another.
     */
    setSun(dir) { facade.setSun(dir); },

    /**
     * The building collider, built on first ask. Hand it to the game's ground
     * adapter (`setCityCollider`) and towers become solid. The crash comes
     * free: the vehicle arms `_crashYield` off ANY solid above
     * CRASH.wallSpeed and has no idea what kind of solid it was.
     */
    getCollider() {
      if (!collider) {
        collider = createCityCollider({ kit, buildings, lotSize: P.lotSize });
        stats.collider = collider.stats;
      }
      return collider;
    },
    /**
     * The street surface for PHYSICS, or NaN where there is none.
     *
     * The city's ground plane is flat, so it IS a heightfield, and the vehicle
     * already has a heightfield path (the terrain probe in
     * v3/play/modularRoadGround.js). Sky mode feeds that NaN, meaning "no
     * ground here"; this feeds it the street where the street exists, which
     * makes the road drivable without one line of new collision code. With
     * terrain ON there is no city ground plane — the terrain is the ground —
     * so this returns NaN and stays out of the way.
     */
    /**
     * ── THE CITY'S OWN ROADS, FOR COLLISION ────────────────────────────────────
     *
     * `{deck, solids}`, the same shape the dock hands over, for the game's
     * collision bake to collect. The viaduct AND the underpass — every piece of
     * the city that is real geometry under the wheels rather than a plane.
     *
     * This is NOT `streetHeightAt`, and it cannot be: that is a single flat
     * `groundY` for the whole city and structurally cannot express a road
     * eleven metres in the air. An elevated road is real geometry, resolved
     * against the same BVH the track uses.
     */
    /**
     * ── THE LOWEST POINT OF ANY CITY ROAD ──────────────────────────────────────
     *
     * `Infinity` when the city has none, so a caller can `Math.min` it with
     * whatever else it knows about without a special case.
     *
     * This exists because the kill floor used to be derived from the TRACK
     * alone, on the reasonable assumption that nothing else in the world went
     * downward. The underpass broke that: it is a road six and a half metres
     * below the ground plane, and a sky track forty metres up put the floor at
     * minus ten — so driving down the ramp was indistinguishable from falling
     * out of the world, and the game sent the player back to the start every
     * time they approached it.
     */
    roadFloorY() {
      let lo = Infinity;
      if (underAt) lo = Math.min(lo, underAt.roadY - 1.5);
      return lo;
    },
    roadCollision() {
      const v = viaduct ? viaduct.collisionMeshes() : { deck: [], solids: [] };
      const u = underpass ? underpass.collisionMeshes() : { deck: [], solids: [] };
      return { deck: [...v.deck, ...u.deck], solids: [...v.solids, ...u.solids] };
    },
    streetHeightAt(x, z) {
      if (!ground || !P.ground) return NaN;
      const halfPlane = P.extent * 1.3;   // the plane is extent * 2.6 across
      if (Math.abs(x - P.centerX) > halfPlane || Math.abs(z - P.centerZ) > halfPlane) return NaN;
      /*
       * THERE IS NO GROUND OVER A HOLE.
       *
       * NaN is not a special case bolted on here — it is what this function
       * already returns outside the city and with terrain on, and everything
       * downstream reads it as "no surface". So the open trench simply stops
       * being street, and the underpass road's own BVH takes over.
       *
       * Without it the car drives straight across the top of the hole on the
       * street it is supposed to be driving under, and the tunnel is scenery
       * you can see into and never enter.
       */
      if (underOpen && underOpen(x, z)) return NaN;
      /*
       * AND NONE UNDER THE ROOF EITHER, which is the half of this that took
       * three attempts to see. Over the covered section the street is still
       * there — you drive over it — so it was left alone, and the tunnel stayed
       * unenterable: a height function has no notion of above or below, so
       * inside the tunnel this answered "the surface here is street level" and
       * the suspension spent every frame trying to climb 5.9 m to reach it.
       * MEASURED: the car entered the portal at 12 m/s and left it going 12 m/s
       * STRAIGHT UP, one frame after its nose crossed `cov0`. Every scene-wide
       * triangle scan of that spot found nothing, because the thing throwing
       * the car was not geometry at all.
       *
       * The street above is given back by the lid mesh — see `coveredRect`.
       */
      if (underRoof && underRoof(x, z)) return NaN;
      return P.groundY;
    },
    /**
     * Same weather the track gets, 0 dry … 1 soaked. The street material runs
     * the Smart Road's own wet model (modularRoadWet.js, same knob names), so
     * a wet city and a wet track read as the same rain.
     */
    setWet(v) { wetAmount = Math.max(0, Math.min(1, v || 0)); ground?.setWet(wetAmount); },
    get wet() { return wetAmount; },

    setHeightSource(fn) { heightAt = fn ?? null; rebuild(); },
    setAvoid(fn) { avoid = fn ?? null; rebuild(); },
    setGround(on) { P.ground = !!on; syncGround(); },

    setBackend(name) {
      if (name === P.backend) return;
      P.backend = name;
      rebuild();
    },

    setShadows(on) {
      P.castShadows = !!on;
      if (batched) batched.castShadow = P.castShadows;
      if (instanced) {
        for (const row of instanced) row.forEach((im, tier) => {
          if (im) im.castShadow = P.castShadows && tier === 0;
        });
      }
    },

    setEnabled(on) {
      enabled = !!on;
      group.visible = enabled;
    },

    setLayer(n, on = true) {
      group.traverse((o) => {
        if (!o.isMesh) return;
        if (on) o.layers.enable(n); else o.layers.disable(n);
      });
    },

    dispose() {
      clearBackend();
      disposeCityKit(kit);
      if (roofs) roofs.dispose();
      if (ground) ground.dispose();
      for (const m of facade.allMaterials) m.dispose();
      collider?.dispose();
      collider = null;
      facade.lotHeights.texture.dispose();
    },
  };
}
