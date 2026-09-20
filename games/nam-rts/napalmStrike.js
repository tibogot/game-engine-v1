/**
 * NAPALM — a weapon assembled out of systems that already exist.
 *
 * Almost nothing here is new. The flames are fireSystem's emissive blobs, the
 * pall is smokeField's `napalm` columns, the scorch is craterSystem's draped
 * decals, and the killing is combat.onImpact so a unit that burns to death
 * leaves the same wreck, fire and crater as one that is shot. What this file
 * adds is the SHAPE of the thing: a run that lands along a line, spreads over
 * a few seconds, burns for a while and then goes out.
 *
 * ── A RUN, NOT A BLAST ──────────────────────────────────────────────────────
 *
 * Napalm is delivered by an aircraft flying a line, so it arrives as a series
 * of splashes along a heading rather than a circle centred on a point. That is
 * also what makes it tactically different from artillery: it denies a CORRIDOR.
 * A player should be able to cut a valley in half with one, which is why the
 * default run is 70 m long and 22 m wide — roughly the width of the gentle
 * ground between two slopes on nam-valley.
 *
 * ── IT BLOCKS SIGHT FOR FREE ────────────────────────────────────────────────
 *
 * The pall is ordinary smokeField columns, so it already breaks firing lines
 * through the same Beer-Lambert test everything else uses. Nothing here knows
 * about line of sight; it just asks for smoke in the right places. That is the
 * payoff of having made smoke a sim object rather than an effect.
 *
 * ── THE BURN OUTLIVES THE FIRE ──────────────────────────────────────────────
 *
 * Every splash leaves a `burn` record that stays long after the flames are
 * out, and `burnedAt(x, z)` reads them. Nothing consumes it yet. It is here
 * because the interesting half of napalm in an RTS is the AFTERMATH — ground
 * that no longer hides anyone — and that wants vegetation density, the splat
 * layer and the cover system to read one number rather than three systems each
 * inventing their own idea of "burned".
 */

/**
 * Pool arithmetic, and it is the tightest constraint in this file.
 *
 * fireSystem owns 160 blobs and claims min(26, radius*7) per fire, so a run's
 * whole flame budget is splashes * firesPerSplash * (fireRadius*7). At 4 x 2 x
 * 18 that is 144, which leaves a thin 16 for wreck fires while a strike burns.
 * That is deliberate: a napalm run SHOULD dominate the screen it lands on.
 *
 * The other half of the same sum is why fireRadius is small. Blob size is
 * fire.radius * 0.35..0.8 and rise speed is radius * 0.5..1.1, so asking for
 * one fire at the splash's full 11 m radius does not make a wide fire — it
 * makes a 9 m flame climbing at 12 m/s, which through the emissive MRT and
 * bloom whites out the entire frame. Napalm is burning GROUND: many small
 * flames spread across the splash, not one bonfire in the middle of it.
 */
const MAX_SPLASHES_PER_RUN = 5;

export const NAPALM = {
  /** The run. */
  length: 70,          // metres along the heading
  width: 22,           // metres across — sets each splash's radius
  spreadTime: 2.2,     // seconds for the run to land end to end
  /** Each splash. */
  burnTime: 14,        // seconds of open flame
  firesPerSplash: 2,   // see the pool note above
  fireRadius: 2.6,     // metres — flame SCALE, not the splash's reach
  /** What it does to whoever is in it. */
  damagePerSecond: 55,
  damagePulse: 0.5,    // seconds between damage applications, see below
  /** How long the ground stays marked after the flames are out, seconds. */
  scarTime: 240,
};

/**
 * @param {object} o
 *   app, fire, smoke, craters, combat, units, structures
 */
