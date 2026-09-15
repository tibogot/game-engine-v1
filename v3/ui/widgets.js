/**
 * The editor's panel widgets — ONE copy, used by every panel in v3/ui.
 *
 * Each panel used to carry its own copy of these helpers (8 versions of the
 * slider alone), and they drifted: some snapped typed values, some didn't;
 * some returned a handle, some nothing; six panels used a button class with no
 * CSS at all. This module is the union of what they did.
 *
 * Every value widget binds to `obj[key]`: the control writes the value, then
 * calls `onChange`. Widgets that show a value return a handle with `row` and
 * `refresh()` (re-read `obj[key]` after it changed elsewhere — a preset, a
 * load, undo). Panels import them under their old names, e.g.
 * `import { slider as _slider } from "./widgets.js"`.
 */

export const ARROW_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
export const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

/** Format a number with as many decimals as `step` has. */
export function fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v).toFixed(d);
}

/** Clamp to [min, max] and snap to the step grid (without float noise). */
export function clampSnap(v, min, max, step) {
  if (!Number.isFinite(v)) return min;
  const n = Math.round((v - min) / step);
  let out = min + n * step;
  const stepStr = String(step);
  const decimals = stepStr.includes(".") ? stepStr.split(".")[1].length : 0;
  if (decimals > 0) out = Number(out.toFixed(decimals));
  return Math.min(max, Math.max(min, out));
}

// ── Live values ─────────────────────────────────────────────────────────────
// Every value widget registers here. refreshWidgets() re-reads obj[key] for
// the ones on screen, so a panel shows a change made elsewhere — undo, a
// project load, a preset, the Inspector, the renderer (time of day) — without
// being rebuilt.
const _live = new Set();
function _track(handle) {
  _live.add(handle);
  return handle;
}

/** Write an input's value unless the user is in it, and only if it changed. */
function _setValue(el, v) {
  if (document.activeElement === el || el.value === v) return;
  el.value = v;
}

/**
 * Refresh every visible widget from its object. Cheap enough to call a few
 * times a second: rows that left the page are dropped, hidden ones skipped,
 * and nothing is written unless the value differs.
 * @returns {number} how many were refreshed
 */
export function refreshWidgets() {
  let n = 0;
  for (const h of _live) {
    if (!h.row.isConnected) { _live.delete(h); continue; }
    if (h.row.offsetParent === null) continue;
    h.refresh();
    n++;
  }
  return n;
}

function _row(parent, label, hint) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  const lbl = document.createElement("span");
  lbl.className = "prop-label";
  lbl.innerHTML = label;
  const value = document.createElement("div");
  value.className = "prop-value";
  row.append(lbl, value);
  parent.appendChild(row);
  return { row, value };
}

