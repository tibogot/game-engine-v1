// Unit archetypes — shared by the LOGIC (units.js) and the RENDERER
// (unitRenderer.js). Logic fields (speed, radius, hp) and render fields (model,
// scale, bar size) live together here because they describe one unit type, but
// the two consumers stay independent.
//
// ── THE SCALE RULE: real size × RTS_SCALE, for units AND for anything built ──
//
// One factor for the whole man-made world, so a soldier, the jeep he rides, the
// sandbags he hides behind and the HQ he comes out of are in proportion to each
// other. NATURE STAYS REAL (palms, grass, the terrain): nobody notices a 1.3x
// oil drum beside a palm, but everyone notices a 3.8 m man standing head and
// shoulders above elephant grass that is supposed to hide him — which is what
// the old 2.1x soldier did to the concealment rule.
//
// 1.3 and not 1 because a top-down camera needs a little help: at play zoom the
// screen resolves ~14 px per metre (rtsObjectProps.js), so a 2.3 m soldier is
// ~33 px tall — about a StarCraft II marine. Readability beyond that comes from
// rings, health bars and silhouettes, not from giants.
export const RTS_SCALE = 1.3;
/** Real sizes the numbers below are derived from, metres. */
const REAL = { soldierHeight: 1.8, jeepLength: 3.35 /* M151 MUTT */ };

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
    // Radius a little over half the length, so two "correctly separated" jeeps
    // do not look like they are touching (2.6 against the old 5 m model did).
    radius: 2.9,
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
    targetLength: REAL.jeepLength * RTS_SCALE,   // 4.4 m (was 5: 1.5x)
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 3.5,
    barWidth: 4,
    barY: 3.6,
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
  lightTank: {
    typeKey: "lightTank",
    name: "Light Tank",
    // logic — agile armour: quicker than the battle tank, cheaper, lighter gun.
    isAir: false,
    hover: 0,
    speed: 17,
    radius: 4.6,
    turnRate: 2.1,
    maxHp: 260,
    // combat
    range: 42,
    damage: 26,
    fireRate: 0.85,
    canHitAir: false,
    vision: 36,
    // render — low_poly_tank_compressed.glb normalised to ~7 m (APC scale).
    url: "/models/rts/low_poly_tank_compressed.glb",
    targetLength: 7,
    excludeRotorsFromBox: false,
    // GLB hull faces +X; game heading uses +Z forward — quarter-turn correction.
    facingOffset: Math.PI / 2,
    ringRadius: 5.5,
    barWidth: 6.5,
    barY: 4.2,
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
  // Personal space, not the body: a 2.3 m man is ~0.8 m wide, and a metre of
  // radius keeps a squad about two metres apart — close enough to read as a
  // group, and to fit in cover. Was 2.6 (a 5.2 m circle) for the 3.8 m soldier;
  // it also sets avoidance's look-ahead (5 radii), so crowds got cheaper too.
  radius: 1.0,
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
  targetHeight: REAL.soldierHeight * RTS_SCALE,   // 2.34 m (was 3.8: 2.1x)
  excludeRotorsFromBox: false,
  facingOffset: 0,
  ringRadius: 1.7,
  // Narrower than the 3.2 m muster spacing, or a squad's bars merge into strips.
  barWidth: 2.2,
  barY: 3.4,
  // Soldiers cast shadows again. They were switched off when each one was his own
  // SkinnedMesh: the shadow pass redraws every caster once per CSM cascade, so six
  // soldiers cost 18 draws. Now the whole crowd is ONE compute-skinned mesh
  // (crowdSkinning.js), so its shadow costs 3 draws — MEASURED IDENTICAL at 6 and
  // at 106 soldiers. Shadows are what ground infantry on the terrain, and they're
  // now free, so there's no reason to skip them.
  castShadow: true,
};

export const UNIT_TYPE_KEYS = Object.keys(UNIT_TYPES);
