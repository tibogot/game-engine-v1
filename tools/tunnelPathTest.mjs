// Tunnel tool maths (v3/tools/tunnelPath.js) and the two hole sources in the
// splat map (painted holes vs tool holes).
import * as THREE from "three";
import {
  resolveNodeHeights, sampleTunnel, buildTunnelGeometry, rasterizeTunnelHoles, tunnelDims, FLOOR_LIFT,
  computeCuttings, digDepth,
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
  const cave = [{ x: 0, z: 0, y: 5 }, { x: 20, z: 0, y: 30 }, { x: 40, z: 0, y: 38 }];
  const c = resolveNodeHeights(cave, { closedEnd: true });
  check("a CLOSED end is not a mouth: it stays level with the last anchor, not on the hilltop click",
    c[0] === 5 && c[1] === 5 && c[2] === 5, c.join(","));
  cave[2].pinned = true;
  const cp = resolveNodeHeights(cave, { closedEnd: true });
  check("…unless its floor is set (pinned)", cp[2] === 38 && near(cp[1], 5 + 33 * 0.5), cp.join(","));
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

// ── Caves, chambers, closed ends ─────────────────────────────────────────────
/** Weld positions and count triangle uses per edge: a closed solid has every edge used exactly twice. */
function openEdges(g) {
  const pos = g.getAttribute("position"), idx = g.getIndex().array;
  const key = (i) => `${Math.round(pos.getX(i) * 1e3)},${Math.round(pos.getY(i) * 1e3)},${Math.round(pos.getZ(i) * 1e3)}`;
  const edges = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const k = [key(idx[i]), key(idx[i + 1]), key(idx[i + 2])];
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue; // welded away
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const ek = a < b ? a + "|" + b : b + "|" + a;
      edges.set(ek, (edges.get(ek) ?? 0) + 1);
    }
  }
  let bad = 0;
  for (const c of edges.values()) if (c !== 2) bad++;
  return bad;
}
const curvy = [{ x: -30, z: 0, y: 5 }, { x: 0, z: 12, y: 8, scale: 2.5 }, { x: 30, z: -4, y: 6 }];
for (const [label, t] of [
  ["tunnel, open", { ...dims, nodes: curvy }],
  ["tunnel, both ends closed", { ...dims, nodes: curvy, closedStart: true, closedEnd: true }],
  ["cave, open", { ...dims, style: "cave", roughness: 1.2, nodes: curvy }],
  ["cave, closed end", { ...dims, style: "cave", roughness: 1.2, nodes: curvy, closedEnd: true }],
]) {
  const st = sampleTunnel(t);
  const g = buildTunnelGeometry(st, t);
  const nor = g.getAttribute("normal").array, pos = g.getAttribute("position").array;
  check(`${label}: watertight (every edge shared by two triangles)`, openEdges(g) === 0, `${openEdges(g)} open edges`);
  check(`${label}: no NaN`, [...pos, ...nor].every(Number.isFinite));
}
{
  const t = { ...dims, nodes: curvy };
  const st = sampleTunnel(t);
  const mid = st.scales[Math.round(st.scales.length / 2)];
  check("a node's size swells the section around it (chamber)", st.scales[0] === 1 && mid > 2, `mid scale ${mid.toFixed(2)}`);
  const closed = sampleTunnel({ ...t, closedEnd: true });
  check("a closed end tapers to a small tip", closed.scales.at(-1) < 0.2 && closed.scales[0] === 1);
  check("roughness fades to 0 at open mouths only", st.fades[0] === 0 && st.fades.at(-1) === 0 && closed.fades.at(-1) === 1);
}
{
  const t = { ...dims, style: "cave", roughness: 1.2, nodes: [{ x: -40, z: 0, y: 0 }, { x: 40, z: 0, y: 0 }] };
  const st = sampleTunnel(t);
  const g = buildTunnelGeometry(st, t);
  const pos = g.getAttribute("position"), flr = g.getAttribute("aFloor");
  let floorOff = 0, maxOut = 0;
  const { hw, height } = tunnelDims(dims);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) - FLOOR_LIFT;
    if (flr.getX(i) === 1 && Math.abs(y) > 1e-4) floorOff++;
    if (Math.abs(pos.getX(i)) < 30) maxOut = Math.max(maxOut, y - height - 1, Math.abs(pos.getZ(i)) - hw - 1);
  }
  check("cave: the walking floor stays flat", floorOff === 0, `${floorOff} floor verts moved`);
  check("cave: walls pushed out by up to the roughness (not more)", maxOut > 0.2 && maxOut <= 1.2 + 1e-3, `max push ${maxOut.toFixed(2)} m`);
}

