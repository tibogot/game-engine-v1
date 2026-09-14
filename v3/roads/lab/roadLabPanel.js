// Right-hand panel of the road lab: tools, layers, traffic, the inspector for
// the current selection (road / node / bend point) and the issue list.
//
// Inputs commit on `change` (blur / Enter) so typing a number does not rebuild
// the network per keystroke; sliders and profile drags edit live through
// app.beginEdit / app.live / app.endEdit, which folds a whole drag into ONE
// undo step.

import { ROAD_TYPES, LANE_TYPES, SECTION_PRESETS, makeSection, layoutAt, layoutEdges } from "../roadCrossSection.js";
import { SCENES } from "../roadScenes.js";
import { TERRAINS } from "../roadTerrain.js";
import { COLORS } from "./roadLabRender.js";
import { findRoad, findNode, nodeDegree, reverseRoad, deleteRoad, deleteNode, dissolveNode, removePI, splitRoadAt } from "../roadEdit.js";
import { evalAlignment } from "../roadAlignment.js";

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style") e.style.cssText = v;
    else if (k in e && typeof v !== "string") e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
const opt = (value, label, selected) => el("option", { value, selected: selected ? true : null }, label);
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");

const LANE_SWATCH = {
  driving: COLORS.asphalt, turn: "#2f3238", bus: COLORS.bus, parking: COLORS.parking, bike: COLORS.bike,
  shoulder: COLORS.shoulder, sidewalk: COLORS.sidewalk, verge: COLORS.verge, barrier: COLORS.barrier,
};

