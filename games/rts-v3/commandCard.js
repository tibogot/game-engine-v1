// Command card — GAME UI (player-facing), bottom-right.
//
// Two faces:
//   • UNITS selected    → portrait, name, count, Stop / Focus.
//   • The BASE selected → production: build buttons + queue + progress bar.
export function createCommandCard({
  thumbnails,
  onStop = () => {},
  onFocus = () => {},
  onBuild = () => {},          // (structure, key) — enqueue production on that structure
  productionFor = () => [],    // (structure) → [{ key, label }] it can produce
  structureBuilds = [],        // [{ key, label }] — buildings a selected builder can raise
  onBuildStructure = () => {},
}) {
  const root = document.createElement("div");
  root.id = "rts-cmd-card";
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #rts-cmd-card {
      position: fixed; right: 280px; bottom: 12px; z-index: 55; width: 232px;
      display: none; flex-direction: column; gap: 8px; padding: 10px;
      background: rgba(16,18,22,0.72); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 10px; backdrop-filter: blur(6px);
      font-family: system-ui, -apple-system, sans-serif; color: #e8e8e8;
    }
    #rts-cmd-card.show { display: flex; }
    #rts-cmd-card .cc-head { display: flex; gap: 10px; align-items: center; }
    #rts-cmd-card .cc-portrait {
      width: 64px; height: 64px; border-radius: 8px; flex: none;
      background: #11151c center/90% no-repeat; border: 1px solid rgba(255,255,255,0.14);
    }
    #rts-cmd-card .cc-name { font-weight: 700; font-size: 14px; }
    #rts-cmd-card .cc-sub { font-size: 12px; color: #9aa4b2; }
    #rts-cmd-card .cc-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    #rts-cmd-card button {
      cursor: pointer; font: 12px system-ui, sans-serif; color: #e8e8e8;
      padding: 7px 0; border-radius: 6px; background: #23303f; border: 1px solid rgba(255,255,255,0.14);
    }
    #rts-cmd-card button:hover { background: #2d3f52; border-color: #6ab0ff; }
    #rts-cmd-card .cc-bar {
      height: 6px; border-radius: 3px; background: #11151c; overflow: hidden;
      border: 1px solid rgba(255,255,255,0.12);
    }
    #rts-cmd-card .cc-bar i { display: block; height: 100%; width: 0%; background: #2a6df0; }
    #rts-cmd-card .cc-queue { display: flex; gap: 4px; flex-wrap: wrap; min-height: 18px; }
    #rts-cmd-card .cc-chip {
      font-size: 10px; padding: 2px 6px; border-radius: 4px;
      background: #1b2430; border: 1px solid rgba(255,255,255,0.12); color: #c3ccd6;
    }
  `;
  document.head.appendChild(style);

  let baseRef = null; // the base, while it's the thing selected

  function renderUnits(selected) {
    baseRef = null;
    const types = new Set(selected.map((u) => u.typeKey));
    const lead = selected[0];
    const url = thumbnails?.get(lead.typeKey);

    // Which buildings can this selection raise? (union of every selected builder's list)
    const canBuild = new Set();
    for (const u of selected) for (const k of u.type?.builds ?? []) canBuild.add(k);
    const builds = structureBuilds.filter((b) => canBuild.has(b.key));

    root.innerHTML = `
      <div class="cc-head">
        <div class="cc-portrait" style="${url ? `background-image:url(${url})` : ""}"></div>
        <div>
          <div class="cc-name">${types.size > 1 ? "Mixed group" : (lead.name ?? lead.typeKey)}</div>
          <div class="cc-sub">${selected.length} unit${selected.length > 1 ? "s" : ""}</div>
        </div>
      </div>
      ${builds.length ? `<div class="cc-actions">${builds.map((b) => `<button data-struct="${b.key}">${b.label}</button>`).join("")}</div>` : ""}
      <div class="cc-actions">
        <button data-act="stop">Stop</button>
        <button data-act="focus">Focus</button>
      </div>
    `;
    root.querySelector('[data-act="stop"]').addEventListener("click", onStop);
    root.querySelector('[data-act="focus"]').addEventListener("click", onFocus);
    for (const b of builds) {
      root.querySelector(`[data-struct="${b.key}"]`)
        .addEventListener("click", () => onBuildStructure(b.key, selected));
    }
  }

  function renderProducer(s) {
    baseRef = s;
    const opts = productionFor(s);
    const constructing = s.constructing === true;
    root.innerHTML = `
      <div class="cc-head">
        <div>
          <div class="cc-name">${s.name}</div>
          <div class="cc-sub">${constructing ? "Under construction…" : "Production"}</div>
        </div>
      </div>
      <div class="cc-bar"><i id="cc-prog"></i></div>
      <div class="cc-queue" id="cc-queue"></div>
      <div class="cc-actions">
        ${opts.map((b) => `<button data-build="${b.key}">${b.label}</button>`).join("")}
      </div>
    `;
    for (const b of opts) {
      root.querySelector(`[data-build="${b.key}"]`)
        .addEventListener("click", () => onBuild(s, b.key));
    }
  }

  /** A structure with nothing to produce (a turret): identity + status only. */
  function renderStructure(s) {
    baseRef = null;
    const status = s.constructing
      ? "Under construction…"
      : (s.deploy ?? 1) < 1 ? "Calibrating…"
        : s.range ? `Defensive emplacement · ${Math.round(s.range)}m` : "Structure";
    root.innerHTML = `
      <div class="cc-head">
        <div>
          <div class="cc-name">${s.name}</div>
          <div class="cc-sub">${status}</div>
        </div>
      </div>
      <div class="cc-actions">
        <button data-act="focus">Focus</button>
      </div>
    `;
    root.querySelector('[data-act="focus"]').addEventListener("click", onFocus);
  }

  function render(selected) {
    if (!selected.length) { root.classList.remove("show"); baseRef = null; return; }
    // A selected PRODUCING structure (base or a finished building) shows its queue.
    const producer = selected.find((e) => e.isStructure && e.enqueue);
    const mobile = selected.filter((e) => !e.isStructure);
    if (producer) renderProducer(producer);
    else if (mobile.length) renderUnits(mobile);
    // Nothing mobile and nothing producing — a lone turret or other silent structure.
    else renderStructure(selected[0]);
    root.classList.add("show");
  }

  /** Called each frame — keeps the production bar/queue live. */
  function tick() {
    if (!baseRef) return;
    const prog = root.querySelector("#cc-prog");
    const queue = root.querySelector("#cc-queue");
    if (prog) prog.style.width = `${Math.round((baseRef.progress ?? 0) * 100)}%`;
    if (queue) {
      const chips = (baseRef.queue ?? []).map((k) => `<span class="cc-chip">${k}</span>`).join("");
      if (queue.innerHTML !== chips) queue.innerHTML = chips;
    }
  }

  return {
    root,
    render,
    tick,
    dispose() { root.remove(); style.remove(); },
  };
}
