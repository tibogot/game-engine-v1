/**
 * WHERE THE CASCADES SPLIT — and how sharp each one ends up.
 *
 * three's "practical" mode averages a uniform split with a logarithmic one, and
 * the logarithmic half is anchored on `camera.near`. Ours is 0.5 m, which drags
 * the log term down to almost nothing, so practical ends up behaving nearly
 * uniformly: the first split lands at roughly maxFar/3. That ties contact-shadow
 * sharpness to shadow RANGE through a single knob — every extra metre of reach
 * is paid for in near-field texels, which is why this editor sat at maxFar 80
 * for so long (see AUDIT #102 for the measurements).
 *
 * `nearAnchoredSplits` cuts that knot. You say where the FIRST cascade ends —
 * the distance past which you stop caring whether a foot touches the ground —
 * and the rest are spaced logarithmically from there out to maxFar. It is the
 * curve three's logarithmic mode already draws, anchored on a useful distance
 * instead of on the near plane.
 *
 * Why logarithmic spacing is the right curve: three sizes each cascade's shadow
 * map to the DIAGONAL of its slice (see `describeCascades`), so a cascade whose
 * far edge sits at distance d has a texel of `d · k / mapSize`. A screen pixel
 * at that same distance covers `d · k' / screenHeight`. Both grow linearly with
 * d, so at 2048 the texel at every cascade's far edge is about one screen pixel
 * — whatever the distance. Constant ratios between splits therefore spend the
 * shadow budget evenly, and the only real choice left is where the first one
 * ends.
 */

/**
 * Breaks for `CSMShadowNode`'s `customSplitsCallback`: normalised (fraction of
 * `far`), ascending, always ending at exactly 1 — the same contract as three's
 * own uniform/logarithmic/practical helpers.
 *
 * @param {number} amount     cascade count
 * @param {number} near       camera near plane (only used as a floor)
 * @param {number} far        the shadow range, i.e. min(camera.far, csm.maxFar)
 * @param {number} nearSplit  where cascade 0 ends, in metres
 * @param {Array<number>} [target] array to fill (three hands us its own)
 */
export function nearAnchoredSplits(amount, near, far, nearSplit, target = []) {
  target.length = 0;
  const n = Math.max(1, Math.round(Number(amount) || 1));
  const F = Number(far);
  if (n === 1 || !(F > 0)) {
    target.push(1);
    return target;
  }
  // The anchor has to clear the near plane and leave the last cascade some room:
  // a nearSplit at or past `far` would collapse every break onto 1.
  const lo = Math.min(
    Math.max(Number(nearSplit) || 0, Math.max(Number(near) || 0, 0.01) * 2),
    F * 0.75,
  );
  const ratio = F / lo;
  for (let i = 1; i < n; i++) {
    const edge = lo * Math.pow(ratio, (i - 1) / (n - 1));
    target.push(Math.min(edge / F, 1));
  }
  target.push(1);
  return target;
}

/**
 * What those splits actually cost in sharpness.
 *
 * three fits each cascade to a SQUARE box sized by the longest diagonal of its
 * frustum slice — either across the far face or corner-to-corner through the
 * whole slice, whichever is longer (`CSMShadowNode._updateShadowBounds`). The
 * texel size is that box divided by the map. Reported in metres.
 *
 * `pixel` is what one screen pixel covers at the cascade's far edge, so the
 * ratio texel/pixel says whether a cascade is over- or under-resolved: below 1
 * is sharper than the screen can show, far above 1 is visibly blocky.
 *
 * @returns {Array<{near:number, far:number, box:number, texel:number, pixel:number}>}
 */
export function describeCascades({ breaks, near, far, fov, aspect, mapSize, screenHeight = 1080 }) {
  const F = Number(far);
  const N = Math.max(Number(near) || 0.1, 0.01);
  const tan = Math.tan(((Number(fov) || 60) * Math.PI) / 360);
  const a = Number(aspect) || 1.78;
  const diag = Math.sqrt(1 + a * a);
  const map = Math.max(Math.round(Number(mapSize) || 1024), 1);
  const out = [];
  let prev = N;
  for (const b of breaks ?? []) {
    const end = F * b;
    // Half-extents of the slice's near and far faces.
    const hFar = tan * end;
    const hNear = tan * prev;
    const farFace = 2 * hFar * diag;
    const through = Math.sqrt((hFar + hNear) * (hFar + hNear) * diag * diag + (end - prev) * (end - prev));
    const box = Math.max(farFace, through);
    out.push({
      near: prev,
      far: end,
      box,
      texel: box / map,
      pixel: (end * 2 * tan) / Math.max(screenHeight, 1),
    });
    prev = end;
  }
  return out;
}

/** One line for the panel: `0–10 / 10–39 / 39–150 m · 1.2 / 4.6 / 17 cm per texel`. */
export function formatCascades(cascades) {
  if (!cascades?.length) return "—";
  const m = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const cm = (v) => {
    const c = v * 100;
    return c >= 10 ? Math.round(c) : c.toFixed(1);
  };
  const bands = cascades.map((c) => `${m(c.near)}–${m(c.far)}`).join(" / ");
  const texels = cascades.map((c) => cm(c.texel)).join(" / ");
  return `${bands} m · ${texels} cm per texel`;
}
