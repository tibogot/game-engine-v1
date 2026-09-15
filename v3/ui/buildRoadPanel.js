import { ROAD_PROFILES } from "../../v2/tools/smartRoad/smartRoadLabSystem.js";
import { section as _section, slider as _slider, toggle as _toggle, dropdown as _dropdown, button as _button, hint } from "./widgets.js";
import { uiById } from "./uiRoot.js";
const _hint = (parent, html) => hint(parent, html, { html: true });

export function buildRoadPanel(app) {
  const panel = uiById("road-panel");
  if (!panel) return;
  panel.innerHTML = "";
  const rp = app.toolState.road;
  const changed = () => app.roadChanged?.();

  const netBody = _section(panel, "Smart Road Network");
  _hint(netBody,
    "<b>Shift-click</b> ground: add node (chains from selection)<br>" +
    "<b>Drag</b> sphere: move node &nbsp;·&nbsp; <b>Ctrl-click</b> node: connect/disconnect<br>" +
    "<b>Drag</b> purple edge handle: bend road<br>" +
    "<b>J</b> junction/roundabout &nbsp;·&nbsp; <b>B</b> bridge (grabbed edge)<br>" +
    "<b>+/−</b> node lift (Shift = fine) &nbsp;·&nbsp; <b>Del</b> delete node");
  _toggle(netBody, rp, "showHandles", { label: "Show handles", onChange: () => app.roadHandlesChanged?.() });
  _button(netBody, { title: "Clear network", onClick: () => app.roadClearAll?.() });
  _button(netBody, { title: "Export roads (.json)", onClick: () => app.roadExport?.() });
  _button(netBody, { title: "Import roads", onClick: () => app.roadImport?.() });

  const geoBody = _section(panel, "Geometry");
  _slider(geoBody, rp, "width", { label: "Width (m)", min: 4, max: 40, step: 0.5, onChange: changed });
  _slider(geoBody, rp, "lanesPerDir", { label: "Lanes / dir", min: 1, max: 4, step: 1, onChange: changed });
  _slider(geoBody, rp, "junctionRadius", { label: "Junction radius", min: 6, max: 40, step: 0.5, onChange: changed });
  _slider(geoBody, rp, "roundaboutRadius", { label: "Roundabout radius", min: 8, max: 50, step: 0.5, onChange: changed });
  _dropdown(geoBody, rp, "twoRoadNodes", { label: "Bends", options: { Smooth: "smooth", Junction: "junction" }, onChange: changed });
  _dropdown(geoBody, rp, "endCapStyle", { label: "End caps", options: { Round: "round", Flat: "flat" }, onChange: changed });
  const profileOptions = {};
  for (const [k, v] of Object.entries(ROAD_PROFILES)) profileOptions[v.label] = k;
  _dropdown(geoBody, rp, "profilePreset", { label: "Profile", options: profileOptions, onChange: changed });
  _slider(geoBody, rp, "profileScale", { label: "Profile scale", min: 0, max: 3, step: 0.05, onChange: changed });
  _slider(geoBody, rp, "smoothRadius", { label: "Smooth radius", hint: "Terrain low-pass under the road — bigger = road irons out bumps more", min: 2, max: 60, step: 1, onChange: changed });
  _slider(geoBody, rp, "clearance", { label: "Clearance", hint: "Deck height above the (graded) terrain", min: 0.02, max: 0.5, step: 0.01, onChange: changed });
  _slider(geoBody, rp, "skirtDepth", { label: "Skirt depth", min: 0, max: 3, step: 0.05, onChange: changed });
  _toggle(geoBody, rp, "sidewalk", { label: "Sidewalks", onChange: changed });
  _slider(geoBody, rp, "sidewalkWidth", { label: "Sidewalk width", min: 0.5, max: 6, step: 0.1, onChange: changed });
  _slider(geoBody, rp, "curbHeight", { label: "Curb height", min: 0.05, max: 0.5, step: 0.01, onChange: changed });

  const markBody = _section(panel, "Markings", false);
  _toggle(markBody, rp, "centerLine", { label: "Center line", onChange: changed });
  _toggle(markBody, rp, "centerLineDashed", { label: "Dashed center", onChange: changed });
  _toggle(markBody, rp, "doubleCenterLine", { label: "Double center", onChange: changed });
  _toggle(markBody, rp, "laneLines", { label: "Lane lines", onChange: changed });
  _slider(markBody, rp, "lineWidth", { label: "Edge line width", min: 0.005, max: 0.06, step: 0.001, onChange: changed });
  _slider(markBody, rp, "dashScale", { label: "Dash scale", min: 0.02, max: 0.3, step: 0.005, onChange: changed });

  const terrBody = _section(panel, "Terrain Grade");
  _toggle(terrBody, rp, "liveGrade", {
    label: "Live grade",
    hint: "Re-flatten the terrain to the road after every network edit (non-destructive until baked)",
    onChange: () => app.roadLiveGradeChanged?.(),
  });
  _slider(terrBody, rp, "flattenDepth", { label: "Embed depth", hint: "Terrain sits this far below the deck", min: 0, max: 1.5, step: 0.05, onChange: () => app.roadGradeParamsChanged?.() });
  _slider(terrBody, rp, "shoulder", { label: "Shoulder (m)", hint: "Blend band from graded road edge back to natural ground", min: 1, max: 30, step: 0.5, onChange: () => app.roadGradeParamsChanged?.() });
  _button(terrBody, { title: "Bake grade into terrain", hint: "Make the current grade permanent (new baseline)", onClick: () => app.roadBakeGrade?.() });
  _button(terrBody, { title: "Remove grade", hint: "Restore terrain under roads to the pre-grade baseline", onClick: () => app.roadRemoveGrade?.() });
}
