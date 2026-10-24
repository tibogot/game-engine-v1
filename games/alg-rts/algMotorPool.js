// THE MOTOR POOL, NEW STANDARD (2026-10-18, you: "see how far we could make a better looking AAA motor pool").
// tools/blender/motorPool.py builds it as the real thing is built — I-section columns, Howe trusses, purlins,
// lapped corrugated sheets, a rendered workshop with its openings cut through — and bakes it (colour × ambient
// occlusion) → public/models/alg/motorPool.glb. Front at -Z, as buildMotorPool. In the BUILDINGS LAB first.
//
// OPTIMIZED (you: "any asset we create should be very optimized, with LOD"): TWO LEVELS, each ONE draw —
//   StaticFar   the GAME's level (motorPool.glb): zig-zag ribbed sheets, box sections, no small parts,
//               one 2048 atlas baked from the near one
//   StaticNear  the whole building, one 4096 atlas (motorPoolNear.glb) — the LAB's close look only, loaded
//               on request: it cost 2 ms at the game's closest zoom (tiny-triangle shading), far 0.84
//   DoorL/DoorR the garage bay's doors (origin on the hinge: a game swings them) — near; far a meshopt-
//               simplified copy of each (the same names: whoever swings them, swings both)
// The game's cloth-simulated sandbags ride along: the full mesh near, a meshopt-simplified one far.
// The geometry is meshopt-compressed (the shared loader decodes it).
import { KIT_BLEND, blendMesh, whenGroundBlend } from "./algGroundBlend.js";
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v3/render/foliage/glbLoader.js";
import { simplifierReady, simplifyGeometry } from "../../v3/render/instancing/autoLod.js";
import { loadSandbags, loadSandbagWall, sandbagMesh, sandbagWallBags, simulatedWallMesh } from "./algSandbags.js";

let _p = null, _parts = null;
const S = 1.3;          // (built in real metres; the game draws its buildings at unit scale ×1.3, as rtsAlgeria's)
/** The camera distance (world m) where the far level takes over; the RTS camera sits 50-130 m out. */
export const MOTOR_POOL_FAR = 45;

/** Load the GLB once (`file`: another build of it, the lab's ?glb= — comparing compressions; `near`: also the
 *  close-up level, the lab's). Null if missing. */
export function loadMotorPool(file = "motorPool", { near: withNear = false } = {}) {
  return (_p ??= (async () => {
    const load = (f) => getSharedGltfLoader().loadAsync(`/models/alg/${f}.glb`).catch((e) => { console.warn("[motorPool]", e); return null; });
    const [gltf, gNear] = await Promise.all([load(file), withNear ? load(`${file}Near`) : null, loadSandbags(), loadSandbagWall(), simplifierReady]);
    if (!gltf) return null;
    const get = (n) => gltf.scene.getObjectByName(n);
    const near = gNear?.scene.getObjectByName("StaticNear") ?? null, far = get("StaticFar");
    if (!far) return null;
    // THE SANDBAGS (you: "we have already made some — I have several realistic ones"): the game's cloth-
    // simulated bags (algSandbags.js), a low wall shielding the drums at the shed's left gable, on the apron.
    // (built in the game's units, then ÷S: the bags the size of the game's walls, not ×1.3 again)
    // NOW THE BLENDER-SIMULATED WALL (2026-10-23, you: "we made some nice sandbags … why are the motor pool sandbags by
    // the side looking bad"): the game draws the far level only, and its bags were the cloth bags cut to 20 % by the
    // simplifier — lumps. The searchlight shed's piece (sandbagWall.py "slshed": 3.4 m, one bag thick, three courses,
    // its own near/far) is this wall's size exactly. The procedural bags only if it did not load.
    let bags = simulatedWallMesh("MotorPoolBags", "slshed"), bagsFar = bags;
    if (bags) {
      bags.scale.setScalar(1 / S);
      bags.position.set(-8.97, 0.15, -2.55);   // (fully on the slab — its edge at x −9.2 — and clear of the drums at −8.62)
      bags.rotation.y = Math.PI / 2;
    } else {
      bags = sandbagMesh(sandbagWallBags({ length: 3.4 * S, courses: 3, thick: 1, seed: 11, x0: -9.08 * S, z0: -2.55 * S, yaw: Math.PI / 2 }), "MotorPoolBags");
      bags.scale.setScalar(1 / S);
      bags.position.y = 0.15;
      bagsFar = new THREE.Mesh(simplifyGeometry(bags.geometry, { ratio: 0.2, error: 0.02 }), bags.material);
      bagsFar.name = "MotorPoolBagsFar";
      bagsFar.scale.copy(bags.scale); bagsFar.position.copy(bags.position);
    }
    for (const o of [near, far, get("DoorL"), get("DoorR"), bags, bagsFar]) {
      if (!o?.isMesh) continue;
      o.castShadow = o.receiveShadow = true;
      if (o.material?.map) o.material.map.anisotropy = 8;
      // (Blender exports DOUBLE-sided: every back face shaded too — measured ~0.45 ms at the closest zoom. Every
      // surface here is closed or has its own back: the sheets are thickened, or a flat underside in the far)
      if (o.material) o.material.side = THREE.FrontSide;
    }
    const doors = [get("DoorL"), get("DoorR")].filter(Boolean);
    // (the GLB's geometry is meshopt-QUANTIZED — 16-bit attributes, the node's scale undoes it — and the
    // simplifier reads plain floats: decoded first; the node's transform copied whole)
    const doorsFar = doors.map((d) => {
      const q = new THREE.Mesh(simplifyGeometry(toFloat(d.geometry), { ratio: 0.12, error: 0.01 }), d.material);
      q.name = d.name; q.position.copy(d.position); q.quaternion.copy(d.quaternion); q.scale.copy(d.scale);
      q.castShadow = q.receiveShadow = true;
      return q;
    });
    // (THE GROUND BLEND — algGroundBlend: the building and its doors, before anything draws them)
    whenGroundBlend((app) => { for (const m of [near, far, ...doors, ...doorsFar]) blendMesh(app, m, KIT_BLEND.motorPool); });
    return (_parts = { near, far, doors, doorsFar, bags, bagsFar });
  })());
}

