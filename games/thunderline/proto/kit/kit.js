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
      rotate(T, U, R, q, -(seg.turn ?? 0) * w * 0.5, (seg.pitch ?? 0) * w * 0.5);
      p.addScaledVector(T, ds);
      rotate(T, U, R, q, -(seg.turn ?? 0) * w * 0.5, (seg.pitch ?? 0) * w * 0.5);
      if (off) {
        const want = off * q5((x0 + ds) / L);
        p.addScaledVector(R0, want - shifted);
        shifted = want;
      }
      s += ds;
      lean = leanIn + (leanOut - leanIn) * q5((x0 + ds) / L);
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

function rotate(T, U, R, q, yaw, pitch) {
  if (yaw) { q.setFromAxisAngle(U, yaw); T.applyQuaternion(q); R.applyQuaternion(q); }
  if (pitch) { q.setFromAxisAngle(R, pitch); T.applyQuaternion(q); U.applyQuaternion(q); }
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
  catch_pad: {
    label: "Catch pad",
    section: "wide",
    segs: [{ L: 64, pitch: 8 * DEG, ramp: 32 }],
    marks: [{ kind: "landing", from: 0, to: 40 }],
  },
  boost_32: { label: "Boost 32", segs: [{ L: 32 }], marks: [{ kind: "boost", from: 4, to: 28 }] },
  // ---- THE TUBE FAMILY (tubeLook.js: one section, closure 0 = road … 1 = pipe r 8 m) ----
  // Sized for ~60 m/s: in a turn the car rides the wall at atan(v²/gR) — R64 ≈ 80° at full speed.
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
};
// LEFT-HAND VERSIONS: every piece that turns, leans or steps sideways gets a mirror, `<id>_L`
// (turn, lean and the loop's sideways step negated). A test track of only right turns spiralled into
// itself (the user saw it overlap).
for (const [id, t] of Object.entries({ ...TILES })) {
  const handed = t.segs.some((s) => s.turn || s.leanIn || s.leanOut || s.offset);
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
 */
/**
 * Other modules can add tiles (oldTiles.js brings the old kit's bowl and flip ramp). A resolver
 * returns a tile for an id it knows, or undefined. A tile may carry `customIntegrate(tile, opts)`
 * instead of `segs` — then `integrate` hands it the job.
 */
export const TILE_RESOLVERS = [];

export function ensureTile(id) {
  if (TILES[id]) return TILES[id];
  for (const resolve of TILE_RESOLVERS) {
    const t = resolve(id);
    if (t) { TILES[id] = { ...t, id }; return TILES[id]; }
  }
  const m = /^fitted_landing_(\d+)_(\d+)$/.exec(id);
  if (!m) return undefined;
  const angle = Number(m[1]), D = Number(m[2]);
  TILES[id] = {
    id,
    label: `Fitted landing ${angle}° · ${D} m`,
    landAngle: angle,
    segs: [{ L: D }, { L: Math.max(44, Math.round(angle * 2.2)), pitch: angle * DEG, ramp: Math.max(22, Math.round(angle * 1.1)) }],
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
