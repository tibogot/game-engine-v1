// ============================================================================
// SLOW MOTION — hold to slow the world, eased in and out.
//
// The game already had the hook: `timeScale`, with the contract that FIXED_DT
// never changes and only how much sim time a frame buys does. What was missing
// was a key, an ease, and the rest of the world. Scaling the car alone would be
// a car in slow motion driving through traffic, smoke, rain and clouds at full
// speed — so the rate feeds the same world clock the pause uses (`worldDt` in
// roadGame.js): 0 paused, `scale` held, 1 released, and everything that
// advances the world reads it.
//
// ── WHY AN EASE, AND WHY ASYMMETRIC ──────────────────────────────────────────
//
// A snap from 1 to 0.3 reads as a stutter, not a slow-down: a frame that
// suddenly buys a third of the motion looks exactly like a dropped frame. Easing
// in over ~0.12 s makes the world visibly decelerate into it. Coming out is
// slower (~0.22 s) because the moment it matters is usually the landing, and a
// world that slams back to full speed under it is where the stutter would be.
//
// The ease runs on REAL time, not world time — an ease measured in slowed
// seconds would take three times longer to come out than it took to go in.
// ============================================================================

export const SLOWMO_DEFAULTS = {
  /** World rate while fully slowed. 0.3 = three times slower. */
  scale: 0.3,
  /** Exponential time constants in real seconds: going in, coming out. */
  easeIn: 0.12,
  easeOut: 0.22,
};

/**
 * The pure core: an eased amount and the rate it implies. No DOM, no clock —
 * the caller hands it real dt and whether the button is held.
 */
export function createSlowMo(params = {}) {
  const P = { ...SLOWMO_DEFAULTS, ...params };
  let amount = 0;   // 0 = realtime, 1 = fully slowed
  const smooth = (t) => t * t * (3 - 2 * t);
  const rateOf = (a) => 1 + (P.scale - 1) * smooth(a);
  return {
    params: P,
    get amount() { return amount; },
    get rate() { return rateOf(amount); },
    /**
     * @param {number} realDt   unscaled frame seconds
     * @param {boolean} held
     * @returns {number} the world rate multiplier, in [scale, 1]
     */
    update(realDt, held) {
      const target = held ? 1 : 0;
      const tau = held ? P.easeIn : P.easeOut;
      if (realDt > 0) {
        amount += (target - amount) * (1 - Math.exp(-realDt / Math.max(1e-4, tau)));
        if (Math.abs(target - amount) < 1e-3) amount = target;
      }
      return rateOf(amount);
    },
    reset() { amount = 0; },
  };
}

const STYLE_ID = "road-slowmo-style";
const CSS = `
#road-slowmo {
  /* 100px: under the race clock, which is centred at the top and runs to ~75px. */
  position: fixed; left: 50%; top: 100px; transform: translateX(-50%);
  z-index: 9000; pointer-events: none;
  padding: 4px 14px;
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 15px; font-weight: 800; font-style: italic; letter-spacing: 0.24em;
  color: #dce622;
  background: rgba(12, 14, 20, 0.62);
  border-bottom: 2px solid #dce622;
  opacity: 0;
}
`;

/**
 * The badge. Its opacity IS the eased amount, so it fades exactly as the world
 * slows and never says "slow-mo" over a world already back at full speed.
 */
export function createSlowMoBadge(parent = document.body) {
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const el = document.createElement("div");
  el.id = "road-slowmo";
  el.textContent = "SLOW-MO";
  el.setAttribute("aria-hidden", "true");
  parent.appendChild(el);
  let shown = -1;
  return {
    el,
    set(amount) {
      // Quantised so a settled badge costs no style writes at all.
      const a = Math.round(Math.max(0, Math.min(1, amount)) * 50) / 50;
      if (a === shown) return;
      shown = a;
      el.style.opacity = String(a);
    },
    dispose() { el.remove(); },
  };
}
