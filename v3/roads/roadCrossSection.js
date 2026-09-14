// Cross-section: what a road is made of, sideways.
//
// A road is a CENTRE STRIP plus two ordered lane lists, each read from the
// centre outward. Right lanes run forward (a → b), left lanes backward. A lane
// is { type, width, turn? }. Markings are NOT authored per lane: they are
// derived from which lane types sit next to each other (roadMarkings.js), so a
// new lane stack is marked correctly with no extra work.
//
// SECTIONS change the stack along the road — a left-turn pocket opening before
// a junction, parking ending at a corner, a lane dropping after a merge. A
// section is a zone anchored to one end ({ from:'end', d }) that applies ops at
// full strength inside and blends out over `taper` metres. Lanes keep identity
// through a taper (their width goes to/from 0), so geometry, markings and the
// traffic lane graph all stay continuous.

import { clamp, smooth01 } from "./roadMath.js";

/** Lane-type behaviour. `carriage` = paved and drivable-adjacent (inside the curb). */
export const LANE_TYPES = {
  driving: { carriage: true, drive: true, label: "Driving" },
  turn: { carriage: true, drive: true, label: "Turn" },
  bus: { carriage: true, drive: true, label: "Bus" },
  parking: { carriage: true, label: "Parking" },
  bike: { carriage: true, label: "Bike" },
  shoulder: { carriage: true, label: "Shoulder" },
  sidewalk: { roadside: true, walk: true, label: "Sidewalk" },
  verge: { roadside: true, label: "Verge (trees)" },
  barrier: { roadside: true, label: "Barrier" },
};

export const CENTER_KINDS = ["line", "painted", "raised", "barrier"];

const L = (type, width, extra) => ({ type, width, ...extra });

/**
 * Road types. rank orders them for junction control (higher = major road).
 * Widths are typical European urban / motorway dimensions.
 */