/** Collapsible section. Returns its body element. */
export function section(parent, title, expanded = true) {
  const sec = document.createElement("div");
  sec.className = "inspector-section";
  const hdr = document.createElement("div");
  hdr.className = "section-header" + (expanded ? "" : " collapsed");
  hdr.setAttribute("data-toggle", "");
  hdr.innerHTML = ARROW_SVG + " " + title;
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

export function separator(parent) {
  const hr = document.createElement("div");
  hr.className = "section-separator";
  parent.appendChild(hr);
  return hr;
}

/**
 * Slider with a number box. `curve: "log"` spreads a wide range (min > 0) so
 * small values get as much travel as large ones. Typed values are clamped and
 * snapped to the step; Enter commits.
 */
export function slider(parent, obj, key, opts) {
  const { label, min, max, step = 0.01, curve, onChange, hint } = opts;
  const isLog = curve === "log" && min > 0 && max > min;
  const logK = isLog ? Math.log(max / min) : 0;
  const valToSlider = (v) => (isLog ? Math.log(Math.max(v, min) / min) / logK : v);
  const sliderToVal = (s) => (isLog ? min * Math.exp(s * logK) : s);

  const { row, value } = _row(parent, label, hint);
  value.innerHTML = `<div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${isLog ? 0 : min}" max="${isLog ? 1 : max}" step="${isLog ? 0.0001 : step}" value="${valToSlider(obj[key])}"><input type="number" class="prop-num-input" title="Type an exact value" min="${min}" max="${max}" step="${step}" value="${fmt(obj[key], step)}"></div>`;
  const sl = value.querySelector(".prop-slider");
  const num = value.querySelector(".prop-num-input");
  const syncNum = () => { num.value = fmt(obj[key], step); };
  const syncSlider = () => { sl.value = String(valToSlider(obj[key])); };

  sl.addEventListener("input", () => {
    obj[key] = clampSnap(sliderToVal(parseFloat(sl.value)), min, max, step);
    syncNum();
    onChange?.();
  });
  num.addEventListener("change", () => {
    const raw = String(num.value).trim();
    const v = parseFloat(raw);
    if (raw === "" || !Number.isFinite(v)) { syncNum(); return; }
    obj[key] = clampSnap(v, min, max, step);
    syncSlider();
    syncNum();
    onChange?.();
  });
  num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
  return _track({
    row,
    refresh() {
      if (document.activeElement === sl) return;   // being dragged
      const target = valToSlider(obj[key]);
      // A range input snaps what it is given: a value between two steps (0.145
      // on a 0.01 slider) reads back as 0.15 forever. Redraw only when the
      // value is a whole step away, or it would be rewritten on every pass.
      if (Math.abs(parseFloat(sl.value) - target) >= (isLog ? 1e-4 : step * 0.999)) syncSlider();
      _setValue(num, fmt(obj[key], step));
    },
  });
}

/**
 * One to three number fields on one row, e.g. a position:
 * `numbers(body, view, ["px", "py", "pz"], { label: "Position", step: 0.1 })`.
 * For values with no sensible slider range (world coordinates). A field
 * commits on Enter or blur, so one typed value is one `onChange` (one undo
 * step). `refresh()` leaves the field being typed in alone.
 */
export function numbers(parent, obj, keys, opts) {
  const { label, step = 0.01, min = -Infinity, max = Infinity, onChange, hint, fieldTitles = [] } = opts;
  const { row, value } = _row(parent, label, hint);
  const wrap = document.createElement("div");
  wrap.className = "prop-numbers";
  value.appendChild(wrap);
  const inputs = keys.map((key, i) => {
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "prop-num-input";
    inp.step = String(step);
    if (Number.isFinite(min)) inp.min = String(min);
    if (Number.isFinite(max)) inp.max = String(max);
    if (fieldTitles[i]) inp.title = fieldTitles[i];
    inp.value = fmt(obj[key], step);
    inp.addEventListener("change", () => {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v)) { inp.value = fmt(obj[key], step); return; }
      obj[key] = Math.min(max, Math.max(min, v));
      inp.value = fmt(obj[key], step);
      onChange?.(key);
    });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") inp.blur(); });
    wrap.appendChild(inp);
    return inp;
  });
  return _track({
    row,
    refresh() {
      keys.forEach((key, i) => _setValue(inputs[i], fmt(obj[key], step)));
    },
  });
}

export function color(parent, obj, key, opts) {
  const { label, onChange, hint } = opts;
  const { row, value } = _row(parent, label, hint);
  value.innerHTML = `<div class="prop-color-wrap"><input type="color" class="prop-color" value="${obj[key]}"><span class="prop-slider-val" style="width:auto">${obj[key]}</span></div>`;
  const inp = value.querySelector(".prop-color");
  const hex = value.querySelector(".prop-slider-val");
  inp.addEventListener("input", () => {
    obj[key] = inp.value;
    hex.textContent = inp.value;
    onChange?.();
  });
  return _track({
    row,
    refresh() {
      const v = typeof obj[key] === "string" ? obj[key].toLowerCase() : null;
      if (!v || document.activeElement === inp) return;   // picker open
      _setValue(inp, v);
      if (hex.textContent !== obj[key]) hex.textContent = obj[key];
    },
  });
}

