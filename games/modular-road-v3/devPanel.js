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

// Match the v3 editor's --right-w (300px). Narrower than that and prop-rows
// (label + range + readout) clip on the right edge of the panel.
const DEV_PANEL_OPEN_W = 300;

/**
 * @param {object} o
 * @param {object} o.app          the v3 app returned by startV3App
 * @param {object} o.game         the road game's own control surface
 * @param {object} o.params       live-tunable param objects from the vehicle/kit
 */
export function createRoadDevPanel({ app, game, params }) {
  const { TIRE, AERO, DRIVETRAIN, DECK, SOLID, HEADLIGHTS, glowPropParams } = params;

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
          <div class="dv-hint">
            The track floats at this height above the terrain. <b>New chain</b> drops
            a fresh anchor in the sky where you're looking; pieces auto-chain from
            it, so the whole track floats — no dragging pieces up.
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
          <button class="action-btn primary" id="dv-snap" type="button">Snap landing → new chain</button>
          <div class="dv-hint">
            The red arc is where a jump at <b>launch speed</b> lands (green ring).
            <b>Snap landing</b> starts a new chain there, heading down-arc — then
            place a landing / dive piece to catch the car.
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
        <div class="section-header">Spawn</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Source</span>
            <div class="prop-value"><span class="prop-num" id="dv-spawn-src">.v3proj / origin</span></div>
          </div>
          <button class="action-btn primary" id="dv-spawn-car" type="button">Set to car position</button>
          <button class="action-btn" id="dv-spawn-cursor" type="button">Set to build cursor</button>
          <button class="action-btn" id="dv-spawn-clear" type="button">Clear (use .v3proj)</button>
          <div class="dv-hint">
            The green arrow marks where the car starts / respawns. <b>Set to car</b>
            (drive somewhere first) is the quickest way to set a start line.
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
            <span class="prop-label">Target laps</span>
            <div class="prop-value">
              <input type="range" id="dv-laps" min="1" max="10" step="1" />
              <span class="prop-num" id="dv-laps-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Best lap</span>
            <div class="prop-value"><span class="prop-num" id="dv-best">--:--.---</span></div>
          </div>
          <button class="action-btn" id="dv-clear-rec" type="button">Clear record + ghost</button>
          <div class="dv-hint">
            Place <b>Start</b> / <b>Checkpoint</b> / <b>Finish</b> pieces to enable
            timing. <b>Fall respawn</b> off (free-drive) = fall off the track and
            land on the terrain; on = snap back to the last safe spot (game rule).
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
        <div class="section-header">Loop camera</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Engage tilt</span>
            <div class="prop-value">
              <input type="range" id="dv-loopstart" min="0.5" max="1" step="0.01" />
              <span class="prop-num" id="dv-loopstart-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Full commit</span>
            <div class="prop-value">
              <input type="range" id="dv-loopfull" min="-1" max="0.8" step="0.05" />
              <span class="prop-num" id="dv-loopfull-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Roll ease</span>
            <div class="prop-value">
              <input type="range" id="dv-looplerp" min="1" max="12" step="0.5" />
              <span class="prop-num" id="dv-looplerp-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Up ease</span>
            <div class="prop-value">
              <input type="range" id="dv-uplerp" min="1" max="12" step="0.5" />
              <span class="prop-num" id="dv-uplerp-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            <b>Engage tilt</b> higher = starts rolling earlier as the car noses into
            the loop. <b>Full commit</b> lower = ramps more gradually across the
            whole loop. Keep the eases moderate for smoothness.
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
        <div class="section-header">Car — Wall response</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Max bounce</span>
            <div class="prop-value">
              <input type="range" id="dv-wall-exit" min="0.5" max="20" step="0.5" />
              <span class="prop-num" id="dv-wall-exit-v"></span>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Scrape drag</span>
            <div class="prop-value">
              <input type="range" id="dv-wall-scrub" min="0" max="8" step="0.1" />
              <span class="prop-num" id="dv-wall-scrub-v"></span>
            </div>
          </div>
          <div class="dv-hint">
            Caps how hard a guardrail can throw the car back — the collision
            springs stack across contact points and used to launch it. Raise
            <b>max bounce</b> for pinball, lower for a car that hugs the rail.
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
            <span class="prop-label">Road lines</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-lines" type="button" aria-label="Road lines">${CHECK_SVG}</button>
            </div>
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
        <div class="section-header">Lights</div>
        <div class="section-body">
          <div class="prop-row">
            <span class="prop-label">Headlights</span>
            <div class="prop-value">
              <button class="prop-toggle" id="dv-lights" type="button" aria-label="Headlights">${CHECK_SVG}</button>
            </div>
          </div>
          <div class="prop-row">
            <span class="prop-label">Auto (by sun)</span>
            <div class="prop-value">
              <button class="prop-toggle checked" id="dv-lights-auto" type="button" aria-label="Auto headlights">${CHECK_SVG}</button>
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
      position: fixed; right: 0; top: 0; bottom: 0;
      width: ${DEV_PANEL_OPEN_W}px; min-width: ${DEV_PANEL_OPEN_W}px; z-index: 200;
      background: var(--bg-panel); border-left: 1px solid var(--border);
      display: flex; flex-direction: column; overflow: hidden;
      font-family: var(--font);
      pointer-events: auto;
    }
    /* Readouts like "80 m/s" need more than the editor's default 36px. */
    #road-dev .prop-num { width: auto; min-width: 52px; }
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
  toggle("dv-gap", game.getGapPreview(), (on) => game.setGapPreview(on));
  const refSpdEl = $("#dv-refspd");
  const refSpdVal = $("#dv-refspd-v");
  if (refSpdEl) {
    refSpdEl.value = game.getRefSpeed();
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
  $("#dv-snap").addEventListener("click", () => game.snapLanding());

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const spawnSrc = $("#dv-spawn-src");
  const renderSpawnSrc = () => {
    spawnSrc.textContent = game.hasSpawn() ? "custom" : ".v3proj / origin";
  };
  $("#dv-spawn-car").addEventListener("click", () => { game.setSpawnToCar(); renderSpawnSrc(); });
  $("#dv-spawn-cursor").addEventListener("click", () => { game.setSpawnToCursor(); renderSpawnSrc(); });
  $("#dv-spawn-clear").addEventListener("click", () => { game.clearSpawn(); renderSpawnSrc(); });
  renderSpawnSrc();

  // ── Race ────────────────────────────────────────────────────────────────────
  const lapsEl = $("#dv-laps");
  const lapsVal = $("#dv-laps-v");
  const bestEl = $("#dv-best");
  if (lapsEl) {
    lapsEl.value = game.getTargetLaps();
    lapsVal.textContent = String(game.getTargetLaps());
    lapsEl.addEventListener("input", () => {
      const n = +lapsEl.value;
      game.setTargetLaps(n);
      lapsVal.textContent = String(n);
    });
  }
  toggle("dv-respawn-on", game.getRaceRespawn(), (on) => game.setRaceRespawn(on));
  $("#dv-clear-rec").addEventListener("click", () => { game.clearRecord(); refresh(); });

  // ── Camera ──────────────────────────────────────────────────────────────────
  toggle("dv-freelook", false, (on) => game.setFreeLook(on));
  const cam = game.cameraParams;
  slider("dv-cam-dist", cam, "dist", (v) => `${v.toFixed(1)}m`);
  slider("dv-cam-height", cam, "height", (v) => `${v.toFixed(1)}m`);
  slider("dv-cam-ahead", cam, "lookAhead", (v) => `${v.toFixed(1)}m`);

  // Loop camera (live tuning — smoothness is subjective, dial to taste).
  slider("dv-loopstart", cam, "loopStart", (v) => v.toFixed(2));
  slider("dv-loopfull", cam, "loopFull", (v) => v.toFixed(2));
  slider("dv-looplerp", cam, "loopLerp", (v) => v.toFixed(1));
  slider("dv-uplerp", cam, "upLerp", (v) => v.toFixed(1));

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
  slider("dv-wall-exit", SOLID, "maxExitSpeed", (v) => `${v.toFixed(1)} m/s`);
  slider("dv-wall-scrub", SOLID, "tangentScrub", (v) => v.toFixed(1));
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
  toggle("dv-lines", game.getLinesOn(), (on) => game.setLinesOn(on));
  toggle("dv-showcol", false, (on) => game.setCollisionDebug(on));
  toggle("dv-inst", true, (on) => game.setInstancing(on));
  $("#dv-rebake").addEventListener("click", () => game.bakeCollision());

  // ── Lights ──────────────────────────────────────────────────────────────────
  const lightsToggle = toggle("dv-lights", false, (on) => {
    game.setAutoHeadlights(false);   // manual click takes over from auto
    autoToggle.set(false);
    game.setHeadlights(on);
  });
  const autoToggle = toggle("dv-lights-auto", true, (on) => game.setAutoHeadlights(on));
  slider("dv-lamp", HEADLIGHTS, "lampEmissive", (v) => v.toFixed(1), () => game.refreshLights());
  slider("dv-beam", HEADLIGHTS, "intensity", (v) => v.toFixed(0), () => game.refreshLights());

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
  toggle("dv-smoke", true, (on) => game.setDriftSmokeEnabled(on));

  // ── Live readouts ───────────────────────────────────────────────────────────
  const piecesEl = $("#dv-pieces");
  const trisEl = $("#dv-tris");
  function refresh() {
    renderMode();
    piecesEl.textContent = String(game.getPieceCount());
    trisEl.textContent = game.getCollisionTriCount().toLocaleString();
    if (bestEl) {
      const b = game.getBestLap();
      bestEl.textContent = Number.isFinite(b) ? b.toFixed(3) : "--:--.---";
    }
    // Auto mode flips the headlights from outside the panel — keep the toggle
    // showing the truth rather than the last thing that was clicked.
    lightsToggle.set(game.getHeadlights());
  }
  refresh();

  return {
    refresh,
    renderMode,
    dispose() { root.remove(); style.remove(); worldInput.remove(); },
  };
}
