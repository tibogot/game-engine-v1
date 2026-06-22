import * as THREE from "three";

/**
 * Procedural guardrail along a Catmull-Rom spline.
 * Standalone lab module — param names mirror v2/toolState for later porting.
 */

export const GUARDRAIL_DEFAULTS = {
  height: 0.5,
  depth: 0.2,
  thickness: 0.02,
  crownDepth: 0.05,
  pathSegments: 80,
  postSpacing: 2.0,
  postWidth: 0.08,
  postDepth: 0.06,
  postHeight: 0.6,
  railYOffset: 0.25,
  postSink: 0.04,
  color: "#9aa0a8",
  roughness: 0.45,
  metalness: 0.85,
  postRoughness: 0.55,
  postMetalness: 0.7,
};

function makeWBeamProfile(height, depth, crown) {
  return [
    { y: -0.5 * height, z: 0.5 },
    { y: -0.16 * height, z: 0.35 },
    { y: 0.0, z: -crown / Math.max(depth, 1e-6) },
    { y: 0.16 * height, z: 0.35 },
    { y: 0.5 * height, z: 0.5 },
  ];
}

export function buildGuardrailProfileGeometry(
  curve,
  pathSegs,
  profile,
  depth,
  closed,
  getWorldHeight = () => 0,
) {
  const segs = Math.max(16, pathSegs | 0);
  const prof =
    Array.isArray(profile) && profile.length >= 2
      ? profile
      : [
          { y: -0.5, z: 0.5 },
          { y: 0.5, z: 0.5 },
        ];
  const ringVerts = prof.length;
  const rings = segs + 1;
  const positions = new Float32Array(rings * ringVerts * 3);
  const normals = new Float32Array(rings * ringVerts * 3);
  const uvs = new Float32Array(rings * ringVerts * 2);
  const indexCount = segs * (ringVerts - 1) * 6;
  const indices =
    rings * ringVerts > 65535
      ? new Uint32Array(indexCount)
      : new Uint16Array(indexCount);
  const frames = curve.computeFrenetFrames(segs, closed);
  const up = new THREE.Vector3();
  const out = new THREE.Vector3();
  let vi3 = 0;
  let vi2 = 0;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const center = curve.getPointAt(t);
    const centerY = getWorldHeight(center.x, center.z);
    const n = frames.normals[i];
    const b = frames.binormals[i];
    for (let j = 0; j < ringVerts; j++) {
      const p = prof[j];
      up.copy(n).multiplyScalar(p.y);
      out.copy(b).multiplyScalar(p.z * depth);
      positions[vi3] = center.x + up.x + out.x;
      positions[vi3 + 1] = centerY + up.y + out.y;
      positions[vi3 + 2] = center.z + up.z + out.z;
      normals[vi3] = b.x;
      normals[vi3 + 1] = b.y;
      normals[vi3 + 2] = b.z;
      uvs[vi2] = t * Math.max(1, segs * 0.2);
      uvs[vi2 + 1] = j / Math.max(1, ringVerts - 1);
      vi3 += 3;
      vi2 += 2;
    }
  }
  let ii = 0;
  for (let i = 0; i < segs; i++) {
    const r0 = i * ringVerts;
    const r1 = (i + 1) * ringVerts;
    for (let j = 0; j < ringVerts - 1; j++) {
      const a = r0 + j;
      const b = r1 + j;
      const c = r0 + j + 1;
      const d = r1 + j + 1;
      indices[ii++] = a;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Extrude a {y, z} profile along a curve with world +Y as vertical and width on
 * the horizontal path normal (matches v2 fullRoad barrier / guardrail accessory).
 */
export function buildWorldUpProfileGeometry(
  curve,
  pathSegs,
  profile,
  depth,
  closed,
  getWorldHeight = () => 0,
) {
  const segs = Math.max(8, pathSegs | 0);
  const prof =
    Array.isArray(profile) && profile.length >= 2
      ? profile
      : [
          { y: -0.5, z: 0.5 },
          { y: 0.5, z: 0.5 },
        ];
  const profLen = prof.length;
  const pts = curve.getSpacedPoints(segs);
  const totalVerts = (segs + 1) * profLen;
  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const worldUp = new THREE.Vector3(0, 1, 0);

  let vIdx = 0;
  let uvIdx = 0;
  let arcLen = 0;

  for (let i = 0; i <= segs; i++) {
    if (i > 0) arcLen += pts[i].distanceTo(pts[i - 1]);
    const t = i / segs;
    tangent.copy(curve.getTangentAt(Math.min(t, 1)));
    right.crossVectors(worldUp, tangent);
    if (right.lengthSq() < 1e-10) right.set(1, 0, 0);
    else right.normalize();

    const pt = pts[i];
    const baseY = getWorldHeight(pt.x, pt.z);

    for (let j = 0; j < profLen; j++) {
      const pj = prof[j];
      positions[vIdx++] = pt.x + right.x * pj.z * depth;
      positions[vIdx++] = baseY + pj.y;
      positions[vIdx++] = pt.z + right.z * pj.z * depth;
      uvs[uvIdx++] = arcLen;
      uvs[uvIdx++] = j / (profLen - 1);
    }
  }

  const indices = [];
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < profLen - 1; j++) {
      const a = i * profLen + j;
      const b = a + profLen;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function disposeGroup(group) {
  if (!group) return;
  group.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
  });
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params] guardrail params (merged with GUARDRAIL_DEFAULTS)
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildGuardrailMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...GUARDRAIL_DEFAULTS, ...params };
  const height = Math.max(0.05, p.height);
  const depth = Math.max(0.05, p.depth);
  const thickness = Math.max(0, p.thickness);
  const crown = Math.max(0, p.crownDepth);
  const pathSegs = Math.max(40, p.pathSegments | 0);

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

  const profile = makeWBeamProfile(height, depth, crown);

  const railMat = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.roughness,
    metalness: p.metalness,
    side: THREE.DoubleSide,
  });
  const postMat = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.postRoughness,
    metalness: p.postMetalness,
  });

  const group = new THREE.Group();
  group.name = "Guardrail";

  const railOuterGeo = buildGuardrailProfileGeometry(
    curve,
    pathSegs,
    profile,
    depth,
    closed,
    getWorldHeight,
  );
  const railOuter = new THREE.Mesh(railOuterGeo, railMat);
  railOuter.castShadow = true;
  railOuter.receiveShadow = true;
  group.add(railOuter);

  if (thickness > 0.002) {
    const innerDepth = Math.max(0.01, depth - thickness * 2);
    const innerHeight = Math.max(0.02, height - thickness * 2);
    const innerProfile = [
      { y: -0.5 * innerHeight, z: 0.44 },
      { y: -0.16 * innerHeight, z: 0.31 },
      { y: 0.0, z: -crown / Math.max(depth, 1e-6) },
      { y: 0.16 * innerHeight, z: 0.31 },
      { y: 0.5 * innerHeight, z: 0.44 },
    ];
    const railInnerGeo = buildGuardrailProfileGeometry(
      curve,
      pathSegs,
      innerProfile,
      innerDepth,
      closed,
      getWorldHeight,
    );
    const railInner = new THREE.Mesh(railInnerGeo, postMat);
    railInner.castShadow = true;
    railInner.receiveShadow = true;
    group.add(railInner);
  }

  railOuter.position.y += p.railYOffset;
  if (group.children[1]) group.children[1].position.y += p.railYOffset;

  const length = curve.getLength();
  const postCount = Math.max(
    2,
    Math.floor(length / Math.max(0.5, p.postSpacing)) + 1,
  );
  const tangent = new THREE.Vector3();

  for (let i = 0; i < postCount; i++) {
    const t = closed ? i / postCount : i / Math.max(1, postCount - 1);
    const pos = curve.getPointAt(t);
    tangent.copy(curve.getTangentAt(t));
    const groundY = getWorldHeight(pos.x, pos.z) - p.postSink;
    const railBottomY = pos.y + p.railYOffset - height * 0.5;
    const postH = Math.max(
      p.postHeight,
      railBottomY - groundY + thickness * 0.5,
    );
    const postGeo = new THREE.BoxGeometry(p.postWidth, postH, p.postDepth);
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(pos.x, groundY + postH * 0.5, pos.z);
    post.rotation.y = Math.atan2(tangent.x, tangent.z);
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);
  }

  return group;
}

/** @param {THREE.Group|null} group */
export function disposeGuardrail(group) {
  disposeGroup(group);
}

/** Preset spline paths for the objects lab. */
export const SPLINE_PRESETS = {
  straight: [
    { x: -22, y: 0, z: 18 },
    { x: 22, y: 0, z: 18 },
  ],
  sCurve: [
    { x: -28, y: 0, z: 8 },
    { x: -10, y: 0, z: 28 },
    { x: 10, y: 0, z: 8 },
    { x: 28, y: 0, z: 28 },
  ],
  tight90: [
    { x: -18, y: 0, z: -4 },
    { x: -18, y: 0, z: 18 },
    { x: 6, y: 0, z: 18 },
  ],
  hairpin: [
    { x: -20, y: 0, z: -8 },
    { x: -6, y: 0, z: 12 },
    { x: 8, y: 0, z: -4 },
    { x: 20, y: 0, z: 16 },
  ],
};

/** Fixed hero strip — short straight segment for close-up tuning. */
export const HERO_STRIP_POINTS = [
  { x: -6, y: 0, z: -14 },
  { x: 6, y: 0, z: -14 },
];
