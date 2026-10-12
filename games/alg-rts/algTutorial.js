// THE TRAINING — CAMP D'INSTRUCTION (2026-10-09, you: "a first mission that teaches the basics;
// everything should make the user understand the game"). ?map=training (maps/training.js).
//
// One lesson at a time, in a panel at the top of the screen: what to do, the keys for it, and the
// lesson moves on by itself once it is DONE (or "Passer" skips it). Each lesson sets its own
// ground: a marker ring where to go, a sandbag wall, a few FLN fighters to fight. The battle's
// own rules are off (algBattle `rules`: no score, no objectives, no advice); its alerts, markers
// and end screen are used. The FLN's AI and the fog of war are off on this map (algGame.js) —
// the enemies here are the lessons'.
//
//   1 the camera          ZQSD / WASD, A / E, the wheel        → moved, turned, zoomed
//   2 select              a click or a box                     → a squad selected
//   3 move                right-click to the marker            → men on it
//   4 cover               V, behind the sandbags               → men in cover by the wall
//   4b the sappers        build a sandbag wall (2026-10-11)    → a wall YOU placed, finished
//   5 take the village    men in the mechta's circle           → held
//   5b the houses         right-click a house, then K (Sortir) → in, then out (2026-10-11)
//   6 supply              the depot on the track               → held (and linked)
//   6b how to win         the score bar shown, the score runs  → the FLN's score down 2 (2026-10-11)
//   7 attack              right-click an enemy                 → the three targets down
//   8 assault             Ctrl + right-click toward the knoll  → its defenders down, men on top
//   9 grenade             G on men dug in                      → a grenade thrown, them down
//  10 retreat, reinforce  T, then Y at the post                → the squad full again
//  11 the post            train a squad                        → a new squad
//  12 the tier            ▲ Airmobile at the post              → tier 2
//  13 the half-track      board, drive, disembark (K)          → a squad out of it by the mechta
//  14 the final           a band attacks the mechta            → the band down, the mechta held
import { t } from "./i18n/i18n.js";
import { LAYOUT, MAP } from "./layout.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

const P = { tick: 0.25, nextDelay: 1.6 };

