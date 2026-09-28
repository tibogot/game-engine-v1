// OCEAN PRO — the shore simulation and the surf lace (part of the "pro" ocean mode, v3/render/oceanpro/).
// Ports of Tidewater's ocean/ShoreSim.js and the lace texture of ocean/SurfFoam.js (MIT, Copyright (c)
// 2026 DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE). The WGSL and the lace
// generator are Tidewater's; changes are marked `// PORT:`.
//
// Eulerian state around the surf, updated every frame on the GPU:
//   r = foam carried by the water (made by the bore roller, the plunge point and the swash front;
//       advected with the actual flow: bores, uprush, backwash; thinned where the flow spreads it out)
//   g = sand wetness (1 while covered, dries over ~half a minute)
//   b = foam stranded on the sand when the water drains away (pops over a few seconds)
//   a = depth-averaged flow speed along the local wave direction (m/s): carries the foam pattern
//       (SurfFoam flow map) and gives the divergence that thins the foam
//
// PORT:
//  - Tidewater simulates one fixed region over its main beach. Here the window FOLLOWS THE CAMERA (it
//    re-centres in whole texels, and the state is carried along with the shift), so any coast works.
//  - a raw WebGPU compute pipeline on three's device (as the FFT), reading the textures three owns
//    (the heightmap, the shore field, the state) and writing the state three's materials read
//  - no spray deposits (the spray comes with the breakers' thrown lip)
//  - "far from the surf" tests the ground against the SEA LEVEL (Tidewater's sea is at 0)

import * as THREE from "three/webgpu";
import { wgsl } from "three/tsl";
import { shoreCode } from "./oceanproShore.js";
import { SHARED_WGSL } from "./oceanproShader.js";

export const LACE_TILE = 3.5; // metres per tile of the lace texture

// ------------------------------------------------------------------ the lace texture (CPU, once)

/**
 * Tileable lace texture (Tidewater SurfFoam.makeLaceTexture; generated once on the CPU, with CPU mipmaps)
 *   R: distance to the nearest bubble strand (0 on a strand, 1 in the middle of a hole)
 *   G: small bubbles clustered along the strands
 *   B: soft mottling (foam density variation)
 *   A: per-cell random value (staggers when stranded foam pops)
 * PORT: two three DataTextures — `tex` (linear, mipmapped, repeat) and `nearest` (read with loads).
 */
