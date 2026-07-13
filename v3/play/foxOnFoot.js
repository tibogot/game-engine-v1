import { QuadrupedOnFoot, QUADRUPED_CAPSULE_DEFAULTS } from "../../v2/play/quadrupedOnFoot.js";

export const FOX_MODEL = "/models/fox.glb";
/** Overall model height in metres — the one knob for how big the fox reads. */
export const FOX_HEIGHT = 1.15;

/**
 * Same controller, same numbers as the husky — the fox is deliberately not its
 * own physics feel. The capsule's radius/height/forward offset are auto-fitted
 * from the model bounds, so the smaller body gets a proportionally smaller
 * collider for free. Only the run speed is nudged: a fox is the quicker animal.
 */
export const FOX_CAPSULE_DEFAULTS = {
  ...QUADRUPED_CAPSULE_DEFAULTS,
  runSpeed: 7.5,
};

/** fox.glb's ground-contact foot bones: front-L, front-R, back-L, back-R. */
const FOX_PAW_BONES = [
  "Front_Leg_Foot_L",
  "Front_Leg_Foot_R",
  "Back_Leg_Foot_L",
  "Back_Leg_Foot_R",
];

/**
 * Fox pawn. Structurally identical to the husky (same QuadrupedOnFoot base, same
 * CapsuleController), so movement, jumping, slope pitch and paw prints all behave
 * the same. The rig is richer, so the FSM adds a fall clip, a sneak gait, a held
 * sit, and the bite/bark/howl one-shots.
 *
 * fox.glb is authored nose-down-+Z, which already matches play mode's facing
 * convention (forward = +Z), so it needs no yaw offset.
 */
export class FoxOnFoot extends QuadrupedOnFoot {
  constructor({ scene, loader, excludeFromReflection, modelUrl = FOX_MODEL }) {
    super({
      scene,
      loader,
      excludeFromReflection,
      modelUrl,
      label: "Fox",
      targetHeight: FOX_HEIGHT,
      capsuleDefaults: FOX_CAPSULE_DEFAULTS,
      pawBoneNames: FOX_PAW_BONES,
      tune: {
        modelYawOffset: 0,
        walkAnimRef: 1.6,
        runAnimRef: 5.5,
        sneakAnimRef: 1.4,
        // Landmarks inside the 2.2s Jump clip, in clip-seconds (measured off the
        // Hips translation track). The clip opens with ~0.4s of standing and an
        // anticipation crouch that the game has no time for — the capsule is
        // already airborne the frame you press jump — so playback starts at the
        // moment the paws leave the ground and ends as they touch down again.
        jumpLiftOff: 0.87,
        jumpTouchDown: 1.60,
      },
    });

    this.sitting = false;
  }

  _buildActions(gltf) {
    const jumpClip = this._pickClip(gltf, "Jump");
    this.airJumpDuration = jumpClip?.duration ?? 1;

    this.actions = {
      idle: this._makeAction(this._pickClip(gltf, "Idle")),
      alert: this._makeAction(this._pickClip(gltf, "Idle Alert")),
      walk: this._makeAction(this._pickClip(gltf, "Walk")),
      run: this._makeAction(this._pickClip(gltf, "Run")),
      sneak: this._makeAction(this._pickClip(gltf, "Sneak")),
      airJump: this._makeAction(jumpClip, true),
      fall: this._makeAction(this._pickClip(gltf, "Fall")),
      bite: this._makeAction(this._pickClip(gltf, "Bite"), true),
      bark: this._makeAction(this._pickClip(gltf, "Bark"), true),
      howl: this._makeAction(this._pickClip(gltf, "Howl"), true),
      sit: this._makeAction(this._pickClip(gltf, "Sit"), true),
    };
  }

