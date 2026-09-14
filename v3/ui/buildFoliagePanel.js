import { createAssetPalette } from "./assetPalette.js";
import { projectAssets, isAssetRef } from "../io/projectAssets.js";

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

function _extOf(name) {
  return String(name || "").split(".").pop().toLowerCase();
}

function tryGetImageFileFromAnyDrop(dataTransfer) {
  if (!dataTransfer?.files?.length) return null;
  for (const f of dataTransfer.files) {
    if (IMAGE_EXTS.has(_extOf(f.name)) || f.type?.startsWith("image/")) return f;
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

function _info(parent, label, value) {
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML = `<span class="prop-label">${label}</span><span class="insp-value" style="text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>`;
  const val = row.querySelector(".insp-value");
  val.textContent = value;
  parent.appendChild(row);
  return { update: (v) => { val.textContent = v; } };
}

function _hintText(parent, html) {
  const el = document.createElement("p");
  el.className = "mode-hint";
  el.innerHTML = html;
  parent.appendChild(el);
  return el;
}

function _addBrushExtras(parent, ts) {
  _slider(parent, ts.brush, "falloff", {
    label: "Shape",
    min: 0.5,
    max: 4,
    step: 0.05,
  });
  _dropdown(parent, ts.brush, "previewShape", {
    label: "Preview shape",
    options: { Dome: "dome", Circle: "circle" },
  });
}

/**
 * Billboard-foliage panel — same shape as the tree panel.
 *
 *   Foliage   — eraser + 8 slot cards (the slot's own texture as the thumbnail,
 *               "+" while empty). Click to select; drop an image on any card,
 *               empty ones included, to fill that slot.
 *   Brush     — everything that shapes ONE stroke.
 *   <Name>    — the SELECTED slot's settings only, collapsed, rebuilt when the
 *               selection changes and hidden while the eraser is active.
 *   More      — mass place, billboard LOD, clear all.
 *
 * Erase is the existing `foliagePaint.erase` flag, not a negative slot index
 * (that is how trees do it, but the foliage paint system reads the flag), so the
 * eraser card just toggles it and the paint behaviour is unchanged.
 */
export function buildFoliagePanel(app) {
  const panel = document.getElementById("foliage-panel");
  if (!panel) return null;
  panel.innerHTML = "";
  const ts = app.toolState;
  const cfg = app.config;
  const fp = ts.foliagePaint;

  const isLoaded = (i) => !!app.isFoliageSlotLoaded?.(i);

  // ── Palette ────────────────────────────────────────────────────────────────
  const palBody = _section(panel, "Foliage");
  const palette = createAssetPalette({
    container: palBody,
    cards: () => [
      { key: -1, kind: "eraser", label: "Erase", title: "Erase foliage under the brush (or hold Alt / Shift while painting)" },
      ...ts.foliageSlots.map((slot, i) => {
        const loaded = isLoaded(i);
        return {
          key: i,
          kind: loaded ? "asset" : "empty",
          label: loaded ? slot.name : "Add",
          thumb: loaded ? app.getFoliageThumbnail?.(i) : null,
          title: loaded
            ? `${slot.name} — click to paint, drop an image to replace`
            : `Empty slot ${i + 1} — drop an image here, or select it and use Load texture`,
        };
      }),
    ],
    activeKey: () => (fp.erase ? -1 : fp.activeSlot),
    onSelect: (key) => {
      if (key < 0) {
        fp.erase = true;
      } else {
        fp.erase = false;
        fp.activeSlot = key;
      }
      palette.refresh();
      rebuildSettings(key >= 0 && !isLoaded(key));
    },
    onDropFile: async (key, file) => {
      await app.loadFoliageTexture(key, file);
      fp.erase = false;
      fp.activeSlot = key;
      palette.refresh();
      rebuildSettings();
    },
    acceptExts: IMAGE_EXTS,
    dropHint: "Drop image",
  });
  _hintText(palBody, "<kbd>Alt</kbd>+paint = erase &nbsp;·&nbsp; Drop an image onto a card");

  // ── Brush ──────────────────────────────────────────────────────────────────
  const brushBody = _section(panel, "Brush");
  _slider(brushBody, ts.brush, "radius", { label: "Radius", min: cfg.sculpt.brushMin, max: cfg.sculpt.brushMax, step: 0.5 });
  _slider(brushBody, ts.brush, "strength", { label: "Strength", min: cfg.sculpt.strengthMin, max: cfg.sculpt.strengthMax, step: 0.01 });
  _slider(brushBody, ts.brush, "falloff", { label: "Shape", min: 0.5, max: 4, step: 0.05 });
  _slider(brushBody, fp, "density", { label: "Density", min: 0.1, max: 5, step: 0.1 });
  _slider(brushBody, fp, "minSpacing", { label: "Min spacing", min: 0.3, max: 10, step: 0.1 });
  _slider(brushBody, fp, "scaleMin", { label: "Scale min", min: 0.1, max: 3, step: 0.05 });
  _slider(brushBody, fp, "scaleMax", { label: "Scale max", min: 0.1, max: 3, step: 0.05 });
  _toggle(brushBody, fp, "randomRotation", { label: "Random rot." });
  _toggle(brushBody, fp, "slopeEnabled", { label: "Skip steep slopes" });
  _slider(brushBody, fp, "slopeMax", { label: "Slope threshold", min: 0.0, max: 1.0, step: 0.01 });
  _toggle(brushBody, fp, "eraseAllSlots", {
    label: "Erase all slots",
    hint: "While erasing, remove every slot's instances instead of only the selected one",
  });
  _dropdown(brushBody, ts.brush, "previewShape", { label: "Preview shape", options: { Dome: "dome", Circle: "circle" } });

  // ── Selected slot's settings ───────────────────────────────────────────────
  function foliageTextureLabel(slot) {
    if (slot.texturePreviewName) return `${slot.texturePreviewName} (preview)`;
    if (isAssetRef(slot.textureUrl)) return projectAssets.nameOf(slot.textureUrl) ?? "imported";
    if (slot.textureUrl) return slot.textureUrl.split(/[/\\]/).pop() || slot.textureUrl;
    return "(none)";
  }

  const settingsHost = document.createElement("div");
  panel.appendChild(settingsHost);
  panel._foliageTexInfo = [];

  function rebuildSettings(expand = false) {
    settingsHost.innerHTML = "";
    panel._foliageTexInfo = [];
    if (fp.erase) return;
    const i = fp.activeSlot;
    const slot = ts.foliageSlots[i];
    if (!slot) return;
    const loaded = isLoaded(i);
    const sBody = _section(
      settingsHost,
      loaded ? `${slot.name} — settings` : `Slot ${i + 1} — load a texture`,
      expand || !loaded,
    );
    const hdr = sBody.previousElementSibling;
    const structCb = () => app.foliageSlotStructureChanged(i);
    const matCb = () => app.foliageSlotMaterialChanged(i);

    panel._foliageTexInfo[i] = _info(sBody, "Texture", foliageTextureLabel(slot));
    const texBtn = _button(sBody, { title: "Load texture", onClick: () => app.loadFoliageTexture(i) });
    installDropZone(texBtn, {
      hint: "Drop image as texture",
      pickFile: tryGetImageFileFromAnyDrop,
      onFile: async (file) => { await app.loadFoliageTexture(i, file); },
    });
    if (!loaded) return;

    _text(sBody, slot, "name", {
      label: "Name",
      onChange: () => {
        if (hdr) hdr.innerHTML = _arrowSvg + " " + `${slot.name} — settings`;
        palette.refresh();
      },
    });
    _toggle(sBody, slot, "enabled", { label: "Enabled", onChange: structCb });
    _slider(sBody, slot, "baseScale", { label: "Base scale", min: 0.1, max: 5, step: 0.05, onChange: structCb });
    _toggle(sBody, slot, "alignToNormal", { label: "Align to normal", onChange: structCb });

    const csBody = _section(sBody, "Card structure", false);
    _slider(csBody, slot, "planeCount", { label: "Plane count", min: 1, max: 6, step: 1, onChange: structCb });
    _dropdown(csBody, slot, "planeSpread", { label: "Spread", options: { "360° radial": "full", "180° fan": "half" }, onChange: structCb });
    _dropdown(csBody, slot, "tiltMode", { label: "Tilt mode", options: { "Stable random": "stable", Symmetric: "symmetric" }, onChange: structCb });
    _slider(csBody, slot, "tilt", { label: "Tilt amount", min: 0, max: 1.5, step: 0.01, onChange: structCb });
    _slider(csBody, slot, "structureSeed", { label: "Seed", min: 0, max: 999999, step: 1, onChange: structCb });
    _slider(csBody, slot, "width", { label: "Width", min: 0.1, max: 10, step: 0.1, onChange: structCb });
    _slider(csBody, slot, "height", { label: "Height", min: 0.1, max: 10, step: 0.1, onChange: structCb });

    const mBody = _section(sBody, "Material", false);
    _slider(mBody, slot, "alphaTest", { label: "Alpha test", min: 0.1, max: 0.95, step: 0.01, onChange: matCb });
    _slider(mBody, slot, "roughness", { label: "Roughness", min: 0, max: 1, step: 0.01, onChange: matCb });
    _color(mBody, slot, "colorTint", { label: "Color tint", onChange: matCb });
    _slider(mBody, slot, "groundOcclusion", { label: "Ground AO", min: 0, max: 2, step: 0.01, onChange: matCb });
    _slider(mBody, slot, "normalBending", { label: "Normal bend", min: 0, max: 1, step: 0.01, onChange: matCb });
    _slider(mBody, slot, "sssIntensity", { label: "SSS intensity", min: 0, max: 5, step: 0.1, onChange: matCb });

    const wBody = _section(sBody, "Wind", false);
    _slider(wBody, slot, "swaySpeed", { label: "Speed", min: 0, max: 5, step: 0.1, onChange: matCb });
    _slider(wBody, slot, "swayStrength", { label: "Strength", min: 0, max: 0.5, step: 0.01, onChange: matCb });
  }
  rebuildSettings();

  // ── More ───────────────────────────────────────────────────────────────────
  const moreBody = _section(panel, "More", false);

  const massBody = _section(moreBody, "Mass Place Foliage", false);
  _slider(massBody, fp, "massPlaceCount", { label: "Number of instances", min: 1, max: 50000, step: 1 });
  _toggle(massBody, fp, "massPlaceKeepExisting", { label: "Keep existing foliage" });
  _button(massBody, {
    title: "Place",
    onClick: () => { if (!fp.erase) app.massPlaceFoliage(); },
  });

  const visBody = _section(moreBody, "Billboard LOD", false);
  _slider(visBody, ts.billboardFoliageLod, "lod0Distance", { label: "Full cards → reduced", min: 20, max: 400, step: 5 });
  _slider(visBody, ts.billboardFoliageLod, "lod1Distance", { label: "Reduced → single card", min: 50, max: 800, step: 10 });
  _slider(visBody, ts.billboardFoliageLod, "fadeOutDistance", { label: "Hide distance", min: 50, max: 2000, step: 10 });
  _info(visBody, "LOD", "Near: all planes · Mid: 2 planes · Far: 1 plane · Then hidden.");

  _separator(moreBody);
  _button(moreBody, {
    title: "Clear all foliage",
    onClick: () => { if (confirm("Clear ALL placed foliage?")) app.clearAllFoliage(); },
  });

  // Called by foliageEnvironment after a texture lands.
  panel._updateFoliageTextureLabel = (slotIdx) => {
    panel._foliageTexInfo[slotIdx]?.update(foliageTextureLabel(ts.foliageSlots[slotIdx]));
    palette.refresh();
    if (!fp.erase && fp.activeSlot === slotIdx) rebuildSettings(true);
  };
  panel._rebuildFoliageUi = () => buildFoliagePanel(app);
  return panel;
}
