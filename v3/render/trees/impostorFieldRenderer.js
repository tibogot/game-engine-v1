/**
 * GPU impostor field — V3 replacement for v2's ImpostorRenderer (same API).
 *
 * v2 repacked the far-band instance buffers on the CPU whenever the camera
 * moved >4 m or turned >3°: an O(allTrees) walk + attribute re-upload, which
 * put a hard ceiling (~10k trees) on smooth camera movement.
 *
 * Here the instance buffers are PERSISTENT: every tree of a slot is packed
 * exactly once per store edit (debounced during paint strokes), and the far
 * band is selected on the GPU instead — a vertex-stage gate collapses quads
 * outside [fadeStart, maxDistance] to zero area (no rasterization, no fill).
 * The octahedral material already crossfades by camera distance in-shader
 * (uFadeStart/uFadeEnd dither), so band membership needs no CPU at all.
 *
 * Camera-move CPU cost: zero, at any tree count. GPU cost: N degenerate or
 * ~2-tri quads — 100k trees ≈ 200k triangles worst case, trivial.
 */
import * as THREE from "three";
import {
  attribute, cameraPosition, length, step, uniform, vec2,
} from "three/tsl";
import { makeFlatAuxTextures, createImpostorMaterials } from "../../../v2/render/foliage/octahedralCore.js";

const INITIAL_CAP     = 4096;
const FADE_BAND       = 60;   // metres of impostor↔geometry crossfade (matches v2)
const REPACK_DEBOUNCE = 250;  // ms — coalesce per-stamp gen bumps while painting

