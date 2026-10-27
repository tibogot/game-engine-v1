// BUILDINGS LAB — the vehicle lab's scene and panel, one building at a time, AVANT / APRÈS
// (you, 2026-10-07: "pause the vehicle lab and start the buildings lab"). The game's sun,
// shadow and exposure; the building as the game draws it (the kit atlas, the French tint).
//
//   left   AVANT — the game's building (detail 1)
//   right  APRÈS — the same builder at detail 2
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { buildHelipad } from "../../v3/render/objects/rtsAlgeria.js";
import { buildRomanArch, buildRomanBlockField, buildRomanColonnade, buildRomanColumn, buildRomanOilPress, buildRomanRuin } from "../../v3/render/objects/rtsAlgVillage.js";
import { SANDSTONE_COLOURS, buildSandstoneRock, sandApron, sandstoneLook, sandstoneMaterial, setSandstoneColour } from "./algSandstone.js";
import { buildSandstoneCave } from "./algCave.js";
import { buildCampV2 } from "./algAlnCamp.js";
import { kitPhotoMaterial } from "./algKitPhoto.js";
import { FR_PAINT_TINT } from "../../v3/render/objects/rtsVehiclesFr.js";
import { buildDechraV2, buildKsarV2, buildMechtaHouseV2, buildMechtaV2, buildStoneHouse } from "./algMasonry.js";
import * as THREE from "three";
import { ATLAS_COLS, makeAuresStoneTexture, makeRubbleTexture, rtsAtlas, rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { MAT } from "../../v3/render/objects/rtsParts.js";
import { createPointMark } from "./algPointMarks.js";
import { createConstruction } from "./algConstruction.js";
import { buildFrSandbagWall } from "../../v3/render/objects/rtsAlgeria.js";
import { buildFrenchPostPiece, buildHelipadPiece, buildSandbagWallPiece, loadSandbags, loadSandbagWall } from "./algSandbags.js";
import { haystackField, loadHaystack } from "./algHaystack.js";
// (the cloth-simulated bags, loaded before any piece is built: algSandbags.js)
await loadSandbags();
await loadSandbagWall();
import { loadZeriba, zeribaMesh } from "./algZeriba.js";
import { buildPortBlock } from "./algPort.js";
import { buildZeriba } from "../../v3/render/objects/rtsAlgVillage.js";
await loadZeriba();
await loadZeriba("zeribaFarm");
import { loadMotorPool, motorPoolMesh, motorPoolStats, motorPoolStatesReady, setMotorPoolState } from "./algMotorPool.js";
import { houseMesh, houseStats, loadHouses } from "./algHouse.js";
import { loadPointWalls, pointWalls } from "./algPointFlags.js";
import { ambushScreenGeometry, armsCacheGeometry, barbedWireGeometry, fortPointGeometry, loadFortPoint, loadSearchlight, searchlightGeometry, forwardPostGeometry, loadForwardPost, aidStationGeometry, loadAidStation, markDecal, loadFrenchPost, frenchPostGeometry, loadRefuge, refugeGeometry, loadInfirmary, infirmaryGeometry, growScreenPlants, loadAmbushScreen, loadArmsCache, loadBarbedWire, loadMgNest, loadMirador, loadMortarPit, loadSangar, mgNestGeometry, mortarPitGeometry, miradorGeometry, plainGeometry, sangarGeometry, sangarStoneMaterial } from "./algSangar.js";
import { PlacedFoliage, FOLIAGE_DOME_CARDS } from "../../v3/render/foliage/placedFoliage.js";
import { buildRenderedWell, buildRubbleHeap, buildTelegraphPole } from "../../v3/render/objects/rtsAlgeria.js";
import { bagsInState, farmGeometry, loadFarmstead, loadLookout, loadMineMarker, loadSasPost, pieceInState, sasGeometry } from "./algSangar.js";
import { buildBeehives, buildBurntFarm as buildBurntFarmOld, buildFarmsteadOld, buildCemetery, buildFieldWallSegment, buildGarden, buildHaystack, buildKoubba, buildRuinedHut, buildTabouna, buildTerraces, buildThreshingFloor, buildVillageWell, buildWoodpile } from "../../v3/render/objects/rtsAlgVillage.js";
import { FIELD_WALL_TYPES, RUBBLE_TYPES, VPROP_TYPES } from "./algHouse.js";
import { loadPenProps } from "./algPenProps.js";
import { scanOutcropParts } from "./algStones.js";
import { SUN } from "./vehicleLab.js";
import { siteBags, simulatedWallMesh, loadSandbagWall as loadSimBags } from "./algSandbags.js";
import { kitView } from "./showroom.js";
import { FOLIAGE_PRESETS } from "../../v3/app/state/foliageScatterState.js";

/** Per-frame work of the lab's pieces (the screen's plants): the new lab's loop calls labTick(camera). */
const LAB_TICK = new Set();
export const labTick = (camera) => { for (const f of LAB_TICK) f(camera); };
/**
 * A piece with the ambush screen's SCRUB (the game's procedural broom and juniper — algSangar.js screenPlantSpots):
 * its own little PlacedFoliage, a child of the piece so it moves with it (spots in game metres, piece-local).
 * `keep(spot)`: which stand (the damaged screen loses its middle). Returns { group, fill(progress) }.
 */
function withScreenPlants(obj, keep = () => true, from = ambushScreenGeometry()) {   // (`from`: whose spots — the refuge's mound too)
  const g = new THREE.Group();
  g.add(obj);
  const spots = (from?.userData.screenPlants ?? []).filter(keep);
  const pf = new PlacedFoliage({ scene: g, lodDistances: [70, 140], shadowLods: 2 });
  for (const k of ["broomCut", "juniperScrub"]) pf.setType(k, structuredClone(FOLIAGE_PRESETS[k]));
  const fill = (p) => { pf.removeWhere(() => true); for (const s of spots) if (s.t <= p) pf.add(s.kind, s.x, s.y, s.z, { rotY: s.rot, scale: s.scale, seed: s.seed }); };
  fill(1);
  LAB_TICK.add((cam) => { if (g.parent) pf.update(cam); });
  return { group: g, fill };
}
/** The village test: a lane (along x) of the kit, both sides facing it; the brown houses beyond. */
function whiteVillage() {
  const g = new THREE.Group();
  g.name = "WhiteVillage";
  const types = ["maison", "cour", "haute", "boutique"];
  const north = [-44, -28, -12, 4, 20, 36], south = [-36, -20, -4, 12, 28];
  let k = 0;
  for (const [xs, z, yaw] of [[north, 14, 0], [south, -14, Math.PI]]) for (const x of xs) {
    const st = k === 4 ? "damaged" : k === 8 ? "ruin" : "intact";
    const h = houseMesh(types[(k * 3 + 1) % 4], st);
    k++;
    if (!h) continue;
    h.position.set(x, 0, z + (k % 3) * 1.2);
    h.rotation.y = yaw + ((k * 37) % 7 - 3) * 0.03;
    g.add(h);
  }
  // the farmers' and shepherds' homes: the brown houses, set apart
  for (const [x, z, yaw, seed] of [[-66, 30, 0.6, 3], [58, -34, 2.8, 11], [66, 26, -0.4, 19]]) {
    const { group } = buildMechtaHouseV2({ seed });
    group.position.set(x, 0, z); group.rotation.y = yaw;
    g.add(group);
  }
  return g;
}
/** THE M'ZAB TOWN TEST: the souk square (its arcades facing in), the town PACKED behind it — ochre houses,
 *  a few of the whitewashed kit's mixed in (the Casbah's), one damaged, one in ruins. Flat here: in the game
 *  the knoll steps them up. */
function mzabTown() {
  const g = new THREE.Group();
  g.name = "MzabTown";
  const put = (type, state, x, z, yaw) => {
    const h = houseMesh(type, state);
    if (!h) return;
    h.position.set(x, 0, z); h.rotation.y = yaw;
    g.add(h);
  };
  // the square, 32 x 24 m: two souks along its north side, one on the west, houses south and east
  put("souk", "intact", -8.5, -18.5, Math.PI); put("souk", "damaged", 8.5, -18.5, Math.PI);
  put("souk", "intact", -22.5, 0, -Math.PI / 2);
  put("dar", "intact", -9, 18, 0); put("terrasse", "intact", 3, 17, 0); put("maison", "intact", 15, 18, 0);
  put("tour", "intact", 20.5, -3, Math.PI / 2); put("dar", "ruin", 21, 8, Math.PI / 2);
  // the packed town behind the souks (north: up the knoll in the game)
  const types = ["dar", "tour", "dar", "bas", "terrasse", "tour", "haute", "dar"];
  let k = 0;
  for (const z of [-34, -45, -56]) for (let x = -34; x <= 30; x += 10.5) {
    const ty = types[(k * 5 + (z & 3)) % types.length];
    const st = k === 9 ? "damaged" : k === 15 ? "ruin" : "intact";
    put(ty, st, x + ((k * 13) % 5) * 0.4, z + ((k * 7) % 3) * 0.8, Math.PI + ((k * 37) % 5 - 2) * 0.04);
    k++;
  }
  return g;
}
/** A ready mesh / group as a lab piece: an empty geometry carrying it as its `extra`. */
function labPiece(obj) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false });
  g.userData.extra = obj ? [obj] : [];
  return g;
}

