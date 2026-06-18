import * as THREE from "three";

/**
 * CapsuleController — solid capsule-vs-BVH character physics (LAB, experimental).
 *
 * Unlike OnFootController (the faithful editor mirror), this resolves the whole
 * capsule against the triangle soup via segment depenetration — the canonical
 * three-mesh-bvh / BVHEcctrl approach. One loop replaces the editor's down-ray
 * ground + lateral wall rays + ceiling ray, and removes the snapping/clip-through
 * artifacts. Same public API as OnFootController so the lab can A/B swap them.
 *
 * Collider contract (in addition to .baked):
 *   capsuleDepenetrate(sx,sy,sz, ex,ey,ez, radius)
 *     -> { dx, dy, dz, maxNY } | null
 *   where (sx,sy,sz)=bottom sphere centre, (ex,ey,ez)=top sphere centre,
 *   the result is the accumulated push and the most-upward contact normal.y.
 */

export const DEFAULT_CAPSULE_PARAMS = {
  capRadius: 0.4,
  capHeight: 1.2,

  walkSpeed: 4.0,
  runSpeed: 8.0,
  crouchSpeedMult: 0.5,
  /** Cylinder height while crouched, as a fraction of capHeight. */
  crouchHeightScale: 0.5,

  jumpVel: 11.0,
  gravity: 20.0,
  glideFallSpeed: 3.0,
  /** Grace window to still jump just after leaving ground. */
  coyoteTime: 0.1,
  /** Jump pressed up to this early still fires on landing. */
  jumpBufferTime: 0.12,
  /** Max ledge/step height to auto-climb when blocked (beyond the free
   *  ~radius the capsule already rolls over). 0 disables. */
  stepMaxHeight: 0.5,

  /** cos of the steepest slope you can stand on (0.5 ≈ 60°). */
  minGroundNormalY: 0.5,
  /** Stay stuck to ground that drops up to this far in a frame (stairs/ramps
   *  down). 0 disables (you launch off descending edges). */
  groundStickDist: 0.5,
  yawLerpRate: 14,

  /** Depenetration passes per substep (higher = more stable in corners). */
  iterations: 4,
  /** Substep when a frame's move exceeds this fraction of the radius. */
  substepFraction: 0.5,
  /** Hard cap on substeps so a fast fall can't stall the frame. */
  maxSubsteps: 10,
};

function mergeParams(overrides = {}) {
  return { ...DEFAULT_CAPSULE_PARAMS, ...overrides };
}

/**
 * Resolve a vertical capsule against an axis-aligned box. Returns the push to
 * apply + the contact normal.y (1 = standing on top, -1 = head under it, 0 =
 * pushed off the side), or null if no overlap. px/pz = capsule axis; segBotY/
 * segTopY = sphere centres; r = radius; b = { minX..maxZ }.
 */
function resolveCapsuleBox(px, pz, segBotY, segTopY, r, b) {
  const cx = Math.max(b.minX, Math.min(px, b.maxX));
  const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));
  const dx = px - cx;
  const dz = pz - cz;
  const horiz2 = dx * dx + dz * dz;
  if (horiz2 >= r * r) return null;
  if (segBotY - r >= b.maxY || segTopY + r <= b.minY) return null;

  if (horiz2 > 1e-10) {
    // Beside the box → horizontal push out along the XZ normal.
    const horiz = Math.sqrt(horiz2);
    const depth = r - horiz;
    return { dx: (dx / horiz) * depth, dy: 0, dz: (dz / horiz) * depth, ny: 0 };
  }

  // Axis within the footprint → resolve vertically, whichever way is shallower.
  const pushUp = b.maxY + r - segBotY; // lift bottom sphere onto the top face
  const pushDown = segTopY - (b.minY - r); // drop top sphere below the bottom face
  if (pushUp <= pushDown) return { dx: 0, dy: pushUp, dz: 0, ny: 1 };
  return { dx: 0, dy: -pushDown, dz: 0, ny: -1 };
}

