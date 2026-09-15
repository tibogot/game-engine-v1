/**
 * Decal mode — the editing half of the decal system (the renderer is
 * v3/render/decals/decalSystem.js and runs in games too; this runs only in the
 * editor).
 *
 * Unity / Unreal workflow:
 *   - click a surface: place a decal there, projected into that surface
 *   - click a painted decal: select it (gizmo: W move, E rotate, R scale)
 *   - Shift+click: place even on top of an existing decal
 *   - click empty ground with one selected: deselect
 *   - Del delete · Ctrl+D duplicate · Esc deselect
 *
 * The selected decal shows its box; the placement box follows the cursor.
 * Every edit is one undo step (snapshot history of the decal list).
 */
import * as THREE from "three";
import { orientDecal } from "../render/decals/decalMath.js";
import { createSnapshotHistory } from "./snapshotHistory.js";

/** Settings for the NEXT decal placed. */
export function createDecalPlaceState() {
  return {
    slot: 0,
    /** "surface": project into the clicked surface · "down": straight down, whatever the slope. */
    align: "surface",
    size: 4,
    depth: 2,
    randomRotation: true,
    rotation: 0,
  };
}

function _boxLines(color, opacity) {
  const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  // Plus the projection axis: top centre → bottom centre.
  const pos = [...edges.getAttribute("position").array, 0, 0.5, 0, 0, -0.5, 0];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false });
  const lines = new THREE.LineSegments(geo, mat);
  lines.matrixAutoUpdate = false;
  lines.renderOrder = 999;
  lines.frustumCulled = false;
  lines.visible = false;
  return lines;
}

/**
 * @param {object} o
 * @param {import("../render/decals/decalSystem.js").DecalSystem} o.system
 * @param {THREE.Scene} o.scene
 * @param {(decal, proxy:THREE.Object3D) => void} o.attachGizmo
 * @param {() => void} o.detachGizmo
 * @param {() => void} [o.onChanged]  selection or data changed (panel refresh)
 */
export function createDecalEditor({ system, scene, attachGizmo, detachGizmo, onChanged }) {
  const place = createDecalPlaceState();
  let selectedId = null;
  let active = false;

  const proxy = new THREE.Object3D();
  proxy.name = "DecalGizmoProxy";
  scene.add(proxy);

  const selBox = _boxLines(0xffa040, 0.95);
  const ghostBox = _boxLines(0x80c8ff, 0.55);
  scene.add(selBox, ghostBox);

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
    const d = active ? selected() : null;
    selBox.visible = !!d;
    if (!d) { detachGizmo(); return; }
    system.matrixOf(d, selBox.matrix);
    selBox.matrixWorldNeedsUpdate = true;
    proxy.position.set(d.px, d.py, d.pz);
    proxy.quaternion.set(d.qx, d.qy, d.qz, d.qw);
    proxy.scale.set(d.sx, d.sy, d.sz);
    proxy.updateMatrixWorld(true);
  }

  function select(id) {
    selectedId = id !== null && system.get(id) ? id : null;
    _syncSelection();
    if (selected() && active) attachGizmo(selected(), proxy);
    onChanged?.();
  }

  /** Orientation for a new decal at a surface hit (random spin only when `rolled`). */
  function _placement(hit, camera, rolled = true) {
    const n = place.align === "down" || !hit.normal ? new THREE.Vector3(0, 1, 0) : hit.normal;
    let yaw = THREE.MathUtils.degToRad(place.rotation);
    if (place.randomRotation) yaw = rolled ? Math.random() * Math.PI * 2 : 0;
    else if (camera) {
      // Texture "up" (local −Z) points away from the camera, like reading it.
      const f = new THREE.Vector3().subVectors(hit.point, camera.position);
      yaw += Math.atan2(-f.x, -f.z);
    }
    return orientDecal(n, yaw);
  }

  function placeAt(hit, camera) {
    const q = _placement(hit, camera);
    const d = history.record(() => system.add({
      slot: Math.min(place.slot, Math.max(0, system.textures.slots.length - 1)),
      px: hit.point.x, py: hit.point.y, pz: hit.point.z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
      sx: place.size, sy: place.depth, sz: place.size,
    }));
    select(d.id);
    return d;
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
      if (!on) ghostBox.visible = false;
      _syncSelection();
      if (on && selected()) attachGizmo(selected(), proxy);
    },

    /** Mouse move over a surface (null = off the world): the placement box. */
    hover(hit, camera, { shift = false } = {}) {
      const show = active && hit && (shift || (!selected() && !system.pick(hit.point)));
      ghostBox.visible = !!show;
      if (!show) return;
      const q = _placement(hit, camera, false);
      ghostBox.matrix.compose(hit.point, q, new THREE.Vector3(place.size, place.depth, place.size));
      ghostBox.matrixWorldNeedsUpdate = true;
    },

    /** A click on a surface. Returns what it did: "place" | "select" | "deselect" | null. */
    click(hit, camera, { shift = false } = {}) {
      if (!hit) return null;
      if (shift) { placeAt(hit, camera); return "place"; }
      const under = system.pick(hit.point);
      if (under && under.id !== selectedId) { select(under.id); return "select"; }
      if (under) return null;
      if (selected()) { select(null); return "deselect"; }
      placeAt(hit, camera);
      return "place";
    },

    placeAt,

    /** The gizmo moved the proxy: write it back to the decal. */
    gizmoChanged() {
      const d = selected();
      if (!d) return;
      d.px = proxy.position.x; d.py = proxy.position.y; d.pz = proxy.position.z;
      d.qx = proxy.quaternion.x; d.qy = proxy.quaternion.y; d.qz = proxy.quaternion.z; d.qw = proxy.quaternion.w;
      d.sx = Math.max(0.05, Math.abs(proxy.scale.x));
      d.sy = Math.max(0.05, Math.abs(proxy.scale.y));
      d.sz = Math.max(0.05, Math.abs(proxy.scale.z));
      system.markDirty();
      system.matrixOf(d, selBox.matrix);
      selBox.matrixWorldNeedsUpdate = true;
    },

    gizmoEnd() {
      _syncSelection();
      if (history.commit()) onChanged?.();
    },

    /** Panel edit of the selected decal. `coalesce` merges a slider drag into one undo step. */
    edit(patch, { coalesce = null } = {}) {
      const d = selected();
      if (!d) return;
      Object.assign(d, patch);
      system.markDirty();
      _syncSelection();
      history.commit({ coalesce });
    },

    /** Something already changed the selected decal in place (a bound widget). */
    edited(coalesce = null) {
      if (!selected()) return;
      system.markDirty();
      _syncSelection();
      history.commit({ coalesce });
    },

    deleteSelected() {
      if (!selected()) return false;
      history.record(() => system.remove(selectedId));
      select(null);
      return true;
    },

    duplicateSelected() {
      const d = selected();
      if (!d) return null;
      // Beside the original along its own width, so the copy is visible at once.
      const along = new THREE.Vector3(d.sx * 0.6, 0, 0).applyQuaternion(new THREE.Quaternion(d.qx, d.qy, d.qz, d.qw));
      const copy = history.record(() => system.duplicate(d.id, along));
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

    /** After a project load replaced the decals. */
    reset() {
      selectedId = null;
      history.reset();
      _syncSelection();
      onChanged?.();
    },
  };
}
