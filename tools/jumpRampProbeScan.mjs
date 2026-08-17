// WHAT CAN A WHEEL PROBE SEE AT THE LIP?
//
// The tyre probe fires along CHASSIS-down, not world-down (modularRoadVehicle
// line ~1992), and on this ramp the chassis is pitched ~30° nose-up at the lip —
// so the probe rays and the anti-tunnel sphere sweep both lean BACKWARDS, into
// the ramp's vertical END CAP and its side walls, which `collision:"both"` put
// in the same deck BVH as the drive surface.
//
// This runs the exact _probeGround geometry (10-ray bottom semicircle + sphere
// sweep, pad 0.6, far 1.6) over a grid of hub poses near the lip, against each
// face group on its own, and reports which face wins and what NORMAL it hands
// the suspension. A near-horizontal "ground normal" is the bug.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(ROOT, `.jumprampscan.${process.pid}.mjs`);
writeFileSync(TMP, readFileSync(join(ROOT, "v3/play/modularRoadVehicle.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};"));
const { TIRE, WHEEL } = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const { jumpRampGeometry } =
  await import(new URL("../games/modular-road-v3/modularRoadParkour.js", import.meta.url).href);
const { RoadBvh } = await import(new URL("../v3/play/modularRoadBvh.js", import.meta.url).href);

const W = 14, L = 22, H = 8, R2D = 57.2958;
const surfY = (z) => (z > 0 || z < -L ? null : H * (1 - Math.cos((Math.PI / 2) * (-z / L))));
const surfDeg = (z) => Math.atan((H * (Math.PI / 2) * Math.sin((Math.PI / 2) * (-z / L))) / L) * R2D;

function classify(geo) {
  const p = geo.getAttribute("position");
  const g = { top: [], bottom: [], side: [], endcap: [] };
  const hw = W / 2;
  for (let i = 0; i < p.count; i += 3) {
    const xs = [p.getX(i), p.getX(i + 1), p.getX(i + 2)];
    const ys = [p.getY(i), p.getY(i + 1), p.getY(i + 2)];
    const zs = [p.getZ(i), p.getZ(i + 1), p.getZ(i + 2)];
    if (zs.every((z) => Math.abs(z + L) < 1e-4)) g.endcap.push(i, i + 1, i + 2);
    else if (ys.every((y) => y < 1e-6)) g.bottom.push(i, i + 1, i + 2);
    else if (xs.every((x) => Math.abs(x - hw) < 1e-4) || xs.every((x) => Math.abs(x + hw) < 1e-4))
      g.side.push(i, i + 1, i + 2);
    else g.top.push(i, i + 1, i + 2);
  }
  return g;
}

const base = jumpRampGeometry(W, L, H, 32);
const groups = classify(base);
const bvhFor = (keys) => {
  const g = base.clone();
  g.setIndex(keys.flatMap((k) => groups[k]));
  const m = new THREE.Mesh(g);
  m.updateMatrixWorld(true);
  const b = new RoadBvh();
  b.bakeFromMeshes([m]);
  return b;
};
const PARTS = ["top", "bottom", "side", "endcap"];
const bvh = Object.fromEntries(PARTS.map((k) => [k, bvhFor([k])]));

console.log(`TIRE: rayPadAbove ${TIRE.rayPadAbove}  rayLength ${TIRE.rayLength}  far ${TIRE.rayPadAbove + TIRE.rayLength}`);
console.log(`      rayRingCount ${TIRE.rayRingCount}  rayRingScale ${TIRE.rayRingScale}  sphereSweep ${TIRE.useSphereSweep} × ${TIRE.sphereSweepScale}`);
console.log(`WHEEL.radius ${WHEEL.radius}  →  ring radius ${(WHEEL.radius * TIRE.rayRingScale).toFixed(3)} m, sweep sphere ${(WHEEL.radius * TIRE.sphereSweepScale).toFixed(3)} m\n`);

/** Exactly Tire._probeGround, but per face group, so the winner can be named. */
function probe(hub, pitchDeg, part) {
  const pitch = pitchDeg / R2D;
  // Car faces -Z; nose-up pitch rotates chassis-up toward +Z.
  const up = new THREE.Vector3(0, Math.cos(pitch), Math.sin(pitch));
  const down = up.clone().negate();
  const wheelFwd = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch));
  const pad = TIRE.rayPadAbove, far = TIRE.rayLength + pad;
  const ringN = Math.round(TIRE.rayRingCount);
  const ringR = WHEEL.radius * TIRE.rayRingScale;
  const B = bvh[part];

  let best = null;
  const consider = (hit, dist) => {
    if (!hit) return;
    const d = dist !== undefined ? dist : hit.distance;
    if (!best || d < best.d) best = { d, n: hit.normal, p: hit.point, via: hit.via };
  };
  const o = new THREE.Vector3();
  for (let i = 0; i < ringN; i++) {
    const a = Math.PI * (i / (ringN - 1));
    const ca = Math.cos(a), sa = Math.sin(a);
    o.copy(hub).addScaledVector(up, pad).addScaledVector(wheelFwd, ca * ringR).addScaledVector(down, sa * ringR);
    const h = B.raycastFirst(o, down, far);
    if (h) consider({ ...h, via: `ray${i}` }, h.distance + sa * ringR);
  }
  if (TIRE.useSphereSweep) {
    o.copy(hub).addScaledVector(up, pad);
    const sr = WHEEL.radius * TIRE.sphereSweepScale;
    const sh = B.spherecast(o.x, o.y, o.z, sr, down.x, down.y, down.z, far);
    if (sh) consider({ normal: sh.normal, point: sh.point, via: "sweep" }, sh.distance + sr);
  }
  return best;
}

