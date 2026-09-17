// Terrain mirror, ground-paint half (v3/terrain/splatMap.js mirrorPaint). The
// heights half runs on the GPU (sculptBrush.mirror) and is checked in the
// editor; both must follow the same conventions, which these checks pin:
// "x" reflects world X, "z" reflects world Z, "rotate" turns half a turn about
// the centre, and keep "low" keeps the −X (or −Z) side.
import { SplatMap, SPLAT_RES, HOLE_LAYER } from "../v3/terrain/splatMap.js";
import { WORLD_SIZE } from "../v3/terrain/heightmapTexture.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const R = SPLAT_RES;
const texel = (wx, wz) => {
  const px = Math.floor((wx + WORLD_SIZE / 2) / WORLD_SIZE * R);
  const pz = Math.floor((wz + WORLD_SIZE / 2) / WORLD_SIZE * R);
  return pz * R + px;
};
const w = (sm, layer, wx, wz) => {           // layer 1..4 live in slice 0
  return sm.data0[texel(wx, wz) * 4 + (layer - 1)];
};
const dot = (sm, layer, wx, wz, radius = 20) =>
  sm.applySplatStroke({ cx: wx, cz: wz, radius, strength: 1, falloff: 0, activeLayer: layer });
const Q = WORLD_SIZE * 0.25;

// ── mirror X, keep low: a dot at −X appears at +X, same Z ──
{
  const sm = new SplatMap();
  dot(sm, 2, -Q, Q * 0.5);
  sm.mirrorPaint({ mode: "x", keep: "low" });
  check("x: the kept dot is untouched", w(sm, 2, -Q, Q * 0.5) === 255);
  check("x: it is reflected across X", w(sm, 2, Q, Q * 0.5) === 255, `${w(sm, 2, Q, Q * 0.5)}`);
  check("x: not reflected across Z", w(sm, 2, Q, -Q * 0.5) === 0);
}

// ── mirror X, keep HIGH: the +X side wins ──
{
  const sm = new SplatMap();
  dot(sm, 3, -Q, 0);          // on the side that gets replaced
  dot(sm, 4, Q, 0);           // on the side that is kept
  sm.mirrorPaint({ mode: "x", keep: "high" });
  check("keep high: the +X dot is copied to −X", w(sm, 4, -Q, 0) === 255);
  check("keep high: the old −X paint is gone", w(sm, 3, -Q, 0) === 0);
}

// ── mirror Z ──
{
  const sm = new SplatMap();
  dot(sm, 2, Q * 0.5, -Q);
  sm.mirrorPaint({ mode: "z", keep: "low" });
  check("z: reflected across Z", w(sm, 2, Q * 0.5, Q) === 255);
  check("z: not reflected across X", w(sm, 2, -Q * 0.5, Q) === 0);
}

// ── rotate 180°: point symmetry about the centre ──
{
  const sm = new SplatMap();
  dot(sm, 2, -Q, -Q * 0.6);
  sm.mirrorPaint({ mode: "rotate", keep: "low" });
  check("rotate: the dot appears at (−x, −z)", w(sm, 2, Q, Q * 0.6) === 255);
  check("rotate: not a plain X reflection", w(sm, 2, Q, -Q * 0.6) === 0);
}

// ── painted holes are mirrored, weights still sum ──
{
  const sm = new SplatMap();
  dot(sm, HOLE_LAYER, -Q, 0);
  sm.mirrorPaint({ mode: "x", keep: "low" });
  check("a painted hole is mirrored", sm.holeAt(Q, 0) > 0.9, sm.holeAt(Q, 0).toFixed(2));
}

// ── seam blend: a hard mirror leaves the kept side byte-identical; a blend
//    only reaches the band around the axis ──
{
  const sm = new SplatMap();
  // Different paint either side of the axis, covering right up to it.
  dot(sm, 1, -24, 0, 26);
  dot(sm, 2, 24, 0, 26);
  const keptBefore = w(sm, 1, -8, 0);
  const a = new SplatMap(); a.setCombined(sm.combined.slice ? sm.combined.slice() : new Uint8Array(sm.combined));
  a.mirrorPaint({ mode: "x", keep: "low", blendM: 0 });
  check("hard seam: kept side unchanged next to the axis", w(a, 1, -8, 0) === keptBefore);
  const b = new SplatMap(); b.setCombined(new Uint8Array(sm.combined));
  b.mirrorPaint({ mode: "x", keep: "low", blendM: 30 });
  const texelM = WORLD_SIZE / R;
  const nearAxis = w(b, 1, -texelM * 0.5, 0);
  check("hard seam: the texel just inside the kept side is still fully layer 1", w(a, 1, -texelM * 0.5, 0) === 255, `${w(a, 1, -texelM * 0.5, 0)}`);
  check("blended seam: that texel now blends toward the mirrored layer 2", nearAxis < 255 && w(b, 2, -texelM * 0.5, 0) > 0,
    `L1=${nearAxis} L2=${w(b, 2, -texelM * 0.5, 0)}`);
  check("blended seam: far from the axis nothing changes", w(b, 1, -Q, 0) === w(a, 1, -Q, 0));
}

// ── the undo patch restores everything ──
{
  const sm = new SplatMap();
  dot(sm, 2, -Q, 0); dot(sm, 3, Q, Q);
  const snap = new Uint8Array(sm.combined);
  const { before } = sm.mirrorPaint({ mode: "rotate", keep: "low", blendM: 25 });
  let changed = false;
  for (let i = 0; i < snap.length; i++) if (snap[i] !== sm.combined[i]) { changed = true; break; }
  check("the mirror changed something", changed);
  sm.pasteRect(before);
  let same = true;
  for (let i = 0; i < snap.length; i++) if (snap[i] !== sm.combined[i]) { same = false; break; }
  check("pasting the returned patch restores the map exactly", same);
  check("the patch covers only half the map plus the band", before.w * before.h < R * R * 0.6, `${before.w}x${before.h}`);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
