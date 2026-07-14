// Dev-controls panel — DEVELOPER UI, not player-facing.
//
// Styled to match the v3 editor's right panel: it reuses editor.css's own
// classes (.inspector-section / .section-header / .section-body / .prop-row /
// .prop-value / .prop-num / .action-btn / .prop-toggle) and CSS variables, so
// it reads as the same tool. Only the fixed-position container is our own CSS
// (the editor's #right-panel is a grid cell we can't reuse).
//
// This is the single home for every dev utility — camera, units, navigation.
// Player-facing HUD lives in minimap.js / unitBar.js / commandCard.js.
const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

export function createDevPanel({
  app, navGrid, rtsCamera, units, minimap,
  worldName = "procedural default",
  onLoadWorldFile,
  onLoadDefaultWorld,
}) {
  const DEG = Math.PI / 180;

  const root = document.createElement("div");
  root.id = "rts-dev";
  root.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" type="button">Dev Controls</button>
      <button class="tab-btn dv-collapse" type="button" title="Collapse">–</button>
    </div>
    <div class="tab-content active">

      <div class="inspector-section">
        <div class="section-header">Camera</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Mode</span>
            <div class="prop-value">
              <button class="action-btn primary" id="dv-cam" type="button">RTS</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Pan speed</span>
            <div class="prop-value">
              <input type="range" id="dv-pan" min="0.2" max="3" step="0.1" />
              <span class="prop-num" id="dv-pan-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Pitch</span>
            <div class="prop-value">
              <input type="range" id="dv-pitch" min="25" max="85" step="1" />
              <span class="prop-num" id="dv-pitch-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Units</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Speed</span>
            <div class="prop-value">
              <input type="range" id="dv-speed" min="0.25" max="4" step="0.25" />
              <span class="prop-num" id="dv-speed-v"></span>
            </div>
          </div>
          <button class="action-btn" id="dv-stop-all" type="button">Stop all units</button>
          <button class="action-btn" id="dv-debug-units" type="button">Log unit states</button>
          <div class="dv-hint">Click while units are stuck, then check the console.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Fog</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Height fog</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-fog" type="button" aria-label="Height fog">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Color</span>
            <div class="prop-value">
              <input type="color" id="dv-fog-color" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Base (Y)</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-base" min="-40" max="80" step="1" />
              <span class="prop-num" id="dv-fog-base-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Top (Y)</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-top" min="10" max="200" step="1" />
              <span class="prop-num" id="dv-fog-top-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Haze</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-haze" min="0" max="0.005" step="0.0001" />
              <span class="prop-num" id="dv-fog-haze-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wobble</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-wobble" min="0" max="40" step="1" />
              <span class="prop-num" id="dv-fog-wobble-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Dist. fog</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-fog-dist" type="button" aria-label="Distance fog">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Dist. density</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-dist-d" min="0" max="0.003" step="0.0001" />
              <span class="prop-num" id="dv-fog-dist-d-v"></span>
            </div>
          </div>
          <div class="dv-hint">Valley band fog — mist below Top, clear above. Haze fades distant terrain into the sky.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post-FX</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Post-FX</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-postfx" type="button" aria-label="Post-FX">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bloom</span>
            <div class="prop-value">
              <input type="range" id="dv-bloom" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-bloom-v"></span>
            </div>
          </div>
          <div class="dv-hint">Selective bloom — only emissive materials (tracers, beacons) glow.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">World</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Loaded</span>
            <span class="prop-num dv-world-name" id="dv-world-name"></span>
          </div>
          <input type="file" id="dv-world-file" accept=".v3proj" hidden />
          <button class="action-btn" id="dv-world-load" type="button">Load .v3proj…</button>
          <button class="action-btn" id="dv-world-default" type="button">Reload default</button>
          <div class="dv-hint">Default: <code>world.v3proj</code>. Or open with <code>?world=/path/file.v3proj</code>.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Navigation</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Nav grid</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-nav" type="button" aria-label="Show nav grid">${CHECK_SVG}</button>
            </div>
          </div>
          <button class="action-btn" id="dv-rebuild" type="button">Rebuild nav + minimap</button>
          <div class="dv-hint">Rebuild after changing the world or loading a new .v3proj.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Controls</div>
        <div class="section-body">
          <div class="dv-hint">
            <b>Left-click / drag</b> select (Shift adds)<br />
            <b>Right-click</b> move order<br />
            <b>WASD</b> / edge pan · <b>wheel</b> zoom · <b>Q/E</b> rotate<br />
            <b>C</b> camera mode · <b>N</b> nav grid
          </div>
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #rts-dev {
      position: fixed; right: 0; top: 0; bottom: 0; width: 264px; z-index: 56;
      background: var(--bg-panel); border-left: 1px solid var(--border);
      display: flex; flex-direction: column; overflow-y: auto;
      font-family: var(--font);
    }
    #rts-dev.collapsed { bottom: auto; }
    #rts-dev.collapsed .tab-content { display: none; }
    #rts-dev .tab-btn { cursor: default; }
    #rts-dev .tab-btn.dv-collapse { flex: 0 0 32px; cursor: pointer; }
    #rts-dev .dv-hint {
      margin-top: 6px; font-size: 11px; line-height: 1.5; color: var(--text-dim);
    }
    #rts-dev .dv-hint b { color: var(--text); font-weight: 600; }
    #rts-dev .dv-world-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #rts-dev .dv-hint code { font-size: 10px; color: var(--text-dim); }
    #rts-dev input[type="color"] {
      width: 36px; height: 22px; padding: 0; border: 1px solid var(--border);
      background: transparent; cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  const $ = (sel) => root.querySelector(sel);

  // ── Collapse ────────────────────────────────────────────────────────────────
  const collapseBtn = $(".dv-collapse");
  collapseBtn.addEventListener("click", () => {
    const collapsed = root.classList.toggle("collapsed");
    collapseBtn.textContent = collapsed ? "+" : "–";
  });

  // ── Camera ──────────────────────────────────────────────────────────────────
  const camBtn = $("#dv-cam");
  const renderCam = () => { camBtn.textContent = rtsCamera.getMode() === "rts" ? "RTS" : "Orbit"; };
  const toggleCam = () => { rtsCamera.toggle(); renderCam(); };
  camBtn.addEventListener("click", toggleCam);
  renderCam();

  const pan = $("#dv-pan"), panV = $("#dv-pan-v");
  pan.value = rtsCamera.params.panSpeed;
  panV.textContent = (+pan.value).toFixed(1);
  pan.addEventListener("input", () => {
    rtsCamera.params.panSpeed = +pan.value;
    panV.textContent = (+pan.value).toFixed(1);
  });

  const pitch = $("#dv-pitch"), pitchV = $("#dv-pitch-v");
  pitch.value = Math.round(rtsCamera.params.pitch / DEG);
  pitchV.textContent = `${pitch.value}°`;
  pitch.addEventListener("input", () => {
    rtsCamera.params.pitch = +pitch.value * DEG;
    pitchV.textContent = `${pitch.value}°`;
  });

  // ── Units ───────────────────────────────────────────────────────────────────
  const speed = $("#dv-speed"), speedV = $("#dv-speed-v");
  speed.value = 1;
  speedV.textContent = "1×";
  speed.addEventListener("input", () => {
    units.setSpeedScale(+speed.value);
    speedV.textContent = `${+speed.value}×`;
  });
  $("#dv-stop-all").addEventListener("click", () => { for (const u of units.list) u.stop(); });
  $("#dv-debug-units").addEventListener("click", () => {
    console.table(units.list.map((u) => u.debugState()));
  });

  // ── Fog ─────────────────────────────────────────────────────────────────────
  const fogState = app?.fog?.state?.height ?? {};
  const distState = app?.fog?.state?.distance ?? {};

  const fogBtn = $("#dv-fog");
  const setFogChecked = (on) => {
    fogBtn.classList.toggle("checked", !!on);
    app?.fog?.setHeight?.({ enabled: !!on, mode: "valley" });
  };
  setFogChecked(fogState.enabled !== false);
  fogBtn.addEventListener("click", () => setFogChecked(!fogBtn.classList.contains("checked")));

  const fogColor = $("#dv-fog-color");
  fogColor.value = fogState.color ?? "#c8d8e4";
  fogColor.addEventListener("input", () => {
    app?.fog?.setHeight?.({ color: fogColor.value });
  });

  const fogBase = $("#dv-fog-base"), fogBaseV = $("#dv-fog-base-v");
  fogBase.value = fogState.base ?? 8;
  fogBaseV.textContent = fogBase.value;
  fogBase.addEventListener("input", () => {
    app?.fog?.setHeight?.({ base: +fogBase.value });
    fogBaseV.textContent = fogBase.value;
  });

  const fogTop = $("#dv-fog-top"), fogTopV = $("#dv-fog-top-v");
  fogTop.value = fogState.top ?? 42;
  fogTopV.textContent = fogTop.value;
  fogTop.addEventListener("input", () => {
    app?.fog?.setHeight?.({ top: +fogTop.value });
    fogTopV.textContent = fogTop.value;
  });

  const fogHaze = $("#dv-fog-haze"), fogHazeV = $("#dv-fog-haze-v");
  fogHaze.value = fogState.haze ?? 0.0018;
  fogHazeV.textContent = (+fogHaze.value).toFixed(4);
  fogHaze.addEventListener("input", () => {
    app?.fog?.setHeight?.({ haze: +fogHaze.value });
    fogHazeV.textContent = (+fogHaze.value).toFixed(4);
  });

  const fogWobble = $("#dv-fog-wobble"), fogWobbleV = $("#dv-fog-wobble-v");
  fogWobble.value = fogState.noiseWobble ?? 16;
  fogWobbleV.textContent = fogWobble.value;
  fogWobble.addEventListener("input", () => {
    app?.fog?.setHeight?.({ noiseWobble: +fogWobble.value });
    fogWobbleV.textContent = fogWobble.value;
  });

  const fogDistBtn = $("#dv-fog-dist");
  const setFogDistChecked = (on) => {
    fogDistBtn.classList.toggle("checked", !!on);
    app?.fog?.setDistance?.({ enabled: !!on, matchSky: true });
  };
  setFogDistChecked(distState.enabled !== false);
  fogDistBtn.addEventListener("click", () => setFogDistChecked(!fogDistBtn.classList.contains("checked")));

  const fogDistD = $("#dv-fog-dist-d"), fogDistDV = $("#dv-fog-dist-d-v");
  fogDistD.value = distState.density ?? 0.0004;
  fogDistDV.textContent = (+fogDistD.value).toFixed(4);
  fogDistD.addEventListener("input", () => {
    app?.fog?.setDistance?.({ density: +fogDistD.value });
    fogDistDV.textContent = (+fogDistD.value).toFixed(4);
  });

  // ── Post-FX ─────────────────────────────────────────────────────────────────
  const postFxBtn = $("#dv-postfx");
  postFxBtn.addEventListener("click", () => {
    const on = !postFxBtn.classList.contains("checked");
    postFxBtn.classList.toggle("checked", on);
    app?.postFx?.setEnabled(on);
  });

  const bloom = $("#dv-bloom"), bloomV = $("#dv-bloom-v");
  bloom.value = app?.postFx?.state?.bloom?.strength ?? 0.85;
  bloomV.textContent = (+bloom.value).toFixed(2);
  bloom.addEventListener("input", () => {
    app?.postFx?.setBloom({ strength: +bloom.value });
    bloomV.textContent = (+bloom.value).toFixed(2);
  });

  // ── World ───────────────────────────────────────────────────────────────────
  const worldNameEl = $("#dv-world-name");
  const worldFileInput = $("#dv-world-file");
  const setWorldName = (name) => { worldNameEl.textContent = name || "—"; };
  setWorldName(worldName);

  $("#dv-world-load").addEventListener("click", () => worldFileInput.click());
  worldFileInput.addEventListener("change", async () => {
    const file = worldFileInput.files?.[0];
    worldFileInput.value = "";
    if (!file || !onLoadWorldFile) return;
    try {
      await onLoadWorldFile(file);
    } catch (err) {
      console.error("[RTS-v3] World load failed:", err);
      window.alert(err instanceof Error ? err.message : "Failed to load world.");
    }
  });
  $("#dv-world-default").addEventListener("click", async () => {
    if (!onLoadDefaultWorld) return;
    try {
      await onLoadDefaultWorld();
    } catch (err) {
      console.error("[RTS-v3] Default world load failed:", err);
      window.alert(err instanceof Error ? err.message : "Failed to load default world.");
    }
  });

  // ── Navigation ──────────────────────────────────────────────────────────────
  const navBtn = $("#dv-nav");
  const setNavChecked = (on) => navBtn.classList.toggle("checked", !!on);
  const toggleNav = () => setNavChecked(navGrid.toggleDebug());
  navBtn.addEventListener("click", toggleNav);

  $("#dv-rebuild").addEventListener("click", () => {
    const wasOn = navBtn.classList.contains("checked");
    navGrid.rebuild();
    minimap?.rebuildTerrain?.();
    navGrid.setDebug(wasOn); // the rebuild drops the old overlay mesh
  });

  // ── Shortcuts (moved here from the old top-left bar) ─────────────────────────
  const onKey = (e) => {
    if (e.repeat || e.target.matches?.("input, textarea")) return;
    if (e.code === "KeyC") toggleCam();
    else if (e.code === "KeyN") toggleNav();
  };
  window.addEventListener("keydown", onKey);

  return {
    root,
    setNavChecked,
    setWorldName,
    getNavDebug: () => navBtn.classList.contains("checked"),
    dispose() {
      window.removeEventListener("keydown", onKey);
      root.remove(); style.remove();
    },
  };
}
