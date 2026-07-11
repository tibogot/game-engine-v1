// Structures — GAME LOGIC (mesh-free, like units.js).
//
//   • BASE     — the player's HQ. Big, tough, unarmed (it'll produce units later).
//   • TURRET   — enemy emplacement. Stationary, auto-fires at player units in
//                range, rotates its head to track its target.
//
// Structures are combatants: combat.js treats them and units uniformly (both
// have position/hp/team/range/damage), so one targeting+damage system covers all.
import * as THREE from "three";

export const STRUCTURE_TYPES = {
  base: {
    typeKey: "base",
    name: "Command Base",
    team: "player",
    maxHp: 3000,
    radius: 14,      // footprint (blocks pathing, and a hit target)
    range: 0,        // unarmed
    barWidth: 14,
    barY: 20,
  },
  turret: {
    typeKey: "turret",
    name: "Turret",
    team: "enemy",
    maxHp: 400,
    radius: 4,
    range: 60,
    damage: 16,
    fireRate: 1.1,   // shots per second
    canHitAir: true,
    barWidth: 6,
    barY: 10,
  },
};

function makeStructure(app, type, x, z) {
  const pos = new THREE.Vector3(x, app.getWorldHeight?.(x, z) ?? 0, z);
  return {
    kind: "structure",
    type,
    typeKey: type.typeKey,
    name: type.name,
    team: type.team,
    isAir: false,
    isStructure: true,
    radius: type.radius,
    maxHp: type.maxHp,
    hp: type.maxHp,
    alive: true,
    selected: false,
    // combat
    range: type.range ?? 0,
    damage: type.damage ?? 0,
    fireRate: type.fireRate ?? 0,
    canHitAir: !!type.canHitAir,
    cooldown: 0,
    target: null,
    turretYaw: 0,      // rendered head rotation
    get position() { return pos; },
    setSelected(v) { this.selected = !!v; },
  };
}

/**
 * Place the player base and a scatter of enemy turrets on walkable ground.
 * Positions are snapped clear of water/cliffs via the nav grid.
 */
/** Seconds to build each unit type. */
export const BUILD_TIME = { jeep: 4, helicopter: 7 };

export function createStructures({ app, navGrid, basePos = { x: 0, z: -60 }, turretCount = 5 } = {}) {
  const list = [];

  const snap = (x, z) => (navGrid ? navGrid.nearestOpenWorld(x, z) : { x, z });

  // Player base.
  const b = snap(basePos.x, basePos.z);
  const base = makeStructure(app, STRUCTURE_TYPES.base, b.x, b.z);

  // ── Production ──────────────────────────────────────────────────────────────
  base.queue = [];       // typeKeys waiting to be built
  base.progress = 0;     // 0..1 through the head of the queue
  base.rally = { x: base.position.x + 26, z: base.position.z + 26 };
  base.enqueue = (typeKey) => {
    if (base.alive && base.queue.length < 8) base.queue.push(typeKey);
  };
  list.push(base);

  // Enemy turrets — ringed around the map at a distance from the base so there's
  // somewhere to attack, and something that shoots back.
  const world = app.worldSize ?? 1000;
  const ringR = Math.min(world * 0.28, 260);
  for (let i = 0; i < turretCount; i++) {
    const a = (i / turretCount) * Math.PI * 2 + 0.6;
    const t = snap(base.position.x + Math.cos(a) * ringR, base.position.z + Math.sin(a) * ringR);
    list.push(makeStructure(app, STRUCTURE_TYPES.turret, t.x, t.z));
  }

  /**
   * Advance the base's build queue. `spawn(typeKey, x, z)` comes from the unit
   * manager; the finished unit walks to the base's rally point.
   */
  function updateProduction(dt, spawn) {
    if (!base.alive || !base.queue.length) { base.progress = 0; return; }
    const key = base.queue[0];
    base.progress += dt / (BUILD_TIME[key] ?? 5);
    if (base.progress < 1) return;

    base.progress = 0;
    base.queue.shift();

    // Pop out around the edge of the base, then head for the rally point.
    const a = Math.random() * Math.PI * 2;
    const r = base.radius + 8;
    const u = spawn(key, base.position.x + Math.cos(a) * r, base.position.z + Math.sin(a) * r);
    u?.moveOrder(base.rally.x, base.rally.z);
  }

  return {
    list,
    base,
    updateProduction,
    get turrets() { return list.filter((s) => s.typeKey === "turret" && s.alive); },
  };
}
