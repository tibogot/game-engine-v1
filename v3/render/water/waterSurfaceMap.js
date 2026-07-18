/**
 * v3/render/water/waterSurfaceMap.js — top-down "where is water, and how high" map.
 *
 * A single small RT over the whole world whose R channel holds the WATER SURFACE
 * WORLD Y at that XZ, or NO_WATER_Y where there is none. The terrain shader samples
 * it to know how deep under water each fragment is (depth = waterY - terrainY), which
 * drives the lakebed tint + caustics (see lakebedTsl.js) — the terrain-side half of
 * the revo-realms water look.
 *
 * How it works: on demand, every live water mesh (lake quads + River+ ribbons) is
 * borrowed into a private scene, its material swapped for one that writes
 * positionWorld.y, and rendered once through a top-down orthographic camera. Depth
 * test keeps the HIGHEST surface where waters overlap. A world-sized floor plane at
 * NO_WATER_Y guarantees "no water" everywhere else, so no clear-color fiddling.
 *
 * Water meshes deliberately overhang dry land (the lake bounds quad, the ribbon's
 * carve footprint) — that is fine here for the same reason it is fine on screen:
 * where the surface overhangs, the terrain sits ABOVE the written water Y, the
 * depth goes negative and the lakebed mask is zero.
 *
 * The bake is lazy: systems call markDirty() when water geometry changes and the
 * main loop calls bakeIfNeeded() once per frame. One 1024² ortho render of a
 * handful of quads — cheap enough to re-run every frame of a drag.
 *
 * Camera orientation copies the grass-tint bake in main.js exactly (left/right
 * swapped, up = +Z, flipY = false) so the shader-side UV is the same
 * worldXZ / worldSize + 0.5 mapping every other world map here uses.
 */

import * as THREE from "three";
import { positionWorld, vec4 } from "three/tsl";

/** Written wherever there is no water. Well below any terrain the engine makes. */
export const NO_WATER_Y = -100;

/**
 * @param {object} opts
 * @param {number} opts.worldSize  — metres covered by the map (world is centred on 0)
 * @param {number} opts.maxHeight — highest possible water level, for the camera range
 * @param {number} [opts.resolution=1024]
 */
export function createWaterSurfaceMap({ worldSize, maxHeight, resolution = 1024 }) {
  // Half float: filterable (fp32 is not, without an optional WebGPU feature) and
  // plenty — a water level is one constant per lake, ±0.25 m at worst near the top
  // of the height range, and the shoreline itself still comes from the depth buffer.
  // RGBA rather than Red: every RT in this engine is RGBA (see sculptBrush's
  // heightmap RT) — the one proven-renderable format across backends.
  const rt = new THREE.RenderTarget(resolution, resolution, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    colorSpace: THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  rt.texture.name = "WaterSurfaceY";

  const scene = new THREE.Scene();

  // Frustum axes measured empirically against the terrain shader's
  // `worldXZ / worldSize + 0.5` sampling (lake at +300/+200, ghost at +300/-200
  // before the fix):
  //  - left/right swapped because a straight-down lookAt with up=(0,0,1)
  //    mirrors world X in camera space (same as main.js's grass-tint bake);
  //  - top/bottom ALSO swapped because WebGPU puts NDC +Y at texel ROW 0, so an
  //    unswapped frustum lands world +Z at v=0 — mirroring the map in Z.
  const camY = maxHeight + 10;
  const camera = new THREE.OrthographicCamera(
    worldSize / 2, -worldSize / 2, -worldSize / 2, worldSize / 2,
    1, camY - NO_WATER_Y + 10,
  );
  camera.position.set(0, camY, 0);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  // Writes the surface's world height; DoubleSide because river ribbons wind
  // either way depending on centreline curvature.
  const heightMat = new THREE.MeshBasicNodeMaterial();
  heightMat.colorNode = vec4(positionWorld.y, 0, 0, 1);
  heightMat.side = THREE.DoubleSide;
  heightMat.fog = false;

  // "No water" floor — always rendered, always underneath every real surface.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(worldSize, worldSize), heightMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = NO_WATER_Y;
  floor.frustumCulled = false;
  scene.add(floor);

  /** @type {() => THREE.Object3D[]} set once systems exist; may return groups. */
  let sourceProvider = null;
  let dirty = true;

  function setSourceProvider(fn) { sourceProvider = fn; markDirty(); }
  function markDirty() { dirty = true; }

  const _borrowed = [];   // { obj, parent }
  const _swapped  = [];   // { mesh, material }

  function bakeIfNeeded(renderer) {
    if (!dirty || !sourceProvider) return;
    dirty = false;

    // Borrow the live meshes: reparent into the bake scene and swap materials.
    // All water parents are identity transforms, so plain add/re-add is exact.
    for (const obj of sourceProvider()) {
      if (!obj) continue;
      _borrowed.push({ obj, parent: obj.parent });
      scene.add(obj);
      obj.traverse((c) => {
        if (c.isMesh) {
          _swapped.push({ mesh: c, material: c.material });
          c.material = heightMat;
        }
      });
    }

    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(prevRT);

    for (const { mesh, material } of _swapped) mesh.material = material;
    for (const { obj, parent } of _borrowed) {
      if (parent) parent.add(obj);
      else scene.remove(obj);
    }
    _swapped.length = 0;
    _borrowed.length = 0;
  }

  return { texture: rt.texture, setSourceProvider, markDirty, bakeIfNeeded };
}
