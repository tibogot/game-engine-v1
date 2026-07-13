// Structures — GAME LOGIC (mesh-free, like units.js).
//
//   • BASE     — the player's HQ. Big, tough, unarmed (it'll produce units later).
//   • TURRET   — enemy emplacement. Stationary, auto-fires at player units in
//                range, rotates its head to track its target.
//
// Structures are combatants: combat.js treats them and units uniformly (both
// have position/hp/team/range/damage), so one targeting+damage system covers all.
import * as THREE from "three";
import { findBuildSite, prepareSite } from "./sitePlanner.js";

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

/** Seconds to build each unit type. */
export const BUILD_TIME = { soldier: 2.5, jeep: 4, helicopter: 7 };

/**
 * Place structures on the map.
 *
 * MAP LAYOUT: the player starts at the BOTTOM (−Z) and the enemy holds the TOP
 * (+Z) — the classic RTS "you here, them there" axis, so there's a front line to
 * push up. (+Z is the top of the minimap; we flipped it to match earlier.)
 *
 * Every structure gets a REAL site: the ground is evaluated, rejected if too
 * steep, and then FLATTENED so the building sits level on a plateau. Async
 * because flattening round-trips the GPU heightmap — the caller must rebuild the
 * nav grid afterwards, since the terrain has genuinely changed.
 */
export async function createStructures({ app, navGrid, turretCount = 5 } = {}) {
  const list = [];
  const world = app.worldSize ?? 1000;
  const half = world / 2;

  /** Validate + level a site, then build there. Returns null if unbuildable. */
  async function place(type, x, z, opts = {}) {
    const site = findBuildSite(app, x, z, type.radius, opts);
    if (!site) {
      console.warn(`[rts-v3] no buildable ground for ${type.typeKey} near (${x | 0}, ${z | 0}) — skipped.`);
      return null;
    }
    await prepareSite(app, site.x, site.z, type.radius, site.y);
    const s = makeStructure(app, type, site.x, site.z); // reads the NEW height
    list.push(s);
    return s;
  }

  // ── Player base: bottom of the map ──────────────────────────────────────────
  const base = await place(STRUCTURE_TYPES.base, 0, -half * 0.72, { searchRadius: half * 0.5 });
  if (!base) throw new Error("[rts-v3] could not place the player base anywhere.");

  // ── Production ──────────────────────────────────────────────────────────────
  base.queue = [];       // typeKeys waiting to be built
  base.progress = 0;     // 0..1 through the head of the queue
  // Rally toward the enemy (up the map), on flat ground beside the base.
  base.rally = { x: base.position.x, z: base.position.z + base.radius + 22 };
  base.enqueue = (typeKey) => {
    if (base.alive && base.queue.length < 8) base.queue.push(typeKey);
  };

  // ── Enemy turrets: spread across the TOP of the map ─────────────────────────
  // A defensive line to push into, not a ring around your own base. Each finds
  // its own flat site, so a turret never ends up half-buried in a hillside.
  const lineZ = half * 0.55;
  const spanX = half * 1.2;
  for (let i = 0; i < turretCount; i++) {
    const tx = -spanX / 2 + (spanX * i) / Math.max(1, turretCount - 1);
    const tz = lineZ + (i % 2 ? -1 : 1) * half * 0.1; // stagger so it's not a wall
    await place(STRUCTURE_TYPES.turret, tx, tz, { searchRadius: 120, maxSpread: 4 });
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
