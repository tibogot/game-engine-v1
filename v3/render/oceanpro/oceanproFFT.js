// OCEAN PRO — the FFT sea (part of the "pro" ocean mode, v3/render/oceanpro/). Port of Tidewater's
// ocean/OceanFFT.js (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see
// v3/skypro-real/tidewater/LICENSE). The kernels' WGSL is Tidewater's, verbatim; changes are marked
// `// PORT:`.
//
// Multi-cascade Tessendorf FFT with a two-system (local sea + swell) Horvath/JONSWAP spectrum, 256²
// per cascade, 4 cascades of 733 / 157 / 33.3 / 7.1 m. Per frame: two compute dispatches for all
// cascades (rows then columns, each a 256-point radix-2 IFFT in workgroup memory), the Jacobian foam
// accumulated in the column pass, and the mip chains filled by two more compute kernels.
//
// HOW IT RUNS IN THREE: the kernels are RAW WebGPU compute pipelines on three's own GPUDevice
// (renderer.backend.device). They write into textures THREE owns (StorageArrayTexture, full mip
// chain allocated, mipmapsAutoUpdate off) through per-mip storage views of the GPUTexture three
// created, so any three material samples them as ordinary array textures. Queue order does the
// rest: this frame's compute is submitted before three's render submits.
//
// Output textures (2D arrays, one layer per cascade, rgba16float, 9 mips):
//   displacement  (Dx, Dy, Dz, foam)
//   derivatives   (dDy/dx, dDy/dz, dDx/dx, dDz/dz)

import * as THREE from "three/webgpu";

export const FFT_SIZE = 256;
const N = FFT_SIZE;
const LOG2N = 8;
const HALF = N / 2;
const GRAVITY = 9.81;

/** Non-integer ratios between cascade sizes avoid visible repetition (Tidewater). */
export const DEFAULT_CASCADE_SIZES = [733, 157, 33.3, 7.1];

const TWO_PI = Math.PI * 2;

/** One wave system (the local wind sea, or the swell). Tidewater's WaveSystem. */
export class WaveSystem {
  constructor(o = {}) {
    this.scale = o.scale ?? 1;
    this.windSpeed = o.windSpeed ?? 8; // m/s
    this.windDirection = o.windDirection ?? 20; // degrees
    this.fetch = o.fetch ?? 200; // km
    this.spreadBlend = o.spreadBlend ?? 0.9;
    this.swell = o.swell ?? 0.2;
    this.peakEnhancement = o.peakEnhancement ?? 3.3;
    this.shortWavesFade = o.shortWavesFade ?? 0.01;
  }
}

// PORT: the parts of Tidewater's common module the kernels use
const COMMON = /* wgsl */`
const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;
fn sat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }
`;

// PORT: Tidewater's OceanParams block, plus `dt` (its kernels read frame.dt; there is no frame here)
const OCEAN_STRUCT = /* wgsl */`
struct OceanParams {
	sizes: array<vec4f, 4>,
	cuts: array<vec4f, 4>,
	sysA: array<vec4f, 2>,
	sysB: array<vec4f, 2>,
	choppiness: f32,
	foamBias: f32,
	foamGain: f32,
	foamDecay: f32,
	foamAdd: f32,
	time: f32,
	depth: f32,
	seed: u32,
	dt: f32,
	_pad0: f32,
	_pad1: f32,
	_pad2: f32,
};
@group( 0 ) @binding( 0 ) var<uniform> ocean: OceanParams;
`;
const OCEAN_BYTES = 256; // 60 floats used, rounded up

