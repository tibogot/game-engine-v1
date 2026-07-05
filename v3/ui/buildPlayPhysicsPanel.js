/**
 * Play-mode on-foot physics tuning — lives in the play panel (not lil-gui).
 */
import { HUMAN_CAPSULE_DEFAULTS } from "../play/playMode.js";

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';

export const PHYSICS_PRESETS = {
  default: { ...HUMAN_CAPSULE_DEFAULTS },
  snappy: {
    walkSpeed: 3.5,
    runSpeed: 7,
    jumpVel: 10,
    gravity: 22,
    accelRate: 58,
    decelRate: 68,
    coyoteTime: 0.08,
  },
  floaty: {
    walkSpeed: 3,
    runSpeed: 5.5,
    jumpVel: 12.5,
    gravity: 14,
    glideFallSpeed: 2.5,
    coyoteTime: 0.14,
    jumpBufferTime: 0.15,
    groundSpringK: 28,
  },
  heavy: {
    walkSpeed: 2.5,
    runSpeed: 5,
    jumpVel: 9,
    gravity: 28,
    accelRate: 28,
    decelRate: 38,
    airControlMult: 0.28,
    groundSpringK: 42,
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

/**
 * @param {object} app
 * @param {HTMLElement} app.mount
 * @param {() => object} app.getCapsuleParams
 * @param {(patch: object) => void} app.setCapsuleParams
 * @param {() => void} app.resetCapsuleParams
 */
export function buildPlayPhysicsPanel(app) {
  const root = document.createElement("div");
  root.id = "play-physics-panel";
  root.style.display = "none";
  app.mount.appendChild(root);

  const tune = { ...HUMAN_CAPSULE_DEFAULTS };
  const bindings = [];
  let activePreset = "default";

  const apply = (patch) => {
    Object.assign(tune, patch);
    app.setCapsuleParams(patch);
    syncSliders();
  };

  const syncSliders = () => {
    for (const b of bindings) {
      b.syncSliderFromValue();
      b.syncNumDisplay();
    }
  };

  const syncFromPlayMode = () => {
    const p = app.getCapsuleParams?.();
    if (!p) return;
    Object.assign(tune, p);
    syncSliders();
  };

  function _slider(parent, key, opts) {
    const { label, min, max, step = 0.01, onChange } = opts;
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
      app.setCapsuleParams({ [key]: v });
      activePreset = "";
      presetBtns.forEach((b) => b.classList.remove("active"));
      onChange?.();
    };
    sl.addEventListener("input", () => {
      tune[key] = _clampSnap(parseFloat(sl.value), min, max, step);
      syncNumDisplay();
      app.setCapsuleParams({ [key]: tune[key] });
      activePreset = "";
      presetBtns.forEach((b) => b.classList.remove("active"));
      onChange?.();
    });
    num.addEventListener("change", push);
    num.addEventListener("keydown", (e) => { if (e.key === "Enter") push(); });
    parent.appendChild(row);
    bindings.push({ key, syncSliderFromValue, syncNumDisplay });
  }

  // ── Feel (tier 1) ─────────────────────────────────────────────────────────
  const feelBody = _section(root, "Physics — Feel", true);

  const presetRow = document.createElement("div");
  presetRow.className = "preset-grid";
  presetRow.style.marginBottom = "8px";
  feelBody.appendChild(presetRow);

  const presetBtns = [];
  for (const [id, label] of [
    ["default", "Default"],
    ["snappy", "Snappy"],
    ["floaty", "Floaty"],
    ["heavy", "Heavy"],
  ]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn" + (id === "default" ? " active" : "");
    btn.textContent = label;
    btn.dataset.preset = id;
    btn.addEventListener("click", () => {
      apply({ ...PHYSICS_PRESETS[id] });
      activePreset = id;
      presetBtns.forEach((b) => b.classList.toggle("active", b.dataset.preset === id));
    });
    presetRow.appendChild(btn);
    presetBtns.push(btn);
  }

  _slider(feelBody, "walkSpeed", { label: "Walk speed", min: 1, max: 12, step: 0.1 });
  _slider(feelBody, "runSpeed",  { label: "Run speed",  min: 2, max: 18, step: 0.1 });
  _slider(feelBody, "jumpVel",   { label: "Jump height", min: 4, max: 18, step: 0.25 });
  _slider(feelBody, "gravity",   { label: "Gravity",    min: 6, max: 45, step: 0.5 });

  const resetRow = document.createElement("div");
  resetRow.className = "prop-row";
  resetRow.style.marginTop = "6px";
  resetRow.innerHTML = `<span class="prop-label">Reset</span><div class="prop-value"><button type="button" class="preset-btn" id="play-physics-reset" style="width:100%">Restore defaults</button></div>`;
  feelBody.appendChild(resetRow);
  resetRow.querySelector("#play-physics-reset").addEventListener("click", () => {
    app.resetCapsuleParams?.();
    syncFromPlayMode();
    activePreset = "default";
    presetBtns.forEach((b) => b.classList.toggle("active", b.dataset.preset === "default"));
  });

  const hint = document.createElement("p");
  hint.style.cssText = "margin:8px 0 0;font-size:11px;color:var(--text-dim);line-height:1.35";
  hint.textContent = "Live tuning — session only, not saved to the world.";
  feelBody.appendChild(hint);

  // ── Advanced (tier 2) ─────────────────────────────────────────────────────
  const advBody = _section(root, "Physics — Advanced", false);
  _slider(advBody, "crouchSpeedMult",  { label: "Crouch speed ×", min: 0.2, max: 1, step: 0.02 });
  _slider(advBody, "crouchHeightScale", { label: "Crouch height ×", min: 0.3, max: 1, step: 0.02 });
  _slider(advBody, "coyoteTime",       { label: "Coyote time", min: 0, max: 0.35, step: 0.01 });
  _slider(advBody, "jumpBufferTime",   { label: "Jump buffer", min: 0, max: 0.35, step: 0.01 });
  _slider(advBody, "glideFallSpeed",   { label: "Glide fall", min: 1, max: 12, step: 0.25 });
  _slider(advBody, "groundStickDist",  { label: "Ground stick", min: 0, max: 1, step: 0.05 });
  _slider(advBody, "stepMaxHeight",    { label: "Autostep max", min: 0, max: 0.9, step: 0.05 });
  _slider(advBody, "maxWalkSlopeDeg",  { label: "Max walk slope°", min: 20, max: 70, step: 1 });
  _slider(advBody, "accelRate",        { label: "Accel", min: 10, max: 80, step: 1 });
  _slider(advBody, "decelRate",        { label: "Decel", min: 10, max: 80, step: 1 });
  _slider(advBody, "airControlMult",   { label: "Air control", min: 0.1, max: 1, step: 0.05 });
  _slider(advBody, "groundSpringK",    { label: "Ground spring", min: 5, max: 60, step: 1 });

  // ── Collider (tier 3) ─────────────────────────────────────────────────────
  const capBody = _section(root, "Physics — Collider", false);
  _slider(capBody, "capRadius",        { label: "Radius", min: 0.2, max: 0.7, step: 0.01 });
  _slider(capBody, "capHeight",        { label: "Height", min: 0.6, max: 2.0, step: 0.05 });
  _slider(capBody, "iterations",       { label: "Depen. passes", min: 1, max: 8, step: 1 });
  _slider(capBody, "substepFraction",  { label: "Substep frac", min: 0.2, max: 1, step: 0.05 });

  const capHint = document.createElement("p");
  capHint.style.cssText = "margin:6px 0 0;font-size:11px;color:var(--text-dim);line-height:1.35";
  capHint.textContent = "Husky mode overrides height/offset when active.";
  capBody.appendChild(capHint);

  function setVisible(show) {
    root.style.display = show ? "" : "none";
    if (show) syncFromPlayMode();
  }

  return { setVisible, syncFromPlayMode, root };
}
