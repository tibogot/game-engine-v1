import * as THREE from "three";

export class TerrainGeometryPool {
  constructor(config) {
    this.config = config;
    this.pool = new Map(); // segments -> BufferGeometry[]
    this.templateCache = new Map();
    this.maxPerLevel = 16;
  }

  getTemplate(segments) {
    if (this.templateCache.has(segments)) return this.templateCache.get(segments);
    const geom = new THREE.PlaneGeometry(
      this.config.world.chunkSize,
      this.config.world.chunkSize,
      segments,
      segments,
    );
    geom.rotateX(-Math.PI / 2);
    // PlaneGeometry already produces analytical UVs in [0..1] across the tile
    // and XZ positions matching `ix * cs/seg - cs/2` / `iz * cs/seg - cs/2`,
    // so we don't touch them again at runtime — only Y changes per remesh.
    const baseVertCount = geom.attributes.position.count;
    geom.userData.baseVertCount = baseVertCount;
    appendChunkTerrainSkirt(geom, segments, this.config.render.terrainSkirtDepth);
    this.templateCache.set(segments, geom);
    return geom;
  }

  acquire(segments) {
    const list = this.pool.get(segments);
    if (list && list.length > 0) return list.pop();
    return this.getTemplate(segments).clone();
  }

  release(segments, geometry) {
    let list = this.pool.get(segments);
    if (!list) {
      list = [];
      this.pool.set(segments, list);
    }
    if (list.length < this.maxPerLevel) list.push(geometry);
    else geometry.dispose();
  }

  disposeAll() {
    for (const geos of this.pool.values()) {
      for (const g of geos) g.dispose();
    }
    this.pool.clear();
    for (const g of this.templateCache.values()) g.dispose();
    this.templateCache.clear();
  }
}

const _perimeterRingCache = new Map();
export function getChunkPerimeterRingIndices(segments) {
  let ring = _perimeterRingCache.get(segments);
  if (ring) return ring;
  const w = segments + 1;
  ring = [];
  for (let ix = 0; ix <= segments; ix++) ring.push(ix);
  for (let iy = 1; iy <= segments; iy++) ring.push(iy * w + segments);
  for (let ix = segments - 1; ix >= 0; ix--) ring.push(segments * w + ix);
  for (let iy = segments - 1; iy >= 1; iy--) ring.push(iy * w);
  _perimeterRingCache.set(segments, ring);
  return ring;
}

/**
 * Append downward extrusion along the chunk boundary (must run on a fresh
 * `(segments+1)²` plane only — not on geometry that already has a skirt).
 *
 * Ported from `splatmap-chunks.html` (Unity-style terrain skirts).
 */
function appendChunkTerrainSkirt(geom, segments, skirtDepth) {
  const expected = (segments + 1) * (segments + 1);
  if (geom.attributes.position.count !== expected) {
    delete geom.userData.terrainTriCount;
    return;
  }
  const idx = geom.index;
  if (!idx) {
    delete geom.userData.terrainTriCount;
    return;
  }

  const ring = getChunkPerimeterRingIndices(segments);
  const baseCount = expected;
  const botCount = ring.length;
  const newCount = baseCount + botCount;

  const posArr = geom.attributes.position.array;
  const uvArr = geom.attributes.uv.array;
  const nArr = geom.attributes.normal.array;

  const newPos = new Float32Array(newCount * 3);
  newPos.set(posArr);
  const newUv = new Float32Array(newCount * 2);
  newUv.set(uvArr);
  const newN = new Float32Array(newCount * 3);
  newN.set(nArr);
  // 1 on skirt verts, 0 on the surface verts. Lets the fragment shader kill
  // the skirt curtain inside chunks with painted holes (zero by default for
  // surface verts since Float32Array initializes to 0).
  const newSkirt = new Float32Array(newCount);

  for (let r = 0; r < botCount; r++) {
    const ti = ring[r];
    const bi = baseCount + r;
    newPos[bi * 3] = posArr[ti * 3];
    newPos[bi * 3 + 1] = posArr[ti * 3 + 1] - skirtDepth;
    newPos[bi * 3 + 2] = posArr[ti * 3 + 2];
    newUv[bi * 2] = uvArr[ti * 2];
    newUv[bi * 2 + 1] = uvArr[ti * 2 + 1];
    newN[bi * 3] = nArr[ti * 3];
    newN[bi * 3 + 1] = nArr[ti * 3 + 1];
    newN[bi * 3 + 2] = nArr[ti * 3 + 2];
    newSkirt[bi] = 1;
  }

  const oldIdx = idx.array;
  // Raycasts must ignore skirt triangles (first hit can be a vertical skirt face → wrong xz).
  geom.userData.terrainTriCount = oldIdx.length / 3;
  const newIdxLen = oldIdx.length + ring.length * 6;
  const maxVertIndex = newCount - 1;
  const newIdx =
    maxVertIndex > 65535 ? new Uint32Array(newIdxLen) : new Uint16Array(newIdxLen);
  newIdx.set(oldIdx);
  let o = oldIdx.length;
  const L = ring.length;
  for (let r = 0; r < L; r++) {
    const r1 = (r + 1) % L;
    const T0 = ring[r];
    const T1 = ring[r1];
    const B0 = baseCount + r;
    const B1 = baseCount + r1;
    newIdx[o++] = T0;
    newIdx[o++] = T1;
    newIdx[o++] = B0;
    newIdx[o++] = T1;
    newIdx[o++] = B1;
    newIdx[o++] = B0;
  }

  geom.setAttribute("position", new THREE.BufferAttribute(newPos, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(newN, 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(newUv, 2));
  geom.setAttribute("aSkirt", new THREE.BufferAttribute(newSkirt, 1));
  // setIndex() only wraps plain Arrays; raw TypedArray ends up as index with no .array — WebGPU breaks.
  const indexBuf =
    maxVertIndex > 65535 ? new THREE.Uint32BufferAttribute(newIdx, 1) : new THREE.Uint16BufferAttribute(newIdx, 1);
  geom.setIndex(indexBuf);
  // Do NOT computeVertexNormals() here. Skirt wall triangles share the top-ring
  // vertices with the terrain surface; averaging would blend outward wall normals
  // into the rim and MeshStandard lighting draws a dark grid on every chunk edge.
  geom.computeBoundingSphere();
}

