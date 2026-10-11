// BUILDINGS LAB — the vehicle lab's scene and panel, one building at a time, AVANT / APRÈS
// (you, 2026-10-07: "pause the vehicle lab and start the buildings lab"). The game's sun,
// shadow and exposure; the building as the game draws it (the kit atlas, the French tint).
//
//   left   AVANT — the game's building (detail 1)
//   right  APRÈS — the same builder at detail 2
import { buildMechtaHouse } from "../../v3/render/objects/rtsMechta.js";
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { buildMotorPool, buildRockOutcrop } from "../../v3/render/objects/rtsAlgeria.js";
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
import { buildAmmoDump } from "../../v3/render/objects/rtsAlgeria.js";
import { createPointMark } from "./algPointMarks.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { drawFlnDataUrl, drawTricoloreDataUrl } from "./algFlag.js";

// THE SUPPLY POINT (2026-10-11, you: "add the requisition point in my building lab"): the GAME's
// marks on the LEFT (its thin solid ring, algUnits villageRings), the NEW ones on the RIGHT
// (algPointMarks.js: dashed → filled → solid, the disc, the capture wave and streaks); the same
// depot and flag on both. The panel's "Point" buttons set the state and play a capture.
const POINT_R = 22;                    // algEconomy supplyRadius
const POINT = { game: null, neu: null };
function supplyPoint(which) {
  const geo = buildAmmoDump();
  const fp = geo.userData.footprint ?? { hx: 1.5, hz: 1.5 };
  const extra = [];
  // The flag: a pole and a flat cloth that climbs with the hold (the game's waves: algPointFlags).
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 5, 8).translate(0, 2.5, 0), new THREE.MeshStandardNodeMaterial({ color: 0x5a5650, roughness: 0.6, metalness: 0.4 }));
  pole.position.set(-fp.hx - 0.4, 0, fp.hz * 0.6);
  pole.castShadow = true;
  const tex = { player: labFlagTex(drawTricoloreDataUrl(256)), enemy: labFlagTex(drawFlnDataUrl(256)) };
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.07).translate(0.8, 0.535, 0), new THREE.MeshStandardNodeMaterial({ map: tex.player, side: THREE.DoubleSide, roughness: 0.9 }));
  cloth.castShadow = true;
  pole.add(cloth);
  extra.push(pole);
  const flag = (side, hold) => {
    cloth.visible = !!side && hold > 0;
    if (side) cloth.material.map = tex[side];
    cloth.position.y = 0.5 + hold * (5 - 1.07 - 0.5);
  };
  let marks;
  if (which === "game") {
    const ring = new THREE.Mesh(new THREE.RingGeometry(POINT_R * 0.975, POINT_R, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.55, depthWrite: false }));
    ring.position.y = 0.06;
    ring.renderOrder = RENDER_ORDER.ON_GROUND;
    extra.push(ring);
    const GAME_COL = { player: 0x58a8ff, enemy: 0xff6a5a, null: 0xd8cfae };
    marks = { set: ({ owner }) => ring.material.color.set(GAME_COL[owner]), capture() {}, update() {} };
  } else {
    marks = createPointMark({ radius: POINT_R });
    marks.group.rotation.y = 0.6;       // undo the turntable's −0.6, so the fill starts at the top
    extra.push(marks.group);
  }
  geo.userData.extra = extra;
  POINT[which === "game" ? "game" : "neu"] = { marks, flag };
  return geo;
}
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

const BUILDINGS = {
  mechtaHouse: { build: (o) => buildMechtaHouse({ ...o }), label: "Maison (mechta)", gap: 7.5 },
  poste: { build: (o) => buildFrenchPost({ ...o }), label: "Poste français", gap: 42 },
  parcAuto: { build: (o) => buildMotorPool({ ...o }), label: "Parc auto", gap: 21 },
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
    label: "Point de ravitaillement", gap: POINT_R + 3, before: () => supplyPoint("game"), after: () => supplyPoint("new"),
    tags: ["POINT (LE JEU)", "POINT · NOUVEAU"], note: "les marques du jeu à gauche, les nouvelles à droite — « Point » : l'état et la capture.",
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
  if (new URLSearchParams(location.search).get("v") === "pointRavit") startPointPanel(lab, panel);
  return Object.assign(lab, { setStone });
}

/** The supply point's panel: its state on both sides, and a capture played out (3 s, then the flash). */
function startPointPanel(lab, panel) {
  const both = (fn) => { for (const p of [POINT.game, POINT.neu]) if (p) fn(p); };
  let anim = null;      // { side, t } while a capture is playing
  const show = (owner, capturer = owner, progress = owner ? 1 : 0) => {
    anim = null;
    both((p) => { p.marks.set({ owner, capturer, progress }); p.flag(owner ?? (progress > 0 ? capturer : null), owner ? 1 : progress); });
  };
  const box = document.createElement("div");
  box.innerHTML = `<h2>Point</h2><div class="g">
    <button data-pt="neutral">Neutre</button><button data-pt="half">Capture 50 %</button>
    <button data-pt="player">Tenu : France</button><button data-pt="enemy">Tenu : FLN</button>
    <button data-pt="capP">▶ Capture France</button><button data-pt="capE">▶ Capture FLN</button></div>`;
  panel.insertBefore(box, panel.firstElementChild?.nextSibling ?? null);
  box.addEventListener("click", (e) => {
    const k = e.target.closest("button")?.dataset.pt;
    if (k === "neutral") show(null);
    else if (k === "half") show(null, "player", 0.5);
    else if (k === "player" || k === "enemy") show(k);
    else if (k === "capP" || k === "capE") { show(null); anim = { side: k === "capP" ? "player" : "enemy", t: 0 }; }
  });
  show(null);
  // The point is 44 m across: the RTS camera, a little further out than play.
  lab.play(105, 48);
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
