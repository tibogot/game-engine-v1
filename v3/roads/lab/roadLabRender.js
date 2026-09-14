// 2D renderer for the road lab. Draws a buildRoadNetwork() result top-down.
//
// Static geometry is batched into Path2D objects once per build (one fill per
// material, one stroke per marking style), so panning and zooming only replays
// a few dozen draw calls. Bridge spans are drawn twice: once with everything
// at ground level, then again clipped to the span's footprint above a drop
// shadow — that is what makes an overpass read as ABOVE the road below.

import { polylineAt } from "../roadMath.js";
import { signalState } from "../roadJunction.js";
import { evalAlignment, sampleAlignment } from "../roadAlignment.js";
import { layoutAt, layoutEdges } from "../roadCrossSection.js";
import { profileAt } from "../roadProfile.js";

export const COLORS = {
  ground: "#d9d6c8",
  groundGrid: "rgba(0,0,0,0.045)",
  block: "#e7e1d2",
  lot: "#ddd5c1",
  lotEdge: "rgba(120,105,80,0.35)",
  inner: "#cfd9b8",
  asphalt: "#3b3e44",
  sidewalk: "#c9c4b8",
  verge: "#7f9a5c",
  barrier: "#a4a4a0",
  parking: "#464950",
  bike: "#4d7355",
  bus: "#7b3d38",
  shoulder: "#4b4e54",
  turn: "#3b3e44",
  curb: "#e9e5da",
  paveEdge: "rgba(0,0,0,0.25)",
  white: "#f2f0ea",
  yellow: "#e6b53a",
  grass: "#86a462",
  apron: "#a79a86",
  raised: "#b9b3a6",
  medianGrass: "#7f9a5c",
  shadow: "rgba(20,20,30,0.28)",
  rail: "#d8d8d4",
  pier: "#6e6a62",
  laneGraph: "rgba(60,190,255,0.75)",
  connector: "rgba(255,160,60,0.85)",
};

const STRIP_FILL = { sidewalk: "sidewalk", verge: "verge", barrier: "barrier", parking: "parking", bike: "bike", bus: "bus", shoulder: "shoulder" };

function polyPath(path, pts) {
  if (!pts || pts.length < 2) return;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
  path.closePath();
}
function linePath(path, pts) {
  if (!pts || pts.length < 2) return;
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
}

class Batch {
  constructor() {
    this.fills = new Map(); // color key → Path2D
    this.strokes = new Map(); // style key → { path, width, color, dash }
    this.hatches = [];
    this.medianGrass = new Path2D();
  }
  fill(key) {
    let p = this.fills.get(key);
    if (!p) this.fills.set(key, (p = new Path2D()));
    return p;
  }
  stroke(color, width, dash) {
    const k = `${color}|${width}|${dash ? dash.join(",") : ""}`;
    let s = this.strokes.get(k);
    if (!s) this.strokes.set(k, (s = { path: new Path2D(), color, width, dash }));
    return s.path;
  }
}

function addRoadToBatch(b, rr) {
  for (const s of rr.strips) {
    const key = STRIP_FILL[s.type];
    if (key && (key === "sidewalk" || key === "verge" || key === "barrier")) polyPath(b.fill(`side:${key}`), s.poly);
  }
  polyPath(b.fill("asphalt"), rr.carriage);
  for (const s of rr.strips) {
    const key = STRIP_FILL[s.type];
    if (key && !(key === "sidewalk" || key === "verge" || key === "barrier")) polyPath(b.fill(`over:${key}`), s.poly);
  }
  if (rr.center) {
    if (rr.center.kind === "raised") polyPath(b.fill("median:raised"), rr.center.poly);
    else if (rr.center.kind === "barrier") polyPath(b.fill("median:barrier"), rr.center.poly);
    else if (rr.center.kind === "painted") b.hatches.push({ poly: rr.center.poly, angle: rr.smp.th[0] + Math.PI / 4, spacing: 2.2, width: 0.3, color: "white" });
  }
  for (const c of rr.curbs) {
    if (c.kind === "curb") linePath(b.stroke(COLORS.curb, 0.28, null), c.pts);
    else linePath(b.stroke(COLORS.paveEdge, 0.12, null), c.pts);
  }
  for (const l of rr.lines) linePath(b.stroke(COLORS[l.color] || l.color, l.width, l.dash), l.pts);
  if (rr.type.rank >= 5 && rr.center?.kind === "barrier") {
    const S = rr.smp, pts = [];
    for (let i = 0; i < S.s.length; i++) pts.push([S.x[i], S.z[i]]);
    linePath(b.stroke(COLORS.barrier, 0.6, null), pts);
  }
}

