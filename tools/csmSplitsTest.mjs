// Cascade splits (v3/app/csmSplits.js): where the shadow cascades break, and
// what that costs in texels. The point of the module is that "practical" mode
// anchors on camera.near (0.5 m here) and so ties near sharpness to shadow
// range; these checks pin the replacement curve and its readout.
import { nearAnchoredSplits, describeCascades, formatCascades } from "../v3/app/csmSplits.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ── The shipped editor setup: 3 cascades, 0.5 m near plane, 150 m of range ──
const breaks = nearAnchoredSplits(3, 0.5, 150, 10);
const dist = breaks.map((b) => b * 150);

check("returns one break per cascade", breaks.length === 3, JSON.stringify(breaks.map((b) => +b.toFixed(4))));
check("the last break is exactly 1 (three's contract)", breaks[breaks.length - 1] === 1);
check("cascade 0 ends exactly at the anchor", close(dist[0], 10, 1e-9), `${dist[0].toFixed(3)} m`);
check("cascade 2 ends at maxFar", close(dist[2], 150, 1e-9));
check("the middle split is the geometric mean of anchor and far",
  close(dist[1], Math.sqrt(10 * 150), 1e-9), `${dist[1].toFixed(2)} m vs ${Math.sqrt(1500).toFixed(2)}`);
check("breaks ascend strictly", breaks.every((b, i) => i === 0 || b > breaks[i - 1]));
check("every break is inside (0,1]", breaks.every((b) => b > 0 && b <= 1));

// ── The curve is a constant ratio, whatever the cascade count ──
for (const n of [2, 3, 4, 5]) {
  const d = nearAnchoredSplits(n, 0.5, 150, 10).map((b) => b * 150);
  const ratios = d.slice(1).map((v, i) => v / d[i]);
  const even = ratios.every((r) => close(r, ratios[0], 1e-9));
  check(`${n} cascades: equal ratio between every split`, n === 1 || even,
    d.map((v) => v.toFixed(1)).join(" / "));
  check(`${n} cascades: still anchored at 10 m and ending at 150 m`,
    close(d[0], 10, 1e-9) && close(d[d.length - 1], 150, 1e-9));
}

// ── Guards: nothing may produce a non-ascending or out-of-range break list ──
const degenerate = [
  ["one cascade", nearAnchoredSplits(1, 0.5, 150, 10)],
  ["anchor past maxFar", nearAnchoredSplits(3, 0.5, 150, 400)],
  ["anchor at zero", nearAnchoredSplits(3, 0.5, 150, 0)],
  ["anchor NaN", nearAnchoredSplits(3, 0.5, 150, NaN)],
  ["far of zero", nearAnchoredSplits(3, 0.5, 0, 10)],
  ["cascades as a float", nearAnchoredSplits(2.6, 0.5, 150, 10)],
];
for (const [name, b] of degenerate) {
  const ok = b.length >= 1
    && b[b.length - 1] === 1
    && b.every((v) => Number.isFinite(v) && v > 0 && v <= 1)
    && b.every((v, i) => i === 0 || v > b[i - 1]);
  check(`guard: ${name} still gives a legal break list`, ok, JSON.stringify(b.map((v) => +v.toFixed(4))));
}
check("guard: anchor past maxFar is clamped, not collapsed",
  nearAnchoredSplits(3, 0.5, 150, 400)[0] < 1);
check("guard: the anchor always clears the near plane",
  nearAnchoredSplits(3, 4, 150, 0.1)[0] * 150 >= 8, "near 4 m → anchor ≥ 8 m");

// ── The readout: the whole argument for the change is the texel numbers ──
const shipped = describeCascades({ breaks, near: 0.5, far: 150, fov: 60, aspect: 16 / 9, mapSize: 2048 });
check("one entry per cascade", shipped.length === 3);
check("bands are contiguous and cover near → far",
  close(shipped[0].near, 0.5) && close(shipped[0].far, shipped[1].near)
  && close(shipped[1].far, shipped[2].near) && close(shipped[2].far, 150));
check("cascade 0 texel is around 1.2 cm at 2048",
  shipped[0].texel > 0.010 && shipped[0].texel < 0.014, `${(shipped[0].texel * 100).toFixed(2)} cm`);
check("texels grow with distance", shipped[0].texel < shipped[1].texel && shipped[1].texel < shipped[2].texel);
check("every cascade lands near one texel per screen pixel at its far edge",
  shipped.every((c) => c.texel / c.pixel > 0.6 && c.texel / c.pixel < 1.6),
  shipped.map((c) => (c.texel / c.pixel).toFixed(2)).join(" / "));
check("box side is the far-face diagonal for a normal slice",
  close(shipped[2].box, 2 * Math.tan(Math.PI / 6) * 150 * Math.sqrt(1 + (16 / 9) ** 2), 1e-6),
  `${shipped[2].box.toFixed(1)} m`);
check("doubling the map halves the texel",
  close(describeCascades({ breaks, near: 0.5, far: 150, fov: 60, aspect: 16 / 9, mapSize: 4096 })[0].texel,
    shipped[0].texel / 2, 1e-9));

// The comparison that justifies the default change: practical @ 80 (what the
// editor shipped) vs near-anchored @ 150. Same cascades, same map.
const practical80 = [14.86 / 80, 34.12 / 80, 1];
const old = describeCascades({ breaks: practical80, near: 0.5, far: 80, fov: 60, aspect: 16 / 9, mapSize: 2048 });
check("the new near cascade is SHARPER than practical @ 80",
  shipped[0].texel < old[0].texel,
  `${(shipped[0].texel * 100).toFixed(2)} cm vs ${(old[0].texel * 100).toFixed(2)} cm`);
check("...while reaching nearly twice as far",
  shipped[2].far / old[2].far > 1.8, `${shipped[2].far} m vs ${old[2].far} m`);

check("formats a readable line", /–.*m ·.*cm per texel/.test(formatCascades(shipped)), formatCascades(shipped));
check("formats an empty list without throwing", formatCascades([]) === "—");

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
