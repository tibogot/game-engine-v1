// Lane-based road network: data in, everything a renderer, a traffic sim or a
// city generator needs out.
//
// DATA (what gets saved — small, all derived geometry is rebuilt):
//   { version, style: 'eu'|'us', roadScale?: 1 (see roadCrossSection.js scaledWidth),
//     nodes: [{ id, x, z, y?, kind?: 'auto'|'junction'|'roundabout'|'split',
//               radius?, corners?: { 'r1|r2': radius }, control?, crosswalks?,
//               ring?: { radius, lanes }, trunk? }],
//     roads: [{ id, a, b, type, pts: [{ x, z, r?, ls? }], lanes?, sections?,
//               profile?: { mode, vpis }, radius? }] }
//
// PIPELINE (buildRoadNetwork):
//   1 arms          every road end becomes an arm of its node
//   2 node kinds    end / continuation / junction / roundabout / split
//   3 node frames   smooth headings for continuations, branch offsets for splits
//   4 node geometry trims, curb returns, pads, corner sidewalks, islands
//   5 control       signal / stop / yield per arm, stop lines + crosswalks
//   6 alignments    PI fit per road with the node constraints and straight leads
//   7 profiles      elevation per road
//   8 road geometry lane strips, edges, markings, bridges
//   9 lane graph    lane pieces (split at section events) + node connectors
//  10 checks        crossings (grade separation), overlaps, tight bends
//  11 structures, props, blocks + lots, locate index
//
// See roadMath.js for the axis and sign conventions.

import { wrap2Pi, wrapPi, polylineLength, segIntersect, pointSegDist2, SegmentGrid, cumulative, clamp } from "./roadMath.js";
import { fitAlignment, alignmentVertices, evalAlignment, sampleAlignment } from "./roadAlignment.js";
import {
  ROAD_TYPES, LANE_TYPES, resolveStack, layoutAt, layoutEdges, sectionBreaks, sectionEventStations, laneWidthAt,
} from "./roadCrossSection.js";
import { buildProfile, profileAt, curveDesign, defaultSpiral } from "./roadProfile.js";
import {
  buildJunctionGeometry, buildRoundaboutGeometry, planSplit, buildGore, buildEndGeometry, resolveControl,
  armMouthMarkings, arrowMarkings, junctionConnectors, roundaboutConnectors, lateralLinks, uturnConnectors, armPoint,
} from "./roadJunction.js";
import { buildRoadMarkings } from "./roadMarkings.js";
import { buildBlocks } from "./roadBlocks.js";
import { buildProps } from "./roadProps.js";

export const CLEARANCE = 5.0;
export const DECK = 1.2;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function setFrame(arm, th, ox, oz) {
  arm.th = th;
  arm.dx = Math.cos(th); arm.dz = Math.sin(th);
  arm.nx = Math.sin(th); arm.nz = -Math.cos(th);
  if (ox != null) { arm.ox = ox; arm.oz = oz; }
}

function makeArm(node, rr, end, rawTh, L) {
  const lay = layoutAt(rr.stack, end === "a" ? 0 : L, L);
  const flip = end === "b";
  const conv = (l) => ({
    laneId: l.id, type: l.type, turn: l.turn, w: l.w,
    tIn: flip ? -l.tIn : l.tIn, tOut: flip ? -l.tOut : l.tOut,
    drive: !!LANE_TYPES[l.type]?.drive,
  });
  const lanesL = (flip ? lay.right : lay.left).map(conv);
  const lanesR = (flip ? lay.left : lay.right).map(conv);
  const edges = layoutEdges({ cw: lay.cw, left: lanesL, right: lanesR });
  const withT = (l) => ({ ...l, t: (l.tIn + l.tOut) / 2 });
  const approach = lanesL.filter((l) => l.drive && l.w > 0.5).map(withT).sort((p, q) => p.t - q.t);
  const depart = lanesR.filter((l) => l.drive && l.w > 0.5).map(withT).sort((p, q) => q.t - p.t);
  const arm = {
    node, road: rr, end, type: rr.type, rawTh, rawDx: Math.cos(rawTh), rawDz: Math.sin(rawTh),
    lanesL, lanesR, edges, approach, depart, cw: lay.cw, centerKind: rr.stack.center.kind,
    trim: 0, ox: node.x, oz: node.z, offset: 0, constraintTh: null, markStart: 0, control: "none",
  };
  setFrame(arm, rawTh);
  return arm;
}

function autoSplit(arms) {
  if (arms.length !== 3 || !arms.every((a) => a.type.oneWay)) return false;
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      if (Math.abs(wrapPi(arms[i].rawTh - arms[j].rawTh)) < 0.6) return true;
    }
  }
  return false;
}

