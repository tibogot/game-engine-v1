// Road lab app: owns the network data, rebuilds it, and turns mouse/keyboard
// into edit ops. Shortcuts match e.key (the printed label) so they work on
// AZERTY too.

import { buildRoadNetwork } from "../roadNetwork.js";
import { ROAD_TYPES, resolveStack, layoutAt, layoutEdges } from "../roadCrossSection.js";
import { fitAlignment, sampleAlignment } from "../roadAlignment.js";
import { SCENES } from "../roadScenes.js";
import { terrainFn } from "../roadTerrain.js";
import { TrafficSim } from "../roadTraffic.js";
import {
  emptyNetwork, addNode, addRoad, splitRoadAt, mergeNodes, insertJunction, insertPI, removePI,
  deleteNode, deleteRoad, findNode, findRoad,
} from "../roadEdit.js";
import { RoadRenderer } from "./roadLabRender.js";
import { LabPanel } from "./roadLabPanel.js";

const STORE = "v3.roadLab.network";

export class RoadLabApp {
  constructor({ canvas, panel, readout }) {
    this.canvas = canvas;
    this.readout = readout;
    this.renderer = new RoadRenderer(canvas);
    this.renderer.resize();
    this.tool = "select";
    this.drawType = "local";
    this.gridSnap = false;
    this.selection = null;
    this.hover = null;
    this.draft = null;
    this.undo = [];
    this.redo = [];
    this.trafficOn = true;
    this.carCount = 160;
    this.speed = 1;
    this.stationMarker = null;
    this.focusedIssue = null;
    this.editBase = null;
    this.pendingRebuild = false;
    this.dirtyDraw = true;

    this.data = this.loadStored() || SCENES.downtown.build();
    this.terrainName = null;
    this.rebuild();
    this.sim = new TrafficSim(this.result, { count: this.carCount });
    this.panel = new LabPanel(panel, this);
    this.renderer.fit(this.result);

    this.bindInput();
    window.addEventListener("resize", () => { this.renderer.resize(); this.redraw(); });
    let last = performance.now();
    const frame = (t) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      if (this.pendingRebuild) {
        this.pendingRebuild = false;
        this.rebuild({ fast: true });
        this.panel.refresh({ inspector: false });
        this.panel._profileRedraw?.();
      }
      const animate = this.trafficOn && this.renderer.layers.traffic && !this.editBase;
      if (animate) this.sim.step(dt * this.speed);
      if (animate || this.dirtyDraw || this.renderer.layers.props) this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------- data */

  get ground() { return terrainFn(this.data.terrain); }

  rebuild({ fast = false } = {}) {
    this.result = buildRoadNetwork(this.data, { ground: this.ground, fast });
    if (this.terrainName !== (this.data.terrain || "flat")) {
      this.terrainName = this.data.terrain || "flat";
      this.renderer.setTerrain(this.ground, this.terrainName);
    }
    this.renderer.setResult(this.result);
    if (this.sim && !this.editBase) this.sim.setNetwork(this.result, this.carCount);
    this.validateSelection();
    this.dirtyDraw = true;
  }

  validateSelection() {
    const s = this.selection;
    if (!s) return;
    const ok = s.kind === "node" ? !!findNode(this.data, s.id)
      : s.kind === "road" ? !!findRoad(this.data, s.id)
      : !!findRoad(this.data, s.roadId)?.pts[s.index];
    if (!ok) this.selection = null;
  }

  commit(mutate, { inspector = true } = {}) {
    const before = JSON.stringify(this.data);
    mutate(this.data);
    const after = JSON.stringify(this.data);
    if (before === after) { this.panel.refresh({ inspector }); return; }
    this.undo.push(before);
    if (this.undo.length > 300) this.undo.shift();
    this.redo.length = 0;
    this.rebuild();
    this.save();
    this.panel.refresh({ inspector });
  }

  beginEdit() { if (!this.editBase) this.editBase = JSON.stringify(this.data); }
  live(mutate) { mutate(this.data); this.pendingRebuild = true; }
  endEdit({ inspector = true } = {}) {
    if (!this.editBase) return;
    const base = this.editBase;
    this.editBase = null;
    if (JSON.stringify(this.data) !== base) {
      this.undo.push(base);
      this.redo.length = 0;
    }
    this.pendingRebuild = false;
    this.rebuild();
    this.save();
    this.panel.refresh({ inspector });
  }

  undoStep() {
    if (!this.undo.length) return;
    this.redo.push(JSON.stringify(this.data));
    this.data = JSON.parse(this.undo.pop());
    this.rebuild(); this.save(); this.panel.build();
  }
  redoStep() {
    if (!this.redo.length) return;
    this.undo.push(JSON.stringify(this.data));
    this.data = JSON.parse(this.redo.pop());
    this.rebuild(); this.save(); this.panel.build();
  }

  setData(data, { fit = true } = {}) {
    this.undo.push(JSON.stringify(this.data));
    this.redo.length = 0;
    this.data = data;
    this.selection = null;
    this.draft = null;
    this.rebuild();
    // ~1 car per 45 m of lane: busy but flowing on any network size.
    this.setCarCount(Math.max(20, Math.min(500, Math.round(this.result.stats.laneKm * 22))));
    this.save();
    if (fit) this.renderer.fit(this.result);
    this.panel.build();
  }

  loadScene(key) { this.setData(SCENES[key].build()); }
  newNetwork() { this.setData(emptyNetwork(this.data.style), { fit: false }); }

  loadStored() {
    try {
      const raw = localStorage.getItem(STORE);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && Array.isArray(d.nodes) && Array.isArray(d.roads) ? d : null;
    } catch { return null; }
  }
  save() {
    try { localStorage.setItem(STORE, JSON.stringify(this.data)); } catch { /* storage full or blocked */ }
  }

  exportFile() {
    const blob = new Blob([JSON.stringify(this.data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "road-network.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  async importFile(file) {
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.nodes) || !Array.isArray(d.roads)) throw new Error("not a road network");
      this.setData(d);
    } catch (e) { alert(`Import failed: ${e.message}`); }
  }

  setCarCount(n) { this.carCount = n; this.sim.setCount(n); }

  /* ---------------------------------------------------------------- view */

  redraw() { this.dirtyDraw = true; }
  fitView() { this.renderer.fit(this.result); this.redraw(); }

  draw() {
    this.dirtyDraw = false;
    const selRoad = this.selection?.kind === "road" ? this.result.roadsById.get(this.selection.id) : null;
    this.renderer.draw({
      selection: this.selection, hover: this.hover, draft: this.draft, snap: this.draft?.snap ? [this.draft.snap.x, this.draft.snap.z] : null,
      cars: this.editBase ? null : this.sim.cars, time: this.sim.time, selectedRoad: selRoad,
      stationMarker: this.selection?.kind === "road" ? this.stationMarker : null, focusIssue: this.focusedIssue,
    });
  }

  select(sel) {
    this.selection = sel;
    this.stationMarker = null;
    this.panel.refresh();
    this.redraw();
  }

  setTool(t) {
    this.tool = t;
    this.draft = null;
    this.canvas.style.cursor = t === "draw" ? "crosshair" : "default";
    this.panel.refresh({ inspector: false });
    this.redraw();
  }

  focusIssue(i) {
    this.focusedIssue = i;
    if (i.x != null) {
      this.renderer.view.cx = i.x;
      this.renderer.view.cz = i.z;
      this.renderer.view.scale = Math.max(this.renderer.view.scale, 2.5);
    }
    if (i.roadId) this.select({ kind: "road", id: i.roadId });
    else if (i.nodeId) this.select({ kind: "node", id: i.nodeId });
    this.redraw();
  }

  applyFix(fix) {
    if (fix.action === "insertJunction") {
      this.commit((d) => insertJunction(d, fix.a, fix.b, fix.x, fix.z, this.result));
    }
  }

  /* ---------------------------------------------------------------- picking */

  pick(sx, sy) {
    const [x, z] = this.renderer.toWorld(sx, sy);
    const tol = 11 / this.renderer.view.scale;
    const sel = this.selection;
    const roadId = sel?.kind === "road" ? sel.id : sel?.kind === "pi" ? sel.roadId : null;
    if (roadId) {
      const road = findRoad(this.data, roadId);
      if (road) {
        for (let i = 0; i < road.pts.length; i++) {
          if (Math.hypot(road.pts[i].x - x, road.pts[i].z - z) < tol) return { kind: "pi", roadId, index: i };
        }
      }
    }
    let best = null, bd = tol * 1.2;
    for (const n of this.data.nodes) {
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = { kind: "node", id: n.id }; }
    }
    if (best) return best;
    const loc = this.result.locate(x, z);
    if (loc?.kind === "road") return { kind: "road", id: loc.roadId };
    if (loc?.kind === "node") return { kind: "node", id: loc.nodeId };
    return null;
  }

