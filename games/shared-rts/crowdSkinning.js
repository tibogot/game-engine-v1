// GPU crowd skinning — every soldier in the game in ONE draw call.
//
// A SkinnedMesh costs a draw call each, and its pose is computed in the vertex
// shader of every pass (beauty + one per shadow cascade). Six soldiers were
// already 6 draws; a real infantry force is unshippable that way.
//
// Instead (proven in v3/crowd-lab.html, and it works on the r184 we ship — this
// is NOT gated on r185, which only added it as an example):
//
//   • The clips' BONE MATRICES are baked once at load into a flat table:
//     [slice][bone] → mat4, where a slice is one sampled frame of one clip.
//   • A COMPUTE pass skins every vertex of every soldier into a storage buffer.
//   • ONE Mesh with `.count = n` draws the whole crowd.
//
// Per frame the CPU writes, per soldier: a transform, two slice indices, and a
// blend weight. That's it — no skeleton is re-posed, no mixer runs, so the CPU
// cost does not scale with crowd size (measured flat from 200 → 1000 soldiers).
//
// The two slices are what buys us the idle⇄run CROSSFADE: the compute shader
// skins the vertex against BOTH poses and mixes the results by the blend weight.
import * as THREE from "three";
import { markGpuOnly } from "../../v3/render/gpuOnlyArrays.js";
import {
  Fn, add, attributeArray, cos, cross, dot, float, floor, instanceIndex, max, min, mix, select, sin, sqrt, storage, transformNormal,
  transformNormalToView, uint, uniform, uniformArray, vec2, vec3, vec4, vertexIndex,
} from "three/tsl";

const BAKE_FPS = 30; // sampling rate of the baked clips (RTS zoom hides the steps)

// ── MEN BLOWN APART (opt-in: createCrowdField's `gibs`) ─────────────────────
// A man killed close to a blast comes apart in the SKINNING PASS itself: every
// vertex belongs to one of six parts (by its strongest bone), and a gibbed
// instance moves each part as a rigid piece — thrown, spinning, falling, lying
// where it lands. No new mesh, no new draw: the parts are the crowd's own
// vertices in his last pose, in his own look, with his shadow. A gibbed
// instance's anim .z (the crossfade, 0-1 for everyone else) carries the
// seed and the clock: 2 + seed·64 + seconds.
//
// The same motion runs on the CPU (gibMatrix) for his rigid kit — the helmet
// goes with the head, the rifle with the arm. Both read the SAME random table
// (GIB_RAND, a uniform on the GPU): a sin-hash differs between float32 and
// float64, and the helmet would fly off on its own.
export const GIB = { HEAD: 1, ARM_L: 2, ARM_R: 3, LEG_L: 4, LEG_R: 5, TORSO: 0, PARTS: 6, SEEDS: 16, GRAVITY: 22 };
const GIB_RAND = (() => {
  let s = 0x9e3779b9;
  const r = () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) ^ Math.imul(s ^ (s >>> 13), 0x297a2d39)) >>> 0) / 4294967296;
  return Array.from({ length: GIB.SEEDS * GIB.PARTS }, () => new THREE.Vector4(r(), r(), r(), r()));
})();

/**
 * One part's flight, the CPU side: `r` its four randoms, `piv` its joint and
 * `torso` the chest (world), `ground` the height it comes to rest on, `t`
 * seconds since the blast. → { ox, oy, oz, ax, ay, az, angle }: offset of the
 * joint, spin axis, angle turned. MUST match the kernel's (gibMotionNode).
 */
function gibMotion(r, part, piv, torso, ground, t) {
  const torsoPart = part === GIB.TORSO;
  let dx = piv.x - torso.x + (r.x - 0.5) * 0.8, dz = piv.z - torso.z + (r.y - 0.5) * 0.8;
  const dl = Math.max(Math.hypot(dx, dz), 1e-3);
  dx /= dl; dz /= dl;
  const speedH = torsoPart ? 1 + 1.5 * r.z : 2.5 + 4 * r.z;
  const vy = torsoPart ? 2.5 + 2 * r.w : part === GIB.HEAD ? 5.5 + 3 * r.w : 4.5 + 4.5 * r.w;
  let ax = r.y - 0.5, ay = r.z - 0.5 + 0.001, az = r.x - 0.5;
  const al = Math.hypot(ax, ay, az);
  ax /= al; ay /= al; az /= al;
  const w = torsoPart ? 3 + 3 * r.w : 7 + 9 * r.x;
  const h0 = Math.max(piv.y - ground - (torsoPart ? 0.25 : 0.12), 0);
  const G = GIB.GRAVITY;
  const te = Math.min(t, (vy + Math.sqrt(vy * vy + 2 * G * h0)) / G);
  return { ox: dx * speedH * te, oy: vy * te - 0.5 * G * te * te, oz: dz * speedH * te, ax, ay, az, angle: w * te };
}

