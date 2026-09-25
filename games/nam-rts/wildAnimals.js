// WILD ANIMALS — sambar deer (stag and hinds) and muntjac at the jungle's
// edge. GAME code. Your models (2026-09-26): public/models/Deer_compressed.glb
// and Stag_compressed.glb, from the same pack as the bull — the same clips
// (Eating, Idle, Idle_2, Idle_Headlow, Walk, Gallop).
//
// Vietnam's deer, recoloured from the pack's European red deer:
//   · SAMBAR — big, dark grey-brown, the stag with heavy dark antlers;
//   · MUNTJAC (barking deer) — small and red-brown: the deer model at 0.55.
//
// WHAT THEY DO. Small groups on the sunny fringe of the jungle, away from the
// camps: graze, lift the head and look round, walk a few metres. When a
// soldier — either side's — comes within 35 m they BOLT, galloping 40-70 m
// away from him, then settle again where they stopped. Deer breaking out of a
// treeline is a tell that someone is moving in it.
//
// COST. Each kind is the soldiers' GPU crowd path (crowdSkinning.js): the
// model's pieces merged onto one skeleton (the stag's antlers are a separate,
// unskinned mesh on the Head bone — bound to it here), the clips baked once,
// the whole group skinned in one compute pass and drawn in ONE call.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { createCrowdField } from "./crowdSkinning.js";

/** A float copy of an attribute (the GLBs' are quantised). */
function floatAttr(a) {
  const out = new Float32Array(a.count * a.itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, a.itemSize);
}

/**
 * Load a model of the pack and merge it to ONE skinned mesh on one skeleton,
 * every piece in the model's rest space, its material colour (or the
 * override `colors[materialName]`) baked into the vertices.
 * Returns { root, source, clips }.
 */
export async function loadAnimal(url, colors = {}) {
  const gltf = await getSharedGltfLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const skinned = [], rigid = [];
  root.traverse((o) => {
    if (o.isSkinnedMesh) skinned.push(o);
    else if (o.isMesh) rigid.push(o);
  });
  const bones = skinned[0].skeleton.bones;
  const colorOf = (m) => new THREE.Color(colors[m.name] ?? `#${m.color.getHexString()}`);
  const geos = [];
  const v = new THREE.Vector3();
  const pack = (P, Nn, skinIndex, skinWeight, index, mat) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", P);
    g.setAttribute("normal", Nn);
    g.setAttribute("skinIndex", skinIndex);
    g.setAttribute("skinWeight", skinWeight);
    const c = colorOf(mat);
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(P.count * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
    g.setIndex(index ? index.clone() : null);
    geos.push(g);
  };
  const place = (P, Nn, M) => {
    const nm = new THREE.Matrix3().getNormalMatrix(M);
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(M); P.setXYZ(i, v.x, v.y, v.z);
      v.fromBufferAttribute(Nn, i).applyMatrix3(nm).normalize(); Nn.setXYZ(i, v.x, v.y, v.z);
    }
  };
  for (const p of skinned) {
    // Its rest space → the model's: bone at rest × its own inverse bind.
    const D = new THREE.Matrix4().multiplyMatrices(p.skeleton.bones[0].matrixWorld, p.skeleton.boneInverses[0]).multiply(p.bindMatrix);
    const P = floatAttr(p.geometry.attributes.position), Nn = floatAttr(p.geometry.attributes.normal);
    place(P, Nn, D);
    pack(P, Nn, floatAttr(p.geometry.attributes.skinIndex), floatAttr(p.geometry.attributes.skinWeight), p.geometry.index, p.material);
  }
  for (const r of rigid) {
    // A rigid piece on a bone (the stag's antlers on its Head): its world rest
    // placement, every vertex bound fully to that bone.
    let b = r.parent;
    while (b && !b.isBone) b = b.parent;
    const bi = Math.max(0, bones.indexOf(b));
    const P = floatAttr(r.geometry.attributes.position), Nn = floatAttr(r.geometry.attributes.normal);
    place(P, Nn, r.matrixWorld);
    const n = P.count;
    pack(P, Nn,
      new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? bi : 0)), 4),
      new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4),
      r.geometry.index, r.material);
  }
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error(`wildAnimals: merge failed for ${url}`);
  merged.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
  const mesh = new THREE.SkinnedMesh(merged, mat);
  for (const o of [...skinned, ...rigid]) o.parent?.remove(o);
  root.add(mesh);
  mesh.bind(new THREE.Skeleton(bones), new THREE.Matrix4());
  return { root, source: mesh, clips: gltf.animations };
}

const CLIP_NAMES = { eat: "Eating", idle: "Idle", look: "Idle_2", low: "Idle_Headlow", walk: "Walk", run: "Gallop" };

/**
 * One kind of animal as a crowd: `spots` [{ x, z, height }] (height in metres,
 * per animal), `canStand(x, z)` → ground y or null, `threats()` → positions of
 * whoever makes them bolt. Returns { update(dt), mesh, count, herd }.
 */
