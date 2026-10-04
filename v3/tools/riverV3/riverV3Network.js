/**
 * v3/tools/riverV3/riverV3Network.js — River v3: a river NETWORK, solved.
 *
 * Pure maths: no THREE, no GPU, no DOM, so it runs headlessly and is tested
 * (tools/riverV3NetworkTest.mjs).
 *
 * THE MODEL. River v2 was one spline per river, and two rivers only met by an
 * endpoint copying the other's level. River v3 is a directed graph:
 *
 *   junction  { id, x, z, y }            y = null AUTO (solved) | number PINNED
 *   reach     { id, nodes, from, to, q }  a spline between two junctions (or a
 *                                         free end), nodes[0] at `from`, the
 *                                         last node at `to`; direction is
 *                                         downstream, always
 *
 * A tributary is two reaches ending at one junction with one leaving it; a
 * split (distributary, delta) is one in and several out. The graph must be
 * acyclic; a cycle is reported and the edge that closes it ignored.
 *
 * WHAT HAS TO BE CONTINUOUS AT A JUNCTION, AND HOW:
 *   level     Playfair's law of accordant junctions: every reach that touches a
 *             junction starts or ends at the SAME water level. Solved in
 *             topological order: a junction's level is the lowest of its own
 *             valley floor and what each incoming reach can deliver while still
 *             running downhill.
 *   discharge Q is summed at a confluence and split at a split (by the
 *             out-reaches' authored widths), so a trunk carries its tributaries.
 *   velocity  v = Q / A (continuity), so speed is conserved across a junction
 *             instead of each reach inventing its own — River v2's Manning
 *             speed pinned nam-valley's whole upper river to the 9 m/s clamp.
 *   terrain   riverV3Terrain.js: two channels meeting union by the LOWER bed.
 *
 * STATIONS ARE ANCHORED PER SPAN. v2 spaced stations evenly along the whole
 * river, so moving one node shifted every station downstream of it and a drag
 * had to recompose the entire river (~29 ms on nam-valley). Here each span
 * between two nodes carries its own stations and its values are interpolated
 * in span-local arc length, so a node move changes only the spans whose curve
 * or interpolation actually depends on it.
 */

export const V3_DEFAULTS = {
  stationSpacing: 2.5,     // m between stations along a span
  minGradient: 0.0008,     // AUTO levels fall at least this much per metre
  levelSmoothing: 2,       // passes over AUTO node levels
  bedCurve: 0.55,          // 0 flat canal … 1 parabolic
  freeboard: 0.6,          // m, lip above the water
  lipFraction: 0.28,
  maxBankSlope: 0.9,
  bankFlareMax: 4,
  minSpeed: 0.08,
  maxSpeed: 9,
  froudeStart: 0.8,
  froudeFull: 2.5,
  /** w = widthCoef · √Q (hydraulic geometry): a 10 m reach carries 16 m³/s. */
  widthCoef: 2.5,
  newWidth: 10, newDepth: 1.8, newBank: 8,
};

/** Dense samples per span when measuring and walking the curve. */
const SPAN_SUB = 24;
const G = 9.81;

// ─── Curve ──────────────────────────────────────────────────────────────────

/**
 * The four control points of span k (nodes k → k+1) of a uniform Catmull-Rom
 * through `nodes`, with the ends extrapolated by reflection — the same curve
 * THREE.CatmullRomCurve3("catmullrom", 0.5) draws, which River v2 used.
 */
function spanControls(nodes, k) {
  const n = nodes.length;
  const p1 = nodes[k], p2 = nodes[k + 1];
  const p0 = k > 0 ? nodes[k - 1] : { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z };
  const p3 = k + 2 < n ? nodes[k + 2] : { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z };
  return [p0, p1, p2, p3];
}

function crPoint(c, t) {
  const [p0, p1, p2, p3] = c;
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, cc, d) => 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) };
}

