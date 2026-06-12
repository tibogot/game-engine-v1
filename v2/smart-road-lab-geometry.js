/**
 * Smart Road lab geometry — SUCCESSOR COPY of `core/road/roadNetworkLabGeometry.js`.
 * The original stays untouched until Smart Road is proven and swapped in one move;
 * all geometry evolution happens here. Lab pages import THIS file.
 *
 * Changes over the original:
 *  - PER-EDGE CURVES: `bend` (signed lateral bow, meters at the chord midpoint)
 *    makes the edge a quadratic Bézier through the bow point. Junction mouths sit
 *    ON the curve, road directions at a node are the curve's END TANGENTS, and
 *    corners/clips use those tangents — curved roads enter junctions at their
 *    natural angle.
 *  - ANGLE-AWARE CLIP DISTANCES: roads meeting at angle θ (between their tangents
 *    at the node) overlap until ~hw / tan(θ/2); each road end is clipped past its
 *    overlap with its closest angular neighbor. This is what makes tangent-aware
 *    junctions safe — the earlier failure was angle-blind clips, not the tangents.
 *  - corner reach scales with the clips (fixed reach rejected legitimate corners
 *    once clips grew, cutting junctions below their node).
 *
 * Internal plane: (x, y) where y maps to world Z in Three.js.
 */

export const ROAD_PROFILES = {
  flat: {
    label: "Flat",
    points: [
      { t: 0, y: 0 },
      { t: 1, y: 0 },
    ],
  },
  crowned: {
    label: "Crowned",
    points: [
      { t: 0, y: 0 },
      { t: 0.15, y: 0.02 },
      { t: 0.5, y: 0.06 },
      { t: 0.85, y: 0.02 },
      { t: 1, y: 0 },
    ],
  },
  curbed: {
    label: "Curbed",
    points: [
      { t: 0, y: 0.15 },
      { t: 0.06, y: 0.15 },
      { t: 0.1, y: 0 },
      { t: 0.9, y: 0 },
      { t: 0.94, y: 0.15 },
      { t: 1, y: 0.15 },
    ],
  },
  highway: {
    label: "Highway",
    points: [
      { t: 0, y: 0 },
      { t: 0.08, y: 0.12 },
      { t: 0.12, y: 0.12 },
      { t: 0.18, y: 0 },
      { t: 0.5, y: 0.04 },
      { t: 0.82, y: 0 },
      { t: 0.88, y: 0.12 },
      { t: 0.92, y: 0.12 },
      { t: 1, y: 0 },
    ],
  },
  dirtPath: {
    label: "Dirt path",
    points: [
      { t: 0, y: -0.04 },
      { t: 0.15, y: 0.01 },
      { t: 0.5, y: 0.03 },
      { t: 0.85, y: 0.01 },
      { t: 1, y: -0.04 },
    ],
  },
};

function sampleProfileY(profile, t) {
  const pts = profile.points;
  if (t <= pts[0].t) return pts[0].y;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].y;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const seg = (t - pts[i - 1].t) / (pts[i].t - pts[i - 1].t);
      return pts[i - 1].y + (pts[i].y - pts[i - 1].y) * seg;
    }
  }
  return 0;
}

function profileColumns(profile, minCols) {
  const tSet = new Set(profile.points.map(p => p.t));
  const cols = minCols ?? 5;
  for (let i = 0; i < cols; i++) tSet.add(i / (cols - 1));
  const sorted = [...tSet].sort((a, b) => a - b);
  return sorted;
}

function vec(x = 0, y = 0) {
  return { x, y };
}
function add(a, b) {
  return vec(a.x + b.x, a.y + b.y);
}
function sub(a, b) {
  return vec(a.x - b.x, a.y - b.y);
}
function mul(a, s) {
  return vec(a.x * s, a.y * s);
}
function cross(a, b) {
  return a.x * b.y - a.y * b.x;
}
function len(a) {
  return Math.hypot(a.x, a.y);
}
function norm(a) {
  const l = len(a);
  return l < 1e-6 ? vec(1, 0) : vec(a.x / l, a.y / l);
}
function perpLeft(a) {
  return vec(-a.y, a.x);
}
function dist(a, b) {
  return len(sub(a, b));
}
function lerp(a, b, t) {
  return vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
}

