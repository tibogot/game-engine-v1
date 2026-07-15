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

// `unitRenderer` owns the unit meshes, so picking goes through it. Unit logic
// (units.js) has no meshes at all. (Note: app.renderer is the WebGPU renderer —
// different thing, hence the explicit name.)
export function createSelection({ app, units, unitRenderer, structuresRenderer = null, buildingRenderer = null, onChange = () => {} }) {
  // Rigid unit types render as shared InstancedMeshes, so a hit identifies its
  // unit by instanceId, not by the mesh — unitRenderer owns that resolution.
  // Crowd soldiers have no mesh AT ALL (they live in a compute buffer), so they
  // are picked by screen proximity instead.
  const { roots, unitFromHit, pickCrowdUnit } = unitRenderer;
  const { renderer, camera } = app;
  const dom = renderer.domElement;
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const selected = new Set();

  const rtsActive = () => !app.rtsCamera || app.rtsCamera.getMode() === "rts";

  const notify = () => onChange([...selected]);
  const setSelected = (unit, on) => {
    if (on) selected.add(unit); else selected.delete(unit);
    unit.setSelected(on);
  };
  const clear = () => { for (const u of selected) u.setSelected(false); selected.clear(); };

  // ── Box-select overlay ──────────────────────────────────────────────────────
  const boxEl = document.createElement("div");
  boxEl.style.cssText =
    "position:fixed;border:1px solid #6ab0ff;background:rgba(106,176,255,0.12);pointer-events:none;z-index:60;display:none";
  document.body.appendChild(boxEl);

  let down = null;   // { x, y, shift } while the left button is held
  let dragging = false;

  const meshPick = (clientX, clientY) => {
    const rect = dom.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(roots, true);
    for (const h of hits) {
      const u = unitFromHit(h);
      if (u?.alive) return u;
    }

    // Nothing with a mesh — try the crowd (soldiers), which is picked in 2D.
    const soldier = pickCrowdUnit?.(clientX, clientY, camera, rect);
    if (soldier?.alive) return soldier;
    // Nothing under the cursor — try our own buildings (the base is commandable).
    // Structures are instanced per kind now, so a hit names its structure by
    // instanceId, exactly like the units.
    if (structuresRenderer) {
      const sHits = raycaster.intersectObjects(structuresRenderer.roots, true);
      for (const h of sHits) {
        const s = structuresRenderer.structureFromHit(h);
        if (s?.alive && s.team === "player") return s;
      }
    }
    // Player-built buildings (helipad) have their own renderer/pick.
    if (buildingRenderer) {
      const bHits = raycaster.intersectObjects(buildingRenderer.roots, true);
      for (const h of bHits) {
        const b = buildingRenderer.buildingFromHit(h);
        if (b?.alive && b.team === "player") return b;
      }
    }
    return null;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 || !rtsActive()) return;
    if (app.buildPlacement?.state.active) return; // placement owns the cursor
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
    notify();
  };

  // ── Move-order marker: a quick expanding ring where you right-click ─────────
  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 1.0, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x6ab0ff, transparent: true, depthTest: false, depthWrite: false, fog: false }),
  );
  marker.renderOrder = 1000;
  marker.visible = false;
  app.scene.add(marker);
  let markerT = 0, markerRaf = null, markerLast = 0;
  const MARKER_DUR = 0.55;
  const animMarker = () => {
    const now = performance.now();
    markerT += (now - markerLast) / 1000;
    markerLast = now;
    if (markerT >= MARKER_DUR) { marker.visible = false; markerRaf = null; return; }
    const p = markerT / MARKER_DUR;
    const s = 1 + p * 3;
    marker.scale.set(s, 1, s);
    marker.material.opacity = 1 - p;
    markerRaf = requestAnimationFrame(animMarker);
  };
  const pingMarker = (x, y, z) => {
    marker.position.set(x, y + 0.25, z);
    marker.visible = true;
    markerT = 0;
    markerLast = performance.now();
    if (!markerRaf) markerRaf = requestAnimationFrame(animMarker);
  };

  /** Raycast the enemy structures under the cursor, if any. */
  function pickEnemy(clientX, clientY) {
    if (!structuresRenderer) return null;
    const rect = dom.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(structuresRenderer.roots, true);
    for (const h of hits) {
      const s = structuresRenderer.structureFromHit(h);
      if (s?.alive && s.team === "enemy") return s;
    }
    return null;
  }

  // ── Right-click → attack an enemy, else move ────────────────────────────────
  const onContextMenu = (e) => {
    // Right-click works in BOTH camera modes — it never fights orbit's
    // left-drag. (Left-click/box-select stays RTS-only to avoid that clash.)
    e.preventDefault();
    if (!selected.size) return;

    // Right-clicking an enemy is an ATTACK order.
    const enemy = pickEnemy(e.clientX, e.clientY);
    if (enemy) {
      for (const u of selected) u.attack?.(enemy);
      pingMarker(enemy.position.x, enemy.position.y, enemy.position.z);
      return;
    }

    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    if (!hit?.point) return;
    pingMarker(hit.point.x, hit.point.y, hit.point.z);

    // A selected building can't move — right-click sets its RALLY POINT instead.
    for (const s of selected) {
      if (s.isStructure && s.rally) { s.rally.x = hit.point.x; s.rally.z = hit.point.z; }
    }
    // Spread units around the target so they don't stack on one point. Spacing
    // must clear the biggest unit's separation radius — otherwise their goal
    // points overlap and they shove each other forever instead of settling.
    //
    // Assign the CLOSEST unit to each slot (greedy) so the group doesn't cross
    // over itself on the way, and so two units never chase the same slot.
    const arr = [...selected].filter((u) => !u.isStructure); // buildings don't move
    if (!arr.length) return;
    const maxR = Math.max(...arr.map((u) => u.radius ?? 3));
    const spacing = Math.max(6, maxR * 2.6);
    const cols = Math.ceil(Math.sqrt(arr.length));

    const slots = arr.map((_, i) => {
      const gx = (i % cols) - (cols - 1) / 2;
      const gz = Math.floor(i / cols) - (cols - 1) / 2;
      return { x: hit.point.x + gx * spacing, z: hit.point.z + gz * spacing };
    });

    const pool = [...arr];
    for (const slot of slots) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = (pool[i].position.x - slot.x) ** 2 + (pool[i].position.z - slot.z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      // moveOrder (not orderTo) — a move command cancels any attack order.
      pool.splice(best, 1)[0].moveOrder(slot.x, slot.z);
    }
  };

  dom.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  dom.addEventListener("contextmenu", onContextMenu);

  return {
    get selected() { return [...selected]; },
    clear,
    /** Drop a unit from the selection when it dies. */
    remove(unit) {
      if (!selected.has(unit)) return;
      selected.delete(unit);
      unit.setSelected(false);
      notify();
    },
    /** Replace the selection with the given units (used by the unit bar). */
    select(arr) {
      clear();
      for (const u of arr) setSelected(u, true);
      notify();
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("contextmenu", onContextMenu);
      boxEl.remove();
      if (markerRaf) cancelAnimationFrame(markerRaf);
      app.scene.remove(marker);
    },
  };
}
