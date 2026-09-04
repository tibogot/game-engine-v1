// Wet spray streaks: the projection derivative must never be evaluated at or
// behind the lens.
//
// THE BUG, which drew a bright cross over the car whenever the road was wet:
// a streak's screen axis is the derivative of the perspective projection,
//
//     sx = V·right - X * (V·fwd) / z
//     sy = V·up    - Y * (V·fwd) / z
//
// and that 1/z is unbounded as a droplet approaches the plane of the lens. The
// guard that was supposed to retire particles before the near plane measured
// the RADIAL distance to the camera instead of the DEPTH along the view axis,
// which are not the same thing: a droplet level with the lens but two metres to
// one side is two metres away — fully opaque by a radial test — and yet
// completely past the near plane. Spray from a chase camera does exactly that,
// because it is thrown backwards into the car's wake and streams past the rig.
//
// Those particles took `z` to its 0.05 floor, multiplying the perspective term
// by up to 20 and stretching a 4 cm droplet into a card several METRES long,
// aimed radially away from the view axis. Hundreds of them at once is a set of
// beams converging on the vanishing point — the cross.
//
// This checks the invariant rather than the symptom: no particle that survives
// the fade may be at or behind the lens, and no streak may sweep more than a
// bounded fraction of the frame.
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "games", "modular-road-v3", "modularRoadDriftSmoke.js");
const src = readFileSync(SRC, "utf8");

let fail = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) fail++; };

// Pull the live constants out of the source so the test cannot drift from it.
const num = (name) => {
  const m = src.match(new RegExp(`^const ${name} = ([-0-9./ ]+);`, "m"));
  if (!m) throw new Error(`constant ${name} not found in modularRoadDriftSmoke.js`);
  return eval(m[1]);
};
const NEAR_FADE_OUT = num("NEAR_FADE_OUT");
const NEAR_FADE_IN = num("NEAR_FADE_IN");
const BASE_SHUTTER = num("BASE_SHUTTER");
const STREAK_MAX_SWEEP = num("STREAK_MAX_SWEEP");

console.log("=== THE GUARD IS ON DEPTH, NOT RADIAL DISTANCE ===");
{
  // The whole bug in one line. `camDist` may still size the quad (that IS
  // radial), but the near-plane term has to read the depth.
  const near = src.match(/\(camDepth - NEAR_FADE_OUT\)/);
  check("near-plane fade measures camDepth", !!near);
  check("camDepth is the signed dot with the view axis",
    /const camDepth = _toPart\.dot\(_smokeFwd\);/.test(src));
  check("the old 0.05 depth floor is gone from the streak axis",
    !/Math\.max\(_toPart\.dot\(_smokeFwd\), 0\.05\)/.test(src),
    "that floor was the amplifier");
  check("the quad-size term still uses the RADIAL distance",
    /const k = radius \/ Math\.max\(camDist, 1e-4\);/.test(src));
}

// ── The math, mirrored, so the numbers are checked and not just the text ──
//
// Camera basis: fwd = +Z, right = +X, up = +Y, travelling with the car. A
// droplet leaves the tread at `drag` of road speed while the camera holds road
// speed, so against the lens it recedes at (1 - drag) * v.
const DRAG = 0.78;
function streak({ v, depth, offX, offY, size }) {
  const fade = Math.min(1, Math.max(0,
    (depth - NEAR_FADE_OUT) / (NEAR_FADE_IN - NEAR_FADE_OUT)));
  if (fade <= 0) return { drawn: false, fade };
  const relFwd = -(1 - DRAG) * v;
  const z = Math.max(depth, NEAR_FADE_OUT);
  const vf = relFwd / z;
  const sLen = Math.hypot(-offX * vf, -offY * vf);
  const half = size * 0.5;
  const grown = Math.max(half, half + sLen * BASE_SHUTTER * 0.5);
  const halfLong = Math.max(half, Math.min(grown, depth * STREAK_MAX_SWEEP));
  return { drawn: true, fade, halfLong, ratio: halfLong / half, uncapped: grown / half };
}

console.log("\n=== NOTHING AT OR BEHIND THE LENS IS EVER DRAWN ===");
{
  const past = [
    ["level with the lens, 2 m to the side", { v: 30, depth: 0, offX: 2, offY: 0, size: 0.04 }],
    ["a metre behind it", { v: 30, depth: -1, offX: 2, offY: 0, size: 0.04 }],
    ["three behind, flung wide", { v: 30, depth: -3, offX: 3, offY: 1, size: 0.04 }],
    ["behind at walking pace", { v: 8, depth: -2, offX: 2, offY: 0, size: 0.04 }],
  ];
  for (const [name, args] of past) {
    const r = streak(args);
    check(name, !r.drawn, `fade ${r.fade.toFixed(2)}`);
  }
}

