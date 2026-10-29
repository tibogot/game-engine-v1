// FIRE BAKE PRESETS — what Fire Pro simulates, and the box the lab bakes from it.
//
// `sim`      FireSimulation options (v3/vendor/fire-pro/src/library/options.ts)
// `fires`    continuous emitters: { kind: fire|smoke|emitter, at, radius, emission, velocity }
// `blasts`   explosions, triggered at t = 0: { at, radius, charge, outwardSpeed, variation }
// `forces`   wind / turbulence
// `bake`     center + size: the square the orthographic bake camera frames (m), seen
//            at `pitch` degrees down (the RTS camera: 30° near, 58° far); frames from
//            `start` s over `duration` s; `loop` books crossfade their last `blend`
//            frames into the first, so they cycle without a pop.
//
// Starting points from Fire Pro's own editor presets (fuel-fireball, campfire,
// industrial-smoke), scaled and darkened toward a battlefield.

export const PRESETS = {
  blast: {
    label: "Shell blast",
    note: "one-shot: fuel fireball → rolling soot (Fire Pro's Fireball preset)",
    sim: {
      // 0.05 as Fire Pro's preset: at 0.06 the solver FROZE (a still, glowing ball, no
      // error) — seen 2026-10-07. Change the voxel size only with an eye on the live view.
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 1,
      grid: { maxVoxels: 8_000_000, cutoff: 0.05, ground: true },
      flame: { lifespan: 5, heatRate: 0.78, smokeRate: 5, expansionRate: 6.23, cooling: 0.26, brightness: 15, opacity: 1, temperature: 2630, sootGlow: 5 },
      smoke: { dissipation: 0.97, color: "#303236", density: 4.5, scattering: 0.38, shadowDensity: 5.24 },
      motion: { buoyancy: 4.66, smokeWeight: 1.45, damping: 0.1, vorticity: 1.08 },
      fuel: { enabled: true, ignitionHeat: 0.4, burnRate: 6 },
    },
    fires: [],
    blasts: [{ at: [0, 1.2, 0], radius: 0.5, charge: { flame: 0, heat: 3.5, smoke: 0.1, fuel: 0.62 }, outwardSpeed: 7, variation: { period: 0.4, strength: 0.55 } }],
    forces: [{ type: "turbulence", strength: 7.61, scale: 9.01 }, { type: "turbulence", strength: 2, scale: 1 }],
    // 8 m centred at 3.6 cut the rising soot flat at the top (fill 0.995, 2026-10-07).
    bake: { center: [0, 5, 0], size: 10, pitch: 40, start: 0, duration: 4, loop: false, blend: 0 },
  },
  // THE ROCKET HITTING THE GROUND (you, 2026-10-09: "some peak of smoke, a realistic explosion"):
  // a flash and a dust dome, and the SPIKES — the earth thrown out fast, each streak a narrow jet
  // of heavy dust for a tenth of a second, fanned at steep angles; they arc and fall back. (Fire
  // Pro has no solid debris: the clods themselves fly as the game's particles on top.)
  rocket: {
    label: "Rocket impact",
    note: "one-shot: a flash, dust spikes thrown out in a fan, the dome, the soot rising",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 21,
      grid: { maxVoxels: 12_000_000, cutoff: 0.03, ground: true },
      flame: { lifespan: 0.4, heatRate: 1.5, smokeRate: 3, expansionRate: 3, cooling: 1.0, brightness: 8, opacity: 1, temperature: 2600, sootGlow: 1 },
      // Thins fast: at 0.3 the spikes had become a 12 M-voxel haze by 2.6 s (the cap).
      smoke: { dissipation: 0.6, color: "#8f7a5e", density: 5, scattering: 0.38, shadowDensity: 3.5 },
      motion: { buoyancy: 1.4, smokeWeight: 1.6, damping: 0.2, vorticity: 3 },
      fuel: { enabled: false },
    },
    // The spikes: each a CLOD flying a ballistic arc (lab `path`) and trailing dust for 0.55 s —
    // fixed nozzles at the centre made a 1.5 m puff (the sim's air stops a jet at once).
    // [elevation °, azimuth °, speed m/s]
    fires: [[72, 0, 19], [58, 40, 15], [80, 85, 20], [55, 130, 14], [66, 170, 18], [62, 215, 16], [75, 255, 19], [57, 295, 14], [70, 335, 17]].map(([el, az, sp]) => {
      const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180;
      return { kind: "emitter", at: [0, 0.4, 0], radius: 0.24, emission: { flame: 0, heatRate: 0.4, smokeRate: 60 }, velocity: null,
        path: { v: [Math.cos(e) * Math.cos(a) * sp, Math.sin(e) * sp, Math.cos(e) * Math.sin(a) * sp] }, until: 0.9 };
    }),
    blasts: [{ at: [0, 0.4, 0], radius: 1.0, charge: { flame: 0.8, heat: 2.5, smoke: 8, fuel: 0 }, outwardSpeed: 14, variation: { period: 0.5, strength: 0.6 } }],
    forces: [{ type: "turbulence", strength: 4, scale: 2.5 }, { type: "wind", direction: [1, 0, 0], strength: 0.3 }],
    bake: { center: [0, 6.5, 0], size: 15, pitch: 40, start: 0, duration: 3, loop: false, blend: 0 },
  },
  // THE MORTAR FIRING (2026-10-16, you, CoH 3 refs assets-src/refs/coh3/mortar_launch_*.png): the
  // first frames a bright burst of fire at the tube's mouth, then a column of light-grey smoke that
  // rises out of it and drifts several metres downwind (+X here; the game turns the card). The
  // mouth is ~0.9 m up (a 60/81 mm tube at its firing angle).
  mortarLaunch: {
    label: "Mortar launch",
    note: "one-shot: a bright burst at the tube's mouth, then a light-grey column rising and drifting downwind",
    sim: {
      voxelSize: 0.04, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 41,
      grid: { maxVoxels: 8_000_000, cutoff: 0.03, ground: true },
      // The fire is a blink (lifespan) but bright, its smoke glowing as it leaves the mouth.
      flame: { lifespan: 0.18, heatRate: 2, smokeRate: 4, expansionRate: 2.5, cooling: 1.4, brightness: 9, opacity: 1, temperature: 2700, sootGlow: 2 },
      // Propellant smoke: pale, thin, and it LINGERS (low dissipation) as a drifting column.
      smoke: { dissipation: 0.1, color: "#cbc6bd", density: 5, scattering: 0.45, shadowDensity: 2.2 },
      motion: { buoyancy: 2.6, smokeWeight: 0.15, damping: 0.1, vorticity: 1.8 },
      fuel: { enabled: false },
    },
    fires: [
      // The shot: fire and smoke blown up out of the tube for a tenth of a second…
      { kind: "emitter", at: [0, 0.9, 0], radius: 0.22, emission: { flame: 1, heatRate: 3, smokeRate: 100 }, velocity: { direction: [0.15, 1, 0], speed: 14 }, until: 0.15 },
      // …and the tube breathing smoke a moment after.
      { kind: "emitter", at: [0, 0.9, 0], radius: 0.16, emission: { flame: 0, heatRate: 0.8, smokeRate: 45 }, velocity: { direction: [0.15, 1, 0], speed: 9 }, until: 0.9 },
    ],
    blasts: [{ at: [0, 0.95, 0], radius: 0.45, charge: { flame: 1, heat: 2.5, smoke: 8, fuel: 0 }, outwardSpeed: 5, variation: { period: 0.4, strength: 0.5 } }],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 1.6 }, { type: "turbulence", strength: 1.1, scale: 2.5 }],
    bake: { center: [2.4, 4.8, 0], size: 10.5, pitch: 40, start: 0, duration: 4, loop: false, blend: 0 },
  },
  // A MORTAR BOMB LANDING (2026-10-16): HE in earth — not fuel. A bright core for a blink (the
  // first frame is fire, as the launch), then the EARTH: a narrow fountain of dark dirt spikes
  // thrown up steeply (a mortar's look, taller and tighter than the rocket's fan), the dust dome
  // at its foot, and it all slumps and drifts. Dark earth here; the game tints it to the ground.
  mortarImpact: {
    label: "Mortar in earth",
    note: "one-shot: a blink of fire, a tall tight fountain of dark earth spikes, the dome, slump and drift",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 43,
      grid: { maxVoxels: 12_000_000, cutoff: 0.03, ground: true },
      flame: { lifespan: 0.32, heatRate: 2.4, smokeRate: 3, expansionRate: 3, cooling: 0.9, brightness: 16, opacity: 1, temperature: 2800, sootGlow: 3 },
      smoke: { dissipation: 0.55, color: "#6e6152", density: 5.5, scattering: 0.36, shadowDensity: 3.5 },
      motion: { buoyancy: 1.3, smokeWeight: 1.7, damping: 0.2, vorticity: 4.5 },
      fuel: { enabled: false },
    },
    // The spikes: [elevation °, azimuth °, speed m/s, radius m] — steep (60-86°), clods on ballistic
    // arcs, uneven: thick slow ones and thin fast ones (all alike read as a broom, the lab).
    fires: [[78, 10, 16, 0.34], [64, 55, 11, 0.4], [84, 100, 18, 0.22], [62, 150, 10, 0.38], [73, 200, 14, 0.3], [68, 250, 12, 0.36], [86, 290, 19, 0.2], [61, 330, 9, 0.42]].map(([el, az, sp, rad]) => {
      const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180;
      return { kind: "emitter", at: [0, 0.35, 0], radius: rad, emission: { flame: 0, heatRate: 0.4, smokeRate: 60 }, velocity: null,
        path: { v: [Math.cos(e) * Math.cos(a) * sp, Math.sin(e) * sp, Math.cos(e) * Math.sin(a) * sp] }, until: 0.55 };
    }).concat(
      // THE GROUND SKIRT (you, 2026-10-16: "a large kind of flat impact at the ground level… not so
      // flat"): the shockwave throwing a low ring of dust out along the ground — 28 fat jets skimming
      // out (6-12° up), close enough to MERGE into one ring (14 thin ones drew a starburst of
      // spokes), heavy dust that billows a little as it slows.
      Array.from({ length: 28 }, (_, i) => {
        const a = (i / 28) * Math.PI * 2 + (i % 3) * 0.07, e = ((6 + (i * 37) % 7) * Math.PI) / 180, sp = 9 + (i * 53) % 4;
        return { kind: "emitter", at: [0, 0.3, 0], radius: 0.5, emission: { flame: 0, heatRate: 0.2, smokeRate: 40 }, velocity: null,
          // From 0.1 s: started with the blast, its dust smothered the fireball (emission 1.45 → 0.03).
          path: { v: [Math.cos(e) * Math.cos(a) * sp, Math.sin(e) * sp, Math.cos(e) * Math.sin(a) * sp] }, from: 0.1, until: 0.6 };
      })),
    blasts: [{ at: [0, 0.5, 0], radius: 1.0, charge: { flame: 1, heat: 4, smoke: 9, fuel: 0 }, outwardSpeed: 12, variation: { period: 0.5, strength: 0.6 } }],
    forces: [{ type: "turbulence", strength: 4, scale: 2.2 }, { type: "wind", direction: [1, 0, 0], strength: 0.4 }],
    bake: { center: [0, 4.2, 0], size: 19, pitch: 40, start: 0, duration: 3.5, loop: false, blend: 0 },
  },
  // WHITE PHOSPHORUS ("Willie Pete" — nam): burning pellets thrown out on arcs, each trailing
  // brilliant white smoke (the same flying emitters as the rocket's spikes, burning heads),
  // over a dense white ball that rises.
  wp: {
    label: "White phosphorus",
    note: "one-shot: burning pellets arcing out on white streamers, a white ball rising",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 29,
      grid: { maxVoxels: 12_000_000, cutoff: 0.03, ground: true },
      flame: { lifespan: 0.5, heatRate: 1.5, smokeRate: 6, expansionRate: 2, cooling: 0.8, brightness: 10, opacity: 1, temperature: 3600, sootGlow: 0 },
      smoke: { dissipation: 0.35, color: "#f1f0ea", density: 6, scattering: 0.5, shadowDensity: 2.5 },
      motion: { buoyancy: 2.2, smokeWeight: 0.5, damping: 0.15, vorticity: 3 },
      fuel: { enabled: false },
    },
    // [elevation °, azimuth °, speed m/s]: wider and lower than a rocket's spikes.
    fires: [[50, 0, 13], [35, 25, 11], [65, 55, 14], [30, 85, 10], [55, 110, 13], [40, 140, 12], [70, 165, 12],
      [33, 195, 11], [58, 220, 14], [42, 250, 12], [62, 280, 13], [36, 305, 11], [52, 330, 13], [45, 350, 10]].map(([el, az, sp]) => {
      const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180;
      return { kind: "emitter", at: [0, 0.5, 0], radius: 0.2, emission: { flame: 1, heatRate: 1, smokeRate: 50 }, velocity: null,
        path: { v: [Math.cos(e) * Math.cos(a) * sp, Math.sin(e) * sp, Math.cos(e) * Math.sin(a) * sp] }, until: 1.3 };
    }),
    blasts: [{ at: [0, 0.6, 0], radius: 1.1, charge: { flame: 1, heat: 2.5, smoke: 14, fuel: 0 }, outwardSpeed: 10, variation: { period: 0.5, strength: 0.5 } }],
    forces: [{ type: "turbulence", strength: 3, scale: 2.5 }, { type: "wind", direction: [1, 0, 0], strength: 0.3 }],
    bake: { center: [0, 6, 0], size: 16, pitch: 40, start: 0, duration: 3.5, loop: false, blend: 0 },
  },
  // SIGNAL SMOKE (nam: marking a landing zone): a grenade on the ground pouring thick smoke that
  // drifts with the wind. Baked WHITE: the game tints it (yellow, purple, red…).
  signal: {
    label: "Signal smoke",
    note: "loop: a smoke grenade on the ground, thick billows drifting downwind (tinted in the game)",
    sim: {
      voxelSize: 0.04, brickSize: 16, velocityDivisor: 2, smokeDivisor: 1, seed: 31,
      grid: { maxVoxels: 8_000_000, cutoff: 0.03, ground: true },
      flame: { cooling: 0.6, opacity: 1, brightness: 1 },
      smoke: { dissipation: 0.4, color: "#ffffff", density: 5, scattering: 0.4, shadowDensity: 3 },
      motion: { buoyancy: 1.1, smokeWeight: 0.15, damping: 0.1, vorticity: 3.5 },
    },
    fires: [{ kind: "smoke", at: [0, 0.12, 0], radius: 0.18, emission: { flame: 0, heatRate: 1.6, smokeRate: 40 }, velocity: { direction: [0.3, 1, 0], speed: 2.5 } }],
    blasts: [],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.9 }, { type: "turbulence", strength: 1.2, scale: 2 }],
    bake: { center: [1.6, 2.4, 0], size: 6, pitch: 40, start: 5, duration: 64 / 24, loop: true, blend: 16 },
  },
  shell: {
    label: "Shell in sand",
    note: "one-shot: a shell landing in earth — a short flash, then a dust burst that slumps and drifts (no fuel)",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 7,
      grid: { maxVoxels: 8_000_000, cutoff: 0.03, ground: true },
      // A blink of flame, no soot glow: earth, not fuel.
      flame: { lifespan: 0.35, heatRate: 1, smokeRate: 2, expansionRate: 2, cooling: 1.2, brightness: 6, opacity: 1, temperature: 2400, sootGlow: 0 },
      // Dust is HEAVY (smokeWeight) and barely buoyant: it is thrown, then slumps and drifts.
      smoke: { dissipation: 0.25, color: "#a08a6a", density: 5, scattering: 0.38, shadowDensity: 3 },
      motion: { buoyancy: 1.2, smokeWeight: 2.2, damping: 0.6, vorticity: 2.5 },
      fuel: { enabled: false },
    },
    // The burst alone is an even dome; a shell in earth also throws a JET up for a moment.
    // (Fire Pro caps emission rates at 100 and speeds at 50.)
    fires: [{ kind: "emitter", at: [0, 0.3, 0], radius: 0.5, emission: { flame: 0, heatRate: 3, smokeRate: 100 }, velocity: { direction: [0, 1, 0], speed: 30 }, until: 0.35 }],
    blasts: [{ at: [0, 0.3, 0], radius: 1.2, charge: { flame: 0.6, heat: 1.5, smoke: 12, fuel: 0 }, outwardSpeed: 16, variation: { period: 0.5, strength: 0.6 } }],
    forces: [{ type: "turbulence", strength: 5, scale: 3 }, { type: "wind", direction: [1, 0, 0], strength: 0.3 }],
    bake: { center: [0, 3.5, 0], size: 9, pitch: 40, start: 0, duration: 4, loop: false, blend: 0 },
  },
  wreck: {
    label: "Burning wreck",
    note: "loop: a fuel fire with heavy black smoke (a vehicle burning)",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 3,
      grid: { maxVoxels: 8_000_000, cutoff: 0.05, ground: true },
      // A small hot sphere with an upward push read as a TORCH (one thin jet 6 m tall, no
      // smoke): a wide emitter, low heat per volume, no push, more soot, more turbulence.
      // Soot fades INSIDE the card (dissipation 1.2): a thick plume crossing the bake box
      // drew a square edge on the card. The tall plume is the game's smoke puffs (or the
      // smoke-column book), not this one.
      flame: { lifespan: 0.8, heatRate: 3, smokeRate: 3, expansionRate: 0.4, cooling: 0.62, brightness: 1.2, opacity: 1, temperature: 2900, sootGlow: 1.5 },
      smoke: { dissipation: 1.2, color: "#1c1d1f", density: 7, scattering: 0.38, shadowDensity: 3.5 },
      motion: { buoyancy: 3, smokeWeight: 0.12, damping: 0.1, vorticity: 4 },
      fuel: { enabled: false },
    },
    fires: [{ kind: "fire", at: [0, 0.3, 0], radius: 0.9, emission: { flame: 1, heatRate: 2.5, smokeRate: 1.5 }, velocity: null }],
    blasts: [],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.4 }, { type: "turbulence", strength: 2, scale: 2.5 }],
    bake: { center: [0, 2.9, 0], size: 6, pitch: 40, start: 4, duration: 64 / 24, loop: true, blend: 16 },
  },
  napalm: {
    label: "Napalm splash",
    note: "one-shot: a canister's fuel splashing along the run (+X) — a rolling wall of fire into thick black smoke",
    // Tuned live 2026-10-08: five full fuel charges hit the 12 M voxel cap as one white block;
    // half charges burnt out low in a second. Four 0.6 splashes with the FIREBALL's flame and
    // motion (it rises) and a slower fuel burn (3) roll as one wall for ~2 s, then go black.
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 11,
      grid: { maxVoxels: 12_000_000, cutoff: 0.05, ground: true },
      flame: { lifespan: 5, heatRate: 0.78, smokeRate: 5, expansionRate: 6.23, cooling: 0.26, brightness: 15, opacity: 1, temperature: 2630, sootGlow: 5 },
      smoke: { dissipation: 0.7, color: "#141416", density: 4.5, scattering: 0.38, shadowDensity: 5.24 },
      motion: { buoyancy: 4.66, smokeWeight: 1.45, damping: 0.1, vorticity: 1.08 },
      fuel: { enabled: true, ignitionHeat: 0.4, burnRate: 3 },
    },
    fires: [],
    // Four splashes walking along +X, 0.1 s apart: the fuel arriving as the canister tumbles.
    blasts: [-3, -1, 1, 3].map((x, i) => ({
      at: [x, 0.5, i % 2 ? 0.5 : -0.5], delay: i * 0.1, radius: 0.6,
      charge: { flame: 0, heat: 3.5, smoke: 0.1, fuel: 0.6 }, outwardSpeed: 6, variation: { period: 0.5, strength: 0.6 },
    })),
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 2.2 }, { type: "turbulence", strength: 5, scale: 4 }],
    bake: { center: [2.5, 5, 0], size: 14, pitch: 40, start: 0, duration: 3.6, loop: false, blend: 0 },
  },
  napalmFire: {
    label: "Napalm ground",
    note: "loop: the strip burning after the splash — low wide flames, black smoke",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 13,
      grid: { maxVoxels: 10_000_000, cutoff: 0.05, ground: true },
      flame: { lifespan: 0.9, heatRate: 3, smokeRate: 6, expansionRate: 0.4, cooling: 0.6, brightness: 1.4, opacity: 1, temperature: 2700, sootGlow: 1.5 },
      // Soot fades inside the card (as the wreck): the tall pall is the column book.
      smoke: { dissipation: 1.1, color: "#141416", density: 7, scattering: 0.38, shadowDensity: 3.5 },
      motion: { buoyancy: 3, smokeWeight: 0.12, damping: 0.1, vorticity: 4 },
      fuel: { enabled: false },
    },
    fires: [-3, -1, 1, 3].map((x, i) => ({ kind: "fire", at: [x, 0.25, i % 2 ? 0.5 : -0.5], radius: 0.8, emission: { flame: 1, heatRate: 2.2, smokeRate: 1.5 }, velocity: null })),
    blasts: [],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.4 }, { type: "turbulence", strength: 2, scale: 2.5 }],
    bake: { center: [0, 3.2, 0], size: 9, pitch: 40, start: 4, duration: 64 / 24, loop: true, blend: 16 },
  },
  flamethrower: {
    label: "Flamethrower",
    note: "loop: a fuel jet from a nozzle at hip height, along +X (Fire Pro's Flamethrower preset). The game lays this card ALONG the aim.",
    sim: {
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 17,
      grid: { maxVoxels: 10_000_000, cutoff: 0.05, ground: true },
      // Dan's preset drew a thin 4.5 m rod here (2026-10-08): 3x the fuel, a wider faster jet,
      // a slower burn (it carries further), more soot and swirl → a rope that billows at its end.
      flame: { lifespan: 2, heatRate: 5, smokeRate: 1.5, expansionRate: 0.8, cooling: 0.62, brightness: 1.4, opacity: 1, temperature: 3200, sootGlow: 1 },
      smoke: { dissipation: 0.35, color: "#303030", density: 1.5, scattering: 0.38, shadowDensity: 3.5 },
      motion: { buoyancy: 1.2, smokeWeight: 0.12, damping: 0.15, vorticity: 3 },
      fuel: { enabled: true, ignitionHeat: 0.4, burnRate: 1.5 },
    },
    // The nozzle: thickened fuel, lit as it leaves (heat), thrown at 12 m/s.
    fires: [{ kind: "emitter", at: [-3.5, 1.05, 0], radius: 0.3, emission: { flame: 0, heatRate: 80, smokeRate: 0, fuelRate: 30 }, velocity: { direction: [1, 0, 0], speed: 16 } }],
    blasts: [],
    forces: [{ type: "turbulence", strength: 1.5, scale: 4 }],
    // `anchor`: the nozzle — the bake records where it lands on the card (meta.anchor).
    bake: { center: [1.5, 2.2, 0], size: 11, pitch: 40, start: 3, duration: 64 / 24, loop: true, blend: 16, anchor: [-3.5, 1.05, 0] },
  },
  column: {
    label: "Smoke column",
    note: "loop: thick dark smoke rising off a wreck (no flame)",
    sim: {
      // 0.05 as the others (0.06 froze the fireball; 0.08 was never proven).
      voxelSize: 0.05, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 5,
      grid: { maxVoxels: 12_000_000, cutoff: 0.04, ground: true },
      flame: { cooling: 0.5, opacity: 1, brightness: 1 },
      // Oily black (napalm's pall, a burning wreck's): dark, dense.
      smoke: { dissipation: 0.28, color: "#18181a", density: 6, scattering: 0.38, shadowDensity: 3.5 },
      motion: { buoyancy: 2.6, smokeWeight: 0.1, damping: 0.1, vorticity: 3 },
    },
    // heat 2.4 / push 1.6 / buoyancy 1.8 made a 5 m blob that barely rose (2026-10-08).
    fires: [{ kind: "smoke", at: [0, 0.6, 0], radius: 0.7, emission: { flame: 0, heatRate: 4, smokeRate: 7 }, velocity: { direction: [0, 1, 0], speed: 4 } }],
    blasts: [],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.3 }, { type: "turbulence", strength: 0.6, scale: 2.5 }],
    bake: { center: [0, 5, 0], size: 10, pitch: 40, start: 9, duration: 4, loop: true, blend: 20 },
  },
  // BURNING FUEL ON THE GROUND (2026-10-16, you: the flamethrower's "burning end" — the napalm-strip book
  // on a 4.6 m card drew a block of fire with its black pall cut square at the card's edge). The spatter
  // where a stream comes down: five small puddles over ~2 m, low ragged flames (< ~1.3 m), a little
  // light-grey smoke that dies INSIDE the card (fast dissipation) — no square edge, no black wall.
  fuelFire: {
    label: "Burning fuel",
    note: "loop: a flamethrower's fuel burning on the ground — small scattered puddles, low flames, light smoke",
    sim: {
      voxelSize: 0.04, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 23,
      grid: { maxVoxels: 8_000_000, cutoff: 0.05, ground: true },
      flame: { lifespan: 0.55, heatRate: 3, smokeRate: 0.7, expansionRate: 0.3, cooling: 0.66, brightness: 1.1, opacity: 1, temperature: 2900, sootGlow: 1 },
      smoke: { dissipation: 2.2, color: "#3c3b39", density: 4, scattering: 0.38, shadowDensity: 3 },
      motion: { buoyancy: 3.2, smokeWeight: 0.12, damping: 0.12, vorticity: 3.5 },
    },
    fires: [[-0.9, -0.3, 0.32], [-0.2, 0.45, 0.26], [0.35, -0.2, 0.38], [1.05, 0.25, 0.24], [0.15, -0.75, 0.2]]
      .map(([x, z, r], i) => ({ kind: "fire", at: [x * 0.8, 0.12, z * 0.8], radius: r, emission: { flame: 1, heatRate: 4 + i * 0.6, smokeRate: 0.6 }, velocity: null })),
    blasts: [],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.12 }, { type: "turbulence", strength: 1.6, scale: 1.8 }],
    bake: { center: [0, 1.3, 0], size: 3.0, pitch: 40, start: 3, duration: 64 / 24, loop: true, blend: 16 },
  },
  // A GRENADE (2026-10-22, the Fire Pro pass — it was a small procedural burst): the mortar's recipe at a hand grenade's
  // size — a blink of fire, a short burst of earth spikes (low, fast, thin), a ground skirt of dust, a small grey-brown
  // cloud that slumps and drifts. ~3.5 m across; the game tints it to the ground.
  grenade: {
    label: "Grenade",
    note: "one-shot: a hand grenade in earth — a blink of fire, a short burst of dirt spikes, a small dust cloud",
    sim: {
      voxelSize: 0.03, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 61,
      grid: { maxVoxels: 8_000_000, cutoff: 0.03, ground: true },
      flame: { lifespan: 0.18, heatRate: 2.4, smokeRate: 3, expansionRate: 3, cooling: 1.1, brightness: 14, opacity: 1, temperature: 2800, sootGlow: 2 },
      smoke: { dissipation: 0.6, color: "#6e6658", density: 5, scattering: 0.36, shadowDensity: 3.5 },
      motion: { buoyancy: 1.7, smokeWeight: 1.3, damping: 0.25, vorticity: 4 },
      fuel: { enabled: false },
    },
    // [elevation °, azimuth °, speed m/s, radius m]: lower and shorter than the mortar's (a grenade lies ON the ground)
    fires: [[58, 15, 9, 0.12], [46, 75, 7, 0.14], [66, 130, 10, 0.1], [44, 190, 7, 0.14], [55, 250, 8, 0.12], [62, 310, 9, 0.1]].map(([el, az, sp, rad]) => {
      const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180;
      return { kind: "emitter", at: [0, 0.15, 0], radius: rad, emission: { flame: 0, heatRate: 0.4, smokeRate: 50 }, velocity: null,
        path: { v: [Math.cos(e) * Math.cos(a) * sp, Math.sin(e) * sp, Math.cos(e) * Math.sin(a) * sp] }, until: 0.3 };
    // NO ground skirt: as jets it drew petals — a flat scalloped "dust flower" on the ground in the game (18 thin or 26 fat,
    // seen 2026-10-22). The volume goes UP: a fat jet of earth thrown up, and the blast's own spread.
    }).concat([{ kind: "emitter", at: [0, 0.2, 0], radius: 0.5, emission: { flame: 0, heatRate: 1.8, smokeRate: 100 }, velocity: { direction: [0, 1, 0], speed: 10 }, until: 0.28 }]),
    // (flame 1 drew a smooth WHITE BALL, as the flamethrower's head once: less flame, more smoke, and a strong fine
    // turbulence over its first half-second to tear it)
    blasts: [{ at: [0, 0.2, 0], radius: 0.4, charge: { flame: 0.55, heat: 2.6, smoke: 14, fuel: 0 }, outwardSpeed: 6, variation: { period: 0.3, strength: 0.8 } }],
    forces: [{ type: "turbulence", strength: 3, scale: 1.2 }, { type: "turbulence", strength: 10, scale: 0.6, fadeUntil: 0.6 }, { type: "wind", direction: [1, 0, 0], strength: 0.3 }],
    bake: { center: [0, 1.6, 0], size: 6, pitch: 40, start: 0, duration: 2.5, loop: false, blend: 0 },
  },
  // A BUILDING GOING UP (2026-10-22, you, CoH 3's Nissen hut: "any building animation has a ground smoke"): the
  // dust the work kicks up — low, heavy, brown, ROLLING out along the ground from a few spots (spades, bags, boots),
  // lifting a little as it billows, dying inside the card (no square edge). The game lays a few of these round a
  // site's footprint while it builds, the ground's colour as its tint.
  constructionDust: {
    label: "Construction dust",
    note: "loop: the dust a building site kicks up — low brown billows rolling out along the ground (tinted in the game)",
    sim: {
      voxelSize: 0.04, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 51,
      grid: { maxVoxels: 8_000_000, cutoff: 0.03, ground: true },
      flame: { cooling: 0.6, opacity: 1, brightness: 1 },
      smoke: { dissipation: 1.15, color: "#b09a78", density: 4, scattering: 0.42, shadowDensity: 2.5 },
      // Dust is heavy and barely buoyant: it rolls, then hangs.
      motion: { buoyancy: 0.7, smokeWeight: 0.9, damping: 0.3, vorticity: 4 },
    },
    // Four spots, each pushing dust out low (a little up) in its own direction: the billows meet and roll.
    fires: [[-0.9, -0.4, 200], [0.6, -0.6, 320], [-0.3, 0.7, 110], [1.1, 0.4, 20]].map(([x, z, az], i) => {
      const a = (az * Math.PI) / 180;
      return { kind: "smoke", at: [x, 0.15, z], radius: 0.28, emission: { flame: 0, heatRate: 0.5, smokeRate: 22 + i * 4 }, velocity: { direction: [Math.cos(a), 0.35, Math.sin(a)], speed: 1.8 } };
    }),
    blasts: [],
    // (dissipation 0.75 + wind 0.4 rolled it out of a 6 m box: a square edge on the card)
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.15 }, { type: "turbulence", strength: 2.5, scale: 1.6 }],
    bake: { center: [0.2, 1.6, 0], size: 7, pitch: 40, start: 4, duration: 64 / 24, loop: true, blend: 16 },
  },
  // THUNDERLINE'S TYRE SMOKE (user, 2026-10-29: "the best looking AAA smoke"; the game's puffs read as two tidy white
  // ropes behind the wheels). ONE PUFF'S LIFE, as the game plays it (tyreSmoke.js: age 0 → 1 over the frames):
  // rubber smoke burst off a spinning tyre for a third of a second, thrown sideways (the slide) and a little up; it
  // rolls over itself, swells several times, hangs low (rubber smoke is heavy, barely buoyant) and thins.
  tyreSmoke: {
    label: "Tyre smoke (one puff)",
    note: "one-shot: a puff of rubber smoke thrown off a sliding tyre — it rolls, swells and hangs, then thins (Thunderline)",
    sim: {
      voxelSize: 0.04, brickSize: 16, velocityDivisor: 2, smokeDivisor: 1, seed: 61,
      grid: { maxVoxels: 8_000_000, cutoff: 0.03, ground: true },
      flame: { cooling: 0.6, opacity: 1, brightness: 1 },
      smoke: { dissipation: 0.45, color: "#f4f4f6", density: 4.5, scattering: 0.45, shadowDensity: 2.6 },
      motion: { buoyancy: 0.55, smokeWeight: 0.35, damping: 0.25, vorticity: 4.5 },
    },
    // (a slower, longer burst with mild turbulence left a smooth white BALL for the first second — a drift's puffs
    // live mostly there, and the trail read as a row of balls: torn at once now, and the book starts 0.15 s in)
    fires: [{ kind: "smoke", at: [0, 0.3, 0], radius: 0.22, emission: { flame: 0, heatRate: 0.6, smokeRate: 80 }, velocity: { direction: [1, 0.25, 0.2], speed: 8 }, until: 0.22 }],
    blasts: [],
    forces: [{ type: "turbulence", strength: 3.5, scale: 1.4 }, { type: "turbulence", strength: 5, scale: 0.45 }, { type: "wind", direction: [1, 0, 0], strength: 0.25 }],
    // the chase camera sees smoke from low: 15° down
    bake: { center: [-1.6, 2.2, 0], size: 7, pitch: 15, start: 0.45, duration: 2.9, loop: false, blend: 0 },
  },
  campfire: {
    label: "Campfire",
    note: "loop: clean small flames (Fire Pro's Campfire preset)",
    sim: {
      voxelSize: 0.04, brickSize: 16, velocityDivisor: 2, smokeDivisor: 2, seed: 1,
      grid: { maxVoxels: 8_000_000, cutoff: 0.05, ground: true },
      flame: { lifespan: 0.65, heatRate: 3, smokeRate: 1.2, expansionRate: 0.3, cooling: 0.62, brightness: 0.9, opacity: 1, temperature: 3200, sootGlow: 1 },
      smoke: { dissipation: 0.94, color: "#25292e", density: 7.11, scattering: 0.38, shadowDensity: 3.5 },
      motion: { buoyancy: 4.7, smokeWeight: 0.12, damping: 0.1, vorticity: 3.2 },
    },
    fires: [{ kind: "fire", at: [0, 0.25, 0], radius: 0.45, emission: { flame: 1, heatRate: 10, smokeRate: 0 }, velocity: null }],
    blasts: [],
    forces: [{ type: "wind", direction: [1, 0, 0], strength: 0.16 }, { type: "turbulence", strength: 0.8, scale: 4.6 }],
    bake: { center: [0, 1.5, 0], size: 3.2, pitch: 40, start: 3, duration: 64 / 24, loop: true, blend: 16 },
  },
};

