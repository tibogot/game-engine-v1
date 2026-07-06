/**
 * V3 flight mode — v3-native physics (flightController.js), v2-style visuals/camera/gun.
 * v2/play/playMode.js fly physics is unchanged; this module does not import it.
 */
import * as THREE from "three";
import { loadTreeGlbFromUrl } from "../../v2/core/foliage/glbLoader.js";
import { createPlaneGun } from "./planeGun.js";
import { FlightController, DEFAULT_FLIGHT_PARAMS } from "./flightController.js";
import { createFlightCollider } from "./flightCollider.js";

const CAP_R = 0.4;
const CAP_H = 1.2;

export const FLY_MOUSE_SENS_X = DEFAULT_FLIGHT_PARAMS.mouseSensX;
export const FLY_MOUSE_SENS_Y = DEFAULT_FLIGHT_PARAMS.mouseSensY;
const FLY_CAM_SPRING = 5;

const PLANE_URLS = [
  "../models/wenning_carsten_gameart_plane_compressed.glb",
  "/models/wenning_carsten_gameart_plane_compressed.glb",
  "/models/heli5.glb",
];

export function createFlightMode({
  scene,
  sampleGroundY,
  getTerrainHeight,
  getCliffBvh = () => null,
  getTreeBvh = () => null,
}) {
  const ctrl = new FlightController();
  const collider = createFlightCollider({
    getWorld: getCliffBvh,
    getTreeBvh,
  });

  let planeRoot = null;
  let planeInner = null;
  let planeLoaded = false;
  let _flyCamYaw = null;

  let wireMesh = null;
  let wireOn = false;

  const gun = createPlaneGun(scene);

  async function loadPlane(urlIdx = 0) {
    if (urlIdx >= PLANE_URLS.length) {
      console.warn("[Play] Flight: no plane GLB loaded");
      return;
    }
    const url = PLANE_URLS[urlIdx];
    try {
      const { submeshes } = await loadTreeGlbFromUrl(url);
      const inner = new THREE.Group();
      for (const sm of submeshes) {
        const mesh = new THREE.Mesh(sm.geometry, sm.material);
        mesh.applyMatrix4(sm.localMatrix);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        inner.add(mesh);
      }
      inner.rotation.y = Math.PI;
      inner.updateMatrixWorld(true);
      const box0 = new THREE.Box3().setFromObject(inner);
      if (!box0.isEmpty()) {
        const size0 = box0.getSize(new THREE.Vector3());
        const max0 = Math.max(size0.x, size0.y, size0.z);
        const targetSpan = 2.8 * (CAP_H + 2 * CAP_R);
        inner.scale.setScalar(targetSpan / max0);
        inner.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(inner);
        inner.position.set(
          -((box.min.x + box.max.x) * 0.5),
          -box.min.y,
          -((box.min.z + box.max.z) * 0.5),
        );
      }
      planeRoot = new THREE.Group();
      planeRoot.rotation.order = "YXZ";
      planeRoot.add(inner);
      planeRoot.visible = false;
      scene.add(planeRoot);
      planeInner = inner;
      gun.setupMuzzles(inner);
      planeLoaded = true;
      console.log(`[Play] Flight loaded (${url}) — v3 physics`);
    } catch (err) {
      console.warn(`[Play] Flight load failed (${url}):`, err);
      loadPlane(urlIdx + 1);
    }
  }
  loadPlane();

  const state = {
    get heading() { return ctrl.heading; },
    get barrelActive() { return ctrl.barrelActive; },
    get barrelPhase() { return ctrl.barrelPhase; },
  };

  function resetFrom(x, y, z, yaw) {
    ctrl.reset(x, y, z, yaw);
    _flyCamYaw = null;
    gun.clear();
    return { x, y: ctrl.position.y, z };
  }

  function triggerBarrelRoll() {
    if (!planeLoaded) return;
    ctrl.triggerBarrelRoll();
  }

  function applyMouse(mx, my, wx, wz) {
    const p = ctrl.params;
    const fromY = ctrl.position.y + 1.0;
    const terrainY = getTerrainHeight(wx, wz);
    let groundY = sampleGroundY(wx, wz, fromY);
    if (terrainY > fromY) {
      const bvhY = collider.raycastHeightFrom?.(wx, fromY, wz);
      groundY = bvhY ?? terrainY;
    }
    const onDeck =
      (ctrl.position.y - groundY) < p.deckAglMax &&
      ctrl.horizontalSpeed() < p.deckSpeedMax;
    ctrl.applyMouse(mx, my, { onDeck });
  }

  function updateWireframe(visible) {
    wireOn = !!visible;
    if (!wireOn) {
      if (wireMesh) wireMesh.visible = false;
      return;
    }
    const r = ctrl.params.sphereRadius;
    if (!wireMesh) {
      wireMesh = new THREE.Mesh(
        new THREE.SphereGeometry(r, 12, 8),
        new THREE.MeshBasicMaterial({
          color: 0x66ccff,
          wireframe: true,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        }),
      );
      wireMesh.frustumCulled = false;
      scene.add(wireMesh);
    } else if (Math.abs(wireMesh.geometry.parameters.radius - r) > 0.01) {
      wireMesh.geometry.dispose();
      wireMesh.geometry = new THREE.SphereGeometry(r, 12, 8);
    }
    wireMesh.visible = true;
    wireMesh.position.copy(ctrl.position);
  }

  function update(dt, keys, pos) {
    ctrl.update(dt, keys, { collider, sampleGroundY, getTerrainHeight });
    pos.copy(ctrl.position);
    updateWireframe(wireOn);
    return pos;
  }

  function syncVisuals(pos, visible) {
    if (!planeRoot) return;
    const show = visible && planeLoaded;
    planeRoot.visible = show;
    if (!show) {
      gun.clear();
      return;
    }
    planeRoot.position.copy(ctrl.position);
    let barrelAdd = 0;
    if (ctrl.barrelActive) {
      const t = Math.min(1, ctrl.barrelPhase);
      barrelAdd = t * t * (3 - 2 * t) * Math.PI * 2 * ctrl.barrelDir;
    }
    planeRoot.rotation.set(
      ctrl.pitch,
      ctrl.heading,
      ctrl.roll + barrelAdd + ctrl.aileronAngle,
    );
  }

  function positionCamera(camera, lookAtX, lookAtY, lookAtZ, camPitch, camDist, dt) {
    const desiredCamYaw = ctrl.heading + ctrl.groundCamYawOff;
    if (_flyCamYaw === null) _flyCamYaw = desiredCamYaw;
    else {
      let delta = desiredCamYaw - _flyCamYaw;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      _flyCamYaw += delta * (1 - Math.exp(-FLY_CAM_SPRING * dt));
    }

    const hDist = camDist * Math.cos(camPitch);
    const vDist = camDist * Math.sin(camPitch);
    const sinH = Math.sin(_flyCamYaw);
    const cosH = Math.cos(_flyCamYaw);
    const a = ctrl.aileronAngle;
    const sinA = Math.sin(a);
    const cosA = Math.cos(a);

    camera.position.set(
      lookAtX + sinH * hDist - cosH * sinA * vDist,
      lookAtY + cosA * vDist,
      lookAtZ + cosH * hDist + sinH * sinA * vDist,
    );
    camera.up.set(-cosH * sinA, cosA, sinH * sinA);
    camera.lookAt(lookAtX, lookAtY, lookAtZ);
  }

  function updateGun(dt, camera, firing) {
    if (!planeRoot?.visible) {
      gun.clear();
      return;
    }
    gun.update(dt, camera, firing, planeRoot, planeInner);
  }

  return {
    get loaded() { return planeLoaded; },
    get state() { return state; },
    get speed() { return ctrl.speed(); },
    get controller() { return ctrl; },
    resetFrom,
    triggerBarrelRoll,
    applyMouse,
    update,
    syncVisuals,
    positionCamera,
    updateGun,
    setShowCollider(v) { updateWireframe(v); },
    get showCollider() { return wireOn; },
    getFlightParams() { return { ...ctrl.params }; },
    setFlightParams(patch) { ctrl.setParams(patch); },
    resetFlightParams() {
      ctrl.setParams({ ...DEFAULT_FLIGHT_PARAMS });
      ctrl.thrustReserve = 1;
    },
    getHudState() { return ctrl.getHudState(); },
    dispose() {
      gun.dispose();
      if (wireMesh) {
        scene.remove(wireMesh);
        wireMesh.geometry.dispose();
        wireMesh.material.dispose();
        wireMesh = null;
      }
      if (planeRoot) {
        scene.remove(planeRoot);
        planeRoot.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
            else o.material.dispose();
          }
        });
      }
      planeRoot = null;
      planeInner = null;
      planeLoaded = false;
    },
  };
}
