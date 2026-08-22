// ============================================================================
// SEGMENT DASH — rally-car digital dashboard (speed bar + 7-seg digits + tach).
//
// Replaces the old sweeping-arc speedo (still in road.html, commented out) with
// the layout you see in a stage-rally / drift car: a DashDAQ / AiM-style screen.
//
//   ┌──────────────────────────────────────────┐
//   │ SPEED km/h                               │
//   │ ▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯   ← 16-segment speed bar│
//   │ 20  40  60 … 200   ← fixed tick scale    │
//   │                                          │
//   │   ▉▉ ▉▉ ▉▉        ▉▉   ← 7-seg digits    │
//   │    km/h            GEAR                  │
//   │                                          │
//   │ ▁▂▃▄▅▆▇█▇  ← rising-envelope tach bars   │
//   │ 1 2 3 4 5 6 7 8   ▉ ▉  ← shift lights    │
//   └──────────────────────────────────────────┘
//
// WHY SVG AND NOT A FONT: a 7-segment webfont draws a glyph, so the segments
// that are OFF simply are not there. Half of what makes these panels read as
// hardware is the GHOST — the unlit segments sitting there dim behind the lit
// ones (that's why the photo's "86" looks like "88"). Only real geometry gives
// you that, so every segment is its own polygon and lighting a digit is a class
// swap on seven of them.
//
// PER-FRAME COST: nothing is created or laid out after build(). update() diffs
// against the last frame's state and only touches the elements that actually
// changed — a digit that stays on 8 costs one string compare, and the tach
// touches at most the bars that crossed the lit/unlit boundary this frame.
// ============================================================================

const NS = "http://www.w3.org/2000/svg";

/** Look + scale knobs. Mutable so a dev panel could drive them live. */
export const DASH = {
  /** Full-scale of the speed bar and its tick row, km/h. Rounded up from the
   *  car's top speed by the caller so overspeed still has bar left to fill. */
  speedMaxKmh: 200,
  /** Segment count of the speed bar. */
  speedSegments: 16,
  /** Tick label spacing on the scale row, km/h. */
  tickStepKmh: 20,
  /** Bars in the tach ladder. */
  tachBars: 24,
  /** Fraction of the ladder drawn green / amber. Past `tachAmber` is red. */
  tachGreen: 0.6,
  tachAmber: 0.86,
  /** Shift lights to the right of the ladder. */
  shiftLights: 2,
  /** Blink period of the shift lights at redline, seconds. */
  shiftBlink: 0.14,
};

// ── SVG helpers ─────────────────────────────────────────────────────────────
function svg(name, attrs) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

/**
 * A horizontal segment: a bar with mitred (45°) ends, so neighbouring segments
 * meet in the corner notch the way a real display does.
 */
function hSeg(x, y, len, t) {
  const h = t / 2;
  return `${x},${y + h} ${x + h},${y} ${x + len - h},${y} ${x + len},${y + h} ${x + len - h},${y + t} ${x + h},${y + t}`;
}

/** A vertical segment, same mitring. */
function vSeg(x, y, len, t) {
  const h = t / 2;
  return `${x + h},${y} ${x + t},${y + h} ${x + t},${y + len - h} ${x + h},${y + len} ${x},${y + len - h} ${x},${y + h}`;
}

/** Which of the seven segments each character lights. Order: a b c d e f g. */
const GLYPHS = {
  "0": "abcdef",
  "1": "bc",
  "2": "abged",
  "3": "abgcd",
  "4": "fgbc",
  "5": "afgcd",
  "6": "afgedc",
  "7": "abc",
  "8": "abcdefg",
  "9": "abcfgd",
  // Lowercase r — the usual 7-seg stand-in for Reverse (a real "R" needs 14).
  R: "eg",
  N: "abcef",
  "-": "g",
  " ": "",
};
const SEG_ORDER = ["a", "b", "c", "d", "e", "f", "g"];

/**
 * Build one 7-segment digit into `parent`.
 * @returns {{ els: SVGElement[], set(ch: string): void, last: string }}
 */
