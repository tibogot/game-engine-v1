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
 *
 * A SKY'S OWN CLOUD SHADOW MAP (setMap): a sky that marches real clouds (Sky Pro)
 * has a shadow map of them over the ground. setMap({ texture, center, size,
 * strength }) points the SAME texture slot at it — no new texture, no recompile —
 * and the visibility becomes that map's (Tidewater's cloudsShadow: the ground
 * point slid down the sun ray to sea level, bilinear, faded out at the map's
 * edge). setMap(null) goes back to the baked field.
 *
 * NO SAMPLER (2026-09-28): the field is read with four textureLoads and
 * filtered by hand, and both it and any map are NEAREST-filtered, so three binds
 * the slot with no sampler. The editor's terrain sits at WebGPU's 16 samplers but
 * only 18 of its 48 textures (measured), so this fits where the old one-sample
 * read broke it — which is why the editor can have it too. Off (no darkness, no
 * map) it branches out before any load.
 */
import * as THREE from "three";
import { float, max, positionWorld, select, smoothstep, texture, uniform, vec2, vec3, vec4, wgslFn } from "three/tsl";

// The "load" read: no sampler. mode 0 = off, 1 = the baked field (tiling), 2 = a sky's map (clamped).
const LOAD_FN = /* wgsl */`
fn csVisibility( mode: f32, P: vec3f, toSun: vec3f, fieldT: texture_2d<f32>, lite0: vec4f, lite1: vec4f, map0: vec4f ) -> f32 {
	var vis = 1.0;
	if ( mode > 0.5 ) {
		let res = vec2i( textureDimensions( fieldT ) );
		var q: vec2f;
		if ( mode < 1.5 ) {
			let k = ( lite1.x - P.y ) / max( toSun.y, 0.2 );
			q = ( P.xz + toSun.xz * k + lite1.yz ) / lite0.z;
		} else {
			let g = P.xz - toSun.xz * ( max( P.y, 0.0 ) / max( toSun.y, 0.08 ) );
			q = ( g - map0.xy ) / map0.z + 0.5;
		}
		let st = q * vec2f( res ) - 0.5;
		let fl = floor( st );
		let fr = st - fl;
		let i0 = vec2i( fl );
		var t: array<f32, 4>;
		for ( var j = 0; j < 4; j++ ) {
			var c = i0 + vec2i( j & 1, j >> 1u );
			if ( mode < 1.5 ) { c = ( ( c % res ) + res ) % res; } else { c = clamp( c, vec2i( 0 ), res - 1 ); }
			t[ j ] = textureLoad( fieldT, c, 0 ).x;
		}
		let n = mix( mix( t[ 0 ], t[ 1 ], fr.x ), mix( t[ 2 ], t[ 3 ], fr.x ), fr.y );
		if ( mode < 1.5 ) {
			let thr = 1.0 - lite0.x;
			vis = 1.0 - smoothstep( thr - lite0.w, thr + lite0.w, n ) * lite0.y;
		} else {
			let e = abs( q - 0.5 );
			vis = mix( 1.0, n, map0.w * smoothstep( 0.5, 0.42, max( e.x, e.y ) ) );
		}
	}
	return vis;
}`;

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
  // NEAREST = no sampler bound (the shader filters by hand; see the header)
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * One per sun. `sun` is the DirectionalLight, before it has ever rendered.
 * `attach: false` leaves the sun's colorNode alone (no texture in any lit
 * material); set() and update() still work and do nothing visible.
 * `sampled: true` (games, 2026-09-28) reads the field ONCE through a linear
 * sampler instead of four textureLoads filtered by hand: in nam the load path
 * cost 1.2-1.6 ms against 0.14 (same camera, gpuAB), ~1 ms of it even at
 * darkness 0. A game has samplers to spare; the editor's terrain does not. The
 * sampled slot cannot take a sky's map (setMap warns and keeps the field).
 */
