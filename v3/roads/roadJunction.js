// Node geometry: what happens where roads meet.
//
// Every road end at a node is an ARM in the node's AWAY frame — heading θ
// pointing out of the node along the road, station σ measured from the node,
// lateral t with +t on the left. In that frame the lanes arriving at the node
// are ALWAYS on the left (+t) and departing lanes on the right (−t), whichever
// end of the road it is.
//
// Node kinds:
//   junction     — arms trimmed back so curb returns (fillets) fit each corner;
//                  the pad fills between; stop/yield lines, crosswalks, arrows.
//   continuation — two roads joined nearly straight (headings forced smooth).
//   roundabout   — ring carriageway, central island + apron, flared entries
//                  (circle–line fillets), splitter islands, yield lines.
//   split        — diverge / merge: branch roads start side by side where the
//                  trunk's lanes are, no pad, painted gore until the nose.
//   end          — dead end with a sidewalk cap and U-turn connectors.
//
// Corner chains run from arm i's RIGHT edge to arm i+1's LEFT edge (arms
// sorted by increasing θ, which walks the node clockwise on screen). The pad,
// corner sidewalks and city blocks (roadBlocks.js) all consume these chains.

import {
  wrap2Pi, wrapPi, clamp, lineIntersect, arcPoints, cubicPoints, polylineLength, cumulative, polylineAt, pointInPolygon,
} from "./roadMath.js";

const STRAIGHT_EPS = 0.1; // rad — corners within ~6° of straight get no fillet

export function armPoint(arm, sigma, t) {
  return [arm.ox + arm.dx * sigma + arm.nx * t, arm.oz + arm.dz * sigma + arm.nz * t];
}

/* ------------------------------------------------------------------ corners */

/** Fillet (or convex/straight corner) between arm i's edge tI and arm j's edge tJ. */
export function lineCorner(ai, tI, aj, tJ, r) {
  const Ax = ai.ox + ai.nx * tI, Az = ai.oz + ai.nz * tI;
  const Bx = aj.ox + aj.nx * tJ, Bz = aj.oz + aj.nz * tJ;
  const phi = wrap2Pi(aj.th - ai.th);
  if (phi > 1e-3 && phi < Math.PI - STRAIGHT_EPS) {
    const hit = lineIntersect(Ax, Az, ai.dx, ai.dz, Bx, Bz, aj.dx, aj.dz);
    if (hit) {
      const X = [Ax + ai.dx * hit.u, Az + ai.dz * hit.u];
      const tau = r / Math.tan(phi / 2);
      const Ti = [X[0] + ai.dx * tau, X[1] + ai.dz * tau];
      const Tj = [X[0] + aj.dx * tau, X[1] + aj.dz * tau];
      let pts = [Ti, Tj];
      if (r > 0.01) {
        let bx = ai.dx + aj.dx, bz = ai.dz + aj.dz;
        const bl = Math.hypot(bx, bz) || 1;
        bx /= bl; bz /= bl;
        const cd = r / Math.sin(phi / 2);
        const C = [X[0] + bx * cd, X[1] + bz * cd];
        const a0 = Math.atan2(Ti[1] - C[1], Ti[0] - C[0]);
        const a1 = a0 + wrapPi(Math.atan2(Tj[1] - C[1], Tj[0] - C[0]) - a0);
        pts = arcPoints(C[0], C[1], r, a0, a1, 0.1);
      }
      return { kind: "fillet", sI: hit.u + tau, sJ: hit.v + tau, pts, phi };
    }
  }
  if (phi > Math.PI + STRAIGHT_EPS) {
    const hit = lineIntersect(Ax, Az, ai.dx, ai.dz, Bx, Bz, aj.dx, aj.dz);
    if (hit && hit.u <= 0.05 && hit.v <= 0.05 && Math.hypot(hit.u, hit.v) < 80) {
      return { kind: "convex", sI: 0, sJ: 0, pts: [[Ax + ai.dx * hit.u, Az + ai.dz * hit.u]], phi };
    }
  }
  return { kind: "straight", sI: 0, sJ: 0, pts: [], phi };
}

/** Circle (radius Rc, centred on the node) to arm-edge fillet, radius rf. */
function circleCorner(node, Rc, arm, tEdge, sideSign, rf) {
  const tp = tEdge + sideSign * rf;
  const D = Rc + rf;
  if (D <= Math.abs(tp) + 1e-6) return null;
  const sigma = Math.sqrt(D * D - tp * tp);
  const C = armPoint(arm, sigma, tp);
  const Tl = armPoint(arm, sigma, tEdge);
  const Tc = [node.x + ((C[0] - node.x) * Rc) / D, node.z + ((C[1] - node.z) * Rc) / D];
  const a0 = Math.atan2(Tl[1] - C[1], Tl[0] - C[0]);
  const a1 = a0 + wrapPi(Math.atan2(Tc[1] - C[1], Tc[0] - C[0]) - a0);
  return { sigma, pts: arcPoints(C[0], C[1], rf, a0, a1, 0.1), angle: Math.atan2(Tc[1] - node.z, Tc[0] - node.x) };
}

