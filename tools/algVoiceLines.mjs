/**
 * THE VOICE SCRIPT — every line alg-rts says (you, 2026-10-02: "the soldiers'
 * communication is missing, the enemies' too; radio calls in French and
 * Arabic"). tools/genVoices.mjs turns it into audio with ElevenLabs; the game
 * (games/alg-rts/algVoices.js) picks a line by its id.
 *
 *   side    "fr"    French soldiers, said by the man (positional)
 *           "hq"    French radio (the post / HQ), through the radio filter
 *           "aln"   ALN fighters, said by the man (positional, when near)
 *   texts   several ways to say it: variety (one picked at random)
 *
 * French: 1950s army French, short and shouted. ALN: ALGERIAN ARABIC (Darija)
 * in Arabic script so the voice pronounces it, a French or Chaoui word where
 * the Aurès would use one — the English beside each line is what it means.
 * TO CHECK by a native speaker before shipping.
 */
export const VOICE_LINES = {
  // ── French soldiers ─────────────────────────────────────────────────────
  fr_select:      { side: "fr", texts: ["Oui, mon lieutenant ?", "J'écoute.", "À vos ordres.", "On attend vos ordres."] },
  fr_move:        { side: "fr", texts: ["Compris, on y va !", "En avant !", "Bien reçu, on bouge.", "On se déplace !"] },
  fr_attack:      { side: "fr", texts: ["Feu à volonté !", "On les accroche !", "Allez, on y va, feu !", "Cible en vue !"] },
  fr_contact:     { side: "fr", texts: ["Contact !", "Fellagha en vue !", "Contact, devant !", "Attention, ils sont là !"] },
  fr_underFire:   { side: "fr", texts: ["On nous tire dessus !", "À couvert !", "Ça tire de partout !", "Couchez-vous !"] },
  fr_pinned:      { side: "fr", texts: ["On est bloqués !", "Je peux plus bouger !", "Ils nous clouent au sol !"] },
  fr_grenade:     { side: "fr", texts: ["Grenade !", "Attention, grenade !", "Je lance !"] },
  fr_manDown:     { side: "fr", texts: ["Homme à terre !", "Ils l'ont eu !", "Infirmier !", "On a un blessé !"] },
  fr_build:       { side: "fr", texts: ["Au boulot, les gars.", "On creuse.", "Le génie s'en occupe."] },
  fr_vehicleMove: { side: "fr", texts: ["Moteur ! On roule.", "Bien reçu, on avance.", "En route."] },
  fr_victory:     { side: "fr", texts: ["On les a repoussés !", "Ils décrochent !"] },

  // ── French radio (HQ / the post) ────────────────────────────────────────
  hq_contact:      { side: "hq", texts: ["Ici Tighanimine. Contact signalé.", "Attention, contact avec l'ennemi."] },
  hq_enemySeen:    { side: "hq", texts: ["Bande rebelle repérée.", "Fellagha signalés dans le secteur."] },
  hq_enemyMG:      { side: "hq", texts: ["Attention, fusil-mitrailleur ennemi !", "Mitrailleuse rebelle, restez à couvert."] },
  hq_villageTaken: { side: "hq", texts: ["Le village est à nous.", "Village sécurisé."] },
  hq_villageLost:  { side: "hq", texts: ["Nous avons perdu le village.", "Le village est passé aux rebelles."] },
  hq_villageThreat:{ side: "hq", texts: ["Les rebelles travaillent le village. Envoyez du monde."] },
  hq_vehicleLost:  { side: "hq", texts: ["Véhicule détruit.", "On a perdu un véhicule."] },
  hq_buildingLost: { side: "hq", texts: ["Position détruite."] },
  hq_postAttack:   { side: "hq", texts: ["Le poste est attaqué ! Renforts au poste !", "Ici le poste, on est attaqués !"] },
  hq_cacheFound:   { side: "hq", texts: ["Cache d'armes découverte.", "On a trouvé une cache d'armes."] },
  hq_muleTrain:    { side: "hq", texts: ["Convoi de mulets repéré. Interceptez-le."] },
  hq_mine:         { side: "hq", texts: ["Attention, mine sur la piste.", "Une mine a sauté !"] },
  hq_reinforce:    { side: "hq", texts: ["Renforts en route.", "Les renforts arrivent."] },
  hq_tier:         { side: "hq", texts: ["Moyens supplémentaires accordés.", "Le commandement nous envoie des moyens."] },
  hq_victory:      { side: "hq", texts: ["Bien joué. Le secteur est à nous."] },
  hq_defeat:       { side: "hq", texts: ["Le secteur est perdu. Repli général."] },

  // ── ALN fighters (Algerian Arabic) ──────────────────────────────────────
  aln_contact:   { side: "aln", texts: [
    "جاو العسكر!",            // "The soldiers are coming!"
    "راهم هنا!",              // "They're here!"
    "شوف، الفرانسيس!",        // "Look, the French!"
  ] },
  aln_attack:    { side: "aln", texts: [
    "اضربوهم!",               // "Hit them!"
    "هجوم يا خاوتي!",         // "Attack, my brothers!"
    "زيدو، زيدو!",            // "Go on, go on!"
  ] },
  aln_underFire: { side: "aln", texts: [
    "طيحو! طيحو!",            // "Get down! Get down!"
    "راهم يضربو علينا!",      // "They're firing at us!"
    "تخباو!",                 // "Take cover!"
  ] },
  aln_grenade:   { side: "aln", texts: [
    "رمانة!",                 // "Grenade!"
    "ردو بالكم، رمانة!",      // "Watch out, grenade!"
  ] },
  aln_manDown:   { side: "aln", texts: [
    "طاح خونا!",              // "Our brother fell!"
    "الله يرحمو!",            // "God have mercy on him!"
    "مجروح، عاونوني!",        // "Wounded, help me!"
  ] },
  aln_retreat:   { side: "aln", texts: [
    "انسحبو! للجبل!",         // "Pull back! To the mountain!"
    "روحو، روحو!",            // "Go, go!"
  ] },
  aln_move:      { side: "aln", texts: [
    "يالاه، نمشيو.",          // "Come on, let's move."
    "تبعوني!",                // "Follow me!"
  ] },
};