function makeDigit(parent, x, y, w, h, t, gap, extraClass) {
  // The colour class lives on the GROUP, not the polygons: the lit-segment glow
  // is a filter, and one filter on a group that repaints when the digit changes
  // is far cheaper than seven filtered polygons (see the tach, which changes
  // every frame and therefore carries no filter at all).
  const g = svg("g", { transform: `translate(${x} ${y})`, class: `sd-digit ${extraClass}` });
  const lh = w - t - 2 * gap;         // horizontal segment length
  const lv = h / 2 - t / 2 - 2 * gap; // vertical segment length
  const hx = t / 2 + gap;
  const pts = {
    a: hSeg(hx, 0, lh, t),
    b: vSeg(w - t, t / 2 + gap, lv, t),
    c: vSeg(w - t, h / 2 + gap, lv, t),
    d: hSeg(hx, h - t, lh, t),
    e: vSeg(0, h / 2 + gap, lv, t),
    f: vSeg(0, t / 2 + gap, lv, t),
    g: hSeg(hx, (h - t) / 2, lh, t),
  };
  const els = SEG_ORDER.map((k) => {
    const p = svg("polygon", { points: pts[k], class: "sd-seg" });
    g.appendChild(p);
    return p;
  });
  parent.appendChild(g);

  let last = null;
  return {
    els,
    group: g,
    /**
     * Light exactly the segments this character needs. No-op if unchanged.
     *
     * Touches only the segments that actually DIFFER from the glyph before it.
     * The speed digits change several times a second while driving, and most
     * neighbouring glyphs share most of their bars — 8 to 9 moves one segment,
     * 3 to 8 moves two — so rewriting all seven meant roughly five pointless
     * `classList.toggle` calls per digit per change. Profiling a drift on
     * audittest.json put `toggle` at 1.6% of the main thread.
     */
    set(ch) {
      if (ch === last) return;
      // `last === null` means invalidate() ran and the DOM state is unknown, so
      // every segment has to be written rather than diffed against a glyph we
      // can no longer trust.
      const prev = last === null ? null : (GLYPHS[last] ?? "");
      last = ch;
      const on = GLYPHS[ch] ?? "";
      for (let i = 0; i < 7; i++) {
        const want = on.includes(SEG_ORDER[i]);
        if (prev === null || want !== prev.includes(SEG_ORDER[i])) {
          els[i].classList.toggle("on", want);
        }
      }
    },
    /** Force the next set() to rewrite (used when the colour class changes). */
    invalidate() { last = null; },
  };
}

/**
 * Build the dashboard inside `root` (an empty div) and return its driver.
 *
 * @param {HTMLElement} root
 * @param {{ speedMaxKmh?: number }} [opts]
 */