export const ROAD_TYPES = {
  alley: {
    label: "Alley", rank: 0, speed: 20, maxGrade: 0.14, radius: 12, cornerRadius: 3,
    center: { width: 0, kind: "none" },
    left: [L("driving", 2.6), L("sidewalk", 1.2)],
    right: [L("driving", 2.6), L("sidewalk", 1.2)],
    crosswalks: false, lampSpacing: 22, treeSpacing: 0,
  },
  local: {
    label: "Local street", rank: 1, speed: 30, maxGrade: 0.12, radius: 25, cornerRadius: 6,
    center: { width: 0, kind: "line" },
    left: [L("driving", 3.0), L("parking", 2.2), L("sidewalk", 2.5)],
    right: [L("driving", 3.0), L("parking", 2.2), L("sidewalk", 2.5)],
    crosswalks: true, lampSpacing: 26, treeSpacing: 0,
  },
  collector: {
    label: "Collector", rank: 2, speed: 50, maxGrade: 0.09, radius: 60, cornerRadius: 8,
    center: { width: 0, kind: "line" },
    left: [L("driving", 3.25), L("bike", 1.6), L("sidewalk", 3.0)],
    right: [L("driving", 3.25), L("bike", 1.6), L("sidewalk", 3.0)],
    crosswalks: true, lampSpacing: 28, treeSpacing: 0,
  },
  avenue: {
    label: "Avenue", rank: 3, speed: 50, maxGrade: 0.08, radius: 80, cornerRadius: 10,
    center: { width: 0, kind: "line" },
    left: [L("driving", 3.25), L("driving", 3.25), L("parking", 2.3), L("sidewalk", 3.5)],
    right: [L("driving", 3.25), L("driving", 3.25), L("parking", 2.3), L("sidewalk", 3.5)],
    crosswalks: true, lampSpacing: 30, treeSpacing: 0,
  },
  boulevard: {
    label: "Boulevard", rank: 4, speed: 50, maxGrade: 0.07, radius: 120, cornerRadius: 11,
    center: { width: 5, kind: "raised" },
    left: [L("driving", 3.25), L("driving", 3.25), L("bike", 1.8), L("verge", 1.8), L("sidewalk", 4.0)],
    right: [L("driving", 3.25), L("driving", 3.25), L("bike", 1.8), L("verge", 1.8), L("sidewalk", 4.0)],
    crosswalks: true, lampSpacing: 32, treeSpacing: 9,
  },
  rural: {
    label: "Rural road", rank: 2, speed: 80, maxGrade: 0.08, radius: 250, cornerRadius: 12,
    center: { width: 0, kind: "line" },
    left: [L("driving", 3.25), L("shoulder", 0.75), L("verge", 2.5)],
    right: [L("driving", 3.25), L("shoulder", 0.75), L("verge", 2.5)],
    crosswalks: false, lampSpacing: 0, treeSpacing: 0, spirals: true,
  },
  highway: {
    label: "Motorway (one carriageway)", rank: 5, speed: 110, maxGrade: 0.05, radius: 700, cornerRadius: 20,
    oneWay: true,
    center: { width: 0, kind: "line" },
    left: [L("shoulder", 1.0), L("barrier", 0.8)],
    right: [L("driving", 3.5), L("driving", 3.5), L("driving", 3.5), L("shoulder", 3.0), L("verge", 2.0)],
    crosswalks: false, lampSpacing: 0, treeSpacing: 0, spirals: true,
  },
  dualHighway: {
    label: "Motorway (both ways)", rank: 5, speed: 110, maxGrade: 0.05, radius: 700, cornerRadius: 20,
    center: { width: 3.2, kind: "barrier" },
    left: [L("shoulder", 1.0), L("driving", 3.5), L("driving", 3.5), L("shoulder", 3.0), L("verge", 2.0)],
    right: [L("shoulder", 1.0), L("driving", 3.5), L("driving", 3.5), L("shoulder", 3.0), L("verge", 2.0)],
    crosswalks: false, lampSpacing: 60, treeSpacing: 0, spirals: true,
  },
  ramp: {
    label: "Ramp (one-way)", rank: 3, speed: 50, maxGrade: 0.06, radius: 90, cornerRadius: 14,
    oneWay: true,
    center: { width: 0, kind: "line" },
    left: [L("shoulder", 1.0)],
    right: [L("driving", 3.75), L("shoulder", 2.5), L("verge", 1.5)],
    crosswalks: false, lampSpacing: 45, treeSpacing: 0, spirals: true,
  },
  oneWay: {
    label: "One-way street", rank: 1, speed: 30, maxGrade: 0.12, radius: 25, cornerRadius: 6,
    oneWay: true,
    center: { width: 0, kind: "line" },
    left: [L("parking", 2.2), L("sidewalk", 2.5)],
    right: [L("driving", 3.2), L("bike", 1.5), L("sidewalk", 2.5)],
    crosswalks: true, lampSpacing: 26, treeSpacing: 0,
  },
};

/** Section presets the lab offers. `side` resolves from the chosen end. */
export const SECTION_PRESETS = {
  leftPocket: { label: "Left-turn pocket", d: 40, taper: 20, add: { at: "inner", lane: { type: "turn", width: 3.0, turn: "left" } } },
  rightPocket: { label: "Right-turn pocket", d: 35, taper: 15, add: { at: "curb", lane: { type: "turn", width: 3.0, turn: "right" } } },
  parkingEnds: { label: "No parking near corner", d: 18, taper: 6, widthOf: { type: "parking", width: 0 } },
  laneDrop: { label: "Extra lane (drops)", d: 160, taper: 70, add: { at: "curb", lane: { type: "driving", width: 3.5 } } },
  bulbOut: { label: "Curb extension", d: 12, taper: 4, widthOf: { type: "parking", width: 0 }, sidewalkGrow: 2.2 },
};

/**
 * Build a section from a preset.
 * At the END of a road, arriving traffic uses the RIGHT lanes; at the START it
 * uses the LEFT lanes — so pockets go on the side that approaches that end.
 */
