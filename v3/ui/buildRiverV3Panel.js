/**
 * v3/ui/buildRiverV3Panel.js — River v3 (network) inspector.
 *
 * Deliberately small: the network, the selected node or junction, display.
 * The water LOOK is River v2's own settings object (shared in main.js), so it
 * is edited in River v2's panel and both rivers always look the same.
 */
import { section as _section, slider as _slider, toggle as _toggle, button as _button, hint as _hint } from "./widgets.js";
import { uiById } from "./uiRoot.js";

/**
 * @param {object} app
 * @param {object} app.toolState       has a `.riverV3` slice
 * @param {object} app.riverV3System
 * @param {number} app.maxHeight
 * @param {function} [app.getV2Rivers]  () => River v2's rivers, for converting
 * @param {function} [app.convertFromV2] moves every v2 river into v3
 * @returns {{ refresh: () => void }}
 */
export function buildRiverV3Panel(app) {
  const panel = uiById("riverv3-panel");
  if (!panel) return { refresh: () => {} };

  function refresh() {
    panel.innerHTML = "";
    const p = app.toolState.riverV3;
    const sys = app.riverV3System;
    sys.syncSelectionToState();

    // ── Network ─────────────────────────────────────────────────────────────
    const nw = _section(panel, `Network (${sys.reaches.length} reaches, ${sys.junctions.length} junctions)`, true);
    _hint(nw, "Click the terrain to draw a reach downstream. End a reach ON another one to join it (a tributary). Select an interior node — or a junction (orange) — and click to branch a new reach out of it. Levels meet at every junction and the water adds up downstream.");
    const act = sys.activeReach, s = act ? sys.sol?.reaches.get(act.id) : null;
    if (act) {
      _hint(nw, `Active reach: ${act.nodes.length} nodes` + (s ? ` · ${s.total.toFixed(0)} m · ${s.q.toFixed(1)} m³/s` : "")
        + (s?.hasUphill ? " · ⚠ climbs somewhere (red arrows)" : ""));
    }
    if (sys.sol?.cyclic?.length) _hint(nw, `⚠ ${sys.sol.cyclic.length} reach(es) form a loop and are ignored.`);
    _button(nw, { title: "New reach", hint: "The next click starts a separate reach.", onClick: () => { sys.startNewReach(); refresh(); } });
    if (act) {
      _button(nw, { title: "Reverse active reach", hint: "Node order is the flow direction: turns a branch into a tributary and back.", onClick: () => { sys.reverseActiveReach(); refresh(); } });
      _button(nw, { title: "Delete active reach", onClick: () => { sys.deleteActiveReach(); refresh(); } });
    }
    const v2 = app.getV2Rivers?.() ?? [];
    if (v2.length) {
      _button(nw, {
        title: `Convert River v2 → v3 (${v2.length})`,
        hint: "Moves every River v2 river into this network as a reach, and removes it from River v2 so the two never shape the same ground.",
        onClick: () => { app.convertFromV2?.(); refresh(); },
      });
    }
    if (sys.reaches.length) _button(nw, { title: "Clear all", onClick: () => { sys.clearAll(); refresh(); } });

    // ── Selection ───────────────────────────────────────────────────────────
    const sel = sys.selectedNode();
    if (sel) {
      const sc = _section(panel, `Selected node (${sel.nodeIdx + 1}/${sel.reach.nodes.length})`, true);
      _slider(sc, p, "selWidth", { label: "Width (m)", min: 1, max: 200, step: 0.5, onChange: () => sys.setSelectedChannel({ width: p.selWidth }) });
      _slider(sc, p, "selDepth", { label: "Depth (m)", min: 0.1, max: 30, step: 0.1, onChange: () => sys.setSelectedChannel({ depth: p.selDepth }) });
      _slider(sc, p, "selBank", { label: "Bank (m)", min: 0.5, max: 80, step: 0.5, onChange: () => sys.setSelectedChannel({ bank: p.selBank }) });
      _slider(sc, p, "selLevel", { label: "Water level (m)", min: 0, max: app.maxHeight, step: 0.1, onChange: () => { sys.setSelectedLevel(p.selLevel); refresh(); } });
      _hint(sc, Number.isFinite(sel.node.y) ? "PINNED (gold)." : "AUTO — follows the valley floor.");
      _button(sc, { title: "Follow the ground (un-pin)", onClick: () => { sys.releaseSelectedLevel(); refresh(); } });
    } else if (sys.selected?.kind === "junction") {
      const J = sys.junction(sys.selected.junctionId), info = sys.sol?.junctions.get(J?.id);
      const sc = _section(panel, `Junction (${info?.kind ?? "?"})`, true);
      _hint(sc, `Level ${info?.level?.toFixed(2) ?? "–"} m · inflow ${info?.q?.toFixed(1) ?? 0} m³/s. Every reach end here shares this level. Click the terrain to branch a new reach out of it.`);
      _slider(sc, p, "selLevel", { label: "Water level (m)", min: 0, max: app.maxHeight, step: 0.1, onChange: () => { sys.setSelectedLevel(p.selLevel); refresh(); } });
      _hint(sc, Number.isFinite(J?.y) ? "PINNED (gold)." : "AUTO — solved from the reaches that meet here.");
      _button(sc, { title: "Follow the ground (un-pin)", onClick: () => { sys.releaseSelectedLevel(); refresh(); } });
    }

    // ── New node defaults ───────────────────────────────────────────────────
    const nn = _section(panel, "New node defaults", false);
    _slider(nn, p, "newWidth", { label: "Width (m)", min: 1, max: 200, step: 0.5 });
    _slider(nn, p, "newDepth", { label: "Depth (m)", min: 0.1, max: 30, step: 0.1 });
    _slider(nn, p, "newBank", { label: "Bank (m)", min: 0.5, max: 80, step: 0.5 });

    // ── Display ─────────────────────────────────────────────────────────────
    const dsp = _section(panel, "Display", true);
    _toggle(dsp, p, "showHandles", { label: "Handles", onChange: () => { sys._rebuildHandles(); sys.refreshVisibility(); } });
    _toggle(dsp, p, "showArrows", { label: "Flow arrows", onChange: () => { sys._rebuildArrows(); sys.refreshVisibility(); }, hint: "Blue slow → white fast; RED where the water climbs." });
    _hint(dsp, "Water look: edit it in River v2's panel (Water colour, Surface, Whitewater…). Both rivers share one look.");
  }

  refresh();
  return { refresh };
}
