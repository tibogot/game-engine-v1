// ============================================================================
// TRACK BANNER FLAGS — the tall vertical banners that line a racing straight.
//
// ONE DRAW CALL for every cloth on the track, and ZERO CPU to animate them.
//
// WHY NOT THE ENGINE'S FLAG. v3 already has a real Verlet cloth
// (v2/core/props/flagFactory.js, which the RTS base flag uses) and it looks
// great standing still. But it is a per-flag particle sim with a per-flag
// DYNAMIC geometry upload every frame — it cannot instance, because every cloth
// has unique vertex positions. Six of those is six sims and six uploads.
//
// A racing banner is passed at 170 km/h. The fold detail a cloth sim buys you is
// invisible at that speed, so the wave is done in the VERTEX SHADER instead:
// no CPU, no per-frame upload, and every flag on the track in a single draw.
// Keep the Verlet flag for a hero flag you park next to.
//
// INSTANCING SHAPE — copied from v3/props/collectibleField.js because the
// obvious approach does not work:
//   • A custom `positionNode` (which the wave needs) CANNOT be combined with
//     THREE.InstancedMesh. So this is a plain Mesh over an
//     InstancedBufferGeometry, reading per-instance data through attribute().
//   • Instance data is ONE INTERLEAVED buffer, not three. WebGPU allows 8 vertex
//     buffers per pipeline and separate buffers burn a slot each.
//   • frustumCulled = false: the mesh sits at the origin while its instances are
//     spread over the whole track, so three's bounding sphere would cull it all
//     away the moment you drive off.
//
// PLACEMENT is the props system's job, not this file's. A "flag" prop carries
// the POLE (cheap, visible, pickable, and it gives the gizmo something to grab);
// this mirrors those props into the instanced cloth. That way flags inherit
// placement, the surface snap, save/load and undo for free.
// ============================================================================
import * as THREE from "three";
import { attribute, uniform, positionLocal, uv, vec3, vec4, sin, float } from "three/tsl";

export const FLAG = {
  /** Cloth size (m). Tall and narrow — a circuit banner, not a pennant. */
  width: 1.15,
  height: 4.2,
  /** Height of the cloth's TOP above the prop origin. The pole is 6 m. */
  top: 5.75,
  /** Mesh resolution. Across needs almost nothing (the wave is along the drop);
   *  down is what makes the ripple smooth. */
  segX: 3,
  segY: 16,
  /** Wave shape. amplitude is metres at the free edge. */
  amplitude: 0.42,
  frequency: 1.5,
  speed: 2.1,
  /** How much the cloth also swings sideways — pure wind lean. */
  sway: 0.18,
  color: "#e0342a",
  /** Tint multiplies the map, so an image on a coloured flag comes out stained.
   *  Applying a texture forces this to white; clearing restores the colour.
   *  Same rule the RTS base flag uses. */
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
   */
  constructor(scene, props) {
    this.props = props;
    this.count = 0;
    this._lastPropCount = -1;

    // ── Cloth geometry: a plane pinned along its LEFT edge (x = 0 = the mast) ──
    // Authored with x running 0..width and y running -height..0, so the origin
    // is the TOP of the cloth where it meets the pole. That makes the instance
    // position the pole top, which is the natural thing to place.
    const plane = new THREE.PlaneGeometry(FLAG.width, FLAG.height, FLAG.segX, FLAG.segY);
    plane.translate(FLAG.width / 2, -FLAG.height / 2, 0);

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
    this.uAmp = uniform(FLAG.amplitude);
    this.uFreq = uniform(FLAG.frequency);
    this.uSpeed = uniform(FLAG.speed);
    this.uSway = uniform(FLAG.sway);

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
    this._tex = null;
    this._objectUrl = null;
  }

  /** Rebuild the instance buffer from the current "flag" props. */
  sync() {
    const list = (this.props.instances ?? []).filter((i) => i.id === "flag");
    this._lastPropCount = this.props.instances?.length ?? 0;
    const n = Math.min(list.length, CAPACITY);
    const d = this.data;
    _col.set(this._tex ? "#ffffff" : FLAG.color);
    for (let i = 0; i < n; i++) {
      const root = list[i].root;
      const o = i * STRIDE;
      d[o] = root.position.x;
      d[o + 1] = root.position.y + FLAG.top;
      d[o + 2] = root.position.z;
      // Yaw only: a banner pole stands upright even on a banked road.
      d[o + 3] = _yawOf(root.quaternion);
      d[o + 4] = _col.r; d[o + 5] = _col.g; d[o + 6] = _col.b;
      // Per-instance phase, derived from position so it is STABLE across
      // reloads — a random phase would make every flag jump on a track load.
      d[o + 7] = (root.position.x * 0.7 + root.position.z * 1.3) % 6.283;
    }
    this.count = n;
    this.geometry.instanceCount = n;
    this.ib.needsUpdate = true;
    this.mesh.visible = n > 0;
  }

  /** @param {number} dt seconds */
  update(dt) {
    if (!this.count) return;
    // Self-heal like the prop physics: PropManager owns its own Delete key, so
    // there is no single hook that fires on every set change.
    const n = this.props.instances?.length ?? 0;
    if (n !== this._lastPropCount) this.sync();
    this.uTime.value += dt;
  }

  /** Re-read FLAG params (colour, wave) into the live uniforms + buffer. */
  applyParams() {
    this.uAmp.value = FLAG.amplitude;
    this.uFreq.value = FLAG.frequency;
    this.uSpeed.value = FLAG.speed;
    this.uSway.value = FLAG.sway;
    this.sync(); // colour lives in the instance buffer
  }

  /**
   * Point every flag at an image. ONE texture for ALL of them — that is the
   * price of a single draw call; per-flag images would need one draw each or a
   * texture atlas.
   *
   * Tint drops to white while a texture is set: the material multiplies colour ×
   * map, so a red flag would stain the picture red (the RTS base flag hit this
   * exact problem).
   */
  setTextureUrl(url) {
    if (!url) return this.clearTexture();
    new THREE.TextureLoader().load(
      url,
      (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        this._tex?.dispose();
        this._tex = tex;
        this.material.map = tex;
        this.material.needsUpdate = true;
        this.sync(); // repaint tints white
      },
      undefined,
      (e) => console.warn("[ModularRoad-v3] flag texture failed:", url, e),
    );
    return true;
  }

  /** Dev panel: swap the banner image from a picked File. */
  setTextureFile(file) {
    if (!file) return;
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = URL.createObjectURL(file);
    this.setTextureUrl(this._objectUrl);
  }

  /** Back to a flat colour. */
  clearTexture() {
    this._tex?.dispose();
    this._tex = null;
    this.material.map = null;
    this.material.needsUpdate = true;
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    this.sync();
  }

  get hasTexture() { return !!this._tex; }
}

const _e = new THREE.Euler();
/** Yaw only — a flagpole stays upright whatever the prop was rotated to. */
function _yawOf(q) {
  _e.setFromQuaternion(q, "YXZ");
  return _e.y;
}
