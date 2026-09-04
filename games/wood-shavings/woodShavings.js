// Wood shavings hero — a workbench buried under plane shavings that you blow away
// with the pointer. WebGPU + TSL only: the whole simulation lives in a compute kernel
// (positions, velocities, quaternions), and every shaving is one instance of a flat
// strip that the VERTEX shader curls into a spiral/helix. One draw for the shavings,
// one for the sawdust, one for the bench.
//
// Textures: ambientCG Wood066 (bench, walnut) and Wood076 (raw sawn wood, used as the
// shaving grain). CC0.

import * as THREE from "three/webgpu";
import {
  Fn, If, uniform, instancedArray, instanceIndex, float, vec2, vec3, vec4, uv,
  normalWorld, texture, varying, transformNormalToView, mix, smoothstep, sin, cos, exp,
  normalize, cross, dot, length, max, saturate, sign, select, abs, pow,
  faceDirection, mx_noise_float, hash, positionWorld, fwidth, uint,
} from "three/tsl";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

// Imported by name, one per file, rather than built from a template string: Vite only
// rewrites asset URLs it can resolve STATICALLY, so `new URL(`./textures/${n}`, ...)`
// survives the dev server and then 404s in the build, where the files are hashed and
// moved. These imports make the bundler emit them.
import benchColorUrl from "./textures/bench_color.jpg";
import benchNormalUrl from "./textures/bench_normal.jpg";
import benchRoughUrl from "./textures/bench_roughness.jpg";
import shavingColorUrl from "./textures/shaving_color.jpg";

// ── Scene scale ─────────────────────────────────────────────────────────────────
// Metres. A real workbench seen from a standing height; shavings are 3–25 cm long.
const BENCH = { w: 7, d: 6, cz: -1.2 }; // bench slab (x width, z depth, centre z)
const SIM = { x: 1.9, zMin: -2.6, zMax: 0.95 }; // where shavings are allowed to live
const CAMERA = { pos: new THREE.Vector3(0, 0.74, 0.82), look: new THREE.Vector3(0, 0, 0.01), fov: 40 };

const SHAVINGS = 7500;
const SAWDUST = 22000;
const STRIP_SEGS = 48;
const TAU = 6.2831853;

// ── Quaternion helpers (TSL) ────────────────────────────────────────────────────
const qmul = Fn(([a, b]) => {
  const xyz = a.xyz.mul(b.w).add(b.xyz.mul(a.w)).add(cross(a.xyz, b.xyz));
  const w = a.w.mul(b.w).sub(dot(a.xyz, b.xyz));
  return vec4(xyz, w);
});
const qrot = Fn(([q, v]) => {
  const t = cross(q.xyz, v).mul(2.0);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
});
// Minimal rotation taking unit vector a onto unit vector b.
const qFromTo = Fn(([a, b]) => {
  const c = cross(a, b);
  const w = float(1.0).add(dot(a, b)).max(1e-4);
  return normalize(vec4(c, w));
});

// ── The shaving shape ──────────────────────────────────────────────────────────
// A strip (t along the ribbon 0..1, v across it -0.5..0.5) wrapped into a spiral in
// the local XY plane whose axis is local Z, with a helical drift along Z so tight
// coils read as springs and not washers. Parameters per instance:
//   A = (L, W, Theta, r0)      ribbon length, width, total curl angle, start radius
//   B = (a, b, tint, tiltMix)  radius growth/rad, axis drift/rad, colour, rest pose
// The JS twin below computes the resting height with exactly the same maths.
const shapeTSL = Fn(([t, v, A, B, edge, seed]) => {
  const theta = A.z.mul(t);
  const wobble = float(1.0).add(sin(theta.mul(3.1).add(seed.mul(17.0))).mul(0.05));
  const r = A.w.add(B.x.mul(theta)).mul(wobble);
  const taper = float(0.55).add(smoothstep(0.0, 0.12, t).mul(0.45))
    .mul(float(1.0).sub(smoothstep(0.68, 1.0, t).mul(0.8)));
  const z = v.mul(A.y).mul(taper).mul(edge).add(B.y.mul(theta)).sub(B.y.mul(A.z).mul(0.5));
  // Re-centre gently-bent chips on their arc rather than on a far-away arc centre.
  const rMid = A.w.add(B.x.mul(A.z).mul(0.5));
  const f = float(1.0).sub(saturate(A.z.div(Math.PI)));
  const cx = rMid.mul(cos(A.z.mul(0.5))).mul(f);
  const cy = rMid.mul(sin(A.z.mul(0.5))).mul(f);
  return vec3(r.mul(cos(theta)).sub(cx), r.mul(sin(theta)).sub(cy), z);
});

