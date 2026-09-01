// Asphalt lot — 200 m closed slab in Parkour, drive on top, painted caps.
//
// The failure modes this is here for:
//   • scaling the kit `platform` sweep to 200 m (thousands of tris, full asphalt
//     graph on a flat square)
//   • baking the closed solid into the deck BVH (underside / lips become ground)
//   • sitting the bottom face on y=0 (z-fight with the heightfield)
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { PROP_CATALOG } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);

const def = PROP_CATALOG.find((d) => d.id === "asphaltlot");

console.log("=== CATALOG ===");
check("asphaltlot is in the parkour catalog", !!def && def.category === "parkour");
check("label is Asphalt lot", def?.label === "Asphalt lot");
check("collision both (drive on top, blocked at the lips)", def?.collision === "both");

console.log("\n=== SLAB ===");
const root = def.make();
const meshes = [];
root.traverse((o) => { if (o.isMesh) meshes.push(o); });
check("one mesh", meshes.length === 1, `${meshes.length} meshes`);
const mesh = meshes[0];
mesh.geometry.computeBoundingBox();
const box = mesh.geometry.boundingBox;
const sizeX = box.max.x - box.min.x;
const sizeZ = box.max.z - box.min.z;
const thick = box.max.y - box.min.y;
check("200 × 200 m", Math.abs(sizeX - 200) < 1e-4 && Math.abs(sizeZ - 200) < 1e-4,
  `${sizeX.toFixed(1)} × ${sizeZ.toFixed(1)}`);
check("0.8 m thick (same as the road slab)", Math.abs(thick - 0.8) < 1e-4, `${thick.toFixed(3)} m`);
check("lifted off y=0 so it does not z-fight the terrain", box.min.y > 0.05,
  `min y ${box.min.y.toFixed(3)}`);
check("twelve triangles (closed box, not a sweep)",
  mesh.geometry.getAttribute("position").count / 3 === 12,
  `${mesh.geometry.getAttribute("position").count / 3} tris`);
check("FrontSide", mesh.material.side === THREE.FrontSide);
check("does not cast shadows (ground plane)", mesh.userData.noCastShadow === true);

console.log("\n=== CAPS FACE OUT ===");
{
  const pos = mesh.geometry.getAttribute("position");
  const nrm = mesh.geometry.getAttribute("normal");
  const zone = mesh.geometry.getAttribute("aZone");
  const seen = { px: 0, nx: 0, pz: 0, nz: 0 };
  for (let i = 0; i < pos.count; i += 3) {
    if (zone.getX(i) >= 0.5) continue;
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    if (Math.abs(ny) > 0.5) continue; // underside
    if (nx > 0.5) seen.px++;
    else if (nx < -0.5) seen.nx++;
    else if (nz > 0.5) seen.pz++;
    else if (nz < -0.5) seen.nz++;
  }
  check("+X cap faces +X", seen.px === 2, `${seen.px} tris`);
  check("−X cap faces −X", seen.nx === 2, `${seen.nx} tris`);
  check("+Z cap faces +Z", seen.pz === 2, `${seen.pz} tris`);
  check("−Z cap faces −Z", seen.nz === 2, `${seen.nz} tris`);
}

console.log("\n=== ROAD ATTRIBUTES ===");
{
  const g = mesh.geometry;
  for (const name of ["aZone", "aLateral", "aPlain", "aCurve", "aAlongOffset", "uv"]) {
    check(`has ${name}`, !!g.getAttribute(name));
  }
  const plain = g.getAttribute("aPlain");
  check("aPlain is 1 (platform — no centre/edge lines)",
    plain && [...Array(plain.count)].every((_, i) => plain.getX(i) === 1));
}

console.log("\n=== DECK PROXY ===");
const deck = mesh.geometry.userData.deckGeometry;
check("has deckGeometry", !!deck);
if (deck) {
  const dt = deck.getAttribute("position").count / 3;
  check("two drive-surface tris", dt === 2, `${dt} tris`);
  const p = deck.getAttribute("position");
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  let notUp = 0, notTop = 0;
  const topY = box.max.y;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2).normalize();
    if (n.y <= 0.9) notUp++;
    if (Math.abs(a.y - topY) > 1e-4 || Math.abs(b.y - topY) > 1e-4 || Math.abs(c.y - topY) > 1e-4) notTop++;
  }
  check("every proxy triangle faces +Y", notUp === 0, `${notUp} not up`);
  check("every proxy triangle is on the deck (not a lip or the underside)", notTop === 0);
}

console.log("\n=== SOLID PROXY ===");
const solid = mesh.geometry.userData.solidGeometry;
check("has solidGeometry (lips only)", !!solid);
if (solid) {
  const st = solid.getAttribute("position").count / 3;
  check("eight lip tris (four walls)", st === 8, `${st} tris`);
  const p = solid.getAttribute("position");
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  let notWall = 0;
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2).normalize();
    if (Math.abs(n.y) > 0.1) notWall++;
  }
  check("every solid triangle is a vertical lip (not the deck or underside)", notWall === 0,
    `${notWall} not vertical`);
}

console.log("\n=== ZONES ===");
{
  const pos = mesh.geometry.getAttribute("position");
  const zone = mesh.geometry.getAttribute("aZone");
  check("carries aZone (deck vs painted cap)", !!zone);
  if (zone) {
    let deckZ = 0, capZ = 0;
    for (let i = 0; i < pos.count; i++) {
      if (zone.getX(i) >= 0.5) deckZ++;
      else capZ++;
    }
    check("six deck verts (two tris)", deckZ === 6, `${deckZ}`);
    check("thirty cap verts (ten tris: four walls + underside)", capZ === 30, `${capZ}`);
  }
}

if (fail) {
  console.log(`\n${fail} FAIL`);
  process.exit(1);
}
console.log("\nAll checks passed.");
