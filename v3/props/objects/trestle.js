import * as THREE from "three";

/**
 * Shared "trestle" helpers: structures whose DECK is authored (flat, graded,
 * or arched) while their LEGS individually reach down to whatever ground is
 * under them.
 *
 * This is the piece that makes docks, pier bridges and aqueducts all work:
 * once the deck is authored, everything above a pier top is invariant and
 * only the leg length varies. Sample the ground at each leg's OWN xz (legs
 * are usually offset sideways from the path centre), and the structure
 * plants itself on any terrain.
 *
 * Used by: boatDock.js (piles), trestleBridge.js (timber bents),
 * aqueduct.js (stone piers).
 *
 * NOTE: terrain-adaptive legs only do anything when the caller passes a real
 * `getWorldHeight`. The props adapter builds on flat ground by design (a prop
 * is one transform), so adaptive legs are a SPLINE-MODE behaviour.
 */

export const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * Work out one leg's extent from the deck down to the ground beneath it.
 *
 * @param {number} topY      leg top (deck underside) world Y
 * @param {number} groundY   ground height sampled at the LEG's xz
 * @param {object} [opts]
 * @param {number} [opts.embed]     how far to sink below the ground (hides the
 *                                  foot and survives terrain edits)
 * @param {number} [opts.maxLength] clamp; 0 = unlimited (viaducts want 0, a
 *                                  dock wants a sane cap so a deep hole under
 *                                  it doesn't grow a 40 m spike)
 * @param {number} [opts.minLength] never shorter than this (keeps a leg from
 *                                  vanishing where the deck grazes the ground)
 * @returns {{bottomY:number, length:number, midY:number, clamped:boolean}}
 */
export function legSpan(topY, groundY, opts = {}) {
  const embed = opts.embed ?? 0.35;
  const maxLength = opts.maxLength ?? 0;
  const minLength = opts.minLength ?? 0.15;

  let bottomY = groundY - embed;
  let clamped = false;

  if (maxLength > 0 && topY - bottomY > maxLength) {
    bottomY = topY - maxLength;
    clamped = true; // leg stops short — deck is very high above this spot
  }
  let length = topY - bottomY;
  if (length < minLength) {
    length = minLength;
    bottomY = topY - length;
  }
  return { bottomY, length, midY: (topY + bottomY) * 0.5, clamped };
}

/** Bake a solid color into every vertex of a geometry (in-place). */
export function bakeColor(geo, color) {
  const n = geo.attributes.position.count;
  const buf = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    buf[i * 3] = color.r;
    buf[i * 3 + 1] = color.g;
    buf[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(buf, 3));
  return geo;
}

/**
 * Sweep a square cross-section along world-space centres (rails, ropes,
 * strands, channel edges). Frames are derived from the centreline itself.
 */
export function sweepSquare(centers, r) {
  const rings = centers.length;
  const pos = new Float32Array(rings * 4 * 3);
  const idx = [];
  const fwd = new THREE.Vector3();
  const rt = new THREE.Vector3();
  const up = new THREE.Vector3();
  const v = new THREE.Vector3();

  let o = 0;
  for (let i = 0; i < rings; i++) {
    const a = centers[Math.max(0, i - 1)];
    const b = centers[Math.min(rings - 1, i + 1)];
    fwd.subVectors(b, a).normalize();
    if (fwd.lengthSq() < 1e-9) fwd.set(0, 0, 1);
    rt.crossVectors(WORLD_UP, fwd);
    if (rt.lengthSq() < 1e-9) rt.set(1, 0, 0);
    rt.normalize();
    up.crossVectors(fwd, rt).normalize();
    const c = centers[i];
    for (const [x, y] of [
      [r, r],
      [-r, r],
      [-r, -r],
      [r, -r],
    ]) {
      v.copy(c).addScaledVector(rt, x).addScaledVector(up, y);
      pos[o++] = v.x;
      pos[o++] = v.y;
      pos[o++] = v.z;
    }
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      idx.push(i * 4 + k, i * 4 + k2, (i + 1) * 4 + k2);
      idx.push(i * 4 + k, (i + 1) * 4 + k2, (i + 1) * 4 + k);
    }
  }
  idx.push(0, 2, 1, 0, 3, 2);
  const last = (rings - 1) * 4;
  idx.push(last, last + 1, last + 2, last, last + 2, last + 3);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Matrices for the voussoirs (wedge blocks) of a semicircular arch springing
 * between two points at the same height — the arcade unit of an aqueduct or
 * a masonry viaduct.
 *
 * The arch plane is the vertical plane through `a` and `b`; `depth` runs
 * horizontally across it (the structure's width).
 *
 * @param {THREE.Vector3} a springing point (pier top, near side)
 * @param {THREE.Vector3} b springing point (pier top, far side)
 * @param {object} opts
 * @param {number} opts.count      voussoirs in the arch
 * @param {number} opts.thickness  radial thickness of the ring
 * @param {number} opts.depth      across-the-path width
 * @param {number} [opts.riseScale] 1 = semicircle; <1 = segmental (flatter)
 * @param {number} [opts.gap]      shrink each block slightly to read the joints
 * @returns {THREE.Matrix4[]}
 */
export function archVoussoirs(a, b, opts) {
  const count = Math.max(3, opts.count | 0);
  const thickness = opts.thickness;
  const depth = opts.depth;
  const riseScale = opts.riseScale ?? 1;
  const gap = opts.gap ?? 0.02;

  const chord = new THREE.Vector3().subVectors(b, a);
  const span = chord.length();
  if (span < 1e-4) return [];
  const d = chord.clone().normalize(); // along the path
  const across = new THREE.Vector3().crossVectors(WORLD_UP, d).normalize();
  const centre = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  const R = span * 0.5;

  const out = [];
  const arcLen = (Math.PI * R) / count;
  const pos = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const radial = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const scl = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const th = (Math.PI * (i + 0.5)) / count; // 0 at `a`, PI at `b`
    const c = Math.cos(th);
    const s = Math.sin(th);

    // point on the arch centreline (mid-thickness of the ring)
    pos
      .copy(centre)
      .addScaledVector(d, -R * c)
      .addScaledVector(WORLD_UP, R * s * riseScale);

    // radial = outward from the arch centre; tangent = along the ring
    radial
      .set(0, 0, 0)
      .addScaledVector(d, -c)
      .addScaledVector(WORLD_UP, s * riseScale)
      .normalize();
    tangent
      .set(0, 0, 0)
      .addScaledVector(d, s)
      .addScaledVector(WORLD_UP, c * riseScale)
      .normalize();

    scl.set(Math.max(0.02, arcLen - gap), thickness, depth);
    m.makeBasis(tangent, radial, across).scale(scl).setPosition(pos);
    out.push(m.clone());
  }
  return out;
}
