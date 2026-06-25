import * as THREE from "three";
import { installTerrainSkirtSafeRaycast } from "./terrainMesher.js";

export class TerrainMerger {
  constructor({ scene }) {
    this.scene = scene;
    this._lodMeshes = new Map(); // segments -> THREE.Mesh
    this._chunkStream = null;
    this._material = null;
    this._mergedBucketSizes = new Map(); // segments -> chunk count at merge time
  }

  get isMerged() { return this._lodMeshes.size > 0; }

  merge(chunkStream, material) {
    if (this.isMerged) this.unmerge();
    this._chunkStream = chunkStream;
    this._material = material;

    const chunks = Array.from(chunkStream.activeChunks.values());
    if (chunks.length === 0) return;

    // Group chunks by LOD level so each bucket gets its own merged mesh with a
    // tight bounding sphere — Three.js frustum culling then works per-bucket
    // instead of being disabled across the whole terrain.
    const byLod = new Map();
    for (const ch of chunks) {
      if (!byLod.has(ch.segments)) byLod.set(ch.segments, []);
      byLod.get(ch.segments).push(ch);
    }

    this._mergedBucketSizes.clear();
    for (const [segments, lodChunks] of byLod) {
      const geo = _buildMergedGeometry(lodChunks);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = true;
      installTerrainSkirtSafeRaycast(mesh);
      this.scene.add(mesh);
      this._lodMeshes.set(segments, mesh);
      this._mergedBucketSizes.set(segments, lodChunks.length);
    }

    for (const ch of chunks) ch.mesh.visible = false;
  }

  /**
   * Returns true when any active chunk's LOD level differs from the snapshot
   * taken at merge time, meaning the merged geometry is showing stale detail.
   */
  isLodStale(activeChunks) {
    if (!this.isMerged) return false;
    const current = new Map();
    for (const ch of activeChunks.values()) {
      current.set(ch.segments, (current.get(ch.segments) ?? 0) + 1);
    }
    if (current.size !== this._mergedBucketSizes.size) return true;
    for (const [segs, count] of current) {
      if (this._mergedBucketSizes.get(segs) !== count) return true;
    }
    return false;
  }

  /**
   * Rebuilds the merged geometry from the current LOD state of active chunks
   * without making individual chunk meshes visible — no visible flash.
   * Only call when the remesh queue is empty (all LOD transitions settled).
   */
  remerge() {
    if (!this.isMerged || !this._chunkStream || !this._material) return;

    for (const mesh of this._lodMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this._lodMeshes.clear();
    this._mergedBucketSizes.clear();

    const chunks = Array.from(this._chunkStream.activeChunks.values());
    const byLod = new Map();
    for (const ch of chunks) {
      if (!byLod.has(ch.segments)) byLod.set(ch.segments, []);
      byLod.get(ch.segments).push(ch);
    }

    for (const [segments, lodChunks] of byLod) {
      const geo = _buildMergedGeometry(lodChunks);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this._material);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.frustumCulled = true;
      installTerrainSkirtSafeRaycast(mesh);
      this.scene.add(mesh);
      this._lodMeshes.set(segments, mesh);
      this._mergedBucketSizes.set(segments, lodChunks.length);
    }
    // Chunk meshes stay hidden — they were already hidden from the original merge.
  }

