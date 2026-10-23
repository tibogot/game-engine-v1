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
import { createRoadMaterial, createGuardrailMaterial, createRoadGlassMaterial } from "../../../modular-road-v3/modularRoadMaterial.js";
import { createTubeMaterial } from "./tubeMaterial.js";
import { buildWornSurface, createScanDeck, ROAD_WEAR, ROAD_SCAN } from "./roadSurface.js";

export function createOldLookMaterials() {
  // our own asphalt (roadSurface.js): a scanned deck under thin worn lines, not the old game's 14× stretched bands
  // ?asphalt=<scan> picks another (roadSurface.js ROAD_SCANS); ?asphalt=old = the old game's road, for an A/B
  const pick = new URLSearchParams(globalThis.location?.search ?? "").get("asphalt") ?? "tarred_gravel";
  const scan = pick === "old" ? null : createScanDeck(pick);
  const road = scan ? createRoadMaterial({ buildSurface: buildWornSurface, deck: scan.hook }) : createRoadMaterial();
  if (typeof window !== "undefined") Object.assign(window, { __roadWear: ROAD_WEAR, __roadScan: ROAD_SCAN, __roadScanUse: scan?.use });
  // The deck casts its shadow from its UNDERSIDE only (back faces into the shadow map), so its top
  // can't shadow itself. Without this, under Sky Pro's lower sun the road self-shadowed into a dark
  // band across the near cascade even at normal bias 0.12 (user's screenshot, 2026-10-18; A/B:
  // decks not casting → band gone; back-face casting → band gone AND lower decks still shadowed).
  road.shadowSide = THREE.BackSide;
  // TUBES: Thunderline's own pipe (tubeMaterial.js, 2026-10-22) — graphite panels, thin light rings every
  // 16 m, a floor band with chevrons, the deep blue shell. (Was the road material's tube mode: rings every
  // 8 m whose bloom flooded the bore pale cyan — "the same as my old game with those lines".)
  const tube = createTubeMaterial();
  tube.shadowSide = THREE.BackSide;
  // the tubes' white trim: rims at the ends and joints, seams along the shell
  const trim = new THREE.MeshStandardNodeMaterial({ color: 0xf1f4f9, roughness: 0.32, metalness: 0.05 });
  // STUNT STRIPES (stripedUnder below): flat bands, vertex coloured
  const stripe = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1, side: THREE.DoubleSide });
  // THE RAIL, SATIN (user, 2026-10-20: the left rail "fades a few metres ahead"): not a shadow — with the
  // shadows off it did the same. The old rail is half metal at roughness 0.2, a mirror: its face turned
  // away from the sun showed only reflections, dark blue under the car and bright at a grazing angle
  // further on. Satin (0.5 / 0.25) is one even sky-lit tone along its length. The old game keeps its own.
  // the GLASS road's pane (buildGlassLook): the old game's real glass, double-sided — you see it from under the track too
  return { road, tube, trim, rail: createGuardrailMaterial({ roughness: 0.5, metalness: 0.25 }), stripe, glass: createRoadGlassMaterial() };
}

/**
 * STUNT PIECES WEAR STRIPES (user's Apex Rush top view, 2026-10-20: every stunt piece has a striped
 * underside, so from anywhere you read "this is a stunt"). Bands under the slab and along both its sides,
 * in Thunderline's colours (navy, bolt blue, white, signal orange — never their orange-black livery),
 * following the deck through every roll. Only these pieces (and their _L):
 */
export const STRIPED = new Set(["twist_120", "half_loop_28", "loop_28", "wallride_90", "wall_wide_90", "uturn_wall_32"]);
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
 * RAILS PER SIDE (user, 2026-10-21, Apex Rush: pieces with a guardrail on ONE side, or none, laid side by
 * side make wide roads and jump areas). `edges` everywhere in this file: true = both rails (guarded),
 * false = none (open), "L" / "R" = that side only. The other side has no kerb either: its deck edge is
 * flush, so a neighbour laid against it joins without a lip.
 */
