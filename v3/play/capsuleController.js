import * as THREE from "three";

export const DEFAULT_CAPSULE_PARAMS = {
  capRadius: 0.4,
  capHeight: 1.2,
  capForwardOffset: 0,

  walkSpeed: 6,
  runSpeed: 14,
  crouchSpeedMult: 0.5,
  crouchHeightScale: 0.5,

  // Movement smoothing — velocity approaches the input target at these rates
  // (m/s²) instead of snapping, so starts/stops/turns ramp and animations blend.
  accelRate: 40,
  decelRate: 50,
  airControlMult: 0.4,

  // Terrain slope limit (needs ctx.getTerrainNormal). Steeper than this can't
  // be walked up; standing on it slides downhill instead of grounding.
  maxWalkSlopeDeg: 50,
  slideAccel: 20,
  maxSlideSpeed: 10,

  jumpVel: 11.0,
  gravity: 20.0,
  glideFallSpeed: 3.0,
  coyoteTime: 0.1,
  jumpBufferTime: 0.12,
  stepMaxHeight: 0.5,

  minGroundNormalY: 0.5,
  groundStickDist: 0.5,

  groundSpringK: 25,
  groundSpringRange: 0.5,

  yawLerpRate: 14,

  iterations: 4,
  substepFraction: 0.5,
  maxSubsteps: 10,
};

function mergeParams(overrides = {}) {
  return { ...DEFAULT_CAPSULE_PARAMS, ...overrides };
}

function resolveCapsuleBox(px, pz, segBotY, segTopY, r, b) {
  const cx = Math.max(b.minX, Math.min(px, b.maxX));
  const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
  const dx = px - cx;
  const dz = pz - cz;
  const horiz2 = dx * dx + dz * dz;
  if (horiz2 >= r * r) return null;
  if (segBotY - r >= b.maxY || segTopY + r <= b.minY) return null;

  if (horiz2 > 1e-10) {
    const horiz = Math.sqrt(horiz2);
    const depth = r - horiz;
    return { dx: (dx / horiz) * depth, dy: 0, dz: (dz / horiz) * depth, ny: 0 };
  }

  const pushUp   = b.maxY + r - segBotY;
  const pushDown = segTopY - (b.minY - r);
  if (pushUp <= pushDown) return { dx: 0, dy: pushUp,   dz: 0, ny:  1 };
  return                         { dx: 0, dy: -pushDown, dz: 0, ny: -1 };
}

export class CapsuleController {
  constructor(params = {}) {
    this.params = mergeParams(params);
    this.position = new THREE.Vector3();
    this.velY = 0;
    this.velX = 0;
    this.velZ = 0;
    this.sliding = false;
    this.yaw = 0;
    this.grounded = true;
    this.inAir = false;
    this.crouching = false;
    this.gliding = false;
    this._spacePrev = false;
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
    this._carrier = null;
    this.justJumped = false;
    this.debug = { groundY: 0, moveSpeed: 0, normalY: 0, substeps: 1, onPlatform: false };
  }

  setParams(patch) { Object.assign(this.params, patch); }

  getCapsuleDims() {
    const p = this.params;
    const height = this.crouching ? p.capHeight * p.crouchHeightScale : p.capHeight;
    return { radius: p.capRadius, height };
  }

  getCapsuleCenterY() {
    const { radius, height } = this.getCapsuleDims();
    return this.position.y + radius + height * 0.5;
  }

  _capsuleXZ(out = { x: 0, z: 0 }) {
    const fwd = this.params.capForwardOffset || 0;
    if (Math.abs(fwd) < 1e-6) { out.x = this.position.x; out.z = this.position.z; return out; }
    out.x = this.position.x + fwd * Math.sin(this.yaw);
    out.z = this.position.z + fwd * Math.cos(this.yaw);
    return out;
  }

  reset(x, y, z) {
    this.position.set(x, y, z);
    this.velY = 0;
    this.velX = 0;
    this.velZ = 0;
    this.sliding = false;
    this.grounded = true;
    this.inAir = false;
    this.gliding = false;
    this._spacePrev = false;
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
    this._carrier = null;
  }

