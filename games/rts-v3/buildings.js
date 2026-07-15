// Player buildings — GAME LOGIC. Structures the player CONSTRUCTS at runtime
// (the base and turrets are placed at boot; these aren't).
//
// A building is shaped exactly like a structure (buildings.js makes the same kind
// of object structures.js does) so it drops straight into structures.list — which
// means combat.js targets it, selection picks it, and the command card shows its
// production queue, all with no special-casing. What's new here is a CONSTRUCTION
// phase (`built` ramps 0→1 while the builder raises it) and, for the helipad, a
// production queue that launches HELICOPTERS off the pad.
import * as THREE from "three";
import { findBuildSite, prepareSite } from "./sitePlanner.js";

export const BUILDING_TYPES = {
  helipad: {
    typeKey: "helipad",
    name: "Helipad",
    team: "player",
    maxHp: 700,
    radius: 11,
    buildTime: 5,        // seconds the builder spends raising it
    produces: "helicopter",
    produceTime: 7,      // seconds per helicopter
    launchDur: 1.8,      // heli rise-off-the-pad animation length
    barWidth: 11,
    barY: 8,
  },
};

/** A structure-shaped building. Same contract as structures.js makeStructure. */
function makeBuilding(app, type, x, z) {
  const pos = new THREE.Vector3(x, app.getWorldHeight?.(x, z) ?? 0, z);
  return {
    kind: "structure",
    type,
    typeKey: type.typeKey,
    name: type.name,
    team: type.team,
    passive: false,      // enemies will target it
    isAir: false,
    isStructure: true,
    isBuilding: true,    // distinguishes runtime buildings from the boot structures
    radius: type.radius,
    maxHp: type.maxHp,
    hp: type.maxHp,
    alive: true,
    selected: false,
    // combat: unarmed (range 0 → combat.js never fires it, but still targets it)
    range: 0,
    damage: 0,
    fireRate: 0,
    canHitAir: false,
    cooldown: 0,
    target: null,
    turretYaw: 0,
    // construction + production
    built: 0,            // 0 while rising, 1 when finished
    constructing: true,
    queue: [],
    progress: 0,
    enqueue(key) {
      // Only the thing this building makes, and only once it's finished.
      if (this.alive && !this.constructing && key === type.produces && this.queue.length < 8) {
        this.queue.push(key);
      }
    },
    get position() { return pos; },
    setSelected(v) { this.selected = !!v; },
  };
}

export function createBuildings({ app, structures, units, navGrid = null }) {
  const list = [];

  /**
   * Raise a building at/near (x, z). Flattens the site first (async, GPU
   * heightmap), then adds the structure and starts its construction ramp.
   * Returns the building, or null if the ground is unbuildable.
   */
  async function place(typeKey, x, z) {
    const type = BUILDING_TYPES[typeKey];
    if (!type) return null;

    const site = findBuildSite(app, x, z, type.radius, { searchRadius: 40, maxSpread: 6 });
    if (!site) return null;
    await prepareSite(app, site.x, site.z, type.radius, site.y);

    const b = makeBuilding(app, type, site.x, site.z);
    list.push(b);
    structures.add?.(b);       // combat / selection / waves now see it
    // Block pathing under the footprint so units route around it, not over it.
    navGrid?.addObstacle?.(site.x, site.z, type.radius);
    return b;
  }

  /**
   * Drive builders that have a pending build order: once one reaches its site it
   * stops and raises the building. `buildOrder` is set by the placement UX.
   */
  function updateBuilders() {
    for (const u of units.list) {
      if (!u.alive || !u.buildOrder || u.busyBuilding) continue;
      const bo = u.buildOrder;
      const reach = (BUILDING_TYPES[bo.typeKey]?.radius ?? 8) + 8;
      if (Math.hypot(u.position.x - bo.x, u.position.z - bo.z) > reach) continue; // still driving

      // Arrived — raise it. Guard against re-entry while the async flatten runs.
      u.busyBuilding = true;
      u.haltMovement?.();
      place(bo.typeKey, bo.x, bo.z).finally(() => {
        u.buildOrder = null;
        u.busyBuilding = false;
      });
    }
  }

  /** Where a finished helicopter should rally: just off the pad, toward the enemy. */
  function rallyFor(b) {
    return { x: b.position.x, z: b.position.z + b.radius + 16 };
  }

  function update(dt) {
    updateBuilders();

    for (const b of list) {
      if (!b.alive) continue;

      // Construction ramp — the builder raising it (buildingRenderer shows the rise).
      if (b.constructing) {
        b.built = Math.min(1, b.built + dt / b.type.buildTime);
        if (b.built >= 1) b.constructing = false;
        continue; // no production until it's up
      }

      // Production.
      if (!b.queue.length) { b.progress = 0; continue; }
      const key = b.queue[0];
      b.progress += dt / (b.type.produceTime ?? 6);
      if (b.progress < 1) continue;

      b.progress = 0;
      b.queue.shift();

      // Spawn the aircraft ON THE PAD, at ground level, and launch it: it rises
      // off the pad (units.js launch ramp) before flying to the rally point.
      const u = units.spawn(key, b.position.x, b.position.z, { team: b.team });
      if (u) {
        u.launch?.(b.type.launchDur ?? 1.8);
        const r = rallyFor(b);
        u.faceToward?.(r.x, r.z); // face the rally before lifting off, no mid-air spin
        u.moveOrder?.(r.x, r.z);
      }
    }
  }

  return {
    list,
    place,
    update,
    /** For the renderer: buildings currently standing. */
    get standing() { return list.filter((b) => b.alive); },
  };
}
