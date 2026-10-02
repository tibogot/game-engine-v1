// THE GROUND LAB (ground-lab.html; you, 2026-10-02: "CoH's terrain has way
// more detail — let's make nice RTS terrain; a lab so we don't waste time with
// the game loader"). The REAL map, light and camera (booted lean, as the
// battle lab), with a panel over the terrain's paint layers, LIVE:
//
//   per layer   its photo set (any folder under public/textures/ground/ that
//               tools/fetchGroundSets.mjs listed), its scale (m a tile), the
//               normal / AO / roughness strength, a tint
//   the blend   height-blend and its contrast (the layers meet along their
//               own pebbles), the macro variation (big patches) and its scale
//   the cache   the detail pass (ground cache DETAIL) strength
//   views       a few fixed views to compare: play zoom on the piste, close
//               on the post, a village, the hills, the oasis
//   Copy        the settings as JSON, to bake into the map (a tool patches it)
//
// Nothing here saves: the map file is only changed when we bake.
import { PLAY } from "./layout.js";

const VIEWS = [
  { name: "Piste (play)", x: 40, z: 170, zoom: 0.35 },
  { name: "Piste (close)", x: 40, z: 170, zoom: 0.05 },
  { name: "Post", x: 90, z: 213, zoom: 0.25 },
  { name: "Village", x: 150, z: 60, zoom: 0.3 },
  { name: "Oasis", x: 132, z: 128, zoom: 0.3 },
  { name: "Hills", x: -150, z: -150, zoom: 0.45 },
  { name: "Wide", x: 0, z: 60, zoom: 0.9 },
];

