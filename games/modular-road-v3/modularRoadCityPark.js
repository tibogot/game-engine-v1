// ── PARKS IN THE SQUARES ─────────────────────────────────────────────────────
//
// One of the plazas becomes a park: grass, gravel paths, trees and benches.
//
// ── WHY A PARK AND NOT MORE CITY ─────────────────────────────────────────────
//
// Every block in this city is built or paved. A park is the only place that is
// neither, and that is the whole value of it — it is a hole in the pattern that
// reads as deliberate. A car park says "this square is empty on purpose"; a
// park says "this square was never meant to be built on", which is a different
// and better sentence for a city to be able to say.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
//
// One draw for the ground and NOTHING for the trees. The grass and its paths
// are a single instanced quad per park with the paths drawn procedurally; the
// trees are extra instances in the two tree meshes the city already draws, so
// two hundred more trees is two hundred more matrices and not one more draw.
// The benches are the one new shape, and they ride the shared clutter material.
//
// ── PATHS AND TREES COME FROM ONE DESCRIPTION ────────────────────────────────
//
// The single thing that can go wrong is a tree standing in the middle of a
// gravel path, and it happens the moment the shader and the planter each decide
// where the paths are. So `pathMask` is the only answer to "is this on a path",
// the planter calls it and the material is handed the same numbers as uniforms.

