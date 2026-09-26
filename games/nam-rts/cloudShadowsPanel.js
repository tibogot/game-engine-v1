// Dev → CLOUD SHADOWS — DEVELOPER UI for the drifting cloud shade
// (v3/render/clouds/cloudShadowsLite.js, via app.setCloudShadows). Every
// change is kept across reloads; "Defaults" forgets them.

const KEY = "namrts.cloudShadows";
/** The game's look (the engine's own defaults are "off"). */
export const NAM_CLOUD_SHADOWS = {
  enabled: true, cover: 0.45, darkness: 0.7, scale: 220, softness: 0.1,
  height: 900, windX: 6, windZ: 3,
};

function load() {
  try { return { ...NAM_CLOUD_SHADOWS, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch { return { ...NAM_CLOUD_SHADOWS }; }
}
function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} }

/** At boot: your saved settings (or the game's), ?clouds=0 = off. */
export function applyCloudShadows(app) {
  const p = load();
  if (new URLSearchParams(location.search).get("clouds") === "0") p.enabled = false;
  app.setCloudShadows?.(p);
}

export function buildCloudShadowsPanel(el, app) {
  const cs = app?.cloudShadows;
  if (!el || !cs) return;
  const P = cs.params;
  el.innerHTML = "";
  const set = (key, v) => { app.setCloudShadows({ [key]: v }); save({ ...P }); };

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
    inp.addEventListener("input", () => { const v = Number(inp.value); set(key, v); num.textContent = fmt(v); });
  };

  const on = document.createElement("button");
  on.className = "action-btn";
  on.type = "button";
  const paint = () => { on.textContent = P.enabled ? "Cloud shadows: on" : "Cloud shadows: OFF"; };
  paint();
  on.addEventListener("click", () => { set("enabled", !P.enabled); paint(); });
  el.append(on);

  const m = (v) => `${Math.round(v)} m`;
  const ms = (v) => `${v.toFixed(1)} m/s`;
  slider("Cover", "cover", 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`);
  slider("Darkness", "darkness", 0, 1, 0.01);
  slider("Cloud size", "scale", 60, 800, 10, m);
  slider("Edge softness", "softness", 0.01, 0.4, 0.01);
  slider("Cloud height", "height", 200, 2500, 50, m);
  slider("Wind X", "windX", -20, 20, 0.5, ms);
  slider("Wind Z", "windZ", -20, 20, 0.5, ms);

  const hint = document.createElement("div");
  hint.className = "dv-hint";
  hint.innerHTML = `Shade only — no clouds drawn. Cover = share of the ground in
    shade; darkness = how much SUN a cloud takes (the sky light stays). Height
    slides each shadow along the sun ray. One texture read per lit pixel
    (measured free). Kept across reloads. <code>?clouds=0</code> = off.`;
  el.append(hint);

  const reset = document.createElement("button");
  reset.className = "action-btn";
  reset.type = "button";
  reset.textContent = "Defaults (forget my settings)";
  reset.addEventListener("click", () => {
    try { localStorage.removeItem(KEY); } catch {}
    app.setCloudShadows({ ...NAM_CLOUD_SHADOWS });
    buildCloudShadowsPanel(el, app);
  });
  el.append(reset);
  el.querySelectorAll("input").forEach((f, i) => {
    const label = f.closest(".prop-row")?.querySelector(".prop-label")?.textContent?.trim() || "field";
    f.name = `cloudshadow-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i}`;
    f.setAttribute("aria-label", label);
  });
}
