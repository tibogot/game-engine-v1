// THE WORLDS a track is built in (user, 2026-10-19: "far away mountains that break the horizon… a
// switch to choose that map or the flat one… the flat one at least infinite"). A track carries its
// world (`track.world`), like Trackmania's environments, so it always looks as its author built it.
//   flat    the engine's floor to the horizon (no edge), a sky-tinted haze far out
//   valley  the same flat play area, ringed by far mountains from ~4 km out
// Both use the engine's FAR TERRAIN (terrainLOD's extra rings to ±8 km round the camera, drawn with the
// terrain's own material — no backdrop mesh, no seam) and its distance fog. Game code only: no engine
// change. The far ground is NOT solid (app.getWorldHeight reads the map only): the play area is flat.
// The ground is TEXTURED (below); each world has a "· grid" twin with the engine's grid ground.

// GROUND (user, 2026-10-20: "texturize the terrain so it's not the default grid, but keep the possibility
// to use the default terrain grid"): the worlds are TEXTURED — grass on the flat, rocky ground on slopes,
// cliff rock on steep faces, bare rock high up (the engine's slope / height paint: setAutoPaint on the
// play area, the far rule on the mountains) — and each has a "· grid" twin with the engine's grid ground.
export const WORLDS = {
  valley: { label: "Valley", shape: "valley" },
  flat: { label: "Flat", shape: "flat" },
  valley_grid: { label: "Valley · grid", shape: "valley", grid: true },
  flat_grid: { label: "Flat · grid", shape: "flat", grid: true },
};
export const DEFAULT_WORLD = "flat";

// TIME OF DAY a track is driven at (track.tod, hours; user, 2026-10-20: track settings). The drive page sets it
// BEFORE its sun-shadow bake, so the baked shadows always match the track's sun.
// Picked by the SUN'S HEIGHT on the engine's calendar (it sets ~18:10): morning ~23°, sunset ~8°, dusk ~1°.
// No night yet: without its own exposure / lights the night is near black (seen 2026-10-20).
export const TIMES = [[7.5, "Morning"], [12.5, "Midday"], [15.5, "Afternoon"], [17.6, "Sunset"], [18.1, "Dusk"]];
export const DEFAULT_TOD = 15.5;

// the paint layers (slots 0-2; Grass005 + two public/textures/ground sets, ~13 MB in all) and their tile sizes
const GROUND_SETS = [
  // a green lawn on the flat (grass_ground, the dry one, read brown from the builder's height)
  { files: (m) => `/textures/pbr_materials/Grass005/Grass005_1K-JPG_${{ diff: "Color", nor_gl: "NormalGL", rough: "Roughness", ao: "AmbientOcclusion" }[m]}.jpg`, tile: 6 }, // 0 flat
  { slug: "rocky_terrain_02", tile: 40 }, // 1 slopes: grass with stones (only on the far mountains: big tiles, no repeat pattern from km away)
  // 2 cliffs AND the tops: a grey-beige rock (cliff_side was orange strata: salmon stripes on every slope)
  { slug: "rock_boulder_dry", tile: 90 },
];
const PAINT = { flatSlot: 0, screeSlot: 1, cliffSlot: 2, highSlot: 2, screeLo: 10, screeHi: 20, cliffLo: 24, cliffHi: 34, highLo: 650, highHi: 900 };
let groundLoad = null;
/** The ground sets into paint slots 0-2, once (the engine keeps them for the session). */
function loadGround(app) {
  return (groundLoad ??= (async () => {
    for (let i = 0; i < GROUND_SETS.length; i++) {
      const { slug, files, tile } = GROUND_SETS[i];
      const f = files ?? ((m) => `/textures/ground/${slug}/${slug}_${m}_1k.jpg`);
      await app.setTerrainLayerTextures(i, { albedo: f("diff"), normal: f("nor_gl"), rough: f("rough"), ao: f("ao") });
      app.setTerrainLayerTile?.(i, tile);
    }
  })());
}