export function makeSection(presetKey, from, id, opts = {}) {
  const p = SECTION_PRESETS[presetKey];
  // One-way roads only carry traffic on the right lanes, whichever end.
  const side = opts.side || (opts.oneWay || from === "end" ? "right" : "left");
  const ops = [];
  if (p.add) ops.push({ op: "add", side, at: p.add.at, lane: { ...p.add.lane } });
  if (p.widthOf) {
    ops.push({ op: "width", side: "left", match: p.widthOf.type, width: p.widthOf.width });
    ops.push({ op: "width", side: "right", match: p.widthOf.type, width: p.widthOf.width });
  }
  if (p.sidewalkGrow) {
    ops.push({ op: "grow", side: "left", match: "sidewalk", by: p.sidewalkGrow });
    ops.push({ op: "grow", side: "right", match: "sidewalk", by: p.sidewalkGrow });
  }
  return { id, kind: presetKey, from, d: p.d, taper: p.taper, ops };
}

/**
 * ROAD SCALE — how much wider than real the drivable road is built.
 *
 * 1 = real-world widths (a 3.25 m lane for a 2.1 m car). Racing and open-world
 * games widen roads for playability (typically 1.2–1.5x); this is that knob.
 * It scales what a CAR uses — carriage lanes (driving, turn, bus, parking, bike,
 * shoulder), medians, and lanes added by sections — and, in roadJunction.js,
 * corner radii and roundabout rings. It does NOT scale what a PERSON uses
 * (sidewalks, verges, barriers), paint widths, or the plan geometry (curves).
 */
const scaledWidth = (type, width, scale) => (LANE_TYPES[type]?.carriage ? width * scale : width);

function baseStack(road, types, scale) {
  const t = types[road.type] || types.local;
  const src = road.lanes || t;
  return {
    type: t,
    center: { width: (src.center?.width ?? 0) * scale, kind: src.center?.kind ?? "line" },
    left: (src.left || []).map((l) => ({ ...l, width: scaledWidth(l.type, l.width, scale) })),
    right: (src.right || []).map((l) => ({ ...l, width: scaledWidth(l.type, l.width, scale) })),
  };
}

/**
 * Resolve a road's stack: stable lane ids, the union order of every lane that
 * ever exists (sections insert into it), and per-lane width modifiers.
 * `scale` = the network's road scale (see scaledWidth).
 */
export function resolveStack(road, types = ROAD_TYPES, scale = 1) {
  const base = baseStack(road, types, scale);
  const sides = { left: [], right: [] };
  for (const side of ["left", "right"]) {
    base[side].forEach((l, i) => {
      sides[side].push({
        id: `${side[0].toUpperCase()}${i}`, side, type: l.type, turn: l.turn || null,
        base: l.width, full: l.width, mods: [],
      });
    });
  }
  const centerMods = [];
  const sections = (road.sections || []).map((sec, si) => ({ ...sec, index: si }));
  for (const sec of sections) {
    for (const [oi, op] of (sec.ops || []).entries()) {
      if (op.op === "center") { centerMods.push({ sec, width: op.width * scale }); continue; }
      const list = sides[op.side];
      if (!list) continue;
      if (op.op === "add") {
        const w = scaledWidth(op.lane.type, op.lane.width, scale);
        const lane = {
          id: `S${sec.id ?? si}_${oi}`, side: op.side, type: op.lane.type, turn: op.lane.turn || null,
          base: 0, full: w, mods: [{ sec, width: w }], added: true,
        };
        let idx = 0;
        if (op.at === "curb") {
          idx = list.findIndex((l) => !LANE_TYPES[l.type]?.carriage || l.type === "parking" || l.type === "shoulder");
          if (idx < 0) idx = list.length;
        } else if (typeof op.at === "number") idx = clamp(op.at, 0, list.length);
        list.splice(idx, 0, lane);
      } else if (op.op === "width" || op.op === "grow") {
        for (const l of list) {
          const hit = typeof op.match === "number" ? list.indexOf(l) === op.match : l.type === op.match;
          if (!hit || l.added) continue;
          l.mods.push(op.op === "grow" ? { sec, grow: op.by } : { sec, width: scaledWidth(l.type, op.width, scale) });
          if (op.op === "grow") l.full = Math.max(l.full, l.base + op.by);
        }
      }
    }
  }
  return { type: base.type, center: base.center, centerMods, sides, sections };
}

