/**
 * CPU FBM for sculpt noise — same as `splatmap-chunks.html` `_sculptFbm` / `_sculptSn2` / `_sculptH2`.
 */

function sculptH2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

export function sculptSn2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return (
    sculptH2(ix, iy) * (1 - u) * (1 - v) +
    sculptH2(ix + 1, iy) * u * (1 - v) +
    sculptH2(ix, iy + 1) * (1 - u) * v +
    sculptH2(ix + 1, iy + 1) * u * v
  );
}

/** @param {number} oct — clamped 1..8 inside */
export function sculptFbm(x, y, oct = 5) {
  const o = Math.max(1, Math.min(8, Math.round(oct)));
  let s = 0;
  let a = 0.5;
  let f = 1;
  let m = 0;
  for (let i = 0; i < o; i++) {
    s += sculptSn2(x * f, y * f) * a;
    m += a;
    a *= 0.5;
    f *= 2;
  }
  return m > 0 ? s / m : 0;
}
