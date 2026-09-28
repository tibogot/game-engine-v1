// OCEAN PRO — its two procedural textures (part of the "pro" ocean mode, v3/render/oceanpro/).
// Ports of Tidewater's ocean/FoamTexture.js and the noise of ocean/SeaDetail.js (MIT, Copyright (c)
// 2026 DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE). The WGSL and the noise
// maths are Tidewater's; changes are marked `// PORT:`.

import * as THREE from "three/webgpu";

/**
 * Tileable procedural foam, generated once on the GPU (Tidewater FoamTexture.js).
 *   R: foam density field (thresholded by coverage)   G: fine bubble detail
 *   B: soft large-scale mottling                      A: streaks
 * PORT: a raw WebGPU compute pass on three's device into a texture three owns (level 0), then
 * three's own mip generation.
 */
export function createFoamTexture(renderer, size = 1024) {
  const tex = new THREE.StorageTexture(size, size);
  tex.name = "oceanpro foam pattern";
  tex.type = THREE.HalfFloatType;
  tex.format = THREE.RGBAFormat;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.mipmapsAutoUpdate = false;
  tex.anisotropy = 4;
  renderer.initTexture(tex);

  // fbm( uv, base, oct ) unrolled like the TSL version (constant octave weights)
  const fbm = (uv, base, oct) => {
    let s = "", a = 0.5, n = 0;
    for (let o = 0; o < oct; o++) {
      s += `${s ? " + " : ""}vnoise( ${uv}, ${(base * Math.pow(2, o)).toFixed(1)} ) * ${a}`;
      n += a;
      a *= 0.5;
    }
    return `( ( ${s} ) / ${n} )`;
  };

  const code = /* wgsl */`
@group( 0 ) @binding( 0 ) var foamOut: texture_storage_2d<rgba16float, write>;
fn hash2( p: vec2f ) -> vec2f { return fract( sin( vec2f( dot( p, vec2f( 127.1, 311.7 ) ), dot( p, vec2f( 269.5, 183.3 ) ) ) ) * 43758.5453 ); }
// GLSL-style mod (TSL .mod): x - y * floor( x / y )
fn fmod2( x: vec2f, y: f32 ) -> vec2f { return x - y * floor( x / y ); }

// periodic worley F1 with jittered cell sizes
fn worley( uv: vec2f, cells: f32 ) -> f32 {
	let p = uv * cells;
	let ip = floor( p );
	let fp = fract( p );
	var f1 = 8.0;
	for ( var j = -1; j <= 1; j++ ) {
		for ( var i = -1; i <= 1; i++ ) {
			let o = vec2f( f32( i ), f32( j ) );
			let cell = fmod2( ip + o, cells );
			let h = hash2( cell );
			let d = length( o + h - fp );
			f1 = min( f1, d );
		}
	}
	return f1;
}

fn vnoise( uv: vec2f, cells: f32 ) -> f32 {
	let p = uv * cells;
	let i = floor( p );
	let f = fract( p );
	let u = f * f * ( 3.0 - f * 2.0 );
	let a = hash2( fmod2( i, cells ) ).x;
	let b = hash2( fmod2( i + vec2f( 1.0, 0.0 ), cells ) ).x;
	let c = hash2( fmod2( i + vec2f( 0.0, 1.0 ), cells ) ).x;
	let d = hash2( fmod2( i + vec2f( 1.0, 1.0 ), cells ) ).x;
	return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}

@compute @workgroup_size( 8, 8, 1 )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	let px = gid.xy;
	let uv = ( vec2f( px ) + 0.5 ) / ${size}.0;

	// domain warp (organic, flowing shapes)
	let w1 = ( vec2f( ${fbm("uv", 3, 4)}, ${fbm("( uv + 0.43 )", 3, 4)} ) - 0.5 ) * 0.14;
	let wuv = uv + w1;

	// density: ragged rafts
	let dens = ${fbm("wuv", 4, 6)};

	// holes of many sizes punched through the mat (worley, radius varied by noise)
	let holeA = smoothstep( 0.28, 0.12, worley( wuv, 7.0 ) + ( ${fbm("uv", 16, 3)} - 0.5 ) * 0.25 );
	let holeB = smoothstep( 0.30, 0.16, worley( wuv + 0.17, 19.0 ) + ( ${fbm("uv", 32, 2)} - 0.5 ) * 0.3 );
	let holeC = smoothstep( 0.32, 0.18, worley( wuv + 0.61, 47.0 ) );
	let holes = clamp( holeA * 0.9 + holeB * 0.7 + holeC * 0.45, 0.0, 1.0 );

	// fine bubbles: small bright dots
	let bub = smoothstep( 0.24, 0.08, worley( uv + 0.33, 140.0 ) ) * 0.8 + smoothstep( 0.2, 0.05, worley( uv + 0.71, 260.0 ) ) * 0.5;

	// streaks (drawn out by flow)
	let suv = vec2f( uv.x * 1.0, uv.y * 1.0 ) + w1 * 2.0;
	let streak = ${fbm("suv", 12, 4)};

	let foam = clamp( dens * 1.35 - holes * 0.55 + bub * 0.08, 0.0, 1.0 );
	let mottle = ${fbm("uv", 2, 3)};

	textureStore( foamOut, px, vec4f( foam, clamp( bub, 0.0, 1.0 ), mottle, streak ) );
}`;
  const dev = renderer.backend.device;
  const pipeline = dev.createComputePipeline({
    label: "OceanPro Foam Pattern", layout: "auto",
    compute: { module: dev.createShaderModule({ label: "oceanpro foam", code }), entryPoint: "main" },
  });
  const gpuTex = renderer.backend.get(tex).texture;
  const bind = dev.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: gpuTex.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1 }) }],
  });
  const enc = dev.createCommandEncoder({ label: "oceanpro foam" });
  const pass = enc.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(size / 8, size / 8, 1);
  pass.end();
  dev.queue.submit([enc.finish()]);
  renderer.backend.generateMipmaps(tex);
  return tex;
}

