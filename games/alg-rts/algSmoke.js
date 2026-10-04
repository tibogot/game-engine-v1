// SMOKE SCREENS (you, 2026-10-04: "veterancy + smoke + the LMG upgrade + the mortar barrage").
// A man throws a smoke grenade (FUMIGÈNE on the command card, B — algGrenades.js, the same throw
// as the frag); where it lands a grey cloud blooms for ~22 s and NOBODY SEES THROUGH IT: combat
// (shared combat.js `smoke`) won't pick or keep a target across it. CoH's use: cross open
// ground, break an MG's line, cover a retreat.
//
// TWO HALVES (as nam's smokeField): the SIM owns a few analytic columns (shared smokeColumns.js:
// Beer-Lambert through a Gaussian column — the same answer on every machine); the LOOK is the
// battle's own lit smoke (combatFx's lit puffs, sun-lit like every other cloud here), fed a puff
// every few tenths of a second while a column lives. No draw of its own.
import { smokeOcclusion, stepSmokeColumns } from "../shared-rts/smokeColumns.js";

export const SMOKE = {
  max: 8,            // columns at once (the oldest is reused)
  radius: 7,         // m at the burst …
  growth: 4,         // … + this at full bloom (11 m)
  bloom: 3,          // s to full size
  life: 22,          // s
  losOpacity: 0.88,  // straight through the middle of a full cloud
  emit: 0.28,        // s between two puffs of the look
  tint: [0.5, 0.5, 0.48],   // 0.58 read chalk-white in the sun
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} [o.lit]   combatFx's lit smoke (puff); none = sight only, nothing drawn
 */
export function createAlgSmoke({ app, lit = null }) {
  const P = SMOKE;
  const sources = [];

  /** A screening cloud blooming at (x, z). */
  function burst(x, z) {
    let s = sources.find((q) => !q.alive);
    if (!s) {
      if (sources.length < P.max) { s = {}; sources.push(s); }
      else s = sources.reduce((a, b) => (a.age > b.age ? a : b));   // the oldest
    }
    Object.assign(s, {
      alive: true, x, z, y: app.getWorldHeight?.(x, z) ?? 0, age: 0, life: P.life, strength: 1,
      radius: P.radius, growth: P.growth, bloom: P.bloom, losOpacity: P.losOpacity, emitT: 0,
    });
    // The pop: a burst of puffs at the canister.
    if (lit) for (let k = 0; k < 6; k++) lit.puff(x + (Math.random() - 0.5) * 2, s.y + 0.6, z + (Math.random() - 0.5) * 2, { size: 3 + Math.random() * 2, duration: 3.5, tint: P.tint, opacity: 0.8, grow: 1.2, vel: [0, 0.9, 0] });
    app.algSounds?.audio?.play?.("impact", x, s.y, z, { gain: 0.2, rate: 1.6 });
  }

  /** Fixed clock: the columns age, and the look is fed while they live. */
  function step(dt) {
    stepSmokeColumns(sources, dt);
    if (!lit) return;
    const w = app.showroom?.wind;
    let wx = 0, wz = 0;
    if (w) { const t = performance.now() / 1000, d = w.dirRad(t), v = w.speed(t) * 0.6; wx = Math.cos(d) * v; wz = Math.sin(d) * v; }
    for (const s of sources) {
      if (!s.alive) continue;
      s.emitT -= dt;
      if (s.emitT > 0 || s.age > s.life - 5) continue;   // the last puffs outlive the column by their own life
      s.emitT = P.emit;
      const bloom = Math.min(1, s.age / P.bloom);
      const R = (P.radius + P.growth) * (0.35 + 0.65 * bloom);
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * R * 0.85;
      const x = s.x + Math.cos(a) * r, z = s.z + Math.sin(a) * r;
      const y = (app.getWorldHeight?.(x, z) ?? s.y) + 0.8 + Math.random() * 2.2;
      lit.puff(x, y, z, {
        size: 6 + Math.random() * 4 * (0.5 + bloom), duration: 5 + Math.random() * 2,
        tint: P.tint, opacity: 0.75, grow: 0.6, vel: [wx, 0.25 + Math.random() * 0.3, wz],
      });
    }
  }

  return {
    params: P, burst, step,
    /** combat.js: how much smoke stands between two points, 0..1. */
    occlusionBetween: (ax, az, bx, bz) => smokeOcclusion(sources, ax, az, bx, bz),
    get live() { return sources.filter((s) => s.alive).length; },
    clear() { for (const s of sources) s.alive = false; },
  };
}
