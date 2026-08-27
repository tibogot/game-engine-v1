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
  const { TIRE, AERO, DRIVETRAIN, DECK, SOLID, BODYLEAN, HEADLIGHTS, WHEEL_LAYOUT, DRIFT, glowPropParams } = params;

  const root = document.createElement("div");
  root.id = "road-dev";
  root.innerHTML = `
    <div class="tab-bar">
      <button class="tab-btn active" type="button">Dev Controls</button>
      <button class="tab-btn dv-expand-all" type="button" title="Expand all sections">⊞</button>
      <button class="tab-btn dv-collapse-all" type="button" title="Collapse all sections">⊟</button>
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
          <div class="prop-row">
            <span class="prop-label">Clouds</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-clouds" type="button" aria-label="Volumetric clouds">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="dv-hint">
            Volumetric clouds you can fly through, at ~260 m. Off costs nothing — no
            buffers, no passes. The first enable bakes noise in a worker (a few seconds).
          </div>
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
            board takes three, one per rotating face. Both save with the track.
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
            <span class="prop-label">Best time</span>
            <div class="prop-value"><span class="prop-num" id="dv-best">--:--.---</span></div>
          </div>
          <button class="action-btn" id="dv-clear-rec" type="button">Clear record + ghost</button>
          <div class="dv-hint">
            Place rounded <b>Start</b> + <b>Finish</b> to enable the clock
            (any chains — jumps / new chains are fine). Checkpoints are
            optional ordered splits. Open start/finish pieces are for a later
            circuit mode. <b>Fall respawn</b> off = land on the terrain; on =
            snap back to the last safe spot (clock keeps running).
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
              <button class="prop-toggle checked" id="dv-lines-center" type="button" aria-label="Centre dashes">${CHECK_SVG}</button>
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
            <span class="prop-label">Rail metalness</span>
            <div class="prop-value">
              <input type="range" id="dv-rail-metal" min="0" max="1" step="0.02" />
              <span class="prop-num" id="dv-rail-metal-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Rail roughness</span>
            <div class="prop-value">
              <input type="range" id="dv-rail-rough" min="0.05" max="1" step="0.02" />
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
          <div class="dv-hint">
            <b>Auto</b> switches them on when the v3 sun drops near the horizon.
            Lamps only glow with Bloom on.
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
        </div>
      </div>

      <div class="inspector-section">
        <div class="section-header">Bloom</div>
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
          <div class="dv-hint">
            v3 bloom is <b>selective</b> — only materials writing the emissive MRT
            buffer glow. Glow box / ring / boost pads opt in.
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
          <div class="prop-row">
            <span class="prop-label">Nitro</span>
            <div class="prop-value">
              <input type="range" id="dv-a-nitro" min="0" max="2" step="0.05" />
              <span class="prop-num" id="dv-a-nitro-v"></span>
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
        <div class="section-header">FX</div>
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
          <div class="prop-row">
            <span class="prop-label">Drift smoke</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-smoke" type="button" aria-label="Drift smoke">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Stochastic tiling</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-stoch" type="button">Off</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Flag image</span>
            <div class="prop-value">
              <button class="action-btn" id="dv-flag-img" type="button">Load image…</button>
              <button class="action-btn" id="dv-flag-clear" type="button">Clear</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Flag colour</span>
            <div class="prop-value">
              <input type="color" id="dv-flag-color" />
              <span class="prop-num" id="dv-flag-count"></span>
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
  const GROUP_PREFIXES = ["Car", "Audio"];
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

  /** Wire a colour input to a TSL/THREE Color uniform stored in linear space. */
  function colorUniform(id, uColor) {
    const el = $(`#${id}`);
    if (!el || !uColor?.value) return;
    const toHex = () => `#${uColor.value.clone().convertLinearToSRGB().getHexString()}`;
    el.value = toHex();
    el.addEventListener("input", () => {
      uColor.value.set(el.value).convertSRGBToLinear();
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
  toggle("dv-lines-center", game.getCenterLinesOn?.() ?? true, (on) => game.setCenterLinesOn?.(on));
  toggle("dv-lines-edge", game.getEdgeLinesOn?.() ?? true, (on) => game.setEdgeLinesOn?.(on));
  toggle("dv-lines-bloom", game.getLinesBloom?.() ?? false, (on) => game.setLinesBloom?.(on));
  toggle("dv-terrain", game.getTerrain?.() ?? true, (on) => game.setTerrain?.(on));
  toggle("dv-clouds", game.getClouds?.() ?? false, (on) => game.setClouds?.(on));
  // Road-surface uniforms are TSL `uniform()` objects, so the slider / colour
  // helpers drive their `.value` directly — every change is live, no rebuild.
  // Colours live in linear space in the shader; the picker shows sRGB.
  const ru = game.roadUniforms;
  if (ru) {
    colorUniform("dv-road-dark", ru.asphaltDark);
    colorUniform("dv-road-light", ru.asphaltLight);
    colorUniform("dv-road-side", ru.sideColor);
    colorUniform("dv-road-kerb", ru.railA);
    slider("dv-road-bright", ru.deckBrightness, "value", (v) => `${v.toFixed(2)}×`);
    slider("dv-road-grain", ru.grainScale, "value", (v) => v.toFixed(2));
    slider("dv-road-agg", ru.aggScale, "value", (v) => `${v.toFixed(1)}/m`);
    slider("dv-road-rvary", ru.roughVary, "value", (v) => v.toFixed(2));
    slider("dv-road-polish", ru.wheelPolish, "value", (v) => v.toFixed(2));
    slider("dv-road-wdark", ru.wheelDarken, "value", (v) => v.toFixed(2));
  }
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
  slider("dv-beam", HEADLIGHTS, "intensity", (v) => v.toFixed(0), () => game.refreshLights());

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
  toggle("dv-reflect", true, (on) => game.setReflection?.(on));
  // SEEDED FROM THE GAME, not from a literal. It was hard-coded `false` while
  // roadGame defaults it on, so the box read unchecked with the reflection
  // plainly visible — and the first click then "turned on" what was already on
  // and appeared to do nothing at all.
  toggle("dv-reflect-rails", game.getRailsInMirror?.() ?? true,
    (on) => game.setRailsInMirror?.(on));
  slider("dv-reflect-str", weather, "reflectStrength", (v) => v.toFixed(2),
    (v) => game.setReflectStrength?.(v));
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

  // ── Bloom ───────────────────────────────────────────────────────────────────
  const bloom = { strength: 0.9, radius: 0.5 };
  toggle("dv-bloom", true, (on) => app.postFx?.setBloom({ enabled: on }));
  slider("dv-bloom-str", bloom, "strength", (v) => v.toFixed(2),
    (v) => app.postFx?.setBloom({ strength: v }));
  slider("dv-bloom-rad", bloom, "radius", (v) => v.toFixed(2),
    (v) => app.postFx?.setBloom({ radius: v }));
  slider("dv-glow", glowPropParams, "intensity", (v) => v.toFixed(1),
    () => game.refreshGlowProps());

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
  slider("dv-a-nitro", va, "nitroMul", pct);
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

  // ── Banner flags ────────────────────────────────────────────────────────────
  // One image and one colour drive EVERY flag, because they are all one
  // instanced draw. The colour picker is disabled while an image is loaded: the
  // material multiplies colour × map, so a tinted flag stains the picture (the
  // RTS base flag hit exactly this).
  const flagP = game.getFlagParams?.();
  if (flagP) {
    const colEl = $("#dv-flag-color");
    const countEl = $("#dv-flag-count");
    const syncFlagUi = () => {
      const tex = !!game.flagHasTexture?.();
      if (colEl) { colEl.value = flagP.color; colEl.disabled = tex; }
      if (countEl) countEl.textContent = `${game.flagCount?.() ?? 0} placed${tex ? " · image" : ""}`;
    };
    colEl?.addEventListener("input", () => {
      flagP.color = colEl.value;
      game.applyFlagParams?.();
    });
    // Hidden file input — same shape as the track loader.
    const flagFile = document.createElement("input");
    flagFile.type = "file";
    flagFile.accept = "image/*";
    flagFile.style.display = "none";
    flagFile.addEventListener("change", () => {
      const f = flagFile.files?.[0];
      if (f) game.setFlagTextureFile?.(f);
      flagFile.value = "";
      syncFlagUi();
    });
    document.body.appendChild(flagFile);
    $("#dv-flag-img")?.addEventListener("click", () => flagFile.click());
    $("#dv-flag-clear")?.addEventListener("click", () => {
      game.clearFlagTexture?.();
      syncFlagUi();
    });
    slider("dv-flag-amp", flagP, "amplitude", (v) => v.toFixed(2),
      () => game.applyFlagParams?.());
    slider("dv-flag-speed", flagP, "speed", (v) => v.toFixed(1),
      () => game.applyFlagParams?.());
    syncFlagUi();
  }

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
      liveryName.textContent = (sel.hasDecal || sel.hasAdvert) ? sel.label : `${sel.label} — no liveries`;
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