let cachedLace = null;
export function makeLaceTexture(size = 512) {
  if (cachedLace) return cachedLace;
  const t0 = performance.now();
  const data = laceData(size);
  const mips = [{ data, width: size, height: size }];
  let src = data, s = size;
  while (s > 1) {
    const h = s >> 1;
    const dst = new Uint8Array(h * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) for (let c = 0; c < 4; c++) {
      const a = src[((2 * y) * s + 2 * x) * 4 + c], b = src[((2 * y) * s + 2 * x + 1) * 4 + c];
      const d = src[((2 * y + 1) * s + 2 * x) * 4 + c], e = src[((2 * y + 1) * s + 2 * x + 1) * 4 + c];
      dst[(y * h + x) * 4 + c] = (a + b + d + e + 2) >> 2;
    }
    mips.push({ data: dst, width: h, height: h });
    src = dst;
    s = h;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = "oceanpro surf lace";
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  const nearest = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  nearest.name = "oceanpro surf lace (nearest)";
  nearest.magFilter = nearest.minFilter = THREE.NearestFilter;
  nearest.generateMipmaps = false;
  nearest.needsUpdate = true;
  cachedLace = { tex, nearest, size, ms: performance.now() - t0 };
  return cachedLace;
}

function laceData(size) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, s) => {
    let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const vnoise = (x, y, n, s) => {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const w = (a) => ((a % n) + n) % n;
    const a = hash(w(i), w(j), s), b = hash(w(i + 1), w(j), s);
    const c = hash(w(i), w(j + 1), s), d = hash(w(i + 1), w(j + 1), s);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  };
  const fbm = (x, y, n, s, oct = 3) => {
    let v = 0, a = 0.5, t = 0;
    for (let o = 0; o < oct; o++) {
      v += vnoise(x * (1 << o), y * (1 << o), n * (1 << o), s + o * 17) * a;
      t += a;
      a *= 0.5;
    }
    return v / t;
  };
  // Voronoi F1, F2 and nearest cell id on an n x n periodic jittered grid (coordinates in cells)
  const voronoi = (x, y, n, s) => {
    const i = Math.floor(x), j = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ci = i + di, cj = j + dj;
      const wi = ((ci % n) + n) % n, wj = ((cj % n) + n) % n;
      const px = ci + 0.15 + 0.7 * hash(wi, wj, s), py = cj + 0.15 + 0.7 * hash(wi, wj, s + 1);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1; f1 = d; id = hash(wi, wj, s + 2);
      } else if (d < f2) f2 = d;
    }
    return [f1, f2, id];
  };
  const sstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  // pass 1: warped coordinates and the contour noise at every texel
  const N = size * size;
  const UU = new Float32Array(N), VV = new Float32Array(N), NC = new Float32Array(N);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const u = (px + 0.5) / size, v = (py + 0.5) / size;
    // two-level domain warp: organic, curvy strands
    const w1x = (fbm(u * 3, v * 3, 3, 3) - 0.5) * 0.16, w1y = (fbm(u * 3 + 5.2, v * 3 + 1.3, 3, 7) - 0.5) * 0.16;
    const w2x = (fbm((u + w1x) * 9, (v + w1y) * 9, 9, 13) - 0.5) * 0.07, w2y = (fbm((u + w1x) * 9 + 2.7, (v + w1y) * 9, 9, 17) - 0.5) * 0.07;
    const k = py * size + px;
    UU[k] = u + w1x + w2x;
    VV[k] = v + w1y + w2y;
    NC[k] = fbm(UU[k] * 6, VV[k] * 6, 6, 91, 3);
  }

  // pass 2: distance to the nearest strand
  const N1 = 16, half = 0.5 / N1;
  const D = new Float32Array(N);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const u = (px + 0.5) / size, v = (py + 0.5) / size;
    const k = py * size + px;
    const uu = UU[k], vv = VV[k];
    // strands 1: edges of a warped cell network (distance to the edge ~ (F2 - F1) / 2, in cells)
    const [a1, b1, id1] = voronoi(uu * N1, vv * N1, N1, 11);
    const dCells = (b1 - a1) * 0.5 / N1;
    // strands 2: contour loops of the warped noise; distance ~ |n - c| / |grad n| (texture units)
    const n1 = NC[k];
    const xl = (px + size - 1) % size, xr = (px + 1) % size, yd = (py + size - 1) % size, yu = (py + 1) % size;
    const gx = (NC[py * size + xr] - NC[py * size + xl]) * size * 0.5;
    const gy = (NC[yu * size + px] - NC[yd * size + px]) * size * 0.5;
    const g = Math.max(Math.hypot(gx, gy), 0.5);
    const dLoops = Math.min(Math.abs(n1 - 0.5), Math.abs(n1 - 0.36), Math.abs(n1 - 0.64)) / g;
    // normalised by half a cell: 0 on a strand, ~1 in the middle of a hole. Irregular hole edges
    // (fine noise) and places where the strands break up (gaps).
    const hi = fbm(u * 24, v * 24, 24, 5, 2);
    const gap = sstep(0.52, 0.36, fbm(u * 10 + 3.1, v * 10, 10, 31));
    const d = Math.min(dCells * 1.35 + 0.004, dLoops) / half * (0.75 + 0.5 * hi) + gap * 0.22;
    const mott = fbm(u * 3, v * 3, 3, 71, 4);
    // bubbles: small dots, clustered near the strands
    const N3 = 120;
    const [a3, , id3] = voronoi(u * N3, v * N3, N3, 61);
    const rad = 0.1 + 0.22 * id3;
    const dot = sstep(rad, rad * 0.35, a3) * (id3 > 0.45 ? 1 : 0);
    const bub = dot * (0.25 + 0.75 * sstep(0.5, 0.1, d));
    D[k] = Math.min(1, d);
    data[k * 4 + 1] = Math.round(Math.min(1, bub) * 255);
    data[k * 4 + 2] = Math.round(mott * 255);
    data[k * 4 + 3] = Math.round(id1 * 255);
  }

  // pass 3: rounded holes: blurred distance inside the holes, the exact one near the strands
  const D0 = new Float32Array(D);
  const T = new Float32Array(N);
  for (let it = 0; it < 2; it++) {
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      let s = 0;
      for (let o = -2; o <= 2; o++) s += D[py * size + ((px + o + size) % size)];
      T[py * size + px] = s / 5;
    }
    for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
      let s = 0;
      for (let o = -2; o <= 2; o++) s += T[((py + o + size) % size) * size + px];
      D[py * size + px] = s / 5;
    }
  }
  for (let k = 0; k < N; k++) data[k * 4] = Math.round((D0[k] + (D[k] - D0[k]) * sstep(0.12, 0.45, D0[k])) * 255);
  return data;
}

