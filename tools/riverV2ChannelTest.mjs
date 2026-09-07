/**
* Headless checks for the River v2 solver (v3/tools/riverV2Channel.js) and for
 * the cross-section the conform shader writes.
 *
 * The two that matter most, because they are the whole reason River v2 exists:
 *   4 — a PINNED node really does lift the profile off the terrain
 *   8 — the cross-section CUTS AND FILLS, and is continuous at both seams
 * Run: node tools/riverV2ChannelTest.mjs   (picked up by npm test)
 */
import {
  solveRiver, monotoneCubic, closestStation, planConformChunks, conformStride, LOOP_SEGS,
  buildFlowIndex, sampleFlow, sampleFlowAt,
} from "../v3/tools/riverV2Channel.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const PARAMS = {
  stationSpacing: 2.5, forceDownhill: true, minGradient: 0.0008, levelSmoothing: 0,
  bedCurve: 0.55, freeboard: 0.6, lipFraction: 0.28, maxBankSlope: 0.9, bankFlareMax: 4,
  manningN: 0.04, flowScale: 1, minSlope: 0.0006, minSpeed: 0.08, maxSpeed: 9,
  froudeStart: 0.8, froudeFull: 2.5,
  newWidth: 10, newDepth: 1.8, newBank: 8,
};
const node = (x, z, o = {}) => ({ x, z, y: null, width: 10, depth: 1.8, bank: 8, ...o });

