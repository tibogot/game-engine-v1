// node games/thunderline/proto/piecesTest.mjs — every piece must end ON its exit node, level,
// pointing along the exit heading, for every parameter value and every entry heading.
import { FAMILIES, CELL, STEP, FWD, advance, toWorld, layout, predict, bankFor, turnCap } from "./pieces.js";

let fails = 0;
let checks = 0;
const fail = (m) => { fails++; console.log("FAIL", m); };

for (const [fam, F] of Object.entries(FAMILIES)) {
  const [s0, s1] = F.limits.size;
  const step = F.sizeStep ?? 1;
  const rises = F.limits.rise ? [F.limits.rise[0], 0, F.limits.rise[1]] : [0];
  const bends = fam === "road" ? [-1, 0, 1] : fam === "jump" ? [0] : [-1, 1];
  for (let size = s0; size <= s1; size += step)
    for (const rise of rises)
      for (const bend of bends)
        for (let h = 0; h < 4; h++) {
          const p = { ...F.defaults, size, rise, bend };
          const b = F.build(p);
          const entry = { x: 3, y: 10, z: -2, h };
          const exit = advance(entry, b.exit);
          const s = b.samples;
          const end = toWorld(entry, s[s.length - 1].p);
          const want = [exit.x * CELL, exit.y * STEP, exit.z * CELL];
          const err = Math.hypot(end[0] - want[0], end[1] - want[1], end[2] - want[2]);
          checks++;
          if (err > 1e-6) fail(`${fam} ${JSON.stringify(p)} h${h}: end off node by ${err.toFixed(4)} m`);
          const a = toWorld(entry, s[s.length - 2].p);
          const t = [end[0] - a[0], end[1] - a[1], end[2] - a[2]];
          const n = Math.hypot(t[0], t[2]); // heading only: slopes ease to level exactly at the node
          const f = FWD[exit.h];
          const dot = (t[0] * f[0] + t[2] * f[2]) / n;
          checks++;
          // a 2 m chord on an 8 m radius is 7° off the tangent
          if (dot < 0.99) fail(`${fam} ${JSON.stringify(p)} h${h}: exit tangent off heading (dot ${dot.toFixed(4)})`);
          const s0p = toWorld(entry, s[0].p);
          checks++;
          if (Math.hypot(s0p[0] - entry.x * CELL, s0p[1] - entry.y * STEP, s0p[2] - entry.z * CELL) > 1e-9) fail(`${fam} start off node`);
          if (Math.abs(s[s.length - 1].roll) > 1e-9) fail(`${fam} ends rolled`);
        }
}

// A small track: everything integer, a time comes out.
const track = {
  start: { x: 0, y: 20, z: 0, h: 0 },
  pieces: [
    { fam: "road", p: { size: 8 } },
    { fam: "bank", p: { size: 10, bend: 1 } },
    { fam: "jump", p: { size: 10, rise: -2, v: 50 } },
    { fam: "loop", p: { size: 24, bend: -1 } },
    { fam: "road", p: { size: 12, bend: -1, rise: 4 } },
  ],
};
const laid = layout(track);
const pr = predict(laid);
for (const L of laid) for (const k of ["x", "y", "z", "h"]) if (!Number.isInteger(L.exit[k])) fail("non-integer node");
console.log("track time", pr.total.toFixed(2), "s; per piece vIn/vMin km/h:",
  pr.perPiece.map((o) => `${Math.round(o.vIn * 3.6)}/${Math.round(o.vMin * 3.6)}${o.warn ? "!" : ""}`).join(" "));
console.log("bank angles (deg) r32..r256:", [32, 64, 96, 128, 192, 256].map((R) => `${R}:${(bankFor(R) * 180 / Math.PI).toFixed(0)}`).join(" "));
console.log("flat-turn caps (km/h):", [16, 32, 64, 128, 256].map((R) => `${R}:${Math.round(turnCap(R, 0) * 3.6)}`).join(" "));
console.log(`${checks} checks, ${fails} failures`);
process.exit(fails ? 1 : 0);
