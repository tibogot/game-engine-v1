/**
 * Racing-style kerb: discrete red/white blocks along a curve (Smart Road / Full Road accessory look).
 * Curve samples are in XZ with Y from getWorldHeight at the inner edge.
 */
import * as THREE from "three";

function normalizeXZ(v) {
  const len = Math.hypot(v.x, v.z);
  if (len < 1e-6) return new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3(v.x / len, 0, v.z / len);
}

function perpXZ(dir) {
  return new THREE.Vector3(-dir.z, 0, dir.x);
}

function buildKerbSquare(
  group,
  curve,
  startT,
  endT,
  lateralDist,
  kerbWidth,
  kerbHeight,
  lipHeight,
  sideSign,
  color,
  getWorldHeight,
  isPreview,
) {
  const segCount = Math.max(4, Math.ceil((endT - startT) * 40));

  const positions = [];
  const indices = [];

  for (let i = 0; i <= segCount; i++) {
    const t = startT + (endT - startT) * (i / segCount);
    const pt = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    const perp = perpXZ(normalizeXZ(tangent));

    const groundY = getWorldHeight(
      pt.x + perp.x * lateralDist * sideSign,
      pt.z + perp.z * lateralDist * sideSign,
    );

    const innerX = pt.x + perp.x * lateralDist * sideSign;
    const innerZ = pt.z + perp.z * lateralDist * sideSign;
    const outerX = pt.x + perp.x * (lateralDist + kerbWidth) * sideSign;
    const outerZ = pt.z + perp.z * (lateralDist + kerbWidth) * sideSign;

    positions.push(innerX, groundY, innerZ);
    positions.push(innerX, groundY + kerbHeight + lipHeight, innerZ);
    positions.push(outerX, groundY + kerbHeight, outerZ);
    positions.push(outerX, groundY, outerZ);
  }

  for (let i = 0; i < segCount; i++) {
    const base = i * 4;
    indices.push(base, base + 4, base + 1);
    indices.push(base + 4, base + 5, base + 1);
    indices.push(base + 1, base + 5, base + 2);
    indices.push(base + 5, base + 6, base + 2);
    indices.push(base + 2, base + 6, base + 3);
    indices.push(base + 6, base + 7, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.6,
    metalness: 0.0,
    side: THREE.DoubleSide,
    transparent: isPreview,
    opacity: isPreview ? 0.6 : 1.0,
    flatShading: true,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

/**
 * @param {object} opts
 * @param {THREE.Curve} opts.curve — must provide getPointAt, getTangentAt
 * @param {number} [opts.startT]
 * @param {number} [opts.endT]
 * @param {number} opts.sideSign — +1 / −1 (same convention as FullRoadSystem: left = +1)
 * @param {number} opts.lateralDist — offset from curve to **inner** kerb foot (0 when curve is already on inner edge)
 * @param {number} opts.kerbWidth
 * @param {number} opts.kerbHeight
 * @param {number} opts.lipHeight
 * @param {number} opts.squareSize — target length per red/white block along arc
 * @param {THREE.Color|string} opts.colorA
 * @param {THREE.Color|string} opts.colorB
 * @param {(x:number,z:number)=>number} opts.getWorldHeight
 * @param {boolean} [opts.isPreview]
 */
export function buildChunkedKerbGroup(opts) {
  const {
    curve,
    startT = 0,
    endT = 1,
    sideSign,
    lateralDist,
    kerbWidth,
    kerbHeight,
    lipHeight,
    squareSize,
    colorA,
    colorB,
    getWorldHeight,
    isPreview = false,
  } = opts;

  const tMin = Math.min(startT, endT);
  const tMax = Math.max(startT, endT);

  const colA = colorA instanceof THREE.Color ? colorA : new THREE.Color(colorA ?? "#cc2222");
  const colB = colorB instanceof THREE.Color ? colorB : new THREE.Color(colorB ?? "#f2f2f2");

  const sampleCount = 128;
  const pathPoints = [];
  for (let i = 0; i <= sampleCount; i++) {
    const t = tMin + (tMax - tMin) * (i / sampleCount);
    pathPoints.push({ t, pt: curve.getPointAt(t) });
  }

  let totalLength = 0;
  for (let i = 1; i < pathPoints.length; i++) {
    totalLength += pathPoints[i].pt.distanceTo(pathPoints[i - 1].pt);
  }

  const squareCount = Math.max(1, Math.round(totalLength / Math.max(0.05, squareSize)));
  const actualSquareLen = totalLength / squareCount;

  const group = new THREE.Group();

  let currentLen = 0;
  let squareIdx = 0;
  let squareStartT = tMin;

  for (let i = 1; i < pathPoints.length; i++) {
    const segLen = pathPoints[i].pt.distanceTo(pathPoints[i - 1].pt);
    currentLen += segLen;

    const targetLen = (squareIdx + 1) * actualSquareLen;

    if (currentLen >= targetLen || i === pathPoints.length - 1) {
      const overshoot = currentLen - targetLen;
      const ratio = segLen > 0.001 ? Math.max(0, 1 - overshoot / segLen) : 1;
      const squareEndT = pathPoints[i - 1].t + (pathPoints[i].t - pathPoints[i - 1].t) * ratio;

      const stripeColor = squareIdx % 2 === 0 ? colA : colB;

      if (i === pathPoints.length - 1) {
        buildKerbSquare(
          group,
          curve,
          squareStartT,
          tMax,
          lateralDist,
          kerbWidth,
          kerbHeight,
          lipHeight,
          sideSign,
          stripeColor,
          getWorldHeight,
          isPreview,
        );
      } else {
        buildKerbSquare(
          group,
          curve,
          squareStartT,
          squareEndT,
          lateralDist,
          kerbWidth,
          kerbHeight,
          lipHeight,
          sideSign,
          stripeColor,
          getWorldHeight,
          isPreview,
        );
      }

      squareStartT = squareEndT;
      squareIdx++;
    }
  }

  return group;
}
