import { buildDepthWaterControls } from "./depthWaterControls.js";
import { section as _section, slider as _slider, color as _color, toggle as _toggle, button as _button, hint as _hint } from "./widgets.js";
import { uiById } from "./uiRoot.js";

/**
 * @param {object}   app
 * @param {object}   app.toolState        — has a `.lake` slice
 * @param {object}   app.lakeSystem
 * @param {number}   app.worldSize
 * @param {number}   app.maxHeight
 * @param {function} app.materialChanged  — shared material params changed
 * @param {function} app.lakebedChanged   — underwater terrain shading params changed
 * @param {function} app.transformChanged — active lake bounds/level changed
 * @param {function} app.selectionChanged — active lake index changed / lake deleted
 * @returns {{ refresh: () => void }}
 */
export function buildLakePanel(app) {
  const panel = uiById("lake-panel");
  if (!panel) return { refresh: () => {} };

  function refresh() {
    panel.innerHTML = "";
    const lp = app.toolState.lake;
    const sys = app.lakeSystem;
    const count = sys.lakes.length;

    // ── Lakes ───────────────────────────────────────────────────────────────
    const lakes = _section(panel, `Lakes (${count})`, true);
    if (count === 0) {
      _hint(lakes, "Drag on the terrain to place a lake. The water level starts at the terrain height where you began the drag; the shoreline is derived from the depth buffer, so the rectangle only has to be roughly right.");
    } else {
      _slider(lakes, lp, "activeIndex", {
        label: "Active", min: 0, max: count - 1, step: 1,
        onChange: () => { sys.setActiveIndex(lp.activeIndex); app.selectionChanged?.(); refresh(); },
      });
      _toggle(lakes, lp, "showBounds", {
        label: "Show bounds",
        onChange: () => sys.refreshBoundsVisibility(),
      });
      _button(lakes, {
        title: "Delete active lake",
        onClick: () => { sys.deleteActive(); app.selectionChanged?.(); refresh(); },
      });
    }

    // ── Active lake transform ───────────────────────────────────────────────
    const active = sys.active;
    if (active) {
      const t = _section(panel, "Placement", true);
      const onT = () => { sys.syncActiveTransform(); app.transformChanged?.(); };
      const half = app.worldSize / 2;
      _slider(t, active, "level", { label: "Water level", min: 0, max: app.maxHeight, step: 0.1, onChange: onT,
        hint: "Terrain above this height is dry; below it is underwater." });
      _slider(t, active, "cx",    { label: "Center X", min: -half, max: half, step: 1, onChange: onT });
      _slider(t, active, "cz",    { label: "Center Z", min: -half, max: half, step: 1, onChange: onT });
      _slider(t, active, "sizeX", { label: "Size X", min: 4, max: app.worldSize, step: 1, onChange: onT });
      _slider(t, active, "sizeZ", { label: "Size Z", min: 4, max: app.worldSize, step: 1, onChange: onT });
    }

    // Flow is lake-specific: lakes drift with a wind angle, rivers flow downstream.
    const onM = () => app.materialChanged?.();
    const surfExtra = (body) => {
      _slider(body, lp, 'flowSpeed', { label: 'Drift speed', min: 0, max: 1, step: 0.01, onChange: onM });
      _slider(body, lp, 'flowAngle', { label: 'Drift angle', min: 0, max: 360, step: 1, onChange: onM });
    };

    buildDepthWaterControls(panel, lp.water, app.waterGlobals, onM, {
      label: 'this lake',
      extraSurface: surfExtra,
    });

    // ── Lakebed (underwater terrain) ────────────────────────────────────────
    // Rendered by the TERRAIN shader, not the water: sand + depth tint +
    // caustics under every water surface, rivers included. One global set.
    const lb = lp.lakebed;
    if (lb) {
      const onB = () => app.lakebedChanged?.();
      const bed = _section(panel, "Lakebed (underwater terrain)", false);
      _hint(bed, "Shades the ground under EVERY water surface — lakes and rivers alike. Sand colour, a deep-water tint and animated caustics, drawn by the terrain itself.");
      _toggle(bed, lb, "enabled", { label: "Enabled", onChange: onB });
      _color(bed, lb, "sandColor", { label: "Sand colour", onChange: onB });
      _slider(bed, lb, "sandMix", { label: "Sand mix", min: 0, max: 1, step: 0.01, onChange: onB,
        hint: "How much the sand replaces the painted terrain. 1 = full sand bed (reference look), 0 = keep the splat textures." });
      _color(bed, lb, "deepColor", { label: "Deep tint", onChange: onB });
      _slider(bed, lb, "tintDepth", { label: "Tint depth (m)", min: 0.5, max: 30, step: 0.5, onChange: onB,
        hint: "Metres of water at which the deep tint is fully in." });
      _slider(bed, lb, "shallowBoost", { label: "Shallow boost", min: 0, max: 3, step: 0.05, onChange: onB,
        hint: "Warm sand highlight in the first metres of water." });
      _slider(bed, lb, "shallowDepth", { label: "Shallow depth (m)", min: 0.1, max: 6, step: 0.1, onChange: onB });
      _color(bed, lb, "causticsColor", { label: "Caustics colour", onChange: onB });
      _slider(bed, lb, "causticsIntensity", { label: "Caustics intensity", min: 0, max: 3, step: 0.01, onChange: onB });
      _slider(bed, lb, "causticsScale", { label: "Caustics scale", min: 0.02, max: 0.6, step: 0.005, onChange: onB,
        hint: "Pattern tiles per metre. Higher = smaller, busier filaments." });
      _slider(bed, lb, "causticsSharpness", { label: "Caustics sharpness", min: 1, max: 16, step: 0.5, onChange: onB,
        hint: "Pinches the light net into thinner, brighter filaments." });
      _slider(bed, lb, "causticsDispersion", { label: "Caustics dispersion", min: 0, max: 1, step: 0.01, onChange: onB,
        hint: "Chromatic fringing — red/blue split on the filament edges, like real refracted light." });
      _slider(bed, lb, "causticsSpeed", { label: "Caustics speed", min: 0, max: 2, step: 0.01, onChange: onB });
      _slider(bed, lb, "causticsMinDepth", { label: "Caustics min depth (m)", min: 0, max: 3, step: 0.05, onChange: onB,
        hint: "Caustics fade IN over this much water. Light needs depth to focus through, so at 0 they appear right at the waterline — which on a river's shallow rim reads as caustics on dry sand." });
      _slider(bed, lb, "causticsMaxDepth", { label: "Caustics max depth (m)", min: 1, max: 30, step: 0.5, onChange: onB,
        hint: "Caustics fade out by this depth — light stops reaching the bed." });
      _slider(bed, lb, "shoreBlend", { label: "Shore blend (m)", min: 0.02, max: 3, step: 0.01, onChange: onB,
        hint: "Metres of depth over which the whole treatment fades in at the waterline." });
    }
  }

  refresh();
  return { refresh };
}
