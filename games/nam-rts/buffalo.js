// WATER BUFFALO — the paddy animal. GAME code.
// Your ask (2026-09-25): "for the bull if you are confident to make it look
// more like water buffalo go ahead". The model is public/models/Bull_compressed.glb
// (a low-poly bull, 2.4k triangles, 13 clips); a buffalo is made of it by:
//   • HORNS — the bull's are replaced by a buffalo's: wide flattened crescents
//     sweeping out and back from the top of the skull, bound to the Head bone
//     so they move with it;
//   • HIDE — slate grey, paler on the legs and the belly, dark hooves;
//   • SIZE — about 1.4 m at the shoulder.
//
// COST. The GLB is 7 skinned pieces (7 draws each). They are merged into ONE
// geometry — each piece unpacked from its own quantised space into the shared
// rest pose, its material's colour baked into the vertices — on one skeleton:
// one draw per buffalo (+ its shadow). A handful of AnimationMixers.
import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

const URL = "/models/Bull_compressed.glb";

/** The buffalo's colours by the bull's material names (sRGB). */
const HIDE = {
  Main: "#3b3e40", Main_Light: "#6b6a64", Hooves: "#23201c", Muzzle: "#26282a",
  Eye_Black: "#0b0b0b", Eye_White: "#b9b4a8", Horns: "#57504a",
};

/** A float copy of an attribute (the GLB's are quantised Int16/Uint8). */
function floatAttr(a, itemSize = a.itemSize) {
  const out = new Float32Array(a.count * itemSize);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = a.getComponent(i, k);
  return new THREE.BufferAttribute(out, itemSize);
}

/**
 * Buffalo horns: two tapered, flattened tubes along crescents, in the model's
 * rest space, every vertex bound to `headIndex` with weight 1.
 */
