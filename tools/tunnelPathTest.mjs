// Tunnel tool maths (v3/tools/tunnelPath.js) and the two hole sources in the
// splat map (painted holes vs tool holes).
import * as THREE from "three";
import {
  resolveNodeHeights, sampleTunnel, buildTunnelGeometry, rasterizeTunnelHoles, tunnelDims, FLOOR_LIFT,
} from "../v3/tools/tunnelPath.js";
import { SplatMap, SPLAT_RES, HOLE_LAYER, HOLE_ERASE_LAYER } from "../v3/terrain/splatMap.js";
import { WORLD_SIZE } from "../v3/terrain/heightmapTexture.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

// ── Heights ──────────────────────────────────────────────────────────────────
{
  const ys = resolveNodeHeights([
    { x: 0, z: 0, y: 10 }, { x: 10, z: 0, y: 80 }, { x: 30, z: 0, y: 99, pinned: true }, { x: 40, z: 0, y: 20 },
  ]);
  check("end nodes use their own floor height", ys[0] === 10 && ys[3] === 20);
  check("a pinned middle node keeps its height", ys[2] === 99);
  check("an unpinned middle node sits on the grade between anchors (not on the click)",
    near(ys[1], 10 + (99 - 10) * (10 / 30)), ys[1].toFixed(3));
}

// ── Centreline + frames ──────────────────────────────────────────────────────
const dims = { width: 8, height: 7, thickness: 1 };
const straight = { ...dims, nodes: [{ x: -20, z: 0, y: 10 }, { x: 0, z: 0, y: 10 }, { x: 20, z: 0, y: 10 }] };
const s = sampleTunnel(straight);
check("sampled length matches the path", near(s.length, 40, 0.05), s.length.toFixed(3));
check("floor stations sit FLOOR_LIFT above the node height", s.points.every((p) => near(p.y, 10 + FLOOR_LIFT)));
check("right axis is horizontal everywhere", s.rights.every((r) => near(r.y, 0)));
{
  const sloped = sampleTunnel({ ...dims, nodes: [{ x: 0, z: 0, y: 0 }, { x: 30, z: 0, y: 10 }] });
  check("up axis tilts with the grade and stays perpendicular to the path",
    sloped.ups.every((u, k) => near(u.dot(sloped.tangents[k]), 0) && u.y > 0.9));
}

// ── Geometry ─────────────────────────────────────────────────────────────────
const geo = buildTunnelGeometry(s, dims);
{
  const pos = geo.getAttribute("position"), nor = geo.getAttribute("normal"), flr = geo.getAttribute("aFloor");
  const idx = geo.getIndex().array;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), vn = new THREE.Vector3();
  let wrong = 0, floorTris = 0, floorUp = 0, nonFinite = 0;
  for (let i = 0; i < idx.length; i += 3) {
    a.fromBufferAttribute(pos, idx[i]); b.fromBufferAttribute(pos, idx[i + 1]); c.fromBufferAttribute(pos, idx[i + 2]);
    n.subVectors(b, a).cross(c.clone().sub(a));
    if (n.lengthSq() < 1e-12) continue; // degenerate (zero-height wall strip)
    vn.set(0, 0, 0);
    for (const j of [idx[i], idx[i + 1], idx[i + 2]]) vn.add(new THREE.Vector3().fromBufferAttribute(nor, j));
    if (n.dot(vn) <= 0) wrong++;
    if (flr.getX(idx[i]) === 1) { floorTris++; if (n.y > 0) floorUp++; }
  }
  for (let i = 0; i < pos.array.length; i++) if (!Number.isFinite(pos.array[i]) || !Number.isFinite(nor.array[i] ?? 0)) nonFinite++;
  check("every triangle faces the way its normals point", wrong === 0, `${wrong} of ${idx.length / 3} wrong`);
  check("the walking floor faces up", floorTris > 0 && floorUp === floorTris, `${floorUp}/${floorTris}`);
  check("no NaN in positions or normals", nonFinite === 0);
  geo.computeBoundingBox();
  const bb = geo.boundingBox, { hw, T, height } = tunnelDims(dims);
  check("bounds = width + walls, floor − wall .. roof + wall",
    near(bb.max.z, hw + T, 1e-3) && near(bb.min.y, 10 + FLOOR_LIFT - T, 1e-3) && near(bb.max.y, 10 + FLOOR_LIFT + height + T, 1e-3),
    `z ${bb.max.z.toFixed(3)}, y ${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)}`);
}

