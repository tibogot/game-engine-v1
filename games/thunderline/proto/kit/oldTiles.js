// The old kit's AIR pieces in the new kit (user, 2026-10-18: "the bowl … the flip ramp … that's
// what the game is about"). Their geometry comes from the old buildPiece untouched — they carry
// months of measured tuning — and is re-expressed in the new kit's socket space so the builder, the
// drive page and the prediction treat them like any other tile. No GPU imports: Node tests use it.
//   bowl_<R>       a U-TURN: the old quarter-pipe at radius R, lip vertical, on the WIDE section. You
//                  climb it in the entry lane, pop off the lip, SPIN 180° in the air and come down
//                  the face forward into the return lane, BOWL_LANE m over (bowl_<R>_L: on the
//                  left), heading back. R must fit the ARRIVAL speed — see bowlTest.mjs.
//   flip_ramp_std  the old "Flip ramp" (34 m, throws the car back over its run-up, inverted)
//   flip_ramp_s    the old "Flip ramp S" (23 m)
import * as THREE from "three";
import { TILE_RESOLVERS, SECTIONS } from "./kit.js";
import {
  buildPiece, PIECE_PARAM_DEFAULTS, ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, isFollowRoad, isFreeCarve,
} from "../../../modular-road-v3/modularRoadKit.js";

const PRESETS = {
  // the old palette's numbers (modularRoadBuilder.js CATEGORY_PRESETS)
  flip_ramp_std: { label: "Flip ramp", base: "flip_ramp", params: { flipRampRadius: 21, flipRampAngle: 70, flipRampFace: 7.5, flipRampTopRadius: 16.5, flipRampExit: 135 } },
  flip_ramp_s: { label: "Flip ramp S", base: "flip_ramp", params: { flipRampRadius: 11, flipRampAngle: 70, flipRampFace: 3, flipRampTopRadius: 9, flipRampExit: 132 } },
  // START and FINISH (user, 2026-10-20: "start and finish pieces that have rounded guardrails like I did
  // in the old game"): the old rounded terminus, its guardrail one U round the nose.
  // START: the nose BEHIND you (the piece's entry is the nose's tip), a 24 m stub to wait on. `start` =
  // how far in the car waits (past the 8 m nose) and the line is drawn.
  start_line: { label: "Start", base: "rounded_start", params: { roundEndLength: 24 }, start: { spawn: 14, line: 22 } },
  // FINISH: the line at its entry, then a 28 m stub where the car brakes by itself (≈ 16 m from
  // 200 km/h: driveSession's firm stop after the finish; was 72 m), then the nose. Nothing builds on past it.
  finish_line: { label: "Finish", base: "rounded_end", params: { roundEndLength: 28 }, finish: { line: 2 } },
};

/** Centre-to-centre spacing of the bowl's entry and return lanes (two 24 m roads, 4 m apart). */
export const BOWL_LANE = 28;
const laneSide = (t) => (t.id.endsWith("_L") ? -1 : 1);

const cache = new Map();
/** The old buildPiece, expressed in socket space (entry socket = identity). */
function oldPiece(t, edges) {
  const key = `${t.id}|${edges}`;
  if (cache.has(key)) return cache.get(key);
  const pp = { ...PIECE_PARAM_DEFAULTS, ...t.old.params };
  const r = buildPiece(t.old.base, new THREE.Matrix4(), pp, t.old.road ?? ROAD_PARAM_DEFAULTS, GUARDRAIL_PARAM_DEFAULTS, edges);
  // piece-local → socket space (the connector is identity); a bowl's face is shifted half a lane
  // spacing so the entry socket sits on its entry lane
  const W = t.bowl ? new THREE.Matrix4().makeTranslation((laneSide(t) * BOWL_LANE) / 2, 0, 0).multiply(r.world) : r.world;
  const bake = (g) => (g ? g.clone().applyMatrix4(W) : null);
  const posts = r.railPosts?.template && r.railPosts.matrices.length
    ? { template: r.railPosts.template, matrices: r.railPosts.matrices.map((m) => W.clone().multiply(m)) }
    : null;
  const out = {
    r, W,
    deck: bake(r.geometry),
    deckCollision: bake(r.deckCollision ?? r.geometry),
    rail: bake(r.railGeometry),
    railCollision: bake(r.railCollision),
    posts,
  };
  cache.set(key, out);
  return out;
}

