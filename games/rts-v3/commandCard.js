// Command card — GAME UI (player-facing). Bottom-right panel showing the
// current selection's portrait + name + count and command buttons (Stop,
// Focus). Grows into build/ability buttons per unit type later.
export function createCommandCard({ thumbnails, onStop = () => {}, onFocus = () => {} }) {
  const root = document.createElement("div");
  root.id = "rts-cmd-card";
  root.innerHTML = `
    <div class="cc-head">
      <div class="cc-portrait"></div>
      <div class="cc-info"><div class="cc-name">—</div><div class="cc-count"></div></div>
    </div>
    <div class="cc-actions">
      <button data-act="stop" title="Stop (S)">Stop</button>
      <button data-act="focus" title="Center camera (F)">Focus</button>
    </div>
  `;
  document.body.appendChild(root);

  const style = document.createElement("style");
  style.textContent = `
    #rts-cmd-card {
      position: fixed; right: 12px; bottom: 12px; z-index: 55; width: 220px;
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
    #rts-cmd-card .cc-count { font-size: 12px; color: #9aa4b2; }
    #rts-cmd-card .cc-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    #rts-cmd-card button {
      cursor: pointer; font: 12px system-ui, sans-serif; color: #e8e8e8;
      padding: 7px 0; border-radius: 6px; background: #23303f; border: 1px solid rgba(255,255,255,0.14);
    }
    #rts-cmd-card button:hover { background: #2d3f52; border-color: #6ab0ff; }
  `;
  document.head.appendChild(style);

  const portrait = root.querySelector(".cc-portrait");
  const nameEl = root.querySelector(".cc-name");
  const countEl = root.querySelector(".cc-count");
  root.querySelector('[data-act="stop"]').addEventListener("click", onStop);
  root.querySelector('[data-act="focus"]').addEventListener("click", onFocus);

  function render(selected) {
    if (!selected.length) { root.classList.remove("show"); return; }
    const types = new Set(selected.map((u) => u.typeKey));
    const lead = selected[0];
    const url = thumbnails?.get(lead.typeKey);
    portrait.style.backgroundImage = url ? `url(${url})` : "none";
    nameEl.textContent = types.size > 1 ? "Mixed group" : (lead.name ?? lead.typeKey);
    countEl.textContent = `${selected.length} unit${selected.length > 1 ? "s" : ""}`;
    root.classList.add("show");
  }

  return {
    root,
    render,
    dispose() { root.remove(); style.remove(); },
  };
}
