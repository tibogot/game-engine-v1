// LAB ONLY: a small world for the Sky Pro TSL lab, so the haze, sun shafts and cloud shadows have
// something to act on. Flat sand round the camera (sea level, like the analytic lab ground), hills
// rising 1-4 km out (aerial perspective), a colonnade and a few blocks west of the camera (the
// afternoon sun is in the west: shafts through the columns from the "Toward sun" view).
//
// Lighting, in the same units as the clouds (our sky: sun 20):
//  - the sun: a DirectionalLight whose colorNode = sun colour x the Sky Pro cloud shadow. The colorNode
//    must be set when the light is made (three reads it once — memory ref_light_colornode_once). three's
//    Lambert is albedo / PI x E, which is Tidewater's lighting.js (directDiffuse = sunColor N.L albedo / PI).
//  - ambient, as emissive (a STAND-IN until the environment map and ground-bounce map of step 3b),
//    both already / PI like Tidewater's hooks:
//    sky = Tidewater lighting.js's fallback hookEnvDiffuse: mix( horizon x 0.25, skyIrradiance, N.y / 2 + 0.5 )
//    (the Sky Pro atmosphere's irradianceNode / horizonNode, Tidewater's irradiance kernel);
//    bounce = Tidewater GroundBounce.js for a flat sand floor: ground albedo x sun colour x sun height x
//    cloud shadow x the lower view factor (1 - N.y) / 2 x 0.6 (SURROUND) / PI.

import * as THREE from "three/webgpu";
import { uniform, vec3, positionWorld, normalWorld, mix, shadow } from "three/tsl";

// value noise (Math.imul, or the hash degenerates — memory ref_js_value_noise_imul)
function hash2(ix, iz) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) & 0xffffff) / 0xffffff;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function fbm(x, z) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < 5; i++) { s += vnoise(x * f, z * f) * a; a *= 0.5; f *= 2.03; }
  return s;
}
/** Ground height (m): 0 within ~700 m of the origin, hills beyond. */
export function labHeight(x, z) {
  const r = Math.hypot(x, z);
  const ramp = THREE.MathUtils.smoothstep(r, 700, 2500);
  const n = fbm(x / 2200 + 11.3, z / 2200 + 4.7);
  return Math.max(0, (n - 0.35) * 1.8) * 520 * ramp;
}

export function createLabScene({ clouds, atmosphere }) {
  const scene = new THREE.Scene();

  // ---- terrain
  const SIZE = 30000, SEG = 300;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, labHeight(pos.getX(i), pos.getZ(i)));
  geo.computeVertexNormals();

  const uSunCol = uniform(new THREE.Vector3(1, 1, 1));
  const uLight = uniform(new THREE.Vector3(0, 1, 0));
  const GROUND_ALBEDO = [0.33, 0.29, 0.22];
  const ny = normalWorld.y;
  const skyAmb = mix(atmosphere.horizonNode.mul(0.25), atmosphere.irradianceNode, ny.mul(0.5).add(0.5)); // (never a.mix(b,t): memory ref_tsl_mix_method_factor)
  const bounce = vec3(...GROUND_ALBEDO).mul(uSunCol).mul(uLight.y.max(0.0)).mul(clouds.shadowAt(positionWorld.xz))
    .mul(ny.oneMinus().mul(0.5)).mul(0.6 / Math.PI);
  const uFallback = uniform(0); // 1 = the stand-in ambient below, 0 = the sky environment (envTSL.js)
  const lit = (albedo) => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
    const a = vec3(...albedo);
    m.colorNode = a;
    m.emissiveNode = a.mul(skyAmb.add(bounce)).mul(uFallback);
    return m;
  };
  const ground = new THREE.Mesh(geo, lit(GROUND_ALBEDO));
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- a colonnade and a few blocks, west of the camera
  const stone = lit([0.42, 0.38, 0.33]);
  const col = new THREE.BoxGeometry(2.4, 26, 2.4);
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(col, stone);
      m.position.set(-70 - row * 14, 13, -48 + i * 12);
      m.castShadow = m.receiveShadow = true;
      scene.add(m);
    }
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(18, 2, 104), stone);
  lintel.position.set(-77, 27, 0);
  lintel.castShadow = lintel.receiveShadow = true;
  scene.add(lintel);
  const blocks = [[-190, 40, 30, 60, 80, 0.3], [-260, -120, 70, 40, 50, -0.4], [-140, 160, 24, 30, 26, 0.9], [40, -120, 18, 12, 18, 0.2]];
  for (const [x, z, w, h, d, ry] of blocks) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
    m.position.set(x, h / 2, z);
    m.rotation.y = ry;
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
  }

  // ---- the sun (colour x PI x cloud shadow; see the header)
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.colorNode = vec3(uSunCol).mul(clouds.shadowAt(positionWorld.xz));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const R = 320;
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 4000 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  // our own ShadowNode, handed to the light before its first render: three r184 keeps the shadow map
  // inside the node (light.shadow.map stays null on WebGPU), and the haze march reads that map
  const shadowNode = shadow(sun);
  sun.shadow.shadowNode = shadowNode;
  scene.add(sun, sun.target);

  const _c = new THREE.Vector3();
  /** Per frame: the key light's direction and colour (our units); the shadow box follows the camera. */
  function update(camera, lightDir, sunColor) {
    uSunCol.value.copy(sunColor);
    uLight.value.copy(lightDir);
    // snap the box centre to the shadow texel grid (in light space) so the edges don't crawl
    const texel = (2 * R) / sun.shadow.mapSize.x;
    _c.copy(camera.position);
    _c.x = Math.round(_c.x / texel) * texel;
    _c.z = Math.round(_c.z / texel) * texel;
    _c.y = 0;
    sun.target.position.copy(_c);
    sun.position.copy(_c).addScaledVector(lightDir, 2000);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  /** env: a texture for scene.environment (the sky, envTSL.js), or null = the stand-in ambient */
  function setEnvironment(env) {
    if (env && scene.environment !== env) scene.environment = env;
    scene.environmentIntensity = env ? 1 : 0;
    uFallback.value = env ? 0 : 1;
  }

  return { scene, sun, update, labHeight, setEnvironment, GROUND_ALBEDO, get shadowDepth() { return shadowNode.shadowMap ? shadowNode.shadowMap.depthTexture : null; } };
}
