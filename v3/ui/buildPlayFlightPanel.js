/**
 * Play-mode flight physics tuning — native play panel (v3 flightController).
 */
import { DEFAULT_FLIGHT_PARAMS } from "../play/flightController.js";

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';

export const FLIGHT_PRESETS = {
  default: { ...DEFAULT_FLIGHT_PARAMS },
  agile: {
    thrust: 12,
    maxSpeedFwd: 62,
    rollYawRate: 0.55,
    rollMouseScale: 0.003,
    mouseSensX: 0.0026,
    mouseSensY: 0.0028,
    sphereRadius: 2.0,
    hitSpeedLoss: 0.32,
  },
  heavy: {
    thrust: 8.5,
    maxSpeedFwd: 48,
    coast: 2.8,
    drag: 0.02,
    stallSpeed: 18,
    sphereRadius: 2.5,
    hitSpeedLoss: 0.55,
    hitSpeedMin: 0.25,
  },
  stunt: {
    thrust: 14,
    maxSpeedFwd: 72,
    maxSpeedFwdBoost: 95,
    rollYawRate: 1.2,
    rollMax: 1.0,
    stallSpeed: 10,
    sphereRadius: 1.9,
    hitSpeedLoss: 0.28,
    boostDrainPerSec: 0.18,
  },
};

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

