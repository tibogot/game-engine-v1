// THE FRENCH TIERS (you, 2026-10-01: "motor pool → helipad → armour"): a
// match with a shape, Company of Heroes style — infantry and light vehicles
// first, the heliborne reserve once the valley is contested, armour last.
// A tier is UNLOCKED from the post's card: it costs effectifs + FUEL
// (algEconomy.js — the land you hold pays for the next tier) and needs
// villages held (the war is for the villages; the means follow them).
// Locked units show on their building's card, greyed, saying what unlocks
// them. Once unlocked a tier stays (losing a village later doesn't take the
// tanks back).
import { t } from "./i18n/i18n.js";

export const TIERS = [
  {
    n: 1, name: t("Section d'infanterie"), note: t("dès le départ"),
    units: ["appele", "sapeur", "piece", "willys", "gmc"], cost: 0, villages: 0,
  },
  {
    n: 2, name: t("Moyens héliportés"), note: t("l'héliport ouvre : paras, l'Alouette ; le half-track"),
    units: ["para", "alouette", "halftrack"], cost: { mp: 150, fuel: 40 }, villages: 1,
  },
  {
    n: 3, name: t("Blindés"), note: t("les blindés : l'EBR, l'AMX-13 ; la Légion"),
    units: ["ebr", "amx13", "legion"], cost: { mp: 200, fuel: 90 }, villages: 2,
  },
];
const tierOfUnit = Object.fromEntries(TIERS.flatMap((tr) => tr.units.map((u) => [u, tr.n])));

export function createAlgTiers(app, { economy }) {
  let tier = 1;
  /** The tier a unit needs (units not listed: always open — the ALN's). */
  const needs = (key) => tierOfUnit[key] ?? 1;
  const next = () => TIERS.find((tr) => tr.n === tier + 1) ?? null;
  /** Why the next tier can't be bought now (null: it can). */
  function blockedBy(tr = next()) {
    if (!tr) return t("tout est débloqué");
    if (economy.held < tr.villages) return tr.villages > 1
      ? t("tenir {n} villages (vous en tenez {held})", { n: tr.villages, held: economy.held })
      : t("tenir 1 village (vous en tenez {held})", { held: economy.held });
    // Merely too poor, not locked: the card (algUnits.js) tells the two apart by the villages.
    if (!economy.french.canAfford(tr.cost)) {
      const short = economy.french.short?.(tr.cost);
      return short ? t("{short} ressources", { short }) : t("plus de ressources");
    }
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
      const tr = next();
      if (!tr || blockedBy(tr) || !economy.french.spend(tr.cost)) return false;
      tier = tr.n;
      app.algBattle?.say?.(t("<b>{name}</b> débloqué : {note}.", { name: tr.name, note: tr.note }));
      app.algVoices?.radio("hq_tier");
      return true;
    },
  };
}