export const railSides = (edges) => (edges === "L" ? [-1] : edges === "R" ? [1] : edges ? [-1, 1] : []);
/** A placed piece's edges: { open, rail } → true / false / "L" / "R" (old tracks: open only). */
export const edgesOf = (p) => (p.open ? false : p.rail === "L" || p.rail === "R" ? p.rail : true);
/** The look-cache key for those edges. */
export const lookKey = (edges) => (edges === true ? "guarded" : edges === false ? "open" : `rail${edges}`);
/** The road cross-section with a kerb on each side in `sides` (−1 left, +1 right) and a flush edge elsewhere. */
function sideProfile(rp, sides) {
  const both = buildProfile(rp, true), none = buildProfile(rp, false);
  if (sides.length === 2) return both;
  if (!sides.length) return none;
  const hw = rp.width / 2;
  const rw = Math.min(Math.max(0, rp.railWidth), hw * 0.45), rh = Math.max(0, rp.railHeight);
  const t = Math.max(0.05, rp.thickness), N = 24;
  const left = sides.includes(-1), xl = left ? -hw + rw : -hw, xr = left ? hw : hw - rw;
  const pts = [];
  if (left) pts.push({ x: -hw, y: rh, zone: 2 }, { x: -hw + rw, y: rh, zone: 2 });
  for (let k = 0; k <= N; k++) pts.push({ x: xl + ((xr - xl) * k) / N, y: 0, zone: 1, smooth: k > 0 && k < N });
  if (!left) pts.push({ x: hw - rw, y: rh, zone: 2 }, { x: hw, y: rh, zone: 2 });
  for (let k = N; k >= 0; k--) pts.push({ x: -hw + (2 * hw * k) / N, y: -t, zone: 0, smooth: k > 0 && k < N });
  return { pts, hw };
}

/**
 * A FUNNEL / FLARE (`tile.taper: { from, to }`, half widths in m — user, 2026-10-21: large platforms to
 * land on need a way back to the road): the deck narrows (or widens) smoothly along the piece, kerbs at
 * its edges; each side's rail is built from frames SHIFTED out to the edge at that point (the rail
 * builder keeps a fixed offset), so the rails converge and guide the car in — their collision too.
 */
function buildTaperLook(tile, edges) {
  const { frames } = oldFrames(tile);
  const { from, to, shape, side: sd = 1, hw = 24 } = tile.taper;
  // arc length along the frames → each edge's offset across: the deck is centred between them (cAt) and
  // `hwAt` wide each side. A funnel / flare: both edges, eased (smoothstep: no kink at either end). A
  // SHAPE (platform wedges and ends): one edge fixed, the other cutting across — straight (wedge), a
  // quarter circle (cwedge) — or both closing on a half circle (cap); never under 0.3 m (a point)
  const sAt = [0];
  for (let i = 1; i < frames.length; i++) sAt.push(sAt[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos));
  const L = sAt.at(-1) || 1;
  const edgesAt = (i) => {
    const t = Math.min(1, sAt[i] / L);
    if (shape === "cap") return [-hw * Math.sqrt(1 - t * t), hw * Math.sqrt(1 - t * t)];
    if (shape === "wedge" || shape === "cwedge") {
      const fixed = -sd * hw, moving = shape === "wedge" ? sd * hw * (1 - 2 * t) : -sd * hw + sd * 2 * hw * Math.sqrt(1 - t * t);
      return [Math.min(fixed, moving), Math.max(fixed, moving)];
    }
    const e = t * t * (3 - 2 * t), h = from + (to - from) * e;
    return [-h, h];
  };
  const hwAt = (i) => { const [a, b] = edgesAt(i); return Math.max(0.3, (b - a) / 2); };
  const cAt = (i) => { const [a, b] = edgesAt(i); return (a + b) / 2; };
  if (shape) frames.forEach((f, i) => f.pos.addScaledVector(f.right, cAt(i)));
  let narrow = Infinity;
  for (let i = 0; i < frames.length; i++) narrow = Math.min(narrow, hwAt(i));
  const sides = railSides(edges);
  const deck = buildSweepGeometry(frames, sideProfile({ ...ROAD_PARAM_DEFAULTS, width: 2 * hwAt(0) }, sides), {
    profileAt: (_t, i) => sideProfile({ ...ROAD_PARAM_DEFAULTS, width: 2 * hwAt(i) }, sides),
  });
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  const sig = sides.join(), iN = frames.length - 1;
  const tEnd = (i, s) => {
    const hwE = hwAt(i);
    if (hwE < 1) return null; // a wedge's point, a round end
    return endOf(frames[i], s, hwE, sig, capGeometry(deck, frames[i], sideProfile({ ...ROAD_PARAM_DEFAULTS, width: 2 * hwE }, sides).pts, s));
  };
  const ends = [tEnd(0, -1), tEnd(iN, 1)].filter(Boolean);
  if (!edges) return { deck, rail: null, railCollision: null, posts: null, under: null, ends };
  // each side: the frames moved sideways by (half width here − the narrow half width), tangents along
  // the moved edge (a converging rail faces along ITS line, not the road's centre line)
  const rp = { ...ROAD_PARAM_DEFAULTS, width: 2 * narrow };
  const sideFrames = (side) => {
    const moved = frames.map((f, i) => ({ ...f, pos: f.pos.clone().addScaledVector(f.right, side * (hwAt(i) - narrow)) }));
    moved.forEach((f, i) => {
      const p = moved[Math.max(0, i - 1)].pos, q = moved[Math.min(moved.length - 1, i + 1)].pos;
      const T = q.clone().sub(p).normalize();
      f.tangent = T;
      f.right = T.clone().cross(f.up).normalize().multiplyScalar(f.right.dot(T.clone().cross(f.up)) >= 0 ? 1 : -1);
    });
    return moved;
  };
  const posts = { key: "", template: null, matrices: [] };
  const rails = [], cols = [];
  for (const side of sides) {
    const fr = sideFrames(side);
    rails.push(buildRailGeometry(fr, rp, RAIL, { postSink: posts, sides: [side] }));
    cols.push(buildRailCollision(fr, rp, RAIL, { sides: [side] }));
  }
  const merge = (gs) => mergeGeometries(gs.filter(Boolean));
  return { deck, rail: merge(rails), railCollision: merge(cols), posts, under: null, ends };
}

