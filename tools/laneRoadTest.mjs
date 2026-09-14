// Lane-based road engine (v3/roads/) — geometry, junctions, lane graph, blocks.
//
// The engine is plain JS, so everything the 2D lab draws is checked here
// headless: curves really are tangent-continuous, junction corners really are
// tangent fillets, every scene builds with no crossing errors, the lane graph
// is drivable, blocks close, and edit ops leave a valid network.
import { fitAlignment, evalAlignment } from "../v3/roads/roadAlignment.js";
import { resolveStack, layoutAt, layoutEdges, makeSection } from "../v3/roads/roadCrossSection.js";
import { buildRoadNetwork } from "../v3/roads/roadNetwork.js";
import { SCENES } from "../v3/roads/roadScenes.js";
import { terrainFn } from "../v3/roads/roadTerrain.js";
import { emptyNetwork, addNode, addRoad, insertJunction, reverseRoad, findRoad, dissolveNode } from "../v3/roads/roadEdit.js";
import { TrafficSim } from "../v3/roads/roadTraffic.js";
import { polygonArea, wrapPi, pointInPolygon } from "../v3/roads/roadMath.js";

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};
const build = (data) => buildRoadNetwork(data, { ground: terrainFn(data.terrain) });

console.log("— alignment —");
{
  const al = fitAlignment([{ x: 0, z: 0 }, { x: 100, z: 0, r: 30 }, { x: 100, z: 100 }]);
  const expected = 200 - 2 * 30 + (30 * Math.PI) / 2;
  check("90° arc length is exact", Math.abs(al.length - expected) < 1e-6, `${al.length.toFixed(4)} vs ${expected.toFixed(4)}`);
  check("ends on the last point", al.endError < 1e-6);
  let worst = 0;
  for (let i = 1; i < al.segments.length; i++) {
    const s = al.segments[i].s0;
    worst = Math.max(worst, Math.abs(wrapPi(evalAlignment(al, s - 1e-7).th - evalAlignment(al, s + 1e-7).th)));
  }
  check("tangent-continuous at every joint", worst < 1e-5, worst.toExponential(2));
  check("right bend has k > 0", al.segments.some((sg) => sg.type === "arc" && sg.k0 > 0));
}
{
  const al = fitAlignment([{ x: 0, z: 0 }, { x: 400, z: 0, r: 300, ls: 80 }, { x: 600, z: -300 }]);
  const kinds = al.segments.map((s) => s.type).join(",");
  check("spiral-arc-spiral generated", kinds === "line,spiral,arc,spiral,line", kinds);
  let jump = 0;
  for (let i = 1; i < al.segments.length; i++) jump = Math.max(jump, Math.abs(al.segments[i - 1].k1 - al.segments[i].k0));
  check("curvature continuous with spirals", jump < 1e-9);
  check("spiral end lands on the tangent (end error < 1 cm)", al.endError < 0.01, al.endError.toExponential(2));
}
{
  const al = fitAlignment([{ x: 0, z: 0 }, { x: 50, z: 0, r: 200 }, { x: 50, z: 50 }]);
  check("oversized radius is clamped to fit the legs", al.vertices[0].clamped && al.vertices[0].R < 60, al.vertices[0].R.toFixed(1));
}

console.log("— cross-section —");
{
  const road = { type: "local", sections: [makeSection("leftPocket", "end", "s1")] };
  const st = resolveStack(road);
  const L = 200;
  const e0 = layoutEdges(layoutAt(st, 0, L)), e1 = layoutEdges(layoutAt(st, L, L));
  check("local street is 15.4 m property to property", Math.abs(e0.propL - e0.propR - 15.4) < 1e-6, (e0.propL - e0.propR).toFixed(2));
  check("pocket widens the far end by 3 m", Math.abs((e1.propL - e1.propR) - (e0.propL - e0.propR) - 3) < 1e-6);
  let jump = 0, prev = null;
  for (let s = 0; s <= L; s += 0.5) {
    const w = layoutEdges(layoutAt(st, s, L)).propR;
    if (prev != null) jump = Math.max(jump, Math.abs(w - prev));
    prev = w;
  }
  check("taper is continuous (no width jump > 0.3 m per 0.5 m)", jump < 0.3, jump.toFixed(3));
}

