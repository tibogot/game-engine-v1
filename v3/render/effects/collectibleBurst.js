/**
 * Pickup particle burst — single shared InstancedMesh, ring-buffered.
 * TSL node material reads per-instance origin / velocity / birth / color and
 * computes position + alpha on the GPU. Cheap and fire-and-forget.
 *
 * One mesh, many simultaneous bursts — `burstAt(pos, color)` writes ~16 particles
 * into the ring and bumps a uniform clock.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  vec3, float, uniform, attribute, positionLocal,
  sub, smoothstep, max, greaterThanEqual,
} from "three/tsl";

const MAX_PARTICLES   = 256;
const PARTICLES_PER_BURST = 16;
const LIFETIME_SEC    = 0.6;
const SPEED           = 3.0;   // m/s outward
const GRAVITY         = 4.5;   // m/s^2 down
const QUAD_SIZE       = 0.18;

export function createCollectibleBurst(scene) {
  // Camera-facing tiny quad; we'll fake billboarding by rotating per particle via TSL? Simpler: use a Sprite-like
  // billboard rendered as a Plane that's always camera-facing — handled per-frame on CPU is overkill, so we render
  // a small quad in world XY plane and rely on additive blending — looks like a star/spark and reads fine.
  // For nicer look we point the quad's normal at camera by writing positionLocal in TSL with a tiny offset basis.
  const planeGeo = new THREE.PlaneGeometry(QUAD_SIZE, QUAD_SIZE);

  // Per-instance attributes (filled at burst time, ring-buffered).
  const aOrigin = new Float32Array(MAX_PARTICLES * 3);
  const aDir    = new Float32Array(MAX_PARTICLES * 3);
  const aBirth  = new Float32Array(MAX_PARTICLES);
  const aColor  = new Float32Array(MAX_PARTICLES * 3);

  // Initialize birth far in the past so all particles are dead → alpha 0.
  for (let i = 0; i < MAX_PARTICLES; i++) aBirth[i] = -999.0;

  const iOrigin = new THREE.InstancedBufferAttribute(aOrigin, 3);
  const iDir    = new THREE.InstancedBufferAttribute(aDir, 3);
  const iBirth  = new THREE.InstancedBufferAttribute(aBirth, 1);
  const iColor  = new THREE.InstancedBufferAttribute(aColor, 3);
  iOrigin.setUsage(THREE.DynamicDrawUsage);
  iDir.setUsage(THREE.DynamicDrawUsage);
  iBirth.setUsage(THREE.DynamicDrawUsage);
  iColor.setUsage(THREE.DynamicDrawUsage);

  const instGeo = new THREE.InstancedBufferGeometry();
  // Copy plane attrs (position, normal, uv, index) into the instanced geometry.
  instGeo.index = planeGeo.index;
  for (const key of Object.keys(planeGeo.attributes)) {
    instGeo.setAttribute(key, planeGeo.attributes[key]);
  }
  instGeo.setAttribute("aOrigin", iOrigin);
  instGeo.setAttribute("aDir",    iDir);
  instGeo.setAttribute("aBirth",  iBirth);
  instGeo.setAttribute("aColor",  iColor);
  instGeo.instanceCount = MAX_PARTICLES;

  const uClock = uniform(0.0);
  const uLife  = uniform(LIFETIME_SEC);
  const uSpeed = uniform(SPEED);
  const uGrav  = uniform(GRAVITY);

  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });

  // Per-vertex: shift quad to world position(origin + dir*age + gravity*age^2 down).
  // We add the local quad offset in world space (no billboarding — additive + small size makes it read like sparks).
  const aOriginNode = attribute("aOrigin", "vec3");
  const aDirNode    = attribute("aDir",    "vec3");
  const aBirthNode  = attribute("aBirth",  "float");
  const aColorNode  = attribute("aColor",  "vec3");

  const ageRaw = sub(uClock, aBirthNode);
  // Clamp negative ages to 0 so dead particles collapse to origin (then alpha kills them).
  const age = max(ageRaw, float(0.0));
  const tNorm = age.div(uLife);

  const offset = aOriginNode
    .add(aDirNode.mul(age).mul(uSpeed))
    .add(vec3(0, -1, 0).mul(uGrav).mul(age).mul(age).mul(0.5));

  mat.positionNode = positionLocal.add(offset);

  // Fade out + ease for the alpha; multiply tint by quick falloff.
  const alive = smoothstep(float(1.0), float(0.0), tNorm); // 1 at birth → 0 at lifetime
  const aliveMask = smoothstep(float(0.0), float(0.001), ageRaw); // kill before birth
  mat.colorNode   = aColorNode.mul(alive.add(0.4));
  mat.opacityNode = alive.mul(aliveMask);

  // Skip fragment shader entirely for dead particles — major perf win when many bursts have decayed
  // (no overdraw, no blending of zero-alpha fragments).
  mat.discardNode = greaterThanEqual(tNorm, float(1.0));

  const mesh = new THREE.Mesh(instGeo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  scene.add(mesh);

  let cursor = 0;
  const _tmp = new THREE.Vector3();

  /**
   * Spawn a burst at `pos`, tinted `color` (THREE.Color or hex).
   */
  function burstAt(pos, color) {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    const cr = c.r, cg = c.g, cb = c.b;
    const now = uClock.value;
    for (let i = 0; i < PARTICLES_PER_BURST; i++) {
      const idx = cursor;
      cursor = (cursor + 1) % MAX_PARTICLES;

      // Random direction biased upward.
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1) * 0.5; // upper hemisphere bias
      const sx = Math.sin(phi) * Math.cos(theta);
      const sy = Math.cos(phi) + 0.4;
      const sz = Math.sin(phi) * Math.sin(theta);
      _tmp.set(sx, sy, sz).normalize().multiplyScalar(0.8 + Math.random() * 0.6);

      aOrigin[idx * 3 + 0] = pos.x;
      aOrigin[idx * 3 + 1] = pos.y;
      aOrigin[idx * 3 + 2] = pos.z;

      aDir[idx * 3 + 0] = _tmp.x;
      aDir[idx * 3 + 1] = _tmp.y;
      aDir[idx * 3 + 2] = _tmp.z;

      aColor[idx * 3 + 0] = cr;
      aColor[idx * 3 + 1] = cg;
      aColor[idx * 3 + 2] = cb;

      aBirth[idx] = now;
    }
    iOrigin.needsUpdate = true;
    iDir.needsUpdate = true;
    iColor.needsUpdate = true;
    iBirth.needsUpdate = true;
  }

  /**
   * Advance the burst clock. Call once per frame.
   */
  function update(dt) {
    uClock.value += dt;
  }

  function dispose() {
    scene.remove(mesh);
    instGeo.dispose();
    mat.dispose();
  }

  function reset() {
    for (let i = 0; i < MAX_PARTICLES; i++) aBirth[i] = -999.0;
    iBirth.needsUpdate = true;
    cursor = 0;
  }

  return { burstAt, update, dispose, reset, mesh };
}