// ---------- END CAPS (user, 2026-10-23: "we need caps on the road side … check my old game: it recognises when
// two pieces go together and removes the caps, if one piece is alone it places a cap") ----------
// The slab is a hollow prism (deck, sides, underside) with no end faces: an open end showed its inside.
// Every piece's look carries its two END LIDS (built once, in the piece's frame, with the deck's own
// attributes so they merge into the same draws) and `ends` (where each end is, which way it faces, how wide,
// which rails): testTrack.buildTrackMeshes lids the ends no other piece covers. Visual only — the wheels
// still leave a lip off the open sweep. Painted as the slab's side (zone 0), as the old game's lids.
// Ear-clipped, as the old kit's appendRoadEndCaps (a banked U is not star-shaped: a fan sprays holes).
function capGeometry(deck, f, pts, outSign) {
  let contour = pts.map((p) => new THREE.Vector2(p.x, p.y)), ring = pts;
  if (THREE.ShapeUtils.isClockWise(contour)) { contour = contour.slice().reverse(); ring = pts.slice().reverse(); }
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  if (!tris.length) return null;
  const n = ring.length, out = f.tangent.clone().multiplyScalar(outSign).normalize();
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(deck.attributes)) {
    const a = new Float32Array(n * attr.itemSize);
    if (name === "aPiece") for (let i = 0; i < n; i++) a[i * 2 + 1] = NO_CHECKER;
    g.setAttribute(name, new THREE.Float32BufferAttribute(a, attr.itemSize));
  }
  const pos = g.getAttribute("position"), nrm = g.getAttribute("normal"), p = new THREE.Vector3();
  ring.forEach((q, i) => {
    p.copy(f.pos).addScaledVector(f.right, q.x).addScaledVector(f.up, q.y);
    pos.setXYZ(i, p.x, p.y, p.z);
    nrm?.setXYZ(i, out.x, out.y, out.z);
  });
  const idx = [];
  // entry faces back, exit forward: the winding follows (as the old kit's emitCap)
  for (const [a, b, c] of tris) outSign < 0 ? idx.push(a, b, c) : idx.push(a, c, b);
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
/** One end: where it is, the way it faces (outward), its up and right, half width, rails ("*": covers any). */
const endOf = (f, outSign, hw, sig, geo) => ({ pos: f.pos.clone(), out: f.tangent.clone().multiplyScalar(outSign).normalize(), up: f.up.clone(), right: f.right.clone(), hw, sig, geo });
/** A piece with its own look (tubes, half-pipes, the old kit's pieces): ends that COVER a road's, no lid. */
function coverEnds(tile) {
  const b = integrate(tile, { maxGap: 2 });
  const hw = SECTIONS[tile.section ?? "road"].hw;
  const ring = (r, s) => { const f = deckFrame(r, hw); return endOf({ pos: f.P, tangent: r.T, up: f.U, right: f.R }, s, hw, "*", null); };
  return b.rings.length > 1 ? [ring(b.rings[0], -1), ring(b.rings.at(-1), 1)] : [];
}