function addNodeToBatch(b, node) {
  for (const sw of node.sidewalks || []) polyPath(b.fill("side:sidewalk"), sw);
  if (node.pad) polyPath(b.fill("asphalt"), node.pad);
  for (const isl of node.islands || []) {
    const key = isl.kind === "grass" ? "island:grass" : isl.kind === "apron" ? "island:apron" : "island:raised";
    polyPath(b.fill(key), isl.poly);
    if (isl.kind !== "grass") linePath(b.stroke(COLORS.curb, 0.25, null), [...isl.poly, isl.poly[0]]);
  }
  if (node.kind === "junction" || node.kind === "roundabout") {
    for (const c of node.corners) if (c.curbChain) linePath(b.stroke(COLORS.curb, 0.28, null), c.curbChain);
  }
  for (const cb of node.curbs || []) linePath(b.stroke(COLORS.curb, 0.28, null), cb);
  for (const m of node.markings) {
    const col = COLORS[m.color] || m.color;
    if (m.kind === "poly") polyPath(b.fill(`paint:${col}`), m.pts);
    else if (m.kind === "line") linePath(b.stroke(col, m.width, m.dash || null), m.pts);
    else if (m.kind === "hatch") b.hatches.push(m);
  }
}

function drawBatch(ctx, b, px) {
  const fillKeys = [
    ["side:verge", COLORS.verge], ["side:sidewalk", COLORS.sidewalk], ["side:barrier", COLORS.barrier],
    ["asphalt", COLORS.asphalt],
    ["over:shoulder", COLORS.shoulder], ["over:parking", COLORS.parking], ["over:bike", COLORS.bike], ["over:bus", COLORS.bus],
    ["median:raised", COLORS.medianGrass], ["median:barrier", COLORS.raised],
    ["island:apron", COLORS.apron], ["island:grass", COLORS.grass], ["island:raised", COLORS.raised],
  ];
  for (const [k, col] of fillKeys) {
    const p = b.fills.get(k);
    if (!p) continue;
    ctx.fillStyle = col;
    ctx.fill(p);
    // Seal hairline seams between abutting polygons.
    if (k === "asphalt" || k.startsWith("side:")) {
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(0.12, 0.6 / px);
      ctx.stroke(p);
    }
  }
  if (px < 0.35) return;
  for (const s of b.strokes.values()) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(s.width, 0.7 / px);
    ctx.setLineDash(s.dash || []);
    ctx.stroke(s.path);
  }
  ctx.setLineDash([]);
  for (const [k, p] of b.fills) {
    if (!k.startsWith("paint:")) continue;
    ctx.fillStyle = k.slice(6);
    ctx.fill(p);
  }
  for (const h of b.hatches) drawHatch(ctx, h, px);
}

function drawHatch(ctx, h, px) {
  const pts = h.poly;
  if (!pts || pts.length < 3) return;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
  const clip = new Path2D();
  polyPath(clip, pts);
  ctx.save();
  ctx.clip(clip);
  const col = COLORS[h.color] || h.color;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(h.width, 0.7 / px);
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const R = Math.hypot(x1 - x0, z1 - z0) / 2 + 2;
  const dx = Math.cos(h.angle), dz = Math.sin(h.angle);
  const nx = -dz, nz = dx;
  ctx.beginPath();
  for (let o = -R; o <= R; o += h.spacing) {
    ctx.moveTo(cx + nx * o - dx * R, cz + nz * o - dz * R);
    ctx.lineTo(cx + nx * o + dx * R, cz + nz * o + dz * R);
  }
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(0.15, 0.7 / px);
  ctx.stroke(clip);
}

