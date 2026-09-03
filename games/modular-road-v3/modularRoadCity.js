// ============================================================================
// CITY — layout, batching and LOD for the skyline the track flies through.
//
// One material (modularRoadCityFacade.js), a handful of shared archetype
// geometries (modularRoadCityKit.js), and N transforms. This file is the part
// that decides WHERE the towers go and HOW they reach the GPU.
//
// ── TWO BACKENDS — AND THE MEASUREMENT THAT PICKED ONE ───────────────────────
//
// INSTANCED IS THE DEFAULT, and the reason is not the one you would expect.
//
// BatchedMesh is advertised as collapsing a whole batch into ONE draw call.
// That is a WebGL2 property, not a WebGPU one: it rides on the
// `WEBGL_multi_draw` extension, and you can see the check in three.webgpu.js —
// `if ( isBatchedMesh && ext.has( 'WEBGL_multi_draw' ) )`. WebGPU has no
// multi-draw in the base spec, so the WebGPU backend falls back to issuing ONE
// DRAW PER VISIBLE INSTANCE. A "single" BatchedMesh city is therefore about as
// many draw calls as it has towers on screen.
//
// Measured in city-lab.html, 2411 buildings, deck viewpoint, r184, 60 fps
// throughout (GPU timestamp averaged over ~150 frames in a FOREGROUND tab —
// a backgrounded tab throttles rAF and every number comes out garbage):
//
//   backend                draws    GPU        triangles
//   ────────────────────────────────────────────────────
//   instanced, no shadows     34    0.47 ms    60k
//   instanced + shadows       41    0.48 ms    62k
//   batched,   no shadows   1150    0.69 ms    26k
//   batched,   + shadows     600    0.62 ms    32k
//   city off (baseline)        5    0.22 ms     1k
//
// So the whole city costs ~0.25 ms, and instanced wins on draws by 34× and on
// time by 32%. It does submit 2.3× the triangles — BatchedMesh frustum-culls
// per instance whereas the InstancedMeshes are `frustumCulled = false` and hand
// over every instance of a tier — and it is STILL faster, which is the clearest
// possible statement that this workload is not triangle-bound.
//
// Per viewpoint, instanced, no shadows: deck 0.46 ms / street 0.64 / canyon
// 0.80 / skyline 0.25 / drive-by 0.40. Canyon is the worst case exactly as
// predicted — tall near geometry filling the screen is fragment cost.
//
//   INSTANCED (THREE.InstancedMesh per archetype per LOD tier)
//     + ~34 draws instead of ~1150.
//     + castShadow is per mesh, and there is one mesh per TIER, so distant
//       towers drop out of the shadow pass entirely. BatchedMesh cannot express
//       this at all — see the shadow note below.
//     + No per-frame CPU between LOD recomputes.
//     − An LOD change rewrites matrix buffers rather than one integer. This is
//       what `lodInterval` / `lodMoveDist` / `lodHysteresis` are protecting;
//       measured at ~0.1 ms for 2411 buildings, and not every frame.
//     − No per-instance frustum culling, hence the triangle count above.
//
// BATCHED is kept, switchable at runtime (B in the lab), because it is the
// better shape on paper and would win the moment three's WebGPU backend gains
// an indirect multi-draw path. It is also the honest control for the numbers
// above — delete it and the table becomes an assertion instead of a result.
//
// ── SHADOWS ARE THE REAL COST, NOT DRAWS ─────────────────────────────────────
//
// A skyscraper is an enormous occluder. Every tower added to the shadow pass is
// a second draw of its geometry AND inflates the cascade bounds, which spends
// shadow-map resolution on geometry nowhere near the road. Worse, in this
// game's DEFAULT sky mode the track sits hundreds of metres above the city, so
// a tower's shadow lands on ground the player never touches. So the default
// here is: shadows only from the L0 tier, and off entirely unless asked for.
//
// ── LAYOUT: BLOCKS AND LOTS ──────────────────────────────────────────────────
//
// Buildings sit one per LOT, inset, on an axis-aligned grid of BLOCKS separated
// by streets. This is not just for looks — the facade shader identifies a
// building by its lot cell (`floor(worldXZ / lotSize)`), so one-building-
// per-lot-inset is a hard contract, not a stylistic choice. Break it and
// neighbouring towers share a tint and a window seed.
//
// Height comes from a downtown falloff: a smooth centre bias times a random
// term, then quantised onto the kit's height-sorted archetypes. A flat random
// pick gives a hedge; the falloff gives a skyline.
// ============================================================================
import * as THREE from "three";
import { Fn, vec4, uniform, positionWorld, fract, abs, max, smoothstep, mix, fwidth } from "three/tsl";
import { buildCityKit, disposeCityKit, mulberry32 } from "./modularRoadCityKit.js";
import { createCityFacadeMaterial } from "./modularRoadCityFacade.js";

