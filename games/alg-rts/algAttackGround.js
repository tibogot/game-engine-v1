// ATTACK GROUND (2026-10-22, CoH's — you: "do 1 and 2 together"): fire on a SPOT, not on a man — a suspected position,
// a wood's edge, the house the shots came from. The FLN fights hidden; this is how you make it keep its head down.
//
//   WHO        machine guns and cannons (an FM team, the 12.7, the half-track, the AMX, the jeep's MG, the MG nest, the
//              mirador), and the MORTAR TEAMS. Not riflemen (CoH's neither).
//   THE ORDER  the button (⇧G) or its hotkey, then a left-click on the ground (right-click / Esc: cancel; Shift keeps
//              the aim for another). The ring under the cursor: green in reach (a mortar's, a structure's), amber
//              where they must first close in (a unit walks or drives up to its range).
//   WHAT       a gun fires its rounds into the spot (shared combat.js groundFire: tracers, dirt, SUPPRESSION on the
//              enemy men hidden within 5 m — no man hit by name); a mortar team lays its rounds there, free, a few
//              metres apart (algMortarTeam.js) — the damage is the mortar's. Until another order (units.js clears it).
//   SHOWN      an orange ring on each spot your selected units are firing on.
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { queuedPoints } from "../shared-rts/orderQueue.js";
import { isHuman } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

const MORTARS = new Set(["mortier", "mortierFr"]);
const SPOT_R = 5;   // the ring (and combat's GROUND_R: the men suppressed round the spot)

export function createAlgAttackGround(app, { selection, squads, mortarTeams = null }) {
  const dom = app.renderer.domElement;
  const rings = createSelectionRingField({ app, max: 48, inner: 0.9, opacity: 0.8 });
  let targeting = null;   // { men, at }

  const mortarOf = (u) => { const s = squads.of(u); return s && MORTARS.has(s.typeKey) ? s : null; };
  const gun = (u) => u.range > 0 && (u.weapon === "mg" || u.weapon === "cannon") && !u.isAir;
  const able = (u) => u?.alive && isHuman(u.team) && (gun(u) || !!mortarOf(u));
  /** Can `u` reach (x, z) from where it stands? (a unit that moves can always close in) */
  function inReach(u, x, z) {
    const d = Math.hypot(x - u.position.x, z - u.position.z), s = mortarOf(u);
    if (s) { const r = mortarTeams?.reachOf?.(s); return !r || (d >= r.min && d <= r.max); }
    return !u.isStructure || d <= u.range;
  }

  function begin(sel = selection.selected) {
    const men = (sel ?? []).filter(able);
    if (!men.length) return false;
    targeting = { men, at: null };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; if (dom.style.cursor === "crosshair") dom.style.cursor = ""; }

  const aim = (e) => { const h = app.pickWorldAtClient?.(e.clientX, e.clientY); if (targeting) targeting.at = h?.point ? { x: h.point.x, y: h.point.y, z: h.point.z } : null; };
  const onMove = (e) => { if (targeting) aim(e); };
  const onDown = (e) => {
    if (!targeting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) { cancel(); return; }
    aim(e);
    const { men, at } = targeting;
    if (!e.shiftKey) cancel();
    if (!at) return;
    // a mortar out of its reach can't (it does not walk with its tube up): told, the others fire
    const ok = men.filter((u) => u.alive && (!mortarOf(u) || inReach(u, at.x, at.z)));
    if (ok.length < men.length) app.algBattle?.say?.(t("Mortier <b>hors de portée</b> de ce point : rapprochez-le d'abord."), at.x, at.z, "bad");
    for (const u of ok) { u.attackTarget = null; u.target = null; u.holdFire = false; u.groundAt = { x: at.x, y: at.y, z: at.z }; }
    if (ok.length) app.algSounds?.order?.("attack", ok);
  };
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  const onKey = (e) => { if (e.key === "Escape" && targeting) cancel(); };
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKey);

  /** Each frame: the aim ring, and the spots your selected units fire on. */
  function frame() {
    rings.begin();
    if (targeting?.at) {
      const { men, at } = targeting;
      rings.add(at.x, at.z, SPOT_R, men.every((u) => inReach(u, at.x, at.z)) ? 0x58e070 : 0xffb020);
    }
    const seen = [];
    for (const u of selection.selected ?? []) {
      const g = u.alive && u.groundAt;
      if (!g || seen.some((p) => Math.hypot(p.x - g.x, p.z - g.z) < 1)) continue;
      seen.push(g);
      rings.add(g.x, g.z, SPOT_R, 0xff7a2a);
    }
    // (and the QUEUED orders' waypoints — shared orderQueue.js, Shift + right-click: one ring a squad, its leader's spot)
    for (const u of selection.selected ?? []) {
      if (!u.alive || (!u.orderQueue && !u._qCur)) continue;
      const s = squads.of(u);
      if (s && s.leader !== u) continue;
      for (const p of queuedPoints(u)) rings.add(p.x, p.z, 1.6, p.kind === "attack" ? 0xe0574a : 0xf2c94c);
    }
    rings.commit();
  }

  return {
    begin, cancel, frame,
    get aiming() { return !!targeting; },
    /** The command card's button for this selection (null: nothing in it can). */
    ability(sel) {
      if (!(sel ?? []).some(able)) return null;
      return { key: "attackGround", label: t("Tir sur zone"), ready: true,
        hint: t("Tir sur zone : vos mitrailleuses, canons et mortiers tirent sur un point — une position soupçonnée, une lisière, une maison. Les mitrailleuses clouent au sol ceux qui s'y cachent ; le mortier y lance ses obus. Jusqu'au prochain ordre.") };
    },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    },
  };
}
