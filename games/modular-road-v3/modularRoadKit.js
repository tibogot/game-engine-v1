import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  buildRailGeometry,
  buildMirroredRailGeometry,
  buildRailCollision,
  buildRailAlongPath,
  buildRailCollisionAlongPath,
  buildMirroredRailAlongPath,
} from "./modularRoadRail.js";
import { buildStartNewGateGeometries, buildCheckpointArchGeometry } from "./modularRoadStartGate.js";

/**
 * Modular Road kit — parametric track pieces built by sweeping a single shared
 * cross-section profile along each piece's centerline using a parallel-transport
 * (minimal-twist) frame. The shared profile guarantees pieces mate seamlessly at
 * their sockets; the transport frame keeps the design loop/bank-ready from day one.
 *
 * Coordinate convention (piece-local): the centerline starts at the origin and
 * heads toward -Z. Up is +Y. "Right" of travel is +X (= cross(tangent, up)).
 */

const V3 = THREE.Vector3;
const _up = new V3(0, 1, 0);

/** Shared cross-section appearance — edit via UI, then call onChange to rebuild. */
export const roadParams = {
  width: 16, // outer kerb-to-kerb deck width (m)
  thickness: 0.8, // slab depth below the deck (m) — this is the "depth"
  // KERB WIDTH (m, each side). Was 0.5, which the old flat-sheet rail sat on
  // fine — its posts were 0.1 m boxes right against the beam. The rail in
  // modularRoadRail.js has a blockout and a base plate, so its footprint reaches
  // ~0.37 m out from the kerb centre and 0.5 left most of it hanging in the air.
  // buildPostTemplate clamps as a backstop (old tracks carry their own saved
  // railWidth), but the kerb wants to be genuinely wide enough to carry a post.
  railWidth: 0.75,
  railHeight: 0.22, // kerb height above the deck (m) — low; guardrail sits on top
  segLen: 1.6, // sweep step (m). Curves, morphs, AND constant straights.
  onChange: null,
};

/**
 * Samples across the drivable deck (and the underside).
 *
 * 1 is a single quad. 12 matches buildBankProfile, so a bank-in still meets
 * a straight vertex-for-vertex across the deck. (Repeating close-up
 * diagonals on a wet deck were shadow acne + screen-space bump derivatives,
 * not this tessellation — see roadGame shadowNormalBias and bumpHeightAt.)
 */
const DECK_STEPS = 12;

/**
 * Guardrail that sits on top of each kerb (W-beam + posts), adapted from the
 * objects-lab guardrail but driven by the piece's own transport frames so it
 * follows slopes/curves in 3D. Built as a separate metal mesh per piece.
 */
export const guardrailParams = {
  /** Kerbs + W-beam guardrails on new pieces when true; flat deck when false. */
  enabled: true,
  beamHeight: 0.8, // vertical height of the W-beam (m)
  beamDepth: 0.1, // lateral thickness of the beam (m)
  beamGap: 0.16, // gap from kerb top to beam bottom (m)
  crownFrac: 0.22, // depth of the central W indent (fraction of beamDepth)
  /** Peaked top cap — rise as a fraction of beamDepth, over a run of half the
   *  depth. Above 0.5 the face tilts past 45° so a car landing on the rail is
   *  shed sideways rather than balanced on it; 0 restores the old bare knife
   *  edge. See wBeamProfile for why this matters. */
  capRiseFrac: 0.8,
  postSpacing: 4, // meters between posts
  postWidth: 0.1, // lateral width of a post (m)
  postThickness: 0.1, // along-travel thickness of a post (m)
  onChange: null,
};

/** Per-piece geometry params (global for v1; per-instance can come later). */
export const pieceParams = {
  straightLength: 22,
  // Platform: a wide, flat, line-free deck for landing zones / open stunt areas.
  platformLength: 24,
  platformWidth: 44,
  narrowWidth: 8, // narrow precision road (keeps lines + kerbs)
  curveRadius: 26,
  curveAngle: 90, // degrees of arc
  curveDir: 1, // +1 = right turn, -1 = left turn
  slopeLength: 26, // horizontal run of the slope (m)
  slopeRise: 9, // vertical rise over the run (m); negative = downhill
  // ── GRADED CLIMB — Grade in → (straights) → Grade out ─────────────────────
  //
  // WHAT DECIDES WHETHER THE CAR FOLLOWS A HILL IS ITS RADIUS, NOT ITS GRADE.
  // Holding a vertical curve of radius R at speed v needs v²/R of downward
  // acceleration; past what gravity plus downforce can supply, the wheels
  // simply leave and the road has become a takeoff ramp. Measured across the
  // shipped Slopes presets (tools/gradeFollowTest.mjs), every one of them
  // crested tighter than ~30 m — i.e. a jump above 40–60 km/h, against a car
  // that tops out near 175. That is the whole of "the slopes are not usable".
  //
  // `slope` cannot fix it, because one piece has to gain the height AND come
  // back to level, so its whole rise is spent turning. This family splits the
  // job: ONE vertical curve to pick the grade up, ordinary straights (which
  // inherit the pitch from the connector, so they climb at zero curvature and
  // are followable at ANY speed) to gain as much height as you like, and ONE
  // vertical curve to put it back down. Each transition only ever absorbs
  // `gradeAngle`, so its radius is a free choice instead of a consequence.
  //
  // gradeRadius IS the tightest radius the transition contains — see
  // gradeCurvePoints for why the piece's LENGTH is derived from it rather than
  // being a parameter of its own.
  gradeAngle: 10, // the grade the climb holds (deg); negative descends
  gradeRadius: 160, // tightest vertical radius in a transition (m)
  gradeLength: 40, // the constant-grade straight between the transitions (m)
  // Banked pieces (reuse curveRadius/curveAngle/curveDir):
  bankAngle: 22, // lean in degrees (turns HOLD it; Bank up/down ease it in/out)
  // CURL — how far the deck EDGE lifts above the flat chord, in metres, at full
  // bank. This is what makes a banked piece a different SHAPE from a straight
  // rather than the same flat plate rolled over: see buildBankProfile.
  // 0 restores the old flat plate exactly.
  bankCurl: 0.9,
  bankCurlSteps: 12, // deck samples across the width (shading resolution)
  // RAMP LENGTH — how much road the Bank in / Bank out transitions get to do
  // their work in. Its OWN number rather than the straight piece's
  // `straightLength`, which is what it used to borrow: those two want opposite
  // things. A straight is a building block you want short so you can compose
  // with it; a bank ramp is a transition that has to be LONG or the deck snaps
  // over instead of rolling. Sharing one slider meant you could not have both,
  // and at the straight's 22 m the ramp rolled 22° and lifted its edge 0.8 m in
  // under a second at speed — it read as a fold, not a bank.
  bankRampLength: 40,
  // CLIMB — height gained across a banked TURN (see bankedClimbCurvePoints).
  // Smoothstepped, so the piece enters and leaves horizontal and the rest of
  // the chain does not tilt; negative descends. Sized per tile,
  // because the grade is rise / arc length and a 60° R34 turn is a third of the
  // road a 90° R58 one is.
  bankRise: 10,
  // ── Jump / launch ramp ────────────────────────────────────────────────────
  // TAKEOFF ANGLE IS TIED TO TOP SPEED. Ballistic range is v²·sin(2θ)/g, so it
  // scales with the SQUARE of speed — raising TIRE.topSpeed 30 → 50 m/s made
  // every jump 2.6× longer on its own. At terminal speed (48 m/s / 174 km/h):
  //     8° → 66 m,  12° → 97 m,  20° → 153 m,  28° → 197 m
  // 28° was sized for the old 108 km/h car and threw the car ~197 m and 26 m
  // high — far past any gap you'd actually build (the kit's gap was 22 m).
  // 12° gives a 97 m arc peaking 5.1 m up: still a proper stunt jump, but in
  // proportion to the pieces around it.
  //
  // If topSpeed changes again, rescale this — the arc goes as v².
  jumpLength: 18, // arc length of the ramp (m)
  jumpAngle: 12, // takeoff angle at the exit (deg)
  // Dive / down ramp (mirror of the jump — flat entry, exit pitched down).
  // Kept equal to jumpAngle so a dive→jump pair stays symmetric.
  diveLength: 18, // arc length of the ramp (m)
  diveAngle: 12, // down-pitch angle at the exit (deg)
  // Drivable vertical looping (round ring split at the bottom, feet slid apart
  // sideways so both stay flat on the floor). Tunable shape controls:
  loopRadius: 25, // ring radius (m)
  loopOffset: 16, // sideways gap between the entry foot and exit foot (m, red axis)
  loopFlat: 12, // flat lead-in / lead-out length on the floor (m)
  loopSpread: 1, // how much the foot gap concentrates at the feet (0 = even/coil, 1 = feet only)
  loopHalf: "full", // "full" = whole loop; "in" = entry→top slice; "out" = top→exit slice
  loopLean: 0, // tilt the ring plane toward/away (-1..1); 0 = perfectly vertical
  loopTighten: 0, // teardrop pinch toward the top (0 = round circle, up to 0.7)
  loopAdvance: 28, // unused leftover on old saves — do not read; see loopStretch
  // Forward gap between the ring's entry foot and exit foot (m, along −Z). 0 keeps
  // the compact looping (feet side-by-side). A positive value stretches the ring
  // into one turn of a helix so the start and end are not on top of each other.
  loopStretch: 0,
  // Spiral ring / corkscrew (flat run + climbing wrapped arc):
  loopSpiralRadius: 12, // helix radius (m)
  loopSpiralTurns: 1, // full revolutions about the vertical axis
  loopSpiralRise: 32, // total height climbed over the helix (m)
  // Game line pieces (start / checkpoint / finish):
  gameLineLength: 16,
  /** Longer stub on start_new / finish_new (rounded terminus + gantry). */
  gameStartStub: 14,
  /** How far past the nose diameter the start / finish line + gantry sit (m). */
  gameStartLineOffset: 6,
  /** Car spawn sits this many metres before the start line on start_new. */
  gameStartSpawnBackset: 4,
  // Twist / barrel roll (straight centreline that rolls):
  twistLength: 26,
  twistTurns: 1, // full 360° rolls over the length
  // Spiral / helix (constant-radius turn that also climbs):
  spiralRadius: 18,
  spiralAngle: 180, // degrees of arc (allow multi-turn for a true helix)
  spiralRise: 10, // total height gained over the arc (m)
  // ── Gap spacer (invisible air gap that drifts forward & drops) ────────────
  // SIZED TO THE BALLISTIC ARC, so the gap's exit lands where the car actually
  // does: a flat launch falling `gapDrop` covers v·√(2·drop/g). At the gap
  // preview's reference speed (roadGame `refSpeed` 40 m/s) with a 6 m drop
  // that's 44 m. The old 22 m was sized for the 30 m/s car and left you flying
  // well past the far side.
  gapLength: 44, // forward run across the gap (m)
  gapDrop: 6, // height lost across the gap (m)
  // ── Landing ramp (enters pitched down, eases to level) ────────────────────
  // MATCHED TO THE ARRIVAL ANGLE, or the car slams into a ramp that's flatter
  // than its descent. A 12° jump landing level arrives at 12°; a flat gap with
  // a 6 m drop arrives at 13–15°. 15° is a touch steeper than both, so the ramp
  // meets the car rather than the car hitting the ramp.
  landLength: 16,
  landAngle: 15, // entry down-pitch (deg)
  // Brow ramp (mirror of landing — enters pitched up, eases to level):
  browLength: 16,
  browAngle: 15, // entry up-pitch (deg)
  // Tunnel shell:
  tunnelHeight: 7, // interior clearance from deck to crown (m)
  // Rideable tube (the tube wall IS the road — drive inside, loop the walls):
  tubeRadius: 8, // interior radius (m)
  tubeWall: 0.6, // wall thickness (m) — visible at the open ends
  // Half tube — the same rideable ring with the top cut away (see
  // buildHalfTubeProfile). Shares tubeRadius/tubeWall so a half tube seams onto
  // a full tube of the same size.
  halfTubeSpan: 180, // arc of the surviving arc (deg), centred on the floor
  // Tube entry / exit funnel — the flat road rolls up into the tube bore over
  // this length (see buildTubeMorphProfile). Long on purpose: the curl has to
  // read as a shape developing, and a short one just looks like the road got
  // pinched. Radius / wall / span come from the tube params above, so an entry
  // seams onto whatever tube it is placed against.
  tubeEntryLength: 26,
  // Far-end radius of a tube REDUCER (see buildTubeReducerProfile) — the piece
  // that lets a second size family exist at all. Defaults to tubeRadius, i.e.
  // no taper, so a reducer with nothing set is just a length of tube.
  tubeRadius2: 12,
  // Snowboard half-pipe (flat + transition + vert — see buildHalfPipeProfile).
  // Transition radius is tubeRadius; wall thickness is tubeWall.
  halfPipeFlat: 12, // flat bottom between the two transitions (m)
  halfPipeVert: 3, // straight vertical wall above the transition (m)
  // Half-pipe channel shell (open-top quarter-pipe walls):
  channelRadius: 4, // wall fillet radius = wall height (m)
  // Quarter-pipe (concave ramp curving up a vertical-plane arc to a wall):
  qpRadius: 16, // arc radius (m) — also the wall height at 90°
  qpAngle: 90, // arc sweep (deg): 90 = up to vertical, less = a launch kicker
  // ── Junctions (see the JUNCTION AUTHORING PLANE block below) ─────────────
  // Sizes are in metres and all of them are clamped against the road width, so
  // a junction can never end up with an arm narrower than the road feeding it.
  junctionLength: 34, // through-lane run of a T / crossroads (m)
  junctionStub: 22, // how far a side arm reaches from the through centreline (m)
  junctionFillet: 6, // corner radius where an arm meets the through lane (m)
  forkAngle: 30, // half-angle of each Y-fork arm (deg)
  forkArm: 34, // Y-fork arm length from the split (m)
  forkThroat: 6, // straight run before a Y fork starts to diverge (m)
  splitAngle: 24, // slip-road departure angle (deg)
  splitLength: 40, // through run of a split / merge (m)
  splitArm: 30, // slip-road arm length (m)
  splitStart: 8, // where along the run the slip road peels off (m)
  roundaboutRadius: 22, // ring CENTRELINE radius (m)
  roundaboutStub: 10, // stub length outside the ring (m)
  // Glass road (lacquered deck with a glazed square window — see
  // buildGlassDeckGeometry). Its own sizes rather than the hole road's, because
  // the two are tuned against different things: that one wants a gap you can
  // fall through, this one wants a window you can look through.
  glassLength: 32, // run of the piece (m)
  glassWidth: 16, // deck width (m)
  glassHole: 9, // side of the square window (m)
  glassRecess: 0.025, // how far the pane sits below the deck (m)
  glassFlange: 0.15, // how far the pane tucks UNDER the deck on each side (m)
  glassThick: 0.18, // pane thickness (m)
  // Hole road (straight deck with a big circular hole punched through it):
  holedLength: 32, // run of the piece (m)
  holedWidth: 16, // deck width (m) — widen for a bigger hole with real ledges
  holeRadius: 5, // hole radius (m) — clamped so ledges never vanish
  // Dual boards: two close planks you straddle like a bridge — left wheels on
  // one, right on the other, void under the belly. Gap is narrower than the
  // car's track (~1.84 m) so both boards are in play at once; each plank is
  // too narrow to hold the whole car, so drifting off-centre drops a side.
  dualLength: 32,
  dualWidth: 4.4, // 2×1.75 m boards + 0.9 m gap
  dualGap: 0.9,
  // Rounded end (short terminus with a semicircle nose):
  roundEndLength: 8, // straight run before the nose (m)
  // ── LINK: the piece that CLOSES A GAP between two ends built separately ────
  // Every other piece has a shape and lands wherever it lands. This one is the
  // other way round: you give it where it has to END and it works out the shape.
  // Its target is stored in the ENTRY'S LOCAL FRAME, so the piece stays a pure
  // function of its params (rebuildAll re-derives its world pose like any other)
  // and it saves and loads with no format change.
  linkX: 0, // target offset right (m), in the entry frame
  linkY: 0, // target offset up (m)
  linkZ: -48, // target offset ALONG TRAVEL (m; travel is −Z, so this is negative)
  linkYawDeg: 0, // heading the road must be pointing when it arrives (deg)
  // Multiplier on the tangent length a circular arc of the same chord and turn
  // would use (see _linkTangentScale). 1 = arc-like, which is what you want
  // almost always. Higher runs straighter out of each end and bulges in the
  // middle; lower turns harder near the ends and eventually cusps.
  linkTension: 1,
  onChange: null,
};

/* ----------------------------------------------------------------------- */
/* PRISTINE DEFAULTS — the baseline a saved track is diffed against.        */
/*                                                                         */
/* Captured HERE, at module init, because the three objects above are the   */
/* live, mutable ones the dev panel writes straight into: by the time a     */
/* save runs, `pieceParams.jumpAngle` is whatever the last slider left it   */
/* at, and nothing in memory remembers any more what the build shipped      */
/* with. These frozen copies are that memory.                              */
/*                                                                         */
/* They are what lets a track file say "I did not choose this" — see        */
/* `sparse()` in modularRoadTrackIO.js. A key ABSENT from a save resolves   */
/* against whatever THIS build thinks is right, so retuning a default flows */
/* into every track that never overrode it, while a value the user actually */
/* dialled in differs from the baseline and is written out verbatim.        */
/*                                                                         */
/* `onChange` is stripped rather than copied: it is a live callback, never  */
/* part of the format, and leaving it in would make every diff compare a    */
/* function against `null`.                                                 */
/* ----------------------------------------------------------------------- */

const _pristine = (o) => { const c = { ...o }; delete c.onChange; return Object.freeze(c); };

export const ROAD_PARAM_DEFAULTS = _pristine(roadParams);
export const GUARDRAIL_PARAM_DEFAULTS = _pristine(guardrailParams);
export const PIECE_PARAM_DEFAULTS = _pristine(pieceParams);

/* ----------------------------------------------------------------------- */
/* Cross-section profile                                                    */
/* ----------------------------------------------------------------------- */

/**
 * Build the closed cross-section outline in the local (x = lateral, y = vertical)
 * plane. The deck top sits at y = 0; rails rise to +railHeight; the slab extends
 * down to -thickness. Each point carries a `zone`: 0 = side/underside,
 * 1 = drivable deck, 2 = rail top.
 * @param {object} p road cross-section params
 * @param {boolean} [withKerbs=true] false = flat deck only (no raised kerbs)
 * @returns {{ pts: {x:number,y:number,zone:number}[], hw:number }}
 */
export function buildProfile(p = roadParams, withKerbs = true) {
  const hw = p.width / 2;
  const t = Math.max(0.05, p.thickness);
  const N = DECK_STEPS;

  if (!withKerbs) {
    const pts = [];
    for (let k = 0; k <= N; k++) {
      const x = -hw + (2 * hw * k) / N;
      pts.push({ x, y: 0, zone: 1, smooth: k > 0 && k < N });
    }
    for (let k = N; k >= 0; k--) {
      const x = -hw + (2 * hw * k) / N;
      pts.push({ x, y: -t, zone: 0, smooth: k > 0 && k < N });
    }
    return { pts, hw };
  }

  const rw = Math.min(Math.max(0.0, p.railWidth), hw * 0.45);
  const rh = Math.max(0.0, p.railHeight);
  const dx = hw - rw;

  // Clockwise outline (x right, y up): kerb, deck, kerb, underside.
  // The deck used to be TWO points — left edge to right edge, one quad, one
  // 22 m diagonal. Interior samples are flagged smooth so the flat still
  // shades as a plane; the kerb corners stay hard.
  const pts = [
    { x: -hw, y: rh, zone: 2 },
    { x: -hw + rw, y: rh, zone: 2 },
  ];
  for (let k = 0; k <= N; k++) {
    const x = -dx + (2 * dx * k) / N;
    pts.push({ x, y: 0, zone: 1, smooth: k > 0 && k < N });
  }
  pts.push(
    { x: hw - rw, y: rh, zone: 2 },
    { x: hw, y: rh, zone: 2 },
  );
  for (let k = N; k >= 0; k--) {
    const x = -hw + (2 * hw * k) / N;
    pts.push({ x, y: -t, zone: 0, smooth: k > 0 && k < N });
  }
  return { pts, hw };
}

/**
 * CURLED (banked) cross-section — a deck that CURVES across its width instead of
 * being a flat plate.
 *
 * WHY THIS EXISTS. Every bank piece used to sweep `buildProfile`, i.e. the exact
 * same flat slab a straight uses, tipped over by `bankRoll`. Measured on the
 * shipping kit, the drivable deck of a long banked turn was 120 triangles and a
 * bank-in was 30 — ONE quad across the full 14.5 m width, for the whole piece.
 * A single quad has a single normal, so the entire deck shades as one uniform
 * tone: no gradient, no highlight travelling across it as the bank rolls in,
 * nothing for the eye to read the curvature from. That is the "low poly / bad
 * looking" banked piece, and the polygon count is only half of it — the other
 * half is that a flat plate is genuinely the wrong SHAPE. Real banking curls.
 *
 * THE CURVE. A parabola in the piece's own lateral axis,
 *     y(x) = curl · (x / hw)²
 * so the deck is flat at the centreline and lifts by exactly `curl` at each outer
 * edge. Symmetric in LOCAL space on purpose:
 *   - it flips L/R for free, which the whole kit relies on (`pp.curveDir`);
 *   - once the piece is rolled by `bankAngle` it stops being symmetric in WORLD
 *     space — the outer edge ends up steep and the inner edge nearly flat, which
 *     is the asymmetry a banked corner actually has. Authoring that asymmetry
 *     into the profile instead would double it up and break the flip.
 *
 * The kerbs ride ON the curve (they sit at the deck height under them, not at a
 * flat y = 0), and the underside is the same curve offset down by `thickness`,
 * so the slab keeps an even depth and reads as a shell rather than a wedge.
 *
 * `smooth: true` on the deck and underside points is what stops the curve
 * faceting — see the welding pass in buildSweepGeometry. Without it this returns
 * a 12-sided polygon with 12 visible creases, which looks WORSE than the flat
 * plate it replaces. The kerb corners are deliberately left un-flagged: those
 * are meant to be crisp.
 *
 * @param {object} p road cross-section params
 * @param {boolean} withKerbs false = flat deck only (no raised kerbs)
 * @param {number} curl metres of edge lift; <= 0 falls through to
 *   buildProfile (now the same DECK_STEPS subdivision, so a bank-in still
 *   meets a straight across the deck)
 * @param {number} steps deck samples across the width
 */
export function buildBankProfile(p = roadParams, withKerbs = true, curl = 0, steps = DECK_STEPS) {
  const hw = p.width / 2;
  // Strictly > 0, not > epsilon: the morph callback drives `curl` to (almost)
  // zero at a flat seam, and it needs the SAME POINT COUNT there as at full
  // curl. A near-zero curl keeps this subdivided section; exact 0 falls through
  // to buildProfile, which now uses the same DECK_STEPS so the seam still matches.
  if (!(curl > 0)) return buildProfile(p, withKerbs);
  const t = Math.max(0.05, p.thickness);
  const N = Math.max(2, Math.round(steps));
  const y = (x) => curl * (x / hw) * (x / hw);

  // Deck run, edge to edge. Kerbs eat `rw` off each side when they are on.
  const rw = withKerbs ? Math.min(Math.max(0.0, p.railWidth), hw * 0.45) : 0;
  const rh = withKerbs ? Math.max(0.0, p.railHeight) : 0;
  const dx = hw - rw; // deck half-width, inside the kerbs

  // Same clockwise outline as buildProfile: across the top, down the right face,
  // back along the underside, up the left face.
  const pts = [];
  if (withKerbs) {
    pts.push({ x: -hw, y: y(-hw) + rh, zone: 2 });
    pts.push({ x: -dx, y: y(-dx) + rh, zone: 2 });
  }
  for (let k = 0; k <= N; k++) {
    const x = -dx + (2 * dx * k) / N;
    // Endpoints stay hard: they are where the deck meets the kerb (or the slab
    // edge), and smoothing across that corner would round the kerb into the road.
    pts.push({ x, y: y(x), zone: 1, smooth: k > 0 && k < N });
  }
  if (withKerbs) {
    pts.push({ x: dx, y: y(dx) + rh, zone: 2 });
    pts.push({ x: hw, y: y(hw) + rh, zone: 2 });
  }
  // Underside: the same curve, `t` lower, walked back the other way.
  for (let k = N; k >= 0; k--) {
    const x = -hw + (2 * hw * k) / N;
    pts.push({ x, y: y(x) - t, zone: 0, smooth: k > 0 && k < N });
  }
  return { pts, hw };
}

/**
 * Rideable-tube cross-section: a thick-walled annulus whose INNER surface is
 * the drivable "deck" (zone 1) — the car rides inside, up the walls, even a
 * full inverted loop at speed. No flat road, no kerbs. The ring bottom sits at
 * y = 0 so a flat piece feeds straight onto the tube floor; both ends are left
 * open, showing the wall thickness (like the obstacles pipe prop).
 * The closed outline runs the inner circle, jumps to the outer wall at the
 * bottom seam, and runs back — the two radial webs sit hidden at the seam.
 */
/**
 * Flag the INTERIOR of every run of same-zone points as smooth-shaded.
 *
 * One rule for all the curved sections, because hand-flagging each one is how
 * you smooth a corner that was meant to be a corner. A point belongs to a
 * continuous surface exactly when both its neighbours are on the same surface,
 * and `zone` already says which surface that is — bore (3) or outer shell (4).
 *
 * It falls out correctly everywhere it is used:
 *   • a full tube's two arc ends border the radial webs, so they stay crisp;
 *   • a half tube's lips border the rim caps, so those stay crisp;
 *   • the half-pipe's vert-to-transition and transition-to-floor joins are
 *     tangent-continuous and interior to the bore run, so they smooth;
 *   • a flat road section (zones 0/1/2) has no run longer than its own corners,
 *     so nothing is flagged and weldSmoothProfileNormals returns immediately.
 *
 * The outline is a closed loop, so the neighbour lookup wraps.
 */
function flagSmoothRuns(pts) {
  const M = pts.length;
  for (let k = 0; k < M; k++) {
    const z = pts[k].zone;
    const prev = pts[(k - 1 + M) % M].zone;
    const next = pts[(k + 1) % M].zone;
    if (prev === z && next === z) pts[k].smooth = true;
  }
  return pts;
}

function buildTubeProfile(pp = pieceParams) {
  const Ri = Math.max(3, pp.tubeRadius ?? 8);
  const tw = Math.max(0.15, pp.tubeWall ?? 0.6);
  const Ro = Ri + tw;
  const N = 48;
  const pts = [];
  // Inner surface (drivable): the FULL circle, k = 0..N inclusive, so the last
  // edge lands back on the seam angle — stopping at N-1 left a missing wedge
  // (an open band) at the tube bottom. The duplicated seam angle then jumps
  // radially to the outer wall, which walks back the other way; the two radial
  // webs sit coincident at the seam, hidden inside the wall.
  // Zones 3 (tube inner) / 4 (tube outer) get their own colors + the inner
  // neon rings in createRoadMaterial.
  for (let k = 0; k <= N; k++) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / N;
    pts.push({ x: Math.cos(a) * Ri, y: Ri + Math.sin(a) * Ri, zone: 3 });
  }
  for (let k = N; k >= 0; k--) {
    const a = -Math.PI / 2 + (2 * Math.PI * k) / N;
    pts.push({ x: Math.cos(a) * Ro, y: Ri + Math.sin(a) * Ro, zone: 4 });
  }
  flagSmoothRuns(pts);
  // The bore is a closed circle whose two ends sit on top of each other at the
  // bottom, 96 indices apart in the outline — pair them so the floor the car
  // drives on closes too.
  pts[0].seam = N; pts[N].seam = 0;
  pts[N + 1].seam = 2 * N + 1; pts[2 * N + 1].seam = N + 1;
  return { pts, hw: Ri };
}

/**
 * Half-tube cross-section: the rideable tube with the top cut away.
 *
 * NOT the same thing as the half-pipe CHANNEL, which is why both exist. The
 * channel is a shell: a flat road with a quarter-pipe fillet outside each kerb,
 * baked into SOLIDS, so the walls stop the chassis but the wheels never leave
 * the flat deck. This is a PROFILE, like the full tube — the arc IS the road, it
 * lands in the deck BVH, and the wheels drive up it. You can carry a line up to
 * vertical and back down; a channel just bounces you off.
 *
 * Cut from the same circle as buildTubeProfile, on the same centre (y = Ri, so
 * the floor sits at y = 0 and a flat piece feeds straight in) and out of the
 * same tubeRadius/tubeWall — so a half tube seams onto a full tube of the same
 * size, and the transition is the roof simply ending.
 *
 * `halfTubeSpan` is the arc that SURVIVES, centred on the floor: 180° is a true
 * half, and past that the rim curls back over you, which is where the piece
 * stops being a valley and starts being a tube you can fall out of. The clamp
 * ends at 300° rather than 360° because a closed ring is the tube piece's job,
 * and the closing arc would collapse the two rim caps onto each other.
 *
 * Outline order matches buildTubeProfile: the inner (drivable) arc first in the
 * direction of increasing angle, then the outer arc back — so the closed loop's
 * two remaining edges are the RIM CAPS, one at each lip, which is what gives the
 * open edges their visible wall thickness.
 */
function buildHalfTubeProfile(pp = pieceParams) {
  const Ri = Math.max(3, pp.tubeRadius ?? 8);
  const tw = Math.max(0.15, pp.tubeWall ?? 0.6);
  const Ro = Ri + tw;
  const span = THREE.MathUtils.degToRad(
    THREE.MathUtils.clamp(pp.halfTubeSpan ?? 180, 60, 300),
  );
  const a0 = -Math.PI / 2 - span / 2; // left lip
  // Keep the full tube's angular resolution (48 steps for 360°) so the two
  // pieces facet identically and a half-to-full seam has matching vertices.
  const N = Math.max(8, Math.round((48 * span) / (2 * Math.PI)));
  const pts = [];
  for (let k = 0; k <= N; k++) {
    const a = a0 + (span * k) / N;
    pts.push({ x: Math.cos(a) * Ri, y: Ri + Math.sin(a) * Ri, zone: 3 });
  }
  for (let k = N; k >= 0; k--) {
    const a = a0 + (span * k) / N;
    pts.push({ x: Math.cos(a) * Ro, y: Ri + Math.sin(a) * Ro, zone: 4 });
  }
  flagSmoothRuns(pts);
  return { pts, hw: Ri };
}

/**
 * SNOWBOARD HALF-PIPE cross-section: flat bottom, transition, then VERT.
 *
 * Not the same shape as a half tube, and the difference is the whole point. A
 * half tube is one circular arc, so the only place its wall is vertical is a
 * single point at the very top. Ride up a bare arc and where you leave it
 * decides which way you get thrown:
 *
 *   span < 180°  you leave before vertical, still moving OUTWARD  -> over the
 *                deck and gone
 *   span = 180°  vertical for an instant — the right answer, but it is a knife
 *                edge; leave a fraction early and it is the case above
 *   span > 180°  the rim has curled back over, so you leave moving INWARD and
 *                get thrown across the pipe into the flat
 *
 * The 200° Park Pipe was the third case and it was reported as exactly that:
 * "the car falls back at the centre of the pipe, it should fall on the slope."
 * Which is right — in a real pipe a rider who comes down in the flat has taken
 * the whole drop onto level ground, and that is how legs get broken.
 *
 * A real pipe solves it with a VERT: the transition curves up to vertical and
 * then the wall simply carries ON straight up for the last stretch. Through the
 * whole vert the rider's sideways velocity is zero, so they leave the lip going
 * STRAIGHT UP, float, and drop back onto the same wall just under the lip —
 * landing on the transition, which is exactly what a transition is for. The vert
 * turns the knife edge into a section with margin: anywhere in it gives the same
 * vertical launch.
 *
 * Geometry, floor at y = 0 so a flat piece feeds straight in (as the half tube
 * does). Transition centre sits at (±flat/2, Rt), so
 *     p(θ) = (±(flat/2 + Rt·sinθ), Rt·(1 − cosθ)),  θ = 0 … 90°
 * which is tangent to the floor at θ=0 and vertical at θ=90°, then the vert runs
 * straight from y = Rt to y = Rt + vert.
 *
 * Outline order follows buildHalfTubeProfile — the whole inner (drivable)
 * surface first, then the outer shell back — so the two closing edges are the
 * RIM CAPS at the lips. They carry mixed zones, become zone 0, and
 * buildOpenLipCollision strips them, without which the lip is a shelf and the
 * car cannot leave the pipe at all.
 */
function buildHalfPipeProfile(pp = pieceParams) {
  const Rt = Math.max(3, pp.tubeRadius ?? 8); // transition radius
  const tw = Math.max(0.15, pp.tubeWall ?? 0.6);
  const hf = Math.max(0, pp.halfPipeFlat ?? 0) / 2; // half the flat bottom
  const vert = Math.max(0, pp.halfPipeVert ?? 0); // straight wall above the arc
  const N = 16; // steps per transition quadrant
  const inner = [];
  const outer = [];
  // Left lip down to the floor, then up the right side. `s` is the side sign.
  for (const s of [-1, 1]) {
    const arc = [];
    for (let k = 0; k <= N; k++) {
      const th = (Math.PI / 2) * (k / N);
      arc.push({
        i: { x: s * (hf + Rt * Math.sin(th)), y: Rt * (1 - Math.cos(th)) },
        // Outer shell is the same arc grown by the wall thickness about the same
        // centre, so the wall keeps an even thickness all the way round.
        o: { x: s * (hf + (Rt + tw) * Math.sin(th)), y: Rt - (Rt + tw) * Math.cos(th) },
      });
    }
    const lip = { i: { x: s * (hf + Rt), y: Rt + vert },
      o: { x: s * (hf + Rt + tw), y: Rt + vert } };
    if (s < 0) {
      // Left side runs lip -> floor, so vert first and the arc reversed.
      if (vert > 0) { inner.push(lip.i); outer.push(lip.o); }
      for (let k = N; k >= 0; k--) { inner.push(arc[k].i); outer.push(arc[k].o); }
    } else {
      // Right side runs floor -> lip. Skip k=0: it is the same point the left
      // side finished on when there is no flat, and a duplicated outline vertex
      // is what turns an ear-clipped band into a zero-area triangle.
      for (let k = hf > 1e-6 ? 0 : 1; k <= N; k++) { inner.push(arc[k].i); outer.push(arc[k].o); }
      if (vert > 0) { inner.push(lip.i); outer.push(lip.o); }
    }
  }
  const pts = [];
  for (const p of inner) pts.push({ x: p.x, y: p.y, zone: 3 });
  for (let k = outer.length - 1; k >= 0; k--) pts.push({ x: outer[k].x, y: outer[k].y, zone: 4 });
  flagSmoothRuns(pts);
  return { pts, hw: hf + Rt };
}

