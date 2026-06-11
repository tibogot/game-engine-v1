/**
 * Car driving layers — synth engine loop (pitch ∝ speed), wind, nitro, wheels, drift brake.
 * Assets: `./static/sounds/vehicle/*`
 */
import * as THREE from "three";

const CAR_NITRO_MIN = 0.05;
/** Keep in sync with `playMode.js` — carVx/carVz speed used for pitch. */
const CAR_MAX_SPEED = 45;
const CAR_MAX_SPEED_BOOST = 72;

const DEFAULT_PATHS = {
  engine: "./static/sounds/vehicle/joao_janz__synth-car-engine-loop.wav",
  wind: "./static/sounds/vehicle/wind-speed.mp3",
  nitro: "./static/sounds/vehicle/nitro-activation.mp3",
  wheels: "./static/sounds/vehicle/wheels-surface.mp3",
  driftBrake: "./static/sounds/vehicle/brak_SOUND.ogg",
};

/**
 * Howler: `loop: true` = whole file, or sprite `[startMs, durationMs, true]` for a looping window.
 * @param {object} playMode
 * @param {"engine"|"wind"|"wheels"|"driftBrake"} layer
 */
function howlerLoopLayerOptions(playMode, layer) {
  const s = playMode.carAudioSettings || {};
  const start = Math.max(0, Number(s[`${layer}LoopStartMs`]) || 0);
  const dur = Math.max(0, Number(s[`${layer}LoopDurationMs`]) || 0);
  if (dur > 0) {
    const spritePlayId = `_v2_${layer}`;
    return {
      loop: false,
      sprite: { [spritePlayId]: [start, dur, true] },
      spritePlayId,
    };
  }
  return { loop: true, sprite: undefined, spritePlayId: undefined };
}

/**
 * Reads `playMode.carAudioSettings` every frame so Tweakpane changes apply live.
 *
 * @param {object} playMode — `PlayMode` instance (`carAudioSettings`, `keysHeld`, `carVx`, …)
 * @param {{ register: Function, unregister: Function }} audioSystem — `createV2AudioSystem()` return
 * @param {Partial<typeof DEFAULT_PATHS>} [pathOverrides] — optional alternate asset URLs
 */