console.log("— four-way junction —");
{
  const d = emptyNetwork();
  const c = addNode(d, 0, 0);
  const ends = [[150, 0], [0, 150], [-150, 0], [0, -150]].map(([x, z]) => addNode(d, x, z));
  for (const e of ends) addRoad(d, c, e, "local");
  const res = build(d);
  const node = res.nodesById.get(c);
  check("kind is junction", node.kind === "junction", node.kind);
  check("every arm trimmed back past the curb return", node.arms.every((a) => a.trim > 7), node.arms.map((a) => a.trim.toFixed(1)).join(" "));
  const fillets = node.corners.filter((k) => k.curb.kind === "fillet").length;
  check("four fillet corners", fillets === 4, String(fillets));
  // Fillet tangency: the first arc point lies on arm i's curb line.
  const k0 = node.corners[0], a0 = node.arms[0];
  const p = k0.curb.pts[0];
  const lat = (p[0] - a0.ox) * a0.nx + (p[1] - a0.oz) * a0.nz;
  check("fillet starts ON the curb line", Math.abs(lat - a0.edges.curbR) < 1e-6, `${lat.toFixed(4)} vs ${a0.edges.curbR}`);
  check("pad polygon has area", Math.abs(polygonArea(node.pad)) > 200);
  check("12 connectors (L/S/R from each of 4 single-lane approaches)", node.connectors.length === 12, String(node.connectors.length));
  check("4 corner sidewalks", node.sidewalks.length === 4);
}

console.log("— one block —");
{
  const d = emptyNetwork();
  const n = [[0, 0], [200, 0], [200, 200], [0, 200]].map(([x, z]) => addNode(d, x, z));
  for (let i = 0; i < 4; i++) addRoad(d, n[i], n[(i + 1) % 4], "local");
  const res = build(d);
  check("exactly one block", res.blocks.length === 1, String(res.blocks.length));
  const A = res.blocks[0]?.area ?? 0;
  const inner = (200 - 15.4) ** 2;
  check("block ≈ square minus the road widths (curb returns cut corners)", A < inner && A > inner * 0.97, `${A.toFixed(0)} m² vs ${inner.toFixed(0)}`);
  check("block subdivided into lots", res.blocks[0].lots.length > 10, String(res.blocks[0].lots.length));
  const lotSum = res.blocks[0].lots.reduce((s, l) => s + l.area, 0);
  check("lots tile the block", Math.abs(lotSum - A) / A < 0.02, `${lotSum.toFixed(0)} vs ${A.toFixed(0)}`);
}

