// THE SPEED A PLAYER CAN CARRY (user, 2026-10-29: "I placed a jump and a landing following the arc, and at the speed
// I go after a turn there is no way I reach that landing … is there not a better way to predict it?"). The builder's
// red arc is the test car's — full throttle, the autopilot's line, never a lift: the best case. This is the
// realistic one, the racing games' SPEED PROFILE: no simulation, the road's shape alone —
//   1. at every point, the fastest the tyres hold through its curve (the road's own banking and the car's downforce
//      counted), at HUMAN.grip of the car's grip;
//   2. FORWARD from the start: the engine's pull (its curve, the air drag, the slopes), never over those limits;
//   3. BACKWARD: before each limit, the braking it needs, at HUMAN.brake of the car's brakes — none in the air.
// What is left at a lip is the take-off a good player makes.
import { ARCADE } from "./arcadeCar.js";
import { TIRE, AERO, CHASSIS } from "../../../../v3/play/modularRoadVehicle.js";
import { BOOST } from "./carRules.js";
import { LANDING } from "./landing.js";

const G = 9.81;
const LAND_REACH = 1.0; // m: the flight this close over a landing has its wheels on it
/** A good player, not a robot: the share of the grip and of the brakes they use */
export const HUMAN = { grip: 0.8, brake: 0.7, throttle: 0.93 };

/** The car's numbers the profile needs: the arcade car's own, else the old car's (approximate) */
export function profileCar(physics) {
  if (physics === "arcade") {
    const D = ARCADE.drive, Gp = ARCADE.grip, S = ARCADE.stick;
    return { accel: D.accel, top: D.top, brake: D.brake, gripG: Gp.g, aero: Gp.aero, stick: (v) => (v > S.minSpeed ? Math.min(S.max, S.k * v * v) : 0) };
  }
  return { accel: 9, top: TIRE.topSpeed || 63, brake: 16, gripG: 1.6, aero: 0, stick: () => 0 };
}

/**
 * @param ride  [{ P, T, U, air, uid }] the line the car follows (the builder's prediction ride)
 * @param car   profileCar(...)
 * @param v0    m/s at the first point (a test car's spawn speed, else 0)
 * @param isGap (i) → true when the step from point i to i + 1 is a FLIGHT (a lip to its landing: the ride jumps
 *              across it) — no engine, no brakes there
 * @param boostAt (i) → true when point i is on a boost piece (its push, BOOST.time s, as the game's rules)
 * @returns Float32Array: the speed (m/s) at each ride point
 * THE BOOSTS COUNT (measured on Sky Switchback: 183 → 245 km/h in 55 m after a landing — the perfect-landing boost,
 * 14 m/s² for 1 s): a good player lands clean, so every touchdown gets it, and the boost pieces theirs.
 */
