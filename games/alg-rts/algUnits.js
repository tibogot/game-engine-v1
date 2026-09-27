// UNITS FOR THE ALGERIA GAME — the shared RTS machinery (games/shared-rts:
// nav grid, units, renderer, selection, health bars, rings, sim clock) wired
// to this game's map, buildings and unit list. The UI is this game's own
// (next step); nothing here imports from nam-rts.
import { createNavGrid } from "../shared-rts/navGrid.js";
import { createUnits } from "../shared-rts/units.js";
import { createUnitRenderer } from "../shared-rts/unitRenderer.js";
import { createHealthBarField } from "../shared-rts/healthBar.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { createSelectionFrameField } from "../shared-rts/selectionFrameField.js";
import { createSelection } from "../shared-rts/selection.js";
import { createSimClock } from "../shared-rts/simClock.js";
import { createControlGroups } from "../shared-rts/controlGroups.js";
import { ALG_UNIT_TYPES, ALG_UNIT_TYPE_KEYS } from "./algUnitTypes.js";
import { FR_PAINT_TINT, buildAMX13, buildAlouette, buildEBR, buildGMC, buildHalfTrack, buildWillys } from "../../v3/render/objects/rtsVehiclesFr.js";
import { createAlgProducer, createStructuresRenderer } from "./algProducer.js";
import { bakeStructureThumbnails } from "./structureThumbnails.js";
import { VIEW_YAW } from "./layout.js";
// This game's own UI (copies of nam's on day one, to be redesigned).
import { createHudBar } from "./ui/hudBar.js";
import { createUnitBar } from "./ui/unitBar.js";
import { createCommandCard } from "./ui/commandCard.js";
import { createMinimap } from "./ui/minimap.js";

/**
 * WHAT EACH BUILDING PRODUCES, seconds per unit (no costs yet: this game's
 * economy comes with its rules). The command card lists them in this order.
 */
const PRODUCTION = {
  post: { appele: 6 },
  motorPool: { willys: 10, gmc: 12, halftrack: 16, ebr: 20, amx13: 24 },
};

/** The French vehicles built in code, by a unit type's `procedural` key. */
const FR_VEHICLES = {
  willys: () => buildWillys(), gmc: () => buildGMC(), halftrack: () => buildHalfTrack(),
  amx13: () => buildAMX13(), ebr: () => buildEBR(), alouette: () => buildAlouette(),
};

/**
 * The showroom's parked vehicles become UNITS where they stood: the static
 * piece leaves the scene (and the showroom list) and a unit of the same key
 * spawns on its spot, facing its way (a vehicle's front is +Z).
 */
function takeOverVehicles(app, units, showroom) {
  let n = 0;
  for (const key of Object.keys(ALG_UNIT_TYPES)) {
    const o = ALG_UNIT_TYPES[key].procedural && showroom?.[key];
    if (!o?.isObject3D) continue;
    const u = units.spawn(key, o.position.x, o.position.z);
    if (!u) continue;
    u.faceToward(u.position.x + Math.sin(o.rotation.y), u.position.z + Math.cos(o.rotation.y));
    o.removeFromParent();
    delete showroom[key];
    n++;
  }
  return n;
}

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
  // Square buildings get corner brackets round their footprint, as in nam;
  // round ones (and units) the rings.
  const selectionFrames = createSelectionFrameField({ app });

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
    app, units, healthBars, selectionRings, types: ALG_UNIT_TYPES, typeKeys: ALG_UNIT_TYPE_KEYS,
    procedural: FR_VEHICLES, paint: FR_PAINT_TINT,
  });
  // After the renderer, which builds a view for each unit spawned from now on.
  const vehicles = takeOverVehicles(app, units, showroom);
  // The buildings' portraits, into the same map as the units' (the unit bar
  // and the command card look them up by thumbKeyOf: "struct:post", …).
  if (unitRenderer.thumbnails) {
    await bakeStructureThumbnails(app.renderer, unitRenderer.thumbnails).catch((e) => console.warn("[thumbs] structures:", e));
  }
  // The production buildings (algProducer.js): selectable, they produce, and
  // their gate or doors swing open for each unit that comes out.
  const producers = [];
  const S = 1.3;
  if (showroom?.frenchPost) {
    const g = showroom.frenchPost.geometry.userData.gate;
    producers.push(createAlgProducer({
      mesh: showroom.frenchPost, units, typeKey: "post", name: "Poste de Tighanimine", maxHp: 2000,
      builds: PRODUCTION.post,
      // In the courtyard behind the gate; out through the arch; the muster.
      inside: [0, g.z + 4.5 * S], outside: [0, g.z - 3.2 * S], rally: muster,
    }));
  }
  if (showroom?.motorPool) {
    const m = showroom.motorPool, g = m.geometry.userData.gate;
    // In the garage bay; out past the open leaves; then a vehicle's length
    // further on, on open ground (the park in front of the shed).
    const out = [g.x, g.z - 9], park = [g.x, g.z - 22];
    const c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
    const rw = { x: m.position.x + park[0] * c + park[1] * s, z: m.position.z - park[0] * s + park[1] * c };
    producers.push(createAlgProducer({
      mesh: m, units, typeKey: "motorPool", name: "Parc auto", maxHp: 1400,
      builds: PRODUCTION.motorPool,
      inside: [g.x, 0], outside: out,
      rally: navGrid.nearestOpenWorld(rw.x, rw.z, false) ?? rw,
    }));
  }
  app.algProducers = producers;

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
    // What a selected structure produces (PRODUCTION), labelled by unit name.
    productionFor: (s) => Object.keys(PRODUCTION[s.typeKey] ?? {}).map((key) => ({ key, label: ALG_UNIT_TYPES[key].buildLabel ?? ALG_UNIT_TYPES[key].name })),
    onBuild: (s, key) => s.enqueue(key),
    mount: hud.right,
  });
  let controlGroups = null;   // made after the selection it listens to
  const selection = createSelection({
    app, units, unitRenderer, structuresRenderer: producers.length ? createStructuresRenderer(producers) : null,
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
  const minimap = createMinimap({ app, units, mount: hud.left, intel: () => true, upYaw: VIEW_YAW });

  const sim = createSimClock({ hz: 60 });
  app.addPreRenderHook((dt) => {
    sim.advance(dt, (d) => { for (const p of producers) p.update(d); units.update(d); });
    healthBars.begin();
    selectionRings.begin();
    selectionFrames.begin();
    unitRenderer.sync(dt, app.camera);
    for (const p of producers) if (p.structure.selected) p.markSelected(selectionFrames);
    healthBars.commit();
    selectionRings.commit();
    selectionFrames.commit();
    commandCard.tick();
    unitBar.tick();
    minimap.draw();
  });

  return { navGrid, units, unitRenderer, selection, sim, stamped, vehicles, hud, unitBar, commandCard, minimap, controlGroups };
}
