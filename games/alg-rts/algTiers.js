// THE FRENCH TIERS (you, 2026-10-01: "motor pool → helipad → armour"): a
// match with a shape, Company of Heroes style — infantry and light vehicles
// first, the heliborne reserve once the valley is contested, armour last.
// A tier is UNLOCKED from the post's card: it costs effectifs + FUEL
// (algEconomy.js — the land you hold pays for the next tier) and needs
// villages held (the war is for the villages; the means follow them).
// Locked units show on their building's card, greyed, saying what unlocks
// them. Once unlocked a tier stays (losing a village later doesn't take the
// tanks back).
export const TIERS = [
  {
    n: 1, name: "Section d'infanterie", note: "dès le départ",
    units: ["appele", "sapeur", "piece", "willys", "gmc"], cost: 0, villages: 0,
  },
  {
    n: 2, name: "Moyens héliportés", note: "l'héliport ouvre : paras, l'Alouette ; le half-track",
    units: ["para", "alouette", "halftrack"], cost: { mp: 150, fuel: 40 }, villages: 1,
  },
  {
    n: 3, name: "Blindés", note: "les blindés : l'EBR, l'AMX-13 ; la Légion",
    units: ["ebr", "amx13", "legion"], cost: { mp: 200, fuel: 90 }, villages: 2,
  },
];
const tierOfUnit = Object.fromEntries(TIERS.flatMap((t) => t.units.map((u) => [u, t.n])));

export function createAlgTiers(app, { economy }) {
  let tier = 1;
  /** The tier a unit needs (units not listed: always open — the ALN's). */
  const needs = (key) => tierOfUnit[key] ?? 1;
  const next = () => TIERS.find((t) => t.n === tier + 1) ?? null;
  /** Why the next tier can't be bought now (null: it can). */
  function blockedBy(t = next()) {
    if (!t) return "tout est débloqué";
    if (economy.held < t.villages) return `tenir ${t.villages} village${t.villages > 1 ? "s" : ""} (vous en tenez ${economy.held})`;
    // Ends "supplies": the card shows it as merely too poor, not locked.
    if (!economy.french.canAfford(t.cost)) return `${economy.french.short?.(t.cost) || "plus de"} ressources`;
    return null;
  }
  return {
    TIERS,
    get tier() { return tier; },
    needs,
    unlocked: (key) => needs(key) <= tier,
    next,
    blockedBy,
    /** Buy the next tier (the post's card). True if done. */
    unlock() {
      const t = next();
      if (!t || blockedBy(t) || !economy.french.spend(t.cost)) return false;
      tier = t.n;
      app.algBattle?.say?.(`<b>${t.name}</b> débloqué : ${t.note}.`);
      app.algVoices?.radio("hq_tier");
      return true;
    },
  };
}
