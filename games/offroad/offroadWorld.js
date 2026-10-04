// THE WORLD AS THE OFF-ROAD TRUCK FEELS IT — built from a loaded level through
// the public engine handle only (no engine change):
//
//   ground    the terrain heightmap (app.getWorldHeight) + a BVH of the
//             level's SOLID rock props: the wheels ride both
//   solids    the same rock BVH: the bodywork rests on / is pushed off rocks
//   getFloorY the terrain height (chassis corners)
//   getSurface grip and rolling resistance under a wheel, from the terrain
//             PAINT (app.samplePaintWeights) — or rock, on a rock prop
//
// The rock shapes are the engine's own (v3/props/proceduralRock.js, public):
// getRockGeometry is memoised, so asking for a type's params returns the very
// geometry the props draw — collision and visuals cannot disagree.
import * as THREE from "three";
import { createVehicleGround } from "../../v3/play/modularRoadGround.js";
import { RoadBvh } from "../../v3/play/modularRoadBvh.js";
import { getRockGeometry, rockKitParams, ROCK_CLIFF_PRESETS } from "../../v3/props/proceduralRock.js";

const DEG = Math.PI / 180;

/** Grip by paint layer, for a level that does not pass its own. Index = paint slot. */
export const DEFAULT_SURFACES = [{ mu: 1, roll: 0.02 }];
/** On a rock prop: grippy, rolls freely. */
export const ROCK_SURFACE = { mu: 1.05, roll: 0.005 };

/**
 * @param {object} app  the engine handle (after the level loaded)
 * @param {object} [o]
 * @param {{mu:number,roll:number}[]} [o.surfaces]  per paint slot
 */
export function createOffroadWorld(app, { surfaces = DEFAULT_SURFACES } = {}) {
  const t0 = performance.now();
  const store = app.propStore;
  const cliffParams = new Map(ROCK_CLIFF_PRESETS.map((c) => [c.name, c.params]));
  const meshes = [];
  let tris = 0;
  for (const inst of store?.instances ?? []) {
    const type = store.types[inst.typeIdx];
    if (!type?.solid) continue;                       // pebbles and stones: not worth colliding
    const params = cliffParams.get(type.name) ?? rockKitParams(type.name);
    if (!params) continue;                            // not a rock (a house, a bridge…)
    const geo = getRockGeometry(params);
    const m = new THREE.Mesh(geo);
    m.position.set(inst.px, inst.py, inst.pz);
    m.rotation.set((inst.rx ?? 0) * DEG, (inst.ry ?? 0) * DEG, (inst.rz ?? 0) * DEG);
    m.scale.set(inst.sx ?? 1, inst.sy ?? 1, inst.sz ?? 1);
    m.updateMatrixWorld(true);
    meshes.push(m);
    tris += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
  }
  const rocks = new RoadBvh();
  if (meshes.length) rocks.bakeFromMeshes(meshes);
  const getFloorY = (x, z) => app.getWorldHeight(x, z);
  const { ground } = createVehicleGround({ getTerrainHeight: getFloorY, roadBvh: rocks, roadSolidsBvh: rocks });

  const getSurface = (x, z, source) => {
    if (source !== "terrain") return ROCK_SURFACE;
    const w = app.samplePaintWeights?.(x, z);
    if (!w) return surfaces[0] ?? DEFAULT_SURFACES[0];
    let mu = 0, roll = 0, sum = 0;
    for (let i = 0; i < w.length; i++) {
      const s = surfaces[i];
      if (!s || !(w[i] > 0)) continue;
      mu += w[i] * s.mu; roll += w[i] * s.roll; sum += w[i];
    }
    return sum > 0 ? { mu: mu / sum, roll: roll / sum } : (surfaces[0] ?? DEFAULT_SURFACES[0]);
  };

  console.log(`[offroad] rock collision: ${meshes.length} rocks, ${Math.round(tris / 1000)}k triangles, ${Math.round(performance.now() - t0)} ms`);
  return { ground, solids: meshes.length ? rocks : null, getFloorY, getSurface, rockCount: meshes.length };
}
