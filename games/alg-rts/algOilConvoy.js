// THE OIL CONVOY (2026-11-02, El Kantara — you: "ok do 1 and 2"): the French side's own convoy, the FLN's target. Now
// and then a TANKER (buildGMC body "tanker") and its escort JEEP come down the road from Batna, out of the gorge at the map's north edge
// (MAP.oilConvoy.route), to the PUMP STATION, load (a stop of `load` s) and drive back north the way they came (the fuel for Batna's depot). Back
// out with the tanker alive: the post keeps its share (`fuel`). The tanker lost: nothing, and the post is told. The
// vehicles are the French side's units (a human French player can escort them). THE FLN HEARS OF IT (its informants:
// algAI convoyComing — a band lies up on the route for the round trip, the wire team goes for its road; a human FLN is
// told). Off the route, held by a fight, they wait and go on.
//
//   MAP.oilConvoy = { route: [[x, z], …] from the edge to the station's front, first: s, every: [s, s], load: s, fuel }
import { t } from "./i18n/i18n.js";
import { isHuman } from "../shared-rts/teams.js";

export function createOilConvoy(app, { units, economy, cfg }) {
  const route = cfg.route.map(([x, z]) => ({ x, z }));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const rand = (a, b) => a + Math.random() * (b - a);
  const say = (...a) => app.algBattle?.say?.(...a);
  let next = cfg.first ?? 120, run = null, told = false;
  const WARN = cfg.warn ?? 60;   // s: the FLN hears of it this long before it is on the map (it leaves Batna)
  /** A MINUTE AHEAD, both sides hear of it — THE FLN: its AI (algAI convoyComing) lies up on the route and sends its wire team; a human FLN is told. */
  function tell() {
    told = true;
    const a = route[0];
    // (the post is told as early: a minute to clear the road — the convoy drives blind past what the FLN holds)
    if (isHuman("player")) say(t("<b>Un convoi de carburant</b> quitte Batna : il sera dans les gorges dans une minute. Ouvrez-lui la route."), a.x, a.z, "", null, "alertAttack");
    else if (isHuman("enemy")) say(t("<b>Les informateurs</b> signalent un convoi français qui descend des gorges : un camion-citerne vers la station de pompage. Tendez-lui une embuscade."), a.x, a.z, "good", null, "alertAttack");
    app.algAI?.convoyComing?.(route, Math.max(0, next) + (cfg.trip ?? 170));
  }

  function start() {
    const a = route[0], b = route[1];
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    const tanker = units.spawn("gmcCiterne", a.x, a.z, { team: "player" });
    const jeep = units.spawn("willys", a.x - Math.sin(yaw) * 12, a.z - Math.cos(yaw) * 12, { team: "player" });
    if (!tanker) return;
    for (const v of [tanker, jeep]) if (v) v.convoy = true;
    run = { tanker, jeep, leg: 1, dir: 1, wait: 0, t: 0 };
    go(run);
    if (isHuman("player")) say(t("<b>Convoi de carburant</b> descendant de Batna par les gorges : un camion-citerne et sa jeep vont à la station de pompage. Couvrez la route."), a.x, a.z, "");
  }
  /** The next point of the route, both vehicles (the jeep 12 m behind on the way in, ahead on the way out). */
  function go(r) {
    const p = route[r.leg];
    r.tanker.orderTo(p.x, p.z);
    if (r.jeep?.alive) {
      const q = route[Math.max(0, Math.min(route.length - 1, r.leg - r.dir))];
      const dx = p.x - q.x, dz = p.z - q.z, d = Math.hypot(dx, dz) || 1, off = r.dir > 0 ? -12 : 12;
      r.jeep.orderTo(p.x + (dx / d) * off, p.z + (dz / d) * off);
    }
    r.orderedAt = r.t;
  }
  function end(ok) {
    if (ok) {
      economy.french?.earn?.({ fuel: cfg.fuel ?? 60 });
      if (isHuman("player")) say(t("<b>Convoi passé :</b> le carburant de la station est parti pour Batna, le poste en garde sa part."), run.tanker.position.x, run.tanker.position.z, "good");
      for (const v of [run.tanker, run.jeep]) if (v?.alive) { v.alive = false; v.vanished = true; app.selection?.remove?.(v); }   // (off the map: no wreck, no kill)
    } else if (isHuman("player")) {
      const p = run.tanker.position;
      say(t("<b>Convoi perdu !</b> Le camion-citerne a été détruit sur la route."), p.x, p.z, "bad", "hq_contact", "alertAttack");
    }
    run = null;
  }

  function step(dt) {
    if (!run) {
      if ((next -= dt) <= WARN && !told) tell();
      if (next <= 0) { next = rand(...(cfg.every ?? [240, 330])); told = false; start(); }
      return;
    }
    run.t += dt;
    const r = run, tk = r.tanker;
    if (!tk.alive) return end(false);
    if (r.wait > 0) { if ((r.wait -= dt) <= 0) { r.dir = -1; r.leg = route.length - 2; go(r); } return; }
    const p = route[r.leg];
    if (dist(tk.position, p) < 8) {
      if (r.dir > 0 && r.leg === route.length - 1) { r.wait = cfg.load ?? 25; return; }   // at the station: loading
      if (r.dir < 0 && r.leg === 0) return end(true);                                     // back out at the edge
      r.leg += r.dir;
      go(r);
    } else if (!tk.isMoving && r.t - r.orderedAt > 6) go(r);   // (stopped by a fight or a jam: on again)
  }
  return { step, get run() { return run; }, startNow: () => { if (!run) { if (!told) tell(); told = false; start(); } }, tellNow: () => { next = Math.min(next, WARN); } };
}
