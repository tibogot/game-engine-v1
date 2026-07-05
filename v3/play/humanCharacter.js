import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";

const CHAR_HEIGHT   = 2.5;
const WALK_ANIM_REF = 2.0;
const RUN_ANIM_REF  = 5.5;
const YAW_LERP_RATE = 14;
const FADE_TIME     = 0.18; // matches v2
const CHAR_ROLL_PEAK       = 13.0;
const CHAR_SLIDE_SPEED     = 10.0;
const CHAR_SLIDE_MAX_TIME  = 1.2;
const PI = Math.PI;

const MODEL_PATH = "/models/UA1+UA2_compressed.glb";
const KATANA_PATH = "/models/katana.glb";
const HAT_PATH    = "/models/asian_conical_hat_compressed.glb";

export function createHumanCharacter(scene, renderer) {
  let charRoot      = null;
  let charMixer     = null;
  let charActions   = null;
  let currentAction = null;

  let charYaw   = 0;
  let airActive = false;
  let jumpPhase = "none"; // "start" | "loop" | "land" | "none"
  let airTime   = 0;
  let loaded    = false;
  let footBoneL = null;
  let footBoneR = null;

  let rolling      = false;
  let rollYaw      = 0;
  let rollStart    = 0;
  let rollDuration = 0.8;
  let slidePhase   = "none"; // "start" | "loop" | "exit" | "none"
  let slideYaw     = 0;
  let slideStart   = 0;

  const _footPosL = new THREE.Vector3();
  const _footPosR = new THREE.Vector3();

  const loader = getSharedGltfLoader();

  // Find a bone by trying multiple naming conventions (Mixamo, Blender, etc.)
  function findBone(model, ...candidates) {
    let found = null;
    model.traverse(o => {
      if (found) return;
      if (o.isBone || o.isObject3D) {
        if (candidates.includes(o.name)) found = o;
      }
    });
    return found;
  }

  // ── Load main character model ───────────────────────────────────────────────
  loader.load(MODEL_PATH, (gltf) => {
    const model = gltf.scene;
    model.traverse(o => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow    = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });

    // Normalize to CHAR_HEIGHT — feet at local Y = 0
    const box = new THREE.Box3().setFromObject(model);
    const sz  = new THREE.Vector3();
    box.getSize(sz);
    model.scale.setScalar(CHAR_HEIGHT / (sz.y || 1));
    box.setFromObject(model);
    model.position.y -= box.min.y;

    charRoot = new THREE.Group();
    charRoot.add(model);
    charRoot.visible = false;
    scene.add(charRoot);

    // ── Find attachment bones ─────────────────────────────────────────────────
    const rightHand = findBone(model,
      "DEF-handR", "hand.R", "mixamorigRightHand", "RightHand", "hand_r");
    const headBone  = findBone(model,
      "DEF-head", "head", "Head", "mixamorigHead", "head_01");
    footBoneL = findBone(model,
      "DEF-foot.L", "foot.L", "mixamorigLeftFoot", "LeftFoot", "foot_l");
    footBoneR = findBone(model,
      "DEF-foot.R", "foot.R", "mixamorigRightFoot", "RightFoot", "foot_r");

    // ── Katana ────────────────────────────────────────────────────────────────
    if (rightHand) {
      const sg = new THREE.Group();
      sg.position.set(-0.07, 0.115, -0.2);
      sg.rotation.set(-1.37, 1.8, -2.21);
      rightHand.add(sg);

      loader.load(KATANA_PATH, (kg) => {
        const ks = kg.scene;
        ks.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        const kb  = new THREE.Box3().setFromObject(ks);
        const ksz = new THREE.Vector3();
        kb.getSize(ksz);
        const kscale = 1.0 / (Math.max(ksz.x, ksz.y, ksz.z) || 1);
        ks.scale.setScalar(kscale);
        kb.setFromObject(ks);
        ks.position.set(-kb.min.x, -kb.min.y, -kb.min.z);
        sg.add(ks);
      }, undefined, e => console.warn("[HumanChar] katana load failed:", e));
    }

    // ── Hat ───────────────────────────────────────────────────────────────────
    if (headBone) {
      loader.load(HAT_PATH, (hg) => {
        const hs = hg.scene;
        hs.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        const hatScale = CHAR_HEIGHT / 1.8;
        hs.scale.setScalar(0.65 * hatScale);
        hs.position.set(0, 0.2, 0);
        headBone.add(hs);
      }, undefined, e => console.warn("[HumanChar] hat load failed:", e));
    }

    // ── Animations ────────────────────────────────────────────────────────────
    if (gltf.animations?.length) {
      charMixer = new THREE.AnimationMixer(model);

      const pick = (...names) => gltf.animations.find(
        a => names.some(n => a.name === n || a.name === n + "_Armature")
      ) ?? null;

      const mk = (clip, once = false) => {
        if (!clip) return null;
        const a = charMixer.clipAction(clip)
          .setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat);
        if (once) a.clampWhenFinished = true;
        return a;
      };

      const idleClip = pick("Idle_Loop");
      const rollClip = pick("Roll", "Roll_RM") || idleClip;
      const slideStartClip = pick("Slide_Start");
      const slideLoopClip  = pick("Slide_Loop") || slideStartClip;
      const slideExitClip  = pick("Slide_Exit") || slideLoopClip;

      charActions = {
        idle:       mk(idleClip),
        walk:       mk(pick("Walk_Loop")),
        run:        mk(pick("Sprint_Loop", "Jog_Fwd_Loop")),
        jumpStart:  mk(pick("Jump_Start"), true),
        jumpLoop:   mk(pick("Jump_Loop", "NinjaJump_Idle_Loop")),
        jumpLand:   mk(pick("Jump_Land"), true),
        crouch:     mk(pick("Crouch_Idle_Loop")),
        crouchWalk: mk(pick("Crouch_Fwd_Loop")),
        roll:       mk(rollClip, true),
        slideStart: mk(slideStartClip, true),
        slideLoop:  mk(slideLoopClip, false),
        slideExit:  mk(slideExitClip, true),
      };

      if (charActions.jumpStart) charActions.jumpStart.timeScale = 1.4;
      if (charActions.jumpLand)  charActions.jumpLand.timeScale  = 1.8;
      if (charActions.roll) {
        const d = charActions.roll.getClip()?.duration;
        if (d && d > 0) rollDuration = d;
      }

      charMixer.addEventListener("finished", e => {
        if (e.action === charActions?.jumpLand) jumpPhase = "none";
        if (e.action === charActions?.roll) rolling = false;
        if (e.action === charActions?.slideStart && slidePhase === "start" && charActions.slideLoop) {
          slidePhase = "loop";
          setAction(charActions.slideLoop, 0.1);
        }
        if (e.action === charActions?.slideExit) slidePhase = "none";
      });

      currentAction = charActions.idle;
      currentAction?.play();
    }

    loaded = true;
  }, undefined, err => {
    console.warn("[HumanChar] Failed to load character model:", err);
  });

  // ── Animation helper ────────────────────────────────────────────────────────
  function setAction(next, fade = FADE_TIME) {
    if (!next || next === currentAction) return;
    next.reset().enabled = true;
    next.crossFadeFrom(currentAction, fade, false).play();
    currentAction = next;
  }

  function tryRoll() {
    if (!charActions?.roll || rolling || slidePhase !== "none") return false;
    rolling = true;
    rollYaw = charYaw;
    rollStart = performance.now();
    setAction(charActions.roll, 0.1);
    return true;
  }

  function trySlide(moving) {
    if (!moving || !charActions?.slideStart || rolling || slidePhase !== "none" || airActive) return false;
    slidePhase = "start";
    slideYaw = charYaw;
    slideStart = performance.now();
    setAction(charActions.slideStart, 0.1);
    return true;
  }

  /** Roll/slide movement override for CapsuleController (v2 playMode parity). */
  function getMoveOverride(moveKeysHeld, slideKeyHeld) {
    if (rolling) {
      const elapsed = (performance.now() - rollStart) / 1000;
      const t = Math.min(1, elapsed / rollDuration);
      if (moveKeysHeld && t >= 0.75) {
        rolling = false;
        return null;
      }
      const speed = CHAR_ROLL_PEAK * Math.cos(t * PI * 0.5);
      return { mx: Math.sin(rollYaw), mz: Math.cos(rollYaw), speed };
    }
    if (slidePhase !== "none") {
      if (slidePhase === "loop") {
        const elapsed = (performance.now() - slideStart) / 1000;
        if ((elapsed >= CHAR_SLIDE_MAX_TIME || !slideKeyHeld) && charActions?.slideExit) {
          slidePhase = "exit";
          setAction(charActions.slideExit, 0.12);
        }
      }
      return { mx: Math.sin(slideYaw), mz: Math.cos(slideYaw), speed: CHAR_SLIDE_SPEED };
    }
    return null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    get loaded() { return loaded; },
    get rolling() { return rolling; },
    get slidePhase() { return slidePhase; },
    get inSlide() { return slidePhase !== "none"; },
    get jumpPhase() { return jumpPhase; },
    get movementBusy() { return rolling || slidePhase !== "none"; },
    get footBoneL() { return footBoneL; },
    get footBoneR() { return footBoneR; },
    tryRoll,
    trySlide,
    getMoveOverride,

    /** World positions of foot bones (after update). */
    getFootWorldPositions(outL = _footPosL, outR = _footPosR) {
      if (footBoneL) footBoneL.getWorldPosition(outL);
      if (footBoneR) footBoneR.getWorldPosition(outR);
      return { left: outL, right: outR };
    },

    setVisible(v) { if (charRoot) charRoot.visible = v; },

    setYaw(y) {
      charYaw = y;
      if (charRoot) charRoot.rotation.y = y;
    },

    /**
     * @param {number} dt    — delta seconds
     * @param {object} ctrl  — CapsuleController
     * @param {object} input — { mx, mz, run, crouch }
     */
    update(dt, ctrl, input) {
      if (!charRoot || !charMixer || !charActions) return;

      const { mx = 0, mz = 0, run = false, crouch = false } = input;
      const mlen = Math.hypot(mx, mz);

      // Position — capsule.position.y = feet
      charRoot.position.set(ctrl.position.x, ctrl.position.y, ctrl.position.z);

      // Yaw: smoothly face movement direction (skip during roll/slide)
      if (mlen > 0.01 && !rolling && slidePhase === "none") {
        const targetYaw = Math.atan2(mx, mz);
        let dYaw = targetYaw - charYaw;
        while (dYaw >  Math.PI) dYaw -= 2 * Math.PI;
        while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
        charYaw += dYaw * (1 - Math.exp(-YAW_LERP_RATE * dt));
      }
      charRoot.rotation.y = charYaw;

      // Animation FSM (mirrors v2 playMode char locomotion)
      const inAir    = ctrl.inAir;
      airTime = inAir ? airTime + dt : 0;
      const enterAir = inAir && (ctrl.velY > 0.5 || airTime > 0.12);

      if (enterAir && !airActive) {
        airActive = true;
        if (ctrl.velY > 0.5 && charActions.jumpStart) {
          jumpPhase = "start";
          setAction(charActions.jumpStart, 0.08);
        } else if (charActions.jumpLoop) {
          jumpPhase = "loop";
          setAction(charActions.jumpLoop, 0.12);
        }
      } else if (!inAir && airActive) {
        airActive = false;
        if (mlen > 0.01) {
          jumpPhase = "none";
          setAction(run ? charActions.run : charActions.walk, 0.12);
        } else if (charActions.jumpLand) {
          jumpPhase = "land";
          setAction(charActions.jumpLand, 0.1);
        }
      } else if (!inAir && jumpPhase === "none" && !rolling && slidePhase === "none") {
        let tgt;
        if (crouch)        tgt = mlen > 0 ? charActions.crouchWalk : charActions.crouch;
        else if (mlen > 0) tgt = run ? charActions.run : charActions.walk;
        else               tgt = charActions.idle;
        if (tgt) setAction(tgt);
      }

      // Speed sync — walk/run animation rate matches actual movement
      const speed = ctrl.debug.moveSpeed;
      if (charActions.walk && speed > 0)
        charActions.walk.timeScale = speed / WALK_ANIM_REF;
      if (charActions.run  && speed > 0)
        charActions.run.timeScale  = speed / RUN_ANIM_REF;
      if (charActions.crouchWalk && speed > 0)
        charActions.crouchWalk.timeScale = speed / (WALK_ANIM_REF * 0.5);

      charMixer.update(dt);
    },

    get yaw() { return charYaw; },

    reset() {
      charYaw   = 0;
      airActive = false;
      jumpPhase = "none";
      airTime   = 0;
      rolling = false;
      slidePhase = "none";
      if (charRoot) charRoot.rotation.y = 0;
    },
  };
}
