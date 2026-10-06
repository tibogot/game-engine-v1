// BUILDINGS LAB — the vehicle lab's scene and panel, one building at a time, AVANT / APRÈS
// (you, 2026-10-07: "pause the vehicle lab and start the buildings lab"). The game's sun,
// shadow and exposure; the building as the game draws it (the kit atlas, the French tint).
//
//   left   AVANT — the game's building (detail 1)
//   right  APRÈS — the same builder at detail 2
import { buildMechtaHouse } from "../../v3/render/objects/rtsMechta.js";
import { buildFrenchPost } from "../../v3/render/objects/rtsFrenchPost.js";
import { startVehicleLab } from "./vehicleLab.js";
import { ATLAS_COLS, makeAuresStoneTexture, makeRubbleTexture, rtsAtlas, rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { MAT } from "../../v3/render/objects/rtsParts.js";

const BUILDINGS = {
  mechtaHouse: { build: (o) => buildMechtaHouse({ ...o }), label: "Maison (mechta)", gap: 7.5 },
  poste: { build: (o) => buildFrenchPost({ ...o }), label: "Poste français", gap: 42 },
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
  return Object.assign(lab, { setStone });
}
