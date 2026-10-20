// THE FLN TRAINING — LE MAQUIS (2026-10-20, FLN_TRAINING_PLAN.md; you: "always think Company of Heroes and nice
// play"). ?map=maquis (maps/maquis.js): you command the FLN (MAP.side), the French are the lessons' own (no AI).
//
// The French training's machinery (algTutorial.js — the panel at the top, a lesson moves on once DONE, "Passer"
// skips it, its target on the minimap), the French file left as it is. The FLN's way of war, CoH's pace — one
// idea a lesson, fighting early:
//
//   1 the djebel        camera, select, move                         → moved, turned, zoomed; men below the camp
//   2 hide              into the scrub; V: concealment (cyan)        → a faoudj concealed
//   3 the ambush        HOLD FIRE (⇧H), a patrol comes, OPEN FIRE    → the patrol down
//   4 hit and run       a half-track: RETREAT (T) to the cave, Y     → back at the cave, the faoudj full
//   5 the village       take the mechta: it pays supplies            → the mechta held
//   6 the cave          train a faoudj, then an FM team              → both out
//   7 build             a SANGAR on the knoll, an AMBUSH SCREEN      → both standing
//   8 the arms cache    a cache in the scrub, then the BAZOOKA (U)   → a faoudj with a bazooka
//   (9-13 next: forward, sabotage, the command mine, armour, the convoy)
import { t } from "./i18n/i18n.js";
import { LAYOUT, MAP } from "./layout.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

const P = { tick: 0.25, nextDelay: 1.6 };

