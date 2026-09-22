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
import {
  buildBunker, buildGunPitBody, buildHelipad, buildMedicTent, buildRadioPost, buildSandbagWallPiece, buildWatchTower,
} from "../../v3/render/objects/rtsBuildables.js";

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
    barY: 5,
  },
  turret: {
    typeKey: "turret",
    name: "M60 Gun Pit",
    team: "player",
    maxHp: 400,
    radius: 4,
    buildTime: 4,        // seconds the builder spends raising it
    // Armed: combat.js drives structures and units through the same targeting
    // code, so these stats are all a defensive emplacement needs.
    range: 60,
    damage: 16,
    fireRate: 1.1,       // shots per second
    canHitAir: true,
    deployDur: 1.1,      // head's calibration sweep once it finishes rising
    barWidth: 6,
    barY: 4.5,
  },
  radio: {
    typeKey: "radio",
    name: "Radio Station",
    team: "player",
    maxHp: 260,
    radius: 8,
    buildTime: 8,
    barWidth: 8,
    barY: 18,
    role: "intel",       // unlocks tactical minimap + extended vision
  },
  // ── Buildings with a job (each earns its place, or it is not here) ─────────
  watchTower: {
    typeKey: "watchTower",
    name: "Guard Tower",
    team: "player",
    maxHp: 300,
    radius: 5,
    buildTime: 5,
    // Sees further: the one reason to build it. A unit sees 40 m, a
    // structure 52; from the deck, over the canopy, 110.
    vision: 110,
    barWidth: 6,
    barY: 10,
  },
  medicTent: {
    typeKey: "medicTent",
    name: "Aid Station",
    team: "player",
    maxHp: 350,
    radius: 9,
    buildTime: 7,
    // Heals INFANTRY standing near it — men, not machines.
    healRadius: 18,
    healRate: 4,         // hp per second, per man
    barWidth: 9,
    barY: 6,
  },
  sandbagWall: {
    typeKey: "sandbagWall",
    name: "Sandbag Wall",
    team: "player",
    maxHp: 220,
    radius: 4,
    buildTime: 2,
    // Cover you build: circles all along the run, at full strength, turned
    // to face away from the HQ (the way the enemy comes from).
    cover: "wall",
    facesOut: true,
    barWidth: 5,
    barY: 2.6,
  },
  bunker: {
    typeKey: "bunker",
    name: "Bunker",
    team: "player",
    maxHp: 1100,
    radius: 5,
    buildTime: 9,
    // HARD cover: takes more off a shot than a rock or a wall does (cover.js
    // maxHardCover), for men fighting from round it.
    cover: "hard",
    facesOut: true,
    barWidth: 7,
    barY: 4.5,
  },
  captureNode: {
    typeKey: "captureNode",
    name: "Supply Relay",
    team: "player",
    maxHp: 320,
    radius: 10,
    buildTime: 6,
    incomeRate: 10,      // supplies/sec while online
    barWidth: 10,
    barY: 16,
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
    // Combat. An unarmed building (range 0) is never fired by combat.js but is
    // still a target; a turret fills these in and defends itself.
    range: type.range ?? 0,
    damage: type.damage ?? 0,
    fireRate: type.fireRate ?? 0,
    canHitAir: !!type.canHitAir,
    cooldown: 0,
    target: null,
    turretYaw: 0,      // rendered head rotation
    // 0→1 calibration sweep after construction. Anything without a deploy phase
    // starts fully deployed, so "deploy < 1" always means "not ready to fire".
    deploy: type.deployDur ? 0 : 1,
    // construction + production
    built: 0,            // 0 while rising, 1 when finished
    constructing: true,
    queue: [],
    progress: 0,
    // Only buildings that PRODUCE get an enqueue — the command card uses its
    // presence to decide whether to show a production face at all, so a turret
    // must not carry a no-op one.
    ...(type.produces ? {
      enqueue(key) {
        // Only the thing this building makes, and only once it's finished.
        if (this.alive && !this.constructing && key === type.produces && this.queue.length < 8) {
          this.queue.push(key);
        }
      },
    } : {}),
    get position() { return pos; },
    setSelected(v) { this.selected = !!v; },
  };
}

/**
 * The footprint a kit building declares (rtsBuildables: helipad, gun pit,
 * radio post), read once from its geometry — so the pad, the nav block and
 * the model can never disagree. null for a type still on the old renderer.
 */
const FOOTPRINT_BUILDERS = {
  helipad: () => buildHelipad(),
  turret: () => buildGunPitBody(),
  radio: () => buildRadioPost(),
  watchTower: () => buildWatchTower(),
  medicTent: () => buildMedicTent(),
  sandbagWall: () => buildSandbagWallPiece(),
  bunker: () => buildBunker(),
};

/** A footprint (building frame) turned by `ry` into world axes, around the origin. */
function turnFootprint(fp, ry) {
  const c = Math.cos(ry), s = Math.sin(ry);
  return { cx: fp.cx * c + fp.cz * s, cz: -fp.cx * s + fp.cz * c, hx: fp.hx, hz: fp.hz, ry };
}