/** A kit sangar with the game's stone material (the scan's relief tiled close up — algSangar.js). */
function sangarDetailed(g) {
  g?.traverse((o) => {
    if (!o.isMesh) return;
    const m = sangarStoneMaterial(o.material);
    if (!m) return;
    o.geometry = plainGeometry(o);                   // (plain floats, real metres: the detail tiles in them)
    o.position.set(0, 0, 0); o.quaternion.identity(); o.scale.set(1, 1, 1);
    o.material = m;
  });
  return g;
}

/**
 * A sandbag piece as the game's construction site shows it (algBuild): the kit mesh (kitView, its bags as extras)
 * standing, its bags laid course by course on it (siteBags), the gun last. One lab slider drives every such piece (SAND_SITES).
 */
const SAND_SITES = [];
function sandbagSite(build) {
  const mesh = kitView(build());
  const site = siteBags(mesh);
  const set = (p) => { if (site) site.set(p); else mesh.scale.y = 0.06 + 0.94 * p; };
  SAND_SITES.push(set);
  SITE = { set: (p) => { for (const f of SAND_SITES) f(p); }, stencilShown: () => false, sock: null };
  set(1);
  return labPiece(mesh);
}

/** The Blender point and its sandbag walls (algPointFlags.pointWalls), as the game lays them. */
function pointWithWalls(kind, state) {
  const g = new THREE.Group();
  g.add(houseMesh(kind, state, 1));
  for (const [part, lx, lz, ly] of pointWalls(kind, state)) {
    const w = houseMesh(part, "intact", 1);
    if (!w) continue;
    w.position.set(lx, -0.03, lz); w.rotation.y = ly;
    g.add(w);
  }
  return g;
}

// THE SUPPLY POINT'S CAPTURE MARKS (2026-10-11, you: "add the requisition point in my building lab"; on the Blender
// point since 2026-10-25 — the old depot's entries gone): algPointMarks round the mast (dashed → filled → solid, the
// disc, the capture wave and streaks), the lab's « Piece » box sets the state, plays a capture, sizes the ring
// (ours 11 m, CoH 3's ~11 m — measured, assets-src/refs/coh3/README.md).
const POINT_KINDS = { mun: { R: 11 }, fuel: { R: 11 } };
const POINT = { game: null, neu: null, kind: null };
function pointMarks(kindKey) {
  POINT.kind = kindKey;
  const make = (r) => createPointMark({ radius: r });
  const marks = make(POINT_KINDS[kindKey].R);
  marks.group.userData.noFrame = true;   // (a ground overlay: the lab's thumbnail frames the point, not its 22 m ring)
  // A new radius: the marks rebuilt in place (their geometry is made at their radius).
  const resize = (r) => {
    const parent = marks.group.parent, next = make(r);
    parent?.remove(marks.group);
    marks.dispose();
    parent?.add(next.group);
    Object.assign(marks, next);
  };
  POINT.game = null;
  POINT.neu = { marks, flag: () => {}, resize };   // (the flag: the game's, algPointFlags — not in the lab)
  return marks.group;
}

// ?seed=: the new pieces' variant (the panel's "Variante suivante").
const SEED = Number(new URLSearchParams(location.search).get("seed")) || 0;

// THE ROMAN SITES (2026-10-08, you: "variants of that Roman ruin, it looks so nice — but don't
// change it"): each site alone (the temple, its own entry, no longer beside each one — 2026-10-25).
const roman = (label, build, gap) => ({ label, gap, before: () => build({ seed: build.seed0 + SEED }), tags: [`ROMAN SITE · variante ${SEED + 1}`], note: "a Roman site of the old Aurès, alone (its variants: « Piece »)." });
Object.assign(buildRomanColumn, { seed0: 2101 }); Object.assign(buildRomanColonnade, { seed0: 2201 }); Object.assign(buildRomanBlockField, { seed0: 2301 });
Object.assign(buildRomanArch, { seed0: 2401 }); Object.assign(buildRomanOilPress, { seed0: 2501 });

// THE SANDSTONE ROCKS (you, a CoH 3 screenshot): each shape alone — the old procedural outcrop beside them is gone
// from the game (the scanned boulders replaced it, 2026-10-24), so from here too (2026-10-25).
let _sand = null;
const rock = (label, shape, gap) => ({
  label, gap, before: () => { const g = buildSandstoneRock(shape, 1 + SEED); g.userData.labMaterial = _sand ??= sandstoneMaterial(); return g; },
  tags: [`SANDSTONE · variante ${SEED + 1}`], note: "a sandstone rock of the game (algSandstone); its look and variants: « Piece » — the formations' editor: rock-lab.html.",
});

/** The helipad's construction site (the lab's « Construction » panel). */
let SITE = null;

/** The windsock's cloth for the lab (the game's turns with the wind — algWind.js): red and white bands, filled. */
function labWindsock(g) {
  const w = g.userData.windsock, grp = new THREE.Group();
  if (!w) return grp;
  const sw = new THREE.Mesh(w.swivel, kitPhotoMaterial(FR_PAINT_TINT));
  grp.add(sw);
  const bands = 5, red = new THREE.MeshStandardMaterial({ color: 0xb8352a, roughness: 0.9 }), white = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.9 });
  for (let k = 0; k < bands; k++) {
    const r0 = w.mouthR + (w.tailR - w.mouthR) * (k / bands), r1 = w.mouthR + (w.tailR - w.mouthR) * ((k + 1) / bands), l = w.length / bands;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, l, 14, 1, true), k % 2 ? white : red);
    c.material.side = THREE.DoubleSide;
    c.rotation.z = -Math.PI / 2;
    c.position.set(w.mouth + l * (k + 0.5), -0.05 * k, 0);
    grp.add(c);
  }
  grp.position.fromArray(w.pivot);
  grp.rotation.y = 0.6;
  return grp;
}

// THE PLANTS (2026-10-25, you: "fold the plant lab into the game lab" — plant-lab.html gone): every species the game
// grows, a bed of three (sizes 1 / 0.8 / 0.65, three headings: a species judged by one plant is judged by its seed) with
// the engine's own builders and material (PlacedFoliage, FOLIAGE_PRESETS) — the plant judged here is the game's. Worst
// first (the order we worked through them). The steppe: alfa at steppe spacing, as the player sees it — a field.
const PLANT_SPECIES = [
  ["pricklyPear", "Prickly pear"], ["thistle", "Thistle"], ["asphodel", "Asphodel"], ["alfa", "Alfa grass"],
  ["agave", "Agave"], ["agaveMast", "Agave in flower"], ["broom", "Broom (genêt)"], ["oleander", "Oleander"],
  ["tamarisk", "Big tree (old)"], ["betoum", "Betoum (Atlas pistachio)"], ["tamariskTree", "Tamarisk"], ["typha", "Reed-mace"],
  ["juniperScrub", "Juniper scrub"], ["doumPalm", "Doum palm"],
];
const PLANT_PF = new Map();   // species → its bed's PlacedFoliage (the tamarisk's canopy A/B: pieceTools)
function plantField(fill, w, h, d) {
  const g = new THREE.Group();
  // (its size for the lab's framing: the instanced plants give the bounds nothing to measure — an invisible box)
  const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), new THREE.MeshBasicMaterial({ visible: false }));
  box.userData.frame = true;   // (the lab's thumbnail frames it — lab.js frameBox)
  g.add(box);
  const pf = new PlacedFoliage({ scene: g, lodDistances: [60, 140], shadowLods: 3 });
  pf.setSunDir(SUN.dir);
  fill(pf);
  LAB_TICK.add((cam) => { if (g.parent) pf.update(cam); });
  return { g, pf };
}
function plantBed(key) {
  const size = FOLIAGE_PRESETS[key].size ?? 1, k = Math.max(1, size * 1.6 / 6);   // (a big tree's three spread apart too)
  const { g, pf } = plantField((pf) => {
    pf.setType(key, structuredClone(FOLIAGE_PRESETS[key]));
    if (key === "agaveMast") pf.setType("agave", structuredClone(FOLIAGE_PRESETS.agave));
    for (const [dx, dz, s, seed] of [[0, 0, 1, 0.13], [-1.4, 1.6, 0.8, 0.47], [1.5, 1.3, 0.65, 0.81]]) {
      pf.add(key, dx * k, -0.05, dz * k, { rotY: seed * 9, scale: s, seed });
      // (as in the game, algLandmarks: a mast grows out of an agave)
      if (key === "agaveMast") pf.add("agave", dx * k - 0.2, -0.08, dz * k, { rotY: seed * 5, scale: 0.9 * s + 0.2, seed: (seed + 0.3) % 1 });
    }
  }, 2.9 * k + size, size, 1.6 * k + size);
  PLANT_PF.set(key, pf);
  return labPiece(g);
}
function steppeField() {
  let s = 7;
  const r = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
  const { g } = plantField((pf) => {
    pf.setType("alfa", structuredClone(FOLIAGE_PRESETS.alfa));
    for (let x = -12; x < 12; x += 1.6) for (let z = -8; z < 8; z += 1.6) {
      if (r() < 0.25) continue;   // gaps: a steppe, not a lawn
      pf.add("alfa", x + (r() - 0.5) * 1.44, -0.05, z + (r() - 0.5) * 1.44, { rotY: r() * 7, scale: 0.7 + r() * 0.5, seed: r() });
    }
  }, 24, 0.8, 16);
  return labPiece(g);
}