/**
 * TUBE ENTRY / EXIT cross-section — one section that MORPHS from a flat road
 * into a tube bore (or back out of one).
 *
 * WHY THIS EXISTS. Every tube in the kit starts as a tube: an 8 m bore butted
 * straight onto a 14.5 m flat plate. The seam is a step, the car arrives at a
 * wall that appeared out of nothing, and the two pieces do not even share a
 * width. Real stunt kits (this is the Apex Rush shape) put a FUNNEL in between —
 * the deck edges lift, curl inward, and by the far seam they have wrapped into
 * the bore. That is what this builds.
 *
 * THE SHAPE IS ALWAYS A CIRCULAR ARC, tangent to horizontal at the floor
 * centreline. Two numbers describe it: the half-angle it subtends, `phi`, and
 * the SPAN OF THE SECTION IN PLAN, `hw` — how wide the piece is looking down on
 * it. Radius follows. Walk both from road to tube:
 *
 *     phi:  0             -> span/2   (flat plate -> the tube's own arc)
 *     hw:   road half-width -> Ri      (the bore at its widest)
 *
 * so R goes from infinity (a straight line) to exactly Ri. t = 0 returns the
 * road's own flat section — same width, same slab thickness, so it seams onto a
 * straight with nothing to line up by hand — and t = 1 returns the SAME points
 * buildTubeProfile / buildHalfTubeProfile would (same N, same angles, verified
 * by tools/tubeEntryTest.mjs), so the far seam matches a tube of the same params
 * vertex for vertex. Nothing in between can self-intersect: an arc is
 * single-valued about its own centre however far it wraps.
 *
 * WIDTH, NOT ARC LENGTH, IS THE PARAMETER, and that choice is visible from the
 * car. The first version interpolated developed (arc) length instead, which
 * also hits both ends exactly — but width is then R·sin(phi), and MEASURED on
 * the stock kit that ballooned the funnel to 11.3 m half-width at the middle of
 * a 8 -> 8 m transition: the road bellied out like a trumpet and pinched back
 * in. Driving through a bulge that is not going anywhere reads as a mistake.
 * Holding the plan width instead means the road keeps the width it had; only
 * its edges lift and curl inward, which is the shape the reference kit has and
 * the one that looks like the road became the tube. At the kit's numbers
 * (16 m road, R 8 m bore) the width does not change at all.
 *
 * Interpolating (phi, hw) rather than lerping the two OUTLINES point by point
 * is the other half of it. A point-wise lerp between a line and a circle is not
 * an arc at any t — for the full ring it is not even a simple curve. Every
 * intermediate section here is a real, drivable arc.
 *
 * `wall` is interpolated too (road thickness -> tubeWall) so the underside is
 * flush with the slab behind it at one end and with the tube shell at the other.
 *
 * The easing is a smoothstep, so the section's rate of change is ZERO at both
 * seams. Without it the curl starts at full rate the instant the piece begins
 * and there is a visible crease where it meets the straight.
 *
 * Outline order follows the tube profiles — the whole inner (drivable) arc,
 * then the outer shell back — so the two closing edges are the rim caps and
 * `openLips` strips them from the BVH exactly as it does on a half tube.
 *
 * @param {object} pp piece params (tubeRadius / tubeWall / halfTubeSpan)
 * @param {object} rp road cross-section params (width / thickness at t = 0)
 * @param {number} t 0 = flat road, 1 = tube
 * @param {boolean} fullRing true = wrap all the way to a closed tube; false =
 *   stop at `halfTubeSpan`, i.e. feed a half tube
 */
function buildTubeMorphProfile(pp = pieceParams, rp = roadParams, t = 1, fullRing = false) {
  const Ri = Math.max(3, pp.tubeRadius ?? 8);
  const tw = Math.max(0.15, pp.tubeWall ?? 0.6);
  const span = fullRing
    ? Math.PI * 2
    : THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.halfTubeSpan ?? 180, 60, 300));
  // Same angular resolution as the piece this feeds, so the seam vertices land
  // on each other instead of near each other.
  const N = fullRing ? 48 : Math.max(8, Math.round((48 * span) / (2 * Math.PI)));
  const W = Math.max(1, rp.width);
  const th = Math.max(0.05, rp.thickness);

  const u0 = THREE.MathUtils.clamp(t, 0, 1);
  const e = u0 * u0 * (3 - 2 * u0);
  const phi = (span / 2) * e;
  // How wide the finished piece is in plan. Past a quarter turn the arc has
  // passed its own equator, so the widest point is the equator itself (R) and
  // not the lip — which is why a 360° ring and a 180° half tube are both Ri
  // wide, and why this stays continuous as phi crosses 90°.
  const hwT = W / 2 + (Ri * Math.sin(Math.min(span / 2, Math.PI / 2)) - W / 2) * e;
  const wall = th + (tw - th) * e;
  // Below this the radius is astronomical and sin/cos underflow to the straight
  // line they are approaching anyway — so take the limit forms directly.
  const flat = phi < 1e-6;
  const R = flat ? 0 : phi < Math.PI / 2 ? hwT / Math.sin(phi) : hwT;
  const Ro = R + wall;

  const inner = [];
  const outer = [];
  for (let k = 0; k <= N; k++) {
    const u = -1 + (2 * k) / N; // -1 = left lip, +1 = right lip
    if (flat) {
      inner.push({ x: hwT * u, y: 0 });
      outer.push({ x: hwT * u, y: -wall });
    } else {
      const a = phi * u;
      // Centre at (0, R): floor touches y = 0 at the centreline, so a flat piece
      // feeds straight in — the same convention the tube profiles use.
      inner.push({ x: R * Math.sin(a), y: R * (1 - Math.cos(a)) });
      outer.push({ x: Ro * Math.sin(a), y: R - Ro * Math.cos(a) });
    }
  }

  const pts = [];
  let hw = 0;
  for (const p of inner) {
    pts.push({ x: p.x, y: p.y, zone: 3 });
    hw = Math.max(hw, Math.abs(p.x));
  }
  for (let k = N; k >= 0; k--) pts.push({ x: outer[k].x, y: outer[k].y, zone: 4 });
  flagSmoothRuns(pts);
  // A full ring closes on itself; the weld checks per frame whether the two
  // points really are coincident, so this is inert while the section is open.
  if (fullRing) { pts[0].seam = N; pts[N].seam = 0; pts[N + 1].seam = 2 * N + 1; pts[2 * N + 1].seam = N + 1; }
  return { pts, hw };
}

/**
 * TUBE REDUCER cross-section — the same bore at a different SIZE.
 *
 * Every tube in the kit was locked to one radius, and for a good reason: a
 * preset whose radius drifts from the tube beside it is a step at the seam that
 * nothing in the geometry can catch. That made a second size family impossible
 * rather than merely unwired — there was no piece that could get you from one
 * bore to another. This is that piece's section.
 *
 * It is deliberately NOT buildTubeMorphProfile with different numbers. That one
 * morphs a flat ROAD into a bore, so its arc angle opens from 0 while its radius
 * chases whatever keeps the plan width continuous. Here both ends are already
 * tubes: the angle is fixed at the full span and only the radius moves, which
 * means the section stays a true circle the whole way and the floor stays at
 * y = 0 (centre at y = Ri, the same convention buildTubeProfile uses).
 *
 * EXACT AT BOTH ENDS, which is the only thing that makes it safe: t = 0 is
 * literally the point set buildTubeProfile / buildHalfTubeProfile produce from
 * `tubeRadius`, and t = 1 is the same from `tubeRadius2`. The angular
 * resolution is the tube's own (48 steps for 360°), so both seams land vertex
 * for vertex on the pieces either side. Point count is constant in t —
 * buildSweepGeometry throws if it is not, and that throw is a build-time crash.
 *
 * Smoothstepped so the wall has no crease where it starts and stops tapering.
 *
 * @param {object} pp piece params (tubeRadius -> tubeRadius2, tubeWall, halfTubeSpan)
 * @param {object} rp unused — kept so the signature matches the other sections
 * @param {number} t 0 = tubeRadius, 1 = tubeRadius2
 * @param {boolean} fullRing true = closed tube; false = the halfTubeSpan arc
 */
function buildTubeReducerProfile(pp = pieceParams, rp = roadParams, t = 1, fullRing = true) {
  const R0 = Math.max(3, pp.tubeRadius ?? 8);
  const R1 = Math.max(3, pp.tubeRadius2 ?? R0);
  const tw = Math.max(0.15, pp.tubeWall ?? 0.6);
  const span = fullRing
    ? Math.PI * 2
    : THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.halfTubeSpan ?? 180, 60, 300));
  const N = fullRing ? 48 : Math.max(8, Math.round((48 * span) / (2 * Math.PI)));
  // A closed ring starts at the floor and wraps; an arc is centred on the floor.
  const a0 = fullRing ? -Math.PI / 2 : -Math.PI / 2 - span / 2;

  const u = THREE.MathUtils.clamp(t, 0, 1);
  const Ri = R0 + (R1 - R0) * (u * u * (3 - 2 * u));
  const Ro = Ri + tw;

  const pts = [];
  for (let k = 0; k <= N; k++) {
    const a = a0 + (span * k) / N;
    pts.push({ x: Math.cos(a) * Ri, y: Ri + Math.sin(a) * Ri, zone: 3 });
  }
  for (let k = N; k >= 0; k--) {
    const a = a0 + (span * k) / N;
    pts.push({ x: Math.cos(a) * Ro, y: Ri + Math.sin(a) * Ro, zone: 4 });
  }
  flagSmoothRuns(pts);
  // Both ends are closed rings, so pair the seam at each. See the seam block
  // in weldSmoothProfileNormals.
  if (fullRing) { pts[0].seam = N; pts[N].seam = 0; pts[N + 1].seam = 2 * N + 1; pts[2 * N + 1].seam = N + 1; }
  return { pts, hw: Ri };
}

/* ----------------------------------------------------------------------- */
/* Parallel-transport frames                                                */
/* ----------------------------------------------------------------------- */

/**
 * Compute a minimal-twist frame at each centerline point.
 * @param {THREE.Vector3[]} points
 * @param {THREE.Vector3} [up0]
 * @returns {{pos:THREE.Vector3, tangent:THREE.Vector3, up:THREE.Vector3, right:THREE.Vector3}[]}
 */
export function computeFrames(points, up0 = _up) {
  const n = points.length;
  const tangents = [];
  for (let i = 0; i < n; i++) {
    let t;
    if (i === 0) t = points[1].clone().sub(points[0]);
    else if (i === n - 1) t = points[n - 1].clone().sub(points[n - 2]);
    else t = points[i + 1].clone().sub(points[i - 1]);
    if (t.lengthSq() < 1e-12) t.set(0, 0, -1);
    tangents.push(t.normalize());
  }

  const frames = [];
  // Seed frame: project up0 perpendicular to the first tangent.
  let right = new V3().crossVectors(tangents[0], up0);
  if (right.lengthSq() < 1e-10) right = new V3().crossVectors(tangents[0], new V3(1, 0, 0));
  right.normalize();
  let up = new V3().crossVectors(right, tangents[0]).normalize();
  frames.push({ pos: points[0].clone(), tangent: tangents[0].clone(), up, right });

  const axis = new V3();
  const q = new THREE.Quaternion();
  for (let i = 1; i < n; i++) {
    const prevT = tangents[i - 1];
    const curT = tangents[i];
    let newUp;
    axis.crossVectors(prevT, curT);
    const len = axis.length();
    if (len < 1e-7) {
      newUp = frames[i - 1].up.clone();
    } else {
      axis.divideScalar(len);
      const ang = Math.acos(THREE.MathUtils.clamp(prevT.dot(curT), -1, 1));
      q.setFromAxisAngle(axis, ang);
      newUp = frames[i - 1].up.clone().applyQuaternion(q).normalize();
    }
    const r = new V3().crossVectors(curT, newUp).normalize();
    const u = new V3().crossVectors(r, curT).normalize();
    frames.push({ pos: points[i].clone(), tangent: curT.clone(), up: u, right: r });
  }
  return frames;
}

/**
 * Roll each frame about its own tangent by `rollFn(t, pp)` radians (banking,
 * barrel rolls). Frames whose roll is 0 at both ends stay connectable level.
 */
export function applyRoll(frames, rollFn, pp) {
  const F = frames.length;
  const q = new THREE.Quaternion();
  for (let i = 0; i < F; i++) {
    const t = F > 1 ? i / (F - 1) : 0;
    const ang = rollFn(t, pp);
    if (Math.abs(ang) < 1e-9) continue;
    q.setFromAxisAngle(frames[i].tangent, ang);
    frames[i].up.applyQuaternion(q).normalize();
    frames[i].right.crossVectors(frames[i].tangent, frames[i].up).normalize();
  }
}

/**
 * Snap the END frames to a piece's *analytic* tangents (exact mating).
 *
 * The minimal-twist transport derives tangents from finite differences, and the
 * ONE-SIDED difference at each endpoint is the chord of the last segment — it
 * lags the true tangent by ~half a step, so e.g. a "90°" curve's exit connector
 * only turns ~87°. That error accumulates and stops loops from closing on their
 * labelled angles. A piece can expose `endTangents(pp)` → {entry, exit} (local
 * unit vectors); we overwrite just the first/last frame's tangent with those, so
 * BOTH the end mesh rings and the connectors sit at the exact angle (seams stay
 * perfect AND compositions add up). Call BEFORE applyRoll so banking still rolls
 * about the corrected tangent. Geometry tessellation is otherwise unchanged, so
 * identical params still produce identical geometry (instancing-friendly).
 */
export function applyEndTangents(frames, et) {
  if (!frames.length || !et) return;
  if (et.entry) _setFrameTangent(frames[0], et.entry);
  if (et.exit) _setFrameTangent(frames[frames.length - 1], et.exit);
}

function _setFrameTangent(fr, t) {
  const nt = t.clone().normalize();
  // Re-orthonormalise with the frame's existing up as the reference (matches
  // computeFrames' convention: right = tangent × up, up = right × tangent).
  let right = new V3().crossVectors(nt, fr.up);
  if (right.lengthSq() < 1e-10) right = new V3().crossVectors(nt, new V3(1, 0, 0));
  right.normalize();
  const up = new V3().crossVectors(right, nt).normalize();
  fr.tangent.copy(nt);
  fr.right.copy(right);
  fr.up.copy(up);
}

/* ----------------------------------------------------------------------- */
/* Sweep mesh                                                               */
/* ----------------------------------------------------------------------- */

/**
 * Sweep the shared profile along the given frames into a BufferGeometry.
 * Strips are emitted per profile-edge with un-shared vertices so each face keeps
 * crisp slab edges and a constant `aZone`. Attributes: position, normal, uv
 * (x = meters along path, y = meters across developed profile), aLateral
 * (x / halfWidth, for centre/edge lines), aZone (0 side, 1 deck, 2 rail).
 */
/**
 * Signed curvature (1/m) at each frame. Positive = turning RIGHT, matching
 * pieceParams.curveDir, so the shader can tell which side of the road is the
 * inside of the corner.
 *
 * Central difference on the tangent, projected onto `up`: the component of the
 * turn that is actually a corner, as opposed to a piece that climbs or rolls.
 */
function frameCurvature(frames) {
  const F = frames.length;
  const out = new Float32Array(F);
  for (let i = 0; i < F; i++) {
    const a = frames[Math.max(0, i - 1)];
    const b = frames[Math.min(F - 1, i + 1)];
    const ds = a.pos.distanceTo(b.pos);
    if (ds < 1e-6) continue;
    // cross(tA, tB)·up is NEGATIVE for a right turn, hence the minus.
    const s = Math.max(-1, Math.min(1, -_kx.crossVectors(a.tangent, b.tangent).dot(a.up)));
    out[i] = Math.asin(s) / ds;
  }
  return out;
}
const _kx = new V3();

/**
 * Per-piece values every road geometry must carry, stamped in ONE place.
 *
 * Not three copies, because these are attributes on a material whose pieces are
 * later MERGED: a builder that forgets one makes mergeGeometries return `null`
 * and the entire merged track vanishes in drive mode with no error whatsoever.
 * That failure has already happened three times in this codebase. Adding a
 * per-piece value here reaches every builder at once.
 *
 * `aCurve` is signed curvature FADED TO ZERO at both ends of the piece. Pieces
 * do not know their neighbours, so a raw value would step from 0 to 0.038 at
 * the seam where a straight meets a curve and draw a hard line across the road.
 * Faded, both sides of every seam agree at zero, and the effects it drives
 * (drift marks, kerbs, the racing line) concentrate mid-corner where they
 * belong. The fade is derived from the geometry's OWN uv.x range, so it needs
 * no knowledge of vertex ordering and works for every builder.
 */
/**
 * Span of the per-piece noise phase, in metres.
 *
 * Large enough to decorrelate any surface frequency the deck uses: the streak
 * field's period along the road is `streakStraight / streakScale`, about 54 m
 * at the defaults, so a phase drawn from a 1 km span puts neighbouring pieces
 * essentially anywhere in the pattern.
 */
const ALONG_OFFSET_SPAN = 1000;

/**
 * PER-PIECE NOISE PHASE. Without it every piece of a given length is painted
 * with a byte-identical patch of asphalt.
 *
 * buildSweepGeometry starts `along` (uv.x) at 0 on every piece, and uv.x is
 * what feeds the deck's noise, the drift-mark wander and the puddle field. So a
 * track built from 22 m straights repeats the same tonal blotches, the same
 * skid wander and the same puddles every 22 m, with a hard break at each seam.
 * Visible immediately on three straights in a row.
 *
 * WHY A HASH OF THE WORLD POSITION AND NOT CUMULATIVE ARC LENGTH. Arc length
 * down the chain is the better answer on paper — it removes the repeat AND the
 * seam discontinuity, because `along` becomes continuous over the whole track.
 * It is also unaffordable: `rebuildAll({reuse})` skips pieces whose inputs have
 * not changed, and a running total makes every piece depend on every piece
 * before it. Inserting one piece at the head would then remesh the entire
 * chain, and a straight costs ~2.7 ms to build (tools/deckOnlyTest.mjs), so a
 * 100-piece track would hitch for a quarter of a second on every edit.
 *
 * A hash of the piece's own world position depends on nothing else, so it
 * survives the reuse fast path untouched. It kills the repeat, which is the
 * visible artefact. It does NOT remove the seam discontinuity — but that
 * discontinuity is already there today (`along` jumps from the piece length
 * back to 0), so this makes it no worse, and raising `streakStraight` shrinks
 * it for free by making the field vary more slowly along the road.
 *
 * Quantised to a centimetre so that a piece re-placed at a numerically
 * near-identical spot keeps the same phase rather than shimmering to a new one.
 */
function stampAlongOffset(geo, world) {
  if (!geo?.getAttribute) return geo;
  const pos = geo.getAttribute("position");
  if (!pos) return geo;
  const e = world.elements;
  const q = (v) => Math.round(v * 100);
  const h = Math.sin(q(e[12]) * 12.9898 + q(e[13]) * 78.233 + q(e[14]) * 37.719) * 43758.5453;
  const offset = (h - Math.floor(h)) * ALONG_OFFSET_SPAN;
  geo.setAttribute(
    "aAlongOffset",
    new THREE.Float32BufferAttribute(new Float32Array(pos.count).fill(offset), 1),
  );
  return geo;
}

function stampPieceAttributes(geo, { plain = 1, curvature = 0 } = {}) {
  const vcount = geo.getAttribute("position").count;
  geo.setAttribute("aPlain", new THREE.Float32BufferAttribute(new Float32Array(vcount).fill(plain), 1));

  const curve = new Float32Array(vcount);
  const uv = geo.getAttribute("uv");
  if (curvature !== 0 && uv) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < vcount; i++) {
      const x = uv.getX(i);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    const span = hi - lo;
    const FADE = 0.18; // fraction of the piece spent easing in and out
    for (let i = 0; i < vcount; i++) {
      const t = span > 1e-6 ? (uv.getX(i) - lo) / span : 0.5;
      const e = Math.min(t, 1 - t) / FADE;
      const w = e >= 1 ? 1 : e * e * (3 - 2 * e); // smoothstep
      curve[i] = curvature * w;
    }
  }
  geo.setAttribute("aCurve", new THREE.Float32BufferAttribute(curve, 1));
  return geo;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.plain] suppress centre/edge lines (platforms)
 * @param {(t:number, i:number) => {pts:Array}} [opts.profileAt] MORPH the section
 *   along the piece. Called once per frame with t = 0..1; must return the same
 *   point COUNT every time (only the x/y move). This is how a bank-in grows its
 *   curl from a flat entry to a fully curled exit in step with `bankInRoll`, so
 *   both of its seams match whatever they mate with. `profileData` stays the
 *   reference section — zones, uv.y and aLateral all come from it, so the deck
 *   markings do not swim while the shape moves under them.
 */
export function buildSweepGeometry(frames, profileData = buildProfile(), opts = {}) {
  const { pts: profile, hw } = profileData;
  const plain = opts.plain ? 1 : 0; // 1 = suppress centre/edge lines (platforms)
  const M = profile.length;
  const F = frames.length;

  // Per-frame sections, or null for the ordinary constant-section sweep.
  let morph = null;
  if (opts.profileAt) {
    morph = new Array(F);
    for (let i = 0; i < F; i++) {
      const pd = opts.profileAt(F > 1 ? i / (F - 1) : 0, i);
      const pts = pd?.pts;
      if (!pts || pts.length !== M) {
        throw new Error(
          `profileAt must keep the point count (${M}); frame ${i} returned ${pts?.length}`,
        );
      }
      morph[i] = pts;
    }
  }

  // Cumulative distance along the path (for uv.x).
  const along = new Float32Array(F);
  for (let i = 1; i < F; i++) {
    along[i] = along[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);
  }

  // How hard this piece corners, as one number. The kit's turns are
  // constant-radius so the mean IS the curvature; averaging only matters for
  // pieces that ease in and out, where it gives the honest average rather than
  // whatever the first frame happened to be.
  const kappa = frameCurvature(frames);
  let meanCurvature = 0;
  for (let i = 0; i < F; i++) meanCurvature += kappa[i];
  meanCurvature /= Math.max(1, F);

  // Cumulative developed distance across the closed profile (for uv.y).
  const dev = new Float32Array(M + 1);
  for (let k = 0; k < M; k++) {
    const a = profile[k];
    const b = profile[(k + 1) % M];
    dev[k + 1] = dev[k] + Math.hypot(b.x - a.x, b.y - a.y);
  }

  const positions = [];
  const uvs = [];
  const lateral = [];
  const zone = [];
  const indices = [];

  const pa = new V3();
  const pb = new V3();
  let vbase = 0;

  for (let k = 0; k < M; k++) {
    const a = profile[k];
    const b = profile[(k + 1) % M];
    // An edge keeps its zone only when both endpoints agree (mixed edges are
    // structural sides → 0). Zones: 0 side, 1 deck, 2 rail, 3 tube inner,
    // 4 tube outer — the material colors each band.
    const edgeZone = a.zone === b.zone ? a.zone : 0;
    const devA = dev[k];
    const devB = dev[k + 1];

    for (let i = 0; i < F; i++) {
      const fr = frames[i];
      // Shape comes from this frame's section when morphing; zone / uv / lateral
      // below always come from the reference one.
      const ai = morph ? morph[i][k] : a;
      const bi = morph ? morph[i][(k + 1) % M] : b;
      pa.copy(fr.pos).addScaledVector(fr.right, ai.x).addScaledVector(fr.up, ai.y);
      pb.copy(fr.pos).addScaledVector(fr.right, bi.x).addScaledVector(fr.up, bi.y);
      positions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      uvs.push(along[i], devA, along[i], devB);
      lateral.push(a.x / hw, b.x / hw);
      zone.push(edgeZone, edgeZone);
    }

    for (let i = 0; i < F - 1; i++) {
      const r0 = vbase + i * 2; // pa_i
      const i0 = r0;
      const i1 = r0 + 1; // pb_i
      const i2 = r0 + 2; // pa_{i+1}
      const i3 = r0 + 3; // pb_{i+1}
      indices.push(i0, i1, i3, i0, i3, i2);
    }
    vbase += F * 2;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(lateral, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zone, 1));
  // Per-piece constants — see stampPieceAttributes for why they live there.
  stampPieceAttributes(geo, { plain, curvature: meanCurvature });
  geo.setIndex(indices);
  geo.computeVertexNormals();
  weldSmoothProfileNormals(geo, profile, F);
  geo.computeBoundingSphere();
  return geo;
}

const _capPt = new V3();

/**
 * Lid on an OPEN sweep end — the slab is a hollow prism (deck / sides /
 * underside) with no end faces. FrontSide then looks into the cavity.
 *
 * Visual only. Callers clone collision first so the wheels still leave the
 * lip rather than hitting a wall. Only the un-mated sockets should pass
 * true: a cap on a joined seam z-fights the neighbour and costs tris for
 * nothing. Tubes have their own wall-cavity caps; this is the road plate.
 *
 * @param {THREE.BufferGeometry} geo
 * @param {object[]} frames
 * @param {{ capEntry?: boolean, capExit?: boolean, entryPts: object[], exitPts: object[], plain?: number }} opts
 */
function appendRoadEndCaps(geo, frames, opts) {
  const capEntry = !!opts.capEntry;
  const capExit = !!opts.capExit;
  if (!capEntry && !capExit) return geo;
  if (frames.length < 2) return geo;

  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const lat = geo.getAttribute("aLateral");
  const zn = geo.getAttribute("aZone");
  const plainAttr = geo.getAttribute("aPlain");
  const curve = geo.getAttribute("aCurve");
  const nrm = geo.getAttribute("normal");
  const idx = geo.getIndex();
  if (!pos || !uv || !lat || !zn || !plainAttr || !curve || !nrm || !idx) return geo;

  const positions = Array.from(pos.array);
  const uvs = Array.from(uv.array);
  const laterals = Array.from(lat.array);
  const zones = Array.from(zn.array);
  const plains = Array.from(plainAttr.array);
  const curves = Array.from(curve.array);
  const normals = Array.from(nrm.array);
  const indices = Array.from(idx.array);
  const plain = opts.plain ?? plains[0] ?? 0;

  let alongN = 0;
  for (let i = 1; i < frames.length; i++) {
    alongN += frames[i].pos.distanceTo(frames[i - 1].pos);
  }

  const emitCap = (fr, alongX, nx, ny, nz, pts, flip) => {
    const M = pts?.length ?? 0;
    if (M < 3) return;
    // EAR CLIP, not a fan. A banked section is a U (deck y = curl·(x/hw)²) and
    // is not star-shaped about any vertex — a fan sprays triangles across the
    // valley, which FrontSide reads as holes and inverted lids. Same reason the
    // guardrail caps stopped fanning (see modularRoadRail.js).
    let contour = pts.map((p) => new THREE.Vector2(p.x, p.y));
    let ring = pts;
    if (THREE.ShapeUtils.isClockWise(contour)) {
      contour = contour.slice().reverse();
      ring = pts.slice().reverse();
    }
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!tris.length) return;
    const base = positions.length / 3;
    for (const p of ring) {
      _capPt.copy(fr.pos).addScaledVector(fr.right, p.x).addScaledVector(fr.up, p.y);
      positions.push(_capPt.x, _capPt.y, _capPt.z);
      uvs.push(alongX, 0);
      laterals.push(0);
      zones.push(0); // cut face — side/underside paint, not deck asphalt
      plains.push(plain);
      curves.push(0);
      normals.push(nx, ny, nz);
    }
    for (const [a, b, c] of tris) {
      if (flip) indices.push(base + a, base + b, base + c);
      else indices.push(base + a, base + c, base + b);
    }
  };

  const f0 = frames[0];
  const fN = frames[frames.length - 1];
  // Entry faces backward (out of the prism). Profile is clockwise looking
  // along travel, so the fan has to flip to be CCW from outside.
  if (capEntry) {
    emitCap(f0, 0, -f0.tangent.x, -f0.tangent.y, -f0.tangent.z, opts.entryPts, true);
  }
  if (capExit) {
    emitCap(fN, alongN, fN.tangent.x, fN.tangent.y, fN.tangent.z, opts.exitPts, false);
  }

  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(laterals, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zones, 1));
  geo.setAttribute("aPlain", new THREE.Float32BufferAttribute(plains, 1));
  geo.setAttribute("aCurve", new THREE.Float32BufferAttribute(curves, 1));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Inner / outer wall rings, paired at matching angles.
 *
 * `buildTubeProfile` walks the inner arc then the outer in reverse. A CLOSED
 * ring repeats the seam point on both loops — drop those duplicates and wrap.
 * An OPEN wall (half tube, half-pipe) has two distinct lips: keep every point
 * and do not wrap, or the last quad chords across the sky between the rims.
 */
function tubeWallRings(pts, closed) {
  const innerAll = [];
  const outerAll = [];
  for (const p of pts) {
    if (p.zone === 3) innerAll.push(p);
    else if (p.zone === 4) outerAll.push(p);
  }
  if (outerAll.length !== innerAll.length) return null;
  if (closed) {
    if (innerAll.length < 9) return null;
    const inner = innerAll.slice(0, -1);
    const n = inner.length;
    const outer = new Array(n);
    outer[0] = outerAll[0];
    for (let j = 1; j < n; j++) outer[n - j] = outerAll[j];
    return { inner, outer };
  }
  if (innerAll.length < 3) return null;
  const n = innerAll.length;
  const outer = new Array(n);
  for (let k = 0; k < n; k++) outer[k] = outerAll[n - 1 - k];
  return { inner: innerAll, outer };
}

/**
 * Is this section a CLOSED ring — a bore with a mouth that needs shutting?
 *
 * `tubeWallRings` cannot answer this on its own: the closed path drops what it
 * assumes is a duplicated seam point, which is true of a full tube and false of
 * everything else. buildTubeMorphProfile in particular emits zones 3/4 at EVERY
 * value of t, so at t = 0 a flat road plate looks exactly like an annulus to it
 * — wrap that and you weld a ring across the road.
 *
 * The honest test is geometric: the drivable arc is closed iff its last point
 * lands back on its first. A full tube wraps −π…+π; a morph part-way in, a half
 * tube, and a flat plate all stop short.
 */
