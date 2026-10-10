// ATTACK-MOVE — CoH's "A": advance and fight whatever you meet on the way (2026-10-09, the CoH
// audit: "players expect it"). A plain move is obeyed to the letter — the men shoot on the move
// but never stop or turn aside (shared combat.js `playerMove`). An ASSAULT:
//   ORDER     Ctrl + right-click the ground, or ASSAUT (N) on the card then a left-click (the
//             reticle; right-click or Esc cancels).
//   GOING     the same formation and paths as a move (selection.js formationAt), but the men are
//             free to fight: an enemy in reach → they halt (or close in) and fire, as when idle.
//   ON AGAIN  his target down and nobody left in reach, each man walks on to his own spot.
//   ENDS      at the spot, or with any other order (a move, a halt, a retreat).
// (Not the camera's A: W/A/S/D and Q/E are taken by position on QWERTY and AZERTY alike.)
import { t } from "./i18n/i18n.js";
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";

const P = {
  tick: 0.3,          // s between looks at the men on an assault
  arrive: 2.5,        // m from his spot: there
};

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.selection   the shared selection (previewMove / orderMove)
 */
export function createAlgAttackMove(app, { selection }) {
  const dom = app.renderer.domElement;
  const marching = new Set();
  let armed = false, tickT = 0;

  /** The player's units of a selection that can go (not buildings, not the enemy, not inside). */
  const movers = (sel) => (sel ?? []).filter((u) => u.alive && isHuman(u.team) && !u.isStructure);

  /** ASSAULT toward (x, z): the move's formation, the men free to fight. */
  function go(x, z, y) {
    if (!movers(selection.selected).length) return false;
    const { arr, slots } = selection.previewMove(x, z);
    selection.orderMove(x, z, y);          // paths, the order marks, the radio — as a move
    arr.forEach((u, i) => {
      if (!isHuman(u.team) || u.isStructure || !slots[i]) return;
      u.playerMove = false;                // fight on the way (combat.js)
      u.attackMove = { x: slots[i].x, z: slots[i].z };
      marching.add(u);
    });
    app.algVoices?.order?.("attack", arr);
    return true;
  }
  /** Any other order to these men ends their assault (algUnits onOrder / halt / retreat). */
  function cancel(list) { for (const u of list ?? []) if (u.attackMove) { u.attackMove = null; marching.delete(u); } }

  function step(dt) {
    if ((tickT -= dt) > 0) return;
    tickT = P.tick;
    for (const u of marching) {
      const g = u.attackMove;
      if (!u.alive || !g || u.squad?.retreating || u.holdFire) { u.attackMove = null; marching.delete(u); continue; }
      if (u.inside) continue;                                   // in a house / a truck: wait
      if (Math.hypot(u.position.x - g.x, u.position.z - g.z) < P.arrive) { u.attackMove = null; marching.delete(u); continue; }
      if (u.target?.alive || u.attackTarget?.alive) continue;   // fighting
      if (!u.isMoving) u.orderTo(g.x, g.z);                     // on again
    }
  }

  // ── The order: Ctrl + right-click; or the card's ASSAUT then a click ──────────
  const ground = (e) => app.pickWorldAtClient?.(e.clientX, e.clientY)?.point ?? null;
  function onContext(e) {
    if (armed) { e.preventDefault(); e.stopImmediatePropagation(); end(); return; }   // right-click cancels
    if (!e.ctrlKey) return;
    const p = ground(e);
    if (!p || !movers(selection.selected).length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    go(p.x, p.z, p.y);
  }
  function onDown(e) {
    if (!armed || e.button !== 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const p = ground(e);
    if (p) go(p.x, p.z, p.y);
    end();
  }
  function onKey(e) { if (armed && e.key === "Escape") { e.preventDefault(); end(); } }
  function begin(sel) {
    if (!movers(sel).length) return false;
    armed = true;
    dom.style.cursor = "crosshair";          // the game's reticle (ui/cursors.js)
    return true;
  }
  function end() {
    armed = false;
    if (dom.style.cursor === "crosshair") dom.style.cursor = "";
  }
  dom.addEventListener("contextmenu", onContext, true);
  dom.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey);

  return {
    P, go, cancel, step, begin, end,
    get armed() { return armed; },
    /** ASSAUT on the command card: any of your units that can move. */
    ability(sel) {
      if (!movers(sel).length) return null;
      return { key: "attackMove", label: t("Assaut"), hint: t("Avancer en combattant : les hommes s'arrêtent pour tirer sur tout ennemi à portée, puis reprennent leur route. Un clic au sol ; plus vite : Ctrl + clic droit."), ready: true };
    },
    dispose() {
      dom.removeEventListener("contextmenu", onContext, true);
      dom.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    },
  };
}