export function buildPlayFlightPanel(app) {
  const root = document.createElement("div");
  root.id = "play-flight-panel";
  root.style.display = "none";
  app.mount.appendChild(root);

  const tune = { ...DEFAULT_FLIGHT_PARAMS };
  const bindings = [];

  const syncSliders = () => {
    for (const b of bindings) {
      b.syncSliderFromValue();
      b.syncNumDisplay();
    }
  };

  const syncFromPlayMode = () => {
    const p = app.getFlightParams?.();
    if (!p) return;
    Object.assign(tune, p);
    syncSliders();
  };

  function _slider(parent, key, opts) {
    const { label, min, max, step = 0.01 } = opts;
    const row = document.createElement("div");
    row.className = "prop-row";
    const cur = tune[key];
    row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${min}" max="${max}" step="${step}" value="${cur}"><input type="number" class="prop-num-input" title="Type an exact value" min="${min}" max="${max}" step="${step}" value="${_fmt(cur, step)}"></div></div>`;
    const sl = row.querySelector(".prop-slider");
    const num = row.querySelector(".prop-num-input");
    const syncNumDisplay = () => { num.value = _fmt(tune[key], step); };
    const syncSliderFromValue = () => { sl.value = String(tune[key]); };
    const push = () => {
      let v = parseFloat(num.value);
      if (!Number.isFinite(v)) v = tune[key];
      v = _clampSnap(v, min, max, step);
      tune[key] = v;
      syncNumDisplay();
      syncSliderFromValue();
      app.setFlightParams({ [key]: v });
      presetBtns.forEach((b) => b.classList.remove("active"));
    };
    sl.addEventListener("input", () => {
      tune[key] = _clampSnap(parseFloat(sl.value), min, max, step);
      syncNumDisplay();
      app.setFlightParams({ [key]: tune[key] });
      presetBtns.forEach((b) => b.classList.remove("active"));
    });
    num.addEventListener("change", push);
    num.addEventListener("keydown", (e) => { if (e.key === "Enter") push(); });
    parent.appendChild(row);
    bindings.push({ syncSliderFromValue, syncNumDisplay });
  }

  const feelBody = _section(root, "Flight — Feel", true);

  const presetRow = document.createElement("div");
  presetRow.className = "preset-grid";
  presetRow.style.marginBottom = "8px";
  feelBody.appendChild(presetRow);

  const presetBtns = [];
  for (const [id, label] of [
    ["default", "Default"],
    ["agile", "Agile"],
    ["heavy", "Heavy"],
    ["stunt", "Stunt"],
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn" + (id === "default" ? " active" : "");
    btn.textContent = label;
    btn.dataset.preset = id;
    btn.addEventListener("click", () => {
      const patch = { ...FLIGHT_PRESETS[id] };
      Object.assign(tune, patch);
      app.setFlightParams(patch);
      syncSliders();
      presetBtns.forEach((b) => b.classList.toggle("active", b.dataset.preset === id));
    });
    presetRow.appendChild(btn);
    presetBtns.push(btn);
  }

  _slider(feelBody, "thrust", { label: "Thrust", min: 4, max: 20, step: 0.5 });
  _slider(feelBody, "maxSpeedFwd", { label: "Max speed", min: 20, max: 90, step: 1 });
  _slider(feelBody, "maxSpeedFwdBoost", { label: "Boost max", min: 30, max: 120, step: 1 });
  _slider(feelBody, "coast", { label: "Coast", min: 1, max: 10, step: 0.2 });
  _slider(feelBody, "drag", { label: "Drag", min: 0.005, max: 0.04, step: 0.001 });
  _slider(feelBody, "stallSpeed", { label: "Stall speed", min: 6, max: 24, step: 0.5 });
  _slider(feelBody, "stallSink", { label: "Stall sink", min: 2, max: 14, step: 0.5 });
  _slider(feelBody, "boostDrainPerSec", { label: "Boost drain", min: 0.04, max: 0.35, step: 0.01 });
  _slider(feelBody, "boostRegenPerSec", { label: "Boost regen", min: 0.05, max: 0.5, step: 0.01 });

  const resetRow = document.createElement("div");
  resetRow.className = "prop-row";
  resetRow.style.marginTop = "6px";
  resetRow.innerHTML = `<span class="prop-label">Reset</span><div class="prop-value"><button type="button" class="preset-btn" id="play-flight-reset" style="width:100%">Restore defaults</button></div>`;
  feelBody.appendChild(resetRow);
  resetRow.querySelector("#play-flight-reset").addEventListener("click", () => {
    app.resetFlightParams?.();
    syncFromPlayMode();
    presetBtns.forEach((b) => b.classList.toggle("active", b.dataset.preset === "default"));
  });

  const hint = document.createElement("p");
  hint.style.cssText = "margin:8px 0 0;font-size:11px;color:var(--text-dim);line-height:1.35";
  hint.textContent = "Hold Shift + W for boost — drains thrust reserve (HUD bar). Session tuning only.";
  feelBody.appendChild(hint);

  const ctrlBody = _section(root, "Flight — Control", false);
  _slider(ctrlBody, "mouseSensX", { label: "Mouse yaw", min: 0.001, max: 0.006, step: 0.0001 });
  _slider(ctrlBody, "mouseSensY", { label: "Mouse pitch", min: 0.001, max: 0.006, step: 0.0001 });
  _slider(ctrlBody, "rollYawRate", { label: "Bank → turn", min: 0, max: 2, step: 0.05 });
  _slider(ctrlBody, "rollMouseScale", { label: "Bank mouse", min: 0.001, max: 0.01, step: 0.0002 });
  _slider(ctrlBody, "rollMax", { label: "Max bank", min: 0.2, max: 1.2, step: 0.02 });
  _slider(ctrlBody, "deckAglMax", { label: "Taxi AGL", min: 0.5, max: 3, step: 0.05 });
  _slider(ctrlBody, "deckSpeedMax", { label: "Taxi speed", min: 6, max: 28, step: 0.5 });

  const colBody = _section(root, "Flight — Collision", false);
  _slider(colBody, "sphereRadius", { label: "Probe radius", min: 1.2, max: 4, step: 0.1 });
  _slider(colBody, "sweepMargin", { label: "Sweep margin", min: 0.5, max: 1.2, step: 0.05 });
  _slider(colBody, "wingSpanExtra", { label: "Wing span +", min: 0.3, max: 2, step: 0.1 });
  _slider(colBody, "probeUpDist", { label: "Ceiling probe", min: 0.5, max: 4, step: 0.1 });
  _slider(colBody, "probeDownDist", { label: "Floor probe", min: 0.5, max: 4, step: 0.1 });
  _slider(colBody, "hitSpeedLoss", { label: "Graze speed loss", min: 0.1, max: 0.8, step: 0.02 });
  _slider(colBody, "hitSpeedMin", { label: "Min speed mult", min: 0.1, max: 0.6, step: 0.02 });
  _slider(colBody, "hitSweepSpeedMult", { label: "Wall hit mult", min: 0.4, max: 0.95, step: 0.02 });

  function setVisible(show) {
    root.style.display = show ? "" : "none";
    if (show) syncFromPlayMode();
  }

  return { setVisible, syncFromPlayMode, root };
}
