// BUILDINGS LAB — the vehicle lab's scene and panel, one building at a time, AVANT / APRÈS
// (you, 2026-10-07: "pause the vehicle lab and start the buildings lab"). The game's sun,
// shadow and exposure; the building as the game draws it (the kit atlas, the French tint).
//
//   left   AVANT — the game's building (detail 1)
//   right  APRÈS — the same builder at detail 2
import { buildMechtaHouse } from "../../v3/render/objects/rtsMechta.js";
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { buildHelipad, buildMotorPool, buildRockOutcrop } from "../../v3/render/objects/rtsAlgeria.js";
import { buildRomanArch, buildRomanBlockField, buildRomanColonnade, buildRomanColumn, buildRomanOilPress, buildRomanRuin } from "../../v3/render/objects/rtsAlgVillage.js";
import { SANDSTONE_COLOURS, buildSandstoneRock, sandApron, sandstoneLook, sandstoneMaterial, setSandstoneColour } from "./algSandstone.js";
import { startVehicleLab } from "./vehicleLab.js";
import { buildSandstoneCave } from "./algCave.js";
import { buildCampV2 } from "./algAlnCamp.js";
import { buildMortarPitV2 } from "./algMortarPit.js";
import { kitPhotoMaterial } from "./algKitPhoto.js";
import { FR_PAINT_TINT } from "../../v3/render/objects/rtsVehiclesFr.js";
import { buildMortarPit } from "../../v3/render/objects/rtsAlgeria.js";
import { buildDechraV2, buildKsarV2, buildMechtaHouseV2, buildMechtaV2, buildStoneHouse } from "./algMasonry.js";
import { buildDechra, buildKsar } from "../../v3/render/objects/rtsAlgVillage.js";
import { buildMechta } from "../../v3/render/objects/rtsMechta.js";
import * as THREE from "three";
import { buildAlnCamp } from "../../v3/render/objects/rtsAlnCamp.js";
import { buildCaveEntrance } from "../../v3/render/objects/rtsAlgeria.js";
import { ATLAS_COLS, makeAuresStoneTexture, makeRubbleTexture, rtsAtlas, rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { MAT } from "../../v3/render/objects/rtsParts.js";
import { buildAmmoDump, buildFuelDepot } from "../../v3/render/objects/rtsAlgeria.js";
import { createPointMark } from "./algPointMarks.js";
import { buildPointMast, pointMastMaterial } from "./algPointMast.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { drawFlnDataUrl, drawTricoloreDataUrl } from "./algFlag.js";
import { createConstruction } from "./algConstruction.js";
import { buildFrSandbagWall } from "../../v3/render/objects/rtsAlgeria.js";
import { buildFortPointPiece, buildFrenchPostPiece, buildMgNestPiece, buildSandbagWallV2, loadSandbags, loadSandbagWall } from "./algSandbags.js";
import { buildFortPoint, buildMgNest } from "../../v3/render/objects/rtsAlgeria.js";
// (the cloth-simulated bags, loaded before any piece is built: algSandbags.js)
await loadSandbags();
await loadSandbagWall();
import { loadZeriba, zeribaMesh } from "./algZeriba.js";
import { buildPortBlock } from "./algPort.js";
import { buildFarmstead, buildZeriba } from "../../v3/render/objects/rtsAlgVillage.js";
await loadZeriba();
await loadZeriba("zeribaFarm");
import { loadMotorPool, motorPoolMesh, motorPoolStats } from "./algMotorPool.js";

// THE SUPPLY POINT (2026-10-11, you: "add the requisition point in my building lab"): the GAME's
// marks on the LEFT (its thin solid ring, algUnits villageRings), the NEW ones on the RIGHT
// (algPointMarks.js: dashed → filled → solid, the disc, the capture wave and streaks); the same
// depot and flag on both. The panel's "Point" buttons set the state and play a capture.
// (2026-10-11, you: "I have different points in the game — shouldn't we place them in the lab?")
// THE GAME'S POINT KINDS (algEconomy.js, algPointFlags.js): a SUPPLY point pays munitions (crates)
// or fuel (drums), 22 m, a 5 m pole beside the depot; a VILLAGE counts for the score and pays all
// three, 40 m, a 7 m pole on open ground near its centre (a house stands for the village here).
const POINT_KINDS = {
  mun: { R: 11, pole: 5, mast: 9, cloth: [1.6, 1.07], build: () => buildAmmoDump() },
  fuel: { R: 11, pole: 5, mast: 9, cloth: [1.6, 1.07], build: () => buildFuelDepot() },
};
const POINT = { game: null, neu: null, kind: null };
function supplyPoint(which, kindKey = "mun") {
  const K = POINT_KINDS[kindKey];
  POINT.kind = kindKey;
  const geo = K.build();
  const fp = geo.userData.footprint ?? { hx: 1.5, hz: 1.5 };
  const extra = [];
  // The flag: a pole and a flat cloth that climbs with the hold (the game's waves: algPointFlags).
  // The GAME's thin pole on the left; the NEW MAST on the right (algPointMast.js: tapered, guyed, a
  // concrete footing), where the point marks are new too.
  // The GAME: its pole beside the depot (a village's on open ground off its centre). The NEW: the mast
  // AT THE CENTRE, as CoH's (the disc and the column of light round it), the depot / house moved
  // beside it (2026-10-11: at 11 m a village's pole at (-9, 7) stood on the ring).
  if (which !== "game") geo.translate(fp.hx + 2.6, 0, 0);
  const [px, pz] = which === "game" ? (K.poleAt ?? [-fp.hx - 0.4, fp.hz * 0.6]) : [0, 0];
  const H = which === "game" ? K.pole : K.mast;
  const pole = which === "game"
    ? new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, H, 8).translate(0, H / 2, 0), new THREE.MeshStandardNodeMaterial({ color: 0x5a5650, roughness: 0.6, metalness: 0.4 }))
    : new THREE.Mesh(buildPointMast({ height: H, guyR: H * 0.4, away: Math.PI }).geometry, pointMastMaterial());   // the wires away from the depot / house
  pole.position.set(px, 0, pz);
  pole.castShadow = true;
  const tex = { player: labFlagTex(drawTricoloreDataUrl(256)), enemy: labFlagTex(drawFlnDataUrl(256)) };
  const [cw, ch] = K.cloth;
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(cw, ch).translate(cw / 2, ch / 2, 0), new THREE.MeshStandardNodeMaterial({ map: tex.player, side: THREE.DoubleSide, roughness: 0.9 }));
  cloth.castShadow = true;
  pole.add(cloth);
  extra.push(pole);
  const flag = (side, hold) => {
    cloth.visible = !!side && hold > 0;
    if (side) cloth.material.map = tex[side];
    cloth.position.y = 0.5 + hold * (H - 0.15 - ch - 0.5);
  };
  let marks, resize;
  if (which === "game") {
    const ring = new THREE.Mesh(gameRingGeo(K.R), new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.55, depthWrite: false }));
    ring.position.y = 0.06;
    ring.renderOrder = RENDER_ORDER.ON_GROUND;
    extra.push(ring);
    const GAME_COL = { player: 0x58a8ff, enemy: 0xff6a5a, cut: 0xe0a040, null: 0xd8cfae };
    marks = { set: ({ owner, cut }) => ring.material.color.set(GAME_COL[cut && owner === "player" ? "cut" : owner]), capture() {}, update() {} };
    resize = (r) => { ring.geometry.dispose(); ring.geometry = gameRingGeo(r); };
  } else {
    const make = (r) => { const m = createPointMark({ radius: r }); m.group.rotation.y = 0.6; return m; };   // undo the turntable's −0.6: the fill starts at the top
    marks = make(K.R);
    extra.push(marks.group);
    // A new radius: the marks rebuilt in place (their geometry is made at their radius).
    resize = (r) => {
      const parent = marks.group.parent, next = make(r);
      parent?.remove(marks.group);
      marks.dispose();
      parent?.add(next.group);
      Object.assign(marks, next);
    };
  }
  geo.userData.extra = extra;
  POINT[which === "game" ? "game" : "neu"] = { marks, flag, resize };
  return geo;
}
const gameRingGeo = (r) => new THREE.RingGeometry(r * 0.975, r, 96).rotateX(-Math.PI / 2);
function labFlagTex(url) { const t = new THREE.TextureLoader().load(url); t.colorSpace = THREE.SRGBColorSpace; return t; }

