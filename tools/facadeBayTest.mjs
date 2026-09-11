// ============================================================================
// HOW THE FACADE'S BAYS MEET THE END OF A FACE.
//
// A numeric model of the shader's own "FACE LAYOUT" arithmetic
// (modularRoadCityFacade.js), because that arithmetic decides something you
// can see from a car — how big a window is — and it cannot be asserted from a
// headless render.
//
// ── WHAT THE STRETCH ACTUALLY BROKE ──────────────────────────────────────────
//
// Not that different buildings get different bays: `bay0` is already spread
// +/- `baySpread` per lot ON PURPOSE, because a city whose every tower shares
// one window rhythm is a city built in one afternoon.
//
// It is that the bay was fitted PER FACE. A box is `w` by `d`, so the two
// faces you see from a street corner have different widths — and the stretch
// hands them different window sizes on the SAME building, at the one viewpoint
// where you can compare them directly. That is the tell, and it is the thing
// these tests pin down.
//
// Run:  node tools/facadeBayTest.mjs
// ============================================================================
import { register } from "node:module";

register("./threeWebgpuHook.mjs", import.meta.url);
const { FACADE_DEFAULTS } = await import("../games/modular-road-v3/modularRoadCityFacade.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

const F = FACADE_DEFAULTS;
const PIER = F.pierWidth;
/** `spread(c, s, h) = c + (h - 0.5) * 2 * s`, the shader's own per-lot dice. */
const spread = (c, s, h) => c + (h - 0.5) * 2 * s;

/**
 * The layout, exactly as the shader computes it for one FACE.
 *
 *   count  = floor((W - pierW) / bay0)        — the same however it is fitted,
 *                                               which is what keeps the blend
 *                                               smooth: no bay ever pops
 *   bayS   = (W - pierW) / count              — stretched to fill
 *   bay    = mix(bay0, bayS, bayFit)
 *   slack  = max(W - count * bay, pierW)      — never less than one pier
 *   origin = pierW/2 + (slack - pierW) * phase
 */
function layout(W, bay0, bayFit, phase = 0.5, pierW = PIER) {
  const count = Math.max(Math.floor((W - pierW) / bay0), 1);
  const bayS = (W - pierW) / count;
  const bay = bay0 + (bayS - bay0) * bayFit;
  const slack = Math.max(W - count * bay, pierW);
  const origin = pierW / 2 + (slack - pierW) * phase;
  return { count, bay, slack, origin, mL: origin, mR: W - (origin + count * bay) };
}

/** `classify`: inside a window slot, with the margins masked off. */
function inSlot(L, ua, pierW = PIER) {
  const slotL = pierW / 2, slotR = L.bay - pierW / 2;
  const uL = ua - L.origin;
  const inGrid = uL >= 0 && uL <= L.count * L.bay;
  const bi = Math.min(Math.max(Math.floor(uL / L.bay), 0), L.count - 1);
  const bu = uL - bi * L.bay + slotL;
  return inGrid && bu >= slotL && bu <= slotR;
}

/** Widest run of glass touching either end of the face. */
function edgeGlass(L, W) {
  const step = 0.002;
  let left = 0, right = 0;
  for (let u = 0; u < W; u += step) { if (inSlot(L, u)) left = u + step; else break; }
  for (let u = W; u > 0; u -= step) { if (inSlot(L, u)) right = W - u + step; else break; }
  return { left, right };
}

/** The phase range the shader can actually reach: 0.5 +/- bayPhase/2. */
const PH_LO = 0.5 - F.bayPhase / 2, PH_HI = 0.5 + F.bayPhase / 2;
const WIDTHS = [12, 14, 16, 18, 20, 21, 22, 24, 26, 28, 30, 36, 44];
/** Face pairs as a box gives them: (w, d) for one building. */
const BOXES = [[24, 18], [30, 14], [21, 20], [16, 44], [28, 26], [36, 12]];

console.log(`bayWidth ${F.bayWidth} +/- ${F.baySpread} · pierWidth ${PIER} · `
  + `bayFit ${F.bayFit} · bayPhase ${F.bayPhase} (reach ${PH_LO.toFixed(3)}..${PH_HI.toFixed(3)})\n`);

// ── 1. bayFit = 1 IS the shipped layout ─────────────────────────────────────
{
  let worst = 0;
  for (const W of WIDTHS) {
    const L = layout(W, F.bayWidth, 1);
    const count = Math.max(Math.floor((W - PIER) / F.bayWidth), 1);
    worst = Math.max(worst,
      Math.abs(L.bay - (W - PIER) / count),
      Math.abs(L.mL - PIER / 2), Math.abs(L.mR - PIER / 2));
  }
  check("bayFit = 1 reproduces the shipped layout", worst < 1e-9,
    `worst disagreement ${worst.toExponential(1)} m over ${WIDTHS.length} face widths`);
}

// ── 2. THE TELL: one building, two faces, two window sizes ──────────────────
{
  const disagreement = (bayFit) => {
    let worst = 0, at = "";
    for (const [w, d] of BOXES) {
      for (const h4 of [0.1, 0.35, 0.5, 0.7, 0.95]) {
        const bay0 = spread(F.bayWidth, F.baySpread, h4);
        const a = layout(w, bay0, bayFit).bay, b = layout(d, bay0, bayFit).bay;
        const r = Math.max(a, b) / Math.min(a, b) - 1;
        if (r > worst) { worst = r; at = `${w}x${d} m, bay0 ${bay0.toFixed(2)}: ${a.toFixed(2)} vs ${b.toFixed(2)}`; }
      }
    }
    return { worst, at };
  };
  const shipped = disagreement(1), fixed = disagreement(0);
  check("the shipped layout gave one building two window sizes", shipped.worst > 0.1,
    `${(shipped.worst * 100).toFixed(0)}% apart — ${shipped.at}`);
  check("bayFit = 0 gives a building ONE window on every face", fixed.worst < 1e-9,
    `${(fixed.worst * 100).toFixed(1)}% apart`);
  // ...while keeping the deliberate building-to-building variety.
  let lo = Infinity, hi = 0;
  for (const h4 of [0, 0.25, 0.5, 0.75, 1]) {
    const b = layout(24, spread(F.bayWidth, F.baySpread, h4), 0).bay;
    lo = Math.min(lo, b); hi = Math.max(hi, b);
  }
  check("...and buildings still differ from each other on purpose", hi - lo > 1.0,
    `${lo.toFixed(2)}..${hi.toFixed(2)} m across the lot dice`);
}

// ── 3. THE CORNERS ARE SOLID. Every fit, width, phase and lot dice. ─────────
{
  let worstGlass = 0, worstAt = "", thinnest = Infinity;
  for (const bayFit of [0, 0.25, 0.5, 1]) {
    for (const W of WIDTHS) {
      for (const h4 of [0, 0.5, 1]) {
        const bay0 = spread(F.bayWidth, F.baySpread, h4);
        for (const phase of [PH_LO, 0.5, PH_HI]) {
          const L = layout(W, bay0, bayFit, phase);
          const e = edgeGlass(L, W);
          const g = Math.max(e.left, e.right);
          if (g > worstGlass) { worstGlass = g; worstAt = `W ${W}, bay0 ${bay0.toFixed(2)}, bayFit ${bayFit}, phase ${phase.toFixed(2)}`; }
          thinnest = Math.min(thinnest, L.mL, L.mR);
        }
      }
    }
  }
  check("no window ever reaches a face corner", worstGlass === 0,
    worstGlass ? `${worstGlass.toFixed(2)} m at ${worstAt}` : "4 fits x 13 widths x 3 dice x 3 phases");
  check("...and every margin is at least a half pier", thinnest >= PIER / 2 - 1e-9,
    `thinnest ${thinnest.toFixed(3)} m vs ${(PIER / 2).toFixed(3)}`);
}

// ── 4. A margin is a corner pier, not a missing bay ─────────────────────────
{
  /*
   * A fixed pitch buys its standard window with slack at the ends, and the
   * slack is `W mod bay` — on an unlucky width, nearly a whole bay of it. That
   * still has to read as a wide corner pier rather than as a bay somebody
   * forgot, so no margin may exceed one bay.
   *
   * This is really a CONSTRAINT ON `bayPhase`: at 0.5 the slack is split
   * evenly and the bound is comfortable, and every notch of phase pushes one
   * margin toward the whole of it. Raise `bayPhase` to 1 and this fails, which
   * is the warning it exists to give.
   */
  let widest = 0, at = "";
  for (const W of WIDTHS) {
    for (const h4 of [0, 0.5, 1]) {
      const bay0 = spread(F.bayWidth, F.baySpread, h4);
      for (const phase of [PH_LO, 0.5, PH_HI]) {
        const L = layout(W, bay0, 0, phase);
        const m = Math.max(L.mL, L.mR);
        if (m / L.bay > widest / (widest ? L.bay : 1) && m > widest) {
          widest = m; at = `W ${W}, bay0 ${bay0.toFixed(2)}, phase ${phase.toFixed(2)} -> ${(m / L.bay).toFixed(2)} bays`;
        }
      }
    }
  }
  let overBay = 0;
  for (const W of WIDTHS) {
    for (const h4 of [0, 0.5, 1]) {
      const bay0 = spread(F.bayWidth, F.baySpread, h4);
      for (const phase of [PH_LO, 0.5, PH_HI]) {
        const L = layout(W, bay0, 0, phase);
        if (Math.max(L.mL, L.mR) > L.bay + 1e-9) overBay++;
      }
    }
  }
  check("a margin never grows past one bay", overBay === 0,
    `widest ${widest.toFixed(2)} m — ${at}`);
}

// ── 5. The phase is centred by default and bounded ──────────────────────────
{
  const mid = layout(24, F.bayWidth, 0, 0.5);
  check("the default phase centres the grid", Math.abs(mid.mL - mid.mR) < 1e-9,
    `${mid.mL.toFixed(3)} / ${mid.mR.toFixed(3)}`);
  const off = layout(24, F.bayWidth, 0, PH_HI);
  check("...and bayPhase slides it off centre without freeing it",
    F.bayPhase > 0 && F.bayPhase < 1 && off.mL > mid.mL,
    `bayPhase ${F.bayPhase}: a 24 m face's margin ${mid.mL.toFixed(2)} -> ${off.mL.toFixed(2)} m`);
}

console.log(`\n${fail ? `${fail} FAILURE(S)  ` : "ALL PASS  "}(${pass} passed)`);
process.exit(fail ? 1 : 0);
