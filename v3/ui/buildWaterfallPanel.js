import { section, slider, color, toggle, dropdown, button, hint, numbers, info } from "./widgets.js";
import { WATERFALL_PRESETS } from "../app/state/waterfallState.js";

/**
 * Waterfall mode panel — what the next click places, the selected fall's shape,
 * and the look every fall shares (Realistic / Stylized, like River v2).
 * Built into #waterfall-panel.
 *
 * Callbacks:
 *   onLookChanged()    a shared look setting changed (push it to the materials)
 *   onOpenRiver()      jump to River v2 mode (where a followed look is edited)
 */
export function buildWaterfallPanel(root, { system, editor, onLookChanged, onOpenRiver }) {
  const widgets = [];
  const W = (w) => { widgets.push(w); return w; };
  const presetOptions = Object.entries(WATERFALL_PRESETS).map(([k, p]) => [k, p.label]);
  const deg = (r) => Math.round((r * 180) / Math.PI);

  function build() {
    root.innerHTML = "";
    widgets.length = 0;
    const place = editor.place;
    const f = editor.selected;
    const look = system.look;
    const onLook = () => onLookChanged?.();

    // ── Place ──
    const pl = section(root, "Place Waterfalls");
    W(dropdown(pl, place, "preset", {
      label: "Preset", options: presetOptions,
      onChange: () => { editor.applyPreset(place.preset); build(); },
      hint: "Sets the shape of the next fall (and of the selected one). Ribbon: a thin stream. Curtain: a wide sheet. Cascade: slow water that rides down ledges. Torrent: a river in spate thrown clear of the rock.",
    }));
    W(slider(pl, place, "width", { label: "Width (m)", min: 0.5, max: 80, step: 0.5 }));
    W(slider(pl, place, "speed", { label: "Lip speed (m/s)", min: 0.1, max: 12, step: 0.1,
      hint: "How fast the water goes over the edge. Faster throws it further from the rock." }));
    W(toggle(pl, place, "autoDirection", { label: "Face over the drop",
      hint: "The water leaves toward the steepest drop under the cursor. Off: away from the camera." }));
    W(toggle(pl, place, "attachToRivers", { label: "Snap to river ends",
      hint: "Clicking at the end of a River v2 river attaches the fall to it: the lip takes the river's position, level, heading, width and speed, follows every river edit, and the river's channel stops at the lip instead of filling past it." }));
    hint(pl, "Hover a cliff edge to preview · click = place · click a fall = select · <kbd>W</kbd>/<kbd>E</kbd> move/turn · <kbd>Del</kbd> · <kbd>Ctrl</kbd>+<kbd>D</kbd> · <kbd>Esc</kbd>",
      { html: true, className: "mode-hint" });
    info(pl, "In scene", `${system.falls.length} waterfall${system.falls.length === 1 ? "" : "s"} · 1 draw call`, { layout: "prop" });

    // ── Selected ──
    if (f) {
      const s = system.solved(f.id);
      const co = (k) => () => editor.edited(`wf-${f.id}-${k}`);
      const sel = section(root, `Waterfall #${f.id}`);
      if (s) {
        info(sel, "Drop", `${s.drop.toFixed(1)} m · ${s.impact.time.toFixed(1)} s · lands at ${s.impact.speed.toFixed(1)} m/s ${s.impact.onWater ? "in water" : "on ground"}`, { layout: "prop" });
      }
      const mouths = system.getRiverMouths?.() ?? [];
      const attached = f.river != null;
      if (attached || mouths.length) {
        // The dropdown binds to a string; "" is the free lip.
        const bind = { river: attached ? String(f.river) : "" };
        W(dropdown(sel, bind, "river", {
          label: "Fed by river",
          options: [["", "None (free lip)"], ...mouths.map((m) => [String(m.id), `River ${m.id} — ${m.width.toFixed(0)} m, ${m.speed.toFixed(1)} m/s`])],
          onChange: () => editor.attachSelected(bind.river === "" ? null : Number(bind.river)),
          hint: "Attached, the lip is the river's mouth and follows it. Width, speed and level come from the river; the river's channel stops at the lip.",
        }));
      }
      if (attached) {
        info(sel, "Lip", `from the river · ${f.width.toFixed(1)} m wide · ${f.speed.toFixed(1)} m/s · level ${f.py.toFixed(1)}`, { layout: "prop" });
      } else {
        W(slider(sel, f, "width", { label: "Width (m)", min: 0.5, max: 80, step: 0.5, onChange: co("width") }));
        W(slider(sel, f, "speed", { label: "Lip speed (m/s)", min: 0.1, max: 12, step: 0.1, onChange: co("speed") }));
      }
      W(slider(sel, f, "depth", { label: "Water depth (m)", min: 0.05, max: 3, step: 0.05, onChange: co("depth"),
        hint: "How much water goes over. With the speed it sets the flow: more flow = a thicker, whiter sheet." }));
      W(slider(sel, f, "spread", { label: "Spread", min: 0, max: 0.6, step: 0.01, onChange: co("spread"),
        hint: "How much the sheet fans out as it falls." }));
      W(slider(sel, f, "friction", { label: "Rock friction", min: 0, max: 3, step: 0.05, onChange: co("friction"),
        hint: "Speed lost where the water slides over rock. Low = it shoots off ledges; high = it clings and trickles." }));
      W(slider(sel, f, "foam", { label: "Whitewater", min: 0, max: 2, step: 0.05, onChange: co("foam") }));
      W(slider(sel, f, "crest", { label: "Crest (m)", min: 0, max: 20, step: 0.5, onChange: co("crest"),
        hint: "Metres of flat water carried upstream of the lip, lying over the river's own surface. This overlap is what joins the river to the fall — 0 starts the water at the edge." }));
      if (!attached) {
        const yawObj = { yaw: deg(f.yaw) };
        W(slider(sel, yawObj, "yaw", { label: "Direction °", min: -180, max: 180, step: 1,
          onChange: () => editor.edit({ yaw: (yawObj.yaw * Math.PI) / 180 }, { coalesce: `wf-${f.id}-yaw` }) }));
        W(numbers(sel, f, ["px", "py", "pz"], { label: "Lip", step: 0.05, onChange: () => editor.edited(), fieldTitles: ["X", "Y (water surface)", "Z"] }));
      }

      const act = section(root, "Actions");
      button(act, { title: "Duplicate (Ctrl+D)", onClick: () => editor.duplicateSelected() });
      button(act, { title: "Deselect (Esc)", onClick: () => editor.deselect() });
      button(act, { title: "Delete (Del)", onClick: () => editor.deleteSelected(), style: "color:#f66" });
    }

    // ── Look (shared) ──
    const lk = section(root, "Water look (all waterfalls)", !f);
    W(toggle(lk, look, "followRiver", { label: "Match River v2",
      onChange: () => { onLook(); build(); },
      hint: "Take the style and the stylized colours from River v2, so a river and the falls it pours over are the same water. Off: the old waterfall's own colours. Edit the river's in River v2 mode." }));
    const eff = system._effective;
    const stylized = eff.style === "stylized";
    if (look.followRiver) {
      info(lk, "Style", stylized ? "Stylized (from River v2)" : "Realistic (from River v2)", { layout: "prop" });
      if (onOpenRiver) button(lk, { title: "Edit the river look…", onClick: () => onOpenRiver() });
    } else {
      W(dropdown(lk, look, "style", {
        label: "Style", options: [["realistic", "Realistic"], ["stylized", "Stylized"]],
        onChange: () => { onLook(); build(); },
        hint: "Realistic: lit by the sun and sky, glassy at the lip, aerated white lower down, sunlight through thin water. Stylized: the old waterfall's look — flat colours, a cyan shimmer band, blobby foam and vertical drip streaks.",
      }));
    }

    if (!stylized) {
      hint(lk, "The sheet IS River v2's surface: the same shader, with the river's own colour, absorption, refraction, reflections and foam. There is nothing to match by hand — edit the water in River v2 mode and the falls follow. What is here is what a FALL has that a river does not.");
      W(slider(lk, look, "foam", { label: "Whitewater", min: 0, max: 2, step: 0.01, onChange: onLook,
        hint: "How hard the fall aerates. This drives the river shader's own whitewater, so a fall goes white the way a rapid does." }));
      W(slider(lk, look, "aerateTime", { label: "Glassy for (s)", min: 0.05, max: 3, step: 0.05, onChange: onLook,
        hint: "Seconds of fall before the water is fully aerated. Longer = a clear glassy tongue over the lip." }));
      W(slider(lk, look, "lipFoam", { label: "Lip churn", min: 0, max: 2, step: 0.01, onChange: onLook }));
      W(slider(lk, look, "reflect", { label: "Sky reflection", min: 0, max: 1, step: 0.01, onChange: onLook,
        hint: "How much of the river's sky reflection the sheet keeps. A fall is vertical, so you look across it at a grazing angle and it mirrors the sky — the same water and the same setting reading as a sheet of sky. Damping it is what makes the fall look like the river feeding it." }));
      W(slider(lk, look, "thinning", { label: "Thinning", min: 0, max: 1, step: 0.01, onChange: onLook,
        hint: "How much the sheet thins as it speeds up. Thin water absorbs less, so a thinning fall reads paler than the river feeding it. 0 keeps the river's own depth all the way down — the same water." }));

      const st = section(root, "Streaks & break-up", false);
      W(slider(st, look, "streakScale", { label: "Streaks per metre", min: 0.1, max: 4, step: 0.05, onChange: onLook }));
      W(slider(st, look, "streakRate", { label: "Streak length", min: 0.3, max: 6, step: 0.05, onChange: onLook,
        hint: "Pattern cycles per second of fall. Lower = longer streaks." }));
      W(slider(st, look, "streakContrast", { label: "Streak contrast", min: 0.2, max: 4, step: 0.05, onChange: onLook }));
      W(slider(st, look, "breakup", { label: "Break-up", min: 0, max: 1, step: 0.01, onChange: onLook,
        hint: "How much of a long fall parts into separate strands." }));
      W(slider(st, look, "breakupStart", { label: "Break-up starts (s)", min: 0, max: 8, step: 0.1, onChange: onLook }));
      W(slider(st, look, "breakupEnd", { label: "Fully broken (s)", min: 0.2, max: 12, step: 0.1, onChange: onLook }));
      W(slider(st, look, "veil", { label: "Outer veil", min: 0, max: 1, step: 0.01, onChange: onLook,
        hint: "The loose outer layer standing off the sheet." }));
      W(slider(st, look, "veilOffset", { label: "Veil distance (m)", min: 0, max: 2, step: 0.05, onChange: onLook }));
      W(slider(st, look, "edgeFade", { label: "Ragged sides (m)", min: 0.05, max: 4, step: 0.05, onChange: onLook }));
    } else {
      // The old waterfall's controls, in its own order.
      if (!look.followRiver) {
        W(color(lk, look, "styDarkColor", { label: "Dark", onChange: onLook }));
        W(color(lk, look, "styBodyColor", { label: "Body", onChange: onLook }));
        W(color(lk, look, "styShimmerColor", { label: "Shimmer", onChange: onLook }));
        W(color(lk, look, "styFoamColor", { label: "Foam", onChange: onLook }));
        W(color(lk, look, "styStreakColor", { label: "Drips", onChange: onLook }));
      }
      W(slider(lk, look, "styOpacity", { label: "Opacity", min: 0, max: 1, step: 0.01, onChange: onLook }));
      W(slider(lk, look, "styFlowSpeed", { label: "Flow speed", min: 0, max: 3, step: 0.01, onChange: onLook,
        hint: "How fast the pattern runs down the fall." }));
      W(slider(lk, look, "styDepthStrength", { label: "Colour variation", min: 0, max: 1, step: 0.01, onChange: onLook }));
      W(slider(lk, look, "styShimmer", { label: "Shimmer band", min: 0, max: 1, step: 0.01, onChange: onLook,
        hint: "The cyan band down the middle of the fall." }));
      W(slider(lk, look, "styFoamInner", { label: "Foam (wide)", min: 0, max: 1, step: 0.01, onChange: onLook }));
      W(slider(lk, look, "styFoamOuter", { label: "Foam (bright)", min: 0, max: 1, step: 0.01, onChange: onLook }));
      W(slider(lk, look, "styFoamThreshold", { label: "Foam amount", min: 0, max: 0.6, step: 0.005, onChange: onLook,
        hint: "Higher = more and bigger foam blobs." }));
      W(slider(lk, look, "styStreaks", { label: "Drips", min: 0, max: 1, step: 0.01, onChange: onLook,
        hint: "The vertical streaks running the whole height." }));
      W(slider(lk, look, "styStreakThreshold", { label: "Drip amount", min: 0, max: 0.6, step: 0.005, onChange: onLook }));
      W(slider(lk, look, "styFoamLength", { label: "Foam length (s)", min: 0.05, max: 4, step: 0.05, onChange: onLook,
        hint: "Seconds of fall the lip foam covers. The foam sits where the water leaves the edge, so it lands in the same place on a short fall and a tall one." }));
    }
    // ── Impact ──
    const ip = section(root, "Impact", false);
    W(toggle(ip, look, "capEnabled", { label: "Splash cap", onChange: onLook,
      hint: "A real dome of churned water where the fall lands, lit by the scene. One draw call for every waterfall." }));
    W(color(ip, look, "capColor", { label: "Cap foam", onChange: onLook }));
    W(color(ip, look, "capDeepColor", { label: "Cap trough", onChange: onLook }));
    W(slider(ip, look, "capSize", { label: "Cap size", min: 0.2, max: 3, step: 0.05, onChange: onLook,
      hint: "Multiplies the radius the landing implies (how wide the sheet is when it arrives, and how fast)." }));
    W(slider(ip, look, "capHeight", { label: "Cap height", min: 0.1, max: 2, step: 0.05, onChange: onLook,
      hint: "As a fraction of the radius." }));
    W(slider(ip, look, "capRelief", { label: "Boil", min: 0, max: 2, step: 0.01, onChange: onLook,
      hint: "How hard the surface of the mound churns." }));
    W(slider(ip, look, "capFlow", { label: "Boil speed", min: 0, max: 4, step: 0.05, onChange: onLook }));
    W(slider(ip, look, "capFoam", { label: "Cap whiteness", min: 0, max: 3, step: 0.05, onChange: onLook }));
    W(slider(ip, look, "capRim", { label: "Rim fade", min: 0.02, max: 1, step: 0.01, onChange: onLook }));
    W(slider(ip, look, "capOpacity", { label: "Cap opacity", min: 0, max: 1, step: 0.01, onChange: onLook }));

    W(toggle(ip, look, "poolEnabled", { label: "Flat pool foam", onChange: onLook,
      hint: "Flat foam painted on the water surface instead of the dome. Off by default: with the cap as well it reads as too much white." }));
    W(color(ip, look, "poolColor", { label: "Pool foam", onChange: onLook }));
    W(slider(ip, look, "poolSize", { label: "Pool size", min: 0.2, max: 3, step: 0.05, onChange: onLook,
      hint: "Multiplies the radius the landing itself implies (how wide the sheet is and how fast it arrives)." }));
    W(slider(ip, look, "poolOpacity", { label: "Pool opacity", min: 0, max: 1, step: 0.01, onChange: onLook }));
    W(slider(ip, look, "poolChurn", { label: "Churn", min: 0, max: 2, step: 0.01, onChange: onLook,
      hint: "The white water directly under the fall." }));
    W(slider(ip, look, "poolFlow", { label: "Outward speed", min: 0, max: 3, step: 0.01, onChange: onLook }));
    W(slider(ip, look, "poolRings", { label: "Rings", min: 0, max: 1, step: 0.01, onChange: onLook }));
    W(slider(ip, look, "poolEdge", { label: "Edge fade", min: 0, max: 1, step: 0.01, onChange: onLook }));

    W(toggle(ip, look, "sprayEnabled", { label: "Spray", onChange: onLook,
      hint: "Droplets thrown off the impact, simulated on the GPU and stretched along the way they travel." }));
    W(slider(ip, look, "sprayAmount", { label: "Spray amount", min: 0, max: 1, step: 0.01, onChange: onLook,
      hint: "Fraction of the droplet field in use. Lower really does less work, not just draws less." }));
    W(slider(ip, look, "spraySpeed", { label: "Spray speed (m/s)", min: 0.5, max: 15, step: 0.1, onChange: onLook }));
    W(slider(ip, look, "spraySize", { label: "Droplet size (m)", min: 0.02, max: 0.6, step: 0.01, onChange: onLook }));
    W(slider(ip, look, "sprayStretch", { label: "Motion stretch", min: 0, max: 6, step: 0.1, onChange: onLook }));
    W(slider(ip, look, "sprayOpacity", { label: "Spray opacity", min: 0, max: 1, step: 0.01, onChange: onLook }));

    W(toggle(ip, look, "mistEnabled", { label: "Mist", onChange: onLook,
      hint: "The cloud in the gorge: soft, rising, and lit — it glows when you look toward the sun through it." }));
    W(slider(ip, look, "mistAmount", { label: "Mist amount", min: 0, max: 1, step: 0.01, onChange: onLook }));
    W(slider(ip, look, "mistSize", { label: "Puff size (m)", min: 0.5, max: 12, step: 0.1, onChange: onLook }));
    W(slider(ip, look, "mistGrow", { label: "Puff growth", min: 1, max: 6, step: 0.05, onChange: onLook }));
    W(slider(ip, look, "mistRise", { label: "Rise (m/s)", min: 0, max: 4, step: 0.05, onChange: onLook }));
    W(slider(ip, look, "mistLife", { label: "Mist life (s)", min: 0.5, max: 15, step: 0.1, onChange: onLook }));
    W(slider(ip, look, "mistSpread", { label: "Mist spread", min: 0.2, max: 5, step: 0.05, onChange: onLook }));
    W(slider(ip, look, "mistOpacity", { label: "Mist opacity", min: 0, max: 0.6, step: 0.005, onChange: onLook }));
    W(slider(ip, look, "mistScatter", { label: "Sun scatter", min: 0, max: 4, step: 0.05, onChange: onLook,
      hint: "How much the mist lights up looking into the sun." }));
    W(slider(ip, look, "windX", { label: "Wind X (m/s)", min: -6, max: 6, step: 0.1, onChange: onLook }));
    W(slider(ip, look, "windZ", { label: "Wind Z (m/s)", min: -6, max: 6, step: 0.1, onChange: onLook }));
    W(slider(ip, look, "sprayDistance", { label: "Fade out at (m)", min: 40, max: 800, step: 10, onChange: onLook }));

    const ed = section(root, "Edges", false);
    W(slider(ed, look, "softDepth", { label: "Soft into ground (m)", min: 0, max: 4, step: 0.05, onChange: onLook }));
    W(slider(ed, look, "bottomFade", { label: "Bottom fade", min: 0, max: 0.5, step: 0.01, onChange: onLook }));
    W(slider(ed, look, "detailDistance", { label: "Detail distance (m)", min: 20, max: 1000, step: 10, onChange: onLook,
      hint: "Beyond this the fine noise is skipped (cheaper far away)." }));
  }

  build();
  return {
    refresh() { for (const w of widgets) w.refresh?.(); },
    rebuild: build,
  };
}