// ?seed=: the new pieces' variant (the panel's "Variante suivante").
const SEED = Number(new URLSearchParams(location.search).get("seed")) || 0;

// THE ROMAN SITES (2026-10-08, you: "variants of that Roman ruin, it looks so nice — but don't
// change it"): the temple as it is in the game on the LEFT, the new site on the RIGHT.
const temple = () => buildRomanRuin({ seed: 1980, detail: 2 });
const roman = (label, build, gap) => ({ label, gap, before: temple, after: () => build({ seed: build.seed0 + SEED }), tags: ["TEMPLE (LE JEU)", `NOUVEAU · variante ${SEED + 1}`], note: "le temple du jeu à gauche (référence, inchangé), le nouveau site à droite." });
Object.assign(buildRomanColumn, { seed0: 2101 }); Object.assign(buildRomanColonnade, { seed0: 2201 }); Object.assign(buildRomanBlockField, { seed0: 2301 });
Object.assign(buildRomanArch, { seed0: 2401 }); Object.assign(buildRomanOilPress, { seed0: 2501 });

// THE SANDSTONE ROCKS (you, a CoH 3 screenshot): the game's outcrop on the LEFT, the new rock RIGHT.
let _sand = null;
const rock = (label, shape, gap) => ({
  label, gap, before: () => buildRockOutcrop({ seed: 2000 }),
  after: () => { const g = buildSandstoneRock(shape, 1 + SEED); g.userData.labMaterial = _sand ??= sandstoneMaterial(); return g; },
  tags: ["ROCHER (LE JEU)", `GRÈS · variante ${SEED + 1}`], note: "l'affleurement du jeu à gauche, le nouveau rocher de grès à droite.",
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

const BUILDINGS = {
  // THE ZERIBA (2026-10-14, you: "what are these things near the villager house?"): the kit's pen LEFT, the
  // Blender one RIGHT (algZeriba.js, tools/blender/zeribaSim.py).
  // THE FARMSTEAD'S THORN PEN (2026-10-14, your screenshot: the ring of round lumps by the farm): the farm as
  // the game builds it LEFT (its pen of brush balls to the right of its yard), the Blender pen RIGHT.
  enclosFerme: {
    label: "Enclos de la ferme (nouveau)", gap: 24, before: () => buildFarmstead({ seed: 1970 }),
    after: () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [zeribaMesh("ZeribaFarm", "zeribaFarm")].filter(Boolean); return g; },
    tags: ["FERME (LE JEU) — SON ENCLOS À DROITE DE LA COUR", "ENCLOS · NOUVEAU (BLENDER)"], note: "la ferme du jeu à gauche (son enclos : les boules de broussailles), le nouvel enclos d'épineux à droite.",
  },
  zeriba: {
    label: "Zeriba (nouveau)", gap: 20, before: () => buildZeriba({ seed: 81 }),
    after: () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [zeribaMesh()].filter(Boolean); return g; },
    tags: ["ZERIBA (LE JEU)", "ZERIBA · NOUVEAU (BLENDER)"], note: "l'enclos du jeu à gauche, le nouveau à droite : des buissons d'épineux coupés, empilés en cercle, la cime vers l'extérieur.",
  },
  // THE SANDBAGS (2026-10-14, you: "the sandbags look so cheap — can you do better?"): the game's wall LEFT,
  // the new one RIGHT (algSandbags.js).
  sacsDeSable: {
    label: "Sacs de sable (nouveau)", gap: 7.5, before: () => buildFrSandbagWall(),
    after: () => { const { mesh } = buildSandbagWallV2({ seed: 3 + SEED }); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [mesh]; return g; },
    tags: ["SACS DE SABLE (LE JEU)", `SACS DE SABLE · NOUVEAU · variante ${SEED + 1}`], note: "le mur du jeu à gauche, le nouveau à droite : sacs en jute, chacun sa forme et sa teinte, posés en quinconce.",
  },
  // THE REST OF THE SANDBAGS (2026-10-14): the kit's LEFT, the cloth-simulated RIGHT (algSandbags.js).
  // THE PORT (2026-10-16, the coast): the colonial fishing port's kit — row houses, the magasin, the
  // mole and its lighthouse, lamparo boats (algPort.js). New: nothing on the left.
  port: {
    label: "Port (nouveau)", gap: 60, before: () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); return g; },
    after: () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [buildPortBlock({ seed: 1 + SEED })]; return g; },
    tags: ["—", `PORT · NOUVEAU · variante ${SEED + 1}`], note: "le port de pêche : maisons coloniales chaulées aux toits de tuiles canal, le magasin, le môle et son phare, les lamparos.",
  },
  sacsNidMg: {
    label: "Nid de MG (sacs)", gap: 10, before: () => buildMgNest({}), after: () => buildMgNestPiece((o) => buildMgNest(o)),
    tags: ["NID DE MG (LE JEU)", "NID DE MG · SACS SIMULÉS"], note: "le nid du jeu à gauche, ses sacs simulés à droite (la couronne et le toit).",
  },
  sacsPointFort: {
    label: "Point fortifié (sacs)", gap: 13, before: () => buildFortPoint({}), after: () => buildFortPointPiece((o) => buildFortPoint(o)),
    tags: ["POINT FORTIFIÉ (LE JEU)", "POINT FORTIFIÉ · SACS SIMULÉS"], note: "le point fortifié du jeu à gauche, ses trois murs simulés à droite.",
  },
  sacsPoste: {
    label: "Poste (sacs)", gap: 42, before: () => buildFrenchPost({ detail: 2, footStone: MAT.limestone }), after: () => buildFrenchPostPiece((o) => buildFrenchPost({ detail: 2, footStone: MAT.limestone, ...o })),
    tags: ["POSTE (LE JEU)", "POSTE · SACS SIMULÉS"], note: "le poste du jeu à gauche, ses sacs simulés à droite : la chicane, les tours, le guetteur, le mortier.",
  },
  mechtaHouse: { build: (o) => buildMechtaHouse({ ...o }), label: "Maison (mechta)", gap: 7.5 },
  poste: { build: (o) => buildFrenchPost({ ...o }), label: "Poste français", gap: 42 },
  parcAuto: { build: (o) => buildMotorPool({ ...o }), label: "Parc auto", gap: 21 },
  // THE MOTOR POOL, NEW (2026-10-18, you: "how far could we make a better looking AAA motor pool?"): the
  // game's LEFT (detail 1), the lab's kit pass MIDDLE (detail 2, the sheets), the Blender one RIGHT
  // (algMotorPool.js, tools/blender/motorPool.py) — the evolution, three side by side.
  parcAutoNeuf: {
    label: "Parc auto (nouveau)", gap: 34, yaw: Math.PI - 0.6, prepare: () => loadMotorPool(new URLSearchParams(location.search).get("glb") ?? undefined, { near: true }), before: () => buildMotorPool({ detail: 1 }), middle: () => buildMotorPool({ detail: 2 }),
    after: () => {
      const m = motorPoolMesh(), g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false });
      g.userData.extra = m ? [m] : [];
      if (m) console.log("[motorPool]", motorPoolStats(m));
      return g;
    },
    tags: ["PARC AUTO (LE JEU)", "PARC AUTO · KIT, DÉTAIL 2", "PARC AUTO · NOUVEAU (BLENDER)"], note: "le parc auto du jeu à gauche, la passe du kit (détail 2) au milieu, le nouveau à droite : charpente acier, tôle ondulée, atelier enduit à la chaux.",
  },
  // THE HELIPAD (2026-10-13, you: "add the helipad to the lab to fine-tune it" — the first base building
  // the sappers will place themselves, CoH's way): the game's on both sides until the new one exists.
  helisurface: {
    label: "Hélisurface", gap: 24, before: () => buildHelipad(),
    // (2026-10-13: the CONSTRUCTION too — algConstruction.js: the panel's « Construction » plays it.)
    after: () => {
      const g = buildHelipad({ detail: 2 });
      SITE = createConstruction(g, { paintTint: FR_PAINT_TINT });
      SITE.sock = labWindsock(g);
      g.userData.labMaterial = SITE.material;
      g.userData.extra = [SITE.sock, SITE.dressing];
      SITE.set(1);
      return g;
    },
    tags: ["HÉLISURFACE (LE JEU)", "HÉLISURFACE · NOUVELLE"], note: "l'hélisurface du jeu à gauche, la nouvelle à droite : terre battue, H en pierres blanchies, panneaux de signalisation, point carburant.",
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
    label: "Grotte du FLN", gap: 11, before: () => buildCaveEntrance(), after: () => buildSandstoneCave({ variant: SEED }),
    tags: ["GROTTE (LE JEU)", `GRÈS · variante ${SEED + 1}`], note: "la grotte du jeu à gauche, la grotte en grès à droite (même étais, même matériel).",
  },
  // THE FLN CAMP (same day, you: "it looks wrong and too cheap beside the cave"): the game's on the
  // LEFT, the sandstone and dry-stone camp on the RIGHT (algAlnCamp.js).
  // THE NEW STANDARD (2026-10-11, you: "everything but the rocks reads cheap"): the camp's stone
  // house built as the rocks are (algMasonry.js) — real thickness, rounded corners, photo materials —
  // beside the game's mechta house (the kit atlas).
  maisonPierre: {
    label: "Maison en pierre (PC)", gap: 10, before: () => buildMechtaHouse({}),
    after: () => {
      const { group } = buildStoneHouse();
      // (the lab draws a body mesh per piece: an empty one, the house its `extra`)
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
      g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false });
      g.userData.extra = [group];
      return g;
    },
    tags: ["MAISON (KIT DU JEU)", "PIERRE · NOUVEAU"], note: "la maison du jeu à gauche, la maison en pierre du nouveau standard à droite.",
  },
  // THE MORTAR PIT (same day): the game's on the LEFT, the new standard's on the RIGHT.
  // THE MECHTA (2026-10-11): the lab's best kit house (detail 2) on the LEFT, the new standard RIGHT.
  mechtaPierre: {
    label: "Mechta (nouveau)", gap: 8, before: () => buildMechtaHouse({ detail: 2 }),
    after: () => { const { group } = buildMechtaHouseV2({ seed: 7 + SEED }); const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)); g.userData.labMaterial = new THREE.MeshBasicMaterial({ visible: false }); g.userData.extra = [group]; return g; },
    tags: ["MECHTA (KIT, DÉTAIL 2)", `MECHTA · NOUVEAU · variante ${SEED + 1}`], note: "la maison du kit à gauche, la nouvelle à droite.",
  },
  // THE HAMLET (same day): the game's on the LEFT, the new standard's on the RIGHT.
  hameau: {
    label: "Hameau (nouveau)", gap: 26, before: () => buildMechta(), after: () => buildMechtaV2(),
    tags: ["HAMEAU (LE JEU)", "HAMEAU · NOUVEAU"], note: "le hameau du jeu à gauche, le nouveau à droite.",
  },
  dechraNouveau: {
    label: "Dechra (nouveau)", gap: 34, before: () => buildDechra(), after: () => buildDechraV2(),
    tags: ["DECHRA (LE JEU)", "DECHRA · NOUVEAU"], note: "la dechra du jeu à gauche, la nouvelle à droite (sur terrain plat ici).",
  },
  ksarNouveau: {
    label: "Ksar (nouveau)", gap: 46, before: () => buildKsar(), after: () => buildKsarV2(),
    tags: ["KSAR (LE JEU)", "KSAR · NOUVEAU"], note: "le ksar du jeu à gauche, le nouveau à droite (terrain plat ici).",
  },
  // OPTION B (2026-10-11, your go): the post as the kit builds it, its colours kept, the photos'
  // grain and relief on top (algKitPhoto.js) — the game's post on the LEFT.
  postePhoto: {
    label: "Poste (photo)", gap: 42, before: () => buildFrenchPost({ detail: 2 }),
    after: () => { const g = buildFrenchPost({ detail: 2, footStone: MAT.limestone }); g.userData.labMaterial = kitPhotoMaterial(FR_PAINT_TINT); return g; },
    tags: ["POSTE (LE JEU)", "POSTE · DÉTAIL PHOTO"], note: "le poste du jeu à gauche, le même avec le grain et le relief des photos à droite.",
  },
  mortier: {
    label: "Fosse de mortier", gap: 7, before: () => buildMortarPit(), after: () => buildMortarPitV2(),
    tags: ["MORTIER (LE JEU)", "MORTIER · NOUVEAU"], note: "la fosse du jeu à gauche, la nouvelle à droite.",
  },
  campFln: {
    label: "Camp du FLN", gap: 31, before: () => buildAlnCamp(), after: () => buildCampV2(),
    tags: ["CAMP (LE JEU)", "CAMP · NOUVEAU STANDARD"], note: "le camp du jeu à gauche, le camp en grès et pierre sèche à droite.",
  },
  pointRavit: {
    label: "Point : munitions", gap: POINT_KINDS.mun.R + 3, before: () => supplyPoint("game", "mun"), after: () => supplyPoint("new", "mun"),
    tags: ["MUNITIONS (LE JEU)", "MUNITIONS · NOUVEAU"], note: "les marques du jeu à gauche, les nouvelles à droite — « Point » : l'état, la capture, le rayon.",
  },
  pointCarbu: {
    label: "Point : carburant", gap: POINT_KINDS.fuel.R + 3, before: () => supplyPoint("game", "fuel"), after: () => supplyPoint("new", "fuel"),
    tags: ["CARBURANT (LE JEU)", "CARBURANT · NOUVEAU"], note: "le dépôt de fûts — les marques du jeu à gauche, les nouvelles à droite.",
  },
};