export function createAlgTutorial(app) {
  const battle = app.algBattle, hud = battle.hud;
  // The lessons' own targets would each be "a band spotted": the sightings are off too.
  battle.rules.score = battle.rules.objectives = battle.rules.advice = battle.rules.sightings = false;
  const units = app.algUnits.units, S = app.algSquads, E = app.algEconomy;
  const H = (x, z) => app.getWorldHeight(x, z);
  const site = (k) => LAYOUT.sites.find((s) => s.kind === k);
  const postSite = site("french"), hamletSite = site("hamlet"), alnSite = site("aln");
  const hamlet = () => E.points.find((p) => p.kind !== "supply");
  const depot = () => E.allPoints.find((p) => p.kind === "supply");
  const post = () => app.algProducers.find((p) => p.structure.typeKey === "post")?.structure ?? null;
  const knoll = MAP.knoll;
  const mine = () => units.list.filter((u) => u.alive && u.team === "player" && !u.isStructure);
  const squads = () => S.list.filter((s) => s.team === "player" && s.members.length);
  const near = (u, p, r) => Math.hypot(u.position.x - p.x, u.position.z - p.z) < r;
  const say = (text, x = null, z = null, kind = "good") => battle.say(text, x, z, kind);

  // ── Helpers for the lessons' ground ───────────────────────────────────────
  const markers = [];   // { x, z, r, color }
  const rings = createSelectionRingField({ app, max: 8, inner: 0.93, segments: 64, opacity: 0.85 });
  app.addPreRenderHook(() => {
    rings.begin();
    for (const m of markers) rings.add(m.x, m.z, m.r, m.color ?? 0xf2c94c);
    for (const u of state.hunt ?? []) if (u.alive) rings.add(u.position.x, u.position.z, 1.5, 0xe0574a);   // the last of a band, ringed red
    rings.commit();
  });
  /** Some FLN fighters at (x, z): `hold` = targets that do not shoot; `row` = in a line along X (behind a wall). */
  function fighters(n, x, z, { hold = false, spread = 3, row = false, type = "moudjahid" } = {}) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, r = k ? spread : 0;
      const px = row ? x + (k - (n - 1) / 2) * spread : x + Math.cos(a) * r, pz = row ? z : z + Math.sin(a) * r;
      const u = units.spawn(type, px, pz, { team: "enemy" });
      if (!u) continue;
      u.holdFire = hold;
      u.faceToward?.(postSite.x, postSite.z);
      out.push(u);
    }
    return out;
  }
  /**
   * A sandbag wall near (x, z) facing `toward`, built at once: the nearest clear spot (the post's
   * sheds and the hamlet's walls take some ground). Returns { x, z, behind } — `behind` the side
   * to shelter on — or null.
   */
  async function wall(x, z, toward) {
    const b = app.algBuild;
    if (!b) return null;
    const fx = toward.x - x, fz = toward.z - z, l = Math.hypot(fx, fz) || 1;
    const yaw = Math.atan2(fx, fz);   // the wall runs ACROSS the line to `toward` (yaw 0 = along X)
    for (let r = 0; r <= 30; r += 3) {
      for (let k = 0, n = r ? 8 : 1; k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (!b.survey("sandbags", px, pz, yaw).ok) continue;
        app.algEconomy?.french.earn(b.costOf("sandbags"));
        const s = await b.place("sandbags", px, pz, yaw, [], { stay: true });
        if (!s) continue;
        s.progress = 1;
        return { x: px, z: pz, behind: { x: px - (fx / l) * 3, z: pz - (fz / l) * 3 } };
      }
    }
    console.warn("[tutorial] no ground for the sandbags near", x, z);
    return null;
  }
  const allDead = (list) => list.length > 0 && list.every((u) => !u.alive);

  // ── The lessons ───────────────────────────────────────────────────────────
  const view = () => app.rtsCamera?.getView?.();
  const L = [];
  // 1. the camera
  L.push({
    title: t("La caméra"),
    text: t("Déplacez la caméra avec <kbd>Z Q S D</kbd> (ou <kbd>W A S D</kbd>, ou les flèches, ou la souris au bord de l'écran), tournez-la avec <kbd>A</kbd> / <kbd>E</kbd> (<kbd>Q</kbd> / <kbd>E</kbd> sur un clavier QWERTY), zoomez à la molette."),
    start(s) { const v = view(); s.v0 = { x: v.focus.x, z: v.focus.z, yaw: v.yaw, h: v.height }; },
    done(s) {
      const v = view();
      if (Math.hypot(v.focus.x - s.v0.x, v.focus.z - s.v0.z) > 20) s.moved = true;
      if (Math.abs(v.yaw - s.v0.yaw) > 0.25) s.turned = true;
      if (Math.abs(v.height - s.v0.h) > 5) s.zoomed = true;
      return s.moved && s.turned && s.zoomed;
    },
    sub: (s) => [s.moved ? "✓" : "·", t("déplacer"), s.turned ? "✓" : "·", t("tourner"), s.zoomed ? "✓" : "·", t("zoomer")].join(" "),
  });
  // 2. select
  L.push({
    title: t("Sélectionner"),
    text: t("Cliquez sur un de vos soldats : tout son <b>groupe</b> est sélectionné (des cercles bleus sous les hommes, sa fiche en bas). Encadrer à la souris en sélectionne plusieurs. Plus tard : <kbd>Ctrl</kbd> + un chiffre garde une sélection, le chiffre la rappelle."),
    start() { const s = squads()[0]; if (s) app.rtsCamera?.focusOn(s.members[0].position.x, s.members[0].position.z); },
    done: () => (app.selection?.selected ?? []).some((u) => u.team === "player" && u.squad),
  });
  // 3. move
  L.push({
    title: t("Se déplacer"),
    text: t("<b>Clic droit</b> sur le sol : le groupe sélectionné y va. Amenez-le dans le cercle jaune, sur la piste. Pour choisir où il fera face, <b>maintenez le clic droit et glissez</b> : une flèche montre la direction, des anneaux la place de chaque homme."),
    start(s) { s.m = { x: 4, z: 70, r: 7 }; markers.push(s.m); },
    done: (s) => squads().some((q) => q.members.filter((u) => near(u, s.m, s.m.r + 1)).length >= 3),
    end(s) { markers.splice(markers.indexOf(s.m), 1); },
  });
  // 4. cover
  L.push({
    title: t("La couverture"),
    text: t("Derrière un mur, on survit ; à découvert, non. Maintenez <kbd>V</kbd> : <b>vert</b> = couverture lourde, <b>jaune</b> = légère. Envoyez le groupe derrière les sacs de sable : sous le curseur, chaque homme montre la couverture qu'il aura."),
    async start(s) {
      const w = await wall(30, 52, { x: 30, z: 0 }) ?? { x: 30, z: 52, behind: { x: 30, z: 55 } };   // the bags face north
      s.m = { ...w.behind, r: 5 }; markers.push(s.m);
      app.rtsCamera?.focusOn(w.x, w.z + 4);
    },
    done: (s) => squads().some((q) => q.members.filter((u) => near(u, s.m, 7) && (app.algCover?.coverAt?.(u.position.x, u.position.z) ?? 0) > 0.25).length >= 3),
    end(s) { markers.splice(markers.indexOf(s.m), 1); },
  });
  // 4b. THE SAPPERS (2026-10-11, your review: "the sapper squad you start with — nothing says what
  // it is for"): build your own cover. Done when a sandbag wall YOU placed is finished.
  L.push({
    title: t("Les sapeurs"),
    text: t("Vos <b>sapeurs</b> (le petit groupe de 3) bâtissent : sélectionnez-les, cliquez <b>Construire</b> puis <b>Sacs de sable</b> sur leur fiche, et posez le mur d'un clic gauche (<kbd>R</kbd> le tourne, clic droit annule). Ils vont le monter — un abri à vous, où vous voulez. Ils posent aussi des barbelés, coupent ceux de l'ennemi (<kbd>X</kbd>) et réparent les véhicules (<kbd>J</kbd>)."),
    start(s) {
      let q = squads().find((x) => x.typeKey === "sapeur");
      if (!q) {   // (lost earlier: a fresh squad at the post's gate)
        const men = [0, 1, 2].map((k) => units.spawn("sapeur", postSite.x + 10 + k * 1.5, postSite.z - 26, { team: "player" })).filter(Boolean);
        S.adopt(men, "sapeur");
        q = squads().find((x) => x.typeKey === "sapeur");
      }
      E.french.earn(app.algBuild?.costOf?.("sandbags") * 2 || 40);
      s.seen = new Set(app.algBuild?.sites ?? []);   // the lessons' own walls: not the player's
      s.mine = [];
      if (q) { app.selection?.select(q.members); app.rtsCamera?.focusOn(q.members[0].position.x, q.members[0].position.z); }
    },
    tick(s) {
      for (const site of app.algBuild?.sites ?? []) if (!s.seen.has(site)) { s.seen.add(site); if (site.team === "player" && site.key === "sandbags") s.mine.push(site); }
    },
    done: (s) => s.mine.some((site) => site.done),
    sub: (s) => (s.mine.some((site) => site.done) ? `✓ ${t("mur monté")}` : s.mine.length ? `✓ ${t("mur posé")} · ${t("les sapeurs le montent")}` : t("posez un mur de sacs de sable")),
  });
  // 5. take the village
  L.push({
    title: t("Prendre un village"),
    text: t("Les villages sont l'enjeu : chacun rapporte et compte comme point de victoire. Postez des <b>hommes à pied</b> dans le cercle de la <b>Mechta d'exercice</b> : son anneau se remplit vers vous (plus ils sont nombreux, plus c'est rapide). Ses habitants ne sont pas des cibles : quand on tire, ils rentrent chez eux."),
    start() { const v = hamlet(); if (v) app.rtsCamera?.focusOn(v.position.x, v.position.z); },
    done: () => hamlet()?.owner === "player",
    sub: () => { const v = hamlet(); return v ? t("{pct} % vers vous", { pct: Math.max(0, Math.round(v.value * 100)) }) : ""; },
  });
  // 5b. THE HOUSES (2026-10-11, your review): a garrison — in, then out with SORTIR (K).
  const inside = () => mine().filter((u) => u.garrison);
  L.push({
    title: t("Les maisons"),
    text: t("Un mur protège ; une <b>maison</b> protège mieux. Groupe sélectionné, <b>clic droit sur une maison</b> de la mechta (le curseur devient une maison) : les hommes entrent et tirent par les fenêtres. Une grenade ou un obus les en chasse. Pour ressortir : <b>Sortir</b> (<kbd>K</kbd>), ou un simple ordre de marche."),
    start() { const v = hamlet(); if (v) app.rtsCamera?.focusOn(v.position.x, v.position.z); },
    done(s) {
      if (inside().length >= 3) s.in = true;
      return !!s.in && !inside().length;
    },
    sub: (s) => `${s.in ? "✓" : "·"} ${t("entrer dans une maison")} · ${t("ressortir")}`,
  });
  // 6. supply
  L.push({
    title: t("Le ravitaillement"),
    text: t("Le <b>carburant</b> et les <b>munitions</b> viennent des villages et des <b>points de ravitaillement</b> sur les pistes — s'ils sont <b>reliés au poste</b> par des points à vous. Prenez le <b>dépôt de munitions</b> sur la piste."),
    start() { const d = depot(); if (d) app.rtsCamera?.focusOn(d.position.x, d.position.z); },
    done: () => depot()?.owner === "player",
  });
  // 6b. HOW A BATTLE IS WON (2026-10-11, your review: the training never showed the score). The bar
  // appears from here on and the score runs (the drain: 0.175 a second per village of difference —
  // the FLN's 500 would last ~48 min against the one mechta, so it can't end the training).
  L.push({
    title: t("Gagner la bataille"),
    text: t("En haut, la <b>barre de score</b> : vous en bleu, le FLN en rouge, 500 points chacun. Le camp qui tient <b>moins de villages</b> perd des points chaque seconde, d'autant plus vite que l'écart est grand ; à zéro, il a perdu. Prendre la grotte du FLN, ou perdre votre poste, finit aussi la bataille. Un village <b>coupé du poste</b> (orange) compte, mais ne rapporte rien. Regardez le score du FLN baisser."),
    start(s) {
      document.body.classList.add("alg-tut-score");
      battle.rules.score = true;
      s.e0 = battle.score?.enemy ?? null;
    },
    done: (s) => s.e0 == null || battle.score.enemy <= s.e0 - 2,
    // (The mechta not yours — its lesson skipped, or lost: nothing drains; say what to do.)
    sub: (s) => (s.e0 == null ? "" : E.held > E.heldByEnemy ? t("FLN : {n} points", { n: Math.ceil(battle.score.enemy) }) : t("tenez la mechta : le score du FLN baissera")),
  });
  // 7. attack
  L.push({
    title: t("Attaquer"),
    text: t("Trois cibles au nord du village (elles ne tirent pas). Sélectionnez un groupe et faites <b>clic droit sur un ennemi</b> : le curseur devient un viseur rouge, vos hommes l'attaquent."),
    start(s) { s.f = fighters(3, 20, -46, { hold: true, spread: 3 }); app.rtsCamera?.focusOn(10, -30); },
    done: (s) => allDead(s.f),
  });
  // 7b. the shepherd (the moussebel, algCivilians.js): the farmstead west of the track
  L.push({
    title: t("Le berger"),
    text: t("Le FLN a ses auxiliaires, les <b>moussebels</b> : habillés comme tout le monde, ils prennent le fusil quand vous approchez. Un berger garde la <b>ferme</b> à l'ouest de la piste. Allez-y avec un groupe — de préférence d'abri en abri — et neutralisez-le s'il tire."),
    start(s) {
      s.a = app.algCivilians?.auxes?.[0] ?? null;
      const p = s.a?.u.position ?? { x: MAP.farmsteads?.[0]?.x ?? -58, z: MAP.farmsteads?.[0]?.z ?? 64 };
      s.m = { x: p.x, z: p.z, r: 10, color: 0xe0574a }; markers.push(s.m);
      app.rtsCamera?.focusOn(p.x - 6, p.z - 8);   // (north of him: the farm mid-screen, clear of the panel)
    },
    done(s) {
      if (!s.a) return true;   // no civilians (?civ=0): nothing to teach here
      if (s.a.fighter) s.f = [s.a.fighter];   // (a skip clears him)
      return s.a.revealed && !!s.a.fighter && !s.a.fighter.alive;
    },
    sub: (s) => (s.a?.revealed ? `✓ ${t("il a tiré")} · ${t("neutralisez-le")}` : t("approchez de la ferme")),
    end(s) {
      markers.splice(markers.indexOf(s.m), 1);
      if (s.a && !s.a.revealed) { s.a.revealed = true; s.a.u.inside = true; }   // skipped before he showed: gone
    },
  });
  // 8. assault
  L.push({
    title: t("L'assaut"),
    text: t("Un simple clic droit, c'est un ordre de marche : vos hommes avancent sans s'arrêter. <kbd>Ctrl</kbd> + <b>clic droit</b> (ou <kbd>N</kbd> puis un clic), c'est l'<b>assaut</b> : ils s'arrêtent pour tirer sur ce qu'ils rencontrent, puis continuent. Lancez un assaut sur la <b>butte</b> à l'est : elle est tenue."),
    start(s) { s.m = { x: knoll.x, z: knoll.z, r: 9, color: 0xe0574a }; markers.push(s.m); s.f = fighters(3, knoll.x + 2, knoll.z - 3, { spread: 3 }); app.rtsCamera?.focusOn(knoll.x - 20, knoll.z + 20); },
    done: (s) => allDead(s.f) && mine().some((u) => near(u, s.m, s.m.r + 3)),
    end(s) { markers.splice(markers.indexOf(s.m), 1); },
  });
  // 9. grenade
  L.push({
    title: t("La grenade"),
    text: t("Des hommes retranchés derrière des sacs de sable : à découvert, vous ne les délogerez pas. Sélectionnez un groupe, <kbd>G</kbd> (ou le bouton <b>Grenade</b>, 15 munitions), puis cliquez sur eux. La fumée (<kbd>B</kbd>) aveugle, elle aussi."),
    async start(s) {
      const w = await wall(-58, -75, { x: -58, z: 0 }) ?? { x: -58, z: -75 };   // the bags face the French (south)
      const at = { x: w.x, z: w.z - 1.6 };                                          // the men tight behind them
      s.f = fighters(3, at.x, at.z, { spread: 2.4, row: true });
      s.g0 = app.algGrenades?.thrown?.grenade ?? 0;
      E.french.earn({ mun: 60 });
      app.rtsCamera?.focusOn(at.x, at.z + 25);
    },
    done: (s) => (app.algGrenades?.thrown?.grenade ?? 0) > s.g0 && allDead(s.f),
    sub: (s) => ((app.algGrenades?.thrown?.grenade ?? 0) > s.g0 ? `✓ ${t("grenade lancée")}` : t("une grenade sur eux")),
  });
  // 10. retreat, reinforce
  L.push({
    title: t("Retraite et renfort"),
    text: t("Un groupe affaibli : l'instructeur vous retire deux hommes. <b>Retraite</b> (<kbd>T</kbd>) le ramène au poste en courant — il ne tire plus, il est moins touché, et s'y soigne. Au poste, <b>Renforcer</b> (<kbd>Y</kbd>) : chaque clic fait sortir un homme par la porte, jusqu'à remplir le groupe."),
    start(s) {
      const q = squads().find((x) => x.typeKey === "appele" && x.count >= 4) ?? squads()[0];
      s.q = q;
      if (q) { q.members.slice(-2).forEach((u) => u.takeDamage(1e6)); q.members.forEach((u) => { u.hp = Math.min(u.hp, u.maxHp * 0.55); }); app.selection?.select(q.members); app.rtsCamera?.focusOn(q.members[0].position.x, q.members[0].position.z); }
      E.french.earn({ mp: 120 });
    },
    done(s) { if (s.q?.retreating) s.ran = true; return !!s.ran && s.q && s.q.count >= s.q.size; },
    sub: (s) => `${s.ran ? "✓" : "·"} ${t("retraite")} · ${s.q ? `${s.q.count}/${s.q.size}` : ""} ${t("hommes")}`,
  });
  // 11. the post
  L.push({
    title: t("Le poste"),
    text: t("Le poste forme vos troupes. Cliquez dessus : sa fiche montre ce qu'il produit, avec leur prix (effectifs, carburant, munitions). Formez un groupe d'<b>Appelés</b> — il sort par la porte."),
    start(s) { s.n0 = S.list.filter((q) => q.team === "player").length; E.french.earn({ mp: 300 }); const p = post(); if (p) app.rtsCamera?.focusOn(p.position.x, p.position.z); },
    done: (s) => S.list.filter((q) => q.team === "player" && q.count > 0).length > s.n0,
  });
  // 12. the tier
  L.push({
    title: t("Les échelons"),
    text: t("Les unités plus fortes sont <b>verrouillées</b> : elles s'ouvrent par échelon, au poste. Sur sa fiche, cliquez <b>▲ Moyens héliportés</b> (il faut tenir un village) : paras, Alouette et half-track."),
    start() { E.french.earn({ mp: 200, fuel: 60 }); const p = post(); if (p) { app.rtsCamera?.focusOn(p.position.x, p.position.z); app.selection?.select([p]); } },
    done: () => (app.algTiers?.tier ?? 1) >= 2,
  });
  // 13. the half-track
  L.push({
    title: t("Le half-track"),
    text: t("Un half-track vous attend devant le poste. Groupe sélectionné, <b>clic droit sur le half-track</b> : les hommes montent (à l'abri, ils ne tirent pas). Conduisez-le près de la mechta, puis <b>Débarquer</b> (<kbd>K</kbd>). À l'arrêt, il sert aussi de point de <b>renfort</b> pour les groupes proches."),
    start(s) {
      const p = postSite;
      s.ht = units.spawn("halftrack", p.x + 12, p.z - 30, { team: "player" });
      s.ht?.faceToward?.(hamletSite.x, hamletSite.z);
      if (s.ht) app.rtsCamera?.focusOn(s.ht.position.x, s.ht.position.z);
    },
    done(s) {
      const T = app.algTransports;
      if (s.ht && T?.menOf(s.ht).length) s.boarded = true;
      return !!s.boarded && s.ht && T && !T.menOf(s.ht).length && squads().some((q) => q.members.some((u) => near(u, hamletSite, hamletSite.r + 25) && Math.hypot(u.position.x - s.ht.position.x, u.position.z - s.ht.position.z) < 25));
    },
    sub: (s) => `${s.boarded ? "✓" : "·"} ${t("embarquer")} · ${t("débarquer près de la mechta")}`,
  });
  // 14. the final
  L.push({
    title: t("L'attaque"),
    text: t("Une bande du FLN descend sur la mechta ! Tenez-la : vos hommes à couvert dans le village, l'<b>assaut</b> pour les accrocher, une <b>grenade</b> sur un groupe retranché. Si un groupe faiblit : <b>Retraite</b>."),
    start(s) {
      s.f = fighters(7, alnSite.x, alnSite.z + 10, { spread: 4 });
      s.goal = new Map(s.f.map((u) => [u, { x: hamletSite.x + (Math.random() - 0.5) * 16, z: hamletSite.z + (Math.random() - 0.5) * 16 }]));
      for (const u of s.f) u.orderTo(s.goal.get(u).x, s.goal.get(u).z);
      say(t("<b>Contact !</b> Une bande du FLN marche sur la Mechta d'exercice."), hamletSite.x, hamletSite.z, "bad");
      app.algVoices?.radio?.("hq_contact");
    },
    // The FLN's AI is off here: a man who stopped to fight (combat halts him) and has nobody left
    // in sight marches on to the mechta, as an attack-move would.
    // The last three, dug into a courtyard, can sit out of sight: they are ringed red to go and find.
    tick(s) {
      for (const u of s.f) if (u.alive && !u.isMoving && !u.target) { const g = s.goal.get(u); if (Math.hypot(u.position.x - g.x, u.position.z - g.z) > 4) u.orderTo(g.x, g.z); }
      const left = s.f.filter((u) => u.alive);
      if (left.length <= 3 && !s.hunt) { s.hunt = left; say(t("Les derniers rebelles se terrent dans la mechta (cerclés de rouge) : allez les chercher."), left[0]?.position.x, left[0]?.position.z, ""); }
    },
    done: (s) => allDead(s.f) && hamlet()?.owner === "player",
    sub: (s) => t("{n} rebelles restants", { n: s.f.filter((u) => u.alive).length }),
  });

  // ── The panel ─────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
