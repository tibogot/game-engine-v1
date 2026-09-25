// Dev → FOG BANKS — DEVELOPER UI for the mist at places (fogBanks.js). The
// look, the quality, each bank's own thickness, and a camera jump to each
// bank so it can be judged where it is. Every change is kept across reloads
// (fogBanks saves them); "Defaults" forgets them.

export function buildFogBanksPanel(el, fog, { rtsCamera = null } = {}) {
  if (!el || !fog) return;
  const P = fog.params;
  el.innerHTML = "";

  const row = (label, inner) => {
    const r = document.createElement("div");
    r.className = "prop-row";
    r.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value">${inner}</div>`;
    el.append(r);
    return r;
  };
  const slider = (label, key, min, max, step, fmt = (v) => v.toFixed(2)) => {
    const r = row(label, `<input type="range" min="${min}" max="${max}" step="${step}" value="${P[key]}" /><span class="prop-num">${fmt(P[key])}</span>`);
    const inp = r.querySelector("input"), num = r.querySelector(".prop-num");
    inp.addEventListener("input", () => { const v = Number(inp.value); fog.set(key, v); num.textContent = fmt(v); });
    return r;
  };
  const color = (label, key) => {
    const r = row(label, `<input type="color" value="${P[key]}" style="width:100%" />`);
    const inp = r.querySelector("input");
    inp.addEventListener("input", () => fog.set(key, inp.value));
  };

  const on = document.createElement("button");
  on.className = "action-btn";
  on.type = "button";
  const paint = () => { on.textContent = P.enabled ? "Fog banks: on" : "Fog banks: OFF"; };
  paint();
  on.addEventListener("click", () => { fog.set("enabled", !P.enabled); paint(); });
  el.append(on);

  {
    const r = row("Look", `<select class="prop-select">
      <option value="volume">Volume (raymarched)</option>
      <option value="analytic">Veil (cheaper)</option></select>`);
    const sel = r.querySelector("select");
    sel.value = P.mode;
    sel.addEventListener("change", () => fog.set("mode", sel.value));
  }
  // Presets: set every look slider at once (then the panel redraws).
  {
    const r = row("Preset", `<button class="action-btn" type="button" style="width:auto;padding:2px 8px">Morning mist</button>
      <button class="action-btn" type="button" style="width:auto;padding:2px 8px">Thick (Apocalypse Now)</button>`);
    const [light, thick] = r.querySelectorAll("button");
    const apply = (v) => {
      for (const [k, x] of Object.entries(v)) fog.set(k, x);
      fog.banks.forEach((b, i) => fog.setBankDensity(i, b.def.sited));
      buildFogBanksPanel(el, fog, { rtsCamera });
    };
    light.addEventListener("click", () => apply({ height: 1, size: 1, density: 1, wisps: 0.75, shade: "#9aa6a4" }));
    // The banks as deep as the canopy: only the tallest crowns and the
    // temple tower stand out of it (your screenshot, 2026-09-25).
    thick.addEventListener("click", () => apply({ height: 2.6, size: 1.6, density: 1.3, wisps: 0.3, shade: "#b9c2c1" }));
  }
  slider("Height", "height", 0.5, 4, 0.05, (v) => `×${v.toFixed(2)}`);
  slider("Size", "size", 0.5, 3, 0.05, (v) => `×${v.toFixed(2)}`);
  slider("Density", "density", 0, 3, 0.05);
  slider("Wisps", "wisps", 0, 1, 0.05);
  slider("Drift (m/s)", "drift", 0, 3, 0.1, (v) => v.toFixed(1));
  color("Mist", "color");
  color("Shade", "shade");
  color("Sun warmth", "sunTint");
  slider("Steps", "steps", 6, 24, 1, (v) => String(v | 0));
  slider("Resolution", "scale", 0.25, 1, 0.05, (v) => `${Math.round(v * 100)}%`);

  const hint = document.createElement("div");
  hint.className = "dv-hint";
  hint.innerHTML = `Volume: stepped through at the resolution above, lit and billowing
    (~0.4 ms native at half res with mist over most of the screen). Veil: one
    closed-form sum, flat wisps, cheaper. Steps and Look rebuild the shader
    (a moment's hitch). Kept across reloads.`;
  el.append(hint);

  // Each bank: its own thickness, and a jump to it.
  const head = document.createElement("div");
  head.className = "dv-hint";
  head.innerHTML = "<b>Banks</b> — each one's own thickness (per metre at its heart):";
  el.append(head);
  fog.banks.forEach((b, i) => {
    const r = row(`${i + 1}. ${b.name}`, `<input type="range" min="0" max="0.4" step="0.005" value="${b.def.density}" />
      <span class="prop-num">${b.def.density.toFixed(3)}</span>
      <button class="action-btn" type="button" title="Look at it" style="width:auto;padding:2px 7px">◎</button>`);
    const inp = r.querySelector("input"), num = r.querySelector(".prop-num"), go = r.querySelector("button");
    inp.addEventListener("input", () => { const v = Number(inp.value); fog.setBankDensity(i, v); num.textContent = v.toFixed(3); });
    go.addEventListener("click", () => rtsCamera?.focusOn?.(b.def.x, b.def.z));
  });

  const reset = document.createElement("button");
  reset.className = "action-btn";
  reset.type = "button";
  reset.textContent = "Defaults (forget my settings)";
  reset.addEventListener("click", () => { fog.reset(); buildFogBanksPanel(el, fog, { rtsCamera }); });
  el.append(reset);
}
