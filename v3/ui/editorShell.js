/** Tab bar + collapsible inspector sections (v2-style shell helpers). */
export function initEditorShell() {
  for (const btn of document.querySelectorAll(".tab-btn")) {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      for (const b of document.querySelectorAll(".tab-btn")) {
        b.classList.toggle("active", b.dataset.tab === tab);
      }
      for (const panel of document.querySelectorAll(".tab-content")) {
        panel.classList.toggle("active", panel.id === `tab-${tab}`);
      }
    });
  }

  for (const hdr of document.querySelectorAll(".section-header[data-toggle]")) {
    hdr.addEventListener("click", () => {
      hdr.classList.toggle("collapsed");
      hdr.nextElementSibling?.classList.toggle("hidden");
    });
  }

  if (typeof lucide !== "undefined") lucide.createIcons();
}