function shapeJS(t, v, A, B, out) {
  const theta = A[2] * t;
  const wobble = 1 + Math.sin(theta * 3.1) * 0.05; // seed term ignored: bounded ±5 %
  const r = (A[3] + B[0] * theta) * wobble;
  const s01 = (x, e0, e1) => { const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };
  const taper = (0.55 + s01(t, 0, 0.12) * 0.45) * (1 - s01(t, 0.68, 1) * 0.8);
  const z = v * A[1] * taper + B[1] * theta - B[1] * A[2] * 0.5;
  const rMid = A[3] + B[0] * A[2] * 0.5;
  const f = 1 - Math.min(1, A[2] / Math.PI);
  out[0] = r * Math.cos(theta) - rMid * Math.cos(A[2] * 0.5) * f;
  out[1] = r * Math.sin(theta) - rMid * Math.sin(A[2] * 0.5) * f;
  out[2] = z;
}

// ── Instance parameter generation ──────────────────────────────────────────────
const rnd = (() => { let s = 1234567; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
const U = (a, b) => a + (b - a) * rnd();

function makeShavingParams() {
  const A = new Float32Array(4), B = new Float32Array(4);
  const k = rnd();
  let tilt, tiltMix;
  if (k < 0.3) { // tight coil — the classic plane shaving, a spring that opens up
    const turns = U(1.3, 2.4);
    A[2] = turns * Math.PI * 2; A[3] = U(0.005, 0.0105);
    B[0] = U(0.0006, 0.0015); B[1] = U(0.0014, 0.003);
    A[1] = U(0.009, 0.02);
    tilt = U(-0.3, 0.3); tiltMix = 0.0;
  } else if (k < 0.7) { // loose curl
    const turns = U(0.5, 1.3);
    A[2] = turns * Math.PI * 2; A[3] = U(0.009, 0.02);
    B[0] = U(0.002, 0.005); B[1] = U(0.0004, 0.0024);
    A[1] = U(0.009, 0.024);
    tilt = U(0.35, 1.0); tiltMix = 0.45;
  } else { // flat chip
    A[2] = U(0.22, 0.9); A[3] = U(0.045, 0.12);
    B[0] = 0; B[1] = 0;
    A[1] = U(0.009, 0.024);
    tilt = Math.PI / 2 + U(-0.12, 0.12); tiltMix = 1.0;
  }
  A[0] = (A[3] + B[0] * A[2] * 0.5) * A[2]; // arc length
  B[2] = rnd(); B[3] = tiltMix;
  return { A, B, tilt };
}

function makeSawdustParams() {
  const A = new Float32Array(4), B = new Float32Array(4);
  const L = U(0.0022, 0.0055);
  A[2] = U(0.08, 0.5); A[3] = L / A[2]; A[1] = L * U(0.5, 1.0); A[0] = L;
  B[0] = 0; B[1] = 0; B[2] = rnd(); B[3] = 1.0;
  return { A, B, tilt: Math.PI / 2 + U(-0.2, 0.2) };
}

// Lowest point of the shape once tilted about X by `tilt` (the rest pose), so a
// shaving sits ON the bench rather than through it.
const _pt = [0, 0, 0];
function restHeight(A, B, tilt, segs) {
  let minY = Infinity;
  const c = Math.cos(tilt), s = Math.sin(tilt);
  for (let i = 0; i <= segs; i++) {
    for (let j = -1; j <= 1; j++) {
      shapeJS(i / segs, j * 0.5, A, B, _pt);
      const y = _pt[1] * c - _pt[2] * s;
      if (y < minY) minY = y;
    }
  }
  return -minY + 0.0006;
}

// ── One particle system (buffers + compute kernel + mesh) ──────────────────────
function createSystem({ count, segs, makeParams, cfg, shared, place }) {
  const pos = new Float32Array(count * 4), vel = new Float32Array(count * 4);
  const quat = new Float32Array(count * 4), ang = new Float32Array(count * 4);
  const pA = new Float32Array(count * 4), pB = new Float32Array(count * 4), pC = new Float32Array(count * 4);
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion(), qy = new THREE.Quaternion(), qx = new THREE.Quaternion();
  const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < count; i++) {
    const { A, B, tilt } = makeParams();
    const ry = restHeight(A, B, tilt, segs);
    place(p);
    pos.set([p.x, ry, p.z, ry], i * 4);
    qy.setFromAxisAngle(Y, rnd() * Math.PI * 2);
    qx.setFromAxisAngle(X, tilt);
    q.copy(qy).multiply(qx);
    quat.set([q.x, q.y, q.z, q.w], i * 4);
    pA.set(A, i * 4); pB.set(B, i * 4);
    pC.set([tilt, rnd(), rnd() * 6.283, 0], i * 4);
  }
  const posBuf = instancedArray(pos, "vec4");
  const velBuf = instancedArray(vel, "vec4");
  const quatBuf = instancedArray(quat, "vec4");
  const angBuf = instancedArray(ang, "vec4");
  const aBuf = instancedArray(pA, "vec4");
  const bBuf = instancedArray(pB, "vec4");
  const cBuf = instancedArray(pC, "vec4");

  const { uMouse, uMouseVel, uBlow, uRadius, uTime, uDt } = shared;

  // ── Compute kernel ─────────────────────────────────────────────────────────
  const update = Fn(() => {
    const i = instanceIndex;
    const P = posBuf.element(i).toVar();
    const V = velBuf.element(i).toVar();
    const Q = quatBuf.element(i).toVar();
    const W = angBuf.element(i).xyz.toVar();
    const B = bBuf.element(i);
    const C = cBuf.element(i);
    const restY = P.w;
    const tiltMix = B.w;
    const rn = C.y;
    const dt = uDt;
    const pos3 = P.xyz.toVar();
    const vel3 = V.xyz.toVar();

    // Breath from the pointer: radial spread on the bench + the pointer's own motion,
    // stirred by a little noise so it never reads as a perfect ring.
    const d = pos3.xz.sub(uMouse.xz);
    const dist = length(d);
    const R = uRadius.mul(float(1.0).add(uBlow.mul(0.45)));
    const fall = exp(dist.div(R).pow(2.0).negate());
    const radial = d.div(max(dist, 0.02));
    const turb = mx_noise_float(vec3(pos3.x.mul(7.0), pos3.z.mul(7.0), uTime.mul(2.2)));
    const swirl = vec2(radial.y.negate(), radial.x).mul(turb.mul(0.7));
    const push = float(0.3).add(uBlow.mul(1.1)).mul(cfg.push);
    const wh = radial.add(swirl).mul(push).add(uMouseVel.xz.mul(0.35))
      .mul(fall).mul(float(1.0).add(turb.mul(0.35)));
    const windMag = length(wh);
    const lift = windMag.mul(float(0.3).add(uBlow.mul(0.5))).mul(cfg.lift);
    const wind = vec3(wh.x, lift, wh.y);

    const grounded = pos3.y.lessThanEqual(restY.add(0.0008)).and(vel3.y.lessThanEqual(0.02));
    const axis = normalize(vec3(hash(i.add(uint(11))), hash(i.add(uint(29))), hash(i.add(uint(53)))).sub(0.5));
    const thresh = float(cfg.threshold).mul(float(0.7).add(rn.mul(0.6)));

    If(grounded, () => {
      If(windMag.greaterThan(thresh), () => {
        vel3.addAssign(wind.sub(vel3).mul(cfg.airCouple * 0.6).mul(dt));
        vel3.y.addAssign(windMag.sub(thresh).mul(cfg.pop).mul(dt));
        W.addAssign(cross(axis, wind).mul(cfg.spin * 0.5).mul(dt));
      }).Else(() => {
        vel3.mulAssign(exp(dt.mul(-cfg.groundFriction)));
        vel3.y.assign(0.0);
      });
      // Coils roll; flat chips just slide.
      const roll = cross(vec3(0, 1, 0), vel3).div(restY.max(0.003));
      W.assign(mix(roll, W.mul(exp(dt.mul(-9.0))), tiltMix));
    }).Else(() => {
      vel3.addAssign(wind.sub(vel3).mul(cfg.airCouple).mul(dt));
      vel3.y.subAssign(float(cfg.gravity).mul(dt));
      // Flutter: a light strip never falls straight.
      const ph = uTime.mul(cfg.flutterHz).add(C.z);
      vel3.x.addAssign(sin(ph).mul(cfg.flutter).mul(dt));
      vel3.z.addAssign(cos(ph.mul(1.31)).mul(cfg.flutter).mul(dt));
      W.addAssign(cross(axis, vel3).mul(cfg.spin).mul(dt));
      W.mulAssign(exp(dt.mul(-1.6)));
    });

    pos3.addAssign(vel3.mul(dt));

    // Bench collision.
    If(pos3.y.lessThan(restY), () => {
      pos3.y.assign(restY);
      vel3.y.assign(vel3.y.negate().mul(0.12));
      vel3.xz.mulAssign(0.75);
    });
    // Keep them on the bench (a soft wall just outside the frame).
    If(pos3.x.greaterThan(SIM.x), () => { pos3.x.assign(SIM.x); vel3.x.assign(vel3.x.abs().negate().mul(0.3)); });
    If(pos3.x.lessThan(-SIM.x), () => { pos3.x.assign(-SIM.x); vel3.x.assign(vel3.x.abs().mul(0.3)); });
    If(pos3.z.greaterThan(SIM.zMax), () => { pos3.z.assign(SIM.zMax); vel3.z.assign(vel3.z.abs().negate().mul(0.3)); });
    If(pos3.z.lessThan(SIM.zMin), () => { pos3.z.assign(SIM.zMin); vel3.z.assign(vel3.z.abs().mul(0.3)); });

    // Integrate orientation.
    const dq = qmul(vec4(W, 0.0), Q).mul(dt.mul(0.5));
    Q.assign(normalize(Q.add(dq)));

    // Settle toward the rest pose as the bench comes up: the curl axis (local Z)
    // goes horizontal for coils, vertical for flat chips. Roll about that axis stays
    // free, which is what lets a coil roll.
    const lz = qrot(Q, vec3(0, 0, 1));
    const horiz = normalize(vec3(lz.x, 0.0, lz.z).add(vec3(0.0, 0.0, 1e-4)));
    const vert = vec3(0.0, sign(lz.y.add(1e-5)), 0.0);
    const target = normalize(mix(horiz, vert, tiltMix));
    const restQ = qmul(qFromTo(lz, target), Q);
    const restS = restQ.mul(sign(dot(restQ, Q)));
    const near = smoothstep(0.08, 0.0, pos3.y.sub(restY));
    const k = near.mul(select(grounded, 9.0, 2.5)).mul(dt).min(1.0);
    Q.assign(normalize(mix(Q, restS, k)));

    posBuf.element(i).assign(vec4(pos3, restY));
    velBuf.element(i).assign(vec4(vel3, 0.0));
    quatBuf.element(i).assign(Q);
    angBuf.element(i).assign(vec4(W, 0.0));
  })().compute(count);

  // ── Geometry: a flat strip, curled in the vertex shader ───────────────────────
  const plane = new THREE.PlaneGeometry(1, 1, segs, 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = plane.index;
  geometry.setAttribute("position", plane.getAttribute("position"));
  geometry.setAttribute("normal", plane.getAttribute("normal"));
  geometry.setAttribute("uv", plane.getAttribute("uv"));
  geometry.instanceCount = count;

  const material = buildShavingMaterial({ posBuf, quatBuf, aBuf, bBuf, cBuf, shared, cfg });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, update, buffers: { posBuf, velBuf, quatBuf } };
}

function buildShavingMaterial({ posBuf, quatBuf, aBuf, bBuf, cBuf, shared, cfg }) {
  const { texColor, uSunDir, uSunColor } = shared;
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.metalness = 0;

  const seedNode = cBuf.element(instanceIndex).z;
  const tNode = uv().x;
  const vNode = uv().y.sub(0.5);

  // Shape evaluated in the vertex stage. The analytic frame (tangent along the ribbon,
  // bitangent across it, normal) travels to the fragment stage as varyings: assigning
  // normalLocal from inside positionNode does not reach the lighting, because the
  // POSITION sub-build keeps its own copy of that variable.
  const i = instanceIndex;
  const P = posBuf.element(i);
  const Q = quatBuf.element(i);
  const A = aBuf.element(i);
  const B = bBuf.element(i);
  const t = tNode, v = vNode, seed = seedNode;
  // Ragged edges: each edge tears differently.
  const edge = float(1.0).add(mx_noise_float(vec3(t.mul(14.0).add(seed), v.mul(4.0), seed.mul(2.7))).mul(cfg.edgeNoise));
  const e = float(0.012);
  const p0 = shapeTSL(t, v, A, B, edge, seed);
  const pt = shapeTSL(t.add(e), v, A, B, edge, seed).sub(shapeTSL(t.sub(e), v, A, B, edge, seed));
  const pv = shapeTSL(t, v.add(0.1), A, B, edge, seed).sub(shapeTSL(t, v.sub(0.1), A, B, edge, seed));
  const nL = normalize(cross(pt, pv));
  mat.positionNode = qrot(Q, p0).add(P.xyz);
  const vT = varying(transformNormalToView(qrot(Q, normalize(pt))), "vShT");
  const vB = varying(transformNormalToView(qrot(Q, normalize(pv))), "vShB");
  const vN = varying(transformNormalToView(qrot(Q, nL)), "vShN");

  // ── Surface: wood fibre, generated rather than sampled ────────────────────────
  // A shaving is a few centimetres of ribbon, so the photo tiled at a plausible scale
  // covered about half a tile per piece — magnified into a smooth cream blur with no
  // grain left. Fibre is a line pattern with a KNOWN direction (it runs along the cut,
  // i.e. along the ribbon), so generating it is both cheaper and sharp at any zoom.
  // The photo stays on as a low-frequency mottle, which is what it is actually good for.
  const along = tNode.mul(A.x);   // metres along the ribbon
  const across = vNode.mul(A.y);  // metres across it

  // Fibre is an anisotropic noise field stretched along the ribbon, NOT a sine wave. A
  // periodic ridge at this spacing reads as corrugated cardboard however its amplitude is
  // tuned; real fibre varies in width, length and depth from one line to the next.
  // `fibCoord` counts fibres, so fwidth on it is "fibres per pixel" and fading there is
  // exact — a ridge is dropped precisely when it stops being resolvable, at any distance
  // or grazing angle. A distance fade cannot do that: these ribbons are edge-on as often
  // as face-on, and edge-on is where a line pattern turns to moiré.
  const fibCoord = across.mul(cfg.fibreDensity);
  const fibAt = (c) => mx_noise_float(vec3(along.mul(cfg.fibreStretch), c, seedNode.mul(7.0)));
  const f0 = fibAt(fibCoord);
  const f1 = fibAt(fibCoord.add(0.34)); // finite difference across the fibres
  const fibAA = saturate(float(0.5).sub(fwidth(fibCoord)).mul(3.0));
  const fib = f0.mul(fibAA);
  const fibSlope = f1.sub(f0).mul(cfg.fibreSlope).mul(fibAA);
  // Chatter: the faint ridges a plane iron leaves ACROSS the shaving.
  const cc = along.mul(cfg.chatterDensity).add(seedNode.mul(0.8));
  const chatAA = saturate(float(0.42).sub(fwidth(cc)).mul(3.4));
  const chat = sin(cc.mul(TAU)).mul(chatAA);
  const chatSlope = cos(cc.mul(TAU)).mul(TAU * cfg.chatterDensity * cfg.chatterRelief).mul(chatAA);

  // Earlywood / latewood banding, plus the photo as a broad mottle.
  const band = mx_noise_float(vec3(across.mul(150.0), along.mul(6.0), seedNode.mul(4.0))).mul(0.5).add(0.5);
  const mUV = vec2(along.mul(11.0).add(seedNode.mul(0.37)), across.mul(11.0).add(seedNode.mul(0.11)));
  const mottle = dot(texture(texColor, mUV).rgb, vec3(0.3, 0.59, 0.11));

  // A torn edge: frayed, a little darker, and rougher than the body.
  const fray = smoothstep(0.34, 0.5, abs(vNode));

  // Fresh-cut softwood: pale cream, honey where the grain is dense, drifting per piece.
  // These read far darker than fresh pine looks in the hand, and they have to: the sun
  // is at 4.2 and ACES clips a 0.9 albedo to chalk white. Lit, they land on warm cream.
  const pale = vec3(0.72, 0.60, 0.42), amber = vec3(0.58, 0.40, 0.21), deep = vec3(0.34, 0.21, 0.10);
  let albedo = mix(pale, amber, saturate(band.mul(1.05)));
  albedo = mix(albedo, deep, saturate(fib.mul(-0.5).add(0.5)).mul(0.28)); // fibre valleys
  albedo = mix(albedo, amber, B.z.mul(0.45));
  albedo = albedo.mul(mix(float(0.93), float(1.06), mottle));
  albedo = albedo.mul(mix(float(1.0), float(0.86), fray));
  albedo = albedo.mul(float(cfg.brightness).mul(float(0.88).add(hash(instanceIndex.add(uint(7))).mul(0.22))));
  // The inside of the curl is the freshly cut face: paler and smoother than the outside,
  // which was torn off the board.
  const inside = faceDirection.lessThan(0.0);
  albedo = albedo.mul(select(inside, 1.06, 0.95));
  mat.colorNode = albedo;

  // Tangent-space relief, expressed straight in the analytic ribbon frame.
  const N = normalize(vN).mul(faceDirection);
  const relief = normalize(vec3(chatSlope.negate(), fibSlope.negate(), 1.0));
  mat.normalNode = normalize(
    normalize(vT).mul(relief.x).add(normalize(vB).mul(relief.y)).add(N.mul(relief.z)),
  );

  // Planed wood is smooth where the iron touched it and rough where it tore — but it is
  // never glossy. Dropping below ~0.5 gives every ridge a specular edge and the whole
  // carpet goes chalk white.
  mat.roughnessNode = saturate(
    select(inside, float(0.54), float(0.70))
      .add(fib.mul(-0.05))
      .add(chat.mul(0.03))
      .add(fray.mul(0.2))
      .add(mottle.sub(0.5).mul(0.1)),
  );

  // Thin wood glows when the sun is behind it, and the fibre shows through.
  const through = saturate(dot(normalWorld, uSunDir).negate());
  const thin = mix(float(1.0), float(1.5), fray); // edges are the thinnest part
  mat.emissiveNode = albedo.mul(uSunColor)
    .mul(through.mul(through)).mul(thin)
    .mul(mix(float(0.82), float(1.18), fib.mul(0.5).add(0.5)))
    .mul(cfg.translucency);
  return mat;
}

// ── App ────────────────────────────────────────────────────────────────────────
export async function startWoodShavings({ container = document.body, onStats } = {}) {
  if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); // measured: 9x pixels still runs at 27 fps, 2.25x is free
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  await renderer.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x120c08);
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, 0.05, 40);
  camera.position.copy(CAMERA.pos);
  camera.lookAt(CAMERA.look);
  camera.updateMatrixWorld(true); // the placement below raycasts through this camera before any render

  // ── Textures ──────────────────────────────────────────────────────────────────
  const loader = new THREE.TextureLoader();
  const load = async (url, srgb) => {
    const t = await loader.loadAsync(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // The bench is seen at a grazing angle, where 8x is still visibly blurry. 16 is the
    // WebGPU maximum and three clamps to what the device reports.
    t.anisotropy = 16;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  // The shavings only need a colour map now (a broad mottle); their grain and relief are
  // generated, so the shaving normal/roughness maps are no longer loaded.
  const [benchColor, benchNormal, benchRough, shColor] = await Promise.all([
    load(benchColorUrl, true), load(benchNormalUrl, false), load(benchRoughUrl, false),
    load(shavingColorUrl, true),
  ]);

  // ── Lights ────────────────────────────────────────────────────────────────────
  const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.92, 0.78), 4.2);
  sun.position.set(-1.3, 2.0, 0.9);
  sun.target.position.set(0.25, 0, -0.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.near = 0.3;
  sun.shadow.camera.far = 7;
  sun.shadow.camera.left = -2.3; sun.shadow.camera.right = 2.3;
  sun.shadow.camera.top = 2.3; sun.shadow.camera.bottom = -2.3;
  sun.shadow.bias = -0.00012;
  sun.shadow.normalBias = 0.003;
  scene.add(sun, sun.target);

  const rim = new THREE.DirectionalLight(new THREE.Color(0.62, 0.72, 1.0), 0.55);
  rim.position.set(1.0, 0.9, -1.8);
  scene.add(rim);
  scene.add(new THREE.HemisphereLight(new THREE.Color(0.55, 0.6, 0.72), new THREE.Color(0.32, 0.22, 0.12), 0.28));

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // RoomEnvironment is an HDR room: at 0.4 it out-shone the sun and flattened everything.
  scene.environmentIntensity = 0.14;

  // ── Shared uniforms ───────────────────────────────────────────────────────────
  const sunDir = new THREE.Vector3().subVectors(sun.position, sun.target.position).normalize();
  const shared = {
    uMouse: uniform(new THREE.Vector3(0, 0, 99)),
    uMouseVel: uniform(new THREE.Vector3()),
    uBlow: uniform(0),
    uRadius: uniform(0.17),
    uTime: uniform(0),
    uDt: uniform(1 / 120),
    uSunDir: uniform(sunDir),
    uSunColor: uniform(sun.color.clone().multiplyScalar(0.9)),
    texColor: shColor,
  };

  // ── Bench ─────────────────────────────────────────────────────────────────────
  {
    const mat = new THREE.MeshPhysicalNodeMaterial();
    // One 1K tile per ~0.8 m. The first pass stretched one tile over 4.4 m, so with the
    // camera 70 cm off the deck the photo was magnified ~10x past its texel size: the
    // normal and roughness maps flattened into smooth gradients and the surface read as
    // a bare albedo however hard the maps were pushed.
    const TILE = 0.8;
    const bUV = uv().mul(vec2(BENCH.w / TILE, BENCH.d / TILE));
    const far = smoothstep(-0.3, -2.8, positionWorld.z);
    const tint = mix(float(1.0), float(0.55), far);

    // Fine tiling exposes the repeat, so a low-frequency tone drift breaks it up.
    const blotch = mx_noise_float(vec3(uv().x.mul(4.7), uv().y.mul(3.9), 0.0)).mul(0.5).add(0.5);
    const wear = mx_noise_float(vec3(uv().x.mul(11.0), uv().y.mul(9.0), 5.0)).mul(0.5).add(0.5);
    mat.colorNode = texture(benchColor, bUV).rgb
      .mul(mix(float(0.84), float(1.13), blotch))
      .mul(mix(float(1.0), float(0.93), wear)) // scuffed patches read slightly greyer
      .mul(tint).mul(vec3(1.02, 0.96, 0.9));

    // The plane's geometry is pre-rotated, so its tangent frame is world-aligned and
    // exact: u runs along +X, v along -Z, normal +Y. Building the frame by hand (rather
    // than through normalMap(), which falls back to a screen-space derivative frame on
    // a geometry with no tangent attribute) also lets an analytic grain ripple ride
    // along with the photographed normal.
    const bT = transformNormalToView(vec3(1, 0, 0));
    const bB = transformNormalToView(vec3(0, 0, -1));
    const bN = transformNormalToView(vec3(0, 1, 0));
    const nTS = texture(benchNormal, bUV).xyz.mul(2.0).sub(1.0);
    // Grain runs along X, so the ridges vary across Z. Faded out with distance before
    // the period drops under a pixel and starts to shimmer.
    // Grain lines run along X, so the relief varies across Z. Noise stretched along the
    // grain, never a cosine: the deck catches a grazing specular band where a periodic
    // ridge reads as machined corrugation, and the amplitude that looks right head-on is
    // ten times too strong inside that highlight.
    // fwidth on the feature count is the only fade that holds here — the deck is seen
    // almost edge-on, so its grain is foreshortened perhaps tenfold and a distance fade
    // left the far half shimmering.
    const gCoord = positionWorld.z.mul(230.0); // grain features ~4 mm apart
    const gAt = (c) => mx_noise_float(vec3(positionWorld.x.mul(1.7), c, 11.0));
    const gAA = saturate(float(0.5).sub(fwidth(gCoord)).mul(3.0));
    const ripple = gAt(gCoord.add(0.3)).sub(gAt(gCoord)).mul(0.24).mul(gAA);
    mat.normalNode = normalize(
      bT.mul(nTS.x.mul(0.95))
        .add(bB.mul(nTS.y.mul(0.95).add(ripple)))
        .add(bN.mul(nTS.z)),
    );

    // A finish, not a constant: waxed patches are smoother and hold a tighter coat,
    // worn ones scatter. This variation is most of what reads as "a real surface".
    const rough = texture(benchRough, bUV).r;
    mat.roughnessNode = saturate(rough.mul(0.5).add(0.2).add(wear.sub(0.5).mul(0.34)));
    // Waxed, not lacquered: a tight coat turns the grazing sun into a plastic sheen.
    mat.clearcoatNode = mix(float(0.24), float(0.06), wear);
    mat.clearcoatRoughnessNode = mix(float(0.3), float(0.65), wear);
    mat.metalness = 0;
    const geo = new THREE.PlaneGeometry(BENCH.w, BENCH.d);
    geo.rotateX(-Math.PI / 2);
    const bench = new THREE.Mesh(geo, mat);
    bench.position.z = BENCH.cz;
    bench.receiveShadow = true;
    scene.add(bench);
  }

  // ── Placement: uniform on SCREEN, so the hero reads as a carpet edge to edge ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();
  const placeOnScreen = (span) => (out) => {
    for (let k = 0; k < 8; k++) {
      ndc.set(U(-span, span), span - 2 * span * Math.pow(rnd(), 0.72));
      ray.setFromCamera(ndc, camera);
      if (ray.ray.intersectPlane(ground, hit) && Math.abs(hit.x) < SIM.x && hit.z > SIM.zMin && hit.z < SIM.zMax) {
        out.copy(hit); return;
      }
    }
    out.set(U(-SIM.x, SIM.x), 0, U(SIM.zMin, SIM.zMax));
  };

  const shavings = createSystem({
    count: SHAVINGS, segs: STRIP_SEGS, makeParams: makeShavingParams, shared,
    place: placeOnScreen(1.12),
    cfg: {
      push: 1.0, lift: 0.55, threshold: 0.3, airCouple: 8.5, gravity: 9.81, pop: 1.4, spin: 18,
      groundFriction: 10, flutter: 1.0, flutterHz: 7, edgeNoise: 0.16,
      // fibres per metre across the ribbon, and how deep their ridges stand (metres)
      fibreDensity: 620, fibreStretch: 11, fibreSlope: 0.42, chatterDensity: 70, chatterRelief: 5e-5,
      brightness: 1.02, translucency: 0.28,
    },
  });
  const sawdust = createSystem({
    count: SAWDUST, segs: 1, makeParams: makeSawdustParams, shared,
    place: placeOnScreen(1.15),
    cfg: {
      push: 0.9, lift: 0.9, threshold: 0.16, airCouple: 16, gravity: 9.81, pop: 1.2, spin: 40,
      groundFriction: 12, flutter: 1.2, flutterHz: 11, edgeNoise: 0.0,
      fibreDensity: 1500, fibreStretch: 14, fibreSlope: 0.16, chatterDensity: 180, chatterRelief: 1e-5,
      brightness: 1.0, translucency: 0.2,
    },
  });
  scene.add(shavings.mesh, sawdust.mesh);

  // ── Pointer → breath ──────────────────────────────────────────────────────────
  const mouseNdc = new THREE.Vector2(0, -2);
  const mouseWorld = new THREE.Vector3(0, 0, 99);
  const prevWorld = new THREE.Vector3();
  const velTarget = new THREE.Vector3();
  let pointerOn = false, puff = 0, blow = 0, speedCharge = 0;
  let lastMove = performance.now();
  const parallax = new THREE.Vector2();

  const onMove = (e) => {
    mouseNdc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    pointerOn = true;
    lastMove = performance.now();
  };
  addEventListener("pointermove", onMove, { passive: true });
  addEventListener("pointerdown", (e) => { onMove(e); puff = 1.0; }, { passive: true });
  addEventListener("pointerleave", () => { pointerOn = false; });
  document.addEventListener("mouseleave", () => { pointerOn = false; });

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ── Loop ──────────────────────────────────────────────────────────────────────
  let prevNow = performance.now();
  let frames = 0, statT = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min((now - prevNow) / 1000, 1 / 30);
    prevNow = now;
    shared.uTime.value += dt;

    // Pointer on the bench plane.
    if (pointerOn) {
      ray.setFromCamera(mouseNdc, camera);
      if (ray.ray.intersectPlane(ground, hit)) {
        if (mouseWorld.z > 50) prevWorld.copy(hit);
        mouseWorld.copy(hit);
      }
    } else {
      mouseWorld.set(0, 0, 99);
    }
    velTarget.subVectors(mouseWorld, prevWorld).multiplyScalar(dt > 0 ? 1 / dt : 0);
    if (mouseWorld.z > 50 || prevWorld.z > 50) velTarget.set(0, 0, 0);
    velTarget.clampLength(0, 3.5);
    prevWorld.copy(mouseWorld);
    shared.uMouseVel.value.lerp(velTarget, 1 - Math.exp(-dt * 9));
    shared.uMouse.value.copy(mouseWorld);

    // Breath envelope: a steady breath under the pointer, charged by motion, plus a puff on click.
    const speed = shared.uMouseVel.value.length();
    speedCharge = Math.max(speedCharge * Math.exp(-dt * 2.2), Math.min(1, speed * 0.5));
    puff *= Math.exp(-dt * 3.2);
    const idle = pointerOn ? (performance.now() - lastMove < 2500 ? 0.22 : 0.06) : 0;
    const target = Math.min(1.6, idle + speedCharge + puff * 1.4);
    blow += (target - blow) * (1 - Math.exp(-dt * 10));
    shared.uBlow.value = blow;

    // Two substeps keep the settle stable at low frame rates.
    shared.uDt.value = dt * 0.5;
    renderer.compute(shavings.update);
    renderer.compute(sawdust.update);
    renderer.compute(shavings.update);
    renderer.compute(sawdust.update);

    // Subtle camera parallax against the pointer.
    parallax.lerp(pointerOn ? mouseNdc : new THREE.Vector2(0, 0), 1 - Math.exp(-dt * 2.5));
    camera.position.set(CAMERA.pos.x - parallax.x * 0.025, CAMERA.pos.y - parallax.y * 0.012, CAMERA.pos.z);
    camera.lookAt(CAMERA.look);

    renderer.render(scene, camera);

    frames++; statT += dt;
    if (statT >= 0.5 && onStats) { onStats({ fps: frames / statT }); frames = 0; statT = 0; }
  });

  return { renderer, scene, camera, shared, sun, CAMERA, systems: { shavings, sawdust } };
}
