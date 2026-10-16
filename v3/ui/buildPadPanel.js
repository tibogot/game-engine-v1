/**
 * Pads mode panel (Tools tab) — the next pad's settings, and the selected pad's.
 * `padFields` draws a pad's own fields; the Inspector uses it too, so a pad
 * edits the same way from both places (and every change is one undo step).
 */
import { section, slider, toggle, dropdown, button, hint, info } from "./widgets.js";

const DEG = 180 / Math.PI;

/**
 * The fields of one pad. Returns widget handles with `refresh()`.
 * @param {HTMLElement} body
 * @param {number} id
 * @param {{ system, editor }} deps
 */
export function padFields(body, id, { system, editor }) {
  const p0 = system.get(id);
  if (!p0) return [];
  // A plain view the widgets bind to, pulled from the pad on every refresh.
  const view = {};
  const pull = () => {
    const p = system.get(id);
    if (!p) return;
    Object.assign(view, p, { rotDeg: Math.round((p.rot * DEG) * 10) / 10, sizeX: p.halfX * 2, sizeZ: p.halfZ * 2 });
  };
  pull();
  const commit = (patch, coalesce) => {
    if (editor.selectedId !== id) editor.select(id);
    editor.edit(patch, { coalesce });
  };
  const hs = [];
  const attached = p0.attach != null;
  hs.push(toggle(body, view, "enabled", { label: "On", hint: "Off keeps the pad in the level with no effect on the ground", onChange: (v) => commit({ enabled: v }) }));
  hs.push(dropdown(body, view, "shape", { label: "Shape", options: { Rectangle: "rect", Circle: "circle" }, onChange: () => commit({ shape: view.shape }) }));
  if (attached) {
    info(body, "Attached to", `prop #${p0.attach} — the pad follows it`, { layout: "prop" });
    hs.push(slider(body, view, "margin", { label: "Margin (m)", min: 0, max: 20, step: 0.25, hint: "Flat ground around the prop's footprint", onChange: () => commit({ margin: view.margin }, `pad${id}margin`) }));
  } else {
    hs.push(slider(body, view, "sizeX", {
      label: view.shape === "circle" ? "Diameter (m)" : "Size X (m)", min: 0.5, max: 400, step: 0.5, curve: "log",
      onChange: () => commit({ halfX: view.sizeX / 2 }, `pad${id}x`),
    }));
    if (view.shape !== "circle") {
      hs.push(slider(body, view, "sizeZ", { label: "Size Z (m)", min: 0.5, max: 400, step: 0.5, curve: "log", onChange: () => commit({ halfZ: view.sizeZ / 2 }, `pad${id}z`) }));
      hs.push(slider(body, view, "rotDeg", { label: "Rotation (°)", min: -180, max: 180, step: 0.5, onChange: () => commit({ rot: view.rotDeg / DEG }, `pad${id}rot`) }));
    }
  }
  hs.push(slider(body, view, "rim", { label: "Soft edge (m)", min: 0, max: 60, step: 0.5, hint: "The pad eases back to the ground over this distance", onChange: () => commit({ rim: view.rim }, `pad${id}rim`) }));
  hs.push(dropdown(body, view, "heightMode", {
    label: "Height",
    options: { "Follow the ground": "follow", "Fixed": "fixed" },
    hint: "Follow: levels to the average ground under it, again whenever that ground changes. Fixed: an exact height.",
    onChange: () => {
      // Switching to Fixed starts from where the pad is now, not from 0 m.
      const patch = { heightMode: view.heightMode };
      if (view.heightMode === "fixed") patch.height = Math.round((editor.currentHeight?.(id) ?? view.height) * 10) / 10;
      commit(patch);
      editor.onPanelRebuild?.();
    },
  }));
  if (view.heightMode === "fixed") {
    hs.push(slider(body, view, "height", { label: "Height (m)", min: -50, max: 2000, step: 0.1, onChange: () => commit({ height: view.height }, `pad${id}h`) }));
  }
  hs.push(slider(body, view, "offset", { label: "Offset (m)", min: -30, max: 30, step: 0.1, hint: "Raise (or sink) the pad above the height it levels to", onChange: () => commit({ offset: view.offset }, `pad${id}off`) }));
  return hs.map((h) => ({ refresh() { pull(); h.refresh(); } }));
}

/**
 * @param {HTMLElement} root  #pad-panel
 * @param {{ system, editor }} deps
 */
export function buildPadPanel(root, deps) {
  const { system, editor } = deps;
  let handles = [];
  let builtFor = undefined;

  function rebuild(force = false) {
    const sel = editor.selectedId;
    const key = `${sel}|${system.get(sel)?.shape}|${system.get(sel)?.heightMode}|${system.get(sel)?.attach}|${system.pads.length}`;
    if (!force && key === builtFor) { for (const h of handles) h.refresh(); return; }
    builtFor = key;
    root.innerHTML = "";
    handles = [];

    const intro = section(root, "Pads", true);
    hint(intro, "Flattened zones — a building pad, a paddock, an airfield. Click the ground to place one, "
      + "click a pad to select it (W move · E turn · R resize). Shift+click places on top of another. "
      + "Del deletes, Ctrl+D duplicates. Pads are saved in the level and applied in games.");

    if (sel != null && system.get(sel)) {
      const b = section(root, `Selected pad #${sel}`, true);
      handles.push(...padFields(b, sel, deps));
      const row = document.createElement("div");
      row.className = "inspector-actions";
      if (system.get(sel).attach != null) button(row, { title: "Detach from prop", onClick: () => { const f = system.footprintOf(sel); editor.edit({ attach: null, x: f.x, z: f.z, rot: f.rot, halfX: f.halfX, halfZ: f.halfZ }); rebuild(true); } });
      button(row, { title: "Duplicate", onClick: () => editor.duplicateSelected() });
      button(row, { title: "Delete", onClick: () => editor.deleteSelected() });
      b.appendChild(row);
    }

    const n = section(root, "Next pad", sel == null);
    handles.push(dropdown(n, editor.place, "shape", { label: "Shape", options: { Rectangle: "rect", Circle: "circle" } }));
    const view = { sizeX: editor.place.halfX * 2, sizeZ: editor.place.halfZ * 2 };
    handles.push(slider(n, view, "sizeX", { label: "Size X (m)", min: 0.5, max: 400, step: 0.5, curve: "log", onChange: () => { editor.place.halfX = view.sizeX / 2; } }));
    handles.push(slider(n, view, "sizeZ", { label: "Size Z (m)", min: 0.5, max: 400, step: 0.5, curve: "log", onChange: () => { editor.place.halfZ = view.sizeZ / 2; } }));
    handles.push(slider(n, editor.place, "rim", { label: "Soft edge (m)", min: 0, max: 60, step: 0.5 }));
    hint(n, `${system.pads.length} pad${system.pads.length === 1 ? "" : "s"} in this level. A prop gets one under it from its Inspector (Add pad under it).`);
  }

  editor.onPanelRebuild = () => rebuild(true);
  rebuild(true);
  return { rebuild, refresh: () => { for (const h of handles) h.refresh(); } };
}
