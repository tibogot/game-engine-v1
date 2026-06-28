import * as THREE from "three";
import { DEFAULT_CAPSULE_PARAMS } from "./onFootCapsule.js";

export const HUSKY_MODEL = "../models/Husky_compressed.glb";
export const HUSKY_HEIGHT = 1.2;

export const HUSKY_CAPSULE_DEFAULTS = {
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
const _smoothN = new THREE.Vector3(0, 1, 0);
const _flatUp = new THREE.Vector3(0, 1, 0);

/**
 * Husky quadruped pawn — model load, capsule auto-fit, slope pitch, animation FSM.
 * Physics live in PlayMode's shared CapsuleController; this class owns visuals + clips.
 */
export class HuskyOnFoot {
  constructor({ scene, loader, excludeFromReflection, modelUrl = HUSKY_MODEL }) {
    this.scene = scene;
    this.loader = loader;
    this._modelUrl = modelUrl;
    this._excludeFromReflection = excludeFromReflection;

    this.root = null;
    this.mixer = null;
    this.actions = null;
    this.currentAction = null;
    this.loaded = false;

    this.oneShotLock = false;
    this.airActive = false;
    this.jumpPhase = "none";
    this.gallopJumpDuration = 1;

    this.baseCapRadius = HUSKY_CAPSULE_DEFAULTS.capRadius;
    this.modelBounds = { width: 0.5, height: 0.5, length: 1.2, centerZ: 0.35 };

    this.tune = {
      walkAnimRef: 1.8,
      runAnimRef: 5.0,
      modelYawOffset: 0,
      standJumpStart: 0.38,
      lengthRadiusBoost: 0.12,
      slopeAlign: 1.0,
      slopeAlignSpeed: 12,
    };

    this.smoothPitch = 0;
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
        const scale = HUSKY_HEIGHT / (sz.y || 1);
        model.scale.setScalar(scale);
        box.setFromObject(model);
        model.position.y -= box.min.y;

        this.root = new THREE.Group();
        this.root.add(model);
        this.root.visible = false;
        this.scene.add(this.root);
        if (this._excludeFromReflection) this._excludeFromReflection(this.root);

        this._autoFitFromModel(model);

        if (gltf.animations?.length) {
          this.mixer = new THREE.AnimationMixer(model);
          const pick = (...names) =>
            gltf.animations.find((a) => names.includes(a.name)) ?? null;
          const mk = (clip, once) => {
            if (!clip) return null;
            const a = this.mixer
              .clipAction(clip)
              .setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat);
            if (once) a.clampWhenFinished = true;
            return a;
          };

          const gallopJumpClip = pick("Gallop_Jump");
          this.gallopJumpDuration = gallopJumpClip?.duration ?? 1;

          this.actions = {
            idle: mk(pick("Idle", "Idle_2"), false),
            headLow: mk(pick("Idle_2_HeadLow"), false),
            walk: mk(pick("Walk"), false),
            gallop: mk(pick("Gallop"), false),
            airJump: mk(gallopJumpClip, true),
            attack: mk(pick("Attack"), true),
            eating: mk(pick("Eating"), true),
          };

          this.mixer.addEventListener("finished", (e) => {
            if (
              e.action === this.actions.attack ||
              e.action === this.actions.eating
            ) {
              this.oneShotLock = false;
            }
          });

          this.currentAction = this.actions.idle;
          if (this.currentAction) this.currentAction.play();
        }

        this.loaded = true;
        onReady?.();
        console.log(`[Play] Husky loaded (${this._modelUrl})`);
      },
      undefined,
      (err) => console.warn(`[Play] Husky load failed (${this._modelUrl}):`, err),
    );
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
      ...HUSKY_CAPSULE_DEFAULTS,
      capHeight: this._fittedCapsule?.capHeight ?? HUSKY_CAPSULE_DEFAULTS.capHeight,
      capForwardOffset:
        this._fittedCapsule?.capForwardOffset ??
        HUSKY_CAPSULE_DEFAULTS.capForwardOffset,
      capRadius: this._effectiveCapRadius(),
    });
  }

  restoreHumanCapsuleParams(ctrl) {
    ctrl.setParams({ ...DEFAULT_CAPSULE_PARAMS });
  }

  resetAnimState() {
    this.oneShotLock = false;
    this.airActive = false;
    this.jumpPhase = "none";
    this.smoothPitch = 0;
    _smoothN.set(0, 1, 0);
    if (this.actions?.idle) {
      this.setAction(this.actions.idle, 0.1);
    }
  }

  onKeyDown(code) {
    if (code === "KeyF") {
      this.playOneShot(this.actions?.attack);
      return true;
    }
    if (code === "KeyE") {
      this.playOneShot(this.actions?.eating);
      return true;
    }
    return false;
  }

  setAction(next, fade = 0.15) {
    if (!next || next === this.currentAction) return;
    next.reset().enabled = true;
    if (this.currentAction) next.crossFadeFrom(this.currentAction, fade, false);
    next.play();
    this.currentAction = next;
  }

  startAirJump({ gallop, speed, ctrl }) {
    const a = this.actions?.airJump;
    if (!a) return;

    const isGallop =
      gallop ||
      this.currentAction === this.actions.gallop ||
      speed >= ctrl.params.runSpeed * 0.65;

    a.reset().enabled = true;
    if (!isGallop) {
      const startNorm =
        speed < 0.15
          ? this.tune.standJumpStart
          : this.tune.standJumpStart * 0.55;
      a.time = this.gallopJumpDuration * startNorm;
    }
    if (this.currentAction && this.currentAction !== a) {
      a.crossFadeFrom(this.currentAction, 0.08, false);
    }
    a.play();
    this.currentAction = a;
  }

  playOneShot(action, fade = 0.1) {
    if (!action) return;
    this.oneShotLock = true;
    this.setAction(action, fade);
  }

  _sampleGroundNormal(out, yaw, playerPos, ctrl, collider, getTerrainHeight) {
    const fwdOff = ctrl.params.capForwardOffset || 0;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const ox = playerPos.x + fwdOff * sin;
    const oz = playerPos.z + fwdOff * cos;
    const oy = playerPos.y + ctrl.params.capRadius + 0.2;
    const hit = collider?.raycastDown?.(
      ox,
      oy,
      oz,
      ctrl.params.capRadius + 2.5,
    );
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

    let yaw = charYaw;
    if (Math.hypot(mx, mz) > 0.01 && !this.oneShotLock) {
      const targetYaw = Math.atan2(mx, mz);
      let dYaw = targetYaw - yaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      yaw += dYaw * (1 - Math.exp(-14 * dtSec));
    }

    const visYaw = yaw + this.tune.modelYawOffset;
    const grounded = ctrl.grounded && !ctrl.inAir;

    const hasNormal = grounded &&
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
    if (hasNormal) _smoothN.lerp(_groundN, t).normalize();
    else _smoothN.lerp(_flatUp, t).normalize();

    const fwdX = Math.sin(visYaw);
    const fwdZ = Math.cos(visYaw);
    const nFwd = _smoothN.x * fwdX + _smoothN.z * fwdZ;
    const targetPitch = grounded
      ? Math.atan2(nFwd, _smoothN.y) * this.tune.slopeAlign
      : 0;
    this.smoothPitch += (targetPitch - this.smoothPitch) * t;

    this.root.rotation.order = "YXZ";
    this.root.rotation.set(this.smoothPitch, visYaw, 0);

    if (this.mixer && this.actions && !this.oneShotLock) {
      const inAir = ctrl.inAir;
      const mlen = Math.hypot(mx, mz);
      const headLow = !!(keys.KeyC);

      if (inAir && !this.airActive) {
        this.airActive = true;
        this.jumpPhase = "air";
        this.startAirJump({ gallop, speed: moveSpeed, ctrl });
      } else if (!inAir && this.airActive && ctrl.velY <= 0.05) {
        this.airActive = false;
        this.jumpPhase = "none";
        const moving = mlen > 0.01;
        if (moving) {
          this.setAction(gallop ? this.actions.gallop : this.actions.walk, 0.12);
        } else {
          this.setAction(this.actions.idle, 0.12);
        }
      } else if (!inAir && this.jumpPhase === "none") {
        let tgt;
        if (headLow && mlen < 0.01) tgt = this.actions.headLow;
        else if (mlen > 0) tgt = gallop ? this.actions.gallop : this.actions.walk;
        else tgt = this.actions.idle;
        if (tgt) this.setAction(tgt, 0.15);
      }

      const speed = moveSpeed;
      if (this.actions.walk && speed > 0) {
        this.actions.walk.timeScale = speed / this.tune.walkAnimRef;
      }
      if (this.actions.gallop && speed > 0) {
        this.actions.gallop.timeScale = speed / this.tune.runAnimRef;
      }

      this.mixer.update(dtSec);
    } else if (this.mixer) {
      this.mixer.update(dtSec);
    }

    return yaw;
  }
}
