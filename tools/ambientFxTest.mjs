// ============================================================================
// AMBIENT FX — the parts that are wrong silently.
//
// Most of this system fails loudly: a broken integrator makes butterflies fly
// into the ground and you see it. Three things do not, and they are what this
// checks.
//
//   · THE SLICE ARITHMETIC. Slot i belongs to effect e because i falls inside
//     e's slice, and the GPU re-derives e by counting how many slice STARTS it
//     is past. If that derivation and sliceBudgets() ever disagree, particles
//     are simulated as one effect and shaded as another — which looks like a
//     colour bug, not an indexing bug, and would be hunted in the wrong file.
//
//   · THE SHADERS COMPILING AT ALL. Every TSL mistake in this mode (a bad
//     swizzle assign, an Fn returning an object, a method that is a function)
//     surfaces as a blank screen in a browser. The headless builder answers it
//     in a second.
//
//   · THE CARD'S TOPOLOGY. The geometry is built by hand, indexed by hand, and
//     drawn indirectly with a hand-written index count. An off-by-one there is
//     a torn wing nobody traces back to an index buffer.
// ============================================================================

// A canvas the atlas can draw into. The atlas is pure 2D path work whose only
// output is pixels nothing here looks at, so every call is a no-op — but it
// has to EXIST, because the atlas runs at construction time.
const ctx2d = new Proxy({}, {
  get: (t, k) => (k in t ? t[k] : (t[k] = () => {})),
  set: (t, k, v) => ((t[k] = v), true),
});
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }),
};
// The atlas loads its artwork through Image. Here every load FAILS, which is
// the case worth exercising headlessly: a missing file must fall back to a
// drawn placeholder and warn, never render nothing (v2's ambient store loaded
// a moth.png that was not in the repo and silently showed empty cards).
globalThis.Image = class {
  set src(_v) { queueMicrotask(() => this.onerror?.()); }
};

const { buildWGSL, buildComputeWGSL, THREE } = await import("./wgslBuilderStub.mjs");
const { sliceBudgets, dayWindow, createAmbientFxState, AMBIENT_MAX_PARTICLES, AMBIENT_EFFECT_COUNT, AMBIENT_ROWS, MOTION, TILE } =
  await import("../v3/app/state/ambientFxState.js");
const { stampScatterDensity } = await import("../v3/render/scatter/scatterDensity.js");
const { createCardGeometry } = await import("../v3/render/ambient/ambientShapes.js");
const { tileUv, ATLAS_TILES, AMBIENT_ART, ART_TILE } = await import("../v3/render/ambient/ambientAtlas.js");
const { AmbientFxSystem } = await import("../v3/render/ambient/ambientFxSystem.js");

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) fail++;
};

/* ── 1 · the slices ───────────────────────────────────────────────────────── */

const eff = (budget, enabled = true) => ({ budget, enabled });

{
  const { starts, lengths, total } = sliceBudgets([eff(100), eff(250), eff(0), eff(40)], 1000);
  check("slices are contiguous from zero", starts.join() === "0,100,350,350" && total === 390,
    `starts ${starts.join()} total ${total}`);
  check("lengths are the budgets when they fit", lengths.join() === "100,250,0,40", lengths.join());
}

{
  // A disabled effect keeps its index and gets a zero-length slice.
  const { starts, lengths } = sliceBudgets([eff(100), eff(250, false), eff(40)], 1000);
  check("a disabled effect takes no slots but keeps its index",
    lengths.join() === "100,0,40" && starts.join() === "0,100,100", `${starts.join()} / ${lengths.join()}`);
}

{
  // Over budget: everyone shrinks, nobody is starved, and the pool is not exceeded.
  const { lengths, total } = sliceBudgets([eff(6000), eff(6000), eff(6000)], 1000);
  check("over budget scales everyone down rather than starving the last",
    lengths.every((l) => l > 300) && total <= 1000, `${lengths.join()} total ${total}`);
}

{
  const state = createAmbientFxState();
  const { total } = sliceBudgets(state.effects, AMBIENT_MAX_PARTICLES);
  check("the shipped presets fit the pool", total > 0 && total <= AMBIENT_MAX_PARTICLES,
    `${total} of ${AMBIENT_MAX_PARTICLES}`);
  check("butterflies and leaves are the first two effects",
    state.effects[0].motion === MOTION.wander && state.effects[1].motion === MOTION.fall
    && state.effects[0].tile === TILE.butterflyBlue && state.effects[1].tile === TILE.leafMaple,
    `${state.effects[0].motion}/${state.effects[1].motion} tiles ${state.effects[0].tile}/${state.effects[1].tile}`);
  check("a painted butterfly keeps its own colour (tint 0)", state.effects[0].tint === 0,
    `tint ${state.effects[0].tint}`);
  check("leaves are flat — a photographed midrib is not down the middle",
    state.effects[1].flapAmp === 0, `flapAmp ${state.effects[1].flapAmp}`);
}

