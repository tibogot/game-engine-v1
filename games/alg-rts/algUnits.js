// UNITS FOR THE ALGERIA GAME — the shared RTS machinery (games/shared-rts:
// nav grid, units, renderer, selection, health bars, rings, sim clock) wired
// to this game's map, buildings and unit list. The UI is this game's own
// (next step); nothing here imports from nam-rts.
import { createNavGrid } from "../shared-rts/navGrid.js";
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";
import { createUnits } from "../shared-rts/units.js";
import { CORPSES, createUnitRenderer } from "../shared-rts/unitRenderer.js";

// THE BODIES STAY (2026-10-07, the AAA list's "the battle leaves marks"): 14 s and gone read as
// a clean-up; CoH's field stays strewn. 90 s, 48 at most (each is posed every frame).
CORPSES.seconds = 90;
CORPSES.max = 48;
import { createHealthBarField } from "../shared-rts/healthBar.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { createAlgSquadMarch } from "./algSquadMarch.js";
import { createSelectionFrameField } from "../shared-rts/selectionFrameField.js";
import { createSelection } from "../shared-rts/selection.js";
import { createSimClock } from "../shared-rts/simClock.js";
import { createControlGroups } from "../shared-rts/controlGroups.js";
import { ALG_UNIT_TYPES, ALG_UNIT_TYPE_KEYS } from "./algUnitTypes.js";
import { createAlgSnipers } from "./algSniper.js";
import { createAlgUnitMarks } from "./algUnitMarks.js";
import { FR_PAINT_TINT, buildAMX13, buildAlouette, buildEBR, buildGMC, buildH21, buildHalfTrack, buildWillys } from "../../v3/render/objects/rtsVehiclesFr.js";
import { createAlgSquads, SQUADS, squadSize } from "./algSquads.js";
import { createAlgLastSeen } from "./algLastSeen.js";
import { createAlgPathDots } from "./algPathDots.js";
import { createSquadBadges } from "./ui/squadBadges.js";
import { createOrderMarks } from "./ui/orderMarks.js";
import { createAlgProducer } from "./algProducer.js";
import { createAlgStructures } from "./algStructures.js";
import { bakeStructureThumbnails } from "./structureThumbnails.js";
import { createAlgCombat } from "./algCombat.js";
import { POSTURE, createInfantryPosture } from "../shared-rts/infantryPosture.js";
import { createAlgGrenades } from "./algGrenades.js";
import { createAlgFlares } from "./algFlares.js";
import { createAlgBarrage } from "./algBarrage.js";
import { createAlgAirStrike } from "./algAirStrike.js";
import { createAlgVeterancy } from "./algVeterancy.js";
import { UPGRADES } from "./algSquads.js";
import { createAlgAI } from "./algAI.js";
import { createAlgFrenchAI } from "./algFrenchAI.js";
import { createAlgAccuracy, ACCURACY } from "./algAccuracy.js";
import { createAlgMines } from "./algMines.js";
import { createAlgPatrols } from "./algPatrols.js";
import { createAlgSight } from "./algSight.js";
import { createAlgCover } from "./algCover.js";
import { createFogOfWar } from "../shared-rts/fogOfWar.js";
import { LAYOUT, MAP, PLAY, VIEW_YAW, sitePoint } from "./layout.js";
import { createAlgDoctrines } from "./algDoctrines.js";
import { createAlgFieldWorks } from "./algFieldWorks.js";
import { COSTS, POP, createAlgEconomy, costOf, unitCost } from "./algEconomy.js";
import { createAlgRepair } from "./algRepair.js";
import { createAlgGarrison } from "./algGarrison.js";
import { createAlgTransports } from "./algTransports.js";
import { createAlgHeliLift } from "./algHeliLift.js";
import { createAlgFlnTricks } from "./algFlnTricks.js";
import { createAlgMortarTeams } from "./algMortarTeam.js";
import { createAlgRecoilless } from "./algRecoilless.js";
import { createAlgMules } from "./algMules.js";
import { createAlgSalvage } from "./algSalvage.js";
import { createAlgAttackMove } from "./algAttackMove.js";
import { createAlgWrecks } from "./algWrecks.js";
import { createAlgCrews } from "./algCrews.js";
import { createAlgDroppedWeapons } from "./algDroppedWeapons.js";
import { createAlgTiers } from "./algTiers.js";
import { BUILD_COSTS, buildButtons, canBuild, createAlgBuild } from "./algBuild.js";
import { createAlgSearchlights } from "./algSearchlight.js";
import { createResourceHud } from "./ui/resourceHud.js";
// This game's own UI (copies of nam's on day one, to be redesigned).
import { createHudBar } from "./ui/hudBar.js";
import { createUnitBar } from "./ui/unitBar.js";
import { createCommandCard } from "./ui/commandCard.js";
import { createMinimap } from "./ui/minimap.js";
import { createTacticalMap } from "./ui/tacticalMap.js";
import { createAlgCoverCursor } from "./algCoverCursor.js";
import { createAlgMgTeams } from "./algMgTeam.js";
import { createAlgFlamethrowers } from "./algFlamethrower.js";
import { createArmyTabs } from "./ui/armyTabs.js";
import { createQueueBadges } from "./ui/queueBadges.js";
import { installPortraits, hasPortrait } from "./ui/portraits.js";
import { t } from "./i18n/i18n.js";

/**
 * WHAT EACH BUILDING PRODUCES, seconds per unit (no costs yet: this game's
 * economy comes with its rules). The command card lists them in this order.
 */
const PRODUCTION = {
  // Infantry per SQUAD (algSquads.js), vehicles one each.
  post: { appele: 14, sapeur: 10, piece: 14, lanceFlammes: 16, mortierFr: 16, legion: 24 },
  motorPool: { willys: 10, gmc: 12, halftrack: 16, ebr: 20, amx13: 24 },
  helipad: { para: 18, alouette: 30, h21: 34 },   // paras: the heliborne reserve; the H-21 carries them
  caveEntrance: { moudjahid: 4, fmTeam: 7, tireur: 8, mortier: 16, sansRecul: 15, mitrailleuse: 14, mulet: 10 },   // the ALN's (its AI queues them; fmTeam needs an arms cache — algAI.js)
};

/** Pad-local point just past the footprint's edge, heading to (px, pz). */
function padEdge(m, px, pz) {
  const fp = m.geometry.userData.footprint, d = Math.hypot(px, pz) || 1;
  const r = Math.hypot(fp.hx, fp.hz) + 2;
  return [fp.cx + (px / d) * r, fp.cz + (pz / d) * r];
}

/**
 * The French vehicles built in code, by a unit type's `procedural` key. The jeep and the
 * half-track at DETAIL 2 (the vehicle lab, 2026-10-06), their crew real soldiers on the
 * builders' seats (FR_CREW, below) instead of the box men.
 */
const FR_VEHICLES = {
  willys: () => buildWillys({ detail: 2, crew: false }), gmc: () => buildGMC({ detail: 2, crew: false }), gmcOpen: () => buildGMC({ detail: 2, crew: false, tilt: false }), halftrack: () => buildHalfTrack({ detail: 2, crew: false }),
  amx13: () => buildAMX13({ detail: 2 }), ebr: () => buildEBR({ detail: 2 }), alouette: () => buildAlouette({ detail: 2, crew: false }),
  h21: () => buildH21(),
};

/**
 * The showroom's parked vehicles become UNITS where they stood: the static
 * piece leaves the scene (and the showroom list) and a unit of the same key
 * spawns on its spot, facing its way (a vehicle's front is +Z).
 */
// A LEAN START, Company of Heroes style (you, 2026-10-01): the post starts
// with its infantry, a sapeur and the jeep; the trucks, the half-track, the
// armour and the Alouette come with the TIERS (algTiers.js). ?army=full
// starts with the whole park, as before.
const START_VEHICLES = typeof location !== "undefined" && new URLSearchParams(location.search).get("army") === "full"
  ? null : new Set(["willys"]);