export async function createGroundLab(app) {
  const D = window.__V3_DEBUG;
  const lib = D?.textureLib, ov = D?.splatOverlay, gc = app.groundCache;
  if (!lib || !ov) throw new Error("ground lab: no texture library (window.__V3_DEBUG)");
  const sets = await fetch("/textures/ground/sets.json").then((r) => (r.ok ? r.json() : { sets: [] })).catch(() => ({ sets: [] }));
  const restale = () => gc?.markAllStale?.();

  // ── BEFORE / AFTER (you, 2026-10-02: "a control to really see the
  // difference"). BEFORE = the map as the game has it (captured at load);
  // AFTER = what the lab has built. Each side: the layers (photos, scale,
  // relief…), the blend and macro uniforms, and the lab's extra ground pieces
  // (`extras`: tracks, splats — shown only on AFTER). ──
  const extras = [];      // { setVisible(on) } — the lab's added ground layers
  const snapUniforms = () => ({
    hb: ov.uHeightBlend.value, hc: ov.uHeightContrast.value, ms: ov.uMacroStrength.value, msc: ov.uMacroScale.value,
    mts: ov.uMacroTexStrength.value, mtsc: ov.uMacroTexScale.value, det: gc?.uDetail.value ?? 0,
  });
  const putUniforms = (u) => {
    ov.uHeightBlend.value = u.hb; ov.uHeightContrast.value = u.hc; ov.uMacroStrength.value = u.ms; ov.uMacroScale.value = u.msc;
    ov.uMacroTexStrength.value = u.mts; ov.uMacroTexScale.value = u.mtsc; if (gc) gc.uDetail.value = u.det;
  };
  const before = { layers: lib.exportData(), u: { ...snapUniforms(), mts: 0 } };
  let after = null, showing = "after", busy = false;
  async function show(which) {
    if (busy || which === showing) return;
    busy = true;
    if (showing === "after") after = { layers: lib.exportData(), u: snapUniforms() };
    const S = which === "before" ? before : after;
    if (S) {
      await lib.importData(S.layers);
      putUniforms(S.u);
    }
    for (const x of extras) x.setVisible(which === "after");
    showing = which;
    restale();
    busy = false;
    render();
  }
  const state = lib.slots.map((s, i) => ({
    name: s.name, set: null,
    uv: lib.slotUniforms[i].uUVScale.value, normal: lib.slotUniforms[i].uNormalStr.value,
    ao: lib.slotUniforms[i].uAOStr.value, rough: lib.slotUniforms[i].uRoughStr.value,
    tint: "#" + lib.slotUniforms[i].uTint.value.getHexString(),
  }));
  const W = app.worldSize ?? 1024;

  async function setSet(i, slug) {
    const s = sets.sets.find((x) => x.slug === slug);
    if (!s) return;
    const base = `/textures/ground/${slug}/${slug}`;
    await Promise.all([
      lib.loadAlbedoFromUrl(i, `${base}_diff_1k.jpg`),
      s.maps.includes("nor_gl") ? lib.loadNormalFromUrl(i, `${base}_nor_gl_1k.jpg`) : null,
      s.maps.includes("rough") ? lib.loadRoughnessFromUrl(i, `${base}_rough_1k.jpg`) : null,
      s.maps.includes("ao") ? lib.loadAOFromUrl(i, `${base}_ao_1k.jpg`) : null,
    ]);
    state[i].set = slug;
    restale();
  }

  // ── The macro photo (splatOverlay setMacroImage): an aerial set's luminance
  // ratio, 512², laid over every layer at tens of metres a tile. ──
  let macroSet = null;
  async function setMacro(slug) {
    macroSet = slug || null;
    if (!slug) { ov.uMacroTexStrength.value = 0; restale(); return; }
    const N = ov.macroImageSize;
    const img = new Image();
    img.src = `/textures/ground/${slug}/${slug}_diff_1k.jpg`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, N, N);
    const px = g.getImageData(0, 0, N, N).data;
    const lum = new Float32Array(N * N);
    let mean = 0;
    for (let i = 0; i < N * N; i++) {
      // sRGB → linear luminance
      const l = (v) => (v / 255) ** 2.2;
      lum[i] = 0.2126 * l(px[i * 4]) + 0.7152 * l(px[i * 4 + 1]) + 0.0722 * l(px[i * 4 + 2]);
      mean += lum[i];
    }
    mean /= N * N;
    const bytes = new Uint8Array(N * N);
    for (let i = 0; i < N * N; i++) bytes[i] = Math.max(0, Math.min(255, Math.round((lum[i] / mean) * 0.5 * 255)));
    ov.setMacroImage(bytes);
    if (ov.uMacroTexStrength.value === 0) ov.uMacroTexStrength.value = 0.6;
    restale();
    render();
  }

  // ── The panel ─────────────────────────────────────────────────────────────
  const css = document.createElement("style");
  css.textContent = `
    #glab { position: fixed; top: 10px; left: 10px; z-index: 60; width: 300px; max-height: calc(100vh - 20px); overflow-y: auto;
      background: rgba(22, 17, 12, 0.92); border: 1px solid #4a3c2c; border-radius: 4px; padding: 10px 12px;
      color: #e8dcc4; font: 12px/1.45 "Segoe UI", system-ui, sans-serif; }
    #glab h1 { margin: 0 0 4px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #f0d9a8; }
    #glab h2 { margin: 10px 0 4px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #a8987c; }
    #glab .row { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
    #glab .row > span:first-child { width: 62px; color: #c9b998; flex: none; }
    #glab input[type=range] { flex: 1; min-width: 0; }
    #glab b { font-variant-numeric: tabular-nums; min-width: 38px; text-align: right; font-weight: 600; }
    #glab select { flex: 1; min-width: 0; background: #2a2118; color: #eadfc8; border: 1px solid #4a3c2c; font: inherit; }
    #glab .layer { border-top: 1px solid #3a2e22; padding-top: 6px; margin-top: 6px; }
    #glab .layer .t { color: #f0d9a8; font-weight: 600; }
    #glab .btns { display: flex; flex-wrap: wrap; gap: 4px; }
    #glab button { flex: 1 1 auto; padding: 4px 6px; font: 11px "Segoe UI", system-ui; cursor: pointer; background: #2f251b; color: #e2d4b6; border: 1px solid #54432f; border-radius: 3px; }
    #glab button:hover { background: #3c2f22; }
    #glab .ab button { padding: 7px 6px; font-weight: 600; }
    #glab button.on { background: #8a3a22; border-color: #c8603c; color: #fff; }
    #glab .note { color: #8f8068; font-size: 11px; margin-top: 6px; }
  `;
  document.head.appendChild(css);
  const el = document.createElement("div");
  el.id = "glab";
  document.body.appendChild(el);

  const slider = (key, label, min, max, step, value, fmt = (v) => v) =>
    `<div class="row"><span>${label}</span><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><b>${fmt(value)}</b></div>`;
  const tile = (uv) => `${(W / uv).toFixed(1)} m`;

  function render() {
    el.innerHTML = `
      <h1>Ground Lab</h1>
      <div class="btns ab"><button data-ab="before" class="${showing === "before" ? "on" : ""}">◀ Before (the game now)</button><button data-ab="after" class="${showing === "after" ? "on" : ""}">After (the lab) ▶</button></div>
      <div class="note">Key <b>B</b> flips between them.</div>
      <div class="note">The game's own terrain, live. Nothing is saved until we bake it.</div>
      <h2>Views</h2>
      <div class="btns">${VIEWS.map((v, i) => `<button data-view="${i}">${v.name}</button>`).join("")}</div>
      <h2>Blend</h2>
      ${slider("hb", "Height", 0, 1, 0.01, ov.uHeightBlend.value)}
      ${slider("hc", "Contrast", 0.01, 1, 0.01, ov.uHeightContrast.value)}
      ${slider("ms", "Macro", 0, 0.5, 0.01, ov.uMacroStrength.value)}
      ${slider("msc", "Macro m", 10, 400, 5, ov.uMacroScale.value)}
      ${gc ? slider("det", "Detail", 0, 2, 0.05, gc.uDetail.value) : ""}
      <h2>Macro photo</h2>
      <div class="row"><span>Photo</span><select data-macro="1"><option value="">(none)</option>${sets.sets.map((x) => `<option value="${x.slug}"${macroSet === x.slug ? " selected" : ""}>${x.aerial ? "★ " : ""}${x.slug}</option>`).join("")}</select></div>
      ${slider("mts", "Strength", 0, 1, 0.02, ov.uMacroTexStrength.value)}
      ${slider("mtsc", "Tile m", 10, 300, 5, ov.uMacroTexScale.value)}
      ${app.algSplats?.strips ? `<h2>Pistes (ruts)</h2>
      ${slider("rw", "Rut m", 0.1, 0.6, 0.01, app.algSplats.stripStyle.rut)}
      ${slider("rr", "Wander m", 0, 2, 0.05, app.algSplats.stripStyle.wander)}
      ${slider("ro", "Opacity", 0, 1, 0.02, app.algSplats.stripStyle.opacity)}
      ${slider("rn", "Relief", 0, 3, 0.05, app.algSplats.stripStyle.normal)}` : ""}
      <h2>Layers</h2>
      ${state.map((s, i) => `<div class="layer" data-i="${i}">
        <div class="t">${i} · ${s.name}</div>
        <div class="row"><span>Photo</span><select data-set="${i}"><option value="">(as in the map)</option>${sets.sets.map((x) => `<option value="${x.slug}"${s.set === x.slug ? " selected" : ""}>${x.slug}</option>`).join("")}</select></div>
        ${slider(`uv${i}`, "Tile", 4, 400, 1, s.uv, () => tile(s.uv))}
        ${slider(`n${i}`, "Normal", 0, 4, 0.05, s.normal)}
        ${slider(`ao${i}`, "AO", 0, 2, 0.05, s.ao)}
        <div class="row"><span>Tint</span><input type="color" data-tint="${i}" value="${s.tint}"></div>
      </div>`).join("")}
      <h2>Bake</h2>
      <div class="btns"><button data-act="copy">Copy settings</button></div>
      <div class="note">Sets: ${sets.sets.length} (tools/fetchGroundSets.mjs).</div>`;
  }
  render();

  el.addEventListener("input", (e) => {
    const t = e.target, k = t.dataset.k, v = Number(t.value);
    if (t.dataset.tint) { const i = +t.dataset.tint; state[i].tint = t.value; lib.setTint(i, t.value); restale(); return; }
    if (!k) return;
    if (k === "hb") ov.uHeightBlend.value = v;
    else if (k === "hc") ov.uHeightContrast.value = v;
    else if (k === "ms") ov.uMacroStrength.value = v;
    else if (k === "msc") ov.uMacroScale.value = v;
    else if (k === "det") gc.uDetail.value = v;
    else if (k === "mts") ov.uMacroTexStrength.value = v;
    else if (k === "mtsc") ov.uMacroTexScale.value = v;
    else if (k === "rw" || k === "rr" || k === "ro" || k === "rn") {
      app.algSplats?.restyleStrips({ [{ rw: "rut", rr: "wander", ro: "opacity", rn: "normal" }[k]]: v });
      t.nextElementSibling.textContent = v;
      return;
    }
    else {
      const m = /^(uv|n|ao)(\d)$/.exec(k);
      if (!m) return;
      const i = +m[2];
      if (m[1] === "uv") { state[i].uv = v; lib.setUVScale(i, v); }
      if (m[1] === "n") { state[i].normal = v; lib.setNormalStr(i, v); }
      if (m[1] === "ao") { state[i].ao = v; lib.setAOStr(i, v); }
    }
    t.nextElementSibling.textContent = k.startsWith("uv") ? tile(v) : v;
    restale();
  });
  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.set) setSet(+t.dataset.set, t.value);
    if (t.dataset.macro) setMacro(t.value);
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.view) {
      const v = VIEWS[+b.dataset.view];
      app.rtsCamera?.focusOn(Math.max(PLAY.x0, Math.min(PLAY.x1, v.x)), Math.max(PLAY.z0, Math.min(PLAY.z1, v.z)));
      app.rtsCamera?.setZoom(v.zoom);
    }
    if (b.dataset.ab) { show(b.dataset.ab); return; }
    if (b.dataset.act === "copy") {
      const out = JSON.stringify({ layers: state, blend: { heightBlend: ov.uHeightBlend.value, contrast: ov.uHeightContrast.value, macroStrength: ov.uMacroStrength.value, macroScale: ov.uMacroScale.value }, detail: gc?.uDetail.value, macro: { set: macroSet, strength: ov.uMacroTexStrength.value, scale: ov.uMacroTexScale.value } }, null, 1);
      navigator.clipboard?.writeText(out).catch(() => {});
      console.log("[ground lab]", out);
      b.textContent = "Copied (and in the console)";
    }
  });

  // The piste ruts: shown on AFTER only.
  if (app.algSplats?.setStrips) extras.push({ setVisible: (on) => app.algSplats.setStrips(on) });

  // THE PROPOSAL so far (After starts with it; Before is the game as it is).
  await setMacro("dirt_aerial_02");
  ov.uMacroTexStrength.value = 0.7; ov.uMacroTexScale.value = 45;
  for (const i of [0, 2, 6]) { lib.setNormalStr(i, 2.5); state[i].normal = 2.5; }
  restale();
  render();

  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.target?.matches?.("input, textarea, select")) return;
    if (e.key?.toLowerCase() === "b") show(showing === "after" ? "before" : "after");
  });

  return { show, extras, get showing() { return showing; }, state, setSet, setMacro, sets, views: VIEWS, get macro() { return macroSet; } };
}
