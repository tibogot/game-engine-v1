import { ROAD_PROFILES } from "../../v2/tools/smartRoad/smartRoadLabSystem.js";

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function _fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v).toFixed(d);
}

function _clampSnap(v, min, max, step) {
  if (!Number.isFinite(v)) return min;
  const n = Math.round((v - min) / step);
  let out = min + n * step;
  const stepStr = String(step);
  let decimals = 0;
  if (stepStr.includes(".")) decimals = stepStr.split(".")[1].length;
  if (decimals > 0) out = Number(out.toFixed(decimals));
  return Math.min(max, Math.max(min, out));
}

function _section(parent, title, expanded = true) {
  const sec = document.createElement("div");
  sec.className = "inspector-section";
  const hdr = document.createElement("div");
  hdr.className = "section-header" + (expanded ? "" : " collapsed");
  hdr.setAttribute("data-toggle", "");
  hdr.innerHTML = _arrowSvg + " " + title;
  const body = document.createElement("div");
  body.className = "section-body" + (expanded ? "" : " hidden");
  hdr.addEventListener("click", () => {
    hdr.classList.toggle("collapsed");
    body.classList.toggle("hidden");
  });
  sec.appendChild(hdr);
  sec.appendChild(body);
  parent.appendChild(sec);
  return body;
}

function _slider(parent, obj, key, opts) {
  const { label, min, max, step = 0.01, onChange, hint } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  const cur = obj[key];
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${min}" max="${max}" step="${step}" value="${cur}"><input type="number" class="prop-num-input" min="${min}" max="${max}" step="${step}" value="${_fmt(cur, step)}"></div></div>`;
  const sl = row.querySelector(".prop-slider");
  const num = row.querySelector(".prop-num-input");
  const syncNum = () => { num.value = _fmt(obj[key], step); };
  sl.addEventListener("input", () => {
    obj[key] = _clampSnap(parseFloat(sl.value), min, max, step);
    syncNum();
    onChange?.();
  });
  num.addEventListener("change", () => {
    const v = parseFloat(num.value);
    if (!Number.isFinite(v)) { syncNum(); return; }
    obj[key] = _clampSnap(v, min, max, step);
    sl.value = String(obj[key]);
    syncNum();
    onChange?.();
  });
  parent.appendChild(row);
}

function _toggle(parent, obj, key, opts) {
  const { label, onChange, hint } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><button type="button" class="prop-toggle ${obj[key] ? "checked" : ""}">${_checkSvg}</button></div>`;
  const btn = row.querySelector(".prop-toggle");
  btn.addEventListener("click", () => {
    obj[key] = !obj[key];
    btn.classList.toggle("checked", obj[key]);
    onChange?.();
  });
  parent.appendChild(row);
}

function _dropdown(parent, obj, key, opts) {
  const { label, options, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  let optHtml = "";
  for (const [text, val] of Object.entries(options)) {
    optHtml += `<option value="${val}" ${obj[key] === val ? "selected" : ""}>${text}</option>`;
  }
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><select class="prop-dropdown">${optHtml}</select></div>`;
  row.querySelector(".prop-dropdown").addEventListener("change", (e) => {
    obj[key] = e.target.value;
    onChange?.();
  });
  parent.appendChild(row);
}

function _button(parent, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "prop-action-btn";
  btn.textContent = opts.title;
  if (opts.hint) btn.title = opts.hint;
  btn.addEventListener("click", opts.onClick);
  parent.appendChild(btn);
}

function _hint(parent, html) {
  const div = document.createElement("div");
  div.className = "prop-row";
  div.style.cssText = "display:block;opacity:0.65;font-size:11px;line-height:1.5;padding:4px 8px";
  div.innerHTML = html;
  parent.appendChild(div);
}

export function buildRoadPanel(app) {
  const panel = document.getElementById("road-panel");
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
