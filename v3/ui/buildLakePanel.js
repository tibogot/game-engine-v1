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

function _button(parent, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "prop-action-btn";
  btn.textContent = opts.title;
  if (opts.hint) btn.title = opts.hint;
  btn.addEventListener("click", opts.onClick);
  parent.appendChild(btn);
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

/**
 * @param {object}   app
 * @param {object}   app.toolState        — has a `.lake` slice
 * @param {object}   app.lakeSystem
 * @param {number}   app.worldSize
 * @param {number}   app.maxHeight
 * @param {function} app.materialChanged  — shared material params changed
 * @param {function} app.transformChanged — active lake bounds/level changed
 * @param {function} app.selectionChanged — active lake index changed / lake deleted
 * @returns {{ refresh: () => void }}
 */
export function buildLakePanel(app) {
  const panel = document.getElementById("lake-panel");
  if (!panel) return { refresh: () => {} };

  function refresh() {
    panel.innerHTML = "";
    const lp = app.toolState.lake;
    const sys = app.lakeSystem;
    const count = sys.lakes.length;

    // ── Lakes ───────────────────────────────────────────────────────────────
    const lakes = _section(panel, `Lakes (${count})`, true);
    if (count === 0) {
      _hint(lakes, "Drag on the terrain to place a lake. The water level starts at the terrain height where you began the drag; the shoreline is derived from the depth buffer, so the rectangle only has to be roughly right.");
    } else {
      _slider(lakes, lp, "activeIndex", {
        label: "Active", min: 0, max: count - 1, step: 1,
        onChange: () => { sys.setActiveIndex(lp.activeIndex); app.selectionChanged?.(); refresh(); },
      });
      _toggle(lakes, lp, "showBounds", {
        label: "Show bounds",
        onChange: () => sys.refreshBoundsVisibility(),
      });
      _button(lakes, {
        title: "Delete active lake",
        onClick: () => { sys.deleteActive(); app.selectionChanged?.(); refresh(); },
      });
    }

    // ── Active lake transform ───────────────────────────────────────────────
    const active = sys.active;
    if (active) {
      const t = _section(panel, "Placement", true);
      const onT = () => { sys.syncActiveTransform(); app.transformChanged?.(); };
      const half = app.worldSize / 2;
      _slider(t, active, "level", { label: "Water level", min: 0, max: app.maxHeight, step: 0.1, onChange: onT,
        hint: "Terrain above this height is dry; below it is underwater." });
      _slider(t, active, "cx",    { label: "Center X", min: -half, max: half, step: 1, onChange: onT });
      _slider(t, active, "cz",    { label: "Center Z", min: -half, max: half, step: 1, onChange: onT });
      _slider(t, active, "sizeX", { label: "Size X", min: 4, max: app.worldSize, step: 1, onChange: onT });
      _slider(t, active, "sizeZ", { label: "Size Z", min: 4, max: app.worldSize, step: 1, onChange: onT });
    }

    // Flow is lake-specific: lakes drift with a wind angle, rivers flow downstream.
    const onM = () => app.materialChanged?.();
    const surfExtra = (body) => {
      _slider(body, lp, 'flowSpeed', { label: 'Drift speed', min: 0, max: 1, step: 0.01, onChange: onM });
      _slider(body, lp, 'flowAngle', { label: 'Drift angle', min: 0, max: 360, step: 1, onChange: onM });
    };

    // Identical control set to River+'s Depth style — same shader, separate values.
    buildDepthWaterControls(_widgets, panel, lp.water, app.waterGlobals, onM, {
      label: 'this lake',
      extraSurface: surfExtra,
    });
  }

  refresh();
  return { refresh };
}
