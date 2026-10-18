// DOCTRINES — the commander you choose (2026-10-10, you: "doctrines, make the game more like CoH").
// Company of Heroes' biggest lever: a choice at the start that shapes the whole battle, and
// COMMAND POINTS earned in combat that unlock its abilities as the fight goes on.
//
//   THE CHOICE   in the briefing, beside the difficulty (stored; ?doctrine=paras|legion|air).
//   THE POINTS   every FLN killed by your men (their veterancy value: a man 10, a gunner 14, a
//                vehicle 30, a structure 25) and every village you hold (a trickle) fill a bar;
//                P.xpPerCp of it = one command point.
//   THE STRIP    the doctrine's abilities, on the right above the HUD. Locked: its price in
//                points — click to unlock it for good. Unlocked: a call-in, paid in the usual
//                resources, with a cooldown; the ones aimed at a place take a click on the map
//                (right-click / Échap cancels), on ground your men can SEE.
//
// The three, from the French army in Algeria:
//   PARAS (the paras of the 10e DP): a stick PARACHUTED from a Noratlas anywhere you see
//                (algParadrop.js — before 2026-10-12, set down by helicopter); a commando de
//                chasse (the hunter units of the Challe plan); supplies by air.
//   LÉGION      (the 1er REP and the REI): légionnaires without the armour tier; engineers who
//                build fast; the 120 mm mortar on any point you see.
//   APPUI AÉRIEN (the T-6 squadrons, the Piper spotters, the Alouette's medevac): an observation
//                plane that reveals a zone; a patrol of two T-6; casualties lifted out and healed.
//
// THE FLN'S TWO (2026-10-13, A4 — a human playing it, ?side=fln; points from French killed, its villages):
//   WILAYA       the maquis: a faoudj from a douar you hold; the informers' network that reveals a
//                zone; the saboteurs (cheaper mines, more of them); a captured jeep.
//   ARMÉE DES FRONTIÈRES  the army from Tunisia and Morocco: 81 mm mortar fire; the heavy weapons
//                tier at once; a section from outside; advisers (every squad with a star).
//
// Off in the training (algGame does not make it). ?doctrine=none = no doctrine.
import * as THREE from "three";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { FR_PAINT_TINT, buildAlouette, buildT6 } from "../../v3/render/objects/rtsVehiclesFr.js";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { stencilMesh } from "../../v3/render/objects/rtsStencils.js";
import { costOf, RES } from "./algEconomy.js";
import { VET } from "./algVeterancy.js";
import { createAlgParadrop } from "./algParadrop.js";
import { SIDES } from "../shared-rts/teams.js";
import { FLN_TRICKS } from "./algFlnTricks.js";
import { iconStyle } from "./ui/icons.js";
import { t } from "./i18n/i18n.js";

export const DOCTRINE_PARAMS = {
  xpPerCp: 70,            // veterancy value per command point (~7 FLN killed; 90 gave 6 points in 15 min — the playtest, 2026-10-10)
  villageXpPerMin: 6,     // per village held, a minute
  heli: { speed: 30, cruise: 32, hover: 6, climb: 3 },
  recon: { life: 25, radius: 90, height: 110, speed: 45, vision: 80 },
  mortar: { shells: 8, every: 1.1, spread: 14, damage: 60, splash: 9, flight: 3.2 },
  gunship: { life: 30, radius: 22, height: 26, speed: 18, reach: 32, every: 0.35, damage: 7 },
  eliteStars: 1,
  espritCorps: 0.5,
};
const P = DOCTRINE_PARAMS;
const STORE = "algrts.doctrine";

