// THE SQUAD ON THE MARCH — Company of Heroes' moving formation (you, 2026-10-12: "let's continue nicer
// squad movement from the CoH article"; Jurney, "Company of Heroes Squad Formations Explained", AI Game
// Programming Wisdom 4). Before, each man ran his own path to his own end spot: a squad travelled as a
// loose blob, strung out, the fast ones first.
//
//   LEADER     the squad's leader (slot 0) walks his own path to his spot, a touch slower (LEADER_PACE)
//              so the others can keep up.
//   FOLLOWERS  each aims at a point ~LOOK_S seconds AHEAD of the leader along his route, plus his offset
//              in the formation turned to the route's heading — re-aimed every RETARGET_S, and only when it
//              moved RETARGET_M (CoH: a repath every half second, not every tick). The spot goes through
//              navGrid.nearestReachable from that point: never inside a house, the squad squeezes in a lane.
//   CONTEXT    the shape from the ground under the leader: a staggered COLUMN on a track, a TIGHT wedge
//              where walls crowd round (villages, gullies), a WIDE wedge in the open.
//   SPEED      a man ahead of his spot (along the march) slows, one behind speeds up (formMul, units.js):
//              the shape holds instead of stringing out.
//   DRIFT      each man's spot wanders a little (DRIFT_M): not a robotic parade.
//   ARRIVAL    with the leader ARRIVE_M from his spot, each man is sent to his OWN end spot — the move's
//              destination formation (selection.js formationAt, the cover snap) — as before.
//
// A march starts on its own when a squad's men all get new move orders at once and the leader has more
// than START_M to go (a short step needs no column). ANY other order to one of them (attack, retreat, a
// house, a new move) ends it: the controller only steers men whose goal is still the one it gave.
import { nearestTrack } from "./algTracks.js";

const P = {
  START_M: 22,        // the leader this far from his spot: a march (a shorter move: as before)
  ARRIVE_M: 13,       // the leader this near: everyone to his own end spot
  LOOK_S: 2.0,        // seconds ahead of the leader the followers aim (CoH: ~2 s)
  RETARGET_S: 0.5,    // a follower's spot re-aimed at most this often…
  RETARGET_M: 2.0,    // …and only when it moved this far (a fresh path each time otherwise)
  LEADER_PACE: 0.9,   // the leader a touch slower, so the men behind can close up
  SPEED_K: 0.09,      // speed change per metre ahead (−) / behind (+) of his spot
  SPEED_MIN: 0.7, SPEED_MAX: 1.3,
  CATCHUP_M: 6,       // farther than this from his spot: full catch-up speed
  RELEASE_M: 50,      // farther than this from the leader (or standing still off his spot): to his own end spot
  DRIFT_M: 0.8,       // how far a man's spot wanders
  CONTEXT_S: 0.6,     // how often the ground under the leader is read
  ROAD_M: 5,          // a track this near the leader: the column
  TIGHT_FRAC: 0.25,   // this share of the ground round the leader blocked: the tight wedge
};

