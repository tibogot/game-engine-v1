// ── THE FLAT DEBUG GROUND ────────────────────────────────────────────────────
//
// A floor to land on. That is the whole feature.
//
// ── WHY IT IS NOT THE v3 TERRAIN ─────────────────────────────────────────────
//
// Testing a jump needs somewhere to come down. Loading a GPU clipmap terrain —
// heightmap, splat, streaming, seven PBR material sets — to get a flat surface
// at y = 0 is absurd, and MEASURED it was 104 MB of texture before anything
// appeared. The terrain stays for the off-road mode, where it is the point.
// This is for the sky track builder, where it is scaffolding.
//
// ── WHAT IT COSTS ────────────────────────────────────────────────────────────
//
// One draw, no textures, no fetches, two triangles. It is a single quad with
// the grid drawn procedurally — the same trick the city street uses, where
// every kerb and marking is shader work on one flat plane.
//
// ── IT IS ALSO A RULER ───────────────────────────────────────────────────────
//
// A blank floor tells you a jump landed. A GRIDDED floor tells you it landed
// eleven metres further than the last one, which is the question actually
// being asked when somebody is tuning a ramp. Lines every `minor` metres, a
// brighter one every `major`, and the origin axes picked out so there is a
// fixed point to measure from.

import * as THREE from "three";
import {
  Fn, uniform, positionWorld, abs, min, max, float, vec3, mix, smoothstep,
  fwidth, fract, step, length,
} from "three/tsl";

export const FLAT_GROUND_DEFAULTS = {
  /** Half-extent, metres. Big enough that a long jump cannot leave it. */
  extent: 3000,
  /** Sat a hair below zero so the CITY's street plane, which is also at zero,
   *  draws over it rather than z-fighting with it. The height the car lands on
   *  is still exactly 0 — see `groundY`. */
  visualY: -0.02,
  groundY: 0,
  minor: 10,
  major: 100,
  lineWidth: 0.06,
  base: 0x3a3f45,
  minorColor: 0x4c525a,
  majorColor: 0x6d7681,
  axisColor: 0x8fa2b5,
  /** Fades out rather than tiling to the horizon, which reads as a floor
   *  rather than as an infinite graph. */
  fadeStart: 700,
  fadeEnd: 2600,
};

/**
 * One quad, one material. `mesh` goes in the scene; `groundY` is what the
 * vehicle's floor query should return over it.
 */
export function createFlatGround(params = {}) {
  const P = { ...FLAT_GROUND_DEFAULTS, ...params };

  const geo = new THREE.PlaneGeometry(P.extent * 2, P.extent * 2);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0.0 });
  mat.name = "FlatDebugGround";

  const uMinor = uniform(P.minor);
  const uMajor = uniform(P.major);
  const uLine = uniform(P.lineWidth);
  const uBase = uniform(new THREE.Color(P.base));
  const uMinorC = uniform(new THREE.Color(P.minorColor));
  const uMajorC = uniform(new THREE.Color(P.majorColor));
  const uAxisC = uniform(new THREE.Color(P.axisColor));
  const uFade0 = uniform(P.fadeStart);
  const uFade1 = uniform(P.fadeEnd);

  mat.colorNode = Fn(() => {
    const p = positionWorld.xz;
    /*
     * FILTERED BY THE PIXEL FOOTPRINT, not by a fixed width. A grid drawn at a
     * constant world thickness turns into moire the moment the lines are finer
     * than a pixel, which on a floor stretching to the horizon is most of it.
     * Widening the line to at least one pixel keeps it a line all the way out.
     */
    const px = max(fwidth(p.x), fwidth(p.y)).toVar();
    const half = max(uLine, px).mul(0.5);

    const lineAt = (period) => {
      const d = abs(fract(p.div(period)).sub(0.5)).mul(period);
      const g = min(d.x, d.y);
      return smoothstep(half.add(px), half.sub(px), g);
    };
    const minorL = lineAt(uMinor);
    const majorL = lineAt(uMajor);
    // The origin itself, so there is a fixed point to measure a jump from.
    const axis = smoothstep(half.add(px).mul(2.0), half.sub(px), min(abs(p.x), abs(p.y)));

    let col = mix(uBase, uMinorC, minorL);
    col = mix(col, uMajorC, majorL);
    col = mix(col, uAxisC, axis);
    // Fade to the base colour with distance: a floor, not a graph to infinity.
    const d = length(p);
    return mix(col, uBase, smoothstep(uFade0, uFade1, d));
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "FlatDebugGround";
  mesh.position.y = P.visualY;
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  // Never swept into a collision bake or a merge: the floor is a HEIGHT
  // FUNCTION, not a mesh the car is resolved against.
  mesh.userData.noCollide = true;
  mesh.userData.noMerge = true;

  return {
    mesh,
    params: P,
    /** The height the vehicle lands on. Flat, so it ignores its arguments —
     *  and takes them anyway, so it can stand in for a terrain sampler. */
    heightAt: () => P.groundY,
    /** True where this ground exists at all. */
    covers: (x, z) => Math.abs(x) <= P.extent && Math.abs(z) <= P.extent,
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
