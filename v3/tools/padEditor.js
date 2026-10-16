/**
 * Pads mode — the editing half of pads (the pads themselves are
 * v3/terrain/padSystem.js and run in games too; this runs only in the editor).
 *
 * Same workflow as Decals:
 *   - click the ground: place a pad there (the next-pad settings below)
 *   - click a pad: select it (gizmo: W move, E turn, R resize)
 *   - Shift+click: place even on top of an existing pad
 *   - click empty ground with one selected: deselect
 *   - Del delete · Ctrl+D duplicate · Esc deselect
 *
 * Every pad's outline is drawn on the ground while the mode is on: the flat
 * area solid, the soft edge faint; the selected one brighter. A pad attached to
 * a prop follows the prop, so the gizmo does not move it (move the prop).
 * Every edit is one undo step (snapshot history of the pad list).
 */
import * as THREE from "three";
import { createSnapshotHistory } from "./snapshotHistory.js";

/** Settings for the NEXT pad placed. */
export function createPadPlaceState() {
  return { shape: "rect", halfX: 5, halfZ: 5, rim: 4 };
}

const SEG = 96;          // outline points per loop (circle) / per pad (rectangle, 4 sides)
const LIFT = 0.25;       // metres above the ground

function _lines(color, opacity) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(3), 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 999;
  lines.frustumCulled = false;
  lines.visible = false;
  return lines;
}

/** The shape's outline in the XZ plane as a closed point list (world metres). */
function outlinePoints(shape, f, grow) {
  const pts = [];
  if (shape === "circle") {
    const r = f.halfX + grow;
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      pts.push([f.x + Math.cos(a) * r, f.z + Math.sin(a) * r]);
    }
    return pts;
  }
  // A rectangle with rounded corners when grown (the rim is a distance, so its
  // outline rounds the corners), turned like three.js Y rotation.
  const hx = f.halfX, hz = f.halfZ, cr = Math.cos(f.rot), sr = Math.sin(f.rot);
  const local = [];
  const per = Math.max(2, Math.floor(SEG / 4));
  const corners = [[hx, hz, 0], [-hx, hz, Math.PI / 2], [-hx, -hz, Math.PI], [hx, -hz, Math.PI * 1.5]];
  for (const [cx, cz, a0] of corners) {
    for (let i = 0; i <= per; i++) {
      const a = a0 + (i / per) * (Math.PI / 2);
      local.push([cx + Math.cos(a) * grow, cz + Math.sin(a) * grow]);
    }
  }
  // local +X → (cos, -sin), local +Z → (sin, cos)
  for (const [lx, lz] of local) pts.push([f.x + lx * cr + lz * sr, f.z - lx * sr + lz * cr]);
  return pts;
}

/**
 * @param {object} o
 * @param {ReturnType<import("../terrain/padSystem.js").createPadSystem>} o.system
 * @param {THREE.Scene} o.scene
 * @param {(wx:number, wz:number) => number} o.groundAt   the ground height (metres)
 * @param {() => number} o.heightVersion   changes when any height changes (outline redraw)
 * @param {(pad, proxy:THREE.Object3D) => void} o.attachGizmo
 * @param {() => void} o.detachGizmo
 * @param {() => void} [o.onChanged]   selection or data changed (panel refresh)
 */
