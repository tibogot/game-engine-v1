import * as THREE from "three";

export function generateRiverGeometry(curve, width, segments, heightOffset, getWorldHeight) {
  const pts = curve.getSpacedPoints(segments);
  const arcLen = [0];
  for (let i = 1; i <= segments; i++) {
    arcLen.push(arcLen[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  const totalLen = arcLen[segments] || 1;

  const positions = [];
  const uvs = [];
  const indices = [];
  const halfW = width * 0.5;

  for (let i = 0; i <= segments; i++) {
    const pos = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(segments, i + 1)];
    const tan = next.clone().sub(prev).normalize();
    const perp = new THREE.Vector3(-tan.z, 0, tan.x).normalize();

    const lx = pos.x - perp.x * halfW;
    const lz = pos.z - perp.z * halfW;
    const rx = pos.x + perp.x * halfW;
    const rz = pos.z + perp.z * halfW;

    positions.push(lx, getWorldHeight(lx, lz) + heightOffset, lz);
    positions.push(rx, getWorldHeight(rx, rz) + heightOffset, rz);

    const u = arcLen[i] / Math.max(1, totalLen);
    uvs.push(u, 0, u, 1);

    if (i < segments) {
      const b = i * 2;
      indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