function sectionIsClosedRing(profileData) {
  const pts = profileData?.pts;
  if (!pts) return false;
  const inner = pts.filter((p) => p.zone === 3);
  if (inner.length < 9) return false;
  const a = inner[0], b = inner[inner.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
}

/**
 * Is this section an OPEN thick wall — a U whose mouth still shows the cavity?
 *
 * A half tube's lips already sweep along the length, so you see wall thickness
 * from the side. Looking AT either end you still look into the 0.6 m gap
 * between bore and shell, the same hollow a full tube has. This is that shape:
 * inner and outer arcs that do not meet, with real height (a U, not a plate).
 *
 * The height check is what keeps a morph's FLAT-ROAD end uncapped. At t = 0
 * every inner point sits at y = 0; fill that and you plate the slab end, which
 * is the road's job to leave open so it seams onto a straight.
 */
function sectionIsOpenWall(profileData) {
  if (sectionIsClosedRing(profileData)) return false;
  const pts = profileData?.pts;
  if (!pts) return false;
  const inner = pts.filter((p) => p.zone === 3);
  const outer = pts.filter((p) => p.zone === 4);
  if (inner.length < 3 || outer.length !== inner.length) return false;
  let minY = Infinity, maxY = -Infinity;
  for (const p of inner) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return maxY - minY > 1e-3;
}

function sectionNeedsEndCap(profileData) {
  return sectionIsClosedRing(profileData) || sectionIsOpenWall(profileData);
}

/**
 * Whether a piece's entry or exit is a thick-wall mouth that wants a ring.
 * The builder uses this to drop the ring when that socket is already occupied
 * by another wall mouth (tube-to-tube). A road neighbour does not fill the
 * cavity, so the ring stays.
 *
 * @param {string} id
 * @param {"entry"|"exit"} end
 * @param {object} [pp]
 * @param {object} [rp]
 */
export function pieceEndTakesTubeCap(id, end, pp = pieceParams, rp = roadParams) {
  const def = PIECE_BY_ID.get(id);
  if (!def?.tubeEndCaps || def.geometry) return false;
  const pieceWidth = def.width ? def.width(pp) : rp.width;
  const rpForProfile = pieceWidth !== rp.width ? { ...rp, width: pieceWidth } : rp;
  const section = def.profileAt
    ? def.profileAt(end === "exit" ? 1 : 0, pp, rpForProfile)
    : def.profile
      ? def.profile(pp, rpForProfile)
      : null;
  return sectionNeedsEndCap(section);
}

/**
 * Close the hollow wall cavity at a sweep's mouths.
 *
 * The sweep is an extruded thick wall: inner surface + outer surface. Length
 * ends stay open, so you look into the cavity. These strips fill that gap at
 * the first and last frames — both faces, so FrontSide shows the lip from
 * outside and from the bore. A closed tube gets a ring; a half tube gets the
 * same ring with the open arc left out, so the sky between the lips stays sky.
 *
 * Visual only. Callers must keep the uncapped sweep as `deckCollision` so the
 * caps are not a driveable shelf across the mouth. Same idea as half-tube
 * `openLips`. Occupancy is the caller's job: pass `lids.capEntry` / `capExit`
 * false to drop a ring on a mouth that already nests against another wall.
 *
 * Mutates `geo` in place (appends verts / indices, leaves existing normals).
 *
 * @param {THREE.BufferGeometry} geo
 * @param {object[]} frames
 * @param {object} entrySection section at the first frame, or null to leave open
 * @param {object} exitSection  section at the last frame, or null to leave open
 * @param {{ capEntry?: boolean, capExit?: boolean }} [lids]
 */
function appendTubeEndCaps(geo, frames, entrySection, exitSection, lids = {}) {
  // Section still decides WHETHER this end is a wall. Occupancy (lids) decides
  // whether to actually emit the ring: omit the flags (kit / labs / thumbnails)
  // and a free piece keeps both; pass false to suppress a mated mouth.
  const capEntry = sectionNeedsEndCap(entrySection) && lids.capEntry !== false;
  const capExit = sectionNeedsEndCap(exitSection) && lids.capExit !== false;
  if ((!capEntry && !capExit) || frames.length < 2) return geo;

  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  const lat = geo.getAttribute("aLateral");
  const zn = geo.getAttribute("aZone");
  const plain = geo.getAttribute("aPlain");
  const curve = geo.getAttribute("aCurve");
  const nrm = geo.getAttribute("normal");
  const idx = geo.getIndex();
  if (!pos || !uv || !lat || !zn || !plain || !curve || !nrm || !idx) return geo;

  const positions = Array.from(pos.array);
  const uvs = Array.from(uv.array);
  const laterals = Array.from(lat.array);
  const zones = Array.from(zn.array);
  const plains = Array.from(plain.array);
  const curves = Array.from(curve.array);
  const normals = Array.from(nrm.array);
  const indices = Array.from(idx.array);

  let alongN = 0;
  for (let i = 1; i < frames.length; i++) {
    alongN += frames[i].pos.distanceTo(frames[i - 1].pos);
  }

  const emitCap = (fr, alongX, ox, oy, oz, section) => {
    // PER-END RINGS. This used to take one reference section and stamp it on
    // both mouths, which is right only while the two ends are the same shape.
    // A reducer's ends are different radii and an entry's ends are a road and a
    // bore, so a shared ring fits one of them and is wrong on the other.
    const closed = sectionIsClosedRing(section);
    const rings = tubeWallRings(section?.pts, closed);
    if (!rings) return;
    const { inner, outer } = rings;
    const n = inner.length;
    const pushPt = (p, nx, ny, nz) => {
      _capPt.copy(fr.pos).addScaledVector(fr.right, p.x).addScaledVector(fr.up, p.y);
      positions.push(_capPt.x, _capPt.y, _capPt.z);
      uvs.push(alongX, 0);
      laterals.push(0);
      zones.push(4);
      plains.push(1);
      curves.push(0);
      normals.push(nx, ny, nz);
    };
    const emitFace = (nx, ny, nz, flip) => {
      const base = positions.length / 3;
      for (let k = 0; k < n; k++) pushPt(inner[k], nx, ny, nz);
      for (let k = 0; k < n; k++) pushPt(outer[k], nx, ny, nz);
      // A closed ring wraps the last quad back to 0. An open U must not —
      // that wrap is a chord across the sky between the lips.
      const segs = closed ? n : n - 1;
      for (let k = 0; k < segs; k++) {
        const k1 = closed ? (k + 1) % n : k + 1;
        const i0 = base + k;
        const i1 = base + k1;
        const o0 = base + n + k;
        const o1 = base + n + k1;
        if (flip) indices.push(i0, o1, o0, i0, i1, o1);
        else indices.push(i0, o0, o1, i0, o1, i1);
      }
    };
    emitFace(ox, oy, oz, false);
    emitFace(-ox, -oy, -oz, true);
  };

  const f0 = frames[0];
  const fN = frames[frames.length - 1];
  // Entry faces backward (travel goes into the piece); exit faces forward. Each
  // end is capped only if ITS OWN section is a thick wall (closed ring OR open
  // U) — so a tube caps both, a half tube caps both, an entry caps only the
  // mouth it opens into, and an exit caps only the one it comes out of.
  if (capEntry) emitCap(f0, 0, -f0.tangent.x, -f0.tangent.y, -f0.tangent.z, entrySection);
  if (capExit) emitCap(fN, alongN, fN.tangent.x, fN.tangent.y, fN.tangent.z, exitSection);

  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(laterals, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zones, 1));
  geo.setAttribute("aPlain", new THREE.Float32BufferAttribute(plains, 1));
  geo.setAttribute("aCurve", new THREE.Float32BufferAttribute(curves, 1));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Average normals across profile points flagged `smooth`.
 *
 * THE SWEEP IS BUILT FROM UN-SHARED BANDS ON PURPOSE — one strip per profile
 * EDGE, its own vertices, so each face keeps a constant `aZone` and the slab
 * corners stay crisp. The cost is that `computeVertexNormals` can only ever
 * produce FLAT shading across the section: it smooths along the sweep (those
 * vertices really are shared) but every profile point is a hard crease, because
 * the two bands meeting there do not share a single vertex.
 *
 * That is invisible on the old 8-point section — every one of its corners is
 * meant to be sharp. It is fatal the moment a section CURVES: buildBankProfile's
 * 12-segment deck would come out as twelve flat facets with eleven visible
 * creases, which reads WORSE than the flat plate it replaces. Adding polygons
 * without this makes the piece look more low-poly, not less.
 *
 * So: for each flagged point, find the two vertices sitting on it — band k-1's
 * far column and band k's near column — and give both their average. The vertex
 * layout is fully deterministic (band k starts at k·F·2; frame i within it is at
 * +i·2 near and +i·2+1 far), so this is index arithmetic — no spatial hashing,
 * no epsilon to get wrong, and no cost to pieces that flag nothing.
 */
function weldSmoothProfileNormals(geo, profile, F) {
  const M = profile.length;
  let any = false;
  for (let k = 0; k < M; k++) if (profile[k].smooth) { any = true; break; }
  if (!any) return;

  const nrm = geo.getAttribute("normal");
  const posAttr = geo.getAttribute("position");
  for (let k = 0; k < M; k++) {
    if (!profile[k].smooth) continue;
    // Point k is the FAR end of band k-1 and the NEAR end of band k.
    const prevBase = ((k - 1 + M) % M) * F * 2;
    const curBase = k * F * 2;
    for (let i = 0; i < F; i++) {
      const va = prevBase + i * 2 + 1;
      const vb = curBase + i * 2;
      const x = nrm.getX(va) + nrm.getX(vb);
      const y = nrm.getY(va) + nrm.getY(vb);
      const z = nrm.getZ(va) + nrm.getZ(vb);
      const l = Math.hypot(x, y, z) || 1;
      nrm.setXYZ(va, x / l, y / l, z / l);
      nrm.setXYZ(vb, x / l, y / l, z / l);
    }
  }

  /*
   * THE SEAM — two points at the SAME PLACE that are not neighbours.
   *
   * A closed bore's outline cannot be a topological circle: it has to run the
   * inner surface, jump to the outer wall and walk back, so the section starts
   * and ends at the same angle with the whole outer arc in between. Those two
   * coincident points are adjacent in SPACE and 96 indices apart in the OUTLINE,
   * so the pass above can never pair them — it only ever looks at k−1 and k.
   *
   * Left alone that is one hard crease running the length of the tube, and on
   * the full tube it lands at the very bottom: straight down the middle of the
   * floor the car drives on. `seam` names the partner index so the two get the
   * same average, which closes the ring properly.
   */
  for (let k = 0; k < M; k++) {
    const j = profile[k].seam;
    if (j === undefined || j < k) continue; // pair once, from the lower index
    const aBase = k * F * 2;                    // band k — point k is its NEAR end
    const bBase = ((j - 1 + M) % M) * F * 2;    // band j−1 — point j is its FAR end
    for (let i = 0; i < F; i++) {
      /*
       * ONLY WHERE THE TWO POINTS REALLY ARE COINCIDENT, checked per frame.
       *
       * A MORPHING section closes only at one end of the piece: a tube entry is
       * a full ring at the bore and a flat plate at the road, so its seam points
       * sit on top of each other at the last station and a road-width apart at
       * the first. The flags come from one reference outline and cannot know
       * that, so the geometry is asked instead — welding normals across a gap
       * would smear the road's two edges into each other.
       */
      const pa = aBase + i * 2, pb = bBase + i * 2 + 1;
      const dx = posAttr.getX(pa) - posAttr.getX(pb);
      const dy = posAttr.getY(pa) - posAttr.getY(pb);
      const dz = posAttr.getZ(pa) - posAttr.getZ(pb);
      if (dx * dx + dy * dy + dz * dz > 1e-8) continue;
      // The outline LEAVES the seam at point k and ARRIVES at point j, so the
      // two columns lying on the shared surface are k's near and (j−1)'s far.
      // Using band j here instead of j−1 averages the floor against the radial
      // web on the far side of the seam: measured 43° of error at the tube's
      // bottom, in the middle of the drivable floor.
      const va = aBase + i * 2;
      const vb = bBase + i * 2 + 1;
      const x = nrm.getX(va) + nrm.getX(vb);
      const y = nrm.getY(va) + nrm.getY(vb);
      const z = nrm.getZ(va) + nrm.getZ(vb);
      const l = Math.hypot(x, y, z) || 1;
      nrm.setXYZ(va, x / l, y / l, z / l);
      nrm.setXYZ(vb, x / l, y / l, z / l);
    }
  }
  nrm.needsUpdate = true;
}

/**
 * Collision copy of an OPEN-LIPPED swept piece with the rim caps deleted.
 *
 * WHY THIS EXISTS — the half tube would not let the car get air, measured by
 * tools/halfTubeAirRepro.mjs (analytic arc) against
 * tools/halfTubeAirMeshRepro.mjs (this kit's real mesh). Same car, same physics:
 *
 *     35 m/s straight at the wall     analytic arc  32 m     real piece  9.7 m
 *     35 m/s, nose 60° off axis       analytic arc  41 m     real piece  9.1 m
 *
 * 9.7 m is the lip (8 m) plus the car's own length stood on end. The car climbs
 * the wall perfectly, reaches the rim at 28 m/s, and in ONE 16 ms tick drops to
 * 2.4 m/s and then hangs there — "the maximum it does is be at the edges".
 *
 * THE CAUSE IS NOT THE PHYSICS, IT IS THIS PIECE'S OWN GEOMETRY. buildSweepGeometry
 * closes the profile outline, so the two edges that join the inner arc to the
 * outer arc are swept too. On the full tube those land at the floor seam, buried
 * under the bore where nothing can touch them. On the HALF tube they land at the
 * lips — and because the wall thickness runs radially, at a 180° span that is a
 * flat 0.6 m HORIZONTAL LEDGE at exactly rim height, running the whole length of
 * the piece. It goes into the deck BVH with everything else, the wheel probes
 * cannot tell it from road, and a car leaving the wall vertically at 28 m/s puts
 * its wheels onto a horizontal shelf whose normal has just flipped 90°. The tyre
 * model scrubs the entire climb away against it (~170 g in one tick) and the car
 * stays "grounded" on the rim instead of flying.
 *
 * Measured with only these caps removed from the BVH (the outer shell kept, so a
 * car can still land on the OUTSIDE of a tube): 9.7 m → 49.7 m of air.
 *
 * Zone 0 is the exact test. buildSweepGeometry stamps a band with its endpoints'
 * shared zone and falls back to 0 when they disagree, and a tube profile only
 * ever uses zones 3 (bore) and 4 (outer shell) — so on these pieces the zone-0
 * bands ARE the rim caps and nothing else. They still RENDER; they just stop
 * being a driving surface.
 *
 * WHAT THIS GIVES UP, deliberately: a vertical probe onto the 0.6 m rim strip
 * now finds nothing until the outer shell ~2 m below, so the rim reads as a
 * narrow slot rather than a ledge. That strip is a decoration 8 m up with a
 * sheer drop on the far side — the only thing that ever arrives there is a car
 * leaving the pipe, which is the exact case this is unblocking. It is also
 * narrower than the car's track, so it can never swallow more than one wheel.
 * The bore itself is untouched: 159 vertical probes across the valley return the
 * identical surface before and after (tools/halfTubeTest.mjs).
 *
 * Position-only and re-indexed, because RoadBvh.bakeFromMeshes reads nothing
 * else.
 *
 * @returns {THREE.BufferGeometry|null} null when there is nothing to strip, which
 *   means "just bake the visible mesh" to every caller.
 */
export function buildOpenLipCollision(geometry) {
  const zone = geometry?.getAttribute("aZone");
  const pos = geometry?.getAttribute("position");
  const idx = geometry?.getIndex();
  if (!zone || !pos || !idx) return null;

  const remap = new Int32Array(pos.count).fill(-1);
  const positions = [];
  const indices = [];
  const push = (v) => {
    if (remap[v] < 0) {
      remap[v] = positions.length / 3;
      positions.push(pos.getX(v), pos.getY(v), pos.getZ(v));
    }
    return remap[v];
  };

  let dropped = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (zone.getX(a) === 0 && zone.getX(b) === 0 && zone.getX(c) === 0) {
      dropped++;
      continue;
    }
    indices.push(push(a), push(b), push(c));
  }
  if (!dropped) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

/* ----------------------------------------------------------------------- */
/* Holed deck (straight slab with a circular hole punched through it)       */
/* ----------------------------------------------------------------------- */

/**
 * Straight deck with a big circular hole through the middle — the sweep can't
 * express holes (it always emits a continuous strip), so this piece builds its
 * slab directly in piece-local space (origin → −Z, deck top at y = 0).
 *
 * Physics needs NOTHING special: the deck BVH only contains the triangles that
 * exist, so a wheel probing over the hole finds no ground and the car simply
 * falls through — same rule as the gap spacer, but inside one piece.
 *
 * Triangulation: walk the rectangle perimeter CCW (corners included, so the
 * outer edges stay perfectly straight and seam cleanly with neighbours), pair
 * each border point with the point on the hole circle at the same angle from
 * the hole centre, and band-quad between the two rings. Same attributes as
 * buildSweepGeometry (uv / aLateral / aZone / aPlain) so the road material
 * works unchanged. Every quad gets unique vertices → crisp flat shading.
 */
export function buildHoledDeckGeometry(pp = pieceParams, rp = roadParams) {
  const L = Math.max(8, pp.holedLength ?? 32);
  const hw = Math.max(3, (pp.holedWidth ?? rp.width) / 2);
  const t = Math.max(0.05, rp.thickness);
  // Keep at least a 1.2 m ledge on the sides and 2 m of deck at the ends.
  const r = THREE.MathUtils.clamp(pp.holeRadius ?? 5, 1, Math.min(hw - 1.2, L / 2 - 2));
  const cz = -L / 2; // hole centre (piece-local z)

  // Border points, CCW in the (u = x, v = z − cz) plane. Each side includes its
  // start corner and excludes its end corner, so corners appear exactly once.
  const border = [];
  const push = (u0, v0, u1, v1, n) => {
    for (let i = 0; i < n; i++) {
      const s = i / n;
      border.push([u0 + (u1 - u0) * s, v0 + (v1 - v0) * s]);
    }
  };
  const nSide = Math.max(8, Math.ceil(L / 2));
  const nEnd = Math.max(6, Math.ceil(hw));
  push(hw, -L / 2, hw, L / 2, nSide); // right side
  push(hw, L / 2, -hw, L / 2, nEnd); // far end
  push(-hw, L / 2, -hw, -L / 2, nSide); // left side
  push(-hw, -L / 2, hw, -L / 2, nEnd); // near end
  const M = border.length;

  // Hole-circle point at the same angle as each border point.
  const circle = border.map(([u, v]) => {
    const a = Math.atan2(v, u);
    return [Math.cos(a) * r, Math.sin(a) * r];
  });

  const positions = [];
  const uvs = [];
  const lateral = [];
  const zone = [];
  const indices = [];

  // One quad, unique vertices. p* = [x, y, z]; zone constant per quad.
  const quad = (pa, pb, pc, pd, zn) => {
    const base = positions.length / 3;
    for (const p of [pa, pb, pc, pd]) {
      positions.push(p[0], p[1], p[2]);
      uvs.push(-p[2], p[0]); // uv.x = metres along path, uv.y = across
      lateral.push(p[0] / hw);
      zone.push(zn);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const P = (uv2, y) => [uv2[0], y, cz + uv2[1]]; // (u,v) plane → piece-local

  for (let i = 0; i < M; i++) {
    const j = (i + 1) % M;
    const Bi = border[i], Bj = border[j];
    const Ci = circle[i], Cj = circle[j];
    // Top ring band (deck, +Y): CCW in (u,v) seen from above = +Y normal.
    quad(P(Ci, 0), P(Cj, 0), P(Bj, 0), P(Bi, 0), 1);
    // Bottom ring band (underside, −Y): reversed winding.
    quad(P(Bi, -t), P(Bj, -t), P(Cj, -t), P(Ci, -t), 0);
    // Hole wall (inner cylinder).
    quad(P(Ci, -t), P(Cj, -t), P(Cj, 0), P(Ci, 0), 0);
    // Outer perimeter wall.
    quad(P(Bi, 0), P(Bj, 0), P(Bj, -t), P(Bi, -t), 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(lateral, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zone, 1));
  stampPieceAttributes(geo, { plain: 1 });
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ----------------------------------------------------------------------- */
/* Dual boards (two planks, void between — fall through the gap or a side)  */
/* ----------------------------------------------------------------------- */

/**
 * Two close parallel planks you straddle like a bridge: left wheels on one,
 * right on the other, nothing under the belly. Authored as two closed boxes
 * in piece-local space (origin → −Z, deck top at y = 0) because a sweep cannot
 * split the deck.
 *
 * The gap is narrower than the car's track so both boards are in play at once;
 * each plank is too narrow to hold the whole car, so a drift drops a side
 * into the void or off an outer edge. The BVH only contains the planks.
 */
export function buildDualDeckGeometry(pp = pieceParams, rp = roadParams) {
  const L = Math.max(8, pp.dualLength ?? 32);
  const hw = Math.max(1.2, (pp.dualWidth ?? 4.4) / 2);
  const t = Math.max(0.05, rp.thickness);
  const minBoard = 0.7; // wider than a tyre, narrower than the car
  const gap = THREE.MathUtils.clamp(
    pp.dualGap ?? 0.9,
    0.35,
    Math.max(0.35, 2 * hw - 2 * minBoard),
  );
  const inner = gap / 2;

  const positions = [];
  const uvs = [];
  const lateral = [];
  const zone = [];
  const indices = [];
  const quad = (pa, pb, pc, pd, zn) => {
    const base = positions.length / 3;
    for (const p of [pa, pb, pc, pd]) {
      positions.push(p[0], p[1], p[2]);
      uvs.push(-p[2], p[0]);
      lateral.push(p[0] / hw);
      zone.push(zn);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const slab = (x0, x1, z0, z1, y, up, zn) => {
    const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
    if (up) quad(d, c, b, a, zn); else quad(a, b, c, d, zn);
  };
  const board = (x0, x1) => {
    slab(x0, x1, -L, 0, 0, true, 1); // deck
    slab(x0, x1, -L, 0, -t, false, 0); // underside
    // Outer / inner walls, wound OUTWARD from the plank (into air / into the gap).
    const outerIsRight = x1 > 0;
    if (outerIsRight) {
      quad([x1, 0, -L], [x1, 0, 0], [x1, -t, 0], [x1, -t, -L], 0); // +X outer
      quad([x0, 0, 0], [x0, 0, -L], [x0, -t, -L], [x0, -t, 0], 0); // −X inner (gap)
    } else {
      quad([x0, 0, 0], [x0, 0, -L], [x0, -t, -L], [x0, -t, 0], 0); // −X outer
      quad([x1, 0, -L], [x1, 0, 0], [x1, -t, 0], [x1, -t, -L], 0); // +X inner (gap)
    }
    quad([x1, 0, 0], [x0, 0, 0], [x0, -t, 0], [x1, -t, 0], 0); // near end
    quad([x0, 0, -L], [x1, 0, -L], [x1, -t, -L], [x0, -t, -L], 0); // far end
  };

  board(-hw, -inner);
  board(inner, hw);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(lateral, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zone, 1));
  stampPieceAttributes(geo, { plain: 0 });
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ----------------------------------------------------------------------- */
/* Rounded end — short terminus with a semicircle nose                      */
/* ----------------------------------------------------------------------- */

/**
 * Flat mating face on one end, semicircle free end on the other.
 * Guardrail is one U along the kerb centreline (see roundedEndRailFrames).
 *
 * The STUB is a normal road sweep so asphalt UVs / zones / kerbs match the piece
 * it joins. Only the semicircle nose is a custom plate, with uv.x continuing
 * from the stub and uv.y on the same developed-deck scale.
 *
 * TWO VARIANTS off the same code, `atStart` picking between them:
 *   - rounded END   — nose past the exit  (stub v = 0 → L, tip at v = L + R)
 *   - rounded START — nose behind the entry (tip at v = 0, stub v = R → R + L)
 * Both keep the SAME sockets, so a rounded start is just a piece you prepend to
 * the head of a chain (its entry connects to nothing, which is the point).
 * Mirroring in v reverses triangle orientation, hence the `tri` helper.
 */
function _roundedEndSizes(pp, rp) {
  const hw = rp.width / 2;
  const L = Math.max(2, pp.roundEndLength ?? 8);
  const rw = Math.min(Math.max(0, rp.railWidth), hw * 0.45);
  const rh = Math.max(0, rp.railHeight);
  return { hw, L, rw, rh, tipV: L + hw };
}

/**
 * Semicircle nose only.
 *
 * EVERY BAND IS A STRIP WITH SHARED COLUMNS, deliberately. Built as loose quads
 * (four fresh verts per segment) computeVertexNormals has nothing to average
 * across, so a 180° arc shades as a flat-faceted polygon while the straight it
 * joins is smooth — that is the "looks wrong, maybe the normals?" read. Sharing
 * the arc columns inside a band and NOT between bands smooths around the curve
 * and keeps the kerb corners crisp, which is exactly what weldSmoothProfileNormals
 * does for the swept pieces.
 *
 * The kerb is a full ring: top, OUTER face and INNER face. The inner face was
 * missing, so from the deck you looked straight through the kerb (backfaces are
 * culled) and the band appeared to float. Likewise the underside fan runs to the
 * OUTER radius, not the deck rim, or the slab is open all round its foot.
 */
function buildRoundedEndNose(pp, rp, withKerbs, atStart = false) {
  const { hw, L, rw, rh } = _roundedEndSizes(pp, rp);
  const t = Math.max(0.05, rp.thickness);
  const R = hw;
  const Ri = withKerbs && rw > 1e-4 ? Math.max(0.5, hw - rw) : hw;
  const arcSteps = Math.max(16, Math.round(R * 3));
  const dir = atStart ? -1 : 1; // which way the nose bulges out of the diameter
  const v0 = atStart ? R : L; // plane of the diameter, in piece v-space
  const along0 = atStart ? 0 : L; // uv.x on that plane = the stub's own uv.x
  // Developed-deck uv.y so the nose matches a swept deck at the diameter:
  // profile walks left-kerb then deck from x=-(hw-rw) … +(hw-rw) starting at
  // dev ≈ rw + rh.
  const deckDev0 = rw + rh;
  const deckHalf = hw - (withKerbs ? rw : 0);

  const positions = [];
  const uvs = [];
  const lateral = [];
  const zone = [];
  const indices = [];
  const push = (u, v, y, zn) => {
    positions.push(u, y, -v);
    // uv.x continues through the diameter (it runs NEGATIVE on a rounded start,
    // which the procedural asphalt does not care about); uv.y mirrors sweep
    // deck developed coords.
    const uy = zn === 1
      ? deckDev0 + (u + deckHalf)
      : deckDev0 + (u + hw); // kerb / side: keep across-scale similar
    uvs.push(along0 + (v - v0), uy);
    lateral.push(hw > 0 ? u / hw : 0);
    zone.push(zn);
    return positions.length / 3 - 1;
  };
  // Wound for dir = +1; a mirrored nose needs every triangle flipped.
  const tri = (a, b, c) => {
    if (dir > 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  };
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };

  // Arc points a = 0 (right) → π (left), including endpoints.
  const outer = [];
  const inner = [];
  for (let k = 0; k <= arcSteps; k++) {
    const a = Math.PI * (k / arcSteps);
    const s = dir * Math.sin(a);
    outer.push({ u: R * Math.cos(a), v: v0 + R * s });
    inner.push({ u: Ri * Math.cos(a), v: v0 + Ri * s });
  }
  const column = (pts, y, zn) => pts.map((p) => push(p.u, p.v, y, zn));

  // Semicircle deck (fan from the diameter centre). The diameter itself is left
  // open — the sweep already owns that end, and the two halves of the fan edge
  // are collinear with the stub's single deck edge, so there is no crack.
  const origin = push(0, v0, 0, 1);
  const rim = column(withKerbs ? inner : outer, 0, 1);
  for (let i = 0; i < rim.length - 1; i++) tri(origin, rim[i], rim[i + 1]);

  // Underside — always at the OUTER radius so it closes against the slab wall.
  const originB = push(0, v0, -t, 0);
  const rimB = column(outer, -t, 0);
  for (let i = 0; i < rimB.length - 1; i++) tri(originB, rimB[i + 1], rimB[i]);

  if (withKerbs && Ri < R - 1e-4) {
    const oTop = column(outer, rh, 2);
    const iTop = column(inner, rh, 2);
    for (let i = 0; i < arcSteps; i++) quad(oTop[i], oTop[i + 1], iTop[i + 1], iTop[i]);
    const oHi = column(outer, rh, 0);
    const oLo = column(outer, 0, 0);
    for (let i = 0; i < arcSteps; i++) quad(oHi[i], oLo[i], oLo[i + 1], oHi[i + 1]);
    const iLo = column(inner, 0, 0);
    const iHi = column(inner, rh, 0);
    for (let i = 0; i < arcSteps; i++) quad(iLo[i], iHi[i], iHi[i + 1], iLo[i + 1]);
  }

  // Outer slab wall under the nose (and under the kerb foot).
  const sHi = column(outer, 0, 0);
  const sLo = column(outer, -t, 0);
  for (let i = 0; i < arcSteps; i++) quad(sHi[i], sLo[i], sLo[i + 1], sHi[i + 1]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(lateral, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zone, 1));
  stampPieceAttributes(geo, { plain: 1 });
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildRoundedEndGeometry(pp = pieceParams, rp = roadParams, withKerbs = true, atStart = false) {
  const { hw, L } = _roundedEndSizes(pp, rp);
  // Stub = ordinary straight sweep → identical asphalt / kerbs / seam as
  // neighbours. On a rounded start it begins at v = hw, past the nose, and its
  // own uv.x still starts at 0 there — which is what the nose's `along0` matches.
  const v0 = atStart ? hw : 0;
  const stubFrames = computeFrames(
    [new V3(0, 0, -v0), new V3(0, 0, -(v0 + L))],
    _up,
  );
  const profile = buildProfile(rp, withKerbs);
  const stub = buildSweepGeometry(stubFrames, profile, { plain: true });
  const nose = buildRoundedEndNose(pp, rp, withKerbs, atStart);
  const merged = mergeGeometries([stub, nose], false);
  nose.dispose();
  if (!merged) return stub; // attribute mismatch — keep the stub rather than nothing
  stub.dispose();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Kerb-centreline frames for the U-rail: entry-left → nose → entry-right.
 * Uses the kit's parallel-transport frames as-is (up = +Y). Do NOT rebuild the
 * basis — flipping `right` to "outward" inverted `up` and hung the rail upside down.
 */
function roundedEndRailFrames(pp = pieceParams, rp = roadParams, atStart = false) {
  const { hw, L, rw } = _roundedEndSizes(pp, rp);
  const lat = hw - rw * 0.5;
  if (lat < 0.4) return [];
  const arcSteps = Math.max(10, Math.round(lat * 1.6));
  const pts = [];
  // The U is walked so the DECK IS ALWAYS ON +right (buildRailAlongPath relies
  // on it for which face the corrugation shows). Mirroring the piece therefore
  // also reverses the traversal: a rounded start runs right kerb → nose → left.
  if (atStart) {
    const vD = hw; // diameter plane; the tip is at v = 0
    const vEnd = hw + L;
    pts.push(new V3(lat, 0, -vEnd));
    pts.push(new V3(lat, 0, -vD));
    for (let k = 1; k < arcSteps; k++) {
      const a = (Math.PI * k) / arcSteps; // 0 at right → π at left
      pts.push(new V3(lat * Math.cos(a), 0, -(vD - lat * Math.sin(a))));
    }
    pts.push(new V3(-lat, 0, -vD));
    pts.push(new V3(-lat, 0, -vEnd));
    return computeFrames(pts, _up);
  }
  pts.push(new V3(-lat, 0, 0));
  pts.push(new V3(-lat, 0, -L));
  for (let k = 1; k < arcSteps; k++) {
    const a = Math.PI - (Math.PI * k) / arcSteps; // π at left → 0 at right
    pts.push(new V3(lat * Math.cos(a), 0, -(L + lat * Math.sin(a))));
  }
  pts.push(new V3(lat, 0, -L));
  pts.push(new V3(lat, 0, 0));
  return computeFrames(pts, _up);
}

function roundedEndPoints(pp) {
  const L = Math.max(2, pp.roundEndLength ?? 8);
  const hw = roadParams.width / 2;
  return straightLinePoints(L + hw);
}

function roundedEndSockets(pp) {
  const L = Math.max(2, pp.roundEndLength ?? 8);
  const hw = roadParams.width / 2;
  return {
    entryPos: new V3(0, 0, 0),
    entryDir: new V3(0, 0, -1),
    exitPos: new V3(0, 0, -(L + hw)),
    exitDir: new V3(0, 0, -1),
  };
}

/** Params snapshot for start_new / finish_new — longer stub by default. */
function _startNewParams(pp) {
  const stub = Math.max(4, pp.gameStartStub ?? pp.roundEndLength ?? 14);
  return pp.roundEndLength === stub ? pp : { ...pp, roundEndLength: stub };
}

/* ----------------------------------------------------------------------- */
/* Glass road (lacquer deck with a glazed square window)                    */
/* ----------------------------------------------------------------------- */

/**
 * A straight deck in lacquered white with a SQUARE window cut through it — and the
 * window is glazed, not open. It reads as the hole road's evil twin: same
 * silhouette, same "there is nothing under me" jolt, except the car stays on the
 * road and you watch the world go past underneath.
 *
 * THREE PIECES OF GEOMETRY, and which is which matters:
 *
 *  • this deck — the thing you SEE, with a real hole through the slab, so you
 *    can look through the window from above AND from underneath;
 *  • the same builder with `solid`, which is the thing you DRIVE on. It is
 *    handed to the deck BVH as `deckCollision` (the mechanism the half tubes'
 *    rim caps already use), and it simply has no window: the wheels find an
 *    unbroken slab across the whole piece.
 *  • buildGlassPaneGeometry — the pane, rendered on its own transparent
 *    material and collided by NOTHING.
 *
 * That split is what makes the piece cheap AND safe. The alternative, putting
 * the pane in the collision bake, means the wheels probe a surface that has to
 * line up with the deck to the millimetre or the car trips on the frame; here
 * the collision surface is flat, continuous and 12 triangles.
 *
 * The deck itself is one zone-5 band, so it stays on the SHARED road material
 * and instances with every other road piece — no per-piece material, no extra
 * draw call. See `panelColor` in modularRoadMaterial.js.
 */
export function buildGlassDeckGeometry(pp = pieceParams, rp = roadParams, opts = {}) {
  const L = Math.max(8, pp.glassLength ?? 32);
  const hw = Math.max(3, (pp.glassWidth ?? rp.width) / 2);
  const t = Math.max(0.05, rp.thickness);
  // Keep at least a 1 m frame on the sides and 1.5 m at the ends, so the window
  // can never eat the piece and leave a rim you cannot land on.
  const h = opts.solid
    ? 0
    : THREE.MathUtils.clamp((pp.glassHole ?? 9) / 2, 0.5, Math.min(hw - 1, L / 2 - 1.5));
  const cz = -L / 2; // window centre (piece-local z)

  const positions = [];
  const uvs = [];
  const lateral = [];
  const zone = [];
  const indices = [];
  const quad = (pa, pb, pc, pd, zn) => {
    const base = positions.length / 3;
    for (const p of [pa, pb, pc, pd]) {
      positions.push(p[0], p[1], p[2]);
      uvs.push(-p[2], p[0]); // uv.x = metres along path, uv.y = across
      lateral.push(p[0] / hw);
      zone.push(zn);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  /** Axis-aligned patch at height y, wound for a +Y (up) or −Y (down) normal. */
  const slab = (x0, x1, z0, z1, y, up, zn) => {
    const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
    if (up) quad(d, c, b, a, zn); else quad(a, b, c, d, zn);
  };

  const DECK = 5; // lacquered panel — see createRoadMaterial's zone chain
  if (h <= 0) {
    // COLLISION FORM: an unbroken slab. This is the surface the wheels meet.
    slab(-hw, hw, -L, 0, 0, true, DECK);
    slab(-hw, hw, -L, 0, -t, false, 0);
  } else {
    // Deck and underside as a frame of four bands around the window.
    const bands = [
      [-hw, hw, cz + h, 0], // near of the window
      [-hw, hw, -L, cz - h], // far of the window
      [-hw, -h, cz - h, cz + h], // left of it
      [h, hw, cz - h, cz + h], // right of it
    ];
    for (const [x0, x1, z0, z1] of bands) {
      slab(x0, x1, z0, z1, 0, true, DECK);
      slab(x0, x1, z0, z1, -t, false, 0);
    }
    // Window reveal — the four faces you see the slab's thickness through.
    // Wound facing INTO the hole so FrontSide shows the frame from the pane.
    quad([h, 0, cz - h], [-h, 0, cz - h], [-h, -t, cz - h], [h, -t, cz - h], 0);
    quad([-h, 0, cz + h], [h, 0, cz + h], [h, -t, cz + h], [-h, -t, cz + h], 0);
    quad([-h, 0, cz - h], [-h, 0, cz + h], [-h, -t, cz + h], [-h, -t, cz - h], 0);
    quad([h, 0, cz + h], [h, 0, cz - h], [h, -t, cz - h], [h, -t, cz + h], 0);
  }

  // Outer perimeter walls (both forms have them — the collision slab wants a
  // closed volume so a chassis sample can never end up inside it).
  // Wound OUTWARD. These used to face the cavity, which DoubleSide hid and
  // FrontSide made disappear: looking at the piece from the side you saw a
  // paper-thin deck with no thickness. Same winding as a closed box.
  quad([hw, 0, 0], [-hw, 0, 0], [-hw, -t, 0], [hw, -t, 0], 0);
  quad([-hw, 0, -L], [hw, 0, -L], [hw, -t, -L], [-hw, -t, -L], 0);
  quad([-hw, 0, 0], [-hw, 0, -L], [-hw, -t, -L], [-hw, -t, 0], 0);
  quad([hw, 0, -L], [hw, 0, 0], [hw, -t, 0], [hw, -t, -L], 0);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(lateral, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zone, 1));
  stampPieceAttributes(geo, { plain: 1 });
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The pane that fills the glass road's window.
 *
 * NOT flush, and not the same size as the hole — both on purpose, and both for
 * the reason the hole walls learned the hard way: two surfaces on the same plane
 * z-fight, and the flicker crawls as the camera moves.
 *
 *  • RECESSED by `glassRecess`, so the pane's top face is a couple of
 *    centimetres under the road rather than level with it. Nothing is coplanar,
 *    and the car never touches the pane anyway — it rides the flat collision
 *    slab above it (see buildGlassDeckGeometry).
 *  • OVERSIZE by `glassFlange` on every side, so its edges tuck UNDER the deck
 *    instead of meeting the reveal face-to-face. That also means there is no
 *    sliver of daylight around the frame when you look along the road.
 *
 * The result reads as a pane bedded into a rebate, which is how real glazing
 * sits, and it needs no frame geometry to sell it.
 */
export function buildGlassPaneGeometry(pp = pieceParams, rp = roadParams) {
  const L = Math.max(8, pp.glassLength ?? 32);
  const hw = Math.max(3, (pp.glassWidth ?? rp.width) / 2);
  const t = Math.max(0.05, rp.thickness);
  const h = THREE.MathUtils.clamp((pp.glassHole ?? 9) / 2, 0.5, Math.min(hw - 1, L / 2 - 1.5));
  const f = Math.max(0.02, pp.glassFlange ?? 0.15);
  const top = -Math.max(0.005, pp.glassRecess ?? 0.025);
  // Clamped so the pane can never reach the underside of the slab — down there
  // it would be coplanar with the piece's own bottom face, which is the flicker
  // the recess exists to avoid.
  const thick = Math.min(Math.max(0.02, pp.glassThick ?? 0.18), t + top - 0.05);
  const bot = top - thick;
  const cz = -L / 2;
  const s = h + f; // half-side including the flange under the deck

  const geo = new THREE.BoxGeometry(2 * s, thick, 2 * s);
  geo.translate(0, (top + bot) / 2, cz);
  geo.computeBoundingSphere();
  return geo;
}

/* ----------------------------------------------------------------------- */
/* Guardrail (W-beam + posts) along the kerb tops                           */
/* ----------------------------------------------------------------------- */

/** W-beam cross-section in (vertical y, lateral z) meters, about the beam centre. */
/**
 * W-beam cross-section in (y, z): y vertical, z lateral offset from the beam
 * centreline. An OPEN polyline swept along the frames — the beam is a
 * corrugated sheet, not a solid.
 *
 * The last three points are a PEAKED TOP CAP, and they exist for gameplay, not
 * looks. Without them the profile simply ended at (0.5h, 0.5d): a bare knife
 * edge ~1.18 m above the deck whose only face normal is HORIZONTAL. A car
 * landing on the rail was therefore shoved sideways and never either properly
 * supported or cleanly rejected — and since guardrails live in the SOLIDS BVH,
 * the wheels can't probe them, so a car up there has no drive, no steering and
 * no suspension. That is the "stuck on a guardrail" case.
 *
 * The cap turns the top into a ridge whose faces point up-AND-outward, so
 * anything landing on it slides off. `capRiseFrac` sets the slope: rise
 * capRiseFrac·d over a run of 0.5·d, so anything above 0.5 tilts the face past
 * 45° and makes the shedding (lateral) component beat the supporting (vertical)
 * one. 0 restores the old bare edge.
 *
 * The ridge is deliberately SYMMETRIC about z=0. Biasing it inward so the car
 * always sheds back onto the track would be nicer — but `prof.z` is added along
 * the same `fr.right` axis for BOTH rails while only `edgeX` is mirrored (see
 * sweepBeamGeometry), so any z-asymmetry would point the right way on one rail
 * and backwards on the other.
 */
function wBeamProfile(h, d, crownFrac, capRiseFrac) {
  const prof = [
    { y: -0.5 * h, z: 0.5 * d },
    { y: -0.16 * h, z: 0.32 * d },
    { y: 0.0, z: -crownFrac * d },
    { y: 0.16 * h, z: 0.32 * d },
  ];
  const cap = Math.max(0, capRiseFrac ?? 0) * d;
  if (cap <= 1e-6) {
    prof.push({ y: 0.5 * h, z: 0.5 * d }); // legacy bare edge
    return prof;
  }
  prof.push(
    { y: 0.5 * h - cap, z: 0.5 * d }, // outer shoulder
    { y: 0.5 * h, z: 0.0 }, // ridge
    { y: 0.5 * h - cap, z: -0.5 * d }, // inner shoulder
  );
  return prof;
}

/** Sweep a small (y,z) profile along the frames, offset to one kerb edge. */
function sweepBeamGeometry(frames, edgeX, centerV, prof) {
  const F = frames.length;
  const R = prof.length;
  const along = new Float32Array(F);
  for (let i = 1; i < F; i++) along[i] = along[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);

  const positions = [];
  const uvs = [];
  const indices = [];
  const p = new V3();
  for (let i = 0; i < F; i++) {
    const fr = frames[i];
    for (let j = 0; j < R; j++) {
      const pr = prof[j];
      p.copy(fr.pos)
        .addScaledVector(fr.right, edgeX + pr.z)
        .addScaledVector(fr.up, centerV + pr.y);
      positions.push(p.x, p.y, p.z);
      uvs.push(along[i], j / (R - 1));
    }
  }
  for (let i = 0; i < F - 1; i++) {
    const r0 = i * R;
    const r1 = (i + 1) * R;
    for (let j = 0; j < R - 1; j++) {
      indices.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

const _m = new THREE.Matrix4();
const _pos = new V3();

/** Posts connecting kerb top to the beam, spaced along the path on one side. */
function buildPostGeometries(frames, edgeX, kerbTop, centerV, gp, out) {
  const F = frames.length;
  let total = 0;
  for (let i = 1; i < F; i++) total += frames[i].pos.distanceTo(frames[i - 1].pos);
  const n = Math.max(2, Math.floor(total / Math.max(0.5, gp.postSpacing)) + 1);
  const postH = Math.max(0.05, centerV - kerbTop + gp.beamHeight * 0.4);
  const postCenterV = kerbTop + postH * 0.5;
  for (let k = 0; k < n; k++) {
    const idx = Math.round((k / (n - 1)) * (F - 1));
    const fr = frames[idx];
    const box = new THREE.BoxGeometry(gp.postWidth, postH, gp.postThickness);
    _pos.copy(fr.pos).addScaledVector(fr.right, edgeX).addScaledVector(fr.up, postCenterV);
    _m.makeBasis(fr.right, fr.up, fr.tangent).setPosition(_pos);
    box.applyMatrix4(_m);
    out.push(box);
  }
}

/**
 * Build the guardrail (both kerbs) for a piece in local space, or null when
 * disabled. Returns a single merged geometry (beams + posts).
 */
export function buildGuardrailGeometry(frames, profileData = buildProfile(), gp = guardrailParams, rp = roadParams) {
  // NOTE: deliberately does NOT check `gp.enabled`. That is the GLOBAL "new
  // pieces get edges" default, and testing it here made it override the
  // PER-PIECE `edges` flag: toggling Edges off stripped rails from every piece
  // in the track on the next rebuild, so per-piece edges were unreachable.
  // The only caller (buildPiece) already gates on the per-piece flag.
  if (gp.beamHeight <= 0) return null;
  const hw = profileData.hw;
  const rw = Math.min(Math.max(0, rp.railWidth), hw * 0.45);
  const kerbTop = rp.railHeight;
  const centerV = kerbTop + gp.beamGap + gp.beamHeight * 0.5;
  const edgeX = hw - rw * 0.5; // centre of each kerb
  const prof = wBeamProfile(gp.beamHeight, gp.beamDepth, gp.crownFrac, gp.capRiseFrac);

  const geos = [];
  for (const side of [-1, 1]) {
    geos.push(sweepBeamGeometry(frames, side * edgeX, centerV, prof));
    buildPostGeometries(frames, side * edgeX, kerbTop, centerV, gp, geos);
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (merged) merged.computeBoundingSphere();
  return merged;
}

/* ----------------------------------------------------------------------- */
/* Shells — enclosures swept along the frames (tunnel arch, tube, channel)  */
/* ----------------------------------------------------------------------- */

/** Sweep one open (x, y) profile polyline along the frames into one surface
 *  (rendered double-sided; baked into the SOLIDS BVH so the chassis collides
 *  with it while the wheels still probe the deck underneath). */
function _sweepShellProfile(frames, prof, opts = {}) {
  const F = frames.length;
  const P = prof.length;
  const along = new Float32Array(F);
  for (let i = 1; i < F; i++) along[i] = along[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);
  const uvAlong0 = opts.uvAlong0 ?? 0;
  const uvUScale = opts.uvWorld ? 1 : 0.12;

  const positions = [];
  const uvs = [];
  const colors = opts.color ? [] : null;
  const cr = opts.color?.r ?? 0, cg = opts.color?.g ?? 0, cb = opts.color?.b ?? 0;
  const indices = [];
  const p = new V3();
  for (let i = 0; i < F; i++) {
    const fr = frames[i];
    for (let j = 0; j < P; j++) {
      const pr = prof[j];
      p.copy(fr.pos).addScaledVector(fr.right, pr.x).addScaledVector(fr.up, pr.y);
      positions.push(p.x, p.y, p.z);
      uvs.push((uvAlong0 + along[i]) * uvUScale, j / (P - 1));
      if (colors) colors.push(cr, cg, cb);
    }
  }
  for (let i = 0; i < F - 1; i++) {
    const r0 = i * P;
    const r1 = (i + 1) * P;
    for (let j = 0; j < P - 1; j++) {
      if (opts.reverse) {
        indices.push(r0 + j, r0 + j + 1, r1 + j, r0 + j + 1, r1 + j + 1, r1 + j);
      } else {
        indices.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  if (colors) geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Tunnel shell — vertical side walls plus a semicircular crown, swept along the
 * piece frames and left open underneath so the deck stays drivable.
 */
export function buildTunnelGeometry(frames, profileData = buildProfile(), pp = pieceParams) {
  const hw = profileData.hw;
  const xo = hw + 0.4; // walls sit just outside the deck edge
  const apex = Math.max(xo + 1.2, pp.tunnelHeight); // crown clearance above the deck
  const springY = Math.max(0.6, apex - xo); // wall height where the arch springs
  const arcSteps = 16;
  // Walls sit 0.4 m OUTSIDE the deck edge, so a wall base at deck level leaves
  // a see-through slit between wall and slab. A skirt down past the slab bottom
  // closes it (same class of gap as the tube's missing bottom wedge).
  const skirtY = -(roadParams.thickness + 0.4);

  // Cross-section from left skirt, up the wall, over the arch, down the right.
  const prof = [
    { x: -xo, y: skirtY },
    { x: -xo, y: springY },
  ];
  for (let k = 1; k <= arcSteps; k++) {
    const a = Math.PI * (1 - k / arcSteps); // PI (left springline) → 0 (right springline)
    prof.push({ x: Math.cos(a) * xo, y: springY + Math.sin(a) * xo });
  }
  prof.push({ x: xo, y: skirtY });
  return _sweepShellProfile(frames, prof);
}

const _VAULT_IN = new THREE.Color(0x5c6168);
const _VAULT_OUT = new THREE.Color(0x8a9098);
const _VAULT_LIP = new THREE.Color(0xc5c9ce);
const _VAULT_RIB = new THREE.Color(0x3a3e44);
const _VAULT_THICK = 0.78;
const _VAULT_PORTAL = 0.72;
const _VAULT_RIB_SPACING = 13;
const _VAULT_LIGHT_SPACING = 13;
const _VAULT_LIGHT_MARGIN = 6.5;

/**
 * Horseshoe vault — the new road tunnel. Inner + outer concrete, inset mouth
 * bulkheads (so chained pieces don't z-fight), a few inner ribs, and discrete
 * neon bars. NOT the old `arch` shell: that stays until we delete it on purpose.
 *
 * Perf: FrontSide (both faces exist), subsampled sweep (deck stays dense),
 * cheaper inner-only collision, glow is a handful of boxes not a strip on
 * every metre and not a shader on every shell pixel.
 */
export function buildVaultTunnel(frames, profileData = buildProfile(), pp = pieceParams) {
  const visual = _subsampleFrames(frames, 2.5);
  const coll = _subsampleFrames(frames, 5.2);
  const inner = _vaultInnerProfile(profileData.hw, pp.tunnelHeight ?? 7.2);
  const outer = _offsetProfile(inner, _VAULT_THICK);
  const total = _pathLength(frames);
  const portal = Math.min(_VAULT_PORTAL, total * 0.2);
  const innerFrames = _pulledFrames(visual, portal);
  const shellParts = [
    _sweepShellProfile(innerFrames, inner, { color: _VAULT_IN, reverse: false, uvWorld: true }),
    _sweepShellProfile(visual, outer, { color: _VAULT_OUT, reverse: true, uvWorld: true }),
    // 3D portal reveal: outer starts at the mouth, inner is set back. A
    // planar cap here was FrontSide-culled from 3/4 and the vault read as a
    // paper cutout. The slanted ring is visible from every angle.
    _vaultMouthBevel(visual[0], innerFrames[0], outer, inner, _VAULT_LIP, false),
    _vaultMouthBevel(visual[visual.length - 1], innerFrames[innerFrames.length - 1], outer, inner, _VAULT_LIP, true),
  ];
  for (let s = _VAULT_RIB_SPACING; s < total - 1.6; s += _VAULT_RIB_SPACING) {
    shellParts.push(_vaultRib(_frameAtArcLength(frames, s), inner));
  }
  const shell = mergeGeometries(shellParts, false);
  for (const g of shellParts) g.dispose();
  if (shell) shell.computeBoundingSphere();
  const collision = _sweepShellProfile(coll, inner, { reverse: false });
  const glow = _vaultGlowGeometry(frames, inner, total);
  return { shell, collision, glow };
}

function _subsampleFrames(frames, maxStep) {
  const n = frames.length;
  if (n <= 2) return frames;
  const out = [frames[0]];
  let acc = 0;
  for (let i = 1; i < n - 1; i++) {
    acc += frames[i].pos.distanceTo(frames[i - 1].pos);
    if (acc >= maxStep) {
      out.push(frames[i]);
      acc = 0;
    }
  }
  if (out[out.length - 1] !== frames[n - 1]) out.push(frames[n - 1]);
  return out;
}

/** Flattened horseshoe: tall vertical walls, elliptical crown. Real motorway
 *  vault, not a semicircle balanced on two posts. */
function _vaultInnerProfile(hw, apex) {
  const xo = hw + 0.34;
  const spring = Math.min(2.85, Math.max(2.2, apex * 0.38));
  const rx = xo;
  const ry = Math.max(2.2, apex - spring);
  const skirtY = -(roadParams.thickness + 0.4);
  const ARC = 12;
  const prof = [
    { x: -xo, y: skirtY },
    { x: -xo, y: spring },
  ];
  for (let k = 1; k <= ARC; k++) {
    const a = Math.PI * (1 - k / ARC);
    prof.push({ x: Math.cos(a) * rx, y: spring + Math.sin(a) * ry });
  }
  prof.push({ x: xo, y: skirtY });
  return prof;
}

function _pathLength(frames) {
  let t = 0;
  for (let i = 1; i < frames.length; i++) t += frames[i].pos.distanceTo(frames[i - 1].pos);
  return t;
}

function _shiftFrame(fr, dist) {
  return {
    pos: fr.pos.clone().addScaledVector(fr.tangent, dist),
    tangent: fr.tangent,
    up: fr.up,
    right: fr.right,
  };
}

/** Parallel offset with clamped miters so 90° skirt/wall corners don't spike. */
function _offsetProfile(prof, dist) {
  const n = prof.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = prof[i + 1].x - prof[i].x;
    const dy = prof[i + 1].y - prof[i].y;
    const len = Math.hypot(dx, dy) || 1;
    // Profile walks left-up-over-right around the U. The bore stays on the
    // RIGHT of that walk, so outward (into the mountain) is LEFT of the tangent.
    segN.push({ x: -dy / len, y: dx / len });
  }
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let nx, ny;
    if (i === 0) {
      nx = segN[0].x;
      ny = segN[0].y;
    } else if (i === n - 1) {
      nx = segN[n - 2].x;
      ny = segN[n - 2].y;
    } else {
      nx = segN[i - 1].x + segN[i].x;
      ny = segN[i - 1].y + segN[i].y;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;
      const miter = Math.min(2, 1 / Math.max(0.35, nx * segN[i].x + ny * segN[i].y));
      nx *= miter;
      ny *= miter;
    }
    out[i] = { x: prof[i].x + nx * dist, y: prof[i].y + ny * dist };
  }
  return out;
}

function _pulledFrames(frames, inset) {
  if (frames.length < 2 || inset <= 1e-4) return frames;
  const a = _shiftFrame(frames[0], inset);
  const b = _shiftFrame(frames[frames.length - 1], -inset);
  if (frames.length === 2) return [a, b];
  return [a, ...frames.slice(1, -1), b];
}

/** Slanted portal ring: inner profile on `frInner`, outer on `frOuter`. */
function _vaultMouthBevel(frOuter, frInner, outer, inner, color, reverse) {
  const P = inner.length;
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];
  const p = new V3();
  const cr = color.r, cg = color.g, cb = color.b;
  const push = (fr, pr) => {
    p.copy(fr.pos).addScaledVector(fr.right, pr.x).addScaledVector(fr.up, pr.y);
    positions.push(p.x, p.y, p.z);
    colors.push(cr, cg, cb);
    uvs.push(4, 0);
  };
  for (let j = 0; j < P; j++) push(frInner, inner[j]);
  for (let j = 0; j < P; j++) push(frOuter, outer[j]);
  for (let j = 0; j < P - 1; j++) {
    const i0 = j, i1 = j + 1, o0 = P + j, o1 = P + j + 1;
    if (reverse) indices.push(i0, o0, i1, i1, o0, o1);
    else indices.push(i0, i1, o0, i1, o1, o0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Short inward ridge on the inner wall — expansion joint, not a full portal. */
function _vaultRib(fr, inner) {
  const a = _shiftFrame(fr, -0.08);
  const b = _shiftFrame(fr, 0.08);
  const ridge = _offsetProfile(inner, -0.05);
  return _sweepShellProfile([a, b], ridge, {
    color: _VAULT_RIB, reverse: false, uvWorld: true, uvAlong0: 4,
  });
}

/**
 * Discrete wall neon bars. Real tunnels light a few fixtures, not a Tron ring
 * every metre — two bars every ~13 m, both walls, same stations so they pair.
 */
function _vaultGlowGeometry(frames, inner, total) {
  const left = inner[1];
  const right = inner[inner.length - 2];
  const y = left.y - 0.32;
  const xl = left.x + 0.028;
  const xr = right.x - 0.028;
  const parts = [];
  for (let s = _VAULT_LIGHT_MARGIN; s <= total - _VAULT_LIGHT_MARGIN + 0.05; s += _VAULT_LIGHT_SPACING) {
    const fr = _frameAtArcLength(frames, s);
    parts.push(_neonBar(fr, xl, y));
    parts.push(_neonBar(fr, xr, y));
  }
  if (!parts.length) return null;
  const glow = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (glow) glow.computeBoundingSphere();
  return glow;
}

function _neonBar(fr, x, y) {
  const geo = new THREE.BoxGeometry(0.04, 0.075, 1.35);
  _pos.copy(fr.pos).addScaledVector(fr.right, x).addScaledVector(fr.up, y);
  _m.makeBasis(fr.right, fr.up, fr.tangent).setPosition(_pos);
  geo.applyMatrix4(_m);
  return geo;
}

/**
 * Half-pipe channel shell — open-top quarter-pipe walls curving up from just
 * outside each deck edge (tangent to the deck at the base, vertical at the top).
 * A U-channel that keeps the car funneled without enclosing the sky.
 */
export function buildChannelGeometry(frames, profileData = buildProfile(), pp = pieceParams) {
  const xo = profileData.hw + 0.3;
  const rc = Math.max(1, pp.channelRadius ?? 4);
  const steps = 12;
  const skirtY = -(roadParams.thickness + 0.4); // seal the wall-to-slab slit
  const geos = [];
  for (const side of [-1, 1]) {
    // From top rim down to the deck edge: P(a) = (xo + rc·sin a, rc·(1 − cos a)),
    // then straight down past the slab bottom.
    const prof = [];
    for (let k = steps; k >= 0; k--) {
      const a = (Math.PI / 2) * (k / steps);
      prof.push({ x: side * (xo + rc * Math.sin(a)), y: rc * (1 - Math.cos(a)) });
    }
    prof.push({ x: side * xo, y: skirtY });
    geos.push(_sweepShellProfile(frames, prof));
  }
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (merged) merged.computeBoundingSphere();
  return merged;
}

/** Shell dispatch by kind — `def.shell` is "arch" | "channel" (legacy `true`
 *  = arch). Rideable tubes are NOT shells — their ring is the road itself
 *  (def.profile = buildTubeProfile), so it lands in the deck BVH, not solids. */
export function buildShellGeometry(kind, frames, profileData, pp) {
  if (kind === "channel") return buildChannelGeometry(frames, profileData, pp);
  if (kind === "vault") return null; // buildVaultTunnel — own mesh + glow + collision
  return buildTunnelGeometry(frames, profileData, pp);
}

/* ----------------------------------------------------------------------- */
/* Piece centerlines                                                        */
/* ----------------------------------------------------------------------- */

function rotateY(v, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return new V3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

/** Max bend per sweep step (rad). Fixed-length stepping alone lets tight arcs
 *  facet visibly (1.6 m steps on an 18 m radius ≈ 5°/step, and the kerb +
 *  guardrail silhouettes show every facet), so curved pieces cap the per-step
 *  turn/roll too. Pass the TOTAL angle the piece sweeps (yaw + roll). */
const MAX_STEP_ANGLE = THREE.MathUtils.degToRad(1.5);
/**
 * How many stations to sweep, and `pp.maxStepDeg` is how a piece opts out of the
 * default density.
 *
 * 1.5° EXISTS FOR KERBS. It was chosen because "length-only stepping put ~5° of
 * pitch per step on a typical slope and the kerbs showed every facet" — a road's
 * kerb is a narrow ridge running along the piece, so it catches the light on
 * every crease. The rideable tubes have no kerbs (`noKerb`), and they pay for
 * that density across a 98-point annulus instead of an 8-point road section.
 *
 * MEASURED on a 90° R26 tube, sagitta of the flat it leaves behind:
 *
 *     along the sweep  1.5°/step -> 0.22 cm     (faceting radius = centreline, 26 m)
 *     around the bore  48 segs   -> 1.71 cm     (faceting radius = bore, 8 m)
 *
 * The frames are EIGHT TIMES finer than the cross-section they are sweeping, so
 * the extra stations buy nothing you can see — the profile's own faceting swamps
 * them. See `def.stepDeg` on the tube family.
 */
function stepsFor(arcLen, totalAngle = 0, minSteps = 2, pp = null) {
  // ONE KNOB, because both terms are over-tight for the same reason. Relaxing
  // only the angle would leave `arcLen / segLen` (1.6 m stations) setting the
  // density on anything long and gently curved, which is most of a tube run.
  const relax = Math.max(1, pp?.stepRelax ?? 1);
  return Math.max(
    minSteps,
    Math.ceil(arcLen / (roadParams.segLen * relax)),
    Math.ceil(Math.abs(totalAngle) / (MAX_STEP_ANGLE * relax)),
  );
}

/**
 * Constant-section straight centreline.
 *
 * Used to be entry and exit only. A two-frame sweep is one quad per profile
 * span, and bump / wet lighting reads that quad's triangle diagonal as a
 * crease — a field of parallel diagonals across the deck, which looks like
 * shadow acne or a bad normal. Stations every `segLen` keep those quads
 * roughly square so the diagonal dies in the grain. Heading and the section
 * are constant, so the extra rings are coincident with the chord; rails and
 * posts still space themselves by metres, not by frame count.
 *
 * Do NOT use this where heading, roll, or the profile changes between the
 * ends (curves, morphing entries, bank in/out) — those already go through
 * `stepsFor`.
 */
function straightLinePoints(length, y = 0) {
  const L = Math.max(1, length);
  const n = Math.max(1, Math.ceil(L / roadParams.segLen));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, y, -L * (i / n)));
  return pts;
}

function straightPoints(pp) {
  return straightLinePoints(pp.straightLength);
}

/** Tube entry / exit funnel centreline — a straight of its own length.
 *  Kept dense: the SECTION morphs along t, so the sweep needs the stations. */
function tubeEntryPoints(pp) {
  const L = Math.max(4, pp.tubeEntryLength ?? 26);
  // Rolls its whole section from flat road to bore along the way, so it keeps a
  // floor of 4 stations however far `stepRelax` opens the spacing up.
  const n = Math.max(4, Math.ceil(L / (roadParams.segLen * Math.max(1, pp.stepRelax ?? 1))));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -L * (i / n)));
  return pts;
}

/**
 * TUBE CANNON — a tube exit that pitches UP as it unwraps.
 *
 * The flat `tube_out` is the only way out of a bore, so every tube run in the
 * game ends by putting you back on level road. This is the same unwrap over the
 * same `tubeEntryLength`, on the jump ramp's centreline: the bore opens into
 * road while the road tilts, and you leave the mouth flying.
 *
 * Shares `jumpAngle` with the ramps rather than owning a number, because it IS
 * a launch and the takeoff angle is tied to top speed the same way (ballistic
 * range goes as v²·sin 2θ — see the jump defaults). That also means
 * `jumpEndTangents` describes this piece exactly: it only reads jumpAngle, so
 * the connector hits its labelled pitch whatever length the unwrap is given.
 */
function tubeLaunchPoints(pp) {
  const L = Math.max(4, pp.tubeEntryLength ?? 26);
  const ang = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.jumpAngle, 0, 80));
  const n = stepsFor(L, ang, 8, pp);
  const ds = L / n;
  const cur = new V3(0, 0, 0);
  const pts = [cur.clone()];
  for (let i = 1; i <= n; i++) {
    const ph = ang * (i / n) * (i / n); // ease-in: level in the bore, pitched at the mouth
    cur.y += Math.sin(ph) * ds;
    cur.z += -Math.cos(ph) * ds;
    pts.push(cur.clone());
  }
  return pts;
}

function platformPoints(pp) {
  return straightLinePoints(Math.max(4, pp.platformLength));
}

/** Hole-road / glass centerline: only the connectors matter (geometry is custom). */
function glassPoints(pp) {
  return straightLinePoints(Math.max(8, pp.glassLength ?? 32));
}

function holedPoints(pp) {
  return straightLinePoints(Math.max(8, pp.holedLength ?? 32));
}

function dualPoints(pp) {
  return straightLinePoints(Math.max(8, pp.dualLength ?? 32));
}

/** Quintic smootherstep — C2, so slope AND curvature are zero at both ends.
 *  The cubic smoothstep used before left a curvature jump where an ease meets
 *  the hold, which the sweep lighting showed as a hard crease line across the
 *  deck (the "blocky" banked look). */
function smoother(u) {
  return u * u * u * (u * (u * 6 - 15) + 10);
}

function curvePoints(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 180));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const arc = R * A;
  const n = stepsFor(arc, A, 2, pp);
  const center = new V3(dir * R, 0, 0);
  const radius0 = new V3(-dir * R, 0, 0); // origin - center
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const phi = A * (i / n);
    pts.push(center.clone().add(rotateY(radius0, -dir * phi)));
  }
  return pts;
}

/**
 * Fraction of a slope's run spent on its CONCAVE half — see slopeShape.
 *
 * 0.5 = symmetric, which is the minimum-peak-curvature shape and what this
 * ships. IT WAS 0.35 FOR ONE SESSION and that was a mistake worth recording,
 * because the reasoning behind it sounded right: give the CONVEX half the long
 * side, since only the convex half can throw the car off the road, and let the
 * suspension absorb the sharper compression on the concave half.
 *
 * The suspension does not absorb it. MEASURED at 48 m/s, the demand each half
 * makes against what can answer it:
 *
 *                     concave       convex
 *     capacity        14.5 g        12.7 g      (strut fully squashed / ROAD_HOLD)
 *     Up Medium 32/10 13.1 g         7.1 g      at 0.35
 *     Up Steep  34/14 16.3 g         8.8 g      at 0.35   ← over capacity
 *
 * Past the strut's capacity there is nothing left to give: it bottoms out and
 * the chassis keeps going, so the HUB ENDS UP BELOW THE DECK and the drawn wheel
 * with it (0.25–0.31 m under, tools/roadHoldSinkDiag.mjs). That is the "the car
 * wheels enter inside the road a lot on the slopes" report, and note where it
 * came from: the entry to a CLIMB, not the crest anybody was looking at.
 *
 * So the trade was real but backwards — it spent the concave half's budget,
 * which was nearly exhausted, to buy margin for the convex half, which had 5 g
 * to spare and now has ROAD_HOLD besides. Symmetric splits the difference at
 * 9.2 g / 11.4 g on those two pieces, inside both ceilings.
 *
 * (The exactly-balanced-against-capacity split is 0.467 rather than 0.5. That is
 * a 7% difference on a pair of ceilings that are themselves approximations, so
 * it is not worth preferring a fitted number over the principled one.)
 */
const SLOPE_CONCAVE_FRAC = 0.5;

/**
 * Slope profile — two parabolic vertical curves, convex half given the long side.
 *
 * WHAT THIS REPLACED AND WHY. It was a cubic smoothstep, and a smoothstep's
 * curvature PEAKS AT ITS ENDS (|f''| = 6 there, falling to 0 in the middle) and
 * then steps discontinuously to the flat road's zero. On a climb that puts the
 * tightest convex curvature the piece owns exactly on the exit seam, which is
 * the worst place for it: crossing a convex curve of radius R at speed v needs
 * v²/R of downward acceleration, so the car unloads hardest where the road has
 * least warning and then gets released in one step. That is the "the car does
 * not follow the slope, it jumps off flat" — it is airborne before the top, and
 * once airborne TIRE.airTrajectoryAlign pitches the nose onto the ballistic arc
 * rather than the ramp, so it also LOOKS level on the way up.
 *
 * A parabola in height is a CONSTANT-curvature vertical curve, which is what
 * road engineering uses for exactly this problem, and joining two of them is
 * the minimum-peak-curvature shape for fixed ends and level tangents: |f''| = 4
 * against the smoothstep's 6. Then spend the length where it buys something —
 * the two halves are not equally dangerous, since on a climb the first half is
 * CONCAVE (a compression the suspension and SURFACE_GRIP absorb between them)
 * and only the second half can throw the car:
 *
 *     split   concave |f''|   convex |f''|
 *      0.50        4.00           4.00
 *      0.35        5.71           3.08      <- shipped
 *      0.25        8.00           2.67
 *
 * The split flips with the sign of the rise, so a descent gets the same
 * treatment mirrored (its convex half is the ENTRY).
 *
 * WHAT IT ACTUALLY BOUGHT, and it is NOT what the curvature figures predict.
 * MEASURED by driving each shape at the same size (tools/gradeFollowTest.mjs),
 * km/h held before the car leaves the deck, smoothstep → this:
 *
 *     Up Gentle  34/5    148 → 108     <- the one that trades DOWN
 *     Up Medium  32/10    72 →  76
 *     Up Steep   34/14    65 →  72
 *     Down Gtl   34/-5   108 → 119
 *     Down Med   32/-10   61 →  68
 *     Down Stp   34/-14   54 →  61
 *
 * A 1.9× curvature advantage bought 6–13%, and on the gentle climb it lost 27%.
 * The suspension is doing far more of the work than curvature alone accounts
 * for: a smoothstep's curvature is concentrated near its seams and near-zero in
 * between, so the unload it produces is BRIEF and 55 cm of travel swallows it
 * whole. A constant-curvature half sustains that unload for its entire length
 * and the travel runs out. Where the peak was never over gravity anyway — which
 * is exactly the gentle climb — brief-and-sharp beats gentle-and-long.
 *
 * SHIPPED ANYWAY, because it raises the FLOOR: 54 → 61 km/h on the worst piece,
 * and the floor is what makes a track unusable. Nobody takes a 5 m rise at
 * 148 km/h; everybody takes a steep descent at 60. If you are tempted to put the
 * smoothstep back for climbs and keep this for descents, note that the two are
 * within 6% at every size except the one nobody drives fast.
 *
 * WHAT IT ALSO COSTS: a constant-curvature climb reaches a steeper peak grade
 * than a smoothstep does for the same rise — 2·H/L against 1.5·H/L — and the
 * car's own thrust ceiling is ~42° (tools/slopeClimbLimit.mjs). The presets are
 * sized against that; steeper than about H/L = 0.42 is a hill the car cannot
 * climb whatever its curvature.
 *
 * Endpoints and end tangents are untouched (0,0,0) → (0, H, −L), level at both
 * ends, so every saved track keeps its connectors exactly and only the shape
 * between them changes.
 */
function slopeShape(t, concaveFrac) {
  const p = concaveFrac;
  // f = t²/p up to the join, then 1 − (1−t)²/(1−p). Both branches pass through
  // (p, p) with slope 2, so f is C1 and f'(0) = f'(1) = 0 exactly.
  if (t <= p) return (t * t) / p;
  const d = 1 - t;
  return 1 - (d * d) / (1 - p);
}

function slopePoints(pp) {
  const L = Math.max(2, pp.slopeLength);
  const H = pp.slopeRise;
  // The convex half always takes the long side; on a descent that is the entry.
  const p = H >= 0 ? SLOPE_CONCAVE_FRAC : 1 - SLOPE_CONCAVE_FRAC;
  // Pitch swings 0 → peak grade → 0, and the parabola's peak grade is 2·H/L, so
  // pass the total direction change through stepsFor — length-only stepping put
  // ~5° of pitch per step on a typical slope and the kerbs showed every facet.
  const swing = 2 * Math.atan((2 * Math.abs(H)) / L);
  const n = stepsFor(L, swing, 8, pp);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const tt = i / n;
    pts.push(new V3(0, H * slopeShape(tt, p), -L * tt));
  }
  return pts;
}

/**
 * Sweep a centreline by integrating a PITCH angle along it.
 *
 * `pitchAt(t)` is the deck's pitch in radians at t = s/L, where s is ARC LENGTH
 * — so `L` is the length of road, not a horizontal run. That is the right
 * parameterisation for a piece whose job is a change of DIRECTION (the whole
 * point of a vertical curve is the angle it absorbs); `slope` and `crest` go the
 * other way and stay exact functions of the horizontal run, because their
 * contract is "rise H over run L".
 *
 * Midpoint rule rather than the endpoint rule the jump/dive ramps use: it is
 * second-order, so the exit lands on the analytic tangent instead of drifting
 * toward it as the step count falls.
 */
function integratePitch(L, n, pitchAt) {
  const ds = L / n;
  const cur = new V3(0, 0, 0);
  const pts = [cur.clone()];
  for (let i = 1; i <= n; i++) {
    const ph = pitchAt((i - 0.5) / n);
    cur.y += Math.sin(ph) * ds;
    cur.z += -Math.cos(ph) * ds;
    pts.push(cur.clone());
  }
  return pts;
}

/** Grade angle in radians, clamped to what the car can actually climb.
 *
 *  The ceiling is the REAR TYRE, not the engine: RWD drive is capped at
 *  μ·N_rear, which runs out around 42° (tools/slopeClimbLimit.mjs). 35° leaves
 *  margin for the load the transition's own curvature takes off the axle. */
function gradeAngleRad(pp) {
  const a = pp.gradeAngle ?? pieceParams.gradeAngle;
  return THREE.MathUtils.degToRad(THREE.MathUtils.clamp(a, -35, 35));
}

/** Length of a grade transition. DERIVED — see gradeCurvePoints. */
function gradeCurveLength(pp) {
  const ang = Math.abs(gradeAngleRad(pp));
  const R = Math.max(10, pp.gradeRadius ?? pieceParams.gradeRadius);
  return Math.max(4, 2 * ang * R);
}

/**
 * VERTICAL CURVE — the piece that turns level road into graded road, or back.
 *
 * PARAMETERISED BY RADIUS, because radius is the only number that decides
 * whether the car can follow it (see the gradeAngle block in pieceParams). The
 * LENGTH is derived, and has to be: a transition that absorbs θ over length L
 * has mean curvature θ/L, so L, θ and R cannot all be chosen independently.
 *
 * The curvature is a BUMP, not a step:
 *
 *     κ(s) = (1/R)·sin²(π·s/L)
 *
 * which integrates to a pitch of φ(t) = θ·(t − sin(2πt)/2π) and pins the length
 * at L = 2·θ·R by requiring φ(1) = θ. Two things fall out of that shape:
 *
 *  • κ IS ZERO AT BOTH SEAMS, so the piece is C² against the flat road on one
 *    side and the constant grade on the other. There is no step in the load the
 *    tyres carry at either end — which is the failure mode `slope` has and
 *    cannot avoid, because a slope's curvature has nowhere to go but its seams.
 *  • THE PEAK IS EXACTLY 1/R, so `gradeRadius` is not a nominal figure: it is
 *    the tightest radius in the piece, and √(g·R) is the speed it holds to.
 *
 * A sine-squared bump costs twice the length of a circular arc turning the same
 * angle. That is the price of the C² seams and it is worth paying here, because
 * unlike a slope this piece is not trying to be compact — the STRAIGHTS after it
 * gain the height, at zero curvature, for as long as you want.
 */
function gradeCurvePoints(pp, out) {
  const ang = gradeAngleRad(pp);
  const L = gradeCurveLength(pp);
  const n = stepsFor(L, Math.abs(ang), 8, pp);
  const TAU = 2 * Math.PI;
  // φ(t) = θ·(t − sin(2πt)/2π), reversed for the exit transition.
  const ramp = (t) => ang * (t - Math.sin(TAU * t) / TAU);
  return integratePitch(L, n, out ? (t) => ang - ramp(t) : ramp);
}

function gradeInPoints(pp) {
  return gradeCurvePoints(pp, false);
}

function gradeOutPoints(pp) {
  return gradeCurvePoints(pp, true);
}

/**
 * The constant-grade straight between the two transitions.
 *
 * Deliberately a plain straight in piece-local space. The pitch is not authored
 * here — it is INHERITED, because `world = currentConnector · entryLocal⁻¹`
 * carries the incoming connector's full 3-D frame, so dropped after a Grade in
 * this climbs at exactly that grade with zero vertical curvature. Which is the
 * whole point: zero curvature is followable at any speed, so this is the piece
 * that actually gains the height.
 *
 * It exists as its own tile rather than telling people to reach for `straight`
 * for the same reason `banktilt` does next to a rolled straight: the trio reads
 * as a family in the palette, and "Climb" says what it is for.
 */
function gradePoints(pp) {
  return straightLinePoints(pp.gradeLength ?? pieceParams.gradeLength);
}

/**
 * Constant lean across the whole piece. Holding the bank (rather than easing to
 * 0 at the ends) means consecutive banked curves keep a single continuous lean
 * with no flatten/crease at the seam. Use the Bank-in / Bank-out transitions to
 * ramp to and from a flat (level) piece.
 */
function bankRoll(t, pp) {
  const dir = pp.curveDir >= 0 ? 1 : -1;
  return dir * THREE.MathUtils.degToRad(pp.bankAngle);
}

/** Straight that ramps the lean 0 → bankAngle (flat → banked entry). */
function bankInRoll(t, pp) {
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const a = THREE.MathUtils.degToRad(pp.bankAngle);
  return dir * a * smoother(t);
}

/** Straight that ramps the lean bankAngle → 0 (banked → flat exit). */
function bankOutRoll(t, pp) {
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const a = THREE.MathUtils.degToRad(pp.bankAngle);
  return dir * a * (1 - smoother(t));
}

/**
 * CHICANE: the lean crosses sides without the road ever flattening out.
 *
 * The only way to get from a right-hand banked turn to a left-hand one was
 * Bank out → Bank in: settle the deck to flat, then roll it up the other way.
 * That is two pieces and, more to the point, a stretch of FLAT ROAD in the
 * middle of what should be one continuous change of direction — the car
 * un-banks, drives level, and re-banks. This is the same swap as one motion.
 *
 * Same easing as the other two so it seams with them: `smoother` is C2, so the
 * roll rate is zero at both ends and a chicane butts onto a held-bank turn with
 * no crease.
 */
function bankSwapRoll(t, pp) {
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const a = THREE.MathUtils.degToRad(pp.bankAngle);
  return dir * a * (1 - 2 * smoother(t)); // +a → −a
}
/** Curl fraction for the chicane — unsigned, so it dips to flat at the swap. */
function bankCurlSwap(t) {
  return Math.abs(1 - 2 * smoother(t));
}

/*
 * BANK FAMILY — the Apex-Rush model, three rules working together:
 *
 *  1. LOW-EDGE PIVOT. The centreline rises by hw·sin(lean) while the roll drops
 *     one side by the same amount, so the deck curls UP from the connector
 *     plane like a wave and never dips below it.
 *  2. TURNS HOLD the bank; the STRAIGHT Up/Down pieces do the transitions
 *     (no rise-hold-fall hump inside a single turn — that read as a bump).
 *  3. LEVEL SOCKETS (def.sockets): connectors carry position + heading only,
 *     never the roll. A held-bank piece dropped on a FLAT connector sits
 *     upright exactly as authored (the old rolled sockets rigidly un-rolled
 *     the piece and pitched its exit out of plane). Seams between bank pieces
 *     still match because they all share the same raised/rolled cross-section.
 */

/*
 * CURL FRACTION — how much of `pp.bankCurl` this piece's deck is carrying at t.
 *
 * Each one MUST be the same easing as that piece's ROLL function, or the deck
 * curls at a different rate than it leans and the two disagree in the middle of
 * the piece. Pairs: bankCurlIn↔bankInRoll, bankCurlOut↔bankOutRoll,
 * bankCurlHold↔bankRoll. They are unsigned — the curl is symmetric about the
 * centreline, so unlike the roll it does not care which way the corner goes.
 */
function bankCurlHold() {
  return 1;
}
function bankCurlIn(t) {
  return smoother(t);
}
function bankCurlOut(t) {
  return 1 - smoother(t);
}

/** Low-edge raise for a given lean (m above the connector plane). */
function bankRaise(pp, frac = 1) {
  const bank = THREE.MathUtils.degToRad(Math.abs(pp.bankAngle));
  return (roadParams.width / 2) * Math.sin(bank * frac);
}

/** How long a Bank in / Bank out ramp is. Falls back to `straightLength` for
 *  tracks saved before bankRampLength existed — those pieces were authored at
 *  the straight's length and must reload at exactly that, or every bank
 *  transition in an old track changes size and the chain after it moves. */
function bankRampLength(pp) {
  return Math.max(1, pp.bankRampLength ?? pp.straightLength);
}

/** Bank-in straight: deck curls up 0 → bankAngle (C2, matches bankInRoll). */
function bankInPoints(pp) {
  const L = bankRampLength(pp);
  const bank = THREE.MathUtils.degToRad(Math.abs(pp.bankAngle));
  const n = stepsFor(L, bank, 12);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(new V3(0, bankRaise(pp, smoother(t)), -L * t));
  }
  return pts;
}

/** Bank-out straight: deck settles bankAngle → 0 (C2, matches bankOutRoll). */
function bankOutPoints(pp) {
  const L = bankRampLength(pp);
  const bank = THREE.MathUtils.degToRad(Math.abs(pp.bankAngle));
  const n = stepsFor(L, bank, 12);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push(new V3(0, bankRaise(pp, 1 - smoother(t)), -L * t));
  }
  return pts;
}

/** Held-bank straight: constant lean, centreline held at the full raise. */
function bankHoldPoints(pp) {
  return straightLinePoints(pp.straightLength, bankRaise(pp));
}

/**
 * Chicane centreline — HELD AT THE FULL RAISE, not dipped to the plane.
 *
 * The obvious reading of rule 1 (centreline rises by hw·sin lean) says the raise
 * should follow the lean MAGNITUDE, dipping to the plane where the deck passes
 * through flat. It should not, and the reason is that |lean| has a corner where
 * the lean crosses zero: raise ∝ |1 − 2·smoother(t)| is a V, and the centreline
 * inherits it. MEASURED at the kit's 22° over a 44 m ramp (tools/bankChicaneTest.mjs),
 * that V bends the centreline through 29.2° at the crossing — a crease you can
 * see and a bump the car hits, in the one spot the whole piece exists to smooth
 * out. The shipped centreline measures 0.000°.
 *
 * Holding the centreline flat at `bankRaise` removes every absolute value from
 * the geometry: the deck simply rotates about its own axis and the two edges
 * trade places, each tracing hw·sin(θ(t)) — smooth, because θ is smooth and
 * nothing takes its magnitude. It also matches the neighbours exactly, since a
 * bank-in ends at the full raise and a held-bank turn sits at it.
 *
 * The cost is that the low edge lifts to the raise at the crossover instead of
 * staying on the plane. That is the correct trade: the deck is momentarily flat
 * there, so there is no "low edge" to keep down, and rule 1 has nothing to say.
 *
 * Stations rather than the two-point straight, because the ROLL varies along it
 * — see the warning on straightLinePoints.
 */
function bankSwapPoints(pp) {
  const L = bankRampLength(pp);
  const bank = THREE.MathUtils.degToRad(Math.abs(pp.bankAngle));
  // It rolls through twice the angle (+a → −a), so it earns twice the stations.
  const n = stepsFor(L, 2 * bank, 12);
  const y = bankRaise(pp);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, y, -L * (i / n)));
  return pts;
}

/** Held-bank turn: flat arc at the full raise, constant lean (Short/Long Turn). */
function bankedHoldCurvePoints(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 180));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const n = stepsFor(R * A, A, 24);
  const y = bankRaise(pp);
  const center = new V3(dir * R, 0, 0);
  const radius0 = new V3(-dir * R, 0, 0); // origin - center
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const pt = center.clone().add(rotateY(radius0, -dir * A * (i / n)));
    pt.y = y;
    pts.push(pt);
  }
  return pts;
}

/**
 * Held-bank turn that ALSO climbs — the one thing the bank family could not do.
 *
 * `bankedHoldCurvePoints` pins the centreline at a constant `bankRaise`, so a
 * banked corner can never change altitude: every banked section in a track sits
 * on one flat plane and has to be un-banked, climbed, and re-banked to get off
 * it. This is the same arc with the raise plus a rise on top.
 *
 * SMOOTHSTEPPED, not linear, and that is deliberate — it is the `slope` trick
 * rather than the `spiral` one. dy/dt is zero at both ends, so the piece enters
 * and leaves HORIZONTAL: `curveEndTangents` stays exact, the level sockets below
 * stay honest, and dropping one between a Bank in and a Bank out gains height
 * without pitching anything downstream. A constant-grade helix would stack more
 * cleanly, but `spiral` already covers that for flat road and it would pitch the
 * exit connector — which is the whole thing we are avoiding.
 */
function bankedClimbCurvePoints(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 180));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const rise = pp.bankRise ?? 0;
  const arc = R * A;
  // The pitch swings 0 → peak → 0 on top of the plan turn, so both go through
  // stepsFor or a steep short climb facets the deck (same reason as slopePoints).
  const swing = A + 2 * Math.atan((1.5 * Math.abs(rise)) / Math.max(1, arc));
  const n = stepsFor(arc, swing, 24);
  const y0 = bankRaise(pp);
  const center = new V3(dir * R, 0, 0);
  const radius0 = new V3(-dir * R, 0, 0); // origin - center
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const pt = center.clone().add(rotateY(radius0, -dir * A * t));
    const sm = t * t * (3 - 2 * t); // smoothstep — horizontal tangents at both ends
    pt.y = y0 + rise * sm; // rotateY preserves y, so set the climb after
    pts.push(pt);
  }
  return pts;
}