/* ── 2 · the GPU's slot → effect derivation ──────────────────────────────── */

/** Exactly what the compute does: count how many slice starts the slot is past. */
const effectOfGpu = (starts, i) => {
  let e = 0;
  for (let k = 1; k < starts.length; k++) e += i >= starts[k] ? 1 : 0;
  return e;
};

/** What the slices SAY the answer is, by looking the slot up directly. */
const effectOfTruth = (starts, lengths, i) => {
  for (let k = 0; k < starts.length; k++) {
    if (lengths[k] > 0 && i >= starts[k] && i < starts[k] + lengths[k]) return k;
  }
  return -1;   // beyond every slice — must never be treated as alive
};

{
  const cases = [
    [eff(100), eff(250), eff(0), eff(40)],
    [eff(0), eff(500), eff(1), eff(0)],          // an empty FIRST effect
    [eff(0), eff(0), eff(0), eff(7)],            // only the last one
    [eff(1), eff(1), eff(1), eff(1)],            // one slot each
    [eff(300, false), eff(300), eff(0), eff(2)], // one disabled
  ];
  let bad = null;
  for (const effects of cases) {
    const { starts, lengths, total } = sliceBudgets(effects, 1000);
    for (let i = 0; i < total; i++) {
      const truth = effectOfTruth(starts, lengths, i);
      if (effectOfGpu(starts, i) !== truth) { bad = { starts, lengths, i, truth, got: effectOfGpu(starts, i) }; break; }
    }
    if (bad) break;
  }
  check("the compute's slot → effect derivation agrees with the slices, for every live slot",
    bad === null, bad && JSON.stringify(bad));
}

{
  // Slots past the last slice must be held dead by the length test, whatever
  // effect the derivation names them. This is the guard that stops an unbudgeted
  // slot from spawning as (and being shaded as) the final effect.
  const { starts, lengths, total } = sliceBudgets([eff(10), eff(10)], 1000);
  const i = total + 5;
  const e = effectOfGpu(starts, i);
  const localIdx = i - starts[e];
  check("a slot past every slice fails the budget test", localIdx >= lengths[e],
    `slot ${i} → effect ${e}, local ${localIdx}, len ${lengths[e]}`);
}

{
  // The tier is the whole scalability story: it must shrink each slice, never
  // truncate the tail (which would delete the LAST effect instead of thinning
  // all of them).
  const { starts, lengths } = sliceBudgets([eff(400), eff(400)], 1000);
  const tier = 0.25;
  const live = [0, 1].map((e) =>
    Array.from({ length: lengths[e] }, (_, k) => k).filter((k) => k + 0.5 < lengths[e] * tier).length);
  check("tier 0.25 thins BOTH effects, not just the last",
    live[0] === 100 && live[1] === 100, live.join());
}

/* ── 2b · the time-of-day window ──────────────────────────────────────────── */

{
  // What the shader does with the window, replicated: t = fract(h01 - s01),
  // inside while t < len01. This is the check that the WRAP is right — a
  // night window is the normal case, not the exotic one.
  const activeAt = (start, end, soft, hour) => {
    const { s01, len01, soft01 } = dayWindow(start, end, soft);
    if (len01 >= 0.999) return 1;
    const t = ((hour / 24 - s01) % 1 + 1) % 1;
    const up = Math.min(1, Math.max(0, (t - 0) / soft01));
    const dn = Math.min(1, Math.max(0, (t - (len01 - soft01)) / soft01));
    const sm = (x) => x * x * (3 - 2 * x);
    return sm(up) * (1 - sm(dn));
  };

  check("start === end means ALWAYS, not a zero-length window",
    dayWindow(0, 0).len01 === 1 && dayWindow(9, 9).len01 === 1,
    `${dayWindow(0, 0).len01} / ${dayWindow(9, 9).len01}`);
  check("the default 0 → 24 is always", dayWindow(0, 24).len01 === 1, `${dayWindow(0, 24).len01}`);

  const night = dayWindow(19, 5, 1);
  check("a window that crosses midnight is TEN hours, not minus fourteen",
    Math.abs(night.len01 - 10 / 24) < 1e-9, `${night.len01 * 24} h`);

  check("fireflies (19 → 5) are out at midnight and at 03:00",
    activeAt(19, 5, 1, 0) > 0.99 && activeAt(19, 5, 1, 3) > 0.99,
    `${activeAt(19, 5, 1, 0).toFixed(3)} / ${activeAt(19, 5, 1, 3).toFixed(3)}`);
  check("and gone at noon", activeAt(19, 5, 1, 12) === 0, `${activeAt(19, 5, 1, 12)}`);

  check("butterflies (7 → 19) are out at noon and gone at midnight",
    activeAt(7, 19, 1.5, 12) > 0.99 && activeAt(7, 19, 1.5, 0) === 0,
    `${activeAt(7, 19, 1.5, 12).toFixed(3)} / ${activeAt(7, 19, 1.5, 0)}`);

  // The two ramps must not overlap, or the effect never reaches full strength
  // in the middle of its own window.
  const tiny = dayWindow(12, 13, 6);
  check("a soft edge wider than the window is clamped, not left to cross",
    tiny.soft01 <= tiny.len01 * 0.5 + 1e-9, `soft ${tiny.soft01} of len ${tiny.len01}`);
  const mid = (12 + 13) / 2;
  check("a one-hour window still reaches full strength in the middle",
    activeAt(12, 13, 6, mid) > 0.9, `${activeAt(12, 13, 6, mid).toFixed(3)}`);

  check("the soft edge is never zero (smoothstep needs a width)",
    dayWindow(8, 16, 0).soft01 > 0, `${dayWindow(8, 16, 0).soft01}`);
}