// mulberry32 (Tidewater util/Noise.js)
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sea detail noise (Tidewater SeaDetail.js makeNoiseTexture): tileable smooth fbm in 4 channels
 * (different seeds / base frequencies) — gusts, their morph, slicks, windrows.
 * PORT: a three DataTexture (HalfFloat RGBA), linear + repeat, no mips (sampled at level 0).
 */
export function createSeaDetailTexture(size = 256) {
  const data = new Uint16Array(size * size * 4);
  const channels = [
    { seed: 11, freq: 4, oct: 4 },
    { seed: 23, freq: 5, oct: 4 },
    { seed: 37, freq: 4, oct: 3 },
    { seed: 53, freq: 6, oct: 3 },
  ];
  for (let c = 0; c < 4; c++) {
    const { seed, freq, oct } = channels[c];
    const rand = mulberry32(seed);
    // gradient tables per octave (periodic lattice)
    const tables = [];
    for (let o = 0; o < oct; o++) {
      const n = freq << o;
      const g = new Float32Array(n * n * 2);
      for (let i = 0; i < n * n; i++) {
        const a = rand() * Math.PI * 2;
        g[i * 2] = Math.cos(a);
        g[i * 2 + 1] = Math.sin(a);
      }
      tables.push({ n, g });
    }
    let mn = Infinity, mx = -Infinity;
    const vals = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0, amp = 1, norm = 0;
      for (let o = 0; o < oct; o++) {
        const { n, g } = tables[o];
        const fx = x / size * n, fy = y / size * n;
        const xi = Math.floor(fx), yi = Math.floor(fy);
        const xf = fx - xi, yf = fy - yi;
        const grad = (ix, iy, dx, dy) => {
          const k = (((iy % n) + n) % n) * n + (((ix % n) + n) % n);
          return g[k * 2] * dx + g[k * 2 + 1] * dy;
        };
        const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
        const w = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
        const a0 = grad(xi, yi, xf, yf), a1 = grad(xi + 1, yi, xf - 1, yf);
        const b0 = grad(xi, yi + 1, xf, yf - 1), b1 = grad(xi + 1, yi + 1, xf - 1, yf - 1);
        const nv = (a0 + (a1 - a0) * u) + ((b0 + (b1 - b0) * u) - (a0 + (a1 - a0) * u)) * w;
        v += nv * amp;
        norm += amp;
        amp *= 0.5;
      }
      v /= norm;
      vals[y * size + x] = v;
      mn = Math.min(mn, v);
      mx = Math.max(mx, v);
    }
    for (let i = 0; i < size * size; i++) data[i * 4 + c] = THREE.DataUtils.toHalfFloat((vals[i] - mn) / (mx - mn));
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.name = "oceanpro sea detail";
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
