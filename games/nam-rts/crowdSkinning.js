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
 */
export function createCrowdField({
  scene, renderer, source, animRoot, clips, max = 128, castShadow = true,
}) {
  const skeleton = source.skeleton;
  const geometry = source.geometry.clone();
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

  // ── The one mesh that draws every soldier ──────────────────────────────────
  const material = source.material.clone();
  const meshVertex = instanceIndex.mul(uint(vertexCount)).add(vertexIndex).mul(uint(2));
  material.positionNode = out.element(meshVertex).xyz;
  material.normalNode = transformNormalToView(out.element(meshVertex.add(uint(1))).xyz).toVarying();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.count = 0;
  mesh.frustumCulled = false; // soldiers live anywhere; the shared bounds mean nothing
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  scene.add(mesh);

  let n = 0;

  /** Which baked slice a clip is on at time `t`. */
  const sliceOf = (clipName, t) => {
    const c = info[clipName];
    const f = Math.floor((((t % c.duration) + c.duration) % c.duration) / c.duration * c.frames);
    return c.offset + Math.min(f, c.frames - 1);
  };

  return {
    mesh,
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
    add(matrix, time, blend) {
      if (n >= max) return false;
      matrix.toArray(instMatrices.array, n * 16);
      const o = n * 4;
      anim.array[o + 0] = sliceOf("idle", time);
      anim.array[o + 1] = sliceOf("run", time);
      anim.array[o + 2] = blend;
      n++;
      return true;
    },

    commit() {
      mesh.count = n;
      instMatrices.needsUpdate = true;
      anim.needsUpdate = true;
      // Dispatch is sized to CAPACITY, not the live count (the kernel's size is
      // fixed at build). Instances past `count` write into the buffer but are
      // never drawn — bounded, cheap waste in exchange for a stable kernel.
      renderer.compute(kernel);
    },

    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      material.dispose();
    },
  };
}
