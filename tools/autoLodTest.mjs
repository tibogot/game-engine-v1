// Automatic levels of detail (v3/render/instancing/autoLod.js): meshoptimizer
// builds the LOD1/LOD2 a built-in prop shape never had, keeping its normals and
// UVs and COMPACTING the vertex buffer (the thing the meshopt example skips).
import * as THREE from "three";
import { simplifyGeometry, simplifyEntries, countTriangles, simplifierReady } from "../v3/render/instancing/autoLod.js";

await simplifierReady;

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const tris = (g) => g.getIndex().count / 3;

// ── A sphere, the shape the audit measured at 960 triangles ──
const sphere = new THREE.SphereGeometry(1, 32, 16);
const half = simplifyGeometry(sphere, { ratio: 0.5 });
check("simplifies toward the asked ratio", tris(half) <= tris(sphere) * 0.62 && tris(half) > 0,
  `${tris(sphere)} → ${tris(half)}`);
check("keeps normals and uvs", !!half.getAttribute("normal") && !!half.getAttribute("uv"));
check("COMPACTS the vertex buffer (not just the index)",
  half.getAttribute("position").count < sphere.getAttribute("position").count,
  `${sphere.getAttribute("position").count} → ${half.getAttribute("position").count} vertices`);
check("every index is inside the compacted buffer",
  Math.max(...half.getIndex().array) < half.getAttribute("position").count);
check("attributes stay the same length as each other",
  half.getAttribute("normal").count === half.getAttribute("position").count
  && half.getAttribute("uv").count === half.getAttribute("position").count);

// The silhouette must survive: every kept vertex still near the unit sphere.
let worst = 0;
const p = half.getAttribute("position");
for (let i = 0; i < p.count; i++) worst = Math.max(worst, Math.abs(Math.hypot(p.getX(i), p.getY(i), p.getZ(i)) - 1));
check("keeps the shape (a simplified sphere is still a sphere)", worst < 0.12, `worst radius error ${worst.toFixed(3)}`);

const quarter = simplifyGeometry(sphere, { ratio: 0.2 });
check("a lower ratio gives fewer triangles", tris(quarter) < tris(half), `${tris(quarter)} < ${tris(half)}`);
check("deterministic: same input, same output", tris(simplifyGeometry(sphere, { ratio: 0.5 })) === tris(half));

// ── Guards ──
const tiny = new THREE.BufferGeometry();
tiny.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
tiny.setIndex([0, 1, 2]);
check("a mesh already below the floor is returned untouched", simplifyGeometry(tiny, { ratio: 0.5 }) === tiny);
const unindexed = new THREE.BufferGeometry();
unindexed.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
check("an unindexed mesh is returned untouched", simplifyGeometry(unindexed) === unindexed);
const positionsOnly = new THREE.BufferGeometry();
positionsOnly.setAttribute("position", sphere.getAttribute("position").clone());
positionsOnly.setIndex(Array.from(sphere.getIndex().array));
check("works without normals or uvs", tris(simplifyGeometry(positionsOnly, { ratio: 0.5 })) < tris(sphere));

// ── Prop entries: many submeshes, one material and transform each ──
const mat = { name: "m" };
const localMatrix = new THREE.Matrix4().makeTranslation(1, 2, 3);
const entries = [
  { geometry: sphere, material: mat, localMatrix },
  { geometry: new THREE.TorusKnotGeometry(1, 0.3, 64, 12), material: mat, localMatrix },
];
const lod1 = simplifyEntries(entries, { ratio: 0.4 });
check("a type's submeshes each get a simplified copy", lod1.length === entries.length);
check("…sharing the material and transform", lod1[0].material === mat && lod1[0].localMatrix === localMatrix);
check("…and really costing less", countTriangles(lod1) < countTriangles(entries) * 0.6,
  `${countTriangles(entries)} → ${countTriangles(lod1)} triangles`);
check("entries that cannot shrink report nothing to register",
  simplifyEntries([{ geometry: tiny, material: mat, localMatrix }], { ratio: 0.5 }) === null);

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