function hornGeometry(base, span, headIndex) {
  const pos = [], nor = [], idx = [];
  const RINGS = 14, SIDES = 7;
  for (const side of [-1, 1]) {
    // Out along the side, sweeping BACK and a little down, the tip turning
    // up and in — the buffalo's crescent. In units of `span`.
    const ctrl = [
      [0, 0, 0], [0.35, 0.04, -0.05], [0.72, 0.02, -0.28], [0.95, 0.1, -0.62], [0.9, 0.34, -0.95], [0.74, 0.52, -1.08],
    ].map(([x, y, z]) => new THREE.Vector3(side * (base.x + x * span), base.y + y * span, base.z + z * span));
    const curve = new THREE.CatmullRomCurve3(ctrl);
    const frames = curve.computeFrenetFrames(RINGS, false);
    const start = pos.length / 3;
    for (let r = 0; r <= RINGS; r++) {
      const t = r / RINGS;
      const c = curve.getPoint(t);
      const N = frames.normals[r], B = frames.binormals[r];
      // Thick at the root, a point at the tip; flattened (wider than deep).
      const rad = span * 0.13 * (1 - t) ** 0.8 + span * 0.008;
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2;
        const dx = Math.cos(a) * rad * 1.35, dy = Math.sin(a) * rad * 0.75;
        const n = N.clone().multiplyScalar(Math.cos(a) / 1.35).addScaledVector(B, Math.sin(a) / 0.75).normalize();
        pos.push(c.x + N.x * dx + B.x * dy, c.y + N.y * dx + B.y * dy, c.z + N.z * dx + B.z * dy);
        nor.push(n.x, n.y, n.z);
      }
    }
    for (let r = 0; r < RINGS; r++) for (let s = 0; s < SIDES; s++) {
      const a = start + r * SIDES + s, b = start + r * SIDES + ((s + 1) % SIDES);
      const c = a + SIDES, d = b + SIDES;
      if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  const n = pos.length / 3;
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("skinIndex", new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? headIndex : 0)), 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  // Grey-brown at the root, paler to the tip (rings run root → tip per side).
  const root = new THREE.Color(HIDE.Horns), tip = new THREE.Color("#a39a88"), c = new THREE.Color();
  const col = new Float32Array(n * 3);
  const perSide = (RINGS + 1) * SIDES;
  for (let i = 0; i < n; i++) {
    const t = Math.floor((i % perSide) / SIDES) / RINGS;
    c.copy(root).lerp(tip, t ** 1.5);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Load the bull once and make the buffalo template: { root, mesh, clips }. */
let _template = null;
export async function loadBuffaloTemplate() {
  if (_template) return _template;
  const gltf = await getSharedGltfLoader().loadAsync(URL);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const pieces = [];
  root.traverse((o) => { if (o.isSkinnedMesh) pieces.push(o); });
  const bones = pieces[0].skeleton.bones;
  const headIndex = bones.findIndex((b) => b.name === "Head");
  const geos = [];
  let hornBase = null, headSpan = 1;
  for (const p of pieces) {
    // This piece's rest space → the model's: the bones at rest times its own
    // inverse binds (the quantisation lives there).
    const D = new THREE.Matrix4().multiplyMatrices(p.skeleton.bones[0].matrixWorld, p.skeleton.boneInverses[0])
      .multiply(p.bindMatrix);
    const g = new THREE.BufferGeometry();
    const P = floatAttr(p.geometry.attributes.position), Nn = floatAttr(p.geometry.attributes.normal);
    const nm = new THREE.Matrix3().getNormalMatrix(D);
    const v = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(D); P.setXYZ(i, v.x, v.y, v.z);
      v.fromBufferAttribute(Nn, i).applyMatrix3(nm).normalize(); Nn.setXYZ(i, v.x, v.y, v.z);
    }
    if (p.material.name === "Horns") {
      // Not drawn: where they sat (the top of the skull) roots the new ones.
      const bb = new THREE.Box3().setFromBufferAttribute(P);
      hornBase = new THREE.Vector3((bb.max.x - bb.min.x) * 0.16, bb.min.y + (bb.max.y - bb.min.y) * 0.35, (bb.min.z + bb.max.z) / 2);
      headSpan = bb.max.x - bb.min.x;
      continue;
    }
    g.setAttribute("position", P);
    g.setAttribute("normal", Nn);
    g.setAttribute("skinIndex", floatAttr(p.geometry.attributes.skinIndex));
    g.setAttribute("skinWeight", floatAttr(p.geometry.attributes.skinWeight));
    const c = new THREE.Color(HIDE[p.material.name] ?? "#555555");
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(P.count * 3).map((_, i) => [c.r, c.g, c.b][i % 3]), 3));
    g.setIndex(p.geometry.index ? p.geometry.index.clone() : null);
    geos.push(g);
  }
  if (hornBase) geos.push(hornGeometry(hornBase, headSpan * 0.62, headIndex));
  const merged = mergeGeometries(geos, false);
  if (!merged) throw new Error("buffalo: merge failed");
  merged.computeBoundingSphere();
  // One skeleton, its inverses from the bones at rest (the model's own space).
  const skeleton = new THREE.Skeleton(bones);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  mat.name = "Buffalo";
  const mesh = new THREE.SkinnedMesh(merged, mat);
  mesh.name = "Buffalo";
  // Swap the 7 pieces for the one mesh, under the same parent as the bones' root.
  const parent = pieces[0].parent;
  for (const p of pieces) p.parent.remove(p);
  parent.add(mesh);
  mesh.bind(skeleton, new THREE.Matrix4());
  _template = { root, clips: gltf.animations };
  return _template;
}

/**
 * A few buffalo, each LIVING a little (your note: not one clip on a loop):
 * graze (Eating) for a while, lift the head and look round (Idle / Idle_2),
 * now and then walk a few metres to fresh grazing, turning as it goes — every
 * change a half-second crossfade. `spots`: [{ x, z, heightAt(x, z) }] —
 * heightAt gives where it stands (the water it wades in, the grass it grazes)
 * or null where it may not go, so a buffalo keeps to its own paddy.
 * Returns { update(dt), group, count }.
 */
