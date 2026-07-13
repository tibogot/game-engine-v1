import { QuadrupedOnFoot, QUADRUPED_CAPSULE_DEFAULTS } from "./quadrupedOnFoot.js";

export const HUSKY_MODEL = "../models/Husky_compressed.glb";
export const HUSKY_HEIGHT = 1.2;

export const HUSKY_CAPSULE_DEFAULTS = { ...QUADRUPED_CAPSULE_DEFAULTS };

/** The Husky rig's IK foot targets: front-L, front-R, back-L, back-R. */
const HUSKY_PAW_BONES = ["FFL", "FFR", "FFBL", "FFBR"];

/**
 * Husky quadruped pawn. Everything structural (load, capsule fit, slope pitch,
 * paw prints) lives in QuadrupedOnFoot — this class only names the rig's clips
 * and drives its gait FSM.
 */
export class HuskyOnFoot extends QuadrupedOnFoot {
  constructor({ scene, loader, excludeFromReflection, modelUrl = HUSKY_MODEL }) {
    super({
      scene,
      loader,
      excludeFromReflection,
      modelUrl,
      label: "Husky",
      targetHeight: HUSKY_HEIGHT,
      capsuleDefaults: HUSKY_CAPSULE_DEFAULTS,
      // The Husky rig exposes IK foot targets that sit at ground-contact height
      // and are keyframed in every gait, so their world XZ tracks the stride.
      pawBoneNames: HUSKY_PAW_BONES,
    });
  }

  _buildActions(gltf) {
    const gallopJumpClip = this._pickClip(gltf, "Gallop_Jump");
    this.airJumpDuration = gallopJumpClip?.duration ?? 1;

    this.actions = {
      idle: this._makeAction(this._pickClip(gltf, "Idle", "Idle_2")),
      headLow: this._makeAction(this._pickClip(gltf, "Idle_2_HeadLow")),
      walk: this._makeAction(this._pickClip(gltf, "Walk")),
      run: this._makeAction(this._pickClip(gltf, "Gallop")),
      airJump: this._makeAction(gallopJumpClip, true),
      attack: this._makeAction(this._pickClip(gltf, "Attack"), true),
      eating: this._makeAction(this._pickClip(gltf, "Eating"), true),
    };
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

  _tickAnim({ ctrl, keys, gallop, moveSpeed, mlen }) {
    const inAir = ctrl.inAir;
    const headLow = !!keys.KeyC;

    if (inAir && !this.airActive) {
      this.airActive = true;
      this.jumpPhase = "air";
      this.startAirJump({ gallop, speed: moveSpeed, ctrl });
    } else if (!inAir && this.airActive && ctrl.velY <= 0.05) {
      this.airActive = false;
      this.jumpPhase = "none";
      if (mlen > 0.01) {
        this.setAction(gallop ? this.actions.run : this.actions.walk, 0.12);
      } else {
        this.setAction(this.actions.idle, 0.12);
      }
    } else if (!inAir && this.jumpPhase === "none") {
      let tgt;
      if (headLow && mlen < 0.01) tgt = this.actions.headLow;
      else if (mlen > 0) tgt = gallop ? this.actions.run : this.actions.walk;
      else tgt = this.actions.idle;
      if (tgt) this.setAction(tgt, 0.15);
    }
  }
}