/** A follower's offset in the formation (right, forward; metres, the leader at 0,0), k = 1… */
const SHAPES = {
  wedge: (k) => { const r = Math.ceil(k / 2), s = k % 2 ? 1 : -1; return [s * r * 2.4, -r * 2.0]; },
  tight: (k) => { const r = Math.ceil(k / 2), s = k % 2 ? 1 : -1; return [s * r * 1.3, -r * 2.2]; },
  column: (k) => [k % 2 ? 0.7 : -0.7, -k * 2.1],
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.squads   algSquads (list)
 */
export function createAlgSquadMarch({ app, squads }) {
  const nav = app.navGrid;
  const marches = new Map();   // squad → march
  const seen = new Map();      // man → his goal last frame ("x,z") — a new order shows as a change
  const drift = new WeakMap(); // man → { x, z } his wandering offset
  let rnd = 9781;
  const rand = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647 - 0.5; };
  const keyOf = (g) => (g ? `${g.x.toFixed(2)},${g.z.toFixed(2)}` : "");

  /** The point `ahead` m along `from` → the route's waypoints, and the heading there. */
  function along(from, route, ahead) {
    let x = from.x, z = from.z, fx = 0, fz = 1, left = ahead;
    for (const w of route ?? []) {
      const dx = w.x - x, dz = w.z - z, d = Math.hypot(dx, dz);
      if (d < 1e-3) continue;
      fx = dx / d; fz = dz / d;
      if (d >= left) return { x: x + fx * left, z: z + fz * left, fx, fz };
      x = w.x; z = w.z; left -= d;
    }
    return { x, z, fx, fz };
  }

  function contextOf(m, at) {
    const tr = nearestTrack(at.x, at.z);
    if (tr && tr.d < P.ROAD_M) return "column";
    let b = 0;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      if (nav?.isBlockedAtWorld(at.x + Math.cos(a) * 5, at.z + Math.sin(a) * 5, true)) b++;
    }
    return b / 16 >= P.TIGHT_FRAC ? "tight" : "wedge";
  }

  function end(s, sendHome) {
    const m = marches.get(s);
    if (!m) return;
    marches.delete(s);
    for (const u of m.men) {
      u.formMul = 1;
      // To his own end spot (the move's destination formation) — only if his goal is still ours.
      // (halted by combat on an AI's move: he keeps fighting; on the player's, move means move)
      if (sendHome && u.alive && (u.goalPoint ? m.issued.get(u) === keyOf(u.goalPoint) : m.playerMove) && m.dest.has(u)) {
        const d = m.dest.get(u);
        u.orderTo(d.x, d.z);
        if (m.playerMove) u.playerMove = true;
        seen.set(u, keyOf(u.goalPoint));
      }
    }
  }

  function start(s) {
    const men = s.members.filter((u) => u.alive && !u.inside);
    const leader = men[0];
    if (!leader || men.length < 2) return;
    const lg = leader.goalPoint;
    if (!lg || Math.hypot(lg.x - leader.position.x, lg.z - leader.position.z) < P.START_M) return;
    // (playerMove: the player's MOVE MEANS MOVE (combat.js) carried by the march — combat clears it the moment a
    // man stops, and a follower pauses at each of his short goals: then an enemy in range halted him, wiped his
    // order, and the march read that as a new order and left him behind, 380 m away — 2026-10-12.)
    const m = { leader, men, dest: new Map(), issued: new Map(), at: new Map(), t: new Map(), ctx: "wedge", ctxT: 0, playerMove: !!leader.playerMove, released: new Set() };
    for (const u of men) { const g = u.goalPoint; if (g) m.dest.set(u, { x: g.x, z: g.z }); m.issued.set(u, keyOf(g)); m.t.set(u, 9); }
    leader.formMul = P.LEADER_PACE;
    marches.set(s, m);
  }

  function step(dt) {
    for (const s of squads.list) {
      const men = s.members;
      // A march: still ours? (any other order to one of its men ends it)
      const m = marches.get(s);
      if (m) {
        const L = m.leader;
        // His goal still ours — or WIPED (combat halted him to fight: not a new order; he is left to fight).
        const mine = (u) => !u.goalPoint || m.issued.get(u) === keyOf(u.goalPoint);
        if (!L.alive || L.inside || s.retreating || !mine(L) || men.some((u) => m.men.includes(u) && !mine(u))) { end(s, false); }
        else {
          const ld = m.dest.get(L);
          if (!L.isMoving || Math.hypot(ld.x - L.position.x, ld.z - L.position.z) < P.ARRIVE_M) end(s, true);
          else steer(m, dt);
        }
      }
      // A NEW move to the whole squad (every man's goal changed this frame): a march, if it is long.
      if (!marches.has(s) && !s.retreating && men.length > 1) {
        const changed = men.filter((u) => u.goalPoint && u.isMoving && keyOf(u.goalPoint) !== seen.get(u)).length;
        if (changed === men.length) start(s);
      }
      for (const u of men) seen.set(u, keyOf(u.goalPoint));
    }
  }

  function steer(m, dt) {
    const L = m.leader;
    // A new shape only after TWO readings in a row (it flickered wedge / tight / wedge at a village edge).
    if ((m.ctxT -= dt) <= 0) {
      m.ctxT = P.CONTEXT_S;
      const c = contextOf(m, L.position);
      if (c === m.ctx) m.pending = null;
      else if (c === m.pending) { m.ctx = c; m.pending = null; }
      else m.pending = c;
    }
    const shape = SHAPES[m.ctx];
    const pace = (L.type?.speed ?? 5) * P.LEADER_PACE;
    const ahead = along(L.position, L.route, pace * P.LOOK_S);
    const now = along(L.position, L.route, 0.5);   // the leader's heading now
    m.men.forEach((u, k) => {
      if (k === 0 || !u.alive || u.inside || m.released.has(u)) return;
      if (!u.goalPoint && u.target) return;          // halted by combat to FIGHT: not steered
      if (m.playerMove) u.playerMove = true;          // move means move, all the way
      // RELEASED to his own end spot (2026-10-12: two followers ended 89 / 137 m behind, never catching up):
      // fallen too far behind, or standing still away from his march spot — he walks his own path there,
      // as before the march existed. Never left behind.
      const far = Math.hypot(u.position.x - L.position.x, u.position.z - L.position.z) > P.RELEASE_M;
      const idle = !u.isMoving && (m.at.get(u) ? Math.hypot(u.position.x - m.at.get(u).x, u.position.z - m.at.get(u).z) > 4 : false);
      if ((far || idle) && m.dest.has(u)) {
        const d = m.dest.get(u);
        u.formMul = 1;
        u.orderTo(d.x, d.z);
        if (m.playerMove) u.playerMove = true;
        m.issued.set(u, keyOf(u.goalPoint));
        m.released.add(u);
        return;
      }
      // His drifting offset.
      let dr = drift.get(u);
      if (!dr) drift.set(u, (dr = { x: 0, z: 0 }));
      dr.x += rand() * 0.9 * dt; dr.z += rand() * 0.9 * dt;
      const dl = Math.hypot(dr.x, dr.z);
      if (dl > P.DRIFT_M) { dr.x *= P.DRIFT_M / dl; dr.z *= P.DRIFT_M / dl; }
      const [ox, oz] = shape(k);
      const place = (c) => ({ x: c.x + (ox + dr.x) * c.fz + (oz + dr.z) * c.fx, z: c.z - (ox + dr.x) * c.fx + (oz + dr.z) * c.fz });
      // SPEED: ahead of his spot (along the march) slower, behind faster.
      const slot = place({ ...now, x: L.position.x, z: L.position.z });
      const e = (u.position.x - slot.x) * now.fx + (u.position.z - slot.z) * now.fz;
      // Far from his spot (> CATCHUP_M): flat out, whichever way the route bends — the along-the-march
      // reading took a man far BEHIND round a bend for one ahead, and slowed him.
      u.formMul = Math.hypot(u.position.x - slot.x, u.position.z - slot.z) > P.CATCHUP_M ? P.SPEED_MAX
        : Math.min(P.SPEED_MAX, Math.max(P.SPEED_MIN, 1 - e * P.SPEED_K));
      // THE GOAL: his spot off the leader's point ahead, reachable from it.
      const t = (m.t.get(u) ?? 0) + dt;
      m.t.set(u, t);
      if (t < P.RETARGET_S) return;
      const want = place(ahead);
      const goal = nav?.nearestReachable?.(ahead.x, ahead.z, want.x, want.z, { foot: true }) ?? want;
      const last = m.at.get(u);
      if (last && Math.hypot(last.x - goal.x, last.z - goal.z) < P.RETARGET_M && u.isMoving) return;
      m.t.set(u, 0);
      m.at.set(u, goal);
      u.orderTo(goal.x, goal.z);
      if (m.playerMove) u.playerMove = true;
      m.issued.set(u, keyOf(u.goalPoint));
    });
  }

  return {
    params: P, marches, step,
    /** A squad's march now: its shape ("column" / "tight" / "wedge") — the dev console. */
    shapeOf: (s) => marches.get(s)?.ctx ?? null,
  };
}
