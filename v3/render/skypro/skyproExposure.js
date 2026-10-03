// SKY PRO — eye adaptation: Tidewater's auto exposure (post/PostFX.js _buildMeter), plus the
// night-look EV on top of it.
//
// Tidewater meters a 1/16 copy of its final HDR frame (after the haze, before exposure): the
// centre-weighted average of log2 luminance, then a PARTIAL correction toward refLum —
// "the eye only partly compensates: dark scenes stay darker" — clamped to [min, max], with the
// max falling to 2 (one stop) at night. Measured in the original on the tidewater-bay shot:
// x0.6 at 16.2 h (the min), ~x5 at dusk, x2.0 from 19 h on. Without it our Sky Pro sat at the
// bare 0.55: brighter than Tidewater by day, a stop darker at night.
//
// Tidewater does the average in a compute pass and keeps the value on the GPU. Here the engine's
// exposure is a CPU number (renderer.toneMappingExposure), so the 1/16 image is read back
// asynchronously and the formula runs on the CPU; the few frames of readback delay are far below
// the adaptation time constants (1/1.6 s, 1/1.1 s).
//
//   const ae = createSkyProExposure({ renderer });
//   ae.meter(rt)                       after the haze, on the linear HDR frame
//   const k = ae.update(dt, { night, enabled, nightEV })   the factor on the base exposure
//   ae.state                           { avg, target, value, nightGain } (debug)

import * as THREE from "three/webgpu";
import { Fn, uniform, vec2, texture, uv } from "three/tsl";

/** Tidewater PostFX aeUniforms. */
export const SKYPRO_AE = { refLum: 0.25, min: 0.6, max: 6.0, nightMax: 2.0, up: 1.6, down: 1.1 };

export function createSkyProExposure({ renderer }) {
  // ---- 1/16 copy: two passes of four bilinear taps, each covering a 4x4 block of its source
  const mk = () => new THREE.RenderTarget(1, 1, {
    depthBuffer: false, type: THREE.HalfFloatType, format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  const quarter = mk();
  const sixteenth = new THREE.RenderTarget(1, 1, {
    depthBuffer: false, type: THREE.FloatType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  });
  const makeDown = () => {
    const src = texture(new THREE.Texture());
    const texel = uniform(new THREE.Vector2(1, 1));
    const m = new THREE.MeshBasicNodeMaterial();
    // render-target to render-target: uv(), not screenUV (which mirrors; see skyproSky.js)
    m.fragmentNode = Fn(() => {
      const p = uv();
      const a = src.sample(p.add(texel.mul(vec2(-1, -1)))).level(0);
      const b = src.sample(p.add(texel.mul(vec2(1, -1)))).level(0);
      const c = src.sample(p.add(texel.mul(vec2(-1, 1)))).level(0);
      const d = src.sample(p.add(texel.mul(vec2(1, 1)))).level(0);
      return a.add(b).add(c).add(d).mul(0.25);
    })();
    m.depthTest = false; m.depthWrite = false;
    return { quad: new THREE.QuadMesh(m), src, texel };
  };
  const down1 = makeDown(), down2 = makeDown();

  const state = { avg: NaN, target: 1, value: 1, nightGain: 1, metered: false, reads: 0, dropped: 0 };
  let pending = false, pendingSince = 0, ticket = 0;
  let frame = 0;

  function pass(d, srcTex, srcW, srcH, dst) {
    d.src.value = srcTex;
    d.texel.value.set(1 / srcW, 1 / srcH);
    renderer.setRenderTarget(dst);
    d.quad.render(renderer);
  }

  /** Meter the linear HDR frame in `rt` (call after the haze has been written into it). */
  function meter(rt) {
    const w = rt.width, h = rt.height;
    if (!(w > 0 && h > 0)) return;
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    const sw = Math.max(1, Math.round(w / 16)), sh = Math.max(1, Math.round(h / 16));
    if (quarter.width !== qw || quarter.height !== qh) quarter.setSize(qw, qh);
    if (sixteenth.width !== sw || sixteenth.height !== sh) sixteenth.setSize(sw, sh);
    // A readback can be lost (seen after a canvas resize: the promise never settled and the
    // exposure froze); after a second it is dropped and its late result, if any, ignored.
    const now = performance.now();
    if (pending && now - pendingSince > 1000) { pending = false; state.dropped++; }
    // one readback in flight at a time; a new image every other frame is plenty
    if (pending || (frame++ & 1)) return;
    const prev = renderer.getRenderTarget();
    pass(down1, rt.texture, w, h, quarter);
    pass(down2, quarter.texture, qw, qh, sixteenth);
    renderer.setRenderTarget(prev);
    pending = true; pendingSince = now;
    const mine = ++ticket;
    renderer.readRenderTargetPixelsAsync(sixteenth, 0, 0, sw, sh).then((px) => {
      if (mine !== ticket) return;
      pending = false;
      // (the target may have been resized since: only a full image is averaged)
      if (px.length < sw * sh * 4) return;
      state.avg = logAverage(px, sw, sh);
      state.metered = true;
      state.reads++;
    }).catch(() => { if (mine === ticket) pending = false; });
  }

  /** Tidewater's centre-weighted log2 average of the luminance. */
  function logAverage(px, w, h) {
    let accL = 0, accW = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const l = Math.log2(Math.max(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2], 1e-4));
        const ux = (x + 0.5) / w - 0.5, uy = ((y + 0.5) / h - 0.5) * 1.4;
        const wt = Math.max(1 - Math.hypot(ux, uy) * 1.2, 0.15);
        accL += l * wt; accW += wt;
      }
    }
    return Math.pow(2, accL / Math.max(accW, 1e-4));
  }

  /**
   * @param {number} dt  seconds
   * @param {object} o   night (0..1, Tidewater's), enabled (Tidewater's auto exposure),
   *                     nightEV (the night look: extra stops at full night; 0 = faithful)
   * @returns {number}   the factor on the base exposure
   */
  function update(dt, { night = 0, enabled = true, nightEV = 0 } = {}) {
    let tgt = 1;
    if (enabled && state.metered) {
      const ratio = SKYPRO_AE.refLum / state.avg;
      const partial = ratio > 1 ? Math.pow(ratio, 0.8) : ratio;
      const hi = SKYPRO_AE.max + (SKYPRO_AE.nightMax - SKYPRO_AE.max) * night;
      tgt = Math.min(Math.max(partial, SKYPRO_AE.min), hi);
    }
    // the night look rides on the same easing, so scrubbing the clock never snaps
    state.nightGain = Math.pow(2, nightEV * night);
    tgt *= state.nightGain;
    state.target = tgt;
    const rate = tgt > state.value ? SKYPRO_AE.up : SKYPRO_AE.down;
    const k = 1 - Math.exp(-Math.max(dt, 0) * rate);
    state.value = Math.pow(2, Math.log2(Math.max(state.value, 1e-3)) + (Math.log2(tgt) - Math.log2(Math.max(state.value, 1e-3))) * k);
    return state.value;
  }

  function dispose() {
    quarter.dispose(); sixteenth.dispose();
  }

  return { meter, update, state, dispose };
}
