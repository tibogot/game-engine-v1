// SALVAGE — a beaten convoy's vehicles (2026-10-18, you: "any vehicle they could have stolen?").
// History: the ALN had no vehicles of its own in the war; it looted ambushed convoys and burned what it
// could not keep (no fuel, no workshops, the T-6s overhead) — and in April 1956 Henri Maillot drove an
// army truck full of weapons to the maquis. CoH's re-crew, made to fit:
//
//   ABANDONED   a French JEEP or GMC "killed" by anything short of a big blast is, `chance` of the time,
//               not a wreck: it stops, its crew bails out (algCrews), and it stands EMPTY — nobody's
//               (team "abandoned"), nobody fires on it, it takes no orders.
//   TAKEN       a man on foot beside it for `take` s (and none of the other side) climbs in: it is his
//               side's. The French get their vehicle back; the FLN get it in its French paint with
//               moudjahidin aboard (unitRenderer tintAs / crewLook).
//   THE FLN'S   it has FUEL for a while, then they burn it (no workshops). A GMC driven to the cave or
//               a refuge is UNLOADED there: its cargo to the purse, then burnt. The FLN's AI does both
//               itself (algAI.js seizes them; a jeep joins its teams, a truck drives home).
//
//   THE FLAG    a vehicle in FLN hands (taken, or the wilaya doctrine's jeep) has the FLN's flag PAINTED
//               on it (`decal: "fln"` — the builders' decals, unitRenderer): on the bonnet, and big across
//               a truck's canvas roof. (A cloth flag on a staff, tried first: a tick from the RTS camera,
//               and a cloth simulation and two draws a vehicle; the paint is one draw for them all.)
import { isHuman } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

export const SALVAGE = {
  types: { willys: { fuel: 150 }, gmc: { fuel: 120, cargo: 80 } },
  chance: 0.6,        // a light vehicle's death that leaves it abandoned
  overkill: 0.3,      // a hit this far past its last hp (of its max) blows it up anyway (a mine, a shell)
  hpLeft: 0.25,       // what an abandoned vehicle has left, of its max
  reach: 3.5,         // m past its hull: a man this near takes it
  take: 3,            // s beside it
  home: 22,           // m from the cave / a refuge: a truck is unloaded
  crewSurvive: 0.55,  // each FLN man's chance of getting out when a taken vehicle is destroyed
};
const P = SALVAGE;

