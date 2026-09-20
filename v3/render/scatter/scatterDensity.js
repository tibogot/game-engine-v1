/**
 * A painted density layer for scattered plants — one RGBA8 texture, one plant
 * type per channel (so four types per layer).
 *
 * The scatter compute samples `maskedTex`, not the painted texture: the paint
 * with every "Blocks grass" ground layer and every terrain hole masked out —
 * the same rule, and the same soft edge, as grass and susuki
 * (grassTerrainData.initDensityMask). It is a GPU bake that only re-runs when
 * the paint, the ground paint or a layer's flag changes.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import { Fn, dot, float, int, smoothstep, texture, uniform, uv } from "three/tsl";

/**
 * Add (or with `erase`, remove) paint in a disc. Pure — exported for tests.
 * Paint goes to `channel` only; erase clears every channel, so Alt+paint
 * removes plants whatever their type — unless `onlyChannel`, which erases just
 * that type and leaves the others growing.
 * @returns {boolean} true if any texel changed
 */
export function stampScatterDensity(data, res, { cx, cz, radius, strength, falloff, worldSize, channel, erase, onlyChannel = false }) {
  const half = worldSize * 0.5;
  const rPx  = (radius / worldSize) * res;
  const cxPx = ((cx + half) / worldSize) * res;
  const czPx = ((cz + half) / worldSize) * res;
  const r2   = rPx * rPx;
  const x0 = Math.max(0, Math.floor(cxPx - rPx));
  const x1 = Math.min(res - 1, Math.ceil(cxPx + rPx));
  const z0 = Math.max(0, Math.floor(czPx - rPx));
  const z1 = Math.min(res - 1, Math.ceil(czPx + rPx));
  let changed = false;
  for (let z = z0; z <= z1; z++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cxPx, dz = z + 0.5 - czPx;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      const w = Math.pow(Math.max(0, 1 - Math.sqrt(d2) / rPx), falloff) * strength * 255;
      if (w <= 0) continue;
      const i = (z * res + x) * 4;
      if (erase && onlyChannel) {
        data[i + channel] = Math.max(0, data[i + channel] - w);
      } else if (erase) {
        for (let c = 0; c < 4; c++) data[i + c] = Math.max(0, data[i + c] - w);
      } else {
        data[i + channel] = Math.min(255, data[i + channel] + w);
      }
      changed = true;
    }
  }
  return changed;
}