function lineIntersection(p, d, q, e) {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-6) return null;
  const qp = sub(q, p);
  const t = cross(qp, e) / den;
  const u = cross(qp, d) / den;
  return { p: add(p, mul(d, t)), t, u };
}

function angleLerp(a0, a1, t) {
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a0 + d * t;
}

function quadraticPoint(P0, P1, P2, t) {
  const u = 1 - t;
  return add(add(mul(P0, u * u), mul(P1, 2 * u * t)), mul(P2, t * t));
}

function quadraticDeriv(P0, P1, P2, t) {
  return add(mul(sub(P1, P0), 2 * (1 - t)), mul(sub(P2, P1), 2 * t));
}

function sampleQuadraticOffset(P0, P1, P2, offset, samples) {
  const out = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = quadraticPoint(P0, P1, P2, t);
    const side = perpLeft(norm(quadraticDeriv(P0, P1, P2, t)));
    out.push(add(p, mul(side, offset)));
  }
  return out;
}

/** Sub-curve of a quadratic Bézier on [u, v] via the blossom — again a quadratic. */
function quadraticSub(P0, P1, P2, u, v) {
  const blossom = (s, t) =>
    add(add(mul(P0, (1 - s) * (1 - t)), mul(P1, s * (1 - t) + t * (1 - s))), mul(P2, s * t));
  return { Q0: blossom(u, u), Q1: blossom(u, v), Q2: blossom(v, v) };
}

/** Arc-length table for a quadratic: { ts, cum, total }. */
function quadraticArcTable(P0, P1, P2, samples = 48) {
  const ts = [0];
  const cum = [0];
  let prev = P0;
  let total = 0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const p = quadraticPoint(P0, P1, P2, t);
    total += dist(prev, p);
    ts.push(t);
    cum.push(total);
    prev = p;
  }
  return { ts, cum, total };
}

/** Invert arc length → t on the table (linear interp between samples). */
function tAtArcLength(table, s) {
  const { ts, cum, total } = table;
  if (s <= 0) return 0;
  if (s >= total) return 1;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= s) {
      const span = cum[i] - cum[i - 1];
      const f = span > 1e-8 ? (s - cum[i - 1]) / span : 0;
      return ts[i - 1] + (ts[i] - ts[i - 1]) * f;
    }
  }
  return 1;
}

function buildNetworkBend(start, control, end, width, curveSegments, lateralCols, profile) {
  const hw = width * 0.5;
  const samples = Math.max(4, curveSegments | 0);
  const left = sampleQuadraticOffset(start, control, end, hw, samples);
  const right = sampleQuadraticOffset(start, control, end, -hw, samples);

  let grid = null;
  let gridProfile = null;
  const tCols = profile ? profileColumns(profile, lateralCols ?? 5) : null;
  const cols = tCols ? tCols.length : (lateralCols ?? 0);
  if (cols >= 3) {
    const paths = [];
    const profileYs = [];
    for (let j = 0; j < cols; j++) {
      const tVal = tCols ? tCols[j] : j / (cols - 1);
      const lateral = hw * (1 - 2 * tVal);
      paths.push(sampleQuadraticOffset(start, control, end, lateral, samples));
      if (profile) profileYs.push(sampleProfileY(profile, tVal));
    }
    grid = [];
    for (let i = 0; i <= samples; i++) {
      const row = [];
      for (let j = 0; j < cols; j++) {
        row.push(paths[j][i]);
      }
      grid.push(row);
    }
    if (profile) gridProfile = profileYs;
  }

  return {
    polygon: [...left, ...right.slice().reverse()],
    left: { path: left, debug: [] },
    right: { path: right, debug: [] },
    center: sampleQuadraticOffset(start, control, end, 0, samples),
    grid,
    gridProfile,
    networkBend: true,
  };
}

/**
 * Junction fill polygon from precomputed road ends.
 * roadEnds: { mouth, away (unit tangent pointing OUT of the junction along the
 * road), sortDir (unit, node → mouth, for angular ordering), clip }.
 * Straight edges reproduce the original exactly (away == sortDir == road.dir).
 */
