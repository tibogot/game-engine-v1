/**
 * Procedural Ground (TSL) — the v2 base-terrain texture controls, ported to
 * the v3 paint panel. Drives the shared createGroundTslBundle uniforms (base
 * color + brightness/contrast + 2 masked noise layers, 5 noise types, FBM).
 * Appended as an extra section at the bottom of #paint-panel.
 *
 * Callbacks:
 *   onChanged()  any param changed → sync bundle uniforms + retint grass
 */
const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function _fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v).toFixed(d);
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

function _slider(parent, obj, key, { label, min, max, step = 0.01, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML =
    `<span class="prop-label">${label}</span><div class="prop-value">` +
    `<input type="range" min="${min}" max="${max}" step="${step}" value="${obj[key]}" />` +
    `<span class="prop-num">${_fmt(obj[key], step)}</span></div>`;
  const sl = row.querySelector("input");
  const num = row.querySelector(".prop-num");
  sl.addEventListener("input", () => {
    obj[key] = parseFloat(sl.value);
    num.textContent = _fmt(obj[key], step);
    onChange?.();
  });
  parent.appendChild(row);
  return { refresh() { sl.value = String(obj[key]); num.textContent = _fmt(obj[key], step); } };
}

function _color(parent, obj, key, { label, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML =
    `<span class="prop-label">${label}</span><div class="prop-value">` +
    `<input type="color" value="${obj[key]}" style="width:36px;height:22px;border:none;padding:0;cursor:pointer;background:none;border-radius:3px" /></div>`;
  const inp = row.querySelector("input");
  inp.addEventListener("input", () => { obj[key] = inp.value; onChange?.(); });
  parent.appendChild(row);
  return { refresh() { inp.value = obj[key]; } };
}

function _toggle(parent, obj, key, { label, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML =
    `<span class="prop-label">${label}</span><div class="prop-value">` +
    `<button type="button" class="prop-toggle ${obj[key] ? "checked" : ""}">${_checkSvg}</button></div>`;
  const btn = row.querySelector(".prop-toggle");
  btn.addEventListener("click", () => {
    obj[key] = !obj[key];
    btn.classList.toggle("checked", obj[key]);
    onChange?.();
  });
  parent.appendChild(row);
  return { refresh() { btn.classList.toggle("checked", !!obj[key]); } };
}

function _select(parent, obj, key, { label, options, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  const opts = options
    .map((o) => `<option value="${o}" ${obj[key] === o ? "selected" : ""}>${o}</option>`)
    .join("");
  row.innerHTML =
    `<span class="prop-label">${label}</span><div class="prop-value">` +
    `<select class="prop-dropdown">${opts}</select></div>`;
  const sel = row.querySelector("select");
  sel.addEventListener("change", () => { obj[key] = sel.value; onChange?.(); });
  parent.appendChild(row);
  return { refresh() { sel.value = obj[key]; } };
}

function _layerControls(parent, L, title, onChanged, widgets) {
  const W = (w) => { widgets.push(w); return w; };
  const body = _section(parent, title, false);
  W(_toggle(body, L, "enable", { label: "Enable", onChange: onChanged }));
  W(_select(body, L, "noiseType", {
    label: "Noise",
    options: ["value", "perlin", "simplex", "voronoi", "white"],
    onChange: onChanged,
  }));
  W(_color(body, L, "color", { label: "Color", onChange: onChanged }));
  W(_slider(body, L, "strength",   { label: "Strength", min: 0, max: 1, step: 0.02, onChange: onChanged }));
  W(_slider(body, L, "scale",      { label: "Scale",    min: 0.001, max: 0.2, step: 0.001, onChange: onChanged }));
  W(_toggle(body, L, "useFbm",     { label: "FBM (perlin)", onChange: onChanged }));
  W(_slider(body, L, "octaves",    { label: "Octaves",  min: 1, max: 6, step: 0.5, onChange: onChanged }));
  W(_slider(body, L, "lacunarity", { label: "Lacunarity", min: 1.5, max: 3, step: 0.05, onChange: onChanged }));
  W(_slider(body, L, "gain",       { label: "Gain",     min: 0.2, max: 0.8, step: 0.02, onChange: onChanged }));
  W(_slider(body, L, "offsetX",    { label: "Offset X", min: -100, max: 100, step: 0.5, onChange: onChanged }));
  W(_slider(body, L, "offsetY",    { label: "Offset Y", min: -100, max: 100, step: 0.5, onChange: onChanged }));
  W(_toggle(body, L, "invert",     { label: "Invert",   onChange: onChanged }));
  W(_slider(body, L, "maskLow",    { label: "Mask low", min: 0, max: 1, step: 0.02, onChange: onChanged }));
  W(_slider(body, L, "maskHigh",   { label: "Mask high", min: 0, max: 1, step: 0.02, onChange: onChanged }));
  W(_slider(body, L, "maskSharpness", { label: "Mask sharp", min: 0.2, max: 3, step: 0.05, onChange: onChanged }));
  W(_slider(body, L, "voronoiJitter", { label: "Voro jitter", min: 0, max: 1, step: 0.05, onChange: onChanged }));
}

/**
 * @param root            #paint-panel element (section is appended at its end)
 * @param groundTslState  { enabled, brightness, contrast, baseColor, layer1, layer2 }
 * @param presets         GROUND_PRESETS map (id → params)
 * @param applyPreset     (id) => void — copies preset into state (caller syncs)
 * @param onChanged       () => void
 */
export function buildGroundTslPanel(root, { groundTslState, presets, applyPreset, onChanged }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  const body = _section(root, "Procedural Ground (TSL)", false);
  const note = document.createElement("p");
  note.className = "mode-hint";
  note.textContent =
    "v2's procedural base ground. Replaces the grey tile under the splat layers — "
    + "match it to your grass roots for that full-field look.";
  body.appendChild(note);

  W(_toggle(body, groundTslState, "enabled", { label: "Enable", onChange: onChanged }));

  // Preset row
  const presetRow = document.createElement("div");
  presetRow.className = "prop-row";
  const ids = Object.keys(presets);
  presetRow.innerHTML =
    `<span class="prop-label">Preset</span><div class="prop-value">` +
    `<select class="prop-dropdown">${ids.map((i) => `<option value="${i}">${i}</option>`).join("")}</select>` +
    `<button type="button" class="action-btn" style="margin-left:4px">Apply</button></div>`;
  const presetSel = presetRow.querySelector("select");
  presetRow.querySelector("button").addEventListener("click", () => {
    applyPreset(presetSel.value);
    for (const w of widgets) w.refresh?.();
    onChanged?.();
  });
  body.appendChild(presetRow);

  W(_color(body, groundTslState, "baseColor", { label: "Base color", onChange: onChanged }));
  W(_slider(body, groundTslState, "brightness", { label: "Brightness", min: 0.2, max: 2, step: 0.02, onChange: onChanged }));
  W(_slider(body, groundTslState, "contrast",   { label: "Contrast",   min: 0.3, max: 2, step: 0.02, onChange: onChanged }));

  _layerControls(body, groundTslState.layer1, "Noise Layer 1", onChanged, widgets);
  _layerControls(body, groundTslState.layer2, "Noise Layer 2", onChanged, widgets);

  // ── Slope / height band rules (v3 extension) ──
  const bands = _section(body, "Slope & Height Tint", false);
  const bandNote = document.createElement("p");
  bandNote.className = "mode-hint";
  bandNote.textContent =
    "Recolor steep slopes and high altitudes procedurally (rock faces, snowy "
    + "summits, beach lines) — noise-broken bands, no image textures.";
  bands.appendChild(bandNote);
  W(_toggle(bands, groundTslState.slopeTint, "enabled", { label: "Slope tint", onChange: onChanged }));
  W(_color(bands, groundTslState.slopeTint, "color", { label: "Slope color", onChange: onChanged }));
  W(_slider(bands, groundTslState.slopeTint, "startDeg", { label: "Slope start °", min: 5, max: 85, step: 1, onChange: onChanged }));
  W(_slider(bands, groundTslState.slopeTint, "endDeg",   { label: "Slope full °",  min: 10, max: 89, step: 1, onChange: onChanged }));
  W(_toggle(bands, groundTslState.heightTint, "enabled", { label: "Height tint", onChange: onChanged }));
  W(_color(bands, groundTslState.heightTint, "color", { label: "Height color", onChange: onChanged }));
  W(_slider(bands, groundTslState.heightTint, "start", { label: "Height start", min: 0, max: 500, step: 5, onChange: onChanged }));
  W(_slider(bands, groundTslState.heightTint, "end",   { label: "Height full",  min: 0, max: 600, step: 5, onChange: onChanged }));
  W(_slider(bands, groundTslState, "bandNoise", { label: "Band breakup", min: 0, max: 1, step: 0.05, onChange: onChanged }));

  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
  };
}
