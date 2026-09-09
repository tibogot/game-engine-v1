/*
 * WHAT SHAPE IS THE SKYLINE, counted rather than looked at.
 *
 * The kit already builds podiums, setbacks, ledges, crowns and masts. Before
 * changing any of that it is worth knowing how often each actually happens and
 * how strong it is when it does — "add setbacks" is the wrong instruction for a
 * kit that has them, and "make them stronger" needs a number to move.
 */
import { register } from "node:module";
register("./threeWebgpuHook.mjs", import.meta.url);
const { buildCityKit, KIT_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCityKit.js");

const kit = buildCityKit({ seed: 20260902 });
const A = kit.archetypes;

/*
 * THE SILHOUETTE, MEASURED OFF THE GEOMETRY. An earlier version of this used
 * `crownW` as a stand-in for "width at the top" and reported 0% narrowing for
 * every archetype — crownW is the roof furniture's footprint, not the tower's,
 * and it is 0 unless a crown was built. Reading the mesh cannot be fooled that
 * way: bucket the vertices by height and take the widest point in each band.
 */
const BANDS = 20;
function profile(geo) {
  const pos = geo.getAttribute("position");
  let top = 0;
  for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  const w = new Array(BANDS).fill(0);
  for (let i = 0; i < pos.count; i++) {
    const b = Math.min(BANDS - 1, Math.floor((pos.getY(i) / Math.max(1e-6, top)) * BANDS));
    w[b] = Math.max(w[b], Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getZ(i))) * 2);
  }
  // A box contributes vertices only at its own two ends, so bands in the middle
  // of a tier are empty. Carry the last real width up through them, or the
  // profile reads as a stack of gaps.
  for (let i = 1; i < BANDS; i++) if (w[i] === 0) w[i] = w[i - 1];
  for (let i = BANDS - 2; i >= 0; i--) if (w[i] === 0) w[i] = w[i + 1];
  return { top, w };
}

/*
 * BASE AND TIP ARE THE TOWER'S, NOT THE AERIAL'S. Reading the topmost band
 * reported 98% narrowing on half the kit — that is a MAST, a 1 m box on the
 * roof, and calling it "the tower steps in" is exactly wrong. The tip is
 * measured at 85% of the height, below the roof furniture and above the last
 * setback; the base over the lowest tenth, because a podium is part of the
 * silhouette and its ledge is not.
 */
const tipBand = Math.floor(BANDS * 0.85);
const baseOf = (w) => Math.max(w[0], w[1]);

console.log(`${A.length} archetypes
`);
console.log("  #  height   base   top   step%   profile (base -> top)");
let stepped = 0, sum = 0, worst = 0;
A.forEach((a, i) => {
  const { top, w } = profile(a.lods[0]);
  const base = baseOf(w), tip = w[tipBand];
  const step = base > 0 ? 1 - tip / base : 0;
  if (step > 0.08) stepped++;
  sum += step; worst = Math.max(worst, step);
  const bar = w.map((v) => "▁▂▃▄▅▆▇█"[Math.max(0, Math.min(7, Math.round(v / base * 7)))] || " ").join("");
  console.log(
    `  ${String(i).padStart(2)} ${top.toFixed(0).padStart(5)} m  ${base.toFixed(0).padStart(4)}  `
    + `${tip.toFixed(0).padStart(4)}  ${(step * 100).toFixed(0).padStart(5)}%   ${bar}`,
  );
});
console.log(`
${stepped} of ${A.length} step in by more than 8%; mean ${(sum / A.length * 100).toFixed(0)}%, worst ${(worst * 100).toFixed(0)}%`);
console.log(`setbackChance ${KIT_DEFAULTS.setbackChance}, maxSetbacks ${KIT_DEFAULTS.maxSetbacks}, `
  + `setbackDepth ${KIT_DEFAULTS.setbackDepth}, podiumChance ${KIT_DEFAULTS.podiumChance}`);