/* ── 2c · the paint channel ───────────────────────────────────────────────── */

{
  // "Clear this effect" wipes ONE channel and leaves the others painted. It
  // goes through the same stamp the brush does, at world radius.
  const res = 64, world = 1024;
  const data = new Uint8Array(res * res * 4);
  for (let c = 0; c < 4; c++) {
    stampScatterDensity(data, res, {
      cx: 0, cz: 0, radius: world, strength: 1, falloff: 0,
      worldSize: world, channel: c, erase: false,
    });
  }
  const any = (c) => { for (let i = c; i < data.length; i += 4) if (data[i] > 0) return true; return false; };
  check("filling paints the channel it was asked for", [0, 1, 2, 3].every(any));

  stampScatterDensity(data, res, {
    cx: 0, cz: 0, radius: world, strength: 1, falloff: 0,
    worldSize: world, channel: 1, erase: true, onlyChannel: true,
  });
  check("clearing one effect leaves the other three painted",
    !any(1) && any(0) && any(2) && any(3),
    [0, 1, 2, 3].map(any).join());
}

/* ── 3 · the card ─────────────────────────────────────────────────────────── */

{
  const { geometry, triangles } = createCardGeometry();
  const card = geometry.getAttribute("aCard");
  const idx = geometry.index;
  const n = card.count;

  check("the card is two hinged halves", n === 18 && triangles === 16, `${n} verts, ${triangles} tris`);
  check("the index count matches the triangles the indirect draw is told about",
    idx.count === triangles * 3 && idx.count === 48, `${idx.count}`);

  let inRange = true, sides = new Set(), uvBad = null;
  for (let i = 0; i < idx.count; i++) if (idx.getX(i) < 0 || idx.getX(i) >= n) inRange = false;
  for (let i = 0; i < n; i++) {
    sides.add(card.getX(i));
    const u = card.getY(i), v = card.getZ(i);
    if (u < 0 || u > 1 || v < 0 || v > 1) uvBad = `vert ${i}: u ${u} v ${v}`;
  }
  check("every index addresses a real vertex", inRange);
  check("both halves are present and mirrored", sides.size === 2 && sides.has(-1) && sides.has(1),
    [...sides].join());
  check("u and v stay in 0..1 (the atlas tile maths assumes it)", uvBad === null, uvBad ?? "");

  // Every vertex of a half must be reachable, or a wing has a hole in it.
  const used = new Set();
  for (let i = 0; i < idx.count; i++) used.add(idx.getX(i));
  check("no orphan vertices", used.size === n, `${used.size} of ${n} used`);

  check("the bounds are large enough that the CPU never culls the mesh",
    geometry.boundingSphere.radius > 1e4, `${geometry.boundingSphere.radius}`);
}