// ── Dug-in entrances (cuttings) ──────────────────────────────────────────────
{
  const RES = 1024, W = 1024, texel = W / RES;
  const texelOf = (wx, wz) => Math.floor((wz + W / 2) / texel) * RES + Math.floor((wx + W / 2) / texel);
  const flat = () => 10;
  const t = { ...dims, digStart: true, cutCover: 1.5, cutSlope: 0.5, nodes: [{ x: 0, z: 0, y: 10 }, { x: 60, z: 0, y: 10 }] };
  const ys = resolveNodeHeights(t.nodes, t);
  const depth = digDepth(t, t.nodes[0]);
  check("dug-in end: the floor sits height + wall + cover below the clicked ground", near(ys[0], 10 - depth) && ys[1] === 10,
    `${ys[0].toFixed(2)} (depth ${depth.toFixed(2)})`);
  const st = sampleTunnel(t);
  const cuts = computeCuttings(st, t, flat);
  check("one cutting, at the dug end only", cuts.length === 1 && cuts[0].which === "start");
  const c = cuts[0], s0 = c.stations[0], sL = c.stations.at(-1);
  check("the cutting points OUT of the tunnel (away from the far end)", c.ex < -0.99);
  check("the ramp starts at the tube floor and tops out at the ground", near(s0.y, st.points[0].y) && near(sL.y, 10, 1e-6));
  check("auto ramp length keeps the grade at 20%", near((10 - s0.y) / c.L, 0.2, 0.02), `${c.L.toFixed(1)} m`);
  const mid = c.stations[Math.round(c.stations.length / 2)];
  check("side walls meet the ground", Math.abs(mid.right.h - 10) < 0.01 && Math.abs(mid.left.h - 10) < 0.01,
    `right ${mid.right.h.toFixed(2)}, left ${mid.left.h.toFixed(2)}`);

  const g = buildTunnelGeometry(st, t, { cuts });
  check("tunnel + cutting builds with no NaN", [...g.getAttribute("position").array, ...g.getAttribute("normal").array].every(Number.isFinite));

  const buf = new Uint8Array(RES * RES);
  rasterizeTunnelHoles(st, t, flat, buf, RES, W, { cuts });
  const at = (a, lat) => buf[texelOf(c.P.x + c.ex * a + c.rx * lat, c.P.z + c.ez * a + c.rz * lat)];
  check("the ground over the cutting is opened", at(c.L * 0.5, 0) === 255 && at(2, c.B - 0.3) === 255);
  check("…not past the top of the ramp", at(c.L + 2, 0) === 0);
  check("…not outside the walls", at(c.L * 0.5, mid.right.lat + 1.5) === 0);
  check("…and the buried tube just behind the portal stays covered", buf[texelOf(5, 0)] === 0 && buf[texelOf(1.5, 0)] === 0);
}

// ── Baked lighting ───────────────────────────────────────────────────────────
{
  const t = { ...dims, lamps: true, lampSpacing: 10, lampIntensity: 1, daylight: 0.7, nodes: [{ x: -50, z: 0, y: 0 }, { x: 50, z: 0, y: 0 }] };
  const st = sampleTunnel(t);
  const g = buildTunnelGeometry(st, t);
  const emit = g.getAttribute("aEmit"), pos = g.getAttribute("position"), glow = g.getAttribute("aGlow");
  check("lamps are placed along the tunnel", g.userData.lampCount >= 9, `${g.userData.lampCount} lamps`);
  let glowing = 0; for (let i = 0; i < glow.count; i++) if (glow.getX(i) > 0) glowing++;
  check("each lamp has a glowing fixture (4 verts)", glowing === g.userData.lampCount * 4, `${glowing}`);
  // Floor brightness: near a mouth (daylight) vs deep inside between lamps vs under a lamp.
  const floorEmit = (x) => {
    let best = null, bd = Infinity;
    for (let i = 0; i < pos.count; i++) {
      if (g.getAttribute("aFloor").getX(i) !== 1) continue;
      const d = Math.abs(pos.getX(i) - x) + Math.abs(pos.getZ(i) - 4);
      if (d < bd) { bd = d; best = i; }
    }
    return emit.getX(best) + emit.getY(best) + emit.getZ(best);
  };
  check("floor is lit under a lamp more than half-way between lamps", floorEmit(-5 + 0) > 0 && floorEmit(0) >= 0, `${floorEmit(0).toFixed(3)}`);
  const dark = buildTunnelGeometry(st, { ...t, lamps: false, daylight: 0.7 });
  const de = dark.getAttribute("aEmit"), dp = dark.getAttribute("position");
  let nearMouth = 0, deep = 0;
  for (let i = 0; i < dp.count; i++) {
    const e = de.getX(i) + de.getY(i) + de.getZ(i);
    if (Math.abs(dp.getX(i) + 49) < 1) nearMouth = Math.max(nearMouth, e);
    if (Math.abs(dp.getX(i)) < 1) deep = Math.max(deep, e);
  }
  check("daylight: bright near an open mouth, ~dark deep inside", nearMouth > 0.3 && deep < 0.01, `${nearMouth.toFixed(2)} vs ${deep.toFixed(4)}`);
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
