// THE HELIPAD'S FLY-INS (2026-10-19, you: "is the helicopter supposed to come out of it? it doesn't look
// realistic if they come out of the ground … they should come from out of the map"). A forward hélisurface
// in Algeria was no factory: the helicopters were based at the airfields (Batna, Sétif, Constantine) and
// FLEW IN. So what the pad builds is brought in from the map edge nearest it (CoH's call-ins come the
// same way: aircraft never leave a building):
//   ALOUETTE / H-21  appears past the edge, at its hover, and flies to the pad's holding point — yours
//                    from the first second (the build time is the order; the flight is on top).
//   PARAS            a stick of five flown in by an H-21 of the base: it lands ON the H, the men jump out
//                    and go to the holding point, it lifts off and flies back out — gone past the edge (no
//                    wreck, no kill, not yours: not selectable, outside the troop count). Shot down on the
//                    way in, the stick dies with it — the landing zone is the dangerous minute.
import { PLAY } from "./layout.js";

const P = {
  out: 70,          // m past the edge where a helicopter appears / is taken away
  gone: 12,         // m from that point: the delivery H-21 is home
  fan: 2.8,         // m between the men at the holding point
};

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units
 * @param {object} o.heli         algHeliLift (landAt)
 * @param {object} o.transports   algTransports (load, unloadAll, menOf)
 * @param {{x:number,z:number}} o.pad    the H, world
 * @param {{x:number,z:number}} o.rally  the holding point, world
 * @param {string} [o.team]
 * @param {(u, key, slot) => void} [o.onSpawned]  the squad builder (algSquads.bought)
 */
export function createAlgHeliDelivery(app, { units, heli, transports, pad, rally, team = "player", onSpawned = null }) {
  // The edge: the side of the play box nearest the pad, straight out from it.
  const sides = [
    { d: pad.x - PLAY.x0, x: PLAY.x0 - P.out, z: pad.z },
    { d: PLAY.x1 - pad.x, x: PLAY.x1 + P.out, z: pad.z },
    { d: pad.z - PLAY.z0, x: pad.x, z: PLAY.z0 - P.out },
    { d: PLAY.z1 - pad.z, x: pad.x, z: PLAY.z1 + P.out },
  ];
  const edge = sides.reduce((a, b) => (b.d < a.d ? b : a));
  const jobs = [];   // { v, men, phase: "in" | "out" }

  /** The producer's hook: true when this key is brought in here. */
  function deliver(key, count) {
    if (key === "para") return stick(key, count), true;
    if (key === "alouette" || key === "h21") {
      const u = units.spawn(key, edge.x, edge.z, { snap: false, team });
      if (!u) return true;
      u.faceToward(pad.x, pad.z);
      onSpawned?.(u, key, 0);
      u.orderTo(rally.x, rally.z);
      return true;
    }
    return false;
  }

  function stick(key, count) {
    const v = units.spawn("h21", edge.x, edge.z, { snap: false, team });
    if (!v) return;
    v.unselectable = true;   // flown by the base, not by you
    v.delivery = true;       // outside the troop count (algUnits popNow)
    v.holdFire = true;
    v.faceToward(pad.x, pad.z);
    const men = [];
    for (let k = 0; k < count; k++) {
      const u = units.spawn(key, edge.x, edge.z, { snap: false, team, lookRole: count > 1 ? k : null });
      if (!u) continue;
      onSpawned?.(u, key, k);
      men.push(u);
    }
    transports.load(men, v);
    const job = { v, men, phase: "in" };
    jobs.push(job);
    heli.landAt(v, pad.x, pad.z, () => {
      transports.unloadAll(v);
      // Off the H to the holding point, fanned out.
      men.forEach((u, k) => {
        if (!u.alive) return;
        const a = k * 2.39996, r = k === 0 ? 0 : P.fan;
        (u.moveOrder ?? u.orderTo).call(u, rally.x + Math.cos(a) * r, rally.z + Math.sin(a) * r);
      });
      // and home (a goal away from the H: algHeliLift lifts it off first)
      v.orderTo(edge.x, edge.z);
      job.phase = "out";
    });
  }

  function step() {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const { v, phase } = jobs[i];
      if (!v.alive) { jobs.splice(i, 1); continue; }
      if (phase === "out" && !transports.menOf(v).length && Math.hypot(v.position.x - edge.x, v.position.z - edge.z) < P.gone) {
        // Gone home: out of the game quietly — not a kill (combat's death path never runs).
        v.alive = false;
        app.selection?.remove?.(v);
        jobs.splice(i, 1);
      }
    }
  }

  return { deliver, step, edge, jobs };
}