// ── Holes ────────────────────────────────────────────────────────────────────
const RES = 1024, W = 1024, texel = W / RES;
const texelOf = (wx, wz) => Math.floor((wz + W / 2) / texel) * RES + Math.floor((wx + W / 2) / texel);
{
  const buf = new Uint8Array(RES * RES);
  const n = rasterizeTunnelHoles(s, dims, () => 10, buf, RES, W);
  check("flat ground at floor level is opened inside the tube", n > 0 && buf[texelOf(0, 0)] === 255, `${n} texels`);
  check("…but not past either portal", buf[texelOf(-21, 0)] === 0 && buf[texelOf(21, 0)] === 0);
  check("…and not beside the tube", buf[texelOf(0, 5.5)] === 0 && buf[texelOf(0, -5.5)] === 0);
  check("…and inside the half-wall line", buf[texelOf(0, 4.2)] === 255);
}
{
  const buf = new Uint8Array(RES * RES);
  check("ground above the tube's top (a mountain) stays closed",
    rasterizeTunnelHoles(s, dims, () => 10 + 7 + 1 + 5, buf, RES, W) === 0);
  check("ground well below the floor stays closed",
    rasterizeTunnelHoles(s, dims, () => 10 - 5, buf, RES, W) === 0);
}
{
  // A hillside rising along the tunnel: only the strip where the ground crosses the tube opens.
  const buf = new Uint8Array(RES * RES);
  rasterizeTunnelHoles(s, dims, (wx) => 10 + Math.max(0, wx + 20) * 0.5, buf, RES, W);
  check("hillside: open at the mouth", buf[texelOf(-18, 0)] === 255);
  check("hillside: closed deep inside where the ground is over the roof", buf[texelOf(10, 0)] === 0);
}

// ── Splat map: two hole sources ──────────────────────────────────────────────
{
  const sm = new SplatMap();
  const stamp = (layer, cx, cz, r) => sm.applySplatStroke({ cx, cz, radius: r, strength: 1, falloff: 0, activeLayer: layer });
  const px = (wx, wz) => (Math.floor((wz + WORLD_SIZE / 2) / WORLD_SIZE * SPLAT_RES) * SPLAT_RES + Math.floor((wx + WORLD_SIZE / 2) / WORLD_SIZE * SPLAT_RES));
  stamp(HOLE_LAYER, 100, 100, 6);           // a painted hole
  const proc = new Uint8Array(SPLAT_RES * SPLAT_RES);
  proc[px(-100, -100)] = 255;               // a tool hole elsewhere
  proc[px(100, 100)] = 255;                 // and one overlapping the painted hole
  sm.setProcHoles(proc);
  check("tool holes show in the channel", sm.holeAt(-100 + 0.1, -100 + 0.1) > 0);
  sm.setProcHoles(null);
  check("clearing tool holes leaves the painted hole", sm.holeAt(100, 100) > 0.9);
  check("…and removes the tool-only hole", sm.data1[(px(-100, -100) << 2) + 3] === 0);

  sm.setProcHoles(proc);
  stamp(HOLE_ERASE_LAYER, -100, -100, 4);
  check("Alt-fill on the hole card cannot close a tool hole", sm.data1[(px(-100, -100) << 2) + 3] === 255);

  const saved = sm.exportCombined();
  const off = SPLAT_RES * SPLAT_RES * 4;
  check("save writes painted holes only", saved[off + (px(-100, -100) << 2) + 3] === 0 && saved[off + (px(100, 100) << 2) + 3] === 255);

  // A paint undo patch must not bring back a tool hole that has since gone.
  const rect = { x: 0, y: 0, w: SPLAT_RES, h: SPLAT_RES };
  const patch = sm.copyRect(rect);
  sm.setProcHoles(null);
  sm.pasteRect(patch);
  check("undoing paint recomposes against the CURRENT tool holes", sm.data1[(px(-100, -100) << 2) + 3] === 0 && sm.holeAt(100, 100) > 0.9);

  // Loading a file: its alpha becomes the painted holes, tool holes re-apply.
  sm.setProcHoles(proc);
  sm.setCombined(saved);
  check("load keeps tool holes composed on top of the file's holes",
    sm.data1[(px(-100, -100) << 2) + 3] === 255 && sm.holeUser[px(-100, -100)] === 0);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