export class ScatterDensity {
  /**
   * @param {object} [o]
   * @param {number} [o.res]       texels per side (1024 = 2 m per texel on a 2048 m world)
   * @param {number} [o.channels]  plant types, 4 per texture (8 = two textures)
   */
  constructor({ res = 1024, channels = 4 } = {}) {
    this.res = res;
    this.channels = channels;
    const pages = (this.pages = Math.max(1, Math.ceil(channels / 4)));

    this.texes = [];
    this.maskedTexes = [];
    this._maskRTs = [];
    for (let i = 0; i < pages; i++) {
      const tex = new THREE.DataTexture(new Uint8Array(res * res * 4), res, res, THREE.RGBAFormat);
      tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.texes.push(tex);

      const rt = new THREE.RenderTarget(res, res, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false,
        generateMipmaps: false,
        colorSpace: THREE.NoColorSpace,
      });
      rt.texture.flipY = false;
      this._maskRTs.push(rt);
      this.maskedTexes.push(rt.texture);
    }
    // One page is the common case (the flowers); these keep that simple.
    this.tex = this.texes[0];
    this.maskedTex = this.maskedTexes[0];
    this._mask = null;
    this._hasData = false;
  }

  /** Which plant types have any paint — used to skip drawing unused ones. */
  usedChannels() {
    const used = new Array(this.channels).fill(false);
    for (let p = 0; p < this.pages; p++) {
      const data = this.texes[p].image.data;
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 4; c++) {
          if (data[i + c] > 0) used[p * 4 + c] = true;
        }
      }
    }
    return used;
  }

  /** True once anything is painted; the render loop skips the system while false. */
  get hasData() { return this._hasData; }

  /**
   * How much of anything is painted at a world point, 0..1 — the STRONGEST
   * channel, not their sum, so "is there vegetation here" does not depend on
   * how many species happen to be painted on top of each other.
   *
   * Readable on the CPU because the paint has always LIVED on the CPU: these
   * are DataTextures whose `image.data` is the authority and the GPU copy is
   * the mirror. No readback, no async, no frame latency. That is what makes it
   * usable from a fixed-step simulation, which cannot wait for a GPU fence.
   *
   * Nearest-texel on purpose. At 1024 over a 2 km world a texel is about two
   * metres, which is finer than anything asking the question, and bilinear
   * would cost four fetches to smooth data that is already smooth.
   */
  sampleAt(x, z, worldSize) {
    if (!this._hasData) return 0;
    const res = this.res;
    const half = worldSize * 0.5;
    const px = Math.floor(((x + half) / worldSize) * res);
    const pz = Math.floor(((z + half) / worldSize) * res);
    if (px < 0 || pz < 0 || px >= res || pz >= res) return 0;
    const i = (pz * res + px) * 4;
    let best = 0;
    for (let p = 0; p < this.pages; p++) {
      const d = this.texes[p].image.data;
      for (let c = 0; c < 4; c++) if (d[i + c] > best) best = d[i + c];
    }
    return best / 255;
  }

  /**
   * @param {object} o
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {THREE.DataArrayTexture} o.splatTex  SplatMap.tex (slice 1 alpha = holes)
   */
  initMask({ renderer, splatTex }) {
    const uBlockA = uniform(new THREE.Vector4(0, 0, 0, 0));
    const uBlockB = uniform(new THREE.Vector4(0, 0, 0, 0));
    const quads = this.texes.map((tex) => {
      const m = new THREE.MeshBasicNodeMaterial();
      m.toneMapped = m.fog = false;
      m.depthTest = m.depthWrite = false;
      // fragmentNode, not colorNode: a colorNode's alpha is discarded, and the
      // fourth plant type of a page lives in alpha.
      m.fragmentNode = Fn(() => {
        const c = uv();
        const d = texture(tex, c);
        const s0 = texture(splatTex, c).depth(int(0));
        const s1 = texture(splatTex, c).depth(int(1));
        const blocked = dot(s0, uBlockA).add(dot(s1, uBlockB));
        const keep = float(1).sub(smoothstep(0.3, 0.6, blocked))
          .mul(float(1).sub(smoothstep(0.2, 0.35, s1.w)));
        return d.mul(keep);
      })();
      return new QuadMesh(m);
    });
    this._mask = { renderer, splatTex, uBlockA, uBlockB, quads, blockKey: "", seen: { d: -1, splat: -1, block: "" } };
    this.updateMask(null);
  }

  /** Re-bake the masked copy if the paint, the ground paint or a blocking flag changed. */
  updateMask(blocksGrass) {
    const b = this._mask;
    if (!b) return false;
    if (blocksGrass) {
      const key = blocksGrass.map((x) => (x ? 1 : 0)).join("");
      if (key !== b.blockKey) {
        b.blockKey = key;
        const f = (i) => (blocksGrass[i] ? 1 : 0);
        b.uBlockA.value.set(f(0), f(1), f(2), f(3));
        b.uBlockB.value.set(f(4), f(5), f(6), 0);
      }
    }
    const seen = b.seen;
    const version = this.texes.reduce((a, t) => a + t.version, 0);
    if (seen.d === version && seen.splat === b.splatTex.version && seen.block === b.blockKey) return false;
    seen.d = version; seen.splat = b.splatTex.version; seen.block = b.blockKey;
    const { renderer } = b;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    for (let i = 0; i < this.pages; i++) {
      renderer.setRenderTarget(this._maskRTs[i]);
      b.quads[i].render(renderer);
    }
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    return true;
  }

  /** The texture holding a plant type, and its channel inside it. */
  _pageOf(channel) {
    const page = Math.min(this.pages - 1, Math.floor(channel / 4));
    return { tex: this.texes[page], channel: channel - page * 4 };
  }

  stamp(opts) {
    // Erasing clears every type, so it has to touch every page.
    const pages = opts.erase && !opts.onlyChannel
      ? this.texes.map((tex, i) => ({ tex, channel: opts.channel - i * 4 }))
      : [this._pageOf(opts.channel)];
    for (const { tex, channel } of pages) {
      if (stampScatterDensity(tex.image.data, this.res, { ...opts, channel: Math.max(0, Math.min(3, channel)) })) {
        tex.needsUpdate = true;
        if (!opts.erase) this._hasData = true;
      }
    }
  }

  /**
   * Bytes a snapshot occupies — EVERY page, not one.
   *
   * Callers validating a saved blob before restoring it must compare against
   * this, not against `tex.image.data.length`: `tex` is page 0 alone, so with
   * more than four channels the two never match. That mismatch silently threw
   * away the ground-foliage paint of every project on load.
   */
  get snapshotLength() { return this.res * this.res * 4 * this.pages; }

  /** Every page, end to end — one blob for the project file and for undo. */
  getSnapshot() {
    const page = this.res * this.res * 4;
    const out = new Uint8Array(page * this.pages);
    this.texes.forEach((t, i) => out.set(t.image.data, i * page));
    return out;
  }
  restoreSnapshot(s) {
    const page = this.res * this.res * 4;
    this.texes.forEach((t, i) => {
      t.image.data.set(s.subarray(i * page, (i + 1) * page));
      t.needsUpdate = true;
    });
    this._hasData = s.some((v) => v > 0);
  }
  /** Fill one type everywhere. */
  fill(channel) {
    const { tex, channel: c } = this._pageOf(channel);
    const data = tex.image.data;
    for (let i = c; i < data.length; i += 4) data[i] = 255;
    tex.needsUpdate = true;
    this._hasData = true;
  }
  clear() {
    for (const t of this.texes) {
      t.image.data.fill(0);
      t.needsUpdate = true;
    }
    this._hasData = false;
  }
}
