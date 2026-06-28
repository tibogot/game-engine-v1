/** Radial play-mode picker — hold G to open, release to confirm (v2-style). */

export const V3_MODE_ORDER = ["capsule", "char", "fly", "husky", "car", "stunt", "ball"];

export const V3_MODE_META = {
  capsule: { label: "Capsule", icon: "◉", digit: "1" },
  char:    { label: "Character", icon: "🧝", digit: "2" },
  fly:     { label: "Flight", icon: "✈", digit: "3" },
  husky:   { label: "Husky", icon: "🐺", digit: "4" },
  car:     { label: "Bruno", icon: "🚙", digit: "5" },
  stunt:   { label: "Stunt", icon: "🏁", digit: "6" },
  ball:    { label: "Debug Ball", icon: "🔵", digit: "7" },
};

export function createModeWheel({ onPick, getCurrentMode }) {
  const slotEls = {};
  let overlay = null;
  let cursorEl = null;
  let hubLabelEl = null;
  let open = false;
  let armed = false;
  let holdTimer = null;
  let hover = null;
  const cursor = { x: 0, y: 0 };

  function build() {
    overlay = document.createElement("div");
    overlay.id = "v3-mode-wheel";
    overlay.style.cssText = [
      "display:none", "position:fixed", "inset:0", "z-index:9500",
      "background:rgba(0,0,0,0.35)", "backdrop-filter:blur(2px)",
    ].join(";");

    const wheel = document.createElement("div");
    wheel.style.cssText = [
      "position:absolute", "left:50%", "top:50%",
      "width:360px", "height:360px", "margin:-180px 0 0 -180px",
    ].join(";");

    const RING_R = 130;
    const n = V3_MODE_ORDER.length;
    for (let i = 0; i < n; i++) {
      const name = V3_MODE_ORDER[i];
      const meta = V3_MODE_META[name];
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / n;
      const cx = Math.cos(ang) * RING_R;
      const cy = Math.sin(ang) * RING_R;
      const slot = document.createElement("div");
      slot.dataset.mode = name;
      slot.style.cssText = [
        "position:absolute", "left:50%", "top:50%", "width:84px", "height:84px",
        `transform:translate(calc(-50% + ${cx}px),calc(-50% + ${cy}px))`,
        "border-radius:50%", "background:rgba(6,10,14,0.78)",
        "border:1px solid rgba(120,175,200,0.25)",
        "display:flex", "flex-direction:column", "align-items:center", "justify-content:center",
        "gap:2px", "color:#f2f8fc", "pointer-events:none",
        "transition:transform 120ms ease,background 120ms ease,border-color 120ms ease",
      ].join(";");
      slot.innerHTML = `
        <div style="font-size:22px;line-height:1;">${meta.icon}</div>
        <div style="font-size:10px;font-weight:700;">${meta.label}</div>
        <div style="font-size:8px;font-weight:600;letter-spacing:0.16em;color:rgba(140,175,195,0.7);">Key ${meta.digit}</div>`;
      wheel.appendChild(slot);
      slotEls[name] = slot;
    }

    const hub = document.createElement("div");
    hub.style.cssText = [
      "position:absolute", "left:50%", "top:50%", "width:120px", "height:120px",
      "margin:-60px 0 0 -60px", "border-radius:50%", "background:rgba(4,8,12,0.82)",
      "border:1px solid rgba(120,175,200,0.22)", "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center", "text-align:center", "padding:0 10px",
    ].join(";");
    hub.innerHTML = `
      <div style="font-size:8px;font-weight:600;letter-spacing:0.22em;color:rgba(140,175,195,0.7);text-transform:uppercase;">Play mode</div>
      <div id="v3-mode-wheel-label" style="font-size:14px;font-weight:700;color:#f2f8fc;margin-top:4px;">—</div>
      <div style="font-size:8px;color:rgba(140,175,195,0.55);margin-top:6px;text-transform:uppercase;">Release G</div>`;
    wheel.appendChild(hub);
    hubLabelEl = hub.querySelector("#v3-mode-wheel-label");

    cursorEl = document.createElement("div");
    cursorEl.style.cssText = [
      "position:absolute", "left:50%", "top:50%", "width:10px", "height:10px",
      "margin:-5px 0 0 -5px", "border-radius:50%", "background:#f2f8fc",
      "pointer-events:none", "transform:translate(0,0)",
    ].join(";");
    wheel.appendChild(cursorEl);

    overlay.appendChild(wheel);
    document.body.appendChild(overlay);
  }

  function refreshVisual() {
    if (cursorEl) cursorEl.style.transform = `translate(${cursor.x}px,${cursor.y}px)`;
    const mag = Math.hypot(cursor.x, cursor.y);
    const DEAD_R = 40;
    let nextHover = null;
    if (mag > DEAD_R) {
      const ang = Math.atan2(cursor.y, cursor.x);
      const n = V3_MODE_ORDER.length;
      let best = -1;
      let bestDiff = Infinity;
      for (let i = 0; i < n; i++) {
        const slotAng = -Math.PI / 2 + (i * Math.PI * 2) / n;
        let d = Math.abs(((ang - slotAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
        if (d < bestDiff) { bestDiff = d; best = i; }
      }
      if (best >= 0) nextHover = V3_MODE_ORDER[best];
    }
    if (nextHover !== hover) {
      hover = nextHover;
      for (const name of V3_MODE_ORDER) {
        const el = slotEls[name];
        if (!el) continue;
        const on = name === hover;
        el.style.background = on ? "rgba(60,120,170,0.55)" : "rgba(6,10,14,0.78)";
        el.style.borderColor = on ? "rgba(180,220,250,0.7)" : "rgba(120,175,200,0.25)";
        el.style.transform = el.style.transform.replace(/\s*scale\([^)]*\)/, "") + (on ? " scale(1.12)" : "");
      }
      if (hubLabelEl) {
        hubLabelEl.textContent = hover
          ? V3_MODE_META[hover].label
          : V3_MODE_META[getCurrentMode()]?.label ?? "—";
      }
    }
  }

  function openWheel() {
    if (!overlay || open) return;
    open = true;
    cursor.x = 0;
    cursor.y = 0;
    hover = null;
    refreshVisual();
    overlay.style.display = "block";
  }

  function closeWheel(commit) {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    armed = false;
    if (!open) return;
    open = false;
    overlay.style.display = "none";
    if (commit && hover && hover !== getCurrentMode()) onPick(hover);
    hover = null;
  }

  function armHold() {
    if (holdTimer || open) return;
    armed = true;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      openWheel();
    }, 180);
  }

  function onKeyDownG() {
    armHold();
  }

  function onKeyUpG() {
    if (open) closeWheel(true);
    else if (armed) {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      armed = false;
      const i = V3_MODE_ORDER.indexOf(getCurrentMode());
      const next = V3_MODE_ORDER[(i + 1) % V3_MODE_ORDER.length];
      onPick(next);
    }
  }

  function feedMouse(dx, dy) {
    if (!open) return;
    cursor.x += dx;
    cursor.y += dy;
    const mag = Math.hypot(cursor.x, cursor.y);
    const maxR = 160;
    if (mag > maxR) {
      const s = maxR / mag;
      cursor.x *= s;
      cursor.y *= s;
    }
    refreshVisual();
  }

  function cancel() { closeWheel(false); }

  build();

  return {
    get open() { return open; },
    onKeyDownG,
    onKeyUpG,
    feedMouse,
    cancel,
    dispose() { overlay?.remove(); },
  };
}