/** A haystack as the game draws it (algHaystack's field — its near or far level forced, or by the camera): a lab piece
 *  carrying an empty group the field attaches it to. */
const hayLab = haystackField();
LAB_TICK.add((camera) => hayLab.update(camera));
function haystackView(force) {
  const g = new THREE.Group();
  hayLab.add(g, 0, 0, 0, 0, 1, force);
  return labPiece(g);
}

/** The French post in a state as the game draws it: the state's model in the post's material, its bags as setPieceState
 *  leaves them (algSangar bagsInState). */
function postInState(state) {
  const g = buildFrenchPostPiece(() => pieceInState(frenchPostGeometry(), state));
  for (const m of g?.userData.extra ?? []) if (/^PostBags/.test(m.name)) bagsInState(m, state);
  return g;
}
/** A Blender piece in a state as the game draws it (kitView: its extras, its pen props), its bags as setPieceState leaves them. */
function pieceView(base, state) {
  const g = pieceInState(base, state);
  if (!g) return null;
  const m = kitView(g);
  for (const c of m.children) if (/Bags/.test(c.name)) bagsInState(c, state);
  return m;
}
const sasInState = (state) => pieceView(sasGeometry(), state);

/** The Blender motor pool in a state, as a lab piece (an empty geometry carrying it). */
function motorPoolView(state) {
  const m = motorPoolMesh(), g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false });
  if (m && state !== "intact" && !setMotorPoolState(m, state)) console.warn("[motorPool] no", state, "model");
  g.userData.extra = m ? [m] : [];
  if (m && state === "intact") console.log("[motorPool]", motorPoolStats(m));
  return g;
}

