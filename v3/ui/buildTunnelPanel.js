/**
 * v3/ui/buildTunnelPanel.js — Tunnel mode inspector (tunnels and caves).
 *
 * Tunnels first (count, new, delete), then the selected node's floor height,
 * then the active tunnel's cross-section and look. Widget helpers are a
 * per-file copy, matching the convention in every other v3 panel.
 */

const _arrowSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="section-arrow"><polyline points="6 9 12 15 18 9"></polyline></svg>';
const _checkSvg =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

function _fmt(v, step) {
  if (step >= 1) return String(Math.round(v));
  const d = Math.max(0, -Math.floor(Math.log10(step)));
  return Number(v).toFixed(d);
}

function _clampSnap(v, min, max, step) {
  if (!Number.isFinite(v)) return min;
  const n = Math.round((v - min) / step);
  let out = min + n * step;
  const stepStr = String(step);
  if (stepStr.includes(".")) out = Number(out.toFixed(stepStr.split(".")[1].length));
  return Math.min(max, Math.max(min, out));
}

function _section(parent, title, expanded = true) {
  const sec = document.createElement("div");
  sec.className = "inspector-section";
  const hdr = document.createElement("div");
  hdr.className = "section-header" + (expanded ? "" : " collapsed");
  hdr.setAttribute("data-toggle", "");
  hdr.innerHTML = _arrowSvg + " " + title;
  const body = document.createElement("div");
  body.className = "section-body" + (expanded ? "" : " hidden");
  hdr.addEventListener("click", () => {
    hdr.classList.toggle("collapsed");
    body.classList.toggle("hidden");
  });
  sec.appendChild(hdr);
  sec.appendChild(body);
  parent.appendChild(sec);
  return body;
}

function _slider(parent, obj, key, opts) {
  const { label, min, max, step = 0.01, onChange, hint } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  const cur = obj[key];
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-slider-wrap"><input type="range" class="prop-slider" min="${min}" max="${max}" step="${step}" value="${cur}"><input type="number" class="prop-num-input" min="${min}" max="${max}" step="${step}" value="${_fmt(cur, step)}"></div></div>`;
  const sl = row.querySelector(".prop-slider");
  const num = row.querySelector(".prop-num-input");
  const syncNum = () => { num.value = _fmt(obj[key], step); };
  sl.addEventListener("input", () => {
    obj[key] = _clampSnap(parseFloat(sl.value), min, max, step);
    syncNum();
    onChange?.();
  });
  num.addEventListener("change", () => {
    const v = parseFloat(num.value);
    if (!Number.isFinite(v)) { syncNum(); return; }
    obj[key] = _clampSnap(v, min, max, step);
    sl.value = String(obj[key]);
    syncNum();
    onChange?.();
  });
  parent.appendChild(row);
}

function _color(parent, obj, key, opts) {
  const { label, onChange } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><div class="prop-color-wrap"><input type="color" class="prop-color" value="${obj[key]}"><span class="prop-slider-val" style="width:auto">${obj[key]}</span></div></div>`;
  const inp = row.querySelector(".prop-color");
  const hex = row.querySelector(".prop-slider-val");
  inp.addEventListener("input", () => {
    obj[key] = inp.value;
    hex.textContent = inp.value;
    onChange?.();
  });
  parent.appendChild(row);
}

function _toggle(parent, obj, key, opts) {
  const { label, onChange, hint } = opts;
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><button type="button" class="prop-toggle ${obj[key] ? "checked" : ""}">${_checkSvg}</button></div>`;
  const btn = row.querySelector(".prop-toggle");
  btn.addEventListener("click", () => {
    obj[key] = !obj[key];
    btn.classList.toggle("checked", obj[key]);
    onChange?.();
  });
  parent.appendChild(row);
}