console.log("\n=== A STREAK STAYS A STREAK, NOT A BEAM ===");
{
  // Sweep the whole plausible envelope: every speed the car reaches, every
  // depth in front of the lens, every lateral throw. The old code hit 418x here.
  //
  // The invariant is the SWEEP — half-length over depth, which is the fraction
  // of the frame the streak crosses. That is the thing a viewer sees, and it is
  // the only bound that means the same at every distance. A ratio to the
  // droplet's own radius is not it: the same sweep is 60x on a 2.2 cm droplet
  // and 22x on a 6 cm one, so a ratio bound would just encode the size range.
  let worstSweep = 0, worstAt = null, worstUncappedSweep = 0, worstRatio = 0;
  for (let v = 4; v <= 60; v += 2) {
    for (let depth = NEAR_FADE_OUT; depth <= 40; depth += 0.05) {
      for (let off = 0; off <= 6; off += 0.25) {
        const r = streak({ v, depth, offX: off, offY: off * 0.4, size: 0.022 });
        if (!r.drawn) continue;
        worstUncappedSweep = Math.max(worstUncappedSweep, r.uncapped * 0.011 / depth);
        worstRatio = Math.max(worstRatio, r.ratio);
        const sweep = r.halfLong / depth;
        if (sweep > worstSweep) { worstSweep = sweep; worstAt = { v, depth: +depth.toFixed(2), off }; }
      }
    }
  }
  check("no streak sweeps more of the frame than the cap allows",
    worstSweep <= STREAK_MAX_SWEEP + 1e-9,
    `worst ${worstSweep.toFixed(3)} vs cap ${STREAK_MAX_SWEEP} at ${JSON.stringify(worstAt)}`);
  // The beams in the screenshot ran the full height of the frame and then some.
  check("the cap is doing real work at the extremes",
    worstUncappedSweep > STREAK_MAX_SWEEP * 4,
    `uncapped would sweep ${worstUncappedSweep.toFixed(2)} (${(worstUncappedSweep / STREAK_MAX_SWEEP).toFixed(0)}x the cap)`);
  console.log(`      (worst capped streak is ${worstRatio.toFixed(0)}x its own radius — long, but a streak)`);
}

console.log("\n=== ORDINARY SPRAY IS UNTOUCHED BY THE CAP ===");
{
  // The fix must not shorten the streaks the feature exists to draw. These are
  // where spray actually lives: out behind the car, several metres off the lens.
  for (const [name, args] of [
    ["at the wheels, 6 m out", { v: 30, depth: 6, offX: 0.8, offY: 0, size: 0.04 }],
    ["trailing, 12 m out", { v: 45, depth: 12, offX: 1.5, offY: 0.5, size: 0.03 }],
    ["far plume, 40 m out", { v: 30, depth: 40, offX: 2, offY: 0, size: 0.04 }],
  ]) {
    const r = streak(args);
    check(name + " is drawn at full strength", r.drawn && r.fade === 1);
    check(name + " is not clipped by the sweep cap",
      Math.abs(r.ratio - r.uncapped) < 1e-9, `${r.ratio.toFixed(1)}x`);
  }
}

console.log("\n=== ON AXIS, THE FADE IS UNCHANGED FROM THE RADIAL VERSION ===");
{
  // Depth and radial distance agree on the view axis, so the drift smoke's
  // near-camera behaviour — the thing the radial test was tuned against — is
  // exactly as it was. Only off-axis particles, which are at the frame edge or
  // outside it entirely, see any difference.
  const radial = (d) => Math.min(1, Math.max(0, (d - NEAR_FADE_OUT) / (NEAR_FADE_IN - NEAR_FADE_OUT)));
  let maxDiff = 0;
  for (let d = 0; d <= 4; d += 0.01) maxDiff = Math.max(maxDiff, Math.abs(streak({ v: 30, depth: d, offX: 0, offY: 0, size: 0.04 }).fade - radial(d)));
  check("identical for a particle straight ahead", maxDiff < 1e-12);
}

console.log(fail ? `\n${fail} FAILURE(S)` : "\nall green");
process.exit(fail ? 1 : 0);