console.log("— scenes —");
const finite = (pts) => pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
for (const [key, sc] of Object.entries(SCENES)) {
  const data = sc.build();
  let res;
  try { res = build(data); } catch (e) { check(`${key} builds`, false, e.stack); continue; }
  const errors = res.issues.filter((i) => i.level === "error");
  check(`${key}: builds in ${res.stats.ms.toFixed(1)} ms with no errors`, errors.length === 0, errors.map((e) => e.msg).slice(0, 3).join(" | "));
  let bad = 0;
  for (const rr of res.roads) {
    if (!finite(rr.carriage)) bad++;
    for (const s of rr.strips) if (!finite(s.poly)) bad++;
    for (const l of rr.lines) if (!finite(l.pts)) bad++;
  }
  for (const nd of res.nodes) {
    if (nd.pad && !finite(nd.pad)) bad++;
    for (const m of nd.markings) if (!finite(m.pts || m.poly)) bad++;
  }
  check(`${key}: no NaN geometry`, bad === 0, String(bad));
  // Junction geometry is built from arm frames; the road must really arrive
  // along them (a smooth joint at the far end once bent roads 5° off).
  let worstArm = 0;
  for (const rr of res.roads) {
    worstArm = Math.max(worstArm,
      Math.abs(wrapPi(rr.al.startHeading - rr.armA.th)),
      Math.abs(wrapPi(rr.al.endHeading + Math.PI - rr.armB.th)));
  }
  check(`${key}: roads arrive along their junction arms`, worstArm < 1e-3, `${((worstArm * 180) / Math.PI).toFixed(2)}°`);
  // Crosswalk stripes centred between the curbs (undivided arms).
  let offCentre = 0;
  for (const nd of res.nodes) {
    for (const a of nd.arms) {
      if (!a.crosswalk || a.cw > 0.3) continue;
      let lo = Infinity, hi = -Infinity;
      for (const m of nd.markings) {
        if (m.tag !== "zebra" || m.arm !== a) continue;
        for (const p of m.pts) {
          const t = (p[0] - a.ox) * a.nx + (p[1] - a.oz) * a.nz;
          lo = Math.min(lo, t); hi = Math.max(hi, t);
        }
      }
      if (!isFinite(lo)) continue;
      offCentre = Math.max(offCentre, Math.abs((lo - a.edges.curbR) - (a.edges.curbL - hi)));
    }
  }
  check(`${key}: crosswalk stripes centred between curbs`, offCentre < 0.01, `${offCentre.toFixed(3)} m`);
  // Every painted shape at a node (stop/yield lines, zebras, arrows) lies on
  // pavement. Corners are pulled 10 cm inward: paint may END on a curb line.
  {
    const onPave = (p) => res.nodes.some((n) => n.pad && pointInPolygon(p[0], p[1], n.pad))
      || res.roads.some((r) => pointInPolygon(p[0], p[1], r.carriage));
    let off = 0, total = 0;
    for (const nd of res.nodes) {
      for (const m of nd.markings) {
        if (m.kind !== "poly") continue;
        total++;
        const cx = m.pts.reduce((s, p) => s + p[0], 0) / m.pts.length;
        const cz = m.pts.reduce((s, p) => s + p[1], 0) / m.pts.length;
        const inset = m.pts.map((p) => {
          const dx = cx - p[0], dz = cz - p[1], d = Math.hypot(dx, dz) || 1;
          const kk = Math.min(0.1, d * 0.5) / d;
          return [p[0] + dx * kk, p[1] + dz * kk];
        });
        if (inset.some((p) => !onPave(p))) off++;
      }
    }
    check(`${key}: all ${total} painted shapes lie on pavement`, off === 0, `${off} off`);
  }
  // Roundabout give-way teeth: on the ARRIVING side of their own entry only.
  {
    let wrongSide = 0, bare = 0;
    for (const nd of res.nodes.filter((n) => n.kind === "roundabout")) {
      for (const a of nd.arms) {
        if (!a.approach.length) continue;
        let own = 0;
        for (const m of nd.markings) {
          if (m.kind !== "poly" || m.pts.length !== 3) continue;
          const [cx, cz] = [(m.pts[0][0] + m.pts[1][0] + m.pts[2][0]) / 3, (m.pts[0][1] + m.pts[1][1] + m.pts[2][1]) / 3];
          const sg = (cx - a.ox) * a.dx + (cz - a.oz) * a.dz;
          const t = (cx - a.ox) * a.nx + (cz - a.oz) * a.nz;
          if (sg < nd.ring.Ro - 2 || sg > nd.ring.Ro + 4 || Math.abs(t) > a.edges.curbL + 6) continue;
          if (t < 0) wrongSide++; else own++;
        }
        if (own < 2) bare++;
      }
    }
    if (res.nodes.some((n) => n.kind === "roundabout")) {
      check(`${key}: give-way teeth only on arriving half, every entry has them`, wrongSide === 0 && bare === 0, `${wrongSide} wrong side, ${bare} bare entries`);
    }
  }
  const lanes = res.graph.paths.filter((p) => p.kind === "lane");
  const deadEnds = lanes.filter((p) => !p.next.length && !p.exit).length;
  check(`${key}: every lane piece leads somewhere`, deadEnds === 0, `${deadEnds} of ${lanes.length}`);
  const sim = new TrafficSim(res, { count: 60, seed: 3 });
  for (let i = 0; i < 600; i++) sim.step(1 / 30);
  const moving = sim.cars.filter((c) => c.v > 0.5).length;
  const nan = sim.cars.some((c) => !Number.isFinite(c.x) || !Number.isFinite(c.z));
  check(`${key}: traffic runs 20 s (${moving}/60 moving)`, !nan && moving > 10);
  console.log(`      ${JSON.stringify({ roads: res.stats.roads, junctions: res.stats.junctions, roundabouts: res.stats.roundabouts, splits: res.stats.splits, blocks: res.stats.blocks, lots: res.stats.lots, props: res.stats.props, overpasses: res.stats.overpasses, warn: res.issues.filter((i) => i.level === "warn").length })}`);

  if (key === "downtown") {
    check("downtown: blocks found", res.blocks.length >= 14, String(res.blocks.length));
    const six = res.nodes.filter((n) => n.arms.length >= 5).length;
    check("downtown: the diagonal makes 5+ arm junctions", six >= 1, String(six));
    const sig = res.nodes.filter((n) => n.control === "signal").length;
    check("downtown: signalised junctions exist", sig >= 2, String(sig));
  }
  if (key === "interchange") {
    check("interchange: avenue passes under both carriageways", res.stats.overpasses >= 2, String(res.stats.overpasses));
    check("interchange: four splits/merges", res.stats.splits === 4, String(res.stats.splits));
    // Reach the off-ramp's terminal from the motorway entry lanes.
    const start = res.graph.paths.filter((p) => p.kind === "lane" && p.roadId === data.roads[0].id);
    const J1 = res.nodes.find((n) => n.kind === "junction" && n.z > 50);
    const seen = new Set(start.map((p) => p.id));
    const queue = [...seen];
    let reached = false;
    while (queue.length) {
      const p = res.graph.byId.get(queue.shift());
      if (p.nodeId === J1.id) { reached = true; break; }
      for (const n of p.next) if (!seen.has(n)) { seen.add(n); queue.push(n); }
    }
    check("interchange: motorway lanes reach the ramp terminal junction", reached);
    const main = res.roadsById.get(data.roads[1].id);
    check("interchange: mainline bridge detected", main.bridges.length >= 1);
    check("interchange: piers placed, none inside the avenue", res.structures.filter((s) => s.kind === "pier").length >= 2);
  }
  if (key === "roundabouts") {
    const ring = res.nodes.filter((n) => n.kind === "roundabout");
    check("roundabouts: rings built with islands", ring.every((n) => n.ring && n.islands.length >= 2));
    check("roundabouts: ring connectors exist", ring.every((n) => n.connectors.length >= 6), ring.map((n) => n.connectors.length).join(","));
  }
  if (key === "hillRoad") {
    const r = res.roads[0];
    check("hillRoad: terrain-following profile", r.prof.mode === "terrain" && Math.abs(r.prof.maxGrade) <= r.type.maxGrade + 0.006, (r.prof.maxGrade * 100).toFixed(2) + " %");
  }
}