/* The training: its lessons are the objectives; the score bar only from "Gagner la bataille" on. */
body:not(.alg-tut-score) #alg-score, #alg-obj { display: none !important; }
/* The score bar shown: the panel BELOW it (both at the top centre — it hid the bar it talks about). */
body.alg-tut-score #alg-tut { top: calc(16px + 38px * var(--alg-ui, 1)); }
#alg-tut { position: fixed; top: 14px; left: calc((100vw - var(--alg-dev-w, 0px)) / 2); transform: translateX(-50%); z-index: 57;
  width: min(560px, 76vw); padding: 10px 14px 12px; background: var(--hud-bg, rgba(16,14,10,0.9)); border: 1px solid var(--hud-brass, #c9a54a);
  border-radius: var(--hud-radius, 3px); box-shadow: 0 6px 18px rgba(0,0,0,0.45); font-family: var(--hud-sans, sans-serif); color: var(--hud-text, #e8dcc4); }
#alg-tut[hidden] { display: none; }
#alg-tut .k { display: flex; justify-content: space-between; align-items: baseline; font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: var(--hud-brass, #c9a54a); }
#alg-tut h3 { margin: 4px 0 6px; font-size: 16px; letter-spacing: 0.02em; color: #f1dfa6; }
#alg-tut .tx { font-size: 13px; line-height: 1.5; }
#alg-tut .tx kbd { font: 11px var(--hud-mono, monospace); padding: 0 5px; border: 1px solid rgba(201,165,74,0.6); border-radius: 2px; }
#alg-tut .sb { margin-top: 6px; font-size: 12px; color: var(--hud-dim, #a8987a); }
#alg-tut .row { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
#alg-tut .bar { flex: 1; height: 3px; margin-right: 12px; background: rgba(234,223,200,0.15); }
#alg-tut .bar i { display: block; height: 100%; background: #c9a54a; transition: width 0.4s; }
#alg-tut button { padding: 3px 10px; font: 600 11px var(--hud-sans, sans-serif); letter-spacing: 0.06em; color: var(--hud-text, #e8dcc4);
  background: transparent; border: 1px solid rgba(201,165,74,0.5); border-radius: 2px; cursor: pointer; }
#alg-tut button:hover { border-color: #f1dfa6; color: #f1dfa6; }
#alg-tut.done h3::after { content: "  ✓"; color: #58e070; }`;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.id = "alg-tut";
  el.hidden = true;
  el.innerHTML = `<div class="k"><span>${t("Instruction")}</span><span class="n"></span></div><h3></h3><div class="tx"></div><div class="sb"></div>
    <div class="row"><div class="bar"><i></i></div><button type="button" data-a="skip">${t("Passer ›")}</button></div>`;
  document.body.appendChild(el);
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.querySelector('[data-a="skip"]').addEventListener("click", () => next());

  let i = -1, state = {}, tickT = 0, waitT = 0, running = false, finished = false;
  async function begin(k) {
    i = k;
    state = {};
    const l = L[i];
    el.classList.remove("done");
    el.querySelector(".n").textContent = `${i + 1} / ${L.length}`;
    el.querySelector("h3").textContent = l.title;
    el.querySelector(".tx").innerHTML = l.text;
    el.querySelector(".sb").textContent = "";
    el.querySelector(".bar i").style.width = `${(100 * i) / L.length}%`;
    try { await l.start?.(state); } catch (e) { console.warn("[tutorial] start", e); }
    state.ready = true;
  }
  function next() {
    if (i >= 0) {
      try { L[i].end?.(state); } catch { /* */ }
      // A skipped lesson's FLN would stand in the next one's way: the range is cleared.
      if (!el.classList.contains("done")) for (const u of state.f ?? []) if (u.alive) u.takeDamage(1e6);
    }
    waitT = 0;
    if (i + 1 >= L.length) return finish();
    begin(i + 1);
  }
  function finish() {
    if (finished) return;
    finished = true;
    el.hidden = true;
    app.algVoices?.radio?.("hq_victory");
    const back = hud.end(`
      <div class="kicker">${t("Camp d'instruction")}</div>
      <h2 class="win">${t("Instruction terminée")}</h2>
      <p>${t("Vous savez déplacer et abriter vos hommes, bâtir avec les sapeurs, tenir une maison, prendre et relier des points, gagner au score, attaquer, lancer un assaut et des grenades, battre en retraite et renforcer, former des troupes, débloquer un échelon et transporter un groupe. La suite : les Aurès.")}</p>
      <p>${t("En bataille, le <b>brouillard de guerre</b> couvre la carte : vous ne voyez que ce que vos hommes voient. Le <b>manuel</b> (<kbd>Échap</kbd>) reprend tout.")}</p>
      <p><button type="button" class="go" data-a="aures">${t("Les Aurès — 1956 ›")}</button></p>`, { onReplay: () => location.reload() });
    back?.querySelector?.('[data-a="aures"]')?.addEventListener("click", () => { location.href = "./alg.html"; });
  }
  app.addPreRenderHook((dt) => {
    if (!running || finished || i < 0 || !state.ready) return;
    if ((tickT -= dt) > 0) return;
    tickT = P.tick;
    const l = L[i];
    if (l.sub) el.querySelector(".sb").textContent = l.sub(state);
    try { l.tick?.(state); } catch (e) { console.warn("[tutorial] tick", e); }
    if (waitT > 0) { waitT -= P.tick; if (waitT <= 0) next(); return; }
    let ok = false;
    try { ok = l.done(state); } catch (e) { console.warn("[tutorial] check", e); }
    if (ok) {
      el.classList.add("done");
      el.querySelector(".bar i").style.width = `${(100 * (i + 1)) / L.length}%`;
      app.algSounds?.audio?.play?.("radio", null, 0, 0, { gain: 0.5 });
      waitT = P.nextDelay;
    }
  });

  return {
    lessons: L,
    get step() { return i; },
    next, finish,
    /** Start the lessons (the briefing's button, or ?brief=0). */
    start() {
      if (running) return;
      running = true;
      app.algBattle?.start?.("easy");
      el.hidden = false;
      begin(0);
    },
    /** The training's briefing (instead of the battle's), shown during the boot. */
    brief({ ready = null } = {}) {
      return hud.briefing(`
        <div class="kicker">${t("Algérie, 1956 · Camp d'instruction")}</div>
        <h2>${t("Instruction")}</h2>
        <p>${t("Avant le djebel, le camp. Quinze leçons courtes : la caméra, les ordres, la couverture, les villages et le ravitaillement, le combat, les moussebels, la retraite, le poste et ses échelons, le half-track — puis une vraie bande du FLN.")}</p>
        <p>${t("Chaque leçon s'affiche en haut de l'écran et passe d'elle-même une fois faite. <b>Passer</b> saute celle que vous connaissez. <kbd>Échap</kbd> : pause, options, manuel.")}</p>`,
        () => this.start(), { ready });
    },
    dispose() { el.remove(); style.remove(); },
  };
}
