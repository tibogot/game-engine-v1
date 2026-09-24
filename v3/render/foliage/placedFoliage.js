/**
 * PLACED FOLIAGE — plants a PLACE puts down by hand, at exact points, rather
 * than the painted fields' GPU scatter. A traveller's palm at a hamlet gate,
 * a pair flanking a temple causeway: plants whose whole point is that
 * somebody planted them THERE, which a density field cannot say.
 *
 * Same geometry (createFoliageTypeGeometry) and the SAME material
 * (createFoliageMaterial) as the scatter fields, so a placed plant is shaded
 * exactly like a painted one — only the source of its position differs. The
 * field reads a plant from its compute buffers; here each plant is one
 * instance of an InstancedBufferGeometry carrying two vec4s:
 *   iPos  (x, z, type, groundY)   the field's `p`, verbatim
 *   iRot  (yaw, scale, seed, sway)  heading, size and sway, which the field
 *                                  hashes or takes from the wind
 *
 * One mesh per (type, detail level). Detail is chosen on the CPU from camera
 * distance, a few times a second: a map holds tens of these, not tens of
 * thousands, so the instance lists are rebuilt outright when a plant crosses
 * a band. Six vertex buffers per draw (4 geometry + 2 instance), inside
 * WebGPU's eight.
 *
 * No wind field: a placed plant gets a slow two-frequency sway on its own
 * phase, which is all a 12 m tree shows from an RTS camera. Leaves still
 * flutter, from the material.
 */
import * as THREE from "three";
import { attribute, cos, float, int, floor, sin, time, uniform, uniformArray, vec4 } from "three/tsl";
import { createFoliageTypeGeometry, FOLIAGE_LODS, cardTextureOf } from "./foliageGeometry.js";
import { createFoliageMaterial, makeCardTexture } from "./foliageSystem.js";

const ROWS = 4;
/** Types one PlacedFoliage can hold (the uniform array is fixed-size). */
const MAX_TYPES = 8;

export class PlacedFoliage {
  /**
   * @param {object} o
   *   scene
   *   lodDistances  [near→mid, mid→far] in metres from the camera
   *   shadowLods    how many detail levels cast (the far one never does)
   */
  constructor({ scene, lodDistances = [45, 110], shadowLods = 2 } = {}) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = "PlacedFoliage";
    scene.add(this.group);
    this.lodDistances = lodDistances;
    this.shadowLods = shadowLods;

    /** key → { index, type, localH, meshes: [lod] | null } */
    this.types = new Map();
    /** { typeIndex, x, y, z, yaw, scale, seed, lod } */
    this.plants = [];

