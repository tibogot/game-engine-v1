// THUNDERLINE'S LED SIGNS — the dot-matrix look of the chevron sign, the start / finish arch and the START / FINISH
// boards (user, 2026-10-28: "the chevron itself should be with digital dots … the start and finish panels with digital
// dots for the chevrons and text … the traffic lights of the start arch as better traffic lights in the dotted style").
// The dots are the old game's shader (v3 ledMatrix.js, image mode: a texture with ONE TEXEL PER LED, white = lit),
// reached through a loaded kit (physProps.js physKit: `makeLedMatrixMaterial`, imported there so the Node tests never
// load the WebGPU-only module). The words are drawn in a 5 × 7 DOT FONT (a browser font on a ~20-dot grid was mush).
import * as THREE from "three";

export const LED_PITCH = 0.09; // m between LEDs on every sign
const DOT_FONT = {
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  F: ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  I: [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  N: ["#...#", "##..#", "#.#.#", "#.#.#", "#..##", "#...#", "#...#"],
  H: ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
};
export const LED_PALETTES = {
  // (the cores saturated: with the bloom, near-white cores read WHITE — red lamps pink, green and START white)
  start: { coreColor: "#8fe6ff", edgeColor: "#1aa8ff" }, // bolt blue
  finish: { coreColor: "#ffffff", edgeColor: "#aab8cc" }, // white
  red: { coreColor: "#ff4a32", edgeColor: "#e00800" },
  green: { coreColor: "#5dff70", edgeColor: "#00d02a" },
};
const ledParams = (cols, rows, palette, emissive = 2.2) => ({
  mode: "image", shape: "round", cols, rows, dotRadius: 0.38, useRamp: true, threshold: 0.5, panSpeed: 0, emissive, offLevel: 0.05,
  ...LED_PALETTES[palette],
});
function gridTexture(cols, rows, draw) {
  const c = document.createElement("canvas");
  c.width = cols; c.height = rows;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, cols, rows);
  g.fillStyle = "#fff";
  draw(g);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}
/** `word` in the dot font, k LEDs a font dot, centred on (cx, cy) of the grid */
function drawWord(g, word, cx, cy, k) {
  const gap = 2 * k, cw = 5 * k, tw = word.length * cw + (word.length - 1) * gap;
  let x0 = Math.round(cx - tw / 2);
  const y0 = Math.round(cy - (7 * k) / 2);
  for (const ch of word) {
    (DOT_FONT[ch] ?? []).forEach((row, j) => { for (let i = 0; i < 5; i++) if (row[i] === "#") g.fillRect(x0 + i * k, y0 + j * k, k, k); });
    x0 += cw + gap;
  }
  return tw;
}
/** a chevron pointing `dir` (+1: toward +u) `h` LEDs tall, its tip at column tipX, stroke `t` LEDs, centred on cy */
function drawChevron(g, tipX, cy, h, dir, t) {
  const half = (h - 1) / 2, slope = 0.55; // columns back per row away from the middle
  for (let r = 0; r < h; r++) {
    const off = Math.round(Math.abs(r - half) * slope);
    for (let s = 0; s < t; s++) g.fillRect(tipX - dir * (off + s), Math.round(cy - half + r), 1, 1);
  }
  return Math.round(half * slope) + t; // its width
}

const cache = new Map();
/**
 * A sign's LED face: `word` (dot font) and, if `chevrons` (±1: the end they sit at and point to), three chevrons at
 * that end; `checker`: two checkered rows top and bottom. One material per kind and size, shared (userData.keep).
 * @param kit  physKit("arch") — carries makeLedMatrixMaterial
 * @param o { word, w, h (m), chevrons: 0 | 1 | -1, checker, palette }
 */
export function ledSignMaterial(kit, { word = "", w, h, chevrons = 0, checker = false, palette = "start" }) {
  const key = `${word}|${w.toFixed(2)}|${h.toFixed(2)}|${chevrons}|${checker}|${palette}`;
  if (cache.has(key)) return cache.get(key);
  const cols = Math.round(w / LED_PITCH), rows = Math.round(h / LED_PITCH);
  const tex = gridTexture(cols, rows, (g) => {
    if (checker) for (let x = 0; x < cols; x += 2) for (const y of [0, rows - 2]) if (((x >> 1) + (y ? 1 : 0)) % 2 === 0) g.fillRect(x, y, 2, 2);
    const k = rows >= 18 ? 2 : 1;
    let textCx = cols / 2;
    if (chevrons) {
      // three chevrons at the `chevrons` end, the word centred in what is left
      const ch = Math.min(rows - (checker ? 6 : 4), Math.round(rows * 0.8)), margin = 3, step = Math.round(ch * 0.5);
      for (let i = 0; i < 3; i++) drawChevron(g, chevrons > 0 ? cols - 1 - margin - i * step : margin + i * step, rows / 2, ch, chevrons, k + 1);
      const used = margin + 2 * step + Math.round(ch * 0.3) + 4;
      textCx = chevrons > 0 ? (cols - used) / 2 : used + (cols - used) / 2;
    }
    if (word) drawWord(g, word, textCx, rows / 2, k);
  });
  const mat = kit.makeLedMatrixMaterial({ boardW: w, boardH: h, contentTexture: tex, sourceAspect: cols / rows, params: ledParams(cols, rows, palette) });
  mat.userData.keep = true;
  cache.set(key, mat);
  return mat;
}

/**
 * A START LAMP: a round cluster of LEDs (a disc of the dot grid), its own material, and set(state): "off" (the dots
 * dark red, still visible as LEDs), "red", "green". Not shared: each lamp lights on its own.
 * @param kit  physKit("arch")
 * @param r  the disc's radius (m)
 */
export function ledLamp(kit, r) {
  const n = Math.max(7, Math.round((2 * r) / (LED_PITCH * 0.75))); // a denser grid than the boards: a lamp is small
  const tex = gridTexture(n, n, (g) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) <= n / 2 - 0.2) g.fillRect(x, y, 1, 1);
  });
  const mat = kit.makeLedMatrixMaterial({ boardW: 2 * r, boardH: 2 * r, contentTexture: tex, sourceAspect: 1, params: { ...ledParams(n, n, "red", 0), offLevel: 0.07 } });
  const u = mat.userData.led.u;
  const set = (state) => {
    const p = LED_PALETTES[state === "green" ? "green" : "red"];
    u.coreColor.value.set(state === "off" ? "#401010" : p.coreColor);
    u.edgeColor.value.set(state === "off" ? "#2a0806" : p.edgeColor);
    u.emissive.value = state === "off" ? 0.09 : 2.0; // (the shader caps the light at this: 0 would black the dots out)
  };
  set("off");
  return { material: mat, set };
}
