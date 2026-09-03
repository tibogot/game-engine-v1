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
// track, FX. Player-facing UI is the palette (build); shortcuts live here for
// now (Mode section) until a dedicated menu exists.
import * as THREE from "three";
import { formatRunTime } from "./modularRoadRun.js";

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

// Wider than the v3 editor's --right-w (300px). At 300, a prop-row of label
// (90px) + range (browser min ~129px) + readout (52px) plus the scrollbar
// clipped ~18px off the right edge. 360 matches games/rts-v3/devPanel.js and
// leaves room for the slider to sit fully inside the panel.
const DEV_PANEL_OPEN_W = 360;

/**
 * @param {object} o
 * @param {object} o.app          the v3 app returned by startV3App
 * @param {object} o.game         the road game's own control surface
 * @param {object} o.params       live-tunable param objects from the vehicle/kit
 */
export function createRoadDevPanel({ app, game, params }) {
  const {
    TIRE, AERO, ROAD_HOLD, DRIVETRAIN, DECK, SOLID, BODYLEAN, HEADLIGHTS,
    CHASSIS_GLB_LIGHTS, WHEEL_LAYOUT, DRIFT, glowPropParams,
  } = params;

  const root = document.createElement("div");
  root.id = "road-dev";
  root.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" type="button">Dev Controls</button>
      <button class="tab-btn dv-hints-btn" type="button" title="Show or hide the explanation notes">&#9432;</button>
      <button class="tab-btn dv-expand-all" type="button" title="Expand all sections">⊞</button>
      <button class="tab-btn dv-collapse-all" type="button" title="Collapse all sections">⊟</button>
      <button class="tab-btn dv-collapse" type="button" title="Collapse">–</button>
    </div>
    <!-- FIND, rather than READ. With 253 controls across 29 sections, the way
         to answer "where is the fog slider" is to type "fog" — not to scan
         paragraphs. The notes stay (they are worth having) but they are no
         longer the navigation mechanism, which is what made them feel bloated. -->
    <div class="dv-search">
      <span class="dv-search-icon">&#128269;</span>
      <input id="dv-filter" type="search" spellcheck="false" autocomplete="off"
        placeholder="Filter controls…  (/ to focus, Esc to clear)" />
      <span class="dv-search-count" id="dv-filter-count"></span>
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
          <div class="prop-row">
            <span class="prop-label">Terrain</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-terrain" type="button" aria-label="Terrain (off = sky mode)">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">
            Off is <b>sky mode</b>: no ground drawn, none to land on — the car falls
            past where it was and respawns. For races that live in the air, and for
            reading the game's own frame time without the terrain's fixed ~2.5&nbsp;ms
            sitting on top of every measurement. Safe to flip while driving.
          </div>
          <!-- The Clouds toggle used to live here, alone. It moved to its own
               CLOUDS group below, with the rest of the knobs it belongs to. -->
          <div class="dv-hint">
            Author worlds in <b>v3/editor.html</b>, Save Project, then drop the file
            here as <code>world.v3proj</code> to make it the default.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Build (sky)</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Build height</span>
            <div class="prop-value">
              <input type="range" id="dv-bh" min="0" max="200" step="2" />
              <span class="prop-num" id="dv-bh-v"></span>
            </div>
          </div>
          <button class="action-btn primary" id="dv-newchain" type="button">New chain here (N)</button>
          <div class="prop-row">
            <span class="prop-label">Anchor tilt</span>
            <div class="prop-value"><span class="prop-num" id="dv-anchor-tilt">level</span></div>
          </div>
          <button class="action-btn" id="dv-anchor-level" type="button">Level anchor</button>
          <div class="dv-hint">
            To tilt a chain (e.g. a banked landing strip after a jump): start or
            select it, press <b>Shift+E</b> for the rotate gizmo — on a chain
            anchor it turns on all 3 axes — and drag. The whole chain tilts
            rigidly. <b>Level anchor</b> resets pitch/roll (keeps the heading).
          </div>
          <div class="dv-hint">
            The track floats at this height above the terrain. <b>New chain</b> drops
            a fresh anchor in the sky where you're looking; pieces auto-chain from
            it, so the whole track floats — no dragging pieces up.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Prop livery</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label" id="dv-livery-name">No prop selected</span>
          </div>
          <div class="prop-row">
            <div class="prop-value" id="dv-livery-swatches" style="display:flex;flex-wrap:wrap;gap:4px"></div>
          </div>
          <div class="prop-row" id="dv-decal-row">
            <span class="prop-label" id="dv-decal-label">Decal</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-decal" type="button" aria-label="Decal">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row" id="dv-advert-row" style="display:none">
            <span class="prop-label" id="dv-advert-label">Advert</span>
            <div class="prop-value" style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="action-btn" id="dv-advert-upload" type="button">Upload image</button>
              <button class="action-btn" id="dv-advert-clear" type="button">Clear</button>
              <input id="dv-advert-file" type="file" accept="image/*" hidden>
            </div>
          </div>
          <div id="dv-advert-prism-row" style="display:none">
            <div class="prop-row">
              <span class="prop-label">Face 1</span>
              <div class="prop-value" style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="action-btn" id="dv-advert-f0" type="button">Upload</button>
                <button class="action-btn" id="dv-advert-c0" type="button">Clear</button>
              </div>
            </div>
            <div class="prop-row">
              <span class="prop-label">Face 2</span>
              <div class="prop-value" style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="action-btn" id="dv-advert-f1" type="button">Upload</button>
                <button class="action-btn" id="dv-advert-c1" type="button">Clear</button>
              </div>
            </div>
            <div class="prop-row">
              <span class="prop-label">Face 3</span>
              <div class="prop-value" style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="action-btn" id="dv-advert-f2" type="button">Upload</button>
                <button class="action-btn" id="dv-advert-c2" type="button">Clear</button>
              </div>
            </div>
            <input id="dv-advert-prism-file" type="file" accept="image/*" hidden>
          </div>
          <div id="dv-led-display" style="display:none">
            <div class="prop-row">
              <span class="prop-label">LED source</span>
              <div class="prop-value">
                <select id="dv-led-source" class="dv-led-input">
                  <option value="chevron">Chevron</option>
                  <option value="text">Text marquee</option>
                  <option value="image">Image</option>
                </select>
              </div>
            </div>
            <div class="prop-row" id="dv-led-text-row" style="display:none">
              <span class="prop-label">Text</span>
              <div class="prop-value">
                <input id="dv-led-text" class="dv-led-input" type="text" spellcheck="false" placeholder="RACE  •  CHAMPIONS  •  ">
              </div>
            </div>
            <div class="prop-row" id="dv-led-image-row" style="display:none">
              <span class="prop-label" id="dv-led-image-label">Image</span>
              <div class="prop-value" style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="action-btn" id="dv-led-upload" type="button">Upload image</button>
                <button class="action-btn" id="dv-led-clear" type="button">Clear</button>
                <input id="dv-led-file" type="file" accept="image/*" hidden>
              </div>
            </div>
            <div class="prop-row" id="dv-led-speed-row" style="display:none">
              <span class="prop-label">Speed</span>
              <div class="prop-value">
                <input id="dv-led-speed" type="range" min="-1.5" max="1.5" step="0.01" value="0.4">
                <span class="prop-num" id="dv-led-speed-v">0.40</span>
              </div>
            </div>
            <div class="prop-row" id="dv-led-rgb-row" style="display:none">
              <span class="prop-label">RGB wall</span>
              <div class="prop-value">
                <button class="prop-toggle" id="dv-led-rgb" type="button" aria-label="RGB">${CHECK_SVG}</button>
              </div>
            </div>
          </div>
          <div id="dv-flag-prop" style="display:none">
            <div class="prop-row">
              <span class="prop-label" id="dv-flag-img-label">Flag image</span>
              <div class="prop-value" style="display:flex;gap:6px;flex-wrap:wrap">
                <button class="action-btn" id="dv-flag-img" type="button">Upload image</button>
                <button class="action-btn" id="dv-flag-clear" type="button">Clear</button>
                <input id="dv-flag-file" type="file" accept="image/*" hidden>
              </div>
            </div>
            <div class="prop-row">
              <span class="prop-label">Flag colour</span>
              <div class="prop-value">
                <input type="color" id="dv-flag-color" />
              </div>
            </div>
            <div class="prop-row">
              <span class="prop-label">Flag wave</span>
              <div class="prop-value">
                <input type="range" id="dv-flag-amp" min="0" max="1.5" step="0.02" />
                <span class="prop-num" id="dv-flag-amp-v"></span>
              </div>
            </div>
            <div class="prop-row">
              <span class="prop-label">Flag speed</span>
              <div class="prop-value">
                <input type="range" id="dv-flag-speed" min="0" max="8" step="0.1" />
                <span class="prop-num" id="dv-flag-speed-v"></span>
              </div>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">All of this type</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-livery-random" type="button">Randomise</button>
            </div>
          </div>
          <div class="dv-hint">
            Colour is a <b>per-instance tint</b> and the decal is <b>one shared
            instanced quad</b> — neither is a second material, so forty
            containers in seven colours with logos are five draw calls rather
            than forty. Right-click a prop to select it, then click a swatch or
            press <b>C</b> (<b>Shift+C</b> to go back); <b>V</b> toggles the
            decal. Ad billboards take an uploaded image the same way; the prism
            board takes three, one per rotating face.             Both save with the track.
            <b>LED display</b> takes chevron, a text marquee, or an image; default
            chevrons stay instanced, authored faces do not.
            Right-click a <b>flag</b> to put an image on that one sheet (saves
            with the track), or tint it; wave is shared by every flag of that shape.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Grid snap</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Snap to grid</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-snap" type="button" aria-label="Snap to grid">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Show grid</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-grid" type="button" aria-label="Show grid">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cell size</span>
            <div class="prop-value">
              <input type="range" id="dv-snapstep" min="2" max="32" step="2" />
              <span class="prop-num" id="dv-snapstep-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Angle step</span>
            <div class="prop-value">
              <input type="range" id="dv-snapyaw" min="5" max="90" step="5" />
              <span class="prop-num" id="dv-snapyaw-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Snapping is what lets two separately-built chains <b>meet</b> — needed
            to close a circuit. Anchors land on grid cells; the gizmo drags in
            steps too.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Gap / jump</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Arc preview</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-gap" type="button" aria-label="Gap preview">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Launch speed</span>
            <div class="prop-value">
              <input type="range" id="dv-refspd" min="8" max="60" step="1" />
              <span class="prop-num" id="dv-refspd-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Landing drop</span>
            <div class="prop-value">
              <input type="range" id="dv-drop" min="0" max="80" step="1" />
              <span class="prop-num" id="dv-drop-v"></span>
            </div>
          </div>
          <button class="action-btn primary" id="dv-snap-landing" type="button">Snap landing → new chain</button>
          <button class="action-btn" id="dv-gap-to-landing" type="button">Size the Gap piece to this jump</button>
          <div class="dv-hint">
            The red arc is where a jump at <b>launch speed</b> lands (green ring).
            <b>Snap landing</b> starts a new chain there, heading down-arc — then
            place a landing / dive piece to catch the car. Both buttons solve the
            arc on demand, so they work whether or not the preview is ticked.
            <br><br>
            <b>Size the Gap</b> measures the same jump and sets the Gap piece to
            match, keeping everything in ONE chain — good for a hole you fly
            straight over. It declines if the car lands off to one side, because
            a gap can only run straight on; use <b>Snap landing</b> for those.
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
          <!-- Temporary home for the old bottom shortcut bar — a proper menu later. -->
          <div id="hint" data-mode="build">
            <span class="hint-build">
              <b>B</b> test drive · <b>MMB</b> orbit · <b>RMB</b> pan ·
              <b>.</b> orbit selection · <b>LMB</b> gizmo / place ·
              <b>Enter</b> place · <b>Backspace</b> undo
            </span>
            <span class="hint-drive">
              <b data-keys="KeyB">B</b> build · <b data-keys="KeyW,KeyA,KeyS,KeyD">WASD</b>/<b>Arrows</b> drive ·
              <b>Space</b> handbrake · <b data-keys="KeyR">R</b> respawn · <b data-keys="KeyH">H</b> headlights ·
              <b data-keys="KeyC">C</b> debug cam
              <br>in air: <b>Shift</b>/<b>Ctrl</b> flip · <b data-keys="KeyZ">Z</b>/<b data-keys="KeyX">X</b> roll · <b data-keys="KeyQ">Q</b>/<b data-keys="KeyE">E</b> spin
            </span>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Spawn</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Source</span>
            <div class="prop-value"><span class="prop-num" id="dv-spawn-src">.v3proj / origin</span></div>
          </div>
          <button class="action-btn primary" id="dv-spawn-road" type="button">Place car on road</button>
          <button class="action-btn primary" id="dv-spawn-ground" type="button">Place car on ground</button>
          <button class="action-btn" id="dv-spawn-car" type="button">Set to car position</button>
          <button class="action-btn" id="dv-spawn-clear" type="button">Clear (use .v3proj)</button>
          <div class="dv-hint">
            <b>Place car</b> arms a ghost of the car that follows your cursor —
            <kbd>LMB</kbd> to drop it, <kbd>Q</kbd>/<kbd>E</kbd> to turn it,
            <kbd>Esc</kbd> or <kbd>RMB</kbd> to cancel. <b>On road</b> rides the
            track only (the ghost turns red off it and will not place);
            <b>on ground</b> rides the terrain, so you can start off-track or under
            an elevated section. Left alone the ghost aims itself down-track off
            whatever piece it is on; Q/E take that over.
            <br><br>
            A dimmer car silhouette in a ring marks the current spawn while
            building. <b>Set to car position</b> pins wherever the car is right
            now — one click, no mode switch, no hunting for the spot in the build
            camera, which is the fast way to restart from a section you are
            iterating on mid-test-drive.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Race</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Fall respawn</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-respawn-on" type="button" aria-label="Fall respawn">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Race ghost</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-race-ghost" type="button" aria-label="Race ghost">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Best time</span>
            <div class="prop-value"><span class="prop-num" id="dv-best">--:--.---</span></div>
          </div>
          <button class="action-btn" id="dv-clear-rec" type="button">Clear record + ghost</button>
          <div class="dv-hint">
            Place rounded <b>Start</b> + <b>Finish</b> to enable the clock
            (any chains — jumps / new chains are fine). Checkpoints are
            optional ordered splits. A course turns on last-safe fall
            (clock keeps running): a drop onto lower track still lands, empty
            sky retries from the last grounded pose. The toggle here forces
            that even without a course. Open start/finish pieces are for a
            later circuit mode.
            <br><br>
            <b>Race ghost</b> hides the replay car without wiping the record
            (recording still runs so a new best still saves).
          </div>
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
            <span class="prop-label">Car below centre</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-below" min="0" max="30" step="0.5" />
              <span class="prop-num" id="dv-cam-below-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">FOV</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-fovbase" min="40" max="90" step="1" />
              <span class="prop-num" id="dv-cam-fovbase-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Speed FOV</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-fov" min="0" max="30" step="1" />
              <span class="prop-num" id="dv-cam-fov-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Full kick at</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-fovref" min="5" max="80" step="1" />
              <span class="prop-num" id="dv-cam-fovref-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">FOV ease</span>
            <div class="prop-value">
              <input type="range" id="dv-cam-fovlerp" min="0.5" max="12" step="0.1" />
              <span class="prop-num" id="dv-cam-fovlerp-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Free look</b> hands the camera to orbit while driving (MMB rotate,
            RMB pan) — useful for inspecting the car mid-run. <b>FOV</b> is the
            resting lens. <b>Speed FOV</b> is how many extra degrees it widens
            once you hit <b>Full kick at</b> (0 = static). <b>FOV ease</b> is how
            quickly that kick arrives — lower is slower; twitchy FOV reads as
            nausea. The debug orbit (C) stays pinned at 60° on purpose.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Camera frame</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Heading ease</span>
            <div class="prop-value">
              <input type="range" id="dv-headinglerp" min="1" max="12" step="0.5" />
              <span class="prop-num" id="dv-headinglerp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Road ease</span>
            <div class="prop-value">
              <input type="range" id="dv-uplerp" min="1" max="12" step="0.5" />
              <span class="prop-num" id="dv-uplerp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Smoothing</span>
            <div class="prop-value">
              <input type="range" id="dv-boomsmooth" min="0.05" max="0.6" step="0.01" />
              <span class="prop-num" id="dv-boomsmooth-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max elevation</span>
            <div class="prop-value">
              <input type="range" id="dv-poleguard" min="30" max="78" step="1" />
              <span class="prop-num" id="dv-poleguard-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            The camera aims straight <i>at</i> the car and then tilts its axis up,
            so <b>Car below centre</b> is the only thing that can move the car on
            screen — Distance and Height change where you watch <i>from</i>, never
            where the car lands. The horizon is taken level every frame, so
            <b>the camera never rolls</b>: through a loop or a tube the car turns
            over on screen and the view stays put.
            <b>Smoothing</b> is the boom's critically-damped time constant: higher
            is lazier and more cinematic, lower is tighter. Past about 0.35 s the
            boom lags far enough through a violent reversal (a quarterpipe lip)
            that the camera can end up in front of the car.
            <b>Max elevation</b> caps how far the camera may swing above or below
            the car. Keep it under about 78° — past that the view approaches
            straight down, where "level" has no answer and the horizon flips.
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
          <div class="prop-row">
            <span class="prop-label">Wheels</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-wheels" type="button">Procedural</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Chassis</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-chassis" type="button">Procedural</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Track width</span>
            <div class="prop-value">
              <input type="range" id="dv-track" min="0.70" max="1.15" step="0.01" />
              <span class="prop-num" id="dv-track-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fit scale</span>
            <div class="prop-value">
              <input type="range" id="dv-ch-scale" min="0.80" max="1.30" step="0.005" />
              <span class="prop-num" id="dv-ch-scale-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fit X</span>
            <div class="prop-value">
              <input type="range" id="dv-ch-x" min="-0.30" max="0.30" step="0.005" />
              <span class="prop-num" id="dv-ch-x-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fit Y (height)</span>
            <div class="prop-value">
              <input type="range" id="dv-ch-y" min="-1.10" max="-0.10" step="0.005" />
              <span class="prop-num" id="dv-ch-y-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fit Z (fore/aft)</span>
            <div class="prop-value">
              <input type="range" id="dv-ch-z" min="-0.90" max="0.50" step="0.005" />
              <span class="prop-num" id="dv-ch-z-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fit</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-ch-reset" type="button">Reset fit</button>
              <button class="action-btn" id="dv-ch-log" type="button">Log values</button>
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
              <input type="range" id="dv-steer" min="0.15" max="1.2" step="0.01" />
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
        <div class="section-header">Car — Steering feel</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Turn-in rate</span>
            <div class="prop-value">
              <input type="range" id="dv-st-attack" min="1" max="30" step="0.5" />
              <span class="prop-num" id="dv-st-attack-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Return rate</span>
            <div class="prop-value">
              <input type="range" id="dv-st-release" min="1" max="40" step="0.5" />
              <span class="prop-num" id="dv-st-release-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Countersteer</span>
            <div class="prop-value">
              <input type="range" id="dv-st-counter" min="1" max="50" step="0.5" />
              <span class="prop-num" id="dv-st-counter-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Weight at speed</span>
            <div class="prop-value">
              <input type="range" id="dv-st-drop" min="0" max="0.8" step="0.05" />
              <span class="prop-num" id="dv-st-drop-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Stick filter</span>
            <div class="prop-value">
              <input type="range" id="dv-st-analog" min="5" max="60" step="1" />
              <span class="prop-num" id="dv-st-analog-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Keyboard steering is a ramp, and its shape IS the feel. Higher =
            faster. <b>Countersteer</b> is the rate used when you flick the
            opposite way mid-slide — keep it the fastest of the three.
            <b>Stick filter</b> only applies to a gamepad stick.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Landing &amp; body</div>
        <div class="section-body">
          <!-- WHEEL TRAVEL (visual only — physics compression is unclamped).
               The bump stop is now the arch-gap TARGET rather than a floor on
               the wheel: "Body rides bumps" decides who gives way when there is
               not enough travel — the body (1) or the tyre (0). -->
          <div class="prop-row">
            <span class="prop-label">Wheel bump stop</span>
            <div class="prop-value">
              <input type="range" id="dv-susp-bump" min="0" max="0.16" step="0.005" />
              <span class="prop-num" id="dv-susp-bump-v"></span>
            </div>
          </div>
          <!-- 1 = the wheel always sits on the surface and the BODY lifts to
               keep the arch clear (a floor on the wheel can only push it DOWN,
               into the road). 0 = the old clamp, for an A/B. -->
          <div class="prop-row">
            <span class="prop-label">Body rides bumps</span>
            <div class="prop-value">
              <input type="range" id="dv-susp-archlift" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-susp-archlift-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wheel droop stop</span>
            <div class="prop-value">
              <input type="range" id="dv-susp-droop" min="0.05" max="0.5" step="0.01" />
              <span class="prop-num" id="dv-susp-droop-v"></span>
            </div>
          </div>
          <!-- Drift counter-steer LOOK. Deadband is the slip angle at which the
               front wheels start pointing down the road instead of into the
               corner; too low and ordinary cornering shows opposite lock. -->
          <div class="prop-row">
            <span class="prop-label">Countersteer look</span>
            <div class="prop-value">
              <input type="range" id="dv-cs-gain" min="0" max="1.5" step="0.05" />
              <span class="prop-num" id="dv-cs-gain-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Countersteer from</span>
            <div class="prop-value">
              <input type="range" id="dv-cs-dead" min="0" max="0.7" step="0.01" />
              <span class="prop-num" id="dv-cs-dead-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max visual steer</span>
            <div class="prop-value">
              <input type="range" id="dv-cs-max" min="0.2" max="1.2" step="0.05" />
              <span class="prop-num" id="dv-cs-max-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Landing absorb</span>
            <div class="prop-value">
              <input type="range" id="dv-land-absorb" min="0" max="0.95" step="0.05" />
              <span class="prop-num" id="dv-land-absorb-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Land assist</span>
            <div class="prop-value">
              <input type="range" id="dv-land-assist" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-land-assist-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Assist range</span>
            <div class="prop-value">
              <input type="range" id="dv-land-range" min="2" max="40" step="1" />
              <span class="prop-num" id="dv-land-range-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Assist window</span>
            <div class="prop-value">
              <input type="range" id="dv-land-time" min="0.1" max="2.5" step="0.05" />
              <span class="prop-num" id="dv-land-time-v"></span>
            </div>
          </div>
          <!-- 0 = the assist levels ROLL only and leaves the nose down, so the
               car lands front-first. 1 = the old behaviour, which flattened the
               car in the last few metres. -->
          <div class="prop-row">
            <span class="prop-label">Assist levels pitch</span>
            <div class="prop-value">
              <input type="range" id="dv-land-pitch" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-land-pitch-v"></span>
            </div>
          </div>
          <!-- How much of the assist a held roll input switches off. At 0 the
               assist out-torques the player and the car will not roll. -->
          <div class="prop-row">
            <span class="prop-label">Assist yields to roll</span>
            <div class="prop-value">
              <input type="range" id="dv-land-yield" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-land-yield-v"></span>
            </div>
          </div>
          <!-- THE NEED GATE — how wrong the landing has to be before the assist
               acts at all. Raising the deadband makes the car feel less
               "magnetic" on ordinary jumps; at 0 the assist is back to firing on
               every landing whatever the attitude. -->
          <div class="prop-row">
            <span class="prop-label">Assist deadband</span>
            <div class="prop-value">
              <input type="range" id="dv-land-errdead" min="0" max="0.6" step="0.01" />
              <span class="prop-num" id="dv-land-errdead-v"></span>
            </div>
          </div>
          <!-- Roll error at which the assist reaches full authority. -->
          <div class="prop-row">
            <span class="prop-label">Assist full at</span>
            <div class="prop-value">
              <input type="range" id="dv-land-errfull" min="0.05" max="1.2" step="0.01" />
              <span class="prop-num" id="dv-land-errfull-v"></span>
            </div>
          </div>
          <!-- Roll RATE that arms the assist regardless of attitude — this is
               what keeps barrel rolls covered, since a rolling car sweeps back
               through level twice per rotation. -->
          <div class="prop-row">
            <span class="prop-label">Assist roll-rate arm</span>
            <div class="prop-value">
              <input type="range" id="dv-land-ratedead" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-land-ratedead-v"></span>
            </div>
          </div>
          <!-- Fraction of the flight-path angle the nose tracks in the air:
               higher = more nose-down through a jump. -->
          <div class="prop-row">
            <span class="prop-label">Arc follow amount</span>
            <div class="prop-value">
              <input type="range" id="dv-air-arcfrac" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-air-arcfrac-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Body roll</span>
            <div class="prop-value">
              <input type="range" id="dv-lean-roll" min="0" max="0.3" step="0.01" />
              <span class="prop-num" id="dv-lean-roll-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Body pitch</span>
            <div class="prop-value">
              <input type="range" id="dv-lean-pitch" min="0" max="0.3" step="0.01" />
              <span class="prop-num" id="dv-lean-pitch-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Landing absorb</b> eats the impact so a hard landing doesn't pogo.
            <b>Land assist</b> eases the car level with whatever it's about to hit
            during the last few metres of a fall — <b>range</b> is how early it
            starts. Body roll/pitch are purely visual lean (degrees per g); they
            do not affect handling.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Wall response</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Contact skin</span>
            <div class="prop-value">
              <input type="range" id="dv-wall-skin" min="0.02" max="0.5" step="0.01" />
              <span class="prop-num" id="dv-wall-skin-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Hit spin</span>
            <div class="prop-value">
              <input type="range" id="dv-wall-spin" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-wall-spin-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Chassis hits are resolved by <b>projection</b> (move out of the
            surface, kill the inward speed) rather than springs, so they can't
            store energy and launch the car. <b>Contact skin</b> is how far the
            collider sits outside the visible body — keep it small or the car
            floats off geometry and shape stops mattering. <b>Hit spin</b> is how
            much an off-centre hit turns the car.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Yaw assist</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Assist</span>
            <div class="prop-value">
              <input type="range" id="dv-yaw" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-yaw-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Align torque</span>
            <div class="prop-value">
              <input type="range" id="dv-yaw-align" min="0" max="40000" step="500" />
              <span class="prop-num" id="dv-yaw-align-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max slip</span>
            <div class="prop-value">
              <input type="range" id="dv-yaw-slip" min="0.15" max="1.4" step="0.01" />
              <span class="prop-num" id="dv-yaw-slip-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Yaw damping</span>
            <div class="prop-value">
              <input type="range" id="dv-yaw-damp" min="0" max="15000" step="250" />
              <span class="prop-num" id="dv-yaw-damp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drift release</span>
            <div class="prop-value">
              <input type="range" id="dv-yaw-drift" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-yaw-drift-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Keeps the slip angle drivable — the tire model has no yaw damping of
            its own. <b>Assist 0</b> = raw tire sim. <b>Max slip</b> is how far
            the car may rotate before the clamp bites; <b>drift release</b> is how
            much assist survives while the handbrake is down (0 = none).
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Car — Air control</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Flip rate</span>
            <div class="prop-value">
              <input type="range" id="dv-air-pitch" min="0" max="10" step="0.2" />
              <span class="prop-num" id="dv-air-pitch-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Roll rate</span>
            <div class="prop-value">
              <input type="range" id="dv-air-roll" min="0" max="10" step="0.2" />
              <span class="prop-num" id="dv-air-roll-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spin rate</span>
            <div class="prop-value">
              <input type="range" id="dv-air-yaw" min="0" max="10" step="0.2" />
              <span class="prop-num" id="dv-air-yaw-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Response</span>
            <div class="prop-value">
              <input type="range" id="dv-air-resp" min="1" max="25" step="0.5" />
              <span class="prop-num" id="dv-air-resp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Flip softness</span>
            <div class="prop-value">
              <input type="range" id="dv-air-presp" min="1" max="25" step="0.5" />
              <span class="prop-num" id="dv-air-presp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bounce lockout</span>
            <div class="prop-value">
              <input type="range" id="dv-air-lock" min="0" max="1.5" step="0.05" />
              <span class="prop-num" id="dv-air-lock-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Nose follows arc</span>
            <div class="prop-value">
              <input type="range" id="dv-air-arc" min="0" max="6" step="0.1" />
              <span class="prop-num" id="dv-air-arc-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Air control is <b>rate-based</b>: hold a direction and the car rotates
            at that many rad/s, release and it stops — so the same input always
            does the same thing. <b>Response</b> is how fast it reaches the rate
            (higher = snappier). <b>Bounce lockout</b> is how long after touching
            down before air control re-arms; a landing bounce is not a trick, and
            without it holding steer through a bounce rolls the car over.
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
        <div class="section-header">Car — Road hold</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Hold slopes</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-hold-on" type="button">On</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Crest float</span>
            <div class="prop-value">
              <input type="range" id="dv-hold-floor" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-hold-floor-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Snap back</span>
            <div class="prop-value">
              <input type="range" id="dv-hold-corr" min="0" max="30" step="1" />
              <span class="prop-num" id="dv-hold-corr-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ceiling</span>
            <div class="prop-value">
              <input type="range" id="dv-hold-g" min="0" max="20" step="0.5" />
              <span class="prop-num" id="dv-hold-g-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            On slopes, crests, grades and banks the car <b>supplies the
            centripetal force the curve needs</b> so it tracks the road instead of
            flying off it — without it a 30 m hill that climbs 10 m launches above
            ~65 km/h, because following that curve at speed takes several g and
            gravity brings one. Ramps (jump, dive, gap, quarterpipes) are excluded
            and launch exactly as before.<br /><br />
            <b>Crest float</b> is the tyre load left under the car at the top of a
            brow: <i>low</i> = it goes properly light over crests (0 = weightless,
            and grip goes with it), <i>high</i> = planted, and at 1 it reads as a
            magnet. <b>Snap back</b> is how hard the car is put back when it does
            fall behind the road — turn this down first if crests feel too glued.
            <b>Ceiling</b> caps the assist in car weights; geometry needing more
            still launches, which is what keeps <i>Hill Jump</i> a jump. Ceiling 0
            gives the old car back.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Edit piece</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Selected</span>
            <div class="prop-value"><span class="prop-num" id="dv-sel-piece">none</span></div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tilt</span>
            <div class="prop-value"><span class="prop-num" id="dv-sel-tilt">level</span></div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Placement</span>
            <div class="prop-value"><span class="prop-num" id="dv-sel-attach">—</span></div>
          </div>
          <button class="action-btn" id="dv-piece-detach" type="button">Detach from chain</button>
          <button class="action-btn" id="dv-piece-edges" type="button">Edges: on</button>
          <button class="action-btn" id="dv-piece-level" type="button">Level tilt (L)</button>
          <button class="action-btn" id="dv-piece-gap" type="button">Make empty space</button>
          <button class="action-btn" id="dv-piece-replace" type="button">Replace with active (Enter)</button>
          <button class="action-btn" id="dv-piece-insert" type="button">Insert active before (I)</button>
          <button class="action-btn" id="dv-piece-delete" type="button">Delete (Del)</button>
          <div class="dv-hint">
            <b>Right-click</b> a placed piece to select it (Esc to deselect), then
            <b>W</b> move / <b>E</b> rotate with the gizmo.
            <br><br>
            <b>Chained</b> (default): the piece takes its position from the one
            before it. Rotating it <b>tilts</b> it and everything after — that's
            how you bank a landing strip. <b>Free</b> (after a move, or via
            Detach): the piece keeps its own position and rotates on its own, and
            nothing else moves. <b>Re-attach</b> snaps it back onto the chain.
            <br><br>
            <b>Edges</b> is per piece. <b>L</b> levels tilt. <b>Make empty space</b>
            turns it into a jump gap (still selectable — replace to fill it back).
            Replace / insert / delete re-flow the chain to fit.
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
            <span class="prop-label">Road lines</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-lines" type="button" aria-label="Road lines">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">· Centre dashes</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-lines-center" type="button" aria-label="Centre dashes">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">· Edge lines</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-lines-edge" type="button" aria-label="Edge lines">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">· Lines bloom</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-lines-bloom" type="button" aria-label="Lines bloom">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Asphalt dark</span>
            <div class="prop-value">
              <input type="color" id="dv-road-dark" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Asphalt light</span>
            <div class="prop-value">
              <input type="color" id="dv-road-light" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Side colour</span>
            <div class="prop-value">
              <input type="color" id="dv-road-side" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Kerb colour</span>
            <div class="prop-value">
              <input type="color" id="dv-road-kerb" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Road brightness</span>
            <div class="prop-value">
              <input type="range" id="dv-road-bright" min="0.2" max="5" step="0.05" />
              <span class="prop-num" id="dv-road-bright-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Grain contrast</span>
            <div class="prop-value">
              <input type="range" id="dv-road-grain" min="0" max="2.5" step="0.05" />
              <span class="prop-num" id="dv-road-grain-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Aggregate</span>
            <div class="prop-value">
              <input type="range" id="dv-road-agg" min="0.5" max="20" step="0.5" />
              <span class="prop-num" id="dv-road-agg-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Gloss variation</span>
            <div class="prop-value">
              <input type="range" id="dv-road-rvary" min="0" max="0.4" step="0.01" />
              <span class="prop-num" id="dv-road-rvary-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wheel polish</span>
            <div class="prop-value">
              <input type="range" id="dv-road-polish" min="0" max="0.6" step="0.02" />
              <span class="prop-num" id="dv-road-polish-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wheel darken</span>
            <div class="prop-value">
              <input type="range" id="dv-road-wdark" min="0" max="0.4" step="0.01" />
              <span class="prop-num" id="dv-road-wdark-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bump</span>
            <div class="prop-value">
              <input type="range" id="dv-road-bump" min="0" max="0.25" step="0.005" />
              <span class="prop-num" id="dv-road-bump-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Chip relief</span>
            <div class="prop-value">
              <input type="range" id="dv-road-chip" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-road-chip-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Chip size</span>
            <div class="prop-value">
              <input type="range" id="dv-road-chipscale" min="4" max="40" step="1" />
              <span class="prop-num" id="dv-road-chipscale-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Chip fade</span>
            <div class="prop-value">
              <input type="range" id="dv-road-chipfade" min="0.5" max="6" step="0.1" />
              <span class="prop-num" id="dv-road-chipfade-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bump filter</span>
            <div class="prop-value">
              <input type="range" id="dv-road-bumpfilter" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-bumpfilter-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tar snakes</span>
            <div class="prop-value">
              <input type="range" id="dv-road-tarsnake" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-road-tarsnake-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Snake spacing</span>
            <div class="prop-value">
              <input type="range" id="dv-road-tarsnakescale" min="1" max="24" step="0.5" />
              <span class="prop-num" id="dv-road-tarsnakescale-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Snake width</span>
            <div class="prop-value">
              <input type="range" id="dv-road-tarsnakewidth" min="0.005" max="0.15" step="0.005" />
              <span class="prop-num" id="dv-road-tarsnakewidth-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Snake break-up</span>
            <div class="prop-value">
              <input type="range" id="dv-road-tarsnakebreak" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-tarsnakebreak-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Snake gloss</span>
            <div class="prop-value">
              <input type="range" id="dv-road-tarsnakegloss" min="0" max="0.8" step="0.02" />
              <span class="prop-num" id="dv-road-tarsnakegloss-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sealant colour</span>
            <div class="prop-value"><input type="color" id="dv-road-tarsnakecol" /></div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Old rubber</span>
            <div class="prop-value">
              <input type="range" id="dv-road-drift" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-road-drift-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rubber band width</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftw" min="0.05" max="1" step="0.02" />
              <span class="prop-num" id="dv-road-driftw-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rubber toward outside</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftbias" min="-1" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-driftbias-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Corner sensitivity</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftref" min="0.005" max="0.15" step="0.005" />
              <span class="prop-num" id="dv-road-driftref-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rubber streaks</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftlines" min="4" max="40" step="1" />
              <span class="prop-num" id="dv-road-driftlines-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rubber wander</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftwander" min="0" max="6" step="0.1" />
              <span class="prop-num" id="dv-road-driftwander-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rubber wander scale</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftwscale" min="0.001" max="0.06" step="0.001" />
              <span class="prop-num" id="dv-road-driftwscale-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rubber gloss</span>
            <div class="prop-value">
              <input type="range" id="dv-road-driftgloss" min="0" max="0.6" step="0.02" />
              <span class="prop-num" id="dv-road-driftgloss-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Anisotropy</span>
            <div class="prop-value">
              <input type="range" id="dv-road-aniso" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-road-aniso-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Aniso angle</span>
            <div class="prop-value">
              <input type="range" id="dv-road-anisoang" min="-90" max="90" step="5" />
              <span class="prop-num" id="dv-road-anisoang-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Aniso in wheel paths</span>
            <div class="prop-value">
              <input type="range" id="dv-road-anisowheel" min="0" max="3" step="0.1" />
              <span class="prop-num" id="dv-road-anisowheel-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Aniso killed by water</span>
            <div class="prop-value">
              <input type="range" id="dv-road-anisowet" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-anisowet-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Grit (close-up)</span>
            <div class="prop-value">
              <input type="range" id="dv-road-grit" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-road-grit-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Line relief</span>
            <div class="prop-value">
              <input type="range" id="dv-road-linebump" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-road-linebump-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Line fill</span>
            <div class="prop-value">
              <input type="range" id="dv-road-linefill" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-linefill-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Line roughness</span>
            <div class="prop-value">
              <input type="range" id="dv-road-linerough" min="0.05" max="1" step="0.02" />
              <span class="prop-num" id="dv-road-linerough-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Line wetness</span>
            <div class="prop-value">
              <input type="range" id="dv-road-linewet" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-linewet-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Line gloss (wet)</span>
            <div class="prop-value">
              <input type="range" id="dv-road-linecoat" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-road-linecoat-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Streak sharpness</span>
            <div class="prop-value">
              <input type="range" id="dv-road-streak" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-road-streak-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Paver joints</span>
            <div class="prop-value">
              <input type="range" id="dv-road-joints" min="0" max="24" step="1" />
              <span class="prop-num" id="dv-road-joints-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cheap deck (A/B)</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-road-cheap" type="button" aria-label="Cheap deck — no procedural surface"></button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">FrontSide</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-road-front" type="button" aria-label="FrontSide (cull back faces)">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rail metalness</span>
            <div class="prop-value">
              <input type="range" id="dv-rail-metal" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-rail-metal-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rail roughness</span>
            <div class="prop-value">
              <input type="range" id="dv-rail-rough" min="0.05" max="1" step="0.01" />
              <span class="prop-num" id="dv-rail-rough-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Asphalt is fully procedural — no textures, so no sampler slots and it
            tiles down a track of any length. <b>Asphalt dark / light</b> are the
            real levers for how light the deck reads; brightness only multiplies
            them. A mid-grey deck (~#6a7078 → #8a9098) keeps black tyres readable.
            <br><br>
            <b>Aggregate</b> is the chip size in cycles/metre (it self-fades before
            it aliases at distance). <b>Wheel polish</b> smooths the two tyre
            tracks; <b>Wheel darken</b> is the rubber deposit in those same paths
            — pull it down if the lanes look too black.
            <br><br>
            <b>Bump</b> is a micro-normal from the same noise (no extra samples).
            Zero compiles it out. Small values — this is race asphalt, not gravel.
            <br><br>
            <b>Chip relief</b> is the octave you can actually SEE from the chase
            camera. Measured: a pixel covers 7.9&nbsp;mm across the road under the
            car and 27&nbsp;mm at 20&nbsp;m ahead, so the resolvable band runs
            about 3–10&nbsp;cm. The old grit (1.8&nbsp;cm) is below it
            <i>everywhere</i> — the eye has to get within 6.3&nbsp;m and the boom
            is 8.2&nbsp;m, which is why it only ever showed in the labs — and the
            aggregate (20&nbsp;cm) is above it. This fills the gap.
            <b>Chip size</b> is cycles/metre across (16 ≈ 6&nbsp;cm, lower =
            bigger stones) and <b>Chip fade</b> is how fast it dies with distance
            (higher = sooner; raise it if the mid-distance crawls).
            <br><br>
            <b>Bump filter</b> spreads the three height taps to one pixel's width
            instead of a fixed 4&nbsp;mm, so the normal measures the average slope
            rather than point-sampling something finer than the pixel. It also
            gets the anisotropy for free — at 20&nbsp;m the taps are 8.7× wider
            along the road than across, so along-road relief decays on its own
            while transverse screed lines survive. Set it to 0 for the old
            fixed-spacing look. Note the 4&nbsp;mm floor only governs within
            ~4&nbsp;m, so the labs look unchanged and the game deck does not.
            <br><br>
            <b>Old rubber</b> is track history — marks laid down <i>before</i> you
            drove, not your own skids (those are a separate mesh). It is driven by
            <code>aCurve</code>, the signed curvature baked into each piece, so it
            concentrates in corners by itself and sits toward the corner's
            <i>outside</i> where cars run wide. <b>You will not see any of it on a
            straight</b> — the field is multiplied by curvature, so it is exactly
            zero there. Build a curve to judge it.
            <br><br>
            <b>Corner sensitivity</b> is the curvature at which the marks reach
            full strength, shown as the equivalent radius. <b>Rubber toward
            outside</b> is signed: negative moves the band to the inside line.
            <b>Rubber streaks</b> is how many parallel lines across the deck
            (~a tyre apart at 20) and <b>wander</b> stops them looking machined.
            <b>Rubber gloss</b> matters more than the darkness — rubber is
            glossier than asphalt, and at a grazing angle that sheen is what
            identifies it.
            <br><br>
            <b>Anisotropy</b> makes the deck rougher in one direction than the
            other, which is what a road physically is — tyres polish the
            aggregate along the direction of travel, the paver drags the mix the
            same way. Until now only the <i>albedo</i> knew that; this is the
            same claim reaching the specular lobe, where gloss is actually read.
            The tangent frame is free: three derives it from UV derivatives, and
            this deck's UV is already (metres along, metres across).
            <br><br>
            <b>Aniso angle</b> is a knob and not a constant because the two
            defensible answers disagree. Tyre polish says the surface is
            <i>smoother</i> along the road, putting the stretch across it (90°);
            the look people mean by "wet road at night" is a smear running away
            from you (0°). Much of that smear is really grazing-angle projection,
            which you already get for free — so this decides what the material
            adds on top. Sweep it and pick.
            <br><br>
            <b>Aniso in wheel paths</b> is the honest part: the two strips where
            tyres run are the polished ones. <b>Aniso killed by water</b> relaxes
            it toward isotropic as the film builds, since water fills the grooves.
            Note this affects the base lobe, <i>not</i> the clearcoat — three's
            coat is isotropic — so its reach is the dry and damp deck, not a
            puddle mirror. Zero compiles the whole anisotropic BRDF out; crossing
            0 rebuilds the material.
            <br><br>
            <b>Grit (close-up)</b> is the 1.8&nbsp;cm octave, and it ships
            <b>off</b> — not as a quality cut. It is faded to exactly zero on
            every pixel this camera can see (the eye must get within
            6.3&nbsp;m; the boom is 8.2&nbsp;m), so it was three noise
            evaluations per fragment returning a certain zero. The labs keep it,
            because their cameras are inside that range. Turn it on here if you
            add a bonnet or photo camera. Crossing 0 rebuilds the material.
            <br><br>
            Together with retiring the macro swell — 0.060° of normal tilt for a
            three-octave fractal per tap — the bump normal went from
            <b>18 noise evaluations per fragment to 6</b>.
            <code>node tools/roadBumpVisibilityTest.mjs</code> prints the whole
            table and the per-octave cost — run it before changing any of these
            scales.
            <br><br>
            <b>The paint is its own material</b> (needs <b>Road lines</b> on).
            Marking is a thermoplastic band laid <i>on</i> the asphalt, so it
            gets its own everything: <b>Line fill</b> is how far it smooths the
            aggregate underneath (this is the half that stops a line reading as
            chalk), <b>Line relief</b> lifts it a couple of millimetres proud so
            the lip catches a low sun, and <b>Line roughness</b> is its dry
            gloss. Both relief knobs at 0 compiles the paint out of the bump.
            <br><br>
            <b>Line wetness</b> is low on purpose — paint is non-porous, so it
            barely darkens in the rain while the asphalt drops to about half.
            That contrast is why markings pop in the wet; push it to 1 and you
            delete the effect. <b>Line gloss (wet)</b> is the other side of the
            same coin: water sits <i>on</i> paint instead of soaking in, so a
            wet line is the most mirror-like thing on the road.
            <b>Streak sharpness</b> is off by default (the original meandering
            grain). Turn it up only if you want hard paver lines.
            <b>Paver joints</b> are grooves every N metres (0 = off). Leave them
            off unless you want saw-cuts across the deck — they read as seams.
            <br><br>
            <b>FrontSide</b> culls back faces. The slab already has an underside,
            so this is cheaper fill and cleaner shadows. Uncheck (DoubleSide) if
            looking into an open piece end shows a hole, or to A/B the old look.
            <br><br>
            <b>Rail metalness</b> near 1 means the rail has no diffuse at all and
            only shows reflections of the sky — which is why it looked black. Pull
            it down to let sunlight hit it.
          </div>
          <div class="prop-row">
            <span class="prop-label">Show colliders</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-showcol" type="button" aria-label="Show colliders">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-hint">
            Wireframes of what the car ACTUALLY collides with, which is not always
            what you can see. Pair it with the debug orbit cam (<b>C</b>) to watch a
            contact happen from outside the car.
            <br><br>
            <b style="color:#ff5060">red</b> road decks (wheels probe these) &middot;
            <b style="color:#5080ff">blue</b> guardrails and tunnel shells (chassis
            only) &middot; <b style="color:#ffe14a">yellow</b> the car's collision
            BOX &mdash; the bodywork you see is only a look &middot;
            <b style="color:#4ad2ff">cyan</b> the four tyres &middot;
            <b style="color:#ff8a3d">orange</b> moving platforms and walls &middot;
            <b style="color:#9dff5a">green</b> simulated props: the cone's SPHERE
            proxy and the swing gate's panel, which is what the sim uses rather
            than the mesh.
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
          <button class="action-btn" id="dv-rebake-thumbs" type="button">Rebake palette thumbnails</button>
          <div class="dv-hint">
            Palette tiles are baked once and cached in the browser (IndexedDB), so
            reloading does not pay for ~175 renders again. The cache invalidates
            itself when a piece, a preset or the road look changes — but it cannot
            see edits to the geometry <i>code</i>, so use this after changing how a
            piece is built.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">World light</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Time of day</span>
            <div class="prop-value">
              <input type="range" id="dv-tod" min="0" max="24" step="0.1" />
              <span class="prop-num" id="dv-tod-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Exposure</span>
            <div class="prop-value">
              <input type="range" id="dv-exposure" min="0.1" max="3" step="0.02" />
              <span class="prop-num" id="dv-exposure-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sun intensity</span>
            <div class="prop-value">
              <input type="range" id="dv-sun-int" min="0" max="6" step="0.05" />
              <span class="prop-num" id="dv-sun-int-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky fill (hemi)</span>
            <div class="prop-value">
              <input type="range" id="dv-hemi" min="0" max="2" step="0.02" />
              <span class="prop-num" id="dv-hemi-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ambient (env)</span>
            <div class="prop-value">
              <input type="range" id="dv-env" min="0" max="2" step="0.02" />
              <span class="prop-num" id="dv-env-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky blue (rayleigh)</span>
            <div class="prop-value">
              <input type="range" id="dv-sky-ray" min="0" max="4" step="0.05" />
              <span class="prop-num" id="dv-sky-ray-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Haze (mie)</span>
            <div class="prop-value">
              <input type="range" id="dv-sky-mie" min="0" max="2" step="0.02" />
              <span class="prop-num" id="dv-sky-mie-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sun glow</span>
            <div class="prop-value">
              <input type="range" id="dv-sky-glow" min="0" max="1.5" step="0.02" />
              <span class="prop-num" id="dv-sky-glow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Light</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-light-log" type="button">Log values</button>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Lights</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Headlights</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-lights" type="button" aria-label="Headlights">${CHECK_SVG}</button>
              <span class="prop-num">H</span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Auto (by sun)</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-lights-auto" type="button" aria-label="Auto headlights">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Lamp glow</span>
            <div class="prop-value">
              <input type="range" id="dv-lamp" min="0" max="12" step="0.5" />
              <span class="prop-num" id="dv-lamp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Beam power</span>
            <div class="prop-value">
              <input type="range" id="dv-beam" min="0" max="60" step="1" />
              <span class="prop-num" id="dv-beam-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tail lights</span>
            <div class="prop-value">
              <input type="range" id="dv-tail-run" min="0" max="12" step="0.25" />
              <span class="prop-num" id="dv-tail-run-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Brake lights</span>
            <div class="prop-value">
              <input type="range" id="dv-tail-brake" min="0" max="24" step="0.5" />
              <span class="prop-num" id="dv-tail-brake-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Headlamp faces</span>
            <div class="prop-value">
              <input type="range" id="dv-glb-lamp" min="0" max="12" step="0.25" />
              <span class="prop-num" id="dv-glb-lamp-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Auto</b> switches them on when the v3 sun drops near the horizon.
            Lamps only glow with Bloom on.
            <br><br>
            <b>Tail</b> / <b>Brake</b> drive the GLB car's rear light bar. The
            model has ONE emissive rear node — despite being called
            <code>BRAKES_LEFT</code> it spans the full 1.73&nbsp;m, so it is both
            tail lights in one mesh and braking changes its brightness rather
            than its shape. Nothing is missing; what matters is the RATIO — a
            real stop lamp is roughly 3× its tail lamp.
            <br><br>
            Tail was 1.0 and sat under the bloom's reach while the brake cleared
            it easily, so the bar only ever glowed when braking. On a wet road
            these are the brightest thing behind you and both the deck's
            clearcoat and the planar mirror reflect them — most of the wet-night
            look is this slider.
        </div>
      </div>
      </div>  <!-- /Lights. THIS CLOSE WAS MISSING: without it Weather, Bloom, Audio and FX were children of Lights, so collapsing Lights hid all four. -->

      <div class="inspector-section">
        <div class="section-header">Sky</div>
        <div class="section-body">
          <div class="dv-hint">
            The game's own sky, kept side by side with the engine's so you can
            judge it. <b>F8</b> flips between them — same corner, same light, so
            the difference is the sky and nothing else. It is built the first
            time you switch it on and costs nothing until then.
            <b>Lighting does not change</b> with the switch: the track is still
            lit by the engine sky's environment map, on purpose, so only one
            thing differs at a time.
          </div>
          <div class="prop-row">
            <span class="prop-label">Game sky (F8)</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-gamesky" type="button" aria-label="Game sky">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Atmosphere</span>
            <div class="prop-value">
              <input type="range" id="dv-sky-atmo" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-sky-atmo-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            0 is the authored gradient, 1 is the physically-modelled atmosphere
            (Rayleigh, Mie and ozone through three LUTs). It is a crossfade, not
            a switch, so you can see which parts of the physical model you
            actually want. Stars, moon and cloud sea ride on both.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Clouds — Shape</div>
        <div class="section-body">
          <div class="dv-hint">
            Volumetric clouds you can fly through. Off costs nothing — no buffers,
            no passes. The first enable bakes noise in a worker (a few seconds, off
            the main thread), then the deck fades in.
            <b>Coverage is the fraction of sky covered</b> — a threshold on the
            weather field, so masses keep solid white cores at any setting: 0.9
            is honest overcast, 0.55 a lively broken-cumulus sky. Edge softness
            is the wispy skirt around each mass. Measured cost in an editor sky
            framing: <b>~1.0 ms</b>, holding 60 fps.
          </div>
          <div class="prop-row">
            <span class="prop-label">Quality</span>
            <div class="prop-value" style="gap:4px">
              <button class="action-btn dv-tier" data-tier="volumetric" type="button">Volumetric</button>
              <button class="action-btn dv-tier" data-tier="painted" type="button">Painted</button>
              <button class="action-btn dv-tier" data-tier="off" type="button">Off</button>
            </div>
          </div>
          <div class="dv-hint">
            <b>Quality is a machine setting, not track data</b> — it never rides in a
            save. <b>Painted</b> is the DEFAULT: a thin slab marched (18 steps) through
            one baked cloud map inside the sky dome's own shader, with planet curvature,
            ground shadows and a high cirrus layer — no render targets, no extra pass,
            no worker bake, <b>~0.29 ms</b>. <b>Volumetric</b> is the raymarched deck you
            can actually fly a car THROUGH (~1.07 ms) — the painted deck is
            camera-relative, so you can never get inside or above it, which is why the
            cloud-dive tracks want this tier. Switching rebuilds the sky
            (~0.7 s) because the painted deck is compiled in or out of the dome's
            shader rather than faded, so you never pay for the tier you are not on.
          </div>
          <div class="prop-row">
            <span class="prop-label">Clouds</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-clouds" type="button" aria-label="Volumetric clouds">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Coverage</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-cov" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-cld-cov-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">More / less</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-bias" min="-0.5" max="0.5" step="0.01" />
              <span class="prop-num" id="dv-cld-bias-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Edge softness</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-covsoft" min="0.02" max="0.4" step="0.01" />
              <span class="prop-num" id="dv-cld-covsoft-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Base height</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-base" min="60" max="1500" step="10" />
              <span class="prop-num" id="dv-cld-base-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Thickness</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-thick" min="100" max="2000" step="10" />
              <span class="prop-num" id="dv-cld-thick-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Density</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-dens" min="0.02" max="0.6" step="0.005" />
              <span class="prop-num" id="dv-cld-dens-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cumulus / stratus</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-type" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-cld-type-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Planet radius</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-planet" min="200" max="12000" step="50" />
              <span class="prop-num" id="dv-pc-planet-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Towering</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-topmin" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-cld-topmin-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Towering</b> is the shortest cloud as a fraction of the slab. At 1.0
            every cell fills the full thickness and you get a flat sheet — the
            spread between it and 1.0 IS the towering look.
          </div>
          <div class="prop-row">
            <span class="prop-label">Interior glow</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-msfloor" min="0" max="0.6" step="0.01" />
              <span class="prop-num" id="dv-pc-msfloor-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Evolve</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-evolve" min="0" max="0.15" step="0.002" />
              <span class="prop-num" id="dv-pc-evolve-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wind speed</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-wind" min="0" max="30" step="0.5" />
              <span class="prop-num" id="dv-cld-wind-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wind heading</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-winddeg" min="0" max="360" step="1" />
              <span class="prop-num" id="dv-cld-winddeg-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Clouds — Painted deck</div>
        <div class="section-body">
          <div class="dv-hint">
            These are the <b>Painted</b> tier's own controls and only do anything in
            that tier — every other slider in the CLOUDS group belongs to the
            volumetric deck. <b>Steps</b> is the quality/cost dial: the deck is a
            slab march, so cost scales with it almost linearly (18 ≈ 0.1 ms). Drop it
            to 8-10 on a weak machine; below that the slab starts to band.
          </div>
          <div class="prop-row">
            <span class="prop-label">Coverage</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cov" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-pc-cov-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Density</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-den" min="0.01" max="0.12" step="0.002" />
              <span class="prop-num" id="dv-pc-den-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Erosion</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-erode" min="0" max="1.2" step="0.02" />
              <span class="prop-num" id="dv-pc-erode-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Base altitude</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-alt" min="300" max="3000" step="25" />
              <span class="prop-num" id="dv-pc-alt-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Thickness</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-thick" min="200" max="2000" step="25" />
              <span class="prop-num" id="dv-pc-thick-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cloud size</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-tile" min="1500" max="9000" step="100" />
              <span class="prop-num" id="dv-pc-tile-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Towering</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-topmin" min="0.05" max="1" step="0.01" />
              <span class="prop-num" id="dv-pc-topmin-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Steps (cost)</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-steps" min="6" max="24" step="1" />
              <span class="prop-num" id="dv-pc-steps-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sun strength</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-sun" min="0.5" max="4" step="0.05" />
              <span class="prop-num" id="dv-pc-sun-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky ambient</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-amb" min="0" max="1.5" step="0.02" />
              <span class="prop-num" id="dv-pc-amb-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Base darkness</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-basedark" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-pc-basedark-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Shadow depth</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-absorb" min="0" max="6" step="0.1" />
              <span class="prop-num" id="dv-pc-absorb-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Silver lining</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-silver" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-pc-silver-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Aerial fade</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-aerial" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-pc-aerial-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>High cirrus</b> is the second layer, and the depth cue: one deck
            gives the eye a single distance and reads as a ceiling, two at very
            different altitudes give it parallax. It is a flat sheet, which here
            is correct rather than a compromise — cirrus is optically thin and
            always seen from far below, so it has no thickness to miss. Two
            fetches, no march.
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus amount</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirrus" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-pc-cirrus-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus coverage</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirruscov" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-pc-cirruscov-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus altitude</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirrusalt" min="3000" max="14000" step="250" />
              <span class="prop-num" id="dv-pc-cirrusalt-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus size</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirrustile" min="4000" max="40000" step="500" />
              <span class="prop-num" id="dv-pc-cirrustile-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus streak</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirrusstretch" min="1" max="12" step="0.1" />
              <span class="prop-num" id="dv-pc-cirrusstretch-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus swirl</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirrusswirl" min="0" max="2.5" step="0.05" />
              <span class="prop-num" id="dv-pc-cirrusswirl-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Cirrus glow</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-cirrussilver" min="0" max="4" step="0.05" />
              <span class="prop-num" id="dv-pc-cirrussilver-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">God rays</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-rays" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-pc-rays-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ray length</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-raylen" min="0.1" max="1" step="0.02" />
              <span class="prop-num" id="dv-pc-raylen-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ray tightness</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-raytight" min="4" max="40" step="0.5" />
              <span class="prop-num" id="dv-pc-raytight-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ray steps</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-raysteps" min="6" max="24" step="1" />
              <span class="prop-num" id="dv-pc-raysteps-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ground shadows</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-shadow" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-pc-shadow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Shadow softness</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-shadowsoft" min="0.05" max="1" step="0.01" />
              <span class="prop-num" id="dv-pc-shadowsoft-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wind speed</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-wind" min="0" max="40" step="0.5" />
              <span class="prop-num" id="dv-pc-wind-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wind heading</span>
            <div class="prop-value">
              <input type="range" id="dv-pc-winddeg" min="0" max="360" step="1" />
              <span class="prop-num" id="dv-pc-winddeg-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Clouds — Lighting</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Sun into cloud</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-sun" min="0" max="8" step="0.1" />
              <span class="prop-num" id="dv-cld-sun-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky ambient</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-amb" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-cld-amb-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Forward scatter</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-g" min="0" max="0.9" step="0.01" />
              <span class="prop-num" id="dv-cld-g-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Powder (dark edge)</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-powder" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-cld-powder-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sky tint</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-tint" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-cld-tint-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            How much of the sky's colour the clouds take. 1 is exactly what the
            sky model says — but that model reddens the sun 85% toward orange as
            it sets, which is right for the sun DISC and far too strong as a
            light on a whole cloud deck. This mixes toward the same brightness in
            grey, so only the vividness changes: dawn stays as bright, night
            stays as dark.
          </div>
          <div class="prop-row">
            <span class="prop-label">Interior glow</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-msfloor" min="0" max="0.6" step="0.01" />
              <span class="prop-num" id="dv-cld-msfloor-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">God rays</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-rays" min="0" max="1.5" step="0.02" />
              <span class="prop-num" id="dv-cld-rays-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ground shadows</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-shadow" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-cld-shadow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Shadow softness</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-shadowsoft" min="0.02" max="0.25" step="0.005" />
              <span class="prop-num" id="dv-cld-shadowsoft-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Interior glow</b> is the multiple-scattering floor — the fraction of
            sun energy surviving as diffuse light deep inside a mass. At 0 you get
            physically-wrong dark blue interiors; this is what makes flying INTO a
            cloud a bright whiteout instead of dull fog.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Clouds — Quality</div>
        <div class="section-body">
          <div class="dv-hint">
            The performance knobs. <b>Resolution</b> is the big one — the march runs
            per cloud-buffer pixel, so it is roughly quadratic. 0.5 is half-res.
          </div>
          <div class="prop-row">
            <span class="prop-label">Resolution</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-buf" min="0.25" max="1" step="0.05" />
              <span class="prop-num" id="dv-cld-buf-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max steps</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-steps" min="40" max="256" step="4" />
              <span class="prop-num" id="dv-cld-steps-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Step ceiling</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-maxstep" min="8" max="60" step="1" />
              <span class="prop-num" id="dv-cld-maxstep-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Temporal blend</span>
            <div class="prop-value">
              <input type="range" id="dv-cld-hist" min="0" max="0.95" step="0.01" />
              <span class="prop-num" id="dv-cld-hist-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Step ceiling</b> is an aliasing control, not a look control: at 60 m
            the far field samples ~14 m cloud detail once every 50 m, which is the
            crosshatch speckle on distant edges. <b>Temporal blend</b> is the
            running average that cleans the march dither — 0 shows the raw march.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Aerial perspective</div>
        <div class="section-body">
          <div class="dv-hint">
            The air between you and the world. Not fog: it blends distant geometry
            toward <b>the colour of the sky in that direction</b> — pale at the
            horizon, deeper overhead, blazing toward the sun — which is what reads
            as distance rather than as weather. Runs in <b>every cloud tier</b>,
            including off, because it is atmosphere and not cloud. Haze 0 disables
            the pass entirely.
          </div>
          <div class="prop-row">
            <span class="prop-label">Haze</span>
            <div class="prop-value">
              <input type="range" id="dv-ap-density" min="0" max="0.0025" step="0.00005" />
              <span class="prop-num" id="dv-ap-density-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max haze</span>
            <div class="prop-value">
              <input type="range" id="dv-ap-max" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-ap-max-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Scale height</span>
            <div class="prop-value">
              <input type="range" id="dv-ap-scaleh" min="300" max="8000" step="100" />
              <span class="prop-num" id="dv-ap-scaleh-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sun glow</span>
            <div class="prop-value">
              <input type="range" id="dv-ap-glow" min="0" max="4" step="0.05" />
              <span class="prop-num" id="dv-ap-glow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Glow tightness</span>
            <div class="prop-value">
              <input type="range" id="dv-ap-glowpow" min="1" max="24" step="0.5" />
              <span class="prop-num" id="dv-ap-glowpow-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Sky weather</div>
        <div class="section-body">
          <div class="dv-hint">
            One preset moves clouds, haze and shadows <b>together</b>. A storm is not
            just more coverage — it is a thicker deck, darker bases, a weaker sun,
            denser haze and <i>softer</i> shadows, because a solid ceiling scatters
            light instead of casting it. Presets crossfade over ~6&nbsp;s rather than
            snapping, and the driver lets go of the values the moment a transition
            settles, so these sliders keep working afterwards. Drives the
            <b>painted</b> deck; the sun, the exposure and the rain are left alone.
          </div>
          <div class="prop-row">
            <span class="prop-label">Preset</span>
            <div class="prop-value" style="gap:4px;flex-wrap:wrap">
              <button class="action-btn dv-wx" data-wx="clear" type="button">Clear</button>
              <button class="action-btn dv-wx" data-wx="fair" type="button">Fair</button>
              <button class="action-btn dv-wx" data-wx="broken" type="button">Broken</button>
              <button class="action-btn dv-wx" data-wx="overcast" type="button">Overcast</button>
              <button class="action-btn dv-wx" data-wx="storm" type="button">Storm</button>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Weather</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Wetness</span>
            <div class="prop-value">
              <input type="range" id="dv-wet" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-wet-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Puddles</span>
            <div class="prop-value">
              <input type="range" id="dv-wet-puddle" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-wet-puddle-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Waterline</span>
            <div class="prop-value">
              <input type="range" id="dv-wet-waterline" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-wet-waterline-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Waterline tightness</span>
            <div class="prop-value">
              <input type="range" id="dv-wet-waterlinew" min="1" max="5" step="0.1" />
              <span class="prop-num" id="dv-wet-waterlinew-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Dry line</span>
            <div class="prop-value">
              <input type="range" id="dv-wet-wheel" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-wet-wheel-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Car reflection</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-reflect" type="button" aria-label="Car reflection">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rails in mirror</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-reflect-rails" type="button" aria-label="Guardrail reflection (mirrored geometry)">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Reflection strength</span>
            <div class="prop-value">
              <input type="range" id="dv-reflect-str" min="0" max="4" step="0.05" />
              <span class="prop-num" id="dv-reflect-str-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Rain</b> is droplets on the lens, drawn after the scene and before
            bloom — so a drop that magnifies a neon tube glows from where the
            drop put it. Off removes the pass entirely rather than fading it to
            zero, so a dry track pays nothing. It is independent of
            <b>Wetness</b>: rain can stop while the road stays soaked.
          </div>
          <div class="prop-row">
            <span class="prop-label">Rain</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-rain" type="button" aria-label="Rain on the lens">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rain amount</span>
            <div class="prop-value">
              <input type="range" id="dv-rain-amount" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-rain-amount-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drop density</span>
            <div class="prop-value">
              <input type="range" id="dv-rain-density" min="4" max="30" step="0.5" />
              <span class="prop-num" id="dv-rain-density-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drop size</span>
            <div class="prop-value">
              <input type="range" id="dv-rain-size" min="0.05" max="0.5" step="0.01" />
              <span class="prop-num" id="dv-rain-size-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drop blur</span>
            <div class="prop-value">
              <input type="range" id="dv-rain-blur" min="0" max="0.05" step="0.001" />
              <span class="prop-num" id="dv-rain-blur-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Runners</span>
            <div class="prop-value">
              <input type="range" id="dv-rain-runners" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-rain-runners-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Speed lean</span>
            <div class="prop-value">
              <input type="range" id="dv-rain-lean" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-rain-lean-v"></span>
            </div>
          </div>

          <div class="prop-row">
            <span class="prop-label">Reflection blur</span>
            <div class="prop-value">
              <input type="range" id="dv-reflect-blur" min="0" max="8" step="0.1" />
              <span class="prop-num" id="dv-reflect-blur-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Reflection smear</span>
            <div class="prop-value">
              <input type="range" id="dv-reflect-smear" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-reflect-smear-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Max error (m)</span>
            <div class="prop-value">
              <input type="range" id="dv-reflect-flat" min="0.05" max="4" step="0.05" />
              <span class="prop-num" id="dv-reflect-flat-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rail reflection</span>
            <div class="prop-value">
              <input type="range" id="dv-rail-reflect" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-rail-reflect-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Mirror slab (m)</span>
            <div class="prop-value">
              <input type="range" id="dv-reflect-slab" min="0.5" max="12" step="0.25" />
              <span class="prop-num" id="dv-reflect-slab-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Off-plane range (m)</span>
            <div class="prop-value">
              <input type="range" id="dv-reflect-plane" min="0.05" max="4" step="0.05" />
              <span class="prop-num" id="dv-reflect-plane-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Wet is a water <b>film</b> (darker, sheen) plus <b>puddles</b> (near-mirror
            in the gutters). The bump on the road is what stops the sheen looking
            like varnish — chips catch the sun through a thin film, then drown
            inside standing water. Turn bump up in Road look if a soaked deck
            still reads plastic.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Bloom</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Enabled</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-bloom" type="button" aria-label="Bloom">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Strength</span>
            <div class="prop-value">
              <input type="range" id="dv-bloom-str" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-bloom-str-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Radius</span>
            <div class="prop-value">
              <input type="range" id="dv-bloom-rad" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-bloom-rad-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Glow prop power</span>
            <div class="prop-value">
              <input type="range" id="dv-glow" min="0" max="20" step="0.5" />
              <span class="prop-num" id="dv-glow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Threshold</span>
            <div class="prop-value">
              <input type="range" id="dv-bloom-thr" min="0" max="2" step="0.01" />
              <span class="prop-num" id="dv-bloom-thr-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Smooth width</span>
            <div class="prop-value">
              <input type="range" id="dv-bloom-smooth" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-bloom-smooth-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            v3 bloom is <b>selective</b> — only materials writing the emissive MRT
            buffer glow. Glow box / ring / boost pads opt in.
          </div>
        </div>
      </div>

      <!-- ── THE v3 EDITOR'S WORLD MENU, PORTED ───────────────────────────────
           These edit the SAME engine state the editor's World tab does
           (app.postFx.state and app.fog.state), so a value set here is the
           value the editor would show. None of it is stored in the .v3proj —
           lighting and post never were — so the game owns whatever it sets. -->
      <div class="inspector-section">
        <div class="section-header">Post FX — Pipeline</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Post FX</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-pfx" type="button" aria-label="Post FX">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">FXAA</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-fxaa" type="button" aria-label="FXAA">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">
            <b>Post FX</b> is the master switch — off, the renderer skips the whole
            post pipeline and costs nothing. <b>FXAA</b> replaces MSAA, which does
            not survive the post pipeline.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Colour grade</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Grade &amp; polish</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-polish" type="button" aria-label="Colour polish">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">
            One switch for grading, vignette AND film grain — they share a pass,
            so the two sections below do nothing while this is off.
          </div>
          <div class="prop-row">
            <span class="prop-label">Brightness</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-bright" min="-1" max="1" step="0.01" />
              <span class="prop-num" id="dv-pfx-bright-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Contrast</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-contrast" min="0" max="2" step="0.01" />
              <span class="prop-num" id="dv-pfx-contrast-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Saturation</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-sat" min="0" max="2" step="0.01" />
              <span class="prop-num" id="dv-pfx-sat-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Temperature</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-temp" min="-1" max="1" step="0.01" />
              <span class="prop-num" id="dv-pfx-temp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tint</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-tint" min="-1" max="1" step="0.01" />
              <span class="prop-num" id="dv-pfx-tint-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Vignette &amp; grain</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Vignette</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-vig" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-pfx-vig-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Vignette falloff</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-vigfall" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-pfx-vigfall-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Vignette colour</span>
            <div class="prop-value">
              <input type="color" id="dv-pfx-vigcol" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Grain</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-grain" min="0" max="0.3" step="0.005" />
              <span class="prop-num" id="dv-pfx-grain-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Grain size</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-grainsz" min="0.5" max="4" step="0.05" />
              <span class="prop-num" id="dv-pfx-grainsz-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Sharpen</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Sharpen (RCAS)</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-sharp" type="button" aria-label="Sharpen">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sharpness</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-sharpness" min="0" max="1" step="0.01" />
              <span class="prop-num" id="dv-pfx-sharpness-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Denoise</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-denoise" type="button" aria-label="Denoise">${CHECK_SVG}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Chromatic aberration</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Enabled</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-ca" type="button" aria-label="Chromatic aberration">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Strength</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-ca-str" min="0" max="5" step="0.05" />
              <span class="prop-num" id="dv-pfx-ca-str-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Scale</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-ca-scale" min="1" max="1.5" step="0.005" />
              <span class="prop-num" id="dv-pfx-ca-scale-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Depth of field</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Enabled</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-dof" type="button" aria-label="Depth of field">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Focus distance</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-dof-dist" min="1" max="1000" step="0.5" />
              <span class="prop-num" id="dv-pfx-dof-dist-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Focal length</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-dof-len" min="1" max="500" step="0.5" />
              <span class="prop-num" id="dv-pfx-dof-len-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bokeh scale</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-dof-bokeh" min="0" max="20" step="0.1" />
              <span class="prop-num" id="dv-pfx-dof-bokeh-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Focus is a fixed distance, not a follow — on a chase camera the car
            sits at a near-constant distance, so one value holds for a whole lap.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Post FX — Ambient occlusion</div>
        <div class="section-body">
          <div class="dv-hint">
            n8ao. The first enable lazily compiles its shaders — expect a
            <b>50–200 ms hitch once</b>, so switch it on in the pits, not mid-lap.
          </div>
          <div class="prop-row">
            <span class="prop-label">SSAO</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-ssao" type="button" aria-label="SSAO">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Quality</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-pfx-ssao-q" type="button">Medium</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Radius</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-ssao-rad" min="0.1" max="64" step="0.1" />
              <span class="prop-num" id="dv-pfx-ssao-rad-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-ssao-fall" min="0" max="5" step="0.05" />
              <span class="prop-num" id="dv-pfx-ssao-fall-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Intensity</span>
            <div class="prop-value">
              <input type="range" id="dv-pfx-ssao-int" min="0" max="10" step="0.1" />
              <span class="prop-num" id="dv-pfx-ssao-int-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">AO colour</span>
            <div class="prop-value">
              <input type="color" id="dv-pfx-ssao-col" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Half-res</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-ssao-half" type="button" aria-label="Half res">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Depth-aware upsample</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-ssao-dau" type="button" aria-label="Depth aware upsampling">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Screen-space radius</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-pfx-ssao-ssr" type="button" aria-label="Screen space radius">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Display mode</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-pfx-ssao-disp" type="button">Combined</button>
            </div>
          </div>
          <div class="dv-hint">
            <b>Half-res</b> is 2–4× faster and wants depth-aware upsampling with it.
            <b>Display mode</b> is a debug view — leave it on Combined.
            Selective bloom already works; the MRT <i>diffuse/normal</i> attachments
            still need their blend fix before AO is trusted over transparencies.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Fog — Distance</div>
        <div class="section-body">
          <div class="dv-hint">
            <b>This is aerial perspective</b> — far geometry taking the sky's
            colour is most of what makes distance read as distance. Both fogs
            ship <b>off</b>, so the track currently gets none of it.
          </div>
          <div class="prop-row">
            <span class="prop-label">Distance fog</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-fog-d" type="button" aria-label="Distance fog">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Density</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-d-dens" min="0.0001" max="0.05" step="0.0001" />
              <span class="prop-num" id="dv-fog-d-dens-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Match sky</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-fog-d-match" type="button" aria-label="Match sky">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Away colour</span>
            <div class="prop-value">
              <input type="color" id="dv-fog-d-col" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Sun tint</span>
            <div class="prop-value">
              <input type="color" id="dv-fog-d-sun" />
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Tint focus</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-d-pow" min="0.5" max="8" step="0.1" />
              <span class="prop-num" id="dv-fog-d-pow-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            With <b>Match sky</b> on, the away colour is driven by the sky instead
            of the swatch — which is what keeps fog and sky agreeing as the hour
            changes. The swatch only bites when it is off.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Fog — Height</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Height fog</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-fog-h" type="button" aria-label="Height fog">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Density</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-h-dens" min="0.001" max="0.05" step="0.001" />
              <span class="prop-num" id="dv-fog-h-dens-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Falloff</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-h-fall" min="0.005" max="0.2" step="0.005" />
              <span class="prop-num" id="dv-fog-h-fall-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Base height</span>
            <div class="prop-value">
              <input type="range" id="dv-fog-h-base" min="-60" max="500" step="1" />
              <span class="prop-num" id="dv-fog-h-base-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Colour</span>
            <div class="prop-value">
              <input type="color" id="dv-fog-h-col" />
            </div>
          </div>
          <div class="dv-hint">
            A ground-hugging band, not a global haze — the track sits at build
            height 40 m in sky mode, so <b>Base height</b> has to reach it before
            any of this is visible from the car.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Audio — Mixer</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Mute all</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-mute" type="button" aria-label="Mute">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Master</span>
            <div class="prop-value">
              <input type="range" id="dv-vol" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-vol-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Vehicle bus</span>
            <div class="prop-value">
              <input type="range" id="dv-bus-veh" min="0" max="1" step="0.05" />
              <span class="prop-num" id="dv-bus-veh-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Audio — Layers</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Engine</span>
            <div class="prop-value">
              <input type="range" id="dv-a-engine" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-a-engine-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wind</span>
            <div class="prop-value">
              <input type="range" id="dv-a-wind" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-a-wind-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wheels</span>
            <div class="prop-value">
              <input type="range" id="dv-a-wheels" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-a-wheels-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Drift / brake</span>
            <div class="prop-value">
              <input type="range" id="dv-a-drift" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-a-drift-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Wind</b> and <b>Wheels</b> ship at 0 (inherited from v2's defaults)
            — raise them to hear those layers at all.
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Audio — Engine pitch</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Pitch min</span>
            <div class="prop-value">
              <input type="range" id="dv-p-min" min="0.2" max="3" step="0.05" />
              <span class="prop-num" id="dv-p-min-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Pitch max</span>
            <div class="prop-value">
              <input type="range" id="dv-p-max" min="0.5" max="6" step="0.05" />
              <span class="prop-num" id="dv-p-max-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Tyre marks</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Tire marks</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-marks" type="button" aria-label="Tire marks">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Mark style</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-skid-style" type="button">Solid</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Not an FX control at all: this is the TERRAIN texture's stochastic
           tiling (the terrain_stochastic key; reloads the page). It has always lived
           in FX. Left here rather than moved to World so no one's muscle memory
           breaks, but named so the filter finds it. -->
      <div class="inspector-section">
        <div class="section-header">FX — Terrain texture</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Stochastic tiling</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-stoch" type="button">Off</button>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Sparks</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Guardrail sparks</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-sparks" type="button" aria-label="Guardrail sparks">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spark rate</span>
            <div class="prop-value">
              <input type="range" id="dv-spk-rate" min="0" max="400" step="10" />
              <span class="prop-num" id="dv-spk-rate-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spark brightness</span>
            <div class="prop-value">
              <input type="range" id="dv-spk-int" min="0.5" max="8" step="0.1" />
              <span class="prop-num" id="dv-spk-int-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spark stretch</span>
            <div class="prop-value">
              <input type="range" id="dv-spk-str" min="0" max="0.2" step="0.005" />
              <span class="prop-num" id="dv-spk-str-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Drift smoke</div>
        <div class="section-body">
          <!-- The enable toggle was six rows above its own settings, on the far
               side of the sparks block. Moved down to lead the group it owns. -->
          <div class="prop-row">
            <span class="prop-label">Drift smoke</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-smoke" type="button" aria-label="Drift smoke">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Smoke amount</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-rate" min="8" max="400" step="2" />
              <span class="prop-num" id="dv-smk-rate-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Smoke opacity</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-op" min="0.05" max="1" step="0.01" />
              <span class="prop-num" id="dv-smk-op-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Smoke life</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-life" min="0.4" max="4" step="0.05" />
              <span class="prop-num" id="dv-smk-life-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Smoke growth</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-grow" min="0.5" max="7" step="0.1" />
              <span class="prop-num" id="dv-smk-grow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Turbulence</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-turb" min="0" max="5" step="0.05" />
              <span class="prop-num" id="dv-smk-turb-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Buoyancy</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-buoy" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-smk-buoy-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Smoke lighting</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Sun shading</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-sun" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-smk-sun-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Ambient</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-amb" min="0" max="1.5" step="0.02" />
              <span class="prop-num" id="dv-smk-amb-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Scatter (rim)</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-scat" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-smk-scat-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Self-shadow</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-abs" min="0" max="3" step="0.05" />
              <span class="prop-num" id="dv-smk-abs-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Smoke shape</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Puff detail</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-noise" min="0.3" max="3" step="0.05" />
              <span class="prop-num" id="dv-smk-noise-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Churn</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-drift" min="0" max="0.6" step="0.01" />
              <span class="prop-num" id="dv-smk-drift-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Dissolve</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-erode" min="0.2" max="1.6" step="0.01" />
              <span class="prop-num" id="dv-smk-erode-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Wispiness</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-esoft" min="0.03" max="1" step="0.01" />
              <span class="prop-num" id="dv-smk-esoft-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Depth fade</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-soft" min="0" max="4" step="0.05" />
              <span class="prop-num" id="dv-smk-soft-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fuse (world noise)</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-fuse" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-smk-fuse-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Fuse scale</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-fscale" min="0.1" max="2" step="0.02" />
              <span class="prop-num" id="dv-smk-fscale-v"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Lingering bank</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Lingering bank</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-smk-haze" type="button" aria-label="Lingering smoke bank">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bank amount</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-hrate" min="0" max="60" step="1" />
              <span class="prop-num" id="dv-smk-hrate-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bank opacity</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-hop" min="0.005" max="0.25" step="0.005" />
              <span class="prop-num" id="dv-smk-hop-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bank life</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-hlife" min="2" max="20" step="0.5" />
              <span class="prop-num" id="dv-smk-hlife-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bank size</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-hsize" min="0.6" max="6" step="0.1" />
              <span class="prop-num" id="dv-smk-hsize-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bank growth</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-hgrow" min="0.5" max="9" step="0.1" />
              <span class="prop-num" id="dv-smk-hgrow-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Bank hold</span>
            <div class="prop-value">
              <input type="range" id="dv-smk-hhold" min="0" max="0.9" step="0.02" />
              <span class="prop-num" id="dv-smk-hhold-v"></span>
            </div>
          </div>

        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">FX — Wet spray</div>
        <div class="section-body">
          <div class="dv-hint">
            <b>Wet spray</b> is the same puff system wearing a different coat —
            these values are blended in by road wetness, so a dry track never
            sees them and none of this costs a second particle pool or an extra
            draw. Set <b>Wetness</b> above 0 in WEATHER to see any of it.
            On a wet road all four wheels throw, not just the rears.
            It switches <b>independently of Drift smoke</b> above — one system,
            two effects.
          </div>
          <div class="prop-row">
            <span class="prop-label">Wet spray</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-spray" type="button" aria-label="Wet spray">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray amount</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-rate" min="0" max="900" step="10" />
              <span class="prop-num" id="dv-spr-rate-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray opacity</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-op" min="0" max="0.3" step="0.005" />
              <span class="prop-num" id="dv-spr-op-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Streak length</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-streak" min="0" max="4" step="0.05" />
              <span class="prop-num" id="dv-spr-streak-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Streak width</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-size" min="0.04" max="0.8" step="0.01" />
              <span class="prop-num" id="dv-spr-size-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Side throw</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-side" min="0" max="9" step="0.2" />
              <span class="prop-num" id="dv-spr-side-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray life</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-life" min="0.1" max="1.6" step="0.02" />
              <span class="prop-num" id="dv-spr-life-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray spread</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-spread" min="0" max="2.5" step="0.05" />
              <span class="prop-num" id="dv-spr-spread-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray rise</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-rise" min="-0.5" max="1.5" step="0.02" />
              <span class="prop-num" id="dv-spr-rise-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray drag</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-drag" min="0" max="1.2" step="0.02" />
              <span class="prop-num" id="dv-spr-drag-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Spray entry</span>
            <div class="prop-value">
              <input type="range" id="dv-spr-entry" min="0" max="20" step="0.5" />
              <span class="prop-num" id="dv-spr-entry-v"></span>
            </div>
          </div>
        </div>
      </div>

    </div>
  `;
  document.body.appendChild(root);

  /**
   * Relabel the key hints for the keyboard the player ACTUALLY has.
   *
   * Driving is bound by `e.code` — physical position — which is right, and is
   * why WASD lands on the same three-finger cluster everywhere. But `e.code` is
   * NAMED for US QWERTY, so on any other layout the printed letter differs and
   * a hardcoded hint is simply wrong. AZERTY is the case that bites here:
   * `KeyZ` is the key printed **W**, and the key printed **Z** is `KeyW` — the
   * THROTTLE. So "Z/X roll" told an AZERTY player to press the gas to roll left.
   * QWERTZ has the same problem one key over (Z is printed Y).
   *
   * `navigator.keyboard.getLayoutMap()` maps code → printed label, so the hint
   * can just tell the truth. Chromium-only; everywhere else the markup's own
   * QWERTY text stands, which is exactly today's behaviour.
   */
  (async () => {
    try {
      const map = await navigator.keyboard?.getLayoutMap?.();
      if (!map) return;
      for (const el of root.querySelectorAll("[data-keys]")) {
        const labels = el.dataset.keys.split(",").map((c) => map.get(c)?.toUpperCase());
        // All or nothing — a half-translated "WASD" would be worse than none.
        if (labels.some((l) => !l)) continue;
        el.textContent = labels.join("");
      }
    } catch { /* layout API unavailable or blocked — keep the QWERTY labels */ }
  })();

  const style = document.createElement("style");
  style.textContent = `
    #road-dev {
      position: fixed; right: 0; top: 0; bottom: 0;
      width: ${DEV_PANEL_OPEN_W}px; min-width: ${DEV_PANEL_OPEN_W}px; z-index: 200;
      background: var(--bg-panel); border-left: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: var(--font);
      pointer-events: auto;
      box-sizing: border-box;
    }
    /* Readouts like "80 m/s" need more than the editor's default 36px.
       min-width: 0 on the row/value/range so Chrome's ~129px range default
       cannot shove the readout past the panel edge. */
    #road-dev .prop-row { min-width: 0; }
    #road-dev .prop-value { min-width: 0; }
    #road-dev .prop-value input[type="range"] { min-width: 0; }
    #road-dev .dv-led-input {
      width: 100%; min-width: 0;
      background: var(--bg-input); color: var(--text);
      border: 1px solid var(--border); border-radius: 4px;
      padding: 4px 6px; font: inherit; font-size: 12px;
    }
    #road-dev .prop-num {
      width: auto; min-width: 52px; flex-shrink: 0;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    #road-dev .prop-label { width: 90px; min-width: 90px; }
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
    #road-dev .dv-hint kbd {
      padding: 1px 4px; font-family: var(--font-mono); font-size: 10px;
      color: var(--text); background: var(--bg-input);
      border: 1px solid var(--border); border-radius: 3px;
    }
    /* A tool that is ARMED, not a button that was clicked. editor.css has
       .primary (a highlighted call-to-action) but nothing for "this mode is live
       right now", and the spawn ghost needs the difference to be visible: the lit
       button is the only thing on screen saying the next click will drop a car. */
    #road-dev .action-btn.active {
      background: var(--accent); border-color: var(--accent); color: #08101c;
      font-weight: 600;
    }
    #road-dev .action-btn.active:hover { filter: brightness(1.08); }
    /* Shortcut strip — parked in Mode until a real menu exists. */
    #road-dev #hint {
      margin-top: 8px; padding: 8px 10px;
      font-size: 11px; line-height: 1.5; color: var(--text-dim);
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid var(--border); border-radius: var(--radius, 4px);
    }
    #road-dev #hint b { color: var(--text); font-weight: 600; }
    #road-dev #hint .hint-build,
    #road-dev #hint .hint-drive { display: none; }
    #road-dev #hint[data-mode="build"] .hint-build { display: block; }
    #road-dev #hint[data-mode="drive"] .hint-drive { display: block; }
    #road-dev .dv-world-name {
      max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* NESTED GROUPS. editor.css pads .section-body, so a body inside a body
       would double-indent and eat the panel's width. The group body
       contributes no padding of its own; the children keep theirs. */
    #road-dev .dv-group-body { padding: 0; }
    /* The parent reads as a heading, the children as items under it. */
    #road-dev .dv-group-header { color: var(--text); }
    #road-dev .dv-group-body > .inspector-section > .section-header {
      padding-left: 22px;
      text-transform: none;
      letter-spacing: 0;
    }
    #road-dev .dv-group-body > .inspector-section:last-child { border-bottom: none; }

    /* ── SEARCH ───────────────────────────────────────────────────────────── */
    #road-dev .dv-search {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 8px;
      border-bottom: 1px solid var(--border, rgba(255,255,255,0.08));
      background: rgba(0, 0, 0, 0.18);
    }
    #road-dev.collapsed .dv-search { display: none; }
    #road-dev .dv-search-icon { opacity: 0.5; font-size: 11px; line-height: 1; }
    #road-dev .dv-search input {
      flex: 1 1 auto; min-width: 0;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 3px;
      color: #eef2f7; font: inherit; font-size: 11px;
      padding: 4px 6px;
    }
    #road-dev .dv-search input:focus {
      outline: none; border-color: var(--tm-yellow, #ffd42a);
    }
    #road-dev .dv-search input::placeholder { color: #7c8697; }
    #road-dev .dv-search-count {
      font-size: 10px; color: #8b95a6; font-variant-numeric: tabular-nums;
      min-width: 34px; text-align: right;
    }
    /* A section the filter emptied, and rows it rejected. Kept as a separate
       attribute from [hidden] so the filter can never fight a control that
       hides itself for a real reason — see the note in slider(). */
    #road-dev [data-filtered] { display: none !important; }

    /* ── HINTS ────────────────────────────────────────────────────────────── */
    /* Off by default. The notes are genuinely useful — they are why a control
       you have not touched in a month is still legible — but they were doing
       the job of navigation, and 30 paragraphs of it turned the panel into a
       document you scroll rather than a console you use. The ⓘ button brings
       them all back, and the filter searches their text either way, so nothing
       written here is lost by hiding it. */
    #road-dev:not(.dv-hints) .dv-hint { display: none; }
    #road-dev .dv-hints-btn.on { color: var(--tm-yellow, #ffd42a); }
    /* A hint the filter matched shows even with hints off, so a search can
       explain itself. */
    #road-dev .dv-hint[data-hit] { display: block !important; }

    /* ── SECTION ICONS ────────────────────────────────────────────────────── */
    /* One glyph per section, so the eye lands on the right block before it has
       read anything. Purely a marker: the text still carries the meaning. */
    /* A LEFT COLUMN, not a right-aligned decoration. Right-aligned glyphs sit
       at a different x on every row because the labels differ in length, so the
       eye has to read the text to find them — which defeats the point. In a
       fixed-width column they scan as a single vertical strip. */
    #road-dev .section-header { display: flex; align-items: center; }
    #road-dev .section-header .section-arrow { order: -2; }
    #road-dev .section-header::after {
      content: attr(data-icon);
      order: -1;
      width: 17px;
      margin-right: 4px;
      text-align: center;
      font-size: 12px;
      line-height: 1;
      opacity: 0.75;
    }
  `;
  document.head.appendChild(style);

  const $ = (sel) => root.querySelector(sel);

  // ── FOLDABLE SECTIONS ───────────────────────────────────────────────────────
  // 25 sections in one scroll is unusable, so every .section-header becomes a
  // fold using the SAME mechanism as the v3 editor: `.collapsed` on the header,
  // `.hidden` on the body that follows it. The CSS for both (including the arrow
  // rotation) already lives in editor.css, which this panel reuses — see the
  // module header — so nothing new is styled here.
  //
  // Done in JS rather than by hand-editing 25 headers in the template: the
  // markup stays readable, and a section added later is folded automatically
  // instead of being silently left out.
  //
  // State persists per section, keyed by header text, because the alternative is
  // re-opening the same four sections after every reload while tuning.
  // ── NESTING ─────────────────────────────────────────────────────────────────
  // Eight "Car — …" blocks and three "Audio — …" blocks are most of the panel's
  // length, and they are only ever opened one at a time. Each family collapses
  // into ONE parent fold, so the top level reads as ~14 entries instead of 25.
  //
  // Built from the existing flat markup rather than by re-indenting the template:
  // the prefix in the header text ("Car — Power") is already the grouping, so the
  // markup stays flat and readable and a new "Car — …" section joins its parent
  // automatically. Each family's sections are contiguous, so wrapping in place
  // preserves order.
  //
  // Display text loses the prefix once nested (it is above them now) but the
  // FOLD KEY keeps the full original — otherwise a bare "Power" would be one
  // rename away from colliding with some other section's key in localStorage.
  const GROUP_PREFIXES = ["Car", "Audio", "FX", "Clouds", "Post FX", "Fog"];
  for (const prefix of GROUP_PREFIXES) {
    const sep = `${prefix} — `;
    const secs = [...root.querySelectorAll(".inspector-section")].filter((s) => {
      const h = s.querySelector(":scope > .section-header");
      return h && h.textContent.trim().startsWith(sep);
    });
    if (secs.length < 2) continue;

    const wrap = document.createElement("div");
    wrap.className = "inspector-section dv-group";
    const gh = document.createElement("div");
    gh.className = "section-header dv-group-header";
    gh.textContent = prefix;
    const gb = document.createElement("div");
    gb.className = "section-body dv-group-body";
    wrap.append(gh, gb);
    secs[0].parentNode.insertBefore(wrap, secs[0]);

    for (const s of secs) {
      const h = s.querySelector(":scope > .section-header");
      const full = h.textContent.trim();
      h.dataset.foldKey = full;              // stable across the rename
      h.textContent = full.slice(sep.length);
      gb.appendChild(s);                     // moves it out of the flat list
    }
  }

  const FOLD_KEY = "modular-road-v3.devPanel.folds";
  /** Open on a fresh profile. Everything else — the ten "Car — …" tuning blocks
   *  especially — starts folded so the panel opens as an index, not a wall. */
  const DEFAULT_OPEN = new Set(["World", "Mode", "Track"]);
  const ARROW_SVG =
    '<svg class="section-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<polyline points="6 9 12 15 18 9"></polyline></svg>';

  let folds = {};
  try { folds = JSON.parse(localStorage.getItem(FOLD_KEY) || "{}") || {}; } catch { folds = {}; }
  const saveFolds = () => {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch { /* private mode */ }
  };

  const sections = [];
  for (const hdr of root.querySelectorAll(".section-header")) {
    // Nested headers carry their original full text as the key (see NESTING).
    const key = hdr.dataset.foldKey || hdr.textContent.trim(); // BEFORE the arrow goes in
    const body = hdr.nextElementSibling;
    if (!body || !body.classList.contains("section-body")) continue;
    hdr.setAttribute("data-toggle", "");
    hdr.insertAdjacentHTML("afterbegin", ARROW_SVG);

    const setOpen = (open) => {
      hdr.classList.toggle("collapsed", !open);
      body.classList.toggle("hidden", !open);
    };
    setOpen(folds[key] ?? DEFAULT_OPEN.has(key));
    hdr.addEventListener("click", () => {
      const open = hdr.classList.contains("collapsed"); // about to open
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

  // ── SECTION ICONS ───────────────────────────────────────────────────────────
  //
  // Matched on the fold KEY, which is the header's original text — the same
  // string the group rename preserves — so a section moved under "Car" or
  // "Audio" keeps its glyph. Anything unmatched simply gets none; this is a
  // wayfinding aid, not a requirement, and a missing icon must never be a bug.
  const SECTION_ICONS = {
    World: "🌍", Mode: "🕹️", Track: "🛣️", Weather: "🌧️", "Post FX": "✨",
    Camera: "🎥", Lighting: "💡", Clouds: "☁️", Terrain: "⛰️",
    Props: "📦", Movers: "⚙️", Portals: "🌀", Audio: "🔊", FX: "💥",
    Physics: "🧪", Debug: "🐞", Car: "🚗", Wheels: "🛞", Tires: "🛞",
    Surface: "🧱", Rails: "🚧", Collision: "🧊", Performance: "📈",
    // `Lights` is spelled out because the prefix match is `includes`, and
    // "Lights" does not contain "Lighting".
    Lights: "💡", Bloom: "🌟", "Prop livery": "🎨", "Grid snap": "📐",
    "Gap / jump": "🛫", Spawn: "📍", Race: "🏁", "Edit piece": "✏️",
    "Camera frame": "🖼️",
    // The Car block is eight consecutive sections. Left as one repeated 🚗 the
    // glyph column carries no information exactly where the list is longest, so
    // each handling group gets its own mark.
    Power: "⚡", "Grip & Handling": "🛞", "Steering feel": "🎯",
    "Landing & body": "🪂", "Wall response": "🧱", "Yaw assist": "🌀",
    "Air control": "🪁", Aero: "🌬️", "Road hold": "🧲",
    "World light": "🔆",
    // Same reason for the four Audio sections.
    Mixer: "🎚️", Layers: "🧅", "Engine pitch": "🎵",
    // …and for the eight FX sections the 43-row block was split into.
    "Tyre marks": "🛞", Sparks: "✨", "Drift smoke": "💨",
    "Smoke lighting": "🔦", "Smoke shape": "🌫️", "Lingering bank": "🏳️",
    "Wet spray": "💦", "Terrain texture": "🧱",
    // `Sky` is defined ONCE, here — it used to also sit in the block above with a
    // different glyph, where the later key silently won.
    Sky: "🌌", Shape: "🌥️", Quality: "🎚️",
    // The ported v3 WORLD menu.
    "Post FX": "✨", Fog: "🌫️", Pipeline: "🧩",
    "Colour grade": "🎨", "Vignette & grain": "🎞️", Sharpen: "🔪",
    "Chromatic aberration": "🌈", "Depth of field": "📷",
    "Ambient occlusion": "⚫", Distance: "🌁", Height: "🏞️",
    // Explicit, or "Build (sky)" matches the Sky entry and wears its glyph.
    "Build (sky)": "🏗️",
  };
  for (const hdr of root.querySelectorAll(".section-header")) {
    const key = hdr.dataset.foldKey || hdr.textContent.trim();
    // A fold key is "Family — Own name" ("Audio — Mixer"), so the tail is the
    // most specific name this section has. Try it, then the visible label, then
    // the whole key: a section's own glyph must beat its family's.
    //
    // The substring pass is only a fallback, and it is genuinely ambiguous —
    // "Audio — Mixer" contains BOTH "Audio" and "Mixer", both 5 characters, so
    // longest-wins picked whichever was declared first. That is why the exact
    // passes run ahead of it rather than relying on the sort.
    const tail = key.split("—").pop().trim();
    let icon =
      SECTION_ICONS[tail] ||
      SECTION_ICONS[hdr.textContent.trim()] ||
      SECTION_ICONS[key];
    if (!icon) {
      const hit = Object.keys(SECTION_ICONS)
        .filter((k) => key.toLowerCase().includes(k.toLowerCase()))
        .sort((a, b) => b.length - a.length)[0];
      icon = hit ? SECTION_ICONS[hit] : "";
    }
    if (icon) hdr.dataset.icon = icon;
  }

  // ── HINTS ───────────────────────────────────────────────────────────────────
  const HINTS_KEY = "modular-road-v3.devPanel.hints";
  let hintsOn = false;
  try { hintsOn = localStorage.getItem(HINTS_KEY) === "1"; } catch { hintsOn = false; }
  const hintsBtn = $(".dv-hints-btn");
  const applyHints = () => {
    root.classList.toggle("dv-hints", hintsOn);
    hintsBtn?.classList.toggle("on", hintsOn);
    if (hintsBtn) {
      hintsBtn.title = hintsOn ? "Hide the explanation notes" : "Show the explanation notes";
    }
  };
  applyHints();
  hintsBtn?.addEventListener("click", () => {
    hintsOn = !hintsOn;
    applyHints();
    try { localStorage.setItem(HINTS_KEY, hintsOn ? "1" : "0"); } catch { /* private mode */ }
  });

  // ── FILTER ──────────────────────────────────────────────────────────────────
  //
  // Hides rows whose text does not match, then hides any section left with
  // nothing in it, and force-opens the ones that still have something — so a
  // search reads as a short list rather than as a set of closed drawers you
  // still have to click through.
  //
  // `data-filtered` rather than `hidden`, deliberately: `slider()` uses
  // `hidden` to retire a control with no backing value (the cheap-deck subset),
  // and the two must not overwrite each other. A row can be legitimately hidden
  // AND filtered; clearing the search must not resurrect a dead control.
  const filterInput = $("#dv-filter");
  const filterCount = $("#dv-filter-count");
  const filterables = () => root.querySelectorAll(
    ".tab-content .prop-row, .tab-content .action-btn, .tab-content .dv-hint",
  );
  const applyFilter = (raw) => {
    const q = raw.trim().toLowerCase();
    for (const el of root.querySelectorAll("[data-hit]")) delete el.dataset.hit;

    if (!q) {
      for (const el of filterables()) delete el.dataset.filtered;
      for (const s of root.querySelectorAll(".inspector-section")) delete s.dataset.filtered;
      // Back to the user's own fold state, not to everything-open.
      for (const s of sections) s.setOpen(folds[s.key] ?? DEFAULT_OPEN.has(s.key));
      if (filterCount) filterCount.textContent = "";
      return;
    }

    let hits = 0;
    for (const el of filterables()) {
      const match = el.textContent.toLowerCase().includes(q);
      if (match) {
        delete el.dataset.filtered;
        hits++;
        // Let a matching note show itself even when notes are switched off,
        // so the search can explain what it found.
        if (el.classList.contains("dv-hint")) el.dataset.hit = "";
      } else {
        el.dataset.filtered = "";
      }
    }
    // A SECTION NAME COUNTS AS A MATCH FOR EVERYTHING INSIDE IT.
    //
    // Searching "bloom" should show you the Bloom section, but its own controls
    // are called Strength, Threshold and Radius — none of which contain the
    // word. Without this the most obvious search in the panel returns one row.
    // Done before the section pass below so those rows are already alive when
    // their section is judged.
    for (const hdr of root.querySelectorAll(".section-header")) {
      const name = (hdr.dataset.foldKey || hdr.textContent || "").toLowerCase();
      if (!name.includes(q)) continue;
      const body = hdr.nextElementSibling;
      if (!body || !body.classList.contains("section-body")) continue;
      for (const el of body.querySelectorAll(".prop-row, .action-btn, .dv-hint")) {
        if (el.dataset.filtered !== undefined) { delete el.dataset.filtered; hits++; }
      }
    }

    // DEEPEST FIRST, and stale flags cleared before any of it.
    //
    // A group wrapper's verdict depends on its children's, so judging it in
    // document order reads their state from the PREVIOUS search — the wrapper
    // sits before them in the DOM. That is how a search for "spray" found 8
    // matching rows and displayed none: the rows were live, their section was
    // live, and the "Car"-style wrapper above them was still carrying a
    // filtered flag left over from the search before it. Reversing resolves
    // every child before the parent that asks about it.
    const secs = [...root.querySelectorAll(".inspector-section")];
    for (const sec of secs) delete sec.dataset.filtered;
    for (let i = secs.length - 1; i >= 0; i--) {
      const sec = secs[i];
      const body = sec.querySelector(":scope > .section-body");
      if (!body) continue;
      const alive = [...body.querySelectorAll(".prop-row, .action-btn, .dv-hint")]
        .some((el) => el.dataset.filtered === undefined);
      // A group wrapper counts as alive if any nested section survived.
      const nested = [...body.querySelectorAll(".inspector-section")]
        .some((s) => s.dataset.filtered === undefined);
      if (alive || nested) {
        delete sec.dataset.filtered;
        const hdr = sec.querySelector(":scope > .section-header");
        hdr?.classList.remove("collapsed");
        body.classList.remove("hidden");
      } else {
        sec.dataset.filtered = "";
      }
    }
    if (filterCount) filterCount.textContent = hits ? String(hits) : "none";
  };
  filterInput?.addEventListener("input", () => applyFilter(filterInput.value));
  filterInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { filterInput.value = ""; applyFilter(""); filterInput.blur(); }
    e.stopPropagation();   // the game listens on window; typing must not drive
  });
  // `/` focuses the box, the way it does in most tools. Ignored while typing
  // anywhere, so it can never eat a keystroke meant for a text field —
  // including the track-name box, which sits outside this panel.
  const typingIn = (el) => {
    const t = el?.tagName;
    return t === "INPUT" || t === "TEXTAREA" || t === "SELECT" || el?.isContentEditable === true;
  };
  addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (typingIn(e.target)) return;
    if (root.classList.contains("collapsed")) return;
    e.preventDefault();
    filterInput?.focus();
    filterInput?.select();
  });

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
    // NO BACKING VALUE: hide the row rather than leave a dead control.
    //
    // This is what lets the cheap-deck switch prune the panel for free. The
    // cheap asphalt material is a deliberate SUBSET of the look — no tar
    // snakes, no historical rubber, no wet, no anisotropy — so those uniforms
    // simply are not there, and a slider bound to `undefined.value` would
    // either throw or sit there pretending to do something.
    if (!obj) { el.closest(".prop-row")?.setAttribute("hidden", ""); return; }
    el.closest(".prop-row")?.removeAttribute("hidden");
    el.value = obj[key];
    if (out) out.textContent = fmt(obj[key]);
    el.addEventListener("input", () => {
      const v = +el.value;
      obj[key] = v;
      if (out) out.textContent = fmt(v);
      onSet?.(v);
    });
  }

  /* ── ROAD-LOOK CONTROLS BIND BY NAME, NOT BY OBJECT ────────────────────────
   *
   * The deck material is REPLACED, not edited, whenever wetness, anisotropy,
   * grit or line relief crosses zero — `syncRoadMaterialFeatures` rebuilds it so
   * the shader compiles only the features in use. The replacement carries a
   * brand-new `uniform()` bag, so a control holding the old uniform object then
   * writes into a material nobody renders. Two things went wrong at once: the
   * knob stopped doing anything, and the next `applyRoadMaterial` re-synced the
   * new deck from `roadLook`, so any edit made after the swap visibly snapped
   * back.
   *
   * `game.roadUniforms` is a getter for exactly this reason, but reading it once
   * into a local at bind time threw that away. These resolve it PER EVENT, so a
   * control keeps working across any number of rebuilds.
   *
   * The listener is also attached exactly once. The old pass re-ran wholesale to
   * "rebind" after the cheap-deck A/B and added another `input` handler every
   * time, so after N toggles one drag wrote into N discarded materials.
   */
  const roadLookSyncs = [];
  const roadUniform = (key) => game.roadUniforms?.[key];

  /** Show or hide a control's row, mirroring `slider`'s missing-uniform rule. */
  function setRowShown(el, shown) {
    const row = el.closest(".prop-row");
    if (!row) return;
    if (shown) row.removeAttribute("hidden");
    else row.setAttribute("hidden", "");
  }

  /** A range input on a road-look uniform, resolved by name at event time. */
  function roadSlider(id, key, fmt = (v) => v.toFixed(2)) {
    const el = $(`#${id}`);
    const out = $(`#${id}-v`);
    if (!el) return;
    const sync = () => {
      const u = roadUniform(key);
      // The cheap deck is a deliberate SUBSET of the look, so a missing uniform
      // hides the row rather than leaving a dead control (see `slider`).
      setRowShown(el, !!u);
      if (!u) return;
      el.value = u.value;
      if (out) out.textContent = fmt(u.value);
    };
    el.addEventListener("input", () => {
      const u = roadUniform(key);
      if (!u) return;
      const v = +el.value;
      u.value = v;
      if (out) out.textContent = fmt(v);
    });
    roadLookSyncs.push(sync);
    sync();
  }

  /**
   * A colour input on a road-look colour uniform, resolved by name.
   *
   * The uniform holds LINEAR; the picker speaks sRGB. `getHexString()` already
   * runs linear→sRGB and `set("#rrggbb")` already runs sRGB→linear, so neither
   * direction needs an explicit convert. Both used to carry one, mirroring the
   * double conversion in the material module's `lin()` — the pair round-tripped,
   * so the picker showed back exactly the hex you typed, which is why it never
   * looked broken even though the colour reaching the shader was 5–10× too dark.
   */
  function roadColor(id, key) {
    const el = $(`#${id}`);
    if (!el) return;
    const sync = () => {
      const u = roadUniform(key);
      setRowShown(el, !!u?.value);
      if (!u?.value) return;
      el.value = `#${u.value.getHexString()}`;
    };
    el.addEventListener("input", () => {
      const u = roadUniform(key);
      if (u?.value) u.value.set(el.value);
    });
    roadLookSyncs.push(sync);
    sync();
  }

  /**
   * Re-read every road-look control from the CURRENT material.
   *
   * Only display and row visibility — the write path already follows the swap on
   * its own, so this never re-attaches a listener.
   */
  const refreshRoadLook = () => { for (const s of roadLookSyncs) s(); };

  /**
   * Wire an `<input type=color>` to a PLAIN HEX STRING on a state object.
   *
   * Not `roadColor`: that one owns a THREE.Color living in linear space and the
   * DOM speaks sRGB. These are engine tool-state fields the editor
   * writes as "#rrggbb" strings, so converting would double-apply the transfer
   * function and wash every colour out.
   */
  function colorField(id, obj, key, onChange) {
    const el = $(`#${id}`);
    if (!el || !obj || obj[key] == null) {
      el?.closest(".prop-row")?.setAttribute("hidden", "");
      return;
    }
    el.value = obj[key];
    el.addEventListener("input", () => {
      obj[key] = el.value;
      onChange?.(el.value);
    });
  }

  /**
   * An action-btn that cycles a set of values — the panel's stand-in for the
   * editor's dropdown. `values` are what the engine wants; `labels` what to
   * show. Cycling rather than a <select> keeps it the same one-line row shape
   * as every other control here.
   */
  function cycleField(id, obj, key, values, labels, onChange) {
    const el = $(`#${id}`);
    if (!el || !obj) { el?.closest(".prop-row")?.setAttribute("hidden", ""); return; }
    const paint = () => {
      const i = Math.max(0, values.indexOf(obj[key]));
      el.textContent = labels[i] ?? String(obj[key]);
    };
    paint();
    el.addEventListener("click", () => {
      const i = values.indexOf(obj[key]);
      obj[key] = values[(i + 1) % values.length];
      paint();
      onChange?.(obj[key]);
    });
    return { refresh: paint };
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

  // ── Build (sky) ─────────────────────────────────────────────────────────────
  const bhEl = $("#dv-bh");
  const bhVal = $("#dv-bh-v");
  if (bhEl) {
    bhEl.value = game.getBuildHeight();
    bhVal.textContent = `${game.getBuildHeight()} m`;
    bhEl.addEventListener("input", () => {
      const m = +bhEl.value;
      game.setBuildHeight(m);
      bhVal.textContent = `${m} m`;
    });
  }
  $("#dv-newchain").addEventListener("click", () => game.reseedChain());
  const anchorTiltEl = $("#dv-anchor-tilt");
  $("#dv-anchor-level")?.addEventListener("click", () => { game.levelAnchor?.(); refresh(); });

  // ── Grid snap ───────────────────────────────────────────────────────────────
  toggle("dv-snap", game.getSnapOn(), (on) => game.setSnapOn(on));
  toggle("dv-grid", game.getGridVisible(), (on) => game.setGridVisible(on));
  const stepEl = $("#dv-snapstep");
  const stepVal = $("#dv-snapstep-v");
  if (stepEl) {
    stepEl.value = game.getSnapStep();
    stepVal.textContent = `${game.getSnapStep()} m`;
    stepEl.addEventListener("input", () => {
      game.setSnapStep(+stepEl.value);
      stepVal.textContent = `${stepEl.value} m`;
    });
  }
  const yawEl = $("#dv-snapyaw");
  const yawVal = $("#dv-snapyaw-v");
  if (yawEl) {
    yawEl.value = game.getSnapYaw();
    yawVal.textContent = `${game.getSnapYaw()}°`;
    yawEl.addEventListener("input", () => {
      game.setSnapYaw(+yawEl.value);
      yawVal.textContent = `${yawEl.value}°`;
    });
  }

  // ── Gap / jump ──────────────────────────────────────────────────────────────
  // HANDLE KEPT, not discarded: "Snap landing" and "Size the Gap" solve the arc
  // on demand and turn the preview on themselves, so the button has to be able
  // to catch up with a change it did not make. Same reason lightsToggle is kept.
  const gapToggle = toggle("dv-gap", game.getGapPreview(), (on) => game.setGapPreview(on));
  const refSpdEl = $("#dv-refspd");
  const refSpdVal = $("#dv-refspd-v");
  if (refSpdEl) {
    // CAP AT TOP SPEED. The markup's static max of 60 let you draw an arc for a
    // speed the car cannot physically reach — and range goes as v², so a 60 m/s
    // arc on a car that tops out near 48 marks a landing 55% too far away, which
    // reads as "the preview lies" rather than "that slider is unreachable".
    refSpdEl.max = TIRE.topSpeed;
    refSpdEl.value = Math.min(game.getRefSpeed(), TIRE.topSpeed);
    refSpdVal.textContent = `${game.getRefSpeed()} m/s`;
    refSpdEl.addEventListener("input", () => {
      game.setRefSpeed(+refSpdEl.value);
      refSpdVal.textContent = `${refSpdEl.value} m/s`;
    });
  }
  const dropEl = $("#dv-drop");
  const dropVal = $("#dv-drop-v");
  if (dropEl) {
    dropEl.value = game.getLandingDrop();
    dropVal.textContent = `${game.getLandingDrop()} m`;
    dropEl.addEventListener("input", () => {
      game.setLandingDrop(+dropEl.value);
      dropVal.textContent = `${dropEl.value} m`;
    });
  }
  $("#dv-snap-landing").addEventListener("click", () => game.snapLanding());
  $("#dv-gap-to-landing")?.addEventListener("click", () => game.gapToLanding?.());

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const spawnSrc = $("#dv-spawn-src");
  const spawnRoadBtn = $("#dv-spawn-road");
  const spawnGroundBtn = $("#dv-spawn-ground");
  const renderSpawnSrc = () => {
    spawnSrc.textContent = game.hasSpawn() ? "custom" : ".v3proj / origin";
    // The buttons are a MODE, not a one-shot action: while the ghost is armed the
    // active one stays lit, so the panel and the viewport never disagree about
    // whether a tool is live. roadGame calls refresh() on arm, place and cancel —
    // including the cancels it does NOT own (Esc, right-click, arming a prop).
    const placing = game.spawnPlacingMode?.() ?? null;
    spawnRoadBtn.classList.toggle("active", placing === "road");
    spawnGroundBtn.classList.toggle("active", placing === "ground");
    spawnRoadBtn.textContent = placing === "road" ? "Placing… (Esc)" : "Place car on road";
    spawnGroundBtn.textContent = placing === "ground" ? "Placing… (Esc)" : "Place car on ground";
  };
  // Clicking the armed mode again puts the tool down — a lit button you cannot
  // switch off is a trap.
  const armSpawn = (mode) => {
    if ((game.spawnPlacingMode?.() ?? null) === mode) game.cancelSpawnPlacement();
    else game.placeSpawn(mode);
    renderSpawnSrc();
  };
  spawnRoadBtn.addEventListener("click", () => armSpawn("road"));
  spawnGroundBtn.addEventListener("click", () => armSpawn("ground"));
  $("#dv-spawn-car").addEventListener("click", () => { game.setSpawnToCar(); renderSpawnSrc(); });
  $("#dv-spawn-clear").addEventListener("click", () => { game.clearSpawn(); renderSpawnSrc(); });
  renderSpawnSrc();

  // ── Race ────────────────────────────────────────────────────────────────────
  const bestEl = $("#dv-best");
  toggle("dv-respawn-on", game.getRaceRespawn(), (on) => game.setRaceRespawn(on));
  toggle("dv-race-ghost", game.getShowRaceGhost?.() ?? true, (on) => game.setShowRaceGhost?.(on));
  $("#dv-clear-rec").addEventListener("click", () => { game.clearRecord(); refresh(); });

  // ── Camera ──────────────────────────────────────────────────────────────────
  toggle("dv-freelook", false, (on) => game.setFreeLook(on));
  const cam = game.cameraParams;
  slider("dv-cam-dist", cam, "dist", (v) => `${v.toFixed(1)}m`);
  slider("dv-cam-height", cam, "height", (v) => `${v.toFixed(1)}m`);
  slider("dv-cam-below", cam, "carBelowCentre", (v) => `${v.toFixed(1)}°`);
  slider("dv-cam-fovbase", cam, "fovBase", (v) => `${v.toFixed(0)}°`);
  slider("dv-cam-fov", cam, "fovAtSpeed", (v) => (v > 0 ? `+${v.toFixed(0)}°` : "static"));
  slider("dv-cam-fovref", cam, "fovSpeedRef", (v) => `${v.toFixed(0)} m/s`);
  slider("dv-cam-fovlerp", cam, "fovLerp", (v) => v.toFixed(1));

  // Boom behaviour (live tuning — smoothness is subjective, dial to taste).
  // None of these can move the car on screen; that is `carBelowCentre` alone.
  slider("dv-headinglerp", cam, "headingLerp", (v) => v.toFixed(1));
  slider("dv-uplerp", cam, "upLerp", (v) => v.toFixed(1));
  slider("dv-boomsmooth", cam, "boomSmoothTime", (v) => `${v.toFixed(2)}s`);
  slider("dv-poleguard", cam, "poleGuard", (v) => `${v.toFixed(0)}°`);

  // ── Car ─────────────────────────────────────────────────────────────────────
  slider("dv-top", TIRE, "topSpeed", (v) => `${v.toFixed(0)} m/s`);
  slider("dv-accel", TIRE, "accelForce", (v) => `${(v / 1000).toFixed(1)}k`);
  slider("dv-fric", TIRE, "frictionCoeff");
  slider("dv-rear", TIRE, "gripRear");
  slider("dv-steer", TIRE, "maxSteerAngle", (v) => `${Math.round(v * 57.2958)}°`);
  slider("dv-yaw", TIRE, "yawAssist", (v) => v.toFixed(2));
  slider("dv-yaw-align", TIRE, "alignTorque", (v) => `${(v / 1000).toFixed(1)}k`);
  slider("dv-yaw-slip", TIRE, "slipMax", (v) => `${Math.round(v * 57.2958)}°`);
  slider("dv-yaw-damp", TIRE, "yawRateDamp", (v) => `${(v / 1000).toFixed(1)}k`);
  slider("dv-yaw-drift", TIRE, "driftYawAssistMul", (v) => `${Math.round(v * 100)}%`);
  slider("dv-st-attack", TIRE, "steerAttack", (v) => v.toFixed(1));
  slider("dv-st-release", TIRE, "steerRelease", (v) => v.toFixed(1));
  slider("dv-st-counter", TIRE, "steerCounter", (v) => v.toFixed(1));
  slider("dv-st-drop", TIRE, "steerRateSpeedDrop", (v) => `${Math.round(v * 100)}%`);
  slider("dv-st-analog", TIRE, "steerAnalogRate", (v) => v.toFixed(0));
  slider("dv-wall-skin", SOLID, "skin", (v) => `${(v * 100).toFixed(0)} cm`);
  slider("dv-wall-spin", SOLID, "spin", (v) => v.toFixed(2));
  const deg = (v) => `${(v * 57.2958).toFixed(1)}°/g`;
  const cm = (v) => `${(v * 100).toFixed(1)} cm`;
  slider("dv-susp-bump", TIRE, "minSuspExt", cm);
  slider("dv-susp-archlift", TIRE, "archLiftBody", (v) => `${Math.round(v * 100)}%`);
  slider("dv-susp-droop", TIRE, "maxDroop", cm);
  const csDeg = (v) => `${(v * 57.2958).toFixed(0)}°`;
  slider("dv-cs-gain", DRIFT, "counterSteerVisual", (v) => `${Math.round(v * 100)}%`);
  slider("dv-cs-dead", DRIFT, "counterDeadband", csDeg);
  slider("dv-cs-max", DRIFT, "maxVisualSteer", csDeg);
  slider("dv-land-absorb", TIRE, "landingAbsorb", (v) => `${Math.round(v * 100)}%`);
  slider("dv-land-assist", TIRE, "airLandAssist", (v) => v.toFixed(2));
  slider("dv-land-range", TIRE, "airLandRange", (v) => `${v.toFixed(0)} m`);
  slider("dv-land-time", TIRE, "airLandTime", (v) => `${v.toFixed(2)}s`);
  // 0 keeps the nose down for a front-first landing; 1 is the old flatten.
  slider("dv-land-pitch", TIRE, "airLandPitchLevel", (v) => `${Math.round(v * 100)}%`);
  slider("dv-land-yield", TIRE, "airLandInputYield", (v) => `${Math.round(v * 100)}%`);
  // Shown in DEGREES — the constants are radians, but "the car is 6° off" is the
  // thing you can actually see out of the window.
  slider("dv-land-errdead", TIRE, "airLandErrDead", (v) => `${(v * 57.2958).toFixed(0)}°`);
  slider("dv-land-errfull", TIRE, "airLandErrFull", (v) => `${(v * 57.2958).toFixed(0)}°`);
  slider("dv-land-ratedead", TIRE, "airLandRateDead", (v) => `${v.toFixed(2)} rad/s`);
  slider("dv-air-arcfrac", TIRE, "airAlignFraction", (v) => `${Math.round(v * 100)}%`);
  // Track width is the hub |x|; the readout shows the FULL track so it can be
  // compared against the body width directly.
  slider("dv-track", WHEEL_LAYOUT, "halfTrack", (v) => (v * 2).toFixed(2) + "m",
    () => game.applyWheelLayout?.());
  slider("dv-lean-roll", BODYLEAN, "rollPerG", deg);
  slider("dv-lean-pitch", BODYLEAN, "pitchPerG", deg);
  const rads = (v) => `${v.toFixed(1)} rad/s`;
  slider("dv-air-pitch", TIRE, "airPitchRate", rads);
  slider("dv-air-roll", TIRE, "airRollRate", rads);
  slider("dv-air-yaw", TIRE, "airYawRate", rads);
  // Pitches the nose toward the direction of travel in flight; 0 = the old
  // dead-flat jump. See the NOSE FOLLOWS THE ARC block in modularRoadVehicle.
  slider("dv-air-arc", TIRE, "airTrajectoryAlign");
  slider("dv-air-resp", TIRE, "airResponse", (v) => v.toFixed(1));
  // Pitch-only convergence: LOWER = the flip ramps in instead of snapping.
  slider("dv-air-presp", TIRE, "airPitchResponse");
  slider("dv-air-lock", TIRE, "airGroundLockout", (v) => `${v.toFixed(2)}s`);
  slider("dv-drag", AERO, "drag");
  slider("dv-down", AERO, "downforce", (v) => v.toFixed(1));

  // Road hold. `loadFloor` is the one to reach for: the assist asks only for
  // what the curve demands, so the CEILING is rarely what the car is feeling —
  // how much load is left on the tyres over the brow is.
  slider("dv-hold-floor", ROAD_HOLD, "loadFloor",
    (v) => (v <= 0 ? "weightless" : v >= 1 ? "planted" : `${Math.round(v * 100)}%`));
  slider("dv-hold-corr", ROAD_HOLD, "correctRate",
    (v) => (v > 0 ? `${(1000 / v).toFixed(0)} ms` : "off"));
  slider("dv-hold-g", ROAD_HOLD, "maxG", (v) => (v ? `${v.toFixed(1)}g` : "off"));
  const holdBtn = $("#dv-hold-on");
  const syncHold = () => {
    holdBtn.textContent = ROAD_HOLD.enabled ? "On" : "Off";
    holdBtn.classList.toggle("on", ROAD_HOLD.enabled);
  };
  holdBtn.addEventListener("click", () => {
    ROAD_HOLD.enabled = !ROAD_HOLD.enabled;
    syncHold();
  });
  syncHold();

  const LAYOUTS = ["AWD", "RWD", "FWD"];
  const layoutBtn = $("#dv-layout");
  layoutBtn.textContent = DRIVETRAIN.layout;
  layoutBtn.addEventListener("click", () => {
    const i = LAYOUTS.indexOf(DRIVETRAIN.layout);
    DRIVETRAIN.layout = LAYOUTS[(i + 1) % LAYOUTS.length];
    layoutBtn.textContent = DRIVETRAIN.layout;
  });

  // Wheel style. The GLB loads asynchronously, so the button stays disabled
  // ("Procedural only") until a model is actually available — and syncWheelBtn
  // is called from refresh(), which the loader fires on success.
  const wheelBtn = $("#dv-wheels");
  function syncWheelBtn() {
    if (!wheelBtn) return;
    const glb = game.getWheelStyle() === "glb";
    const has = game.hasWheelModel();
    wheelBtn.textContent = glb ? "Lotus GLB" : has ? "Procedural" : "Procedural only";
    wheelBtn.disabled = !has;
    wheelBtn.classList.toggle("primary", glb);
  }
  wheelBtn?.addEventListener("click", () => {
    game.setWheelStyle(game.getWheelStyle() === "glb" ? "procedural" : "glb");
    syncWheelBtn();
  });
  syncWheelBtn();

  // Chassis style — same async-load pattern as the wheels. Unlike the wheels this
  // changes nothing physical (the collision box is unchanged), so it is a pure
  // visual A/B.
  const chassisBtn = $("#dv-chassis");
  function syncChassisBtn() {
    if (!chassisBtn) return;
    const glb = game.getChassisStyle?.() === "glb";
    const has = !!game.hasChassisModel?.();
    chassisBtn.textContent = glb ? "Emira GT4" : has ? "Procedural" : "Procedural only";
    chassisBtn.disabled = !has;
    chassisBtn.classList.toggle("primary", glb);
  }
  chassisBtn?.addEventListener("click", () => {
    game.setChassisStyle?.(game.getChassisStyle?.() === "glb" ? "procedural" : "glb");
    syncChassisBtn();
  });
  syncChassisBtn();

  // Chassis FIT. slider() mutates the CHASSIS_GLB object in place, so all these
  // have to do afterwards is ask the game to re-apply the transform. The GLB may
  // still be loading — the object is captured by the game, so applying before it
  // arrives is a harmless no-op and the sliders keep whatever the user set.
  const chFit = game.getChassisFit?.();
  const chFitIds = ["dv-ch-scale", "dv-ch-x", "dv-ch-y", "dv-ch-z"];
  if (chFit) {
    const apply = () => game.applyChassisFit?.();
    const f3 = (v) => v.toFixed(3);
    slider("dv-ch-scale", chFit, "scale", f3, apply);
    slider("dv-ch-x", chFit, "offsetX", f3, apply);
    slider("dv-ch-y", chFit, "offsetY", f3, apply);
    slider("dv-ch-z", chFit, "offsetZ", f3, apply);

    // Sliders don't re-read their object, so a reset has to push the values back
    // into the inputs by hand or the thumbs lie about what the model is doing.
    const syncFitInputs = () => {
      const map = { "dv-ch-scale": "scale", "dv-ch-x": "offsetX", "dv-ch-y": "offsetY", "dv-ch-z": "offsetZ" };
      for (const [id, key] of Object.entries(map)) {
        const el = $(`#${id}`), out = $(`#${id}-v`);
        if (el) el.value = chFit[key];
        if (out) out.textContent = f3(chFit[key]);
      }
    };
    $("#dv-ch-reset")?.addEventListener("click", () => {
      game.resetChassisFit?.();
      syncFitInputs();
    });
    // Nudging is only half the job — the numbers have to get back into
    // chassisModel.js, so print them in paste-ready form.
    $("#dv-ch-log")?.addEventListener("click", () => {
      console.info(
        "[ModularRoad-v3] CHASSIS_GLB fit:\n"
        + `  scale: ${f3(chFit.scale)},\n  offsetX: ${f3(chFit.offsetX)},\n`
        + `  offsetY: ${f3(chFit.offsetY)},\n  offsetZ: ${f3(chFit.offsetZ)},`,
      );
    });
  } else {
    for (const id of chFitIds) { const el = $(`#${id}`); if (el) el.disabled = true; }
  }

  // ── Track ───────────────────────────────────────────────────────────────────
  // Piece editing. The buttons no-op with no selection; the readout + disabled
  // state come from refresh(), which the game calls after any pick/edit.
  const selPieceEl = $("#dv-sel-piece");
  const pieceBtns = ["dv-piece-replace", "dv-piece-insert", "dv-piece-delete", "dv-piece-level", "dv-piece-gap", "dv-piece-detach", "dv-piece-edges"].map((id) => $(`#${id}`));
  $("#dv-piece-replace")?.addEventListener("click", () => { game.replaceSelected(); refresh(); });
  $("#dv-piece-insert")?.addEventListener("click", () => { game.insertBeforeSelected(); refresh(); });
  $("#dv-piece-delete")?.addEventListener("click", () => { game.deleteSelected(); refresh(); });
  $("#dv-piece-level")?.addEventListener("click", () => { game.levelSelected?.(); refresh(); });
  $("#dv-piece-gap")?.addEventListener("click", () => { game.makeSelectedGap?.(); refresh(); });
  $("#dv-piece-detach")?.addEventListener("click", () => { game.toggleSelectedDetached?.(); refresh(); });
  $("#dv-piece-edges")?.addEventListener("click", () => { game.toggleSelectedEdges?.(); refresh(); });
  const selAttachEl = $("#dv-sel-attach");
  const detachBtn = $("#dv-piece-detach");
  const edgesBtn2 = $("#dv-piece-edges");
  const selTiltEl = $("#dv-sel-tilt");

  toggle("dv-lines", game.getLinesOn(), (on) => game.setLinesOn(on));
  toggle("dv-lines-center", game.getCenterLinesOn?.() ?? false, (on) => game.setCenterLinesOn?.(on));
  toggle("dv-lines-edge", game.getEdgeLinesOn?.() ?? true, (on) => game.setEdgeLinesOn?.(on));
  toggle("dv-lines-bloom", game.getLinesBloom?.() ?? false, (on) => game.setLinesBloom?.(on));
  toggle("dv-terrain", game.getTerrain?.() ?? true, (on) => game.setTerrain?.(on));
  toggle("dv-clouds", game.getClouds?.() ?? false, (on) => game.setClouds?.(on));

  // ── Clouds ──────────────────────────────────────────────────────────────────
  // Bound straight to the live params object: the cloud system's update() copies
  // every field into its uniform each frame, so there is nothing to sync and no
  // rebuild — including bufferScale, which re-sizes its render targets when it
  // sees the value change. `slider` hides any row whose param is missing, so a
  // renamed field degrades to a missing row rather than a dead control.
  const CP = game.cloudParams ?? null;
  slider("dv-cld-cov", CP, "coverage", (v) => v.toFixed(2));
  slider("dv-cld-bias", CP, "coverageBias", (v) => (v > 0 ? "+" : "") + v.toFixed(2));
  slider("dv-cld-covsoft", CP, "coverageSoft", (v) => v.toFixed(2));
  slider("dv-cld-base", CP, "base", (v) => v.toFixed(0) + " m");
  slider("dv-cld-thick", CP, "thickness", (v) => v.toFixed(0) + " m");
  slider("dv-cld-dens", CP, "densityMul", (v) => v.toFixed(3));
  slider("dv-cld-type", CP, "typeBias",
    (v) => (v < 0.4 ? "stratus " : v > 0.6 ? "cumulus " : "") + v.toFixed(2));
  slider("dv-cld-topmin", CP, "cloudTopMin", (v) => v.toFixed(2));
  slider("dv-cld-wind", CP, "windSpeed", (v) => v.toFixed(1) + " m/s");
  slider("dv-cld-winddeg", CP, "windDeg", (v) => v.toFixed(0) + "°");
  slider("dv-cld-sun", CP, "sunIntensity", (v) => v.toFixed(1));
  slider("dv-cld-amb", CP, "ambientIntensity", (v) => v.toFixed(2));
  slider("dv-cld-g", CP, "phaseG", (v) => v.toFixed(2));
  slider("dv-cld-powder", CP, "powder", (v) => v.toFixed(2));
  slider("dv-cld-msfloor", CP, "msFloor", (v) => v.toFixed(2));
  // Cloud quality tier. The buttons are a radio group: the active one is marked with
  // the same primary style the palette uses, so "which tier am I on" is readable at a
  // glance rather than inferred from whether clouds happen to be visible.
  const tierBtns = [...root.querySelectorAll(".dv-tier")];
  const syncTierBtns = () => {
    const cur = game.getCloudTier?.() ?? "volumetric";
    for (const b of tierBtns) b.classList.toggle("primary", b.dataset.tier === cur);
  };
  for (const b of tierBtns) {
    b.addEventListener("click", () => {
      game.setCloudTier?.(b.dataset.tier);
      syncTierBtns();
    syncWxBtns();
    });
  }
  syncTierBtns();

  /*
   * PAINTED DECK. Bound to `game.paintedParams`, which roadGame creates at BOOT and
   * hands to createPaintedClouds by reference — so these keep working across the sky
   * rebuild that a tier switch performs, instead of pointing at a dead copy.
   * `markPaintedTouched` stops re-entering the tier from stomping a coverage the user
   * dialled in here with the volumetric deck's value.
   */
  /* Aerial perspective — a live params object owned by roadGame, present in every
   * tier, so these bind exactly like the painted deck's. */
  /* Sky weather presets. Buttons, not sliders: a preset is a choice, and the values
   * behind it are only meaningful together (see modularRoadWeather.js). */
  const wxBtns = [...root.querySelectorAll(".dv-wx")];
  const syncWxBtns = () => {
    const cur = game.getWeather?.() ?? "fair";
    for (const b of wxBtns) b.classList.toggle("primary", b.dataset.wx === cur);
  };
  for (const b of wxBtns) {
    b.addEventListener("click", () => {
      game.setWeather?.(b.dataset.wx, 6);
      syncWxBtns();
    });
  }
  syncWxBtns();

  const AP = game.aerialParams ?? null;
  const aslider = (id, key, fmt) => slider(id, AP, key, fmt);
  aslider("dv-ap-density", "density", (v) => (v <= 0 ? "off" : v.toFixed(5)));
  aslider("dv-ap-max", "maxAmount", (v) => v.toFixed(2));
  aslider("dv-ap-scaleh", "scaleHeight", (v) => (v / 1000).toFixed(1) + " km");
  aslider("dv-ap-glow", "sunGlow", (v) => v.toFixed(2));
  aslider("dv-ap-glowpow", "sunGlowPow", (v) => v.toFixed(1));

  const PP = game.paintedParams ?? null;
  const pslider = (id, key, fmt) => {
    const s = slider(id, PP, key, fmt);
    document.getElementById(id)?.addEventListener("input", () => game.markPaintedTouched?.());
    return s;
  };
  pslider("dv-pc-cov", "coverage", (v) => v.toFixed(2));
  pslider("dv-pc-den", "densityMul", (v) => v.toFixed(3));
  pslider("dv-pc-erode", "erode", (v) => v.toFixed(2));
  pslider("dv-pc-alt", "altitude", (v) => v.toFixed(0) + " m");
  pslider("dv-pc-thick", "thickness", (v) => v.toFixed(0) + " m");
  pslider("dv-pc-tile", "tile", (v) => v.toFixed(0) + " m");
  pslider("dv-pc-planet", "planetRadiusKm",
    (v) => (v >= 6371 ? v.toFixed(0) + " km (Earth)" : v.toFixed(0) + " km"));
  pslider("dv-pc-topmin", "topMin", (v) => v.toFixed(2));
  pslider("dv-pc-steps", "steps", (v) => v.toFixed(0) + " steps");
  pslider("dv-pc-sun", "sunStrength", (v) => v.toFixed(2));
  pslider("dv-pc-amb", "ambient", (v) => v.toFixed(2));
  pslider("dv-pc-basedark", "baseDark", (v) => v.toFixed(2));
  pslider("dv-pc-absorb", "absorb", (v) => v.toFixed(1));
  pslider("dv-pc-silver", "silver", (v) => v.toFixed(2));
  pslider("dv-pc-aerial", "aerial", (v) => v.toFixed(2));
  pslider("dv-pc-cirrus", "cirrusAmount", (v) => (v <= 0 ? "off" : v.toFixed(2)));
  pslider("dv-pc-cirruscov", "cirrusCoverage", (v) => v.toFixed(2));
  pslider("dv-pc-cirrusalt", "cirrusAltitude", (v) => (v / 1000).toFixed(1) + " km");
  pslider("dv-pc-cirrustile", "cirrusTile", (v) => (v / 1000).toFixed(1) + " km");
  pslider("dv-pc-cirrusstretch", "cirrusStretch", (v) => v.toFixed(1) + "\u00d7");
  pslider("dv-pc-cirrussilver", "cirrusSilver", (v) => v.toFixed(2));
  pslider("dv-pc-rays", "rayStrength", (v) => (v <= 0 ? "off" : v.toFixed(2)));
  pslider("dv-pc-raylen", "rayLength", (v) => v.toFixed(2));
  pslider("dv-pc-raytight", "rayTightness", (v) => v.toFixed(1));
  pslider("dv-pc-raysteps", "raySteps", (v) => v.toFixed(0) + " steps");
  pslider("dv-pc-shadow", "shadowStrength", (v) => (v <= 0 ? "off" : v.toFixed(2)));
  pslider("dv-pc-shadowsoft", "shadowSoftness", (v) => v.toFixed(2));
  pslider("dv-pc-msfloor", "msFloor", (v) => v.toFixed(2));
  pslider("dv-pc-evolve", "evolve", (v) => (v <= 0 ? "frozen" : v.toFixed(3)));
  pslider("dv-pc-cirrusswirl", "cirrusSwirl", (v) => v.toFixed(2));
  pslider("dv-pc-wind", "windSpeed", (v) => v.toFixed(1) + " m/s");
  pslider("dv-pc-winddeg", "windDeg", (v) => v.toFixed(0) + "°");

  slider("dv-cld-rays", CP, "rayStrength", (v) => (v <= 0 ? "off" : v.toFixed(2)));
  slider("dv-cld-shadow", CP, "shadowStrength", (v) => (v <= 0 ? "off" : v.toFixed(2)));
  slider("dv-cld-shadowsoft", CP, "shadowSoftness", (v) => v.toFixed(3));
  // Not a cloud-system param: the sky-colour mix is the GAME's wiring between
  // the sky model and the cloud lighting, so it lives on its own object.
  slider("dv-cld-tint", game.cloudLight ?? null, "skyTint",
    (v) => (v <= 0 ? "neutral grey" : v >= 1 ? "full sky colour" : v.toFixed(2)));
  slider("dv-cld-buf", CP, "bufferScale",
    (v) => `${v.toFixed(2)}× · ${(v * v * 100).toFixed(0)}% of the pixels`);
  slider("dv-cld-steps", CP, "steps", (v) => v.toFixed(0));
  slider("dv-cld-maxstep", CP, "maxStep", (v) => v.toFixed(0) + " m");
  slider("dv-cld-hist", CP, "historyBlend",
    (v) => (v <= 0 ? "off (raw march)" : `${(1 / Math.max(1 - v, 1e-3)).toFixed(0)}-frame avg`));
  // Road-surface uniforms are TSL `uniform()` objects, so the slider / colour
  // helpers drive their `.value` directly — every change is live, no rebuild.
  // Colours live in linear space in the shader; the picker shows sRGB.
  // BOUND BY NAME, so they survive a material swap on their own — see
  // `roadSlider`. This used to be a function the cheap-deck A/B re-ran to
  // "rebind", which both stacked a duplicate listener per toggle and left every
  // OTHER rebuild path (wet / anisotropy / grit / line relief crossing zero)
  // with dead knobs, because nothing re-ran it there.
  roadColor("dv-road-dark", "asphaltDark");
  roadColor("dv-road-light", "asphaltLight");
  roadColor("dv-road-side", "sideColor");
  roadColor("dv-road-kerb", "railA");
  roadSlider("dv-road-bright", "deckBrightness", (v) => `${v.toFixed(2)}×`);
  roadSlider("dv-road-grain", "grainScale", (v) => v.toFixed(2));
  roadSlider("dv-road-agg", "aggScale", (v) => `${v.toFixed(1)}/m`);
  roadSlider("dv-road-rvary", "roughVary", (v) => v.toFixed(2));
  roadSlider("dv-road-polish", "wheelPolish", (v) => v.toFixed(2));
  roadSlider("dv-road-wdark", "wheelDarken", (v) => v.toFixed(2));
  // The paint's SHADING half — plain look uniforms, so they poke live and ride
  // ROAD_LOOK into the track save. Its RELIEF half is on the surface below.
  roadSlider("dv-road-linerough", "lineRough", (v) => v.toFixed(2));
  roadSlider("dv-road-linewet", "lineWet", (v) => v.toFixed(2));
  roadSlider("dv-road-linecoat", "lineCoat", (v) => `${v.toFixed(2)}×`);
  // Tar snakes. Plain uniforms — no build gate, because the whole field is a
  // fract/abs/smoothstep on `surface.x`, which the deck has already computed.
  // See the note on tarSnakeAmount: there is no noise here to compile out.
  roadSlider("dv-road-tarsnake", "tarSnakeAmount", (v) => (v === 0 ? "off" : v.toFixed(2)));
  roadSlider("dv-road-tarsnakescale", "tarSnakeScale", (v) => v.toFixed(1));
  roadSlider("dv-road-tarsnakewidth", "tarSnakeWidth", (v) => v.toFixed(3));
  roadSlider("dv-road-tarsnakebreak", "tarSnakeBreak", (v) => (v === 0 ? "continuous" : v.toFixed(2)));
  roadSlider("dv-road-tarsnakegloss", "tarSnakeGloss", (v) => v.toFixed(2));
  roadColor("dv-road-tarsnakecol", "tarSnakeColor");
  // HISTORICAL RUBBER — the marks that were already on the track before you
  // drove it. These uniforms have existed and shipped ON (driftAmount 1.4)
  // since the field was written; nothing had ever exposed them, so they were
  // tunable in a look file and untunable in the game.
  roadSlider("dv-road-drift", "driftAmount", (v) => (v === 0 ? "clean track" : v.toFixed(2)));
  roadSlider("dv-road-driftw", "driftWidth", (v) => v.toFixed(2));
  roadSlider("dv-road-driftbias", "driftBias", (v) => v.toFixed(2));
  roadSlider("dv-road-driftref", "driftCurveRef",
    (v) => `${v.toFixed(3)} · R${(1 / Math.max(v, 1e-4)).toFixed(0)}m`);
  roadSlider("dv-road-driftlines", "driftLines", (v) => v.toFixed(0));
  roadSlider("dv-road-driftwander", "driftWander", (v) => v.toFixed(1));
  // Wavelength of the sideways drift, shown as the period in metres — the
  // number that decides "driven line" vs "slalom". Low = long, straight runs.
  roadSlider("dv-road-driftwscale", "driftWanderScale",
    (v) => `${(1 / Math.max(v, 1e-4)).toFixed(0)} m`);
  roadSlider("dv-road-driftgloss", "driftGloss", (v) => v.toFixed(2));
  const surface = {
    bump: game.getBump?.() ?? 0.05,
    streak: game.getStreakSharp?.() ?? 0,
    joints: game.getJointSpacing?.() ?? 12,
    // The chip octave and the tap filter are plain uniforms — no build gate to
    // cross — so they go through the generic accessor rather than earning four
    // more named setters. They still land in `surfaceLook`, so they save.
    chip: game.getSurface?.("bumpChip") ?? 0.7,
    chipScale: game.getSurface?.("bumpChipScale") ?? 16,
    chipFade: game.getSurface?.("bumpChipFade") ?? 2.0,
    bumpFilter: game.getSurface?.("bumpFilter") ?? 1,
    lineBump: game.getSurface?.("lineBump") ?? 0.4,
    lineFill: game.getSurface?.("lineFill") ?? 0.85,
    grit: game.getSurface?.("bumpGrit") ?? 0,
  };
  slider("dv-road-bump", surface, "bump", (v) => v.toFixed(3), (v) => game.setBump?.(v));
  slider("dv-road-chip", surface, "chip", (v) => v.toFixed(2), (v) => game.setSurface?.("bumpChip", v));
  slider("dv-road-chipscale", surface, "chipScale",
    (v) => `${v.toFixed(0)}/m · ${(100 / v).toFixed(0)} cm`,
    (v) => game.setSurface?.("bumpChipScale", v));
  slider("dv-road-chipfade", surface, "chipFade", (v) => v.toFixed(1), (v) => game.setSurface?.("bumpChipFade", v));
  slider("dv-road-bumpfilter", surface, "bumpFilter",
    (v) => (v === 0 ? "fixed 4 mm" : v.toFixed(2)),
    (v) => game.setSurface?.("bumpFilter", v));
  // Crossing 0 on either of these is a material REBUILD, not a poke — the paint
  // mask is compiled into the height taps or it is not. setSurface handles that.
  slider("dv-road-linebump", surface, "lineBump",
    (v) => (v === 0 ? "flat" : v.toFixed(2)),
    (v) => game.setSurface?.("lineBump", v));
  slider("dv-road-linefill", surface, "lineFill",
    (v) => (v === 0 ? "off" : v.toFixed(2)),
    (v) => game.setSurface?.("lineFill", v));
  // Ships OFF: the chase camera fades this octave to zero on every pixel, so in
  // game it was three noise evaluations per fragment returning a certain zero.
  slider("dv-road-grit", surface, "grit",
    (v) => (v === 0 ? "off (unseen)" : v.toFixed(2)),
    (v) => game.setSurface?.("bumpGrit", v));

  // ── ANISOTROPIC SPECULAR ────────────────────────────────────────────────
  // `anisotropy` crossing 0 REBUILDS the material (three swaps in the
  // anisotropic BRDF the moment the node exists), so it goes through setLook
  // rather than poking the uniform. The other three are plain pokes.
  const aniso = {
    on: game.getLook?.("anisotropy") ?? 0,
    angle: game.getLook?.("anisotropyAngle") ?? 0,
    wheel: game.getLook?.("anisoWheel") ?? 0.6,
    wet: game.getLook?.("anisoWet") ?? 0.7,
  };
  slider("dv-road-aniso", aniso, "on",
    (v) => (v === 0 ? "off" : v.toFixed(2)),
    (v) => game.setLook?.("anisotropy", v));
  slider("dv-road-anisoang", aniso, "angle",
    (v) => (v === 0 ? "0° along road" : (Math.abs(v) === 90 ? "90° across" : `${v.toFixed(0)}°`)),
    (v) => game.setLook?.("anisotropyAngle", v));
  slider("dv-road-anisowheel", aniso, "wheel", (v) => `+${(v * 100).toFixed(0)}%`,
    (v) => game.setLook?.("anisoWheel", v));
  slider("dv-road-anisowet", aniso, "wet", (v) => v.toFixed(2),
    (v) => game.setLook?.("anisoWet", v));
  slider("dv-road-streak", surface, "streak", (v) => v.toFixed(2), (v) => game.setStreakSharp?.(v));
  slider("dv-road-joints", surface, "joints", (v) => v === 0 ? "off" : `${v.toFixed(0)} m`, (v) => game.setJointSpacing?.(v));
  toggle("dv-road-front", game.getRoadFrontSide?.() ?? true, (on) => game.setRoadFrontSide?.(on));
  // A/B against the floor: no procedural surface at all. Rebuilds the material
  // and re-runs this whole binding pass, so the knobs the cheap deck does not
  // have hide themselves (see the `!obj` branch in `slider`).
  toggle("dv-road-cheap", game.getCheapRoad?.() ?? false, (on) => {
    game.setCheapRoad?.(on);
    // Re-read only. The writes already follow the new material by themselves;
    // this is what re-hides the rows the cheap deck has no uniform for.
    requestAnimationFrame(refreshRoadLook);
  });
  // Guardrails are a plain MeshStandardMaterial, so these drive it directly.
  const rm = game.railMaterial;
  if (rm) {
    slider("dv-rail-metal", rm, "metalness", (v) => v.toFixed(2));
    slider("dv-rail-rough", rm, "roughness", (v) => v.toFixed(2));
  }
  toggle("dv-showcol", false, (on) => game.setCollisionDebug(on));
  toggle("dv-inst", true, (on) => game.setInstancing(on));
  $("#dv-rebake").addEventListener("click", () => game.bakeCollision());
  // The bake takes seconds and nothing else on screen moves while it runs, so
  // the button IS the progress indicator.
  $("#dv-rebake-thumbs")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Baking thumbnails…";
    try {
      await game.rebakeThumbnails?.();
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  // ── Lights ──────────────────────────────────────────────────────────────────
  const lightsToggle = toggle("dv-lights", false, (on) => {
    game.setAutoHeadlights(false);   // manual click takes over from auto
    autoToggle.set(false);
    game.setHeadlights(on);
  });
  const autoToggle = toggle("dv-lights-auto", false, (on) => game.setAutoHeadlights(on));
  slider("dv-lamp", HEADLIGHTS, "lampEmissive", (v) => v.toFixed(1), () => game.refreshLights());
  // The GLB car's own lamps. Plain config objects read by the vehicle every
  // frame (_updateTaillights), so no refresh call is needed — the next frame
  // picks them up. Shown with the tail:brake ratio, which is the number that
  // actually decides whether braking reads.
  slider("dv-tail-run", CHASSIS_GLB_LIGHTS, "runningIntensity",
    (v) => `${v.toFixed(2)} · 1:${(CHASSIS_GLB_LIGHTS.brakeIntensity / Math.max(v, 0.01)).toFixed(1)}`);
  slider("dv-tail-brake", CHASSIS_GLB_LIGHTS, "brakeIntensity", (v) => v.toFixed(1));
  slider("dv-glb-lamp", CHASSIS_GLB_LIGHTS, "headlampIntensity", (v) => v.toFixed(2));
  slider("dv-beam", HEADLIGHTS, "intensity", (v) => v.toFixed(0), () => game.refreshLights());

  // ── Sky (game-owned, A/B against the engine's) ──────────────────────────────
  // The sky is built lazily on first switch-on, so `game.setAtmosphereMix` is a
  // no-op until then. The mix therefore lives HERE, in a small holder, and is
  // pushed into the sky each time it is switched on — otherwise moving the
  // slider before ever pressing F8 would silently lose the value.
  const skyAB = { mix: game.getAtmosphereMix?.() ?? 1 };
  const gameSkyToggle = toggle("dv-gamesky", game.getGameSky?.() ?? false, (on) => {
    game.setGameSky?.(on);
    if (on) game.setAtmosphereMix?.(skyAB.mix);
  });
  slider("dv-sky-atmo", skyAB, "mix",
    (v) => (v <= 0 ? "gradient" : v >= 1 ? "physical" : v.toFixed(2)),
    (v) => game.setAtmosphereMix?.(v));

  // ── Weather ─────────────────────────────────────────────────────────────────
  // `wetAmount` at 0 is not merely invisible, it decides which MATERIAL the road
  // is built from (see setWet in roadGame): crossing 0 swaps a plain Standard
  // material for a Physical one with a clearcoat lobe, and back. So the slider
  // is a build trigger at one end of its range and a uniform everywhere else.
  const weather = {
    wet: game.getWet?.() ?? 0,
    puddles: game.getPuddles?.() ?? 1,
    dryLine: game.getWheelClear?.() ?? 0.45,
    reflectStrength: game.getReflectStrength?.() ?? 1.4,
    reflectFlat: game.getReflectFlat?.() ?? 0.8,
    reflectPlane: game.getReflectPlane?.() ?? 0.7,
    reflectSlab: game.getReflectSlab?.() ?? 3.0,
    railReflect: game.getRailReflect?.() ?? 1.0,
  };
  slider("dv-wet", weather, "wet", (v) => v.toFixed(2), (v) => game.setWet?.(v));
  slider("dv-wet-puddle", weather, "puddles", (v) => v.toFixed(2), (v) => game.setPuddles?.(v));
  slider("dv-wet-wheel", weather, "dryLine", (v) => v.toFixed(2), (v) => game.setWheelClear?.(v));
  // The dark rim at a puddle's edge — what gives standing water depth instead of
  // reading as a patch of gloss. Plain look uniforms, so they poke live.
  // Bound by name like the rest of the look. These two reached through
  // `game.roadMaterial._roadUniforms` and sat OUTSIDE the old rebind pass, so
  // they died on the first material swap and nothing ever revived them.
  roadSlider("dv-wet-waterline", "waterlineDark", (v) => (v === 0 ? "off" : v.toFixed(2)));
  roadSlider("dv-wet-waterlinew", "waterlineSharp", (v) => v.toFixed(1));
  toggle("dv-reflect", true, (on) => game.setReflection?.(on));
  // SEEDED FROM THE GAME, not from a literal. It was hard-coded `false` while
  // roadGame defaults it on, so the box read unchecked with the reflection
  // plainly visible — and the first click then "turned on" what was already on
  // and appeared to do nothing at all.
  toggle("dv-reflect-rails", game.getRailsInMirror?.() ?? true,
    (on) => game.setRailsInMirror?.(on));
  slider("dv-reflect-str", weather, "reflectStrength", (v) => v.toFixed(2),
    (v) => game.setReflectStrength?.(v));
  // How far up the reflection's mip chain a ROUGH bit of road reaches. It is
  // scaled by the coat roughness per fragment, so puddles stay near-sharp while
  // the damp film between them smears — turn it to 0 to get the old always-LOD-0
  // look back, staircased neon and all.
  // ── Rain on the lens ────────────────────────────────────────────────────
  //
  // Bound against the game rather than a local object, because the uniforms
  // live with the effect — `setRainParam` is a uniform write, so every one of
  // these is live with no rebuild.
  toggle("dv-rain", game.getRain?.() ?? false, (on) => game.setRain?.(on));
  const rainSlider = (id, key, fmt) => {
    const el = $(`#${id}`);
    const out = $(`#${id}-v`);
    if (!el) return;
    const initial = game.getRainParam?.(key);
    if (initial != null) el.value = String(initial);
    if (out) out.textContent = fmt(+el.value);
    el.addEventListener("input", () => {
      const v = +el.value;
      game.setRainParam?.(key, v);
      if (out) out.textContent = fmt(v);
    });
  };
  rainSlider("dv-rain-amount", "amount", (v) => v.toFixed(2));
  rainSlider("dv-rain-density", "beadDensity", (v) => v.toFixed(1));
  rainSlider("dv-rain-size", "beadSize", (v) => v.toFixed(2));
  rainSlider("dv-rain-blur", "dropBlur", (v) => v.toFixed(3));
  rainSlider("dv-rain-runners", "runnerFill", (v) => v.toFixed(2));
  {
    const el = $("#dv-rain-lean");
    const out = $("#dv-rain-lean-v");
    if (el) {
      el.value = String(game.getRainLean?.() ?? 0.9);
      if (out) out.textContent = (+el.value).toFixed(2);
      el.addEventListener("input", () => {
        game.setRainLean?.(+el.value);
        if (out) out.textContent = (+el.value).toFixed(2);
      });
    }
  }

  if (weather.reflectBlur === undefined) weather.reflectBlur = game.getReflectBlur?.() ?? 3.2;
  slider("dv-reflect-blur", weather, "reflectBlur", (v) => v.toFixed(1),
    (v) => game.setReflectBlur?.(v));
  // How far the reflection is drawn out VERTICALLY, which is what separates a
  // wet road from a merely blurry one. Scaled per fragment by coat roughness,
  // so puddles stay crisp while the damp film between them streaks.
  if (weather.reflectStretch === undefined) weather.reflectStretch = game.getReflectStretch?.() ?? 0.25;
  slider("dv-reflect-smear", weather, "reflectStretch", (v) => v.toFixed(2),
    (v) => game.setReflectStretch?.(v));
  // The two knobs that decide where a planar mirror is allowed to be believed.
  // "Max error" is the one for banks, crests and dips: metres of reflection
  // displacement tolerated before the reflection fades. Turn it DOWN if
  // guardrails look inverted or smeared on sloped pieces.
  slider("dv-reflect-flat", weather, "reflectFlat", (v) => v.toFixed(2),
    (v) => game.setReflectFlat?.(v));
  slider("dv-reflect-plane", weather, "reflectPlane", (v) => v.toFixed(2),
    (v) => game.setReflectPlane?.(v));
  // THE one that fixes inverted guardrails on crests, dips and banks: geometry
  // further than this from the mirror plane is clipped out of the pass entirely,
  // so it can never be reflected to the wrong place. Lower = stricter.
  slider("dv-reflect-slab", weather, "reflectSlab", (v) => v.toFixed(2),
    (v) => game.setReflectSlab?.(v));
  // The guardrail's reflection, drawn as MIRRORED GEOMETRY seen by the normal
  // camera rather than through the mirror — see modularRoadWet.js. 1 is the
  // physically right answer here; the "Rails in mirror" toggle above turns the
  // whole extra pass off.
  slider("dv-rail-reflect", weather, "railReflect", (v) => v.toFixed(2),
    (v) => game.setRailReflect?.(v));

  // ── POST FX + FOG: the v3 editor's WORLD menu, ported ───────────────────────
  //
  // Bound STRAIGHT to `app.postFx.state` / `app.fog.state`, which is the same
  // object the editor's World tab edits — so a slider here reads the engine's
  // real value and the two can never disagree. The bloom rows used to bind to a
  // LOCAL `{ strength: 0.9, radius: 0.5 }` instead, which meant they showed
  // those two numbers whatever the engine actually had.
  //
  // `applyPostFxState` is not on the game's app handle (the editor gets it
  // passed in separately), and only `setEnabled`/`setBloom` re-apply the whole
  // pipeline. So the sync is `setEnabled` with the CURRENT value: a no-op on
  // the state, a full re-apply of everything else.
  const pfx = app.postFx?.state ?? null;
  const fog = app.fog?.state ?? null;
  const syncPostFx = () => app.postFx?.setEnabled(pfx?.enabled ?? true);

  toggle("dv-pfx", pfx?.enabled !== false, (on) => app.postFx?.setEnabled(on));
  toggle("dv-pfx-fxaa", pfx?.fxaa?.enabled ?? false, (on) => {
    if (pfx?.fxaa) { pfx.fxaa.enabled = on; syncPostFx(); }
  });

  toggle("dv-bloom", pfx?.bloom?.enabled !== false,
    (on) => app.postFx?.setBloom({ enabled: on }));
  slider("dv-bloom-str", pfx?.bloom ?? null, "strength", (v) => v.toFixed(2), syncPostFx);
  slider("dv-bloom-rad", pfx?.bloom ?? null, "radius", (v) => v.toFixed(2), syncPostFx);
  slider("dv-bloom-thr", pfx?.bloom ?? null, "threshold", (v) => v.toFixed(2), syncPostFx);
  slider("dv-bloom-smooth", pfx?.bloom ?? null, "smoothWidth", (v) => v.toFixed(2), syncPostFx);
  slider("dv-glow", glowPropParams, "intensity", (v) => v.toFixed(1),
    () => game.refreshGlowProps());

  // Colour / vignette / grain all ride the one `polish` pass.
  toggle("dv-pfx-polish", pfx?.polish?.enabled ?? false, (on) => {
    if (pfx?.polish) { pfx.polish.enabled = on; syncPostFx(); }
  });
  const P = pfx?.polish ?? null;
  slider("dv-pfx-bright", P, "brightness", (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-contrast", P, "contrast", (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-sat", P, "saturation", (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-temp", P, "temperature",
    (v) => (v > 0 ? "warm " : v < 0 ? "cool " : "") + v.toFixed(2), syncPostFx);
  slider("dv-pfx-tint", P, "tint", (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-vig", P, "vignetteStrength", (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-vigfall", P, "vignetteFalloff", (v) => v.toFixed(2), syncPostFx);
  colorField("dv-pfx-vigcol", P, "vignetteColor", syncPostFx);
  slider("dv-pfx-grain", P, "grainStrength", (v) => v.toFixed(3), syncPostFx);
  slider("dv-pfx-grainsz", P, "grainSize", (v) => v.toFixed(2), syncPostFx);

  toggle("dv-pfx-sharp", pfx?.sharpen?.enabled ?? false, (on) => {
    if (pfx?.sharpen) { pfx.sharpen.enabled = on; syncPostFx(); }
  });
  slider("dv-pfx-sharpness", pfx?.sharpen ?? null, "sharpness", (v) => v.toFixed(2), syncPostFx);
  toggle("dv-pfx-denoise", pfx?.sharpen?.denoise ?? false, (on) => {
    if (pfx?.sharpen) { pfx.sharpen.denoise = on; syncPostFx(); }
  });

  toggle("dv-pfx-ca", pfx?.chromaticAberration?.enabled ?? false, (on) => {
    if (pfx?.chromaticAberration) { pfx.chromaticAberration.enabled = on; syncPostFx(); }
  });
  slider("dv-pfx-ca-str", pfx?.chromaticAberration ?? null, "strength",
    (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-ca-scale", pfx?.chromaticAberration ?? null, "scale",
    (v) => v.toFixed(3), syncPostFx);

  toggle("dv-pfx-dof", pfx?.dof?.enabled ?? false, (on) => {
    if (pfx?.dof) { pfx.dof.enabled = on; syncPostFx(); }
  });
  slider("dv-pfx-dof-dist", pfx?.dof ?? null, "focusDistance", (v) => v.toFixed(0) + " m", syncPostFx);
  slider("dv-pfx-dof-len", pfx?.dof ?? null, "focalLength", (v) => v.toFixed(0) + " mm", syncPostFx);
  slider("dv-pfx-dof-bokeh", pfx?.dof ?? null, "bokehScale", (v) => v.toFixed(1), syncPostFx);

  const SS = pfx?.ssao ?? null;
  toggle("dv-pfx-ssao", SS?.enabled ?? false, (on) => {
    if (SS) { SS.enabled = on; syncPostFx(); }
  });
  cycleField("dv-pfx-ssao-q", SS, "quality",
    ["Performance", "Low", "Medium", "High", "Ultra"],
    ["Performance", "Low", "Medium", "High", "Ultra"], syncPostFx);
  slider("dv-pfx-ssao-rad", SS, "aoRadius", (v) => v.toFixed(1), syncPostFx);
  slider("dv-pfx-ssao-fall", SS, "distanceFalloff", (v) => v.toFixed(2), syncPostFx);
  slider("dv-pfx-ssao-int", SS, "intensity", (v) => v.toFixed(1), syncPostFx);
  colorField("dv-pfx-ssao-col", SS, "color", syncPostFx);
  toggle("dv-pfx-ssao-half", SS?.halfRes ?? false, (on) => { if (SS) { SS.halfRes = on; syncPostFx(); } });
  toggle("dv-pfx-ssao-dau", SS?.depthAwareUpsampling ?? false,
    (on) => { if (SS) { SS.depthAwareUpsampling = on; syncPostFx(); } });
  toggle("dv-pfx-ssao-ssr", SS?.screenSpaceRadius ?? false,
    (on) => { if (SS) { SS.screenSpaceRadius = on; syncPostFx(); } });
  cycleField("dv-pfx-ssao-disp", SS, "displayMode",
    ["Combined", "AO", "No AO", "Split", "Split AO"],
    ["Combined", "AO only", "No AO", "Split", "Split AO"], syncPostFx);

  // ── Fog ─────────────────────────────────────────────────────────────────────
  // setDistance/setHeight Object.assign then sync, so passing {} re-syncs after
  // a direct field write — same trick as syncPostFx above.
  const syncFogD = () => app.fog?.setDistance({});
  const syncFogH = () => app.fog?.setHeight({});
  const FD = fog?.distance ?? null, FH = fog?.height ?? null;

  toggle("dv-fog-d", FD?.enabled ?? false, (on) => app.fog?.setDistance({ enabled: on }));
  slider("dv-fog-d-dens", FD, "density", (v) => v.toFixed(4), syncFogD);
  toggle("dv-fog-d-match", FD?.matchSky ?? true, (on) => app.fog?.setDistance({ matchSky: on }));
  colorField("dv-fog-d-col", FD, "color", syncFogD);
  colorField("dv-fog-d-sun", FD, "sunTint", syncFogD);
  slider("dv-fog-d-pow", FD, "tintPow", (v) => v.toFixed(1), syncFogD);

  toggle("dv-fog-h", FH?.enabled ?? false, (on) => app.fog?.setHeight({ enabled: on }));
  slider("dv-fog-h-dens", FH, "density", (v) => v.toFixed(3), syncFogH);
  slider("dv-fog-h-fall", FH, "falloff", (v) => v.toFixed(3), syncFogH);
  slider("dv-fog-h-base", FH, "height", (v) => v.toFixed(0) + " m", syncFogH);
  colorField("dv-fog-h-col", FH, "color", syncFogH);

  // ── Audio ───────────────────────────────────────────────────────────────────
  const audio = game.audioState;
  const va = game.vehicleAudioSettings;
  toggle("dv-mute", !!audio.muteAll, (on) => { audio.muteAll = on; });
  slider("dv-vol", audio.buses.master, "volume", (v) => `${Math.round(v * 100)}%`);
  slider("dv-bus-veh", audio.buses.vehicle, "volume", (v) => `${Math.round(v * 100)}%`);

  const pct = (v) => `${Math.round(v * 100)}%`;
  slider("dv-a-engine", va, "engineVol", pct);
  slider("dv-a-wind", va, "windMul", pct);
  slider("dv-a-wheels", va, "wheelsMul", pct);
  slider("dv-a-drift", va, "driftBrakeMul", pct);
  slider("dv-p-min", va, "enginePitchMin");
  slider("dv-p-max", va, "enginePitchMax");

  // ── FX ──────────────────────────────────────────────────────────────────────
  toggle("dv-marks", true, (on) => game.setTireMarksEnabled(on));
  // Live A/B between the flat ribbon and the textured skid decal.
  const skidBtn = $("#dv-skid-style");
  const syncSkidBtn = () => {
    if (skidBtn) skidBtn.textContent = game.getSkidStyle?.() === "textured" ? "Textured" : "Solid";
  };
  skidBtn?.addEventListener("click", () => { game.toggleSkidStyle?.(); syncSkidBtn(); });
  syncSkidBtn();
  toggle("dv-smoke", true, (on) => game.setDriftSmokeEnabled(on));
  // Smoke look.  is driven directly and lifeMin follows at 45% of it —
  // two independent life sliders is a fiddly way to say "longer plume".
  // Stochastic terrain tiling — OPT-IN, off unless the key is exactly "true".
  //
  // MUST MATCH stochasticTex.js's own test (`=== "true"`), which is the source
  // of truth: it is read once at module load and decides whether the extra taps
  // are compiled into the shader at all. This used to read `!== "false"`, the
  // old default, so with the key unset the button claimed "On" while the shader
  // had been built with it OFF — a toggle that lied about the state it toggles.
  //
  // The label no longer quotes ~5ms: measured on this project it is 0.13 ms
  // (4.98 vs 4.85 ms). It is off because it is unused, not because it is dear.
  //
  // Flipping RELOADS the page, since the graph is built at load — hence a
  // button rather than a switch that would appear to do nothing.
  const stochBtn = $("#dv-stoch");
  if (stochBtn) {
    const stochOn = () => localStorage.getItem("terrain_stochastic") === "true";
    stochBtn.textContent = stochOn() ? "On" : "Off";
    stochBtn.classList.toggle("primary", stochOn());
    stochBtn.title = "Hides terrain texture repetition (~0.13 ms). Reloads the page.";
    stochBtn.addEventListener("click", () => {
      localStorage.setItem("terrain_stochastic", stochOn() ? "false" : "true");
      location.reload();
    });
  }

  // ── World light ─────────────────────────────────────────────────────────────
  // Lighting is not stored in the .v3proj, so these edit LIVE engine state that
  // the game seeded at boot. The engine re-reads light/sky every frame through
  // its own snapshot dirty-check, so a plain slider() write is enough — EXCEPT
  // time of day, which must recompute the sun's astronomical position.
  const lightState = game.getLightState?.();
  const skyState = game.getSkyState?.();
  if (lightState && skyState) {
    const hhmm = (v) => {
      const h = Math.floor(v), m = Math.round((v - h) * 60);
      return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    };
    slider("dv-tod", skyState, "timeOfDay", hhmm, (v) => game.setTimeOfDay?.(v));
    slider("dv-exposure", lightState, "exposure");
    slider("dv-sun-int", lightState, "dirIntensity");
    slider("dv-hemi", lightState, "hemiIntensity");
    slider("dv-env", lightState, "envIntensity");
    slider("dv-sky-ray", skyState, "rayleigh");
    slider("dv-sky-mie", skyState, "mie");
    slider("dv-sky-glow", skyState, "sunGlowStrength");
    $("#dv-light-log")?.addEventListener("click", () => {
      const f = (v) => Number(v).toFixed(2);
      // Paste-ready: lighting is not saved anywhere, so a look you like has to
      // get back into roadGame.js by hand or it dies with the tab.
      console.info(
        [
          "[ModularRoad-v3] lighting — paste into roadGame.js:",
          "  startV3App({ light: {",
          `    exposure: ${f(lightState.exposure)},`,
          `    dirIntensity: ${f(lightState.dirIntensity)},`,
          `    hemiIntensity: ${f(lightState.hemiIntensity)},`,
          `    envIntensity: ${f(lightState.envIntensity)},`,
          "  } })",
          `  app.sky.setTimeOfDay(${f(skyState.timeOfDay)});`,
          `  app.sky.set({ rayleigh: ${f(skyState.rayleigh)}, `
            + `mie: ${f(skyState.mie)}, sunGlowStrength: ${f(skyState.sunGlowStrength)} });`,
        ].join("\n"),
      );
    });
  }

  // ── Selected-flag cloth (Prop livery) ─────────────────────────────────────
  // Image and colour are PER FLAG, like a billboard advert. Wave/speed still
  // tune the shared shader for that shape (banner vs country).
  const flagWrap = $("#dv-flag-prop");
  const flagFile = $("#dv-flag-file");
  const flagCol = $("#dv-flag-color");
  const flagAmp = $("#dv-flag-amp");
  const flagAmpV = $("#dv-flag-amp-v");
  const flagSpeed = $("#dv-flag-speed");
  const flagSpeedV = $("#dv-flag-speed-v");
  $("#dv-flag-img")?.addEventListener("click", () => flagFile?.click());
  flagFile?.addEventListener("change", async () => {
    const f = flagFile.files?.[0];
    flagFile.value = "";
    if (!f) return;
    await game.setPropFlagFile?.(f);
    refresh();
  });
  $("#dv-flag-clear")?.addEventListener("click", () => {
    game.clearPropFlagImage?.();
    refresh();
  });
  flagCol?.addEventListener("input", () => {
    game.setPropFlagColor?.(flagCol.value, { commit: false });
  });
  flagCol?.addEventListener("change", () => {
    game.setPropFlagColor?.(flagCol.value, { commit: true });
    refresh();
  });
  flagAmp?.addEventListener("input", () => {
    const style = game.getSelectedFlagStyle?.();
    if (!style) return;
    style.amplitude = +flagAmp.value;
    if (flagAmpV) flagAmpV.textContent = style.amplitude.toFixed(2);
    game.applySelectedFlagParams?.();
  });
  flagSpeed?.addEventListener("input", () => {
    const style = game.getSelectedFlagStyle?.();
    if (!style) return;
    style.speed = +flagSpeed.value;
    if (flagSpeedV) flagSpeedV.textContent = style.speed.toFixed(1);
    game.applySelectedFlagParams?.();
  });

  const spk = game.getSparkSettings?.();
  if (spk) {
    toggle("dv-sparks", spk.enabled !== false, (on) => { spk.enabled = on; });
    slider("dv-spk-rate", spk, "emitRate", (v) => v.toFixed(0));
    slider("dv-spk-int", spk, "intensity");
    slider("dv-spk-str", spk, "stretch", (v) => v.toFixed(3));
  }
  const smk = game.getDriftSmokeSettings?.();
  if (smk) {
    slider("dv-smk-rate", smk, "emitRate", (v) => v.toFixed(0));
    slider("dv-smk-op", smk, "opacity");
    slider("dv-smk-life", smk, "lifeMax", (v) => v.toFixed(2) + "s",
      (v) => { smk.lifeMin = v * 0.45; });
    slider("dv-smk-grow", smk, "sizeGrowth");
    slider("dv-smk-turb", smk, "turbulence");
    slider("dv-smk-buoy", smk, "buoyancy");
    slider("dv-smk-sun", smk, "sunTint");
    slider("dv-smk-amb", smk, "ambient");
    slider("dv-smk-scat", smk, "scatter");
    slider("dv-smk-abs", smk, "absorb");
    slider("dv-smk-noise", smk, "noiseScale");
    slider("dv-smk-drift", smk, "noiseDrift");
    slider("dv-smk-erode", smk, "erodeEnd");
    slider("dv-smk-esoft", smk, "erodeSoft");
    slider("dv-smk-soft", smk, "softDepth", (v) => v.toFixed(2) + "m");
    slider("dv-smk-fuse", smk, "worldNoiseMix");
    slider("dv-smk-fscale", smk, "worldNoiseScale");
    if (smk.haze) {
      const hz = smk.haze;
      toggle("dv-smk-haze", hz.enabled !== false, (on) => { hz.enabled = on; });
      slider("dv-smk-hrate", hz, "emitRate", (v) => v.toFixed(0));
      slider("dv-smk-hop", hz, "opacity", (v) => v.toFixed(3));
      // lifeMin trails lifeMax, same as the puff life slider above.
      slider("dv-smk-hlife", hz, "lifeMax", (v) => v.toFixed(1) + "s",
        (v) => { hz.lifeMin = v * 0.5; });
      slider("dv-smk-hsize", hz, "sizeMax", (v) => v.toFixed(1) + "m",
        (v) => { hz.sizeMin = v * 0.59; });
      slider("dv-smk-hgrow", hz, "sizeGrowth", (v) => "x" + v.toFixed(1));
      slider("dv-smk-hhold", hz, "fadeOutStart");
    }

    // ── WET SPRAY ───────────────────────────────────────────────────────────
    //
    // Same object shape as the puff settings above, because it IS the puff
    // settings — blended in by wetness rather than driving a second system.
    // Nothing here does anything on a dry track, which is why the hint in the
    // markup points at the WEATHER wetness slider.
    const spr = smk.wetSpray;
    if (spr) {
      toggle("dv-spray", spr.enabled !== false, (on) => game.setWetSprayEnabled?.(on));
      slider("dv-spr-rate", spr, "emitRate", (v) => v.toFixed(0));
      slider("dv-spr-op", spr, "opacity", (v) => v.toFixed(3));
      slider("dv-spr-streak", spr, "streak", (v) => "x" + v.toFixed(2));
      // Width is the ACROSS radius now that length comes from `stretch`, so the
      // min trails the max the same way the puff life slider does.
      slider("dv-spr-size", spr, "sizeMax", (v) => v.toFixed(2) + "m",
        (v) => { spr.sizeMin = v * 0.38; });
      slider("dv-spr-side", spr, "sideThrow", (v) => v.toFixed(1) + " m/s");
      slider("dv-spr-life", spr, "lifeMax", (v) => v.toFixed(2) + "s",
        (v) => { spr.lifeMin = v * 0.44; });
      slider("dv-spr-spread", spr, "spread");
      slider("dv-spr-rise", spr, "rise");
      slider("dv-spr-drag", spr, "drag");
      slider("dv-spr-entry", spr, "entrySpeed", (v) => v.toFixed(1) + " m/s");
    }
  }

  // ── Live readouts ───────────────────────────────────────────────────────────
  const piecesEl = $("#dv-pieces");
  const trisEl = $("#dv-tris");
  // ── Prop livery ─────────────────────────────────────────────────────────────
  // Rebuilt on every refresh rather than wired once: the swatches ARE the
  // selected prop's palette, and different prop types have different ones (or
  // none). Cheap — a handful of buttons.
  const liveryName = $("#dv-livery-name");
  const liverySwatches = $("#dv-livery-swatches");
  const liveryRandom = $("#dv-livery-random");
  liveryRandom?.addEventListener("click", () => {
    game.randomisePropVariants?.();
    refresh();
  });

  const decalRow = $("#dv-decal-row");
  const decalToggle = toggle("dv-decal", false, (on) => { game.setPropDecal?.(on); });
  const advertRow = $("#dv-advert-row");
  const advertFile = $("#dv-advert-file");
  $("#dv-advert-upload")?.addEventListener("click", () => advertFile?.click());
  advertFile?.addEventListener("change", async () => {
    const file = advertFile.files?.[0];
    advertFile.value = "";
    if (!file) return;
    await game.setPropAdvertFile?.(file);
    refresh();
  });
  $("#dv-advert-clear")?.addEventListener("click", () => {
    game.clearPropAdvert?.();
    refresh();
  });

  const prismRow = $("#dv-advert-prism-row");
  const prismFile = $("#dv-advert-prism-file");
  let prismFace = 0;
  for (let i = 0; i < 3; i++) {
    $(`#dv-advert-f${i}`)?.addEventListener("click", () => {
      prismFace = i;
      prismFile?.click();
    });
    $(`#dv-advert-c${i}`)?.addEventListener("click", () => {
      game.clearPropAdvert?.(i);
      refresh();
    });
  }
  prismFile?.addEventListener("change", async () => {
    const file = prismFile.files?.[0];
    prismFile.value = "";
    if (!file) return;
    await game.setPropAdvertFile?.(file, prismFace);
    refresh();
  });

  const ledWrap = $("#dv-led-display");
  const ledSource = $("#dv-led-source");
  const ledTextRow = $("#dv-led-text-row");
  const ledText = $("#dv-led-text");
  const ledImageRow = $("#dv-led-image-row");
  const ledFile = $("#dv-led-file");
  const ledSpeedRow = $("#dv-led-speed-row");
  const ledSpeed = $("#dv-led-speed");
  const ledSpeedV = $("#dv-led-speed-v");
  const ledRgbRow = $("#dv-led-rgb-row");
  ledSource?.addEventListener("change", () => {
    const source = ledSource.value;
    if (source === "chevron") game.setPropLedDisplay?.({ source: "chevron" });
    else if (source === "text") game.setPropLedDisplay?.({ source: "text" });
    else game.setPropLedDisplay?.({ source: "image" });
    refresh();
  });
  ledText?.addEventListener("input", () => {
    game.setPropLedDisplay?.({ source: "text", text: ledText.value }, { immediate: false });
  });
  $("#dv-led-upload")?.addEventListener("click", () => ledFile?.click());
  ledFile?.addEventListener("change", async () => {
    const file = ledFile.files?.[0];
    ledFile.value = "";
    if (!file) return;
    await game.setPropLedDisplayFile?.(file);
    refresh();
  });
  $("#dv-led-clear")?.addEventListener("click", () => {
    game.setPropLedDisplay?.({ source: "chevron", image: null });
    refresh();
  });
  ledSpeed?.addEventListener("input", () => {
    const v = +ledSpeed.value;
    if (ledSpeedV) ledSpeedV.textContent = v.toFixed(2);
    game.setPropLedDisplay?.({ panSpeed: v }, { immediate: false });
  });
  const ledRgb = toggle("dv-led-rgb", false, (on) => {
    game.setPropLedDisplay?.({ rgb: on });
    refresh();
  });

  function renderLiveries() {
    if (!liverySwatches || !liveryName) return;
    const sel = game.getSelectedProp?.();
    const list = sel?.variants ?? [];
    liverySwatches.innerHTML = "";
    // The decal row only means anything for a prop that HAS one, so it hides
    // rather than sitting there dead.
    if (decalRow) decalRow.style.display = sel?.hasDecal ? "" : "none";
    if (sel?.hasDecal) decalToggle?.set?.(!!sel.decal);
    if (advertRow) advertRow.style.display = (sel?.hasAdvert && (sel.advertFaces ?? 1) <= 1) ? "" : "none";
    if (prismRow) prismRow.style.display = (sel?.advertFaces ?? 0) > 1 ? "" : "none";
    const ledOn = !!sel?.hasLedDisplay;
    if (ledWrap) ledWrap.style.display = ledOn ? "" : "none";
    if (ledOn) {
      const src = sel.ledDisplay?.source ?? "chevron";
      if (ledSource && document.activeElement !== ledSource) ledSource.value = src;
      const authored = src === "text" || src === "image";
      if (ledTextRow) ledTextRow.style.display = src === "text" ? "" : "none";
      if (ledImageRow) ledImageRow.style.display = src === "image" ? "" : "none";
      if (ledSpeedRow) ledSpeedRow.style.display = authored ? "" : "none";
      if (ledRgbRow) ledRgbRow.style.display = authored ? "" : "none";
      if (ledText && document.activeElement !== ledText) {
        ledText.value = sel.ledDisplay?.text ?? "";
      }
      const imgLab = $("#dv-led-image-label");
      if (imgLab) imgLab.textContent = sel.ledDisplay?.image ? "Image · set" : "Image";
      if (ledSpeed && document.activeElement !== ledSpeed) {
        const sp = sel.ledDisplay?.panSpeed ?? 0.4;
        ledSpeed.value = String(sp);
        if (ledSpeedV) ledSpeedV.textContent = Number(sp).toFixed(2);
      }
      ledRgb?.set?.(!!sel.ledDisplay?.rgb);
    }
    const isFlag = !!sel?.isFlag;
    if (flagWrap) flagWrap.style.display = isFlag ? "" : "none";
    if (isFlag) {
      const tex = !!sel.flagImage;
      const imgLab = $("#dv-flag-img-label");
      if (imgLab) imgLab.textContent = tex ? "Flag image · set" : "Flag image";
      if (flagCol) {
        flagCol.value = sel.flagColor;
        flagCol.disabled = tex;
      }
      if (flagAmp) flagAmp.closest(".prop-row").style.display = sel.flagVerlet ? "none" : "";
      if (flagSpeed) flagSpeed.closest(".prop-row").style.display = sel.flagVerlet ? "none" : "";
      const style = game.getSelectedFlagStyle?.();
      if (style && !sel.flagVerlet) {
        if (flagAmp && document.activeElement !== flagAmp) {
          flagAmp.value = String(style.amplitude);
          if (flagAmpV) flagAmpV.textContent = Number(style.amplitude).toFixed(2);
        }
        if (flagSpeed && document.activeElement !== flagSpeed) {
          flagSpeed.value = String(style.speed);
          if (flagSpeedV) flagSpeedV.textContent = Number(style.speed).toFixed(1);
        }
      }
    }
    if (advertRow) {
      const lab = $("#dv-advert-label");
      if (lab) lab.textContent = sel?.hasAdvertImage ? "Advert · set" : "Advert";
    }
    if (prismRow) {
      const slots = sel?.advertSlots ?? [];
      for (let i = 0; i < 3; i++) {
        const b = $(`#dv-advert-f${i}`);
        if (b) b.textContent = slots[i] ? "Replace" : "Upload";
      }
    }
    if (!sel) {
      liveryName.textContent = "No prop selected";
      return;
    }
    if (!list.length) {
      liveryName.textContent = (sel.hasDecal || sel.hasAdvert || sel.hasLedDisplay || sel.isFlag)
        ? sel.label : `${sel.label} — no liveries`;
      return;
    }
    liveryName.textContent = `${sel.label} — ${sel.variant + 1}/${list.length}`;
    list.forEach((hex, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = `Livery ${i + 1}`;
      const on = i === sel.variant;
      b.style.cssText = `width:26px;height:22px;border-radius:4px;cursor:pointer;`
        + `background:#${hex.toString(16).padStart(6, "0")};`
        + `border:2px solid ${on ? "#fff" : "rgba(255,255,255,0.25)"};`;
      b.addEventListener("click", () => { game.setPropVariant?.(i); refresh(); });
      liverySwatches.appendChild(b);
    });
  }

  function refresh() {
    // The deck material can be REPLACED from outside the panel (the weather
    // slider, a track load, the cheap-deck A/B), and the replacement carries
    // different values — and, on the cheap deck, fewer uniforms.
    refreshRoadLook();
    renderMode();
    renderLiveries();
    renderSpawnSrc();
    piecesEl.textContent = String(game.getPieceCount());
    trisEl.textContent = game.getCollisionTriCount().toLocaleString();
    if (bestEl) {
      const b = game.getBestTime?.() ?? game.getBestLap();
      bestEl.textContent = formatRunTime(b);
    }
    // Auto mode flips the headlights from outside the panel — keep the toggle
    // showing the truth rather than the last thing that was clicked.
    lightsToggle.set(game.getHeadlights());
    // Ditto the arc: solving a landing switches it on behind the panel's back.
    gapToggle.set(game.getGapPreview());
    // F8 flips the sky from outside the panel.
    gameSkyToggle.set(game.getGameSky?.() ?? false);
    syncTierBtns();
    autoToggle.set(game.getAutoHeadlights?.() ?? true);
    // The wheel and chassis GLBs finish loading after the panel is built and
    // call refresh().
    syncWheelBtn();
    syncChassisBtn();
    // Selected-piece readout + button enable state.
    const selId = game.getSelectedPieceId?.() ?? null;
    if (selPieceEl) selPieceEl.textContent = selId ?? "none";
    for (const b of pieceBtns) if (b) b.disabled = !selId;
    if (selAttachEl) {
      const det = game.isSelectedDetached?.() ?? false;
      selAttachEl.textContent = !selId ? "—" : det ? "free" : "chained";
      if (detachBtn) detachBtn.textContent = det ? "Re-attach to chain" : "Detach from chain";
      if (edgesBtn2) {
        edgesBtn2.textContent = `Edges: ${(game.getSelectedEdges?.() ?? true) ? "on" : "off"}`;
      }
    }
    if (selTiltEl) {
      const t = game.getSelectedTilt?.() ?? { pitch: 0, roll: 0 };
      const flat = Math.abs(t.pitch) < 0.5 && Math.abs(t.roll) < 0.5;
      selTiltEl.textContent = !selId ? "—" : flat ? "level" : `pitch ${t.pitch.toFixed(0)}°  roll ${t.roll.toFixed(0)}°`;
    }
    // Anchor tilt readout.
    if (anchorTiltEl) {
      const t = game.getAnchorTilt?.() ?? { pitch: 0, roll: 0 };
      const flat = Math.abs(t.pitch) < 0.5 && Math.abs(t.roll) < 0.5;
      anchorTiltEl.textContent = flat
        ? "level"
        : `pitch ${t.pitch.toFixed(0)}°  roll ${t.roll.toFixed(0)}°`;
    }
  }
  refresh();

  return {
    refresh,
    renderMode,
    dispose() { root.remove(); style.remove(); worldInput.remove(); },
  };
}