// THE FLAMETHROWER'S START AND STOP, from the same sim (you, 2026-10-09: the stream wiping out
// of the gun "looks fake"). START: from the first fuel out of the nozzle (t = 0) until the
// rope is whole — the burning head shoots out, the rope unrolls behind it, the billow forms
// where it lands. STOP: the nozzle shuts at 3 s (a timed emitter) and the stream breaks off,
// its tail flying on and burning out. The game plays start → loop → stop on one anchor.
const FT = PRESETS.flamethrower;
PRESETS.flamethrowerStart = {
  ...FT, label: "Flamethrower start",
  note: "one-shot: the trigger pulled — the burning head shoots out, the rope unrolls behind it",
  // The sim's head was a smooth white ball (still air, even burning): strong fine turbulence
  // tears it, and FADES OUT by 2.6 s, so the book ends as the loop begins.
  forces: [...FT.forces, { type: "turbulence", strength: 9, scale: 2.2, fadeUntil: 2.6 }],
  // The sim's air starts at rest, so the head takes ~2.5 s to reach the loop's length; baked
  // whole (to where the loop book starts, 3 s) and PLAYED FASTER in the game (ignition ~0.8 s).
  bake: { ...FT.bake, start: 0, duration: 2.9, loop: false, blend: 0 },
};
PRESETS.flamethrowerStop = {
  ...FT, label: "Flamethrower stop",
  note: "one-shot: the trigger let go at 3 s — the stream breaks off at the nozzle and burns out",
  fires: FT.fires.map((f) => ({ ...f, until: 3 })),
  bake: { ...FT.bake, start: 3, duration: 2, loop: false, blend: 0 },
};