/** The doctrines and their abilities (`cp`: points to unlock; `cost`: resources per use). */
export const DOCTRINES = {
  paras: {
    name: t("Parachutistes"), short: t("Paras"),
    blurb: t("Des paras largués d'avion où vous voyez, un commando de chasse, des vivres par air."),
    abilities: [
      { key: "paraDrop", icon: "reinforce", name: t("Parachutage"), cp: 1, cost: { mp: 340 }, cooldown: 90, aim: true, radius: 8,
        hint: t("Un Nord 2501 largue un stick de cinq paras sur un point que vos hommes voient. Sous leur voile, ils ne tirent pas et sont des cibles faciles.") },
      { key: "commando", icon: "vet2", name: t("Commando de chasse"), cp: 2, cost: { mp: 380, mun: 40 }, cooldown: 150,
        hint: t("Un stick d'élite sort du poste : un FM et une étoile d'expérience.") },
      { key: "airSupply", icon: "unload", name: t("Ravitaillement aérien"), cp: 2, cost: {}, cooldown: 180,
        hint: t("Un Nord 2501 largue des caisses au poste : +80 munitions, +30 carburant.") },
      { key: "eliteParas", icon: "vet1", name: t("Paras d'élite"), cp: 3, passive: true,
        hint: t("Permanent : chaque stick de paras arrive avec une étoile d'expérience.") },
    ],
  },
  legion: {
    name: t("Légion étrangère"), short: t("Légion"),
    blurb: t("Des légionnaires sans attendre les blindés, un génie qui bâtit vite, le mortier de 120."),
    abilities: [
      { key: "legionCall", icon: "reinforce", name: t("Légionnaires"), cp: 1, cost: { mp: 380, mun: 45 }, cooldown: 120,
        hint: t("Un groupe de la Légion sort du poste, sans l'échelon des blindés.") },
      { key: "legionEngineers", icon: "sandbags", name: t("Génie de la Légion"), cp: 2, passive: true,
        hint: t("Permanent : vos sapeurs bâtissent 60 % plus vite.") },
      { key: "mortar120", icon: "barrage", name: t("Mortier de 120"), cp: 3, cost: { mun: 90 }, cooldown: 120, aim: true, radius: 14,
        hint: t("Huit obus lourds sur un point que vos hommes voient, en dix secondes.") },
      { key: "espritCorps", icon: "reinforce", name: t("Esprit de corps"), cp: 3, passive: true,
        hint: t("Permanent : les groupes de la Légion se renforcent à moitié prix.") },
    ],
  },
  // ── THE FLN'S ──────────────────────────────────────────────────────────────
  wilaya: {
    side: "enemy", name: t("Wilaya"), short: t("Wilaya"),
    blurb: t("Le maquis : des renforts des douars, un réseau d'informateurs, les saboteurs, une jeep capturée."),
    abilities: [
      { key: "douar", icon: "reinforce", name: t("Renforts du douar"), cp: 1, cost: 110, cooldown: 90, aim: true, villageOnly: true, radius: 8,
        hint: t("Un faoudj de quatre hommes du douar rejoint le maquis dans un village que vous tenez.") },
      { key: "informers", icon: "alertSeen", name: t("Réseau d'informateurs"), cp: 2, cost: 40, cooldown: 100, aim: true, anywhere: true, radius: P.recon.vision,
        hint: t("Les bergers et les commerçants parlent : tout ce qui se trouve dans la zone est vu pendant 25 s.") },
      { key: "saboteurs", icon: "alertMine", name: t("Saboteurs"), cp: 2, passive: true,
        hint: t("Permanent : les mines coûtent moitié moins et huit peuvent attendre en même temps.") },
      { key: "jeep", icon: "transport", name: t("Jeep capturée"), cp: 3, cost: 150, cooldown: 180,
        hint: t("Une jeep Willys prise aux Français, sa mitrailleuse : elle sort de la grotte.") },
    ],
  },
  frontieres: {
    side: "enemy", name: t("Armée des frontières"), short: t("Frontières"),
    blurb: t("L'armée de l'extérieur : mortiers de 81, armes lourdes tout de suite, une section venue de Tunisie, des conseillers."),
    abilities: [
      { key: "mortar81", icon: "barrage", name: t("Tir de mortiers de 81"), cp: 1, cost: 90, cooldown: 120, aim: true, radius: 14,
        hint: t("Huit obus de 81 sur un point que vos hommes voient, tirés depuis la frontière.") },
      { key: "borderArms", icon: "tier", name: t("Armes des frontières"), cp: 2, passive: true,
        hint: t("Permanent : l'échelon des armes lourdes (mortier de 60, mitrailleuse de 12,7) s'ouvre aussitôt.") },
      { key: "outsideSection", icon: "reinforce", name: t("Section de l'extérieur"), cp: 2, cost: 220, cooldown: 150,
        hint: t("Deux faoudjs et un tireur FM passés du barrage sortent de la grotte.") },
      { key: "advisers", icon: "vet1", name: t("Conseillers"), cp: 3, passive: true,
        hint: t("Permanent : chaque groupe du FLN arrive avec une étoile d'expérience.") },
    ],
  },
  air: {
    name: t("Appui aérien"), short: t("Air"),
    blurb: t("Un avion d'observation qui révèle une zone, une patrouille de T-6, l'évacuation des blessés."),
    abilities: [
      { key: "recon", icon: "alertSeen", name: t("Avion d'observation"), cp: 1, cost: { mun: 30 }, cooldown: 100, aim: true, anywhere: true, radius: P.recon.vision,
        hint: t("Un Piper tourne au-dessus d'une zone pendant 25 s : tout ce qui s'y trouve est vu.") },
      { key: "t6Pair", icon: "barrage", name: t("Patrouille de T-6"), cp: 2, cost: { mun: 180 }, cooldown: 160, aim: true, radius: 10,
        hint: t("Deux T-6 mitraillent et bombardent le point, l'un derrière l'autre.") },
      { key: "medevac", icon: "repair", name: t("Évacuation sanitaire"), cp: 2, cost: { mp: 60 }, cooldown: 120, aim: true, radius: 25,
        hint: t("Une Alouette se pose : vos blessés à 25 m sont soignés.") },
      { key: "gunship", icon: "lmg", name: t("Alouette armée"), cp: 3, cost: { mun: 120 }, cooldown: 150, aim: true, radius: P.gunship.reach,
        hint: t("Une Alouette armée tourne 30 s au-dessus d'un point que vos hommes voient et tire sur le FLN qui s'y trouve.") },
    ],
  },
};
/** The doctrines of the side you play (the briefing's choice). */
export const doctrineList = () => Object.entries(DOCTRINES).filter(([, d]) => (d.side ?? "player") === SIDES.human).map(([key, d]) => ({ key, label: d.name, blurb: d.blurb }));