export const BUILDINGS = {
  // THE ZERIBA (2026-10-14, you: "what are these things near the villager house?"): the kit's pen LEFT, the
  // Blender one RIGHT (algZeriba.js, tools/blender/zeribaSim.py).
  // THE FARMSTEAD'S THORN PEN (2026-10-14, your screenshot: the ring of round lumps by the farm): the farm as
  // the game builds it LEFT (its pen of brush balls to the right of its yard), the Blender pen RIGHT.
  // THE ZERIBA (2026-10-25, you: "I prefer the old one … keep the old zeriba fences but make some better assets inside"):
  // the game's thorn fence, its trough and hay the Blender village props (algPenProps). The Blender branch ring
  // (zeribaSim.py, algZeriba.js) is parked — "it might be useful for another asset".
  zeriba: {
    label: "Zeriba", gap: 20, prepare: () => loadPenProps(), before: () => labPiece(kitView(buildZeriba({ seed: 81 }))),
    tags: ["ZERIBA"], note: "the flock's pen by the hamlets: the thorn fence, the Blender trough and haystack inside.",
  },
  zeribaParked: {
    label: "Thorn ring (Blender, parked)", gap: 20, prepare: () => Promise.all([loadZeriba(), loadZeriba("zeribaFarm")]),
    before: () => labPiece(zeribaMesh()), after: () => labPiece(zeribaMesh("ZeribaFarm", "zeribaFarm")),
    tags: ["THORN RING · BIG", "THORN RING · SMALL"], note: "the Blender ring of cut thorn bushes (tools/blender/zeribaSim.py) — not in the game: kept for another asset (a thorn barricade, an FLN obstacle).",
  },
  // THE SANDBAG WALL (2026-10-25, you: "we don't need the old one anymore… if it's repeating other assets that would be
  // confusing"; then "remove completely the old sandbags"): ONE entry — your cloth-simulated wall as the game builds it
  // (« Construction »: its bags laid course by course) LEFT, the simulated breached wall the game swaps in RIGHT.
  sacsDeSable: {
    label: "Sacs de sable", gap: 7.5, yaw: Math.PI - 0.5, construction: true, prepare: () => loadSimBags(),
    before: () => sandbagSite(() => buildSandbagWallPiece(() => buildFrSandbagWall())),
    after: () => labPiece(simulatedWallMesh("SandbagBreach", "breach")),
    tags: ["SANDBAGS", "SANDBAGS · DAMAGED"], note: "your simulated wall — « Construction »: laid course by course — and, right, the simulated breached wall the game swaps in when a blast hits it (algDamage).",
  },
  // THE REST OF THE SANDBAGS (2026-10-14): the kit's LEFT, the cloth-simulated RIGHT (algSandbags.js).
  // THE PORT (2026-10-16, the coast): the colonial fishing port's kit — row houses, the magasin, the
  // mole and its lighthouse, lamparo boats (algPort.js). New: nothing on the left.
  port: {
    label: "Port", gap: 60, before: () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [buildPortBlock({ seed: 1 + SEED })]; return g; },
    tags: [`FISHING PORT · variante ${SEED + 1}`], note: "le port de pêche : maisons coloniales chaulées aux toits de tuiles canal, le magasin, le môle et son phare, les lamparos.",
  },
  // THE MOTOR POOL, NEW (2026-10-18, you: "how far could we make a better looking AAA motor pool?"): the
  // game's LEFT (detail 1), the lab's kit pass MIDDLE (detail 2, the sheets), the Blender one RIGHT
  // (algMotorPool.js, tools/blender/motorPool.py). ITS STATES (2026-10-25): damaged — the shell through the roof, the
  // workshop's corner off — and destroyed: the middle truss down, two bays' roof gone, the workshop fallen in, burnt.
  parcAutoNeuf: {
    label: "Parc auto", gap: 34, yaw: Math.PI - 0.6,
    prepare: () => loadMotorPool(new URLSearchParams(location.search).get("glb") ?? undefined, { near: true }).then(motorPoolStatesReady),
    before: () => motorPoolView("intact"), middle: () => motorPoolView("damaged"), after: () => motorPoolView("ruin"),
    tags: ["MOTOR POOL · NEW", "MOTOR POOL · DAMAGED", "MOTOR POOL · DESTROYED"], note: "the motor pool as the game draws it (Blender: the steel frame, the corrugated sheets, the whitewashed workshop); damaged below half its health, destroyed when it falls.",
  },
  // THE WHITEWASHED HOUSE, PILOT (2026-10-19, you, after CoH 3's North Africa — algHouse.js,
  // tools/blender/house.py): the village house the game builds today LEFT, the new one intact in the
  // MIDDLE, damaged RIGHT; « Maison blanchie : ruine » shows the third state.
  ...Object.fromEntries(["maison", "cour", "haute", "boutique"].map((ty) => [`blanche_${ty}`, {
    label: `Maison blanchie : ${ty}`, gap: 15, yaw: Math.PI - 0.5, prepare: () => loadHouses(),
    before: () => { console.log("[houses]", houseStats()); return labPiece(houseMesh(ty, "intact")); }, middle: () => labPiece(houseMesh(ty, "damaged")), after: () => labPiece(houseMesh(ty, "ruin")),
    tags: [`${ty.toUpperCase()} · INTACTE`, `${ty.toUpperCase()} · ENDOMMAGÉE`, `${ty.toUpperCase()} · RUINE`], note: "une maison du kit blanchi (Blender) dans ses trois états : intacte, endommagée, en ruine.",
  }])),
  // THE M'ZAB TOWN HOUSES (2026-10-19, the Oued Abdi's town — tools/blender/mzab.py, algHouse.js MZAB_TYPES):
  // each type in its three states, intact LEFT, damaged MIDDLE, ruin RIGHT.
  ...Object.fromEntries(["dar", "tour", "bas", "terrasse", "souk", "mosquee", "mur"].map((ty) => [`mzab_${ty}`, {
    label: `Maison du M'zab : ${ty}`, gap: ty === "souk" || ty === "mosquee" ? 20 : 15, yaw: Math.PI - 0.5, prepare: () => loadHouses("mzab"),
    before: () => { console.log("[mzab]", houseStats()); return labPiece(houseMesh(ty, "intact")); }, middle: () => labPiece(houseMesh(ty, "damaged")), after: () => labPiece(houseMesh(ty, "ruin")),
    tags: [`${ty.toUpperCase()} · INTACTE`, `${ty.toUpperCase()} · ENDOMMAGÉE`, `${ty.toUpperCase()} · RUINE`], note: "une maison du kit du M'zab (Blender) dans ses trois états : intacte, endommagée, en ruine.",
  }])),
  villeMzab: {
    label: "Ville du M'zab", gap: 90, yaw: 0, prepare: () => Promise.all([loadHouses("mzab"), loadHouses()]),
    before: () => { const g = mzabTown(); console.log("[mzab town]", houseStats()); return labPiece(g); },
    tags: ["M'ZAB TOWN"], note: "le village blanchi à gauche, la ville du M'zab à droite : la place du souk et ses arcades, la ville serrée derrière (en jeu, la butte l'étage).",
  },
  // THE VILLAGE (2026-10-19, you: "then I guess we should see how it looks for a village"): a lane of the
  // whitewashed kit, one house damaged and one in ruins, the brown houses (the game's) on the outskirts as the
  // farmers' and shepherds' homes — the game's village beside it, LEFT.
  villageBlanc: {
    label: "Village blanchi", gap: 70, yaw: 0, prepare: () => loadHouses(),
    before: () => { const g = whiteVillage(); console.log("[village]", houseStats()); return labPiece(g); },
    tags: ["WHITEWASHED VILLAGE"], note: "le hameau du jeu à gauche, un village du kit blanchi à droite : une rue, une maison endommagée, une en ruine, les maisons brunes à l'écart (fermiers, bergers).",
  },
  // THE HELIPAD (2026-10-13, you: "add the helipad to the lab to fine-tune it" — the first base building
  // the sappers will place themselves, CoH's way): the game's on both sides until the new one exists.
  helisurface: {
    label: "Hélisurface", gap: 24, construction: true,
    // (2026-10-13: the CONSTRUCTION too — algConstruction.js: the panel's « Construction » plays it.)
    before: () => {
      const g = buildHelipadPiece((o) => buildHelipad({ detail: 2, ...o }));
      SITE = createConstruction(g, { paintTint: FR_PAINT_TINT });
      SITE.sock = labWindsock(g);
      g.userData.labMaterial = SITE.material;
      g.userData.extra = [...(g.userData.extra ?? []), SITE.sock, SITE.dressing];
      SITE.set(1);
      return g;
    },
    tags: ["HELIPAD"], note: "l'hélisurface du jeu à gauche, la nouvelle à droite : terre battue, H et cercle peints à la chaux, panneaux de signalisation, point carburant, coin radio.",
  },
  ruineRomaine: { build: (o) => buildRomanRuin({ ...o }), label: "Ruine romaine", gap: 15 },
  colonne: roman("Colonne seule", buildRomanColumn, 17),
  colonnade: roman("Colonnade", buildRomanColonnade, 26),
  voie: roman("Voie romaine", buildRomanBlockField, 24),
  arc: roman("Arc de Trajan", buildRomanArch, 24),
  pressoir: roman("Pressoir à huile", buildRomanOilPress, 19),
  rocheBanc: rock("Rocher : grand banc", "mesa", 16),
  rocheBloc: rock("Rocher : bloc", "block", 10),
  rocheDalle: rock("Rocher : dalle basse", "low", 10),
  // THE FLN CAVE (2026-10-11, you: "use the realistic rocks to make a cave"): the game's on the
  // LEFT (low-poly limestone), the sandstone cave on the RIGHT — the same shoring and gear.
  grotte: {
    label: "Grotte du FLN", gap: 11, before: () => buildSandstoneCave({ variant: SEED }),
    tags: [`FLN CAVE · variante ${SEED + 1}`], note: "la grotte du jeu à gauche, la grotte en grès à droite (même étais, même matériel).",
  },
  // THE FLN CAMP (same day, you: "it looks wrong and too cheap beside the cave"): the game's on the
  // LEFT, the sandstone and dry-stone camp on the RIGHT (algAlnCamp.js).
  // THE NEW STANDARD (2026-10-11, you: "everything but the rocks reads cheap"): the camp's stone
  // house built as the rocks are (algMasonry.js) — real thickness, rounded corners, photo materials —
  // beside the game's mechta house (the kit atlas).
  maisonPierre: {
    label: "Maison en pierre (PC)", gap: 10,
    before: () => {
      const { group } = buildStoneHouse();
      // (the lab draws a body mesh per piece: an empty one, the house its `extra`)
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false });
      g.userData.extra = [group];
      return g;
    },
    tags: ["STONE HOUSE"], note: "la maison du jeu à gauche, la maison en pierre du nouveau standard à droite.",
  },
  // THE MORTAR PIT (same day): the game's on the LEFT, the new standard's on the RIGHT.
  // THE MECHTA (2026-10-11): the lab's best kit house (detail 2) on the LEFT, the new standard RIGHT.
  mechtaPierre: {
    label: "Mechta", gap: 8,
    before: () => { const { group } = buildMechtaHouseV2({ seed: 7 + SEED }); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [group]; return g; },
    tags: [`MECHTA HOUSE · variante ${SEED + 1}`], note: "la maison du kit à gauche, la nouvelle à droite.",
  },
  // THE MECHTA IN BLENDER (2026-10-27, MECHTA_PLAN.md — tools/blender/mechta.py, algHouse MECHTA_TYPES): for the NEW
  // maps (the « Mechta » above stays the old Aurès'); each type intact LEFT, damaged MIDDLE, ruin RIGHT.
  ...Object.fromEntries([["petite", "une pièce, son échelle"], ["etage", "deux pièces, la chambre haute sur sa loggia"]].map(([ty, what]) => [`mechta_${ty}`, {
    label: `Mechta (Blender) : ${ty}`, gap: 13, yaw: Math.PI - 0.5, prepare: () => loadHouses("mechta"),
    before: () => { console.log("[mechta]", houseStats()); return labPiece(houseMesh(ty, "intact")); }, middle: () => labPiece(houseMesh(ty, "damaged")), after: () => labPiece(houseMesh(ty, "ruin")),
    tags: [`${ty.toUpperCase()} · INTACTE`, `${ty.toUpperCase()} · ENDOMMAGÉE`, `${ty.toUpperCase()} · RUINE`], note: `la maison de pierre des Aurès (Blender) — ${what} — dans ses trois états. À comparer avec « Mechta » (celle du jeu).`,
  }])),
  // THE HAMLET (same day): the game's on the LEFT, the new standard's on the RIGHT.
  hameau: {
    label: "Hameau", gap: 26, before: () => buildMechtaV2(),
    tags: ["HAMLET"], note: "le hameau du jeu à gauche, le nouveau à droite.",
  },
  dechraNouveau: {
    label: "Dechra", gap: 34, before: () => buildDechraV2(),
    tags: ["DECHRA"], note: "la dechra du jeu à gauche, la nouvelle à droite (sur terrain plat ici).",
  },
  ksarNouveau: {
    label: "Ksar", gap: 46, before: () => buildKsarV2(),
    tags: ["KSAR"], note: "le ksar du jeu à gauche, le nouveau à droite (terrain plat ici).",
  },
  // OPTION B (2026-10-11, your go): the post as the kit builds it, its colours kept, the photos'
  // grain and relief on top (algKitPhoto.js) — the game's post on the LEFT.
  // THE POST IN BLENDER (2026-10-22, tools/blender/postKit.py): the game's LEFT, the Blender one RIGHT — the same
  // layout, its gate, flag and YOUR simulated bags on both
  // THE FRENCH POST, ONE ENTRY (2026-10-25, you: "is a post asset not enough to check what is in the post?" — the
  // separate sim-bags, photo and old-kit entries gone): the Blender post as the game builds it (your simulated bags,
  // the flag's mast, the gate) LEFT, damaged MIDDLE, destroyed RIGHT.
  posteBlender: {
    label: "Poste français", gap: 46, yaw: Math.PI - 0.55, prepare: () => Promise.all([loadFrenchPost(), loadSandbagWall(), loadHouses("postkit")]),
    // (all three as the game draws them — the piece's own material, its LOD: algSangar pieceInState)
    before: () => buildFrenchPostPiece(() => { const g0 = frenchPostGeometry(), g = g0.clone(); g.userData = { ...g0.userData }; return g; }),
    middle: () => postInState("damaged"), after: () => postInState("ruin"),
    tags: ["FRENCH POST · NEW", "FRENCH POST · DAMAGED", "FRENCH POST · DESTROYED"], note: "the French post (Blender: the bordj, its towers, the gate, the barracks; your simulated sandbags) in its three states.",
  },
  campFln: {
    label: "Camp du FLN", gap: 31, before: () => buildCampV2(),
    tags: ["FLN CAMP"], note: "le camp du jeu à gauche, le camp en grès et pierre sèche à droite.",
  },
  // THE REQUISITION POINT IN BLENDER (2026-10-20, tools/blender/supplyPoint.py — you: "it doesn't look AAA at all,
  // and still my old sandbags"): the mast and the depot as one piece, the cloth-simulated bags; intact LEFT,
  // damaged MIDDLE, ruin RIGHT; the capture marks round the intact one's mast (« Piece »).
  ...Object.fromEntries([["fuel", "carburant", "FUEL"], ["mun", "munitions", "MUNITIONS"]].map(([ty, fr, en]) => [`pointBlender_${ty}`, {
    label: `Point : ${fr}`, gap: 16, yaw: 1.5 * Math.PI - 0.5,   /* (its front is +x: turned to the camera as the houses' -z) */ prepare: () => Promise.all([loadHouses("points"), loadPointWalls()]),
    before: () => { const g = pointWithWalls(ty, "intact"); g.add(pointMarks(ty)); return labPiece(g); }, middle: () => labPiece(pointWithWalls(ty, "damaged")), after: () => labPiece(pointWithWalls(ty, "ruin")),
    tags: [`${en} · INTACT`, `${en} · DAMAGED`, `${en} · DESTROYED`], note: "the requisition point (Blender: mast, depot, simulated bags) in its three states; the capture marks round the intact one (« Piece »).",
  }])),
  // THE SANGAR IN BLENDER (2026-10-21, tools/blender/sangar.py, algSangar.js): the game's old one LEFT, the new one
  // MIDDLE — its CONSTRUCTION in the panel (stone by stone, the game's own site material) — damaged RIGHT;
  // « Sangar (Blender) : états » shows intact / damaged / ruin.
  sangarBlender: {
    label: "Sangar", gap: 7, yaw: Math.PI - 0.5, construction: true, prepare: () => Promise.all([loadSangar(), loadHouses("sangar")]),
    before: () => {
      const g = sangarGeometry().clone(), site = g.userData.siteMaterial();
      g.userData = { ...g.userData, labMaterial: site.material };
      SITE = { set: site.set, stencilShown: () => false, sock: null };
      site.set(1);
      return g;
    },
    middle: () => labPiece(sangarDetailed(houseMesh("sangar", "damaged"))),
    after: () => labPiece(sangarDetailed(houseMesh("sangar", "ruin"))),
    tags: ["SANGAR · NEW", "SANGAR · DAMAGED", "SANGAR · DESTROYED"], note: "the dry-stone sangar (Blender) — « Construction »: stone by stone, as in the game — damaged, destroyed.",
  },
  // THE ARMS CACHE IN BLENDER (2026-10-21, tools/blender/armsCache.py): the game's old one LEFT, the new one MIDDLE
  // (its construction in the panel), damaged RIGHT; « Cache d'armes (Blender) : états » the three states.
  cacheBlender: {
    label: "Cache d'armes", gap: 11, yaw: Math.PI - 0.5, construction: true, prepare: () => loadArmsCache(),
    before: () => {
      const g = armsCacheGeometry().clone(), site = g.userData.siteMaterial();
      g.userData = { ...g.userData, labMaterial: site.material };
      SITE = { set: site.set, stencilShown: () => false, sock: null };
      site.set(1);
      return g;
    },
    middle: () => labPiece(sangarDetailed(houseMesh("arms", "damaged"))),
    after: () => labPiece(sangarDetailed(houseMesh("arms", "ruin"))),
    tags: ["ARMS CACHE · NEW", "ARMS CACHE · DAMAGED", "ARMS CACHE · DESTROYED"], note: "the arms cache (matmora and dry-stone gourbi, Blender) — « Construction » — damaged, destroyed.",
  },
  // THE AMBUSH SCREEN IN BLENDER (2026-10-21, tools/blender/ambushScreen.py): the game's old one LEFT, the new one
  // MIDDLE — the dry-stone footing, the scrub the engine's plants (its construction in the panel: the footing, then the
  // scrub stood up) — damaged RIGHT.
  // THE MIRADOR IN BLENDER (2026-10-21, tools/blender/mirador.py): the game's old one LEFT, the new one MIDDLE —
  // timber and corrugated iron, YOUR simulated sandbags on the deck (its construction in the panel) — damaged RIGHT.
  // THE BARBED WIRE IN BLENDER (2026-10-21, tools/blender/barbedWire.py): the game's old one LEFT, the new one MIDDLE
  // (barbed strands, the double apron, one concertina coil; its construction in the panel), cut RIGHT.
  // THE SANDBAG PIECES' CONSTRUCTION (2026-10-21): the game's own site — the kit parts rising, YOUR simulated bags laid
  // course by course (algSandbags siteBags) — the wall LEFT, the MG nest MIDDLE, the mortar pit RIGHT, one slider.
  // THE MG NEST IN BLENDER (2026-10-21, tools/blender/mgNest.py): the game's old one LEFT, the new one MIDDLE — the spoil
  // platform, the roof on posts, the AA-52, YOUR simulated ring (its construction in the panel: the earth, the posts,
  // the bags course by course, the timbers, the roof bags, the gun) — damaged RIGHT.
  // THE MORTAR PIT IN BLENDER (2026-10-21, tools/blender/mortarPit.py): the game's LEFT, the new one MIDDLE (its
  // construction in the panel: the berm, YOUR ring course by course, the stores, the mortar last), damaged RIGHT.
  mortierBlender: {
    label: "Fosse de mortier", gap: 10, yaw: Math.PI - 0.5, construction: true, prepare: () => loadMortarPit(),
    before: () => {
      const geo = mortarPitGeometry(), site = geo.userData.siteMaterial();
      const mesh = kitView(geo);
      mesh.material = site.material;
      const bags = siteBags(mesh);
      SITE = { set: (p) => { site.set(p); bags?.set(p); mesh.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — algBuild) */ for (const c of mesh.children) if (c.userData.late != null) c.visible = p >= c.userData.late; /* (its late parts: the searchlight's head — as algBuild) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      // (its 81 mm: drawn by the lab on its pivot — the lab's « Fire » lobs the game's bombs from it)
      const g = labPiece(mesh); g.userData.gun = geo.userData.gun;
      return g;
    },
    middle: () => labPiece(houseMesh("mortar", "damaged")),
    after: () => labPiece(houseMesh("mortar", "ruin")),
    tags: ["MORTAR PIT · NEW", "MORTAR PIT · DAMAGED", "MORTAR PIT · DESTROYED"], note: "the mortar pit (Blender: berm, stores, stakes, the 81 mm; your simulated bags) — « Construction » — damaged, destroyed.",
  },
  // THE FORTIFIED POINT IN BLENDER (2026-10-21, tools/blender/fortPoint.py): the game's LEFT, the new one MIDDLE (the
  // spoil banked outside YOUR simulated walls, the stores inside; its construction in the panel), damaged RIGHT.
  fortBlender: {
    label: "Point fortifié", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadFortPoint(),
    before: () => {
      const geo = fortPointGeometry(), site = geo.userData.siteMaterial();
      const mesh = kitView(geo);
      mesh.material = site.material;
      const bags = siteBags(mesh);
      SITE = { set: (p) => { site.set(p); bags?.set(p); mesh.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — algBuild) */ for (const c of mesh.children) if (c.userData.late != null) c.visible = p >= c.userData.late; /* (its late parts: the searchlight's head — as algBuild) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(mesh);
    },
    middle: () => labPiece(houseMesh("point", "damaged")),
    after: () => labPiece(houseMesh("point", "ruin")),
    tags: ["FORTIFIED POINT · NEW", "FORTIFIED POINT · DAMAGED", "FORTIFIED POINT · DESTROYED"], note: "the fortified point (Blender: spoil against your simulated walls, crates, jerrycans, field telephone, tarp) — « Construction » — damaged, destroyed.",
  },
  // THE SEARCHLIGHT TOWER IN BLENDER (2026-10-21, tools/blender/searchlightTower.py): the game's LEFT, the new one
  // MIDDLE (the lattice, the deck, the caged ladder, the searchlight's head on its own; the generator shed and YOUR
  // simulated wall; its construction in the panel), damaged RIGHT.
  // THE FIELD POSTS IN BLENDER (2026-10-21, tools/blender/fieldPosts.py): the game's LEFT, the new one MIDDLE (its
  // construction in the panel), damaged RIGHT. The forward post: a French radio post in YOUR simulated horseshoe (the
  // old one was the US shelter of the Vietnam kit); the aid station: the army's ridge tent, the red cross.
  posteAvanceBlender: {
    label: "Poste avancé", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadForwardPost(),
    before: () => {
      const geo = forwardPostGeometry(), site = geo.userData.siteMaterial();
      const mesh = kitView(geo);
      mesh.material = site.material;
      const bags = siteBags(mesh);
      SITE = { set: (p) => { site.set(p); bags?.set(p); mesh.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — algBuild) */ for (const c of mesh.children) if (c.userData.late != null) c.visible = p >= c.userData.late; /* (its late parts: the searchlight's head — as algBuild) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(mesh);
    },
    middle: () => labPiece(houseMesh("fwdradio", "damaged")),
    after: () => labPiece(houseMesh("fwdradio", "ruin")),
    tags: ["FORWARD POST · NEW", "FORWARD POST · DAMAGED", "FORWARD POST · DESTROYED"], note: "the forward post (Blender: French radio post, tarp, hand generator, guyed mast, flag; your simulated bags) — « Construction » — damaged, destroyed.",
  },
  secoursBlender: {
    label: "Poste de secours", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadAidStation(),
    before: () => {
      const geo = aidStationGeometry(), site = geo.userData.siteMaterial();
      const mesh = kitView(geo);
      mesh.material = site.material;
      SITE = { set: (p) => { site.set(p); for (const c of mesh.children) if (c.userData.late != null) c.visible = p >= c.userData.late; }, stencilShown: () => false, sock: null };   // (the crosses go on last)
      SITE.set(1);
      return labPiece(mesh);
    },
    middle: () => { const g = new THREE.Group(); g.add(houseMesh("aidtent", "damaged"), markDecal("damaged")); return labPiece(g); },
    after: () => (() => { const g = new THREE.Group(); g.add(houseMesh("aidtent", "ruin"), markDecal("ruin")); return labPiece(g); })(),
    tags: ["AID STATION · NEW", "AID STATION · DAMAGED", "AID STATION · DESTROYED"], note: "the aid station (Blender: the army's ridge tent, the red cross, stretchers, medical chest) — « Construction » — damaged, destroyed.",
  },
  projBlender: {
    label: "Tour de projecteur", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadSearchlight(),
    before: () => {
      const geo = searchlightGeometry(), site = geo.userData.siteMaterial();
      const mesh = kitView(geo);
      mesh.material = site.material;
      const bags = siteBags(mesh);
      SITE = { set: (p) => { site.set(p); bags?.set(p); mesh.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — algBuild) */ for (const c of mesh.children) if (c.userData.late != null) c.visible = p >= c.userData.late; /* (its late parts: the searchlight's head — as algBuild) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(mesh);
    },
    middle: () => labPiece(houseMesh("sltower", "damaged")),
    after: () => labPiece(houseMesh("sltower", "ruin")),
    tags: ["SEARCHLIGHT · NEW", "SEARCHLIGHT · DAMAGED", "SEARCHLIGHT · DESTROYED"], note: "the searchlight tower (Blender: steel lattice, deck, caged ladder, the turning head; the generator shed, your simulated bags) — « Construction » — damaged, destroyed.",
  },
  nidBlender: {
    label: "Nid de MG", gap: 11, yaw: Math.PI - 0.5, construction: true, prepare: () => loadMgNest(),
    before: () => {
      const geo = mgNestGeometry(), site = geo.userData.siteMaterial();
      const mesh = kitView(geo);
      mesh.material = site.material;
      const bags = siteBags(mesh);
      SITE = { set: (p) => { site.set(p); bags?.set(p); mesh.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — algBuild) */ for (const c of mesh.children) if (c.userData.late != null) c.visible = p >= c.userData.late; /* (its late parts: the searchlight's head — as algBuild) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(mesh);
    },
    middle: () => labPiece(houseMesh("mg", "damaged")),
    after: () => labPiece(houseMesh("mg", "ruin")),
    tags: ["MG NEST · NEW", "MG NEST · DAMAGED", "MG NEST · DESTROYED"], note: "the MG nest (Blender, your simulated bags) — « Construction » — damaged, destroyed (without their bags: their states come with the damage pass).",
  },
  barbelesBlender: {
    label: "Barbelés", gap: 9, yaw: Math.PI - 0.5, construction: true, prepare: () => loadBarbedWire(),
    before: () => {
      const g = barbedWireGeometry().clone(), site = g.userData.siteMaterial();
      g.userData = { ...g.userData, labMaterial: site.material };
      SITE = { set: site.set, stencilShown: () => false, sock: null };
      site.set(1);
      return g;
    },
    middle: () => labPiece(houseMesh("barbed", "damaged")),
    after: () => labPiece(houseMesh("barbed", "ruin")),
    tags: ["BARBED WIRE · NEW", "BARBED WIRE · CUT", "BARBED WIRE · CRUSHED"], note: "the barbed wire (Blender) — « Construction » — cut (a gap), crushed (a vehicle went through).",
  },
  miradorBlender: {
    label: "Mirador", gap: 9, yaw: Math.PI - 0.5, construction: true, prepare: () => loadMirador(),
    before: () => {
      const geo = miradorGeometry(), site = geo.userData.siteMaterial();
      const m = new THREE.Mesh(geo, site.material); m.castShadow = m.receiveShadow = true;
      const bags = (geo.userData.extra ?? []).map((x) => x.clone());
      for (const b of bags) m.add(b);
      SITE = { set: (p) => { site.set(p); for (const b of bags) b.visible = p >= (b.userData.late ?? 0); }, stencilShown: () => false, sock: null };
      site.set(1);
      return labPiece(m);
    },
    middle: () => { const g = houseMesh("mirador", "damaged"); g.add(houseMesh("gear", "damaged", 1)); return labPiece(g); },
    after: () => (() => { const g = houseMesh("mirador", "ruin"); g.add(houseMesh("gear", "ruin", 1)); return labPiece(g); })(),
    tags: ["MIRADOR · NEW", "MIRADOR · DAMAGED", "MIRADOR · DESTROYED"], note: "the mirador (timber, corrugated iron, your simulated bags on the deck) — « Construction » — damaged, destroyed.",
  },
  // THE FLN'S FIELD WORKS IN BLENDER (2026-10-21, tools/blender/flnPosts.py): the game's LEFT, the new one MIDDLE (its
  // construction in the panel; the scrub the game's plants), damaged RIGHT.
  refugeBlender: {
    label: "Refuge FLN", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadRefuge(),
    before: () => {
      const geo = refugeGeometry(), site = geo.userData.siteMaterial();
      const m = new THREE.Mesh(geo, site.material); m.castShadow = m.receiveShadow = true;
      const sp = withScreenPlants(m, () => true, geo);
      SITE = { set: (p) => { site.set(p); sp.fill(p); m.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — the cloth's weave) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(sp.group);
    },
    middle: () => labPiece(withScreenPlants(houseMesh("refuge", "damaged"), () => true, refugeGeometry()).group),
    after: () => labPiece(houseMesh("refuge", "ruin")),
    tags: ["FLN REFUGE · NEW", "FLN REFUGE · DAMAGED", "FLN REFUGE · DESTROYED"], note: "the FLN refuge (Blender: the mound, the dry-stone trench, the log door; the game's scrub on the mound) — « Construction » — damaged, destroyed.",
  },
  infirmBlender: {
    label: "Infirmerie FLN", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadInfirmary(),
    before: () => {
      const geo = infirmaryGeometry(), site = geo.userData.siteMaterial();
      const m = new THREE.Mesh(geo, site.material); m.castShadow = m.receiveShadow = true;
      const sp = withScreenPlants(m, () => true, geo);
      SITE = { set: (p) => { site.set(p); sp.fill(p); m.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — the cloth's weave) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(sp.group);
    },
    middle: () => labPiece(withScreenPlants(houseMesh("infirm", "damaged"), () => true, infirmaryGeometry()).group),
    after: () => labPiece(houseMesh("infirm", "ruin")),
    tags: ["FLN INFIRMARY · NEW", "FLN INFIRMARY · DAMAGED", "FLN INFIRMARY · DESTROYED"], note: "the FLN infirmary (Blender: forked poles, patched tarp, pallets and blankets — simulated cloth) — « Construction » — damaged, destroyed.",
  },
  ecranBlender: {
    label: "Écran d'embuscade", gap: 12, yaw: Math.PI - 0.5, construction: true, prepare: () => loadAmbushScreen(),
    before: () => {
      const geo = ambushScreenGeometry(), site = geo.userData.siteMaterial();
      const m = new THREE.Mesh(geo, site.material); m.castShadow = m.receiveShadow = true;
      const sp = withScreenPlants(m);
      SITE = { set: (p) => { site.set(p); sp.fill(p); m.material = p >= 1 ? geo.userData.labMaterial : site.material; /* (finished: the game's own material — the cloth's weave) */ }, stencilShown: () => false, sock: null };
      SITE.set(1);
      return labPiece(sp.group);
    },
    middle: () => labPiece(withScreenPlants(sangarDetailed(houseMesh("ambush", "damaged")), (s) => Math.abs(s.x) > 1.2 * 1.3).group),
    after: () => labPiece(sangarDetailed(houseMesh("ambush", "ruin"))),
    tags: ["AMBUSH SCREEN · NEW", "AMBUSH SCREEN · DAMAGED", "AMBUSH SCREEN · DESTROYED"], note: "the ambush screen (dry-stone footing, the game's scrub) — « Construction » — damaged, destroyed (the scrub burnt, gone).",
  },
};
// EVERYTHING ELSE THE GAME PLACES (2026-10-25, you: "be careful with some assets not being in the lab … we need better
// organization"): the pieces the maps place that the lab never showed — the old Aurès' landmarks, its fields and
// props, the SAS post, the kits' extras — each as the game builds it (several seeds or kinds side by side where the
// game varies them). The inventory: PIECES_INVENTORY.md; tools/labCoverageTest.mjs keeps the two in step.
/** Kit geometries in a row, `step` m apart (one lab version). */
let SCANS = null;   // (the scanned boulders, loaded by their entry)
function kitRow(geos, step) {
  const g = new THREE.Group();
  geos.forEach((geo, i) => { const m = kitView(geo); m.position.x = (i - (geos.length - 1) / 2) * step; g.add(m); });
  return labPiece(g);
}
/** A Blender kit's types in a row, in one state (the missing ones skipped). */
function houseRow(types, state, step) {
  const g = new THREE.Group();
  types.forEach((ty, i) => { const h = houseMesh(ty, state); if (h) { h.position.x = (i - (types.length - 1) / 2) * step; g.add(h); } });
  return labPiece(g);
}
Object.assign(BUILDINGS, {
  // THE SAS POST IN BLENDER (2026-10-25, you: "the best looking for my AAA RTS … it shouldn't look cheap" — tools/blender/
  // sasPost.py): new (your simulated sandbagged corner, the game's), damaged, destroyed (the old one gone 2026-10-25; its well kept: renderedWell)
  sasPost: { label: "SAS post", gap: 30, yaw: -0.4, prepare: () => Promise.all([loadSasPost(), loadPenProps()]),
    before: () => labPiece(kitView(sasGeometry())), middle: () => labPiece(sasInState("damaged")), after: () => labPiece(sasInState("ruin")),
    tags: ["SAS POST · NEW", "SAS POST · DAMAGED", "SAS POST · DESTROYED"], note: "the French army's post in a village: the school and the clinic under a canal-tile roof, the veranda, the yard wall and gate, the well, the water tank, the flag's plinth, the radio mast; your simulated sandbagged corner." },
  // THE FLN'S MARKS IN BLENDER (2026-10-25, you: "very cheap … make way better" — tools/blender/flnMarks.py)
  mineMarker: { label: "Mine marker", gap: 5, yaw: Math.PI - 0.5, prepare: () => loadMineMarker(),
    before: () => labPiece(sangarDetailed(houseMesh("minemark", "intact"))), middle: () => labPiece(sangarDetailed(houseMesh("minemark", "damaged"))), after: () => labPiece(sangarDetailed(houseMesh("minemark", "ruin"))),
    tags: ["MINE MARKER · NEW", "MINE MARKER · KNOCKED OVER", "MINE MARKER · GONE OFF"], note: "where the ALN laid a mine: the turned earth, the three-stone cairn its fighters marked their own mines with, a thorn branch stuck in the mound." },
  lookout: { label: "FLN lookout", gap: 8, yaw: Math.PI - 0.5, prepare: () => loadLookout(),
    before: () => labPiece(sangarDetailed(houseMesh("lookout", "intact"))), middle: () => labPiece(sangarDetailed(houseMesh("lookout", "damaged"))), after: () => labPiece(sangarDetailed(houseMesh("lookout", "ruin"))),
    tags: ["LOOKOUT · NEW", "LOOKOUT · DAMAGED", "LOOKOUT · DESTROYED"], note: "the watcher's perch on a spur: a dry-stone parapet, a brush shade on forked poles, the goatskin water bag, the blanket, the jar." },
  koubba: { label: "Koubba", gap: 12, before: () => buildKoubba({}), tags: ["KOUBBA"], note: "the marabout's domed tomb by the villages (rtsAlgVillage buildKoubba)." },
  cemetery: { label: "Cemetery", gap: 16, before: () => buildCemetery({}), tags: ["CEMETERY"], note: "the village cemetery (rtsAlgVillage buildCemetery)." },
  villageWell: { label: "Village well (old)", gap: 6, before: () => buildVillageWell({}), tags: ["WELL (OLD)"], note: "the old procedural well by the hamlets and the dechra (the Blender well: « Village props (Blender) »)." },
  // THE FARMSTEAD IN BLENDER (2026-10-25, you: "do the farmstead" — tools/blender/farmstead.py): intact with its yard's
  // props (the village props kit on its spots, as the game), damaged, burnt (the map's burnt farm)
  farmstead: { label: "Farmstead", gap: 30, prepare: () => Promise.all([loadFarmstead(), loadPenProps()]),
    before: () => labPiece(kitView(farmGeometry())), middle: () => labPiece(pieceView(farmGeometry(), "damaged")), after: () => labPiece(pieceView(farmGeometry(), "ruin")),
    tags: ["FARMSTEAD · NEW", "FARMSTEAD · DAMAGED", "FARMSTEAD · BURNT"], note: "the Aurès' lone farm: the stone house and byre, the yard wall and gate, the thorn pen; its oven, hay, woodpile, jars and trough the village props kit. Burnt: the map's burnt farm." },
  // OLD vs NEW (2026-10-25, you: "do we still have the old farm so I can compare?"): the old kit's farm and burnt farm
  // beside the new ones — remove this entry once judged
  farmsteadCompare: { label: "Farmstead: old vs new", gap: 44, prepare: () => Promise.all([loadFarmstead(), loadPenProps()]),
    before: () => buildFarmsteadOld({ seed: 1970 }), middle: () => labPiece(kitView(farmGeometry())), after: () => buildBurntFarmOld({}),
    tags: ["FARMSTEAD (OLD)", "FARMSTEAD · NEW", "BURNT FARM (OLD)"], note: "the old procedural farm (left) and the old burnt farm (right) beside the new farmstead (middle) — its burnt state: « Farmstead »." },
  ruinedHut: { label: "Ruined hut", gap: 10, before: () => buildRuinedHut({ seed: 2010 }), middle: () => buildRuinedHut({ seed: 2013 }), after: () => buildRuinedHut({ seed: 2016 }),
    tags: ["RUINED HUT 1", "RUINED HUT 2", "RUINED HUT 3"], note: "the ruined gourbis scattered over the old Aurès (rtsAlgVillage buildRuinedHut), three of the game's seeds." },
  garden: { label: "Walled garden", gap: 22, before: () => buildGarden({ kind: "olive" }), middle: () => buildGarden({ kind: "mixed" }), after: () => buildGarden({ kind: "fig" }),
    tags: ["GARDEN · OLIVE", "GARDEN · MIXED", "GARDEN · FIG"], note: "the village gardens of the old Aurès (rtsAlgVillage buildGarden) — their trees are the game's plants, not shown here." },
  threshingFloor: { label: "Threshing floor", gap: 12, before: () => buildThreshingFloor({}), tags: ["THRESHING FLOOR"], note: "the stone threshing floor by the old villages (rtsAlgVillage buildThreshingFloor)." },
  terraces: { label: "Almond terraces", gap: 26, before: () => buildTerraces({}), tags: ["TERRACES"], note: "the almond terraces of the old Aurès (rtsAlgVillage buildTerraces) — on flat ground here, stepped up the slope in the game; the almonds are the game's plants." },
  fieldWallOld: { label: "Field wall (old)", gap: 8, before: () => kitRow([1964, 1965, 1966].map((seed) => buildFieldWallSegment({ seed })), 6), tags: ["FIELD WALLS (OLD)"], note: "the old Aurès' field wall segments (rtsAlgVillage buildFieldWallSegment), three variants." },
  fieldWallsBlender: { label: "Field walls (Blender)", gap: 16, yaw: Math.PI - 0.5, prepare: () => loadHouses("fieldwalls"),
    before: () => houseRow(FIELD_WALL_TYPES, "intact", 5), middle: () => houseRow(FIELD_WALL_TYPES, "damaged", 5), after: () => houseRow(FIELD_WALL_TYPES, "ruin", 5),
    tags: ["FIELD WALLS · INTACT", "FIELD WALLS · DAMAGED", "FIELD WALLS · DESTROYED"], note: "the dry-stone field walls of Oued Abdi and the new Aurès (tools/blender/fieldwall.py: a b c), in their three states." },
  villagePropsOld: { label: "Village props (old)", gap: 14, before: () => kitRow([buildHaystack({}), buildWoodpile({}), buildTabouna({}), buildBeehives({})], 3.5), tags: ["HAY · WOOD · OVEN · HIVES (OLD)"], note: "the old Aurès' village life props (rtsAlgVillage): haystack, woodpile, tabouna, beehives." },
  villagePropsBlender: { label: "Village props (Blender)", gap: 18, prepare: () => loadHouses("vprops"), before: () => houseRow(VPROP_TYPES, "intact", 3), tags: ["VILLAGE PROPS"], note: "the village props kit (tools/blender/villageProps.py): well, trough, jars, bench, oven, hay, wood, hives — the new Aurès and the training camp." },
  // THE HAYSTACK (2026-10-26, you: the props' hay "look really like some low poly assets, very cheap"; the straw-card one
  // "the minimum level we want for assets" — tools/blender/haystack.py, algHaystack): its near and far levels, and one by
  // the camera (orbit out past 52-66 m: the cross-fade)
  haystack: { label: "Haystack", gap: 5, yaw: Math.PI - 0.5, prepare: () => loadHaystack(),
    before: () => haystackView("near"), middle: () => haystackView("far"), after: () => haystackView(null),
    tags: ["HAYSTACK · NEAR", "HAYSTACK · FAR", "HAYSTACK · BY THE CAMERA"], note: "the straw stack round its pole: ~550 straw cards (a strand texture, alpha-tested, coverage-kept mipmaps) layered like shingles over a lumpy core, the trodden straw round its foot, branches on its top, a pitchfork; its far level ~110 bigger cards; the two dither-faded over 52-66 m; the tips in the wind." },
  renderedWell: { label: "Rendered well (old SAS post's)", gap: 4, before: () => buildRenderedWell(), tags: ["RENDERED WELL"], note: "the whitewashed well of the old SAS post (gone 2026-10-25), kept as a small asset for later: the round rendered curb, its lid, two posts and the beam, the rope and bucket." },
  telegraphPole: { label: "Telegraph pole", gap: 6, before: () => buildTelegraphPole({}), tags: ["TELEGRAPH POLE"], note: "the telegraph line's pole (rtsAlgeria buildTelegraphPole); the wires are drawn between them in the game." },
  rubbleKit: { label: "Rubble (Blender)", gap: 26, prepare: () => loadHouses("rubble"), before: () => houseRow(RUBBLE_TYPES, "intact", 5), tags: ["RUBBLE"], note: "a collapsing house's heaps and flying chunks (tools/blender/rubble.py — algTownDamage)." },
  // THE SCANNED BOULDERS (Poly Haven scans, boulders.glb — algStones scanOutcropParts): the game's outcrops and big
  // stones, at the outcrops' 3.4 m. (The sandstone formations have their own tool: rock-lab.html.)
  scannedBoulders: { label: "Scanned boulders", gap: 26, prepare: async () => { SCANS = await scanOutcropParts(3.4); },
    before: () => {
      const g = new THREE.Group();
      (SCANS ?? []).forEach((p, i) => {
        const m = new THREE.Mesh(p.geometry, p.material); m.castShadow = m.receiveShadow = true;
        if (!p.geometry.boundingBox) p.geometry.computeBoundingBox();
        const b = p.geometry.boundingBox;
        // (sunk as the game sinks them — algGame: 15 % of their height, at least 10 cm)
        m.position.set((i - ((SCANS.length - 1) / 2)) * 4.6, -Math.max(0.1, (b.max.y - b.min.y) * 0.15), 0);
        g.add(m);
      });
      return labPiece(g);
    },
    tags: ["SCANNED BOULDERS"], note: "the boulder scans (three today) the outcrops and the big loose stones use (tools/blender/scanBoulders.py → boulders.glb), at an outcrop's size." },
  rubbleHeapOld: { label: "Rubble heap (old)", gap: 8, before: () => buildRubbleHeap({}), tags: ["RUBBLE HEAP (OLD)"], note: "the old heap a shelled kit house leaves (rtsAlgeria buildRubbleHeap — algDamage)." },
});