  snapPoint(sx, sy, allowSnap = true) {
    let [x, z] = this.renderer.toWorld(sx, sy);
    if (allowSnap) {
      const tol = 14 / this.renderer.view.scale;
      let best = null, bd = tol;
      for (const n of this.data.nodes) {
        const d = Math.hypot(n.x - x, n.z - z);
        if (d < bd) { bd = d; best = { kind: "node", id: n.id, x: n.x, z: n.z }; }
      }
      if (best) return best;
      const loc = this.result.locate(x, z);
      if (loc?.kind === "road" && Math.abs(loc.t) < 6) {
        const rr = this.result.roadsById.get(loc.roadId);
        const s = Math.min(rr.s1 - 2, Math.max(rr.s0 + 2, loc.s));
        const S = sampleAlignment(rr.al, s, Math.min(rr.L, s + 0.01));
        return { kind: "road", id: loc.roadId, x: S.x[0], z: S.z[0] };
      }
      if (loc?.kind === "node") {
        const n = findNode(this.data, loc.nodeId);
        return { kind: "node", id: n.id, x: n.x, z: n.z };
      }
    }
    if (this.gridSnap) { x = Math.round(x / 5) * 5; z = Math.round(z / 5) * 5; }
    return { kind: "free", x, z };
  }

  /* ---------------------------------------------------------------- drawing */

