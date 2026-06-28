/**
 * V3 flight mode — direct port of v2/play/playMode.js fly physics, camera, plane, gun.
 */
import * as THREE from "three";
import { loadTreeGlbFromUrl } from "../../v2/core/foliage/glbLoader.js";
import { createPlaneGun } from "./planeGun.js";

const CAP_R = 0.4;
const CAP_H = 1.2;

const PLANE_MAX_FWD = 56;
const PLANE_MAX_FWD_BOOST = 78;
const PLANE_MAX_REV = 18;
const PLANE_ACCEL = 10.5;
const PLANE_BRAKE = 26;
const PLANE_REV_ACCEL = 8;
const PLANE_COAST = 3.8;
const PLANE_DRAG = 0.014;
const PLANE_DECK_ALT = 1.15;
const PLANE_DECK_COAST_MULT = 2.1;
const STALL_SPEED = 14;
const STALL_SINK_RATE = 6;
export const FLY_MOUSE_SENS_X = 0.0022;
export const FLY_MOUSE_SENS_Y = 0.00235;
const FLY_PITCH_MIN = -1.22;
const FLY_PITCH_MAX = 0.9;
const FLY_ROLL_MAX = 0.78;
const FLY_ROLL_YAW_RATE = 0.9;
const FLY_ROLL_VEL_SCALE = 0.0042;
const FLY_ROLL_SMOOTH = 10;
const FLY_ROLL_TARGET_DECAY = 5;
const FLY_SURFACE_ALT = 1.35;
const FLY_SURFACE_SPEED = 16;
const FLY_AILERON_RATE = 2.8;
const FLY_BARREL_DURATION = 0.88;
const FLY_CAM_SPRING = 5;
const CAM_DIST = 8;

// Match v2/playMode.js PLANE_MODEL path first (../models from v2/), then public/.
const PLANE_URLS = [
  "../models/wenning_carsten_gameart_plane_compressed.glb",
  "/models/wenning_carsten_gameart_plane_compressed.glb",
  "/models/heli5.glb",
];

