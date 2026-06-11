import * as THREE from "three";
import { chunkKey, chunkMinWorldX, chunkMinWorldZ } from "../../core/terrain/chunkMath.js";
import { getChunkPerimeterRingIndices, TerrainGeometryPool } from "./terrainGeometryPool.js";

const _terrainHfN = new THREE.Vector3();
const _stitchN0 = new THREE.Vector3();
const _stitchN1 = new THREE.Vector3();

export class TerrainMesher {
  constructor(config) {
    this.config = config;
    this.pool = new TerrainGeometryPool(config);
  }

  createChunkMesh(cx, cz, segments, terrainStore, material, neighborSegments) {
    const geometry = this.pool.acquire(segments);
    this.applyChunkHeightsToGeometry(
      geometry,
      cx,
      cz,
      segments,
      terrainStore,
      neighborSegments,
      null,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    // Bounding spheres are recomputed on every rebuild/remesh (incl. skirt
    // verts), so per-chunk frustum culling is safe and cuts off-screen draws.
    mesh.frustumCulled = true;
    mesh.userData.chunk = { cx, cz, segments };
    installTerrainSkirtSafeRaycast(mesh);
    mesh.position.set(
      chunkMinWorldX(cx, this.config) + this.config.world.chunkSize * 0.5,
      0,
      chunkMinWorldZ(cz, this.config) + this.config.world.chunkSize * 0.5,
    );
    return mesh;
  }

  remesh(mesh, cx, cz, segments, terrainStore, neighborSegments, dirtyRect = null) {
    const oldSegments = mesh.userData.chunk?.segments ?? segments;
    if (oldSegments !== segments) {
      // LOD change — can't use incremental path, geometry has different topology.
      this.pool.release(oldSegments, mesh.geometry);
      mesh.geometry = this.pool.acquire(segments);
      mesh.userData.chunk = { cx, cz, segments };
      this.applyChunkHeightsToGeometry(
        mesh.geometry,
        cx,
        cz,
        segments,
        terrainStore,
        neighborSegments,
        null,
      );
      return;
    }

    if (dirtyRect) {
      this.applyIncrementalUpdate(
        mesh.geometry,
        cx,
        cz,
        segments,
        terrainStore,
        neighborSegments,
        dirtyRect,
      );
      return;
    }

    this.applyChunkHeightsToGeometry(
      mesh.geometry,
      cx,
      cz,
      segments,
      terrainStore,
      neighborSegments,
      null,
    );
  }

  disposeChunkMesh(mesh) {
    const segments = mesh.userData.chunk?.segments ?? this.config.lod.levels[0].segments;
    this.pool.release(segments, mesh.geometry);
  }

  /**
   * Full rebuild. Only Y values + normals are written — XZ/UV come from the
   * template and never change after acquire().
   */
  applyChunkHeightsToGeometry(geometry, cx, cz, segments, terrainStore, neighborSegments) {
    const pos = geometry.attributes.position;
    const baseVertCount = geometry.userData.baseVertCount ?? (segments + 1) * (segments + 1);
    const posArr = pos.array;
    const res = this.config.world.dataResolution;
    const cs = this.config.world.chunkSize;
    const chunkMinX = chunkMinWorldX(cx, this.config);
    const chunkMinZ = chunkMinWorldZ(cz, this.config);

    const heights = terrainStore.ensureChunkData(cx, cz);
    const stride = res + 1;

    // Write Y for every mesh vertex by sampling this chunk's heightfield only.
    // Inline bilinear — no Map lookups in the hot loop.
    const w = segments + 1;
    for (let iz = 0; iz <= segments; iz++) {
      const v = (iz / segments) * res;
      const z0 = Math.floor(v);
      const z1 = z0 >= res ? res : z0 + 1;
      const tz = v - z0;
      for (let ix = 0; ix <= segments; ix++) {
        const u = (ix / segments) * res;
        const x0 = Math.floor(u);
        const x1 = x0 >= res ? res : x0 + 1;
        const tx = u - x0;
        const h00 = heights[z0 * stride + x0];
        const h10 = heights[z0 * stride + x1];
        const h01 = heights[z1 * stride + x0];
        const h11 = heights[z1 * stride + x1];
        const hy =
          h00 * (1 - tx) * (1 - tz) +
          h10 * tx * (1 - tz) +
          h01 * (1 - tx) * tz +
          h11 * tx * tz;
        posArr[(iz * w + ix) * 3 + 1] = hy;
      }
    }

    let normal = geometry.attributes.normal;
    if (!normal || normal.count !== pos.count) {
      normal = new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3);
      geometry.setAttribute("normal", normal);
    }
    const nArr = normal.array;
    const eps = cs / res;

    for (let iz = 0; iz <= segments; iz++) {
      for (let ix = 0; ix <= segments; ix++) {
        const { wx, wz } = chunkMeshWorldXZ(chunkMinX, chunkMinZ, cs, segments, ix, iz);
        sampleHeightfieldNormal(wx, wz, eps, terrainStore, _terrainHfN);
        const i3 = (iz * w + ix) * 3;
        nArr[i3] = _terrainHfN.x;
        nArr[i3 + 1] = _terrainHfN.y;
        nArr[i3 + 2] = _terrainHfN.z;
      }
    }

    if (neighborSegments) {
      snapLodBoundaries({
        pos,
        normal,
        segments,
        cx,
        cz,
        chunkMinX,
        chunkMinZ,
        terrainStore,
        neighborSegments,
        eps,
      });
    }

    if (pos.count > baseVertCount) {
      syncSkirtRing({
        pos,
        normal,
        segments,
        skirtDepth: this.config.render.terrainSkirtDepth,
      });
    }

    pos.needsUpdate = true;
    normal.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  /**
   * Incremental update: only rewrite mesh vertices within the mesh-vertex rect
   * implied by `dirtyRect` (heightfield grid coords). Normals recomputed in the
   * same region, expanded by 1 for central-difference continuity.
   */
  applyIncrementalUpdate(geometry, cx, cz, segments, terrainStore, neighborSegments, dirtyRect) {
    const pos = geometry.attributes.position;
    const normal = geometry.attributes.normal;
    const posArr = pos.array;
    const nArr = normal.array;
    const baseVertCount = geometry.userData.baseVertCount ?? (segments + 1) * (segments + 1);
    const res = this.config.world.dataResolution;
    const cs = this.config.world.chunkSize;
    const chunkMinX = chunkMinWorldX(cx, this.config);
    const chunkMinZ = chunkMinWorldZ(cz, this.config);

    const heights = terrainStore.ensureChunkData(cx, cz);
    const stride = res + 1;
    const w = segments + 1;

    // Map heightfield dirty rect → mesh vertex rect. A heightfield vertex at
    // index ix affects mesh vertices whose u = mx*res/segs lies in [ix-1, ix+1]
    // (bilinear support). So mesh rect = dirty ± 1 in heightfield space, then
    // scale by segments/res, clamped to [0, segments].
    const sR = segments / res;
    const mMinX = Math.max(0, Math.floor((dirtyRect.minIx - 1) * sR));
    const mMaxX = Math.min(segments, Math.ceil((dirtyRect.maxIx + 1) * sR));
    const mMinZ = Math.max(0, Math.floor((dirtyRect.minIz - 1) * sR));
    const mMaxZ = Math.min(segments, Math.ceil((dirtyRect.maxIz + 1) * sR));
    if (mMinX > mMaxX || mMinZ > mMaxZ) return;

    // Rewrite Y only in the mesh rect.
    for (let iz = mMinZ; iz <= mMaxZ; iz++) {
      const v = (iz / segments) * res;
      const z0 = Math.floor(v);
      const z1 = z0 >= res ? res : z0 + 1;
      const tz = v - z0;
      for (let ix = mMinX; ix <= mMaxX; ix++) {
        const u = (ix / segments) * res;
        const x0 = Math.floor(u);
        const x1 = x0 >= res ? res : x0 + 1;
        const tx = u - x0;
        const h00 = heights[z0 * stride + x0];
        const h10 = heights[z0 * stride + x1];
        const h01 = heights[z1 * stride + x0];
        const h11 = heights[z1 * stride + x1];
        const hy =
          h00 * (1 - tx) * (1 - tz) +
          h10 * tx * (1 - tz) +
          h01 * (1 - tx) * tz +
          h11 * tx * tz;
        posArr[(iz * w + ix) * 3 + 1] = hy;
      }
    }

    // Expand the rect by 1 for normal-pass margin so normals at the boundary
    // of the sculpted region blend into the surrounding surface smoothly.
    const nMinX = Math.max(0, mMinX - 1);
    const nMaxX = Math.min(segments, mMaxX + 1);
    const nMinZ = Math.max(0, mMinZ - 1);
    const nMaxZ = Math.min(segments, mMaxZ + 1);

    const eps = cs / res;

    for (let iz = nMinZ; iz <= nMaxZ; iz++) {
      for (let ix = nMinX; ix <= nMaxX; ix++) {
        const { wx, wz } = chunkMeshWorldXZ(chunkMinX, chunkMinZ, cs, segments, ix, iz);
        sampleHeightfieldNormal(wx, wz, eps, terrainStore, _terrainHfN);
        const i3 = (iz * w + ix) * 3;
        nArr[i3] = _terrainHfN.x;
        nArr[i3 + 1] = _terrainHfN.y;
        nArr[i3 + 2] = _terrainHfN.z;
      }
    }

    // Re-snap any LOD-seam edge that falls inside the dirty mesh rect.
    if (neighborSegments) {
      snapLodBoundariesPartial({
        pos,
        normal,
        segments,
        cx,
        cz,
        chunkMinX,
        chunkMinZ,
        terrainStore,
        neighborSegments,
        eps,
        mMinX,
        mMaxX,
        mMinZ,
        mMaxZ,
      });
    }

    // If the rect touches the chunk perimeter, skirt ring follows.
    if (
      pos.count > baseVertCount &&
      (mMinX === 0 || mMaxX === segments || mMinZ === 0 || mMaxZ === segments)
    ) {
      syncSkirtRing({
        pos,
        normal,
        segments,
        skirtDepth: this.config.render.terrainSkirtDepth,
      });
    }

    pos.needsUpdate = true;
    normal.needsUpdate = true;
    // Bounding sphere may have grown — recompute. Cheap compared to the
    // full-rebuild path we skipped.
    geometry.computeBoundingSphere();
  }
}

/**
 * World XZ for mesh vertex (ix, iz) on the chunk plane — snaps perimeter verts
 * to exact chunk bounds so adjacent chunks share bit-identical coordinates at seams.
 */
function chunkMeshWorldXZ(chunkMinX, chunkMinZ, cs, segments, ix, iz) {
  const wx =
    ix <= 0 ? chunkMinX : ix >= segments ? chunkMinX + cs : chunkMinX + (ix / segments) * cs;
  const wz =
    iz <= 0 ? chunkMinZ : iz >= segments ? chunkMinZ + cs : chunkMinZ + (iz / segments) * cs;
  return { wx, wz };
}

/**
 * FD normal at world (x,z) — v1 `heightfieldNormalAt`: all four taps go through
 * `getChunkHeightfieldHeight` so chunk boundaries are continuous for lighting.
 */
function sampleHeightfieldNormal(worldX, worldZ, eps, terrainStore, out) {
  const inv2eps = 1 / (2 * eps);
  const hL = terrainStore.getChunkHeightfieldHeight(worldX - eps, worldZ);
  const hR = terrainStore.getChunkHeightfieldHeight(worldX + eps, worldZ);
  const hD = terrainStore.getChunkHeightfieldHeight(worldX, worldZ - eps);
  const hU = terrainStore.getChunkHeightfieldHeight(worldX, worldZ + eps);
  out.set((hL - hR) * inv2eps, 1, (hD - hU) * inv2eps).normalize();
}

function snapLodBoundaries({
  pos,
  normal,
  segments,
  cx,
  cz,
  chunkMinX,
  chunkMinZ,
  terrainStore,
  neighborSegments,
  eps,
}) {
  const cs = terrainStore.config.world.chunkSize;
  const dataScale =
    terrainStore.config.world.dataResolution / terrainStore.config.world.chunkSize;
  const snapped = new Uint8Array(pos.count);
  let any = false;

  const runEdge = (edge, neighborSeg, ncx, ncz, axis, neighborBoundary) => {
    if (neighborSeg == null || neighborSeg >= segments) return;
    for (let k = 0; k <= segments; k++) {
      const t = segments > 0 ? k / segments : 0;
      const wz = axis === "z" ? chunkMinZ + t * cs : 0;
      const wx = axis === "z" ? 0 : chunkMinX + t * cs;
      const wxFinal =
        axis === "z"
          ? edge === "east"
            ? chunkMinX + cs
            : chunkMinX
          : wx;
      const wzFinal =
        axis === "z"
          ? wz
          : edge === "south"
            ? chunkMinZ + cs
            : chunkMinZ;
      const y = sampleCoarseNeighborEdgeY({
        terrainStore,
        ncx,
        ncz,
        neighborSeg,
        wx: wxFinal,
        wz: wzFinal,
        axis,
        neighborBoundary,
        dataScale,
      });
      const vi = vertexIndexOnEdge(segments, edge, k);
      pos.setY(vi, y);

      const worldAlong = axis === "z" ? wzFinal : wxFinal;
      const minAlong = axis === "z" ? chunkMinZ : chunkMinX;
      const tCoarse = THREE.MathUtils.clamp((worldAlong - minAlong) / cs, 0, 1);
      const f = tCoarse * neighborSeg;
      const i0 = Math.min(Math.floor(f + 1e-8), Math.max(0, neighborSeg - 1));
      const i1 = Math.min(i0 + 1, neighborSeg);
      const alpha = THREE.MathUtils.clamp(f - i0, 0, 1);
      let wx0, wz0, wx1, wz1;
      if (axis === "z") {
        wx0 = wx1 = wxFinal;
        wz0 = chunkMinZ + (i0 / neighborSeg) * cs;
        wz1 = chunkMinZ + (i1 / neighborSeg) * cs;
      } else {
        wz0 = wz1 = wzFinal;
        wx0 = chunkMinX + (i0 / neighborSeg) * cs;
        wx1 = chunkMinX + (i1 / neighborSeg) * cs;
      }
      sampleHeightfieldNormal(wx0, wz0, eps, terrainStore, _stitchN0);
      sampleHeightfieldNormal(wx1, wz1, eps, terrainStore, _stitchN1);
      const nx = _stitchN0.x + alpha * (_stitchN1.x - _stitchN0.x);
      const ny = _stitchN0.y + alpha * (_stitchN1.y - _stitchN0.y);
      const nz = _stitchN0.z + alpha * (_stitchN1.z - _stitchN0.z);
      const len = Math.hypot(nx, ny, nz) || 1;
      normal.setXYZ(vi, nx / len, ny / len, nz / len);

      snapped[vi] = 1;
      any = true;
    }
  };

  runEdge("east", neighborSegments.east, cx + 1, cz, "z", "west");
  runEdge("west", neighborSegments.west, cx - 1, cz, "z", "east");
  runEdge("south", neighborSegments.south, cx, cz + 1, "x", "north");
  runEdge("north", neighborSegments.north, cx, cz - 1, "x", "south");

  return any ? snapped : null;
}

function snapLodBoundariesPartial({
  pos,
  normal,
  segments,
  cx,
  cz,
  chunkMinX,
  chunkMinZ,
  terrainStore,
  neighborSegments,
  eps,
  mMinX,
  mMaxX,
  mMinZ,
  mMaxZ,
}) {
  const cs = terrainStore.config.world.chunkSize;
  const dataScale =
    terrainStore.config.world.dataResolution / terrainStore.config.world.chunkSize;
  const snapped = new Uint8Array(pos.count);
  let any = false;

  const snapEdgeNormal = (vi, axis, wxFinal, wzFinal, neighborSeg) => {
    const worldAlong = axis === "z" ? wzFinal : wxFinal;
    const minAlong = axis === "z" ? chunkMinZ : chunkMinX;
    const tCoarse = THREE.MathUtils.clamp((worldAlong - minAlong) / cs, 0, 1);
    const f = tCoarse * neighborSeg;
    const i0 = Math.min(Math.floor(f + 1e-8), Math.max(0, neighborSeg - 1));
    const i1 = Math.min(i0 + 1, neighborSeg);
    const alpha = THREE.MathUtils.clamp(f - i0, 0, 1);
    let wx0, wz0, wx1, wz1;
    if (axis === "z") {
      wx0 = wx1 = wxFinal;
      wz0 = chunkMinZ + (i0 / neighborSeg) * cs;
      wz1 = chunkMinZ + (i1 / neighborSeg) * cs;
    } else {
      wz0 = wz1 = wzFinal;
      wx0 = chunkMinX + (i0 / neighborSeg) * cs;
      wx1 = chunkMinX + (i1 / neighborSeg) * cs;
    }
    sampleHeightfieldNormal(wx0, wz0, eps, terrainStore, _stitchN0);
    sampleHeightfieldNormal(wx1, wz1, eps, terrainStore, _stitchN1);
    const nx = _stitchN0.x + alpha * (_stitchN1.x - _stitchN0.x);
    const ny = _stitchN0.y + alpha * (_stitchN1.y - _stitchN0.y);
    const nz = _stitchN0.z + alpha * (_stitchN1.z - _stitchN0.z);
    const len = Math.hypot(nx, ny, nz) || 1;
    normal.setXYZ(vi, nx / len, ny / len, nz / len);
  };

  const touchEast = mMaxX === segments && neighborSegments.east != null && neighborSegments.east < segments;
  const touchWest = mMinX === 0 && neighborSegments.west != null && neighborSegments.west < segments;
  const touchSouth = mMaxZ === segments && neighborSegments.south != null && neighborSegments.south < segments;
  const touchNorth = mMinZ === 0 && neighborSegments.north != null && neighborSegments.north < segments;

  if (touchEast) {
    const neighborSeg = neighborSegments.east;
    for (let k = mMinZ; k <= mMaxZ; k++) {
      const t = k / segments;
      const wz = chunkMinZ + t * cs;
      const wx = chunkMinX + cs;
      const y = sampleCoarseNeighborEdgeY({
        terrainStore, ncx: cx + 1, ncz: cz, neighborSeg, wx, wz,
        axis: "z", neighborBoundary: "west", dataScale,
      });
      const vi = vertexIndexOnEdge(segments, "east", k);
      pos.setY(vi, y);
      snapEdgeNormal(vi, "z", wx, wz, neighborSeg);
      snapped[vi] = 1;
      any = true;
    }
  }
  if (touchWest) {
    const neighborSeg = neighborSegments.west;
    for (let k = mMinZ; k <= mMaxZ; k++) {
      const t = k / segments;
      const wz = chunkMinZ + t * cs;
      const wx = chunkMinX;
      const y = sampleCoarseNeighborEdgeY({
        terrainStore, ncx: cx - 1, ncz: cz, neighborSeg, wx, wz,
        axis: "z", neighborBoundary: "east", dataScale,
      });
      const vi = vertexIndexOnEdge(segments, "west", k);
      pos.setY(vi, y);
      snapEdgeNormal(vi, "z", wx, wz, neighborSeg);
      snapped[vi] = 1;
      any = true;
    }
  }
  if (touchSouth) {
    const neighborSeg = neighborSegments.south;
    for (let k = mMinX; k <= mMaxX; k++) {
      const t = k / segments;
      const wx = chunkMinX + t * cs;
      const wz = chunkMinZ + cs;
      const y = sampleCoarseNeighborEdgeY({
        terrainStore, ncx: cx, ncz: cz + 1, neighborSeg, wx, wz,
        axis: "x", neighborBoundary: "north", dataScale,
      });
      const vi = vertexIndexOnEdge(segments, "south", k);
      pos.setY(vi, y);
      snapEdgeNormal(vi, "x", wx, wz, neighborSeg);
      snapped[vi] = 1;
      any = true;
    }
  }
  if (touchNorth) {
    const neighborSeg = neighborSegments.north;
    for (let k = mMinX; k <= mMaxX; k++) {
      const t = k / segments;
      const wx = chunkMinX + t * cs;
      const wz = chunkMinZ;
      const y = sampleCoarseNeighborEdgeY({
        terrainStore, ncx: cx, ncz: cz - 1, neighborSeg, wx, wz,
        axis: "x", neighborBoundary: "south", dataScale,
      });
      const vi = vertexIndexOnEdge(segments, "north", k);
      pos.setY(vi, y);
      snapEdgeNormal(vi, "x", wx, wz, neighborSeg);
      snapped[vi] = 1;
      any = true;
    }
  }

  return any ? snapped : null;
}

function vertexIndexOnEdge(segments, edge, k) {
  if (edge === "west") return k * (segments + 1) + 0;
  if (edge === "east") return k * (segments + 1) + segments;
  if (edge === "north") return 0 * (segments + 1) + k;
  if (edge === "south") return segments * (segments + 1) + k;
  return 0;
}

function sampleCoarseNeighborEdgeY({
  terrainStore,
  ncx,
  ncz,
  neighborSeg,
  wx,
  wz,
  axis,
  neighborBoundary,
  dataScale,
}) {
  const nMinX = chunkMinWorldX(ncx, terrainStore.config);
  const nMinZ = chunkMinWorldZ(ncz, terrainStore.config);
  const cs = terrainStore.config.world.chunkSize;

  const t =
    axis === "z"
      ? THREE.MathUtils.clamp((wz - nMinZ) / cs, 0, 1)
      : THREE.MathUtils.clamp((wx - nMinX) / cs, 0, 1);

  const u = t * neighborSeg;
  const i0 = Math.floor(u);
  const i1 = Math.min(neighborSeg, i0 + 1);
  const f = u - i0;

  const nHalf = cs * 0.5;
  const lxEdgeLocal =
    neighborBoundary === "west"
      ? -nHalf
      : neighborBoundary === "east"
        ? nHalf
        : null;
  const lzEdgeLocal =
    neighborBoundary === "north"
      ? -nHalf
      : neighborBoundary === "south"
        ? nHalf
        : null;

  const z0 = -nHalf + (i0 / neighborSeg) * cs;
  const z1 = -nHalf + (i1 / neighborSeg) * cs;
  const x0 = -nHalf + (i0 / neighborSeg) * cs;
  const x1 = -nHalf + (i1 / neighborSeg) * cs;

  if (axis === "z") {
    const y0 = terrainStore.sampleChunkHeight(
      ncx,
      ncz,
      (lxEdgeLocal + nHalf) * dataScale,
      (z0 + nHalf) * dataScale,
    );
    const y1 = terrainStore.sampleChunkHeight(
      ncx,
      ncz,
      (lxEdgeLocal + nHalf) * dataScale,
      (z1 + nHalf) * dataScale,
    );
    return THREE.MathUtils.lerp(y0, y1, f);
  }

  const y0 = terrainStore.sampleChunkHeight(
    ncx,
    ncz,
    (x0 + nHalf) * dataScale,
    (lzEdgeLocal + nHalf) * dataScale,
  );
  const y1 = terrainStore.sampleChunkHeight(
    ncx,
    ncz,
    (x1 + nHalf) * dataScale,
    (lzEdgeLocal + nHalf) * dataScale,
  );
  return THREE.MathUtils.lerp(y0, y1, f);
}

function syncSkirtRing({ pos, normal, segments, skirtDepth }) {
  const baseCount = (segments + 1) * (segments + 1);
  if (pos.count <= baseCount) return;
  const ring = getChunkPerimeterRingIndices(segments);
  const posArr = pos.array;
  const nArr = normal.array;
  for (let r = 0; r < ring.length; r++) {
    const ti = ring[r];
    const bi = baseCount + r;
    posArr[bi * 3] = posArr[ti * 3];
    posArr[bi * 3 + 1] = posArr[ti * 3 + 1] - skirtDepth;
    posArr[bi * 3 + 2] = posArr[ti * 3 + 2];
    nArr[bi * 3] = nArr[ti * 3];
    nArr[bi * 3 + 1] = nArr[ti * 3 + 1];
    nArr[bi * 3 + 2] = nArr[ti * 3 + 2];
  }
}

function installTerrainSkirtSafeRaycast(mesh) {
  if (mesh.userData._terrainRaycastPatched) return;
  mesh.userData._terrainRaycastPatched = true;
  const baseRaycast = mesh.raycast.bind(mesh);
  mesh.raycast = (raycaster, intersects) => {
    const prevLen = intersects.length;
    baseRaycast(raycaster, intersects);
    const triCap = mesh.geometry?.userData?.terrainTriCount;
    if (triCap == null) return;
    for (let i = intersects.length - 1; i >= prevLen; i--) {
      const hit = intersects[i];
      const fi = hit.faceIndex;
      if (fi != null && fi >= triCap) intersects.splice(i, 1);
    }
  };
}
