import * as THREE from "three";
import { installTerrainSkirtSafeRaycast } from "./terrainMesher.js";

export class TerrainMerger {
  constructor({ scene }) {
    this.scene = scene;
    this._mergedMesh = null;
    this._chunkStream = null;
  }

  get isMerged() { return this._mergedMesh !== null; }

  merge(chunkStream, material) {
    if (this._mergedMesh) this.unmerge();
    this._chunkStream = chunkStream;

    const chunks = Array.from(chunkStream.activeChunks.values());
    if (chunks.length === 0) return;

    const geo = _buildMergedGeometry(chunks);
    if (!geo) return;

    this._mergedMesh = new THREE.Mesh(geo, material);
    this._mergedMesh.receiveShadow = true;
    this._mergedMesh.castShadow = false;
    this._mergedMesh.frustumCulled = false;
    installTerrainSkirtSafeRaycast(this._mergedMesh);
    this.scene.add(this._mergedMesh);

    for (const ch of chunks) ch.mesh.visible = false;
  }

  unmerge() {
    if (!this._mergedMesh) return;

    if (this._chunkStream) {
      for (const ch of this._chunkStream.activeChunks.values()) {
        ch.mesh.visible = true;
      }
    }

    this.scene.remove(this._mergedMesh);
    this._mergedMesh.geometry.dispose();
    this._mergedMesh = null;
    this._chunkStream = null;

    window.dispatchEvent(new CustomEvent("terrain-merge-changed", { detail: { merged: false } }));
  }

  raycastMeshes() {
    if (this._mergedMesh) return [this._mergedMesh];
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
