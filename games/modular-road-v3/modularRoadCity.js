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
// Only the L0 tier ever casts, and only on the instanced backend (castShadow
// is per mesh; BatchedMesh cannot gate per tier). Off unless asked. The engine
// fits its shadow camera to the VIEW, so the city does not inflate a cascade.
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
import { createCityFacadeMaterial, LOT_TEX_SIZE, DISTRICT } from "./modularRoadCityFacade.js";
import { createCitySigns } from "./modularRoadCitySigns.js";
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
  districtCore: 0.40,
  districtMid: 0.76,
  districtNoise: 0.22,
  /** Landmark archetypes go on the lots nearest the centre, within this radius. */
  landmarkRadius: 200,

  /** Per-instance Y-scale range. X and Z are NEVER scaled. */
  scaleYMin: 0.75,
  scaleYMax: 1.45,

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

  castShadows: false,

  /** Streets + block ground plane — flat ground only. */
  ground: true,
  groundY: 0,
  streetColor: 0x1b1d21,
  blockColor: 0x2c2e33,

  /** Signage and beacons. Both are ONE draw each per kind. */
  signs: true,
  signParams: {},
  beacons: true,
  beaconColor: 0xff2a1a,

  /** 'batched' | 'instanced'. Instanced by default — see the header. */
  backend: "instanced",
  perObjectFrustumCulled: true,
  sortObjects: false,
};

/** Ground plane on the SAME global lot grid the layout uses. Unlit. */
function createGround(P, originCellX, originCellZ) {
  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const uPitch = uniform(pitch);
  const uBuilt = uniform(P.blockLots * P.lotSize);
  const uOrigin = uniform(new THREE.Vector2(originCellX * P.lotSize, originCellZ * P.lotSize));
  const uStreet = uniform(new THREE.Color(P.streetColor));
  const uBlock = uniform(new THREE.Color(P.blockColor));

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "CityGround";
  mat.colorNode = Fn(() => {
    const local = positionWorld.xz.sub(uOrigin);
    const inBlock = fract(local.div(uPitch)).mul(uPitch);
    const half = uBuilt.mul(0.5);
    const dx = abs(inBlock.x.sub(half));
    const dz = abs(inBlock.y.sub(half));
    const aa = max(fwidth(positionWorld.x), fwidth(positionWorld.z)).mul(0.5).add(0.01);
    const onBlock = smoothstep(half.add(aa), half.sub(aa), max(dx, dz));
    return vec4(mix(uStreet, uBlock, onBlock), 1.0);
  })();

  const g = new THREE.PlaneGeometry(P.extent * 2.6, P.extent * 2.6);
  g.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(P.centerX, P.groundY, P.centerZ);
  mesh.name = "CityGround";
  mesh.receiveShadow = true;
  return { mesh };
}

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
 */
export function createModularRoadCity({
  seed = 20260902,
  params = {},
  facadeParams = {},
  kitParams = {},
  avoid = null,
  heightAt = null,
} = {}) {
  const P = { ...CITY_DEFAULTS, ...params };

  const group = new THREE.Group();
  group.name = "City";

  const facade = createCityFacadeMaterial({
    params: { lotSize: P.lotSize, groundY: P.groundY, ...facadeParams },
  });

  let kit = buildCityKit({ seed, params: kitParams });

  let ground = null;
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

    // Landmarks sort to the end of the kit; the ordinary pick excludes them.
    const normalCount = kit.archetypes.length - (kit.stats.landmarks ?? 0);

    let culledCorridor = 0, culledSlope = 0, culledBounds = 0;
    const districts = [0, 0, 0];
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

        out.push({ x, y: baseY, z, top, arch, scaleY, cx, cz, r, district, tier: -1 });
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
      }
    }
    facade.lotHeights.texture.needsUpdate = true;
    stats.culledCorridor = culledCorridor;
    stats.culledSlope = culledSlope;
    stats.culledBounds = culledBounds;
    stats.districts = districts;
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
        const im = new THREE.InstancedMesh(g, facade.material, perArch[ai]);
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
        lobbyHeight: facade.params.lobbyHeight, params: P.signParams, lotRand,
      });
      group.add(signs.group);
      stats.signs = signs.stats;
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

  function applyLod(camPos) {
    const t0 = performance.now();
    let changed = 0;
    const counts = [0, 0, 0];
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      const dx = b.x - camPos.x, dz = b.z - camPos.z;
      const dy = (b.y + b.top) * 0.5 - camPos.y;
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
      const t = tierFor(dist, b.tier);
      if (t !== b.tier) {
        b.tier = t;
        changed++;
        if (batched) batched.setGeometryIdAt(batchInstIds[i], batchGeomIds[b.arch][t]);
      }
      counts[t]++;
    }
    if (instanced && changed > 0) {
      for (const row of instanced) for (const im of row) if (im) im.count = 0;
      for (const b of buildings) {
        const im = instanced[b.arch][b.tier];
        if (!im) continue;
        im.setMatrixAt(im.count++, matrixFor(b, _m));
      }
      for (const row of instanced) for (const im of row) {
        if (!im) continue;
        im.instanceMatrix.needsUpdate = true;
        im.visible = im.count > 0;
      }
    }
    stats.lod = counts;
    stats.lastLodMs = performance.now() - t0;
    return changed;
  }

  // ── Ground ─────────────────────────────────────────────────────────────────
  function syncGround() {
    if (ground) {
      group.remove(ground.mesh);
      ground.mesh.geometry.dispose();
      ground.mesh.material.dispose();
      ground = null;
    }
    if (P.ground) {
      ground = createGround(P, originCellX, originCellZ);
      group.add(ground.mesh);
    }
  }

  // ── Build / rebuild ────────────────────────────────────────────────────────
  function rebuild() {
    const t0 = performance.now();
    clearBackend();
    buildings = layout();
    stats.buildings = buildings.length;
    if (P.backend === "instanced") buildInstanced();
    else buildBatched();
    buildExtras();
    syncGround();
    _lodT = 1e9;
    stats.lastBuildMs = performance.now() - t0;
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  let _lodT = 1e9;
  const _lastLodPos = new THREE.Vector3(1e9, 1e9, 1e9);

  function update(dt, camera) {
    if (!enabled) return;
    // One clock for the window churn, the screens and the beacons; one night
    // value, read off the facade proxy the game already drives.
    _clock += dt;
    uTime.value = _clock;
    facade.setTime(_clock);
    const night = facade.params.nightAmount;
    uNight.value = night;
    if (signs) { signs.setNight(night); signs.setTime(_clock); }

    _lodT += dt;
    const moved = camera.position.distanceTo(_lastLodPos);
    if (_lodT < P.lodInterval && moved < P.lodMoveDist) return;
    _lodT = 0;
    _lastLodPos.copy(camera.position);
    applyLod(camera.position);
  }

  rebuild();

  return {
    group,
    params: P,
    facade: facade.params,
    facadeMaterial: facade.material,
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
      if (ground) { ground.mesh.geometry.dispose(); ground.mesh.material.dispose(); }
      facade.material.dispose();
      facade.lotHeights.texture.dispose();
    },
  };
}
