import * as THREE from "three";

/**
 * Procedural fence along a Catmull-Rom spline.
 * Standalone lab module — param names mirror v2/toolState for later porting.
 */

export const FENCE_DEFAULTS = {
  height: 1.5,
  postSpacing: 2.5,
  postWidth: 0.06,
  postDepth: 0.04,
  railCount: 3,
  railThickness: 0.04,
  pathSegments: 80,
  color: "#5a5a5a",
  roughness: 0.6,
  metalness: 0.3,
};

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
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildFenceMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  const p = { ...FENCE_DEFAULTS, ...params };
  const fenceHeight = Math.max(0.35, p.height);
  const postSpacing = Math.max(0.4, p.postSpacing);
  const postWidth = Math.max(0.02, p.postWidth);
  const postDepth = Math.max(0.02, p.postDepth);
  const railCount = Math.max(1, p.railCount | 0);
  const railThick = Math.max(0.01, p.railThickness);
  const segCount = Math.max(16, p.pathSegments | 0);

  const groundedPoints = points.map((pt) => {
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    return new THREE.Vector3(v.x, getWorldHeight(v.x, v.z), v.z);
  });

  const fenceCurve = new THREE.CatmullRomCurve3(
    groundedPoints,
    !!closed,
    "catmullrom",
    0.5,
  );
  const length = fenceCurve.getLength();

  const mat = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: p.roughness,
    metalness: p.metalness,
  });

  const group = new THREE.Group();
  group.name = "Fence";

  const postCount = Math.max(
    2,
    Math.floor(length / postSpacing) + 1,
  );

  for (let i = 0; i < postCount; i++) {
    const t = closed ? i / postCount : i / Math.max(1, postCount - 1);
    const pos = fenceCurve.getPointAt(t);
    const tangent = fenceCurve.getTangentAt(t);
    const groundY = getWorldHeight(pos.x, pos.z);

    const postGeo = new THREE.BoxGeometry(postWidth, fenceHeight, postDepth);
    const post = new THREE.Mesh(postGeo, mat);
    post.position.set(pos.x, groundY + fenceHeight * 0.5, pos.z);
    post.rotation.y = Math.atan2(tangent.x, tangent.z);
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);
  }

  for (let r = 0; r < railCount; r++) {
    const railY =
      fenceHeight * (0.2 + (0.6 * r) / Math.max(1, railCount - 1));
    const railPoints = [];

    for (let i = 0; i <= segCount; i++) {
      const t = i / segCount;
      const pos = fenceCurve.getPointAt(t);
      const groundY = getWorldHeight(pos.x, pos.z);
      railPoints.push(new THREE.Vector3(pos.x, groundY + railY, pos.z));
    }

    const railCurve = new THREE.CatmullRomCurve3(
      railPoints,
      closed,
      "catmullrom",
      0.5,
    );
    const tubeGeo = new THREE.TubeGeometry(
      railCurve,
      segCount,
      railThick * 0.5,
      6,
      closed,
    );
    const rail = new THREE.Mesh(tubeGeo, mat);
    rail.castShadow = true;
    rail.receiveShadow = true;
    group.add(rail);
  }

  return group;
}

/** @param {THREE.Group|null} group */
export function disposeFence(group) {
  disposeGroup(group);
}
