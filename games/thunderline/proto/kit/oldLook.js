// Draw a NEW piece (path × section × lean from kit.js) with the OLD game's look: its road sweep,
// kerbs, W-beam guardrail and instanced posts, and its materials. The old look is the floor the new
// game must beat, never something to trade for triangle counts (user, 2026-10-18).
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { integrate, deckFrame, SECTIONS } from "./kit.js";
import "./oldTiles.js"; // registers the old kit's bowl and flip ramp as tiles
import { buildTubeLook, buildHalfpipeLook } from "./tubeLook.js";
import { buildSweepGeometry, buildProfile, ROAD_PARAM_DEFAULTS, NO_CHECKER } from "../../../modular-road-v3/modularRoadKit.js";
import { buildRailGeometry, buildRailCollision, railParams } from "../../../modular-road-v3/modularRoadRail.js";
// HALF THE POSTS (user, 2026-10-21: "they are too close from each other"): 7.2 m apart, not the old game's 3.6
const RAIL = { ...railParams, postSpacing: 7.2 };
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
    tubeInner: 0x161c28, // dark bore: the lit rings carry it
    tubeOuter: 0x1f56c9, // a deep Thunderline blue shell (a strong colour reads as an object — the
    //                      Apex Rush reference; ours, not their orange)
    neonColor: 0x3fd2ff,
    neonIntensity: 2.4,
    neonSpacing: 8,
    neonWidth: 0.4,
  });
  tube.shadowSide = THREE.BackSide;
  // the tubes' white trim: rims at the ends and joints, seams along the shell
  const trim = new THREE.MeshStandardNodeMaterial({ color: 0xf1f4f9, roughness: 0.32, metalness: 0.05 });
  // STUNT STRIPES (stripedUnder below): flat bands, vertex coloured
  const stripe = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
  // THE RAIL, SATIN (user, 2026-10-20: the left rail "fades a few metres ahead"): not a shadow — with the
  // shadows off it did the same. The old rail is half metal at roughness 0.2, a mirror: its face turned
  // away from the sun showed only reflections, dark blue under the car and bright at a grazing angle
  // further on. Satin (0.5 / 0.25) is one even sky-lit tone along its length. The old game keeps its own.
  return { road, tube, trim, rail: createGuardrailMaterial({ roughness: 0.5, metalness: 0.25 }), stripe };
}

/**
 * STUNT PIECES WEAR STRIPES (user's Apex Rush top view, 2026-10-20: every stunt piece has a striped
 * underside, so from anywhere you read "this is a stunt"). Bands under the slab and along both its sides,
 * in Thunderline's colours (navy, bolt blue, white, signal orange — never their orange-black livery),
 * following the deck through every roll. Only these pieces (and their _L):
 */
export const STRIPED = new Set(["twist_120", "half_loop_28", "loop_28", "wallride_90", "uturn_wall_32"]);
const NAVY = [0.06, 0.09, 0.2], BOLT = [0.25, 0.82, 1.0], WHITE = [0.93, 0.95, 0.98], SIGNAL = [1.0, 0.48, 0.1];
// across the underside (x from −1 to 1 of the slab's half width) and down each side (0 top … 1 bottom)
const UNDER_BANDS = [[-1, -0.62, NAVY], [-0.62, -0.38, BOLT], [-0.38, -0.2, WHITE], [-0.2, 0.2, SIGNAL], [0.2, 0.38, WHITE], [0.38, 0.62, BOLT], [0.62, 1, NAVY]];
const SIDE_BANDS = [[0, 0.34, BOLT], [0.34, 0.6, WHITE], [0.6, 1, SIGNAL]];
function stripedUnder(frames, hw, slab) {
  const pos = [], col = [], idx = [];
  const strip = (at, color) => { // at(frame, t) → point; t = 0 / 1 across the band
    const base = pos.length / 3;
    for (const f of frames) for (const t of [0, 1]) { pos.push(...at(f, t).toArray()); col.push(...color); }
    for (let i = 0; i < frames.length - 1; i++) { const k = base + i * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
  };
  const under = -slab - 0.03, w = hw + 0.02;
  for (const [a, b, c] of UNDER_BANDS) strip((f, t) => f.pos.clone().addScaledVector(f.right, w * (t ? b : a)).addScaledVector(f.up, under), c);
  for (const s of [-1, 1]) for (const [a, b, c] of SIDE_BANDS) strip((f, t) => f.pos.clone().addScaledVector(f.right, s * (hw + 0.04)).addScaledVector(f.up, -slab * (t ? b : a)), c);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
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
    frames.push({ pos: f.P, tangent: r.T.clone(), up: f.U, right: f.R, air: !!r.air });
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
  if (tile.tube || tile.halfpipe) {
    // a tube piece: the tube section, its closure eased along the piece (tubeLook.js); no rails.
    // A half-pipe: the open U, its walls grown along the piece (same frames, same trim)
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
    return (tile.halfpipe ? buildHalfpipeLook : buildTubeLook)(tile, frames, sAt, b.L, { buildSweepGeometry, NO_CHECKER, THREE });
  }
  const { frames: all } = oldFrames(tile);
  const rp = tile.section === "wide" ? { ...ROAD_PARAM_DEFAULTS, width: SECTIONS.wide.hw * 2 } : ROAD_PARAM_DEFAULTS;
  // RUNS of road: a gap's air frames cut the piece in two (gap jumps); one run for the others
  const runs = [[]];
  for (const f of all) { if (f.air) { if (runs.at(-1).length) runs.push([]); } else runs.at(-1).push(f); }
  const parts = runs.filter((r) => r.length >= 2);
  const merge = (gs) => (gs.length === 1 ? gs[0] : mergeGeometries(gs));
  const deck = merge(parts.map((r) => buildSweepGeometry(r, buildProfile(rp, edges), {})));
  // the road material reads aPiece = (noise phase, line distance); one phase per tile is enough here
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  const under = STRIPED.has(String(tile.id ?? "").replace(/_L$/, "")) ? merge(parts.map((r) => stripedUnder(r, rp.width / 2, rp.thickness ?? 0.9))) : null;
  if (!edges) return { deck, rail: null, railCollision: null, posts: null, under };
  const posts = { key: "", template: null, matrices: [] };
  const rail = merge(parts.map((r) => buildRailGeometry(r, rp, RAIL, { postSink: posts })));
  const railCollision = merge(parts.map((r) => buildRailCollision(r, rp)));
  return { deck, rail, railCollision, posts, under };
}