export class ImpostorFieldRenderer {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.slots = [];
    this.maxDistance = 1500;
    this._lastGen = -1;
    this._repackAt = 0;      // debounce deadline (0 = nothing pending)
    this._mat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
  }

  /** Register (or replace) a slot's baked impostor and build its billboard mesh. */
  setSlot(slotIdx, impostorResult, trunkScale, opts) {
    this.clearSlot(slotIdx);
    const flats = makeFlatAuxTextures();
    const built = createImpostorMaterials(
      {
        colorTex: impostorResult.colorTex,
        normalTex: flats.normalTex,
        rmTex: flats.rmTex,
        depthTex: flats.depthTex,
      },
      {
        impostorScale: impostorResult.radius,
        gridVal: opts.grid,
        atlasSize: impostorResult.atlasSize,
        cellPad: impostorResult.cellPad,
        fullOctahedral: opts.fullOctahedral,
        instanced: true,
      },
    );
    built.uniforms.uUnlit.value = 0; // relight live by the scene sun
    built.mainMat.envMapIntensity = 0;

    // ── Vertex-stage band gate ────────────────────────────────────────────────
    // Instances outside [uFieldNear, uFieldFar] collapse to zero area: no
    // rasterization, no alpha-tested fill — the GPU replaces the CPU repack.
    const uFieldNear = uniform(0.0);
    const uFieldFar  = uniform(this.maxDistance);
    const impC = attribute("aImpCenter", "vec3");
    const dxz  = length(vec2(
      impC.x.sub(cameraPosition.x),
      impC.z.sub(cameraPosition.z),
    ));
    const gate = step(uFieldNear, dxz).mul(step(dxz, uFieldFar));
    built.mainMat.positionNode = built.mainMat.positionNode.mul(gate);

    while (this.slots.length <= slotIdx) this.slots.push(null);
    this.slots[slotIdx] = {
      mesh: null,
      geo: null,
      material: built.mainMat,
      uniforms: built.uniforms,
      uFieldNear,
      uFieldFar,
      cap: 0,
      bakeCenter: impostorResult.center.clone(),
      bakeRadius: impostorResult.radius,
      trunkScale: trunkScale || 1,
      aCenter: null,
      aScale: null,
    };
    this._ensureCapacity(this.slots[slotIdx], INITIAL_CAP);
    this._lastGen = -1; // force a repack with the new slot
  }

  _ensureCapacity(slot, needed) {
    if (slot.cap >= needed && slot.mesh) return;
    const cap = Math.max(INITIAL_CAP, Math.ceil(needed * 1.5));
    if (slot.mesh) {
      this.scene.remove(slot.mesh);
      slot.mesh.dispose();
      slot.geo.dispose();
    }
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute("aImpCenter", new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    geo.setAttribute("aImpScale", new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    const im = new THREE.InstancedMesh(geo, slot.material, cap);
    im.frustumCulled = false;
    im.count = 0;
    im.castShadow = false;
    im.receiveShadow = false;
    this.scene.add(im);
    slot.mesh = im;
    slot.geo = geo;
    slot.cap = cap;
    slot.aCenter = geo.getAttribute("aImpCenter");
    slot.aScale = geo.getAttribute("aImpScale");
  }

  hasSlot(slotIdx) {
    return slotIdx < this.slots.length && this.slots[slotIdx] != null;
  }

  clearSlot(slotIdx) {
    const s = this.slots[slotIdx];
    if (!s) return;
    if (s.mesh) {
      this.scene.remove(s.mesh);
      s.mesh.dispose();
      s.geo.dispose();
    }
    this.slots[slotIdx] = null;
  }

  /** Keep the impostor relight in sync with the scene sun. */
  setSunDir(x, y, z) {
    for (const s of this.slots) {
      if (s && s.uniforms.uSunDir) s.uniforms.uSunDir.value.set(x, y, z).normalize();
    }
  }

  update(treeStore, camera, lodCfg) {
    let any = false;
    for (const s of this.slots) if (s) { any = true; break; }
    if (!any) return;

    // Per-frame: only cheap uniform updates — band selection runs on the GPU.
    const fadeD = lodCfg.fadeOutDistance ?? 600;
    const fadeStartD = Math.max(0, fadeD - FADE_BAND);
    for (const s of this.slots) {
      if (!s) continue;
      s.uniforms.uFadeStart.value = fadeStartD;
      s.uniforms.uFadeEnd.value = fadeD;
      s.uFieldNear.value = fadeStartD;
      s.uFieldFar.value = this.maxDistance;
    }

    // Repack only when the tree set changed — debounced so a paint stroke
    // (one gen bump per stamp) coalesces into a single O(N) pack at the end.
    const gen = treeStore.globalGen;
    if (gen !== this._lastGen) {
      this._lastGen = gen;
      this._repackAt = performance.now() + REPACK_DEBOUNCE;
    }
    if (this._repackAt && performance.now() >= this._repackAt) {
      this._repackAt = 0;
      this._packAll(treeStore);
    }
  }

  /** Pack EVERY tree of every slot (edit-time only, never on camera moves). */
  _packAll(treeStore) {
    // Count per slot first so capacity grows once, not repeatedly mid-fill.
    const totals = new Array(this.slots.length).fill(0);
    for (const [, trees] of treeStore.chunks) {
      for (const t of trees) {
        if (t.slotIdx < totals.length && this.slots[t.slotIdx]) totals[t.slotIdx]++;
      }
    }
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s && totals[i] > 0) this._ensureCapacity(s, totals[i]);
    }

    const counts = new Array(this.slots.length).fill(0);
    for (const [, trees] of treeStore.chunks) {
      for (const t of trees) {
        const si = t.slotIdx;
        const slot = si < this.slots.length ? this.slots[si] : null;
        if (!slot) continue;
        const idx = counts[si];
        if (idx >= slot.cap) continue;

        const instScale = (t.scale ?? 1) / slot.trunkScale;
        const wx = t.x + slot.bakeCenter.x * instScale;
        const wy = (t.y ?? 0) + slot.bakeCenter.y * instScale;
        const wz = t.z + slot.bakeCenter.z * instScale;
        const R = slot.bakeRadius * instScale;

        this._pos.set(wx, wy, wz);
        this._quat.set(0, 0, 0, 1);
        this._scl.setScalar(2 * R);
        this._mat.compose(this._pos, this._quat, this._scl);
        slot.mesh.setMatrixAt(idx, this._mat);
        slot.aCenter.setXYZ(idx, wx, wy, wz);
        slot.aScale.setX(idx, R);
        counts[si]++;
      }
    }

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (!slot) continue;
      slot.mesh.count = counts[i];
      if (counts[i] > 0) {
        slot.mesh.instanceMatrix.needsUpdate = true;
        slot.aCenter.needsUpdate = true;
        slot.aScale.needsUpdate = true;
      }
    }
  }

  dispose() {
    for (let i = 0; i < this.slots.length; i++) this.clearSlot(i);
  }
}
