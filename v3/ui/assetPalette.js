/**
 * Asset palette — a grid of thumbnail cards for "what am I painting" pickers.
 *
 * The Unreal foliage-mode model: the things you can paint are a palette of
 * cards, the brush lives under it, and an item's own settings open only for
 * the SELECTED card. Reuses the paint panel's `.layer-card-grid` look, so trees,
 * foliage cards and props can all share one picker without new CSS.
 *
 * Every card except the eraser is a drop target, so a preset or model can be
 * dropped straight onto the slot it should fill — including empty "+" slots.
 *
 * @param {object} o
 * @param {HTMLElement} o.container      where the grid is appended
 * @param {() => Card[]} o.cards         card descriptors, re-read on refresh()
 * @param {() => any} o.activeKey        key of the selected card
 * @param {(key:any) => void} o.onSelect
 * @param {(key:any, file:File) => (void|Promise<void>)} [o.onDropFile]
 * @param {Set<string>} [o.acceptExts]   lowercase extensions accepted by drop
 * @param {string} [o.dropHint]          text shown while dragging over a card
 *
 * Card: { key, label, kind: "eraser"|"asset"|"empty", thumb?: dataURL, title?: string }
 */
export function createAssetPalette({
  container,
  cards,
  activeKey,
  onSelect,
  onDropFile = null,
  acceptExts = null,
  dropHint = "Drop to load",
}) {
  const grid = document.createElement("div");
  grid.className = "layer-card-grid";
  container.appendChild(grid);

  const extOf = (name) => String(name || "").split(".").pop().toLowerCase();

  function pickFile(dataTransfer) {
    if (!dataTransfer?.files?.length) return null;
    for (const f of dataTransfer.files) {
      if (!acceptExts || acceptExts.has(extOf(f.name))) return f;
    }
    return null;
  }

  function installDrop(card, key) {
    card.classList.add("drop-zone");
    card.dataset.dropHint = dropHint;
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", (e) => {
      if (!card.contains(e.relatedTarget)) card.classList.remove("drag-over");
    });
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove("drag-over");
      const file = pickFile(e.dataTransfer);
      if (!file) return;
      try {
        await onDropFile(key, file);
      } catch (err) {
        console.error("[V3] palette drop failed:", err);
      }
    });
  }

  function refresh() {
    grid.innerHTML = "";
    const act = activeKey();
    for (const c of cards()) {
      const card = document.createElement("div");
      card.className =
        "layer-card" +
        (c.key === act ? " active" : "") +
        (c.kind === "empty" ? " layer-card-empty" : "");
      card.title = c.title ?? c.label;

      const thumb = document.createElement("div");
      thumb.className = "layer-card-thumb" + (c.kind === "eraser" ? " layer-thumb-eraser" : "");
      if (c.kind === "eraser") {
        thumb.textContent = "✕";
      } else if (c.kind === "empty") {
        thumb.textContent = "+";
      } else if (c.thumb) {
        thumb.style.backgroundImage = `url("${c.thumb}")`;
        // Baked thumbnails are transparent PNGs; a dark ground keeps the
        // silhouette readable on the light and dark accent states alike.
        thumb.style.backgroundColor = "#1b1b1b";
        thumb.style.backgroundSize = "contain";
        thumb.style.backgroundRepeat = "no-repeat";
      } else {
        // Loaded but not yet baked: initials stand in until the bake lands.
        thumb.textContent = String(c.label).slice(0, 2).toUpperCase();
        thumb.style.backgroundColor = "#2b3a25";
      }

      const label = document.createElement("div");
      label.className = "layer-card-label";
      label.textContent = c.label;

      card.appendChild(thumb);
      card.appendChild(label);
      card.addEventListener("click", () => onSelect(c.key));
      if (onDropFile && c.kind !== "eraser") installDrop(card, c.key);
      grid.appendChild(card);
    }
  }

  refresh();
  return { el: grid, refresh };
}
