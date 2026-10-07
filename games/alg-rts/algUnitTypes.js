// THE ALGERIA GAME'S UNITS — its own list (nam-rts has its own: the two
// games share the machinery in games/shared-rts, not their armies).
//
// Same scale rule as nam: real size × RTS_SCALE (1.3) for units and
// everything man-made, nature real.
//
// SOLDIERS (2026-09-30): the soldier pack (public/models/soldiers/soldiers.glb,
// packed from assets-src/soldiers/ by tools/packMixamo.mjs --skip soldier3
// --rig-texture originalsoldier, judged in games/shared-rts/soldier-lab.html) — a
// `body` per type and its faction `look` (soldierLooks.js), replacing nam's
// stand-in. The numbers are this game's to tune.
export const RTS_SCALE = 1.3;
const REAL = { soldierHeight: 1.8 };

export const ALG_UNIT_TYPES = {
  // The appelé: the conscript infantryman, the French army's mass in Algeria.
  appele: {
    typeKey: "appele",
    grenade: true,   // algGrenades.js: the GRENADE ability
    name: "Appelés",
    buildLabel: "Groupe (6)",   // a SQUAD a click (algSquads.js)
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
    // The soldier pack (assets-src/soldiers/ → tools/packMixamo.mjs): body
    // soldier1 in the APPELÉ SECTION look (soldierLooks.js) — helmets and bush
    // hats, packs and belts, per-man extras; by spawn order a leader (MAT 49,
    // binoculars), a radioman and an FM 24/29 gunner in every twelve.
    url: "/models/soldiers/soldiers.glb",
    body: "soldier1",
    look: "appeleSection",
    skinned: true,
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // THE PIÈCE FM (2026-10-07, CoH's machine-gun team): three men round a section's FM 24/29 used as
  // the base of fire — the gunner (slot 0: the gun, algSquads SQUADS.piece.kit), his loader and the
  // chef de pièce. The gun SETS UP before it fires, in an arc (algMgTeam.js). The men are appelés
  // (their body and section look; the gunner dressed by role).
  piece: {
    typeKey: "piece",
    name: "Pièce FM",
    buildLabel: "Pièce FM (3)",
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 5.0,
    radius: 1.0,
    turnRate: 6,
    maxHp: 60,
    range: 30,
    damage: 6,
    fireRate: 2.4,
    canHitAir: true,
    vision: 46,
    url: "/models/soldiers/soldiers.glb",
    body: "soldier1",
    look: "appelePiece",
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
    buildLabel: "Génie (3)",
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
    // The appelé's body in the SAPEUR look: pack, belt, work extras — his
    // shovel shows when he digs.
    url: "/models/soldiers/soldiers.glb",
    body: "soldier1",
    look: "sapeur",
    skinned: true,
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // The PARAS: colonial paratroopers, the heliborne reserve, trained at the
  // helipad. Faster and harder than the appelé, closer range (MAT 49s): the
  // unit you fly to where the katiba showed itself. Casquettes Bigeard and red
  // berets, leopard smocks.
  para: {
    typeKey: "para",
    grenade: true,   // algGrenades.js: the GRENADE ability
    name: "Paras coloniaux",
    buildLabel: "Stick para (5)",
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 6.3,
    radius: 1.0,
    turnRate: 7,
    maxHp: 80,
    range: 26,
    damage: 7,
    fireRate: 3.0,
    canHitAir: true,
    vision: 44,
    url: "/models/soldiers/soldiers.glb",
    body: "soldier1",
    look: "paraSection",
    skinned: true,
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // The LÉGION (1er REP): the elite, trained at the post, slow to raise and
  // dear. Full range, the best shots, the toughest men. Green berets.
  legion: {
    typeKey: "legion",
    grenade: true,   // algGrenades.js: the GRENADE ability
    name: "Légionnaires",
    buildLabel: "Légion (5)",
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 5.8,
    radius: 1.0,
    turnRate: 6,
    maxHp: 95,
    range: 30,
    damage: 8,
    fireRate: 2.6,
    canHitAir: true,
    vision: 44,
    url: "/models/soldiers/soldiers.glb",
    body: "soldier1",
    look: "legionSection",
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
    grenade: true,   // algGrenades.js: the GRENADE ability
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
    // Both ALN bodies (aln1: headband and vest, aln2: boonie and open vest),
    // shared out between the fighters, in the ALN SECTION look: chèches, caps,
    // beards, bandoliers, MAS 36 / Mauser / Enfield, the FLN flag.
    url: "/models/soldiers/soldiers.glb",
    bodies: ["aln1", "aln2"],
    look: "alnSection",
    skinned: true,
    targetHeight: REAL.soldierHeight * RTS_SCALE,
    excludeRotorsFromBox: false,
    facingOffset: 0,
    ringRadius: 1.7,
    barWidth: 2.2,
    barY: 3.4,
    castShadow: true,
  },

  // The FM GUNNER (2026-10-01, you: "ambushes can't pin"): a moudjahid with a
  // captured FM 24/29 — the ALN's light MG. Weapon "mg": every burst
  // SUPPRESSES an area (infantryPosture.js), so a band with one can pin a
  // French section in the open. Slower (the gun and its pans), tougher to
  // drop (the band covers him). The ARMS CACHES arm them: two per standing
  // cache (algAI.js) — destroy the caches and the MGs stop coming.
  fmTeam: {
    typeKey: "fmTeam",
    name: "Tireur FM",
    buildLabel: "FM 24/29",
    weapon: "mg",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 4.8,
    radius: 1.0,
    turnRate: 5,
    maxHp: 80,
    range: 42,
    damage: 5,
    fireRate: 4.5,
    canHitAir: true,
    vision: 42,
    url: "/models/soldiers/soldiers.glb",
    bodies: ["aln1", "aln2"],
    look: "alnGunners",
    skinned: true,
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
    // drives along its hull (shared-rts/units.js type.drive, 2026-10-06: "vehicles slide")
    drive: { kind: "wheels", turn: 1.6, accel: 6 },
    typeKey: "willys", name: "Jeep Willys", weapon: "mg",
    isAir: false, hover: 0, speed: 12, radius: 2.9, turnRate: 3.4, maxHp: 120,
    range: 34, damage: 14, fireRate: 1.8, canHitAir: false, vision: 38,
    procedural: "willys", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 3.4, barWidth: 4, barY: 3.4, castShadow: true,
  },
  // GMC CCKW "Jimmy", the convoy truck. Unarmed; plays like nam's M35 (no
  // building yet).
  gmc: {
    // drives along its hull (shared-rts/units.js type.drive, 2026-10-06: "vehicles slide")
    drive: { kind: "wheels", turn: 1.0, accel: 3 },
    typeKey: "gmc", name: "Camion GMC",
    isAir: false, hover: 0, speed: 9, radius: 3.6, turnRate: 3.0, maxHp: 160,
    range: 0, damage: 0, fireRate: 1, canHitAir: false, vision: 34,
    procedural: "gmc", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 5.4, barWidth: 5, barY: 4.4, castShadow: true,
  },
  // M3 half-track, the APC. Plays like nam's M113 (its .50 reaches aircraft).
  halftrack: {
    // drives along its hull (shared-rts/units.js type.drive, 2026-10-06: "vehicles slide")
    drive: { kind: "wheels", turn: 0.9, accel: 2.6 },
    typeKey: "halftrack", name: "Half-track M3", weapon: "mg",
    isAir: false, hover: 0, speed: 10, radius: 4.3, turnRate: 2.5, maxHp: 240,
    range: 38, damage: 16, fireRate: 1.6, canHitAir: true, vision: 38,
    procedural: "halftrack", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 5.0, barWidth: 6, barY: 4.2, castShadow: true,
  },
  // AMX-13, the light tank with the oscillating turret. Plays like nam's
  // M551 Sheridan.
  amx13: {
    // drives along its hull (shared-rts/units.js type.drive, 2026-10-06: "vehicles slide")
    drive: { kind: "tracks", turn: 0.8, accel: 2.4 },
    typeKey: "amx13", name: "AMX-13", weapon: "cannon",
    isAir: false, hover: 0, speed: 8.5, radius: 4.6, turnRate: 2.1, maxHp: 260,
    range: 42, damage: 26, fireRate: 0.85, canHitAir: false, vision: 36,
    procedural: "amx13", excludeRotorsFromBox: false, facingOffset: 0,
    ringRadius: 4.6, barWidth: 6, barY: 4.0, castShadow: true,
  },
  // Panhard EBR, the eight-wheeled armoured car. Sheridan's numbers too for
  // now (its real edge, speed on tracks, comes with this game's balance).
  ebr: {
    // drives along its hull (shared-rts/units.js type.drive, 2026-10-06: "vehicles slide")
    drive: { kind: "wheels", turn: 1.1, accel: 3.2 },
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