  unmerge() {
    if (!this.isMerged) return;

    if (this._chunkStream) {
      for (const ch of this._chunkStream.activeChunks.values()) {
        ch.mesh.visible = true;
      }
    }

    for (const mesh of this._lodMeshes.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this._lodMeshes.clear();
    this._mergedBucketSizes.clear();
    this._chunkStream = null;
    this._material = null;

    window.dispatchEvent(new CustomEvent("terrain-merge-changed", { detail: { merged: false } }));
  }

  raycastMeshes() {
    if (this.isMerged) return Array.from(this._lodMeshes.values());
    return this._chunkStream ? this._chunkStream.raycastMeshes() : [];
  }

  dispose() {
    this.unmerge();
  }
}

function _buildMergedGeometry(chunks) {
  let totalVerts = 0;
  let totalTerrainIdxCount = 0;
  let totalSkirtIdxCount = 0;

  for (const ch of chunks) {
    const geo = ch.mesh.geometry;
    if (!geo?.index) continue;
    totalVerts += geo.attributes.position.count;
    const terrainTris = geo.userData.terrainTriCount ?? 0;
    totalTerrainIdxCount += terrainTris * 3;
    totalSkirtIdxCount += geo.index.count - terrainTris * 3;
  }

  if (totalVerts === 0) return null;

  const totalIdxCount = totalTerrainIdxCount + totalSkirtIdxCount;
  const maxVertIndex = totalVerts - 1;

  const posArr  = new Float32Array(totalVerts * 3);
  const normArr = new Float32Array(totalVerts * 3);
  const uvArr   = new Float32Array(totalVerts * 2);
  const skirtArr = new Float32Array(totalVerts);
  const idxArr  = maxVertIndex > 65535
    ? new Uint32Array(totalIdxCount)
    : new Uint16Array(totalIdxCount);

  let vertOffset = 0;
  let terrainIdxWrite = 0;
  let skirtIdxWrite = totalTerrainIdxCount; // skirt indices go after all terrain indices

  for (const ch of chunks) {
    const geo = ch.mesh.geometry;
    if (!geo?.index) continue;

    const mx = ch.mesh.position.x;
    const mz = ch.mesh.position.z;
    const vertCount = geo.attributes.position.count;
    const srcPos   = geo.attributes.position.array;
    const srcNorm  = geo.attributes.normal.array;
    const srcUv    = geo.attributes.uv.array;
    const srcSkirt = geo.attributes.aSkirt?.array;
    const srcIdx   = geo.index.array;
    const terrainTris = geo.userData.terrainTriCount ?? 0;
    const terrainIdxEnd = terrainTris * 3;

    for (let i = 0; i < vertCount; i++) {
      const d3 = (vertOffset + i) * 3;
      const s3 = i * 3;
      posArr[d3]     = srcPos[s3]     + mx;
      posArr[d3 + 1] = srcPos[s3 + 1];
      posArr[d3 + 2] = srcPos[s3 + 2] + mz;
      normArr[d3]     = srcNorm[s3];
      normArr[d3 + 1] = srcNorm[s3 + 1];
      normArr[d3 + 2] = srcNorm[s3 + 2];
      const d2 = (vertOffset + i) * 2;
      const s2 = i * 2;
      uvArr[d2]     = srcUv[s2];
      uvArr[d2 + 1] = srcUv[s2 + 1];
      if (srcSkirt) skirtArr[vertOffset + i] = srcSkirt[i];
    }

    // Terrain indices first, then skirt indices — preserves terrainTriCount contract.
    for (let j = 0; j < terrainIdxEnd; j++) {
      idxArr[terrainIdxWrite++] = srcIdx[j] + vertOffset;
    }
    for (let j = terrainIdxEnd; j < srcIdx.length; j++) {
      idxArr[skirtIdxWrite++] = srcIdx[j] + vertOffset;
    }

    vertOffset += vertCount;
  }

  const mergedGeo = new THREE.BufferGeometry();
  mergedGeo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
  mergedGeo.setAttribute("normal",   new THREE.BufferAttribute(normArr, 3));
  mergedGeo.setAttribute("uv",       new THREE.BufferAttribute(uvArr, 2));
  mergedGeo.setAttribute("aSkirt",   new THREE.BufferAttribute(skirtArr, 1));

  const indexBuf = maxVertIndex > 65535
    ? new THREE.Uint32BufferAttribute(idxArr, 1)
    : new THREE.Uint16BufferAttribute(idxArr, 1);
  mergedGeo.setIndex(indexBuf);
  mergedGeo.userData.terrainTriCount = totalTerrainIdxCount / 3;
  mergedGeo.computeBoundingSphere();

  return mergedGeo;
}