/** Rings/exit in the new kit's shape, from the old piece's own frames (lean is 0: the shape is in the path). */
function oldIntegrate(t) {
  const { r, W } = oldPiece(t, true);
  const rings = [];
  let s = 0, prev = null;
  const push = (p, T, U, R) => { if (prev) s += p.distanceTo(prev); prev = p; rings.push({ p, T, U, R, lean: 0, s, mark: 0 }); };
  // a bowl's centreline is off its face: entry lane at socket x = 0 (face x = ∓BOWL_LANE/2)
  const up = t.bowl ? new THREE.Matrix4().makeTranslation((-laneSide(t) * BOWL_LANE) / 2, 0, 0).premultiply(W) : W;
  for (const f of r.frames) push(f.pos.clone().applyMatrix4(up), f.tangent.clone().transformDirection(W), f.up.clone().transformDirection(W), f.right.clone().transformDirection(W));
  if (t.bowl) {
    // ...and back down the same face, forward, in the return lane: the path the car rides after its spin
    const down = new THREE.Matrix4().makeTranslation(laneSide(t) * BOWL_LANE, 0, 0).multiply(up);
    for (const f of r.frames.slice().reverse()) {
      push(f.pos.clone().applyMatrix4(down), f.tangent.clone().transformDirection(W).negate(), f.up.clone().transformDirection(W), f.right.clone().transformDirection(W).negate());
    }
    const e = { p: new THREE.Vector3(laneSide(t) * BOWL_LANE, 0, 0), T: new THREE.Vector3(0, 0, 1), U: new THREE.Vector3(0, 1, 0), R: new THREE.Vector3(-1, 0, 0), lean: 0 };
    return { rings, exit: e, L: s };
  }
  const c = r.connectorOut;
  const e = {
    p: new THREE.Vector3().setFromMatrixPosition(c),
    T: new THREE.Vector3(0, 0, -1).transformDirection(c),
    U: new THREE.Vector3(0, 1, 0).transformDirection(c),
    R: new THREE.Vector3(1, 0, 0).transformDirection(c),
    lean: 0,
  };
  return { rings, exit: e, L: s };
}

/** What oldLook's buildOldLook returns, for an old tile. */
export function oldLookOf(t, edges) {
  const o = oldPiece(t, edges);
  return { deck: o.deck, deckCollision: o.deckCollision, rail: o.rail, railCollision: o.railCollision, posts: o.posts };
}

TILE_RESOLVERS.push((id) => {
  const m = /^bowl_(\d+)(_L)?$/.exec(id);
  // a left-hand old piece: "<preset>_L" = the same preset with curveDir −1
  const lh = !m && /_L$/.test(id) && PRESETS[id.slice(0, -2)]?.hand ? PRESETS[id.slice(0, -2)] : null;
  if (lh) {
    const def = lh;
    return {
      label: `${def.label} L`, old: { base: def.base, params: { ...def.params, curveDir: -1 } },
      roadHold: isFollowRoad(def.base), freeCarve: isFreeCarve(def.base), customIntegrate: oldIntegrate, customLook: oldLookOf,
    };
  }
  // the bowl is WIDE (two lanes: up one, back down the other)
  const def = m ? { label: `Bowl R${m[1]}`, base: "quarterpipe", params: { qpRadius: Number(m[1]), qpAngle: 90 }, road: { ...ROAD_PARAM_DEFAULTS, width: SECTIONS.wide.hw * 2 } } : PRESETS[id];
  if (!def) return undefined;
  return {
    label: def.label,
    bowl: !!m,
    old: { base: def.base, params: def.params, road: def.road },
    start: def.start, finish: def.finish,
    roadHold: isFollowRoad(def.base), // the flip ramp needs it (its launch logic reads it)
    freeCarve: isFreeCarve(def.base), // park shapes: free pivot steering
    customIntegrate: oldIntegrate,
    customLook: oldLookOf,
  };
});
