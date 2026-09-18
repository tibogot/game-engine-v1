/**
 * The card — the one geometry every ambient effect in this slice draws with,
 * and the reason the whole mode costs a single draw call.
 *
 * TWO QUADS HINGED AT A SPINE. That is the whole idea, and it is what lets a
 * butterfly and a falling leaf be the same mesh:
 *
 *     a butterfly   the hinge is the body, the halves are wings, and the
 *                   angle is driven by a flap oscillator
 *     a leaf        the hinge is the midrib, the halves are the blade, and
 *                   the angle is a small fixed fold
 *
 * A flat card would have been one quad, but a flat leaf reads as a paper chit
 * and a flat butterfly cannot flap at all. The fold costs 8 extra vertices.
 *
 * LOCAL CARD SPACE, before the particle's own orientation is applied:
 *     +Z  forward, toward the head / the leaf's tip
 *     +X  outward, toward the wing tip / the blade's edge
 *     +Y  up — the direction the hinge lifts both halves
 *
 * Each vertex carries `aCard`:
 *     x  side, −1 or +1
 *     y  u, 0 at the spine → 1 at the outer tip
 *     z  v, 0 at the tail → 1 at the head
 *     w  unused (kept so the attribute is a vec4 and the stride is friendly)
 *
 * The vertex shader builds the position from `aCard` alone — `position` is not
 * used at all — because the hinge angle is per particle and per frame, so
 * baking any of it into the buffer would be wasted.
 */
import * as THREE from "three";

/** Quads per half, along u and along v. 2×2 lets a wing CURVE as it flaps. */
const SEG_U = 2;
const SEG_V = 2;

/**
 * @returns {{ geometry: THREE.BufferGeometry, triangles: number }}
 */
export function createCardGeometry() {
  const perSide = (SEG_U + 1) * (SEG_V + 1);
  const card = new Float32Array(perSide * 2 * 4);
  const pos = new Float32Array(perSide * 2 * 3);
  const index = [];

  let w = 0;
  for (let s = 0; s < 2; s++) {
    const side = s === 0 ? -1 : 1;
    const base = s * perSide;
    for (let iv = 0; iv <= SEG_V; iv++) {
      for (let iu = 0; iu <= SEG_U; iu++) {
        const u = iu / SEG_U;
        const v = iv / SEG_V;
        card[w * 4] = side;
        card[w * 4 + 1] = u;
        card[w * 4 + 2] = v;
        card[w * 4 + 3] = 0;
        // A resting pose, so anything that reads `position` (a bounds helper,
        // a debug view) sees a card rather than a point cloud. The shader
        // rebuilds it from aCard every frame.
        pos[w * 3] = side * u * 0.5;
        pos[w * 3 + 1] = 0;
        pos[w * 3 + 2] = (v - 0.5) * 0.7;
        w++;
      }
    }
    for (let iv = 0; iv < SEG_V; iv++) {
      for (let iu = 0; iu < SEG_U; iu++) {
        const a = base + iv * (SEG_U + 1) + iu;
        const b = a + 1;
        const c = a + (SEG_U + 1);
        const d = c + 1;
        // Wound so both halves face the same way before the hinge; the
        // material is DoubleSide anyway (a wing is seen from underneath at
        // least half the time), so the winding only matters for the normal.
        if (side < 0) index.push(a, c, b, b, c, d);
        else index.push(a, b, c, b, d, c);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("aCard", new THREE.BufferAttribute(card, 4));
  geometry.setIndex(index);
  // Every instance is somewhere else entirely, so the geometry's own bounds
  // are meaningless. The compute culls, per particle.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return { geometry, triangles: index.length / 3 };
}
