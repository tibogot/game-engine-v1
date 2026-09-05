/**
 * Tree panel — palette first, brush second, and only the SELECTED tree's
 * settings after that.
 *
 * The previous layout put eight collapsible slot sections (each with Colors,
 * Lighting, SSS & Rim and Wind sub-folds) in the same scroll as the brush you
 * were trying to paint with, and rebuilt all of them on every change. That is
 * Unreal's per-foliage-type settings and its paint brush jammed into one
 * column. Now:
 *
 *   Trees      — eraser + 8 slot cards (thumbnail, name; "+" while empty).
 *                Click selects; drop a .json preset or .glb onto a card to load it.
 *   Brush      — everything that shapes ONE stroke: radius, strength, shape,
 *                density, spacing, scale range, rotation, slope skip.
 *   <Name>     — the selected slot's own settings, collapsed, rebuilt only
 *                when the selection changes. Hidden for the eraser.
 *   More       — mass place, LOD distances, collision debug, clear all.
 *
 * The palette component is shared (assetPalette.js) so the foliage panel can
 * get the same treatment without a second implementation.
 */
import { createAssetPalette } from "./assetPalette.js";

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

const GLB_EXTS = new Set(["glb", "gltf"]);
const JSON_EXTS = new Set(["json"]);
const DROP_EXTS = new Set([...GLB_EXTS, ...JSON_EXTS]);

function _extOf(name) {
  return String(name || "").split(".").pop().toLowerCase();
}

function tryGetGlbFileFromAnyDrop(dataTransfer) {
  if (!dataTransfer?.files?.length) return null;
  for (const f of dataTransfer.files) {
    if (GLB_EXTS.has(_extOf(f.name))) return f;
  }
  return null;
}

function tryGetJsonFileFromAnyDrop(dataTransfer) {
  if (!dataTransfer?.files?.length) return null;
  for (const f of dataTransfer.files) {
    if (JSON_EXTS.has(_extOf(f.name))) return f;
  }
  return null;
}

function installDropZone(el, { pickFile, onFile, hint = "Drop here" }) {
  if (!el) return () => {};
  el.classList.add("drop-zone");
  el.dataset.dropHint = hint;
  const onOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    el.classList.add("drag-over");
  };
  const onLeave = (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("drag-over");
  };
  const onDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drag-over");
    let file = null;
    try {
      file = await pickFile(e.dataTransfer);
    } catch (err) {
      console.warn("[V3] drop pickFile failed:", err);
    }
    if (!file) return;
    try {
      await onFile(file);
    } catch (err) {
      console.error("[V3] drop onFile failed:", err);
    }
  };
  el.addEventListener("dragover", onOver);
  el.addEventListener("dragleave", onLeave);
  el.addEventListener("drop", onDrop);
  return () => {
    el.removeEventListener("dragover", onOver);
    el.removeEventListener("dragleave", onLeave);
    el.removeEventListener("drop", onDrop);
    el.classList.remove("drop-zone", "drag-over");
  };
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
  const stepStr = String(step);
  let decimals = 0;
  if (stepStr.includes(".")) decimals = stepStr.split(".")[1].length;
  else if (stepStr.includes("e-")) decimals = 8;
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

function _separator(parent) {
  const hr = document.createElement("div");
  hr.className = "section-separator";
  parent.appendChild(hr);
}

function _slider(parent, obj, key, opts) {
  const { label, min, max, step = 0.01, curve, onChange, hint } = opts;
  const isLog = curve === "log" && min > 0 && max > min;
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  const cur = obj[key];
  const logK = isLog ? Math.log(max / min) : 0;
  const valToSlider = (v) => (isLog ? Math.log(Math.max(v, min) / min) / logK : v);
  const sliderToVal = (s) => (isLog ? min * Math.exp(s * logK) : s);
  const sliderMin = isLog ? 0 : min;
  const sliderMax = isLog ? 1 : max;
  const sliderStep = isLog ? 0.0001 : step;
  const sliderInit = valToSlider(cur);
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${sliderMin}" max="${sliderMax}" step="${sliderStep}" value="${sliderInit}"><input type="number" class="prop-num-input" title="Type an exact value" min="${min}" max="${max}" step="${step}" value="${_fmt(cur, step)}"></div></div>`;
  const sl = row.querySelector(".prop-slider");
  const num = row.querySelector(".prop-num-input");
  const syncNumDisplay = () => { num.value = _fmt(obj[key], step); };
  const syncSliderFromValue = () => { sl.value = String(valToSlider(obj[key])); };
  const applyFromSlider = () => {
    let v = sliderToVal(parseFloat(sl.value));
    if (isLog) v = _clampSnap(v, min, max, step);
    obj[key] = v;
    syncNumDisplay();
    onChange?.();
  };
  const commitFromNum = () => {
    const raw = String(num.value).trim();
    if (raw === "" || raw === "-" || raw === "." || raw === "-.") { syncNumDisplay(); return; }
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) { syncNumDisplay(); return; }
    v = _clampSnap(v, min, max, step);
    obj[key] = v;
    syncSliderFromValue();
    syncNumDisplay();
    onChange?.();
  };
  sl.addEventListener("input", applyFromSlider);
  num.addEventListener("change", commitFromNum);
  num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
  parent.appendChild(row);
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
    onChange?.(obj[key]);
  });
  parent.appendChild(row);
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
  const _isNum = typeof obj[key] === "number";
  sel.addEventListener("change", () => {
    obj[key] = _isNum ? Number(sel.value) : sel.value;
    onChange?.();
  });
  parent.appendChild(row);
}

