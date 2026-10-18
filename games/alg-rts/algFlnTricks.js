// THE FLN'S TRICKS FOR A HUMAN (2026-10-13, A1 "the FLN made playable"). What its AI did on its own
// (algAI.js: mines on the pistes, the telegraph cut) as buttons on the moudjahidine's card:
//   MINE            click a spot (a piste is best): the nearest man walks there, digs ~6 s, and the
//                   mine arms (algMines.js: it waits for a French boot or wheel). Paid in supplies;
//                   four live at most, as for the AI. Yours show as small amber rings.
//   COUPER LA LIGNE the group walks to the nearest standing telegraph pole (45 m) and fells it in
//                   ~10 s (algTelegraph.js: the post loses its air strike and a share of its effectifs
//                   from Algiers until sappers mend it).
//   MINE COMMANDÉE  (2026-10-18, CoH's demolition charge) as the mine, a charge with a WIRE: the man who
//                   laid it holds it (algMines.js layCommand, manual) — move him into cover within 45 m;
//                   on his card, FAIRE SAUTER sets it off under whatever is on it. He dies or goes out
//                   of reach: it is an ordinary mine.
// The man at work plays the dig (the renderer's `working`). Any other order given to him ends it.
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { isHuman } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

export const FLN_TRICKS = {
  mine: { cost: 30, work: 6, reach: 70 },   // reach: m from the nearest man to the spot
  wire: { cost: 45, work: 7, reach: 70 },   // the command mine: a little dearer and longer to bury
  cut: { work: 10, reach: 45 },             // reach: m from the group to the pole
};
const P = FLN_TRICKS;

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units
 * @param {object} o.selection
 * @param {object} o.mines      algMines
 * @param {object} o.purse      the FLN's purse (economy.aln)
 */
