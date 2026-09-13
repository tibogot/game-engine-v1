/**
 * Brush filter — restrict a sculpt or paint brush to ground inside a height
 * band, a slope band and/or a concavity test, the way Unity's Terrain Tools
 * brush filters do.
 *
 * CONCAVITY measures how far a point sits below (concave: a crease, a valley
 * floor, the foot of a slope) or above (convex: a ridge, a hilltop, a cliff lip)
 * the average of 8 heights on a ring of `concavityRadius` metres around it. The
 * radius picks the scale: a few metres finds small creases, tens of metres whole
 * valleys. The test is fully on from `concavityMin` metres of depth (or height,
 * for convex) and fades out over `concavitySoft` below that.
 *
 * One UI component, one state shape, two implementations of the SAME maths:
 *   sculpt → sculptBrush.js, on the GPU, inside the shared brush falloff
 *   paint  → splatMap.js, on the CPU, inside the stroke loop
 *
 * Each mode owns its OWN state object on purpose. Filters are tool settings,
 * and a slope band set up for painting cliffs must not silently make the smooth
 * brush "stop working" when you switch to sculpt. The section header shows the
 * active filter even while collapsed, so a live constraint is never hidden.
 *
 * Bands are FULLY ON inside [min, max] and fade to zero over `soft` outside
 * them, so "min 40 m" means full effect from exactly 40 m, not half.
 * Both filters off = no effect at all (the sculpt mask is exactly 1.0).
 */

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

/** Default filter state. Both bands off, so creating one changes nothing. */
export function createBrushFilterState(maxHeight = 500) {
  return {
    heightOn: false,
    heightMin: 0,
    heightMax: Math.round(maxHeight),
    heightSoft: 5,
    slopeOn: false,
    // "Steep ground only" is the common reason to reach for a slope filter,
    // so switching it on does something visible straight away.
    slopeMin: 30,
    slopeMax: 90,
    slopeSoft: 3,
    concavityOn: false,
    concavityMode: "concave", // "concave" | "convex"
    concavityRadius: 8,       // metres
    concavityMin: 0.5,        // metres of depth for full effect
    concavitySoft: 1,         // metres over which it fades out
  };
}

/**
 * The concavity test's mask for a measured `depth` = ring average − centre
 * height, in metres (positive in a hollow). Shared shape for GPU and CPU:
 * full at depth ≥ min, fading to 0 at min − soft. Convex flips the sign.
 */
