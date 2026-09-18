import { section, slider, color, toggle, dropdown, hint, text, info, button } from "./widgets.js";
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
/** 18.5 → "18:30". */
function fmtHour(h) {
  const hh = Math.floor(((h % 24) + 24) % 24);
  const mm = Math.round((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function buildAmbientFxPanel(root, {
  fxState, getSelected, setSelected, onStateChanged, onRenamed,
  brush, onFill, onClear, getPainted,
}) {
  const changed = () => onStateChanged?.();

  function build() {
    root.innerHTML = "";
    const idx = getSelected();
    const e = fxState.effects[idx];

    /* ── the whole mode ── */
    const on = section(root, "Ambient FX");
    toggle(on, fxState, "enabled", { label: "On", onChange: changed,
      hint: "The whole mode. Off costs nothing at all — no compute, no draw." });
    hint(on, "Butterflies, falling leaves, dust and fireflies, simulated on the GPU inside a box that follows the camera. ONE compute pass however many effects are on, and one draw call per shape class in use — two at most.");

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
    const isCard = e.shape !== "billboard";
    const what = section(root, "What it is");
    dropdown(what, e, "shape", {
      label: "Drawn as",
      options: [["card", "Card (painted artwork)"], ["billboard", "Billboard (soft light)"]],
      onChange: () => { changed(); build(); },
      hint: "The ONE choice here that costs a draw call: cards are alpha-tested painted art in the opaque pass, billboards are additive light after it. Everything else about an effect is free.",
    });
    dropdown(what, e, "motion", {
      label: "Motion",
      options: [
        [MOTION.wander, "Wander (flies)"],
        [MOTION.fall, "Fall (settles)"],
        [MOTION.float, "Float (hangs)"],
      ],
      onChange: () => { changed(); build(); },
      hint: "Wander seeks a drifting heading and bobs on the wing beat. Fall drops to a terminal speed, tumbles on the way down, and lies on the ground where it lands.",
    });
    if (isCard) dropdown(what, e, "tile", {
      label: "Artwork",
      options: AMBIENT_ART.map((a, i) => [i, a.name]),
      onChange: changed,
      hint: "The painted image this effect wears. Drop a new single leaf or butterfly on transparency into public/textures/ and add it to AMBIENT_ART to get another.",
    });
    slider(what, e, "size", { label: "Size (m)", min: 0.01, max: 0.6, step: 0.005, onChange: changed,
      hint: "Tip to tip. A real butterfly is 0.06-0.10; an oak leaf about 0.12." });
    slider(what, e, "sizeVar", { label: "Size variation", min: 0, max: 0.8, step: 0.01, onChange: changed });
    if (isCard) slider(what, e, "tint", { label: "Tint over the art", min: 0, max: 1, step: 0.01, onChange: () => { changed(); if (((e.tint ?? 0) > 0.001) !== _tintShown) build(); },
      hint: "0 leaves the painting exactly as it is — the right setting for a hand-painted butterfly. Turn it up to recolour, which a drift of one photographed leaf wants." });
    if (!isCard || (e.tint ?? 0) > 0.001) {
      color(what, e, "colorA", { label: isCard ? "Tint (spine)" : "Colour", onChange: changed });
      color(what, e, "colorB", { label: isCard ? "Tint (tip)" : "Colour (second)", onChange: changed });
    }
    slider(what, e, "colorVar", { label: "Per-individual drift", min: 0, max: 1, step: 0.01, onChange: changed,
      hint: "A little hue and brightness variation per particle, so a swarm is not one image repeated." });
    if (isCard) {
      slider(what, e, "translucency", { label: "Backlight", min: 0, max: 1.5, step: 0.01, onChange: changed,
        hint: "How much the sun glows through it from behind. A wing does; a dry leaf hardly." });
    } else {
      slider(what, e, "glow", { label: "Brightness", min: 0, max: 5, step: 0.05, onChange: changed,
        hint: "Additive, so this really is how much light it adds to the scene." });
      slider(what, e, "pulseAmount", { label: "Blink depth", min: 0, max: 1, step: 0.01, onChange: changed,
        hint: "0 is a steady light \u2014 dust. Turn it up and it pulses, which is the whole of what makes a firefly a firefly." });
      if ((e.pulseAmount ?? 0) > 0.001) {
        slider(what, e, "pulseRate", { label: "Blinks / s", min: 0.05, max: 6, step: 0.05, onChange: changed });
      }
    }

    /* ── how it moves ── */
    const mv = section(root, "How it moves");
    slider(mv, e, "speed", {
      label: e.motion === MOTION.fall ? "Fall speed (m/s)" : "Speed (m/s)",
      min: 0.1, max: 6, step: 0.05, onChange: changed,
      hint: e.motion === MOTION.fall ? "Terminal speed. A leaf is about 1-2." : "Cruise speed.",
    });
    slider(mv, e, "turbulence", { label: e.motion === MOTION.fall ? "Tumble swing" : "Wander", min: 0, max: 2, step: 0.01, onChange: changed,
      hint: "How far off a straight line it goes — the side-to-side stall of a falling leaf, or how erratically a butterfly turns." });
    if (isCard) slider(mv, e, "flapRate", { label: e.motion === MOTION.fall ? "Tumbles / s" : "Wing beats / s", min: 0.1, max: 16, step: 0.1, onChange: changed });
    if (isCard) slider(mv, e, "flapAmp", { label: "Hinge swing (rad)", min: 0, max: 1.4, step: 0.01, onChange: changed,
      hint: "How far the card folds at its spine. A butterfly's full wing stroke is around 1. Leaves sit at 0 and stay flat — a photographed leaf's midrib does not run down the middle of the image, so folding one looks wrong." });
    if (isCard) slider(mv, e, "faceCamera", { label: "Turns to face you", min: 0, max: 1, step: 0.01, onChange: changed,
      hint: "A flat card seen edge-on is a one-pixel streak, and a butterfly in level flight holds its wings horizontal — so from a camera at the same height that is most of what you would see. This rolls it part of the way toward showing its face. 0 is pure physics; 1 always faces you and stops a leaf tumbling." });
    slider(mv, e, "windCoupling", { label: "Carried by wind", min: 0, max: 1.5, step: 0.01, onChange: changed,
      hint: "How much of the world's wind it takes. The wind itself is the Grass panel's." });
    slider(mv, e, "lifetime", { label: "Lifetime (s)", min: 2, max: 60, step: 0.5, onChange: changed,
      hint: "How long before it dies and respawns somewhere its rule allows. Spread ±35% per individual." });
    if (e.motion === MOTION.fall) {
      slider(mv, e, "settleTime", { label: "Lies on the ground (s)", min: 0, max: 40, step: 0.5, onChange: changed,
        hint: "A landed leaf holds its slot this long, then fades. Permanent leaf litter is a paint job, not a particle." });
    }

    /* ── the brush ── */
    if (brush) {
      const br = section(root, "Paint");
      dropdown(br, e, "area", {
        label: "Where",
        options: [["painted", "Only where painted"], ["everywhere", "Everywhere"]],
        onChange: () => { changed(); build(); },
        hint: "A new effect starts everywhere so the mode shows something when you open it. The first brush stroke switches it to painted.",
      });
      if (e.area === "painted" && getPainted && !getPainted(idx)) {
        hint(br, `Nothing is painted for ${e.name} yet, so none are showing. Drag on the terrain to paint some, or set Where to Everywhere.`);
      }
      hint(br, "Drag to paint this effect. Alt+drag erases it. Shift+wheel is the brush size, Alt+wheel its strength.");
      slider(br, brush, "radius", { label: "Brush size (m)", min: 1, max: 300, step: 1 });
      slider(br, brush, "strength", { label: "Strength", min: 0.05, max: 1, step: 0.01 });
      slider(br, brush, "falloff", { label: "Edge falloff", min: 0.2, max: 6, step: 0.1,
        hint: "How quickly the stroke fades toward its rim. The paint is a PROBABILITY, so a soft edge really does thin the swarm out rather than ending it on a line." });
      toggle(br, brush, "erase", { label: "Erase" });
      button(br, { title: `Fill the world with ${e.name}`, onClick: () => { onFill?.(idx); build(); } });
      button(br, { title: `Clear ${e.name}`, onClick: () => { onClear?.(idx); build(); } });
    }

    /* ── where it lives ── */
    const wh = section(root, "Where it lives", false);
    slider(wh, e, "altMin", { label: "Lowest (m above ground)", min: 0, max: 40, step: 0.1, onChange: changed });
    slider(wh, e, "altMax", { label: "Highest (m above ground)", min: 0, max: 40, step: 0.1, onChange: changed,
      hint: "Leaves are born up in the canopy and fall out of it; butterflies stay low." });
    slider(wh, e, "slopeMinY", { label: "Flattest ground needed", min: 0, max: 1, step: 0.01, onChange: changed,
      hint: "0 = any slope including a cliff face, 1 = dead level only." });

    /* ── when it is out ── */
    const wn = section(root, "When it is out", false);
    const always = e.dayStart === e.dayEnd || e.dayEnd - e.dayStart >= 24;
    info(wn, "Window", always ? "Always" : `${fmtHour(e.dayStart)} → ${fmtHour(e.dayEnd)}`);
    hint(wn, "Hours on the world's clock. It wraps, so 19 → 5 is a normal night window, and setting both the same means always. It gates SPAWNING, not opacity — an effect going out of season drains over a lifetime or two instead of the whole swarm dimming at once.");
    slider(wn, e, "dayStart", { label: "Out from (h)", min: 0, max: 24, step: 0.5, onChange: () => { changed(); build(); } });
    slider(wn, e, "dayEnd", { label: "Gone by (h)", min: 0, max: 24, step: 0.5, onChange: () => { changed(); build(); } });
    slider(wn, e, "daySoft", { label: "Soft edge (h)", min: 0, max: 6, step: 0.1, onChange: changed,
      hint: "How gradually it comes out and goes in at each end of the window." });

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
    slider(cu, e, "pixelFloor", { label: "Never smaller than (px)", min: 0, max: 24, step: 0.5, onChange: changed,
      hint: "Below this it GROWS in world space rather than shrinking away. A real butterfly is 8 cm, which at twenty metres is four pixels and throws the painted wing away. Growing it is a lie about its distance nobody can see \u2014 the birds in this engine have done it for years. 0 turns it off, which is what dust wants." });
    slider(cu, e, "minPixels", { label: "Smallest on screen (px)", min: 0, max: 12, step: 0.1, onChange: changed,
      hint: "Below this it is not drawn at all. The other half of the same problem: something smaller than a pixel does not fade out, it crawls. Leave at 0 for anything with a pixel floor above." });

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