function cornerRadius(node, ai, aj) {
  const key = [ai.road.id, aj.road.id].sort().join("|");
  const o = node.src.corners?.[key];
  if (o != null) return o;
  if (node.src.radius != null) return node.src.radius;
  // Type defaults grow with the road scale (a wider road needs a wider return);
  // radii authored on the node above are taken as given.
  const r = Math.min(ai.type.cornerRadius ?? 8, aj.type.cornerRadius ?? 8) * (node.roadScale ?? 1);
  // The tangent length is r / tan(φ/2): on an acute corner a full radius
  // pushes the curb return tens of metres back and paves a huge pad. Real
  // acute corners get a tight return, so scale down below 90°.
  const phi = wrap2Pi(aj.th - ai.th);
  return phi < Math.PI / 2 ? r * clamp(phi / (Math.PI / 2), 0.3, 1) : r;
}

/* ------------------------------------------------------------------ builders */

/** Junction / continuation / corner. Sets arm.trim and node geometry. */
export function buildJunctionGeometry(node, arms, { straightOnly = false } = {}) {
  const n = arms.length;
  const corners = [];
  for (let i = 0; i < n; i++) {
    const ai = arms[i], aj = arms[(i + 1) % n];
    const r = straightOnly ? 0 : cornerRadius(node, ai, aj);
    const curb = straightOnly ? { kind: "straight", sI: 0, sJ: 0, pts: [] } : lineCorner(ai, ai.edges.curbR, aj, aj.edges.curbL, r);
    const swI = ai.edges.curbR - ai.edges.propR, swJ = aj.edges.propL - aj.edges.curbL;
    const rp = Math.max(0, r - (swI + swJ) / 2);
    const prop = straightOnly ? { kind: "straight", sI: 0, sJ: 0, pts: [] } : lineCorner(ai, ai.edges.propR, aj, aj.edges.propL, rp);
    corners.push({ i, j: (i + 1) % n, r, curb, prop, sw: swI > 0.05 || swJ > 0.05 });
  }
  for (let i = 0; i < n; i++) {
    const before = corners[(i - 1 + n) % n], after = corners[i];
    let trim = Math.max(0, before.curb.sJ, after.curb.sI, before.prop.sJ, after.prop.sI);
    if (!straightOnly && n >= 3) trim = Math.max(trim, 1.0);
    arms[i].trim = trim;
  }
  finishLineCorners(node, arms, corners);
  node.corners = corners;
  if (!straightOnly) {
    for (const a of arms) {
      if (a.trim > 45) {
        node.issues.push({ level: "warn", code: "sharp-junction", msg: `Roads meet at a very sharp angle — the junction reaches ${a.trim.toFixed(0)} m back`, x: node.x, z: node.z, nodeId: node.id });
        break;
      }
    }
    for (let i = 0; i < n; i++) {
      const phi = wrap2Pi(arms[(i + 1) % n].th - arms[i].th);
      if (n > 1 && phi < 0.26) {
        node.issues.push({ level: "warn", code: "arm-overlap", msg: "Two roads leave this node almost on top of each other", x: node.x, z: node.z, nodeId: node.id });
        break;
      }
    }
  }
}

function finishLineCorners(node, arms, corners) {
  const n = arms.length;
  const pad = [];
  node.sidewalks = [];
  for (let i = 0; i < n; i++) {
    const a = arms[i], c = corners[i], b = arms[c.j];
    const EiL = armPoint(a, a.trim, a.edges.curbL);
    const EiR = armPoint(a, a.trim, a.edges.curbR);
    const EjL = armPoint(b, b.trim, b.edges.curbL);
    pad.push(EiL, EiR, ...c.curb.pts);
    c.curbChain = [EiR, ...c.curb.pts, EjL];
    const PiR = armPoint(a, a.trim, a.edges.propR);
    const PjL = armPoint(b, b.trim, b.edges.propL);
    c.propChain = [PiR, ...c.prop.pts, PjL];
    if (c.sw) node.sidewalks.push([...c.curbChain, ...c.propChain.slice().reverse()]);
  }
  node.pad = n >= 2 ? pad : null;
}

