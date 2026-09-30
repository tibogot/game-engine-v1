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
          if (!throttled("contact", x, z, P.contactEvery)) say(`<b>Contact</b> ${placeName(x, z)}!`, x, z, "bad");
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
          if (!throttled("sight", x, z, P.sightEvery)) say(`FLN ${n > 1 ? `band (${n})` : "fighter"} seen ${placeName(x, z)}.`, x, z, "");
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
    hud.tick();
  };
  app.addPreRenderHook(frame);

  return {
    params: P, score, stats,
    get over() { return over; },
    get clock() { return clock; },
    /** The briefing: what the fight is about. Shown once the loading screen lifts. */
    brief() {
      const n = economy.points.length;
      return hud.briefing(`
        <div class="kicker">Aurès, 1956 · Poste de Tighanimine</div>
        <h2>Hold the valley</h2>
        <ul>
          <li>The <b>${n} villages</b> are what this war is about. Each one pays supplies to whoever it backs, and each is a <b>victory point</b> (the markers over them; ◆ on the minimap).</li>
          <li><b>Win a village</b> by standing men on foot in it. The bar under its name moves toward whoever has more men there.</li>
          <li>You both start at <b>500</b>. Whoever holds <b>fewer</b> villages bleeds points every second; at 0 they lose. <b>Destroy the FLN's cave</b> (north-west) to win outright. <b>Lose the post</b> and it is over.</li>
          <li>The <b>FLN</b> won't fight you in the open. It works the villages quietly, ambushes men who wander, mines the pistes, and slips back to its cave. Garrison, patrol, build.</li>
        </ul>
        <div class="keys"><kbd>Space</kbd> go to the latest alert · click an alert to go there · hold <kbd>V</kbd> to see cover · <kbd>R</kbd> turns a building</div>`);
    },
    dispose() { app.removePreRenderHook?.(frame); hud.dispose(); },
  };
}