/** Level sockets for a HELD-bank straight (entry plane → exit plane). */
function bankStraightSockets(pp) {
  return bankLevelSockets(Math.max(1, pp.straightLength));
}

/** Level sockets for a bank RAMP — same thing at the ramp's own length. Not
 *  shared with the held-bank straight above, because the two pieces no longer
 *  measure themselves with the same number, and a socket that disagrees with
 *  its piece's geometry puts the whole rest of the chain in the wrong place. */
function bankRampSockets(pp) {
  return bankLevelSockets(bankRampLength(pp));
}

function bankLevelSockets(L) {
  const fwd = new V3(0, 0, -1);
  return { entryPos: new V3(0, 0, 0), entryDir: fwd.clone(), exitPos: new V3(0, 0, -L), exitDir: fwd.clone() };
}

/** Level sockets for the held-bank turn: the flat arc projected to the plane. */
function bankedCurveSockets(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 180));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const center = new V3(dir * R, 0, 0);
  const exitPos = center.clone().add(rotateY(new V3(-dir * R, 0, 0), -dir * A));
  return {
    entryPos: new V3(0, 0, 0),
    entryDir: new V3(0, 0, -1),
    exitPos,
    exitDir: rotateY(new V3(0, 0, -1), -dir * A),
  };
}