/** Roundabout. */
export function buildRoundaboutGeometry(node, arms) {
  const src = node.src;
  const n = arms.length;
  let maxCarriage = 0, maxApproach = 0;
  for (const a of arms) {
    maxCarriage = Math.max(maxCarriage, a.edges.curbL - a.edges.curbR);
    maxApproach = Math.max(maxApproach, a.approach.length);
  }
  const lanes = clamp(src.ring?.lanes ?? (maxApproach >= 2 ? 2 : 1), 1, 3);
  // The whole ring scales with the road scale, authored radius included: a ring
  // sized for real lanes is too tight for scaled ones and would just error.
  const sc = node.roadScale ?? 1;
  const laneW = (lanes === 1 ? 5.2 : 4.6) * sc;
  const Ro = Math.max(src.ring?.radius != null ? src.ring.radius * sc : Math.max(15 * sc, maxCarriage * 0.9 + 9 * sc, lanes * laneW + 8 * sc), lanes * laneW + 3 * sc);
  const Ri = Ro - lanes * laneW;
  const apron = Math.min(2.2, Ri * 0.3);
  // Entry curb radius scales with the ring: a big flare on a mini roundabout
  // eats the angle between neighbouring entries.
  const rf = src.radius ?? clamp(Ro * 0.48, 6 * sc, 15 * sc);
  let sw = Infinity;
  for (const a of arms) sw = Math.min(sw, a.edges.curbR - a.edges.propR, a.edges.propL - a.edges.curbL);
  if (!isFinite(sw)) sw = 0;
  sw = Math.max(0, sw);
  const Rp = Ro + sw;
  const rfp = Math.max(1, rf - sw);
  node.ring = { Ro, Ri, apron, lanes, laneW, Rp };

  const fil = arms.map((a) => ({
    R: circleCorner(node, Ro, a, a.edges.curbR, -1, rf),
    L: circleCorner(node, Ro, a, a.edges.curbL, +1, rf),
    pR: circleCorner(node, Rp, a, a.edges.propR, -1, rfp),
    pL: circleCorner(node, Rp, a, a.edges.propL, +1, rfp),
  }));
  arms.forEach((a, i) => {
    const f = fil[i];
    if (!f.R || !f.L) {
      node.issues.push({ level: "error", code: "ring-small", msg: "Roundabout is narrower than a road entering it — raise the ring radius", x: node.x, z: node.z, nodeId: node.id });
    }
    a.trim = Math.max(Ro + 2, f.R?.sigma ?? 0, f.L?.sigma ?? 0, f.pR?.sigma ?? 0, f.pL?.sigma ?? 0);
  });

  const corners = [];
  const pad = [];
  node.sidewalks = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = arms[i], b = arms[j];
    const gap = n === 1 ? Math.PI * 2 : wrap2Pi(b.th - a.th);
    const chain = (rad, fr, fl, tR, tL, isCurb) => {
      const pts = [armPoint(a, a.trim, tR)];
      if (fr) pts.push(...fr.pts);
      if (fr && fl) {
        let sweep = wrap2Pi(fl.angle - fr.angle);
        if (sweep > gap + 0.35) {
          // Sidewalk corners that meet simply merge; only carriageway overlap is an error.
          if (isCurb && !node.issues.some((q) => q.code === "ring-crowded")) {
            node.issues.push({ level: "error", code: "ring-crowded", msg: "Roundabout entries overlap — spread the roads or enlarge the ring", x: node.x, z: node.z, nodeId: node.id });
          }
          sweep = 0;
        }
        pts.push(...arcPoints(node.x, node.z, rad, fr.angle, fr.angle + sweep, 0.08));
        pts.push(...fl.pts.slice().reverse());
      }
      pts.push(armPoint(b, b.trim, tL));
      return pts;
    };
    const curbChain = chain(Ro, fil[i].R, fil[j].L, a.edges.curbR, b.edges.curbL, true);
    const propChain = chain(Rp, fil[i].pR, fil[j].pL, a.edges.propR, b.edges.propL, false);
    pad.push(armPoint(a, a.trim, a.edges.curbL), ...curbChain.slice(0, -1));
    corners.push({ i, j, curbChain, propChain, sw: sw > 0.05 });
    if (sw > 0.05) node.sidewalks.push([...curbChain, ...propChain.slice().reverse()]);
  }
  node.pad = pad;
  node.corners = corners;

  for (let k = 1; k < lanes; k++) {
    node.markings.push({ kind: "line", pts: arcPoints(node.x, node.z, Ro - laneW * k, 0, Math.PI * 2, 0.05), width: 0.12, color: "white", dash: [3, 5] });
  }
  node.islands = [
    { kind: "apron", poly: arcPoints(node.x, node.z, Ri, 0, Math.PI * 2, 0.08) },
    { kind: "grass", poly: arcPoints(node.x, node.z, Math.max(0.5, Ri - apron), 0, Math.PI * 2, 0.08) },
  ];
  // Splitter islands on two-way arms.
  for (const a of arms) {
    if (!a.approach.length || !a.depart.length) continue;
    // A raised island needs room: on a narrow arm (an alley) it would fill the lanes.
    const carriage = a.edges.curbL - a.edges.curbR;
    if (carriage < 8 * sc) continue;
    const s0 = Ro + 1.2, s1 = Math.max(s0 + 3, a.trim + 1);
    const hw0 = Math.min(1.5 * sc, carriage * 0.12), hw1 = 0.35;
    const left = [], right = [];
    const N = 10;
    for (let k = 0; k <= N; k++) {
      const f = k / N;
      const sg = s0 + (s1 - s0) * f;
      const hw = hw0 + (hw1 - hw0) * Math.sqrt(f);
      left.push(armPoint(a, sg, hw));
      right.push(armPoint(a, sg, -hw));
    }
    const nose = [];
    for (let k = 1; k < 6; k++) {
      const ang = (Math.PI * k) / 6;
      nose.push(armPoint(a, s1 + Math.sin(ang) * hw1, Math.cos(ang) * hw1));
    }
    const tail = [];
    for (let k = 1; k < 6; k++) {
      const ang = (Math.PI * k) / 6;
      tail.push(armPoint(a, s0 - Math.sin(ang) * hw0 * 0.6, -Math.cos(ang) * hw0));
    }
    node.islands.push({ kind: "raised", poly: [...left, ...nose, ...right.reverse(), ...tail] });
  }
}

