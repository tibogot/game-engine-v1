/**
 * ALPHA-COVERAGE MIPMAPS — why alpha-tested foliage dissolves at distance.
 *
 * Every card plant here is cut out with an alpha TEST: the shader samples the
 * card texture and discards anything under 0.4. That works at the base level
 * and quietly falls apart down the mip chain, because averaging is not what
 * the test does.
 *
 * Take a leaf four texels wide with alpha 1 sitting in empty space. One mip
 * down it is two texels at ~0.5. Two down, one texel at ~0.25 — and 0.25 is
 * under the threshold, so the leaf is GONE. Do that across a whole cluster and
 * the canopy thins as the camera pulls back: first it breaks into a chain-link
 * of speckle, then it goes see-through, then the tree is a stick. Measured on
 * the jungle tree's cluster card, whose leaves are ~2 texels wide by mip 3.
 *
 * The fix is Ignacio Castaño's (The Witness): after building each mip level,
 * SCALE ITS ALPHA so that the fraction of texels passing the threshold matches
 * the base level's. The leaf gets fatter as it gets blurrier, which is exactly
 * what preserves the silhouette's weight, and the cost is a one-off CPU pass
 * when the texture is drawn — nothing per frame.
 *
 * RGB is forced to white throughout: these textures are alpha masks and every
 * one of their consumers takes colour from the shader, so the colour channels
 * only ever mattered as a way for bilinear filtering to drag black in from
 * outside a leaf edge.
 */
import * as THREE from "three";

/** Fraction of texels whose alpha passes the test, after scaling by `s`. */
function coverage(alpha, s, cut) {
  let n = 0;
  for (let i = 0; i < alpha.length; i++) if (alpha[i] * s >= cut) n++;
  return n / alpha.length;
}

/**
 * The alpha scale that makes this level cover as much as the base level did.
 * Binary search, because coverage is monotonic in `s` but has no closed form.
 */
function scaleForCoverage(alpha, target, cut) {
  let lo = 0.0, hi = 8.0, s = 1.0;
  for (let i = 0; i < 12; i++) {
    s = (lo + hi) * 0.5;
    if (coverage(alpha, s, cut) < target) lo = s; else hi = s;
  }
  return (lo + hi) * 0.5;
}

/**
 * A texture with a hand-built, coverage-preserving mip chain.
 *
 * @param {HTMLCanvasElement} canvas  the drawn mask (white on transparent)
 * @param {object} [o]
 *   threshold   the shader's alpha test, 0-1 (foliageSystem discards under 0.4)
 *   anisotropy  for the live field; thumbnails go without
 */
export function coverageMippedTexture(canvas, { threshold = 0.4, anisotropy = 0 } = {}) {
  const w0 = canvas.width, h0 = canvas.height;
  const src = canvas.getContext("2d").getImageData(0, 0, w0, h0).data;
  const cut = threshold * 255;

  // Level 0. Alpha as drawn; RGB white so no filtering can pull black inward.
  //
  // The rows are flipped HERE rather than by setting `flipY` on the texture.
  // A CanvasTexture flips on upload and a DataTexture does not, so a card that
  // had been drawn for one would come out upside down on the other — and
  // flipping on the CPU also means every mip below is built from rows that are
  // already the right way up, instead of trusting the backend to flip each
  // level of a hand-supplied chain.
  let w = w0, h = h0;
  let alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = h - 1 - y;
    for (let x = 0; x < w; x++) alpha[y * w + x] = src[(sy * w + x) * 4 + 3];
  }
  const target = coverage(alpha, 1, cut);

  const levels = [];
  const pack = (a, ww, hh) => {
    const rgba = new Uint8Array(ww * hh * 4);
    for (let i = 0; i < a.length; i++) {
      rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = a[i];
    }
    return { data: rgba, width: ww, height: hh };
  };
  levels.push(pack(alpha, w, h));

  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
        const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
        next[y * nw + x] = (alpha[y0 * w + x0] + alpha[y0 * w + x1]
          + alpha[y1 * w + x0] + alpha[y1 * w + x1] + 2) >> 2;
      }
    }
    // Fatten this level until it covers what the base level covered.
    const s = scaleForCoverage(next, target, cut);
    if (s !== 1) for (let i = 0; i < next.length; i++) next[i] = Math.min(255, Math.round(next[i] * s));
    alpha = next; w = nw; h = nh;
    levels.push(pack(alpha, w, h));
  }

  const tex = new THREE.DataTexture(levels[0].data, w0, h0, THREE.RGBAFormat);
  tex.mipmaps = levels;                       // level 0 included; see Textures.getMipLevels
  tex.generateMipmaps = false;                // ours are better than the GPU's
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;                          // already flipped, above
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  if (anisotropy) tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}
