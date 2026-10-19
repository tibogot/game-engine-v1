// THE DECALS PANEL (2026-10-19, you: "build the decals panel and be sure they look AAA like CoH"). In the game's
// Dev panel, on the real ground (the decals are baked into the ground cache: lit, shadowed and graded with the
// terrain — a lab's flat floor would lie). Each KIND of mark (ruts, tank tracks, paths, packed earth, swept
// yards, charred, debris — read from the slot names "<map> <kind>_<n>") is tuned LIVE, all its marks at once:
//
//   strength   × every mark's own opacity           size       × its box (the art keeps its metres: grain scales)
//   darkness   the tint's brightness (1 = as placed) warmth     red up / blue down (or the reverse)
//   relief     the normal map's strength             match      0 = the photo's colour, 1 = the ground's tone
//   edge       how soft its border                   solo / off / next: see one kind, A/B, fly to each mark
//
// SAVE writes the looks to localStorage and prints them; tools/algAbdiDecals.mjs reads them from
// public/textures/decals/<map>/kinds.json (the panel's "Copy" output pasted there) when it lays the decals.
const KEY = (map) => `alg-rts.decalLooks.${map}`;
const DEFAULT = { strength: 1, size: 1, darkness: 1, warmth: 0, relief: 1, match: null, edge: null };

export function buildDecalPanel(sec, { app, rtsCamera, mapId }) {
  const D = app.decals;
  if (!D?.decals?.length) { sec.hint("No decals on this map."); return; }
  const kindOf = (d) => (D.textures.slots[d.slot]?.name ?? "").split(" ").pop().replace(/_\d+$/, "");
  const base = new Map(D.decals.map((d) => [d, { ...d }]));
  const kinds = [...new Set(D.decals.map(kindOf))].filter(Boolean).sort();
  let looks = {};
  try { looks = JSON.parse(localStorage.getItem(KEY(mapId)) ?? "{}"); } catch { /* private window */ }
  // the file's looks (what the level was laid with) are the starting point
  fetch(`/textures/decals/${mapId}/kinds.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((f) => {
    for (const k of kinds) looks[k] = { ...DEFAULT, ...(f[k] ?? {}), ...(looks[k] ?? {}) };
    apply();
    panelRefresh();
  });
  for (const k of kinds) looks[k] ??= { ...DEFAULT };
  let kind = kinds[0], solo = false, off = false, cursor = -1;
  const L = () => looks[kind];

  const hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
  const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  function apply() {
    for (const [d, b] of base) {
      const k = kindOf(d), lk = looks[k] ?? DEFAULT;
      const show = !off && (!solo || k === kind);
      d.opacity = show ? Math.min(1, b.opacity * lk.strength) : 0;
      d.sx = b.sx * lk.size; d.sz = b.sz * lk.size;
      const t = parse(b.tint ?? "#ffffff"), w = lk.warmth;
      d.tint = hex([t[0] * lk.darkness * (1 + 0.25 * w), t[1] * lk.darkness * (1 + 0.04 * w), t[2] * lk.darkness * (1 - 0.3 * w)]);
      d.normalStrength = b.normalStrength * lk.relief;
      if (lk.match != null) d.match = lk.match;
      if (lk.edge != null) d.edgeFade = lk.edge;
    }
    D.markDirty();
  }
  let panelRefresh = () => {};
  const set = (k, v) => { L()[k] = v; apply(); };

  sec.select("Kind", { options: kinds.map((k) => [k, `${k} (${D.decals.filter((d) => kindOf(d) === k).length})`]), get: () => kind, set: (k) => { kind = k; cursor = -1; apply(); panelRefresh(); } });
  sec.toggle("Solo (only this kind)", { get: () => solo, set: (v) => { solo = v; apply(); } });
  sec.toggle("All decals off (A/B)", { get: () => off, set: (v) => { off = v; apply(); } });
  sec.slider("Strength", { min: 0, max: 2.5, step: 0.05, get: () => L().strength, set: (v) => set("strength", v) });
  sec.slider("Size", { min: 0.4, max: 3, step: 0.05, get: () => L().size, set: (v) => set("size", v), live: false });
  sec.slider("Darkness", { min: 0.3, max: 1.6, step: 0.02, get: () => L().darkness, set: (v) => set("darkness", v), fmt: (v) => (v < 1 ? `darker ×${v}` : v > 1 ? `lighter ×${v}` : "as placed") });
  sec.slider("Warmth", { min: -1, max: 1, step: 0.05, get: () => L().warmth, set: (v) => set("warmth", v) });
  sec.slider("Relief", { min: 0, max: 3, step: 0.05, get: () => L().relief, set: (v) => set("relief", v) });
  sec.slider("Ground match", { min: 0, max: 1, step: 0.05, get: () => L().match ?? base.values().next().value.match ?? 1, set: (v) => set("match", v) });
  sec.slider("Edge softness", { min: 0.02, max: 0.5, step: 0.01, get: () => L().edge ?? 0.16, set: (v) => set("edge", v) });
  sec.button("▶ Next mark of this kind", () => {
    const list = D.decals.filter((d) => kindOf(d) === kind);
    if (!list.length) return;
    cursor = (cursor + 1) % list.length;
    rtsCamera.focusOn(list[cursor].px, list[cursor].pz);
  }, { primary: true });
  sec.button("Reset this kind", () => { looks[kind] = { ...DEFAULT }; apply(); panelRefresh(); });
  const out = sec.readout();
  sec.button("Save (and copy for kinds.json)", () => {
    try { localStorage.setItem(KEY(mapId), JSON.stringify(looks)); } catch { /* private window */ }
    const txt = JSON.stringify(looks, null, 1);
    navigator.clipboard?.writeText(txt).catch(() => {});
    console.log(`[decals] ${mapId} looks:\n${txt}`);
    out.set(`saved — ${Object.keys(looks).length} kinds (copied: paste into public/textures/decals/${mapId}/kinds.json)`);
  });
  sec.hint("Tunes <b>every mark of the kind</b> at once, live, on the real ground. <b>Solo</b> shows one kind; <b>Next</b> flies the camera to each mark. The decals re-bake into the ground as you move a slider (a short blur).");
  return { setRefresh: (f) => (panelRefresh = f), looks: () => looks, apply };
}
