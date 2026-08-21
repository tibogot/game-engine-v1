// Road block — jersey prism, painted stripes, one FrontSide mesh.
//
// The claim is the silhouette (wide foot, toe, handle trough) plus two red
// bands, without a second stripe mesh sitting on the faces. Geometry is the
// thing that drifts: invert a cap winding and the ends vanish; drop the trough
// and it reads as a wedge. Both are asserted from the real make().
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadProps.js"), "utf8");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { PROP_CATALOG, ROAD_BLOCK_COLORS } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);

const def = PROP_CATALOG.find((d) => d.id === "roadblock");

console.log("=== CATALOG ===");
{
  check("roadblock is in the obstacles catalog", !!def && def.label === "Road block");
  check("solid collision (not a deck)", def?.collision === "solid");
  check("white + red variants (instance tint, no stripe texture)",
    Array.isArray(def?.variants) && def.variants.length === 2
    && ROAD_BLOCK_COLORS.length === 2
    && !SRC.includes("roadBlockStripeTexture"));
}

console.log("\n=== ONE FRONTSIDE PRISM ===");
{
  const root = def.make();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  check("one mesh", meshes.length === 1, `${meshes.length} meshes`);
  const mesh = meshes[0];
  check("FrontSide", mesh.material.side === THREE.FrontSide);
  check("sits on the ground", Math.abs(mesh.geometry.boundingBox.min.y) < 1e-6);
  const tris = mesh.geometry.attributes.position.count / 3;
  check("under 80 triangles", tris < 80, `${tris} tris`);
  check("no stripe map — colour is instance tint", !mesh.material.map);
  check("tintable for white/red variants", mesh.userData.tintable === true);

  const pos = mesh.geometry.attributes.position;
  const nrm = mesh.geometry.attributes.normal;
  const box = mesh.geometry.boundingBox;
  const baseW = box.max.z - box.min.z;
  const topY = box.max.y;
  let topW = 0;
  let troughY = topY;
  const P = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    P.fromBufferAttribute(pos, i);
    if (P.y > topY - 0.02) topW = Math.max(topW, 2 * Math.abs(P.z));
    if (Math.abs(P.z) < 0.05) troughY = Math.min(troughY, P.y);
  }
  check("jersey: base wider than the top lips",
    baseW > 0.5 && topW > 0 && topW < baseW * 0.5,
    `base ${baseW.toFixed(2)} m, top ${topW.toFixed(2)} m`);
  check("handle trough is cut into the top",
    troughY < topY - 0.05, `trough ${troughY.toFixed(2)} vs top ${topY.toFixed(2)}`);

  let frontOut = 0, frontIn = 0, capOut = 0, capIn = 0, topUp = 0;
  const hx = (mesh.geometry.boundingBox.max.x - mesh.geometry.boundingBox.min.x) / 2;
  for (let i = 0; i < pos.count; i += 3) {
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    if (z > 0.25 && y < 0.2) (nz > 0.5 ? frontOut++ : frontIn++);
    if (x > hx - 0.05) (nx > 0.5 ? capOut++ : capIn++);
    if (ny > 0.85 && y > topY - 0.02) topUp++;
  }
  check("foot faces outward (+Z)", frontOut > 0 && frontIn === 0,
    `${frontOut} out / ${frontIn} in`);
  check("+X cap faces out", capOut > 0 && capIn === 0,
    `${capOut} out / ${capIn} in`);
  check("top lips face up", topUp > 0, `${topUp} tris`);
}

console.log("\n=== INSTANCER ===");
{
  const it = Object.create(PropInstancer.prototype);
  it.catalog = PROP_CATALOG;
  it._templates = new Map();
  it._m4 = new THREE.Matrix4();
  const parts = it._template("roadblock");
  check("one instanced part", parts?.length === 1, `${parts?.length} parts`);
}

console.log(fail === 0 ? "\nAll road-block checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