// (the plants after the buildings: the lab's list keeps its order)
Object.assign(BUILDINGS, {
  ...Object.fromEntries(PLANT_SPECIES.filter(([k]) => FOLIAGE_PRESETS[k]).map(([k, name]) => [`plant_${k}`, {
    label: name, gap: 8, yaw: 0, before: () => plantBed(k), tags: [name.toUpperCase()], note: "the game's plant (PlacedFoliage, FOLIAGE_PRESETS): a bed of three.",
  }])),
  plantSteppe: { label: "Steppe (alfa field)", gap: 8, yaw: 0, before: () => steppeField(), tags: ["STEPPE"], note: "alfa tussocks at steppe spacing, gaps and all — the field the player sees." },
});

/**
 * STONE candidates for the atlas's rubble cell (MAT.rubble, 19 — every wall in the game): drawn
 * INTO the shared atlas live, so both houses show the same stone — a fair A/B. The lab only.
 */
const STONES = {
  actuelle: { label: "Old stone", make: makeRubbleTexture },
  aures: { label: "Aurès stone", make: makeAuresStoneTexture },
};

/** The stone drawn into the kit's atlas (MAT.rubble — every wall of the old kit): the Aurès stone, or the old one to
 *  compare (the lab's « Wall stone »). */
export async function applyLabStone(key = "aures") {
  await rtsAtlasReady();
  const atlas = rtsAtlas(), cell = atlas.image.width / ATLAS_COLS;
  const t = STONES[key].make({ size: cell });
  const i = MAT.rubble, col = i % ATLAS_COLS, row = (i / ATLAS_COLS) | 0;
  atlas.image.getContext("2d").drawImage(t.image, col * cell, row * cell);
  t.dispose();
  atlas.needsUpdate = true;
}
export const LAB_STONES = Object.fromEntries(Object.entries(STONES).map(([k, v]) => [k, v.label]));
export const labSite = () => SITE;