/** The same flight as nodes (TSL), for the skinning kernel. */
function gibMotionNode(r, part, piv, torso, ground, t) {
  const torsoPart = part.lessThan(0.5);
  const d0 = vec2(piv.x.sub(torso.x).add(r.x.sub(0.5).mul(0.8)), piv.z.sub(torso.z).add(r.y.sub(0.5).mul(0.8)));
  const d = d0.div(max(d0.length(), 1e-3));
  const speedH = select(torsoPart, r.z.mul(1.5).add(1), r.z.mul(4).add(2.5));
  const vy = select(torsoPart, r.w.mul(2).add(2.5), select(part.lessThan(1.5), r.w.mul(3).add(5.5), r.w.mul(4.5).add(4.5)));
  const axis = vec3(r.y.sub(0.5), r.z.sub(0.5).add(0.001), r.x.sub(0.5)).normalize();
  const w = select(torsoPart, r.w.mul(3).add(3), r.x.mul(9).add(7));
  const h0 = max(piv.y.sub(ground).sub(select(torsoPart, float(0.25), float(0.12))), 0);
  const G = float(GIB.GRAVITY);
  const te = min(t, vy.add(sqrt(vy.mul(vy).add(G.mul(2).mul(h0)))).div(G));
  const offset = vec3(d.x.mul(speedH).mul(te), vy.mul(te).sub(G.mul(0.5).mul(te).mul(te)), d.y.mul(speedH).mul(te));
  return { offset, axis, angle: w.mul(te) };
}
/** Rodrigues: `v` turned by `angle` about the unit `axis` (nodes). */
const rotateNode = (v, axis, angle) => {
  const c = cos(angle), s = sin(angle);
  return v.mul(c).add(cross(axis, v).mul(s)).add(axis.mul(dot(axis, v)).mul(c.oneMinus()));
};

const _gibB = new THREE.Matrix4(), _gibAxis = new THREE.Vector3();
const _gibP = new THREE.Vector3(), _gibT = new THREE.Vector3(), _gibF = new THREE.Vector3(), _gibF2 = new THREE.Vector3();

/**
 * Re-cut a skinned geometry so no triangle spans two parts: each triangle goes
 * to the part most of its corners belong to, and a corner shared across a cut
 * is duplicated (one copy per part). Triangle order is kept, so groups stay
 * valid. → { geometry, part: Float32Array per new vertex }.
 */
function splitByPart(geo, vPart) {
  const idx = geo.index ? geo.index.array : null;
  const nTri = (idx ? idx.length : geo.getAttribute("position").count) / 3;
  const map = new Map(), srcOf = [], partOf = [], index = new Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
    const pa = vPart[a], pb = vPart[b], pc = vPart[c];
    const p = pb === pc ? pb : pa;
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c, key = v * 8 + p;
      let ni = map.get(key);
      if (ni === undefined) { ni = srcOf.length; map.set(key, ni); srcOf.push(v); partOf.push(p); }
      index[t * 3 + k] = ni;
    }
  }
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(geo.attributes)) {
    // Raw components (an interleaved glTF attribute reads through its buffer).
    const n = attr.itemSize, il = attr.isInterleavedBufferAttribute;
    const src = il ? attr.data.array : attr.array, stride = il ? attr.data.stride : n, off = il ? attr.offset : 0;
    const arr = new src.constructor(srcOf.length * n);
    for (let i = 0; i < srcOf.length; i++) for (let j = 0; j < n; j++) arr[i * n + j] = src[srcOf[i] * stride + off + j];
    out.setAttribute(name, new THREE.BufferAttribute(arr, n, attr.normalized));
  }
  out.setIndex(index);
  for (const g of geo.groups) out.addGroup(g.start, g.count, g.materialIndex);
  out.userData = { ...geo.userData };
  return { geometry: out, part: Float32Array.from(partOf) };
}

