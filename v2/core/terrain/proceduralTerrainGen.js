/**
 * CPU terrain height — ported from `splatmap-chunks.html` (`terrainGenHeightAtWorld` + helpers).
 * World normalization matches v1: nx = wx / worldSize + 0.5, nz = wz / worldSize + 0.5.
 */

function genH2(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function genSn2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return (
    genH2(ix, iy) * (1 - u) * (1 - v) +
    genH2(ix + 1, iy) * u * (1 - v) +
    genH2(ix, iy + 1) * (1 - u) * v +
    genH2(ix + 1, iy + 1) * u * v
  );
}

function genFbm(x, y, oct = 5) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let m = 0;
  for (let i = 0; i < oct; i++) {
    s += genSn2(x * f, y * f) * a;
    m += a;
    a *= 0.5;
    f *= 2;
  }
  return s / m;
}

function genFbmRidge(x, y, oct = 6) {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let m = 0;
  for (let i = 0; i < oct; i++) {
    const n = genSn2(x * f, y * f);
    s += (1.0 - Math.abs(n * 2.0 - 1.0)) * a;
    m += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / m;
}

/**
 * @param {number} wx
 * @param {number} wz
 * @param {object} g — same fields as v1 `PARAMS.gen`
 * @param {number} worldSize
 */
export function terrainGenHeightAtWorld(wx, wz, g, worldSize) {
  const nx = wx / worldSize + 0.5;
  const nz = wz / worldSize + 0.5;
  const sc = g.scale;
  const oct = Math.round(g.octaves);
  const H = g.height;
  const seed = g.seed * 100;
  const warp = g.domainWarp;
  const drop = g.dropoff;
  const cx0 = 0.5 + g.offsetX;
  const cz0 = 0.5 + g.offsetZ;

  const wxp =
    warp > 0
      ? genFbm(nx * sc * 3 + seed + 31.7, nz * sc * 3 + seed + 17.3, 4) * warp * 0.08
      : 0;
  const wzp =
    warp > 0
      ? genFbm(nx * sc * 3 + seed + 55.1, nz * sc * 3 + seed + 89.2, 4) * warp * 0.08
      : 0;

  const sx = nx * sc + seed + wxp;
  const sz = nz * sc + seed + wzp;

  const raw = g.mode === "ridge" ? genFbmRidge(sx, sz, oct) : genFbm(sx, sz, oct);

  const dx = (nx - cx0) * 2;
  const dz = (nz - cz0) * 2;
  const rCircle = Math.sqrt(dx * dx + dz * dz);
  const rBox = Math.max(Math.abs(dx), Math.abs(dz));

  /** Circle / box / noise: high in center → `1 - r^drop`. Ring variants: high at edges → `t^drop`, t = normalized distance from center. */
  let falloff;
  const shape = g.dropoffShape;
  if (shape === "ring") {
    const rCap = Math.SQRT2;
    const t = Math.min(1, Math.max(0, rCircle / rCap));
    falloff = Math.pow(t, drop);
  } else if (shape === "invertedBox") {
    const t = Math.min(1, Math.max(0, rBox));
    falloff = Math.pow(t, drop);
  } else if (shape === "noiseRing") {
    const nr = genFbm(nx * 3.1 + seed + 7.3, nz * 3.1 + seed + 12.1, 3) * 0.45;
    const r = rCircle + nr;
    const rCap = Math.SQRT2 + 0.55;
    const t = Math.min(1, Math.max(0, r / rCap));
    falloff = Math.pow(t, drop);
  } else if (shape === "box") {
    falloff = Math.max(0, 1 - Math.pow(Math.max(0, rBox), drop));
  } else if (shape === "noise") {
    const nr = genFbm(nx * 3.1 + seed + 7.3, nz * 3.1 + seed + 12.1, 3) * 0.45;
    const r = rCircle - nr;
    falloff = Math.max(0, 1 - Math.pow(Math.max(0, r), drop));
  } else {
    falloff = Math.max(0, 1 - Math.pow(Math.max(0, rCircle), drop));
  }

  const tilt = g.tiltX * (nx - 0.5) * 2 + g.tiltZ * (nz - 0.5) * 2;

  let h = (raw + tilt * 0.5) * H * falloff;

  if (g.plains > 0) {
    const thresh = g.plains * H * 0.6;
    h = h < thresh ? 0 : h - thresh;
  }

  return Math.max(0, h);
}
