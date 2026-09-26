// THE CRASH SITE — a Huey down in the jungle beside the road to Kurtz's
// temple (your ask 2026-09-23, done 2026-09-26). The approach tells the story
// before the temple does: you pass a wreck the jungle is already taking back.
//
// The wreck is the UH-1 model taken apart (rtsVehicles.buildHueyWreck): cabin
// on its side, boom snapped off, one blade bent over it, one thrown into the
// trees, scorch and debris. It lies on the ground as it fell (no levelling
// pad), blocks movement and gives cover like any wreck. The jungle is cleared
// round it — a gash where it came down — and the CANOPY keeps off it (the
// site is passed to canopyClearings), or the RTS camera would never see it.
// ?crash=0 boots without it.
import * as THREE from "three";
import { buildHueyWreck } from "../../v3/render/objects/rtsVehicles.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { scorchDecals } from "./temple.js";

const mapKey = (worldName) => String(worldName ?? "").replace(/\.v3proj$/i, "").replace(/^.*[\\/]/, "");

/**
 * nam-valley: 14 m east of the temple road, 45 m before the pond, on flat
 * ground in the forest (measured: 0.56 m of relief over 6 m). Lying at an
 * angle to the road, nose toward it.
 */
export const CRASH_SITES = {
  "nam-valley": [{ name: "the Huey", x: 380, z: 295, rotY: 2.2, clear: 13 }],
};

export function crashSitesFor(worldName) {
  if (new URLSearchParams(location.search).get("crash") === "0") return [];
  return CRASH_SITES[mapKey(worldName)] ?? [];
}

/** Place each crash site through placedObjects. Returns the number placed. */
export async function placeCrashSites(app, placed, sites) {
  const items = [];
  for (const s of sites) {
    const obj = new THREE.Mesh(buildHueyWreck({ seed: 5 }), rtsObjectMaterial());
    items.push({ obj, x: s.x, z: s.z, rotY: s.rotY, pad: false, nav: true, cover: true, clear: 0 });
    (app.plantKeepOut ??= []).push({ x0: s.x, z0: s.z, x1: s.x, z1: s.z, r: s.clear });   // no palm in the gash
  }
  if (items.length) await placed.place(items);
  // The burn under it: two overlapping scorches, the bigger under the engine end.
  await scorchDecals(app, sites.flatMap((s) => [{ x: s.x, z: s.z, size: 13 }, { x: s.x - Math.cos(s.rotY) * 4, z: s.z + Math.sin(s.rotY) * 4, size: 9 }]));
  return items.length;
}

/**
 * The gash it tore: jungle and grass gone round the wreck, a ragged edge.
 * Call AFTER the canopy, palm fringe and undergrowth are painted — they paint
 * over any earlier clearing (the banana plants grew back over it).
 */
export function clearCrashSites(app, sites) {
  // (grass out to 0.85 of it: at 0.55 metre-tall grass hid the scorch)
  for (const s of sites) app.clearVegetation?.(s.x, s.z, s.clear, { grass: s.clear * 0.85, edge: 4 });
}
