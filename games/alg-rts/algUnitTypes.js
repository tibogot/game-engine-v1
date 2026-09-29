// THE ALGERIA GAME'S UNITS — its own list (nam-rts has its own: the two
// games share the machinery in games/shared-rts, not their armies).
//
// Same scale rule as nam: real size × RTS_SCALE (1.3) for units and
// everything man-made, nature real.
//
// STAND-INS (you, 2026-09-27): the soldiers use nam's soldier model until
// you make the French and ALN ones. Only the model is borrowed; the numbers
// are this game's to tune.
export const RTS_SCALE = 1.3;
const REAL = { soldierHeight: 1.8 };

export const ALG_UNIT_TYPES = {
  // The appelé: the conscript infantryman, the French army's mass in Algeria.
  appele: {
    typeKey: "appele",
    name: "Appelés",
    buildLabel: "Appelé",   // the command card trains ONE man a click
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 5.5,     // m/s: a credible RTS pace (CoH scale, 2026-09-28; nam runs 11)
    radius: 1.0,
    turnRate: 6,
    maxHp: 60,
    range: 30,
    damage: 6,
    fireRate: 2.4,
    canHitAir: true,
    vision: 42,
    // STAND-IN model: nam's soldier (Mixamo, compute-skinned crowd).
    url: "/models/testsolanim.glb",
    skinned: true,
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // The SAPEUR of the Génie: the French army's engineer, who digs the post's
  // defences (algBuild.js). A rifleman too, a worse one. `builds`: what his
  // command card offers (keys of algBuild.js BUILDS).
  sapeur: {
    typeKey: "sapeur",
    name: "Sapeurs du Génie",
    buildLabel: "Sapeur",
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 5.2,
    radius: 1.0,
    turnRate: 6,
    maxHp: 55,
    range: 26,
    damage: 4,
    fireRate: 2.0,
    canHitAir: false,
    vision: 38,
    builds: ["sandbags", "wire", "mgNest", "mortarPit", "mirador", "searchlight"],
    // STAND-IN model: the appelé's (nam's soldier) until the Génie gets its own.
    url: "/models/testsolanim.glb",
    skinned: true,
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // The moudjahid: an ALN fighter of the katiba, out of the cave mouth. The
  // enemy side (the red wash, teams.js) on the SAME stand-in model as the
  // appelé until you make the ALN one; the numbers are nam's infantry's too.
  moudjahid: {
    typeKey: "moudjahid",
    name: "Moudjahidine",
    buildLabel: "Moudjahid",
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 6,       // lighter kit than the appelé
    radius: 1.0,
    turnRate: 6,
    maxHp: 60,
    range: 30,
    damage: 6,
    fireRate: 2.4,
    canHitAir: true,
    vision: 42,
    url: "/models/testsolanim.glb",
    skinned: true,
    // The same model, dyed: dun and earth browns, the katiba's mixed khaki
    // and civilian cloth, against the appelés' olive (one tint per type).
    crowdTint: [1.05, 0.82, 0.62],
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // ── THE VEHICLES (rtsVehiclesFr.js, built in code, French paint) ────────
  // BEHAVIOUR IS NAM'S FOR NOW (you, 2026-09-27): each copies the numbers of
  // the nam vehicle it plays like (named on each). This game's own balance
  // comes with its own rules. `procedural` names the builder (algUnits.js).
  // Hotchkiss/Willys MB jeep, the patrol's car. Plays like nam's M151.
  willys: {
    typeKey: "willys", name: "Jeep Willys", weapon: "mg",
    isAir: false, hover: 0, speed: 12, radius: 2.9, turnRate: 3.4, maxHp: 120,
    range: 34, damage: 14, fireRate: 1.8, canHitAir: false, vision: 38,
    procedural: "willys", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 3.4, barWidth: 4, barY: 3.4, castShadow: true,
  },
  // GMC CCKW "Jimmy", the convoy truck. Unarmed; plays like nam's M35 (no
  // building yet).
  gmc: {
    typeKey: "gmc", name: "Camion GMC",
    isAir: false, hover: 0, speed: 9, radius: 3.6, turnRate: 3.0, maxHp: 160,
    range: 0, damage: 0, fireRate: 1, canHitAir: false, vision: 34,
    procedural: "gmc", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 5.4, barWidth: 5, barY: 4.4, castShadow: true,
  },
  // M3 half-track, the APC. Plays like nam's M113 (its .50 reaches aircraft).
  halftrack: {
    typeKey: "halftrack", name: "Half-track M3", weapon: "mg",
    isAir: false, hover: 0, speed: 10, radius: 4.3, turnRate: 2.5, maxHp: 240,
    range: 38, damage: 16, fireRate: 1.6, canHitAir: true, vision: 38,
    procedural: "halftrack", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 5.0, barWidth: 6, barY: 4.2, castShadow: true,
  },
  // AMX-13, the light tank with the oscillating turret. Plays like nam's
  // M551 Sheridan.
  amx13: {
    typeKey: "amx13", name: "AMX-13", weapon: "cannon",
    isAir: false, hover: 0, speed: 8.5, radius: 4.6, turnRate: 2.1, maxHp: 260,
    range: 42, damage: 26, fireRate: 0.85, canHitAir: false, vision: 36,
    procedural: "amx13", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 4.6, barWidth: 6, barY: 4.0, castShadow: true,
  },
  // Panhard EBR, the eight-wheeled armoured car. Sheridan's numbers too for
  // now (its real edge, speed on tracks, comes with this game's balance).
  ebr: {
    typeKey: "ebr", name: "Panhard EBR", weapon: "cannon",
    isAir: false, hover: 0, speed: 13, radius: 4.6, turnRate: 2.1, maxHp: 260,
    range: 42, damage: 26, fireRate: 0.85, canHitAir: false, vision: 36,
    procedural: "ebr", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 5.4, barWidth: 6.5, barY: 4.2, castShadow: true,
  },
  // Alouette II. Plays like nam's Huey gunship for now.
  alouette: {
    typeKey: "alouette", name: "Alouette II", weapon: "gunship",
    isAir: true, hover: 24, speed: 24, radius: 6, turnRate: 2.6, maxHp: 80,
    range: 44, damage: 11, fireRate: 3.2, canHitAir: true, vision: 72,
    procedural: "alouette", excludeRotorsFromBox: true, facingOffset: 0,
    ringRadius: 7.5, barWidth: 7, barY: 6, castShadow: true,
  },
};

export const ALG_UNIT_TYPE_KEYS = Object.keys(ALG_UNIT_TYPES);