/**
 * STONE candidates for the atlas's rubble cell (MAT.rubble, 19 — every wall in the game): drawn
 * INTO the shared atlas live, so both houses show the same stone — a fair A/B. The lab only.
 */
const STONES = {
  actuelle: { label: "Pierre actuelle", make: makeRubbleTexture },
  aures: { label: "Pierre des Aurès", make: makeAuresStoneTexture },
};

export async function startBuildingLab(container) {
  const lab = await startVehicleLab(container, { catalog: BUILDINGS, title: "Buildings Lab", kind: "Bâtiment", def: "mechtaHouse", gap: (k) => BUILDINGS[k].gap });
  await rtsAtlasReady();
  const atlas = rtsAtlas(), cell = atlas.image.width / ATLAS_COLS;
  const setStone = (key) => {
    const t = STONES[key].make({ size: cell });
    const i = MAT.rubble, col = i % ATLAS_COLS, row = (i / ATLAS_COLS) | 0;
    atlas.image.getContext("2d").drawImage(t.image, col * cell, row * cell);
    t.dispose();
    atlas.needsUpdate = true;
  };
  const panel = document.getElementById("vlab");
  const box = document.createElement("div");
  box.innerHTML = `<h2>Pierre (les deux)</h2><div class="g">${Object.entries(STONES).map(([k, v]) => `<button data-stone="${k}">${v.label}</button>`).join("")}</div>`;
  panel.insertBefore(box, panel.querySelector("h2:nth-of-type(3)"));
  box.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setStone(b.dataset.stone); });
  setStone("aures");   // the candidate first
  // Another seed of the new piece (the Roman sites, the rocks).
  const key = new URLSearchParams(location.search).get("v");
  if (BUILDINGS[key]?.after) {
    const v = document.createElement("div");
    v.innerHTML = `<h2>Variante</h2><div class="g"><button data-seed="-1">Précédente</button><button data-seed="1">Suivante</button></div>`;
    panel.insertBefore(v, box);
    // The rocks: the top in the sides' layered stone, or the cracked photo (you, 2026-10-08).
    if (key.startsWith("roche")) {
      const t = document.createElement("div");
      // The colour (CoH stays the default) and the sand apron at the foot (the game's splats: a preview).
      t.innerHTML = `<h2>Dessus du rocher</h2><div class="g"><button data-top="1">Même pierre</button><button data-top="0">Craquelé</button></div>
        <h2>Couleur du rocher</h2><div class="g">${Object.entries(SANDSTONE_COLOURS).map(([k, c]) => `<button data-col="${k}">${c.label}</button>`).join("")}</div>
        <h2>Sable au pied</h2><div class="g"><button data-apron="1">Avec</button><button data-apron="0">Sans</button></div>`;
      panel.insertBefore(t, box);
      const rockMesh = lab.after.group.children[0];
      const apron = sandApron(rockMesh.geometry);
      lab.after.group.add(apron);
      t.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.top) sandstoneLook.topSame.value = Number(b.dataset.top);
        if (b.dataset.col) setSandstoneColour(b.dataset.col);
        if (b.dataset.apron) apron.visible = b.dataset.apron === "1";
      });
    }
    v.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) location.search = `?v=${key}&seed=${Math.max(0, SEED + Number(b.dataset.seed))}`;
    });
  }
  if (["pointRavit", "pointCarbu"].includes(new URLSearchParams(location.search).get("v"))) startPointPanel(lab, panel);
  if (SITE) startConstructionPanel(lab, panel, box);
  // (`point`: the supply point's two sides, for stills of the capture from the console.)
  return Object.assign(lab, { setStone, point: POINT });
}