export function speedProfile(rideIn, car, v0 = 0, isGapIn = () => false, boostAtIn = () => false) {
  // EVERY ≤ 2 m (a straight piece's ride is its two ends, 64 m apart: a touchdown snapped to the far end and lost
  // the run after it); a flight's step is left as it is. The answer is read back at the given points.
  const ride = [], src = [], gap = [], bst = [];
  for (let i = 0; i < rideIn.length; i++) {
    const a = rideIn[i], b = rideIn[i + 1];
    src.push(ride.length);
    ride.push(a); gap.push(!!b && isGapIn(i)); bst.push(boostAtIn(i));
    if (!b || isGapIn(i)) continue;
    const k = Math.floor(a.P.distanceTo(b.P) / 2);
    for (let m = 1; m < k; m++) {
      const f = m / k;
      ride.push({ P: a.P.clone().lerp(b.P, f), T: a.T.clone().lerp(b.T, f).normalize(), U: a.U.clone().lerp(b.U, f).normalize(), air: a.air && b.air, uid: a.uid });
      gap.push(false); bst.push(boostAtIn(i));
    }
  }
  const isGap = (i) => gap[i];
  const n = ride.length, vmax = new Float32Array(n), v = new Float32Array(n);
  const drag = AERO.drag / CHASSIS.mass;
  // 1. the corner limits
  for (let i = 0; i < n; i++) {
    vmax[i] = 200;
    const r = ride[i], a = ride[i - 1], b = ride[i + 1];
    if (r.air || !a || !b || a.air || b.air || isGap(i - 1) || isGap(i)) continue;
    if (r.U && r.U.y < 0.75) continue; // (loops, walls: held by the stunt surface, not the tyres)
    const ds = a.P.distanceTo(b.P);
    if (ds < 1e-3) continue;
    // the curve IN the road's plane: dT/ds along the road's sideways axis (R = U × T)
    const Rx = r.U.y * r.T.z - r.U.z * r.T.y, Ry = r.U.z * r.T.x - r.U.x * r.T.z, Rz = r.U.x * r.T.y - r.U.y * r.T.x;
    const kap = ((b.T.x - a.T.x) * Rx + (b.T.y - a.T.y) * Ry + (b.T.z - a.T.z) * Rz) / ds;
    if (Math.abs(kap) < 1e-4) continue;
    // what the tyres must give: the turn's v²κ, less the banking's share of gravity (−g along R)
    const need = (s) => Math.abs(s * s * kap + G * Ry);
    const can = (s) => HUMAN.grip * car.gripG * (G + car.aero * car.stick(s));
    let lo = 0, hi = 200;
    if (need(hi) <= can(hi)) continue;
    for (let k = 0; k < 28; k++) { const m = (lo + hi) / 2; if (need(m) <= can(m)) lo = m; else hi = m; }
    vmax[i] = lo;
  }
  // 2. forward: the engine (none in the air), the drag, the slopes (as heights: exact over any step)
  v[0] = Math.min(v0, vmax[0]);
  let boostLeft = 0; // s of boost push left (a touchdown, a boost piece)
  for (let i = 0; i < n - 1; i++) {
    const p = ride[i], q = ride[i + 1], ds = p.P.distanceTo(q.P), s = v[i];
    // A JUMP: the flight from the lip (along its tangent) to the landing; what goes INTO the landing is lost
    // (the springs take it), only the speed ALONG the landing stays — a drop is not speed gained
    // (the FLIGHT is flown: where its arc comes down onto the landing's points is where the car lands — it flies
    // over the top of a long landing and lands low on it; the points flown over carry that landing's speed)
    if (isGap(i)) {
      const hx = p.T.x, hz = p.T.z, hl = Math.hypot(hx, hz) || 1, vh = s * hl, vy0 = s * p.T.y;
      let j = i + 1, t = 0;
      // (on past the landing piece if the flight is still above the road — it overshoots onto what follows)
      for (; j < n; j++) {
        if (j > i + 1 && isGap(j - 1)) break; // (another jump: not this flight's road)
        const d = ((ride[j].P.x - p.P.x) * hx + (ride[j].P.z - p.P.z) * hz) / hl; // (along the flight, flat)
        t = Math.max(0, d / Math.max(1, vh));
        // (down onto the landing here: within the wheels' reach of it — a landing fitted to the arc runs just under
        // the flight all the way, and "below it" alone landed the car at its foot, 40 km/h short)
        if (p.P.y + vy0 * t - 0.5 * G * t * t <= ride[j].P.y + LAND_REACH) break;
      }
      j = Math.min(j, n - 1);
      const k = Math.exp(-drag * s * t); // (the air drag over the flight)
      const q2 = ride[j], vy = vy0 - G * t;
      const along = Math.max(0, ((hx / hl) * vh * q2.T.x + vy * q2.T.y + (hz / hl) * vh * q2.T.z) * k);
      for (let m = i + 1; m <= j; m++) v[m] = Math.min(vmax[m], along);
      boostLeft = Math.max(boostLeft, LANDING.boostTime);
      if (j - 1 > i) i = j - 1; // (the loop carries on from the touchdown — always forward: a touchdown on the very next point left i where it was, and the loop never ended)
      continue;
    }
    if (bst[i]) boostLeft = BOOST.time;
    const dt = ds / Math.max(1, s);
    const push = !p.air && boostLeft > 0 ? BOOST.accel * Math.min(1, boostLeft / Math.max(dt, 1e-3)) : 0;
    boostLeft = Math.max(0, boostLeft - dt);
    const eng = (p.air ? 0 : HUMAN.throttle * car.accel * Math.max(0, 1 - (s / car.top) ** 2)) + push;
    const v2 = s * s + 2 * (eng - drag * s * s) * ds - 2 * G * (q.P.y - p.P.y);
    v[i + 1] = Math.min(vmax[i + 1], Math.sqrt(Math.max(0, v2)));
  }
  // 3. backward: the braking each limit needs (none in the air: a flight carries what it took off with)
  for (let i = n - 2; i >= 0; i--) {
    const p = ride[i], q = ride[i + 1];
    if (p.air || isGap(i)) continue;
    const ds = p.P.distanceTo(q.P);
    const v2 = v[i + 1] * v[i + 1] + 2 * HUMAN.brake * car.brake * ds + 2 * G * (q.P.y - p.P.y);
    v[i] = Math.min(v[i], Math.sqrt(Math.max(0, v2)));
  }
  return Float32Array.from(src, (k) => v[k]);
}

/** The profile's speed where the car leaves each lip: uid → m/s (the piece's last point on the road) */
export function lipSpeeds(ride, v) {
  const out = new Map();
  for (let i = 0; i < ride.length; i++) if (!ride[i].air && (i === ride.length - 1 || ride[i + 1].uid !== ride[i].uid)) out.set(ride[i].uid, v[i]);
  return out;
}
