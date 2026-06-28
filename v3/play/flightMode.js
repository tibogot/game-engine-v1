import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

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

const PLANE_CANDIDATES = [
  "/models/heli5.glb",
  "/models/wenning_carsten_gameart_plane_compressed.glb",
];

function makePlaceholderPlane(scene) {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.35, 2.2),
    new THREE.MeshStandardMaterial({ color: 0x8899aa, roughness: 0.6 }),
  );
  body.position.y = 0.18;
  body.castShadow = true;
  root.add(body);
  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(4.2, 0.06, 0.7),
    new THREE.MeshStandardMaterial({ color: 0x667788, roughness: 0.65 }),
  );
  wing.position.y = 0.22;
  wing.castShadow = true;
  root.add(wing);
  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.5, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x778899 }),
  );
  tail.position.set(0, 0.45, 1.0);
  root.add(tail);
  root.visible = false;
  scene.add(root);
  return { root, loaded: true };
}

/** Flight mode — v2 playMode fly physics port. */
export function createFlightMode({ scene, sampleGroundY, getCliffBvh = () => null }) {
  const state = {
    heading: 0,
    pitch: 0,
    roll: 0,
    rollTarget: 0,
    height: 0,
    speed: 0,
    aileron: 0,
    groundCamYawOff: 0,
    camYaw: null,
    barrelActive: false,
    barrelPhase: 0,
    barrelDir: 1,
  };

  let root = null;
  let loaded = false;
  const loader = getSharedGltfLoader();

  function tryLoad(idx = 0) {
    if (idx >= PLANE_CANDIDATES.length) {
      const ph = makePlaceholderPlane(scene);
      root = ph.root;
      loaded = ph.loaded;
      console.log("[Play] Flight placeholder mesh");
      return;
    }
    loader.load(
      PLANE_CANDIDATES[idx],
      (gltf) => {
        const inner = new THREE.Group();
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            inner.add(o);
          }
        });
        inner.rotation.y = Math.PI;
        inner.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(inner);
        if (!box.isEmpty()) {
          const sz = box.getSize(new THREE.Vector3());
          const span = Math.max(sz.x, sz.y, sz.z);
          inner.scale.setScalar(3.2 / span);
          box.setFromObject(inner);
          inner.position.set(
            -((box.min.x + box.max.x) * 0.5),
            -box.min.y,
            -((box.min.z + box.max.z) * 0.5),
          );
        }
        root = new THREE.Group();
        root.rotation.order = "YXZ";
        root.add(inner);
        root.visible = false;
        scene.add(root);
        loaded = true;
        console.log(`[Play] Flight loaded (${PLANE_CANDIDATES[idx]})`);
      },
      undefined,
      () => tryLoad(idx + 1),
    );
  }
  tryLoad();

  function resetFrom(x, y, z, yaw) {
    state.heading = yaw;
    state.pitch = 0;
    state.roll = 0;
    state.rollTarget = 0;
    state.height = y;
    state.speed = 0;
    state.aileron = 0;
    state.groundCamYawOff = 0;
    state.camYaw = null;
    state.barrelActive = false;
    state.barrelPhase = 0;
    return { x, y: state.height, z };
  }

  function triggerBarrelRoll() {
    if (state.barrelActive) return;
    state.barrelActive = true;
    state.barrelPhase = 0;
    state.barrelDir = state.roll >= 0 ? 1 : -1;
  }

  function applyMouse(mx, my, wx, wz) {
    const groundY = sampleGroundY(wx, wz);
    const agl = state.height - groundY;
    const onDeck = agl < FLY_SURFACE_ALT && Math.abs(state.speed) < FLY_SURFACE_SPEED;
    if (onDeck) {
      state.groundCamYawOff -= mx * FLY_MOUSE_SENS_X;
    } else {
      state.groundCamYawOff = 0;
      state.heading -= mx * FLY_MOUSE_SENS_X;
      state.pitch = THREE.MathUtils.clamp(
        state.pitch + my * FLY_MOUSE_SENS_Y,
        FLY_PITCH_MIN,
        FLY_PITCH_MAX,
      );
      state.rollTarget = THREE.MathUtils.clamp(
        state.rollTarget - mx * FLY_ROLL_VEL_SCALE,
        -FLY_ROLL_MAX,
        FLY_ROLL_MAX,
      );
    }
  }

  function applyCliffCollision(pos, prevX, prevZ, groundY) {
    const cliffBvh = getCliffBvh?.();
    if (!cliffBvh?.baked) return;

    const px = pos.x;
    const py = state.height;
    const pz = pos.z;
    const cosP = Math.cos(state.pitch);
    const sinP = Math.sin(state.pitch);
    const sinH = Math.sin(state.heading);
    const cosH = Math.cos(state.heading);
    const fwdX = -sinH * cosP;
    const fwdY = sinP;
    const fwdZ = -cosH * cosP;
    const rightX = cosH;
    const rightZ = -sinH;
    const planeRadius = 2.5;
    const wingSpan = 3.0;

    const moveDx = px - prevX;
    const moveDz = pz - prevZ;
    const moveLen = Math.hypot(moveDx, moveDz);
    if (moveLen > 1e-5) {
      const sweep = cliffBvh.raycast3D(prevX, py, prevZ, moveDx, 0, moveDz, moveLen + planeRadius);
      if (sweep) {
        const nx = moveDx / moveLen;
        const nz = moveDz / moveLen;
        const safeDist = Math.max(0, sweep.distance - planeRadius * 0.9);
        pos.x = prevX + nx * safeDist;
        pos.z = prevZ + nz * safeDist;
        state.speed *= 0.75;
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
      const hit = cliffBvh.raycast3D(px, py, pz, r.dx, r.dy, r.dz, r.dist);
      if (!hit) continue;
      const pushDist = r.dist - hit.distance;
      if (pushDist <= 0) continue;
      pos.x -= r.dx * pushDist;
      state.height -= r.dy * pushDist;
      pos.z -= r.dz * pushDist;
      if (state.height < groundY) state.height = groundY;
      state.speed *= Math.max(0.3, 1 - pushDist * 0.4);
    }
  }

  function update(dt, keys, pos) {
    const prevX = pos.x;
    const prevZ = pos.z;
    const thr = keys.w ? 1 : keys.s ? -1 : 0;
    const groundY = sampleGroundY(pos.x, pos.z);
    const drag = PLANE_DRAG * state.speed * Math.abs(state.speed);
    let coast = PLANE_COAST;
    const deckAgl = state.height - groundY;
    if (deckAgl < PLANE_DECK_ALT) coast *= PLANE_DECK_COAST_MULT;

    if (thr === 1) {
      let a = PLANE_ACCEL;
      if (keys.shift) a *= 1.5;
      state.speed += a * dt;
    } else if (thr === -1) {
      if (state.speed > 0.55) state.speed -= PLANE_BRAKE * dt;
      else state.speed -= PLANE_REV_ACCEL * dt;
    } else {
      if (state.speed > 0) state.speed = Math.max(0, state.speed - (coast + drag) * dt);
      else if (state.speed < 0) state.speed = Math.min(0, state.speed + (coast + drag) * dt);
    }

    const maxFwd = keys.shift ? PLANE_MAX_FWD_BOOST : PLANE_MAX_FWD;
    state.speed = THREE.MathUtils.clamp(state.speed, -PLANE_MAX_REV, maxFwd);
    if (Math.abs(state.speed) < 0.04 && thr === 0) state.speed = 0;

    const spdAbs = Math.abs(state.speed);
    if (spdAbs > 1e-4) {
      const sg = Math.sign(state.speed);
      pos.x -= Math.sin(state.heading) * sg * spdAbs * dt;
      pos.z -= Math.cos(state.heading) * sg * spdAbs * dt;
    }

    const agl = state.height - groundY;
    const onDeck = agl < FLY_SURFACE_ALT && spdAbs < FLY_SURFACE_SPEED;

    state.height = Math.max(
      groundY,
      state.height + Math.sin(state.pitch) * state.speed * dt,
    );

    if (!onDeck) {
      const stallFrac = THREE.MathUtils.clamp(1 - state.speed / STALL_SPEED, 0, 1);
      state.height = Math.max(groundY, state.height - stallFrac * STALL_SINK_RATE * dt);
    }

    if (onDeck) {
      const deckRate = 1 - Math.exp(-4 * dt);
      state.pitch = THREE.MathUtils.lerp(state.pitch, 0, deckRate);
      state.rollTarget = THREE.MathUtils.lerp(state.rollTarget, 0, deckRate);
      state.height = THREE.MathUtils.lerp(state.height, groundY, deckRate);
    }

    if (state.barrelActive) {
      state.barrelPhase += dt / FLY_BARREL_DURATION;
      if (state.barrelPhase >= 1) {
        state.barrelActive = false;
        state.barrelPhase = 0;
      }
    }

    const dtRoll = Math.min(dt, 0.08);
    state.rollTarget = THREE.MathUtils.lerp(
      state.rollTarget, 0, 1 - Math.exp(-FLY_ROLL_TARGET_DECAY * dtRoll),
    );
    state.roll = THREE.MathUtils.lerp(
      state.roll, state.rollTarget, 1 - Math.exp(-FLY_ROLL_SMOOTH * dtRoll),
    );

    if (!onDeck) {
      state.heading += state.roll * FLY_ROLL_YAW_RATE * dt;
      if (keys.z) state.aileron += FLY_AILERON_RATE * dt;
      if (keys.c) state.aileron -= FLY_AILERON_RATE * dt;
    } else {
      const lvl = 1 - Math.exp(-3 * dt);
      state.aileron *= 1 - lvl;
      if (Math.abs(state.aileron) < 0.01) state.aileron = 0;
    }

    applyCliffCollision(pos, prevX, prevZ, groundY);
    pos.y = state.height;
    return pos;
  }

  function syncVisuals(pos, visible) {
    if (!root) return;
    root.visible = visible && loaded;
    if (!root.visible) return;
    root.position.set(pos.x, pos.y, pos.z);
    let barrelAdd = 0;
    if (state.barrelActive) {
      const t = Math.min(1, state.barrelPhase);
      barrelAdd = t * t * (3 - 2 * t) * Math.PI * 2 * state.barrelDir;
    }
    root.rotation.set(state.pitch, state.heading, state.roll + barrelAdd + state.aileron);
  }

  function positionCamera(camera, lookAt, camPitch, camDist, dt = 0.016) {
    const desiredCamYaw = state.heading + state.groundCamYawOff;
    if (state.camYaw == null) state.camYaw = desiredCamYaw;
    else {
      let delta = desiredCamYaw - state.camYaw;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      state.camYaw += delta * (1 - Math.exp(-FLY_CAM_SPRING * dt));
    }

    const hDist = camDist * Math.cos(camPitch);
    const vDist = camDist * Math.sin(camPitch);
    const sinH = Math.sin(state.camYaw);
    const cosH = Math.cos(state.camYaw);
    const a = state.aileron;
    const sinA = Math.sin(a);
    const cosA = Math.cos(a);

    camera.position.set(
      lookAt.x + sinH * hDist - cosH * sinA * vDist,
      lookAt.y + cosA * vDist,
      lookAt.z + cosH * hDist + sinH * sinA * vDist,
    );
    camera.up.set(-cosH * sinA, cosA, sinH * sinA);
    camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
  }

  return {
    get loaded() { return loaded; },
    get state() { return state; },
    resetFrom,
    triggerBarrelRoll,
    applyMouse,
    update,
    syncVisuals,
    positionCamera,
    dispose() {
      if (!root) return;
      scene.remove(root);
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
          else o.material.dispose();
        }
      });
    },
  };
}