/**
 * What the cover bake stamps for a building (cover.js staticObstacles).
 * A wall is a row of full-strength circles down its length — one blob would
 * hand cover to the open ground past its ends; a bunker is one HARD circle;
 * the rest keep their round footprint.
 */
function coverCirclesFor(b) {
  const fp = b.footprint, t = b.type;
  if (!fp || !t.cover) return [{ x: b.position.x, z: b.position.z, radius: b.radius }];
  const px = b.position.x + fp.cx, pz = b.position.z + fp.cz;
  if (t.cover === "hard") return [{ x: px, z: pz, radius: Math.max(fp.hx, fp.hz), size: 1, hard: true }];
  // Wall: along the footprint's long axis (local X, turned by ry).
  const ax = Math.cos(fp.ry ?? 0), az = -Math.sin(fp.ry ?? 0);
  const out = [];
  const n = Math.max(2, Math.round((2 * fp.hx) / 1.6));
  for (let k = 0; k < n; k++) {
    const u = -fp.hx + 0.8 + ((2 * fp.hx - 1.6) * k) / (n - 1);
    out.push({ x: px + ax * u, z: pz + az * u, radius: 1.0, size: 1 });
  }
  return out;
}
const _footprints = new Map();
function footprintOf(typeKey) {
  if (!_footprints.has(typeKey)) {
    const make = FOOTPRINT_BUILDERS[typeKey];
    let fp = null;
    if (make) {
      const geo = make();
      fp = geo.userData.footprint ?? null;
      geo.userData.stencil?.dispose();
      geo.dispose();
    }
    _footprints.set(typeKey, fp);
  }
  return _footprints.get(typeKey);
}

export function createBuildings({ app, structures, units, navGrid = null, onComplete = null }) {
  const list = [];

  /** Grass and foliage off the site, and the map's rocks out of it. */
  function clearGround(x, z, r) {
    app.clearVegetation?.(x, z, r + 2, { grass: r });
    const ps = app.propStore;
    if (!ps?.instances) return;
    let removed = false;
    for (let i = ps.instances.length - 1; i >= 0; i--) {
      const inst = ps.instances[i];
      if (Math.hypot(inst.px - x, inst.pz - z) < r) { ps.removeInstance(i); removed = true; }
    }
    // A removed rock must stop blocking the path; the rebuild drops the
    // structures' stamps, so they go back on.
    if (removed && navGrid) {
      navGrid.rebuild();
      for (const s of structures.list) if (s.alive) navGrid.addStructureObstacle(s);
    }
  }

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
    // A wall or a bunker faces away from the HQ — its front (+Z) toward
    // where the enemy comes from.
    const hq = structures.base?.position;
    const rotY = type.facesOut && hq ? Math.atan2(site.x - hq.x, site.z - hq.z) : 0;
    // A building on the kit levels a pad to its own footprint, as the camp's
    // pieces do; the rest keep the round site.
    const local = footprintOf(typeKey);
    const fp = local ? turnFootprint(local, rotY) : null;
    if (fp && app.flattenRect) await app.flattenRect(site.x + fp.cx, site.z + fp.cz, fp.hx + 0.5, fp.hz + 0.5, site.y, { rim: 3, rotY });
    else await prepareSite(app, site.x, site.z, type.radius, site.y);

    const b = makeBuilding(app, type, site.x, site.z);
    b.rotY = rotY;
    if (fp) b.footprint = fp;
    b.coverCircles = coverCirclesFor(b);
    clearGround(site.x + (fp?.cx ?? 0), site.z + (fp?.cz ?? 0), fp ? Math.hypot(fp.hx, fp.hz) : type.radius);
    list.push(b);
    structures.add?.(b);       // combat / selection / waves now see it
    // Block pathing under the footprint so units route around it, not over it.
    navGrid?.addStructureObstacle?.(b);
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
        if (b.built >= 1) { b.constructing = false; onComplete?.(b); }
        continue; // no production, and no shooting, until it's up
      }

      // Deploy ramp — a turret spends a beat calibrating before it can fire.
      // combat.js holds fire while this is under 1 (see its `deploying` check).
      if (b.deploy < 1 && b.type.deployDur) {
        b.deploy = Math.min(1, b.deploy + dt / b.type.deployDur);
      }

      // Aid station: men standing near it get their health back.
      if (b.type.healRate) {
        const r2 = b.type.healRadius ** 2;
        for (const u of units.list) {
          if (!u.alive || u.team !== b.team || u.typeKey !== "soldier" || u.hp >= u.maxHp) continue;
          const dx = u.position.x - b.position.x, dz = u.position.z - b.position.z;
          if (dx * dx + dz * dz <= r2) u.hp = Math.min(u.maxHp, u.hp + b.type.healRate * dt);
        }
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
