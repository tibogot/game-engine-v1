// Open cylinder — one FrontSide lathe, not four DoubleSide cylinders.
//
// The obstacle used to be outer + inner + two caps, 40 segments, outer DoubleSide.
// Kit Tunnel (air) was a second, denser arch for the same job as a kit tunnel
// piece; it is gone. This pins both: the catalog no longer ships that prop, and
// the remaining pipe is one mesh whose FrontSide shows the bore from inside.
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
const { PROP_CATALOG } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);
const { PropInstancer } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadPropInstancer.js")).href);

console.log("=== TUNNEL (AIR) IS GONE ===");
{
  check("no airtunnel catalog entry",
    !PROP_CATALOG.some((d) => d.id === "airtunnel"));
  check("no airTunnelGeometry helper",
    !SRC.includes("airTunnelGeometry"));
  check("props no longer import the kit tunnel sweep",
    !SRC.includes("buildTunnelGeometry"));
}

console.log("\n=== OPEN CYLINDER IS ONE FRONTSIDE LATHE ===");
{
  const def = PROP_CATALOG.find((d) => d.id === "tube");
  check("open cylinder is still in the catalog", !!def);
  const root = def.make();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  check("one mesh", meshes.length === 1, `${meshes.length} meshes`);
  const mesh = meshes[0];
  check("FrontSide (not DoubleSide / BackSide)",
    mesh.material.side === THREE.FrontSide);
  // Was a single Lathe profile; thickWallTubeGeometry replaced it with split
  // inner/outer shells + flat ring caps merged into one BufferGeometry. The
  // facing checks below are what actually matter, so pin the replacement
  // rather than the old class name.
  check("one merged BufferGeometry, not the old Lathe profile",
    mesh.geometry.type === "BufferGeometry", mesh.geometry.type);

  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const idx = geo.index;
  const innerR = 9 - 0.65;
  const outerR = 9;
  const half = 15;
  let innerIn = 0, innerOut = 0, outerOut = 0, outerIn = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const N = new THREE.Vector3(), P = new THREE.Vector3(), radial = new THREE.Vector3();
  for (let i = 0; i < idx.count; i += 3) {
    A.fromBufferAttribute(pos, idx.getX(i));
    B.fromBufferAttribute(pos, idx.getX(i + 1));
    C.fromBufferAttribute(pos, idx.getX(i + 2));
    N.subVectors(B, A).cross(C.clone().sub(A)).normalize();
    P.copy(A).add(B).add(C).multiplyScalar(1 / 3);
    const r = Math.hypot(P.x, P.z);
    radial.set(P.x, 0, P.z);
    if (radial.lengthSq() < 1e-8) continue;
    radial.normalize();
    const mid = Math.abs(P.y) < half - 0.3;
    if (Math.abs(r - innerR) < 0.2 && mid) (N.dot(radial) < -0.5 ? innerIn++ : innerOut++);
    else if (Math.abs(r - outerR) < 0.2 && mid) (N.dot(radial) > 0.5 ? outerOut++ : outerIn++);
  }
  check("inner wall faces the bore (FrontSide from inside)",
    innerIn > 0 && innerOut === 0, `${innerIn} in / ${innerOut} out`);
  check("outer wall faces out (FrontSide from outside)",
    outerOut > 0 && outerIn === 0, `${outerOut} out / ${outerIn} in`);
}

console.log("\n=== INSTANCER COLLAPSES TO ONE PART ===");
{
  const it = Object.create(PropInstancer.prototype);
  it.catalog = PROP_CATALOG;
  it._templates = new Map();
  it._m4 = new THREE.Matrix4();
  const parts = it._template("tube");
  check("one instanced part", parts?.length === 1, `${parts?.length} parts`);
}

console.log(fail === 0 ? "\nAll open-cylinder checks passed." : `\n${fail} check(s) FAILED.`);
process.exit(fail === 0 ? 0 : 1);
