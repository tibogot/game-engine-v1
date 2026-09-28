// Sky Pro REAL lab: the exact Sky Pro WebGPU clouds (DRG Software Solutions LLC, MIT) as shipped in
// Tidewater (github.com/dgreenheck/tidewater), running on Tidewater's own raw-WebGPU engine. The
// files under ./tidewater/ are verbatim copies (see ./tidewater/LICENSE); this file is only the host:
// the frame loop, a free camera, a small panel, a GPU timer and Tidewater's final grade.
//
// Not three.js: this page owns its own WebGPU device. It is the REFERENCE a later TSL port is
// compared against, not something a game imports.
//
// Lab-only, NOT Tidewater: the optional flat ground (to see the cloud shadows), and the frame
// composition below. Tidewater's post chain (TAAU, bloom, RCAS, motion blur, flare, droplets) is not
// here; the grade and the auto exposure are copied from its PostFX.js.

import { Vector3, MathUtils } from './tidewater/src/engine/index.js';
import { GPU, UniformBlock, ComputeKernel, StorageBuffer, RenderTarget, FullscreenPass, FrameUniforms, G, setFrameCamera, commonModule } from './tidewater/src/engine/webgpu.js';
import { Engine } from './tidewater/src/engine/Engine.js';
import { Atmosphere, SUN_ILLUMINANCE } from './tidewater/src/sky/Atmosphere.js';
import { Sky, sunDirectionFromTime } from './tidewater/src/sky/Sky.js';
import { SkyProClouds } from './tidewater/src/sky/SkyProClouds.js';
import { Color } from './tidewater/src/engine/math/index.js';

const _up = new Vector3( 0, 1, 0 );
const status = document.getElementById( 'status' );
const say = ( t ) => { status.textContent = t; };

// ------------------------------------------------------------------ settings (Tidewater App defaults)
const settings = {
	timeOfDay: 16.2,
	sunAzimuth: 0,
	timeSpeed: 0,
	exposureEV: 0, // Tidewater UI: exposure = 0.55 * 2^EV
	autoExposure: true,
	coverage: 0.49, // the "Partly cloudy" preset's shell coverage
	windDeg: Math.atan2( 0.94, 0.35 ) * 180 / Math.PI, // Tidewater's default wind direction
	ground: true, // lab-only
	renderScale: 1,
};

// ------------------------------------------------------------------ GPU timer (every pass, like Tidewater's core/Bench.js)
class GpuTimer {

	constructor() {

		this.enabled = GPU.hasTimestamp;
		this.ms = 0;
		this.passes = [];
		this._samples = [];
		this._labels = [];
		if ( ! this.enabled ) return;
		const MAX = this.MAX = 128;
		const d = GPU.device;
		this.querySet = d.createQuerySet( { type: 'timestamp', count: MAX * 2 } );
		this.resolve = d.createBuffer( { size: MAX * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC } );
		this.ring = Array.from( { length: 4 }, () => ( { buffer: d.createBuffer( { size: MAX * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST } ), busy: false } ) );
		const self = this, proto = GPUCommandEncoder.prototype;
		const rp = proto.beginRenderPass, cp = proto.beginComputePass;
		const tag = ( desc, kind ) => {

			if ( self._labels.length >= MAX || ( desc && desc.timestampWrites ) ) return desc;
			const i = self._labels.length;
			self._labels.push( ( desc && desc.label ) || kind );
			return { ...( desc || {} ), timestampWrites: { querySet: self.querySet, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 } };

		};

		proto.beginRenderPass = function ( desc ) { return rp.call( this, tag( desc, 'render' ) ); };
		proto.beginComputePass = function ( desc ) { return cp.call( this, tag( desc, 'compute' ) ); };

	}

