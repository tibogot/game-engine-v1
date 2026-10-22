// DROPPED WEAPONS (2026-10-10, the CoH gaps; the CoH way since 2026-10-22 — you: "picking the weapon of a dead
// soldier … that's how CoH works?"). A special weapon outlives the man who carried it:
//   WHAT DROPS  the FM, the bazooka, the flamethrower (algSquads CARRIED: their weapon, the piece in hand). An FM
//               team's gunner drops his FM; a squad's UPGRADE weapon (the section's FM, the faoudj's bazooka) and the
//               flamethrower team's lance only when the whole squad is wiped out (until then the squad keeps its
//               slot: the replacement takes it up); a man who PICKED one UP drops it where he falls.
//   YOURS       picked up by an ORDER: your men selected, a RIGHT-CLICK on the weapon (the cursor is the hand over
//               it, a brass ring marks it on the ground) — the nearest man able to walks over and takes it. A new
//               order on the way calls him off.
//   THE AI'S    its men pick up what they pass within `notice` m, not in a fight (CoH's AI does).
//   WHO         a man of an infantry squad (algSquads PICKERS), not one carrying already, at most CARRY_PER_SQUAD a
//               squad. The French section's FM goes in as the squad's FM UPGRADE if it has none (it is kept and
//               replaced as the bought one); anything else he CARRIES (u.carried — algSquads applyKit).
//   TEAMS       a mortar or the recoilless whose whole team fell stays too (algSquads TEAM_WEAPONS); a squad's
//               right-click (the AI's: passing by) sends it, and crew (that many) of its men become that weapon's TEAM — their
//               own uniforms, the weapon as itself (the FLN's 60 mm in French hands fires the 60 mm); never
//               reinforced (nobody of that kind at the post). Men carrying a picked weapon stay in their squad.
// A weapon lies 4 minutes, then it is gone (taken by someone off the map). DRAWN: one InstancedMesh a weapon
// (procWeapons.js), lying on its side, made empty at load (the warm-up builds its programs); only what the human
// can see.
import * as THREE from "three";
import { WEAPONS, weaponMaterial } from "../shared-rts/procWeapons.js";
import { CARRIED, CARRY_PER_SQUAD, PICKERS, TEAM_WEAPONS, UPGRADES } from "./algSquads.js";
import { KIT } from "../shared-rts/soldierLooks.js";
import { RTS_SCALE } from "./algUnitTypes.js";
import { t } from "./i18n/i18n.js";
import { isHuman } from "../shared-rts/teams.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

const P = {
  max: 12,
  look: 1.25,       // drawn a quarter bigger than in a man's hands: brown on brown ground, it got lost
  life: 240,        // s on the ground
  notice: 6,        // m: the AI's passer-by this close goes for it
  take: 1.8,        // m: in his hands
  click: 2.6,       // m: a right-click this near a weapon is "take it"
};
/** The weapon a dead man leaves, if any (his kit, his squad's slot — see the head). */
function droppedBy(e) {
  if (e.carried) return e.carried;
  if (e.typeKey === "fmTeam" && e.weapon === "mg") return "fm";
  const s = e.squad;
  if (!s || s.members.length) return null;   // (the squad lives: its slot keeps the weapon)
  if (s.typeKey === "piece" && s.slots[0] === e) return "fm";
  if (s.typeKey === "lanceFlammes" && s.slots[0] === e) return "flamer";
  if (s.upgrades?.lmg && s.slots[UPGRADES.lmg.slot] === e) return "fm";
  if (s.upgrades?.bazooka && s.slots[UPGRADES.bazooka.slot] === e) return "bazooka";
  return null;
}

