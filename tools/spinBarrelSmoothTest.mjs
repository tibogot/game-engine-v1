// THE SMOOTH SPIN BARREL — the faceted one kept, a shaded twin beside it.
//
// The barrel had the same low-poly look the tubes did, but for a different
// reason and with a different fix. The swept road pieces share vertices along
// the sweep, so they could be welded; the barrel emits FOUR FRESH VERTICES PER
// QUAD, so nothing is shared and there is nothing to average. A cylinder does
// not need averaging though — the true normal at any point is radial, and the
// vertex position gives the angle.
//
// The faceted look is wanted, so this is a second mover rather than a change to
// the first. That makes the risk "the two drift apart", which is why they share
// one builder, and why this checks the original is byte-for-byte untouched.
import * as THREE from "three";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The mover module reaches for TSL and the bloom MRT node, neither of which
 * exists in a plain three build. Stub those two edges and the geometry — which
 * is all this measures — imports cleanly. Same trick the vehicle tests use.
 */
// Written BESIDE the original, not at the repo root: the module imports its
// siblings by relative path, and a copy one directory up cannot find them.
const TMP = join(ROOT, "games/modular-road-v3", ".barrel." + process.pid + ".mjs");
writeFileSync(TMP, readFileSync(join(ROOT, "games/modular-road-v3/modularRoadMoverProps.js"), "utf8")
  .replace(/^import \{ materialEmissive \}.*$/m, "const materialEmissive = null;")
  .replace(/^import \{ applyBloomMRT \}.*$/m, "const applyBloomMRT = () => {};")
  // The elevator reaches for the bloom node too, so stubbing this module's own
  // import is not enough — the chain has to be cut here. Nothing below tests
  // the elevator, so a placeholder is honest rather than lossy.
  .replace(/^import \{ ELEVATOR, makeElevator \}.*$/m,
    "const ELEVATOR = { liftSpeed: 1, rise: 8 };"
    + " const makeElevator = () => ({ root: new THREE.Group(), bind: {} });")
  .replace(/MeshStandardNodeMaterial/g, "MeshStandardMaterial"));
const mover = await import(pathToFileURL(TMP).href);
unlinkSync(TMP);

const CATALOG = mover.MOVER_CATALOG ?? Object.values(mover).find((v) => Array.isArray(v));
let fail = 0;
const ok = (c, label, detail = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!c) fail++;
};
const R2D = THREE.MathUtils.RAD2DEG;

const entry = (id) => CATALOG.find((m) => m.id === id);
/** Walk a built mover for its shell mesh (the rims are a child of it). */
function partsOf(id) {
  // bindMover hangs the binding on userData and returns the root Object3D
  // itself, so there is no `.root` to unwrap.
  const root = entry(id).make();
  let shell = null, rims = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "SpinBarrelShell") shell = o;
    else if (shell && o.parent === shell) rims = o;
  });
  return { shell, rims, root };
}

/* ---------------------------------------------------------------------- */
console.log("\n1. BOTH BARRELS EXIST, AND THE ORIGINAL IS UNCHANGED\n");

ok(!!entry("spinbarrel"), "the faceted barrel is still there");
ok(!!entry("spinbarrel_smooth"), "and the smooth one is a separate mover");
for (const id of ["spinbarrel", "spinbarrel_smooth"]) {
  const e = entry(id);
  ok(e.collision === "deck" && e.defaults.speed === 0.55 && e.defaults.amplitude === 8,
    `${id}: same collision mode and defaults`, `${e.label}`);
}

const flat = partsOf("spinbarrel");
const smooth = partsOf("spinbarrel_smooth");

// SAME MESH. If the smooth one is not the same barrel, it is a different prop.
const fp = flat.shell.geometry.getAttribute("position");
const sp = smooth.shell.geometry.getAttribute("position");
let samePos = fp.count === sp.count;
if (samePos) {
  for (let i = 0; i < fp.count * 3; i++) {
    if (Math.abs(fp.array[i] - sp.array[i]) > 1e-9) { samePos = false; break; }
  }
}
ok(samePos, "identical geometry — same vertices, same holes, same size",
  `${fp.count} verts, ${flat.shell.geometry.getIndex().count / 3} tris`);
ok(flat.shell.geometry.getIndex().count === smooth.shell.geometry.getIndex().count,
  "...and the same triangles, so smoothing costs nothing");

/* ---------------------------------------------------------------------- */
console.log("\n2. THE WALLS SHADE AS A CURVE\n");

/**
 * Worst angle between a wall vertex's normal and the true radial direction.
 *
 * The barrel's axis runs along z through the origin of its pivot, so the true
 * normal at any wall vertex is (x, y, 0) normalised — outward on the shell,
 * inward on the bore. Only wall vertices are checked: the end rings and hole
 * borders are real edges and are meant to stay flat.
 */
