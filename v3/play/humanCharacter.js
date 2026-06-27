import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

const CHAR_HEIGHT   = 2.5;
const WALK_ANIM_REF = 2.0;
const RUN_ANIM_REF  = 5.5;
const YAW_LERP_RATE = 14;
const FADE_TIME     = 0.18; // matches v2

const MODEL_PATH = "/models/UA1+UA2_compressed.glb";
const KATANA_PATH = "/models/katana.glb";
const HAT_PATH    = "/models/asian_conical_hat_compressed.glb";

let _loader = null;
function getLoader(renderer) {
  if (_loader) return _loader;
  const draco = new DRACOLoader();
  draco.setDecoderPath("https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/");
  const ktx2 = new KTX2Loader();
  ktx2.setTranscoderPath("https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/basis/");
  ktx2.detectSupport(renderer);
  _loader = new GLTFLoader();
  _loader.setDRACOLoader(draco);
  _loader.setKTX2Loader(ktx2);
  return _loader;
}

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

  const loader = getLoader(renderer);

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

      charActions = {
        idle:       mk(pick("Idle_Loop")),
        walk:       mk(pick("Walk_Loop")),
        run:        mk(pick("Sprint_Loop", "Jog_Fwd_Loop")),
        jumpStart:  mk(pick("Jump_Start"), true),
        jumpLoop:   mk(pick("Jump_Loop", "NinjaJump_Idle_Loop")),
        jumpLand:   mk(pick("Jump_Land"), true),
        crouch:     mk(pick("Crouch_Idle_Loop")),
        crouchWalk: mk(pick("Crouch_Fwd_Loop")),
      };

      if (charActions.jumpStart) charActions.jumpStart.timeScale = 1.4;
      if (charActions.jumpLand)  charActions.jumpLand.timeScale  = 1.8;

      charMixer.addEventListener("finished", e => {
        if (e.action === charActions?.jumpLand) jumpPhase = "none";
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

  // ── Public API ──────────────────────────────────────────────────────────────
  return {
    get loaded() { return loaded; },

    setVisible(v) { if (charRoot) charRoot.visible = v; },

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

      // Yaw: smoothly face movement direction
      if (mlen > 0.01) {
        const targetYaw = Math.atan2(mx, mz);
        let dYaw = targetYaw - charYaw;
        while (dYaw >  Math.PI) dYaw -= 2 * Math.PI;
        while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
        charYaw += dYaw * (1 - Math.exp(-YAW_LERP_RATE * dt));
      }
      charRoot.rotation.y = charYaw;

      // Animation FSM (mirrors char-test.html / v2 playMode)
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
      } else if (!inAir && jumpPhase === "none") {
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
      if (charRoot) charRoot.rotation.y = 0;
    },
  };
}
