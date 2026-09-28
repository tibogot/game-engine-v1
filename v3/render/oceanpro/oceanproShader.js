// OCEAN PRO — the sea surface and its shading (part of the "pro" ocean mode, v3/render/oceanpro/).
// Port of Tidewater's ocean/WaterSurface.js + ocean/WaterMaterial.js + ocean/SeaDetail.js' module
// (MIT, Copyright (c) 2026 DRG Software Solutions LLC — see v3/skypro-real/tidewater/LICENSE).
//
// The WGSL is Tidewater's. What changed, and why (marked `// PORT:` in the code):
//  - Tidewater's shaders see its uniform blocks (frame, ocean, waterSurface, seaDetailParams, mat) as
//    globals. Here they are `var<private>` copies filled by opLoad(), whose f32 result every entry
//    point takes first (the sky port's pattern), so the function bodies read them unchanged.
//  - Its textures and samplers are bindings of its own engine. Here they are FUNCTION PARAMETERS with
//    the same names (three binds them), threaded through the call chain: bodies unchanged,
//    signatures and call sites extended.
//  - Stage 1 is the open sea: no shore waves / swash / shore simulation / surf foam (stage 2), no wake,
//    whale, hull mask or refraction pass (the opaque scene copy is the refraction source, which is
//    Tidewater's own fallback path). Those branches are left out, not stubbed.
//  - Engine services it asked its own engine for: the sun shadow (three's shadow node, evaluated in TSL
//    and passed in), the cloud shadow (Sky Pro's map), the terrain height (our heightmap), the sky
//    (Sky Pro's environment image, or a two-colour gradient without Sky Pro).
//  - Depth: three's standard depth (0 near .. 1 far), not reversed-Z; viewDepth() goes through the
//    inverse projection, so it is unchanged.

import { wgsl, wgslFn } from "three/tsl";
import { shoreCode } from "./oceanproShore.js";

/**
 * WGSL shared by the water shader and the shore simulation's compute kernel (oceanproShoreSim.js):
 * Tidewater's perlin2 and our terrain height lookup. It reads `frame` fields (terrainSize, maxHeight,
 * heightBase, zenith = the heightmap-is-a-render-target flag); each includer defines that struct.
 */
export const SHARED_WGSL = /* wgsl */`
// ---- MaterialX gradient noise (Tidewater common: perlin2 and what it needs)
fn _mxRotl( x: u32, k: u32 ) -> u32 { return ( x << k ) | ( x >> ( 32u - k ) ); }
fn _mxFinal( a0: u32, b0: u32, c0: u32 ) -> u32 {
	var a = a0; var b = b0; var c = c0;
	c ^= b; c -= _mxRotl( b, 14u );
	a ^= c; a -= _mxRotl( c, 11u );
	b ^= a; b -= _mxRotl( a, 25u );
	c ^= b; c -= _mxRotl( b, 16u );
	a ^= c; a -= _mxRotl( c, 4u );
	b ^= a; b -= _mxRotl( a, 14u );
	c ^= b; c -= _mxRotl( b, 24u );
	return c;
}
fn mxHash2( x: i32, y: i32 ) -> u32 { let s = 0xdeadbeefu + ( 2u << 2u ) + 13u; return _mxFinal( s + u32( x ), s + u32( y ), s ); }
fn _mxGrad2( hash: u32, x: f32, y: f32 ) -> f32 {
	let h = hash & 7u;
	let u = select( y, x, h < 4u );
	let v = 2.0 * select( x, y, h < 4u );
	return select( u, - u, ( h & 1u ) != 0u ) + select( v, - v, ( h & 2u ) != 0u );
}
fn _fade3( t: vec3f ) -> vec3f { return t * t * t * ( t * ( t * 6.0 - 15.0 ) + 10.0 ); }
fn perlin2( p: vec2f ) -> f32 {
	let fl = floor( p );
	let X = i32( fl.x ); let Y = i32( fl.y );
	let fx = p.x - fl.x; let fy = p.y - fl.y;
	let u = _fade3( vec3f( fx, fy, 0.0 ) );
	let v0 = _mxGrad2( mxHash2( X, Y ), fx, fy );
	let v1 = _mxGrad2( mxHash2( X + 1, Y ), fx - 1.0, fy );
	let v2 = _mxGrad2( mxHash2( X, Y + 1 ), fx, fy - 1.0 );
	let v3 = _mxGrad2( mxHash2( X + 1, Y + 1 ), fx - 1.0, fy - 1.0 );
	let s1 = 1.0 - u.x;
	return ( ( 1.0 - u.y ) * ( v0 * s1 + v1 * u.x ) + u.y * ( v2 * s1 + v3 * u.x ) ) * 0.6616;
}

// ---- PORT: the engine services ------------------------------------------------------------
// terrain height (m) at world xz from our heightmap (uv = xz / size + 0.5, row 0 = -z), hand bilinear
// (the heightmap may be an unfilterable float texture)
// Beyond the heightmap the sea floor falls away to open-ocean depth over OP_SHELF metres (Tidewater's
// island sits in deep water; a clamped edge would make the whole outside a metre-deep flat, where the
// shallow-water attenuation rightly kills the waves).
const OP_SHELF: f32 = 400.0;
const OP_DEEP: f32 = -300.0;
fn terrainHeightAt( xz: vec2f, terrainHeight: texture_2d<f32> ) -> f32 {
	let h = terrainHeightInside( xz, terrainHeight );
	let e = abs( xz ) - vec2f( frame.terrainSize * 0.5 );
	let out = length( max( e, vec2f( 0.0 ) ) );
	return mix( h, min( h, OP_DEEP ), smoothstep( 0.0, OP_SHELF, out ) );
}
fn terrainHeightInside( xz: vec2f, terrainHeight: texture_2d<f32> ) -> f32 {
	let res = vec2i( textureDimensions( terrainHeight ) );
	var uv = clamp( xz / frame.terrainSize + 0.5, vec2f( 0.0005 ), vec2f( 0.9995 ) );
	// after a sculpt the heightmap is a render target, whose rows a raw WGSL read sees flipped
	// (three's TSL sampler flips them back): frame.zenith carries that flag
	if ( frame.zenith > 0.5 ) { uv.y = 1.0 - uv.y; }
	let st = uv * vec2f( res ) - 0.5;
	let i0 = vec2i( floor( st ) );
	let fr = fract( st );
	let m = res - 1;
	let a = textureLoad( terrainHeight, clamp( i0, vec2i( 0 ), m ), 0 ).x;
	let b = textureLoad( terrainHeight, clamp( i0 + vec2i( 1, 0 ), vec2i( 0 ), m ), 0 ).x;
	let c = textureLoad( terrainHeight, clamp( i0 + vec2i( 0, 1 ), vec2i( 0 ), m ), 0 ).x;
	let d = textureLoad( terrainHeight, clamp( i0 + vec2i( 1, 1 ), vec2i( 0 ), m ), 0 ).x;
	return mix( mix( a, b, fr.x ), mix( c, d, fr.x ), fr.y ) * frame.maxHeight + frame.heightBase;
}
// the terrain normal's xz in .xy (Tidewater terrainNormalRock: .xy = the normal's horizontal part)
fn terrainNormalRock( xz: vec2f, terrainHeight: texture_2d<f32> ) -> vec4f {
	let e = max( frame.terrainSize / f32( textureDimensions( terrainHeight ).x ), 0.25 );
	let hx = terrainHeightAt( xz + vec2f( e, 0.0 ), terrainHeight ) - terrainHeightAt( xz - vec2f( e, 0.0 ), terrainHeight );
	let hz = terrainHeightAt( xz + vec2f( 0.0, e ), terrainHeight ) - terrainHeightAt( xz - vec2f( 0.0, e ), terrainHeight );
	let n = normalize( vec3f( - hx / ( 2.0 * e ), 1.0, - hz / ( 2.0 * e ) ) );
	return vec4f( n.x, n.z, 0.0, 0.0 );
}
`;

const IOR = 1.333;
const f6 = (x) => Number(x).toFixed(6);

/**
 * @param {object} o
 * @param {import('./oceanproFFT.js').OceanProFFT} o.fft
 * @param {import('./oceanproCDLOD.js').OceanProCDLOD} o.cdlod
 * @param {number[]} [o.foamWeights]  per-cascade contribution to the foam coverage
 * @returns {{ vertexFn, fragmentFn, U_COUNT }}  wgslFn nodes (see the entry points at the end)
 */
