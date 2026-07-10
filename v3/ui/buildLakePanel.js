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

    // Everything below is shared by every lake in the scene.
    const onM = () => app.materialChanged?.();

    const water = _section(panel, "Water color", true);
    _hint(water, "Beer-Lambert absorption, per channel. Red absorbs fastest, which is what turns deep water teal.");
    _slider(water, lp, "absorptionR", { label: "Absorb R", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(water, lp, "absorptionG", { label: "Absorb G", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(water, lp, "absorptionB", { label: "Absorb B", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(water, lp, "absorptionScale", { label: "Absorb scale", min: 0, max: 60, step: 0.5, onChange: onM });
    _color (water, lp, "inscatterTint", { label: "Inscatter tint", onChange: onM });
    _slider(water, lp, "inscatterStrength", { label: "Inscatter", min: 0, max: 3, step: 0.01, onChange: onM });
    _slider(water, lp, "depthDistance", { label: "Depth distance", min: 1, max: 120, step: 0.5, onChange: onM,
      hint: "Metres of water over which absorption reaches full strength." });

    const surf = _section(panel, "Surface", false);
    _slider(surf, lp, "normalTiling",   { label: "Normal tiling", min: 0.005, max: 0.5, step: 0.005, onChange: onM,
      hint: "Repeats per metre. 0.05 = one tile every 20 m." });
    _slider(surf, lp, "normalStrength", { label: "Wave strength", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(surf, lp, "flowSpeed",      { label: "Flow speed", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(surf, lp, "flowAngle",      { label: "Flow angle", min: 0, max: 360, step: 1, onChange: onM });

    const optics = _section(panel, "Refraction / reflection", false);
    _slider(optics, lp, "refractionStrength",  { label: "Refraction", min: 0, max: 0.4, step: 0.005, onChange: onM,
      hint: "Beyond ~0.25 the wobble reads as jelly." });
    _slider(optics, lp, "fresnelScale",        { label: "Fresnel scale", min: 0, max: 2, step: 0.01, onChange: onM });
    _slider(optics, lp, "skyReflectIntensity", { label: "Sky reflect", min: 0, max: 3, step: 0.01, onChange: onM });

    const ssr = _section(panel, "Screen-space reflections", false);
    _hint(ssr, "Reflects whatever is on screen — banks, mountains, trees — by marching the reflected ray against the depth buffer the refraction already grabbed. Off-screen rays fall back to the sky gradient. Turning this off removes the march entirely, at no cost.");
    _toggle(ssr, lp, "ssrEnabled",     { label: "Enabled", onChange: onM });
    _slider(ssr, lp, "ssrStrength",    { label: "Strength", min: 0, max: 1, step: 0.01, onChange: onM,
      hint: "0 = sky gradient only, 1 = full screen-space hit colour." });
    _slider(ssr, lp, "ssrMaxDistance", { label: "Max distance", min: 5, max: 400, step: 1, onChange: onM,
      hint: "Metres the ray travels before giving up. Also sets the step size, so shorter is sharper." });
    _slider(ssr, lp, "ssrThickness",   { label: "Thickness", min: 0.05, max: 10, step: 0.05, onChange: onM,
      hint: "Assumed depth of a surface. Too small and rays tunnel through thin geometry; too large and they snap onto surfaces they should pass behind." });
    _slider(ssr, lp, "ssrEdgeFade",    { label: "Edge fade", min: 0, max: 0.5, step: 0.005, onChange: onM,
      hint: "Fades reflections near the screen border so they don't pop as geometry leaves the frame." });

    const glint = _section(panel, "Sun glint", false);
    _color (glint, lp, "sunColor",       { label: "Sun color", onChange: onM });
    _slider(glint, lp, "shininess",      { label: "Shininess", min: 1, max: 2000, step: 1, onChange: onM });
    _slider(glint, lp, "glintStrength",  { label: "Glow", min: 0, max: 20, step: 0.1, onChange: onM });
    _slider(glint, lp, "glintFresnel",   { label: "Fresnel influence", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(glint, lp, "glintSpread",    { label: "Spread", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(glint, lp, "glintShoreFade", { label: "Shore fade", min: 0, max: 1, step: 0.005, onChange: onM,
      hint: "Metres of water over which glints fade in, so they don't crawl up the beach." });

    const shore = _section(panel, "Shoreline", false);
    _slider(shore, lp, "shoreFade",      { label: "Shore fade", min: 0, max: 2, step: 0.01, onChange: onM,
      hint: "Metres of water over which the surface fades in at the waterline." });
    _slider(shore, lp, "surfaceOpacity", { label: "Surface opacity", min: 0, max: 1, step: 0.01, onChange: onM });

    const foam = _section(panel, "Foam", false);
    _hint(foam, "Widths are metres of vertical water depth, so the band keeps its size as the camera tilts.");
    _toggle(foam, lp, "foamEnabled",      { label: "Enabled", onChange: onM });
    _color (foam, lp, "foamColor",        { label: "Color", onChange: onM });
    _slider(foam, lp, "foamWidth",        { label: "Band width", min: 0.02, max: 4, step: 0.01, onChange: onM });
    _slider(foam, lp, "foamSharpness",    { label: "Sharpness", min: 0.2, max: 4, step: 0.01, onChange: onM,
      hint: ">1 pulls the foam tighter against the shore." });
    _slider(foam, lp, "foamIntensity",    { label: "Intensity", min: 0, max: 2, step: 0.01, onChange: onM });
    _slider(foam, lp, "foamCutoff",       { label: "Cutoff", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(foam, lp, "foamTransition",   { label: "Edge softness", min: 0.01, max: 0.5, step: 0.005, onChange: onM });
    _slider(foam, lp, "foamNoiseScale",   { label: "Cell scale", min: 0.05, max: 4, step: 0.05, onChange: onM,
      hint: "Worley cells per metre." });
    _slider(foam, lp, "foamNoiseSpeed",   { label: "Drift speed", min: 0, max: 0.5, step: 0.005, onChange: onM });
    _slider(foam, lp, "foamJitter",       { label: "Cell jitter", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(foam, lp, "foamWarpScale",    { label: "Warp scale", min: 0.05, max: 2, step: 0.01, onChange: onM });
    _slider(foam, lp, "foamWarpStrength", { label: "Warp strength", min: 0, max: 2, step: 0.01, onChange: onM,
      hint: "Turns the cellular pattern into a ragged waterline. At 0 the foam reads as bubbles." });

    const pulse = _section(panel, "Pulse rings", false);
    _toggle(pulse, lp, "pulseEnabled",    { label: "Enabled", onChange: onM });
    _color (pulse, lp, "pulseColor",      { label: "Color", onChange: onM });
    _slider(pulse, lp, "pulseSpeed",      { label: "Rings / sec", min: 0, max: 2, step: 0.01, onChange: onM });
    _slider(pulse, lp, "pulseMaxDepth",   { label: "Travel depth", min: 0.2, max: 12, step: 0.1, onChange: onM,
      hint: "Vertical depth a ring reaches before dying." });
    _slider(pulse, lp, "pulseRingWidth",  { label: "Ring width", min: 0.01, max: 1, step: 0.005, onChange: onM });
    _slider(pulse, lp, "pulseIntensity",  { label: "Intensity", min: 0, max: 2, step: 0.01, onChange: onM });
    _slider(pulse, lp, "pulse2Intensity", { label: "2nd ring intensity", min: 0, max: 2, step: 0.01, onChange: onM });
    _slider(pulse, lp, "pulseStagger",    { label: "2nd ring offset", min: 0, max: 1, step: 0.01, onChange: onM });
    _slider(pulse, lp, "pulseFade",       { label: "Fade", min: 0, max: 5, step: 0.01, onChange: onM });
    _slider(pulse, lp, "pulseSharpness",  { label: "Sharpness", min: 0.2, max: 4, step: 0.01, onChange: onM });
    _slider(pulse, lp, "pulseNoiseAmt",   { label: "Noise breakup", min: 0, max: 1, step: 0.01, onChange: onM });
  }

  refresh();
  return { refresh };
}