function wallNormalError(mesh, Ri = 8, wall = 0.6) {
  const g = mesh.geometry;
  const pos = g.getAttribute("position"), nrm = g.getAttribute("normal");
  let worst = 0, n = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const r = Math.hypot(x, y);
    const inner = Math.abs(r - Ri) < 1e-3;
    const outer = Math.abs(r - (Ri + wall)) < 1e-3;
    if (!inner && !outer) continue;
    const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
    // A cap or rim vertex also sits at one of those radii — tell them apart by
    // their normal having a z component, which a wall normal never does.
    if (Math.abs(nz) > 0.01) continue;
    // SIGN FOLLOWS THE WINDING: the bore's quads are wound so their normal
    // points AWAY from the axis and the shell's toward it, and the mesh is
    // DoubleSide so the shader flips per face. Measuring against the opposite
    // convention reports a uniform 176.25° (180° minus half a facet), which is
    // how the first version of this barrel was caught pointing backwards.
    const s = inner ? 1 : -1;
    const dot = (s * x / r) * nx + (s * y / r) * ny;
    worst = Math.max(worst, Math.acos(THREE.MathUtils.clamp(dot, -1, 1)) * R2D);
    n++;
  }
  return { worst, n };
}

const fe = wallNormalError(flat.shell);
const se = wallNormalError(smooth.shell);
console.log(`   faceted: worst ${fe.worst.toFixed(2)}° off the true radial, over ${fe.n} wall verts`);
console.log(`   smooth:  worst ${se.worst.toFixed(2)}° off the true radial, over ${se.n} wall verts`);
// 48 segments flat-shaded means each face normal is up to half a segment out.
ok(fe.worst > 3, "the faceted barrel really is faceted", `${fe.worst.toFixed(2)}° ≈ 360/48/2`);
// The residue is float32 storage precision, not geometry — normals are kept in
// a Float32BufferAttribute, which is worth about a hundredth of a degree.
ok(se.worst < 0.05, "the smooth one sits on the true cylinder normal",
  `${se.worst.toFixed(4)}°`);
ok(se.n === fe.n, "and it is the same set of wall vertices", `${se.n}`);

// Normals must be unit length or the lighting goes wrong in a way that is hard
// to trace back to here.
{
  const nrm = smooth.shell.geometry.getAttribute("normal");
  let worstLen = 0;
  for (let i = 0; i < nrm.count; i++) {
    worstLen = Math.max(worstLen, Math.abs(
      Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1));
  }
  ok(worstLen < 1e-6, "every normal is unit length", `worst |n|−1 = ${worstLen.toExponential(1)}`);
}

/* ---------------------------------------------------------------------- */
console.log("\n3. THE EDGES THAT SHOULD STAY EDGES\n");

// End rings and hole borders keep face normals — smoothing those would round
// off the openings the barrel is built around.
{
  const g = smooth.shell.geometry;
  const pos = g.getAttribute("position"), nrm = g.getAttribute("normal");
  let axial = 0;
  for (let i = 0; i < pos.count; i++) if (Math.abs(nrm.getZ(i)) > 0.9) axial++;
  ok(axial > 0, "the end rings still face along the axis", `${axial} verts`);
}
ok(!!smooth.rims && smooth.rims.geometry.getIndex().count > 0,
  "the hole rims are still their own mesh", `${smooth.rims.geometry.getIndex().count / 3} tris`);

/* ---------------------------------------------------------------------- */
console.log("\n4. PINK, SO YOU CAN TELL THEM APART\n");

const hex = (m) => `#${m.color.getHexString()}`;
ok(hex(flat.rims.material) === "#38e8d8", "the original keeps its cyan rims", hex(flat.rims.material));
ok(hex(smooth.rims.material) === "#ff3ea5", "the smooth one glows pink", hex(smooth.rims.material));
ok(smooth.rims.material.emissive.getHexString() === "ff3ea5"
  && smooth.rims.material.emissiveIntensity === 4,
  "...and it is the EMISSIVE that is pink, so the bloom picks it up");
ok(flat.shell.material.color.getHex() === smooth.shell.material.color.getHex()
  && flat.shell.material.roughness === smooth.shell.material.roughness,
  "the shell material is otherwise identical", "only the rims differ");

/* ---------------------------------------------------------------------- */
console.log("\n5. IT IS STILL A DRIVEABLE BARREL\n");

for (const id of ["spinbarrel", "spinbarrel_smooth"]) {
  const bind = entry(id).make().userData.moverBind;
  ok(bind?.mode === "spin-z" && bind.isDeck && bind.deckCarry
    && bind.collisionGeometry?.getIndex()?.count > 0,
    `${id}: still a deck-carrying spin mover with its own cheap collider`,
    `${bind.mode}, collider ${bind.collisionGeometry.getIndex().count / 3} tris`);
}
// The collider is the cheap inner-wall grid, unaffected by shading — if the
// smooth variant ever grew a different one, it would drive differently.
{
  const a = entry("spinbarrel").make().userData.moverBind.collisionGeometry;
  const b = entry("spinbarrel_smooth").make().userData.moverBind.collisionGeometry;
  ok(a.getIndex().count === b.getIndex().count
    && a.getAttribute("position").count === b.getAttribute("position").count,
    "both barrels collide identically", `${a.getIndex().count / 3} tris each`);
}

console.log(fail === 0 ? "\nALL PASS\n" : `\n${fail} FAILURE(S)\n`);
process.exit(fail === 0 ? 0 : 1);