export function createCloudShadowsLite(sun, params = {}, { attach = true, sampled = false } = {}) {
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
    // a sky's own map (setMap): 0 = the baked field; its centre (xz), size and strength
    useMap: uniform(0),
    map: uniform(new THREE.Vector4(0, 0, 1, 0)),
  };
  let fieldNode = null, field = null;
  if (attach && sampled) {
    field = bakeField();
    field.magFilter = field.minFilter = THREE.LinearFilter;
    fieldNode = texture(field);
    // Slide up the sun ray to the cloud layer, drift, ONE hardware-filtered read.
    const s = u.toSun;
    const k = u.height.sub(positionWorld.y).div(max(s.y, 0.2));
    const q = positionWorld.xz.add(vec2(s.x, s.z).mul(k)).add(u.offset).div(u.scale);
    const n = fieldNode.sample(q).r;
    const thr = float(1).sub(u.cover);
    const visibility = float(1).sub(smoothstep(thr.sub(u.soft), thr.add(u.soft), n).mul(u.darkness));
    const off = typeof location !== "undefined" && new URLSearchParams(location.search).get("cloudshadows") === "0";
    sun.colorNode = off ? vec3(u.sunCol) : vec3(u.sunCol).mul(visibility);
  } else if (attach) {
    field = bakeField();
    fieldNode = texture(field);
    // Slide up the sun ray to the cloud layer, drift, filter four texels (csVisibility). A map wins;
    // else the field while it darkens anything; else nothing is read.
    const m = select(u.useMap.greaterThan(0.5), float(2), select(u.darkness.greaterThan(0), float(1), float(0)));
    const visibility = wgslFn(LOAD_FN)(m, positionWorld, u.toSun, fieldNode,
      vec4(u.cover, u.darkness, u.scale, u.soft), vec4(u.height, u.offset.x, u.offset.y, 0), u.map);

    // ?cloudshadows=0: the sun's plain colour (the A/B for what the field costs).
    const off = typeof location !== "undefined" && new URLSearchParams(location.search).get("cloudshadows") === "0";
    sun.colorNode = off ? vec3(u.sunCol) : vec3(u.sunCol).mul(visibility);
  }

  const _dir = new THREE.Vector3();
  let mapSrc = null, _warnedMap = false;
  return {
    params: P,
    uniforms: u,
    /** True when a colorNode is on the sun (a map or the field can show). */
    get attached() { return !!fieldNode; },
    /** Per frame: the drift, the sun's direction and live colour, the map's placement. */
    update(dt) {
      u.offset.value.x += P.windX * dt;
      u.offset.value.y += P.windZ * dt;
      u.sunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
      _dir.copy(sun.position).sub(sun.target.position).normalize();
      u.toSun.value.copy(_dir);
      if (mapSrc) u.map.value.set(mapSrc.center.value.x, mapSrc.center.value.y, mapSrc.size.value, mapSrc.strength.value);
    },
    set(p = {}) {
      Object.assign(P, p);
      u.cover.value = P.cover;
      u.darkness.value = P.enabled ? P.darkness : 0;
      u.scale.value = P.scale * 4;
      u.soft.value = P.softness;
      u.height.value = P.height;
    },
    /**
     * A sky's own cloud shadow map, or null for the baked field. `src` = { texture (2D, .x =
     * sun visibility), center (uniform Vector2, world xz), size (uniform, m), strength
     * (uniform 0..1) }. A texture swap in the same slot: nothing recompiles.
     */
    setMap(src) {
      if (!fieldNode || src === mapSrc) return;
      if (sampled) {
        // The sampled slot cannot take a sky's map (NEAREST, half-float): boot into Sky Pro to have it.
        if (src && !_warnedMap) {
          _warnedMap = true;
          console.warn("[V3] cloud shadows: booted in the sampled (game) mode — a sky's cloud shadow map needs the boot skyMode \"skypro\"; the baked field stays.");
        }
        return;
      }
      mapSrc = src ?? null;
      fieldNode.value = mapSrc ? mapSrc.texture : field;
      u.useMap.value = mapSrc ? 1 : 0;
      if (!mapSrc) u.map.value.w = 0;
    },
  };
}
