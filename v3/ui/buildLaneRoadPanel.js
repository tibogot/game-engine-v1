/**
 * v3/ui/buildLaneRoadPanel.js — Lane Road mode inspector (3D preview of the
 * lane-based road engine).
 *
 * Test scene, cross-section heights, colours, and the build/mesh numbers.
 */
import { PREVIEW_SCENES } from "../roads/mesh/previewScenes.js";
import { section as _section, slider as _slider, color as _color, toggle as _toggle, button as _button, hint as _hint } from "./widgets.js";
import { uiById } from "./uiRoot.js";

function _choice(parent, label, options, current, onPick, hint) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><select class="prop-dropdown">${options
    .map(([v, t]) => `<option value="${v}"${v === current ? " selected" : ""}>${t}</option>`).join("")}</select></div>`;
  row.querySelector("select").addEventListener("change", (e) => onPick(e.target.value));
  parent.appendChild(row);
}

/**
 * @param {object} app
 * @param {import("../tools/laneRoadSystem.js").LaneRoadSystem} app.laneRoadSystem
 * @param {() => void} [app.onFrame]  frame the loaded scene in the view
 * @returns {{ refresh: () => void }}
 */
export function buildLaneRoadPanel(app) {
  const panel = uiById("lane-road-panel");
  if (!panel) return { refresh: () => {} };

  let _rebuildTimer = 0;
  function rebuildSoon() {
    clearTimeout(_rebuildTimer);
    _rebuildTimer = setTimeout(() => { app.laneRoadSystem.rebuild(); refresh(); }, 60);
  }

  function refresh() {
    panel.innerHTML = "";
    const sys = app.laneRoadSystem;
    const p = sys.params;

    // ── Scene ───────────────────────────────────────────────────────────────
    const sc = _section(panel, "Lane road (preview)", true);
    _hint(sc, "3D preview of the new lane-based road engine. Pick a test scene; it is placed at the centre of the view, on the terrain. Smart Road 2 is untouched, and nothing here is saved in the project (the terrain grade is a normal undoable edit).");
    _choice(sc, "Scene", Object.entries(PREVIEW_SCENES).map(([k, d]) => [k, d.label]), p.scene,
      (v) => { sys.load(v); refresh(); });
    _button(sc, {
      title: sys.loaded ? "Move to view centre" : "Load",
      hint: "Drops the scene at the centre of the view, on the ground there.",
      onClick: () => { sys.load(p.scene); refresh(); },
    });
    if (sys.loaded) {
      if (app.onFrame) _button(sc, { title: "Frame", onClick: () => app.onFrame() });
      _button(sc, { title: "Clear", onClick: () => { sys.clear(); refresh(); } });
      _toggle(sc, p, "visible", { label: "Visible", onChange: () => sys.setVisible(p.visible) });
    }

    // ── Shape ───────────────────────────────────────────────────────────────
    const sh = _section(panel, "Cross-section", true);
    _slider(sh, p, "roadScale", {
      label: "Road scale", min: 0.5, max: 2, step: 0.05, onChange: rebuildSoon,
      hint: "How much wider than real the drivable road is. 1 = real (3.25 m lanes); games use 1.2–1.5. Scales lanes, medians, corner radii and roundabouts; sidewalks, paint and curves stay real.",
    });
    // Crown is edited in % (the engine takes a fraction).
    const crownUi = { crownPct: p.crown * 100 };
    _slider(sh, crownUi, "crownPct", {
      label: "Crown (%)", min: 0, max: 4, step: 0.1, onChange: () => { p.crown = crownUi.crownPct / 100; rebuildSoon(); },
      hint: "Cross fall from each carriageway's crown line down to its kerbs, so rain drains to the gutters (the wet asphalt pools there). 2.5 % is typical.",
    });
    _toggle(sh, p, "banking", {
      label: "Banking", onChange: rebuildSoon,
      hint: "Superelevation on fast curves (rural roads, motorways, ramps), from the engine's design values for speed and radius. City streets are crowned only.",
    });
    _slider(sh, p, "curbHeight", { label: "Curb (m)", min: 0.05, max: 0.3, step: 0.01, onChange: rebuildSoon, hint: "Sidewalks, splitter islands, dead-end caps." });
    _slider(sh, p, "medianHeight", { label: "Median (m)", min: 0.05, max: 0.4, step: 0.01, onChange: rebuildSoon });
    _slider(sh, p, "apronHeight", { label: "Apron (m)", min: 0.02, max: 0.2, step: 0.01, onChange: rebuildSoon, hint: "Roundabout truck apron — low, so it can be driven over." });
    _slider(sh, p, "islandHeight", { label: "Island (m)", min: 0.05, max: 0.5, step: 0.01, onChange: rebuildSoon, hint: "Roundabout central island." });
    _slider(sh, p, "bevel", { label: "Curb bevel (m)", min: 0, max: 0.05, step: 0.005, onChange: rebuildSoon, hint: "45° chamfer on the top edge of every curb." });
    _slider(sh, p, "curbBand", { label: "Curb stone (m)", min: 0, max: 0.4, step: 0.01, onChange: rebuildSoon, hint: "Concrete band round grass tops (medians, verges, island)." });
    _slider(sh, p, "islandWall", {
      label: "Island wall (m)", min: 0, max: 1.5, step: 0.05, onChange: rebuildSoon,
      hint: "Collision only (not drawn): a wall this tall round the roundabout island, splitter islands and raised medians, so the car hits them. 0 = climbable like a kerb.",
    });

    // ── Terrain ─────────────────────────────────────────────────────────────
    const tr = _section(panel, "Terrain", true);
    _toggle(tr, p, "fitTerrain", {
      label: "Fit to terrain", onChange: rebuildSoon,
      hint: "On: junctions sit on planes fitted to the ground, roads follow it within their grade limits, and the terrain is graded under them with a shoulder. Off: a flat plate, terrain untouched (the grade comes off).",
    });
    if (p.fitTerrain) {
      _slider(tr, p, "shoulder", { label: "Shoulder (m)", min: 1, max: 30, step: 0.5, onChange: rebuildSoon, hint: "How far past the property line the graded ground blends back to the hills." });
      _slider(tr, p, "embed", { label: "Under road (m)", min: 0.05, max: 1, step: 0.05, onChange: rebuildSoon, hint: "How far the terrain sits below the road surface inside the footprint, so it never pokes through." });
      _button(tr, { title: "Bake grade", hint: "Keep the current grade as the terrain (the base for later grades).", onClick: () => { sys.bakeGrade(); refresh(); } });
      _button(tr, { title: "Remove grade", hint: "Put the terrain back as it was before this grade (turns fitting off).", onClick: () => { p.fitTerrain = false; sys.rebuild(); refresh(); } });
    } else {
      _slider(tr, p, "lift", {
        label: "Above ground (m)", min: 0, max: 3, step: 0.01, onChange: rebuildSoon,
        hint: "Flat plate: road surface height over the ground at the scene centre.",
      });
    }

    // ── Markings ────────────────────────────────────────────────────────────
    const mk = _section(panel, "Markings", true);
    const onColor = () => sys.syncMaterialColors();
    _hint(mk, "Painted by the asphalt shader: lines along roads are drawn from the lane data, junction shapes come from a distance-field atlas. The paint shares the asphalt's wear and wet film.");
    _toggle(mk, p, "markings", { label: "Markings", onChange: rebuildSoon, hint: "Lane lines, crosswalks, stop/yield lines, arrows." });
    const onWear = () => sys.syncPaintWear();
    _slider(mk, p, "wearAmount", { label: "Wear", min: 0, max: 4, step: 0.05, onChange: onWear, hint: "0 = fresh paint. Over 1 clips old stretches to fully worn and leaves fresh ones alone." });
    _slider(mk, p, "wearBite", { label: "Edge bite", min: 0, max: 1, step: 0.01, onChange: onWear, hint: "How much of a line's half-width worn edges eat away." });
    _slider(mk, p, "wearBase", { label: "Off wheel paths", min: 0, max: 1, step: 0.01, onChange: onWear, hint: "Wear away from where tyres run, as a fraction of the wheel-path wear." });
    _slider(mk, p, "crossWear", { label: "Crossing wear", min: 0, max: 2, step: 0.01, onChange: onWear, hint: "Junction shapes (crosswalks, arrows, stop lines) relative to lane lines." });
    _color(mk, p, "paintWhite", { label: "White", onChange: onColor });
    _color(mk, p, "paintYellow", { label: "Yellow", onChange: onColor });

    // ── Asphalt ─────────────────────────────────────────────────────────────
    const as = _section(panel, "Asphalt (city street surface)", true);
    const onAsphalt = () => sys.syncAsphalt();
    _color(as, p, "asphaltDark", { label: "Dark", onChange: onAsphalt });
    _color(as, p, "asphaltLight", { label: "Light", onChange: onAsphalt });
    _slider(as, p, "deckBrightness", { label: "Brightness", min: 0.2, max: 2, step: 0.01, onChange: onAsphalt });
    _slider(as, p, "patchAmount", { label: "Patches", min: 0, max: 1, step: 0.01, onChange: onAsphalt, hint: "Resurfacing patches with sealant seams — darker, glossier." });
    _slider(as, p, "patchChance", { label: "Patch density", min: 0, max: 1, step: 0.01, onChange: onAsphalt });
    _slider(as, p, "chipRelief", { label: "Stone relief (m)", min: 0, max: 0.05, step: 0.001, onChange: onAsphalt, hint: "Height of the cellular stones in the normal. Reads most under grazing and headlight light." });
    _slider(as, p, "gritRelief", { label: "Grit relief (m)", min: 0, max: 0.03, step: 0.001, onChange: onAsphalt });

    // ── Weather ─────────────────────────────────────────────────────────────
    const we = _section(panel, "Weather", true);
    _toggle(we, p, "wet", { label: "Wet", onChange: () => { sys.setWet(p.wet); refresh(); }, hint: "Compiles the water film into the asphalt (a material swap, not a slider)." });
    if (p.wet) {
      _slider(we, p, "wetAmount", { label: "Wetness", min: 0, max: 1, step: 0.01, onChange: () => sys.syncWetAmounts() });
      _slider(we, p, "puddleAmount", { label: "Puddles", min: 0, max: 2, step: 0.01, onChange: () => sys.syncWetAmounts() });
    }

    // ── Look ────────────────────────────────────────────────────────────────
    const lk = _section(panel, "Look", false);
    _color(lk, p, "slabColor", { label: "Sidewalk", onChange: onColor });
    _color(lk, p, "curbColor", { label: "Curb stone", onChange: onColor });
    _color(lk, p, "apronColor", { label: "Apron", onChange: onColor });
    _color(lk, p, "grassColor", { label: "Grass", onChange: onColor });
    _toggle(lk, p, "curbShadows", {
      label: "Curb shadows", onChange: () => sys.setCurbShadows(p.curbShadows),
      hint: "Concrete mesh in the shadow pass (one extra draw per cascade).",
    });

    // ── Stats ───────────────────────────────────────────────────────────────
    const st = sys.stats;
    if (st) {
      const ss = _section(panel, "Stats", true);
      _hint(ss, `${st.roads} roads · ${st.nodes} nodes · ${st.junctions} junctions · ${st.roundabouts} roundabouts`);
      _hint(ss, `${st.draws} draw calls · ${st.triangles.toLocaleString()} triangles · ${st.vertices.toLocaleString()} vertices`);
      _hint(ss, `Build ${st.totalMs.toFixed(1)} ms (network ${st.networkMs.toFixed(1)}, mesh ${st.meshMs.toFixed(1)} incl. atlas ${st.atlasMs.toFixed(1)})`);
      _hint(ss, `Marking atlas: ${st.atlas}`);
      const gs = sys.gradeStats;
      if (sys.fitting && gs) _hint(ss, `Terrain grade ${gs.conformMs.toFixed(1)} ms + GPU push ${gs.pushMs.toFixed(1)} ms`);
      if (st.issues) _hint(ss, `${st.issues} engine issue${st.issues === 1 ? "" : "s"} (warnings/errors) — see the 2D lab for where.`);
    }
  }

  refresh();
  return { refresh };
}
