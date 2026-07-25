// ============================================================================
// GAMEPAD → drive controls.
//
// The game was keyboard-only, which caps how smooth the steering can ever be:
// a key is a switch, so the car's steering feel is entirely the ramp the
// Vehicle applies between 0 and full lock. A stick supplies the intermediate
// positions directly, which is why the Vehicle takes an `analog` flag and
// bypasses that ramp when it's set (see _smoothSteer in modularRoadVehicle.js).
//
// Nothing here holds state about which pad is "the" pad — navigator.getGamepads()
// is re-polled every frame and the first connected pad wins. Unplugging mid-race
// just falls back to the keyboard on the next frame.
// ============================================================================

/** Live-tunable pad shaping. Mutate and the next poll picks it up. */
export const PAD = {
  enabled: true,
  /** Pad slot to read, or -1 for "first connected". */
  index: -1,
  /** Stick travel ignored around centre — sticks rarely rest at exactly 0. */
  steerDeadzone: 0.12,
  /** Response curve on the stick. >1 spreads the fine control around centre,
   *  which is where precision actually matters; 1 is linear. */
  steerGamma: 1.5,
  /** Triggers rest at 0 but drift, so they get a (much smaller) deadzone too. */
  triggerDeadzone: 0.06,
  /** Flip the air-pitch stick axis if you prefer push-forward = nose up. */
  invertPitch: false,
};

/**
 * Deadzone + curve. Rescales so output starts at 0 the instant the stick leaves
 * the deadzone — without the rescale the control jumps to `deadzone` worth of
 * steering the moment it engages.
 */
function shape(v, deadzone, gamma) {
  const a = Math.abs(v);
  if (a <= deadzone) return 0;
  const t = (a - deadzone) / (1 - deadzone);
  return Math.sign(v) * (gamma === 1 ? t : Math.pow(t, gamma));
}

/**
 * @returns {{ read: () => object|null, isConnected: () => boolean, padName: () => string }}
 */
export function createGamepadInput() {
  let lastRespawn = false;
  let connected = false;
  let name = "";

  function pick() {
    const pads = navigator.getGamepads?.() ?? [];
    if (PAD.index >= 0) return pads[PAD.index] ?? null;
    // Prefer a pad reporting the standard mapping — the button indices below are
    // only meaningful for that layout.
    for (const p of pads) if (p?.connected && p.mapping === "standard") return p;
    for (const p of pads) if (p?.connected) return p;
    return null;
  }

  /**
   * Poll the pad. Returns null when there isn't one, so the caller can fall
   * straight through to the keyboard.
   *
   * MUST be called at most once per frame — the respawn button is edge-detected
   * against the previous call, so polling twice would swallow the press.
   */
  function read() {
    const p = PAD.enabled ? pick() : null;
    connected = !!p;
    name = p?.id ?? "";
    if (!p) {
      lastRespawn = false;
      return null;
    }
    const ax = p.axes ?? [];
    const bt = p.buttons ?? [];
    const down = (i) => (bt[i]?.pressed ? 1 : 0);
    const analogVal = (i) => bt[i]?.value ?? 0;

    // Standard mapping: axis 0 is left stick X, LEFT is negative. This game's
    // steerTarget is +1 for LEFT (see readControls in roadGame.js), so negate.
    let steerTarget = -shape(ax[0] ?? 0, PAD.steerDeadzone, PAD.steerGamma);
    let analog = true;
    if (steerTarget === 0) {
      // D-pad is a switch, so it must NOT claim to be analog — it wants the
      // keyboard's ramp, not the stick's near-instant filter.
      const dpad = down(14) - down(15); // 14 = left, 15 = right
      if (dpad !== 0) {
        steerTarget = dpad;
        analog = false;
      }
    }

    // RT accelerates, LT brakes/reverses. Both are analog on a standard pad.
    let throttle = shape(analogVal(7), PAD.triggerDeadzone, 1)
      - shape(analogVal(6), PAD.triggerDeadzone, 1);
    if (throttle === 0) throttle = down(12) - down(13); // d-pad up/down fallback

    // AIR PITCH on the left stick's Y axis. The keyboard needs dedicated keys
    // for this (the gas is held constantly, so sharing it forces flips) — but a
    // pad never had that problem: throttle lives on the TRIGGERS, so the stick
    // is free. Pull back = nose up, matching flight and Rocket League.
    const pitch = shape(ax[1] ?? 0, PAD.steerDeadzone, PAD.steerGamma) * (PAD.invertPitch ? -1 : 1);

    const respawn = down(3) === 1; // Y
    const respawnPressed = respawn && !lastRespawn;
    lastRespawn = respawn;

    return {
      steerTarget,
      throttle,
      handbrake: down(0) === 1 || down(1) === 1, // A or B
      yaw: down(5) - down(4), // RB / LB — matches E / Q air spin
      pitch,                  // left stick Y — air pitch (see above)
      analog,
      respawnPressed,
    };
  }

  return {
    read,
    isConnected: () => connected,
    padName: () => name,
  };
}
