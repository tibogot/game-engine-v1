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
    radius: 14,      // combat hit footprint
    // The ground levelled under the building, offset from the base point (world
    // metres, door toward -Z): the Quonset's blast walls reach 13 m in front of
    // the base point and its gable 12 m behind, 11 m either side, masts at 13.
    // The round site stamp alone left the door end on its blended rim, 1-1.5 m
    // under the sandbag skirts.
    pad: { dz: -1, halfX: 13.5, halfZ: 14 },
    // The selection outline: the Quonset and its blast walls (world, door -Z:
    // blast walls 13 m in front of the base point, the gable 12 m behind),
    // inside the pad — the pad's own edge meets the terrace wall.
    frame: { dz: -0.5, halfX: 10.5, halfZ: 12 },
    navRadius: 24,   // pathfinding block — hangar apron (~17 m) + unit clearance
    // Walkable corridor on the −Z face (door / production exit). Carved after the
    // nav circle is stamped so units path around the HQ but still drive out.
    doorApproach: { halfWidth: 7, length: 32, dirX: 0, dirZ: -1 },
    range: 0,        // unarmed
    barWidth: 14,
    barY: 20,
  },
  // The French colonial résidence the Front has taken over (rtsColonial.js):
  // 21 x 14 m, front (arcade, steps) toward -Z. Nav blocks the building's own
  // rectangle plus a man's clearance — no door lane: nobody drives in, the
  // recruits come out of the front at doorOf (enemyAI.js), navRadius + 8 out.
  enemyBase: {
    typeKey: "enemyBase",
    name: "Front HQ (Résidence)",
    team: "enemy",
    maxHp: 3000,
    radius: 14,
    navRadius: 16,
    footprint: { cx: 0, cz: -0.6, hx: 12.6, hz: 9.8 },
    pad: { dz: -1.2, halfX: 13, halfZ: 11 },
    frame: { dz: -0.6, halfX: 11.4, halfZ: 8.6 },
    range: 0,
    barWidth: 14,
    barY: 19,
  },
  turret: {
    typeKey: "turret",
    name: "DShK Nest",
    team: "enemy",
    maxHp: 400,
    radius: 4,
    range: 60,
    damage: 16,
    fireRate: 1.1,   // shots per second
    canHitAir: true,
    barWidth: 6,
    barY: 4.5,
  },
  // A Cu Chi trapdoor (rtsEnemyKit.js): where the Front's men come up. Unarmed,
  // low and in the jungle — concealment (cover.js) makes it hard to pick up —
  // and not very tough once found: a squad with rifles closes it.
  tunnel: {
    typeKey: "tunnel",
    name: "Tunnel Entrance",
    team: "enemy",
    maxHp: 350,
    radius: 2.5,
    footprint: { cx: 0, cz: 0, hx: 1.6, hz: 1.6 },
    range: 0,
    barWidth: 3,
    barY: 3,
  },
  // The ZPU-4 (rtsEnemyKit.js): the quad 14.5 mm the helicopter crews feared
  // most. Outranges every gun you field (62 m against the Huey's 44 and the
  // M48's 48), picks aircraft first, and hits them hard — four barrels,
  // ~65 damage a second into a helicopter, which has 80 — but it is an AA gun
  // in a pit: against ground targets a third of that. What kills one is a
  // tank taking its time (M48 wins 1v1, ~15 s) or riflemen in the grass.
  zpu: {
    typeKey: "zpu",
    name: "ZPU-4 AA Gun",
    team: "enemy",
    maxHp: 350,
    radius: 3.5,
    footprint: { cx: 0, cz: 0, hx: 3.6, hz: 3.6 },
    range: 62,
    damage: 9,
    fireRate: 4,
    canHitAir: true,
    prefersAir: true,
    airMul: 1.8,
    groundMul: 0.6,
    barWidth: 5,
    barY: 4.2,
  },
  // The 82 mm mortar (rtsEnemyKit.js). `range: 0` on purpose: combat.js only
  // knows about shooting at what you can see, and this shoots at GROUND its
  // own men have eyes on, from behind cover. The commander aims it
  // (enemyAI.js) and projectiles.spawnArc throws the shell.
  mortar: {
    typeKey: "mortar",
    name: "82 mm Mortar",
    team: "enemy",
    maxHp: 240,
    radius: 3,
    footprint: { cx: 0, cz: 0, hx: 3, hz: 3 },
    range: 0,
    barWidth: 4,
    barY: 3.4,
  },
  // ── The cheap nasty kit (rtsEnemyKit.js) ───────────────────────────────────
  //
  // Four things the Front can afford that do not win a fight: they make WALKING
  // somewhere expensive. All four are CONCEALED — not drawn, not shot at, not
  // on the minimap — until your men find them (traps.js).
  //
  // `concealed.spot` is how close a RIFLEMAN has to be to have a chance of
  // noticing, `notice` his odds of it per second. Vehicles notice nothing: the
  // man walking in front is the mine detector, and driving blind up a trail is
  // how you find out what is on it. `navBlock` says the thing is walked around
  // once it has been found — knowing where a pit is IS the counter to it.
  punji: {
    typeKey: "punji",
    name: "Punji Pit",
    team: "enemy",
    maxHp: 50,
    radius: 2,
    range: 0,
    concealed: { spot: 10, notice: 0.85 },
    navBlock: { cx: 0, cz: 0, hx: 1.6, hz: 1.6 },
    // Infantry only — a stake pit does nothing to a tracked vehicle — and it
    // does not kill: half a man's health and a limp, which is worse for you
    // than a death, because he walks home instead of fighting.
    trap: { trigger: 2.6, damage: 30, limp: 9, limpScale: 0.45, infantryOnly: true, rearm: 8 },
    barWidth: 3,
    barY: 2.6,
  },
  boobyTrap: {
    typeKey: "boobyTrap",
    name: "Booby Trap",
    team: "enemy",
    maxHp: 30,
    radius: 1.5,
    range: 0,
    concealed: { spot: 9, notice: 0.8 },
    // One bang: it takes the man who walked into it and whoever bunched up
    // behind him, and it is spent. Armour barely notices (vehicleMul).
    trap: { trigger: 3, damage: 58, splash: 8, vehicleMul: 0.12, oneShot: true },
    barWidth: 3,
    barY: 2.2,
  },
  cache: {
    typeKey: "cache",
    name: "Supply Cache",
    team: "enemy",
    maxHp: 260,
    radius: 3,
    range: 0,
    concealed: { spot: 15, notice: 1.4 },   // a rice stack under a mat: easier to find
    navBlock: { cx: 0, cz: 0, hx: 2.4, hz: 2.4 },
    // It pays the Front while it stands (a fifth of a requisition point), and
    // what is left of it pays YOU when it burns. Raiding their rear is worth
    // the walk — and it is the only way to cut their income between points.
    income: 0.35,
    loot: 150,
    barWidth: 5,
    barY: 3.4,
  },
  spiderHole: {
    typeKey: "spiderHole",
    name: "Spider Hole",
    team: "enemy",
    maxHp: 130,
    radius: 1.8,
    // Short-ranged and not very dangerous in a straight fight. What it does is
    // open up behind you, from ground you have already walked past.
    range: 24,
    damage: 7,
    fireRate: 2.2,
    canHitAir: false,
    // `ambush`: he throws the lid back and starts shooting at this range —
    // further than he can hit at, so you always see him before the first round.
    concealed: { spot: 8, notice: 0.7, ambush: 30 },
    navBlock: { cx: 0, cz: 0, hx: 1.2, hz: 1.2 },
    barWidth: 3.5,
    barY: 3,
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
  const s = {
    kind: "structure",
    type,
    typeKey: type.typeKey,
    name: type.name,
    team: type.team,
    passive: !!type.passive,
    isAir: false,
    isStructure: true,
    // A declared rectangle blocks nav instead of a circle (navGrid.addStructureObstacle).
    footprint: type.footprint ?? null,
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
    // An AA gun picks aircraft first and hits them harder (combat.js).
    prefersAir: !!type.prefersAir,
    airMul: type.airMul ?? 1,
    groundMul: type.groundMul ?? 1,
    cooldown: 0,
    target: null,
    turretYaw: 0,      // rendered head rotation
    get position() { return pos; },
    setSelected(v) { this.selected = !!v; },
  };
  // CONCEALED things (the cheap nasty kit) start hidden, and hidden is spelled
  // in the two flags combat.js already understands: `passive` keeps them out of
  // everyone's target list, `deploy` 0 keeps the one that shoots from shooting.
  // Nothing in combat had to learn about traps.
  if (type.concealed) {
    s.concealed = type.concealed;
    s.hidden = true;
    s.passive = true;
    s.deploy = 0;
    /** Found: it becomes an ordinary structure — drawn, shot at, and shooting back. */
    s.reveal = function reveal() {
      if (!this.hidden) return false;
      this.hidden = false;
      this.passive = !!type.passive;
      this.deploy = 1;
      return true;
    };
  }
  return s;
}

