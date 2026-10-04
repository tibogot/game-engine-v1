// THE RESOURCE ICONS — one picture per resource, used everywhere it appears (you, 2026-10-04:
// "compare with CoH"; CoH's top bar, prices and capture points all speak in the same icons):
//   mp    EFFECTIFS   a soldier's helmet (Adrian-style brim)
//   fuel  CARBURANT   a jerrycan, its X pressed in the side
//   mun   MUNITIONS   three cartridges
//   vp    a VILLAGE   a star: a victory point (and it pays all three)
// Drawn from path data (viewBox 0 0 24 24) — an SVG string for the HUD, the same paths on a
// canvas (Path2D) for the minimap. Colour comes from the caller (currentColor in SVG).

const PATHS = {
  mp: {
    fill: "M4 15.5C4 10.3 7.6 6 12 6s8 4.3 8 9.5z M2 16.6h20v2.2c-2 .9-5.2 1.5-10 1.5S4 19.7 2 18.8z M11 3.2h2v3h-2z",
  },
  fuel: {
    fill: "M6 5.5L9.5 2H17l2 2v17.5c0 .8-.7 1.5-1.5 1.5h-11c-.8 0-1.5-.7-1.5-1.5z M10.5 3.6v1.6h4.8V3.6z",
    stroke: "M8.6 10.5l7 9 M15.6 10.5l-7 9",
  },
  mun: {
    fill: "M4 9h4v13H4z M4.4 9C4.4 6 5 4 6 2.5 7 4 7.6 6 7.6 9z M10 9h4v13h-4z M10.4 9c0-3 .6-5 1.6-6.5C13 4 13.6 6 13.6 9z M16 9h4v13h-4z M16.4 9c0-3 .6-5 1.6-6.5C19 4 19.6 6 19.6 9z",
  },
  vp: {
    fill: "M12 1.8l2.9 6.6 7.2.7-5.4 4.8 1.6 7.1L12 17.3 5.7 21l1.6-7.1L1.9 9.1l7.2-.7z",
  },
};

/** An inline SVG of `key` at `size` px, in `color` (default: the text colour). */
export function iconSvg(key, { size = 14, color = "currentColor", cls = "" } = {}) {
  const p = PATHS[key];
  if (!p) return "";
  return `<svg class="ricon ${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" style="vertical-align:-2px">`
    + `<path d="${p.fill}" fill="${color}" fill-rule="evenodd"/>`
    + (p.stroke ? `<path d="${p.stroke}" fill="none" stroke="rgba(10,12,8,0.75)" stroke-width="1.6" stroke-linecap="round"/>` : "")
    + "</svg>";
}

const _path2d = {};
/** Draw `key` centred at (x, y), `size` px across, on a 2D canvas context. */
export function drawIcon(ctx, key, x, y, size, color) {
  const p = PATHS[key];
  if (!p) return;
  const P = (_path2d[key] ??= { fill: new Path2D(p.fill), stroke: p.stroke ? new Path2D(p.stroke) : null });
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.fillStyle = color;
  ctx.fill(P.fill, "evenodd");
  if (P.stroke) { ctx.strokeStyle = "rgba(10,12,8,0.75)"; ctx.lineWidth = 1.6; ctx.lineCap = "round"; ctx.stroke(P.stroke); }
  ctx.restore();
}

/** The icon of a capture point. */
export const pointIcon = (p) => (p.kind === "supply" ? p.res : "vp");