/** Blend weight of a section at station s on a road of length L. */
export function sectionAlpha(sec, s, L) {
  const d = Math.max(0, sec.d || 0), taper = Math.max(0.01, sec.taper || 0.01);
  if (sec.from === "start") {
    if (s <= d) return 1;
    return 1 - smooth01((s - d) / taper);
  }
  const z = L - d;
  if (s >= z) return 1;
  return smooth01((s - (z - taper)) / taper);
}

export function laneWidthAt(lane, s, L) {
  let w = lane.base;
  for (const m of lane.mods) {
    const a = sectionAlpha(m.sec, s, L);
    if (a <= 0) continue;
    if (m.grow != null) w += m.grow * a;
    else w += (m.width - w) * a;
  }
  return Math.max(0, w);
}

export function centerWidthAt(stack, s, L) {
  let w = stack.center.width;
  for (const m of stack.centerMods) {
    const a = sectionAlpha(m.sec, s, L);
    if (a > 0) w += (m.width - w) * a;
  }
  return Math.max(0, w);
}

/**
 * Lateral layout at station s. Each lane gets tIn (edge nearer the centre) and
 * tOut, signed (right lanes negative). Zero-width lanes are kept (present:false)
 * so indices stay stable along the road.
 */
export function layoutAt(stack, s, L) {
  const cw = centerWidthAt(stack, s, L);
  const out = { cw, left: [], right: [] };
  for (const side of ["left", "right"]) {
    const sign = side === "left" ? 1 : -1;
    let acc = cw / 2;
    for (const lane of stack.sides[side]) {
      const w = laneWidthAt(lane, s, L);
      out[side].push({
        id: lane.id, lane, type: lane.type, turn: lane.turn, w,
        tIn: sign * acc, tOut: sign * (acc + w), present: w > 0.05,
      });
      acc += w;
    }
  }
  return out;
}

/** Extents of a layout: property edges, curb edges, carriage extents. */
export function layoutEdges(lay) {
  const edge = (side) => {
    const sign = side === "left" ? 1 : -1;
    let curb = sign * lay.cw / 2, prop = sign * lay.cw / 2;
    for (const l of lay[side]) {
      prop = l.tOut;
      if (LANE_TYPES[l.type]?.carriage) curb = l.tOut;
    }
    return { curb, prop };
  };
  const le = edge("left"), re = edge("right");
  return { curbL: le.curb, propL: le.prop, curbR: re.curb, propR: re.prop };
}

/** Stations where section ramps begin/end — the sampler must hit them. */
export function sectionBreaks(stack, L) {
  const out = [];
  for (const sec of stack.sections) {
    const d = Math.max(0, sec.d || 0), taper = Math.max(0.01, sec.taper || 0.01);
    const a = sec.from === "start" ? d : L - d;
    const b = sec.from === "start" ? d + taper : L - d - taper;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = 0; i <= 8; i++) out.push(lo + ((hi - lo) * i) / 8);
  }
  return out.filter((v) => v > 0 && v < L);
}

/** Midpoints of ramps: where a lane crosses half its width (lane graph events). */
export function sectionEventStations(stack, L) {
  const out = [];
  for (const sec of stack.sections) {
    const d = Math.max(0, sec.d || 0), taper = Math.max(0.01, sec.taper || 0.01);
    const s = sec.from === "start" ? d + taper / 2 : L - d - taper / 2;
    if (s > 0.5 && s < L - 0.5) out.push(s);
  }
  return [...new Set(out.map((v) => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
}

/** Width of the widest layout along the road (for proximity tests). */
export function maxHalfWidth(stack, L) {
  let m = 0;
  const probes = [0, L / 2, L, ...sectionBreaks(stack, L)];
  for (const s of probes) {
    const e = layoutEdges(layoutAt(stack, s, L));
    m = Math.max(m, e.propL, -e.propR);
  }
  return m;
}