export function createNapalmStrike({
  app, fire, smoke, craters, combat, units, structures, params = NAPALM,
}) {
  const runs = [];
  /** Burn scars, oldest first. Read by burnedAt(); nothing else yet. */
  const burns = [];

  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;

  /**
   * Call it in. `dirX/dirZ` is the aircraft's heading; it is normalised here,
   * and a zero heading defaults to due north so a misfired call still does
   * something visible rather than stacking every splash on one point.
   */
  function strike({ x, z, dirX = 0, dirZ = 1, length = params.length, width = params.width } = {}) {
    const m = Math.hypot(dirX, dirZ) || 1;
    const run = {
      x, z, dx: dirX / m, dz: dirZ / m, length, width,
      t: 0, landed: 0,
      count: Math.min(MAX_SPLASHES_PER_RUN, Math.max(2, Math.round(length / (width * 0.85)))),
      splashes: [],
    };
    runs.push(run);
    return run;
  }

  /** Drop one splash of a run, with everything that goes with it. */
  function land(run, i) {
    // Splashes are spaced from the START of the run, so the first lands where
    // the player pointed and the rest walk away along the heading.
    const f = run.count > 1 ? i / (run.count - 1) : 0;
    const d = f * run.length;
    const x = run.x + run.dx * d;
    const z = run.z + run.dz * d;
    const y = groundY(x, z);
    const r = run.width * 0.5;

    // Flames scattered across the splash rather than stacked at its centre:
    // the disc is 11 m across and a 2.6 m flame in the middle of it would read
    // as a campfire, not as a strip of burning ground.
    for (let k = 0; k < params.firesPerSplash; k++) {
      const a = (k / params.firesPerSplash) * Math.PI * 2 + i;
      const rr = r * 0.45;
      const fx = x + Math.cos(a) * rr, fz = z + Math.sin(a) * rr;
      fire.addFire(fx, groundY(fx, fz) + 0.4, fz, params.fireRadius, params.burnTime);
    }
    // A column per splash. Every OTHER splash was tried first, on the theory
    // that two 26 m palls would cover a 70 m run; measured against the shot,
    // two columns read as haze over the middle and left both ends of the
    // corridor clear, which is the opposite of what a napalm run should mean.
    // Four columns cost about 1.7 ms of the frame's GPU, which is affordable
    // where the strike is the whole point of the moment.
    smoke.spawn({ x, z, y: y + 1, kind: "napalm" });

    const splash = { x, z, y, r, age: 0, life: params.burnTime, pulse: 0 };
    run.splashes.push(splash);
    burns.push({ x, z, r, age: 0, life: params.scarTime, scorched: false });
    return splash;
  }

  /** FIXED-STEP. Everything here decides an outcome. */
  function step(dt) {
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i];
      run.t += dt;
      // Land whatever is due this step. A loop, not an if: a long hitch must
      // not swallow splashes, or a strike would silently come up short.
      while (run.landed < run.count
             && run.t >= (run.landed / Math.max(1, run.count - 1)) * params.spreadTime) {
        land(run, run.landed++);
      }

      for (let j = run.splashes.length - 1; j >= 0; j--) {
        const s = run.splashes[j];
        s.age += dt;
        if (s.age >= s.life) { run.splashes.splice(j, 1); continue; }

        // Damage in PULSES rather than every step. Not an optimisation — a
        // per-step application would call combat.onImpact 60 times a second
        // per burning unit, and onImpact is what spawns the impact effect and
        // handles death. Half-second pulses give the same damage over time,
        // one readable flare per pulse, and one death rather than a race
        // between sixty of them.
        s.pulse -= dt;
        if (s.pulse > 0) continue;
        s.pulse = params.damagePulse;
        const dmg = params.damagePerSecond * params.damagePulse;
        const r2 = s.r * s.r;
        for (const e of [...(units?.list ?? []), ...(structures?.list ?? [])]) {
          if (!e.alive) continue;
          // Aircraft fly over it. Napalm is a ground weapon and pretending
          // otherwise would make it the answer to everything.
          if (e.isAir) continue;
          const d2 = (e.position.x - s.x) ** 2 + (e.position.z - s.z) ** 2;
          if (d2 > r2) continue;
          combat.onImpact(e, dmg, { x: e.position.x, y: e.position.y + 1, z: e.position.z }, null);
        }
      }

      if (run.landed >= run.count && !run.splashes.length) runs.splice(i, 1);
    }

    for (let i = burns.length - 1; i >= 0; i--) {
      const b = burns[i];
      b.age += dt;
      // The scorch is stamped when the FLAMES die, not when they start — a
      // decal under an open fire is invisible, and stamping it late means the
      // ground is revealed as the fire clears, which is the read you want.
      if (!b.scorched && b.age >= params.burnTime) {
        b.scorched = true;
        craters?.addCrater?.(b.x, b.z, b.r * 0.9);
      }
      if (b.age >= b.life) burns.splice(i, 1);
    }
  }

  /**
   * How burned the ground at (x, z) is, 0..1, fading over `scarTime`.
   *
   * THE HOOK FOR THE AFTERMATH. Nothing reads it yet. When something does —
   * grass and foliage density, the splat layer, whatever cover system arrives
   * — it should read THIS rather than keeping its own list, so that "burned"
   * means one thing across the game and a scar that fades fades everywhere at
   * once.
   */
  function burnedAt(x, z) {
    let worst = 0;
    for (const b of burns) {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d >= b.r) continue;
      // Full strength in the middle, feathered at the rim, fading with age.
      const core = 1 - (d / b.r) ** 2;
      const fresh = 1 - Math.max(0, (b.age - b.life * 0.5) / (b.life * 0.5));
      worst = Math.max(worst, core * Math.max(0, Math.min(1, fresh)));
      if (worst >= 1) return 1;
    }
    return worst;
  }

  return {
    strike, step, burnedAt,
    runs, burns,
    activeCount: () => runs.length,
    clear() { runs.length = 0; burns.length = 0; },
  };
}