// WGSL shared by the kernels: PCG hash, complex helpers (Tidewater FFT_COMMON)
const FFT_COMMON = /* wgsl */`
const FFT_N: u32 = ${N}u;
const FFT_HALF: u32 = ${HALF}u;
const FFT_G: f32 = ${GRAVITY};

fn fftBitReverse8( v: u32 ) -> u32 {
	var r = v;
	r = ( ( r & 0x55u ) << 1u ) | ( ( r >> 1u ) & 0x55u );
	r = ( ( r & 0x33u ) << 2u ) | ( ( r >> 2u ) & 0x33u );
	r = ( ( r & 0x0Fu ) << 4u ) | ( ( r >> 4u ) & 0x0Fu );
	return r;
}

// complex multiply of two packed complex numbers (v.xy, v.zw) by scalar complex w
fn fftCmul2( v: vec4f, w: vec2f ) -> vec4f {
	return vec4f( v.x * w.x - v.y * w.y, v.x * w.y + v.y * w.x, v.z * w.x - v.w * w.y, v.z * w.y + v.w * w.x );
}

// PCG hash
fn fftPcg( v: u32 ) -> u32 {
	let state = v * 747796405u + 2891336453u;
	let word = ( ( state >> ( ( state >> 28u ) + 4u ) ) ^ state ) * 277803737u;
	return ( word >> 22u ) ^ word;
}
fn fftToUnit( h: u32 ) -> f32 { return f32( h >> 8u ) * ( 1.0 / 16777216.0 ) + ( 0.5 / 16777216.0 ); }
`;

const SPECTRUM = /* wgsl */`
fn dispersion( k: f32 ) -> f32 { return sqrt( k * FFT_G * tanh( min( k * ocean.depth, 20.0 ) ) ); }

fn dispersionDerivative( k: f32 ) -> f32 {
	let kd = min( k * ocean.depth, 20.0 );
	let th = tanh( kd );
	let ch = cosh( kd );
	return FFT_G * ( ocean.depth * k / ( ch * ch ) + th ) / dispersion( k ) * 0.5;
}

fn tmaCorrection( omega: f32 ) -> f32 {
	let omegaH = omega * sqrt( ocean.depth / FFT_G );
	let a = omegaH * omegaH * 0.5;
	let b = 1.0 - pow( 2.0 - omegaH, 2.0 ) * 0.5;
	return select( select( 1.0, b, omegaH < 2.0 ), a, omegaH <= 1.0 );
}

fn jonswap( omega: f32, sysA: vec4f, sysB: vec4f ) -> f32 {
	let alpha = sysB.x; let peakOmega = sysB.y; let gamma = sysB.z;
	let sigma = select( 0.09, 0.07, omega <= peakOmega );
	let d = omega - peakOmega;
	let r = exp( - d * d / ( sigma * sigma * peakOmega * peakOmega * 2.0 ) );
	let inv = 1.0 / omega;
	let po = peakOmega * inv;
	return sysA.x * tmaCorrection( omega ) * alpha * ( FFT_G * FFT_G )
		* pow( inv, 5.0 )
		* exp( pow( po, 4.0 ) * -1.25 )
		* pow( abs( gamma ), r );
}

fn normalisationFactor( s: f32 ) -> f32 {
	let s2 = s * s; let s3 = s2 * s; let s4 = s3 * s;
	let lo = s4 * -0.000564 + s3 * 0.00776 - s2 * 0.044 + s * 0.192 + 0.163;
	let hi = s4 * -4.80e-08 + s3 * 1.07e-05 - s2 * 9.53e-04 + s * 5.90e-02 + 3.93e-01;
	return select( hi, lo, s < 5.0 );
}

fn directionSpectrum( theta: f32, omega: f32, sysA: vec4f, sysB: vec4f ) -> f32 {
	let peakOmega = sysB.y;
	let ratio = omega / peakOmega;
	let spreadPower = select( pow( abs( ratio ), 5.0 ) * 6.97, pow( abs( ratio ), -2.5 ) * 9.77, omega > peakOmega );
	let s = spreadPower + tanh( min( ratio, 20.0 ) ) * 16.0 * sysA.w * sysA.w;
	let dTheta = theta - sysA.y;
	let cos2s = normalisationFactor( s ) * pow( abs( cos( dTheta * 0.5 ) ), s * 2.0 );
	let cosT = cos( dTheta );
	let base = cosT * cosT * ( 2.0 / PI ) * select( 0.0, 1.0, cosT > 0.0 );
	return mix( base, cos2s, sysA.z );
}

fn shortWavesFade( k: f32, sysB: vec4f ) -> f32 { return exp( - sysB.w * sysB.w * k * k ); }
`;