export function createAlgTutorial(app) {
  const battle = app.algBattle, hud = battle.hud;
  battle.rules.score = battle.rules.objectives = battle.rules.advice = battle.rules.sightings = false;
  const units = app.algUnits.units, S = app.algSquads, E = app.algEconomy;
  const site = (k) => LAYOUT.sites.find((s) => s.kind === k);
  const campSite = site("aln"), hamletSite = site("hamlet"), postSite = site("french");
  const SP = MAP.spots;
  const hamlet = () => E.points.find((p) => p.kind !== "supply");
  const cave = () => app.algProducers.find((p) => p.structure.typeKey === "caveEntrance") ?? null;
  const caveAt = () => { const c = cave(); return c?.outside ?? c?.structure.position ?? campSite; };
  const squads = () => S.list.filter((s) => s.team === "enemy" && s.members.some((u) => u.alive));
  const faoudjs = () => squads().filter((s) => s.typeKey === "moudjahid");
  const near = (u, p, r) => Math.hypot(u.position.x - p.x, u.position.z - p.z) < r;
  const say = (text, x = null, z = null, kind = "good") => battle.say(text, x, z, kind);
  const conceal = (u) => app.algCover?.concealmentAt?.(u.position.x, u.position.z) ?? 0;

  // ── Helpers for the lessons' ground ───────────────────────────────────────
  const markers = [];   // { x, z, r, color }
  const rings = createSelectionRingField({ app, max: 8, inner: 0.93, segments: 64, opacity: 0.85 });
  app.addPreRenderHook(() => {
    rings.begin();
    for (const m of markers) rings.add(m.x, m.z, m.r, m.color ?? 0xf2c94c);
    rings.commit();
  });
  /** French soldiers at (x, z), facing (fx, fz): the lessons' patrols. */
  function french(n, x, z, { type = "appele", spread = 2.5 } = {}) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const u = units.spawn(type, x + (k % 3 - 1) * spread, z + Math.floor(k / 3) * spread, { team: "player", lookRole: k % 6 });
      if (u) out.push(u);
    }
    return out;
  }
  /** Walk `men` along a path (each its own waypoint, a file); `i` the leg they are on (state). */
  function walk(s, men, path) {
    const leg = path[s.leg ?? 0];
    if (!leg) return true;
    const live = men.filter((u) => u.alive && !u.target);
    if (live.every((u) => Math.hypot(u.position.x - leg[0], u.position.z - leg[1]) < 6)) { s.leg = (s.leg ?? 0) + 1; s.sent = false; }
    if (!s.sent && path[s.leg ?? 0]) { const [x, z] = path[s.leg ?? 0]; live.forEach((u, k) => u.orderTo(x + (k % 2) * 2, z + Math.floor(k / 2) * 2)); s.sent = true; }
    return false;
  }
  const allDead = (list) => list.length > 0 && list.every((u) => !u.alive);
  const alive = (list) => (list ?? []).filter((u) => u.alive).map((u) => u.position);
  const fund = (n) => E.aln.earn(n);
  const newSquads = (s, type) => squads().filter((q) => q.typeKey === type && !s.had.has(q));

  // ── The lessons ───────────────────────────────────────────────────────────
  const view = () => app.rtsCamera?.getView?.();
  const L = [];
  // 1. the djebel: the camera, select, move
  L.push({
    title: t("Le djebel"),
    text: t("Vous commandez une katiba de l'ALN. Déplacez la caméra avec <kbd>Z Q S D</kbd> (ou <kbd>W A S D</kbd>, les flèches, la souris au bord), tournez-la avec <kbd>A</kbd> / <kbd>E</kbd>, zoomez à la molette. Puis <b>cliquez</b> sur un faoudj et <b>clic droit</b> dans le cercle jaune, sous le camp."),
    start(s) { const v = view(); s.v0 = { x: v.focus.x, z: v.focus.z, yaw: v.yaw, h: v.height }; s.m = { ...SP.camp, r: 7 }; markers.push(s.m); },
    done(s) {
      const v = view();
      if (Math.hypot(v.focus.x - s.v0.x, v.focus.z - s.v0.z) > 20) s.moved = true;
      if (Math.abs(v.yaw - s.v0.yaw) > 0.25) s.turned = true;
      if (Math.abs(v.height - s.v0.h) > 5) s.zoomed = true;
      s.there = squads().some((q) => q.members.filter((u) => u.alive && near(u, s.m, s.m.r + 1)).length >= 3);
      return s.moved && s.turned && s.zoomed && s.there;
    },
    sub: (s) => [s.moved ? "✓" : "·", t("déplacer"), s.turned ? "✓" : "·", t("tourner"), s.zoomed ? "✓" : "·", t("zoomer"), s.there ? "✓" : "·", t("un faoudj au cercle")].join(" "),
    end(s) { markers.splice(markers.indexOf(s.m), 1); },
  });
  // 2. hide
  L.push({
    title: t("Se cacher"),
    text: t("Votre arme, c'est le terrain. Maintenez <kbd>V</kbd> : le <b>cyan</b> montre les broussailles qui vous <b>cachent</b> — l'ennemi ne vous voit que de bien plus près. Menez un faoudj dans les broussailles, au cercle. Mais attention : <b>tirer vous trahit</b> quelques secondes."),
    start(s) { s.m = { ...SP.hide, r: 7 }; markers.push(s.m); app.rtsCamera?.focusOn(SP.hide.x, SP.hide.z); },
    done: (s) => squads().some((q) => q.members.filter((u) => u.alive && near(u, s.m, s.m.r + 2) && conceal(u) > 0.25).length >= 3),
    end(s) { markers.splice(markers.indexOf(s.m), 1); },
  });
  // 3. the ambush: hold fire, wait, open up
  L.push({
    title: t("L'embuscade"),
    text: t("Une patrouille française arrive par la vallée. <b>Halte au feu</b> (<kbd>⇧H</kbd>, sur la fiche du faoudj) : vos hommes ne tirent plus et restent cachés. Laissez-la approcher… puis <b>Ouvrir le feu</b> (<kbd>⇧H</kbd> de nouveau) : tout le monde ensemble, à bout portant."),
    start(s) {
      s.f = french(4, SP.patrolPath[0][0], SP.patrolPath[0][1]);
      s.held = false;
      say(t("<b>Patrouille française</b> en approche par la vallée."), SP.patrolPath[0][0], SP.patrolPath[0][1], "bad");
    },
    tick(s) {
      if (!s.f.length) return;
      if (squads().some((q) => q.holdFire)) s.held = true;
      if (s.held && s.f.some((u) => u.alive && squads().some((q) => q.members.some((m) => m.alive && near(m, u.position, 30))))) s.close = true;
      // the patrol walks on; once a shot is fired it fights where it stands (combat keeps it)
      if (!s.f.some((u) => u.target?.alive)) walk(s, s.f, SP.patrolPath);
    },
    where: (s) => alive(s.f),
    done: (s) => allDead(s.f),
    sub: (s) => `${s.held ? "✓" : "·"} ${t("halte au feu")} · ${s.close ? "✓" : "·"} ${t("la patrouille à 30 m")} · ${t("{n} soldats", { n: s.f.filter((u) => u.alive).length })}`,
  });
  // 4. hit and run
  L.push({
    title: t("Frapper et disparaître"),
    text: t("Un <b>half-track</b> monte vers vous : vos fusils ne lui font rien. Ne restez pas : <b>Retraite</b> (<kbd>T</kbd>) — le faoudj court à la grotte, plus vite, sans tirer. Là-bas, <b>Renforcer</b> (<kbd>Y</kbd>) remplace ses morts."),
    start(s) {
      const q = faoudjs()[0];
      const at = q?.members.find((u) => u.alive)?.position ?? SP.hide;
      s.ht = units.spawn("halftrack", SP.roadWest.x + 60, SP.roadWest.z, { team: "player" });
      s.ht?.orderTo(at.x, at.z - 25);
      // (a wounded faoudj — the reinforcement is the point)
      if (q) { const m = q.members.filter((u) => u.alive); if (m.length > 2) m[m.length - 1].takeDamage(1e6); }
      fund(120);
      say(t("<b>Blindé !</b> Un half-track sur la piste."), s.ht?.position.x, s.ht?.position.z, "bad");
    },
    tick(s) {
      if (squads().some((q) => q.retreating)) s.ran = true;
      // it stops short of the scrub, then turns back to the road
      if (s.ht?.alive && !s.ht.isMoving && !s.back) { s.back = true; setTimeout(() => s.ht?.alive && s.ht.orderTo(SP.roadEast.x, SP.roadEast.z), 12000); }
    },
    where: (s) => [s.ran ? caveAt() : s.ht?.position],
    done: (s) => s.ran && faoudjs().some((q) => near(q.members.find((u) => u.alive), caveAt(), 30) && q.members.filter((u) => u.alive).length >= (q.size ?? 4)),
    sub: (s) => `${s.ran ? "✓" : "·"} ${t("retraite")} · ${t("renforcer à la grotte")}`,
    end(s) { if (s.ht?.alive) s.ht.takeDamage(1e6); },
  });
  // 5. the village
  L.push({
    title: t("Le village"),
    text: t("Les douars nourrissent le maquis. Menez des hommes dans le cercle de la mechta : tenue, elle vous <b>paie du ravitaillement</b> chaque minute — sans avoir à la relier à la grotte (les Français, eux, doivent relier leurs points). Le ravitaillement est votre seule ressource : il paie les hommes, les armes, tout."),
    start() { app.rtsCamera?.focusOn(hamletSite.x, hamletSite.z); },
    where: () => [hamletSite],
    done: () => hamlet()?.owner === "enemy",
  });
  // 6. the cave
  L.push({
    title: t("La grotte"),
    text: t("La <b>grotte</b> forme vos combattants. Cliquez-la : sa fiche montre ce qu'elle peut former. Formez un <b>faoudj</b> (quatre moudjahidine), puis une <b>équipe FM</b> — deux hommes et un fusil-mitrailleur, qui cloue l'ennemi au sol."),
    start(s) { s.had = new Set(squads()); fund(300); const c = caveAt(); app.rtsCamera?.focusOn(c.x, c.z); },
    tick(s) { if (newSquads(s, "moudjahid").length) s.f1 = true; if (newSquads(s, "fmTeam").length) s.f2 = true; },
    where: () => [caveAt()],
    done: (s) => s.f1 && s.f2,
    sub: (s) => `${s.f1 ? "✓" : "·"} ${t("un faoudj")} · ${s.f2 ? "✓" : "·"} ${t("une équipe FM")}`,
  });
  // 7. build
  L.push({
    title: t("Bâtir"),
    text: t("Le faoudj bâtit aussi. Sélectionnez-en un, <b>Construire</b> sur sa fiche : un <b>sangar</b> (un muret de pierres sèches : couverture lourde) sur le piton qui domine la route, puis un <b>écran d'embuscade</b> (des branchages : on se cache derrière, il n'arrête pas les balles) devant lui."),
    start(s) { s.seen = new Set(app.algBuild?.sites ?? []); s.mine = []; fund(140); s.m = { ...SP.knollTop, r: 10 }; markers.push(s.m); app.rtsCamera?.focusOn(SP.knollTop.x, SP.knollTop.z); },
    tick(s) { for (const st of app.algBuild?.sites ?? []) if (!s.seen.has(st)) { s.seen.add(st); if (st.team === "enemy") s.mine.push(st); } },
    done: (s) => ["sangar", "ambushScreen"].every((k) => s.mine.some((st) => st.key === k && st.done)),
    sub: (s) => ["sangar", "ambushScreen"].map((k) => `${s.mine.some((st) => st.key === k && st.done) ? "✓" : s.mine.some((st) => st.key === k) ? "…" : "·"} ${k === "sangar" ? t("sangar") : t("écran d'embuscade")}`).join(" · "),
    end(s) { markers.splice(markers.indexOf(s.m), 1); },
  });
  // 8. the arms cache
  L.push({
    title: t("La cache d'armes"),
    text: t("Une <b>cache d'armes</b>, bien cachée dans les broussailles, vous rapporte du ravitaillement chaque minute — et ouvre le <b>bazooka</b> : un faoudj qui en reçoit un (<kbd>U</kbd>) peut enfin frapper les blindés. Bâtissez une cache, puis armez un faoudj."),
    start() { fund(220); },
    tick(s) { if (faoudjs().some((q) => q.upgrades?.bazooka)) s.baz = true; if ((app.algBuild?.sites ?? []).some((st) => st.team === "enemy" && st.key === "armsCache" && st.done)) s.cache = true; },
    done: (s) => s.cache && s.baz,
    sub: (s) => `${s.cache ? "✓" : "·"} ${t("une cache d'armes")} · ${s.baz ? "✓" : "·"} ${t("un bazooka")}`,
  });

  // ── The panel (the French training's) ─────────────────────────────────────
  const style = document.createElement("style");
  style.textContent = `
body #alg-score, #alg-obj { display: none !important; }
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
  el.innerHTML = `<div class="k"><span>${t("Instruction FLN")}</span><span class="n"></span></div><h3></h3><div class="tx"></div><div class="sb"></div>
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
    try { await l.start?.(state); } catch (e) { console.warn("[tutorial fln] start", e); }
    state.ready = true;
  }
  function next() {
    if (i >= 0) {
      try { L[i].end?.(state); } catch { /* */ }
      // A skipped lesson's French would stand in the next one's way: they are cleared.
      if (!el.classList.contains("done")) for (const u of state.f ?? []) if (u.alive) u.takeDamage(1e6);
    }
    waitT = 0;
    if (i + 1 >= L.length) return finish();
    begin(i + 1);
  }
  function showWhere(list) {
    const pts = (list ?? []).filter(Boolean);
    app.algUnits?.minimap?.setObjectives?.(pts);
    app.algTacMap?.map?.setObjectives?.(pts);
  }
  function finish() {
    if (finished) return;
    finished = true;
    showWhere([]);
    el.hidden = true;
    const back = hud.end(`
      <div class="kicker">${t("Le maquis")}</div>
      <h2 class="win">${t("Première instruction terminée")}</h2>
      <p>${t("Vous savez vous cacher, tendre une embuscade, frapper et disparaître, tenir un douar, former vos combattants, bâtir et armer un faoudj d'un bazooka.")}</p>
      <p>${t("<b>La suite arrive :</b> le refuge et le mulet, le sabotage de la ligne, les mines, les blindés — et l'embuscade d'un convoi.")}</p>`, { onReplay: () => location.reload() });
    void back;
  }
  app.addPreRenderHook((dt) => {
    if (!running || finished || i < 0 || !state.ready) return;
    if ((tickT -= dt) > 0) return;
    tickT = P.tick;
    const l = L[i];
    if (l.sub) el.querySelector(".sb").textContent = l.sub(state);
    try { l.tick?.(state); } catch (e) { console.warn("[tutorial fln] tick", e); }
    showWhere(waitT > 0 ? [] : l.where ? l.where(state) : state.m ? [state.m] : []);
    if (waitT > 0) { waitT -= P.tick; if (waitT <= 0) next(); return; }
    let ok = false;
    try { ok = l.done(state); } catch (e) { console.warn("[tutorial fln] check", e); }
    if (ok) {
      el.classList.add("done");
      el.querySelector(".bar i").style.width = `${(100 * (i + 1)) / L.length}%`;
      app.algSounds?.audio?.play?.("radio", null, 0, 0, { gain: 0.5 });
      waitT = P.nextDelay;
    }
  });
  void postSite;

  return {
    lessons: L,
    get step() { return i; },
    next, finish,
    start() {
      if (running) return;
      running = true;
      app.algBattle?.start?.("easy");
      el.hidden = false;
      begin(0);
    },
    brief({ ready = null } = {}) {
      return hud.briefing(`
        <div class="kicker">${t("Algérie, 1956 · Le maquis")}</div>
        <h2>${t("Instruction FLN")}</h2>
        <p>${t("Vous n'avez ni blindés, ni avions, ni artillerie. Vous avez le djebel, les broussailles, les douars — et la surprise. Huit leçons courtes : se cacher, tendre une embuscade, frapper et disparaître, tenir un village, former, bâtir, armer.")}</p>
        <p>${t("Chaque leçon s'affiche en haut de l'écran et passe d'elle-même une fois faite. <b>Passer</b> saute celle que vous connaissez. <kbd>Échap</kbd> : pause, options, manuel.")}</p>`,
        () => this.start(), { ready });
    },
    dispose() { el.remove(); style.remove(); },
  };
}
