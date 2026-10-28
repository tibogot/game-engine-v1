// THE GÉNIE BUILDS — the French sappers raise the post's defences (you,
// 2026-09-29: the Company of Heroes loop; until now they stood pre-placed).
//
//   select sappers → a build button (the command card) → the piece itself, a
//   see-through GHOST, follows the cursor: green where it can stand, red where
//   not → left-click places it (Shift-click: place and keep going, for a run of
//   sandbags or wire), R turns it 45°, right-click / Esc cancels.
//
// Placing PAYS, levels the ground for a piece that stands on a pad, blocks the
// spot on the nav grid, clears the plants and lays a foundation; the sappers
// walk there. While a sapper stands at the site it RISES (two work faster);
// done, it is a structure like the pre-placed ones (algStructures.js: it
// fights, sees, is picked, is shot at) and its walls give cover.
//
// Game code: this game's buildings, prices and rules. The same flow in nam-rts
// is nam's own (buildPlacement.js / buildings.js).
import * as THREE from "three";
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";
import { buildAmbushScreen, buildArmsCache, buildBarbedWire, buildFlnInfirmary, buildFortPoint, buildRefuge, buildFrSandbagWall, buildMgNest, buildMirador, buildMortarPit, buildSangar, buildSearchlightTower } from "../../v3/render/objects/rtsAlgeria.js";
import { buildRadioStation, buildTent } from "../../v3/render/objects/rtsFirebaseProps.js";
import { createHealthBarField } from "../shared-rts/healthBar.js";
import { buildMortarPitV2 } from "./algMortarPit.js";
import { kitView } from "./showroom.js";
import { siteBags } from "./algSandbags.js";
import { attachMotorPool, loadMotorPool } from "./algMotorPool.js";
import { dressPens } from "./algPenProps.js";
import { farmGeometry, grotteGeometry, loadFarmstead, loadGrotte, loadSasPost, sasGeometry, loadLookout, loadMineMarker, lookoutGeometry, mineMarkerGeometry, setPieceState } from "./algSangar.js";
import { ambushScreenGeometry, armsCacheGeometry, barbedWireGeometry, dropScreenPlants, loadFrenchPost, swapPost, fortPointGeometry, loadFortPoint, loadSearchlight, forwardPostGeometry, aidStationGeometry, loadForwardPost, loadAidStation, refugeGeometry, infirmaryGeometry, loadRefuge, loadInfirmary, searchlightGeometry, growScreenPlants, loadAmbushScreen, loadArmsCache, loadBarbedWire, loadMgNest, loadMirador, loadMortarPit, loadSangar, mgNestGeometry, mortarPitGeometry, miradorGeometry, sangarGeometry, swapPlaced, trackLod, untrackLod } from "./algSangar.js";
import { buildFortPointPiece, buildMgNestPiece, buildSandbagWallPiece } from "./algSandbags.js";
import { MAP, PLAY, VIEW_YAW } from "./layout.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { t } from "./i18n/i18n.js";

/**
 * What a sapper can build. `pad`: stands on levelled ground (the mirador, the
 * pits); `follow`: lies ON the slope like real bags and wire. `time`: seconds
 * for one sapper. `structure`: its combat stats' key (algStructures.js STATS).
 */