function _button(parent, opts) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "prop-action-btn";
  btn.textContent = opts.title;
  if (opts.hint) btn.title = opts.hint;
  btn.addEventListener("click", opts.onClick);
  parent.appendChild(btn);
}

function _hint(parent, text) {
  const p = document.createElement("div");
  p.className = "prop-row";
  p.style.cssText = "opacity:0.65;font-size:11px;line-height:1.4;display:block";
  p.textContent = text;
  parent.appendChild(p);
}

function _choice(parent, label, options, current, onPick, hint) {
  const row = document.createElement("div");
  row.className = "prop-row";
  if (hint) row.title = hint;
  row.innerHTML = `<span class="prop-label">${label}</span><div class="prop-value"><select class="prop-dropdown">${options
    .map(([v, t]) => `<option value="${v}"${v === current ? " selected" : ""}>${t}</option>`).join("")}</select></div>`;
  row.querySelector("select").addEventListener("change", (e) => onPick(e.target.value));
  parent.appendChild(row);
}

const STYLE_OPTIONS = [["tunnel", "Tunnel"], ["cave", "Cave"]];

/**
 * @param {object} app
 * @param {import("../tools/tunnelSystem.js").TunnelSystem} app.tunnelSystem
 * @param {number} app.maxHeight
 * @param {{ TUNNEL_DEFAULTS: object, CAVE_DEFAULTS: object }} app.defaults
 * @returns {{ refresh: () => void }}
 */
