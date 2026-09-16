/**
 * Waterfall mode — the editing half of the waterfall system (the renderer is
 * v3/render/waterfall/waterfallSystem.js and runs in games too; this runs only
 * in the editor).
 *
 * Workflow (Unity / Unreal style):
 *   - hover: the fall that WOULD be placed is solved live and drawn as a
 *     preview (its edges, centre line and landing), facing over the steepest
 *     drop under the cursor
 *   - click the ground: place it · click a fall: select it
 *   - gizmo W move, E rotate (the lip turns; the fall re-solves as you drag)
 *   - Del delete · Ctrl+D duplicate · Esc deselect
 *
 * Every edit is one undo step (snapshot history of the fall list; the shared
 * look is a panel setting, not part of undo — same as lakes and rivers).
 */
import * as THREE from "three";
import { createSnapshotHistory } from "./snapshotHistory.js";
import { downhillYaw, FALL_DEFAULTS } from "../render/waterfall/waterfallPath.js";
import { WATERFALL_PRESETS } from "../app/state/waterfallState.js";

/** Settings for the NEXT fall placed. */
export function createWaterfallPlaceState() {
  const p = WATERFALL_PRESETS.curtain;
  return {
    preset: "curtain",
    width: p.width,
    speed: p.speed,
    depth: p.depth,
    spread: p.spread,
    foam: p.foam,
    friction: FALL_DEFAULTS.friction,
    crest: p.crest ?? FALL_DEFAULTS.crest,
    /** Face the water over the steepest drop under the cursor (else away from the camera). */
    autoDirection: true,
    /** A click at a river's end attaches the fall to that river. */
    attachToRivers: true,
  };
}

/** The preset's shape values, filled with defaults for the keys it leaves out. */
export function presetShape(name) {
  const p = WATERFALL_PRESETS[name];
  if (!p) return null;
  const { label: _, ...shape } = p;
  return { friction: FALL_DEFAULTS.friction, crest: FALL_DEFAULTS.crest, ...shape };
}

function _lines(color, opacity) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 999;
  lines.frustumCulled = false;
  lines.visible = false;
  return lines;
}

/** Outline of a solved fall as line segments: both edges, the centre line, the lip and a landing cross. */
function _outline(s) {
  const out = [];
  const P = (j, i) => {
    const v = (j * s.rows + i) * 3;
    return [s.position[v], s.position[v + 1], s.position[v + 2]];
  };
  const mid = Math.floor(s.cols / 2);
  for (const j of [0, mid, s.cols - 1]) {
    for (let i = 0; i < s.rows - 1; i++) out.push(...P(j, i), ...P(j, i + 1));
  }
  for (let j = 0; j < s.cols - 1; j++) out.push(...P(j, 0), ...P(j + 1, 0));
  // Direction arrow at the lip.
  const [lx, ly, lz] = P(mid, 0);
  const ax = s.impact.dirX, az = s.impact.dirZ;
  const tip = [lx + ax * 2.5, ly, lz + az * 2.5];
  out.push(lx, ly, lz, ...tip);
  out.push(...tip, tip[0] - ax * 0.8 - az * 0.6, ly, tip[2] - az * 0.8 + ax * 0.6);
  out.push(...tip, tip[0] - ax * 0.8 + az * 0.6, ly, tip[2] - az * 0.8 - ax * 0.6);
  // Landing cross, sized to the landing width.
  const r = Math.max(1, s.impact.width * 0.5);
  const { x, y, z } = s.impact;
  out.push(x - r, y + 0.05, z, x + r, y + 0.05, z, x, y + 0.05, z - r, x, y + 0.05, z + r);
  return new Float32Array(out);
}

function _setLines(lines, arr) {
  lines.geometry.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  lines.geometry.computeBoundingSphere();
}