export const BUILDS = {
  sandbags: { label: t("Sacs de sable"), tip: t("Mur de sacs de sable : une couverture solide pour les hommes derrière."), cost: 20, time: 6, build: () => buildSandbagWallPiece(() => buildFrSandbagWall()), follow: true },
  wire: { label: t("Barbelés"), tip: t("Barbelés : il faut les contourner ou les couper ; un véhicule les écrase."), cost: 15, time: 5, build: () => barbedWireGeometry() ?? buildBarbedWire() /* (the Blender piece once loaded — algSangar.js) */, follow: true, noFoot: true },
  mgNest: { label: t("Nid de MG"), tip: t("Nid de mitrailleuse : une AA-52 derrière des sacs de sable."), cost: 90, time: 14, build: () => mgNestGeometry() ?? buildMgNestPiece((o) => buildMgNest(o)) /* (the Blender piece once loaded — algSangar.js) */, pad: true, structure: "mgNest" },
  mortarPit: { label: t("Mortier"), tip: t("Fosse de mortier de 81 : tire de 25 à 160 m, par-dessus les abris. Plus loin que l'équipe de mortier, mais fixe."), cost: 130, time: 18, build: () => mortarPitGeometry() ?? buildMortarPitV2() /* (the Blender piece once loaded — algSangar.js) */, pad: true, structure: "mortarPit" },
  mirador: { label: "Mirador", tip: t("Mirador : voit à 110 m, une mitrailleuse dans la cabine."), cost: 110, time: 20, build: () => miradorGeometry() ?? buildMirador() /* (the Blender piece once loaded — algSangar.js) */, pad: true, structure: "mirador" },
  searchlight: { label: t("Projecteur"), tip: t("Tour de projecteur : voit à 100 m."), cost: 60, time: 10, build: () => searchlightGeometry() ?? buildSearchlightTower() /* (the Blender piece once loaded — algSangar.js) */, pad: true, structure: "searchlight" },
  // FIELD WORKS (2026-10-10, the CoH comparison: what engineers raise OUT on the map — algFieldWorks.js).
  // `near: "point"`: only inside the ring of a point you hold. `one`: one per point.
  forwardPost: { label: t("Poste avancé"), tip: t("Poste radio près d'un point que vous tenez : vos groupes à 30 m s'y renforcent, comme au poste."), cost: 150, time: 25, build: () => forwardPostGeometry() ?? buildRadioStation({ seed: 41 + Math.floor(Math.random() * 9) }) /* (the Blender piece once loaded — algSangar.js) */, pad: true, structure: "forwardPost", near: "point", one: true },
  aidStation: { label: t("Poste de secours"), tip: t("Tente de l'infirmier : vos blessés à 20 m guérissent, hors du combat."), cost: 100, time: 18, build: () => aidStationGeometry() ?? fieldTent() /* (the Blender piece once loaded) */, pad: true, structure: "aidStation" },
  fortPoint: { label: t("Point fortifié"), tip: t("Sacs de sable dans le cercle d'un point que vous tenez : il rapporte 25 % de plus et le FLN met deux fois plus de temps à le prendre."), cost: 120, time: 20, build: () => fortPointGeometry() ?? buildFortPointPiece((o) => buildFortPoint({ seed: 51 + Math.floor(Math.random() * 9), ...o })) /* (the Blender piece once loaded — algSangar.js) */, follow: true, structure: "fortPoint", near: "point", one: true },
  // THE ALN BUILDS TOO (you, 2026-09-30): the same sites, paid from the ALN's
  // purse, raised by moudjahidine (`by`: no command card of theirs to list
  // them — the AI places them through place()). Both lie on the slope, as
  // the showroom's do.
  sangar: { label: t("Sangar"), tip: t("Position de tir en pierres sèches : un FM tire par-dessus son rebord, les hommes derrière sont à couvert."), cost: 60, time: 16, build: () => sangarGeometry() ?? buildSangar() /* (the Blender piece once loaded — algSangar.js) */, follow: true, structure: "sangar", team: "enemy", by: ["moudjahid"] },
  // A NEW ARMS CACHE (2026-10-02): the FLN hides one in a village it holds
  // when the French have found theirs (algAI.js) — each standing cache arms
  // two FM teams. Hidden from the French until seen, built or not.
  armsCache: { label: t("Cache d'armes"), tip: t("Cache d'armes : chaque cache debout arme deux équipes FM. Cachée aux Français tant qu'ils ne l'ont pas vue."), cost: 120, time: 40, build: () => armsCacheGeometry() ?? buildArmsCache({ seed: 1958 + Math.floor(Math.random() * 99) }) /* (the Blender piece once loaded — algSangar.js) */, follow: true, structure: "armsCache", team: "enemy", by: ["moudjahid"] },
  // A NEW REFUGE (2026-10-07, the tunnels): the FLN digs one near a village it holds, the
  // nearest the post first (algAI.js stepRefuges) — its bands go to ground and come back out of
  // it. Hidden from the French until seen.
  refuge: { label: t("Refuge"), tip: t("Casemate cachée, une seconde base : vos groupes à 30 m s'y renforcent comme à la grotte. Cachée aux Français tant qu'ils ne l'ont pas vue."), cost: 100, time: 45, build: () => refugeGeometry() ?? buildRefuge({ seed: 2001 + Math.floor(Math.random() * 99) }) /* (the Blender piece once loaded — algSangar.js) */, follow: true, structure: "refuge", team: "enemy", by: ["moudjahid"] },
  // THE FLN'S FIELD HOSPITAL (2026-10-13, A3 — algFieldWorks.js): a brush shade, pallets, a stretcher: its
  // wounded within 20 m heal, out of the fight (the French aid station's rule).
  infirmary: { label: t("Infirmerie"), tip: t("Abri de l'infirmier sous les broussailles : vos blessés à 20 m guérissent, hors du combat."), cost: 90, time: 22, build: () => infirmaryGeometry() ?? buildFlnInfirmary({ seed: 1999 + Math.floor(Math.random() * 9) }) /* (the Blender piece once loaded) */, pad: true, structure: "infirmary", team: "enemy", by: ["moudjahid"] },
  ambushScreen: { label: t("Écran d'embuscade"), tip: t("Broussailles coupées sur un pied de pierres : les hommes derrière restent cachés jusqu'à ce qu'ils tirent."), cost: 25, time: 8, build: () => ambushScreenGeometry() ?? buildAmbushScreen() /* (the Blender piece once loaded — algSangar.js) */, follow: true, team: "enemy", by: ["moudjahid"] },
};
/** The medic's tent (nam's kit, the medic variant), with the footprint the build needs. */
function fieldTent() {
  const g = buildTent({ medic: true, blastWall: false, seed: 17 + Math.floor(Math.random() * 9) });
  if (!g.userData.footprint) {
    g.computeBoundingBox();
    const b = g.boundingBox;
    g.userData.footprint = { cx: (b.min.x + b.max.x) / 2, cz: (b.min.z + b.max.z) / 2, hx: (b.max.x - b.min.x) / 2, hz: (b.max.z - b.min.z) / 2 };
  }
  return g;
}
/** Who may raise `key`: his type lists it (the sappers), or the piece names his type. */
export const canBuild = (u, key) => !!(u?.type?.builds?.includes(key) || BUILDS[key]?.by?.includes(u?.typeKey));
/**
 * For the command card: the HUMAN's side's pieces, [{ key, label, tip }] (and { key: cost }).
 * A FUNCTION, asked when the units are made (2026-10-13): as a module constant it was worked out at
 * import, before algGame set the side — playing the FLN, a moudjahid had no build button at all.
 */
export const buildButtons = () => Object.entries(BUILDS).filter(([, b]) => !isHostile(b.team ?? "player")).map(([key, b]) => ({ key, label: b.label, tip: b.tip }));
export const BUILD_COSTS = Object.fromEntries(Object.entries(BUILDS).map(([k, b]) => [k, b.cost]));