export function createAlgDroppedWeapons(app, { units, squads, fogOfWar = null }) {
  const items = [];   // { key, x, z, y, yaw, t, claim, ordered }
  const meshes = {};
  for (const [key, C] of Object.entries(CARRIED)) {
    const m = new THREE.InstancedMesh(WEAPONS[C.prop].buildRaw(), weaponMaterial(), P.max);
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = true;
    m.name = `droppedWeapons:${key}`;
    app.scene.add(m);
    meshes[key] = m;
  }
  // the TEAM weapons: the mortar tube (the carried piece, laid flat), the recoilless
  for (const [k, T] of Object.entries(TEAM_WEAPONS)) {
    const g = T.model === "mortarTube" ? KIT.mortarTube.build() : WEAPONS[T.model].buildRaw();
    g.computeBoundingBox(); const c = g.boundingBox.getCenter(new THREE.Vector3()); g.translate(-c.x, -c.y, -c.z);
    const m = new THREE.InstancedMesh(g, weaponMaterial(), 4);
    m.count = 0; m.frustumCulled = false; m.castShadow = true; m.name = `droppedWeapons:team:${k}`;
    app.scene.add(m);
    meshes[`team:${k}`] = m;
  }
  const teamOf = (it) => (it.key.startsWith("team:") ? it.key.slice(5) : null);
  const labelOf = (it) => (teamOf(it) ? TEAM_WEAPONS[teamOf(it)].label : CARRIED[it.key].label);
  // (the brass ring under each one you can see: a dropped gun is small and brown on brown ground)
  const rings = createSelectionRingField({ app, max: P.max, inner: 0.82, segments: 32, opacity: 0.75 });
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _p = new THREE.Vector3(), _s = new THREE.Vector3().setScalar(RTS_SCALE * P.look);
  let told = false;

  function drop(x, z, yaw = Math.random() * Math.PI * 2, key = "fm") {
    if (!CARRIED[key] && !TEAM_WEAPONS[key.slice(5)]) return;
    if (items.length >= P.max) items.splice(items.findIndex((it) => !it.claim), 1);
    items.push({ key, x, z, y: app.getWorldHeight?.(x, z) ?? 0, yaw, t: 0, claim: null, ordered: false });
  }

  /** A unit died (algUnits combat onDeath): does a weapon stay on the ground? */
  function onDeath(e) {
    if (e.isStructure || !e.type?.foot) return;
    const key = droppedBy(e);
    if (key) drop(e.position.x + 0.6, e.position.z + 0.3, (e.heading ?? 0) + 1.2, key);
    // the last of a TEAM: its weapon stays
    const s = e.squad;
    if (s && TEAM_WEAPONS[s.typeKey] && !s.members.length) drop(e.position.x - 0.5, e.position.z + 0.6, (e.heading ?? 0) + 0.4, `team:${s.typeKey}`);
  }

  const near = (u, it, r) => Math.abs(u.position.x - it.x) < r && Math.abs(u.position.z - it.z) < r && Math.hypot(u.position.x - it.x, u.position.z - it.z) < r;
  const carriedIn = (s) => s.members.filter((m) => m.carried).length;
  /** Can `u` take `it`? (a man of an infantry squad, free hands, room in his squad) */
  const freeMen = (s) => s.members.filter((m) => !m.carried);
  function canTake(u, it) {
    if (!u.alive || !u.type?.foot || u.inside || u.garrison || u.carrier || u.carried) return false;
    const s = u.squad;
    if (!s || !PICKERS.has(s.typeKey) || s.retreating) return false;
    if (teamOf(it)) return freeMen(s).length >= 2;   // (a team of two at least: the gun and a loader)
    // (the section's own FM slot taken: a second FM is carried like anything else)
    if (it.key === "fm" && UPGRADES.lmg.squads.includes(s.typeKey) && !s.upgrades.lmg) return true;
    if (s.upgrades?.bazooka && s.slots[UPGRADES.bazooka.slot] === u) return false;   // (his own tube already)
    return carriedIn(s) < CARRY_PER_SQUAD;
  }
  function take(u, it) {
    const s = u.squad;
    if (teamOf(it)) return recrew(s, it);
    if (it.key === "fm" && s && UPGRADES.lmg.squads.includes(s.typeKey) && !s.upgrades.lmg) s.upgrades.lmg = true;
    else u.carried = it.key;
    u.playOnce = "plant";   // (he stoops for it)
    if (isHuman(u.team)) app.algBattle?.say?.(t("{w} ramassé.", { w: CARRIED[it.key].label }), u.position.x, u.position.z, "good");
  }
  /** crew (that many) of squad s's free men (the nearest) become the weapon's team; the others stay where they are. */
  function recrew(s, it) {
    const key = teamOf(it), T = TEAM_WEAPONS[key];
    const d = (m) => Math.hypot(m.position.x - it.x, m.position.z - it.z);
    const men = freeMen(s).sort((a, b) => d(a) - d(b)).slice(0, T.crew);
    for (const m of men) squads.leave(m);
    const ns = squads.create(key, s.team);
    ns.captured = true;
    men.forEach((m, k) => { squads.join(ns, m, k); m.playOnce = "plant"; });
    if (isHuman(s.team)) {
      app.algBattle?.say?.(t("{w} : vos hommes le servent.", { w: T.label }), it.x, it.z, "good");
      if ((app.selection?.selected ?? []).some((u) => men.includes(u))) app.selection.select(men);
    }
  }

  /** Who takes `it` now — the man who has reached it — or (the AI's) sends the nearest passer-by to it. */
  function step(dt) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.t += dt;
      if (it.t > P.life) { items.splice(i, 1); continue; }
      const c = it.claim;
      if (c) {
        // Called off: dead, can't any more, or (yours) given another order on the way; (the AI's) in a fight.
        const g = c.goalPoint, away = it.ordered && !!g && Math.hypot(g.x - it.x, g.z - it.z) > P.click + 1;
        if (!canTake(c, it) || away || (!it.ordered && (c.target || !near(c, it, P.notice * 1.5)))) it.claim = null;
        else if (near(c, it, P.take)) { take(c, it); items.splice(i, 1); continue; }
        else if (!c.isMoving) c.moveOrder(it.x, it.z);   // (stopped short: on to it)
        continue;
      }
      let best = null, bd = P.notice;
      for (const u of units.list) {
        if (isHuman(u.team) || u.target || !canTake(u, it)) continue;
        const d = Math.hypot(u.position.x - it.x, u.position.z - it.z);
        if (d < bd) { bd = d; best = u; }
      }
      if (best) { it.claim = best; it.ordered = false; best.orderTo(it.x, it.z); }
    }
  }

  // ── YOURS: a right-click on a weapon, men selected ────────────────────────
  const dom = app.renderer.domElement;
  const yours = () => (app.selection?.selected ?? []).filter((u) => u.alive && isHuman(u.team) && u.type?.foot);
  /** The weapon under the cursor that one of the selected men could take, or null. */
  function itemAt(clientX, clientY) {
    if (!items.length) return null;
    const men = yours();
    if (!men.length) return null;
    const hit = app.pickWorldAtClient?.(clientX, clientY);
    if (!hit?.point) return null;
    let best = null, bd = P.click;
    for (const it of items) {
      if (fogOfWar?.enabled && !fogOfWar.isVisible(it.x, it.z)) continue;
      const d = Math.hypot(hit.point.x - it.x, hit.point.z - it.z);
      if (d < bd && men.some((u) => canTake(u, it))) { bd = d; best = it; }
    }
    return best;
  }
  const onContext = (e) => {
    if (e.target !== dom || dom.style.cursor) return;   // (a targeting mode owns the click)
    const it = itemAt(e.clientX, e.clientY);
    if (!it) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const men = yours().filter((u) => canTake(u, it));
    const u = men.reduce((b, m) => (Math.hypot(m.position.x - it.x, m.position.z - it.z) < Math.hypot(b.position.x - it.x, b.position.z - it.z) ? m : b));
    it.claim = u; it.ordered = true;
    u.moveOrder(it.x, it.z);
    u.playerMove = true;
    // (a team weapon: his squad goes with him, round it)
    if (teamOf(it)) freeMen(u.squad).filter((m) => m !== u).forEach((m, k) => { const a = (k / 3) * Math.PI * 2; m.moveOrder(it.x + Math.cos(a) * 2, it.z + Math.sin(a) * 2); m.playerMove = true; });
    app.algSounds?.order?.("move", [u]);
  };
  // The HAND over a weapon you can take (ui/cursors.js canvas.alg-pickup)
  let hoverT = 0, hover = false;
  const onMove = (e) => {
    const now = performance.now();
    if (now - hoverT < 90) return;
    hoverT = now;
    const on = e.target === dom && !dom.style.cursor && !!itemAt(e.clientX, e.clientY);
    if (on !== hover) { hover = on; dom.classList.toggle("alg-pickup", on); }
  };
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("pointermove", onMove);

  /** Each frame: the weapons the human can see, and their rings. */
  function frame() {
    const n = {};
    for (const k in meshes) n[k] = 0;
    rings.begin();
    for (const it of items) {
      if (fogOfWar?.enabled && !fogOfWar.isVisible(it.x, it.z)) continue;
      // The first one the human sees: say what it is for.
      if (!told && it.t > 0.5) { told = true; app.algBattle?.say?.(t("Une <b>arme</b> est restée au sol (cerclée) : sélectionnez des hommes et faites un <b>clic droit</b> dessus pour la ramasser."), it.x, it.z, "", null); }
      _e.set(0, it.yaw, teamOf(it) === "mortier" || teamOf(it) === "mortierFr" ? 0 : Math.PI / 2);
      _q.setFromEuler(_e);
      _p.set(it.x, it.y + 0.06, it.z);
      meshes[it.key].setMatrixAt(n[it.key]++, _m.compose(_p, _q, _s));
      rings.add(it.x, it.z, 1.1, it.claim ? 0x58e070 : 0xc9a54a);
    }
    rings.commit();
    for (const k in meshes) { meshes[k].count = n[k]; meshes[k].visible = n[k] > 0; meshes[k].instanceMatrix.needsUpdate = n[k] > 0; }
  }

  return {
    params: P, items, drop, onDeath, step, frame,
    dispose() {
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      for (const m of Object.values(meshes)) { app.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    },
  };
}