// the radix-2 butterfly stages (Tidewater: unrolled per stage)
function butterflyStages() {
  let stages = "";
  for (let s = 0; s < LOG2N; s++) {
    const half = 1 << s;
    stages += /* wgsl */`
	{
		let pos = t & ${half - 1}u;
		let i = ( ( t >> ${s}u ) << ${s + 1}u ) | pos;
		let j = i + ${half}u;
		let ang = f32( pos ) * ${(Math.PI / half).toFixed(12)};
		let w = vec2f( cos( ang ), sin( ang ) );
		let i2 = i * 2u; let j2 = j * 2u;
		let a0 = fftShared[ i2 ]; let a1 = fftShared[ i2 + 1u ];
		let b0 = fftCmul2( fftShared[ j2 ], w ); let b1 = fftCmul2( fftShared[ j2 + 1u ], w );
		fftShared[ i2 ] = a0 + b0;
		fftShared[ i2 + 1u ] = a1 + b1;
		fftShared[ j2 ] = a0 - b0;
		fftShared[ j2 + 1u ] = a1 - b1;
		workgroupBarrier();
	}`;
  }
  return stages;
}

/**
 * @param {THREE.WebGPURenderer} renderer  (initialised: its backend device is used)
 * @param {object} [options]  cascades (4), sizes, depth (m), local / swell (WaveSystem options),
 *                            choppiness
 */