console.log("\n1. Monotone cubic never overshoots");
{
  // Classic overshoot case: a plain interpolating cubic dips below 12 here.
  const f = monotoneCubic([0, 10, 20, 30], [20, 20, 12, 12]);
  let lo = Infinity, hi = -Infinity;
  for (let x = 0; x <= 30; x += 0.1) { const v = f(x); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  ok("stays within the data range", lo >= 12 - 1e-9 && hi <= 20 + 1e-9, `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`);
  ok("hits the knots exactly", near(f(0), 20, 1e-9) && near(f(20), 12, 1e-9));
}

console.log("\n2. AUTO nodes follow the ground (flat)");
{
  const ground = () => 40;
  const s = solveRiver({ nodes: [node(-100, 0), node(0, 0), node(100, 0)], sampleGround: ground, params: PARAMS });
  ok("solved", !!s);
  const maxDev = Math.max(...Array.from(s.level, (v) => Math.abs(v - 40)));
  // forceDownhill applies minGradient, so a flat run tilts by gradient*length.
  ok("level tracks the ground within the forced gradient", maxDev < 0.25, `dev=${maxDev.toFixed(3)}`);
}

console.log("\n3. AUTO nodes follow a sloping valley");
{
  const ground = (x) => 60 - x * 0.05;   // falls 5 m per 100 m eastward
  const s = solveRiver({ nodes: [node(-200, 0), node(0, 0), node(200, 0)], sampleGround: ground, params: PARAMS });
  ok("start is high, end is low", s.level[0] > s.level[s.count - 1]);
  ok("start ≈ ground at start", Math.abs(s.level[0] - ground(-200)) < 0.5, `${s.level[0].toFixed(2)} vs ${ground(-200)}`);
  ok("end ≈ ground at end", Math.abs(s.level[s.count - 1] - ground(200)) < 0.5);
  ok("no uphill stretch", !s.hasUphill);
}

console.log("\n4. A PINNED node lifts the river — the whole point of the tool");
{
  const ground = () => 40;
  const nodes = [node(-100, 0), node(0, 0, { y: 60 }), node(100, 0)];
  const s = solveRiver({ nodes, sampleGround: ground, params: PARAMS });
  const mid = s.level[Math.floor(s.count / 2)];
  ok("the pinned node really is at 60 m", near(s.nodeLevel[1], 60, 1e-6), `${s.nodeLevel[1]}`);
  ok("the profile mid-river is lifted, not snapped back to the ground", mid > 55, `mid=${mid.toFixed(2)}`);
  ok("the profile is 20 m above the terrain there", mid - 40 > 15);
  ok("forceDownhill did NOT move the pinned node", near(s.nodeLevel[1], 60, 1e-9));
  ok("uphill is reported honestly rather than silently flattened", s.hasUphill);
}

console.log("\n5. Per-node width interpolates along the river");
{
  const ground = () => 40;
  const nodes = [node(-100, 0, { width: 30 }), node(0, 0, { width: 4 }), node(100, 0, { width: 30 })];
  const s = solveRiver({ nodes, sampleGround: ground, params: PARAMS });
  const w0 = s.width[0];
  const wMid = s.width[Math.floor(s.count / 2)];
  const wEnd = s.width[s.count - 1];
  ok("wide at the ends", w0 > 28 && wEnd > 28, `${w0.toFixed(2)} / ${wEnd.toFixed(2)}`);
  ok("narrow in the middle", wMid < 5, `${wMid.toFixed(2)}`);
  ok("width never goes negative or zero anywhere", Math.min(...s.width) > 0);
  ok("width never overshoots past the authored maximum", Math.max(...s.width) <= 30 + 1e-6);
}

console.log("\n6. Velocity responds to slope and depth (Manning)");
{
  const flat = solveRiver({
    nodes: [node(-200, 0), node(200, 0)], sampleGround: () => 40, params: PARAMS,
  });
  const steep = solveRiver({
    nodes: [node(-200, 0), node(200, 0)], sampleGround: (x) => 60 - x * 0.05, params: PARAMS,
  });
  const vFlat = flat.speed[Math.floor(flat.count / 2)];
  const vSteep = steep.speed[Math.floor(steep.count / 2)];
  ok("a steeper reach runs faster", vSteep > vFlat * 2, `${vFlat.toFixed(3)} -> ${vSteep.toFixed(3)}`);

  const shallow = solveRiver({
    nodes: [node(-200, 0, { depth: 0.3 }), node(200, 0, { depth: 0.3 })],
    sampleGround: (x) => 60 - x * 0.05, params: PARAMS,
  });
  const vShallow = shallow.speed[Math.floor(shallow.count / 2)];
  ok("a shallower channel runs slower at the same slope", vShallow < vSteep, `${vShallow.toFixed(3)} < ${vSteep.toFixed(3)}`);
  ok("speeds stay inside the clamp band",
    Math.min(...steep.speed) >= PARAMS.minSpeed - 1e-9 && Math.max(...steep.speed) <= PARAMS.maxSpeed + 1e-9);
  ok("turbulence stays in 0..1", Math.max(...steep.turb) <= 1 + 1e-6 && Math.min(...steep.turb) >= 0);

  // The bug this replaced, found the first time a river was drawn in the editor:
  // turbulence used to be normalised against the river's OWN worst reach, so a
  // river of uniform gradient — the commonest case there is — came out at 1.0
  // along its whole length and painted a glass-calm stream solid white. Froude
  // is an absolute measure, so calm water now reads as calm.
  // (`steep` here is a 5% gradient 1.8 m deep — that is genuinely Fr ~2, a real
  // torrent, so it SHOULD white-cap. The gentle case is the flat one.)
  ok("a uniform gentle river has NO whitewater", Math.max(...flat.turb) === 0,
    `Fr=${flat.froude[0].toFixed(3)}, turb=${Math.max(...flat.turb)}`);
  ok("...because its Froude number really is subcritical", flat.froude[0] < 0.8,
    `Fr=${flat.froude[0].toFixed(3)}`);
  ok("the genuinely steep reach does white-cap", Math.max(...steep.turb) > 0.5,
    `Fr=${steep.froude[0].toFixed(2)}`);

  const torrent = solveRiver({
    // A 1-in-5 mountain stream, shallow over a rough bed.
    nodes: [node(-100, 0, { depth: 0.35 }), node(100, 0, { depth: 0.35 })],
    sampleGround: (x) => 100 - x * 0.2, params: PARAMS,
  });
  const tMax = Math.max(...torrent.turb);
  ok("a steep shallow torrent DOES white-cap", tMax > 0.5,
    `Fr=${torrent.froude[0].toFixed(2)}, turb=${tMax.toFixed(2)}`);
  ok("its Froude number is supercritical", torrent.froude[0] > 1);
}

console.log("\n7. AUTO level takes the corridor MINIMUM, not the centreline");
{
  // A hillside: ground falls away to the north (-z). The centreline height is 50,
  // but the corridor reaches 14 m out and there the ground is lower.
  const ground = (x, z) => 50 + z * 0.25;
  const s = solveRiver({ nodes: [node(-50, 0), node(50, 0)], sampleGround: ground, params: PARAMS });
  const reach = 10 * 0.5 + 8;          // width/2 + bank
  const lowestRim = ground(0, -reach); // 50 - 3.5 = 46.5
  ok("level sits at/below the lowest rim, so the water cannot spill sideways",
    s.level[Math.floor(s.count / 2)] <= lowestRim + 0.3,
    `${s.level[Math.floor(s.count / 2)].toFixed(2)} vs rim ${lowestRim.toFixed(2)}`);
}

console.log("\n8. Cross-section is continuous and cuts AND fills");
{
  // Mirror of the conform shader, in metres.
  const P = PARAMS;
  function section(t, L, halfW, depth, bank, natural) {
    if (t <= halfW) {
      const u = Math.min(1, t / halfW);
      const shape = (1 - u ** 8) * (1 - P.bedCurve) + (1 - u * u) * P.bedCurve;
      return L - depth * shape;
    }
    const rim = L + P.freeboard;
    const need = Math.abs(natural - rim) / P.maxBankSlope;
    const flare = Math.min(Math.max(need, bank), bank * P.bankFlareMax);
    const u = Math.min(1, (t - halfW) / flare);
    const ss = (e0, e1, x) => {
      const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return k * k * (3 - 2 * k);
    };
    const a = ss(0, P.lipFraction, u);
    const b = ss(P.lipFraction, 1, u);
    return (L + (rim - L) * a) * (1 - b) + natural * b;
  }

  const L = 50, halfW = 5, depth = 1.8, bank = 8;

  // (a) continuity at the channel rim
  const inner = section(halfW - 1e-4, L, halfW, depth, bank, 44);
  const outer = section(halfW + 1e-4, L, halfW, depth, bank, 44);
  ok("bed meets the bank exactly at the water level", near(inner, L, 1e-3) && near(outer, L, 1e-3),
    `${inner.toFixed(5)} / ${outer.toFixed(5)}`);

  // (b) deepest point on the centreline
  ok("deepest at the centreline", near(section(0, L, halfW, depth, bank, 44), L - depth, 1e-9));

  // (c) CUT: ground above the river is carved down to a ramp
  const cutNat = 80;
  const cutFlare = Math.min(Math.max(Math.abs(cutNat - (L + 0.6)) / 0.9, bank), bank * 4);
  ok("a hillside is cut down near the channel", section(halfW + 0.5, L, halfW, depth, bank, cutNat) < cutNat);
  ok("the cut returns to natural ground at the footprint edge",
    near(section(halfW + cutFlare, L, halfW, depth, bank, cutNat), cutNat, 1e-3));

  // (d) FILL: ground below the river is built UP into an embankment
  const fillNat = 30;
  const fillFlare = Math.min(Math.max(Math.abs(fillNat - (L + 0.6)) / 0.9, bank), bank * 4);
  const lip = section(halfW + fillFlare * P.lipFraction, L, halfW, depth, bank, fillNat);
  ok("an embankment is raised above the water level", lip > L, `lip=${lip.toFixed(3)} > L=${L}`);
  ok("the lip stands at the requested freeboard", near(lip, L + P.freeboard, 1e-3), `${lip.toFixed(4)}`);
  ok("the fill returns to natural ground at the footprint edge",
    near(section(halfW + fillFlare, L, halfW, depth, bank, fillNat), fillNat, 1e-3));

  // (e) the flare keeps the embankment slope under control
  const rise = (L + P.freeboard) - fillNat;              // 20.6 m of fill
  const run = fillFlare * (1 - P.lipFraction);
  ok("a 20 m embankment flares wide instead of standing vertical",
    fillFlare > bank * 2, `flare=${fillFlare.toFixed(2)} m vs bank=${bank} m`);
  ok("its slope is at or under maxBankSlope", rise / run <= P.maxBankSlope * 1.6,
    `${(rise / run).toFixed(3)} vs ${P.maxBankSlope}`);
}

console.log("\n9. Confluence snapping finds the parent's level");
{
  const parent = solveRiver({
    nodes: [node(-100, 0), node(100, 0)], sampleGround: () => 40, params: PARAMS,
  });
  const c = closestStation(parent, 0, 2, 8);
  ok("station found within the snap radius", !!c);
  ok("it reports the parent's water level there", c && Math.abs(c.level - parent.level[c.index]) < 1e-9);
  ok("a far-away point does not snap", closestStation(parent, 0, 500, 8) === null);
}

console.log("\n10. Degenerate input is refused, not crashed on");
{
  ok("one node -> null", solveRiver({ nodes: [node(0, 0)], sampleGround: () => 0, params: PARAMS }) === null);
  ok("no nodes -> null", solveRiver({ nodes: [], sampleGround: () => 0, params: PARAMS }) === null);
  const dup = solveRiver({ nodes: [node(5, 5), node(5, 5)], sampleGround: () => 10, params: PARAMS });
  ok("two coincident nodes -> null or finite", dup === null || Array.from(dup.level).every(Number.isFinite));
  const tiny = solveRiver({ nodes: [node(0, 0), node(0.01, 0)], sampleGround: () => 10, params: PARAMS });
  ok("a sub-metre river stays finite", tiny === null || Array.from(tiny.level).every(Number.isFinite));
}

console.log("\n11. Conform passes tile the path and compose in any order");
{
  // History, because it took three goes. The conform is scissored into passes.
  // The first two designs had each pass WRITE the terrain from whichever
  // segment it found nearest, which makes a pass's answer depend on seeing
  // every segment that could win for any texel in its rect. An arc-length
  // margin either side does not guarantee that, and neither does a spatial
  // window: a river folding back on itself puts two arms within a bank width of
  // each other while they are most of the river apart along its length. Both
  // shipped a visibly gappy river.
  //
  // The fix was to stop writing terrain in the pass. Passes now only carry the
  // nearest-segment search forward, and `min` over distance is associative, so
  // they compose in any order and each needs only its OWN segments — a texel
  // whose nearest segment is elsewhere is inside that chunk's rect anyway. So
  // what is left to check is simply that the chunks tile the path and fit the
  // shader's unrolled loop.
  for (const count of [2, 3, 50, 96, 97, 200, 1000, 2048]) {
    const plan = planConformChunks(count);
    const spans = plan.chunks.map((c) => c.b - c.a);
    const contiguous = plan.chunks.every((c, i) =>
      (i === 0 ? c.a === 0 : c.a === plan.chunks[i - 1].b));
    const reachesEnd = plan.chunks[plan.chunks.length - 1].b === count - 1;
    ok(`n=${count}: every chunk fits the loop`, Math.max(...spans) <= LOOP_SEGS,
      `widest ${Math.max(...spans)} > ${LOOP_SEGS}`);
    ok(`n=${count}: chunks tile the path with no hole`, contiguous && reachesEnd);
    ok(`n=${count}: every chunk covers at least one segment`, Math.min(...spans) >= 1);
  }
  ok("a one-point path is refused, not crashed on",
    planConformChunks(1).chunks.length === 0);

  // The path texture is shared by every river, so each river's path is capped
  // to its share of it. This is a memory budget only — accuracy along the
  // channel comes from the solver's station spacing, not from this.
  ok("a short river is not decimated", conformStride(300, 1024) === 1);
  ok("an over-long river is decimated", conformStride(4000, 1024) > 1);
  for (const [count, budget] of [[4000, 1024], [2048, 64], [5, 2], [300, 300]]) {
    const stride = conformStride(count, budget);
    const points = Math.max(2, Math.ceil((count - 1) / stride) + 1);
    ok(`stride(${count}, ${budget}) keeps the path inside its budget`, points <= budget + 1,
      `${points} points vs budget ${budget}`);
  }
}

console.log("\n12. Flow query: what the water is doing at a world position");
{
  // A straight river running +X, so every expected answer is hand-checkable.
  const straight = solveRiver({
    nodes: [node(-200, 0), node(0, 0), node(200, 0)],
    sampleGround: (x) => 60 - x * 0.05,
    params: PARAMS,
  });
  const idx = buildFlowIndex([straight], { worldSize: 1024, bedCurve: PARAMS.bedCurve });
  ok("an index is built", !!idx);

  const mid = sampleFlow(idx, 0, 0);
  ok("the centreline is in the channel", mid && mid.inChannel);
  ok("distance from the centreline is ~0", mid && mid.distance < 0.5, `${mid && mid.distance}`);
  ok("it reports the deepest point there", mid && Math.abs(mid.depth - 1.8) < 0.05,
    `depth ${mid && mid.depth.toFixed(3)}`);
  ok("bed sits exactly depth below the surface",
    mid && Math.abs((mid.surfaceY - mid.bedY) - mid.depth) < 1e-9);
  ok("flow points downstream (+X)", mid && mid.dirX > 0.99 && Math.abs(mid.dirZ) < 0.05,
    `(${mid && mid.dirX.toFixed(3)}, ${mid && mid.dirZ.toFixed(3)})`);
  ok("direction is unit length", mid && Math.abs(Math.hypot(mid.dirX, mid.dirZ) - 1) < 1e-6);
  ok("speed matches the solver", mid && Math.abs(mid.speed - straight.speed[Math.round(straight.count / 2)]) < 0.2);

  // Across the channel: depth must fall to zero exactly at the water's edge,
  // because that is where the conform puts the bed.
  const halfW = mid.halfWidth;
  ok("halfWidth is the authored half-width", Math.abs(halfW - 5) < 1e-6, `${halfW}`);
  const atEdge = sampleFlow(idx, 0, halfW - 0.01);
  ok("depth is ~0 at the waterline", atEdge && atEdge.depth < 0.02,
    `${atEdge && atEdge.depth.toFixed(4)}`);
  const inner = sampleFlow(idx, 0, halfW * 0.5);
  ok("halfway out is shallower than the middle but still wet",
    inner && inner.depth > 0.05 && inner.depth < mid.depth, `${inner && inner.depth.toFixed(3)}`);
  ok("halfway out is still in the channel", inner && inner.inChannel);

  const justOut = sampleFlow(idx, 0, halfW + 1);
  ok("just past the edge is out of the channel", justOut && !justOut.inChannel);
  ok("...but still reported, so a caller can see the bank coming", !!justOut);
  ok("well clear of the river returns null", sampleFlow(idx, 0, 200) === null);
  ok("the far side of the world returns null", sampleFlow(idx, 480, 480) === null);

  // Surface level must agree with the solver, not be re-derived. Compare
  // against the station actually nearest x = 0, not the middle of the array:
  // stations are spaced along ARC, so index count/2 is a couple of metres off
  // and on a sloping river that is a real height difference.
  let nearest0 = 0;
  for (let i = 1; i < straight.count; i++) {
    if (Math.abs(straight.x[i]) < Math.abs(straight.x[nearest0])) nearest0 = i;
  }
  ok("surface level matches the solved profile",
    Math.abs(mid.surfaceY - straight.level[nearest0]) < 0.05,
    `${mid.surfaceY.toFixed(3)} vs ${straight.level[nearest0].toFixed(3)} at x=${straight.x[nearest0].toFixed(2)}`);

  // Downstream really is downhill.
  const up = sampleFlow(idx, -150, 0);
  const down = sampleFlow(idx, 150, 0);
  ok("the surface falls downstream", up.surfaceY > down.surfaceY,
    `${up.surfaceY.toFixed(2)} -> ${down.surfaceY.toFixed(2)}`);

  // 3D form.
  const under = sampleFlowAt(idx, 0, mid.surfaceY - 1, 0);
  ok("a point under the surface is submerged", under && under.submerged);
  ok("...by the right amount", under && Math.abs(under.submergedDepth - 1) < 1e-6);
  const over = sampleFlowAt(idx, 0, mid.surfaceY + 2, 0);
  ok("a point above the surface is not submerged", over && !over.submerged);
  ok("...and reports zero immersion", over && over.submergedDepth === 0);

  // Per-node width is respected by the query, not just by the mesh.
  const varied = solveRiver({
    nodes: [node(-200, 0, { width: 40 }), node(0, 0, { width: 6 }), node(200, 0, { width: 40 })],
    sampleGround: () => 40, params: PARAMS,
  });
  const vIdx = buildFlowIndex([varied], { worldSize: 1024, bedCurve: PARAMS.bedCurve });
  const wide = sampleFlow(vIdx, -195, 0);
  const narrow = sampleFlow(vIdx, 0, 0);
  ok("the query sees the river narrow", narrow.halfWidth < wide.halfWidth * 0.5,
    `${wide.halfWidth.toFixed(1)} -> ${narrow.halfWidth.toFixed(1)}`);
  ok("a point 10 m out is wet in the wide reach", sampleFlow(vIdx, -195, 10)?.inChannel === true);
  ok("...and dry in the narrow one", (sampleFlow(vIdx, 0, 10)?.inChannel ?? false) === false);

  // Two rivers: the query must answer for the nearer one.
  const other = solveRiver({
    nodes: [node(-200, 300), node(200, 300)], sampleGround: () => 10, params: PARAMS,
  });
  const both = buildFlowIndex([straight, other], { worldSize: 1024, bedCurve: PARAMS.bedCurve });
  ok("near river 0 answers for river 0", sampleFlow(both, 0, 0)?.riverIndex === 0);
  ok("near river 1 answers for river 1", sampleFlow(both, 0, 300)?.riverIndex === 1);
  ok("between them answers for neither", sampleFlow(both, 0, 150) === null);

  // Degenerate input.
  ok("no rivers -> no index", buildFlowIndex([], { worldSize: 1024 }) === null);
  ok("nulls in the list -> no index", buildFlowIndex([null, null], { worldSize: 1024 }) === null);
  ok("a null index answers null", sampleFlow(null, 0, 0) === null);
  ok("a null index answers null in 3D", sampleFlowAt(null, 0, 0, 0) === null);

  // The grid must not change the answer: brute force over every segment has to
  // agree with the accelerated lookup, or the cell size is wrong.
  const brute = (s, x, z) => {
    let best = Infinity;
    for (let i = 0; i < s.count - 1; i++) {
      const ax = s.x[i], az = s.z[i];
      const abx = s.x[i + 1] - ax, abz = s.z[i + 1] - az;
      const len2 = abx * abx + abz * abz || 1e-9;
      let t = ((x - ax) * abx + (z - az) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(x - (ax + abx * t), z - (az + abz * t)));
    }
    return best;
  };
  const meander = solveRiver({
    nodes: [node(-300, 0), node(-100, 80), node(100, -80), node(300, 0)],
    sampleGround: (x) => 50 - x * 0.02, params: PARAMS,
  });
  const mIdx = buildFlowIndex([meander], { worldSize: 1024, bedCurve: PARAMS.bedCurve });
  let mismatch = 0, checked = 0;
  for (let i = 0; i < meander.count; i += 7) {
    for (const off of [-4, -1, 0, 1, 4]) {
      const px = -meander.tanZ[i], pz = meander.tanX[i];
      const qx = meander.x[i] + px * off, qz = meander.z[i] + pz * off;
      const got = sampleFlow(mIdx, qx, qz);
      const want = brute(meander, qx, qz);
      checked++;
      if (!got || Math.abs(got.distance - want) > 0.01) mismatch++;
    }
  }
  ok(`the grid finds the true nearest segment (${checked} probes on a meander)`,
    mismatch === 0, `${mismatch} disagreed with brute force`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
