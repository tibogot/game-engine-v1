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
import {
  Fn, add, attributeArray, instanceIndex, mix, storage, transformNormal,
  transformNormalToView, uint, uniform, vec4, vertexIndex,
} from "three/tsl";

const BAKE_FPS = 30; // sampling rate of the baked clips (RTS zoom hides the steps)

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
}) {
  const skeleton = source.skeleton;
  const geometry = (geometryIn ?? source.geometry).clone();
  const vertexCount = geometry.getAttribute("position").count;

  const { table, slices, boneCount, info } = bakeClips(animRoot, skeleton, clips);

  // ── Static, upload-once buffers ────────────────────────────────────────────
  const boneTable = new THREE.StorageBufferAttribute(slices * boneCount, 16);
  boneTable.array.set(table);
  boneTable.needsUpdate = true;
  const bones = storage(boneTable, "mat4", boneTable.count).toReadOnly();

  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const src = new Float32Array(vertexCount * 8); // 2 × vec4 per vertex
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 8;
    src[o + 0] = position.getX(i); src[o + 1] = position.getY(i); src[o + 2] = position.getZ(i);
    src[o + 4] = normal.getX(i); src[o + 5] = normal.getY(i); src[o + 6] = normal.getZ(i);
  }
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
    const b = poseAt(uint(state.y));
    const pos = mix(a.pos, b.pos, state.z);
    const nrm = mix(a.nrm, b.nrm, state.z).normalize();

    const m = instMatricesNode.element(inst);
    out.element(dstOff).assign(vec4(m.mul(vec4(pos, 1.0)).xyz, 1));
    out.element(dstOff.add(uint(1))).assign(vec4(transformNormal(nrm, m), 0));
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

  return {
    mesh,
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
    addPose(matrix, clipA, tA, clipB, tB, blend, lane = 0, { holdA = false, holdB = false, extra: ex = null } = {}) {
      if (n >= max) return false;
      matrix.toArray(instMatrices.array, n * 16);
      const o = n * 4;
      anim.array[o + 0] = sliceOf(clipA, tA, holdA);
      anim.array[o + 1] = sliceOf(clipB, tB, holdB);
      anim.array[o + 2] = blend;
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
