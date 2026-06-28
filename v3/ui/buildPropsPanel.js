import { bakeObjectThumbnails } from "../../v2/tools/objectThumbnails.js";
import { proceduralThumbnailItems } from "../../v2/core/props/proceduralObjectProps.js";

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
  hdr.innerHTML = `${_arrowSvg} ${title}`;
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
  const { label, min, max, step = 0.01, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  const cur = obj[key];
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${min}" max="${max}" step="${step}" value="${cur}"><input type="number" class="prop-num-input" title="Type an exact value" min="${min}" max="${max}" step="${step}" value="${_fmt(cur, step)}"></div></div>`;
  const sl = row.querySelector(".prop-slider");
  const num = row.querySelector(".prop-num-input");
  const syncNum = () => { num.value = _fmt(obj[key], step); };
  sl.addEventListener("input", () => {
    obj[key] = Number(sl.value);
    syncNum();
    onChange?.();
  });
  const commitNum = () => {
    const raw = String(num.value).trim();
    if (!raw || raw === "-" || raw === ".") { syncNum(); return; }
    let v = parseFloat(raw);
    if (!Number.isFinite(v)) { syncNum(); return; }
    v = Math.min(max, Math.max(min, v));
    obj[key] = v;
    sl.value = String(v);
    syncNum();
    onChange?.();
  };
  num.addEventListener("change", commitNum);
  num.addEventListener("keydown", (e) => { if (e.key === "Enter") num.blur(); });
  parent.appendChild(row);
}

