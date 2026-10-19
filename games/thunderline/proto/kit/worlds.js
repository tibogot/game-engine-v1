// THE WORLDS a track is built in (user, 2026-10-19: "far away mountains that break the horizon… a
// switch to choose that map or the flat one… the flat one at least infinite"). A track carries its
// world (`track.world`), like Trackmania's environments, so it always looks as its author built it.
//   flat    the engine's floor to the horizon (no edge), a sky-tinted haze far out
//   valley  the same flat play area, ringed by far mountains from ~4 km out
// Both use the engine's FAR TERRAIN (terrainLOD's extra rings to ±8 km round the camera, drawn with the
// terrain's own material — no backdrop mesh, no seam) and its distance fog. Game code only: no engine
// change. The far ground is NOT solid (app.getWorldHeight reads the map only): the play area is flat.
// Texturing the ground and the mountains comes later.

export const WORLDS = {
  flat: { label: "Flat" },
  valley: { label: "Valley" },
};
export const DEFAULT_WORLD = "flat";

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

/**
 * Put `app` in a world. Safe to call again to switch.
 * @param app  the engine app (startV3App)
 * @param name  a WORLDS key (unknown → flat)
 */
export function applyWorld(app, name = DEFAULT_WORLD) {
  const world = WORLDS[name] ? name : DEFAULT_WORLD;
  const n = world === "valley" ? 513 : 2;
  const grid = world === "valley" ? (valleyCache ??= valleyGrid(513)) : new Float32Array(4);
  // stand 1: the heights as authored (the engine scales far relief up by default); blend: the map's
  // edge (flat, 0) fades into the grid over 250 m
  app.setFarTerrain({ grid, n, extent: EXTENT, stand: 1, standStart: 0, standEnd: 1, blend: 250, rule: NO_PAINT, enabled: true });
  // the far rings reach ±8.2 km round the camera: the far plane must see their corners
  app.camera.far = Math.max(app.camera.far, 12000);
  app.camera.updateProjectionMatrix();
  // the haze that melts the ground into the sky far out (Sky Pro scales its colour by its daylight)
  app.fog?.setDistance?.({ enabled: true, color: HAZE.color, density: HAZE.density, matchSky: false });
  return world;
}