export function setupPlayModeCarAudio(playMode, audioSystem, pathOverrides = {}) {
  if (!audioSystem) return () => {};

  const paths = { ...DEFAULT_PATHS, ...pathOverrides };

  function settings() {
    const s = playMode.carAudioSettings || {};
    return {
      enabled: s.enabled !== false,
      engineMul: s.engineMul ?? 1,
      /** m/s where pitch hits max; 0 = auto (car max speed × scale). */
      engineRefTopSpeed: s.engineRefTopSpeed ?? 0,
      engineVol: s.engineVol ?? s.engineVolAtTop ?? 1,
      enginePitchMin: s.enginePitchMin ?? 1,
      /** Pitch at normal top speed (Shift off, ~45 m/s). */
      enginePitchMax: s.enginePitchMax ?? 2.85,
      /** Extra rev above normal top speed when Shift boost is faster (~72 m/s). */
      enginePitchBoostMax: s.enginePitchBoostMax ?? 3.55,
      enginePitchIdleSpeedMax: s.enginePitchIdleSpeedMax ?? 0.35,
      /** 1 = linear with speed; >1 adds more rev only near top speed. */
      enginePitchCurvePow: s.enginePitchCurvePow ?? 1,
      enginePitchEase: s.enginePitchEase ?? 10,
      engineFadeEaseUp: s.engineFadeEaseUp ?? 18,
      windMul: s.windMul ?? 0,
      nitroMul: s.nitroMul ?? 0.3,
      wheelsMul: s.wheelsMul ?? 0,
      driftBrakeMul: s.driftBrakeMul ?? 0.45,
    };
  }

  const registered = [];

  function carContextOk() {
    if (!settings().enabled || !playMode.active) return false;
    // Stunt car (rigid body) is always "loaded" (procedural meshes).
    if (playMode.moveMode === "stunt") return true;
    return playMode.moveMode === "car" && playMode.carLoaded;
  }

  function whenCar(fn) {
    return (item, dt) => {
      if (!carContextOk()) {
        const k = 1 - Math.exp(-6 * dt);
        item.volume += (0 - item.volume) * k;
        return;
      }
      fn(item, dt);
    };
  }

  function smoothVolume(item, target, dt, easeUp = 10, easeDown = 2.5) {
    const delta = target - item.volume;
    const easing = delta > 0 ? easeUp : easeDown;
    item.volume += delta * Math.min(1, dt * easing);
  }

  function smoothScalar(cur, target, dt, lambda = 8) {
    return cur + (target - cur) * Math.min(1, dt * lambda);
  }

  function carSpeedPitchLimits(playMode, st) {
    const scale = playMode.carSettings?.maxSpeedScale ?? 1;
    const manual = Number(st.engineRefTopSpeed);
    const normalMax =
      manual > 0 ? manual : CAR_MAX_SPEED * scale;
    const boostMax =
      manual > 0
        ? manual * (CAR_MAX_SPEED_BOOST / CAR_MAX_SPEED)
        : CAR_MAX_SPEED_BOOST * scale;
    const idleBand = Math.max(0, st.enginePitchIdleSpeedMax);
    return {
      idleBand,
      normalMax: Math.max(idleBand + 1, normalMax),
      boostMax: Math.max(normalMax + 1, boostMax),
    };
  }

  /**
   * Two-stage pitch: idle → normal max (Shift off cap), then higher rev in Shift boost range.
   */
  function enginePitchFromSpeed(playMode, st, curSpeed) {
    const { idleBand, normalMax, boostMax } = carSpeedPitchLimits(playMode, st);
    const pow = Math.max(0.25, st.enginePitchCurvePow);
    const pitchMin = st.enginePitchMin;
    const pitchMax = st.enginePitchMax;
    const pitchBoostMax = Math.max(
      pitchMax,
      st.enginePitchBoostMax ?? pitchMax * 1.24,
    );

    if (curSpeed <= idleBand) return pitchMin;

    if (curSpeed <= normalMax) {
      const t = THREE.MathUtils.clamp((curSpeed - idleBand) / (normalMax - idleBand), 0, 1);
      const drive = Math.pow(t, pow);
      return THREE.MathUtils.lerp(pitchMin, pitchMax, drive);
    }

    const t = THREE.MathUtils.clamp((curSpeed - normalMax) / (boostMax - normalMax), 0, 1);
    const drive = Math.pow(t, pow);
    return THREE.MathUtils.lerp(pitchMax, pitchBoostMax, drive);
  }

  // ── Synth engine loop: always on in car (idle = native pitch); revs up with speed
  const engLoop = howlerLoopLayerOptions(playMode, "engine");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.engine,
      loop: engLoop.loop,
      ...(engLoop.sprite ? { sprite: engLoop.sprite, spritePlayId: engLoop.spritePlayId } : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenCar((item, dt) => {
        const st = settings();
        const curSpeed = Math.sqrt(playMode.carVx * playMode.carVx + playMode.carVz * playMode.carVz);
        const targetVol = Math.min(1.5, st.engineVol * st.engineMul);
        smoothVolume(item, targetVol, dt, st.engineFadeEaseUp, 2.5);
        const rateTarget = enginePitchFromSpeed(playMode, st, curSpeed);
        item.rate = smoothScalar(item.rate, rateTarget, dt, st.enginePitchEase);
      }),
    }),
  );

  // ── Speed / air rush ──
  const windLoop = howlerLoopLayerOptions(playMode, "wind");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.wind,
      loop: windLoop.loop,
      ...(windLoop.sprite ? { sprite: windLoop.sprite, spritePlayId: windLoop.spritePlayId } : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenCar((item, dt) => {
        const curSpeed = Math.sqrt(playMode.carVx * playMode.carVx + playMode.carVz * playMode.carVz);
        const speedEffect = THREE.MathUtils.clamp(curSpeed * 0.1, 0, 1);
        const air = playMode.carInAir ? 0.35 : 1;
        const targetVol = speedEffect * air * settings().windMul;
        smoothVolume(item, targetVol, dt);
        const rateTarget = THREE.MathUtils.clamp(
          THREE.MathUtils.mapLinear(speedEffect, 0, 1, 1, 1.85),
          0.9,
          2,
        );
        item.rate += (rateTarget - item.rate) * Math.min(1, dt * 5);
      }),
    }),
  );

  // ── Nitro: one-shot activation clip (fires once per “nitro active” burst)
  const nitroItem = audioSystem.register({
    bus: "vehicle",
    src: paths.nitro,
    loop: false,
    autoplay: false,
    volume: 0,
    rate: 1,
    pool: 4,
    onPlaying: whenCar((item) => {
      const keys = playMode.keysHeld;
      const forward = keys.KeyW || keys.ArrowUp;
      const backward = keys.KeyS || keys.ArrowDown;
      const keyN = !!keys.KeyN;
      const curSpeed = Math.sqrt(playMode.carVx * playMode.carVx + playMode.carVz * playMode.carVz);
      const active =
        keyN &&
        forward &&
        !backward &&
        curSpeed > 1 &&
        playMode.carNitro > CAR_NITRO_MIN;
      const prevActive = item._nitroPrevActive === true;
      const rising = active && !prevActive;
      if (rising) {
        item.volume = settings().nitroMul;
        try {
          item.howl.stop();
        } catch (_) {
          /* ignore */
        }
        item.howl.play();
      }
      item._nitroPrevActive = active;
    }),
  });
  nitroItem.howl.on("end", () => {
    nitroItem.volume = 0;
  });
  registered.push(nitroItem);

  // ── Handbrake / drift brake loop (Space) ──
  const driftLoop = howlerLoopLayerOptions(playMode, "driftBrake");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.driftBrake,
      loop: driftLoop.loop,
      ...(driftLoop.sprite ? { sprite: driftLoop.sprite, spritePlayId: driftLoop.spritePlayId } : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenCar((item) => {
        const keys = playMode.keysHeld;
        const handbrake = !!keys.Space;
        const drifting = playMode.carDrifting === true;
        const curSpeed = Math.sqrt(playMode.carVx * playMode.carVx + playMode.carVz * playMode.carVz);
        const speedGate = THREE.MathUtils.smoothstep(curSpeed, 2, 16);
        if (!handbrake && !drifting) {
          item.volume = 0;
          item.rate = 1;
          return;
        }
        const st = settings();
        let drive;
        if (drifting) {
          drive = 0.78 + speedGate * 0.24;
        } else {
          drive = speedGate * 0.85;
        }
        const targetVol = Math.min(1.05, drive * st.driftBrakeMul);
        item.volume = targetVol;
        item.rate = THREE.MathUtils.lerp(
          0.94,
          1.14,
          THREE.MathUtils.smoothstep(curSpeed, 4, 26),
        );
      }),
    }),
  );

  // ── Wheels on surface ──
  const wheelsLoop = howlerLoopLayerOptions(playMode, "wheels");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.wheels,
      loop: wheelsLoop.loop,
      ...(wheelsLoop.sprite ? { sprite: wheelsLoop.sprite, spritePlayId: wheelsLoop.spritePlayId } : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenCar((item, dt) => {
        const curSpeed = Math.sqrt(playMode.carVx * playMode.carVx + playMode.carVz * playMode.carVz);
        const grounded = playMode.carInAir ? 0 : 1;
        const targetVol =
          THREE.MathUtils.clamp(curSpeed * 0.1, 0, 1) * grounded * settings().wheelsMul;
        smoothVolume(item, targetVol, dt);
      }),
    }),
  );

  return () => {
    for (const r of registered) {
      audioSystem.unregister(r);
    }
    registered.length = 0;
  };
}
