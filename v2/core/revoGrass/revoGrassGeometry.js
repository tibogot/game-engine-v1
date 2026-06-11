import * as THREE from "three";

/**
 * Tapered blade mesh for SpriteNodeMaterial (Revo-style segments + tip).
 */
export function createRevoBladeGeometry({ segments, bladeHeight, bladeWidth }) {
  const rowCount = segments;
  const vertexCount = rowCount * 2 + 1;
  const quadCount = Math.max(0, rowCount - 1);
  const indexCount = quadCount * 6 + 3;
  const halfWidthBase = bladeWidth * 0.5;
  const taper = (t) => halfWidthBase * (1.0 - 0.7 * t);

  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint8Array(indexCount);
  const normals = new Float32Array(vertexCount * 3);

  let idx = 0;
  for (let row = 0; row < rowCount; row++) {
    const v = row / segments;
    const y = v * bladeHeight;
    const halfWidth = taper(v);
    const left = row * 2;
    const right = left + 1;

    positions[left * 3] = -halfWidth;
    positions[left * 3 + 1] = y;
    positions[left * 3 + 2] = 0;
    positions[right * 3] = halfWidth;
    positions[right * 3 + 1] = y;
    positions[right * 3 + 2] = 0;

    uvs[left * 2] = 0;
    uvs[left * 2 + 1] = v;
    uvs[right * 2] = 1;
    uvs[right * 2 + 1] = v;

    if (row > 0) {
      const prevLeft = (row - 1) * 2;
      const prevRight = prevLeft + 1;
      indices[idx++] = prevLeft;
      indices[idx++] = prevRight;
      indices[idx++] = right;
      indices[idx++] = prevLeft;
      indices[idx++] = right;
      indices[idx++] = left;
    }
  }

  const tip = rowCount * 2;
  positions[tip * 3 + 1] = bladeHeight;
  uvs[tip * 2] = 0.5;
  uvs[tip * 2 + 1] = 1;
  const lastLeft = (rowCount - 1) * 2;
  const lastRight = lastLeft + 1;
  indices[idx++] = lastLeft;
  indices[idx++] = lastRight;
  indices[idx++] = tip;

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.StaticDrawUsage);
  geom.setAttribute("position", posAttr);
  const uvAttr = new THREE.BufferAttribute(uvs, 2);
  uvAttr.setUsage(THREE.StaticDrawUsage);
  geom.setAttribute("uv", uvAttr);
  const indexAttr = new THREE.BufferAttribute(indices, 1);
  indexAttr.setUsage(THREE.StaticDrawUsage);
  geom.setIndex(indexAttr);
  const normalAttr = new THREE.BufferAttribute(normals, 3);
  normalAttr.setUsage(THREE.StaticDrawUsage);
  geom.setAttribute("normal", normalAttr);
  return geom;
}
