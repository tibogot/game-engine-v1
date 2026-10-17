// Thunderline prototype P1/P2 — piece maths on the grid. Pure (no three.js) so Node can test it.
//
// The rule this prototype tests: every piece starts and ends on a grid node, LEVEL, facing one of
// 4 directions. A piece is described in its own frame (x = right, y = up, z = forward) and reports
// its exit as whole cells / steps / quarter turns, so a track is integers end to end.

export const CELL = 8; // m, horizontal grid
export const STEP = 2; // m, vertical grid
export const ROAD_HW = 8; // m, half road width (road = 2 cells)
export const DESIGN_SPEED = 60; // m/s
export const G = 9.81;

// heading h: 0 = +Z, h+1 = a right turn. right(h) = FWD[(h+1)%4].
export const FWD = [[0, 0, 1], [-1, 0, 0], [0, 0, -1], [1, 0, 0]];
export const rightOf = (h) => FWD[(h + 1) % 4];

export const q5 = (t) => t * t * t * (10 + t * (-15 + 6 * t)); // C2 ease, 0→1
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const DEG = Math.PI / 180;

// Car model used for the speed prediction (matches the old car to first order).
export const CAR = { accel: 11.4, top: 63, brake: 15, flatG: 3.0, mu: 1.5, boostAccel: 14, boostTop: 72 };

/** Bank angle a fast turn of radius R (m) needs to be held at DESIGN_SPEED. */
export function bankFor(R) {
  const a = (DESIGN_SPEED * DESIGN_SPEED) / (R * G);
  const t = (a - CAR.mu) / (1 + CAR.mu * a);
  return clamp(Math.atan(Math.max(t, 0)), 8 * DEG, 40 * DEG);
}

/** Highest speed a turn of radius R (m) and bank b (rad) can be held at. */
export function turnCap(R, bank) {
  if (!bank) return Math.sqrt(R * G * CAR.flatG);
  const t = Math.tan(bank);
  const den = 1 - CAR.mu * t;
  if (den <= 0.05) return Infinity;
  return Math.sqrt((R * G * (t + CAR.mu)) / den);
}

// Each family: defaults, ui (which controls do what), clamp, and build(p) →
//   { L, exit:{dx,dy,dz,dh}, samples: [{d, p:[x,y,z], up:[x,y,z], roll, air, cap}], warn? }
// Samples are in the piece frame. `d` is metres along the path.

function sampleRange(L, step = 2) {
  const n = Math.max(2, Math.ceil(L / step));
  return Array.from({ length: n + 1 }, (_, i) => (i / n) * L);
}

const UP = [0, 1, 0];

