// DROPPED WEAPONS (2026-10-10, the CoH gaps): a machine gun outlives its gunner. An FLN FM gunner
// killed leaves his FM 24/29 where he fell; a French FM is left only when its whole squad is wiped
// out (until then the squad keeps its slot: the replacement takes it up, algSquads.js). Whoever
// comes by picks it up:
//   FRENCH   a section without an FM (appelés, Légion, paras: UPGRADES.lmg) passing within 6 m —
//            its nearest man walks over, and the squad has the FM upgrade, free;
//   FLN      a fighter passing within 6 m (not already a gunner) — he becomes an FM gunner.
// Not in a fight (a man with a target stays on it). A gun lies 4 minutes, then it is gone (taken by
// someone off the map). DRAWN: one InstancedMesh of the FM's geometry (procWeapons.js), lying on
// its side, made empty at load (the warm-up builds its program); only the ones the human can see.
import * as THREE from "three";
import { WEAPONS, weaponMaterial } from "../shared-rts/procWeapons.js";
import { UPGRADES } from "./algSquads.js";
import { RTS_SCALE } from "./algUnitTypes.js";
import { t } from "./i18n/i18n.js";
import { isHuman } from "../shared-rts/teams.js";

const P = {
  max: 12,
  look: 1.25,       // drawn a quarter bigger than in a man's hands: brown on brown ground, it got lost
  life: 240,        // s on the ground
  notice: 6,        // m: a passer-by this close goes for it
  take: 1.8,        // m: in his hands
  fmGunner: { weapon: "mg", range: 42, damage: 5, fireRate: 4.5 },   // an FLN man with it (as the French FM upgrade)
};

export function createAlgDroppedWeapons(app, { units, squads, fogOfWar = null }) {
  const items = [];   // { x, z, y, yaw, t, claim }
  const mesh = new THREE.InstancedMesh(WEAPONS.fm2429.buildRaw(), weaponMaterial(), P.max);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.name = "droppedWeapons";
  app.scene.add(mesh);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, "YXZ"), _p = new THREE.Vector3(), _s = new THREE.Vector3().setScalar(RTS_SCALE * P.look);
  let dirty = false, told = false;

  function drop(x, z, yaw = Math.random() * Math.PI * 2) {
    if (items.length >= P.max) items.shift();
    items.push({ x, z, y: app.getWorldHeight?.(x, z) ?? 0, yaw, t: 0, claim: null });
    dirty = true;
  }

  /** A unit died (algUnits combat onDeath): does a gun stay on the ground? */
  function onDeath(e) {
    if (e.isStructure || !e.type?.foot) return;
    let gun = e.typeKey === "fmTeam" || e.fmPicked;
    const s = e.squad;
    if (!gun && s && s.members.length === 0) gun = (s.typeKey === "piece" && s.slots[0] === e) || (s.upgrades?.lmg && s.slots[UPGRADES.lmg.slot] === e);
    if (gun) drop(e.position.x + 0.6, e.position.z + 0.3, (e.heading ?? 0) + 1.2);
  }

  const near = (u, it, r) => Math.abs(u.position.x - it.x) < r && Math.abs(u.position.z - it.z) < r && Math.hypot(u.position.x - it.x, u.position.z - it.z) < r;
  const lmgSquads = new Set(UPGRADES.lmg.squads);
  /** Who takes `it` now — the man who has reached it — or sends the nearest passer-by to it. */
  function step(dt) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.t += dt;
      if (it.t > P.life) { items.splice(i, 1); dirty = true; continue; }
      // The claimant there: it is his.
      const c = it.claim;
      if (c && (!c.alive || c.target || !near(c, it, P.notice * 1.5))) it.claim = null;
      else if (c && near(c, it, P.take)) {
        if (c.team === "player") { const s = c.squad; if (s && !s.upgrades.lmg) s.upgrades.lmg = true; }
        else { Object.assign(c, P.fmGunner); c.fmPicked = true; }
        items.splice(i, 1); dirty = true;
        continue;
      }
      if (it.claim) continue;
      let best = null, bd = P.notice;
      for (const u of units.list) {
        if (!u.alive || !u.type?.foot || u.target || u.inside || u.garrison || u.carrier) continue;
        if (u.team === "player") { const s = u.squad; if (!s || !lmgSquads.has(s.typeKey) || s.upgrades.lmg || s.retreating) continue; }
        else if (u.team === "enemy") { if (u.typeKey !== "moudjahid" || u.fmPicked || u.holdFire) continue; }
        else continue;
        const d = Math.hypot(u.position.x - it.x, u.position.z - it.z);
        if (d < bd) { bd = d; best = u; }
      }
      if (best) { it.claim = best; best.orderTo(it.x, it.z); }
    }
  }

  /** Each frame: the guns the human can see. */
  function frame() {
    let n = 0;
    for (const it of items) {
      if (fogOfWar?.enabled && !fogOfWar.isVisible(it.x, it.z)) continue;
      // The first one the human sees: say what it is for.
      if (!told && it.t > 0.5) { told = true; app.algBattle?.say?.(isHuman("enemy") ? t("Un <b>FM</b> est resté au sol : un combattant qui passe à moins de 6 m le ramasse.") : t("Un <b>FM</b> est resté au sol : un groupe sans FM qui passe à moins de 6 m le ramasse."), it.x, it.z, "", null); }
      _e.set(0, it.yaw, Math.PI / 2);
      _q.setFromEuler(_e);
      _p.set(it.x, it.y + 0.06, it.z);
      mesh.setMatrixAt(n++, _m.compose(_p, _q, _s));
    }
    if (n !== mesh.count || dirty || n) { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; dirty = false; }
  }

  return { params: P, items, drop, onDeath, step, frame, dispose() { app.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); } };
}
