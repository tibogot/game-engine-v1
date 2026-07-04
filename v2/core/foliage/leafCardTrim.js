/**
 * Trimmed leaf cards — fit a convex octagon to the leaf mask so cards
 * rasterize ~30-50% fewer alpha-discarded pixels than a full quad
 * (SpeedTree-style). The trim lives in the card's LOCAL 2D space
 * (x,y ∈ [-0.5, 0.5], uv = local + 0.5); billboarding merely orients that
 * space per frame, so trimmed cards billboard identically to quads.
 *
 * Trade: 6 triangles instead of 2 per card. Leaf rendering is fill-bound,
 * so trading vertex count for fill is the right direction by a wide margin.
 */
import * as THREE from "three";

const DIRS = 8;

/**
 * @param {HTMLImageElement|HTMLCanvasElement} image — the leaf mask source
 * @param {object} opts
 * @param {boolean} opts.maskInAlpha  — mask channel (matches the material)
 * @param {?{x:number,y:number,w:number,h:number}} opts.cellRect — atlas cell
 *        in CANVAS coordinates (fractions, y measured from the top)
 * @returns {?Array<[number,number]>} convex CCW polygon in local space, or
 *          null when trimming isn't possible/worth it (caller keeps the quad)
 */
export function computeLeafTrimPolygon(image, { maskInAlpha = false, cellRect = null } = {}) {
  try {
    const S = 64;
    const cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (cellRect) {
      const iw = image.width ?? image.naturalWidth;
      const ih = image.height ?? image.naturalHeight;
      ctx.drawImage(
        image,
        cellRect.x * iw, cellRect.y * ih, cellRect.w * iw, cellRect.h * ih,
        0, 0, S, S,
      );
    } else {
      ctx.drawImage(image, 0, 0, S, S);
    }
    const data = ctx.getImageData(0, 0, S, S).data;
    const ch = maskInAlpha ? 3 : 0;
    const cut = 24; // conservative: keep faint fringe pixels inside the trim

    // Support (max projection) of opaque pixels along 8 evenly spaced dirs.
    const nx = [], ny = [], h = [];
    for (let k = 0; k < DIRS; k++) {
      const a = (k / DIRS) * Math.PI * 2;
      nx.push(Math.cos(a));
      ny.push(Math.sin(a));
      h.push(-Infinity);
    }
    let any = false;
    for (let py = 0; py < S; py++) {
      const y = 0.5 - (py + 0.5) / S; // canvas y-down → local y-up
      for (let px = 0; px < S; px++) {
        if (data[(py * S + px) * 4 + ch] < cut) continue;
        any = true;
        const x = (px + 0.5) / S - 0.5;
        for (let k = 0; k < DIRS; k++) {
          const d = x * nx[k] + y * ny[k];
          if (d > h[k]) h[k] = d;
        }
      }
    }
    if (!any) return null;

    // Safety margin, clamped to the quad's own support so we never exceed it.
    const margin = 1.5 / S;
    for (let k = 0; k < DIRS; k++) {
      h[k] = Math.min(0.5 * (Math.abs(nx[k]) + Math.abs(ny[k])), h[k] + margin);
    }

    // Octagon vertices = intersections of consecutive support planes.
    const pts = [];
    for (let k = 0; k < DIRS; k++) {
      const j = (k + 1) % DIRS;
      const det = nx[k] * ny[j] - nx[j] * ny[k];
      if (Math.abs(det) < 1e-6) return null;
      pts.push([
        (h[k] * ny[j] - h[j] * ny[k]) / det,
        (nx[k] * h[j] - nx[j] * h[k]) / det,
      ]);
    }

    // Shoelace area — skip trimming when the saving is negligible.
    let area = 0;
    for (let k = 0; k < DIRS; k++) {
      const [x1, y1] = pts[k];
      const [x2, y2] = pts[(k + 1) % DIRS];
      area += x1 * y2 - x2 * y1;
    }
    area = Math.abs(area) / 2;
    if (!(area > 0.01) || area > 0.9) return null;
    return pts;
  } catch (_) {
    return null; // tainted canvas etc. — keep the plain quad
  }
}

/** Card geometry from a convex local-space polygon (triangle fan); quad fallback. */
export function buildLeafCardGeometry(polygon) {
  if (!polygon || polygon.length < 3) return new THREE.PlaneGeometry(1, 1);
  const n = polygon.length;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv  = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3]     = polygon[i][0];
    pos[i * 3 + 1] = polygon[i][1];
    nrm[i * 3 + 2] = 1;
    uv[i * 2]     = polygon[i][0] + 0.5;
    uv[i * 2 + 1] = polygon[i][1] + 0.5;
  }
  const idx = [];
  for (let i = 1; i < n - 1; i++) idx.push(0, i, i + 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
