/**
 * CLOUD SHADOWS, LITE — big soft patches of shade drifting over the land, for
 * a game that never draws the clouds themselves (an RTS looking down).
 *
 * The full cloudShadowMap.js marches a volumetric deck's density; with no deck
 * on screen that is a pass for clouds nobody sees. This is the other shape:
 * a 2D cloud-cover field baked ONCE (value-noise fbm, 256², tiling) into a
 * small texture; every lit pixel slides its world point up the SUN RAY to the
 * cloud height (so each shadow falls where its cloud would be), adds the wind
 * drift and reads ONE texel. It dims the SUN only — the sky light is untouched
 * — so a shaded patch reads as shade, not as a darker picture.
 *
 * (A first version computed three noise octaves per lit pixel: ~0.9 ms on
 * the foliage-heavy RTS view, where every pixel is shaded many times over.)
 *
 * HOW IT IS HOOKED: the sun gets light.colorNode = (its live colour ×
 * intensity) × visibility, set by worldEnvironment WHEN THE SUN IS CREATED.
 * It has to be then: three keeps one light node per light for good
 * (LightsNode's _lightsNodeRef) and reads colorNode only when that node is
 * made — setting it later does nothing, and patching the live node (tried,
 * 2026-09-26) freed the shadow map under the renderer. "Off" is darkness 0.
 * The colour uniform is kept in step with the light every frame (update()),
 * so the engine's per-frame sun colour keeps working.
 */
import * as THREE from "three";
import { float, max, positionWorld, smoothstep, texture, uniform, vec2, vec3 } from "three/tsl";

export const CLOUD_SHADOW_LITE_DEFAULTS = {
  enabled: false,
  cover: 0.45,        // share of the sky clouded (0-1)
  darkness: 0.7,      // how much sun a cloud core takes away (0-1)
  scale: 220,         // metres, the size of a typical cloud (a view is ~200 m: several fit)
  softness: 0.1,      // edge width, in cover units
  height: 900,        // m: where the clouds are, for the sun-ray slide
  windX: 6, windZ: 3, // m/s the pattern drifts
};

const RES = 256;
/** Tiling value-noise fbm, 0..1, baked once. Periods divide RES so it wraps. */
function bakeField() {
  const data = new Uint8Array(RES * RES);
  const lattice = (period, seed) => {
    const g = new Float32Array(period * period);
    let s = seed;
    for (let i = 0; i < g.length; i++) { s = (s * 16807) % 2147483647; g[i] = s / 2147483647; }
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10), sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
      const at = (i, j) => g[(((j % period) + period) % period) * period + (((i % period) + period) % period)];
      const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
      return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
    };
  };
  const o1 = lattice(4, 11), o2 = lattice(8, 23), o3 = lattice(16, 37);
  const raw = new Float32Array(RES * RES);
  for (let y = 0; y < RES; y++) for (let x = 0; x < RES; x++) {
    const u = x / RES, v = y / RES;
    raw[y * RES + x] = o1(u * 4, v * 4) * 0.55 + o2(u * 8, v * 8) * 0.3 + o3(u * 16, v * 16) * 0.15;
  }
  // EQUALISED by rank: fbm clusters round the middle, so "cover 0.45" left
  // most views wholly in a gap (you saw nothing, 2026-09-26). Now a value is
  // its rank, and cover IS the share of ground under cloud.
  const order = Array.from(raw.keys()).sort((i, j) => raw[i] - raw[j]);
  order.forEach((idx, r) => { data[idx] = Math.round((r / (order.length - 1)) * 255); });
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** One per sun. `sun` is the DirectionalLight, before it has ever rendered. */
export function createCloudShadowsLite(sun, params = {}) {
  const P = { ...CLOUD_SHADOW_LITE_DEFAULTS, ...params };
  const u = {
    sunCol: uniform(new THREE.Color().copy(sun.color).multiplyScalar(sun.intensity)),
    cover: uniform(P.cover),
    darkness: uniform(P.enabled ? P.darkness : 0),
    scale: uniform(P.scale * 4),   // the baked tile holds 4 cloud periods
    soft: uniform(P.softness),
    height: uniform(P.height),
    offset: uniform(new THREE.Vector2()),
    toSun: uniform(new THREE.Vector3(0, 1, 0)),
  };
  const field = bakeField();

  // Slide up the sun ray to the cloud layer, drift, one texel.
  const s = u.toSun;
  const k = u.height.sub(positionWorld.y).div(max(s.y, 0.2));
  const q = positionWorld.xz.add(vec2(s.x, s.z).mul(k)).add(u.offset).div(u.scale);
  const n = texture(field, q).r;
  const thr = float(1).sub(u.cover);
  const cloud = smoothstep(thr.sub(u.soft), thr.add(u.soft), n);
  const visibility = float(1).sub(cloud.mul(u.darkness));

  // ?cloudshadows=0: the sun's plain colour (the A/B for what the field costs).
  const off = typeof location !== "undefined" && new URLSearchParams(location.search).get("cloudshadows") === "0";
  sun.colorNode = off ? vec3(u.sunCol) : vec3(u.sunCol).mul(visibility);

  const _dir = new THREE.Vector3();
  return {
    params: P,
    uniforms: u,
    /** Per frame: the drift, the sun's direction and live colour. */
    update(dt) {
      u.offset.value.x += P.windX * dt;
      u.offset.value.y += P.windZ * dt;
      u.sunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
      _dir.copy(sun.position).sub(sun.target.position).normalize();
      u.toSun.value.copy(_dir);
    },
    set(p = {}) {
      Object.assign(P, p);
      u.cover.value = P.cover;
      u.darkness.value = P.enabled ? P.darkness : 0;
      u.scale.value = P.scale * 4;
      u.soft.value = P.softness;
      u.height.value = P.height;
    },
  };
}
