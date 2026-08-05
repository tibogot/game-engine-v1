/**
 * Modular Road Lab — vehicle driving audio + Howler mixer.
 * Same assets and layering as v2 play-mode car audio; standalone (no v2 imports).
 */
import * as THREE from "three";
import { Howl, Howler } from "howler";
import { TIRE } from "../../v3/play/modularRoadVehicle.js";

const RATE_MIN = 0.5;
const RATE_MAX = 4;
const DRIFT_ANGLE_MIN = 0.1;
const DRIFT_ENTRY_SPEED = 8;

export const AUDIO_BUS_IDS = [
  "master",
  "sfx",
  "music",
  "voice",
  "ui",
  "vehicle",
];

export const DEFAULT_MIXER = {
  muteAll: true,
  pauseWhenHidden: true,
  buses: {
    master: { volume: 1, mute: false },
    sfx: { volume: 1, mute: false },
    music: { volume: 0.85, mute: false },
    voice: { volume: 1, mute: false },
    ui: { volume: 1, mute: false },
    vehicle: { volume: 1, mute: false },
  },
};

/** Layer gains — mirrors v2 `toolState.playCarAudio` defaults (engine on, wind/wheels off). */
export const DEFAULT_VEHICLE_AUDIO_SETTINGS = {
  enabled: true,
  engineMul: 1,
  engineRefTopSpeed: 0,
  engineVol: 1,
  enginePitchMin: 1,
  enginePitchMax: 2.85,
  enginePitchBoostMax: 3.55,
  enginePitchIdleSpeedMax: 0.35,
  enginePitchCurvePow: 1,
  enginePitchEase: 10,
  engineFadeEaseUp: 18,
  windMul: 0,
  nitroMul: 0.3,
  wheelsMul: 0,
  driftBrakeMul: 0.45,
  engineLoopStartMs: 0,
  engineLoopDurationMs: 0,
  windLoopStartMs: 0,
  windLoopDurationMs: 0,
  wheelsLoopStartMs: 0,
  wheelsLoopDurationMs: 0,
  driftBrakeLoopStartMs: 0,
  driftBrakeLoopDurationMs: 0,
};

const DEFAULT_PATHS = {
  engine: "/v2/static/sounds/vehicle/joao_janz__synth-car-engine-loop.wav",
  wind: "/v2/static/sounds/vehicle/wind-speed.mp3",
  nitro: "/v2/static/sounds/vehicle/nitro-activation.mp3",
  wheels: "/v2/static/sounds/vehicle/wheels-surface.mp3",
  driftBrake: "/v2/static/sounds/vehicle/brak_SOUND.ogg",
};

const _velHoriz = new THREE.Vector3();
const _chassisFwd = new THREE.Vector3();

