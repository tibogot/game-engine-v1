/**
 * RTS PROPS: NO COPLANAR OVERLAPS (z-fighting).
 *
 * Two triangles of one merged prop lying in the same plane and overlapping
 * shimmer as the camera moves — the depth test cannot decide between them.
 * Every case found on the firebase kit (2026-09) was a part ending EXACTLY on
 * another's face: a roof sheet on a casting, a wall on a post, a crossed brace
 * in its partner's plane, a triangle-fan cap folding over itself. Each fix
 * tucked one part into the other or stood it off by a centimetre.
 *
 * Checked: every pair of triangles that share a plane (normal to ~1°, offset
 * to 2.5 mm) and whose outlines overlap once shrunk 3% toward their centres —
 * the shrink leaves triangles that only share an EDGE (the two halves of a
 * box face) alone. Downward faces at ground level are exempt: they are the
 * bottoms of things standing on the terrain and can never be seen.
 *
 *   node tools/rtsPropsCoplanarTest.mjs
 */
import {
  buildConex, buildConexYard, buildContainer, buildCrateStack, buildFuelDump, buildGuardTower, buildGunPit,
  buildGate, buildRadioStation, buildTent,
} from "../v3/render/objects/rtsFirebaseProps.js";
import { buildCorrugatedPanel, buildTrapezoidPanel, MAT } from "../v3/render/objects/rtsParts.js";

import { buildDoorLeaf, buildQuonsetShellGeometry } from "../v3/render/objects/rtsQuonset.js";
import { buildGunPitBody, buildGunPitGun, buildHelipad } from "../v3/render/objects/rtsBuildables.js";

let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}${extra ? "  " + extra : ""}`);
  else { failed++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
};

/** Visible coplanar overlapping pairs in a geometry, with the first one found. */
function coplanarOverlaps(geo) {
  const p = geo.attributes.position, idx = geo.index;
  const nt = idx ? idx.count / 3 : p.count / 3;
  const vi = (k) => (idx ? idx.getX(k) : k);
  const V = (i) => [p.getX(i), p.getY(i), p.getZ(i)];
  const buckets = new Map();
  for (let t = 0; t < nt; t++) {
    const a = V(vi(3 * t)), b = V(vi(3 * t + 1)), c = V(vi(3 * t + 2));
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-7) continue;
    n = n.map((x) => x / len);
    const y = (a[1] + b[1] + c[1]) / 3;
    if (n[1] < -0.9 && y < 0.35) continue;               // a bottom on the ground
    const d = n[0] * a[0] + n[1] * a[1] + n[2] * a[2];
    const key = n.map((x) => Math.round(x * 50)).join(",") + "|" + Math.round(d * 400);
    const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : (Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2);
    const pr = (q) => (ax === 0 ? [q[1], q[2]] : ax === 1 ? [q[0], q[2]] : [q[0], q[1]]);
    let P = [pr(a), pr(b), pr(c)];
    const cx = (P[0][0] + P[1][0] + P[2][0]) / 3, cy = (P[0][1] + P[1][1] + P[2][1]) / 3;
    P = P.map(([x, z]) => [cx + (x - cx) * 0.97, cy + (z - cy) * 0.97]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ P, at: [a, b, c].map((q) => q.map((x) => +x.toFixed(2))) });
  }
  const separated = (A, B) => {
    for (const T of [A, B]) {
      for (let i = 0; i < 3; i++) {
        const [x1, y1] = T[i], [x2, y2] = T[(i + 1) % 3];
        const nx = y2 - y1, ny = x1 - x2;
        let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
        for (const q of A) { const s = q[0] * nx + q[1] * ny; amin = Math.min(amin, s); amax = Math.max(amax, s); }
        for (const q of B) { const s = q[0] * nx + q[1] * ny; bmin = Math.min(bmin, s); bmax = Math.max(bmax, s); }
        if (amax <= bmin || bmax <= amin) return true;
      }
    }
    return false;
  };
  let pairs = 0, first = null;
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!separated(list[i].P, list[j].P)) { pairs++; first ??= [list[i].at, list[j].at]; }
      }
    }
  }
  return { pairs, first, tris: nt };
}

const check = (name, geo) => {
  const r = coplanarOverlaps(geo);
  ok(`${name} has no coplanar overlaps`, r.pairs === 0,
    r.pairs ? `${r.pairs} pairs, e.g. ${JSON.stringify(r.first)}` : `${r.tris} tris`);
};

console.log("sheet parts");
check("corrugated panel (strip-capped ends)", buildCorrugatedPanel({ width: 2, height: 1.8, ribs: 9 }));
check("trapezoid panel", buildTrapezoidPanel({ width: 3, height: 2.5 }));

console.log("firebase props");
check("guard tower", buildGuardTower());
check("fuel dump", buildFuelDump());
check("gun pit", buildGunPit());
check("crate stack", buildCrateStack());
check("tent (blast wall)", buildTent());
check("tent (open)", buildTent({ blastWall: false }));
check("conex", buildConex());
check("conex yard", buildConexYard());
check("container (olive)", buildContainer());
check("container (camo)", buildContainer({ mat: MAT.camo }));
check("radio station", buildRadioStation());
check("camp gate", buildGate());
check("helipad", buildHelipad());
check("gun pit body (M60 post)", buildGunPitBody());
check("M60", buildGunPitGun());

console.log("Quonset HQ");
check("quonset shell", buildQuonsetShellGeometry().shellGeo);
check("quonset door leaf", buildDoorLeaf(3.94, 5.45, 51));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
