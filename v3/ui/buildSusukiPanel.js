import { section as _section, slider as _slider, color as _color, toggle as _toggle } from "./widgets.js";

/**
 * Susuki settings under the Vegetation header — plant and plume appearance.
 * Built into #susuki-panel. The picker, brush, fill and clear live in the
 * header (buildVegetationHeader.js).
 *
 * Callbacks:
 *   onStateChanged()      any uniform-driven appearance param changed
 *   onPlumeGeoChanged()   plumeWidth / plumeHeight / plumeDroop (geometry bake)
 *   onStemGeoChanged()    stemWidth (geometry bake)
 *   onTextureChanged()    plume strand texture params (canvas redraw)
 */
export function buildSusukiPanel(root, {
  susukiState,
  onStateChanged,
  onPlumeGeoChanged,
  onStemGeoChanged,
  onTextureChanged,
}) {
  root.innerHTML = "";
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  // ── Plants ──
  const plants = _section(root, "Susuki");
  W(_slider(plants, susukiState, "density",       { label: "Density",     min: 0.05, max: 1, step: 0.05, onChange: onStateChanged }));
  W(_slider(plants, susukiState, "tufts",         { label: "Stems/plant", min: 1, max: 8, step: 1, hint: "Optional bunching: stems per painted plant", onChange: () => { onStemGeoChanged?.(); onPlumeGeoChanged?.(); } }));
  W(_slider(plants, susukiState, "plumesPerFlower", { label: "Plumes/flower", min: 1, max: 8, step: 1, hint: "Plumes in the flower head atop each stem", onChange: onPlumeGeoChanged }));
  W(_slider(plants, susukiState, "flowerSpread",  { label: "Flower spread", min: 10, max: 90, step: 1, hint: "Fan half-angle of the flower head (°)", onChange: onPlumeGeoChanged }));
  W(_slider(plants, susukiState, "interactRadius",   { label: "Push radius",   min: 0.5, max: 6, step: 0.1, onChange: onStateChanged, hint: "Player/horse parting radius" }));
  W(_slider(plants, susukiState, "interactStrength", { label: "Push strength", min: 0, max: 3, step: 0.05, onChange: onStateChanged }));
  W(_slider(plants, susukiState, "stemHeight",    { label: "Stem height", min: 0.8, max: 3.5, step: 0.05, onChange: onStateChanged }));
  W(_slider(plants, susukiState, "stemHeightVar", { label: "Height var",  min: 0, max: 0.6, step: 0.02, onChange: onStateChanged }));
  W(_slider(plants, susukiState, "stemFlex",      { label: "Wind flex",   min: 0, max: 1.2, step: 0.05, onChange: onStateChanged }));
  W(_slider(plants, susukiState, "windMul",       { label: "Wind ×",      min: 0, max: 2.5, step: 0.05, onChange: onStateChanged, hint: "Multiplier on the shared grass wind" }));
  W(_slider(plants, susukiState, "stemWidth",     { label: "Stem width",  min: 0.01, max: 0.08, step: 0.005, onChange: onStemGeoChanged }));
  W(_color(plants, susukiState, "stemBase", { label: "Stem base", onChange: onStateChanged }));
  W(_color(plants, susukiState, "stemTip",  { label: "Stem tip",  onChange: onStateChanged }));

  // ── Plume ──
  const plume = _section(root, "Plume");
  W(_slider(plume, susukiState, "plumeSize",   { label: "Size",       min: 0.4, max: 2, step: 0.05, onChange: onStateChanged }));
  W(_slider(plume, susukiState, "plumeWidth",  { label: "Card width", min: 0.2, max: 1.2, step: 0.02, onChange: onPlumeGeoChanged }));
  W(_slider(plume, susukiState, "plumeHeight", { label: "Card height",min: 0.4, max: 2, step: 0.05, onChange: onPlumeGeoChanged }));
  W(_slider(plume, susukiState, "plumeDroop",  { label: "Droop",      min: 0, max: 1.2, step: 0.05, onChange: onPlumeGeoChanged }));
  W(_color(plume, susukiState, "plumeBase", { label: "Base color", onChange: onStateChanged }));
  W(_color(plume, susukiState, "plumeTip",  { label: "Tip color",  onChange: onStateChanged }));
  W(_slider(plume, susukiState, "plumeAO",          { label: "Base AO",   min: 0, max: 1, step: 0.02, onChange: onStateChanged }));
  W(_slider(plume, susukiState, "plumeGlow",        { label: "Glow",      min: 0, max: 0.6, step: 0.02, onChange: onStateChanged }));
  W(_slider(plume, susukiState, "backlitIntensity", { label: "Backlight", min: 0, max: 4, step: 0.05, onChange: onStateChanged, hint: "Silver-lining glow looking toward the sun" }));
  W(_slider(plume, susukiState, "backlitPower",     { label: "Backlight focus", min: 1, max: 16, step: 0.5, onChange: onStateChanged }));
  W(_slider(plume, susukiState, "flutter",          { label: "Flutter",   min: 0, max: 0.2, step: 0.005, onChange: onStateChanged }));
  W(_slider(plume, susukiState, "alphaTest",        { label: "Alpha test",min: 0.05, max: 0.6, step: 0.01, onChange: onStateChanged }));

  // ── Plume texture ──
  const tex = _section(root, "Plume Texture", false);
  W(_slider(tex, susukiState, "texStrands",   { label: "Strands",    min: 60, max: 800, step: 10, onChange: onTextureChanged }));
  W(_slider(tex, susukiState, "texSpread",    { label: "Spread °",   min: 15, max: 85, step: 1, onChange: onTextureChanged }));
  W(_slider(tex, susukiState, "texStrandLen", { label: "Strand len", min: 0.1, max: 0.6, step: 0.01, onChange: onTextureChanged }));
  W(_slider(tex, susukiState, "texDroop",     { label: "Strand droop", min: 0, max: 2, step: 0.05, onChange: onTextureChanged }));

  // ── Distance / growth ──
  const dist = _section(root, "Distance & Growth", false);
  W(_slider(dist, susukiState, "fadeStart", { label: "Fade start", min: 40, max: 400, step: 5, onChange: onStateChanged, hint: "Plumes start thinning here (m)" }));
  W(_slider(dist, susukiState, "fadeEnd",   { label: "Fade end",   min: 60, max: 500, step: 5, onChange: onStateChanged }));
  W(_toggle(dist, susukiState, "castShadows", { label: "Cast shadows", onChange: onStateChanged,
    hint: "Near the camera only. Susuki is tall; without a shadow a field in full sun looks pasted on." }));
  W(_slider(dist, susukiState, "shadowDistance", { label: "Shadow distance", min: 5, max: 90, step: 1, onChange: onStateChanged,
    hint: "Plants closer than this cast, in front of the camera or behind it (m)." }));
  W(_slider(dist, susukiState, "slopeMinY", { label: "Max slope",  min: 0, max: 0.95, step: 0.05, onChange: onStateChanged, hint: "Terrain normal.y below this rejects susuki" }));

  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
  };
}
