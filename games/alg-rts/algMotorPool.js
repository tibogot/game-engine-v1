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
import { vec3 } from "three/tsl";
import { FR_PAINT_TINT, buildGMC, buildWillys } from "../../v3/render/objects/rtsVehiclesFr.js";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { rtsRunningGearMaterial } from "../../v3/render/objects/rtsVehicles.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
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
    _parts = { near, far, doors, doorsFar, bags, bagsFar };
    loadStates(load);   // (the damaged and ruin models after it, not holding the boot)
    return _parts;
  })());
}

// THE STATES (2026-10-25, your verdict: "finish what remained; its damaged / destroyed states"): motorPool_damaged.glb
// (the shell through the roof, the workshop's corner off) and motorPool_ruin.glb (the middle truss down, two bays'
// roof gone, the workshop fallen in, burnt — its doors on the apron, its own) — the far level, built and baked as the
// intact one (tools/blender/motorPool.py --state). Fetched after the intact one; a state not there yet: no swap.
const _states = {};
let _statesP = null;
/** Resolves once the states have loaded (or failed): the lab waits for them. */
export const motorPoolStatesReady = () => (_p ? _p.then(() => _statesP) : Promise.resolve());
function loadStates(load) {
  _statesP = Promise.all(["damaged", "ruin"].map((st) =>
    load(`motorPool_${st}`).then((g) => {
      const m = g?.scene.getObjectByName("StaticFar");
      if (!m?.isMesh) return;
      m.castShadow = m.receiveShadow = true;
      if (m.material) { m.material.side = THREE.FrontSide; if (m.material.map) m.material.map.anisotropy = 8; }
      whenGroundBlend((app) => blendMesh(app, m, KIT_BLEND.motorPool));
      _states[st] = m;
    })));
}

/** A motor pool (motorPoolMesh's group) shown in a state: "intact" | "damaged" | "ruin" — its building (both levels)
 *  the state's model, its doors gone in the ruin. False when that state's model is not loaded. */
export function setMotorPoolState(g, state) {
  const s = state === "intact" ? null : _states[state];
  if (state !== "intact" && !s) return false;
  g.traverse((o) => {
    if (o.name === "StaticFar" || o.name === "StaticNear") {
      o.userData.intact ??= { geometry: o.geometry, material: o.material };
      o.geometry = s ? s.geometry : o.userData.intact.geometry;
      o.material = s ? s.material : o.userData.intact.material;
    } else if (o.name === "DoorL" || o.name === "DoorR") o.visible = state !== "ruin";
  });
  for (const v of g.children) if (/^Parked/.test(v.name)) burnVehicle(v, state === "ruin");
  return true;
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

// ITS VEHICLES (2026-10-26, you: "it looks too neutral, it doesn't look enough like a motor pool … add a broken vehicle
// inside?"): the game's own GMC — open, nose in under the gantry, its engine hung from the hoist over its bonnet
// (tools/blender/motorPool.py: the engine out, turned along it), its tail out on the apron — and a Willys over the
// inspection pit. Built as the units are (rtsVehiclesFr detail 2, the units' paint and running gear), at the pool's
// real metres (÷S). Burnt in the ruin. Front +Z (the back wall).
const PARKED = [
  { name: "ParkedGMC", build: () => buildGMC({ detail: 2, crew: false, tilt: false }), at: [-5.0, 0.15, -2.75], yaw: 0 },
  { name: "ParkedWillys", build: () => buildWillys({ detail: 2, crew: false }), at: [0, 0.15, -0.25], yaw: 0 },
];
let _vehicles = null;
function parkedVehicles() {
  return (_vehicles ??= PARKED.map((v) => {
    const geo = v.build();
    const body = new THREE.Mesh(geo, rtsObjectMaterialTinted(FR_PAINT_TINT));
    body.name = v.name;
    const st = stencilMesh(geo.userData.stencil);
    if (st) body.add(st);
    const tur = geo.userData.turret;
    if (tur) { const t = new THREE.Mesh(tur.geo, body.material); t.position.set(...tur.pivot); body.add(t); }
    // (the wheels on the units' rolling-gear material: it reads a per-INSTANCE odometer — an InstancedMesh of one)
    if (geo.userData.gear) {
      const gear = new THREE.InstancedMesh(geo.userData.gear, rtsRunningGearMaterial(FR_PAINT_TINT), 1);
      gear.setMatrixAt(0, new THREE.Matrix4());
      gear.frustumCulled = false;
      body.add(gear);
    }
    body.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
    body.scale.setScalar(1 / S);
    body.position.set(...v.at);
    body.rotation.y = v.yaw;
    return body;
  }));
}
/** Burnt (the ruin) or not: every part's material darkened, the tyres gone flat (the body down 6 cm). */
function burnVehicle(v, burnt) {
  v.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.userData.mat0 ??= o.material;
    if (!burnt) { o.material = o.userData.mat0; return; }
    // (the paint burnt off: its light and dark kept, the colour gone — black-brown, a rust tint; ×0.2 read as dark olive)
    o.userData.charred ??= (() => {
      const m = o.userData.mat0.clone(), c = o.userData.mat0.colorNode;
      if (c) { const l = c.dot(vec3(0.2126, 0.7152, 0.0722)); m.colorNode = vec3(l.mul(0.12).add(0.012), l.mul(0.085).add(0.009), l.mul(0.06).add(0.007)); }
      else m.color?.setRGB(0.06, 0.045, 0.035);
      return m;
    })();
    o.material = o.userData.charred;
  });
  v.userData.y0 ??= v.position.y;
  v.position.y = v.userData.y0 - (burnt ? 0.06 : 0);
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
  for (const v of parkedVehicles()) g.add(v.clone());   // (each copy its own: the ruin burns its own)
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
  // (its damage: algSangar setPieceState hands the swap here — algDamage below half health, algStructures' wreck)
  mesh.userData.setState = (state) => {
    if (!setMotorPoolState(g, state)) return false;
    mesh.userData.pieceState = state;
    return true;
  };
  return true;
}
