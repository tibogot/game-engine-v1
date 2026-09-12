/**
 * Texture Library — the "Procedural" source for a paint slot.
 *
 * Presets, pattern, a 3-colour ramp + accent, and a few shape sliders. Every
 * edit calls onChange(params) with a fresh copy; the TextureLibrary coalesces
 * those into bakes, so dragging a slider is safe. The panel owns no bake logic
 * and no slot state — main.js hands it the active slot's params via setParams.
 */
import { PROC_PRESETS, PROC_PATTERNS, procParamsFromPreset, normalizeProcParams } from "../terrain/proceduralLayer.js";

function _fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v).toFixed(d);
}

/**
 * @param {HTMLElement} host
 * @param {object} o
 * @param {(params: object) => void} o.onChange   any edit (sliders, colours, pattern, seed)
 * @param {(params: object) => void} o.onPreset   a preset was picked (params include uvScale)
 */
export function createProceduralLayerPanel(host, { onChange, onPreset }) {
  let params = procParamsFromPreset("stylizedGrass");
  const controls = [];
  const emit = () => onChange({ ...params });

  // ── Preview + preset ──────────────────────────────────────────────────────
  const top = document.createElement("div");
  top.style.cssText = "display:flex;gap:8px;align-items:stretch;margin:6px 0 4px";
  const thumb = document.createElement("div");
  thumb.title = "The baked texture (one tile)";
  thumb.style.cssText = "width:64px;height:64px;flex:none;border-radius:4px;border:1px solid var(--border);background:var(--bg-input) center/cover no-repeat;position:relative";
  const busy = document.createElement("div");
  busy.textContent = "…";
  busy.style.cssText = "position:absolute;right:3px;bottom:1px;font-size:12px;color:var(--text-bright);text-shadow:0 0 3px #000";
  busy.hidden = true;
  thumb.appendChild(busy);
  const col = document.createElement("div");
  col.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;justify-content:center";
  const presetSel = document.createElement("select");
  presetSel.className = "prop-dropdown";
  presetSel.title = "Start from a preset. Sets every value below, and the UV tile.";
  presetSel.innerHTML = `<option value="" disabled>Preset…</option>` +
    Object.entries(PROC_PRESETS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join("");
  const patternSel = document.createElement("select");
  patternSel.className = "prop-dropdown";
  patternSel.title = "The pattern the colours are painted with";
  patternSel.innerHTML = Object.entries(PROC_PATTERNS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join("");
  col.appendChild(presetSel);
  col.appendChild(patternSel);
  top.appendChild(thumb);
  top.appendChild(col);
  host.appendChild(top);

  presetSel.addEventListener("change", () => {
    const seed = params.seed;
    params = procParamsFromPreset(presetSel.value);
    params.seed = seed; // a preset changes the look, not which variation you had
    refresh();
    onPreset({ ...params });
  });
  patternSel.addEventListener("change", () => {
    params.pattern = patternSel.value;
    markCustom();
    refresh();
    emit();
  });

  const markCustom = () => { presetSel.value = ""; params.preset = "custom"; };

  // ── Colours ───────────────────────────────────────────────────────────────
  const swatchRow = document.createElement("div");
  swatchRow.className = "prop-row";
  swatchRow.innerHTML = `<span class="prop-label">Colours</span><div class="prop-value" style="display:flex;gap:4px"></div>`;
  const swatchHost = swatchRow.querySelector(".prop-value");
  for (const [key, tip] of [["dark", "Dark"], ["mid", "Mid"], ["light", "Light"], ["accent", "Accent (flowers, moss, shells…)"]]) {
    const inp = document.createElement("input");
    inp.type = "color";
    inp.className = "prop-color";
    inp.title = tip;
    inp.style.cssText = "flex:1;min-width:0";
    inp.addEventListener("input", () => { params[key] = inp.value; markCustom(); emit(); });
    swatchHost.appendChild(inp);
    controls.push(() => { inp.value = params[key]; });
  }
  host.appendChild(swatchRow);

  // ── Sliders ───────────────────────────────────────────────────────────────
  const slider = (key, { label, min, max, step, hint, labelFn }) => {
    const row = document.createElement("div");
    row.className = "prop-row";
    if (hint) row.title = hint;
    row.innerHTML = `<span class="prop-label"></span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${min}" max="${max}" step="${step}"><input type="number" class="prop-num-input" min="${min}" max="${max}" step="${step}" title="Type an exact value"></div></div>`;
    const lbl = row.querySelector(".prop-label");
    const sl = row.querySelector(".prop-slider");
    const num = row.querySelector(".prop-num-input");
    const set = (v) => {
      if (!Number.isFinite(v)) return;
      params[key] = Math.min(max, Math.max(min, step >= 1 ? Math.round(v) : v));
      sl.value = String(params[key]);
      num.value = _fmt(params[key], step);
      markCustom();
      emit();
    };
    sl.addEventListener("input", () => set(parseFloat(sl.value)));
    num.addEventListener("change", () => set(parseFloat(num.value)));
    num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
    host.appendChild(row);
    controls.push(() => {
      lbl.textContent = labelFn ? labelFn() : label;
      sl.value = String(params[key]);
      num.value = _fmt(params[key], step);
    });
  };

  slider("scale",     { label: "Scale", min: 2, max: 64, step: 1, hint: "How many features fit in one tile. Whole numbers only, so the tile stays seamless." });
  slider("patches",   { label: "Patches", min: 0, max: 1, step: 0.01, hint: "Large soft colour patches across the tile" });
  slider("feature",   { label: "Feature", min: 0, max: 1, step: 0.01, labelFn: () => PROC_PATTERNS[params.pattern].feature, hint: "The pattern's own shape: grass clumps, pebbles, rock cracks, sand ripples" });
  slider("detail",    { label: "Detail", min: 0, max: 1, step: 0.01, hint: "Fine grain" });
  slider("accentAmt", { label: "Accent", min: 0, max: 1, step: 0.01, hint: "How much of the accent colour: flowers on grass, tufts on dirt, moss on rock, shells on sand" });
  slider("rough",     { label: "Roughness", min: 0, max: 1, step: 0.01 });
  slider("bump",      { label: "Bump", min: 0, max: 2, step: 0.01, hint: "Strength of the baked relief in the normal map" });
  slider("ao",        { label: "AO", min: 0, max: 1, step: 0.01, hint: "Darkening in the low parts of the relief" });

  // ── Seed ──────────────────────────────────────────────────────────────────
  const seedRow = document.createElement("div");
  seedRow.className = "prop-row";
  seedRow.title = "A different variation of the same look";
  seedRow.innerHTML = `<span class="prop-label">Seed</span><div class="prop-value" style="display:flex;gap:6px;align-items:center"><input type="number" class="prop-input" min="0" max="9999" step="1" style="flex:1 1 auto;width:auto;min-width:0"><button type="button" class="action-btn" title="Pick a random variation" style="margin:0;padding:2px 10px;flex:0 0 auto;width:auto">New</button></div>`;
  const seedInp = seedRow.querySelector("input");
  const seedBtn = seedRow.querySelector("button");
  seedInp.addEventListener("change", () => {
    const v = parseInt(seedInp.value, 10);
    if (!Number.isFinite(v)) { seedInp.value = params.seed; return; }
    params.seed = Math.min(9999, Math.max(0, v));
    seedInp.value = params.seed;
    emit();
  });
  seedBtn.addEventListener("click", () => {
    params.seed = Math.floor(Math.random() * 10000);
    seedInp.value = params.seed;
    emit();
  });
  host.appendChild(seedRow);
  controls.push(() => { seedInp.value = params.seed; });

  const hint = document.createElement("p");
  hint.className = "mode-hint";
  hint.style.marginTop = "2px";
  hint.textContent = "Generated once into this layer, so it paints and costs exactly like an image layer.";
  host.appendChild(hint);

  function refresh() {
    presetSel.value = PROC_PRESETS[params.preset] ? params.preset : "";
    patternSel.value = params.pattern;
    for (const c of controls) c();
  }
  refresh();

  return {
    /** Show a slot's params (a copy is kept; the caller's object is not mutated). */
    setParams(p) { params = normalizeProcParams(p); refresh(); },
    getParams() { return { ...params }; },
    setThumb(url) { thumb.style.backgroundImage = url ? `url(${url})` : ""; },
    setBusy(on) { busy.hidden = !on; },
  };
}
