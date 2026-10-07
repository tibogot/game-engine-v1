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