export function buildOceanProShader({ fft, cdlod, foamWeights = [0.35, 0.45, 0.5, 0.25], depthMultisampled = false, simCode = "", surfFoam = "" }) {
  // PORT: DEPTH_T = the scene depth copy's type: the engine's post chain renders with MSAA, its
  // minimal chain without; textureLoad( t, p, 0 ) reads sample 0 of either
  const T = (s) => s.replaceAll("DEPTH_T", depthMultisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d");
  const C = fft.cascades;
  const FFT_SIZE = 256;

  // ------------------------------------------------------------------ globals + common
  // PORT: the uniform blocks as private copies (opLoad fills them), Tidewater's field names.
  const COMMON = /* wgsl */`
const PI: f32 = 3.141592653589793;
const TWO_PI: f32 = 6.283185307179586;
const INV_PI: f32 = 0.3183098861837907;
fn sat( x: f32 ) -> f32 { return clamp( x, 0.0, 1.0 ); }

struct OpFrame {
	view: mat4x4f, proj: mat4x4f, invProj: mat4x4f, invView: mat4x4f,
	cameraPos: vec3f, seaLevel: f32,
	sunDir: vec3f, windSpeed: f32,
	sunColor: vec3f, time: f32,
	skyIrradiance: vec3f, far: f32,
	horizonColor: vec3f, cameraWaterHeight: f32,
	waterAbsorption: vec3f, skyMode: f32,
	waterScattering: vec3f, zenith: f32,
	windDir: vec2f, terrainSize: f32, maxHeight: f32,
	cloud: vec4f, // PORT: Sky Pro cloud shadow map ( centre xz, size, strength )
	zenithColor: vec3f, heightBase: f32,
};
struct OpOcean { sizes: array<vec4f, 4>, foamBias: f32 };
struct OpWaterSurface { amplitude: f32, slopeScale: f32, foamCoverage: f32, foamSharpness: f32, foamScale: f32 };
struct OpSeaDetail { offset: vec2f, gustAmount: f32, slickAmount: f32, streakAmount: f32 };
struct OpMat { backscatter: f32, sss: f32, refraction: f32, foamIntensity: f32, waterRoughness: f32, reflectionStrength: f32, ssr: f32, debugMode: i32 };
var<private> frame: OpFrame;
var<private> ocean: OpOcean;
var<private> waterSurface: OpWaterSurface;
var<private> seaDetailParams: OpSeaDetail;
var<private> mat: OpMat;

// u0 ( cameraPos, seaLevel )  u1 ( sunDir, windSpeed )  u2 ( sunColor, time )  u3 ( skyIrradiance, far )
// u4 ( horizonColor, cameraWaterHeight )  u5 ( waterAbsorption, skyMode )  u6 ( waterScattering, zenith - )
// u7 ( windDir, terrainSize, maxHeight )  u8 cloud  u9 ( zenithColor, heightBase )
// u10 ( ocean.sizes[0..3].x )  u11 ( foamBias, amplitude, slopeScale, foamCoverage )
// u12 ( foamSharpness, foamScale, seaDetail.offset )  u13 ( gust, slick, streak, - )
// u14 ( backscatter, sss, refraction, foamIntensity )  u15 ( waterRoughness, reflectionStrength, ssr, debugMode )
// u16..u18: the shore waves (oceanproShore.js shoreLoad)
fn opLoad( view: mat4x4f, proj: mat4x4f, invProj: mat4x4f, invView: mat4x4f,
	u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f, u4: vec4f, u5: vec4f, u6: vec4f, u7: vec4f,
	u8: vec4f, u9: vec4f, u10: vec4f, u11: vec4f, u12: vec4f, u13: vec4f, u14: vec4f, u15: vec4f,
	u16: vec4f, u17: vec4f, u18: vec4f, u19: vec4f ) -> f32 {
	shoreLoad( u16, u17, u18 );
	shoreSimLoad( u19 );
	frame.view = view; frame.proj = proj; frame.invProj = invProj; frame.invView = invView;
	frame.cameraPos = u0.xyz; frame.seaLevel = u0.w;
	frame.sunDir = u1.xyz; frame.windSpeed = u1.w;
	frame.sunColor = u2.xyz; frame.time = u2.w;
	frame.skyIrradiance = u3.xyz; frame.far = u3.w;
	frame.horizonColor = u4.xyz; frame.cameraWaterHeight = u4.w;
	frame.waterAbsorption = u5.xyz; frame.skyMode = u5.w;
	frame.waterScattering = u6.xyz; frame.zenith = u6.w;
	frame.windDir = u7.xy; frame.terrainSize = u7.z; frame.maxHeight = u7.w;
	frame.cloud = u8;
	frame.zenithColor = u9.xyz; frame.heightBase = u9.w;
	ocean.sizes[ 0 ] = vec4f( u10.x ); ocean.sizes[ 1 ] = vec4f( u10.y ); ocean.sizes[ 2 ] = vec4f( u10.z ); ocean.sizes[ 3 ] = vec4f( u10.w );
	ocean.foamBias = u11.x;
	waterSurface.amplitude = u11.y; waterSurface.slopeScale = u11.z; waterSurface.foamCoverage = u11.w;
	waterSurface.foamSharpness = u12.x; waterSurface.foamScale = u12.y;
	seaDetailParams.offset = u12.zw;
	seaDetailParams.gustAmount = u13.x; seaDetailParams.slickAmount = u13.y; seaDetailParams.streakAmount = u13.z;
	mat.backscatter = u14.x; mat.sss = u14.y; mat.refraction = u14.z; mat.foamIntensity = u14.w;
	mat.waterRoughness = u15.x; mat.reflectionStrength = u15.y; mat.ssr = u15.z; mat.debugMode = i32( u15.w );
	return 1.0;
}

// positive view-space distance along the view axis from a depth-buffer value (Tidewater common)
fn viewDepth( d: f32 ) -> f32 {
	let v = frame.invProj * vec4f( 0.0, 0.0, d, 1.0 );
	return - v.z / v.w;
}

${SHARED_WGSL}
// Sky Pro's cloud shadow on the ground (skyproHaze hzCloudsShadow): 1 = clear
fn cloudsShadow( xz: vec2f, cloudShadow: texture_2d<f32> ) -> f32 {
	if ( frame.cloud.w <= 0.0 ) { return 1.0; }
	let L = frame.sunDir;
	let g = xz; // (the water is at sea level: no slide down the sun ray)
	let res = vec2i( textureDimensions( cloudShadow ) );
	let uv = ( g - frame.cloud.xy ) / frame.cloud.z + 0.5;
	let st = uv * vec2f( res ) - 0.5;
	let i0 = vec2i( floor( st ) );
	let fr = fract( st );
	let m = res - 1;
	let a = textureLoad( cloudShadow, clamp( i0, vec2i( 0 ), m ), 0 ).x;
	let b = textureLoad( cloudShadow, clamp( i0 + vec2i( 1, 0 ), vec2i( 0 ), m ), 0 ).x;
	let c = textureLoad( cloudShadow, clamp( i0 + vec2i( 0, 1 ), vec2i( 0 ), m ), 0 ).x;
	let d = textureLoad( cloudShadow, clamp( i0 + vec2i( 1, 1 ), vec2i( 0 ), m ), 0 ).x;
	let s = mix( mix( a, b, fr.x ), mix( c, d, fr.x ), fr.y );
	let ee = abs( uv - 0.5 );
	let inside = smoothstep( 0.5, 0.42, max( ee.x, ee.y ) );
	return mix( 1.0, s, frame.cloud.w * inside );
}
// the sky seen along a direction, without the sun disc (Tidewater skyReflectionRadiance /
// skyRadianceWithClouds): Sky Pro's environment image (sky + cumulus + cirrus), or a gradient
fn skyReflectionRadiance( dir: vec3f, skyEnv: texture_2d<f32>, skyEnvS: sampler ) -> vec3f {
	let d = normalize( dir );
	// three's equirectUV, v flipped: the image is baked through the quad's uv (skyproEnv.js), which
	// three's TSL sampler flips back; a raw WGSL read does not
	let uv = vec2f( atan2( d.z, d.x ) * ( 0.5 * INV_PI ) + 0.5, 0.5 - asin( clamp( d.y, -1.0, 1.0 ) ) * INV_PI );
	let img = textureSampleLevel( skyEnv, skyEnvS, uv, 0.0 ).rgb;
	let grad = mix( frame.horizonColor, frame.zenithColor, pow( sat( d.y ), 0.45 ) );
	return select( grad, img, frame.skyMode > 0.5 );
}
`;

  // ------------------------------------------------------------------ sea detail (SeaDetail.module)
  const SEA_DETAIL = /* wgsl */`
struct SeaDetailSample { rough: f32, gust: f32, slick: f32, streak: f32 };

// hardware bilinear, repeat-wrapped
fn seaDetailLoad( uv: vec2f, seaDetailNoise: texture_2d<f32>, smpLinearRepeat: sampler ) -> vec4f {
	return textureSampleLevel( seaDetailNoise, smpLinearRepeat, uv, 0.0 );
}

fn seaDetailSample( xz: vec2f, seaDetailNoise: texture_2d<f32>, smpLinearRepeat: sampler ) -> SeaDetailSample {
	let p = xz - seaDetailParams.offset;

	// gusts: two octaves (~600 m and ~230 m features), the second slowly morphing
	let g1 = seaDetailLoad( p / 620.0, seaDetailNoise, smpLinearRepeat ).x;
	let g2 = seaDetailLoad( p / 230.0 + vec2f( frame.time * 0.0009, 0.37 ), seaDetailNoise, smpLinearRepeat ).y;
	let gustRaw = g1 * 0.62 + g2 * 0.38;
	let gust = sat( ( gustRaw - 0.5 ) * 2.4 * seaDetailParams.gustAmount + 0.5 );

	// wind-aligned frame, lightly domain-warped so bands meander
	let w = frame.windDir;
	let along = dot( xz, w );
	let across = dot( xz, vec2f( - w.y, w.x ) ) + ( g2 - 0.5 ) * 26.0;

	// slicks: long bands, strongest in light wind, torn apart by gusts
	let sl = seaDetailLoad( vec2f( along / 1100.0, across / 70.0 ), seaDetailNoise, smpLinearRepeat ).z;
	let calmWind = smoothstep( 13.0, 4.0, frame.windSpeed );
	let slick = smoothstep( 0.64, 0.76, sl ) * ( 1.0 - gust * 0.8 ) * calmWind * seaDetailParams.slickAmount;

	// windrows: thin foam lines ~10 m apart that come and go along their length
	let st = seaDetailLoad( vec2f( along / 380.0, across / 11.0 ) + vec2f( 0.13, 0.71 ), seaDetailNoise, smpLinearRepeat ).w;
	let breakUp = seaDetailLoad( vec2f( along / 140.0, across / 40.0 ) + vec2f( 0.51, 0.29 ), seaDetailNoise, smpLinearRepeat ).x;
	let freshWind = smoothstep( 6.0, 12.0, frame.windSpeed );
	let streak = smoothstep( 0.68, 0.82, st ) * smoothstep( 0.4, 0.62, breakUp ) * freshWind * seaDetailParams.streakAmount;

	// windrows show mostly as smooth lanes (surfactant and debris collect in the convergence lines
	// and damp the ripples), with only a trace of foam
	let rough = mix( 0.5, 1.5, gust ) * ( 1.0 - slick * 0.8 ) * ( 1.0 - streak / max( seaDetailParams.streakAmount, 1e-3 ) * 0.45 );
	return SeaDetailSample( rough, gust, slick, streak );
}
`;

  // ------------------------------------------------------------------ WaterSurface: vertex
  // per-cascade amplitude attenuation in shallow water (long waves feel the bottom first)
  const d0 = [], floorAmt = [];
  for (let c = 0; c < C; c++) {
    d0.push(Math.min(40, fft.sizes[c] * 0.08));
    floorAmt.push([0.0, 0.05, 0.25, 0.5][c] ?? 0.5);
  }
  const arr = (a) => `array<f32, ${a.length}>( ${a.map((x) => x.toFixed(5)).join(", ")} )`;
  const ATTENUATION = /* wgsl */`
fn waterSurfaceCascadeAttenuation( c: i32, depth: f32 ) -> f32 {
	let d0 = ${arr(d0)};
	let floorAmt = ${arr(floorAmt)};
	let a = smoothstep( 0.0, d0[ c ], depth );
	return mix( floorAmt[ c ] * smoothstep( 0.0, 0.6, depth ), 1.0, a );
}
`;

  let cascadesV = "";
  for (let c = 0; c < C; c++) {
    const texel = fft.sizes[c] / FFT_SIZE;
    cascadesV += /* wgsl */`
	{
		// band-limit to the mesh spacing to avoid aliasing / swimming
		let level = max( log2( spacing / ${f6(texel)} ) + 0.7, 0.0 );
		let att = waterSurfaceCascadeAttenuation( ${c}, depth );
		let uv = worldXZ / ocean.sizes[ ${c} ].x;
		let s = textureSampleLevel( oceanDisplacement, smpLinearRepeat, uv, ${c}, level );
		disp += s.xyz * att;
		// foam coverage is smooth enough to evaluate per vertex (sampled at a fixed detail level,
		// the displacement sample itself from there on)
		var fv = s.w;
		if ( level < 1.5 ) { fv = textureSampleLevel( oceanDisplacement, smpLinearRepeat, uv, ${c}, 1.5 ).w; }
		foam += fv * ${f6(foamWeights[c] ?? 0.25)} * att;
	}`;
  }

  const VERTEX = /* wgsl */`
const WATER_SHORE_DEEP: f32 = 26.0; // m: ShoreWaves' envelope smoothstep( 26, 13, depth ) is 0 beyond

struct WaterSurfaceVertex {
	position: vec3f,
	lagXZ: vec2f,
	height: f32,
	depth: f32,
	foam: f32,
	shoreN: vec3f,
	shoreFoam: f32,
	swash: f32,
	surfMask: vec2f, // clear plunging face, whitewater roller relief (m)
};

// depth of the sea floor below mean sea level at xz (m)
fn waterSurfaceSeaDepth( xz: vec2f, terrainHeight: texture_2d<f32> ) -> f32 {
	return frame.seaLevel - terrainHeightAt( xz, terrainHeight );
}

// PORT: the textures as parameters (see the header); no wake
fn waterSurfaceVertex( node: vec4f, grid: vec2f, oceanDisplacement: texture_2d_array<f32>, smpLinearRepeat: sampler, terrainHeight: texture_2d<f32>, shoreTex: texture_2d<f32> ) -> WaterSurfaceVertex {
	// PORT: the CDLOD morph runs in the mesh's plane at sea level (Tidewater: y0 = 0 = its sea level)
	let lod: CdlodVertex = cdlodMorph( node, grid, frame.cameraPos, frame.seaLevel );
	let worldXZ = lod.worldXZ;
	let spacing = lod.spacing;
	let ground = terrainHeightAt( worldXZ, terrainHeight );
	let depth = frame.seaLevel - ground;

	var disp = vec3f( 0.0 );
	var foam = 0.0;
${cascadesV}

	disp *= waterSurface.amplitude;

	var extra = vec3f( 0.0 );
	var shoreN = vec3f( 0.0, 1.0, 0.0 );
	var shoreFoam = 0.0;
	var swash = 0.0;
	var surfMask = vec2f( 0.0 ); // clear plunging face, whitewater roller relief (m)
	// Offshore of WATER_SHORE_DEEP the shore waves have faded out completely (their envelope is 0 from 26 m
	// of depth, see ShoreWaves) and there is no swash: most of the sea skips their evaluation.
	// PORT: and none at all while the shore is off (no field yet)
	let nearShore = depth < WATER_SHORE_DEEP && shoreP.enabled > 0.0;
	var swashLevel = -1e4;
	if ( nearShore ) {
		let sw = shoreEvaluate( worldXZ, depth, ground, terrainHeight, shoreTex );
		extra += sw.disp;
		shoreN = clamp( sw.nShore, vec3f( -1.0 ), vec3f( 1.0 ) );
		// (the foam line on the swash front is added per pixel in the water shader: on this coarse mesh
		// it would end short of the front and follow the triangles)
		shoreFoam = sw.foam;
		surfMask = vec2f( sw.face, sw.roller );
		swashLevel = sw.swashLevel;
	}

	var total = disp + extra;
	var y = frame.seaLevel + total.y;
	if ( nearShore ) {
		// thin run-up sheet on the sand: take whichever surface is higher (smooth max)
		let k = 0.04;
		// no run-up sheet on steep rock (cliffs, sea stacks): waves break against it instead
		let nr = terrainNormalRock( worldXZ, terrainHeight );
		let gentle = smoothstep( 0.45, 0.25, length( nr.xy ) );
		let hmx = sat( ( swashLevel - y ) / k * 0.5 + 0.5 ) * gentle;
		let smax = mix( y, swashLevel, hmx ) + hmx * ( 1.0 - hmx ) * k;
		swash = smoothstep( -0.02, 0.03, swashLevel - y );
		y = smax;
		// Where the sheet is the surface it is the sheet that is seen, not the wave below it: the sheet
		// lies on the sand (the sand's slope, no horizontal wave motion, no plunging face / roller).
		shoreN = normalize( mix( shoreN, vec3f( nr.x, 1.0, nr.y ), hmx ) );
		let still = 1.0 - hmx;
		total = vec3f( total.x * still, total.y, total.z * still );
		surfMask *= still;
	}
	// hide the water sheet below dry land (beyond the swash zone)
	let below = select( ground - 0.06, min( ground - 2.0, frame.seaLevel - 1.0 ), depth < -3.0 );
	y = select( y, min( y, below ), y < ground );

	var o: WaterSurfaceVertex;
	o.position = vec3f( worldXZ.x + total.x, y, worldXZ.y + total.z );
	o.lagXZ = worldXZ;
	o.height = total.y;
	o.depth = depth;
	o.foam = foam;
	o.shoreN = shoreN;
	o.shoreFoam = shoreFoam;
	o.swash = swash;
	o.surfMask = surfMask;
	return o;
}
`;

  // ------------------------------------------------------------------ WaterSurface: fragment
  let cascadesF = "";
  for (let c = 0; c < C; c++) {
    let att = `waterSurfaceCascadeAttenuation( ${c}, depth )`;
    if (c >= C - 2) att += " * rough";
    else if (c === C - 3) att += " * mix( 1.0, rough, 0.4 )";
    // (4x anisotropy: 8x only sharpened the far grazing sea imperceptibly, at ~0.1 ms)
    cascadesF += `\td += textureSample( oceanDerivatives, smpAniso4Repeat, lagXZ / ocean.sizes[ ${c} ].x, ${c} ) * ( ${att} );\n`;
  }
  const cN = C - 1;
  const Lf = fft.sizes[cN];
  const k1 = 7.3, k2 = 3.1;
  const texel1 = Lf / k1 / FFT_SIZE, texel2 = Lf / k2 / FFT_SIZE;
  const rot = (v, a) => `vec2f( ${v}.x * ${f6(Math.cos(a))} - ${v}.y * ${f6(Math.sin(a))}, ${v}.x * ${f6(Math.sin(a))} + ${v}.y * ${f6(Math.cos(a))} )`;

  const FRAGMENT = /* wgsl */`
struct WaterSurfaceFrag {
	normal: vec3f,
	foam: f32,
	coverage: f32,
	slopes: vec2f,
	jacobian: f32,
	rough: f32,
	aeration: f32,
	gust: f32,
	slick: f32,
	foamInfo: SurfFoamInfo,
};

// PORT: textures as parameters (the shore simulation's state, the lace, the shore field too); no wake.
// PORT: Tidewater compiles every shader with diagnostic( off, derivative_uniformity ) (its Shader.js);
// three owns the module header here, so the attribute form sits on the functions that need it.
@diagnostic( off, derivative_uniformity )
// extraFoam: foam carried by the water (the shore simulation); simState: its sample here
fn waterSurfaceFragment( lagXZ: vec2f, footprint: f32, depth: f32, vertexFoam: f32, shoreN: vec3f, shoreFoam: f32, extraFoam: f32, simState: vec4f, surfMask: vec2f, P: vec3f,
	oceanDerivatives: texture_2d_array<f32>, smpAniso4Repeat: sampler, smpLinearRepeat: sampler,
	waterFoamTex: texture_2d<f32>, foamSmp: sampler, seaDetailNoise: texture_2d<f32>, detailSmp: sampler,
	surfFoamLaceTex: texture_2d<f32>, laceSmp: sampler, shoreTex: texture_2d<f32> ) -> WaterSurfaceFrag {
	var d = vec4f( 0.0 );
	var foamSum = 0.0;
	// the clear concave face of a plunging wave overhangs the trough: the foam carried by the
	// (depth-averaged, world-space) shore simulation below it is not on the face
	let face = sat( surfMask.x );
	// (some of it stays: the lace of the previous wave is drawn up the face)
	let simFoam = extraFoam * ( 1.0 - face * 0.72 );
	foamSum += simFoam;
	// bubbles mixed into the water (milky, turquoise, hides the bottom): surf and wake
	var aeration = 0.0;

	// world-space gusts / slicks modulate the short wind waves (non-repeating dark and bright patches)
	let det = seaDetailSample( lagXZ, seaDetailNoise, detailSmp );
	let rough = det.rough;

${cascadesF}
	d *= waterSurface.amplitude;
	var slopes = vec2f( d.x / max( d.z + 1.0, 0.2 ), d.y / max( d.w + 1.0, 0.2 ) );

	// Near-field capillary ripples. Within a few metres of the camera a pixel covers less than
	// the finest cascade's texel (~3 cm), so the surface looks glassy. Re-sample that cascade at
	// ~1 m and ~2.3 m tiles (rotated, so they never line up with it) wherever the footprint is
	// small. Damped in slicks with the short wind waves. Explicit LOD: this runs in a branch.
	let near = smoothstep( 0.04, 0.01, footprint ) * rough;
	if ( near > 0.002 ) {
		let c1 = textureSampleLevel( oceanDerivatives, smpLinearRepeat, ${rot("lagXZ", 0.63)} * ${f6(k1 / Lf)}, ${cN}, max( log2( footprint / ${f6(texel1)} ), 0.0 ) );
		let c2 = textureSampleLevel( oceanDerivatives, smpLinearRepeat, ${rot("lagXZ", 2.14)} * ${f6(k2 / Lf)}, ${cN}, max( log2( footprint / ${f6(texel2)} ), 0.0 ) );
		// gradients back into world axes (transpose of the rotation)
		let g1 = c1.xy; let g2 = c2.xy;
		let g = ${rot("g1", -0.63)} * 0.55 + ${rot("g2", -2.14)} * 0.35;
		slopes += g * near;
	}
	let jac = ( d.z + 1.0 ) * ( d.w + 1.0 );

	// base normal: large shoreline waves (per-vertex, can overhang) perturbed by FFT detail
	var normal: vec3f;
	var baseNormal = vec3f( 0.0, 1.0, 0.0 );
	{
		// On a coarse mesh the shore normal can flip between the vertices of a folding crest: the
		// interpolated vector then cancels out (or is NaN). Keep it finite and facing up; NaN
		// would otherwise surface as a white-hot cell after the output clamp.
		let sn = clamp( shoreN, vec3f( -1.0 ), vec3f( 1.0 ) ) + vec3f( 0.0, 1e-3, 0.0 );
		let Ns0 = sn / max( length( sn ), 1e-4 );
		let Ns = normalize( vec3f( Ns0.x, max( Ns0.y, 0.12 ), Ns0.z ) );
		baseNormal = Ns;
		// the ripples and chop ride on the wave: the detail normal is rotated onto the tilted face
		// (reoriented normal mapping) instead of being flattened by it, so a steep face keeps the
		// full texture of the sea surface rather than turning into smooth plastic
		let nd = normalize( vec3f( - slopes.x, 1.0, - slopes.y ) );
		let tq = Ns + vec3f( 0.0, 1.0, 0.0 );
		let uq = vec3f( slopes.x, 1.0, slopes.y ) * nd.y;
		normal = normalize( tq * ( dot( tq, uq ) / tq.y ) - uq );
		foamSum += shoreFoam * 0.55;
		// the roller and the water behind the plunge point are full of bubbles, decaying behind the
		// bore with the foam it sheds; the clear face of a plunging wave is not
		aeration += sat( shoreFoam * 1.2 + simFoam * 0.7 ) * ( 1.0 - face ) * smoothstep( -0.1, 0.3, depth );
	}

	// whitecaps: persistent (per vertex) + fresh where the surface is compressed right now;
	// more of them inside gusts, plus windrow lines in fresh wind
	let fresh = sat( ( ocean.foamBias - 0.15 - jac ) * 2.0 );
	var whitecaps = vertexFoam + fresh;
	whitecaps = whitecaps * mix( 0.5, 1.5, det.gust ) + det.streak * 0.5;
	let coverage = sat( ( foamSum + whitecaps ) * waterSurface.foamCoverage );

	// foam pattern: an irregular bubbly mat thresholded by coverage, so foam grows, tears into
	// lace and dissolves naturally
	let fuv = lagXZ * waterSurface.foamScale;
	let p1 = textureSample( waterFoamTex, foamSmp, fuv );
	// second layer at another scale, rotated, to break repetition
	let r2 = vec2f( fuv.x * 0.8 - fuv.y * 0.6, fuv.x * 0.6 + fuv.y * 0.8 );
	let p2 = textureSample( waterFoamTex, foamSmp, r2 * 2.37 + vec2f( 0.31, 0.77 ) );
	let pattern = p1.x * 0.62 + p2.x * 0.38;
	let thresh = 1.05 - coverage * 1.1;
	let soft = 0.06 + footprint * 0.1;
	let detail = smoothstep( thresh - soft, thresh + soft, pattern ) * ( p1.y * 0.25 + 0.8 );
	// at distance the pattern averages out -> use coverage directly
	let far = smoothstep( 0.15, 1.2, footprint );
	var foam = mix( detail, coverage * 0.85, far );

	var o: WaterSurfaceFrag;
	// foam look (surf zone whitewater / lace, see SurfFoam)
	var fa: SurfFoamArgs;
	fa.coverage = coverage; fa.foam = foam; fa.footprint = footprint; fa.depth = depth; fa.bubbles = p1.y;
	fa.lagXZ = lagXZ; fa.normal = normal; fa.baseNormal = baseNormal;
	fa.fresh = shoreFoam; fa.sim = simFoam; fa.simState = simState; fa.roller = surfMask.y; fa.P = P;
	o.foamInfo = surfFoamShading( fa, surfFoamLaceTex, laceSmp, shoreTex );
	foam = o.foamInfo.foam;
	o.normal = normal;
	o.foam = foam;
	o.coverage = coverage;
	o.slopes = slopes;
	o.jacobian = jac;
	o.rough = rough;
	o.aeration = sat( aeration );
	o.gust = det.gust;
	o.slick = det.slick;
	return o;
}
`;

  // ------------------------------------------------------------------ WaterMaterial helpers
  const HELPERS = /* wgsl */`
fn fresnelDielectric( cosI: f32, eta: f32 ) -> f32 {
	let c = clamp( cosI, 0.0, 1.0 );
	let g2 = eta * eta - 1.0 + c * c;
	let tir = g2 < 0.0;
	let g = sqrt( max( g2, 0.0 ) );
	let a = ( g - c ) / ( g + c );
	let b = ( c * ( g + c ) - 1.0 ) / ( c * ( g - c ) + 1.0 );
	return select( 0.5 * ( a * a ) * ( b * b + 1.0 ), 1.0, tir );
}

fn waterPhaseHG( cosT: f32, g: f32 ) -> f32 {
	let g2 = g * g;
	return ( ( 1.0 - g2 ) / ( 4.0 * PI ) ) / pow( max( 1.0 + g2 - cosT * 2.0 * g, 1e-4 ), 1.5 );
}

fn viewPositionFromViewZ( uv: vec2f, viewZ: f32 ) -> vec3f {
	let ndc = vec2f( uv.x * 2.0 - 1.0, ( 1.0 - uv.y ) * 2.0 - 1.0 );
	let p00 = frame.proj[ 0 ][ 0 ];
	let p11 = frame.proj[ 1 ][ 1 ];
	return vec3f( ndc.x / p00, ndc.y / p11, -1.0 ) * ( - viewZ );
}

// a refracted sample is usable when it lies this far behind the water surface (view depth, m): objects in
// front of it (the hull you stand in, pier piles) are rejected
const WATER_BEHIND: f32 = 0.05;
fn _waterDGGX( NdH: f32, a2: f32 ) -> f32 {
	let d = NdH * NdH * ( a2 - 1.0 ) + 1.0;
	return a2 / ( d * d * PI );
}
fn _waterVSmithGGX( NdL: f32, NdV: f32, a2: f32 ) -> f32 {
	let gv = NdL * sqrt( NdV * NdV * ( 1.0 - a2 ) + a2 );
	let gl = NdV * sqrt( NdL * NdL * ( 1.0 - a2 ) + a2 );
	return 0.5 / max( gv + gl, 1e-5 );
}
// depth via exact texel loads (float depth textures + filtering samplers are unreliable)
// PORT: the depth texture as a parameter; a depth texture's textureLoad is an f32 (no .x)
fn _waterSceneDepthAt( uv: vec2f, waterSceneDepth: DEPTH_T ) -> f32 {
	let size = vec2f( textureDimensions( waterSceneDepth ) );
	let p = vec2i( clamp( uv, vec2f( 0.0 ), vec2f( 0.9999 ) ) * size );
	return textureLoad( waterSceneDepth, p, 0 );
}
// linear view Z of the opaque scene for the reflection march (PORT: no half-float copy)
fn _waterSceneZAt( uv: vec2f, waterSceneDepth: DEPTH_T ) -> f32 {
	return - viewDepth( _waterSceneDepthAt( uv, waterSceneDepth ) );
}
fn _waterProject( p: vec3f ) -> vec2f {
	let clip = frame.proj * vec4f( p, 1.0 );
	let ndc = clip.xy / max( clip.w, 1e-4 );
	return vec2f( ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5 );
}

// --------------------------------------------------------------- screen-space reflection
// March the reflected ray through the opaque depth copy (view space, geometric steps, then a
// short bisection). Returns ( color, weight ): weight fades at screen edges, for rays heading
// back toward the camera and at the end of the search range.
// y0, ry: world height of the start and the ray's rise per metre. A hit beyond 260 m, or below the
// water on a descending ray, is weighted 0, so the march stops once the last miss is there.
fn _waterSSR( posV: vec3f, Rv: vec3f, y0: f32, ry: f32, waterSceneDepth: DEPTH_T, waterSceneColor: texture_2d<f32>, smpLinearClamp: sampler ) -> vec4f {
	var hit = false;
	// steps grow with the distance: far away the first ones would all land in the same pixel
	let stepScale = max( - posV.z / 60.0, 1.0 );
	var t = 0.15 * stepScale;
	var dt = 0.25 * stepScale;
	var prevT = 0.0;
	for ( var i = 0; i < 11; i++ ) {
		prevT = t;
		if ( prevT >= 260.0 || ( ry <= 0.0 && y0 + ry * prevT < frame.seaLevel - 0.2 ) ) { break; }
		t += dt;
		dt *= 1.7;
		let p = posV + Rv * t;
		let uv = _waterProject( p );
		if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || p.z > -0.1 ) { break; }
		let sz = _waterSceneZAt( uv, waterSceneDepth );
		// behind the visible surface, within a thickness covering the last step
		if ( p.z < sz && sz - p.z < max( dt * 1.3, max( t * 0.08, 0.3 ) ) ) {
			hit = true;
			break;
		}
	}

	var color = vec3f( 0.0 );
	var weight = 0.0;
	if ( hit ) {
		// refine between the last miss and the hit
		var a = prevT; var b = t;
		for ( var k = 0; k < 3; k++ ) {
			let m = ( a + b ) * 0.5;
			let p = posV + Rv * m;
			let behind = p.z < _waterSceneZAt( _waterProject( p ), waterSceneDepth );
			b = select( b, m, behind );
			a = select( m, a, behind );
		}
		let hitT = b;
		let hitV = posV + Rv * b;
		let uv = _waterProject( hitV );
		// after refining, the ray must really touch the surface there (a ray that only passed far
		// behind a thin or distant object is a false hit)
		let gap = abs( _waterSceneZAt( uv, waterSceneDepth ) - hitV.z );
		let touch = smoothstep( max( b * 0.04, 0.4 ), max( b * 0.02, 0.2 ), gap );
		// anything under the surface (seabed seen through the water, submerged hull) is not
		// visible to a reflected ray: those rays run into the next wave instead
		let hitY = ( frame.invView * vec4f( hitV, 1.0 ) ).y;
		color = textureSampleLevel( waterSceneColor, smpLinearClamp, uv, 0.0 ).rgb;
		let edge = smoothstep( 0.0, 0.06, uv.x ) * smoothstep( 1.0, 0.94, uv.x ) * smoothstep( 0.0, 0.06, uv.y ) * smoothstep( 1.0, 0.94, uv.y );
		let facing = smoothstep( 0.5, 0.1, Rv.z ); // rays toward the camera leave the screen
		weight = edge * facing * touch * smoothstep( 260.0, 120.0, hitT ) * smoothstep( frame.seaLevel - 0.15, frame.seaLevel + 0.35, hitY );
	}
	return vec4f( color, weight );
}
`;

  // ------------------------------------------------------------------ WaterMaterial shading
  // PORT: Tidewater's output snippet as a function: its `in.*` inputs are parameters, r.color the
  // return value. T (terrain) on, CL (clouds) on; SH / SIM / SF / HULL / REFL / REFRACTION off.
  const SHADE = /* wgsl */`
@diagnostic( off, derivative_uniformity )
fn waterShade( pos: vec3f, screenUV: vec2f, front: f32, lagXZ: vec2f, vHeight: f32, vDepth: f32, vFoam: f32, sunShadow: f32,
	vShoreN: vec3f, vShoreFoam: f32, vSurfMask: vec2f,
	oceanDerivatives: texture_2d_array<f32>, derivSmp: sampler,
	waterFoamTex: texture_2d<f32>, foamSmp: sampler, seaDetailNoise: texture_2d<f32>, detailSmp: sampler,
	terrainHeight: texture_2d<f32>, shoreTex: texture_2d<f32>, cloudShadow: texture_2d<f32>,
	waterSceneColor: texture_2d<f32>, smpLinearClamp: sampler, waterSceneDepth: DEPTH_T,
	skyEnv: texture_2d<f32>, skyEnvS: sampler,
	shoreSimStateTex: texture_2d<f32>, surfFoamLaceTex: texture_2d<f32>, laceSmp: sampler ) -> vec4f {
	let posV = ( frame.view * vec4f( pos, 1.0 ) ).xyz;
	// footprint of this pixel on the surface (m) — for filtering / roughness (uniform control flow)
	let footprint = max( length( fwidth( lagXZ ) ), 1e-4 );

	let toCam = frame.cameraPos - pos;
	let dist = length( toCam );
	let V = toCam / dist;
	let L = frame.sunDir;
	// the sun light reaching the surface: sun colour x shadow maps (three's direct light), x clouds
	// PORT: the shadow is three's (evaluated in TSL, passed in); no island heightfield shadow
	var sunLight = frame.sunColor * sunShadow;
	sunLight *= cloudsShadow( pos.xz, cloudShadow );

	// water film thickness at this pixel and the distance to the swash front (ShoreWaves.swashEdge):
	// the sheet ends exactly on its analytic leading edge, not on the mesh triangles
	let groundH = terrainHeightAt( pos.xz, terrainHeight );
	var thickness = pos.y - groundH;
	var frontD = 1e3;
	var swTau = 0.0;
	var swRt = 0.0;
	if ( vDepth < 1.0 ) {
		let tRaw = thickness;
		let se = shoreSwashEdge( pos.xz, thickness, terrainHeight, shoreTex );
		thickness = se.x; frontD = se.y; swTau = se.z; swRt = se.w;
		// The draining sheet has no rounded front: it thins out over decimetres and breaks up where the
		// sand drains faster. The analytic front runs parallel to the shoreline; kept as a hard, smooth
		// edge (with the uprush's meniscus, rim and contact shadow) it read as a dark line ruled along
		// the beach between the foam and the wet sand.
		let backwash = smoothstep( 0.32, 0.46, swTau );
		if ( backwash > 0.0 && swRt > 0.0 && frontD < 3.0 ) {
			frontD += ( perlin2( pos.xz * 1.1 ) * 0.35 + perlin2( pos.xz * 3.7 + vec2f( 5.3, 1.9 ) ) * 0.15 ) * backwash;
			thickness = min( tRaw, frontD * mix( 0.08, 0.025, backwash ) );
		}
	}
	// the foam line riding the swash front, per pixel: a dense bubbly bead right at the edge while
	// the sheet runs up, a thinning lace behind it; weaker in the backwash (it sinks into the sand)
	let uprush = smoothstep( 0.46, 0.32, swTau );
	let bead = smoothstep( -0.01, 0.05, frontD ) * smoothstep( 0.6, 0.12, frontD );
	let trail = smoothstep( -0.01, 0.25, frontD ) * smoothstep( 2.2, 0.3, frontD );
	// patchy along the front (dense bunches and thin stretches), not an even white rope (only where
	// the edge foam below can be non-zero: it is weighted by the run-up and the shallow depth)
	var edgePatch = 1.0;
	if ( swRt > 0.0 && vDepth < 0.4 ) {
		edgePatch = smoothstep( -0.45, 0.55, perlin2( pos.xz * 0.42 ) ) * 0.7 + smoothstep( -0.3, 0.6, perlin2( pos.xz * 1.7 + vec2f( 3.1, 7.7 ) ) ) * 0.3;
	}
	let edgeFoam = ( bead * mix( 0.45, 1.1, uprush ) * mix( 0.35, 1.0, edgePatch ) + trail * mix( 0.12, 0.4, uprush ) * edgePatch ) * smoothstep( 0.0, 1.0, swRt ) * smoothstep( 0.4, -0.2, vDepth );
	// the meniscus: the last decimetre of the advancing sheet bends down to the sand
	let lipW = ( 1.0 - smoothstep( 0.0, 0.14, frontD ) ) * uprush;

	let simState = shoreSimSample( pos.xz, shoreSimStateTex );
	let surf = waterSurfaceFragment( lagXZ, footprint, vDepth, vFoam, vShoreN, vShoreFoam + edgeFoam, simState.x, simState, vSurfMask, pos,
		oceanDerivatives, derivSmp, derivSmp, waterFoamTex, foamSmp, seaDetailNoise, detailSmp,
		surfFoamLaceTex, laceSmp, shoreTex );
	var foam = surf.foam;

	// Which medium is the view ray in before it reaches this fragment? The water surface is a closed
	// interface: a front face (its air side towards the camera) is seen from the air, a back face from
	// the water. The winding can't be trusted in folds of the choppy surface: there, and well above
	// or below the surface, the camera's own medium decides.
	let camH = frame.cameraPos.y - frame.cameraWaterHeight;
	let folded = surf.jacobian < 0.1 || normalize( vShoreN ).y < 0.35;
	let nearSurface = abs( camH ) < 1.5;
	let viewFromBelow = select( camH < 0.0, front < 0.5, nearSurface && ! folded );
	// shading normal on the viewer's side of the interface. Triangle winding can't be trusted
	// (tiny self-intersections of the choppy FFT surface render as back faces seen from above),
	// so pick the side from the camera and bend facets that face away to grazing instead of
	// flipping them (a flipped normal turns a fold into a white sky-mirror patch).
	let Nup = surf.normal;
	let Nside = select( Nup, - Nup, viewFromBelow );
	let Nview = normalize( Nside + V * max( - dot( Nside, V ) + 0.03, 0.0 ) );

	// roughness from unresolved slope variance (Cox-Munk: mss = 0.003 + 0.00512 U)
	let mss = ( 0.003 + frame.windSpeed * 0.00512 ) * waterSurface.slopeScale;
	let kpx = PI / footprint;
	let unresolved = sat( log2( 110.0 / kpx ) / 9.0 );
	let roughVar = surf.rough * surf.rough;
	let alpha2 = mat.waterRoughness * mat.waterRoughness + mss * 2.0 * unresolved * roughVar + foam * 0.2 + surf.aeration * 0.03;
	// slope spread the mesh / normal maps can't show at this distance (for the reflection)
	let sigmaUnres = sqrt( mss * unresolved * roughVar );

	var outCol = vec3f( 0.0 );
	var ssrW = 0.0;
	var dbgPath = 0.0;
	var dbgScene = vec3f( 0.0 );

	if ( ! viewFromBelow ) {

		// ================= ABOVE WATER =================
		// near the leading edge the surface bends down to meet the sand like a rounded bead
		// (meniscus), tilting the normal toward dry land
		let edgeW = max( ( 1.0 - smoothstep( 0.0, 0.006, thickness ) ) * uprush, lipW );
		let nr = terrainNormalRock( pos.xz, terrainHeight );
		let uphill = normalize( - vec2f( nr.x, nr.y ) + vec2f( 1e-5, 0.0 ) );
		let N = normalize( Nview + vec3f( uphill.x, 0.0, uphill.y ) * ( edgeW * edgeW * 0.7 ) );
		let NdV = max( dot( N, V ), 1e-4 );
		let F = fresnelDielectric( NdV, ${IOR} );

		// ---- reflection
		let Rraw = reflect( - V, N );
		// unresolved facets tilt the average reflection toward the higher, darker sky: rough
		// patches (gusts) darken toward the horizon, slicks stay bright and mirror-like
		let Rup = max( Rraw.y, 0.004 ) + sigmaUnres * 1.3 * ( 1.0 - max( Rraw.y, 0.0 ) );
		let R = normalize( vec3f( Rraw.x, Rup, Rraw.z ) );
		// reflections pointing below the horizon hit other waves: fade toward a dark sea color
		let horizonOcc = max( smoothstep( -0.12, 0.08, Rraw.y ), smoothstep( 0.25, 0.06, thickness ) );
		var skyRefl = vec3f( 0.0 );
		if ( horizonOcc > 0.0 || frontD < 0.1 ) { skyRefl = skyReflectionRadiance( R, skyEnv, skyEnvS ); }
		var reflCol = mix( frame.horizonColor * 0.35, skyRefl, horizonOcc );

		// objects (pier, boat, hills, village) reflected from the screen; only rays close to the
		// horizon can hit anything, so steep reflections skip the march entirely
		// (looking down, F is tiny: the reflection can't be seen, skip the march)
		if ( Rraw.y < 0.45 && F > 0.05 && mat.ssr > 0.5 ) {
			let Rv = normalize( ( frame.view * vec4f( Rraw, 0.0 ) ).xyz );
			// (rays toward the camera get no weight: see facing in _waterSSR)
			if ( Rv.z < 0.5 ) {
				let r = _waterSSR( posV, Rv, pos.y, Rraw.y, waterSceneDepth, waterSceneColor, smpLinearClamp );
				reflCol = mix( reflCol, r.rgb, r.a );
				ssrW = r.a;
			}
		}

		reflCol *= mat.reflectionStrength;

		// ---- sun specular (GGX), sun light already includes shadowing
		let H = normalize( L + V );
		let NdL = max( dot( N, L ), 0.0 );
		let NdH = max( dot( N, H ), 0.0 );
		let VdH = max( dot( V, H ), 0.0 );
		let Fs = fresnelDielectric( VdH, ${IOR} );
		let spec = _waterDGGX( NdH, alpha2 ) * _waterVSmithGGX( NdL, NdV, alpha2 ) * Fs * NdL;
		// physically the glint is ~1e5x brighter than the sky; clamp to stay inside fp16 range
		let sunSpec = sunLight * min( spec, 400.0 );

		// ---- refraction / water volume
		// Trace the refracted view ray (Snell) to the sea floor instead of using the straight
		// screen ray: at grazing angles the straight ray overestimates the water path ~10x.
		let Tr = refract( - V, N, 1.0 / ${IOR} );
		let Tv = normalize( vec3f( Tr.x, min( Tr.y, -0.08 ), Tr.z ) );
		let tDown = max( - Tv.y, 0.04 );
		let surfViewZ = posV.z;

		// water column below the surface along the refracted ray (terrain, 2 refinements)
		let L0 = max( pos.y - groundH, 0.0 ) / tDown;
		// deep water: the end point is capped at 80 m and the column is opaque long before, so the
		// refinements can't change the result
		var Lt = L0;
		if ( L0 < 100.0 ) {
			let L1 = max( pos.y - terrainHeightAt( pos.xz + Tv.xz * min( L0, 200.0 ), terrainHeight ), 0.0 ) / tDown;
			Lt = max( pos.y - terrainHeightAt( pos.xz + Tv.xz * min( L1 * 0.5 + L0 * 0.5, 200.0 ), terrainHeight ), 0.0 ) / tDown;
		}
		let Lter = clamp( Lt, 0.0, 400.0 );
		// thin breaking crests: the refracted ray leaves through the back of the wave into the sky
		let crestT = shoreCrestPath( lagXZ, vDepth, Tv, terrainHeight, shoreTex );
		let thruCrest = crestT < Lter;

		// project the refracted end point to the screen
		let pEnd = pos + Tv * min( Lter, 80.0 );
		let clipEnd = frame.proj * ( frame.view * vec4f( pEnd, 1.0 ) );
		let ndcEnd = clipEnd.xy / max( clipEnd.w, 1e-4 );
		let uvR = vec2f( ndcEnd.x * 0.5 + 0.5, ndcEnd.y * -0.5 + 0.5 );
		let onScreen = all( uvR > vec2f( 0.0 ) ) && all( uvR < vec2f( 1.0 ) );
		var uvF = screenUV;
		var dR = 0.0;
		var sceneCol = vec3f( 0.0 );
		// PORT: no refraction pass — Tidewater's own fallback: the opaque copy, where the refracted
		// sample lies behind the water surface, else the unrefracted pixel
		{
			let dO = _waterSceneDepthAt( uvR, waterSceneDepth );
			let valid = onScreen && surfViewZ + viewDepth( dO ) > WATER_BEHIND;
			uvF = select( screenUV, uvR, valid );
			dR = select( _waterSceneDepthAt( screenUV, waterSceneDepth ), dO, valid );
			sceneCol = textureSampleLevel( waterSceneColor, smpLinearClamp, uvF, 0.0 ).rgb;
		}
		// (a branch: select() would evaluate the sky for every pixel)
		if ( thruCrest ) { sceneCol = skyReflectionRadiance( normalize( vec3f( Tv.x, max( abs( Tv.y ), 0.03 ), Tv.z ) ), skyEnv, skyEnvS ); }

		// objects in front of the sea floor (pylons, rocks, reef) shorten the path
		let qView = viewPositionFromViewZ( uvF, - viewDepth( dR ) );
		let qDist = length( qView - posV );
		var pathLen = clamp( min( Lter, qDist ), 0.0, 400.0 );
		pathLen = min( pathLen, crestT );
		dbgPath = pathLen;
		dbgScene = sceneCol;

		// bubbles mixed into the water (the surf behind breakers, wakes): a strong scatterer
		let aer = surf.aeration;
		// sand stirred up where the bores have just passed (the foam they left marks that water):
		// clouds of sediment, not a uniform tint
		let sandK = sat( simState.x * 2.5 ) * 1.8 + 0.45;
		// surf zone: sand and bubbles stirred up by the breakers (see ShoreWaves.surfMedium)
		let surfMed = shoreSurfMedium( pos.xz, vDepth, shoreTex );
		let sigA = frame.waterAbsorption + surfMed.absorb * sandK;
		// (bubble plumes are shallow and patchy: a moderate scatterer, milky turquoise rather than a glow)
		let sigS = frame.waterScattering + surfMed.scatter * sandK + aer * 1.6;
		let sigT = sigA + sigS;

		// refracted sun direction
		let Ls = - refract( - L, vec3f( 0.0, 1.0, 0.0 ), 1.0 / ${IOR} ); // toward the sun from underwater
		let muS = max( Ls.y, 0.1 );
		let muV = max( - Tv.y, 0.15 );

		let Tview = exp( - sigT * pathLen );

		// in-scattered light along the view ray (single scattering sun + ambient), analytic
		// light at depth z: E0 * exp(-sigT * z / mu). Along the view ray z = s * muV.
		let sunIn = sunLight * ( 1.0 - fresnelDielectric( max( L.y, 0.02 ), ${IOR} ) );
		let kSun = sigT * ( 1.0 + muV / muS );
		let kAmb = sigT * ( 1.0 + muV / 0.75 );
		let cosPh = dot( Tv, Ls );
		let phase = waterPhaseHG( cosPh, 0.86 ) * 0.7 + ${(0.3 / (4 * Math.PI)).toFixed(8)};
		let bb = sigS * mix( mat.backscatter, 0.06, sat( aer * 2.0 ) );
		// multiple-scattering boosted backscatter (Gordon R = 0.33 bb/(a+bb))
		let albedoMS = bb * ( 0.33 * 4.0 ) / ( sigA + bb );
		let inSun = sunIn * ( sigS * phase + albedoMS * sigT * INV_PI ) * ( 1.0 - exp( - kSun * pathLen ) ) / kSun;
		let inAmb = frame.skyIrradiance * ( sigS * 0.25 + albedoMS * sigT ) * ( 1.0 - exp( - kAmb * pathLen ) ) / kAmb;

		// crest translucency (sun shining through thin wave tips)
		let vH = normalize( vec2f( V.x, V.z ) );
		let lH = normalize( vec2f( L.x, L.z ) + 1e-5 );
		// (light entering the top and back of a thin crest scatters out of the face over a broad lobe:
		// side-lit waves glow green too, not only when looking straight into the sun)
		let back = pow( sat( dot( vH, - lH ) * 0.6 + 0.4 ), 2.5 );
		let crest = sat( vHeight * 0.9 + 0.1 ) * ( sat( ( 1.0 - N.y ) * 4.0 ) + 0.25 );
		let sssCol = vec3f( 0.12, 0.55, 0.45 ) * 0.06;
		let sss = sunLight * sssCol * back * crest * mat.sss * smoothstep( 0.0, 0.25, L.y );

		let transmitted = sceneCol * Tview * ( 1.0 - 0.3 * lipW ) + inSun + inAmb + sss;

		// ---- foam
		// foam: bright diffuse scatterer (albedo ~0.85), wrapped sun + sky irradiance (skyIrradiance = E/PI)
		let foamLit = surfFoamLight( surf.foamInfo, N, L, V, sunLight, pos );
		let foamCol = foamLit * mat.foamIntensity;

		// a thin bright rim just behind the edge: the rounded bead catches the sky
		let rim = smoothstep( 0.0, 0.025, frontD ) * smoothstep( 0.1, 0.035, frontD ) * uprush;
		let water = mix( transmitted, reflCol, F ) + sunSpec + skyRefl * ( 0.22 * rim );
		let shaded = mix( water, foamCol + sunSpec * 0.05, sat( foam ) );
		// fade into the sand right at the leading edge (anti-aliased by the film thickness)
		let edgeAA = smoothstep( 0.0, max( fwidth( thickness ) * 1.5, 0.004 ), thickness );
		outCol = shaded;
		if ( edgeAA < 1.0 ) {
			let contact = smoothstep( -0.16, -0.005, frontD ) * ( 1.0 - edgeAA ) * uprush;
			let sandC = textureSampleLevel( waterSceneColor, smpLinearClamp, screenUV, 0.0 ).rgb * ( 1.0 - 0.3 * contact );
			outCol = mix( sandC, shaded, edgeAA );
		}

	} else {

		// ================= BELOW WATER (looking up at the surface) =================
		let N = Nview;
		let NdV = max( dot( N, V ), 1e-4 );
		// from water (n=1.333) into air: eta = 1/1.333
		let F = fresnelDielectric( NdV, ${(1 / IOR).toFixed(8)} );
		let Tt = refract( - V, N, ${IOR} );
		let tValid = dot( Tt, Tt ) > 0.5;
		let Td = normalize( select( vec3f( 0.0, 1.0, 0.0 ), Tt, tValid ) );
		// sky through Snell's window (PORT: the environment image; no sun disc yet)
		let skyT = min( skyReflectionRadiance( Td, skyEnv, skyEnvS ), vec3f( 60.0 ) );

		// total internal reflection mirrors the lit water body below: the radiance of an
		// infinitely long view ray through the medium in the reflected direction
		let sigA = frame.waterAbsorption; let sigS = frame.waterScattering; let sigT = sigA + sigS;
		let bb = sigS * mat.backscatter;
		let albedoMS = bb * ( 0.33 * 4.0 ) / ( sigA + bb );
		let Rr = reflect( - V, N );
		let LsU = - refract( - L, vec3f( 0.0, 1.0, 0.0 ), 1.0 / ${IOR} );
		let muU = max( LsU.y, 0.15 );
		let phR = waterPhaseHG( dot( Rr, LsU ), 0.86 ) * 0.7 + ${(0.3 / (4 * Math.PI)).toFixed(8)};
		let kS = sigT * ( 1.0 - min( Rr.y, 0.0 ) / muU );
		let kA = sigT * ( 1.0 - min( Rr.y, 0.0 ) / 0.8 );
		let eSunU = sunLight * ( 1.0 - fresnelDielectric( max( L.y, 0.02 ), ${IOR} ) );
		let deepCol = eSunU * ( sigS * phR + albedoMS * sigT * INV_PI ) / kS
			+ frame.skyIrradiance * PI * ( sigS * ( 1.0 / ( 4.0 * PI ) ) + albedoMS * sigT * INV_PI ) / kA;

		// objects above the water seen through Snell's window (from the viewport)
		let sceneDepthC = _waterSceneDepthAt( screenUV, waterSceneDepth );
		let sceneZ = - viewDepth( sceneDepthC );
		let hasObj = posV.z - sceneZ > 0.0 && sceneZ > - frame.far * 0.9;
		let objCol = textureSampleLevel( waterSceneColor, smpLinearClamp, screenUV, 0.0 ).rgb;
		let transmittedU = select( skyT, objCol, hasObj );

		let foamUnder = ( frame.skyIrradiance + sunLight * 0.5 ) * 0.25;
		outCol = mix( transmittedU * ( 1.0 - F ) + deepCol * F, foamUnder, sat( foam ) * 0.7 );

	}

	// debug views: 1 = back faces red, 2 = normals, 3 = foam, 6 = water path, 7 = the seabed seen through
	let dbg = mat.debugMode;
	var res = min( outCol, vec3f( 16000.0 ) );
	if ( dbg == 1 ) {
		res = select( vec3f( 50.0, 0.0, 0.0 ), res, front > 0.5 );
	} else if ( dbg == 2 ) {
		res = Nview * 0.5 + 0.5;
	} else if ( dbg == 3 ) {
		res = vec3f( foam );
	} else if ( dbg == 10 ) {
		res = vec3f( ssrW );
	} else if ( dbg == 6 ) {
		res = vec3f( dbgPath * 0.02, 0.0, 0.0 );
	} else if ( dbg == 8 ) {
		res = vec3f( 0.0, vDepth * 0.02, 0.0 );
	} else if ( dbg == 7 ) {
		res = dbgScene;
	} else if ( dbg == 5 ) {
		res = vec3f( fract( lagXZ.x * 0.1 ), fract( vHeight ), fract( lagXZ.y * 0.1 ) );
	} else if ( dbg == 11 ) {
		// surf foam sources: whitewater of the breaking wave (r), clear plunging face (b)
		res = vec3f( vShoreFoam, 0.0, vSurfMask.x );
	} else if ( dbg == 12 ) {
		// PORT: the surface height (m, grey = mean, 1 m per half range)
		res = vec3f( sat( vHeight * 0.5 + 0.5 ) );
	} else if ( dbg == 13 ) {
		// PORT: the shore wave phase (r) and exposure (g) straight from the field
		let ph = shorePhaseAt( pos.xz, shoreTex );
		res = vec3f( fract( ph.s ), ph.exposure, 0.0 );
	}
	return vec4f( res, 1.0 );
}
`;

  const all = wgsl(T(COMMON + SEA_DETAIL + ATTENUATION + shoreCode() + simCode + surfFoam + VERTEX + FRAGMENT + HELPERS + SHADE), [cdlod.code]);

  // ------------------------------------------------------------------ entry points (wgslFn)
  const LOAD_ARGS = `view: mat4x4f, proj: mat4x4f, invProj: mat4x4f, invView: mat4x4f,
	u0: vec4f, u1: vec4f, u2: vec4f, u3: vec4f, u4: vec4f, u5: vec4f, u6: vec4f, u7: vec4f,
	u8: vec4f, u9: vec4f, u10: vec4f, u11: vec4f, u12: vec4f, u13: vec4f, u14: vec4f, u15: vec4f,
	u16: vec4f, u17: vec4f, u18: vec4f, u19: vec4f`;
  const LOAD_CALL = "view, proj, invProj, invView, u0, u1, u2, u3, u4, u5, u6, u7, u8, u9, u10, u11, u12, u13, u14, u15, u16, u17, u18, u19";
  const loadFn = wgslFn(`fn opLoadCall( ${LOAD_ARGS} ) -> f32 { return opLoad( ${LOAD_CALL} ); }`, [all]);

  // the vertex: every per-vertex output packed into one mat4 (columns: position + foam, lagXZ +
  // height + depth, shore normal + shore foam, surf mask + swash) — TSL reads the columns, the stage
  // computes it once
  const vertexFn = wgslFn(/* wgsl */`
fn opVertex( gate: f32, node: vec4f, grid: vec2f, oceanDisplacement: texture_2d_array<f32>, smpLinearRepeat: sampler, terrainHeight: texture_2d<f32>, shoreTex: texture_2d<f32> ) -> mat4x4f {
	let r = waterSurfaceVertex( node, grid, oceanDisplacement, smpLinearRepeat, terrainHeight, shoreTex );
	return mat4x4f( vec4f( r.position, r.foam ), vec4f( r.lagXZ, r.height, r.depth ), vec4f( r.shoreN, r.shoreFoam ), vec4f( r.surfMask, r.swash, 0.0 ) );
}`, [all]);

  const fragmentFn = wgslFn(T(/* wgsl */`
fn opFragment( gate: f32, pos: vec3f, screenUV: vec2f, front: f32, aux0: vec4f, aux1: vec4f, aux2: vec4f, aux3: vec4f, sunShadow: f32,
	oceanDerivatives: texture_2d_array<f32>, derivSmp: sampler,
	waterFoamTex: texture_2d<f32>, foamSmp: sampler, seaDetailNoise: texture_2d<f32>, detailSmp: sampler,
	terrainHeight: texture_2d<f32>, shoreTex: texture_2d<f32>, cloudShadow: texture_2d<f32>,
	waterSceneColor: texture_2d<f32>, smpLinearClamp: sampler, waterSceneDepth: DEPTH_T,
	skyEnv: texture_2d<f32>, skyEnvS: sampler,
	shoreSimStateTex: texture_2d<f32>, surfFoamLaceTex: texture_2d<f32>, laceSmp: sampler ) -> vec4f {
	return waterShade( pos, screenUV, front, aux1.xy, aux1.z, aux1.w, aux0.w, sunShadow,
		aux2.xyz, aux2.w, aux3.xy,
		oceanDerivatives, derivSmp, waterFoamTex, foamSmp, seaDetailNoise, detailSmp,
		terrainHeight, shoreTex, cloudShadow, waterSceneColor, smpLinearClamp, waterSceneDepth, skyEnv, skyEnvS,
		shoreSimStateTex, surfFoamLaceTex, laceSmp );
}`), [all]);

  return { loadFn, vertexFn, fragmentFn, U_COUNT: 20 };
}