	// call right before GPU.submit()
	endFrame() {

		if ( ! this.enabled ) return;
		const n = this._labels.length, labels = this._labels;
		this._labels = [];
		if ( ! n || ! GPU.encoder ) return;
		const slot = this.ring.find( ( s ) => ! s.busy );
		if ( ! slot ) return;
		slot.busy = true;
		GPU.encoder.resolveQuerySet( this.querySet, 0, n * 2, this.resolve, 0 );
		GPU.encoder.copyBufferToBuffer( this.resolve, 0, slot.buffer, 0, n * 16 );
		GPU.onSubmit( null, () => {

			slot.buffer.mapAsync( GPUMapMode.READ ).then( () => {

				const t = new BigInt64Array( slot.buffer.getMappedRange().slice( 0, n * 16 ) );
				slot.buffer.unmap();
				slot.busy = false;
				this._result( labels, t );

			} ).catch( () => { slot.busy = false; } );

		} );

	}

	_result( labels, t ) {

		let first = null, last = null;
		const per = new Map();
		for ( let i = 0; i < labels.length; i ++ ) {

			const a = t[ i * 2 ], b = t[ i * 2 + 1 ];
			if ( b <= 0n || b < a ) continue;
			if ( first === null || a < first ) first = a;
			if ( last === null || b > last ) last = b;
			per.set( labels[ i ], ( per.get( labels[ i ] ) || 0 ) + Number( b - a ) / 1e6 );

		}

		if ( first === null ) return;
		// rolling 60-frame median of the whole frame, mean per pass
		this._samples.push( { total: Number( last - first ) / 1e6, per } );
		if ( this._samples.length > 60 ) this._samples.shift();
		const tot = this._samples.map( ( s ) => s.total ).sort( ( x, y ) => x - y );
		this.ms = tot[ tot.length >> 1 ];
		const acc = new Map();
		for ( const s of this._samples ) for ( const [ k, v ] of s.per ) acc.set( k, ( acc.get( k ) || 0 ) + v / this._samples.length );
		this.passes = [ ...acc ].sort( ( x, y ) => y[ 1 ] - x[ 1 ] );

	}

}

// ------------------------------------------------------------------ free camera (mouse look + WASD)
class FlyCamera {

	constructor( camera, dom ) {

		this.camera = camera;
		camera.rotation.order = 'YXZ';
		this.yaw = 0; this.pitch = 0.12;
		this.keys = new Set();
		this.speed = 60;
		dom.addEventListener( 'pointerdown', ( e ) => { if ( e.button === 0 ) dom.requestPointerLock?.(); } );
		document.addEventListener( 'mousemove', ( e ) => {

			if ( document.pointerLockElement !== dom ) return;
			this.yaw -= e.movementX * 0.0022;
			this.pitch = MathUtils.clamp( this.pitch - e.movementY * 0.0022, - 1.55, 1.55 );

		} );
		// e.code: position-based, so ZQSD on AZERTY works as WASD
		window.addEventListener( 'keydown', ( e ) => { if ( ! ( e.target instanceof HTMLInputElement ) ) this.keys.add( e.code ); } );
		window.addEventListener( 'keyup', ( e ) => this.keys.delete( e.code ) );
		window.addEventListener( 'blur', () => this.keys.clear() );

	}

	update( dt ) {

		const k = this.keys, c = this.camera;
		c.rotation.set( this.pitch, this.yaw, 0, 'YXZ' );
		const fwd = new Vector3( - Math.sin( this.yaw ) * Math.cos( this.pitch ), Math.sin( this.pitch ), - Math.cos( this.yaw ) * Math.cos( this.pitch ) );
		const right = new Vector3( Math.cos( this.yaw ), 0, - Math.sin( this.yaw ) );
		const boost = k.has( 'ShiftLeft' ) || k.has( 'ShiftRight' ) ? 12 : 1;
		const v = this.speed * boost * dt;
		if ( k.has( 'KeyW' ) ) c.position.addScaledVector( fwd, v );
		if ( k.has( 'KeyS' ) ) c.position.addScaledVector( fwd, - v );
		if ( k.has( 'KeyD' ) ) c.position.addScaledVector( right, v );
		if ( k.has( 'KeyA' ) ) c.position.addScaledVector( right, - v );
		if ( k.has( 'KeyE' ) || k.has( 'Space' ) ) c.position.y += v;
		if ( k.has( 'KeyQ' ) || k.has( 'KeyC' ) ) c.position.y -= v;
		c.position.y = Math.max( c.position.y, 1.0 );

	}

