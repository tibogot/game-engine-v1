// RoadBvh.bakeFromMeshes: the rewrite must be BIT-IDENTICAL to the old one,
// and the content-signature skip must never hide a real change.
//
// Collision is the one place where "close enough" is not a defensible standard
// — every query the car makes reads this buffer — so the assertion is exact
// equality against a verbatim copy of the previous implementation.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { loadTrackFile } from "./loadTrackFile.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const KIT = await import(pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadKit.js")).href);
const { RoadBvh } = await import(pathToFileURL(join(ROOT, "v3/play/modularRoadBvh.js")).href);

let fail = 0;
const check = (n, c, d = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`);
  if (!c) fail++;
};

const _v = new THREE.Vector3();
/** The implementation as it stood before this change, verbatim. */
function bakeOld(meshes) {
  const positions = [];
  const indices = [];
  let vertexOffset = 0;
  for (const mesh of meshes) {
    if (!mesh) continue;
    const geo = mesh.geometry;
    const posAttr = geo?.getAttribute("position");
    if (!posAttr) continue;
    mesh.updateMatrixWorld(true);
    const m = mesh.matrixWorld;
    const idx = geo.getIndex();
    for (let i = 0; i < posAttr.count; i++) {
      _v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(m);
      positions.push(_v.x, _v.y, _v.z);
    }
    if (idx) {
      for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + vertexOffset);
    } else {
      for (let i = 0; i < posAttr.count; i++) indices.push(i + vertexOffset);
    }
    vertexOffset += posAttr.count;
  }
  if (positions.length === 0) return null;
  const origLen = indices.length;
  for (let i = 0; i < origLen; i += 3) indices.push(indices[i], indices[i + 2], indices[i + 1]);
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  return merged;
}

// Real track geometry, plus a couple of awkward shapes the road really does
// hand in: a non-indexed geometry and a nested/rotated transform.
// Through loadTrackFile — a v2 track's per-piece params are sparse.
const { rp, gp, pieces } = await loadTrackFile(ROOT, "games/modular-road-v3/rushline.json");

const decks = [];
for (const e of pieces) {
  let b;
  try {
    b = KIT.buildPiece(e.id, new THREE.Matrix4().fromArray(e.connectorIn), e.pp, rp, gp, e.edges ?? true);
  } catch { continue; }
  const m = new THREE.Mesh(b.deckCollision ?? b.geometry, null);
  m.matrixAutoUpdate = false;
  m.matrix.copy(b.world);
  m.updateMatrixWorld(true);
  decks.push(m);
}
{
  const g = new THREE.BoxGeometry(3, 1, 7).toNonIndexed();
  const parent = new THREE.Group();
  parent.position.set(12, -3, 4);
  parent.rotation.set(0.3, 1.1, -0.7);
  const m = new THREE.Mesh(g, null);
  m.position.set(-2, 5, 1);
  m.rotation.set(1.2, -0.4, 0.9);
  parent.add(m);
  parent.updateMatrixWorld(true);
  decks.push(m);
}
console.log(`${decks.length} meshes (last is non-indexed, under a rotated parent)\n`);

// ── 1. Bit-identical output ────────────────────────────────────────────────
//
// The reference geometry has to go through MeshBVH too. Its build REORDERS the
// index buffer in place — that is what the `indirect` option exists to avoid —
// so comparing a post-BVH array against a raw merged one compares the tree's
// triangle grouping, not the bake. Running both through it is also the stronger
// claim: identical input to a deterministic builder must give identical trees.
{
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(decks);
  const oldGeo = bakeOld(decks);
  const { MeshBVH: MB } = await import("three-mesh-bvh");
  new MB(oldGeo);
  const np = bvh.geometry.getAttribute("position").array;
  const op = oldGeo.getAttribute("position").array;
  const ni = bvh.geometry.getIndex().array;
  const oi = oldGeo.getIndex().array;

  check("same vertex count", np.length === op.length, `${np.length} vs ${op.length}`);
  check("same index count", ni.length === oi.length, `${ni.length} vs ${oi.length}`);
  let posDiff = -1, idxDiff = -1;
  for (let i = 0; i < Math.min(np.length, op.length); i++) {
    // Float32Array round-trip on both sides: EXACT equality is the bar.
    if (np[i] !== op[i]) { posDiff = i; break; }
  }
  for (let i = 0; i < Math.min(ni.length, oi.length); i++) {
    if (ni[i] !== oi[i]) { idxDiff = i; break; }
  }
  check("positions bit-identical to the old bake", posDiff === -1,
    posDiff === -1 ? `${np.length / 3} verts` : `first differs at ${posDiff}: ${np[posDiff]} vs ${op[posDiff]}`);
  check("indices bit-identical to the old bake", idxDiff === -1,
    idxDiff === -1 ? `${ni.length / 3} tris` : `first differs at ${idxDiff}`);
  check("the winding duplicate set is still there",
    ni.length === oi.length && ni.length / 3 === bvh.triCount);
}

// ── 2. The skip fires when nothing moved, and NOT when something did ───────
{
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(decks);
  const first = bvh.geometry;

  bvh.bakeFromMeshes(decks);
  check("unchanged inputs reuse the same tree", bvh.geometry === first);

  bvh.bakeFromMeshes(decks, { force: true });
  check("force:true rebuilds anyway", bvh.geometry !== first);

  // A pose change of 1 mm must be seen.
  const g2 = bvh.geometry;
  decks[3].matrix.elements[13] += 0.001;
  decks[3].matrixWorldNeedsUpdate = true;
  decks[3].updateMatrixWorld(true);
  bvh.bakeFromMeshes(decks);
  check("a 1 mm pose change is NOT skipped", bvh.geometry !== g2);
  decks[3].matrix.elements[13] -= 0.001;
  decks[3].updateMatrixWorld(true);

  // Swapping geometry while keeping the pose must be seen.
  bvh.bakeFromMeshes(decks);
  const g3 = bvh.geometry;
  const savedGeo = decks[2].geometry;
  decks[2].geometry = decks[5].geometry;
  bvh.bakeFromMeshes(decks);
  check("a geometry swap at the same pose is NOT skipped", bvh.geometry !== g3);
  decks[2].geometry = savedGeo;

  // Adding and removing a mesh must be seen.
  bvh.bakeFromMeshes(decks);
  const g4 = bvh.geometry;
  const extra = decks.slice(0, 5);
  bvh.bakeFromMeshes(extra);
  check("a different mesh SET is NOT skipped", bvh.geometry !== g4);

  // ...and invalidate() forces the next one through.
  bvh.bakeFromMeshes(extra);
  const g5 = bvh.geometry;
  bvh.invalidate();
  bvh.bakeFromMeshes(extra);
  check("invalidate() forces a rebuild", bvh.geometry !== g5);
}

// ── 3. Empty input tears the tree down rather than leaving a stale one ─────
{
  const bvh = new RoadBvh();
  bvh.bakeFromMeshes(decks);
  check("baked from real meshes", bvh.baked === true);
  const ok = bvh.bakeFromMeshes([]);
  check("empty input returns false and clears", ok === false && bvh.baked === false && bvh.geometry === null);
  // And a bake after that must not be skipped by a stale signature.
  bvh.bakeFromMeshes(decks);
  check("rebakes after an empty bake", bvh.baked === true && bvh.geometry !== null);
}

// ── 4. Queries still answer the same thing ────────────────────────────────
{
  const a = new RoadBvh();
  a.bakeFromMeshes(decks);
  const oldGeo = bakeOld(decks);
  const { MeshBVH } = await import("three-mesh-bvh");
  const ref = new MeshBVH(oldGeo);

  a.geometry.computeBoundingBox();
  const bb = a.geometry.boundingBox;
  const t1 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const t2 = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  let probes = 0, disagree = 0, worst = 0;
  const p = new THREE.Vector3();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 4000; i++) {
    p.set(
      bb.min.x + rnd() * (bb.max.x - bb.min.x),
      bb.min.y + rnd() * (bb.max.y - bb.min.y),
      bb.min.z + rnd() * (bb.max.z - bb.min.z));
    t1.distance = Infinity; t2.distance = Infinity;
    const r1 = a._bvh.closestPointToPoint(p, t1, 0, 3);
    const r2 = ref.closestPointToPoint(p, t2, 0, 3);
    probes++;
    if (!!r1 !== !!r2) { disagree++; continue; }
    if (r1) worst = Math.max(worst, Math.abs(t1.distance - t2.distance));
  }
  check("closest-point answers unchanged vs the old bake",
    disagree === 0 && worst < 1e-9,
    `${probes} probes, ${disagree} hit/miss, max distance delta ${worst.toExponential(2)}`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