/** Dense polyline of one span with cumulative arc; depends only on its 4 controls. */
function sampleSpan(nodes, k) {
  const c = spanControls(nodes, k);
  const xs = new Float64Array(SPAN_SUB + 1), zs = new Float64Array(SPAN_SUB + 1), cum = new Float64Array(SPAN_SUB + 1);
  for (let i = 0; i <= SPAN_SUB; i++) {
    const p = crPoint(c, i / SPAN_SUB);
    xs[i] = p.x; zs[i] = p.z;
    if (i) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { xs, zs, cum, len: cum[SPAN_SUB] };
}

function spanPointAt(sp, s) {
  const { xs, zs, cum } = sp;
  if (s <= 0) return { x: xs[0], z: zs[0], i: 0 };
  if (s >= cum[SPAN_SUB]) return { x: xs[SPAN_SUB], z: zs[SPAN_SUB], i: SPAN_SUB - 1 };
  let i = 0;
  while (i < SPAN_SUB - 1 && cum[i + 1] < s) i++;
  const t = (s - cum[i]) / Math.max(cum[i + 1] - cum[i], 1e-9);
  return { x: xs[i] + (xs[i + 1] - xs[i]) * t, z: zs[i] + (zs[i + 1] - zs[i]) * t, i };
}

// ─── Interpolation ──────────────────────────────────────────────────────────

/**
 * Fritsch-Carlson (monotone cubic) slopes at each node, from span lengths
 * `h` — monotone for the same reason as River v2: an overshooting cubic
 * invents a puddle the conform then digs. The slope at node k depends only on
 * spans k−1 and k.
 */
function pchipSlopes(ys, h) {
  const n = ys.length;
  const m = new Float64Array(n);
  if (n < 2) return m;
  const d = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) d[k] = (ys[k + 1] - ys[k]) / Math.max(h[k], 1e-9);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) {
    if (d[k - 1] * d[k] <= 0) { m[k] = 0; continue; }
    const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
    m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
  }
  return m;
}

/** Value in span k at local arc s ∈ [0, h[k]] (Hermite, span-local). */
function hermite(ys, m, h, k, s) {
  const hk = Math.max(h[k], 1e-9), t = s / hk;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * hk * m[k]
    + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * hk * m[k + 1];
}

/** Lowest ground across the channel at (x, z) — River v2's corridor minimum. */
function corridorMin(sampleGround, x, z, tx, tz, reach) {
  const px = -tz, pz = tx;
  let lo = Infinity;
  for (let i = -2; i <= 2; i++) {
    const o = (i / 2) * reach;
    const h = sampleGround(x + px * o, z + pz * o);
    if (h < lo) lo = h;
  }
  return lo === Infinity ? 0 : lo;
}

// ─── Graph ──────────────────────────────────────────────────────────────────

/**
 * Topological order of the reaches (a reach after every reach that ends at its
 * `from` junction). Reaches on a cycle are returned in `cyclic` and left out.
 */
export function orderReaches(reaches) {
  const byTo = new Map();
  for (const r of reaches) if (r.to != null) (byTo.get(r.to) ?? byTo.set(r.to, []).get(r.to)).push(r);
  const indeg = new Map(reaches.map((r) => [r.id, r.from != null ? (byTo.get(r.from)?.length ?? 0) : 0]));
  const outOf = new Map();
  for (const r of reaches) if (r.from != null) (outOf.get(r.from) ?? outOf.set(r.from, []).get(r.from)).push(r);
  const queue = reaches.filter((r) => indeg.get(r.id) === 0);
  const order = [];
  const seen = new Set();
  while (queue.length) {
    const r = queue.shift();
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    order.push(r);
    if (r.to == null) continue;
    for (const nx of outOf.get(r.to) ?? []) {
      const d = indeg.get(nx.id) - 1;
      indeg.set(nx.id, d);
      if (d === 0) queue.push(nx);
    }
  }
  return { order, cyclic: reaches.filter((r) => !seen.has(r.id)) };
}

// ─── Solve ──────────────────────────────────────────────────────────────────

/**
 * Solve the whole network.
 *
 * @param {object} o
 * @param {Array}  o.junctions  [{ id, x, z, y }]
 * @param {Array}  o.reaches    [{ id, nodes:[{x,z,y,width,depth,bank}], from, to, q }]
 * @param {(x:number,z:number)=>number} o.sampleGround  GROUND, metres
 * @param {object} [o.params]   V3_DEFAULTS overrides
 * @returns {{ reaches: Map<id, object>, junctions: Map<id, {level:number, q:number, kind:string}>, cyclic: Array }}
 *   per reach the same station arrays River v2's solver returns (so the
 *   ribbon builder and the flow index take them unchanged), plus `q`.
 */
