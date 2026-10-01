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
    if (best?.kind === "aln") return "leaving their camp";
    return best ? `near ${best.name}` : "in the djebel";
  };
  function say(text, x, z, kind) {
    hud.alert(text, { x, z, kind, time: clock });
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
        if (v.owner === "player") say(`<b>${v.name}</b> is yours. It pays you, and counts for you.`, x, z, "good");
        else if (v.owner === "enemy") say(`<b>${v.name}</b> now backs the FLN. Win it back: stand men in it.`, x, z, "bad");
        else if (L.owner === "player") say(`<b>${v.name}</b> slipped away: the FLN turned it.`, x, z, "bad");
        else if (L.owner === "enemy") say(`<b>${v.name}</b> no longer backs the FLN.`, x, z, "good");
        L.owner = v.owner;
      }
      // Turning: FLN men in it and the needle moving their way.
      const falling = v.value < L.value - 1e-4;
      if (falling && v.value > -economy.params.hold && clock - L.turnAt > P.turnEvery) {
        const r = economy.params.radius;
        const aln = units.list.some((u) => u.alive && u.team === "enemy" && u.type?.foot && Math.hypot(u.position.x - x, u.position.z - z) < r);
        if (aln) { L.turnAt = clock; say(`The FLN is working <b>${v.name}</b>. Send men before it turns.`, x, z, "bad"); }
      }
      L.value = v.value;
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
          if (!throttled("contact", x, z, P.contactEvery)) { say(`<b>Contact</b> ${placeName(x, z)}!`, x, z, "bad"); told.add("contactSeen"); }
          else if (!u.alive && !u.type?.foot && !throttled(`lost:${u.typeKey}`, x, z, 10)) say(`${u.type?.name ?? "A vehicle"} destroyed ${placeName(x, z)}.`, x, z, "bad");
        }
      } else if (u.team === "enemy") {
        if (was > 0 && !u.alive) stats.lostAln++;
        // A band seen: the first sight of these men, away from their cave.
        if (u.alive && !reported.has(u) && seenByPlayer(x, z) && (!cave || Math.hypot(x - cave.position.x, z - cave.position.z) > 80)) {
          let n = 0;
          for (const o of units.list) {
            if (o.alive && o.team === "enemy" && Math.hypot(o.position.x - x, o.position.z - z) < 35) { n++; reported.add(o); }
          }
          if (!throttled("sight", x, z, P.sightEvery)) { say(`FLN ${n > 1 ? `band (${n})` : "fighter"} seen ${placeName(x, z)}.`, x, z, ""); told.add("bandSeen"); }
        }
      }
    }
  }

  function watchMines() {
    if (!mines) return;
    const now = new Set(mines.list);
    for (const m of now) {
      const was = knownMines.get(m);
      if (was === false && m.spotted) say(`A <b>mine</b> spotted on the track ${placeName(m.x, m.z)}. Men on foot clear it.`, m.x, m.z, "");
      knownMines.set(m, m.spotted);
    }
    for (const [m] of knownMines) {
      if (now.has(m)) continue;
      knownMines.delete(m);
      if (m.clearT >= (mines.params?.clearTime ?? 1e9)) say(`Mine cleared ${placeName(m.x, m.z)}.`, m.x, m.z, "good");
      else say(`A <b>mine</b> went up ${placeName(m.x, m.z)}!`, m.x, m.z, "bad");
    }
  }

  function watchBuildings() {
    for (const s of structures.list) {
      const was = aliveB.get(s);
      aliveB.set(s, s.alive);
      const { x, z } = s.position;
      if (was && !s.alive) say(`${s.name ?? "A building"} destroyed.`, x, z, s.team === "player" ? "bad" : "good");
      const hp = hpOf.get(s);
      hpOf.set(s, s.hp);
      if (hp != null && s.alive && s.hp < hp - 1e-6) {
        if (s === post && !throttled("post", x, z, 30)) say("<b>The post is under attack!</b>", x, z, "bad");
        else if (s === cave && !throttled("cave", x, z, 45)) say("The cave is under fire. Destroy it to win.", x, z, "good");
      }
    }
  }

  // ── The rule ──────────────────────────────────────────────────────────────
  function stepScore(dt) {
    const fr = economy.held, al = economy.heldByEnemy, diff = fr - al;
    if (diff > 0) score.enemy = Math.max(0, score.enemy - P.drain * diff * dt);
    else if (diff < 0) score.player = Math.max(0, score.player + P.drain * diff * dt);
    let end = null;
    if (cave && !cave.alive) end = { winner: "player", why: "The FLN's cave is destroyed: the katiba has nowhere to go." };
    else if (post && !post.alive) end = { winner: "enemy", why: "The post has fallen." };
    else if (score.enemy <= 0) end = { winner: "player", why: "The villages are yours: the FLN has lost the valley." };
    else if (score.player <= 0) end = { winner: "enemy", why: "The villages went over to the FLN: Paris recalls the company." };
    if (end) finish(end);
  }

  function finish(end) {
    over = end;
    const win = end.winner === "player";
    say(win ? "<b>Victory.</b>" : "<b>Defeat.</b>", null, null, win ? "good" : "bad");
    hud.end(`
      <div class="kicker">Aurès · ${fmt(clock)}</div>
      <h2 class="${win ? "win" : "lose"}">${win ? "Victory" : "Defeat"}</h2>
      <p>${end.why}</p>
      <table>
        <tr><td>Score</td><td>France ${Math.ceil(score.player)} · FLN ${Math.ceil(score.enemy)}</td></tr>
        <tr><td>Villages held</td><td>France ${economy.held} · FLN ${economy.heldByEnemy} · of ${economy.points.length}</td></tr>
        <tr><td>Men and vehicles lost</td><td>France ${stats.lostFr} · FLN ${stats.lostAln}</td></tr>
      </table>`, { onReplay: () => location.reload() });
  }
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ── OBJECTIVES (top left): what to do now, always in view ────────────────
  const home = post?.position ?? { x: 0, z: 0 };
  const ownerName = (o) => (o === "player" ? "yours" : o === "enemy" ? "FLN-held" : "neutral");
  let objT = 0;
  function objectives(dt) {
    if ((objT -= dt) > 0) return;
    objT = 0.5;
    const fr = economy.held, al = economy.heldByEnemy;
    const list = [{
      text: "Hold more villages than the FLN",
      sub: `You ${fr} · FLN ${al} of ${economy.points.length} — ${fr > al ? "the FLN is bleeding" : fr < al ? "<b style='color:var(--hud-red)'>you are bleeding</b>" : "even: nobody bleeds"}`,
      state: fr > al ? "done" : fr < al ? "bad" : "",
    }];
    // The next village to take: the nearest one not yours (to the post).
    const todo = economy.points.filter((v) => v.owner !== "player")
      .sort((a, b) => Math.hypot(a.position.x - home.x, a.position.z - home.z) - Math.hypot(b.position.x - home.x, b.position.z - home.z))[0];
    if (todo) {
      const fln = units.list.filter((u) => u.alive && u.team === "enemy" && Math.hypot(u.position.x - todo.position.x, u.position.z - todo.position.z) < economy.params.radius).length;
      list.push({
        text: `Take ${todo.name}`,
        sub: `${ownerName(todo.owner)}${fln ? ` · <b style='color:var(--hud-red)'>${fln} FLN inside</b>` : ""} · stand men on foot in its ring`,
        x: todo.position.x, z: todo.position.z,
      });
    } else list.push({ text: "Hold your villages", sub: "leave a few men in each: the FLN works them back", state: "done" });
    if (cave) list.push({ text: "Destroy the FLN cave (north-west)", sub: cave.alive ? (cave.hp < cave.maxHp ? `${Math.round((100 * cave.hp) / cave.maxHp)}% left` : "wins the war outright · bring armour and mortars") : "destroyed", state: cave.alive ? "" : "done", x: cave.position.x, z: cave.position.z });
    if (post) list.push({ text: "Keep the post", sub: post.hp < post.maxHp ? `${Math.round((100 * post.hp) / post.maxHp)}% left` : "lose it and the war is lost", state: post.hp < post.maxHp * 0.5 ? "bad" : "", x: post.position.x, z: post.position.z });
    const lv = { easy: "Easy", normal: "Normal", hard: "Hard" }[app.algDifficulty] ?? "";
    hud.setObjectives(list, `${fmt(clock)}${lv ? ` · ${lv}` : ""}`);
  }

  // ── ADVICE: one tip per first time something happens ────────────────────
  const told = new Set(), tips = [];
  let tipGap = 0;
  const advise = (key, text) => { if (told.has(key)) return; told.add(key); tips.push(text); };
  function advice(dt) {
    // Firsts, from what the watchers and the economy show.
    if (started && clock > startAt + 3) advise("start", "Drag a box round your men, then <b>right-click</b> near a village to send them there. Click an objective to look at it.");
    const footIn = units.list.some((u) => u.alive && u.team === "player" && u.type?.foot && economy.points.some((v) => Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) < economy.params.radius));
    if (footIn) advise("inRing", "Keep them in the ring: the bar under the village's name fills toward you. Only men on foot count; more men, faster (up to 3).");
    if (economy.held > 0) advise("firstVillage", "A village of yours pays supplies and counts as a point. The FLN will try to turn it back — <b>leave a few men</b> in it.");
    if (stats.lostFr > 0 || told.has("contactSeen")) advise("contact", "Under fire: hold <b>V</b> to see cover (green) and concealment (cyan). Men behind walls and rocks live; men in the open don't.");
    if (economy.heldByEnemy > economy.held) advise("bleeding", "The FLN holds more villages than you: <b>your score is falling</b>. Take one back.");
    if (economy.french.stock >= 260 && clock > 60) advise("build", "Supplies to spend: click the post to train a <b>Sapeur</b> — he builds MG nests, wire and miradors to hold what you take.");
    if (told.has("bandSeen")) advise("band", "An FLN band won't fight fair: it waits in the scrub and strikes men who come close. Scout with the jeep, bring the MG, keep men together.");
    if ((tipGap -= dt) > 0 || !tips.length) return;
    tipGap = 14;
    hud.alert(tips.shift(), { kind: "tip", life: 24 });
  }
  let started = false, startAt = 0;

  // The village tooltip (hover its marker).
  hud.setTooltip((v) => {
    const r = economy.params.radius;
    let fr = 0, al = 0;
    for (const u of units.list) {
      if (!u.alive || !u.type?.foot || Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) > r) continue;
      if (u.team === "player") fr++; else if (u.team === "enemy") al++;
    }
    const pay = economy.params.village[v.kind] ?? economy.params.village.hamlet;
    const lean = v.value > 0.02 ? `${Math.round(v.value * 100)}% toward France` : v.value < -0.02 ? `${Math.round(-v.value * 100)}% toward the FLN` : "undecided";
    return `<b>${v.name}</b> <span class="dim">· ${v.kind}</span><br>Backs: <b>${v.owner === "player" ? "France" : v.owner === "enemy" ? "the FLN" : "nobody"}</b> (${lean}; held at 60%)<br>Pays its holder <b>+${pay}/min</b> and counts as a victory point<br>In its ring now: France ${fr} · FLN ${al}<br><span class="dim">Stand men on foot in the ring to win it over (more men, faster, up to 3).</span>`;
  });

  // ── The clock ─────────────────────────────────────────────────────────────
  const frame = (dt) => {
    dt = Math.min(dt, 0.1);
    clock += dt;
    watchUnits();
    watchBuildings();
    watchVillages();
    watchMines();
    if (!over) stepScore(dt);
    hud.setScore({ fr: score.player, aln: score.enemy, max: P.start, heldFr: economy.held, heldAln: economy.heldByEnemy });
    hud.markers(economy.points);
    objectives(dt);
    advice(dt);
    hud.tick();
  };
  app.addPreRenderHook(frame);

  return {
    params: P, score, stats,
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
        <h2>Hold the valley</h2>
        <ul>
          <li>The <b>${n} villages</b> are what this war is about. Each one pays supplies to whoever it backs, and each is a <b>victory point</b> (the markers over them; ◆ on the minimap).</li>
          <li><b>Win a village</b> by standing men on foot in it. The bar under its name moves toward whoever has more men there.</li>
          <li>You both start at <b>500</b>. Whoever holds <b>fewer</b> villages bleeds points every second; at 0 they lose. <b>Destroy the FLN's cave</b> (north-west) to win outright. <b>Lose the post</b> and it is over.</li>
          <li>The <b>FLN</b> won't fight you in the open. It works the villages quietly, ambushes men who wander, mines the pistes, and slips back to its cave. Garrison, patrol, build.</li>
        </ul>
        <div class="keys"><kbd>Space</kbd> go to the latest alert · click an alert to go there · hold <kbd>V</kbd> to see cover · <kbd>R</kbd> turns a building · hover a village for its details</div>`,
      go, { levels: DIFFICULTIES, current: storedDifficulty() });
    },
    dispose() { app.removePreRenderHook?.(frame); hud.dispose(); },
  };
}
