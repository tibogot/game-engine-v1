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
};

UNIT_TYPES.soldier = {
  typeKey: "soldier",
  name: "Soldier",
  // logic
  isAir: false,
  hover: 0,
  speed: 11,
  radius: 1.3,
  turnRate: 6,
  maxHp: 60,
  // combat — rifle: fast, weak, can plink at helicopters
  range: 30,
  damage: 6,
  fireRate: 2.4,
  canHitAir: true,
  // render — SKINNED (Mixamo): needs SkeletonUtils.clone + an AnimationMixer,
  // and scales by HEIGHT (a humanoid's horizontal footprint is meaningless).
  url: "/models/testsolanim.glb",
  skinned: true,
  targetHeight: 1.9,
  excludeRotorsFromBox: false,
  facingOffset: 0,
  ringRadius: 2.2,
  barWidth: 3,
  barY: 2.8,
  // Soldiers cast shadows again. They were switched off when each one was his own
  // SkinnedMesh: the shadow pass redraws every caster once per CSM cascade, so six
  // soldiers cost 18 draws. Now the whole crowd is ONE compute-skinned mesh
  // (crowdSkinning.js), so its shadow costs 3 draws — MEASURED IDENTICAL at 6 and
  // at 106 soldiers. Shadows are what ground infantry on the terrain, and they're
  // now free, so there's no reason to skip them.
  castShadow: true,
};

export const UNIT_TYPE_KEYS = Object.keys(UNIT_TYPES);
