import * as THREE from "three";

/**
 * Large sidewalk slab ribbon along a spline — UVs tiled for image textures.
 */

export const SIDEWALK_DEFAULTS = {
  width: 3.6,
  thickness: 0.12,
  sideOffset: 0,
  side: "right",
  pathSegments: 120,
  yOffset: 0.012,
  /** World metres per one UV repeat along the path (U). */
  uvRepeatAlong: 2.5,
  /** World metres per one UV repeat across width (V). */
  uvRepeatAcross: 2.5,
  color: "#b5b0a8",
  roughness: 0.94,
  metalness: 0,
};

function sideSign(side) {
  return side === "left" ? 1 : -1;
}

function buildSidewalkGeometry(
  curve,
  pathSegs,
  width,
  thickness,
  closed,
  sideOffset,
  side,
  yOffset,
  uvRepeatAlong,
  uvRepeatAcross,
  getWorldHeight,
) {
  const segs = Math.max(8, pathSegs | 0);
  const w = Math.max(0.4, width);
  const thick = Math.max(0.02, thickness);
  const sign = sideSign(side);
  const ringVerts = 4;
  const rings = segs + 1;
  const positions = new Float32Array(rings * ringVerts * 3);
  const normals = new Float32Array(rings * ringVerts * 3);
  const uvs = new Float32Array(rings * ringVerts * 2);
  const indexCount = segs * (ringVerts - 1) * 6;
  const indices =
    rings * ringVerts > 65535
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);

  const tangent = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const innerTop = new THREE.Vector3();
  const outerTop = new THREE.Vector3();
  const innerBot = new THREE.Vector3();
  const outerBot = new THREE.Vector3();

  let arcLen = 0;
  let prevInner = new THREE.Vector3();

  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const center = curve.getPointAt(t);
    tangent.copy(curve.getTangentAt(t));
    if (tangent.lengthSq() < 1e-10) tangent.set(0, 0, 1);
    tangent.normalize();
    perp.set(-tangent.z, 0, tangent.x).normalize();

    const gy = getWorldHeight(center.x, center.z) + yOffset;
    const innerX = center.x + perp.x * sideOffset * sign;
    const innerZ = center.z + perp.z * sideOffset * sign;
    const outerX = innerX + perp.x * w * sign;
    const outerZ = innerZ + perp.z * w * sign;

    innerTop.set(innerX, gy + thick, innerZ);
    outerTop.set(outerX, gy + thick, outerZ);
    innerBot.set(innerX, gy, innerZ);
    outerBot.set(outerX, gy, outerZ);

    if (i > 0) {
      arcLen += innerTop.distanceTo(prevInner);
    }
    prevInner.copy(innerTop);

    const uAlong = arcLen / Math.max(0.1, uvRepeatAlong);
    const vInner = 0;
    const vOuter = w / Math.max(0.1, uvRepeatAcross);

    const base = i * ringVerts;
    const writeVert = (vi, v, nx, ny, nz, u, uvV) => {
      positions[vi * 3] = v.x;
      positions[vi * 3 + 1] = v.y;
      positions[vi * 3 + 2] = v.z;
      normals[vi * 3] = nx;
      normals[vi * 3 + 1] = ny;
      normals[vi * 3 + 2] = nz;
      uvs[vi * 2] = u;
      uvs[vi * 2 + 1] = uvV;
    };

    writeVert(base + 0, innerTop, 0, 1, 0, uAlong, vInner);
    writeVert(base + 1, outerTop, 0, 1, 0, uAlong, vOuter);
    writeVert(base + 2, outerBot, 0, -1, 0, uAlong, vOuter);
    writeVert(base + 3, innerBot, 0, -1, 0, uAlong, vInner);
  }

  let ii = 0;
  for (let i = 0; i < segs; i++) {
    const r0 = i * ringVerts;
    const r1 = (i + 1) * ringVerts;
    const quad = (a, b, c, d) => {
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = d;
    };
    quad(r0, r1, r0 + 1, r1 + 1);
    quad(r0 + 3, r0 + 2, r1 + 3, r1 + 2);
    quad(r0, r0 + 3, r1, r1 + 3);
    quad(r0 + 1, r1 + 1, r0 + 2, r1 + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildSidewalkMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...SIDEWALK_DEFAULTS, ...params };

  const groundedPoints = points.map((pt) => {
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    return new THREE.Vector3(v.x, getWorldHeight(v.x, v.z), v.z);
  });

  const curve = new THREE.CatmullRomCurve3(
    groundedPoints,
    !!closed,
    "catmullrom",
    0.5,
  );

  const geo = buildSidewalkGeometry(
    curve,
    p.pathSegments,
    p.width,
    p.thickness,
    closed,
    p.sideOffset,
    p.side,
    p.yOffset,
    p.uvRepeatAlong,
    p.uvRepeatAcross,
    getWorldHeight,
  );

  const mat = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.roughness,
    metalness: p.metalness,
    side: THREE.FrontSide,
  });

  if (p.map) {
    mat.map = p.map;
    mat.map.wrapS = THREE.RepeatWrapping;
    mat.map.wrapT = THREE.RepeatWrapping;
    mat.map.colorSpace = THREE.SRGBColorSpace;
    mat.map.needsUpdate = true;
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "Sidewalk";

  const group = new THREE.Group();
  group.name = "Sidewalk";
  group.add(mesh);
  return group;
}

/** Apply a loaded texture to sidewalk params and rebuild material. */
export function setSidewalkTexture(params, texture) {
  params.map = texture;
}
