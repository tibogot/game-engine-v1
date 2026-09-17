import { section, slider, color, toggle, dropdown, hint } from "./widgets.js";
import { FLOWER_PRESETS, FLOWER_HEIGHT_ANY } from "../app/state/flowerState.js";

/**
 * Flower settings under the Vegetation header — the selected flower (species,
 * colours, shape, where it grows) and the meadow-wide look. Built into
 * #flower-panel. The picker, brush, fill and clear live in the header
 * (buildVegetationHeader.js); `flowerBrush.type` is the flower it selected.
 *
 * Callbacks:
 *   onStateChanged()        any uniform setting changed
 *   onGeometryChanged(i)    a shape setting of type i changed (mesh rebuild)
 */
export function buildFlowerPanel(root, { flowerBrush, flowerState, getLayerNames, onStateChanged, onGeometryChanged }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  // Shape sliders fire on every input; a mesh rebuild is cheap but not free,
  // so coalesce a drag into one rebuild per frame.
  let _rebuildQueued = false;
  const geometryChanged = () => {
    if (_rebuildQueued) return;
    _rebuildQueued = true;
    requestAnimationFrame(() => { _rebuildQueued = false; onGeometryChanged?.(flowerBrush.type); });
  };

  function build() {
    root.innerHTML = "";
    widgets.length = 0;
    const type = flowerState.types[flowerBrush.type];

    // ── The selected type: species + colour ──
    const ty = section(root, type.name);
    W(dropdown(ty, type, "preset", {
      label: "Species",
      options: Object.keys(FLOWER_PRESETS).map((k) => [k, k[0].toUpperCase() + k.slice(1)]),
      onChange: () => {
        // Species sets shape and colour; the height band is where it grows here, so it stays.
        Object.assign(type, structuredClone(FLOWER_PRESETS[type.preset]));
        onStateChanged?.();
        onGeometryChanged?.(flowerBrush.type);
        build();
      },
      hint: "Loads that species' shape and colours into this flower. Tweak anything after.",
    }));
    W(color(ty, type, "petalBase", { label: "Petal base", onChange: onStateChanged }));
    W(color(ty, type, "petalTip",  { label: "Petal tip", onChange: onStateChanged }));
    W(color(ty, type, "centre",    { label: "Centre", onChange: onStateChanged }));
    W(slider(ty, type, "size", { label: "Bloom size (m)", min: 0.08, max: 1.2, step: 0.01, onChange: onStateChanged }));
    W(slider(ty, type, "stemHeight", { label: "Stem height (m)", min: 0, max: 1.6, step: 0.01, onChange: onStateChanged,
      hint: "0 = a bloom sitting on the ground, no stem." }));
    W(slider(ty, type, "veins", { label: "Veins", min: 0, max: 1, step: 0.01, onChange: onStateChanged }));
    W(slider(ty, type, "heightMin", { label: "Grows above (m)", min: FLOWER_HEIGHT_ANY.heightMin, max: FLOWER_HEIGHT_ANY.heightMax, step: 1, onChange: onStateChanged,
      hint: "Terrain height band this flower grows in — valley flowers low, alpine ones high. The full range is no limit." }));
    W(slider(ty, type, "heightMax", { label: "Grows below (m)", min: FLOWER_HEIGHT_ANY.heightMin, max: FLOWER_HEIGHT_ANY.heightMax, step: 1, onChange: onStateChanged }));
    const layerNames = getLayerNames?.() ?? [];
    W(dropdown(ty, type, "onLayer", {
      label: "Grows on layer",
      options: [[-1, "Any ground"], ...layerNames.map((n, i) => [i, n || "Layer " + (i + 1)])],
      onChange: onStateChanged,
      hint: "Only where this paint layer is painted — poppies on the meadow, not on the rock.",
    }));
    W(slider(ty, type, "nearRiver", { label: "Near rivers within (m)", min: 0, max: 80, step: 1, onChange: onStateChanged,
      hint: "Only this close to a River v2 river (measured from its centre line). 0 = anywhere." }));
    W(slider(ty, type, "translucency", { label: "Translucency", min: 0, max: 1.5, step: 0.01, onChange: onStateChanged,
      hint: "How much light comes through the petals with the sun behind them." }));

    // ── The selected type: shape (mesh) ──
    const sh = section(root, "Shape", false);
    const g = { onChange: geometryChanged };
    W(slider(sh, type, "petals",      { label: "Petals", min: 3, max: 32, step: 1, ...g }));
    W(slider(sh, type, "petalLength", { label: "Petal length", min: 0.15, max: 0.7, step: 0.01, ...g }));
    W(slider(sh, type, "petalWidth",  { label: "Petal width", min: 0.08, max: 1.4, step: 0.01, ...g }));
    W(slider(sh, type, "pointed",     { label: "Pointed tips", min: 0, max: 1, step: 0.01, ...g }));
    W(slider(sh, type, "cup",         { label: "Cup", min: 0, max: 1.1, step: 0.01, ...g,
      hint: "0 = open and flat, 1 = a closed tulip cup." }));
    W(slider(sh, type, "curl",        { label: "Tip curl", min: -0.8, max: 0.8, step: 0.01, ...g,
      hint: "Negative droops the petal tips, positive curls them up." }));
    W(toggle(sh, type, "doubleLayer", { label: "Second petal layer", ...g }));
    W(slider(sh, type, "centreSize",   { label: "Centre size", min: 0.04, max: 0.8, step: 0.01, ...g }));
    W(slider(sh, type, "centreHeight", { label: "Centre height", min: 0, max: 0.3, step: 0.005, ...g }));
    W(slider(sh, type, "leaves",   { label: "Leaves", min: 0, max: 3, step: 1, ...g }));
    W(slider(sh, type, "leafSize", { label: "Leaf size", min: 0.3, max: 2.5, step: 0.05, ...g }));
    hint(sh, "Leaves grow on stemmed flowers only.");

    // ── Meadow ──
    const md = section(root, "Meadow", false);
    W(slider(md, flowerState, "density",   { label: "Density", min: 0.05, max: 1, step: 0.05, onChange: onStateChanged,
      hint: "Share of plant spots that grow a flower where the paint is full strength." }));
    W(slider(md, flowerState, "clumping",  { label: "Clumping", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
      hint: "0 = an even spread; higher = natural clusters with bare gaps between." }));
    W(slider(md, flowerState, "clumpSize", { label: "Clump size (m)", min: 1, max: 20, step: 0.5, onChange: onStateChanged }));
    W(slider(md, flowerState, "sizeVar",   { label: "Size variation", min: 0, max: 0.8, step: 0.01, onChange: onStateChanged }));
    W(slider(md, flowerState, "colorVar",  { label: "Colour variation", min: 0, max: 0.5, step: 0.01, onChange: onStateChanged }));
    W(slider(md, flowerState, "grassLift", { label: "Rise above grass", min: 0, max: 1.5, step: 0.01, onChange: onStateChanged,
      hint: "Where grass is painted, flowers grow taller by this share of the grass blade height." }));
    W(color(md, flowerState, "stemBase", { label: "Stem base", onChange: onStateChanged }));
    W(color(md, flowerState, "stemTop",  { label: "Stem & leaf", onChange: onStateChanged }));
    W(slider(md, flowerState, "translucencyMul", { label: "Sun through petals ×", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));
    W(slider(md, flowerState, "glowLight", { label: "Self glow", min: 0, max: 0.6, step: 0.01, onChange: onStateChanged }));

    // ── Wind & push ──
    const wd = section(root, "Wind & Push", false);
    W(slider(wd, flowerState, "windMul", { label: "Wind ×", min: 0, max: 3, step: 0.05, onChange: onStateChanged,
      hint: "Multiplier on the shared grass wind." }));
    W(slider(wd, flowerState, "flex", { label: "Stem flex", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));
    W(slider(wd, flowerState, "flutter", { label: "Petal flutter", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));
    W(slider(wd, flowerState, "interactRadius",   { label: "Push radius (m)", min: 0.2, max: 5, step: 0.1, onChange: onStateChanged }));
    W(slider(wd, flowerState, "interactStrength", { label: "Push strength", min: 0, max: 2, step: 0.05, onChange: onStateChanged }));

    // ── Distance & detail ──
    const ds = section(root, "Distance & Detail", false);
    W(slider(ds, flowerState, "lodDistance", { label: "Detailed up to (m)", min: 4, max: 60, step: 1, onChange: onStateChanged,
      hint: "Full petals, leaves and shadows nearer than this; simple flowers beyond." }));
    W(slider(ds, flowerState, "fadeStart", { label: "Fade start (m)", min: 10, max: 90, step: 1, onChange: onStateChanged,
      hint: "Flowers thin out and shrink from here. The plant tile reaches 96 m, so keep the end below that." }));
    W(slider(ds, flowerState, "fadeEnd",   { label: "Fade end (m)", min: 15, max: 95, step: 1, onChange: onStateChanged }));
    W(slider(ds, flowerState, "farTint", { label: "Far field colour", min: 0, max: 2, step: 0.05, onChange: onStateChanged,
      hint: "Past the fade distance the ground takes the flowers' colour, so a painted field still reads from a hill. 0 = off." }));
    W(slider(ds, flowerState, "slopeMinY", { label: "Max slope", min: 0, max: 0.95, step: 0.01, onChange: onStateChanged,
      hint: "Terrain steeper than this grows no flowers." }));
    W(toggle(ds, flowerState, "receiveShadows", { label: "Shadows on near flowers", onChange: onStateChanged }));
  }

  build();
  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
    rebuild: build,
  };
}

