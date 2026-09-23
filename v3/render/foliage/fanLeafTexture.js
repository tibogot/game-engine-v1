/**
 * FAN LEAF — the alpha of one palmate palm leaf: the *cọ* of the northern
 * palm hills, the *thốt nốt* of the Mekong.
 *
 * This is the texture that makes a fan palm a DIFFERENT PLANT from a coconut
 * or a betel palm rather than a differently-proportioned one. Coconut and
 * areca are pinnate — a feather, leaflets down both sides of a rachis. A fan
 * palm is palmate: one leaf, a pleated disc split into stiff segments
 * radiating from a single point. At two hundred metres a feather reads as a
 * soft plume and a fan reads as a hard spiked star, and that difference is the
 * whole reason to build the plant.
 *
 * DRAWN FROM PHOTOGRAPHS (Borassus flabellifer and Livistona, Wikimedia
 * Commons, 2026-09-23), because the first two passes were drawn from memory
 * and both were wrong in the same way:
 *
 *   · THE LEAF IS NEARLY A FULL CIRCLE — about 300 degrees of arc, a disc with
 *     a notch where the petiole enters. The first version drew a 157-degree
 *     HALF-disc, which is a hand fan, not a palm leaf, and it is why the crown
 *     read as a pinwheel of slabs however the geometry was arranged.
 *   · THE SEGMENTS DROOP AND THE TIPS SPLIT. Each one curves away from the
 *     centre as it goes out and ends in a long fine fork. The spikiness of the
 *     outline is the plant's signature; a clean circular rim is a dinner plate.
 *   · THE INNER THIRD IS SOLID. The splits only run down the outer part of the
 *     blade; the middle is one pleated sheet. Split it to the centre and the
 *     leaf falls apart into loose spokes.
 *   · THE SPLITS ARE UNEVEN. A fan leaf tears along its pleats with age, to
 *     different depths, and a third of the segments are noticeably short.
 *
 * Drawn white on transparent, the petiole entering at the bottom centre, like
 * every other card texture here; colour is the shader's.
 */
/** Square: the leaf is a disc, and it is mapped onto a square card. */
export const FAN_TEX_W = 512;
export const FAN_TEX_H = 512;

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * @param {HTMLCanvasElement} canvas  FAN_TEX_W x FAN_TEX_H
 * @param {object} [o]
 *   segments  radiating blade segments (a real leaf has 30-60)
 *   arc       how far round the fan opens, in radians (Borassus ~2.6, a
 *             costapalmate Livistona folds narrower)
 *   seed      deterministic across reloads
 */
export function drawFanLeafTexture(canvas, o = {}) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const rand = rng(o.seed ?? 4471);
  const segments = o.segments ?? 46;
  // ~300 degrees. Not a half-disc: see the header.
  const arc = o.arc ?? 5.24;
  const curl = o.curl ?? 0.42;

  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // The hub sits low enough that the downward segments still fit on the
  // canvas: the leaf reaches R up and 0.87R down, so 1.87R has to fit in H.
  const R = Math.min(H / 1.9, W / 2) * 0.98;
  const hx = W * 0.5, hy = H - R * 0.87 - H * 0.015;

  /** A point on a segment's centre line, drooping as it goes out. */
  const along = (a, t, len) => {
    // The segment bends AWAY from straight-up as it extends — gravity on a
    // stiff pleated blade. Straight segments read as a cog wheel.
    const bend = a + Math.sign(a) * curl * t * t * Math.min(1, Math.abs(a) / 1.2);
    const drop = curl * 0.35 * t * t;
    return [hx + Math.sin(bend) * len * t, hy - Math.cos(bend) * len * t + drop * len * t];
  };

  for (let i = 0; i < segments; i++) {
    const f = segments === 1 ? 0.5 : i / (segments - 1);
    const a = (f - 0.5) * arc;                   // 0 = straight up
    // Longest at the sides, a little shorter at the very top and at the two
    // ends of the arc, which is what makes the leaf round rather than a star.
    const shape = 0.82 + 0.18 * Math.cos(a * 0.9);
    const tear = rand() < 0.3 ? 0.66 + rand() * 0.18 : 0.92 + rand() * 0.08;
    const len = R * shape * tear;
    const halfA = (arc / segments) * 0.44;
    const steps = 5;
    ctx.beginPath();
    // Out along one edge…
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const p = along(a - halfA * (1 - t * 0.35), t, len);
      if (k === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
    }
    // …a forked tip…
    const notch = along(a, 0.86, len);
    ctx.lineTo(notch[0], notch[1]);
    // …and back down the other.
    for (let k = steps; k >= 0; k--) {
      const t = k / steps;
      const p = along(a + halfA * (1 - t * 0.35), t, len);
      ctx.lineTo(p[0], p[1]);
    }
    ctx.closePath();
    ctx.fill();
  }

  // The solid inner blade: the splits only run down the outer part.
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const a = (f - 0.5) * arc;
    const shape = 0.82 + 0.18 * Math.cos(a * 0.9);
    const p = along(a, 1, R * shape * 0.34);
    if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
  }
  ctx.lineTo(hx, hy);
  ctx.closePath();
  ctx.fill();
}
