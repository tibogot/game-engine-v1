// HOW HARD THE FLN FIGHTS (you, 2026-10-01: "way too easy, almost no
// enemies"). The match you played: the ALN started with 240 supplies, earned
// 15 a minute and paid 40 a fighter — six men, then one every ~2.7 minutes;
// its AI may keep 18 out but could never pay for them. These levels set the
// ALN's purse, income and fighter price, the AI's pace (algAI.js params) and
// a head start of fighters already out of the cave, and the French purse.
//
// Chosen on the briefing (remembered), or ?difficulty=easy|normal|hard.
import { t } from "./i18n/i18n.js";
import { isHuman } from "../shared-rts/teams.js";

const LEVELS = {
  easy: {
    label: t("Facile"), alnStart: 320, alnBase: 25, moudjahid: 35, headStart: 4,
    firstBandAt: 40, bandEvery: [70, 115], maxLive: 16, frStart: 750, snipers: 1,
    // (You as the FLN: your purse and income; the French company's size and start.)
    flnStart: 520, flnBase: 60, frAiStart: 400, frSquads: 4, frAssaultAt: 7,
    blurb: t("Petites bandes, lentes à venir."), blurbFln: t("Une compagnie d'appelés, lente à réagir."),
  },
  normal: {
    label: t("Normal"), alnStart: 480, alnBase: 45, moudjahid: 30, headStart: 8,
    firstBandAt: 18, bandEvery: [50, 85], maxLive: 26, frStart: 600, snipers: 2,
    flnStart: 420, flnBase: 45, frAiStart: 600, frSquads: 6, frAssaultAt: 5,
    blurb: t("Une katiba qui se bat pour chaque village."), blurbFln: t("Une compagnie qui reprend chaque village."),
  },
  hard: {
    label: t("Difficile"), alnStart: 700, alnBase: 70, moudjahid: 25, headStart: 12,
    firstBandAt: 10, bandEvery: [35, 60], maxLive: 36, frStart: 500, snipers: 3,
    flnStart: 340, flnBase: 35, frAiStart: 850, frSquads: 8, frAssaultAt: 5,
    blurb: t("Toute la wilaya contre un seul poste."), blurbFln: t("Paras, Légion et Alouettes contre une katiba."),
  },
};
// (The blurb describes YOUR enemy: the French when you play the FLN — read when the briefing is built.)
export const DIFFICULTIES = Object.entries(LEVELS).map(([key, v]) => ({ key, label: v.label, get blurb() { return isHuman("enemy") ? v.blurbFln : v.blurb; } }));
const STORE = "algrts.difficulty";

export function storedDifficulty() {
  const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("difficulty") : null;
  if (q && LEVELS[q]) return q;
  try { const s = localStorage.getItem(STORE); if (s && LEVELS[s]) return s; } catch { /* private window */ }
  return "normal";
}

/**
 * Apply a level to a running game (at its start): the purses, the price,
 * the AI's pace, and the head start (fighters at the cave's rally, idle — the
 * AI's next band takes them).
 */
export function applyDifficulty(app, key) {
  const L = LEVELS[key] ?? LEVELS.normal;
  try { localStorage.setItem(STORE, key); } catch { /* ignore */ }
  const eco = app.algEconomy;
  const fln = isHuman("enemy");
  if (eco) {
    eco.aln.stock = fln ? L.flnStart : L.alnStart;
    eco.french.stock = fln ? L.frAiStart : L.frStart;
    eco.params.base.enemy = fln ? L.flnBase : L.alnBase;
    if (eco.costs) eco.costs.moudjahid = L.moudjahid;
  }
  // The French commander (algFrenchAI.js) when you are the FLN.
  // (Only when you are the FLN: the ?bot=1 balance runs keep the bot a Normal company.)
  if (fln && app.algFrenchAI) Object.assign(app.algFrenchAI.params, { squadsMax: L.frSquads, assaultAt: L.frAssaultAt });
  const ai = app.algAI;
  if (ai?.params) Object.assign(ai.params, { firstBandAt: L.firstBandAt, bandEvery: L.bandEvery, maxLive: L.maxLive });
  ai?.restartClock?.(L.firstBandAt);
  // The snipers out at once (algSniper.js).
  if (app.algSnipers) app.algSnipers.params.max = L.snipers;
  // The head start: men already out of the cave, standing at its rally.
  const cave = app.algProducers?.find((p) => p.structure.typeKey === "caveEntrance");
  const units = app.algUnits?.units;
  if (cave && units && ai) {
    const r = cave.structure.rally;
    for (let i = 0; i < L.headStart; i++) {
      const a = (i / L.headStart) * Math.PI * 2, d = 3 + (i % 3) * 2;
      units.spawn("moudjahid", r.x + Math.cos(a) * d, r.z + Math.sin(a) * d, { team: "enemy" });
    }
  }
  app.algDifficulty = key;
  return L;
}
