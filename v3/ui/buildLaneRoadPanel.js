/**
 * v3/ui/buildLaneRoadPanel.js — Lane Road mode inspector (3D preview of the
 * lane-based road engine).
 *
 * Test scene, cross-section heights, colours, and the build/mesh numbers.
 * Widget helpers are a per-file copy, matching the convention in every other
 * v3 panel.
 */
import { PREVIEW_SCENES } from "../roads/mesh/previewScenes.js";

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
  if (stepStr.includes(".")) out = Number(out.toFixed(stepStr.split(".")[1].length));
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
  return p;
}

function _choice(parent, label, options, current, onPick, hint) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><select class="prop-dropdown">${options
    .map(([v, t]) => `<option value="${v}"${v === current ? " selected" : ""}>${t}</option>`).join("")}</select></div>`;
  row.querySelector("select").addEventListener("change", (e) => onPick(e.target.value));
  parent.appendChild(row);
}

/**
 * @param {object} app
 * @param {import("../tools/laneRoadSystem.js").LaneRoadSystem} app.laneRoadSystem
 * @param {() => void} [app.onFrame]  frame the loaded scene in the view
 * @returns {{ refresh: () => void }}
 */
export function buildLaneRoadPanel(app) {
  const panel = document.getElementById("lane-road-panel");
  if (!panel) return { refresh: () => {} };

  let _rebuildTimer = 0;
  function rebuildSoon() {
    clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(() => { app.laneRoadSystem.rebuild(); refresh(); }, 60);
  }

  function refresh() {
    panel.innerHTML = "";
    const sys = app.laneRoadSystem;
    const p = sys.params;

    // ── Scene ───────────────────────────────────────────────────────────────
    const sc = _section(panel, "Lane road (preview)", true);
    _hint(sc, "3D preview of the new lane-based road engine on flat ground. Pick a test scene; it is placed at the centre of the view. Smart Road 2 is untouched, and nothing here is saved in the project.");
    _choice(sc, "Scene", Object.entries(PREVIEW_SCENES).map(([k, d]) => [k, d.label]), p.scene,
      (v) => { sys.load(v); refresh(); });
    _button(sc, {
      title: sys.loaded ? "Move to view centre" : "Load",
      hint: "Drops the scene at the centre of the view, on the ground there.",
      onClick: () => { sys.load(p.scene); refresh(); },
    });
    if (sys.loaded) {
      if (app.onFrame) _button(sc, { title: "Frame", onClick: () => app.onFrame() });
      _button(sc, { title: "Clear", onClick: () => { sys.clear(); refresh(); } });
      _toggle(sc, p, "visible", { label: "Visible", onChange: () => sys.setVisible(p.visible) });
    }

    // ── Shape ───────────────────────────────────────────────────────────────
    const sh = _section(panel, "Cross-section", true);
    _slider(sh, p, "lift", {
      label: "Above ground (m)", min: 0, max: 3, step: 0.01, onChange: rebuildSoon,
      hint: "Road surface height over the ground at the scene centre. No terrain fitting yet — use a flat area.",
    });
    _slider(sh, p, "curbHeight", { label: "Curb (m)", min: 0.05, max: 0.3, step: 0.01, onChange: rebuildSoon, hint: "Sidewalks, splitter islands, dead-end caps." });
    _slider(sh, p, "medianHeight", { label: "Median (m)", min: 0.05, max: 0.4, step: 0.01, onChange: rebuildSoon });
    _slider(sh, p, "apronHeight", { label: "Apron (m)", min: 0.02, max: 0.2, step: 0.01, onChange: rebuildSoon, hint: "Roundabout truck apron — low, so it can be driven over." });
    _slider(sh, p, "islandHeight", { label: "Island (m)", min: 0.05, max: 0.5, step: 0.01, onChange: rebuildSoon, hint: "Roundabout central island." });
    _slider(sh, p, "bevel", { label: "Curb bevel (m)", min: 0, max: 0.05, step: 0.005, onChange: rebuildSoon, hint: "45° chamfer on the top edge of every curb." });
    _slider(sh, p, "curbBand", { label: "Curb stone (m)", min: 0, max: 0.4, step: 0.01, onChange: rebuildSoon, hint: "Concrete band round grass tops (medians, verges, island)." });

    // ── Markings ────────────────────────────────────────────────────────────
    const mk = _section(panel, "Markings", true);
    const onColor = () => sys.syncMaterialColors();
    _hint(mk, "Painted by the asphalt shader: lines along roads are drawn from the lane data, junction shapes come from a distance-field atlas. The paint shares the asphalt's wear and wet film.");
    _toggle(mk, p, "markings", { label: "Markings", onChange: rebuildSoon, hint: "Lane lines, crosswalks, stop/yield lines, arrows." });
    const onWear = () => sys.syncPaintWear();
    _slider(mk, p, "wearAmount", { label: "Wear", min: 0, max: 4, step: 0.05, onChange: onWear, hint: "0 = fresh paint. Over 1 clips old stretches to fully worn and leaves fresh ones alone." });
    _slider(mk, p, "wearBite", { label: "Edge bite", min: 0, max: 1, step: 0.01, onChange: onWear, hint: "How much of a line's half-width worn edges eat away." });
    _slider(mk, p, "wearBase", { label: "Off wheel paths", min: 0, max: 1, step: 0.01, onChange: onWear, hint: "Wear away from where tyres run, as a fraction of the wheel-path wear." });
    _slider(mk, p, "crossWear", { label: "Crossing wear", min: 0, max: 2, step: 0.01, onChange: onWear, hint: "Junction shapes (crosswalks, arrows, stop lines) relative to lane lines." });
    _color(mk, p, "paintWhite", { label: "White", onChange: onColor });
    _color(mk, p, "paintYellow", { label: "Yellow", onChange: onColor });

    // ── Asphalt ─────────────────────────────────────────────────────────────
    const as = _section(panel, "Asphalt (city street surface)", true);
    const onAsphalt = () => sys.syncAsphalt();
    _color(as, p, "asphaltDark", { label: "Dark", onChange: onAsphalt });
    _color(as, p, "asphaltLight", { label: "Light", onChange: onAsphalt });
    _slider(as, p, "deckBrightness", { label: "Brightness", min: 0.2, max: 2, step: 0.01, onChange: onAsphalt });
    _slider(as, p, "patchAmount", { label: "Patches", min: 0, max: 1, step: 0.01, onChange: onAsphalt, hint: "Resurfacing patches with sealant seams — darker, glossier." });
    _slider(as, p, "patchChance", { label: "Patch density", min: 0, max: 1, step: 0.01, onChange: onAsphalt });
    _slider(as, p, "chipRelief", { label: "Stone relief (m)", min: 0, max: 0.05, step: 0.001, onChange: onAsphalt, hint: "Height of the cellular stones in the normal. Reads most under grazing and headlight light." });
    _slider(as, p, "gritRelief", { label: "Grit relief (m)", min: 0, max: 0.03, step: 0.001, onChange: onAsphalt });

    // ── Weather ─────────────────────────────────────────────────────────────
    const we = _section(panel, "Weather", true);
    _toggle(we, p, "wet", { label: "Wet", onChange: () => { sys.setWet(p.wet); refresh(); }, hint: "Compiles the water film into the asphalt (a material swap, not a slider)." });
    if (p.wet) {
      _slider(we, p, "wetAmount", { label: "Wetness", min: 0, max: 1, step: 0.01, onChange: () => sys.syncWetAmounts() });
      _slider(we, p, "puddleAmount", { label: "Puddles", min: 0, max: 2, step: 0.01, onChange: () => sys.syncWetAmounts() });
    }

    // ── Look ────────────────────────────────────────────────────────────────
    const lk = _section(panel, "Look", false);
    _color(lk, p, "slabColor", { label: "Sidewalk", onChange: onColor });
    _color(lk, p, "curbColor", { label: "Curb stone", onChange: onColor });
    _color(lk, p, "apronColor", { label: "Apron", onChange: onColor });
    _color(lk, p, "grassColor", { label: "Grass", onChange: onColor });
    _toggle(lk, p, "curbShadows", {
      label: "Curb shadows", onChange: () => sys.setCurbShadows(p.curbShadows),
      hint: "Concrete mesh in the shadow pass (one extra draw per cascade).",
    });

    // ── Stats ───────────────────────────────────────────────────────────────
    const st = sys.stats;
    if (st) {
      const ss = _section(panel, "Stats", true);
      _hint(ss, `${st.roads} roads · ${st.nodes} nodes · ${st.junctions} junctions · ${st.roundabouts} roundabouts`);
      _hint(ss, `${st.draws} draw calls · ${st.triangles.toLocaleString()} triangles · ${st.vertices.toLocaleString()} vertices`);
      _hint(ss, `Build ${st.totalMs.toFixed(1)} ms (network ${st.networkMs.toFixed(1)}, mesh ${st.meshMs.toFixed(1)} incl. atlas ${st.atlasMs.toFixed(1)})`);
      _hint(ss, `Marking atlas: ${st.atlas}`);
      if (st.issues) _hint(ss, `${st.issues} engine issue${st.issues === 1 ? "" : "s"} (warnings/errors) — see the 2D lab for where.`);
    }
  }

  refresh();
  return { refresh };
}
