import * as THREE from "three";
import { DEFAULT_CAPSULE_PARAMS } from "./onFootCapsule.js";

/**
 * Baseline capsule tuning shared by every quadruped pawn. Individual rigs only
 * nudge the speeds — radius/height/offset get auto-fitted from the model bounds
 * in `_autoFitFromModel`, so a fox and a husky end up with proportional
 * colliders driven by the exact same controller code.
 */
export const QUADRUPED_CAPSULE_DEFAULTS = {
  capRadius: 0.24,
  capHeight: 0.42,
  capForwardOffset: 0.35,
  walkSpeed: 3.5,
  runSpeed: 7.0,
  jumpVel: 7.5,
  stepMaxHeight: 0.4,
  groundStickDist: 0.45,
};

const _groundN = new THREE.Vector3(0, 1, 0);
const _flatUp = new THREE.Vector3(0, 1, 0);

/**
 * Shared quadruped pawn — GLB load + height fit, capsule auto-fit, ground-normal
 * slope pitch, paw contact bones, and the mixer plumbing.
 *
 * Physics live in PlayMode's shared CapsuleController; this class owns visuals +
 * clips. A concrete rig subclasses it and supplies the two rig-specific parts:
 *
 *   `_buildActions(gltf)` — map this rig's clip names onto action slots
 *   `_tickAnim(ctx)`      — the per-frame animation state machine
 */
export class QuadrupedOnFoot {
  constructor({
    scene,
    loader,
    excludeFromReflection,
    modelUrl,
    targetHeight = 1.2,
    capsuleDefaults = null,
    /** Bone names for the four ground-contact paws: [frontL, frontR, backL, backR]. */
    pawBoneNames = null,
    label = "Quadruped",
    tune = null,
  }) {
    this.scene = scene;
    this.loader = loader;
    this._modelUrl = modelUrl;
    this._excludeFromReflection = excludeFromReflection;

    this.label = label;
    this.targetHeight = targetHeight;
    this.capsuleDefaults = { ...QUADRUPED_CAPSULE_DEFAULTS, ...(capsuleDefaults ?? {}) };
    this.pawBoneNames = pawBoneNames;

    this.root = null;
    this.mixer = null;
    this.actions = null;
    this.currentAction = null;
    this.loaded = false;

    // Paw IK-target bones (front-L, front-R, back-L, back-R), filled on load.
    // Used by the snow system to stamp four paw prints instead of a body trail.
    this.paws = null;

    this.oneShotLock = false;
    // The action currently holding `oneShotLock`, if it releases on its own
    // "finished" event. A held pose (a sit) locks with no `_lockAction`, so it
    // stays put until something explicitly releases it.
    this._lockAction = null;
    this.airActive = false;
    this.jumpPhase = "none";
    this.airJumpDuration = 1;

    this.baseCapRadius = this.capsuleDefaults.capRadius;
    this.modelBounds = { width: 0.5, height: 0.5, length: 1.2, centerZ: 0.35 };

    this.tune = {
      walkAnimRef: 1.8,
      runAnimRef: 5.0,
      modelYawOffset: 0,
      standJumpStart: 0.38,
      lengthRadiusBoost: 0.12,
      slopeAlign: 1.0,
      slopeAlignSpeed: 12,
      ...(tune ?? {}),
    };

    this.smoothPitch = 0;
    // Per-instance so two pawns alive at once (husky + fox) never share state.
    this._smoothN = new THREE.Vector3(0, 1, 0);
  }

  load(onReady) {
    this.loader.load(
      this._modelUrl,
      (gltf) => {
        const model = gltf.scene;
        model.traverse((o) => {
          if (o.isMesh || o.isSkinnedMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            o.frustumCulled = false;
          }
        });

        const box = new THREE.Box3().setFromObject(model);
        const sz = new THREE.Vector3();
        box.getSize(sz);
        const scale = this.targetHeight / (sz.y || 1);
        model.scale.setScalar(scale);
        box.setFromObject(model);
        model.position.y -= box.min.y;

        this.root = new THREE.Group();
        this.root.add(model);
        this.root.visible = false;
        this.scene.add(this.root);
        if (this._excludeFromReflection) this._excludeFromReflection(this.root);

        this._autoFitFromModel(model);
        this.paws = this._findPaws(model);

        if (gltf.animations?.length) {
          this.mixer = new THREE.AnimationMixer(model);
          this._buildActions(gltf);
          this.mixer.addEventListener("finished", (e) => {
            if (e.action === this._lockAction) this.releaseOneShot();
          });
          this.currentAction = this.actions?.idle ?? null;
          if (this.currentAction) this.currentAction.play();
        }

        this.loaded = true;
        onReady?.();
        console.log(`[Play] ${this.label} loaded (${this._modelUrl})`);
      },
      undefined,
      (err) => console.warn(`[Play] ${this.label} load failed (${this._modelUrl}):`, err),
    );
  }