/** On/off switch. `onChange` receives the new value. */
export function toggle(parent, obj, key, opts) {
  const { label, onChange, hint } = opts;
  const { row, value } = _row(parent, label, hint);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "prop-toggle" + (obj[key] ? " checked" : "");
  btn.innerHTML = CHECK_SVG;
  value.appendChild(btn);
  btn.addEventListener("click", () => {
    obj[key] = !obj[key];
    btn.classList.toggle("checked", !!obj[key]);
    onChange?.(obj[key]);
  });
  return _track({ row, refresh() { btn.classList.toggle("checked", !!obj[key]); } });
}

/**
 * Drop-down list. `options` is `{ "Shown text": value }` or `[[value, "Shown text"], …]`.
 * The chosen value is stored as a number when the setting was a number or every
 * option is one, otherwise as a string.
 */
export function dropdown(parent, obj, key, opts) {
  const { label, options, onChange, hint } = opts;
  const pairs = Array.isArray(options)
    ? options.map(([v, text]) => [text, v])
    : Object.entries(options ?? {});
  const numeric = typeof obj[key] === "number"
    || (pairs.length > 0 && pairs.every(([, v]) => typeof v === "number"));
  const { row, value } = _row(parent, label, hint);
  const sel = document.createElement("select");
  sel.className = "prop-dropdown";
  for (const [text, v] of pairs) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = text;
    sel.appendChild(opt);
  }
  // No matching option (e.g. the setting is still unset): leave the browser's
  // default, the first option, rather than a blank select.
  const select = () => {
    if (document.activeElement === sel) return;   // list open
    const i = pairs.findIndex(([, v]) => String(v) === String(obj[key]));
    if (i >= 0 && sel.selectedIndex !== i) sel.selectedIndex = i;
  };
  select();
  value.appendChild(sel);
  sel.addEventListener("change", () => {
    obj[key] = numeric ? Number(sel.value) : sel.value;
    onChange?.();
  });
  return _track({ row, refresh: select });
}

/** Single-line text field; commits on change (blur or Enter). */
export function text(parent, obj, key, opts) {
  const { label, onChange, hint } = opts;
  const { row, value } = _row(parent, label, hint);
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "prop-dropdown";
  inp.style.width = "100%";
  inp.value = obj[key] ?? "";
  value.appendChild(inp);
  inp.addEventListener("change", () => {
    obj[key] = inp.value;
    onChange?.();
  });
  return _track({ row, refresh() { _setValue(inp, String(obj[key] ?? "")); } });
}

/** Full-width panel button. Returns the button element. */
export function button(parent, { title, onClick, hint, style }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "section-btn";
  btn.textContent = title;
  if (hint) btn.title = hint;
  if (style) btn.style.cssText = style;
  btn.addEventListener("click", onClick);
  parent.appendChild(btn);
  return btn;
}

/**
 * Read-only label / value line. Returns `{ row, update(value) }`.
 * `layout: "prop"` draws it like a control row (label left, value right).
 */
export function info(parent, label, value, { layout = "info" } = {}) {
  const row = document.createElement("div");
  const val = document.createElement("span");
  if (layout === "prop") {
    row.className = "prop-row";
    row.innerHTML = `<span class="prop-label">${label}</span>`;
    val.className = "insp-value";
    val.style.cssText = "text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  } else {
    row.className = "info-row";
    row.innerHTML = `<span class="info-label">${label}</span>`;
    val.className = "info-value";
  }
  val.textContent = value;
  row.appendChild(val);
  parent.appendChild(row);
  return { row, update(v) { val.textContent = v; } };
}

/**
 * Explanatory text under a control group. Plain text by default; `html: true`
 * for markup. `className` swaps the faded row look for a CSS class (e.g.
 * "mode-hint"). Returns the element.
 */
export function hint(parent, content, { html = false, className = null } = {}) {
  const el = document.createElement(className ? "p" : "div");
  if (className) {
    el.className = className;
  } else {
    el.className = "prop-row";
    el.style.cssText = "opacity:0.65;font-size:11px;line-height:1.4;display:block";
  }
  if (html) el.innerHTML = content;
  else el.textContent = content;
  parent.appendChild(el);
  return el;
}
