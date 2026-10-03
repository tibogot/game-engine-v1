// alg-rts — COMBAT LIGHTS AT NIGHT: muzzle flashes, gun blasts, grenades, explosions, burning
// wrecks and houses light the ground and the walls round them (2026-10-04).
//
// The engine's local lights (v3/render/lighting/localLights.js, app.localLights: tiled point
// lights, pooled, no shadows, ranked by importance). This file only decides WHEN and HOW
// BRIGHT: it wraps the combat FX calls (the sprites, flipbooks and sounds stay as they were)
// and follows the flame field's list of what is burning.
//
// Scaled by the sky's night amount (app.sky.night): by day nothing is added at all — the
// flashes and fireballs already read in the sun, and a light under them would cost for nothing.
//
// Units are Sky Pro's (night ground ~0.002-0.003 linear, exposure ~2.2): a point light of
// I candela lights level ground at d metres with E = I / d^2. A rifle flash (20 cd) brightens
// the man's feet; a shell (900 cd) lights a house front 15 m away.

const LOOKS = {
  //            colour      peak cd   range m  life s   lift m  importance
  muzzle:   { color: 0xffc070, peak: 20,   range: 6,  life: 0.06, lift: 0,   importance: 0.4 },
  cannon:   { color: 0xffb060, peak: 260,  range: 16, life: 0.14, lift: 0,   importance: 1.5 },
  grenade:  { color: 0xffa050, peak: 220,  range: 12, life: 0.25, lift: 1.0, importance: 1.2 },
  shellHit: { color: 0xff9a40, peak: 420,  range: 16, life: 0.35, lift: 1.2, importance: 1.5 },
  // a blast's peak and range grow with its size (10 = a vehicle)
  blast:    { color: 0xff8a30, peak: 90,   range: 2.2, life: 0.08, lift: 0.15, importance: 2 },
};

/**
 * @param {object} o
 * @param {object} o.app   the engine app (app.localLights, app.sky.night)
 * @param {object} o.fx    combatFx (wrapped: muzzle, cannon, grenade, shellHit, explosion)
 * @param {object} [o.fire] the flame field (its `fires` list is followed)
 */
export function createAlgLights({ app, fx, fire = null }) {
  const L = app.localLights;
  if (!L) return null;
  const params = { enabled: true, gain: 1 };
  const night = () => (params.enabled ? (app.sky?.night ?? 0) * params.gain : 0);

  /** Short lights that flare and die: { h, t, life, peak } */
  const flashes = [];
  function flash(kind, x, y, z, { scale = 1 } = {}) {
    const n = night();
    if (n < 0.02) return;
    const k = LOOKS[kind];
    const peak = k.peak * scale * scale * n;
    const range = kind === "blast" ? k.range * 10 * scale : k.range;
    const life = kind === "blast" ? 0.35 + 0.05 * 10 * scale : k.life;
    const h = L.add({ position: { x, y: y + k.lift * (kind === "blast" ? 10 * scale : 1), z }, color: k.color, intensity: peak, range, importance: k.importance });
    flashes.push({ h, t: 0, life, peak });
  }

  // ---- wrap the FX (each original runs first, untouched)
  const wrap = (name, fn) => {
    const orig = fx[name];
    if (typeof orig !== "function") return;
    // a light that fails must never cost the shot its flash: warn once, carry on
    let warned = false;
    fx[name] = (...a) => {
      const r = orig(...a);
      try { fn(...a); } catch (e) { if (!warned) { warned = true; console.warn(`[alg lights] ${name}:`, e); } }
      return r;
    };
  };
  wrap("muzzle", (x, y, z) => flash("muzzle", x, y, z));
  wrap("cannon", (x, y, z) => flash("cannon", x, y, z));
  wrap("grenade", (x, y, z) => flash("grenade", x, y, z));
  wrap("shellHit", (x, y, z) => flash("shellHit", x, y, z));
  wrap("explosion", (x, y, z, o) => { if (!o?.dust) flash("blast", x, y, z, { scale: (o?.size ?? 10) / 10 }); });

  // ---- fires: one flickering light per blaze, as long as it burns
  const fireLights = new Map(); // fire -> handle
  function syncFires(n) {
    const list = fire?.fires;
    if (!list) return;
    const now = fire.now;
    const live = new Set(list);
    for (const [f, h] of fireLights) if (!live.has(f)) { h.remove(); fireLights.delete(f); }
    for (const f of list) {
      // dying down over its last 3 s
      const left = Math.max(0, Math.min(1, (f.end - now) / 3));
      const I = 30 * f.radius * left * n;
      let h = fireLights.get(f);
      if (!h) {
        if (n < 0.02) continue;
        h = L.add({ position: { x: f.x, y: f.y + 0.6 + f.radius * 0.3, z: f.z }, color: 0xff7a2a, intensity: I, range: 6 + f.radius * 3, flicker: 0.45, importance: 1.3 });
        fireLights.set(f, h);
      } else h.set({ intensity: I });
    }
  }

  let n = 0;
  function update(dt) {
    n = night();
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      const k = 1 - f.t / f.life;
      if (k <= 0) { f.h.remove(); flashes.splice(i, 1); continue; }
      f.h.set({ intensity: f.peak * k * k });
    }
    syncFires(n);
  }
  // on the game's clock (app.timeScale, algUnits.js): slowed with the fireballs, frozen on pause
  app.addPreRenderHook(function algCombatLights(dt) { update(dt * (app.timeScale ?? 1)); });

  return {
    params, LOOKS,
    get count() { return flashes.length + fireLights.size; },
  };
}
