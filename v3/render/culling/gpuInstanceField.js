/**
 * A FIXED set of instances (props, rocks, structures) culled and LOD-picked on
 * the GPU, drawn with indirect draws — the static counterpart of ScatterField.
 *
 * ScatterField owns plants that live on a camera-following wrap tile and are
 * re-derived from paint every frame. Props are the opposite: placed once, each
 * with its own transform. They were culled on the CPU (PropInstancer: a loop
 * over every instance, then setMatrixAt into the camera's InstancedMesh), which
 * is right for 12k and grows linearly with the world. Here the loop is a
 * compute pass and nothing is uploaded per frame.
 *
 * ONE COMPUTE PER FRAME, one thread per instance:
 *   distance fade → frustum (gpuCull.js, the test every field shares) →
 *   occlusion (HiZPyramid, when given) → LOD by distance → atomic append into
 *   that (type, lod)'s slice of ONE compact list, whose count is the instance
 *   count of that draw's indirect args. `firstInstance` points each draw at its
 *   slice, so `instance_index` in the vertex shader already addresses it.
 *
 * DEBUG LIST. Instances the frustum kept but occlusion removed are appended to
 * a list of their own (one draw per type, flat red), shown only when asked.
 * Its counts are also the "occluded" statistic, so it is always filled.
 *
 * Not here yet (the PropInstancer parity list, after the lab proves the gain):
 * shadow lists per cascade, LOD hysteresis, hide/show and picking.
 */
import * as THREE from "three";
import {
  Fn, If, atomicAdd, atomicStore, cameraViewMatrix, float, hash, instanceIndex, instancedArray,
  length, normalLocal, normalize, positionLocal, step, storage, uint, uniform, varying, vec3, vec4,
} from "three/tsl";
import { frustumVisibleAtClip } from "../scatter/gpuCull.js";

export class GpuInstanceField {
  /**
   * @param {object} o
   *   renderer, scene
   *   types      [{ name, lods: BufferGeometry[] (indexed, same count per type),
   *                 color, roughness }]
   *   instances  { count, sphere: Float32Array(count·4) world centre + radius,
   *                rows: Float32Array(count·12) affine rows (3×vec4, row-major),
   *                type: Uint32Array(count) }
   *   lodDistances  [d1, d2, …] metres; one fewer than the LOD count
   *   fadeDistance  beyond this, not drawn at all
   *   hiz        HiZPyramid or null
   */
  constructor({ renderer, scene, name = "GpuProps", types, instances, lodDistances = [40, 110],
    fadeDistance = 600, hiz = null }) {
    this.renderer = renderer;
    this.name = name;
    this.types = types;
    this.hiz = hiz;
    const T = types.length;
    const L = (this.lods = types[0].lods.length);
    const N = (this.count = instances.count);

    // Sort by type so each type is one contiguous run: its draws' slices are
    // then exactly as long as the type has instances.
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => instances.type[a] - instances.type[b]);
    const sphere = new Float32Array(N * 4), rows = new Float32Array(N * 12), type = new Uint32Array(N);
    order.forEach((src, dst) => {
      sphere.set(instances.sphere.subarray(src * 4, src * 4 + 4), dst * 4);
      rows.set(instances.rows.subarray(src * 12, src * 12 + 12), dst * 12);
      type[dst] = instances.type[src];
    });
    const perType = new Array(T).fill(0);
    for (let i = 0; i < N; i++) perType[type[i]]++;
    this.perType = perType;

    // Slices: (t, l) for every draw, then one debug slice per type.
    const draws = (this.draws = T * L);
    const sliceBase = new Uint32Array(draws + T);
    let at = 0;
    for (let t = 0; t < T; t++) for (let l = 0; l < L; l++) { sliceBase[t * L + l] = at; at += perType[t]; }
    for (let t = 0; t < T; t++) { sliceBase[draws + t] = at; at += perType[t]; }
    const compactLen = at;

    this.bufSphere = instancedArray(sphere, "vec4");
    this.bufRows = instancedArray(rows, "vec4");
    this.bufType = instancedArray(type, "uint");
    this.bufCompact = instancedArray(Math.max(1, compactLen), "uint");