export const FAMILIES = {
  road: {
    label: "Road",
    key: "1",
    icon: "▬",
    defaults: { size: 4, bend: 0, rise: 0 },
    // size = length (cells) when straight, radius (cells) when bent
    limits: { size: [1, 32], rise: [-16, 16] },
    describe: (p) =>
      (p.bend ? `${p.bend > 0 ? "R" : "L"} turn r${p.size * CELL}` : `${p.size * CELL} m`) +
      (p.rise ? ` ${p.rise > 0 ? "+" : ""}${p.rise * STEP} m` : ""),
    build(p) {
      const H = p.rise * STEP;
      if (!p.bend) {
        const L = p.size * CELL;
        const samples = sampleRange(L).map((d) => ({ d, p: [0, H * q5(d / L), d], up: UP, roll: 0 }));
        return { L, exit: { dx: 0, dy: p.rise, dz: p.size, dh: 0 }, samples, grade: gradeOf(H, L) };
      }
      const R = p.size * CELL;
      const dir = p.bend;
      const L = (R * Math.PI) / 2;
      const cap = turnCap(R, 0);
      const samples = sampleRange(L).map((d) => {
        const th = d / R;
        return { d, p: [dir * R * (1 - Math.cos(th)), H * q5(d / L), R * Math.sin(th)], up: UP, roll: 0, cap };
      });
      return { L, exit: { dx: dir * p.size, dy: p.rise, dz: p.size, dh: dir > 0 ? 1 : 3 }, samples, grade: gradeOf(H, L) };
    },
  },

  bank: {
    label: "Fast turn",
    key: "2",
    icon: "◠",
    defaults: { size: 8, bend: 1 },
    limits: { size: [4, 32] },
    describe: (p) => `${p.bend > 0 ? "R" : "L"} banked r${p.size * CELL} ${Math.round(bankFor(p.size * CELL) / DEG)}°`,
    // Apex Rush rule (user-approved): the lean changes on STRAIGHTS, the turn HOLDS it, ends are level.
    build(p) {
      const R = p.size * CELL;
      const dir = p.bend;
      const A = 2 * CELL; // bank-in / bank-out straights
      const arc = (R * Math.PI) / 2;
      const L = A + arc + A;
      const bank = bankFor(R);
      const cap = turnCap(R, bank);
      const samples = [];
      for (const d of sampleRange(L)) {
        let pos, roll;
        if (d <= A) {
          pos = [0, 0, d];
          roll = bank * q5(d / A);
        } else if (d <= A + arc) {
          const th = (d - A) / R;
          pos = [dir * R * (1 - Math.cos(th)), 0, A + R * Math.sin(th)];
          roll = bank;
        } else {
          const e = d - A - arc;
          pos = [dir * (R + e), 0, A + R];
          roll = bank * (1 - q5(e / A));
        }
        samples.push({ d, p: pos, up: UP, roll: dir * roll, cap: d > A * 0.5 && d < L - A * 0.5 ? cap : undefined, lowEdge: true });
      }
      const k = p.size + 2;
      return { L, exit: { dx: dir * k, dy: 0, dz: k, dh: dir > 0 ? 1 : 3 }, samples, bank };
    },
  },

  jump: {
    label: "Jump",
    key: "3",
    icon: "⌒",
    // angle (deg) of the kicker, rise = landing height vs entry (steps), v = speed it was fitted for
    defaults: { size: 10, rise: 0, v: DESIGN_SPEED },
    limits: { size: [4, 24], rise: [-20, 8] },
    sizeStep: 2,
    describe: (p) => `${p.size}° @${Math.round(p.v * 3.6)} km/h${p.rise ? ` ${p.rise > 0 ? "+" : ""}${p.rise * STEP} m` : ""}`,
    build(p) {
      const al = p.size * DEG;
      const v = Math.max(p.v, 10);
      const Lk = 24; // kicker
      const Ll = 32; // landing
      const ylip = (Lk * Math.tan(al)) / 2;
      const H = p.rise * STEP;
      const kk = G / (2 * v * v * Math.cos(al) ** 2);
      // Find where the flight path meets a landing ramp tangent to it, ending level at height H.
      let beta = al;
      let x = NaN;
      let ok = true;
      for (let i = 0; i < 40; i++) {
        const top = H + (Ll * Math.tan(beta)) / 2;
        // ylip + x tan(al) - kk x² = top → kk x² - tan(al) x + (top - ylip) = 0, descending root
        const disc = Math.tan(al) ** 2 - 4 * kk * (top - ylip);
        if (disc < 0) { ok = false; break; }
        x = (Math.tan(al) + Math.sqrt(disc)) / (2 * kk);
        const slope = Math.tan(al) - 2 * kk * x;
        beta = clamp(Math.atan(-slope), 2 * DEG, 50 * DEG);
      }
      if (!ok || !(x > 4)) {
        // can't reach: a short flat gap so the piece still exists, flagged
        x = 8; beta = 5 * DEG; ok = false;
      }
      const span = Lk + x + Ll;
      const cells = Math.ceil(span / CELL);
      const L = cells * CELL; // run-out fills the rest
      const yAt = (d) => {
        if (d <= Lk) return (d * d * Math.tan(al)) / (2 * Lk);
        if (d <= Lk + x) { const t = d - Lk; return ylip + t * Math.tan(al) - kk * t * t; }
        if (d <= span) { const w = d - Lk - x; return H + ((Ll - w) ** 2 * Math.tan(beta)) / (2 * Ll); }
        return H;
      };
      const ds = sampleRange(L).concat([Lk, Lk + x]).sort((a, b) => a - b);
      const samples = ds.map((d) => ({ d, p: [0, yAt(d), d], up: UP, roll: 0, air: d > Lk + 0.01 && d < Lk + x - 0.01 }));
      return {
        L,
        exit: { dx: 0, dy: p.rise, dz: cells, dh: 0 },
        samples,
        warn: ok ? null : `can't clear at ${Math.round(v * 3.6)} km/h`,
        flight: { x, peak: ylip + Math.tan(al) ** 2 / (4 * kk), beta },
      };
    },
  },

  loop: {
    label: "Loop",
    key: "4",
    icon: "◯",
    defaults: { size: 24, bend: 1 }, // size = radius in m (steps of 4)
    limits: { size: [16, 40] },
    sizeStep: 4,
    describe: (p) => `loop r${p.size} ${p.bend > 0 ? "→" : "←"}`,
    build(p) {
      const r = p.size;
      const side = p.bend;
      const a = Math.ceil(r / CELL) + 1;
      const b = Math.ceil(r / CELL) + 1;
      const circ = 2 * Math.PI * r;
      const L = a * CELL + circ + b * CELL;
      const samples = [];
      const n = Math.ceil(circ / 1.5);
      for (const d of sampleRange(a * CELL)) samples.push({ d, p: [0, 0, d], up: UP, roll: 0 });
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const ph = 2 * Math.PI * t;
        samples.push({
          d: a * CELL + t * circ,
          p: [side * 2 * CELL * q5(t), r * (1 - Math.cos(ph)), a * CELL + r * Math.sin(ph)],
          up: [0, Math.cos(ph), -Math.sin(ph)],
          roll: 0,
          loopTop: Math.abs(t - 0.5) < 0.5 / n + 1e-9 ? r : undefined,
        });
      }
      for (const d of sampleRange(b * CELL).slice(1))
        samples.push({ d: a * CELL + circ + d, p: [side * 2 * CELL, 0, a * CELL + d], up: UP, roll: 0 });
      return { L, exit: { dx: side * 2, dy: 0, dz: a + b, dh: 0 }, samples };
    },
  },
};

