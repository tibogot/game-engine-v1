// RTS selection & orders — GAME code.
//
//   • Left-click a unit         → select it (replaces current selection)
//   • Shift + left-click        → add/remove that unit from the selection
//   • Left-drag on empty ground → box-select every unit inside the rectangle
//     (hold Shift to add to the current selection)
//   • Double-click a unit, or Ctrl + click → every unit of that TYPE on screen
//     (Shift as well: add them to the selection)
//   • Left-click empty ground   → clear selection
//   • Right-click ground        → move every selected unit there (spread out)
//
// Only active while the camera is in "rts" mode, so it never fights the orbit
// camera's left-drag. Picks units by raycasting the meshes tagged in units.js
// (mesh.userData.unit); box-select projects each unit to screen space.
import * as THREE from "three";
import { RENDER_ORDER } from "./renderOrder.js";

const _pc = new THREE.Vector3(), _pe = new THREE.Vector3();   // screen picks (vehicles)
const DRAG_THRESHOLD = 6; // px before a click becomes a box-drag

// `unitRenderer` owns the unit meshes, so picking goes through it. Unit logic
// (units.js) has no meshes at all. (Note: app.renderer is the WebGPU renderer —
// different thing, hence the explicit name.)
export function createSelection({ app, units, unitRenderer, structuresRenderer = null, buildingRenderer = null, resourceRenderer = null, harvesting = null, onChange = () => {}, onOrder = () => {}, clampOrder = null, squadOf = null, orderMarker = null, attackUnits = false, canTarget = null, adjustSlots = null }) {
  // `attackUnits` (opt-in, alg-rts 2026-10-06): a right-click on an enemy UNIT is an attack order
  // too (not only on a building), and the cursor turns to a red sight over one; `canTarget(u)`:
  // may the player point at him (seen — not in the fog)?
  // `squadOf(unit) → unit[] | null` (opt-in, alg-rts's squads): a click or a
  // box on one man selects his whole squad, and a move order forms each squad
  // round its own spot instead of a grid of loose men.
  // onOrder(kind, units): "attack" | "harvest" | "move" — the radio answers (namSounds.js).
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

  /** With squads: every selected man's squad mates join him. */
  const expandSquads = () => {
    if (!squadOf) return;
    for (const u of [...selected]) for (const m of squadOf(u) ?? []) if (m.alive && !selected.has(m)) setSelected(m, true);
  };
  const notify = () => { expandSquads(); onChange([...selected]); };
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
    // A VEHICLE the ray missed (between a jeep's wheels, a helicopter's thin
    // tail, far out where it is a few pixels): within its outline on screen —
    // its radius projected round its middle (2026-10-02, you: "clicking
    // vehicles sometimes doesn't work").
    {
      let best = null, bd = Infinity;
      for (const u of units.list) {
        if (!u.alive || u.isStructure || u.type?.foot) continue;
        const r = u.radius ?? u.type?.radius ?? 3;
        _pc.set(u.position.x, u.position.y + Math.min(2, r * 0.5), u.position.z).project(camera);
        if (_pc.z > 1) continue;
        const sx = rect.left + (_pc.x * 0.5 + 0.5) * rect.width, sy = rect.top + (-_pc.y * 0.5 + 0.5) * rect.height;
        _pe.set(u.position.x + r, u.position.y + Math.min(2, r * 0.5), u.position.z).project(camera);
        const rpx = Math.max(10, Math.hypot((_pe.x - _pc.x) * 0.5 * rect.width, (_pe.y - _pc.y) * 0.5 * rect.height));
        const d = Math.hypot(sx - clientX, sy - clientY);
        if (d < rpx * 1.1 && d - (u.team === "player" ? 4 : 0) < bd) { bd = d - (u.team === "player" ? 4 : 0); best = u; }
      }
      if (best) return best;
    }
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

  const DOUBLE_CLICK_MS = 350;
  let lastClick = { unit: null, t: 0 };
  /** The player's living units of one type whose position is on screen. */
  function onScreenOfType(typeKey) {
    const out = [];
    const v = new THREE.Vector3();
    for (const u of units.list) {
      if (!u.alive || u.team !== "player" || u.typeKey !== typeKey) continue;
      v.copy(u.position).project(camera);
      if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) out.push(u);
    }
    return out;
  }

  const onPointerDown = (e) => {
    if (e.button !== 0 || !rtsActive()) return;
    if (app.buildPlacement?.state.active) return; // placement owns the cursor
    down = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
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
      // Only the player's LIVING units. Dead units stay in units.list forever
      // (the renderer keeps their corpse on the ground), so without the alive
      // check a drag also grabbed every casualty in the rectangle.
      for (const u of units.list) {
        if (!u.alive || u.team !== "player") continue;
        // His middle, not his feet (a box drawn round a man's body missed him).
        const p = u.position.clone().setY(u.position.y + (u.type?.foot ? 1 : 0)).project(camera);
        if (p.z > 1) continue; // behind the camera
        const sx = rect.left + (p.x * 0.5 + 0.5) * rect.width;
        const sy = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) setSelected(u, true);
      }
    } else {
      // Plain click: select the unit under the cursor, else clear.
      const unit = meshPick(e.clientX, e.clientY);
      const now = performance.now();
      const dbl = unit && lastClick.unit === unit && now - lastClick.t < DOUBLE_CLICK_MS;
      lastClick = { unit, t: now };
      if (unit && !unit.isStructure && (down.ctrl || dbl)) {
        // Every unit of that type the player can SEE (on screen), as in every
        // RTS; the unit bar's double-click takes the whole map.
        if (!down.shift) clear();
        for (const u of onScreenOfType(unit.typeKey)) setSelected(u, true);
      } else if (unit && unit.team !== "player") {
        // An ENEMY under the cursor is not yours to select (you, 2026-10-08: "I could select the
        // ALN" — and, selected, it took your move orders). A plain click there clears, as on the ground.
        if (!down.shift) clear();
      } else if (unit) {
        if (down.shift) {
          // Shift-click toggles the man's whole squad (or the man alone).
          const on = !selected.has(unit);
          for (const m of (squadOf?.(unit) ?? [unit])) setSelected(m, on);
        }
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
  marker.renderOrder = RENDER_ORDER.HUD;
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
  // `orderMarker(x, y, z, units, kind)` (a game's opt-in): its own marker instead of
  // the blue ring (alg-rts: CoH chevrons at each man's spot, by cover).
  const pingMarker = (x, y, z, kind = "move") => {
    if (orderMarker) { orderMarker(x, y, z, [...selected], kind); return; }
    marker.position.set(x, y + 0.25, z);
    marker.visible = true;
    markerT = 0;
    markerLast = performance.now();
    if (!markerRaf) markerRaf = requestAnimationFrame(animMarker);
  };

  /**
   * The resource node under the cursor, if any.
   *
   * Two passes, because a crate pile is full of holes: the crates sit at fixed
   * offsets with gaps between them, so a ray aimed at the middle of a dump can
   * thread straight through and hit nothing. Hitting a crate is the precise
   * answer; landing on the GROUND inside a node's radius means the same thing to
   * the player, so that counts too.
   */
  function pickNode(clientX, clientY) {
    if (!resourceRenderer) return null;
    const rect = dom.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(resourceRenderer.roots, true);
    for (const h of hits) {
      const n = resourceRenderer.nodeFromHit(h);
      if (n?.alive) return n;
    }

    // Missed the crates — did the click land on the ground inside a node's footprint?
    const ground = app.pickWorldAtClient?.(clientX, clientY);
    if (!ground?.point) return null;
    for (const n of resourceRenderer.nodesNear(ground.point.x, ground.point.z)) return n;
    return null;
  }

  /** An enemy UNIT under the cursor (attackUnits only), one the player can see. */
  function pickEnemyUnit(clientX, clientY) {
    if (!attackUnits) return null;
    const u = meshPick(clientX, clientY);
    return u?.alive && !u.isStructure && u.team && u.team !== "player" && (canTarget?.(u) ?? true) ? u : null;
  }
  // THE ATTACK CURSOR (attackUnits): a red sight over an enemy while men are selected. Looked
  // up at most every 90 ms; never over another mode's cursor (a grenade's crosshair).
  const ATTACK_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><g fill="none" stroke="#000" stroke-opacity=".7" stroke-width="4"><circle cx="14" cy="14" r="8"/><path d="M14 1v7M14 20v7M1 14h7M20 14h7"/></g><g fill="none" stroke="#ff4a3a" stroke-width="2"><circle cx="14" cy="14" r="8"/><path d="M14 1v7M14 20v7M1 14h7M20 14h7"/></g></svg>')}") 14 14, crosshair`;
  let hoverT = 0, hoverOn = false;
  const onHover = (e) => {
    if (!attackUnits) return;
    const now = performance.now();
    if (now - hoverT < 90) return;
    hoverT = now;
    const cur = dom.style.cursor;
    if (cur && !hoverOn) return;   // another mode owns it
    const armed = [...selected].some((u) => !u.isStructure && u.team === "player" && u.range > 0);
    const on = armed && !!(pickEnemy(e.clientX, e.clientY) ?? pickEnemyUnit(e.clientX, e.clientY));
    if (on !== hoverOn) { hoverOn = on; dom.style.cursor = on ? ATTACK_CURSOR : ""; }
  };
  dom.addEventListener("pointermove", onHover);

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
    // Orders go to the PLAYER's units only, whatever the selection holds.
    const mine = [...selected].filter((u) => u.team === "player");
    if (!mine.length) return;

    // Right-clicking an enemy is an ATTACK order.
    const enemy = pickEnemy(e.clientX, e.clientY) ?? pickEnemyUnit(e.clientX, e.clientY);
    if (enemy) {
      for (const u of mine) u.attack?.(enemy);
      pingMarker(enemy.position.x, enemy.position.y, enemy.position.z, "attack");
      onOrder("attack", mine);
      return;
    }

    // Right-clicking a resource node sends any selected HARVESTERS to work it.
    // Anything else in the selection falls through to a normal move order, so a
    // mixed selection does the sensible thing with both halves.
    const node = pickNode(e.clientX, e.clientY);
    if (node && harvesting) {
      let assigned = 0;
      for (const u of selected) if (harvesting.assignNode(u, node)) assigned++;
      if (assigned) {
        pingMarker(node.position.x, node.position.y, node.position.z, "harvest");
        if (assigned === selected.size) { onOrder("harvest", [...selected]); return; } // pure harvester selection — done
      }
    }

    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    if (!hit?.point) return;
    orderMove(hit.point.x, hit.point.z, hit.point.y);
  };

  /**
   * WHERE A MOVE TO (px, pz) PUTS EACH SELECTED UNIT — no side effects. orderMove uses it, and so
   * does a game's cursor preview (alg-rts: cover shown at the cursor, 2026-10-07), so what is
   * shown is what is ordered. `adjustSlots(slots, units)` (a game's, opt-in) may move them (onto
   * cover). Squads: `arr` comes back in squad order, one slot per man.
   */
  function formationAt(px, pz) {
    // Spread units around the target so they don't stack on one point. Spacing
    // must clear the biggest unit's separation radius — otherwise their goal
    // points overlap and they shove each other forever instead of settling.
    //
    // Assign the CLOSEST unit to each slot (greedy) so the group doesn't cross
    // over itself on the way, and so two units never chase the same slot.
    const arr = [...selected].filter((u) => !u.isStructure && u.team === "player"); // buildings don't move; never an enemy
    if (!arr.length) return { arr, slots: [] };
    const maxR = Math.max(...arr.map((u) => u.radius ?? 3));
    const spacing = Math.max(6, maxR * 2.6);
    const cols = Math.ceil(Math.sqrt(arr.length));

    let slots = arr.map((_, i) => {
      const gx = (i % cols) - (cols - 1) / 2;
      const gz = Math.floor(i / cols) - (cols - 1) / 2;
      return { x: px + gx * spacing, z: pz + gz * spacing };
    });
    // SQUADS (opt-in): each squad (or lone unit) gets a spot on a coarse grid,
    // its men a loose cluster round it — a squad stays a squad on arrival.
    if (squadOf) {
      const groups = [];
      const seen = new Set();
      for (const u of arr) {
        if (seen.has(u)) continue;
        const mates = (squadOf(u) ?? [u]).filter((m) => arr.includes(m));
        if (!mates.includes(u)) mates.push(u);
        for (const m of mates) seen.add(m);
        groups.push(mates);
      }
      const gCols = Math.ceil(Math.sqrt(groups.length));
      const gSpace = Math.max(16, maxR * 4);
      const order = [];
      slots = [];
      groups.forEach((g, gi) => {
        const cx = px + ((gi % gCols) - (gCols - 1) / 2) * gSpace;
        const cz = pz + (Math.floor(gi / gCols) - (Math.ceil(groups.length / gCols) - 1) / 2) * gSpace;
        g.forEach((m, k) => {
          // A loose ring round the spot (the first man at its middle).
          const ring = k === 0 ? 0 : 2.6 + (k > 6 ? 2.6 : 0), a = k * 2.39996;
          slots.push({ x: cx + Math.cos(a) * ring, z: cz + Math.sin(a) * ring });
          order.push(m);
        });
      });
      arr.length = 0;
      arr.push(...order);
    }
    if (adjustSlots) slots = adjustSlots(slots, arr) ?? slots;
    return { arr, slots };
  }

  /**
   * MOVE the selection to world (x, z): a formation round the point, rally
   * points for selected buildings, shared path searches. The ground's
   * right-click and the minimap's (a game's) both come here. `y`: the marker's
   * height (the ground's, when not given).
   */
  function orderMove(x, z, y) {
    if (!selected.size) return;
    // A game's playable area: an order outside it goes to the nearest point
    // inside (alg-rts's box; without it the path had no route and men held).
    if (clampOrder) {
      const c = clampOrder(x, z);
      if (c.x !== x || c.z !== z) { x = c.x; z = c.z; y = undefined; }
    }
    y ??= app.getWorldHeight?.(x, z) ?? 0;
    const hit = { point: { x, y, z } };
    pingMarker(x, y, z);
    onOrder("move", [...selected]);

    // A selected building can't move — right-click sets its RALLY POINT instead.
    for (const s of selected) {
      if (s.isStructure && s.rally) { s.rally.x = hit.point.x; s.rally.z = hit.point.z; }
    }
    const { arr, slots } = formationAt(hit.point.x, hit.point.z);
    if (!arr.length) return;

    // ONE path search per cluster of units, not one per unit: every ground
    // unit within 15 m of a unit that already searched takes a copy of that
    // path, ending on its own slot. A search across the map is several ms
    // (MEASURED up to 5 ms after the navGrid rewrite, 31 before it), so a
    // twenty-unit order was a visible hitch. A slot on blocked ground (a
    // click at the water's edge) searches its own, as before.
    const nav = app.navGrid;
    const shared = [];
    const pathFor = (u, slot) => {
      // Infantry and vehicles never share a path: a footbridge is open to one only.
      const foot = !!u.type?.foot;
      if (u.isAir || !nav?.findPath || nav.isBlockedAtWorld(slot.x, slot.z, foot)) return null;
      let c = shared.find((s) => s.foot === foot && Math.hypot(s.x - u.position.x, s.z - u.position.z) < 15);
      if (!c) {
        c = { x: u.position.x, z: u.position.z, foot, path: nav.findPath(u.position.x, u.position.z, hit.point.x, hit.point.z, { foot }) };
        shared.push(c);
      }
      return c.path?.length ? [...c.path.slice(0, -1), { x: slot.x, z: slot.z }] : null;
    };

    // Squads: each man to his own squad's spot (in the order built above).
    if (squadOf) {
      arr.forEach((u, i) => u.moveOrder(slots[i].x, slots[i].z, pathFor(u, slots[i])));
      return;
    }
    const pool = [...arr];
    for (const slot of slots) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const d = (pool[i].position.x - slot.x) ** 2 + (pool[i].position.z - slot.z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      // moveOrder (not orderTo) — a move command cancels any attack order.
      const u = pool.splice(best, 1)[0];
      u.moveOrder(slot.x, slot.z, pathFor(u, slot));
    }
  }

  dom.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  dom.addEventListener("contextmenu", onContextMenu);

  return {
    get selected() { return [...selected]; },
    clear,
    orderMove,
    /** Where a move to (x, z) would put the selection, without ordering it (a cursor preview). */
    previewMove(x, z) {
      if (clampOrder) ({ x, z } = clampOrder(x, z));
      return formationAt(x, z);
    },
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
      for (const u of arr) if (u.team === "player") setSelected(u, true);
      notify();
    },
    dispose() {
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("contextmenu", onContextMenu);
      dom.removeEventListener("pointermove", onHover);
      boxEl.remove();
      if (markerRaf) cancelAnimationFrame(markerRaf);
      app.scene.remove(marker);
    },
  };
}
