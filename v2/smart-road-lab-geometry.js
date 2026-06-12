/**
 * Smart Road lab geometry — SUCCESSOR COPY of `core/road/roadNetworkLabGeometry.js`.
 * The original stays untouched until Smart Road is proven and swapped in one move;
 * all geometry evolution happens here. Lab pages import THIS file.
 *
 * Changes over the original:
 *  - ANGLE-AWARE CLIP DISTANCES: roads meeting at acute angles overlap each other
 *    until hw / tan(gap/2) from the node; the original clipped by degree+length
 *    only, so sharp Y junctions folded through themselves (black slivers, hooked
 *    edge lines). Each road end is now clipped past its overlap with its angular
 *    neighbors, giving sharp junctions a longer asphalt wedge like real roads.
 *  - junction corner intersections are only accepted IN FRONT of both edge rays.
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
function dot(a, b) {
  return a.x * b.x + a.y * b.y;
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
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
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

function junctionBoundary(node, roads, clipFor, hw, junctionRadius, junctionSegments) {
  const entries = roads
    .map((road) => {
      const clip = clipFor(road);
      const mouth = add(node.p, mul(road.dir, clip));
      const side = perpLeft(road.dir);
      return {
        angle: Math.atan2(road.dir.y, road.dir.x),
        dir: road.dir,
        clip,
        left: add(mouth, mul(side, hw)),
        right: add(mouth, mul(side, -hw)),
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
 * @param nodes { id, x, z, forceJunction? }[]
 * @param edges { a, b, style? }[] — optional `style` overrides markings on **straight network spans** only (not smooth bends / junction cores).
 * @param params { width, lanesPerDir, junctionRadius, curveSegments, junctionSegments, twoRoadNodes, endCapStyle,
 *   centerLine?, laneLines?, doubleCenterLine?, centerLineGap?, centerLineWidth?, centerLeftEnabled?, centerRightEnabled?,
 *   centerLineDashed?, centerLeftDashed?, centerRightDashed?, centerLineDashScale?, laneDashScale? }
 */