/**
 * Walk the hub up the last stretch of ramp at the pose the car actually holds:
 * riding ~WHEEL.radius above the surface, pitched to the local slope.
 */
console.log("=== WHEEL PROBE ALONG THE LAST 4 m OF RAMP AND OFF THE LIP ===");
console.log("   (hub rides on the surface, chassis pitched to the local slope)\n");
console.log("      z    surfY  pitch |   winning face   dist    normal (x,y,z)      n·world-up   via");
for (let z = -17; z >= -25.5; z -= 0.5) {
  const onRamp = z >= -L;
  const sy = onRamp ? surfY(z) : H;
  const pitch = onRamp ? surfDeg(z) : surfDeg(-L + 0.001);
  const hub = new THREE.Vector3(0, sy + WHEEL.radius, z);
  const hits = PARTS.map((p) => ({ p, h: probe(hub, pitch, p) })).filter((o) => o.h);
  hits.sort((a, b) => a.h.d - b.h.d);
  if (!hits.length) {
    console.log(`  ${z.toFixed(1).padStart(6)} ${sy.toFixed(2).padStart(7)} ${pitch.toFixed(1).padStart(6)}° |   (no contact)`);
    continue;
  }
  const w = hits[0];
  const n = w.h.n;
  const ny = n.y;
  const flag = ny < 0.5 ? "   <== NOT A FLOOR" : "";
  console.log(
    `  ${z.toFixed(1).padStart(6)} ${sy.toFixed(2).padStart(7)} ${pitch.toFixed(1).padStart(6)}° |` +
    ` ${w.p.padStart(9)}  ${w.h.d.toFixed(3).padStart(6)}` +
    `  (${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)})` +
    `   ${ny.toFixed(2).padStart(6)}   ${String(w.h.via).padStart(6)}${flag}`,
  );
}

console.log("\n=== SAME SCAN, but the car is a bit NOSE-HIGH (landing/bounce attitude) ===");
console.log("      z   pitch |   winning face   dist    normal              n·up    via");
for (const extra of [10, 20, 30]) {
  console.log(`   --- slope + ${extra}° ---`);
  for (let z = -19; z >= -24; z -= 0.5) {
    const onRamp = z >= -L;
    const sy = onRamp ? surfY(z) : H;
    const pitch = (onRamp ? surfDeg(z) : surfDeg(-L + 0.001)) + extra;
    const hub = new THREE.Vector3(0, sy + WHEEL.radius, z);
    const hits = PARTS.map((p) => ({ p, h: probe(hub, pitch, p) })).filter((o) => o.h);
    hits.sort((a, b) => a.h.d - b.h.d);
    if (!hits.length) { console.log(`  ${z.toFixed(1).padStart(6)} ${pitch.toFixed(0).padStart(5)}° |   (no contact)`); continue; }
    const w = hits[0], n = w.h.n;
    const flag = n.y < 0.5 ? "   <== NOT A FLOOR" : "";
    console.log(
      `  ${z.toFixed(1).padStart(6)} ${pitch.toFixed(0).padStart(5)}° | ${w.p.padStart(9)}  ${w.h.d.toFixed(3).padStart(6)}` +
      `  (${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)})  ${n.y.toFixed(2).padStart(5)}  ${String(w.h.via).padStart(6)}${flag}`,
    );
  }
}
console.log("");