	look( yawDeg, pitchDeg ) {

		this.yaw = MathUtils.degToRad( yawDeg );
		this.pitch = MathUtils.degToRad( pitchDeg );

	}

}

// ------------------------------------------------------------------ boot
async function main() {

	if ( ! navigator.gpu ) {

		say( 'WebGPU is not available in this browser.' );
		return;

	}

	say( 'Starting WebGPU…' );
	const engine = new Engine( document.getElementById( 'app' ) );
	await engine.init();
	const camera = engine.camera;
	camera.position.set( 0, 2, 0 );
	const timer = new GpuTimer();
	const fly = new FlyCamera( camera, engine.canvas );

	say( 'Building the atmosphere…' );
	const atmosphere = new Atmosphere( engine );
	const sky = new Sky( atmosphere );
	say( 'Loading the cloud noise…' );
	const clouds = new SkyProClouds( engine, atmosphere );
	await clouds.ready;
	sky.clouds = clouds;

	// ---- HDR sky (+ optional lab ground) into one rgba16f target, Tidewater's skyViewRadiance
	const labParams = new UniformBlock( 'LabParams', {
		ground: [ 'f32', 1 ],
		groundAlbedo: [ 'vec3f', new Vector3( 0.33, 0.29, 0.22 ) ],
	}, { label: 'lab' } );

	const hdr = new RenderTarget( 4, 4, { colors: [ 'rgba16float' ], label: 'lab hdr' } );
	const skyPass = new FullscreenPass( {
		label: 'Sky (skyViewRadiance)',
		modules: [ sky.module ],
		bindings: { lab: { uniform: labParams } },
		colorFormats: [ 'rgba16float' ],
		code: /* wgsl */`
fn fragment( in: FSIn ) -> vec4f {
	let dir = viewRay( in.pos.xy * frame.invResolution );
	var c = skyViewRadiance( dir );
	// LAB ONLY (not Tidewater): a flat sea-level ground to see the cloud shadows on
	if ( lab.ground > 0.5 && dir.y < -1e-4 && frame.cameraPos.y > 0.0 ) {
		let t = -frame.cameraPos.y / dir.y;
		let P = frame.cameraPos + dir * t;
		let L = frame.sunDir;
		let direct = frame.sunColor * max( L.y, 0.0 ) * cloudsShadow( P.xz ) / PI; // Lambert / PI, as Tidewater's lighting.js
		let g = lab.groundAlbedo * ( direct + frame.skyIrradiance );
		// haze toward the horizon's sky colour (the direction of view, just above the horizon)
		let hz = atmosphereSkyLuminance( normalize( vec3f( dir.x, 0.02, dir.z ) ) );
		let k = 1.0 - exp( -t / 12000.0 );
		c = mix( g, hz, k );
	}
	return vec4f( c, 1.0 );
}
`,
	} );

	// ---- auto exposure: Tidewater PostFX._buildMeter, metering a 1/16 copy of the frame
	const meterRT = new RenderTarget( 4, 4, { colors: [ 'rgba16float' ], label: 'lab meter' } );
	const downPass = new FullscreenPass( {
		label: 'Meter downsample',
		bindings: { src: { texture: () => hdr.texture } },
		code: /* wgsl */`fn fragment( in: FSIn ) -> vec4f { return textureSampleLevel( src, smpLinearClamp, in.uv, 0.0 ); }`,
	} );
	const aeUniforms = new UniformBlock( 'AutoExposureParams', {
		enabled: [ 'f32', 1 ], refLum: [ 'f32', 0.25 ], min: [ 'f32', 0.6 ], max: [ 'f32', 6.0 ], up: [ 'f32', 1.6 ], down: [ 'f32', 1.1 ],
	}, { label: 'autoExposure' } );
	const exposureBuf = new StorageBuffer( { label: 'autoExposure', count: 1, type: 'f32', data: new Float32Array( [ 1 ] ) } );
	const W = 256;
	let reduce = '';
	for ( let s = W / 2; s > 0; s >>= 1 ) reduce += `
	if ( t < ${ s }u ) {
		sumL[ t ] += sumL[ t + ${ s }u ];
		sumW[ t ] += sumW[ t + ${ s }u ];
	}
	workgroupBarrier();`;
	const meterKernel = new ComputeKernel( {
		label: 'Auto Exposure',
		modules: [ commonModule ],
		bindings: { ae: { uniform: aeUniforms }, aeTex: { texture: () => meterRT.texture }, aeExposure: { storage: exposureBuf, access: 'read_write' } },
		workgroupSize: [ W, 1, 1 ],
		code: /* wgsl */`
var<workgroup> sumL: array<f32, ${ W }>;
var<workgroup> sumW: array<f32, ${ W }>;
@compute @workgroup_size( WG_X, 1, 1 )
fn main( @builtin( local_invocation_id ) lid: vec3u ) {
	let t = lid.x;
	let size = textureDimensions( aeTex );
	let n = size.x * size.y;
	var accL = 0.0; var accW = 0.0;
	for ( var i = 0u; i < 160u; i++ ) {
		let idx = t + i * ${ W }u;
		if ( idx < n ) {
			let x = idx % size.x; let y = idx / size.x;
			let c = textureLoad( aeTex, vec2i( i32( x ), i32( y ) ), 0 ).rgb;
			let l = log2( max( luminance( c ), 1e-4 ) );
			let uvc = vec2f( ( f32( x ) + 0.5 ) / f32( size.x ), ( f32( y ) + 0.5 ) / f32( size.y ) ) - 0.5;
			let w = max( 1.0 - length( uvc * vec2f( 1.0, 1.4 ) ) * 1.2, 0.15 );
			accL += l * w;
			accW += w;
		}
	}
	sumL[ t ] = accL;
	sumW[ t ] = accW;
	workgroupBarrier();
${ reduce }
	if ( t == 0u ) {
		let avg = exp2( sumL[ 0 ] / max( sumW[ 0 ], 1e-4 ) );
		let ratio = ae.refLum / avg;
		let partial = select( ratio, pow( ratio, 0.8 ), ratio > 1.0 );
		let tgt = clamp( partial, ae.min, mix( ae.max, 2.0, frame.night ) );
		let cur = aeExposure[ 0 ];
		let rate = select( ae.down, ae.up, tgt > cur );
		let k = 1.0 - exp( - frame.dt * rate );
		let next = exp2( mix( log2( max( cur, 1e-3 ) ), log2( tgt ), k ) );
		aeExposure[ 0 ] = select( 1.0, next, ae.enabled > 0.5 );
	}
}
`,
	} );

	// ---- final: Tidewater PostFX grade (warmth, saturation, contrast, vignette, grain, ACES, dither)
	const post = new UniformBlock( 'PostParams', {
		vignette: [ 'f32', 0.28 ], saturation: [ 'f32', 1.06 ], contrast: [ 'f32', 1.04 ], warmth: [ 'f32', 0.02 ], grain: [ 'f32', 0.012 ],
	}, { label: 'post' } );
	const finalPass = new FullscreenPass( {
		label: 'Final grade',
		bindings: { post: { uniform: post }, src: { texture: () => hdr.texture }, postExposure: { storage: exposureBuf, access: 'read' } },
		colorFormats: [ GPU.format ],
		code: /* wgsl */`
fn RRTAndODTFit( v: vec3f ) -> vec3f {
	let a = v * ( v + 0.0245786 ) - 0.000090537;
	let b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
	return a / b;
}
fn acesFilmicToneMapping( colorIn: vec3f, exposure: f32 ) -> vec3f {
	let ACESInputMat = transpose( mat3x3f(
		0.59719, 0.35458, 0.04823,
		0.07600, 0.90834, 0.01566,
		0.02840, 0.13383, 0.83777 ) );
	let ACESOutputMat = transpose( mat3x3f(
		1.60475, -0.53108, -0.07367,
		-0.10208, 1.10813, -0.00605,
		-0.00327, -0.07276, 1.07602 ) );
	var color = colorIn * exposure / 0.6;
	color = ACESInputMat * color;
	color = RRTAndODTFit( color );
	color = ACESOutputMat * color;
	return clamp( color, vec3f( 0.0 ), vec3f( 1.0 ) );
}
fn postHash( p: vec2u, f: u32 ) -> f32 {
	var x = p.x * 1664525u + p.y * 1013904223u + f * 2654435761u;
	x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
	return f32( x >> 8u ) / 16777216.0;
}
fn fragment( in: FSIn ) -> vec4f {
	let uv = in.uv;
	var c = textureSampleLevel( src, smpLinearClamp, uv, 0.0 ).rgb * postExposure[ 0 ];
	c = c * vec3f( 1.0 + post.warmth, 1.0, 1.0 - post.warmth );
	let l = luminance( c );
	c = mix( vec3f( l ), c, post.saturation );
	c = pow( max( c, vec3f( 0.0 ) ) / 0.18, vec3f( post.contrast ) ) * 0.18;
	let dv = ( uv - 0.5 ) * vec2f( 1.0, 0.8 );
	let v = 1.0 - smoothstep( 0.25, 0.75, length( dv ) ) * post.vignette;
	c = c * v;
	let px = vec2u( in.pos.xy );
	let fi = frame.frameIndex;
	let n = ( postHash( px, fi ) + postHash( px + vec2u( 7919u, 104729u ), fi ) - 1.0 ) * 0.5;
	c = c + c * ( n * post.grain );
	let t = acesFilmicToneMapping( c, frame.exposure );
	let dq = ( postHash( px + vec2u( 31337u, 271u ), fi ) + postHash( px + vec2u( 1013u, 65537u ), fi ) - 1.0 ) / 255.0;
	return vec4f( linearToSrgb( t ) + vec3f( dq ), 1.0 );
}
`,
	} );

	say( 'Compiling shaders…' );
	await GPU.pipelinesReady();

	// ---- sun / moon (Tidewater App.updateSun + applyAtmosphereReadback)
	const updateSun = () => {

		const dir = sunDirectionFromTime( settings.timeOfDay ).applyAxisAngle( _up, MathUtils.degToRad( settings.sunAzimuth ) );
		atmosphere.sunDir.value.copy( dir );
		const night = MathUtils.smoothstep( - dir.y, 0.02, 0.18 );
		G.night.value = night;
		sky.starIntensity.value = night;
		const moon = new Vector3( - dir.x, Math.abs( dir.y ) * 0.8 + 0.25, - dir.z ).normalize();
		sky.moonDir.value.copy( moon );
		G.sunDir.value.copy( dir.y > - 0.07 ? dir : moon );

	};

	const applyAtmosphereReadback = () => {

		const a = atmosphere;
		if ( ! a.sunTransmittance ) return;
		const sunTrue = a.sunDir.value;
		const T = a.sunTransmittance;
		const horizonFade = MathUtils.smoothstep( sunTrue.y, - 0.03, 0.02 );
		const c = sunTrue.y > - 0.07
			? new Color( T[ 0 ], T[ 1 ], T[ 2 ] ).multiplyScalar( SUN_ILLUMINANCE * horizonFade )
			: new Color( 0.6, 0.7, 1.0 ).multiplyScalar( 0.12 * G.night.value );
		G.sunColor.value.copy( c );
		const irr = a.skyIrradiance;
		const nightAmb = 0.012 * G.night.value;
		G.skyIrradiance.value.setRGB( irr[ 0 ] + nightAmb * 0.6, irr[ 1 ] + nightAmb * 0.7, irr[ 2 ] + nightAmb );
		G.horizonColor.value.setRGB( a.horizon[ 0 ], a.horizon[ 1 ], a.horizon[ 2 ] );

	};

	// ---- sizing
	let w = 0, h = 0;
	const resize = () => {

		engine.setRenderScale( settings.renderScale * Math.min( window.devicePixelRatio || 1, 2 ) );
		w = engine.width; h = engine.height;
		hdr.setSize( w, h );
		meterRT.setSize( Math.max( 1, w >> 4 ), Math.max( 1, h >> 4 ) );
		clouds.outputSize = { x: w, y: h };

	};

	engine.onResize.push( () => { w = 0; } );
	resize();

	// ---- panel
	buildPanel( { settings, clouds, fly, camera, resize, timer, labParams, aeUniforms } );

	let prevVP = null;
	let prevPos = null;
	const frame = ( dt ) => {

		if ( w !== engine.width || h !== engine.height || ! w ) resize();
		GPU.beginFrame();
		FrameUniforms.fields.frameIndex.value = GPU.frame;
		G.dt.value = dt;
		G.time.value += dt;
		if ( settings.timeSpeed !== 0 ) settings.timeOfDay = ( settings.timeOfDay + dt * settings.timeSpeed + 24 ) % 24;
		G.exposure.value = 0.55 * Math.pow( 2, settings.exposureEV );
		aeUniforms.fields.enabled.value = settings.autoExposure ? 1 : 0;
		labParams.fields.ground.value = settings.ground ? 1 : 0;
		const wr = MathUtils.degToRad( settings.windDeg );
		G.windDir.value.set( Math.cos( wr ), Math.sin( wr ) );
		clouds.coverage.value = settings.coverage;

		fly.update( dt );
		updateSun();
		atmosphere.update( dt, camera.position.y );
		applyAtmosphereReadback();

		setFrameCamera( camera, w, h, { prevViewProj: prevVP, prevCameraPos: prevPos } );
		prevVP = FrameUniforms.fields.viewProjNoJitter.value.clone();
		prevPos = FrameUniforms.fields.cameraPos.value.clone();

		clouds.update( dt, camera );
		skyPass.render( { colorViews: [ hdr.texture ], clear: [ 0, 0, 0, 1 ] } );
		downPass.render( { colorViews: [ meterRT.texture ] } );
		meterKernel.dispatch( [ 1, 1, 1 ] );
		finalPass.render( { colorViews: [ engine.currentTexture().createView() ], clear: [ 0, 0, 0, 1 ] } );
		timer.endFrame();
		GPU.submit();

	};

	window.__skyProReal = { engine, camera, atmosphere, sky, clouds, settings, timer, fly, G };
	say( '' );
	engine.start( ( dt ) => frame( dt ) );

}