export const CITY_DEFAULTS = {
  /** Half-extent of the built area, metres. 1200 = a 2.4 km city. */
  extent: 1200,
  /** Lot pitch. MUST equal the facade's lotSize. */
  lotSize: 34,
  /** Lots per block edge, and the street between blocks. */
  blockLots: 4,
  streetWidth: 22,
  /** Chance a lot gets a building at all. Gaps read as yards, plazas, car parks. */
  density: 0.86,

  /** Downtown: heights bias toward this point, falling off over `extent`. */
  centerX: 0,
  centerZ: 0,
  /** Higher = tighter, more dramatic downtown core. */
  downtownPower: 2.2,
  /** Randomness mixed against the falloff. 0 = pure cone, 1 = pure noise. */
  heightNoise: 0.55,

  /** Per-instance Y-scale range applied on top of the archetype's own height.
   *  This is what turns 14 archetypes into a continuous height distribution.
   *  X and Z are NEVER scaled — the facade's window pitch is in world metres
   *  and an XZ scale would stretch it off the grid. */
  scaleYMin: 0.75,
  scaleYMax: 1.45,

  /** Keep-out corridor half-width around whatever `avoid` describes, metres. */
  avoidRadius: 40,

  /** LOD ring radii, metres. */
  lod0Dist: 220,
  lod1Dist: 850,
  /** Hysteresis band so a tower on a boundary does not flicker between tiers. */
  lodHysteresis: 30,
  /** Recompute LOD at most this often, and only if the camera moved this far. */
  lodInterval: 0.2,
  lodMoveDist: 12,

  /** Shadows. `shadowDist` only applies to the instanced backend — BatchedMesh
   *  cannot gate castShadow per tier. */
  castShadows: false,

  /** Streets + block ground plane. Cheap, but without it the towers float. */
  ground: true,
  groundY: 0,
  streetColor: 0x1b1d21,
  blockColor: 0x2c2e33,

  /** 'batched' | 'instanced'. Instanced by default — BatchedMesh is NOT one
   *  draw on WebGPU, it is one per visible instance. See the header table. */
  backend: "instanced",
  /** BatchedMesh knobs, exposed because they are per-frame CPU. */
  perObjectFrustumCulled: true,
  sortObjects: false,
};

/**
 * Ground plane carrying the block/street pattern, derived from the SAME grid the
 * layout uses so the streets actually line up with the gaps between towers.
 *
 * Unlit on purpose: it is a backdrop under a city that will mostly be seen at
 * night or from far above, and a lit plane this large is pure fill cost for a
 * flat result. `fwidth` AA on the street edge for the same reason the facade
 * needs it — a hard step on a ground plane at a grazing angle is a shimmer
 * generator.
 */
function createGround(P) {
  const uBlockPitch = uniform(P.blockLots * P.lotSize + P.streetWidth);
  const uBuilt = uniform(P.blockLots * P.lotSize);
  const uStreet = uniform(new THREE.Color(P.streetColor));
  const uBlock = uniform(new THREE.Color(P.blockColor));

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.name = "CityGround";
  mat.colorNode = Fn(() => {
    const c = positionWorld.xz.div(uBlockPitch);
    const inBlock = fract(c).mul(uBlockPitch);
    const half = uBuilt.mul(0.5);
    const dx = abs(inBlock.x.sub(uBlockPitch.mul(0.5)));
    const dz = abs(inBlock.y.sub(uBlockPitch.mul(0.5)));
    const aa = max(fwidth(positionWorld.x), fwidth(positionWorld.z)).mul(0.5).add(0.01);
    const onBlock = smoothstep(half.add(aa), half.sub(aa), max(dx, dz));
    return vec4(mix(uStreet, uBlock, onBlock), 1.0);
  })();

  const g = new THREE.PlaneGeometry(P.extent * 2.6, P.extent * 2.6);
  g.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.y = P.groundY;
  mesh.name = "CityGround";
  mesh.receiveShadow = true;
  return { mesh, uniforms: { uBlockPitch, uBuilt, uStreet, uBlock } };
}

