import * as THREE from "three";

/**
 * ── ONE PIPELINE FOR A FAMILY OF INSTANCED MESHES ────────────────────────────
 *
 * MEASURED in road.html, GPU device instrumented, switching the city on:
 *
 *     285 render pipelines · 30.7 MB of WGSL handed to the driver
 *     …from 30 distinct shaders · 1.8 MB of it actually distinct
 *
 * The city facade's 271 kB fragment shader was compiled **41 times**. Not
 * because the shader varied — because the VERTEX shader did, by a few
 * characters, once per mesh:
 *
 *     struct NodeBuffer_267355Struct { value : array< mat4x4<f32>, 45  > };
 *     struct NodeBuffer_289109Struct { value : array< mat4x4<f32>, 133 > };
 *
 * Two things are baked into that: the instance COUNT, and the NODE ID. three
 * names every WGSL symbol after the node that produced it, and each
 * InstancedMesh makes its own instance-matrix node — so two meshes sharing a
 * material still produce textually different shaders, which are different
 * programs, which are different pipelines, each dragging a fresh compile of
 * whatever fragment shader sits beside it.
 *
 * ── WHY THE MATRICES ARE IN THE SHADER AT ALL ────────────────────────────────
 *
 * `InstanceNode._createInstanceMatrixNode` (three r184):
 *
 *     const uniformBufferSize = count * 16 * 4;
 *     if ( uniformBufferSize <= builder.getUniformBufferLimit() )
 *         instanceMatrixNode = buffer( instanceMatrix.array, 'mat4', count )…
 *     else
 *         …four instanced vec4 vertex attributes…
 *
 * A uniform array must be sized at compile time, so under the 64 kB limit —
 * 1024 instances — the count goes into the source. Past it, three switches to
 * VERTEX ATTRIBUTES, which are named by slot rather than by node, and every
 * mesh then generates the same shader.
 *
 * So: pad the matrix attribute past the cliff. `mesh.count` still decides how
 * many are drawn; only the allocation grows, by 65 kB a mesh.
 *
 *     MEASURED, same protocol, city switched on in a freshly loaded page:
 *       before   285 pipelines · 30.7 MB submitted · ~20.4 s GPU (n=3)
 *       after    144 pipelines ·  5.5 MB submitted · ~16   s GPU (n=3)
 *     and the facade itself: 41 pipelines → 3, which is the three genuine
 *     render-pass variants and nothing more.
 *
 * A STORAGE buffer was tried first and rejected: its array is runtime-sized so
 * the count leaves the source, but the symbol is still named after the node, so
 * the programs stay distinct and the pipeline count does not move at all.
 *
 * ── WHAT THIS COSTS ──────────────────────────────────────────────────────────
 *
 * 65 kB per mesh of matrices that are never drawn, and the same again in
 * instance colours where a mesh has them (three sizes `instanceColor` from
 * `instanceMatrix.count`). About 2.4 MB across the city. Runtime is unchanged:
 * vsync-locked at 16.7 ms, 93 draws, 3.6 ms GPU with the city on.
 *
 * ── AND THE TRAP IT SETS ─────────────────────────────────────────────────────
 *
 * `instanceMatrix.count` is now the CAPACITY, not the population — which is
 * what it has always meant in three (this codebase already allocates rail posts
 * at `n + INSTANCE_SLACK`), but three tests were reading it as a population and
 * had to be corrected. Read `mesh.count` for what is drawn; read
 * `instanceMatrix.count` only to ask "is there room".
 */

/** count * 64 B must exceed three's 64 kB uniform-buffer limit. */
export const ATTRIBUTE_PATH_MIN = 1025;

/**
 * Pad a mesh's instance matrices past three's uniform-buffer cliff, so it
 * shares one pipeline with every other mesh on the same material.
 *
 * Call it on construction, before any `setMatrixAt`. Idempotent, and a no-op
 * on a mesh that is already over the cliff.
 *
 * @param {THREE.InstancedMesh} mesh
 * @returns {THREE.InstancedMesh} the same mesh, for chaining
 */
export function shareInstancePipeline(mesh) {
  const m = mesh?.instanceMatrix;
  if (!m || m.count >= ATTRIBUTE_PATH_MIN) return mesh;
  const arr = new Float32Array(ATTRIBUTE_PATH_MIN * m.itemSize);
  arr.set(m.array.subarray(0, Math.min(m.array.length, arr.length)));
  const next = new THREE.InstancedBufferAttribute(arr, m.itemSize);
  next.usage = m.usage;
  mesh.instanceMatrix = next;
  return mesh;
}