/**
 * Sample every clip into one flat bone-matrix table.
 *
 * Returns the table plus, for each clip, where its frames start and how many
 * there are — which is all the per-frame code needs to point a soldier at a pose.
 */
function bakeClips(animRoot, skeleton, clips) {
  const mixer = new THREE.AnimationMixer(animRoot);
  const boneCount = skeleton.bones.length;

  const plan = [];
  let slices = 0;
  for (const [name, clip] of Object.entries(clips)) {
    const frames = Math.max(2, Math.round(clip.duration * BAKE_FPS));
    plan.push({ name, clip, frames, offset: slices });
    slices += frames;
  }

  const table = new Float32Array(slices * boneCount * 16);
  const info = {};

  for (const { name, clip, frames, offset } of plan) {
    const action = mixer.clipAction(clip);
    action.reset().play();
    for (let f = 0; f < frames; f++) {
      // setTime drives the WHOLE mixer, so only this clip may be playing.
      mixer.setTime((f / frames) * clip.duration);
      animRoot.updateMatrixWorld(true);
      skeleton.update();
      table.set(skeleton.boneMatrices, (offset + f) * boneCount * 16);
    }
    action.stop();
    info[name] = { offset, frames, duration: clip.duration };
  }

  mixer.stopAllAction();
  return { table, slices, boneCount, info };
}

/**
 * @param {object}  o
 * @param {THREE.SkinnedMesh} o.source  merged template mesh (geometry + skeleton)
 * @param {THREE.Object3D}    o.animRoot object holding the bones, for baking
 * @param {object}  o.clips   { idle: AnimationClip, run: AnimationClip }
 * @param {number}  o.max     instance capacity (sizes the storage buffers)
 * @param {boolean} o.drawMesh false: no mesh of its own in the scene — the
 *   caller draws RANGES of the crowd through view() (one per look)
 * @param {THREE.BufferGeometry} [o.geometry] the skinned geometry, if not the
 *   source's own (a body with skinned kit merged in — unitRenderer.js)
 */