const EXTENT = 8000; // the far grid covers ±8 km round the world origin
const HAZE = { color: "#a9c2db", density: 0.00018 }; // exp²: ~4% at 1 km, ~47% at 4 km, ~92% at 8 km
// keep the grid's own colour on the far ground (no paint layers are loaded in Thunderline)
const NO_PAINT = { flatSlot: -1, highSlot: -1, screeSlot: -1, cliffSlot: -1 };

// value noise (integer hash with Math.imul: the float-sin hash repeats at this scale)
function hash(x, z) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
// ridged multifractal: sharp crests, the look of a mountain range from far away
function ridged(x, z, octaves = 6) {
  let sum = 0, amp = 0.5, freq = 1, w = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(noise(x * freq, z * freq) * 2 - 1);
    n *= n * w;
    w = Math.min(1, n * 2);
    sum += n * amp;
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Heights (metres) for the valley: flat inside, a ring of ranges rising from ~4 km, highest far out.
 * A far range reads as FAR when it rises ~4-8° over the horizon: 300-800 m at 5-7 km. The first try
 * (foot 2.7 km, peaks to 1.5 km) stood over the track like a wall.
 */
function valleyGrid(n) {
  const g = new Float32Array(n * n);
  const cell = (2 * EXTENT) / (n - 1);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -EXTENT + ix * cell, z = -EXTENT + iz * cell;
      const r = Math.hypot(x, z), ang = Math.atan2(z, x);
      // the foot of the range wanders round the valley (3.5–4.5 km), so the ring doesn't read as a circle
      const foot = 4000 + 500 * (noise(Math.cos(ang) * 2 + 7, Math.sin(ang) * 2 + 3) * 2 - 1);
      const rise = smooth(foot, foot + 2200, r);
      if (rise <= 0) continue;
      const ridges = ridged(x / 2200, z / 2200);
      const massif = 0.45 + 0.55 * noise(x / 5200 + 11, z / 5200 - 4); // some ranges higher than others
      g[iz * n + ix] = rise * (80 + 1150 * ridges * massif);
    }
  }
  return g;
}
let valleyCache = null;
let current = null; // the world applied last (a late texture load must not paint a grid world)

/**
 * Put `app` in a world. Safe to call again to switch.
 * @param app  the engine app (startV3App)
 * @param name  a WORLDS key (unknown → flat)
 */
export function applyWorld(app, name = DEFAULT_WORLD) {
  const world = WORLDS[name] ? name : DEFAULT_WORLD;
  const { shape, grid: gridLook } = WORLDS[world];
  const n = shape === "valley" ? 513 : 2;
  const grid = shape === "valley" ? (valleyCache ??= valleyGrid(513)) : new Float32Array(4);
  // stand 1: the heights as authored (the engine scales far relief up by default); blend: the map's
  // edge (flat, 0) fades into the grid over 250 m
  app.setFarTerrain({ grid, n, extent: EXTENT, stand: 1, standStart: 0, standEnd: 1, blend: 250, rule: NO_PAINT, enabled: true });
  // the GROUND: the grid at once, the paint when its textures are in (a switch back to a grid world wins)
  app.setAutoPaint?.({ enabled: false });
  if (!gridLook && app.setAutoPaint) {
    loadGround(app).then(() => {
      if (current !== world) return;
      app.setFarTerrain({ rule: PAINT });
      app.setAutoPaint({ enabled: true, flat: 0, cliff: 2, high: -1, slopeStartDeg: 24, slopeEndDeg: 34, noise: 0.3 });
    }).catch((e) => console.warn("[worlds] ground textures not loaded: the grid stays", e));
  }
  current = world;
  // the far rings reach ±8.2 km round the camera: the far plane must see their corners
  app.camera.far = Math.max(app.camera.far, 12000);
  app.camera.updateProjectionMatrix();
  // the haze that melts the ground into the sky far out (Sky Pro scales its colour by its daylight)
  app.fog?.setDistance?.({ enabled: true, color: HAZE.color, density: HAZE.density, matchSky: false });
  return world;
}
