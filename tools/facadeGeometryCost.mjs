// WOULD A GEOMETRY FACADE PAY? — the triangle bill for the three.js approach.
//
// three.js's city generator builds piers, window frames, mullions and cornices
// as real instanced geometry and tags each with a `partId`, so one material
// shades every zone by branching on an attribute. That is why its piers cannot
// dither, and why it needs no second pass to recover their normals: a vertex
// normal is already the right answer.
//
// Ours does all of it analytically in the fragment shader, and that shader is
// what the driver spends the ~29 s first-frame wait compiling.
// tools/facadeShaderSizes.mjs measures the prize: relief + rooms + the
// duplicated normal pass are ~3249 of 4833 lines, 67% of the near facade.
//
// The catch is that the saving is paid for in triangles, and three.js's example
// has a few hundred buildings where ours has thousands. So before porting
// anything, this prints the bill: how many triangles the geometry facade would
// add, from the REAL archetypes and the REAL bay/floor parameters, against what
// the city draws today.
//
//   node tools/facadeGeometryCost.mjs
import { register } from "node:module";

// Same bootstrap the other city harnesses use — the facade pulls in the bloom
// MRT node, which needs the real three/webgpu build present first.
register("./threeWebgpuHook.mjs", import.meta.url);
await import("three/webgpu");
const { buildCityKit } = await import("../games/modular-road-v3/modularRoadCityKit.js");
const { FACADE_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCityFacade.js");
const { CITY_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCity.js");

const kit = buildCityKit({ seed: 20260902 });
const F = FACADE_DEFAULTS;

// A box is 12 triangles. A window frame is a flat ring — four quads, 8 tris —
// and the glass pane behind it 2. A pier runs a whole tier, so it is one box
// however many floors it spans; that is the bucketing three.js does too.
const TRIS = { pier: 12, frame: 8, pane: 2 };

let l0Today = 0, l0Geom = 0, worstBuilding = 0;
const rows = [];
for (const a of kit.archetypes) {
  const w = a.footprint, d = a.footprint;          // near enough; lots are square
  const h = a.massHeight;
  // The layout the shader would otherwise solve per pixel.
  const baysW = Math.max(1, Math.floor((w - F.pierWidth) / F.bayWidth));
  const baysD = Math.max(1, Math.floor((d - F.pierWidth) / F.bayWidth));
  const floors = Math.max(1, Math.round(h / F.floorHeight));
  const baysPerFloor = (baysW + baysD) * 2;
  const piers = baysPerFloor;                      // continuous up the tier
  const windows = baysPerFloor * floors;
  const geom = piers * TRIS.pier + windows * (TRIS.frame + TRIS.pane);
  const today = a.tris[0];
  l0Today += today;
  l0Geom += today + geom;
  worstBuilding = Math.max(worstBuilding, geom);
  rows.push({ h: h.toFixed(0), floors, baysPerFloor, windows, today, geom });
}

const n = kit.archetypes.length;
console.log(`ARCHETYPES (${n}), per building at L0`);
console.log("  height  floors  bays/floor  windows   tris today   + geometry facade");
for (const r of rows.slice(0, 8)) {
  console.log(
    `  ${String(r.h).padStart(5)} m ${String(r.floors).padStart(6)} ` +
    `${String(r.baysPerFloor).padStart(11)} ${String(r.windows).padStart(9)} ` +
    `${String(r.today).padStart(12)} ${String(r.geom).padStart(20)}`,
  );
}
console.log(`  ... ${n - 8} more`);
console.log("");
console.log(`  mean today  ${Math.round(l0Today / n).toLocaleString()} tris`);
console.log(`  mean geom   ${Math.round(l0Geom / n).toLocaleString()} tris` +
  `   (${(l0Geom / l0Today).toFixed(1)}x)`);
console.log(`  worst single building adds ${worstBuilding.toLocaleString()} tris`);

// What that means for a whole city. Only L0 would carry the detail; L1/L2 keep
// the analytic shader, so the bill scales with how many buildings are near.
console.log("");
console.log("CITY BILL — the detail only exists at L0, so this is the near set");
for (const nearCount of [20, 60, 120, 300]) {
  const add = Math.round((l0Geom - l0Today) / n) * nearCount;
  console.log(`  ${String(nearCount).padStart(4)} buildings at L0   +${add.toLocaleString()} tris`);
}
console.log("");
console.log(`  for scale: the city draws ~508,000 tris in ~81 draws today,`);
console.log(`  and CITY_DEFAULTS puts ${CITY_DEFAULTS.extent} m of city around the car.`);
