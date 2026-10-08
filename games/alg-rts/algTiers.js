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
    units: ["appele", "sapeur", "piece", "lanceFlammes", "willys", "gmc"], cost: 0, villages: 0,
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

export function createAlgTiers(app, { economy, post = () => null }) {
  let tier = 1;
  // `post()`: the post's structure — the tiers are bought on its card (the alert and a locked
  // button take you there: you, 2026-10-08, "the player should understand the game well").
  /** Where and what, in one line: "au poste, ▲ Moyens héliportés — tenir 1 village, 150 effectifs, 40 carburant". */
  function howTo(tr) {
    const c = tr.cost ?? {}, price = [c.mp ? t("{n} effectifs", { n: c.mp }) : "", c.fuel ? t("{n} carburant", { n: c.fuel }) : ""].filter(Boolean).join(", ");
    const hold = tr.villages > 1 ? t("tenir {n} villages", { n: tr.villages }) : t("tenir 1 village");
    return t("au poste, ▲ {name} — {hold}, {price}", { name: tr.name, hold, price });
  }
  /** Select the post and bring the camera to it (the alert's click, a locked button's). */
  function goToPost() {
    const s = post();
    if (!s) return;
    app.rtsCamera?.focusOn(s.position.x, s.position.z);
    app.selection?.select([s]);
  }
  // THE ALERT: once a tier CAN be bought (the villages held and the price in hand), once per tier.
  let announced = 1, watchT = 0;
  function watch(dt) {
    if ((watchT -= dt) > 0) return;
    watchT = 1;
    const tr = next();
    if (!tr || announced >= tr.n || blockedBy(tr)) return;
    announced = tr.n;
    const s = post();
    app.algBattle?.say?.(t("<b>Échelon disponible : {name}</b> ({note}). Cliquez ici, puis ▲ {name} sur la fiche du poste.", { name: tr.name, note: tr.note }),
      s?.position.x, s?.position.z, "good", null, "alertFlag", goToPost);
  }
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
    howTo, goToPost, watch,
    /** The resources' readout: "échelon 1/3", and its tooltip (what the next one needs). */
    readout() {
      const tr = next();
      return { text: t("échelon {n}/{of}", { n: tier, of: TIERS.length }),
        tip: tr ? t("Échelon suivant : {how}.", { how: howTo(tr) }) : t("Tous les échelons sont débloqués.") };
    },
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