export function createCrowdField({
  scene, renderer, source, animRoot, clips, max = 128, castShadow = true, aliases = {}, drawMesh = true,
  geometry: geometryIn = null,
  // MEN BLOWN APART (see GIB above): { partOfBone: part per bone index,
  // pivots: 6 bone indices (each part's joint, by GIB part), feet: [l, r] }.
  // null: the kernel as it was. A field made with it holds ONLY gibbed men
  // (every addPose passes `gib`): its own small crowd beside the living one.
  gibs = null,
  shareFrom = null,
}) {
  const skeleton = source.skeleton;
  let geometry = (geometryIn ?? source.geometry).clone();
  let vPart = null;
  if (gibs) {
    // Each vertex's part: its strongest bone's.
    const si = geometry.getAttribute("skinIndex"), sw = geometry.getAttribute("skinWeight");
    const raw = new Uint8Array(si.count);
    for (let i = 0; i < si.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = si.getComponent(i, k); } }
      raw[i] = gibs.partOfBone[best] ?? GIB.TORSO;
    }
    ({ geometry, part: vPart } = splitByPart(geometry, raw));
  }
  const vertexCount = geometry.getAttribute("position").count;

  // `shareFrom`: another field of the SAME body and clips (a gib field beside
  // its living crowd) — its baked table and its GPU copy, not a second bake.
  const baked = shareFrom?.baked ?? (() => {
    const b = bakeClips(animRoot, skeleton, clips);
    const boneTable = new THREE.StorageBufferAttribute(b.slices * b.boneCount, 16);
    boneTable.array.set(b.table);
    boneTable.needsUpdate = true;
    markGpuOnly(boneTable);   // the CPU keeps its own b.table

    return { ...b, bones: storage(boneTable, "mat4", boneTable.count).toReadOnly() };
  })();
  const { table, boneCount, info, bones } = baked;

  // ── Static, upload-once buffers ────────────────────────────────────────────

  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const src = new Float32Array(vertexCount * 8); // 2 × vec4 per vertex
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 8;
    src[o + 0] = position.getX(i); src[o + 1] = position.getY(i); src[o + 2] = position.getZ(i);
    src[o + 4] = normal.getX(i); src[o + 5] = normal.getY(i); src[o + 6] = normal.getZ(i);
    if (vPart) src[o + 3] = vPart[i];   // the spare lane: the vertex's part (gibs)
  }
  // Gibs: each part's joint (and the feet, for the ground) in BIND space —
  // the bone's bind position, where the kernel's skinVertex lives — with the
  // bone's index in .w; and the shared random table.
  const gibJoints = gibs ? [...gibs.pivots, ...gibs.feet].map((b) => {
    const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(skeleton.boneInverses[b]).invert());
    return new THREE.Vector4(p.x, p.y, p.z, b);
  }) : null;
  const uGibJoints = gibs ? uniformArray(gibJoints, "vec4") : null;
  const uGibRand = gibs ? uniformArray(GIB_RAND, "vec4") : null;
  const sourceVerts = storage(new THREE.StorageBufferAttribute(src, 4), "vec4", vertexCount * 2).toReadOnly();
  const skinIndices = storage(
    new THREE.StorageBufferAttribute(new Uint32Array(geometry.getAttribute("skinIndex").array), 4),
    "uvec4", vertexCount,
  ).toReadOnly();
  const skinWeights = storage(
    new THREE.StorageBufferAttribute(geometry.getAttribute("skinWeight").array, 4),
    "vec4", vertexCount,
  ).toReadOnly();

  const uBind = uniform(source.bindMatrix, "mat4");
  const uBindInv = uniform(source.bindMatrixInverse, "mat4");

  // ── Per-soldier buffers, rewritten each frame ──────────────────────────────
  const instMatrices = new THREE.StorageBufferAttribute(max, 16);
  // Animation state PACKED into one buffer: (idle slice, run slice, blend, —).
  // A storage binding is a scarce resource — the default cap is 8 per shader
  // stage, and this kernel was hitting it. Packing keeps us inside the default,
  // so the crowd works on stricter devices, not just this one.
  const anim = new THREE.StorageBufferAttribute(max, 4);

  const instMatricesNode = storage(instMatrices, "mat4", max).toReadOnly();
  const animNode = storage(anim, "vec4", max).toReadOnly();
  // Per-soldier values for the MATERIAL (not the kernel, whose storage
  // bindings are at the cap): a stable random look variation, etc. Written by
  // addPose's `extra`; read in the vertex stage (soldierLooks' variation).
  const extra = new THREE.StorageBufferAttribute(max, 4);
  const extraNode = storage(extra, "vec4", max).toReadOnly();

  // Output: skinned position + normal, per soldier per vertex.
  const out = attributeArray(max * vertexCount * 2, "vec4");
  // Only the GPU writes the output and only the kernel reads the sources: a
  // game's releaseGpuOnly drops their CPU copies (~12 MB a crowd for `out`).
  markGpuOnly(out.value, sourceVerts.value, skinIndices.value);

  // ── The compute kernel ─────────────────────────────────────────────────────
  const kernel = Fn(() => {
    const vert = instanceIndex.mod(uint(vertexCount));
    const inst = instanceIndex.div(uint(vertexCount));
    const srcOff = vert.mul(uint(2));
    const dstOff = instanceIndex.mul(uint(2));

    const localPos = sourceVerts.element(srcOff).xyz;
    const localNrm = sourceVerts.element(srcOff.add(uint(1))).xyz;
    const skinIndex = skinIndices.element(vert);
    const w = skinWeights.element(vert);

    const skinVertex = uBind.mul(vec4(localPos, 1.0));

    // Skin this vertex against ONE pose (a slice of the baked table).
    const poseAt = (sliceIndex) => {
      const off = sliceIndex.mul(uint(boneCount));
      const b0 = bones.element(off.add(skinIndex.x));
      const b1 = bones.element(off.add(skinIndex.y));
      const b2 = bones.element(off.add(skinIndex.z));
      const b3 = bones.element(off.add(skinIndex.w));

      const skinMatrix = add(w.x.mul(b0), w.y.mul(b1), w.z.mul(b2), w.w.mul(b3));

      const pos = uBindInv.mul(add(
        b0.mul(w.x).mul(skinVertex),
        b1.mul(w.y).mul(skinVertex),
        b2.mul(w.z).mul(skinVertex),
        b3.mul(w.w).mul(skinVertex),
      )).xyz;

      const nrm = uBindInv.mul(skinMatrix).mul(uBind).transformDirection(localNrm).xyz;
      return { pos, nrm };
    };

    // Crossfade idle ⇄ run by skinning against both poses and mixing the RESULT.
    // (Lerping the bone matrices themselves is cheaper but skews limbs mid-blend.)
    const state = animNode.element(inst); // (idle slice, run slice, blend, —)
    const a = poseAt(uint(state.x));
    // A GIB field (every instance blown apart) holds one frozen pose: no
    // second skin, no crossfade — .z is 2 + seed·64 + seconds instead (GIB).
    const b = gibs ? a : poseAt(uint(state.y));
    const pos = gibs ? a.pos : mix(a.pos, b.pos, state.z);
    const nrm = gibs ? a.nrm.normalize() : mix(a.nrm, b.nrm, state.z).normalize();

    const m = instMatricesNode.element(inst);
    const wp = m.mul(vec4(pos, 1.0)).xyz.toVar();
    const wn = transformNormal(nrm, m).toVar();
    if (gibs) {
      {
        const g = state.z.sub(2);
        const seed = floor(g.div(64));
        const t = g.sub(seed.mul(64));
        const part = sourceVerts.element(srcOff).w;
        const off = uint(state.x).mul(uint(boneCount));
        // A joint where this pose has it, in the world.
        const joint = (k) => {
          const j = uGibJoints.element(k);
          return m.mul(vec4(uBindInv.mul(bones.element(off.add(uint(j.w))).mul(vec4(j.xyz, 1.0))).xyz, 1.0)).xyz;
        };
        const piv = joint(uint(part));
        const torso = joint(uint(GIB.TORSO));
        const ground = min(joint(uint(GIB.PARTS)).y, joint(uint(GIB.PARTS + 1)).y).sub(0.08);
        const r = uGibRand.element(uint(seed).mul(uint(GIB.PARTS)).add(uint(part)));
        const f = gibMotionNode(r, part, piv, torso, ground, t);
        wp.assign(piv.add(rotateNode(wp.sub(piv), f.axis, f.angle)).add(f.offset));
        wn.assign(rotateNode(wn, f.axis, f.angle));
      }
    }
    out.element(dstOff).assign(vec4(wp, 1));
    out.element(dstOff.add(uint(1))).assign(vec4(wn, 0));
  })().compute(max * vertexCount).setName("Crowd skinning");

  // ── Drawing ────────────────────────────────────────────────────────────────
  /** The skinned vertex of instance `inst` (a node): position + view normal. */
  const skinnedAt = (inst) => {
    const v = inst.mul(uint(vertexCount)).add(vertexIndex).mul(uint(2));
    return {
      positionNode: out.element(v).xyz,
      normalNode: transformNormalToView(out.element(v.add(uint(1))).xyz).toVarying(),
    };
  };

  // The one mesh that draws every soldier.
  const material = source.material.clone();
  const own = skinnedAt(instanceIndex);
  material.positionNode = own.positionNode;
  material.normalNode = own.normalNode;
  // ONE PROGRAM PER CROWD. Two crowds (a second soldier type on the same model)
  // build node graphs identical but for WHICH storage buffer they read, and
  // three keyed them as one program — the second mesh then drew the FIRST
  // crowd's skinned vertices (its soldiers appeared on top of the other
  // side's, invisible). A key of its own gives each crowd its own bindings.
  const programKey = `crowd:${material.uuid}`;
  material.customProgramCacheKey = () => programKey;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.count = 0;
  mesh.frustumCulled = false; // soldiers live anywhere; the shared bounds mean nothing
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  if (drawMesh) scene.add(mesh);

  let n = 0;

  /**
   * Which baked slice a clip is on at time `t`. `hold`: a one-shot (a death)
   * stops on its last frame instead of looping.
   */
  const sliceOf = (clipName, t, hold = false) => {
    const c = info[aliases[clipName] ?? clipName];
    const u = hold ? Math.min(Math.max(t, 0), c.duration * 0.999) : (((t % c.duration) + c.duration) % c.duration);
    const f = Math.floor((u / c.duration) * c.frames);
    return c.offset + Math.min(f, c.frames - 1);
  };

  /** A part's joint in his last pose (world) and its flight at gibT (gibMotion). */
  function gibPart(clip, t, part, seed, gibT, matrix) {
    const slice = sliceOf(clip, t);
    const joint = (k, v) => {
      const j = gibJoints[k];
      _gibB.fromArray(table, (slice * boneCount + j.w) * 16);
      return v.set(j.x, j.y, j.z).applyMatrix4(_gibB).applyMatrix4(source.bindMatrixInverse).applyMatrix4(matrix);
    };
    const piv = joint(part, _gibP), torso = joint(GIB.TORSO, _gibT);
    const ground = Math.min(joint(GIB.PARTS, _gibF).y, joint(GIB.PARTS + 1, _gibF2).y) - 0.08;
    return { piv, f: gibMotion(GIB_RAND[(seed % GIB.SEEDS) * GIB.PARTS + part], part, piv, torso, ground, gibT) };
  }

  return {
    mesh,
    /** The baked clips and their GPU table (shareFrom). */
    baked,
    /** Per-soldier (idle slice, run slice, blend, team) — the x-ray reads the team. */
    animNode,
    /** Per-soldier vec4 for the material (addPose's `extra`), e.g. the look variation. */
    extraNode,
    /** Instances queued so far this frame (the next one's index). */
    get count() { return n; },
    /** The skinned vertex of instance `inst` (a node): { positionNode, normalNode }. */
    skinnedAt,
    /**
     * A mesh drawing a RANGE of this crowd — instances [start, start + count)
     * — with its own material: one per LOOK, so several soldier types dressed
     * on one body share the skinning, the clip table and the buffers, and each
     * keeps its own shader (no per-pixel branching between looks). Write each
     * view's soldiers contiguously, then setRange(). `index` is the instance's
     * index in the crowd (for extraNode / animNode reads in the material).
     */
    view(viewMaterial, name = "CrowdView") {
      const base = uniform(0, "uint");
      const index = instanceIndex.add(base);
      const nodes = skinnedAt(index);
      viewMaterial.positionNode = nodes.positionNode;
      viewMaterial.normalNode = nodes.normalNode;
      // Its own program: it reads THIS crowd's buffers (see ONE PROGRAM PER CROWD).
      const key = `crowd:${viewMaterial.uuid}`;
      viewMaterial.customProgramCacheKey = () => key;
      const m = new THREE.Mesh(geometry, viewMaterial);
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;
      m.castShadow = castShadow;
      m.receiveShadow = true;
      m.name = name;
      scene.add(m);
      return {
        mesh: m, index,
        setRange(start, count) { base.value = start; m.count = count; m.visible = count > 0; },
      };
    },
    /** The baked clips' names (plus the aliases). */
    has: (clipName) => !!info[aliases[clipName] ?? clipName],
    capacity: max,
    /** Bytes of skinned-vertex storage — the one cost that scales with capacity. */
    bytes: max * vertexCount * 2 * 16,

    begin() { n = 0; },

    /**
     * Queue one soldier.
     * @param {THREE.Matrix4} matrix  world transform
     * @param {number} time           this soldier's own animation clock
     * @param {number} blend          0 = idle, 1 = run (crossfaded on the GPU)
     */
    add(matrix, time, blend, team = 0) {
      if (n >= max) return false;
      matrix.toArray(instMatrices.array, n * 16);
      const o = n * 4;
      anim.array[o + 0] = sliceOf("idle", time);
      anim.array[o + 1] = sliceOf("run", time);
      anim.array[o + 2] = blend;
      anim.array[o + 3] = team;   // the spare lane: 0 ours, 1 theirs (the x-ray colour)
      n++;
      return true;
    },

    /**
     * Queue one instance between ANY two baked clips (the kernel only ever
     * sees two slices and a blend): `clipA` at its own time `tA`, crossfaded
     * by `blend` (0 → 1) into `clipB` at `tB`. For animals with more than
     * the soldiers' idle/run — graze, look round, walk (buffalo.js).
     */
    addPose(matrix, clipA, tA, clipB, tB, blend, lane = 0, { holdA = false, holdB = false, extra: ex = null, gib = null } = {}) {
      if (n >= max) return false;
      matrix.toArray(instMatrices.array, n * 16);
      const o = n * 4;
      anim.array[o + 0] = sliceOf(clipA, tA, holdA);
      anim.array[o + 1] = sliceOf(clipB, tB, holdB);
      // `gib` { seed, t } (a field made with `gibs`): blown apart, pose A.
      anim.array[o + 2] = gib && gibs ? 2 + (gib.seed % GIB.SEEDS) * 64 + Math.min(gib.t, 63.9) : blend;
      anim.array[o + 3] = lane;
      if (ex) { extra.array[o] = ex[0]; extra.array[o + 1] = ex[1]; extra.array[o + 2] = ex[2]; extra.array[o + 3] = ex[3] ?? 0; }
      n++;
      return true;
    },

    /** Seconds in a baked clip (to keep an instance's clock on its loop). */
    duration: (clipName) => info[aliases[clipName] ?? clipName]?.duration ?? 1,

    /** A bone's index in the baked table (by name), or −1. */
    boneIndex: (name) => skeleton.bones.findIndex((b) => b.name === name),

    /**
     * One bone's baked SKINNING matrix (bone world · bone inverse) for the pose
     * an instance is drawn with — clipA at tA crossfaded by `blend` into clipB
     * at tB — from the CPU copy of the table, blended like the GPU does. What
     * a rigid piece on that bone (a rifle in the hand, a hat) is placed with,
     * so it follows the skinned body exactly without being skinned itself.
     */
    boneMatrix(clipA, tA, clipB, tB, blend, bone, out, { holdA = false, holdB = false } = {}) {
      const a = (sliceOf(clipA, tA, holdA) * boneCount + bone) * 16;
      const b = (sliceOf(clipB, tB, holdB) * boneCount + bone) * 16;
      const e = out.elements;
      for (let k = 0; k < 16; k++) e[k] = table[a + k] + (table[b + k] - table[a + k]) * blend;
      return out;
    },

    /** Made with `gibs`: men can come apart. Part of each bone (for rigid kit). */
    gibs: gibs ? { partOfBone: gibs.partOfBone } : null,

    /**
     * A gibbed man's PART as a rigid motion, the CPU twin of the kernel's: a
     * world matrix that carries what was on that part in his last pose (clip
     * at t, not held) to where it is `gibT` seconds after the blast. `matrix`
     * is his instance matrix (as given to addPose). For his helmet, his rifle.
     */
    gibMatrix(clip, t, part, seed, gibT, matrix, out) {
      const { piv, f } = gibPart(clip, t, part, seed, gibT, matrix);
      _gibAxis.set(f.ax, f.ay, f.az);
      // T(piv + offset) · R · T(−piv)
      out.makeRotationAxis(_gibAxis, f.angle);
      _gibB.makeTranslation(-piv.x, -piv.y, -piv.z);
      out.multiply(_gibB);
      out.premultiply(_gibB.makeTranslation(piv.x + f.ox, piv.y + f.oy, piv.z + f.oz));
      return out;
    },
    /** Where each of a gibbed man's six parts comes to rest (its joint), in the world. */
    gibLandings(clip, t, seed, matrix) {
      const out = [];
      for (let p = 0; p < GIB.PARTS; p++) {
        const { piv, f } = gibPart(clip, t, p, seed, 60, matrix);
        out.push({ part: p, x: piv.x + f.ox, y: piv.y + f.oy, z: piv.z + f.oz });
      }
      return out;
    },

    commit() {
      mesh.count = n;
      if (!drawMesh) mesh.visible = false;
      // AN EMPTY CROWD COSTS NOTHING: no upload, no dispatch, no draw. The
      // kernel is sized to capacity, so an idle type (no fighters out of the
      // cave yet, a second army on the same model) would otherwise skin 160
      // soldiers' worth every frame for no one.
      if (drawMesh) mesh.visible = n > 0;
      if (n === 0) return;
      instMatrices.needsUpdate = true;
      anim.needsUpdate = true;
      extra.needsUpdate = true;
      // Dispatch sized to the LIVE soldiers: renderer.compute takes the thread
      // count per call (WebGPUBackend: workgroups = ceil(count / 64)). It used
      // to be the capacity — 160 soldiers skinned with 5 alive. (One dimension
      // caps at 65 535 workgroups: ~1 700 soldiers of ~2 400 vertices a crowd.)
      renderer.compute(kernel, n * vertexCount);
    },

    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
