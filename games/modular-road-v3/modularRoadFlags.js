// ============================================================================
// TRACK FLAGS — banner + country flag cloth.
//
// LIVE CLOTH is the engine Verlet sim (v2/core/props/flagFactory.js), the same
// one the RTS base flag uses. A shader-displaced plane can be denser and still
// look cheap: the wave moves verts but lighting keeps (or reconstructs) normals
// that read as faceted cardboard. Verlet rebuilds smooth vertex normals each
// frame, which is what Blender's smooth shading is.
//
// Each placed flag is its own sim. That is the cost of looking like cloth.
// The instanced shader path is still in this file (positionNode + interleaved
// instances) but both shipped styles set `verlet: true`.
//
// PLACEMENT is the props system's job. A flag prop carries the POLE plus a
// static preview cloth for palette thumbnails (`noRender`). This file attaches
// the live sim to those props.
// ============================================================================
import * as THREE from "three";
import { attribute, uniform, positionLocal, uv, vec3, vec4, sin, float, materialColor, dFdx, dFdy, cross, normalize, positionView } from "three/tsl";
import { createFlag } from "../../v3/props/liveProps.js";

export const FLAG = {
  /** Cloth size (m). Tall and narrow — a circuit banner, not a pennant. */
  width: 1.15,
  height: 4.2,
  poleHeight: 6,
  /** Height of the cloth's TOP above the prop origin. */
  top: 5.75,
  /** Same Verlet cloth as the RTS flag. A shader wave on a dense plane still
   *  shades like cardboard: displacement does not write smooth vertex normals
   *  the way Blender / computeVertexNormals does. */
  segX: 10,
  segY: 16,
  verlet: true,
  /** Wave shape. Unused while `verlet` is on (wind lives on the sim). */
  amplitude: 0.42,
  frequency: 1.5,
  speed: 2.1,
  sway: 0.18,
  color: "#e0342a",
  textureUrl: "",
};

/**
 * Country flag — tall mast (not the 6 m banner pole) and a 3:2 sheet. The old
 * 3.2×1.9 on a 6 m pole was both too short and too wide for the stick.
 */
export const COUNTRY_FLAG = {
  width: 4.8,
  height: 3.2,
  poleHeight: 18,
  top: 17.7,
  segX: 12,
  segY: 9,
  verlet: true,
  amplitude: 0.32,
  frequency: 2.0,
  speed: 2.1,
  sway: 0.16,
  color: "#c8322d",
  textureUrl: "",
};

/** Interleaved per-instance layout. Offsets in floats; vec4s stay 16-byte aligned. */
const STRIDE = 8;
const ATTRS = [
  { name: "aFlag", size: 4, offset: 0 }, // x, y, z, yaw
  { name: "aTint", size: 4, offset: 4 }, // r, g, b, phase
];
const CAPACITY = 256;

const _col = new THREE.Color();