/** Level sockets for the CLIMBING banked turn: the same projected arc, with the
 *  exit lifted by the height the piece actually gained. Its own function rather
 *  than a flag on the one above, because a socket that disagrees with its
 *  piece's geometry puts the whole rest of the chain in the wrong place. */
function bankedClimbSockets(pp) {
  const s = bankedCurveSockets(pp);
  s.exitPos.y += pp.bankRise ?? 0;
  return s;
}

/** Chicane: turn `curveAngle` one way then back the other, ending parallel. */
/**
 * LINK — road that joins the end you are building from to a fixed end somewhere
 * else, hitting BOTH position and heading exactly.
 *
 * Why this piece has to exist at all: a chain is a RIGID sequence, so its
 * end-to-end transform is fixed by the pieces in it. You can weld one end to a
 * target (`anchor = target · T⁻¹`) but not both — unless the pieces you happened
 * to place add up to exactly the right span AND heading. Rejoining a merge pins
 * both ends, so something in the middle has to solve for whatever is left over.
 *
 * A CUBIC HERMITE, not a Dubins arc–straight–arc. Hermite interpolation hits
 * both endpoints with both tangents by construction, in closed form, with no
 * solver to converge and no case analysis — and it takes a height difference in
 * its stride, which a planar Dubins solution does not. What it gives up is
 * constant curvature: the arc is not the tightest possible path, and a hard ask
 * (target behind you, or far off to one side) bunches the curvature near the
 * ends. `linkCurvature` reports the worst radius so a caller can say "that is
 * too tight to drive" instead of silently building a hairpin.
 *
 * The tangents are scaled by `linkTension × distance`. That is the standard
 * Cardinal-spline trick: scaling both by the chord keeps the shape similar as
 * the gap grows, so one tension value works at 20 m and at 200 m.
 */
function _linkTarget(pp) {
  const yaw = THREE.MathUtils.degToRad(pp.linkYawDeg ?? 0);
  return {
    p1: new V3(pp.linkX ?? 0, pp.linkY ?? 0, pp.linkZ ?? -48),
    // Travel direction for a heading, matching the convention every other piece
    // uses (see sCurvePoints): yaw 0 is −Z.
    d1: new V3(-Math.sin(yaw), 0, -Math.cos(yaw)),
  };
}

/**
 * Tangent magnitude for the Hermite — DERIVED FROM THE TURN, not a flat
 * fraction of the distance.
 *
 * This is the whole difference between a usable link and a cusp. A cubic hits
 * its endpoint tangents whatever magnitude you give them, but too SHORT and it
 * has to whip round near the ends to make up the heading: at 0.55 × distance a
 * 48° join over 26 m measured a 2.4 m radius at t=0 (second derivative), while
 * the curve through the middle looked perfectly reasonable. The geometry was
 * fine; the parameterisation was starved.
 *
 * So take the magnitude a circular arc would want. For a chord `d` subtending a
 * turn θ the arc radius is d / (2 sin(θ/2)), and the classic cubic-Bézier
 * approximation to an arc puts its control points (4/3)·R·tan(θ/4) along the
 * tangents — three times that for a Hermite, since P'(0) = 3(P₁ − P₀) for a
 * Bézier. It degenerates correctly: as θ → 0 it tends to the chord length (a
 * straight line), and at θ → π it tops out at 2 d.
 */
function _linkTangentScale(dist, turn) {
  if (turn < 1e-3) return dist;
  const R = dist / (2 * Math.sin(turn / 2));
  return 4 * R * Math.tan(turn / 4);
}

function linkPoints(pp) {
  const { p1, d1 } = _linkTarget(pp);
  const d0 = new V3(0, 0, -1); // entry travel
  const dist = Math.max(1e-3, p1.length());
  const turn0 = Math.acos(THREE.MathUtils.clamp(d0.dot(d1), -1, 1));
  const k = THREE.MathUtils.clamp(pp.linkTension ?? 1, 0.1, 3)
    * _linkTangentScale(dist, turn0);
  const m0 = d0.clone().multiplyScalar(k);
  const m1 = d1.clone().multiplyScalar(k);

  // Segment count from the chord plus the total heading change, so a tight
  // join is tessellated as finely as a long lazy one.
  const turn = Math.acos(THREE.MathUtils.clamp(d0.dot(d1), -1, 1));
  const n = stepsFor(dist * 1.35, turn, 6);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const t2 = t * t;
    const t3 = t2 * t;
    // Standard cubic Hermite basis.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    pts.push(new V3(
      h10 * m0.x + h01 * p1.x + h11 * m1.x,
      h10 * m0.y + h01 * p1.y + h11 * m1.y,
      h00 * 0 + h10 * m0.z + h01 * p1.z + h11 * m1.z,
    ));
  }
  // Land the ends on EXACTLY the poses asked for — floating point in the basis
  // sum is not worth arguing with when the whole point is a seam that closes.
  pts[0].set(0, 0, 0);
  pts[pts.length - 1].copy(p1);
  return pts;
}

/** Declared sockets, so the exit IS the target rather than whatever the swept
 *  frames happened to end at. This is what makes the seam exact. */
function linkSockets(pp) {
  const { p1, d1 } = _linkTarget(pp);
  return {
    entryPos: new V3(0, 0, 0), entryDir: new V3(0, 0, -1),
    exitPos: p1.clone(), exitDir: d1.clone(),
  };
}

/**
 * Tightest radius along a link, in metres (Infinity for a straight one).
 * Lets the editor refuse — or at least warn about — a join no car could take.
 */
export function linkCurvature(pp) {
  const pts = linkPoints(pp);
  let worst = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const ab = a.distanceTo(b), bc = b.distanceTo(c), ca = c.distanceTo(a);
    // Menger curvature: R = abc / 4A, with A from the cross product.
    const area = new V3().subVectors(b, a).cross(new V3().subVectors(c, a)).length() / 2;
    if (area < 1e-9) continue; // collinear here — locally straight
    worst = Math.min(worst, (ab * bc * ca) / (4 * area));
  }
  return worst;
}

function sCurvePoints(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 120));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const half = stepsFor(R * A, A, 2, pp);
  const ds = (R * A) / half;
  const dth = A / half;
  const pts = [new V3(0, 0, 0)];
  const pos = new V3(0, 0, 0);
  let yaw = 0;
  const run = (sign) => {
    for (let i = 0; i < half; i++) {
      yaw += sign * dir * dth;
      pos.x += -Math.sin(yaw) * ds;
      pos.z += -Math.cos(yaw) * ds;
      pts.push(pos.clone());
    }
  };
  run(+1); // turn out by A
  run(-1); // turn back by A → heading returns to -Z, laterally offset
  return pts;
}

/**
 * Fraction of a crest's run given to EACH of its two concave shoulders.
 *
 * 0.25 makes all three segments equally curved — the minimum-peak shape.
 *
 * IT WAS 0.18, squeezing the shoulders to buy the brow a bigger radius, and it
 * failed for exactly the reason SLOPE_CONCAVE_FRAC's 0.35 did (read that note
 * first — it is the same mistake and the same measurement). At 0.18 the Hill
 * preset's shoulders came out at R 14.8 m, which at 48 m/s is a 15.9 g
 * compression against a strut that can carry 14.5, so the hub went 0.31 m
 * through the deck on the way ONTO the crest. The brow it bought — 8.9 g — was
 * comfortably inside ROAD_HOLD's ceiling either way.
 *
 * At 0.25 both come out at 11.4 g on that preset: under the strut's 14.5 and
 * under the hold's 12.7, which is the only arrangement where neither end of the
 * piece is over its own budget.
 */
const CREST_SHOULDER_FRAC = 0.25;

/**
 * Crest / dip profile: a long convex middle between two short concave shoulders.
 *
 * A crest has to turn the car up and then back down inside its own length, so
 * unlike a slope its total direction change is fixed by H and L and no profile
 * can avoid it. What a profile CAN choose is where the curvature sits, and a
 * crest's two kinds of curvature are not equally costly: the shoulders are
 * concave (compression — the suspension and SURFACE_GRIP absorb it) and only the
 * middle, over the brow, can throw the car off the road.
 *
 * This replaced sin², which spread it evenly and so put 19.7·H/L² of convex
 * curvature over the brow — a 6.5 m crest radius on the shipped Hill preset,
 * i.e. a takeoff ramp above 29 km/h. Squeezing the shoulders and stretching the
 * middle buys the brow a bigger radius for a tighter compression:
 *
 *     shoulder   shoulder |f''|   brow |f''|
 *       0.25          16.0           16.0
 *       0.18          22.2           12.5     <- shipped
 *       0.10          40.0           10.0
 *
 * MEASURED (tools/gradeFollowTest.mjs), km/h held before the car takes off, sin²
 * → this, at the same size — and unlike `slope` it is a win with no trade:
 *
 *     32/8    32 → 47        32/-8 (dip)   36 → 40
 *     48/7    54 → 65        48/-7 (dip)   58 → 61
 *     48/4    72 → 79
 *
 * The asymmetry is the whole of it: a symmetric three-parabola (shoulder 0.25,
 * the minimum-PEAK shape) measures 40 / 58 / 72 / 36 / 58 — i.e. barely better
 * than sin². Moving curvature onto the compression side is what pays.
 *
 * The shoulder fraction flips with the sign of the rise, for the same reason
 * `slope`'s split does: a DIP is this shape upside down, so its convex parts are
 * the two shoulders and it wants the length spent there instead. Both signs end
 * up with the same convex curvature, so a Dip is exactly a Hill mirrored.
 *
 * Curvature is piecewise constant (three parabolas), so like `slope` this is a
 * vertical curve in the road-engineering sense. Ends stay at y = 0 and the peak
 * at exactly H, level tangents at both ends, so saved tracks keep their seams.
 *
 * It is still, unavoidably, a jump if you build it short and tall — a crest is
 * that shape. The Slopes presets are sized so the shipped ones are not, and the
 * palette tooltip reports the speed each one can actually be followed at.
 */
function crestShape(t, q) {
  const u = t > 0.5 ? 1 - t : t; // symmetric about the brow
  if (u <= q) return (2 / q) * u * u; // shoulder: f'' = +4/q, reaches f' = 4
  const d = u - q;
  return 2 * q + 4 * d - (2 / (0.5 - q)) * d * d; // brow: f'' = −4/(0.5−q)
}

function crestPoints(pp) {
  const L = Math.max(2, pp.slopeLength);
  const H = pp.slopeRise;
  // Hill: the brow is convex and wants the middle. Dip: the shoulders are.
  const q = H >= 0 ? CREST_SHOULDER_FRAC : 0.5 - CREST_SHOULDER_FRAC;
  // Peak grade is 4·H/L (the shoulders run f' up to 4), and the pitch swings
  // up-over-down-out — ~4× the peak angle of total direction change. Cap the
  // per-step bend via stepsFor or the kerbs show every facet.
  const swing = 4 * Math.atan((4 * Math.abs(H)) / L);
  const n = stepsFor(L, swing, 8, pp);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const tt = i / n;
    pts.push(new V3(0, H * crestShape(tt, q), -L * tt));
  }
  return pts;
}

/** Launch ramp: pitches up from horizontal to jumpAngle at the exit. */
function jumpPoints(pp) {
  const L = Math.max(2, pp.jumpLength);
  const ang = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.jumpAngle, 0, 80));
  const n = stepsFor(L, ang);
  const ds = L / n;
  const cur = new V3(0, 0, 0);
  const pts = [cur.clone()];
  for (let i = 1; i <= n; i++) {
    const ph = ang * (i / n) * (i / n); // ease-in: horizontal at start
    cur.y += Math.sin(ph) * ds;
    cur.z += -Math.cos(ph) * ds;
    pts.push(cur.clone());
  }
  return pts;
}

/** Dive ramp: vertical mirror of the jump — flat at the start, pitches DOWN to
 * diveAngle at the exit so the track crests an edge and keeps heading downhill. */
function divePoints(pp) {
  const L = Math.max(2, pp.diveLength);
  const ang = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.diveAngle, 0, 80));
  const n = stepsFor(L, ang);
  const ds = L / n;
  const cur = new V3(0, 0, 0);
  const pts = [cur.clone()];
  for (let i = 1; i <= n; i++) {
    const ph = -ang * (i / n) * (i / n); // ease-in: horizontal at start, pitched down at exit
    cur.y += Math.sin(ph) * ds;
    cur.z += -Math.cos(ph) * ds;
    pts.push(cur.clone());
  }
  return pts;
}

/**
 * One side of a *drivable* vertical loop: ground → over the top, built by
 * integrating a pitch angle from horizontal (0) to inverted (π). Two fixes over
 * a plain semicircle: (1) the radius tightens toward the top (`loopTighten`) so
 * the silhouette is a teardrop/clothoid, not a perfect ring; (2) the path drifts
 * laterally (`loopOffset`) so when you place this piece then its mirror (R /
 * curveDir flip), the climbing and descending lanes sit side-by-side instead of
 * colliding — a loop a car can actually drive. curveDir picks the lateral side.
 */
/**
 * Half of the EXACT same looping as `loopPoints` — just sliced. `loopHalf='in'`
 * gives the entry-foot→top portion (flat foot on the floor → inverted at top);
 * `loopHalf='out'` gives top→exit-foot. The shared `loopFixFrames` keeps both
 * feet flat. Place the 'in' half then its mirror ('out', curveDir flipped) to
 * build the full looping from two pieces.
 */
function loopHalfPoints(pp) {
  return loopPoints(pp); // loopPoints honours pp.loopHalf to emit only one side
}

/**
 * Full drivable LOOPING in one piece. A complete 360° vertical circle (Y/Z plane)
 * that also drifts sideways (X) as it goes around, so the entry foot and exit foot
 * both sit FLAT on the floor (y=0) but separated by `loopOffset` along the red (X)
 * axis — they don't meet. `loopStretch` (default 0) also walks the ring forward
 * along −Z. Stretch 0 keeps the full circular silhouette; a large stretch
 * collapses the backswing and the hole shrinks. The offset-looping tile opens
 * the gap with a large `loopOffset` and even `loopSpread` instead.
 */
function loopPoints(pp) {
  const R = Math.max(6, pp.loopRadius);
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const gap = pp.loopOffset ?? roadParams.width; // sideways foot gap (red axis, m)
  const flat = Math.max(0, pp.loopFlat ?? R * 0.5); // flat lead-in / lead-out (m)
  const spread = THREE.MathUtils.clamp(pp.loopSpread ?? 1, 0, 1); // gap concentration at feet
  const lean = THREE.MathUtils.clamp(pp.loopLean ?? 0, -1, 1); // ring-plane tilt
  const pinch = THREE.MathUtils.clamp(pp.loopTighten ?? 0, 0, 0.7); // teardrop pinch
  const stretch = Math.max(0, pp.loopStretch ?? 0); // forward foot gap along −Z (m)
  // half: undefined/'full' = whole loop; 'in' = entry foot → top; 'out' = top → exit foot.
  const half = pp.loopHalf;
  const segN = Math.max(1, Math.ceil(Math.max(0.001, flat) / roadParams.segLen));
  // Full 360° of bend — honor the per-step angle cap (the old floor of 96 was
  // 3.75°/step, visibly faceted on the ring silhouette).
  const ringN = stepsFor(2 * Math.PI * R, 2 * Math.PI, 96);
  const pts = [];

  // Sideways offset across the FULL ring (θ over 0..2π). Zero slope at both feet
  // so they sit flat. A half just samples its portion of this same curve, so the
  // halves are literally slices of the full looping.
  const S1 = (u) => u * u * (3 - 2 * u);
  const S2 = (u) => u * u * u * (u * (u * 6 - 15) + 10);
  const xAt = (u) => {
    const s = (1 - spread) * S1(u) + spread * S2(u); // u: 0 (entry) → 1 (exit)
    return -gap / 2 + gap * s;
  };
  // Ring point at full-loop parameter u ∈ [0,1].
  const ringPt = (u) => {
    const theta = 2 * Math.PI * u;
    const r = R * (1 - pinch * Math.sin(Math.PI * u));
    const y = r * (1 - Math.cos(theta));
    const z = -flat - dir * r * Math.sin(theta) + lean * y - stretch * u;
    return new V3(xAt(u), y, z);
  };

  const hN = stepsFor(Math.PI * R, Math.PI, 48); // 180° of bend under the angle cap
  if (half === "in") {
    // Entry foot → top. Flat lead-in from origin heading -Z (same as the full
    // loop's start), then the first half of the ring (u: 0 → 0.5). Top left open.
    const entry = ringPt(0); // foot, on the floor at (-gap/2, 0, -flat)
    for (let i = 0; i < segN; i++) pts.push(new V3(entry.x, 0, -flat * (i / segN)));
    for (let i = 0; i <= hN; i++) pts.push(ringPt(0.5 * (i / hN)));
    return pts;
  }
  if (half === "out") {
    // Top → exit foot, then flat lead-out continuing -Z (same as the full loop's
    // end). Entry is the inverted top — meant to snap onto an "in" half's top.
    const exit = ringPt(1); // foot, on the floor at (+gap/2, 0, -flat − stretch)
    for (let i = 0; i <= hN; i++) pts.push(ringPt(0.5 + 0.5 * (i / hN)));
    for (let i = 1; i <= segN; i++) pts.push(new V3(exit.x, 0, exit.z - flat * (i / segN)));
    return pts;
  }

  // Full loop: flat lead-in, the ring, flat lead-out. Lead-out continues from
  // the ring's actual exit (which walks forward when stretch > 0) rather than
  // assuming the compact looping's z = −flat.
  const exit = ringPt(1);
  for (let i = 0; i < segN; i++) pts.push(new V3(-gap / 2, 0, -flat * (i / segN)));
  for (let i = 0; i <= ringN; i++) pts.push(ringPt(i / ringN));
  for (let i = 1; i <= segN; i++) pts.push(new V3(exit.x, 0, exit.z - flat * (i / segN)));
  return pts;
}

/**
 * Override the loop's frame up-vectors AFTER transport. Parallel transport rolls
 * (banks) the road as the circle drifts sideways, which tilts the feet so one
 * edge digs into the ground. Instead we set up explicitly to point from each road
 * point toward the ring's central axis: straight up at the feet (flat), inverted
 * at the top, facing inward on the sides — independent of the sideways drift, so
 * BOTH feet stay perfectly flat for any gap. Lead-in / lead-out frames get +Y.
 */
function loopFixFrames(frames, pp) {
  const R = Math.max(6, pp.loopRadius);
  const flat = Math.max(0, pp.loopFlat ?? R * 0.5);
  const stretch = Math.max(0, pp.loopStretch ?? 0);
  // A frame is "on the ring" when it's clearly above the floor; flat foot leads
  // (y≈0) keep world-up. This works for the full loop AND either half slice
  // without index bookkeeping. The ring centre sits at y=R and shares the
  // frame's own x (the ring is swept sideways rigidly). With stretch it also
  // walks forward, recovered from height + whether we are still climbing.
  const worldUp = new V3(0, 1, 0);
  const up = new V3();
  const right = new V3();
  const onRingY = 0.05 * R; // height above which we treat the frame as ring
  for (const fr of frames) {
    const T = fr.tangent;
    if (fr.pos.y <= onRingY) {
      up.copy(worldUp).addScaledVector(T, -worldUp.dot(T)); // flat foot
    } else {
      let zCenter = -flat;
      if (stretch > 0) {
        const c = THREE.MathUtils.clamp(1 - fr.pos.y / R, -1, 1);
        let theta = Math.acos(c);
        if (T.y < 0) theta = 2 * Math.PI - theta;
        zCenter = -flat - stretch * (theta / (2 * Math.PI));
      }
      up.set(fr.pos.x, R, zCenter).sub(fr.pos); // toward ring centre
      up.addScaledVector(T, -up.dot(T));
    }
    if (up.lengthSq() < 1e-9) up.copy(worldUp);
    up.normalize();
    right.crossVectors(T, up).normalize();
    fr.up.copy(up);
    fr.right.copy(right);
  }
}

/**
 * Climbing helix ramp — winds around a VERTICAL axis while climbing, like a
 * parking-garage ramp or spiral staircase: starts FLAT on the ground heading -Z,
 * spirals up `loopSpiralTurns` revolutions, and ends FLAT at height `loopSpiralRise`.
 * The climb uses smoothstep so the vertical tangent is 0 at both ends → entry and
 * exit are level. curveDir picks the turn direction. Paired with loopSpiralFixFrames
 * (up = world-up) so the deck stays level across its width (a drivable ramp).
 */
function loopSpiralPoints(pp) {
  const R = Math.max(4, pp.loopSpiralRadius ?? 12);
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const turns = Math.max(0.25, pp.loopSpiralTurns ?? 1);
  const rise = pp.loopSpiralRise ?? R * 2.6; // total height gained over the helix
  const A = 2 * Math.PI * turns; // total turn angle about the vertical axis
  const center = new V3(dir * R, 0, 0); // turn centre (origin starts on the rim)
  const radius0 = new V3(-dir * R, 0, 0); // origin - center
  const smooth = (u) => u * u * (3 - 2 * u); // ease climb in/out → flat ends
  const n = stepsFor(R * A, A, 64, pp); // A can exceed 540° — angle cap must apply
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const pt = center.clone().add(rotateY(radius0, -dir * A * u)); // horizontal turn
    pt.y = rise * smooth(u); // climb, flat at both ends
    pts.push(pt);
  }
  return pts;
}

