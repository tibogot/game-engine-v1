// Terrain region copy-paste, ground-paint half (v3/terrain/splatMap.js
// copyRegionWorld / pasteRegion). The heights half is a GPU pass
// (sculptBrush.pasteRegion) checked in the editor; both follow one convention,
// pinned here: world = centre + R(angle) * local on (x, z) with
// R = [[cos, -sin], [sin, cos]], flips applied in local space.
import { SplatMap, SPLAT_RES, HOLE_LAYER } from "../v3/terrain/splatMap.js";
import { WORLD_SIZE } from "../v3/terrain/heightmapTexture.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const R = SPLAT_RES;
const PX = WORLD_SIZE / R;
const idx = (wx, wz) => Math.floor((wz + WORLD_SIZE / 2) / PX) * R + Math.floor((wx + WORLD_SIZE / 2) / PX);
const layer = (sm, n, wx, wz) => sm.data0[idx(wx, wz) * 4 + (n - 1)];
const dot = (sm, n, wx, wz, radius) =>
  sm.applySplatStroke({ cx: wx, cz: wz, radius, strength: 1, falloff: 0, activeLayer: n });
const equalMaps = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// A source 200 x 200 m around (-250, -250): layer 2 everywhere, and a layer-3
// marker to its EAST (+X) so rotations and flips are visible.
const C = -250, S = 100, M = 60;
function source() {
  const sm = new SplatMap();
  dot(sm, 2, C, C, S * 1.5);
  dot(sm, 3, C + M, C, PX * 6);
  return sm;
}

// ── Pasting a region back where it came from changes nothing ──
{
  const sm = source();
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const snap = new Uint8Array(sm.combined);
  sm.pasteRegion(clip, { centerX: C, centerZ: C });
  check("paste in place is a no-op", equalMaps(snap, sm.combined));
}

// ── Plain move: the marker comes along ──
{
  const sm = source();
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const T = 250;
  sm.pasteRegion(clip, { centerX: T, centerZ: T });
  check("moved: body layer arrives", layer(sm, 2, T, T) > 250);
  check("moved: marker keeps its east offset", layer(sm, 3, T + M, T) > 250, `${layer(sm, 3, T + M, T)}`);
  check("moved: the source is untouched", layer(sm, 3, C + M, C) > 250);
  check("moved: outside the rectangle is untouched", layer(sm, 2, T + S + 20, T) === 0);
}

// ── Rotate +90°: local +X lands on world +Z ──
{
  const sm = source();
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const T = 250;
  sm.pasteRegion(clip, { centerX: T, centerZ: T, angle: Math.PI / 2 });
  check("rotate 90: marker at +Z", layer(sm, 3, T, T + M) > 250, `${layer(sm, 3, T, T + M)}`);
  check("rotate 90: not at +X", layer(sm, 3, T + M, T) === 0);
}

// ── Flip X: the marker moves to the west ──
{
  const sm = source();
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const T = 250;
  sm.pasteRegion(clip, { centerX: T, centerZ: T, flipX: true });
  check("flip X: marker at -X", layer(sm, 3, T - M, T) > 250);
  check("flip X: not at +X", layer(sm, 3, T + M, T) === 0);
}

// ── Flip Z of an east marker leaves it east (only X was off-centre) ──
{
  const sm = source();
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const T = 250;
  sm.pasteRegion(clip, { centerX: T, centerZ: T, flipZ: true });
  check("flip Z: an on-axis east marker stays east", layer(sm, 3, T + M, T) > 250);
}

// ── Feather: full inside, softened near the edge, nothing outside ──
{
  const sm = source();
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const T = 250, F = 40;
  sm.pasteRegion(clip, { centerX: T, centerZ: T, featherM: F });
  check("feather: centre is full", layer(sm, 2, T, T) > 250);
  const nearEdge = layer(sm, 2, T + S - F * 0.25, T);
  check("feather: near the edge is partial", nearEdge > 0 && nearEdge < 250, `${nearEdge}`);
  check("feather: outside stays empty", layer(sm, 2, T + S + PX * 3, T) === 0);
}

// ── Painted holes travel with the paste ──
{
  const sm = new SplatMap();
  dot(sm, HOLE_LAYER, C, C, 20);
  const clip = sm.copyRegionWorld(C - 50, C - 50, C + 50, C + 50);
  sm.pasteRegion(clip, { centerX: 200, centerZ: -150 });
  check("a painted hole is pasted", sm.holeAt(200, -150) > 0.9, sm.holeAt(200, -150).toFixed(2));
}

// ── Undo patch restores exactly ──
{
  const sm = source();
  dot(sm, 4, 240, 240, 80);
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  const snap = new Uint8Array(sm.combined);
  const { before } = sm.pasteRegion(clip, { centerX: 250, centerZ: 250, angle: 0.7, flipZ: true, featherM: 25 });
  check("the paste changed something", !equalMaps(snap, sm.combined));
  sm.pasteRect(before);
  check("pasting the returned patch restores the map exactly", equalMaps(snap, sm.combined));
}

// ── Off the map ──
{
  const sm = source();
  check("a copy fully off the map is null", sm.copyRegionWorld(WORLD_SIZE, WORLD_SIZE, WORLD_SIZE + 50, WORLD_SIZE + 50) === null);
  const clip = sm.copyRegionWorld(C - S, C - S, C + S, C + S);
  check("a paste fully off the map is null", sm.pasteRegion(clip, { centerX: WORLD_SIZE * 2, centerZ: 0 }) === null);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
