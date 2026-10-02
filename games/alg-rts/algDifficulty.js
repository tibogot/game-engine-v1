// HOW HARD THE FLN FIGHTS (you, 2026-10-01: "way too easy, almost no
// enemies"). The match you played: the ALN started with 240 supplies, earned
// 15 a minute and paid 40 a fighter — six men, then one every ~2.7 minutes;
// its AI may keep 18 out but could never pay for them. These levels set the
// ALN's purse, income and fighter price, the AI's pace (algAI.js params) and
// a head start of fighters already out of the cave, and the French purse.
//
// Chosen on the briefing (remembered), or ?difficulty=easy|normal|hard.
const LEVELS = {
  easy: {
    label: "Easy", alnStart: 320, alnBase: 25, moudjahid: 35, headStart: 4,
    firstBandAt: 40, bandEvery: [70, 115], maxLive: 16, frStart: 750,
    blurb: "Small bands, slow to come.",
  },
  normal: {
    label: "Normal", alnStart: 480, alnBase: 45, moudjahid: 30, headStart: 8,
    firstBandAt: 18, bandEvery: [50, 85], maxLive: 26, frStart: 600,
    blurb: "A katiba that fights for every village.",
  },
  hard: {
    label: "Hard", alnStart: 700, alnBase: 70, moudjahid: 25, headStart: 12,
    firstBandAt: 10, bandEvery: [35, 60], maxLive: 36, frStart: 500,
    blurb: "The whole wilaya against one post.",
  },
};
export const DIFFICULTIES = Object.entries(LEVELS).map(([key, v]) => ({ key, label: v.label, blurb: v.blurb }));
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
  if (eco) {
    eco.aln.stock = L.alnStart;
    eco.french.stock = L.frStart;
    eco.params.base.enemy = L.alnBase;
    if (eco.costs) eco.costs.moudjahid = L.moudjahid;
  }
  const ai = app.algAI;
  if (ai?.params) Object.assign(ai.params, { firstBandAt: L.firstBandAt, bandEvery: L.bandEvery, maxLive: L.maxLive });
  ai?.restartClock?.(L.firstBandAt);
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