export class LabPanel {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.station = 0.5;
    this.build();
  }

  build() {
    const a = this.app;
    this.root.innerHTML = "";
    this.stats = el("div", { class: "stats" });

    const toolBtns = el("div", { class: "seg" },
      el("button", { "data-tool": "select", onclick: () => a.setTool("select") }, "Select  V"),
      el("button", { "data-tool": "draw", onclick: () => a.setTool("draw") }, "Draw road  R"),
    );
    this.toolBtns = toolBtns;
    const typeSel = el("select", { onchange: (e) => (a.drawType = e.target.value) },
      Object.entries(ROAD_TYPES).map(([k, t]) => opt(k, t.label, k === a.drawType)));
    this.typeSel = typeSel;

    const sceneSel = el("select", {}, Object.entries(SCENES).map(([k, s]) => opt(k, s.label)));
    const styleSel = el("select", { onchange: (e) => a.commit((d) => (d.style = e.target.value)) },
      opt("eu", "EU markings", a.data.style !== "us"), opt("us", "US markings", a.data.style === "us"));
    const terrSel = el("select", { onchange: (e) => a.commit((d) => (d.terrain = e.target.value)) },
      Object.entries(TERRAINS).map(([k, t]) => opt(k, t.label, a.data.terrain === k)));
    // Road scale: 1 = real widths; games widen the drivable road (1.2–1.5).
    const scaleIn = el("input", { type: "number", min: 0.5, max: 3, step: 0.05, value: a.data.roadScale ?? 1, title: "Carriage lanes, medians, corner radii and roundabouts. Sidewalks, paint and curves stay real.",
      onchange: (e) => { const v = Math.min(3, Math.max(0.5, +e.target.value || 1)); a.commit((d) => { if (v === 1) delete d.roadScale; else d.roadScale = v; }); } });
    this.styleSel = styleSel; this.terrSel = terrSel; this.scaleIn = scaleIn;
    const fileIn = el("input", { type: "file", accept: ".json,application/json", style: "display:none", onchange: (e) => a.importFile(e.target.files[0]) });

    this.root.append(
      el("h1", {}, "Road Lab", el("span", { class: "tag" }, "lane-based")),
      this.stats,
      el("section", {},
        el("h2", {}, "Tools"),
        toolBtns,
        el("label", { class: "row" }, "New roads", typeSel),
        el("div", { class: "row" },
          el("label", { class: "chk" }, el("input", { type: "checkbox", checked: a.gridSnap, onchange: (e) => (a.gridSnap = e.target.checked) }), "Snap 5 m  G"),
          el("button", { onclick: () => a.fitView() }, "Fit  F"),
        ),
        el("div", { class: "row btns" },
          el("button", { onclick: () => a.undoStep() }, "Undo"),
          el("button", { onclick: () => a.redoStep() }, "Redo"),
          el("button", { onclick: () => a.newNetwork() }, "Clear"),
        ),
      ),
      el("section", {},
        el("h2", {}, "Network"),
        el("div", { class: "row" }, sceneSel, el("button", { onclick: () => a.loadScene(sceneSel.value) }, "Load scene")),
        el("label", { class: "row" }, "Markings", styleSel),
        el("label", { class: "row" }, "Terrain", terrSel),
        el("label", { class: "row" }, "Road scale", scaleIn),
        el("div", { class: "row btns" },
          el("button", { onclick: () => a.exportFile() }, "Export JSON"),
          el("button", { onclick: () => fileIn.click() }, "Import"),
          fileIn,
        ),
      ),
      this.layersSection(),
      this.trafficSection(),
      (this.inspector = el("section", { class: "inspector" })),
      (this.issuesBox = el("section", { class: "issues" })),
    );
    this.refresh();
  }

  layersSection() {
    const a = this.app, L = a.renderer.layers;
    const names = {
      terrain: "Terrain", blocks: "Blocks", lots: "Lots", surface: "Surface", markings: "Markings", props: "Props",
      structures: "Bridges", laneGraph: "Lane graph  L", traffic: "Traffic", construction: "Handles", issues: "Issues", curvature: "Curvature",
    };
    this.layerBoxes = {};
    return el("section", {},
      el("h2", {}, "Layers"),
      el("div", { class: "grid2" }, Object.entries(names).map(([k, label]) => {
        const box = el("input", { type: "checkbox", checked: L[k], onchange: (e) => { L[k] = e.target.checked; a.redraw(); } });
        this.layerBoxes[k] = box;
        return el("label", { class: "chk" }, box, label);
      })),
    );
  }

  trafficSection() {
    const a = this.app;
    const count = el("b", {}, String(a.carCount));
    return el("section", {},
      el("h2", {}, "Traffic"),
      el("div", { class: "row" },
        el("label", { class: "chk" }, el("input", { type: "checkbox", checked: a.trafficOn, onchange: (e) => (a.trafficOn = e.target.checked) }), "Run  T"),
        el("span", {}, "cars ", count),
      ),
      el("input", {
        type: "range", min: 0, max: 800, step: 10, value: a.carCount,
        oninput: (e) => { a.setCarCount(+e.target.value); count.textContent = e.target.value; },
      }),
    );
  }

  syncLayers() {
    for (const [k, b] of Object.entries(this.layerBoxes)) b.checked = this.app.renderer.layers[k];
  }

  refresh({ inspector = true } = {}) {
    const a = this.app, r = a.result;
    if (!r) return;
    const st = r.stats;
    const errs = r.issues.filter((i) => i.level === "error").length;
    const warns = r.issues.filter((i) => i.level === "warn").length;
    this.stats.innerHTML = "";
    this.stats.append(
      el("div", {}, el("b", {}, `${fmt(st.ms, 1)} ms`), " rebuild"),
      el("div", {}, `${st.roads} roads · ${st.junctions} junctions · ${st.roundabouts} roundabouts · ${st.splits} splits`),
      el("div", {}, `${fmt(st.laneKm, 2)} lane-km · ${st.connectors} connectors · ${st.overpasses} overpasses`),
      el("div", {}, `${st.blocks} blocks · ${st.lots} lots · ${st.props} props`),
      el("div", { class: errs ? "bad" : warns ? "warn" : "ok" }, errs ? `${errs} errors, ${warns} warnings` : warns ? `${warns} warnings` : "No problems"),
    );
    for (const b of this.toolBtns.children) b.classList.toggle("on", b.dataset.tool === a.tool);
    this.styleSel.value = a.data.style === "us" ? "us" : "eu";
    this.terrSel.value = a.data.terrain || "flat";
    if (document.activeElement !== this.scaleIn) this.scaleIn.value = a.data.roadScale ?? 1;
    if (inspector) this.renderInspector();
    this.renderIssues();
  }

  /* ---------------------------------------------------------------- issues */

  renderIssues() {
    const a = this.app, r = a.result;
    const box = this.issuesBox;
    box.innerHTML = "";
    const list = r.issues;
    box.append(el("h2", {}, `Issues (${list.length})`));
    if (!list.length) { box.append(el("div", { class: "muted" }, "Nothing to report.")); return; }
    for (const i of list.slice(0, 80)) {
      box.append(el("div", { class: `issue ${i.level}`, onclick: () => a.focusIssue(i) },
        el("span", { class: "dot" }),
        el("span", { class: "msg" }, i.msg),
        i.fix ? el("button", { onclick: (e) => { e.stopPropagation(); a.applyFix(i.fix); } }, i.fix.label) : null,
      ));
    }
  }

  /* ---------------------------------------------------------------- inspector */

  renderInspector() {
    const box = this.inspector;
    box.innerHTML = "";
    const sel = this.app.selection;
    if (!sel) {
      box.append(el("h2", {}, "Inspector"), el("div", { class: "muted" },
        "Click a road, node or bend point. Double-click a road to add a bend point. Draw with R: click to place points, click an existing node or road to connect, double-click or Enter to finish."));
      return;
    }
    if (sel.kind === "road") this.roadInspector(box, sel.id);
    else if (sel.kind === "node") this.nodeInspector(box, sel.id);
    else if (sel.kind === "pi") this.piInspector(box, sel.roadId, sel.index);
  }

  roadInspector(box, id) {
    const a = this.app;
    const road = findRoad(a.data, id);
    const rr = a.result.roadsById.get(id);
    if (!road || !rr) return;
    const type = ROAD_TYPES[road.type] || ROAD_TYPES.local;
    const laneCount = (side) => rr.stack.sides[side].filter((l) => LANE_TYPES[l.type]?.drive && !l.added).length;
    box.append(
      el("h2", {}, `Road ${id}`),
      el("div", { class: "sub" },
        `${type.label} · ${fmt(rr.L, 0)} m · ${laneCount("right")}+${laneCount("left")} lanes · `,
        `min R ${Number.isFinite(rr.minRadius) ? fmt(rr.minRadius, 0) + " m" : "straight"} · max grade ${fmt(Math.abs(rr.prof.maxGrade) * 100, 1)} %`,
        rr.bridges.length ? ` · ${rr.bridges.length} bridge` : "",
      ),
      el("label", { class: "row" }, "Type",
        el("select", { onchange: (e) => a.commit((d) => { const r = findRoad(d, id); r.type = e.target.value; delete r.lanes; }) },
          Object.entries(ROAD_TYPES).map(([k, t]) => opt(k, t.label, k === road.type)))),
      el("label", { class: "row" }, "Default bend radius",
        el("input", {
          type: "number", min: 1, step: 5, value: road.radius ?? "", placeholder: String(type.radius),
          onchange: (e) => a.commit((d) => { const r = findRoad(d, id); if (e.target.value === "") delete r.radius; else r.radius = +e.target.value; }),
        })),
    );

    // Cross-section preview.
    const cs = el("canvas", { class: "xsec", width: 600, height: 150 });
    const slider = el("input", { type: "range", min: 0, max: 1, step: 0.001, value: this.station });
    const stLabel = el("span", { class: "muted" });
    const drawX = () => {
      const s = rr.s0 + (rr.s1 - rr.s0) * this.station;
      stLabel.textContent = `at ${fmt(s, 0)} m`;
      drawCrossSection(cs, rr, s);
      const e = evalAlignment(rr.al, s);
      const ed = layoutEdges(layoutAt(rr.stack, s, rr.L));
      const P = (t) => [e.x + Math.sin(e.th) * t, e.z - Math.cos(e.th) * t];
      a.stationMarker = [P(ed.propL + 2), P(ed.propR - 2)];
      a.redraw();
    };
    slider.addEventListener("input", () => { this.station = +slider.value; drawX(); });
    box.append(el("h3", {}, "Cross-section ", stLabel), cs, slider);
    drawX();

    // Lanes.
    box.append(el("h3", {}, "Lanes"));
    if (!road.lanes) {
      box.append(el("div", { class: "row" },
        el("span", { class: "muted" }, `Using the ${type.label} stack`),
        el("button", { onclick: () => a.commit((d) => { const r = findRoad(d, id); r.lanes = structuredClone({ center: type.center, left: type.left, right: type.right }); }) }, "Customize")));
    } else {
      const L = road.lanes;
      const table = el("div", { class: "lanes" });
      const laneRow = (side, idx) => {
        const lane = L[side][idx];
        return el("div", { class: "lane" },
          el("span", { class: `side ${side}` }, side === "left" ? "L" : "R"),
          el("span", { class: "sw", style: `background:${LANE_SWATCH[lane.type] || "#999"}` }),
          el("select", { onchange: (e) => a.commit((d) => (findRoad(d, id).lanes[side][idx].type = e.target.value)) },
            Object.entries(LANE_TYPES).map(([k, t]) => opt(k, t.label, k === lane.type))),
          el("input", { type: "number", min: 0.3, max: 12, step: 0.05, value: lane.width, onchange: (e) => a.commit((d) => (findRoad(d, id).lanes[side][idx].width = Math.max(0.3, +e.target.value))) }),
          el("button", { class: "x", title: "Remove lane", onclick: () => a.commit((d) => findRoad(d, id).lanes[side].splice(idx, 1)) }, "×"),
        );
      };
      const add = (side, where) => el("button", {
        class: "add",
        onclick: () => a.commit((d) => {
          const arr = findRoad(d, id).lanes[side];
          const lane = { type: "driving", width: 3.25 };
          if (where === "inner") arr.unshift(lane); else arr.push(lane);
        }),
      }, `+ ${side} ${where}`);
      table.append(el("div", { class: "row btns" }, add("left", "outer")));
      for (let i = L.left.length - 1; i >= 0; i--) table.append(laneRow("left", i));
      table.append(el("div", { class: "row btns" }, add("left", "inner"), add("right", "inner")));
      table.append(el("div", { class: "lane center" },
        el("span", { class: "side" }, "C"),
        el("select", { onchange: (e) => a.commit((d) => (findRoad(d, id).lanes.center.kind = e.target.value)) },
          [["none", "No centre line"], ["line", "Centre line"], ["painted", "Painted median"], ["raised", "Raised median"], ["barrier", "Barrier"]]
            .map(([k, lbl]) => opt(k, lbl, (L.center?.kind || "line") === k))),
        el("input", { type: "number", min: 0, max: 30, step: 0.1, value: L.center?.width ?? 0, onchange: (e) => a.commit((d) => { const r = findRoad(d, id); r.lanes.center = { ...(r.lanes.center || {}), width: Math.max(0, +e.target.value) }; }) }),
      ));
      for (let i = 0; i < L.right.length; i++) table.append(laneRow("right", i));
      table.append(el("div", { class: "row btns" }, add("right", "outer"),
        el("button", { onclick: () => a.commit((d) => delete findRoad(d, id).lanes) }, "Reset to type")));
      box.append(table);
    }

    // Sections.
    box.append(el("h3", {}, "Sections"));
    (road.sections || []).forEach((sec, i) => {
      const upd = (k) => (e) => a.commit((d) => (findRoad(d, id).sections[i][k] = Math.max(0, +e.target.value)));
      box.append(el("div", { class: "section-row" },
        el("span", {}, `${SECTION_PRESETS[sec.kind]?.label || sec.kind} · ${sec.from}`),
        el("label", {}, "d", el("input", { type: "number", min: 0, step: 5, value: sec.d, onchange: upd("d") })),
        el("label", {}, "taper", el("input", { type: "number", min: 1, step: 5, value: sec.taper, onchange: upd("taper") })),
        el("button", { class: "x", onclick: () => a.commit((d) => findRoad(d, id).sections.splice(i, 1)) }, "×"),
      ));
    });
    const pSel = el("select", {}, Object.entries(SECTION_PRESETS).map(([k, p]) => opt(k, p.label)));
    const endSel = el("select", {}, opt("end", "at end (b)"), opt("start", "at start (a)"));
    box.append(el("div", { class: "row" }, pSel, endSel,
      el("button", {
        onclick: () => a.commit((d) => {
          const r = findRoad(d, id);
          r.sections = r.sections || [];
          const sid = `s${Date.now().toString(36)}`;
          r.sections.push(makeSection(pSel.value, endSel.value, sid, { oneWay: !!ROAD_TYPES[r.type]?.oneWay }));
        }),
      }, "Add")));

    // Profile.
    const prof = road.profile || { mode: "terrain" };
    box.append(el("h3", {}, "Elevation profile"),
      el("label", { class: "row" }, "Mode",
        el("select", { onchange: (e) => a.commit((d) => { const r = findRoad(d, id); r.profile = { ...(r.profile || {}), mode: e.target.value, vpis: r.profile?.vpis || [] }; }) },
          opt("terrain", "Follow terrain (grade-limited)", prof.mode === "terrain"),
          opt("linear", "Straight grade", prof.mode === "linear"),
          opt("design", "Design (vertical PIs)", prof.mode === "design"))));
    const pc = el("canvas", { class: "profile", width: 600, height: 260 });
    box.append(pc);
    if (prof.mode === "design") box.append(el("div", { class: "muted" }, "Click to add a vertical PI, drag to move, right-click to remove. The curve passes below a crest PI."));
    this.bindProfile(pc, id);

    box.append(el("div", { class: "row btns" },
      el("button", { onclick: () => a.commit((d) => reverseRoad(d, id)) }, "Reverse"),
      el("button", { onclick: () => { const mid = evalAlignment(rr.al, rr.L / 2); a.commit((d) => splitRoadAt(d, id, mid.x, mid.z, a.result)); } }, "Split in middle"),
      el("button", { class: "danger", onclick: () => { a.selection = null; a.commit((d) => deleteRoad(d, id)); } }, "Delete"),
    ));
  }

  bindProfile(canvas, id) {
    const a = this.app;
    const draw = () => {
      const rr = a.result.roadsById.get(id);
      if (rr) drawProfile(canvas, rr, findRoad(a.data, id));
    };
    draw();
    const toData = (ev) => {
      const rr = a.result.roadsById.get(id);
      const r = canvas.getBoundingClientRect();
      const u = (ev.clientX - r.left) / r.width, v = (ev.clientY - r.top) / r.height;
      const m = canvas._map;
      return { u: Math.min(0.995, Math.max(0.005, (u * canvas.width - m.padL) / m.w)), y: m.y1 - ((v * canvas.height - m.padT) / m.h) * (m.y1 - m.y0), rr };
    };
    let drag = -1;
    canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());
    canvas.addEventListener("pointerdown", (ev) => {
      const road = findRoad(a.data, id);
      if (road.profile?.mode !== "design") return;
      const p = toData(ev);
      const vpis = road.profile.vpis || [];
      const m = canvas._map;
      const hit = vpis.findIndex((q) => Math.abs((q.u - p.u) * m.w) < 14 && Math.abs(((q.y - p.y) / (m.y1 - m.y0)) * m.h) < 14);
      if (ev.button === 2) {
        if (hit >= 0) a.commit((d) => findRoad(d, id).profile.vpis.splice(hit, 1), { inspector: false });
        draw();
        return;
      }
      a.beginEdit();
      if (hit >= 0) drag = hit;
      else {
        a.live((d) => { const r = findRoad(d, id); r.profile.vpis = [...(r.profile.vpis || []), { u: p.u, y: Math.round(p.y * 10) / 10, L: 60 }]; });
        drag = findRoad(a.data, id).profile.vpis.length - 1;
      }
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (drag < 0) return;
      const p = toData(ev);
      a.live((d) => { const q = findRoad(d, id).profile.vpis[drag]; q.u = p.u; q.y = Math.round(p.y * 10) / 10; });
      requestAnimationFrame(draw);
    });
    const end = () => {
      if (drag < 0) return;
      drag = -1;
      a.endEdit({ inspector: false });
      draw();
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (ev) => {
      const road = findRoad(a.data, id);
      if (road.profile?.mode !== "design") return;
      const p = toData(ev);
      const m = canvas._map;
      const hit = (road.profile.vpis || []).findIndex((q) => Math.abs((q.u - p.u) * m.w) < 16);
      if (hit < 0) return;
      ev.preventDefault();
      a.commit((d) => { const q = findRoad(d, id).profile.vpis[hit]; q.L = Math.max(0, Math.min(800, (q.L ?? 60) * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))); }, { inspector: false });
      draw();
    }, { passive: false });
    this._profileRedraw = draw;
  }

  nodeInspector(box, id) {
    const a = this.app;
    const node = findNode(a.data, id);
    const bn = a.result.nodesById.get(id);
    if (!node || !bn) return;
    const deg = nodeDegree(a.data, id);
    const set = (fn) => a.commit((d) => fn(findNode(d, id)));
    box.append(
      el("h2", {}, `Node ${id}`),
      el("div", { class: "sub" }, `${bn.kind} · ${deg} road${deg === 1 ? "" : "s"} · control ${bn.control || "none"} · y ${fmt(bn.y, 1)} m`),
      el("label", { class: "row" }, "Kind",
        el("select", { onchange: (e) => set((n) => { if (e.target.value === "auto") delete n.kind; else n.kind = e.target.value; }) },
          opt("auto", `Auto (${bn.kind})`, !node.kind), opt("junction", "Junction", node.kind === "junction"),
          opt("roundabout", "Roundabout", node.kind === "roundabout"), opt("split", "Split / merge", node.kind === "split"))),
      el("label", { class: "row" }, "Elevation",
        el("input", { type: "number", step: 0.5, value: node.y ?? "", placeholder: `terrain ${fmt(bn.y, 1)}`, onchange: (e) => set((n) => { if (e.target.value === "") delete n.y; else n.y = +e.target.value; }) })),
    );
    if (bn.kind === "junction" || bn.kind === "roundabout") {
      box.append(
        el("label", { class: "row" }, bn.kind === "roundabout" ? "Entry radius" : "Corner radius",
          el("input", { type: "number", min: 0, step: 0.5, value: node.radius ?? "", placeholder: "auto", onchange: (e) => set((n) => { if (e.target.value === "") delete n.radius; else n.radius = Math.max(0, +e.target.value); }) })),
        el("label", { class: "row" }, "Control",
          el("select", { onchange: (e) => set((n) => { if (e.target.value === "auto") delete n.control; else n.control = e.target.value; }) },
            ["auto", "signal", "allstop", "stop", "yield", "none"].map((k) => opt(k, k === "auto" ? `Auto (${bn.control})` : k, (node.control || "auto") === k)))),
        el("label", { class: "chk" }, el("input", { type: "checkbox", checked: node.crosswalks !== false, onchange: (e) => set((n) => { if (e.target.checked) delete n.crosswalks; else n.crosswalks = false; }) }), "Crosswalks"),
      );
    }
    if (bn.kind === "roundabout") {
      box.append(
        el("label", { class: "row" }, "Ring radius",
          el("input", { type: "number", min: 8, step: 1, value: node.ring?.radius ?? "", placeholder: fmt(bn.ring?.Ro, 1), onchange: (e) => set((n) => { n.ring = { ...(n.ring || {}) }; if (e.target.value === "") delete n.ring.radius; else n.ring.radius = +e.target.value; }) })),
        el("label", { class: "row" }, "Ring lanes",
          el("select", { onchange: (e) => set((n) => { n.ring = { ...(n.ring || {}) }; if (e.target.value === "auto") delete n.ring.lanes; else n.ring.lanes = +e.target.value; }) },
            opt("auto", `Auto (${bn.ring?.lanes})`, node.ring?.lanes == null), opt("1", "1", node.ring?.lanes === 1), opt("2", "2", node.ring?.lanes === 2))),
      );
    }
    if (bn.kind === "split") {
      box.append(el("label", { class: "row" }, "Trunk road",
        el("select", { onchange: (e) => set((n) => { if (e.target.value === "auto") delete n.trunk; else n.trunk = e.target.value; }) },
          opt("auto", `Auto (${bn.split?.trunk.road.id})`, !node.trunk),
          bn.arms.map((arm) => opt(arm.road.id, `${arm.road.id} · ${arm.type.label}`, node.trunk === arm.road.id)))));
    }
    box.append(el("h3", {}, "Arms"));
    for (const arm of bn.arms) {
      box.append(el("div", { class: "arm", onclick: () => a.select({ kind: "road", id: arm.road.id }) },
        `${arm.road.id} · ${arm.type.label} · trim ${fmt(arm.trim, 1)} m · ${arm.approach.length} in / ${arm.depart.length} out · ${arm.control}`));
    }
    box.append(el("div", { class: "row btns" },
      deg === 2 ? el("button", { onclick: () => { a.selection = null; a.commit((d) => dissolveNode(d, id)); } }, "Dissolve into bend") : null,
      el("button", { class: "danger", onclick: () => { a.selection = null; a.commit((d) => deleteNode(d, id)); } }, "Delete node"),
    ));
  }

  piInspector(box, roadId, index) {
    const a = this.app;
    const road = findRoad(a.data, roadId);
    const rr = a.result.roadsById.get(roadId);
    const p = road?.pts[index];
    if (!p || !rr) return;
    const type = ROAD_TYPES[road.type] || ROAD_TYPES.local;
    const v = rr.al.vertices.filter((q) => !q.virtual).find((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.01);
    const set = (fn) => a.commit((d) => fn(findRoad(d, roadId).pts[index]), { inspector: true });
    const radius = el("input", { type: "range", min: 0, max: 1, step: 0.001, value: Math.log((p.r ?? road.radius ?? type.radius) / 3) / Math.log(1500 / 3) });
    const rLabel = el("b", {}, fmt(p.r ?? road.radius ?? type.radius, 0));
    radius.addEventListener("pointerdown", () => a.beginEdit());
    radius.addEventListener("input", () => {
      const r = Math.round(3 * Math.pow(1500 / 3, +radius.value));
      rLabel.textContent = r;
      a.live((d) => (findRoad(d, roadId).pts[index].r = r));
    });
    radius.addEventListener("change", () => a.endEdit({ inspector: true }));
    box.append(
      el("h2", {}, "Bend point"),
      el("div", { class: "sub" }, `road ${roadId} · point ${index + 1} of ${road.pts.length}`),
      el("label", { class: "row" }, "Radius ", rLabel, " m"),
      radius,
      el("label", { class: "row" }, "Radius (exact)",
        el("input", { type: "number", min: 1, step: 1, value: p.r ?? "", placeholder: `road default ${road.radius ?? type.radius}`, onchange: (e) => set((q) => { if (e.target.value === "") delete q.r; else q.r = Math.max(1, +e.target.value); }) })),
      el("label", { class: "row" }, "Transition spiral",
        el("input", { type: "number", min: 0, step: 5, value: p.ls ?? "", placeholder: type.spirals ? "auto" : "none", onchange: (e) => set((q) => { if (e.target.value === "") delete q.ls; else q.ls = Math.max(0, +e.target.value); }) })),
    );
    if (v) {
      box.append(el("div", { class: "facts" },
        el("div", {}, `Used radius ${fmt(v.R, 1)} m${v.clamped ? " (cut to fit)" : ""}`),
        el("div", {}, `Deflection ${fmt((Math.abs(v.delta) * 180) / Math.PI, 1)}° ${v.delta > 0 ? "right" : "left"}`),
        el("div", {}, `Spiral ${fmt(v.Ls, 1)} m · tangent ${fmt(v.T, 1)} m · curve ${fmt(v.sST - v.sTS, 1)} m`),
      ));
    }
    box.append(el("div", { class: "row btns" },
      el("button", { onclick: () => a.select({ kind: "road", id: roadId }) }, "Back to road"),
      el("button", { class: "danger", onclick: () => { a.selection = { kind: "road", id: roadId }; a.commit((d) => removePI(d, roadId, index)); } }, "Delete point"),
    ));
  }
}

