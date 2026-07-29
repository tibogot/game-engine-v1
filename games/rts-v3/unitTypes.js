// Unit archetypes — shared by the LOGIC (units.js) and the RENDERER
// (unitRenderer.js). Logic fields (speed, radius, hp) and render fields (model,
// scale, bar size) live together here because they describe one unit type, but
// the two consumers stay independent.
export const UNIT_TYPES = {
  helicopter: {
    typeKey: "helicopter",
    name: "Helicopter",
    // logic
    isAir: true,
    hover: 24,      // metres above ground/water
    speed: 40,
    radius: 6,      // separation radius
    turnRate: 2.6,  // rad/s — heading follows ACTUAL motion, rate-limited
    maxHp: 80,
    // combat
    range: 44,
    damage: 11,
    fireRate: 3.2,  // shots per second
    canHitAir: true,
    vision: 72,
    // render
    url: "/models/heli5.glb",
    targetLength: 12,
    excludeRotorsFromBox: true, // rotor span would shrink the fuselage
    facingOffset: 0,
    ringRadius: 9,
    barWidth: 8,
    barY: 9,
    castShadow: true, // big, and the ground shadow reads as an altitude cue
  },
  jeep: {
    typeKey: "jeep",
    name: "Jeep",
    // logic
    isAir: false,
    hover: 0,
    speed: 20,
    // The jeep model is ~5 m long, so a 2.6 radius circle only just circumscribes
    // it — two "correctly separated" jeeps still look like they're touching.
    radius: 3.4,
    turnRate: 3.4,  // rad/s — heading follows ACTUAL motion, rate-limited
    maxHp: 120,
    // combat
    range: 34,
    damage: 14,
    fireRate: 1.8,
    canHitAir: false, // ground vehicle — can't shoot helicopters
    vision: 38,

    // render
    url: "/models/jeep_compressed.glb",
    targetLength: 5,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 4,
    barWidth: 4.5,
    barY: 4,
    castShadow: true,
  },
  builder: {
    typeKey: "builder",
    name: "Builder",
    // logic — a mobile engineer. Slow, tough-ish, UNARMED: it constructs, it
    // doesn't fight. `builds` lists the building keys it can raise (buildings.js).
    isAir: false,
    hover: 0,
    speed: 16,
    radius: 3.6,
    turnRate: 3.0,
    maxHp: 160,
    range: 0,          // no weapon — combat.js skips anything with range 0
    vision: 34,
    builds: ["helipad", "turret", "radio", "captureNode"],
    // render
    url: "/models/rts/truckmilitary_compressed.glb",
    targetLength: 6,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 4.4,
    barWidth: 5,
    barY: 4.5,
    castShadow: true,
  },
  // The two armour types. NOTE both GLBs are a SINGLE mesh — no separate turret
  // node — so their guns can't yaw independently of the hull the way the turret
  // emplacements do. The hull heading IS the aim; combat.js already turns a unit
  // toward what it's shooting, so it reads fine at RTS zoom.
  tank: {
    typeKey: "tank",
    name: "Battle Tank",
    // logic — the heavy. Slow and turns slowly, but out-ranges and out-hits
    // everything on the ground. No AA: helicopters are its hard counter.
    isAir: false,
    hover: 0,
    speed: 13,
    radius: 5.0,
    turnRate: 1.6,   // rad/s — deliberately ponderous; flanking it should work
    maxHp: 380,
    // combat
    range: 48,
    damage: 40,
    fireRate: 0.6,   // one heavy shell rather than a stream
    canHitAir: false,
    vision: 36,
    // render
    url: "/models/rts/tankmilitary_compressed.glb",
    targetLength: 8,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 6,
    barWidth: 7,
    barY: 4.6,
    castShadow: true,
  },
  bigtank: {
    typeKey: "bigtank",
    // The model is a BTR — a wheeled APC, not a tank — so it's named and tuned as
    // one: faster and cheaper than the Battle Tank, and its lighter gun CAN
    // elevate onto aircraft, which is what makes it worth fielding alongside.
    name: "Heavy APC",
    isAir: false,
    hover: 0,
    speed: 22,
    radius: 4.3,
    turnRate: 2.5,
    maxHp: 240,
    // combat
    range: 38,
    damage: 16,
    fireRate: 1.6,
    canHitAir: true,
    vision: 38,
    // render
    url: "/models/rts/bigtank_compressed.glb",
    targetLength: 7,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 5,
    barWidth: 6,
    barY: 4.4,
    castShadow: true,
  },
  harvester: {
    typeKey: "harvester",
    name: "Harvester",
    // logic — the economy unit. Unarmed and slow-ish; it shuttles between a
    // resource node and the base forever (harvesting.js drives it). Tougher than
    // a jeep because it spends its life alone in the open, away from the army.
    isAir: false,
    hover: 0,
    speed: 15,
    radius: 3.6,
    turnRate: 2.8,
    maxHp: 220,
    range: 0,          // no weapon — combat.js skips anything with range 0
    vision: 32,
    // harvesting
    harvest: {
      capacity: 60,    // supplies per trip
      rate: 34,        // supplies per second while parked on a node
      unloadRate: 90,  // supplies per second while unloading at the base
    },
    // render
    url: "/models/rts/carmilitary_compressed.glb",
    targetLength: 6,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 4.4,
    barWidth: 5,
    barY: 4.5,
    castShadow: true,
  },
};

UNIT_TYPES.soldier = {
  typeKey: "soldier",
  name: "Soldier",
  // logic
  isAir: false,
  hover: 0,
  speed: 11,
  radius: 2.6,
  turnRate: 6,
  maxHp: 60,
  // combat — rifle: fast, weak, can plink at helicopters
    range: 30,
    damage: 6,
    fireRate: 2.4,
    canHitAir: true,
    vision: 42,
  // render — SKINNED (Mixamo): needs SkeletonUtils.clone + an AnimationMixer,
  // and scales by HEIGHT (a humanoid's horizontal footprint is meaningless).
  url: "/models/testsolanim.glb",
  skinned: true,
  targetHeight: 3.8,
  excludeRotorsFromBox: false,
  facingOffset: 0,
  ringRadius: 4.4,
  barWidth: 6,
  barY: 5.6,
  // Soldiers cast shadows again. They were switched off when each one was his own
  // SkinnedMesh: the shadow pass redraws every caster once per CSM cascade, so six
  // soldiers cost 18 draws. Now the whole crowd is ONE compute-skinned mesh
  // (crowdSkinning.js), so its shadow costs 3 draws — MEASURED IDENTICAL at 6 and
  // at 106 soldiers. Shadows are what ground infantry on the terrain, and they're
  // now free, so there's no reason to skip them.
  castShadow: true,
};

export const UNIT_TYPE_KEYS = Object.keys(UNIT_TYPES);