// ------------------------------------------------------------------ material-side WGSL

/**
 * Tidewater's shoreSim module for the water shader. PORT: the state and the nearest lace are
 * parameters; the region ( min.xy, size ) is a private copy (shoreSimLoad, from opLoad).
 */
export function shoreSimMaterialCode(res, laceN) {
  return /* wgsl */`
const SHORE_SIM_RES: f32 = ${res}.0;
const SHORE_SIM_LACE_TILE: f32 = ${LACE_TILE};
struct OpShoreSimParams { min: vec2f, size: f32, on: f32 };
var<private> shoreSimP: OpShoreSimParams;
fn shoreSimLoad( a: vec4f ) { shoreSimP.min = a.xy; shoreSimP.size = a.z; shoreSimP.on = a.w; }

fn shoreSimUvOf( xz: vec2f ) -> vec2f {
	return ( xz - shoreSimP.min ) / shoreSimP.size;
}

fn shoreSimInside( uv: vec2f ) -> f32 {
	return smoothstep( 0.0, 0.02, uv.x ) * smoothstep( 1.0, 0.98, uv.x ) * smoothstep( 0.0, 0.02, uv.y ) * smoothstep( 1.0, 0.98, uv.y ) * shoreSimP.on;
}

// bilinear state at texture coordinate uv, from 4 loads
fn shoreSimStateAt( uv: vec2f, shoreSimStateTex: texture_2d<f32> ) -> vec4f {
	let fp = clamp( uv * SHORE_SIM_RES - 0.5, vec2f( 0.0 ), vec2f( SHORE_SIM_RES - 1.001 ) );
	let i = vec2i( floor( fp ) );
	let t = fract( fp );
	let a = textureLoad( shoreSimStateTex, i, 0 );
	let b = textureLoad( shoreSimStateTex, i + vec2i( 1, 0 ), 0 );
	let c = textureLoad( shoreSimStateTex, i + vec2i( 0, 1 ), 0 );
	let d = textureLoad( shoreSimStateTex, i + vec2i( 1, 1 ), 0 );
	return mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y );
}

// raw state (foam, wetness, residue amount, flow speed), faded out at the region border
fn shoreSimSample( xz: vec2f, shoreSimStateTex: texture_2d<f32> ) -> vec4f {
	let uv = shoreSimUvOf( xz );
	var out = vec4f( 0.0 );
	if ( uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 && shoreSimP.on > 0.5 ) {
		out = shoreSimStateAt( uv, shoreSimStateTex ) * shoreSimInside( uv );
	}
	return out;
}
`;
}

