// THE PAINTED PORTRAITS — your ChatGPT sheets (2026-10-02), packed by
// tools/packPortraits.py into two WebPs (240 KB + 50 KB; the PNGs were 4.8 MB):
//   portraits_soldiers.webp  8 x 4 cells of 160 x 200 (rows 1-2 French, 3-4 ALN)
//   portraits_vehicles.webp  3 x 2 cells of 240 x 270
// (the tool's atlases; the game loads the per-cell files it cuts from them).
//
// They REPLACE the baked 3D thumbnails in the shared map every panel reads
// (tabs, selection card, command card, queue badges): one file per face,
// cut by the same tool (public/textures/ui/portraits/s<cell>.webp, v<cell>.webp).
// Cutting them in the browser at boot (38 canvas toBlob encodes) cost ~6 s:
// the encodes queued behind the GPU's shader compiles (audit 2026-10-03).
// Several faces per type: `faceOf(unit)` picks one per man (stable: by his
// place in the unit list) for wherever one man is shown.
const DIR = "/textures/ui/portraits/";
const soldierUrl = (cell) => `${DIR}s${cell}.webp`;
const vehicleUrl = (cell) => `${DIR}v${cell}.webp`;

/** Sheet cell → who. The first face of a list is the type's portrait. */
const FACES = {
  appele: [0, 1, 9, 10, 3, 11, 14, 15],      // helmets, bush hat, camo cover
  sapeur: [2, 13, 12],
  piece: [10, 3, 1],                         // the section's faces: the gunner's team                       // goggles on the helmet, the beret
  para: [4, 5],                              // red berets
  legion: [6, 7],                            // white képis
  colonel: [8],                              // the officer's képi: Colonel Delorme
  moudjahid: [16, 17, 18, 19, 20, 23, 24, 26, 27, 31],
  fmTeam: [21, 22, 25, 28, 29],              // bandoliers: the FM gunners
  siTahar: [30],                             // the hooded kachabia: Commandant Si Tahar
};
const VEHICLE_CELLS = { willys: 0, gmc: 1, halftrack: 2, amx13: 3, ebr: 4, alouette: 5 };

/** True when a type has a painted portrait (its 3D thumbnail need not be baked). */
export const hasPortrait = (key) => key in FACES || key in VEHICLE_CELLS;

/**
 * Put each type's portrait into `thumbnails` (the shared Map key → URL).
 * Resolves to { faceOf(unit) } — a man's own face URL.
 */
export async function installPortraits(thumbnails, units = null) {
  const faces = {};
  for (const [key, cells] of Object.entries(FACES)) {
    faces[key] = cells.map(soldierUrl);
    thumbnails?.set(key, faces[key][0]);
  }
  for (const [key, cell] of Object.entries(VEHICLE_CELLS)) thumbnails?.set(key, vehicleUrl(cell));
  // Into the browser's cache now (not awaited), so a panel does not pop in empty.
  for (const url of [...Object.values(faces).flat(), ...Object.values(VEHICLE_CELLS).map(vehicleUrl)]) new Image().src = url;
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