export function createWildHerd(app, tpl, spots, { canStand, threats = () => [], walkSpeed = 0.9, runSpeed = 7, name = "Wild" } = {}) {
  if (!spots.length) return null;
  const box = new THREE.Box3().setFromObject(tpl.root);
  const baseH = Math.max(0.01, box.max.y - box.min.y);
  const clips = {};
  for (const [k, n] of Object.entries(CLIP_NAMES)) { const c = tpl.clips.find((q) => q.name === n); if (c) clips[k] = c; }
  const field = createCrowdField({
    scene: app.scene, renderer: app.renderer, source: tpl.source, animRoot: tpl.root, clips, max: spots.length, castShadow: true,
  });
  field.mesh.name = name;
  let seed = 7331 + spots.length * 17;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const herd = spots.map((s) => ({
    x: s.x, z: s.z, y: canStand(s.x, s.z) ?? app.getWorldHeight(s.x, s.z), yaw: rnd() * Math.PI * 2,
    scale: s.height / baseH, home: { x: s.x, z: s.z },
    cur: "eat", tCur: rnd() * 10, prev: "eat", tPrev: 0, fade: 1, rate: 0.85 + rnd() * 0.3,
    state: "eat", timer: 3 + rnd() * 10, target: null, speed: walkSpeed,
  }));
  const go = (h, state, key, timer) => {
    const next = clips[key] ? key : "eat";
    if (next !== h.cur) { h.prev = h.cur; h.tPrev = h.tCur; h.cur = next; h.tCur = 0; h.fade = 0; }
    h.state = state;
    h.timer = timer;
  };
  const pathClear = (h, x, z) => {
    for (let f = 0.2; f <= 1.001; f += 0.2) if (canStand(h.x + (x - h.x) * f, h.z + (z - h.z) * f) == null) return false;
    return true;
  };
  /** Fresh grazing 2-6 m off, not straying far from home. */
  const pickGraze = (h) => {
    for (let k = 0; k < 16; k++) {
      const a = rnd() * Math.PI * 2, d = 2 + rnd() * 4;
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d;
      if (Math.hypot(x - h.home.x, z - h.home.z) > 20) continue;
      if (pathClear(h, x, z)) return { x, z };
    }
    return null;
  };
  /** Away from the threat, 40-70 m, the most open of a few headings. */
  const pickFlight = (h, t) => {
    const away = Math.atan2(h.x - t.x, h.z - t.z);
    for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
      const a = away + off + (rnd() - 0.5) * 0.3, d = 40 + rnd() * 30;
      const x = h.x + Math.sin(a) * d, z = h.z + Math.cos(a) * d;
      if (pathClear(h, x, z)) return { x, z };
    }
    return null;
  };
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  let alarmT = 0;
  return {
    mesh: field.mesh, count: spots.length,
    get herd() { return herd.map((h) => ({ state: h.state, at: [+h.x.toFixed(1), +h.z.toFixed(1)] })); },
    update(dt) {
      dt = Math.min(dt, 0.1);
      // Who is near? Checked a few times a second, not every frame.
      alarmT -= dt;
      let near = null;
      if (alarmT <= 0) {
        alarmT = 0.3;
        const T = threats();
        for (const h of herd) {
          if (h.state === "run") continue;
          for (const t of T) {
            if ((t.x - h.x) ** 2 + (t.z - h.z) ** 2 < 35 * 35) { near = t; break; }
          }
          if (near) break;
        }
      }
      field.begin();
      for (const h of herd) {
        // One of them spooked: its group bolts (whoever is within 60 m of the
        // threat — not every deer of the kind on the map), each its own way.
        if (near && h.state !== "run" && (near.x - h.x) ** 2 + (near.z - h.z) ** 2 < 60 * 60
          && (h.target = pickFlight(h, near))) { h.speed = runSpeed * (0.9 + rnd() * 0.2); go(h, "run", "run", 14); }
        h.tCur += dt * h.rate * (h.state === "run" ? h.speed / runSpeed : 1);
        h.tPrev += dt * h.rate;
        h.fade = Math.min(1, h.fade + dt / (h.state === "run" ? 0.2 : 0.5));
        h.timer -= dt;
        if (h.state === "walk" || h.state === "run") {
          const t = h.target;
          const dx = t.x - h.x, dz = t.z - h.z, dist = Math.hypot(dx, dz);
          const dA = Math.atan2(Math.sin(Math.atan2(dx, dz) - h.yaw), Math.cos(Math.atan2(dx, dz) - h.yaw));
          const turn = h.state === "run" ? 3 : 1.2;
          h.yaw += Math.max(-turn * dt, Math.min(turn * dt, dA));
          const step = Math.min(dist, h.speed * dt * Math.max(0.2, Math.cos(dA)));
          const nx = h.x + Math.sin(h.yaw) * step, nz = h.z + Math.cos(h.yaw) * step;
          const y = canStand(nx, nz);
          if (y != null) { h.x = nx; h.z = nz; h.y += (y - h.y) * Math.min(1, dt * 6); }
          if (dist < 0.5 || y == null || h.timer < 0) {
            if (h.state === "run") h.home = { x: h.x, z: h.z };   // settles where it stopped
            h.speed = walkSpeed;
            go(h, "look", "idle", 2 + rnd() * 3);                 // stands and listens first
          }
        } else if (h.timer <= 0) {
          const r = rnd();
          if (h.state === "eat" && r < 0.4) go(h, "look", r < 0.2 ? "idle" : "look", 2 + rnd() * 4);
          else if (r < 0.75 && (h.target = pickGraze(h))) { h.speed = walkSpeed; go(h, "walk", "walk", 10); }
          else go(h, "eat", rnd() < 0.25 ? "low" : "eat", 5 + rnd() * 10);
        }
        p.set(h.x, h.y, h.z);
        q.setFromAxisAngle(up, h.yaw);
        m.compose(p, q, sc.setScalar(h.scale));
        field.addPose(m, h.prev, h.tPrev, h.cur, h.tCur, h.fade);
      }
      field.commit();
    },
  };
}