export class CapsuleController {
  constructor(params = {}) {
    this.params = mergeParams(params);
    /** Feet position — bottom of capsule. */
    this.position = new THREE.Vector3();
    this.velY = 0;
    this.yaw = 0;
    this.grounded = true;
    this.inAir = false;
    this.crouching = false;
    this.gliding = false;
    this._spacePrev = false;
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
    /** Platform we're standing on (for carry); null when not on one. */
    this._carrier = null;

    this.debug = {
      groundY: 0,
      moveSpeed: 0,
      normalY: 0,
      substeps: 1,
      onPlatform: false,
    };
  }

  setParams(patch) {
    Object.assign(this.params, patch);
  }

  getCapsuleDims() {
    const p = this.params;
    const height = this.crouching ? p.capHeight * p.crouchHeightScale : p.capHeight;
    return { radius: p.capRadius, height };
  }

  getCapsuleCenterY() {
    const { radius, height } = this.getCapsuleDims();
    return this.position.y + radius + height * 0.5;
  }

  reset(x, y, z) {
    this.position.set(x, y, z);
    this.velY = 0;
    this.grounded = true;
    this.inAir = false;
    this.gliding = false;
    this._spacePrev = false;
    this._coyoteTimer = 0;
    this._jumpBufferTimer = 0;
    this._carrier = null;
  }