console.log("— lines stop at crossings —");
{
  // No painted line (lane, centre, edge, bike...) runs through a zebra bar.
  for (const [key, def] of Object.entries(SCENES)) {
    const r = build(def.build());
    const bars = [];
    for (const n of r.nodes) for (const m of n.markings) if (m.tag === "zebra") bars.push(m.pts);
    let hits = 0;
    const where = [];
    for (const rr of r.roads) {
      for (const l of rr.lines) {
        for (let i = 1; i < l.pts.length; i++) {
          const a = l.pts[i - 1], b = l.pts[i];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          for (let d = 0; d <= len; d += 0.2) {
            const x = a[0] + ((b[0] - a[0]) * d) / (len || 1), z = a[1] + ((b[1] - a[1]) * d) / (len || 1);
            if (bars.some((p) => pointInPolygon(x, z, p))) { hits++; if (where.length < 2) where.push(`${rr.id} ${l.mark || "line"}`); break; }
          }
        }
      }
    }
    check(`${key}: no line runs through a crosswalk`, hits === 0, `${hits} crossings ${where.join(", ")}`);
  }
}

console.log("— edit ops —");
{
  const d = emptyNetwork();
  const a = addNode(d, -100, 0), b = addNode(d, 100, 0), c = addNode(d, 0, -100), e = addNode(d, 0, 100);
  const r1 = addRoad(d, a, b, "local"), r2 = addRoad(d, c, e, "collector");
  let res = build(d);
  const cross = res.issues.find((i) => i.code === "crossing");
  check("crossing without junction is reported with a fix", !!cross?.fix);
  insertJunction(d, r1, r2, cross.fix.x, cross.fix.z, res);
  res = build(d);
  check("insertJunction clears the error", !res.issues.some((i) => i.code === "crossing"));
  check("…and creates one 4-arm junction", res.nodes.filter((n) => n.kind === "junction" && n.arms.length === 4).length === 1);
  const before = JSON.stringify(findRoad(d, r1));
  reverseRoad(d, r1); reverseRoad(d, r1);
  check("reverseRoad twice is identity", JSON.stringify(findRoad(d, r1)) === before);
}
{
  const d = emptyNetwork();
  const a = addNode(d, 0, 0), m = addNode(d, 100, 10), b = addNode(d, 200, 0);
  addRoad(d, a, m, "local"); addRoad(d, m, b, "local");
  const res = build(d);
  check("gentle degree-2 node is a smooth continuation", res.nodesById.get(m).kind === "continuation");
  const r0 = res.roads[0], r1 = res.roads[1];
  const dh = Math.abs(wrapPi(r0.al.endHeading - r1.al.startHeading));
  check("…with matching headings", dh < 1e-6, dh.toExponential(2));
  dissolveNode(d, m);
  check("dissolveNode merges into one road", d.roads.length === 1 && d.roads[0].pts.length === 1);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