export function buildLabNetworkGeometry(nodes, edges, params) {
  const width = params.width;
  const lanesPerDir = params.lanesPerDir ?? 1;
  const junctionRadius = params.junctionRadius ?? 12;
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

  /** Physical lateral offsets along `side` from road spine (matches Full Road normalized gap/width). */
  function centerStripeOffsets() {
    if (!doubleCenterLine) return [{ off: 0, role: "center" }];
    const halfGap = centerLineGap * 0.5;
    const halfW = centerLineWidth * 0.5;
    const d = (halfGap + halfW) * width;
    const out = [];
    if (centerLeftEnabled) out.push({ off: -d, role: "centerLeft" });
    if (centerRightEnabled) out.push({ off: d, role: "centerRight" });
    return out;
  }

  /** Per-edge effective marking flags for straight `networkSpan` pieces (merged with global `params`). */
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

  for (const edge of edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    if (!a || !b || dist(a.p, b.p) < minEdge) continue;
    adjacency.get(a.id).push({ edge, other: b, dir: norm(sub(b.p, a.p)), length: dist(a.p, b.p) });
    adjacency.get(b.id).push({ edge, other: a, dir: norm(sub(a.p, b.p)), length: dist(a.p, b.p) });
  }

  // ── Angle-aware clip distances ───────────────────────────────────────────
  // Two roads meeting at angle θ overlap each other until hw / tan(θ/2) from
  // the node. Each road end is clipped at least past its overlap with its
  // closest angular neighbor (plus a margin), or the junction polygon folds
  // through itself at sharp Y junctions. Base behavior matches the original.
  const edgeClips = new Map(); // edge → { [nodeId]: clip }
  for (const [nodeId, roads] of adjacency) {
    const degree = roads.length;
    const radiusCap = junctionRadius * (degree === 2 ? 1 : 0.62);
    const lengthScale = degree === 2 ? 0.32 : 0.24;
    const sorted = roads
      .map((road) => ({ road, angle: Math.atan2(road.dir.y, road.dir.x) }))
      .sort((a, b) => a.angle - b.angle);
    for (let i = 0; i < sorted.length; i++) {
      const { road, angle } = sorted[i];
      let clip = 0;
      if (degree > 1) {
        clip = Math.min(radiusCap, Math.max(hw * 1.15, road.length * lengthScale));
        // Smallest angular gap to a neighboring road at this node.
        let minGap = Math.PI * 2;
        for (let j = 0; j < sorted.length; j++) {
          if (j === i) continue;
          let gap = Math.abs(sorted[j].angle - angle);
          if (gap > Math.PI) gap = Math.PI * 2 - gap;
          if (gap < minGap) minGap = gap;
        }
        const halfGap = Math.max(0.06, minGap * 0.5);
        if (halfGap < Math.PI * 0.49) {
          // Margin inside the tan: ~0 extra at right angles (normal junctions
          // keep their original shape), grows naturally as the angle sharpens.
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

  for (const edge of edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    if (!a || !b) continue;
    const length = dist(a.p, b.p);
    if (length < minEdge) continue;
    const dir = norm(sub(b.p, a.p));
    const side = perpLeft(dir);
    const ca = clipAt(edge, a.id);
    const cb = clipAt(edge, b.id);
    const start = add(a.p, mul(dir, ca));
    const end = add(b.p, mul(dir, -cb));
    const spanLen = dist(start, end);
    if (spanLen < 1) continue;
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

    const em = edgeSpanMarkingParams(edge);
    for (let i = 1; i < count; i++) {
      if (i === lanesPerDir) {
        if (!em.centerLine) continue;
        for (const { off: cOff, role } of centerStripeOffsetsFor(em)) {
          let dashed;
          if (role === "center") dashed = em.centerLineDashed;
          else if (role === "centerLeft") dashed = em.centerLeftDashed;
          else dashed = em.centerRightDashed;
          const mPath = [];
          for (let mi = 0; mi <= longRows; mi++) {
            mPath.push(add(lerp(start, end, mi / longRows), mul(side, cOff)));
          }
          markings.push({
            path: mPath,
            type: role,
            dashed,
            dashScale: centerLineDashScale,
          });
        }
      } else {
        if (!em.laneLines) continue;
        const off = -hw + i * laneW;
        const mPath = [];
        for (let mi = 0; mi <= longRows; mi++) {
          mPath.push(add(lerp(start, end, mi / longRows), mul(side, off)));
        }
        markings.push({
          path: mPath,
          type: "divider",
          dashed: true,
          dashScale: laneDashScale,
        });
      }
    }
  }

  for (const node of nodeById.values()) {
    const roads = adjacency.get(node.id);
    if (!roads || roads.length === 0) continue;

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
      const first = roads[0];
      const second = roads[1];
      const clipA = clipAt(first.edge, node.id);
      const clipB = clipAt(second.edge, node.id);
      const mouthA = add(node.p, mul(first.dir, clipA));
      const mouthB = add(node.p, mul(second.dir, clipB));
      pieces.push(buildNetworkBend(mouthA, node.p, mouthB, width, curveSegments, lateralCols, scaledProfile));

      const bendSamples = Math.max(4, curveSegments | 0);
      for (let i = 1; i < count; i++) {
        if (i === lanesPerDir) {
          if (!centerLine) continue;
          for (const { off: cOff, role } of centerStripeOffsets()) {
            markings.push({
              path: sampleQuadraticOffset(mouthA, node.p, mouthB, cOff, bendSamples),
              type: role,
            });
          }
        } else {
          if (!laneLines) continue;
          const off = -hw + i * laneW;
          markings.push({
            path: sampleQuadraticOffset(mouthA, node.p, mouthB, off, bendSamples),
            type: "divider",
          });
        }
      }
      continue;
    }

    const boundary = junctionBoundary(node, roads, (road) => clipAt(road.edge, node.id), hw, junctionRadius, junctionSegments);
    pieces.push({
      polygon: boundary.polygon,
      left: { path: [] },
      right: { path: [] },
      center: [],
      isJunctionCore: true,
      networkNode: node,
      mouths: roads.map((road) => ({
        c: add(node.p, mul(road.dir, clipAt(road.edge, node.id))),
      })),
      outlineSegments: boundary.outlineSegments,
    });
  }

  return { ok: true, pieces, markings, nodes };
}