/** Split / merge: computes branch offsets. Gore comes after roads are sampled. */
export function planSplit(node, arms) {
  let trunk = arms.find((a) => a.road.id === node.src.trunk);
  if (!trunk) {
    let best = -Infinity;
    for (const a of arms) {
      const others = arms.filter((o) => o !== a);
      const mx = others[0].rawDx + others[1].rawDx, mz = others[0].rawDz + others[1].rawDz;
      const ml = Math.hypot(mx, mz) || 1;
      const score = -(a.rawDx * mx + a.rawDz * mz) / ml;
      if (score > best) { best = score; trunk = a; }
    }
  }
  const branches = arms.filter((a) => a !== trunk);
  const H = trunk.rawTh + Math.PI;
  // The right branch veers to increasing θ.
  branches.sort((p, q) => wrapPi(q.rawTh - H) - wrapPi(p.rawTh - H));
  const [right, left] = branches;
  const hn = [Math.sin(H), -Math.cos(H)];
  const driveExt = (arm, flipToH) => {
    let lo = Infinity, hi = -Infinity;
    for (const l of [...arm.lanesL, ...arm.lanesR]) {
      if (!l.drive || l.w < 0.5) continue;
      const t0 = flipToH ? -l.tIn : l.tIn, t1 = flipToH ? -l.tOut : l.tOut;
      lo = Math.min(lo, t0, t1); hi = Math.max(hi, t0, t1);
    }
    if (!isFinite(lo)) {
      const e = arm.edges;
      lo = flipToH ? -e.propL : e.propR; hi = flipToH ? -e.propR : e.propL;
    }
    return { lo, hi };
  };
  const T = driveExt(trunk, true);
  const RB = driveExt(right, false), LB = driveExt(left, false);
  const oR = T.lo - RB.lo;
  const oL = T.hi - LB.hi;
  node.split = { H, trunk, right, left, oR, oL, gap: oL + LB.lo - (oR + RB.hi) };
  right.offset = oR; left.offset = oL;
  for (const b of [right, left]) {
    b.constraintPt = [node.x + hn[0] * b.offset, node.z + hn[1] * b.offset];
    b.constraintTh = H;
  }
  for (const a of arms) a.trim = 0;
  if (node.split.gap < -0.6) {
    node.issues.push({ level: "info", code: "split-lane-gain", msg: `Branches are ${(-node.split.gap).toFixed(1)} m wider than the trunk — a lane is gained here`, x: node.x, z: node.z, nodeId: node.id });
  }
}

/** Painted gore between the branches' drive edges, up to the nose. */
export function buildGore(node, roadsById) {
  const sp = node.split;
  if (!sp) return;
  const edge = (arm, wantHLeft) => {
    const rr = roadsById.get(arm.road.id);
    if (!rr || !rr.edgesPts) return null;
    const roadLeft = arm.end === "a" ? wantHLeft : !wantHLeft;
    const pts = roadLeft ? rr.edgesPts.driveL : rr.edgesPts.driveR;
    return arm.end === "a" ? pts : pts.slice().reverse();
  };
  const eR = edge(sp.right, true), eL = edge(sp.left, false);
  if (!eR || !eL || eR.length < 2 || eL.length < 2) return;
  const cR = cumulative(eR), cL = cumulative(eL);
  const maxD = Math.min(cR[cR.length - 1], cL[cL.length - 1], 500);
  const nose = 3.0;
  const ptsR = [], ptsL = [];
  let reached = false;
  for (let d = 0; d <= maxD; d += 1.5) {
    const p = polylineAt(eR, cR, d), q = polylineAt(eL, cL, d);
    ptsR.push([p.x, p.z]); ptsL.push([q.x, q.z]);
    if (Math.hypot(p.x - q.x, p.z - q.z) >= nose) { reached = true; break; }
  }
  if (ptsR.length < 2) return;
  node.gore = { poly: [...ptsR, ...ptsL.reverse()], reached };
  const H = sp.H;
  node.markings.push({ kind: "hatch", poly: node.gore.poly, angle: H + Math.PI / 4, spacing: 3.0, width: 0.45, color: "white", chevronAxis: H });
}