/**
 * THE GLASS ROAD (user, 2026-10-23: "a straight piece with the glass material, cool because we can see
 * under" — then: "not the road that uses full glass, see the Apex Rush screenshot, or my old game's glass
 * piece"). Our asphalt road, kerbs and rails as any straight, with a long WINDOW in its middle (Apex Rush
 * shot 10: a pool framed in white): a pane of the old game's real glass (createRoadGlassMaterial, the
 * transmission path: it keeps its reflections) bedded a little under the deck and oversize so its edges
 * tuck under it (the old kit's buildGlassPaneGeometry: nothing coplanar), a white frame round it.
 * The WHEELS drive the unbroken deck (`deck`, collision and the end lids only); what is DRAWN is `drawn`
 * (the deck with the window cut, its reveal faces), `glass` and `trimFrame` (testTrack, builder meshesFor).
 * A straight only: the window is cut in the piece's own frame.
 */
const WINDOW = { L: 24, hw: 5, recess: 0.025, thick: 0.18, flange: 0.15, rim: 0.35, rimH: 0.04 };
function buildGlassLook(tile, edges) {
  const { frames } = oldFrames(tile);
  const rp = ROAD_PARAM_DEFAULTS, hw = rp.width / 2, sides = railSides(edges), t = Math.max(0.05, rp.thickness);
  const prof = sideProfile(rp, sides);
  const stamp = (g) => {
    const n = g.getAttribute("position").count, a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
    g.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
    return g;
  };
  const deck = stamp(buildSweepGeometry(frames, prof, {}));
  // the window: centred on the piece, along its −Z (a straight: frames are pos (0, 0, z), the same axes)
  const f0 = frames[0], L = -frames.at(-1).pos.z, h = WINDOW.hw, zA = -(L - WINDOW.L) / 2, zB = zA - WINDOW.L;
  const at = (z) => ({ pos: new THREE.Vector3(0, 0, z), tangent: f0.tangent.clone(), up: f0.up.clone(), right: f0.right.clone() });
  const span = (z0, z1) => [at(z0), ...frames.filter((f) => f.pos.z < z0 - 0.05 && f.pos.z > z1 + 0.05), at(z1)];
  // beside the window: the road's section cut at ±h (the kerb and the deck out to the edge, the slab under)
  const top = prof.pts.filter((p) => p.y > -t + 1e-6);
  const left = { hw, pts: [...top.filter((p) => p.x < -h), { x: -h, y: 0, zone: 1 }, { x: -h, y: -t, zone: 0 }, { x: -hw, y: -t, zone: 0 }] };
  const right = { hw, pts: [{ x: h, y: 0, zone: 1 }, ...top.filter((p) => p.x > h), { x: hw, y: -t, zone: 0 }, { x: h, y: -t, zone: 0 }] };
  const rect = [{ x: -h, y: 0 }, { x: h, y: 0 }, { x: h, y: -t }, { x: -h, y: -t }];
  const drawn = mergeGeometries([
    stamp(buildSweepGeometry(span(0, zA), prof, {})),
    stamp(buildSweepGeometry(span(zA, zB), left, {})),
    stamp(buildSweepGeometry(span(zA, zB), right, {})),
    stamp(buildSweepGeometry(span(zB, -L), prof, {})),
    // the window's near and far reveals, facing into it (the side reveals are the strips' own inner faces)
    capGeometry(deck, at(zA), rect, 1),
    capGeometry(deck, at(zB), rect, -1),
  ]);
  // the pane: recessed under the deck, oversize by the flange on every side
  const s = h + WINDOW.flange, top0 = -WINDOW.recess, cz = (zA + zB) / 2;
  const glass = new THREE.BoxGeometry(2 * s, WINDOW.thick, WINDOW.L + 2 * WINDOW.flange).translate(0, top0 - WINDOW.thick / 2, cz);
  // the white frame: a low rim round the window, on the deck (the wheels ride the flat deck over it)
  const r = WINDOW.rim, y = WINDOW.rimH / 2;
  const trimFrame = mergeGeometries([
    new THREE.BoxGeometry(2 * h + 2 * r, WINDOW.rimH, r).translate(0, y, zA + r / 2),
    new THREE.BoxGeometry(2 * h + 2 * r, WINDOW.rimH, r).translate(0, y, zB - r / 2),
    new THREE.BoxGeometry(r, WINDOW.rimH, WINDOW.L).translate(-h - r / 2, y, cz),
    new THREE.BoxGeometry(r, WINDOW.rimH, WINDOW.L).translate(h + r / 2, y, cz),
  ]);
  const sig = sides.join(), first = frames[0], last = frames.at(-1);
  const ends = [endOf(first, -1, hw, sig, capGeometry(deck, first, prof.pts, -1)), endOf(last, 1, hw, sig, capGeometry(deck, last, prof.pts, 1))];
  const look = { deck, drawn, glass, trimFrame, under: null, ends };
  if (!edges) return { ...look, rail: null, railCollision: null, posts: null };
  const posts = { key: "", template: null, matrices: [] };
  return { ...look, rail: buildRailGeometry(frames, rp, RAIL, { postSink: posts, sides }), railCollision: buildRailCollision(frames, rp, undefined, { sides }), posts };
}