/**
 * CONSTRUCTION (the helipad): the site at a given progress, or played through at real pace (P.secs —
 * a sapper team's build time), the paint and the windsock at their moments.
 */
function startConstructionPanel(lab, panel, before) {
  const secs = 22;
  const div = document.createElement("div");
  div.innerHTML = `<h2>Construction</h2><div class="g">${[0, 20, 40, 60, 80, 100].map((p) => `<button data-p="${p}">${p} %</button>`).join("")}<button data-play="1">▶ Lecture (${secs} s)</button></div><div id="build-pct" style="font:12px monospace;margin-top:4px"></div>`;
  panel.insertBefore(div, before);
  const stencil = () => { let st = null; lab.after.group.traverse((o) => { if (o.material?.name === "RtsStencil") st = o; }); return st; };
  const pct = div.querySelector("#build-pct");
  let play = null;
  const show = (p) => {
    SITE.set(p);
    const st = stencil(); if (st) st.visible = SITE.stencilShown(p);
    if (SITE.sock) SITE.sock.visible = p >= 0.9;
    pct.textContent = `${Math.round(p * 100)} %`;
  };
  div.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.play) { play = { t0: performance.now() }; return; }
    play = null;
    show(Number(b.dataset.p) / 100);
  });
  const tick = () => {
    if (play) { const p = Math.min(1, (performance.now() - play.t0) / 1000 / secs); show(p); if (p >= 1) play = null; }
    requestAnimationFrame(tick);
  };
  tick();
  show(1);
  lab.construction = { show, site: SITE };
}

