// Symmetric match — destroy the enemy HQ to win, lose if yours falls.
//
// OFF by default (dev panel toggle). When enabled the enemy command base is
// spawned at the top of the map and win/lose is tracked every frame.
export function createMatch({ structures, onTerrainChanged = null }) {
  let enabled = false;
  let outcome = null; // null | "victory" | "defeat"
  let spawning = false;

  async function ensureEnemyBase() {
    if (spawning || structures.enemyBase?.alive) return structures.enemyBase;
    spawning = true;
    try {
      const eb = await structures.spawnEnemyBase?.();
      if (eb) await onTerrainChanged?.();
      return eb;
    } finally {
      spawning = false;
    }
  }

  function setEnabled(on) {
    const next = !!on;
    if (next === enabled) return;
    enabled = next;
    outcome = null;
    if (enabled) ensureEnemyBase();
    else {
      structures.removeEnemyBase?.();
      onTerrainChanged?.();
    }
  }

  function update(_dt) {
    if (!enabled || outcome) return;

    const playerBase = structures.base;
    const enemyBase = structures.enemyBase;

    if (!playerBase?.alive) {
      outcome = "defeat";
      return;
    }
    if (enemyBase && !enemyBase.alive) {
      outcome = "victory";
    }
  }

  return {
    get enabled() { return enabled; },
    get outcome() { return outcome; },
    get spawning() { return spawning; },
    setEnabled,
    update,
    /** Re-arm after a finished match (keeps enemy HQ if still alive). */
    resetOutcome() { outcome = null; },
  };
}