/** A geometry with every attribute as plain float32 (a quantized one decoded). */
function toFloat(src) {
  const g = new THREE.BufferGeometry();
  for (const [k, at] of Object.entries(src.attributes)) {
    const out = new Float32Array(at.count * at.itemSize);
    for (let i = 0; i < at.count; i++) for (let c = 0; c < at.itemSize; c++) out[i * at.itemSize + c] = at.getComponent(i, c);
    g.setAttribute(k, new THREE.BufferAttribute(out, at.itemSize));
  }
  g.setIndex(src.index ? new THREE.BufferAttribute(Uint32Array.from(src.index.array), 1) : null);
  return g;
}

/** A motor pool (meshes and materials shared): the far level and the two doors, an LOD with the near one
 *  when it was loaded. Null if not loaded. */
export function motorPoolMesh() {
  if (!_parts) return null;
  const P = _parts, g = new THREE.Group();
  g.name = "MotorPoolV2";
  g.scale.setScalar(S);
  const level = (...ms) => { const q = new THREE.Group(); for (const m of ms) q.add(m.clone()); return q; };
  const lod = new THREE.LOD();
  lod.name = "MotorPoolLOD";
  if (P.near) lod.addLevel(level(P.near, P.bags, ...P.doors), 0, 0.1);
  lod.addLevel(level(P.far, P.bagsFar, ...P.doorsFar), P.near ? MOTOR_POOL_FAR : 0, 0.1);
  g.add(lod);
  return g;
}

/** What each level costs: triangles, draws, texture megapixels. */
export function motorPoolStats(root) {
  const count = (objs) => {
    let tris = 0, draws = 0; const tex = new Set();
    for (const r of objs) r.traverse((o) => {
      if (!o.isMesh) return;
      draws++;
      const q = o.geometry; tris += (q.index ? q.index.count : q.getAttribute("position").count) / 3;
      if (o.material?.map) tex.add(o.material.map);
    });
    let px = 0;
    for (const t of tex) px += (t.image?.width ?? 0) * (t.image?.height ?? 0);
    return { tris, draws, mpx: +(px / 1e6).toFixed(2) };
  };
  const lod = root.getObjectByName("MotorPoolLOD");
  const L = lod.levels;
  return { near: L.length > 1 ? count([L[0].object]) : null, far: count([L[L.length - 1].object]) };
}

/**
 * THE BLENDER MOTOR POOL IN THE GAME (2026-10-22 — it was the lab's only: "the motor pool you loved isn't in the
 * game"). The placed one (the showroom's: the old builder's mesh — its footprint, nav, gate data, pick box and the
 * producer stay ITS) draws nothing of its own any more: the Blender building (far level, one draw, the doors, the
 * simulated bags) a child of it; its gate's leaves stay the producer's (they swing) but invisible, the Blender doors
 * copying their swing (outward: the sign turned). True when done.
 */
export function attachMotorPool(mesh) {
  const g = motorPoolMesh();
  if (!g || !mesh?.isMesh || mesh.userData.blenderPool) return false;
  mesh.userData.blenderPool = true;
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  mesh.material = hidden;
  const leaves = [];
  for (const c of mesh.children) {
    if (c.name === "Stencils") c.visible = false;
    else if (c.userData.gateLeaf) { c.material = hidden; leaves.push(c); }
  }
  mesh.add(g);
  const doors = [];
  g.traverse((o) => { if (o.name === "DoorL" || o.name === "DoorR") doors.push(o); });
  // the doors follow the leaves (left with left): each frame, cheap
  const sync = () => {
    for (const d of doors) {
      const leaf = leaves[d.name === "DoorL" ? 0 : 1];
      if (!leaf) continue;
      d.userData.y0 ??= d.rotation.y;
      d.rotation.y = d.userData.y0 - leaf.rotation.y;
    }
  };
  mesh.userData.syncDoors = sync;
  return true;
}