export function buildRoadNetwork(data, opts = {}) {
  const T0 = now();
  const timings = {};
  let tMark = T0;
  const lap = (name) => { const t = now(); timings[name] = t - tMark; tMark = t; };

  const ground = opts.ground || (() => 0);
  const types = opts.types || ROAD_TYPES;
  const style = data.style || "eu";
  // How much wider than real the drivable road is (1 = real). opts wins over data.
  const roadScale = Math.min(3, Math.max(0.5, opts.roadScale ?? data.roadScale ?? 1));
  const issues = [];

  /* 1 ─ nodes, roads, arms */
  const nodes = new Map();
  for (const src of data.nodes || []) {
    nodes.set(src.id, {
      id: src.id, src, x: src.x, z: src.z, y: src.y ?? ground(src.x, src.z), roadScale,
      arms: [], issues: [], markings: [], kind: null, corners: [], sidewalks: [], islands: [], pad: null,
    });
  }
  const roads = [];
  for (const src of data.roads || []) {
    const A = nodes.get(src.a), B = nodes.get(src.b);
    if (!A || !B) {
      issues.push({ level: "error", code: "dangling", msg: `Road ${src.id} points at a missing node`, roadId: src.id });
      continue;
    }
    const type = types[src.type] || types.local;
    const pts = (src.pts || []).map((p) => ({ x: p.x, z: p.z, r: p.r, ls: p.ls }));
    const chord = polylineLength([[A.x, A.z], ...pts.map((p) => [p.x, p.z]), [B.x, B.z]]);
    if (chord < 2) {
      issues.push({ level: "warn", code: "tiny-road", msg: "Road shorter than 2 m ignored", x: A.x, z: A.z, roadId: src.id });
      continue;
    }
    roads.push({ id: src.id, src, type, stack: resolveStack(src, types, roadScale), A, B, pts, Lapprox: chord, issues: [] });
  }
  const roadsById = new Map(roads.map((r) => [r.id, r]));
  for (const rr of roads) {
    const nxA = rr.pts[0] || rr.B, nxB = rr.pts[rr.pts.length - 1] || rr.A;
    rr.armA = makeArm(rr.A, rr, "a", Math.atan2(nxA.z - rr.A.z, nxA.x - rr.A.x), rr.Lapprox);
    rr.armB = makeArm(rr.B, rr, "b", Math.atan2(nxB.z - rr.B.z, nxB.x - rr.B.x), rr.Lapprox);
    rr.A.arms.push(rr.armA);
    rr.B.arms.push(rr.armB);
  }
  lap("arms");

  /* 2–5 ─ node kinds, frames, geometry, control, mouth markings */
  for (const node of nodes.values()) {
    const arms = node.arms;
    arms.sort((p, q) => wrap2Pi(p.rawTh) - wrap2Pi(q.rawTh));
    const deg = arms.length;
    const want = node.src.kind || "auto";
    if (deg === 0) node.kind = "isolated";
    else if (want === "roundabout") node.kind = "roundabout";
    else if (want === "split") {
      if (deg === 3) node.kind = "split";
      else {
        node.kind = deg === 1 ? "end" : "junction";
        node.issues.push({ level: "warn", code: "split-degree", msg: "A split/merge needs exactly three roads", x: node.x, z: node.z, nodeId: node.id });
      }
    } else if (deg === 1) node.kind = "end";
    else if (deg === 2) {
      const dev = Math.abs(wrapPi(arms[1].rawTh - arms[0].rawTh - Math.PI));
      node.kind = want === "junction" || dev > 1.05 ? "junction" : "continuation";
    } else if (want === "auto" && autoSplit(arms)) node.kind = "split";
    else node.kind = "junction";

    if (node.kind === "continuation") {
      const h = arms[0].rawTh + wrapPi(arms[1].rawTh + Math.PI - arms[0].rawTh) / 2;
      setFrame(arms[0], h); arms[0].constraintTh = h;
      setFrame(arms[1], h + Math.PI); arms[1].constraintTh = h + Math.PI;
    } else if (node.kind === "split") {
      planSplit(node, arms);
      for (const b of [node.split.right, node.split.left]) {
        setFrame(b, b.constraintTh, b.constraintPt[0], b.constraintPt[1]);
      }
    }
  }

  // An end constraint turns the road's FAR end too (its virtual PI changes the
  // last leg), so every unconstrained arm takes its heading from the vertex
  // polyline the fit will really use — not from the authored points.
  for (const rr of roads) {
    const V = alignmentVertices([{ x: rr.armA.ox, z: rr.armA.oz }, ...rr.pts, { x: rr.armB.ox, z: rr.armB.oz }], {
      startDir: rr.armA.constraintTh,
      endDir: rr.armB.constraintTh != null ? rr.armB.constraintTh + Math.PI : null,
    });
    const n = V.length;
    if (rr.armA.constraintTh == null && n >= 2) setFrame(rr.armA, Math.atan2(V[1].z - V[0].z, V[1].x - V[0].x));
    if (rr.armB.constraintTh == null && n >= 2) setFrame(rr.armB, Math.atan2(V[n - 2].z - V[n - 1].z, V[n - 2].x - V[n - 1].x));
  }

  for (const node of nodes.values()) {
    const arms = node.arms;
    const deg = arms.length;
    if (node.kind === "junction" || node.kind === "roundabout") arms.sort((p, q) => wrap2Pi(p.th) - wrap2Pi(q.th));
    if (node.kind === "continuation") buildJunctionGeometry(node, arms, { straightOnly: true });
    else if (node.kind === "split") {
      buildJunctionGeometry(node, arms, { straightOnly: true });
      node.pad = null;
      node.sidewalks = [];
    } else if (node.kind === "junction") buildJunctionGeometry(node, arms);
    else if (node.kind === "roundabout") buildRoundaboutGeometry(node, arms);
    else if (node.kind === "end") buildEndGeometry(node, arms[0]);

    node.control = resolveControl(node, arms, style);
    const walkable = (node.kind === "junction" && deg >= 3) || node.kind === "roundabout";
    for (const a of arms) {
      a.crosswalk = walkable && !!a.type.crosswalks && node.src.crosswalks !== false;
      a.markStart = node.kind === "junction" || node.kind === "roundabout" ? armMouthMarkings(node, a, style) : a.trim;
    }
  }
  lap("nodes");

  /* 6–8 ─ alignments, profiles, road geometry */
  for (const rr of roads) {
    const { armA: aA, armB: aB, type } = rr;
    const lead = (arm) => (arm.node.kind === "junction" || arm.node.kind === "roundabout" ? arm.trim + 5 : arm.node.kind === "split" ? 12 : 0);
    const al = fitAlignment([{ x: aA.ox, z: aA.oz }, ...rr.pts, { x: aB.ox, z: aB.oz }], {
      startDir: aA.constraintTh,
      endDir: aB.constraintTh != null ? aB.constraintTh + Math.PI : null,
      defaultRadius: rr.src.radius ?? type.radius,
      spiralFor: type.spirals ? (R) => defaultSpiral(type.speed, R) : null,
      leadStart: lead(aA), leadEnd: lead(aB),
    });
    rr.al = al;
    const L = al.length;
    rr.L = L;
    for (const iss of al.issues) rr.issues.push({ ...iss, roadId: rr.id });

    let sa = aA.trim, sb = aB.trim;
    if (sa + sb > L - 1) {
      const f = Math.max(0, L - 1) / Math.max(1e-6, sa + sb);
      rr.issues.push({ level: "error", code: "road-swallowed", msg: "Road is shorter than the junctions at its ends", x: (aA.ox + aB.ox) / 2, z: (aA.oz + aB.oz) / 2, roadId: rr.id });
      sa *= f; sb *= f;
    }
    rr.s0 = sa; rr.s1 = L - sb;

    const groundAt = (s) => { const e = evalAlignment(al, s); return ground(e.x, e.z); };
    rr.prof = buildProfile(rr.src, L, { ya: rr.A.y, yb: rr.B.y }, groundAt, type.maxGrade);
    for (const iss of rr.prof.issues) {
      const e = evalAlignment(al, iss.s);
      rr.issues.push({ ...iss, x: e.x, z: e.z, roadId: rr.id });
    }

    buildRoadGeometry(rr, style);
    // Design radius check (per PI).
    const urban = type.rank <= 4 && !type.spirals;
    const cd = curveDesign(type.speed, 1, urban);
    rr.minRadius = Infinity;
    for (const v of al.vertices) {
      if (v.virtual) continue;
      rr.minRadius = Math.min(rr.minRadius, v.R);
      // Slow urban streets are not designed to a superelevation minimum.
      if (type.speed >= 50 && v.R < cd.Rmin * 0.98) {
        rr.issues.push({
          level: urban ? "info" : "warn", code: "design-radius",
          msg: `Radius ${v.R.toFixed(0)} m is under the ${cd.Rmin.toFixed(0)} m minimum for ${type.speed} km/h`,
          x: v.x, z: v.z, roadId: rr.id,
        });
      }
    }
  }
  lap("roads");

  for (const node of nodes.values()) if (node.kind === "split") buildGore(node, roadsById);

  /* 9 ─ lane graph */
  const graph = { paths: [], byId: new Map() };
  const addPath = (p) => {
    p.id = p.id || `p${graph.paths.length}`;
    p.cum = cumulative(p.pts);
    p.len = p.cum[p.cum.length - 1];
    p.next = []; p.prev = [];
    graph.paths.push(p);
    graph.byId.set(p.id, p);
    return p;
  };
  const link = (a, b) => {
    if (!a || !b || a === b) return;
    if (!a.next.includes(b.id)) a.next.push(b.id);
    if (!b.prev.includes(a.id)) b.prev.push(a.id);
  };
  for (const rr of roads) buildRoadLanes(rr, addPath, link);

  for (const node of nodes.values()) {
    const arms = node.arms;
    let cons = [];
    if (node.kind === "junction") cons = junctionConnectors(node, arms);
    else if (node.kind === "roundabout") cons = roundaboutConnectors(node, arms);
    else if (node.kind === "continuation") cons = lateralLinks(node, [{ from: arms[0], to: arms[1] }, { from: arms[1], to: arms[0] }]);
    else if (node.kind === "split") {
      const sp = node.split;
      const pairs = [];
      for (const b of [sp.right, sp.left]) {
        pairs.push({ from: sp.trunk, to: b, oFrom: 0, oTo: b.offset });
        pairs.push({ from: b, to: sp.trunk, oFrom: b.offset, oTo: 0 });
      }
      cons = lateralLinks(node, pairs);
    } else if (node.kind === "end") cons = uturnConnectors(node, arms[0]);
    node.connectors = [];
    const moves = new Map();
    for (const c of cons) {
      const inP = graph.byId.get(c.from.arm.road.laneEnds?.[c.from.arm.end]?.in[c.from.lane.laneId]);
      const outP = graph.byId.get(c.to.arm.road.laneEnds?.[c.to.arm.end]?.out[c.to.lane.laneId]);
      if (!inP || !outP) continue;
      if (!c.pts) { link(inP, outP); continue; }
      const cp = addPath({
        kind: "connector", nodeId: node.id, turn: c.turn, pts: c.pts,
        speed: c.turn === "straight" ? Math.min(inP.speed, outP.speed) : c.turn === "ring" ? 8 : 6.5,
      });
      link(inP, cp); link(cp, outP);
      node.connectors.push(cp);
      const a = c.from.arm;
      if (a.stopStation != null && a.control !== "none") {
        inP.stop = { nodeId: node.id, arm: a, control: a.control, at: Math.max(0, inP.len - (a.stopStation - a.trim) - 0.6) };
      }
      const key = `${a.road.id}|${a.end}|${c.from.lane.laneId}`;
      if (!moves.has(key)) moves.set(key, { arm: a, lane: c.from.lane, kinds: new Set() });
      if (c.turn === "left" || c.turn === "right" || c.turn === "straight") moves.get(key).kinds.add(c.turn);
    }
    // A one-way road ending at a dead end leaves the map: an exit, not a bug.
    if (node.kind === "end") {
      const a = arms[0];
      for (const lane of a.approach) {
        const p = graph.byId.get(a.road.laneEnds?.[a.end]?.in[lane.laneId]);
        if (p && !p.next.length) p.exit = true;
      }
    }
    // Arrows: multi-lane approaches and dedicated turn lanes.
    if (node.kind === "junction") {
      for (const m of moves.values()) {
        if (!m.kinds.size) continue;
        if (m.arm.approach.length < 2 && !m.lane.turn) continue;
        const rr = m.arm.road;
        const dist = (m.arm.stopStation ?? m.arm.trim) + 4;
        const s = m.arm.end === "a" ? dist : rr.L - dist;
        if (s < rr.s0 || s > rr.s1) continue;
        const e = evalAlignment(rr.al, s);
        const lay = layoutAt(rr.stack, s, rr.L);
        const lane = [...lay.left, ...lay.right].find((l) => l.id === m.lane.laneId);
        if (!lane || lane.w < 2) continue;
        const t = (lane.tIn + lane.tOut) / 2;
        const x = e.x + Math.sin(e.th) * t, z = e.z - Math.cos(e.th) * t;
        const heading = m.arm.end === "a" ? e.th + Math.PI : e.th;
        node.markings.push(...arrowMarkings(x, z, heading, m.kinds, "white", lane.w));
      }
    }
  }
  lap("laneGraph");

  /* 10 ─ crossings, overlaps */
  const structures = [];
  const grid = new SegmentGrid(32);
  const foot = new SegmentGrid(32);
  for (const rr of roads) {
    const S = rr.smp, F = rr.footMid;
    for (let i = 1; i < S.s.length; i++) {
      grid.add(S.x[i - 1], S.z[i - 1], S.x[i], S.z[i], { rr, i });
      foot.add(F[i - 1][0], F[i - 1][1], F[i][0], F[i][1], { rr, i });
    }
  }
  const sharedNear = (ra, rb, x, z, pad) => {
    for (const na of [ra.A, ra.B]) {
      if (na !== rb.A && na !== rb.B) continue;
      let reach = pad;
      for (const a of na.arms) reach = Math.max(reach, a.trim + pad);
      if (na.kind === "split") reach = Math.max(reach, 140);
      if (Math.hypot(x - na.x, z - na.z) < reach) return true;
    }
    return false;
  };
  const crossings = [];
  for (const rr of roads) {
    const S = rr.smp;
    for (let i = 1; i < S.s.length; i++) {
      const mx = (S.x[i - 1] + S.x[i]) / 2, mz = (S.z[i - 1] + S.z[i]) / 2;
      const hl = Math.hypot(S.x[i] - S.x[i - 1], S.z[i] - S.z[i - 1]) / 2;
      for (const it of grid.query(mx, mz, hl + 1)) {
        const other = it.data.rr;
        if (other.id <= rr.id) continue;
        const hit = segIntersect(S.x[i - 1], S.z[i - 1], S.x[i], S.z[i], it.ax, it.az, it.bx, it.bz);
        if (!hit) continue;
        if (sharedNear(rr, other, hit.x, hit.z, 4)) continue;
        if (crossings.some((c) => c.a === rr && c.b === other && Math.hypot(c.x - hit.x, c.z - hit.z) < 3)) continue;
        const sA = S.s[i - 1] + (S.s[i] - S.s[i - 1]) * hit.t;
        const OS = other.smp, j = it.data.i;
        const sB = OS.s[j - 1] + (OS.s[j] - OS.s[j - 1]) * hit.u;
        const yA = profileAt(rr.prof, sA).y, yB = profileAt(other.prof, sB).y;
        crossings.push({ a: rr, b: other, x: hit.x, z: hit.z, sA, sB, yA, yB });
      }
    }
  }
  for (const c of crossings) {
    const dy = Math.abs(c.yA - c.yB);
    const upper = c.yA > c.yB ? c.a : c.b, lower = upper === c.a ? c.b : c.a;
    if (dy >= CLEARANCE + DECK) {
      structures.push({ kind: "overpass", x: c.x, z: c.z, upper: upper.id, lower: lower.id, dy });
    } else if (dy >= 1.0) {
      issues.push({
        level: "error", code: "clearance",
        msg: `Only ${dy.toFixed(1)} m between crossing roads — an overpass needs ${(CLEARANCE + DECK).toFixed(1)} m`,
        x: c.x, z: c.z, roadId: upper.id,
      });
    } else {
      issues.push({
        level: "error", code: "crossing", msg: "Roads cross without a junction",
        x: c.x, z: c.z, roadId: c.a.id,
        fix: { action: "insertJunction", a: c.a.id, b: c.b.id, x: c.x, z: c.z, label: "Make junction" },
      });
    }
  }
  // opts.fast (live drags): skip overlaps, props, blocks — the full build runs on release.
  if (!opts.fast) {
    const reported = new Set();
    for (const rr of roads) {
      const S = rr.smp, F = rr.footMid;
      for (let i = 0; i < S.s.length; i += 2) {
        const hwA = rr.halfW[i];
        let worst = null;
        for (const it of foot.query(F[i][0], F[i][1], hwA + 30)) {
          const other = it.data.rr;
          if (other === rr) continue;
          const key = rr.id < other.id ? `${rr.id}|${other.id}` : `${other.id}|${rr.id}`;
          if (reported.has(key)) continue;
          const { d2, t } = pointSegDist2(F[i][0], F[i][1], it.ax, it.az, it.bx, it.bz);
          const j = it.data.i;
          const hwB = other.halfW[j - 1] + (other.halfW[j] - other.halfW[j - 1]) * t;
          const need = hwA + hwB - 0.6;
          if (d2 >= need * need) continue;
          if (sharedNear(rr, other, S.x[i], S.z[i], hwA + hwB + 6)) continue;
          if (crossings.some((c) => (c.a === rr || c.b === rr) && (c.a === other || c.b === other) && Math.hypot(c.x - S.x[i], c.z - S.z[i]) < need * 2.2 + 6)) continue;
          const OS = other.smp;
          const sB = OS.s[j - 1] + (OS.s[j] - OS.s[j - 1]) * t;
          const dy = Math.abs(profileAt(rr.prof, S.s[i]).y - profileAt(other.prof, sB).y);
          if (dy >= CLEARANCE + DECK) continue;
          worst = { key, x: S.x[i], z: S.z[i], other };
          break;
        }
        if (worst) {
          reported.add(worst.key);
          issues.push({ level: "warn", code: "overlap", msg: "Two roads overlap here without meeting", x: worst.x, z: worst.z, roadId: rr.id });
        }
      }
    }
  }
  lap("checks");

  /* 11 ─ structures (bridges, piers), props, blocks */
  for (const rr of roads) {
    for (const span of rr.bridges) {
      structures.push({ kind: "bridge", roadId: rr.id, s0: span.s0, s1: span.s1 });
      const len = span.s1 - span.s0;
      const count = Math.max(0, Math.floor(len / 32));
      for (let k = 1; k <= count; k++) {
        let s = span.s0 + (len * k) / (count + 1);
        let placed = null;
        for (const shift of [0, 7, -7, 13, -13]) {
          const st = clamp(s + shift, span.s0 + 4, span.s1 - 4);
          const e = evalAlignment(rr.al, st);
          const y = profileAt(rr.prof, st);
          let blocked = false;
          for (const it of foot.query(e.x, e.z, 30)) {
            const other = it.data.rr;
            if (other === rr) continue;
            const { d2, t } = pointSegDist2(e.x, e.z, it.ax, it.az, it.bx, it.bz);
            const j = it.data.i;
            const hw = other.halfW[j - 1] + (other.halfW[j] - other.halfW[j - 1]) * t;
            if (d2 < (hw + 1.5) ** 2) {
              const oy = profileAt(other.prof, other.smp.s[j]).y;
              if (oy < y.y - 2) { blocked = true; break; }
            }
          }
          if (!blocked) { placed = { e, y, st }; break; }
        }
        if (!placed) continue;
        const lay = layoutAt(rr.stack, placed.st, rr.L);
        const ed = layoutEdges(lay);
        // Under the middle of the deck, not the reference line (asymmetric roads).
        const mid = (ed.propL + ed.propR) / 2;
        structures.push({
          kind: "pier", roadId: rr.id,
          x: placed.e.x + Math.sin(placed.e.th) * mid, z: placed.e.z - Math.cos(placed.e.th) * mid, th: placed.e.th,
          width: ed.propL - ed.propR, top: placed.y.y - DECK, base: placed.y.ground,
        });
      }
    }
  }
  const props = opts.fast ? [] : buildProps({ roads, nodes: [...nodes.values()] }, opts);
  lap("props");
  const blocks = opts.blocks === false || opts.fast ? [] : buildBlocks([...nodes.values()], roads, opts);
  lap("blocks");

  for (const node of nodes.values()) for (const i of node.issues) issues.push(i);
  for (const rr of roads) for (const i of rr.issues) issues.push(i);
  const order = { error: 0, warn: 1, info: 2 };
  issues.sort((p, q) => order[p.level] - order[q.level]);

  let laneKm = 0, conCount = 0;
  for (const p of graph.paths) {
    if (p.kind === "lane") laneKm += p.len / 1000;
    else conCount++;
  }
  const nodeList = [...nodes.values()];
  const result = {
    style, roadScale, nodes: nodeList, nodesById: nodes, roads, roadsById, graph, structures, props, blocks, issues,
    stats: {
      ms: now() - T0, timings,
      roads: roads.length, nodes: nodeList.length,
      junctions: nodeList.filter((n) => n.kind === "junction").length,
      roundabouts: nodeList.filter((n) => n.kind === "roundabout").length,
      splits: nodeList.filter((n) => n.kind === "split").length,
      laneKm, connectors: conCount, paths: graph.paths.length,
      blocks: blocks.length, lots: blocks.reduce((a, b) => a + b.lots.length, 0),
      props: props.length, overpasses: structures.filter((s) => s.kind === "overpass").length,
    },
  };
  result.locate = (x, z) => locate(result, grid, x, z);
  return result;
}

