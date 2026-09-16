import { section, slider, color, toggle, dropdown, button, hint, text } from "./widgets.js";
import { FOLIAGE_PRESETS, FOLIAGE_HEIGHT_ANY } from "../app/state/foliageScatterState.js";

/**
 * Foliage mode panel — the plant being painted (its shape, colour and where it
 * may grow) and the field as a whole. Built into #foliage-panel.
 *
 * Same idea as the flower panel: the brush paints the plant you are looking at,
 * so what you tune is what you paint.
 *
 * Callbacks:
 *   onBrushChanged()        brush radius changed (cursor ring)
 *   onStateChanged()        any uniform setting changed
 *   onGeometryChanged(i)    a shape setting of type i changed (mesh rebuild)
 *   onFill(type) / onClear()
 */
export function buildFoliagePanel(root, { foliageBrush, foliageState, getLayerNames, onBrushChanged, onStateChanged, onGeometryChanged, onFill, onClear }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  // Shape sliders fire on every input; a rebuild is cheap but not free, so a
  // drag becomes one rebuild per frame.
  let _rebuildQueued = false;
  const geometryChanged = () => {
    if (_rebuildQueued) return;
    _rebuildQueued = true;
    requestAnimationFrame(() => { _rebuildQueued = false; onGeometryChanged?.(foliageBrush.type); });
  };

  function build() {
    root.innerHTML = "";
    widgets.length = 0;
    const type = foliageState.types[foliageBrush.type];

    // ── Paint ──
    const paint = section(root, "Paint Foliage");
    W(dropdown(paint, foliageBrush, "type", {
      label: "Plant",
      options: foliageState.types.map((t, i) => [i, t.name]),
      onChange: () => build(),
      hint: "The brush paints this plant; the settings below tune it. Plants mix where you paint more than one.",
    }));
    W(slider(paint, foliageBrush, "radius",   { label: "Radius",   min: 1, max: 150, step: 1, onChange: onBrushChanged }));
    W(slider(paint, foliageBrush, "strength", { label: "Strength", min: 0.05, max: 1, step: 0.05 }));
    W(slider(paint, foliageBrush, "falloff",  { label: "Falloff",  min: 0.5, max: 6, step: 0.1 }));
    W(toggle(paint, foliageBrush, "erase",    { label: "Erase" }));
    W(toggle(paint, foliageBrush, "eraseOnlyType", { label: "Erase this plant only",
      hint: "Off: erasing (or Alt+paint) removes every plant under the brush. On: only the plant selected above." }));
    hint(paint, "<kbd>Alt</kbd>+paint = erase · <kbd>Shift</kbd>/<kbd>Alt</kbd>+wheel = radius/strength", { html: true, className: "mode-hint" });
    button(paint, { title: `Fill "${type.name}" everywhere`, onClick: () => onFill?.(foliageBrush.type) });
    button(paint, { title: "Clear all foliage", onClick: () => onClear?.(), style: "color:#f66" });

    // ── The selected plant ──
    const ty = section(root, type.name);
    W(text(ty, type, "name", { label: "Name", onChange: () => build() }));
    W(dropdown(ty, type, "preset", {
      label: "Species",
      options: Object.keys(FOLIAGE_PRESETS).map((k) => [k, k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())]),
      onChange: () => {
        // Species sets shape and colour; where it grows is about this world, so it stays.
        Object.assign(type, structuredClone(FOLIAGE_PRESETS[type.preset]));
        onStateChanged?.();
        onGeometryChanged?.(foliageBrush.type);
        build();
      },
      hint: "Loads that species' shape and colours into this plant. Tweak anything after.",
    }));
    W(slider(ty, type, "size", { label: "Size (m)", min: 0.2, max: 5, step: 0.05, onChange: onStateChanged,
      hint: "Roughly how tall the plant stands. A forest fern is 2-3, ground cover under 1." }));
    W(color(ty, type, "colorBase", { label: "Colour (crown)", onChange: onStateChanged }));
    W(color(ty, type, "colorTip",  { label: "Colour (tips)", onChange: onStateChanged }));
    if (type.kind === "typha" || type.kind === "plume") {
      W(color(ty, type, "colorHead", { label: "Colour (head)", onChange: onStateChanged,
        hint: "The cattail's sausage or the reed's plume." }));
    }
    W(slider(ty, type, "translucency", { label: "Translucency", min: 0, max: 1.5, step: 0.01, onChange: onStateChanged,
      hint: "How much light comes through the leaves with the sun behind them." }));

    // ── Where it grows ──
    const gr = section(root, "Where it grows", false);
    W(slider(gr, type, "heightMin", { label: "Grows above (m)", min: FOLIAGE_HEIGHT_ANY.heightMin, max: FOLIAGE_HEIGHT_ANY.heightMax, step: 1, onChange: onStateChanged,
      hint: "Terrain height band — valley ferns low, alpine plants high. The full range is no limit." }));
    W(slider(gr, type, "heightMax", { label: "Grows below (m)", min: FOLIAGE_HEIGHT_ANY.heightMin, max: FOLIAGE_HEIGHT_ANY.heightMax, step: 1, onChange: onStateChanged }));
    const layerNames = getLayerNames?.() ?? [];
    W(dropdown(gr, type, "onLayer", {
      label: "Grows on layer",
      options: [[-1, "Any ground"], ...layerNames.map((n, i) => [i, n || "Layer " + (i + 1)])],
      onChange: onStateChanged,
      hint: "Only where this paint layer is painted — ferns on the forest floor, not on the rock.",
    }));
    W(slider(gr, type, "nearRiver", { label: "Near rivers within (m)", min: 0, max: 80, step: 1, onChange: onStateChanged,
      hint: "Only this close to a River v2 river (measured from its centre line). 0 = anywhere." }));

    // ── Shape (mesh) ──
    const sh = section(root, "Shape", false);
    const g = { onChange: geometryChanged };
    W(slider(sh, type, "fronds",       { label: "Fronds", min: 3, max: 20, step: 1, ...g,
      hint: "Leaves radiating from the crown. Two of them stand up in the middle; the rest lean out." }));
    W(slider(sh, type, "frondLength",  { label: "Frond length", min: 0.4, max: 1.6, step: 0.01, ...g }));
    const stalked = type.kind === "typha" || type.kind === "plume";
    W(slider(sh, type, "leaflets", {
      label: stalked ? "Stems" : "Leaflets per side", min: stalked ? 1 : 4, max: 40, step: 1, ...g,
      hint: stalked
        ? "Flowering stems rising out of the leaves, each carrying a head."
        : "The little blades down each side of a frond. More of them = finer, feathery leaves.",
    }));
    W(slider(sh, type, "leafletWidth", { label: "Leaflet width", min: 0.3, max: 2.5, step: 0.05, ...g }));
    W(slider(sh, type, "leafletAngle", { label: "Leaflet angle °", min: 20, max: 85, step: 1, ...g,
      hint: "How far the leaflets lean toward the frond's tip." }));
    W(slider(sh, type, "spread",       { label: "Spread", min: 0.1, max: 1.6, step: 0.02, ...g,
      hint: "0 = fronds stand straight up, high = a flat star lying on the ground." }));
    W(slider(sh, type, "arch",         { label: "Arch", min: 0, max: 2, step: 0.02, ...g,
      hint: "How far a frond bends over along its length." }));
    W(slider(sh, type, "droop",        { label: "Leaflet droop", min: 0, max: 1, step: 0.02, ...g }));
    W(slider(sh, type, "bareStalk",    { label: "Bare stalk", min: 0, max: 0.5, step: 0.01, ...g,
      hint: "Share of the frond nearest the crown that carries no leaflets." }));
    W(slider(sh, type, "stemWidth",    { label: "Stalk width", min: 0.3, max: 3, step: 0.05, ...g }));

    // ── The field ──
    const fd = section(root, "Field");
    W(slider(fd, foliageState, "density",   { label: "Density", min: 0.02, max: 1, step: 0.01, onChange: onStateChanged,
      hint: "Share of plant spots that grow where the paint is full strength. Big plants need less." }));
    W(slider(fd, foliageState, "clumping",  { label: "Clumping", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
      hint: "0 = an even spread; higher = natural thickets with bare gaps between." }));
    W(slider(fd, foliageState, "clumpSize", { label: "Clump size (m)", min: 1, max: 30, step: 0.5, onChange: onStateChanged }));
    W(slider(fd, foliageState, "sizeVar",   { label: "Size variation", min: 0, max: 0.8, step: 0.01, onChange: onStateChanged }));
    W(slider(fd, foliageState, "colorVar",  { label: "Colour variation", min: 0, max: 0.5, step: 0.01, onChange: onStateChanged }));
    W(slider(fd, foliageState, "grassLift", { label: "Rise above grass", min: 0, max: 1.5, step: 0.01, onChange: onStateChanged }));
    W(slider(fd, foliageState, "slopeMinY", { label: "Max slope", min: 0, max: 0.95, step: 0.01, onChange: onStateChanged,
      hint: "Terrain steeper than this grows nothing." }));

    // ── Wind & push ──
    const wd = section(root, "Wind & Push", false);
    W(slider(wd, foliageState, "windMul", { label: "Wind ×", min: 0, max: 3, step: 0.05, onChange: onStateChanged,
      hint: "Multiplier on the shared grass wind. 0 = the plants stand still." }));
    W(slider(wd, foliageState, "flex",    { label: "Frond flex", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));
    W(slider(wd, foliageState, "flutter", { label: "Leaflet flutter", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));
    W(slider(wd, foliageState, "interactRadius",   { label: "Push radius (m)", min: 0.2, max: 5, step: 0.1, onChange: onStateChanged }));
    W(slider(wd, foliageState, "interactStrength", { label: "Push strength", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));

    // ── Light ──
    const li = section(root, "Light", false);
    W(slider(li, foliageState, "translucencyMul", { label: "Sun through leaves ×", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));
    W(slider(li, foliageState, "glowLight", { label: "Self glow", min: 0, max: 0.6, step: 0.01, onChange: onStateChanged }));
    W(toggle(li, foliageState, "receiveShadows", { label: "Shadows on near plants", onChange: onStateChanged }));

    // ── Distance & detail ──
    const ds = section(root, "Distance & Detail", false);
    W(slider(ds, foliageState, "lodDistance", { label: "Every leaflet up to (m)", min: 4, max: 60, step: 1, onChange: onStateChanged,
      hint: "Full leaflets nearer than this; a cut blade beyond." }));
    W(slider(ds, foliageState, "lodDistance2", { label: "Cut blade up to (m)", min: 10, max: 120, step: 1, onChange: onStateChanged,
      hint: "Past this the plant is a plain blade — cheapest, and most of a field is here." }));
    W(slider(ds, foliageState, "fadeStart", { label: "Fade start (m)", min: 10, max: 160, step: 1, onChange: onStateChanged,
      hint: "Plants thin out and shrink from here. The plant tile reaches 96 m, so keep the end below that." }));
    W(slider(ds, foliageState, "fadeEnd",   { label: "Fade end (m)", min: 15, max: 190, step: 1, onChange: onStateChanged }));
  }

  build();
  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
    rebuild: build,
  };
}
