// THE ZERIBA, NEW STANDARD (2026-10-14, you: "what are these things near the villager house?" — the
// flock's thorn pen read as a ring of baskets). tools/blender/zeribaSim.py grows cut thorn bushes
// (forking, bending branches) and piles them in a ring, crowns outward, the entrance at -Z; the trough
// and the fodder inside → public/models/alg/zeriba.glb (+ _far). Each branch's shade in COLOR_0.
// In the BUILDINGS LAB first (the kit's pen beside it).
import * as THREE from "three";

// The pens: the hamlet's zeriba (zeriba.glb) and the farmstead's small pen (zeribaFarm.glb).
const PENS = {}, _p = {};
let _mat = null;

function prep(gltf) {
  let src = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => { if (o.isMesh && !src) src = o; });
  const g = src.geometry.clone().applyMatrix4(src.matrixWorld);
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** Load the pen (near + far) once. Null if missing. */
export function loadZeriba(file = "zeriba") {
  return (_p[file] ??= import("three/addons/loaders/GLTFLoader.js").then(async ({ GLTFLoader }) => {
    const ld = new GLTFLoader(), get = (u) => ld.loadAsync(u).catch(() => null);
    const [n, f] = await Promise.all([get(`/models/alg/${file}.glb`), get(`/models/alg/${file}_far.glb`)]);
    PENS[file] = n ? { near: prep(n), far: f ? prep(f) : null } : null;
    return PENS[file];
  }));
}

/** Dead wood, its shade from the vertex colour: matte, a little sheen. */
function material() {
  return (_mat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, name: "Zeriba", side: THREE.DoubleSide }));   // (DoubleSide: the twigs are flat ribbons)
}

/** The pen as an object (an LOD near / far from 55 m), or null if not loaded. */
export function zeribaMesh(name = "Zeriba", file = "zeriba") {
  const P = PENS[file];
  if (!P) return null;
  const _near = P.near, _far = P.far;
  const mk = (g, n) => { const m = new THREE.Mesh(g, material()); m.name = n; m.castShadow = m.receiveShadow = true; return m; };
  if (!_far) return mk(_near, name);
  const lod = new THREE.LOD();
  lod.name = name;
  lod.addLevel(mk(_near, name + ":near"), 0);
  lod.addLevel(mk(_far, name + ":far"), 55);
  return lod;
}
