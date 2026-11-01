// THUNDERLINE'S OWN ADS (user, 2026-11-01: "the different billboard would be cool … the prism one"): the posters the
// billboards, the prism and the totem show until you give one your own picture. Made-up brands only — never a real
// one. Drawn once each on a canvas (landscape 1024 × 576, or portrait 640 × 1024 for the totem) and kept as data URLs
// (the old game's billboards take their pictures that way: modularRoadAdBillboard / modularRoadAdPrism).
const ADS = [
  { name: "VOLTRA", tag: "ENERGY THAT HITS 300", bg: ["#0b0f14", "#1d2a12"], ink: "#c6ff1a", sub: "#ffffff", mark: "bolt" },
  { name: "KESTREL", tag: "RACING OIL · LOW FRICTION", bg: ["#082a52", "#0c4a8a"], ink: "#ff8a1f", sub: "#e8f1ff", mark: "drop" },
  { name: "NOVAGRIP", tag: "TYRES THAT HOLD THE WALL", bg: ["#141414", "#2b2b2b"], ink: "#ffd21a", sub: "#ffffff", mark: "tyre" },
  { name: "STORMCELL", tag: "CHARGED FOR THE LONG RUN", bg: ["#0a1830", "#0f3a5c"], ink: "#3fd2ff", sub: "#ffffff", mark: "cell" },
  { name: "THUNDERLINE", tag: "BUILD · RACE · FLY", bg: ["#101a2e", "#1a1030"], ink: "#ffffff", sub: "#ff7a1a", mark: "chevrons" },
  { name: "SKYLINE 104.7", tag: "THE RADIO OF THE FAST LANE", bg: ["#3a0f2a", "#7a1a3a"], ink: "#ffe3f0", sub: "#ffb3d1", mark: "waves" },
];
export const AD_COUNT = ADS.length;
const cache = new Map();

function mark(g, kind, x, y, s, color) {
  g.save(); g.translate(x, y); g.fillStyle = color; g.strokeStyle = color; g.lineWidth = s * 0.12;
  if (kind === "bolt") { g.beginPath(); g.moveTo(s * 0.15, -s); g.lineTo(-s * 0.5, s * 0.1); g.lineTo(-s * 0.02, s * 0.1); g.lineTo(-s * 0.2, s); g.lineTo(s * 0.55, -s * 0.15); g.lineTo(s * 0.05, -s * 0.15); g.closePath(); g.fill(); }
  else if (kind === "drop") { g.beginPath(); g.moveTo(0, -s); g.bezierCurveTo(s * 0.9, -s * 0.1, s * 0.7, s * 0.9, 0, s * 0.9); g.bezierCurveTo(-s * 0.7, s * 0.9, -s * 0.9, -s * 0.1, 0, -s); g.fill(); }
  else if (kind === "tyre") { g.beginPath(); g.arc(0, 0, s * 0.85, 0, 2 * Math.PI); g.stroke(); g.lineWidth = s * 0.06; for (let k = 0; k < 12; k++) { const a = (k / 12) * 2 * Math.PI; g.beginPath(); g.moveTo(Math.cos(a) * s * 0.45, Math.sin(a) * s * 0.45); g.lineTo(Math.cos(a) * s * 0.7, Math.sin(a) * s * 0.7); g.stroke(); } }
  else if (kind === "cell") { g.strokeRect(-s * 0.4, -s * 0.8, s * 0.8, s * 1.6); g.fillRect(-s * 0.15, -s, s * 0.3, s * 0.2); g.fillRect(-s * 0.28, -s * 0.05, s * 0.56, s * 0.7); }
  else if (kind === "chevrons") { for (let k = 0; k < 3; k++) { const o = (k - 1) * s * 0.55; g.beginPath(); g.moveTo(o - s * 0.25, -s * 0.6); g.lineTo(o + s * 0.25, 0); g.lineTo(o - s * 0.25, s * 0.6); g.lineTo(o - s * 0.05, s * 0.6); g.lineTo(o + s * 0.45, 0); g.lineTo(o - s * 0.05, -s * 0.6); g.closePath(); g.fill(); } }
  else if (kind === "waves") { for (let k = 1; k <= 3; k++) { g.beginPath(); g.arc(-s * 0.4, 0, s * 0.3 * k, -0.7, 0.7); g.stroke(); } g.beginPath(); g.arc(-s * 0.4, 0, s * 0.12, 0, 2 * Math.PI); g.fill(); }
  g.restore();
}

/** Ad `i` (any integer: wraps) as a JPEG data URL; `portrait` for the totem. Null outside a browser. */
export function adPoster(i, portrait = false) {
  if (typeof document === "undefined") return null;
  const n = ((i % ADS.length) + ADS.length) % ADS.length, key = `${n}|${portrait}`;
  if (cache.has(key)) return cache.get(key);
  const a = ADS[n], W = portrait ? 640 : 1024, H = portrait ? 1024 : 576;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, W, H); grad.addColorStop(0, a.bg[0]); grad.addColorStop(1, a.bg[1]);
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  // speed stripes behind
  g.save(); g.globalAlpha = 0.12; g.fillStyle = a.ink;
  for (let k = -4; k < 12; k++) { g.beginPath(); const x = k * 120; g.moveTo(x, H); g.lineTo(x + 60, H); g.lineTo(x + 60 + H * 0.6, 0); g.lineTo(x + H * 0.6, 0); g.closePath(); g.fill(); }
  g.restore();
  // the brand mark and the name, the tag line under
  const fit = (text, maxW, size) => { g.font = `900 ${size}px "Arial Black", Impact, sans-serif`; const w = g.measureText(text).width; return w > maxW ? Math.floor(size * maxW / w) : size; };
  g.textBaseline = "middle"; g.fillStyle = a.ink;
  if (portrait) {
    mark(g, a.mark, W / 2, H * 0.3, 150, a.ink);
    const s = fit(a.name, W * 0.86, 120); g.font = `900 ${s}px "Arial Black", Impact, sans-serif`; g.textAlign = "center"; g.fillText(a.name, W / 2, H * 0.6);
    g.fillStyle = a.sub; const t = fit(a.tag, W * 0.86, 40); g.font = `700 ${t}px "Arial", sans-serif`; g.fillText(a.tag, W / 2, H * 0.72);
  } else {
    mark(g, a.mark, W * 0.16, H * 0.46, 140, a.ink);
    const s = fit(a.name, W * 0.64, 150); g.font = `900 ${s}px "Arial Black", Impact, sans-serif`; g.textAlign = "left"; g.fillText(a.name, W * 0.31, H * 0.42);
    g.fillStyle = a.sub; const t = fit(a.tag, W * 0.64, 46); g.font = `700 ${t}px "Arial", sans-serif`; g.fillText(a.tag, W * 0.31, H * 0.66);
  }
  g.fillStyle = a.sub; g.fillRect(0, H - 14, W, 14);
  const url = c.toDataURL("image/jpeg", 0.88);
  cache.set(key, url);
  return url;
}

/** A picture file → a data URL fitted (cover-cropped) to a board: 1024 × 576, or 640 × 1024 for the totem. */
export function pictureToPoster(file, portrait = false) {
  return new Promise((resolve, reject) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const W = portrait ? 640 : 1024, H = portrait ? 1024 : 576, c = document.createElement("canvas"); c.width = W; c.height = H;
      const k = Math.max(W / img.width, H / img.height), w = img.width * k, h = img.height * k;
      c.getContext("2d").drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
