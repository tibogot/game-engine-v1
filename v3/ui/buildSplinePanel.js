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

/** Build the v2 spline panel into #spline-panel. */

export function buildSplinePanel(app) {
const panel = document.getElementById("spline-panel");
if (!panel) return null;
panel.innerHTML = "";
      const sp = app.toolState.spline;
      const kLive = (key) => () => app.splineKerbLiveChanged(key);

      const pathBody = _section(panel, "Path");
      _toggle(pathBody, sp, "showHandles", {
        label: "Show handles",
        onChange: () => app.splineChanged(),
      });
      _button(pathBody, {
        title: "Delete selected point",
        onClick: () => app.splineDeleteSelected(),
      });
      _button(pathBody, {
        title: "Clear all points",
        onClick: () => app.splineClearAll(),
      });
      _slider(pathBody, sp, "selectedPointY", {
        label: "Selected Y",
        min: -50,
        max: 300,
        step: 0.1,
        onChange: () => app.splineSelectedYChanged(),
      });
      _toggle(pathBody, sp, "closed", {
        label: "Close path (loop)",
        onChange: () => app.splineClosedChanged(),
      });

      _separator(panel);
      const platBody = _section(panel, "Plateau");
      _slider(platBody, sp, "plateauHeight", {
        label: "Plateau Y",
        min: -200,
        max: 600,
        step: 0.5,
      });
      _slider(platBody, sp, "plateauFalloff", {
        label: "Plateau falloff",
        min: 0,
        max: 120,
        step: 0.25,
      });
      _slider(platBody, sp, "plateauHalfWidth", {
        label: "Open half-width",
        min: 0.25,
        max: 180,
        step: 0.25,
      });
      _button(platBody, {
        title: "Apply plateau to terrain",
        onClick: () => app.splineApplyPlateau(),
      });

      _separator(panel);
      const placeBody = _section(panel, "Placement");
      _dropdown(placeBody, sp, "objectType", {
        label: "Place object",
        options: {
          "Trees (active tree slot)": "trees",
          "Props (active prop slot)": "props",
          "Procedural object (spline)": "object",
          "Procedural tunnel": "tunnel",
          "Guardrail (W profile)": "guardrail",
          "Guardrail From Road": "guardrailFromRoad",
          "Kerb (spline path)": "kerbSpline",
          "Kerb From Road": "kerbFromRoad",
          "Wall (spline path)": "wallSpline",
          "Fence (spline path)": "fenceSpline",
          "Barrier (spline path)": "barrierSpline",
        },
      });
      // Which registry object to extrude along the spline (objectType "object")
      _dropdown(placeBody, sp, "objectId", {
        label: "↳ Object",
        options: app.getProceduralObjectOptions?.() ?? {},
      });
      _slider(placeBody, sp, "spacing", {
        label: "Spacing",
        min: 0.5,
        max: 40,
        step: 0.5,
      });
      _slider(placeBody, sp, "scaleMin", {
        label: "Scale min",
        min: 0.05,
        max: 20,
        step: 0.05,
      });
      _slider(placeBody, sp, "scaleMax", {
        label: "Scale max",
        min: 0.05,
        max: 20,
        step: 0.05,
      });
      _toggle(placeBody, sp, "alignToPath", { label: "Align to path" });

      const tunnelBody = _section(panel, "Tunnel", false);
      _slider(tunnelBody, sp, "tunnelRadius", {
        label: "Base radius",
        min: 1,
        max: 200,
        step: 0.25,
      });
      _slider(tunnelBody, sp, "tunnelRadialSegments", {
        label: "Radial segs",
        min: 6,
        max: 48,
        step: 1,
      });
      _slider(tunnelBody, sp, "tunnelPathSegments", {
        label: "Path segs",
        min: 40,
        max: 800,
        step: 10,
      });
      _color(tunnelBody, sp, "tunnelColor", { label: "Color" });
      const applyTunnelCaps = () => {
        for (const t of app.splineSystem?.tunnels ?? []) {
          t.capStart = !!sp.tunnelCapStart;
          t.capEnd = !!sp.tunnelCapEnd;
        }
        app.rebuildInteriorVolumes();
      };
      _toggle(tunnelBody, sp, "tunnelCapStart", {
        label: "Cap start (sealed)",
        onChange: applyTunnelCaps,
      });
      _toggle(tunnelBody, sp, "tunnelCapEnd", {
        label: "Cap end (sealed)",
        onChange: applyTunnelCaps,
      });
      const capHint = document.createElement("p");
      capHint.style.cssText =
        "font-size:11px;color:var(--text-dim);margin:6px 0 0;line-height:1.35";
      capHint.textContent =
        "Open ends fade outdoor light near mouths. Cap the end you sealed with terrain.";
      tunnelBody.appendChild(capHint);
      _button(tunnelBody, {
        title: "Clear all tunnels",
        onClick: () => app.splineClearTunnels(),
      });

      const linearBody = _section(panel, "Wall / fence / barrier", false);
      _slider(linearBody, sp, "splineWallHeight", {
        label: "Wall height",
        min: 0.2,
        max: 40,
        step: 0.05,
      });
      _slider(linearBody, sp, "splineWallWidth", {
        label: "Wall thickness",
        min: 0.02,
        max: 2,
        step: 0.01,
      });
      _slider(linearBody, sp, "splineWallPathSegs", {
        label: "Wall path segs",
        min: 12,
        max: 160,
        step: 1,
      });
      _color(linearBody, sp, "splineWallColor", { label: "Wall color" });
      _separator(linearBody);
      _slider(linearBody, sp, "splineFenceHeight", {
        label: "Fence height",
        min: 0.35,
        max: 8,
        step: 0.05,
      });
      _slider(linearBody, sp, "splineFencePostSpacing", {
        label: "Fence post spacing",
        min: 0.5,
        max: 12,
        step: 0.05,
      });
      _slider(linearBody, sp, "splineFencePostWidth", {
        label: "Fence post width",
        min: 0.02,
        max: 0.35,
        step: 0.005,
      });
      _slider(linearBody, sp, "splineFencePostDepth", {
        label: "Fence post depth",
        min: 0.02,
        max: 0.35,
        step: 0.005,
      });
      _slider(linearBody, sp, "splineFenceRailThick", {
        label: "Fence rail thick",
        min: 0.015,
        max: 0.2,
        step: 0.005,
      });
      _color(linearBody, sp, "splineFenceColor", { label: "Fence color" });
      _separator(linearBody);
      _slider(linearBody, sp, "splineBarrierHeight", {
        label: "Barrier height",
        min: 0.12,
        max: 3,
        step: 0.01,
      });
      _slider(linearBody, sp, "splineBarrierDepth", {
        label: "Barrier depth",
        min: 0.08,
        max: 2.5,
        step: 0.01,
      });
      _slider(linearBody, sp, "splineBarrierPathSegs", {
        label: "Barrier path segs",
        min: 12,
        max: 160,
        step: 1,
      });
      _color(linearBody, sp, "splineBarrierColor", {
        label: "Barrier color",
      });
      _button(linearBody, {
        title: "Clear walls / fences / barriers",
        onClick: () => app.splineClearLinearFeatures(),
      });

      const guardBody = _section(panel, "Guardrail", false);
      _slider(guardBody, sp, "guardrailHeight", {
        label: "Rail height",
        min: 0.05,
        max: 2.5,
        step: 0.01,
      });
      _slider(guardBody, sp, "guardrailThickness", {
        label: "Rail thickness",
        min: 0.01,
        max: 0.35,
        step: 0.005,
      });
      _slider(guardBody, sp, "guardrailDepth", {
        label: "Rail depth",
        min: 0.05,
        max: 1.4,
        step: 0.01,
      });
      _slider(guardBody, sp, "guardrailCrownDepth", {
        label: "W crown depth",
        min: 0.0,
        max: 0.35,
        step: 0.005,
      });
      _slider(guardBody, sp, "guardrailPathSegments", {
        label: "Path segs",
        min: 40,
        max: 1200,
        step: 10,
      });
      _slider(guardBody, sp, "guardrailPostSpacing", {
        label: "Post spacing",
        min: 0.5,
        max: 8,
        step: 0.05,
      });
      _slider(guardBody, sp, "guardrailFromRoadPostSpacingMul", {
        label: "Post spacing ×",
        min: 1,
        max: 12,
        step: 0.25,
      });
      _slider(guardBody, sp, "guardrailPostWidth", {
        label: "Post width",
        min: 0.03,
        max: 0.4,
        step: 0.005,
      });
      _slider(guardBody, sp, "guardrailPostDepth", {
        label: "Post depth",
        min: 0.03,
        max: 0.4,
        step: 0.005,
      });
      _slider(guardBody, sp, "guardrailPostHeight", {
        label: "Post height",
        min: 0.2,
        max: 3,
        step: 0.01,
      });
      _slider(guardBody, sp, "guardrailRailYOffset", {
        label: "Rail Y offset",
        min: 0.0,
        max: 3,
        step: 0.01,
      });
      _slider(guardBody, sp, "guardrailPostSink", {
        label: "Post sink",
        min: 0.0,
        max: 0.6,
        step: 0.005,
      });
      _color(guardBody, sp, "guardrailColor", { label: "Color" });

      const gfrBody = _section(panel, "Guardrail From Road", false);
      _slider(gfrBody, sp, "guardrailFromRoadIndex", {
        label: "Road index",
        min: 0,
        max: 63,
        step: 1,
      });
      _dropdown(gfrBody, sp, "guardrailFromRoadSide", {
        label: "Side",
        options: { Left: "left", Right: "right", Both: "both" },
      });
      _slider(gfrBody, sp, "guardrailFromRoadEdgeOffset", {
        label: "Edge offset",
        min: -2,
        max: 8,
        step: 0.05,
      });
      _slider(gfrBody, sp, "guardrailFromRoadStart", {
        label: "Start %",
        min: 0,
        max: 1,
        step: 0.01,
      });
      _slider(gfrBody, sp, "guardrailFromRoadEnd", {
        label: "End %",
        min: 0,
        max: 1,
        step: 0.01,
      });

      const kerbBody = _section(panel, "Kerb From Road", false);
      _slider(kerbBody, sp, "activeKerbIndex", {
        label: "Active kerb",
        min: 0,
        max: 255,
        step: 1,
        onChange: kLive("activeKerbIndex"),
      });
      _toggle(kerbBody, sp, "kerbAutoApplyActive", {
        label: "Auto-apply active",
      });
      _button(kerbBody, {
        title: "Load active kerb settings",
        onClick: () => app.splineKerbSelect(),
      });
      _button(kerbBody, {
        title: "Apply settings to active kerb",
        onClick: () => app.splineKerbApply(),
      });
      _button(kerbBody, {
        title: "Suggest from strongest turn",
        onClick: () => app.splineKerbSuggestFromCurvature(),
      });
      _button(kerbBody, {
        title: "Duplicate active kerb",
        onClick: () => app.splineKerbDuplicate(),
      });
      _button(kerbBody, {
        title: "Delete active kerb",
        onClick: () => app.splineKerbDelete(),
      });
      _separator(kerbBody);
      _dropdown(kerbBody, sp, "kerbSplineSide", {
        label: "Spline side",
        options: { Left: "left", Right: "right", Both: "both" },
        onChange: kLive("kerbSplineSide"),
      });
      _slider(kerbBody, sp, "kerbSplineLateralOffset", {
        label: "Spline lateral",
        min: -2,
        max: 4,
        step: 0.01,
        onChange: kLive("kerbSplineLateralOffset"),
      });
      _dropdown(kerbBody, sp, "kerbMeshStyle", {
        label: "Kerb mesh",
        options: { "Strip (PBR)": "strip", "Chunk (Smart Road)": "chunk" },
        onChange: kLive("kerbMeshStyle"),
      });
      _separator(kerbBody);
      _slider(kerbBody, sp, "kerbFromRoadIndex", {
        label: "Road index",
        min: 0,
        max: 63,
        step: 1,
        onChange: kLive("kerbFromRoadIndex"),
      });
      _dropdown(kerbBody, sp, "kerbFromRoadSide", {
        label: "Side",
        options: { Left: "left", Right: "right", Both: "both" },
        onChange: kLive("kerbFromRoadSide"),
      });
      _slider(kerbBody, sp, "kerbFromRoadEdgeOffset", {
        label: "Edge offset",
        min: -2,
        max: 4,
        step: 0.01,
        onChange: kLive("kerbFromRoadEdgeOffset"),
      });
      _slider(kerbBody, sp, "kerbFromRoadStart", {
        label: "Start %",
        min: 0,
        max: 1,
        step: 0.01,
        onChange: kLive("kerbFromRoadStart"),
      });
      _slider(kerbBody, sp, "kerbFromRoadEnd", {
        label: "End %",
        min: 0,
        max: 1,
        step: 0.01,
        onChange: kLive("kerbFromRoadEnd"),
      });
      _separator(kerbBody);
      _slider(kerbBody, sp, "kerbWidth", {
        label: "Width",
        min: 0.1,
        max: 3,
        step: 0.01,
        onChange: kLive("kerbWidth"),
      });
      _slider(kerbBody, sp, "kerbHeight", {
        label: "Height",
        min: 0.02,
        max: 0.8,
        step: 0.005,
        onChange: kLive("kerbHeight"),
      });
      _slider(kerbBody, sp, "kerbLipHeight", {
        label: "Inner lip",
        min: 0.0,
        max: 0.25,
        step: 0.005,
        onChange: kLive("kerbLipHeight"),
      });
      _slider(kerbBody, sp, "kerbTopInset", {
        label: "Top inset",
        min: 0.0,
        max: 0.95,
        step: 0.01,
        onChange: kLive("kerbTopInset"),
      });
      _slider(kerbBody, sp, "kerbPathSegments", {
        label: "Path segs",
        min: 40,
        max: 1200,
        step: 10,
        onChange: kLive("kerbPathSegments"),
      });
      _toggle(kerbBody, sp, "kerbSquareStripes", {
        label: "Square stripes",
        onChange: kLive("kerbSquareStripes"),
      });
      _slider(kerbBody, sp, "kerbStripeLength", {
        label: "Stripe length",
        min: 0.25,
        max: 10,
        step: 0.05,
        onChange: kLive("kerbStripeLength"),
      });
      _slider(kerbBody, sp, "kerbStripeSharpness", {
        label: "Stripe sharpness",
        min: 0.5,
        max: 1.0,
        step: 0.005,
        onChange: kLive("kerbStripeSharpness"),
      });
      _color(kerbBody, sp, "kerbColorA", {
        label: "Color A",
        onChange: kLive("kerbColorA"),
      });
      _color(kerbBody, sp, "kerbColorB", {
        label: "Color B",
        onChange: kLive("kerbColorB"),
      });
      _separator(kerbBody);
      _slider(kerbBody, sp, "kerbNormalStrength", {
        label: "Normal strength",
        min: 0.0,
        max: 2.0,
        step: 0.01,
        onChange: kLive("kerbNormalStrength"),
      });
      _slider(kerbBody, sp, "kerbRoughnessMul", {
        label: "Roughness x",
        min: 0.2,
        max: 2.0,
        step: 0.01,
        onChange: kLive("kerbRoughnessMul"),
      });
      _slider(kerbBody, sp, "kerbMetalness", {
        label: "Metalness",
        min: 0.0,
        max: 1.0,
        step: 0.01,
        onChange: kLive("kerbMetalness"),
      });
      _separator(kerbBody);
      _slider(kerbBody, sp, "kerbTexUvScaleU", {
        label: "Tex UV scale U",
        min: 0.1,
        max: 24,
        step: 0.05,
        onChange: kLive("kerbTexUvScaleU"),
      });
      _slider(kerbBody, sp, "kerbTexUvScaleV", {
        label: "Tex UV scale V",
        min: 0.1,
        max: 24,
        step: 0.05,
        onChange: kLive("kerbTexUvScaleV"),
      });
      _slider(kerbBody, sp, "kerbTexUvOffsetU", {
        label: "Tex UV offset U",
        min: -4,
        max: 4,
        step: 0.01,
        onChange: kLive("kerbTexUvOffsetU"),
      });
      _slider(kerbBody, sp, "kerbTexUvOffsetV", {
        label: "Tex UV offset V",
        min: -4,
        max: 4,
        step: 0.01,
        onChange: kLive("kerbTexUvOffsetV"),
      });
      _slider(kerbBody, sp, "kerbTexBrightness", {
        label: "Tex brightness",
        min: -0.35,
        max: 0.35,
        step: 0.005,
        onChange: kLive("kerbTexBrightness"),
      });
      _slider(kerbBody, sp, "kerbTexContrast", {
        label: "Tex contrast",
        min: 0.4,
        max: 2.2,
        step: 0.01,
        onChange: kLive("kerbTexContrast"),
      });
      _slider(kerbBody, sp, "kerbTexSaturation", {
        label: "Tex saturation",
        min: 0,
        max: 2,
        step: 0.01,
        onChange: kLive("kerbTexSaturation"),
      });

      _separator(panel);
      const bakeBody = _section(panel, "Bake");
      _button(bakeBody, {
        title: "Preview placement",
        onClick: () => app.splinePreview(),
      });
      _button(bakeBody, {
        title: "Bake placement",
        onClick: () => app.splineBake(),
      });
      _button(bakeBody, {
        title: "Clear preview",
        onClick: () => app.splineClearPreview(),
      });

      _separator(panel);
      const trainBody = _section(panel, "Train");
      _toggle(trainBody, sp, "showTrain", { label: "Show train" });
      _slider(trainBody, sp, "trainSpeed", {
        label: "Train speed",
        min: 0.5,
        max: 60,
        step: 0.5,
      });
      _slider(trainBody, sp, "trainScale", {
        label: "Train scale",
        min: 0.1,
        max: 10,
        step: 0.1,
      });

      return panel;
}