function _text(parent, obj, key, opts) {
  const { label, onChange, hint } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><input type="text" class="prop-dropdown" style="width:100%" value="${obj[key] ?? ""}"></div>`;
  const inp = row.querySelector("input");
  inp.addEventListener("change", () => {
    obj[key] = inp.value;
    onChange?.();
  });
  parent.appendChild(row);
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

function _hint(parent, html) {
  const p = document.createElement("p");
  p.className = "mode-hint";
  p.innerHTML = html;
  parent.appendChild(p);
  return p;
}

function _installBvhDebugUi(parent, app) {
  const dbgBody = _section(parent, "Collision Debug", false);
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML = `<span class="prop-label">Show BVH wireframes</span><div class="prop-value"><button type="button" class="prop-toggle" data-bvh-debug-toggle>${_checkSvg}</button></div>`;
  const btn = row.querySelector(".prop-toggle");
  btn.classList.toggle("checked", !!app.getBvhDebugEnabled?.());
  btn.addEventListener("click", () => app.setBvhDebugEnabled?.(!app.getBvhDebugEnabled?.()));
  dbgBody.appendChild(row);
  const hint = document.createElement("p");
  hint.style.cssText =
    "margin:6px 0 0; font-size:11px; color:var(--text-dim); line-height:1.35;";
  hint.innerHTML =
    '<span style="color:#44ff88">Green</span> props/cliffs · <span style="color:#ff8844">Orange</span> tree trunks. Trees auto-rebake; props need Rebake BVH after bulk edits.';
  dbgBody.appendChild(hint);
}

/** Build the tree panel into #tree-panel. */
export function buildTreePanel(app) {
  const panel = document.getElementById("tree-panel");
  if (!panel) return null;
  panel.innerHTML = "";
  const ts = app.toolState;
  const cfg = app.config;
  const tp = ts.treePaint;

  const isLoaded = (i) => !!app.isTreeSlotLoaded?.(i);

  // ── Palette ────────────────────────────────────────────────────────────────
  const palBody = _section(panel, "Trees");
  const palette = createAssetPalette({
    container: palBody,
    cards: () => [
      { key: -1, kind: "eraser", label: "Erase", title: "Erase trees under the brush (or hold Alt while painting)" },
      ...ts.treeSlots.map((slot, i) => {
        const loaded = isLoaded(i);
        return {
          key: i,
          kind: loaded ? "asset" : "empty",
          label: loaded ? slot.name : "Add",
          thumb: loaded ? app.getTreeThumbnail?.(i) : null,
          title: loaded
            ? `${slot.name} — click to paint, drop a preset/.glb to replace`
            : `Empty slot ${i + 1} — drop a .json tree preset or .glb here, or select it and use its import buttons`,
        };
      }),
    ],
    activeKey: () => tp.activeSlot,
    onSelect: (key) => {
      tp.activeSlot = key;
      palette.refresh();
      // Selecting an EMPTY slot opens its settings, which hold the import
      // buttons — so "+" leads somewhere without popping a file dialog on you.
      rebuildSettings(key >= 0 && !isLoaded(key));
    },
    onDropFile: async (key, file) => {
      const ext = _extOf(file.name);
      if (JSON_EXTS.has(ext)) await app.loadTreePreset(key, file);
      else if (GLB_EXTS.has(ext)) await app.importTreeGlb(key, 0, file);
      tp.activeSlot = key;
      palette.refresh();
      rebuildSettings();
    },
    acceptExts: DROP_EXTS,
    dropHint: "Drop preset / .glb",
  });
  _hint(palBody, "<kbd>Alt</kbd>+paint = erase &nbsp;·&nbsp; Drop a .json preset or .glb onto a card");

  // ── Brush ──────────────────────────────────────────────────────────────────
  // Everything that shapes ONE stroke, whichever tree is selected.
  const brushBody = _section(panel, "Brush");
  _slider(brushBody, ts.brush, "radius", {
    label: "Radius",
    min: cfg.sculpt.brushMin,
    max: cfg.sculpt.brushMax,
    step: 0.5,
  });
  _slider(brushBody, ts.brush, "strength", {
    label: "Strength",
    min: cfg.sculpt.strengthMin,
    max: cfg.sculpt.strengthMax,
    step: 0.01,
  });
  _slider(brushBody, ts.brush, "falloff", { label: "Shape", min: 0.5, max: 4, step: 0.05 });
  _slider(brushBody, tp, "density", { label: "Density", min: 0.05, max: 3, step: 0.05 });
  _slider(brushBody, tp, "minSpacing", { label: "Min spacing", min: 1, max: 100, step: 0.5 });
  _slider(brushBody, tp, "scaleMin", { label: "Scale min", min: 0.1, max: 3, step: 0.05 });
  _slider(brushBody, tp, "scaleMax", { label: "Scale max", min: 0.1, max: 3, step: 0.05 });
  _toggle(brushBody, tp, "randomRotation", { label: "Random rot." });
  _toggle(brushBody, tp, "slopeEnabled", {
    label: "Skip cliffs",
    hint: "Never place on ground steeper than the threshold (brush and mass place)",
  });
  _slider(brushBody, tp, "slopeMax", { label: "Slope threshold", min: 0.0, max: 1.0, step: 0.01 });
  _dropdown(brushBody, ts.brush, "previewShape", {
    label: "Preview shape",
    options: { Dome: "dome", Circle: "circle" },
  });

  // ── Selected tree's settings ───────────────────────────────────────────────
  // Rebuilt only when the selection changes, and never shown for the eraser.
  const settingsHost = document.createElement("div");
  panel.appendChild(settingsHost);

  function rebuildSettings(expand = false) {
    settingsHost.innerHTML = "";
    const i = tp.activeSlot;
    if (i < 0 || !ts.treeSlots[i]) return;
    const slot = ts.treeSlots[i];
    const loaded = isLoaded(i);
    const title = loaded ? `${slot.name} — settings` : `Slot ${i + 1} — load a tree`;
    const slBody = _section(settingsHost, title, expand || !loaded);
    const hdr = slBody.previousElementSibling;

    // Import first while empty: it is the only thing an empty slot can do.
    const importBody = loaded ? _section(slBody, "Model", false) : slBody;
    const presetBtn = _button(importBody, {
      title: "Load tree preset (.json)",
      onClick: () => app.loadTreePreset(i),
    });
    installDropZone(presetBtn, {
      hint: "Drop .json preset",
      pickFile: tryGetJsonFileFromAnyDrop,
      onFile: async (file) => { await app.loadTreePreset(i, file); },
    });
    const lod0Btn = _button(importBody, {
      title: "Import LOD0 (detail .glb)",
      onClick: () => app.importTreeGlb(i, 0),
    });
    installDropZone(lod0Btn, {
      hint: "Drop .glb as LOD0",
      pickFile: tryGetGlbFileFromAnyDrop,
      onFile: async (file) => { await app.importTreeGlb(i, 0, file); },
    });
    const lod1Btn = _button(importBody, {
      title: "Import LOD1 (simplified .glb)",
      onClick: () => app.importTreeGlb(i, 1),
    });
    installDropZone(lod1Btn, {
      hint: "Drop .glb as LOD1",
      pickFile: tryGetGlbFileFromAnyDrop,
      onFile: async (file) => { await app.importTreeGlb(i, 1, file); },
    });
    if (!loaded) return;

    _text(slBody, slot, "name", {
      label: "Name",
      onChange: () => {
        if (hdr) hdr.innerHTML = _arrowSvg + " " + `${slot.name} — settings`;
        palette.refresh();
      },
    });
    _toggle(slBody, slot, "enabled", { label: "Enabled" });
    _slider(slBody, slot, "baseScale", { label: "Base scale", min: 0.01, max: 5, step: 0.01 });
    _slider(slBody, slot, "colliderRadius", {
      label: "Collider radius",
      min: 0, max: 4, step: 0.05,
      onChange: () => app.treeColliderChanged(),
    });
    _slider(slBody, slot, "colliderHeight", {
      label: "Collider height",
      min: 0, max: 30, step: 0.5,
      onChange: () => app.treeColliderChanged(),
    });

    // Foliage material
    const fi = slot.foliage;
    const fChange = () => app.foliageParamChanged(i);
    const colBody = _section(slBody, "Colors", false);
    _color(colBody, fi, "bottomColor", { label: "Base color", onChange: fChange });
    _color(colBody, fi, "topColor", { label: "Top color", onChange: fChange });
    _slider(colBody, fi, "colorVar", { label: "Leaf variation", min: 0, max: 0.5, step: 0.01, onChange: fChange });
    _slider(colBody, fi, "treeColorVar", { label: "Tree variation", min: 0, max: 0.5, step: 0.01, onChange: fChange });
    _slider(colBody, fi, "alphaCutoff", { label: "Alpha cutoff", min: 0.1, max: 0.9, step: 0.01, onChange: fChange });

    const litBody = _section(slBody, "Lighting", false);
    _slider(litBody, fi, "normalBias", { label: "Sphere normals", min: 0, max: 1, step: 0.01, onChange: fChange });
    _slider(litBody, fi, "leafWarp", { label: "Leaf warp", min: 0, max: 1, step: 0.01, onChange: fChange });
    _slider(litBody, fi, "aoStr", { label: "AO strength", min: 0, max: 1, step: 0.01, onChange: fChange });

    const sssBody = _section(slBody, "SSS & Rim", false);
    _slider(sssBody, fi, "sssStr", { label: "SSS strength", min: 0, max: 2, step: 0.01, onChange: fChange });
    _slider(sssBody, fi, "sssPow", { label: "SSS power", min: 0.5, max: 8, step: 0.1, onChange: fChange });
    _color(sssBody, fi, "sssColor", { label: "SSS color", onChange: fChange });
    _slider(sssBody, fi, "rimStr", { label: "Rim strength", min: 0, max: 2, step: 0.01, onChange: fChange });
    _slider(sssBody, fi, "rimPow", { label: "Rim power", min: 0.5, max: 8, step: 0.1, onChange: fChange });
    _color(sssBody, fi, "rimColor", { label: "Rim color", onChange: fChange });

    const windBody = _section(slBody, "Wind", false);
    _slider(windBody, fi, "windSpeed", { label: "Speed", min: 0, max: 5, step: 0.05, onChange: fChange });
    _slider(windBody, fi, "windStr", { label: "Strength", min: 0, max: 0.5, step: 0.005, onChange: fChange });
    _slider(windBody, fi, "windMicro", { label: "Micro sway", min: 0, max: 0.3, step: 0.005, onChange: fChange });

    _separator(slBody);
    _button(slBody, {
      title: "Remove models from this slot",
      onClick: () => app.removeTreeSlot(i),
    });
  }
  rebuildSettings();

  // ── More ───────────────────────────────────────────────────────────────────
  const moreBody = _section(panel, "More", false);

  const massBody = _section(moreBody, "Mass Place Trees", false);
  _hint(massBody, "Scatters the SELECTED tree over the whole world, honouring spacing and the slope skip.");
  _slider(massBody, tp, "massPlaceCount", { label: "Number of trees", min: 1, max: 50000, step: 1 });
  _toggle(massBody, tp, "massPlaceKeepExisting", { label: "Keep existing trees" });
  _button(massBody, {
    title: "Place",
    onClick: () => {
      if (tp.activeSlot < 0) return; // eraser selected: nothing to place
      app.massPlaceTrees();
    },
  });

  const lodBody = _section(moreBody, "LOD Distances", false);
  _slider(lodBody, ts.treeLod, "lod0Distance", { label: "LOD0 > LOD1", min: 20, max: 500, step: 5 });
  _slider(lodBody, ts.treeLod, "lod1Distance", { label: "LOD1 > hide", min: 50, max: 1000, step: 10 });
  _slider(lodBody, ts.treeLod, "fadeOutDistance", { label: "Fade-out", min: 100, max: 2000, step: 10 });
  _toggle(lodBody, ts.treeLod, "castShadow", {
    label: "Cast shadow",
    onChange: () => app.treeCastShadowChanged(),
  });

  // Tree leaf LOD (3D cards on painted trees — not billboard foliage paint)
  const fLodBody = _section(moreBody, "Tree leaf LOD", false);
  _slider(fLodBody, ts.foliageLod, "lod0Distance", { label: "LOD0 → LOD1", min: 20, max: 300, step: 5 });
  _slider(fLodBody, ts.foliageLod, "lod1Distance", { label: "LOD1 → LOD2", min: 50, max: 600, step: 10 });
  _slider(fLodBody, ts.foliageLod, "fadeOutDistance", { label: "Hide distance", min: 100, max: 2000, step: 10 });

  _installBvhDebugUi(moreBody, app);

  _separator(moreBody);
  _button(moreBody, {
    title: "Clear all trees",
    onClick: () => app.clearAllTrees(),
  });

  // Called after preset/GLB loads, thumbnail bakes and project loads.
  panel._rebuildTreeUi = () => {
    palette.refresh();
    rebuildSettings();
  };

  return panel;
}
