import { buildDepthWaterControls } from "./depthWaterControls.js";

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

function _color(parent, obj, key, opts) {
  const { label, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-color-wrap"><input type="color" class="prop-color" value="${obj[key]}"><span class="prop-slider-val" style="width:auto">${obj[key]}</span></div></div>`;
  const inp = row.querySelector(".prop-color");
  const hex = row.querySelector(".prop-slider-val");
  inp.addEventListener("input", () => {
    obj[key] = inp.value;
    hex.textContent = inp.value;
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

function _hint(parent, text) {
  const p = document.createElement("div");
  p.className = "prop-row";
  p.style.cssText = "opacity:0.65;font-size:11px;line-height:1.4;display:block";
  p.textContent = text;
  parent.appendChild(p);
}

/** Handed to the shared depth-water control builder. */
const _widgets = { section: _section, slider: _slider, color: _color, toggle: _toggle, hint: _hint };

function _button(parent, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "prop-action-btn";
  btn.textContent = opts.title;
  if (opts.hint) btn.title = opts.hint;
  btn.addEventListener("click", opts.onClick);
  parent.appendChild(btn);
}

function _buildRiverControls(panel, rp, app, prefix) {
  const body = _section(panel, prefix === "river2" ? "River+ (Auto-Carve)" : "River");
  if (prefix === "river2") {
    _hint(body,
      "Click ground: extend from the selected end (first point selected = trace upstream). " +
      "Select a middle point, then click: start a branch from it. " +
      "Alt-click near the line: insert a point. Handles of every river are clickable.");
  }
  _toggle(body, rp, "showHandles", {
    label: "Show handles",
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _toggle(body, rp, "closed", {
    label: "Close path (loop)",
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _slider(body, rp, "activeRiverIndex", {
    label: "Active river #",
    min: 0,
    max: 63,
    step: 1,
    onChange: () => app[`${prefix}ActiveIndexChanged`]?.(),
  });
  _button(body, { title: "New river", onClick: () => app[`${prefix}NewRiver`]?.() });
  _button(body, { title: "Delete active river", onClick: () => app[`${prefix}DeleteActive`]?.() });
  _button(body, { title: "Delete selected point", onClick: () => app[`${prefix}DeleteSelected`]?.() });
  _slider(body, rp, "selectedPointY", {
    label: "Point Y",
    min: -50,
    max: 200,
    step: 0.1,
    onChange: () => app[`${prefix}SelectedYChanged`]?.(),
  });

  if (prefix === "river2") {
    const carveBody = _section(panel, "Terrain Carving");
    _slider(carveBody, rp, "carveDepth", {
      label: "Carve depth",
      min: 0.1,
      max: 10,
      step: 0.1,
      onChange: () => app.river2CarveChanged?.(),
    });
    _slider(carveBody, rp, "carveShoulder", {
      label: "Blend shoulder",
      min: 0.5,
      max: 20,
      step: 0.5,
      onChange: () => app.river2CarveChanged?.(),
    });
    _slider(carveBody, rp, "bedCurve", {
      label: "Bed curve",
      hint: "0 = flat channel floor, 1 = U-shaped (deeper at the centerline)",
      min: 0,
      max: 1,
      step: 0.05,
      onChange: () => app.river2CarveChanged?.(),
    });
    _slider(carveBody, rp, "maxGorgeDepth", {
      label: "Max gorge depth",
      hint: "Deepest cut below the local ground, in metres. Crossing a hill carves a gorge no deeper than this and the water rides over the pass, instead of a canyon down to valley level.",
      min: 1,
      max: 60,
      step: 0.5,
      onChange: () => app.river2CarveChanged?.(),
    });
    _toggle(carveBody, rp, "branchSnap", {
      label: "Snap branches",
      hint: "Endpoints dropped near another river snap onto it and become a tributary (water levels join up). Off: endpoints stop snapping; existing branches stay linked.",
    });
  }

  const geoBody = _section(panel, "Geometry");
  _slider(geoBody, rp, "width", {
    label: "Width",
    min: 1,
    max: 80,
    step: 0.5,
    // river2: width defines the carve channel too, so re-carve on change
    onChange: () => (prefix === "river2" ? app.river2CarveChanged?.() : app[`${prefix}Changed`]?.()),
  });
  _slider(geoBody, rp, "segments", {
    label: "Segments",
    min: 20,
    max: 900,
    step: 10,
    onChange: () => (prefix === "river2" ? app.river2CarveChanged?.() : app[`${prefix}Changed`]?.()),
  });
  // Negative offsets must be reachable: the carve only ever LOWERS terrain, so a
  // surface at or above the height profile can never meet a bank on flat ground —
  // it just floats. (The Depth style sidesteps this with `waterFreeboard`.)
  _slider(geoBody, rp, "heightOffset", {
    label: "Height offset",
    hint: "Legacy styles only. Metres above the height profile; negative sinks the water into the trench.",
    min: prefix === "river2" ? -2 : -1,
    max: prefix === "river2" ? 1 : 3,
    step: 0.01,
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  if (prefix === "river2") {
    _slider(geoBody, rp, "waterFreeboard", {
      label: "Water freeboard",
      hint: "Depth style only. Metres the surface sits below the height profile, down inside the trench. Kept under Carve depth.",
      min: 0.02,
      max: 5,
      step: 0.02,
      onChange: () => app.river2Changed?.(),
    });
  }

  const matChanged = () =>
    (prefix === "river2" ? (app.river2MaterialChanged ?? app.river2Changed) : app[`${prefix}Changed`])?.();

  const matBody = _section(panel, prefix === "river2" ? "Water Style" : "Material");
  _dropdown(matBody, rp, "shaderStyle", {
    label: "Shader style",
    options: prefix === "river2"
      ? { "Depth (shared w/ lakes)": "Depth", "Toon (GPU)": "Toon", Basic: "Basic" }
      : { Basic: "Basic", "Stylized v1": "Stylized" },
    // Styles expose different controls, so the panel has to be rebuilt, not just synced.
    onChange: () => { app[`${prefix}Changed`]?.(); app.refresh?.(); },
  });

  // Depth style: the exact control set the Lake panel shows, bound to this river's
  // own values. The Toon/Basic sections below are inert in this style, so they are
  // skipped entirely rather than left on screen doing nothing.
  if (prefix === "river2" && rp.shaderStyle === "Depth") {
    _slider(matBody, rp, "flowSpeed", {
      label: "Flow speed",
      hint: "Metres/second downstream. The normal map scrolls along the ribbon's arc length.",
      min: 0, max: 12, step: 0.05, onChange: matChanged,
    });
    buildDepthWaterControls(_widgets, panel, rp.water, app.waterGlobals, matChanged, {
      label: "this river",
    });
    return;
  }

  _color(matBody, rp, "shallowColor", { label: "Shallow", onChange: matChanged });
  _color(matBody, rp, "deepColor", { label: "Deep", onChange: matChanged });
  _color(matBody, rp, "highlightColor", { label: "Highlight", onChange: matChanged });
  _color(matBody, rp, "foamColor", { label: "Foam", onChange: matChanged });
  _slider(matBody, rp, "opacity", {
    label: "Opacity",
    min: 0.05,
    max: 1,
    step: 0.01,
    onChange: matChanged,
  });
  _slider(matBody, rp, "flowSpeed", {
    label: "Flow speed",
    hint: prefix === "river2" ? "Metres per second along the river" : undefined,
    min: 0,
    max: prefix === "river2" ? 10 : 5,
    step: 0.01,
    onChange: matChanged,
  });
  if (prefix !== "river2") {
    _slider(matBody, rp, "foamWidth", {
      label: "Foam width",
      min: 0.01,
      max: 0.6,
      step: 0.01,
      onChange: matChanged,
    });
  }

  if (prefix === "river2") {
    const depthBody = _section(panel, "Depth Bands");
    _slider(depthBody, rp, "bandCount", {
      label: "Bands",
      min: 2,
      max: 6,
      step: 1,
      onChange: matChanged,
    });
    _slider(depthBody, rp, "depthAbsorb", {
      label: "Depth contrast",
      hint: "How fast color shifts from shallow to deep",
      min: 0.05,
      max: 3,
      step: 0.05,
      onChange: matChanged,
    });

    const foamBody = _section(panel, "Foam & Rapids");
    _slider(foamBody, rp, "foamDepth", {
      label: "Shore foam depth",
      hint: "Water shallower than this (metres) grows edge foam",
      min: 0.05,
      max: 3,
      step: 0.05,
      onChange: matChanged,
    });
    _slider(foamBody, rp, "foamScale", {
      label: "Foam scale",
      min: 0.2,
      max: 8,
      step: 0.1,
      onChange: matChanged,
    });
    _slider(foamBody, rp, "rapidsSlope", {
      label: "Rapids slope",
      hint: "Downhill grade where whitewater kicks in",
      min: 0.01,
      max: 0.5,
      step: 0.01,
      onChange: matChanged,
    });
    _slider(foamBody, rp, "rapidsBoost", {
      label: "Rapids boost",
      hint: "Extra flow speed on steep drops",
      min: 0,
      max: 4,
      step: 0.1,
      onChange: matChanged,
    });

    const detailBody = _section(panel, "Surface Detail", false);
    _slider(detailBody, rp, "streakScale", {
      label: "Streak length",
      min: 1,
      max: 30,
      step: 0.5,
      onChange: matChanged,
    });
    _slider(detailBody, rp, "streakStrength", {
      label: "Streak strength",
      min: 0,
      max: 1,
      step: 0.02,
      onChange: matChanged,
    });
    _slider(detailBody, rp, "sparkleStrength", {
      label: "Sparkle",
      min: 0,
      max: 1,
      step: 0.02,
      onChange: matChanged,
    });
    _slider(detailBody, rp, "rimStrength", {
      label: "Glancing sheen",
      min: 0,
      max: 1,
      step: 0.02,
      onChange: matChanged,
    });
  }
}

/** @returns {{ refresh: () => void }} — call refresh() when shaderStyle changes. */
export function buildRiverPanels(app) {
  function refresh() {
    const riverPanel = document.getElementById("river-panel");
    const river2Panel = document.getElementById("river2-panel");
    if (riverPanel) {
      riverPanel.innerHTML = "";
      _buildRiverControls(riverPanel, app.toolState.river, app, "river");
    }
    if (river2Panel) {
      river2Panel.innerHTML = "";
      _buildRiverControls(river2Panel, app.toolState.river2, app, "river2");
    }
  }
  // The shader-style dropdown reaches back through this to rebuild itself.
  app.refresh = refresh;
  refresh();
  return { refresh };
}
