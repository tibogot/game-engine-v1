// THE PRINTED PARTS — canvas textures: the instrument cluster, the shifter plate, the wheel
// hub, the player car sticker.
//
// The cluster has no real LEDs: holes in a printed panel with coloured flaps that slide in
// behind them. Here (step 1) the flaps are painted into the canvas, which is redrawn only
// when a shown value changes. Layout measured from a front photo of the toy (1024 × 614 =
// the cluster window).
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

// seven segments: a b c d e f g
const SEGS = { " ": "", 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };
function sevenSeg(ctx, x, y, w, h, ch, on, off) {
  const t = w * 0.2, sk = w * 0.12;
  const seg = {
    a: [[x + t, y], [x + w - t, y], [x + w - t * 1.5, y + t], [x + t * 1.5, y + t]],
    b: [[x + w, y + t * 0.6], [x + w, y + h / 2 - t * 0.3], [x + w - t, y + h / 2 - t * 0.8], [x + w - t, y + t * 1.2]],
    c: [[x + w, y + h / 2 + t * 0.3], [x + w, y + h - t * 0.6], [x + w - t, y + h - t * 1.2], [x + w - t, y + h / 2 + t * 0.8]],
    d: [[x + t * 1.5, y + h - t], [x + w - t * 1.5, y + h - t], [x + w - t, y + h], [x + t, y + h]],
    e: [[x, y + h / 2 + t * 0.3], [x + t, y + h / 2 + t * 0.8], [x + t, y + h - t * 1.2], [x, y + h - t * 0.6]],
    f: [[x, y + t * 0.6], [x + t, y + t * 1.2], [x + t, y + h / 2 - t * 0.8], [x, y + h / 2 - t * 0.3]],
    g: [[x + t, y + h / 2 - t / 2], [x + w - t, y + h / 2 - t / 2], [x + w - t * 0.6, y + h / 2], [x + w - t, y + h / 2 + t / 2], [x + t, y + h / 2 + t / 2], [x + t * 0.6, y + h / 2]],
  };
  const lit = SEGS[ch] ?? "";
  for (const k of "abcdefg") {
    ctx.fillStyle = lit.includes(k) ? on : off;
    ctx.beginPath();
    seg[k].forEach(([px, py], i) => { const sx = px + sk * (1 - (py - y) / h); i ? ctx.lineTo(sx, py) : ctx.moveTo(sx, py); });
    ctx.closePath();
    ctx.fill();
  }
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
// Drawn in the FRONT PHOTO's pixel coordinates: the panel plane covers photo px 205..845 × 232..625 (see
// turninTurbo.py CL_PANEL), the canvas is that × 2. Every mark below is measured on the photo (and, where the wheel
// hides it, on the bezel photographed out of its shell). The flap windows: dark grey unlit, colour lit.
const PANEL = { x0: 205, y0: 232, x1: 845, y1: 625, k: 2 };
const Q = (x, y) => [(x - PANEL.x0) * PANEL.k, (y - PANEL.y0) * PANEL.k];
const FLAP_OFF = "#202124";
const PRINT = "#dcdad3";

function poly(ctx, pts, fill) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const [u, v] = Q(x, y); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
}
function lines(ctx, pts, w = 2.6) {
  ctx.strokeStyle = PRINT; ctx.lineWidth = w * PANEL.k; ctx.lineJoin = "miter"; ctx.lineCap = "butt";
  ctx.beginPath();
  pts.forEach(([x, y], i) => { const [u, v] = Q(x, y); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
  ctx.stroke();
}
// wide, heavy lettering (the panel's extended sans): Arial Black stretched to the measured box
function text(ctx, str, x0, y0, x1, y1, color = PRINT) {
  const [u0, v0] = Q(x0, y0), [u1, v1] = Q(x1, y1);
  const h = v1 - v0;
  ctx.save();
  ctx.font = `900 ${h * 1.32}px "Arial Black", Arial, sans-serif`;
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  const w = ctx.measureText(str).width;
  ctx.translate(u0, v1);
  ctx.scale((u1 - u0) / w, 1);
  ctx.fillStyle = color;
  ctx.fillText(str, 0, 0);
  ctx.restore();
}
function box(ctx, x0, y0, x1, y1, fill) {
  const [u0, v0] = Q(x0, y0), [u1, v1] = Q(x1, y1);
  ctx.fillStyle = fill; ctx.fillRect(u0, v0, u1 - u0, v1 - v0);
}

// the tacho's 8 blocks: four up the arc (tilted), four along the top
const TACHO = [
  { c: [265, 372], w: 34, h: 18, a: -0.72 }, { c: [295, 341], w: 34, h: 18, a: -0.6 },
  { c: [323, 311], w: 36, h: 18, a: -0.42 }, { c: [364, 287], w: 38, h: 18, a: -0.2 },
  { c: [410, 277], w: 38, h: 17, a: 0 }, { c: [457, 277], w: 38, h: 17, a: 0 },
  { c: [505, 277], w: 38, h: 17, a: 0 }, { c: [552, 277], w: 38, h: 17, a: 0 },
];

export function createCluster() {
  const { canvas, ctx, tex } = canvasTexture((PANEL.x1 - PANEL.x0) * PANEL.k, (PANEL.y1 - PANEL.y0) * PANEL.k);
  let last = "";

  function draw(st) {
    ctx.fillStyle = "#060a10";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // turn arrows (printed grey; they light green when steering hard — a guess)
    poly(ctx, [[252, 270], [266, 258], [310, 258], [310, 283], [266, 283]], st.blinkL ? "#86ff6c" : "#a9aaa6");
    poly(ctx, [[667, 275], [652, 264], [610, 264], [610, 287], [652, 287]], st.blinkR ? "#86ff6c" : "#a9aaa6");

    // tacho flaps + scale
    TACHO.forEach((b, i) => {
      const [u, v] = Q(...b.c);
      ctx.save(); ctx.translate(u, v); ctx.rotate(b.a);
      ctx.fillStyle = i < st.tacho ? YELLOW : FLAP_OFF;
      ctx.fillRect((-b.w / 2) * PANEL.k, (-b.h / 2) * PANEL.k, b.w * PANEL.k, b.h * PANEL.k);
      ctx.restore();
    });
    text(ctx, "0", 252, 397, 275, 413); text(ctx, "1", 293, 364, 309, 380); text(ctx, "2", 347, 308, 370, 325);
    text(ctx, "4", 422, 291, 443, 306); text(ctx, "6", 517, 291, 537, 306); text(ctx, "8", 567, 291, 588, 306);
    text(ctx, "TACHO", 354, 346, 427, 361); text(ctx, "X1000R/MIN", 342, 369, 457, 381);

    // fuel: the stepped box, the scale, five bars (pink = fuel left)
    lines(ctx, [[707, 258], [806, 258], [806, 371], [736, 371], [726, 357], [707, 357], [707, 258]]);
    text(ctx, "FUEL", 680, 310, 729, 325);
    for (let i = 0; i < 6; i++) box(ctx, 733, 268 + i * 17, 744, 270.5 + i * 17, PRINT);
    text(ctx, "F", 748, 263, 755, 273); text(ctx, "E", 748, 353, 755, 363);
    for (let i = 0; i < 5; i++) box(ctx, 758, 265 + i * 19.5, 797, 276 + i * 19.5, 4 - i < st.fuelBars ? PINK : FLAP_OFF);

    // the warning column: door, seat belt, battery (lit red for a moment by the key)
    const warn = st.check ? "#ff4636" : PRINT;
    lines(ctx, [[252, 425], [335, 425], [335, 560], [252, 560], [252, 425]]);
    lines(ctx, [[252, 470], [335, 470]]); lines(ctx, [[252, 515], [335, 515]]);
    // door: a car from the front with a door open
    poly(ctx, [[278, 432], [308, 432], [314, 446], [318, 460], [268, 460], [272, 446]], warn);
    poly(ctx, [[283, 437], [303, 437], [307, 446], [279, 446]], "#0c0d0f");
    poly(ctx, [[318, 446], [330, 440], [331, 444], [320, 450]], warn);
    // seat belt: a seated figure, a strap across
    poly(ctx, [[288, 477], [298, 477], [298, 486], [288, 486]], warn);
    poly(ctx, [[282, 489], [304, 489], [306, 507], [280, 507]], warn);
    poly(ctx, [[272, 504], [316, 480], [318, 484], [274, 508]], warn);
    // battery: a box with + and -
    lines(ctx, [[270, 527], [318, 527], [318, 552], [270, 552], [270, 527]], 2.4);
    box(ctx, 277, 522, 285, 527, warn); box(ctx, 303, 522, 311, 527, warn);
    box(ctx, 276, 538, 286, 541, warn); box(ctx, 303, 538, 313, 541, warn); box(ctx, 306.5, 534.5, 309.5, 544.5, warn);

    // turbo: its box, five cells (pink in 4th at full revs)
    lines(ctx, [[412, 418], [412, 397], [487, 397], [487, 500]]);
    lines(ctx, [[412, 446], [412, 500]]);
    text(ctx, "TURBO", 377, 422, 450, 439);
    for (let i = 0; i < 5; i++) box(ctx, 460, 416 + i * 15, 475, 428 + i * 15, 4 - i < st.turbo ? PINK : FLAP_OFF);

    // speed: the bracket box, three 7-segment windows, MPH, SPEED
    lines(ctx, [[528, 400], [500, 400], [500, 470], [588, 470]]);
    lines(ctx, [[666, 470], [810, 470], [810, 403], [742, 403]]);
    text(ctx, "SPEED", 592, 463, 662, 477); text(ctx, "MPH", 735, 431, 797, 450);
    const txt = String(st.speed).padStart(3, " ");
    for (let i = 0; i < 3; i++) {
      const [u, v] = Q(522 + i * 80, 389);
      sevenSeg(ctx, u, v, 48 * PANEL.k, 63 * PANEL.k, txt[i], GREEN, FLAP_OFF);
    }

    // the odometer box (printed 00009), the lamp icons, TRIP (the score: two flap wheels)
    lines(ctx, [[502, 540], [502, 490], [827, 490], [827, 576], [800, 576]]);
    lines(ctx, [[580, 535], [710, 535], [732, 576], [748, 576]]);
    text(ctx, "00009", 525, 505, 607, 522);
    text(ctx, "TRIP", 750, 570, 795, 585);
    ctx.strokeStyle = PRINT; ctx.lineWidth = 2.4 * PANEL.k;
    { const [u, v] = Q(672, 562); ctx.beginPath(); ctx.arc(u, v, 13 * PANEL.k, 0, Math.PI * 2); ctx.stroke(); }
    text(ctx, "P", 665, 553, 680, 571);
    { const [u, v] = Q(622, 562); ctx.beginPath(); ctx.arc(u, v, 10 * PANEL.k, Math.PI * 0.5, Math.PI * 1.5); ctx.closePath(); ctx.stroke(); }
    for (let i = 0; i < 4; i++) box(ctx, 632, 553 + i * 5.5, 646, 555 + i * 5.5, PRINT);
    const trip = String(st.trip).padStart(2, "0");
    for (let i = 0; i < 2; i++) {
      const x0 = 740 + i * 40;
      box(ctx, x0, 522, x0 + 32, 550, "#050506");
      box(ctx, x0, 545, x0 + 32, 550, "#3a3c40");
      text(ctx, trip[i], x0 + 9, 527, x0 + 23, 543, GREEN);
    }
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
