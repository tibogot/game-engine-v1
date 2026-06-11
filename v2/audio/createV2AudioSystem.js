/**
 * V2 runtime audio — Howler.js with Unity/Unreal-style buses (master + categories).
 * Inspired by folio-2025-main `Audio.js` / `Player.js`: register(), per-tick onPlaying, rate clamp.
 *
 * Bus chain: final = muteAll ? 0 : masterVol * !masterMute * busVol * !busMute * item.volume
 */
import { Howl, Howler } from "howler";

export { V2_AUDIO_BUS_IDS } from "./audioBuses.js";

const RATE_MIN = 0.5;
const RATE_MAX = 4;

/**
 * @param {object} opts
 * @param {{ audio: object }} opts.toolState — must own `audio` (see createToolState)
 * @param {() => number} [opts.getTimeScale] — global playback rate multiplier (bullet time, etc.)
 */
export function createV2AudioSystem({ toolState, getTimeScale = () => 1 }) {
  const audioState = toolState.audio;
  /** @type {import("howler").Howl[]} */
  const howls = [];
  /** @type {V2RegisteredSound[]} */
  const items = [];

  let disposed = false;
  let hiddenSuspended = false;
  /** After a user gesture; Howl must not use `autoplay` — Chrome blocks context start. */
  let audioUnlocked = false;

  function getBus(busId) {
    return audioState.buses[busId] ?? audioState.buses.sfx;
  }

  /**
   * Linear 0..1 attenuation from mixer (master × category).
   * @param {V2AudioBusId} busId
   */
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

  /**
   * @param {object} options
   * @param {string | string[]} options.src
   * @param {V2AudioBusId} [options.bus] — default "sfx"
   * @param {boolean} [options.loop] — full-buffer loop (ignored if `sprite` + `spritePlayId` set)
   * @param {Record<string, [number, number] | [number, number, boolean]>} [options.sprite] — Howler sprite map; use `[startMs, durationMs, true]` for a looping segment
   * @param {string} [options.spritePlayId] — sprite key passed to `howl.play(id)` (defaults to first sprite key)
   * @param {boolean} [options.autoplay] — start loop after gesture + decode (not Howler autoplay)
   * @param {number} [options.volume] — design default for item.volume
   * @param {number} [options.rate] — logical rate (scaled by getTimeScale in update)
   * @param {number} [options.pool]
   * @param {boolean} [options.preload]
   * @param {(item: V2RegisteredSound, dtSec: number) => void} [options.onPlaying]
   * @param {() => void} [options.onLoadError]
   */
  function tryStartPlayback(item) {
    if (disposed || !audioUnlocked || !item._startWhenUnlocked || item._playbackStarted) return;
    const h = item.howl;
    if (h.state() !== "loaded") return;
    try {
      const id =
        item._spritePlayId != null ? h.play(item._spritePlayId) : h.play();
      if (id != null) item._playbackStarted = true;
    } catch (_) {
      /* autoplay policy — retry next frame after unlock */
    }
  }

  function register(options) {
    const bus = /** @type {V2AudioBusId} */ (options.bus ?? "sfx");
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
        onloaderror: options.onLoadError ?? ((_id, err) => console.warn("[V2 Audio] load error", options.src, err)),
      }),
    };
    howls.push(item.howl);
    items.push(item);
    if (audioUnlocked) tryStartPlayback(item);
    return item;
  }

  /**
   * Stop, unload, and remove one registered sound (e.g. when leaving play mode).
   * @param {V2RegisteredSound} item
   */
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

  /**
   * Resume AudioContext after a user gesture (browser autoplay policy).
   */
  async function unlock() {
    try {
      if (Howler.ctx?.state === "suspended") await Howler.ctx.resume();
    } catch (_) {
      /* ignore */
    }
    audioUnlocked = true;
    for (const item of items) {
      tryStartPlayback(item);
    }
  }

  /**
   * @param {number} dtSec
   */
  function update(dtSec) {
    if (disposed) return;
    if (audioUnlocked) {
      for (const item of items) tryStartPlayback(item);
    }
    const ts = getTimeScale();
    const gRate = Math.max(RATE_MIN, Math.min(RATE_MAX, ts));

    for (const item of items) {
      if (typeof item.onPlaying === "function") {
        item.onPlaying(item, dtSec);
      }
      const busScalar = getEffectiveBusScalar(item.bus);
      const vol = Math.max(0, Math.min(1, item.volume * busScalar));
      item.howl.volume(vol);
      item.howl.mute(vol < 1e-4);
      const r = Math.max(RATE_MIN, Math.min(RATE_MAX, item.rate * gRate));
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
    /** Howler global (mute all output, context unlock, etc.) */
    Howler,
  };
}

/**
 * @typedef {object} V2RegisteredSound
 * @property {V2AudioBusId} bus
 * @property {number} volume
 * @property {number} rate
 * @property {(item: V2RegisteredSound, dtSec: number) => void} [onPlaying]
 * @property {import("howler").Howl} howl
 * @property {boolean} [_startWhenUnlocked]
 * @property {boolean} [_playbackStarted]
 * @property {string | null} [_spritePlayId]
 */