/** The supply point's panel: its state on both sides, and a capture played out (3 s, then the flash). */
function startPointPanel(lab, panel) {
  const both = (fn) => { for (const p of [POINT.game, POINT.neu]) if (p) fn(p); };
  let anim = null;      // { side, t } while a capture is playing
  let state = { owner: null, capturer: null, progress: 0, cut: false };
  const show = (owner, capturer = owner, progress = owner ? 1 : 0, cut = false) => {
    anim = null;
    state = { owner, capturer, progress, cut };
    both((p) => { p.marks.set(state); p.flag(owner ?? (progress > 0 ? capturer : null), owner ? 1 : progress); });
  };
  // THE RING'S SIZE (the open question: ours 22 m / 40 m, Company of Heroes 3's ~11 m — measured,
  // assets-src/refs/coh3/README.md). A supply point stops at 22: past it, it would cross the other side.
  const K = POINT_KINDS[POINT.kind] ?? POINT_KINDS.mun;
  const sizes = K.R > 22 ? [11, 16, 22, 30, 40] : [11, 16, 22];
  const box = document.createElement("div");
  box.innerHTML = `<h2>Point</h2><div class="g">
    <button data-pt="neutral">Neutre</button><button data-pt="half">Capture 50 %</button>
    <button data-pt="player">Tenu : France</button><button data-pt="enemy">Tenu : FLN</button>
    <button data-pt="cut">France, coupé</button><button data-pt="capP">▶ Capture France</button>
    <button data-pt="capE">▶ Capture FLN</button></div>
    <h2>Rayon</h2><div class="g">${sizes.map((r) => `<button data-r="${r}">${r} m${r === 11 ? " (CoH)" : r === K.R ? " (jeu)" : ""}</button>`).join("")}</div>`;
  panel.insertBefore(box, panel.firstElementChild?.nextSibling ?? null);
  box.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b?.dataset.r) { const r = Number(b.dataset.r); both((p) => p.resize(r)); both((p) => p.marks.set(state)); return; }
    const k = b?.dataset.pt;
    if (k === "neutral") show(null);
    else if (k === "half") show(null, "player", 0.5);
    else if (k === "player" || k === "enemy") show(k);
    else if (k === "cut") show("player", "player", 1, true);
    else if (k === "capP" || k === "capE") { show(null); anim = { side: k === "capP" ? "player" : "enemy", t: 0 }; }
  });
  show(null);
  // Both points in view through the GAME's camera (CoH 3's, algGame.js: a 26° lens, 44° down), back as
  // far as the pair needs (a village is 80 m across) — the lab's own 40° lens would judge them wrong.
  lab.camera.fov = 26;
  lab.camera.updateProjectionMatrix();
  lab.play(K.R * 7.6, 44);
  const CAP_S = 3;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (anim) {
      anim.t += dt / CAP_S;
      const k = Math.min(1, anim.t);
      both((p) => { p.marks.set({ owner: null, capturer: anim.side, progress: k }); p.flag(anim.side, k); });
      if (k >= 1) { const side = anim.side; anim = null; both((p) => { p.marks.capture(side); p.flag(side, 1); }); }
    }
    both((p) => p.marks.update(dt));
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
