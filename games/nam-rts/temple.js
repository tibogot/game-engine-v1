// THE TEMPLE — Kurtz country, laid out.
//
// The kit (v3/render/objects/rtsTemple.js) builds the tower, the gate, the
// galleries, the nāga and the fig. This is where they stand relative to each
// other, which is what makes a temple a temple:
//
//   1. AN AXIS. You approach along a causeway with the nāga rail beside you,
//      pass through the gate, and the tower is dead ahead. Everything is
//      symmetrical about that line — this is the one arrangement on the map
//      that is NOT informal, and the contrast with the hamlet is the point.
//   2. AN ENCLOSURE. Galleries make a courtyard round the tower, broken
//      enough to walk through in three places, so it fights as a strongpoint
//      with hard cover and ways in, not as a wall.
//   3. THE JUNGLE WINNING. Fig roots over the galleries, rubble spilling off
//      the plinths, saplings in the courtyard. A clean ruin is a museum.
import * as THREE from "three";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import {
  buildFigRoots, buildNagaBalustrade, buildTempleGallery, buildTempleGopura,
  buildTempleRubble, buildTempleTower,
} from "../../v3/render/objects/rtsTemple.js";

/** The compound's pieces in LOCAL metres: the axis runs along -Z, the way in. */
export function templePlan() {
  const out = [];
  const add = (kind, x, z, rotY = 0, extra = {}) => out.push({ kind, x, z, rotY, ...extra });

  // The sanctuary, on the axis.
  add("tower", 0, 14, 0.04, { seed: 3 });
  // Its courtyard: galleries on three sides, each broken somewhere.
  add("gallery", -13, 12, Math.PI / 2 + 0.03, { seed: 7, length: 13 });
  add("gallery", 13.5, 12, Math.PI / 2 - 0.03, { seed: 21, length: 13, collapse: 0.55 });
  add("gallery", 0, 26, 0.02, { seed: 33, length: 14, collapse: 0.3 });
  // The gate, and the causeway out to the jungle.
  add("gopura", 0, -3, 0, { seed: 11 });
  add("naga", -3.2, -13, 0, { seed: 17, length: 10 });
  add("naga", 3.2, -13, Math.PI, { seed: 19, length: 10 });
  // The fig, on the galleries it is pulling down.
  add("fig", -12.5, 9, Math.PI / 2 + 0.03, { seed: 3, width: 7, height: 4.2 });
  add("fig", 13, 16, Math.PI / 2 - 0.03, { seed: 23, width: 6, height: 3.8 });
  add("fig", 2, 27.5, 0.02, { seed: 41, width: 5, height: 3.4 });
  // Rubble: off the gate's flanks, in the courtyard, and out along the way in.
  add("rubble", -8.5, -4, 0.5, { seed: 13 });
  add("rubble", 9, -2, 1.2, { seed: 31 });
  add("rubble", -6, 20, 2.1, { seed: 47 });
  add("rubble", 5.5, -19, 0.3, { seed: 53 });
  return out;
}

/** World position of a local plan point, for a compound centred at (cx, cz). */
export function toWorld(p, { x: cx, z: cz, rotY = 0 }) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return { x: cx + p.x * c + p.z * s, z: cz - p.x * s + p.z * c, rotY: p.rotY + rotY };
}

function geometryFor(p) {
  switch (p.kind) {
    case "tower": return buildTempleTower({ seed: p.seed });
    case "gallery": return buildTempleGallery({ seed: p.seed, length: p.length, collapse: p.collapse ?? 0.4 });
    case "gopura": return buildTempleGopura({ seed: p.seed });
    case "naga": return buildNagaBalustrade({ seed: p.seed, length: p.length });
    case "fig": return buildFigRoots({ seed: p.seed, width: p.width, height: p.height });
    case "rubble": return buildTempleRubble({ seed: p.seed });
    default: return null;
  }
}

/**
 * Stone stops bullets and stone stops feet, so everything standing here blocks
 * nav and gives cover. The fig does neither — you walk under roots — and
 * rubble is scramble-over, which the nav grid has no way to say, so it blocks
 * and gives cover like the wall it fell off.
 */
const PLACEMENT = {
  tower: { pad: true, clear: 12, apron: 1.4 },
  gallery: { pad: true, clear: 8 },
  gopura: { pad: true, clear: 9 },
  naga: { pad: false, nav: true, cover: true, clear: 4 },
  rubble: { pad: false, nav: true, cover: true, clear: 3.5 },
  fig: { pad: false, nav: false, cover: false, clear: 3 },
};

/** Place a temple compound centred on (x, z), through placedObjects. */
export async function placeTemple(app, placed, { x, z, rotY = 0 } = {}) {
  const mat = rtsObjectMaterial();
  const items = [];
  // The clearing the jungle has NOT quite taken back: open over the courtyard
  // and the causeway, closing in round the galleries.
  for (const [lx, lz, r] of [[0, 14, 22], [0, -8, 18], [0, 28, 14]]) {
    const p = toWorld({ x: lx, z: lz, rotY: 0 }, { x, z, rotY });
    app.clearVegetation?.(p.x, p.z, r, { grass: r * 0.8 });
  }
  for (const p of templePlan()) {
    const geo = geometryFor(p);
    if (!geo) continue;
    const w = toWorld(p, { x, z, rotY });
    items.push({
      obj: new THREE.Mesh(geo, mat), x: w.x, z: w.z, rotY: w.rotY,
      ...(PLACEMENT[p.kind] ?? {}),
    });
  }
  await placed.place(items);
  return items.length;
}