/**
 * @param {object}   [opts]
 * @param {number}   [opts.seed]
 * @param {object}   [opts.params]       overrides on CITY_DEFAULTS
 * @param {object}   [opts.facadeParams] overrides on FACADE_DEFAULTS
 * @param {object}   [opts.kitParams]    overrides on KIT_DEFAULTS
 * @param {(x:number,z:number)=>number} [opts.avoid]
 *   Distance in metres from the thing the city must keep clear of (the track).
 *   Return Infinity for "nothing near here". Lots closer than `avoidRadius`
 *   are left empty.
 */
export function createModularRoadCity({
  seed = 20260902,
  params = {},
  facadeParams = {},
  kitParams = {},
  avoid = null,
} = {}) {
  const P = { ...CITY_DEFAULTS, ...params };

  const group = new THREE.Group();
  group.name = "City";

  // The facade's lot grid and the layout's lot grid are the same grid. Wiring
  // it here rather than trusting two defaults to agree.
  const facade = createCityFacadeMaterial({
    params: { lotSize: P.lotSize, groundY: P.groundY, ...facadeParams },
  });

  let kit = buildCityKit({ seed, params: kitParams });

  let ground = null;
  let buildings = [];          // { x, z, arch, scaleY, tier }
  let batched = null;          // BatchedMesh
  let batchGeomIds = null;     // [arch][tier] -> geometryId
  let batchInstIds = null;     // building index -> instanceId
  let instanced = null;        // [arch][tier] -> InstancedMesh
  let enabled = true;

  const stats = {
    buildings: 0, lod: [0, 0, 0], meshes: 0, kit: kit.stats,
    lastLodMs: 0, lastBuildMs: 0,
  };

  // ── Layout ─────────────────────────────────────────────────────────────────
  function layout() {
    const rnd = mulberry32(seed ^ 0x9e3779b9);
    const out = [];
    const blockPitch = P.blockLots * P.lotSize + P.streetWidth;
    const nBlocks = Math.ceil((P.extent * 2) / blockPitch);
    const originX = P.centerX - (nBlocks * blockPitch) / 2;
    const originZ = P.centerZ - (nBlocks * blockPitch) / 2;

    for (let bx = 0; bx < nBlocks; bx++) {
      for (let bz = 0; bz < nBlocks; bz++) {
        for (let lx = 0; lx < P.blockLots; lx++) {
          for (let lz = 0; lz < P.blockLots; lz++) {
            // Lot CENTRE. The facade hashes floor(worldXZ / lotSize), so a
            // building must stay inside one such cell — hence the kit's
            // footprints being capped below lotSize and no XZ scaling anywhere.
            const x = originX + bx * blockPitch + (lx + 0.5) * P.lotSize;
            const z = originZ + bz * blockPitch + (lz + 0.5) * P.lotSize;

            const dx = x - P.centerX, dz = z - P.centerZ;
            const r = Math.hypot(dx, dz);
            if (r > P.extent) continue;
            if (rnd() > P.density) continue;
            if (avoid && avoid(x, z) < P.avoidRadius) continue;

            // Downtown falloff mixed with noise, then mapped onto the
            // height-sorted archetype list.
            const fall = Math.pow(Math.max(0, 1 - r / P.extent), P.downtownPower);
            const t = THREE.MathUtils.clamp(
              fall * (1 - P.heightNoise) + rnd() * P.heightNoise * fall * 1.6,
              0, 0.999,
            );
            const arch = Math.floor(t * kit.archetypes.length);
            const scaleY = P.scaleYMin + rnd() * (P.scaleYMax - P.scaleYMin);

            out.push({ x, z, arch, scaleY, tier: -1 });
          }
        }
      }
    }
    return out;
  }

  // ── Backends ───────────────────────────────────────────────────────────────
  const _m = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _scl = new THREE.Vector3();

  function matrixFor(b, out) {
    _pos.set(b.x, P.groundY, b.z);
    _scl.set(1, b.scaleY, 1);          // XZ scale is fixed at 1 — see the header
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
    batched = new THREE.BatchedMesh(buildings.length, verts, idx, facade.material);
    batched.name = "CityBatched";
    batched.perObjectFrustumCulled = P.perObjectFrustumCulled;
    batched.sortObjects = P.sortObjects;
    batched.castShadow = P.castShadows;
    batched.receiveShadow = true;
    // BatchedMesh's own bounds are computed from instances; the city is static
    // so this is a one-off, but frustum culling the WHOLE batch would cull the
    // city as a unit — the per-object pass above is what actually culls.
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
    // Per (archetype, tier) capacity is that archetype's whole population,
    // because every one of them can be in the same tier at once.
    const perArch = new Array(kit.archetypes.length).fill(0);
    for (const b of buildings) perArch[b.arch]++;

    instanced = kit.archetypes.map((a, ai) =>
      a.lods.map((g, tier) => {
        if (perArch[ai] === 0) return null;
        const im = new THREE.InstancedMesh(g, facade.material, perArch[ai]);
        im.name = `CityInst_a${ai}_l${tier}`;
        im.count = 0;
        im.frustumCulled = false;   // the LOD pass already bounds these by distance
        im.receiveShadow = true;
        // ONLY the near tier casts. This is the option BatchedMesh cannot give
        // you, and on a city it is the biggest single lever there is.
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
  }

  // ── LOD ────────────────────────────────────────────────────────────────────
  function tierFor(dist, current) {
    // Hysteresis: a tower only steps UP in detail once it is well inside the
    // ring, and only steps down once well outside it.
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
      const dy = P.groundY - camPos.y;
      const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
      const t = tierFor(dist, b.tier);
      if (t !== b.tier) {
        b.tier = t;
        changed++;
        // Batched LOD is one integer write. This is the backend's best trick.
        if (batched) batched.setGeometryIdAt(batchInstIds[i], batchGeomIds[b.arch][t]);
      }
      counts[t]++;
    }

    // Instanced LOD needs the matrix buffers refilled. Only when something
    // actually moved tier — that is what the hysteresis and the interval are
    // protecting.
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

  // ── Build / rebuild ────────────────────────────────────────────────────────
  function rebuild() {
    const t0 = performance.now();
    clearBackend();
    buildings = layout();
    stats.buildings = buildings.length;

    if (P.backend === "instanced") buildInstanced();
    else buildBatched();

    if (P.ground) {
      if (ground) { group.remove(ground.mesh); ground.mesh.geometry.dispose(); }
      ground = createGround(P);
      group.add(ground.mesh);
    } else if (ground) {
      group.remove(ground.mesh);
      ground.mesh.geometry.dispose();
      ground = null;
    }

    // Force a full LOD assignment on the next update.
    for (const b of buildings) if (P.backend === "instanced") b.tier = -1;
    _lodT = 1e9;
    stats.lastBuildMs = performance.now() - t0;
  }

  // ── Update ─────────────────────────────────────────────────────────────────
  let _lodT = 1e9;
  const _lastLodPos = new THREE.Vector3(1e9, 1e9, 1e9);

  function update(dt, camera) {
    if (!enabled) return;
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

    rebuild,
    update,

    /** Rebake the archetype set (a kit param changed). */
    rebuildKit(kitOverrides) {
      clearBackend();
      disposeCityKit(kit);
      kit = buildCityKit({ seed, params: { ...kitParams, ...kitOverrides } });
      stats.kit = kit.stats;
      rebuild();
    },

    setSeed(s) { seed = s >>> 0; rebuild(); },

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

    /** Enrol every city mesh on a layer — for the wet-road planar reflection,
     *  which renders exactly what is on its layer and nothing else. */
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
    },
  };
}