/**
 * Keep the spiral-ramp deck level across its width: up = world up (perpendicular
 * to the tangent), so the road banks neither inward nor outward — a normal
 * drivable ramp, not a banked/corkscrew one.
 */
function loopSpiralFixFrames(frames) {
  const worldUp = new V3(0, 1, 0);
  const up = new V3();
  const right = new V3();
  for (const fr of frames) {
    const T = fr.tangent;
    up.copy(worldUp).addScaledVector(T, -worldUp.dot(T));
    if (up.lengthSq() < 1e-9) up.copy(worldUp);
    up.normalize();
    right.crossVectors(T, up).normalize();
    fr.up.copy(up);
    fr.right.copy(right);
  }
}

function gameLinePoints(pp) {
  const L = Math.max(4, pp.gameLineLength ?? 16);
  const n = Math.max(2, Math.ceil(L / roadParams.segLen));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -L * (i / n)));
  return pts;
}

/**
 * Quarter-pipe: the centreline is a circular arc in the vertical (Y/−Z) plane,
 * curving from flat (heading −Z) up to `qpAngle` (90° = straight up a wall). Pos
 * φ = (0, R(1−cosφ), −R sinφ). The deck stays on the concave (rideable) face for
 * free — minimal-twist transport rotates the up-vector from +Y to the wall
 * normal — so no fixFrames needed. Rises to R, never dips below y = 0.
 */
function quarterPipePoints(pp) {
  const R = Math.max(4, pp.qpRadius ?? 16);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.qpAngle ?? 90, 10, 100));
  const n = stepsFor(R * A, A, 8);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const phi = A * (i / n);
    pts.push(new V3(0, R * (1 - Math.cos(phi)), -R * Math.sin(phi)));
  }
  return pts;
}

/**
 * Down quarter-pipe: the vertical mirror of quarterPipePoints — curves from flat
 * DOWN to a vertical wall face (drive down a wall / off a ledge into a pit). Pos
 * φ = (0, −R(1−cosφ), −R sinφ). Descends to −R (place it elevated or into a pit,
 * like a dive). Deck stays on the rideable face via transport (no fixFrames).
 */
function quarterPipeDownPoints(pp) {
  const R = Math.max(4, pp.qpRadius ?? 16);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.qpAngle ?? 90, 10, 100));
  const n = stepsFor(R * A, A, 8);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const phi = A * (i / n);
    pts.push(new V3(0, -R * (1 - Math.cos(phi)), -R * Math.sin(phi)));
  }
  return pts;
}

function twistPoints(pp) {
  const L = Math.max(2, pp.twistLength);
  // The ROLL is the whole piece: 360°·turns of torsion. The old floor of 12
  // steps put ~21°+ of roll per step — the single blockiest thing in the kit.
  const rollAngle = 2 * Math.PI * Math.max(1, Math.round(pp.twistTurns));
  const n = stepsFor(L, rollAngle, 24);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -L * (i / n)));
  return pts;
}

/** Full 360° rolls over the length; ends back at level (multiple of 2π). */
function twistRoll(t, pp) {
  return 2 * Math.PI * Math.max(1, Math.round(pp.twistTurns)) * t;
}

/**
 * Spiral / helix: a constant-radius turn that also climbs at a steady rate, so
 * consecutive spirals stack into a continuous helix (great for gaining the
 * height a loop or big jump needs). Direction follows curveDir.
 */
function spiralPoints(pp) {
  const R = Math.max(3, pp.spiralRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.spiralAngle, 5, 1080));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const rise = pp.spiralRise;
  const n = stepsFor(R * A, A, 6);
  const center = new V3(dir * R, 0, 0);
  const radius0 = new V3(-dir * R, 0, 0); // origin - center
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const tt = i / n;
    const pt = center.clone().add(rotateY(radius0, -dir * A * tt));
    pt.y = rise * tt; // rotateY preserves y, so set the climb after
    pts.push(pt);
  }
  return pts;
}

/**
 * Gap spacer: an *invisible* centreline that drifts forward and drops on a
 * parabola (level at entry). It builds no road — it only advances the open
 * connector across empty space and downward, so a landing ramp can be snapped
 * roughly where a jumped car comes back down.
 */
function gapPoints(pp) {
  const L = Math.max(4, pp.gapLength);
  const drop = pp.gapDrop;
  const n = Math.max(4, Math.ceil(L / roadParams.segLen));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const tt = i / n;
    pts.push(new V3(0, -drop * tt * tt, -L * tt));
  }
  return pts;
}

/** Landing ramp: enters pitched down at landAngle and eases to level at the exit. */
function landingPoints(pp) {
  const L = Math.max(2, pp.landLength);
  const ang = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.landAngle, 0, 80));
  const n = stepsFor(L, ang);
  const ds = L / n;
  const cur = new V3(0, 0, 0);
  const pts = [cur.clone()];
  for (let i = 1; i <= n; i++) {
    const u = 1 - i / n; // 1 at entry → 0 at exit
    const ph = -ang * u * u; // pitched down at entry, level at exit
    cur.y += Math.sin(ph) * ds;
    cur.z += -Math.cos(ph) * ds;
    pts.push(cur.clone());
  }
  return pts;
}

/** Brow ramp: vertical mirror of the landing — enters pitched UP at browAngle and
 * eases to level at the exit, so a sustained climb crests over the top to flat. */
function browPoints(pp) {
  const L = Math.max(2, pp.browLength);
  const ang = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.browAngle, 0, 80));
  const n = stepsFor(L, ang);
  const ds = L / n;
  const cur = new V3(0, 0, 0);
  const pts = [cur.clone()];
  for (let i = 1; i <= n; i++) {
    const u = 1 - i / n; // 1 at entry → 0 at exit
    const ph = ang * u * u; // pitched up at entry, level at exit
    cur.y += Math.sin(ph) * ds;
    cur.z += -Math.cos(ph) * ds;
    pts.push(cur.clone());
  }
  return pts;
}

/* ----------------------------------------------------------------------- */
/* Analytic end tangents (exact connector angles — see applyEndTangents)    */
/* ----------------------------------------------------------------------- */

const _deg = (d) => THREE.MathUtils.degToRad(d);
/** Flat pieces whose ends are exactly horizontal heading −Z (straight, slope,
 *  crest, scurve, tunnel, twist, bank in/out/tilt — all level at both ends). */
function flatEndTangents() {
  return { entry: new V3(0, 0, -1), exit: new V3(0, 0, -1) };
}
function curveEndTangents(pp) {
  const A = _deg(THREE.MathUtils.clamp(pp.curveAngle, 1, 180));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  return { entry: new V3(0, 0, -1), exit: rotateY(new V3(0, 0, -1), -dir * A) };
}
function jumpEndTangents(pp) {
  const a = _deg(THREE.MathUtils.clamp(pp.jumpAngle, 0, 80));
  return { entry: new V3(0, 0, -1), exit: new V3(0, Math.sin(a), -Math.cos(a)) };
}
function diveEndTangents(pp) {
  const a = _deg(THREE.MathUtils.clamp(pp.diveAngle, 0, 80));
  return { entry: new V3(0, 0, -1), exit: new V3(0, -Math.sin(a), -Math.cos(a)) };
}
/** Grade in: level entry, exit pitched at the grade. Mirrored for grade out.
 *  `grade` itself takes flatEndTangents — its pitch is the connector's, not its
 *  own (see gradePoints). */
function gradeInEndTangents(pp) {
  const a = gradeAngleRad(pp);
  return { entry: new V3(0, 0, -1), exit: new V3(0, Math.sin(a), -Math.cos(a)) };
}
function gradeOutEndTangents(pp) {
  const a = gradeAngleRad(pp);
  return { entry: new V3(0, Math.sin(a), -Math.cos(a)), exit: new V3(0, 0, -1) };
}
function landingEndTangents(pp) {
  const a = _deg(THREE.MathUtils.clamp(pp.landAngle, 0, 80));
  return { entry: new V3(0, -Math.sin(a), -Math.cos(a)), exit: new V3(0, 0, -1) };
}
function browEndTangents(pp) {
  const a = _deg(THREE.MathUtils.clamp(pp.browAngle, 0, 80));
  return { entry: new V3(0, Math.sin(a), -Math.cos(a)), exit: new V3(0, 0, -1) };
}
function spiralEndTangents(pp) {
  const R = Math.max(3, pp.spiralRadius);
  const A = _deg(THREE.MathUtils.clamp(pp.spiralAngle, 5, 1080));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const hs = R * A; // horizontal speed (arc length per unit t)
  const exitH = rotateY(new V3(0, 0, -1), -dir * A).multiplyScalar(hs);
  return {
    entry: new V3(0, pp.spiralRise, -hs),
    exit: new V3(exitH.x, pp.spiralRise, exitH.z),
  };
}
function gapEndTangents(pp) {
  const L = Math.max(4, pp.gapLength);
  return { entry: new V3(0, 0, -1), exit: new V3(0, -2 * pp.gapDrop, -L) };
}
// Quarter-pipe: entry flat (−Z), exit pitched up by the arc sweep (vertical at 90°).
function quarterPipeEndTangents(pp) {
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.qpAngle ?? 90, 10, 100));
  return { entry: new V3(0, 0, -1), exit: new V3(0, Math.sin(A), -Math.cos(A)) };
}
// Down quarter-pipe: entry flat, exit pitched DOWN by the arc sweep.
function quarterPipeDownEndTangents(pp) {
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.qpAngle ?? 90, 10, 100));
  return { entry: new V3(0, 0, -1), exit: new V3(0, -Math.sin(A), -Math.cos(A)) };
}
// Climbing helix ramp: a horizontal turn of 2π·turns with the climb eased flat at
// both ends, so the end tangents are horizontal (entry −Z, exit rotated by the
// full turn). fixFrames runs after this and only re-levels up/right.
function loopSpiralEndTangents(pp) {
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const A = 2 * Math.PI * Math.max(0.25, pp.loopSpiralTurns ?? 1);
  return { entry: new V3(0, 0, -1), exit: rotateY(new V3(0, 0, -1), -dir * A) };
}

/* ----------------------------------------------------------------------- */
/* Junctions — the pieces with more than one way out                        */
/* ----------------------------------------------------------------------- */

/**
 * JUNCTION AUTHORING PLANE.
 *
 * Every junction is one FLAT PLATE described by a closed outline (plus optional
 * holes) in a 2-D plane where `u` is lateral and `v` is distance along travel.
 * A plane point maps to piece-local space as (u, 0, −v) — deck top at y = 0,
 * slab bottom at −thickness — so a junction seams flush against any swept piece
 * of the same width.
 *
 * A PLATE, NOT A SET OF SWEPT LANES, and that is the whole design. Lanes that
 * fork or cross OVERLAP: sweeping each one separately gives two coincident decks
 * through the shared area, which z-fight, double up in the collision BVH, and
 * leave a wheel probe resolving against whichever of the two triangles the ray
 * happened to hit first (so the car picks up a phantom step in the middle of the
 * junction). One outline expresses the UNION of the lanes exactly, triangulated
 * once, with no overlap anywhere.
 *
 * Sockets are (pos, dir) in the same plane. Entry/exit are the through line —
 * the chain flows in one and out the other, so a junction is an ordinary chain
 * piece. `branches` are the EXTRA ways out; the builder treats each as a place a
 * NEW chain can start (see ModularRoadBuilder.branchConnectors). Every branch
 * direction points AWAY from the junction, so the side road is always built
 * outward from it.
 */

/** Outline vertex: lateral, along-travel, and the corner radius to round it by
 *  (0 = leave it sharp — every seam edge must stay sharp or it won't mate). */
const _JP = (u, v, r = 0) => ({ u, v, r });

/** Plane point (u, v) → piece-local position. */
function _jPos(p) {
  return new V3(p[0], 0, -p[1]);
}

/** Plane direction (du, dv) → piece-local travel direction. */
function _jDir(d) {
  return new V3(d[0], 0, -d[1]).normalize();
}

/**
 * Round the flagged corners of an outline with true tangent arcs.
 *
 * Works for convex AND reflex corners (the bisector always points into the
 * corner's own wedge), which matters because the interesting corners of a
 * junction — where an arm meets the through lane — are the reflex ones. The
 * tangent distance is clamped to half of each adjoining edge so two fillets on a
 * short edge can never cross and turn the outline inside out.
 */
function _filletOutline(pts, steps = 7) {
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    const r = p.r ?? 0;
    let d1u = a.u - p.u, d1v = a.v - p.v;
    let d2u = b.u - p.u, d2v = b.v - p.v;
    const l1 = Math.hypot(d1u, d1v);
    const l2 = Math.hypot(d2u, d2v);
    if (r <= 1e-4 || l1 < 1e-6 || l2 < 1e-6) {
      out.push([p.u, p.v]);
      continue;
    }
    d1u /= l1; d1v /= l1; d2u /= l2; d2v /= l2;
    const ang = Math.acos(THREE.MathUtils.clamp(d1u * d2u + d1v * d2v, -1, 1));
    if (ang < 1e-3 || Math.PI - ang < 1e-3) {
      out.push([p.u, p.v]);
      continue;
    }
    const half = Math.tan(ang / 2);
    const tanDist = Math.min(r / half, l1 * 0.5, l2 * 0.5);
    const rr = tanDist * half; // the radius actually achievable after clamping
    const t1 = [p.u + d1u * tanDist, p.v + d1v * tanDist];
    const t2 = [p.u + d2u * tanDist, p.v + d2v * tanDist];
    let bu = d1u + d2u, bv = d1v + d2v;
    const bl = Math.hypot(bu, bv);
    if (bl < 1e-6) {
      out.push([p.u, p.v]);
      continue;
    }
    bu /= bl; bv /= bl;
    const cd = rr / Math.sin(ang / 2);
    const cx = p.u + bu * cd;
    const cy = p.v + bv * cd;
    const a1 = Math.atan2(t1[1] - cy, t1[0] - cx);
    let da = Math.atan2(t2[1] - cy, t2[0] - cx) - a1;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    for (let k = 0; k <= steps; k++) {
      const th = a1 + da * (k / steps);
      out.push([cx + Math.cos(th) * rr, cy + Math.sin(th) * rr]);
    }
  }
  return out;
}

/** Normalise an outline's winding (contours CCW, holes CW — what three's ear
 *  clipper and the wall winding below both assume). */
function _orient(poly, wantCCW) {
  const v = poly.map(([u, w]) => new THREE.Vector2(u, w));
  if (THREE.ShapeUtils.isClockWise(v) === wantCCW) v.reverse();
  return v;
}

/**
 * Triangulate a junction outline into a slab: deck on top, matching underside,
 * vertical walls all the way round (and around every hole). Same attribute set
 * as the swept pieces, so the shared road material works unchanged.
 */
function buildJunctionPlate(shape, rp = roadParams) {
  const t = Math.max(0.05, rp.thickness);
  const hw = Math.max(1, rp.width / 2);

  const contour = _orient(_filletOutline(shape.contour), true);
  const holes = (shape.holes ?? []).map((h) => _orient(_filletOutline(h), false));
  const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
  const verts = holes.length ? contour.concat(...holes) : contour;

  const positions = [];
  const uvs = [];
  const lateral = [];
  const zone = [];
  const indices = [];

  const push = (u, v, y, zn) => {
    positions.push(u, y, -v);
    uvs.push(v, u); // uv.x = metres along travel, uv.y = metres across
    lateral.push(u / hw);
    zone.push(zn);
    return positions.length / 3 - 1;
  };

  // Deck ring (zone 1) and its mirror underneath (zone 0 — structural side).
  const topBase = positions.length / 3;
  for (const p of verts) push(p.x, p.y, 0, 1);
  const botBase = positions.length / 3;
  for (const p of verts) push(p.x, p.y, -t, 0);
  for (const f of faces) {
    indices.push(topBase + f[0], topBase + f[1], topBase + f[2]);
    indices.push(botBase + f[2], botBase + f[1], botBase + f[0]);
  }

  // Walls. One quad per outline edge, unique vertices so the slab keeps a crisp
  // edge instead of smoothing into the deck.
  const wall = (ring) => {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const i0 = push(a.x, a.y, 0, 0);
      push(a.x, a.y, -t, 0);
      push(b.x, b.y, -t, 0);
      push(b.x, b.y, 0, 0);
      indices.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
    }
  };
  wall(contour);
  for (const h of holes) wall(h);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute("aLateral", new THREE.Float32BufferAttribute(lateral, 1));
  geo.setAttribute("aZone", new THREE.Float32BufferAttribute(zone, 1));
  stampPieceAttributes(geo, { plain: 1 });
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* --- Outlines ---------------------------------------------------------- */

/** Crossroads: through lane from v=0 to v=L with an arm out each side. */
function _crossShape(pp, rp, sides) {
  const hw = rp.width / 2;
  // The arm box is `width` tall and has to sit inside the run with road left
  // over at both ends, so the run can never be shorter than ~1.6 × the width.
  const L = Math.max(1.6 * rp.width, pp.junctionLength ?? 34);
  const S = Math.max(hw + 6, pp.junctionStub ?? 22);
  const f = Math.max(0, pp.junctionFillet ?? 6);
  const vc = L / 2;
  const right = sides !== "left";
  const left = sides !== "right";

  const c = [_JP(-hw, 0), _JP(hw, 0)];
  if (right) {
    c.push(_JP(hw, vc - hw, f), _JP(S, vc - hw), _JP(S, vc + hw), _JP(hw, vc + hw, f));
  }
  c.push(_JP(hw, L), _JP(-hw, L));
  if (left) {
    c.push(_JP(-hw, vc + hw, f), _JP(-S, vc + hw), _JP(-S, vc - hw), _JP(-hw, vc - hw, f));
  }

  const branches = [];
  if (right) branches.push({ pos: [S, vc], dir: [1, 0], label: "right" });
  if (left) branches.push({ pos: [-S, vc], dir: [-1, 0], label: "left" });
  return {
    contour: c,
    sockets: {
      entry: { pos: [0, 0], dir: [0, 1] },
      exit: { pos: [0, L], dir: [0, 1] },
      branches,
    },
  };
}

/**
 * Symmetric Y: one lane in, two arms out at ±forkAngle.
 *
 * The GORE NOSE — where the two arms' inner edges meet — is not a free choice:
 * two lanes of half-width `hw` diverging by `a` from the same centreline cross
 * their inner edges at exactly hw/sin(a) past the split. Below it the outline is
 * one wide deck, above it two lanes, which is what makes the fork a single
 * plate with no overlap.
 */
function _wyeShape(pp, rp) {
  const hw = rp.width / 2;
  const a = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.forkAngle ?? 30, 8, 75));
  const vs = Math.max(0, pp.forkThroat ?? 6);
  const noseV = vs + hw / Math.sin(a);
  // The arms must outlive the nose or there is no split — only a wide blob.
  const La = Math.max(hw / Math.sin(a) + 10, pp.forkArm ?? 34);
  const sa = Math.sin(a);
  const ca = Math.cos(a);

  const arm = (s) => {
    // s = +1 right arm, −1 left. n = outward lateral normal of that arm.
    const cu = s * La * sa;
    const cv = vs + La * ca;
    const nu = s * ca;
    const nv = -sa;
    return {
      end: [cu, cv],
      dir: [s * sa, ca],
      outer: [cu + nu * hw, cv + nv * hw],
      inner: [cu - nu * hw, cv - nv * hw],
    };
  };
  const R = arm(1);
  const Lf = arm(-1);

  // A zero throat makes the throat corner COINCIDENT with the entry corner, and
  // a duplicated outline vertex is what an ear clipper turns into zero-area
  // triangles — so with no throat the outline simply doesn't have that corner.
  const throat = vs > 0.05;
  const contour = [
    _JP(-hw, 0),
    _JP(hw, 0),
    ...(throat ? [_JP(hw, vs, vs > 1 ? 3 : 0)] : []),
    _JP(R.outer[0], R.outer[1]),
    _JP(R.inner[0], R.inner[1]),
    // A knife-sharp gore tip is a bad thing to hand a collision BVH; round it.
    _JP(0, noseV, 2.5),
    _JP(Lf.inner[0], Lf.inner[1]),
    _JP(Lf.outer[0], Lf.outer[1]),
    ...(throat ? [_JP(-hw, vs, vs > 1 ? 3 : 0)] : []),
  ];

  // `curveDir` picks which arm the CHAIN follows; the other becomes the branch.
  const mainRight = (pp.curveDir ?? 1) >= 0;
  const main = mainRight ? R : Lf;
  const side = mainRight ? Lf : R;
  return {
    contour,
    sockets: {
      entry: { pos: [0, 0], dir: [0, 1] },
      exit: { pos: main.end, dir: main.dir },
      branches: [{ pos: side.end, dir: side.dir, label: mainRight ? "left arm" : "right arm" }],
    },
  };
}

/**
 * Slip road: the through lane runs dead straight and a side lane peels off it.
 * `flip` mirrors the whole thing along travel, which turns the fork into a
 * MERGE (the side lane joins from upstream instead of leaving downstream).
 */
function _splitShape(pp, rp, flip = false) {
  const hw = rp.width / 2;
  const b = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.splitAngle ?? 24, 8, 70));
  const sb = Math.sin(b);
  const cb = Math.cos(b);
  const vd = Math.max(2, pp.splitStart ?? 8); // where the arm leaves the edge
  // GORE NOSE. The arm's inner edge only clears the through lane's edge after
  // hw·(1+cos b)/sin b along the arm — that is where the two lanes stop sharing
  // deck and the split becomes a split. Both the arm and the through run have to
  // outlive it, or the "branch" is just a bulge with a socket buried inside it
  // (which is exactly what a 30 m arm at 24° on a 16 m road gave: the nose is
  // 38 m out). Shallow angles on a wide road need length — that is not a bug to
  // tune away, it is what a slip road is.
  const tNose = (hw * (1 + cb)) / sb;
  const noseV = vd + tNose;
  const L = Math.max(noseV + 10, pp.splitLength ?? 40);
  const La = Math.max(tNose + 14, pp.splitArm ?? 30);
  const dir = (pp.curveDir ?? 1) >= 0 ? 1 : -1;

  const cu = dir * La * sb;
  const cv = vd + La * cb;
  const nu = dir * cb;
  const nv = -sb;
  const outer = [cu + nu * hw, cv + nv * hw];
  const inner = [cu - nu * hw, cv - nv * hw];

  // Authored as a right-hand split, then mirrored laterally for a left-hand one.
  let contour = [
    _JP(-hw * dir, 0),
    _JP(hw * dir, 0),
    _JP(hw * dir, vd, 4),
    _JP(outer[0], outer[1]),
    _JP(inner[0], inner[1]),
    _JP(hw * dir, noseV, 2.5),
    _JP(hw * dir, L),
    _JP(-hw * dir, L),
  ];
  let branch = { pos: [cu, cv], dir: [dir * sb, cb], label: dir > 0 ? "right" : "left" };

  if (flip) {
    // Mirror along travel. Reversing the point order keeps the winding, and the
    // branch now points BACK up the track — a feeder, built outward from here.
    contour = contour.map((p) => _JP(p.u, L - p.v, p.r)).reverse();
    branch = { pos: [branch.pos[0], L - branch.pos[1]], dir: [branch.dir[0], -branch.dir[1]], label: branch.label };
  }

  return {
    contour,
    sockets: {
      entry: { pos: [0, 0], dir: [0, 1] },
      exit: { pos: [0, L], dir: [0, 1] },
      branches: [branch],
    },
  };
}

/**
 * Roundabout: a ring deck with four stubs, and the island punched clean through
 * (drive over the middle and you drop, exactly like the Hole Road piece). The
 * outline walks the outer circle counter-clockwise and detours out and back at
 * each stub; the island is a hole, so it gets its own wall.
 */
function _roundaboutShape(pp, rp) {
  const hw = rp.width / 2;
  const Rc = Math.max(hw + 6, pp.roundaboutRadius ?? 22);
  const Ro = Rc + hw;
  const Ri = Math.max(2, Rc - hw);
  const stub = Math.max(4, pp.roundaboutStub ?? 10);
  const Dc = Ro + stub; // ring centre → stub end
  const phi = Math.asin(THREE.MathUtils.clamp(hw / Ro, 0, 0.95));
  const C = [0, Dc];
  const at = (r, th) => [C[0] + Math.cos(th) * r, C[1] + Math.sin(th) * r];

  // Angles in the (u, v) plane: 0 = +u (right), π/2 = +v (exit), π = left,
  // 3π/2 = −v (entry, which is why the entry stub end lands on the origin).
  const stubs = [
    { th: 0, label: "right" },
    { th: Math.PI / 2, label: "exit" },
    { th: Math.PI, label: "left" },
    { th: (3 * Math.PI) / 2, label: "entry" },
  ];
  const arcSteps = Math.max(6, Math.round((Rc / 3) | 0));
  const flare = Math.min(6, stub * 0.8);

  const contour = [];
  for (let i = 0; i < stubs.length; i++) {
    const s = stubs[i];
    const d = [Math.cos(s.th), Math.sin(s.th)];
    const p = [-Math.sin(s.th), Math.cos(s.th)];
    const end = [C[0] + d[0] * Dc, C[1] + d[1] * Dc];
    const A = at(Ro, s.th - phi);
    const B = [end[0] - p[0] * hw, end[1] - p[1] * hw];
    const D = [end[0] + p[0] * hw, end[1] + p[1] * hw];
    contour.push(_JP(A[0], A[1], flare), _JP(B[0], B[1]), _JP(D[0], D[1]));
    // Arc across to the next stub (its own A point closes it).
    const next = stubs[(i + 1) % stubs.length];
    const th0 = s.th + phi;
    let th1 = next.th - phi;
    while (th1 < th0) th1 += 2 * Math.PI;
    contour.push(_JP(at(Ro, th0)[0], at(Ro, th0)[1], flare));
    for (let k = 1; k < arcSteps; k++) {
      const th = th0 + (th1 - th0) * (k / arcSteps);
      const q = at(Ro, th);
      contour.push(_JP(q[0], q[1]));
    }
  }

  const island = [];
  const islandSteps = Math.max(16, arcSteps * 4);
  for (let k = 0; k < islandSteps; k++) {
    const th = -2 * Math.PI * (k / islandSteps);
    island.push(_JP(C[0] + Math.cos(th) * Ri, C[1] + Math.sin(th) * Ri));
  }

  const stubSocket = (th) => [C[0] + Math.cos(th) * Dc, C[1] + Math.sin(th) * Dc];
  return {
    contour,
    holes: [island],
    sockets: {
      entry: { pos: [0, 0], dir: [0, 1] },
      exit: { pos: stubSocket(Math.PI / 2), dir: [0, 1] },
      branches: [
        { pos: stubSocket(0), dir: [1, 0], label: "right" },
        { pos: stubSocket(Math.PI), dir: [-1, 0], label: "left" },
      ],
    },
  };
}

/** @param {"cross"|"tee"|"wye"|"split"|"merge"|"roundabout"} kind */
function junctionShape(kind, pp, rp) {
  switch (kind) {
    case "cross": return _crossShape(pp, rp, "both");
    case "tee": return _crossShape(pp, rp, (pp.curveDir ?? 1) >= 0 ? "right" : "left");
    case "wye": return _wyeShape(pp, rp);
    case "split": return _splitShape(pp, rp, false);
    case "merge": return _splitShape(pp, rp, true);
    case "roundabout": return _roundaboutShape(pp, rp);
    default: return _crossShape(pp, rp, "both");
  }
}

/* --- Junction road markings (decor mesh, vertex-coloured) ---------------- */

const _YUP_DECO = new V3(0, 1, 0);

/** Painted line just inside an outline. Each edge is drawn as its own quad,
 *  overlapping its neighbours by the line width so the corners close. */
function _paintEdgePart(part, ring, inset, width, color) {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    let du = b.x - a.x, dv = b.y - a.y;
    const len = Math.hypot(du, dv);
    if (len < 1e-5) continue;
    du /= len; dv /= len;
    // Left of travel = into the deck for a CCW contour / a CW hole.
    const nu = -dv, nv = du;
    const ax = a.x - du * width, ay = a.y - dv * width;
    const bx = b.x + du * width, by = b.y + dv * width;
    const o0 = inset;
    const o1 = inset + width;
    const P = (x, y, o) => new V3(x + nu * o, 0.05, -(y + nv * o));
    _pushQuad(
      part,
      P(ax, ay, o0), P(bx, by, o0), P(bx, by, o1), P(ax, ay, o1),
      _YUP_DECO, color, color, color, color,
    );
  }
}

/** Arrow on the deck a little way inside a socket, pointing the way out. */
function _paintArrowPart(part, pos, dir, color, back = 7) {
  const cu = pos[0] - dir[0] * back;
  const cv = pos[1] - dir[1] * back;
  const pu = -dir[1], pv = dir[0];
  const P = (fwd, side) =>
    new V3(cu + dir[0] * fwd + pu * side, 0.05, -(cv + dir[1] * fwd + pv * side));
  // Wound counter-clockwise in the (u, v) plane, which is what faces +Y once
  // the plane maps to (u, 0, −v) — the other way round the paint is a back face
  // and simply does not draw (the decor material is single-sided).
  _pushTri(part, P(3.2, 0), P(-0.6, 2.4), P(-0.6, -2.4), _YUP_DECO, color, color, color);
  _pushQuad(part, P(-0.6, 0.9), P(-3.6, 0.9), P(-3.6, -0.9), P(-0.6, -0.9), _YUP_DECO, color, color, color, color);
}

function buildJunctionDecorGeometry(shape, rp = roadParams) {
  const part = _geoPart();
  const contour = _orient(_filletOutline(shape.contour), true);
  _paintEdgePart(part, contour, 0.45, 0.32, _DECO_WHITE);
  for (const h of shape.holes ?? []) {
    _paintEdgePart(part, _orient(_filletOutline(h), false), 0.45, 0.32, _DECO_YELLOW);
  }
  const { exit, branches } = shape.sockets;
  _paintArrowPart(part, exit.pos, exit.dir, _DECO_WHITE);
  for (const b of branches) _paintArrowPart(part, b.pos, b.dir, _DECO_YELLOW);
  if (!part.positions.length) return null;
  const geo = _partToGeo(part);
  geo.computeBoundingSphere();
  return geo;
}

/* --- Catalog adapters --------------------------------------------------- */

// A junction authors its own geometry and its own sockets, so its "centreline"
// exists only to give computeFrames something to chew on — nothing downstream
// reads the frames (no sweep, no kerbs, no shell).
const junctionPoints = (kind) => (pp) => {
  const s = junctionShape(kind, pp, roadParams);
  return [_jPos(s.sockets.entry.pos), _jPos(s.sockets.exit.pos)];
};
const junctionSockets = (kind) => (pp) => {
  const s = junctionShape(kind, pp, roadParams).sockets;
  return {
    entryPos: _jPos(s.entry.pos), entryDir: _jDir(s.entry.dir),
    exitPos: _jPos(s.exit.pos), exitDir: _jDir(s.exit.dir),
  };
};
const junctionBranches = (kind) => (pp) =>
  junctionShape(kind, pp, roadParams).sockets.branches.map((b) => ({
    pos: _jPos(b.pos), dir: _jDir(b.dir), label: b.label,
  }));
const junctionGeometry = (kind) => (pp, rp) => buildJunctionPlate(junctionShape(kind, pp, rp), rp);
const junctionDecor = (kind) => (pp, rp) => buildJunctionDecorGeometry(junctionShape(kind, pp, rp), rp);

/** Everything a junction entry in the catalog shares. */
function junctionDef(kind, extra) {
  return {
    swatch: "#f39c12",
    key: "",
    points: junctionPoints(kind),
    sockets: junctionSockets(kind),
    branches: junctionBranches(kind),
    geometry: junctionGeometry(kind),
    decor: junctionDecor(kind),
    noKerb: true, // a plate has no cross-section, so no kerbs and no guardrail
    plain: true,
    junction: true,
    ...extra,
  };
}

