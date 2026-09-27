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
    weapon: "rifle",
    isAir: false,
    foot: true,
    hover: 0,
    speed: 11,
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
};

export const ALG_UNIT_TYPE_KEYS = Object.keys(ALG_UNIT_TYPES);