export function createSegmentDash(root, opts = {}) {
  if (!root) return { update() {}, dispose() {} };
  const speedMax = Math.max(60, opts.speedMaxKmh ?? DASH.speedMaxKmh);

  // ── Canvas geometry. One viewBox, CSS scales the whole panel. ─────────────
  // Everything below is in viewBox units, so #race-dash's CSS `width` is the
  // single knob for how big the dash is on screen — these numbers only set the
  // PROPORTIONS. The digits deliberately do not fill the panel: a HUD you read
  // in peripheral vision needs to be legible, not large, and the tach ladder is
  // what you actually watch when driving.
  const W = 320, H = 219; // H trims to just under the rpm labels' descenders
  const PAD = 9;
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  root.textContent = "";
  root.appendChild(s);

  // ── 1) SPEED BAR ──────────────────────────────────────────────────────────
  s.appendChild(Object.assign(svg("text", { x: PAD, y: 10, class: "sd-label" }), { textContent: "SPEED" }));
  s.appendChild(Object.assign(svg("text", { x: PAD + 51, y: 10, class: "sd-label sd-dim" }), { textContent: "km/h" }));

  const barY = 15, barH = 12;
  const barW = W - PAD * 2;
  const segGap = 3;
  const segW = (barW - segGap * (DASH.speedSegments - 1)) / DASH.speedSegments;
  const speedSegs = [];
  for (let i = 0; i < DASH.speedSegments; i++) {
    const r = svg("rect", {
      x: (PAD + i * (segW + segGap)).toFixed(2), y: barY,
      width: segW.toFixed(2), height: barH, rx: 1.5,
      class: "sd-bseg",
    });
    s.appendChild(r);
    speedSegs.push(r);
  }

  // Tick scale. Fixed labels, exactly like a printed gauge face — the numbers
  // never move, only the bar under them grows.
  for (let v = DASH.tickStepKmh; v <= speedMax; v += DASH.tickStepKmh) {
    const f = v / speedMax;
    // Centred on the value it marks — except the last one, which sits exactly
    // on the bar's right edge: centred it would run off the viewBox and get
    // clipped, and nudging it inwards instead collides with its neighbour.
    const isLast = v + DASH.tickStepKmh > speedMax;
    const a = { y: barY + barH + 12, class: "sd-tick" };
    if (isLast) { a.x = W - PAD; a["text-anchor"] = "end"; }
    else a.x = (PAD + f * barW).toFixed(2);
    s.appendChild(Object.assign(svg("text", a), { textContent: String(v) }));
  }

  // ── 2) BIG DIGITS ─────────────────────────────────────────────────────────
  // Speed on the left in white, gear on the right in red — the split from the
  // photo. Three speed digits because top speed is 180 km/h and a downhill can
  // push past it; the leading one simply sits dark (ghosted) below 100.
  const digY = 48, digH = 74, digW = 44, digT = 9, digGap = 2;
  const digSpace = 9; // gap between the speed digits
  const speedDigits = [];
  for (let i = 0; i < 3; i++) {
    speedDigits.push(makeDigit(s, PAD + i * (digW + digSpace), digY, digW, digH, digT, digGap, "sd-white"));
  }
  const gearX = W - PAD - digW - 12;
  const gearDigit = makeDigit(s, gearX, digY, digW, digH, digT, digGap, "sd-red");

  const speedBlockW = digW * 3 + digSpace * 2;
  s.appendChild(Object.assign(
    svg("text", { x: PAD + speedBlockW / 2, y: digY + digH + 13, class: "sd-cap" }),
    { textContent: "KM/H" },
  ));
  s.appendChild(Object.assign(
    svg("text", { x: gearX + digW / 2, y: digY + digH + 13, class: "sd-cap" }),
    { textContent: "GEAR" },
  ));

  // ── 3) TACH LADDER ────────────────────────────────────────────────────────
  // Bars rise along a curve rather than stepping evenly: that swelling profile
  // is what makes the ladder read as an engine winding out instead of a plain
  // progress bar, and it's the shape in the photo.
  const shiftW = 14, shiftGap = 6;
  const shiftBlockW = DASH.shiftLights * (shiftW + shiftGap);
  const tachTop = 150, tachMaxH = 48, tachMinH = 9;
  const tachBase = tachTop + tachMaxH;
  const tachW = W - PAD * 2 - shiftBlockW - 5;
  const tGap = 3;
  const tW = (tachW - tGap * (DASH.tachBars - 1)) / DASH.tachBars;
  const tachBars = [];
  for (let i = 0; i < DASH.tachBars; i++) {
    const f = i / (DASH.tachBars - 1);
    // Slow, flat start → steep climb → full height at the redline end.
    const h = tachMinH + (tachMaxH - tachMinH) * (0.08 + 0.92 * Math.pow(f, 1.9));
    const zone = f < DASH.tachGreen ? "z-green" : f < DASH.tachAmber ? "z-amber" : "z-red";
    const r = svg("rect", {
      x: (PAD + i * (tW + tGap)).toFixed(2), y: (tachBase - h).toFixed(2),
      width: tW.toFixed(2), height: h.toFixed(2), rx: 1.5,
      class: `sd-tbar ${zone}`,
    });
    s.appendChild(r);
    tachBars.push(r);
  }

  // Shift lights, right of the ladder — the only thing on the panel that moves
  // without the car doing anything, so they read instantly.
  const shiftLights = [];
  for (let i = 0; i < DASH.shiftLights; i++) {
    const r = svg("rect", {
      x: PAD + tachW + 5 + i * (shiftW + shiftGap), y: tachBase - 18,
      width: shiftW, height: 18, rx: 2, class: "sd-shift",
    });
    s.appendChild(r);
    shiftLights.push(r);
  }

  // Ladder scale: 1–8 across the bars, red past the redline mark. Decorative —
  // the gearbox reports a normalised rpm, so these are "thousands" in spirit.
  const rpmLabels = [];
  for (let k = 1; k <= 8; k++) {
    const f = k / 8;
    const t = Object.assign(
      svg("text", { x: (PAD + f * tachW - tW / 2).toFixed(2), y: tachBase + 14, class: "sd-rpm" }),
      { textContent: String(k) },
    );
    if (f > DASH.tachAmber) t.classList.add("hot");
    s.appendChild(t);
    rpmLabels.push(t);
  }

  // ── Per-frame state cache ─────────────────────────────────────────────────
  let lastSpeedLit = -1;
  let lastTachLit = -1;
  let lastGearCls = "";
  let lastShiftOn = null;
  let blink = 0;

  return {
    /**
     * @param {number} dt        seconds since last frame (drives the blink)
     * @param {object} v
     * @param {number} v.speedKmh
     * @param {string} v.gearLabel  "1".."6" or "R"
     * @param {number} v.rpm        0..1+ (past 1 = overspeed in top gear)
     * @param {boolean} v.reverse
     * @param {number} v.redline    fraction of the ladder that is redline
     */
    update(dt, v) {
      // Speed bar — ceil so the first segment lights the moment you move.
      const sf = Math.max(0, Math.min(1, v.speedKmh / speedMax));
      const lit = sf <= 0 ? 0 : Math.max(1, Math.ceil(sf * DASH.speedSegments));
      if (lit !== lastSpeedLit) {
        const lo = Math.min(lit, lastSpeedLit < 0 ? 0 : lastSpeedLit);
        const hi = Math.max(lit, lastSpeedLit);
        for (let i = lo; i < hi; i++) speedSegs[i].classList.toggle("on", i < lit);
        lastSpeedLit = lit;
      }

      // Digits — right-aligned, leading zeros left dark so the ghost shows.
      const kmh = Math.max(0, Math.min(999, Math.round(v.speedKmh)));
      const str = String(kmh).padStart(3, " ");
      for (let i = 0; i < 3; i++) speedDigits[i].set(str[i]);

      const gearCls = v.reverse ? "sd-amber" : "sd-red";
      if (gearCls !== lastGearCls) {
        gearDigit.group.classList.remove("sd-red", "sd-amber");
        gearDigit.group.classList.add(gearCls);
        lastGearCls = gearCls;
      }
      gearDigit.set(v.reverse ? "R" : v.gearLabel);

      // Tach ladder.
      const rf = Math.max(0, Math.min(1, v.rpm));
      const tLit = rf <= 0 ? 0 : Math.max(1, Math.round(rf * DASH.tachBars));
      if (tLit !== lastTachLit) {
        const lo = Math.min(tLit, lastTachLit < 0 ? 0 : lastTachLit);
        const hi = Math.max(tLit, lastTachLit);
        for (let i = lo; i < hi; i++) tachBars[i].classList.toggle("on", i < tLit);
        lastTachLit = tLit;
      }

      // Shift lights blink at redline, solid-off below it.
      const hot = v.rpm >= (v.redline ?? 0.88);
      blink = hot ? blink + dt : 0;
      const on = hot && (blink % (DASH.shiftBlink * 2)) < DASH.shiftBlink;
      if (on !== lastShiftOn) {
        for (const e of shiftLights) e.classList.toggle("on", on);
        lastShiftOn = on;
      }
    },

    dispose() { root.textContent = ""; },
  };
}