import * as THREE from "three";
import {
  uniform, uv, vec3, float, abs, min, max, smoothstep, step, mix, sin, floor, fract,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const PARK_DEFAULTS = {
  /** Off and the squares stay paved. */
  parks: true,
  /** Chance a free plaza becomes a park rather than a car park. Parks win the
   *  roll first: a city can afford one green square more easily than it can
   *  afford none. */
  parkChance: 0.55,
  /** The gravel paths: a cross through the middle and a ring inside the edge. */
  pathWidth: 2.6,
  pathInset: 12.0,
  /** Grass keeps clear of the kerb, so the park has a verge rather than
   *  running straight into the road. */
  grassInset: 4.0,
  /** Trees. `treeClear` is how far a trunk must stay off a path — a tree in
   *  the middle of a path is the one mistake anybody would notice. */
  /*
   * 7 rows over a 136 m block is an 18 m spacing — about twenty trees in a
   * square the size of a city block, which reads as a lawn somebody dropped a
   * few saplings on. 11 rows is a 12 m spacing, which is what a planted park
   * actually looks like, and it costs nothing: the trees are extra instances
   * in a mesh the city already draws.
   */
  treeRows: 11,
  treeJitter: 4.2,
  treeClear: 2.6,
  treeChance: 0.62,
  /** Benches, spaced along the ring path and facing across it. */
  benchEvery: 15.0,
  benchChance: 0.5,
  /** Colours. */
  grassColor: 0x33502c,
  grassDark: 0x24391f,
  pathColor: 0x8d8677,
};

/**
 * THE ONE ANSWER TO "IS THIS ON A PATH".
 *
 * Park-local metres, centred on the block. Returns 0 on grass and 1 on gravel;
 * the planter reads it to keep trunks and benches off, and the material is
 * given the same numbers so the two cannot disagree.
 */
export function pathMask(px, pz, P, blockW) {
  const half = P.pathWidth * 0.5;
  const ring = blockW * 0.5 - P.pathInset;
  // The cross through the middle.
  if (Math.abs(px) < half || Math.abs(pz) < half) return 1;
  // The ring: on it when either coordinate is at the ring distance and the
  // other is inside the square it encloses.
  const onX = Math.abs(Math.abs(px) - ring) < half && Math.abs(pz) <= ring + half;
  const onZ = Math.abs(Math.abs(pz) - ring) < half && Math.abs(px) <= ring + half;
  return onX || onZ ? 1 : 0;
}

/**
 * Choose the squares and lay out what stands in them.
 *
 * `skip` is every plaza something else has already taken. Returns parks with
 * their tree and bench placements; the city hands the trees to the furniture so
 * they join the existing instanced meshes.
 */
export function planParks({ plazas = [], blockW, rand, skip = [], params = {} } = {}) {
  const P = { ...PARK_DEFAULTS, ...params };
  if (!P.parks || !plazas.length) return [];
  const taken = new Set(skip.filter(Boolean).map((s) => `${s.bx},${s.bz}`));
  const parks = [];
  for (const pz of plazas) {
    if (taken.has(`${pz.bx},${pz.bz}`)) continue;
    if (rand(pz.bx, pz.bz, 63) >= P.parkChance) continue;

    const trees = [], benches = [];
    const usable = blockW - P.grassInset * 2;
    const stepR = usable / P.treeRows;
    for (let ix = 0; ix < P.treeRows; ix++) {
      for (let iz = 0; iz < P.treeRows; iz++) {
        if (rand(pz.bx * 31 + ix, pz.bz * 17 + iz, 65) >= P.treeChance) continue;
        // A grid with enough jitter that it reads as planted rather than
        // printed — a park is not an orchard.
        const jx = (rand(pz.bx + ix, pz.bz + iz, 66) - 0.5) * P.treeJitter;
        const jz = (rand(pz.bx + iz, pz.bz + ix, 67) - 0.5) * P.treeJitter;
        const px = -usable * 0.5 + (ix + 0.5) * stepR + jx;
        const pp = -usable * 0.5 + (iz + 0.5) * stepR + jz;
        /*
         * OFF THE PATHS, checked at the trunk AND at its clearance. Testing
         * the centre alone plants trees whose trunks miss the gravel by a
         * centimetre and whose canopies sit over it, which looks like an
         * accident because it is one.
         */
        let clear = true;
        for (const [ox, oz] of [[0, 0], [P.treeClear, 0], [-P.treeClear, 0], [0, P.treeClear], [0, -P.treeClear]]) {
          if (pathMask(px + ox, pp + oz, P, blockW)) { clear = false; break; }
        }
        if (!clear) continue;
        trees.push({
          x: pz.x + px, z: pz.z + pp,
          scale: 0.9 + rand(pz.bx + ix, pz.bz + iz, 68) * 0.5,
          yaw: rand(pz.bx + iz, pz.bz + ix, 69) * 6.283,
        });
      }
    }

    // Benches along the ring, facing in across the path.
    const ring = blockW * 0.5 - P.pathInset;
    const perim = ring * 8;
    const n = Math.max(4, Math.floor(perim / P.benchEvery));
    for (let i = 0; i < n; i++) {
      if (rand(pz.bx + i, pz.bz, 70) >= P.benchChance) continue;
      const t = (i / n) * 4;              // which side, and how far along it
      const side = Math.floor(t), f = (t - side) * 2 - 1;
      const off = ring + P.pathWidth * 0.5 + 0.55;
      const [bx, bz, yaw] = side === 0 ? [f * ring, -off, 0]
        : side === 1 ? [off, f * ring, -Math.PI / 2]
          : side === 2 ? [-f * ring, off, Math.PI]
            : [-off, -f * ring, Math.PI / 2];
      benches.push({ x: pz.x + bx, z: pz.z + bz, yaw });
    }

    parks.push({ x: pz.x, y: pz.y, z: pz.z, bx: pz.bx, bz: pz.bz, trees, benches });
  }
  return parks;
}

/** A park bench: two ends, a seat and a back. Base at y = 0, facing +Z. */
export function buildBenchGeometry(paint, box) {
  const parts = [
    paint(box(0.10, 0.42, 0.52, -0.72, 0), 0x3d3a35),
    paint(box(0.10, 0.42, 0.52, 0.72, 0), 0x3d3a35),
    paint(box(1.64, 0.07, 0.50, 0, 0.42), 0x6b5334),
    paint(box(1.64, 0.34, 0.07, 0, 0.49, -0.21), 0x6b5334),
  ];
  const g = mergeGeometries(parts, false);
  for (const q of parts) q.dispose();
  if (!g) throw new Error("[CityPark] bench merge returned null");
  return g;
}

/**
 * The grass and its paths: one instanced quad per park.
 *
 * Every park is one block, so the metres-per-UV scale is the same for all of
 * them and one material covers the lot with no per-instance data at all.
 */
export function buildParkGround(parks, P, blockW) {
  if (!parks.length) return null;
  const geo = new THREE.PlaneGeometry(blockW, blockW);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.0 });
  mat.name = "CityPark";
  const uBlock = uniform(blockW);
  const uHalfW = uniform(P.pathWidth * 0.5);
  const uRing = uniform(blockW * 0.5 - P.pathInset);
  const uGrass = uniform(new THREE.Color(P.grassColor));
  const uGrassDark = uniform(new THREE.Color(P.grassDark));
  const uPath = uniform(new THREE.Color(P.pathColor));

  // Park-local metres, centred — the same frame `pathMask` uses.
  const p = uv().mul(uBlock).sub(uBlock.mul(0.5));
  const px = p.x.toVar(), pz = p.y.toVar();
  const aa = float(0.06);
  const bandAt = (d) => smoothstep(uHalfW.add(aa), uHalfW.sub(aa), abs(d));
  // The cross, then the ring — the same two shapes, in the same order.
  const cross = max(bandAt(px), bandAt(pz));
  const inRing = step(abs(px), uRing.add(uHalfW)).mul(step(abs(pz), uRing.add(uHalfW)));
  const ring = max(bandAt(abs(px).sub(uRing)), bandAt(abs(pz).sub(uRing))).mul(inRing);
  const path = max(cross, ring).toVar();

  /*
   * A MOTTLE, not a flat green. Grass at one colour reads as a snooker table
   * from the air, which is exactly the view this park is most often seen from.
   * Two sines beating against each other cost less than any noise and are
   * enough at the scale a lawn is read.
   */
  const m = sin(px.mul(0.21)).mul(sin(pz.mul(0.17))).mul(0.5).add(0.5)
    .mul(sin(px.mul(0.07).add(pz.mul(0.09))).mul(0.5).add(0.5));
  const grass = mix(uGrassDark, uGrass, m.mul(0.75).add(0.25));

  mat.colorNode = mix(grass, uPath, path);
  mat.roughnessNode = mix(float(0.96), float(0.88), path);

  const mesh = new THREE.InstancedMesh(geo, mat, parks.length);
  mesh.name = "CityPark";
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  const mm = new THREE.Matrix4();
  parks.forEach((pk, i) => {
    // A hair above the walk, for the same reason the car park's paint is.
    mm.makeTranslation(pk.x, pk.y + 0.04, pk.z);
    mesh.setMatrixAt(i, mm);
  });
  mesh.instanceMatrix.needsUpdate = true;
  return { mesh, dispose() { geo.dispose(); mat.dispose(); mesh.dispose(); } };
}