{
  // The atlas maths in the material has to agree with the atlas that drew it.
  const bad = [];
  for (let t = 0; t < ATLAS_TILES * ATLAS_TILES; t++) {
    const { u, v, size } = tileUv(t);
    const col = t % ATLAS_TILES, row = Math.floor(t / ATLAS_TILES);
    if (u !== col / ATLAS_TILES || v !== row / ATLAS_TILES || size !== 1 / ATLAS_TILES) bad.push(t);
  }
  check("every tile maps to its own quadrant", bad.length === 0, bad.join());
  check("the shipped tiles all exist in the atlas",
    Object.values(TILE).every((t) => t >= 0 && t < ATLAS_TILES * ATLAS_TILES)
    && AMBIENT_ART.length <= ATLAS_TILES * ATLAS_TILES,
    `${Object.values(TILE).join()} of ${AMBIENT_ART.length} art entries`);
  // ONE list. The state's TILE is re-exported from the atlas's manifest, so
  // adding art cannot leave two files disagreeing about which tile is a wing.
  check("the state's tile ids ARE the atlas manifest's", TILE === ART_TILE, "");
  check("every art entry has a url and a fallback shape",
    AMBIENT_ART.every((a) => a.url && a.name && a.key && a.fallback),
    AMBIENT_ART.map((a) => a.key).join());
}

{
  // Art that will not load must still leave a visible shape behind.
  const { createAmbientAtlas } = await import("../v3/render/ambient/ambientAtlas.js");
  const { texture, ready } = createAmbientAtlas();
  check("the atlas texture exists before any image has loaded", !!texture,
    "the material binds it on frame 0 and must never be rebuilt");
  const r = await ready;
  check("a missing image falls back to a drawn shape rather than nothing",
    r.failed.length === AMBIENT_ART.length && r.loaded === 0,
    `loaded ${r.loaded}, failed ${r.failed.length}`);
}

/* ── 4 · the shaders actually compile ─────────────────────────────────────── */

