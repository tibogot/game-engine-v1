/**
 * The depth-water control set, shared by the Lake panel and River+'s "Depth" style.
 *
 * Both surfaces run the same shader, so they get the same knobs. They do NOT share
 * values — each passes its own state object. See v3/app/state/depthWaterState.js.
 *
 * The host panel supplies its own widget helpers (each panel file has its own copy,
 * matching the existing convention) so this module stays free of DOM specifics.
 *
 * @param {object} w        — widget helpers { section, slider, color, toggle, hint }
 * @param {HTMLElement} panel
 * @param {object} s        — a depthWaterState object
 * @param {object} globals  — { ssrMaster } accessor, shared by every water surface
 * @param {function} onChange
 * @param {object} [opts]
 * @param {string} [opts.label='this lake'] — suffix for the per-surface SSR toggle
 * @param {boolean} [opts.expandColor=true]
 */
export function buildDepthWaterControls(w, panel, s, globals, onChange, opts = {}) {
  const label = opts.label ?? "this lake";
  const on = onChange;

  const water = w.section(panel, "Water color", opts.expandColor ?? true);
  w.hint(water, "Beer-Lambert absorption, per channel. Red absorbs fastest, which is what turns deep water teal.");
  w.slider(water, s, "absorptionR", { label: "Absorb R", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(water, s, "absorptionG", { label: "Absorb G", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(water, s, "absorptionB", { label: "Absorb B", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(water, s, "absorptionScale", { label: "Absorb scale", min: 0, max: 60, step: 0.5, onChange: on });
  w.color (water, s, "inscatterTint", { label: "Inscatter tint", onChange: on });
  w.slider(water, s, "inscatterStrength", { label: "Inscatter", min: 0, max: 3, step: 0.01, onChange: on });
  w.slider(water, s, "depthDistance", { label: "Depth distance", min: 0.5, max: 120, step: 0.5, onChange: on,
    hint: "Metres of water over which absorption reaches full strength. A river wants ~3, a lake ~20." });

  const surf = w.section(panel, "Surface", false);
  w.slider(surf, s, "normalTiling",   { label: "Normal tiling", min: 0.005, max: 0.5, step: 0.005, onChange: on,
    hint: "Repeats per metre. 0.05 = one tile every 20 m." });
  w.slider(surf, s, "normalStrength", { label: "Wave strength", min: 0, max: 1, step: 0.01, onChange: on });
  if (opts.extraSurface) opts.extraSurface(surf);

  const optics = w.section(panel, "Refraction / reflection", false);
  w.slider(optics, s, "refractionStrength",  { label: "Refraction", min: 0, max: 0.4, step: 0.005, onChange: on,
    hint: "Beyond ~0.25 the wobble reads as jelly." });
  w.slider(optics, s, "fresnelScale",        { label: "Fresnel scale", min: 0, max: 2, step: 0.01, onChange: on,
    hint: "How strongly reflections take over at grazing angles. 0 = no reflection at all." });
  w.slider(optics, s, "skyReflectIntensity", { label: "Sky reflect", min: 0, max: 3, step: 0.01, onChange: on,
    hint: "Brightness of the sky-gradient fallback, used wherever SSR finds nothing. 0 removes it." });

  const ssr = w.section(panel, "Screen-space reflections", false);
  w.hint(ssr, "Reflects whatever is on screen — banks, mountains, trees — by marching the reflected ray against the depth buffer the refraction already grabbed. Off-screen rays fall back to the sky gradient above.");
  w.toggle(ssr, globals, "ssrMaster", { label: "SSR — all water", onChange: on,
    hint: "Master switch. Turns the ray march off on every lake AND river at once. This is the perf lever." });
  w.toggle(ssr, s, "ssrEnabled",     { label: `SSR — ${label}`, onChange: on });
  w.slider(ssr, s, "ssrStrength",    { label: "Strength", min: 0, max: 1, step: 0.01, onChange: on,
    hint: "0 = sky gradient only, 1 = full screen-space hit colour." });
  w.slider(ssr, s, "ssrMaxDistance", { label: "Max distance", min: 5, max: 400, step: 1, onChange: on,
    hint: "Metres the ray travels before giving up. Also sets the step size, so shorter is sharper." });
  w.slider(ssr, s, "ssrThickness",   { label: "Thickness", min: 0.05, max: 10, step: 0.05, onChange: on,
    hint: "Assumed depth of a surface. Too small and rays tunnel through thin geometry; too large and they snap onto surfaces they should pass behind." });
  w.slider(ssr, s, "ssrEdgeFade",    { label: "Edge fade", min: 0, max: 0.5, step: 0.005, onChange: on,
    hint: "Fades reflections near the screen border so they don't pop as geometry leaves the frame." });

  const glint = w.section(panel, "Sun glint", false);
  w.color (glint, s, "sunColor",       { label: "Sun color", onChange: on });
  w.slider(glint, s, "shininess",      { label: "Shininess", min: 1, max: 2000, step: 1, onChange: on });
  w.slider(glint, s, "glintStrength",  { label: "Glow", min: 0, max: 20, step: 0.1, onChange: on });
  w.slider(glint, s, "glintFresnel",   { label: "Fresnel influence", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(glint, s, "glintSpread",    { label: "Spread", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(glint, s, "glintShoreFade", { label: "Shore fade", min: 0, max: 1, step: 0.005, onChange: on,
    hint: "Metres of water over which glints fade in, so they don't crawl up the beach." });

  const shore = w.section(panel, "Shoreline", false);
  w.slider(shore, s, "shoreFade",      { label: "Shore fade", min: 0, max: 2, step: 0.01, onChange: on,
    hint: "Metres of water over which the surface fades in at the waterline." });
  w.slider(shore, s, "surfaceOpacity", { label: "Surface opacity", min: 0, max: 1, step: 0.01, onChange: on });

  const foam = w.section(panel, "Foam", false);
  w.hint(foam, "Widths are metres of vertical water depth, so the band keeps its size as the camera tilts. Off by default; when off, the noise is branched out entirely.");
  w.toggle(foam, s, "foamEnabled",      { label: "Enabled", onChange: on });
  w.color (foam, s, "foamColor",        { label: "Color", onChange: on });
  w.slider(foam, s, "foamWidth",        { label: "Band width", min: 0.02, max: 4, step: 0.01, onChange: on });
  w.slider(foam, s, "foamSharpness",    { label: "Sharpness", min: 0.2, max: 4, step: 0.01, onChange: on,
    hint: ">1 pulls the foam tighter against the shore." });
  w.slider(foam, s, "foamIntensity",    { label: "Intensity", min: 0, max: 2, step: 0.01, onChange: on });
  w.slider(foam, s, "foamCutoff",       { label: "Cutoff", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(foam, s, "foamTransition",   { label: "Edge softness", min: 0.01, max: 0.5, step: 0.005, onChange: on });
  w.slider(foam, s, "foamNoiseScale",   { label: "Cell scale", min: 0.05, max: 4, step: 0.05, onChange: on,
    hint: "Worley cells per metre." });
  w.slider(foam, s, "foamNoiseSpeed",   { label: "Drift speed", min: 0, max: 0.5, step: 0.005, onChange: on });
  w.slider(foam, s, "foamJitter",       { label: "Cell jitter", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(foam, s, "foamWarpScale",    { label: "Warp scale", min: 0.05, max: 2, step: 0.01, onChange: on });
  w.slider(foam, s, "foamWarpStrength", { label: "Warp strength", min: 0, max: 2, step: 0.01, onChange: on,
    hint: "Turns the cellular pattern into a ragged waterline. At 0 the foam reads as bubbles." });

  const pulse = w.section(panel, "Pulse rings", false);
  w.toggle(pulse, s, "pulseEnabled",    { label: "Enabled", onChange: on });
  w.color (pulse, s, "pulseColor",      { label: "Color", onChange: on });
  w.slider(pulse, s, "pulseSpeed",      { label: "Rings / sec", min: 0, max: 2, step: 0.01, onChange: on });
  w.slider(pulse, s, "pulseMaxDepth",   { label: "Travel depth", min: 0.2, max: 12, step: 0.1, onChange: on,
    hint: "Vertical depth a ring reaches before dying." });
  w.slider(pulse, s, "pulseRingWidth",  { label: "Ring width", min: 0.01, max: 1, step: 0.005, onChange: on });
  w.slider(pulse, s, "pulseIntensity",  { label: "Intensity", min: 0, max: 2, step: 0.01, onChange: on });
  w.slider(pulse, s, "pulse2Intensity", { label: "2nd ring intensity", min: 0, max: 2, step: 0.01, onChange: on });
  w.slider(pulse, s, "pulseStagger",    { label: "2nd ring offset", min: 0, max: 1, step: 0.01, onChange: on });
  w.slider(pulse, s, "pulseFade",       { label: "Fade", min: 0, max: 5, step: 0.01, onChange: on });
  w.slider(pulse, s, "pulseSharpness",  { label: "Sharpness", min: 0.2, max: 4, step: 0.01, onChange: on });
  w.slider(pulse, s, "pulseNoiseAmt",   { label: "Noise breakup", min: 0, max: 1, step: 0.01, onChange: on });
}
