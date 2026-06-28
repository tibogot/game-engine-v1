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
  const { label, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
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

function _buildRiverControls(panel, rp, app, prefix) {
  const body = _section(panel, prefix === "river2" ? "River+ (Auto-Carve)" : "River");
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
  }

  const geoBody = _section(panel, "Geometry");
  _slider(geoBody, rp, "width", {
    label: "Width",
    min: 1,
    max: 80,
    step: 0.5,
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _slider(geoBody, rp, "segments", {
    label: "Segments",
    min: 20,
    max: 900,
    step: 10,
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _slider(geoBody, rp, "heightOffset", {
    label: "Height offset",
    min: 0,
    max: prefix === "river2" ? 1 : 3,
    step: 0.01,
    onChange: () => app[`${prefix}Changed`]?.(),
  });

  const matBody = _section(panel, "Material");
  _dropdown(matBody, rp, "shaderStyle", {
    label: "Shader style",
    options: { Basic: "Basic", "Stylized v1": "Stylized" },
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _color(matBody, rp, "shallowColor", { label: "Shallow", onChange: () => app[`${prefix}Changed`]?.() });
  _color(matBody, rp, "deepColor", { label: "Deep", onChange: () => app[`${prefix}Changed`]?.() });
  _color(matBody, rp, "highlightColor", { label: "Highlight", onChange: () => app[`${prefix}Changed`]?.() });
  _color(matBody, rp, "foamColor", { label: "Foam", onChange: () => app[`${prefix}Changed`]?.() });
  _slider(matBody, rp, "foamWidth", {
    label: "Foam width",
    min: 0.01,
    max: 0.6,
    step: 0.01,
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _slider(matBody, rp, "opacity", {
    label: "Opacity",
    min: 0.05,
    max: 1,
    step: 0.01,
    onChange: () => app[`${prefix}Changed`]?.(),
  });
  _slider(matBody, rp, "flowSpeed", {
    label: "Flow speed",
    min: 0,
    max: 5,
    step: 0.01,
    onChange: () => app[`${prefix}Changed`]?.(),
  });
}

export function buildRiverPanels(app) {
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
