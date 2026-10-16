import * as THREE from "three";

const WIND_RES = 512;

const GRAD2 = [
  1, 0,  -1, 0,   0, 1,   0, -1,
  0.7071, 0.7071,  -0.7071, 0.7071,
  0.7071, -0.7071, -0.7071, -0.7071,
];

function _hash(ix, iy) {
  let n = ix * 1597 + iy * 5171;
  n = ((n << 13) ^ n);
  n = (n * (n * n * 15731 + 789221) + 1376312589);
  return ((n >>> 0) % 8);
}

function _grad(ix, iy, fx, fy) {
  const i = _hash(ix, iy) * 2;
  return GRAD2[i] * fx + GRAD2[i + 1] * fy;
}

function _fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function perlin2(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = _fade(fx);
  const v = _fade(fy);
  const n00 = _grad(ix, iy, fx, fy);
  const n10 = _grad(ix + 1, iy, fx - 1, fy);
  const n01 = _grad(ix, iy + 1, fx, fy - 1);
  const n11 = _grad(ix + 1, iy + 1, fx - 1, fy - 1);
  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}

function fbm2(x, y, octaves) {
  let s = 0, a = 0.5, m = 0;
  for (let i = 0; i < octaves; i++) {
    s += perlin2(x, y) * a;
    m += a;
    a *= 0.5;
    const nx = x * 2.0327 - y * 1.2671;
    const ny = x * 1.2671 + y * 2.0327;
    x = nx;
    y = ny;
  }
  return m > 0 ? s / m : 0;
}

export function createSpecNoiseTexture(size = 256) {
  const data = new Float32Array(size * size * 4);
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const u = ix / size;
      const v = iy / size;
      const idx = (iy * size + ix) * 4;
      data[idx]     = fbm2(u * 8 + 431.7, v * 8 + 293.1, 3) * 0.5 + 0.5;
      data[idx + 1] = fbm2(u * 8 + 17.3,  v * 8 + 31.7,  3) * 0.5 + 0.5;
      data[idx + 2] = fbm2(u * 8 * 2.7 + 59.3, v * 8 * 2.7 + 73.1, 3) * 0.5 + 0.5;
      data[idx + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createWindTexture() {
  const data = new Float32Array(WIND_RES * WIND_RES * 4);

  for (let iy = 0; iy < WIND_RES; iy++) {
    for (let ix = 0; ix < WIND_RES; ix++) {
      const u = ix / WIND_RES;
      const v = iy / WIND_RES;
      const idx = (iy * WIND_RES + ix) * 4;

      data[idx]     = fbm2(u * 8, v * 8, 4) * 0.5 + 0.5;
      data[idx + 1] = fbm2(u * 3 + 73.1, v * 3 + 41.3, 3) * 0.5 + 0.5;
      data[idx + 2] = fbm2(u * 6 + 137.9, v * 6 + 259.1, 4) * 0.5 + 0.5;
      data[idx + 3] = fbm2(u * 12 + 317.3, v * 12 + 197.7, 3) * 0.5 + 0.5;
    }
  }

  const tex = new THREE.DataTexture(data, WIND_RES, WIND_RES, THREE.RGBAFormat, THREE.FloatType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}