export class OceanProFFT {
  constructor(renderer, options = {}) {
    this.renderer = renderer;
    this.device = renderer.backend.device;
    this.cascades = options.cascades ?? 4;
    this.sizes = (options.sizes ?? DEFAULT_CASCADE_SIZES).slice(0, this.cascades);
    this.depth = options.depth ?? 500;
    this.local = new WaveSystem(options.local ?? { windSpeed: 7, windDirection: 25, fetch: 120, spreadBlend: 0.85, swell: 0.05 });
    this.swell = new WaveSystem(options.swell ?? { scale: 0.48, windSpeed: 6, windDirection: 5, fetch: 1200, spreadBlend: 1.0, swell: 0.9, shortWavesFade: 0.1 });

    // the uniform block, CPU side (Tidewater's field defaults)
    this.params = {
      choppiness: options.choppiness ?? 0.9,
      // foam starts where a cascade compresses the surface below this Jacobian (per-cascade J
      // stays close to 1: 0.85 gives ~0.3% whitecap cover at 7 m/s, 0.9 several % in fresh wind)
      foamBias: 0.58,
      foamGain: 3.0,
      foamDecay: 0.35,
      foamAdd: 2.5,
      seed: 1337,
    };
    this.time = 0;
    this.timeScale = 1;
    this._sizes = new Float32Array(16);
    this._cuts = new Float32Array(16);
    this._sysA = new Float32Array(8);
    this._sysB = new Float32Array(8);
    this._ubo = new ArrayBuffer(OCEAN_BYTES);

    const C = this.cascades;
    const total = N * N * C;
    const dev = this.device;
    const buf = (label, bytes) => dev.createBuffer({ label, size: bytes, usage: GPUBufferUsage.STORAGE });
    this.uniformBuffer = dev.createBuffer({ label: "oceanpro params", size: OCEAN_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.h0 = buf("oceanpro h0", total * 16);
    this.waveData = buf("oceanpro wave", total * 16);
    this.tmp = buf("oceanpro tmp", total * 2 * 16);
    this.foam = buf("oceanpro foam", total * 4);
    // level 0 of both textures (interleaved) for the compute mip chain, and the 16x16 level 4
    // (PORT: Tidewater keeps the 8x8 level 5 — see the mip kernels)
    this.mipSrc = buf("oceanpro mipSrc", total * 2 * 16);
    this.mipMid = buf("oceanpro mipMid", 256 * C * 2 * 16);

    // THE TEXTURES ARE THREE'S (so materials bind them normally); the kernels write their mips
    const makeTex = (name) => {
      const t = new THREE.StorageArrayTexture(N, N, C);
      t.name = name;
      t.type = THREE.HalfFloatType;
      t.format = THREE.RGBAFormat;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true; // allocates the full chain...
      t.mipmapsAutoUpdate = false; // ...that the compute mip kernels fill
      t.anisotropy = 4;
      renderer.initTexture(t);
      return t;
    };
    this.displacementTexture = makeTex("oceanpro displacement"); // (Dx, Dy, Dz, foam)
    this.derivativeTexture = makeTex("oceanpro derivatives"); // (dDy/dx, dDy/dz, dDx/dx, dDz/dz)
    const gpuTex = (t) => renderer.backend.get(t).texture;
    this._levelView = (t, l) => gpuTex(t).createView({ dimension: "2d-array", baseMipLevel: l, mipLevelCount: 1 });

    this._buildKernels();
    this.updateSpectrumUniforms();
    this.needsSpectrum = true;
  }

  setCascadeSizes(sizes) {
    this.sizes = sizes.slice(0, this.cascades);
    this.updateSpectrumUniforms();
  }

  /** Re-derive the spectrum inputs from the wave systems; the spectrum is re-initialised next update. */
  updateSpectrumUniforms() {
    const C = this.cascades;
    for (let i = 0; i < C; i++) {
      const low = i === 0 ? 0.0001 : (TWO_PI / this.sizes[i]) * 6;
      const high = i === C - 1 ? 9999 : (TWO_PI / this.sizes[i + 1]) * 6;
      this._cuts.set([low, high, 0, 0], i * 4);
      this._sizes.set([this.sizes[i], 0, 0, 0], i * 4);
    }
    const sys = [this.local, this.swell];
    for (let i = 0; i < 2; i++) {
      const s = sys[i];
      const fetchM = Math.max(1, s.fetch) * 1000;
      const U = Math.max(0.1, s.windSpeed);
      const alpha = 0.076 * Math.pow(GRAVITY * fetchM / (U * U), -0.22);
      const peakOmega = 22 * Math.pow(U * fetchM / (GRAVITY * GRAVITY), -0.33);
      this._sysA.set([s.scale, THREE.MathUtils.degToRad(s.windDirection), s.spreadBlend, s.swell], i * 4);
      this._sysB.set([alpha, peakOmega, s.peakEnhancement, s.shortWavesFade], i * 4);
    }
    this.needsSpectrum = true;
  }

  _writeUniforms(dt) {
    const f = new Float32Array(this._ubo);
    const u = new Uint32Array(this._ubo);
    f.set(this._sizes, 0);
    f.set(this._cuts, 16);
    f.set(this._sysA, 32);
    f.set(this._sysB, 40);
    const P = this.params;
    f[48] = P.choppiness; f[49] = P.foamBias; f[50] = P.foamGain; f[51] = P.foamDecay;
    f[52] = P.foamAdd; f[53] = this.time; f[54] = this.depth; u[55] = P.seed >>> 0;
    f[56] = dt;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._ubo);
  }

  _buildKernels() {
    const dev = this.device;
    const C = this.cascades;
    const wg = (code, [x, y, z]) => code.replaceAll("WG_X", x).replaceAll("WG_Y", y).replaceAll("WG_Z", z);
    const pipe = (label, code) => dev.createComputePipeline({
      label, layout: "auto", compute: { module: dev.createShaderModule({ label, code }), entryPoint: "main" },
    });
    const group = (pipeline, entries) => dev.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
    const B = (binding, buffer) => ({ binding, resource: { buffer } });
    const T = (binding, view) => ({ binding, resource: view });
    const U = B(0, this.uniformBuffer);

    // PORT: explicit binding declarations (Tidewater's ComputeKernel generates them)
    const rwVec4 = (b, name) => `@group( 0 ) @binding( ${b} ) var<storage, read_write> ${name}: array<vec4f>;\n`;
    const rwF32 = (b, name) => `@group( 0 ) @binding( ${b} ) var<storage, read_write> ${name}: array<f32>;\n`;
    const outTex = (b, name) => `@group( 0 ) @binding( ${b} ) var ${name}: texture_storage_2d_array<rgba16float, write>;\n`;

    // ---------- init spectrum ----------
    const init = pipe("OceanPro Init Spectrum", wg(COMMON + OCEAN_STRUCT + rwVec4(1, "h0") + rwVec4(2, "waveData") + FFT_COMMON + SPECTRUM + /* wgsl */`
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	let x = i32( gid.x ); let y = i32( gid.y ); let c = i32( gid.z );
	let idx = c * ${N * N} + y * ${N} + x;

	let L = ocean.sizes[ c ].x;
	let dk = TWO_PI / L;
	let kx = f32( x - ${HALF} ) * dk;
	let kz = f32( y - ${HALF} ) * dk;
	let kLen = length( vec2f( kx, kz ) );

	var outH = vec4f( 0.0 );
	var outW = vec4f( kx, kz, 0.0, 0.0 );

	if ( kLen >= ocean.cuts[ c ].x && kLen <= ocean.cuts[ c ].y ) {
		let omega = dispersion( kLen );
		let dOmega = dispersionDerivative( kLen );
		let theta = atan2( kz, kx );

		let sa0 = ocean.sysA[ 0 ]; let sb0 = ocean.sysB[ 0 ];
		let sa1 = ocean.sysA[ 1 ]; let sb1 = ocean.sysB[ 1 ];

		let S0 = jonswap( omega, sa0, sb0 ) * directionSpectrum( theta, omega, sa0, sb0 ) * shortWavesFade( kLen, sb0 );
		let S1 = jonswap( omega, sa1, sb1 ) * directionSpectrum( theta, omega, sa1, sb1 ) * shortWavesFade( kLen, sb1 );
		let S = max( S0 + S1, 0.0 );

		// E|h0|^2 = S(k) dk^2 / 2 so that var(height) = sum S(k) dk^2 (h has both +k and -k terms)
		let amp = sqrt( S * abs( dOmega ) / kLen * dk * dk ) * 0.5;

		// gaussian random pair (Box-Muller)
		let seed = u32( idx ) * 4u + ocean.seed * 7919u;
		let u1 = fftToUnit( fftPcg( seed ) );
		let u2 = fftToUnit( fftPcg( seed + 1u ) );
		let r = sqrt( log( u1 ) * -2.0 );
		let g0 = r * cos( u2 * TWO_PI );
		let g1 = r * sin( u2 * TWO_PI );

		outH = vec4f( g0 * amp, g1 * amp, 0.0, 0.0 );
		outW = vec4f( kx, kz, 1.0 / kLen, omega );
	}

	h0[ idx ] = outH;
	waveData[ idx ] = outW;
}`, [16, 16, 1]));

    const conj = pipe("OceanPro Conjugate", wg(rwVec4(1, "h0") + rwVec4(2, "tmp") + /* wgsl */`
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	let x = i32( gid.x ); let y = i32( gid.y ); let c = i32( gid.z );
	let base = c * ${N * N};
	let idx = base + y * ${N} + x;
	let xm = ( ${N} - x ) % ${N};
	let ym = ( ${N} - y ) % ${N};
	let idxm = base + ym * ${N} + xm;
	let hm = h0[ idxm ].xy;
	let cur = h0[ idx ].xy;
	tmp[ idx ] = vec4f( cur.x, cur.y, hm.x, - hm.y );
}`, [16, 16, 1]));

    const copyH0 = pipe("OceanPro Copy H0", wg(rwVec4(1, "h0") + rwVec4(2, "tmp") + rwF32(3, "foam") + /* wgsl */`
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	let idx = gid.z * ${N * N}u + gid.y * ${N}u + gid.x;
	h0[ idx ] = tmp[ idx ];
	foam[ idx ] = 0.0;
}`, [16, 16, 1]));

    // ---------- IFFT ----------
    const stages = butterflyStages();
    const SHARED = `var<workgroup> fftShared: array<vec4f, ${N * 2}>;\n`;

    const rows = pipe("OceanPro FFT Rows", wg(COMMON + OCEAN_STRUCT + rwVec4(1, "h0") + rwVec4(2, "waveData") + rwVec4(3, "tmp") + FFT_COMMON + SHARED + /* wgsl */`
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let t = lid.x;
	let row = wid.x;
	let c = wid.y;
	let base = c * ${N * N}u + row * ${N}u;
	let time = ocean.time;

	for ( var e = 0u; e < 2u; e++ ) {
		let x = t + e * FFT_HALF;
		let idx = base + x;
		let w = waveData[ idx ];
		let hv = h0[ idx ];
		let ph = w.w * time;
		let cs = cos( ph ); let sn = sin( ph );

		// h = h0 * e^{i w t} + conj(h0(-k)) * e^{-i w t}
		let hr = hv.x * cs - hv.y * sn + hv.z * cs + hv.w * sn;
		let hi = hv.x * sn + hv.y * cs - hv.z * sn + hv.w * cs;

		let kx = w.x; let kz = w.y; let ik = w.z;
		let fx = kx * ik; let fz = kz * ik;

		// Dx_hat = i kx/k h, Dz_hat = i kz/k h  ->  c0 = Dx + i Dz
		let c0 = vec2f( - ( fx * hi + fz * hr ), fx * hr - fz * hi );
		// c1 = Dy + i dDx/dz,  dDx/dz_hat = -kx kz / k h
		let q = - ( kx * kz * ik );
		let c1 = vec2f( hr - q * hi, hi + q * hr );
		// c2 = dDy/dx + i dDy/dz
		let c2 = vec2f( - ( kx * hi + kz * hr ), kx * hr - kz * hi );
		// c3 = dDx/dx + i dDz/dz
		let a = - ( kx * kx * ik ); let b = - ( kz * kz * ik );
		let c3 = vec2f( a * hr - b * hi, a * hi + b * hr );

		let r = fftBitReverse8( x ) * 2u;
		fftShared[ r ] = vec4f( c0, c1 );
		fftShared[ r + 1u ] = vec4f( c2, c3 );
	}

	workgroupBarrier();
${stages}

	for ( var e = 0u; e < 2u; e++ ) {
		let x = t + e * FFT_HALF;
		let o = ( base + x ) * 2u;
		tmp[ o ] = fftShared[ x * 2u ];
		tmp[ o + 1u ] = fftShared[ x * 2u + 1u ];
	}
}`, [HALF, 1, 1]));

    const cols = pipe("OceanPro FFT Columns", wg(COMMON + OCEAN_STRUCT + rwVec4(1, "tmp") + rwF32(2, "foam") + rwVec4(3, "mipSrc")
      + outTex(4, "dispOut") + outTex(5, "derivOut") + FFT_COMMON + SHARED + /* wgsl */`
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let t = lid.x;
	let col = wid.x;
	let c = wid.y;
	let base = c * ${N * N}u;

	for ( var e = 0u; e < 2u; e++ ) {
		let y = t + e * FFT_HALF;
		let idx = base + y * ${N}u + col;
		let r = fftBitReverse8( y ) * 2u;
		fftShared[ r ] = tmp[ idx * 2u ];
		fftShared[ r + 1u ] = tmp[ idx * 2u + 1u ];
	}

	workgroupBarrier();
${stages}

	let lambda = ocean.choppiness;
	for ( var e = 0u; e < 2u; e++ ) {
		let y = t + e * FFT_HALF;
		let idx = base + y * ${N}u + col;
		let sign = select( -1.0, 1.0, ( ( col + y ) & 1u ) == 0u );
		let A = fftShared[ y * 2u ] * sign;
		let B = fftShared[ y * 2u + 1u ] * sign;

		let Dx = A.x; let Dz = A.y; let Dy = A.z; let Dxz = A.w;
		let Dyx = B.x; let Dyz = B.y; let Dxx = B.z; let Dzz = B.w;

		let jxx = lambda * Dxx + 1.0;
		let jzz = lambda * Dzz + 1.0;
		let jxz = lambda * Dxz;
		let J = jxx * jzz - jxz * jxz;

		// Persistent foam: generated where the surface compresses (J < bias),
		// then slowly decays so whitecaps leave trailing foam patches.
		let prev = foam[ idx ];
		let gen = sat( ( ocean.foamBias - J ) * ocean.foamGain );
		let f = prev * exp( - ocean.foamDecay * ocean.dt ) + gen * ocean.foamAdd * ocean.dt; // PORT: ocean.dt (frame.dt)
		let fNew = clamp( max( f, gen * 0.5 ), 0.0, 1.5 );
		foam[ idx ] = fNew;

		let uv = vec2u( col, y );
		let vDisp = vec4f( lambda * Dx, Dy, lambda * Dz, fNew );
		let vDeriv = vec4f( Dyx, Dyz, lambda * Dxx, lambda * Dzz );
		textureStore( dispOut, uv, c, vDisp );
		textureStore( derivOut, uv, c, vDeriv );
		mipSrc[ idx * 2u ] = vDisp;
		mipSrc[ idx * 2u + 1u ] = vDeriv;
	}
}`, [HALF, 1, 1]));

    // ---- mip chains in compute (Tidewater: instead of 2 textures x 4 layers x 8 levels of render passes)
    // PORT: split 4 + 4 levels, not Tidewater's 5 + 3. Its kernel A writes 5 storage textures, and
    // three's device keeps WebGPU's default limit of 4 per stage (Tidewater requests 8).
    // A: 16x16 threads per 32x32 texel tile of level 0 -> levels 1..4 through workgroup memory
    // B: one 16x16 workgroup per layer -> levels 5..8 from the 16x16 level 4
    const reduce = (from, to, width, lvl, t) => {
      const w2 = width * 2;
      let dst = "";
      if (to) dst = `${to}[ ly * ${width}u + lx ] = v;`;
      if (lvl === 4) dst += `mipMid[ ( c * 256u + ( gy * 2u + ly ) * 16u + gx * 2u + lx ) * 2u + ${t}u ] = v;`;
      return /* wgsl */`
	if ( lx < ${width}u && ly < ${width}u ) {
		let i = ly * ${2 * w2}u + lx * 2u;
		let v = ( ${from}[ i ] + ${from}[ i + 1u ] + ${from}[ i + ${w2}u ] + ${from}[ i + ${w2 + 1}u ] ) * 0.25;
		textureStore( out${lvl}, vec2u( gx * ${width}u + lx, gy * ${width}u + ly ), c, v );
		${dst}
	}`;
    };
    const mipA = (t) => pipe("OceanPro Mips A", wg(rwVec4(1, "mipSrc") + rwVec4(2, "mipMid")
      + outTex(3, "out1") + outTex(4, "out2") + outTex(5, "out3") + outTex(6, "out4") + /* wgsl */`
var<workgroup> s1: array<vec4f, 256>;
var<workgroup> s2: array<vec4f, 64>;
var<workgroup> s3: array<vec4f, 16>;
fn src( c: u32, x: u32, y: u32 ) -> vec4f { return mipSrc[ ( c * ${N * N}u + y * ${N}u + x ) * 2u + ${t}u ]; }
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let lx = lid.x; let ly = lid.y;
	let gx = wid.x; let gy = wid.y; let c = wid.z;
	let x1 = gx * 16u + lx; let y1 = gy * 16u + ly;
	let x0 = x1 * 2u; let y0 = y1 * 2u;
	let v1 = ( src( c, x0, y0 ) + src( c, x0 + 1u, y0 ) + src( c, x0, y0 + 1u ) + src( c, x0 + 1u, y0 + 1u ) ) * 0.25;
	textureStore( out1, vec2u( x1, y1 ), c, v1 );
	s1[ ly * 16u + lx ] = v1;
	workgroupBarrier();
${reduce("s1", "s2", 8, 2, t)}
	workgroupBarrier();
${reduce("s2", "s3", 4, 3, t)}
	workgroupBarrier();
${reduce("s3", null, 2, 4, t)}
}`, [16, 16, 1]));
    const mipB = (t) => pipe("OceanPro Mips B", wg(rwVec4(1, "mipMid") + outTex(2, "out5") + outTex(3, "out6") + outTex(4, "out7") + outTex(5, "out8") + /* wgsl */`
var<workgroup> s4: array<vec4f, 256>;
var<workgroup> s5: array<vec4f, 64>;
var<workgroup> s6: array<vec4f, 16>;
var<workgroup> s7: array<vec4f, 4>;
@compute @workgroup_size( WG_X, WG_Y, WG_Z )
fn main( @builtin( local_invocation_id ) lid: vec3u, @builtin( workgroup_id ) wid: vec3u ) {
	let lx = lid.x; let ly = lid.y; let c = wid.z;
	let gx = 0u; let gy = 0u;
	s4[ ly * 16u + lx ] = mipMid[ ( c * 256u + ly * 16u + lx ) * 2u + ${t}u ];
	workgroupBarrier();
${reduce("s4", "s5", 8, 5, t)}
	workgroupBarrier();
${reduce("s5", "s6", 4, 6, t)}
	workgroupBarrier();
${reduce("s6", "s7", 2, 7, t)}
	workgroupBarrier();
${reduce("s7", null, 1, 8, t)}
}`, [16, 16, 1]));

    const L = (tex, l) => this._levelView(tex, l);
    const texs = [this.displacementTexture, this.derivativeTexture];
    const mipAPipes = [mipA(0), mipA(1)];
    const mipBPipes = [mipB(0), mipB(1)];
    this._k = {
      init: { p: init, g: group(init, [U, B(1, this.h0), B(2, this.waveData)]) },
      conj: { p: conj, g: group(conj, [B(1, this.h0), B(2, this.tmp)]) },
      copyH0: { p: copyH0, g: group(copyH0, [B(1, this.h0), B(2, this.tmp), B(3, this.foam)]) },
      rows: { p: rows, g: group(rows, [U, B(1, this.h0), B(2, this.waveData), B(3, this.tmp)]) },
      cols: {
        p: cols, g: group(cols, [U, B(1, this.tmp), B(2, this.foam), B(3, this.mipSrc),
          T(4, L(this.displacementTexture, 0)), T(5, L(this.derivativeTexture, 0))]),
      },
      mipA: texs.map((tex, i) => ({
        p: mipAPipes[i], g: group(mipAPipes[i], [B(1, this.mipSrc), B(2, this.mipMid),
          T(3, L(tex, 1)), T(4, L(tex, 2)), T(5, L(tex, 3)), T(6, L(tex, 4))]),
      })),
      mipB: texs.map((tex, i) => ({
        p: mipBPipes[i], g: group(mipBPipes[i], [B(1, this.mipMid), T(2, L(tex, 5)), T(3, L(tex, 6)), T(4, L(tex, 7)), T(5, L(tex, 8))]),
      })),
    };
    void C;
  }

  /** Advance the sea by dt (s) and run this frame's FFT + mips. */
  update(dt) {
    const C = this.cascades;
    this.time += dt * this.timeScale;
    this._writeUniforms(Math.max(dt, 1e-4));
    const enc = this.device.createCommandEncoder({ label: "oceanpro fft" });
    const pass = enc.beginComputePass({ label: "OceanPro FFT" });
    const run = (k, x, y, z) => { pass.setPipeline(k.p); pass.setBindGroup(0, k.g); pass.dispatchWorkgroups(x, y, z); };
    const K = this._k;
    if (this.needsSpectrum) {
      this.needsSpectrum = false;
      run(K.init, N / 16, N / 16, C);
      run(K.conj, N / 16, N / 16, C);
      run(K.copyH0, N / 16, N / 16, C);
    }
    run(K.rows, N, C, 1);
    run(K.cols, N, C, 1);
    for (const k of K.mipA) run(k, N / 32, N / 32, C);
    for (const k of K.mipB) run(k, 1, 1, C);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  dispose() {
    for (const b of [this.uniformBuffer, this.h0, this.waveData, this.tmp, this.foam, this.mipSrc, this.mipMid]) b.destroy();
    this.displacementTexture.dispose();
    this.derivativeTexture.dispose();
  }
}
