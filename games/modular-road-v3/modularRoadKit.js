import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { buildRailGeometry } from "./modularRoadRail.js";

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
  segLen: 1.6, // target sweep step length along the path (m)
  onChange: null,
};

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
  // Wall-ride: one piece that eases flat → steeply banked → hold → flat, and
  // RISES as it banks so the low edge stays on the original plane.
  wallRideLength: 70, // long — the lean needs room to read as a smooth curve
  wallAngle: 70,      // peak lean (deg)
  wallRamp: 0.38,     // fraction of the length spent easing in / out of the lean
  curveRadius: 26,
  curveAngle: 90, // degrees of arc
  curveDir: 1, // +1 = right turn, -1 = left turn
  slopeLength: 26, // horizontal run of the slope (m)
  slopeRise: 9, // vertical rise over the run (m); negative = downhill
  // Banked pieces (reuse curveRadius/curveAngle/curveDir):
  bankAngle: 22, // lean in degrees (turns HOLD it; Bank up/down ease it in/out)
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
  loopAdvance: 28, // legacy full-loop param (older tracks)
  // Spiral ring / corkscrew (flat run + climbing wrapped arc):
  loopSpiralRadius: 12, // helix radius (m)
  loopSpiralTurns: 1, // full revolutions about the vertical axis
  loopSpiralRise: 32, // total height climbed over the helix (m)
  // Game line pieces (start / checkpoint / finish):
  gameLineLength: 16,
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
  // Hole road (straight deck with a big circular hole punched through it):
  holedLength: 32, // run of the piece (m)
  holedWidth: 16, // deck width (m) — widen for a bigger hole with real ledges
  holeRadius: 5, // hole radius (m) — clamped so ledges never vanish
  onChange: null,
};

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

  if (!withKerbs) {
    const pts = [
      { x: -hw, y: 0, zone: 1 },
      { x: hw, y: 0, zone: 1 },
      { x: hw, y: -t, zone: 0 },
      { x: -hw, y: -t, zone: 0 },
    ];
    return { pts, hw };
  }

  const rw = Math.min(Math.max(0.0, p.railWidth), hw * 0.45);
  const rh = Math.max(0.0, p.railHeight);

  // Clockwise outline (x right, y up): top across, down the right face,
  // back across the underside, up the left face. Closed (last -> first).
  const pts = [
    { x: -hw, y: rh, zone: 2 }, // left rail, outer top
    { x: -hw + rw, y: rh, zone: 2 }, // left rail, inner top
    { x: -hw + rw, y: 0, zone: 1 }, // deck, left edge
    { x: hw - rw, y: 0, zone: 1 }, // deck, right edge
    { x: hw - rw, y: rh, zone: 2 }, // right rail, inner top
    { x: hw, y: rh, zone: 2 }, // right rail, outer top
    { x: hw, y: -t, zone: 0 }, // underside, right
    { x: -hw, y: -t, zone: 0 }, // underside, left
  ];
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
export function buildSweepGeometry(frames, profileData = buildProfile(), opts = {}) {
  const { pts: profile, hw } = profileData;
  const plain = opts.plain ? 1 : 0; // 1 = suppress centre/edge lines (platforms)
  const M = profile.length;
  const F = frames.length;

  // Cumulative distance along the path (for uv.x).
  const along = new Float32Array(F);
  for (let i = 1; i < F; i++) {
    along[i] = along[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);
  }

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
      pa.copy(fr.pos).addScaledVector(fr.right, a.x).addScaledVector(fr.up, a.y);
      pb.copy(fr.pos).addScaledVector(fr.right, b.x).addScaledVector(fr.up, b.y);
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
  // Constant per piece, but a real attribute so it survives geometry merging
  // (all pieces carry it → merge stays valid). Platforms set it to suppress lines.
  const vcount = positions.length / 3;
  geo.setAttribute("aPlain", new THREE.Float32BufferAttribute(new Float32Array(vcount).fill(plain), 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
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
  const vcount = positions.length / 3;
  geo.setAttribute("aPlain", new THREE.Float32BufferAttribute(new Float32Array(vcount).fill(1), 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
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
function _sweepShellProfile(frames, prof) {
  const F = frames.length;
  const P = prof.length;
  const along = new Float32Array(F);
  for (let i = 1; i < F; i++) along[i] = along[i - 1] + frames[i].pos.distanceTo(frames[i - 1].pos);

  const positions = [];
  const uvs = [];
  const indices = [];
  const p = new V3();
  for (let i = 0; i < F; i++) {
    const fr = frames[i];
    for (let j = 0; j < P; j++) {
      const pr = prof[j];
      p.copy(fr.pos).addScaledVector(fr.right, pr.x).addScaledVector(fr.up, pr.y);
      positions.push(p.x, p.y, p.z);
      uvs.push(along[i] * 0.12, j / (P - 1));
    }
  }
  for (let i = 0; i < F - 1; i++) {
    const r0 = i * P;
    const r1 = (i + 1) * P;
    for (let j = 0; j < P - 1; j++) {
      indices.push(r0 + j, r1 + j, r0 + j + 1, r0 + j + 1, r1 + j, r1 + j + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
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
function stepsFor(arcLen, totalAngle = 0, minSteps = 2) {
  return Math.max(
    minSteps,
    Math.ceil(arcLen / roadParams.segLen),
    Math.ceil(Math.abs(totalAngle) / MAX_STEP_ANGLE),
  );
}

function straightPoints(pp) {
  const L = Math.max(1, pp.straightLength);
  const n = Math.max(2, Math.ceil(L / roadParams.segLen));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -L * (i / n)));
  return pts;
}

function platformPoints(pp) {
  const L = Math.max(4, pp.platformLength);
  const n = Math.max(2, Math.ceil(L / roadParams.segLen));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -L * (i / n)));
  return pts;
}

/** Hole-road centerline: only the connectors matter (geometry is custom). */
function holedPoints(pp) {
  const L = Math.max(8, pp.holedLength ?? 32);
  const n = Math.max(2, Math.ceil(L / roadParams.segLen));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(new V3(0, 0, -L * (i / n)));
  return pts;
}

/** Quintic smootherstep — C2, so slope AND curvature are zero at both ends.
 *  The cubic smoothstep used before left a curvature jump where an ease meets
 *  the hold, which the sweep lighting showed as a hard crease line across the
 *  deck (the "blocky" banked look). */
function smoother(u) {
  return u * u * u * (u * (u * 6 - 15) + 10);
}

/** Fraction of full lean at t: eases 0→1 over `ramp`, holds, eases back to 0.
 *  Shared by the wall-ride's POINTS and ROLL so the rise and the lean agree. */
function wallRampFrac(t, ramp) {
  if (t < ramp) return smoother(t / ramp);
  if (t > 1 - ramp) return smoother((1 - t) / ramp);
  return 1;
}

function wallRidePoints(pp) {
  const L = Math.max(8, pp.wallRideLength);
  const ramp = THREE.MathUtils.clamp(pp.wallRamp ?? 0.35, 0.05, 0.5);
  const hw = roadParams.width / 2;
  const maxAng = THREE.MathUtils.degToRad(pp.wallAngle);
  // Torsion-aware density: the lean rolls in AND back out (2× wallAngle of total
  // roll), plus the centreline rise adds pitch. stepsFor caps the per-step angle
  // so this scales with the params instead of a hand-picked fixed step.
  const n = stepsFor(L, 2 * maxAng, 48);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const ang = maxAng * wallRampFrac(t, ramp);
    // RAISE the centreline by hw·sin(lean) so the LOW edge stays on the original
    // plane and the road banks UP into a wall. Without this the deck rolls about
    // its centreline — a see-saw blade with half the road swinging below the
    // track, which is what made it read as a huge dark slab.
    pts.push(new V3(0, hw * Math.sin(ang), -L * t));
  }
  return pts;
}

function curvePoints(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 180));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const arc = R * A;
  const n = stepsFor(arc, A);
  const center = new V3(dir * R, 0, 0);
  const radius0 = new V3(-dir * R, 0, 0); // origin - center
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const phi = A * (i / n);
    pts.push(center.clone().add(rotateY(radius0, -dir * phi)));
  }
  return pts;
}

function slopePoints(pp) {
  const L = Math.max(2, pp.slopeLength);
  const H = pp.slopeRise;
  // Pitch swings 0 → max grade → 0 (smoothstep peak slope = 1.5·H/L), so pass
  // the total direction change through stepsFor — length-only stepping put ~5°
  // of pitch per step on a typical slope and the kerbs showed every facet.
  const swing = 2 * Math.atan((1.5 * Math.abs(H)) / L);
  const n = stepsFor(L, swing, 8);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const tt = i / n;
    const sm = tt * tt * (3 - 2 * tt); // smoothstep — horizontal tangents at both ends
    pts.push(new V3(0, H * sm, -L * tt));
  }
  return pts;
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

/** Low-edge raise for a given lean (m above the connector plane). */
function bankRaise(pp, frac = 1) {
  const bank = THREE.MathUtils.degToRad(Math.abs(pp.bankAngle));
  return (roadParams.width / 2) * Math.sin(bank * frac);
}

/** Bank-in straight: deck curls up 0 → bankAngle (C2, matches bankInRoll). */
function bankInPoints(pp) {
  const L = Math.max(1, pp.straightLength);
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
  const L = Math.max(1, pp.straightLength);
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
  const L = Math.max(1, pp.straightLength);
  const n = Math.max(2, Math.ceil(L / roadParams.segLen));
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

/** Level sockets for the straight bank pieces (entry plane → exit plane). */
function bankStraightSockets(pp) {
  const L = Math.max(1, pp.straightLength);
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

/** Wall-ride: flat → up to (near-)vertical → HOLD → back to flat, all in one
 *  piece, so it chains cleanly off a flat straight (no abrupt twist at the
 *  joints). Ramps over the first/last quarter, holds the wall through the middle. */
function wallRideRoll(t, pp) {
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const ramp = THREE.MathUtils.clamp(pp.wallRamp ?? 0.35, 0.05, 0.5);
  return dir * THREE.MathUtils.degToRad(pp.wallAngle) * wallRampFrac(t, ramp);
}

/** Chicane: turn `curveAngle` one way then back the other, ending parallel. */
function sCurvePoints(pp) {
  const R = Math.max(2, pp.curveRadius);
  const A = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(pp.curveAngle, 1, 120));
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const half = stepsFor(R * A, A);
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

/** Smooth crest/dip: rises to slopeRise at the middle, flat (level) at both ends. */
function crestPoints(pp) {
  const L = Math.max(2, pp.slopeLength);
  const H = pp.slopeRise;
  // sin² profile: peak grade π·H/L, and the pitch swings up-over-down-out —
  // ~4× the peak angle of total direction change. Cap per-step bend via stepsFor.
  const swing = 4 * Math.atan((Math.PI * Math.abs(H)) / L);
  const n = stepsFor(L, swing, 8);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const tt = i / n;
    const s = Math.sin(Math.PI * tt);
    pts.push(new V3(0, H * s * s, -L * tt)); // sin² → horizontal tangents at ends
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
 * axis — they don't meet. This lateral gap is what makes it a real looping.
 */
function loopPoints(pp) {
  const R = Math.max(6, pp.loopRadius);
  const dir = pp.curveDir >= 0 ? 1 : -1;
  const gap = pp.loopOffset ?? roadParams.width; // sideways foot gap (red axis, m)
  const flat = Math.max(0, pp.loopFlat ?? R * 0.5); // flat lead-in / lead-out (m)
  const spread = THREE.MathUtils.clamp(pp.loopSpread ?? 1, 0, 1); // gap concentration at feet
  const lean = THREE.MathUtils.clamp(pp.loopLean ?? 0, -1, 1); // ring-plane tilt
  const pinch = THREE.MathUtils.clamp(pp.loopTighten ?? 0, 0, 0.7); // teardrop pinch
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
    const z = -flat - dir * r * Math.sin(theta) + lean * y;
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
    const exit = ringPt(1); // foot, on the floor at (+gap/2, 0, -flat)
    for (let i = 0; i <= hN; i++) pts.push(ringPt(0.5 + 0.5 * (i / hN)));
    for (let i = 1; i <= segN; i++) pts.push(new V3(exit.x, 0, exit.z - flat * (i / segN)));
    return pts;
  }

  // Full loop: flat lead-in, the ring, flat lead-out.
  for (let i = 0; i < segN; i++) pts.push(new V3(-gap / 2, 0, -flat * (i / segN)));
  for (let i = 0; i <= ringN; i++) pts.push(ringPt(i / ringN));
  for (let i = 1; i <= segN; i++) pts.push(new V3(gap / 2, 0, -flat - flat * (i / segN)));
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
  // A frame is "on the ring" when it's clearly above the floor; flat foot leads
  // (y≈0) keep world-up. This works for the full loop AND either half slice
  // without index bookkeeping. The ring centre sits at y=R, z=-flat, and shares
  // the frame's own x (the ring is swept sideways rigidly).
  const worldUp = new V3(0, 1, 0);
  const up = new V3();
  const right = new V3();
  const onRingY = 0.05 * R; // height above which we treat the frame as ring
  for (const fr of frames) {
    const T = fr.tangent;
    if (fr.pos.y <= onRingY) {
      up.copy(worldUp).addScaledVector(T, -worldUp.dot(T)); // flat foot
    } else {
      up.set(fr.pos.x, R, -flat).sub(fr.pos); // toward ring centre
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
  const n = stepsFor(R * A, A, 64); // A can exceed 540° — angle cap must apply
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
  const vcount = positions.length / 3;
  geo.setAttribute("aPlain", new THREE.Float32BufferAttribute(new Float32Array(vcount).fill(1), 1));
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
    id: "narrow",
    label: "Narrow",
    hint: "Narrow precision road",
    swatch: "#4a9eff",
    key: "",
    points: straightPoints,
    width: (pp) => pp.narrowWidth, // narrower than the road profile (keeps lines/kerbs)
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
    id: "wallride",
    label: "Wall ride",
    hint: "Flat → wall → flat (self-contained)",
    swatch: "#8e6fc0",
    key: "",
    points: wallRidePoints,
    roll: wallRideRoll,
    // NO width override — a wall-ride must match the road width or the deck
    // steps at the connector where it meets a straight.
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
    sockets: bankedCurveSockets,
  },
  {
    id: "banktilt",
    label: "Banked straight",
    hint: "Held lean (straight) — chain freely",
    swatch: "#8e6fc0",
    points: bankHoldPoints,
    roll: bankRoll,
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
    sockets: bankStraightSockets,
  },
  {
    id: "bankout",
    label: "Bank out",
    hint: "Banked → flat: deck settles back to the plane",
    swatch: "#6b4fa0",
    key: "9",
    points: bankOutPoints,
    roll: bankOutRoll,
    sockets: bankStraightSockets,
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
    id: "crest",
    label: "Crest / dip",
    hint: "Hill (slope rise = height)",
    swatch: "#d35400",
    key: "c",
    points: crestPoints,
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
    id: "start",
    label: "Start",
    hint: "Start line + arch",
    swatch: "#2ecc71",
    key: "s",
    points: gameLinePoints,
    game: "start",
  },
  {
    id: "checkpoint",
    label: "Checkpoint",
    hint: "Arch + direction arrows",
    swatch: "#3498db",
    key: "p",
    points: gameLinePoints,
    game: "checkpoint",
  },
  {
    id: "finish",
    label: "Finish",
    hint: "Checkered line + arch (both ends)",
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
    hint: "Full 360° vertical ring",
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
    key: "t",
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
    id: "tube",
    label: "Tube",
    hint: "Ride INSIDE the tube — walls are the road",
    swatch: "#16a0c0",
    key: "",
    points: straightPoints,
    profile: buildTubeProfile,
    noKerb: true,
    plain: true,
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
    key: "b",
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

// Attach analytic end tangents so each piece's connectors hit their exact angle
// (see applyEndTangents). Loops are intentionally omitted — they use fixFrames
// and keep the transported end frames. Keeping this as a side-table avoids
// touching every catalog entry.
const _END_TANGENTS = {
  straight: flatEndTangents,
  platform: flatEndTangents,
  narrow: flatEndTangents,
  holed: flatEndTangents,
  wallride: flatEndTangents,
  tunnel: flatEndTangents,
  tube: flatEndTangents,
  channel: flatEndTangents,
  tunnel_curve: curveEndTangents,
  tube_curve: curveEndTangents,
  channel_curve: curveEndTangents,
  twist: flatEndTangents,
  banktilt: flatEndTangents,
  bankin: flatEndTangents,
  bankout: flatEndTangents,
  slope: flatEndTangents,
  crest: flatEndTangents,
  scurve: flatEndTangents,
  start: flatEndTangents,
  checkpoint: flatEndTangents,
  finish: flatEndTangents,
  curve: curveEndTangents,
  banked: curveEndTangents,
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

/* ----------------------------------------------------------------------- */
/* Game-piece decor (checkered lines, arches, arrows)                       */
/* ----------------------------------------------------------------------- */

const _DECO_BLACK = new THREE.Color(0x111111);
const _DECO_WHITE = new THREE.Color(0xf4f4f4);
const _DECO_GREY = new THREE.Color(0xd8d8d8);
const _DECO_YELLOW = new THREE.Color(0xffcc00);

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

function _archPart(fr, hw, height) {
  const part = _geoPart();
  const up = fr.up.clone().normalize();
  const right = fr.right.clone().normalize();
  const tan = fr.tangent.clone().normalize();
  const origin = fr.pos.clone();
  const postH = height * 0.82;
  const beamR = 0.18;
  const segs = 14;

  const postW = 0.22;
  for (const side of [-1, 1]) {
    const cx = right.clone().multiplyScalar(side * hw);
    const bl = origin.clone().add(cx).addScaledVector(tan, -postW * 0.5);
    const br = origin.clone().add(cx).addScaledVector(tan, postW * 0.5);
    const tl = bl.clone().addScaledVector(up, postH);
    const tr = br.clone().addScaledVector(up, postH);
    _pushQuad(part, bl, br, tr, tl, right.clone().multiplyScalar(side), _DECO_WHITE, _DECO_WHITE, _DECO_WHITE, _DECO_WHITE);
  }

  for (let i = 0; i < segs; i++) {
    const t0 = (Math.PI * i) / segs;
    const t1 = (Math.PI * (i + 1)) / segs;
    const c0 = Math.cos(t0);
    const s0 = Math.sin(t0);
    const c1 = Math.cos(t1);
    const s1 = Math.sin(t1);
    const p0 = origin.clone().addScaledVector(right, -hw * c0).addScaledVector(up, postH + height * 0.18 * s0);
    const p1 = origin.clone().addScaledVector(right, -hw * c1).addScaledVector(up, postH + height * 0.18 * s1);
    const p2 = p1.clone().addScaledVector(up, beamR);
    const p3 = p0.clone().addScaledVector(up, beamR);
    const mid = p0.clone().add(p1).multiplyScalar(0.5).sub(origin).normalize();
    _pushQuad(part, p0, p1, p2, p3, mid, _DECO_GREY, _DECO_GREY, _DECO_GREY, _DECO_GREY);
  }
  return part;
}

function _chevronPart(fr, hw, length, width) {
  const part = _geoPart();
  const n = fr.up.clone().normalize();
  // Tip points ALONG travel (tangent). It used to sit at −length, which aimed
  // the chevron back up the track.
  const tip = _deckPt(fr, 0, length);
  const l = _deckPt(fr, -width, 0);
  const r = _deckPt(fr, width, 0);
  // Winding keeps the normal = +up after flipping the tip forward.
  _pushTri(part, tip, r, l, n, _DECO_YELLOW, _DECO_YELLOW, _DECO_YELLOW);
  return part;
}

function _bannerPart(fr, hw, height, textColor) {
  const part = _geoPart();
  const up = fr.up.clone().normalize();
  const right = fr.right.clone().normalize();
  const tan = fr.tangent.clone().normalize();
  const origin = fr.pos.clone();
  const y0 = height * 0.55;
  const y1 = height * 0.78;
  const bl = origin.clone().addScaledVector(right, -hw * 0.55).addScaledVector(up, y0).addScaledVector(tan, 0.35);
  const br = origin.clone().addScaledVector(right, hw * 0.55).addScaledVector(up, y0).addScaledVector(tan, 0.35);
  const tl = origin.clone().addScaledVector(right, -hw * 0.55).addScaledVector(up, y1).addScaledVector(tan, 0.35);
  const tr = origin.clone().addScaledVector(right, hw * 0.55).addScaledVector(up, y1).addScaledVector(tan, 0.35);
  _pushQuad(part, bl, br, tr, tl, tan.clone().negate(), textColor, textColor, textColor, textColor);
  return part;
}

/** Visual-only geometry for start / checkpoint / finish pieces. */
export function buildGameDecorGeometry(frames, profileData, gameType) {
  const hw = profileData.hw;
  const parts = [];
  const f0 = frames[0];
  const fN = frames[frames.length - 1];

  if (gameType === "start") {
    parts.push(_checkerPart(f0, hw, 3.2, 8, 2));
    parts.push(_archPart(f0, hw, 6.5));
    parts.push(_bannerPart(f0, hw, 6.5, _DECO_WHITE));
  } else if (gameType === "finish") {
    parts.push(_checkerPart(f0, hw, 3.2, 8, 2));
    parts.push(_archPart(f0, hw, 6.5));
    parts.push(_checkerPart(fN, hw, 3.2, 8, 2));
    parts.push(_archPart(fN, hw, 6.5));
    parts.push(_bannerPart(fN, hw, 6.5, _DECO_BLACK));
  } else if (gameType === "checkpoint") {
    const mid = frames[Math.floor(frames.length / 2)];
    parts.push(_archPart(mid, hw, 6));
    parts.push(_bannerPart(mid, hw, 6, _DECO_YELLOW));
    const step = Math.max(2, Math.floor(frames.length / 5));
    for (let i = step; i < frames.length - step * 0.5; i += step) {
      parts.push(_chevronPart(frames[i], hw * 0.55, 2.8, hw * 0.42));
    }
  }

  if (!parts.length) return null;
  const geos = parts.map(_partToGeo);
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  return merged;
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
 */
export function buildPiece(pieceId, currentConnector, pp = pieceParams, rp = roadParams, gp = guardrailParams, edges = gp.enabled) {
  const def = PIECE_BY_ID.get(pieceId);
  if (!def) throw new Error(`Unknown road piece: ${pieceId}`);

  const points = def.points(pp);
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
  // A piece can swap the whole cross-section (rideable tubes sweep an annulus
  // instead of the road profile); everything downstream just sweeps it.
  const profileData = def.profile ? def.profile(pp) : buildProfile(rpForProfile, useKerbs);
  // A piece can also skip the sweep entirely and author its own geometry
  // (the hole road punches a circle through its slab — impossible as a sweep).
  const geometry = def.geometry
    ? def.geometry(pp, rpForProfile)
    : buildSweepGeometry(frames, profileData, { plain: def.plain });
  // TWO rails, deliberately.
  //
  // `railGeometry` is what you SEE (modularRoadRail.js — corrugated, rolled
  // edges, posts). `railCollision` is the old flat-sheet builder, kept because a
  // BVH wants the cheapest possible triangles: bolts, chamfers and a bull-nose
  // radius contribute nothing to a chassis sweep, and bakeCollision() reruns on
  // every single track edit. Measured: 3,688 tris vs 696 for the same piece.
  const wantsRail = useKerbs && !def.noMesh && !def.profile && !def.geometry;
  const railGeometry = wantsRail ? buildRailGeometry(frames, rpForProfile) : null;
  const railCollision = wantsRail
    ? buildGuardrailGeometry(frames, profileData, gp, rpForProfile)
    : null;
  const shellGeometry = def.shell ? buildShellGeometry(def.shell, frames, profileData, pp) : null;
  // Decor is the vertex-coloured overlay mesh: game lines build theirs from the
  // frames, junctions paint their own markings from their outline.
  const decorGeometry = def.game
    ? buildGameDecorGeometry(frames, profileData, def.game)
    : def.decor
      ? def.decor(pp, rpForProfile)
      : null;

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
    def, geometry, railGeometry, railCollision, shellGeometry, decorGeometry,
    frames, world, connectorOut, branchesOut,
  };
}
