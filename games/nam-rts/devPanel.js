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

// Match the v3 editor's --right-w (300px) but give prop-rows a little more room —
// label + range slider + 4-decimal readout clips below ~340px.
export const DEV_PANEL_OPEN_W = 360;

const FOLD_KEY = "rts-v3.devPanel.folds";
/** Sections open on a fresh profile — the rest start folded. */
const DEFAULT_OPEN = new Set(["Camera", "Controls"]);
const ARROW_SVG =
  '<svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
  + '<polyline points="6 9 12 15 18 9"></polyline></svg>';

export function createDevPanel({
  app, navGrid, rtsCamera, units, minimap, foliageZoom = null, stress = null,
  worldName = "procedural default",
  onLoadWorldFile,
  onLoadDefaultWorld,
  onReseat,
}) {
  const DEG = Math.PI / 180;

  const root = document.createElement("div");
  root.id = "rts-dev";
  root.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" type="button"><i data-lucide="wrench"></i> Dev</button>
      <button class="tab-btn dv-expand-all" type="button" title="Expand all sections">⊞</button>
      <button class="tab-btn dv-collapse-all" type="button" title="Collapse all sections">⊟</button>
      <button class="tab-btn dv-collapse" type="button" title="Collapse panel"><i data-lucide="panel-right-close"></i></button>
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
              <input type="range" id="dv-pan" min="10" max="160" step="5" />
              <span class="prop-num" id="dv-pan-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Pitch in</span>
            <div class="prop-value">
              <input type="range" id="dv-pitch-near" min="18" max="70" step="1" />
              <span class="prop-num" id="dv-pitch-near-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Pitch out</span>
            <div class="prop-value">
              <input type="range" id="dv-pitch-far" min="25" max="85" step="1" />
              <span class="prop-num" id="dv-pitch-far-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max zoom</span>
            <div class="prop-value">
              <input type="range" id="dv-dist-max" min="40" max="200" step="5" />
              <span class="prop-num" id="dv-dist-max-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Zoom ease</span>
            <div class="prop-value">
              <input type="range" id="dv-zoom-smooth" min="0" max="30" step="1" />
              <span class="prop-num" id="dv-zoom-smooth-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Height ease</span>
            <div class="prop-value">
              <input type="range" id="dv-height-smooth" min="0" max="12" step="0.5" />
              <span class="prop-num" id="dv-height-smooth-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Edge scroll</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-edge" type="button" aria-label="Edge scroll">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">Pitch goes from <b>in</b> to <b>out</b> across the zoom, CoH-style: horizontal among the units, top-down to read the map. Height ease damps terrain follow while panning; 0 = snap.</div>
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
        <div class="section-header">Fog of War</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Enabled</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-fow" type="button" aria-label="Fog of war">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">CoH-style shroud. Enemy units hidden until scouted. <b>Off by default</b> while the map is being built — turn it on to play.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Match</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Enemy HQ</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-match" type="button" aria-label="Enemy HQ match">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">Spawns an enemy command base at the top of the map. Destroy it to win; lose if yours falls.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Enemy AI</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Commander</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-ai" type="button" aria-label="Enemy AI">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Difficulty</span>
            <div class="prop-value">
              <select class="prop-select" id="dv-ai-diff">
                <option value="easy">Easy</option>
                <option value="normal" selected>Normal</option>
                <option value="hard">Hard</option>
              </select>
            </div>
          </div>
          <pre class="dv-hint" id="dv-ai-status" style="white-space:pre-wrap;font-size:10px;margin:4px 0 0"></pre>
          <div class="dv-hint">Squads of five take, hold and attack points, gather out of sight
            before an attack, fall back when worn down. It only knows what its men can see.
            <b>?ai=0</b> boots without it (no enemy HQ).</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Enemy Waves</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Auto waves</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-waves" type="button" aria-label="Enemy waves">${CHECK_SVG}</button>
            </div>
          </div>
          <button class="action-btn" id="dv-wave-now" type="button">Spawn wave now</button>
          <div id="dv-wave-status"></div>
          <div class="dv-hint">Off by default. Turn on for timed attacks, or spawn one manually. The status line is what used to sit at the top of the screen.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Base Flag</div>
        <div class="section-body">
          <input type="file" id="dv-flag-file" accept="image/*" hidden />
          <button class="action-btn" id="dv-flag-import" type="button">Import flag image…</button>
          <button class="action-btn" id="dv-flag-clear" type="button">Clear image</button>
          <div class="prop-row">
            <span class="prop-label">Color</span>
            <div class="prop-value">
              <input type="color" id="dv-flag-color" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wind</span>
            <div class="prop-value">
              <input type="range" id="dv-flag-wind" min="0" max="900" step="10" />
              <span class="prop-num" id="dv-flag-wind-v"></span>
            </div>
          </div>
          <div class="dv-hint">Any image works. Colour tints the cloth under the image.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Performance</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Render scale</span>
            <div class="prop-value">
              <input type="range" id="dv-rscale" min="60" max="100" step="5" />
              <span class="prop-num" id="dv-rscale-v"></span>
            </div>
          </div>
          <div class="dv-hint" id="dv-rscale-hint"></div>
          <div class="dv-hint">The scene is drawn at this fraction of native and
            scaled up; the HUD stays sharp either way. MEASURED at play zoom:
            <b>100% = 18.5 ms</b> (5% of frames inside budget), <b>90% = 16.6 ms</b>
            (95%). Below 90% buys nothing until something else is added — the
            limit becomes vsync, not the GPU.</div>
          <div class="prop-row">
            <span class="prop-label">Grass</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-grass" type="button" aria-label="Grass">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Far foliage</span>
            <div class="prop-value">
              <input type="range" id="dv-foliage-far" min="20" max="100" step="5" />
              <span class="prop-num" id="dv-foliage-far-v"></span>
            </div>
          </div>
          <div class="dv-hint">Share of the jungle plants kept at full zoom-out; the
            full set returns as you zoom in. Foliage is the biggest cost of the
            zoomed-out frame and scales with plant count. <span id="dv-foliage-now"></span></div>
          <div class="dv-hint">Every grass blade system, compute and draws, plus the
            green tint it lays on distant ground. MEASURED: about <b>1.4 ms</b> zoomed
            out and <b>0.8 ms</b> close up at native resolution — it costs most where it
            shows least. Off, open ground shows its terrain paint (sand reads as sand).</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Stress</div>
        <div class="section-body">
          <button class="action-btn" id="dv-st-soldiers" type="button">+50 soldiers</button>
          <button class="action-btn" id="dv-st-smoke" type="button">+4 smoke</button>
          <button class="action-btn" id="dv-st-fires" type="button">+10 fires</button>
          <button class="action-btn" id="dv-st-gunfire" type="button">Gunfire: off</button>
          <button class="action-btn" id="dv-st-clear" type="button">Clear stress</button>
          <div class="dv-hint">Spawned at the camera focus, straight into the systems — no
            combat, no waves. Soldiers idle on your side. <span id="dv-st-live"></span></div>
          <div class="prop-row">
            <span class="prop-label">Also close-up</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-st-close" type="button" aria-label="Also close-up">${CHECK_SVG}</button>
            </div>
          </div>
          <button class="action-btn primary" id="dv-st-run" type="button">Run price list</button>
          <div class="dv-hint" id="dv-st-status">Prices each ingredient at full zoom-out (and at the
            play zoom if ticked), at two resolutions above native so vsync cannot hide it,
            extrapolated to native. About 3 minutes a view: <b>keep this tab focused and
            do not touch the mouse or keys</b> — it aborts if the page loses focus.</div>
          <div id="dv-st-results"></div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Smoke</div>
        <div class="section-body">
          <button class="action-btn" id="dv-smoke-violet" type="button">Violet marker (M18)</button>
          <button class="action-btn" id="dv-smoke-screen" type="button">Screening grenade</button>
          <button class="action-btn" id="dv-smoke-wreck" type="button">Wreck smoke</button>
          <button class="action-btn" id="dv-smoke-napalm" type="button">Napalm pall</button>
          <button class="action-btn primary" id="dv-napalm-run" type="button">NAPALM RUN</button>
          <button class="action-btn" id="dv-smoke-clear" type="button">Clear all</button>
          <button class="action-btn" id="dv-smoke-look" type="button">Look: flipbook</button>
          <div class="prop-row">
            <span class="prop-label">Opacity</span>
            <div class="prop-value">
              <input type="range" id="dv-smoke-op" min="0" max="150" step="5" />
              <span class="prop-num" id="dv-smoke-op-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Full-detail cols</span>
            <div class="prop-value">
              <input type="range" id="dv-smoke-budget" min="4" max="24" step="1" />
              <span class="prop-num" id="dv-smoke-budget-v"></span>
            </div>
          </div>
          <div class="dv-hint">Render budget: up to this many columns draw every puff;
            past it they all draw a share, denser and a little larger, so the field
            costs about this many columns' worth. Look only — every column still blocks
            sight. MEASURED (2x res): 24 columns 14.7 ms unbudgeted, 7.0 ms at 8.</div>
          <div class="dv-hint">Drops at the camera focus. Violet is a SIGNAL and never
            blocks; screening and napalm break line of sight, so units inside stop
            shooting through it. <span id="dv-smoke-n">0 live</span>.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Light</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Time of day</span>
            <div class="prop-value">
              <input type="range" id="dv-tod" min="4" max="21" step="0.05" />
              <span class="prop-num" id="dv-tod-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sun</span>
            <div class="prop-value">
              <input type="range" id="dv-wl-dir" min="0" max="6" step="0.05" />
              <span class="prop-num" id="dv-wl-dir-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky light</span>
            <div class="prop-value">
              <input type="range" id="dv-wl-hemi" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-wl-hemi-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky fill</span>
            <div class="prop-value">
              <input type="range" id="dv-wl-fill" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-wl-fill-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Reflections</span>
            <div class="prop-value">
              <input type="range" id="dv-wl-env" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-wl-env-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Exposure</span>
            <div class="prop-value">
              <input type="range" id="dv-wl-exp" min="0.3" max="2.5" step="0.02" />
              <span class="prop-num" id="dv-wl-exp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Warmth</span>
            <div class="prop-value">
              <input type="range" id="dv-wl-warm" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-wl-warm-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label"></span>
            <div class="prop-value">
              <button class="action-btn" id="dv-light-keep" type="button" title="Keep this look in this browser across reloads">Keep</button>
              <button class="action-btn" id="dv-light-reset" type="button" title="Back to the map's own look">Reset</button>
              <button class="action-btn" id="dv-light-copy" type="button" title="Copy the values, to write them into the map">Copy</button>
            </div>
          </div>
          <div class="dv-hint">Live. <b>Keep</b> saves the look in this browser; <b>Copy</b> gives the values to write into the map for good.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Grass</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Base colour</span>
            <div class="prop-value">
              <input type="color" id="dv-gr-base" />
              <span class="prop-num" id="dv-gr-base-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tip colour</span>
            <div class="prop-value">
              <input type="color" id="dv-gr-tip" />
              <span class="prop-num" id="dv-gr-tip-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Blade height</span>
            <div class="prop-value">
              <input type="range" id="dv-gr-h" min="0.3" max="2" step="0.05" />
              <span class="prop-num" id="dv-gr-h-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Blade width</span>
            <div class="prop-value">
              <input type="range" id="dv-gr-w" min="0.03" max="0.22" step="0.005" />
              <span class="prop-num" id="dv-gr-w-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Clumping</span>
            <div class="prop-value">
              <input type="range" id="dv-gr-clump" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-gr-clump-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Clump scale</span>
            <div class="prop-value">
              <input type="range" id="dv-gr-cscale" min="0.5" max="6" step="0.1" />
              <span class="prop-num" id="dv-gr-cscale-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fade end</span>
            <div class="prop-value">
              <input type="range" id="dv-gr-fade" min="20" max="110" step="2" />
              <span class="prop-num" id="dv-gr-fade-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Unit trails</span>
            <div class="prop-value">
              <button class="action-btn checked" id="dv-gr-trails" type="button" title="Men and vehicles bend the grass they cross">On</button>
              <span class="prop-num" id="dv-gr-trails-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label"></span>
            <div class="prop-value">
              <button class="action-btn" id="dv-gr-keep" type="button" title="Keep these grass settings in this browser across reloads">Keep</button>
              <button class="action-btn" id="dv-gr-reset" type="button" title="Back to the map's own grass">Reset</button>
              <button class="action-btn" id="dv-gr-copy" type="button" title="Copy the values, to write them into the map">Copy</button>
            </div>
          </div>
          <div class="dv-hint">The live <b>revo</b> grass. Colour applies as you drag; height, width and clump rebuild the tile, so they apply when you let go. <b>Copy</b> gives the lines for tools/namVegPalette.mjs.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Birds</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Enabled</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-birds" type="button" aria-label="Birds">${CHECK_SVG}</button>
            </div>
          </div>
          <button class="action-btn" id="dv-birds-transit" type="button">Send a flock</button>
          <button class="action-btn" id="dv-birds-flush" type="button">Flush here</button>
          <div class="dv-hint">Flocks cross the view now and then. Any explosion near jungle flushes one out of the canopy — <b>Flush here</b> fakes one at the view centre.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Fog</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Model</span>
            <div class="prop-value">
              <select class="prop-select" id="dv-fog-mode">
                <option value="analytic">Analytic (Crytek)</option>
                <option value="valley">Valley band</option>
                <option value="monsoon">Monsoon (top-down)</option>
              </select>
            </div>
          </div>
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
          <div class="prop-row dv-fog-monsoon">
            <span class="prop-label">Density</span>
            <div class="prop-value">
              <input type="range" id="dv-mon-density" min="0.002" max="0.06" step="0.001" />
              <span class="prop-num" id="dv-mon-density-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-monsoon">
            <span class="prop-label">Falloff</span>
            <div class="prop-value">
              <input type="range" id="dv-mon-falloff" min="0.01" max="0.16" step="0.005" />
              <span class="prop-num" id="dv-mon-falloff-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-monsoon">
            <span class="prop-label">Layer (Y)</span>
            <div class="prop-value">
              <input type="range" id="dv-mon-height" min="-20" max="120" step="1" />
              <span class="prop-num" id="dv-mon-height-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-monsoon">
            <span class="prop-label">Sheets</span>
            <div class="prop-value">
              <input type="range" id="dv-mon-strata" min="0" max="1.2" step="0.05" />
              <span class="prop-num" id="dv-mon-strata-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-monsoon">
            <span class="prop-label">Sun glow</span>
            <div class="prop-value">
              <input type="range" id="dv-mon-sun" min="0" max="1.5" step="0.05" />
              <span class="prop-num" id="dv-mon-sun-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-monsoon">
            <span class="prop-label">Sun tint</span>
            <div class="prop-value">
              <input type="color" id="dv-mon-tint" />
            </div>
          </div>
          <div class="dv-hint dv-fog-monsoon">Layer Y near the valley floors (nam-valley plays at y 0-40; the hilltop is 66). Falloff sets thickness ≈ 1/value metres. Keep density LOW — you have to read the battlefield through it. Sun glow only shows looking toward a LOW sun.</div>
          <div class="prop-row dv-fog-valley">
            <span class="prop-label">Base (Y)</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-base" min="-40" max="80" step="1" />
              <span class="prop-num" id="dv-fog-base-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-valley">
            <span class="prop-label">Top (Y)</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-top" min="10" max="200" step="1" />
              <span class="prop-num" id="dv-fog-top-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-valley">
            <span class="prop-label">Haze</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-haze" min="0" max="0.005" step="0.0001" />
              <span class="prop-num" id="dv-fog-haze-v"></span>
            </div>
          </div>
          <div class="prop-row dv-fog-valley">
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
            <div class="prop-value">
              <span class="prop-num dv-world-name" id="dv-world-name"></span>
            </div>
          </div>
          <input type="file" id="dv-world-file" accept=".v3proj" hidden />
          <button class="action-btn" id="dv-world-load" type="button">Load .v3proj…</button>
          <button class="action-btn" id="dv-world-default" type="button">Reload default</button>
          <button class="action-btn" id="dv-world-reseat" type="button">Re-seat on terrain</button>
          <div class="dv-hint">Default: <code>public/levels/nam-valley.v3proj</code>. Or open with <code>?world=/path/file.v3proj</code>. Re-seat drops structures/flag back onto the ground if anything floats.</div>
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
          <div class="prop-row">
            <span class="prop-label">Cover overlay</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-cover" type="button" aria-label="Pin cover overlay">${CHECK_SVG}</button>
            </div>
          </div>
          <button class="action-btn" id="dv-rebuild" type="button">Rebuild nav + minimap</button>
          <div class="dv-hint">Nav shows where units can WALK; cover shows what the
            ground is WORTH — green hard cover, cyan concealment. Hold V for the
            same thing under the cursor; the toggle pins it on for inspecting a bake.</div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Controls</div>
        <div class="section-body">
          <div class="dv-hint">
            <b>Left-click / drag</b> select (Shift adds)<br />
            <b>Right-click</b> move order<br />
            <b>WASD</b> pan · <b>wheel</b> zoom · <b>Q/E</b> rotate<br />
            <b>C</b> camera mode · <b>N</b> nav grid<br />
            <b>hold V</b> cover &amp; concealment under the cursor
          </div>
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #rts-dev {
      position: fixed; right: 0; top: 0; bottom: 0;
      width: ${DEV_PANEL_OPEN_W}px; min-width: ${DEV_PANEL_OPEN_W}px; z-index: 200;
      background: var(--bg-panel); border-left: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: var(--font);
      pointer-events: auto;
      box-sizing: border-box;
    }
    #rts-dev .prop-row { min-width: 0; }
    #rts-dev .prop-label { width: 100px; min-width: 100px; flex-shrink: 0; }
    #rts-dev .prop-value { min-width: 0; overflow: visible; }
    /* The editor's shell has no select style — this is the only one in here. */
    #rts-dev .prop-select {
      flex: 1 1 auto; min-width: 0;
      background: var(--bg-2, #1b1f24); color: var(--fg, #dfe6ee);
      border: 1px solid var(--line, #333a42); border-radius: 4px;
      padding: 2px 6px; font: inherit; font-size: 11px;
    }
    #rts-dev .prop-num {
      width: auto; min-width: 58px; flex-shrink: 0;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    #rts-dev .tab-bar { flex: 0 0 auto; }
    #rts-dev .tab-content {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
    }
    #rts-dev.collapsed {
      top: 10px; bottom: auto; width: auto; min-width: 0; height: auto;
      border-left: none; border-radius: 6px 0 0 6px;
      box-shadow: 0 2px 14px rgba(0, 0, 0, 0.45);
      overflow: visible;
    }
    #rts-dev.collapsed .tab-bar { border-bottom: none; }
    #rts-dev.collapsed .tab-btn:not(.dv-collapse) { display: none; }
    #rts-dev.collapsed .tab-content { display: none; }
    #rts-dev.collapsed .tab-btn.dv-collapse {
      flex: 0 0 auto;
      padding: 7px 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text);
      border-bottom: none;
      background: var(--bg-panel);
      gap: 5px;
    }
    #rts-dev .tab-btn { cursor: default; }
    #rts-dev .tab-btn.dv-collapse,
    #rts-dev .tab-btn.dv-expand-all,
    #rts-dev .tab-btn.dv-collapse-all { flex: 0 0 32px; cursor: pointer; }
    #rts-dev .tab-btn i { width: 13px; height: 13px; }
    #rts-dev .dv-hint {
      margin-top: 6px; font-size: 11px; line-height: 1.5; color: var(--text-dim);
    }
    #rts-dev .dv-hint b { color: var(--text); font-weight: 600; }
    #rts-dev .dv-stress-table { width: 100%; margin-top: 6px; border-collapse: collapse; font-size: 11px; }
    #rts-dev .dv-stress-table th, #rts-dev .dv-stress-table td {
      padding: 2px 4px; text-align: right; border-bottom: 1px solid var(--border); color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    #rts-dev .dv-stress-table th { color: var(--text-dim); font-weight: 500; }
    #rts-dev .dv-stress-table td:first-child, #rts-dev .dv-stress-table th:first-child { text-align: left; }
    #rts-dev .dv-world-name {
      flex: 1; min-width: 0; max-width: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      text-align: right;
    }
    #rts-dev .dv-hint code { font-size: 10px; color: var(--text-dim); }
    #rts-dev input[type="color"] {
      width: 36px; height: 22px; padding: 0; border: 1px solid var(--border);
      background: transparent; cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  const $ = (sel) => root.querySelector(sel);

  // ── Collapsible sections (same pattern as v3 editor / editorShell.js) ───────
  let folds = {};
  try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") || {}; } catch { folds = {}; }
  const saveFolds = () => {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch { /* private mode */ }
  };

  const sections = [];
  for (const hdr of root.querySelectorAll(".section-header")) {
    const key = hdr.textContent.trim();
    const body = hdr.nextElementSibling;
    if (!body?.classList.contains("section-body")) continue;
    hdr.setAttribute("data-toggle", "");
    hdr.insertAdjacentHTML("afterbegin", ARROW_SVG);

    const setOpen = (open) => {
      hdr.classList.toggle("collapsed", !open);
      body.classList.toggle("hidden", !open);
    };
    setOpen(folds[key] ?? DEFAULT_OPEN.has(key));
    hdr.addEventListener("click", () => {
      const open = hdr.classList.contains("collapsed");
      setOpen(open);
      folds[key] = open;
      saveFolds();
    });
    sections.push({ key, setOpen });
  }

  const setAllFolds = (open) => {
    for (const s of sections) { s.setOpen(open); folds[s.key] = open; }
    saveFolds();
  };
  $(".dv-expand-all")?.addEventListener("click", () => setAllFolds(true));
  $(".dv-collapse-all")?.addEventListener("click", () => setAllFolds(false));

  if (typeof lucide !== "undefined") lucide.createIcons();

  // ── Collapse panel ──────────────────────────────────────────────────────────
  const collapseBtn = $(".dv-collapse");
  const setCollapsed = (collapsed) => {
    root.classList.toggle("collapsed", collapsed);
    // The HUD bar ends where this panel begins (hudBar.js reads it).
    document.documentElement.style.setProperty("--rts-dev-w", collapsed ? "0px" : `${DEV_PANEL_OPEN_W}px`);
    collapseBtn.innerHTML = collapsed
      ? '<i data-lucide="panel-right-open"></i> Dev'
      : '<i data-lucide="panel-right-close"></i>';
    collapseBtn.title = collapsed ? "Open dev controls" : "Collapse panel";
    if (typeof lucide !== "undefined") lucide.createIcons();
  };
  collapseBtn.addEventListener("click", () => setCollapsed(!root.classList.contains("collapsed")));

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

  const bindAngle = (id, key) => {
    const el = $(`#${id}`), out = $(`#${id}-v`);
    el.value = Math.round(rtsCamera.params[key] / DEG);
    out.textContent = `${el.value}°`;
    el.addEventListener("input", () => {
      rtsCamera.params[key] = +el.value * DEG;
      out.textContent = `${el.value}°`;
    });
  };
  bindAngle("dv-pitch-near", "pitchNear");
  bindAngle("dv-pitch-far", "pitchFar");

  const bindNum = (id, key, digits = 0) => {
    const el = $(`#${id}`), out = $(`#${id}-v`);
    el.value = rtsCamera.params[key];
    out.textContent = (+el.value).toFixed(digits);
    el.addEventListener("input", () => {
      rtsCamera.params[key] = +el.value;
      out.textContent = (+el.value).toFixed(digits);
    });
  };
  bindNum("dv-dist-max", "distMax");
  bindNum("dv-zoom-smooth", "zoomSmooth");

  const edgeBtn = $("#dv-edge");
  const setEdge = (on) => { edgeBtn.classList.toggle("checked", !!on); rtsCamera.params.edgeScroll = !!on; };
  setEdge(rtsCamera.params.edgeScroll);
  edgeBtn.addEventListener("click", () => setEdge(!edgeBtn.classList.contains("checked")));

  const heightSmooth = $("#dv-height-smooth"), heightSmoothV = $("#dv-height-smooth-v");
  heightSmooth.value = rtsCamera.params.heightSmooth;
  heightSmoothV.textContent = (+heightSmooth.value).toFixed(1);
  heightSmooth.addEventListener("input", () => {
    rtsCamera.params.heightSmooth = +heightSmooth.value;
    heightSmoothV.textContent = (+heightSmooth.value).toFixed(1);
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

  // ── Fog of war ──────────────────────────────────────────────────────────────
  const fowBtn = $("#dv-fow");
  const setFowChecked = (on) => {
    fowBtn.classList.toggle("checked", !!on);
    app?.fogOfWar?.setEnabled?.(!!on);
  };
  setFowChecked(app?.fogOfWar?.enabled !== false);
  fowBtn.addEventListener("click", () => setFowChecked(!fowBtn.classList.contains("checked")));

  // ── Symmetric HQ match ──────────────────────────────────────────────────────
  const matchBtn = $("#dv-match");
  const setMatchChecked = (on) => {
    matchBtn.classList.toggle("checked", !!on);
    app?.match?.setEnabled?.(!!on);
  };
  setMatchChecked(app?.match?.enabled ?? false);
  matchBtn.addEventListener("click", () => setMatchChecked(!matchBtn.classList.contains("checked")));

  // ── Enemy AI ────────────────────────────────────────────────────────────────
  const aiBtn = $("#dv-ai");
  const setAiChecked = (on) => {
    aiBtn.classList.toggle("checked", !!on);
    app?.enemyAI?.setEnabled?.(!!on);
  };
  setAiChecked(app?.enemyAI?.enabled ?? false);
  aiBtn.addEventListener("click", () => setAiChecked(!aiBtn.classList.contains("checked")));
  $("#dv-ai-diff").addEventListener("change", (e) => app?.enemyAI?.setDifficulty?.(e.target.value));
  {
    const out = $("#dv-ai-status");
    let lastText = "";
    setInterval(() => {
      const ai = app?.enemyAI;
      if (!ai || !out.isConnected || out.offsetParent === null) return;   // section closed: no layout work
      const req = app.requisition;
      const text = [
        `supplies ${Math.floor(ai.purse.stock)} · points ${req?.heldByEnemy ?? 0}/${req?.points.length ?? 0}`,
        ...ai.summary(),
        "",
        ...ai.log.slice(-6),
      ].join("\n");
      if (text !== lastText) { lastText = text; out.textContent = text; }
    }, 500);
  }

  // ── Enemy waves ─────────────────────────────────────────────────────────────
  const wavesBtn = $("#dv-waves");
  const setWavesChecked = (on) => {
    wavesBtn.classList.toggle("checked", !!on);
    app?.waves?.setEnabled?.(!!on);
  };
  setWavesChecked(app?.waves?.enabled ?? false);
  wavesBtn.addEventListener("click", () => setWavesChecked(!wavesBtn.classList.contains("checked")));
  $("#dv-wave-now").addEventListener("click", () => app?.waves?.spawnNow?.());

  // ── Base flag ───────────────────────────────────────────────────────────────
  const flagFileInput = $("#dv-flag-file");
  const flagColor = $("#dv-flag-color");
  flagColor.value = app?.baseFlag?.currentColor?.() ?? "#c8322d";
  flagColor.addEventListener("input", () => app?.baseFlag?.setParam?.("flagColor", flagColor.value));

  // Applying/clearing an image also resets the tint (see baseFlag.js) — keep the
  // picker showing what the cloth is actually using.
  const syncFlagColor = () => { flagColor.value = app?.baseFlag?.currentColor?.() ?? "#c8322d"; };

  $("#dv-flag-import").addEventListener("click", () => flagFileInput.click());
  flagFileInput.addEventListener("change", () => {
    const file = flagFileInput.files?.[0];
    if (file) { app?.baseFlag?.setTextureFile?.(file); syncFlagColor(); }
    flagFileInput.value = ""; // let the same file be picked again
  });
  $("#dv-flag-clear").addEventListener("click", () => {
    app?.baseFlag?.clearTexture?.();
    syncFlagColor();
  });

  const flagWind = $("#dv-flag-wind"), flagWindV = $("#dv-flag-wind-v");
  flagWind.value = app?.baseFlag?.getParams?.()?.windIntensity ?? 300;
  flagWindV.textContent = flagWind.value;
  flagWind.addEventListener("input", () => {
    app?.baseFlag?.setParam?.("windIntensity", +flagWind.value);
    flagWindV.textContent = flagWind.value;
  });

  // ── Performance ─────────────────────────────────────────────────────────────
  // Its OWN preference, not the engine's: the editor shares one key across
  // every project because the right value is a property of the machine, but an
  // editor wants fidelity where this game wants frames, and the two should not
  // overwrite each other.
  const RSCALE_KEY = "namrts.renderScale";
  const rScale = $("#dv-rscale"), rScaleV = $("#dv-rscale-v"), rScaleHint = $("#dv-rscale-hint");
  const showScale = (pct) => {
    rScaleV.textContent = `${pct}%`;
    const base = app?.basePixelRatio ?? 1;
    const el = app?.renderer?.domElement;
    rScaleHint.innerHTML = el
      ? `drawing <b>${el.width}x${el.height}</b> (native ${Math.round(el.clientWidth * base)}x${Math.round(el.clientHeight * base)})`
      : "";
  };
  {
    const saved = parseFloat(localStorage.getItem(RSCALE_KEY));
    const start = Number.isFinite(saved) ? saved : (app?.renderScale ?? 1);
    app?.setRenderScale?.(start, { persist: false });
    rScale.value = String(Math.round(start * 100));
    // One frame later, so the canvas has resized before the hint reads it.
    requestAnimationFrame(() => showScale(Math.round(start * 100)));
  }
  rScale.addEventListener("input", () => {
    const pct = Number(rScale.value);
    app?.setRenderScale?.(pct / 100, { persist: false });
    localStorage.setItem(RSCALE_KEY, String(pct / 100));
    requestAnimationFrame(() => showScale(pct));
  });

  // How thin the jungle gets at full zoom-out (namGame's foliageZoom.far).
  const FOLIAGE_FAR_KEY = "namrts.foliageFar";
  const folFar = $("#dv-foliage-far"), folFarV = $("#dv-foliage-far-v"), folNow = $("#dv-foliage-now");
  if (foliageZoom) {
    const saved = parseFloat(localStorage.getItem(FOLIAGE_FAR_KEY));
    if (Number.isFinite(saved)) foliageZoom.far = Math.max(0.2, Math.min(1, saved));
    folFar.value = String(Math.round(foliageZoom.far * 100));
    folFarV.textContent = `${folFar.value}%`;
    folFar.addEventListener("input", () => {
      foliageZoom.far = Number(folFar.value) / 100;
      folFarV.textContent = `${folFar.value}%`;
      localStorage.setItem(FOLIAGE_FAR_KEY, String(foliageZoom.far));
    });
    // What the camera is using right now — the value changes as you zoom.
    setInterval(() => {
      if (!folNow.isConnected) return;
      folNow.textContent = `Now: ${Math.round((app?.foliageThin ?? 1) * 100)}%.`;
    }, 250);
  } else {
    folFar.disabled = true;
  }

  // Grass is a taste call per camera: it sells a close view and is mostly
  // invisible from the top-down one, so it is the player's switch, remembered.
  const GRASS_KEY = "namrts.grass";
  const grassBtn = $("#dv-grass");
  const setGrass = (on) => {
    grassBtn.classList.toggle("checked", !!on);
    app?.setGrassEnabled?.(!!on);
  };
  setGrass(localStorage.getItem(GRASS_KEY) !== "0");
  grassBtn.addEventListener("click", () => {
    const on = !grassBtn.classList.contains("checked");
    setGrass(on);
    localStorage.setItem(GRASS_KEY, on ? "1" : "0");
  });

  // ── Stress ──────────────────────────────────────────────────────────────────
  // Manual spawners to LOOK at a busy battlefield, and the price list that
  // measures one. See stressTest.js for what is measured and why.
  {
    const live = $("#dv-st-live"), status = $("#dv-st-status"), results = $("#dv-st-results");
    const gunBtn = $("#dv-st-gunfire"), closeBtn = $("#dv-st-close"), runBtn = $("#dv-st-run");
    let gunOn = false;
    const showLive = () => {
      if (!stress || !live.isConnected) return;
      live.textContent = `${stress.soldierCount} stress soldiers, ${app?.smoke?.activeCount?.() ?? 0} smoke, `
        + `${app?.fire?.activeCount?.() ?? 0} fires.`;
    };
    setInterval(showLive, 500);
    if (!stress) {
      for (const id of ["soldiers", "smoke", "fires", "gunfire", "clear", "run"]) $(`#dv-st-${id}`).disabled = true;
    } else {
      $("#dv-st-soldiers").addEventListener("click", () => stress.soldiers(50));
      $("#dv-st-smoke").addEventListener("click", () => stress.smoke(4));
      $("#dv-st-fires").addEventListener("click", () => stress.fires(10));
      gunBtn.addEventListener("click", () => {
        gunOn = !gunOn;
        stress.setGunfire(gunOn);
        gunBtn.textContent = `Gunfire: ${gunOn ? "on" : "off"}`;
      });
      $("#dv-st-clear").addEventListener("click", () => {
        stress.clear();
        gunOn = false;
        gunBtn.textContent = "Gunfire: off";
      });
      closeBtn.addEventListener("click", () => closeBtn.classList.toggle("checked"));

      const cell = (v) => (Number.isFinite(v) ? v.toFixed(2) : "–");
      const render = (r) => {
        let html = "";
        for (const [view, v] of Object.entries(r.views)) {
          html += `<div class="dv-hint"><b>${view === "out" ? "Full zoom-out" : "Play zoom"}</b> — baseline `
            + `${cell(v.baseNative)} → ${cell(v.baseEndNative)} ms at native (start → end; a big move is drift).</div>`;
          html += `<table class="dv-stress-table"><tr><th>adds</th><th>frame ms</th><th>CPU ms</th></tr>`;
          for (const row of v.rows) {
            html += `<tr><td>${row.what}</td><td>+${cell(row["frame ms, native est."])}</td>`
              + `<td>+${cell(row["game CPU ms"])}</td></tr>`;
          }
          html += `</table>`;
        }
        results.innerHTML = html;
      };

      runBtn.addEventListener("click", async () => {
        if (stress.running) { stress.stop(); return; }
        gunOn = false;
        gunBtn.textContent = "Gunfire: off";
        runBtn.textContent = "Stop";
        results.innerHTML = "";
        const views = closeBtn.classList.contains("checked") ? ["out", "close"] : ["out"];
        const r = await stress.run({ views, onProgress: (t) => { status.textContent = `Measuring ${t}… keep this tab focused.`; } });
        runBtn.textContent = "Run price list";
        if (r) {
          status.textContent = "Done. Native estimates; the full table (both resolutions, per unit) is in the console and window.__NAM_STRESS.";
          render(r);
        } else {
          status.textContent = stress.abortReason
            ? `Aborted: ${stress.abortReason}. Nothing is reported from a partial run.`
            : "Stopped.";
        }
      });
    }
  }

  // ── Smoke ───────────────────────────────────────────────────────────────────
  // Drops a column at whatever the camera is looking at, which is the only
  // placement that makes sense before units can throw their own: you evaluate
  // smoke by standing the camera where a player would and rotating around it.
  const dropSmoke = (kind) => {
    const v = rtsCamera?.getView?.();
    const f = v?.focus;
    app?.smoke?.spawn({ x: f?.x ?? 0, z: f?.z ?? 0, kind });
  };
  for (const kind of ["violet", "screen", "wreck", "napalm"]) {
    $(`#dv-smoke-${kind}`).addEventListener("click", () => dropSmoke(kind));
  }
  // A/B the puffs' look: the flipbook atlas or the old procedural disc.
  const smokeLook = $("#dv-smoke-look");
  smokeLook.addEventListener("click", () => {
    if (!app?.smoke?.setLook) return;
    app.smoke.setLook(app.smoke.look === "flipbook" ? "procedural" : "flipbook");
    smokeLook.textContent = `Look: ${app.smoke.look}`;
  });
  $("#dv-smoke-clear").addEventListener("click", () => {
    app?.smoke?.clear?.();
    app?.napalm?.clear?.();
  });

  // A run flies along the direction the camera is FACING, which is the heading
  // a player would mean by pointing at the ground and is also the one that
  // reads best — the corridor it denies runs away from you into the screen.
  $("#dv-napalm-run").addEventListener("click", () => {
    const v = rtsCamera?.getView?.();
    if (!v) return;
    app?.napalm?.strike?.({
      x: v.focus.x - Math.sin(v.yaw) * 35,
      z: v.focus.z - Math.cos(v.yaw) * 35,
      dirX: Math.sin(v.yaw), dirZ: Math.cos(v.yaw),
    });
  });

  const smokeOp = $("#dv-smoke-op"), smokeOpV = $("#dv-smoke-op-v");
  smokeOp.value = 100;
  smokeOpV.textContent = "1.00";
  smokeOp.addEventListener("input", () => {
    const v = +smokeOp.value / 100;
    smokeOpV.textContent = v.toFixed(2);
    // Visual only — losOpacity is a separate number, so turning the look down
    // to inspect the geometry does not quietly change what blocks.
    if (app?.smoke) app.smoke.params.uOpacity.value = v;
  });

  // The render budget (smokeField FULL_DETAIL_COLUMNS): look against cost,
  // never the rule — every live column still blocks sight.
  const SMOKE_BUDGET_KEY = "namrts.smokeBudget";
  const smokeBud = $("#dv-smoke-budget"), smokeBudV = $("#dv-smoke-budget-v");
  {
    const saved = parseInt(localStorage.getItem(SMOKE_BUDGET_KEY), 10);
    const start = Number.isFinite(saved) ? saved : (app?.smoke?.budget?.fullColumns ?? 8);
    app?.smoke?.setBudget?.({ fullColumns: start });
    smokeBud.value = String(start);
    smokeBudV.textContent = String(start);
  }
  smokeBud.addEventListener("input", () => {
    const n = Number(smokeBud.value);
    smokeBudV.textContent = String(n);
    app?.smoke?.setBudget?.({ fullColumns: n });
    localStorage.setItem(SMOKE_BUDGET_KEY, String(n));
  });

  const smokeN = $("#dv-smoke-n");
  const smokeTimer = setInterval(() => {
    const b = app?.smoke?.budget;
    smokeN.textContent = `${app?.smoke?.activeCount?.() ?? 0} live`
      + (b && b.drawn < 0.999 ? `, drawing ${Math.round(b.drawn * 100)}% of each column's puffs` : "");
  }, 500);

  // ── Light ───────────────────────────────────────────────────────────────────
  // The Atmosphere sky derives every light from the sun (key colour, sky fill,
  // exposure, env on the daylight curve); these scale that derivation through
  // app.sky.setWorldLight, and time of day moves the sun itself. All live.
  // "Keep" stores the look in this browser and re-applies it at the next boot
  // — tuning survives reloads without touching the map; "Copy" hands over the
  // numbers to write into nam-valley / namGame.js for good.
  const LIGHT_KEY = "namrts.light";
  const wl0 = app?.sky?.getWorldLight?.() ?? {};
  const tod0 = app?.sky?.state?.timeOfDay ?? 12.5;
  const mapLook = { tod: tod0, dir: wl0.dir, hemi: wl0.hemi, skyFill: wl0.skyFill, env: wl0.env, exposure: wl0.exposure, warmth: wl0.warmth };
  const look = { ...mapLook };
  try { Object.assign(look, JSON.parse(localStorage.getItem(LIGHT_KEY) || "null") || {}); } catch { /* private mode */ }
  const applyLook = () => {
    app?.sky?.setTimeOfDay?.(look.tod);
    app?.sky?.setWorldLight?.({ dir: look.dir, hemi: look.hemi, skyFill: look.skyFill, env: look.env, exposure: look.exposure, warmth: look.warmth });
  };
  const hhmm = (v) => {
    const h = Math.floor(v), m = Math.round((v - h) * 60) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const lightRows = [];
  const lightSlider = (id, key, fmt) => {
    const el = $(`#${id}`), out = $(`#${id}-v`);
    if (!el) return;
    const show = () => { el.value = look[key]; out.textContent = fmt(+el.value); };
    show();
    lightRows.push(show);
    el.addEventListener("input", () => { look[key] = +el.value; out.textContent = fmt(+el.value); applyLook(); });
  };
  const f2 = (v) => v.toFixed(2);
  lightSlider("dv-tod", "tod", hhmm);
  lightSlider("dv-wl-dir", "dir", f2);
  lightSlider("dv-wl-hemi", "hemi", f2);
  lightSlider("dv-wl-fill", "skyFill", f2);
  lightSlider("dv-wl-env", "env", f2);
  lightSlider("dv-wl-exp", "exposure", f2);
  lightSlider("dv-wl-warm", "warmth", f2);
  let kept = false;
  try { kept = !!localStorage.getItem(LIGHT_KEY); } catch { /* private mode */ }
  if (kept) applyLook();   // a kept look wins over the map's at boot
  $("#dv-light-keep")?.addEventListener("click", () => {
    try { localStorage.setItem(LIGHT_KEY, JSON.stringify(look)); } catch { /* private mode */ }
  });
  $("#dv-light-reset")?.addEventListener("click", () => {
    try { localStorage.removeItem(LIGHT_KEY); } catch { /* private mode */ }
    Object.assign(look, mapLook);
    applyLook();
    for (const show of lightRows) show();
  });
  $("#dv-light-copy")?.addEventListener("click", async () => {
    const r = (v) => Math.round(v * 100) / 100;
    const text = `nam-rts light: timeOfDay ${r(look.tod)} (${hhmm(look.tod)}) · setWorldLight({ dir: ${r(look.dir)}, hemi: ${r(look.hemi)}, skyFill: ${r(look.skyFill)}, env: ${r(look.env)}, exposure: ${r(look.exposure)}, warmth: ${r(look.warmth)} })`;
    console.info(text);
    try { await navigator.clipboard.writeText(text); } catch { /* logged above */ }
  });

  // ── Grass ───────────────────────────────────────────────────────────────────
  // The live REVO grass (grassState.system is "revo" on this map), edited
  // through __V3_DEBUG.revoGrassState + syncGrass — the same handle the A/B
  // passes used, so what you tune here is exactly what the map ships.
  //
  // Colour is a uniform and applies as you drag. Height, width and clump are
  // GEOMETRY keys: syncGrass rebuilds the tile for them, so they apply on
  // release (`change`) rather than per pixel of slider travel, which would
  // rebuild a few hundred times a drag.
  const GRASS_LOOK_KEY = "namrts.grassLook";   // the on/off toggle owns "namrts.grass"
  const revo = window.__V3_DEBUG?.revoGrassState ?? null;
  const syncGrass = () => window.__V3_DEBUG?.syncGrass?.();
  if (revo) {
    const GK = ["baseColor", "tipColor", "bladeHeight", "bladeWidth", "clumpStrength", "clumpScale", "fadeEnd"];
    const mapGrass = Object.fromEntries(GK.map((k) => [k, revo[k]]));
    const grass = { ...mapGrass };
    try { Object.assign(grass, JSON.parse(localStorage.getItem(GRASS_LOOK_KEY) || "null") || {}); } catch { /* private mode */ }
    const applyGrass = () => { Object.assign(revo, grass); syncGrass(); };
    const grassRows = [];
    const bind = (id, key, { live = true, fmt = (v) => v } = {}) => {
      const el = $(`#${id}`), out = $(`#${id}-v`);
      if (!el) return;
      const show = () => { el.value = grass[key]; if (out) out.textContent = fmt(grass[key]); };
      show();
      grassRows.push(show);
      const commit = () => {
        grass[key] = el.type === "color" ? el.value : +el.value;
        if (out) out.textContent = fmt(grass[key]);
        applyGrass();
      };
      el.addEventListener(live ? "input" : "change", commit);
      // A geometry slider still shows its number while dragging; it just does
      // not rebuild until release.
      if (!live && out) el.addEventListener("input", () => { out.textContent = fmt(+el.value); });
    };
    const g2 = (v) => (+v).toFixed(2);
    bind("dv-gr-base", "baseColor", { fmt: (v) => v });
    bind("dv-gr-tip", "tipColor", { fmt: (v) => v });
    bind("dv-gr-h", "bladeHeight", { live: false, fmt: g2 });
    bind("dv-gr-w", "bladeWidth", { live: false, fmt: (v) => (+v).toFixed(3) });
    bind("dv-gr-clump", "clumpStrength", { live: false, fmt: g2 });
    bind("dv-gr-cscale", "clumpScale", { live: false, fmt: g2 });
    bind("dv-gr-fade", "fadeEnd", { fmt: (v) => `${Math.round(v)} m` });
    let grassKept = false;
    try { grassKept = !!localStorage.getItem(GRASS_LOOK_KEY); } catch { /* private mode */ }
    if (grassKept) applyGrass();
    $("#dv-gr-keep")?.addEventListener("click", () => {
      try { localStorage.setItem(GRASS_LOOK_KEY, JSON.stringify(grass)); } catch { /* private mode */ }
    });
    $("#dv-gr-reset")?.addEventListener("click", () => {
      try { localStorage.removeItem(GRASS_LOOK_KEY); } catch { /* private mode */ }
      Object.assign(grass, mapGrass);
      applyGrass();
      for (const show of grassRows) show();
    });
    $("#dv-gr-copy")?.addEventListener("click", async () => {
      const text = `const REVO = { baseColor: "${grass.baseColor}", tipColor: "${grass.tipColor}" };\n`
        + `const REVO_DENSITY = { bladeHeight: ${+(+grass.bladeHeight).toFixed(2)}, `
        + `bladeWidth: ${+(+grass.bladeWidth).toFixed(3)}, `
        + `clumpStrength: ${+(+grass.clumpStrength).toFixed(2)}, `
        + `clumpScale: ${+(+grass.clumpScale).toFixed(2)}, fadeEnd: ${Math.round(grass.fadeEnd)} };`;
      console.info(text);
      try { await navigator.clipboard.writeText(text); } catch { /* logged above */ }
    });
  }

  // Trails: the grass push field, stamped by the units (grassTrails.js). Its
  // own switch because it is the one part of the grass that costs per FRAME
  // rather than per tile, and because it was asked for with one.
  const TRAILS_KEY = "namrts.grassTrails";
  const trailsBtn = $("#dv-gr-trails");
  const trailsN = $("#dv-gr-trails-v");
  if (trailsBtn && app?.grassTrails) {
    const setTrails = (on) => {
      app.grassTrails.setEnabled(on);
      trailsBtn.classList.toggle("checked", on);
      trailsBtn.textContent = on ? "On" : "Off";
    };
    let want = true;
    try { want = localStorage.getItem(TRAILS_KEY) !== "0"; } catch { /* private mode */ }
    setTrails(want);
    trailsBtn.addEventListener("click", () => {
      const on = !app.grassTrails.enabled;
      setTrails(on);
      try { localStorage.setItem(TRAILS_KEY, on ? "1" : "0"); } catch { /* private mode */ }
    });
    setInterval(() => {
      if (trailsN) trailsN.textContent = app.grassTrails.enabled ? `${app.grassTrails.lastStamps ?? 0} stamped` : "";
    }, 500);
  }

  // ── Birds ───────────────────────────────────────────────────────────────────
  const birdsBtn = $("#dv-birds");
  birdsBtn?.addEventListener("click", () => {
    const on = !birdsBtn.classList.contains("checked");
    birdsBtn.classList.toggle("checked", on);
    app?.birds?.setEnabled?.(on);
  });
  $("#dv-birds-transit")?.addEventListener("click", () => app?.birds?.spawnTransit?.());
  $("#dv-birds-flush")?.addEventListener("click", () => {
    const t = app?.controls?.target;
    // A dev flush ignores the "is there jungle here" test: the point is to see it.
    if (t) app?.birds?.flush?.(t.x, t.z, { force: true });
  });

  // ── Fog ─────────────────────────────────────────────────────────────────────
  const fogState = app?.fog?.state?.height ?? {};
  const distState = app?.fog?.state?.distance ?? {};

  // The MODEL is picked here rather than being pinned to "valley" by the
  // toggle: the point of a second fog is being able to flip between them on
  // the same frame and see which one the map wants.
  const fogMode = $("#dv-fog-mode");
  fogMode.value = fogState.mode ?? "valley";
  const fogBtn = $("#dv-fog");
  // Each model has its own controls and they do nothing for the others, so
  // only the live model's are shown. Four dead sliders is how you end up
  // tuning the wrong thing for ten minutes.
  const showFogRows = () => {
    const m = fogMode.value;
    for (const el of root.querySelectorAll(".dv-fog-valley")) el.style.display = m === "valley" ? "" : "none";
    for (const el of root.querySelectorAll(".dv-fog-monsoon")) el.style.display = m === "monsoon" ? "" : "none";
  };
  const applyFog = (on) => {
    fogBtn.classList.toggle("checked", !!on);
    app?.fog?.setHeight?.({ enabled: !!on, mode: fogMode.value });
    showFogRows();
  };
  applyFog(fogState.enabled !== false);
  fogBtn.addEventListener("click", () => applyFog(!fogBtn.classList.contains("checked")));
  fogMode.addEventListener("change", () => applyFog(fogBtn.classList.contains("checked")));

  // ── Monsoon controls ────────────────────────────────────────────────────────
  const monSlider = (id, key, digits) => {
    const el = $(`#${id}`), out = $(`#${id}-v`);
    el.value = fogState[key];
    out.textContent = (+el.value).toFixed(digits);
    el.addEventListener("input", () => {
      out.textContent = (+el.value).toFixed(digits);
      app?.fog?.setHeight?.({ [key]: +el.value });
    });
  };
  monSlider("dv-mon-density", "monDensity", 3);
  monSlider("dv-mon-falloff", "monFalloff", 3);
  monSlider("dv-mon-height", "monHeight", 0);
  monSlider("dv-mon-strata", "monStrata", 2);
  monSlider("dv-mon-sun", "monSunStrength", 2);
  const monTint = $("#dv-mon-tint");
  monTint.value = fogState.monSunTint ?? "#ffcf9a";
  monTint.addEventListener("input", () => app?.fog?.setHeight?.({ monSunTint: monTint.value }));

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
  $("#dv-world-reseat").addEventListener("click", async () => {
    try {
      await onReseat?.();
    } catch (err) {
      console.error("[RTS-v3] Re-seat failed:", err);
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

  // Pinning the cover overlay is a DEV view of the whole bake; players hold V.
  const coverBtn = $("#dv-cover");
  coverBtn.classList.toggle("checked", !!app?.coverOverlay?.pinned);
  coverBtn.addEventListener("click", () => {
    const on = !coverBtn.classList.contains("checked");
    coverBtn.classList.toggle("checked", on);
    app?.coverOverlay?.setPinned(on);
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
      clearInterval(smokeTimer);
      window.removeEventListener("keydown", onKey);
      root.remove(); style.remove();
    },
  };
}