    const entries = (this.entries = draws + T);
    const args = new Uint32Array(entries * 5);
    for (let k = 0; k < entries; k++) args[k * 5 + 4] = sliceBase[k];
    for (let t = 0; t < T; t++) for (let l = 0; l < L; l++) args[(t * L + l) * 5] = types[t].lods[l].index.count;
    for (let t = 0; t < T; t++) args[(draws + t) * 5] = types[t].lods[L - 1].index.count;
    this._args = args;
    this.indirect = new THREE.IndirectStorageBufferAttribute(args, 5);
    this._argsStore = storage(this.indirect, "uint", entries * 5).toAtomic();

    this.u = {
      uCam: uniform(new THREE.Matrix4()),
      uCamPos: uniform(new THREE.Vector3()),
      uFx: uniform(1),
      uFy: uniform(1),
      uLod1: uniform(lodDistances[0] ?? 1e9),
      uLod2: uniform(lodDistances[1] ?? 1e9),
      uFade: uniform(fadeDistance),
      uOcclusion: uniform(hiz ? 1 : 0),
    };

    this._buildCompute();

    // Meshes: one per (type, lod), then the debug ones.
    this.group = new THREE.Group();
    this.group.name = name;
    scene.add(this.group);
    this.meshes = [];
    this.debugMeshes = [];
    const nodes = this._vertexNodes();
    // Every field reads its OWN buffers through an identical graph, and three
    // keys such materials as one program: a second field would draw the first
    // one's instances (ref: crowd program cache key). One key per field.
    const programKey = () => `gpuInstanceField:${this.group.uuid}`;
    for (let t = 0; t < T; t++) {
      const ty = types[t];
      for (let l = 0; l < L; l++) {
        const mat = new THREE.MeshStandardNodeMaterial({ color: ty.color ?? 0x888888, roughness: ty.roughness ?? 0.9 });
        mat.positionNode = nodes.position;
        mat.normalNode = nodes.normalView;
        mat.customProgramCacheKey = programKey;
        this.meshes.push(this._mesh(ty.lods[l], mat, t * L + l, `${name}:${ty.name}:lod${l}`));
      }
    }
    const red = new THREE.MeshBasicNodeMaterial({ color: 0xff2020 });
    red.positionNode = nodes.position;
    red.customProgramCacheKey = () => `gpuInstanceField:debug:${this.group.uuid}`;
    red.depthTest = false;        // the point is to see them THROUGH what hides them
    // …and they must not write depth either: they would stamp FAR values over
    // whatever hid them, the next pyramid would see through the hill, and the
    // debug view would change what it is showing.
    red.depthWrite = false;
    red.transparent = true;
    red.opacity = 0.55;
    for (let t = 0; t < T; t++) {
      const m = this._mesh(types[t].lods[L - 1], red, draws + t, `${name}:${types[t].name}:occluded`);
      m.visible = false;
      m.renderOrder = 10;
      this.debugMeshes.push(m);
    }
    this._frozen = false;
    this._camMatrix = new THREE.Matrix4();

