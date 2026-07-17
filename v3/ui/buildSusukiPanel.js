/**
 * Susuki mode panel — paint brush + plant/plume appearance controls.
 * Built dynamically into #susuki-panel (same pattern as buildLakePanel).
 *
 * Callbacks:
 *   onBrushChanged()      brush radius changed (cursor ring update)
 *   onStateChanged()      any uniform-driven appearance param changed
 *   onPlumeGeoChanged()   plumeWidth / plumeHeight / plumeDroop (geometry bake)
 *   onStemGeoChanged()    stemWidth (geometry bake)
 *   onTextureChanged()    plume strand texture params (canvas redraw)
 *   onFill() / onClear()  fill / clear the painted density layer
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

function _slider(parent, obj, key, { label, min, max, step = 0.01, onChange, hint }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
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

function _toggle(parent, obj, key, { label, onChange, hint }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
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

export function buildSusukiPanel(root, {
  susukiBrush,
  susukiState,
  onBrushChanged,
  onStateChanged,
  onPlumeGeoChanged,
  onStemGeoChanged,
  onTextureChanged,
  onFill,
  onClear,
}) {
  root.innerHTML = "";
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };

  // ── Paint ──
  const paint = _section(root, "Paint Susuki");
  W(_slider(paint, susukiBrush, "radius",   { label: "Radius",   min: 5, max: 300, step: 5, onChange: onBrushChanged }));
  W(_slider(paint, susukiBrush, "strength", { label: "Strength", min: 0.05, max: 1, step: 0.05 }));
  W(_slider(paint, susukiBrush, "falloff",  { label: "Falloff",  min: 0.5, max: 6, step: 0.1 }));
  W(_toggle(paint, susukiBrush, "erase",    { label: "Erase", hint: "Alt+paint also erases" }));
  const hint = document.createElement("p");
  hint.className = "mode-hint";
  hint.innerHTML = "<kbd>Alt</kbd>+paint = erase · <kbd>Shift</kbd>/<kbd>Alt</kbd>+wheel = radius/strength";
  paint.appendChild(hint);
  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:4px;margin-top:4px";
  btnRow.innerHTML =
    '<button type="button" class="action-btn primary" style="flex:1">Fill all</button>' +
    '<button type="button" class="action-btn" style="flex:1;color:#f66">Clear all</button>';
  btnRow.children[0].addEventListener("click", () => onFill?.());
  btnRow.children[1].addEventListener("click", () => onClear?.());
  paint.appendChild(btnRow);

  // ── Plants ──
  const plants = _section(root, "Plants");
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
  W(_slider(dist, susukiState, "slopeMinY", { label: "Max slope",  min: 0, max: 0.95, step: 0.05, onChange: onStateChanged, hint: "Terrain normal.y below this rejects susuki" }));

  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
  };
}