// ------------------------------------------------------------------ the simulation (raw compute)

/**
 * @param {THREE.WebGPURenderer} renderer
 * @param {object} o  size (m, the window), res (texels)
 */
export class OceanProShoreSim {
  constructor(renderer, { size = 380, res = 768 } = {}) {
    this.renderer = renderer;
    this.device = renderer.backend.device;
    this.size = size;
    this.res = res;
    this.params = { dryTime: 28, foamLife: 4.5, surfFoamLife: 2.6, residueLife: 5.0, foamGen: 1.0 };
    this.min = new THREE.Vector2(-size / 2, -size / 2);
    this.prevMin = this.min.clone();
    this.lace = makeLaceTexture();
    renderer.initTexture(this.lace.tex);

    // nearest + read with loads everywhere (manual bilinear): no sampler binding in any material
    const make = (name) => {
      const t = new THREE.StorageTexture(res, res);
      t.name = name;
      t.type = THREE.HalfFloatType;
      t.format = THREE.RGBAFormat;
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      renderer.initTexture(t);
      return t;
    };
    this.stateA = make("oceanpro shore state A"); // read by materials
    this.stateB = make("oceanpro shore state B"); // written by the sim

    this._ubo = new Float32Array(40);
    this.uniformBuffer = this.device.createBuffer({ label: "oceanpro shore sim", size: this._ubo.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.laceSampler = this.device.createSampler({ addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    this._build();
    this._bindRefs = null;
    this._bind = null;
    this._cleared = false;
    this.material = shoreSimMaterialCode(res, this.lace.size);
  }

  _build() {
    const res = this.res;
    // PORT: the frame / shore / sim blocks from one uniform array (the kernel's own copies)
    const code = /* wgsl */`
const PI: f32 = 3.141592653589793;
fn sat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }
struct OpFrame { seaLevel: f32, time: f32, dt: f32, terrainSize: f32, maxHeight: f32, heightBase: f32, zenith: f32, pad: f32 };
var<private> frame: OpFrame;
@group( 0 ) @binding( 0 ) var<uniform> U: array<vec4f, 10>;
@group( 0 ) @binding( 1 ) var terrainHeight: texture_2d<f32>;
@group( 0 ) @binding( 2 ) var shoreTex: texture_2d<f32>;
@group( 0 ) @binding( 3 ) var shoreSimStateTex: texture_2d<f32>;
@group( 0 ) @binding( 4 ) var shoreSimOut: texture_storage_2d<rgba16float, write>;
@group( 0 ) @binding( 5 ) var shoreSimLace: texture_2d<f32>;
@group( 0 ) @binding( 6 ) var smpLinearRepeat: sampler;
${SHARED_WGSL}
${shoreCode()}
const SHORE_SIM_RES: f32 = ${res}.0;
const SHORE_SIM_LACE_TILE: f32 = ${LACE_TILE};

// PORT: the state is read in the PREVIOUS window (U[6].xy), written in the current one (U[5].xy)
fn stateAtOld( p: vec2f ) -> vec4f {
	let uv = ( p - U[ 6 ].xy ) / U[ 5 ].z;
	if ( any( uv < vec2f( 0.0 ) ) || any( uv > vec2f( 1.0 ) ) ) { return vec4f( 0.0 ); }
	let fp = clamp( uv * SHORE_SIM_RES - 0.5, vec2f( 0.0 ), vec2f( SHORE_SIM_RES - 1.001 ) );
	let i = vec2i( floor( fp ) );
	let t = fract( fp );
	let a = textureLoad( shoreSimStateTex, i, 0 );
	let b = textureLoad( shoreSimStateTex, i + vec2i( 1, 0 ), 0 );
	let c = textureLoad( shoreSimStateTex, i + vec2i( 0, 1 ), 0 );
	let d = textureLoad( shoreSimStateTex, i + vec2i( 1, 1 ), 0 );
	return mix( mix( a, b, t.x ), mix( c, d, t.x ), t.y );
}

@compute @workgroup_size( 8, 8, 1 )
fn main( @builtin( global_invocation_id ) gid: vec3u ) {
	if ( gid.x >= ${res}u || gid.y >= ${res}u ) { return; }
	frame.seaLevel = U[ 0 ].x; frame.time = U[ 0 ].y; frame.dt = U[ 0 ].z; frame.terrainSize = U[ 0 ].w;
	frame.maxHeight = U[ 1 ].x; frame.heightBase = U[ 1 ].y; frame.zenith = U[ 1 ].z;
	shoreLoad( U[ 2 ], U[ 3 ], U[ 4 ] );
	let size = U[ 5 ].z;
	let dryTime = U[ 7 ].x; let foamLife = U[ 7 ].y; let surfFoamLife = U[ 7 ].z; let residueLife = U[ 7 ].w;
	let foamGen = U[ 8 ].x;

	let ij = vec2f( gid.xy );
	let uv = ( ij + 0.5 ) / SHORE_SIM_RES;
	let p = U[ 5 ].xy + uv * size;
	let ground = terrainHeightAt( p, terrainHeight );
	let depth = frame.seaLevel - ground;
	let dt = frame.dt;

	// PORT: this texel's own state, carried from the previous window position (whole-texel shifts)
	let here = stateAtOld( p );

	// far from the surf and swash zone nothing happens: just let everything decay
	// (PORT: the ground against the sea level; Tidewater's sea is at 0)
	if ( depth > 7.0 || ground - frame.seaLevel > 3.2 || shoreP.enabled <= 0.0 ) {
		let k = exp( - dt / 2.0 );
		textureStore( shoreSimOut, gid.xy, vec4f( here.x * k, here.y * exp( - dt / dryTime ), here.z * k, 0.0 ) );
		return;
	}

	let sw = shoreEvaluateWorld( p, depth, ground, terrainHeight, shoreTex );

	// fraction of this texel covered by water: open water, or the swash sheet up to its leading
	// edge (soft over one texel, so no field stored here shows the texel grid)
	let cov = select( sat( ( sw.runup - sw.inland ) / ( size / SHORE_SIM_RES ) + 0.5 ), 1.0, depth > 0.03 );
	let covered = cov > 0.5;
	let vel = select( vec2f( 0.0 ), sw.flow, covered );

	// semi-Lagrangian advection (backtrace)
	let prev = stateAtOld( p - vel * dt );

	// foam: made where the bore roller / plunge point / swash front pass, torn into patches by
	// the mottling of the lace texture, then it decays (bubbles rising and popping) and drains
	// into the sand once the water has gone
	let mott = textureSampleLevel( shoreSimLace, smpLinearRepeat, p / ( SHORE_SIM_LACE_TILE * 4.3 ), 2.0 ).z;
	let patchK = smoothstep( 0.25, 0.75, mott ) * 0.8 + 0.35;
	let swashy = smoothstep( 0.35, 0.05, depth );
	// dense foam collapses within a second or two (big bubbles burst first), the lace it leaves lingers
	let lace = mix( surfFoamLife, foamLife, swashy );
	let life = mix( 0.7, mix( lace, 0.8, smoothstep( 0.3, 0.8, prev.x ) ), cov );
	let gen = ( sw.foam * 2.2 + sw.swashFoam * 1.4 ) * patchK * cov;
	// the foam is diluted where the flow spreads it out (the uprush thinning as it climbs, the
	// backwash draining): d(foam)/dt = - foam * du/ds along the flow
	let h = size / SHORE_SIM_RES;
	let uAhead = stateAtOld( p + sw.dir * h ).w;
	let uBehind = stateAtOld( p - sw.dir * h ).w;
	let spreadRate = max( ( uAhead - uBehind ) / ( 2.0 * h ), 0.0 );
	let foam = min( prev.x * exp( - dt * ( 1.0 / life + spreadRate ) ) + gen * foamGen * dt, 1.0 );

	// wetness: saturated while covered, then dries
	let wet = max( here.y * exp( - dt / dryTime ), cov );

	// residue: foam stranded on the sand when the water leaves (the draining film gathers its
	// bubbles into lines, so it concentrates); washed away by the next uprush
	let stranded = min( here.x * 2.4, 1.0 ) * ( 1.0 - cov );
	let residue = max( here.z * mix( exp( - dt / residueLife ), 0.85, cov ), stranded );

	textureStore( shoreSimOut, gid.xy, vec4f( foam, wet, residue, dot( vel, sw.dir ) ) );
}`;
    const dev = this.device;
    this.pipeline = dev.createComputePipeline({
      label: "OceanPro Shore Sim", layout: "auto",
      compute: { module: dev.createShaderModule({ label: "oceanpro shore sim", code }), entryPoint: "main" },
    });
  }

  /**
   * Re-centre the window on `center` (world xz) in whole texels: the kernel carries the state along.
   */
  follow(center) {
    const h = this.size / this.res;
    const step = h * 16; // re-centre every 16 texels (~8 m)
    const mx = Math.round((center.x - this.size / 2) / step) * step;
    const mz = Math.round((center.y - this.size / 2) / step) * step;
    this.min.set(mx, mz);
  }

  /**
   * One step. o: dt, time, seaLevel, terrainSize, maxHeight, heightBase, flip (heightmap is an RT),
   * shore (the three shore vec4s), heightTexture, fieldTexture (three textures).
   */
  update(o) {
    const r = this.renderer;
    const gpu = (t) => r.backend.get(t)?.texture;
    const hT = gpu(o.heightTexture), fT = gpu(o.fieldTexture);
    if (!hT || !fT) return;
    const aT = gpu(this.stateA), bT = gpu(this.stateB), lT = gpu(this.lace.tex);
    if (!aT || !bT || !lT) return;
    // (three replaces a GPU texture when its three texture changes: rebind then)
    const refs = [hT, fT, aT, bT, lT];
    if (!this._bindRefs || refs.some((t, i) => t !== this._bindRefs[i])) {
      this._bindRefs = refs;
      this._bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniformBuffer } },
          { binding: 1, resource: hT.createView() },
          { binding: 2, resource: fT.createView() },
          { binding: 3, resource: aT.createView() },
          { binding: 4, resource: bT.createView() },
          { binding: 5, resource: lT.createView() },
          { binding: 6, resource: this.laceSampler },
        ],
      });
    }
    const u = this._ubo, P = this.params;
    u.set([o.seaLevel, o.time, Math.max(o.dt, 1e-4), o.terrainSize, o.maxHeight, o.heightBase, o.flip ? 1 : 0, 0], 0);
    u.set(o.shore[0], 8); u.set(o.shore[1], 12); u.set(o.shore[2], 16);
    u.set([this.min.x, this.min.y, this.size, 0], 20);
    u.set([this.prevMin.x, this.prevMin.y, 0, 0], 24);
    u.set([P.dryTime, P.foamLife, P.surfFoamLife, P.residueLife], 28);
    u.set([P.foamGen, 0, 0, 0], 32);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);
    const enc = this.device.createCommandEncoder({ label: "oceanpro shore sim" });
    const pass = enc.beginComputePass({ label: "OceanPro Shore Sim" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this._bind);
    pass.dispatchWorkgroups(Math.ceil(this.res / 8), Math.ceil(this.res / 8), 1);
    pass.end();
    enc.copyTextureToTexture({ texture: bT }, { texture: aT }, { width: this.res, height: this.res });
    this.device.queue.submit([enc.finish()]);
    this.prevMin.copy(this.min);
  }

  dispose() {
    this.uniformBuffer.destroy();
    this.stateA.dispose();
    this.stateB.dispose();
  }
}
void wgsl;
