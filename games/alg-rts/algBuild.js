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
import { buildAmbushScreen, buildArmsCache, buildBarbedWire, buildRefuge, buildFrSandbagWall, buildMgNest, buildMirador, buildMortarPit, buildSangar, buildSearchlightTower } from "../../v3/render/objects/rtsAlgeria.js";
import { createHealthBarField } from "../shared-rts/healthBar.js";
import { kitView } from "./showroom.js";
import { PLAY, VIEW_YAW } from "./layout.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";

/**
 * What a sapper can build. `pad`: stands on levelled ground (the mirador, the
 * pits); `follow`: lies ON the slope like real bags and wire. `time`: seconds
 * for one sapper. `structure`: its combat stats' key (algStructures.js STATS).
 */
export const BUILDS = {
  sandbags: { label: "Sacs de sable", tip: "Mur de sacs de sable : une couverture solide pour les hommes derrière.", cost: 20, time: 6, build: () => buildFrSandbagWall(), follow: true },
  wire: { label: "Barbelés", tip: "Barbelés : il faut les contourner ou les couper ; un véhicule les écrase.", cost: 15, time: 5, build: () => buildBarbedWire(), follow: true, noFoot: true },
  mgNest: { label: "Nid de MG", tip: "Nid de mitrailleuse : une AA-52 derrière des sacs de sable.", cost: 90, time: 14, build: () => buildMgNest(), pad: true, structure: "mgNest" },
  mortarPit: { label: "Mortier", tip: "Fosse de mortier de 81 : tire de 25 à 120 m, par-dessus les abris.", cost: 130, time: 18, build: () => buildMortarPit(), pad: true, structure: "mortarPit" },
  mirador: { label: "Mirador", tip: "Mirador : voit à 110 m, une mitrailleuse dans la cabine.", cost: 110, time: 20, build: () => buildMirador(), pad: true, structure: "mirador" },
  searchlight: { label: "Projecteur", tip: "Tour de projecteur : voit à 100 m.", cost: 60, time: 10, build: () => buildSearchlightTower(), pad: true, structure: "searchlight" },
  // THE ALN BUILDS TOO (you, 2026-09-30): the same sites, paid from the ALN's
  // purse, raised by moudjahidine (`by`: no command card of theirs to list
  // them — the AI places them through place()). Both lie on the slope, as
  // the showroom's do.
  sangar: { label: "Sangar", tip: "Dry-stone firing position, an FM over its lip.", cost: 60, time: 16, build: () => buildSangar(), follow: true, structure: "sangar", team: "enemy", by: ["moudjahid"] },
  // A NEW ARMS CACHE (2026-10-02): the FLN hides one in a village it holds
  // when the French have found theirs (algAI.js) — each standing cache arms
  // two FM teams. Hidden from the French until seen, built or not.
  armsCache: { label: "Cache d'armes", tip: "Arms cache: arms two FM teams.", cost: 120, time: 40, build: () => buildArmsCache({ seed: 1958 + Math.floor(Math.random() * 99) }), follow: true, structure: "armsCache", team: "enemy", by: ["moudjahid"] },
  // A NEW REFUGE (2026-10-07, the tunnels): the FLN digs one near a village it holds, the
  // nearest the post first (algAI.js stepRefuges) — its bands go to ground and come back out of
  // it. Hidden from the French until seen.
  refuge: { label: "Refuge", tip: "A hidden casemate: bands go to ground in it and come back out.", cost: 100, time: 45, build: () => buildRefuge({ seed: 2001 + Math.floor(Math.random() * 99) }), follow: true, structure: "refuge", team: "enemy", by: ["moudjahid"] },
  ambushScreen: { label: "Écran d'embuscade", tip: "Cut scrub on a stone footing: men behind it are hidden until they fire.", cost: 25, time: 8, build: () => buildAmbushScreen(), follow: true, team: "enemy", by: ["moudjahid"] },
};
/** Who may raise `key`: his type lists it (the sappers), or the piece names his type. */
export const canBuild = (u, key) => !!(u?.type?.builds?.includes(key) || BUILDS[key]?.by?.includes(u?.typeKey));
/** For the command card (the French: the ALN's pieces are the AI's): [{ key, label, tip }] and { key: cost }. */
export const BUILD_BUTTONS = Object.entries(BUILDS).filter(([, b]) => b.team !== "enemy").map(([key, b]) => ({ key, label: b.label, tip: b.tip }));
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
      if (!(p.wx > PLAY.x0 + 4 && p.wx < PLAY.x1 - 4 && p.wz > PLAY.z0 + 4 && p.wz < PLAY.z1 - 4)) why ??= "hors de la zone de jeu";
      else if ((app.getWaterLevelAt?.(p.wx, p.wz) ?? -Infinity) > p.h - 0.2) why ??= "dans l'eau";
      else if (navGrid?.isBlockedAtWorld?.(p.wx, p.wz)) why ??= "emplacement occupé";
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
      if (n.y < FOLLOW_NY) { ok = false; why ??= "trop en pente"; }
      // Lowest corner decides: nothing floats, the uphill side sinks a little.
      let dip = 0;
      for (const p of pts) dip = Math.max(dip, a + b * (p.lx - f.cx) + c * (p.lz - f.cz) - p.h);
      y = a - b * f.cx - c * f.cz - dip;
      tilt = n;
    } else if (hi - lo > Math.max(0.6, 2 * Math.max(f.hx, f.hz) * PAD_SLOPE)) { ok = false; why ??= "trop en pente"; }
    if (ok && B.cost > 0 && !purseOf(key)?.canAfford(B.cost)) { ok = false; why = "pas assez de ressources"; }
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
    const builders = selected.filter((u) => u?.alive && u.team === "player" && canBuild(u, key));
    if (!builders.length || !BUILDS[key]) return;
    const mat = ghostMat();
    const ghost = new THREE.Mesh(geoOf(key), mat);
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
    mesh.scale.y = 0.06;                              // the foundation, until work starts
    app.scene.add(mesh);
    const site = {
      key, mesh, x: cx, z: cz, reach: Math.hypot(f.hx, f.hz) + 5, progress: 0, done: false, fp,
      // Picked like a structure (the shared selection's buildingRenderer):
      // the command card shows it under construction, with Annuler.
      site: true, isStructure: true, alive: true, team: teamOf(key), constructing: true,
      typeKey: `site:${key}`, name: `Chantier · ${B.label}`, position: mesh.position,
      hp: 0, maxHp: 100, selected: false,
      setSelected(on) { this.selected = on; },
      barW: Math.min(8, 3 + Math.max(f.hx, f.hz) * 0.4),
      barY: Math.min(14, (geoOf(key).boundingBox ?? (geoOf(key).computeBoundingBox(), geoOf(key).boundingBox)).max.y + 1.5),
    };
    sites.push(site);
    // Each sapper to the nearest open ground at the site's edge, on his side.
    // `stay`: builders already within reach work where they stand (an ambush
    // band raising its screen must not walk off its spot — algAI.js).
    for (const u of stay ? [] : builders) {
      if (!u.alive) continue;
      const dx = u.position.x - cx, dz = u.position.z - cz, d = Math.hypot(dx, dz) || 1;
      const ex = cx + (dx / d) * (site.reach - 3.5), ez = cz + (dz / d) * (site.reach - 3.5);
      const p = navGrid?.nearestOpenWorld?.(ex, ez, true) ?? { x: ex, z: ez };
      u.moveOrder?.(p.x, p.z);
    }
    return site;
  }

  /**
   * Fixed clock: sappers at a site raise it. A sapper at work is marked
   * (`working`: the site) and faces it — the renderer plays the dig clip, the
   * shovel in his hands (unitRenderer.js).
   */
  const atWork = new Set();
  function step(dt) {
    atWork.clear();
    for (const s of sites) {
      if (s.done) continue;
      let workers = 0;
      for (const u of units.list) {
        if (!u.alive || u.team !== s.team || u.isMoving || !canBuild(u, s.key)) continue;
        if (Math.hypot(u.position.x - s.x, u.position.z - s.z) < s.reach) {
          workers++;
          atWork.add(u);
          if (u.working !== s) { u.working = s; u.faceToward?.(s.x, s.z); }
        }
      }
      if (!workers) continue;
      // Two sappers 1.5x as fast, three 1.8x: they get in each other's way.
      s.progress = Math.min(1, s.progress + (dt / BUILDS[s.key].time) * (1 + 0.8 * (1 - 0.5 ** (workers - 1))));
      s.mesh.scale.y = 0.06 + 0.94 * s.progress;
      s.hp = s.progress * 100;
    }
    for (let i = sites.length - 1; i >= 0; i--) if (sites[i].progress >= 1) finish(sites[i]);
    for (const u of units.list) if (u.working && !atWork.has(u) && !u.cutting && !u.repairing) u.working = null;   // a wire-cutter is algWire.js's, a repairer algRepair.js's
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
    retire(s);
    const B = BUILDS[s.key];
    if (B.structure) structures.addBuilt(B.structure, s.mesh);
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
  const fogHides = (s, test) => s.team === "enemy" && app.fogOfWar?.enabled && !app.fogOfWar[test](s.x, s.z);
  const frame = () => {
    bars.begin();
    for (const s of sites) {
      s.mesh.visible = !fogHides(s, "isExplored");
      if (!fogHides(s, "isVisible")) bars.add(s.x, s.position.y + s.barY, s.z, s.barW, s.progress, s.team === "enemy", app.camera, s.team === "enemy" ? null : WORK);
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