  /**
   * @param {number} dtSec
   * @param {{
   *   input: { mx:number, mz:number, jump:boolean, run:boolean, crouch:boolean },
   *   collider: object | null,
   *   getTerrainHeight: (x:number, z:number) => number,
   *   worldHalf?: number,
   * }} ctx
   */
  update(dtSec, ctx) {
    const p = this.params;
    const { input, collider, getTerrainHeight } = ctx;
    const worldHalf = ctx.worldHalf ?? Infinity;
    dtSec = Math.min(dtSec, 0.05);

    const platforms = ctx.platforms || null;

    // ── Ride the platform we were standing on (apply its frame delta) ────────
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

    // Crouch when held & grounded. Stay crouched if a ceiling blocks standing up
    // (headroom check), so releasing crouch under an overhang doesn't pop you up
    // into the geometry.
    let wantCrouch = !!input.crouch && this.grounded;
    if (!wantCrouch && this.crouching && collider?.raycastUp) {
      const fullTop = this.position.y + r * 2 + fullH;
      const ceilY = collider.raycastUp(
        this.position.x,
        this.position.y + r,
        this.position.z,
        fullH + r + 0.05,
      );
      if (ceilY != null && ceilY < fullTop) wantCrouch = true;
    }
    this.crouching = wantCrouch;
    const h = this.crouching ? crouchH : fullH;

    // Speed is normally walk/run/crouch; a host (e.g. v2 ability layer) may
    // override it (roll/slide/etc.) via ctx.moveSpeedOverride.
    const moveSpeed =
      ctx.moveSpeedOverride != null
        ? ctx.moveSpeedOverride
        : this.crouching
          ? p.walkSpeed * p.crouchSpeedMult
          : input.run
            ? p.runSpeed
            : p.walkSpeed;

    // ── Jump (coyote time + buffer) / glide ──────────────────────────────────
    const jumpEdge = !!input.jump && !this._spacePrev;
    if (jumpEdge) this._jumpBufferTimer = p.jumpBufferTime;
    // Glide toggles only when truly airborne (coyote spent) so a press near the
    // ground jumps instead of gliding.
    if (jumpEdge && !this.grounded && this._coyoteTimer <= 0) {
      this.gliding = !this.gliding;
    }
    if (
      this._jumpBufferTimer > 0 &&
      this._coyoteTimer > 0 &&
      !this.crouching &&
      ctx.canJump !== false
    ) {
      this.velY = p.jumpVel;
      this.grounded = false;
      this._coyoteTimer = 0;
      this._jumpBufferTimer = 0;
      jumpedThisFrame = true;
    }
    this._spacePrev = !!input.jump;
    this._jumpBufferTimer = Math.max(0, this._jumpBufferTimer - dtSec);

    // ── Gravity ──────────────────────────────────────────────────────────────
    this.velY -= p.gravity * dtSec;
    if (this.gliding && this.velY < -p.glideFallSpeed) this.velY = -p.glideFallSpeed;

    const vx = mlen > 0 ? (mx / mlen) * moveSpeed : 0;
    const vz = mlen > 0 ? (mz / mlen) * moveSpeed : 0;

    // ── Integrate + depenetrate, substepped for anti-tunnel ──────────────────
    const moveX = vx * dtSec;
    const moveY = this.velY * dtSec;
    const moveZ = vz * dtSec;
    const moveLen = Math.hypot(moveX, moveY, moveZ);
    const steps = Math.min(
      p.maxSubsteps,
      Math.max(1, Math.ceil(moveLen / (r * p.substepFraction + 1e-6))),
    );
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
          const sx = this.position.x;
          const sz = this.position.z;
          const sy = this.position.y + r; // bottom sphere centre
          const ey = this.position.y + r + h; // top sphere centre
          const corr = collider.capsuleDepenetrate(sx, sy, sz, sx, ey, sz, r);
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

    // ── Autostep (climb ledges taller than the free ~radius roll-up) ─────────
    // If horizontal progress was blocked while grounded & moving, try lifting up
    // to stepMaxHeight, completing the move, and settling onto the higher ledge.
    if (
      grounded &&
      mlen > 0 &&
      !jumpedThisFrame &&
      p.stepMaxHeight > 0 &&
      canDepen &&
      collider.raycastDown
    ) {
      const gotX = this.position.x - preX;
      const gotZ = this.position.z - preZ;
      const intLen = Math.hypot(moveX, moveZ);
      const gotAlong = intLen > 1e-6 ? (gotX * moveX + gotZ * moveZ) / intLen : 0;
      if (intLen > 1e-4 && gotAlong < intLen * 0.9) {
        const sx0 = this.position.x;
        const sy0 = this.position.y;
        const sz0 = this.position.z;
        this.position.y += p.stepMaxHeight; // lift
        this.position.x = preX + moveX; // retry full horizontal at raised height
        this.position.z = preZ + moveZ;
        for (let it = 0; it < p.iterations; it++) {
          const sx = this.position.x;
          const sz = this.position.z;
          const sy = this.position.y + r;
          const ey = this.position.y + r + h;
          const corr = collider.capsuleDepenetrate(sx, sy, sz, sx, ey, sz, r);
          if (!corr) break;
          this.position.x += corr.dx;
          this.position.y += corr.dy;
          this.position.z += corr.dz;
          if (Math.abs(corr.dx) + Math.abs(corr.dy) + Math.abs(corr.dz) < 1e-5) break;
        }
        const hit = collider.raycastDown(
          this.position.x,
          this.position.y + r,
          this.position.z,
          r + p.stepMaxHeight + 0.02,
        );
        const landed =
          hit &&
          hit.ny >= p.minGroundNormalY &&
          this.position.y - hit.y >= -0.02 &&
          this.position.y - hit.y <= p.stepMaxHeight + 0.02 &&
          hit.y > sy0 + 0.02; // must actually be a step UP
        if (landed) {
          this.position.y = hit.y;
          this.velY = 0;
          if (hit.ny > maxNY) maxNY = hit.ny;
        } else {
          this.position.set(sx0, sy0, sz0); // no step — revert (stay blocked)
        }
      }
    }

    // ── Moving platforms (analytic AABB — not in the static BVH) ─────────────
    if (platforms) {
      for (let i = 0; i < platforms.length; i++) {
        const plat = platforms[i];
        const segBotY = this.position.y + r;
        const segTopY = this.position.y + r + h;
        const push = resolveCapsuleBox(
          this.position.x,
          this.position.z,
          segBotY,
          segTopY,
          r,
          plat.box,
        );
        if (!push) continue;
        this.position.x += push.dx;
        this.position.y += push.dy;
        this.position.z += push.dz;
        if (push.ny >= p.minGroundNormalY) {
          grounded = true;
          this._carrier = plat;
          if (push.ny > maxNY) maxNY = push.ny;
        } else if (push.ny <= -0.5 && this.velY > 0) {
          this.velY = 0; // bonked head on the platform underside
        }
      }
    }
    this.debug.onPlatform = !!this._carrier;

    // ── Ground stick (descending stairs/ramps — don't launch off edges) ──────
    // If we were grounded, didn't jump, and the move floated us off, a downward
    // ray finds walkable ground within groundStickDist and snaps the feet to it.
    // Ray (not capsule depenetration) so thin stair/ramp quads resolve correctly.
    // Considers BOTH the analytic terrain (getTerrainHeight) and the BVH so we
    // stick to procedural hills on descent, not just baked geometry.
    if (
      !grounded &&
      wasGrounded &&
      !jumpedThisFrame &&
      this.velY <= 0 &&
      p.groundStickDist > 0
    ) {
      let bestY = -Infinity;
      let bestNY = 1;
      // Analytic terrain candidate (treated as walkable — no normal available).
      const stickTerrainY = getTerrainHeight(this.position.x, this.position.z);
      const dropT = this.position.y - stickTerrainY;
      if (dropT >= -0.02 && dropT <= p.groundStickDist) bestY = stickTerrainY;
      // BVH candidate (cliffs / trees / platforms baked into the collider).
      if (collider?.raycastDown) {
        const hit = collider.raycastDown(
          this.position.x,
          this.position.y + r, // bottom sphere centre (above surface)
          this.position.z,
          r + p.groundStickDist + 0.02,
        );
        if (hit && hit.ny >= p.minGroundNormalY) {
          const dropB = this.position.y - hit.y;
          if (dropB >= -0.02 && dropB <= p.groundStickDist && hit.y > bestY) {
            bestY = hit.y;
            bestNY = hit.ny;
          }
        }
      }
      if (bestY > -Infinity) {
        this.position.y = bestY;
        grounded = true;
        this.velY = 0;
        if (bestNY > maxNY) maxNY = bestNY;
      }
    }

    // ── Analytic terrain floor backstop (no BVH under the feet) ──────────────
    const tY = getTerrainHeight(this.position.x, this.position.z);
    if (this.position.y < tY) {
      this.position.y = tY;
      if (this.velY < 0) this.velY = 0;
      grounded = true;
      maxNY = 1;
    }

    // ── Resolve vertical velocity against contacts ───────────────────────────
    if (grounded && this.velY < 0) this.velY = 0;
    if (bonk && this.velY > 0) this.velY = 0;

    this.position.x = THREE.MathUtils.clamp(this.position.x, -worldHalf, worldHalf);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -worldHalf, worldHalf);

    this.grounded = grounded;
    this.inAir = !grounded;
    if (grounded) this.gliding = false;

    // Coyote window refills while grounded, drains in the air.
    if (grounded) this._coyoteTimer = p.coyoteTime;
    else this._coyoteTimer = Math.max(0, this._coyoteTimer - dtSec);

    // ── Yaw toward movement ──────────────────────────────────────────────────
    if (mlen > 0) {
      const targetYaw = Math.atan2(mx, mz);
      let dYaw = targetYaw - this.yaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      this.yaw += dYaw * (1 - Math.exp(-p.yawLerpRate * dtSec));
    }

    this.debug.groundY = this.position.y;
    this.debug.moveSpeed = mlen > 0 ? moveSpeed : 0;
    this.debug.normalY = maxNY;
  }
}