/** Dead end: sidewalk cap behind the road end. */
export function buildEndGeometry(node, arm) {
  arm.trim = 0;
  const e = arm.edges;
  const sw = Math.max(0, e.curbR - e.propR, e.propL - e.curbL);
  const capDepth = sw > 0.05 ? sw : 0;
  const PR = armPoint(arm, 0, e.propR), PL = armPoint(arm, 0, e.propL);
  const chain = [PR];
  if (capDepth > 0) chain.push(armPoint(arm, -capDepth, e.propR), armPoint(arm, -capDepth, e.propL));
  chain.push(PL);
  node.corners = [{ i: 0, j: 0, propChain: chain, curbChain: [armPoint(arm, 0, e.curbR), armPoint(arm, 0, e.curbL)], sw: capDepth > 0 }];
  node.sidewalks = capDepth > 0 ? [[armPoint(arm, 0, e.propR), armPoint(arm, -capDepth, e.propR), armPoint(arm, -capDepth, e.propL), armPoint(arm, 0, e.propL)]] : [];
  node.pad = null;
  node.curbs = [[armPoint(arm, 0, e.curbR), armPoint(arm, 0, e.curbL)]];
}

/* ------------------------------------------------------------------ control */

export function resolveControl(node, arms, style) {
  const src = node.src.control || "auto";
  arms.forEach((a) => (a.control = "none"));
  if (node.kind === "roundabout") { arms.forEach((a) => (a.control = "yield")); return "yield"; }
  if (node.kind !== "junction" || arms.length < 3) return "none";
  const maxRank = Math.max(...arms.map((a) => a.type.rank));
  const minRank = Math.min(...arms.map((a) => a.type.rank));
  const majors = arms.filter((a) => a.type.rank === maxRank);
  let control = src;
  if (src === "auto") {
    if (maxRank >= 5) {
      node.issues.push({ level: "warn", code: "motorway-at-grade", msg: "A motorway meets other roads at grade — use a split/merge or an overpass", x: node.x, z: node.z, nodeId: node.id });
    }
    const significant = arms.filter((a) => a.type.rank >= 2).length;
    if (maxRank >= 3 && significant >= 3) control = "signal";
    else if (maxRank === minRank) control = style === "us" ? "allstop" : maxRank >= 2 ? "signal" : "priority";
    else control = maxRank - minRank >= 2 || minRank <= 1 ? "stop" : "yield";
  }
  for (const a of arms) {
    if (control === "signal") a.control = a.approach.length ? "signal" : "none";
    else if (control === "allstop") a.control = "stop";
    else if (control === "stop") a.control = majors.includes(a) ? "none" : "stop";
    else if (control === "yield") a.control = majors.includes(a) ? "none" : "yield";
    else a.control = "none";
    if (!a.approach.length) a.control = "none";
  }
  if (control === "signal") {
    const groups = [];
    arms.forEach((a) => (a.phase = -1));
    for (const a of arms) {
      if (a.phase >= 0) continue;
      a.phase = groups.length;
      const g = [a];
      for (const b of arms) {
        if (b.phase >= 0) continue;
        if (Math.abs(wrapPi(b.th - a.th - Math.PI)) < 0.6) { b.phase = a.phase; g.push(b); }
      }
      groups.push(g);
    }
    node.phases = groups.length;
  }
  return control;
}

/** Signal state for an arm at time t (s): 'green' | 'amber' | 'red'. */
export function signalState(node, arm, time) {
  const G = 14, A = 3, R = 1.5;
  const cyc = (G + A + R) * (node.phases || 1);
  const local = ((time % cyc) + cyc) % cyc;
  const start = arm.phase * (G + A + R);
  const u = local - start;
  if (u >= 0 && u < G) return "green";
  if (u >= G && u < G + A) return "amber";
  return "red";
}

/* ------------------------------------------------------------------ markings */

const rect = (arm, s0, s1, t0, t1) => [armPoint(arm, s0, t0), armPoint(arm, s1, t0), armPoint(arm, s1, t1), armPoint(arm, s0, t1)];

