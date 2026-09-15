import { section, slider, color, toggle, dropdown, button, hint, numbers, info, text } from "./widgets.js";

/**
 * Decal mode panel — what the next click places, the selected decal's look,
 * and the decal textures (one texture-array layer each). Built into #decal-panel.
 *
 * Callbacks:
 *   onImportTexture(file)        add a texture slot from an image file
 *   onNormalMap(slot, file|null) set / clear a slot's normal map
 *   onRemoveSlot(slot)
 *   onSlotRenamed()
 */
export function buildDecalPanel(root, { system, editor, onImportTexture, onNormalMap, onRemoveSlot, onSlotRenamed }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  function pickFile(onFile) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => { if (input.files?.[0]) onFile(input.files[0]); };
    input.click();
  }

  const slotOptions = () => system.textures.slots.map((s, i) => [i, s.name || `Texture ${i + 1}`]);

  function build() {
    root.innerHTML = "";
    widgets.length = 0;
    const place = editor.place;
    const d = editor.selected;

    // ── Place ──
    const pl = section(root, "Place Decals");
    W(dropdown(pl, place, "slot", { label: "Texture", options: slotOptions() }));
    W(dropdown(pl, place, "align", {
      label: "Project",
      options: [["surface", "Into the surface"], ["down", "Straight down"]],
      hint: "Into the surface follows the slope under the click (walls, cliffs); straight down suits flat ground and puddles.",
    }));
    W(slider(pl, place, "size", { label: "Size (m)", min: 0.25, max: 40, step: 0.25 }));
    W(slider(pl, place, "depth", { label: "Projection depth (m)", min: 0.1, max: 20, step: 0.1,
      hint: "How far the box reaches above and below the click. Deeper wraps over bumps; too deep also paints things above." }));
    W(toggle(pl, place, "randomRotation", { label: "Random rotation", onChange: () => build() }));
    if (!place.randomRotation) {
      W(slider(pl, place, "rotation", { label: "Rotation °", min: -180, max: 180, step: 1,
        hint: "0 = the texture's top faces away from the camera." }));
    }
    hint(pl, "Click = place · click a decal = select · <kbd>Shift</kbd>+click = place on top · <kbd>W</kbd>/<kbd>E</kbd>/<kbd>R</kbd> move/rotate/scale · <kbd>Q</kbd> local/world · <kbd>Del</kbd> · <kbd>Ctrl</kbd>+<kbd>D</kbd> · <kbd>Esc</kbd>",
      { html: true, className: "mode-hint" });
    info(pl, "In scene", `${system.decals.length} decal${system.decals.length === 1 ? "" : "s"} · 1 draw call`, { layout: "prop" });

    // ── Selected ──
    if (d) {
      const coalesce = (k) => () => editor.edited(`decal-${d.id}-${k}`);
      const sel = section(root, `Decal #${d.id}`);
      W(dropdown(sel, d, "slot", { label: "Texture", options: slotOptions(), onChange: () => editor.edited() }));
      W(color(sel, d, "tint", { label: "Tint", onChange: coalesce("tint") }));
      W(slider(sel, d, "opacity", { label: "Opacity", min: 0, max: 1, step: 0.01, onChange: coalesce("opacity") }));
      W(numbers(sel, d, ["sx", "sy", "sz"], { label: "Size W/D/L", step: 0.05, min: 0.05, onChange: () => editor.edited(), fieldTitles: ["Width", "Projection depth", "Length"] }));
      W(numbers(sel, d, ["px", "py", "pz"], { label: "Position", step: 0.05, onChange: () => editor.edited(), fieldTitles: ["X", "Y", "Z"] }));
      W(slider(sel, d, "priority", { label: "Priority", min: -10, max: 10, step: 1, onChange: coalesce("priority"),
        hint: "Where decals overlap, the higher one draws on top." }));

      const look = section(root, "Surface", false);
      W(slider(look, d, "roughness", { label: "Roughness", min: 0, max: 1, step: 0.01, onChange: coalesce("roughness") }));
      W(slider(look, d, "normalStrength", { label: "Normal strength", min: 0, max: 3, step: 0.05, onChange: coalesce("normalStrength"),
        hint: "Bumps from the texture's normal map (Textures section). No normal map = flat." }));
      W(slider(look, d, "angleFade", { label: "Angle fade °", min: 5, max: 89, step: 1, onChange: coalesce("angleFade"),
        hint: "Surfaces turned further than this from the projection stop receiving it — stops streaks down steep sides." }));
      W(slider(look, d, "edgeFade", { label: "Edge fade", min: 0, max: 0.5, step: 0.01, onChange: coalesce("edgeFade") }));

      const act = section(root, "Actions");
      button(act, { title: "Duplicate (Ctrl+D)", onClick: () => editor.duplicateSelected() });
      button(act, { title: "Deselect (Esc)", onClick: () => editor.deselect() });
      button(act, { title: "Delete (Del)", onClick: () => editor.deleteSelected(), style: "color:#f66" });
    }

    // ── Textures ──
    const tx = section(root, "Decal Textures", false);
    hint(tx, "Every texture is one layer of a shared array: any number of decals and textures still costs one draw. PNG alpha is the decal's shape; an image with no alpha gets it from its colours (a light background drops out).");
    system.textures.slots.forEach((s, i) => {
      W(text(tx, s, "name", { label: `Texture ${i + 1}`, onChange: () => { onSlotRenamed?.(); build(); } }));
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;margin:0 0 8px";
      tx.appendChild(row);
      button(row, { title: s.normalUrl ? "Replace normal map" : "Add normal map", onClick: () => pickFile((f) => onNormalMap?.(i, f)) });
      if (s.normalUrl) button(row, { title: "No normal", onClick: () => onNormalMap?.(i, null) });
      if (system.textures.slots.length > 1) button(row, { title: "Remove", style: "color:#f66", onClick: () => onRemoveSlot?.(i) });
    });
    button(tx, { title: "Import texture…", onClick: () => pickFile((f) => onImportTexture?.(f)) });
  }

  build();
  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
    rebuild: build,
  };
}
