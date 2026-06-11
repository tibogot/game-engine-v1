import * as THREE from "three";

const _dir = new THREE.Vector3();
const _toPlayer = new THREE.Vector3();

/**
 * @param {object} inst — editor instance with `playMesh` + `playRuntime`
 * @param {object} defaults — `toolState.actors.npcDefaults` or `enemyDefaults`
 * @param {number} dt
 * @param {{ x: number, y: number, z: number } | null} playerPos
 * @param {(x: number, z: number) => number} getWorldHeight
 * @param {number} floorOffset
 * @param {number} footOffset — capsule center above foot
 * @param {number} worldHalf
 */
export function updateActorPlayInstance(
  inst,
  defaults,
  dt,
  playerPos,
  getWorldHeight,
  floorOffset,
  footOffset,
  worldHalf,
) {
  const mesh = inst.playMesh;
  const rt = inst.playRuntime;
  if (!mesh || !rt) return;

  if (rt.frozen) {
    const ground = getWorldHeight(mesh.position.x, mesh.position.z);
    mesh.position.y = ground + floorOffset + footOffset;
    if (playerPos) {
      _toPlayer.set(playerPos.x - mesh.position.x, 0, playerPos.z - mesh.position.z);
      if (_toPlayer.lengthSq() > 1e-4) {
        const targetYaw = Math.atan2(_toPlayer.x, _toPlayer.z);
        let diff = targetYaw - rt.currentYaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const turnAlpha = 1 - Math.exp(-(defaults.turnSpeed ?? 5) * dt);
        rt.currentYaw += diff * turnAlpha;
        mesh.rotation.y = rt.currentYaw;
      }
    }
    return;
  }

  const speed = defaults.speed ?? 2;
  const wanderRadius = defaults.wanderRadius ?? 12;
  const interval = defaults.directionChangeInterval ?? 3;
  const turnSpeed = defaults.turnSpeed ?? 5;
  const idleWhenNear = !!defaults.idleWhenNearPlayer && playerPos;
  const nearDist = defaults.nearPlayerDistance ?? 4;

  let isNearPlayer = false;
  if (idleWhenNear) {
    _toPlayer.set(playerPos.x - mesh.position.x, 0, playerPos.z - mesh.position.z);
    isNearPlayer = _toPlayer.length() < nearDist;
  }

  if (isNearPlayer) {
    rt.wasNearPlayer = true;
  } else {
    if (rt.wasNearPlayer) rt.wasNearPlayer = false;

    rt.dirChangeTimer -= dt;
    if (rt.dirChangeTimer <= 0) {
      rt.dirChangeTimer = interval;
      const angle = Math.random() * Math.PI * 2;
      rt.dirX = Math.cos(angle);
      rt.dirZ = Math.sin(angle);
    }

    mesh.position.x += rt.dirX * speed * dt;
    mesh.position.z += rt.dirZ * speed * dt;

    const dx = mesh.position.x - rt.spawnX;
    const dz = mesh.position.z - rt.spawnZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > wanderRadius && dist > 1e-4) {
      rt.dirX = -dx / dist;
      rt.dirZ = -dz / dist;
      mesh.position.x = rt.spawnX + (dx / dist) * wanderRadius;
      mesh.position.z = rt.spawnZ + (dz / dist) * wanderRadius;
    }
  }

  const half = worldHalf;
  mesh.position.x = THREE.MathUtils.clamp(mesh.position.x, -half, half);
  mesh.position.z = THREE.MathUtils.clamp(mesh.position.z, -half, half);

  const ground = getWorldHeight(mesh.position.x, mesh.position.z);
  mesh.position.y = ground + floorOffset + footOffset;

  let targetYaw;
  if (isNearPlayer && playerPos) {
    _toPlayer.set(playerPos.x - mesh.position.x, 0, playerPos.z - mesh.position.z);
    targetYaw =
      _toPlayer.lengthSq() > 1e-4
        ? Math.atan2(_toPlayer.x, _toPlayer.z)
        : rt.currentYaw;
  } else {
    targetYaw = Math.atan2(rt.dirX, rt.dirZ);
  }

  let diff = targetYaw - rt.currentYaw;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const turnAlpha = 1 - Math.exp(-turnSpeed * dt);
  rt.currentYaw += diff * turnAlpha;
  mesh.rotation.y = rt.currentYaw;
}

export function createActorPlayRuntime(mesh) {
  return {
    spawnX: mesh.position.x,
    spawnZ: mesh.position.z,
    dirX: 1,
    dirZ: 0,
    dirChangeTimer: Math.random() * 2,
    wasNearPlayer: false,
    currentYaw: mesh.rotation.y,
    frozen: false,
  };
}
