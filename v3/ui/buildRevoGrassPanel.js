import { section, slider, color, toggle, dropdown, hint } from "./widgets.js";
import { REVO_GRASS_QUALITY } from "../app/state/revoGrassState.js";

/**
 * The revo grass system's own controls, built into #revo-grass-panel and shown
 * only while that system is the one running. The Grass panel's shared parts —
 * Paint Density, Terrain (the slope rule) and Interaction — stay visible above
 * it, because those mean the same thing whichever system draws the blades.
 *
 * Callbacks:
 *   onStateChanged()     a uniform changed
 *   onGeometryChanged()  blade shape, grid or tile changed — a rebuild
 */
export function buildRevoGrassPanel(root, { revoGrassState: rp, onStateChanged, onGeometryChanged }) {
  // A rebuild reallocates buffers and re-runs the init pass, so a slider drag
  // coalesces into one per frame rather than one per input event.
  let queued = false;
  const geometryChanged = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; onGeometryChanged?.(); });
  };

  root.innerHTML = "";

  const fld = section(root, "Field");
  dropdown(fld, rp, "quality", {
    label: "Quality",
    options: Object.entries(REVO_GRASS_QUALITY).map(([k, q]) => [k, q.label]),
    onChange: geometryChanged,
    hint: "How many blades the tile holds. Every one of them is simulated, so this is the cost dial.",
  });
  slider(fld, rp, "tileSize", { label: "Tile size (m)", min: 40, max: 260, step: 5, onChange: geometryChanged,
    hint: "The square that follows you. Bigger reaches further with the same blades spread thinner." });
  slider(fld, rp, "density", { label: "Density", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "Multiplies the painted density — the whole field at once." });
  slider(fld, rp, "fadeStart", { label: "Full density to (m)", min: 4, max: 120, step: 1, onChange: onStateChanged });
  slider(fld, rp, "fadeEnd", { label: "Thinned out by (m)", min: 10, max: 260, step: 1, onChange: onStateChanged,
    hint: "Blades thin out between these two, then the ground takes over their colour." });
  slider(fld, rp, "fadeKeep", { label: "Keep at the edge", min: 0.02, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "The fraction still standing at the far edge. Low is cheap; too low is a visible ring." });

  const bl = section(root, "Blade");
  slider(bl, rp, "bladeHeight", { label: "Height (m)", min: 0.2, max: 3, step: 0.05, onChange: geometryChanged });
  slider(bl, rp, "bladeWidth", { label: "Width (m)", min: 0.01, max: 0.3, step: 0.005, onChange: geometryChanged });
  slider(bl, rp, "segments", { label: "Segments", min: 1, max: 8, step: 1, onChange: geometryChanged,
    hint: "Rows along the blade. More curve, more vertices — at this blade count that is the whole cost." });
  slider(bl, rp, "bladeMinScale", { label: "Shortest", min: 0.2, max: 1.5, step: 0.05, onChange: onStateChanged });
  slider(bl, rp, "bladeMaxScale", { label: "Tallest", min: 0.5, max: 3, step: 0.05, onChange: onStateChanged });
  slider(bl, rp, "clumpStrength", { label: "Clumping", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "0 = every blade its own size. 1 = patches of one size, like grass that grew together." });
  slider(bl, rp, "clumpScale", { label: "Clump size (m)", min: 0.5, max: 8, step: 0.1, onChange: onStateChanged });
  slider(bl, rp, "lean", { label: "Resting lean", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "How far a blade leans with no wind at all. 0 stands the whole field to attention." });
  slider(bl, rp, "minPixels", { label: "Min width (px)", min: 0, max: 4, step: 0.1, onChange: onStateChanged,
    hint: "Distant blades grow rather than shrink below this screen width. 0 turns it off — and the far field will shimmer." });

  const col = section(root, "Colour");
  color(col, rp, "baseColor", { label: "Root", onChange: onStateChanged });
  color(col, rp, "tipColor", { label: "Tip", onChange: onStateChanged });
  slider(col, rp, "colorMix", { label: "Tip reach", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "How far down the blade the tip colour comes." });
  slider(col, rp, "colorVariation", { label: "Variation", min: 0.1, max: 5, step: 0.05, onChange: onStateChanged });
  slider(col, rp, "brightness", { label: "Brightness", min: 0.2, max: 2, step: 0.01, onChange: onStateChanged });
  slider(col, rp, "aoScale", { label: "Root shade", min: 0, max: 1, step: 0.01, onChange: onStateChanged });
  slider(col, rp, "aoRadius", { label: "Root shade to (m)", min: 2, max: 60, step: 1, onChange: onStateChanged });
  toggle(col, rp, "receiveShadow", { label: "Receive shadows", onChange: onStateChanged });

  const wd = section(root, "Wind");
  slider(wd, rp, "windStrength", { label: "Strength", min: 0, max: 2, step: 0.01, onChange: onStateChanged });
  slider(wd, rp, "windSpeed", { label: "Speed", min: 0, max: 2, step: 0.01, onChange: onStateChanged });
  slider(wd, rp, "windIntensity", { label: "Gust", min: 0, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "Ramps the calm strength up to a full gust." });
  slider(wd, rp, "windAngle", { label: "Direction (deg)", min: 0, max: 360, step: 5, onChange: onStateChanged });
  slider(wd, rp, "windScale", { label: "Gust size", min: 0.2, max: 6, step: 0.05, onChange: onStateChanged,
    hint: "Bigger = broader waves crossing the field." });
  slider(wd, rp, "bend", { label: "Bend", min: 0, max: 5, step: 0.05, onChange: onStateChanged,
    hint: "How far a blade leans under the wind and under anything pushing it." });
  slider(wd, rp, "windColor", { label: "Gust tint", min: 0, max: 2, step: 0.01, onChange: onStateChanged });
  slider(wd, rp, "baseWindShade", { label: "Root darkening", min: 0, max: 1, step: 0.01, onChange: onStateChanged });

  const push = section(root, "Push");
  hint(push, "Anything that touches the grass writes to the same push field the hybrid blades read: the player, a car's wheels, a game's own objects.");
  slider(push, rp, "pushBend", { label: "Lay over", min: 0, max: 3, step: 0.05, onChange: onStateChanged });
  slider(push, rp, "crushMin", { label: "Crushed height", min: 0.05, max: 1, step: 0.01, onChange: onStateChanged,
    hint: "How short a fully flattened blade gets. 1 = it only leans." });
}