/** Seconds to build each unit type. */
export const BUILD_TIME = {
  soldier: 2.5, jeep: 4, builder: 4.5, harvester: 5,
  bigtank: 6.5, lightTank: 8, tank: 10, helicopter: 7,
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
export async function createStructures({ app, navGrid, turretCount = 5, resources = null, dummies = true } = {}) {
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
    // A pad the shape of the building, at the same level: the round stamp is
    // only fully flat to ~60% of its radius.
    if (type.pad && app.flattenRect) {
      const p = type.pad;
      await app.flattenRect(site.x + (p.dx ?? 0), site.z + (p.dz ?? 0), p.halfX, p.halfZ, site.y);
    }
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

  // Enemy HQ — spawned on demand when a match is enabled (see spawnEnemyBase).
  let enemyBase = null;

  /** Mirror the player HQ at the top of the map. Flatten + nav rebuild is async. */
  async function spawnEnemyBase() {
    if (enemyBase?.alive) return enemyBase;
    // Strip a dead entry so combat/raycast don't see a corpse.
    if (enemyBase) {
      const i = list.indexOf(enemyBase);
      if (i >= 0) list.splice(i, 1);
      enemyBase = null;
    }
    // 0.78 (was 0.72): behind its line of nests, with its door lane (32 m
    // toward -Z) clear of the centre nest — at 0.72 on nam-valley the HQ
    // stood 25 m from that nest and its lane ran through it.
    const s = await place(STRUCTURE_TYPES.enemyBase, 0, half * 0.78, {
      searchRadius: half * 0.5,
      maxSpread: 8,
    });
    if (!s) {
      console.warn("[rts-v3] could not place the enemy command base.");
      return null;
    }
    enemyBase = s;
    return enemyBase;
  }

  function removeEnemyBase() {
    if (!enemyBase) return;
    const i = list.indexOf(enemyBase);
    if (i >= 0) list.splice(i, 1);
    enemyBase = null;
  }

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

  // ── The range: a short row north of the base (+Z toward the enemy) ─────────
  // Targets to test craters and combat on without trekking across the map —
  // and, drawn as a real firing range (rtsFirebaseProps.buildTrainingTarget),
  // part of the camp rather than five placeholder boxes in the jungle.
  // ?dummies=0 boots without them.
  if (dummies) {
    const dummyOffsets = [-28, -14, 0, 14, 28];
    for (let i = 0; i < dummyOffsets.length; i++) {
      await place(
        STRUCTURE_TYPES.trainingDummy,
        base.position.x + dummyOffsets[i],
        base.position.z + 52 + (i % 2) * 6,
        { searchRadius: 50, maxSpread: 3 },
      );
    }
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
    get enemyBase() { return enemyBase; },
    spawnEnemyBase,
    removeEnemyBase,
    updateProduction,
    /** Add a runtime structure (a player-built building) so combat/selection see it. */
    add(s) { list.push(s); },
    /** Dig the Front's tunnel entrances at authored sites ({x, z}); returns those placed. */
    async placeTunnels(sites) {
      const out = [];
      for (const t of sites) {
        const s = await place(STRUCTURE_TYPES.tunnel, t.x, t.z, { searchRadius: 30, maxSpread: 3 });
        if (s) out.push(s);
      }
      return out;
    },
    /** Boot-time: one enemy structure on a levelled site near (x, z). */
    async placeEnemy(typeKey, x, z) {
      return place(STRUCTURE_TYPES[typeKey], x, z, { searchRadius: 30, maxSpread: 4 });
    },
    /**
     * IN PLAY: an enemy structure dug in at (x, z) as it stands — no terrain
     * edit (a flatten is a GPU round trip and re-conforms the river: a hitch
     * mid-battle). It starts `deploy` 0 — combat.js holds its fire until the
     * owner has brought it to 1 — and the caller stamps its nav.
     */
    addNow(typeKey, x, z) {
      const s = makeStructure(app, STRUCTURE_TYPES[typeKey], x, z);
      s.deploy = 0;
      list.push(s);
      return s;
    },
    get turrets() { return list.filter((s) => s.typeKey === "turret" && s.alive); },
    get tunnels() { return list.filter((s) => s.typeKey === "tunnel" && s.alive); },
    get zpus() { return list.filter((s) => s.typeKey === "zpu" && s.alive); },
    get mortars() { return list.filter((s) => s.typeKey === "mortar" && s.alive); },
    /** Re-seat every structure on the current terrain (after loading a .v3proj). */
    async reanchorToTerrain(app) {
      for (const s of list) {
        if (!s.alive) continue;
        const isHq = s.typeKey === "base" || s.typeKey === "enemyBase";
        const site = findBuildSite(app, s.position.x, s.position.z, s.radius, {
          searchRadius: isHq ? 120 : 50,
          maxSpread: isHq ? 8 : 6,
        });
        if (!site) {
          s.position.y = app.getWorldHeight?.(s.position.x, s.position.z) ?? s.position.y;
          continue;
        }
        await prepareSite(app, site.x, site.z, s.radius, site.y);
        if (s.type.pad && app.flattenRect) {
          const p = s.type.pad;
          await app.flattenRect(site.x + (p.dx ?? 0), site.z + (p.dz ?? 0), p.halfX, p.halfZ, site.y);
        }
        s.position.set(site.x, site.y, site.z);
      }
      if (base?.alive) {
        base.rally = { x: base.position.x, z: base.position.z - (base.radius + 22) };
      }
    },
  };
}
