// THE BATTLE — what the fight is FOR, and telling the player what is going on
// (you, 2026-10-01: "no enemies, what should I do with the village? I'm very
// confused"). The systems were all there; the game never said so.
//
// WIN RULE — Company of Heroes' victory points, with this war's prize:
//   · the VILLAGES are the victory points (algEconomy.js points: the hamlets,
//     the dechra, the ksar). Each side starts at 500. Every second, the side
//     holding FEWER villages loses `drain` points per village of difference —
//     hold all four against none and the FLN is gone in ~6 min; one more than
//     them, ~24 min. Neutral villages count for nobody.
//   · first to 0 loses; and outright: the FLN's CAVE destroyed = French
//     victory, the POST destroyed = French defeat.
// The ALN's AI already plays for the villages (algAI.js political work), so
// the rule rewards what both sides were doing: garrison, patrol, strike.
//
// ALERTS — the events a commander must hear about, each with a place (click,
// or Space, to go there; a ping on the minimap): contact, a village turning,
// won or lost, a band seen, a mine spotted / cleared / gone up, a building
// lost or taken out, the post or the cave under fire. Each is throttled per
// place, so a long firefight is one alert, not forty.
//
// It only WATCHES the game (polls units, villages, mines, buildings once a
// frame): no hooks into combat, the AI or the units. ?battle=0 = without.
import { LAYOUT } from "./layout.js";
import { createBattleHud } from "./ui/battleHud.js";
import { DIFFICULTIES, applyDifficulty, storedDifficulty } from "./algDifficulty.js";

const P = {
  start: 500,
  drain: 0.35,          // points a second, per village of difference
  contactEvery: 30,     // s between two contact alerts in one place
  placeM: 90,           // "one place" for throttling, metres
  sightEvery: 45,       // s between two "band seen" alerts in one place
  turnEvery: 60,        // s between two "village turning" alerts, per village
};
// Named places an alert can be "near" (not the cemetery or the koubba: the
// village beside them names it better).
// Each alert's picture (ui/icons.js), CoH's: by the HQ line it comes with.
const ICON_OF = {
  hq_contact: "alertAttack", hq_postAttack: "alertAttack", hq_buildingLost: "alertAttack", hq_vehicleLost: "alertAttack", hq_enemyMG: "alertAttack",
  hq_villageTaken: "alertFlag", hq_villageLost: "alertFlag", hq_villageThreat: "alertFlag",
  hq_enemySeen: "alertSeen", hq_muleTrain: "alertSeen", hq_cacheFound: "alertSeen",
  hq_mine: "alertMine",
};
const KIND_FR = { supply: "point de ravitaillement", hamlet: "mechta", dechra: "dechra", ksar: "ksar" };
const PLACES = LAYOUT.sites.filter((s) => !["cemetery", "koubba"].includes(s.kind));