const OK = new THREE.Color(0x46e070), BAD = new THREE.Color(0xe4483a);
/** A site's progress bar: the génie's amber, not a health colour. */
const WORK = new THREE.Color(0xe0a93a);
/**
 * How steep a site may be. A pad: the height spread across its footprint, as
 * a slope (0.32 ≈ 18°; the pad levels it — a fixed 2.2 m refused gentle
 * valley ground under a small pit). A `follow` piece: its plane's normal.
 */
const PAD_SLOPE = 0.32, FOLLOW_NY = 0.88;

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.units       the shared units (the sappers)
 * @param {object} o.structures  algStructures (addBuilt)
 * @param {object} o.navGrid
 * @param {object} o.purse       the player's purse ({ spend, canAfford })
 * @param {object} [o.enemyPurse] the ALN's (its pieces: the sangar, the ambush screen)
 * @param {object} [o.enemyPurse] the ALN's (its pieces: sangar, ambush screen)
 * @param {() => void} [o.onCover]  re-bake the cover map (a finished wall)
 * @param {Record<string, THREE.Object3D>} o.showroom  where built pieces are listed (cover, clearing)
 */
export function createAlgBuild({ app, units, structures, navGrid, purse, enemyPurse = null, onCover = () => {}, showroom }) {
  const teamOf = (key) => BUILDS[key]?.team ?? "player";
  const purseOf = (key) => (teamOf(key) === "enemy" ? enemyPurse : purse);
  const dom = app.renderer.domElement;
  const geoCache = new Map();
  // The Blender pieces load in the background: their builder's old geometry until then (the cache forgets it).
  // (the map's own sangars too — the training's FLN ground kept the old one, 2026-10-22)
  loadSangar().then((ok) => { if (ok) { geoCache.delete("sangar"); swapPlaced(showroom, /^sangar\d*$/, sangarGeometry(), app); } });
  // the plants (the screen's scrub): the showroom's PlacedFoliage
  const plants = () => app.showroom?.plants ?? showroom?.plants ?? null;
  loadAmbushScreen().then((ok) => {
    if (!ok) return;
    geoCache.delete("ambushScreen");
    swapPlaced(showroom, /^ambushScreen\d*$/, ambushScreenGeometry(), app);
    for (const [name, mesh] of Object.entries(showroom ?? {})) if (/^ambushScreen\d*$/.test(name)) growScreenPlants(plants(), mesh, 1);
  });
  loadMortarPit().then((ok) => {
    if (!ok) return;
    geoCache.delete("mortarPit");
    swapPlaced(showroom, /^mortarPit\d*$/, mortarPitGeometry(), app);   // (?defences=1: the post's own)
  });
  loadFortPoint().then((ok) => { if (ok) geoCache.delete("fortPoint"); });
  // THE POST in Blender (tools/blender/postKit.py): the placed one swapped, its gate, flag and bags kept
  loadFrenchPost().then((ok) => { if (ok) swapPost(showroom?.frenchPost, app); });
  // THE MOTOR POOL in Blender (algMotorPool.js — far level only in the game): the placed one draws it, its doors
  // following the producer's gate
  loadMotorPool().then((ok) => {
    const m = showroom?.motorPool;
    if (ok && attachMotorPool(m)) app.addPreRenderHook?.(() => m.userData.syncDoors?.());
  });
  loadForwardPost().then((ok) => { if (ok) geoCache.delete("forwardPost"); });
  // (the FLN's: the map's own refuges — algLandmarks refuge1 … — swapped, their scrub grown on the mound)
  loadRefuge().then((ok) => {
    if (!ok) return;
    geoCache.delete("refuge");
    swapPlaced(showroom, /^refuge\d*$/, refugeGeometry(), app);
    for (const [name, mesh] of Object.entries(showroom ?? {})) if (/^refuge\d*$/.test(name)) growScreenPlants(plants(), mesh, 1);
  });
  loadInfirmary().then((ok) => { if (ok) geoCache.delete("infirmary"); });
  // THE FLN'S MARKS in Blender (tools/blender/flnMarks.py, 2026-10-25): the map's lookouts on their spurs, the camp's
  // mine marker — swapped where they stand (their footprints and cover kept)
  loadLookout().then((ok) => { if (ok && swapPlaced(showroom, /^lookout\d*$/, lookoutGeometry(), app)) onCover(); });
  loadMineMarker().then((ok) => { if (ok) swapPlaced(showroom, /^mineMarker\d*$/, mineMarkerGeometry(), app); });
  // THE FARMSTEAD in Blender (tools/blender/farmstead.py, 2026-10-25): the map's farms (their yard props dressed on their
  // spots — algPenProps) and its burnt farm, the model's burnt state
  // THE SAS POST in Blender (tools/blender/sasPost.py, 2026-10-25): swapped where it stands, the old piece's painted
  // boards (its stencil child) removed — the model has its own; the flag stays on its mount
  loadSasPost().then((ok) => {
    if (!ok || !swapPlaced(showroom, /^sasPost$/, sasGeometry(), app)) return;
    const m = showroom.sasPost;
    for (const c of [...m.children]) if (c.material?.name === "RtsStencil" || c.material?.name === "RtsPaint") m.remove(c);
    dressPens(m, sasGeometry().userData.pens);   // (its well: the props kit's — algPenProps)
    onCover();
  });
  const FARM_OLD = typeof location !== "undefined" && new URLSearchParams(location.search).get("farm") === "old";   // (?farm=old: the old kit's, an A/B)
  if (!FARM_OLD) loadFarmstead().then((ok) => {
    if (!ok) return;
    swapPlaced(showroom, /^mechtaFarm(Map)?\d*$/, farmGeometry(), app);
    swapPlaced(showroom, /^burntFarm\d*$/, farmGeometry(), app);
    for (const [name, mesh] of Object.entries(showroom ?? {})) if (/^burntFarm\d*$/.test(name)) setPieceState(mesh, "ruin");
    onCover();
  });
  loadAidStation().then((ok) => { if (ok) geoCache.delete("aidStation"); });
  loadSearchlight().then((ok) => {
    if (!ok) return;
    geoCache.delete("searchlight");
    swapPlaced(showroom, /^searchlight\d*$/, searchlightGeometry(), app);   // (the post's own)
  });
  loadMgNest().then((ok) => {
    if (!ok) return;
    geoCache.delete("mgNest");
    swapPlaced(showroom, /^mgNest\d*$/, mgNestGeometry(), app);   // (?defences=1: the post's own)
  });
  loadBarbedWire().then((ok) => {
    if (!ok) return;
    geoCache.delete("wire");
    swapPlaced(showroom, /^wire\d*$/, barbedWireGeometry(), app);   // (?defences=1: the post's own)
  });
  loadMirador().then((ok) => {
    if (!ok) return;
    geoCache.delete("mirador");
    swapPlaced(showroom, /^mirador\d*$/, miradorGeometry(), app);   // (?defences=1: the post's own)
  });
  loadArmsCache().then((ok) => {
    if (!ok) return;
    geoCache.delete("armsCache");
    // the caches already standing (the showroom's, the landmarks' in the hills): the new piece too
    const n = swapPlaced(showroom, /^armsCache\d*$/, armsCacheGeometry(), app);
    if (n) onCover();
  });
  // THE CAVE'S MOUTH in Blender (mechta.py grotte, 2026-10-28 — the new maps only: MAP.flnKit; ?cave=old keeps the old
  // cave whole): the placed cave's kit shoring swapped, its sandstone rocks and dark kept; its damaged and blown-in
  // models follow its health (algDamage, algStructures — setPieceState). (NOT its hung brush: the straw cards over the
  // lintel read as two trees in front of the mouth from the game's camera, the objective's opening hidden — seen.)
  const CAVE_OLD = typeof location !== "undefined" && new URLSearchParams(location.search).get("cave") === "old";
  if (MAP.flnKit && !CAVE_OLD) loadGrotte().then((ok) => {
    const m = showroom?.caveEntrance;
    if (ok && m && swapPlaced({ caveEntrance: m }, /^caveEntrance$/, grotteGeometry(), app)) onCover();
  });
  const geoOf = (key) => { if (!geoCache.has(key)) geoCache.set(key, BUILDS[key].build()); return geoCache.get(key); };

  // ── The site: footprint samples, validity, the height (and tilt) it stands at ──
  const toWorld = (x, z, yaw, lx, lz) => { const c = Math.cos(yaw), s = Math.sin(yaw); return [x + lx * c + lz * s, z - lx * s + lz * c]; };
  function survey(key, x, z, yaw) {
    const f = geoOf(key).userData.footprint ?? { cx: 0, cz: 0, hx: 2, hz: 2 };
    const pts = [];
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const lx = f.cx + (i / 2) * f.hx, lz = f.cz + (j / 2) * f.hz;
      const [wx, wz] = toWorld(x, z, yaw, lx, lz);
      pts.push({ lx, lz, wx, wz, h: app.getWorldHeight(wx, wz) });
    }
    // Why not (the first reason found): for a tooltip, and for testing.
    let why = null;
    for (const p of pts) {
      if (!(p.wx > PLAY.x0 + 4 && p.wx < PLAY.x1 - 4 && p.wz > PLAY.z0 + 4 && p.wz < PLAY.z1 - 4)) why ??= t("hors de la zone de jeu");
      else if ((app.getWaterLevelAt?.(p.wx, p.wz) ?? -Infinity) > p.h - 0.2) why ??= t("dans l'eau");
      else if (navGrid?.isBlockedAtWorld?.(p.wx, p.wz)) why ??= t("emplacement occupé");
    }
    // FIELD WORKS on a point you hold (`near: "point"`), one of a kind there (`one`).
    const NB = BUILDS[key];
    if (NB?.near === "point" && !why) {
      const pt = (app.algEconomy?.allPoints ?? []).find((v) => v.owner === "player" && Math.hypot(v.position.x - x, v.position.z - z) < (v.radius ?? 40));
      if (!pt) why = t("dans le cercle d'un point que vous tenez");
      else if (NB.one && sites.concat(app.algStructures?.list ?? []).some((s) => s.alive !== false && (s.key === key || s.typeKey === key || s.typeKey === `site:${key}`) && Math.hypot((s.x ?? s.position.x) - pt.position.x, (s.z ?? s.position.z) - pt.position.z) < (pt.radius ?? 40))) why = t("déjà un sur ce point");
    }
    let ok = !why;
    // Plane h = a + b·dx + c·dz over the footprint (symmetric grid: terms separate).
    let sh = 0, sx = 0, sz = 0, sxx = 0, szz = 0, lo = Infinity, hi = -Infinity;
    for (const p of pts) { const dx = p.lx - f.cx, dz = p.lz - f.cz; sh += p.h; sx += dx * p.h; sz += dz * p.h; sxx += dx * dx; szz += dz * dz; lo = Math.min(lo, p.h); hi = Math.max(hi, p.h); }
    const a = sh / pts.length, b = sx / sxx, c = sz / szz;
    const B = BUILDS[key];
    let tilt = null, y = a;
    if (B.follow) {
      const n = new THREE.Vector3(-b, 1, -c).normalize();
      if (n.y < FOLLOW_NY) { ok = false; why ??= t("trop en pente"); }
      // Lowest corner decides: nothing floats, the uphill side sinks a little.
      let dip = 0;
      for (const p of pts) dip = Math.max(dip, a + b * (p.lx - f.cx) + c * (p.lz - f.cz) - p.h);
      y = a - b * f.cx - c * f.cz - dip;
      tilt = n;
    } else if (hi - lo > Math.max(0.6, 2 * Math.max(f.hx, f.hz) * PAD_SLOPE)) { ok = false; why ??= t("trop en pente"); }
    if (ok && B.cost > 0 && !purseOf(key)?.canAfford(B.cost)) { ok = false; why = t("pas assez de ressources"); }
    return { ok, why, y, tilt, f };
  }

  /** A mesh's placement: position, yaw, and (a `follow` piece) the tilt. */
  const up = new THREE.Vector3(0, 1, 0), qYaw = new THREE.Quaternion();
  function seat(mesh, x, y, z, yaw, tilt) {
    mesh.position.set(x, y, z);
    if (tilt) {
      const n = tilt.clone().applyQuaternion(qYaw.setFromAxisAngle(up, yaw));
      mesh.quaternion.setFromUnitVectors(up, n).multiply(qYaw);
    } else mesh.rotation.set(0, yaw, 0);
  }

  // ── Placement: the ghost ─────────────────────────────────────────────────
  let placing = null;   // { key, builders, ghost, mat, yaw, at }
  const ghostMat = () => new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.45, depthWrite: false, fog: false });
  function begin(key, selected) {
    cancel();
    const builders = selected.filter((u) => u?.alive && isHuman(u.team) && canBuild(u, key));
    if (!builders.length || !BUILDS[key]) return;
    const mat = ghostMat();
    // (A new-standard piece — a mortar pit — has its own outline for the ghost: algMortarPit.js.)
    const ghost = new THREE.Mesh(geoOf(key).userData.ghost ?? geoOf(key), mat);
    ghost.visible = false;
    ghost.renderOrder = RENDER_ORDER.ON_GROUND;   // over the fields (40)
    app.scene.add(ghost);
    // Fronts toward the camera at three-quarters (your rule), R turns it.
    placing = { key, builders, ghost, mat, yaw: VIEW_YAW + 0.5, at: null, ok: false };
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerdown", onDown, true);     // capture: before the selection
    dom.addEventListener("contextmenu", onContext, true);  // capture: before the move order
    window.addEventListener("keydown", onKey);
  }
  // RIGHT-CLICK AN UNFINISHED SITE with builders selected (CoH): they go back to work on it.
  function onSiteClick(e) {
    if (placing) return;
    const men = (app.selection?.selected ?? []).filter((u) => u.alive && isHuman(u.team) && !u.isStructure);
    if (!men.length) return;
    const g = app.pickWorldAtClient?.(e.clientX, e.clientY)?.point;
    if (!g) return;
    const s = sites.find((q) => !q.done && q.alive && isHuman(q.team) && Math.hypot(g.x - q.x, g.z - q.z) < Math.max(3, q.reach - 4) && men.some((u) => canBuild(u, q.key)));
    if (!s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    sendTo(s, men.filter((u) => canBuild(u, s.key)));
    app.algOrderMarks?.order?.(s.x, app.getWorldHeight(s.x, s.z), s.z, men, "move");
  }
  dom.addEventListener("contextmenu", onSiteClick, true);
  function cancel() {
    if (!placing) return;
    app.scene.remove(placing.ghost);
    placing.mat.dispose();
    placing = null;
    dom.removeEventListener("pointermove", onMove);
    dom.removeEventListener("pointerdown", onDown, true);
    dom.removeEventListener("contextmenu", onContext, true);
    window.removeEventListener("keydown", onKey);
  }
  let lastClient = null;
  function update(clientX, clientY) {
    if (!placing) return;
    lastClient = [clientX, clientY];
    const hit = app.pickWorldAtClient?.(clientX, clientY);
    if (!hit) { placing.ghost.visible = false; placing.at = null; return; }
    const { x, z } = hit.point;
    const sv = survey(placing.key, x, z, placing.yaw);
    placing.at = { x, z, ...sv };
    placing.ok = sv.ok;
    seat(placing.ghost, x, sv.y + 0.03, z, placing.yaw, sv.tilt);
    placing.mat.color.copy(sv.ok ? OK : BAD);
    placing.ghost.visible = true;
  }
  function onMove(e) { update(e.clientX, e.clientY); }
  function onDown(e) {
    if (!placing || e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!placing.ok || !placing.at) return;          // red: stay in placement
    const { key, builders, yaw } = placing, { x, z } = placing.at;
    commit(key, x, z, yaw, builders);
    if (!e.shiftKey) cancel();
    else if (lastClient) update(...lastClient);
  }
  function onContext(e) { if (!placing) return; e.preventDefault(); e.stopImmediatePropagation(); cancel(); }
  function onKey(e) {
    if (!placing) return;
    if (e.key === "Escape") cancel();
    // e.key, not e.code: an AZERTY R is where the key says it is.
    else if (e.key === "r" || e.key === "R") { placing.yaw += Math.PI / 4; if (lastClient) update(...lastClient); }
  }

  // ── The sites: paid, levelled, blocked, cleared; the sappers walk there ───
  const sites = [];
  let n = 0;
  async function commit(key, x, z, yaw, builders, { stay = false } = {}) {
    const B = BUILDS[key];
    const sv = survey(key, x, z, yaw);
    if (!sv.ok || !purseOf(key)?.spend(B.cost)) return null;
    const f = sv.f;
    const [cx, cz] = toWorld(x, z, yaw, f.cx, f.cz);
    // Block it at once (men route round the site) and clear the plants off it.
    // Wire: NO FOOT (men go round, a vehicle drives over and crushes it — algWire.js).
    const fp = navGrid?.addFootprint?.(cx, cz, f.hx, f.hz, yaw, { noFoot: !!B.noFoot }) ?? null;
    for (let lx = -f.hx; lx <= f.hx + 0.01; lx += 2.5) for (let lz = -f.hz; lz <= f.hz + 0.01; lz += 2.5) {
      const [wx, wz] = toWorld(x, z, yaw, f.cx + lx, f.cz + lz);
      app.clearVegetation?.(wx, wz, 2.4, { grass: 2, edge: 0.5 });
    }
    // …and the PLACED plants on it (the hedges' prickly pears, a lone tree — PlacedFoliage; clearVegetation only
    // clears the painted ones: a mortar pit dug into a hedge kept its cacti inside, 2026-10-21)
    {
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      plants()?.removeWhere((p) => {
        if (p.owner) return false;                    // (a screen's own scrub)
        const dx = p.x - cx, dz = p.z - cz;
        return Math.abs(dx * c - dz * sn) < f.hx + 0.6 && Math.abs(dx * sn + dz * c) < f.hz + 0.6;
      });
    }
    // A field under it is cleared (algFields cutHole): worked soil drawn over
    // the ground hid the foundation (2026-10-03). Wire lies in the crop.
    if (!B.noFoot) app.algFields?.cutHole?.(cx, cz, f.hx, f.hz, yaw);
    // A pad: the ground levelled to the site's mean (the showroom's rule).
    let y = sv.y;
    if (B.pad) await app.flattenRect?.(cx, cz, f.hx + 1.5, f.hz + 1.5, sv.y, { rim: 4, rotY: yaw });
    const mesh = kitView(geoOf(key).clone());
    mesh.name = `built:${key}:${++n}`;
    mesh.userData.kitKey = key;
    mesh.userData.navFootprint = fp;                  // algWire.js takes it off when the wire goes
    seat(mesh, x, y, z, yaw, sv.tilt);
    // CONSTRUCTION: a piece with a build order (the Blender sangar — algSangar.js) shows its parts laid one by
    // one (its site material); the rest are stretched out of the ground as before.
    const build = mesh.geometry.userData.siteMaterial?.() ?? null;
    if (build) { mesh.material = build.material; build.set(0); }
    else mesh.scale.y = 0.06;                         // the foundation, until work starts
    // ITS SIMULATED BAGS (the sandbag wall, the MG nest's ring, the fortified point, the mortar pit — 2026-10-21):
    // laid course by course (a site version of the bag material, `bagT`) on its earth and timbers (algSandbags siteBags).
    const bagSite = siteBags(mesh);
    if (bagSite) { mesh.scale.y = 1; bagSite.set(0); }   // (not stretched: its earth stands, its bags go on — siteBags)
    trackLod(app, mesh);                              // (a Blender piece: its far level past HOUSE_FAR — algSangar.js)
    // ITS LATE PARTS hidden from the start (the mirador's gear and bags, the searchlight's head, the aid station's cross):
    // they were hidden only at the first sapper's work — the mirador's searchlight showed on the bare site, went, and
    // came back at the end (you, 2026-10-26: "appears then disappears then the mirador builds and it appears again")
    for (const c of mesh.children) if (c.userData.late != null) c.visible = false;
    app.scene.add(mesh);
    const site = {
      key, mesh, x: cx, z: cz, reach: Math.hypot(f.hx, f.hz) + 5, progress: 0, done: false, fp, build, bagSite, hx: f.hx, hz: f.hz, yaw,
      // Picked like a structure (the shared selection's buildingRenderer):
      // the command card shows it under construction, with Annuler.
      site: true, isStructure: true, alive: true, team: teamOf(key), constructing: true,
      typeKey: `site:${key}`, name: t("Chantier · {label}", { label: B.label }), position: mesh.position,
      hp: 0, maxHp: 100, selected: false,
      setSelected(on) { this.selected = on; },
      barW: Math.min(8, 3 + Math.max(f.hx, f.hz) * 0.4),
      barY: Math.min(14, (geoOf(key).boundingBox ?? (geoOf(key).computeBoundingBox(), geoOf(key).boundingBox)).max.y + 1.5),
    };
    sites.push(site);
    // `stay`: builders already within reach work where they stand (an ambush
    // band raising its screen must not walk off its spot — algAI.js).
    if (stay) { for (const u of builders) if (u.alive) u.buildSite = site; }
    else sendTo(site, builders);
    return site;
  }
  /**
   * Send builders to a site: each to the nearest open ground at its edge, on his side, ASSIGNED to it
   * (2026-10-20, CoH's rule — you: "are you sure that's how it should behave?"): only the men sent to a
   * site work on it; one ordered elsewhere drops it, one passing by does not pick it up; a right-click on
   * the site sends them back (onSiteClick).
   */
  function sendTo(site, builders) {
    for (const u of builders) {
      if (!u.alive || !canBuild(u, site.key)) continue;
      u.buildSite = site;
      u.buildOrder = (u.moveOrders ?? 0) + 1;   // (this moveOrder's count: a later one sends him away)
      const dx = u.position.x - site.x, dz = u.position.z - site.z, d = Math.hypot(dx, dz) || 1;
      const ex = site.x + (dx / d) * (site.reach - 3.5), ez = site.z + (dz / d) * (site.reach - 3.5);
      const p = navGrid?.nearestOpenWorld?.(ex, ez, true) ?? { x: ex, z: ez };
      u.moveOrder?.(p.x, p.z);
    }
  }

  /**
   * Fixed clock: sappers at a site raise it. A sapper at work is marked
   * (`working`: the site) and faces it — the renderer plays the dig clip, the
   * shovel in his hands (unitRenderer.js).
   */
  const atWork = new Set();
  // Dug, not built: their men only shovel (the rest: hands at the frame, half of them).
  const EARTHWORKS = new Set(["sandbags", "mgNest", "mortarPit", "fortPoint", "sangar", "armsCache", "refuge", "ambushScreen"]);
  /**
   * THE DUST OF THE WORK (2026-10-22, you, CoH 3: "any building animation has a ground smoke"): while men work a
   * site, a card of the baked construction dust (v3/fire-bake-lab "Construction dust" — pooled, algCombat.js) every
   * second or so at a spot over its footprint, faded in, drifting with the wind; three or four overlap into one
   * billowing cloud. A bigger site: more often, bigger cards. Cosmetic — no sim state.
   */
  function dust(s, dt) {
    const shots = app.algBookShots;
    if (!shots?.has("constructionDust") || (s.dustT = (s.dustT ?? 0) - dt) > 0) return;
    const r = Math.max(s.hx, s.hz);
    // (first try: a card every ~1 s, 4.5 m, 0.85 — a thin puff at one corner beside CoH's site-wide cloud)
    s.dustT = Math.min(0.9, Math.max(0.4, 1 - r * 0.06)) * (0.8 + 0.4 * Math.random());
    const [x, z] = toWorld(s.x, s.z, s.yaw ?? 0, (Math.random() * 2 - 1) * s.hx, (Math.random() * 2 - 1) * s.hz);
    shots.play("constructionDust", x, z, { size: Math.min(10, Math.max(6, 5 + r * 0.7)), fadeIn: 0.2, wind: app.algWind?.() });
  }
  function step(dt) {
    atWork.clear();
    // A builder ordered AWAY from his site drops it (his goal far from it): CoH's — he does not come back.
    // (the PLAYER's men only: the AI's bands move about and finish their caches by being near — algAI.js)
    for (const u of units.list) if (u.buildSite && isHuman(u.team) && (!u.alive || u.buildSite.done || !u.buildSite.alive || (u.buildOrder != null && (u.moveOrders ?? 0) > u.buildOrder))) u.buildSite = null;   // (a NEW move order of yours — not combat's chase)
    // A builder that chased a target off his site walks back to it, once the fight is over (CoH's engineers).
    for (const u of units.list) {
      const s = u.buildSite;
      if (!s || !isHuman(u.team) || u.isMoving || u.target?.alive || u.attackTarget?.alive) continue;
      if (Math.hypot(u.position.x - s.x, u.position.z - s.z) < s.reach) continue;
      const now = performance.now();
      if ((u._siteBackT ?? 0) > now) continue;   // (a route asked at most every 2 s: none found, no A* each tick)
      u._siteBackT = now + 2000;
      const dx = u.position.x - s.x, dz = u.position.z - s.z, d = Math.hypot(dx, dz) || 1;
      const p = navGrid?.nearestOpenWorld?.(s.x + (dx / d) * (s.reach - 3.5), s.z + (dz / d) * (s.reach - 3.5), true);
      if (p) u.orderTo(p.x, p.z);
    }
    for (const s of sites) {
      if (s.done) continue;
      let workers = 0;
      for (const u of units.list) {
        if (!u.alive || u.team !== s.team || u.isMoving || !canBuild(u, s.key) || (isHuman(u.team) && u.buildSite !== s)) continue;
        // (under fire he FIGHTS — he dug and shot at once, 2026-10-20 — and goes back to it after)
        if (u.target?.alive || u.attackTarget?.alive) continue;
        if (Math.hypot(u.position.x - s.x, u.position.z - s.z) < s.reach) {
          workers++;
          atWork.add(u);
          if (u.working !== s) {
            u.working = s;
            // FACING THE WORK, turned smoothly (the formation's facing: shared units.js) — a facing left
            // over from a right-drag had them dig with their backs to the site (measured, 2026-10-20)
            u.faceAngle = Math.atan2(s.x - u.position.x, s.z - u.position.z);
            // HANDS OR SHOVEL (2026-10-19, Mixamo "Working On Device"): earthworks are dug; on a
            // structure the men alternate — one at the frame with his hands, the next with the shovel.
            // (counted per site: the order they were met in gave every man the same clip — measured)
            s.crew = (s.crew ?? 0) + 1;
            u.workClip = EARTHWORKS.has(s.key) || s.crew % 2 === 0 ? null : "repair";
          }
        }
      }
      if (!workers) continue;
      // Two sappers 1.5x as fast, three 1.8x: they get in each other's way.
      // (`app.algBuildSpeed`: a doctrine's faster engineers — algDoctrines.js, the Légion.)
      s.progress = Math.min(1, s.progress + (dt / BUILDS[s.key].time) * (1 + 0.8 * (1 - 0.5 ** (workers - 1))) * (s.team === "player" ? app.algBuildSpeed ?? 1 : 1));
      // (a Blender piece with simulated bags — the MG nest — has both: its parts in order AND its bags course by course)
      if (s.build) s.build.set(s.progress);
      if (s.bagSite) s.bagSite.set(s.progress);
      if (!s.build && !s.bagSite) s.mesh.scale.y = 0.06 + 0.94 * s.progress;
      growScreenPlants(plants(), s.mesh, s.progress);   // (a screen's scrub, stood up in its turn)
      for (const c of s.mesh.children) if (c.userData.late != null) c.visible = s.progress >= c.userData.late;   // (the mirador's bags)
      s.hp = s.progress * 100;
      dust(s, dt);
    }
    // (NO HAULING since 2026-10-22 — you: "we do like Company of Heroes": the sappers went to a site carrying a crate
    // at 0.45 of their speed (u.hauling, the renderer's carry walk); CoH's engineers run there at their own pace. The
    // carry walk and its crate stay in unitRenderer.js for something else — villagers carrying things.)
    for (let i = sites.length - 1; i >= 0; i--) if (sites[i].progress >= 1) finish(sites[i]);
    for (const u of units.list) if (u.working && !atWork.has(u) && !u.cutting && !u.repairing) { u.working = null; u.workClip = null; }   // a wire-cutter is algWire.js's, a repairer algRepair.js's
  }
  /** A site stops being a site (finished or cancelled): out of the list and the selection. */
  function retire(s) {
    s.alive = false;
    s.constructing = false;
    const i = sites.indexOf(s);
    if (i >= 0) sites.splice(i, 1);
    if (s.selected) app.selection?.remove?.(s);
    for (const u of units.list) if (u.working === s) u.working = null;
  }
  function finish(s) {
    s.done = true;
    s.mesh.scale.y = 1;
    s.bagSite?.finish();
    if (s.build) { s.mesh.material.dispose(); s.mesh.material = s.mesh.geometry.userData.labMaterial; s.build = null; }
    growScreenPlants(plants(), s.mesh, 1);            // (a screen: all its scrub stands)
    for (const c of s.mesh.children) if (c.userData.late != null) c.visible = true;   // (the shared material: a finished piece costs what it always did)
    retire(s);
    const B = BUILDS[s.key];
    // (its nav footprint with it: a LOW piece's ruin opens it — algStructures wreck)
    if (B.structure) { s.mesh.userData.navFp = s.fp ?? null; structures.addBuilt(B.structure, s.mesh); }
    // A CREW (a mortar pit's two appelés: algMortarPit.js) — idle figures in the soldiers' crowd, no
    // draw of their own; taken away when the piece falls (algStructures wreck).
    const crew = s.mesh.geometry.userData.crew;
    if (crew && app.algUnitRenderer?.addStaticFigures) {
      s.mesh.updateMatrixWorld(true);
      const yaw = s.mesh.rotation.y;
      s.mesh.userData.crewFigures = app.algUnitRenderer.addStaticFigures("appele", crew.map((c) => {
        const p = s.mesh.localToWorld(new THREE.Vector3(c.x, 0, c.z));
        // kneeling at rest by the piece (the mortar crew's own clips: setStaticClip when it fires)
        return { x: p.x, y: app.getWorldHeight(p.x, p.z), z: p.z, yaw: yaw + c.yaw, role: "mortarRest", slot: crew.indexOf(c) };
      }));
    }
    if (showroom) showroom[s.mesh.name] = s.mesh;    // cover lists the placed pieces
    onCover();
  }
  /**
   * Cancel a site: the whole price back (Company of Heroes refunds a cancelled
   * site in full), the foundation gone, the ground open again. The pad's
   * levelling stays — earth moved is earth moved. Freeing the cells rebuilds
   * the nav grid (~70 ms, once, on a click; nam does the same on placing).
   */
  function cancelSite(s) {
    if (!s?.site || !s.alive || s.done) return false;
    retire(s);
    purseOf(s.key)?.earn?.(BUILDS[s.key].cost);
    app.scene.remove(s.mesh);
    dropScreenPlants(plants(), s.mesh);
    untrackLod(s.mesh);
    s.mesh.geometry?.dispose?.();
    if (s.fp?.noFoot) navGrid?.clearNoFootFootprint?.(s.fp);
    else if (s.fp) { navGrid?.removeFootprint?.(s.fp); navGrid?.rebuild?.(); }
    return true;
  }

  // ── Every frame: a progress bar over each site (its own bar field — one draw,
  // none while nothing is being built) ─────────────────────────────────────
  const bars = createHealthBarField({ scene: app.scene, max: 64, height: 0.45, groundAt: (x, z) => app.getWorldHeight(x, z) });
  // An ALN site is the fog's, as the ALN's buildings are (algStructures):
  // unseen until first explored, its bar only while you can see it.
  const fogHides = (s, test) => isHostile(s.team) && app.fogOfWar?.enabled && !app.fogOfWar[test](s.x, s.z);
  const frame = () => {
    bars.begin();
    for (const s of sites) {
      s.mesh.visible = !fogHides(s, "isExplored");
      if (!fogHides(s, "isVisible")) bars.add(s.x, s.position.y + s.barY, s.z, s.barW, s.progress, isHostile(s.team), app.camera, isHostile(s.team) ? null : WORK);
    }
    bars.commit();
  };
  app.addPreRenderHook?.(frame);

  /** For the shared selection (its buildingRenderer): a click on a site's foundation picks it. */
  const renderer = {
    get roots() { return sites.map((s) => s.mesh); },
    buildingFromHit(h) {
      for (let o = h.object; o; o = o.parent) {
        const s = sites.find((q) => q.mesh === o);
        if (s) return s.alive ? s : null;
      }
      return null;
    },
  };

  return {
    begin, cancel, step, sites, cancelSite, renderer,
    get placing() { return !!placing; },
    /** Why the ghost is red (null when green). */
    get why() { return placing?.at?.why ?? null; },
    survey,
    /**
     * Place without the ghost (an AI, a test): the same checks, the same cost
     * (from the piece's own side's purse). The ALN's AI raises a sangar or an
     * ambush screen with this: place("sangar", x, z, yaw, [moudjahidine]).
     * Resolves to the site (null: refused — survey(key, x, z, yaw).why says why).
     */
    place: (key, x, z, yaw, builders, opts) => commit(key, x, z, yaw, builders, opts),
    /** A piece's price (BUILDS). */
    costOf: (key) => BUILDS[key]?.cost ?? 0,
  };
}
