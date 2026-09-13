/**
 * v3/ui/buildTunnelPanel.js — Tunnel mode inspector.
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

/**
 * @param {object} app
 * @param {import("../tools/tunnelSystem.js").TunnelSystem} app.tunnelSystem
 * @param {number} app.maxHeight
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
    const ts = _section(panel, `Tunnels (${count})`, true);
    _hint(ts, "Click the ground at one mouth, then at the other. The two end nodes set the floor height at each mouth; nodes in between follow a straight grade unless you set their floor. Alt+click inserts a node, drag a node to move it, Delete removes it. The terrain opens by itself wherever the ground passes through the tube.");
    if (count > 1) {
      const pick = { i: Math.max(0, sys.activeIndex) };
      _slider(ts, pick, "i", {
        label: "Active tunnel", min: 0, max: count - 1, step: 1,
        onChange: () => { sys.setActiveIndex(pick.i); refresh(); },
      });
    }
    if (active) {
      const len = active._sampled?.length ?? 0;
      _hint(ts, `${active.nodes.length} node${active.nodes.length === 1 ? "" : "s"}` + (len ? ` · ${len.toFixed(0)} m long` : " · add a second node"));
    }
    _button(ts, {
      title: "New tunnel",
      hint: "Clicks then start a separate tunnel.",
      onClick: () => { sys.startNewTunnel(); refresh(); },
    });
    if (active) {
      _button(ts, { title: "Delete active tunnel", onClick: () => { sys.deleteActiveTunnel(); refresh(); } });
    }

    // ── Selected node ───────────────────────────────────────────────────────
    const sel = sys._selectedNode();
    if (sel) {
      const isEnd = sel.nodeIdx === 0 || sel.nodeIdx === sel.tunnel.nodes.length - 1;
      const nd = _section(panel, `Selected node (${sel.nodeIdx + 1}/${sel.tunnel.nodes.length})`, true);
      _slider(nd, p, "selFloor", {
        label: "Floor height (m)", min: -50, max: app.maxHeight, step: 0.1,
        onChange: () => sys.setSelectedFloor(p.selFloor),
        hint: isEnd ? "Floor height at this mouth." : "Setting this pins the node (gold).",
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

    // ── Active tunnel section ───────────────────────────────────────────────
    if (active) {
      const sc = _section(panel, "Cross-section", true);
      const onSection = () => sys.setActiveSection({ width: p.selWidth, height: p.selHeight, thickness: p.selThickness });
      _slider(sc, p, "selWidth", { label: "Width (m)", min: 2, max: 30, step: 0.5, onChange: onSection });
      _slider(sc, p, "selHeight", {
        label: "Height (m)", min: 1, max: 30, step: 0.5, onChange: onSection,
        hint: "Floor to the top of the arch. Never less than half the width (a half circle).",
      });
      _slider(sc, p, "selThickness", { label: "Wall (m)", min: 0.2, max: 5, step: 0.1, onChange: onSection });
      _button(sc, { title: "Raise 1 m", onClick: () => { sys.nudgeActiveTunnel(1); refresh(); } });
      _button(sc, { title: "Lower 1 m", onClick: () => { sys.nudgeActiveTunnel(-1); refresh(); } });
    }

    // ── New tunnel defaults ─────────────────────────────────────────────────
    const nn = _section(panel, "New tunnel defaults", false);
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

  refresh();
  return { refresh };
}
