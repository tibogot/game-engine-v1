// ============================================================================
// CITY FURNITURE — what makes a street a street rather than a corridor.
//
// Parked cars along the kerbs, trees on the pavements, traffic lights at every
// junction, pedestrian guardrails by the crossings. Each kind is ONE
// InstancedMesh — five draws for the whole city — placed deterministically on
// the same block grid the streets and the lamps use, so nothing has to be
// authored and nothing moves when the city is rebuilt or the corridor changes.
//
// ── WHAT IS DELIBERATELY CHEAP ───────────────────────────────────────────────
//
// The car is a body box and a cabin box, ~40 triangles. From the chase camera
// at 40 m it is a coloured block the right size in the right place with a
// shadow under it, which is all a parked car IS from up there. Trees are a
// trunk and a one-subdivision icosphere. No textures anywhere: per-instance
// tint rides `instanceColor`, which NodeMaterial multiplies into the colour
// slot for free.
//
// Counts scale with kerb length: a 2.4 km city is ~55 km of kerb, which lands
// around 3k cars and 3k trees. That is ~600k triangles across five draws —
// vertex work, and the vertex stage is nowhere near the bottleneck here.
// ============================================================================
import * as THREE from "three";
import {
  Fn, float, vec3, vec4, uniform, positionWorld, positionGeometry, smoothstep, mix, oneMinus,
  vertexColor, materialColor, varyingProperty, attribute, fract, step,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { applyBloomMRT } from "../../v3/render/bloomMRT.js";
import { installCityPresetTrees } from "./modularRoadCityTreePreset.js";
import {
  buildClutterKit, placeStreetClutter, CLUTTER_DEFAULTS, CLUTTER_PHYSICS, paint as clutterPaint,
} from "./modularRoadCityClutter.js";
// The stop line is the STREET's number, not a second copy of it: a car that
// pulls up a metre past its own painted line is the one error in this whole
// model anybody would notice.
import { STREET_DEFAULTS } from "./modularRoadCityStreets.js";
import { buildBenchGeometry } from "./modularRoadCityPark.js";
import { createRoadMarkings, planStreetMarks } from "./modularRoadCityMarkings.js";
import {
  ROAD_SIGN_DEFAULTS, SIGN, MIDBLOCK_SIGNS, makeRoadSignAtlas,
  buildRoadSignGeometry, makeRoadSignMaterial, loadRoadSignFolder,
} from "./modularRoadCityRoadSigns.js";
import {
  GANTRY_DEFAULTS, GANTRY_PANELS, makeGantryAtlas, buildGantryGeometry,
  makeGantryMaterial, loadGantryFolder,
} from "./modularRoadCityGantry.js";
import {
  STEAM_DEFAULTS, buildSteamGeometry, makeSteamMaterial,
} from "./modularRoadCitySteam.js";
import { shareInstancePipeline } from "../../v3/render/instancePipeline.js";

/**
 * ── THE DRIVING-SIDE RULE. ONE PLACE, BECAUSE EVERYTHING NEEDS IT ───────────
 *
 * We drive on the RIGHT. Anything that belongs beside the traffic it serves —
 * a signal, an approach sign, a stop line, a lane arrow — has to know which
 * way the lanes on a given kerb travel, and every object that worked this out
 * for itself got it wrong on one of the two axes.
 *
 * The one piece of truth is the lane table in the traffic block below:
 *
 *     [[0.125, 1], [0.375, 1], [0.625, -1], [0.875, -1]]   then, for x: -dir
 *
 * Read off it: on a Z-running street the LOW-across half travels +along; on an
 * X-running street the SAME half travels -along, because the table negates
 * `dir` for x. That single flip is why signals, stop lines and arrows were all
 * right on one axis and backwards on the other, while the cars — the only
 * thing reading the table directly — were always correct.
 *
 * Two consequences, and both follow from this function alone:
 *   · the RIGHT-HAND KERB for +along traffic is the side this returns +1 for;
 *   · that traffic ARRIVES at the block's high end, so its stop line, its
 *     arrow and its signal all belong there.
 *
 * The street SHADER cannot import this — it is TSL — so it derives the same
 * thing from `inStreetX`; see the note on `approachSide` in
 * modularRoadCityStreets.js, and keep the two in step.
 *
 * @param {"x"|"z"} axis  which way the street runs
 * @param {0|1} side      0 = the low-across kerb, 1 = the high-across kerb
 * @returns {1|-1} the direction the lanes beside that kerb travel, along the street
 */
export function laneTravelDir(axis, side) {
  return axis === "z" ? (side === 0 ? 1 : -1) : (side === 0 ? -1 : 1);
}

/**
 * THE SAME TABLE, AS DATA — the four lane centres across a street, low to high.
 *
 * `laneTravelDir` answers the driving-side question for a KERB. Turning needs
 * it for a LANE: a right turn goes from the kerb-most lane of one street into
 * the kerb-most lane of the next, and "kerb-most" is an index into this. Both
 * read the one table, so they cannot drift apart — which is the failure this
 * whole area of the file keeps having.
 */
export const LANE_FRACS = [0.125, 0.375, 0.625, 0.875];

/**
 * Which way lane `fi` travels along its street.
 *
 * The low half of the road travels +along on a Z street and -along on an X one
 * — that single flip is the entire driving-side rule, and it is expressed once,
 * here, by deferring to `laneTravelDir`.
 */
export function laneDirForIndex(axis, fi) {
  return laneTravelDir(axis, fi < 2 ? 0 : 1);
}

/**
 * The two lanes on `axis` that travel `dir`, KERB-MOST FIRST.
 *
 * Which pair it is falls out of the table; which of the pair is kerb-most is
 * simply the one further from the street's centre line.
 */
export function lanePairFor(axis, dir) {
  return laneDirForIndex(axis, 0) === dir ? [0, 1] : [3, 2];
}

/**
 * Where you end up after turning: `hand` is +1 for a right turn, -1 for a left.
 *
 * Derived, not tabulated. `right = forward x up`, and forward is (0,0,dir) on a
 * Z street and (dir,0,0) on an X one, so right of +Z is -X and right of +X is
 * +Z. A table of four cases is exactly how the heading bug happened twice.
 *
 * @returns {{axis: "x"|"z", dir: 1|-1}}
 */
export function turnTo(axis, dir, hand) {
  return axis === "z" ? { axis: "x", dir: -dir * hand } : { axis: "z", dir: dir * hand };
}

/**
 * WHICH WAY THE CAR MODEL FACES, along its own local Z. +1 means the bonnet
 * is at +Z.
 *
 * ONE constant, because three separate places have to agree about it and for a
 * while none of them did:
 *
 *   the PROFILE   an extruded side outline, flipped by `rotateY(PI/2)` — the
 *                 bonnet ends up at +z however the shape was authored
 *   the LAMPS     boxes bolted on the ends, white on the bonnet, red on the boot
 *   the YAW       how a moving car is turned to face where it is going
 *
 * They were written from a comment that said "nose at −z" while the geometry
 * actually put it at +z, so the headlights were modelled on the BOOT. No
 * choice of yaw can fix that: turn the white lamps forward and the car drives
 * trunk-first, turn the bonnet forward and it shows red lights at the front.
 * Both were visible in the game, on different streets, from the one error.
 *
 * Derive from this rather than writing a literal sign anywhere.
 */
export const CAR_NOSE_Z = 1;

/** Where the lamp boxes sit along Z. Proud of the extrude bevel at ±2.33. */
const LAMP_Z = 2.42;
/** The material's cut, just inside the boxes and outside the bevel. */
const LAMP_CUT = 2.34, LAMP_CUT_FULL = 2.38;

export const FURNITURE_DEFAULTS = {
  /** Road lettering — BUS, STOP, SORTIE, TAXI, the bike symbol. One draw for
   *  all of it, off the atlas the viaduct already uses. */
  markings: true,
  /** Metres between candidate slots along a lane. Most candidates stay bare:
   *  paint everywhere reads as a test track, not a city. */
  markingEvery: 46,
  /** Keep clear of a junction by this much. Lettering inside one reads as a
   *  mistake, and it is the first thing the eye checks at a stop line. */
  markingJunctionClear: 11,
  /** Parked cars: station pitch along the kerb, occupancy, and how far the
   *  parking lane sits in from the kerb. */
  carPitch: 7.2,
  carOccupancy: 0.5,
  carInset: 1.35,
  /**
   * WHICH TREE. "procedural" is the box trunk + two hashed icospheres built
   * below; "preset" loads a tree-editor preset through
   * modularRoadCityTreePreset.js and draws its real billboard canopy.
   *
   * A SWITCH, not a replacement — the procedural tree is untouched and one
   * word here brings it back. The placement list, the obstacle capsules and
   * the wet-street reflection rules are shared by both, because they key off
   * the `trees` list and never off the mesh.
   */
  treeSource: "preset",
  /** Trees on the pavement: pitch, distance in from the kerb, canopy size. */
  treePitch: 18,
  /**
   * How far ONTO the pavement a tree stands, from the kerb.
   *
   * WAS 2.3, which put the trunk halfway across a 5.5 m pavement and, on a
   * wide-footprint lot, behind the building line — 259 trees had their trunk
   * inside a building. Street trees go at the kerb in real cities anyway, so
   * this both fixes the clash and is more correct: it buys 1.1 m of clearance
   * for every tree in the city at no cost.
   */
  treeInset: 1.2,
  /**
   * Least room a tree needs before it is not planted at all, metres to the
   * nearest building wall. Below this it would be shrunk to a shrub, and a
   * shrub on a pavement reads as a mistake rather than as a small tree.
   * MEASURED at 1.0: keeps 94.9% of the placements.
   */
  treeMinClearance: 1.0,
  treeOccupancy: 0.8,
  treeHeight: 4.8,
  treeCanopy: 2.6,
  /** Pedestrian guardrail either side of every crossing, metres. */
  railRun: 9,
  /**
   * Mast-arm traffic signals: post height, and how far the arm reaches out
   * over the carriageway.
   *
   * WAS 7.0 / 4.6, and the arm was far too short. MEASURED in the game: the
   * street is 34 m wide with lanes centred 4.3, 12.8, 21.3 and 29.8 m from the
   * kerb, the mast stands 0.9 m back on the pavement, and a 4.6 m arm put the
   * head 3.7 m out — over the gutter, short of even the first lane. It read as
   * a lamp post with a box on it, which is exactly what it looked like.
   *
   * 9.5 m puts the head 8.6 m out, between the first and second lanes and
   * squarely over the near half of the carriageway, which is where a driver
   * looks for it. The post goes up with it: a longer arm needs the height or
   * the head hangs into the lane it is signalling.
   */
  lightHeight: 7.6,
  lightArm: 9.5,
  /** Metres back from the junction, along the mast's own approach. Just
   *  behind the crossing (crossClear is 6.5), which is where a stop line is
   *  and which is what keeps two masts on one corner from crossing booms. */
  lightSetback: 7.0,
  /**
   * THE SIGNAL CYCLE, in seconds, and the two boundaries inside it as
   * fractions: green from 0, amber from `signalGreenEnd`, red from
   * `signalAmberEnd` to the end.
   *
   * Cross streets run half a cycle apart, so red must last MORE than half or
   * both directions would be green at once — 0.50 is the shortest red that
   * cannot overlap, and the amber is taken out of the green's share rather
   * than added on top. 24 s is a real urban cycle and slow enough that you
   * notice one change while driving past rather than a flicker.
   */
  signalCycle: 24,
  signalGreenEnd: 0.44,
  signalAmberEnd: 0.50,
  /**
   * Lens brightness, day and night.
   *
   * A signal lens is SMALL — 27 cm across — and it feeds the bloom buffer, so
   * the level that reads as "lit" is far lower than it looks in isolation:
   * at 5.0 the disc clipped to white and bloomed into a green floodlight with
   * no lens visible inside it. These are tuned so the colour survives the
   * bloom instead of being eaten by it.
   */
  signalDay: 0.8,
  signalNight: 1.8,
  /** Keep clear of the crossings at block ends, metres. */
  crossClear: 6.5,
  /** Fraction of parked cars reversed into their space. A few is real; half
   *  is what it used to be, and half of those were facing oncoming traffic
   *  with their headlights on. */
  carReverseChance: 0.09,
  /** Roadworks and loading-bay clutter — see modularRoadCityClutter.js. */
  ...CLUTTER_DEFAULTS,
  /** Road signs — see modularRoadCityRoadSigns.js. */
  ...ROAD_SIGN_DEFAULTS,
  /** The warning triangle that fronts every roadworks closure. */
  /** Street steam — see modularRoadCitySteam.js. */
  ...STEAM_DEFAULTS,
  /** Overhead direction gantries — see modularRoadCityGantry.js. */
  ...GANTRY_DEFAULTS,
  gantryRows: GANTRY_DEFAULTS.rows,
  // Temporary works get the yellow ground, so a closure is legible as a
  // closure before the picture on the plate resolves at all.
  worksSignTile: SIGN.WORKS_TEMP,
  nightAmount: 0,
  /** ── MOVING TRAFFIC ───────────────────────────────────────────────────
   *  Cars driving the lanes, wrapping across the city. ONE extra draw, and
   *  the update is a matrix compose per visible car on the CPU — a few
   *  hundred of those is nothing, and it avoids putting per-instance motion
   *  in the vertex stage where it is far harder to get right.
   *
   *  Nothing else in the city moves; this is what makes it read as running
   *  rather than as a diorama, and at night the headlight and tail-light
   *  streams down an avenue are the whole picture. */
  traffic: true,
  /** Cars per lane across the full width of the city. */
  trafficPerLane: 10,
  /** Metres per second. Real city traffic, not a motorway. */
  trafficSpeedMin: 7.5,
  trafficSpeedMax: 13.5,
  /** THE DRIVING MODEL. `trafficGap` is bumper to bumper at a standstill —
   *  a car is 4.5 m, so this is the car plus a couple of metres of headway.
   *  Braking is harder than pulling away because it is in a real car, and
   *  because a queue that accelerates as hard as it stops concertinas. */
  trafficGap: 7.2,
  trafficAccel: 2.6,
  trafficDecel: 4.5,
  /**
   * TURNING AT JUNCTIONS.
   *
   * Without it the lanes are infinite straight lines and the whole city reads
   * as parallel conveyor belts: nothing ever leaves the street it started on.
   *
   * `trafficTurnChance` is per car per junction, and only ONE hand is open to
   * any given lane — the kerb-most lane may turn right, the median-most may
   * turn left. A right turn out of the inner lane would cut straight across
   * the outer one, which is the thing that reads as wrong even to someone not
   * looking for it.
   *
   * `trafficTurnRadius` is the corner-cutting radius the car is drawn on, and
   * `trafficTurnLook` is how far before the corner the decision is taken — far
   * enough that there is room to check the other street for a gap BEFORE the
   * car has committed to swinging out.
   */
  trafficTurns: true,
  trafficTurnChance: 0.3,
  trafficTurnRadius: 5.5,
  trafficTurnLook: 26,
  /** How far from the camera a moving car is still updated and drawn. */
  trafficRange: 380,
  /** Head and tail lamp strength at night (they bloom). */
  headlightBoost: 6.0,
  taillightBoost: 2.6,
  headlightColor: 0xfff0d0,
  taillightColor: 0xff2a12,

  /** NIGHT SKYGLOW. A real city is never black between its lamps — its own
   *  light bounces off haze and off every other lit surface. Without it every
   *  car and tree is a silhouette the instant the sun goes. A flat ambient
   *  add, warm, scaled by night: cheap, and it only touches the city. */
  glowColor: 0x2a2f3a,
  glowAmount: 1.0,
};

/** Deterministic per-station hash. */
function h2(a, b, k) {
  let x = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(k | 0, 83492791)) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0; x = Math.imul(x, 3266489917) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** A box sitting on y = 0 with its centre at (x, z). */
function box(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return g;
}

/** Real cars are mostly white, silver, grey and black. Weighted. */
const CAR_PALETTE = [
  [0xc9cbcf, 2.5], [0x9a9ea3, 3], [0x5e6266, 2.5], [0x202225, 3],
  [0x6e1c1c, 1], [0x1d2b4f, 1], [0x2b3f2a, 0.5], [0x7a5a34, 0.5],
];
function pickCarColor(r) {
  const total = CAR_PALETTE.reduce((s, [, w]) => s + w, 0);
  let t = r * total;
  for (const [hex, w] of CAR_PALETTE) { if ((t -= w) <= 0) return hex; }
  return CAR_PALETTE[0][0];
}

/**
 * @param {object} o
 * @param {object} o.P            city params (grid, extent, centre, groundY)
 * @param {number} o.originCellX
 * @param {number} o.originCellZ
 * @param {object} [o.params]
 */
/*
 * ── THE TRAFFIC FLEET ──────────────────────────────────────────────────────
 *
 * Four bodies, not one. A street where every car is the same silhouette
 * reads as generated no matter how good that silhouette is, and the fix is
 * shape variety rather than more detail on a single shape — you recognise a
 * van by its outline at a hundred metres and by nothing else.
 *
 * ONE DRAW CALL EACH, so the whole fleet is four. That is the honest cost
 * and it is the reason this is four geometries rather than one geometry
 * deformed per instance: a vertex-stage reshape would have kept it at one
 * draw, but `InstanceNode` overwrites `positionLocal`, so it would have
 * meant fighting the instancing path for a saving of three draws out of a
 * hundred and twenty. Not a trade worth making.
 *
 * The profiles are (along, up) pairs with the BONNET AT NEGATIVE along —
 * `rotateY(PI/2)` maps that axis to −z, so in the finished geometry the nose
 * is at +Z. That is measurable and it is what CAR_NOSE_Z states. The comment
 * here once claimed the opposite and the lamp boxes were placed to match the
 * comment rather than the geometry, which put the white headlights on the
 * boot; both halves of the traffic then looked wrong for two different
 * reasons and fixing one only moved which half.
 */
export const CAR_BODIES = [
  {
    name: "saloon",
    width: 1.82, wheel: 0.33, axle: 1.45, tread: 0.86,
    // bumper, bonnet, windscreen, roof, rear glass, boot, tail
    pts: [
      [-2.25, 0.32], [-2.25, 0.62], [-2.05, 0.72], [-0.95, 0.80],
      [-0.35, 1.32], [0.75, 1.36],
      [1.45, 1.10], [2.05, 0.95], [2.25, 0.70], [2.25, 0.32],
    ],
    glass: [0.86, 1.34, -1.65, 0.55],
    lamps: [2.42, -2.42],
    share: 0.44,
  },
  {
    // Shorter, and the tail falls straight off the roof instead of stepping
    // down to a boot — which is the whole difference between the two shapes.
    name: "hatchback",
    width: 1.76, wheel: 0.31, axle: 1.26, tread: 0.83,
    pts: [
      [-1.98, 0.30], [-1.98, 0.60], [-1.80, 0.70], [-0.85, 0.78],
      [-0.30, 1.28], [0.72, 1.34],
      [1.42, 1.16], [1.78, 0.78], [1.90, 0.60], [1.90, 0.30],
    ],
    glass: [0.84, 1.32, -1.50, 0.70],
    lamps: [2.14, -2.06],
    share: 0.30,
  },
  {
    // A tall box on a short nose. Nothing else on the street has this
    // outline, so it does most of the work of making the traffic look mixed.
    name: "van",
    width: 1.96, wheel: 0.36, axle: 1.72, tread: 0.90,
    pts: [
      [-2.62, 0.36], [-2.62, 0.70], [-2.50, 0.88], [-2.05, 1.05],
      // The cab roof sits BELOW the box behind it, which is what a van
      // actually looks like — and it is also what keeps the nose readable as
      // the lower end. Level with the box it was a 5 cm difference, and 5 cm
      // is not a shape, it is a rounding error waiting to flip a test.
      [-1.85, 1.82], [2.30, 2.02],
      [2.48, 1.80], [2.55, 1.10], [2.55, 0.70], [2.55, 0.36],
    ],
    // Only the cab glazes; the box behind it is panel all the way back.
    glass: [1.10, 1.92, -2.10, -1.30],
    lamps: [2.78, -2.72],
    share: 0.16,
  },
  {
    // A saloon with a roof sign. Taxis are the one vehicle a city has a lot
    // of and that you can name on sight, so it is worth one archetype.
    name: "taxi",
    width: 1.84, wheel: 0.33, axle: 1.48, tread: 0.87,
    pts: [
      [-2.30, 0.32], [-2.30, 0.62], [-2.10, 0.72], [-1.00, 0.80],
      [-0.38, 1.34], [0.80, 1.38],
      [1.50, 1.12], [2.10, 0.96], [2.30, 0.70], [2.30, 0.32],
    ],
    glass: [0.86, 1.36, -1.70, 0.60],
    lamps: [2.47, -2.47],
    roofSign: true,
    share: 0.10,
  },
];

/**
 * One body, built from its profile. Everything that used to be a literal in
 * here is now read off the spec, so a new archetype is a table entry rather
 * than a copy of this function.
 */
function buildCarBody(B) {
  const W = B.width;
  const shape = new THREE.Shape();
  shape.moveTo(B.pts[0][0], B.pts[0][1]);
  for (let i = 1; i < B.pts.length; i++) shape.lineTo(B.pts[i][0], B.pts[i][1]);
  shape.closePath();
  const body = new THREE.ExtrudeGeometry(shape, {
    depth: W, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.08, bevelSegments: 1, steps: 1,
  });
  body.rotateY(Math.PI / 2);          // extrusion axis (z) → across the car (x)
  body.translate(-W / 2, 0, 0);
  // Glass band: vertices between the belt line and the roof, on the cabin.
  // The window is given in FINISHED coordinates (y lo, y hi, z lo, z hi) —
  // the profile is mirrored by the rotation above, and writing the band in
  // profile space is what once tinted a stripe of bonnet and left half the
  // real cabin painted body colour.
  const [gLo, gHi, zLo, zHi] = B.glass;
  const bp = body.getAttribute("position");
  const bc = new Float32Array(bp.count * 3);
  for (let i = 0; i < bp.count; i++) {
    const y = bp.getY(i), z = bp.getZ(i);
    const glass = y > gLo && y < gHi && z > zLo && z < zHi;
    bc[i * 3] = glass ? 0.16 : 1.0;
    bc[i * 3 + 1] = glass ? 0.18 : 1.0;
    bc[i * 3 + 2] = glass ? 0.22 : 1.0;
  }
  body.setAttribute("color", new THREE.BufferAttribute(bc, 3));

  /*
   * HEAD AND TAIL LAMPS, as real boxes on the nose and tail. The traffic
   * material finds them by their LOCAL Z (positionGeometry survives
   * instancing; positionLocal does not — InstanceNode overwrites it), so
   * they need no attribute of their own and the parked cars, whose material
   * has no such term, simply leave them dark.
   *
   * THE Z MAGNITUDE MATTERS. The extrude's bevel pushes the body out past
   * the profile, so lamps flush with the profile sat INSIDE it — invisible,
   * and indistinguishable from the body by the Z test the material uses.
   * `lamps` carries the proud positions per body for that reason.
   */
  const [noseZ, tailZ] = B.lamps;
  const half = B.width * 0.5;
  const extras = [];
  for (const [x, z, w, h, yy] of [
    [-half * 0.66, CAR_NOSE_Z * noseZ, 0.50, 0.22, 0.62],
    [half * 0.66, CAR_NOSE_Z * noseZ, 0.50, 0.22, 0.62],
    [-half * 0.70, CAR_NOSE_Z * tailZ, 0.46, 0.20, 0.58],
    [half * 0.70, CAR_NOSE_Z * tailZ, 0.46, 0.20, 0.58],
  ]) {
    const g = box(w, h, 0.14, x, yy, z).toNonIndexed();
    const c = new Float32Array(g.getAttribute("position").count * 3).fill(1.0);
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    extras.push(g);
  }
  // Wing mirrors. Two small dark boxes, and the cheapest detail on the car
  // that says "this is a vehicle" at the distance you actually see it.
  const mirrorZ = Math.max(zLo, Math.min(zHi, zHi - 0.15));
  for (const sx of [-1, 1]) {
    const g = box(0.16, 0.10, 0.09, sx * (half + 0.09), gHi - 0.14, mirrorZ).toNonIndexed();
    const c = new Float32Array(g.getAttribute("position").count * 3).fill(0.08);
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    extras.push(g);
  }
  if (B.roofSign) {
    const g = box(0.62, 0.17, 0.24, 0, B.pts[5][1] + 0.09, -0.35).toNonIndexed();
    const c = new Float32Array(g.getAttribute("position").count * 3).fill(0.92);
    g.setAttribute("color", new THREE.BufferAttribute(c, 3));
    extras.push(g);
  }

  /*
   * ExtrudeGeometry is NON-indexed and CylinderGeometry is indexed, and
   * mergeGeometries returns null (silently) for a mixed set — the trap
   * proj_merge_geometries_gotchas records. Everything goes non-indexed.
   *
   * Twelve sides rather than eight: a wheel is round in silhouette against
   * the road more often than any other part of the car is against anything,
   * and the four extra triangles per wheel cost nothing on an instanced
   * mesh that draws one geometry however many cars there are.
   */
  const wheels = [];
  for (const [x, z] of [
    [-B.tread, -B.axle], [B.tread, -B.axle], [-B.tread, B.axle], [B.tread, B.axle],
  ]) {
    const w = new THREE.CylinderGeometry(B.wheel, B.wheel, 0.24, 12, 1, false).toNonIndexed();
    w.rotateZ(Math.PI / 2);
    w.translate(x, B.wheel, z);
    const wc = new Float32Array(w.getAttribute("position").count * 3).fill(0.05);
    w.setAttribute("color", new THREE.BufferAttribute(wc, 3));
    wheels.push(w);
  }
  // All non-indexed, all position/normal/uv/color — merge needs identical
  // layouts AND identical indexing.
  const g = mergeGeometries([body, ...wheels, ...extras], false);
  body.dispose();
  wheels.forEach((w) => w.dispose());
  extras.forEach((l) => l.dispose());
  return g;
}

/** Cumulative shares, so one hash roll picks a body. */
const CAR_SHARE = (() => {
  const out = [];
  let acc = 0;
  for (const b of CAR_BODIES) { acc += b.share; out.push(acc); }
  // Normalised, so the table cannot silently stop covering 0..1.
  return out.map((v) => v / acc);
})();
/** Which body a roll in 0..1 picks. */
function pickCarBody(r) {
  for (let i = 0; i < CAR_SHARE.length; i++) if (r < CAR_SHARE[i]) return i;
  return CAR_SHARE.length - 1;
}

/**
 * ── THE SIGNAL CYCLE, WRITTEN ONCE ───────────────────────────────────────────
 *
 * The lens colour lives in a SHADER: a clock uniform plus a per-instance phase,
 * so the CPU has never known what colour any signal is showing. Cars that stop
 * at lights need exactly that, and the obvious way to get it — a second copy of
 * the cycle arithmetic in the traffic loop — is how the two would drift until
 * cars stopped on green.
 *
 * So the PHASE is computed here and nowhere else. The mast is given it at
 * placement and hands it to the shader as `aPhase`; the car asks for the same
 * junction's phase by the same function. There is one expression, and both
 * sides read it.
 *
 * What is still duplicated is the band test — `t < greenEnd` — because a shader
 * cannot call this. It is one comparison against the same uniform, and
 * `signalGo` is the JS half; keep them in step.
 */
export function signalPhaseAt(axis, kx, kz) {
  // Streets running in z are half a cycle from streets running in x, so the two
  // approaches to any junction are always opposed. The small per-block offset
  // stops the whole city changing on the same beat.
  const wave = ((((kx + kz) % 5) + 5) % 5) * 0.037;
  return (axis === "z" ? 0 : 0.5) + wave;
}

/** True while that signal is GREEN. Amber counts as stop — a car that can still
 *  pull up should, and one that cannot is already past the line. */
export function signalGo(time, phase, F) {
  let t = (time / F.signalCycle + phase) % 1;
  if (t < 0) t += 1;
  return t < F.signalGreenEnd;
}

export function createCityFurniture({ P, originCellX, originCellZ, params: overrides = {}, lamp = null, treeEnv = null, buildingClearance = null, parkBays = [], parkTrees = [], viaduct = null, keepOut = null, holeAt = null, underpass = null }) {
  const F = { ...FURNITURE_DEFAULTS, ...overrides };
  const group = new THREE.Group();
  group.name = "CityFurniture";

  const pitch = (P.blockLots + P.streetLots) * P.lotSize;
  const blockW = P.blockLots * P.lotSize;
  const streetW = Math.max(P.streetLots * P.lotSize, 1);
  const ox = originCellX * P.lotSize, oz = originCellZ * P.lotSize;
  const half = P.extent;
  const gy = P.groundY;
  const inside = (x, z) => Math.abs(x - P.centerX) <= half && Math.abs(z - P.centerZ) <= half;

  const uNight = uniform(F.nightAmount);
  /** Drives the signal cycle. Fed the city clock every frame by updateTraffic. */
  const uSignalTime = uniform(0);
  const uGlow = uniform(new THREE.Color(F.glowColor));
  const uGlowAmt = uniform(F.glowAmount);
  const uHead = uniform(new THREE.Color(F.headlightColor));
  const uTail = uniform(new THREE.Color(F.taillightColor));
  const gyBase = gy;

  /**
   * What a lamp adds to a surface standing in the street, plus the skyglow.
   * Emissive rather than a light because there are no lights: the value is
   * the lamp's irradiance times this surface's own albedo, so a white car
   * lights up under a lamp and a black one barely does — which is what
   * happens. The albedo is `materialColor × vertexColor × instanceColor`,
   * exactly what the diffuse slot resolves to, so the two can never disagree.
   */
  function litAdd({ vcolor = false, icolor = false } = {}) {
    let albedo = materialColor;
    // `.rgb` so the albedo stays the vec3 this comment says it is:
    // vertexColor() is a vec4 and would have widened the whole chain.
    if (vcolor) albedo = albedo.mul(vertexColor().rgb);
    // InstanceNode writes the per-instance tint into this varying and
    // NodeMaterial multiplies it into the diffuse (NodeMaterial.js:857). Read
    // the SAME varying rather than a second copy, or a red car would light up
    // white. Only where the mesh actually has an instanceColor — the varying
    // is never assigned otherwise.
    if (icolor) albedo = albedo.mul(varyingProperty("vec3", "vInstanceColor"));
    const pool = lamp ? lamp.pool().mul(lamp.color) : vec3(0.0);
    return albedo.mul(pool.add(uGlow.mul(uGlowAmt).mul(uNight)));
  }

  // ── Geometry ───────────────────────────────────────────────────────────────
  // THE CAR IS A SIDE PROFILE, not two boxes. A box read as a box even from
  // 40 m — the eye keys on the hood/windscreen/roof/trunk silhouette, so that
  // is what is modelled: one extruded outline across the body width, four
  // wheel cylinders. VERTEX COLOURS split it into paint / glass / rubber, and
  // `instanceColor` multiplies all three, so a white car gets grey wheels and
  // a black car black ones, from one draw. ~150 triangles.
  const trunkGeo = box(0.24, F.treeHeight * 0.55, 0.24);
  // A crown, not a lollipop: two icospheres, subdivided, with every vertex
  // pushed in or out by a hash so the silhouette is ragged, and the second
  // crown offset so no tree is symmetric.
  const canopyGeo = (() => {
    const crown = (r, ox, oy, oz, seed) => {
      const g = new THREE.IcosahedronGeometry(r, 1);
      const p = g.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const n = 0.82 + 0.36 * h2(Math.round(x * 37 + seed), Math.round(y * 41), Math.round(z * 43));
        p.setXYZ(i, x * n + ox, y * n * 0.78 + oy, z * n + oz);
      }
      g.computeVertexNormals();
      return g;
    };
    const base = F.treeHeight * 0.55 + F.treeCanopy * 0.62;
    const a = crown(F.treeCanopy, 0, base, 0, 1);
    const b = crown(F.treeCanopy * 0.72, F.treeCanopy * 0.45, base + F.treeCanopy * 0.35, -F.treeCanopy * 0.3, 7);
    const g = mergeGeometries([a, b], false);
    a.dispose(); b.dispose();
    return g;
  })();
  /*
   * ── THE OVERHEAD SIGNAL ───────────────────────────────────────────────────
   *
   * WAS three boxes — a post, an arm and a blank slab on the end — and it did
   * not read as a traffic light at all, because nothing about it said signal.
   * It was the street lamp's silhouette at a different size, which is why the
   * two were mistaken for each other.
   *
   * What makes a signal legible is the HEAD, not the mast: a black backboard,
   * a housing, and three lenses stacked vertically with hoods over them. All
   * of that is here, and it costs ~150 triangles ONCE — the geometry is shared
   * by every signal in the city through one InstancedMesh, and the LOD writer
   * only ever draws the couple of dozen near the camera.
   *
   * VERTEX COLOURS carry the lens tints, so an unlit red lens still reads as a
   * dark red disc rather than as more black plastic. That also frees
   * `instanceColor`, which the old version was using to carry a lens colour it
   * then never managed to get into the emissive (see lensGlow).
   *
   * Arm along local +X, head hanging under its far end; the placement yaws
   * each mast so the arm reaches over the carriageway.
   */
  const lightGeo = (() => {
    const H = F.lightHeight, A = F.lightArm;
    const parts = [];
    const tint = (g, hex) => {
      const n = g.getAttribute("position").count;
      const c = new THREE.Color(hex);
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute("color", new THREE.Float32BufferAttribute(arr, 3));
      parts.push(g);
      return g;
    };
    const STEEL = 0x33373c, SHELL = 0x141618;
    // Post and arm: tapered cylinders, 8 and 6 sided. A box post is the one
    // thing that gives a mast away at any distance.
    const pole = new THREE.CylinderGeometry(0.15, 0.22, H, 8, 1);
    pole.translate(0, H / 2, 0);
    tint(pole, STEEL);
    // Thicker with the longer span — a 9.5 m reach on a 7 cm tube reads as
    // wire rather than as steel.
    const arm = new THREE.CylinderGeometry(0.09, 0.15, A, 6, 1);
    arm.rotateZ(-Math.PI / 2);          // Y-up cylinder laid along +X
    arm.translate(A / 2, H - 0.18, 0);
    tint(arm, STEEL);
    // Backboard: the wide dark plate the lenses are read against. It is most
    // of why a signal is visible against a bright sky.
    /*
     * THE HEAD LOOKS BACK DOWN ITS OWN APPROACH — so the lenses are on local
     * -Z and the backboard behind them on +Z.
     *
     * It was the other way round, and the arm being right made it worse rather
     * than better: the mast stands on the right kerb UPSTREAM of the junction,
     * so the traffic it controls comes from BEHIND it, and a face on +Z showed
     * the lenses to the cars that had already gone through. All four
     * axis/side combinations were wrong by exactly 180 degrees, which is why
     * it read as "the block with the lights is facing the opposite direction"
     * whichever street you looked at.
     */
    tint(box(0.80, 1.44, 0.04, A, H - 1.56, 0.20), SHELL);
    // Housing, hung under the arm end.
    tint(box(0.38, 1.16, 0.34, A, H - 1.42, 0), SHELL);
    /*
     * THREE LENSES, and their Y positions are the shader's only handle on
     * which is which — see lensGlow. Discs, not boxes: a round lens is the
     * single most recognisable thing on the whole assembly.
     */
    const LENS = [[H - 0.52, 0xff2a1a], [H - 0.85, 0xffb020], [H - 1.18, 0x35ff6a]];
    for (const [y, hex] of LENS) {
      /*
       * PROUD OF THE HOUSING BY A CLEAR MARGIN, and that margin is load
       * bearing: the shader separates lens from bodywork by depth alone
       * (`front` in lensGlow), so a disc flush with the 0.17 front face lights
       * the face with it and the "lens" comes out a SQUARE. Housing front is
       * 0.17, the disc sits at 0.20-0.27, and the hood stops at 0.185.
       */
      const d = new THREE.CylinderGeometry(0.135, 0.135, 0.07, 10, 1);
      d.rotateX(-Math.PI / 2);          // face -Z, back down the approach
      d.translate(A, y, -0.235);
      tint(d, hex);
      // Hood over each lens, so low sun does not wash the head out.
      tint(box(0.34, 0.035, 0.17, A, y + 0.145, -0.10), SHELL);
    }
    const g = mergeGeometries(parts, false);
    for (const q of parts) q.dispose();
    return g;
  })();
  /** Lens centres in geometry Y, top to bottom — the shader bands off these. */
  const LENS_Y = [F.lightHeight - 0.52, F.lightHeight - 0.85, F.lightHeight - 1.18];
  /*
   * BUILT PER CITY, not once at import. The table and the builder above are
   * static and shared, but the geometries are not: `dispose()` frees them on
   * teardown, and a module-level set would be freed out from under the next
   * city the moment one was rebuilt.
   */
  const carGeos = CAR_BODIES.map(buildCarBody);
  const carGeo = carGeos[0];            // the saloon still stands for "a car"
  const { coneGeo, barrierGeo, binGeo, palletGeo, jerseyGeo, plateGeo } = buildClutterKit();
  // The bench lives with the park but is BUILT here, on the clutter's own
  // helpers, so it lands on the shared clutter material like everything else
  // standing on a pavement.
  const benchGeo = buildBenchGeometry(clutterPaint, box);
  const signAtlas = makeRoadSignAtlas(F);
  const signGeo = buildRoadSignGeometry(F);
  const gantryAtlas = makeGantryAtlas({ ...F, rows: F.gantryRows });
  const gantryGeo = buildGantryGeometry(F);
  const steamGeo = buildSteamGeometry(F);
  const railGeo = mergeGeometries([
    box(0.06, 1.05, 0.06, -0.95, 0, 0), box(0.06, 1.05, 0.06, 0.95, 0, 0),   // posts
    box(2.0, 0.05, 0.05, 0, 1.0, 0), box(2.0, 0.05, 0.05, 0, 0.55, 0),        // rails
  ], false);
  for (const g of [...carGeos, trunkGeo, canopyGeo, lightGeo, railGeo]) if (!g) throw new Error("[CityFurniture] merge returned null");

  // ── Materials ──────────────────────────────────────────────────────────────
  // Plain colours: NodeMaterial multiplies `instanceColor` into the slot, so
  // per-instance tint costs nothing.
  const carMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.45, vertexColors: true });
  carMat.name = "CityCars";
  carMat.emissiveNode = litAdd({ vcolor: true, icolor: true });
  const trunkMat = new THREE.MeshStandardNodeMaterial({ color: 0x3b2c20, roughness: 0.95 });
  trunkMat.name = "CityTrunks";
  trunkMat.emissiveNode = litAdd();
  const canopyMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.95 });
  canopyMat.name = "CityCanopies";
  canopyMat.emissiveNode = litAdd({ icolor: true });
  /*
   * ONE MATERIAL FOR ALL FOUR KINDS. Cones, barriers, bins and pallets are all
   * rough dielectrics carrying their own vertex colours, so they differ by
   * geometry alone — four materials would be four shader builds and four
   * pipeline compiles for a difference nobody can see.
   */
  const clutterMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.78, metalness: 0.0, vertexColors: true });
  clutterMat.name = "CityClutter";
  clutterMat.emissiveNode = litAdd({ vcolor: true });
  const signMat = makeRoadSignMaterial(signAtlas, uNight);
  const gantryMat = makeGantryMaterial(gantryAtlas, uNight);
  const steam = makeSteamMaterial(uSignalTime, uNight, F);
  const railMat = new THREE.MeshStandardNodeMaterial({ color: 0x3a3d42, roughness: 0.45, metalness: 0.7 });
  railMat.name = "CityRails";
  railMat.emissiveNode = litAdd();
  // Traffic light: dark pole and head; the lens glows in the instance's colour,
  // brighter at night, and into the bloom MRT.
  const lightMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.5, vertexColors: true });
  lightMat.name = "CityTrafficLights";
  /*
   * ── ONE LENS LIGHTS, AND THE CITY CYCLES ──────────────────────────────────
   *
   * The old version lit the WHOLE HEAD, in white, at a constant level. Three
   * things wrong with that, and the third was a real bug: a signal shows one
   * lens at a time, its colour is the whole message, and the per-instance
   * colour the placement was setting never reached the glow at all —
   * `instanceColor` multiplies `colorNode`, not `emissiveNode`, so it tinted a
   * near-black body where nobody could see it while the emissive returned a
   * hardcoded white. MEASURED: the buffer really did hold red, red, green.
   *
   * So the state is computed here instead of being baked at placement, which
   * costs nothing and buys the thing a static colour can never have — the
   * signals actually CHANGE. `aPhase` says where in the cycle this mast sits
   * and the clock does the rest: no CPU per frame, no instance rewrites, no
   * extra draw. Cross streets are half a cycle apart, so when one is green the
   * other is red, which is the only part of this a player would notice was
   * wrong.
   *
   * WHICH lens is found in GEOMETRY space, off the three lens centres, because
   * `positionGeometry` is the raw attribute and survives instancing (the same
   * trick the parked cars use for their headlights). `front` keeps the glow on
   * the lens faces rather than lighting the backboard through the housing.
   *
   * `aPhase` is a FRACTION, never an integer index — see the varying-precision
   * trap in the signs atlas. Interpolating 0.5 to 0.4999999 costs nothing.
   */
  const aPhase = attribute("aPhase", "float");
  const lensGlow = Fn(() => {
    const t = fract(uSignalTime.div(F.signalCycle).add(aPhase));
    const g = float(F.signalGreenEnd), a = float(F.signalAmberEnd);
    const isGreen = step(t, g);
    const isAmber = step(g, t).mul(step(t, a));
    const isRed = step(a, t);
    const y = positionGeometry.y;
    // A window around each lens centre. Half the 0.33 spacing, so the bands
    // touch and never overlap.
    const band = (c) => step(float(c - 0.16), y).mul(step(y, float(c + 0.16)));
    const lit = vec3(1.0, 0.16, 0.10).mul(band(LENS_Y[0]).mul(isRed))
      .add(vec3(1.0, 0.69, 0.13).mul(band(LENS_Y[1]).mul(isAmber)))
      .add(vec3(0.21, 1.0, 0.42).mul(band(LENS_Y[2]).mul(isGreen)));
    // The lens face is the -Z one — see the head geometry.
    const front = step(positionGeometry.z, float(-0.19));
    const atHead = step(float(F.lightArm * 0.6), positionGeometry.x);
    return lit.mul(front.mul(atHead)).mul(mix(float(F.signalDay), float(F.signalNight), uNight));
  })();
  lightMat.emissiveNode = lensGlow;
  applyBloomMRT(lightMat, vec4(lensGlow, 1.0));

  // ── Placement ──────────────────────────────────────────────────────────────
  const cars = [], trees = [], lights = [], rails = [];
  const cones = [], barriers = [], bins = [], pallets = [], roadSigns = [], gantries = [],
    vents = [], blocks = [], plates = [], benches = [];
  const clutterInto = { cones, barriers, bins, pallets, signs: roadSigns, blocks, plates };
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);
  const place = (list, x, z, yaw, extra) => {
    if (!inside(x, z)) return;
    // NOTHING UNDER A DESCENDING RAMP. One gate, at the one place every kind of
    // furniture is created, because a ramp passes through the height of all of
    // them and street furniture is solid — so anything missed here is not
    // scenery clipping a road, it is a wall across it.
    if (keepOut && keepOut(x, z)) return;
    _p.set(x, gy, z);
    _q.setFromAxisAngle(UP, yaw);
    list.push({ m: _m.compose(_p, _q, _s).clone(), ...extra });
  };

  const kMin = Math.floor((-half - ox) / pitch) - 1, kMax = Math.ceil((half - ox) / pitch) + 1;
  for (let kx = kMin; kx <= kMax; kx++) {
    for (let kz = kMin; kz <= kMax; kz++) {
      // One street run along Z and one along X per period cell; each has two
      // kerbs, and each kerb runs the length of one block (blockW), stopping
      // short of the crossings at both ends.
      const runs = [
        // [axis, fixed coordinate of the -side kerb, run start, run end]
        ["z", ox + kx * pitch + blockW, oz + kz * pitch, oz + kz * pitch + blockW],
        ["x", oz + kz * pitch + blockW, ox + kx * pitch, ox + kx * pitch + blockW],
      ];
      for (const [axis, kerb0, a0, a1] of runs) {
        for (let side = 0; side < 2; side++) {
          const dir = side === 0 ? -1 : 1;                 // which way "into the block" is
          const kerb = side === 0 ? kerb0 : kerb0 + streetW;
          const carAcross = kerb - dir * F.carInset;        // into the road
          const treeAcross = kerb + dir * F.treeInset;      // onto the pavement
          const yawAlong = axis === "z" ? 0 : Math.PI / 2;
          const seedA = Math.round(kerb * 3), seedB = Math.round(a0);
          const at = (across, along) => axis === "z" ? [across, along] : [along, across];

          // Parked cars, in the lane by the kerb, clear of the crossings.
          for (let s = a0 + F.crossClear + F.carPitch * 0.5; s < a1 - F.crossClear; s += F.carPitch) {
            const st = Math.round(s / F.carPitch);
            if (h2(seedA, st, 1) > F.carOccupancy) continue;
            const jitter = (h2(seedA, st, 2) - 0.5) * 0.9;
            const [x, z] = at(carAcross, s + jitter);
            /*
             * PARKED CARS FACE THE WAY THEIR LANE TRAVELS.
             *
             * This was `yawAlong + (coin flip ? 0 : PI)`, so HALF the parked
             * cars faced backwards — and since their headlights burn day and
             * night, every other one on your side of the road was a vehicle
             * coming straight at you. Reported as "the cars are driving the
             * wrong lines", and it is not the moving traffic (whose lane
             * directions are right); it is the parked ones.
             *
             * The kerb you are parked against decides it, exactly as it
             * decides which way the signal arm reaches: a rotation about +Y by
             * t sends the nose (+Z) to (sin t, cos t) in XZ, and a z-running
             * street's low-x kerb carries the +z lanes.
             *
             * A few are still reversed in, because a car park nose-out is a
             * real thing and a street where every single car is perfectly
             * aligned reads as generated.
             */
            const parkYaw = axis === "z"
              ? (side === 0 ? 0 : Math.PI)
              : (side === 0 ? -Math.PI / 2 : Math.PI / 2);
            const reversedIn = h2(seedA, st, 3) < F.carReverseChance ? Math.PI : 0;
            place(cars, x, z, parkYaw + reversedIn + (h2(seedA, st, 4) - 0.5) * 0.06,
              { color: pickCarColor(h2(seedA, st, 5)), body: pickCarBody(h2(seedA, st, 6)) });
          }
          // Trees on the pavement, staggered off the lamp stations.
          for (let s = a0 + F.crossClear + 4; s < a1 - F.crossClear; s += F.treePitch) {
            const st = Math.round(s / F.treePitch);
            if (h2(seedA, st, 11) > F.treeOccupancy) continue;
            const [x, z] = at(treeAcross, s);
            /*
             * HOW MUCH ROOM THIS ONE HAS. Carried on the placement rather than
             * resolved here, because the two tree paths have very different
             * canopies — 2.6 m for the procedural icospheres, 5.9 m for the
             * preset — so "does it fit" is the renderer's question to answer.
             * What IS decided here is whether to plant at all, so the obstacle
             * capsules can never describe a tree nobody drew.
             */
            const clearance = buildingClearance ? buildingClearance(x, z) : Infinity;
            if (clearance < F.treeMinClearance) continue;
            const scale = 0.85 + h2(seedA, st, 12) * 0.35;
            const green = new THREE.Color().setHSL(0.26 + (h2(seedA, st, 13) - 0.5) * 0.07, 0.34, 0.16 + h2(seedA, st, 14) * 0.09);
            place(trees, x, z, h2(seedA, st, 15) * 6.283, { color: green.getHex(), scale, clearance });
          }
          // Guardrail either side of each crossing, on the kerb line.
          for (const end of [a0, a1]) {
            const from = end === a0 ? a0 + 1.2 : a1 - F.railRun - 1.2;
            for (let s = from; s < from + F.railRun; s += 2.0) {
              const [x, z] = at(kerb + dir * 0.25, s + 1.0);
              place(rails, x, z, yawAlong, {});
            }
          }
          /*
           * A MAST-ARM SIGNAL on the corner — a tall post with the head slung
           * out over the carriageway, not a short pole with a box on it.
           *
           * THE YAW NOW ENCODES WHICH SIDE, not which end, and that is the whole
           * change. The arm has to reach over the ROAD; on the far kerb that is
           * the opposite world direction, so a yaw that only knew which end of
           * the block it was at would point half of them backwards into the
           * building line. `dir` is "into the block", so the arm wants the
           * opposite — which is exactly what flipping by side does.
           *
           * ONE PER APPROACH, ON THAT APPROACH'S RIGHT-HAND KERB, AT THE
           * JUNCTION IT ARRIVES AT. We drive on the right, so that is the only
           * place a signal belongs — and getting it right is also what stops
           * the masts crossing.
           *
           * The pairing was INVERTED. `side === 0` is the low-across kerb, and
           * the lanes beside it travel in +along (see the lane table: low frac
           * gets dir +1). Traffic going +along ARRIVES at the HIGH end, a1 —
           * but this put that mast at a0, the junction it had just left. So
           * every mast stood at the wrong corner, behind its own driver, on
           * top of the cross street's mast: two booms over one corner in an X,
           * heads out over the pedestrian crossing instead of over the lanes.
           *
           * Right-hand rule, once: facing +z your right is -x, which is the
           * low-across kerb. So side 0 serves +along traffic and belongs at
           * a1; side 1 serves -along traffic and belongs at a0.
           */
          /*
           * WHICH END THIS KERB'S TRAFFIC ARRIVES AT — from the shared rule,
           * not from `side`. Deriving it from the side alone was right on
           * z-streets and backwards on x-streets, because the lane table
           * negates `dir` for x. See laneTravelDir.
           */
          const travel = laneTravelDir(axis, side);
          for (const end of [a0, a1]) {
            if ((travel > 0) !== (end === a1)) continue;
            /*
             * SET BACK ONTO ITS OWN APPROACH, which is what uncrosses them.
             *
             * These used to sit 1 m INTO the junction mouth. Both masts that
             * share a corner then stood 2.7 m apart — MEASURED at the origin:
             * (0.9, -1) and (-1, 0.9) — with 9.5 m booms at the same height
             * meeting at right angles. That is the X the user photographed.
             *
             * The corner is not the mistake: it genuinely serves two
             * approaches, and a real junction does put a mast on it. The
             * mistake was standing them in the crossing. Backed off by
             * `lightSetback` each mast sits behind its own stop line, just
             * short of the zebra, and the two booms reach into the junction
             * from opposite sides without ever meeting — mast A's boom stops
             * at x <= 0.9 while mast B's never comes below z = 0.9.
             */
            const s = travel > 0 ? a1 - F.lightSetback : a0 + F.lightSetback;
            const [x, z] = at(kerb + dir * 0.9, s);
            /*
             * PHASE COMES FROM THE AXIS, not from a hash of the position.
             *
             * The old line rolled a random lens colour per mast, so the four
             * signals around one junction could all be green — which is the
             * one thing about a traffic light a player checks without meaning
             * to. Streets running in z are half a cycle from streets running
             * in x, so a junction's two approaches are always opposed.
             *
             * The small per-block offset stops the whole city changing on the
             * same beat (a green wave down an avenue); both axes of one
             * junction share it, so it never breaks the opposition above.
             */
            const phase = signalPhaseAt(axis, kx, kz);
            /*
             * THE ARM'S OWN YAW, DERIVED — not `yawAlong` with a flip.
             *
             * `yawAlong` orients things that run ALONG the street (a parked
             * car's nose, a guardrail). The signal's arm is its local +X and
             * has to reach ACROSS, into the carriageway, and those two are not
             * the same rotation on both axes. A rotation about +Y by t sends
             * +X to (cos t, -sin t) in XZ, so an x-running street needs -PI/2
             * where a z-running one needs 0 — reusing `yawAlong` sent 156 of
             * 300 signals into the building behind them. Same bug, same file,
             * same day as the street lamps: derive it from the direction the
             * road actually is.
             */
            const armYaw = axis === "z"
              ? (side === 0 ? 0 : Math.PI)
              : (side === 0 ? -Math.PI / 2 : Math.PI / 2);
            place(lights, x, z, armYaw, { phase, axis, side, travel, a0, a1 });
            /*
             * AN OVERHEAD DIRECTION GANTRY ON THE SAME APPROACH, sometimes.
             *
             * Shares the signal's mast corner and the signal's `armYaw` — the
             * boom is local +X on both, so there is ONE convention for "reach
             * out over the carriageway" rather than two that can drift. What
             * differs is only how far back it stands: `setback` is well beyond
             * `lightSetback`, because a driver needs to read where the road
             * goes BEFORE they read whether they may go there.
             */
            if (h2(seedA, side, 121) < F.chance) {
              const gs = travel > 0 ? a1 - F.setback : a0 + F.setback;
              if (gs > a0 + F.crossClear && gs < a1 - F.crossClear) {
                const [gx, gz] = at(kerb + dir * 0.9, gs);
                const gTile = Math.floor(h2(seedA, side, 122) * GANTRY_PANELS.length) % GANTRY_PANELS.length;
                place(gantries, gx, gz, armYaw, { tile: gTile, axis, side, travel });
              }
            }
          }
          /*
           * ROADWORKS AND LOADING BAYS. Placed from HERE rather than from the
           * clutter module because this loop is the one place that turns block
           * indices into kerb lines — a second copy of that maths is how the
           * two would drift apart.
           */
          placeStreetClutter({
            into: clutterInto, place, at, kerb, dir, a0, a1, yawAlong, axis, travel,
            rand: h2, seed: seedA + (side === 0 ? 0 : 977), C: F,
            // The same two refusals `place` makes, asked up front, so a site
            // that meets either is left out whole instead of trimmed.
            blocked: (x, z) => !inside(x, z) || (keepOut ? keepOut(x, z) : false),
          });
          /*
           * A STEAM VENT IN THE CARRIAGEWAY. In the road rather than on the
           * pavement, because that is where a manhole is — and because a
           * plume you drive THROUGH is worth more than one you drive past.
           */
          if (h2(seedA, side, 131) < F.steamChance) {
            const vs = a0 + F.crossClear + h2(seedA, side, 132) * Math.max(1, (a1 - a0) - F.crossClear * 2);
            const [vx, vz] = at(kerb - dir * F.steamInset, vs);
            place(vents, vx, vz, h2(seedA, side, 133) * 6.283, { phase: h2(seedA, side, 134) });
          }
          /*
           * ONE MID-BLOCK SIGN, facing the traffic it is for.
           *
           * Mid-block, and never STOP or GIVE WAY — those mean a junction, and
           * this city signals its junctions. A speed limit halfway down a
           * block is right; a stop sign there is the kind of wrong that reads
           * as carelessness rather than as decoration, so the roll cannot draw
           * one (see MIDBLOCK_SIGNS).
           *
           * THE YAW COMES FROM `travel`, NOT FROM `dir`.
           *
           * The plate's artwork is on its local +Z, so the sign has to face
           * AGAINST the lane it addresses. This flipped on `dir` instead,
           * which is the same mistake the masts and the ground arrows both
           * made: `dir` is the kerb's inward direction, and the lane table
           * negates it on x-streets. That made x-streets right by accident
           * and turned every sign on every z-street to face the traffic's
           * back — the "sometimes right, sometimes not" the user saw.
           */
          for (let k = 0; k < 2; k++) {
            const chance = k === 0 ? F.signChance : F.signChanceSecond;
            if (h2(seedA, side * 2 + k, 91) >= chance) continue;
            // Two halves of the run, so a pair never lands on top of itself.
            const span = Math.max(1, (a1 - a0) - F.crossClear * 2) * 0.5;
            const s = a0 + F.crossClear + k * span + h2(seedA, side * 2 + k, 92) * span;
            const [x, z] = at(kerb + dir * F.inset, s);
            const tile = MIDBLOCK_SIGNS[Math.floor(h2(seedA, side * 2 + k, 93) * MIDBLOCK_SIGNS.length) % MIDBLOCK_SIGNS.length];
            place(roadSigns, x, z, yawAlong + (travel > 0 ? Math.PI : 0), { tile, axis, travel });
          }
        }
      }
    }
  }

  // ── Meshes ─────────────────────────────────────────────────────────────────
  const _c = new THREE.Color();
  function instanced(list, geo, mat, name, { shadows = true } = {}) {
    if (!list.length) return null;
    const im = shareInstancePipeline(new THREE.InstancedMesh(geo, mat, list.length));
    im.name = name;
    im.frustumCulled = false;
    im.castShadow = shadows;
    im.receiveShadow = true;
    list.forEach((e, i) => {
      if (e.scale && e.scale !== 1 && !e.scaled) { _s.set(e.scale, e.scale, e.scale); e.m.scale(_s); _s.set(1, 1, 1); e.scaled = true; }
      im.setMatrixAt(i, e.m);
      if (e.color != null) im.setColorAt(i, _c.set(e.color));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    group.add(im);
    return im;
  }
  // ── MOVING TRAFFIC ─────────────────────────────────────────────────────────
  // A lane is a straight line across the whole city on one street axis; cars
  // wrap along it, so they pass through the junctions instead of stopping at
  // block ends. Lane centres sit at 1/8, 3/8, 5/8, 7/8 of the carriageway —
  // between the paint the street shader draws at 1/4, 1/2 and 3/4.
  const lanes = [];
  /**
   * (axis, street cell, lane index) -> index into `lanes`.
   *
   * A turning car has to name the lane it is turning INTO, and it can only do
   * that by integers: the two `across` values would be computed by two
   * different expressions and float equality between them is not a thing to
   * rely on. `k` and `fi` are exact.
   */
  const laneIndex = new Map();
  /**
   * A NUMBER, not a string. `maybeTurn` runs for every car in a block on every
   * frame — around a thousand calls at 60 Hz — and a template literal there is
   * a thousand short-lived strings a second for the collector to deal with.
   * `k` is a street index, comfortably inside +/-4096 for any city this can
   * build; the +4096 only exists so a negative one does not collide.
   */
  const laneKey = (axis, k, fi) => (((k + 4096) * 4 + fi) * 2 + (axis === "z" ? 0 : 1));
  if (F.traffic) {
    const span = half * 2;
    for (let k = Math.floor((-half - ox) / pitch) - 1; k <= Math.ceil((half - ox) / pitch) + 1; k++) {
      for (const axis of ["z", "x"]) {
        const base = (axis === "z" ? ox : oz) + k * pitch + blockW;
        for (let fi = 0; fi < LANE_FRACS.length; fi++) {
          const across = base + streetW * LANE_FRACS[fi];
          const lim = axis === "z" ? P.centerX : P.centerZ;
          if (Math.abs(across - lim) > half) continue;
          // WHICH SIDE IS THE RIGHT-HAND SIDE FLIPS BETWEEN THE TWO AXES, and
          // this table did not, so one whole axis drove on the wrong side —
          // half the city's traffic meeting the other half head-on.
          //
          // `right = forward x up`. Driving +Z that is -X, so the +1 lanes
          // belong at LOW across, which is where 0.125/0.375 put them. Driving
          // +X it is +Z, so the +1 lanes belong at HIGH across instead — the
          // exact mirror. One sign, applied on one axis, and both agree on
          // right-hand traffic. trafficHeadingTest checks the side, not just
          // the heading, because a heading that is consistent with a lane can
          // still be consistent with the WRONG lane.
          laneIndex.set(laneKey(axis, k, fi), lanes.length);
          lanes.push({ axis, across, dir: laneDirForIndex(axis, fi), span, fi, k });
        }
      }
    }
    /*
     * ── AND TWO OF THEM GO UNDER ───────────────────────────────────────────────
     *
     * The tunnel is not a separate road. It IS this street, for four hundred
     * metres, and the lanes that fall inside its carriageway should follow it
     * down rather than being hidden over the hole.
     *
     * `dip` is the whole feature: a lane that already has a height gets one
     * that varies. Everything else — the queue, the four-body fleet, the
     * colour compaction, the distance cull — is untouched, because none of it
     * ever looked at y.
     *
     * The lane stays a normal street lane in every other respect, and that is
     * deliberate: it runs the full width of the city, wraps at the edge like
     * all the others, and obeys the lights at every junction it meets ABOVE
     * ground. Only while it is actually down in the trench does it stop
     * looking for signals and turns — see `deep` in stepTraffic. Making the
     * whole lane a motorway instead would have been less code and would have
     * had the inner lanes of one street running every red light in the city.
     */
    if (underpass) {
      for (const L of lanes) {
        if (L.elevated || L.axis !== underpass.axis) continue;
        if (Math.abs(L.across - underpass.across) > underpass.half) continue;
        L.dip = underpass.yAt;
        L.dipTop = underpass.top;
      }
    }
  }
  /*
   * ── THE VIADUCT'S LANES ────────────────────────────────────────────────────
   *
   * AND THAT IS THE WHOLE FEATURE. A lane is already a straight line that wraps
   * across the city; an elevated lane is the same line with a `y` on it, so the
   * queueing, the four-body fleet, the colour compaction and the distance cull
   * all apply to the motorway without one line of new simulation.
   *
   * Two things do NOT apply, and both are absences rather than special cases:
   * a motorway has no signals, and it has no junctions to turn at. Elevated
   * lanes are also deliberately kept OUT of `laneIndex`, which is what makes
   * them unreachable as a turn target — a street car cannot turn up onto the
   * viaduct because there is no slip road, and the lane it would have to name
   * is not in the map to be named.
   *
   * `across` here is a deck lane centre, not a street fraction, so `fi` is only
   * carried for the driving-side rule — which is the same rule, because the
   * deck runs along a street axis like everything else.
   */
  /*
   * ── DESTINATION BOARDS OVER THE MOTORWAY ───────────────────────────────────
   *
   * The city's OWN gantries, pushed onto the city's own list, so they land in
   * the same InstancedMesh as every board on every street: no new geometry, no
   * new material, no new draw call, and no second atlas to keep in step with
   * the first. A gantry costs an instance, which is what that module was built
   * for.
   *
   * They face the traffic they are for, which on a two-way deck means
   * alternating: every other board is turned to the other carriageway.
   */
  if (viaduct && viaduct.params.gantries !== false && viaduct.lanePaths) {
    const dp = viaduct.path;
    const step = viaduct.params.gantrySpacing;
    let acc = step * 0.5;
    let n = 0;
    for (let i = 1; i < dp.length; i++) {
      acc += dp[i - 1].distanceTo(dp[i]);
      if (acc < step) continue;
      acc = 0;
      const a = dp[i - 1], b = dp[i];
      // The board hangs over ONE carriageway, from a mast on that side, so it
      // sits on whichever half the traffic it is addressing drives on.
      const flip = n % 2 === 0;
      const yaw = Math.atan2(b.x - a.x, b.z - a.z) + (flip ? 0 : Math.PI);
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      const off = (flip ? 1 : -1) * viaduct.params.deckWidth * 0.25;
      const gx = b.x + (-dz / L) * off, gz = b.z + (dx / L) * off;
      _p.set(gx, viaduct.deckY, gz);
      _q.setFromAxisAngle(UP, yaw);
      gantries.push({
        m: _m.compose(_p, _q, _s).clone(),
        tile: h2(n, 3, 91) * 3.999 | 0,
        axis: viaduct.axis, side: flip ? 1 : 0, travel: flip ? 1 : -1,
      });
      n++;
    }
    /*
     * AND ONE BEFORE EACH SLIP ROAD, which is the board that actually matters.
     * The evenly spaced ones say where the road goes; this one says the exit is
     * coming, at a fixed distance rather than wherever the rhythm happened to
     * land — a warning you meet by luck is not a warning.
     *
     * Every gantry panel carries a straight-on line and a turn-off line, so the
     * board reads correctly for an exit with no new artwork.
     */
    const warn = viaduct.params.gantryWarn;
    for (const rmp of viaduct.ramps ?? []) {
      const a0 = rmp.dir > 0 ? rmp.mouthMin : rmp.mouthMax;
      const a = a0 - rmp.dir * warn;
      if (a < viaduct.alongMin || a > viaduct.alongMax) continue;
      const yaw = viaduct.axis === "x"
        ? (rmp.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
        : (rmp.dir > 0 ? 0 : Math.PI);
      const off = rmp.side * viaduct.params.deckWidth * 0.25;
      _p.set(
        viaduct.axis === "x" ? a : viaduct.across + off,
        viaduct.deckY,
        viaduct.axis === "x" ? viaduct.across + off : a,
      );
      _q.setFromAxisAngle(UP, yaw);
      gantries.push({
        m: _m.compose(_p, _q, _s).clone(),
        tile: h2(n, 7, 93) * 3.999 | 0,
        axis: viaduct.axis, side: rmp.side > 0 ? 1 : 0, travel: rmp.dir,
      });
      n++;
    }
  }

  if (viaduct && F.traffic && viaduct.params.viaductTraffic !== false) {
    for (let fi = 0; fi < viaduct.laneAcross.length; fi++) {
      const lp = viaduct.lanePaths?.[fi] ?? null;
      lanes.push({
        axis: viaduct.axis,
        across: viaduct.laneAcross[fi],
        dir: laneDirForIndex(viaduct.axis, fi),
        // The lane's OWN length, not the city's width: the deck curves away at
        // both ends and runs out past the edge, so it is half a kilometre
        // longer than the grid it started on.
        span: lp ? lp.length : half * 2,
        fi,
        k: null,
        y: viaduct.deckY,
        elevated: true,
        /** The deck's centreline offset to this lane. See the note in
         *  modularRoadCityViaduct.js: a lane is a PATH once the road bends. */
        pts: lp?.pts ?? null,
        cum: lp?.cum ?? null,
        cars: viaduct.params.viaductCars,
        speedScale: viaduct.params.viaductSpeed,
      });
    }
  }

  const traffic = [];
  for (let li = 0; li < lanes.length; li++) {
    const perLane = lanes[li].cars ?? F.trafficPerLane;
    const vScale = lanes[li].speedScale ?? 1;
    for (let i = 0; i < perLane; i++) {
      const r0 = h2(li, i, 61), r1 = h2(li, i, 62), r2 = h2(li, i, 63);
      const u0 = (i + r0) / perLane;
      traffic.push({
        lane: lanes[li],
        li,
        /** Stable identity. `li` changes when the car turns; this never does,
         *  so the turn dice stay deterministic for the life of the city. */
        id: traffic.length,
        /** The turn in progress, or null. See `maybeTurn`. */
        turn: null,
        /** The junction this car has already made its mind up about. */
        turnAt: -1,
        phase: u0,
        /*
         * `u` IS STATE NOW, not a function of the clock.
         *
         * It used to be `(phase + t * speed / span) % 1` — a closed form, and a
         * car that can be stopped by a red light has no closed form. `v` is the
         * current speed and starts at cruise, so the first frame after a build
         * is traffic already moving rather than a grid pulling away together.
         */
        u: u0,
        speed: (F.trafficSpeedMin + r1 * (F.trafficSpeedMax - F.trafficSpeedMin)) * vScale,
        v: (F.trafficSpeedMin + r1 * (F.trafficSpeedMax - F.trafficSpeedMin)) * vScale,
        color: pickCarColor(r2),
        body: pickCarBody(h2(li, i, 64)),
        m: new THREE.Matrix4(),
        x: 0, z: 0,
      });
    }
  }
  /*
   * CARS IN ORDER, PER LANE — and this is what makes stopping possible at all.
   *
   * Without a leader to follow, every car in a lane brakes for the same stop
   * line and parks on top of the one in front: a red light would stack twelve
   * cars in the same three metres. Nobody overtakes, so the leader is simply
   * the next one round the ring.
   *
   * IT IS A RING, NOT A SORTED LIST, and the difference started to matter when
   * cars began turning. `u` wraps from 1 back to 0, so the array stops being
   * ascending the moment the first car laps — what is preserved is the CYCLIC
   * order, which is all `row[(i + 1) % n]` needs. A turning car leaves one ring
   * and joins another, and `insertIntoRing` puts it in the arc it actually
   * occupies rather than where a sort would have put it.
   */
  const laneCars = lanes.map(() => []);
  for (const c of traffic) laneCars[c.li].push(c);
  for (const row of laneCars) row.sort((a, b) => a.u - b.u);

  /** Forward distance from `a` to `b` around the ring, in u. */
  const fwdU = (a, b) => { const d = (b - a) % 1; return d < 0 ? d + 1 : d; };

  /**
   * Put a car into a lane's ring, in the arc it belongs to.
   *
   * NOT `sort by u`. See the note above: the array is cyclically ordered and
   * generally not ascending, so sorting it would reverse the queue of whichever
   * cars had lapped and hand half the lane a leader that is behind it.
   */
  function insertIntoRing(row, car) {
    const n = row.length;
    if (n === 0) { row.push(car); return; }
    /*
     * THE CAR IT FALLS IN BEHIND is the one with the SMALLEST forward distance
     * to it. Nothing else — no arc walk, no epsilon.
     *
     * The first version compared each arc against the offset into it, which is
     * the same answer in exact arithmetic and a different one in floating
     * point. Two cars a hundredth of a millimetre apart — which is precisely
     * what a junction produces when two streams merge — made one arc measure
     * 0.999986 instead of 0.000014, and the arriving car was filed a whole lap
     * away from where it actually was. Its follower then read a clear 2392 m
     * of road and drove straight through it. This formulation cannot express
     * that mistake: whichever of the two is behind, its forward distance is
     * the small one.
     */
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const d = fwdU(row[i].u, car.u);
      if (d < bestD) { bestD = d; best = i; }
    }
    row.splice(best + 1, 0, car);
  }

  /**
   * Is there room at `u` on this lane for one more car?
   *
   * Asked BEFORE the arc starts, not at the corner: a car that has already
   * begun to swing out and then finds nowhere to go has no good option left.
   * The margin is wider than the following gap because the car arrives across
   * the traffic rather than into the back of it.
   */
  function roomAt(row, u, span) {
    const need = (F.trafficGap * 1.6) / span;
    for (let i = 0; i < row.length; i++) {
      const d = fwdU(u, row[i].u);
      if (d < need || 1 - d < need) return false;
    }
    return true;
  }

  const trafficMat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.32, metalness: 0.45, vertexColors: true });
  trafficMat.name = "CityTraffic";
  {
    // Head and tail lamps, found by the geometry's own Z. `positionGeometry`
    // is the raw attribute and survives instancing.
    // Beyond ±2.35 there is nothing but the lamp boxes — the bevelled body
    // stops at ±2.33 — so the Z test alone separates them, and the reversed
    // smoothstep edges make it a hard cut rather than a gradient up the nose.
    // DISTANCE TOWARD THE BONNET, so neither test carries a sign of its own —
    // both follow CAR_NOSE_Z, and the lamp boxes are placed from it too.
    const gz = positionGeometry.z.mul(CAR_NOSE_Z);
    const isHead = smoothstep(LAMP_CUT, LAMP_CUT_FULL, gz);
    const isTail = smoothstep(-LAMP_CUT, -LAMP_CUT_FULL, gz);
    // Headlights burn day and night (a car with its lights off at dusk reads
    // as parked); tail lights only really register after dark.
    const lampGlow = uHead.mul(isHead).mul(mix(float(0.3), float(1.0), uNight)).mul(F.headlightBoost)
      .add(uTail.mul(isTail).mul(mix(float(0.15), float(1.0), uNight)).mul(F.taillightBoost));
    trafficMat.emissiveNode = litAdd({ vcolor: true, icolor: true }).add(lampGlow);
    applyBloomMRT(trafficMat, vec4(lampGlow, 1.0));
  }

  /*
   * ONE MESH PER BODY, and the sub-lists hold the SAME entry objects as
   * `cars` — not copies. Everything downstream that walks the parked cars
   * (the buried-in-a-building scan, the obstacle capsules, the stats) still
   * sees one list of every car, while the LOD partitions each body's list
   * independently. Copying here instead would have given the renderer and the
   * collider two versions of where the traffic is parked.
   */
  /*
   * THE CAR PARKS' CARS, into the SAME lists the street's parked cars use.
   *
   * That is the whole reason this is here rather than in the car-park module:
   * these are extra instances of the four bodies already being drawn, so a few
   * hundred more cars cost a few hundred matrices and not one more draw. A
   * separate mesh would have been tidier to write and four draws worse to run.
   */
  for (const pk of parkBays) {
    for (let i = 0; i < pk.bays.length; i++) {
      const b = pk.bays[i];
      place(cars, b.x, b.z, b.yaw, {
        color: pickCarColor(h2(Math.round(pk.x), i, 71)),
        body: pickCarBody(h2(Math.round(pk.z), i, 72)),
      });
    }
  }
  /*
   * THE PARKS' TREES AND BENCHES.
   *
   * The trees go into the SAME list the street trees use, which is the whole
   * reason this is here rather than in the park module: they become extra
   * instances of the two tree meshes the city already draws, so two hundred
   * more trees is two hundred more matrices and not one more draw.
   */
  for (const pk of parkTrees) {
    for (const t of pk.trees) {
      const green = new THREE.Color().setHSL(0.27 + (h2(Math.round(t.x), Math.round(t.z), 41) - 0.5) * 0.06,
        0.38, 0.17 + h2(Math.round(t.z), Math.round(t.x), 42) * 0.08);
      place(trees, t.x, t.z, t.yaw, { color: green.getHex(), scale: t.scale, clearance: Infinity });
    }
    for (const b of pk.benches) place(benches, b.x, b.z, b.yaw, {});
  }
  const carsByBody = CAR_BODIES.map(() => []);
  for (const e of cars) carsByBody[e.body ?? 0].push(e);
  const carMeshes = carsByBody.map((list, i) =>
    instanced(list, carGeos[i], carMat, `CityCars_${CAR_BODIES[i].name}`));
  const carMesh = carMeshes.find(Boolean) || null;
  /*
   * THE TREE, one way or the other.
   *
   * On the preset path this module draws NO trees at all — not hidden ones,
   * none — because the trees are not ours to draw. They go into v3's shared
   * TreeStore and its own renderers pick them up, which is what buys the leaf
   * LOD, the impostors and the GPU culling that a mesh built here would have to
   * reimplement (and did, badly, at 6 ms). `kinds` below already tolerates a
   * null mesh, so the distance cull simply skips them.
   *
   * `treeEnv` is the engine's; without one the preset path cannot work, so it
   * falls back to procedural rather than silently drawing nothing.
   *
   * Publishing is ASYNCHRONOUS — the preset is a JSON fetch, a leaf atlas and a
   * trunk GLB. `disposed` guards a rebuild that lands first: without it the
   * trees of a city nobody is drawing any more would be left in the store.
   */
  const usePreset = F.treeSource === "preset" && !!treeEnv;
  const trunkMesh = usePreset ? null : instanced(trees, trunkGeo, trunkMat, "CityTrunks", { shadows: false });
  const canopyMesh = usePreset ? null : instanced(trees, canopyGeo, canopyMat, "CityCanopies");
  let presetTrees = null;
  let disposed = false;
  // MUTATED IN PLACE, and returned by reference below. The stats object is
  // built once when this function returns, long before the trees land, so a
  // value assigned later would never reach a caller holding that snapshot.
  const presetTreeStats = { planted: 0, slot: -1 };
  if (usePreset && trees.length) {
    installCityPresetTrees(treeEnv, trees, { groundY: gyBase })
      .then((handle) => {
        if (disposed) { handle.dispose(); return; }
        presetTrees = handle;
        presetTreeStats.planted = handle.stats.trees;
        presetTreeStats.slot = handle.stats.slot;
      })
      .catch((e) => console.warn("[CityFurniture] preset trees failed, none planted:", e));
  }
  const lightMesh = instanced(lights, lightGeo, lightMat, "CityTrafficLights", { shadows: false });
  /*
   * The cycle position, one float per mast. A real instanced attribute rather
   * than `instanceColor`, because instanceColor is multiplied into colorNode
   * by NodeMaterial whether you want it or not — which is exactly how the old
   * lens colour ended up tinting the body instead of lighting the lens.
   */
  if (lightMesh) {
    const phases = new Float32Array(lights.length);
    for (let i = 0; i < lights.length; i++) phases[i] = lights[i].phase ?? 0;
    lightGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  }
  const railMesh = instanced(rails, railGeo, railMat, "CityRails", { shadows: false });
  /*
   * THE BOARDS CAST. Signs and gantries were both `shadows: false`, and a
   * destination board hanging over four lanes with no shadow under it is the
   * kind of wrong you feel before you can name it — reported from the game as
   * exactly that.
   *
   * It is affordable because the shadow pass here is NOT triangle bound: the
   * city's trees are 1.35 M triangles and the biggest caster on screen, and
   * removing them saved 0.00 ms of a 0.52 ms pass (measured in road.html, 2
   * cascades, `maxFar` 80). A few hundred boards are far below that floor. The
   * kinds still switched off below are the ones with nothing to cast — a flat
   * rail, a traffic light already inside its own junction's shade.
   */
  const signMesh = instanced(roadSigns, signGeo, signMat, "CityRoadSigns", { shadows: true });
  /*
   * WHICH SIGN each post shows. A real instanced attribute, and rounded in the
   * shader before it is decoded — see the note in makeRoadSignMaterial.
   */
  if (signMesh) {
    const tiles = new Float32Array(roadSigns.length);
    for (let i = 0; i < roadSigns.length; i++) tiles[i] = roadSigns[i].tile ?? 0;
    signGeo.setAttribute("aTile", new THREE.InstancedBufferAttribute(tiles, 1));
    // Any tile the project supplies replaces the drawn one, in place.
    loadRoadSignFolder(signAtlas).catch(() => {});
  }
  const ventMesh = F.steam
    ? instanced(vents, steamGeo, steam.material, "CitySteam", { shadows: false })
    : null;
  if (ventMesh) {
    const ph = new Float32Array(vents.length);
    for (let i = 0; i < vents.length; i++) ph[i] = vents[i].phase ?? 0;
    steamGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(ph, 1));
    // Transparent, so it must draw after the solid city or it blends against
    // whatever happened to be in the buffer first.
    ventMesh.renderOrder = 3;
  }
  const gantryMesh = instanced(gantries, gantryGeo, gantryMat, "CityGantry", { shadows: true });
  if (gantryMesh) {
    const gt = new Float32Array(gantries.length);
    for (let i = 0; i < gantries.length; i++) gt[i] = gantries[i].tile ?? 0;
    gantryGeo.setAttribute("aTile", new THREE.InstancedBufferAttribute(gt, 1));
    loadGantryFolder(gantryAtlas).catch(() => {});
  }
  const coneMesh = instanced(cones, coneGeo, clutterMat, "CityCones", { shadows: false });
  const barrierMesh = instanced(barriers, barrierGeo, clutterMat, "CityBarriers", { shadows: true });
  const binMesh = instanced(bins, binGeo, clutterMat, "CityBins", { shadows: true });
  const palletMesh = instanced(pallets, palletGeo, clutterMat, "CityPallets", { shadows: false });
  const blockMesh = instanced(blocks, jerseyGeo, clutterMat, "CityBlocks", { shadows: true });
  // A plate lies ON the road; it casts nothing and receives everything.
  const plateMesh = instanced(plates, plateGeo, clutterMat, "CityPlates", { shadows: false });
  const benchMesh = instanced(benches, benchGeo, clutterMat, "CityBenches", { shadows: true });
  /*
   * THE MOVING FLEET, one mesh per body.
   *
   * Each is sized for EVERY car of its body rather than for the ones expected
   * in range: `count` is rewritten each frame by updateTraffic, and a mesh
   * that runs out of capacity would silently stop drawing the cars past the
   * end. Capacity is address space, not work — an InstancedMesh costs what it
   * draws, not what it could.
   *
   * Colours are written once, in the SAME order updateTraffic fills matrices,
   * which is why each car carries `slot`: the compaction loop packs the cars
   * in range to the front, so instance i is not car i and a colour written by
   * list index would repaint the fleet every frame.
   */
  const trafficByBody = CAR_BODIES.map(() => []);
  for (const c of traffic) trafficByBody[c.body ?? 0].push(c);
  const trafficMeshes = trafficByBody.map((list, i) => {
    if (!list.length) return null;
    const im = shareInstancePipeline(new THREE.InstancedMesh(carGeos[i], trafficMat, list.length));
    im.name = `CityTraffic_${CAR_BODIES[i].name}`;
    im.frustumCulled = false;
    im.castShadow = true;
    im.receiveShadow = true;
    im.count = 0;                       // filled by the first update
    group.add(im);
    return im;
  });
  const trafficMesh = trafficMeshes.find(Boolean) || null;

  /**
   * Advance the traffic. `t` is seconds; `cam` is the camera position, so only
   * the cars near enough to see are composed and uploaded — the rest cost a
   * multiply and a compare.
   */
  const _tq = new THREE.Quaternion(), _tp = new THREE.Vector3(), _ts = new THREE.Vector3(1, 1, 1);
  /** Reused so the per-frame update allocates nothing. */
  const _trafficN = new Int32Array(CAR_BODIES.length);
  /** Where the stop line is, in metres back from the junction mouth. Taken from
   *  the STREET's own numbers so the cars pull up on the paint rather than near
   *  it — a car stopped a metre past its own stop line is the one error in this
   *  whole model anybody would notice. */
  const _streetP = { ...STREET_DEFAULTS, ...(P?.streetParams || {}) };
  const STOP_AT = _streetP.crossInset + _streetP.stopOffset;
  let _lastT = null;
  /**
   * Turns are APPLIED AFTER every lane has stepped, never during.
   *
   * A transfer splices two of the very arrays `stepTraffic` is iterating, and
   * it can move a car into a lane that has not stepped yet — which would step
   * it twice in one frame, at two different speeds, with a leader it had not
   * had when it braked. Collecting them costs an array and removes the whole
   * class of problem.
   */
  const _pendingTurns = [];

  /**
   * ── DECIDE A TURN, once per car per junction ───────────────────────────────
   *
   * Called while the car is still in the block, `trafficTurnLook` metres out.
   * Everything here is derived from the lane table (`lanePairFor`, `turnTo`)
   * rather than tabulated again — this file has twice shipped a hand-written
   * table that disagreed with the one the cars actually drive on.
   *
   * THE CORNER is where the two lane centre-lines cross. That is this lane's
   * `across` on one axis and the target lane's `across` on the other, and it
   * needs no junction geometry at all: the target lane's across IS a coordinate
   * on the axis this car is travelling along.
   */
  function maybeTurn(c, L, jAlong, acrossIdx, worldAlong, sLocal) {
    // TOO FAR TO CARE, in two subtractions and before anything is looked up.
    // The corner is at least the junction's near edge away, so a car further
    // out than the look-ahead cannot be deciding anything yet — which is the
    // case almost every car is in almost every frame.
    if ((L.dir > 0 ? blockW - sLocal : sLocal) > F.trafficTurnLook) return;
    const jKey = jAlong * 8192 + acrossIdx;
    if (c.turnAt === jKey) return;
    // ONE HAND PER LANE. The kerb-most lane turns right, the median-most turns
    // left. Anything else cuts across a lane of its own street on the way out.
    const pair = lanePairFor(L.axis, L.dir);
    const hand = L.fi === pair[0] ? 1 : -1;
    const to = turnTo(L.axis, L.dir, hand);
    const tPair = lanePairFor(to.axis, to.dir);
    // Into the matching lane of the new street: kerb-most from a right turn,
    // median-most from a left. Both are the shortest path across the box, and
    // both are where a real driver ends up.
    const tLi = laneIndex.get(laneKey(to.axis, jAlong, hand === 1 ? tPair[0] : tPair[1]));
    if (tLi === undefined) return;          // the city ends here — carry on straight
    const target = lanes[tLi];
    // AND YOU CANNOT TURN INTO A HOLE. Every junction over the tunnel is
    // roofed, so a car on the cross street sits directly above a lane that is
    // six metres down; without this it would turn into it and fall through the
    // roof of its own city.
    if (target.dip && target.dipTop - target.dip(L.across) > 0.5) return;
    const toCorner = (target.across - worldAlong) * L.dir;
    if (toCorner > F.trafficTurnLook || toCorner < F.trafficTurnRadius) return;
    c.turnAt = jKey;
    if (h2(c.id, jKey, 77) >= F.trafficTurnChance) return;
    const uEnter0 = (L.across * to.dir + half) / target.span;
    const uEnter = uEnter0 - Math.floor(uEnter0);
    if (!roomAt(laneCars[tLi], uEnter, target.span)) return;
    c.turn = {
      li: tLi,
      r: F.trafficTurnRadius,
      crossed: false,
      /** The corner, in world XZ. */
      cx: L.axis === "z" ? L.across : target.across,
      cz: L.axis === "z" ? target.across : L.across,
      /** Unit heading in, and out. */
      fx: L.axis === "z" ? 0 : L.dir, fz: L.axis === "z" ? L.dir : 0,
      tx: to.axis === "z" ? 0 : to.dir, tz: to.axis === "z" ? to.dir : 0,
      /** The corner's coordinate on the axis the car is on RIGHT NOW; rewritten
       *  to the new axis at the transfer, so one expression measures progress
       *  through the turn on both halves of it. */
      cornerAlong: target.across,
      /** ...which on the far side is this lane's across. */
      enterAlong: L.across,
      /** Where on the target lane it will arrive — re-checked every frame. */
      uEnter,
    };
  }

  /** Move a car onto the street it turned into, at the corner. */
  function applyTurn(c) {
    const T = c.turn;
    if (!T || T.crossed) return;
    const old = laneCars[c.li];
    const at = old.indexOf(c);
    if (at >= 0) old.splice(at, 1);
    const L2 = lanes[T.li];
    c.lane = L2;
    c.li = T.li;
    const u = (T.enterAlong * L2.dir + half) / L2.span;
    c.u = u - Math.floor(u);
    insertIntoRing(laneCars[T.li], c);
    T.cornerAlong = T.enterAlong;
    T.crossed = true;
  }

  /**
   * ── ONE STEP OF THE TRAFFIC ────────────────────────────────────────────────
   *
   * Every car picks the LOWEST speed three constraints allow: its own cruise,
   * what the car in front leaves room for, and what the signal ahead permits.
   * Then it ramps toward that rather than snapping, because a city where the
   * traffic changes speed instantly reads as a puppet show.
   *
   * `sqrt(2 a d)` is the whole braking model: the fastest you can be going and
   * still stop in `d` metres at `a`. It has the property that matters here —
   * far from the line it returns a speed above cruise, so braking simply does
   * not begin until it needs to, with no threshold to tune.
   */
  function stepTraffic(t, dt) {
    if (dt <= 0) return;
    for (let li = 0; li < laneCars.length; li++) {
      const row = laneCars[li];
      const n = row.length;
      if (!n) continue;
      const L = lanes[li];
      const span = L.span;
      const originAlong = L.axis === "z" ? oz : ox;
      const originAcross = L.axis === "z" ? ox : oz;
      // The lane's own block index across the street; the junction's index
      // ALONG it changes as the car travels, so that one is per car.
      const acrossIdx = Math.floor((L.across - originAcross) / pitch);
      for (let i = 0; i < n; i++) {
        const c = row[i];
        let vMax = c.speed;
        /*
         * WHY it slowed, recorded as it happens. One field, set where the
         * decision is made — so a test can ask the model what it did instead
         * of re-deriving the junction arithmetic and checking its own copy.
         * That copy is the thing this file has got wrong more than once.
         */
        c.hold = 0;

        // ── The car in front. `row` is ordered and nobody overtakes, so the
        // leader is simply the next one round.
        const lead = row[(i + 1) % n];
        let gapU = lead.u - c.u;
        if (gapU <= 0) gapU += 1;
        const gap = gapU * span - F.trafficGap;
        const gv = 2 * F.trafficDecel * (gap > 0 ? gap : 0);
        if (gv < vMax * vMax) { vMax = Math.sqrt(gv); c.hold = 1; }   // the car in front
        // AND NEVER FURTHER THAN THE GAP ITSELF IN ONE STEP. The curve above
        // is smooth but discrete: it can hand back a speed that carries the
        // car past the thing it was braking for, in one frame.
        const gcap = gap / dt;
        if (gcap < vMax) { vMax = gcap > 0 ? gcap : 0; c.hold = 1; }

        // ── The signal ahead. `sLocal` is where this car sits in the repeating
        // block+junction cell; the junction band is [blockW, pitch).
        const worldAlong = (-half + c.u * span) * L.dir;
        const rel = worldAlong - originAlong;
        const cell = Math.floor(rel / pitch);
        const sLocal = rel - cell * pitch;
        // Inside the junction there is nothing left to obey — a car that stops
        // in the box is worse than one that runs an amber.
        // A motorway has no signals and no junctions. Both are absences, not
        // special cases: skip the block and the elevated lane simply never
        // finds anything to stop for or turn into.
        /*
         * DOWN IN THE TRENCH THERE IS NOTHING TO OBEY. The junctions this lane
         * passes under are real, and the lights on them are real, and they are
         * six metres above the roof — a car in the tunnel that stopped for one
         * would be stopping for a road it cannot reach. Half a metre of depth
         * is the threshold, which keeps the shallow ends of the ramps (where
         * the road IS the street) behaving like street.
         */
        const dipY = L.dip ? L.dip(worldAlong) : null;
        const deep = dipY !== null && L.dipTop - dipY > 0.5;
        if (!L.elevated && !deep && sLocal < blockW) {
          // Which junction it is: ahead in the direction of travel, so the one
          // BELOW this cell when travelling backwards along the axis.
          const jAlong = L.dir > 0 ? cell : cell - 1;
          const dist = L.dir > 0 ? (blockW - STOP_AT) - sLocal : sLocal - STOP_AT;
          if (dist > 0) {
            const kx = L.axis === "z" ? acrossIdx : jAlong;
            const kz = L.axis === "z" ? jAlong : acrossIdx;
            if (!signalGo(t, signalPhaseAt(L.axis, kx, kz), F)) {
              const sv = 2 * F.trafficDecel * dist;
              if (sv < vMax * vMax) { vMax = Math.sqrt(sv); c.hold = 2; }  // a red light
              /*
               * AND IT MAY NOT CROSS THE LINE. This is the difference between
               * a model that stops at lights and one that only appears to.
               *
               * Braking in discrete steps lands the car a centimetre or two
               * PAST `dist = 0` — and one centimetre past, the test above
               * stops applying, the car finds nothing holding it and pulls
               * away through the red. MEASURED: 57% of the time a car was
               * stopped, nothing was holding it, which is that. Capping the
               * step at the distance remaining makes overshoot impossible, so
               * `dist` stays positive and the red keeps binding until it is
               * not red any more.
               */
              const cap = dist / dt;
              if (cap < vMax) { vMax = cap; c.hold = 2; }
            }
          }
          // A car only reaches the junction on a green — the constraint above
          // is what stops it otherwise — so turning needs no light of its own.
          if (F.trafficTurns && !c.turn) maybeTurn(c, L, jAlong, acrossIdx, worldAlong, sLocal);
        }

        // ── Ramp. Braking is allowed to be harder than pulling away, which is
        // both true of cars and what keeps a queue from concertina-ing.
        const v0 = c.v;
        const dv = vMax - c.v;
        const lim = dv > 0 ? F.trafficAccel * dt : F.trafficDecel * 1.6 * dt;
        c.v += dv > lim ? lim : (dv < -lim ? -lim : dv);
        if (c.v < 0) c.v = 0;
        /*
         * Pulling away, or standing still? A car that is slow with nothing
         * holding it is one that has just been let go by a green — a real
         * state, and the only one that can look like "stopped for no reason".
         * Recording it is what lets a test tell the two apart instead of
         * having to tolerate a percentage.
         */
        c.rising = c.v > v0 ? 1 : 0;
        c.u += (c.v * dt) / span;
        if (c.u >= 1) c.u -= 1;

        // ── Through the corner. One signed distance, measured along whichever
        // lane the car is on, negative before the corner and positive after.
        if (c.turn) {
          const T = c.turn;
          const s = ((-half + c.u * span) * L.dir - T.cornerAlong) * L.dir;
          if (T.crossed) {
            if (s > T.r) c.turn = null;
          } else if (s >= 0) {
            _pendingTurns.push(c);
          } else if (s < -T.r) {
            /*
             * THE GAP ON THE OTHER STREET IS NOT A FACT, IT IS A MOVING TARGET.
             *
             * Checking it once, at the decision, was wrong: the approach takes
             * a couple of seconds and the traffic being merged into covers 20
             * m in that time — more than the margin the check asks for. So a
             * car could pass the test and still arrive on top of somebody, and
             * MEASURED it did, three centimetres behind another car, within
             * the first two seconds of the simulation.
             *
             * So it is asked again every frame, and the turn is abandoned
             * while there is still room to abandon it: `s < -r` means the arc
             * has not started bending yet, so cancelling here is invisible.
             * `turnAt` is already set, so a cancelled car will not re-roll at
             * this junction — it simply carries straight on.
             */
            if (!roomAt(laneCars[T.li], T.uEnter, lanes[T.li].span)) c.turn = null;
          }
        }
      }
    }
    for (let i = 0; i < _pendingTurns.length; i++) applyTurn(_pendingTurns[i]);
    _pendingTurns.length = 0;
  }

  function updateTraffic(t, cam) {
    // The signals ride the same clock; it is already here every frame.
    uSignalTime.value = t;
    if (!trafficMesh) return;
    const r2 = F.trafficRange * F.trafficRange;
    // One write cursor per body. The cars in range are packed to the front of
    // their own mesh, so a body with nothing near the camera draws nothing.
    /*
     * CLAMPED, and the clamp is load-bearing. A tab left in the background
     * hands back a dt of many seconds, and an unclamped step would teleport
     * every car through the junction it was waiting at — signals, queue and
     * all — in one frame.
     */
    const dt = _lastT == null ? 0 : Math.min(0.1, Math.max(0, t - _lastT));
    _lastT = t;
    stepTraffic(t, dt);

    const n = _trafficN.fill(0);
    for (let i = 0; i < traffic.length; i++) {
      const c = traffic[i];
      const L = c.lane;
      let x, z, pathY = null, pathFwdX = 0, pathFwdZ = 0;
      if (L.pts) {
        /*
         * A LANE THAT BENDS. `u` is still the same 0..1 the queueing model
         * moves; here it is read as distance along the lane's own polyline
         * rather than as a coordinate on an axis. A lane running the other way
         * walks the same polyline backwards, so one set of points serves both
         * carriageways and the two can never drift apart.
         */
        const s = (L.dir > 0 ? c.u : 1 - c.u) * L.span;
        const cum = L.cum, pts = L.pts;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi - 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
        const seg = Math.max(1e-6, cum[hi] - cum[lo]);
        const t = Math.min(1, Math.max(0, (s - cum[lo]) / seg));
        const a = pts[lo], b = pts[hi];
        x = a.x + (b.x - a.x) * t;
        z = a.z + (b.z - a.z) * t;
        // FROM THE LANE, not from a constant. The deck is level over the city
        // and comes down to the ground at both ends, so a car reading a fixed
        // height drives the last four hundred metres through the air.
        pathY = a.y + (b.y - a.y) * t;
        const dx = (b.x - a.x) * L.dir, dz = (b.z - a.z) * L.dir;
        const len = Math.hypot(dx, dz) || 1;
        pathFwdX = dx / len; pathFwdZ = dz / len;
      } else {
        const along = -half + c.u * L.span;
        x = L.axis === "z" ? L.across : along * L.dir;
        z = L.axis === "z" ? along * L.dir : L.across;
        // A straight lane that happens to go underground. Same line, same
        // wrap, same queue — it just stops being flat for four hundred metres.
        if (L.dip) pathY = L.dip(L.axis === "z" ? z : x);
      }
      const dx = x - cam.x, dz = z - cam.z;
      if (dx * dx + dz * dz > r2) continue;
      /*
       * NOT OVER A HOLE IN THE STREET.
       *
       * A lane is an infinite straight line and knows nothing about the
       * underpass, so the two inner lanes of the street it runs under used to
       * pass directly over the open trench, six metres up, on a road that is
       * not there. They were hidden, which was an honest compromise and looked
       * like one — cars winking out at the portal and back in at the far end.
       *
       * Those lanes now DIVE instead (`dip`), so this is the backstop rather
       * than the answer: any lane that still has a constant height and finds
       * itself over the hole is not drawn. A lane that carries its own height
       * — elevated on the viaduct, dipped through the tunnel — is exempt,
       * because it is not on the street plane in the first place.
       */
      if (holeAt && !L.elevated && !L.dip && holeAt(x, z)) continue;
      /*
       * ── THE CORNER, DRAWN AS A CURVE ───────────────────────────────────────
       *
       * The car is logically on one lane or the other — there is no third
       * place for it to be, and inventing one would put it outside every
       * queue. So the TURN is purely how it is drawn: within `r` of the
       * corner, a quadratic Bezier from `corner - in*r` to `corner + out*r`
       * with the corner itself as the control point.
       *
       * That Bezier collapses to something with no square roots in it:
       *
       *     P(t) = corner - in*r*(1-t)^2 + out*r*t^2
       *     P'(t) ∝ in*(1-t) + out*t
       *
       * so the heading is a straight lerp between the two lane directions and
       * costs four multiplies. Which is the whole reason to accept that an arc
       * length parameterised by distance-to-corner is not quite uniform: at
       * 13 m/s through a 5.5 m corner, nobody has ever seen it.
       */
      let hx = pathFwdX, hz = pathFwdZ;
      if (c.turn) {
        const T = c.turn;
        const ax = T.crossed ? T.tx : T.fx, az = T.crossed ? T.tz : T.fz;
        const sd = (x - T.cx) * ax + (z - T.cz) * az;
        if (sd > -T.r && sd < T.r) {
          const t = (sd + T.r) / (2 * T.r), it = 1 - t;
          x = T.cx - T.fx * T.r * it * it + T.tx * T.r * t * t;
          z = T.cz - T.fz * T.r * it * it + T.tz * T.r * t * t;
          hx = T.fx * it + T.tx * t;
          hz = T.fz * it + T.tz * t;
        }
      }
      // BONNET ALONG THE DIRECTION OF TRAVEL. The model's nose is at +Z, so
      // this is the yaw that maps (0,0,+1) onto the way the car is going.
      //
      // The X pair used to be (-PI/2, +PI/2) and was exactly backwards, which
      // is why half the traffic drove trunk-first. The other half looked wrong
      // for an unrelated reason — the headlights were modelled on the boot —
      // and fixing only one of the two just moves which half looks wrong.
      // trafficHeadingTest locks the heading to the position cars move to, and
      // to which end of the model the white lamps are on.
      // A rotation about Y by `yaw` sends the model's nose, (0, 0, CAR_NOSE_Z),
      // to (sin yaw, 0, cos yaw) * CAR_NOSE_Z. Solve that for each of the four
      // travel directions rather than keeping a table that can disagree with
      // the model — which is exactly how this broke.
      const nose = CAR_NOSE_Z;
      let yaw = L.axis === "z"
        ? (L.dir * nose > 0 ? 0 : Math.PI)
        : (L.dir * nose > 0 ? Math.PI / 2 : -Math.PI / 2);
      // Mid-corner the heading is not axis-aligned, so it comes off the curve's
      // own tangent instead. Same rule as the four cases above — point the NOSE
      // along the direction of travel — just written continuously. The table is
      // left in place for the straight case precisely because it is the thing
      // that has been wrong twice and is now covered by trafficHeadingTest.
      if (hx !== 0 || hz !== 0) {
        const sg = nose > 0 ? 1 : -1;
        yaw = Math.atan2(hx * sg, hz * sg);
      }
      const bi = c.body ?? 0;
      const im = trafficMeshes[bi];
      if (!im) continue;
      const slot = n[bi];
      _tp.set(x, pathY ?? L.y ?? gyBase, z);
      _tq.setFromAxisAngle(UP, yaw);
      im.setMatrixAt(slot, _tm.compose(_tp, _tq, _ts));
      /*
       * THE COLOUR IS WRITTEN HERE, WITH THE MATRIX, and it has to be. The
       * loop compacts — instance `slot` is whichever car happened to be in
       * range, not car `i` — so a colour uploaded once at build time by list
       * index would land on a different car every frame and the fleet would
       * shimmer through its own palette as you drove.
       */
      im.setColorAt(slot, _c.set(c.color));
      n[bi]++;
    }
    for (let bi = 0; bi < trafficMeshes.length; bi++) {
      const im = trafficMeshes[bi];
      if (!im) continue;
      im.count = n[bi];
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
  }

  // ── DISTANCE CULL ──────────────────────────────────────────────────────────
  // Every kind is one mesh with `frustumCulled = false`, so without this the
  // whole city's furniture draws every frame from anywhere — measured 6.7 M
  // triangles from street level. A car 800 m away is under a pixel. So, on
  // the city's LOD timer, each list is partitioned near-first and `count` is
  // cut at the kind's range. A partial sort of ~7k items at 5 Hz is nothing;
  // the re-upload is ~0.4 MB per kind per tick.
  // `casts`: shadow casters are culled by RANGE ONLY. The shadow pass draws
  // the same InstancedMesh with the same count, so a car dropped for being
  // off-screen also loses the shadow it throws INTO the frame. See
  // modularRoadCityLodView.js. Everything else gets the frustum test too.
  /*
   * The knockable kinds: a list, its mesh, and its physics profile. What makes
   * a cone fly and a water barrier shove is MASS, in the same solver the track
   * builder's props use — see CLUTTER_PHYSICS. None is `solid` — see the note
   * at the top of modularRoadCityClutter.js.
   */
  const knockGroups = [
    { list: cones, mesh: coneMesh, profile: CLUTTER_PHYSICS.cone },
    { list: bins, mesh: binMesh, profile: CLUTTER_PHYSICS.bin },
    { list: pallets, mesh: palletMesh, profile: CLUTTER_PHYSICS.pallet },
    { list: barriers, mesh: barrierMesh, profile: CLUTTER_PHYSICS.barrier },
    /*
     * CONCRETE. 2 t against the car's 1.4 t, on high friction: a touch moves it
     * centimetres and only a real hit slides it — which is the entire difference
     * between this and the plastic barrier above, and the reason both exist.
     *
     * The trench plate is NOT here on purpose: it lies over a hole in the road
     * and is driven across. One that flew when clipped would be the most
     * obviously wrong object in the city.
     */
    { list: blocks, mesh: blockMesh, profile: CLUTTER_PHYSICS.jersey },
  ];
  const kinds = [
    // One entry per body: each has its own mesh and its own sub-list, and the
    // partition has to happen on the list the mesh actually draws.
    ...carMeshes.map((mesh, i) => ({ mesh, list: carsByBody[i], range: 420, casts: true })),
    { mesh: trunkMesh, list: trees, range: 650, casts: false },
    { mesh: canopyMesh, list: trees, range: 650, casts: true },
    // `attr`: a per-instance value that must follow its entry through the
    // partition below. See the note in applyLod — this is not optional.
    { mesh: lightMesh, list: lights, range: 380, casts: false, attr: "aPhase", key: "phase" },
    { mesh: railMesh, list: rails, range: 260, casts: false },
    // Small, low and close to the road, so they go early. A cone at 200 m is
    // three pixels and there are more of them than of anything except rails.
    { mesh: coneMesh, list: cones, range: 230, casts: false },
    { mesh: barrierMesh, list: barriers, range: 240, casts: true },
    { mesh: binMesh, list: bins, range: 190, casts: true },
    { mesh: palletMesh, list: pallets, range: 170, casts: false },
    // Concrete reads from further than a cone does — that is rather the
    // point of using it — and a plate is flat, so it goes early.
    { mesh: blockMesh, list: blocks, range: 300, casts: true },
    { mesh: plateMesh, list: plates, range: 160, casts: false },
    { mesh: benchMesh, list: benches, range: 190, casts: true },
    // Signs read from further than clutter does — that is their job.
    // Signs read from FURTHER than clutter: their whole job is to be legible
    // before you arrive, and 260 m cut them off inside a single block run.
    { mesh: signMesh, list: roadSigns, range: 340, casts: false, attr: "aTile", key: "tile" },
    // Read from much further than a kerb sign: that is the whole point of
    // hanging it over the road.
    { mesh: gantryMesh, list: gantries, range: 700, casts: false, attr: "aTile", key: "tile" },
    // Short: a plume is soft and slow, and at distance it is a grey smudge
    // over the one part of the frame that is already busiest.
    { mesh: ventMesh, list: vents, range: 210, casts: false, attr: "aPhase", key: "phase" },
  ];
  const _pos = new THREE.Vector3();
  const _tm = new THREE.Matrix4();
  /*
   * THE X/Z CACHE, AND WHY IT IS DERIVED RATHER THAN LISTED.
   *
   * Both the LOD partition below and the knockable pool test `e.x`/`e.z`, and
   * an entry that never got them reads `undefined` — so `dx * dx + dz * dz`
   * is NaN, `NaN >= r2` is FALSE, and the kind is silently never culled AND
   * never knockable. MEASURED when the clutter was first added against a
   * hand-written list: all 1456 cones drew from anywhere in a 2.4 km city and
   * not one of them could be hit, with no error anywhere.
   *
   * So the lists come from `kinds` and the knockable groups themselves. A new
   * kind cannot be forgotten here, because forgetting it would mean not
   * declaring it at all.
   */
  const cached = new Set();
  for (const list of [...kinds.map((k) => k.list), ...knockGroups.map((g) => g.list)]) {
    if (!list || cached.has(list)) continue;
    cached.add(list);
    for (const e of list) { _pos.setFromMatrixPosition(e.m); e.x = _pos.x; e.z = _pos.z; }
  }
  function applyLod(view) {
    // No preset-tree case here on purpose: those are culled and LOD'd by v3's
    // own tree renderers, which run off the engine's camera every frame.
    const cam = view.pos;
    for (const k of kinds) {
      if (!k.mesh) continue;
      const r2 = k.range * k.range;
      const cullFrustum = !k.casts;
      let n = 0;
      // Partition in place: near (and, for non-casters, in-view) instances to
      // the front. A 4 m sphere at head height covers every kind here.
      const list = k.list;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const dx = e.x - cam.x, dz = e.z - cam.z;
        // OUT OF RANGE OR OUT OF VIEW: say so, rather than leaving a stale
        // index behind. A knocked rail writes itself into `idx` every frame,
        // and an index this tick did not fill belongs to a different entry —
        // writing to it would teleport somebody else's barrier.
        if (dx * dx + dz * dz >= r2) { e.idx = -1; continue; }
        if (cullFrustum && !view.inView(e.x, gyBase + 2.5, e.z, 4.0)) { e.idx = -1; continue; }
        if (i !== n) { const t = list[n]; list[n] = e; list[i] = t; }
        n++;
      }
      /*
       * ── PER-INSTANCE DATA MOVES WITH ITS ENTRY ──────────────────────────
       *
       * The partition above SWAPS entries inside `list`, so instance slot `i`
       * belongs to a different object every tick. The matrix is rewritten here
       * for exactly that reason — and anything else carried per instance has
       * to be rewritten with it, or it stays in the ORIGINAL order and every
       * slot gets somebody else's value.
       *
       * MEASURED: uploaded once at build time, `aTile` put a pedestrian sign's
       * artwork on a roadworks post the moment the first LOD tick ran, and
       * `aPhase` scrambled which signals were opposed at a junction — both
       * silently, both only after the camera moved. `instanceColor` was
       * already being rewritten here for the same reason; these are the same
       * problem with a different buffer.
       */
      const attr = k.attr ? k.mesh.geometry.getAttribute(k.attr) : null;
      for (let i = 0; i < n; i++) {
        // `liveM` is a pose something else owns this frame — a knocked cone
        // being thrown. The authored matrix stays untouched underneath it.
        k.mesh.setMatrixAt(i, list[i].liveM ?? list[i].m);
        list[i].idx = i;
        if (list[i].color != null && k.mesh.instanceColor) k.mesh.setColorAt(i, _c.set(list[i].color));
        if (attr) attr.setX(i, list[i][k.key] ?? 0);
      }
      k.mesh.count = n;
      k.mesh.instanceMatrix.needsUpdate = true;
      if (k.mesh.instanceColor) k.mesh.instanceColor.needsUpdate = true;
      if (attr) attr.needsUpdate = true;
    }
  }

  /*
   * ── ROAD LETTERING ─────────────────────────────────────────────────────────
   *
   * The marking atlas has existed since the viaduct, and the viaduct was the
   * only thing using it — twelve slots and not a letter anywhere a player
   * drives. It goes on the streets here because this is where the grid
   * constants already live; deriving `pitch`/`blockW`/`ox`/`oz` a second time
   * somewhere else is how two modules end up disagreeing about where a street
   * is.
   *
   * ONE DRAW for every marking in the city, and it reuses `keepOut` and
   * `holeAt` — the same corridor and underpass predicates every other piece of
   * furniture respects, so paint cannot appear across the track or over the
   * hole.
   */
  let markings = null;
  if (F.markings !== false) {
    const marks = planStreetMarks({
      laneFracs: LANE_FRACS, laneDirForIndex,
      pitch, blockW, streetW, ox, oz, half,
      centerX: P.centerX, centerZ: P.centerZ, groundY: gy,
      keepOut, holeAt,
      every: F.markingEvery, junctionClear: F.markingJunctionClear,
    });
    markings = createRoadMarkings({ marks, name: "CityStreetMarkings" });
    if (markings) group.add(markings.mesh);
  }

  return {
    /** The street lettering, so the city can report and dispose it. */
    markings,
    /** Every placement, by kind — the obstacle table turns these into the
     *  capsules the car collides with (modularRoadCityObstacles.js). */
    lists: { cars, trees, lights, rails, cones, barriers, bins, pallets, roadSigns, gantries, vents, blocks, plates, benches },
    /** The rail mesh, so the knockables can redraw one that is in the air —
     *  `applyLod` only rewrites five times a second, which a thrown barrier
     *  cannot wait for. */
    railMesh,
    /** The knockable kinds, ready for the pool: each is a list, its mesh, and
     *  the mass that decides whether it flies or shoves. None is `solid` — see
     *  the note at the top of modularRoadCityClutter.js. */
    knockableGroups: knockGroups,
    /** The clock the signals and the traffic both run on. Exposed because
     *  "was that car stopped at a red?" cannot be answered without the time
     *  the SIM used — asking at any other time gets a different colour. */
    get trafficTime() { return _lastT ?? 0; },
    /** The moving cars themselves — `{ lane, u, v, speed }`, live. Exposed for
     *  the same reason `lanes` is: whether a car stopped at a red light is a
     *  question about state, and nothing on screen can be asked it. */
    traffic,
    /** THE LANE TABLE THE CARS ACTUALLY DRIVE. Exposed because it is the only
     *  first-hand statement in the city of which way traffic goes on which
     *  half of which street — everything else re-derives it, and re-deriving
     *  it is what has gone wrong every time. Anything that needs to agree with
     *  the traffic should be checked against this, not against a second copy
     *  of the reasoning. `{ axis, across, dir, span }`, across absolute. */
    lanes,
    /**
     * THE QUEUES THEMSELVES, one ring per lane, in cyclic order.
     *
     * Exposed because the invariant that makes red lights work — every car
     * follows the next one round, and no arrival is ever dropped on top of
     * somebody — lives here and nowhere else. It cannot be checked from the
     * rendered scene: a car spliced into the wrong arc of the ring still draws
     * in exactly the right place, it just gets a leader that is behind it.
     */
    laneCars,
    group,
    params: F,
    stats: {
      cars: cars.length, carBodies: CAR_BODIES.map((b, i) => `${b.name}:${carsByBody[i].length}`).join(" "),
      trees: trees.length, lights: lights.length, rails: rails.length,
      traffic: traffic.length, lanes: lanes.length,
      clutter: { cones: cones.length, barriers: barriers.length, bins: bins.length, pallets: pallets.length, blocks: blocks.length, plates: plates.length, benches: benches.length },
      roadSigns: roadSigns.length,
      gantries: gantries.length,
      vents: vents.length,
      /** Live — filled in when the preset trees land. `planted: 0` with
       *  treeSource "preset" means they are still loading, or failed. */
      presetTrees: presetTreeStats,
    },
    setNight(n) { uNight.value = Math.max(0, Math.min(1, n || 0)); },
    /** The night skyglow — colour and strength. */
    setGlow(hex, amount) {
      if (hex != null) uGlow.value.set(hex);
      if (amount != null) uGlowAmt.value = amount;
    },
    /** Cut each kind at its range from the camera. Call on the LOD timer. */
    applyLod,
    /** Drive the moving traffic. `t` seconds, `cam` a Vector3. Every frame. */
    updateTraffic,
    dispose() {
      disposed = true;                    // stops an in-flight preset load attaching
      // Nothing to remove from the group — preset trees live in the engine's
      // TreeStore, not here. This unplants them.
      if (presetTrees) { presetTrees.dispose(); presetTrees = null; }
      for (const m of [...carMeshes, ...trafficMeshes, trunkMesh, canopyMesh, lightMesh, railMesh,
        coneMesh, barrierMesh, binMesh, palletMesh, blockMesh, plateMesh, benchMesh, signMesh, gantryMesh, ventMesh]) { if (!m) continue; group.remove(m); m.dispose(); }
      for (const g of [...carGeos, trunkGeo, canopyGeo, lightGeo, railGeo,
        coneGeo, barrierGeo, binGeo, palletGeo, jerseyGeo, plateGeo, benchGeo, signGeo, gantryGeo, steamGeo]) g.dispose();
      for (const m of [carMat, trunkMat, canopyMat, lightMat, railMat, trafficMat, clutterMat, signMat]) m.dispose();
      signAtlas.texture.dispose();
    },
  };
}
