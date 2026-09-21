// ============================================================================
// STRESS BENCHMARK — what each INGREDIENT of a battle costs, not a battle.
//
// The combat rules, the enemy AI, the waves and the unit models will all
// change, so a scripted fight would measure code that is about to be replaced.
// What every version of this game will have is the same list of ingredients —
// soldiers on screen, smoke columns, fires, explosions, muzzle flashes,
// rockets in the air — so this spawns each one DIRECTLY, in amounts, away from
// the combat code, and prices it:
//
//   GPU  the frame's median time, measured at two resolutions ABOVE native so
//        vsync can never clamp it (at native the zoomed-out frame already sits
//        on the 16.7 ms floor), then extrapolated to native along the line
//        through the two. Two points, not a pixel ratio: a skinned soldier is
//        vertex/compute work that does not scale with pixels, smoke is almost
//        all pixels, and a single-resolution scale would misprice one of them.
//   CPU  the median of the game's own tick (app.frameStats.tickMs), sampled
//        at NATIVE resolution, where a frame is about one fixed sim step — at
//        the slow high-resolution frames the clock catches up 2-3 steps per
//        frame and the tick reads 2-3x what it costs in play.
//
// Each step is applied, settled, measured, CLEARED, and the baseline is
// re-measured at the end so thermal drift shows as a moving baseline instead
// of hiding inside a price. The page must stay focused: a background tab
// throttles requestAnimationFrame, and the run aborts rather than report it.
//
// Napalm is NOT in the automated run: it damages whatever it lands on, the
// player's base included. It is assembled from fire + smoke + craters, which
// are priced here one by one; the panel's Napalm button strikes on demand.
// ============================================================================

import * as THREE from "three";

/** Deterministic, so two runs place things identically. Math.imul keeps the low bits. */
function makeRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** The steps of the price list, in order. `cleanup` runs after each. */
const STEPS = [
  { key: "soldiers",    label: "Soldiers",          levels: [50, 150, 300], unit: "" },
  { key: "smoke",       label: "Smoke columns",     levels: [4, 12, 24],    unit: "" },
  { key: "fires",       label: "Fires",             levels: [5, 20, 50],    unit: "" },
  { key: "explosions",  label: "Explosions",        levels: [5, 20],        unit: "/s" },
  { key: "gunfire",     label: "Muzzle + impacts",  levels: [30, 120],      unit: "/s" },
  { key: "projectiles", label: "Rockets",           levels: [5, 20],        unit: "/s" },
];

