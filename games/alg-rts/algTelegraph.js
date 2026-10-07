// THE LINE CUT (2026-10-07, the FLN asymmetry: sabotage). The telegraph line along the pistes
// (algPoles.js) was scenery; now it is the post's line to Algiers, and the FLN cuts it.
//
//   FELLED      an FLN band sent on a "cut" mission (algAI.js planCut: a pole far from any
//               French, out of their MGs' reach) works at it P.work s and it comes down: the
//               pole lies across the verge, its two spans' wires gone.
//   WHILE CUT   the post cannot call an AIR STRIKE (algAirStrike.js asks `cut`), and the
//               EFFECTIFS from Algiers come at P.mpMul (algEconomy.js) — the alert says where.
//   MENDED      by SAPPERS, as they repair a vehicle (algRepair.js: right-click the felled pole,
//               or Réparer): P.repairHp of work — ~15 s for one man, 5 s for three.
//
// Free per frame: a felled pole is one instance matrix and a rebuilt wire index (rare events).

import { t } from "./i18n/i18n.js";

export const TELEGRAPH = {
  mpMul: 0.6,        // × the base effectifs while the line is cut
  repairHp: 45,      // the work to mend a pole (sappers: 3 hp/s a man)
  keepOff: 90,       // m: no French nearer a pole the FLN goes for
  postKeepOff: 120,  // m from the post
  maxCut: 2,         // poles down at once (more is the same cut line)
};

export function createAlgTelegraph(app, { poles, units, params = TELEGRAPH }) {
  const P = params;
  const cuts = [];          // { i, target } — the felled poles
  const hidden = new Set(); // their spans

  const refreshWires = () => {
    hidden.clear();
    for (const c of cuts) for (const sp of poles.spanList) if (sp.a === c.i || sp.b === c.i) hidden.add(sp);
    poles.setHiddenSpans(hidden);
  };
  const say = (...a) => app.algBattle?.say?.(...a);

  /** Fell pole `i` (the FLN's work done). */
  function fell(i) {
    if (cuts.some((c) => c.i === i) || !poles.poles[i]) return false;
    const p = poles.poles[i];
    poles.setStanding(i, false);
    // What the sappers right-click: a "structure" of the French with no hp left.
    const target = {
      isStructure: true, telegraph: true, typeKey: "telegraph", name: t("Ligne télégraphique"), team: "player",
      alive: true, hp: 0, maxHp: P.repairHp, radius: 1.5, type: { typeKey: "telegraph", name: t("Ligne télégraphique") },
      position: { x: p.x, y: p.y, z: p.z },
    };
    const wasUp = !cuts.length;
    cuts.push({ i, target });
    refreshWires();
    if (wasUp) say(t("<b>Ligne coupée !</b> Le FLN a abattu un poteau : plus d'appui aérien, et les effectifs d'Alger arrivent moins vite. Envoyez des sapeurs la réparer."), p.x, p.z, "bad", "hq_contact", "alertAttack");
    return true;
  }

  function mend(c) {
    cuts.splice(cuts.indexOf(c), 1);
    c.target.alive = false;
    poles.setStanding(c.i, true);
    refreshWires();
    if (!cuts.length) {
      const p = poles.poles[c.i];
      say(t("<b>Ligne rétablie.</b> Le poste a de nouveau Alger au bout du fil."), p.x, p.z, "good");
    }
  }

  /** A pole worth cutting for a band at `from` (null: none): far from the French and their MGs. */
  function poleFor(from) {
    if (cuts.length >= P.maxCut) return null;
    const post = (app.algStructures?.list ?? []).find((s) => s.typeKey === "post" && s.alive);
    const fr = units.list.filter((u) => u.alive && u.team === "player" && !u.isAir);
    const mgs = [...units.list, ...(app.algStructures?.list ?? [])].filter((u) => u.alive && u.team === "player" && (u.weapon ?? u.type?.weapon) === "mg");
    let best = -1, bestS = -Infinity;
    poles.poles.forEach((p, i) => {
      if (cuts.some((c) => c.i === i)) return;
      if (post && Math.hypot(p.x - post.position.x, p.z - post.position.z) < P.postKeepOff) return;
      if (fr.some((u) => Math.hypot(u.position.x - p.x, u.position.z - p.z) < P.keepOff)) return;
      if (mgs.some((g) => Math.hypot(g.position.x - p.x, g.position.z - p.z) < (g.range ?? g.type?.range ?? 40) + 10)) return;
      const s = -Math.hypot(p.x - from.x, p.z - from.z) / 300 + Math.random() * 0.3;
      if (s > bestS) { bestS = s; best = i; }
    });
    return best < 0 ? null : { i: best, x: poles.poles[best].x, z: poles.poles[best].z };
  }

  function step() {
    for (const c of [...cuts]) if (c.target.hp >= c.target.maxHp - 0.5) mend(c);
  }

  return {
    params: P,
    fell, poleFor, step,
    /** The line is down somewhere. */
    get cut() { return cuts.length > 0; },
    get cuts() { return cuts; },
    /** algRepair.js: the felled poles, as targets. */
    repairTargets: () => cuts.map((c) => c.target),
    /** Dev: fell the nearest pole to (x, z). */
    fellNear(x, z) {
      let best = -1, bd = Infinity;
      poles.poles.forEach((p, i) => { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = i; } });
      return best >= 0 && fell(best);
    },
  };
}