export class RoadRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.view = { cx: 0, cz: 0, scale: 1.5 };
    this.layers = {
      terrain: true, blocks: true, lots: true, surface: true, markings: true, props: true,
      laneGraph: false, traffic: true, structures: true, construction: true, issues: true, curvature: false,
    };
    this.terrainImg = null;
    this.dpr = 1;
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.H = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  toWorld(sx, sy) {
    const v = this.view;
    return [(sx - this.W / 2) / v.scale + v.cx, (sy - this.H / 2) / v.scale + v.cz];
  }
  toScreen(x, z) {
    const v = this.view;
    return [(x - v.cx) * v.scale + this.W / 2, (z - v.cz) * v.scale + this.H / 2];
  }

  fit(result) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const n of result.nodes) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); z0 = Math.min(z0, n.z); z1 = Math.max(z1, n.z); }
    for (const r of result.roads) for (const p of r.src.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    if (!isFinite(x0)) { this.view = { cx: 0, cz: 0, scale: 1.5 }; return; }
    this.view.cx = (x0 + x1) / 2; this.view.cz = (z0 + z1) / 2;
    this.view.scale = Math.min(6, Math.max(0.15, Math.min(this.W / (x1 - x0 + 120), this.H / (z1 - z0 + 120))));
  }

  setTerrain(fn, name) {
    if (name === "flat") { this.terrainImg = null; return; }
    const ext = 1400, res = 3.5;
    const N = Math.round((2 * ext) / res);
    const cvs = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(N, N) : Object.assign(document.createElement("canvas"), { width: N, height: N });
    const c = cvs.getContext("2d");
    const img = c.createImageData(N, N);
    const H = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = fn(-ext + i * res, -ext + j * res);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const h = H[j * N + i];
        const hx = H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)];
        const hz = H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i];
        const shade = Math.max(0.55, Math.min(1.15, 1 - (hx * 0.9 + hz * 0.6) / (2 * res) * 1.8));
        const t = Math.max(0, Math.min(1, (h + 20) / 50));
        let r = 196 + (178 - 196) * t, g = 200 + (170 - 200) * t, b = 170 + (140 - 170) * t;
        const band = Math.abs(((h % 5) + 5) % 5);
        const contour = band < 0.28 || band > 4.72;
        const k = contour ? 0.86 : 1;
        const p = (j * N + i) * 4;
        img.data[p] = r * shade * k; img.data[p + 1] = g * shade * k; img.data[p + 2] = b * shade * k; img.data[p + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    this.terrainImg = { cvs, ext, N, res };
  }

  setResult(result) {
    this.result = result;
    const ground = new Batch();
    const elevated = [];
    for (const rr of result.roads) addRoadToBatch(ground, rr);
    for (const n of result.nodes) addNodeToBatch(ground, n);
    for (const rr of result.roads) {
      if (!rr.bridges.length) continue;
      const own = new Batch();
      addRoadToBatch(own, rr);
      const spans = rr.bridges.map((sp) => {
        const s0 = Math.max(rr.s0, sp.s0), s1 = Math.min(rr.s1, sp.s1);
        if (s1 - s0 < 1) return null;
        const smp = sampleAlignment(rr.al, s0, s1, { maxStep: 4 });
        const L = [], R = [];
        for (let i = 0; i < smp.s.length; i++) {
          const e = layoutEdges(layoutAt(rr.stack, smp.s[i], rr.L));
          const sx = Math.sin(smp.th[i]), sz = -Math.cos(smp.th[i]);
          L.push([smp.x[i] + sx * (e.propL + 0.4), smp.z[i] + sz * (e.propL + 0.4)]);
          R.push([smp.x[i] + sx * (e.propR - 0.4), smp.z[i] + sz * (e.propR - 0.4)]);
        }
        const clip = new Path2D();
        polyPath(clip, [...R, ...L.slice().reverse()]);
        const rails = new Path2D();
        linePath(rails, L); linePath(rails, R);
        const shadow = [...R, ...L.slice().reverse()];
        return { clip, rails, shadow, lift: (profileAt(rr.prof, (s0 + s1) / 2).y - profileAt(rr.prof, (s0 + s1) / 2).ground) };
      }).filter(Boolean);
      elevated.push({ rr, batch: own, spans });
    }
    this.ground = ground;
    this.elevated = elevated;

    const blocks = new Path2D(), lots = new Path2D(), inner = new Path2D();
    for (const b of result.blocks) {
      polyPath(blocks, b.poly);
      for (const l of b.lots) polyPath(l.street ? lots : inner, l.poly);
    }
    this.blockPaths = { blocks, lots, inner };

    const lanes = new Path2D(), cons = new Path2D();
    for (const p of result.graph.paths) linePath(p.kind === "lane" ? lanes : cons, p.pts);
    this.graphPaths = { lanes, cons };
  }

  draw(state) {
    const { ctx, view: v, dpr, result } = this;
    if (!result) return;
    const px = v.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr * px, 0, 0, dpr * px, dpr * (this.W / 2 - v.cx * px), dpr * (this.H / 2 - v.cz * px));
    ctx.lineJoin = "round";
    ctx.lineCap = "butt";

    if (this.layers.terrain && this.terrainImg) {
      const t = this.terrainImg;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(t.cvs, -t.ext, -t.ext, t.N * t.res, t.N * t.res);
    } else {
      this.drawGrid(ctx);
    }
    if (this.layers.blocks) {
      ctx.fillStyle = COLORS.block;
      ctx.fill(this.blockPaths.blocks);
      if (this.layers.lots && px > 0.5) {
        ctx.fillStyle = COLORS.lot; ctx.fill(this.blockPaths.lots);
        ctx.fillStyle = COLORS.inner; ctx.fill(this.blockPaths.inner);
        ctx.strokeStyle = COLORS.lotEdge; ctx.lineWidth = Math.max(0.25, 0.8 / px);
        ctx.stroke(this.blockPaths.lots); ctx.stroke(this.blockPaths.inner);
      }
    }
    if (this.layers.surface) {
      drawBatch(ctx, this.ground, this.layers.markings ? px : 0);
      if (this.layers.structures) {
        ctx.fillStyle = COLORS.pier;
        for (const s of result.structures) {
          if (s.kind !== "pier") continue;
          const w = s.width * 0.75, d = 1.6;
          const c = Math.cos(s.th), sn = Math.sin(s.th);
          ctx.beginPath();
          const corners = [[-d / 2, -w / 2], [d / 2, -w / 2], [d / 2, w / 2], [-d / 2, w / 2]];
          corners.forEach(([u, t], i) => {
            const x = s.x + c * u + sn * t, z = s.z + sn * u - c * t;
            if (i === 0) ctx.moveTo(x, z); else ctx.lineTo(x, z);
          });
          ctx.closePath();
          ctx.fill();
        }
      }
      // Cars under a bridge must be drawn BEFORE the deck covers them.
      const cars = this.layers.traffic ? state.cars : null;
      const BRIDGE_LIFT = 3.0; // matches the bridge test in roadNetwork.js
      if (cars) this.drawCars(ctx, cars.filter((c) => !(c.lift > BRIDGE_LIFT)), px);
      for (const el of this.elevated) {
        for (const sp of el.spans) {
          const off = Math.min(9, 0.8 + sp.lift * 0.35);
          ctx.save();
          ctx.translate(off * 0.7, off);
          ctx.fillStyle = COLORS.shadow;
          const sh = new Path2D();
          polyPath(sh, sp.shadow);
          ctx.fill(sh);
          ctx.restore();
          ctx.save();
          ctx.clip(sp.clip);
          ctx.fillStyle = COLORS.barrier;
          ctx.fill(sp.clip);
          drawBatch(ctx, el.batch, this.layers.markings ? px : 0);
          ctx.restore();
          ctx.strokeStyle = COLORS.rail;
          ctx.lineWidth = Math.max(0.5, 1 / px);
          ctx.stroke(sp.rails);
        }
      }
      if (cars) this.drawCars(ctx, cars.filter((c) => c.lift > BRIDGE_LIFT), px);
    } else if (this.layers.traffic && state.cars) {
      this.drawCars(ctx, state.cars, px);
    }
    if (this.layers.laneGraph) {
      ctx.lineWidth = Math.max(0.15, 1.2 / px);
      ctx.strokeStyle = COLORS.laneGraph; ctx.stroke(this.graphPaths.lanes);
      ctx.strokeStyle = COLORS.connector; ctx.stroke(this.graphPaths.cons);
      if (px > 1.2) this.drawLaneArrows(ctx, px);
    }
    if (this.layers.props && px > 0.7) this.drawProps(ctx, px, state.time || 0);
    if (this.layers.curvature && state.selectedRoad) this.drawCurvature(ctx, state.selectedRoad, px);
    if (this.layers.construction) this.drawConstruction(ctx, px, state);
    if (state.draft) this.drawDraft(ctx, px, state.draft);
    if (state.stationMarker) {
      const m = state.stationMarker;
      ctx.strokeStyle = "#ff4fd8";
      ctx.lineWidth = Math.max(0.3, 2 / px);
      ctx.beginPath(); ctx.moveTo(m[0][0], m[0][1]); ctx.lineTo(m[1][0], m[1][1]); ctx.stroke();
    }
    if (this.layers.issues) this.drawIssues(ctx, px, state);
  }

  drawGrid(ctx) {
    const v = this.view;
    const [x0, z0] = this.toWorld(0, 0), [x1, z1] = this.toWorld(this.W, this.H);
    const step = v.scale > 2 ? 10 : v.scale > 0.5 ? 50 : 250;
    ctx.strokeStyle = COLORS.groundGrid;
    ctx.lineWidth = 1 / v.scale;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x, z0); ctx.lineTo(x, z1); }
    for (let z = Math.floor(z0 / step) * step; z <= z1; z += step) { ctx.moveTo(x0, z); ctx.lineTo(x1, z); }
    ctx.stroke();
  }

  drawLaneArrows(ctx, px) {
    ctx.fillStyle = COLORS.laneGraph;
    for (const p of this.result.graph.paths) {
      if (p.kind !== "lane" || p.len < 12) continue;
      for (let d = 10; d < p.len; d += 30) {
        const q = polylineAt(p.pts, p.cum, d);
        const s = Math.max(0.8, 4 / px);
        const c = Math.cos(q.th), n = Math.sin(q.th);
        ctx.beginPath();
        ctx.moveTo(q.x + c * s, q.z + n * s);
        ctx.lineTo(q.x - c * s * 0.6 - n * s * 0.6, q.z - n * s * 0.6 + c * s * 0.6);
        ctx.lineTo(q.x - c * s * 0.6 + n * s * 0.6, q.z - n * s * 0.6 - c * s * 0.6);
        ctx.fill();
      }
    }
  }

  drawProps(ctx, px, time) {
    for (const p of this.result.props) {
      if (p.kind === "tree") {
        ctx.fillStyle = "rgba(40,70,30,0.35)";
        ctx.beginPath(); ctx.arc(p.x + 0.8, p.z + 1.1, 2.9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#5f8a3f";
        ctx.beginPath(); ctx.arc(p.x, p.z, 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#79a552";
        ctx.beginPath(); ctx.arc(p.x - 0.6, p.z - 0.7, 1.5, 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === "lamp") {
        ctx.fillStyle = "#2f3136";
        ctx.beginPath(); ctx.arc(p.x, p.z, Math.max(0.35, 1.6 / px), 0, Math.PI * 2); ctx.fill();
        if (px > 2) {
          ctx.fillStyle = "rgba(255,226,140,0.9)";
          ctx.beginPath(); ctx.arc(p.x, p.z, 0.25, 0, Math.PI * 2); ctx.fill();
        }
      } else if (p.kind === "signal") {
        const node = this.result.nodesById.get(p.nodeId);
        const arm = node?.arms[p.armIndex];
        const st = arm ? signalState(node, arm, time) : "red";
        ctx.fillStyle = "#1f2024";
        ctx.beginPath(); ctx.arc(p.x, p.z, Math.max(0.6, 2.2 / px), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = st === "green" ? "#4be07a" : st === "amber" ? "#ffc23d" : "#ff4a3d";
        ctx.beginPath(); ctx.arc(p.x, p.z, Math.max(0.4, 1.5 / px), 0, Math.PI * 2); ctx.fill();
      } else if (p.kind === "stopSign") {
        const r = Math.max(0.6, 2.4 / px);
        ctx.fillStyle = "#c8261e";
        ctx.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = Math.PI / 8 + (k * Math.PI) / 4;
          ctx.lineTo(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
      } else if (p.kind === "yieldSign") {
        const r = Math.max(0.6, 2.6 / px);
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#c8261e"; ctx.lineWidth = Math.max(0.2, 1 / px);
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          const a = p.th + Math.PI + (k * Math.PI * 2) / 3;
          ctx.lineTo(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }

  drawCars(ctx, cars, px) {
    const L = 4.5, W = 1.9;
    for (const c of cars) {
      const cs = Math.cos(c.th), sn = Math.sin(c.th);
      ctx.save();
      ctx.transform(cs, sn, -sn, cs, c.x, c.z);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(-L / 2 + 0.3, -W / 2 + 0.35, L, W);
      ctx.fillStyle = c.color;
      ctx.fillRect(-L / 2, -W / 2, L, W);
      if (px > 2.5) {
        ctx.fillStyle = "rgba(20,30,40,0.55)";
        ctx.fillRect(L * 0.08, -W / 2 + 0.2, 1.0, W - 0.4);
        if (c.acc < -1.5) { ctx.fillStyle = "#ff3b2f"; ctx.fillRect(-L / 2 - 0.1, -W / 2 + 0.1, 0.25, W - 0.2); }
      }
      ctx.restore();
    }
  }

  drawCurvature(ctx, rr, px) {
    const S = rr.smp;
    ctx.strokeStyle = "rgba(255,80,200,0.6)";
    ctx.lineWidth = Math.max(0.2, 1 / px);
    ctx.beginPath();
    const tips = [];
    for (let i = 0; i < S.s.length; i++) {
      const k = S.k[i] * 1500;
      const x = S.x[i] - Math.sin(S.th[i]) * k, z = S.z[i] + Math.cos(S.th[i]) * k;
      ctx.moveTo(S.x[i], S.z[i]); ctx.lineTo(x, z);
      tips.push([x, z]);
    }
    ctx.stroke();
    ctx.beginPath();
    tips.forEach((t, i) => (i ? ctx.lineTo(t[0], t[1]) : ctx.moveTo(t[0], t[1])));
    ctx.stroke();
  }

  drawConstruction(ctx, px, state) {
    const res = this.result;
    const sel = state.selection;
    const hov = state.hover;
    const R = (r) => r / px;
    // Selected road outline + tangent polygon + PIs.
    const outlineRoad = (rr, color, w) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = R(w);
      const E = rr.edgesPts;
      ctx.beginPath();
      linePathCtx(ctx, E.propL); linePathCtx(ctx, E.propR);
      ctx.stroke();
    };
    if (hov?.kind === "road" && !(sel?.kind === "road" && sel.id === hov.id)) {
      const rr = res.roadsById.get(hov.id);
      if (rr) outlineRoad(rr, "rgba(80,170,255,0.55)", 2);
    }
    const selRoadId = sel?.kind === "road" ? sel.id : sel?.kind === "pi" ? sel.roadId : null;
    if (selRoadId) {
      const rr = res.roadsById.get(selRoadId);
      if (rr) {
        outlineRoad(rr, "#2f9bff", 2.5);
        const V = [[rr.armA.ox, rr.armA.oz], ...rr.src.pts.map((p) => [p.x, p.z]), [rr.armB.ox, rr.armB.oz]];
        ctx.setLineDash([R(6), R(5)]);
        ctx.strokeStyle = "rgba(47,155,255,0.8)";
        ctx.lineWidth = R(1.2);
        ctx.beginPath(); linePathCtx(ctx, V); ctx.stroke();
        ctx.setLineDash([]);
        for (const v of rr.al.vertices) {
          if (v.virtual) continue;
          const ts = evalAlignment(rr.al, v.sTS), st = evalAlignment(rr.al, v.sST);
          ctx.fillStyle = "#2f9bff";
          for (const p of [ts, st]) { ctx.beginPath(); ctx.arc(p.x, p.z, R(2.5), 0, Math.PI * 2); ctx.fill(); }
        }
        rr.src.pts.forEach((p, i) => {
          const on = sel.kind === "pi" && sel.index === i;
          const hv = hov?.kind === "pi" && hov.roadId === selRoadId && hov.index === i;
          ctx.fillStyle = on ? "#ffb02e" : hv ? "#9fd0ff" : "#ffffff";
          ctx.strokeStyle = "#1f6fd1";
          ctx.lineWidth = R(2);
          ctx.beginPath(); ctx.rect(p.x - R(5), p.z - R(5), R(10), R(10)); ctx.fill(); ctx.stroke();
        });
      }
    }
    // Nodes.
    if (px > 0.25) {
      for (const n of res.nodes) {
        const on = sel?.kind === "node" && sel.id === n.id;
        const hv = hov?.kind === "node" && hov.id === n.id;
        if (!on && !hv && px < 0.9) continue;
        const r = on ? 7 : hv ? 6.5 : 4.5;
        ctx.fillStyle = on ? "#ffb02e" : hv ? "#9fd0ff" : "rgba(255,255,255,0.85)";
        ctx.strokeStyle = n.kind === "roundabout" ? "#7b4dff" : n.kind === "split" ? "#00a88f" : "#1f6fd1";
        ctx.lineWidth = R(2);
        ctx.beginPath(); ctx.arc(n.x, n.z, R(r), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    }
    if (state.snap) {
      ctx.strokeStyle = "#ffb02e"; ctx.lineWidth = R(2);
      ctx.beginPath(); ctx.arc(state.snap[0], state.snap[1], R(10), 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawDraft(ctx, px, draft) {
    const R = (r) => r / px;
    const pts = draft.preview;
    if (draft.outline) {
      ctx.fillStyle = "rgba(47,155,255,0.22)";
      ctx.fill(draft.outline);
      ctx.strokeStyle = "rgba(47,155,255,0.9)";
      ctx.lineWidth = R(1.5);
      ctx.stroke(draft.outline);
    }
    if (pts) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = R(1.5);
      ctx.setLineDash([R(8), R(6)]);
      ctx.beginPath(); linePathCtx(ctx, pts); ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const p of draft.verts) {
      ctx.fillStyle = "#fff"; ctx.strokeStyle = "#1f6fd1"; ctx.lineWidth = R(2);
      ctx.beginPath(); ctx.rect(p[0] - R(4), p[1] - R(4), R(8), R(8)); ctx.fill(); ctx.stroke();
    }
  }

  drawIssues(ctx, px, state) {
    const R = (r) => r / px;
    for (const i of this.result.issues) {
      if (i.x == null || i.level === "info") continue;
      const on = state.focusIssue === i;
      ctx.fillStyle = i.level === "error" ? "#ff3b30" : "#ff9f0a";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = R(2);
      ctx.beginPath(); ctx.arc(i.x, i.z, R(on ? 11 : 8), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${R(11)}px system-ui`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("!", i.x, i.z + R(0.5));
    }
  }
}

function linePathCtx(ctx, pts) {
  if (!pts || pts.length < 2) return;
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
}
