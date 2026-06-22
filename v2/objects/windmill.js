import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";

/**
 * Wind turbine GLB along a spline — static tower/nacelle, spinning hub + blades.
 * Rotor parts: Plane (blades) + Circle002 (hub). Static: Circle + Circle001.
 */

export const WINDMILL_DEFAULTS = {
  modelPath: "/models/wind-farm3_compressed (1).glb",
  spacing: 72,
  sideOffset: 0,
  side: "right",
  scale: 1,
  /** Blade rotation speed in degrees per second. */
  rotorSpeedDeg: 36,
  /** Local axis on WindmillRotor group: x | y | z */
  rotorAxis: "z",
  facePath: true,
};

const _tangent = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _box = new THREE.Box3();

let _template = null;
let _loadPromise = null;

function sideSign(side) {
  return side === "left" ? 1 : -1;
}

function setupDracoLoader(loader) {
  const draco = new DRACOLoader();
  draco.setDecoderPath(
    "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/",
  );
  loader.setDRACOLoader(draco);
  return draco;
}

/** One-time reparent: only Plane + Circle002 under a pivot at the hub. */
function prepareWindmillTemplate(gltfScene) {
  const template = new THREE.Group();
  template.name = "WindmillTemplate";

  const circle = gltfScene.getObjectByName("Circle");
  const circle001 = gltfScene.getObjectByName("Circle001");
  const circle002 = gltfScene.getObjectByName("Circle002");
  const plane = gltfScene.getObjectByName("Plane");

  if (circle) template.add(circle);
  if (circle001) template.add(circle001);

  const rotor = new THREE.Group();
  rotor.name = "WindmillRotor";
  if (circle002) rotor.position.copy(circle002.position);
  else if (plane) rotor.position.copy(plane.position);
  template.add(rotor);

  if (circle002) rotor.attach(circle002);
  if (plane) rotor.attach(plane);

  template.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return template;
}

/**
 * Load and cache the windmill template (safe to call multiple times).
 * @param {string} [modelPath]
 */
export function preloadWindmillModel(modelPath = WINDMILL_DEFAULTS.modelPath) {
  if (_template) return Promise.resolve(_template);
  if (_loadPromise) return _loadPromise;

  _loadPromise = new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    const draco = setupDracoLoader(loader);
    loader.load(
      modelPath,
      (gltf) => {
        draco.dispose();
        _template = prepareWindmillTemplate(gltf.scene);
        resolve(_template);
      },
      undefined,
      (err) => {
        _loadPromise = null;
        reject(err);
      },
    );
  });

  return _loadPromise;
}

export function isWindmillModelReady() {
  return _template !== null;
}

function cloneWindmillUnit(params) {
  const p = { ...WINDMILL_DEFAULTS, ...params };
  const unit = _template.clone(true);
  unit.name = "WindmillUnit";
  unit.userData.windmillUnit = true;
  const s = Math.max(0.05, p.scale);
  unit.scale.setScalar(s);
  return unit;
}

function groundUnit(unit, x, groundY, z) {
  unit.position.set(x, 0, z);
  unit.updateMatrixWorld(true);
  _box.setFromObject(unit);
  unit.position.y = groundY - _box.min.y;
}

/**
 * @param {THREE.Object3D} root
 * @param {object} params
 * @param {number} dt
 */
export function updateWindmillRotors(root, params = {}, dt = 0) {
  if (!root || dt <= 0) return;
  const p = { ...WINDMILL_DEFAULTS, ...params };
  const axis = p.rotorAxis === "x" || p.rotorAxis === "y" ? p.rotorAxis : "z";
  const delta = THREE.MathUtils.degToRad(p.rotorSpeedDeg) * dt;
  root.traverse((o) => {
    if (o.name === "WindmillRotor") o.rotation[axis] += delta;
  });
}

export function disposeWindmillGroup(group) {
  // Windmill units are clones of a shared, app-lifetime template, and
  // Object3D.clone() copies geometry/material *references* — it does not
  // deep-copy them. So every clone shares the template's geometry + material.
  // Disposing them here would destroy the template's GPU buffers and make
  // every subsequent windmill build render a destroyed buffer ("used in
  // submit while destroyed"). Nothing in a clone owns GPU data, so detaching
  // is all that's needed; the caller already removes it from the scene.
  if (!group) return;
  if (group.parent) group.parent.remove(group);
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} opts.points
 * @param {boolean} [opts.closed]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group|null}
 */
export function buildWindmillMesh({
  points,
  closed = false,
  params = {},
  getWorldHeight = () => 0,
}) {
  if (!_template || !Array.isArray(points) || points.length < 1) return null;

  const p = { ...WINDMILL_DEFAULTS, ...params };
  const spacing = Math.max(4, p.spacing);
  const offset = p.sideOffset;
  const sign = sideSign(p.side);

  const group = new THREE.Group();
  group.name = "Windmill";
  group.userData.windmill = true;

  if (points.length === 1) {
    const pt = points[0];
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    const unit = cloneWindmillUnit(p);
    let rotY = 0;
    if (pt.heading != null) {
      rotY = pt.heading;
    } else if (p.faceOutwardFrom) {
      const ox = v.x - p.faceOutwardFrom.x;
      const oz = v.z - p.faceOutwardFrom.z;
      if (ox * ox + oz * oz > 1e-6) {
        rotY = Math.atan2(ox, oz);
      }
    } else if (p.facePath) {
      rotY = Math.PI * 0.5;
    }
    unit.rotation.y = rotY;
    groundUnit(unit, v.x, getWorldHeight(v.x, v.z), v.z);
    group.add(unit);
    return group;
  }

  const groundedPoints = points.map((pt) => {
    const v = pt.isVector3 ? pt : new THREE.Vector3(pt.x, pt.y, pt.z);
    return new THREE.Vector3(v.x, getWorldHeight(v.x, v.z), v.z);
  });

  const curve = new THREE.CatmullRomCurve3(
    groundedPoints,
    !!closed,
    "catmullrom",
    0.5,
  );

  const length = curve.getLength();
  const count = Math.max(1, Math.floor(length / spacing) + 1);

  for (let i = 0; i < count; i++) {
    const t = closed
      ? i / count
      : count === 1
        ? 0
        : i / Math.max(1, count - 1);

    const pos = curve.getPointAt(t);
    _tangent.copy(curve.getTangentAt(t));
    if (_tangent.lengthSq() < 1e-10) _tangent.set(0, 0, 1);
    _tangent.normalize();
    _perp.set(-_tangent.z, 0, _tangent.x).normalize();

    const px = pos.x + _perp.x * offset * sign;
    const pz = pos.z + _perp.z * offset * sign;
    const groundY = getWorldHeight(px, pz);

    const unit = cloneWindmillUnit(p);
    if (p.facePath) {
      unit.rotation.y = Math.atan2(_tangent.x, _tangent.z);
    }
    groundUnit(unit, px, groundY, pz);
    group.add(unit);
  }

  return group;
}

export const WINDMILL_HERO_POINTS = [{ x: 0, y: 0, z: -14 }];