/** Crosswalks, stop/yield lines. Returns the station where lane markings may start. */
export function armMouthMarkings(node, arm, style) {
  const out = node.markings;
  let s = arm.trim;
  const e = arm.edges;
  const hasWalk = arm.crosswalk;
  if (hasWalk) {
    const s0 = s + (node.kind === "roundabout" ? 1.5 : 0.4);
    const depth = 3.0;
    const barW = 0.5;
    const medianHalf = arm.centerKind === "raised" || arm.centerKind === "barrier" ? arm.cw / 2 : 0;
    const t0 = e.curbR + 0.3, t1 = e.curbL - 0.3;
    if (style === "us") {
      out.push({ kind: "poly", pts: rect(arm, s0, s0 + 0.3, t0, t1), color: "white" });
      out.push({ kind: "poly", pts: rect(arm, s0 + depth - 0.3, s0 + depth, t0, t1), color: "white" });
    }
    // Stripes centred in each carriageway (both halves of a divided road), so
    // the leftover gap is split evenly between the two curbs.
    const spans = medianHalf > 0 ? [[t0, -medianHalf - 0.3], [medianHalf + 0.3, t1]] : [[t0, t1]];
    for (const [a, b] of spans) {
      const width = b - a;
      const n = Math.floor((width + barW) / (2 * barW));
      if (n < 1) continue;
      const start = a + (width - (2 * n - 1) * barW) / 2;
      for (let k = 0; k < n; k++) {
        const t = start + 2 * k * barW;
        out.push({ kind: "poly", pts: rect(arm, s0, s0 + depth, t, t + barW), color: "white", tag: "zebra", arm });
      }
    }
    s = s0 + depth;
    arm.walkStation = s0 + depth / 2;
  }
  if (!arm.approach.length) return s + 0.5;
  const tIn = Math.max(arm.cw / 2, 0);
  let tOut = tIn;
  for (const l of arm.lanesL) if ((l.drive || l.type === "bike") && l.w > 0.3) tOut = Math.max(tOut, l.tOut);
  if (arm.control === "stop" || arm.control === "signal") {
    const s0 = s + 1.0, wLine = arm.control === "stop" ? 0.5 : 0.35;
    out.push({ kind: "poly", pts: rect(arm, s0, s0 + wLine, tIn, tOut), color: "white" });
    arm.stopStation = s0;
    s = s0 + wLine;
  } else if (arm.control === "yield") {
    const s0 = node.kind === "roundabout" ? s : s + 0.8;
    if (node.kind === "roundabout") {
      // Teeth follow the ring edge across the WHOLE flared entry: from the
      // splitter island to the entry curb. A tooth is kept only if it lies on
      // the paved mouth and clear of every island — the flare is wider than
      // the arm's own lanes, so lane extents alone stop short.
      const R = node.ring.Ro + 0.6;
      const half = 0.4, tall = 1.0, step = 1.25;
      const clear = (p) => pointInPolygon(p[0], p[1], node.pad)
        && !node.islands.some((isl) => isl.kind === "raised" && pointInPolygon(p[0], p[1], isl.poly));
      const teeth = [];
      for (let t = 0.2; t < Math.min(R - 1, e.curbL + 20); t += 0.25) {
        const sg = Math.sqrt(R * R - t * t);
        const tri = [armPoint(arm, sg, t - half), armPoint(arm, sg, t + half), armPoint(arm, sg + tall, t)];
        const mid = armPoint(arm, sg + tall / 2, t);
        const ok = tri.every(clear) && clear(mid)
          && clear(armPoint(arm, sg, t - half - 0.25)) && clear(armPoint(arm, sg, t + half + 0.25));
        if (!ok) {
          // One contiguous row: past the entry curb the circle reaches the
          // NEXT arm's mouth, which must not get teeth.
          if (teeth.length && t - teeth[teeth.length - 1].t > step * 1.5) break;
          continue;
        }
        if (teeth.length && t - teeth[teeth.length - 1].t < step) continue;
        teeth.push({ t, tri });
      }
      for (const k of teeth) out.push({ kind: "poly", pts: k.tri, color: "white" });
      arm.stopStation = arm.trim - 1;
    } else {
      for (let t = tIn + 0.35; t < tOut - 0.3; t += 1.0) {
        out.push({ kind: "poly", pts: [armPoint(arm, s0, t - 0.3), armPoint(arm, s0, t + 0.3), armPoint(arm, s0 + 0.9, t)], color: "white" });
      }
      arm.stopStation = s0;
      s = s0 + 1.0;
    }
  } else {
    arm.stopStation = s;
  }
  return s + 0.5;
}

/**
 * Arrow glyph as marking records. kinds ⊂ {left, straight, right}.
 * Proportions follow real lane arrows (~5 m long, ~1.2 m wide), and the glyph
 * is scaled so its widest point stays inside a lane of width `laneW`.
 */