/* ------------------------------------------------------------------ road geometry */

function buildRoadGeometry(rr, style) {
  const { al, stack, L } = rr;
  const markRange = [Math.max(rr.s0, rr.armA.markStart), Math.min(rr.s1, L - rr.armB.markStart)];
  rr.markRange = markRange;
  // Edge and bike lines run to the mouth, but break across a crosswalk.
  rr.walkRange = [rr.armA.crosswalk ? markRange[0] : rr.s0, rr.armB.crosswalk ? markRange[1] : rr.s1];
  const breaks = [...sectionBreaks(stack, L), ...sectionEventStations(stack, L), markRange[0], markRange[1]];
  const smp = sampleAlignment(al, rr.s0, rr.s1, { maxStep: 6, maxAngle: 0.04, breaks });
  const N = smp.s.length;
  const lays = new Array(N);
  const edgesPts = { curbL: [], curbR: [], propL: [], propR: [], driveL: [], driveR: [] };
  const halfW = new Float64Array(N);
  // Footprint centre + half width (roads are often asymmetric: a one-way
  // motorway carriageway is 1.8 m left of its line and 15.5 m right).
  const footMid = new Array(N);
  let tight = null;
  for (let i = 0; i < N; i++) {
    const lay = layoutAt(stack, smp.s[i], L);
    lays[i] = lay;
    const e = layoutEdges(lay);
    const sx = Math.sin(smp.th[i]), sz = -Math.cos(smp.th[i]);
    const P = (t) => [smp.x[i] + sx * t, smp.z[i] + sz * t];
    edgesPts.curbL.push(P(e.curbL)); edgesPts.curbR.push(P(e.curbR));
    edgesPts.propL.push(P(e.propL)); edgesPts.propR.push(P(e.propR));
    let dlo = Infinity, dhi = -Infinity;
    for (const l of [...lay.left, ...lay.right]) {
      if (!l.present || !LANE_TYPES[l.type]?.drive) continue;
      dlo = Math.min(dlo, l.tIn, l.tOut); dhi = Math.max(dhi, l.tIn, l.tOut);
    }
    if (!isFinite(dlo)) { dlo = e.curbR; dhi = e.curbL; }
    edgesPts.driveL.push(P(dhi)); edgesPts.driveR.push(P(dlo));
    halfW[i] = (e.propL - e.propR) / 2;
    footMid[i] = P((e.propL + e.propR) / 2);
    const k = smp.k[i];
    if (!tight && (1 + k * e.propL < 0.05 || 1 + k * e.propR < 0.05)) tight = { x: smp.x[i], z: smp.z[i], R: 1 / Math.abs(k) };
  }
  if (tight) {
    rr.issues.push({ level: "error", code: "tight-bend", msg: `Bend radius ${tight.R.toFixed(1)} m is tighter than the road is wide`, x: tight.x, z: tight.z, roadId: rr.id });
  }
  rr.smp = smp; rr.lays = lays; rr.edgesPts = edgesPts; rr.halfW = halfW; rr.footMid = footMid;

  const polyOf = (inner, outer) => [...inner, ...outer.slice().reverse()];
  rr.carriage = polyOf(edgesPts.curbR, edgesPts.curbL);
  rr.strips = [];
  for (const side of ["left", "right"]) {
    stack.sides[side].forEach((lane, b) => {
      let any = false;
      const inner = [], outer = [];
      for (let i = 0; i < N; i++) {
        const l = lays[i][side][b];
        if (l.present) any = true;
        const sx = Math.sin(smp.th[i]), sz = -Math.cos(smp.th[i]);
        inner.push([smp.x[i] + sx * l.tIn, smp.z[i] + sz * l.tIn]);
        outer.push([smp.x[i] + sx * l.tOut, smp.z[i] + sz * l.tOut]);
      }
      if (any) rr.strips.push({ type: lane.type, side, laneId: lane.id, poly: polyOf(inner, outer) });
    });
  }
  let cwMax = 0;
  for (const l of lays) cwMax = Math.max(cwMax, l.cw);
  rr.center = null;
  if (cwMax >= 0.3) {
    const left = [], right = [];
    for (let i = 0; i < N; i++) {
      const h = lays[i].cw / 2;
      const sx = Math.sin(smp.th[i]), sz = -Math.cos(smp.th[i]);
      left.push([smp.x[i] + sx * h, smp.z[i] + sz * h]);
      right.push([smp.x[i] - sx * h, smp.z[i] - sz * h]);
    }
    const kind = stack.center.kind;
    const cap = (i, dirSign) => {
      const h = lays[i].cw / 2;
      if (kind !== "raised" || h < 0.15) return [];
      const th = smp.th[i];
      const dx = Math.cos(th) * dirSign, dz = Math.sin(th) * dirSign;
      const sx = Math.sin(th), sz = -Math.cos(th);
      const out = [];
      for (let k = 1; k < 8; k++) {
        const a = -Math.PI / 2 + (Math.PI * k) / 8;
        const u = Math.cos(a) * h * 0.9, v = Math.sin(a) * h * dirSign;
        out.push([smp.x[i] + dx * u + sx * v, smp.z[i] + dz * u + sz * v]);
      }
      return out;
    };
    rr.center = { kind, poly: [...right, ...cap(N - 1, 1), ...left.reverse(), ...cap(0, -1)] };
  }

  const mk = buildRoadMarkings(rr, smp, lays, style, markRange, rr.walkRange);
  rr.lines = mk.lines;
  rr.curbs = mk.curbs;

  // Bridges / tunnels from the profile.
  rr.bridges = []; rr.tunnels = [];
  const prof = rr.prof;
  let bStart = null, tStart = null;
  let ySum = 0;
  for (let i = 0; i < prof.s.length; i++) {
    const s = prof.s[i];
    ySum += prof.y[i];
    const inRange = s >= rr.s0 - 1 && s <= rr.s1 + 1;
    const up = inRange && prof.y[i] - prof.ground[i] > 3.0;
    const down = inRange && prof.ground[i] - prof.y[i] > 7.0;
    if (up && bStart == null) bStart = s;
    if (!up && bStart != null) { rr.bridges.push({ s0: bStart, s1: s }); bStart = null; }
    if (down && tStart == null) tStart = s;
    if (!down && tStart != null) { rr.tunnels.push({ s0: tStart, s1: s }); tStart = null; }
  }
  if (bStart != null) rr.bridges.push({ s0: bStart, s1: Math.min(rr.s1, prof.s[prof.s.length - 1]) });
  if (tStart != null) rr.tunnels.push({ s0: tStart, s1: Math.min(rr.s1, prof.s[prof.s.length - 1]) });
  rr.yMean = ySum / prof.s.length;
  rr.yMax = Math.max(...prof.y);
}

