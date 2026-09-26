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
  buildFigRoots, buildHeadPikes, buildNagaBalustrade, buildRiverStair, buildSkullMidden,
  buildTempleGallery, buildTempleGopura, buildTempleHearth, buildTempleLeanTo, buildTempleRubble,
  buildTempleTotem, buildTempleTower,
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
  add("pikes", -4.6, -17, Math.PI / 2 + 0.06, { seed: 71, count: 5, spacing: 1.5, height: 1.7 });
  add("pikes", 4.6, -17, Math.PI / 2 - 0.05, { seed: 83, count: 5, spacing: 1.5, height: 1.7 });
  add("pikes", -4.6, -25, Math.PI / 2 + 0.1, { seed: 97, count: 4, spacing: 1.5, height: 1.6 });
  add("pikes", 4.6, -25, Math.PI / 2 - 0.08, { seed: 101, count: 4, spacing: 1.5, height: 1.6 });
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

  // THE PEOPLE WHO LIVE IN IT (2026-09-26): lean-tos built against the
  // galleries' outer walls — two on the back gallery, which faces the camera,
  // one on the west — each with its hearth; the skull midden at the tower's
  // foot; totems on the paths in, so the boundary is felt before the temple
  // is seen. Hearths also light a thread of smoke and scorch the ground.
  add("leanTo", -8, 28.8, 0.04, { seed: 301, width: 4.4 });
  add("leanTo", 9, 28.9, -0.05, { seed: 303, width: 3.8 });
  add("leanTo", -15.8, 5.5, -Math.PI / 2 + 0.05, { seed: 307, width: 4.0 });
  add("hearth", -8.5, 33.2, 0, { seed: 311 });
  add("hearth", 9.5, 33.4, 0, { seed: 313 });
  add("hearth", -20.2, 6, 0, { seed: 317 });
  add("midden", -5.2, 6.2, 0.4, { seed: 321 });
  add("totem", -18.5, -4.5, 0.2, { seed: 331, height: 3.2 });
  add("totem", 18.5, -4, -0.3, { seed: 333, height: 2.9 });
  add("totem", -19.5, 31, 0.5, { seed: 337, height: 3.4 });
  add("totem", 19.5, 31.5, -0.4, { seed: 339, height: 3.0 });
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
    case "leanTo": return buildTempleLeanTo({ seed: p.seed, width: p.width });
    case "hearth": return buildTempleHearth({ seed: p.seed });
    case "midden": return buildSkullMidden({ seed: p.seed });
    case "totem": return buildTempleTotem({ seed: p.seed, height: p.height });
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
  leanTo: { pad: true, nav: true, cover: false, clear: 3.5 },
  hearth: { pad: false, nav: false, cover: false, clear: 2.5 },
  midden: { pad: false, nav: true, cover: false, clear: 2.5 },
  totem: { pad: false, nav: false, cover: false, clear: 1.5 },
};

/**
 * THE WATCHERS — the strongest image in the film: people standing motionless,
 * watching the boat come in. World { x, y, z, yaw } for the unit renderer's
 * static figures: on the ghat steps facing the water, lining the causeway
 * between the pikes facing it, a few by the midden and the lean-tos.
 */
export function templeWatchers(app, { x, z, rotY = 0 }) {
  const out = [];
  const flight = templePlan().find((q) => q.kind === "stair");
  const put = (lx, lz, faceX, faceZ, lift = 0) => {
    const w = toWorld({ x: lx, z: lz, rotY: 0 }, { x, z, rotY });
    const f = toWorld({ x: lx + faceX, z: lz + faceZ, rotY: 0 }, { x, z, rotY });
    out.push({ x: w.x, y: app.getWorldHeight(w.x, w.z) + lift, z: w.z, yaw: Math.atan2(f.x - w.x, f.z - w.z) });
  };
  let s = 7;
  const jit = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  // On the steps, looking down at the water (local -Z), a few each side.
  if (flight) for (const k of [2, 4, 6, 8, 10]) for (const sx of [-1, 1]) {
    if ((k + sx) % 3 === 0) continue;
    put(sx * (2.2 + jit() * 1.6), flight.z - k * flight.tread - 0.3, jit() * 0.3, -1, 0.15);
  }
  // Lining the causeway, facing it.
  for (const lz of [-7, -10, -13, -20, -23]) for (const sx of [-1, 1]) put(sx * (6.6 + jit() * 0.8), lz + jit(), -sx, jit() * 0.4);
  // By the midden, and by the lean-tos on the back gallery.
  put(-6.8, 4.2, 0.6, 1); put(-3.4, 4.0, -0.4, 1);
  put(-9.5, 32, 0.2, 1); put(8, 32.4, 0.3, 1);
  return out;
}

