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
  buildFigRoots, buildHeadPikes, buildNagaBalustrade, buildRiverStair,
  buildTempleGallery, buildTempleGopura, buildTempleRubble, buildTempleTower,
} from "../../v3/render/objects/rtsTemple.js";

/** Kinds drawn as planted foliage (placedPlants.js via `app.plant`), not kit. */
const PLANTED_KINDS = new Set(["travellersPalm", "banyan"]);

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
  // THE LANDING STAIRS, at the far end of the causeway on the axis.
  //
  // The compound STAYS WHERE IT IS (your call, 2026-09-23) and the river comes
  // to it when the river branches are done. The flight simply goes down, so
  // wherever the water ends up in the last stretch of its drop, it laps stone.
  // Until then it reads as a ghat on a dry bank, which is what a ruin on a
  // shifted channel looks like anyway.
  add("stair", 0, -26, Math.PI, { seed: 61, steps: 14, rise: 0.32, tread: 0.66 });
  // Heads on pikes, in two groups along the approach: the first where the
  // causeway starts, so you meet them before the gate, and the second at the
  // stair head where anyone coming off the water walks into them.
  add("pikes", -4.6, -17, Math.PI / 2 + 0.06, { seed: 71, count: 5, spacing: 1.5, height: 2.0 });
  add("pikes", 4.6, -17, Math.PI / 2 - 0.05, { seed: 83, count: 5, spacing: 1.5, height: 2.0 });
  add("pikes", -4.6, -25, Math.PI / 2 + 0.1, { seed: 97, count: 4, spacing: 1.5, height: 1.9 });
  add("pikes", 4.6, -25, Math.PI / 2 - 0.08, { seed: 101, count: 4, spacing: 1.5, height: 1.9 });
  // Rubble: off the gate's flanks, in the courtyard, and out along the way in.
  add("rubble", -8.5, -4, 0.5, { seed: 13 });
  add("rubble", 9, -2, 1.2, { seed: 31 });
  add("rubble", -6, 20, 2.1, { seed: 47 });
  add("rubble", 5.5, -19, 0.3, { seed: 53 });
  // A pair of TRAVELLER'S PALMS either side of the approach, framing the gate
  // (fans face the camera — see placeTemple). Somebody planted
  // these, long after the Khmer — Kurtz's people, or the French before them.
  add("travellersPalm", -9.5, -9, 0.06, { seed: 0.33, scale: 1.05 });
  add("travellersPalm", 9.5, -9.5, -0.05, { seed: 0.71, scale: 0.92 });
  return out;
}

/**
 * A BANYAN on the temple's outskirts, off the west gallery — not over
 * the landing stair, where its ~36 m crown hid the gate, the pikes and the
 * ghat from the RTS camera (your call, 2026-09-24: keep it clear). The
 * west gallery is ~15 m outside its crown, and it is off the approach path
 * (at -42, -36 its trunk stood on it). Local metres, same frame as the
 * plan; not in `templePlan`, which is the compound itself.
 */
export const TEMPLE_OUTSKIRTS = [
  { kind: "banyan", x: -46, z: 10, rotY: 0, seed: 0.47, scale: 0.9 },
];

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
    case "stair": return buildRiverStair({ seed: p.seed, steps: p.steps, rise: p.rise, tread: p.tread });
    case "pikes": return buildHeadPikes({ seed: p.seed, count: p.count, spacing: p.spacing, height: p.height });
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
  // NO PAD. A pad levels the ground to ONE height, which buries every step of
  // a descending flight — the first version read as a flat paved ramp for
  // exactly this reason. The bank is cut with `gradeRamp` instead, below.
  stair: { pad: false, nav: false, cover: false, clear: 9 },
  // Pikes are scenery: thin enough to walk between, no cover, no nav.
  pikes: { pad: false, nav: false, cover: false, clear: 2 },
};

/** Place a temple compound centred on (x, z), through placedObjects. */
export async function placeTemple(app, placed, { x, z, rotY = 0 } = {}) {
  const mat = rtsObjectMaterial();
  const items = [];
  // The clearing the jungle has NOT quite taken back: open over the courtyard
  // and the causeway, closing in round the galleries.
  for (const [lx, lz, r] of [[0, 14, 22], [0, -8, 18], [0, 28, 14], [0, -26, 16]]) {
    const p = toWorld({ x: lx, z: lz, rotY: 0 }, { x, z, rotY });
    app.clearVegetation?.(p.x, p.z, r, { grass: r * 0.8 });
  }
  // CUT THE BANK the stair runs down, before placing anything on it: a ramp
  // from the stair head at ground level to its foot one flight lower. The
  // river is not here yet (it is coming to the temple rather than the temple
  // going to it), so the ground has to provide the fall for now.
  const flight = templePlan().find((q) => q.kind === "stair");
  if (flight && app.gradeRamp) {
    const drop = flight.steps * flight.rise;
    const head = toWorld({ x: flight.x, z: flight.z, rotY: 0 }, { x, z, rotY });
    const foot = toWorld({ x: flight.x, z: flight.z - flight.steps * flight.tread - 3, rotY: 0 }, { x, z, rotY });
    const hy = app.getWorldHeight?.(head.x, head.z) ?? 0;
    await app.gradeRamp(
      { x: head.x, z: head.z, y: hy },
      { x: foot.x, z: foot.z, y: hy - drop },
      { halfWidth: 7.5, shoulder: 9 },
    );
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
  // Planted plants after the pads, so each stands on the final ground.
  let plants = 0;
  for (const p of [...templePlan(), ...TEMPLE_OUTSKIRTS]) {
    if (!PLANTED_KINDS.has(p.kind) || !app.plant) continue;
    const w = toWorld(p, { x, z, rotY });
    // The fan faces the DEFAULT camera (looking +Z), whatever way the site is
    // turned: an ornamental is there to be seen, and edge-on it is a pole.
    app.plant(p.kind, w.x, w.z, { rotY: p.rotY, scale: p.scale, seed: p.seed });
    plants++;
  }
  return items.length + plants;
}