function junctionBoundary(node, roadEnds, hw, junctionRadius, junctionSegments) {
  const entries = roadEnds
    .map((re) => {
      const side = perpLeft(re.away);
      return {
        angle: Math.atan2(re.sortDir.y, re.sortDir.x),
        dir: re.away,
        clip: re.clip,
        left: add(re.mouth, mul(side, hw)),
        right: add(re.mouth, mul(side, -hw)),
      };
    })
    .sort((a, b) => a.angle - b.angle);

  const fillPath = [];
  const segments = [];
  for (let i = 0; i < entries.length; i++) {
    const current = entries[i];
    const next = entries[(i + 1) % entries.length];
    if (fillPath.length === 0) fillPath.push(current.right);
    fillPath.push(current.left);

    const start = current.left;
    const end = next.right;
    const cornerHit = lineIntersection(start, current.dir, end, next.dir);
    const fallbackMid = lerp(start, end, 0.5);
    const fallbackOut = norm(sub(fallbackMid, node.p));
    let corner = cornerHit ? cornerHit.p : add(fallbackMid, mul(fallbackOut, hw));
    // Reach must scale with the clips: angle-aware clips push mouths farther
    // out, and a fixed limit rejects legitimate corners (junction then cuts
    // below the node instead of wrapping it). Standard junctions are unchanged.
    const maxCornerReach = Math.max(hw * 2.2, junctionRadius * 1.25, (current.clip + next.clip) * 0.9);
    if (dist(corner, start) > maxCornerReach || dist(corner, end) > maxCornerReach) {
      corner = add(fallbackMid, mul(fallbackOut, hw * 0.65));
    }

    const segment = [];
    const segmentCount = Math.max(3, junctionSegments | 0);
    for (let s = 0; s <= segmentCount; s++) {
      const t = s / segmentCount;
      const a = lerp(start, corner, t);
      const b = lerp(corner, end, t);
      segment.push(lerp(a, b, t));
    }
    fillPath.push(...segment.slice(1));
    segments.push(segment);
  }
  return { polygon: fillPath, outlineSegments: segments };
}

/**
 * @param nodes { id, x, z, forceJunction?, roundabout? }[] — `roundabout` turns the node into
 *   a circulating ring (radius = params.roundaboutRadius) with connector flares per approach.
 * @param edges { a, b, bend?, style? }[] — `bend` = signed lateral bow (m) at the chord
 *   midpoint (0/absent = straight). `style` overrides markings on network spans only.
 * @param params { width, lanesPerDir, junctionRadius, curveSegments, junctionSegments,
 *   twoRoadNodes, endCapStyle, lateralCols, spanLongStep, profilePreset, profileScale,
 *   centerLine?, laneLines?, doubleCenterLine?, centerLineGap?, centerLineWidth?,
 *   centerLeftEnabled?, centerRightEnabled?, centerLineDashed?, centerLeftDashed?,
 *   centerRightDashed?, centerLineDashScale?, laneDashScale? }
 */