/** Scorch decals (the photo scorch art) at each { x, z, size }. Exported for the crash site. */
export async function scorchDecals(app, spots) {
  const decals = app.decals;
  if (!decals || !spots.length) return 0;
  let slot = decals.textures?.slots?.findIndex((s) => s.name.startsWith("scorch")) ?? -1;
  if (slot < 0) {
    await decals.addSlot({ name: "scorch (photo)", albedoUrl: "/textures/decals/nam/scorch_1.webp", normalUrl: "/textures/decals/nam/scorch_1_n.webp" });
    slot = decals.textures.slots.length - 1;
  }
  for (const s of spots) {
    const a = (s.x * 12.9898 + s.z * 78.233) % 6.283;
    decals.add({
      px: s.x, py: app.getWorldHeight(s.x, s.z), pz: s.z,
      qx: 0, qy: Math.sin(a / 2), qz: 0, qw: Math.cos(a / 2),
      slot, sx: s.size, sy: 3, sz: s.size, opacity: 0.9, roughness: 0.95, normalStrength: 1, angleFade: 55, edgeFade: 0.05, priority: 0,
    });
  }
  return spots.length;
}

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
    // The ramp must reach the flight's FOOT at the flight's full drop. It was
    // aimed 3 m past the foot, so at the last step the ground had fallen only
    // 3.3 of the flight's 4.5 m: the lower steps were buried and the stair read
    // as a flat stone band (measured 2026-09-26). Now ONE ramp on the flight's
    // own slope (a little under the treads), carried 6 m on past the foot into
    // the bank where the water will come. (Not a second ramp from the foot:
    // gradeRamp flattens a round cap at each end, and a cap at the foot
    // would lay the lower flight's ground flat under its steps.)
    const drop = flight.steps * flight.rise + 0.15, run = flight.steps * flight.tread;
    const head = toWorld({ x: flight.x, z: flight.z, rotY: 0 }, { x, z, rotY });
    const end = toWorld({ x: flight.x, z: flight.z - run - 3, rotY: 0 }, { x, z, rotY });
    const hy = app.getWorldHeight?.(head.x, head.z) ?? 0;
    // Wide shoulders: the cut is a pond's basin with banks, not a pit with
    // rock walls (at 9 m the sides went steep enough to paint as cliff).
    // (3 m past the foot, not 6, and 22 m shoulders: the deeper, shorter cut
    // left a back wall steep enough to paint as a rock quarry face.)
    await app.gradeRamp({ x: head.x, z: head.z, y: hy }, { x: end.x, z: end.z, y: hy - drop * (run + 3) / run }, { halfWidth: 9, shoulder: 22 });
    // THE TEMPLE POND (2026-09-26). A ghat going down into nothing read as a
    // hole in the ground; the stairs have to go down into WATER — that is the
    // image. Khmer temples stand on their reservoirs (the srah), so a pond at
    // the foot of the landing is the place's own, not a stand-in for the river.
    // Level: 1.2 m over the foot, so the lowest steps are under. The lake is
    // depth-buffer water (shows only where the ground is below it): the
    // rectangle is fitted to the MEASURED basin, which nothing outside of
    // reaches down to. ?templepond=0 = without.
    const foot = toWorld({ x: flight.x, z: flight.z - run, rotY: 0 }, { x, z, rotY });
    // No plant on the flight or the approach to it (placedPlants keep-out).
    (app.plantKeepOut ??= []).push({ x0: head.x, z0: head.z, x1: end.x, z1: end.z, r: 9 });
    const level = app.getWorldHeight(foot.x, foot.z) + 1.2;
    if (app.lakeSystem?.addLake && new URLSearchParams(location.search).get("templepond") !== "0") {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let dz = -40; dz <= 40; dz += 2) for (let dx = -40; dx <= 40; dx += 2) {
        const wx = foot.x + dx, wz = foot.z + dz;
        if (app.getWorldHeight(wx, wz) >= level) continue;
        x0 = Math.min(x0, wx); x1 = Math.max(x1, wx); z0 = Math.min(z0, wz); z1 = Math.max(z1, wz);
      }
      if (x1 > x0) {
        app.templePond = app.lakeSystem.addLake({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, sizeX: x1 - x0 + 6, sizeZ: z1 - z0 + 6, level });
        app.lakeSystem.setEditActive?.(false);
        // MURKY jungle water (your note: "a bit too transparent"): the lake's
        // defaults are a clear lake — full absorption over 20 m, and this pond is
        // ~1.5 m deep, so you saw its bed. Opaque within 2.5 m, olive-brown.
        // (One material serves every lake; nam-valley has no other.)
        const w = app.lakeSystem.toolState?.lake?.water;
        if (w) {
          Object.assign(w, { depthDistance: 2.5, absorptionScale: 24, absorptionR: 0.42, absorptionG: 0.2, absorptionB: 0.3, inscatterTint: "#2c2f14", inscatterStrength: 0.95 });
          app.lakeSystem.syncMaterial?.();
        }
      }
    }
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
  // The hearths burn: a thread of smoke each (kept — never recycled by the
  // combat smoke) and a scorch on the ground round it.
  // No planted palm on the tribe's things (a sugar palm stood on a lean-to).
  for (const q of templePlan()) {
    if (!["leanTo", "hearth", "midden", "totem"].includes(q.kind)) continue;
    const w = toWorld(q, { x, z, rotY });
    (app.plantKeepOut ??= []).push({ x0: w.x, z0: w.z, x1: w.x, z1: w.z, r: q.kind === "leanTo" ? 7 : 4 });
  }
  const hearths = templePlan().filter((q) => q.kind === "hearth").map((q) => toWorld(q, { x, z, rotY }));
  for (const h of hearths) app.smoke?.spawn({ x: h.x, z: h.z, kind: "hearth", keep: true, strength: 0.8 });
  await scorchDecals(app, hearths.map((h) => ({ ...h, size: 3.6 })));
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
