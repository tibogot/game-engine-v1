// Is the jump ramp's DRIVE SURFACE consistently wound?
//
// jumpRampProbeScan saw the deck BVH hand back face normals that flipped sign
// between adjacent bands of the same surface — (0, +0.87, +0.49) on one strip,
// (0, −0.87, −0.49) on the next. Both consumers currently re-orient it (the BVH's
// closestPointWithNormal points it at the query, the tyre negates it toward
// chassis-up), so nothing is visibly broken — but a surface whose normals
// disagree with each other is one un-oriented consumer away from being a bug.
import * as THREE from "three";
const { jumpRampGeometry, kickerRampGeometry } =
  await import(new URL("../../games/modular-road-v3/modularRoadParkour.js", import.meta.url).href);

const W = 14, L = 22, H = 8;

function audit(label, geo) {
  const p = geo.getAttribute("position");
  const hw = W / 2;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const faces = { top: [], bottom: [], sideL: [], sideR: [], endcap: [] };

  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    const xs = [a.x, b.x, c.x], ys = [a.y, b.y, c.y], zs = [a.z, b.z, c.z];
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-12) continue; // degenerate (the base band is flat)
    n.normalize();
    const rec = { z: (a.z + b.z + c.z) / 3, n: n.clone() };
    // A top triangle spans BOTH rails (x = −hw and +hw); a side wall sits on one.
    if (zs.every((z) => Math.abs(z + L) < 1e-4)) faces.endcap.push(rec);
    else if (ys.every((y) => y < 1e-6)) faces.bottom.push(rec);
    else if (xs.every((x) => Math.abs(x + hw) < 1e-4)) faces.sideL.push(rec);
    else if (xs.every((x) => Math.abs(x - hw) < 1e-4)) faces.sideR.push(rec);
    else faces.top.push(rec);
  }

  console.log(`=== ${label} ===`);
  for (const [name, list] of Object.entries(faces)) {
    if (!list.length) { console.log(`   ${name.padEnd(7)} —`); continue; }
    // Expected outward direction per face, to say which way is "wrong".
    const out = { top: "y>0", bottom: "y<0", sideL: "x<0", sideR: "x>0", endcap: "z<0" }[name];
    const good = list.filter((r) => (
      name === "top" ? r.n.y > 0 : name === "bottom" ? r.n.y < 0
        : name === "sideL" ? r.n.x < 0 : name === "sideR" ? r.n.x > 0 : r.n.z < 0
    ));
    const bad = list.length - good.length;
    const mark = bad ? `  <== ${bad} INWARD-FACING` : "";
    console.log(`   ${name.padEnd(7)} ${String(list.length).padStart(3)} tris, outward should be ${out.padEnd(4)} → ${good.length} ok, ${bad} flipped${mark}`);
    if (bad) {
      const zs = list.filter((r) => !good.includes(r)).map((r) => r.z);
      console.log(`           flipped at z ≈ ${Math.max(...zs).toFixed(1)} … ${Math.min(...zs).toFixed(1)}`);
    }
  }
  console.log("");
}

audit("Jump ramp  jumpRampGeometry(14, 22, 8, 32)", jumpRampGeometry(W, L, H, 32));
audit("Convex kicker  kickerRampGeometry(14, 20, 7, 32)", kickerRampGeometry(14, 20, 7, 32));
