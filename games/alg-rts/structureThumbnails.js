// Structure portraits for THIS game's buildings — baked by the shared baker
// (games/shared-rts/thumbnails.js) into the units' thumbnail map, under
// thumbKeyOf's keys ("struct:<typeKey>"), as nam does its own
// (games/nam-rts/structureThumbnails.js). Each is built exactly as the game
// draws it: kitView (showroom.js), French paint, markings, gate shut.
import * as THREE from "three";
import { bakeThumbnails } from "../shared-rts/thumbnails.js";
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { buildHelipad, buildMotorPool } from "../../v3/render/objects/rtsAlgeria.js";
import { kitView } from "./showroom.js";

/**
 * The baker's camera looks from +Z (a unit's front); a kit building's front
 * is its −Z (it faces the player's camera in the game). Turned half round,
 * its front meets the portrait camera at three-quarters, as in the game.
 */
function facing(o) {
  const g = new THREE.Group();
  o.rotation.y = Math.PI;
  g.add(o);
  return g;
}

// `frame`: what the portrait frames. The post only its walls and towers —
// the radio mast (23 m) and the wire and chicane out to ±21 m would make
// the fort a speck in the middle.
const walls = (box) => {
  box.max.y = Math.min(box.max.y, 9);
  for (const k of ["x", "z"]) { box.min[k] = Math.max(box.min[k], -16); box.max[k] = Math.min(box.max[k], 16); }
};
const ITEMS = [
  ["struct:post", () => facing(kitView(buildFrenchPost({ detail: 2 }))), walls],
  ["struct:motorPool", () => facing(kitView(buildMotorPool({ detail: 2 })))],
  ["struct:helipad", () => facing(kitView(buildHelipad()))],
];

/** Bake every structure portrait into `into` (the units' thumbnail map). */
export async function bakeStructureThumbnails(renderer, into) {
  const made = [];
  const baked = await bakeThumbnails({
    renderer,
    // A slightly tighter fill than the units: buildings are wide and low.
    fill: 0.95,
    items: ITEMS.map(([key, make, frame]) => ({ key, frame, make: () => { const o = make(); made.push(o); return o; } })),
  });
  for (const [k, v] of baked) into.set(k, v);
  // Built for the portrait alone: free their geometry (the markings too).
  for (const o of made) o.traverse((m) => { if (m.isMesh) m.geometry.dispose(); });
  return baked.size;
}
