// THE PRINTED PARTS — canvas textures: the instrument cluster, the shifter plate, the wheel
// hub, the player car sticker.
//
// The cluster has no real LEDs: holes in a printed panel with coloured flaps that slide in
// behind them. It is the real panel, from a photo, with its flaps switched (see createCluster).
import * as THREE from "three";

const WHITE = "#e9e6df", DARK = "#0d0e10", UNLIT = "#1b1c1f";
const YELLOW = "#f2b81e", PINK = "#ea2a78", GREEN = "#6fe25a", ORANGE = "#f58a1f";

function canvasTexture(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { canvas, ctx: canvas.getContext("2d"), tex };
}

function label(ctx, text, x, y, size, align = "left") {
  ctx.fillStyle = WHITE;
  ctx.font = `800 ${size}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function frame(ctx, pts, width = 5) {
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
}

// --- the cluster ---------------------------------------------------------------------------
// The real panel: the gauge close-up (assets-src/refs/turnin-turbo/cluster.png) warped onto the front photo's panel
// (SIFT + homography, 0.6 px) — front px 205..845 × 232..625, ×2 — with every flap window cut out of it
// (scratchpad flaps.py → public/textures/turnin-turbo/): cluster_base.png = all flaps OFF, cluster_flaps.png = each
// flap ON, cluster_flaps.json = where each goes. A frame of the panel = the base + the lit flaps (redrawn only when a
// shown value changes). TRIP's two flap wheels are drawn as text.
const TEX = "/textures/turnin-turbo/";
const SPEED_SEGS = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
const loadImage = (src) => new Promise((ok, fail) => Object.assign(new Image(), { onload() { ok(this); }, onerror: fail, src }));

export async function createCluster() {
  const [baseImg, flapsImg, layout] = await Promise.all([
    loadImage(TEX + "cluster_base.png"), loadImage(TEX + "cluster_flaps.png"), fetch(TEX + "cluster_flaps.json").then((r) => r.json()),
  ]);
  const [W, H] = layout.size;
  const { canvas, ctx, tex } = canvasTexture(W, H);
  let last = "";
  const flap = (name) => {
    const f = layout.flaps[name];
    if (f) ctx.drawImage(flapsImg, f[4], f[5], f[2], f[3], f[0], f[1], f[2], f[3]);
  };

  function draw(st) {
    ctx.drawImage(baseImg, 0, 0);
    for (let i = 0; i < st.tacho; i++) flap(`tacho${i}`);
    for (let i = 0; i < st.fuelBars; i++) flap(`fuel${i}`);
    for (let i = 0; i < st.turbo; i++) flap(`turbo${i}`);
    if (st.on) {
      const v = Math.min(199, Math.max(0, Math.round(st.speed)));
      if (v >= 100) { flap("spd0b"); flap("spd0c"); }
      if (v >= 10) for (const s of SPEED_SEGS[Math.floor(v / 10) % 10]) flap(`spd1${s}`);
      for (const s of SPEED_SEGS[v % 10]) flap(`spd2${s}`);
    }
    // TRIP: two flap wheels, green figures
    const trip = String(st.trip).padStart(2, "0");
    ctx.fillStyle = "#86d86a"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    layout.trip.forEach(([x, y, w, h], i) => {
      ctx.font = `900 ${Math.round(h * 1.25)}px "Arial Black", Arial, sans-serif`;
      ctx.save(); ctx.translate(x + w / 2, y + h / 2 + 1); ctx.scale(0.82, 1); ctx.fillText(trip[i], 0, 0); ctx.restore();
    });
    tex.needsUpdate = true;
  }

  return {
    texture: tex,
    update(st) {
      const key = JSON.stringify(st);
      if (key !== last) { last = key; draw(st); }
    },
  };
}

// --- the shifter label, back (canvas top) to front: TURBO, 4 3 2 1 in white boxes widening downwards with the
// orange ramp beside them, N (green) and STOP; the front quarter of the console is plain black.
// 256 × 1024 over the label plane (0.044 × 0.178 m). SHIFTER_ROWS: the gate rows' centres (canvas y), for the lever.
// rows measured on the photo along the ramp (back -> front): TURBO 7 %, 4 31 %, 3 46 %, 2 60 %, 1 74 %, N 88 %
export const SHIFTER_ROWS = { 4: 317, 3: 476, 2: 614, 1: 758, 0: 901 };
export function createShifterPlate() {
  const { ctx, tex } = canvasTexture(256, 1024);
  ctx.fillStyle = "#101113"; ctx.fillRect(0, 0, 256, 1024);
  label(ctx, "TURBO", 22, 72, 46);
  // one diagonal (measured on the photo): the white number boxes end on it, the orange stripes start on it
  const diag = (y) => 53 + (y - 120) * 0.205;
  for (const n of [4, 3, 2, 1]) {
    const y = SHIFTER_ROWS[n];
    const right = n === 1 ? 240 : diag(y) - 4;
    ctx.fillStyle = "#f1eee6"; ctx.fillRect(14, y - 64, right - 14, 128);
    ctx.fillStyle = "#101113"; ctx.font = "800 74px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(String(n), 30, y + 4);
  }
  ctx.fillStyle = ORANGE;
  for (let y = 122; y < 690; y += 34) {
    const x0 = diag(y + 10) + 4, x1 = 222 + (y - 122) * 0.02;
    if (x1 - x0 > 6) ctx.fillRect(x0, y, x1 - x0, 20);
  }
  ctx.fillStyle = "#2fd06c"; ctx.font = "900 72px Arial"; ctx.textAlign = "left"; ctx.fillText("N", 22, SHIFTER_ROWS[0] + 4);
  ctx.fillStyle = "#f1eee6"; ctx.fillRect(100, SHIFTER_ROWS[0] - 40, 140, 80);
  ctx.fillStyle = "#101113"; ctx.font = "900 44px Arial"; ctx.fillText("STOP", 112, SHIFTER_ROWS[0] + 3);
  tex.needsUpdate = true;
  return tex;
}

// --- the wheel hub badge: an elongated octagon, silver frame, black inside, TOMY in light grey ----------
export function createHubBadge() {
  const { ctx, tex } = canvasTexture(512, 308);
  ctx.clearRect(0, 0, 512, 308);   // only the badge itself: the hub shows round it
  const oct = (inset) => {
    const pts = [[70, 30], [442, 30], [490, 154], [442, 278], [70, 278], [22, 154]];
    const c = [256, 154];
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const k = 1 - inset / 230, px = c[0] + (x - c[0]) * k, py = c[1] + (y - c[1]) * (1 - inset / 125);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    });
    ctx.closePath();
  };
  const g = ctx.createLinearGradient(0, 30, 0, 278);
  g.addColorStop(0, "#e4e5e7"); g.addColorStop(0.5, "#9da0a4"); g.addColorStop(1, "#d6d8da");
  ctx.fillStyle = g; oct(0); ctx.fill();
  ctx.fillStyle = "#0d0d0e"; oct(13); ctx.fill();
  ctx.fillStyle = "#c4c6c9"; ctx.font = "900 96px Arial Black, Arial"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("TOMY", 256, 160);
  tex.needsUpdate = true;
  return tex;
}

// --- the strip's printing: COUNTER RESET over the button, OFF / ON over the key (transparent) ------------
// the plane spans photo px x 730..1000, y 668..705 (see turninTurbo.py)
export function createStripPrint() {
  const { ctx, tex } = canvasTexture(1024, 140);
  ctx.clearRect(0, 0, 1024, 140);
  ctx.fillStyle = "#8d949b"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "700 40px Arial";
  const u = (px) => ((px - 730) / 270) * 1024;
  ctx.fillText("COUNTER", u(782), 40); ctx.fillText("RESET", u(782), 95);
  ctx.fillText("OFF", u(878), 50); ctx.fillText("ON", u(948), 80);
  ctx.strokeStyle = "#8d949b"; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.arc(u(906), 250, 200, -Math.PI * 0.68, -Math.PI * 0.32); ctx.stroke();
  tex.needsUpdate = true;
  return tex;
}

// --- the player's red car, seen from behind (a sticker on clear plastic) ----------------------
export function createCarSticker() {
  const { canvas, ctx, tex } = canvasTexture(128, 160);
  ctx.clearRect(0, 0, 128, 160);
  ctx.shadowColor = "rgba(255, 40, 40, 0.9)"; ctx.shadowBlur = 14;
  ctx.fillStyle = "#e3262c";
  ctx.beginPath(); ctx.roundRect(18, 52, 92, 92, 22); ctx.fill();   // body
  ctx.beginPath(); ctx.roundRect(32, 22, 64, 54, 18); ctx.fill();   // cabin
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#5a0d12";
  ctx.beginPath(); ctx.roundRect(40, 32, 48, 26, 8); ctx.fill();    // rear window
  ctx.fillStyle = "#ff8a6a"; ctx.fillRect(24, 104, 18, 10); ctx.fillRect(86, 104, 18, 10); // lights
  ctx.fillStyle = "#2b0508"; ctx.fillRect(14, 124, 18, 26); ctx.fillRect(96, 124, 18, 26);  // tyres
  tex.needsUpdate = true;
  return tex;
}

// --- the TURNIN' TURBO DASHBOARD strip on top (black, red / orange pinstripes) -------------------------
export function createTopSticker() {
  const { ctx, tex } = canvasTexture(1024, 192);
  ctx.fillStyle = "#121214"; ctx.fillRect(0, 0, 1024, 192);
  ctx.fillStyle = "#d8281e"; ctx.fillRect(0, 128, 1024, 10);
  ctx.fillStyle = "#f08a1e"; ctx.fillRect(0, 146, 1024, 6);
  ctx.fillStyle = "#e9e6df";
  ctx.font = "italic 800 30px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText("TURNIN'", 330, 52);
  ctx.font = "italic 900 64px Arial Black, Arial"; ctx.fillText("TURBO DASHBOARD", 330, 112);
  ctx.font = "700 20px Arial"; ctx.fillText("TM", 940, 70);
  tex.needsUpdate = true;
  return tex;
}