    // Auto occlusion (see setOcclusion). The threshold is the break-even
    // measured in the lab; the frame counts only set how quickly it reacts.
    this.autoMinHidden = 0.15;
    this.autoOffFrames = 90;
    this.autoCheckFrames = 60;
    this._auto = { active: !!hiz, frame: 0, nextCheck: 3, offUntil: 0, pending: false, share: null };
    this.occlusionMode = hiz ? "auto" : "off";
  }

  _mesh(geometry, material, entry, name) {
    // Geometries may be shared between types or LODs; each draw needs its own
    // indirect offset, so each mesh gets a shallow copy that shares buffers.
    const geo = new THREE.BufferGeometry();
    geo.index = geometry.index;
    for (const k of Object.keys(geometry.attributes)) geo.setAttribute(k, geometry.attributes[k]);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    geo.setIndirect(this.indirect, entry * 5 * 4);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.frustumCulled = false;   // the compute culls, per instance
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.count = this.count;      // the indirect args carry the real count
    this.group.add(mesh);
    return mesh;
  }

  _vertexNodes() {
    const { bufCompact, bufRows } = this;
    const vNormal = varying(vec3(0, 1, 0), "vGpuPropNormal");
    const position = Fn(() => {
      const id = bufCompact.element(instanceIndex);
      const r0 = bufRows.element(id.mul(3));
      const r1 = bufRows.element(id.mul(3).add(1));
      const r2 = bufRows.element(id.mul(3).add(2));
      const p = positionLocal;
      const n = normalLocal;
      // Rotation × uniform scale: the rows transform the normal too. A prop
      // with non-uniform scale would need the inverse transpose.
      vNormal.assign(normalize(vec3(r0.xyz.dot(n), r1.xyz.dot(n), r2.xyz.dot(n))));
      return vec3(r0.xyz.dot(p).add(r0.w), r1.xyz.dot(p).add(r1.w), r2.xyz.dot(p).add(r2.w));
    })();
    const normalView = normalize(cameraViewMatrix.mul(vec4(vNormal, 0)).xyz);
    return { position, normalView };
  }

  _buildCompute() {
    const { u, bufSphere, bufType, bufCompact, _argsStore: args, hiz } = this;
    const L = this.lods, draws = this.draws, entries = this.entries;
    const sliceBase = instancedArray(new Uint32Array(this._args.filter((_, i) => i % 5 === 4)), "uint");

    this.computeReset = Fn(() => {
      for (let k = 0; k < entries; k++) atomicStore(args.element(k * 5 + 1), uint(0));
    })().compute(1, [1]);

    this.computeCull = Fn(() => {
      const s = bufSphere.element(instanceIndex);
      const t = bufType.element(instanceIndex);
      const dist = length(s.xyz.sub(u.uCamPos));
      If(dist.lessThan(u.uFade), () => {
        const clip = u.uCam.mul(vec4(s.xyz, 1));
        const inFrustum = frustumVisibleAtClip(clip, u.uFx, u.uFy, s.w, float(0), float(0), float(0));
        If(inFrustum.greaterThan(0.5), () => {
          const visible = hiz ? float(1).sub(u.uOcclusion).max(hiz.visibleNode(s.xyz, s.w)) : float(1);
          If(visible.greaterThan(0.5), () => {
            // LOD by distance, the switch spread ±5% per instance so it
            // never draws a ring.
            const k = hash(instanceIndex.add(911)).mul(0.1).add(0.95);
            let lod = step(u.uLod1.mul(k), dist);
            if (L > 2) lod = lod.add(step(u.uLod2.mul(k), dist));
            const draw = t.mul(uint(L)).add(uint(lod));
            const slot = atomicAdd(args.element(draw.mul(5).add(1)), uint(1));
            bufCompact.element(sliceBase.element(draw).add(slot)).assign(instanceIndex);
          }).Else(() => {
            const draw = t.add(uint(draws));
            const slot = atomicAdd(args.element(draw.mul(5).add(1)), uint(1));
            bufCompact.element(sliceBase.element(draw).add(slot)).assign(instanceIndex);
          });
        });
      });
    })().compute(this.count, [64]);
    this._hizVersion = hiz?.version;
  }

  /**
   * MEASUREMENT ONLY: `n` independent copies of the cull's visibility test
   * (frustum, plus occlusion when `occlusion`), each counting into a sink so
   * the compiler cannot drop the work. Run them next to the real cull and the
   * test's own cost is (delta) / n. Copies, not repeats — see makeBuildCopies.
   */
  makeTestCopies(n, occlusion) {
    const { u, bufSphere, hiz } = this;
    const sink = (this._sink ??= instancedArray(1, "uint").toAtomic());
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(Fn(() => {
        const s = bufSphere.element(instanceIndex);
        const clip = u.uCam.mul(vec4(s.xyz, 1));
        const inFrustum = frustumVisibleAtClip(clip, u.uFx, u.uFy, s.w, float(0), float(0), float(0));
        If(inFrustum.greaterThan(0.5), () => {
          const visible = occlusion && hiz ? hiz.visibleNode(s.xyz, s.w) : float(1);
          atomicAdd(sink.element(0), uint(visible));
        });
      })().compute(this.count, [64]));
    }
    return out;
  }

  /**
   * Occlusion: "on", "off", or "auto" (the default when there is a pyramid).
   * `true` / `false` are accepted for on / off.
   *
   * AUTO. The test is not free — measured in the lab, a view that hides little
   * (RTS, overview) paid for the test and got nothing back. So in auto the
   * field checks, from its own counts, what share of the instances in the
   * frustum occlusion actually removed. Below `autoMinHidden` it stops testing
   * for `autoOffFrames`, then probes again (the camera may have come down).
   * While it is off it does not need the pyramid either — see needsPyramid.
   */
  setOcclusion(mode) {
    if (mode === true) mode = "on";
    if (mode === false) mode = "off";
    this.occlusionMode = this.hiz ? mode : "off";
    Object.assign(this._auto, { active: mode !== "off", nextCheck: this._auto.frame + 3, offUntil: 0 });
    this.u.uOcclusion.value = this._auto.active ? 1 : 0;
  }

  /** Whether the occlusion test runs this frame. */
  get occlusionActive() { return this.u.uOcclusion.value > 0.5; }

  /**
   * Does this field need a pyramid built after this frame? True while the
   * test runs, and on the frame before an auto probe — the probe must test
   * against LAST frame's depth, never an older one (a stale pyramid is
   * invalidated by the caller, which makes the test keep everything).
   */
  get needsPyramid() {
    const a = this._auto;
    if (this.occlusionMode === "on") return true;
    if (this.occlusionMode !== "auto") return false;
    return a.active || a.frame + 1 >= a.offUntil;
  }

  _decideOcclusion() {
    const a = this._auto;
    a.frame++;
    if (this.occlusionMode !== "auto") return;
    if (!a.active && a.frame >= a.offUntil) { a.active = true; a.nextCheck = a.frame + 3; }
    if (a.active && a.frame >= a.nextCheck && !a.pending) {
      a.pending = true;
      // The readback copies the args after this frame's cull, so the counts
      // are this frame's — taken with the test running.
      this.readCounts().then((c) => {
        a.pending = false;
        const tested = c.drawn + c.occluded;
        a.share = tested > 0 ? c.occluded / tested : 0;
        if (this.occlusionMode !== "auto") return;
        if (a.share < this.autoMinHidden) { a.active = false; a.offUntil = a.frame + this.autoOffFrames; }
        else a.nextCheck = a.frame + this.autoCheckFrames;
      }, () => { a.pending = false; });
    }
    this.u.uOcclusion.value = a.active ? 1 : 0;
  }

  /** Draw what occlusion removed, in red, through everything. */
  setShowOccluded(on) { for (const m of this.debugMeshes) m.visible = !!on; }

  /**
   * Stop updating the cull camera: the lists stay as they were, so the camera
   * can fly out and look at what was kept and what was not.
   */
  setFrozen(on) { this._frozen = !!on; }

  /** Per frame, before the scene renders. */
  update(camera) {
    if (this.hiz && this.hiz.version !== this._hizVersion) this._buildCompute();
    if (!this._frozen) {
      this._decideOcclusion();
      camera.updateMatrixWorld();
      this._camMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.u.uCam.value.copy(this._camMatrix);
      this.u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      const e = camera.projectionMatrix.elements;
      this.u.uFx.value = e[0];
      this.u.uFy.value = e[5];
      this.renderer.compute([this.computeReset, this.computeCull]);
    }
  }

  /** Instance counts per draw, read back from the GPU (async, for a HUD). */
  async readCounts() {
    const ab = await this.renderer.getArrayBufferAsync(this.indirect);
    const a = new Uint32Array(ab);
    let drawn = 0, occluded = 0, triangles = 0;
    const L = this.lods;
    for (let k = 0; k < this.draws; k++) {
      drawn += a[k * 5 + 1];
      const t = Math.floor(k / L);
      triangles += a[k * 5 + 1] * this.types[t].lods[k % L].index.count / 3;
    }
    for (let t = 0; t < this.types.length; t++) occluded += a[(this.draws + t) * 5 + 1];
    return { total: this.count, drawn, occluded, triangles };
  }
}