export function arrowMarkings(x, z, th, kinds, color = "white", laneW = 3.25) {
  const fx = Math.cos(th), fz = Math.sin(th);
  const lx = Math.sin(th), lz = -Math.cos(th);
  const turn = kinds.has("left") || kinds.has("right");
  // Widest lateral reach of a turn glyph at k = 1 is bend + headLen = 1.35 m.
  const k = turn ? Math.min(1, (laneW / 2 - 0.25) / 1.35) : Math.min(1, (laneW / 2 - 0.25) / 0.45);
  const P = (u, v) => [x + fx * u * k + lx * v * k, z + fz * u * k + lz * v * k];
  const out = [];
  const shaftW = 0.15 * k;
  const head = (u, v, hx, hz, len = 1.2, half = 0.45) => {
    const nx = -hz, nz = hx;
    return {
      kind: "poly", color,
      pts: [P(u + hx * len, v + hz * len), P(u + nx * half, v + nz * half), P(u - nx * half, v - nz * half)],
    };
  };
  const bend = 0.6, turnAt = 0.6;
  out.push({ kind: "line", pts: [P(-4.2, 0), P(turn ? turnAt : 0.2, 0)], width: shaftW, color });
  if (kinds.has("straight")) {
    out.push({ kind: "line", pts: [P(0, 0), P(1.2, 0)], width: shaftW, color });
    out.push(head(1.2, 0, 1, 0));
  }
  for (const side of ["left", "right"]) {
    if (!kinds.has(side)) continue;
    const sg = side === "left" ? 1 : -1;
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * (Math.PI / 2);
      pts.push(P(turnAt + Math.sin(a) * bend, sg * (1 - Math.cos(a)) * bend));
    }
    out.push({ kind: "line", pts, width: shaftW, color });
    out.push(head(turnAt + bend, sg * bend, 0, sg, 0.75, 0.38));
  }
  return out;
}

/* ------------------------------------------------------------------ connectors */

function turnClass(ain, aout) {
  const d = wrapPi(aout.th - (ain.th + Math.PI));
  if (Math.abs(d) > 2.8) return "uturn";
  if (d > 0.6) return "right";
  if (d < -0.6) return "left";
  return "straight";
}

function connectorCurve(p0, h0, p3, h3) {
  const d0 = [Math.cos(h0), Math.sin(h0)], d3 = [Math.cos(h3), Math.sin(h3)];
  const hit = lineIntersect(p0[0], p0[1], d0[0], d0[1], p3[0], p3[1], -d3[0], -d3[1]);
  const D = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  let u = D / 3, v = D / 3;
  if (hit && hit.u > 0.2 && hit.v > 0.2 && hit.u < D * 3 && hit.v < D * 3) {
    u = hit.u * 0.56; v = hit.v * 0.56;
  }
  const p1 = [p0[0] + d0[0] * u, p0[1] + d0[1] * u];
  const p2 = [p3[0] - d3[0] * v, p3[1] - d3[1] * v];
  return cubicPoints(p0, p1, p2, p3, Math.max(6, Math.ceil(D / 2)));
}

/**
 * Junction connectors: which approach lane may go to which departure lane.
 * Dedicated turn lanes win; otherwise the innermost lane turns left, the
 * outermost turns right, every lane may go straight.
 */
export function junctionConnectors(node, arms) {
  const cons = [];
  for (const ai of arms) {
    const Q = ai.approach;
    if (!Q.length) continue;
    const moves = [];
    for (const aj of arms) {
      if (aj === ai || !aj.depart.length) continue;
      const tc = turnClass(ai, aj);
      if (tc === "uturn") continue;
      moves.push({ aj, tc });
    }
    const hasStraight = moves.some((m) => m.tc === "straight");
    const plain = Q.filter((l) => !l.turn);
    const allowed = (lane, tc) => {
      if (lane.turn) return lane.turn.split("-").includes(tc === "straight" ? "through" : tc);
      const dedicated = Q.some((l) => l.turn && l.turn.split("-").includes(tc === "straight" ? "through" : tc));
      if (dedicated && tc !== "straight") return false;
      if (plain.length <= 1) return true;
      const idx = plain.indexOf(lane);
      if (tc === "straight") return true;
      if (tc === "left") return idx === 0 || !hasStraight && idx < plain.length / 2;
      return idx === plain.length - 1 || !hasStraight && idx >= plain.length / 2;
    };
    // A lane with no legal movement (e.g. a left pocket where left is a one-way
    // street coming IN) would strand traffic: give it what no dedicated lane
    // serves, or everything, and say so.
    const served = new Map(Q.map((l) => [l, moves.filter((m) => allowed(l, m.tc))]));
    const extra = new Map();
    for (const l of Q) {
      if (served.get(l).length || !moves.length) continue;
      const free = moves.filter((m) => !Q.some((o) => o !== l && o.turn && served.get(o).includes(m)));
      extra.set(l, new Set(free.length ? free : moves));
      if (l.turn) {
        node.issues.push({ level: "warn", code: "turn-no-exit", msg: `A ${l.turn}-turn lane has no ${l.turn} exit here`, x: node.x, z: node.z, nodeId: node.id, roadId: ai.road.id });
      }
    }
    for (const m of moves) {
      const ins = Q.filter((l) => allowed(l, m.tc) || extra.get(l)?.has(m));
      if (!ins.length) continue;
      const D = m.aj.depart;
      ins.forEach((lane, k) => {
        let out;
        if (m.tc === "right") out = D[Math.max(0, D.length - ins.length + k)];
        else out = D[Math.min(D.length - 1, k)];
        const p0 = armPoint(ai, ai.trim, lane.t);
        const p3 = armPoint(m.aj, m.aj.trim, out.t);
        cons.push({
          from: { arm: ai, lane }, to: { arm: m.aj, lane: out }, turn: m.tc,
          pts: connectorCurve(p0, ai.th + Math.PI, p3, m.aj.th),
        });
      });
    }
  }
  return cons;
}