/** The doctrine to start with: ?doctrine=, then the last one chosen (per side), then the paras (the FLN: the wilaya). */
export function storedDoctrine() {
  const mine = (k) => DOCTRINES[k] && (DOCTRINES[k].side ?? "player") === SIDES.human;
  const q = new URLSearchParams(location.search).get("doctrine");
  if (q === "none") return null;
  if (mine(q)) return q;
  try { const s = localStorage.getItem(storeKey()); if (mine(s)) return s; } catch { /* */ }
  return SIDES.human === "enemy" ? "wilaya" : "paras";
}
const storeKey = () => (SIDES.human === "enemy" ? STORE + ".fln" : STORE);

/**
 * `side`: whose doctrine (default: the human's). `ui: false` — an AI's (algFrenchAI.js, 2026-10-13): no
 * strip, no clicks, no alerts, no fog of its own for you; it calls `use(key, at)` itself.
 */
export function createAlgDoctrines(app, { units, squads, economy, projectiles, combat = null, airStrike, fogOfWar = null, side = SIDES.human, ui = true }) {
  const dom = app.renderer.domElement;
  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  // THE SIDE (the human's): the French's purse and post, or the FLN's supplies and cave.
  const SIDE = side, FLN = SIDE === "enemy";
  const purse = FLN ? economy.aln : economy.french;
  const say = (text, x = null, z = null, kind = "good") => { if (ui) app.algBattle?.say?.(text, x, z, kind); };
  const post = () => app.algProducers?.find((p) => p.structure.typeKey === (FLN ? "caveEntrance" : "post") && p.structure.team === SIDE) ?? null;
  const seen = (x, z) => !fogOfWar?.enabled || fogOfWar.isVisible(x, z);
  const popRoom = () => (SIDES.human === "enemy" ? Infinity : economy.popRoom?.() ?? Infinity);   // (the pop cap is the French's)

  let doctrine = null;
  let xp = 0, cp = 0;
  const unlocked = new Set();
  const cd = new Map();          // ability key → seconds left
  let targeting = null;          // { ab, at, ok }

  // ── Flights: helicopters in and out, the observation plane circling ──────
  const flights = [];
  // (Built on first use, 2026-10-18: an AI's instance — the FLN's has no aircraft — paid ~75 ms at boot for them.)
  let heliProto = null, planeProto = null, mat = null;
  const matOf = () => (mat ??= rtsObjectMaterialTinted(FR_PAINT_TINT));
  function heliMesh() {
    heliProto ??= buildAlouette({ detail: 1 });
    const mat = matOf();
    const g = new THREE.Group();
    const body = new THREE.Mesh(heliProto, mat);
    body.castShadow = true;
    const st = stencilMesh(heliProto.userData.stencil); if (st) body.add(st);
    g.add(body);
    const R = heliProto.userData.rotors;
    const main = new THREE.Mesh(R.main.geo, mat); main.position.fromArray(R.main.pivot);
    const tail = new THREE.Mesh(R.tail.geo, mat); tail.position.fromArray(R.tail.pivot);
    g.add(main, tail);
    g.userData.spin = (now) => { main.rotation.y = now * 28; tail.rotation.x = now * 40; };
    return g;
  }
  function planeMesh() {
    planeProto ??= buildT6();
    const mat = matOf();
    const g = new THREE.Group();
    const body = new THREE.Mesh(planeProto, mat);
    body.castShadow = true;
    const st = stencilMesh(planeProto.userData.stencil); if (st) body.add(st);
    const prop = new THREE.Mesh(planeProto.userData.prop.geo, mat);
    prop.position.fromArray(planeProto.userData.prop.pivot);
    g.add(body, prop);
    g.userData.spin = (now) => { prop.rotation.z = now * 60; };
    return g;
  }
  /** A helicopter from the post to (x, z): hovers `hold` s (onHover once), then away over it. */
  function heliTo(x, z, hold, onHover) {
    const p = post();
    const from = p ? { x: p.structure.position.x, z: p.structure.position.z } : { x: x + 200, z: z + 200 };
    const dx = x - from.x, dz = z - from.z, d = Math.hypot(dx, dz) || 1;
    const H = P.heli, T1 = d / H.speed;
    const mesh = heliMesh();
    app.scene.add(mesh);
    flights.push({
      mesh, t: 0, end: T1 + hold + 12, hovered: false,
      at(tt, out) {
        if (tt < T1) {
          const k = tt / T1, near = Math.max(0, (k - 0.75) / 0.25);
          const px = from.x + dx * k, pz = from.z + dz * k;
          return out.set(px, groundY(px, pz) + H.cruise + (H.hover - H.cruise) * near * near * (3 - 2 * near), pz);
        }
        if (tt < T1 + hold) return out.set(x, groundY(x, z) + H.hover, z);
        const s = tt - T1 - hold, px = x + (dx / d) * H.speed * s, pz = z + (dz / d) * H.speed * s;
        return out.set(px, groundY(px, pz) + H.hover + Math.min(40, s * H.climb * 3), pz);
      },
      tick(tt) { if (!this.hovered && tt >= T1 + Math.min(1.5, hold * 0.4)) { this.hovered = true; onHover?.(); } },
    });
  }
  /** The observation plane: a circle over (x, z) for P.recon.life s — and its eye. */
  const recons = [];
  function reconOver(x, z, { plane = true } = {}) {
    const R = P.recon, w = R.speed / R.radius;
    // (The FLN's informers: no plane — only the eye. An empty group stands in for the mesh.)
    const mesh = plane ? planeMesh() : new THREE.Group();
    app.scene.add(mesh);
    const f = {
      mesh, t: 0, end: R.life, x, z,
      at(tt, out) { const a = tt * w; return out.set(x + Math.cos(a) * R.radius, groundY(x, z) + R.height, z + Math.sin(a) * R.radius); },
    };
    flights.push(f);
    recons.push(f);
  }
  /** The armed Alouette: a tight circle over (x, z), its AA-52 on the FLN within reach. */
  const gunships = [];
  function gunshipOver(x, z) {
    const G = P.gunship, w = G.speed / G.radius;
    const mesh = heliMesh();
    app.scene.add(mesh);
    const f = {
      mesh, t: 0, end: G.life, x, z, fireT: 0,
      at(tt, out) { const a = tt * w; return out.set(x + Math.cos(a) * G.radius, groundY(x, z) + G.height, z + Math.sin(a) * G.radius); },
    };
    flights.push(f);
    gunships.push(f);
  }
  if (ui) fogOfWar?.addSourceProvider?.(() => recons.filter((f) => f.t < f.end).map((f) => ({ x: f.x, z: f.z, r: P.recon.vision, eye: 60 })));

  // THE PARADROP (algParadrop.js): the Noratlas, the stick, the canopies.
  // (An AI's: made on its first drop — the human's at once, app.algParadrop is read elsewhere.)
  let paradrop = ui ? createAlgParadrop(app, { units, squads, navGrid: app.navGrid }) : null;
  const drops = () => (paradrop ??= createAlgParadrop(app, { units, squads, navGrid: app.navGrid }));
  if (ui) app.algParadrop = paradrop;

  // ── Squads out of nowhere (a drop) or out of the post ─────────────────────
  function squadAt(key, x, z, { elite = false } = {}) {
    const size = { para: 5, legion: 5, moudjahid: 4, fmTeam: 1 }[key] ?? 5;
    if (popRoom() < size) { say(t("<b>Effectifs au plafond</b> : pas de place pour un groupe de plus."), x, z, "bad"); return null; }
    const men = [];
    for (let i = 0; i < size; i++) {
      const a = (i / size) * Math.PI * 2, r = i ? 2.4 : 0;
      const u = units.spawn(key, x + Math.cos(a) * r, z + Math.sin(a) * r, { team: SIDE, lookRole: i });
      if (u) men.push(u);
    }
    if (!men.length) return null;
    squads.adopt(men, key);
    const s = squads.of(men[0]);
    if (s && FLN && unlocked.has("advisers")) { s.xp = Math.max(s.xp ?? 0, VET.thresholds[0]); s.stars = Math.max(s.stars ?? 0, 1); }
    if (s && elite) { s.upgrades.lmg = true; s.xp = Math.max(s.xp ?? 0, VET.thresholds[0]); s.stars = Math.max(s.stars ?? 0, 1); }
    return s;
  }
  function squadFromPost(key, opts) {
    const p = post();
    if (!p) return null;
    const o = p.outside ?? p.structure.position;
    const s = squadAt(key, o.x, o.z, opts);
    if (s) for (const u of s.members) u.orderTo(o.x + (Math.random() - 0.5) * 8, o.z + 10 + Math.random() * 6);
    return s;
  }

  // ── The heavy mortar: shells in flight, one by one ────────────────────────
  const salvos = [];   // { x, z, left, t }
  function mortarOn(x, z) { salvos.push({ x, z, left: P.mortar.shells, t: 0.8 }); }
  // The T-6 pair: the second a beat behind the first.
  const later = [];    // { t, fn }

  // ── Using an ability ──────────────────────────────────────────────────────
  const abilityOf = (key) => DOCTRINES[doctrine]?.abilities.find((a) => a.key === key) ?? null;
  function run(ab, at) {
    const p = post();
    switch (ab.key) {
      case "paraDrop": {
        if (popRoom() < 5) { say(t("<b>Effectifs au plafond</b> : pas de place pour un groupe de plus."), at.x, at.z, "bad"); return false; }
        const from = p ? { x: p.structure.position.x, z: p.structure.position.z } : null;
        drops().drop(at.x, at.z, { key: "para", count: 5, from, elite: unlocked.has("eliteParas") });
        say(t("<b>Parachutage</b> : le Nord 2501 est en route."), at.x, at.z);
        app.algSounds?.radio?.();
        return true;
      }
      case "commando":
        if (!squadFromPost("para", { elite: true })) return false;
        say(t("<b>Un commando de chasse</b> sort du poste."), p?.structure.position.x, p?.structure.position.z);
        return true;
      case "airSupply":
        purse.earn({ mun: 80, fuel: 30 });
        say(t("<b>Ravitaillement largué</b> au poste : +80 munitions, +30 carburant."), p?.structure.position.x, p?.structure.position.z);
        return true;
      case "legionCall":
        if (!squadFromPost("legion")) return false;
        say(t("<b>Les légionnaires</b> sortent du poste."), p?.structure.position.x, p?.structure.position.z);
        return true;
      case "mortar120":
        mortarOn(at.x, at.z);
        app.algSounds?.radio?.();
        return true;
      case "recon":
        reconOver(at.x, at.z);
        app.algSounds?.radio?.();
        return true;
      case "t6Pair": {
        if (!airStrike || !p) return false;
        airStrike.call(p.structure, at.x, at.z, null, { free: true });
        const ox = at.x - p.structure.position.x, oz = at.z - p.structure.position.z, l = Math.hypot(ox, oz) || 1;
        later.push({ t: 1.6, fn: () => airStrike.call(p.structure, at.x - (oz / l) * 16, at.z + (ox / l) * 16, null, { free: true }) });
        return true;
      }
      // ── the FLN's ──
      case "douar": {
        const s = squadAt("moudjahid", at.x, at.z);
        if (!s) return false;
        say(t("<b>Un faoudj du douar</b> rejoint le maquis."), at.x, at.z);
        return true;
      }
      case "informers":
        reconOver(at.x, at.z, { plane: false });
        say(t("<b>Les informateurs parlent</b> : la zone est vue pendant 25 s."), at.x, at.z);
        return true;
      case "jeep": {
        const o = p?.outside ?? p?.structure.position;
        if (!o) return false;
        const u = units.spawn("willys", o.x, o.z, { team: SIDE });
        if (!u) return false;
        const r = p.structure.rally ?? o;
        u.orderTo(r.x + 6, r.z + 6);
        say(t("<b>Une jeep capturée</b> sort de la grotte."), o.x, o.z);
        return true;
      }
      case "mortar81":
        mortarOn(at.x, at.z);
        say(t("<b>Les mortiers de 81 tirent</b> depuis la frontière."), at.x, at.z);
        return true;
      case "outsideSection": {
        const a = squadFromPost("moudjahid"), b = squadFromPost("moudjahid"), c = squadFromPost("fmTeam");
        if (!a && !b && !c) return false;
        say(t("<b>Une section de l'extérieur</b> a passé le barrage : elle sort de la grotte."), p?.structure.position.x, p?.structure.position.z);
        return true;
      }
      case "gunship":
        gunshipOver(at.x, at.z);
        app.algSounds?.radio?.();
        return true;
      case "medevac":
        heliTo(at.x, at.z, 6, () => {
          let n = 0;
          for (const u of units.list) {
            if (!u.alive || u.team !== "player" || !u.type?.foot || u.inside) continue;
            if (Math.hypot(u.position.x - at.x, u.position.z - at.z) > ab.radius) continue;
            if (u.hp < u.maxHp) { u.hp = u.maxHp; n++; }
          }
          say(t("<b>Évacuation sanitaire</b> : {n} blessés soignés.", { n }), at.x, at.z);
        });
        return true;
    }
    return false;
  }
  const ready = (ab) => unlocked.has(ab.key) && !ab.passive && !(cd.get(ab.key) > 0) && purse.canAfford(ab.cost ?? {});
  function press(key) {
    const ab = abilityOf(key);
    if (!ab) return;
    if (!unlocked.has(key)) {
      if (cp < ab.cp) { say(t("Il faut {n} points de commandement pour débloquer {name}.", { n: ab.cp, name: ab.name }), null, null, "bad"); return; }
      cp -= ab.cp;
      unlocked.add(key);
      if (key === "legionEngineers") app.algBuildSpeed = 1.6;
      if (key === "eliteParas") elite();
      if (key === "saboteurs") { FLN_TRICKS.mine.cost = 15; if (app.algMines?.params) app.algMines.params.max = 8; }
      if (key === "borderArms") app.algFlnTiers?.grant?.(2);
      if (key === "advisers") elite();
      say(t("<b>{name}</b> débloqué.", { name: ab.name }));
      render();
      return;
    }
    if (!ready(ab)) return;
    if (ab.aim) { targeting = { ab, at: null, ok: false }; dom.style.cursor = "crosshair"; return; }
    if (run(ab, null)) { purse.spend(ab.cost ?? {}); cd.set(key, ab.cooldown ?? 0); }
  }

  // Targeting on the map (as the air strike's).
  const cancel = () => { targeting = null; dom.style.cursor = ""; };
  function aimAt(e) {
    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    targeting.at = hit?.point ? { x: hit.point.x, z: hit.point.z } : null;
    targeting.ok = !!targeting.at && (targeting.ab.anywhere || seen(targeting.at.x, targeting.at.z))
      && (!targeting.ab.villageOnly || (economy.points ?? []).some((v) => v.owner === SIDE && Math.hypot(v.position.x - targeting.at.x, v.position.z - targeting.at.z) < (v.radius ?? 40)));
  }
  const onMove = (e) => { if (targeting) aimAt(e); };
  const onDown = (e) => {
    if (!targeting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) { cancel(); return; }
    aimAt(e);
    const { ab, at, ok } = targeting;
    cancel();
    if (!at) return;
    if (!ok) { say(ab.villageOnly ? t("Il faut un village que vous tenez.") : t("Il faut que vos hommes voient ce point."), at.x, at.z, "bad"); return; }
    if (!ready(ab)) return;
    if (run(ab, at)) { purse.spend(ab.cost ?? {}); cd.set(ab.key, ab.cooldown ?? 0); }
  };
  const onKey = (e) => { if (e.key === "Escape" && targeting) cancel(); };
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  if (ui) {
    dom.addEventListener("pointerdown", onDown, true);
    dom.addEventListener("contextmenu", onContext, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("keydown", onKey);
  }
  const rings = createSelectionRingField({ app, max: 8, inner: 0.93, opacity: 0.75 });

  // ── The strip ─────────────────────────────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
#alg-doc { position: fixed; right: calc(var(--alg-dev-w, 0px) + 8px); bottom: 190px; z-index: 55; width: 214px;
  padding: 8px 8px 9px; background: var(--hud-bg, rgba(16,14,10,0.9)); border: 1px solid rgba(201,165,74,0.55);
  border-radius: var(--hud-radius, 3px); font-family: var(--hud-sans, sans-serif); color: var(--hud-text, #e8dcc4); }
#alg-doc[hidden] { display: none; }
#alg-doc .hd { display: flex; justify-content: space-between; align-items: baseline; font-size: 10px; letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--hud-brass, #c9a54a); }
#alg-doc .cp { font: 600 12px var(--hud-mono, monospace); letter-spacing: 0; color: #f1dfa6; }
#alg-doc .bar { height: 3px; margin: 5px 0 7px; background: rgba(234,223,200,0.15); }
#alg-doc .bar i { display: block; height: 100%; background: #c9a54a; }
#alg-doc .ab { position: relative; display: flex; align-items: center; gap: 7px; width: 100%; margin-top: 4px; padding: 5px 6px;
  font: 12px var(--hud-sans, sans-serif); color: inherit; text-align: left; background: rgba(40,33,22,0.7);
  border: 1px solid rgba(201,165,74,0.35); border-radius: 2px; cursor: pointer; overflow: hidden; }
#alg-doc .ab:hover { border-color: #f1dfa6; }
#alg-doc .ab .ic { flex: 0 0 20px; height: 20px; background: currentColor; -webkit-mask-size: contain; mask-size: contain;
  -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; -webkit-mask-position: center; mask-position: center; color: #c9a54a; }
#alg-doc .ab .nm { flex: 1; line-height: 1.2; }
#alg-doc .ab .pr { font: 11px var(--hud-mono, monospace); color: var(--hud-dim, #a8987a); white-space: nowrap; }
#alg-doc .ab.locked { opacity: 0.6; }
#alg-doc .ab.locked.can { opacity: 1; border-color: #f1dfa6; box-shadow: 0 0 6px rgba(241,223,166,0.35); }
#alg-doc .ab.cool .ic, #alg-doc .ab.short .ic { color: #6f6553; }
#alg-doc .ab .sw { position: absolute; left: 0; bottom: 0; height: 2px; background: #c9a54a; }
#alg-doc .ab.aiming { border-color: #58e070; }`;
  if (ui) document.head.appendChild(style);
  const el = document.createElement("div");
  el.id = "alg-doc";
  el.hidden = true;
  if (ui) document.body.appendChild(el);   // (an AI's strip stays off the page: drawn into nothing)
  el.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.addEventListener("click", (e) => { const b = e.target.closest("[data-ab]"); if (b) press(b.dataset.ab); });

  const fmtCost = (c) => { if (FLN) return c ? t("{n} ravitaillement", { n: c }) : t("gratuit"); const k = costOf(c); return RES.filter((r) => k[r.key] > 0).map((r) => `${k[r.key]}${r.short ? " " + r.short : ""}`).join(" · ") || t("gratuit"); };
  function render() {
    const d = DOCTRINES[doctrine];
    el.hidden = !d;
    if (!d) return;
    el.innerHTML = `<div class="hd"><span>${t("Doctrine")} · ${d.short}</span><span class="cp" title="${FLN ? t("Points de commandement : gagnés en tuant des soldats français et en tenant des villages.") : t("Points de commandement : gagnés en tuant des combattants du FLN et en tenant des villages.")}">★ ${cp}</span></div>
      <div class="bar"><i style="width:${Math.round((100 * xp) / P.xpPerCp)}%"></i></div>
      ${d.abilities.map((a) => `<button type="button" class="ab" data-ab="${a.key}" title="${a.hint}"><span class="ic" style="${iconStyle(a.icon)}"></span>
        <span class="nm">${a.name}</span><span class="pr"></span><span class="sw"></span></button>`).join("")}`;
    refresh();
  }
  let lastSig = "";
  function refresh() {
    const d = DOCTRINES[doctrine];
    if (!d) return;
    el.querySelector(".cp").textContent = `★ ${cp}`;
    el.querySelector(".bar i").style.width = `${Math.round((100 * xp) / P.xpPerCp)}%`;
    for (const a of d.abilities) {
      const b = el.querySelector(`[data-ab="${a.key}"]`);
      if (!b) continue;
      const open = unlocked.has(a.key), left = cd.get(a.key) ?? 0;
      b.classList.toggle("locked", !open);
      b.classList.toggle("can", !open && cp >= a.cp);
      b.classList.toggle("cool", open && left > 0);
      b.classList.toggle("short", open && !a.passive && !purse.canAfford(a.cost ?? {}));
      b.classList.toggle("aiming", targeting?.ab === a);
      b.querySelector(".pr").textContent = !open ? `★ ${a.cp}` : a.passive ? t("actif") : left > 0 ? `${Math.ceil(left)} s` : fmtCost(a.cost);
      b.querySelector(".sw").style.width = open && left > 0 ? `${Math.round((100 * left) / (a.cooldown || 1))}%` : "0";
    }
  }

  // ── The clock ─────────────────────────────────────────────────────────────
  let uiT = 0;
  function gain(n) {
    if (!doctrine) return;
    xp += n;
    while (xp >= P.xpPerCp) {
      xp -= P.xpPerCp;
      cp++;
      say(t("<b>Point de commandement</b> : {n} à dépenser (doctrine, à droite).", { n: cp }));
    }
  }
  function step(dt) {
    if (!doctrine) return;
    gain((((FLN ? economy.heldByEnemy : economy.held) ?? 0) * P.villageXpPerMin * dt) / 60);
    for (const [k, v] of cd) if (v > 0) cd.set(k, Math.max(0, v - dt));
    for (let i = later.length - 1; i >= 0; i--) if ((later[i].t -= dt) <= 0) { later[i].fn(); later.splice(i, 1); }
    for (let i = salvos.length - 1; i >= 0; i--) {
      const s = salvos[i];
      if ((s.t -= dt) > 0) continue;
      const p = post();
      if (!p || s.left <= 0) { salvos.splice(i, 1); continue; }
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * P.mortar.spread;
      const to = new THREE.Vector3(s.x + Math.cos(a) * r, 0, s.z + Math.sin(a) * r);
      to.y = groundY(to.x, to.z);
      const from = p.structure.position.clone().add(new THREE.Vector3(0, 3, 0));
      // (the Légion's 120 when the French fire it; the FLN's doctrine fires 81s — algDoctrines mortar81)
      projectiles.spawnArc(from, to, { damage: P.mortar.damage, splash: P.mortar.splash, owner: p.structure, flight: P.mortar.flight, kind: FLN ? "mortar81" : "mortar120" });
      app.algSounds?.audio?.play?.("incoming", to.x, to.y + 20, to.z, { delay: P.mortar.flight - 1.2 });
      s.left--; s.t = P.mortar.every;
    }
    // The armed Alouettes: a burst at the nearest FLN man within reach of their circle's centre.
    const G = P.gunship;
    for (const g of gunships) {
      if (g.t >= g.end || (g.fireT -= dt) > 0) continue;
      g.fireT = G.every;
      let best = null, bd = G.reach;
      for (const u of units.list) {
        if (!u.alive || u.team !== "enemy" || u.inside || u.isStructure) continue;
        const d = Math.hypot(u.position.x - g.x, u.position.z - g.z);
        if (d < bd && seen(u.position.x, u.position.z)) { bd = d; best = u; }
      }
      if (!best) continue;
      g.at(g.t, _g);
      const at = best.position.clone();
      projectiles.spawn(_g.clone(), { position: at, isAir: false, isStructure: false }, 0, { weapon: "mg", team: "player" }, null, { miss: true, exact: true });
      combat?.onImpact?.(best, G.damage, at, post()?.structure ?? null, { bullet: true });
    }
    if (unlocked.has("eliteParas") || unlocked.has("advisers")) elite();
    paradrop?.step(dt);
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.t += dt;
      f.tick?.(f.t);
      if (f.t >= f.end) {
        app.scene.remove(f.mesh); flights.splice(i, 1);
        for (const L of [recons, gunships]) { const r = L.indexOf(f); if (r >= 0) L.splice(r, 1); }
      }
    }
  }
  /** Paras d'élite: every para stick of yours with at least P.eliteStars (the drop's, the helipad's). */
  function elite() {
    for (const s of squads.list) {
      if (s.team !== SIDE || (!FLN && s.typeKey !== "para") || (s.stars ?? 0) >= P.eliteStars || s._formingElite) continue;
      s.xp = Math.max(s.xp ?? 0, VET.thresholds[P.eliteStars - 1]);
      s.stars = P.eliteStars;
    }
  }
  const _g = new THREE.Vector3();
  const _p = new THREE.Vector3(), _q = new THREE.Vector3();
  function frame(dt) {
    if (!doctrine) return;
    const now = performance.now() / 1000;
    for (const f of flights) {
      f.at(f.t, _p); f.at(f.t + 0.08, _q);
      f.mesh.position.copy(_p);
      if (_q.distanceToSquared(_p) > 1e-4) { _q.y = _p.y; f.mesh.lookAt(_q); }
      f.mesh.userData.spin?.(now);
    }
    paradrop?.frame();
    rings.begin();
    if (targeting?.at) rings.add(targeting.at.x, targeting.at.z, targeting.ab.radius ?? 8, targeting.ok ? 0x58e070 : 0xe0574a);
    for (const s of salvos) rings.add(s.x, s.z, P.mortar.spread, 0xffb020);
    for (const f of recons) rings.add(f.x, f.z, P.recon.vision, 0x6ab0ff);
    for (const f of gunships) rings.add(f.x, f.z, P.gunship.reach, 0xffb020);
    rings.commit();
    if ((uiT -= dt) <= 0) { uiT = 0.25; refresh(); }
  }

  return {
    params: P, step, frame, press,
    get doctrine() { return doctrine; },
    get cp() { return cp; },
    get xp() { return xp; },
    unlocked,
    /** The choice (the briefing's, or none). */
    choose(key) {
      doctrine = DOCTRINES[key] ? key : null;
      try { if (doctrine && ui) localStorage.setItem(storeKey(), doctrine); } catch { /* */ }
      unlocked.clear(); cd.clear(); cp = 0; xp = 0;
      app.algBuildSpeed = 1;
      render();
    },
    /** A kill (combat's onDeath): the FLN killed by your men fill the bar. */
    onKill(e) {
      const k = e.lastHitBy;
      const foe = FLN ? "player" : "enemy";
      if (!doctrine || e.team !== foe || k?.team !== SIDE) return;
      const v = VET.value;
      gain(e.isStructure ? v.structure : !e.type?.foot ? v.vehicle : e.typeKey === "fmTeam" ? v.fmTeam : e.typeKey === "tireur" ? v.tireur : v.man);
    },
    /** A squad type's reinforce price factor (algSquads reinforceCost): the Légion's esprit de corps. */
    reinforceMul: (typeKey) => (doctrine === "legion" && unlocked.has("espritCorps") && typeKey === "legion" ? P.espritCorps : 1),
    /** Dev: points now. */
    give(n = 1) { cp += n; refresh(); },
    /** The abilities of the chosen doctrine. */
    get abilities() { return DOCTRINES[doctrine]?.abilities ?? []; },
    /** Unlock `key` with the points (an AI: no click). True if it is open now. */
    unlock(key) {
      const ab = abilityOf(key);
      if (!ab) return false;
      if (unlocked.has(key)) return true;
      if (cp < ab.cp) return false;
      press(key);
      return unlocked.has(key);
    },
    /** Ready now: unlocked, off cooldown, affordable (a passive never). */
    ready: (key) => { const ab = abilityOf(key); return !!ab && ready(ab); },
    /** Use `key` at `at` (an AI; the same price, cooldown and effect as the human's click). */
    use(key, at = null) {
      const ab = abilityOf(key);
      if (!ab || !ready(ab)) return false;
      if (!run(ab, at)) return false;
      purse.spend(ab.cost ?? {}); cd.set(key, ab.cooldown ?? 0);
      return true;
    },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
      for (const f of flights) app.scene.remove(f.mesh);
      paradrop?.dispose();
      el.remove(); if (ui) style.remove();
    },
  };
}
