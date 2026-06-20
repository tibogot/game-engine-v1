/**
 * Impostor LOD3 renderer — the far tier of the tree LOD pyramid.
 *
 * Each slot gets ONE instanced billboard mesh (PlaneGeometry + the instanced
 * octahedral impostor material). Every frame, trees beyond fadeOutDistance (where
 * the trunk + leaf tiers have already hidden) are packed into that one mesh as
 * camera-facing billboards — so thousands of distant trees of a type cost a
 * single draw call of ~2 tris each. Per-instance aImpCenter/aImpScale drive the
 * octahedral view-direction math + per-tree wind in the shader.
 *
 * Placement: the bake was done at the slot's trunkScale, so a painted tree at
 * t.scale maps to the baked tree x (t.scale / trunkScale) — that ratio scales the
 * bake's bounding sphere (center + radius) into the world per instance.
 */
import * as THREE from "three";
import { makeFlatAuxTextures, createImpostorMaterials } from "./octahedralCore.js";

const INITIAL_CAP = 16384;
const CULL_MARGIN = 24;
const FADE_BAND = 60; // metres of impostor↔geometry crossfade before fadeOutDistance

export class ImpostorRenderer {
  constructor(scene, config) {
    this.scene = scene;
    this.config = config;
    this.slots = [];
    this.maxDistance = 1500; // beyond this even billboards are culled
    this._frustum = new THREE.Frustum();
    this._projScreen = new THREE.Matrix4();
    this._box = new THREE.Box3();
    this._mat = new THREE.Matrix4();
    this._pos = new THREE.Vector3();
    this._scl = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    // Coarse re-pack gate: the SET of far trees changes slowly (you must move/turn
    // a lot at distance to cross a fade boundary), and the billboard FACING is
    // per-frame on the GPU anyway. So only re-pack the instance buffers when the
    // camera moved > REPACK_DIST or turned > REPACK_ANGLE, or trees/slots changed.
    this._dirty = true;
    this._lastGen = -1;
    this._lastPackX = Infinity;
    this._lastPackZ = Infinity;
    this._lastFwd = new THREE.Vector3(0, 0, 1);
    this._fwd = new THREE.Vector3();
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

    const cap = INITIAL_CAP;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute("aImpCenter", new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3));
    geo.setAttribute("aImpScale", new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
    const im = new THREE.InstancedMesh(geo, built.mainMat, cap);
    im.frustumCulled = false;
    im.count = 0;
    im.castShadow = false;
    im.receiveShadow = false;
    this.scene.add(im);

    this._dirty = true; // force a re-pack now that a slot's impostor exists/changed
    while (this.slots.length <= slotIdx) this.slots.push(null);
    this.slots[slotIdx] = {
      mesh: im,
      geo,
      material: built.mainMat,
      uniforms: built.uniforms,
      cap,
      bakeCenter: impostorResult.center.clone(),
      bakeRadius: impostorResult.radius,
      trunkScale: trunkScale || 1,
      aCenter: geo.getAttribute("aImpCenter"),
      aScale: geo.getAttribute("aImpScale"),
    };
  }

  hasSlot(slotIdx) {
    return slotIdx < this.slots.length && this.slots[slotIdx] != null;
  }

  clearSlot(slotIdx) {
    const s = this.slots[slotIdx];
    if (!s) return;
    this.scene.remove(s.mesh);
    s.mesh.dispose();
    s.geo.dispose();
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

    // Coarse re-pack gate — skip the rebuild when the view barely changed.
    const gen = treeStore.globalGen;
    camera.getWorldDirection(this._fwd);
    const moved2 =
      (camera.position.x - this._lastPackX) ** 2 +
      (camera.position.z - this._lastPackZ) ** 2;
    const fwdDot = this._fwd.dot(this._lastFwd);
    if (!this._dirty && gen === this._lastGen && moved2 < 16 && fwdDot > 0.9986) {
      return; // reuse last frame's instance buffers (billboards still face via GPU)
    }
    this._dirty = false;
    this._lastGen = gen;
    this._lastPackX = camera.position.x;
    this._lastPackZ = camera.position.z;
    this._lastFwd.copy(this._fwd);

    this._projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._projScreen);

    const camX = camera.position.x;
    const camZ = camera.position.z;
    const fadeD = lodCfg.fadeOutDistance ?? 600;
    // Start impostors a band BEFORE the geometry hides, so they dither in over it.
    const fadeStartD = Math.max(0, fadeD - FADE_BAND);
    const fadeStartD2 = fadeStartD * fadeStartD;
    const maxD2 = this.maxDistance * this.maxDistance;
    const chunkSize = this.config.world.chunkSize;
    const half = this.config.world.size * 0.5;

    const counts = new Array(this.slots.length).fill(0);

    for (const [key, trees] of treeStore.chunks) {
      if (trees.length === 0) continue;
      const sep = key.indexOf(",");
      const cx = +key.substring(0, sep);
      const cz = +key.substring(sep + 1);
      const minX = -half + cx * chunkSize;
      const minZ = -half + cz * chunkSize;
      this._box.min.set(minX - CULL_MARGIN, -100, minZ - CULL_MARGIN);
      this._box.max.set(minX + chunkSize + CULL_MARGIN, 600, minZ + chunkSize + CULL_MARGIN);
      if (!this._frustum.intersectsBox(this._box)) continue;

      for (const t of trees) {
        const si = t.slotIdx;
        const slot = si < this.slots.length ? this.slots[si] : null;
        if (!slot) continue;
        const dx = t.x - camX;
        const dz = t.z - camZ;
        const dist2 = dx * dx + dz * dz;
        if (dist2 <= fadeStartD2 || dist2 > maxD2) continue; // far band (incl. crossfade)

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
      // Feed the crossfade band to the shader (impostor dithers in fadeStart->fadeEnd).
      slot.uniforms.uFadeStart.value = fadeStartD;
      slot.uniforms.uFadeEnd.value = fadeD;
      slot.mesh.count = counts[i];
      slot.mesh.instanceMatrix.needsUpdate = true;
      slot.aCenter.needsUpdate = true;
      slot.aScale.needsUpdate = true;
    }
  }
}
