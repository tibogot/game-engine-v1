/** V2 World tab UI — extracted from v2/editor.html buildWorldTab (no volumetric cloud sections). */

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

function _info(parent, label, value) {
  const row = document.createElement("div");
  row.className = "info-row";
  const valSpan = document.createElement("span");
  valSpan.className = "info-value";
  valSpan.textContent = value;
  row.innerHTML = `<span class="info-label">${label}</span>`;
  row.appendChild(valSpan);
  parent.appendChild(row);
  return {
    update(v) {
      valSpan.textContent = v;
    },
  };
}
function _buildProceduralSkyControls(parent, ts, app) {
  const ps = ts.proceduralSky;
  const wrap = document.createElement("div");
  parent.appendChild(wrap);

  const tod = _section(wrap, "Time of day", true);
  _slider(tod, ps, "timeOfDay", {
    label: "Time (0–24h)",
    min: 0,
    max: 24,
    step: 0.01,
    hint: "Drives the scene sun (writes Azimuth/Elevation). Smooth day↔night sweep.",
    onChange: () => app.setTimeOfDay?.(ps.timeOfDay),
  });
  _toggle(tod, ps, "autoAdvance", {
    label: "Auto-advance",
    hint: "Animate the day/night cycle over time",
  });
  _slider(tod, ps, "daySpeed", {
    label: "Day speed (h/s)",
    min: 0.05,
    max: 4,
    step: 0.05,
    hint: "Hours of time-of-day advanced per real second",
  });
  _slider(tod, ps, "latitude", {
    label: "Latitude °",
    min: -66,
    max: 66,
    step: 1,
    hint: "Tilts the sun/moon arc; higher = flatter arc + longer twilight.",
    onChange: () => app.setTimeOfDay?.(ps.timeOfDay),
  });
  _slider(tod, ps, "dayOfYear", {
    label: "Day of year",
    min: 1,
    max: 365,
    step: 1,
    hint: "Season → solar declination. 172 ≈ N summer solstice, 355 ≈ winter.",
    onChange: () => app.setTimeOfDay?.(ps.timeOfDay),
  });

  const atmo = _section(wrap, "Atmosphere (scattering)", true);
  _toggle(atmo, ps, "scatter", {
    label: "Physical scatter",
    hint: "On = Nishita atmosphere; off = analytic gradient (uses the Gradient colors below)",
  });
  _slider(atmo, ps, "sunIntensity", {
    label: "Sun intensity",
    min: 0,
    max: 50,
    step: 0.5,
  });
  _slider(atmo, ps, "rayleigh", {
    label: "Rayleigh",
    min: 0,
    max: 4,
    step: 0.05,
  });
  _slider(atmo, ps, "mie", { label: "Mie", min: 0, max: 4, step: 0.05 });
  _slider(atmo, ps, "mieG", {
    label: "Mie G (aureole)",
    min: 0,
    max: 0.99,
    step: 0.01,
  });
  _slider(atmo, ps, "atmoAltitude", {
    label: "Altitude (m)",
    min: 0,
    max: 8000,
    step: 50,
  });
  _slider(atmo, ps, "msAmount", {
    label: "Multi-scatter",
    min: 0,
    max: 3,
    step: 0.05,
    hint: "Ψms LUT multiple scattering. 1 = physical; energy-conserving, so it no longer washes the midday sky.",
  });
  _slider(atmo, ps, "atmoHorizonSoft", {
    label: "Horizon soft",
    min: 0.005,
    max: 0.3,
    step: 0.005,
    hint: "Soft terminator width. Higher = smoother twilight; removes the dawn/dusk scattering bands.",
  });
  _toggle(atmo, ps, "useLut", {
    label: "Sky-view LUT (perf)",
    hint: "Sample the pre-baked atmosphere LUT instead of marching per pixel. Big GPU win; re-bakes only when the sun moves.",
  });
  // "Horizon haze" (hazeHeight) lives in the Distance Fog section now (it
  // reads with the rest of the haze/fog controls — matches the lab layout).

  const grad = _section(wrap, "Gradient (analytic only)", false);
  _color(grad, ps, "zenithDay", { label: "Zenith day" });
  _color(grad, ps, "horizonDay", { label: "Horizon day" });
  _color(grad, ps, "zenithNight", { label: "Zenith night" });
  _color(grad, ps, "horizonNight", { label: "Horizon night" });
  _color(grad, ps, "sunsetColor", { label: "Sunset" });
  _color(grad, ps, "groundColor", { label: "Ground" });

  const sun = _section(wrap, "Sun", false);
  _color(sun, ps, "sunColor", { label: "Color" });
  _slider(sun, ps, "sunSizeDeg", {
    label: "Size (deg)",
    min: 0.2,
    max: 6,
    step: 0.05,
  });
  _slider(sun, ps, "sunGlowPow", {
    label: "Glow falloff",
    min: 10,
    max: 1000,
    step: 5,
  });
  _slider(sun, ps, "sunGlowStrength", {
    label: "Glow strength",
    min: 0,
    max: 2,
    step: 0.01,
  });
  _slider(sun, ps, "sunDiscBright", {
    label: "Disc bright",
    min: 0,
    max: 20,
    step: 0.1,
  });
  _slider(sun, ps, "sunBloom", {
    label: "Bloom feed",
    min: 0,
    max: 4,
    step: 0.05,
    hint: "Sun disc → selective-bloom buffer. Needs Post FX + Bloom ON; 0 = the sun never blooms.",
  });

  const moon = _section(wrap, "Moon", false);
  _color(moon, ps, "moonColor", { label: "Color" });
  _slider(moon, ps, "moonSizeDeg", {
    label: "Size (deg)",
    min: 0.2,
    max: 6,
    step: 0.05,
  });
  _slider(moon, ps, "moonGlowStrength", {
    label: "Glow strength",
    min: 0,
    max: 2,
    step: 0.01,
  });
  _slider(moon, ps, "moonDiscBright", {
    label: "Disc bright",
    min: 0,
    max: 10,
    step: 0.1,
  });
  _slider(moon, ps, "moonAge", {
    label: "Age (new→full)",
    min: 0,
    max: 1,
    step: 0.01,
    hint: "Synodic age: 0/1 = new, 0.5 = full. Drives the moon's position AND phase (lit by the real sun).",
  });
  _slider(moon, ps, "moonSurface", {
    label: "Surface detail",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(moon, ps, "moonEarthshine", {
    label: "Earthshine",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(moon, ps, "moonTermSoft", {
    label: "Terminator soft",
    min: 0,
    max: 0.3,
    step: 0.005,
  });

  const stars = _section(wrap, "Stars", false);
  _slider(stars, ps, "starDensity", {
    label: "Density",
    min: 0,
    max: 1000,
    step: 5,
  });
  _slider(stars, ps, "starThreshold", {
    label: "Threshold",
    min: 0,
    max: 1,
    step: 0.005,
  });
  _slider(stars, ps, "starSize", {
    label: "Size",
    min: 0,
    max: 0.5,
    step: 0.005,
  });
  _slider(stars, ps, "starBrightness", {
    label: "Brightness",
    min: 0,
    max: 3,
    step: 0.05,
  });
  _slider(stars, ps, "starTwinkle", {
    label: "Twinkle",
    min: 0,
    max: 10,
    step: 0.1,
  });

  const mw = _section(wrap, "Milky Way", false);
  _toggle(mw, ps, "milkyWayEnabled", { label: "Enabled" });
  _slider(mw, ps, "milkyWayIntensity", {
    label: "Intensity",
    min: 0,
    max: 3,
    step: 0.05,
  });
  _slider(mw, ps, "milkyWayWidth", {
    label: "Band width",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(mw, ps, "milkyWayScale", {
    label: "Scale",
    min: 0.5,
    max: 12,
    step: 0.1,
  });
  _color(mw, ps, "milkyWayColor1", { label: "Dust" });
  _color(mw, ps, "milkyWayColor2", { label: "Cloud" });

  const met = _section(wrap, "Shooting stars", false);
  _toggle(met, ps, "meteorEnabled", { label: "Enabled" });
  _slider(met, ps, "meteorIntensity", {
    label: "Intensity",
    min: 0,
    max: 3,
    step: 0.05,
  });
  _slider(met, ps, "meteorRate", {
    label: "Rate",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(met, ps, "meteorSpeed", {
    label: "Speed",
    min: 0.1,
    max: 4,
    step: 0.05,
  });
  _slider(met, ps, "meteorWidth", {
    label: "Width",
    min: 0.001,
    max: 0.05,
    step: 0.001,
  });
  _slider(met, ps, "meteorLength", {
    label: "Trail length",
    min: 0.01,
    max: 0.5,
    step: 0.01,
  });

  const cir = _section(wrap, "High clouds (cirrus)", false);
  _toggle(cir, ps, "cloudEnabled", { label: "Enabled" });
  _slider(cir, ps, "cloudCoverage", {
    label: "Coverage",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(cir, ps, "cloudDensity", {
    label: "Density",
    min: 0,
    max: 2,
    step: 0.02,
  });
  _slider(cir, ps, "cloudOpacity", {
    label: "Opacity",
    min: 0,
    max: 1,
    step: 0.02,
  });
  _slider(cir, ps, "cloudScale", {
    label: "Scale",
    min: 0.1,
    max: 3,
    step: 0.02,
  });
  _slider(cir, ps, "cloudStretch", {
    label: "Streakiness",
    min: 0.5,
    max: 6,
    step: 0.05,
  });
  _slider(cir, ps, "cloudSharpness", {
    label: "Edge sharpness",
    min: 0.01,
    max: 1,
    step: 0.01,
  });
  _slider(cir, ps, "cloudDetail", {
    label: "Detail",
    min: 0,
    max: 1,
    step: 0.02,
  });
  _slider(cir, ps, "cloudSunTint", {
    label: "Sun tint",
    min: 0,
    max: 3,
    step: 0.05,
  });
  _slider(cir, ps, "cloudSpeed", {
    label: "Drift speed",
    min: 0,
    max: 0.1,
    step: 0.001,
  });
  _slider(cir, ps, "cloudWindDeg", {
    label: "Wind dir",
    min: 0,
    max: 360,
    step: 1,
  });
  _color(cir, ps, "cloudColor", { label: "Color" });
  _slider(cir, ps, "cloudAerial", {
    label: "Aerial fade",
    min: 0,
    max: 1,
    step: 0.02,
  });

  const vc = ts.volumetricCloudDayNight;
  // 1:1 with the daynight-sky lab's "Cloud layer (volumetric)" panel —
  // identical order, labels and ranges (lab daynight-sky.html L922-946) so
  // the two read the same side-by-side.
  const vcSec = _section(wrap, "Cloud layer (volumetric)", false);
  _toggle(vcSec, vc, "enabled", {
    label: "enabled",
    hint: "Raymarched cloud deck (daynight-sky port). Procedural sky only.",
  });
  _slider(vcSec, vc, "coverage", {
    label: "coverage",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(vcSec, vc, "softness", {
    label: "softness",
    min: 0.02,
    max: 0.4,
    step: 0.01,
  });
  _slider(vcSec, vc, "densityMul", {
    label: "densityMul",
    min: 0.5,
    max: 16,
    step: 0.1,
  });
  _slider(vcSec, vc, "erode", {
    label: "erode",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(vcSec, vc, "detailMul", {
    label: "detailMul",
    min: 1,
    max: 8,
    step: 0.1,
  });
  _slider(vcSec, vc, "base", {
    label: "base",
    min: 600,
    max: 4000,
    step: 10,
  });
  _slider(vcSec, vc, "thickness", {
    label: "thickness",
    min: 200,
    max: 2500,
    step: 10,
  });
  _slider(vcSec, vc, "planetRadius", {
    label: "planetRadius",
    min: 15000,
    max: 400000,
    step: 1000,
  });
  _slider(vcSec, vc, "scale", {
    label: "scale",
    min: 0.00005,
    max: 0.002,
    step: 0.00001,
  });
  _dropdown(vcSec, vc, "bufferScale", {
    label: "Resolution",
    options: { "Half (fast)": 0.5, "¾": 0.75, "Full (sharp)": 1.0 },
  });
  _slider(vcSec, vc, "steps", {
    label: "steps",
    min: 16,
    max: 128,
    step: 1,
  });
  _slider(vcSec, vc, "lightSteps", {
    label: "lightSteps",
    min: 2,
    max: 8,
    step: 1,
  });
  _slider(vcSec, vc, "emptySkip", {
    label: "Empty-space skip",
    min: 1,
    max: 4,
    step: 0.1,
  });
  _slider(vcSec, vc, "opacity", {
    label: "opacity",
    min: 0.2,
    max: 3,
    step: 0.05,
  });
  _slider(vcSec, vc, "phaseG", {
    label: "phaseG",
    min: 0,
    max: 0.9,
    step: 0.01,
  });
  _slider(vcSec, vc, "powder", {
    label: "powder",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(vcSec, vc, "msAmount", {
    label: "★ Multi-scatter",
    min: 0,
    max: 1.5,
    step: 0.05,
  });
  _slider(vcSec, vc, "msExtinction", {
    label: "MS light depth",
    min: 0.1,
    max: 0.9,
    step: 0.05,
  });
  _slider(vcSec, vc, "msEccentricity", {
    label: "MS phase broad",
    min: 0.1,
    max: 0.9,
    step: 0.05,
  });
  _slider(vcSec, vc, "windSpeed", {
    label: "windSpeed",
    min: 0,
    max: 0.2,
    step: 0.001,
  });
  _slider(vcSec, vc, "windDeg", {
    label: "windDeg",
    min: 0,
    max: 360,
    step: 1,
  });
  _toggle(vcSec, vc, "aerialEnabled", { label: "Aerial perspective" });
  _slider(vcSec, vc, "aerialDensity", {
    label: "Aerial density",
    min: 0.00002,
    max: 0.0006,
    step: 0.00001,
  });
  _slider(vcSec, vc, "aerialAmount", {
    label: "Aerial amount",
    min: 0,
    max: 1,
    step: 0.05,
  });
  // v2 extras — real cloud params the lab hard-codes (not in its UI).
  const vcAdv = _section(wrap, "Cloud layer · v2 extras", false);
  _slider(vcAdv, vc, "lightAbsorb", {
    label: "lightAbsorb",
    min: 0.2,
    max: 3,
    step: 0.05,
  });
  _slider(vcAdv, vc, "maxDist", {
    label: "maxDist",
    min: 8000,
    max: 48000,
    step: 1000,
  });
  _slider(vcAdv, vc, "msContribution", {
    label: "msContribution",
    min: 0.1,
    max: 0.9,
    step: 0.05,
  });

  // Cloud shadows on terrain + ocean (lab "Cloud shadows" section).
  const csSec = _section(wrap, "Cloud shadows", false);
  _toggle(csSec, ts.cloudShadows, "enabled", {
    label: "enabled",
    hint: "Deck shadows on terrain + ocean. Needs the cloud deck enabled; fades at night.",
  });
  _slider(csSec, ts.cloudShadows, "strength", {
    label: "strength",
    min: 0,
    max: 1,
    step: 0.01,
  });

  // God rays / light shafts (lab "God rays" section). Cloud-aware: shafts
  // stream through the deck's gaps. Needs the deck enabled + sun on screen.
  const gr = ts.cloudGodRays;
  const grSec = _section(wrap, "God rays", false);
  _toggle(grSec, gr, "enabled", {
    label: "enabled",
    hint: "Light shafts from the sun through the cloud gaps. Deck must be enabled.",
  });
  _toggle(grSec, gr, "skipOffscreen", { label: "Skip off-screen" });
  _slider(grSec, gr, "effectScale", {
    label: "Buffer scale",
    min: 0.2,
    max: 1,
    step: 0.05,
  });
  _slider(grSec, gr, "exposure", {
    label: "exposure",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(grSec, gr, "samples", {
    label: "samples",
    min: 16,
    max: 96,
    step: 1,
  });
  _slider(grSec, gr, "density", {
    label: "density",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(grSec, gr, "decay", {
    label: "decay",
    min: 0.8,
    max: 1,
    step: 0.001,
  });
  _slider(grSec, gr, "weight", {
    label: "weight",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(grSec, gr, "occCloudSteps", {
    label: "Cloud occ steps",
    min: 4,
    max: 16,
    step: 1,
  });
  _slider(grSec, gr, "occLumThreshold", {
    label: "Occlusion gate",
    min: 0,
    max: 0.9,
    step: 0.01,
    hint: "Occlusion pixels dimmer than this can't feed shafts — stops lit foliage/water acting as fake light sources.",
  });
  _slider(grSec, gr, "sunDistance", {
    label: "sunDistance",
    min: 1000,
    max: 4800,
    step: 50,
    hint: "Keep below v2's 5000 far plane or the sun disc clips",
  });
  _slider(grSec, gr, "sunDiscRadius", {
    label: "sunDiscRadius",
    min: 40,
    max: 400,
    step: 5,
  });
  _color(grSec, gr, "sunTint", { label: "Sun tint" });
  _toggle(grSec, gr, "matchLightColor", { label: "Tint = light color" });

  // Cloud bloom (lab "Bloom" section) — blooms the final scene+clouds
  // frame. Owns-the-frame path only (turn v2 POST FX OFF to see it).
  const bl = ts.cloudBloom;
  const blSec = _section(wrap, "Bloom", false);
  _toggle(blSec, bl, "enabled", {
    label: "enabled",
    hint: "Blooms sunlit cloud edges. Only with v2 POST FX OFF (the deck owns the frame).",
  });
  _slider(blSec, bl, "strength", {
    label: "strength",
    min: 0,
    max: 2,
    step: 0.01,
  });
  _slider(blSec, bl, "radius", {
    label: "radius",
    min: 0,
    max: 1,
    step: 0.01,
  });
  _slider(blSec, bl, "threshold", {
    label: "threshold",
    min: 0,
    max: 1.5,
    step: 0.01,
  });

  const ibl = _section(wrap, "Lighting (IBL)", false);
  _button(ibl, {
    title: "Rebake Sky IBL",
    onClick: () => app.rebuildProceduralSkyEnv?.(),
  });

  return wrap;
}

export function buildWorldPanel(app) {
  const container = document.getElementById("tab-world");
  if (!container) return null;
  container.innerHTML = "";
      const ts = app.toolState;
      const refreshTp = () => app.ui?.pane?.refresh?.();

      // --- Sun & Exposure ---
      const sunBody = _section(container, "Sun & Exposure");
      _slider(sunBody, ts.light, "sunAzimuth", {
        label: "Azimuth",
        min: 0,
        max: 360,
        step: 1,
      });
      _slider(sunBody, ts.light, "sunElevation", {
        label: "Elevation",
        min: -90,
        max: 90,
        step: 1,
      });
      _color(sunBody, ts.light, "dirColor", { label: "Sun color" });
      _slider(sunBody, ts.light, "dirIntensity", {
        label: "Intensity",
        min: 0,
        max: 5,
        step: 0.1,
      });
      _slider(sunBody, ts.light, "moonIntensity", {
        label: "Moon intensity",
        min: 0,
        max: 2,
        step: 0.05,
        hint: "Night key-light brightness — the light switches to the moon below the horizon (Procedural sky).",
      });
      _slider(sunBody, ts.light, "sunDistance", {
        label: "Distance",
        min: 200,
        max: 2000,
        step: 10,
      });
      _separator(sunBody);
      _color(sunBody, ts.light, "hemiSkyColor", { label: "Ambient sky" });
      _color(sunBody, ts.light, "hemiGroundColor", { label: "Ambient gnd" });
      _slider(sunBody, ts.light, "hemiIntensity", {
        label: "Ambient int.",
        min: 0,
        max: 3,
        step: 0.1,
      });
      _separator(sunBody);
      _slider(sunBody, ts.light, "envIntensity", {
        label: "Env map",
        min: 0,
        max: 2,
        step: 0.01,
      });
      _slider(sunBody, ts.light, "exposure", {
        label: "Exposure",
        min: 0.1,
        max: 2,
        step: 0.05,
      });

      // --- Shadows (CSM) ---
      const csmBody = _section(container, "Shadows (CSM)", false);
      const syncCsm = () => app.syncCsm?.();
      _toggle(csmBody, ts.csm, "enabled", {
        label: "Enabled",
        onChange: () => {
          app.setCsmEnabled(ts.csm.enabled);
          refreshTp();
        },
      });
      _toggle(csmBody, ts.csm, "updateEveryFrame", {
        label: "Every frame",
      });
      _toggle(csmBody, ts.csm, "fade", {
        label: "Cascade fade",
        hint: "Soft blend between shadow cascades to hide split seams.",
        onChange: syncCsm,
      });
      _slider(csmBody, ts.light, "shadowBias", {
        label: "Bias",
        min: -0.01,
        max: 0.001,
        step: 0.0001,
      });
      _slider(csmBody, ts.light, "shadowNormalBias", {
        label: "Normal bias",
        min: 0,
        max: 0.2,
        step: 0.001,
      });
      _slider(csmBody, ts.csm, "cascades", {
        label: "Cascades",
        min: 1,
        max: 4,
        step: 1,
        onChange: syncCsm,
      });
      _slider(csmBody, ts.csm, "maxFar", {
        label: "Max far",
        min: 30,
        max: 600,
        step: 10,
        onChange: syncCsm,
      });
      _slider(csmBody, ts.csm, "lightMargin", {
        label: "Light margin",
        min: 0,
        max: 400,
        step: 10,
        onChange: syncCsm,
      });
      _slider(csmBody, ts.csm, "mapSize", {
        label: "Map size",
        min: 512,
        max: 4096,
        step: 512,
        onChange: syncCsm,
      });
      _slider(csmBody, ts.csm, "shadowRadius", {
        label: "PCF radius",
        min: 1,
        max: 12,
        step: 0.5,
        hint: "Shadow filter blur in texels (PCFShadowMap). Try 4–8 for soft edges.",
        onChange: syncCsm,
      });

      // --- Lens Flare ---
      const lensBody = _section(container, "Lens Flare", false);
      _toggle(lensBody, ts.lensFlare, "enabled", { label: "Enabled" });
      _slider(lensBody, ts.lensFlare, "intensity", {
        label: "Intensity",
        min: 0,
        max: 5,
        step: 0.05,
      });
      _slider(lensBody, ts.lensFlare, "halationSize", {
        label: "Halation size",
        min: 0,
        max: 3,
        step: 0.05,
      });
      _color(lensBody, ts.lensFlare, "halationColor", {
        label: "Halation color",
      });
      _slider(lensBody, ts.lensFlare, "streakLength", {
        label: "Streak len",
        min: 0,
        max: 4,
        step: 0.05,
      });
      _slider(lensBody, ts.lensFlare, "streakOpacity", {
        label: "Streak opac.",
        min: 0,
        max: 2,
        step: 0.05,
      });
      _color(lensBody, ts.lensFlare, "streakColor", {
        label: "Streak color",
      });
      _slider(lensBody, ts.lensFlare, "ghostOpacity", {
        label: "Ghost opac.",
        min: 0,
        max: 2,
        step: 0.05,
      });
      _slider(lensBody, ts.lensFlare, "ghostSpacing", {
        label: "Ghost spacing",
        min: 0,
        max: 2,
        step: 0.02,
      });
      _slider(lensBody, ts.lensFlare, "dirtOpacity", {
        label: "Lens dirt",
        min: 0,
        max: 2,
        step: 0.05,
      });

      // --- Post FX ---
      const postFxBody = _section(container, "Post FX", false);
      const syncPostFx = () => app.applyPostFxState?.();
      _toggle(postFxBody, ts.postFx, "enabled", {
        label: "Enabled",
        hint: "Master switch — when off the renderer skips the post pipeline entirely (zero cost).",
        onChange: syncPostFx,
      });
      const fxaaBody = _section(postFxBody, "FXAA", true);
      _toggle(fxaaBody, ts.postFx.fxaa, "enabled", {
        label: "Enabled",
        hint: "Cheap edge anti-aliasing. Replaces MSAA (which doesn't apply through the post pipeline).",
        onChange: syncPostFx,
      });
      const ssaoBody = _section(postFxBody, "SSAO (n8ao)", false);
      _toggle(ssaoBody, ts.postFx.ssao, "enabled", {
        label: "Enabled",
        hint: "Screen-space ambient occlusion. First enable lazily compiles n8ao shaders (~50–200 ms hitch).",
        onChange: syncPostFx,
      });
      _dropdown(ssaoBody, ts.postFx.ssao, "quality", {
        label: "Quality",
        options: {
          Performance: "Performance",
          Low: "Low",
          Medium: "Medium",
          High: "High",
          Ultra: "Ultra",
        },
        hint: "Changing quality rebuilds AO + denoise shaders. Set once at startup.",
        onChange: syncPostFx,
      });
      _slider(ssaoBody, ts.postFx.ssao, "aoRadius", {
        label: "Radius",
        min: 0.1,
        max: 64,
        step: 0.1,
        hint: "World units (or pixels when Screen-space radius is on). Typical: 1–10 for scenes 100 units across.",
        onChange: syncPostFx,
      });
      _slider(ssaoBody, ts.postFx.ssao, "distanceFalloff", {
        label: "Falloff",
        min: 0,
        max: 5,
        step: 0.05,
        hint: "How fast AO fades with distance relative to radius. Lower = less haloing.",
        onChange: syncPostFx,
      });
      _slider(ssaoBody, ts.postFx.ssao, "intensity", {
        label: "Intensity",
        min: 0,
        max: 10,
        step: 0.1,
        hint: "Power applied to AO. 2 = subtle, 5 = prominent.",
        onChange: syncPostFx,
      });
      _color(ssaoBody, ts.postFx.ssao, "color", {
        label: "AO color",
        hint: "Default black. Tinted AO can fake crude GI (e.g. dark blue under a clear sky).",
        onChange: syncPostFx,
      });
      _toggle(ssaoBody, ts.postFx.ssao, "halfRes", {
        label: "Half-res",
        hint: "2–4× faster. Combine with depth-aware upsampling to keep edges crisp.",
        onChange: syncPostFx,
      });
      _toggle(ssaoBody, ts.postFx.ssao, "depthAwareUpsampling", {
        label: "Depth-aware upsample",
        hint: "Only meaningful when half-res is on. Strongly recommended.",
        onChange: syncPostFx,
      });
      _toggle(ssaoBody, ts.postFx.ssao, "screenSpaceRadius", {
        label: "Screen-space radius",
        hint: "When on, radius is in pixels (try 16–64) and falloff is a 0..1 ratio. Use for scenes with extreme camera scale changes.",
        onChange: syncPostFx,
      });
      _dropdown(ssaoBody, ts.postFx.ssao, "displayMode", {
        label: "Display mode",
        options: {
          Combined: "Combined",
          "AO only": "AO",
          "No AO": "No AO",
          Split: "Split",
          "Split AO": "Split AO",
        },
        hint: "Debug visualization. Use Combined in production.",
        onChange: syncPostFx,
      });
      _toggle(ssaoBody, ts.postFx.ssao, "transparencyAware", {
        label: "Transparency-aware",
        hint: "Costs ~2 extra full-scene renders per frame. Off by default.",
        onChange: syncPostFx,
      });
      const bloomBody = _section(postFxBody, "Bloom", true);
      _toggle(bloomBody, ts.postFx.bloom, "enabled", {
        label: "Enabled",
        onChange: syncPostFx,
      });
      _slider(bloomBody, ts.postFx.bloom, "strength", {
        label: "Strength",
        min: 0,
        max: 3,
        step: 0.01,
        onChange: syncPostFx,
      });
      _slider(bloomBody, ts.postFx.bloom, "threshold", {
        label: "Threshold",
        min: 0,
        max: 2,
        step: 0.01,
        onChange: syncPostFx,
      });
      _slider(bloomBody, ts.postFx.bloom, "radius", {
        label: "Radius",
        min: 0,
        max: 1,
        step: 0.01,
        onChange: syncPostFx,
      });
      _slider(bloomBody, ts.postFx.bloom, "smoothWidth", {
        label: "Smooth width",
        min: 0,
        max: 1,
        step: 0.01,
        onChange: syncPostFx,
      });

      const dofBody = _section(postFxBody, "Depth of Field", true);
      _toggle(dofBody, ts.postFx.dof, "enabled", {
        label: "Enabled",
        hint: "Bokeh DoF — heavy: allocates 6 internal RTs and runs CoC + 64-tap + 16-tap blurs in half-res. First enable triggers a one-time shader compile.",
        onChange: syncPostFx,
      });
      _slider(dofBody, ts.postFx.dof, "focusDistance", {
        label: "Focus distance",
        min: 1,
        max: 1000,
        step: 0.5,
        hint: "World-space distance from camera to focal plane. Anything at this distance stays sharp.",
        onChange: syncPostFx,
      });
      _slider(dofBody, ts.postFx.dof, "focalLength", {
        label: "Focal length",
        min: 1,
        max: 500,
        step: 0.5,
        hint: "World-space range over which objects fully blur. Smaller = shallower depth of field.",
        onChange: syncPostFx,
      });
      _slider(dofBody, ts.postFx.dof, "bokehScale", {
        label: "Bokeh scale",
        min: 0,
        max: 20,
        step: 0.1,
        hint: "Artistic blur size. 0 = no blur, ~5 = subtle, >10 = stylized.",
        onChange: syncPostFx,
      });

      const polishBody = _section(postFxBody, "Color & Polish", true);
      _toggle(polishBody, ts.postFx.polish, "enabled", {
        label: "Enabled",
        hint: "Color grading + vignette + film grain in a single fullscreen pass. Off = node skipped from the graph entirely.",
        onChange: syncPostFx,
      });
      const gradeBody = _section(polishBody, "Grading", true);
      _slider(gradeBody, ts.postFx.polish, "brightness", {
        label: "Brightness",
        min: -1,
        max: 1,
        step: 0.01,
        hint: "Additive offset on the final pixel. ±0.2 is plenty for most scenes.",
        onChange: syncPostFx,
      });
      _slider(gradeBody, ts.postFx.polish, "contrast", {
        label: "Contrast",
        min: 0,
        max: 2,
        step: 0.01,
        hint: "Pivot is mid-grey (0.5). 1 = identity, >1 = punchier, <1 = flatter.",
        onChange: syncPostFx,
      });
      _slider(gradeBody, ts.postFx.polish, "saturation", {
        label: "Saturation",
        min: 0,
        max: 2,
        step: 0.01,
        hint: "0 = grayscale, 1 = identity, 2 = oversaturated.",
        onChange: syncPostFx,
      });
      _slider(gradeBody, ts.postFx.polish, "temperature", {
        label: "Temperature",
        min: -1,
        max: 1,
        step: 0.01,
        hint: "Negative = cooler/blue, positive = warmer/orange. Subtle by design (±0.1 internal scale).",
        onChange: syncPostFx,
      });
      _slider(gradeBody, ts.postFx.polish, "tint", {
        label: "Tint",
        min: -1,
        max: 1,
        step: 0.01,
        hint: "Negative = green, positive = magenta.",
        onChange: syncPostFx,
      });
      const vignetteBody = _section(polishBody, "Vignette", true);
      _slider(vignetteBody, ts.postFx.polish, "vignetteStrength", {
        label: "Strength",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "0 = no vignette. ~0.4 is a typical cinematic feel.",
        onChange: syncPostFx,
      });
      _slider(vignetteBody, ts.postFx.polish, "vignetteFalloff", {
        label: "Falloff",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "Inner edge of the darkening. 0 = darken from center, 0.7 = only the outer ring.",
        onChange: syncPostFx,
      });
      _color(vignetteBody, ts.postFx.polish, "vignetteColor", {
        label: "Color",
        hint: "Default black. Try a deep red/blue for stylized looks.",
        onChange: syncPostFx,
      });
      const grainBody = _section(polishBody, "Film grain", true);
      _slider(grainBody, ts.postFx.polish, "grainStrength", {
        label: "Strength",
        min: 0,
        max: 0.3,
        step: 0.005,
        hint: "0 = no grain. ~0.04 is a subtle cinematic shimmer; >0.15 gets noisy.",
        onChange: syncPostFx,
      });
      _slider(grainBody, ts.postFx.polish, "grainSize", {
        label: "Size",
        min: 0.5,
        max: 4,
        step: 0.05,
        hint: "Higher = finer grain.",
        onChange: syncPostFx,
      });

      const sharpenBody = _section(postFxBody, "Sharpen (RCAS)", true);
      _toggle(sharpenBody, ts.postFx.sharpen, "enabled", {
        label: "Enabled",
        hint: "FidelityFX contrast-adaptive sharpening. Sits AFTER FXAA so it counteracts the AA softening.",
        onChange: syncPostFx,
      });
      _slider(sharpenBody, ts.postFx.sharpen, "sharpness", {
        label: "Sharpness",
        min: 0,
        max: 1,
        step: 0.01,
        hint: "0 = none, 1 = max. Toggling off is a structural change (rebuild); slider drag rebuilds outputNode each step.",
        onChange: syncPostFx,
      });
      _toggle(sharpenBody, ts.postFx.sharpen, "denoise", {
        label: "Denoise",
        hint: "Attenuates sharpening in noisy areas. Helpful when grain is high.",
        onChange: syncPostFx,
      });

      const caBody = _section(postFxBody, "Chromatic Aberration", true);
      _toggle(caBody, ts.postFx.chromaticAberration, "enabled", {
        label: "Enabled",
        hint: "Lens fringe — RGB channel separation toward the corners.",
        onChange: syncPostFx,
      });
      _slider(caBody, ts.postFx.chromaticAberration, "strength", {
        label: "Strength",
        min: 0,
        max: 5,
        step: 0.05,
        hint: "0 = none, ~1 = subtle real lens, >2 = stylized.",
        onChange: syncPostFx,
      });
      _slider(caBody, ts.postFx.chromaticAberration, "scale", {
        label: "Scale",
        min: 1,
        max: 1.5,
        step: 0.005,
        hint: "Per-channel radial scale separation. 1.1 is the addon default.",
        onChange: syncPostFx,
      });

      // --- World Ocean (global LOD sea; separate from placed water bodies) ---
      {
        const wo = ts.worldOcean;
        const woc = () => app.worldOceanChanged();
        const oceanBody = _section(container, "World Ocean", false);
        _toggle(oceanBody, wo, "enabled", {
          label: "Enabled",
          onChange: woc,
          hint: "Map-covering sea with waves; islands = terrain above sea level. Independent of placed water bodies.",
        });
        _slider(oceanBody, wo, "seaLevel", {
          label: "Sea level",
          min: -100,
          max: 500,
          step: 0.5,
          onChange: woc,
          hint: "Raise above tall/mountain terrain to flood it",
        });
        _slider(oceanBody, wo, "fftUpdateHz", {
          label: "Sim rate (Hz)",
          min: 5,
          max: 60,
          step: 5,
          onChange: woc,
          hint: "GPU FFT update rate — lower is cheaper",
        });
        _separator(oceanBody);
        _slider(oceanBody, wo, "windSpeed", {
          label: "Wind speed",
          min: 4,
          max: 32,
          step: 0.5,
          onChange: woc,
        });
        _slider(oceanBody, wo, "windAngleDeg", {
          label: "Wind dir",
          min: 0,
          max: 360,
          step: 1,
          onChange: woc,
        });
        _slider(oceanBody, wo, "fftChoppiness", {
          label: "Choppiness",
          min: 0,
          max: 2.5,
          step: 0.05,
          onChange: woc,
        });
        _slider(oceanBody, wo, "fftSwellAmp", {
          label: "Swell amp",
          min: 0,
          max: 2.5,
          step: 0.05,
          onChange: woc,
        });
        _slider(oceanBody, wo, "fftRippleAmp", {
          label: "Ripple amp",
          min: 0,
          max: 1.5,
          step: 0.05,
          onChange: woc,
        });
        _separator(oceanBody);
        _color(oceanBody, wo, "shoreColor", {
          label: "Shore",
          onChange: woc,
        });
        _color(oceanBody, wo, "midColor", { label: "Mid", onChange: woc });
        _color(oceanBody, wo, "deepColor", { label: "Deep", onChange: woc });
        _color(oceanBody, wo, "highlightColor", {
          label: "Highlight",
          onChange: woc,
        });
        _slider(oceanBody, wo, "depthAbsorb", {
          label: "Depth fade",
          min: 0.01,
          max: 1,
          step: 0.01,
          onChange: woc,
        });
        _slider(oceanBody, wo, "opacity", {
          label: "Opacity",
          min: 0,
          max: 1,
          step: 0.01,
          onChange: woc,
        });
        _separator(oceanBody);
        _toggle(oceanBody, wo, "foamEnabled", {
          label: "Coastal foam",
          onChange: woc,
        });
        _color(oceanBody, wo, "foamColor", {
          label: "Foam color",
          onChange: woc,
        });
        _slider(oceanBody, wo, "foamIntensity", {
          label: "Foam intensity",
          min: 0,
          max: 4,
          step: 0.05,
          onChange: woc,
        });
        _toggle(oceanBody, wo, "whitecapEnabled", {
          label: "Whitecaps",
          onChange: woc,
        });
        _slider(oceanBody, wo, "whitecapIntensity", {
          label: "Whitecap int.",
          min: 0,
          max: 2,
          step: 0.05,
          onChange: woc,
        });
        _separator(oceanBody);
        _slider(oceanBody, wo, "envReflectIntensity", {
          label: "Reflection",
          min: 0,
          max: 2.5,
          step: 0.05,
          onChange: woc,
        });
        _slider(oceanBody, wo, "fresnelMax", {
          label: "Fresnel max",
          min: 0.2,
          max: 1,
          step: 0.02,
          onChange: woc,
        });
        _toggle(oceanBody, wo, "horizonFadeEnabled", {
          label: "Horizon fade",
          onChange: woc,
        });

        const oceanUwBody = _section(
          container,
          "World Ocean · Underwater",
          false,
        );
        _toggle(oceanUwBody, wo, "underwaterEnabled", {
          label: "Enabled",
          onChange: woc,
          hint: "Tint the view when the camera dips below sea level. DOM overlay — no GPU cost.",
        });
        _color(oceanUwBody, wo, "uwTint", {
          label: "Tint color",
          onChange: woc,
        });
        _slider(oceanUwBody, wo, "uwTintMax", {
          label: "Tint amount",
          min: 0,
          max: 1,
          step: 0.02,
          onChange: woc,
        });
        _slider(oceanUwBody, wo, "uwDepthDarken", {
          label: "Depth darken",
          min: 0,
          max: 0.05,
          step: 0.001,
          onChange: woc,
          hint: "Extra opacity per metre below the surface",
        });
        _slider(oceanUwBody, wo, "uwEyeOffset", {
          label: "Eye offset",
          min: -2,
          max: 2,
          step: 0.05,
          onChange: woc,
        });
        _slider(oceanUwBody, wo, "uwTransitionSpeed", {
          label: "Transition",
          min: 1,
          max: 14,
          step: 0.5,
          onChange: woc,
        });

        const oceanLodBody = _section(
          container,
          "World Ocean · LOD / Perf",
          false,
        );
        _slider(oceanLodBody, wo, "levels", {
          label: "LOD levels",
          min: 2,
          max: 10,
          step: 1,
          onChange: woc,
        });
        _slider(oceanLodBody, wo, "gridM", {
          label: "Grid res",
          min: 16,
          max: 128,
          step: 8,
          onChange: woc,
        });
        _slider(oceanLodBody, wo, "baseCell", {
          label: "Base cell",
          min: 0.5,
          max: 8,
          step: 0.5,
          onChange: woc,
        });
        _slider(oceanLodBody, wo, "horizonScale", {
          label: "Horizon reach",
          min: 1,
          max: 20,
          step: 0.5,
          onChange: woc,
        });
      }

      // --- Sky ---
      const skyBody = _section(container, "Sky");
      const skyModeWidgets = [];
      let lastSkyMode = ts.skyMode;
      _dropdown(skyBody, ts, "skyMode", {
        label: "Mode",
        options: {
          Physical: "physical",
          "Import HDR": "hdr",
          Procedural: "procedural",
        },
        onChange: () => {
          const newMode = ts.skyMode;
          app.applySkyMode(newMode, lastSkyMode);
          lastSkyMode = newMode;
          syncSkyWidgets();
          refreshLiveSliders();
          refreshTp();
        },
      });

      const hdrRow = document.createElement("div");
      hdrRow.style.padding = "2px 0";
      skyBody.appendChild(hdrRow);
      _button(hdrRow, {
        title: "Load HDR file...",
        onClick: () => app.importHdr(),
      });

      const hdrEnv = _slider(skyBody, ts.light, "hdrEnvIntensity", {
        label: "HDR env",
        min: 0,
        max: 5,
        step: 0.05,
      });
      const hdrBg = _slider(skyBody, ts.light, "hdrBackgroundIntensity", {
        label: "HDR bg",
        min: 0,
        max: 5,
        step: 0.05,
      });
      skyModeWidgets.push({ el: hdrRow, mode: "hdr" });
      skyModeWidgets.push({ el: hdrEnv, mode: "hdr" });
      skyModeWidgets.push({ el: hdrBg, mode: "hdr" });

      const physWidgets = [];
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "meshScale", {
          label: "Dome scale",
          min: 2000,
          max: 20000,
          step: 100,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "turbidity", {
          label: "Turbidity",
          min: 0,
          max: 20,
          step: 0.1,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "rayleigh", {
          label: "Rayleigh",
          min: 0,
          max: 4,
          step: 0.05,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "mie", {
          label: "Mie",
          min: 0,
          max: 0.1,
          step: 0.001,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "mieG", {
          label: "Mie G",
          min: 0,
          max: 1,
          step: 0.01,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "cloudCoverage", {
          label: "Cloud cover",
          min: 0,
          max: 1,
          step: 0.02,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "cloudDensity", {
          label: "Cloud dense",
          min: 0,
          max: 1,
          step: 0.02,
        }),
      );
      physWidgets.push(
        _slider(skyBody, ts.physicalSky, "cloudElevation", {
          label: "Cloud elev.",
          min: 0,
          max: 1,
          step: 0.02,
        }),
      );

      const rebakeRow = document.createElement("div");
      rebakeRow.style.padding = "2px 0";
      skyBody.appendChild(rebakeRow);
      _button(rebakeRow, {
        title: "Rebake Sky IBL",
        onClick: () => app.rebuildSkyEnv(),
      });
      physWidgets.push(rebakeRow);

      for (const w of physWidgets)
        skyModeWidgets.push({ el: w, mode: "physical" });

      // Procedural (daynight-sky) dome controls — one wrapper toggled by mode.
      const procWrap = _buildProceduralSkyControls(skyBody, ts, app);
      skyModeWidgets.push({ el: procWrap, mode: "procedural" });

      function syncSkyWidgets() {
        for (const { el, mode } of skyModeWidgets) {
          const domEl = el instanceof HTMLElement ? el : el?.row;
          if (!domEl) continue;
          domEl.style.display = mode === ts.skyMode ? "" : "none";
        }
      }
      syncSkyWidgets();

      // --- Height Fog ---
      const hfBody = _section(container, "Height Fog", false);
      const fogCb = () => {
        app.syncFog();
        refreshTp();
      };
      _toggle(hfBody, ts.fog.height, "enabled", {
        label: "Enabled",
        onChange: fogCb,
      });
      _color(hfBody, ts.fog.height, "color", {
        label: "Color",
        onChange: fogCb,
      });
      _slider(hfBody, ts.fog.height, "density", {
        label: "Density",
        min: 0.001,
        max: 0.05,
        step: 0.001,
        hint: "Extinction per meter at the base height.",
        onChange: fogCb,
      });
      _slider(hfBody, ts.fog.height, "falloff", {
        label: "Falloff",
        min: 0.005,
        max: 0.2,
        step: 0.005,
        hint: "Vertical decay. Layer thickness ≈ 1/value meters (0.05 ≈ 20 m).",
        onChange: fogCb,
      });
      _slider(hfBody, ts.fog.height, "height", {
        label: "Base height",
        min: -60,
        max: 500,
        step: 1,
        onChange: fogCb,
      });

      // --- Distance Fog ---
      const dfBody = _section(container, "Distance Fog", false);
      _toggle(dfBody, ts.fog.distance, "enabled", {
        label: "Enabled",
        onChange: fogCb,
      });
      _color(dfBody, ts.fog.distance, "color", {
        label: "Away color",
        hint: "Fog color away from the sun. Overridden by the sky horizon when Match sky is on.",
        onChange: fogCb,
      });
      _slider(dfBody, ts.fog.distance, "density", {
        label: "Density",
        min: 0.0001,
        max: 0.05,
        step: 0.0001,
        onChange: fogCb,
      });
      // Daynight aerial perspective (sun-tinted haze). Driven live each frame.
      _toggle(dfBody, ts.fog.distance, "matchSky", {
        label: "Match sky",
        hint: "Away color tracks the procedural sky horizon so distant geometry dissolves into it.",
      });
      _color(dfBody, ts.fog.distance, "sunTint", { label: "Sun tint" });
      _slider(dfBody, ts.fog.distance, "tintPow", {
        label: "Tint focus",
        min: 0.5,
        max: 8,
        step: 0.1,
        hint: "Higher = the warm glow stays tighter around the sun.",
      });
      // Sky-dome horizon haze height (procedural sky only). Lower = hugs the
      // waterline. Same `proceduralSky.hazeHeight` param, shown here with fog.
      _slider(dfBody, ts.proceduralSky, "hazeHeight", {
        label: "Horizon haze",
        min: 0.02,
        max: 0.5,
        step: 0.01,
        hint: "How high the sky-dome horizon haze climbs (Procedural sky only). Lower hugs the waterline.",
      });

      // --- Interior lighting (tunnels, caves, future house boxes) ---
      const intBody = _section(container, "Interior lighting", false);
      const intCb = () => {
        app.syncInteriorUniforms();
        app.rebuildInteriorVolumes();
      };
      _toggle(intBody, ts.interior, "enabled", {
        label: "Enabled",
        onChange: intCb,
      });
      _slider(intBody, ts.interior, "strength", {
        label: "Darken strength",
        min: 0,
        max: 1,
        step: 0.02,
        onChange: intCb,
      });
      _color(intBody, ts.interior, "color", {
        label: "Interior tint",
        onChange: intCb,
      });
      _slider(intBody, ts.interior, "ambientScale", {
        label: "Sky/hemi scale inside",
        min: 0,
        max: 1,
        step: 0.02,
        onChange: intCb,
      });
      _slider(intBody, ts.interior, "tunnelRadiusScale", {
        label: "Tunnel vol scale",
        min: 0.7,
        max: 1.05,
        step: 0.01,
        onChange: intCb,
      });
      _slider(intBody, ts.interior, "openingLength", {
        label: "Open end fade (m)",
        min: 0,
        max: 40,
        step: 0.5,
        onChange: intCb,
      });
      _slider(intBody, ts.interior, "edgeSoftness", {
        label: "Tunnel edge soft",
        min: 0.05,
        max: 0.9,
        step: 0.02,
        onChange: intCb,
      });
      _slider(intBody, ts.interior, "segmentStep", {
        label: "Centerline step (m)",
        min: 2,
        max: 24,
        step: 0.5,
        onChange: intCb,
      });

      // --- Terrain / streaming LOD (was Tweakpane "Terrain/LOD") ---
      const cfg = app.config;
      const lodWorldBody = _section(container, "Terrain / LOD", false);
      _toggle(lodWorldBody, cfg.lod, "enabled", {
        label: "LOD enabled",
        onChange: () => app.onConfigChanged(),
      });
      _slider(lodWorldBody, cfg.lod, "activeRadiusInChunks", {
        label: "Active radius",
        min: 2,
        max: 20,
        step: 1,
        onChange: () => app.onConfigChanged(),
      });
      _slider(lodWorldBody, cfg.lod, "hysteresis", {
        label: "Hysteresis",
        min: 0,
        max: 0.5,
        step: 0.01,
        onChange: () => app.onConfigChanged(),
      });

      // --- Audio mixer (Howler buses) ---
      const audio = ts.audio;
      const audioBody = _section(container, "Audio (mixer)", false);
      _toggle(audioBody, audio, "muteAll", { label: "Mute all" });
      _toggle(audioBody, audio, "pauseWhenHidden", {
        label: "Pause when tab hidden",
      });
      const masterBus = audio.buses.master;
      _slider(audioBody, masterBus, "volume", {
        label: "Master vol",
        min: 0,
        max: 1,
        step: 0.01,
      });
      _toggle(audioBody, masterBus, "mute", { label: "Master mute" });
      _separator(audioBody);
      const busLabels = {
        sfx: "SFX",
        music: "Music",
        voice: "Voice",
        ui: "UI",
        vehicle: "Vehicle",
      };
      for (const busId of ["sfx", "music", "voice", "ui", "vehicle"]) {
        const bus = audio.buses[busId];
        if (!bus) continue;
        const sub = _section(audioBody, busLabels[busId] ?? busId, false);
        _slider(sub, bus, "volume", {
          label: "Volume",
          min: 0,
          max: 1,
          step: 0.01,
        });
        _toggle(sub, bus, "mute", { label: "Mute" });
      }

      // --- Perf Gate (read-only; mirrors Tweakpane monitors) ---
      const perfBody = _section(container, "Perf Gate", false);
      const perfFps = _info(perfBody, "FPS", "0.0");
      const perfMs = _info(perfBody, "Frame ms", "0.00");
      const perfChunks = _info(perfBody, "Active chunks", "0");
      const perfQueues = _info(perfBody, "Queues C/R/U", "0/0/0");
      function tickWorldPerfMonitors() {
        const p = app.perf;
        perfFps.update(p.fps.toFixed(1));
        perfMs.update(p.frameMs.toFixed(2));
        perfChunks.update(String(p.activeChunks));
        perfQueues.update(
          `${p.queues.create}/${p.queues.remesh}/${p.queues.unload}`,
        );
        requestAnimationFrame(tickWorldPerfMonitors);
      }
      requestAnimationFrame(tickWorldPerfMonitors);
    }
