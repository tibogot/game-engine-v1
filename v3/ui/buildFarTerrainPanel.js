/**
 * FAR TERRAIN panel (World tab) — the ground past the heightmap
 * (v3/terrain/farTerrain.js): on/off, how the far grid meets the map and
 * stands up with distance, and the rule that paints it with the map's own
 * layers. Saved with the project. The grid itself comes from a tool (the
 * real country round a DEM map: tools/algMountains.mjs) — with none loaded
 * the panel says so and the plain outside the map stays flat.
 */
import { section, slider, toggle, dropdown, hint, info } from "./widgets.js";

/**
 * @param {HTMLElement} container  where the section goes (the World tab)
 * @param {object} farTerrain     createFarTerrain()
 * @param {(p: object) => void} apply  the app's setFarTerrain (live + saved)
 * @param {() => string[]} layerNames  the paint slots' names, for the rule's pickers
 */
export function buildFarTerrainPanel({ container, farTerrain, apply, layerNames = () => [] }) {
  const body = section(container, "Far Terrain", false);
  hint(body, "The ground past the map's edge, drawn by the terrain itself with the map's own layers. Needs a far grid in the project (a tool writes it).");
  const P = farTerrain.params;
  const R = P.rule;
  info(body, "Grid", "", { refresh: () => (farTerrain.grid ? `${P.n}² over ±${Math.round(P.extent)} m` : "none in this project") });
  const push = () => apply({ ...P, rule: { ...R } });
  toggle(body, P, "enabled", { label: "Enabled", onChange: push });
  slider(body, P, "blend", { label: "Edge blend", min: 0, max: 800, step: 10, onChange: push, hint: "Metres past the edge over which the map's edge heights become the far ground." });
  slider(body, P, "stand", { label: "Stand", min: 1, max: 5, step: 0.05, onChange: push, hint: "Relief multiplier far out: at map scale real ridges read as dunes on the horizon." });
  slider(body, P, "standStart", { label: "Stand from", min: 0, max: 2000, step: 10, onChange: push });
  slider(body, P, "standEnd", { label: "Stand full at", min: 100, max: 4000, step: 50, onChange: push });

  const slots = () => {
    const names = layerNames();
    return [[-1, "— none —"], ...names.map((n, i) => [i, `${i + 1}. ${n || "empty"}`])];
  };
  const rule = section(body, "Paint rule", false);
  hint(rule, "No splatmap out there: each far pixel takes its layer from its slope and height.");
  for (const [key, label] of [["flatSlot", "Flat"], ["highSlot", "High ground"], ["screeSlot", "Slopes"], ["cliffSlot", "Cliffs"]]) {
    dropdown(rule, R, key, { label, options: slots(), onChange: push });
  }
  slider(rule, R, "screeLo", { label: "Slope from (°)", min: 0, max: 60, step: 1, onChange: push });
  slider(rule, R, "screeHi", { label: "Slope full (°)", min: 0, max: 60, step: 1, onChange: push });
  slider(rule, R, "cliffLo", { label: "Cliff from (°)", min: 0, max: 80, step: 1, onChange: push });
  slider(rule, R, "cliffHi", { label: "Cliff full (°)", min: 0, max: 80, step: 1, onChange: push });
  slider(rule, R, "highLo", { label: "High from (m)", min: 0, max: 400, step: 1, onChange: push });
  slider(rule, R, "highHi", { label: "High full (m)", min: 0, max: 400, step: 1, onChange: push });
  return { body };
}