export function createStressTest({ app, units, smoke, fire, fx, projectiles, napalm, rtsCamera }) {
  const center = new THREE.Vector3();
  let rng = makeRng();
  const spawned = [];          // stress soldiers
  let removeAfter = -1;        // frames until dead soldiers leave units.list
  const rates = { explosions: 0, gunfire: 0, projectiles: 0 };
  const acc = { explosions: 0, gunfire: 0, projectiles: 0 };
  const dummies = [];          // rocket targets: positions that never die
  let running = false;
  let abortReason = null;
  let lastResults = null;

  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;

  /** A random point within `r` metres of the centre, on the ground. */
  function around(r = 40) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * r;
    const x = center.x + Math.cos(a) * d;
    const z = center.z + Math.sin(a) * d;
    return { x, y: groundY(x, z), z };
  }

  function setCenterFromCamera() {
    const f = rtsCamera.getView().focus;
    center.set(f.x, 0, f.z);
  }

  // ── Ingredients ────────────────────────────────────────────────────────────

  /**
   * `n` soldiers on a grid around the centre, idle, on the player's side —
   * spaced like the game's own muster (3.2 radii). The first version used
   * 2.5 m, but a soldier's radius is 2.6 m: every one spawned inside its
   * neighbours and "idle" measured a crush with everyone pushing.
   */
  function addSoldiers(n) {
    const side = Math.ceil(Math.sqrt(n));
    const step = (units.radiusOf?.("soldier") ?? 2.6) * 3.2;
    for (let i = 0; i < n; i++) {
      const gx = (i % side) - side / 2, gz = Math.floor(i / side) - side / 2;
      const u = units.spawn("soldier", center.x + gx * step, center.z + gz * step, { team: "player" });
      if (u) spawned.push(u);
    }
  }

  /** Dead units stay in units.list (combat and the renderer skip them); ours
   *  are removed two frames later, once the renderer has hidden them. */
  function clearSoldiers() {
    for (const u of spawned) { u.hp = 0; u.alive = false; }
    if (spawned.length) removeAfter = 2;
  }

  function addSmoke(n) {
    for (let i = 0; i < n; i++) {
      const p = around(45);
      smoke.spawn({ x: p.x, z: p.z, kind: "screen", life: 600 });
    }
  }

  function addFires(n) {
    for (let i = 0; i < n; i++) {
      const p = around(40);
      fire.addFire(p.x, p.y + 0.6, p.z, 2.4, 600);
    }
  }

  function setRate(key, perSecond) { rates[key] = Math.max(0, perSecond); acc[key] = 0; }

  function ensureDummies() {
    if (dummies.length) return;
    for (let i = 0; i < 8; i++) {
      dummies.push({
        position: new THREE.Vector3(), alive: true, isStructure: false, hp: 1e9,
        takeDamage() {},   // a target that never dies: no wreck fire, no crater
      });
    }
  }

  function placeDummies() {
    ensureDummies();
    for (const d of dummies) { const p = around(35); d.position.set(p.x, p.y, p.z); }
  }

  const _from = new THREE.Vector3();
  function launchRocket() {
    const t = dummies[(rng() * dummies.length) | 0];
    const a = rng() * Math.PI * 2;
    const x = t.position.x + Math.cos(a) * 70, z = t.position.z + Math.sin(a) * 70;
    _from.set(x, groundY(x, z) + 3, z);
    projectiles.spawn(_from, t, 0, null);
  }

  function napalmHere() {
    const f = rtsCamera.getView().focus;
    const a = rng() * Math.PI * 2;
    napalm.strike({ x: f.x, z: f.z, dirX: Math.cos(a), dirZ: Math.sin(a) });
  }

  function clearAll() {
    clearSoldiers();
    smoke.clear();
    fire.clear();
    napalm.clear?.();
    for (const k of Object.keys(rates)) setRate(k, 0);
  }

  /** From the game tick: continuous spawners + deferred soldier removal. */
  function update(dt) {
    if (removeAfter >= 0 && --removeAfter < 0) {
      const gone = new Set(spawned);
      for (let i = units.list.length - 1; i >= 0; i--) if (gone.has(units.list[i])) units.list.splice(i, 1);
      spawned.length = 0;
    }
    if (rates.explosions > 0) {
      acc.explosions += rates.explosions * dt;
      while (acc.explosions >= 1) { acc.explosions--; const p = around(40); fx.explosion(p.x, p.y, p.z); }
    }
    if (rates.gunfire > 0) {
      acc.gunfire += rates.gunfire * dt;
      while (acc.gunfire >= 1) {
        acc.gunfire--;
        const p = around(40);
        fx.muzzle(p.x, p.y + 1.4, p.z);
        const q = around(40);
        fx.impact(q.x, q.y + 0.3, q.z);
      }
    }
    if (rates.projectiles > 0) {
      ensureDummies();
      acc.projectiles += rates.projectiles * dt;
      while (acc.projectiles >= 1) { acc.projectiles--; launchRocket(); }
    }
  }

  // ── Measurement ────────────────────────────────────────────────────────────

  /** Median frame time and game-tick time over `frames` frames; null if focus is lost. */
  function sample(frames = 90, warm = 30) {
    return new Promise((resolve) => {
      if (!document.hasFocus()) { abortReason = "the page lost focus"; resolve(null); return; }
      const dts = [], ticks = [];
      let n = 0, last = performance.now();
      const frame = () => {
        if (!document.hasFocus()) { abortReason = "the page lost focus"; resolve(null); return; }
        if (!running) { resolve(null); return; }
        const t = performance.now();
        if (n++ > warm) { dts.push(t - last); ticks.push(app.frameStats?.tickMs ?? 0); }
        last = t;
        if (n < frames + warm) requestAnimationFrame(frame);
        else resolve({ frame: median(dts), tick: median(ticks) });
      };
      requestAnimationFrame(frame);
    });
  }

  function setPixelRatio(p) {
    const R = app.renderer, el = R.domElement;
    R.setPixelRatio(p);
    R.setSize(el.clientWidth, el.clientHeight, false);
    return el.width * el.height;
  }

  /**
   * GPU at two resolutions above native; CPU at NATIVE. The sim runs on a
   * fixed 60 Hz clock, so a 40 ms high-resolution frame owes it 2-3 steps and
   * the tick there reads 2-3x what it costs in play — MEASURED: 300 idle
   * soldiers read 16 ms at 2x and 7.7 ms at native. At native one frame is
   * about one step, which is the number that matters.
   */
  async function measureHere(prs, nativePR) {
    const out = [];
    for (const pr of prs) {
      const px = setPixelRatio(pr);
      await wait(700);
      const s = await sample();
      if (!s) return null;
      out.push({ px, ...s });
    }
    setPixelRatio(nativePR);
    await wait(700);
    const c = await sample(60, 20);
    if (!c) return null;
    out.cpu = c.tick;
    return out;
  }

  function apply(step, level) {
    rng = makeRng(1000 + level);
    if (step === "soldiers") addSoldiers(level);
    else if (step === "smoke") addSmoke(level);
    else if (step === "fires") addFires(level);
    else if (step === "projectiles") { placeDummies(); setRate("projectiles", level); }
    else setRate(step, level);
  }

  /**
   * The price list. `views`: "out" (full zoom-out, the worst case) and/or
   * "close" (the default play zoom). `onProgress(text)` for the panel.
   * @returns {Promise<object|null>} null if aborted (see abortReason)
   */
  async function run({ views = ["out"], only = null, onProgress = () => {} } = {}) {
    const steps = only ? STEPS.filter((s) => only.includes(s.key)) : STEPS;
    if (running) return null;
    running = true;
    abortReason = null;
    clearAll();
    setCenterFromCamera();

    const el = app.renderer.domElement;
    const basePR = app.basePixelRatio ?? window.devicePixelRatio ?? 1;
    const nativePx = Math.round(el.clientWidth * basePR) * Math.round(el.clientHeight * basePR);
    const prs = [basePR * 1.5, basePR * 2.0];
    const edge = rtsCamera.params.edgeScroll;
    rtsCamera.params.edgeScroll = false;   // a resting pointer must not pan the view mid-sample

    const result = { center: { x: +center.x.toFixed(0), z: +center.z.toFixed(0) }, nativePx, views: {} };
    const total = views.length * (2 + steps.reduce((n, s) => n + s.levels.length, 0));
    let done = 0;
    const progress = (what) => onProgress(`${++done}/${total} — ${what}`);

    try {
      for (const view of views) {
        rtsCamera.setZoom(view === "out" ? 1 : 0.3);
        rtsCamera.focusOn(center.x, center.z);
        await wait(2500);
        const rows = [];
        progress(`${view}: baseline`);
        const base = await measureHere(prs, basePR);
        if (!base) break;
        for (const step of steps) {
          for (const level of step.levels) {
            progress(`${view}: ${step.label} ${level}${step.unit}`);
            apply(step.key, level);
            await wait(step.key === "soldiers" ? 2500 : 1500);
            const m = await measureHere(prs, basePR);
            clearAll();
            await wait(1500);
            if (!m) break;
            rows.push({ step: step.key, label: `${step.label} ${level}${step.unit}`, level, m });
          }
          if (abortReason || !running) break;
        }
        if (abortReason || !running) break;
        progress(`${view}: baseline again`);
        const baseEnd = await measureHere(prs, basePR);
        if (!baseEnd) break;
        result.views[view] = { base, baseEnd, rows: rows.map((r) => price(r, base, baseEnd, nativePx)) };
      }
    } finally {
      clearAll();
      rtsCamera.params.edgeScroll = edge;
      app.setRenderScale?.(app.renderScale, { persist: false });   // back to the player's scale
      running = false;
    }
    if (abortReason) return null;
    for (const v of Object.values(result.views)) {
      v.baseNative = nativeBase(v.base, nativePx);
      v.baseEndNative = nativeBase(v.baseEnd, nativePx);
    }
    lastResults = result;
    window.__NAM_STRESS = result;
    for (const [view, v] of Object.entries(result.views)) {
      console.log(`[stress] ${view}: baseline ${v.baseNative.toFixed(2)} → ${v.baseEndNative.toFixed(2)} ms (native est.)`);
      console.table(v.rows);
    }
    return result;
  }

  /** One row of the price list: the step's extra cost over the mean baseline, extrapolated to native. */
  function price(r, base, baseEnd, nativePx) {
    const at = (k) => (base[k].frame + baseEnd[k].frame) / 2;
    const d0 = r.m[0].frame - at(0), d1 = r.m[1].frame - at(1);
    const p0 = r.m[0].px, p1 = r.m[1].px;
    const gpuNative = d0 + (d1 - d0) * (nativePx - p0) / (p1 - p0);
    const tick = r.m.cpu - (base.cpu + baseEnd.cpu) / 2;
    return {
      what: r.label,
      "frame ms, native est.": +gpuNative.toFixed(2),
      "frame ms, 2x res": +d1.toFixed(2),
      "game CPU ms": +tick.toFixed(2),
      "per unit, native": +(gpuNative / r.level).toFixed(3),
    };
  }

  /** A baseline, extrapolated to native the same way as a price. */
  function nativeBase(b, nativePx) {
    const [a, c] = b;
    return a.frame + (c.frame - a.frame) * (nativePx - a.px) / (c.px - a.px);
  }

  return {
    update,
    // manual buttons
    soldiers(n = 50) { setCenterFromCamera(); addSoldiers(n); },
    smoke(n = 4) { setCenterFromCamera(); addSmoke(n); },
    fires(n = 10) { setCenterFromCamera(); addFires(n); },
    napalm: napalmHere,
    setGunfire(on) { setCenterFromCamera(); setRate("gunfire", on ? 60 : 0); setRate("explosions", on ? 6 : 0); placeDummies(); setRate("projectiles", on ? 8 : 0); },
    clear: clearAll,
    // benchmark
    run,
    stop() { running = false; },
    get running() { return running; },
    get abortReason() { return abortReason; },
    get lastResults() { return lastResults; },
    get soldierCount() { return spawned.length; },
  };
}
