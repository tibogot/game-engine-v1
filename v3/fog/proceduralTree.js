/**
 * Seeded procedural trees — recursive branching, merged into two draw calls.
 *
 * Geometry only. Shading is left to the caller so the trees can carry whatever
 * TSL material the scene needs; all this does is hand back one merged wood
 * geometry, one merged foliage geometry, and the trunk footprints (so a fog or
 * collision system can be told where the trunks are without re-deriving them).
 *
 * Wood and foliage merge SEPARATELY and not by accident: mergeGeometries needs
 * every input to agree on indexing, and CylinderGeometry is indexed while
 * IcosahedronGeometry (via PolyhedronGeometry) is not. Merging the two together
 * fails; merging each group is fine.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

/** mulberry32 — small, fast, and identical across reloads. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _direction = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quaternion = new THREE.Quaternion();
const _matrix = new THREE.Matrix4();

/** A tapered cylinder from `start` to `end`, baked into world space. */
function branchGeometry(start, end, radiusStart, radiusEnd, radialSegments) {
  _direction.subVectors(end, start);
  const length = _direction.length();

  // Open-ended: the caps are always either buried in the parent branch, hidden
  // under a foliage cluster, or sub-centimetre at a twig tip.
  const geometry = new THREE.CylinderGeometry(
    radiusEnd, radiusStart, length, radialSegments, 1, true,
  );

  _quaternion.setFromUnitVectors(UP, _direction.clone().normalize());
  _matrix.makeRotationFromQuaternion(_quaternion).setPosition(
    start.x + _direction.x * 0.5,
    start.y + _direction.y * 0.5,
    start.z + _direction.z * 0.5,
  );
  geometry.applyMatrix4(_matrix);
  return geometry;
}

function perpendicular(direction, target) {
  // Cross with whichever reference axis is further from parallel, so a vertical
  // trunk does not produce a zero-length axis.
  const reference = Math.abs(direction.y) > 0.95 ? SIDE : UP;
  return target.crossVectors(direction, reference).normalize();
}

function grow(random, out, origin, direction, length, radius, depth) {
  const end = origin.clone().addScaledVector(direction, length);
  out.wood.push(branchGeometry(origin, end, radius, radius * 0.66, depth > 1 ? 7 : 5));

  if (depth <= 0) {
    out.tips.push(end);
    return;
  }

  const children = 2 + (random() < 0.45 ? 1 : 0);
  for (let i = 0; i < children; i++) {
    const child = direction.clone();
    // Tilt away from the parent axis, then spin the tilted copy AROUND that axis
    // so siblings fan out instead of stacking in one plane.
    child.applyAxisAngle(perpendicular(direction, _axis), 0.3 + random() * 0.34);
    child.applyAxisAngle(direction, (i / children) * Math.PI * 2 + random() * 1.2);
    // Phototropism. Load-bearing: without it deep branches keep inheriting their
    // parent's tilt and the crown flattens into an umbrella.
    child.y += 0.4;
    child.normalize();

    grow(
      random, out, end, child,
      length * (0.64 + random() * 0.14),
      radius * 0.62,
      depth - 1,
    );
  }
}

/**
 * @param {Array<{x: number, z: number, height?: number, seed?: number}>} placements
 * @param {object} [options]
 * @param {number} [options.depth=4] - Branch recursion depth. Cost is ~3^depth.
 * @param {number} [options.foliageScale=1] - Multiplier on cluster radius.
 * @returns {{
 *   wood: THREE.BufferGeometry,
 *   foliage: THREE.BufferGeometry,
 *   obstacles: Array<{x: number, z: number, radius: number}>,
 * }}
 */
export function buildTreeField(placements, options = {}) {
  const { depth = 4, foliageScale = 1 } = options;
  const out = { wood: [], foliage: [], tips: [] };
  const obstacles = [];

  placements.forEach((placement, index) => {
    const random = seededRandom(placement.seed ?? 9001 + index * 7919);
    const height = placement.height ?? 5.5;
    const trunkRadius = height * 0.032;

    out.tips.length = 0;

    const origin = new THREE.Vector3(placement.x, -0.15, placement.z);
    // Slight lean off vertical, otherwise a row of trees reads as telegraph poles.
    _direction.set((random() - 0.5) * 0.18, 1, (random() - 0.5) * 0.18).normalize();
    grow(random, out, origin, _direction.clone(), height * 0.4, trunkRadius, depth);

    // Foliage clusters at the twig tips. Faceted low-poly blobs on purpose: in
    // silhouette against bright fog the facets read as canopy mass, and a smooth
    // sphere reads as a balloon.
    // Several small blobs per tip rather than one large one: at cluster sizes
    // much above this the individual icosahedra stop overlapping and the crown
    // reads as a handful of separate rocks stuck to a branch.
    const clusterRadius = height * 0.062 * foliageScale;
    for (const tip of out.tips) {
      const count = 2 + (random() < 0.5 ? 1 : 0);
      for (let i = 0; i < count; i++) {
        const r = clusterRadius * (0.68 + random() * 0.55);
        const blob = new THREE.IcosahedronGeometry(r, 0);
        blob.scale(1, 0.78 + random() * 0.36, 1);
        blob.rotateY(random() * Math.PI);
        blob.rotateX(random() * Math.PI);
        blob.translate(
          tip.x + (random() - 0.5) * r * 1.8,
          tip.y + (random() - 0.5) * r * 1.2,
          tip.z + (random() - 0.5) * r * 1.8,
        );
        out.foliage.push(blob);
      }
    }

    obstacles.push({ x: placement.x, z: placement.z, radius: trunkRadius + 0.75 });
  });

  return {
    wood: mergeGeometries(out.wood),
    foliage: mergeGeometries(out.foliage),
    obstacles,
  };
}
