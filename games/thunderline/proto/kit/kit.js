// Thunderline piece kit, prototype P5 — every piece is PATH × SECTION × LEAN (PIECES.md §2).
//
// A piece is a list of segments. Each segment bends the path (turn = yaw, pitch = climb) with
// curvature that EASES in and out (C2 ramps, so 60 m/s never meets a curvature step), and blends
// the deck lean from its entry value to its exit value. The path is integrated once; the geometry,
// the exit socket and the collision all come from the same samples, so they can't disagree.
//
// Frames: x = right, y = up, travel = -Z (the old kit's socket convention, kept).
// Lean > 0 = the right side goes DOWN (the up vector tips to the right).
import * as THREE from "three";

export const DEG = Math.PI / 180;
export const q5 = (t) => t * t * t * (10 + t * (-15 + 6 * t));

/** Cross-sections. hw = half width of the drivable deck, kerb = slim edge strip. */
export const SECTIONS = {
  road: { hw: 8, kerbW: 0.7, kerbH: 0.16, slab: 0.9 },
  wide: { hw: 24, kerbW: 0.9, kerbH: 0.16, slab: 1.1 },
  // NARROW (user, 2026-10-21, Apex Rush: narrow planks floating for precision landings): 8 m wide
  narrow: { hw: 4, kerbW: 0.5, kerbH: 0.14, slab: 0.7 },
};

/**
 * EDGES: every piece is placed GUARDED (a low solid barrier on the outer edge of the kerb) or OPEN
 * (kerb only: one mistake and you fall). Part of the section — no separate guardrail mesh, no posts
 * (the old W-beam + posts were most of the old kit's ~110 triangles per metre).
 */
export const BARRIER = { h: 1.1, w: 0.35 };

/** Mark kinds painted by the shader (PIECES.md §5: everything that DOES something looks alike). */
export const MARK = { none: 0, lip: 1, landing: 2, chevron: 3, boost: 4 };

const STEP = 0.1; // integration step (m)
const MAX_RING_ANGLE = 2 * DEG; // new ring when the frame has turned this much
const MAX_RING_GAP = 16; // or after this many metres

/**
 * Integrate a piece's segments. Returns rings (every few metres / degrees) and the exit.
 * @param {{segs: object[], section?: string}} tile
 */
export function integrate(tile, opts = {}) {
  if (tile.customIntegrate) return tile.customIntegrate(tile, opts);
  const maxGap = opts.maxGap ?? MAX_RING_GAP;
  const maxAngle = opts.maxAngle ?? MAX_RING_ANGLE;
  const p = new THREE.Vector3();
  const T = new THREE.Vector3(0, 0, -1);
  const U = new THREE.Vector3(0, 1, 0);
  const R = new THREE.Vector3(1, 0, 0);
  const q = new THREE.Quaternion();
  const rings = [];
  let s = 0;
  let lean = tile.segs[0].leanIn ?? 0;
  const last = { T: T.clone(), U: U.clone(), lean, s: 0 };
  // RISE (helices): the whole piece lifts by `tile.rise` m along world up, eased over its full length
  // (level at both ends, so it meets any flat road), the frames staying level (≤ ~6° of slope)
  const rise = tile.rise ?? 0;
  const Ltot = tile.segs.reduce((a, g) => a + g.L, 0);
  let risen = 0;

  const emit = (segIdx, mark) => {
    rings.push({ p: p.clone(), T: T.clone(), U: U.clone(), R: R.clone(), lean, s, seg: segIdx, mark, pivot: tile.twistPivot });
    last.T.copy(T); last.U.copy(U); last.lean = lean; last.s = s;
  };
  emit(0, markAt(tile, 0, 0));

  tile.segs.forEach((seg, si) => {
    const L = seg.L;
    const r = Math.min(seg.ramp ?? 0, L / 2);
    const norm = 1 / (L - r); // ∫ weight ds = L - r (each q5 ramp integrates to r/2)
    const weight = (x) => (r <= 0 ? 1 : x < r ? q5(x / r) : x > L - r ? q5((L - x) / r) : 1) * norm;
    const leanIn = seg.leanIn ?? lean;
    const leanOut = seg.leanOut ?? leanIn;
    const off = seg.offset ?? 0; // lateral shift over the segment (loops step sideways)
    const R0 = R.clone();
    let shifted = 0;
    const n = Math.max(1, Math.round(L / STEP));
    const ds = L / n;
    for (let i = 0; i < n; i++) {
      const x0 = i * ds;
      const w = weight(x0 + ds / 2) * ds;
      // half rotation, move, half rotation (midpoint rule)
      rotate(T, U, R, q, -(seg.turn ?? 0) * w * 0.5, (seg.pitch ?? 0) * w * 0.5, (seg.roll ?? 0) * w * 0.5);
      p.addScaledVector(T, ds);
      rotate(T, U, R, q, -(seg.turn ?? 0) * w * 0.5, (seg.pitch ?? 0) * w * 0.5, (seg.roll ?? 0) * w * 0.5);
      if (off) {
        const want = off * q5((x0 + ds) / L);
        p.addScaledVector(R0, want - shifted);
        shifted = want;
      }
      if (rise) {
        const want = rise * q5(Math.min(1, (s + ds) / Ltot));
        p.y += want - risen;
        risen = want;
      }
      s += ds;
      lean = leanIn + (leanOut - leanIn) * q5((x0 + ds) / L);
      // BANK: extra lean shaped like the curvature (0 at both ends) — a banked turn that meets flat road
      if (seg.bank) lean += seg.bank * weight(x0 + ds) / norm;
      const turned = Math.max(Math.acos(Math.min(1, last.T.dot(T))), Math.acos(Math.min(1, last.U.dot(U))), Math.abs(lean - last.lean));
      const end = i === n - 1;
      if (markEdge(tile, last.s, s)) {
        // A mark starts or stops here: two rings at the same spot, one with each mark, so the
        // shader never sees a blend between kinds (2 → 0 passed through 1 and painted a lip).
        emit(si, markAt(tile, s - 1e-3));
        emit(si, markAt(tile, s + 1e-3));
      } else if (end || turned > maxAngle || s - last.s > maxGap) emit(si, markAt(tile, s, si));
    }
  });
  const exit = { p: p.clone(), T: T.clone(), U: U.clone(), R: R.clone(), lean };
  // A GAP segment (gap jumps): the path goes on (the exit, the snapping, the ride line) but there is no
  // road over it. Its rings are AIR, except the one at its end, where the road starts again.
  let segEnd = 0;
  const ends = tile.segs.map((g) => (segEnd += g.L));
  for (const r of rings) if (tile.segs[r.seg]?.gap && r.s < ends[r.seg] - 1e-6) r.air = true;
  return { rings, exit, L: s };
}