/**
 * @param {object} o
 * @param {import("../render/waterfall/waterfallSystem.js").WaterfallSystem} o.system
 * @param {THREE.Scene} o.scene
 * @param {(fall, proxy:THREE.Object3D) => void} o.attachGizmo
 * @param {() => void} o.detachGizmo
 * @param {() => void} [o.onChanged]  selection or data changed (panel refresh)
 */
export function createWaterfallEditor({ system, scene, attachGizmo, detachGizmo, onChanged }) {
  const place = createWaterfallPlaceState();
  let selectedId = null;
  let active = false;
  let _selSolved = null;
  let _ghostKey = "";

  const proxy = new THREE.Object3D();
  proxy.name = "WaterfallGizmoProxy";
  scene.add(proxy);

  const selLines = _lines(0xffa040, 0.95);
  const ghostLines = _lines(0x80c8ff, 0.7);
  scene.add(selLines, ghostLines);

  const history = createSnapshotHistory({
    capture: () => system.snapshot(),
    restore: (snap) => {
      system.restore(snap);
      if (selectedId !== null && !system.get(selectedId)) selectedId = null;
      _syncSelection();
      onChanged?.();
    },
  });

  const selected = () => (selectedId === null ? null : system.get(selectedId));

  function _syncSelection() {
    const f = active ? selected() : null;
    selLines.visible = !!f;
    _selSolved = null;
    if (!f) { detachGizmo(); return; }
    // An attached fall's lip belongs to the river: nothing to drag.
    if (f.river != null) { detachGizmo(); return; }
    proxy.position.set(f.px, f.py, f.pz);
    proxy.rotation.set(0, f.yaw, 0);
    proxy.scale.set(1, 1, 1);
    proxy.updateMatrixWorld(true);
  }

  function select(id) {
    selectedId = id !== null && system.get(id) ? id : null;
    _syncSelection();
    if (selected() && active && selected().river == null) attachGizmo(selected(), proxy);
    onChanged?.();
  }

  /** Where and which way a fall placed at this surface hit would go. */
  function _placement(hit, camera) {
    let yaw = null;
    if (place.autoDirection) {
      const yFrom = hit.point.y + 50;
      yaw = downhillYaw(hit.point.x, hit.point.z, (x, z) => system.sampleGround(x, yFrom, z)?.y ?? hit.point.y);
    }
    if (yaw === null && camera) {
      // Away from the camera: you look at the fall from the front.
      yaw = Math.atan2(hit.point.x - camera.position.x, hit.point.z - camera.position.z);
    }
    return {
      px: hit.point.x, py: hit.point.y + 0.15, pz: hit.point.z, yaw: yaw ?? 0,
      width: place.width, speed: place.speed, depth: place.depth,
      spread: place.spread, foam: place.foam, friction: place.friction, crest: place.crest,
    };
  }

  function placeAt(hit, camera) {
    const params = _placement(hit, camera);
    // Clicked at a river's end: the fall takes that river's water, and the river
    // stops at the lip. This is how a river goes over a cliff.
    const mouth = place.attachToRivers ? system.nearestMouth?.(hit.point.x, hit.point.z) : null;
    const f = history.record(() => {
      const added = system.add(params);
      if (mouth) system.attach(added.id, mouth.id);
      return added;
    });
    select(f.id);
    return f;
  }

  return {
    place,
    history,
    proxy,
    get selectedId() { return selectedId; },
    get selected() { return selected(); },
    select,
    deselect: () => select(null),

    setActive(on) {
      active = on;
      if (!on) ghostLines.visible = false;
      _syncSelection();
      if (on && selected()) attachGizmo(selected(), proxy);
    },

    /** Mouse move over a surface (null = off the world): the live placement preview. */
    hover(hit, camera, { overFall = false } = {}) {
      const show = active && hit && !selected() && !overFall;
      if (!show) { ghostLines.visible = false; _ghostKey = ""; return; }
      const p = _placement(hit, camera);
      const mouth = place.attachToRivers ? system.nearestMouth?.(hit.point.x, hit.point.z) : null;
      if (mouth) Object.assign(p, { px: mouth.x, py: mouth.y, pz: mouth.z, yaw: mouth.yaw, width: mouth.width, speed: mouth.speed });
      const key = `${p.px.toFixed(1)},${p.pz.toFixed(1)},${p.yaw.toFixed(2)},${p.width},${p.speed},${p.depth},${p.spread},${p.friction}`;
      if (key !== _ghostKey) {
        _ghostKey = key;
        _setLines(ghostLines, _outline(system.preview(p)));
      }
      ghostLines.visible = true;
    },

    /**
     * A click. `hit` is the surface under the cursor (may be null), `raycaster`
     * is set up from the cursor. Returns "place" | "select" | "deselect" | null.
     */
    click(hit, raycaster, camera) {
      const under = raycaster ? system.raycast(raycaster) : null;
      if (under && (!hit || under.distance <= hit.distance + 0.5)) {
        if (under.fall.id !== selectedId) { select(under.fall.id); return "select"; }
        return null;
      }
      if (!hit) return null;
      if (selected()) { select(null); return "deselect"; }
      placeAt(hit, camera);
      return "place";
    },

    placeAt,

    /** Per frame: keep the selection outline on the (re-)solved fall. */
    frame() {
      const f = active ? selected() : null;
      if (!f) return;
      const s = system.solved(f.id);
      if (s && s !== _selSolved) {
        _selSolved = s;
        _setLines(selLines, _outline(s));
      }
      selLines.visible = true;
    },

    /** The gizmo moved the proxy: write it back to the fall (it re-solves). */
    gizmoChanged() {
      const f = selected();
      if (!f) return;
      f.px = proxy.position.x; f.py = proxy.position.y; f.pz = proxy.position.z;
      // Only the heading matters; drop any tilt the rotate gizmo put in.
      const e = new THREE.Euler().setFromQuaternion(proxy.quaternion, "YXZ");
      f.yaw = e.y;
      system.markDirty(f.id);
    },

    gizmoEnd() {
      _syncSelection();
      if (history.commit()) onChanged?.();
    },

    /** Attach the selected fall to a river (null detaches). One undo step. */
    attachSelected(riverId) {
      const f = selected();
      if (!f) return false;
      history.record(() => system.attach(f.id, riverId));
      _syncSelection();
      if (f.river == null && active) attachGizmo(f, proxy);
      onChanged?.();
      return true;
    },

    /** Panel edit of the selected fall. `coalesce` merges a slider drag into one undo step. */
    edit(patch, { coalesce = null } = {}) {
      const f = selected();
      if (!f) return;
      Object.assign(f, patch);
      system.markDirty(f.id);
      _syncSelection();
      history.commit({ coalesce });
    },

    /** Something already changed the selected fall in place (a bound widget). */
    edited(coalesce = null) {
      const f = selected();
      if (!f) return;
      system.markDirty(f.id);
      _syncSelection();
      history.commit({ coalesce });
    },

    /** Apply a shape preset to the next placement, and to the selected fall if any. */
    applyPreset(name) {
      const shape = presetShape(name);
      if (!shape) return;
      place.preset = name;
      Object.assign(place, shape);
      if (selected()) this.edit(shape);
      else onChanged?.();
    },

    deleteSelected() {
      if (!selected()) return false;
      history.record(() => system.remove(selectedId));
      select(null);
      return true;
    },

    duplicateSelected() {
      const f = selected();
      if (!f) return null;
      // Beside the original along its lip, so the copy is visible at once.
      const k = f.width * 1.2;
      const copy = history.record(() => system.duplicate(f.id, { x: -Math.cos(f.yaw) * k, y: 0, z: Math.sin(f.yaw) * k }));
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

    /** After a project load replaced the falls. */
    reset() {
      selectedId = null;
      history.reset();
      _syncSelection();
      onChanged?.();
    },
  };
}