export function createPadEditor({ system, scene, groundAt, heightVersion, attachGizmo, detachGizmo, onChanged }) {
  const place = createPadPlaceState();
  let selectedId = null;
  let active = false;
  let drawnKey = "";
  let hoverAt = null;

  const proxy = new THREE.Object3D();
  proxy.name = "PadGizmoProxy";
  scene.add(proxy);

  const allLines = _lines(0xffffff, 0.45);
  const selLines = _lines(0xffa040, 0.95);
  const ghostLines = _lines(0x80c8ff, 0.6);
  scene.add(allLines, selLines, ghostLines);

  // As TEXT: the history spots "nothing changed" with ===, which a fresh array never is.
  const history = createSnapshotHistory({
    capture: () => JSON.stringify(system.snapshot()),
    restore: (snap) => {
      system.restore(JSON.parse(snap));
      if (selectedId !== null && !system.get(selectedId)) selectedId = null;
      _syncSelection();
      onChanged?.();
    },
  });

  const selected = () => (selectedId === null ? null : system.get(selectedId));

  /** Append a closed loop as line segments draped on the ground. */
  function pushLoop(out, pts) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out.push(a[0], groundAt(a[0], a[1]) + LIFT, a[1], b[0], groundAt(b[0], b[1]) + LIFT, b[1]);
    }
  }
  // A NEW geometry per redraw: swapping a bigger attribute into the same one kept
  // WebGPU's old, smaller vertex buffer bound, and every frame after it was rejected
  // ("vertex range requires a larger buffer", seen live 2026-10-17).
  function setLines(lines, arr) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(arr.length ? arr : [0, 0, 0, 0, 0, 0], 3));
    lines.geometry.dispose();
    lines.geometry = geo;
  }
  function padLoops(out, p, f) {
    pushLoop(out, outlinePoints(p.shape, f, 0));
    if (p.rim > 0.01) pushLoop(out, outlinePoints(p.shape, f, p.rim));
  }

  /** Redraw the outlines when a pad or the ground changed (never otherwise). */
  function redraw(force = false) {
    const key = `${system.version}|${heightVersion()}|${selectedId}|${active}`;
    if (!force && key === drawnKey) return;
    drawnKey = key;
    allLines.visible = selLines.visible = active;
    if (!active) return;
    const all = [], sel = [];
    for (const p of system.pads) padLoops(p.id === selectedId ? sel : all, p, system.footprintOf(p.id));
    setLines(allLines, all);
    setLines(selLines, sel);
  }

  function _syncSelection() {
    const p = active ? selected() : null;
    redraw(true);
    if (!p) { detachGizmo(); return; }
    const f = system.footprintOf(p.id);
    proxy.position.set(f.x, groundAt(f.x, f.z), f.z);
    proxy.rotation.set(0, f.rot, 0);
    proxy.scale.set(f.halfX * 2, 1, (p.shape === "circle" ? f.halfX : f.halfZ) * 2);
    proxy.updateMatrixWorld(true);
  }

  function select(id) {
    selectedId = id !== null && system.get(id) ? id : null;
    _syncSelection();
    const p = selected();
    // An attached pad goes where its prop goes: no gizmo of its own.
    if (p && active && p.attach == null) attachGizmo(p, proxy);
    onChanged?.();
  }

  function placeAt(point) {
    const p = history.record(() => system.add({ ...place, x: point.x, z: point.z }));
    select(p.id);
    return p;
  }

  function showGhost(point) {
    ghostLines.visible = !!point;
    if (!point) return;
    const out = [];
    padLoops(out, { shape: place.shape, rim: place.rim }, { x: point.x, z: point.z, rot: 0, halfX: place.halfX, halfZ: place.halfZ });
    setLines(ghostLines, out);
  }

  return {
    place,
    history,
    proxy,
    get selectedId() { return selectedId; },
    get selected() { return selected(); },
    select,
    deselect: () => select(null),
    /** The height (m) a pad is levelled to now — the panel's start value for "Fixed". */
    currentHeight: (id) => system.levelOf(id),
    /** Set by the panel: rebuild it after an edit that changes which fields show. */
    onPanelRebuild: null,

    setActive(on) {
      active = on;
      if (!on) { ghostLines.visible = false; hoverAt = null; }
      _syncSelection();
      const p = selected();
      if (on && p && p.attach == null) attachGizmo(p, proxy);
    },

    /** Once per frame: outlines follow the ground and the pads. */
    update() {
      if (active) redraw();
    },

    /** Mouse move over the ground (null = off it): the placement outline. */
    hover(point, { shift = false } = {}) {
      hoverAt = point;
      const show = active && point && (shift || (!selected() && !system.pick(point.x, point.z)));
      showGhost(show ? point : null);
    },

    /** A click on the ground. Returns what it did: "place" | "select" | "deselect" | null. */
    click(point, { shift = false } = {}) {
      if (!point) return null;
      if (shift) { placeAt(point); return "place"; }
      const under = system.pick(point.x, point.z);
      if (under && under.id !== selectedId) { select(under.id); return "select"; }
      if (under) return null;
      if (selected()) { select(null); return "deselect"; }
      placeAt(point);
      return "place";
    },

    placeAt,

    /** The gizmo moved the proxy: write it back (turn about Y only; size in X and Z only). */
    gizmoChanged() {
      const p = selected();
      if (!p || p.attach != null) return;
      const yaw = new THREE.Euler().setFromQuaternion(proxy.quaternion, "YXZ").y;
      const hx = Math.max(0.25, Math.abs(proxy.scale.x) / 2);
      const hz = Math.max(0.25, Math.abs(proxy.scale.z) / 2);
      system.edit(p.id, {
        x: proxy.position.x, z: proxy.position.z, rot: yaw,
        halfX: hx, halfZ: p.shape === "circle" ? p.halfZ : hz,
      });
      redraw(true);
    },

    gizmoEnd() {
      _syncSelection();
      if (history.commit()) onChanged?.();
    },

    /** Panel edit of the selected pad. `coalesce` merges a slider drag into one undo step. */
    edit(patch, { coalesce = null } = {}) {
      const p = selected();
      if (!p) return;
      system.edit(p.id, patch);
      _syncSelection();
      if (p.attach == null && active) attachGizmo(p, proxy); else detachGizmo();
      history.commit({ coalesce });
      onChanged?.();
    },

    deleteSelected() {
      if (!selected()) return false;
      history.record(() => system.remove(selectedId));
      select(null);
      return true;
    },

    duplicateSelected() {
      const p = selected();
      if (!p) return null;
      const f = system.footprintOf(p.id);
      // Beside the original along its own width, detached, so the copy is visible at once.
      const along = f.halfX * 2 + p.rim;
      const copy = history.record(() => system.add({
        ...system.snapshot().find((s) => s.id === p.id), id: undefined, attach: null,
        x: f.x + Math.cos(f.rot) * along, z: f.z - Math.sin(f.rot) * along, rot: f.rot, halfX: f.halfX, halfZ: f.halfZ,
      }));
      select(copy.id);
      return copy;
    },

    deleteId(id) {
      if (!system.get(id)) return false;
      history.record(() => system.remove(id));
      if (selectedId === id) select(null);
      else onChanged?.();
      return true;
    },

    /** A pad attached to a prop, recorded as one undo step (Props → "Add pad under it"). */
    addForProp(propId, { margin = 1 } = {}) {
      const p = history.record(() => system.add({ attach: propId, margin, rim: place.rim }));
      return p;
    },

    /** After a project load replaced the pads. */
    reset() {
      selectedId = null;
      history.reset();
      _syncSelection();
      onChanged?.();
    },
  };
}
