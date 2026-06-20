/** Custom inspector UI helpers — same pattern as v2/editor.html */

const _arrowSvg =
  '<svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';

function _fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return v.toFixed(d);
}

function _clampSnap(v, min, max, step) {
  if (!Number.isFinite(v)) return min;
  const n = Math.round((v - min) / step);
  let out = min + n * step;
  const stepStr = String(step);
  let decimals = 0;
  if (stepStr.includes(".")) decimals = stepStr.split(".")[1].length;
  else if (stepStr.includes("e-")) decimals = 8;
  if (decimals > 0) out = Number(out.toFixed(decimals));
  return Math.min(max, Math.max(min, out));
}

export function createUiHelpers() {
  const handles = [];

  function refreshAll() {
    for (const h of handles) h.refresh?.();
  }

  function _section(parent, title, expanded = true) {
    const sec = document.createElement("div");
    sec.className = "inspector-section";
    const hdr = document.createElement("div");
    hdr.className = "section-header" + (expanded ? "" : " collapsed");
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
    const syncSl = () => { sl.value = String(obj[key]); };
    sl.addEventListener("input", () => {
      obj[key] = parseFloat(sl.value);
      syncNum();
      onChange?.();
    });
    const commitNum = () => {
      let v = parseFloat(num.value);
      if (!Number.isFinite(v)) { syncNum(); return; }
      v = _clampSnap(v, min, max, step);
      obj[key] = v;
      syncSl();
      syncNum();
      onChange?.();
    };
    num.addEventListener("change", commitNum);
    num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
    parent.appendChild(row);
    const handle = {
      refresh() { syncSl(); syncNum(); },
    };
    handles.push(handle);
    return handle;
  }

  function _color(parent, obj, key, opts) {
    const { label, onChange, hint } = opts;
    const row = document.createElement("div");
    row.className = "prop-row";
    if (hint) row.title = hint;
    row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-color-wrap"><input type="color" class="prop-color" value="${obj[key]}"><span class="prop-slider-val" style="width:auto">${obj[key]}</span></div></div>`;
    const inp = row.querySelector(".prop-color");
    const hex = row.querySelector(".prop-slider-val");
    inp.addEventListener("input", () => {
      obj[key] = inp.value;
      hex.textContent = inp.value;
      onChange?.();
    });
    parent.appendChild(row);
    const handle = {
      refresh() {
        inp.value = obj[key];
        hex.textContent = obj[key];
      },
    };
    handles.push(handle);
    return handle;
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
    const handle = {
      refresh() { btn.classList.toggle("checked", obj[key]); },
    };
    handles.push(handle);
    return handle;
  }

  function _dropdown(parent, obj, key, opts) {
    const { label, options, onChange, hint } = opts;
    const row = document.createElement("div");
    row.className = "prop-row";
    if (hint) row.title = hint;
    let optHtml = "";
    for (const [text, val] of Object.entries(options)) {
      optHtml += `<option value="${val}" ${obj[key] === val ? "selected" : ""}>${text}</option>`;
    }
    row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><select class="prop-dropdown">${optHtml}</select></div>`;
    const sel = row.querySelector(".prop-dropdown");
    const isNum = typeof obj[key] === "number";
    sel.addEventListener("change", () => {
      obj[key] = isNum ? Number(sel.value) : sel.value;
      onChange?.();
    });
    parent.appendChild(row);
    const handle = {
      refresh() { sel.value = obj[key]; },
    };
    handles.push(handle);
    return handle;
  }

  function _button(parent, opts) {
    const { title, onClick, hint } = opts;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "section-btn";
    btn.textContent = title;
    if (hint) btn.title = hint;
    btn.addEventListener("click", onClick);
    parent.appendChild(btn);
    return btn;
  }

  function _info(parent, label, value) {
    const row = document.createElement("div");
    row.className = "info-row";
    const valSpan = document.createElement("span");
    valSpan.className = "info-value";
    valSpan.textContent = value;
    row.innerHTML = `<span class="info-label">${label}</span>`;
    row.appendChild(valSpan);
    parent.appendChild(row);
    return { update(v) { valSpan.textContent = v; } };
  }

  function _separator(parent) {
    const div = document.createElement("div");
    div.className = "section-separator";
    parent.appendChild(div);
  }

  return {
    _section,
    _slider,
    _color,
    _toggle,
    _dropdown,
    _button,
    _info,
    _separator,
    refreshAll,
  };
}

export function initSplitters() {
  function initSplitter(id, cssVar, axis, invert = false) {
    const el = document.getElementById(id);
    if (!el) return;
    const root = document.documentElement;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el.classList.add("active");
      const startPos = axis === "x" ? e.clientX : e.clientY;
      const startSize = parseFloat(getComputedStyle(root).getPropertyValue(cssVar));
      document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
      const onMove = (ev) => {
        const delta = (axis === "x" ? ev.clientX : ev.clientY) - startPos;
        const maxPx = (axis === "x" ? window.innerWidth : window.innerHeight) * 0.45;
        root.style.setProperty(
          cssVar,
          Math.max(180, Math.min(maxPx, startSize + delta * (invert ? -1 : 1))) + "px",
        );
        window.dispatchEvent(new Event("resize"));
      };
      const onUp = () => {
        el.classList.remove("active");
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }
  initSplitter("splitter-left", "--left-w", "x");
  initSplitter("splitter-right", "--right-w", "x", true);
  initSplitter("splitter-bottom", "--bottom-h", "y", true);
}