export function solveNetwork({ junctions, reaches, sampleGround, params = {} }) {
  const p = { ...V3_DEFAULTS, ...params };
  const spacing = Math.max(0.5, p.stationSpacing);
  const g = Math.max(0, p.minGradient);
  const jById = new Map(junctions.map((j) => [j.id, j]));
  const live = reaches.filter((r) => r.nodes?.length >= 2);
  const { order, cyclic } = orderReaches(live);

  // ── Geometry per reach: spans, node arcs, node channel values ────────────
  const geo = new Map();
  for (const r of order) {
    const nodes = r.nodes;
    const n = nodes.length;
    const spans = [];
    const h = new Float64Array(n - 1);
    for (let k = 0; k < n - 1; k++) { spans.push(sampleSpan(nodes, k)); h[k] = spans[k].len; }
    const width = nodes.map((nd) => Math.max(0.5, nd.width ?? p.newWidth));
    const depth = nodes.map((nd) => Math.max(0.05, nd.depth ?? p.newDepth));
    const bank = nodes.map((nd) => Math.max(0.5, nd.bank ?? p.newBank));
    // AUTO node levels: the valley floor across the channel.
    const auto = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = nodes[Math.max(0, k - 1)], b = nodes[Math.min(n - 1, k + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz) || 1;
      auto[k] = corridorMin(sampleGround, nodes[k].x, nodes[k].z, dx / L, dz / L, width[k] * 0.5 + bank[k]);
    }
    geo.set(r.id, { spans, h, width, depth, bank, auto });
  }

  // ── Discharge first: it depends only on the topology and the widths, and the
  //    junction levels below need to know which incoming reach is the trunk.
  const qIn = new Map();                     // junction id → summed inflow
  const outs = new Map();
  for (const r of order) if (r.from != null) (outs.get(r.from) ?? outs.set(r.from, []).get(r.from)).push(r);
  const reachQ = new Map();
  for (const r of order) {
    const G0 = geo.get(r.id);
    let q;
    const inflow = r.from != null ? qIn.get(r.from) : undefined;
    if (inflow == null) {
      q = Number.isFinite(r.q) ? r.q : (G0.width[0] / p.widthCoef) ** 2;
    } else {
      const sibs = outs.get(r.from);
      const wsum = sibs.reduce((a, s) => a + geo.get(s.id).width[0] ** 2, 0) || 1;
      q = inflow * (G0.width[0] ** 2) / wsum;
    }
    reachQ.set(r.id, q);
    if (r.to != null) qIn.set(r.to, (qIn.get(r.to) ?? 0) + q);
  }

  // ── Levels: junctions in topological order, then every reach ─────────────
  const jLevel = new Map();                  // junction id → level
  const nodeLevels = new Map();              // reach id → Float64Array
  const pinnedOf = new Map();
  // Junction AUTO: the lowest valley floor any reach end touching it sees.
  const jAuto = new Map();
  for (const r of order) {
    const G0 = geo.get(r.id);
    if (r.from != null) jAuto.set(r.from, Math.min(jAuto.get(r.from) ?? Infinity, G0.auto[0]));
    if (r.to != null) jAuto.set(r.to, Math.min(jAuto.get(r.to) ?? Infinity, G0.auto[G0.auto.length - 1]));
  }
  const inbound = new Map();                 // junction id → ceilings from incoming reaches
  const levelsFor = (r, startLevel) => {
    const G0 = geo.get(r.id), nodes = r.nodes, n = nodes.length;
    const lv = Float64Array.from(G0.auto);
    const pin = new Uint8Array(n);
    for (let k = 0; k < n; k++) if (Number.isFinite(nodes[k].y)) { lv[k] = nodes[k].y; pin[k] = 1; }
    if (startLevel != null) { lv[0] = startLevel; pin[0] = 1; }
    for (let pass = 0; pass < Math.max(0, Math.round(p.levelSmoothing)); pass++) {
      const prev = Float64Array.from(lv);
      for (let k = 1; k < n - 1; k++) if (!pin[k]) lv[k] = prev[k - 1] * 0.25 + prev[k] * 0.5 + prev[k + 1] * 0.25;
    }
    for (let k = 1; k < n; k++) {
      if (pin[k]) continue;
      const ceil = lv[k - 1] - g * G0.h[k - 1];
      if (lv[k] > ceil) lv[k] = ceil;
    }
    return { lv, pin };
  };
  for (const r of order) {
    const start = r.from != null ? jLevel.get(r.from) ?? null : null;
    // A junction with no incoming reach (a source junction, the head of a
    // split drawn from nothing) is resolved the first time a reach leaves it.
    let s = start;
    if (r.from != null && s == null) {
      const J = jById.get(r.from);
      s = Number.isFinite(J?.y) ? J.y : (jAuto.get(r.from) ?? geo.get(r.id).auto[0]);
      jLevel.set(r.from, s);
    }
    const { lv, pin } = levelsFor(r, s);
    nodeLevels.set(r.id, lv);
    pinnedOf.set(r.id, pin);
    if (r.to != null) {
      const G0 = geo.get(r.id), n = lv.length;
      // What this reach can deliver at its end while still running downhill.
      const ceil = n >= 2 ? lv[n - 2] - g * G0.h[n - 2] : lv[n - 1];
      const list = inbound.get(r.to) ?? [];
      list.push({ ceil: Math.min(ceil, lv[n - 1]), q: reachQ.get(r.id) });
      inbound.set(r.to, list);
      // THE TRUNK SETS THE LEVEL: the incoming reach carrying the most water
      // (ties: the higher one). Taking the lowest of all of them instead let a
      // tributary drawn from low ground drag the junction down, and the trunk
      // dug a 34 m pit to meet it (seen in the editor, 2026-09-26). A tributary
      // that cannot reach the trunk's level now shows red "uphill" arrows —
      // the author's cue — rather than being accommodated by a canyon.
      // Every reach into `to` is ordered before any reach out of it, so once
      // the last incoming one is in, the junction's level is final.
      let trunk = list[0];
      for (const e of list) if (e.q > trunk.q + 1e-9 || (Math.abs(e.q - trunk.q) <= 1e-9 && e.ceil > trunk.ceil)) trunk = e;
      const J = jById.get(r.to);
      const lvl = Number.isFinite(J?.y) ? J.y : Math.min(jAuto.get(r.to) ?? Infinity, trunk.ceil);
      jLevel.set(r.to, lvl);
    }
  }
  // Pin every reach end to its junction's final level (Playfair).
  for (const r of order) {
    const lv = nodeLevels.get(r.id), pin = pinnedOf.get(r.id), n = lv.length;
    if (r.from != null) { lv[0] = jLevel.get(r.from); pin[0] = 1; }
    if (r.to != null) { lv[n - 1] = jLevel.get(r.to); pin[n - 1] = 1; }
  }

  // ── Backwater length per junction ─────────────────────────────────────────
  // How far up (and down) each reach the junction's level holds: the two
  // widest half-widths meeting there plus 2 m — far enough that every surface
  // reaches the ownership seam (which lies within the trunk's half width of
  // the junction) at the junction's own level.
  const halfAt = new Map();                  // junction id → half widths of the ends there
  for (const r of order) {
    const w = geo.get(r.id).width;
    if (r.from != null) (halfAt.get(r.from) ?? halfAt.set(r.from, []).get(r.from)).push(w[0] * 0.5);
    if (r.to != null) (halfAt.get(r.to) ?? halfAt.set(r.to, []).get(r.to)).push(w[w.length - 1] * 0.5);
  }
  const backwater = (jid) => {
    const hs = (halfAt.get(jid) ?? [0]).slice().sort((a, b) => b - a);
    return (hs[0] ?? 0) + (hs[1] ?? 0) + 2;
  };
  const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // ── Stations ──────────────────────────────────────────────────────────────
  const out = new Map();
  for (const r of order) {
    const G0 = geo.get(r.id), nodes = r.nodes, n = nodes.length;
    const lv = nodeLevels.get(r.id);
    const mL = pchipSlopes(lv, G0.h), mW = pchipSlopes(G0.width, G0.h);
    const mD = pchipSlopes(G0.depth, G0.h), mB = pchipSlopes(G0.bank, G0.h);
    const per = G0.spans.map((sp) => Math.max(1, Math.round(sp.len / spacing)));
    const count = per.reduce((a, b) => a + b, 0) + 1;
    const A = (len) => new Float32Array(len);
    const S = {
      count, x: A(count), z: A(count), arc: A(count), tanX: A(count), tanZ: A(count),
      level: A(count), width: A(count), depth: A(count), bank: A(count),
      speed: A(count), slope: A(count), turb: A(count), froude: A(count), uphill: new Uint8Array(count),
      span: new Int32Array(count),
    };
    let i = 0, arc0 = 0;
    const put = (k, s, arc, px, pz, tx, tz) => {
      S.x[i] = px; S.z[i] = pz; S.arc[i] = arc; S.span[i] = k;
      const tl = Math.hypot(tx, tz) || 1;
      S.tanX[i] = tx / tl; S.tanZ[i] = tz / tl;
      S.level[i] = hermite(lv, mL, G0.h, k, s);
      S.width[i] = Math.max(0.5, hermite(G0.width, mW, G0.h, k, s));
      S.depth[i] = Math.max(0.05, hermite(G0.depth, mD, G0.h, k, s));
      S.bank[i] = Math.max(0.5, hermite(G0.bank, mB, G0.h, k, s));
      i++;
    };
    for (let k = 0; k < n - 1; k++) {
      const sp = G0.spans[k];
      for (let j = 0; j < per[k]; j++) {
        const s = (j / per[k]) * sp.len;
        const pt = spanPointAt(sp, s);
        put(k, s, arc0 + s, pt.x, pt.z, sp.xs[pt.i + 1] - sp.xs[pt.i], sp.zs[pt.i + 1] - sp.zs[pt.i]);
      }
      arc0 += sp.len;
    }
    const last = G0.spans[n - 2];
    put(n - 2, last.len, arc0, last.xs[SPAN_SUB], last.zs[SPAN_SUB],
      last.xs[SPAN_SUB] - last.xs[SPAN_SUB - 1], last.zs[SPAN_SUB] - last.zs[SPAN_SUB - 1]);

    // BACKWATER: near a junction the surface blends to the junction's level and
    // holds it over the last `Lb` metres (and the first, for a reach leaving a
    // junction) — real confluences do this, the trunk's level backing up the
    // tributary's mouth. Without it a steep tributary met the trunk ~0.25 m
    // above it at the ownership seam, and from an angle the height step opened
    // a sawtooth of riverbed between the two surfaces (seen in the river lab).
    // Both blends keep the profile non-increasing: the junction level is below
    // everything upstream of it and above everything downstream.
    if (r.to != null) {
      const J = jLevel.get(r.to), Lb = backwater(r.to);
      for (let s = 0; s < count; s++) {
        const w = smoothstep(arc0 - 2 * Lb, arc0 - Lb, S.arc[s]);
        if (w > 0) S.level[s] = S.level[s] + (J - S.level[s]) * w;
      }
    }
    if (r.from != null) {
      const J = jLevel.get(r.from), Lb = backwater(r.from);
      for (let s = 0; s < count; s++) {
        const w = 1 - smoothstep(Lb, 2 * Lb, S.arc[s]);
        if (w > 0) S.level[s] = S.level[s] + (J - S.level[s]) * w;
      }
    }

    // Flow: continuity with this reach's discharge.
    const q = reachQ.get(r.id);
    const shape = 1 - p.bedCurve / 3;       // mean depth / centre depth of the section
    const f0 = p.froudeStart, f1 = Math.max(f0 + 0.01, p.froudeFull);
    for (let s = 0; s < count; s++) {
      const a = Math.max(0, s - 1), b = Math.min(count - 1, s + 1);
      const fall = (S.level[a] - S.level[b]) / Math.max(S.arc[b] - S.arc[a], 1e-4);
      S.slope[s] = fall;
      if (fall < -1e-4) S.uphill[s] = 1;
      const v = q / Math.max(0.05, S.width[s] * S.depth[s] * shape);
      S.speed[s] = Math.min(p.maxSpeed, Math.max(p.minSpeed, v));
      S.froude[s] = S.speed[s] / Math.sqrt(G * Math.max(S.depth[s], 1e-3));
      S.turb[s] = Math.min(1, Math.max(0, (S.froude[s] - f0) / (f1 - f0)));
    }
    const nodeArc = new Float64Array(n);
    for (let k = 1; k < n; k++) nodeArc[k] = nodeArc[k - 1] + G0.h[k - 1];
    out.set(r.id, {
      ...S, total: arc0, q,
      nodeArc, nodeLevel: Array.from(lv), nodePinned: Array.from(pinnedOf.get(r.id)),
      hasUphill: S.uphill.some((v) => v === 1),
    });
  }

  // ── Junction summary ──────────────────────────────────────────────────────
  const jOut = new Map();
  for (const J of junctions) {
    const ins = live.filter((r) => r.to === J.id).length, os = live.filter((r) => r.from === J.id).length;
    const kind = ins === 0 ? (os ? "source" : "loose") : os === 0 ? "end"
      : ins > 1 && os === 1 ? "confluence" : ins === 1 && os > 1 ? "split" : ins === 1 && os === 1 ? "bend" : "mixed";
    jOut.set(J.id, { level: jLevel.get(J.id) ?? null, q: qIn.get(J.id) ?? 0, kind });
  }
  return { reaches: out, junctions: jOut, cyclic };
}