export function roundaboutConnectors(node, arms) {
  const ring = node.ring;
  const cons = [];
  const laneR = (k) => ring.Ro - ring.laneW * (0.5 + k);
  for (const ai of arms) {
    if (!ai.approach.length) continue;
    for (const aj of arms) {
      if (aj === ai || !aj.depart.length) continue;
      const sweepCenters = wrap2Pi(ai.th - aj.th);
      const inner = ring.lanes >= 2 && sweepCenters > Math.PI * 1.05;
      const ins = ai.approach.length === 1 ? ai.approach : [inner ? ai.approach[0] : ai.approach[ai.approach.length - 1]];
      for (const lane of ins) {
        const rr = laneR(inner ? ring.lanes - 1 : 0);
        const out = inner ? aj.depart[0] : aj.depart[aj.depart.length - 1];
        const aIn = ai.th - Math.asin(clamp(lane.t / rr, -0.95, 0.95)) - 0.3;
        const aOut = aj.th + Math.asin(clamp(-out.t / rr, -0.95, 0.95)) + 0.3;
        let sweep = wrap2Pi(aIn - aOut);
        if (sweep < 0.15) sweep += Math.PI * 2;
        const pIn = [node.x + Math.cos(aIn) * rr, node.z + Math.sin(aIn) * rr];
        const pOut = [node.x + Math.cos(aIn - sweep) * rr, node.z + Math.sin(aIn - sweep) * rr];
        const p0 = armPoint(ai, ai.trim, lane.t);
        const p3 = armPoint(aj, aj.trim, out.t);
        const entry = connectorCurve(p0, ai.th + Math.PI, pIn, aIn - Math.PI / 2);
        const arc = arcPoints(node.x, node.z, rr, aIn, aIn - sweep, 0.08);
        const exit = connectorCurve(pOut, aIn - sweep - Math.PI / 2, p3, aj.th);
        cons.push({
          from: { arm: ai, lane }, to: { arm: aj, lane: out }, turn: "ring",
          pts: [...entry, ...arc.slice(1), ...exit.slice(1)],
        });
      }
    }
  }
  return cons;
}

/** Straight-through links (continuation / split): match lanes by lateral position. */
export function lateralLinks(node, pairs) {
  const cons = [];
  for (const { from, to, oFrom = 0, oTo = 0 } of pairs) {
    for (const lane of from.approach) {
      const tH = -(lane.t + oFrom);
      let best = null, bd = Infinity;
      for (const out of to.depart) {
        const d = Math.abs(out.t + oTo - tH);
        if (d < bd) { bd = d; best = out; }
      }
      if (best && bd < 2.6) {
        cons.push({ from: { arm: from, lane }, to: { arm: to, lane: best }, turn: "straight", pts: null });
      }
    }
  }
  return cons;
}

/** Dead end: every arriving lane turns back into the matching departing lane. */
export function uturnConnectors(node, arm) {
  const cons = [];
  if (!arm.approach.length || !arm.depart.length) return cons;
  arm.approach.forEach((lane, k) => {
    const out = arm.depart[Math.min(arm.depart.length - 1, k)];
    const p0 = armPoint(arm, arm.trim, lane.t), p3 = armPoint(arm, arm.trim, out.t);
    const back = Math.max(2, Math.abs(lane.t - out.t) * 0.9);
    const p1 = armPoint(arm, arm.trim - back, lane.t), p2 = armPoint(arm, arm.trim - back, out.t);
    cons.push({ from: { arm, lane }, to: { arm, lane: out }, turn: "uturn", pts: cubicPoints(p0, p1, p2, p3, 12) });
  });
  return cons;
}

export { polylineLength };
