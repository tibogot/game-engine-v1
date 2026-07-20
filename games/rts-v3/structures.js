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
import { UNIT_COST } from "./resources.js";

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
  // Unarmed targets for close-range crater / combat tests — no need to cross the map.
  trainingDummy: {
    typeKey: "trainingDummy",
    name: "Training Target",
    team: "enemy",
    passive: true,   // won't be auto-targeted — order an attack to test
    maxHp: 80,
    radius: 2.5,
    range: 0,
    barWidth: 4,
    barY: 4.5,
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
    passive: !!type.passive,
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
export const BUILD_TIME = {
  soldier: 2.5, jeep: 4, builder: 4.5, harvester: 5,
  bigtank: 6.5, tank: 10, helicopter: 7,
};

// The hangar door sits on the base's -Z face, half the hangar depth from centre
// (B_DZ/2 in structuresRenderer.js). Units spawn here and drive straight out.
const DOOR_MOUTH = 8;

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
export async function createStructures({ app, navGrid, turretCount = 5, resources = null } = {}) {
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
  base.rally = { x: base.position.x, z: base.position.z - (base.radius + 22) };
  // Production costs supplies, charged AT QUEUE TIME (the C&C convention): the
  // cost is committed when you click, so a full queue can't outspend your stock
  // and the HUD number always reflects what you've actually promised away.
  // `resources` is optional — without it the base builds for free, which keeps
  // structures.js usable in tests and any harness that has no economy.
  base.enqueue = (typeKey) => {
    if (!base.alive || base.queue.length >= 8) return false;
    const cost = UNIT_COST[typeKey] ?? 0;
    if (cost && resources && !resources.spend(cost)) return false; // can't afford it
    base.queue.push(typeKey);
    return true;
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

  // ── Training targets: a short row north of the base (+Z toward the enemy) ───
  // Unarmed dummies so you can test craters / combat without trekking across the map.
  const dummyOffsets = [-28, -14, 0, 14, 28];
  for (let i = 0; i < dummyOffsets.length; i++) {
    await place(
      STRUCTURE_TYPES.trainingDummy,
      base.position.x + dummyOffsets[i],
      base.position.z + 52 + (i % 2) * 6,
      { searchRadius: 50, maxSpread: 3 },
    );
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

    // Drive OUT OF THE DOOR: spawn at the door mouth (the hangar's -Z face, which
    // the RTS camera sees), placed exactly there — inside the footprint — then a
    // scripted straight exit clear of the base, then a normal move to the rally.
    const doorZ = base.position.z - DOOR_MOUTH;                 // at the door
    const exitZ = base.position.z - (base.radius + 8);          // clear of the footprint
    const u = spawn(key, base.position.x, doorZ, { snap: false });
    u?.emerge(base.position.x, exitZ, base.rally.x, base.rally.z);
  }

  return {
    list,
    base,
    updateProduction,
    /** Add a runtime structure (a player-built building) so combat/selection see it. */
    add(s) { list.push(s); },
    get turrets() { return list.filter((s) => s.typeKey === "turret" && s.alive); },
    /** Re-seat every structure on the current terrain (after loading a .v3proj). */
    async reanchorToTerrain(app) {
      for (const s of list) {
        if (!s.alive) continue;
        const site = findBuildSite(app, s.position.x, s.position.z, s.radius, {
          searchRadius: s.typeKey === "base" ? 120 : 50,
          maxSpread: s.typeKey === "base" ? 8 : 6,
        });
        if (!site) {
          s.position.y = app.getWorldHeight?.(s.position.x, s.position.z) ?? s.position.y;
          continue;
        }
        await prepareSite(app, site.x, site.z, s.radius, site.y);
        s.position.set(site.x, site.y, site.z);
      }
      if (base?.alive) {
        base.rally = { x: base.position.x, z: base.position.z - (base.radius + 22) };
      }
    },
  };
}
