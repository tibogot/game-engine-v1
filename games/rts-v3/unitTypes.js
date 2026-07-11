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
  },
};

export const UNIT_TYPE_KEYS = Object.keys(UNIT_TYPES);