export function createAlgSalvage(app, { units }) {
  const abandoned = new Set();
  const taken = new Set();      // the FLN's, with fuel left
  const foot = (u) => u.alive && u.type?.foot && !u.type?.animal && !u.inside && !u.carrier && !u.isStructure;
  const near = (a, b, r) => Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) < r;
  const say = (text, v, kind = "good") => app.algBattle?.say?.(text, v.position.x, v.position.z, kind);
  const combat = () => app.algCombat?.combat ?? app.algCombat;

  /** Its orders off while it stands empty (a patrol, a lift, the French AI would drive it). */
  function freeze(v) {
    v._salvSaved = { orderTo: v.orderTo, moveOrder: v.moveOrder };
    v.orderTo = () => {}; v.moveOrder = () => {};
  }
  function thaw(v) {
    if (!v._salvSaved) return;
    v.orderTo = v._salvSaved.orderTo; v.moveOrder = v._salvSaved.moveOrder;
    delete v._salvSaved;
  }

  /** A French light vehicle's damage: short of a big blast, a killing hit may leave it abandoned. */
  function wrap(v) {
    v._salv = true;
    const td = v.takeDamage.bind(v);
    v.takeDamage = (n) => {
      if (v.alive && v.team === "player" && n >= v.hp && n - v.hp < P.overkill * v.maxHp && Math.random() < P.chance) { abandon(v); return; }
      td(n);
    };
  }
  function abandon(v) {
    app.algTransports?.unloadAll?.(v);
    v.stop?.();                         // (out of its patrol: algPatrols wraps stop)
    v.haltMovement?.();
    app.algCrews?.bail?.(v);            // the crew out, as from a wreck
    v.hp = v.maxHp * P.hpLeft;
    v.team = "abandoned";
    v.passive = true; v.holdFire = true; v.target = null; v.attackTarget = null;
    v.crewLook = "";                    // nobody aboard
    v.tintAs = "player";
    v.salvT = { player: 0, enemy: 0 };
    freeze(v);
    app.selection?.remove?.(v);
    app.algCombat?.fx?.dirt?.(v.position.x, v.position.y, v.position.z, 2);
    abandoned.add(v);
    if (isHuman("player")) say(t("<b>Véhicule abandonné</b> : l'équipage a sauté. Un homme à côté le reprend — sinon le FLN s'en emparera."), v, "bad");
    else say(t("<b>Un véhicule français abandonné</b> : un homme à côté s'en empare."), v);
  }

  /** Taken by `side`: `man` climbs in (he is its crew now). */
  function seize(v, side, man) {
    abandoned.delete(v);
    man.alive = false; man.vanished = true;   // aboard (not killed: no corpse, no kill)
    app.selection?.remove?.(man);
    thaw(v);
    v.team = side;
    v.passive = false; v.holdFire = false;
    if (side === "enemy") {
      v.crewLook = "moudjahid"; v.tintAs = "player"; v.decal = "fln";
      v.fuelLeft = P.types[v.typeKey]?.fuel ?? 120;
      v.lootCrew = 1 + (v.typeKey === "willys" ? 1 : 0);   // the man who took it, and one to man the gun
      taken.add(v);
      if (isHuman("enemy")) say(t("<b>Véhicule pris</b> : du carburant pour {n} s, puis il faudra l'incendier.", { n: Math.round(v.fuelLeft) }), v);
      else say(t("<b>Le FLN s'est emparé</b> d'un véhicule abandonné."), v, "bad");
      if (!isHuman("enemy")) app.algAI?.adoptVehicle?.(v);
    } else {
      v.crewLook = null; v.tintAs = null; v.decal = null;
      if (isHuman("player")) say(t("<b>Véhicule repris</b>."), v);
    }
  }

  /** Burnt by the FLN (no fuel, or unloaded): it goes up, its crew out. */
  function burn(v, crewHome = false) {
    taken.delete(v);
    if (crewHome) { app.algAI?.toGround?.(v.lootCrew ?? 1); v.lootCrew = 0; }
    v._burnt = true;                    // (set alight by its own crew: they all get out — onDeath)
    combat()?.onImpact?.(v, 1e6, v.position);
  }

  /** combat's onDeath: a taken vehicle destroyed — its FLN crew, those who get out. */
  function onDeath(v) {
    abandoned.delete(v);
    if (!taken.has(v) && !(v.lootCrew > 0)) return;
    taken.delete(v);
    const n = v.lootCrew ?? 0;
    v.lootCrew = 0;
    for (let i = 0; i < n; i++) {
      if (!v._burnt && Math.random() > P.crewSurvive) continue;
      const a = (v.heading ?? 0) + Math.PI + (i - 0.5) * 0.9;
      const w = app.navGrid?.nearestOpenWorld?.(v.position.x + Math.sin(a) * 4, v.position.z + Math.cos(a) * 4, true) ?? v.position;
      const u = units.spawn("moudjahid", w.x, w.z, { team: "enemy" });
      if (u) u.hp = u.maxHp * (0.35 + Math.random() * 0.45);
    }
  }

  const homes = () => [
    ...(app.algStructures?.list ?? []).filter((s) => s.alive && s.team === "enemy" && (s.typeKey === "caveEntrance" || s.typeKey === "refuge")),
  ];

  function step(dt) {
    // New French light vehicles: their damage wrapped once.
    for (const u of units.list) if (u.alive && !u._salv && u.team === "player" && P.types[u.typeKey] && u.takeDamage) wrap(u);
    // The abandoned: a man of either side beside it (and none of the other) takes it.
    for (const v of abandoned) {
      if (!v.alive) { abandoned.delete(v); continue; }
      const by = { player: null, enemy: null }, r = P.reach + (v.radius ?? v.type?.radius ?? 2);   // (from its hull, not its centre: a GMC is 6 m long)
      for (const u of units.near ? units.near(v.position.x, v.position.z, r + 2, []) : units.list) {
        if (!foot(u) || (u.team !== "player" && u.team !== "enemy") || !near(u, v, r)) continue;
        by[u.team] ??= u;
      }
      for (const side of ["player", "enemy"]) {
        const other = side === "player" ? "enemy" : "player";
        v.salvT[side] = by[side] && !by[other] ? v.salvT[side] + dt : 0;
        if (v.salvT[side] >= P.take) { seize(v, side, by[side]); break; }
      }
    }
    // The FLN's: fuel, and a truck unloaded at home.
    for (const v of taken) {
      if (!v.alive || v.team !== "enemy") { taken.delete(v); continue; }
      const cargo = P.types[v.typeKey]?.cargo;
      if (cargo && homes().some((h) => near(v, h, P.home))) {
        app.algEconomy?.aln?.earn?.(cargo);
        if (isHuman("enemy")) say(t("<b>Le camion est vidé</b> : +{n} ravitaillement. Il est incendié.", { n: cargo }), v);
        burn(v, true);
        continue;
      }
      if ((v.fuelLeft -= dt) <= 0) {
        if (isHuman("enemy")) say(t("<b>Plus de carburant</b> : le véhicule pris est incendié."), v, "bad");
        burn(v);
      }
    }
  }

  return {
    params: P, step, onDeath,
    /** The vehicles standing empty, nobody's. */
    get abandoned() { return [...abandoned]; },
    /** The FLN's taken vehicles (fuel left). */
    get taken() { return [...taken]; },
    /** The nearest home for a taken truck (the cave, a refuge): { x, z } or null. */
    homeFor(v) { return homes().sort((a, b) => Math.hypot(a.position.x - v.position.x, a.position.z - v.position.z) - Math.hypot(b.position.x - v.position.x, b.position.z - v.position.z))[0]?.position ?? null; },
    /** Dev: abandon `v` now. */
    abandon(v) { if (v?.alive && v.team === "player" && P.types[v.typeKey]) abandon(v); },
  };
}
