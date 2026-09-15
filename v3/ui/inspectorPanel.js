/**
 * The Inspector tab: the properties of the ONE object that is selected — in
 * the Scene list, or by clicking it in the viewport — editable in place, like
 * Unity's and Unreal's.
 *
 * It inspects a Scene-list key ("prop:12", "lake:0", "sun"...). Each kind has a
 * small builder that draws its fields with the shared widgets and edits the
 * object through the SAME calls its tool uses, so undo, rebuilds and saving
 * behave exactly as when the tool panel changes it. The heavy controls stay in
 * the tool panels; "Edit in tool" opens them.
 *
 * Values refresh a few times a second while the tab is visible, so a gizmo
 * drag, an undo or a tool panel edit shows up here without a rebuild.
 */
import { section, slider, color, toggle, button, info, hint, numbers } from "./widgets.js";

const REFRESH_MS = 200;
const RAD = Math.PI / 180;

/**
 * @param {object} o
 * @param {HTMLElement} o.container      the #tab-inspector element
 * @param {object} o.deps               editor systems (see main.js)
 */
export function createInspector({ container, deps }) {
  let key = null;
  let handles = [];
  let stillExists = () => true;
  let lastRefresh = 0;

  function _actions(body, list) {
    const row = document.createElement("div");
    row.className = "inspector-actions";
    for (const a of list) if (a) button(row, a);
    body.appendChild(row);
  }

  function _title(text, kindLabel) {
    const t = document.createElement("div");
    t.className = "inspector-title";
    t.textContent = text;
    if (kindLabel) {
      const k = document.createElement("span");
      k.className = "inspector-kind";
      k.textContent = kindLabel;
      t.appendChild(k);
    }
    container.appendChild(t);
  }

  const frameAction = (k) => ({ title: "Focus", hint: "Frame it in the viewport (Shift+F)", onClick: () => deps.frame(k) });
  const toolAction = (mode, label = "Edit in tool") => ({ title: label, hint: "Open its tool panel", onClick: () => deps.openTool(mode) });

  // ── Kinds ─────────────────────────────────────────────────────────────────

  const KINDS = {
    terrain() {
      const w = deps.world;
      _title("Terrain", "GPU clipmap");
      const b = section(container, "Terrain", true);
      info(b, "World", `${w.worldSize} × ${w.worldSize} m`, { layout: "prop" });
      info(b, "Heightmap", `${w.heightmapSize} × ${w.heightmapSize}`, { layout: "prop" });
      info(b, "Splatmap", `${w.splatSize} × ${w.splatSize} (${+(w.worldSize / w.splatSize).toFixed(3)} m/texel)`, { layout: "prop" });
      info(b, "Max height", `${w.maxHeight} m`, { layout: "prop" });
      info(b, "LOD levels", String(w.lodLevels), { layout: "prop" });
      info(b, "Backend", "WebGPU · TSL", { layout: "prop" });
      _actions(container, [toolAction("sculpt", "Sculpt"), toolAction("paint", "Paint")]);
      return [];
    },

    sun() {
      const L = deps.env.light;
      _title("Sun & light", "World");
      const b = section(container, "Sun", true);
      if (deps.env.skyMode() === "procedural") {
        hint(b, "The Procedural sky's time of day places the sun, so Azimuth and Elevation follow it (see Sky).");
      }
      // The renderer reads these every frame, and the World tab's controls
      // follow them live, so no change callback is needed.
      const hs = [
        slider(b, L, "sunAzimuth", { label: "Azimuth", min: 0, max: 360, step: 1 }),
        slider(b, L, "sunElevation", { label: "Elevation", min: -90, max: 90, step: 1 }),
        color(b, L, "dirColor", { label: "Sun color" }),
        slider(b, L, "dirIntensity", { label: "Intensity", min: 0, max: 5, step: 0.1 }),
      ];
      const a = section(container, "Ambient & exposure", true);
      hs.push(
        slider(a, L, "hemiIntensity", { label: "Ambient", min: 0, max: 3, step: 0.1 }),
        slider(a, L, "envIntensity", { label: "Env map", min: 0, max: 2, step: 0.01 }),
        slider(a, L, "exposure", { label: "Exposure", min: 0.1, max: 2, step: 0.05 }),
      );
      _actions(container, [{ title: "More in World tab", onClick: () => deps.openTab("world") }]);
      return hs;
    },

    sky() {
      const ps = deps.env.proceduralSky;
      const mode = deps.env.skyMode();
      _title("Sky", "World");
      const b = section(container, "Sky", true);
      info(b, "Mode", { physical: "Physical", hdr: "HDR image", procedural: "Procedural (day/night)" }[mode] ?? mode, { layout: "prop" });
      const hs = [];
      if (mode === "procedural") {
        const t = section(container, "Time of day", true);
        hs.push(
          slider(t, ps, "timeOfDay", { label: "Time (h)", min: 0, max: 24, step: 0.01, onChange: () => deps.env.setTimeOfDay(ps.timeOfDay) }),
          toggle(t, ps, "autoAdvance", { label: "Auto-advance" }),
          slider(t, ps, "daySpeed", { label: "Day speed (h/s)", min: 0.05, max: 4, step: 0.05 }),
        );
      } else {
        hint(b, "Time of day, clouds and stars come with the Procedural sky. Switch the mode in the World tab.");
      }
      _actions(container, [{ title: "More in World tab", onClick: () => deps.openTab("world") }]);
      return hs;
    },

    fog() {
      const F = deps.env.fog;
      const sync = () => deps.env.syncFog();
      _title("Fog", "World");
      const h = section(container, "Height fog", true);
      const d = section(container, "Distance fog", true);
      _actions(container, [{ title: "More in World tab", onClick: () => deps.openTab("world") }]);
      return [
        toggle(h, F.height, "enabled", { label: "Enabled", onChange: sync }),
        slider(h, F.height, "density", { label: "Density", min: 0.001, max: 0.05, step: 0.001, onChange: sync }),
        slider(h, F.height, "height", { label: "Base height", min: -60, max: 500, step: 1, onChange: sync }),
        toggle(d, F.distance, "enabled", { label: "Enabled", onChange: sync }),
        slider(d, F.distance, "density", { label: "Density", min: 0.0001, max: 0.05, step: 0.0001, onChange: sync }),
      ];
    },

    prop(arg) {
      const P = deps.props;
      const id = Number(arg);
      const inst = () => P.store.instances[P.store.indexOfId(id)];
      stillExists = () => !!inst();
      const p = inst();
      if (!p) return null;
      const type = P.store.types[p.typeIdx];
      _title(`${type?.name ?? "Prop"} #${id}`, "Prop");
      // A view the fields edit; applied to the prop through the props tool.
      const view = {};
      const pull = () => {
        const q = inst();
        if (!q) return;
        Object.assign(view, { px: q.px, py: q.py, pz: q.pz, rx: q.rx, ry: q.ry, rz: q.rz, sx: q.sx, sy: q.sy, sz: q.sz });
      };
      pull();
      const apply = (k) => {
        const idx = P.store.indexOfId(id);
        if (idx < 0) return;
        if (P.instancer.selectedId !== id || P.instancer.selectionCount !== 1) P.select(idx);
        P.propSys.beginEdit();
        P.store.updateInstance(idx, { [k]: view[k] });
        P.instancer.select(idx);   // gizmo + selection box follow
        P.propSys.endEdit();
        P.changed();
      };
      const t = section(container, "Transform", true);
      const hs = [
        numbers(t, view, ["px", "py", "pz"], { label: "Position", step: 0.01, onChange: apply, fieldTitles: ["X", "Y", "Z"] }),
        numbers(t, view, ["rx", "ry", "rz"], { label: "Rotation °", step: 0.1, onChange: apply, fieldTitles: ["X", "Y", "Z"] }),
        numbers(t, view, ["sx", "sy", "sz"], { label: "Scale", step: 0.01, min: 0.001, onChange: apply, fieldTitles: ["X", "Y", "Z"] }),
      ];
      if (type?.live) hint(t, "A live prop: its own settings are in the Props panel.");
      _actions(container, [
        frameAction(`prop:${id}`),
        { title: "Duplicate", hint: "Ctrl+D", onClick: () => P.duplicate() },
        { title: "Delete", hint: "Del", onClick: () => P.remove() },
      ]);
      return hs.map((h) => ({ refresh() { pull(); h.refresh(); } }));
    },

    propSelection() {
      const P = deps.props;
      stillExists = () => P.instancer.selectionCount > 1;
      _title(`${P.instancer.selectionCount} props selected`, "Props");
      const b = section(container, "Selection", true);
      const count = info(b, "Props", String(P.instancer.selectionCount), { layout: "prop" });
      hint(b, "Move, rotate or scale them together with the gizmo (W / E / R).");
      _actions(container, [
        { title: "Focus", onClick: () => deps.frameSelection() },
        { title: "Duplicate", onClick: () => P.duplicate() },
        { title: "Delete", onClick: () => P.remove() },
      ]);
      return [{ refresh() { count.update(String(P.instancer.selectionCount)); } }];
    },

    propType(arg) {
      const P = deps.props;
      const typeIdx = Number(arg);
      const type = P.store.types[typeIdx];
      stillExists = () => !!P.store.types[typeIdx];
      if (!type) return null;
      _title(type.name ?? `Type ${typeIdx}`, "Prop type");
      const b = section(container, "Type", true);
      const n = () => P.store.instances.reduce((c, q) => c + (q.typeIdx === typeIdx ? 1 : 0), 0);
      const count = info(b, "Placed", String(n()), { layout: "prop" });
      info(b, "Kind", type.live ? "Live (animated)" : "Instanced mesh", { layout: "prop" });
      _actions(container, [frameAction(`propType:${typeIdx}`), toolAction("props")]);
      return [{ refresh() { count.update(String(n())); } }];
    },

    lake(arg) {
      const S = deps.lakes;
      const i = Number(arg);
      // Undo rebuilds the lake objects, so always go through the index.
      const lakeAt = () => S.system.lakes[i];
      stillExists = () => !!lakeAt();
      if (!lakeAt()) return null;
      _title(`Lake ${i + 1}`, "Lake");
      const view = {};
      const pull = () => {
        const l = lakeAt();
        if (l) Object.assign(view, { level: l.level, cx: l.cx, cz: l.cz, sizeX: l.sizeX, sizeZ: l.sizeZ });
      };
      pull();
      const commit = (k) => {
        const l = lakeAt();
        if (!l) return;
        l[k] = view[k];
        if ((S.slice.activeIndex | 0) !== i) S.system.setActiveIndex(i);
        S.system.syncActiveTransform();
        S.history.commit();
        S.ui?.refresh();
      };
      const b = section(container, "Placement", true);
      const hs = [
        numbers(b, view, ["level"], { label: "Water level", step: 0.1, onChange: commit }),
        numbers(b, view, ["cx", "cz"], { label: "Center", step: 1, onChange: commit, fieldTitles: ["X", "Z"] }),
        numbers(b, view, ["sizeX", "sizeZ"], { label: "Size", step: 1, min: 4, onChange: commit, fieldTitles: ["X", "Z"] }),
      ].map((h) => ({ refresh() { pull(); h.refresh(); } }));
      _actions(container, [
        frameAction(`lake:${i}`),
        toolAction("lake"),
        {
          title: "Delete",
          onClick: () => {
            S.system.setActiveIndex(i);
            S.system.deleteActive();
            S.history.commit();
            S.ui?.refresh();
            inspect(null);
          },
        },
      ]);
      return hs;
    },

    tunnel(arg) {
      const S = deps.tunnels;
      const i = Number(arg);
      const tun = () => S.system.tunnels[i];
      stillExists = () => !!tun();
      const t = tun();
      if (!t) return null;
      const cave = t.style === "cave";
      _title(`${cave ? "Cave" : "Tunnel"} ${i + 1}`, cave ? "Cave" : "Tunnel");
      const b = section(container, "Shape", true);
      const length = info(b, "Length", "", { layout: "prop" });
      const nodes = info(b, "Nodes", "", { layout: "prop" });
      const view = { width: t.width, height: t.height, thickness: t.thickness };
      const apply = () => {
        if (S.system.activeIndex !== i) S.system.setActiveIndex(i);
        S.system.setActiveSection({ ...view });
        S.ui?.refresh();
      };
      const section3 = numbers(b, view, ["width", "height", "thickness"], {
        label: "W / H / wall", step: 0.1, min: 0.1, onChange: apply, fieldTitles: ["Width", "Height", "Wall"],
      });
      _actions(container, [
        frameAction(`tunnel:${i}`),
        toolAction("tunnel"),
        { title: "Delete", onClick: () => { S.system.setActiveIndex(i); S.system.deleteActiveTunnel(); S.ui?.refresh(); inspect(null); } },
      ]);
      return [{
        refresh() {
          const q = tun();
          if (!q) return;
          length.update(q._sampled ? `${q._sampled.length.toFixed(0)} m` : "—");
          nodes.update(String(q.nodes.length));
          Object.assign(view, { width: q.width, height: q.height, thickness: q.thickness });
          section3.refresh();
        },
      }];
    },

    river(arg) {
      const S = deps.rivers;
      const i = Number(arg);
      const riv = () => S.system.rivers[i];
      stillExists = () => !!riv();
      if (!riv()) return null;
      _title(`River ${i + 1}`, "River");
      const b = section(container, "River", true);
      const nodes = info(b, "Nodes", "", { layout: "prop" });
      const len = info(b, "Length", "", { layout: "prop" });
      hint(b, "Width, depth and flow are set per node in the River tool.");
      _actions(container, [frameAction(`river:${i}`), toolAction("riverv2")]);
      return [{
        refresh() {
          const r = riv();
          if (!r) return;
          nodes.update(String(r.nodes.length));
          let m = 0;
          for (let k = 1; k < r.nodes.length; k++) m += Math.hypot(r.nodes[k].x - r.nodes[k - 1].x, r.nodes[k].z - r.nodes[k - 1].z);
          len.update(`${m.toFixed(0)} m`);
        },
      }];
    },

    road() {
      const R = deps.road.system;
      stillExists = () => (R?.nodes?.length ?? 0) > 0;
      if (!stillExists()) return null;
      _title("Road network", "Road");
      const b = section(container, "Network", true);
      const nodes = info(b, "Nodes", "", { layout: "prop" });
      const edges = info(b, "Segments", "", { layout: "prop" });
      const bridges = info(b, "Bridges", "", { layout: "prop" });
      _actions(container, [frameAction("road"), toolAction("road")]);
      return [{
        refresh() {
          nodes.update(String(R.nodes.length));
          edges.update(String(R.edges.length));
          bridges.update(String(R.edges.filter((e) => e.bridge).length));
        },
      }];
    },

    spawnPoint() {
      const S = deps.spawn;
      stillExists = () => S.system.placed;
      if (!S.system.placed) return null;
      _title("Player start", "Spawn");
      const view = {};
      const pull = () => { const s = S.system.state; Object.assign(view, { x: s.x, z: s.z, yaw: s.yaw / RAD }); };
      pull();
      const apply = () => { S.system.setPosition(view.x, view.z, view.yaw * RAD); S.ui?.refresh(); };
      const b = section(container, "Placement", true);
      const hs = [
        numbers(b, view, ["x", "z"], { label: "Position", step: 0.1, onChange: apply, fieldTitles: ["X", "Z"] }),
        numbers(b, view, ["yaw"], { label: "Facing °", step: 1, onChange: apply }),
      ];
      _actions(container, [
        frameAction("spawnPoint"),
        { title: "Place at camera", onClick: () => { S.placeAtCamera(); S.ui?.refresh(); } },
        { title: "Clear", onClick: () => { S.system.clear(); S.ui?.refresh(); inspect(null); } },
      ]);
      return hs.map((h) => ({ refresh() { pull(); h.refresh(); } }));
    },

    group(arg) {
      const g = deps.groups[arg];
      if (!g) return null;
      _title(g.label, "Group");
      const b = section(container, g.label, true);
      const count = info(b, "Objects", String(g.count()), { layout: "prop" });
      hint(b, "Pick one in the Scene list to see its properties.");
      _actions(container, [g.mode ? toolAction(g.mode) : null]);
      return [{ refresh() { count.update(String(g.count())); } }];
    },
  };

  const GROUP_KEYS = new Set(["props", "tunnels", "rivers", "lakes", "roads", "spawn", "environment"]);

  function _empty() {
    const d = document.createElement("div");
    d.className = "inspector-empty";
    d.textContent = "Nothing selected. Click an object in the Scene list, or in the viewport in View mode.";
    container.appendChild(d);
  }

  /** Show `k`'s properties (null clears). Returns true when it has something to show. */
  function inspect(k) {
    key = k ?? null;
    container.replaceChildren();
    handles = [];
    stillExists = () => true;
    if (!key) { _empty(); deps.onChange?.(key); return false; }
    const [kind, arg] = key.split(":");
    const build = GROUP_KEYS.has(kind) ? () => KINDS.group(kind) : KINDS[kind] ? () => KINDS[kind](arg) : null;
    const built = build?.();
    if (!built) {
      key = null;
      container.replaceChildren();
      _empty();
      deps.onChange?.(key);
      return false;
    }
    handles = built;
    for (const h of handles) h.refresh?.();
    deps.onChange?.(key);
    return true;
  }

  /** Call every frame; refreshes values while the tab is visible. */
  function refresh(now) {
    if (now - lastRefresh < REFRESH_MS || !container.offsetParent) return;
    lastRefresh = now;
    if (key && !stillExists()) { inspect(null); return; }
    for (const h of handles) h.refresh?.();
  }

  _empty();
  return {
    inspect,
    refresh,
    /** Rebuild the current view (e.g. after a project load). */
    rebuild: () => inspect(key),
    get key() { return key; },
  };
}
