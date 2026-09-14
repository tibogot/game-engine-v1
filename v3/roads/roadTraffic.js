// Minimal traffic over the lane graph — the proof that the graph is drivable.
//
// Cars follow lane pieces and connectors with the Intelligent Driver Model
// (car-following + free-road acceleration). They obey stop lines: red/amber at
// signals, a full stop then go at stop signs, slow approach at yields. Cars do
// not negotiate conflicts inside junctions — this is a lab check, not a sim.

import { polylineAt, rng } from "./roadMath.js";
import { signalState } from "./roadJunction.js";
import { profileAt } from "./roadProfile.js";

const IDM = { a: 1.6, b: 2.6, T: 1.2, s0: 2.5, len: 4.6 };
const COLORS = ["#e8e2d6", "#2a2d33", "#b8322b", "#2f5ea8", "#c9c9c9", "#7a8a4a", "#d9a441", "#556070"];

export class TrafficSim {
  constructor(result, { count = 120, seed = 7 } = {}) {
    this.rand = rng(seed);
    this.cars = [];
    this.time = 0;
    this.setNetwork(result, count);
  }

  setNetwork(result, count = this.cars.length) {
    this.result = result;
    this.graph = result.graph;
    this.lanePaths = this.graph.paths.filter((p) => p.kind === "lane" && p.len > 5);
    this.totalLen = this.lanePaths.reduce((a, p) => a + p.len, 0);
    this.cars = [];
    this.setCount(count);
  }

  setCount(count) {
    while (this.cars.length > count) this.cars.pop();
    while (this.cars.length < count && this.lanePaths.length) this.cars.push(this.spawn());
  }

  spawn() {
    let r = this.rand() * this.totalLen;
    let path = this.lanePaths[0];
    for (const p of this.lanePaths) { r -= p.len; if (r <= 0) { path = p; break; } }
    const car = {
      path, d: this.rand() * path.len, v: path.speed * 0.6, next: null,
      color: COLORS[Math.floor(this.rand() * COLORS.length)], wait: 0, cleared: null, x: 0, z: 0, th: 0,
    };
    car.next = this.pickNext(path);
    return car;
  }

  /** Height above the ground at distance d along a path (0 inside junctions). */
  liftOf(path, d) {
    if (path.kind !== "lane") return 0;
    const rr = this.result.roadsById.get(path.roadId);
    if (!rr || !rr.bridges.length) return 0;
    const f = path.len > 0 ? d / path.len : 0;
    const s = path.side === "left" ? path.s1 - (path.s1 - path.s0) * f : path.s0 + (path.s1 - path.s0) * f;
    const p = profileAt(rr.prof, s);
    return p.y - p.ground;
  }

  pickNext(path) {
    if (!path.next.length) return null;
    return this.graph.byId.get(path.next[Math.floor(this.rand() * path.next.length)]);
  }

  step(dt) {
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const byPath = new Map();
    for (const c of this.cars) {
      let arr = byPath.get(c.path);
      if (!arr) byPath.set(c.path, (arr = []));
      arr.push(c);
    }
    for (const arr of byPath.values()) arr.sort((p, q) => p.d - q.d);

    for (const c of this.cars) {
      const p = c.path;
      const arr = byPath.get(p);
      const idx = arr.indexOf(c);
      let gap = Infinity, vLead = 0;
      if (idx < arr.length - 1) {
        gap = arr[idx + 1].d - c.d - IDM.len;
        vLead = arr[idx + 1].v;
      } else if (c.next) {
        const na = byPath.get(c.next);
        if (na && na.length) {
          gap = p.len - c.d + na[0].d - IDM.len;
          vLead = na[0].v;
        }
      }
      // Stop line as a standing obstacle.
      const st = p.stop;
      let v0 = p.speed;
      if (st && c.cleared !== p.id && c.d < st.at + 0.5) {
        const dStop = st.at - c.d;
        let hold = false;
        if (st.control === "signal") {
          const s = signalState(st.arm.node, st.arm, this.time);
          hold = s === "red" || (s === "amber" && dStop > (c.v * c.v) / (2 * IDM.b) + 2);
        } else if (st.control === "stop") {
          if (dStop < 2 && c.v < 0.4) {
            c.wait += dt;
            if (c.wait > 1.1) { c.cleared = p.id; c.wait = 0; }
          }
          hold = c.cleared !== p.id;
        } else if (st.control === "yield") {
          if (dStop < 25) v0 = Math.min(v0, 5.5);
        }
        if (hold && dStop > -0.5 && dStop - 0.3 < gap) { gap = Math.max(0.05, dStop - 0.3); vLead = 0; }
      }
      if (c.next && c.next.kind === "connector") v0 = Math.min(v0, Math.max(c.next.speed, p.speed * (0.4 + 0.6 * Math.min(1, (p.len - c.d) / 40))));
      const dv = c.v - vLead;
      const sStar = IDM.s0 + Math.max(0, c.v * IDM.T + (c.v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
      let acc = IDM.a * (1 - (c.v / Math.max(0.1, v0)) ** 4 - (gap < Infinity ? (sStar / Math.max(0.1, gap)) ** 2 : 0));
      acc = Math.max(-9, acc);
      c.acc = acc;
    }
    for (const c of this.cars) {
      c.v = Math.max(0, c.v + c.acc * dt);
      c.d += c.v * dt;
      let guard = 0;
      while (c.d > c.path.len && guard++ < 8) {
        c.d -= c.path.len;
        if (!c.next) { Object.assign(c, this.spawn()); break; }
        c.path = c.next;
        c.cleared = null;
        c.next = this.pickNext(c.path);
      }
      const q = polylineAt(c.path.pts, c.path.cum, c.d);
      c.x = q.x; c.z = q.z; c.th = q.th;
      c.lift = this.liftOf(c.path, c.d);
    }
  }
}
