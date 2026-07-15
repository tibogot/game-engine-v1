// Enemy waves — GAME LOGIC. The opponent.
//
// This needed no new combat code at all. combat.js already treats every unit and
// structure as a "combatant" with a team, auto-acquires the nearest thing on
// another team, chases it and shoots it. So an enemy jeep fights the moment it
// exists — all this file does is decide WHAT spawns, WHERE, WHEN, and points it
// at the player's base.
//
// It costs no draw calls either: enemy units join the same instanced fields and
// the same compute-skinned crowd as the player's, and their side is a per-instance
// tint (teams.js), not a separate material.
import * as THREE from "three";

const FIRST_WAVE_DELAY = 30; // seconds of peace before the first wave
const WAVE_GAP = 45;         // seconds between waves
const ADVANCE_EVERY = 2;     // re-issue "walk at the base" this often (seconds)

// How far out they muster. Far enough that you see them coming on the minimap.
const SPAWN_DISTANCE = 420;

/** What wave `n` is made of. Grows, but the shape matters more than the size. */
function composition(n) {
  return {
    // Infantry is the backbone — and it's free to render (one compute-skinned mesh).
    soldier: Math.min(40, 3 + Math.round(n * 1.8)),
    // Jeeps from wave 2: they outrange soldiers and force you to react.
    jeep: n < 2 ? 0 : Math.min(14, Math.floor(n / 2)),
    // Helicopters from wave 4: they ignore terrain and only air-capable units answer.
    helicopter: n < 4 ? 0 : Math.min(8, Math.floor((n - 2) / 3)),
  };
}

export function createWaves({ app, units, structures, navGrid }) {
  const base = structures.base;
  const half = (app.worldSize ?? 2048) * 0.5;

  let wave = 0;
  let timer = FIRST_WAVE_DELAY;
  let advanceCd = 0;
  let running = true;
  let enabled = false; // OFF by default — the player turns waves on from the dev panel
  let outcome = null;  // "defeat" once the base falls

  const liveEnemies = () =>
    units.list.filter((u) => u.team === "enemy" && u.alive);

  /**
   * Where a wave musters: on a ring around the base, rotating each wave so they
   * don't always come from the same side, jittered so it isn't a metronome.
   */
  function musterPoint(n) {
    const angle = n * 2.4 + Math.random() * 0.8; // ~137° apart, plus jitter
    const r = SPAWN_DISTANCE;
    let x = base.position.x + Math.cos(angle) * r;
    let z = base.position.z + Math.sin(angle) * r;
    // Keep it on the map.
    const edge = half - 40;
    x = THREE.MathUtils.clamp(x, -edge, edge);
    z = THREE.MathUtils.clamp(z, -edge, edge);
    return { x, z };
  }

  function spawnWave(n) {
    const c = composition(n);
    const at = musterPoint(n);
    const spawned = [];

    let i = 0;
    for (const [typeKey, count] of Object.entries(c)) {
      for (let k = 0; k < count; k++) {
        // Fan them out so they don't spawn inside each other.
        const gx = at.x + ((i % 6) - 2.5) * 7;
        const gz = at.z + (Math.floor(i / 6) - 1) * 7;
        const u = units.spawn(typeKey, gx, gz, { team: "enemy" });
        if (u) spawned.push(u);
        i++;
      }
    }

    // March on the base. combat.js will interrupt this by itself the moment
    // anything of ours comes into range — an attack-move, for free.
    for (const u of spawned) u.orderTo?.(base.position.x, base.position.z);

    return spawned.length;
  }

  /**
   * Keep them coming. A unit that killed its target, or that pathfinding gave up
   * on, would otherwise just stand there — so anything idle and unengaged is
   * pointed at the base again.
   */
  function keepAdvancing() {
    if (!base.alive) return;
    for (const u of liveEnemies()) {
      if (u.target || u.attackTarget || u.isMoving) continue;
      u.orderTo?.(base.position.x, base.position.z);
    }
  }

  function update(dt) {
    if (!running || !enabled) return;

    // The base is the win condition. Lose it and the game is over.
    if (!base.alive && !outcome) {
      outcome = "defeat";
      running = false;
      return;
    }

    timer -= dt;
    if (timer <= 0) {
      wave++;
      spawnWave(wave);
      timer = WAVE_GAP;
    }

    advanceCd -= dt;
    if (advanceCd <= 0) {
      advanceCd = ADVANCE_EVERY;
      keepAdvancing();
    }
  }

  return {
    update,
    get enabled() { return enabled; },
    /** Toggle the wave clock. Turning on (re)starts the countdown to the next wave. */
    setEnabled(on) {
      enabled = !!on;
      if (enabled && wave === 0) timer = FIRST_WAVE_DELAY;
    },
    get wave() { return wave; },
    get nextWaveIn() { return Math.max(0, timer); },
    get enemiesAlive() { return liveEnemies().length; },
    get outcome() { return outcome; },
    /** Debug / dev panel: skip the wait. */
    spawnNow() {
      wave++;
      timer = WAVE_GAP;
      return spawnWave(wave);
    },
  };
}