export function createAlgBattle(app, { units, economy, structures, mines = null, minimap = null, rtsCamera = null }) {
  const cave = structures.list.find((s) => s.typeKey === "caveEntrance");
  const post = structures.list.find((s) => s.typeKey === "post");
  const score = { player: P.start, enemy: P.start };
  const stats = { lostFr: 0, lostAln: 0, startMs: performance.now() };
  let clock = 0, over = null;
  const fog = () => app.fogOfWar;
  const seenByPlayer = (x, z) => !fog()?.enabled || fog().isVisible(x, z);

  const jump = (x, z) => { rtsCamera?.focusOn(x, z); minimap?.ping?.(x, z); };
  const hud = createBattleHud({ camera: app.camera, canvas: app.renderer.domElement, onJump: jump });

  const placeName = (x, z) => {
    let best = null, bd = 170;
    for (const s of PLACES) { const d = Math.hypot(s.x - x, s.z - z); if (d < bd) { bd = d; best = s; } }
    if (best?.kind === "aln") return "à la sortie de leur camp";
    return best ? `près de ${best.name}` : "dans le djebel";
  };
  /** An alert; `radio`: the HQ line said with it (algVoices.js, tools/algVoiceLines.mjs). */
  function say(text, x, z, kind, radio = null, icon = ICON_OF[radio] ?? null) {
    hud.alert(text, { x, z, kind, time: clock, icon });
    if (radio) app.algVoices?.radio(radio);
    if (x != null) minimap?.ping?.(x, z);
  }
  // Throttle: one alert per `key` per place (a 90 m cell) per `every` seconds.
  const lastAt = new Map();
  const throttled = (key, x, z, every) => {
    const k = `${key}:${Math.round(x / P.placeM)}:${Math.round(z / P.placeM)}`;
    if (clock - (lastAt.get(k) ?? -1e9) < every) return true;
    lastAt.set(k, clock);
    return false;
  };

  // ── What was true last frame ──────────────────────────────────────────────
  const hpOf = new WeakMap();                  // unit/building → last hp
  const reported = new WeakSet();              // enemy units already announced
  const villageLast = new Map(economy.points.map((v) => [v, { owner: v.owner, value: v.value, turnAt: -1e9 }]));
  const knownMines = new Map();                // mine → spotted
  const aliveB = new Map(structures.list.map((s) => [s, s.alive]));

  function watchVillages() {
    for (const v of economy.points) {
      const L = villageLast.get(v), { x, z } = v.position;
      if (v.owner !== L.owner) {
        if (v.owner === "player") say(`<b>${v.name}</b> est à vous : il rapporte et compte pour vous.`, x, z, "good", "hq_villageTaken");
        else if (v.owner === "enemy") say(`<b>${v.name}</b> soutient désormais le FLN. Reprenez-le : postez-y des hommes.`, x, z, "bad", "hq_villageLost");
        else if (L.owner === "player") say(`<b>${v.name}</b> vous échappe : le FLN l'a retourné.`, x, z, "bad", "hq_villageLost");
        else if (L.owner === "enemy") say(`<b>${v.name}</b> ne soutient plus le FLN.`, x, z, "good");
        L.owner = v.owner;
      }
      // Turning: FLN men in it and the needle moving their way.
      const falling = v.value < L.value - 1e-4;
      if (falling && v.value > -economy.params.hold && clock - L.turnAt > P.turnEvery) {
        const r = economy.params.radius;
        const aln = units.list.some((u) => u.alive && u.team === "enemy" && u.type?.foot && Math.hypot(u.position.x - x, u.position.z - z) < r);
        if (aln) { L.turnAt = clock; say(`Le FLN travaille <b>${v.name}</b>. Envoyez des hommes avant qu'il ne bascule.`, x, z, "bad", "hq_villageThreat"); }
      }
      L.value = v.value;
    }
  }

  // THE SUPPLY POINTS (2026-10-04, with the ALN's raids in algAI.js): raided, lost, taken,
  // and CUT OFF — a chain broken further back stops the far ones paying (one alert for all).
  const supplyLast = new Map(economy.supply.map((v) => [v, { owner: v.owner, value: v.value, linked: v.linked, raidAt: -1e9 }]));
  const resName = (v) => (v.res === "fuel" ? "carburant" : "munitions");
  const shortName = (v) => v.name.split(" · ")[0];
  function watchSupply() {
    const cut = [];
    for (const v of economy.supply) {
      const L = supplyLast.get(v), { x, z } = v.position;
      if (v.owner !== L.owner) {
        if (v.owner === "player") say(`<b>${shortName(v)}</b> est à vous : +${economy.params.supplyPoint} ${resName(v)} par minute tant qu'il est relié au poste.`, x, z, "good", null, "alertFlag");
        else if (L.owner === "player") say(`<b>${shortName(v)}</b> perdu : plus de ${resName(v)} de ce côté.`, x, z, "bad", "hq_villageLost", "alertFlag");
        L.owner = v.owner;
      }
      // Raided: FLN men in its ring and the needle going their way.
      if (v.owner === "player" && v.value < L.value - 1e-4 && clock - L.raidAt > 45) {
        const aln = units.list.some((u) => u.alive && u.team === "enemy" && u.type?.foot && Math.hypot(u.position.x - x, u.position.z - z) < v.radius);
        if (aln) { L.raidAt = clock; say(`<b>Raid du FLN</b> sur ${shortName(v)} ! Le dépôt est à eux si vous n'envoyez personne.`, x, z, "bad", "hq_contact", "alertAttack"); }
      }
      L.value = v.value;
      if (L.linked && !v.linked && v.owner === "player") cut.push(v);
      L.linked = v.linked;
    }
    // Villages cut off count too (they pay nothing either).
    for (const v of economy.points) {
      const L = villageLast.get(v);
      if (L.linked && !v.linked && v.owner === "player") cut.push(v);
      L.linked = v.linked;
    }
    if (cut.length) {
      const names = cut.map(shortName).join(", ");
      say(`<b>Coupé</b> : ${names} — plus relié${cut.length > 1 ? "s" : ""} au poste, ${cut.length > 1 ? "ils ne rapportent" : "il ne rapporte"} plus rien. Reprenez le point entre les deux.`, cut[0].position.x, cut[0].position.z, "bad", null, "alertCut");
    }
  }

  function watchUnits() {
    for (const u of units.list) {
      const was = hpOf.get(u);
      hpOf.set(u, u.alive ? u.hp : 0);
      if (was == null) continue;
      const { x, z } = u.position;
      if (u.team === "player") {
        if (u.hp < was - 1e-6 || (was > 0 && !u.alive)) {
          if (!u.alive) stats.lostFr++;
          if (!throttled("contact", x, z, P.contactEvery)) { say(`<b>Contact</b> ${placeName(x, z)} !`, x, z, "bad", "hq_contact"); told.add("contactSeen"); }
          else if (!u.alive && !u.type?.foot && !throttled(`lost:${u.typeKey}`, x, z, 10)) say(`${u.type?.name ?? "Un véhicule"} détruit ${placeName(x, z)}.`, x, z, "bad", "hq_vehicleLost");
        }
      } else if (u.team === "enemy") {
        if (was > 0 && !u.alive) stats.lostAln++;
        // A band seen: the first sight of these men, away from their cave.
        if (u.alive && !reported.has(u) && seenByPlayer(x, z) && (!cave || Math.hypot(x - cave.position.x, z - cave.position.z) > 80)) {
          let n = 0;
          for (const o of units.list) {
            if (o.alive && o.team === "enemy" && Math.hypot(o.position.x - x, o.position.z - z) < 35) { n++; reported.add(o); }
          }
          if (!throttled("sight", x, z, P.sightEvery)) { say(`${n > 1 ? `Bande du FLN (${n}) repérée` : "Combattant du FLN repéré"} ${placeName(x, z)}.`, x, z, "", "hq_enemySeen"); told.add("bandSeen"); }
        }
        // The first FLN machine gun seen: say so — it is what pins a section.
        if (u.alive && u.typeKey === "fmTeam" && !told.has("mgSeen") && seenByPlayer(x, z) && (!cave || Math.hypot(x - cave.position.x, z - cave.position.z) > 80)) {
          told.add("mgSeen");
          say(`<b>Mitrailleuse du FLN</b> ${placeName(x, z)} ! Elle cloue au sol les hommes à découvert.`, x, z, "bad", "hq_enemyMG");
        }
      }
    }
  }

  // THE FLN MULE TRAIN (algAI.js): seen → an alert (intercept it); killed →
  // the arms are lost; arrived unseen → nothing (you never knew).
  let lastConvoySeen = null, lastConvoyDone = null;
  function watchConvoy() {
    const ai = app.algAI;
    const c = ai?.convoy;
    if (c && c !== lastConvoySeen) {
      const m = c.men.find((u) => u.alive && seenByPlayer(u.position.x, u.position.z));
      if (m) {
        lastConvoySeen = c; c.seen = true;
        say(`<b>Convoi de mulets du FLN</b> ${placeName(m.position.x, m.position.z)} ! Des armes pour une cache — interceptez-le.`, m.position.x, m.position.z, "bad", "hq_muleTrain");
        advise("convoy", "Un convoi de mulets ravitaille le FLN et arme une cache d'une mitrailleuse de plus. Abattez son escorte et la cargaison est perdue.");
      }
    }
    const d = ai?.lastConvoy;
    if (d && d !== lastConvoyDone) {
      lastConvoyDone = d;
      if (d.outcome === "lost" && d.seen) say("<b>Convoi détruit</b> : ses armes sont perdues.", d.men[0]?.position.x, d.men[0]?.position.z, "good");
      else if (d.outcome === "arrived" && d.seen) say("Le convoi a atteint sa cache : une mitrailleuse de plus pour le FLN.", d.to.position.x, d.to.position.z, "bad");
    }
  }

  function watchMines() {
    if (!mines) return;
    const now = new Set(mines.list);
    for (const m of now) {
      const was = knownMines.get(m);
      if (was === false && m.spotted) say(`Une <b>mine</b> repérée sur la piste ${placeName(m.x, m.z)}. Des hommes à pied peuvent la déminer.`, m.x, m.z, "", "hq_mine");
      knownMines.set(m, m.spotted);
    }
    for (const [m] of knownMines) {
      if (now.has(m)) continue;
      knownMines.delete(m);
      if (m.clearT >= (mines.params?.clearTime ?? 1e9)) say(`Mine désamorcée ${placeName(m.x, m.z)}.`, m.x, m.z, "good");
      else say(`Une <b>mine</b> a sauté ${placeName(m.x, m.z)} !`, m.x, m.z, "bad", "hq_mine");
    }
  }

  const foundCaches = new WeakSet();
  // Hidden FLN places, and what finding one is worth.
  const FOUND = {
    armsCache: "<b>Cache d'armes du FLN découverte</b> ! Détruisez-la : plus de mitrailleuses de là.",
    refuge: "<b>Refuge du FLN découvert</b> ! Ses bandes s'y cachent et en ressortent sans rien coûter. Détruisez-le.",
    lookout: "<b>Guetteur du FLN découvert</b> sur la crête ! Il signale vos mouvements aux bandes. Éliminez-le et leurs embuscades deviennent aveugles.",
  };
  function watchBuildings() {
    for (const s of structures.list) {
      const was = aliveB.get(s);
      aliveB.set(s, s.alive);
      const { x, z } = s.position;
      if (was && !s.alive) say(`${s.name ?? "Un bâtiment"} détruit.`, x, z, s.team === "player" ? "bad" : "good", s.team === "player" ? "hq_buildingLost" : null);
      // A hidden cache comes into sight.
      if (FOUND[s.typeKey] && s.alive && !foundCaches.has(s) && fog()?.enabled && fog().isVisible(x, z)) {   // seen, not the dev switch turning the fog off
        foundCaches.add(s);
        if (clock > 2) say(FOUND[s.typeKey], x, z, "good", s.typeKey === "armsCache" ? "hq_cacheFound" : null);
      }
      const hp = hpOf.get(s);
      hpOf.set(s, s.hp);
      if (hp != null && s.alive && s.hp < hp - 1e-6) {
        if (s === post && !throttled("post", x, z, 30)) say("<b>Le poste est attaqué !</b>", x, z, "bad", "hq_postAttack");
        else if (s === cave && !throttled("cave", x, z, 45)) say("La grotte est sous le feu. Détruisez-la pour gagner.", x, z, "good");
      }
    }
  }

  // ── The rule ──────────────────────────────────────────────────────────────
  function stepScore(dt) {
    const fr = economy.held, al = economy.heldByEnemy, diff = fr - al;
    if (diff > 0) score.enemy = Math.max(0, score.enemy - P.drain * diff * dt);
    else if (diff < 0) score.player = Math.max(0, score.player + P.drain * diff * dt);
    let end = null;
    if (cave && !cave.alive) end = { winner: "player", why: "La grotte du FLN est détruite : la katiba n'a plus où aller." };
    else if (post && !post.alive) end = { winner: "enemy", why: "Le poste est tombé." };
    else if (score.enemy <= 0) end = { winner: "player", why: "Les villages sont à vous : le FLN a perdu la vallée." };
    else if (score.player <= 0) end = { winner: "enemy", why: "Les villages sont passés au FLN : Paris rappelle la compagnie." };
    if (end) finish(end);
  }

  function finish(end) {
    over = end;
    const win = end.winner === "player";
    say(win ? "<b>Victoire.</b>" : "<b>Défaite.</b>", null, null, win ? "good" : "bad", win ? "hq_victory" : "hq_defeat");
    hud.end(`
      <div class="kicker">Aurès · ${fmt(clock)}</div>
      <h2 class="${win ? "win" : "lose"}">${win ? "Victoire" : "Défaite"}</h2>
      <p>${end.why}</p>
      <table>
        <tr><td>Score</td><td>France ${Math.ceil(score.player)} · FLN ${Math.ceil(score.enemy)}</td></tr>
        <tr><td>Villages tenus</td><td>France ${economy.held} · FLN ${economy.heldByEnemy} · sur ${economy.points.length}</td></tr>
        <tr><td>Hommes et véhicules perdus</td><td>France ${stats.lostFr} · FLN ${stats.lostAln}</td></tr>
      </table>`, { onReplay: () => location.reload() });
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ── OBJECTIVES (top left): what to do now, always in view ────────────────
  const home = post?.position ?? { x: 0, z: 0 };
  const ownerName = (o) => (o === "player" ? "à vous" : o === "enemy" ? "tenu par le FLN" : "neutre");
  let objT = 0;
  function objectives(dt) {
    if ((objT -= dt) > 0) return;
    objT = 0.5;
    const fr = economy.held, al = economy.heldByEnemy;
    const list = [{
      text: "Tenir plus de villages que le FLN",
      sub: `Vous ${fr} · FLN ${al} sur ${economy.points.length} — ${fr > al ? "le FLN perd des points" : fr < al ? "<b style='color:var(--hud-red)'>vous perdez des points</b>" : "égalité : personne ne perd"}`,
      state: fr > al ? "done" : fr < al ? "bad" : "",
    }];
    // The next village to take: the nearest one not yours (to the post).
    const todo = economy.points.filter((v) => v.owner !== "player")
      .sort((a, b) => Math.hypot(a.position.x - home.x, a.position.z - home.z) - Math.hypot(b.position.x - home.x, b.position.z - home.z))[0];
    if (todo) {
      const fln = units.list.filter((u) => u.alive && u.team === "enemy" && Math.hypot(u.position.x - todo.position.x, u.position.z - todo.position.z) < economy.params.radius).length;
      list.push({
        text: `Prendre ${todo.name}`,
        sub: `${ownerName(todo.owner)}${fln ? ` · <b style='color:var(--hud-red)'>${fln} FLN à l'intérieur</b>` : ""} · postez des hommes à pied dans son cercle`,
        x: todo.position.x, z: todo.position.z,
      });
    } else list.push({ text: "Tenir vos villages", sub: "laissez quelques hommes dans chacun : le FLN tente de les reprendre", state: "done" });
    // The caches are HIDDEN in the hills: how many are left is known (the
    // intelligence report), WHERE only once one has been seen.
    const caches = structures.list.filter((s) => s.typeKey === "armsCache"), live = caches.filter((s) => s.alive);
    const found = live.filter((s) => !fog()?.enabled || fog().isExplored(s.position.x, s.position.z));
    if (caches.length) {
      list.push({
        text: "Trouver et détruire les caches d'armes du FLN",
        sub: live.length ? `${live.length} restante${live.length > 1 ? "s" : ""} · ${found.length ? `${found.length} découverte${found.length > 1 ? "s" : ""}` : "aucune découverte — fouillez les collines"} · chacune arme deux mitrailleuses du FLN` : "toutes détruites : plus de mitrailleuses pour le FLN",
        state: live.length ? "" : "done", x: found[0]?.position.x, z: found[0]?.position.z,
      });
    }
    if (cave) list.push({ text: "Détruire la grotte du FLN (nord-ouest)", sub: cave.alive ? (cave.hp < cave.maxHp ? `${Math.round((100 * cave.hp) / cave.maxHp)} % restants` : "victoire immédiate · amenez blindés et mortiers") : "détruite", state: cave.alive ? "" : "done", x: cave.position.x, z: cave.position.z });
    if (post) list.push({ text: "Tenir le poste", sub: post.hp < post.maxHp ? `${Math.round((100 * post.hp) / post.maxHp)} % restants` : "s'il tombe, la guerre est perdue", state: post.hp < post.maxHp * 0.5 ? "bad" : "", x: post.position.x, z: post.position.z });
    const lv = { easy: "Facile", normal: "Normal", hard: "Difficile" }[app.algDifficulty] ?? "";
    hud.setObjectives(list, `${fmt(clock)}${lv ? ` · ${lv}` : ""}`);
  }

  // ── ADVICE: one tip per first time something happens ────────────────────
  const told = new Set(), tips = [];
  let tipGap = 0;
  const advise = (key, text) => { if (told.has(key)) return; told.add(key); tips.push(text); };
  function advice(dt) {
    if (app.algOptions?.tips === false) return;   // the pause menu's "Conseils" (ui/gameMenu.js)
    // Firsts, from what the watchers and the economy show.
    if (started && clock > startAt + 3) advise("start", "Encadrez vos hommes à la souris, puis <b>clic droit</b> près d'un village pour les y envoyer. Cliquez sur un objectif pour le voir.");
    const footIn = units.list.some((u) => u.alive && u.team === "player" && u.type?.foot && economy.points.some((v) => Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) < economy.params.radius));
    if (footIn) advise("inRing", "Gardez-les dans le cercle : l'anneau du village se remplit vers vous. Seuls les hommes à pied comptent ; plus ils sont nombreux, plus c'est rapide (jusqu'à 3).");
    if (economy.held > 0) advise("firstVillage", "Un village à vous rapporte effectifs, carburant et munitions (tant qu'il est relié au poste) et compte comme un point. Le FLN tentera de le retourner — <b>laissez-y quelques hommes</b>.");
    if (stats.lostFr > 0 || told.has("contactSeen")) advise("contact", "Sous le feu : maintenez <b>V</b> pour voir la couverture (vert) et le camouflage (cyan). Derrière murs et rochers on survit ; à découvert, non.");
    if (economy.heldByEnemy > economy.held) advise("bleeding", "Le FLN tient plus de villages que vous : <b>votre score baisse</b>. Reprenez-en un.");
    if (economy.french.stock >= 260 && clock > 60) advise("build", "Des effectifs à dépenser : cliquez sur le poste pour former des <b>sapeurs</b> — ils construisent nids de mitrailleuse, barbelés et miradors pour tenir ce que vous prenez.");
    // The next French tier can be bought (algTiers.js).
    const tn = app.algTiers?.next();
    if (tn && !app.algTiers.blockedBy(tn)) advise(`tier${tn.n}`, `<b>${tn.name}</b> peut être débloqué : cliquez sur le poste, puis <b>▲ ${tn.name}</b> (${tn.cost.mp} effectifs, ${tn.cost.fuel} carburant) — ${tn.note}.`);
    if (told.has("mgSeen")) advise("mg", "Une <b>mitrailleuse</b> du FLN cloue vos hommes à découvert : abritez-les derrière murs et rochers (V), puis prenez-la de flanc. Ses armes viennent des <b>caches</b> — détruisez-les et il n'en viendra plus.");
    if (told.has("bandSeen")) advise("band", "Une bande du FLN ne se bat pas à découvert : elle attend dans les broussailles et frappe ceux qui s'approchent. Éclairez avec la jeep, amenez le FM, restez groupés.");
    if ((tipGap -= dt) > 0 || !tips.length) return;
    tipGap = 14;
    hud.alert(tips.shift(), { kind: "tip", life: 24 });
  }
  let started = false, startAt = 0;

  // The village tooltip (hover its marker).
  hud.setTooltip((v) => {
    const r = v.radius ?? economy.params.radius;
    let fr = 0, al = 0;
    for (const u of units.list) {
      if (!u.alive || !u.type?.foot || Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) > r) continue;
      if (u.team === "player") fr++; else if (u.team === "enemy") al++;
    }
    const E = economy.params;
    const g = E.village[v.kind] ?? E.village.hamlet;
    const pay = v.kind === "supply"
      ? `<b>+${E.supplyPoint} ${v.res === "fuel" ? "carburant" : "munitions"}/min</b>`
      : `<b>+${g.mp} effectifs, +${g.fuel} carburant, +${g.mun} munitions/min</b> et compte comme point de victoire`;
    const line = v.owner === "player" && !v.linked
      ? `<br><span style="color:#e0a040">COUPÉ du poste : il ne rapporte rien. Tenez une chaîne de points (≤ ${E.link} m l'un de l'autre) jusqu'au poste.</span>` : "";
    const lean = v.value > 0.02 ? `${Math.round(v.value * 100)} % vers la France` : v.value < -0.02 ? `${Math.round(-v.value * 100)} % vers le FLN` : "indécis";
    return `<b>${v.name}</b> <span class="dim">· ${KIND_FR[v.kind] ?? v.kind}</span><br>Soutient : <b>${v.owner === "player" ? "la France" : v.owner === "enemy" ? "le FLN" : "personne"}</b> (${lean} ; tenu à 60 %)<br>Rapporte aux Français ${pay} tant qu'il est relié au poste${line}<br>Dans son cercle : France ${fr} · FLN ${al}<br><span class="dim">Postez des hommes à pied dans le cercle pour le gagner (plus ils sont nombreux, plus c'est rapide, jusqu'à 3).</span>`;
  });

  // ── The clock ─────────────────────────────────────────────────────────────
  const frame = (dt) => {
    dt = Math.min(dt, 0.1);
    clock += dt;
    watchUnits();
    watchBuildings();
    watchVillages();
    watchSupply();
    watchMines();
    watchConvoy();
    if (!over) stepScore(dt);
    hud.setScore({ fr: score.player, aln: score.enemy, max: P.start, heldFr: economy.held, heldAln: economy.heldByEnemy });
    hud.markers(economy.allPoints);
    objectives(dt);
    advice(dt);
    hud.tick();
  };
  app.addPreRenderHook(frame);

  return {
    params: P, score, stats,
    /** An alert from another system (algTiers.js). */
    say: (text, x = null, z = null, kind = "good", radio = null, icon = undefined) => say(text, x, z, kind, radio, icon),
    get over() { return over; },
    get clock() { return clock; },
    /** Start without the briefing (?brief=0): the remembered difficulty. */
    start(key = storedDifficulty()) { applyDifficulty(app, key); started = true; startAt = clock; },
    /** The briefing: what the fight is about, and how hard. Shown once the loading screen lifts. */
    brief() {
      const n = economy.points.length;
      const go = (key) => this.start(key);
      return hud.briefing(`
        <div class="kicker">Aurès, 1956 · Poste de Tighanimine</div>
        <h2>Tenir la vallée</h2>
        <ul>
          <li>Les <b>${n} villages</b> sont l'enjeu de cette guerre. Chacun rapporte à celui qu'il soutient, et chacun est un <b>point de victoire</b> (★ au-dessus d'eux et sur la mini-carte).</li>
          <li>Les <b>effectifs</b> arrivent d'Alger en continu. Le <b>carburant</b> et les <b>munitions</b> viennent du terrain : les villages et les <b>points de ravitaillement</b> sur les pistes (jerrican / cartouches) — les véhicules et les échelons demandent du carburant, les grenades et la Légion des munitions. Un point ne rapporte que s'il est <b>relié au poste</b> par une chaîne de points que vous tenez ; coupé, il passe à l'orange et ne rapporte rien.</li>
          <li><b>Gagnez un village</b> en y postant des hommes à pied. Son anneau se remplit vers celui qui a le plus d'hommes sur place.</li>
          <li>Chaque camp part de <b>500</b>. Celui qui tient <b>moins</b> de villages perd des points chaque seconde ; à 0, il a perdu. <b>Détruisez la grotte du FLN</b> (nord-ouest) pour gagner sur-le-champ. <b>Perdez le poste</b> et tout est fini.</li>
          <li>Le <b>FLN</b> ne vous affrontera pas à découvert. Il travaille les villages en silence, tend des embuscades aux hommes isolés, mine les pistes, raide vos dépôts et regagne sa grotte. Tenez garnison, patrouillez, fortifiez.</li>
        </ul>
        <div class="keys"><kbd>Espace</kbd> aller à la dernière alerte · cliquez une alerte pour y aller · maintenez <kbd>V</kbd> pour voir la couverture · <kbd>R</kbd> tourne un bâtiment · survolez un village pour ses détails · <kbd>Échap</kbd> pause et options</div>`,
      go, { levels: DIFFICULTIES, current: storedDifficulty() });
    },
    dispose() { app.removePreRenderHook?.(frame); hud.dispose(); },
  };
}
