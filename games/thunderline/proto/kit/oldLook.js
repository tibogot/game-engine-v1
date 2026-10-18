// Draw a NEW piece (path × section × lean from kit.js) with the OLD game's look: its road sweep,
// kerbs, W-beam guardrail and instanced posts, and its materials. The old look is the floor the new
// game must beat, never something to trade for triangle counts (user, 2026-10-18).
import * as THREE from "three";
import { integrate, deckFrame, SECTIONS } from "./kit.js";
import "./oldTiles.js"; // registers the old kit's bowl and flip ramp as tiles
import { buildTubeLook } from "./tubeLook.js";
import { buildSweepGeometry, buildProfile, ROAD_PARAM_DEFAULTS, NO_CHECKER } from "../../../modular-road-v3/modularRoadKit.js";
import { buildRailGeometry, buildRailCollision } from "../../../modular-road-v3/modularRoadRail.js";
import { createRoadMaterial, createGuardrailMaterial } from "../../../modular-road-v3/modularRoadMaterial.js";

export function createOldLookMaterials() {
  const road = createRoadMaterial();
  // The deck casts its shadow from its UNDERSIDE only (back faces into the shadow map), so its top
  // can't shadow itself. Without this, under Sky Pro's lower sun the road self-shadowed into a dark
  // band across the near cascade even at normal bias 0.12 (user's screenshot, 2026-10-18; A/B:
  // decks not casting → band gone; back-face casting → band gone AND lower decks still shadowed).
  road.shadowSide = THREE.BackSide;
  // TUBES: the same road material in its tube mode (aZone 3 = bore, 4 = shell, lit rings in the bore),
  // in Thunderline's colours — graphite bore, light steel shell, bolt-blue rings — never the old red
  // (zones 3/4 fell through to the kerb colour on the plain road material)
  const tube = createRoadMaterial({
    tubeZones: true,
    tubeInner: 0x2a3242,
    tubeOuter: 0xc9d1dd,
    neonColor: 0x3fd2ff,
    neonIntensity: 2.4,
    neonSpacing: 8,
    neonWidth: 0.4,
  });
  tube.shadowSide = THREE.BackSide;
  return { road, tube, rail: createGuardrailMaterial() };
}

/** Old-kit frames ({pos, tangent, up, right}) along a new piece, every ≤2 m, no duplicate stations. */
export function oldFrames(tile) {
  const b = integrate(tile, { maxGap: 2 });
  const hw = SECTIONS[tile.section ?? "road"].hw;
  const frames = [];
  let lastS = -1;
  for (const r of b.rings) {
    if (r.s - lastS < 0.05) continue; // the mark-edge double rings would make zero-length segments
    lastS = r.s;
    const f = deckFrame(r, hw);
    frames.push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R });
  }
  return { b, frames };
}

/**
 * railCollision is what the CAR hits (two walls with depth, the shape the old car's contact is tuned
 * to); the visible rail and its posts are render-only, as in the old game.
 * @returns {{deck: THREE.BufferGeometry, rail: THREE.BufferGeometry|null, railCollision: THREE.BufferGeometry|null, posts: {template, matrices}|null}}
 */
export function buildOldLook(tile, edges = true) {
  if (tile.customLook) return tile.customLook(tile, edges); // the old kit's own pieces (oldTiles.js)
  if (tile.tube) {
    // a tube piece: the tube section, its closure eased along the piece (tubeLook.js); no rails
    const b = integrate(tile, { maxGap: 2 });
    const frames = [], sAt = [];
    let lastS = -1;
    for (const r of b.rings) {
      if (r.s - lastS < 0.05) continue;
      lastS = r.s;
      const f = deckFrame(r, SECTIONS.road.hw);
      frames.push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R });
      sAt.push(r.s);
    }
    return buildTubeLook(tile, frames, sAt, b.L, { buildSweepGeometry, NO_CHECKER, THREE });
  }
  const { frames } = oldFrames(tile);
  const rp = tile.section === "wide" ? { ...ROAD_PARAM_DEFAULTS, width: SECTIONS.wide.hw * 2 } : ROAD_PARAM_DEFAULTS;
  const deck = buildSweepGeometry(frames, buildProfile(rp, edges), {});
  // the road material reads aPiece = (noise phase, line distance); one phase per tile is enough here
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  if (!edges) return { deck, rail: null, railCollision: null, posts: null };
  const posts = { key: "", template: null, matrices: [] };
  const rail = buildRailGeometry(frames, rp, undefined, { postSink: posts });
  const railCollision = buildRailCollision(frames, rp);
  return { deck, rail, railCollision, posts };
}