export function createFlightMode({ scene, sampleGroundY, getCliffBvh = () => null }) {
  let planeRoot = null;
  let planeInner = null;
  let planeLoaded = false;

  let flyHeading = 0;
  let flyPitch = 0;
  let flyRoll = 0;
  let flyRollTarget = 0;
  let flyHeight = 0;
  let planeSpeed = 0;
  let flyAileronAngle = 0;
  let flyGroundCamYawOff = 0;
  let flyBarrelActive = false;
  let flyBarrelPhase = 0;
  let flyBarrelDir = 1;
  let _flyCamYaw = null;

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
      console.log(`[Play] Flight loaded (${url})`);
    } catch (err) {
      console.warn(`[Play] Flight load failed (${url}):`, err);
      loadPlane(urlIdx + 1);
    }
  }
  loadPlane();

  const state = {
    get heading() { return flyHeading; },
    get barrelActive() { return flyBarrelActive; },
    get barrelPhase() { return flyBarrelPhase; },
  };

  function resetFrom(x, y, z, yaw) {
    flyHeading = yaw;
    flyHeight = y;
    flyPitch = 0;
    flyRoll = 0;
    flyRollTarget = 0;
    flyBarrelActive = false;
    flyBarrelPhase = 0;
    flyGroundCamYawOff = 0;
    flyAileronAngle = 0;
    planeSpeed = 0;
    _flyCamYaw = null;
    gun.clear();
    return { x, y: flyHeight, z };
  }

  /** v2 playMode KeyQ handler */
  function triggerBarrelRoll() {
    if (!planeLoaded || flyBarrelActive) return;
    flyBarrelActive = true;
    flyBarrelPhase = 0;
    flyBarrelDir = flyRoll >= 0 ? 1 : -1;
  }

  /** v2 _onMouseMove flying branch */
  function applyMouse(mx, my, wx, wz) {
    const groundY = sampleGroundY(wx, wz);
    const agl = flyHeight - groundY;
    const spd = Math.abs(planeSpeed);
    const onDeck = agl < FLY_SURFACE_ALT && spd < FLY_SURFACE_SPEED;
    if (onDeck) {
      flyGroundCamYawOff -= mx * FLY_MOUSE_SENS_X;
    } else {
      flyGroundCamYawOff = 0;
      flyHeading -= mx * FLY_MOUSE_SENS_X;
      flyPitch = THREE.MathUtils.clamp(
        flyPitch + my * FLY_MOUSE_SENS_Y,
        FLY_PITCH_MIN,
        FLY_PITCH_MAX,
      );
      flyRollTarget = THREE.MathUtils.clamp(
        flyRollTarget - mx * FLY_ROLL_VEL_SCALE,
        -FLY_ROLL_MAX,
        FLY_ROLL_MAX,
      );
    }
  }

  function applyPlaneBvh(px, py, pz, prevX, prevZ, groundY) {
    const cliffBvh = getCliffBvh?.();
    if (!cliffBvh?.baked) return { x: px, z: pz };

    const cosP = Math.cos(flyPitch);
    const sinP = Math.sin(flyPitch);
    const sinH = Math.sin(flyHeading);
    const cosH = Math.cos(flyHeading);
    const fwdX = -sinH * cosP;
    const fwdY = sinP;
    const fwdZ = -cosH * cosP;
    const rightX = cosH;
    const rightZ = -sinH;
    const planeRadius = 2.5;
    const wingSpan = 3.0;

    let x = px;
    let z = pz;
    const moveDx = x - prevX;
    const moveDz = z - prevZ;
    const moveLen = Math.hypot(moveDx, moveDz);
    if (moveLen > 1e-5) {
      const sweep = cliffBvh.raycast3D(prevX, py, prevZ, moveDx, 0, moveDz, moveLen + planeRadius);
      if (sweep) {
        const nx = moveDx / moveLen;
        const nz = moveDz / moveLen;
        const safeDist = Math.max(0, sweep.distance - planeRadius * 0.9);
        x = prevX + nx * safeDist;
        z = prevZ + nz * safeDist;
        planeSpeed *= 0.75;
      }
    }

    const probeDist = Math.max(planeRadius, planeRadius + moveLen);
    const rays = [
      { dx: fwdX, dy: fwdY, dz: fwdZ, dist: probeDist },
      { dx: rightX, dy: 0, dz: rightZ, dist: wingSpan },
      { dx: -rightX, dy: 0, dz: -rightZ, dist: wingSpan },
      { dx: 0, dy: 1, dz: 0, dist: 1.5 },
      { dx: 0, dy: -1, dz: 0, dist: 1.5 },
    ];
    for (const r of rays) {
      const hit = cliffBvh.raycast3D(x, py, z, r.dx, r.dy, r.dz, r.dist);
      if (!hit) continue;
      const pushDist = r.dist - hit.distance;
      if (pushDist <= 0) continue;
      x -= r.dx * pushDist;
      flyHeight -= r.dy * pushDist;
      z -= r.dz * pushDist;
      if (flyHeight < groundY) flyHeight = groundY;
      planeSpeed *= Math.max(0.3, 1 - pushDist * 0.4);
    }
    return { x, z };
  }

  /** v2 playMode update() flying sections */
  function update(dt, keys, pos) {
    const prevX = pos.x;
    const prevZ = pos.z;
    const groundY = sampleGroundY(pos.x, pos.z);

    const thr = keys.w ? 1 : keys.s ? -1 : 0;
    const drag = PLANE_DRAG * planeSpeed * Math.abs(planeSpeed);
    let coast = PLANE_COAST;
    const deckAgl = flyHeight - groundY;
    if (deckAgl < PLANE_DECK_ALT) coast *= PLANE_DECK_COAST_MULT;

    if (thr === 1) {
      let a = PLANE_ACCEL;
      if (keys.shift) a *= 1.5;
      planeSpeed += a * dt;
    } else if (thr === -1) {
      if (planeSpeed > 0.55) planeSpeed -= PLANE_BRAKE * dt;
      else planeSpeed -= PLANE_REV_ACCEL * dt;
    } else {
      if (planeSpeed > 0) planeSpeed = Math.max(0, planeSpeed - (coast + drag) * dt);
      else if (planeSpeed < 0) planeSpeed = Math.min(0, planeSpeed + (coast + drag) * dt);
    }

    const maxFwd = keys.shift ? PLANE_MAX_FWD_BOOST : PLANE_MAX_FWD;
    planeSpeed = THREE.MathUtils.clamp(planeSpeed, -PLANE_MAX_REV, maxFwd);
    if (Math.abs(planeSpeed) < 0.04 && thr === 0) planeSpeed = 0;

    const spdAbs = Math.abs(planeSpeed);
    if (spdAbs > 1e-4) {
      const sg = Math.sign(planeSpeed);
      pos.x -= Math.sin(flyHeading) * sg * spdAbs * dt;
      pos.z -= Math.cos(flyHeading) * sg * spdAbs * dt;
    }

    const agl = flyHeight - groundY;
    const onDeck = agl < FLY_SURFACE_ALT && spdAbs < FLY_SURFACE_SPEED;

    flyHeight = Math.max(
      groundY,
      flyHeight + Math.sin(flyPitch) * planeSpeed * dt,
    );

    if (!onDeck) {
      const stallFrac = THREE.MathUtils.clamp(1 - planeSpeed / STALL_SPEED, 0, 1);
      flyHeight = Math.max(groundY, flyHeight - stallFrac * STALL_SINK_RATE * dt);
    }

    if (onDeck) {
      const deckRate = 1 - Math.exp(-4 * dt);
      flyPitch = THREE.MathUtils.lerp(flyPitch, 0, deckRate);
      flyRollTarget = THREE.MathUtils.lerp(flyRollTarget, 0, deckRate);
      flyHeight = THREE.MathUtils.lerp(flyHeight, groundY, deckRate);
    }

    if (flyBarrelActive) {
      flyBarrelPhase += dt / FLY_BARREL_DURATION;
      if (flyBarrelPhase >= 1) {
        flyBarrelActive = false;
        flyBarrelPhase = 0;
      }
    }

    const dtRoll = Math.min(dt, 0.08);
    flyRollTarget = THREE.MathUtils.lerp(
      flyRollTarget, 0, 1 - Math.exp(-FLY_ROLL_TARGET_DECAY * dtRoll),
    );
    flyRoll = THREE.MathUtils.lerp(
      flyRoll, flyRollTarget, 1 - Math.exp(-FLY_ROLL_SMOOTH * dtRoll),
    );

    if (!onDeck) {
      flyHeading += flyRoll * FLY_ROLL_YAW_RATE * dt;
      if (keys.z) flyAileronAngle += FLY_AILERON_RATE * dt;
      if (keys.c) flyAileronAngle -= FLY_AILERON_RATE * dt;
    } else {
      const lvl = 1 - Math.exp(-3 * dt);
      flyAileronAngle *= 1 - lvl;
      if (Math.abs(flyAileronAngle) < 0.01) flyAileronAngle = 0;
    }

    const bvh = applyPlaneBvh(pos.x, flyHeight, pos.z, prevX, prevZ, groundY);
    pos.x = bvh.x;
    pos.z = bvh.z;
    pos.y = flyHeight;
    return pos;
  }

  /** v2 plane visual sync */
  function syncVisuals(pos, visible) {
    if (!planeRoot) return;
    const show = visible && planeLoaded;
    planeRoot.visible = show;
    if (!show) {
      gun.clear();
      return;
    }
    planeRoot.position.set(pos.x, flyHeight, pos.z);
    let barrelAdd = 0;
    if (flyBarrelActive) {
      const t = Math.min(1, flyBarrelPhase);
      barrelAdd = t * t * (3 - 2 * t) * Math.PI * 2 * flyBarrelDir;
    }
    planeRoot.rotation.set(
      flyPitch,
      flyHeading,
      flyRoll + barrelAdd + flyAileronAngle,
    );
  }

  /** v2 playMode follow camera (flying branch) */
  function positionCamera(camera, lookAtX, lookAtY, lookAtZ, camPitch, camDist, dt) {
    const desiredCamYaw = flyHeading + flyGroundCamYawOff;
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
    const a = flyAileronAngle;
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
    get speed() { return planeSpeed; },
    resetFrom,
    triggerBarrelRoll,
    applyMouse,
    update,
    syncVisuals,
    positionCamera,
    updateGun,
    dispose() {
      gun.dispose();
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
