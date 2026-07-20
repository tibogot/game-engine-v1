// Resource node RENDERER — a supply dump drawn as a stack of crates.
//
// Procedural rather than a GLB, to match the base/turrets/dummies (the imported
// models are only the units). It also buys the depletion cue for free: a node is
// drawn as up to CRATES_PER_NODE crates and simply shows FEWER of them as it
// drains, so you can read a node's remaining value across the map without a bar.
//
// Every crate of every node is one instance of one geometry, so the whole economy
// layer is 1 draw call no matter how many nodes are on the map.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { materialColor } from "three/tsl";

const CRATES_PER_NODE = 7;
const MAX_NODES = 32;
const MAX_CRATES = CRATES_PER_NODE * MAX_NODES;

const C_CRATE = 0xb98b3a; // weathered amber — reads as "supplies" against grass
const C_BAND = 0x6d5220;  // strapping
const C_LID = 0xd8ab55;

/** Bake a flat colour into a `color` attribute so parts can merge. */
function paint(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

const CRATE_W = 1.5;   // crate footprint
const CRATE_H = 1.4;
const STACK_Y = 1.56;  // crate height + lid — where a stacked crate sits

/** One crate: box + lid + a strap band, merged. Origin at its base centre. */
function crateGeometry() {
  const geo = mergeGeometries([
    paint(new THREE.BoxGeometry(CRATE_W, CRATE_H, CRATE_W).translate(0, CRATE_H / 2, 0), C_CRATE),
    paint(new THREE.BoxGeometry(CRATE_W + 0.1, 0.16, CRATE_W + 0.1).translate(0, CRATE_H + 0.08, 0), C_LID),
    paint(new THREE.BoxGeometry(CRATE_W + 0.12, 0.14, 0.3).translate(0, CRATE_H / 2, 0), C_BAND),
    paint(new THREE.BoxGeometry(0.3, 0.14, CRATE_W + 0.12).translate(0, CRATE_H / 2, 0), C_BAND),
  ], false);
  if (!geo) throw new Error("[rts-v3] crate: mergeGeometries failed (attribute mismatch)");
  return geo;
}

/**
 * Fixed crate layout within a node.
 *
 * Centres are 1.9 apart against a 1.5 crate — crates must NOT overlap, or the
 * lids intersect and the pile renders as one blobby cross instead of a stack.
 * Rotations stay small for the same reason: a 1.5 box rotated 7° spans ~1.67,
 * still inside the spacing.
 *
 * Ordered so that STACKED crates come last: the renderer draws the first N, so
 * draining a node takes the top off and the pile settles, rather than punching
 * holes in the middle.
 */
const LAYOUT = [
  { x: -0.95, y: 0, z: -0.95, r: 0.10 },
  { x: 0.95, y: 0, z: -0.95, r: -0.12 },
  { x: -0.95, y: 0, z: 0.95, r: 0.07 },
  { x: 0.95, y: 0, z: 0.95, r: -0.09 },
  { x: 0.0, y: 0, z: -2.7, r: 0.13 },            // a stray crate off the pile
  { x: -0.95, y: STACK_Y, z: -0.95, r: -0.06 },  // stacked on [0]
  { x: 0.95, y: STACK_Y, z: 0.95, r: 0.11 },     // stacked on [3]
];

export function createResourceRenderer({ app, resources }) {
  const { scene } = app;

  const mat = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff, // the vertex colours ARE the colour
    roughness: 0.9,
    metalness: 0.05,
    vertexColors: true,
  });
  // An InstancedMesh never moves (its instances do), so without a colorNode three
  // freezes its scene fog uniforms — see structuresRenderer.js for the full story.
  mat.colorNode = materialColor;

  const mesh = new THREE.InstancedMesh(crateGeometry(), mat, MAX_CRATES);
  mesh.count = 0;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // instances live anywhere; shared bounds are meaningless
  scene.add(mesh);

  const _obj = new THREE.Object3D();
  let lastKey = ""; // nodes only change when one is drained — skip the rewrite otherwise

  function sync() {
    // Cheap signature: how many crates each node should show. Harvesting changes
    // `amount` every frame, but the VISIBLE crate count only changes occasionally.
    let key = "";
    const counts = [];
    for (const n of resources.nodes) {
      const c = n.alive ? Math.max(1, Math.ceil((n.amount / n.maxAmount) * CRATES_PER_NODE)) : 0;
      counts.push(c);
      key += `${c},`;
    }
    if (key === lastKey) return;
    lastKey = key;

    let i = 0;
    for (let k = 0; k < resources.nodes.length; k++) {
      const n = resources.nodes[k];
      const show = counts[k];
      for (let c = 0; c < show && i < MAX_CRATES; c++) {
        const L = LAYOUT[c % LAYOUT.length];
        _obj.position.set(n.position.x + L.x, n.position.y + L.y, n.position.z + L.z);
        _obj.rotation.set(0, L.r, 0);
        _obj.scale.setScalar(1);
        _obj.updateMatrix();
        mesh.setMatrixAt(i, _obj.matrix);
        i++;
      }
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  }

  /** Resolve a raycast hit to its node, so right-click can assign a harvester. */
  function nodeFromHit(hit) {
    if (hit.object !== mesh) return null;
    // Crates are written node by node, so the instance index maps back by counting.
    let i = 0;
    for (const n of resources.nodes) {
      const show = n.alive ? Math.max(1, Math.ceil((n.amount / n.maxAmount) * CRATES_PER_NODE)) : 0;
      if (hit.instanceId < i + show) return n;
      i += show;
    }
    return null;
  }

  /**
   * Live nodes whose footprint covers a world XZ — the fallback for a click that
   * slipped between crates. Generous radius: the pile is wider than the node's
   * logical radius, and "near enough" is what the player meant.
   */
  function* nodesNear(x, z, pad = 3) {
    for (const n of resources.nodes) {
      if (!n.alive) continue;
      const r = n.radius + pad;
      if ((n.position.x - x) ** 2 + (n.position.z - z) ** 2 <= r * r) yield n;
    }
  }

  return {
    mesh,
    roots: [mesh], // raycast target
    sync,
    nodeFromHit,
    nodesNear,
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