function rotate(T, U, R, q, yaw, pitch, roll = 0) {
  if (yaw) { q.setFromAxisAngle(U, yaw); T.applyQuaternion(q); R.applyQuaternion(q); }
  if (pitch) { q.setFromAxisAngle(R, pitch); T.applyQuaternion(q); U.applyQuaternion(q); }
  // ROLL: the PATH turns round its own direction (not a lean on the deck): after a half loop the road
  // rolls back upright and the next piece meets it the right way up
  if (roll) { q.setFromAxisAngle(T, roll); U.applyQuaternion(q); R.applyQuaternion(q); }
  T.normalize();
  R.crossVectors(T, U).normalize();
  U.crossVectors(R, T).normalize();
}

// Marks are ranges of distance along the piece: [{kind, from, to}], negative = from the end.
function markRanges(tile) {
  if (!tile._marks) {
    const total = tile.segs.reduce((a, s) => a + s.L, 0);
    tile._marks = (tile.marks ?? []).map((m) => ({ kind: MARK[m.kind], from: m.from < 0 ? total + m.from : m.from, to: m.to <= 0 ? total + m.to : m.to }));
  }
  return tile._marks;
}
function markAt(tile, s) {
  for (const m of markRanges(tile)) if (s >= m.from - 1e-6 && s <= m.to + 1e-6) return m.kind;
  return 0;
}
function markEdge(tile, s0, s1) {
  for (const m of markRanges(tile)) if ((s0 < m.from && s1 >= m.from) || (s0 < m.to && s1 >= m.to)) return true;
  return false;
}

/** Deck frame at a ring: lean applied, centre raised so the LOW edge stays on the path plane. */
export function deckFrame(ring, hw) {
  const c = Math.cos(ring.lean);
  const sn = Math.sin(ring.lean);
  const U = ring.U.clone().multiplyScalar(c).addScaledVector(ring.R, sn);
  const R = ring.R.clone().multiplyScalar(c).addScaledVector(ring.U, -sn);
  // a TWIST rolls round an axis `pivot` m above the road's centre (about the car's body, so the car
  // barrel-rolls in place); a bank keeps its low edge on the path plane
  const P = ring.pivot != null
    ? ring.p.clone().addScaledVector(ring.U, ring.pivot).addScaledVector(U, -ring.pivot)
    : ring.p.clone().addScaledVector(ring.U, hw * Math.abs(sn));
  return { P, U, R };
}

/** Socket matrix (x = right, y = up, z = -travel) of a ring/exit, WITHOUT lean (lean travels as a number). */
export function socketMatrix(f) {
  const z = f.T.clone().negate();
  return new THREE.Matrix4().makeBasis(f.R, f.U, z).setPosition(f.p);
}

/** The closed cross-section, wound so (edge direction) × travel points outward. */
export function profileFor(section, edges) {
  const { hw, kerbW, kerbH, slab } = SECTIONS[section];
  const di = hw - kerbW;
  if (!edges) {
    return [
      { a: [-hw, -slab], b: [-hw, kerbH], zone: 2 },
      { a: [-hw, kerbH], b: [-di, kerbH], zone: 1 },
      { a: [-di, kerbH], b: [-di, 0], zone: 1 },
      { a: [-di, 0], b: [di, 0], zone: 0 },
      { a: [di, 0], b: [di, kerbH], zone: 1 },
      { a: [di, kerbH], b: [hw, kerbH], zone: 1 },
      { a: [hw, kerbH], b: [hw, -slab], zone: 2 },
      { a: [hw, -slab], b: [-hw, -slab], zone: 3 },
    ];
  }
  // barrier on the outer edge: zone 4 = its inner face (the one you see and hit), 5 = its top
  const H = BARRIER.h;
  const bi = hw - BARRIER.w;
  return [
    { a: [-hw, -slab], b: [-hw, H], zone: 2 },
    { a: [-hw, H], b: [-bi, H], zone: 5 },
    { a: [-bi, H], b: [-bi, kerbH], zone: 4 },
    { a: [-bi, kerbH], b: [-di, kerbH], zone: 1 },
    { a: [-di, kerbH], b: [-di, 0], zone: 1 },
    { a: [-di, 0], b: [di, 0], zone: 0 },
    { a: [di, 0], b: [di, kerbH], zone: 1 },
    { a: [di, kerbH], b: [bi, kerbH], zone: 1 },
    { a: [bi, kerbH], b: [bi, H], zone: 4 },
    { a: [bi, H], b: [hw, H], zone: 5 },
    { a: [hw, H], b: [hw, -slab], zone: 2 },
    { a: [hw, -slab], b: [-hw, -slab], zone: 3 },
  ];
}

/**
 * Sweep the section along the rings. Zones: 0 deck, 1 kerb, 2 side, 3 underside, 4 barrier face,
 * 5 barrier top. Attributes: position, normal, uv (u across the face, v = metres along), zone, mark.
 * @param {{edges?: boolean}} [opts] guarded (default) or open
 */
