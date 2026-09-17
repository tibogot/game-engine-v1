// Terrain clone brush, ground-paint half (v3/terrain/splatMap.js beginClone /
// cloneStamp / endClone). The heights half is a GPU brush (sculptBrush.clone)
// checked in the editor; both read the map as it was when the stroke STARTED.
import { SplatMap, SPLAT_RES, HOLE_LAYER } from "../v3/terrain/splatMap.js";
import { WORLD_SIZE } from "../v3/terrain/heightmapTexture.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const R = SPLAT_RES, PX = WORLD_SIZE / R;
const idx = (wx, wz) => Math.floor((wz + WORLD_SIZE / 2) / PX) * R + Math.floor((wx + WORLD_SIZE / 2) / PX);
const layer = (sm, n, wx, wz) => sm.data0[idx(wx, wz) * 4 + (n - 1)];
const dot = (sm, n, wx, wz, radius) =>
  sm.applySplatStroke({ cx: wx, cz: wz, radius, strength: 1, falloff: 0, activeLayer: n });
const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// Source: a layer-3 disc at (-200, 0). Clone it to (+200, 0): offset = -400 m.
const SRC = -200, DST = 200, OFF = SRC - DST;

// ── A full-opacity stamp copies the source under the brush centre ──
{
  const sm = new SplatMap();
  dot(sm, 3, SRC, 0, 40);
  sm.beginClone();
  sm.cloneStamp({ cx: DST, cz: 0, radius: 40, falloff: 0, opacity: 1, offsetX: OFF, offsetZ: 0 });
  sm.endClone();
  check("the source layer arrives at the destination", layer(sm, 3, DST, 0) === 255, `${layer(sm, 3, DST, 0)}`);
  check("the source is untouched", layer(sm, 3, SRC, 0) === 255);
  check("outside the brush nothing changes", layer(sm, 3, DST + 60, 0) === 0);
}

// ── Falloff: soft brush gives partial weight toward the rim ──
{
  const sm = new SplatMap();
  dot(sm, 3, SRC, 0, 60);
  sm.beginClone();
  sm.cloneStamp({ cx: DST, cz: 0, radius: 40, falloff: 2, opacity: 1, offsetX: OFF, offsetZ: 0 });
  const centre = layer(sm, 3, DST, 0), rim = layer(sm, 3, DST + 30, 0);
  // The nearest texel centre can sit half a texel off the brush centre.
  check("soft brush: centre near full", centre > 200, `${centre}`);
  check("soft brush: rim partial", rim > 0 && rim < centre, `${rim}`);
}

// ── Opacity scales one stamp; repeated stamps converge ──
{
  const sm = new SplatMap();
  dot(sm, 3, SRC, 0, 60);
  sm.beginClone();
  sm.cloneStamp({ cx: DST, cz: 0, radius: 40, falloff: 0, opacity: 0.25, offsetX: OFF, offsetZ: 0 });
  const one = layer(sm, 3, DST, 0);
  check("opacity 0.25: one stamp gives about a quarter", Math.abs(one - 64) <= 2, `${one}`);
  for (let i = 0; i < 30; i++) sm.cloneStamp({ cx: DST, cz: 0, radius: 40, falloff: 0, opacity: 0.25, offsetX: OFF, offsetZ: 0 });
  check("repeated stamps converge on the source", layer(sm, 3, DST, 0) > 250, `${layer(sm, 3, DST, 0)}`);
}

// ── Overlapping source and destination: no self-feedback ──
//    A 20 m-wide stripe cloned 10 m to the right, stamped twice along the path.
//    Reading the LIVE map would copy freshly cloned paint again and smear it
//    further right than the offset allows.
{
  const sm = new SplatMap();
  dot(sm, 3, 0, 0, 10);
  const OFFSET = -10;
  // Paint moves by whole texels: the offset rounded to the texel grid.
  const shiftM = -Math.round(OFFSET / PX) * PX;
  const rowMax = () => { let m = -Infinity; for (let x = -60; x <= 80; x += PX) if (layer(sm, 3, x, 0) > 250) m = x; return m; };
  const coreMax = rowMax();
  sm.beginClone();
  for (let x = 0; x <= 40; x += 2) sm.cloneStamp({ cx: x, cz: 0, radius: 12, falloff: 0, opacity: 1, offsetX: OFFSET, offsetZ: 0 });
  sm.endClone();
  const cloneMax = rowMax();
  check("clone reaches exactly the offset distance past the source", cloneMax === coreMax + shiftM, `core ends ${coreMax}, clone ends ${cloneMax}, shift ${shiftM}`);
  check("and never beyond it — no smear", layer(sm, 3, cloneMax + PX * 2, 0) === 0);
}

// ── Painted holes are cloned ──
{
  const sm = new SplatMap();
  dot(sm, HOLE_LAYER, SRC, 0, 20);
  sm.beginClone();
  sm.cloneStamp({ cx: DST, cz: 0, radius: 25, falloff: 0, opacity: 1, offsetX: OFF, offsetZ: 0 });
  sm.endClone();
  check("a painted hole is cloned", sm.holeAt(DST, 0) > 0.9, sm.holeAt(DST, 0).toFixed(2));
}

// ── Source off the map: nothing copied, no crash ──
{
  const sm = new SplatMap();
  sm.beginClone();
  const r = sm.cloneStamp({ cx: 0, cz: 0, radius: 30, falloff: 0, opacity: 1, offsetX: WORLD_SIZE * 3, offsetZ: 0 });
  check("a source fully off the map touches nothing", r === null && sm.endClone() === null);
}

// ── Undo / redo patches ──
{
  const sm = new SplatMap();
  dot(sm, 3, SRC, 0, 40); dot(sm, 4, DST, 0, 50);
  const snap = new Uint8Array(sm.combined);
  sm.beginClone();
  for (let i = 0; i < 5; i++) sm.cloneStamp({ cx: DST + i * 8, cz: 0, radius: 30, falloff: 1, opacity: 0.6, offsetX: OFF, offsetZ: 0 });
  const res = sm.endClone();
  const after = new Uint8Array(sm.combined);
  check("the stroke changed the map", !same(snap, after));
  sm.pasteRect(res.before);
  check("before-patch restores the map exactly", same(snap, sm.combined));
  sm.pasteRect(res.after);
  check("after-patch reapplies the stroke exactly", same(after, sm.combined));
  check("endClone twice returns null", sm.endClone() === null);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