export function createAlgFlnTricks(app, { units, selection, mines, purse }) {
  const dom = app.renderer.domElement;
  const jobs = [];          // { kind, u, at, t, pole }
  const own = new Set();    // the mines this player laid (rings)
  let targeting = null;     // { sel, at, ok }
  const say = (text, x, z, kind = "good") => app.algBattle?.say?.(text, x, z, kind);

  const diggers = (sel) => sel.filter((u) => u.alive && isHuman(u.team) && u.typeKey === "moudjahid" && !u.inside);
  const centreOf = (men) => ({ x: men.reduce((a, u) => a + u.position.x, 0) / men.length, z: men.reduce((a, u) => a + u.position.z, 0) / men.length });
  const nearest = (men, x, z) => men.reduce((a, u) => (Math.hypot(u.position.x - x, u.position.z - z) < Math.hypot(a.position.x - x, a.position.z - z) ? u : a));
  const busy = (u) => jobs.some((j) => j.u === u);

  function poleFor(men) {
    const c = centreOf(men);
    return app.algTelegraph?.nearestStanding?.(c.x, c.z, P.cut.reach) ?? null;
  }

  /** The two buttons for a selection of the human's moudjahidine (none: null). */
  function ability(sel) {
    const men = diggers(sel);
    if (!men.length) return [];
    const full = (mines.count ?? 0) >= (mines.params?.max ?? 4);
    const held = men.flatMap((u) => mines.heldBy?.(u) ?? []);
    return [
      { key: "flnMine", label: t("Mine"), cost: P.mine.cost, ready: !full && purse.canAfford(P.mine.cost),
        hint: full ? t("Toutes vos mines sont posées : attendez qu'une saute.") : t("Un homme va poser une mine où vous cliquez (une piste de préférence) : ~6 s de travail, puis elle attend une botte ou une roue française.") },
      { key: "flnWire", label: t("Mine commandée"), cost: P.wire.cost, ready: !full && purse.canAfford(P.wire.cost),
        hint: full ? t("Toutes vos mines sont posées : attendez qu'une saute.") : t("Un homme enterre une charge sous la piste, reliée à un fil : restez à moins de 45 m, à couvert, et faites-la sauter au passage du camion ou du half-track. Elle ne part pas seule.") },
      ...(held.length ? [{ key: "flnDetonate", label: t("Faire sauter"), ready: true,
        hint: t("Le fil est tiré : la charge saute maintenant, sous ce qui roule dessus.") }] : []),
      { key: "flnCut", label: t("Couper la ligne"), ready: !!poleFor(men),
        hint: poleFor(men) ? t("Le groupe abat le poteau télégraphique le plus proche (~10 s) : le poste perd son appui aérien et une part de ses effectifs d'Alger jusqu'à ce que ses sapeurs le réparent.") : t("Aucun poteau télégraphique debout à moins de 45 m.") },
    ];
  }

  function begin(sel, kind = "mine") {
    const men = diggers(sel);
    if (!men.length) return false;
    targeting = { men, at: null, ok: false, kind };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; dom.style.cursor = ""; }

  function cut(sel) {
    const men = diggers(sel);
    const pole = men.length ? poleFor(men) : null;
    if (!pole) return false;
    men.forEach((u, k) => { const a = (k / men.length) * Math.PI * 2; u.moveOrder(pole.x + Math.cos(a) * 2.2, pole.z + Math.sin(a) * 2.2); });
    jobs.push({ kind: "cut", men, pole, t: 0, at: pole });
    return true;
  }

  function onMove(e) {
    if (!targeting) return;
    const p = app.pickWorldAtClient?.(e.clientX, e.clientY)?.point;
    if (!p) { targeting.at = null; return; }
    const hit = { x: p.x, z: p.z };
    const u = nearest(targeting.men, hit.x, hit.z);
    targeting.at = hit;
    targeting.ok = Math.hypot(u.position.x - hit.x, u.position.z - hit.z) <= P.mine.reach && !app.navGrid?.isBlockedAtWorld?.(hit.x, hit.z, true);
  }
  function onDown(e) {
    if (!targeting) return;
    if (e.button === 2) { cancel(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopImmediatePropagation();
    onMove(e);
    const at = targeting.at, kind = targeting.kind ?? "mine", cost = P[kind].cost;
    if (!at || !targeting.ok) return;
    if (!purse.spend(cost)) { cancel(); return; }
    const u = nearest(targeting.men.filter((m) => m.alive), at.x, at.z);
    u.moveOrder(at.x, at.z);
    jobs.push({ kind, u, at: { x: at.x, z: at.z }, t: 0, paid: cost });
    cancel();
  }
  /** FAIRE SAUTER: every charge whose wire one of these men holds. */
  function detonate(sel) {
    let n = 0;
    for (const u of diggers(sel)) for (const m of mines.heldBy?.(u) ?? []) if (mines.detonate(m)) n++;
    return n;
  }
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  const onKey = (e) => { if (targeting && e.key === "Escape") cancel(); };
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey);

  function step(dt) {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const j = jobs[i];
      const dig = j.kind !== "cut";   // a mine or a wired charge: one man, by hand
      const men = dig ? [j.u] : j.men.filter((u) => u.alive);
      const drop = (refund) => { for (const u of men) { u.working = false; u.workClip = null; } if (refund && j.paid) purse.earn(j.paid); jobs.splice(i, 1); };
      if (!men.length || !men[0].alive) { drop(true); continue; }
      // Ordered elsewhere (his goal no longer the job's spot): the job is off.
      const g = men[0].goalPoint;
      if (g && Math.hypot(g.x - j.at.x, g.z - j.at.z) > 4) { drop(true); continue; }
      const there = men.filter((u) => Math.hypot(u.position.x - j.at.x, u.position.z - j.at.z) < (dig ? 1.6 : 4));
      for (const u of men) u.working = there.includes(u);
      // A mine is buried by HAND, kneeling (Mixamo "Plant A Plant", 2026-10-17); the wire is cut as before.
      if (dig) for (const u of men) u.workClip = u.working ? "plant" : null;
      if (!there.length) continue;
      j.t += dt * (j.kind === "cut" ? Math.min(2, 0.6 + 0.4 * there.length) : 1);   // more hands, a faster cut
      if (j.t < P[j.kind].work) continue;
      if (j.kind === "mine") {
        const m = mines.lay(j.at.x, j.at.z);
        if (m) { own.add(m); say(t("<b>Mine posée.</b> Elle attend les Français."), j.at.x, j.at.z); } else purse.earn(j.paid);
      } else if (j.kind === "wire") {
        const u = j.u, at = j.at;
        const m = mines.layCommand(at.x, at.z, u, (why) => {
          if (why === "gone" && u.alive) say(t("<b>Le fil est perdu</b> : la charge est désormais une mine ordinaire."), at.x, at.z, "bad");
        }, { manual: true });
        if (m) { own.add(m); say(t("<b>Mine commandée posée.</b> Mettez l'homme à couvert à moins de 45 m, puis « Faire sauter » au passage du convoi."), at.x, at.z); } else purse.earn(j.paid);
      } else if (app.algTelegraph?.fell(j.pole.i)) say(t("<b>Ligne coupée !</b> Le poste n'a plus Alger au bout du fil."), j.pole.x, j.pole.z);
      drop(false);
    }
    for (const m of [...own]) if (!mines.list.includes(m)) own.delete(m);
  }

  const rings = createSelectionRingField({ app, inner: 0.85, segments: 32 });
  function frame() {
    rings.begin();
    if (targeting?.at) rings.add(targeting.at.x, targeting.at.z, 1.6, targeting.ok ? 0x58e070 : 0xe0574a);
    // Yours: amber; a charge on its wire: red, and a ring round its man's reach while he is selected.
    for (const m of own) {
      rings.add(m.x, m.z, 1.1, m.command ? 0xe05a3a : 0xe0a93a);
      if (m.command?.selected) rings.add(m.x, m.z, mines.params.command.wire, 0xe05a3a);
    }
    for (const j of jobs) if (j.kind === "cut") rings.add(j.pole.x, j.pole.z, 2.2, 0xe0a93a);
    rings.commit();
  }

  return {
    params: P, ability, begin, cut, detonate, cancel, step, frame,
    get targeting() { return !!targeting; },
    dispose() {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
    },
  };
}