export class ModularRoadFlags {
  /**
   * @param {THREE.Scene} scene
   * @param {import("./modularRoadProps.js").PropManager} props
   * @param {{propId?:string, style?:typeof FLAG}} [opts]
   */
  constructor(scene, props, opts = {}) {
    this.props = props;
    this.propId = opts.propId ?? "flag";
    this.style = opts.style ?? FLAG;
    this.count = 0;
    this._lastPropCount = -1;
    const S = this.style;

    // ── Cloth geometry: a plane pinned along its LEFT edge (x = 0 = the mast) ──
    // Authored with x running 0..width and y running -height..0, so the origin
    // is the TOP of the cloth where it meets the pole. That makes the instance
    // position the pole top, which is the natural thing to place.
    const plane = new THREE.PlaneGeometry(S.width, S.height, S.segX, S.segY);
    plane.translate(S.width / 2, -S.height / 2, 0);

    const data = new Float32Array(CAPACITY * STRIDE);
    const ib = new THREE.InstancedInterleavedBuffer(data, STRIDE, 1);
    ib.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.InstancedBufferGeometry();
    geo.index = plane.index;
    for (const k of Object.keys(plane.attributes)) geo.setAttribute(k, plane.attributes[k]);
    for (const { name, size, offset } of ATTRS) {
      geo.setAttribute(name, new THREE.InterleavedBufferAttribute(ib, size, offset));
    }
    geo.instanceCount = 0;

    this.uTime = uniform(0);
    this.uAmp = uniform(S.amplitude);
    this.uFreq = uniform(S.frequency);
    this.uSpeed = uniform(S.speed);
    this.uSway = uniform(S.sway);

    const mat = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide, // you see the back of a flag constantly
      roughness: 0.82,
      metalness: 0,
    });

    const aFlag = attribute("aFlag", "vec4");
    const aTint = attribute("aTint", "vec4");

    mat.positionNode = (() => {
      const p = positionLocal;
      // 0 at the mast, 1 at the free edge. SQUARED so the cloth stays pinned at
      // the pole and the motion builds toward the loose edge, instead of the
      // whole banner sliding sideways.
      const free = uv().x;
      const grip = free.mul(free);
      const t = this.uTime.mul(this.uSpeed).add(aTint.w);

      // Travelling wave DOWN the drop, plus a faster counter-wave so the ripple
      // never looks like a single clean sine.
      const w1 = sin(p.y.mul(this.uFreq).add(t));
      const w2 = sin(p.y.mul(this.uFreq.mul(2.3)).sub(t.mul(1.37))).mul(0.35);
      const flap = w1.add(w2).mul(this.uAmp).mul(grip);

      // Sideways lean, so it reads as wind rather than a flapping sheet.
      const lean = sin(t.mul(0.6)).mul(this.uSway).mul(grip);

      // Cloth is authored in the XY plane; the flap pushes it along local Z.
      const local = vec3(p.x.add(lean), p.y, flap);

      // Per-instance yaw about Y, then translate to the instance position.
      const c = sin(aFlag.w.add(float(Math.PI / 2)));
      const s = sin(aFlag.w);
      return vec3(
        local.x.mul(c).add(local.z.mul(s)).add(aFlag.x),
        local.y.add(aFlag.y),
        local.z.mul(c).sub(local.x.mul(s)).add(aFlag.z),
      );
    })();

    mat.colorNode = vec4(aTint.xyz, 1);
    // positionNode moves verts; stock normals stay those of the rest pose, so
    // the sheet shades as a flat card. Reconstruct from screen-space derivatives
    // of the displaced view position — same trick displaced terrain uses.
    mat.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)));

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;   // instances are all over the track; the mesh is at the origin
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;      // a waving cloth's shadow costs 3 cascade draws for noise
    mesh.receiveShadow = false;
    mesh.name = "TrackFlagCloth";
    scene.add(mesh);

    this.mesh = mesh;
    this.material = mat;
    this.geometry = geo;
    this.data = data;
    this.ib = ib;
    this._plane = plane;
    /** @type {Map<object, {mesh:THREE.Mesh, material:THREE.Material, tex:THREE.Texture|null, url:string}>} */
    this._uniques = new Map();
  }

  /** Rebuild the instance buffer from the current props of this style. */
  sync() {
    const list = (this.props.instances ?? []).filter((i) => i.id === this.propId);
    this._lastPropCount = this.props.instances?.length ?? 0;
    const shared = [];
    const keep = new Set();
    for (const inst of list) {
      if (this.style.verlet || inst.flagImage) {
        keep.add(inst);
        if (this.style.verlet) this._ensureVerlet(inst);
        else this._ensureUnique(inst);
      } else {
        shared.push(inst);
        this._dropUnique(inst);
      }
    }
    for (const inst of [...this._uniques.keys()]) {
      if (!keep.has(inst)) this._dropUnique(inst);
    }

    const n = Math.min(shared.length, CAPACITY);
    const d = this.data;
    for (let i = 0; i < n; i++) {
      const inst = shared[i];
      const root = inst.root;
      const o = i * STRIDE;
      d[o] = root.position.x;
      d[o + 1] = root.position.y + this.style.top;
      d[o + 2] = root.position.z;
      d[o + 3] = _yawOf(root.quaternion);
      _col.set(inst.flagColor || this.style.color);
      d[o + 4] = _col.r; d[o + 5] = _col.g; d[o + 6] = _col.b;
      d[o + 7] = (root.position.x * 0.7 + root.position.z * 1.3) % 6.283;
    }
    this.count = n;
    this.geometry.instanceCount = n;
    this.ib.needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  /**
   * RTS cloth: Verlet particles, constraints, gravity, recomputed normals.
   * Parent to the pole so the gizmo carries it. Cannot instance — every cloth
   * has unique verts each frame, which is why banners stay on the shader path.
   */
  _ensureVerlet(inst) {
    let u = this._uniques.get(inst);
    if (!u?.sim) {
      this._dropUnique(inst);
      const S = this.style;
      const sim = createFlag({
        poleHeight: S.poleHeight ?? 6,
        poleRadius: (S.poleHeight ?? 6) * 0.013,
        clothWidth: S.width,
        clothHeight: S.height,
        xSegs: S.segX,
        ySegs: S.segY,
        flagColor: inst.flagImage ? "#ffffff" : (inst.flagColor || S.color),
        showPole: false,
        windIntensity: 300,
        windSpeed: 1000,
      });
      sim.group.traverse((o) => {
        if (!o.isMesh) return;
        if (o.visible === false) {
          o.userData.noRender = true;
          return;
        }
        o.userData.flagClothUnique = true;
        o.userData.noCollide = true;
        o.castShadow = false;
      });
      inst.root.add(sim.group);
      for (let i = 0; i < 20; i++) sim.update(1 / 60);
      u = { sim, url: "" };
      this._uniques.set(inst, u);
    }
    const url = inst.flagImage || "";
    const color = inst.flagImage ? "#ffffff" : (inst.flagColor || this.style.color);
    if (url !== u.url) {
      u.url = url;
      u.sim.setParam("textureUrl", url);
    }
    u.sim.setParam("flagColor", color);
  }

  /**
   * A flag with its own picture cannot share the instanced cloth (one map for
   * the draw). The waving sheet is parented to THAT pole so the gizmo moves it,
   * and `materialColor` multiplies the uploaded map the way a billboard does.
   * Tint is forced white while a map is on, or a red flag stains the photo.
   */
  _ensureUnique(inst) {
    let u = this._uniques.get(inst);
    if (!u) {
      const material = new THREE.MeshStandardNodeMaterial({
        side: THREE.DoubleSide,
        roughness: 0.82,
        metalness: 0,
        color: new THREE.Color("#ffffff"),
      });
      material.colorNode = materialColor;
      const p = positionLocal;
      const free = uv().x;
      const grip = free.mul(free);
      const t = this.uTime.mul(this.uSpeed);
      const w1 = sin(p.y.mul(this.uFreq).add(t));
      const w2 = sin(p.y.mul(this.uFreq.mul(2.3)).sub(t.mul(1.37))).mul(0.35);
      const flap = w1.add(w2).mul(this.uAmp).mul(grip);
      const lean = sin(t.mul(0.6)).mul(this.uSway).mul(grip);
      material.positionNode = vec3(p.x.add(lean), p.y, flap);
      material.normalNode = normalize(cross(dFdx(positionView), dFdy(positionView)));

      const mesh = new THREE.Mesh(this._plane, material);
      mesh.position.y = this.style.top;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.flagClothUnique = true;
      mesh.userData.noCollide = true;
      inst.root.add(mesh);
      u = { mesh, material, tex: null, url: "" };
      this._uniques.set(inst, u);
    }
    const url = inst.flagImage;
    if (url === u.url) return;
    u.url = url;
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        if (this._uniques.get(inst) !== u || u.url !== url) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        u.tex?.dispose();
        u.tex = tex;
        u.material.map = tex;
        u.material.color.set("#ffffff");
        u.material.needsUpdate = true;
      },
      undefined,
      (e) => console.warn("[ModularRoad-v3] flag texture failed:", url, e),
    );
  }

  _dropUnique(inst) {
    const u = this._uniques.get(inst);
    if (!u) return;
    if (u.sim) {
      u.sim.group.removeFromParent();
      u.sim.dispose();
    } else {
      u.mesh.removeFromParent();
      u.tex?.dispose();
      u.material.map = null;
      u.material.dispose();
    }
    this._uniques.delete(inst);
  }

  /** @param {number} dt seconds */
  update(dt) {
    const n = this.props.instances?.length ?? 0;
    if (n !== this._lastPropCount) this.sync();
    if (!this.count && this._uniques.size === 0) return;
    this.uTime.value += dt;
    for (const u of this._uniques.values()) u.sim?.update(dt);
  }

  /** Re-read style params (colour, wave) into the live uniforms + buffer. */
  applyParams() {
    const S = this.style;
    this.uAmp.value = S.amplitude;
    this.uFreq.value = S.frequency;
    this.uSpeed.value = S.speed;
    this.uSway.value = S.sway;
    this.sync();
  }
}

const _e = new THREE.Euler();
/** Yaw only — a flagpole stays upright whatever the prop was rotated to. */
function _yawOf(q) {
  _e.setFromQuaternion(q, "YXZ");
  return _e.y;
}