function _dropdown(parent, obj, key, opts) {
  const { label, options, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  const lbl = document.createElement("span");
  lbl.className = "prop-label";
  lbl.textContent = label;
  const val = document.createElement("div");
  val.className = "prop-value";
  const sel = document.createElement("select");
  sel.className = "prop-dropdown";
  for (const [text, v] of Object.entries(options)) {
    const opt = document.createElement("option");
    opt.value = String(v);
    opt.textContent = text;
    if (obj[key] === v) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => {
    const raw = sel.value;
    obj[key] = raw === "-1" ? -1 : (Number.isNaN(Number(raw)) ? raw : Number(raw));
    onChange?.();
  });
  val.appendChild(sel);
  row.appendChild(lbl);
  row.appendChild(val);
  parent.appendChild(row);
}

function _toggle(parent, obj, key, opts) {
  const { label, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><button type="button" class="prop-toggle ${obj[key] ? "checked" : ""}">${_checkSvg}</button></div>`;
  const btn = row.querySelector(".prop-toggle");
  btn.addEventListener("click", () => {
    obj[key] = !obj[key];
    btn.classList.toggle("checked", obj[key]);
    onChange?.();
  });
  parent.appendChild(row);
}

function _button(parent, { title, onClick, hint, style }) {
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
      file = pickFile(e);
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

/**
 * Build the v2-style props panel into #props-panel.
 * @param {object} app — callbacks + state from main.js
 */
export function buildPropsPanel(app) {
  const panel = document.getElementById("props-panel");
  if (!panel) return null;
  panel.innerHTML = "";

  const propState = app.propState;
  const propSlots = app.propSlots;
  const propLod = app.propLod;

  // ── Placement Mode ────────────────────────────────────────────────────────
  const modeBody = _section(panel, "Placement");
  _dropdown(modeBody, propState, "placementMode", {
    label: "Mode",
    options: { "Place (click)": "place", "Paint (brush)": "paint" },
  });
  const stampHint = document.createElement("p");
  stampHint.className = "mode-hint";
  stampHint.style.marginTop = "6px";
  stampHint.textContent =
    "Place mode reuses the last rotation + scale per prop type. The cyan ghost shows when nothing is selected — right-click empty space to deselect and preview the next placement.";
  modeBody.appendChild(stampHint);

  // ── Active slot ───────────────────────────────────────────────────────────
  const slotBody = _section(panel, "Active Type");
  function rebuildSlotPicker() {
    slotBody.innerHTML = "";
    const slotOpts = {};
    for (let i = 0; i < propSlots.length; i++) slotOpts[propSlots[i].name] = i;
    if (Object.keys(slotOpts).length === 0) slotOpts["(none)"] = -1;
    _dropdown(slotBody, propState, "activeSlot", {
      label: "Active type",
      options: slotOpts,
    });
  }
  rebuildSlotPicker();

  // ── Import ────────────────────────────────────────────────────────────────
  const importBody = _section(panel, "Import");
  const importDrop = document.createElement("div");
  importDrop.style.cssText = "font-size:11px;color:var(--text-dim);padding:4px 0 6px;text-align:center;";
  importDrop.textContent = "Drop .glb to import";
  importBody.appendChild(importDrop);
  installDropZone(importBody, {
    hint: "Drop .glb",
    pickFile: (e) => {
      const f = e.dataTransfer?.files?.[0];
      return f && /\.glb$|\.gltf$/i.test(f.name) ? f : null;
    },
    onFile: async (file) => { await app.importPropGlb(file); rebuildAll(); },
  });
  _button(importBody, {
    title: "Import GLB...",
    onClick: async () => { await app.importPropGlb(); rebuildAll(); },
  });

  // ── Primitives ────────────────────────────────────────────────────────────
  const primBody = _section(panel, "Add Primitive", false);
  for (const shape of ["Cube", "Sphere", "Cylinder", "Plane", "Cone", "Torus", "Jump ramp"]) {
    _button(primBody, {
      title: shape,
      onClick: () => { app.addPrimitive(shape); rebuildAll(); },
    });
  }

  // ── Live props ────────────────────────────────────────────────────────────
  const liveBody = _section(panel, "Add Live Prop", false);
  const liveDrop = document.createElement("div");
  liveDrop.style.cssText = "font-size:11px;color:var(--text-dim);padding:4px 0 6px;text-align:center;";
  liveDrop.textContent = "Drop .glb as collectible";
  liveBody.appendChild(liveDrop);
  installDropZone(liveBody, {
    hint: "Drop .glb",
    pickFile: (e) => {
      const f = e.dataTransfer?.files?.[0];
      return f && /\.glb$|\.gltf$/i.test(f.name) ? f : null;
    },
    onFile: async (file) => { await app.importGlbCollectible?.(file); rebuildAll(); },
  });
  for (const name of ["Flag", "Coin (collectible)", "Heart (collectible)", "Key (collectible)"]) {
    const short = name.split(" ")[0];
    _button(liveBody, {
      title: name,
      onClick: () => { app.addLiveProp(short); rebuildAll(); },
    });
  }
  _button(liveBody, {
    title: "Import GLB Collectible...",
    onClick: async () => { await app.importGlbCollectible?.(); rebuildAll(); },
  });

  // ── Procedural objects thumbnail grid ─────────────────────────────────────
  const objBody = _section(panel, "Procedural Objects", false);
  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px 0;";
  objBody.appendChild(grid);
  const procCards = [];
  for (const label of app.getProceduralPropLabels?.() ?? []) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "section-btn";
    card.title = label;
    card.style.cssText =
      "display:flex;flex-direction:column;align-items:center;gap:4px;height:auto;padding:6px;margin-top:0;";
    const thumb = document.createElement("div");
    thumb.style.cssText =
      "width:100%;aspect-ratio:1/1;background:#1b1b1b;border:1px solid var(--border,#3c3c3c);border-radius:4px;background-size:contain;background-repeat:no-repeat;background-position:center;";
    const cap = document.createElement("span");
    cap.textContent = label;
    cap.style.cssText = "font-size:11px;line-height:1.15;text-align:center;white-space:normal;";
    card.appendChild(thumb);
    card.appendChild(cap);
    card.addEventListener("click", () => { app.addLiveProp(label); rebuildAll(); });
    grid.appendChild(card);
    procCards.push({ label, thumb });
  }
  const _startProcThumbBake = () => {
    const bake = () => app.bakeProceduralThumbnails?.(192);
    const done = (thumbs) => {
      if (!thumbs) return;
      for (const { label, thumb } of procCards) {
        const url = thumbs.get(label);
        if (url) thumb.style.backgroundImage = `url("${url}")`;
      }
    };
    if (app.runRendererSideWork) {
      app.runRendererSideWork(() => bake()).then(done).catch(() => {});
    } else if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => bake()?.then(done).catch(() => {}), { timeout: 8000 });
    } else {
      setTimeout(() => bake()?.then(done).catch(() => {}), 2000);
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(_startProcThumbBake, { timeout: 8000 });
  } else {
    setTimeout(_startProcThumbBake, 2000);
  }

  // ── Loaded props ──────────────────────────────────────────────────────────
  const loadedBody = _section(panel, "Loaded Props", false);
  function rebuildLoadedSlots() {
    loadedBody.innerHTML = "";
    propSlots.forEach((slot, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;flex-direction:column;gap:4px;padding:4px 0;border-bottom:1px solid var(--border,#333);";
      const headerRow = document.createElement("div");
      headerRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;";
      const label = document.createElement("span");
      label.textContent = slot.name;
      label.style.cssText = "font-size:12px;color:var(--text,#ccc);";
      headerRow.appendChild(label);
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";
      rmBtn.textContent = "Remove";
      rmBtn.className = "prop-row-btn";
      rmBtn.addEventListener("click", () => { app.removePropSlot(i); rebuildAll(); });
      headerRow.appendChild(rmBtn);
      row.appendChild(headerRow);

      if (slot.builtin) {
        const mat = app.propStore?.types[slot.typeIdx]?.entries?.[0]?.material;
        if (mat) {
          const colorRow = document.createElement("div");
          colorRow.className = "prop-row";
          colorRow.innerHTML = `<span class="prop-label">Color</span>`;
          const val = document.createElement("div");
          val.className = "prop-value";
          const inp = document.createElement("input");
          inp.type = "color";
          inp.value = "#" + mat.color.getHexString();
          inp.style.cssText = "width:36px;height:22px;border:none;padding:0;cursor:pointer;background:none";
          inp.addEventListener("input", () => mat.color.set(inp.value));
          val.appendChild(inp);
          colorRow.appendChild(val);
          row.appendChild(colorRow);
        }
      }

      if (!slot.builtin && !slot.live) {
        const lodRow = document.createElement("div");
        lodRow.style.cssText = "display:flex;gap:4px;margin-top:2px";
        for (const [lod, lodLabel] of [[1, "Import LOD1"], [2, "Import LOD2"]]) {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = lodLabel;
          b.className = "prop-row-btn";
          b.style.flex = "1";
          b.addEventListener("click", () => app.importPropLod(i, lod));
          installDropZone(b, {
            hint: `Drop .glb as LOD${lod}`,
            pickFile: (e) => {
              const f = e.dataTransfer?.files?.[0];
              return f && /\.glb$|\.gltf$/i.test(f.name) ? f : null;
            },
            onFile: async (file) => { await app.importPropLod(i, lod, file); },
          });
          lodRow.appendChild(b);
        }
        row.appendChild(lodRow);
      }
      loadedBody.appendChild(row);
    });
  }
  rebuildLoadedSlots();

  _separator(panel);

  // ── Transform ─────────────────────────────────────────────────────────────
  const gizmoBody = _section(panel, "Transform");
  _slider(gizmoBody, propState, "sinkOffset", { label: "Sink offset", min: 0, max: 10, step: 0.1 });
  _dropdown(gizmoBody, propState, "transformMode", {
    label: "Gizmo [W/E/R]",
    options: {
      "Translate (W)": "translate",
      "Rotate (E)": "rotate",
      "Scale (R)": "scale",
    },
    onChange: () => app.propTransformModeChanged?.(),
  });

  _separator(panel);

  // ── Paint settings ────────────────────────────────────────────────────────
  const paintBody = _section(panel, "Paint Settings");
  _slider(paintBody, propState, "density", { label: "Density", min: 0.05, max: 5, step: 0.05 });
  _slider(paintBody, propState, "minSpacing", { label: "Min spacing", min: 0.5, max: 20, step: 0.5 });
  _slider(paintBody, propState, "scaleMin", { label: "Scale min", min: 0.1, max: 5, step: 0.05 });
  _slider(paintBody, propState, "scaleMax", { label: "Scale max", min: 0.1, max: 5, step: 0.05 });
  _toggle(paintBody, propState, "randomRotation", { label: "Random rotation" });

  const brushHint = document.createElement("p");
  brushHint.className = "mode-hint";
  brushHint.style.marginTop = "6px";
  brushHint.innerHTML = "Paint mode uses the global brush radius (<kbd>Shift</kbd>+wheel) and <kbd>Alt</kbd> to erase while dragging.";
  paintBody.appendChild(brushHint);

  _separator(panel);

  // ── LOD ───────────────────────────────────────────────────────────────────
  const lodBody = _section(panel, "LOD Distances", false);
  _slider(lodBody, propLod, "lod0Distance", { label: "LOD0 → LOD1", min: 10, max: 300, step: 5, onChange: () => app.onPropLodChanged?.() });
  _slider(lodBody, propLod, "lod1Distance", { label: "LOD1 → LOD2", min: 20, max: 600, step: 10, onChange: () => app.onPropLodChanged?.() });
  _slider(lodBody, propLod, "fadeOutDistance", { label: "Fade-out dist", min: 50, max: 1500, step: 10, onChange: () => app.onPropLodChanged?.() });
  _toggle(lodBody, propLod, "castShadow", { label: "Cast shadow", onChange: () => app.propCastShadowChanged?.() });

  _separator(panel);

  // ── Live prop params (dynamic) ──────────────────────────────────────────────
  const liveParamsContainer = document.createElement("div");
  liveParamsContainer.id = "live-params-container";
  panel.appendChild(liveParamsContainer);

  function showLiveParamsUi(instIdx) {
    liveParamsContainer.innerHTML = "";
    if (instIdx == null) return;
    const inst = app.propStore.instances[instIdx];
    if (!inst?.liveParams) return;
    const type = app.propStore.types[inst.typeIdx];
    if (!type?.live) return;

    const sec = _section(liveParamsContainer, `${type.name} Params`);
    const p = inst.liveParams;
    const lpm = app.livePropManager;

    function syncParam(key, geometry) {
      if (geometry) app.propStore._bump();
      else {
        const entry = lpm.getLiveEntry?.(instIdx);
        if (entry?.obj.setParam) entry.obj.setParam(key, p[key]);
        lpm.updateParamSnap?.(instIdx);
      }
    }

    const objSchema = app.getProceduralSchema?.(type.factoryId);
    if (objSchema) {
      for (const e of objSchema) {
        if (e.type === "slider") {
          _slider(sec, p, e.key, {
            label: e.label, min: e.min, max: e.max, step: e.step,
            onChange: () => syncParam(e.key, true),
          });
        } else if (e.type === "color") {
          const row = document.createElement("div");
          row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">${e.label}</span>`;
          const val = document.createElement("div");
          val.className = "prop-value";
          const inp = document.createElement("input");
          inp.type = "color";
          inp.value = p[e.key] ?? "#ffffff";
          inp.style.cssText = "width:36px;height:22px;border:none;padding:0;cursor:pointer;background:none";
          inp.addEventListener("input", () => { p[e.key] = inp.value; syncParam(e.key, true); });
          val.appendChild(inp);
          row.appendChild(val);
          sec.appendChild(row);
        } else if (e.type === "toggle") {
          _toggle(sec, p, e.key, { label: e.label, onChange: () => syncParam(e.key, true) });
        }
      }
      return;
    }

    // Built-in live props (flag, coin, etc.)
    if ("flagColor" in p) {
      const row = document.createElement("div");
      row.className = "prop-row";
      row.innerHTML = `<span class="prop-label">Color</span>`;
      const val = document.createElement("div");
      val.className = "prop-value";
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = p.flagColor ?? "#ff0000";
      inp.style.cssText = "width:36px;height:22px;border:none;padding:0;cursor:pointer;background:none";
      inp.addEventListener("input", () => { p.flagColor = inp.value; syncParam("flagColor", false); });
      val.appendChild(inp);
      row.appendChild(val);
      sec.appendChild(row);
    }
    for (const [key, label, min, max, step] of [
      ["windIntensity", "Wind str.", 0, 800, 10],
      ["windSpeed", "Wind speed", 100, 3000, 50],
      ["spinSpeed", "Spin speed", 0, 20, 0.1],
    ]) {
      if (!(key in p)) continue;
      _slider(sec, p, key, {
        label, min, max, step,
        onChange: () => syncParam(key, false),
      });
    }
  }

  app.onPropSelectionChanged = showLiveParamsUi;

  _separator(panel);

  // ── Actions ───────────────────────────────────────────────────────────────
  const actionsBody = _section(panel, "Actions", false);
  _button(actionsBody, {
    title: "Delete Selected [Del]",
    style: "color:#f66",
    onClick: () => app.deleteSelectedProp?.(),
  });
  _button(actionsBody, {
    title: "Duplicate [Ctrl+D]",
    onClick: () => app.duplicateSelectedProp?.(),
  });
  _button(actionsBody, {
    title: "Clear All Props",
    style: "color:#f66",
    onClick: () => app.clearAllProps?.(),
  });

  const countRow = document.createElement("div");
  countRow.className = "prop-row";
  countRow.style.padding = "4px 0";
  countRow.innerHTML = `<span class="prop-label">Total props</span><span class="insp-value" id="prop-total-count">0</span>`;
  panel.appendChild(countRow);

  function rebuildAll() {
    rebuildSlotPicker();
    rebuildLoadedSlots();
    app.refreshPropCount?.();
  }

  panel._rebuildPropUi = rebuildAll;
  return panel;
}

/** Default bake helper wired from main.js renderer. */
export async function defaultBakeProceduralThumbnails(renderer, size = 192) {
  return bakeObjectThumbnails({
    renderer,
    size,
    items: proceduralThumbnailItems(),
  });
}
