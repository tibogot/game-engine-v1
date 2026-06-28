/**
 * Snow-lab debug ball — rolling sphere with WASD + jump for ground/BVH testing.
 * Ported from v2/snow-lab.html (BALL_R, movement, rolling constraint, jump).
 */
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { mix, normalLocal, vec3, float } from "three/tsl";
import { WORLD_SIZE } from "../terrain/heightmapTexture.js";

export const BALL_R = 0.5;
const MOVE_SPEED = 5.0;
const GRAVITY = 18.0;
const JUMP_VEL = 7.5;
const MIN_GROUND_NY = 0.5;
const DEPENETRATE_ITERS = 6;

export function createBallDebugMode({ scene, sampleGroundY, getCollider = () => null }) {
  const ballGeo = new THREE.SphereGeometry(BALL_R, 32, 32);
  const ballMat = new MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.05 });
  const halfBand = normalLocal.y.mul(10.0).clamp(-1, 1).mul(0.5).add(0.5);
  ballMat.colorNode = mix(
    vec3(float(0.9), float(0.15), float(0.1)),
    vec3(float(0.1), float(0.35), float(0.95)),
    halfBand,
  );

  const ball = new THREE.Mesh(ballGeo, ballMat);
  ball.castShadow = true;
  ball.receiveShadow = true;
  ball.visible = false;
  scene.add(ball);

  const ballQuat = new THREE.Quaternion();
  const _rollAxis = new THREE.Vector3();
  const _rollQ = new THREE.Quaternion();

  let velY = 0;
  let grounded = true;
  let speed = 0;
  let _spacePrev = false;

  const worldHalf = WORLD_SIZE / 2 - BALL_R;

  function sampleFloorY(x, z, fromY) {
    let floorY = sampleGroundY(x, z);
    const collider = getCollider?.();
    if (collider?.raycastDown) {
      const hit = collider.raycastDown(x, fromY + BALL_R + 0.25, z, BALL_R + 12);
      if (hit && hit.y > floorY) floorY = hit.y;
    }
    return floorY;
  }

  function depenetrateSphere(pos) {
    const collider = getCollider?.();
    if (!collider?.baked || !collider.capsuleDepenetrate) return false;
    let touchedGround = false;
    for (let it = 0; it < DEPENETRATE_ITERS; it++) {
      const corr = collider.capsuleDepenetrate(
        pos.x, pos.y, pos.z,
        pos.x, pos.y + 0.01, pos.z,
        BALL_R,
      );
      if (!corr) break;
      pos.x += corr.dx;
      pos.y += corr.dy;
      pos.z += corr.dz;
      if (corr.maxNY >= MIN_GROUND_NY && corr.dy >= -1e-4) touchedGround = true;
      if (Math.abs(corr.dx) + Math.abs(corr.dy) + Math.abs(corr.dz) < 1e-5) break;
    }
    return touchedGround;
  }

  function resetFrom(x, y, z) {
    const floorY = sampleFloorY(x, z, y);
    const cy = Math.max(y, floorY + BALL_R);
    velY = 0;
    grounded = true;
    speed = 0;
    _spacePrev = false;
    ballQuat.identity();
    return { x, y: cy, z };
  }

  function update(dt, keys, camYaw, pos) {
    const jumpEdge = !!keys.space && !_spacePrev;
    _spacePrev = !!keys.space;
    if (jumpEdge && grounded) {
      velY = JUMP_VEL;
      grounded = false;
    }

    let mx = 0;
    let mz = 0;
    if (keys.w) { mx -= Math.sin(camYaw); mz -= Math.cos(camYaw); }
    if (keys.s) { mx += Math.sin(camYaw); mz += Math.cos(camYaw); }
    if (keys.a) { mx -= Math.cos(camYaw); mz += Math.sin(camYaw); }
    if (keys.d) { mx += Math.cos(camYaw); mz -= Math.sin(camYaw); }

    const mlen = Math.hypot(mx, mz);
    speed = 0;
    if (mlen > 0) {
      mx = (mx / mlen) * MOVE_SPEED * dt;
      mz = (mz / mlen) * MOVE_SPEED * dt;
      pos.x = THREE.MathUtils.clamp(pos.x + mx, -worldHalf, worldHalf);
      pos.z = THREE.MathUtils.clamp(pos.z + mz, -worldHalf, worldHalf);
      speed = MOVE_SPEED;

      const moveDist = Math.hypot(mx, mz);
      if (moveDist > 1e-8) {
        _rollAxis.set(mz / moveDist, 0, -mx / moveDist).normalize();
        _rollQ.setFromAxisAngle(_rollAxis, moveDist / BALL_R);
        ballQuat.premultiply(_rollQ);
      }
    }

    velY -= GRAVITY * dt;
    pos.y += velY * dt;

    const floorY = sampleFloorY(pos.x, pos.z, pos.y);
    const minY = floorY + BALL_R;
    if (pos.y <= minY) {
      pos.y = minY;
      velY = 0;
      grounded = true;
    } else {
      grounded = false;
    }

    if (depenetrateSphere(pos)) {
      const floorAfter = sampleFloorY(pos.x, pos.z, pos.y);
      const minAfter = floorAfter + BALL_R;
      if (pos.y < minAfter) {
        pos.y = minAfter;
        velY = 0;
      }
      if (velY <= 0) grounded = true;
    }
  }

  function syncVisuals(pos, visible) {
    ball.visible = visible;
    if (!visible) return;
    ball.position.copy(pos);
    ball.quaternion.copy(ballQuat);
  }

  function hide() {
    ball.visible = false;
  }

  function dispose() {
    scene.remove(ball);
    ballGeo.dispose();
    ballMat.dispose();
  }

  return {
    get radius() { return BALL_R; },
    get grounded() { return grounded; },
    get speed() { return speed; },
    resetFrom,
    update,
    syncVisuals,
    hide,
    dispose,
  };
}