/** Unity-style bus mixer — adapted from v2 `createV2AudioSystem`. */
export function createModularRoadAudioSystem({ mixerState }) {
  const audioState = mixerState;
  const howls = [];
  const items = [];
  let disposed = false;
  let hiddenSuspended = false;
  let audioUnlocked = false;

  function getBus(busId) {
    return audioState.buses[busId] ?? audioState.buses.sfx;
  }

  function getEffectiveBusScalar(busId) {
    if (audioState.muteAll) return 0;
    const master = audioState.buses.master;
    if (!master || master.mute || master.volume <= 0) return 0;
    const mv = master.volume;
    if (busId === "master") return mv;
    const b = getBus(busId);
    if (b.mute || b.volume <= 0) return 0;
    return mv * b.volume;
  }

  function onVisibility() {
    if (!audioState.pauseWhenHidden || !Howler.ctx) return;
    if (document.hidden) {
      if (Howler.ctx.state === "running") {
        Howler.ctx.suspend();
        hiddenSuspended = true;
      }
    } else if (hiddenSuspended) {
      Howler.ctx.resume().catch(() => {});
      hiddenSuspended = false;
    }
  }

  document.addEventListener("visibilitychange", onVisibility);

  function tryStartPlayback(item) {
    if (
      disposed ||
      !audioUnlocked ||
      !item._startWhenUnlocked ||
      item._playbackStarted
    )
      return;
    const h = item.howl;
    if (h.state() !== "loaded") return;
    try {
      const id =
        item._spritePlayId != null ? h.play(item._spritePlayId) : h.play();
      if (id != null) item._playbackStarted = true;
    } catch (_) {
      /* autoplay policy */
    }
  }

  function register(options) {
    const bus = options.bus ?? "sfx";
    const startWhenUnlocked = options.autoplay === true && !disposed;
    const spriteDef = options.sprite ?? null;
    let spritePlayId = options.spritePlayId ?? null;
    if (spriteDef && spritePlayId == null) {
      const ks = Object.keys(spriteDef);
      if (ks.length) spritePlayId = ks[0];
    }
    const useSprite = !!(spriteDef && spritePlayId);

    const item = {
      bus,
      volume: options.volume ?? 1,
      rate: options.rate ?? 1,
      onPlaying: options.onPlaying ?? null,
      _startWhenUnlocked: startWhenUnlocked,
      _playbackStarted: false,
      _spritePlayId: useSprite ? spritePlayId : null,
      howl: new Howl({
        src: Array.isArray(options.src) ? options.src : [options.src],
        loop: useSprite ? false : (options.loop ?? false),
        autoplay: false,
        volume: 0,
        preload: options.preload !== false,
        pool: options.pool ?? 2,
        ...(useSprite ? { sprite: spriteDef } : {}),
        onload: () => tryStartPlayback(item),
        onloaderror:
          options.onLoadError ??
          ((_id, err) =>
            console.warn("[modular-road audio] load error", options.src, err)),
      }),
    };
    howls.push(item.howl);
    items.push(item);
    if (audioUnlocked) tryStartPlayback(item);
    return item;
  }

  function unregister(item) {
    const i = items.indexOf(item);
    if (i === -1) return;
    items.splice(i, 1);
    const hi = howls.indexOf(item.howl);
    if (hi >= 0) howls.splice(hi, 1);
    try {
      item.howl.stop();
      item.howl.unload();
    } catch (_) {
      /* ignore */
    }
  }

  async function unlock() {
    try {
      if (Howler.ctx?.state === "suspended") await Howler.ctx.resume();
    } catch (_) {
      /* ignore */
    }
    audioUnlocked = true;
    for (const item of items) tryStartPlayback(item);
  }

  // Howler caps per-sound volume at 1.0, so a quiet source can never be
  // boosted past its native loudness. When a layer asks for >1 gain we keep
  // Howler at unity and set the underlying GainNode(s) to the absolute target.
  // NOTE: absolute assignment (not multiply) — multiplying compounds every
  // frame and runs away into ear-splitting distortion.
  function applyAbsoluteGain(howl, gain) {
    const sounds = howl?._sounds;
    if (!sounds || !sounds.length) return;
    for (const s of sounds) {
      const node = s?._node;
      if (node && node.gain) node.gain.value = gain;
    }
  }

  function update(dtSec) {
    if (disposed) return;
    if (audioUnlocked) {
      for (const item of items) tryStartPlayback(item);
    }
    for (const item of items) {
      if (typeof item.onPlaying === "function") item.onPlaying(item, dtSec);
      const busScalar = getEffectiveBusScalar(item.bus);
      const desired = Math.max(0, item.volume * busScalar); // may exceed 1
      const base = Math.min(1, desired);
      item.howl.volume(base);
      item.howl.mute(base < 1e-4);
      // Per-sound node gain = the howl's linear volume (Howler's global
      // volume is applied downstream at masterGain). Set it absolutely to the
      // above-unity target so there's no frame-to-frame compounding.
      if (desired > 1.0001) applyAbsoluteGain(item.howl, desired);
      const r = Math.max(RATE_MIN, Math.min(RATE_MAX, item.rate));
      item.howl.rate(r);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    for (const h of howls) {
      try {
        h.stop();
        h.unload();
      } catch (_) {
        /* ignore */
      }
    }
    howls.length = 0;
    items.length = 0;
  }

  return {
    register,
    unregister,
    update,
    dispose,
    unlock,
    getEffectiveBusScalar,
    Howler,
  };
}

function howlerLoopLayerOptions(settings, layer) {
  const start = Math.max(0, Number(settings[`${layer}LoopStartMs`]) || 0);
  const dur = Math.max(0, Number(settings[`${layer}LoopDurationMs`]) || 0);
  if (dur > 0) {
    const spritePlayId = `_mr_${layer}`;
    return {
      loop: false,
      sprite: { [spritePlayId]: [start, dur, true] },
      spritePlayId,
    };
  }
  return { loop: true, sprite: undefined, spritePlayId: undefined };
}

function smoothVolume(item, target, dt, easeUp = 10, easeDown = 2.5) {
  const delta = target - item.volume;
  const easing = delta > 0 ? easeUp : easeDown;
  item.volume += delta * Math.min(1, dt * easing);
}

function smoothScalar(cur, target, dt, lambda = 8) {
  return cur + (target - cur) * Math.min(1, dt * lambda);
}

/**
 * How fast the car is actually travelling — the FULL 3D speed.
 *
 * This used to drop the Y component, which is only equivalent to real speed
 * while the road is roughly level. On the vertical flanks of a loop the car is
 * moving almost purely upward, so the horizontal-only measure collapsed to ~0
 * at 150 km/h: the engine fell to idle, the wind died and the tyre roll cut out
 * halfway up every loop. Same story on quarter-pipes, wall-rides and tubes.
 *
 * Drift detection deliberately still works in the horizontal plane — see
 * isDrifting, which now takes its own measurement rather than sharing a scratch
 * vector with this.
 */
function travelSpeed(body) {
  return body.vel.length();
}

/**
 * Slip between where the car points and where it is going, measured in the
 * horizontal plane (both terms flattened, so it stays consistent). Self
 * contained on purpose: it used to read `_velHoriz` left behind by the last
 * horizontalSpeed() call, which silently coupled it to an unrelated helper.
 */
function isDrifting(vehicle) {
  _velHoriz.copy(vehicle.body.vel);
  _velHoriz.y = 0;
  const horiz = _velHoriz.length();
  if (horiz < DRIFT_ENTRY_SPEED || horiz < 0.5) return false;
  _chassisFwd.set(0, 0, 1).applyQuaternion(vehicle.body.quat);
  _chassisFwd.y = 0;
  if (_chassisFwd.lengthSq() < 1e-8) return false;
  _chassisFwd.normalize();
  const driftAngle = Math.acos(
    THREE.MathUtils.clamp(_velHoriz.dot(_chassisFwd) / horiz, -1, 1),
  );
  return driftAngle > DRIFT_ANGLE_MIN;
}

function enginePitchFromSpeed(st, curSpeed, normalMax) {
  const idleBand = Math.max(0, st.enginePitchIdleSpeedMax);
  const boostMax = Math.max(normalMax + 1, normalMax * 1.6);
  const pow = Math.max(0.25, st.enginePitchCurvePow);
  const pitchMin = st.enginePitchMin;
  const pitchMax = st.enginePitchMax;
  const pitchBoostMax = Math.max(
    pitchMax,
    st.enginePitchBoostMax ?? pitchMax * 1.24,
  );

  if (curSpeed <= idleBand) return pitchMin;
  if (curSpeed <= normalMax) {
    const t = THREE.MathUtils.clamp(
      (curSpeed - idleBand) / (normalMax - idleBand),
      0,
      1,
    );
    return THREE.MathUtils.lerp(pitchMin, pitchMax, Math.pow(t, pow));
  }
  const t = THREE.MathUtils.clamp(
    (curSpeed - normalMax) / (boostMax - normalMax),
    0,
    1,
  );
  return THREE.MathUtils.lerp(pitchMax, pitchBoostMax, Math.pow(t, pow));
}

/**
 * Register synth engine, wind, wheels, handbrake, and nitro layers on the vehicle bus.
 *
 * @param {ReturnType<typeof createModularRoadAudioSystem>} audioSystem
 * @param {{
 *   vehicle: import("./modularRoadVehicle.js").Vehicle,
 *   settings: typeof DEFAULT_VEHICLE_AUDIO_SETTINGS,
 *   getKeys?: () => Record<string, boolean>,
 *   pathOverrides?: Partial<typeof DEFAULT_PATHS>,
 * }} ctx
 */
export function setupModularRoadVehicleAudio(audioSystem, ctx) {
  if (!audioSystem) return () => {};

  const {
    vehicle,
    settings: settingsRef,
    getKeys = () => ({}),
    pathOverrides = {},
  } = ctx;
  const paths = { ...DEFAULT_PATHS, ...pathOverrides };
  const registered = [];

  function settings() {
    const s = settingsRef || DEFAULT_VEHICLE_AUDIO_SETTINGS;
    return {
      enabled: s.enabled !== false,
      engineMul: s.engineMul ?? 1,
      engineRefTopSpeed: s.engineRefTopSpeed ?? 0,
      engineVol: s.engineVol ?? 1,
      enginePitchMin: s.enginePitchMin ?? 1,
      enginePitchMax: s.enginePitchMax ?? 2.85,
      enginePitchBoostMax: s.enginePitchBoostMax ?? 3.55,
      enginePitchIdleSpeedMax: s.enginePitchIdleSpeedMax ?? 0.35,
      enginePitchCurvePow: s.enginePitchCurvePow ?? 1,
      enginePitchEase: s.enginePitchEase ?? 10,
      engineFadeEaseUp: s.engineFadeEaseUp ?? 18,
      windMul: s.windMul ?? 0,
      nitroMul: s.nitroMul ?? 0.3,
      wheelsMul: s.wheelsMul ?? 0,
      driftBrakeMul: s.driftBrakeMul ?? 0.45,
      engineLoopStartMs: s.engineLoopStartMs ?? 0,
      engineLoopDurationMs: s.engineLoopDurationMs ?? 0,
      windLoopStartMs: s.windLoopStartMs ?? 0,
      windLoopDurationMs: s.windLoopDurationMs ?? 0,
      wheelsLoopStartMs: s.wheelsLoopStartMs ?? 0,
      wheelsLoopDurationMs: s.wheelsLoopDurationMs ?? 0,
      driftBrakeLoopStartMs: s.driftBrakeLoopStartMs ?? 0,
      driftBrakeLoopDurationMs: s.driftBrakeLoopDurationMs ?? 0,
    };
  }

  function driveContextOk() {
    return settings().enabled && vehicle.enabled;
  }

  function whenDriving(fn) {
    return (item, dt) => {
      if (!driveContextOk()) {
        item.volume += (0 - item.volume) * Math.min(1, dt * 6);
        return;
      }
      fn(item, dt);
    };
  }

  function normalTopSpeed(st) {
    const manual = Number(st.engineRefTopSpeed);
    return manual > 0 ? manual : TIRE.topSpeed;
  }

  const st0 = settings();
  const engLoop = howlerLoopLayerOptions(st0, "engine");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.engine,
      loop: engLoop.loop,
      ...(engLoop.sprite
        ? { sprite: engLoop.sprite, spritePlayId: engLoop.spritePlayId }
        : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenDriving((item, dt) => {
        const st = settings();
        const curSpeed = travelSpeed(vehicle.body);
        const targetVol = Math.min(3, st.engineVol * st.engineMul);
        smoothVolume(item, targetVol, dt, st.engineFadeEaseUp, 2.5);
        const rateTarget = enginePitchFromSpeed(
          st,
          curSpeed,
          normalTopSpeed(st),
        );
        item.rate = smoothScalar(item.rate, rateTarget, dt, st.enginePitchEase);
      }),
    }),
  );

  const windLoop = howlerLoopLayerOptions(st0, "wind");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.wind,
      loop: windLoop.loop,
      ...(windLoop.sprite
        ? { sprite: windLoop.sprite, spritePlayId: windLoop.spritePlayId }
        : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenDriving((item, dt) => {
        const curSpeed = travelSpeed(vehicle.body);
        const speedEffect = THREE.MathUtils.clamp(curSpeed * 0.1, 0, 1);
        const inAir = vehicle.groundedCount === 0;
        const air = inAir ? 0.35 : 1;
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

  const nitroItem = audioSystem.register({
    bus: "vehicle",
    src: paths.nitro,
    loop: false,
    autoplay: false,
    volume: 0,
    rate: 1,
    pool: 4,
    onPlaying: whenDriving((item) => {
      const keys = getKeys();
      const forward = keys.KeyW || keys.ArrowUp;
      const backward = keys.KeyS || keys.ArrowDown;
      const keyN = !!keys.KeyN;
      const curSpeed = travelSpeed(vehicle.body);
      const active = keyN && forward && !backward && curSpeed > 1;
      const rising = active && item._nitroPrevActive !== true;
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

  const driftLoop = howlerLoopLayerOptions(st0, "driftBrake");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.driftBrake,
      loop: driftLoop.loop,
      ...(driftLoop.sprite
        ? { sprite: driftLoop.sprite, spritePlayId: driftLoop.spritePlayId }
        : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenDriving((item) => {
        const keys = getKeys();
        const handbrake = !!keys.Space || !!vehicle.input?.handbrake;
        const curSpeed = travelSpeed(vehicle.body);
        const drifting = isDrifting(vehicle);
        const speedGate = THREE.MathUtils.smoothstep(curSpeed, 2, 16);
        if (!handbrake && !drifting) {
          item.volume = 0;
          item.rate = 1;
          return;
        }
        const st = settings();
        const drive = drifting ? 0.78 + speedGate * 0.24 : speedGate * 0.85;
        item.volume = Math.min(1.05, drive * st.driftBrakeMul);
        item.rate = THREE.MathUtils.lerp(
          0.94,
          1.14,
          THREE.MathUtils.smoothstep(curSpeed, 4, 26),
        );
      }),
    }),
  );

  const wheelsLoop = howlerLoopLayerOptions(st0, "wheels");
  registered.push(
    audioSystem.register({
      bus: "vehicle",
      src: paths.wheels,
      loop: wheelsLoop.loop,
      ...(wheelsLoop.sprite
        ? { sprite: wheelsLoop.sprite, spritePlayId: wheelsLoop.spritePlayId }
        : {}),
      autoplay: true,
      volume: 0,
      onPlaying: whenDriving((item, dt) => {
        const curSpeed = travelSpeed(vehicle.body);
        const grounded = vehicle.groundedCount > 0 ? 1 : 0;
        const targetVol =
          THREE.MathUtils.clamp(curSpeed * 0.1, 0, 1) *
          grounded *
          settings().wheelsMul;
        smoothVolume(item, targetVol, dt);
      }),
    }),
  );

  return () => {
    for (const r of registered) audioSystem.unregister(r);
    registered.length = 0;
  };
}