export function buildGeometry(tile, built = integrate(tile), opts = {}) {
  const section = tile.section ?? "road";
  const edges = opts.edges ?? true;
  const { hw, kerbH, slab } = SECTIONS[section];
  const di = hw - SECTIONS[section].kerbW;
  const prof = profileFor(section, edges);
  const top = edges ? BARRIER.h : kerbH;
  const frames = built.rings.map((r) => deckFrame(r, hw));
  const pos = [], uv = [], zone = [], mark = [], idx = [];
  const t = new THREE.Vector3();
  for (const e of prof) {
    const across = e.zone === 0 ? (x) => (x + di) / (2 * di) : (x) => (x + hw) / (2 * hw);
    for (let j = 0; j < frames.length; j++) {
      const f = frames[j];
      const base = pos.length / 3;
      for (const pt of [e.a, e.b]) {
        t.copy(f.P).addScaledVector(f.R, pt[0]).addScaledVector(f.U, pt[1]);
        pos.push(t.x, t.y, t.z);
        // u: across the deck / underside; up the face for kerbs, sides and the barrier
        const up = e.zone === 4 ? (pt[1] - kerbH) / (BARRIER.h - kerbH) : (pt[1] + slab) / (slab + top);
        uv.push(e.zone === 0 || e.zone === 3 ? across(pt[0]) : up, built.rings[j].s);
        zone.push(e.zone);
        mark.push(built.rings[j].mark);
      }
      if (j > 0) idx.push(base - 2, base - 1, base, base - 1, base + 1, base);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("zone", new THREE.Float32BufferAttribute(zone, 1));
  g.setAttribute("mark", new THREE.Float32BufferAttribute(mark, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- the lab's tiles
const turnLen = (R, ang, ramp) => R * ang + ramp; // core radius R, eased ends

export const TILES = {
  straight_64: { label: "Straight 64", segs: [{ L: 64 }] },
  bank_in_22: { label: "Bank in 22°", segs: [{ L: 48, leanIn: 0, leanOut: 22 * DEG }] },
  bank_out_22: { label: "Bank out 22°", segs: [{ L: 48, leanIn: 22 * DEG, leanOut: 0 }] },
  fast_turn_128: {
    label: "Banked 90°",
    segs: [{ L: turnLen(128, Math.PI / 2, 40), turn: Math.PI / 2, ramp: 40, leanIn: 22 * DEG, leanOut: 22 * DEG }],
  },
  // MORE OF THE BANKED SET (user, 2026-10-21: after a Bank in only the Banked 90° and Bank out fitted):
  // a straight that HOLDS the lean, a 45° and a 180° (a banked U-turn, tighter: R 80, not 128 — a 128 m
  // half circle runs 400 m). All lean 22° in and out, road hold on (the car follows the bank).
  banked_straight_64: { label: "Banked straight 64", roadHold: true, segs: [{ L: 64, leanIn: 22 * DEG, leanOut: 22 * DEG }] },
  banked_turn_45: { label: "Banked 45°", roadHold: true, segs: [{ L: turnLen(128, Math.PI / 4, 30), turn: Math.PI / 4, ramp: 30, leanIn: 22 * DEG, leanOut: 22 * DEG }] },
  banked_turn_180: { label: "Banked 180°", roadHold: true, segs: [{ L: turnLen(80, Math.PI, 40), turn: Math.PI, ramp: 40, leanIn: 22 * DEG, leanOut: 22 * DEG }] },
  brake_turn_32: {
    label: "Brake 90°",
    segs: [{ L: turnLen(32, Math.PI / 2, 12), turn: Math.PI / 2, ramp: 12 }],
    marks: [{ kind: "chevron", from: 0, to: -0 }],
  },
  // ---- THE TURN SET (PIECES.md §7d: "curves of every size" — an Apex Rush track is mostly curves).
  // Flat (no lean) so any of them meets any road end; eased in and out (curvature ramps) so none jerks
  // the car; R is the tightest point. Every one gets its left-hand mirror (…_L) below.
  sweep_160_15: { label: "Sweep 15°", segs: [{ L: turnLen(160, 15 * DEG, 30), turn: 15 * DEG, ramp: 30 }] },
  sweep_160_30: { label: "Sweep 30°", segs: [{ L: turnLen(160, 30 * DEG, 40), turn: 30 * DEG, ramp: 40 }] },
  sweep_160_45: { label: "Sweep 45°", segs: [{ L: turnLen(160, 45 * DEG, 40), turn: 45 * DEG, ramp: 40 }] },
  turn_96_45: { label: "Fast 45°", segs: [{ L: turnLen(96, 45 * DEG, 30), turn: 45 * DEG, ramp: 30 }] },
  turn_96_90: { label: "Fast 90°", segs: [{ L: turnLen(96, 90 * DEG, 30), turn: 90 * DEG, ramp: 30 }] },
  turn_48_90: { label: "Turn 90°", segs: [{ L: turnLen(48, 90 * DEG, 20), turn: 90 * DEG, ramp: 20 }] },
  turn_48_180: { label: "U-turn 180°", segs: [{ L: turnLen(48, Math.PI, 24), turn: Math.PI, ramp: 24 }], marks: [{ kind: "chevron", from: 0, to: -0 }] },
  hairpin_24: { label: "Hairpin 180°", segs: [{ L: turnLen(24, Math.PI, 12), turn: Math.PI, ramp: 12 }], marks: [{ kind: "chevron", from: 0, to: -0 }] },
  // an S at speed: right then back left — the road steps sideways, the heading comes back
  s_bend_96: { label: "S-bend", segs: [{ L: turnLen(96, 30 * DEG, 20), turn: 30 * DEG, ramp: 20 }, { L: turnLen(96, 30 * DEG, 20), turn: -30 * DEG, ramp: 20 }] },
  // the SNAKE: three linked bends, left-right-left (net heading 0) — the wavy run in their track
  snake_60: { label: "Snake", segs: [{ L: turnLen(60, 25 * DEG, 14), turn: 25 * DEG, ramp: 14 }, { L: turnLen(60, 50 * DEG, 18), turn: -50 * DEG, ramp: 18 }, { L: turnLen(60, 25 * DEG, 14), turn: 25 * DEG, ramp: 14 }] },
  kicker_20: {
    label: "Kicker 20°",
    segs: [{ L: 28, pitch: 20 * DEG, ramp: 14 }],
    marks: [{ kind: "lip", from: -8, to: -0 }],
  },
  // THE RAMP FAMILY (user, 2026-10-21, Apex Rush's ~18-ramp palette; the adjustable kicker covers 5–35°):
  // LAUNCH 45° / 60° — steep curls for big air; the QUARTER PIPE — up to vertical (R 16): the car goes
  // straight up and comes back down (a stunt at a platform's edge); the ROLL KICKER — up 20° and rolled
  // 30° as it leaves: the car takes off tilted (land it with the air roll)
  launch_45: { label: "Launch 45°", segs: [{ L: 44, pitch: 45 * DEG, ramp: 30 }], marks: [{ kind: "lip", from: -8, to: -0 }] },
  launch_60: { label: "Launch 60°", segs: [{ L: 52, pitch: 60 * DEG, ramp: 38 }], marks: [{ kind: "lip", from: -8, to: -0 }] },
  // (curls 94°, a little past vertical: at 90° the car drifted forward and came down BEHIND the pipe)
  quarter_pipe: { label: "Quarter pipe", segs: [{ L: Math.round(16 * Math.PI / 2 + 18), pitch: 94 * DEG, ramp: 16 }], marks: [{ kind: "lip", from: -6, to: -0 }] },
  roll_kicker: { label: "Roll kicker 20° · 30°", segs: [{ L: 36, pitch: 20 * DEG, ramp: 18, leanIn: 0, leanOut: 30 * DEG }], marks: [{ kind: "lip", from: -8, to: -0 }] },
  plank_32: { label: "Plank 32", section: "narrow", segs: [{ L: 32 }] },
  plank_64: { label: "Plank 64", section: "narrow", segs: [{ L: 64 }] },
  // GAP JUMP (PIECES 7d): one piece, nothing to aim — a small take-off, a 24 m hole over empty space,
  // and a receiving ramp that catches the whole speed band: it starts below and as steep as a slow
  // car's fall (the hole's path drops ~2 m) and eases back to level, then a flat run-out for the
  // fastest. Speeds measured with the real car (trackRun.mjs).
  gap_jump: {
    label: "Gap jump",
    segs: [
      { L: 20, pitch: 5 * DEG, ramp: 10 },
      { L: 24, pitch: -19 * DEG, ramp: 12, gap: true },
      { L: 70, pitch: 14 * DEG, ramp: 35 },
      { L: 30 },
    ],
    marks: [{ kind: "lip", from: 12, to: 20 }, { kind: "landing", from: 44, to: 114 }],
  },
  // ROLLERS: two smooth bumps (~1 m) in 64 m — the car hops; level in, level out
  rollers_64: {
    label: "Rollers",
    segs: [
      { L: 8, pitch: 8 * DEG, ramp: 4 }, { L: 16, pitch: -16 * DEG, ramp: 8 }, { L: 8, pitch: 8 * DEG, ramp: 4 },
      { L: 8, pitch: 8 * DEG, ramp: 4 }, { L: 16, pitch: -16 * DEG, ramp: 8 }, { L: 8, pitch: 8 * DEG, ramp: 4 },
    ],
  },
  landing_20: {
    label: "Landing 20°",
    // the SAME path as a kicker (pitch up by 20°), longer and gentler: it starts tipped down on the arc
    segs: [{ L: 44, pitch: 20 * DEG, ramp: 22 }],
    marks: [{ kind: "landing", from: 0, to: 24 }],
  },
  banked_landing_20: {
    label: "Banked landing 20° → 22°",
    segs: [{ L: 44, pitch: 20 * DEG, ramp: 22, leanIn: 0, leanOut: 0 }, { L: 48, leanIn: 0, leanOut: 22 * DEG }],
    marks: [{ kind: "landing", from: 0, to: 24 }],
  },
  landing_turn_20: {
    label: "Landing turn 20° + 45°",
    // land and roll into the bank on the landing ramp, then a 45° fast turn holding the lean
    segs: [
      { L: 52, pitch: 20 * DEG, ramp: 26, leanIn: 0, leanOut: 22 * DEG },
      { L: turnLen(128, Math.PI / 4, 30), turn: Math.PI / 4, ramp: 30, leanIn: 22 * DEG, leanOut: 22 * DEG },
    ],
    marks: [{ kind: "landing", from: 0, to: 24 }],
  },
  wallride_90: {
    label: "Wallride 90°",
    segs: [
      { L: 44, turn: 15 * DEG, ramp: 22, leanIn: 0, leanOut: 80 * DEG },
      { L: turnLen(48, 60 * DEG, 0), turn: 60 * DEG, leanIn: 80 * DEG, leanOut: 80 * DEG },
      { L: 44, turn: 15 * DEG, ramp: 22, leanIn: 80 * DEG, leanOut: 0 },
    ],
  },
  loop_28: {
    label: "Loop R28",
    // eased (clothoid-like) loop: tighter at the top, gentler at the bottom, like a real coaster
    segs: [{ L: 2 * Math.PI * 28 + 70, pitch: 2 * Math.PI, ramp: 35, offset: 18 }],
  },
  // THE SKY LOOP (Apex Rush plan step 6, shot 3: "the car upside down under a huge curved roof, a short
  // open pipe pointing straight up below it"): a loop with its two vertical sides OPEN — the road curls
  // up to vertical, the car flies straight up through a gap onto the roof, rides it upside down (held by
  // its own speed, as in a loop), falls straight down through the second gap into a curl that brings it
  // back level, heading on, stepped sideways. No new physics: a loop's path with `gap` segments.
  // SIZE (measured in the drive page, 2026-10-21): R 24 roof + 30 m gaps (98 m tall) — the car came in
  // at 178 km/h and crawled over the top at 17 km/h, then fell off; and in 1 s of air the chase camera
  // turned back to world up and ended up beyond the roof. R 16 + 12 m gaps: 60 m tall, ~0.35 s of air.
  sky_loop: {
    label: "Sky loop",
    segs: [
      { L: Math.round(16 * Math.PI / 2 + 16), pitch: 90 * DEG, ramp: 16 },
      { L: 12, gap: true },
      { L: Math.round(16 * Math.PI + 20), pitch: Math.PI, ramp: 18, offset: 18 },
      { L: 12, gap: true },
      { L: Math.round(16 * Math.PI / 2 + 16), pitch: 90 * DEG, ramp: 16 },
    ],
    // NO road hold, like the Loop R28: a road-held climb past 20° is the chase camera's FLIP-RAMP shot
    // (chaseCamera.js onWall: it swings round to the side and freezes for the flight) — it ended beyond
    // the roof, looking at its underside
  },
  catch_pad: {
    label: "Catch pad",
    section: "wide",
    segs: [{ L: 64, pitch: 8 * DEG, ramp: 32 }],
    marks: [{ kind: "landing", from: 0, to: 40 }],
  },
  boost_32: { label: "Boost 32", segs: [{ L: 32 }], marks: [{ kind: "boost", from: 4, to: 28 }] },
  // ---- THE TUBE FAMILY (tubeLook.js: one section, closure 0 = road … 1 = pipe r 8 m) ----
  // Sized for ~60 m/s: in a turn the car rides the wall at atan(v²/gR) — R64 ≈ 80° at full speed.
  // THE HALF-PIPE (PIECES 7d): an OPEN U-channel — the road's floor between two rounded 8 m walls
  // (tubeLook.js halfpipeSection; `halfpipe` = the wall height 0..1 along the piece), so a turn rides
  // the car up its outside wall and the sky stays open above
  halfpipe_in: { label: "Half-pipe in", segs: [{ L: 32 }], halfpipe: { from: 0, to: 1 } },
  halfpipe_64: { label: "Half-pipe 64", segs: [{ L: 64 }], halfpipe: { from: 1, to: 1 } },
  halfpipe_turn_64: { label: "Half-pipe turn", segs: [{ L: turnLen(64, Math.PI / 2, 30), turn: Math.PI / 2, ramp: 30 }], halfpipe: { from: 1, to: 1 } },
  halfpipe_out: { label: "Half-pipe out", segs: [{ L: 32 }], halfpipe: { from: 1, to: 0 } },
  tube_in: { label: "Tube in", segs: [{ L: 32 }], tube: { from: 0, to: 1 } },
  tube_out: { label: "Tube out", segs: [{ L: 32 }], tube: { from: 1, to: 0 } },
  tube_32: { label: "Tube 32", segs: [{ L: 32 }], tube: { from: 1, to: 1 } },
  tube_64: { label: "Tube 64", segs: [{ L: 64 }], tube: { from: 1, to: 1 } },
  // TIGHT: about twice what the tyres hold at full speed, so the car has to ride the wall round it
  tube_turn_32: { label: "Tube turn R32", segs: [{ L: turnLen(32, Math.PI / 2, 20), turn: Math.PI / 2, ramp: 20 }], tube: { from: 1, to: 1 } },
  tube_turn_64: { label: "Tube turn R64", segs: [{ L: turnLen(64, Math.PI / 2, 30), turn: Math.PI / 2, ramp: 30 }], tube: { from: 1, to: 1 } },
  // ROOF DROP: an eased half loop inside the pipe, open at the top — the car comes out on the roof,
  // upside down, heading back: roll upright in the air and land (a fitted landing below). Staying on
  // the roof at the top needs v²/R ≥ g there, i.e. ≥ ~160 km/h at the entry for R 30.
  tube_roof_drop: { label: "Roof drop", segs: [{ L: Math.PI * 30 + 36, pitch: Math.PI, ramp: 36 }], tube: { from: 1, to: 1 }, drop: true },
  // CANNON: the pipe kicks up 25° and ends open — a lip, with arcs and fitted landings like a kicker
  tube_cannon: { label: "Tube cannon", segs: [{ L: 48, pitch: 25 * DEG, ramp: 24 }], tube: { from: 1, to: 1 }, marks: [{ kind: "lip", from: -8, to: -0 }] },
  // TWIST (PIECES.md §7d, the striped ribbons in the user's Apex Rush track): a straight that rolls a
  // full 360° round itself, the car barrel-rolling with it, upside down half-way. twistPivot: the roll
  // axis, m above the road's centre (about the car's body). twistTest via trackRun measures it.
  // roadHold: the car follows the road's roll (measured, trackRun --open, 2026-10-19: without it the
  // car's upright-keeping assist fought the roll and it left the road at 106–135°, even on longer
  // twists; with it a full roll at every entry speed from 90 to 225 km/h, no air, out at ~180).
  // The pivot at the car's body height: rolling round the road's centre threw the car off.
  // (A magnet — carRules MAGNET — was not needed once the car followed the road.)
  twist_120: { label: "Twist 360°", segs: [{ L: 160, leanIn: 0, leanOut: 2 * Math.PI }], twistPivot: 0.9, roadHold: true },
  // DROP (user, 2026-10-18: "it jumps but it should also fall down and land on the road under"): the
  // road just ends. The builder draws its fall arcs like a kicker's; land on a road below, any depth.
  drop_16: { label: "Drop", segs: [{ L: 16 }], marks: [{ kind: "lip", from: -6, to: -0 }], drop: true },
  slope_down_12: {
    label: "Slope down ~12 m",
    // an S in the vertical: tip down 15°, then back to level — exits level, ~12.5 m lower
    segs: [{ L: 48, pitch: -15 * DEG, ramp: 24 }, { L: 48, pitch: 15 * DEG, ramp: 24 }],
  },
  // PLATFORMS (user, 2026-10-20: "we need some platform shapes, at least a straight one"): the WIDE section
  // (48 m) as plain road — freestyle and landing areas; a 16 m road runs onto their open ends and off again
  platform_32: { label: "Platform 32", section: "wide", segs: [{ L: 32 }] },
  platform_64: { label: "Platform 64", section: "wide", segs: [{ L: 64 }] },
  platform_128: { label: "Platform 128", section: "wide", segs: [{ L: 128 }] },
  platform_turn_90: { label: "Platform turn 90°", section: "wide", segs: [{ L: turnLen(64, Math.PI / 2, 24), turn: Math.PI / 2, ramp: 24 }] },
  platform_up_12: { label: "Platform up ~12 m", section: "wide", segs: [{ L: 48, pitch: 15 * DEG, ramp: 24 }, { L: 48, pitch: -15 * DEG, ramp: 24 }] },
  platform_down_12: { label: "Platform down ~12 m", section: "wide", segs: [{ L: 48, pitch: -15 * DEG, ramp: 24 }, { L: 48, pitch: 15 * DEG, ramp: 24 }] },
  // FUNNEL / FLARE (user, 2026-10-21: big landing platforms need a way back to the road): the deck eases
  // from the wide platform (48 m) to the road (16 m), or back; the rails converge (oldLook.js taper)
  funnel_64: { label: "Funnel 48 → 16", section: "wide", taper: { from: 24, to: 8 }, segs: [{ L: 64 }] },
  flare_64: { label: "Flare 16 → 48", section: "wide", taper: { from: 8, to: 24 }, segs: [{ L: 64 }] },
  // PLATFORM SHAPES (user, 2026-10-22, Apex Rush's straight palette: wedges and a rounded end): the taper's
  // two edges each their own way (oldLook.js buildTaperLook `shape`). A WEDGE: one edge straight on, the
  // other cutting across to meet it — a right-angle triangle 48 × 48; CURVED, that edge a quarter circle;
  // a ROUND END, a half circle closing a platform. They end in a point or a curve: `closed`, nothing
  // snaps after them (side by side does).
  wedge_48: { label: "Wedge", section: "wide", closed: true, taper: { shape: "wedge", side: 1, hw: 24 }, segs: [{ L: 48 }] },
  wedge_48_L: { label: "Wedge (L)", section: "wide", closed: true, taper: { shape: "wedge", side: -1, hw: 24 }, segs: [{ L: 48 }] },
  curved_wedge_48: { label: "Curved wedge", section: "wide", closed: true, taper: { shape: "cwedge", side: 1, hw: 24 }, segs: [{ L: 48 }] },
  curved_wedge_48_L: { label: "Curved wedge (L)", section: "wide", closed: true, taper: { shape: "cwedge", side: -1, hw: 24 }, segs: [{ L: 48 }] },
  round_end_24: { label: "Round end", section: "wide", closed: true, taper: { shape: "cap", hw: 24 }, segs: [{ L: 24 }] },
  // ---- VERTICAL + TURN-AROUND pieces (user's Apex Rush top view, 2026-10-20: the tower climbs, the "C") ----
  // HALF LOOP + ROLL (an Immelmann): up the wall, over the top upside down, and the road rolls you upright
  // again — heading BACK, ~2R higher. Road hold holds the car through the roll (as the twist).
  half_loop_28: { label: "Half loop + roll", segs: [{ L: Math.PI * 28 + 50, pitch: Math.PI, ramp: 25 }, { L: 96, roll: Math.PI, ramp: 48 }], roadHold: true, twistPivot: 0.9 },
  // U-TURN WALL (the "C" at a road's end): a tight 180° banked up to 65° — the car rides up the wall
  // and comes round onto a road beside the way in
  uturn_wall_32: { label: "U-turn wall", segs: [{ L: turnLen(32, Math.PI, 30), turn: Math.PI, ramp: 30, bank: 65 * DEG }] },
  slope_up_12: { label: "Slope up ~12 m", segs: [{ L: 48, pitch: 15 * DEG, ramp: 24 }, { L: 48, pitch: -15 * DEG, ramp: 24 }] },
  // HELIX (PIECES §7c, "use height" on small maps): a full circle (R 56) that climbs or drops 20 m over
  // itself — the exit runs on, in the entry's heading, 20 m above / below it. Banked with the curvature
  // (level at both ends, so it meets any flat road).
  helix_up_360: { label: "Helix up 360°", segs: [{ L: turnLen(56, 2 * Math.PI, 40), turn: 2 * Math.PI, ramp: 40, bank: 20 * DEG }], rise: 20 },
  helix_down_360: { label: "Helix down 360°", segs: [{ L: turnLen(56, 2 * Math.PI, 40), turn: 2 * Math.PI, ramp: 40, bank: 20 * DEG }], rise: -20 },
};
// LEFT-HAND VERSIONS: every piece that turns, leans or steps sideways gets a mirror, `<id>_L`
// (turn, lean and the loop's sideways step negated). A test track of only right turns spiralled into
// itself (the user saw it overlap).
for (const [id, t] of Object.entries({ ...TILES })) {
  const handed = t.segs.some((s) => s.turn || s.leanIn || s.leanOut || s.offset || s.roll);
  if (!handed) continue;
  TILES[`${id}_L`] = {
    ...t,
    label: `${t.label} (L)`,
    segs: t.segs.map((s) => ({
      ...s,
      ...(s.turn ? { turn: -s.turn } : {}),
      ...(s.leanIn !== undefined ? { leanIn: -s.leanIn } : {}),
      ...(s.leanOut !== undefined ? { leanOut: -s.leanOut } : {}),
      ...(s.offset ? { offset: -s.offset } : {}),
      ...(s.bank ? { bank: -s.bank } : {}),
      ...(s.roll ? { roll: -s.roll } : {}),
    })),
  };
}
for (const [id, t] of Object.entries(TILES)) t.id = id;
// Landings are met tipped DOWN along the flight arc by this angle (deg); their exit is then level.
for (const [id, a] of [["landing_20", 20], ["banked_landing_20", 20], ["landing_turn_20", 20], ["catch_pad", 8]]) {
  TILES[id].landAngle = a;
  if (TILES[`${id}_L`]) TILES[`${id}_L`].landAngle = a;
}

/**
 * GENERATED TILES (B2): a FITTED LANDING sized to one jump's speed band (PIECES.md §7b). Its id
 * carries its size, `fitted_landing_<angle>_<D>`: a down-slope at <angle>° for D m (the catch zone:
 * from where the slowest arc lands to where the fastest does, plus a margin), then a curve back to
 * level. Any page rebuilds the exact same piece from the id — a saved track needs nothing else.
 * TILTED (user, 2026-10-21, Apex Rush: land with the air roll), `fitted_landing_<angle>_<D>_t<tilt>`:
 * the catch zone leans <tilt>° (signed, + = the right side low) and the curve rolls it back to flat, so
 * the exit is level and flat — the player rolls the car in the air to match (landing.js grades it).
 */
/**
 * Other modules can add tiles (oldTiles.js brings the old kit's bowl and flip ramp). A resolver
 * returns a tile for an id it knows, or undefined. A tile may carry `customIntegrate(tile, opts)`
 * instead of `segs` — then `integrate` hands it the job.
 */
export const TILE_RESOLVERS = [];

/**
 * ADJUSTABLE PIECES (user, 2026-10-20): one card with settings instead of a dozen presets. The settings
 * are in the id, so any page rebuilds the same piece from the saved track:
 *   adj_straight_<L>           a straight, L m
 *   adj_turn_<R>_<A>[_L]       a flat turn of A° at core radius R m (eased in and out, like the turn set)
 *   adj_turn_<R>_<A>_<w>[_L]   …and its WIDTH (user, 2026-10-22, Apex Rush's many turn shapes): r road ·
 *                              n narrow (plank turns) · w wide (platform corners: R down to the inside edge
 *                              nearly sharp, 4 m — a rounded corner)
 *   adj_slope_<u|d><H>         an S in the vertical: level in, level out, H m up / down
 *   adj_kicker_<A>             a kicker at A° (its last 8 m a lip) — the first form, kept for saved tracks
 *   adj_kicker_<A>_<L>_<w>     THE RAMP (user, 2026-10-22: "ramps in more sizes", Apex Rush has ~18): A° up
 *                              over L m (the curl eased over its whole length — short = sharp, long =
 *                              gentle), w the width: r road 16 m · n narrow 8 m (planks) · w wide 48 m
 *                              (platforms). 5–95°: a bump, a kicker, a launch, a quarter pipe.
 */
export const ADJUSTABLE = {
  adj_straight: { label: "Straight", params: { L: { label: "Length", min: 8, max: 256, step: 8, unit: " m", def: 64 } } },
  adj_turn: { label: "Turn", hand: true, params: {
    A: { label: "Angle", min: 15, max: 180, step: 15, unit: "°", def: 90 },
    R: { label: "Radius", min: 24, max: 256, step: 4, unit: " m", def: 96 },
    W: { label: "Width", min: 0, max: 2, step: 1, unit: "", def: 0, names: ["Road", "Narrow", "Wide"] },
  } },
  adj_slope: { label: "Slope", params: { H: { label: "Height", min: -40, max: 40, step: 2, unit: " m", def: 12, signed: true } } },
  adj_kicker: { label: "Ramp", params: {
    A: { label: "Angle", min: 5, max: 95, step: 5, unit: "°", def: 20 },
    L: { label: "Length", min: 12, max: 96, step: 4, unit: " m", def: 28 },
    W: { label: "Width", min: 0, max: 2, step: 1, unit: "", def: 0, names: ["Road", "Narrow", "Wide"] },
  } },
};
/** The id of an adjustable piece with these settings (`hand` −1 = left). */
export function adjustableId(base, p, hand = 1) {
  if (base === "adj_straight") return `adj_straight_${p.L}`;
  if (base === "adj_turn") return `adj_turn_${p.R}_${p.A}${p.W ? `_${"rnw"[p.W]}` : ""}${hand < 0 ? "_L" : ""}`;
  if (base === "adj_slope") return `adj_slope_${p.H < 0 ? "d" : "u"}${Math.abs(p.H)}`;
  if (base === "adj_kicker") return `adj_kicker_${p.A}_${p.L}_${"rnw"[p.W ?? 0]}`;
  return null;
}
/** An adjustable piece's base and settings from its id, or null. */
export function parseAdjustable(id) {
  let m;
  if ((m = /^adj_straight_(\d+)$/.exec(id))) return { base: "adj_straight", p: { L: +m[1] }, hand: 1 };
  if ((m = /^adj_turn_(\d+)_(\d+)(?:_([rnw]))?(_L)?$/.exec(id))) return { base: "adj_turn", p: { R: +m[1], A: +m[2], W: m[3] ? "rnw".indexOf(m[3]) : 0 }, hand: m[4] ? -1 : 1 };
  if ((m = /^adj_slope_([ud])(\d+)$/.exec(id))) return { base: "adj_slope", p: { H: (m[1] === "d" ? -1 : 1) * +m[2] }, hand: 1 };
  if ((m = /^adj_kicker_(\d+)$/.exec(id))) return { base: "adj_kicker", p: { A: +m[1], L: Math.max(16, Math.round((28 * +m[1]) / 20)), W: 0, old: true }, hand: 1 };
  if ((m = /^adj_kicker_(\d+)_(\d+)_([rnw])$/.exec(id))) return { base: "adj_kicker", p: { A: +m[1], L: +m[2], W: "rnw".indexOf(m[3]) }, hand: 1 };
  return null;
}
TILE_RESOLVERS.push((id) => {
  const a = parseAdjustable(id);
  if (!a) return undefined;
  const { base, p, hand } = a;
  if (base === "adj_straight") return { label: `Straight ${p.L}`, segs: [{ L: p.L }] };
  if (base === "adj_turn") {
    // the turn set's easing: ~0.3 R of curvature ramp at each end (R24 → 12 m … R128+ → 40 m)
    const section = ["road", "narrow", "wide"][p.W ?? 0];
    // a wide corner: never tighter than its own half width + 4 m (the inside edge a near-sharp corner)
    const R = Math.max(p.R, SECTIONS[section].hw + 4);
    const ramp = Math.min(40, Math.max(12, Math.round(R * 0.31)));
    const turn = hand * p.A * DEG;
    return {
      label: `Turn ${p.A}° · R${R}${section === "road" ? "" : ` · ${section}`}${hand < 0 ? " (L)" : ""}`,
      ...(section === "road" ? {} : { section }),
      segs: [{ L: turnLen(R, p.A * DEG, ramp), turn, ramp }],
      ...(R <= 48 && section === "road" ? { marks: [{ kind: "chevron", from: 0, to: -0 }] } : {}),
    };
  }
  if (base === "adj_slope") {
    // slope_up_12's S (two 48 m halves at 15°) rises 12.47 m: longer for more height, flatter (never
    // shorter than 32 m a half) for less
    const H = Math.abs(p.H), s = Math.sign(p.H) || 1;
    let L = (48 * H) / 12.47, pitch = 15;
    if (L < 32) { pitch = (15 * L) / 32; L = 32; }
    return { label: `Slope ${p.H >= 0 ? "up" : "down"} ${H} m`, segs: [{ L, pitch: s * pitch * DEG, ramp: L / 2 }, { L, pitch: -s * pitch * DEG, ramp: L / 2 }] };
  }
  if (p.old) {
    const L = Math.max(16, Math.round((28 * p.A) / 20)); // kicker_20 is 28 m
    return { label: `Kicker ${p.A}°`, segs: [{ L, pitch: p.A * DEG, ramp: L / 2 }], marks: [{ kind: "lip", from: -8, to: -0 }] };
  }
  // THE RAMP: the old kicker's shape (curvature eased over half the length) at any angle, length, width
  const section = ["road", "narrow", "wide"][p.W ?? 0];
  const lip = Math.min(8, Math.round(p.L / 4));
  return {
    label: `Ramp ${p.A}° · ${p.L} m${section === "road" ? "" : ` · ${section}`}`,
    ...(section === "road" ? {} : { section }),
    segs: [{ L: p.L, pitch: p.A * DEG, ramp: p.L / 2 }],
    marks: [{ kind: "lip", from: -lip, to: -0 }],
  };
});

export function ensureTile(id) {
  if (TILES[id]) return TILES[id];
  for (const resolve of TILE_RESOLVERS) {
    const t = resolve(id);
    if (t) { TILES[id] = { ...t, id }; return TILES[id]; }
  }
  // THE CATCH TUBE, `catch_tube_<angle>_<D>` (user, 2026-10-21: "some jump to enter inside a tube in
  // air"): a fitted landing's shape — a down-slope at <angle>° for D m, then a level-out — built as a TUBE
  // that starts as the wide oval PORTAL (closure 0: 32 m wide, 16 m floor to roof) and closes into the
  // pipe by its end. The builder lays its mouth on the jump's arc (the slow car on its floor, the fast one
  // under its roof); it ends level, in a full pipe: a Tube piece goes next.
  const ct = /^catch_tube_(\d+)_(\d+)$/.exec(id);
  if (ct) {
    const angle = Number(ct[1]), D = Number(ct[2]);
    TILES[id] = {
      id,
      label: `Catch tube ${angle}° · ${D} m`,
      landAngle: angle,
      segs: [{ L: D }, { L: Math.max(44, Math.round(angle * 2.2)), pitch: angle * DEG, ramp: Math.max(22, Math.round(angle * 1.1)) }],
      tube: { from: 0, to: 1 },
      marks: [{ kind: "landing", from: 0, to: D }],
    };
    return TILES[id];
  }
  const m = /^fitted_landing_(\d+)_(\d+)(?:_t(-?\d+))?$/.exec(id);
  if (!m) return undefined;
  const angle = Number(m[1]), D = Number(m[2]), tilt = Number(m[3] ?? 0) * DEG;
  const lean = tilt ? [{ leanIn: tilt, leanOut: tilt }, { leanIn: tilt, leanOut: 0 }] : [{}, {}];
  TILES[id] = {
    id,
    label: `${tilt ? "Tilted" : "Fitted"} landing ${angle}° · ${D} m${tilt ? ` · ${Math.abs(m[3])}° ${tilt > 0 ? "right" : "left"} low` : ""}`,
    landAngle: angle,
    ...(tilt ? { tilt } : {}),
    segs: [{ L: D, ...lean[0] }, { L: Math.max(44, Math.round(angle * 2.2)), pitch: angle * DEG, ramp: Math.max(22, Math.round(angle * 1.1)), ...lean[1] }],
    marks: [{ kind: "landing", from: 0, to: D }],
  };
  return TILES[id];
}

/** Lean at the entry / exit of a tile (radians). */
export const leanIn = (t) => t.segs?.[0].leanIn ?? 0;
export function leanOut(t) {
  let l = 0;
  for (const s of t.segs ?? []) l = s.leanOut ?? s.leanIn ?? l;
  // a full twist ends at 360°: the same road as 0° — compare leans modulo a turn
  const TAU = 2 * Math.PI;
  l = ((l % TAU) + TAU) % TAU;
  return l > Math.PI ? l - TAU : l;
}
