// Build placement — GAME UI. The ghost-and-click flow for siting a building.
//
//   select a builder → "Build Helipad" → a translucent ghost follows the cursor,
//   green where the ground is buildable, red where it isn't → left-click to place,
//   right-click / Esc to cancel. The builder then drives to the site and raises it.
//
// This is UX only: it validates the spot (sitePlanner's own check) and, on a valid
// click, hands off to `onCommit`. It never builds anything itself.
import * as THREE from "three";
import { findBuildSite } from "./sitePlanner.js";
import { BUILDING_TYPES } from "./buildings.js";
import { BUILDING_COST } from "./resources.js";

const OK = new THREE.Color(0x3ddc60);
const BAD = new THREE.Color(0xe4483a);

/** A cheap translucent footprint: disc + rim ring, tinted by validity. */
function makeGhost(radius) {
  const g = new THREE.Group();
  const matDisc = new THREE.MeshBasicMaterial({
    color: OK, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const matRing = new THREE.MeshBasicMaterial({
    color: OK, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.2, 40), matDisc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.35, 8, 40).rotateX(Math.PI / 2), matRing);
  g.add(disc, ring);
  g.frustumCulled = false;
  g.userData.mats = [matDisc, matRing];
  return g;
}

export function createBuildPlacement({ app, onCommit = () => {}, canAfford = () => true }) {
  const { scene } = app;
  const dom = app.renderer.domElement;

  let ghost = null;
  let typeKey = null;
  let builders = [];
  let valid = false;
  let site = null; // { x, z, y } when valid

  const state = { get active() { return !!typeKey; } };

  function setTint(good) {
    if (!ghost) return;
    for (const m of ghost.userData.mats) m.color.copy(good ? OK : BAD);
  }

  function moveGhostTo(clientX, clientY) {
    const hit = app.pickWorldAtClient?.(clientX, clientY);
    if (!hit) { valid = false; site = null; if (ghost) ghost.visible = false; return; }
    const p = hit.point;
    const type = BUILDING_TYPES[typeKey];

    // Buildable exactly here? (searchRadius 0 = don't wander — validate THIS spot.)
    site = findBuildSite(app, p.x, p.z, type.radius, { searchRadius: 0 });
    const cost = BUILDING_COST[typeKey] ?? 0;
    valid = !!site && (cost <= 0 || canAfford(cost));

    ghost.visible = true;
    ghost.position.set(p.x, (site ? site.y : p.y) + 0.15, p.z);
    setTint(valid);
  }

  function end() {
    if (ghost) { scene.remove(ghost); ghost = null; }
    typeKey = null; builders = []; valid = false; site = null;
    dom.removeEventListener("pointermove", onMove);
    dom.removeEventListener("pointerdown", onDown, true);
    dom.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey);
  }

  function onMove(e) { if (typeKey) moveGhostTo(e.clientX, e.clientY); }

  function onDown(e) {
    if (!typeKey || e.button !== 0) return;
    // Swallow the left-click so selection.js never sees it.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (valid && site) {
      onCommit(typeKey, site.x, site.z, builders.filter((b) => b.alive));
      end();
    }
    // invalid: ignore, stay in placement
  }

  // Right-click cancels. Selection's move order rides on `contextmenu`, not
  // pointerdown, so we cancel HERE and swallow the event before it reaches it.
  function onContext(e) {
    if (!typeKey) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    end();
  }

  function onKey(e) { if (e.key === "Escape" && typeKey) end(); }

  return {
    state,
    /** Enter placement for `key`, to be built by `selectedBuilders`. */
    begin(key, selectedBuilders) {
      if (!BUILDING_TYPES[key]) return;
      if (typeKey) end();
      typeKey = key;
      builders = selectedBuilders.filter((b) => b?.alive && b.type?.builds?.includes(key));
      if (!builders.length) { typeKey = null; return; } // nobody can build it

      ghost = makeGhost(BUILDING_TYPES[key].radius);
      ghost.visible = false;
      scene.add(ghost);
      dom.addEventListener("pointermove", onMove);
      dom.addEventListener("pointerdown", onDown, true);   // capture: beat selection
      dom.addEventListener("contextmenu", onContext, true); // capture: beat the move order
      window.addEventListener("keydown", onKey);
    },
    cancel() { if (typeKey) end(); },
  };
}
