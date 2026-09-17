import { section, slider, toggle, button, hint } from "./widgets.js";
import { createAssetPalette } from "./assetPalette.js";

/**
 * VEGETATION MODE — the one place to paint plants.
 *
 * Foliage, flowers and susuki are three GPU scatter systems with their own
 * paint layers and saves, but painting them is one job, so they share one
 * mode: this header (the plant grid, the brush, fill and clear) sits on top,
 * and the selected plant's own settings panel shows underneath it. Picking a
 * card switches which system the brush paints into.
 *
 * Grass keeps its own mode (it covers the ground rather than placing plants),
 * and trees keep theirs (a different system with its own LOD and impostors).
 *
 * @param {HTMLElement} root
 * @param {object} o
 *   brush           the shared brush { radius, strength, falloff, erase, eraseOnlyType }
 *   groups          () => [{ title, cards: [{ mode, key, name, thumb?, kind?, title?, canFill? }], onDropFile? }]
 *                   A group is what the artist sees together (Plants, Flowers…);
 *                   each card names the system (`mode`) and plant (`key`) it
 *                   paints, so one group can mix systems — susuki sits in
 *                   Plants though it has its own field. kind "empty" = a "+" card.
 *   active          () => { mode, type }
 *   onSelect(mode, type)
 *   onBrushChanged()   radius changed (cursor ring)
 *   onFill(mode, type) / onClearAll()
 */
export function buildVegetationHeader(root, { brush, groups, active, onSelect, onBrushChanged, onFill, onClearAll }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };
  let palettes = [];

  function build() {
    root.innerHTML = "";
    widgets.length = 0;
    palettes = [];
    const sel = active();
    const gs = groups();

    const pick = section(root, "Paint Vegetation");
    hint(pick, "Pick a plant, then paint. Plants of every kind mix where you paint more than one; the selected plant's settings are below.");
    for (const g of gs) {
      const label = document.createElement("div");
      label.className = "veg-group-label";
      label.textContent = g.title;
      label.style.cssText = "font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-dim);margin:8px 0 4px";
      pick.appendChild(label);
      const id = (c) => `${c.mode}:${c.key}`;
      palettes.push(createAssetPalette({
        container: pick,
        cards: () => g.cards.map((c) => ({
          key: id(c), label: c.name, kind: c.kind ?? "asset", thumb: c.thumb?.() ?? null, title: c.title ?? c.name,
        })),
        activeKey: () => { const a = active(); return `${a.mode}:${a.type}`; },
        onSelect: (key) => { const c = g.cards.find((x) => id(x) === key); if (c) onSelect(c.mode, c.key); },
        onDropFile: g.onDropFile ?? null,
        acceptExts: g.onDropFile ? new Set(["glb", "gltf"]) : null,
        dropHint: "Drop a plant GLB",
      }));
    }

    const selCard = gs.flatMap((g) => g.cards).find((c) => c.mode === sel.mode && c.key === sel.type);
    const selName = selCard?.name ?? "plant";

    const br = section(root, "Brush");
    W(slider(br, brush, "radius",   { label: "Radius",   min: 1, max: 300, step: 1, curve: "log", onChange: onBrushChanged }));
    W(slider(br, brush, "strength", { label: "Strength", min: 0.05, max: 1, step: 0.05 }));
    W(slider(br, brush, "falloff",  { label: "Falloff",  min: 0.5, max: 6, step: 0.1 }));
    W(toggle(br, brush, "erase",    { label: "Erase" }));
    W(toggle(br, brush, "eraseOnlyType", { label: "Erase selected plant only",
      hint: "Off: erasing (or Alt+paint) removes every plant under the brush — foliage, flowers, susuki and placed plants (never other props). On: only the plant selected above." }));
    hint(br, "<kbd>Alt</kbd>+paint = erase · <kbd>Shift</kbd>/<kbd>Alt</kbd>+wheel = radius/strength", { html: true, className: "mode-hint" });
    if (selCard?.canFill !== false) {
      button(br, { title: `Fill "${selName}" everywhere`, onClick: () => onFill?.(sel.mode, sel.type) });
    }
    button(br, { title: "Clear all vegetation", onClick: () => onClearAll?.(), style: "color:#f66" });
  }

  build();
  return {
    /** Brush values changed from outside (wheel shortcuts). */
    refresh() { for (const w of widgets) w.refresh?.(); },
    /** Thumbnails or names changed: redraw the cards only. */
    refreshCards() { for (const p of palettes) p.refresh(); },
    /** The selection moved to another plant: rebuild everything. */
    rebuild: build,
  };
}

// ── Card pictures for the plants that have no baked thumbnail ────────────────

const THUMB = 128;

/**
 * A flower seen from above and a little in front: petals round a centre, in
 * the type's own colours. Drawn on a canvas — the real flower is instanced
 * geometry reading GPU buffers, so a 2D sketch is far cheaper than a bake and
 * reads just as well at card size.
 */
export function drawFlowerThumb(type) {
  const c = document.createElement("canvas");
  c.width = c.height = THUMB;
  const g = c.getContext("2d");
  g.fillStyle = "#1b1b1b";
  g.fillRect(0, 0, THUMB, THUMB);
  const cx = THUMB / 2, cy = THUMB / 2;
  const petals = Math.max(3, Math.min(32, Math.round(type.petals ?? 8)));
  // About the size the baked plant pictures sit at in their cards.
  const len = (THUMB * 0.2 + THUMB * 0.35 * Math.min(1, (type.petalLength ?? 0.4) / 0.6)) * 0.6;
  const wid = len * Math.max(0.12, Math.min(0.9, (type.petalWidth ?? 0.4) * 0.6));
  const layers = type.doubleLayer ? 2 : 1;
  for (let l = 0; l < layers; l++) {
    const scale = l === 0 ? 1 : 0.7;
    for (let i = 0; i < petals; i++) {
      const a = (i + l * 0.5) / petals * Math.PI * 2;
      g.save();
      g.translate(cx, cy);
      g.rotate(a);
      const grad = g.createLinearGradient(0, 0, len * scale, 0);
      grad.addColorStop(0, type.petalBase ?? "#ffffff");
      grad.addColorStop(1, type.petalTip ?? "#ffffff");
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(len * scale * 0.5, 0, len * scale * 0.5, wid * scale * 0.5, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  const cr = (THUMB * 0.05 + THUMB * 0.2 * Math.min(1, (type.centreSize ?? 0.2) / 0.8)) * 0.6;
  g.fillStyle = type.centre ?? "#f2b705";
  g.beginPath();
  g.arc(cx, cy, cr, 0, Math.PI * 2);
  g.fill();
  return c.toDataURL();
}
