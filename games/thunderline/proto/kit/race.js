// THE RACE LAYER (DESIGN.md §8): gates, timer, checkpoints in ANY order, finish only with all of
// them, checkpoint respawn that keeps your speed, medals from the author time. Pure logic (no
// rendering), so the Node tests run the exact rules the drive page runs.
import * as THREE from "three";

/** Medal times from the author time (DESIGN.md §8): ×1.06 / 1.2 / 1.5, rounded up to the next second. */
export function medalTimes(author) {
  if (!(author > 0)) return null;
  return { author, gold: Math.ceil(author * 1.06), silver: Math.ceil(author * 1.2), bronze: Math.ceil(author * 1.5) };
}
export function medalFor(time, medals) {
  if (!medals) return null;
  if (time <= medals.author) return "author";
  if (time <= medals.gold) return "gold";
  if (time <= medals.silver) return "silver";
  if (time <= medals.bronze) return "bronze";
  return null;
}

/**
 * The gates of a laid-out track. A checkpoint is a FLAG on a piece (any piece); its gate stands at the
 * middle of that piece's ride. The finish is the end of the road. Each gate is a plane across the road:
 * P (centre), T (the way through), U (up), hw (half width).
 * @param ride  [{P, T, U, piece}] in driving order
 * @param flagged  piece indices that carry a checkpoint flag
 */
export function gatesFor(ride, flagged, hwOf = () => 8, rings = []) {
  const gates = [];
  // AIR RINGS: checkpoints in the air (a piece placed on a flight arc), gone through within radius r
  for (const r of rings) gates.push({ kind: "cp", ring: true, piece: -1, P: r.P.clone(), T: r.T.clone().normalize(), U: r.U.clone(), hw: r.r });
  for (const k of flagged) {
    const mine = ride.filter((r) => r.piece === k && !r.air);
    if (!mine.length) continue;
    const r = mine[Math.floor(mine.length / 2)];
    gates.push({ kind: "cp", piece: k, P: r.P.clone(), T: r.T.clone().normalize(), U: (r.U ?? new THREE.Vector3(0, 1, 0)).clone(), hw: hwOf(k) });
  }
  const last = ride.filter((r) => !r.air).at(-1);
  // the finish sits 2 m before the very end, so the car crosses it while still on the road
  const T = last.T.clone().normalize();
  gates.push({ kind: "finish", piece: last.piece, P: last.P.clone().addScaledVector(T, -2), T, U: (last.U ?? new THREE.Vector3(0, 1, 0)).clone(), hw: hwOf(last.piece) });
  return gates;
}

/**
 * One run. tick(car, dt) after every physics tick; it returns the events of that tick
 * ({type: "cp"|"finish"|"missing", ...}). Countdown: the car is held for `countdown` s, then the clock runs.
 */
export function createRace({ gates, countdown = 1.5 }) {
  const cps = gates.filter((g) => g.kind === "cp");
  const finish = gates.find((g) => g.kind === "finish");
  const prevPos = new THREE.Vector3();
  const d0 = new THREE.Vector3(), d1 = new THREE.Vector3();
  const s = {
    state: "countdown", // countdown → running → finished
    hold: countdown, // s left in the countdown
    time: 0,
    taken: new Set(), // gate indices (into cps) taken this run
    splits: [], // [{gate, time}] in the order taken
    last: null, // the last checkpoint: {pos, quat, vel, time}
    finishTime: null,
    respawns: 0,
  };
  let havePrev = false;
  /** Did the car's centre go through gate g between the last tick and this one? */
  function crossed(g, p) {
    d0.copy(prevPos).sub(g.P);
    d1.copy(p).sub(g.P);
    const a = d0.dot(g.T), b = d1.dot(g.T);
    if (!(a < 0 && b >= 0)) return false; // through it, the right way
    const t = a / (a - b);
    d0.lerp(d1, t); // the crossing point, relative to the gate
    const side = d0.clone().sub(g.T.clone().multiplyScalar(d0.dot(g.T)));
    if (g.ring) return side.length() < g.hw; // a ring: through its hoop
    const up = side.dot(g.U);
    const across = side.addScaledVector(g.U, -up).length();
    return across < g.hw + 2 && up > -3 && up < 9;
  }
  return {
    s,
    cps,
    finish,
    get missing() { return cps.length - s.taken.size; },
    reset() {
      s.state = "countdown"; s.hold = countdown; s.time = 0; s.taken = new Set(); s.splits = [];
      s.last = null; s.finishTime = null; s.respawns = 0; havePrev = false;
    },
    /** The car is held still during the countdown (the page feeds this to the car's input). */
    get holding() { return s.state === "countdown"; },
    tick(car, dt) {
      const ev = [];
      const p = car.body.pos;
      if (s.state === "countdown") {
        s.hold -= dt;
        if (s.hold <= 0) { s.state = "running"; ev.push({ type: "go" }); }
        prevPos.copy(p); havePrev = true;
        return ev;
      }
      if (s.state !== "running") return ev;
      s.time += dt;
      if (havePrev) {
        cps.forEach((g, i) => {
          if (s.taken.has(i) || !crossed(g, p)) return;
          s.taken.add(i);
          s.splits.push({ gate: i, time: s.time });
          s.last = { pos: p.clone(), quat: car.body.quat.clone(), vel: car.body.vel.clone(), time: s.time };
          ev.push({ type: "cp", gate: i, time: s.time, n: s.taken.size, of: cps.length });
        });
        if (finish && crossed(finish, p)) {
          if (s.taken.size === cps.length) {
            s.state = "finished";
            s.finishTime = s.time;
            ev.push({ type: "finish", time: s.time });
          } else ev.push({ type: "missing", n: cps.length - s.taken.size });
        }
      }
      prevPos.copy(p); havePrev = true;
      return ev;
    },
    /** After a respawn: the car jumped, so don't read the jump as a crossing. */
    teleported(p) { prevPos.copy(p); havePrev = true; s.respawns++; },
  };
}
