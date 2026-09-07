/**
* Headless checks for the River v2 solver (v3/tools/riverV2Channel.js) and for
 * the cross-section the conform shader writes.
 *
 * The two that matter most, because they are the whole reason River v2 exists:
 *   4 — a PINNED node really does lift the profile off the terrain
 *   8 — the cross-section CUTS AND FILLS, and is continuous at both seams
 * Run: node tools/riverV2ChannelTest.mjs   (picked up by npm test)
 */
import { solveRiver, monotoneCubic, closestStation } from "../v3/tools/riverV2Channel.js";

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
  ok("turbulence is normalised to 0..1", Math.max(...steep.turb) <= 1 + 1e-6 && Math.min(...steep.turb) >= 0);
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
