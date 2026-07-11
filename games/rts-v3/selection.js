// RTS selection & orders — GAME code.
//
//   • Left-click a unit         → select it (replaces current selection)
//   • Shift + left-click        → add/remove that unit from the selection
//   • Left-drag on empty ground → box-select every unit inside the rectangle
//     (hold Shift to add to the current selection)
//   • Left-click empty ground   → clear selection
//   • Right-click ground        → move every selected unit there (spread out)
//
// Only active while the camera is in "rts" mode, so it never fights the orbit
// camera's left-drag. Picks units by raycasting the meshes tagged in units.js
// (mesh.userData.unit); box-select projects each unit to screen space.
import * as THREE from "three";

const DRAG_THRESHOLD = 6; // px before a click becomes a box-drag

export function createSelection({ app, units }) {
  const { renderer, camera } = app;
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const selected = new Set();

  const rtsActive = () => !app.rtsCamera || app.rtsCamera.getMode() === "rts";

  const setSelected = (unit, on) => {
    if (on) selected.add(unit); else selected.delete(unit);
    unit.setSelected(on);
  };
  const clear = () => { for (const u of selected) u.setSelected(false); selected.clear(); };

  // ── Box-select overlay ──────────────────────────────────────────────────────
  const boxEl = document.createElement("div");
  boxEl.style.cssText =
    "position:fixed;border:1px solid #37e06b;background:rgba(55,224,107,0.12);pointer-events:none;z-index:60;display:none";
  document.body.appendChild(boxEl);

  let down = null;   // { x, y, shift } while the left button is held
  let dragging = false;

  const meshPick = (clientX, clientY) => {
    const rect = dom.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const meshes = units.list.map((u) => u.root);
    const hits = raycaster.intersectObjects(meshes, true);
    for (const h of hits) {
      let o = h.object;
      while (o && !o.userData.unit) o = o.parent;
      if (o?.userData.unit) return o.userData.unit;
    }
    return null;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || !rtsActive()) return;
    down = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    dragging = false;
  };

  const onPointerMove = (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!dragging && Math.hypot(dx, dy) > DRAG_THRESHOLD) dragging = true;
    if (dragging) {
      const x = Math.min(e.clientX, down.x), y = Math.min(e.clientY, down.y);
      boxEl.style.display = "block";
      boxEl.style.left = `${x}px`;
      boxEl.style.top = `${y}px`;
      boxEl.style.width = `${Math.abs(dx)}px`;
      boxEl.style.height = `${Math.abs(dy)}px`;
    }
  };

  const onPointerUp = (e) => {
    if (e.button !== 0 || !down) return;
    boxEl.style.display = "none";

    if (dragging) {
      // Box-select: every unit whose screen point is inside the rectangle.
      const minX = Math.min(e.clientX, down.x), maxX = Math.max(e.clientX, down.x);
      const minY = Math.min(e.clientY, down.y), maxY = Math.max(e.clientY, down.y);
      const rect = dom.getBoundingClientRect();
      if (!down.shift) clear();
      for (const u of units.list) {
        const p = u.position.clone().project(camera);
        const sx = rect.left + (p.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) setSelected(u, true);
      }
    } else {
      // Plain click: select the unit under the cursor, else clear.
      const unit = meshPick(e.clientX, e.clientY);
      if (unit) {
        if (down.shift) setSelected(unit, !selected.has(unit));
        else { clear(); setSelected(unit, true); }
      } else if (!down.shift) {
        clear();
      }
    }
    down = null;
    dragging = false;
  };

  // ── Right-click → move order for the whole selection ────────────────────────
  const onContextMenu = (e) => {
    // Right-click move works in BOTH camera modes — it never fights orbit's
    // left-drag. (Left-click/box-select stays RTS-only to avoid that clash.)
    e.preventDefault();
    if (!selected.size) return;
    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    if (!hit?.point) return;
    // Spread units around the target so they don't stack on one point.
    const arr = [...selected];
    const spacing = 6;
    const cols = Math.ceil(Math.sqrt(arr.length));
    arr.forEach((u, i) => {
      const gx = (i % cols) - (cols - 1) / 2;
      const gz = Math.floor(i / cols) - (cols - 1) / 2;
      u.orderTo(hit.point.x + gx * spacing, hit.point.z + gz * spacing);
    });
  };

  dom.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  dom.addEventListener("contextmenu", onContextMenu);

  return {
    get selected() { return [...selected]; },
    clear,
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("contextmenu", onContextMenu);
      boxEl.remove();
    },
  };
}