/**
 * railCollision is what the CAR hits (two walls with depth, the shape the old car's contact is tuned
 * to); the visible rail and its posts are render-only, as in the old game.
 * @returns {{deck: THREE.BufferGeometry, rail: THREE.BufferGeometry|null, railCollision: THREE.BufferGeometry|null, posts: {template, matrices}|null}}
 */
export function buildOldLook(tile, edges = true) {
  const look = buildLook(tile, edges);
  look.ends ??= coverEnds(tile);
  return look;
}
function buildLook(tile, edges) {
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
  if (tile.taper) return buildTaperLook(tile, edges);
  if (tile.glass) return buildGlassLook(tile, edges);
  const { frames: all } = oldFrames(tile);
  // the road look at this section's width (road 16 m, wide 48, narrow 8)
  const rp = tile.section && tile.section !== "road" ? { ...ROAD_PARAM_DEFAULTS, width: SECTIONS[tile.section].hw * 2 } : ROAD_PARAM_DEFAULTS;
  // RUNS of road: a gap's air frames cut the piece in two (gap jumps); one run for the others
  const runs = [[]];
  for (const f of all) { if (f.air) { if (runs.at(-1).length) runs.push([]); } else runs.at(-1).push(f); }
  const parts = runs.filter((r) => r.length >= 2);
  const merge = (gs) => (gs.length === 1 ? gs[0] : mergeGeometries(gs));
  const sides = railSides(edges);
  const deck = merge(parts.map((r) => buildSweepGeometry(r, sideProfile(rp, sides), {})));
  // the road material reads aPiece = (noise phase, line distance); one phase per tile is enough here
  const n = deck.getAttribute("position").count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { a[i * 2] = 0; a[i * 2 + 1] = NO_CHECKER; }
  deck.setAttribute("aPiece", new THREE.Float32BufferAttribute(a, 2));
  const under = STRIPED.has(String(tile.id ?? "").replace(/_L$/, "")) ? merge(parts.map((r) => stripedUnder(r, rp.width / 2, rp.thickness ?? 0.9))) : null;
  const prof = sideProfile(rp, sides), sig = sides.join(), first = parts[0][0], last = parts.at(-1).at(-1);
  const ends = [endOf(first, -1, rp.width / 2, sig, capGeometry(deck, first, prof.pts, -1)), endOf(last, 1, rp.width / 2, sig, capGeometry(deck, last, prof.pts, 1))];
  const inner = [];
  for (let i = 0; i + 1 < parts.length; i++) inner.push(capGeometry(deck, parts[i].at(-1), prof.pts, 1), capGeometry(deck, parts[i + 1][0], prof.pts, -1));
  const capsFixed = inner.filter(Boolean).length ? mergeGeometries(inner.filter(Boolean)) : null;
  if (!edges) return { deck, rail: null, railCollision: null, posts: null, under, ends, capsFixed };
  const posts = { key: "", template: null, matrices: [] };
  const rail = merge(parts.map((r) => buildRailGeometry(r, rp, RAIL, { postSink: posts, sides })));
  const railCollision = merge(parts.map((r) => buildRailCollision(r, rp, undefined, { sides })));
  return { deck, rail, railCollision, posts, under, ends, capsFixed };
}