export function buildTunnelPanel(app) {
  const panel = document.getElementById("tunnel-panel");
  if (!panel) return { refresh: () => {} };

  function refresh() {
    panel.innerHTML = "";
    const sys = app.tunnelSystem;
    const p = sys.params;
    sys.syncSelectionToState();
    const count = sys.tunnels.length;
    const active = sys.activeTunnel;

    // ── Tunnels ─────────────────────────────────────────────────────────────
    const ts = _section(panel, `Tunnels & caves (${count})`, true);
    _hint(ts, "Click the ground at one mouth, then at the other (or close the far end for a cave with one entrance). End nodes set the floor height at each mouth; nodes in between follow a straight grade unless you set their floor. Size a node up to make a chamber. Alt+click inserts a node, drag moves it, Delete removes it. The terrain opens by itself wherever the ground passes through.");
    if (count > 1) {
      const pick = { i: Math.max(0, sys.activeIndex) };
      _slider(ts, pick, "i", {
        label: "Active", min: 0, max: count - 1, step: 1,
        onChange: () => { sys.setActiveIndex(pick.i); refresh(); },
      });
    }
    if (active) {
      const len = active._sampled?.length ?? 0;
      _hint(ts, `${active.style === "cave" ? "Cave" : "Tunnel"} · ${active.nodes.length} node${active.nodes.length === 1 ? "" : "s"}`
        + (len ? ` · ${len.toFixed(0)} m long` : " · add a second node"));
    }
    _button(ts, {
      title: "New tunnel",
      hint: "Clicks then start a separate tunnel.",
      onClick: () => { setNewStyle("tunnel"); sys.startNewTunnel(); refresh(); },
    });
    _button(ts, {
      title: "New cave",
      hint: "Clicks then start a separate cave (rough walls).",
      onClick: () => { setNewStyle("cave"); sys.startNewTunnel(); refresh(); },
    });
    if (active) {
      _button(ts, { title: "Delete active", onClick: () => { sys.deleteActiveTunnel(); refresh(); } });
    }

    // ── Selected node ───────────────────────────────────────────────────────
    const sel = sys._selectedNode();
    if (sel) {
      const isEnd = (sel.nodeIdx === 0 && !sel.tunnel.closedStart)
        || (sel.nodeIdx === sel.tunnel.nodes.length - 1 && !sel.tunnel.closedEnd);
      const nd = _section(panel, `Selected node (${sel.nodeIdx + 1}/${sel.tunnel.nodes.length})`, true);
      _slider(nd, p, "selFloor", {
        label: "Floor height (m)", min: -50, max: app.maxHeight, step: 0.1,
        onChange: () => sys.setSelectedFloor(p.selFloor),
        hint: isEnd ? "Floor height at this mouth." : "Setting this pins the node (gold). A closed end is not a mouth, so it follows the floor too.",
      });
      _slider(nd, p, "selScale", {
        label: "Size", min: 0.3, max: 6, step: 0.05,
        onChange: () => sys.setSelectedScale(p.selScale),
        hint: "Multiplies the width and height around this node, easing to its neighbours. 2–4 on a middle node makes a chamber.",
      });
      if (!isEnd) {
        _hint(nd, sel.node.pinned ? "PINNED — holds this floor height." : "Follows the grade between its neighbours.");
        if (sel.node.pinned) {
          _button(nd, { title: "Follow the grade (un-pin)", onClick: () => { sys.releaseSelectedFloor(); refresh(); } });
        }
      } else {
        _hint(nd, "End node: dragging it puts the mouth's floor on the ground where you drop it.");
      }
    }

    // ── Active tunnel shape ─────────────────────────────────────────────────
    if (active) {
      const sc = _section(panel, "Shape", true);
      _choice(sc, "Style", STYLE_OPTIONS, active.style, (v) => { sys.setActiveStyle(v); refresh(); },
        "Tunnel: clean arch. Cave: rough, uneven rock walls (the floor stays walkable).");
      const onSection = () => sys.setActiveSection({ width: p.selWidth, height: p.selHeight, thickness: p.selThickness });
      _slider(sc, p, "selWidth", { label: "Width (m)", min: 2, max: 30, step: 0.5, onChange: onSection });
      _slider(sc, p, "selHeight", {
        label: "Height (m)", min: 1, max: 30, step: 0.5, onChange: onSection,
        hint: "Floor to the top of the arch. Never less than half the width (a half circle).",
      });
      _slider(sc, p, "selThickness", { label: "Wall (m)", min: 0.2, max: 5, step: 0.1, onChange: onSection });
      if (active.style === "cave") {
        _slider(sc, p, "selRoughness", {
          label: "Roughness (m)", min: 0, max: 3, step: 0.05,
          onChange: () => sys.setActiveRoughness(p.selRoughness),
          hint: "How far the rock bulges out of the smooth shape. Fades out at open mouths so the entrance meets the ground cleanly.",
        });
      }
      _toggle(sc, p, "selClosedStart", {
        label: "Close first end",
        onChange: () => { sys.setActiveClosed({ start: p.selClosedStart }); refresh(); },
        hint: "Ends the tunnel in a rounded dead end instead of an opening.",
      });
      _toggle(sc, p, "selClosedEnd", {
        label: "Close last end",
        onChange: () => { sys.setActiveClosed({ end: p.selClosedEnd }); refresh(); },
        hint: "Ends the tunnel in a rounded dead end instead of an opening.",
      });
      _button(sc, { title: "Raise 1 m", onClick: () => { sys.nudgeActiveTunnel(1); refresh(); } });
      _button(sc, { title: "Lower 1 m", onClick: () => { sys.nudgeActiveTunnel(-1); refresh(); } });

      // ── Entrances ─────────────────────────────────────────────────────────
      const en = _section(panel, "Entrances", false);
      _hint(en, "Dig in: the mouth drops below the ground and a ramp cutting leads down to it, so a tunnel can start on flat ground. Only for open ends.");
      if (!active.closedStart) {
        _toggle(en, p, "selDigStart", { label: "Dig in first end", onChange: () => { sys.setActiveOptions({ digStart: p.selDigStart }); refresh(); } });
      }
      if (!active.closedEnd) {
        _toggle(en, p, "selDigEnd", { label: "Dig in last end", onChange: () => { sys.setActiveOptions({ digEnd: p.selDigEnd }); refresh(); } });
      }
      if ((active.digStart && !active.closedStart) || (active.digEnd && !active.closedEnd)) {
        _slider(en, p, "selCutCover", {
          label: "Cover (m)", min: 0, max: 20, step: 0.1,
          onChange: () => sys.setActiveOptions({ cutCover: p.selCutCover }),
          hint: "Ground left over the arch at the portal. More cover = deeper mouth and a longer ramp.",
        });
        _slider(en, p, "selCutLength", {
          label: "Ramp length (m)", min: 0, max: 200, step: 1,
          onChange: () => sys.setActiveOptions({ cutLength: p.selCutLength }),
          hint: "0 = automatic (a 20% grade).",
        });
        _slider(en, p, "selCutSlope", {
          label: "Wall slope", min: 0, max: 3, step: 0.05,
          onChange: () => sys.setActiveOptions({ cutSlope: p.selCutSlope }),
          hint: "Metres the side walls lean out per metre of height. 0 = vertical.",
        });
      }

      // ── Lighting ──────────────────────────────────────────────────────────
      const li = _section(panel, "Lighting", false);
      _hint(li, "Baked into the rock, so it costs nothing to render. It lights the tunnel's own walls and floor; characters inside are lit by the scene as usual.");
      _toggle(li, p, "selLamps", { label: "Lamps", onChange: () => { sys.setActiveOptions({ lamps: p.selLamps }); refresh(); } });
      if (active.lamps) {
        _slider(li, p, "selLampSpacing", { label: "Spacing (m)", min: 4, max: 60, step: 1, onChange: () => sys.setActiveOptions({ lampSpacing: p.selLampSpacing }) });
        _slider(li, p, "selLampIntensity", { label: "Brightness", min: 0, max: 4, step: 0.05, onChange: () => sys.setActiveOptions({ lampIntensity: p.selLampIntensity }) });
        _color(li, p, "selLampColor", { label: "Colour", onChange: () => sys.setActiveOptions({ lampColor: p.selLampColor }) });
      }
      _slider(li, p, "selDaylight", {
        label: "Daylight at mouths", min: 0, max: 2, step: 0.05,
        onChange: () => sys.setActiveOptions({ daylight: p.selDaylight }),
        hint: "Sky light reaching in from each open end, fading over the first ~20 m.",
      });
    }

    // ── New defaults ────────────────────────────────────────────────────────
    const nn = _section(panel, "New defaults", false);
    _choice(nn, "Style", STYLE_OPTIONS, p.newStyle, (v) => { setNewStyle(v); refresh(); });
    _slider(nn, p, "newWidth", { label: "Width (m)", min: 2, max: 30, step: 0.5 });
    _slider(nn, p, "newHeight", { label: "Height (m)", min: 1, max: 30, step: 0.5 });
    _slider(nn, p, "newThickness", { label: "Wall (m)", min: 0.2, max: 5, step: 0.1 });

    // ── Look / display ──────────────────────────────────────────────────────
    const lk = _section(panel, "Look", false);
    _color(lk, p, "wallColor", { label: "Rock", onChange: () => sys.syncMaterialColors() });
    _color(lk, p, "floorColor", { label: "Floor", onChange: () => sys.syncMaterialColors() });
    _toggle(lk, p, "showHandles", {
      label: "Node handles",
      onChange: () => { sys._rebuildHandles(); sys.refreshVisibility(); },
    });
  }

  /** Picking a style for NEW tunnels also loads that style's default size. */
  function setNewStyle(style) {
    const p = app.tunnelSystem.params;
    if (p.newStyle === style) return;
    const d = style === "cave" ? app.defaults.CAVE_DEFAULTS : app.defaults.TUNNEL_DEFAULTS;
    p.newStyle = style;
    p.newWidth = d.width;
    p.newHeight = d.height;
    p.newThickness = d.thickness;
  }

  refresh();
  return { refresh };
}
