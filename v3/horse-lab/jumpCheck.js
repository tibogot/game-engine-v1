// ── Horse lab: jump reliability check ────────────────────────────────────────
// Rides the horse at the arena's fences at a FIXED time step (the page loop is
// blocked while it runs) from many distances, angles, offsets and gears, and
// sorts every run:
//
//   jumped    went over with the jump clip playing
//   refused   stopped at the fence (blocked) — the failure the player sees
//   through   ended up past the fence WITHOUT jumping (walked through it)
//   noReach   never got to the fence (too slow / steered away)
//
// Usage (console): (await import('/v3/horse-lab/jumpCheck.js')).jumpCheck(__HORSE)
const DT = 1 / 60;

// A fence line as a segment (x0,z0)→(x1,z1): approach square to it from `side`.
export const FENCES = {
  long: { a: [-24, -30], b: [24, -30] },          // the long run
  corralE: { a: [-36, -58], b: [-36, -36] },      // corral, east side (has a door gap)
  corralW: { a: [-58, -36], b: [-58, -58] },
  corralN: { a: [-36, -36], b: [-58, -36] },
};

function reset(ctrl, x, z, yaw, v, gait) {
  ctrl.pos.set(x, 0, z); ctrl.yaw = yaw; ctrl.v = v; ctrl.turnRate = 0; ctrl.y = 0;
  ctrl.pitch = 0; ctrl.roll = 0; ctrl.oneShot = null; ctrl.rearT = -1; ctrl.landT = -1;
  ctrl.idleT = -1e9; ctrl.lift = 0; ctrl.ikW = 1; ctrl.bodyOff = 0; ctrl.gear = gait === "Canter" ? 2 : 0;
  ctrl.jumpQueued = false; ctrl.airborne = false; ctrl.autoT = 0; ctrl.prevGallopT = undefined;
  ctrl.mixer.stopAllAction(); ctrl.cur = null; ctrl.gaitName = "";
  ctrl.switchTo(v > 0 ? gait : "Idle", 0, true);
}

// One approach: start `dist` m from the fence's line, at `ang` rad off square,
// `off` m along the fence from its middle. Returns the outcome and details.
export function ride(H, fence, { dist = 14, ang = 0, off = 0, side = 1, gait = "Gallop", flying = true, secs = 7, input } = {}) {
  const { ctrl } = H;
  const [ax, az] = fence.a, [bx, bz] = fence.b;
  const L = Math.hypot(bx - ax, bz - az), tx = (bx - ax) / L, tz = (bz - az) / L;
  const nx = -tz * side, nz = tx * side;                    // normal pointing to where we start
  const mx = (ax + bx) / 2 + tx * off, mz = (az + bz) / 2 + tz * off;
  // heading: toward the fence (−normal), turned by ang
  const hx = -nx, hz = -nz, c = Math.cos(ang), s = Math.sin(ang);
  const dx = hx * c + hz * s, dz = -hx * s + hz * c;
  const sx = mx - dx * dist / Math.max(0.3, (dx * -nx + dz * -nz)), sz = mz - dz * dist / Math.max(0.3, (dx * -nx + dz * -nz));
  const yaw = Math.atan2(dx, dz);
  const S = ctrl.gearSpeeds();
  reset(ctrl, sx, sz, yaw, flying ? (gait === "Canter" ? S[2] : S[3]) : 0, gait);
  const n = Math.round(secs / DT);
  let jumped = false, blockedT = -1, minV = Infinity, crossedAt = -1;
  const sd = () => (ctrl.pos.x - mx) * nx + (ctrl.pos.z - mz) * nz;   // signed distance to the fence line (+ = start side)
  for (let i = 0; i < n; i++) {
    const inp = input ? input(i * DT, ctrl) : { fwd: 1, run: gait === "Gallop", turn: 0 };
    ctrl.update(DT, { fwd: inp.fwd ?? 1, turn: inp.turn ?? 0, run: !!inp.run, gearUp: false, gearDown: false });
    ctrl.idleT = -1e9;
    if (ctrl.oneShot && ctrl.oneShotName === "Gallop_Jump") jumped = true;
    if (ctrl.blocked && blockedT < 0) blockedT = i * DT;
    if (crossedAt < 0 && sd() < -0.5) crossedAt = i * DT;
    if (crossedAt >= 0 && i * DT > crossedAt + 1.2) break;
  }
  const crossed = crossedAt >= 0;
  const result = crossed ? (jumped ? "jumped" : "through") : blockedT >= 0 ? "refused" : "noReach";
  return { result, jumped, blockedT: +blockedT.toFixed(2), left: +sd().toFixed(2) };
}