function takeOverVehicles(app, units, showroom) {
  let n = 0;
  for (const key of Object.keys(ALG_UNIT_TYPES)) {
    const o = ALG_UNIT_TYPES[key].procedural && showroom?.[key];
    if (!o?.isObject3D) continue;
    if (START_VEHICLES && !START_VEHICLES.has(key)) { o.removeFromParent(); delete showroom[key]; continue; }
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
 * Where a village is held from: a ksar from its souk (layout.js sitePoint);
 * any other, the centre of its placed piece's footprint (the showroom piece
 * standing on the site), else the site's own point.
 */
function villageCentre(site, showroom) {
  if (site.souk) return sitePoint(site);
  for (const o of Object.values(showroom ?? {})) {
    const f = o?.isObject3D ? o.geometry?.userData?.footprint : null;
    if (!f || Math.hypot(o.position.x - site.x, o.position.z - site.z) > 1) continue;
    // Village pieces are turned about Y only (no tilt).
    const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    return { x: o.position.x + f.cx * c + f.cz * s, z: o.position.z - f.cx * s + f.cz * c };
  }
  return { x: site.x, z: site.z };
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
    o.updateMatrixWorld(true);
    // `navRects` (rtsAlgVillage.js) replaces the footprint: [] for ground men
    // walk over (terraces, threshing floors), a garden's walls alone.
    for (const f of ud.navRects ?? [ud.footprint]) {
      const c = o.localToWorld(o.position.clone().set(f.cx, 0, f.cz));
      navGrid.addFootprint(c.x, c.z, f.hx, f.hz, o.rotation.y, { vehicleOnly: !!f.vehicleOnly });
    }
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
  // 2 m CELLS (2026-10-06, a player: "too many unwalkable places, let me into the villages"):
  // on the 4 m grid a village's lane, its yards and the gaps between houses were whole cells
  // or nothing — the mechtas were one blocked block. ?navcell=4 = the old grid (A/B).
  const NAV_CELL = Number(new URLSearchParams(location.search).get("navcell")) || 2;
  const navGrid = createNavGrid({ app, minCell: NAV_CELL, maxCellsPerSide: Math.ceil((app.worldSize ?? 1024) / NAV_CELL) });
  app.navGrid = navGrid;
  // Nobody walks out of the playable area (layout.js PLAY): four blocked
  // strips round it, kept through every nav rebuild like any footprint.
  {
    const H = (app.worldSize ?? 1024) / 2 + 8;
    const strip = (x0, x1, z0, z1) => navGrid.addFootprint((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, 0);
    strip(-H, PLAY.x0, -H, H); strip(PLAY.x1, H, -H, H);
    strip(PLAY.x0, PLAY.x1, -H, PLAY.z0); strip(PLAY.x0, PLAY.x1, PLAY.z1, H);
  }
  const stamped = stampShowroom(navGrid, showroom);

  // THINNER than nam's (you, 2026-10-03, watching CoH: the rings and frames
  // too thick, the bars thinner there): bars 0.28 m (0.55), rings a 10% band
  // (18%), building brackets 0.2 m deep (0.45).
  const healthBars = createHealthBarField({ scene: app.scene, height: 0.28, groundAt: (x, z) => app.getWorldHeight(x, z) });
  const selectionRings = createSelectionRingField({ app, inner: 0.9, segments: 56 });
  // Square buildings get corner brackets round their footprint, as in nam;
  // round ones (and units) the rings.
  const selectionFrames = createSelectionFrameField({ app, thick: 0.2 });

  // faceTargets: a man who stands and fires turns to his target (shared-rts/units.js, 2026-10-12).
  const units = createUnits({ app, navGrid, types: ALG_UNIT_TYPES, typeKeys: ALG_UNIT_TYPE_KEYS, spawn: {}, origin: muster, faceTargets: true });
  app.units = units;

  // TWO GROUPES of appelés formed up in front of the post's gate (2 x 6, each
  // a squad — algSquads.js — its leader, radioman and FM gunner first)…
  const fx = -Math.sin(muster.yaw), fz = -Math.cos(muster.yaw);   // out of the gate
  const rx = Math.cos(muster.yaw), rz = -Math.sin(muster.yaw);
  const startMen = { appele: [], sapeur: [], fln: [] };
  for (let i = 0; i < 12; i++) {
    const col = (i % 6 % 3) - 1 + (i < 6 ? -2.2 : 2.2), row = Math.floor((i % 6) / 3);
    const p = navGrid.nearestOpenWorld(muster.x + fx * row * 3.2 + rx * col * 3.2, muster.z + fz * row * 3.2 + rz * col * 3.2, true) ?? { x: muster.x, z: muster.z };
    startMen.appele.push(units.spawn("appele", p.x, p.z, { lookRole: i % 6 }));
  }
  // …and a sapeur team beside them (the lean start: they dig the post's defences).
  for (let i = 0; i < SQUADS.sapeur.size; i++) {
    const p = navGrid.nearestOpenWorld(muster.x + rx * (12 + i * 2.5), muster.z + rz * (12 + i * 2.5), true) ?? { x: muster.x, z: muster.z };
    startMen.sapeur.push(units.spawn("sapeur", p.x, p.z, { lookRole: i }));
  }

  // FOG OF WAR (the shared vision grid, as nam): what the French see — every
  // unit's `vision`, the buildings' (the mirador furthest). The ALN is not
  // drawn outside it; their buildings stay hidden until first seen. OFF by
  // default while the map is being built, as nam (Dev → Navigation, ?fow=1).
  // The fog banks go before it in the post chain (algFog.js rehook).
  const fogOfWar = createFogOfWar({
    app, units,
    structures: { get list() { return app.algStructures?.list ?? []; } },
    // The searchlights' pools of light see through the fog (algSearchlight.js).
    // the searchlights' pools and the flares' circles (algFlares.js) as small vision sources
    buildings: { get list() {
      const pools = app.algSearchlights?.pools ?? [], fl = app.algFlares?.sources;
      return fl?.length ? pools.concat(fl) : pools;
    } },
    // ON (2026-10-01, you: hidden caches + guerrillas only work if you cannot
    // see them): ?fow=0 to look at the whole map. Ridges block sight.
    enabled: new URLSearchParams(location.search).get("fow") !== "0",
    ridgeLOS: { eye: 2.2, target: 1.6 },
    bakeHz: 15,
    // Outside the playable box the land is darkened (CoH): scenery.
    bounds: PLAY,
    // CoH's look (darker, cooler, never black) on the FINISHED frame — after Sky Pro's
    // exposure meter, which the fog used to fool into brightening everything (2026-10-04).
    look: "coh", stage: "display",
  });
  app.fogOfWar = fogOfWar;
  fogOfWar.installPostFx(app);
  app.algFog?.rehook?.();

  // The PAINTED portraits (ui/portraits.js) stand in for the units' 3D
  // thumbnails. ?portraits=0 = the 3D ones.
  const usePortraits = new URLSearchParams(location.search).get("portraits") !== "0";
  const unitRenderer = await createUnitRenderer({
    app, units, healthBars, selectionRings, fogOfWar, types: ALG_UNIT_TYPES, typeKeys: ALG_UNIT_TYPE_KEYS.filter((k) => !ALG_UNIT_TYPES[k].drawnElsewhere),   // (a mule: the herds draw it — algMules.js)
    // A SOLDIER has no bar of his own: his squad's badge (French) or his band's (FLN) carries ONE
    // thin bar for them all (ui/squadBadges.js, CoH). Vehicles keep theirs. (An FLN fighter had
    // none in mind: not in a French squad, a wounded one floated a big bar under his band's badge
    // — you, 2026-10-08.)
    barFor: (u) => !u.type?.foot && !app.algSquads?.of(u),
    procedural: FR_VEHICLES, paint: FR_PAINT_TINT,
    // Their crews: appelés in the soldiers' crowd, on each vehicle's seats (unitRenderer crew).
    // (the closed GMC's cab too, 2026-10-18: its driver was baked in — a truck the FLN took kept him)
    crew: { willys: "appele", halftrack: "appele", alouette: "appele", gmc: "appele", gmcOpen: "appele" },
    // Seated men drawn out to the far corner of CoH 3's camera (~175 m at the top zoom; 135 cut them
    // off mid-screen from 102 m back — 2026-10-11).
    crewFar: 200,
    // The BENCH men only for the squad really aboard (algTransports; you, 2026-10-11: the
    // training's half-track looked full, K did nothing — it was empty). Driver and gunner always.
    troopsAboard: (u) => app.algTransports?.menOf(u).length ?? 0,
    // …in THEIR look (legionnaires as legionnaires, paras as paras), the crew stays appelés.
    troopLook: (u) => app.algTransports?.menOf(u)[0]?.typeKey ?? null,
    // A vehicle's OWN crew (algSalvage.js): abandoned — nobody (""); taken by the FLN — moudjahidin.
    crewLook: (u) => u.crewLook ?? null,
    // The GMC a MIX (you, 2026-10-07): closed under its tilt, or open with men on the benches.
    variants: { gmc: { gmcOpen: { ...ALG_UNIT_TYPES.gmc, typeKey: "gmcOpen", procedural: "gmcOpen" } } },
    // A man down: his pool under his torso (bloodField.js, made with combat).
    onCorpse: (u, x, z, heading) => app.algCombat?.blood.pool(x, z, heading),
    // Men blown apart by a close blast (algCombat GIBS): their blood.
    // ?gibs=0: the skinning pass without the cut (to A/B its cost).
    gibs: new URLSearchParams(location.search).get("gibs") !== "0",
    onGib: (u, parts) => app.algCombat?.gib(u, parts),
    // A type with a painted portrait (below) needs no 3D thumbnail: that bake
    // cost ~1.2 s of PNG encodes + ~5 s waiting on its readbacks at boot.
    thumbnailFor: usePortraits ? (k) => !hasPortrait(k) : null,
  });
  // After the renderer, which builds a view for each unit spawned from now on.
  const vehicles = takeOverVehicles(app, units, showroom);
  // The buildings' portraits, into the same map as the units' (the unit bar
  // and the command card look them up by thumbKeyOf: "struct:post", …).
  app.algUnitRenderer = unitRenderer;   // (static figures: a mortar pit's crew — algBuild.js)
  if (unitRenderer.thumbnails) {
    await bakeStructureThumbnails(app.renderer, unitRenderer.thumbnails).catch((e) => console.warn("[thumbs] structures:", e));
    // The PAINTED portraits (ui/portraits.js) over the units' 3D ones;
    // the buildings keep theirs. ?portraits=0 = the 3D ones.
    if (usePortraits) {
      app.algPortraits = await installPortraits(unitRenderer.thumbnails, units).catch((e) => { console.warn("[portraits]", e); return null; });
    }
  }
  // The production buildings (algProducer.js): selectable, they produce, and
  // their gate or doors swing open for each unit that comes out.
  const producers = [];
  const S = 1.3;
  if (showroom?.frenchPost) {
    const g = showroom.frenchPost.geometry.userData.gate;
    producers.push(createAlgProducer({
      mesh: showroom.frenchPost, units, typeKey: "post", name: MAP.id === "aures" ? t("Poste de Tighanimine") : (LAYOUT.sites.find((s) => s.kind === "french")?.name ?? t("Poste")), maxHp: 2000,
      builds: PRODUCTION.post,
      // In the courtyard behind the gate; out through the arch; the muster.
      inside: [0, g.z + 4.5 * S], outside: [0, g.z - 3.2 * S], rally: muster,
      // A whole SQUAD per click (algSquads.js).
      countOf: (key) => SQUADS[key]?.size ?? 1,
      onSpawned: (u, key, slot) => app.algSquads?.bought(u, key, slot),
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
      mesh: m, units, typeKey: "motorPool", name: t("Parc auto"), maxHp: 1400,
      builds: PRODUCTION.motorPool,
      inside: [g.x, 0], outside: out,
      rally: navGrid.nearestOpenWorld(rw.x, rw.z, false) ?? rw,
    }));
  }
  if (showroom?.helipad) {
    // The pad: an Alouette appears on the H, spools up, lifts off (units.js
    // launch), and holds off to the side of the pad — not over it, where the
    // next one takes off.
    const m = showroom.helipad, c = Math.cos(m.rotation.y), s = Math.sin(m.rotation.y);
    const [px, pz] = [-24, -26];
    const rally = { x: m.position.x + px * c + pz * s, z: m.position.z - px * s + pz * c };
    producers.push(createAlgProducer({
      mesh: m, units, typeKey: "helipad", name: t("Hélisurface"), maxHp: 900,
      builds: PRODUCTION.helipad,
      // Paras trained here walk off the pad's edge, toward the holding point.
      inside: [0, 0], outside: padEdge(m, px, pz), rally,
      launch: { hold: 2.2, rise: 2.4, deckY: m.geometry.userData.deckY ?? 0 },
      countOf: (key) => SQUADS[key]?.size ?? 1,
      onSpawned: (u, key, slot) => app.algSquads?.bought(u, key, slot),
    }));
    // The Alouette parked on the pad at the start (a unit now, hovering) moves
    // to that holding point, off the pad.
    for (const u of units.list) if (u.typeKey === "alouette") u.orderTo(rally.x, rally.z);
  }
  if (showroom?.caveEntrance) {
    // THE ALN'S CAVE MOUTH: a fighter appears deep in the tunnel, in the dark
    // at its end, and walks out through the gap the breastwork leaves (its
    // right side), past the sacks and the bedroll, to the ground in front.
    // The tunnel is the gate: nothing to swing.
    const m = showroom.caveEntrance;
    producers.push(createAlgProducer({
      mesh: m, units, typeKey: "caveEntrance", name: t("Grotte"), maxHp: 1600, team: "enemy",
      // (Playing the FLN, a faoudj of four takes 12 s, not one man's 4 — its AI keeps the 4.)
      builds: SIDES.human === "enemy" ? { ...PRODUCTION.caveEntrance, moudjahid: 12 } : PRODUCTION.caveEntrance,
      // A human playing the FLN buys a SQUAD per click (algSquads.js); its AI, single men (algAI.js).
      countOf: (key) => squadSize(key, "enemy"),
      onSpawned: (u, key, slot) => app.algSquads?.bought(u, key, slot),
      inside: [0.15 * S, 2.2 * S], outside: [0.4 * S, -6 * S],
      // They gather 22 m out TOWARD THE VALLEY (the French post), not
      // straight out of the mouth: the camp is in a corner of the map, and
      // straight out ran them to the plateau's edge, behind the crest.
      rally: (() => {
        const dx = muster.x - m.position.x, dz = muster.z - m.position.z, d = Math.hypot(dx, dz) || 1;
        const w = { x: m.position.x + (dx / d) * 22, z: m.position.z + (dz / d) * 22 };
        return navGrid.nearestOpenWorld(w.x, w.z, true) ?? w;
      })(),
    }));
  }
  app.algProducers = producers;
  // PLAYING THE FLN (?side=fln, step 1): its AI is off, so its men are yours from the start — a band
  // of ten moudjahidine and two FM teams out of the cave (the AI's own opening is bands of this size).
  if (SIDES.human === "enemy") {
    const cv = producers.find((p) => p.structure.typeKey === "caveEntrance");
    const o = cv?.outside ?? cv?.structure.position;
    // (Two faoudjs of four and two FM gunners: in squads once the squads exist, below.)
    if (o) for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, r = 4 + (i % 3) * 2.5;
      const p = navGrid.nearestOpenWorld(o.x + Math.cos(a) * r, o.z + Math.sin(a) * r, true) ?? o;
      const u = units.spawn(i < 8 ? "moudjahid" : "fmTeam", p.x, p.z, { team: "enemy", lookRole: i % 4 });
      if (u) startMen.fln.push(u);
    }
  }
  // Every building as a combat structure (algStructures.js): the producers
  // and the placed emplacements — targets, and the armed ones fighters.
  const structures = createAlgStructures({ app, showroom, producers, units });
  app.algStructures = structures;

  // THE ECONOMY (algEconomy.js): the villages are what both sides fight for;
  // holding one pays; every unit is paid for when it is queued.
  const economy = createAlgEconomy({
    app, units, structures,
    // Held from the VILLAGE ITSELF: the centre of its placed footprint (the
    // houses are not built round the site's point — a ring there sat off to
    // one side, you, 2026-09-29), and a ksar from its souk (layout.js sitePoint).
    sites: LAYOUT.sites.filter((s) => ["hamlet", "dechra", "ksar"].includes(s.kind)).map((s) => ({ ...s, ...villageCentre(s, showroom) })),
    // The supply lines run from the post (a held point pays only if linked to it).
    post: producers.find((p) => p.structure.typeKey === "post")?.centre ?? muster,
  });
  app.algEconomy = economy;
  // THE FRENCH TIERS (algTiers.js): unlocked from the post's card.
  const tiers = createAlgTiers(app, { economy, post: () => app.algProducers?.find((p) => p.structure.typeKey === "post" && p.structure.team === "player")?.structure ?? null });
  app.algTiers = tiers;
  // THE FLN'S TIERS (a human playing it — algTiers.js TIERS_FLN): bought on the cave's card, in supplies.
  // Its AI is not tiered (null when the FLN is the AI's).
  const flnTiers = SIDES.human === "enemy" ? createAlgTiers(app, { economy, side: "enemy", post: () => app.algProducers?.find((p) => p.structure.typeKey === "caveEntrance")?.structure ?? null }) : null;
  app.algFlnTiers = flnTiers;
  /** The tiers that gate a producer's units (null: none — the FLN's AI). */
  const tiersOf = (s) => (s.team === "player" ? tiers : flnTiers);
  for (const p of producers) {
    // The French: the POP CAP first (algEconomy.js POP) — a unit past it is refused, unpaid.
    p.structure.pay = (key) => (p.structure.team !== "player" || popRoom() >= popOf(key)) && economy.purses[p.structure.team].spend(unitCost(key, p.structure.team));
    p.structure.refund = (key) => economy.purses[p.structure.team].earn(unitCost(key, p.structure.team));
  }
  // THE POPULATION (balance 2026-10-04): the French in the field + on the queues.
  const popOf = (key) => POP[key] ?? SQUADS[key]?.size ?? 1;
  function popNow() {
    let n = 0;
    for (const u of units.list) if (u.alive && u.team === "player" && !u.isStructure) n += u.type?.foot ? 1 : POP[u.typeKey] ?? 2;
    for (const p of producers) if (p.structure.team === "player") for (const k of p.structure.queue) n += popOf(k);
    return n;
  }
  const popRoom = () => economy.popCap() - popNow();
  economy.pop = popNow;
  economy.popRoom = popRoom;
  // THE SQUADS (algSquads.js): the start army into squads; retreat to the
  // post's zone, heal and reinforce there.
  const postProd = producers.find((p) => p.structure.typeKey === "post") ?? null;
  const caveProd = producers.find((p) => p.structure.typeKey === "caveEntrance") ?? null;
  const squads = createAlgSquads({
    app, units,
    base: postProd?.centre ?? muster, muster,
    pay: (n) => economy.french.spend(n),
    // REINFORCING IN THE FIELD (CoH): at any of your half-tracks standing still.
    // (+ the forward posts the sappers build: algFieldWorks.js)
    // (+ a human FLN's pack mules: algMules.js)
    fieldPoints: () => [...units.list.filter((u) => u.alive && u.team === "player" && u.typeKey === "halftrack" && !u.isMoving), ...(app.algFieldWorks?.forwardPosts() ?? []), ...(app.algMules?.pointsFor("enemy") ?? []), ...(SIDES.human === "enemy" ? app.algFieldWorks?.refuges() ?? [] : [])],
    post: postProd ?? { inside: muster, outside: muster },
    popRoom: () => popRoom(),
    // PLAYING THE FLN: its squads' home is the cave — they retreat, heal and reinforce there.
    aln: SIDES.human === "enemy" && caveProd ? { base: caveProd.centre, muster: caveProd.structure.rally ?? caveProd.centre, pay: (n) => economy.aln.spend(n), post: caveProd } : null,
  });
  app.algSquads = squads;
  if (startMen.fln.length) {
    squads.adopt(startMen.fln.filter((u) => u.typeKey === "moudjahid"), "moudjahid");
    for (const u of startMen.fln.filter((u) => u.typeKey === "fmTeam")) squads.adopt([u], "fmTeam");
  }
  // THE SQUAD ON THE MARCH (algSquadMarch.js, 2026-10-12 — Company of Heroes' moving formation): a long
  // move walks as a squad behind its leader — a column on a track, a wedge in the open. ?march=0 = without.
  const march = new URLSearchParams(location.search).get("march") === "0" ? null : createAlgSquadMarch({ app, squads });
  app.algSquadMarch = march;
  // VETERANCY (algVeterancy.js): a squad's kills earn it stars.
  const veterancy = createAlgVeterancy({ app, squads });
  app.algVeterancy = veterancy;
  squads.adopt(startMen.appele.filter(Boolean), "appele");
  squads.adopt(startMen.sapeur.filter(Boolean), "sapeur");
  // A faint ring round each village in its holder's colour (the shared ring
  // field: a thin band on a big circle).
  const villageRings = createSelectionRingField({ app, max: 16, inner: 0.975, segments: 96, opacity: 0.55 });
  // The REINFORCE REACH (algSquads fieldPoints): round each still half-track while a squad short of
  // men is selected — where it can call a man in.
  const reachRings = createSelectionRingField({ app, max: 8, inner: 0.975, segments: 96, opacity: 0.5 });

  // ── The HUD (this game's files, ./ui/) ─────────────────────────────────
  const hud = createHudBar();
  // The boot page's key-hint label sits where the bar goes.
  const hint = document.getElementById("hud");
  if (hint) hint.style.display = "none";
  const mine = (key) => units.list.filter((u) => u.alive && isHuman(u.team) && u.typeKey === key);
  const unitBar = createUnitBar({
    thumbnails: unitRenderer.thumbnails,
    onPickGroup: (arr) => app.selection?.select(arr),
    onSelectAllType: (key) => app.selection?.select(mine(key)),
    // The cover and concealment chips (algCover.js), read at the first man.
    stanceFor: (sel) => {
      const u = sel.find((e) => !e.isStructure && !e.isAir);
      const c = app.algCover;
      if (!u || !c) return null;
      return { concealment: c.concealmentAt(u.position.x, u.position.z), cover: c.coverAt(u.position.x, u.position.z) };
    },
    mount: hud.centre,
  });
  const commandCard = createCommandCard({
    thumbnails: unitRenderer.thumbnails,
    onStop: () => { attackMove?.cancel(app.selection?.selected); for (const u of app.selection?.selected ?? []) u.stop?.(); },
    onFocus: () => {
      const sel = app.selection?.selected ?? [];
      if (!sel.length) return;
      app.rtsCamera?.focusOn(sel.reduce((s, u) => s + u.position.x, 0) / sel.length, sel.reduce((s, u) => s + u.position.z, 0) / sel.length);
    },
    // What a selected structure produces (PRODUCTION), labelled by unit name.
    // Locked units show greyed with what unlocks them (algTiers.js); the
    // post's card also carries the NEXT TIER's button.
    productionFor: (s) => {
      const tr = tiersOf(s);
      // (The FLN's AI's cave makes only what its AI makes: its men, gunners and marksmen.)
      const keys = Object.keys(PRODUCTION[s.typeKey] ?? {}).filter((key) => tr || ["moudjahid", "fmTeam", "tireur"].includes(key) || s.typeKey !== "caveEntrance");
      const list = keys.map((key) => {
        const need = tr ? tr.needs(key) : 1;
        const c = unitCost(key, s.team);
        // LOCKED: what unlocks it and where, in full (you, 2026-10-08: "some units read Verrouillé
        // and I can't make them — why?"); a click on it goes to the post (the FLN: the cave).
        return { key, label: ALG_UNIT_TYPES[key].buildLabel ?? ALG_UNIT_TYPES[key].name, cost: s.team === "player" ? { ...costOf(c), pop: popOf(key) } : c,
          locked: tr && need > tr.tier ? (s.team === "player" ? t("débloquez-le {how}. (Clic : aller au poste.)", { how: tr.howTo(tr.TIERS[need - 1]) }) : t("débloquez-le {how}.", { how: tr.howTo(tr.TIERS[need - 1]) })) : null };
      });
      const nx = tr?.next();
      if ((s.typeKey === "post" || (s.typeKey === "caveEntrance" && tr)) && nx) {
        const why = tr.blockedBy(nx);
        const heldNow = s.team === "player" ? economy.held : economy.heldByEnemy;
        list.push({
          key: "tier", label: `▲ ${nx.name}`, cost: nx.cost, tier: true,
          locked: why && heldNow < nx.villages ? why : null,   // too poor alone: not locked (the cost shows it)
          ready: !why,   // it can be bought now: the button pulses
          tip: nx.villages > 1
            ? t("Échelon {n} : {note}. Il faut tenir {villages} villages.", { n: nx.n, note: nx.note, villages: nx.villages })
            : t("Échelon {n} : {note}. Il faut tenir 1 village.", { n: nx.n, note: nx.note }),
        });
      }
      return list;
    },
    // (The HUMAN's purse — the FLN's one number when you play the FLN: ?side=fln.)
    canAfford: (cost) => (SIDES.human === "enemy" ? economy.aln.canAfford(cost) : economy.french.canAfford(cost) && (!cost?.pop || popRoom() >= cost.pop)),
    shortOf: (cost) => (SIDES.human === "enemy" ? "" : [economy.french.short(cost), cost?.pop && popRoom() < cost.pop ? t("troupes (plafond {cap} atteint)", { cap: economy.popCap() }) : ""].filter(Boolean).join(", ")),
    onBuild: (s, key) => { const tr = tiersOf(s); if (key === "tier") { if (tr?.unlock()) commandCard.render(app.selection?.selected ?? [s]); return; } if (!tr || tr.unlocked(key)) s.enqueue(key); },
    // THE SAPPERS' BUILDS (algBuild.js): a button per piece, its price on it.
    structureBuilds: buildButtons(),
    buildingCosts: BUILD_COSTS,
    onBuildStructure: (key, sel) => build?.begin(key, sel),
    // A LOCKED unit clicked: to the post, where its tier is bought (algTiers.js).
    onLocked: () => (SIDES.human === "enemy" ? flnTiers : tiers)?.goToPost(),
    // PATROUILLE (algPatrols.js): the selection walks the nearest track in
    // file, back and forth, until given another order.
    // GRENADE (algGrenades.js): one man of the selection throws.
    abilitiesFor: (sel) => (sel.some((u) => !u.isStructure && !u.isAir && isHuman(u.team))
      ? [
        // ASSAUT (algAttackMove.js): advance and fight on the way.
        attackMove?.ability(sel),
        { key: "patrol", label: sel.every((u) => patrols?.has(u)) ? t("En patrouille") : t("Patrouille"), hint: t("Patrouille en file sur la piste la plus proche, aller et retour (véhicules : la piste). Un GMC en patrouille ravitaille les villages que vous tenez."), ready: true },
        grenades?.ability(sel),
        // ORIENTER (algMgTeam.js): point a machine-gun team's arc.
        mgTeams?.ability(sel),
        // FUMIGÈNE (algGrenades.js + algSmoke.js): a screening cloud nobody sees through.
        grenades?.ability(sel, "smoke"),
        // THE UPGRADES (algSquads UPGRADES), for munitions: FM 24/29 for the appelés, the Légion, the paras.
        ...Object.entries(UPGRADES).map(([key, g]) => {
          const sq = squads.squadsIn(sel).filter((s) => squads.upgradeCost(s, key));
          if (!sq.length) return null;
          const purse = sq[0].team === "enemy" ? economy.aln : economy.french;
          const blocked = squads.upgradeBlocked(sq[0], key);
          const why = blocked === "armsCache" ? t(" Il faut une cache d'armes debout.") : "";
          return { key, label: g.label, cost: g.cost, hint: g.hint + (sq.length > 1 ? t(" ({n} groupes : chacun paie).", { n: sq.length }) : "") + why, ready: !blocked && purse.canAfford(g.cost) };
        }),
        // THE RADIO (algSquads UPGRADES.radio, CoH's forward observer): the section calls the
        // nearest mortar pit's barrage and the post's T-6 itself, on ground the men see.
        ...radioCalls(sel),
        // COUPER (algWire.js): sappers cut the nearest wire within 40 m.
        // RÉPARER (algRepair.js): sappers fix a damaged vehicle or building.
        repair?.ability(sel),
        // SORTIR (algGarrison.js): out of the house.
        garrison?.ability(sel),
        // DÉBARQUER (algTransports.js): out of the truck / half-track.
        transports?.ability(sel),
        // ATTERRIR (algHeliLift.js): an H-21 comes down empty, to wait for men.
        heliLift?.ability(sel),
        // MINE, COUPER LA LIGNE (algFlnTricks.js): playing the FLN, its moudjahidine's sabotage.
        ...(flnTricks?.ability(sel) ?? []),
        // TIR DE BARRAGE (algMortarTeam.js): the FLN's mortar team, set up.
        mortarTeams?.ability(sel),
        sel.some((u) => u.alive && isHuman(u.team) && canBuild(u, "wire"))
          && { key: "cutWire", label: t("Couper"), hint: t("Couper les barbelés les plus proches (40 m) : ~8 s pour un sapeur, moins à plusieurs."), ready: !!app.algWire?.nearest(sel[0].position.x, sel[0].position.z) },
        // SQUADS (algSquads.js): RETRAITE runs the squads home; RENFORCER
        // calls a man in for a squad short of men, at the post.
        squads.squadsIn(sel).length > 0 && {
          key: "retreat", label: squads.squadsIn(sel).every((s) => s.retreating) ? t("En retraite") : t("Retraite"),
          hint: squads.squadsIn(sel).some((s) => s.team === "enemy")
            ? t("Repli sur la grotte : sans tirer, impossible à clouer au sol, plus vite, moins touchés. Les blessés se soignent à la grotte.")
            : t("Repli sur le poste : sans tirer, impossible à clouer au sol, plus vite, moins touchés. Les blessés se soignent au poste."), ready: true,
        },
        (() => {
          const sq = squads.squadsIn(sel), cost = sq.reduce((n, s) => n + squads.reinforceCost(s), 0);
          if (!sq.length) return null;
          const short = sq.some((s) => s.count + squads.pendingFor(s) < s.size);
          return { key: "reinforce", label: t("Renforcer"), cost: cost || undefined,
            hint: sq.some((s) => s.team === "enemy")
              ? (sq.every((s) => !SQUADS[s.typeKey]?.reinforce) ? t("Un tireur seul ne se renforce pas : ramenez-le à la grotte, ses blessures s'y soignent.") : !short ? t("Groupe au complet.") : cost ? t("Un homme par faoudj incomplet, par la grotte.") : t("Ramenez le faoudj à la grotte (Retraite) pour le renforcer."))
              : sq.every((s) => !SQUADS[s.typeKey]?.reinforce) ? t("Un équipage ne se renforce pas : ramenez-le au poste, ses blessés s'y soignent.") : !short ? t("Groupe au complet.") : cost ? t("Un homme par groupe incomplet : par la porte du poste, ou par l'arrière d'un half-track à l'arrêt si le groupe se tient près de lui.") : t("Ramenez le groupe au poste (Retraite), ou près d'un half-track à l'arrêt (30 m), pour le renforcer."),
            ready: cost > 0 && economy.french.canAfford(cost) };
        })(),
      ].filter(Boolean)
      // A sappers' site (algBuild.js): cancel it, the price back.
      : sel.length === 1 && sel[0].site && sel[0].alive
        ? [{ key: "cancelSite", label: t("Annuler (+{n})", { n: BUILD_COSTS[sel[0].key] }), hint: t("Annuler le chantier : {n} ressources rendues.", { n: BUILD_COSTS[sel[0].key] }), ready: true }]
        // The MORTAR PIT: an illumination flare at night (algFlares.js).
        // and the BARRAGE (algBarrage.js), day or night.
        // The POST: the AIR STRIKE call-in (algAirStrike.js).
        // The MG NEST: point its arc (algMgTeam.js).
        : [barrage?.ability(sel), flares?.ability(sel), airStrike?.ability(sel), mgTeams?.ability(sel)].filter(Boolean)),
    onAbility: (key, sel) => {
      if (key === "cancelSite") build?.cancelSite(sel[0]);
      if (key === "cutWire") app.algWire?.orderCut(sel);
      if (key === "repair") repair?.begin(sel);
      if (key === "unload") { garrison?.exitAll(sel); commandCard.render(sel); }
      if (key === "disembark") { transports?.disembark(sel); commandCard.render(sel); }
      if (key === "heliLand") { heliLift?.land(sel); commandCard.render(sel); }
      if (key === "flnMine") flnTricks?.begin(sel);
      if (key === "flnWire") flnTricks?.begin(sel, "wire");
      if (key === "flnDetonate") { flnTricks?.detonate(sel); commandCard.render(sel); }
      if (key === "mortarBarrage") mortarTeams?.begin(sel);
      if (key === "flnCut") { flnTricks?.cut(sel); commandCard.render(sel); }
      if (key === "attackMove") attackMove?.begin(sel);
      if (key === "patrol") { patrols?.start(sel); commandCard.render(sel); }
      if (key === "grenade") grenades?.begin(sel);
      if (key === "smoke") grenades?.begin(sel, "smoke");
      if (key === "aimArc") mgTeams?.begin(sel);
      if (UPGRADES[key]) { for (const s of squads.squadsIn(sel)) squads.upgrade(s, key); commandCard.render(sel); }
      if (key === "barrage") barrage?.begin(sel);
      if (key === "radioBarrage") { const r = radioOf(sel); if (r?.pit) barrage?.begin([r.pit], { sight: seen }); }
      if (key === "radioAir") { const r = radioOf(sel); if (r?.post) airStrike?.begin([r.post], { sight: seen }); }
      if (key === "airStrike") airStrike?.begin(sel);
      if (key === "flare") flares?.begin(sel);
      if (key === "retreat") { for (const s of squads.squadsIn(sel)) squads.retreat(s); app.algSounds?.order?.("move", sel); commandCard.render(sel); }
      if (key === "reinforce") { for (const s of squads.squadsIn(sel)) squads.reinforce(s); commandCard.render(sel); }
    },
    // The cover and concealment chips, read at the first man (algCover.js).
    stanceFor: (sel) => {
      const u = sel.find((e) => !e.isStructure && !e.isAir);
      const c = app.algCover;
      if (!u || !c) return null;
      return { concealment: c.concealmentAt(u.position.x, u.position.z), cover: c.coverAt(u.position.x, u.position.z) };
    },
    mount: hud.right,
  });
  // THE RADIO's calls (algSquads UPGRADES.radio): the squads with one, the nearest pit, the post.
  const seen = (x, z) => !fogOfWar.enabled || fogOfWar.isVisible(x, z);
  function radioOf(sel) {
    const sq = squads.squadsIn(sel).filter((s) => s.upgrades.radio && s.members.length);
    if (!sq.length) return null;
    const at = sq[0].members[0].position;
    const pit = structures.list.filter((s) => s.alive && s.typeKey === "mortarPit" && isHuman(s.team))
      .sort((a, b) => Math.hypot(a.position.x - at.x, a.position.z - at.z) - Math.hypot(b.position.x - at.x, b.position.z - at.z))[0] ?? null;
    const post = structures.list.find((s) => s.alive && s.typeKey === "post" && isHuman(s.team)) ?? null;
    return { pit, post };
  }
  function radioCalls(sel) {
    const r = radioOf(sel);
    if (!r) return [];
    const b = r.pit && barrage?.ability([r.pit]);
    const a = r.post && airStrike?.ability([r.post]);
    return [
      { key: "radioBarrage", label: t("Barrage (radio)"), cost: b?.cost ?? barrage?.params.cost,
        hint: r.pit ? t("Par radio : la fosse de mortier la plus proche tire son barrage, à sa portée ({range} m d'elle), sur ce que vos hommes voient.", { range: barrage?.params.range ?? 150 }) : t("Par radio : il faut une fosse de mortier (les sapeurs la construisent)."),
        ready: !!b?.ready, cooldown: b?.cooldown ?? 0 },
      { key: "radioAir", label: t("T-6 (radio)"), cost: a?.cost ?? airStrike?.params.cost,
        hint: !r.post ? t("Par radio : plus de poste, plus d'avion.") : app.algTelegraph?.cut ? a.hint : t("Par radio : le poste demande le T-6, sur ce que vos hommes voient. Même prix, même délai que depuis le poste."),
        ready: !!a?.ready, cooldown: a?.cooldown ?? 0 },
    ];
  }
  let patrols = null;   // made after combat (algPatrols.js)
  let grenades = null;  // made after combat (algGrenades.js)
  let flares = null;    // the mortar pit's illumination flares (algFlares.js), after combat
  let barrage = null;
  let airStrike = null; // the post's air strike call-in (algAirStrike.js), after combat   // the mortar pit's barrage (algBarrage.js), after combat
  let build = null;     // made after the cover (algBuild.js)
  let repair = null;    // made after the build (algRepair.js)
  let garrison = null;  // made after the build (algGarrison.js)
  let transports = null, heliLift = null, flnTricks = null, mortarTeams = null, recoilless = null, mules = null;   // (flnTricks: a human FLN's mine and line cut — algFlnTricks.js)   // trucks and half-tracks carrying a squad (algTransports.js), with the garrisons
  let attackMove = null;   // ASSAUT: advance and fight (algAttackMove.js), after the selection
  let controlGroups = null;   // made after the selection it listens to
  let coverCursor = null, mgTeams = null;
  const selection = createSelection({
    app, units, unitRenderer, structuresRenderer: structures.renderer,
    // The sappers' sites (algBuild.js, made later): a click picks one.
    buildingRenderer: { get roots() { return build?.renderer.roots ?? []; }, buildingFromHit: (h) => build?.renderer.buildingFromHit(h) ?? null },
    // An order outside the playable box: the nearest point 8 m inside it
    // (the box's edge is blocked on the nav grid; room for the formation).
    // SQUADS: a man selects his squad; a move forms each squad (algSquads.js).
    squadOf: (u) => squads.squadOf(u),
    // CoH's chevrons at each man's spot, coloured by cover (ui/orderMarks.js),
    // instead of the shared blue ring.
    orderMarker: (x, y, z, sel, kind) => app.algOrderMarks?.order(x, y, z, sel, kind),
    // COVER AT THE CURSOR (algCoverCursor.js): a move's spots snapped onto the cover near them.
    adjustSlots: (slots, arr) => coverCursor?.adjustSlots(slots, arr),
    clampOrder: (x, z) => ({
      x: Math.min(PLAY.x1 - 8, Math.max(PLAY.x0 + 8, x)),
      z: Math.min(PLAY.z1 - 8, Math.max(PLAY.z0 + 8, z)),
    }),
    // The radio answers an order (algSounds.js).
    // Right-click an enemy soldier or vehicle you can see = attack; the red sight over him.
    attackUnits: true,
    canTarget: (u) => !fogOfWar?.enabled || fogOfWar.isVisible(u.position.x, u.position.z),
    // THE FORMATION FACES THE ENEMY (CoH, 2026-10-12): a plain right-click's squads turn to the nearest
    // VISIBLE enemy within 60 m of the spot (the fog: nothing hidden is given away); none: the way they go.
    facingFor: (px, pz) => {
      let best = null, bd = 60;
      for (const e of units.list) {
        if (!e.alive || e.isAir || !isHostile(e.team) || e.inside) continue;
        const d = Math.hypot(e.position.x - px, e.position.z - pz);
        if (d < bd && (!fogOfWar?.enabled || fogOfWar.isVisible(e.position.x, e.position.z))) { bd = d; best = e; }
      }
      return best ? Math.atan2(best.position.x - px, best.position.z - pz) : null;
    },
    onOrder: (kind, list) => {
      // MOVE MEANS MOVE (shared-rts/combat.js): a move is obeyed — no chasing, no stopping to
      // fight on the way (they shoot on the move); an attack order ends it.
      for (const u of list) if (!u.isStructure) u.playerMove = kind === "move";
      // A move takes men out of a house first (by its door); an attack is fired from inside.
      if (kind === "move") { garrison?.exitAll(list); transports?.exitAll(list); }   // (and out of a truck)
      attackMove?.cancel(list);   // a new order ends an assault (algAttackMove.go sets it again after)
      repair?.cancel(list);   // a new order ends a repair
      // A new order calls a retreating squad off its retreat (CoH).
      for (const s of squads.squadsIn(list)) if (s.retreating) squads.endRetreat(s);
      app.algSounds?.order(kind, list); app.algVoices?.order(kind, list);
    },
    // An ENEMY clicked: INSPECTED (shared-rts/selection.js) — its portrait, weapon and health in the
    // unit bar, the command card EMPTY (nothing of yours to order). null: back to the selection.
    onInspect: (u) => {
      const sel = selection.selected;
      hud.setCollapsed(!u && !sel.length);
      unitBar.render(u ? [u] : sel);
      commandCard.render(u ? [] : sel);
    },
    onChange: (sel) => {
      // Nothing selected: the card folds away (hudBar.js).
      hud.setCollapsed(!sel.length);
      app.algVoices?.select(sel);
      unitBar.render(sel);
      commandCard.render(sel);
      controlGroups?.render();
      onSelect(sel);
    },
  });
  app.selection = selection;
  attackMove = createAlgAttackMove(app, { selection });
  app.algAttackMove = attackMove;
  controlGroups = createControlGroups({ app, selection, mount: hud.root.querySelector(".block-right") });
  hud.setCollapsed(true);   // nothing selected at the start
  // THE ARMY TABS (ui/armyTabs.js): every group you have, down the right edge.
  // What each building is training, over its roof (ui/queueBadges.js).
  const queueBadges = createQueueBadges({ app, producers, thumbnails: unitRenderer.thumbnails });
  const armyTabs = createArmyTabs({ units, selection, squads, team: SIDES.human, thumbnails: unitRenderer.thumbnails, focus: (x, z) => app.rtsCamera?.focusOn(x, z) });
  // The tactical map from the start: the post has its own radio mast.
  const mapOpts = { app, units, selection, structures, fogOfWar, requisition: { params: economy.params, get points() { return economy.allPoints; } }, intel: () => true, upYaw: VIEW_YAW, area: PLAY, squadOf: (u) => squads.of(u) };
  const minimap = createMinimap({ ...mapOpts, mount: hud.left, dial: true });
  // THE TACTICAL MAP (ui/tacticalMap.js): the same map full screen, Tab.
  // COVER AT THE CURSOR: each man's spot, coloured by its cover, before the order.
  coverCursor = createAlgCoverCursor({ app, selection });
  app.algCoverCursor = coverCursor;
  const tacMap = createTacticalMap({ app, create: (mount) => createMinimap({ ...mapOpts, mount, id: "alg-tacmap", markScale: 2.3, labelPx: 15 }) });
  app.algTacMap = tacMap;
  // Top right now (resourceHud.js); the bottom strip is gone with it.
  const resourceHud = createResourceHud({ mount: document.body, troops: () => `${popNow()}/${economy.popCap()}`, tier: () => (flnTiers ?? tiers).readout() });
  hud.strip.style.display = "none";

  // COMBAT (algCombat.js, the shared machinery): men and vehicles pick up
  // enemies in range, close, fire visible rounds; the dead drop out of the
  // selection.
  // COVER AND CONCEALMENT (algCover.js): scrub hides, stone and sandbags
  // shelter; hold V to see it (armed when something is selected, as nam).
  const coverSys = createAlgCover(app, { showroom, isArmed: () => (selection.selected?.length ?? 0) > 0 });
  app.algCover = coverSys.cover;
  app.algCoverOverlay = coverSys.overlay;
  // THE GÉNIE (algBuild.js): sappers place and raise the defences; a finished
  // wall re-bakes the cover map.
  build = createAlgBuild({
    app, units, structures, navGrid, showroom, purse: economy.french, enemyPurse: economy.aln,
    onCover: () => coverSys.cover.bake(),
  });
  app.algBuild = build;
  // REPAIR (algRepair.js): sapeurs fix damaged vehicles and buildings (CoH's engineers).
  repair = createAlgRepair(app, { units, structures, isSapper: (u) => u.typeKey === "sapeur" });
  app.algRepair = repair;
  // GARRISONS (algGarrison.js): a squad inside a house, firing from its windows (CoH).
  garrison = createAlgGarrison(app, { units, squads, navGrid, showroom, fogOfWar });
  app.algGarrison = garrison;
  // TRANSPORTS (algTransports.js): a squad rides in a GMC or a half-track.
  // THE H-21 LIFT (algHeliLift.js): it lands to take squads on and to set them down.
  heliLift = createAlgHeliLift(app, { units, navGrid });
  app.algHeliLift = heliLift;
  transports = createAlgTransports(app, { units, navGrid, heli: heliLift });
  app.algTransports = transports;
  // THE SEARCHLIGHTS (algSearchlight.js): sweep, lock on, reveal who is lit.
  const searchlights = createAlgSearchlights(app, { structures, units, cover: coverSys.cover });
  app.algSearchlights = searchlights;
  // LINE OF SIGHT (algSight.js): ridges and tall buildings stop a shot; low
  // walls are cover, not blockers. ?los=0 = without (A/B).
  const sight = new URLSearchParams(location.search).get("los") !== "0" ? createAlgSight(app, { showroom, worldSize: app.worldSize ?? 1024 }) : null;
  app.algSight = sight;
  if (sight) console.log(`[sight] ${sight.stats.pieces} pieces baked, ${sight.stats.cells} tall cells, ${sight.stats.bakeMs} ms`);
  // INFANTRY POSTURE (shared-rts/infantryPosture.js, the CoH way): fire
  // SUPPRESSES men on foot (they kneel, slow), heavy fire PINS them (prone,
  // crawling); a man sheltered from his target kneels behind his cover.
  // RIFLES SUPPRESS TOO (you, 2026-10-02: "in CoH riflemen crouch under
  // steady fire"): 0.07 a round topped out at 0.1-0.26 under a section's
  // fire (kneel = 0.4) — nobody ever knelt from rifles alone. 0.12: a squad
  // firing steadily at a man puts him on a knee; one rifle alone doesn't.
  // Capped at 0.8 (pinned = 1.0): rifles alone never put a man flat (0.12
  // uncapped did, in the lab) — that stays the MG's job.
  const posture = createInfantryPosture({ units, cover: coverSys.cover, params: { ...POSTURE, perRound: { ...POSTURE.perRound, rifle: 0.12 }, capByWeapon: { rifle: 0.8 }, movePinned: 0.1 } });   // pinned = barely a crawl (CoH: pinned men can't advance; at 0.3 a pinned rush still reached the gun)
  // MACHINE-GUN TEAMS (algMgTeam.js): the pièce FM's gunner and the FLN's FM gunners set up, fire
  // in an arc, pack up to move.
  mgTeams = createAlgMgTeams({ app, units, selection, fogOfWar,
    isGunner: (u) => u.typeKey === "fmTeam" || (u.typeKey === "mitrailleuse" && u.weapon === "mg") || (u.squad?.typeKey === "piece" && u.squad.slots[0] === u),
    emplacements: () => structures.list });
  app.algMgTeams = mgTeams;
  app.algPosture = posture;
  // WRECKS (algWrecks.js): a destroyed vehicle stays, burnt, burning, as cover and an obstacle.
  const wrecks = createAlgWrecks(app, { types: ALG_UNIT_TYPES, builders: FR_VEHICLES, paint: FR_PAINT_TINT, navGrid, cover: coverSys.cover });
  app.algWrecks = wrecks;
  // CREWS BAIL OUT (algCrews.js): out of the wreck, the men who made it, as a small squad.
  const crews = createAlgCrews(app, { units, squads, navGrid });
  app.algCrews = crews;
  // DROPPED WEAPONS (algDroppedWeapons.js): a dead FM gunner's gun stays; a passer-by takes it up.
  const dropped = createAlgDroppedWeapons(app, { units, squads, fogOfWar });
  app.algDroppedWeapons = dropped;
  const combat = await createAlgCombat(app, {
    units, structures, cover: coverSys.cover, blocksSight: sight?.blocksSight ?? null,
    onDeath: (e) => { dropped.onDeath(e); veterancy.onDeath(e); app.algDoctrines?.onKill(e); app.algFrenchDoctrines?.onKill(e); app.algFlnDoctrines?.onKill(e); selection.remove?.(e); controlGroups?.render(); transports?.onDeath(e); app.algSalvage?.onDeath(e); if (!e.isStructure && !e.type?.foot && !e.isAir) { wrecks.add(e); crews.bail(e); } },
    onShot: (e, tgt) => { posture.onShot(e, tgt); app.algSnipers?.onShot(e, tgt); app.algRecoilless?.onShot(e); }, onSplash: (at, r, owner) => { posture.onSplash(at, r, owner); garrison?.onSplash(at, r); },
    // The walls take some of a blast (algGarrison.js) — two grenades on a house of six: at full,
    // 4 dead; at 0.6, 0.1 (and every squad bailed out); 0.8 between, as CoH.
    // (men aboard a vehicle: none — it is the vehicle that takes it, algTransports.js)
    splashMul: (o) => (o.carrier ? 0 : o.inside ? 0.8 : 1),
    // ACCURACY (algAccuracy.js): a round rolls to hit — range, posture,
    // cover. ?acc=0 = every round hits (the old fights, A/B).
    hitChance: new URLSearchParams(location.search).get("acc") !== "0" ? createAlgAccuracy({ cover: coverSys.cover }) : null,
  });
  app.algCombat = combat;
  // LANCE-FLAMMES (algFlamethrower.js): whoever carries the flamer fires a stream that burns
  // everyone in it (combat.js `fireAt`), pins, routs, clears houses, sets fires.
  const flamers = await createAlgFlamethrowers({ app, units, isFlamer: (u) => u.weapon === "flamer" });
  app.algFlamers = flamers;
  app.algAccuracy = ACCURACY;   // dev: the table, live
  grenades = createAlgGrenades({ app, units, projectiles: combat.projectiles, selection, purse: economy.french });
  app.algGrenades = grenades;
  // ILLUMINATION FLARES (algFlares.js): the mortar pit lights a zone at night. ?flares=0 = without.
  if (new URLSearchParams(location.search).get("flares") !== "0") {
    flares = createAlgFlares({ app, units, selection, purse: economy.french, cover: coverSys.cover });
    app.algFlares = flares;
  }

  // THE MORTAR BARRAGE (algBarrage.js): six bombs on a zone from the pit, for munitions.
  barrage = createAlgBarrage({ app, selection, projectiles: combat.projectiles, structures, purse: economy.french });
  app.algBarrage = barrage;
  airStrike = createAlgAirStrike({ app, selection, projectiles: combat.projectiles, combat: combat.combat ?? combat, purse: economy.french });
  app.algAirStrike = airStrike;
  // DOCTRINES (algDoctrines.js): the commander chosen in the briefing, command points from the
  // fight, its call-ins on a strip above the HUD. Not in the training.
  // (Both sides now: the FLN's two when you play it — 2026-10-13, A4.)
  const doctrines = MAP.tutorial ? null : createAlgDoctrines(app, { units, squads, economy, projectiles: combat.projectiles, combat: combat.combat ?? combat, airStrike, fogOfWar });
  app.algDoctrines = doctrines;
  // FIELD WORKS (algFieldWorks.js): the forward post, the aid station, the fortified point.
  const fieldWorks = createAlgFieldWorks(app, { units, structures, economy });
  app.algFieldWorks = fieldWorks;

  // THE ALN (algAI.js): bands out of the cave, ambushes where the French are
  // thin, back into the cave before the armour comes. ?ai=0 = without.
  const cave = producers.find((p) => p.structure.typeKey === "caveEntrance");
  const postP = producers.find((p) => p.structure.typeKey === "post");
  // (Not when YOU are the FLN — ?side=fln: its men are yours to command.)
  const ai = cave && SIDES.human !== "enemy" && new URLSearchParams(location.search).get("ai") !== "0"
    ? createAlgAI(app, { units, squads, cave, post: postP?.centre ?? muster, caveMouth: cave.outside,
      // ITS DOCTRINE (2026-10-18, FLN AI step 9 — no strip): its own instance of the doctrine module, for the FLN.
      doctrine: MAP.tutorial ? null : (app.algFlnDoctrines = createAlgDoctrines(app, { units, squads, economy, projectiles: combat.projectiles, combat: combat.combat ?? combat, airStrike, fogOfWar, side: "enemy", ui: false })) })
    : null;
  app.algAI = ai;
  // THE SNIPERS (algSniper.js): the FLN's tireurs, out of the cave, on perches above the French.
  const snipers = ai ? createAlgSnipers(app, { units, cave }) : null;
  app.algSnipers = snipers;

  // THE TRACKS AT WAR: the ALN's mines on the piste (algMines.js; the AI lays
  // them), the French patrols and convoys along the tracks (algPatrols.js).
  const mines = createAlgMines(app, { units, combat: combat.combat });
  app.algMines = mines;
  // THE MORTAR TEAMS, both sides' (algMortarTeam.js: the French 81, a human FLN's 60).
  mortarTeams = createAlgMortarTeams(app, { units, squads, projectiles: combat.projectiles, selection, fogOfWar, purses: { player: economy.french, enemy: economy.aln } }); app.algMortarTeams = mortarTeams;
  if (SIDES.human === "enemy") {
    flnTricks = createAlgFlnTricks(app, { units, selection, mines, purse: economy.aln }); app.algFlnTricks = flnTricks;
  }
  // The recoilless and the mules: in EVERY game (2026-10-18 — the FLN's AI buys them too; their orders
  // by mouse act on the human's units only).
  recoilless = createAlgRecoilless(app, { squads }); app.algRecoilless = recoilless;
  mules = createAlgMules(app, { units, squads, selection }); app.algMules = mules;
  // SALVAGE (algSalvage.js): a French jeep / GMC left abandoned, taken by whoever gets a man to it.
  app.algSalvage = createAlgSalvage(app, { units });
  patrols = createAlgPatrols(app, { units, economy, onDelivery: (n, v) => resourceHud.flash(t("+{fuel} C +{mun} M · convoi {name}", { fuel: n.fuel, mun: n.mun, name: v.name })) });
  app.algPatrols = patrols;

  const sim = createSimClock({ hz: 60 });
  // THE BATTLE LAB's clock (battleLab.js): slow motion, pause, one step.
  // The game never sets them (scale 1, no step); the camera keeps real time.
  app.timeScale ??= 1;
  app.timeStep ??= 0;
  // LAST SEEN (algLastSeen.js): where an enemy was when he dropped out of sight.
  const ghostRings = createSelectionRingField({ app, max: 32, inner: 0.86, segments: 40, opacity: 0.5 });
  const lastSeen = createAlgLastSeen({ app, units, fogOfWar, rings: ghostRings, team: hostileSide() });
  // THE PATH DOTS (algPathDots.js): the selected squads' routes on the ground.
  const pathDots = createAlgPathDots({ app, selection, squads });
  app.algPathDots = pathDots;
  // THE SQUAD BADGES (ui/squadBadges.js): icon, men left, one thin bar (CoH).
  // (+ the FLN's bands as squads once seen: a red shield, their men and the katiba's stars)
  const squadBadges = createSquadBadges({ app, squads, groups: () => (app.algAI?.bands ?? []).filter((b) => b.state !== "gather" && b.state !== "done").map((b) => ({ id: b, team: "enemy", typeKey: "moudjahid", members: b.members.filter((u) => u.alive && !u.inside), stars: veterancy.katiba.stars })) });
  const orderMarks = createOrderMarks({ app });
  app.algOrderMarks = orderMarks;
  app.algLastSeen = lastSeen;
  // UNIT MARKS (algUnitMarks.js): a faint team ring under every man you can see. OFF since
  // 2026-10-08 (you: "a blue circle round the units even when not selected — that's not how CoH
  // works"): CoH rings only the selection; the squad badges make the men findable. ?marks=1 = on.
  const unitMarks = new URLSearchParams(location.search).get("marks") === "1" ? createAlgUnitMarks(app, { units, selection, fogOfWar }) : null;
  app.algUnitMarks = unitMarks;
  // THE FRENCH COMMANDER (algFrenchAI.js) when YOU are the FLN (?side=fln): builds, takes and holds
  // the villages, retakes, defends the post, calls the T-6, goes for the cave. ?ai=0 = without.
  // ?bot=1 (dev, balance runs): it plays the French side too, against the FLN's AI — watch, or
  // fast-forward and measure (__ALG.fastForward).
  const botQ = new URLSearchParams(location.search);
  const frenchAI = (SIDES.human === "enemy" ? botQ.get("ai") !== "0" : botQ.get("bot") === "1")
    ? createAlgFrenchAI(app, { units, squads, economy, producers, tiers, garrison, airStrike, build, barrage, flares, grenades, transports, mortarTeams,
      // HIS DOCTRINE (no strip): its own instance of the doctrine module, for the French.
      doctrine: MAP.tutorial ? null : (app.algFrenchDoctrines = createAlgDoctrines(app, { units, squads, economy, projectiles: combat.projectiles, combat: combat.combat ?? combat, airStrike, fogOfWar, side: "player", ui: false })) })
    : null;
  app.algFrenchAI = frenchAI;
  const simStep = (d) => { ai?.step(d); frenchAI?.step(d); snipers?.step(d); dropped.step(d); for (const p of producers) p.update(d); patrols.step(d); units.update(d); combat.step(d, sim.simTime + ffTime); flamers.step(d); posture.step(d); squads.step(d); mortarTeams?.step(d); recoilless?.step(d); mules?.step(d); app.algSalvage?.step(d); march?.step(d); mgTeams.step(d); lastSeen.step(d); grenades.step(d); flares?.step(d); barrage.step(d); airStrike.step(d); mines.step(d); economy.step(d); build.step(d); repair?.step(d); garrison?.step(d); heliLift?.step(d); flnTricks?.step(d); transports?.step(d); attackMove?.step(d); searchlights.step(d); veterancy.step(); doctrines?.step(d); app.algFrenchDoctrines?.step(d); app.algFlnDoctrines?.step(d); fieldWorks.step(d); };
  // BALANCE RUNS (dev, as nam's): `seconds` of the war at once, nothing drawn —
  // __ALG.fastForward(120). The battle's score clock (algBattle.js) runs on frames, not this.
  let ffTime = 0;   // fast-forwarded seconds: the combat clock (fire timings) must see them
  app.fastForward = (seconds) => { for (let i = Math.round(seconds / sim.stepSeconds); i > 0; i--) { ffTime += sim.stepSeconds; simStep(sim.stepSeconds); } };
  app.addPreRenderHook((frameDt) => {
    let dt = frameDt * app.timeScale;
    if (app.timeStep) { dt = app.timeStep; app.timeStep = 0; }
    sim.advance(dt, simStep);
    searchlights.frame();
    dropped.frame();
    combat.frame(dt);
    flamers.frame(dt);
    grenades.frame();
    flares?.frame();
    barrage.frame();
    airStrike.frame();
    coverCursor?.frame();
    mgTeams?.frame();
    unitMarks?.frame();
    doctrines?.frame(dt);
    app.algFrenchDoctrines?.frame(dt);
    app.algFlnDoctrines?.frame(dt);
    fogOfWar.update(dt);
    // An inspected enemy that slipped back into the fog is let go (dead: onDeath does it).
    const ins = selection.inspected;
    if (ins && fogOfWar.enabled && !fogOfWar.canSeeEntity(ins)) selection.remove(ins);
    // The V overlay: centred on the selection until the pointer has moved.
    const lead = selection.selected?.find((e) => !e.isStructure) ?? selection.selected?.[0];
    if (lead?.position) coverSys.overlay.setFallback(lead.position.x, lead.position.z);
    coverSys.overlay.update(dt);
    healthBars.begin();
    selectionRings.begin();
    selectionFrames.begin();
    unitRenderer.sync(dt, app.camera);
    structures.frame(dt, app.camera, healthBars, selectionFrames);
    // The capture rings, the Company of Heroes way: all of them while you
    // have men selected (you are giving orders), otherwise only where someone
    // is standing in one — always-on, they cluttered the map (you, 2026-09-29).
    villageRings.begin();
    const giving = selection.selected?.some((e) => isHuman(e.team) && !e.isStructure);
    for (const v of economy.allPoints) {
      if (v.kind === "supply") continue;   // (supply points: their own rings, always shown — algPointRings.js, 2026-10-12)
      const R = v.radius;
      const busy = giving || units.list.some((u) => u.alive && !u.isAir && Math.abs(u.position.x - v.position.x) < R && Math.abs(u.position.z - v.position.z) < R && Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) < R);
      // Held but cut off from the post (no supply line): amber, it pays nothing.
      if (busy) villageRings.add(v.position.x, v.position.z, R, isHuman(v.owner) ? (v.linked ? 0x58a8ff : 0xe0a040) : isHostile(v.owner) ? 0xff6a5a : 0xd8cfae);
    }
    villageRings.commit();
    reachRings.begin();
    if (squads.squadsIn(selection.selected ?? []).some((q) => q.count + squads.pendingFor(q) < q.size)) {
      for (const u of units.list) if (u.alive && u.team === "player" && u.typeKey === "halftrack" && !u.isMoving) reachRings.add(u.position.x, u.position.z, squads.P.fieldRadius, 0x58e070);
    }
    reachRings.commit();
    ghostRings.begin();
    lastSeen.frame(app.camera);
    ghostRings.commit();
    pathDots.frame(app.camera);
    squadBadges.frame(app.camera);
    garrison?.frame(app.camera);
    transports?.frame(app.camera);
    flnTricks?.frame();
    mortarTeams?.frame();
    mules?.frame();
    orderMarks.frame(frameDt, app.camera);
    resourceHud.update(economy);
    tiers.watch(frameDt);   // "tier available" alert (algTiers.js)
    flnTiers?.watch(frameDt);
    healthBars.commit();
    selectionRings.commit();
    selectionFrames.commit();
    commandCard.tick();
    unitBar.tick();
    armyTabs.tick(frameDt);
    queueBadges.frame();
    minimap.draw();
    tacMap.draw();
  });

  return { navGrid, units, unitRenderer, selection, sim, stamped, vehicles, hud, unitBar, commandCard, minimap, controlGroups, combat, ai };
}