    this._rows = Array.from({ length: MAX_TYPES * ROWS }, () => new THREE.Vector4());
    this.u = {
      uFlutter: uniform(0.7),
      uGlowLight: uniform(0.05),
      uTransMul: uniform(1),
      uSunDir: uniform(new THREE.Vector3(0.5, 0.8, 0.3).normalize()),
    };
    const uTypes = uniformArray(this._rows, "vec4");
    this._src = {
      plantAt: () => {
        const p = attribute("iPos", "vec4");
        const r = attribute("iRot", "vec4");
        const seed = r.z;
        // Sway: two slow frequencies on the plant's own phase, a few degrees.
        const d = vec4(
          sin(time.mul(0.61).add(seed.mul(7.3))).mul(r.w.mul(0.035)),
          cos(time.mul(0.47).add(seed.mul(3.1))).mul(r.w.mul(0.03)),
          1, 0,
        );
        // No resting lean: a planted tree stands straight (the field adds a
        // random one, which on a 36 m banyan would tilt the whole crown).
        return { plant: seed, p, d, yaw: r.x, scale: r.y, leanJitter: 0 };
      },
      rowOf: (t, rr) => uTypes.element(int(floor(t.add(0.5))).mul(ROWS).add(rr)),
      // Size is the placement's own; no hashed variation on top of it.
      sizeVar: uniform(0),
      colorVar: uniform(0.08),
      anchorPos: uniform(new THREE.Vector3()),
      thinScale: () => float(1),
      // The main camera, for billboard cards in every pass (see update).
      viewPos: uniform(new THREE.Vector3()),
    };
    this._plainMat = null;
    this._cardMats = {};
    this._camPos = new THREE.Vector3(Infinity, 0, 0);
    this._dirty = true;
  }

  _materialFor(kind) {
    const key = cardTextureOf(kind);
    if (!key) return (this._plainMat ??= createFoliageMaterial({ src: this._src, u: this.u }));
    if (!this._cardMats[key]) {
      this._cardMats[key] = createFoliageMaterial({ src: this._src, u: this.u, headTex: makeCardTexture(key, 8) });
    }
    return this._cardMats[key];
  }

  /**
   * Register a plant type under `key` (a foliage type object — a
   * FOLIAGE_PRESETS entry or a map's own copy). Re-registering replaces it.
   */
  setType(key, type) {
    let t = this.types.get(key);
    if (!t) {
      if (this.types.size >= MAX_TYPES) throw new Error(`PlacedFoliage: at most ${MAX_TYPES} types`);
      t = { index: this.types.size, type, localH: 1, meshes: null, sway: 1, lodMul: 1 };
      this.types.set(key, t);
    }
    t.type = type;
    const size = type.size ?? 1;
    // A big tree sways less and keeps its detail further out: the sway is an
    // angle, so a 36 m banyan at a palm's sway would swing its crown metres,
    // and its detail bands follow its size the way the painted fields' do.
    t.sway = Math.min(1, 10 / size);
    t.lodMul = Math.max(1, size / 12);
    this._disposeMeshes(t);
    this._writeRows(t);
    this._dirty = true;
  }

  /**
   * Put one plant down. `y` is the ground height there; `scale` multiplies
   * the type's `size`.
   */
  add(key, x, y, z, { rotY = 0, scale = 1, seed = this.plants.length * 0.618 + 0.37 } = {}) {
    const t = this.types.get(key);
    if (!t) throw new Error(`PlacedFoliage: no type "${key}" — setType first`);
    this.plants.push({ typeIndex: t.index, x, y, z, yaw: rotY, scale, seed: seed % 1, lod: -1 });
    this._dirty = true;
  }

  get count() { return this.plants.length; }

  /** Toward the sun, for the see-through light. */
  setSunDir(v) { if (v) this.u.uSunDir.value.copy(v).normalize(); }

  _writeRows(t) {
    const c = new THREE.Color();
    const o = t.index * ROWS, ty = t.type;
    c.set(ty.colorBase); this._rows[o].set(c.r, c.g, c.b, ty.translucency ?? 1);
    c.set(ty.colorTip); this._rows[o + 1].set(c.r, c.g, c.b, ty.size ?? 1);
    this._rows[o + 2].set(-1e5, 1e5, -1, 0);
    c.set(ty.colorHead ?? ty.colorTip); this._rows[o + 3].set(c.r, c.g, c.b, t.localH);
  }

  _buildMeshes(t, capacity) {
    const mat = this._materialFor(t.type.kind);
    t.meshes = [];
    for (let lod = 0; lod < FOLIAGE_LODS; lod++) {
      const { geometry } = createFoliageTypeGeometry(t.type, { lod });
      if (lod === 0) {
        geometry.computeBoundingBox();
        t.localH = Math.max(0.05, geometry.boundingBox.max.y);
        this._writeRows(t);
      }
      const geo = new THREE.InstancedBufferGeometry();
      geo.index = geometry.index;
      for (const name of Object.keys(geometry.attributes)) geo.setAttribute(name, geometry.attributes[name]);
      const iPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      const iRot = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      iPos.setUsage(THREE.DynamicDrawUsage);
      iRot.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("iPos", iPos);
      geo.setAttribute("iRot", iRot);
      geo.instanceCount = 0;
      // Placed by the vertex shader: the plant-local bounds would cull wrongly.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `PlacedFoliage:${t.type.kind}:lod${lod}`;
      mesh.frustumCulled = false;
      mesh.castShadow = lod < this.shadowLods;
      mesh.receiveShadow = true;
      mesh.visible = false;
      this.group.add(mesh);
      t.meshes.push(mesh);
    }
  }

  _disposeMeshes(t) {
    if (!t.meshes) return;
    for (const m of t.meshes) { this.group.remove(m); m.geometry.dispose(); }
    t.meshes = null;
  }

  /** Pick each plant's detail level for this camera; rebuild the lists if any changed. */
  update(camera) {
    if (!this.plants.length) return;
    const cp = camera.position;
    // Every frame, before the early-out: billboard cards face this camera in
    // the shadow pass too (foliageSystem `viewPos`).
    this._src.viewPos.value.copy(cp);
    // Re-bin only once the camera has moved a couple of metres.
    if (!this._dirty && this._camPos.distanceToSquared(cp) < 4) return;
    this._camPos.copy(cp);
    const [d1, d2] = this.lodDistances;
    const byIndex = [];
    for (const t of this.types.values()) byIndex[t.index] = t;
    let changed = this._dirty;
    for (const p of this.plants) {
      const dist = Math.hypot(p.x - cp.x, p.y - cp.y, p.z - cp.z);
      const m = byIndex[p.typeIndex].lodMul;
      const lod = dist < d1 * m ? 0 : dist < d2 * m ? 1 : 2;
      if (lod !== p.lod) { p.lod = lod; changed = true; }
    }
    if (!changed) return;
    this._dirty = false;

    const byType = new Map();
    for (const p of this.plants) {
      if (!byType.has(p.typeIndex)) byType.set(p.typeIndex, []);
      byType.get(p.typeIndex).push(p);
    }
    for (const t of this.types.values()) {
      const list = byType.get(t.index) ?? [];
      if (!list.length) { if (t.meshes) for (const m of t.meshes) m.visible = false; continue; }
      if (!t.meshes || t.meshes[0].geometry.getAttribute("iPos").count < list.length) {
        this._disposeMeshes(t);
        this._buildMeshes(t, Math.max(8, list.length));
      }
      for (let lod = 0; lod < FOLIAGE_LODS; lod++) {
        const mesh = t.meshes[lod];
        const pos = mesh.geometry.getAttribute("iPos"), rot = mesh.geometry.getAttribute("iRot");
        let n = 0;
        for (const p of list) {
          if (p.lod !== lod) continue;
          pos.array.set([p.x, p.z, t.index, p.y], n * 4);
          rot.array.set([p.yaw, p.scale, p.seed, t.sway], n * 4);
          n++;
        }
        pos.needsUpdate = rot.needsUpdate = true;
        mesh.geometry.instanceCount = n;
        mesh.visible = n > 0;
      }
    }
  }

  dispose() {
    for (const t of this.types.values()) this._disposeMeshes(t);
    this.scene.remove(this.group);
    this._plainMat?.dispose();
    for (const m of Object.values(this._cardMats)) m.dispose();
  }
}