function gradeOf(H, L) {
  return (1.875 * Math.abs(H)) / L; // max slope of the quintic
}

export const MAX_GRADE = Math.tan(22 * DEG);

export function clampParams(fam, p) {
  const F = FAMILIES[fam];
  const out = { ...F.defaults, ...p };
  for (const [k, [a, b]] of Object.entries(F.limits)) out[k] = clamp(out[k], a, b);
  return out;
}

/** Move a grid node {x,y,z,h} (integers) through a piece exit. */
export function advance(node, exit) {
  const f = FWD[node.h];
  const r = rightOf(node.h);
  return {
    x: node.x + r[0] * exit.dx + f[0] * exit.dz,
    y: node.y + exit.dy,
    z: node.z + r[2] * exit.dx + f[2] * exit.dz,
    h: (node.h + exit.dh) % 4,
  };
}

/** Local piece point → world metres, given the entry node. */
export function toWorld(node, lp) {
  const f = FWD[node.h];
  const r = rightOf(node.h);
  return [
    node.x * CELL + r[0] * lp[0] + f[0] * lp[2],
    node.y * STEP + lp[1],
    node.z * CELL + r[2] * lp[0] + f[2] * lp[2],
  ];
}
export function dirToWorld(node, v) {
  const f = FWD[node.h];
  const r = rightOf(node.h);
  return [r[0] * v[0] + f[0] * v[2], v[1], r[2] * v[0] + f[2] * v[2]];
}

/** Lay out a whole track: entry node + build result per piece. */
export function layout(track) {
  let node = { ...track.start };
  return track.pieces.map((pc) => {
    const p = clampParams(pc.fam, pc.p);
    const built = FAMILIES[pc.fam].build(p);
    const entry = node;
    node = advance(node, built.exit);
    return { entry, exit: node, built, piece: pc };
  });
}

/**
 * Speed prediction along the laid-out track: forward pass (drive, gravity, caps), backward pass
 * (braking). Returns per-piece {vIn, vMin, vOut, time, warn} and the total time.
 */
export function predict(laid) {
  const pts = [];
  laid.forEach((L, i) => {
    const s = L.built.samples;
    for (let k = i === 0 ? 0 : 1; k < s.length; k++) {
      const w = toWorld(L.entry, s[k].p);
      pts.push({ i, y: w[1], d: s[k].d, ds: k === 0 ? 0 : s[k].d - s[k - 1].d, air: s[k].air, cap: s[k].cap, loopTop: s[k].loopTop, boost: L.piece.boost });
    }
  });
  const v = new Float64Array(pts.length);
  v[0] = 0.5;
  for (let k = 1; k < pts.length; k++) {
    const P = pts[k];
    const dy = P.y - pts[k - 1].y;
    let v2 = v[k - 1] ** 2 - 2 * G * dy;
    if (!P.air && !pts[k - 1].air) {
      const top = P.boost ? CAR.boostTop : CAR.top;
      const acc = (P.boost ? CAR.boostAccel : 0) + CAR.accel * (1 - (v[k - 1] / top) ** 2);
      v2 += 2 * acc * P.ds;
    }
    v[k] = Math.sqrt(Math.max(v2, 0.25));
    if (P.cap !== undefined) v[k] = Math.min(v[k], P.cap);
  }
  for (let k = pts.length - 2; k >= 0; k--) {
    if (pts[k].air || pts[k + 1].air) continue;
    const lim = Math.sqrt(v[k + 1] ** 2 + 2 * CAR.brake * pts[k + 1].ds);
    if (v[k] > lim) v[k] = lim;
  }
  const out = laid.map(() => ({ vIn: 0, vMin: Infinity, vOut: 0, time: 0, warn: null }));
  let total = 0;
  for (let k = 0; k < pts.length; k++) {
    const o = out[pts[k].i];
    if (o.vIn === 0) o.vIn = v[k];
    o.vMin = Math.min(o.vMin, v[k]);
    o.vOut = v[k];
    if (k > 0) {
      const dt = pts[k].ds / Math.max((v[k] + v[k - 1]) / 2, 0.5);
      o.time += dt;
      total += dt;
    }
    if (pts[k].loopTop && v[k] * v[k] < G * pts[k].loopTop) o.warn = `too slow for the loop (${Math.round(v[k] * 3.6)} km/h at the top)`;
  }
  return { perPiece: out, total, speeds: v, pts };
}
