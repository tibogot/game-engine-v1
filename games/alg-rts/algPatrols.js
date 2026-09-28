// PATROLS AND CONVOYS — the French order that uses the tracks (algTracks.js).
//
//   PATROUILLE  the selection takes the NEAREST track (vehicles: the piste
//               only; mule paths are for men) and walks it in FILE, men 5 m
//               apart, vehicles 14 m, from where they join it toward its
//               longer end; at the end the file turns and comes back — until
//               they are given any other order (a move, Stop). Contact is
//               fought as ever (combat.js chases and fires), then the file
//               picks the track up again where it left it.
//   CONVOI      a GMC on patrol that passes through a village the French
//               HOLD delivers supplies there (+30, once a village each two
//               minutes a truck): the road has to be kept open for the trucks
//               to pay — and that is where the ALN mines it (algMines.js).
import { TRACK_LINES } from "./algTracks.js";

const P = {
  tick: 0.5,            // re-plan every half second, not every frame
  ahead: 24,            // the leader's next goal, metres along the track
  reach: 9,             // "there" for the leader
  spacingFoot: 5, spacingVehicle: 14,
  reorderMove: 6,       // re-path a man only when his goal moved this far
  convoyPay: 30, convoyEvery: 120, convoyR: 70,   // the piste stops at the village edge
};

/** Cumulative arc length along a line of {x, z}. */
function arcOf(line) {
  const s = [0];
  for (let i = 1; i < line.length; i++) s.push(s[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z));
  return s;
}

export function createAlgPatrols(app, { units, economy, onDelivery = () => {} }) {
  const patrols = [];
  const byUnit = new Map();
  const tracks = TRACK_LINES.map((t) => ({ ...t, arc: arcOf(t.line) }));
  tracks.forEach((t) => { t.total = t.arc[t.arc.length - 1]; });
  let simT = 0;

  const pointAt = (t, s) => {
    s = Math.max(0, Math.min(t.total, s));
    let i = 1;
    while (i < t.arc.length - 1 && t.arc[i] < s) i++;
    const f = (s - t.arc[i - 1]) / Math.max(1e-6, t.arc[i] - t.arc[i - 1]);
    const a = t.line[i - 1], b = t.line[i];
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
  };
  const nearestS = (t, x, z) => {
    let best = 0, bd = Infinity;
    t.line.forEach((p, i) => { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = t.arc[i]; } });
    return { s: best, d: bd };
  };
  const busy = (u) => (u.attackTarget?.alive) || (u.target?.alive);

  /** Out of its patrol: its own orders back, the patrol gone if empty. */
  function leave(u) {
    const p = byUnit.get(u);
    if (!p) return;
    byUnit.delete(u);
    u.moveOrder = u._patrolSaved.moveOrder;
    u.stop = u._patrolSaved.stop;
    delete u._patrolSaved;
    p.members.splice(p.members.indexOf(u), 1);
    if (!p.members.length) patrols.splice(patrols.indexOf(p), 1);
  }

  /**
   * Start a patrol with these units. Returns the track taken, or null (no
   * one able to, or no track near enough — 150 m).
   */
  function start(selected) {
    const list = selected.filter((u) => u.alive && u.team === "player" && !u.isAir && !u.isStructure && u.orderTo);
    if (!list.length) return null;
    for (const u of list) leave(u);
    const vehicles = list.some((u) => !u.type?.foot);
    const cx = list.reduce((a, u) => a + u.position.x, 0) / list.length;
    const cz = list.reduce((a, u) => a + u.position.z, 0) / list.length;
    let track = null, at = null;
    for (const t of tracks) {
      if (vehicles && t.kind !== "piste") continue;
      const n = nearestS(t, cx, cz);
      if (!at || n.d < at.d) { track = t; at = n; }
    }
    if (!track || at.d > 150) return null;
    // Toward the longer end; the man furthest along that way leads.
    const dir = track.total - at.s >= at.s ? 1 : -1;
    const members = list
      .map((u) => ({ u, s: nearestS(track, u.position.x, u.position.z).s }))
      .sort((a, b) => (b.s - a.s) * dir)
      .map((e) => e.u);
    const p = { track, s: at.s + dir * P.ahead, dir, members, t: P.tick, goals: new Map(), spacing: vehicles ? P.spacingVehicle : P.spacingFoot, paid: new Map() };
    patrols.push(p);
    for (const u of members) {
      byUnit.set(u, p);
      // Any order of the player's own takes the man out of the patrol.
      u._patrolSaved = { moveOrder: u.moveOrder, stop: u.stop };
      u.moveOrder = (...a) => { leave(u); return u.moveOrder(...a); };
      u.stop = (...a) => { leave(u); return u.stop(...a); };
    }
    return track;
  }

  function stepPatrol(p) {
    for (const u of [...p.members]) if (!u.alive) leave(u);
    if (!p.members.length) return;
    const lead = p.members[0];
    // The leader's goal moves on when he is there (or has stopped, blocked:
    // a patrol never stalls on one bad waypoint).
    const g = pointAt(p.track, p.s);
    if (!busy(lead) && (Math.hypot(lead.position.x - g.x, lead.position.z - g.z) < P.reach || (!lead.isMoving && p.goals.has(lead)))) {
      const end = p.dir > 0 ? p.track.total : 0;
      if (Math.abs(p.s - end) < 1) {
        // The end of the track: turn round; the last man leads back.
        p.dir = -p.dir;
        p.members.reverse();
      }
      p.s = Math.max(0, Math.min(p.track.total, p.s + p.dir * P.ahead));
    }
    p.members.forEach((u, k) => {
      if (busy(u)) return;
      const goal = pointAt(p.track, p.s - p.dir * k * p.spacing);
      const last = p.goals.get(u);
      const far = Math.hypot(u.position.x - goal.x, u.position.z - goal.z) > P.reach;
      // Re-path when the goal moved, or when he is idle away from it (a fight
      // pulled him off the track and is over).
      if (!last || Math.hypot(last.x - goal.x, last.z - goal.z) > P.reorderMove || (!u.isMoving && far)) {
        u.orderTo(goal.x, goal.z);
        p.goals.set(u, goal);
      }
    });
    // CONVOI: a truck through a French-held village delivers.
    for (const u of p.members) {
      if (u.typeKey !== "gmc") continue;
      for (const v of economy?.points ?? []) {
        if (v.owner !== "player") continue;
        if (Math.hypot(u.position.x - v.position.x, u.position.z - v.position.z) > P.convoyR) continue;
        const key = `${u.id ?? units.list.indexOf(u)}|${v.name}`;
        if (simT - (p.paid.get(key) ?? -1e9) < P.convoyEvery) continue;
        p.paid.set(key, simT);
        economy.french.earn(P.convoyPay);
        onDelivery(P.convoyPay, v, u);
      }
    }
  }

  return {
    params: P,
    get list() { return patrols; },
    start,
    leave,
    /** Is this unit on patrol? (the command card's button state) */
    has: (u) => byUnit.has(u),
    /** On the fixed sim clock. */
    step(dt) {
      simT += dt;
      for (const p of [...patrols]) {
        p.t += dt;
        if (p.t < P.tick) continue;
        p.t = 0;
        stepPatrol(p);
      }
    },
  };
}