// ------------------------------------------------------------------ panel
function buildPanel( { settings, clouds, fly, camera, resize, timer } ) {

	const panel = document.getElementById( 'panel' );
	const row = ( label, input, out ) => {

		const r = document.createElement( 'label' );
		r.className = 'row';
		const s = document.createElement( 'span' );
		s.textContent = label;
		r.append( s, input );
		if ( out ) r.append( out );
		panel.append( r );

	};

	const slider = ( label, key, min, max, step, fmt = ( v ) => v.toFixed( 2 ), onInput = null ) => {

		const i = document.createElement( 'input' );
		i.type = 'range'; i.min = min; i.max = max; i.step = step; i.value = settings[ key ];
		const o = document.createElement( 'output' );
		const show = () => { o.textContent = fmt( Number( settings[ key ] ) ); };
		i.addEventListener( 'input', () => { settings[ key ] = Number( i.value ); show(); if ( onInput ) onInput(); } );
		show();
		row( label, i, o );
		return { input: i, show };

	};

	const check = ( label, key ) => {

		const i = document.createElement( 'input' );
		i.type = 'checkbox'; i.checked = settings[ key ];
		i.addEventListener( 'change', () => { settings[ key ] = i.checked; } );
		row( label, i );

	};

	const h = ( t ) => { const e = document.createElement( 'h3' ); e.textContent = t; panel.append( e ); };
	const hhmm = ( v ) => `${ String( Math.floor( v ) ).padStart( 2, '0' ) }:${ String( Math.floor( ( v % 1 ) * 60 ) ).padStart( 2, '0' ) }`;

	h( 'Sun' );
	const tod = slider( 'Time of day', 'timeOfDay', 0, 24, 0.01, hhmm );
	slider( 'Sun azimuth', 'sunAzimuth', - 180, 180, 1, ( v ) => `${ v.toFixed( 0 ) }°` );
	slider( 'Time speed', 'timeSpeed', 0, 2, 0.01, ( v ) => `${ v.toFixed( 2 ) } h/s` );
	h( 'Clouds (Partly cloudy preset)' );
	slider( 'Coverage', 'coverage', 0, 1, 0.01 );
	slider( 'Wind direction', 'windDeg', - 180, 180, 1, ( v ) => `${ v.toFixed( 0 ) }°` );
	h( 'Output' );
	slider( 'Exposure', 'exposureEV', - 3, 3, 0.1, ( v ) => `${ v.toFixed( 1 ) } EV` );
	check( 'Auto exposure', 'autoExposure' );
	slider( 'Render scale', 'renderScale', 0.5, 1, 0.05, ( v ) => v.toFixed( 2 ), resize );
	check( 'Ground (lab only)', 'ground' );

	h( 'Camera' );
	const views = document.createElement( 'div' );
	views.className = 'views';
	const view = ( label, y, yaw, pitch ) => {

		const b = document.createElement( 'button' );
		b.textContent = label;
		b.addEventListener( 'click', () => {

			camera.position.set( 0, y, 0 );
			fly.look( yaw, pitch );
			clouds.resetHistory();

		} );
		views.append( b );

	};

	view( 'Ground 2 m', 2, 0, 12 );
	view( 'Toward sun', 2, 90, 8 );
	view( 'RTS 130 m', 130, 0, - 35 );
	view( 'High 2 km', 2000, 0, 5 );
	view( 'In the deck 6 km', 6000, 0, 0 );
	view( 'Above 11 km', 11000, 0, - 20 );
	panel.append( views );

	const stats = document.createElement( 'pre' );
	stats.id = 'stats';
	panel.append( stats );
	const help = document.createElement( 'p' );
	help.className = 'help';
	help.textContent = 'Click the view to look (Esc releases). WASD / ZQSD move, E/Space up, Q/C down, Shift x12.';
	panel.append( help );

	let acc = 0, frames = 0, last = performance.now();
	const tick = () => {

		const now = performance.now();
		acc += now - last; frames ++; last = now;
		if ( acc > 500 ) {

			const ms = acc / frames;
			acc = 0; frames = 0;
			const p = camera.position;
			let s = `frame  ${ ms.toFixed( 2 ) } ms (wall, vsync-bound)\n`;
			s += timer.enabled ? `GPU    ${ timer.ms.toFixed( 2 ) } ms (median of 60)\n` : 'GPU    n/a (no timestamp-query)\n';
			for ( const [ k, v ] of timer.passes.slice( 0, 8 ) ) s += `  ${ k.padEnd( 22 ).slice( 0, 22 ) } ${ v.toFixed( 3 ) }\n`;
			s += `cam    ${ p.x.toFixed( 0 ) }, ${ p.y.toFixed( 0 ) }, ${ p.z.toFixed( 0 ) } m\n`;
			s += `sync compiles: ${ GPU.syncCompiles.length }`;
			stats.textContent = s;
			if ( settings.timeSpeed !== 0 ) tod.input.value = settings.timeOfDay, tod.show();

		}

		requestAnimationFrame( tick );

	};

	requestAnimationFrame( tick );

}

main().catch( ( e ) => {

	console.error( e );
	say( 'Failed: ' + e.message );

} );