/* ------------------------------------------------------------------ lane pieces */

function buildRoadLanes(rr, addPath, link) {
  const { stack, L, smp, lays } = rr;
  const events = sectionEventStations(stack, L).filter((s) => s > rr.s0 + 0.5 && s < rr.s1 - 0.5);
  const cuts = [rr.s0, ...events, rr.s1];
  const K = cuts.length - 1;
  rr.laneEnds = { a: { in: {}, out: {} }, b: { in: {}, out: {} } };
  const speed = rr.type.speed / 3.6;
  for (const side of ["left", "right"]) {
    const lanes = stack.sides[side];
    const drive = [];
    lanes.forEach((l, b) => { if (LANE_TYPES[l.type]?.drive) drive.push(b); });
    const pieces = new Map();
    for (const b of drive) {
      const lane = lanes[b];
      const arr = new Array(K).fill(null);
      for (let k = 0; k < K; k++) {
        const mid = (cuts[k] + cuts[k + 1]) / 2;
        const w = laneWidthAt(lane, mid, L);
        if (w < Math.max(1.0, lane.full * 0.5)) continue;
        const pts = [];
        for (let i = 0; i < smp.s.length; i++) {
          if (smp.s[i] < cuts[k] - 1e-4 || smp.s[i] > cuts[k + 1] + 1e-4) continue;
          const l = lays[i][side][b];
          const t = (l.tIn + l.tOut) / 2;
          pts.push([smp.x[i] + Math.sin(smp.th[i]) * t, smp.z[i] - Math.cos(smp.th[i]) * t]);
        }
        if (pts.length < 2) continue;
        if (side === "left") pts.reverse();
        arr[k] = addPath({ kind: "lane", roadId: rr.id, laneId: lane.id, side, turn: lane.turn, pts, speed, s0: cuts[k], s1: cuts[k + 1] });
      }
      pieces.set(b, arr);
    }
    const order = [];
    for (let k = 0; k < K; k++) order.push(k);
    if (side === "left") order.reverse();
    const neighbour = (b, k) => {
      let best = null, bd = Infinity;
      for (const [b2, arr] of pieces) {
        if (b2 === b || !arr[k]) continue;
        const d = Math.abs(b2 - b) + (b2 > b ? 0.1 : 0);
        if (d < bd) { bd = d; best = arr[k]; }
      }
      return best;
    };
    for (let q = 1; q < order.length; q++) {
      const kp = order[q - 1], kc = order[q];
      for (const [b, arr] of pieces) {
        if (arr[kp] && arr[kc]) link(arr[kp], arr[kc]);
        else if (!arr[kp] && arr[kc]) link(neighbour(b, kp), arr[kc]);
        else if (arr[kp] && !arr[kc]) link(arr[kp], neighbour(b, kc));
      }
    }
    for (const [b, arr] of pieces) {
      const id = lanes[b].id;
      if (side === "right") {
        if (arr[K - 1]) rr.laneEnds.b.in[id] = arr[K - 1].id;
        if (arr[0]) rr.laneEnds.a.out[id] = arr[0].id;
      } else {
        if (arr[0]) rr.laneEnds.a.in[id] = arr[0].id;
        if (arr[K - 1]) rr.laneEnds.b.out[id] = arr[K - 1].id;
      }
    }
  }
}