// The sweep: every fence × distances × angles × offsets × gaits.
export function jumpCheck(H, { fences = Object.keys(FENCES), dists = [9, 11, 12.5, 14, 16, 18.5, 21], angs = [0, 0.2, -0.2, 0.4, -0.4], offs = [0, 1.3], gaits = ["Gallop", "Canter"] } = {}) {
  const counts = {}, fails = [];
  for (const fk of fences) for (const gait of gaits) for (const dist of dists) for (const ang of angs) for (const off of offs) {
    const f = FENCES[fk];
    // corral sides: ride from outside in (side so we start outside); the long run: from the north
    for (const side of [1, -1]) {
      const r = ride(H, f, { dist, ang, off, side, gait });
      counts[r.result] = (counts[r.result] ?? 0) + 1;
      if (r.result !== "jumped") fails.push({ fence: fk, gait, dist, ang, off, side, ...r });
    }
  }
  return { counts, fails };
}

// ── The parkour, ridden by an autopilot ──────────────────────────────────────
// Follows the course line (lane 1 east, the east loop, lane 2 west, the west
// loop back) at a gallop / canter and reports what happened at each fence.
export function courseLine() {
  const pts = [];
  for (let x = -100; x <= 95; x += 2) pts.push([x, 0]);
  for (let a = -90; a <= 90; a += 4) { const r = a * Math.PI / 180; pts.push([95 + 35 * Math.cos(r), 35 + 35 * Math.sin(r)]); }
  for (let x = 95; x >= -95; x -= 2) pts.push([x, 70]);
  for (let a = 90; a <= 270; a += 4) { const r = a * Math.PI / 180; pts.push([-95 + 35 * Math.cos(r), 35 + 35 * Math.sin(r)]); }
  return pts;
}
export function testLine() { const p = []; for (let x = -90; x <= 90; x += 2) p.push([x, -30]); return p; }

