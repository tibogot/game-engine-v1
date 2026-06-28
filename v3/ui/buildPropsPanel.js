import { bakeObjectThumbnails } from "../../v2/tools/objectThumbnails.js";
import { proceduralThumbnailItems } from "../../v2/core/props/proceduralObjectProps.js";

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

const GLB_EXTS = new Set(["glb", "gltf"]);

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

function _button(parent, opts) {
  const { title, onClick, hint } = opts;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "section-btn";
  btn.textContent = title;
  if (hint) btn.title = hint;
  btn.addEventListener("click", onClick);
  parent.appendChild(btn);
}

export async function defaultBakeProceduralThumbnails(renderer, size = 192) {
  return bakeObjectThumbnails({
    renderer,
    size,
    items: proceduralThumbnailItems(),
  });
}

/** Build the v2 props panel into #props-panel. */

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

export function buildPropsPanel(app) {
const panel = document.getElementById("props-panel");
if (!panel) return null;
panel.innerHTML = "";
      const ts = app.toolState;

      // --- Placement Mode ---
      const modeBody = _section(panel, "Placement");
      _dropdown(modeBody, ts.props, "placementMode", {
        label: "Mode",
        options: { "Place (click)": "place", "Paint (brush)": "paint" },
      });
      const stampHint = document.createElement("p");
      stampHint.style.cssText =
        "margin:6px 0 0; font-size:11px; color:var(--text-dim); line-height:1.35;";
      stampHint.textContent =
        "Place mode reuses the last rotation + scale per prop type. After placing, use W/E/R on the gizmo to move, rotate, or scale. Q toggles gizmo LOCAL/WORLD space. Right-click empty space (or Esc) to deselect. Hold Shift while clicking to place another copy without deselecting.";
      modeBody.appendChild(stampHint);

      // --- Scene counts / caps ---
      const statsBody = _section(panel, "Scene Count", false);
      const statsEl = document.createElement("div");
      statsEl.id = "prop-stats-display";
      statsEl.style.cssText =
        "font-size:11px; color:var(--text-dim); line-height:1.5; padding:2px 0 4px;";
      statsBody.appendChild(statsEl);

      function refreshPropStatsDisplay() {
        const s = app.getPropStats?.();
        if (!s) {
          statsEl.textContent = "—";
          return;
        }
        const lines = [
          `Total: ${s.total}`,
          `Static (instanced): ${s.staticCount}`,
          `Live groups (flag, procedural…): ${s.liveGroupCount}`,
          `Live instanced (coin/heart/key): ${s.liveInstancedCount}`,
          `Cap: ${s.maxPerType} instances per static type / submesh`,
        ];
        if (s.nearCapTypes?.length) {
          lines.push("");
          lines.push("Near or at cap:");
          for (const t of s.nearCapTypes.slice(0, 5)) {
            const pct = Math.round((t.count / s.maxPerType) * 100);
            lines.push(
              `${t.atCap ? "⚠ " : "• "}${t.name}: ${t.count} / ${s.maxPerType} (${pct}%)`,
            );
          }
          if (s.nearCapTypes.some((t) => t.atCap)) {
            lines.push("At cap — new instances of that type will not render.");
          }
        }
        statsEl.innerHTML = lines
          .map((line) => (line === "" ? "<br>" : `<div>${line}</div>`))
          .join("");
      }

      panel._refreshPropStats = refreshPropStatsDisplay;
      refreshPropStatsDisplay();

      // --- Active slot ---
      const slotBody = _section(panel, "Active Type");
      function rebuildSlotPicker() {
        slotBody.innerHTML = "";
        const slotOpts = {};
        for (let i = 0; i < ts.propSlots.length; i++)
          slotOpts[ts.propSlots[i].name] = i;
        if (Object.keys(slotOpts).length === 0) slotOpts["(none)"] = -1;
        _dropdown(slotBody, ts.props, "activeSlot", {
          label: "Active type",
          options: slotOpts,
        });
      }
      rebuildSlotPicker();

      // --- Import / Primitives ---
      const importBody = _section(panel, "Import");
      installDropZone(importBody, {
        hint: "Drop .glb to import",
        pickFile: tryGetGlbFileFromAnyDrop,
        onFile: async (file) => {
          await app.importPropGlb(file);
          rebuildAll();
        },
      });
      _button(importBody, {
        title: "Import GLB...",
        onClick: async () => {
          await app.importPropGlb();
          rebuildAll();
        },
      });
      _button(importBody, {
        title: "+ Import material (folder)...",
        onClick: () => {
          if (!app.propTextureLibrary) return;
          const inp = document.createElement("input");
          inp.type = "file";
          inp.webkitdirectory = true;
          inp.multiple = true;
          inp.addEventListener("change", () => {
            if (!inp.files || inp.files.length === 0) return;
            const newMat = app.propTextureLibrary.addMaterialFromFiles(
              Array.from(inp.files),
            );
            if (!newMat) {
              console.warn(
                "[V2] Material import: no albedo/diff map detected in folder. Check filenames for _diff/_color/_basecolor suffix.",
              );
              return;
            }
            console.log(
              `[V2] Imported material "${newMat.name}" (id ${newMat.id})`,
            );
            rebuildAll();
          });
          inp.click();
        },
      });

      const primBody = _section(panel, "Add Primitive", false);
      for (const shape of [
        "Cube",
        "Sphere",
        "Cylinder",
        "Plane",
        "Cone",
        "Torus",
        "Jump ramp",
      ]) {
        _button(primBody, {
          title: shape,
          onClick: () => {
            app.addPrimitive(shape);
            rebuildAll();
          },
        });
      }

      const liveBody = _section(panel, "Add Live Prop", false);
      installDropZone(liveBody, {
        hint: "Drop .glb as collectible",
        pickFile: tryGetGlbFileFromAnyDrop,
        onFile: async (file) => {
          await app.importGlbCollectible(file);
          rebuildAll();
        },
      });
      _button(liveBody, {
        title: "Flag",
        onClick: () => {
          app.addLiveProp("Flag");
          rebuildAll();
        },
      });
      _button(liveBody, {
        title: "Coin (collectible)",
        onClick: () => {
          app.addLiveProp("Coin");
          rebuildAll();
        },
      });
      _button(liveBody, {
        title: "Heart (collectible)",
        onClick: () => {
          app.addLiveProp("Heart");
          rebuildAll();
        },
      });
      _button(liveBody, {
        title: "Key (collectible)",
        onClick: () => {
          app.addLiveProp("Key");
          rebuildAll();
        },
      });
      _button(liveBody, {
        title: "Import GLB Collectible...",
        onClick: async () => {
          await app.importGlbCollectible();
          rebuildAll();
        },
      });

      // Procedural objects (objects/index.js registry) — a thumbnail grid:
      // each card is a big square preview + label (bake memoized on app).
      const objBody = _section(panel, "Procedural Objects", false);
      const grid = document.createElement("div");
      grid.style.cssText =
        "display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:4px 0;";
      objBody.appendChild(grid);
      const _procCards = [];
      for (const label of app.getProceduralPropLabels?.() ?? []) {
        const card = document.createElement("button");
        card.className = "section-btn";
        card.title = label;
        card.style.cssText =
          "display:flex;flex-direction:column;align-items:center;gap:4px;height:auto;padding:6px;";
        const thumb = document.createElement("div");
        thumb.style.cssText =
          "width:100%;aspect-ratio:1/1;background:#1b1b1b;border:1px solid var(--border,#3c3c3c);border-radius:4px;background-size:contain;background-repeat:no-repeat;background-position:center;";
        const cap = document.createElement("span");
        cap.textContent = label;
        cap.style.cssText =
          "font-size:11px;line-height:1.15;text-align:center;white-space:normal;";
        card.appendChild(thumb);
        card.appendChild(cap);
        card.addEventListener("click", () => {
          app.addLiveProp(label);
          rebuildAll();
        });
        grid.appendChild(card);
        _procCards.push({ label, thumb });
      }
      app
        .bakeProceduralThumbnails?.(192)
        .then((thumbs) => {
          if (!thumbs) return;
          for (const { label, thumb } of _procCards) {
            const url = thumbs.get(label);
            if (url) thumb.style.backgroundImage = `url("${url}")`;
          }
        })
        .catch(() => {});

      // --- Loaded Props ---
      const loadedBody = _section(panel, "Loaded Props", false);
      function rebuildLoadedSlots() {
        loadedBody.innerHTML = "";
        ts.propSlots.forEach((slot, i) => {
          const row = document.createElement("div");
          row.style.cssText =
            "display:flex; flex-direction:column; gap:4px; padding:4px 0; border-bottom:1px solid var(--border);";
          const headerRow = document.createElement("div");
          headerRow.style.cssText =
            "display:flex; align-items:center; justify-content:space-between;";
          const label = document.createElement("span");
          label.textContent = slot.name;
          label.style.cssText = "font-size:12px; color:var(--text);";
          headerRow.appendChild(label);
          const rmBtn = document.createElement("button");
          rmBtn.textContent = "Remove";
          rmBtn.className = "prop-row-btn";
          rmBtn.style.cssText =
            "font-size:11px; padding:2px 8px; background:var(--bg-item); color:var(--text-dim); border:1px solid var(--border); border-radius:var(--radius); cursor:pointer;";
          rmBtn.addEventListener("click", () => {
            app.removePropSlot(i);
            rebuildAll();
          });
          headerRow.appendChild(rmBtn);
          row.appendChild(headerRow);
          if (slot.builtin && app.propTextureLibrary) {
            const matOpts = app.propTextureLibrary.getMaterialOptionsForUi();
            if (Object.keys(matOpts).length > 0) {
              const proxy = {
                materialId: slot.materialId ?? Object.values(matOpts)[0],
              };
              _dropdown(row, proxy, "materialId", {
                label: "Material",
                options: matOpts,
                onChange: () => {
                  app.setPrimitiveMaterial(i, proxy.materialId);
                  rebuildAll();
                },
              });
              const propMat = app.propTextureLibrary.getById(
                proxy.materialId,
              );
              if (propMat && propMat.type === "pbr") {
                _slider(row, propMat, "uvScale", {
                  label: "UV tile",
                  min: 0.01,
                  max: 20,
                  step: 0.001,
                  curve: "log",
                  onChange: () => {
                    propMat.uUVScale.value = propMat.uvScale;
                  },
                });
                _slider(row, propMat, "normalStrength", {
                  label: "Normal",
                  min: 0,
                  max: 3,
                  step: 0.05,
                  onChange: () => {
                    propMat.uNormalStr.value = propMat.normalStrength;
                  },
                });
                _slider(row, propMat, "aoStrength", {
                  label: "AO",
                  min: 0,
                  max: 2,
                  step: 0.05,
                  onChange: () => {
                    propMat.uAOStr.value = propMat.aoStrength;
                  },
                });
                _slider(row, propMat, "roughStrength", {
                  label: "Rough",
                  min: 0,
                  max: 2,
                  step: 0.05,
                  onChange: () => {
                    propMat.uRoughStr.value = propMat.roughStrength;
                  },
                });
                const triProxy = { triplanar: !!slot.triplanar };
                _toggle(row, triProxy, "triplanar", {
                  label: "Triplanar",
                  onChange: () =>
                    app.setPrimitiveTriplanar(i, triProxy.triplanar),
                });
              }
            }
          }
          if (!slot.builtin && !slot.live) {
            const lodRow = document.createElement("div");
            lodRow.style.cssText = "display:flex; gap:4px;";
            const btnStyle =
              "font-size:10px; padding:2px 6px; background:var(--bg-item); color:var(--text-dim); border:1px solid var(--border); border-radius:var(--radius); cursor:pointer; flex:1;";
            const lod1Btn = document.createElement("button");
            lod1Btn.textContent = "Import LOD1";
            lod1Btn.className = "prop-row-btn";
            lod1Btn.style.cssText = btnStyle;
            lod1Btn.addEventListener("click", async () => {
              await app.importPropLod(i, 1);
            });
            installDropZone(lod1Btn, {
              hint: "Drop .glb as LOD1",
              pickFile: tryGetGlbFileFromAnyDrop,
              onFile: async (file) => {
                await app.importPropLod(i, 1, file);
              },
            });
            lodRow.appendChild(lod1Btn);
            const lod2Btn = document.createElement("button");
            lod2Btn.textContent = "Import LOD2";
            lod2Btn.className = "prop-row-btn";
            lod2Btn.style.cssText = btnStyle;
            lod2Btn.addEventListener("click", async () => {
              await app.importPropLod(i, 2);
            });
            installDropZone(lod2Btn, {
              hint: "Drop .glb as LOD2",
              pickFile: tryGetGlbFileFromAnyDrop,
              onFile: async (file) => {
                await app.importPropLod(i, 2, file);
              },
            });
            lodRow.appendChild(lod2Btn);
            row.appendChild(lodRow);
          }
          loadedBody.appendChild(row);
        });
      }
      rebuildLoadedSlots();

      _separator(panel);

      // --- Sink / Gizmo ---
      const gizmoBody = _section(panel, "Transform");
      _slider(gizmoBody, ts.props, "sinkOffset", {
        label: "Sink offset",
        min: 0,
        max: 10,
        step: 0.1,
      });
      _dropdown(gizmoBody, ts.props, "transformMode", {
        label: "Gizmo [W/E/R]",
        options: {
          "Translate (W)": "translate",
          "Rotate (E)": "rotate",
          "Scale (R)": "scale",
        },
        onChange: () => app.propTransformModeChanged(),
      });
      const gizmoSpaceHint = document.createElement("p");
      gizmoSpaceHint.id = "gizmo-space-hint";
      gizmoSpaceHint.className = "mode-hint";
      gizmoSpaceHint.style.cssText =
        "margin:6px 0 0; font-size:11px; color:var(--text-dim); line-height:1.35;";
      gizmoBody.appendChild(gizmoSpaceHint);
      app.refreshGizmoHud?.();

      _separator(panel);

      // --- Paint Settings ---
      const paintBody = _section(panel, "Paint Settings");
      _slider(paintBody, ts.props, "density", {
        label: "Density",
        min: 0.05,
        max: 5,
        step: 0.05,
      });
      _slider(paintBody, ts.props, "minSpacing", {
        label: "Min spacing",
        min: 0.5,
        max: 20,
        step: 0.5,
      });
      _slider(paintBody, ts.props, "scaleMin", {
        label: "Scale min",
        min: 0.1,
        max: 5,
        step: 0.05,
      });
      _slider(paintBody, ts.props, "scaleMax", {
        label: "Scale max",
        min: 0.1,
        max: 5,
        step: 0.05,
      });
      _toggle(paintBody, ts.props, "randomRotation", {
        label: "Random rotation",
      });

      _separator(panel);

      // --- LOD Distances ---
      const lodBody = _section(panel, "LOD Distances", false);
      _slider(lodBody, ts.propLod, "lod0Distance", {
        label: "LOD0 → LOD1",
        min: 10,
        max: 300,
        step: 5,
      });
      _slider(lodBody, ts.propLod, "lod1Distance", {
        label: "LOD1 → LOD2",
        min: 20,
        max: 600,
        step: 10,
      });
      _slider(lodBody, ts.propLod, "fadeOutDistance", {
        label: "Fade-out dist",
        min: 50,
        max: 1500,
        step: 10,
      });
      _toggle(lodBody, ts.propLod, "castShadow", {
        label: "Cast shadow",
        onChange: () => app.propCastShadowChanged(),
      });

      _separator(panel);

      // --- Live Prop Params (shown when a live prop is selected) ---
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
          if (geometry) {
            app.propStore._bump();
          } else {
            const entry = lpm.getLiveEntry(instIdx);
            if (entry?.obj.setParam) entry.obj.setParam(key, p[key]);
            lpm.updateParamSnap(instIdx);
          }
        }

        // Procedural objects: build controls from the registry schema. Any
        // change rebuilds the prop (geometry=true → _bump), so no setParam.
        const objSchema = app.getProceduralSchema?.(type.factoryId);
        if (objSchema) {
          for (const e of objSchema) {
            if (e.type === "sep") {
              _separator(sec);
            } else if (e.type === "slider") {
              _slider(sec, p, e.key, {
                label: e.label,
                min: e.min,
                max: e.max,
                step: e.step,
                onChange: () => syncParam(e.key, true),
              });
            } else if (e.type === "color") {
              _color(sec, p, e.key, {
                label: e.label,
                onChange: () => syncParam(e.key, true),
              });
            } else if (e.type === "toggle") {
              _toggle(sec, p, e.key, {
                label: e.label,
                onChange: () => syncParam(e.key, true),
              });
            } else if (e.type === "select") {
              _dropdown(sec, p, e.key, {
                label: e.label,
                options: e.options,
                onChange: () => syncParam(e.key, true),
              });
            }
            // "file" (texture) params are skipped on placed props for now.
          }
          return;
        }

        if ("flagColor" in p) {
          _color(sec, p, "flagColor", {
            label: "Color",
            onChange: () => syncParam("flagColor", false),
          });
        }
        if ("textureUrl" in p) {
          const row = document.createElement("div");
          row.className = "prop-row";
          row.innerHTML = `<span class="prop-label">Texture</span><div class="prop-value" style="display:flex;gap:4px;align-items:center;"><span class="prop-slider-val" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.textureUrl ? p.textureUrl.split("/").pop() : "(none)"}</span><button class="section-btn" style="padding:2px 8px;font-size:11px;">Import...</button></div>`;
          const btn = row.querySelector("button");
          const label = row.querySelector(".prop-slider-val");
          btn.addEventListener("click", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.accept = "image/*";
            input.addEventListener("change", () => {
              const file = input.files[0];
              if (!file) return;
              const url = URL.createObjectURL(file);
              p.textureUrl = url;
              label.textContent = file.name;
              syncParam("textureUrl", false);
            });
            input.click();
          });
          sec.appendChild(row);
        }
        if ("clothWidth" in p) {
          _slider(sec, p, "clothWidth", {
            label: "Cloth width",
            min: 0.5,
            max: 6,
            step: 0.1,
            onChange: () => syncParam("clothWidth", true),
          });
        }
        if ("clothHeight" in p) {
          _slider(sec, p, "clothHeight", {
            label: "Cloth height",
            min: 0.3,
            max: 8,
            step: 0.1,
            onChange: () => syncParam("clothHeight", true),
          });
        }
        if ("poleHeight" in p) {
          _slider(sec, p, "poleHeight", {
            label: "Pole height",
            min: 1,
            max: 12,
            step: 0.5,
            onChange: () => syncParam("poleHeight", true),
          });
        }
        if ("windIntensity" in p) {
          _slider(sec, p, "windIntensity", {
            label: "Wind intensity",
            min: 0,
            max: 800,
            step: 10,
            onChange: () => syncParam("windIntensity", false),
          });
        }
        if ("windSpeed" in p) {
          _slider(sec, p, "windSpeed", {
            label: "Wind speed",
            min: 100,
            max: 3000,
            step: 50,
            onChange: () => syncParam("windSpeed", false),
          });
        }
        if ("windDirection" in p) {
          _slider(sec, p, "windDirection", {
            label: "Wind direction",
            min: 0,
            max: 360,
            step: 1,
            onChange: () => syncParam("windDirection", false),
          });
        }
        if ("showPole" in p) {
          _toggle(sec, p, "showPole", {
            label: "Show pole",
            onChange: () => syncParam("showPole", false),
          });
        }

        // --- Collectible params (coin, heart, key, GLB collectibles) ---
        if ("pickupRadius" in p) {
          _slider(sec, p, "pickupRadius", {
            label: "Pickup radius",
            min: 0.3,
            max: 6,
            step: 0.1,
            onChange: () => syncParam("pickupRadius", false),
          });
        }
        if ("spinSpeed" in p) {
          _slider(sec, p, "spinSpeed", {
            label: "Spin speed",
            min: 0,
            max: 6,
            step: 0.1,
            onChange: () => syncParam("spinSpeed", false),
          });
        }
        if ("bobAmp" in p) {
          _slider(sec, p, "bobAmp", {
            label: "Bob amplitude",
            min: 0,
            max: 0.6,
            step: 0.01,
            onChange: () => syncParam("bobAmp", false),
          });
        }
        if ("bobSpeed" in p) {
          _slider(sec, p, "bobSpeed", {
            label: "Bob speed",
            min: 0,
            max: 5,
            step: 0.1,
            onChange: () => syncParam("bobSpeed", false),
          });
        }
      }

      app.onPropSelectionChanged = showLiveParamsUi;

      _separator(panel);

      _installBvhDebugUi(panel, app);
      _separator(panel);

      // --- Actions ---
      _button(panel, { title: "Rebake BVH", onClick: () => app.rebakeBvh() });
      const bvhHint = document.createElement("p");
      bvhHint.style.cssText =
        "margin:6px 0 0; font-size:11px; color:var(--text-dim); line-height:1.35;";
      bvhHint.textContent =
        "Props contribute one bounding box per instance to the player BVH (not full mesh geometry). Rebake after bulk edits.";
      panel.appendChild(bvhHint);
      _separator(panel);
      _button(panel, {
        title: "Delete Selected [Del]",
        onClick: () => app.deleteSelectedProp(),
      });
      _button(panel, {
        title: "Duplicate Selected [Ctrl+D]",
        onClick: () => app.duplicateSelectedProp(),
      });
      _button(panel, {
        title: "Clear All Props",
        onClick: () => app.clearAllProps(),
      });

      function rebuildAll() {
        rebuildSlotPicker();
        rebuildLoadedSlots();
        refreshPropStatsDisplay();
      }

      panel._rebuildPropUi = rebuildAll;

      return panel;
    }