/* ------------------------------------------------------------------ locate */

function locate(result, grid, x, z) {
  for (const node of result.nodes) {
    if (node.pad && pointInPoly(x, z, node.pad)) {
      return { kind: "node", nodeId: node.id, nodeKind: node.kind, y: node.y, control: node.control };
    }
  }
  let best = null, bd = Infinity;
  for (const it of grid.query(x, z, 40)) {
    const { d2, t } = pointSegDist2(x, z, it.ax, it.az, it.bx, it.bz);
    if (d2 < bd) { bd = d2; best = { it, t }; }
  }
  if (!best) return null;
  const rr = best.it.data.rr, i = best.it.data.i;
  const S = rr.smp;
  const s = S.s[i - 1] + (S.s[i] - S.s[i - 1]) * best.t;
  const e = evalAlignment(rr.al, s);
  const lat = (x - e.x) * Math.sin(e.th) - (z - e.z) * Math.cos(e.th);
  const lay = layoutAt(rr.stack, s, rr.L);
  let lane = null;
  for (const l of [...lay.left, ...lay.right]) {
    const lo = Math.min(l.tIn, l.tOut), hi = Math.max(l.tIn, l.tOut);
    if (l.present && lat >= lo && lat <= hi) { lane = l; break; }
  }
  const edges = layoutEdges(lay);
  if (lat > edges.propL + 0.5 || lat < edges.propR - 0.5) return null;
  if (!lane && Math.abs(lat) <= lay.cw / 2) lane = { type: `median (${rr.stack.center.kind})`, w: lay.cw, id: "C" };
  const p = profileAt(rr.prof, s);
  return {
    kind: "road", roadId: rr.id, roadType: rr.type.label, s, L: rr.L, t: lat, lane,
    y: p.y, grade: p.g, ground: p.ground, radius: Math.abs(e.k) > 1e-6 ? 1 / Math.abs(e.k) : Infinity,
    superelevation: Math.abs(e.k) > 1e-6 ? curveDesign(rr.type.speed, 1 / Math.abs(e.k), !rr.type.spirals).e : 0,
  };
}

function pointInPoly(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], zi = pts[i][1], xj = pts[j][0], zj = pts[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export { ROAD_TYPES, LANE_TYPES, armPoint };