/* ------------------------------------------------------------------ drawings */

export function drawCrossSection(canvas, rr, s) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const lay = layoutAt(rr.stack, s, rr.L);
  const ed = layoutEdges(lay);
  const span = ed.propL - ed.propR;
  const pad = 16;
  const k = (W - pad * 2) / Math.max(span, 1);
  const X = (t) => pad + (ed.propL - t) * k;
  const y0 = 38, y1 = H - 34;
  const lanes = [...lay.left.slice().reverse(), ...lay.right];
  for (const l of lanes) {
    if (!l.present) continue;
    const xa = X(Math.max(l.tIn, l.tOut)), xb = X(Math.min(l.tIn, l.tOut));
    const raised = LANE_TYPES[l.type]?.roadside;
    ctx.fillStyle = LANE_SWATCH[l.type] || "#999";
    ctx.fillRect(xa, raised ? y0 - 6 : y0, xb - xa, y1 - y0 + (raised ? 6 : 0));
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "22px system-ui";
    ctx.textAlign = "center";
    if (xb - xa > 48) ctx.fillText(l.w.toFixed(2), (xa + xb) / 2, H - 12);
    if (LANE_TYPES[l.type]?.drive && xb - xa > 22) {
      const up = l.tIn < 0 || (l.tIn === 0 && l.tOut < 0);
      ctx.fillStyle = "#fff";
      ctx.font = "22px system-ui";
      ctx.fillText(up ? "↑" : "↓", (xa + xb) / 2, (y0 + y1) / 2 + 8);
    }
    if (l.turn) { ctx.font = "20px system-ui"; ctx.fillText(l.turn, (xa + xb) / 2, y0 + 16); }
  }
  if (lay.cw > 0.05) {
    ctx.fillStyle = rr.stack.center.kind === "raised" ? COLORS.medianGrass : rr.stack.center.kind === "barrier" ? COLORS.raised : "#565a61";
    ctx.fillRect(X(lay.cw / 2), y0 - 6, lay.cw * k, y1 - y0 + 6);
  }
  ctx.fillStyle = "#c9d3da";
  ctx.font = "22px system-ui";
  ctx.textAlign = "left";
  ctx.fillText(`${span.toFixed(1)} m property · ${(ed.curbL - ed.curbR).toFixed(1)} m curb to curb`, pad, 20);
}