  /** Clip lookup helper for subclasses — first name that exists in the GLB wins. */
  _pickClip(gltf, ...names) {
    return gltf.animations.find((a) => names.includes(a.name)) ?? null;
  }

  /** Turn a clip into an action. `once` clamps on the final frame. */
  _makeAction(clip, once = false) {
    if (!clip || !this.mixer) return null;
    const a = this.mixer
      .clipAction(clip)
      .setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat);
    if (once) a.clampWhenFinished = true;
    return a;
  }

  /** Subclass hook — must assign `this.actions` (an `idle` slot is expected). */
  _buildActions(_gltf) {
    this.actions = {};
  }

  _findPaws(model) {
    if (!this.pawBoneNames || this.pawBoneNames.length !== 4) return null;
    const byName = new Map();
    model.traverse((o) => { if (!byName.has(o.name)) byName.set(o.name, o); });
    const found = this.pawBoneNames.map((n) => byName.get(n) ?? null);
    return found.every(Boolean) ? found : null;
  }

  _autoFitFromModel(model) {
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    this.modelBounds.width = size.x;
    this.modelBounds.height = size.y;
    this.modelBounds.length = size.z;
    this.modelBounds.centerZ = center.z;

    this.baseCapRadius = Math.max(0.18, size.x * 0.34);
    this._fittedCapsule = {
      capHeight: Math.max(0.2, size.y * 0.34),
      capForwardOffset: center.z,
    };
  }

  _effectiveCapRadius() {
    return this.baseCapRadius + this.modelBounds.length * this.tune.lengthRadiusBoost;
  }

  applyCapsuleParams(ctrl) {
    ctrl.setParams({
      ...this.capsuleDefaults,
      capHeight: this._fittedCapsule?.capHeight ?? this.capsuleDefaults.capHeight,
      capForwardOffset:
        this._fittedCapsule?.capForwardOffset ?? this.capsuleDefaults.capForwardOffset,
      capRadius: this._effectiveCapRadius(),
    });
  }

  restoreHumanCapsuleParams(ctrl) {
    ctrl.setParams({ ...DEFAULT_CAPSULE_PARAMS });
  }

  resetAnimState() {
    this.oneShotLock = false;
    this._lockAction = null;
    this.airActive = false;
    this.jumpPhase = "none";
    this.smoothPitch = 0;
    this._smoothN.set(0, 1, 0);
    if (this.actions?.idle) this.setAction(this.actions.idle, 0.1);
  }

  /** Return true to swallow the key. Subclasses map their one-shot clips here. */
  onKeyDown(_code) {
    return false;
  }

  setAction(next, fade = 0.15) {
    if (!next || next === this.currentAction) return;
    next.reset().enabled = true;
    if (this.currentAction) next.crossFadeFrom(this.currentAction, fade, false);
    next.play();
    this.currentAction = next;
  }

  /** Play a clip through once; the rig unlocks itself on the clip's last frame. */
  playOneShot(action, fade = 0.1) {
    if (!action) return;
    this.oneShotLock = true;
    this._lockAction = action;
    this.setAction(action, fade);
  }

  /** Play a clip and stay in its final pose until something releases the lock. */
  playHold(action, fade = 0.12) {
    if (!action) return;
    this.oneShotLock = true;
    this._lockAction = null;
    this.setAction(action, fade);
  }

  releaseOneShot() {
    this.oneShotLock = false;
    this._lockAction = null;
  }

  /**
   * Takeoff pose. The default rig has a single run-jump clip, so a standing jump
   * scrubs into it past the run-up frames; subclasses with a dedicated jump clip
   * override this.
   */
  startAirJump({ gallop, speed, ctrl }) {
    const a = this.actions?.airJump;
    if (!a) return;

    const isRunning =
      gallop ||
      this.currentAction === this.actions.run ||
      speed >= ctrl.params.runSpeed * 0.65;

    a.reset().enabled = true;
    if (!isRunning) {
      const startNorm =
        speed < 0.15 ? this.tune.standJumpStart : this.tune.standJumpStart * 0.55;
      a.time = this.airJumpDuration * startNorm;
    }
    if (this.currentAction && this.currentAction !== a) {
      a.crossFadeFrom(this.currentAction, 0.08, false);
    }
    a.play();
    this.currentAction = a;
  }

  /** Locomotion clips run at the model's authored pace unless retimed to the ground speed. */
  _syncLocomotionTimeScale(speed) {
    if (this.actions?.walk && speed > 0) {
      this.actions.walk.timeScale = speed / this.tune.walkAnimRef;
    }
    if (this.actions?.run && speed > 0) {
      this.actions.run.timeScale = speed / this.tune.runAnimRef;
    }
  }

  /** Subclass hook — the animation FSM. Called only while no one-shot holds the rig. */
  _tickAnim(_ctx) {}

  /**
   * Subclass hook — runs every frame *including* while locked, so a held pose can
   * decide to let go (a sitting fox stands up the moment you walk it off).
   */
  _maybeReleaseLock(_ctx) {}

  _sampleGroundNormal(out, yaw, playerPos, ctrl, collider, getTerrainHeight) {
    const fwdOff = ctrl.params.capForwardOffset || 0;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const ox = playerPos.x + fwdOff * sin;
    const oz = playerPos.z + fwdOff * cos;
    const oy = playerPos.y + ctrl.params.capRadius + 0.2;
    const hit = collider?.raycastDown?.(ox, oy, oz, ctrl.params.capRadius + 2.5);
    if (hit && hit.nx !== undefined && hit.ny >= ctrl.params.minGroundNormalY) {
      out.set(hit.nx, hit.ny, hit.nz).normalize();
      return true;
    }
    const d = 0.35;
    const yC = getTerrainHeight(ox, oz);
    const yX = getTerrainHeight(ox + d, oz);
    const yZ = getTerrainHeight(ox, oz + d);
    out.set(yC - yX, d, yC - yZ).normalize();
    return out.y > 0.05;
  }

  updateFrame({
    dtSec,
    playerPos,
    charYaw,
    mx,
    mz,
    ctrl,
    collider,
    getTerrainHeight,
    keys,
    gallop,
    moveSpeed,
  }) {
    if (!this.loaded || !this.root) return charYaw;

    this.root.visible = true;
    this.root.position.set(playerPos.x, playerPos.y, playerPos.z);

    const mlen = Math.hypot(mx, mz);
    if (this.oneShotLock) {
      this._maybeReleaseLock({ ctrl, keys: keys ?? {}, mlen, moveSpeed });
    }

    let yaw = charYaw;
    if (mlen > 0.01 && !this.oneShotLock) {
      const targetYaw = Math.atan2(mx, mz);
      let dYaw = targetYaw - yaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      yaw += dYaw * (1 - Math.exp(-14 * dtSec));
    }

    const visYaw = yaw + this.tune.modelYawOffset;
    const grounded = ctrl.grounded && !ctrl.inAir;

    const hasNormal =
      grounded &&
      this._sampleGroundNormal(
        _groundN,
        visYaw,
        playerPos,
        ctrl,
        collider,
        getTerrainHeight,
      );
    const strength = grounded ? this.tune.slopeAlign : 1;
    const t = (1 - Math.exp(-this.tune.slopeAlignSpeed * dtSec)) * strength;
    if (hasNormal) this._smoothN.lerp(_groundN, t).normalize();
    else this._smoothN.lerp(_flatUp, t).normalize();

    const fwdX = Math.sin(visYaw);
    const fwdZ = Math.cos(visYaw);
    const nFwd = this._smoothN.x * fwdX + this._smoothN.z * fwdZ;
    const targetPitch = grounded
      ? Math.atan2(nFwd, this._smoothN.y) * this.tune.slopeAlign
      : 0;
    this.smoothPitch += (targetPitch - this.smoothPitch) * t;

    this.root.rotation.order = "YXZ";
    this.root.rotation.set(this.smoothPitch, visYaw, 0);

    if (this.mixer) {
      if (this.actions && !this.oneShotLock) {
        this._tickAnim({ ctrl, keys: keys ?? {}, gallop, moveSpeed, mlen });
        this._syncLocomotionTimeScale(moveSpeed);
      }
      this.mixer.update(dtSec);
    }

    return yaw;
  }
}
