// Planted plants — the ones a PLACE puts down by hand, at a point, as opposed
// to the map's painted vegetation. A traveller's palm is an ornamental: it
// stands at a hamlet's square or a temple's gate because somebody planted it
// there, and a density field cannot say "there".
//
// The renderer is the engine's PlacedFoliage (v3/render/foliage/
// placedFoliage.js): the same geometry and the same shading as the painted
// plants, one instanced draw per plant type and detail level. Made on the
// first plant, so a map with none pays nothing.
//
// Plants are not obstacles: a trunk is thinner than a nav cell and a fan is
// six metres up. They clear the grass and ground cover round their foot so
// the trunk does not stand in a fern.
import { PlacedFoliage } from "../../v3/render/foliage/placedFoliage.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

/** The kinds a plan may name, and the preset each is built from. */
export const PLANTED = {
  travellersPalm: { preset: "travellersPalm", clear: 2.5 },
};

export function isPlanted(kind) { return kind in PLANTED; }

function ensure(app) {
  if (app.placedFoliage) return app.placedFoliage;
  const pf = new PlacedFoliage({ scene: app.scene });
  for (const [key, def] of Object.entries(PLANTED)) pf.setType(key, structuredClone(FOLIAGE_PRESETS[def.preset]));
  app.placedFoliage = pf;
  return pf;
}

/**
 * Plant one at world (x, z). `rotY` turns it (a traveller's palm shows its
 * fan's face along ±Z at 0), `scale` sizes it against its preset, `seed`
 * gives it its own sway phase and colour.
 */
export function plant(app, kind, x, z, { rotY = 0, scale = 1, seed } = {}) {
  const def = PLANTED[kind];
  if (!def) throw new Error(`placedPlants: unknown kind "${kind}"`);
  const pf = ensure(app);
  if (def.clear) app.clearVegetation?.(x, z, def.clear + 1, { grass: def.clear });
  const y = (app.getWorldHeight?.(x, z) ?? 0) - 0.05;
  pf.add(kind, x, y, z, { rotY, scale, ...(seed !== undefined ? { seed } : {}) });
}

/** Per frame: detail levels for this camera, and the sun for the see-through light. */
export function updatePlantedPlants(app, camera, sunDir) {
  const pf = app.placedFoliage;
  if (!pf) return;
  pf.setSunDir(sunDir);
  pf.update(camera);
}
