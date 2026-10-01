// THE FRENCH TIERS (you, 2026-10-01: "motor pool → helipad → armour"): a
// match with a shape, Company of Heroes style — infantry and light vehicles
// first, the heliborne reserve once the valley is contested, armour last.
// A tier is UNLOCKED from the post's card: it costs supplies and needs
// villages held (the war is for the villages; the means follow them).
// Locked units show on their building's card, greyed, saying what unlocks
// them. Once unlocked a tier stays (losing a village later doesn't take the
// tanks back).
export const TIERS = [
  {
    n: 1, name: "Section d'infanterie", note: "from the start",
    units: ["appele", "sapeur", "willys", "gmc"], cost: 0, villages: 0,
  },
  {
    n: 2, name: "Moyens héliportés", note: "the helipad opens: paras, the Alouette; the half-track",
    units: ["para", "alouette", "halftrack"], cost: 150, villages: 1,
  },
  {
    n: 3, name: "Blindés", note: "armour: the EBR, the AMX-13; the Légion",
    units: ["ebr", "amx13", "legion"], cost: 250, villages: 2,
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
    if (!t) return "all unlocked";
    if (economy.held < t.villages) return `hold ${t.villages} village${t.villages > 1 ? "s" : ""} (you hold ${economy.held})`;
    if (!economy.french.canAfford(t.cost)) return `${t.cost} supplies`;
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
      app.algBattle?.say?.(`<b>${t.name}</b> unlocked: ${t.note}.`);
      return true;
    },
  };
}
