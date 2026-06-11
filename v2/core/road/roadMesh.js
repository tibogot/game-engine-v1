import * as THREE from "three";

function distToSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) {
    const ex = px - ax, ez = pz - az;
    return Math.sqrt(ex * ex + ez * ez);
  }
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cz = az + t * dz;
  const ex = px - cx, ez = pz - cz;
  return Math.sqrt(ex * ex + ez * ez);
}

function distToPolyline(x, z, polyPts) {
  if (polyPts.length === 0) return Infinity;
  if (polyPts.length === 1) {
    const dx = x - polyPts[0].x, dz = z - polyPts[0].z;
    return Math.sqrt(dx * dx + dz * dz);
  }
  let minD = Infinity;
  for (let i = 0; i < polyPts.length - 1; i++) {
    const d = distToSegment(x, z, polyPts[i].x, polyPts[i].z, polyPts[i + 1].x, polyPts[i + 1].z);
    if (d < minD) minD = d;
  }
  return minD;
}

function sampleSlope01(x, z, eps, getWorldHeight) {
  const hL = getWorldHeight(x - eps, z);
  const hR = getWorldHeight(x + eps, z);
  const hD = getWorldHeight(x, z - eps);
  const hU = getWorldHeight(x, z + eps);
  const nx = hL - hR;
  const ny = 2 * eps;
  const nz = hD - hU;
  const invLen = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
  const normalY = ny * invLen;
  return Math.max(0, Math.min(1, 1 - normalY));
}

function roadSurfaceY(x, z, baseOffset, getWorldHeight, adaptiveLift, slopeLift, liftMax, eps) {
  const h = getWorldHeight(x, z);
  if (!adaptiveLift) return h + baseOffset;
  const slope01 = sampleSlope01(x, z, eps, getWorldHeight);
  const extra = Math.min(liftMax, slope01 * slopeLift);
  return h + baseOffset + extra;
}

export function generateRoadGeometry(curve, width, segments, heightOffset, getWorldHeight, otherCurves, opts = null) {
  const startT = Math.max(0, Math.min(1, opts?.startT ?? 0));
  const endT = Math.max(startT, Math.min(1, opts?.endT ?? 1));
  const arcOffset = Math.max(0, opts?.arcOffset ?? 0);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const localT = segments > 0 ? i / segments : 0;
    pts.push(curve.getPointAt(startT + (endT - startT) * localT));
  }
  const arcLen = [0];
  for (let i = 1; i <= segments; i++) {
    arcLen.push(arcLen[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  const totalLen = arcLen[segments] || 1;

  let otherPolylines = null;
  if (otherCurves && otherCurves.length > 0) {
    otherPolylines = otherCurves.map(c => c.curve.getSpacedPoints(Math.min(c.segments, 200)));
  }

  const positions = [];
  const uvs = [];
  const junctions = [];
  const indices = [];
  const halfW = width / 2;
  const margin = halfW * 0.5;
  const adaptiveLift = opts?.adaptiveLift !== false;
  const slopeLift = Math.max(0, opts?.slopeLift ?? 0.35);
  const liftMax = Math.max(0, opts?.liftMax ?? 0.6);
  const slopeEps = Math.max(0.35, Math.min(2.5, width * 0.1));

  for (let i = 0; i <= segments; i++) {
    const u = arcLen[i] / totalLen;
    const pos = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(segments, i + 1)];
    const tan = next.clone().sub(prev).normalize();
    const perp = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
    const lx = pos.x - perp.x * halfW;
    const lz = pos.z - perp.z * halfW;
    const rx = pos.x + perp.x * halfW;
    const rz = pos.z + perp.z * halfW;
    positions.push(
      lx,
      roadSurfaceY(lx, lz, heightOffset, getWorldHeight, adaptiveLift, slopeLift, liftMax, slopeEps),
      lz,
    );
    positions.push(
      rx,
      roadSurfaceY(rx, rz, heightOffset, getWorldHeight, adaptiveLift, slopeLift, liftMax, slopeEps),
      rz,
    );
    uvs.push(arcOffset + arcLen[i], 0, arcOffset + arcLen[i], 1);

    let jL = 0, jR = 0;
    if (otherPolylines) {
      for (const poly of otherPolylines) {
        const dL = distToPolyline(lx, lz, poly);
        const dR = distToPolyline(rx, rz, poly);
        jL = Math.max(jL, 1 - Math.max(0, Math.min(1, (dL - halfW) / margin)));
        jR = Math.max(jR, 1 - Math.max(0, Math.min(1, (dR - halfW) / margin)));
      }
    }
    junctions.push(jL, jR);

    if (i < segments) {
      const b = i * 2;
      indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aJunction", new THREE.Float32BufferAttribute(junctions, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}
