// SOUND for nam-rts — the mixer is shared now (games/shared-rts/rtsAudio.js,
// moved 2026-09-30, unchanged); this keeps nam's manifest, its storage key and
// its default (sound OFF: your call, 2026-09-25).
import { createRtsAudio } from "../shared-rts/rtsAudio.js";

export function createNamAudio({ app, getView, manifestUrl = "/sounds/nam/manifest.json" }) {
  return createRtsAudio({ app, getView, manifestUrl, storeKey: "namrts.audio.v2", startMuted: true });
}