export async function placeBuffalo(app, spots, { height = 1.4 } = {}) {
  if (!spots.length) return null;
  const tpl = await loadBuffaloTemplate();
  const box = new THREE.Box3().setFromObject(tpl.root);
  const scale = height / Math.max(0.01, box.max.y - box.min.y) * 1.08;
  const clipBy = (name) => tpl.clips.find((c) => c.name === name);
  const group = new THREE.Group();
  group.name = "Buffalo";
  const herd = [];
  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const s of spots) {
    const b = SkeletonUtils.clone(tpl.root);
    b.scale.setScalar(scale);
    b.position.set(s.x, s.heightAt(s.x, s.z) ?? 0, s.z);
    b.rotation.y = rnd() * Math.PI * 2;
    b.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; } });
    group.add(b);
    const mixer = new THREE.AnimationMixer(b);
    const act = {};
    for (const [k, n] of [["eat", "Eating"], ["idle", "Idle"], ["look", "Idle_2"], ["low", "Idle_Headlow"], ["walk", "Walk"]]) {
      const c = clipBy(n);
      if (c) act[k] = mixer.clipAction(c);
    }
    const a0 = act.eat ?? Object.values(act)[0];
    a0.time = rnd() * a0.getClip().duration;
    a0.play();
    herd.push({ b, s, mixer, act, cur: a0, state: "eat", timer: 4 + rnd() * 12, target: null });
  }
  const WALK_SPEED = 0.75;   // m/s, matched by eye to the Walk clip's stride at this size
  const go = (h, state, key, timer) => {
    const next = h.act[key] ?? h.act.eat;
    if (next !== h.cur) {
      next.reset().setEffectiveWeight(1).fadeIn(0.5).play();
      h.cur.fadeOut(0.5);
      h.cur = next;
    }
    h.state = state;
    h.timer = timer;
  };
  /** Fresh grazing 2-5 m off, reachable in a straight line on allowed ground. */
  const pickTarget = (h) => {
    const p = h.b.position;
    for (let k = 0; k < 24; k++) {
      const a = rnd() * Math.PI * 2, d = 2 + rnd() * 3;
      const x = p.x + Math.sin(a) * d, z = p.z + Math.cos(a) * d;
      let ok = true;
      for (let f = 0.25; f <= 1 && ok; f += 0.25) ok = h.s.heightAt(p.x + (x - p.x) * f, p.z + (z - p.z) * f) != null;
      if (ok) return { x, z };
    }
    return null;
  };
  app.scene.add(group);
  return {
    group, count: spots.length,
    /** For a look from the console: each buffalo's state and seconds left. */
    get herd() { return herd.map((h) => ({ state: h.state, timer: +h.timer.toFixed(1), at: [h.b.position.x, h.b.position.z].map((v) => +v.toFixed(1)) })); },
    update(dt) {
      for (const h of herd) {
        h.mixer.update(dt);
        h.timer -= dt;
        if (h.state === "walk") {
          const p = h.b.position, t = h.target;
          const dx = t.x - p.x, dz = t.z - p.z, dist = Math.hypot(dx, dz);
          // Turn toward the target as it walks (at most ~50°/s).
          const want = Math.atan2(dx, dz);
          let dA = want - h.b.rotation.y;
          dA = Math.atan2(Math.sin(dA), Math.cos(dA));
          h.b.rotation.y += Math.max(-0.9 * dt, Math.min(0.9 * dt, dA));
          const step = Math.min(dist, WALK_SPEED * dt * Math.max(0, Math.cos(dA)));
          const nx = p.x + Math.sin(h.b.rotation.y) * step, nz = p.z + Math.cos(h.b.rotation.y) * step;
          const y = h.s.heightAt(nx, nz);
          if (y != null) { p.x = nx; p.z = nz; p.y += (y - p.y) * Math.min(1, dt * 4); }
          if (dist < 0.4 || y == null || h.timer < 0) go(h, "eat", "eat", 8 + rnd() * 14);
          continue;
        }
        if (h.timer > 0) continue;
        const r = rnd();
        if (h.state === "eat" && r < 0.4) go(h, "look", r < 0.2 ? "idle" : "look", 3 + rnd() * 4);
        else if (r < 0.85 && (h.target = pickTarget(h))) go(h, "walk", "walk", 12);
        else go(h, "eat", rnd() < 0.2 ? "low" : "eat", 6 + rnd() * 12);
      }
    },
  };
}