  /**
   * Scrub straight to the lift-off frame and play the leap at (near) its authored
   * speed. The clip's airborne span is ~0.73s and the capsule's default arc is
   * ~0.75s, so this lands on ≈1× — speeding the whole 2.2s clip up to fit the
   * airtime instead is what made the jump read as a twitch.
   *
   * The remaining stretch is only to keep the paws touching down as the capsule
   * does when jump height / gravity are tuned away from the defaults.
   */
  startAirJump({ ctrl }) {
    const a = this.actions?.airJump;
    if (!a) return;

    const airtime = (2 * ctrl.params.jumpVel) / Math.max(ctrl.params.gravity, 1);
    const clipSpan = this.tune.jumpTouchDown - this.tune.jumpLiftOff;
    const fit = clipSpan / Math.max(airtime, 0.15);
    a.timeScale = Math.max(0.7, Math.min(1.6, fit));

    a.reset().enabled = true;
    a.time = this.tune.jumpLiftOff;
    if (this.currentAction && this.currentAction !== a) {
      a.crossFadeFrom(this.currentAction, 0.08, false);
    }
    a.play();
    this.currentAction = a;
  }

  resetAnimState() {
    this.sitting = false;
    super.resetAnimState();
  }

  onKeyDown(code) {
    // Sitting is a held pose — any of the other one-shots (or moving) breaks it.
    if (code === "KeyE") {
      if (this.sitting) {
        this.sitting = false;
        this.releaseOneShot();
        this.setAction(this.actions?.idle, 0.15);
      } else if (this.actions?.sit) {
        this.sitting = true;
        this.playHold(this.actions.sit);
      }
      return true;
    }
    const oneShot = { KeyF: "bite", KeyR: "bark", KeyT: "howl" }[code];
    if (oneShot && this.actions?.[oneShot]) {
      this.sitting = false;
      this.playOneShot(this.actions[oneShot]);
      return true;
    }
    return false;
  }

  _maybeReleaseLock({ ctrl, mlen }) {
    // `_lockAction` is null only for a held pose; a bite in progress must play out.
    if (!this.sitting || this._lockAction) return;
    if (mlen > 0.01 || ctrl.inAir) {
      this.sitting = false;
      this.releaseOneShot();
    }
  }

  _tickAnim({ ctrl, keys, gallop, moveSpeed, mlen }) {
    const inAir = ctrl.inAir;
    const moving = mlen > 0.01;
    const sneaking = !!keys.KeyC && !gallop;

    if (inAir && !this.airActive) {
      this.airActive = true;
      if (ctrl.velY < 0) {
        // Walked off a ledge rather than jumping — there is no take-off to play.
        this.jumpPhase = "fall";
        this.setAction(this.actions.fall ?? this.actions.airJump, 0.15);
      } else {
        this.jumpPhase = "air";
        this.startAirJump({ ctrl });
      }
    } else if (
      inAir &&
      this.jumpPhase === "air" &&
      this.actions.airJump &&
      this.actions.airJump.time >= this.tune.jumpTouchDown
    ) {
      // The leap reached the frame where the paws should touch down and we're
      // STILL airborne — this is a real drop (jumped off a cliff), so hand over to
      // the looping fall. A normal hop lands before this, so it never cuts the leap.
      this.jumpPhase = "fall";
      this.setAction(this.actions.fall ?? this.actions.airJump, 0.18);
    } else if (!inAir && this.airActive && ctrl.velY <= 0.05) {
      this.airActive = false;
      this.jumpPhase = "none";
      this.setAction(this._groundAction({ moving, sneaking, gallop }), 0.12);
    } else if (!inAir && this.jumpPhase === "none") {
      this.setAction(this._groundAction({ moving, sneaking, gallop }), 0.15);
    }

    if (this.actions.sneak && moveSpeed > 0) {
      this.actions.sneak.timeScale = moveSpeed / this.tune.sneakAnimRef;
    }
  }

  /** Ctrl-crouch reads as "sneak" while moving and as a wary "alert" idle when still. */
  _groundAction({ moving, sneaking, gallop }) {
    if (sneaking) {
      if (moving) return this.actions.sneak ?? this.actions.walk;
      return this.actions.alert ?? this.actions.idle;
    }
    if (moving) return gallop ? this.actions.run : this.actions.walk;
    return this.actions.idle;
  }
}