export function buildLabNetworkGeometry(nodes, edges, params) {
  const width = params.width;
  const lanesPerDir = params.lanesPerDir ?? 1;
  const junctionRadius = params.junctionRadius ?? 12;
  /** Circulating-lane centerline radius for `roundabout` nodes. */
  const roundaboutRadius = params.roundaboutRadius ?? 16;
  /** World-space inset of painted edge lines from the road edge (lab passes its own). */
  const edgeLineInset = params.edgeLineInset ?? width * 0.066;
  const curveSegments = Math.max(4, params.curveSegments ?? 34);
  const junctionSegments = Math.max(3, params.junctionSegments ?? 14);
  const twoRoadNodes = params.twoRoadNodes ?? "smooth";
  const endCapStyle = params.endCapStyle ?? "flat";
  const lateralCols = Math.max(2, params.lateralCols ?? 5);
  const spanLongStep = Math.max(0.5, params.spanLongStep ?? 4);
  const profileKey = params.profilePreset ?? "flat";
  const profile = ROAD_PROFILES[profileKey] || ROAD_PROFILES.flat;
  const profileScale = params.profileScale ?? 1;
  const scaledProfile = {
    points: profile.points.map(p => ({ t: p.t, y: p.y * profileScale })),
  };
  const centerLine = params.centerLine !== false;
  const laneLines = !!params.laneLines;
  const doubleCenterLine = !!params.doubleCenterLine;
  const centerLineGap = params.centerLineGap ?? 0.012;
  const centerLineWidth = params.centerLineWidth ?? 0.02;
  const centerLeftEnabled = params.centerLeftEnabled !== false;
  const centerRightEnabled = params.centerRightEnabled !== false;
  const centerLineDashedGlobal = params.centerLineDashed !== false;
  const centerLeftDashedGlobal = params.centerLeftDashed !== false;
  const centerRightDashedGlobal = params.centerRightDashed !== false;
  const centerLineDashScale = params.centerLineDashScale ?? 0.08;
  const laneDashScale = params.laneDashScale ?? 0.08;

  /** Per-edge effective marking flags for `networkSpan` pieces (merged with globals). */
  function edgeSpanMarkingParams(edge) {
    const st = edge.style || {};
    const boolOr = (key, fallback) => (st[key] !== undefined ? !!st[key] : fallback);
    const numOr = (key, fallback) => (st[key] !== undefined ? st[key] : fallback);
    return {
      centerLine: boolOr("centerLine", centerLine),
      laneLines: boolOr("laneLines", laneLines),
      doubleCenterLine: boolOr("doubleCenterLine", doubleCenterLine),
      centerLineGap: numOr("centerLineGap", centerLineGap),
      centerLineWidth: numOr("centerLineWidth", centerLineWidth),
      centerLeftEnabled: boolOr("centerLeftEnabled", centerLeftEnabled),
      centerRightEnabled: boolOr("centerRightEnabled", centerRightEnabled),
      centerLineDashed: boolOr("centerLineDashed", centerLineDashedGlobal),
      centerLeftDashed: boolOr("centerLeftDashed", centerLeftDashedGlobal),
      centerRightDashed: boolOr("centerRightDashed", centerRightDashedGlobal),
    };
  }

  function centerStripeOffsetsFor(em) {
    if (!em.doubleCenterLine) return [{ off: 0, role: "center" }];
    const halfGap = em.centerLineGap * 0.5;
    const halfW = em.centerLineWidth * 0.5;
    const d = (halfGap + halfW) * width;
    const out = [];
    if (em.centerLeftEnabled) out.push({ off: -d, role: "centerLeft" });
    if (em.centerRightEnabled) out.push({ off: d, role: "centerRight" });
    return out;
  }

  const nodeById = new Map(
    nodes.map((n) => [
      n.id,
      {
        id: n.id,
        p: vec(n.x, n.z),
        forceJunction: !!n.forceJunction,
        roundabout: !!n.roundabout,
      },
    ]),
  );
  const adjacency = new Map(nodes.map((n) => [n.id, []]));
  const pieces = [];
  const markings = [];
  const hw = width * 0.5;
  const count = lanesPerDir * 2;
  const laneW = width / count;
  const minEdge = width * 0.75;

  // ── Per-edge curve data ────────────────────────────────────────────────────
  // bend ≠ 0 → quadratic Bézier a → b, control = chord midpoint + 2·bend·perp
  // (the curve passes exactly `bend` meters beside the chord midpoint).
  const edgeInfo = new Map();
  for (const edge of edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    if (!a || !b) continue;
    const chord = dist(a.p, b.p);
    if (chord < 1e-3) continue;
    const bend = Number(edge.bend) || 0;
    const curved = Math.abs(bend) > 0.05;
    if (!curved) {
      edgeInfo.set(edge, { curved: false, length: chord, dir: norm(sub(b.p, a.p)) });
      continue;
    }
    const chordDir = norm(sub(b.p, a.p));
    const ctrl = add(lerp(a.p, b.p, 0.5), mul(perpLeft(chordDir), 2 * bend));
    const table = quadraticArcTable(a.p, ctrl, b.p);
    edgeInfo.set(edge, {
      curved: true,
      P0: a.p,
      P1: ctrl,
      P2: b.p,
      table,
      length: table.total,
    });
  }

  for (const edge of edges) {
    const info = edgeInfo.get(edge);
    if (!info || info.length < minEdge) continue;
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    // Direction pointing away from each node into the edge (curve end tangent).
    const dirFromA = info.curved ? norm(sub(info.P1, info.P0)) : info.dir;
    const dirFromB = info.curved ? norm(sub(info.P1, info.P2)) : mul(info.dir, -1);
    adjacency.get(a.id).push({ edge, info, other: b, atA: true, dir: dirFromA, length: info.length });
    adjacency.get(b.id).push({ edge, info, other: a, atA: false, dir: dirFromB, length: info.length });
  }

  // ── Angle-aware clip distances ───────────────────────────────────────────
  // Two roads meeting at angle θ (between their node tangents) overlap until
  // ~hw / tan(θ/2) from the node; clip each road end past that overlap or the
  // junction polygon folds at sharp angles. Right-angle junctions keep the
  // original clips (the margin lives inside the tan).
  const edgeClips = new Map(); // edge → { [nodeId]: clip }
  for (const [nodeId, roads] of adjacency) {
    const degree = roads.length;
    const radiusCap = junctionRadius * (degree === 2 ? 1 : 0.62);
    const lengthScale = degree === 2 ? 0.32 : 0.24;
    const sorted = roads
      .map((road) => ({ road, angle: Math.atan2(road.dir.y, road.dir.x) }))
      .sort((a, b) => a.angle - b.angle);
    const nodeIsRoundabout = nodeById.get(nodeId)?.roundabout;
    for (let i = 0; i < sorted.length; i++) {
      const { road, angle } = sorted[i];
      let clip = 0;
      if (nodeIsRoundabout) {
        // Roads must reach the ring's outer edge plus a short connector lead.
        clip = Math.min(roundaboutRadius + hw * 1.9, road.length * 0.45);
        let perNode = edgeClips.get(road.edge);
        if (!perNode) {
          perNode = {};
          edgeClips.set(road.edge, perNode);
        }
        perNode[nodeId] = clip;
        continue;
      }
      if (degree > 1) {
        clip = Math.min(radiusCap, Math.max(hw * 1.15, road.length * lengthScale));
        let minGap = Math.PI * 2;
        for (let j = 0; j < sorted.length; j++) {
          if (j === i) continue;
          let gap = Math.abs(sorted[j].angle - angle);
          if (gap > Math.PI) gap = Math.PI * 2 - gap;
          if (gap < minGap) minGap = gap;
        }
        const halfGap = Math.max(0.06, minGap * 0.5);
        if (halfGap < Math.PI * 0.49) {
          const overlapNeed = (hw + width * 0.12) / Math.tan(halfGap);
          clip = Math.max(clip, Math.min(overlapNeed, junctionRadius * 3));
        }
      }
      clip = Math.min(clip, road.length * 0.45);
      let perNode = edgeClips.get(road.edge);
      if (!perNode) {
        perNode = {};
        edgeClips.set(road.edge, perNode);
      }
      perNode[nodeId] = clip;
    }
  }
  const clipAt = (edge, nodeId) => edgeClips.get(edge)?.[nodeId] ?? 0;

  /** Mouth point + outward tangent where `road` (adjacency entry) leaves node `nodeId`. */
  function mouthInfo(nodeId, road) {
    const clip = clipAt(road.edge, nodeId);
    const info = road.info;
    if (!info.curved) {
      const node = nodeById.get(nodeId);
      return { mouth: add(node.p, mul(road.dir, clip)), away: road.dir, clip };
    }
    const s = road.atA ? clip : info.length - clip;
    const t = tAtArcLength(info.table, s);
    const tan = norm(quadraticDeriv(info.P0, info.P1, info.P2, t));
    return {
      mouth: quadraticPoint(info.P0, info.P1, info.P2, t),
      away: road.atA ? tan : mul(tan, -1),
      clip,
    };
  }

  /** Span lane/center markings shared by straight and curved spans. pathAt(off) → polyline. */
  function emitSpanMarkings(edge, pathAt) {
    const em = edgeSpanMarkingParams(edge);
    for (let i = 1; i < count; i++) {
      if (i === lanesPerDir) {
        if (!em.centerLine) continue;
        for (const { off: cOff, role } of centerStripeOffsetsFor(em)) {
          let dashed;
          if (role === "center") dashed = em.centerLineDashed;
          else if (role === "centerLeft") dashed = em.centerLeftDashed;
          else dashed = em.centerRightDashed;
          markings.push({
            path: pathAt(cOff),
            type: role,
            dashed,
            dashScale: centerLineDashScale,
          });
        }
      } else {
        if (!em.laneLines) continue;
        markings.push({
          path: pathAt(-hw + i * laneW),
          type: "divider",
          dashed: true,
          dashScale: laneDashScale,
        });
      }
    }
  }

  /** Roundabout node: circulating ring + one connector flare per approach.
   *  Ring centerline radius = roundaboutRadius; ring width = road width. */
  function buildRoundaboutAt(node, roads) {
    const R = roundaboutRadius;
    const Ro = R + hw;
    const Ri = R - hw;
    const ringSegs = Math.max(48, Math.min(220, Math.ceil((Math.PI * 2 * R) / spanLongStep)));
    const tCols = profileColumns(scaledProfile, lateralCols);
    const ringProfileYs = tCols.map((tv) => sampleProfileY(scaledProfile, tv));

    const grid = [];
    const center = [];
    const outer = [];
    const inner = [];
    for (let i = 0; i <= ringSegs; i++) {
      const a = (i / ringSegs) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const row = [];
      for (let j = 0; j < tCols.length; j++) {
        const radius = R + hw * (1 - 2 * tCols[j]);
        row.push(vec(node.p.x + ca * radius, node.p.y + sa * radius));
      }
      grid.push(row);
      center.push(vec(node.p.x + ca * R, node.p.y + sa * R));
      outer.push(vec(node.p.x + ca * Ro, node.p.y + sa * Ro));
      inner.push(vec(node.p.x + ca * Ri, node.p.y + sa * Ri));
    }
    pieces.push({
      polygon: outer,
      left: { path: outer },
      right: { path: inner },
      center,
      grid,
      gridProfile: ringProfileYs,
      isJunctionCore: true,
      networkNode: node,
      mouths: [],
      padReach: Ro + hw * 1.6,
      islandRadius: Math.max(1, Ri - 0.5),
      suppressEdgeStripes: true,
      isRoundabout: true,
    });

    // Inner edge line: full circle around the island.
    const lineSegs = Math.max(48, ringSegs);
    const innerLine = [];
    for (let i = 0; i <= lineSegs; i++) {
      const a = (i / lineSegs) * Math.PI * 2;
      innerLine.push(vec(node.p.x + Math.cos(a) * (Ri + edgeLineInset), node.p.y + Math.sin(a) * (Ri + edgeLineInset)));
    }
    markings.push({ path: innerLine, type: "edge", dashed: false });

    // Connector flares + occupied angular intervals (for outer-line gaps).
    // Each connector bridges the road mouth to the ring with a WIDTH-PRESERVING
    // quad: cast each road-edge corner straight inward (-away) onto the ring
    // outer circle, so the connector stays road-width instead of pinching to the
    // narrow angular arc the corners subtend at the ring radius.
    const intervals = [];
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    /** First forward hit of ray (o + t·d) with circle radius Rc at node center. */
    function rayCircle(o, d, Rc) {
      const fx = o.x - node.p.x, fy = o.y - node.p.y;
      const fd = fx * d.x + fy * d.y;
      const disc = fd * fd - (fx * fx + fy * fy - Rc * Rc);
      if (disc < 0) return null;
      const t = -fd - Math.sqrt(disc); // NEAR crossing (the far root exits the ring)
      if (t < 0) return null;
      return vec(o.x + d.x * t, o.y + d.y * t);
    }
    for (const road of roads) {
      const m = mouthInfo(node.id, road);
      const side = perpLeft(m.away);
      const mouthL = add(m.mouth, mul(side, hw));
      const mouthR = add(m.mouth, mul(side, -hw));
      const inward = mul(m.away, -1);
      const ringL = rayCircle(mouthL, inward, Ro) ?? mouthL;
      const ringR = rayCircle(mouthR, inward, Ro) ?? mouthR;
      pieces.push({
        polygon: [mouthL, mouthR, ringR, ringL],
        left: { path: [mouthL, ringL] },
        right: { path: [mouthR, ringR] },
        center: [m.mouth, lerp(ringL, ringR, 0.5)],
        networkConnector: true,
      });
      // Angular interval the entry occupies on the ring (line-gap on either side).
      const thL = Math.atan2(ringL.y - node.p.y, ringL.x - node.p.x);
      const thR = Math.atan2(ringR.y - node.p.y, ringR.x - node.p.x);
      const thM = Math.atan2(m.mouth.y - node.p.y, m.mouth.x - node.p.x);
      const halfSpan = Math.max(Math.abs(wrap(thL - thM)), Math.abs(wrap(thR - thM))) + 0.04;
      intervals.push({ mid: thM, half: halfSpan });
    }

    // Outer edge line: arcs of the ring between the connectors.
    intervals.sort((a, b) => a.mid - b.mid);
    const rOut = Ro - edgeLineInset;
    for (let i = 0; i < intervals.length; i++) {
      const cur = intervals[i];
      const next = intervals[(i + 1) % intervals.length];
      const start = cur.mid + cur.half;
      let span = (i === intervals.length - 1 ? next.mid + Math.PI * 2 : next.mid) - next.half - start;
      if (intervals.length === 1) span = Math.PI * 2 - cur.half * 2;
      if (span <= 0.02) continue;
      const segsN = Math.max(4, Math.ceil(span / (Math.PI / 60)));
      const path = [];
      for (let s = 0; s <= segsN; s++) {
        const a = start + (span * s) / segsN;
        path.push(vec(node.p.x + Math.cos(a) * rOut, node.p.y + Math.sin(a) * rOut));
      }
      markings.push({ path, type: "edge", dashed: false });
    }
  }

  // ── Spans ──────────────────────────────────────────────────────────────────
  for (const edge of edges) {
    const info = edgeInfo.get(edge);
    if (!info || info.length < minEdge) continue;
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    const length = info.length;
    const ca = clipAt(edge, a.id);
    const cb = clipAt(edge, b.id);
    const spanLen = length - ca - cb;
    if (spanLen < 1) continue;

    if (info.curved) {
      // Clip by arc length, re-extract the clipped range as a true quadratic.
      const u = tAtArcLength(info.table, ca);
      const v = tAtArcLength(info.table, length - cb);
      if (v - u < 1e-3) continue;
      const { Q0, Q1, Q2 } = quadraticSub(info.P0, info.P1, info.P2, u, v);
      const segs = Math.max(8, Math.min(240, Math.ceil(spanLen / spanLongStep)));
      const piece = buildNetworkBend(Q0, Q1, Q2, width, segs, lateralCols, scaledProfile);
      piece.networkSpan = true;
      pieces.push(piece);
      emitSpanMarkings(edge, (off) => sampleQuadraticOffset(Q0, Q1, Q2, off, segs));
      continue;
    }

    const dir = info.dir;
    const side = perpLeft(dir);
    const start = add(a.p, mul(dir, ca));
    const end = add(b.p, mul(dir, -cb));
    const longRows = Math.max(1, Math.ceil(spanLen / spanLongStep));
    const tCols = profileColumns(scaledProfile, lateralCols);
    const spanProfileYs = tCols.map(tv => sampleProfileY(scaledProfile, tv));
    const grid = [];
    for (let ri = 0; ri <= longRows; ri++) {
      const t = ri / longRows;
      const c = lerp(start, end, t);
      const row = [];
      for (let ci = 0; ci < tCols.length; ci++) {
        const lateral = hw * (1 - 2 * tCols[ci]);
        row.push(add(c, mul(side, lateral)));
      }
      grid.push(row);
    }
    const leftPath = grid.map(row => row[0]);
    const rightPath = grid.map(row => row[tCols.length - 1]);
    pieces.push({
      polygon: [add(start, mul(side, hw)), add(end, mul(side, hw)), add(end, mul(side, -hw)), add(start, mul(side, -hw))],
      left: { path: leftPath, debug: [] },
      right: { path: rightPath, debug: [] },
      center: [start, end],
      grid,
      gridProfile: spanProfileYs,
      networkSpan: true,
    });
    emitSpanMarkings(edge, (off) => {
      const mPath = [];
      for (let mi = 0; mi <= longRows; mi++) {
        mPath.push(add(lerp(start, end, mi / longRows), mul(side, off)));
      }
      return mPath;
    });
  }

  // ── Nodes: caps, smooth bends, junction cores ──────────────────────────────
  for (const node of nodeById.values()) {
    const roads = adjacency.get(node.id);
    if (!roads || roads.length === 0) continue;

    if (node.roundabout) {
      buildRoundaboutAt(node, roads);
      continue;
    }

    if (roads.length === 1) {
      const road = roads[0];
      const side = perpLeft(road.dir);
      let pts;
      if (endCapStyle === "flat") {
        const L = add(node.p, mul(side, -hw));
        const R = add(node.p, mul(side, hw));
        const back = mul(road.dir, -hw * 0.2);
        pts = [L, R, add(R, back), add(L, back)];
      } else {
        pts = [];
        const back = mul(road.dir, -1);
        const base = Math.atan2(back.y, back.x);
        const a0 = base - Math.PI * 0.5;
        const a1 = base + Math.PI * 0.5;
        const segmentCount = Math.max(6, junctionSegments | 0);
        for (let i = 0; i <= segmentCount; i++) {
          const ang = angleLerp(a0, a1, i / segmentCount);
          pts.push(add(node.p, vec(Math.cos(ang) * hw, Math.sin(ang) * hw)));
        }
      }
      pieces.push({
        polygon: pts,
        left: { path: [] },
        right: { path: [] },
        center: [],
        isJunctionCore: true,
        networkNode: node,
        mouths: [],
      });
      continue;
    }

    if (roads.length === 2 && twoRoadNodes === "smooth" && !node.forceJunction) {
      const mA = mouthInfo(node.id, roads[0]);
      const mB = mouthInfo(node.id, roads[1]);
      // Bend control = intersection of the mouth tangents pointing INTO the node
      // (continues each span's direction → tangent-continuous with curved spans).
      // Straight edges intersect exactly at node.p — identical to the original.
      // Near straight-through nodes the rays are near-antiparallel and the
      // intersection is numerically wild; node.p is always a safe control.
      let control = node.p;
      const dA = mul(mA.away, -1);
      const dB = mul(mB.away, -1);
      const mouthDist = dist(mA.mouth, mB.mouth);
      if (dA.x * dB.x + dA.y * dB.y > -0.85) {
        const hit = lineIntersection(mA.mouth, dA, mB.mouth, dB);
        const reachCap = Math.max(mouthDist * 1.4, hw * 2.2);
        if (
          hit && hit.t > 0 && hit.u > 0 &&
          dist(hit.p, mA.mouth) < reachCap && dist(hit.p, mB.mouth) < reachCap
        ) {
          control = hit.p;
        }
      }
      pieces.push(buildNetworkBend(mA.mouth, control, mB.mouth, width, curveSegments, lateralCols, scaledProfile));

      const bendSamples = Math.max(4, curveSegments | 0);
      for (let i = 1; i < count; i++) {
        if (i === lanesPerDir) {
          if (!centerLine) continue;
          if (!doubleCenterLine) {
            markings.push({
              path: sampleQuadraticOffset(mA.mouth, control, mB.mouth, 0, bendSamples),
              type: "center",
            });
          } else {
            const halfGap = centerLineGap * 0.5;
            const halfW = centerLineWidth * 0.5;
            const d = (halfGap + halfW) * width;
            if (centerLeftEnabled) {
              markings.push({
                path: sampleQuadraticOffset(mA.mouth, control, mB.mouth, -d, bendSamples),
                type: "centerLeft",
              });
            }
            if (centerRightEnabled) {
              markings.push({
                path: sampleQuadraticOffset(mA.mouth, control, mB.mouth, d, bendSamples),
                type: "centerRight",
              });
            }
          }
        } else {
          if (!laneLines) continue;
          const off = -hw + i * laneW;
          markings.push({
            path: sampleQuadraticOffset(mA.mouth, control, mB.mouth, off, bendSamples),
            type: "divider",
          });
        }
      }
      continue;
    }

    const roadEnds = roads.map((road) => {
      const m = mouthInfo(node.id, road);
      const toMouth = sub(m.mouth, node.p);
      return {
        mouth: m.mouth,
        away: m.away,
        clip: m.clip,
        sortDir: len(toMouth) > 1e-6 ? norm(toMouth) : road.dir,
      };
    });
    const boundary = junctionBoundary(node, roadEnds, hw, junctionRadius, junctionSegments);
    pieces.push({
      polygon: boundary.polygon,
      left: { path: [] },
      right: { path: [] },
      center: [],
      isJunctionCore: true,
      networkNode: node,
      mouths: roadEnds.map((re) => ({ c: re.mouth })),
      outlineSegments: boundary.outlineSegments,
    });
  }

  return { ok: true, pieces, markings, nodes };
}
