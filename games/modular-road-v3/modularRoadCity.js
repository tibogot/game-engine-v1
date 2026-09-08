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
import { createCitySigns, loadHeroAdFolder } from "./modularRoadCitySigns.js";
import { createCityStreets, STREET_DEFAULTS } from "./modularRoadCityStreets.js";
import { createCityFurniture } from "./modularRoadCityFurniture.js";
import { createCityCollider } from "./modularRoadCityCollider.js";
import { createCityObstacles } from "./modularRoadCityObstacles.js";
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

  /** World half-size the city may occupy (the terrain's edge). */
  bounds: Infinity,
  boundsMargin: 80,

  /** Terrain fit. */
  slopeLimit: 6,
  sinkBias: 0.6,

  /** LOD ring radii, metres, with hysteresis and a recompute throttle. */
  lod0Dist: 220,
  lod1Dist: 850,
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
  beacons: true,
  beaconColor: 0xff2a1a,

  /** 'batched' | 'instanced'. Instanced by default — see the header. */
  backend: "instanced",
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
} = {}) {
  const P = { ...CITY_DEFAULTS, ...params };

  const group = new THREE.Group();
  group.name = "City";

  const facade = createCityFacadeMaterial({
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
  /** Buildings you cannot drive through. Built lazily — a city that is never
   *  collided against never pays for the trees. */
  let collider = null;
  /** Last wetness the game pushed — survives a ground rebuild. */
  let wetAmount = 0;
  let buildings = [];
  let batched = null, batchGeomIds = null, batchInstIds = null;
  let instanced = null;
  let signs = null;
  let beacons = null;
  let enabled = true;
  let originCellX = 0, originCellZ = 0;
  const uTime = uniform(0);
  const uNight = uniform(0);
  let _clock = 0;

  const stats = {
    buildings: 0, lod: [0, 0, 0], meshes: 0, kit: kit.stats,
    lastLodMs: 0, lastBuildMs: 0,
    culledCorridor: 0, culledSlope: 0, culledBounds: 0,
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

    let culledCorridor = 0, culledSlope = 0, culledBounds = 0;
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
        if (avoid && avoid(x, z) < P.avoidRadius) { culledCorridor++; continue; }

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
    stats.culledSlope = culledSlope;
    stats.culledBounds = culledBounds;
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

  function buildInstanced() {
    const perArch = new Array(kit.archetypes.length).fill(0);
    for (const b of buildings) perArch[b.arch]++;
    instanced = kit.archetypes.map((a, ai) =>
      a.lods.map((g, tier) => {
        if (perArch[ai] === 0) return null;
        // L2 gets the CHEAP facade variant. The distance work was already
        // being skipped by a per-pixel branch, but a 3300-line shader carries
        // its register pressure whether the branch is taken or not, and that
        // costs occupancy on every pixel of every far tower. Splitting it is
        // free here because the tiers are already separate meshes.
        const mat = tier === 2 ? facade.farMaterial : facade.material;
        const im = new THREE.InstancedMesh(g, mat, perArch[ai]);
        im.name = `CityInst_a${ai}_l${tier}`;
        im.count = 0;
        im.frustumCulled = false;
        im.receiveShadow = true;
        im.castShadow = P.castShadows && tier === 0;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        group.add(im);
        return im;
      }),
    );
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
          const im = instanced[b.arch][t];
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
    if (P.ground) {
      ground = createCityStreets({
        P, originCellX, originCellZ, params: P.streetParams, reflectionTexture,
      });
      // The street material is rebuilt with the ground, so the weather it was
      // last told about has to be re-applied or every rebuild dries the city.
      ground.setWet(wetAmount);
      group.add(ground.mesh);
      group.add(ground.lampMesh);
      stats.lamps = ground.lampCount;
      if (P.furniture) {
        furniture = createCityFurniture({
          P, originCellX, originCellZ, params: P.furnitureParams,
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
        groundY: P.groundY,
        // The same corridor the towers respect, so a track at street level is
        // not lined with posts you cannot see coming — plus whatever the game
        // asked to be kept clear, which is where the car appears.
        avoid,
        avoidRadius: P.avoidRadius,
        params: P.obstacleParams,
      });
      stats.obstacles = obstacles.stats;
    }
  }

  // ── Build / rebuild ────────────────────────────────────────────────────────
  function rebuild() {
    const t0 = performance.now();
    clearBackend();
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
    streetHeightAt(x, z) {
      if (!ground || !P.ground) return NaN;
      const halfPlane = P.extent * 1.3;   // the plane is extent * 2.6 across
      if (Math.abs(x - P.centerX) > halfPlane || Math.abs(z - P.centerZ) > halfPlane) return NaN;
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
      facade.material.dispose();
      collider?.dispose();
      collider = null;
      facade.lotHeights.texture.dispose();
    },
  };
}
