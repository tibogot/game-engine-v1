// THE PAINTED PORTRAITS — your ChatGPT sheets (2026-10-02), packed by
// tools/packPortraits.py into two WebPs (240 KB + 50 KB; the PNGs were 4.8 MB):
//   portraits_soldiers.webp  8 x 4 cells of 160 x 200 (rows 1-2 French, 3-4 ALN)
//   portraits_vehicles.webp  3 x 2 cells of 240 x 270
//
// They REPLACE the baked 3D thumbnails in the shared map every panel reads
// (tabs, selection card, command card, queue badges): one blob URL per type,
// cut once at load. Several faces per type: `faceOf(unit)` picks one per man
// (stable: by his place in the unit list) for wherever one man is shown.
const SOLDIERS = { url: "/textures/ui/portraits_soldiers.webp", cols: 8, w: 160, h: 200 };
const VEHICLES = { url: "/textures/ui/portraits_vehicles.webp", cols: 3, w: 240, h: 270 };

/** Sheet cell → who. The first face of a list is the type's portrait. */
const FACES = {
  appele: [0, 1, 9, 10, 3, 11, 14, 15],      // helmets, bush hat, camo cover
  sapeur: [2, 13, 12],                       // goggles on the helmet, the beret
  para: [4, 5],                              // red berets
  legion: [6, 7],                            // white képis
  colonel: [8],                              // the officer's képi: Colonel Delorme
  moudjahid: [16, 17, 18, 19, 20, 23, 24, 26, 27, 31],
  fmTeam: [21, 22, 25, 28, 29],              // bandoliers: the FM gunners
  siTahar: [30],                             // the hooded kachabia: Commandant Si Tahar
};
const VEHICLE_CELLS = { willys: 0, gmc: 1, halftrack: 2, amx13: 3, ebr: 4, alouette: 5 };

function load(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}
async function cut(img, sheet, cell) {
  const c = document.createElement("canvas");
  c.width = sheet.w; c.height = sheet.h;
  c.getContext("2d").drawImage(img, (cell % sheet.cols) * sheet.w, Math.floor(cell / sheet.cols) * sheet.h, sheet.w, sheet.h, 0, 0, sheet.w, sheet.h);
  const blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.88));
  return URL.createObjectURL(blob);
}

/**
 * Load the sheets and put each type's portrait into `thumbnails` (the shared
 * Map key → URL). Resolves to { faceOf(unit) } — a man's own face URL.
 */
export async function installPortraits(thumbnails, units = null) {
  const [s, v] = await Promise.all([load(SOLDIERS.url), load(VEHICLES.url)]);
  const faces = {};
  for (const [key, cells] of Object.entries(FACES)) {
    faces[key] = await Promise.all(cells.map((c) => cut(s, SOLDIERS, c)));
    thumbnails?.set(key, faces[key][0]);
  }
  for (const [key, cell] of Object.entries(VEHICLE_CELLS)) thumbnails?.set(key, await cut(v, VEHICLES, cell));
  return {
    faces,
    /** One man's face, stable for him (vehicles: the type's card). */
    faceOf(u) {
      const list = faces[u.typeKey];
      if (!list) return thumbnails?.get(u.typeKey) ?? null;
      const i = units ? Math.max(0, units.list.indexOf(u)) : 0;
      return list[i % list.length];
    },
  };
}
