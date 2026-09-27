// UNITS FOR THE ALGERIA GAME — the shared RTS machinery (games/shared-rts:
// nav grid, units, renderer, selection, health bars, rings, sim clock) wired
// to this game's map, buildings and unit list. The UI is this game's own
// (next step); nothing here imports from nam-rts.
import { createNavGrid } from "../shared-rts/navGrid.js";
import { createUnits } from "../shared-rts/units.js";
import { createUnitRenderer } from "../shared-rts/unitRenderer.js";
import { createHealthBarField } from "../shared-rts/healthBar.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { createSelection } from "../shared-rts/selection.js";
import { createSimClock } from "../shared-rts/simClock.js";
import { createControlGroups } from "../shared-rts/controlGroups.js";
import { ALG_UNIT_TYPES, ALG_UNIT_TYPE_KEYS } from "./algUnitTypes.js";
// This game's own UI (copies of nam's on day one, to be redesigned).
import { createHudBar } from "./ui/hudBar.js";
import { createUnitBar } from "./ui/unitBar.js";
import { createCommandCard } from "./ui/commandCard.js";
import { createMinimap } from "./ui/minimap.js";

/**
 * The placed buildings are plain meshes, not engine props, so the nav grid
 * cannot see them by itself: stamp each one's footprint (vehicles excluded —
 * they become units).
 */
function stampShowroom(navGrid, showroom) {
  let n = 0;
  for (const o of Object.values(showroom ?? {})) {
    const ud = o?.isObject3D ? o.geometry?.userData : null;
    if (!ud?.footprint || ud.gear || ud.rotors) continue;
    const f = ud.footprint;
    o.updateMatrixWorld(true);
    const c = o.localToWorld(o.position.clone().set(f.cx, 0, f.cz));
    navGrid.addFootprint(c.x, c.z, f.hx, f.hz, o.rotation.y);
    n++;
  }
  return n;
}

/**
 * @param {object} app  the engine app
 * @param {object} o
 * @param {object} o.showroom   placed pieces (showroom.js), stamped as obstacles
 * @param {{x:number,z:number,yaw:number}} o.muster  where the first squad forms up
 * @param {(sel:object[]) => void} [o.onSelect]
 */
export async function createAlgUnits(app, { showroom, muster, onSelect = () => {} }) {
  const navGrid = createNavGrid({ app });
  app.navGrid = navGrid;
  const stamped = stampShowroom(navGrid, showroom);

  const healthBars = createHealthBarField({ scene: app.scene, groundAt: (x, z) => app.getWorldHeight(x, z) });
  const selectionRings = createSelectionRingField({ app });

  const units = createUnits({ app, navGrid, types: ALG_UNIT_TYPES, typeKeys: ALG_UNIT_TYPE_KEYS, spawn: {}, origin: muster });
  app.units = units;

  // A section of appelés formed up in front of the post's gate (3 x 4).
  const fx = -Math.sin(muster.yaw), fz = -Math.cos(muster.yaw);   // out of the gate
  const rx = Math.cos(muster.yaw), rz = -Math.sin(muster.yaw);
  for (let i = 0; i < 12; i++) {
    const col = (i % 4) - 1.5, row = Math.floor(i / 4);
    const p = navGrid.nearestOpenWorld(muster.x + fx * row * 3.2 + rx * col * 3.2, muster.z + fz * row * 3.2 + rz * col * 3.2, true) ?? { x: muster.x, z: muster.z };
    units.spawn("appele", p.x, p.z);
  }

  const unitRenderer = await createUnitRenderer({
    app, units, healthBars, selectionRings, types: ALG_UNIT_TYPES, typeKeys: ALG_UNIT_TYPE_KEYS, procedural: {},
  });
  // ── The HUD (this game's files, ./ui/) ─────────────────────────────────
  const hud = createHudBar();
  // The boot page's key-hint label sits where the bar goes.
  const hint = document.getElementById("hud");
  if (hint) hint.style.display = "none";
  const mine = (key) => units.list.filter((u) => u.alive && u.team === "player" && u.typeKey === key);
  const unitBar = createUnitBar({
    thumbnails: unitRenderer.thumbnails,
    onPickGroup: (arr) => app.selection?.select(arr),
    onSelectAllType: (key) => app.selection?.select(mine(key)),
    mount: hud.centre,
  });
  const commandCard = createCommandCard({
    thumbnails: unitRenderer.thumbnails,
    onStop: () => { for (const u of app.selection?.selected ?? []) u.stop?.(); },
    onFocus: () => {
      const sel = app.selection?.selected ?? [];
      if (!sel.length) return;
      app.rtsCamera?.focusOn(sel.reduce((s, u) => s + u.position.x, 0) / sel.length, sel.reduce((s, u) => s + u.position.z, 0) / sel.length);
    },
    mount: hud.right,
  });
  let controlGroups = null;   // made after the selection it listens to
  const selection = createSelection({
    app, units, unitRenderer,
    onChange: (sel) => {
      unitBar.render(sel);
      commandCard.render(sel);
      controlGroups?.render();
      onSelect(sel);
    },
  });
  app.selection = selection;
  controlGroups = createControlGroups({ app, selection, mount: hud.root.querySelector(".block-right") });
  // The tactical map from the start: the post has its own radio mast.
  const minimap = createMinimap({ app, units, mount: hud.left, intel: () => true });

  const sim = createSimClock({ hz: 60 });
  app.addPreRenderHook((dt) => {
    sim.advance(dt, (d) => units.update(d));
    healthBars.begin();
    selectionRings.begin();
    unitRenderer.sync(dt, app.camera);
    healthBars.commit();
    selectionRings.commit();
    commandCard.tick();
    unitBar.tick();
    minimap.draw();
  });

  return { navGrid, units, unitRenderer, selection, sim, stamped, hud, unitBar, commandCard, minimap, controlGroups };
}
