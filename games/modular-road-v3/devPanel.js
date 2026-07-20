// Dev-controls panel — DEVELOPER UI, not player-facing.
//
// Same contract as games/rts-v3/devPanel.js: styled to match the v3 editor's
// right panel by reusing editor.css's own classes (.inspector-section /
// .section-header / .section-body / .prop-row / .prop-value / .prop-num /
// .action-btn / .prop-toggle) and CSS variables, so it reads as the same tool.
// Only the fixed-position container is our own CSS (the editor's #right-panel is
// a grid cell we can't reuse).
//
// This is the single home for every dev utility — world, camera, car tuning,
// track, FX. Player-facing UI is the palette (build) and the hint bar (drive).
import * as THREE from "three";

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

const DEV_PANEL_OPEN_W = 264;

/**
 * @param {object} o
 * @param {object} o.app          the v3 app returned by startV3App
 * @param {object} o.game         the road game's own control surface
 * @param {object} o.params       live-tunable param objects from the vehicle/kit
 */
export function createRoadDevPanel({ app, game, params }) {
  const { TIRE, AERO, DRIVETRAIN, DECK } = params;

  const root = document.createElement("div");
  root.id = "road-dev";
  root.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" type="button">Dev Controls</button>
      <button class="tab-btn dv-collapse" type="button" title="Collapse">–</button>
    </div>
    <div class="tab-content active">

      <div class="inspector-section">
        <div class="section-header">World</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Loaded</span>
            <div class="prop-value"><span class="prop-num dv-world-name" id="dv-world"></span></div>
          </div>
          <button class="action-btn" id="dv-load-world" type="button">Load .v3proj…</button>
          <div class="dv-hint">
            Author worlds in <b>v3/editor.html</b>, Save Project, then drop the file
            here as <code>world.v3proj</code> to make it the default.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Mode</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Current</span>
            <div class="prop-value">
              <button class="action-btn primary" id="dv-mode" type="button">Build</button>
            </div>
          </div>
          <button class="action-btn" id="dv-respawn" type="button">Respawn car (R)</button>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Camera</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Free look</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-freelook" type="button" aria-label="Free look while driving">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Distance</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-dist" min="3" max="20" step="0.5" />
              <span class="prop-num" id="dv-cam-dist-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Height</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-height" min="0.5" max="10" step="0.1" />
              <span class="prop-num" id="dv-cam-height-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Look ahead</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-ahead" min="0" max="15" step="0.5" />
              <span class="prop-num" id="dv-cam-ahead-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Free look</b> hands the camera to orbit while driving (MMB rotate,
            RMB pan) — useful for inspecting the car mid-run.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Power</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Top speed</span>
            <div class="prop-value">
              <input type="range" id="dv-top" min="5" max="80" step="1" />
              <span class="prop-num" id="dv-top-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Accel force</span>
            <div class="prop-value">
              <input type="range" id="dv-accel" min="500" max="15000" step="100" />
              <span class="prop-num" id="dv-accel-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drivetrain</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-layout" type="button">AWD</button>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Grip &amp; Handling</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Friction</span>
            <div class="prop-value">
              <input type="range" id="dv-fric" min="0.2" max="4" step="0.05" />
              <span class="prop-num" id="dv-fric-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rear grip</span>
            <div class="prop-value">
              <input type="range" id="dv-rear" min="0.3" max="1.5" step="0.05" />
              <span class="prop-num" id="dv-rear-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Steer angle</span>
            <div class="prop-value">
              <input type="range" id="dv-steer" min="0.15" max="1.0" step="0.01" />
              <span class="prop-num" id="dv-steer-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Lower <b>rear grip</b> for oversteer / easier drifts. Friction scales
            both axles.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Aero</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Drag</span>
            <div class="prop-value">
              <input type="range" id="dv-drag" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-drag-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Downforce</span>
            <div class="prop-value">
              <input type="range" id="dv-down" min="0" max="20" step="0.5" />
              <span class="prop-num" id="dv-down-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Downforce</b> presses the car onto whatever surface it's on — raise
            it if the car falls out of loops.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Track</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Pieces</span>
            <div class="prop-value"><span class="prop-num" id="dv-pieces">0</span></div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Collision tris</span>
            <div class="prop-value"><span class="prop-num" id="dv-tris">0</span></div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Show collision</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-showcol" type="button" aria-label="Show collision">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Instancing</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-inst" type="button" aria-label="Instancing">${CHECK_SVG}</button>
            </div>
          </div>
          <button class="action-btn" id="dv-rebake" type="button">Rebake collision</button>
          <div class="dv-hint">
            Deck BVH is <b>red</b>, solids (rails/shells) <b>blue</b>. Rebake if
            the car falls through something you just moved.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX &amp; Audio</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Mute all</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-mute" type="button" aria-label="Mute">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Volume</span>
            <div class="prop-value">
              <input type="range" id="dv-vol" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-vol-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tire marks</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-marks" type="button" aria-label="Tire marks">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drift smoke</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-smoke" type="button" aria-label="Drift smoke">${CHECK_SVG}</button>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #road-dev {
      position: fixed; right: 0; top: 0; bottom: 0; width: ${DEV_PANEL_OPEN_W}px; z-index: 200;
      background: var(--bg-panel); border-left: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: var(--font);
      pointer-events: auto;
    }
    #road-dev .tab-bar { flex: 0 0 auto; }
    #road-dev .tab-content { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    #road-dev.collapsed {
      top: 10px; bottom: auto; width: auto; height: auto;
      border-left: none; border-radius: 6px 0 0 6px;
      box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
      overflow: visible;
    }
    #road-dev.collapsed .tab-bar { border-bottom: none; }
    #road-dev.collapsed .tab-btn:not(.dv-collapse) { display: none; }
    #road-dev.collapsed .tab-content { display: none; }
    #road-dev.collapsed .tab-btn.dv-collapse {
      flex: 0 0 auto; padding: 7px 12px; font-size: 11px; font-weight: 600;
      color: var(--text); border-bottom: none; background: var(--bg-panel);
    }
    #road-dev .tab-btn { cursor: default; }
    #road-dev .tab-btn.dv-collapse { flex: 0 0 32px; cursor: pointer; }
    #road-dev .dv-hint {
      margin-top: 6px; font-size: 11px; line-height: 1.5; color: var(--text-dim);
    }
    #road-dev .dv-hint b { color: var(--text); font-weight: 600; }
    #road-dev .dv-hint code { font-size: 10px; color: var(--text-dim); }
    #road-dev .dv-world-name {
      max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  const $ = (sel) => root.querySelector(sel);

  // ── Collapse ────────────────────────────────────────────────────────────────
  const collapseBtn = $(".dv-collapse");
  const setCollapsed = (collapsed) => {
    root.classList.toggle("collapsed", collapsed);
    collapseBtn.textContent = collapsed ? "Dev ▸" : "–";
    collapseBtn.title = collapsed ? "Open dev controls" : "Collapse";
  };
  collapseBtn.addEventListener("click", () => setCollapsed(!root.classList.contains("collapsed")));

  /** Wire a range input to a live object property, with a formatted readout. */
  function slider(id, obj, key, fmt = (v) => v.toFixed(2), onSet = null) {
    const el = $(`#${id}`);
    const out = $(`#${id}-v`);
    if (!el) return;
    el.value = obj[key];
    if (out) out.textContent = fmt(obj[key]);
    el.addEventListener("input", () => {
      const v = +el.value;
      obj[key] = v;
      if (out) out.textContent = fmt(v);
      onSet?.(v);
    });
  }

  /** Wire a .prop-toggle button. `initial` seeds the checked class. */
  function toggle(id, initial, onChange) {
    const el = $(`#${id}`);
    if (!el) return { set: () => {} };
    el.classList.toggle("checked", !!initial);
    el.addEventListener("click", () => {
      const on = !el.classList.contains("checked");
      el.classList.toggle("checked", on);
      onChange(on);
    });
    return { set: (on) => el.classList.toggle("checked", !!on) };
  }

  // ── World ───────────────────────────────────────────────────────────────────
  $("#dv-world").textContent = game.getWorldName();
  $("#dv-world").title = game.getWorldName();
  const worldInput = document.createElement("input");
  worldInput.type = "file";
  worldInput.accept = ".v3proj";
  worldInput.hidden = true;
  worldInput.addEventListener("change", async () => {
    const file = worldInput.files?.[0];
    worldInput.value = "";
    if (!file) return;
    try {
      const res = await game.loadWorldFile(file);
      if (res?.loaded) {
        $("#dv-world").textContent = res.name;
        $("#dv-world").title = res.name;
      }
    } catch (e) {
      console.error("[ModularRoad-v3] world load failed", e);
      alert(`Could not load world: ${e?.message ?? e}`);
    }
  });
  document.body.appendChild(worldInput);
  $("#dv-load-world").addEventListener("click", () => worldInput.click());

  // ── Mode ────────────────────────────────────────────────────────────────────
  const modeBtn = $("#dv-mode");
  const renderMode = () => {
    modeBtn.textContent = game.getMode() === "drive" ? "Drive" : "Build";
  };
  modeBtn.addEventListener("click", () => { game.toggleMode(); renderMode(); });
  $("#dv-respawn").addEventListener("click", () => game.respawn());

  // ── Camera ──────────────────────────────────────────────────────────────────
  toggle("dv-freelook", false, (on) => game.setFreeLook(on));
  const cam = game.cameraParams;
  slider("dv-cam-dist", cam, "dist", (v) => `${v.toFixed(1)}m`);
  slider("dv-cam-height", cam, "height", (v) => `${v.toFixed(1)}m`);
  slider("dv-cam-ahead", cam, "lookAhead", (v) => `${v.toFixed(1)}m`);

  // ── Car ─────────────────────────────────────────────────────────────────────
  slider("dv-top", TIRE, "topSpeed", (v) => `${v.toFixed(0)} m/s`);
  slider("dv-accel", TIRE, "accelForce", (v) => `${(v / 1000).toFixed(1)}k`);
  slider("dv-fric", TIRE, "frictionCoeff");
  slider("dv-rear", TIRE, "gripRear");
  slider("dv-steer", TIRE, "maxSteerAngle", (v) => `${Math.round(v * 57.2958)}°`);
  slider("dv-drag", AERO, "drag");
  slider("dv-down", AERO, "downforce", (v) => v.toFixed(1));

  const LAYOUTS = ["AWD", "RWD", "FWD"];
  const layoutBtn = $("#dv-layout");
  layoutBtn.textContent = DRIVETRAIN.layout;
  layoutBtn.addEventListener("click", () => {
    const i = LAYOUTS.indexOf(DRIVETRAIN.layout);
    DRIVETRAIN.layout = LAYOUTS[(i + 1) % LAYOUTS.length];
    layoutBtn.textContent = DRIVETRAIN.layout;
  });

  // ── Track ───────────────────────────────────────────────────────────────────
  toggle("dv-showcol", false, (on) => game.setCollisionDebug(on));
  toggle("dv-inst", true, (on) => game.setInstancing(on));
  $("#dv-rebake").addEventListener("click", () => game.bakeCollision());

  // ── FX & audio ──────────────────────────────────────────────────────────────
  const audio = game.audioState;
  toggle("dv-mute", !!audio.muteAll, (on) => { audio.muteAll = on; });
  slider("dv-vol", audio.buses.master, "volume", (v) => `${Math.round(v * 100)}%`);
  toggle("dv-marks", true, (on) => game.setTireMarksEnabled(on));
  toggle("dv-smoke", true, (on) => game.setDriftSmokeEnabled(on));

  // ── Live readouts ───────────────────────────────────────────────────────────
  const piecesEl = $("#dv-pieces");
  const trisEl = $("#dv-tris");
  function refresh() {
    renderMode();
    piecesEl.textContent = String(game.getPieceCount());
    trisEl.textContent = game.getCollisionTriCount().toLocaleString();
  }
  refresh();

  return {
    refresh,
    renderMode,
    dispose() { root.remove(); style.remove(); worldInput.remove(); },
  };
}
