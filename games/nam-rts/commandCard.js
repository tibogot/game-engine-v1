// Command card — GAME UI (player-facing), the HUD bar's right slot (hudBar.js).
//
// Two faces:
//   • UNITS selected    → portrait, name, count, Stop / Focus.
//   • The BASE selected → production: build buttons + queue + progress bar.

export function createCommandCard({
  thumbnails,
  onStop = () => {},
  onFocus = () => {},
  onBuild = () => {},          // (structure, key) — enqueue production on that structure
  productionFor = () => [],    // (structure) → [{ key, label, cost }] it can produce
  canAfford = () => true,      // (cost) → is it affordable right now?
  structureBuilds = [],        // [{ key, label }] — buildings a selected builder can raise
  buildingCosts = {},          // { key: supplies } — shown on builder structure buttons
  onBuildStructure = () => {},
  abilitiesFor = () => [],     // (selected) → [{ key, label, hint, cost, ready, cooldown }]
  onAbility = () => {},        // (key, selected) — enter targeting
  stanceFor = () => null,      // (selected) → { concealment, cover } | null
  mount = document.body,
}) {
  const root = document.createElement("div");
  root.id = "rts-cmd-card";
  mount.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #rts-cmd-card { height: 100%; display: flex; flex-direction: column; gap: 7px; font-family: var(--hud-sans); color: var(--hud-text); }
    #rts-cmd-card .cc-head { display: flex; gap: 10px; align-items: center; }
    #rts-cmd-card .cc-portrait {
      width: 44px; height: 44px; flex: none;
      background: #1b1e17 center/90% no-repeat; border: 1px solid #454c3a; border-radius: var(--hud-radius);
    }
    #rts-cmd-card .cc-name { font-weight: 600; font-size: 13px; letter-spacing: 0.03em; }
    #rts-cmd-card .cc-sub { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--hud-dim); margin-top: 2px; }
    #rts-cmd-card .cc-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
    /* A builder has eight builds: four across, so two rows leave room for its abilities. */
    #rts-cmd-card .cc-builds, #rts-cmd-card .cc-orders { grid-template-columns: repeat(4, 1fr); gap: 4px; }
    #rts-cmd-card .cc-builds button { padding: 5px 2px; white-space: nowrap; }
    #rts-cmd-card .cc-builds .cc-cost { margin-left: 3px; }
    #rts-cmd-card button {
      cursor: pointer; font: 11px var(--hud-sans); color: var(--hud-text); line-height: 1.15;
      padding: 5px 3px; border-radius: var(--hud-radius); background: #252920; border: 1px solid #454c3a;
    }
    #rts-cmd-card button:hover { background: #2d3226; border-color: var(--hud-brass); }
    #rts-cmd-card button .cc-cost {
      font: 600 10px var(--hud-mono); color: var(--hud-brass); margin-left: 5px;   /* one line: the slot is 152 px tall */
    }
    /* Can't afford it — still clickable (the click just no-ops), but clearly dead. */
    #rts-cmd-card button.poor { opacity: 0.45; }
    #rts-cmd-card button.poor:hover { background: #252920; border-color: #454c3a; }
    #rts-cmd-card button.poor .cc-cost { color: var(--hud-red); }
    #rts-cmd-card .cc-bar { height: 4px; background: #23261d; border: 1px solid #3a4031; overflow: hidden; }
    #rts-cmd-card .cc-bar i { display: block; height: 100%; width: 0%; background: var(--hud-brass); }
    #rts-cmd-card .cc-queue { display: flex; gap: 4px; flex-wrap: wrap; min-height: 16px; }
    /* Abilities read differently from production: they are VERBS, not purchases,
       so they get their own colour and sit above Stop/Focus where a player's
       eye lands first. */
    #rts-cmd-card .cc-abil button { background: #33301c; border-color: rgba(201,165,74,0.45); }
    #rts-cmd-card .cc-abil button:hover { background: #3e3a22; border-color: var(--hud-brass); }
    #rts-cmd-card .cc-abil button.cooling { background: #1d2019; border-color: #33382b; color: #6f6d60; cursor: default; }
    #rts-cmd-card .cc-abil button.cooling:hover { background: #1d2019; border-color: #33382b; }
    #rts-cmd-card .cc-abil .cc-cd { font: 10px var(--hud-mono); color: var(--hud-dim); margin-left: 5px; }
    /* Cover and concealment are RULES the player cannot see on the terrain.
       Two chips are the whole readout: without them a unit that has stopped
       shooting looks broken rather than outplayed. */
    #rts-cmd-card .cc-stance { display: flex; gap: 5px; min-height: 16px; }
    #rts-cmd-card .cc-tag {
      font-size: 9px; font-weight: 600; letter-spacing: 0.1em;
      padding: 2px 6px; border-radius: var(--hud-radius); border: 1px solid;
    }
    #rts-cmd-card .cc-tag.conceal { color: #9fcf7a; border-color: rgba(159,207,122,0.4); background: rgba(52,74,38,0.4); }
    #rts-cmd-card .cc-tag.cover   { color: #c9b98a; border-color: rgba(201,185,138,0.4); background: rgba(74,66,42,0.4); }
    #rts-cmd-card .cc-tag.seen    { color: #e0905a; border-color: rgba(224,144,90,0.45); background: rgba(94,52,25,0.4); }
    #rts-cmd-card .cc-chip {
      font-size: 10px; padding: 1px 5px; border-radius: var(--hud-radius);
      background: #1d2019; border: 1px solid #3a4031; color: var(--hud-dim);
    }
  `;
  document.head.appendChild(style);

  let baseRef = null;    // the base, while it's the thing selected
  let selRef = [];       // the live selection, so tick() can refresh cooldowns

  /**
   * The ability row's markup. Shared by the unit face and the structure face
   * because "what can this thing DO" is the same question for a squad and for
   * a radio station, and two copies would drift.
   */
  function abilityRow(selected) {
    const inner = abilityButtons(selected);
    return inner ? `<div class="cc-actions cc-abil">${inner}</div>` : "";
  }

  /** Just the ability buttons, for a row that also holds other orders. */
  function abilityButtons(selected) {
    const list = abilitiesFor(selected);
    if (!list.length) return "";
    return `${list.map((a) => `
      <button data-abil="${a.key}" class="${a.ready ? "" : "cooling"}" title="${a.hint ?? ""}">
        ${a.label}
        ${a.ready
          ? (a.cost ? `<span class="cc-cost">${a.cost}</span>` : "")
          : `<span class="cc-cd">${a.cooldown > 0 ? `${a.cooldown}s` : "—"}</span>`}
      </button>`).join("")}`;
  }

  /** Wire whatever ability buttons the last render produced. */
  function bindAbilities(selected) {
    for (const btn of root.querySelectorAll("[data-abil]")) {
      btn.addEventListener("click", () => {
        if (btn.classList.contains("cooling")) return;
        onAbility(btn.dataset.abil, selected);
      });
    }
  }

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
      ${builds.length ? `<div class="cc-actions cc-builds">${builds.map((b) => {
        const cost = buildingCosts[b.key] ?? 0;
        const poor = cost > 0 && !canAfford(cost);
        return `<button data-struct="${b.key}" class="${poor ? "poor" : ""}" title="${b.tip ?? b.label}">${b.label}${cost ? `<span class="cc-cost">${cost}</span>` : ""}</button>`;
      }).join("")}</div>` : ""}
      <div class="cc-stance" id="cc-stance"></div>
      <!-- Abilities and the standing orders share one row: the slot is 152 px tall. -->
      <div class="cc-actions cc-orders">
        ${abilityButtons(selected)}
        <button data-act="stop">Stop</button>
        <button data-act="focus">Focus</button>
      </div>
    `;
    root.querySelector('[data-act="stop"]').addEventListener("click", onStop);
    root.querySelector('[data-act="focus"]').addEventListener("click", onFocus);
    bindAbilities(selected);
    for (const b of builds) {
      root.querySelector(`[data-struct="${b.key}"]`)
        .addEventListener("click", () => {
          const cost = buildingCosts[b.key] ?? 0;
          if (cost > 0 && !canAfford(cost)) return;
          onBuildStructure(b.key, selected);
        });
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
        ${opts.map((b) => `
          <button data-build="${b.key}" data-cost="${b.cost ?? 0}">
            ${b.label}${b.cost ? `<span class="cc-cost">${b.cost}</span>` : ""}
          </button>`).join("")}
      </div>
    `;
    for (const b of opts) {
      root.querySelector(`[data-build="${b.key}"]`)
        .addEventListener("click", () => onBuild(s, b.key));
    }
    refreshAffordability();
  }

  /**
   * Grey out what the player can't pay for. Called on render AND every frame from
   * tick(), because stock changes continuously as harvesters unload — a button
   * that only re-evaluated on selection would lie for as long as the card is open.
   */
  function refreshAffordability() {
    for (const btn of root.querySelectorAll("[data-build]")) {
      const cost = Number(btn.dataset.cost) || 0;
      btn.classList.toggle("poor", cost > 0 && !canAfford(cost));
    }
  }

  /**
   * Keep ability buttons honest between renders — a cooldown ticks down every
   * frame, and a button that only re-evaluated on re-selection would sit there
   * saying "ready" on something that is not, or "38s" on something that is.
   * Text only: re-rendering the row would drop the listeners mid-click.
   */
  /**
   * The stance chips. Thresholds rather than a percentage on purpose: a player
   * reading a command card in a firefight wants to know WHETHER they are
   * hidden, not that they are 0.31 hidden.
   */
  function refreshStance() {
    const el = root.querySelector("#cc-stance");
    if (!el) return;
    const st = stanceFor(selRef);
    let html = "";
    if (st) {
      if (st.revealed) html += `<span class="cc-tag seen">SPOTTED</span>`;
      else if (st.concealment >= 0.3) html += `<span class="cc-tag conceal">CONCEALED</span>`;
      else if (st.concealment >= 0.1) html += `<span class="cc-tag conceal">IN COVER OF BRUSH</span>`;
      if (st.cover >= 0.35) html += `<span class="cc-tag cover">HARD COVER</span>`;
      else if (st.cover >= 0.12) html += `<span class="cc-tag cover">LIGHT COVER</span>`;
    }
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function refreshAbilities() {
    const btns = root.querySelectorAll("[data-abil]");
    if (!btns.length) return;
    const live = new Map(abilitiesFor(selRef).map((a) => [a.key, a]));
    for (const btn of btns) {
      const a = live.get(btn.dataset.abil);
      if (!a) continue;
      btn.classList.toggle("cooling", !a.ready);
      const cd = btn.querySelector(".cc-cd");
      if (cd) cd.textContent = a.ready ? "" : `${a.cooldown}s`;
    }
  }

  /** A structure with nothing to produce (a turret): identity + status only. */
  function renderStructure(s) {
    baseRef = null;
    const status = s.constructing
      ? "Under construction…"
      : (s.deploy ?? 1) < 1 ? "Calibrating…"
        : s.typeKey === "radio" ? "Tactical map · vision relay"
          : s.typeKey === "captureNode" ? `Supply relay · +${s.type.incomeRate ?? 0}/s`
          : s.typeKey === "enemyBase" ? "Primary objective · destroy to win"
            : s.range ? `Defensive emplacement · ${Math.round(s.range)}m` : "Structure";
    root.innerHTML = `
      <div class="cc-head">
        <div>
          <div class="cc-name">${s.name}</div>
          <div class="cc-sub">${status}</div>
        </div>
      </div>
      ${abilityRow([s])}
      <div class="cc-actions">
        <button data-act="focus">Focus</button>
      </div>
    `;
    root.querySelector('[data-act="focus"]').addEventListener("click", onFocus);
    bindAbilities([s]);
  }

  function render(selected) {
    selRef = selected;
    if (!selected.length) { baseRef = null; root.innerHTML = `<div class="empty">No orders</div>`; return; }
    // A selected PRODUCING structure (base or a finished building) shows its queue.
    const producer = selected.find((e) => e.isStructure && e.enqueue);
    const mobile = selected.filter((e) => !e.isStructure);
    if (producer) renderProducer(producer);
    else if (mobile.length) { renderUnits(mobile); refreshStance(); }
    // Nothing mobile and nothing producing — a lone turret or other silent structure.
    else renderStructure(selected[0]);
  }

  /** Called each frame — keeps the production bar/queue/affordability live. */
  function tick() {
    refreshAbilities();
    refreshStance();
    if (!baseRef) return;
    refreshAffordability();
    const prog = root.querySelector("#cc-prog");
    const queue = root.querySelector("#cc-queue");
    if (prog) prog.style.width = `${Math.round((baseRef.progress ?? 0) * 100)}%`;
    if (queue) {
      const chips = (baseRef.queue ?? []).map((k) => `<span class="cc-chip">${k}</span>`).join("");
      if (queue.innerHTML !== chips) queue.innerHTML = chips;
    }
  }

  render([]);

  return {
    root,
    render,
    tick,
    dispose() { root.remove(); style.remove(); },
  };
}