/**
 * A PIECE'S OWN TOOLS in the lab (2026-10-25, you: "move those few panels into the new lab, then delete
 * building-lab.html" — the old page's special panels, now the lab's « Piece » box): the variants of a seeded piece
 * (the Roman sites, the rocks…), a rock's look, the supply point's capture. `versions` the lab's shown versions (the
 * last one the new piece). Null when the piece has none. { html, bind(el), tick(dt), dispose() }
 */
export function pieceTools(key, versions) {
  const E = BUILDINGS[key];
  if (!E) return null;
  const parts = [], binds = [], ticks = [], ends = [];
  const btns = (items) => `<div class="btns">${items.join("")}</div>`;
  // VARIANTS: another seed of the new piece (the page reloads on it: ?seed=)
  if ((E.tags ?? []).some((t) => /variante/i.test(t))) {
    parts.push(`<h4>Variant ${SEED + 1}</h4>${btns([`<button class="btn" data-seed="-1">Previous</button>`, `<button class="btn" data-seed="1">Next</button>`])}`);
    binds.push((el) => el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-seed]");
      if (b) location.search = `?p=${key}&seed=${Math.max(0, SEED + Number(b.dataset.seed))}`;
    }));
  }
  // A ROCK: its top in the sides' layered stone or the cracked photo (you, 2026-10-08), its colour, the sand at its foot
  if (key.startsWith("roche")) {
    parts.push(`<h4>Rock top</h4>${btns([`<button class="btn" data-top="1">Same stone</button>`, `<button class="btn" data-top="0">Cracked</button>`])}
      <h4>Rock colour</h4>${btns(Object.entries(SANDSTONE_COLOURS).map(([k, c]) => `<button class="btn" data-col="${k}">${c.label}</button>`))}
      <h4>Sand at the foot</h4>${btns([`<button class="btn" data-apron="1">With</button>`, `<button class="btn" data-apron="0">Without</button>`])}`);
    const g = versions.at(-1)?.group, rock = g?.children[0];
    const apron = rock?.geometry ? sandApron(rock.geometry) : null;
    if (apron) { g.add(apron); ends.push(() => apron.removeFromParent()); }
    binds.push((el) => el.addEventListener("click", (e) => {
      const b = e.target.closest(".btn");
      if (!b) return;
      if (b.dataset.top) sandstoneLook.topSame.value = Number(b.dataset.top);
      if (b.dataset.col) setSandstoneColour(b.dataset.col);
      if (b.dataset.apron && apron) apron.visible = b.dataset.apron === "1";
    }));
  }
  // THE SUPPLY POINT: its state on both sides, a capture played out (3 s, then the flash), the ring's size (ours
  // 22 m / 40 m, Company of Heroes 3's ~11 m — measured, assets-src/refs/coh3/README.md)
  if (key.startsWith("pointBlender_")) {
    const both = (fn) => { for (const p of [POINT.game, POINT.neu]) if (p) fn(p); };
    let anim = null, state = { owner: null, capturer: null, progress: 0, cut: false };
    const set = (owner, capturer = owner, progress = owner ? 1 : 0, cut = false) => {
      anim = null;
      state = { owner, capturer, progress, cut };
      both((p) => { p.marks.set(state); p.flag(owner ?? (progress > 0 ? capturer : null), owner ? 1 : progress); });
    };
    const K = POINT_KINDS[POINT.kind] ?? POINT_KINDS.mun;
    const sizes = K.R > 22 ? [11, 16, 22, 30, 40] : [11, 16, 22];
    parts.push(`<h4>Point</h4>${btns([["neutral", "Neutral"], ["half", "Capture 50 %"], ["player", "Held: France"], ["enemy", "Held: FLN"], ["cut", "France, cut off"], ["capP", "▶ Capture: France"], ["capE", "▶ Capture: FLN"]].map(([k, l]) => `<button class="btn" data-pt="${k}">${l}</button>`))}
      <h4>Radius</h4>${btns(sizes.map((r) => `<button class="btn" data-r="${r}">${r} m${r === 11 ? " (CoH)" : r === K.R ? " (game)" : ""}</button>`))}`);
    binds.push((el) => el.addEventListener("click", (e) => {
      const b = e.target.closest(".btn");
      if (b?.dataset.r) { const r = Number(b.dataset.r); both((p) => p.resize(r)); both((p) => p.marks.set(state)); return; }
      const k = b?.dataset.pt;
      if (k === "neutral") set(null);
      else if (k === "half") set(null, "player", 0.5);
      else if (k === "player" || k === "enemy") set(k);
      else if (k === "cut") set("player", "player", 1, true);
      else if (k === "capP" || k === "capE") { set(null); anim = { side: k === "capP" ? "player" : "enemy", t: 0 }; }
    }));
    set(null);
    ticks.push((dt) => {
      if (anim) {
        anim.t += dt / 3;
        const k = Math.min(1, anim.t);
        both((p) => { p.marks.set({ owner: null, capturer: anim.side, progress: k }); p.flag(anim.side, k); });
        if (k >= 1) { const side = anim.side; anim = null; both((p) => { p.marks.capture(side); p.flag(side, 1); }); }
      }
      both((p) => p.marks.update(dt));
    });
  }
  // THE CANOPY FIX (B): the dome cards' no-flip switch and the baked inner shadow — the tamarisk here, nam-rts's
  // dipterocarps (the shared builder)
  if (key === "plant_tamarisk") {
    parts.push(`<h4>Canopy fix (B)</h4>${btns([`<button class="btn" data-ab="before">Before</button>`, `<button class="btn" data-ab="after">After</button>`])}`);
    const ab = (which) => {
      FOLIAGE_DOME_CARDS.value = which === "after" ? 1 : 0;
      PLANT_PF.get("tamarisk")?.setType("tamarisk", { ...structuredClone(FOLIAGE_PRESETS.tamarisk), selfOcclusion: which === "after" });
    };
    binds.push((el) => el.addEventListener("click", (e) => { const b = e.target.closest("[data-ab]"); if (b) ab(b.dataset.ab); }));
    ends.push(() => ab("after"));
  }
  if (!parts.length) return null;
  return {
    html: parts.join(""),
    bind: (el) => { for (const f of binds) f(el); },
    tick: (dt) => { for (const f of ticks) f(dt); },
    dispose: () => { for (const f of ends) f(); },
  };
}
