/**
 * Painted flower density — one RGBA8 texture, one flower type per channel.
 *
 * 1024² (2 m per texel on the default 2048 m world), where grass and susuki use
 * 512²: flowers are small and read as patches, so the paint needs to hold a
 * path's edge or a ring round a tree.
 *
 * The flower compute samples `maskedTex`, not the painted texture: the paint
 * with every "Blocks grass" ground layer and every terrain hole masked out —
 * the same rule, and the same soft edge, as grass and susuki
 * (grassTerrainData.initDensityMask). It is a GPU bake that only re-runs when
 * the paint, the ground paint or a layer's flag changes.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import { Fn, dot, float, int, smoothstep, texture, uniform, uv } from "three/tsl";

export const FLOWER_DENSITY_RES = 1024;

/**
 * Add (or with `erase`, remove) paint in a disc. Pure — exported for tests.
 * Paint goes to `channel` only; erase clears every channel, so Alt+paint
 * removes flowers whatever their type.
 * @returns {boolean} true if any texel changed
 */
export function stampFlowerDensity(data, res, { cx, cz, radius, strength, falloff, worldSize, channel, erase }) {
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
      if (erase) {
        for (let c = 0; c < 4; c++) data[i + c] = Math.max(0, data[i + c] - w);
      } else {
        data[i + channel] = Math.min(255, data[i + channel] + w);
      }
      changed = true;
    }
  }
  return changed;
}

export class FlowerDensity {
  constructor() {
    const res = FLOWER_DENSITY_RES;
    this.tex = new THREE.DataTexture(new Uint8Array(res * res * 4), res, res, THREE.RGBAFormat);
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;

    this._maskRT = new THREE.RenderTarget(res, res, {
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
    this._maskRT.texture.flipY = false;
    this.maskedTex = this._maskRT.texture;
    this._mask = null;
    this._hasData = false;
  }

  /** True once anything is painted; the render loop skips the system while false. */
  get hasData() { return this._hasData; }

  /**
   * @param {object} o
   * @param {THREE.WebGPURenderer} o.renderer
   * @param {THREE.DataArrayTexture} o.splatTex  SplatMap.tex (slice 1 alpha = holes)
   */
  initMask({ renderer, splatTex }) {
    const uBlockA = uniform(new THREE.Vector4(0, 0, 0, 0));
    const uBlockB = uniform(new THREE.Vector4(0, 0, 0, 0));
    const m = new THREE.MeshBasicNodeMaterial();
    m.toneMapped = m.fog = false;
    m.depthTest = m.depthWrite = false;
    // fragmentNode, not colorNode: a colorNode's alpha is discarded, and the
    // fourth flower type lives in alpha.
    m.fragmentNode = Fn(() => {
      const c = uv();
      const d = texture(this.tex, c);
      const s0 = texture(splatTex, c).depth(int(0));
      const s1 = texture(splatTex, c).depth(int(1));
      const blocked = dot(s0, uBlockA).add(dot(s1, uBlockB));
      const keep = float(1).sub(smoothstep(0.3, 0.6, blocked))
        .mul(float(1).sub(smoothstep(0.2, 0.35, s1.w)));
      return d.mul(keep);
    })();
    this._mask = { renderer, splatTex, uBlockA, uBlockB, quad: new QuadMesh(m), blockKey: "", seen: { d: -1, splat: -1, block: "" } };
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
    if (seen.d === this.tex.version && seen.splat === b.splatTex.version && seen.block === b.blockKey) return false;
    seen.d = this.tex.version; seen.splat = b.splatTex.version; seen.block = b.blockKey;
    const { renderer } = b;
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this._maskRT);
    b.quad.render(renderer);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
    return true;
  }

  stamp(opts) {
    if (stampFlowerDensity(this.tex.image.data, FLOWER_DENSITY_RES, opts)) {
      this.tex.needsUpdate = true;
      if (!opts.erase) this._hasData = true;
    }
  }

  getSnapshot() { return new Uint8Array(this.tex.image.data); }
  restoreSnapshot(s) {
    this.tex.image.data.set(s);
    this.tex.needsUpdate = true;
    this._hasData = s.some((v) => v > 0);
  }
  /** Fill one type everywhere. */
  fill(channel) {
    const data = this.tex.image.data;
    for (let i = channel; i < data.length; i += 4) data[i] = 255;
    this.tex.needsUpdate = true;
    this._hasData = true;
  }
  clear() {
    this.tex.image.data.fill(0);
    this.tex.needsUpdate = true;
    this._hasData = false;
  }
}