/** @type {{id:string,label:string,hint:string,swatch:string,key:string,points:(pp:any)=>THREE.Vector3[]}[]} */
export const PIECE_CATALOG = [
  {
    id: "straight",
    label: "Straight",
    hint: "Flat run",
    swatch: "#4a9eff",
    key: "1",
    points: straightPoints,
  },
  {
    id: "platform",
    label: "Platform",
    hint: "Wide flat deck — no lines / kerbs",
    swatch: "#6b7280",
    key: "",
    points: platformPoints,
    width: (pp) => pp.platformWidth, // wider than the road profile
    plain: true,                     // suppress centre / edge lines
    noKerb: true,                    // no kerbs or guardrails
  },
  {
    id: "platform_hazard",
    label: "Hazard pad",
    hint: "Wide diamond-plate deck — yellow / black stripes, red caps",
    swatch: "#e8c012",
    key: "",
    points: platformPoints,
    width: (pp) => pp.platformWidth,
    plain: true,
    noKerb: true,
    hazardPad: true,
  },
  {
    id: "narrow",
    label: "Narrow",
    hint: "Narrow precision road",
    swatch: "#4a9eff",
    key: "",
    points: straightPoints,
    width: (pp) => pp.narrowWidth, // narrower than the road profile (keeps lines/kerbs)
  },
  {
    id: "glass_road",
    label: "Glass road",
    hint: "Lacquer deck with a glazed window — drive over the void",
    swatch: "#f0f0ee",
    key: "",
    points: glassPoints,
    width: (pp) => pp.glassWidth,
    geometry: (pp, rp) => buildGlassDeckGeometry(pp, rp),
    // The window is a hole to LOOK through, not to fall through — the wheels get
    // an unbroken slab. Same mechanism the half tubes use for their rim caps.
    deckCollision: (pp, rp) => buildGlassDeckGeometry(pp, rp, { solid: true }),
    glass: (pp, rp) => buildGlassPaneGeometry(pp, rp),
    noKerb: true,
    plain: true,
  },
  {
    id: "holed",
    label: "Hole road",
    hint: "Straight deck with a big circular hole — don't fall in",
    swatch: "#4a9eff",
    key: "",
    points: holedPoints,
    width: (pp) => pp.holedWidth,
    geometry: (pp, rp) => buildHoledDeckGeometry(pp, rp),
    noKerb: true, // no kerbs / guardrails — the hazard IS the point
    plain: true,
  },
  {
    id: "dual",
    label: "Dual boards",
    hint: "Two close planks — straddle both like a bridge, or fall",
    swatch: "#4a9eff",
    key: "",
    points: dualPoints,
    width: (pp) => pp.dualWidth,
    geometry: (pp, rp) => buildDualDeckGeometry(pp, rp),
    noKerb: true, // rails would turn the drop into a cage
  },
  {
    id: "rounded_end",
    label: "Rounded end",
    hint: "Short terminus — semicircle nose, rails wrap the U",
    swatch: "#4a9eff",
    key: "",
    points: roundedEndPoints,
    sockets: roundedEndSockets,
    geometry: (pp, rp, edges = true) => buildRoundedEndGeometry(pp, rp, edges),
    // One open polyline on the kerb centreline: left → nose → right.
    railPath: (pp, rp) => roundedEndRailFrames(pp, rp),
    plain: true,
  },
  {
    id: "rounded_start",
    label: "Rounded start",
    hint: "Same terminus mirrored — the nose is BEHIND the entry, so it caps the head of a chain",
    swatch: "#4a9eff",
    key: "",
    // Identical sockets to the rounded end: the nose lives between the entry
    // and the stub, so the piece still measures L + hw from entry to exit.
    points: roundedEndPoints,
    sockets: roundedEndSockets,
    geometry: (pp, rp, edges = true) => buildRoundedEndGeometry(pp, rp, edges, true),
    railPath: (pp, rp) => roundedEndRailFrames(pp, rp, true),
    plain: true,
  },
  {
    id: "curve",
    label: "Curve",
    hint: "Flat arc (R flips L/R)",
    swatch: "#5cb85c",
    key: "2",
    points: curvePoints,
  },
  {
    id: "slope",
    label: "Slope / Ramp",
    hint: "Climb or descend",
    swatch: "#e8912d",
    key: "3",
    points: slopePoints,
  },
  {
    id: "banked",
    label: "Banked turn",
    hint: "Held lean, curls up from the plane — pair with Bank up/down",
    swatch: "#9b59b6",
    key: "4",
    points: bankedHoldCurvePoints,
    roll: bankRoll,
    curl: bankCurlHold,
    sockets: bankedCurveSockets,
  },
  {
    id: "banked_climb",
    label: "Banked climb turn",
    hint: "Held lean that also gains height (negative bankRise descends)",
    swatch: "#a86fd0",
    key: "",
    points: bankedClimbCurvePoints,
    roll: bankRoll,
    curl: bankCurlHold,
    sockets: bankedClimbSockets,
  },
  {
    id: "bankswap",
    label: "Bank chicane",
    hint: "Lean crosses sides without flattening — joins opposite banked turns",
    swatch: "#8e6fc0",
    key: "",
    points: bankSwapPoints,
    roll: bankSwapRoll,
    curl: bankCurlSwap,
    sockets: bankRampSockets,
  },
  {
    id: "banktilt",
    label: "Banked straight",
    hint: "Held lean (straight) — chain freely",
    swatch: "#8e6fc0",
    points: bankHoldPoints,
    roll: bankRoll,
    curl: bankCurlHold,
    sockets: bankStraightSockets,
  },
  {
    id: "bankin",
    label: "Bank in",
    hint: "Flat → banked: deck curls up from the plane",
    swatch: "#7d5fb0",
    key: "8",
    points: bankInPoints,
    roll: bankInRoll,
    curl: bankCurlIn,
    sockets: bankRampSockets,
  },
  {
    id: "bankout",
    label: "Bank out",
    hint: "Banked → flat: deck settles back to the plane",
    swatch: "#6b4fa0",
    key: "9",
    points: bankOutPoints,
    roll: bankOutRoll,
    curl: bankCurlOut,
    sockets: bankRampSockets,
  },
  {
    id: "scurve",
    label: "S-curve",
    hint: "Chicane (R flips lead)",
    swatch: "#16a085",
    key: "0",
    points: sCurvePoints,
  },
  {
    // NOT A PALETTE TILE. You never pick a Link and place it blind — its whole
    // shape comes from the gap it has to close, so the builder computes the
    // params and places it for you (see linkToNearestEnd). It lives in the
    // catalog because it still has to be a real piece: buildPiece, rebuildAll,
    // save/load and undo all key off PIECE_BY_ID.
    id: "link",
    label: "Link",
    hint: "Closes the gap to another open end",
    swatch: "#2ecc71",
    points: linkPoints,
    sockets: linkSockets,
  },
  {
    id: "crest",
    label: "Crest / dip",
    hint: "Hill (slope rise = height)",
    swatch: "#d35400",
    key: "c",
    points: crestPoints,
  },
  // ── The graded climb, in three tiles ──────────────────────────────────────
  // Grade in → any number of Climbs (or plain straights) → Grade out. Only the
  // two transitions curve; the middle is flat-out zero curvature and gains the
  // height. See the gradeAngle block in pieceParams for why this exists next to
  // `slope` rather than instead of it.
  {
    id: "grade_in",
    label: "Grade in",
    hint: "Level → graded, at a radius the car can follow",
    swatch: "#e8a13d",
    points: gradeInPoints,
  },
  {
    id: "grade",
    label: "Climb",
    hint: "Holds the incoming grade — zero curvature, gains the height",
    swatch: "#e8b455",
    points: gradePoints,
  },
  {
    id: "grade_out",
    label: "Grade out",
    hint: "Graded → level, at a radius the car can follow",
    swatch: "#d98f2a",
    points: gradeOutPoints,
  },
  {
    id: "jump",
    label: "Jump ramp",
    hint: "Angled takeoff",
    swatch: "#e74c3c",
    key: "5",
    points: jumpPoints,
  },
  {
    id: "dive",
    label: "Dive / down ramp",
    hint: "Flat → pitched down (mirror of jump)",
    swatch: "#d98c3f",
    key: "d",
    points: divePoints,
  },
  {
    id: "start_new",
    label: "Start (rounded)",
    hint: "Rounded terminus + neon start gantry at the line",
    swatch: "#27ae60",
    key: "",
    points: (pp) => roundedEndPoints(_startNewParams(pp)),
    sockets: (pp) => roundedEndSockets(_startNewParams(pp)),
    geometry: (pp, rp, edges = true) => buildRoundedEndGeometry(_startNewParams(pp), rp, edges, true),
    railPath: (pp, rp) => roundedEndRailFrames(_startNewParams(pp), rp, true),
    plain: true,
    game: "start_new",
  },
  {
    id: "finish_new",
    label: "Finish (rounded)",
    hint: "Same rounded terminus as Start (rounded), nose past the exit + neon finish gantry",
    swatch: "#ff4ec8",
    key: "",
    points: (pp) => roundedEndPoints(_startNewParams(pp)),
    sockets: (pp) => roundedEndSockets(_startNewParams(pp)),
    geometry: (pp, rp, edges = true) => buildRoundedEndGeometry(_startNewParams(pp), rp, edges, false),
    railPath: (pp, rp) => roundedEndRailFrames(_startNewParams(pp), rp, false),
    plain: true,
    game: "finish_new",
  },
  {
    id: "checkpoint_new",
    label: "Checkpoint",
    hint: "Straight — yellow neon semicircle arch",
    swatch: "#ffe14a",
    key: "p",
    points: gameLinePoints,
    game: "checkpoint_new",
  },
  {
    id: "start",
    label: "Start",
    hint: "Straight — neon start gantry at the line",
    swatch: "#2ecc71",
    key: "s",
    points: gameLinePoints,
    game: "start",
  },
  {
    id: "finish",
    label: "Finish",
    hint: "Straight — neon finish gantry at the line",
    swatch: "#e74c3c",
    key: "f",
    points: gameLinePoints,
    game: "finish",
  },
  {
    id: "quarterpipe",
    label: "Quarter-pipe",
    hint: "Concave ramp curving up to a vertical wall",
    swatch: "#16a0c0",
    key: "",
    points: quarterPipePoints,
  },
  {
    id: "quarterpipe_down",
    label: "Quarter-pipe down",
    hint: "Curves from flat down a vertical wall (descends)",
    swatch: "#1287a8",
    key: "",
    points: quarterPipeDownPoints,
  },
  {
    id: "loop",
    label: "Loop (full)",
    hint: "Full 360° vertical ring (stretch opens the feet along the track)",
    swatch: "#f1c40f",
    key: "",
    points: loopPoints,
    fixFrames: loopFixFrames,
  },
  {
    id: "loop_half",
    label: "Loop half",
    hint: "Half of the looping — place two (mirror 2nd) for a full loop",
    swatch: "#f1c40f",
    key: "6",
    points: loopHalfPoints,
    fixFrames: loopFixFrames,
  },
  {
    id: "loop_spiral",
    label: "Loop spiral",
    hint: "Climbing helix ramp — flat → spiral up → flat",
    swatch: "#e67e22",
    key: "",
    points: loopSpiralPoints,
    fixFrames: loopSpiralFixFrames,
  },
  {
    id: "twist",
    label: "Twist / roll",
    hint: "Barrel roll",
    swatch: "#1abc9c",
    key: "",
    points: twistPoints,
    roll: twistRoll,
  },
  {
    id: "tunnel",
    label: "Tunnel",
    hint: "Enclosed straight (arch)",
    swatch: "#7f8c8d",
    key: "",
    points: straightPoints,
    shell: "arch",
  },
  {
    id: "tunnel_curve",
    label: "Tunnel curve",
    hint: "Arch tunnel on a flat curve (R flips L/R)",
    swatch: "#7f8c8d",
    key: "",
    points: curvePoints,
    shell: "arch",
  },
  {
    id: "tunnel_lit",
    label: "Road tunnel",
    hint: "Vaulted concrete tunnel, wall LEDs",
    swatch: "#4a5560",
    key: "t",
    points: straightPoints,
    shell: "vault",
  },
  {
    id: "tunnel_lit_curve",
    label: "Road tunnel curve",
    hint: "Vaulted tunnel on a flat curve (R flips L/R)",
    swatch: "#4a5560",
    key: "",
    points: curvePoints,
    shell: "vault",
  },
  {
    id: "tube",
    label: "Tube",
    hint: "Ride INSIDE the tube — walls are the road",
    swatch: "#16a0c0",
    key: "",
    points: straightPoints,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
    // Close the hollow wall-cavity at both mouths. Visual only — buildPiece
    // keeps the uncapped sweep as deckCollision so the rings are not a shelf.
    tubeEndCaps: true,
  },
  {
    id: "tube_curve",
    label: "Tube curve",
    hint: "Rideable tube on a flat curve (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: curvePoints,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube",
    label: "Half tube",
    hint: "Rideable U — drive up the walls, open sky",
    swatch: "#16a0c0",
    key: "",
    points: straightPoints,
    profile: buildHalfTubeProfile,
    noKerb: true,
    plain: true,
    // The longitudinal rim caps render but are NOT road — without this the car
    // cannot get air off the lip. See buildOpenLipCollision.
    // Mouth caps too: looking at either end you still see into the hollow wall,
    // the same cavity a full tube has. Visual only — added after the collision
    // clone, so they cannot become a shelf.
    openLips: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube_curve",
    label: "Half tube curve",
    hint: "Rideable U on a flat curve (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: curvePoints,
    profile: buildHalfTubeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  // ── Tube entries. The missing link: a flat road cannot butt onto a bore. ──
  // All four share one morph (buildTubeMorphProfile) and differ only in which
  // way `t` runs and how far the section wraps. `profile` is the t = 1 section
  // in every case, because the sweep takes zones / uv / lateral from the
  // REFERENCE outline and those want to be the tube's the whole way through —
  // this piece is the tube's mouth, not a stretch of road that happens to curl.
  {
    id: "tube_in",
    label: "Tube entry",
    hint: "Flat road curls up and wraps into a full tube",
    swatch: "#16a0c0",
    key: "",
    points: tubeEntryPoints,
    profile: (pp, rp) => buildTubeMorphProfile(pp, rp, 1, true),
    profileAt: (t, pp, rp) => buildTubeMorphProfile(pp, rp, t, true),
    noKerb: true,
    plain: true,
    // Open until the very last frame, so the rim caps are a ledge for almost
    // the whole piece — exactly the case buildOpenLipCollision exists for.
    // Caps the BORE mouth only — its other end is flat road, and
    // sectionNeedsEndCap is what tells the two apart (a plate has no height).
    tubeEndCaps: true,
    openLips: true,
  },
  {
    id: "tube_out",
    label: "Tube exit",
    hint: "Full tube unwraps back down to flat road",
    swatch: "#16a0c0",
    key: "",
    points: tubeEntryPoints,
    profile: (pp, rp) => buildTubeMorphProfile(pp, rp, 1, true),
    profileAt: (t, pp, rp) => buildTubeMorphProfile(pp, rp, 1 - t, true),
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
    openLips: true,
  },
  {
    id: "half_tube_in",
    label: "Half tube entry",
    hint: "Flat road flares up into a rideable U",
    swatch: "#16a0c0",
    key: "",
    points: tubeEntryPoints,
    profile: (pp, rp) => buildTubeMorphProfile(pp, rp, 1, false),
    profileAt: (t, pp, rp) => buildTubeMorphProfile(pp, rp, t, false),
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube_out",
    label: "Half tube exit",
    hint: "Rideable U flattens back out to road",
    swatch: "#16a0c0",
    key: "",
    points: tubeEntryPoints,
    profile: (pp, rp) => buildTubeMorphProfile(pp, rp, 1, false),
    profileAt: (t, pp, rp) => buildTubeMorphProfile(pp, rp, 1 - t, false),
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  {
    id: "half_pipe",
    label: "Half-pipe",
    hint: "Snowboard pipe — flat, transition, vert; carve up and drop back in",
    swatch: "#16a0c0",
    key: "",
    points: straightPoints,
    profile: buildHalfPipeProfile,
    noKerb: true,
    plain: true,
    // Without this the rim caps are a shelf at lip height and the car cannot
    // leave the pipe at all. See buildOpenLipCollision.
    openLips: true,
    tubeEndCaps: true,
  },
  {
    id: "half_pipe_curve",
    label: "Half-pipe curve",
    hint: "Snowboard pipe on a flat curve (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: curvePoints,
    profile: buildHalfPipeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  // ── Tube S-bend: sidestep without turning ────────────────────────────────
  // `sCurvePoints` turns out by curveAngle and back again, so the heading it
  // hands on is the heading it was given and the piece is a pure lateral offset.
  // That is the one shape a tube run had no way to make: dodging an obstacle
  // meant two 45° corners, which leaves the whole rest of the chain rotated.
  {
    id: "tube_scurve",
    label: "Tube S-bend",
    hint: "Rideable tube that sidesteps and comes back parallel (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: sCurvePoints,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube_scurve",
    label: "Half tube S-bend",
    hint: "Rideable U that sidesteps and comes back parallel (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: sCurvePoints,
    profile: buildHalfTubeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  // ── Tube cannon: the exit that fires you out ─────────────────────────────
  // Same morph as tube_out / half_tube_out (`profile` is the t = 1 tube section
  // in both cases, because the sweep takes zones / uv / lateral from the
  // reference outline), on a centreline that pitches up. `openLips` for the
  // same reason the exits have it: the rim caps run almost the whole length.
  {
    id: "tube_launch",
    label: "Tube launch",
    hint: "Full tube unwraps to road while pitching up — leave the mouth flying",
    swatch: "#16a0c0",
    key: "",
    points: tubeLaunchPoints,
    profile: (pp, rp) => buildTubeMorphProfile(pp, rp, 1, true),
    profileAt: (t, pp, rp) => buildTubeMorphProfile(pp, rp, 1 - t, true),
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
    openLips: true,
  },
  {
    id: "half_tube_launch",
    label: "Half tube launch",
    hint: "Rideable U flattens out while pitching up — a ramp you can see out of",
    swatch: "#16a0c0",
    key: "",
    points: tubeLaunchPoints,
    profile: (pp, rp) => buildTubeMorphProfile(pp, rp, 1, false),
    profileAt: (t, pp, rp) => buildTubeMorphProfile(pp, rp, 1 - t, false),
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  // ── Tube reducer: the piece that makes a second SIZE family possible ─────
  //
  // It used to ship with NO `tubeEndCaps`, because appendTubeEndCaps closed both
  // mouths from the ONE reference outline — so on a piece whose ends are
  // different radii it would have fitted a `tubeRadius2` annulus onto the
  // `tubeRadius` mouth. That limit is gone: the caps are now built from each
  // end's OWN section, which is exactly the case a reducer needs.
  {
    id: "tube_reduce",
    tubeEndCaps: true,
    label: "Tube reducer",
    hint: "Tube that tapers from tubeRadius to tubeRadius2",
    swatch: "#16a0c0",
    key: "",
    points: tubeEntryPoints,
    profile: (pp, rp) => buildTubeReducerProfile(pp, rp, 1, true),
    profileAt: (t, pp, rp) => buildTubeReducerProfile(pp, rp, t, true),
    noKerb: true,
    plain: true,
  },
  {
    id: "half_tube_reduce",
    label: "Half tube reducer",
    hint: "Rideable U that tapers from tubeRadius to tubeRadius2",
    swatch: "#16a0c0",
    key: "",
    points: tubeEntryPoints,
    profile: (pp, rp) => buildTubeReducerProfile(pp, rp, 1, false),
    profileAt: (t, pp, rp) => buildTubeReducerProfile(pp, rp, t, false),
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },

  /* ── Tubes that go somewhere vertically ────────────────────────────────────
   *
   * A piece in this kit is a CROSS PRODUCT: `points` is the centreline, `profile`
   * is the cross-section. Verticality lives in the centreline, tube-ness in the
   * section — and until now every single tube piece used `straightPoints` or
   * `curvePoints`, both dead flat. So a tube run could never change altitude,
   * and the only way to make one climb was to rotate a piece, which rotates its
   * EXIT PLANE and therefore drags every piece after it.
   *
   * These are not new geometry. They pair centrelines that already existed
   * (`slopePoints`, `crestPoints`, `spiralPoints`) with sections that already
   * existed. What makes them safe to drop mid-chain is that the first three
   * carry `flatEndTangents`: smoothstep / sin² put a horizontal tangent at BOTH
   * ends, so the piece gains 12 m and still hands the next one a level frame.
   *
   * Every one of them keeps `openLips` on anything with a rim (so the lip is a
   * launch edge, not a shelf — see buildOpenLipCollision) and `tubeEndCaps` so
   * the hollow wall is closed at each mouth. Caps are visual-only: they go on
   * after the collision clone, so they cannot become a shelf.
   */
  {
    id: "tube_slope",
    label: "Tube slope",
    hint: "Rideable tube that climbs or drops — level at both ends",
    swatch: "#16a0c0",
    key: "",
    points: slopePoints,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube_slope",
    label: "Half tube slope",
    hint: "Rideable U that climbs or drops — level at both ends",
    swatch: "#16a0c0",
    key: "",
    points: slopePoints,
    profile: buildHalfTubeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  {
    id: "tube_crest",
    label: "Tube crest",
    hint: "Hump or dip inside a tube — net-zero height, level at both ends",
    swatch: "#16a0c0",
    key: "",
    points: crestPoints,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube_crest",
    label: "Half tube crest",
    hint: "Hump or dip in a rideable U — net-zero height",
    swatch: "#16a0c0",
    key: "",
    points: crestPoints,
    profile: buildHalfTubeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  /*
   * THE HELIXES RIDE `loopSpiralPoints`, NOT `spiralPoints`, and that is a
   * measured choice rather than a stylistic one.
   *
   * `spiralPoints` climbs at a CONSTANT rate, so its entry tangent is pitched
   * up. Drop one on a level connector and buildPiece rotates the WHOLE piece to
   * bring that tangent down to the connector — which tips the helix axis off
   * vertical. The exit then leaves at double the intended pitch, and parallel
   * transport around a tilted helix accumulates roll. MEASURED on the shipped
   * Slopes → Helix tile (R18 / 180° / rise 10), stacking three:
   *
   *     after 1   y =  9.77   up = (-0.52, 0.81, -0.29)   <- 36° of roll
   *     after 2   y =  0.75   <- climbed, then came back DOWN
   *     after 3   y =  9.13
   *
   * i.e. `spiral` does not stack, despite its own hint saying "stack to gain
   * height". That bug is left alone here — changing it would move the geometry
   * of every saved track containing one — but it is not a foundation to build a
   * tube family on.
   *
   * `loopSpiralPoints` smoothsteps the climb so both ends are LEVEL, and
   * `loopSpiralFixFrames` pins up to world-up so no roll can accumulate. Two
   * stack to exactly double the height with an upright exit. The price is a
   * flat spot in the grade at each seam, which is the same trade every other
   * piece in this block makes and the reason any of them can be dropped
   * mid-chain at all.
   */
  {
    id: "tube_spiral",
    label: "Tube helix",
    hint: "Climbing tube turn — stack to corkscrew up (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: loopSpiralPoints,
    fixFrames: loopSpiralFixFrames,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
    tubeEndCaps: true,
  },
  {
    id: "half_tube_spiral",
    label: "Half tube helix",
    hint: "Climbing rideable U — stack to corkscrew up (R flips L/R)",
    swatch: "#16a0c0",
    key: "",
    points: loopSpiralPoints,
    fixFrames: loopSpiralFixFrames,
    profile: buildHalfTubeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  {
    // A REAL PIPE IS CUT INTO A HILLSIDE. Snowboard pipes run at a 16-18° grade
    // and that grade is where the speed comes from — the flat Park Pipe only
    // ever bleeds it, so a run of them gets slower every hit. Same section, same
    // vert, on a slope centreline.
    id: "half_pipe_slope",
    label: "Half-pipe slope",
    hint: "Snowboard pipe on a grade — the descent is what keeps your speed",
    swatch: "#16a0c0",
    key: "",
    points: slopePoints,
    profile: buildHalfPipeProfile,
    noKerb: true,
    plain: true,
    openLips: true,
    tubeEndCaps: true,
  },
  {
    id: "channel",
    label: "Half-pipe channel",
    hint: "Open-top U walls — funnels the car",
    swatch: "#3a7bd5",
    key: "",
    points: straightPoints,
    shell: "channel",
  },
  {
    id: "channel_curve",
    label: "Channel curve",
    hint: "U-channel on a flat curve (R flips L/R)",
    swatch: "#3a7bd5",
    key: "",
    points: curvePoints,
    shell: "channel",
  },
  {
    id: "spiral",
    label: "Spiral / helix",
    hint: "Climbing turn — stack to gain height",
    swatch: "#2980b9",
    key: "h",
    points: spiralPoints,
  },
  {
    id: "gap",
    label: "Gap spacer",
    hint: "Invisible air gap (drops) — land beyond",
    swatch: "#34495e",
    key: "g",
    points: gapPoints,
    noMesh: true,
  },
  {
    id: "landing",
    label: "Landing ramp",
    hint: "Down-pitch easing to flat",
    swatch: "#c0392b",
    key: "l",
    points: landingPoints,
  },
  {
    id: "brow",
    label: "Brow / hill top",
    hint: "Up-pitch easing to flat (mirror of landing)",
    swatch: "#3fa07d",
    // WAS "b", WHICH COULD NEVER FIRE. roadGame's outer key handler intercepts
    // `keyb` for the build/drive toggle and returns, several steps before the
    // piece-hotkey lookup ever runs — so this piece had a shortcut on paper and
    // no shortcut in fact. "m" is free (checked against every piece key and
    // every editor binding).
    key: "m",
    points: browPoints,
  },
  // ── Junctions ────────────────────────────────────────────────────────────
  // The chain runs entry → exit as usual; every extra way out is a BRANCH the
  // builder can start a new chain from (K, or drag the ghost onto its marker).
  junctionDef("split", {
    id: "junction_split",
    label: "Split",
    hint: "Straight through + a slip road peeling off (R flips the side)",
  }),
  junctionDef("merge", {
    id: "junction_merge",
    label: "Merge",
    hint: "A feeder lane joins the straight (build the feeder from its branch)",
  }),
  junctionDef("wye", {
    id: "junction_y",
    label: "Y fork",
    hint: "Two arms at ±fork angle — R picks which one the chain follows",
  }),
  junctionDef("tee", {
    id: "junction_t",
    label: "T junction",
    hint: "Straight through + one square-on arm (R flips the side)",
  }),
  junctionDef("cross", {
    id: "junction_cross",
    label: "Crossroads",
    hint: "Straight through + an arm out each side",
  }),
  junctionDef("roundabout", {
    id: "junction_roundabout",
    label: "Roundabout",
    hint: "Ring with four ways out — the island is a hole, don't cut across",
  }),
];

export const PIECE_BY_ID = new Map(PIECE_CATALOG.map((p) => [p.id, p]));

/**
 * Pieces that can be snapped SIDE BY SIDE into a genuinely wider road.
 *
 * Two conditions, both measured — see tools/lateralSnapProbe.mjs, which fails
 * if this list ever stops matching the geometry:
 *
 *  1. THE EDGES MATE. `aLateral` is x / halfWidth, so a lateral copy fits only
 *     when the left edge translated by the piece's width lands exactly on the
 *     right edge. True of anything whose centreline is straight in plan. FALSE
 *     of every curve, bank, loop, spiral and twist: their two edges are arcs of
 *     radius R-hw and R+hw, so a copy opens a wedge that grows along the arc
 *     (measured at up to 18.95 m on `curve`). That is not a tuning problem —
 *     the neighbour would have to be a DIFFERENT piece, same swept angle at
 *     radius R+W, which is a separate feature.
 *
 *  2. THE DECK CONTINUES. Mating edges alone are not enough. A full tube's
 *     widest points are its bore equator and also sit at aLateral = +-1, so two
 *     tubes "mate" by kissing along a tangent line with two separate bores and
 *     nothing drivable between them. `tube`, `half_tube`, `half_pipe` and
 *     `glass_road` are excluded for that reason, not because they miss.
 *
 * `tunnel` and `channel` are in: their decks are ordinary slabs, so the result
 * is a twin-bore tunnel, which is a look to choose rather than a defect.
 */
export const LATERAL_TILEABLE = new Set([
  "straight", "platform", "platform_hazard", "narrow", "holed",
  "rounded_start", "rounded_end",
  "slope", "link", "crest", "jump", "dive", "gap", "landing", "brow",
  "grade_in", "grade", "grade_out",
  "quarterpipe", "quarterpipe_down",
  "start", "start_new", "checkpoint_new", "finish", "finish_new",
  "tunnel", "channel",
  "tunnel_lit",
  "junction_y", "junction_t", "junction_cross",
]);

/** Can this piece take a lateral neighbour? */
export function isLaterallyTileable(pieceId) {
  return LATERAL_TILEABLE.has(pieceId);
}

/**
 * The tightest CONVEX vertical radius a piece contains, in metres — the number
 * that decides whether the car follows the road over it or takes off.
 *
 * Convex only, and that is the whole point of the function. A concave curve
 * presses the car INTO the road, which the suspension and SURFACE_GRIP absorb
 * between them; a convex one asks gravity to hold the car down, and past
 * v²/R > g nothing can. So this is the geometry half of "how fast can this be
 * driven" — the builder pairs it with the car's own numbers to print a speed
 * (see followSpeedLabel).
 *
 * Returns null for pieces with no convex vertical curvature at all (straights,
 * flat turns, the constant-grade Climb) and for the pieces MEANT to launch —
 * jump, dive, gap, the tube cannons. A takeoff ramp has no follow limit worth
 * reporting; that it throws the car is what it is for.
 *
 * The curvature figures come from each profile's second derivative, which is
 * analytic for all three of these shapes — see slopeShape, crestShape and
 * gradeCurvePoints.
 */
export function convexVerticalRadius(pieceId, pp = pieceParams) {
  const L = Math.max(2, pp.slopeLength ?? pieceParams.slopeLength);
  const H = Math.abs(pp.slopeRise ?? pieceParams.slopeRise);
  switch (pieceId) {
    case "slope":
    case "tube_slope":
    case "half_tube_slope":
    case "half_pipe_slope":
      // Convex half always gets the long side, whichever way the slope runs.
      if (H < 1e-6) return null;
      return ((1 - SLOPE_CONCAVE_FRAC) * L * L) / (2 * H);
    case "crest":
    case "tube_crest":
    case "half_tube_crest":
      // Hill: the brow. Dip: its shoulders. Same figure either way — the
      // shoulder fraction flips with the sign so the two shapes mirror.
      if (H < 1e-6) return null;
      return ((0.5 - CREST_SHOULDER_FRAC) * L * L) / (4 * H);
    case "grade_in":
    case "grade_out":
      // Exactly the authored radius — that is what the parameterisation is for.
      // One of the pair is concave and one convex depending on which way the
      // grade runs, but they are built as a set and sized by the convex one.
      return Math.max(10, pp.gradeRadius ?? pieceParams.gradeRadius);
    default:
      return null;
  }
}

/**
 * ROAD YOU FOLLOW — the pieces whose decks the car is entitled to stick to.
 *
 * WHY A LIST AND NOT A MEASUREMENT. SURFACE_GRIP works out curvature from the
 * spread of the tyres' own contact normals, which needs no geometry at all and
 * is why tubes, loops, bowls and banks all just work. It cannot help here,
 * because the thing it would have to decide is not geometric: a slope crest and
 * a jump lip are the same shape, and the only difference between them is INTENT.
 * A ramp exists to throw the car; a hill exists to be driven over. No amount of
 * normal-spread tells you which one you are on, so the author does.
 *
 * WHAT BEING ON THE LIST BUYS. Where the deck falls away from under a tyre
 * faster than the suspension can follow, the wheel is pulled back toward it, so
 * the car tracks the surface instead of leaving it (see ROAD_HOLD in the
 * vehicle). Without it, following a radius R at speed v is capped at v = √(g·R)
 * plus what
 * downforce adds — about 60–120 km/h on the compact Slopes presets, against a
 * car that reaches 180. That cap is the whole of "the slopes are unusable": you
 * cannot build a hill short enough to fit a track and gentle enough to drive.
 *
 * WHAT IS DELIBERATELY OFF IT. Everything in the Ramps tab — jump, dive, gap,
 * landing, brow, the quarterpipes — and the tube cannons. Those are launchers,
 * and a launcher the car cannot leave is broken. The rule of thumb for adding to
 * this list: if you would be annoyed to find yourself airborne, it belongs here;
 * if you placed it to get airborne, it does not.
 *
 * Kept next to convexVerticalRadius on purpose — that function answers "how fast
 * can this be followed without help", and every piece it names is in here.
 */
export const FOLLOW_ROAD = new Set([
  // The vertical-profile road pieces, and their tube / half-tube variants.
  "slope", "crest", "link",
  "tube_slope", "tube_crest", "half_tube_slope", "half_tube_crest",
  "half_pipe_slope",
  // The graded climb. `grade` is a constant grade with no curvature at all, so
  // it never asks for the force — it is in the set so a chain of them cannot
  // flicker the assist off between two transitions that need it.
  "grade_in", "grade", "grade_out",
  // Climbing / banked road: a banked climb's crest is convex in the same way.
  "banked", "banked_climb", "bankswap", "banktilt", "bankin", "bankout",
]);

/** Is this a piece the car should stick to rather than fly off? See FOLLOW_ROAD. */
export function isFollowRoad(pieceId) {
  return FOLLOW_ROAD.has(pieceId);
}

/**
 * The car's numbers, for turning a radius into a speed.
 *
 * COPIED, NOT IMPORTED, and deliberately. The kit is geometry and is imported by
 * node tools that cannot load the vehicle module (it pulls in the renderer's
 * material helpers — see the TMP-file rewrite every tool in tools/ does). So
 * these three live here and tools/gradeFollowTest.mjs asserts they still match
 * v3/play/modularRoadVehicle.js, which is what stops them drifting.
 */
export const FOLLOW_CAR = { gravity: 9.81, mass: 1400, downforce: 3.0 };

/**
 * Fastest speed (m/s) at which the car still holds a convex vertical curve of
 * radius `R`, or Infinity if no speed can lift it off.
 *
 * Following the curve needs m·v²/R of downward force. Gravity supplies m·g and
 * AERO downforce supplies `downforce`·v² — which is itself speed-dependent, so
 * this is not simply √(g·R):
 *
 *     m·v²/R = m·g + k·v²   ⇒   v² = g·R / (1 − k·R/m)
 *
 * and the denominator going to zero is real rather than a singularity to guard:
 * at R ≥ m/k ≈ 467 m the downforce grows at least as fast as the demand does, so
 * the car can follow the curve at ANY speed. Below that the answer is finite and
 * this is it.
 *
 * Downforce is scaled by wheels-in-contact in the vehicle and acts along chassis
 * up rather than world up, so on a real crest this reads a little optimistic —
 * it is a design figure for sizing a piece, not a lap-time prediction.
 */
export function followSpeed(radius, car = FOLLOW_CAR) {
  if (!(radius > 0)) return Infinity;
  const denom = 1 - (car.downforce * radius) / car.mass;
  if (denom <= 1e-6) return Infinity;
  return Math.sqrt((car.gravity * radius) / denom);
}

/**
 * The car's ROAD HOLD ceiling and crest-load floor, and its top speed.
 *
 * Copied from ROAD_HOLD.maxG, ROAD_HOLD.loadFloor and TIRE.topSpeed in
 * v3/play/modularRoadVehicle.js for the same reason FOLLOW_CAR is copied — the
 * kit is geometry and cannot import the vehicle. tools/roadHoldTest.mjs asserts
 * all three still match.
 */
export const FOLLOW_HOLD = { maxG: 14, loadFloor: 0.3, topSpeed: 50 };

/**
 * Fastest speed (m/s) at which the car holds a convex vertical curve of radius
 * `R` WITH road hold — i.e. on a piece the author tagged as road to follow.
 *
 * The hold supplies the curve's demand less the part of gravity it leaves
 * carrying the tyres (see ROAD_HOLD.loadFloor), and saturates at maxG:
 *
 *     v²/R = (1 − loadFloor)·g + maxG·g   ⇒   v = √((1 + maxG − loadFloor)·g·R)
 *
 * Downforce is left out deliberately. It is a rounding error next to fourteen car
 * weights, and including it would make this read as a precision figure when it
 * is a design one — the honest use of this number is "does the piece hold at
 * the speed people drive", which is a comparison against topSpeed.
 *
 * Returns Infinity once the answer passes top speed, because past that the
 * distinction stops existing for the player: nothing they can do gets the car
 * off it. See ROAD_HOLD in the vehicle for why the ceiling exists at all.
 */
export function heldSpeed(radius, hold = FOLLOW_HOLD, car = FOLLOW_CAR) {
  if (!(radius > 0)) return Infinity;
  const v = Math.sqrt((1 + hold.maxG - hold.loadFloor) * car.gravity * radius);
  return v >= hold.topSpeed ? Infinity : v;
}

// Attach analytic end tangents so each piece's connectors hit their exact angle
// (see applyEndTangents). Loops are intentionally omitted — they use fixFrames
// and keep the transported end frames. Keeping this as a side-table avoids
// touching every catalog entry.
const _END_TANGENTS = {
  straight: flatEndTangents,
  platform: flatEndTangents,
  platform_hazard: flatEndTangents,
  narrow: flatEndTangents,
  holed: flatEndTangents,
  glass_road: flatEndTangents,
  dual: flatEndTangents,
  tunnel: flatEndTangents,
  tunnel_lit: flatEndTangents,
  tube: flatEndTangents,
  tube_in: flatEndTangents,
  tube_out: flatEndTangents,
  half_tube: flatEndTangents,
  half_tube_in: flatEndTangents,
  half_tube_out: flatEndTangents,
  half_pipe: flatEndTangents,
  channel: flatEndTangents,
  // Vertical tube family — level at both ends (smoothstep / sin²), so they take
  // the SAME flat tangents as the straights they seam onto.
  tube_slope: flatEndTangents,
  half_tube_slope: flatEndTangents,
  tube_crest: flatEndTangents,
  half_tube_crest: flatEndTangents,
  half_pipe_slope: flatEndTangents,
  // S-bends turn out and back, so the exit heading is the entry heading.
  tube_scurve: flatEndTangents,
  half_tube_scurve: flatEndTangents,
  // Reducers are straight; only the section moves.
  tube_reduce: flatEndTangents,
  half_tube_reduce: flatEndTangents,
  // The cannons take the ramp's tangents — jumpEndTangents reads only jumpAngle.
  tube_launch: jumpEndTangents,
  half_tube_launch: jumpEndTangents,
  // Eased climb about a vertical axis: the ends are horizontal, so these are the
  // turn's plan tangents. fixFrames runs after and only re-levels up/right.
  tube_spiral: loopSpiralEndTangents,
  half_tube_spiral: loopSpiralEndTangents,
  tunnel_curve: curveEndTangents,
  tunnel_lit_curve: curveEndTangents,
  tube_curve: curveEndTangents,
  half_tube_curve: curveEndTangents,
  half_pipe_curve: curveEndTangents,
  channel_curve: curveEndTangents,
  twist: flatEndTangents,
  banktilt: flatEndTangents,
  bankin: flatEndTangents,
  bankswap: flatEndTangents,
  bankout: flatEndTangents,
  slope: flatEndTangents,
  crest: flatEndTangents,
  grade_in: gradeInEndTangents,
  grade: flatEndTangents,
  grade_out: gradeOutEndTangents,
  scurve: flatEndTangents,
  start: flatEndTangents,
  start_new: flatEndTangents,
  checkpoint_new: flatEndTangents,
  finish: flatEndTangents,
  finish_new: flatEndTangents,
  curve: curveEndTangents,
  banked: curveEndTangents,
  // Exact, because the climb is smoothstepped: dy/dt is 0 at both ends, so the
  // end tangents are the flat arc's after all.
  banked_climb: curveEndTangents,
  jump: jumpEndTangents,
  dive: diveEndTangents,
  landing: landingEndTangents,
  brow: browEndTangents,
  spiral: spiralEndTangents,
  gap: gapEndTangents,
  loop_spiral: loopSpiralEndTangents,
  quarterpipe: quarterPipeEndTangents,
  quarterpipe_down: quarterPipeDownEndTangents,
  // loop / loop_half intentionally omitted — already exact via loopFixFrames.
};
for (const def of PIECE_CATALOG) {
  const fn = _END_TANGENTS[def.id];
  if (fn) def.endTangents = fn;
}

/*
 * TUBE TESSELLATION — the rideable-tube family sweeps a 98-point annulus, and
 * it was doing it at the density chosen for an 8-point road section.
 *
 * 1.5°/station exists for KERBS: a road's kerb is a narrow ridge running along
 * the piece, so it catches the light on every crease, and the comment on
 * MAX_STEP_ANGLE records that coarser stepping "showed every facet". Tubes have
 * no kerbs (`noKerb`) and pay that density across twelve times the section.
 *
 * MEASURED on a 90° R26 tube, the sagitta of the flat each step leaves behind:
 *
 *     along the sweep   1.5°/step   0.22 cm    (faceting radius = centreline, 26 m)
 *     around the bore   48 segs     1.71 cm    (faceting radius = bore, 8 m)
 *
 * The frames are EIGHT TIMES finer than the cross-section they carry, so the
 * extra stations are invisible under the profile's own faceting. At relax 2.5
 * the sweep contributes 1.4 cm — still under what the section already costs —
 * and a tube corner drops from 61 stations to 24.
 *
 * NOT THE OUTER SHELL. The obvious cut is the outside of the tube, which is half
 * the triangles and "nobody looks at" — except you can LAND on top of a tube and
 * drive along it, which the kit says out loud ("so a car can still land on the
 * OUTSIDE of a tube"). Decimating the profile would coarsen that roof ACROSS the
 * car's width, where 24 segments means 6.8 cm steps. Relaxing the sweep instead
 * leaves every cross-section exactly as round as it was and only lengthens the
 * spacing along the direction of travel — the direction a wheelbase smooths out.
 * tools/tubeDensityTest.mjs drives the roof to check that claim rather than
 * asserting it.
 *
 * NOT A MORPHING PIECE EITHER, and this one was learned the hard way. All of the
 * above reasons why the stations are surplus assume the CROSS-SECTION IS THE
 * SAME AT EVERY ONE of them: then a station only exists to approximate the
 * centreline, and the centreline is a 26 m arc that barely needs them. The
 * entries, exits, launches and reducers are the opposite kind of piece — their
 * section is rebuilt at every station by `profileAt`, rolling a flat plate up
 * into a bore, so the stations ARE the shape rather than a sampling of it.
 * Relaxing those took the tube entry from 17 stations to 7 and it went visibly
 * blocky: reported as "the tube entry looks very cheap, not smooth at all".
 *
 * So the list is filtered by `profileAt` rather than hand-curated, because the
 * hand-curated version is exactly what got this wrong — and the next morphing
 * tube piece someone adds would have been added straight back into it.
 */
for (const id of [
  "tube", "tube_curve", "tube_in", "tube_out",
  "half_tube", "half_tube_curve", "half_tube_in", "half_tube_out",
  "half_pipe", "half_pipe_curve",
  "tube_slope", "tube_crest", "tube_spiral",
  "half_tube_slope", "half_tube_crest", "half_tube_spiral",
  "half_pipe_slope", "tube_scurve", "half_tube_scurve",
  "tube_launch", "half_tube_launch", "tube_reduce", "half_tube_reduce",
]) {
  const def = PIECE_BY_ID.get(id);
  if (def && !def.profileAt) def.stepRelax = 2.5;
}

/**
 * HANDED PIECES — the ones `curveDir` actually does something to.
 *
 * The palette no longer ships an L tile beside every R tile; it carries ONE
 * sticky hand that it applies to whatever you pick (see ModularRoadBuilder.hand),
 * which halves the Banked and Turns tabs. For that to read honestly the UI has
 * to know when the control is inert, because 41 of the 66 pieces ignore
 * curveDir entirely and a hand toggle that silently does nothing on a straight
 * is worse than no toggle.
 *
 * DERIVED BY MEASUREMENT, not by reading the piece functions: build each piece
 * both ways and see whether anything moves. That is how `junction_y` got in —
 * a Y fork's PLATE is symmetric, so its deck is identical either way and only
 * the BRANCHES swap sides. A hand-maintained list would have called it unhanded
 * and the tile would have stopped flipping. tools/handedTest.mjs re-runs that
 * comparison against this list, so a new piece that reads curveDir cannot
 * quietly go missing from it.
 */
const HANDED_PIECES = new Set([
  "curve", "scurve", "spiral",
  "banked", "banked_climb", "banktilt", "bankin", "bankout", "bankswap",
  "loop", "loop_half", "loop_spiral",
  "tunnel_curve", "tunnel_lit_curve", "channel_curve",
  "tube_curve", "half_tube_curve", "half_pipe_curve",
  "tube_scurve", "half_tube_scurve", "tube_spiral", "half_tube_spiral",
  "junction_split", "junction_merge", "junction_t",
  "junction_y", // branches only — the plate is symmetric
]);
for (const def of PIECE_CATALOG) def.handed = HANDED_PIECES.has(def.id);

/** Does `curveDir` change anything about this piece? */
export function isHandedPiece(pieceId) {
  return HANDED_PIECES.has(pieceId);
}

// Rideable-tube family: dedicated cheap shader, not the asphalt graph. Same
// list the Tubes tab is built from — channel/quarter-pipe stay on the road
// material (they are a deck + shell, not an annulus).
for (const id of [
  "tube", "tube_curve", "tube_in", "tube_out",
  "half_tube", "half_tube_curve", "half_tube_in", "half_tube_out",
  "half_pipe", "half_pipe_curve",
  "tube_slope", "tube_crest", "tube_spiral",
  "half_tube_slope", "half_tube_crest", "half_tube_spiral",
  "half_pipe_slope",
  "tube_scurve", "half_tube_scurve",
  "tube_launch", "half_tube_launch",
  "tube_reduce", "half_tube_reduce",
]) {
  const def = PIECE_BY_ID.get(id);
  if (def) def.tubeShader = true;
}

/* ----------------------------------------------------------------------- */
/* Game-piece decor (checkered lines, arches, arrows)                       */
/* ----------------------------------------------------------------------- */

const _DECO_BLACK = new THREE.Color(0x000000);
const _DECO_WHITE = new THREE.Color(0xffffff);
const _DECO_YELLOW = new THREE.Color(0xffcc00);

/** Interpolate a transport frame at `dist` metres from the piece entry. */
function _frameAtArcLength(frames, dist) {
  if (!frames.length) return frames[0];
  if (dist <= 0) return frames[0];
  let acc = 0;
  for (let i = 1; i < frames.length; i++) {
    const seg = frames[i].pos.distanceTo(frames[i - 1].pos);
    if (acc + seg >= dist - 1e-6) {
      const t = seg > 1e-6 ? (dist - acc) / seg : 0;
      const pos = frames[i - 1].pos.clone().lerp(frames[i].pos, t);
      const tangent = frames[i - 1].tangent.clone().lerp(frames[i].tangent, t).normalize();
      const up = frames[i - 1].up.clone().lerp(frames[i].up, t).normalize();
      const right = new V3().crossVectors(tangent, up);
      if (right.lengthSq() < 1e-10) right.crossVectors(new V3(0, 1, 0), tangent);
      right.normalize();
      up.crossVectors(right, tangent).normalize();
      return { pos, tangent, up, right };
    }
    acc += seg;
  }
  const f = frames[frames.length - 1];
  return {
    pos: f.pos.clone(),
    tangent: f.tangent.clone(),
    up: f.up.clone(),
    right: f.right.clone(),
  };
}

/** Metres from the piece entry to the start line / gantry on start_new. */
export function startNewLineDist(pp, hw) {
  return hw + Math.max(2, pp.gameStartLineOffset ?? pieceParams.gameStartLineOffset ?? 6);
}

/** Metres from the piece entry to the finish line / gantry on finish_new.
 *  Mirror of start_new: same offset in from the rounded nose. */
export function finishNewLineDist(pp, hw) {
  const stub = Math.max(4, pp.gameStartStub ?? pp.roundEndLength ?? 14);
  return Math.max(2, stub + hw - startNewLineDist(pp, hw));
}

/** Metres from the piece entry to the gantry on a straight start / finish. */
export function straightGameLineDist(pp, atFinish = false) {
  const L = Math.max(4, pp.gameLineLength ?? pieceParams.gameLineLength ?? 16);
  const offset = Math.max(2, pp.gameStartLineOffset ?? pieceParams.gameStartLineOffset ?? 6);
  return atFinish ? Math.max(2, L - offset) : Math.min(L - 2, offset);
}

/** Gantry / checker distance for any start or finish piece. */
export function gameGantryLineDist(gameType, pp, hw) {
  if (gameType === "finish_new") return finishNewLineDist(pp, hw);
  if (gameType === "start_new") return startNewLineDist(pp, hw);
  if (gameType === "finish") return straightGameLineDist(pp, true);
  return straightGameLineDist(pp, false);
}

/** Deck markings for start_new / finish_new — checker at the line only. */
function buildStartNewMarkingsGeometry(frames, profileData, pp, lineDist) {
  const hw = profileData.hw;
  const dist = lineDist ?? startNewLineDist(pp, hw);
  const gateFr = _frameAtArcLength(frames, dist);
  const part = _checkerPart(gateFr, hw, 3.2, 8, 2);
  return _partToGeo(part);
}

function _deckPt(fr, rx, rz, lift = 0.04) {
  return fr.pos
    .clone()
    .addScaledVector(fr.right, rx)
    .addScaledVector(fr.tangent, rz)
    .addScaledVector(fr.up, lift);
}

function _geoPart() {
  return { positions: [], normals: [], colors: [], indices: [] };
}

function _pushTri(part, a, b, c, n, ca, cb, cc) {
  const base = part.positions.length / 3;
  for (const [p, col] of [
    [a, ca],
    [b, cb],
    [c, cc],
  ]) {
    part.positions.push(p.x, p.y, p.z);
    part.normals.push(n.x, n.y, n.z);
    part.colors.push(col.r, col.g, col.b);
  }
  part.indices.push(base, base + 1, base + 2);
}

function _pushQuad(part, a, b, c, d, n, ca, cb, cc, cd) {
  const base = part.positions.length / 3;
  for (const [p, col] of [
    [a, ca],
    [b, cb],
    [c, cc],
    [d, cd],
  ]) {
    part.positions.push(p.x, p.y, p.z);
    part.normals.push(n.x, n.y, n.z);
    part.colors.push(col.r, col.g, col.b);
  }
  part.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function _partToGeo(part) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(part.positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(part.normals, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(part.colors, 3));
  g.setIndex(part.indices);
  return g;
}

function _checkerPart(fr, hw, depth, cols, rows) {
  const part = _geoPart();
  const n = fr.up.clone().normalize();
  const cellW = (hw * 2) / cols;
  const cellD = depth / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = (row + col) % 2 === 0 ? _DECO_BLACK : _DECO_WHITE;
      const x0 = -hw + col * cellW;
      const x1 = x0 + cellW;
      const z0 = -row * cellD;
      const z1 = z0 - cellD;
      _pushQuad(
        part,
        _deckPt(fr, x0, z0),
        _deckPt(fr, x1, z0),
        _deckPt(fr, x1, z1),
        _deckPt(fr, x0, z1),
        n,
        c,
        c,
        c,
        c,
      );
    }
  }
  return part;
}

/* ----------------------------------------------------------------------- */
/* Sockets + placement math                                                 */
/* ----------------------------------------------------------------------- */

/**
 * Connector basis for a socket: -Z axis = travel direction, +Y ~ up. Used for
 * both ends with the same convention so continuity is `W * entry = exit`.
 */
export function socketMatrix(pos, travelDir, up, target = new THREE.Matrix4()) {
  const z = travelDir.clone().multiplyScalar(-1).normalize();
  let x = new V3().crossVectors(up, z);
  if (x.lengthSq() < 1e-10) x = new V3().crossVectors(new V3(0, 1, 0), z);
  x.normalize();
  const y = new V3().crossVectors(z, x).normalize();
  target.makeBasis(x, y, z).setPosition(pos);
  return target;
}

/** The open connector for an empty track: origin, heading -Z, up +Y. */
export function initialConnector() {
  return socketMatrix(new V3(0, 0, 0), new V3(0, 0, -1), new V3(0, 1, 0));
}

/**
 * Build everything needed to place a piece: its local geometry plus the world
 * matrix that snaps its entry connector onto `currentConnector`, and the new
 * open connector left at its exit.
 * @param {string} pieceId
 * @param {THREE.Matrix4} currentConnector
 * @param {object} [pp] piece params snapshot
 * @param {object} [gp] guardrail params snapshot
 * @param {boolean} [edges] kerbs + guardrails; defaults to gp.enabled
 * @param {object} [opts]
 * @param {boolean} [opts.deckOnly] Skip every output but `geometry` (and the
 *   connectors, which are nearly free). See the note on DECK-ONLY below.
 * @param {boolean} [opts.mirrorOnly] Build ONLY `railMirrorGeometry` (plus the
 *   deck, which is cheap and shares the frames). See the note on the mirror.
 * @param {boolean} [opts.mirrorRail] Include `railMirrorGeometry` in an
 *   otherwise-normal build. Off by default — see the note on the mirror.
 * @param {boolean} [opts.capEntry] Lid the sweep's entry. Un-mated sockets
 *   only — slab prism lids and tube wall rings both honour this. Omit to
 *   keep a tube's section default (cap a wall mouth); pass false to drop it.
 * @param {boolean} [opts.capExit] Lid the sweep's exit.
 */
export function buildPiece(pieceId, currentConnector, pp = pieceParams, rp = roadParams, gp = guardrailParams, edges = gp.enabled, opts = {}) {
  const def = PIECE_BY_ID.get(pieceId);
  if (!def) throw new Error(`Unknown road piece: ${pieceId}`);

  /**
   * DECK-ONLY — build the surface you can see and nothing else.
   *
   * The placement GHOST needs `geometry` and `world`; it draws one translucent
   * deck and has no rail, no collision, no mirror image and no branches. It was
   * paying for all of them anyway, and paying every frame of a gizmo drag,
   * because `rebuildAll` ends in `refreshGhost` and the gizmo's `change` event
   * fires per frame.
   *
   * That is not a small tail. Measured (tools/perfAudit2.mjs, 20 runs each):
   *
   *   straight     full 2.72 ms   deckOnly 0.03 ms
   *   curve        full 2.06 ms   deckOnly 0.13 ms
   *   quarterpipe  full 4.03 ms   deckOnly 0.18 ms
   *   loop        full 10.11 ms   deckOnly 0.58 ms
   *
   * i.e. 84–99% of a ghost refresh was the guardrail — swept three times over
   * (visible beam, collision stand-in, mirror image), for an object that has no
   * guardrail. Dragging with a loop selected cost 10 ms a frame on geometry
   * nobody would ever see.
   *
   * Deliberately NOT a separate entry point. A second function would be a
   * second copy of the centreline/frames/profile setup above, and the two would
   * drift the first time a piece gained a feature — which is exactly how the
   * ghost ended up building mirror rails in the first place.
   */
  const deckOnly = !!opts.deckOnly;

  /**
   * THE MIRRORED RAIL IS OPT-IN, AND IT IS THE ONLY OUTPUT THAT IS.
   *
   * It used to be built on every single call and then kept on the piece for the
   * life of the track: 280,330 vertices across rushline — TEN TIMES the visible
   * rail now that the posts are instanced — for about 8.5 MB of attribute data
   * that is used only while the road is wet.
   *
   * And only while DRIVING. `updateCarReflection` runs the pre-mirror pass under
   * `mode === "drive"`, and pins the road's `railMirrorOn` uniform to 0
   * otherwise, so in build mode none of it is ever sampled. Every remesh while
   * editing was therefore sweeping a second full guardrail, per piece, that
   * nothing could look at.
   *
   * So: nobody gets it unless they ask. `mirrorOnly` is how the one caller that
   * wants it — roadGame's mirror pass, via the builder — asks for it and
   * nothing else, and it treats what it gets as TRANSIENT: merge it, then throw
   * it away. Nothing holds a mirrored rail between passes any more.
   */
  const mirrorOnly = !!opts.mirrorOnly;
  const wantMirror = mirrorOnly || !!opts.mirrorRail;
  /** Both partial modes skip everything that is neither deck nor mirror. */
  const skipExtras = deckOnly || mirrorOnly;

  /*
   * TESSELLATION DENSITY IS A PROPERTY OF THE PIECE, not of the track.
   *
   * Injected here rather than living in `pp` so it never lands in a save file:
   * how finely a tube is meshed is a rendering decision that should follow the
   * kit, and a track saved today must pick up a better answer tomorrow rather
   * than freezing today's. (It also keeps `stepRelax` out of the thumbnail cache
   * signature and out of every piece's params snapshot.)
   *
   * Safe to change because it does NOT move connectors: every points function
   * computes its END POSITION analytically from the piece's own parameters, and
   * applyEndTangents snaps the end frames to exact analytic tangents — neither
   * depends on how many stations sit in between. Verified in
   * tools/tubeDensityTest.mjs, which rebuilds at several densities and compares
   * exits to 1e-9.
   */
  const ppSteps = def.stepRelax ? { ...pp, stepRelax: def.stepRelax } : pp;
  const points = def.points(ppSteps);
  const frames = computeFrames(points, _up);
  // Snap end frames to exact analytic tangents (before roll, so banking rolls
  // about the corrected tangent) so connectors hit their labelled angle exactly.
  if (def.endTangents) applyEndTangents(frames, def.endTangents(pp));
  if (def.roll) applyRoll(frames, def.roll, pp);
  // Optional explicit frame fix-up AFTER transport: lets a piece override the
  // up-vector directly (e.g. the loop sets up = toward the ring axis so the feet
  // stay flat instead of banking from the sideways drift). Recomputes `right`.
  if (def.fixFrames) def.fixFrames(frames, pp);
  // Per-piece deck width (platforms are wide) and no-kerb (platforms are plain
  // slabs). Everything else uses the global road profile.
  const pieceWidth = def.width ? def.width(pp) : rp.width;
  const rpForProfile = pieceWidth !== rp.width ? { ...rp, width: pieceWidth } : rp;
  const useKerbs = edges && !def.noKerb;
  // CURL — the bank family sweeps a deck that CURVES across its width rather
  // than the flat plate everything else uses (see buildBankProfile). `def.curl`
  // is the easing; `pp.bankCurl` is the amount, and 0 gives back the old flat
  // piece exactly, so this is a look you can dial out.
  // Falls back to the KIT DEFAULT, not to 0: every piece in a track saved
  // before the curl existed carries a `pp` snapshot with no bankCurl in it, and
  // `?? 0` would quietly reload all of them as the old flat plates. An explicit
  // 0 is still an explicit 0 and is still honoured.
  const curlAmt = def.curl ? Math.max(0, pp.bankCurl ?? pieceParams.bankCurl ?? 0) : 0;
  const curling = curlAmt > 1e-4;
  const curlSteps = pp.bankCurlSteps ?? 12;
  // A piece can swap the whole cross-section (rideable tubes sweep an annulus
  // instead of the road profile); everything downstream just sweeps it.
  const profileData = def.profile
    ? def.profile(pp, rpForProfile)
    : curling
      ? buildBankProfile(rpForProfile, useKerbs, curlAmt, curlSteps)
      : buildProfile(rpForProfile, useKerbs);
  // MORPH the section along the piece when the curl eases (bank in / bank out),
  // so a bank-in leaves a flat seam behind it and a fully curled one in front.
  // Held-bank pieces need no morph — their curl is constant, and skipping it
  // keeps them on the plain constant-section path.
  const sweepOpts = { plain: def.plain };
  // A piece can drive the section itself, frame by frame — the tube entries
  // morph a flat road into a bore that way. Same contract as the bank morph
  // below: the point count must not change, so `profile` (the reference) and
  // `profileAt` have to be two views of one parametric section, never two
  // different outlines.
  if (def.profileAt) {
    sweepOpts.profileAt = (t) => def.profileAt(t, pp, rpForProfile);
  } else if (curling && def.curl !== bankCurlHold) {
    sweepOpts.profileAt = (t) => buildBankProfile(
      rpForProfile,
      useKerbs,
      // Floored, never zero: buildBankProfile falls back to the 8-point flat
      // section at a true zero and the sweep needs one stable point count.
      Math.max(1e-6, curlAmt * def.curl(t, pp)),
      curlSteps,
    );
  }
  // The kerb — and so the guardrail standing on it — rides UP with the curl.
  // Stamped on the frames themselves rather than passed alongside, because the
  // rail sweeps a DECIMATED copy of them (see decimateFrames) and carrying the
  // lift on the frame is the only way it survives that thinning in step.
  if (curling) {
    const hwP = rpForProfile.width / 2;
    const rwP = Math.min(Math.max(0, rpForProfile.railWidth), hwP * 0.45);
    const kerbFrac = (hwP - rwP * 0.5) / hwP; // deck curve is y = curl·(x/hw)²
    const lift = curlAmt * kerbFrac * kerbFrac;
    const F = frames.length;
    for (let i = 0; i < F; i++) {
      frames[i].deckLift = lift * def.curl(F > 1 ? i / (F - 1) : 0, pp);
    }
  }
  // A piece can also skip the sweep entirely and author its own geometry
  // (the hole road punches a circle through its slab — impossible as a sweep).
  // Third arg is kerbs-on: the rounded end draws its kerb band from it.
  const geometry = def.geometry
    ? def.geometry(pp, rpForProfile, useKerbs)
    : buildSweepGeometry(frames, profileData, sweepOpts);
  // TWO rails, deliberately: one to look at, one to hit. Both come out of
  // modularRoadRail.js and share a profile, so the collision surface tracks the
  // visible one automatically instead of being a second set of numbers that
  // drifts. See buildRailCollision for the slab (two vertical walls, not a sheet).
  //
  // `railPath` is for pieces whose rail is NOT ±offset from the centreline —
  // the rounded end wraps left + nose + right as one open U.
  const wantsRail = !skipExtras && useKerbs && !def.noMesh && !def.profile && !def.geometry;
  /**
   * Same test as `wantsRail`, but for the mirror — which `mirrorOnly` wants
   * and `deckOnly` does not, so the two cannot share one flag.
   *
   * `!def.geometry` is the sweep-world veto (hole road, glass, junctions have
   * a custom deck and no centreline rail). It must NOT apply to a piece that
   * already declares `railPath`: the rounded start/end and start_new /
   * finish_new author a plate for the semicircle nose, then hang a U-rail on
   * the kerb. The visible rail takes that door (`alongPath` below); the
   * mirror used to skip them and "Rails in mirror" left the bulb bare.
   */
  const mirrorRailOk = wantMirror && useKerbs && !def.noMesh
    && (!!def.railPath || (!def.profile && !def.geometry));
  let railGeometry = null;
  let railCollision = null;
  let railMirrorGeometry = null;
  /**
   * The guardrail's POSTS, as poses rather than as geometry.
   *
   * A post is one shape repeated ~600 times over a track, and baking every copy
   * into the merged rail is what made the guardrail 89% of the track's vertices
   * (280,330 of 316,190 on rushline — tools/perfAudit.mjs). `postSink` takes the
   * transforms instead, in PIECE-LOCAL space, and whoever owns the piece draws
   * them as one instanced mesh.
   *
   * Purely a rendering split: `buildRailCollision` is a swept slab and has
   * never contained posts, so nothing the car can hit moves.
   *
   * The MIRRORED rail deliberately keeps its posts merged. It is built from
   * flipped frames, so its poses are a second, different set, and it now lives
   * The MIRRORED rail gets the same treatment through `railMirrorPosts`. Its
   * poses are a SECOND, different set — they come out of the flipped frames, so
   * each is a reflection of its twin about the deck at its own station — but the
   * TEMPLATE is the same object, because `postTemplate` keys on the rail and
   * road params and a mirror changes neither.
   */
  const railPosts = { key: "", template: null, matrices: [] };
  const railMirrorPosts = { key: "", template: null, matrices: [] };
  const alongPath = def.railPath && useKerbs;
  if (alongPath && !skipExtras) {
    const railFrames = def.railPath(pp, rpForProfile);
    railGeometry = buildRailAlongPath(railFrames, rpForProfile, undefined, { postSink: railPosts });
    railCollision = buildRailCollisionAlongPath(railFrames, rpForProfile);
  } else if (wantsRail) {
    railGeometry = buildRailGeometry(frames, rpForProfile, undefined, { postSink: railPosts });
    railCollision = buildRailCollision(frames, rpForProfile);
  }
  // Separately, because `mirrorOnly` wants exactly this and nothing above it.
  if (mirrorRailOk) {
    const o = { postSink: railMirrorPosts };
    railMirrorGeometry = alongPath
      ? buildMirroredRailAlongPath(def.railPath(pp, rpForProfile), rpForProfile, undefined, o)
      : buildMirroredRailGeometry(frames, rpForProfile, undefined, o);
  }
  // Same trick as the rail: one deck to look at, a slightly different one to
  // drive on. Open-lipped pieces (the half tubes) hand the BVH a copy with the
  // rim caps deleted so the lip is a launch edge, not a shelf.
  // …and a piece can supply that stand-in outright rather than deriving it from
  // what it drew: the glass road's window is a hole in the MESH only, so its
  // collision form is the same slab with no window in it at all.
  let deckCollision = skipExtras
    ? null
    : def.deckCollision
      ? def.deckCollision(pp, rpForProfile)
      : def.openLips
        ? buildOpenLipCollision(geometry)
        : null;
  // Tube / half-tube mouths: cap the wall cavity on the MESH, keep the open
  // sweep as the thing the wheels hit. Clone first so the BVH never sees the
  // rings. An open U gets the same fill as a closed ring, minus the wrap.
  //
  // The CAPS themselves are visual, so they are built deck-only too — skipping
  // them would hand the ghost an open-ended tube that does not match the piece
  // it is previewing. Only the collision clone is dropped.
  if (def.tubeEndCaps && !def.geometry) {
    if (!deckCollision && !skipExtras) deckCollision = geometry.clone();
    // A morphing piece has a DIFFERENT section at each end, so ask it for both.
    // Everything else sweeps one section and hands the same one over twice.
    const entrySection = def.profileAt ? def.profileAt(0, pp, rpForProfile) : profileData;
    const exitSection = def.profileAt ? def.profileAt(1, pp, rpForProfile) : profileData;
    appendTubeEndCaps(geometry, frames, entrySection, exitSection, {
      capEntry: opts.capEntry,
      capExit: opts.capExit,
    });
  }
  // Road-slab lids on un-mated ends. Same visual-only clone as the tube
  // rings: the BVH keeps the open sweep so you still launch off a lip.
  // Custom plates, tubes and noMesh pieces skip this — tubes close the
  // wall cavity on their own path, plates have no prism, gaps have no mesh.
  const wantsRoadCaps = !def.geometry && !def.profile && !def.tubeEndCaps && !def.noMesh;
  if (wantsRoadCaps && (opts.capEntry || opts.capExit)) {
    if (!deckCollision && !skipExtras) deckCollision = geometry.clone();
    const entrySection = def.profileAt || sweepOpts.profileAt
      ? (sweepOpts.profileAt ? sweepOpts.profileAt(0) : profileData)
      : profileData;
    const exitSection = def.profileAt || sweepOpts.profileAt
      ? (sweepOpts.profileAt ? sweepOpts.profileAt(1) : profileData)
      : profileData;
    appendRoadEndCaps(geometry, frames, {
      capEntry: !!opts.capEntry,
      capExit: !!opts.capExit,
      entryPts: entrySection.pts,
      exitPts: exitSection.pts,
      plain: def.plain ? 1 : 0,
    });
  }
  // Glazing: rendered on its own transparent material, collided by nothing.
  const glassGeometry = skipExtras || !def.glass ? null : def.glass(pp, rpForProfile);
  let shellGeometry = null;
  let shellCollision = null;
  let decorGeometry = null;
  let decorGateGeometry = null;
  let decorGlowGeometry = null;
  if (!skipExtras) {
    if (def.shell === "vault") {
      const vault = buildVaultTunnel(frames, profileData, pp);
      shellGeometry = vault.shell;
      shellCollision = vault.collision;
      decorGlowGeometry = vault.glow;
    } else if (def.shell) {
      shellGeometry = buildShellGeometry(def.shell, frames, profileData, pp);
    }
    if (def.game === "start" || def.game === "start_new" || def.game === "finish" || def.game === "finish_new") {
      const lineDist = gameGantryLineDist(def.game, pp, profileData.hw);
      const gateFr = _frameAtArcLength(frames, lineDist);
      decorGeometry = buildStartNewMarkingsGeometry(frames, profileData, pp, lineDist);
      const gate = buildStartNewGateGeometries(gateFr, profileData.hw * 2);
      decorGateGeometry = gate.body;
      decorGlowGeometry = gate.glow;
    } else if (def.game === "checkpoint_new") {
      const mid = frames[Math.floor(frames.length / 2)];
      decorGlowGeometry = buildCheckpointArchGeometry(mid, profileData.hw * 2);
    } else if (def.decor) {
      decorGeometry = def.decor(pp, rpForProfile);
    }
  }

  const f0 = frames[0];
  const fN = frames[frames.length - 1];
  let entryLocal, exitLocal;
  if (def.sockets) {
    // LEVEL sockets: position + heading only, up = world-up. Bank pieces use
    // this so a rolled deck never rolls the connector — the piece always sits
    // upright as authored, and its exit hands the next piece a level frame.
    const s = def.sockets(pp);
    entryLocal = socketMatrix(s.entryPos, s.entryDir, _up);
    exitLocal = socketMatrix(s.exitPos, s.exitDir, _up);
  } else {
    // entry travel dir points INTO the piece (= tangent at start).
    entryLocal = socketMatrix(f0.pos, f0.tangent, f0.up);
    // exit travel dir points OUT of the piece (= tangent at end).
    exitLocal = socketMatrix(fN.pos, fN.tangent, fN.up);
  }

  const world = currentConnector.clone().multiply(entryLocal.clone().invert());
  // Every piece gets its own noise phase — see stampAlongOffset. Stamped HERE,
  // after `world` exists and after any end caps have been appended, so it
  // reaches every builder (sweeps, custom plates, capped tubes) with one call
  // and can never disagree with the vertex count.
  stampAlongOffset(geometry, world);
  if (deckCollision && deckCollision !== geometry) stampAlongOffset(deckCollision, world);
  const connectorOut = world.clone().multiply(exitLocal);

  // EXTRA WAYS OUT (junctions). Same connector convention as `connectorOut`, so
  // a branch can seed a chain exactly like a chain's own open end — see
  // ModularRoadBuilder.branchConnectors().
  const branchesOut = [];
  if (def.branches) {
    for (const b of def.branches(pp)) {
      branchesOut.push({
        label: b.label ?? "branch",
        matrix: world.clone().multiply(socketMatrix(b.pos, b.dir, _up)),
      });
    }
  }

  // `frames` is handed back so a caller can sweep its OWN geometry along the
  // exact centreline this piece used — road-piece-lab.html builds its
  // experimental guardrail that way. Recomputing them outside would mean
  // duplicating every centreline function in here and watching the two drift.
  return {
    def, geometry, deckCollision, railGeometry, railCollision, railMirrorGeometry,
    shellGeometry, decorGeometry, decorGateGeometry, decorGlowGeometry,
    glassGeometry,
    shellCollision,
    // `matrices` is piece-local — the owner combines it with the piece's world
    // matrix. `template` is SHARED and cached in modularRoadRail.js; never free
    // it. Empty `matrices` means this piece has no posts.
    railPosts,
    // The same, for the mirrored rail. Only filled when the mirror was asked
    // for; shares `railPosts.template` when both are present.
    railMirrorPosts,
    // Half-width of the section this piece actually swept. Lateral snapping
    // offsets a neighbour by 2*hw, and that has to be the PIECE's own width —
    // `narrow` is 8 m and `platform` 44 m, so the global roadParams.width is
    // the wrong number for them. Null for pieces that build their own plate.
    hw: profileData?.hw ?? null,
    frames, world, connectorOut, branchesOut,
  };
}