export function rideCourse(H, { line = courseLine(), gait = "Gallop", secs = 240, look = 7, start, shift = 0 } = {}) {
  if (shift) line = line.map((p, i) => { const q = line[Math.min(line.length - 1, i + 1)], r = line[Math.max(0, i - 1)], dx = q[0] - r[0], dz = q[1] - r[1], L = Math.hypot(dx, dz) || 1; return [p[0] - dz / L * shift, p[1] + dx / L * shift]; });   // ride off-centre
  const { ctrl, arena } = H;
  const p0 = start ?? line[0], p1 = line[1];
  const S = ctrl.gearSpeeds();
  reset(ctrl, p0[0], p0[1], Math.atan2(p1[0] - p0[0], p1[1] - p0[1]), gait === "Canter" ? S[2] : S[3], gait);
  const fences = arena.fences.map((f) => ({ n: f.n, x: f.x, z: f.z, h: f.h, dir: f.dir, half: f.type === "oxer" ? 0.66 : f.type === "logs" ? 0.42 : f.type === "wall" ? 0.3 : f.type === "bank" ? 0 : 0.08, base: f.base ?? 0, jumped: false, blocked: 0, passed: false, near: Infinity, clear: Infinity }));
  const hooves = ctrl.legs.map((g) => g.ff), hp = new ctrl.pos.constructor();
  let k = 0, wasJ = false, jumpAt = null, stuck = 0, hardStops = 0, vPrevC = null;
  const n = Math.round(secs / DT);
  for (let i = 0; i < n; i++) {
    // target: the first line point at least `look` m ahead of the nearest one
    let best = k, bd = Infinity;
    for (let j = k; j < Math.min(line.length, k + 30); j++) { const d = Math.hypot(line[j][0] - ctrl.pos.x, line[j][1] - ctrl.pos.z); if (d < bd) { bd = d; best = j; } }
    k = best;
    let t = k; while (t < line.length - 1 && Math.hypot(line[t][0] - ctrl.pos.x, line[t][1] - ctrl.pos.z) < look) t++;
    if (k >= line.length - 2) break;
    const want = Math.atan2(line[t][0] - ctrl.pos.x, line[t][1] - ctrl.pos.z);
    const err = Math.atan2(Math.sin(want - ctrl.yaw), Math.cos(want - ctrl.yaw));
    ctrl.update(DT, { fwd: 1, run: gait === "Gallop", turn: Math.max(-1, Math.min(1, err * 2.5)), gearUp: false, gearDown: false });
    ctrl.idleT = -1e9;
    const j = ctrl.oneShot && ctrl.oneShotName === "Gallop_Jump";
    if (j && !wasJ) jumpAt = ctrl.pos.clone();
    wasJ = j;
    for (const f of fences) {
      const d = Math.hypot(f.x - ctrl.pos.x, f.z - ctrl.pos.z);
      f.near = Math.min(f.near, d);
      if (d < 1.0) { f.passed = true; if (j) f.jumped = true; }
      if ((ctrl.blocked || (ctrl.refusing && Math.abs(ctrl.v) < 0.1)) && d < 5) f.blocked++;
      // the lowest hoof over the obstacle's footprint, above its top (< 0: through the rails)
      if (d < 4 && f.half > 0) for (const b of hooves) {
        b.getWorldPosition(hp);
        const fx = Math.sin(f.dir), fz = Math.cos(f.dir), along = (hp.x - f.x) * fx + (hp.z - f.z) * fz, side = (hp.x - f.x) * fz - (hp.z - f.z) * fx;
        if (Math.abs(along) < f.half + 0.06 && Math.abs(side) < 2) f.clear = Math.min(f.clear, hp.y - ctrl.h.foot.sole - (f.base + f.h));
      }
    }
    // stopped at something: the old hard block, or a sliding-stop refusal standing its ground
    const standing = ctrl.blocked || (ctrl.refusing && Math.abs(ctrl.v) < 0.1);
    stuck = standing ? stuck + 1 : 0;
    if (vPrevC !== null && vPrevC - ctrl.v > 1.0) hardStops++;   // a one-frame stop (> 60 m/s²): a regression since the sliding refusal
    vPrevC = ctrl.v;
    if (stuck > 90) {                                         // refused for 1.5 s: note it, put the horse past the fence, carry on
      const f = fences.filter((f) => f.near < 6).sort((a, b) => Math.hypot(a.x - ctrl.pos.x, a.z - ctrl.pos.z) - Math.hypot(b.x - ctrl.pos.x, b.z - ctrl.pos.z))[0];
      if (f) f.refused = true;
      ctrl.refusing = false; ctrl.refuseV = 0; ctrl.rearT = -1;
      const kk = Math.min(line.length - 2, k + 6);
      ctrl.pos.set(line[kk][0], 0, line[kk][1]); ctrl.y = 0; ctrl.v = S[3] * 0.8; stuck = 0; k = kk;
    }
  }
  void jumpAt;
  const rows = fences.filter((f) => f.near < 3).map((f) => ({ n: f.n, h: f.h, result: f.refused ? "REFUSED" : f.jumped ? "jumped" : f.passed ? "THROUGH" : "missed", blockedFrames: f.blocked, clear: f.clear === Infinity ? null : +f.clear.toFixed(2) }));
  rows.hardStops = hardStops;
  return rows;
}