  updateDraftPreview() {
    const d = this.draft;
    if (!d) return;
    const verts = [d.start, ...d.pts, d.cursor].map((p) => ({ x: p.x, z: p.z }));
    const type = ROAD_TYPES[this.drawType];
    d.verts = [d.start, ...d.pts].map((p) => [p.x, p.z]);
    if (verts.length < 2 || Math.hypot(verts[1].x - verts[0].x, verts[1].z - verts[0].z) < 0.5) { d.preview = null; d.outline = null; return; }
    const al = fitAlignment(verts, { defaultRadius: type.radius });
    const smp = sampleAlignment(al, 0, al.length, { maxStep: 4 });
    const e = layoutEdges(layoutAt(resolveStack({ type: this.drawType }), 0, 1));
    const L = [], R = [], C = [];
    for (let i = 0; i < smp.s.length; i++) {
      const sx = Math.sin(smp.th[i]), sz = -Math.cos(smp.th[i]);
      L.push([smp.x[i] + sx * e.propL, smp.z[i] + sz * e.propL]);
      R.push([smp.x[i] + sx * e.propR, smp.z[i] + sz * e.propR]);
      C.push([smp.x[i], smp.z[i]]);
    }
    const path = new Path2D();
    [...R, ...L.reverse()].forEach((p, i) => (i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1])));
    path.closePath();
    d.preview = C;
    d.outline = path;
    d.length = al.length;
  }

  drawClick(target) {
    if (!this.draft) {
      this.draft = { start: target, pts: [], cursor: target, verts: [] };
      return;
    }
    if (target.kind === "node" || target.kind === "road") {
      if (target.kind === "node" && this.draft.start.kind === "node" && target.id === this.draft.start.id && this.draft.pts.length < 2) return;
      this.finishDraft(target);
      return;
    }
    const last = this.draft.pts[this.draft.pts.length - 1] || this.draft.start;
    if (Math.hypot(last.x - target.x, last.z - target.z) < 1) return;
    this.draft.pts.push({ x: target.x, z: target.z });
  }

  finishDraft(endTarget) {
    const draft = this.draft;
    this.draft = null;
    if (!draft) return;
    const pts = draft.pts.slice();
    let end = endTarget;
    if (!end) {
      if (!pts.length) return;
      const p = pts.pop();
      end = { kind: "free", x: p.x, z: p.z };
    }
    const result = this.result;
    let newEnd = null;
    this.commit((d) => {
      const resolve = (t, other) => {
        if (t.kind === "node") return t.id;
        if (t.kind === "road" && !(other && other.kind === "road" && other.id === t.id)) return splitRoadAt(d, t.id, t.x, t.z, result);
        return addNode(d, t.x, t.z);
      };
      const a = resolve(draft.start, null);
      const b = resolve(end, draft.start);
      if (!a || !b || (a === b && pts.length < 2)) return;
      const id = addRoad(d, a, b, this.drawType, pts);
      newEnd = { road: id, node: b };
    });
    if (newEnd) this.selection = { kind: "road", id: newEnd.road };
    this.panel.refresh();
  }

  /* ---------------------------------------------------------------- input */

  bindInput() {
    const c = this.canvas;
    let pan = null, drag = null, spaceDown = false;
    const pos = (e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("pointerdown", (e) => {
      c.setPointerCapture(e.pointerId);
      const [sx, sy] = pos(e);
      if (e.button === 1 || (e.button === 2 && !this.draft) || spaceDown) {
        pan = { sx, sy, cx: this.renderer.view.cx, cz: this.renderer.view.cz, moved: false };
        return;
      }
      if (e.button === 2 && this.draft) { this.finishDraft(null); this.redraw(); return; }
      if (e.button !== 0) return;
      if (this.tool === "draw") {
        this.drawClick(this.snapPoint(sx, sy, !e.altKey));
        this.updateDraftPreview();
        this.redraw();
        return;
      }
      const hit = this.pick(sx, sy);
      if (hit?.kind === "node" || hit?.kind === "pi") {
        this.selection = hit;
        this.panel.refresh();
        drag = { hit, moved: false, sx, sy };
      } else if (hit?.kind === "road") {
        this.select(hit);
        pan = { sx, sy, cx: this.renderer.view.cx, cz: this.renderer.view.cz, moved: false, keepSel: true };
      } else {
        pan = { sx, sy, cx: this.renderer.view.cx, cz: this.renderer.view.cz, moved: false, clearSel: true };
      }
      this.redraw();
    });

    c.addEventListener("pointermove", (e) => {
      const [sx, sy] = pos(e);
      const [wx, wz] = this.renderer.toWorld(sx, sy);
      if (pan) {
        if (Math.hypot(sx - pan.sx, sy - pan.sy) > 3) pan.moved = true;
        this.renderer.view.cx = pan.cx - (sx - pan.sx) / this.renderer.view.scale;
        this.renderer.view.cz = pan.cz - (sy - pan.sy) / this.renderer.view.scale;
        this.redraw();
        return;
      }
      if (drag) {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        if (!drag.moved) { drag.moved = true; this.beginEdit(); }
        let x = wx, z = wz;
        if (this.gridSnap) { x = Math.round(x / 5) * 5; z = Math.round(z / 5) * 5; }
        const h = drag.hit;
        this.live((d) => {
          if (h.kind === "node") { const n = findNode(d, h.id); n.x = x; n.z = z; }
          else { const p = findRoad(d, h.roadId).pts[h.index]; p.x = x; p.z = z; }
        });
        this.redraw();
        return;
      }
      if (this.draft) {
        const t = this.snapPoint(sx, sy, !e.altKey);
        this.draft.cursor = t;
        this.draft.snap = t.kind !== "free" ? t : null;
        this.updateDraftPreview();
      } else {
        const h = this.pick(sx, sy);
        if (JSON.stringify(h) !== JSON.stringify(this.hover)) { this.hover = h; }
      }
      this.updateReadout(wx, wz);
      this.redraw();
    });

    const up = () => {
      if (pan) {
        if (!pan.moved && pan.clearSel && this.selection) this.select(null);
        pan = null;
      }
      if (drag) {
        if (drag.moved) {
          const h = drag.hit;
          if (h.kind === "node") {
            const n = findNode(this.data, h.id);
            const tol = 10 / this.renderer.view.scale;
            const other = this.data.nodes.find((q) => q.id !== h.id && Math.hypot(q.x - n.x, q.z - n.z) < tol);
            if (other) {
              mergeNodes(this.data, other.id, h.id);
              this.selection = { kind: "node", id: other.id };
            }
          }
          this.endEdit();
        }
        drag = null;
      }
    };
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);

    c.addEventListener("dblclick", (e) => {
      const [sx, sy] = pos(e);
      if (this.tool === "draw") {
        if (this.draft) {
          // The double-click's first click already added a point; finish there.
          this.finishDraft(null);
          this.redraw();
        }
        return;
      }
      const hit = this.pick(sx, sy);
      if (hit?.kind === "road") {
        const [x, z] = this.renderer.toWorld(sx, sy);
        let idx = -1;
        this.commit((d) => { idx = insertPI(d, hit.id, x, z, this.result); });
        if (idx >= 0) this.select({ kind: "pi", roadId: hit.id, index: idx });
      }
    });

    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [sx, sy] = pos(e);
      const v = this.renderer.view;
      const [wx, wz] = this.renderer.toWorld(sx, sy);
      v.scale = Math.min(40, Math.max(0.08, v.scale * Math.exp(-e.deltaY * 0.0015)));
      v.cx = wx - (sx - this.renderer.W / 2) / v.scale;
      v.cz = wz - (sy - this.renderer.H / 2) / v.scale;
      this.redraw();
    }, { passive: false });

    window.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key;
      if (k === " ") { spaceDown = true; e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === "z" || k === "Z")) { e.preventDefault(); if (e.shiftKey) this.redoStep(); else this.undoStep(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === "y" || k === "Y")) { e.preventDefault(); this.redoStep(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === "Escape") {
        if (this.draft) this.draft = null;
        else if (this.selection) this.select(null);
        this.redraw();
      } else if (k === "Enter") {
        if (this.draft) { this.finishDraft(null); this.redraw(); }
      } else if (k === "Delete" || k === "Backspace") {
        if (this.draft) {
          if (this.draft.pts.length) this.draft.pts.pop(); else this.draft = null;
          this.updateDraftPreview();
          this.redraw();
          e.preventDefault();
          return;
        }
        const s = this.selection;
        if (!s) return;
        e.preventDefault();
        this.selection = s.kind === "pi" ? { kind: "road", id: s.roadId } : null;
        this.commit((d) => {
          if (s.kind === "node") deleteNode(d, s.id);
          else if (s.kind === "road") deleteRoad(d, s.id);
          else removePI(d, s.roadId, s.index);
        });
      } else if (k === "v" || k === "V") this.setTool("select");
      else if (k === "r" || k === "R") this.setTool("draw");
      else if (k === "f" || k === "F") this.fitView();
      else if (k === "g" || k === "G") { this.gridSnap = !this.gridSnap; this.panel.build(); }
      else if (k === "t" || k === "T") { this.trafficOn = !this.trafficOn; this.panel.build(); }
      else if (k === "l" || k === "L") { this.renderer.layers.laneGraph = !this.renderer.layers.laneGraph; this.panel.syncLayers(); this.redraw(); }
    });
    window.addEventListener("keyup", (e) => { if (e.key === " ") spaceDown = false; });
  }

  updateReadout(x, z) {
    const loc = this.result.locate(x, z);
    let text = `x ${x.toFixed(1)}  z ${z.toFixed(1)}  ·  ground ${this.ground(x, z).toFixed(1)} m`;
    if (loc?.kind === "road") {
      const lane = loc.lane ? `${loc.lane.type} ${loc.lane.w.toFixed(2)} m` : "edge";
      text += `  ·  ${loc.roadId} ${loc.roadType}  ·  ${lane}  ·  s ${loc.s.toFixed(0)}/${loc.L.toFixed(0)} m  ·  y ${loc.y.toFixed(2)} m  ·  grade ${(loc.grade * 100).toFixed(1)} %`;
      text += Number.isFinite(loc.radius) ? `  ·  R ${loc.radius.toFixed(0)} m  ·  e ${(loc.superelevation * 100).toFixed(1)} %` : "  ·  straight";
    } else if (loc?.kind === "node") {
      text += `  ·  ${loc.nodeId} ${loc.nodeKind}  ·  control ${loc.control}  ·  y ${loc.y.toFixed(2)} m`;
    }
    if (this.draft?.length) text += `  ·  drawing ${this.draft.length.toFixed(0)} m`;
    this.readout.textContent = text;
  }
}