  update(dtSec, ctx) {
    const p = this.params;
    const { input, collider, getTerrainHeight } = ctx;
    const worldHalf = ctx.worldHalf ?? Infinity;
    dtSec = Math.min(dtSec, 0.05);

    this.justJumped = false;
    const platforms = ctx.platforms || null;

    if (this._carrier && platforms && platforms.includes(this._carrier)) {
      const d = this._carrier.delta;
      this.position.x += d.x;
      this.position.y += d.y;
      this.position.z += d.z;
    }
    this._carrier = null;

    const wasGrounded = this.grounded;
    let jumpedThisFrame = false;
    const r = p.capRadius;
    const fullH = p.capHeight;
    const crouchH = p.capHeight * p.crouchHeightScale;
    const mx = input.mx || 0;
    const mz = input.mz || 0;
    const mlen = Math.hypot(mx, mz);

    let wantCrouch = !!input.crouch && this.grounded;
    if (!wantCrouch && this.crouching && collider?.raycastUp) {
      const fullTop = this.position.y + r * 2 + fullH;
      const ceilY = collider.raycastUp(this.position.x, this.position.y + r, this.position.z, fullH + r + 0.05);
      if (ceilY != null && ceilY < fullTop) wantCrouch = true;
    }
    this.crouching = wantCrouch;
    const h = this.crouching ? crouchH : fullH;

    const moveSpeed =
      ctx.moveSpeedOverride != null ? ctx.moveSpeedOverride
      : this.crouching ? p.walkSpeed * p.crouchSpeedMult
      : input.run ? p.runSpeed
      : p.walkSpeed;

    const jumpEdge = !!input.jump && !this._spacePrev;
    if (jumpEdge) this._jumpBufferTimer = p.jumpBufferTime;
    if (jumpEdge && !this.grounded && this._coyoteTimer <= 0) this.gliding = !this.gliding;
    if (this._jumpBufferTimer > 0 && this._coyoteTimer > 0 && !this.crouching && ctx.canJump !== false) {
      this.velY = p.jumpVel;
      this.grounded = false;
      this._coyoteTimer = 0;
      this._jumpBufferTimer = 0;
      jumpedThisFrame = true;
      this.justJumped = true;
    }
    this._spacePrev = !!input.jump;
    this._jumpBufferTimer = Math.max(0, this._jumpBufferTimer - dtSec);

    this.velY -= p.gravity * dtSec;
    if (this.gliding && this.velY < -p.glideFallSpeed) this.velY = -p.glideFallSpeed;

    // ── Horizontal velocity: ramp toward the input target (accel/decel) ──────
    const tvx = mlen > 0 ? (mx / mlen) * moveSpeed : 0;
    const tvz = mlen > 0 ? (mz / mlen) * moveSpeed : 0;
    let rate = (mlen > 0 ? p.accelRate : p.decelRate) ?? 0;
    if (!wasGrounded) rate *= p.airControlMult ?? 1;
    if (this.sliding) rate *= 0.25; // weak steering while sliding down a slope
    if (rate > 0) {
      const dvx = tvx - this.velX;
      const dvz = tvz - this.velZ;
      const dLen = Math.hypot(dvx, dvz);
      const step = rate * dtSec;
      if (dLen <= step) { this.velX = tvx; this.velZ = tvz; }
      else { this.velX += (dvx / dLen) * step; this.velZ += (dvz / dLen) * step; }
    } else {
      this.velX = tvx;
      this.velZ = tvz;
    }

    // ── Terrain slope gate: cancel the uphill velocity component when pushing
    // into terrain steeper than maxWalkSlopeDeg (the floor backstop would
    // otherwise ratchet the capsule up ANY slope). Only applies while in
    // contact with the terrain surface — BVH props/cliffs handle their own
    // normals via the collider.
    const minWalkNY = Math.cos((p.maxWalkSlopeDeg ?? 90) * Math.PI / 180);
    if (ctx.getTerrainNormal && (this.velX !== 0 || this.velZ !== 0)) {
      const aheadX = this.position.x + this.velX * dtSec;
      const aheadZ = this.position.z + this.velZ * dtSec;
      const tHere = getTerrainHeight(this.position.x, this.position.z);
      if (this.position.y <= tHere + 0.3) {
        const n = ctx.getTerrainNormal(aheadX, aheadZ);
        const tThere = getTerrainHeight(aheadX, aheadZ);
        if (n && n.y < minWalkNY && tThere > tHere + 0.005) {
          const gl = Math.hypot(n.x, n.z);
          if (gl > 1e-5) {
            const ux = -n.x / gl, uz = -n.z / gl; // uphill direction (XZ)
            const d = this.velX * ux + this.velZ * uz;
            if (d > 0) { this.velX -= ux * d; this.velZ -= uz * d; }
          }
        }
      }
    }

    const moveX = this.velX * dtSec;
    const moveY = this.velY * dtSec;
    const moveZ = this.velZ * dtSec;
    const moveLen = Math.hypot(moveX, moveY, moveZ);
    const steps = Math.min(p.maxSubsteps, Math.max(1, Math.ceil(moveLen / (r * p.substepFraction + 1e-6))));
    this.debug.substeps = steps;

    let grounded = false;
    let bonk = false;
    let maxNY = -1;
    const preX = this.position.x;
    const preZ = this.position.z;
    const canDepen = !!(collider?.baked && collider.capsuleDepenetrate);

    for (let s = 0; s < steps; s++) {
      this.position.x += moveX / steps;
      this.position.y += moveY / steps;
      this.position.z += moveZ / steps;

      if (canDepen) {
        for (let it = 0; it < p.iterations; it++) {
          const capXZ = this._capsuleXZ();
          const sy = this.position.y + r;
          const ey = this.position.y + r + h;
          const corr = collider.capsuleDepenetrate(capXZ.x, sy, capXZ.z, capXZ.x, ey, capXZ.z, r);
          if (!corr) break;
          this.position.x += corr.dx;
          this.position.y += corr.dy;
          this.position.z += corr.dz;
          if (corr.maxNY > maxNY) maxNY = corr.maxNY;
          if (corr.maxNY >= p.minGroundNormalY && corr.dy > -1e-4) grounded = true;
          if (corr.dy < -1e-4) bonk = true;
          if (Math.abs(corr.dx) + Math.abs(corr.dy) + Math.abs(corr.dz) < 1e-5) break;
        }
      }
    }

    if (grounded && mlen > 0 && !jumpedThisFrame && p.stepMaxHeight > 0 && canDepen && collider.raycastDown) {
      const gotX = this.position.x - preX;
      const gotZ = this.position.z - preZ;
      const intLen = Math.hypot(moveX, moveZ);
      const gotAlong = intLen > 1e-6 ? (gotX * moveX + gotZ * moveZ) / intLen : 0;
      if (intLen > 1e-4 && gotAlong < intLen * 0.9) {
        const sx0 = this.position.x, sy0 = this.position.y, sz0 = this.position.z;
        this.position.y += p.stepMaxHeight;
        this.position.x = preX + moveX;
        this.position.z = preZ + moveZ;
        for (let it = 0; it < p.iterations; it++) {
          const capXZ = this._capsuleXZ();
          const sy = this.position.y + r;
          const ey = this.position.y + r + h;
          const corr = collider.capsuleDepenetrate(capXZ.x, sy, capXZ.z, capXZ.x, ey, capXZ.z, r);
          if (!corr) break;
          this.position.x += corr.dx;
          this.position.y += corr.dy;
          this.position.z += corr.dz;
          if (Math.abs(corr.dx) + Math.abs(corr.dy) + Math.abs(corr.dz) < 1e-5) break;
        }
        const capXZ = this._capsuleXZ();
        const hit = collider.raycastDown(capXZ.x, this.position.y + r, capXZ.z, r + p.stepMaxHeight + 0.02);
        const landed = hit && hit.ny >= p.minGroundNormalY
          && this.position.y - hit.y >= -0.02
          && this.position.y - hit.y <= p.stepMaxHeight + 0.02
          && hit.y > sy0 + 0.02;
        if (landed) { this.position.y = hit.y; this.velY = 0; if (hit.ny > maxNY) maxNY = hit.ny; }
        else this.position.set(sx0, sy0, sz0);
      }
    }

    if (platforms) {
      for (const plat of platforms) {
        const capXZ = this._capsuleXZ();
        const push = resolveCapsuleBox(capXZ.x, capXZ.z, this.position.y + r, this.position.y + r + h, r, plat.box);
        if (!push) continue;
        this.position.x += push.dx;
        this.position.y += push.dy;
        this.position.z += push.dz;
        if (push.ny >= p.minGroundNormalY) { grounded = true; this._carrier = plat; if (push.ny > maxNY) maxNY = push.ny; }
        else if (push.ny <= -0.5 && this.velY > 0) this.velY = 0;
      }
    }
    this.debug.onPlatform = !!this._carrier;

    if (!grounded && wasGrounded && !jumpedThisFrame && this.velY <= 0 && p.groundStickDist > 0) {
      let bestY = -Infinity, bestNY = 1;
      const stickTerrainY = getTerrainHeight(this.position.x, this.position.z);
      const dropT = this.position.y - stickTerrainY;
      // Never stick to unwalkable terrain — that would re-ground on steep slopes.
      const stickN = ctx.getTerrainNormal?.(this.position.x, this.position.z);
      const stickWalkable = !stickN || stickN.y >= minWalkNY;
      if (stickWalkable && dropT >= -0.02 && dropT <= p.groundStickDist) bestY = stickTerrainY;
      if (collider?.raycastDown) {
        const hit = collider.raycastDown(this.position.x, this.position.y + r, this.position.z, r + p.groundStickDist + 0.02);
        if (hit && hit.ny >= p.minGroundNormalY) {
          const dropB = this.position.y - hit.y;
          if (dropB >= -0.02 && dropB <= p.groundStickDist && hit.y > bestY) { bestY = hit.y; bestNY = hit.ny; }
        }
      }
      if (bestY > -Infinity) { this.position.y = bestY; grounded = true; this.velY = 0; if (bestNY > maxNY) maxNY = bestNY; }
    }

    const tY = getTerrainHeight(this.position.x, this.position.z);
    let sliding = false;
    if (this.position.y < tY) {
      const err = tY - this.position.y;
      this.position.y += err > p.groundSpringRange ? err : err * (1 - Math.exp(-p.groundSpringK * dtSec));
      if (this.velY < 0) this.velY = 0;
      const n = ctx.getTerrainNormal?.(this.position.x, this.position.z);
      if (!n || n.y >= minWalkNY) {
        grounded = true;
        if (maxNY < 1) maxNY = 1;
      } else {
        // Too steep to stand on: surf the surface and accelerate downhill.
        // grounded stays false → no jump reset, and coyote time runs out.
        sliding = true;
        const gl = Math.hypot(n.x, n.z) || 1;
        this.velX += (n.x / gl) * (p.slideAccel ?? 0) * dtSec;
        this.velZ += (n.z / gl) * (p.slideAccel ?? 0) * dtSec;
        const sl = Math.hypot(this.velX, this.velZ);
        const cap = p.maxSlideSpeed ?? Infinity;
        if (sl > cap) { this.velX *= cap / sl; this.velZ *= cap / sl; }
      }
    }
    this.sliding = sliding;

    if (grounded && this.velY < 0) this.velY = 0;
    if (bonk && this.velY > 0) this.velY = 0;

    this.position.x = THREE.MathUtils.clamp(this.position.x, -worldHalf, worldHalf);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -worldHalf, worldHalf);

    this.grounded = grounded;
    this.inAir = !grounded;
    if (grounded) this.gliding = false;
    if (grounded) this._coyoteTimer = p.coyoteTime;
    else this._coyoteTimer = Math.max(0, this._coyoteTimer - dtSec);

    if (mlen > 0) {
      const targetYaw = Math.atan2(mx, mz);
      let dYaw = targetYaw - this.yaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      this.yaw += dYaw * (1 - Math.exp(-p.yawLerpRate * dtSec));
    }

    this.debug.groundY = this.position.y;
    // Actual smoothed speed — animation blending reads this, so ramps register.
    this.debug.moveSpeed = Math.hypot(this.velX, this.velZ);
    this.debug.normalY = maxNY;
  }
}
