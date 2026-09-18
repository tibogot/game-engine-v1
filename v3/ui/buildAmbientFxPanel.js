import { section, slider, color, toggle, dropdown, hint, text, info } from "./widgets.js";
import {
  AMBIENT_PRESETS, AMBIENT_MAX_PARTICLES, MOTION, sliceBudgets,
} from "../app/state/ambientFxState.js";
import { AMBIENT_ART } from "../render/ambient/ambientAtlas.js";

/**
 * Ambient FX settings — the selected effect, and the field as a whole. Built
 * into #ambientfx-panel.
 *
 * The panel is deliberately BUDGET-FORWARD: the live slot count, the pool it
 * comes out of and the tier are at the top of the field section, because the
 * whole design of this system is that those three numbers are the thing you
 * trade. A slider that changes them changes a uniform, never an allocation.
 *
 * Callbacks:
 *   onStateChanged()   any setting changed — re-pack the uniform rows
 *   onRenamed()        an effect's name changed
 */
export function buildAmbientFxPanel(root, { fxState, getSelected, setSelected, onStateChanged, onRenamed }) {
  const changed = () => onStateChanged?.();

  function build() {
    root.innerHTML = "";
    const idx = getSelected();
    const e = fxState.effects[idx];

    /* ── the whole mode ── */
    const on = section(root, "Ambient FX");
    toggle(on, fxState, "enabled", { label: "On", onChange: changed,
      hint: "The whole mode. Off costs nothing at all — no compute, no draw." });
    hint(on, "Butterflies and falling leaves, simulated on the GPU inside a box that follows the camera. One compute pass and one draw call however many effects are on.");

    /* ── which effect ── */
    const pick = section(root, "Effect");
    dropdown(pick, { get v() { return idx; }, set v(n) { setSelected(Number(n)); build(); } }, "v", {
      label: "Editing",
      options: fxState.effects.map((f, i) => [i, `${f.name}${f.enabled ? "" : " (off)"}`]),
    });
    toggle(pick, e, "enabled", {
      label: "Enabled",
      onChange: () => { changed(); build(); },
      hint: "An effect that is off gives its slots back to the pool for the others to use.",
    });
    text(pick, e, "name", { label: "Name", onChange: () => { build(); onRenamed?.(); } });
    dropdown(pick, e, "preset", {
      label: "Preset",
      options: [["", "—"], ...Object.entries(AMBIENT_PRESETS).map(([k, p]) => [k, p.name])],
      onChange: () => {
        const p = AMBIENT_PRESETS[e.preset];
        if (p) Object.assign(e, structuredClone(p));
        changed();
        build();
      },
      hint: "Loads that effect's whole character — motion, shape, colours, budget.",
    });

    /* ── what it is ── */
    const _tintShown = (e.tint ?? 0) > 0.001;
    const what = section(root, "What it is");
    dropdown(what, e, "motion", {
      label: "Motion",
      options: [[MOTION.wander, "Wander (flies)"], [MOTION.fall, "Fall (settles)"]],
      onChange: changed,
      hint: "Wander seeks a drifting heading and bobs on the wing beat. Fall drops to a terminal speed, tumbles on the way down, and lies on the ground where it lands.",
    });
    dropdown(what, e, "tile", {
      label: "Artwork",
      options: AMBIENT_ART.map((a, i) => [i, a.name]),
      onChange: changed,
      hint: "The painted image this effect wears. Drop a new single leaf or butterfly on transparency into public/textures/ and add it to AMBIENT_ART to get another.",
    });
    slider(what, e, "size", { label: "Size (m)", min: 0.01, max: 0.6, step: 0.005, onChange: changed,
      hint: "Tip to tip. A real butterfly is 0.06-0.10; an oak leaf about 0.12." });
    slider(what, e, "sizeVar", { label: "Size variation", min: 0, max: 0.8, step: 0.01, onChange: changed });
    slider(what, e, "tint", { label: "Tint over the art", min: 0, max: 1, step: 0.01, onChange: () => { changed(); if (((e.tint ?? 0) > 0.001) !== _tintShown) build(); },
      hint: "0 leaves the painting exactly as it is — the right setting for a hand-painted butterfly. Turn it up to recolour, which a drift of one photographed leaf wants." });
    if ((e.tint ?? 0) > 0.001) {
      color(what, e, "colorA", { label: "Tint (spine)", onChange: changed });
      color(what, e, "colorB", { label: "Tint (tip)", onChange: changed });
    }
    slider(what, e, "colorVar", { label: "Per-individual drift", min: 0, max: 1, step: 0.01, onChange: changed,
      hint: "A little hue and brightness variation per particle, so a swarm is not one image repeated." });
    slider(what, e, "translucency", { label: "Backlight", min: 0, max: 1.5, step: 0.01, onChange: changed,
      hint: "How much the sun glows through it from behind. A wing does; a dry leaf hardly." });

    /* ── how it moves ── */
    const mv = section(root, "How it moves");
    slider(mv, e, "speed", {
      label: e.motion === MOTION.fall ? "Fall speed (m/s)" : "Speed (m/s)",
      min: 0.1, max: 6, step: 0.05, onChange: changed,
      hint: e.motion === MOTION.fall ? "Terminal speed. A leaf is about 1-2." : "Cruise speed.",
    });
    slider(mv, e, "turbulence", { label: e.motion === MOTION.fall ? "Tumble swing" : "Wander", min: 0, max: 2, step: 0.01, onChange: changed,
      hint: "How far off a straight line it goes — the side-to-side stall of a falling leaf, or how erratically a butterfly turns." });
    slider(mv, e, "flapRate", { label: e.motion === MOTION.fall ? "Tumbles / s" : "Wing beats / s", min: 0.1, max: 16, step: 0.1, onChange: changed });
    slider(mv, e, "flapAmp", { label: "Hinge swing (rad)", min: 0, max: 1.4, step: 0.01, onChange: changed,
      hint: "How far the card folds at its spine. A butterfly's full wing stroke is around 1. Leaves sit at 0 and stay flat — a photographed leaf's midrib does not run down the middle of the image, so folding one looks wrong." });
    slider(mv, e, "windCoupling", { label: "Carried by wind", min: 0, max: 1.5, step: 0.01, onChange: changed,
      hint: "How much of the world's wind it takes. The wind itself is the Grass panel's." });
    slider(mv, e, "lifetime", { label: "Lifetime (s)", min: 2, max: 60, step: 0.5, onChange: changed,
      hint: "How long before it dies and respawns somewhere its rule allows. Spread ±35% per individual." });
    if (e.motion === MOTION.fall) {
      slider(mv, e, "settleTime", { label: "Lies on the ground (s)", min: 0, max: 40, step: 0.5, onChange: changed,
        hint: "A landed leaf holds its slot this long, then fades. Permanent leaf litter is a paint job, not a particle." });
    }

    /* ── where it lives ── */
    const wh = section(root, "Where it lives", false);
    hint(wh, "Painting comes next. For now an effect fills anywhere its height and slope allow.");
    slider(wh, e, "altMin", { label: "Lowest (m above ground)", min: 0, max: 40, step: 0.1, onChange: changed });
    slider(wh, e, "altMax", { label: "Highest (m above ground)", min: 0, max: 40, step: 0.1, onChange: changed,
      hint: "Leaves are born up in the canopy and fall out of it; butterflies stay low." });
    slider(wh, e, "slopeMinY", { label: "Flattest ground needed", min: 0, max: 1, step: 0.01, onChange: changed,
      hint: "0 = any slope including a cliff face, 1 = dead level only." });

    /* ── the budget ── */
    const cu = section(root, "Budget and culling");
    const slices = sliceBudgets(fxState.effects, AMBIENT_MAX_PARTICLES);
    const used = slices.total;
    info(cu, "Pool", `${used} / ${AMBIENT_MAX_PARTICLES} slots${used >= AMBIENT_MAX_PARTICLES ? " — full, budgets scaled down" : ""}`);
    info(cu, "This effect", `${slices.lengths[idx]} slots, ${Math.round(slices.lengths[idx] * fxState.tier)} live at tier ${fxState.tier.toFixed(2)}`);
    slider(cu, e, "budget", { label: "Budget (slots)", min: 0, max: 4000, step: 25, onChange: () => { changed(); build(); },
      hint: "This effect's slice of the pool. It is a hard ceiling, not a spawn rate — the rule decides how many of these slots are ever alive." });
    slider(cu, e, "fadeStart", { label: "Fades from (m)", min: 2, max: 120, step: 1, onChange: changed });
    slider(cu, e, "fadeEnd", { label: "Gone by (m)", min: 3, max: 140, step: 1, onChange: changed,
      hint: "Clamped inside the spawn box, so the field never ends on a visible wall. Raise Volume to push it out." });
    slider(cu, e, "minPixels", { label: "Smallest on screen (px)", min: 0, max: 12, step: 0.1, onChange: changed,
      hint: "Below this a card is not drawn at all. Something smaller than a pixel does not fade out, it crawls and sparkles." });

    /* ── the field ── */
    const fl = section(root, "The field", false);
    slider(fl, fxState, "tier", { label: "Quality tier", min: 0, max: 1, step: 0.05, onChange: () => { changed(); build(); },
      hint: "Scales every effect's live slots at once. Free to change — nothing is reallocated." });
    slider(fl, fxState, "volumeXZ", { label: "Volume across (m)", min: 20, max: 200, step: 5, onChange: changed,
      hint: "The camera-following box that has ambient FX in it. Everything outside is empty, so this is the draw distance." });
    slider(fl, fxState, "volumeY", { label: "Volume above ground (m)", min: 5, max: 120, step: 1, onChange: changed });
    slider(fl, fxState, "forwardOffset", { label: "Pushed ahead", min: 0, max: 0.45, step: 0.01, onChange: changed,
      hint: "How far ahead of the camera the box sits, as a fraction of its width. At speed the budget belongs on the ground you are about to reach." });
    slider(fl, fxState, "windMul", { label: "Wind ×", min: 0, max: 3, step: 0.05, onChange: changed });
  }

  build();
  return { rebuild: build };
}
