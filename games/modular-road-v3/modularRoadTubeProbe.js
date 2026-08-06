import * as THREE from "three";
import { pmremTexture } from "three/tsl";

/**
 * Local cube reflection probe for metallic rideable tubes.
 *
 * IMPORTANT — do NOT hide the tube while capturing. Hiding it leaves the probe
 * staring at the skybox in 5 of 6 directions, so the "metal" just mirrors the
 * sky (exactly the bug we hit). Instead, swap metal draws to a matte occluder
 * for the capture so the tube still blocks the sky, then restore chrome.
 *
 * The chrome material must be created with `envNode` already pointing at this
 * probe (see `createMetallicTubeMaterial` + `attachEnv`). Node materials bake
 * their environment at first compile — assigning envNode later is ignored and
 * they keep `scene.environment` (sky).
 */

const _entry = new THREE.Vector3();
const _exit = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();
const _probePos = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function distPointToSegmentSq(p, a, b, outClosest) {
  _ab.subVectors(b, a);
  const lenSq = _ab.lengthSq();
  let t = 0;
  if (lenSq > 1e-8) {
    t = THREE.MathUtils.clamp(_ap.subVectors(p, a).dot(_ab) / lenSq, 0, 1);
  }
  outClosest.copy(a).addScaledVector(_ab, t);
  return outClosest.distanceToSquared(p);
}

/**
 * @param {object} o
 * @param {THREE.WebGPURenderer|THREE.WebGLRenderer} o.renderer
 * @param {THREE.Scene} o.scene
 * @param {THREE.Material} o.material chrome tube material (envNode attached here)
 * @param {() => Iterable<{pp?:object, connectorIn?:THREE.Matrix4, connectorOut?:THREE.Matrix4}>} o.getPieces
 * @param {() => Iterable<THREE.Object3D>} [o.getMetalDrawables]
 * @param {() => THREE.Vector3|null} o.getCarPos
 * @param {() => THREE.Vector3|null} [o.getCarNormal]
 * @param {() => boolean} [o.isActive]
 * @param {number} [o.size=256]
 * @param {number} [o.near=0.2]
 * @param {number} [o.far=50]
 * @param {number} [o.activateDist=18]
 * @param {number} [o.interval=2]
 */
export function createTubeReflectionProbe({
  renderer,
  scene,
  material,
  getPieces,
  getMetalDrawables = () => [],
  getCarPos,
  getCarNormal = () => _up,
  isActive = () => true,
  size = 256,
  near = 0.2,
  far = 50,
  activateDist = 18,
  interval = 2,
}) {
  const cubeRT = new THREE.CubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
  });
  const cubeCam = new THREE.CubeCamera(near, far, cubeRT);

  // Matte stand-in: occludes sky during capture, contributes almost no specular
  // so the cubemap doesn't feed back into itself.
  const occluderMat = new THREE.MeshStandardNodeMaterial({
    color: new THREE.Color(0x2a2e32),
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
    envMapIntensity: 0,
  });
  occluderMat.envNode = null;

  const envNode = pmremTexture(cubeRT.texture);
  // Bind BEFORE any draw compiles the material — otherwise it latches onto sky.
  material.envNode = envNode;
  material.envMap = cubeRT.texture;
  material.envMapIntensity = 1.75;

  let disposed = false;
  let framesUntilUpdate = 0;
  const activateDistSq = activateDist * activateDist;
  /** @type {THREE.Object3D[]} */
  let swapped = [];

  // Neutral studio fill so chrome reads silver in build mode / before the first
  // live capture (empty cubemap would look black, sky would look like sky).
  {
    const seed = new THREE.Scene();
    seed.background = new THREE.Color(0x9aa3ab);
    const warm = new THREE.Mesh(
      new THREE.SphereGeometry(40, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xd8dde3, side: THREE.BackSide }),
    );
    seed.add(warm);
    const key = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    key.position.set(0, 12, -8);
    key.lookAt(0, 0, 0);
    seed.add(key);
    cubeCam.position.set(0, 0, 0);
    cubeCam.update(renderer, seed);
    warm.geometry.dispose();
    warm.material.dispose();
    key.geometry.dispose();
    key.material.dispose();
  }

  function findNearbyMetal(carPos) {
    let best = null;
    let bestD = activateDistSq;
    for (const p of getPieces()) {
      if (!p?.pp?.tubeMetal) continue;
      const cin = p.connectorIn;
      const cout = p.connectorOut;
      if (!cin || !cout) continue;
      _entry.setFromMatrixPosition(cin);
      _exit.setFromMatrixPosition(cout);
      const dSq = distPointToSegmentSq(carPos, _entry, _exit, _closest);
      if (dSq < bestD) {
        bestD = dSq;
        best = p;
      }
    }
    return best ? { piece: best, radius: Math.max(3, best.pp.tubeRadius ?? 8) } : null;
  }

  function beginOcclude() {
    swapped.length = 0;
    for (const o of getMetalDrawables()) {
      if (!o) continue;
      o.userData._chromeMat = o.material;
      o.material = occluderMat;
      swapped.push(o);
    }
  }

  function endOcclude() {
    for (const o of swapped) {
      o.material = o.userData._chromeMat || material;
      delete o.userData._chromeMat;
    }
    swapped.length = 0;
  }

  function update() {
    if (disposed || !isActive()) return;
    const carPos = getCarPos();
    if (!carPos) return;
    const hit = findNearbyMetal(carPos);
    if (!hit) return;

    if (framesUntilUpdate > 0) {
      framesUntilUpdate--;
      return;
    }
    framesUntilUpdate = Math.max(1, interval | 0);

    // Sit near the tube axis so the car is clearly in the cubemap.
    const n = getCarNormal() || _up;
    _probePos.copy(carPos).addScaledVector(n, hit.radius * 0.8);
    cubeCam.position.copy(_probePos);

    beginOcclude();
    try {
      cubeCam.update(renderer, scene);
    } finally {
      endOcclude();
    }
  }

  function dispose() {
    disposed = true;
    if (material.envNode === envNode) material.envNode = null;
    if (material.envMap === cubeRT.texture) material.envMap = null;
    cubeRT.dispose();
    occluderMat.dispose();
  }

  return { update, dispose, cubeRT, envNode };
}
