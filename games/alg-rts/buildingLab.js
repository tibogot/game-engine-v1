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
import { ATLAS_COLS, makeAuresStoneTexture, makeRubbleTexture, rtsAtlas, rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { MAT } from "../../v3/render/objects/rtsParts.js";

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
  return Object.assign(lab, { setStone });
}