const dataTex = (v = 0) => {
  const t = new THREE.DataTexture(new Float32Array([v, v, v, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
};

let system = null;
try {
  system = new AmbientFxSystem({
    scene: new THREE.Scene(),
    renderer: { isWebGPURenderer: true },
    heightTex: dataTex(0),
    terrainNormalTex: dataTex(1),
    windTex: dataTex(0.5),
    worldSize: 2048,
    fx: createAmbientFxState(),
  });
  check("the system builds", true);
} catch (err) {
  check("the system builds", false, err.message);
}

if (system) {
  check("one shape class means ONE draw for every card effect",
    system.meshes.length === 1, `${system.meshes.length} meshes`);
  check("the card mesh never casts (a butterfly's shadow is not worth a cascade)",
    system.meshes.every((m) => !m.castShadow && !m.receiveShadow));
  check("the card mesh is not CPU frustum culled (the compute culls per particle)",
    system.meshes.every((m) => m.frustumCulled === false));
  check("the mesh sits at the origin — positions are absolute world metres",
    system.meshes.every((m) => m.position.lengthSq() === 0));
  check("the field allocates one uniform row block per effect",
    system.field.effectRows.length === AMBIENT_EFFECT_COUNT * AMBIENT_ROWS,
    `${system.field.effectRows.length}`);

  let wgsl = null;
  try {
    // The REAL card geometry, or `aCard` does not resolve and the builder
    // quietly substitutes a default — which compiles, and proves nothing.
    const probe = new THREE.Mesh(system.meshes[0].geometry, system.meshes[0].material);
    const builder = buildWGSL(system.meshes[0].material, { instanced: probe });
    wgsl = { v: builder.vertexShader ?? "", f: builder.fragmentShader ?? "" };
    check("the card material compiles to WGSL", wgsl.v.length > 0 && wgsl.f.length > 0,
      `vertex ${wgsl.v.length} chars, fragment ${wgsl.f.length} chars`);
  } catch (err) {
    check("the card material compiles to WGSL", false, err.message);
  }

  if (wgsl) {
    // The vertex stage must READ the compact list — that is the whole indirect
    // scheme. If this ever stops appearing, every card is drawing particle 0.
    check("the vertex stage reads the compacted particle list",
      /instanceIndex/.test(wgsl.v) || /instance_index/.test(wgsl.v), "");
    check("the fragment stage samples the atlas",
      /textureSample/.test(wgsl.f), "");
    // A discard in the fragment stage is what keeps these cards in the opaque
    // pass instead of needing blending and a sort.
    check("the card is alpha tested, not blended", /discard/.test(wgsl.f),
      "no discard — the cards would need the transparent pass");
    check("the material is opaque",
      system.meshes[0].material.transparent !== true, "");
    check("the vertex stage really read the card attribute (not a substituted default)",
      /aCard/.test(wgsl.v), "aCard missing — the builder used a stub geometry");
  }

  // The compute is where every integrator, the respawn and all four cull gates
  // live. A TSL mistake in there is a silent no-op at runtime, so it is the
  // single most valuable thing on this page to compile.
  try {
    const src = buildComputeWGSL(system.field.computeUpdate).computeShader ?? "";
    check("the simulation compute compiles to WGSL", src.length > 0, `${src.length} chars`);
    check("the compute compacts through an atomic", /atomicAdd/.test(src),
      "no atomic — the indirect instance count would never be written");
    check("the compute samples the world maps", /texture(Load|SampleLevel)/.test(src),
      "no texture read — the spawn rule and the ground would be invisible to it");
  } catch (err) {
    check("the simulation compute compiles to WGSL", false, err.message);
  }
}

/* ── 4b · the .v3proj round trip ──────────────────────────────────────────── */

{
  // The paint is a BLOB, and a blob that is not in projectIO's manifest is
  // silently dropped on save — you find out by reopening a world and finding
  // your butterflies gone. Nearly shipped exactly that.
  const { encodeProjectFile, decodeProjectFile } = await import("../v3/io/projectIO.js");
  const terrain = { worldSize: 100, heightmapSize: 4, splatSize: 4, maxHeight: 10 };
  const heightmap = new Float32Array(16).fill(1);
  const ambientPaint = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7 + 3) & 255);

  const state = createAmbientFxState();
  state.effects[0].area = "painted";
  state.effects[0].dayStart = 6.5;
  state.effects[1].tint = 0.42;
  state.tier = 0.6;
  state.volumeXZ = 111;
  const { effects, ...field } = state;

  const d = decodeProjectFile(encodeProjectFile({
    terrain, heightmap, ambientPaint,
    ambientEffects: structuredClone(effects),
    ambientField: field,
  }));

  const same = (a, b) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
  check("painted ambient FX survives the file byte-for-byte", same(d.ambientPaint, ambientPaint),
    d.ambientPaint ? `${d.ambientPaint.length} bytes` : "the blob came back NULL — not in the manifest");
  check("each effect's settings survive",
    d.ambientEffects?.[0]?.area === "painted" && d.ambientEffects[0].dayStart === 6.5
    && d.ambientEffects[1].tint === 0.42,
    JSON.stringify(d.ambientEffects?.[0]?.area));
  check("the field's settings survive",
    d.ambientField?.tier === 0.6 && d.ambientField.volumeXZ === 111,
    JSON.stringify(d.ambientField));

  // A world nobody opened the mode in must not carry 4 MB of zeros.
  const empty = decodeProjectFile(encodeProjectFile({ terrain, heightmap }));
  check("a file with no ambient FX carries no ambient blob",
    empty.ambientPaint === null && empty.ambientEffects === null,
    `${empty.ambientPaint} / ${empty.ambientEffects}`);
}

/* ── 5 · the fade window can never reach the box wall ─────────────────────── */

{
  // A particle killed for leaving the box while still fully visible is the one
  // way this design shows its seams, so syncFromState clamps fadeEnd inside it.
  if (system) {
    const fx = createAmbientFxState();
    fx.volumeXZ = 40;                      // smaller than the presets' fadeEnd
    fx.effects.forEach((e) => { e.fadeEnd = 500; e.fadeStart = 400; });
    system.syncFromState(fx);
    const rows = system.field.effectRows;
    const wall = fx.volumeXZ * 0.5;
    const worst = Math.max(...fx.effects.map((_, i) => rows[i * AMBIENT_ROWS + 5].y));
    check("the distance fade is clamped inside the box wall", worst < wall,
      `fadeEnd ${worst} vs wall ${wall}`);
    check("fadeStart stays below fadeEnd after clamping",
      fx.effects.every((_, i) => rows[i * AMBIENT_ROWS + 5].x < rows[i * AMBIENT_ROWS + 5].y));

    // Row 7 carries the area flag and the day window. An effect set to
    // "painted" must send 0, or it would ignore the paint it was just given.
    const fx2 = createAmbientFxState();
    fx2.effects[0].area = "painted";
    fx2.effects[1].area = "everywhere";
    fx2.effects[1].dayStart = 19; fx2.effects[1].dayEnd = 5;
    system.syncFromState(fx2);
    const r7 = (i) => system.field.effectRows[i * AMBIENT_ROWS + 7];
    check("the area flag reaches the uniform row", r7(0).x === 0 && r7(1).x === 1,
      `${r7(0).x} / ${r7(1).x}`);
    check("a night window reaches the uniform row as ten hours",
      Math.abs(r7(1).z - 10 / 24) < 1e-9, `${r7(1).z * 24} h`);
    check("butterflies ship with a daytime window, not always",
      r7(0).z < 0.999, `len01 ${r7(0).z}`);
  }
}

console.log(fail === 0 ? "\nambient FX: all checks passed" : `\nambient FX: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
