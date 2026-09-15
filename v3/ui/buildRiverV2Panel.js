/**
 * v3/ui/buildRiverV2Panel.js — River v2 inspector.
 *
 * Organised the way the system is: what the SELECTED NODE does, then what the
 * whole river does, then the cross-section, the flow model and the surface.
 * The node section is first because per-node width and level are the two
 * controls the tool exists for.
 */
import { section as _section, slider as _slider, color as _color, toggle as _toggle, button as _button, hint as _hint } from "./widgets.js";
import { uiById } from "./uiRoot.js";

/**
 * @param {object}   app
 * @param {object}   app.toolState      has a `.riverV2` slice
 * @param {object}   app.riverV2System
 * @param {number}   app.maxHeight
 * @param {object}   app.waterGlobals   { ssrMaster } shared by every water surface
 * @param {function} app.materialChanged
 * @param {function} app.conformChanged
 * @param {function} app.visibilityChanged
 * @returns {{ refresh: () => void }}
 */
export function buildRiverV2Panel(app) {
  const panel = uiById("riverv2-panel");
  if (!panel) return { refresh: () => {} };

  function refresh() {
    panel.innerHTML = "";
    const p = app.toolState.riverV2;
    const sys = app.riverV2System;
    // The per-node sliders read mirrored state, so pull it from the selection
    // first — otherwise a refresh triggered by anything other than an edit
    // (a mode change, an undo, a project load) shows the previous node's values.
    sys.syncSelectionToState?.();
    const w = p.water;

    const onMat = () => app.materialChanged?.();
    const onConform = () => app.conformChanged?.();

    const count = sys.rivers.length;
    const active = sys.activeRiver;
    const solved = active?.solved ?? null;

    // ── Rivers ──────────────────────────────────────────────────────────────
    const rs = _section(panel, `Rivers (${count})`, true);
    if (count === 0) {
      _hint(rs, "Click the terrain to drop nodes. Node order is the flow direction — the arrows show it. Each node carries its own width, depth and bank, and its own water level, so a river narrows, deepens and climbs by dragging handles rather than by being split up.");
    } else {
      if (count > 1) {
        _slider(rs, p, "activeRiverIndex", {
          label: "Active river", min: 0, max: count - 1, step: 1,
          onChange: () => { sys.selected = null; sys._rebuildVisual(); refresh(); },
        });
      }
      _hint(rs, `${active?.nodes.length ?? 0} nodes` +
        (solved ? ` · ${solved.total.toFixed(0)} m long` : "") +
        (solved?.hasUphill ? " · ⚠ flows uphill somewhere (red arrows)" : ""));
      _button(rs, {
        title: "New river",
        hint: "Start a separate river. Clicks then build the new one.",
        onClick: () => { sys.startNewRiver(); refresh(); },
      });
      _button(rs, {
        title: "Reverse flow direction",
        hint: "Node order IS the direction, so this flips the whole river end for end.",
        onClick: () => { sys.reverseActiveRiver(); refresh(); },
      });
      _button(rs, {
        title: "Delete active river",
        onClick: () => { sys.deleteActiveRiver(); refresh(); },
      });
    }

    // ── Selected node ───────────────────────────────────────────────────────
    const sel = sys._selectedNode?.();
    if (sel) {
      const nd = _section(panel, `Selected node (${sel.nodeIdx + 1}/${sel.river.nodes.length})`, true);
      _hint(nd, "Drag the green diamonds in the viewport to set the width, or the gold cone above the node to lift it. Lifting a node PINS it: the solver then holds that height instead of dropping the node onto the valley floor, and the terrain is filled up to meet it.");

      _slider(nd, p, "selWidth", {
        label: "Width (m)", min: 1, max: 200, step: 0.5,
        onChange: () => { sys.setSelectedChannel({ width: p.selWidth }); },
      });
      _slider(nd, p, "selDepth", {
        label: "Depth (m)", min: 0.1, max: 30, step: 0.1,
        onChange: () => { sys.setSelectedChannel({ depth: p.selDepth }); },
        hint: "Metres from the water surface to the deepest point of the bed.",
      });
      _slider(nd, p, "selBank", {
        label: "Bank (m)", min: 0.5, max: 80, step: 0.5,
        onChange: () => { sys.setSelectedChannel({ bank: p.selBank }); },
        hint: "Shoulder width blending the bank lip back out to natural ground. Widened automatically where the slope would otherwise be too steep.",
      });
      _slider(nd, p, "selLevel", {
        label: "Water level (m)", min: 0, max: app.maxHeight, step: 0.1,
        onChange: () => { sys.setSelectedLevel(p.selLevel); refresh(); },
        hint: "Setting this pins the node. Use 'Follow the ground' to hand it back to the solver.",
      });
      _hint(nd, Number.isFinite(sel.node.y)
        ? "This node is PINNED (gold handle)."
        : "This node is AUTO — its level follows the valley floor.");
      _button(nd, {
        title: "Follow the ground (un-pin)",
        onClick: () => { sys.releaseSelectedLevel(); refresh(); },
      });
      _button(nd, {
        title: "Apply this channel to the whole river",
        hint: "Copies width, depth and bank from this node to every other node.",
        onClick: () => { sys.applySelectedChannelToRiver(); refresh(); },
      });
    }

    // ── Whole river level ───────────────────────────────────────────────────
    if (active && active.nodes.length >= 2) {
      const lv = _section(panel, "River level", false);
      _hint(lv, "Lift or drop the whole river at once. The channel and both banks come with it — raise it above the surrounding ground and the conform builds embankments to hold it in.");
      _button(lv, { title: "Raise 1 m", onClick: () => { sys.nudgeActiveRiver(1); refresh(); } });
      _button(lv, { title: "Raise 5 m", onClick: () => { sys.nudgeActiveRiver(5); refresh(); } });
      _button(lv, { title: "Lower 1 m", onClick: () => { sys.nudgeActiveRiver(-1); refresh(); } });
      _button(lv, { title: "Lower 5 m", onClick: () => { sys.nudgeActiveRiver(-5); refresh(); } });
      _button(lv, {
        title: "Pin every node here",
        hint: "Freezes the whole solved profile, so later terrain edits cannot move the water.",
        onClick: () => { sys.pinActiveRiver(); refresh(); },
      });
      _button(lv, {
        title: "Follow the ground (un-pin all)",
        onClick: () => { sys.releaseActiveRiver(); refresh(); },
      });
    }

    // ── New node defaults ───────────────────────────────────────────────────
    const nn = _section(panel, "New node defaults", false);
    _hint(nn, "Channel given to nodes placed from now on. Existing nodes keep theirs.");
    _slider(nn, p, "newWidth", { label: "Width (m)", min: 1, max: 200, step: 0.5 });
    _slider(nn, p, "newDepth", { label: "Depth (m)", min: 0.1, max: 30, step: 0.1 });
    _slider(nn, p, "newBank", { label: "Bank (m)", min: 0.5, max: 80, step: 0.5 });

    // ── Display ─────────────────────────────────────────────────────────────
    const dsp = _section(panel, "Display", true);
    _toggle(dsp, p, "showHandles", {
      label: "Node handles",
      onChange: () => { sys._rebuildHandles(); sys.refreshVisibility(); },
    });
    _toggle(dsp, p, "showArrows", {
      label: "Flow arrows",
      onChange: () => { sys._rebuildArrows(); sys.refreshVisibility(); },
      hint: "Direction and speed along every river. Blue is slow, white is fast, RED means the water surface climbs against the flow direction there — almost always a node that needs moving.",
    });

    // ── Cross-section ───────────────────────────────────────────────────────
    const xs = _section(panel, "Cross-section", false);
    _hint(xs, "The shape the terrain is cut and filled to. The bed always returns to the water level exactly at ±width/2, so the waterline needs no tuning.");
    _slider(xs, p, "bedCurve", {
      label: "Bed shape", min: 0, max: 1, step: 0.01, onChange: onConform,
      hint: "0 = flat-bottomed canal with steep walls. 1 = parabolic natural channel.",
    });
    _slider(xs, p, "freeboard", {
      label: "Bank lip (m)", min: 0, max: 6, step: 0.05, onChange: onConform,
      hint: "How far the bank stands above the water. This is what physically holds the river in when it sits above the surrounding ground.",
    });
    _slider(xs, p, "lipFraction", {
      label: "Lip sharpness", min: 0.02, max: 0.9, step: 0.01, onChange: onConform,
      hint: "Fraction of the bank width spent climbing from the waterline to the lip. Small = a crisp levee crest; large = a soft swell.",
    });
    _slider(xs, p, "maxBankSlope", {
      label: "Max bank slope", min: 0.05, max: 3, step: 0.05, onChange: onConform,
      hint: "Rise over run. Where the ground is further from the lip than this allows, the bank widens instead of standing vertical.",
    });
    _slider(xs, p, "bankFlareMax", {
      label: "Max flare", min: 1, max: 10, step: 0.5, onChange: onConform,
      hint: "Ceiling on that widening, in multiples of the node's bank width. Also sets how far the conform can reach, so raising it costs area.",
    });

    // ── Profile solver ──────────────────────────────────────────────────────
    const pr = _section(panel, "Profile", false);
    _slider(pr, p, "stationSpacing", {
      label: "Station spacing (m)", min: 0.5, max: 12, step: 0.25, onChange: onConform,
      hint: "Resolution of the solve, the conform and the ribbon. Smaller is smoother and slower.",
    });
    _toggle(pr, p, "forceDownhill", {
      label: "Force downhill", onChange: onConform,
      hint: "Clamps AUTO node levels so they never climb. Pinned nodes are never moved — if you lift one, the river really does climb there and the arrows turn red.",
    });
    _slider(pr, p, "minGradient", {
      label: "Min gradient", min: 0, max: 0.02, step: 0.0002, onChange: onConform,
      hint: "Fall per metre applied by 'Force downhill', so a reach never goes perfectly flat.",
    });
    _slider(pr, p, "levelSmoothing", {
      label: "Level smoothing", min: 0, max: 8, step: 1, onChange: onConform,
      hint: "Smoothing passes over AUTO node levels only, to take the noise out of rough ground. Pinned levels are held exactly.",
    });
    _slider(pr, p, "surfaceDrop", {
      label: "Surface drop (m)", min: 0, max: 1, step: 0.01, onChange: () => { sys.rebuildMeshes(); },
      hint: "Metres the drawn surface sits below the solved level, tucking the mesh edge inside the bank lip.",
    });

    // ── Flow ────────────────────────────────────────────────────────────────
    const fl = _section(panel, "Flow", false);
    _hint(fl, "Speed is solved, not authored: v = (1/n)·depth^(2/3)·√slope. A reach that steepens or shallows out runs faster on its own, and the whitewater follows it.");
    _slider(fl, p, "manningN", {
      label: "Roughness (n)", min: 0.008, max: 0.12, step: 0.001, onChange: onConform,
      hint: "Manning's n. 0.03 is a clean channel, 0.07 a boulder-strewn mountain stream. Lower = faster.",
    });
    _slider(fl, p, "flowScale", {
      label: "Speed scale", min: 0.1, max: 4, step: 0.05, onChange: onConform,
    });
    _slider(fl, p, "minSlope", {
      label: "Min slope", min: 0, max: 0.01, step: 0.0002, onChange: onConform,
      hint: "Slope floor, so a dead-flat reach still drifts instead of freezing.",
    });
    _slider(fl, p, "minSpeed", { label: "Min speed (m/s)", min: 0, max: 2, step: 0.01, onChange: onConform });
    _slider(fl, p, "maxSpeed", { label: "Max speed (m/s)", min: 0.5, max: 20, step: 0.1, onChange: onConform });
    _hint(fl, "Whitewater is keyed to the Froude number, v / sqrt(g·depth) — how close the flow is to breaking. Absolute, so a calm river reads as calm rather than as 100% of its own small turbulence.");
    _slider(fl, p, "froudeStart", { label: "Rapids start (Fr)", min: 0, max: 3, step: 0.05, onChange: onConform,
      hint: "Below this Froude number there is no turbulence at all. ~1 is where real water starts to break; lower it to get whitewater on a gentler river." });
    _slider(fl, p, "froudeFull", { label: "Rapids full (Fr)", min: 0.1, max: 5, step: 0.05, onChange: onConform,
      hint: "Froude number at which turbulence saturates." });

    // ── Banks (sand) ────────────────────────────────────────────────────────
    const sd = _section(panel, "Banks (sand)", false);
    _hint(sd, "A sand band on the terrain under and around the channel, measured from the centreline out — so it follows the river's width and covers bed and bank in one sweep. Terrain shading, not water: no caustics, and it shows whether or not that stretch is submerged.");
    const onSand = () => app.sandChanged?.();
    _toggle(sd, p.sand, "enabled", { label: "Enabled", onChange: onSand });
    _color (sd, p.sand, "color", { label: "Sand colour", onChange: onSand });
    _slider(sd, p.sand, "strength", { label: "Strength", min: 0, max: 1, step: 0.01, onChange: onSand,
      hint: "How much of the sand hue replaces the painted ground." });
    _slider(sd, p.sand, "width", { label: "Width beyond channel (m)", min: 0, max: 60, step: 0.5, onChange: onSand,
      hint: "Metres of sand past the water's own half-width, on each side." });
    _slider(sd, p.sand, "fade", { label: "Edge fade (m)", min: 0.1, max: 30, step: 0.1, onChange: onSand });
    _slider(sd, p.sand, "edgeNoise", { label: "Edge wander (m)", min: 0, max: 15, step: 0.1, onChange: onSand,
      hint: "Wobble on the outer edge, so the band is not a perfect ribbon." });
    _slider(sd, p.sand, "edgeNoiseScale", { label: "Wander scale", min: 0.005, max: 0.3, step: 0.005, onChange: onSand,
      hint: "Noise cells per metre. Lower = longer, lazier bays." });
    _slider(sd, p.sand, "detail", { label: "Keep ground detail", min: 0, max: 1, step: 0.01, onChange: onSand,
      hint: "Multiplies the sand by the ground's own luminance so the painted texture reads through instead of going flat." });

    // ── Water colour ────────────────────────────────────────────────────────
    const wc = _section(panel, "Water colour", false);
    _hint(wc, "Beer-Lambert absorption, per channel. Thickness comes from the depth buffer, so the shoreline is pixel-exact against terrain, rocks and anything else standing in the water.");
    _slider(wc, w, "absorptionR", { label: "Absorb R", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(wc, w, "absorptionG", { label: "Absorb G", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(wc, w, "absorptionB", { label: "Absorb B", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(wc, w, "absorptionScale", { label: "Absorb scale", min: 0, max: 60, step: 0.5, onChange: onMat });
    _color(wc, w, "inscatterTint", { label: "Inscatter tint", onChange: onMat });
    _slider(wc, w, "inscatterStrength", { label: "Inscatter", min: 0, max: 3, step: 0.01, onChange: onMat });
    _slider(wc, w, "depthDistance", { label: "Depth distance (m)", min: 0.3, max: 30, step: 0.1, onChange: onMat,
      hint: "Metres of water over which absorption reaches full strength. A river wants ~3." });

    // ── Surface ─────────────────────────────────────────────────────────────
    const sf = _section(panel, "Surface", false);
    _hint(sf, "Two normal layers, each advected in two half-period phases and cross-faded. That is what lets neighbouring fragments move at different speeds without tearing the texture apart.");
    _slider(sf, w, "normalTiling", { label: "Ripple tiling", min: 0.005, max: 0.5, step: 0.005, onChange: onMat,
      hint: "Repeats per metre." });
    _slider(sf, w, "normalStrength", { label: "Ripple strength", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(sf, w, "normalTiling2", { label: "Swell tiling", min: 0.002, max: 0.2, step: 0.002, onChange: onMat });
    _slider(sf, w, "normalStrength2", { label: "Swell strength", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(sf, w, "advectPeriod", { label: "Advect period (s)", min: 0.2, max: 6, step: 0.05, onChange: onMat,
      hint: "Seconds before each phase resets. Longer is smoother but stretches more; shorter is crisper but the cross-fade starts to pulse." });
    _slider(sf, w, "flowBias", { label: "Speed bias (m/s)", min: -2, max: 6, step: 0.05, onChange: onMat,
      hint: "Added to the solved velocity everywhere, for art direction." });
    _hint(sf, "Displacement is real geometry, so it reads at eye level and in silhouette. Swell drifts downstream at one speed for the whole river (a per-station speed shears the wave apart over time); standing waves do not drift at all — that is what makes them standing — and appear only where the solved flow is already breaking.");
    _toggle(sf, w, "waveEnabled", { label: "Surface waves", onChange: onMat });
    _slider(sf, w, "swellAmplitude", { label: "Swell height (m)", min: 0, max: 0.6, step: 0.005, onChange: onMat });
    _slider(sf, w, "swellLength", { label: "Swell length (m)", min: 0.5, max: 40, step: 0.1, onChange: onMat });
    _slider(sf, w, "swellSpeed", { label: "Swell drift (m/s)", min: 0, max: 8, step: 0.05, onChange: onMat });
    _slider(sf, w, "standingAmplitude", { label: "Standing waves (m)", min: 0, max: 1.5, step: 0.01, onChange: onMat,
      hint: "Height at full turbulence. Appears only where the solved flow is already breaking." });
    _slider(sf, w, "standingLength", { label: "Standing spacing (x depth)", min: 1, max: 25, step: 0.25, onChange: onMat,
      hint: "Crest spacing as a multiple of the local depth. A fast river is shallow, and its wave train spaces itself off the depth — the deep-water v-squared formula asks for tens of metres here and reads as ocean swell." });
    _slider(sf, p, "meshStep", { label: "Mesh step (m)", min: 0.25, max: 5, step: 0.05,
      onChange: () => { sys.rebuildMeshes(); },
      hint: "Metres between rows of the water surface. Waves cannot be finer than this." });
    _slider(sf, p, "meshAcross", { label: "Mesh columns", min: 2, max: 48, step: 1,
      onChange: () => { sys.rebuildMeshes(); },
      hint: "Columns across the ribbon." });
    _slider(sf, w, "streakStrength", { label: "Flow streaks", min: 0, max: 0.6, step: 0.01, onChange: onMat,
      hint: "Faint lengthwise banding — what reads as moving water even on a calm reach." });
    _slider(sf, w, "streakScale", { label: "Streak scale", min: 0.05, max: 2, step: 0.01, onChange: onMat });

    // ── Whitewater ──────────────────────────────────────────────────────────
    const ww = _section(panel, "Whitewater", false);
    _hint(ww, "Three sources sharing one advected noise field: rapids from the solved slope and speed, shallows from the depth buffer, and wakes found by looking upstream in screen space — which is what puts foam behind a rock without any per-object work.");
    _toggle(ww, w, "foamEnabled", { label: "Enabled", onChange: onMat });
    _color(ww, w, "foamColor", { label: "Colour", onChange: onMat });
    _slider(ww, w, "turbulence", { label: "Rapids", min: 0, max: 3, step: 0.01, onChange: onMat,
      hint: "Whitewater from the reach's own slope × speed." });
    _slider(ww, w, "turbulenceCutoff", { label: "Rapids threshold", min: 0, max: 0.95, step: 0.01, onChange: onMat,
      hint: "Turbulence below this contributes nothing, so calm reaches stay glassy." });
    _slider(ww, w, "shallows", { label: "Shallows", min: 0, max: 3, step: 0.01, onChange: onMat,
      hint: "Foam where the water is thin — bank edges and gravel bars." });
    _slider(ww, w, "shallowDepth", { label: "Shallow depth (m)", min: 0.02, max: 3, step: 0.01, onChange: onMat });
    _slider(ww, w, "wake", { label: "Obstacle wake", min: 0, max: 3, step: 0.01, onChange: onMat,
      hint: "Foam trailing behind rocks, piers, the player — anything solid standing in the river." });
    _slider(ww, w, "wakeDistance", { label: "Wake reach (m)", min: 0.3, max: 12, step: 0.1, onChange: onMat,
      hint: "How far upstream the test looks. Roughly the length of the foam tail." });
    _slider(ww, w, "foamScale", { label: "Noise scale", min: 0.05, max: 3, step: 0.01, onChange: onMat,
      hint: "Cells per metre, in flow space — so the foam travels with the current." });
    _slider(ww, w, "foamBreakup", { label: "Breakup", min: 0, max: 1, step: 0.01, onChange: onMat,
      hint: "How hard the noise chews holes in the foam. 0 = flat white, even where the water is genuinely churning." });
    _slider(ww, w, "foamContrast", { label: "Breakup contrast", min: 0.5, max: 5, step: 0.05, onChange: onMat,
      hint: "Stretches the noise so it swings the full range. Low values leave it hovering near its mean, which is what makes saturated foam read as milk." });
    _slider(ww, w, "foamSharpness", { label: "Sharpness", min: 0.2, max: 4, step: 0.01, onChange: onMat });
    _slider(ww, w, "foamCutoff", { label: "Cutoff", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(ww, w, "foamTransition", { label: "Edge softness", min: 0.01, max: 0.5, step: 0.005, onChange: onMat });

    // ── Refraction / reflection ─────────────────────────────────────────────
    const rr = _section(panel, "Refraction / reflection", false);
    _slider(rr, w, "refractionStrength", { label: "Refraction", min: 0, max: 0.3, step: 0.005, onChange: onMat });
    _slider(rr, w, "fresnelScale", { label: "Fresnel scale", min: 0, max: 2, step: 0.01, onChange: onMat });
    _slider(rr, w, "skyReflectIntensity", { label: "Sky reflect", min: 0, max: 3, step: 0.01, onChange: onMat });
    _slider(rr, w, "shoreFade", { label: "Waterline fade (m)", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(rr, w, "surfaceOpacity", { label: "Surface opacity", min: 0, max: 1, step: 0.01, onChange: onMat });

    const ssr = _section(panel, "Screen-space reflections", false);
    _hint(ssr, "Marches the reflected ray against the depth buffer the refraction already grabbed, so only the march costs. Off-screen rays fall back to the sky gradient.");
    if (app.waterGlobals) {
      _toggle(ssr, app.waterGlobals, "ssrMaster", { label: "SSR — all water", onChange: onMat,
        hint: "Master switch across every lake and river at once. This is the perf lever." });
    }
    _toggle(ssr, w, "ssrEnabled", { label: "SSR — rivers", onChange: onMat });
    _slider(ssr, w, "ssrStrength", { label: "Strength", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(ssr, w, "ssrMaxDistance", { label: "Max distance (m)", min: 5, max: 200, step: 1, onChange: onMat });
    _slider(ssr, w, "ssrThickness", { label: "Thickness", min: 0.05, max: 10, step: 0.05, onChange: onMat });
    _slider(ssr, w, "ssrEdgeFade", { label: "Edge fade", min: 0, max: 0.5, step: 0.005, onChange: onMat });

    // ── Sun glint ───────────────────────────────────────────────────────────
    const gl = _section(panel, "Sun glint", false);
    _color(gl, w, "sunColor", { label: "Sun colour", onChange: onMat });
    _slider(gl, w, "shininess", { label: "Shininess", min: 1, max: 2000, step: 1, onChange: onMat });
    _slider(gl, w, "glintStrength", { label: "Glow", min: 0, max: 20, step: 0.1, onChange: onMat });
    _slider(gl, w, "glintFresnel", { label: "Fresnel influence", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(gl, w, "glintSpread", { label: "Spread", min: 0, max: 1, step: 0.01, onChange: onMat });
    _slider(gl, w, "glintShoreFade", { label: "Shore fade", min: 0, max: 1, step: 0.005, onChange: onMat });

    // ── Danger zone ─────────────────────────────────────────────────────────
    if (count > 0) {
      const dz = _section(panel, "Reset", false);
      _button(dz, {
        title: "Delete all rivers",
        hint: "Removes every river and restores the terrain to its unconformed state.",
        onClick: () => { sys.clearAll(); refresh(); },
      });
    }
  }

  refresh();
  return { refresh };
}