export function drawProfile(canvas, rr, road) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const P = rr.prof;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < P.s.length; i++) { y0 = Math.min(y0, P.y[i], P.ground[i]); y1 = Math.max(y1, P.y[i], P.ground[i]); }
  for (const v of road?.profile?.vpis || []) { y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y); }
  const padL = 44, padR = 12, padT = 16, padB = 30;
  if (y1 - y0 < 8) { const m = (y0 + y1) / 2; y0 = m - 4; y1 = m + 4; }
  y0 -= 2; y1 += 2;
  const w = W - padL - padR, h = H - padT - padB;
  canvas._map = { padL, padT, w, h, y0, y1 };
  const X = (s) => padL + (s / rr.L) * w;
  const Y = (y) => padT + (1 - (y - y0) / (y1 - y0)) * h;
  ctx.fillStyle = "#1a2026"; ctx.fillRect(0, 0, W, H);
  for (const b of rr.bridges) { ctx.fillStyle = "rgba(120,160,255,0.12)"; ctx.fillRect(X(b.s0), padT, X(b.s1) - X(b.s0), h); }
  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
  ctx.fillStyle = "#7d8b96"; ctx.font = "22px system-ui"; ctx.textAlign = "right";
  const step = Math.max(1, Math.round((y1 - y0) / 4));
  for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
    ctx.beginPath(); ctx.moveTo(padL, Y(y)); ctx.lineTo(W - padR, Y(y)); ctx.stroke();
    ctx.fillText(`${y}`, padL - 6, Y(y) + 5);
  }
  ctx.beginPath();
  ctx.moveTo(X(0), H - padB);
  for (let i = 0; i < P.s.length; i++) ctx.lineTo(X(P.s[i]), Y(P.ground[i]));
  ctx.lineTo(X(rr.L), H - padB);
  ctx.fillStyle = "rgba(150,120,80,0.45)"; ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < P.s.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(P.s[i]), Y(P.y[i]));
  ctx.strokeStyle = "#4fb0ff"; ctx.lineWidth = 3; ctx.stroke();
  if (road?.profile?.mode === "design") {
    const vp = [{ u: 0, y: P.y[0] }, ...(road.profile.vpis || []).slice().sort((p, q) => p.u - q.u), { u: 1, y: P.y[P.y.length - 1] }];
    ctx.setLineDash([6, 5]); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); vp.forEach((v, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, X(v.u * rr.L), Y(v.y))); ctx.stroke();
    ctx.setLineDash([]);
    for (const v of road.profile.vpis || []) {
      ctx.fillStyle = "#ffb02e";
      ctx.beginPath(); ctx.arc(X(v.u * rr.L), Y(v.y), 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffe2b0"; ctx.textAlign = "center";
      ctx.fillText(`L ${Math.round(v.L ?? 60)}`, X(v.u * rr.L), Y(v.y) - 12);
    }
  }
  ctx.fillStyle = "#c9d3da"; ctx.textAlign = "left"; ctx.font = "22px system-ui";
  ctx.fillText(`${rr.L.toFixed(0)} m · max grade ${(Math.abs(P.maxGrade) * 100).toFixed(1)} % (limit ${(rr.type.maxGrade * 100).toFixed(0)} %)`, padL, H - 9);
}
