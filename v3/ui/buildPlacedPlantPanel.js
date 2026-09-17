import { section, slider, toggle, hint, button } from "./widgets.js";

/**
 * Placed-plant settings under the Vegetation header — the brush rules of the
 * selected imported plant (`slot.plant`, see v3/tools/placedPlants.js). Built
 * into #veg-placed-panel.
 *
 * @param {HTMLElement} root
 * @param {object} o
 *   getSlot()          the selected plant's prop slot, or null
 *   getCount()         how many of it are placed
 *   onCollideChanged() the slot's collide flag changed
 *   onImport()         open the GLB picker
 *   onRemove()         remove every placed copy of this plant
 */
export function buildPlacedPlantPanel(root, { getSlot, getCount, onCollideChanged, onImport, onRemove }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  function build() {
    root.innerHTML = "";
    widgets.length = 0;
    const slot = getSlot();
    if (!slot?.plant) {
      const sec = section(root, "Placed plants");
      hint(sec, "Import a plant GLB (a bush, a shrub, a clump of grass) — or drop one on the Import card above. Each painted copy is a real instance: LOD, culling and shadows come from the prop instancer.");
      button(sec, { title: "Import plant GLB…", onClick: () => onImport?.() });
      return;
    }
    const p = slot.plant;
    const sec = section(root, slot.name);
    hint(sec, `${getCount?.() ?? 0} placed. Paint with the brush above; erase removes placed plants too, never other props.`);
    W(slider(sec, p, "density",   { label: "Density", min: 0.5, max: 100, step: 0.5, curve: "log",
      hint: "Plants per 100 m² at full brush strength, before spacing rejects some." }));
    W(slider(sec, p, "minSpacing", { label: "Min spacing (m)", min: 0.2, max: 20, step: 0.1, curve: "log",
      hint: "No two plants closer than this — against every prop already standing, not just this plant." }));
    W(slider(sec, p, "scaleMin",  { label: "Scale min", min: 0.1, max: 5, step: 0.05 }));
    W(slider(sec, p, "scaleMax",  { label: "Scale max", min: 0.1, max: 5, step: 0.05 }));
    W(slider(sec, p, "alignToNormal", { label: "Lean with slope", min: 0, max: 1, step: 0.05,
      hint: "0 = always upright (trees, reeds), 1 = follows the ground (moss, low shrubs)." }));
    W(slider(sec, p, "maxSlope",  { label: "Max slope °", min: 0, max: 90, step: 1,
      hint: "Steeper ground grows nothing." }));
    W(slider(sec, p, "sink",      { label: "Sink", min: 0, max: 0.5, step: 0.01,
      hint: "Share of the plant's height pushed into the ground, so roots never float on a slope." }));
    W(toggle(sec, p, "collide",   { label: "Blocks the player", onChange: () => onCollideChanged?.() }));
    button(sec, { title: `Remove every placed ${slot.name}`, onClick: () => onRemove?.(), style: "color:#f66" });
    hint(sec, "The model, its materials and LOD are the prop's: Props mode lists it too.");
  }

  build();
  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
    rebuild: build,
  };
}