export function concavityMaskCpu(depth, mode, min, soft) {
  const d = mode === "convex" ? -depth : depth;
  const w = Math.max(soft, 1e-4);
  const e0 = min - w, e1 = min;
  const t = Math.max(0, Math.min(1, (d - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function _fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v).toFixed(d);
}

function _clampSnap(v, min, max, step) {
  if (!Number.isFinite(v)) return min;
  const n = Math.round((v - min) / step);
  let out = min + n * step;
  const s = String(step);
  if (s.includes(".")) out = Number(out.toFixed(s.split(".")[1].length));
  return Math.min(max, Math.max(min, out));
}

function _slider(parent, obj, key, { label, min, max, step = 1, hint, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${min}" max="${max}" step="${step}" value="${obj[key]}"><input type="number" class="prop-num-input" title="Type an exact value" min="${min}" max="${max}" step="${step}" value="${_fmt(obj[key], step)}"></div></div>`;
  const sl = row.querySelector(".prop-slider");
  const num = row.querySelector(".prop-num-input");
  sl.addEventListener("input", () => {
    obj[key] = _clampSnap(parseFloat(sl.value), min, max, step);
    num.value = _fmt(obj[key], step);
    onChange();
  });
  num.addEventListener("change", () => {
    const v = parseFloat(num.value);
    if (!Number.isFinite(v)) { num.value = _fmt(obj[key], step); return; }
    obj[key] = _clampSnap(v, min, max, step);
    sl.value = String(obj[key]);
    num.value = _fmt(obj[key], step);
    onChange();
  });
  num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
  parent.appendChild(row);
  return row;
}

function _toggle(parent, obj, key, { label, hint, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><button type="button" class="prop-toggle ${obj[key] ? "checked" : ""}">${_checkSvg}</button></div>`;
  const btn = row.querySelector(".prop-toggle");
  btn.addEventListener("click", () => {
    obj[key] = !obj[key];
    btn.classList.toggle("checked", obj[key]);
    onChange();
  });
  parent.appendChild(row);
  return row;
}

/** Short human summary for the header, so an active filter shows while collapsed. */
function _summary(s) {
  const parts = [];
  if (s.heightOn) {
    parts.push(`${Math.round(Math.min(s.heightMin, s.heightMax))}–${Math.round(Math.max(s.heightMin, s.heightMax))} m`);
  }
  if (s.slopeOn) {
    parts.push(`${Math.round(Math.min(s.slopeMin, s.slopeMax))}–${Math.round(Math.max(s.slopeMin, s.slopeMax))}°`);
  }
  if (s.concavityOn) parts.push(s.concavityMode === "convex" ? "convex" : "concave");
  return parts.length ? parts.join(" · ") : "off";
}

function _select(parent, obj, key, { label, options, hint, onChange }) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><select class="prop-dropdown">${
    options.map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select></div>`;
  const sel = row.querySelector("select");
  sel.value = obj[key];
  sel.addEventListener("change", () => { obj[key] = sel.value; onChange(); });
  parent.appendChild(row);
  return row;
}

/**
 * Mount a collapsible "Brush filter" section after `anchorEl`.
 *
 * @param {object} o
 * @param {HTMLElement} o.anchorEl   element to insert relative to
 * @param {"afterend"|"beforebegin"} [o.where] insertAdjacentElement position
 * @param {object}      o.state      createBrushFilterState() object, mutated in place
 * @param {number}      o.maxHeight  terrain MAX_HEIGHT, for slider ranges
 * @param {() => void}  o.onChange   called after every edit
 */
export function buildBrushFilterSection({ anchorEl, where = "afterend", state, maxHeight = 500, onChange = () => {} }) {
  const sec = document.createElement("div");
  sec.className = "inspector-section";
  const hdr = document.createElement("div");
  hdr.className = "section-header collapsed";
  hdr.setAttribute("data-toggle", "");
  const body = document.createElement("div");
  body.className = "section-body hidden";
  hdr.addEventListener("click", () => {
    hdr.classList.toggle("collapsed");
    body.classList.toggle("hidden");
  });
  sec.appendChild(hdr);
  sec.appendChild(body);
  anchorEl.insertAdjacentElement(where, sec);

  const renderHeader = () => {
    const on = state.heightOn || state.slopeOn || state.concavityOn;
    hdr.innerHTML = `${_arrowSvg} Brush filter <span style="margin-left:auto;font-weight:400;text-transform:none;letter-spacing:0;color:${on ? "var(--accent)" : "var(--text-dim)"}">${_summary(state)}</span>`;
    hdr.style.display = "flex";
    hdr.style.alignItems = "center";
    hdr.style.gap = "6px";
  };
  const changed = () => { renderHeader(); onChange(); };

  const hint = document.createElement("p");
  hint.className = "mode-hint";
  hint.style.marginTop = "2px";
  hint.textContent = "Limit the brush to ground inside a height or slope band, or to hollows / ridges. Full effect inside the band, fading out over Softness. All off = no effect.";
  body.appendChild(hint);

  const hLo = -Math.round(maxHeight * 0.5);
  const hHi = Math.round(maxHeight * 2);
  _toggle(body, state, "heightOn", { label: "Height", hint: "Only affect ground between Min and Max height", onChange: changed });
  _slider(body, state, "heightMin", { label: "Min (m)", min: hLo, max: hHi, step: 1, onChange: changed });
  _slider(body, state, "heightMax", { label: "Max (m)", min: hLo, max: hHi, step: 1, onChange: changed });
  _slider(body, state, "heightSoft", { label: "Softness (m)", min: 0, max: 100, step: 1, hint: "How far outside the band the effect fades to nothing", onChange: changed });

  const sep = document.createElement("div");
  sep.className = "prop-separator";
  body.appendChild(sep);

  _toggle(body, state, "slopeOn", { label: "Slope", hint: "Only affect ground whose slope is between Min and Max", onChange: changed });
  _slider(body, state, "slopeMin", { label: "Min (°)", min: 0, max: 90, step: 1, onChange: changed });
  _slider(body, state, "slopeMax", { label: "Max (°)", min: 0, max: 90, step: 1, onChange: changed });
  _slider(body, state, "slopeSoft", { label: "Softness (°)", min: 0, max: 30, step: 1, hint: "How far outside the band the effect fades to nothing", onChange: changed });

  const sep2 = document.createElement("div");
  sep2.className = "prop-separator";
  body.appendChild(sep2);

  _toggle(body, state, "concavityOn", { label: "Concavity", hint: "Only affect hollows (creases, valley floors) or ridges (hilltops, cliff lips)", onChange: changed });
  _select(body, state, "concavityMode", {
    label: "Affect",
    options: [["concave", "Hollows (concave)"], ["convex", "Ridges (convex)"]],
    onChange: changed,
  });
  _slider(body, state, "concavityRadius", { label: "Radius (m)", min: 1, max: 60, step: 1, hint: "Compare each point with the ground this far around it: small finds creases, large finds whole valleys", onChange: changed });
  _slider(body, state, "concavityMin", { label: "Min depth (m)", min: 0, max: 20, step: 0.1, hint: "How far below (hollows) or above (ridges) its surroundings a point must be for full effect", onChange: changed });
  _slider(body, state, "concavitySoft", { label: "Softness (m)", min: 0, max: 10, step: 0.1, hint: "How far below Min depth the effect fades to nothing", onChange: changed });

  renderHeader();
  return { refresh: renderHeader };
}
