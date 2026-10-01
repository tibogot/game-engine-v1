// THE BATTLE LAB (battle-lab.html; you, 2026-10-02: "everything related to
// the fight in a lab — how they behave, fire, the bullets, the animations,
// the blood, men blown apart"). The REAL game, booted lean (no AI, no win
// rules, no fog of war, no herds), with a panel that stages a fight on a flat
// patch of the Aurès: two squads facing each other across the screen, held
// until you open fire, explosives dropped where you click, and the clock
// slowed, paused or stepped — sparks live a third of a second.
//
// Nothing here is a copy: the units, combat, rounds, effects and blood are
// the game's own (algUnits / algCombat / shared-rts), so what you judge here
// is what plays. The only hooks it needs in the game: app.timeScale /
// app.timeStep (algUnits.js) and projectiles.weapons (the live tracer look).
import * as THREE from "three";
import { ALG_UNIT_TYPES } from "./algUnitTypes.js";
import { PLAY, VIEW_YAW } from "./layout.js";
import { GIBS } from "./algCombat.js";

/** What can stand in a squad: every ground type (any of them on either side). */
const GROUND = Object.keys(ALG_UNIT_TYPES).filter((k) => !ALG_UNIT_TYPES[k].isAir);

/** The explosives: what lands, how hard, how wide (the game's own numbers). */
const DROPS = {
  grenade: { label: "Grenade", arc: true, from: 18, damage: 70, splash: 5, kind: "grenade", flight: 1.1 },   // algGrenades.js
  mortar: { label: "Mortar 81", arc: true, from: 90, damage: 45, splash: 7 },                                  // algStructures.js mortarPit
  shell: { label: "Tank shell", damage: 80, splash: 5 },
  big: { label: "Big blast", damage: 160, splash: 11 },
};

/** Arena: squads this far apart at most, on ground this flat. */
const ARENA_LEN = 90, ARENA_W = 36, FLAT = 3.0;

export function createBattleLab(app, { rtsCamera = app.rtsCamera } = {}) {
  const units = app.algUnits?.units;
  const combat = app.algCombat;
  if (!units || !combat) throw new Error("battle lab: the game booted without units or combat");
  const nav = app.navGrid;
  const H = (x, z) => app.getWorldHeight(x, z);

  // The view's axes: squads face each other ACROSS the screen.
  const fwd = { x: Math.sin(VIEW_YAW), z: Math.cos(VIEW_YAW) };
  const right = { x: -fwd.z, z: fwd.x };   // forward × up
  const at = (c, r, f) => ({ x: c.x + right.x * r + fwd.x * f, z: c.z + right.z * r + fwd.z * f });

  // ── The arena: the flattest open patch, clear of every armed building ────
  const arena = findArena();
  // Trees and scrub off it: a lab is for seeing the men.
  for (let r = -ARENA_LEN / 2 - 6; r <= ARENA_LEN / 2 + 6; r += 5) {
    for (let f = -ARENA_W / 2; f <= ARENA_W / 2; f += 5) {
      const p = at(arena, r, f);
      app.clearVegetation?.(p.x, p.z, 3.6, { grass: 2, edge: 0.5 });
    }
  }
  console.log(`[battle lab] arena at (${arena.x.toFixed(0)}, ${arena.z.toFixed(0)}), relief ${arena.relief.toFixed(1)} m`);

  function findArena() {
    const armed = (app.algStructures?.list ?? []).map((s) => s.position);
    let best = null;
    for (let x = PLAY.x0 + 60; x <= PLAY.x1 - 60; x += 12) {
      for (let z = PLAY.z0 + 60; z <= PLAY.z1 - 60; z += 12) {
        const c = { x, z };
        if (armed.some((p) => Math.hypot(p.x - x, p.z - z) < 140)) continue;
        let lo = Infinity, hi = -Infinity, ok = true;
        for (let r = -ARENA_LEN / 2; r <= ARENA_LEN / 2 && ok; r += 9) {
          for (let f = -ARENA_W / 2; f <= ARENA_W / 2; f += 9) {
            const p = at(c, r, f), h = H(p.x, p.z);
            if (nav?.isBlockedAtWorld?.(p.x, p.z) || (app.getWaterLevelAt?.(p.x, p.z) ?? -Infinity) > h - 0.2) { ok = false; break; }
            lo = Math.min(lo, h); hi = Math.max(hi, h);
          }
        }
        if (!ok) continue;
        const relief = hi - lo;
        // Flat enough first, then the flattest, near the post as a tiebreak.
        const score = relief + Math.hypot(x - 90, z - 213) * 0.002;
        if (relief < FLAT * 2 && (!best || score < best.score)) best = { x, z, relief, score };
      }
    }
    return best ?? { x: 0, z: 0, relief: NaN };
  }

  // ── The squads ───────────────────────────────────────────────────────────
  // dist 24: the back rows in rifle range too (30 m), so nobody walks out of cover to shoot.
  const S = { fr: "appele", frN: 8, aln: "moudjahid", alnN: 8, dist: 24, cover: { fr: false, aln: false }, hold: true };
  let squads = { fr: [], aln: [] };
  let walls = [];   // the sandbag walls placed for cover
  let firedAt = null, killed = { fr: 0, aln: 0 };

  const side = (k) => (k === "fr" ? -1 : 1);   // French on the left of the screen
  const centreOf = (k) => at(arena, side(k) * S.dist / 2, 0);

  /** A squad's slots: files of 4 across the screen's depth, rows away from the enemy. */
  function slots(k, typeKey, n) {
    const t = ALG_UNIT_TYPES[typeKey], gap = t.foot ? 3.2 : (t.radius ?? 3) * 3.2;
    const out = [];
    for (let i = 0; i < n; i++) {
      const col = (i % 4) - (Math.min(n, 4) - 1) / 2, row = Math.floor(i / 4);
      out.push(at(arena, side(k) * (S.dist / 2 + row * gap), col * gap));
    }
    return out;
  }

  async function spawn() {
    clear();
    for (const k of ["fr", "aln"]) {
      const typeKey = k === "fr" ? S.fr : S.aln, n = k === "fr" ? S.frN : S.alnN;
      if (S.cover[k]) await raiseWalls(k, Math.min(n, 4) * (ALG_UNIT_TYPES[typeKey].foot ? 3.2 : 9));
      const foe = centreOf(k === "fr" ? "aln" : "fr");
      for (const p of slots(k, typeKey, n)) {
        const u = units.spawn(typeKey, p.x, p.z, { team: k === "fr" ? "player" : "enemy" });
        if (!u) continue;
        u.faceToward?.(u.position.x + (foe.x - centreOf(k).x), u.position.z + (foe.z - centreOf(k).z));
        u.holdFire = S.hold;
        u.labSide = k;
        squads[k].push(u);
      }
    }
    firedAt = S.hold ? null : performance.now();
    killed = { fr: 0, aln: 0 };
    frame();
  }

  /** Sandbag walls 2.5 m in front of a squad (the game's own piece, raised at once). */
  async function raiseWalls(k, width) {
    const build = app.algBuild;
    if (!build) return;
    const yaw = Math.atan2(right.x, right.z) + (k === "fr" ? 0 : Math.PI);   // the bags' face toward the enemy
    const len = 2 * (build.survey("sandbags", arena.x, arena.z, yaw).f.hx || 2.5);
    const n = Math.max(1, Math.ceil(width / len));
    for (let i = 0; i < n; i++) {
      const p = at(arena, side(k) * (S.dist / 2 - 2.5), (i - (n - 1) / 2) * len);
      app.algEconomy?.french.earn(build.costOf("sandbags"));
      const site = await build.place("sandbags", p.x, p.z, yaw, [], { stay: true });
      if (site) { site.progress = 1; walls.push(site); }
    }
  }

  /** Every lab unit out of the world (no deaths, no dust); walls taken down. */
  function clear() {
    const gone = [...squads.fr, ...squads.aln];
    for (const u of gone) { u.alive = false; u.hp = 0; app.selection?.remove?.(u); }
    if (gone.length) clearedAt = performance.now();
    // A frame later (the renderer hides a vehicle's model on seeing it dead),
    // out of the list: no corpse left behind (and no pool: see setBlood).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      for (const u of gone) { const i = units.list.indexOf(u); if (i >= 0) units.list.splice(i, 1); }
    }));
    squads = { fr: [], aln: [] };
    for (const s of walls) {
      const m = s.mesh;
      if (!s.done) { app.algBuild.cancelSite(s); continue; }
      app.scene.remove(m);
      if (s.fp) { nav?.removeFootprint?.(s.fp); }
      if (app.showroom) delete app.showroom[m.name];
    }
    if (walls.length) { nav?.rebuild?.(); app.algCover?.bake(); }
    walls = [];
    firedAt = null;
  }

  function setHold(on) {
    S.hold = on;
    for (const u of [...squads.fr, ...squads.aln]) { u.holdFire = on; if (on) { u.target = null; u.attackTarget = null; } }
    if (!on && !firedAt) firedAt = performance.now();
  }

  // ── Explosives ───────────────────────────────────────────────────────────
  let armed = null;   // a drop waiting for a click on the ground
  function drop(key, p) {
    const D = DROPS[key], y = H(p.x, p.z);
    const to = new THREE.Vector3(p.x, y, p.z);
    if (D.arc) {
      // Thrown or fired from the side it came from: the far side of the target.
      const k = Math.sign((p.x - arena.x) * right.x + (p.z - arena.z) * right.z) || 1;
      const fx = p.x + right.x * k * D.from, fz = p.z + right.z * k * D.from;
      const from = new THREE.Vector3(fx, H(fx, fz) + 1.6, fz);
      combat.projectiles.spawnArc(from, to, { damage: D.damage, splash: D.splash, owner: null, kind: D.kind ?? null, ...(D.flight ? { flight: D.flight } : {}) });
    } else {
      combat.combat.splashAt(to, D.damage, D.splash, null);
    }
  }
  const dropOn = (key, k) => {
    const live = squads[k].filter((u) => u.alive);
    const c = live.length ? live[Math.floor(Math.random() * live.length)].position : centreOf(k);
    drop(key, { x: c.x + (Math.random() - 0.5) * 1.5, z: c.z + (Math.random() - 0.5) * 1.5 });
  };

  /** The ground under the pointer: a march along the ray (no terrain mesh pick needed). */
  const _ray = new THREE.Raycaster();
  function groundAt(e) {
    const r = app.renderer.domElement.getBoundingClientRect();
    _ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), app.camera);
    const o = _ray.ray.origin, d = _ray.ray.direction;
    for (let t = 1; t < 1500; t += 0.5) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      if (y <= H(x, z)) return { x, z };
    }
    return null;
  }
  // Capture phase: the click that drops does not also select or order.
  app.renderer.domElement.addEventListener("pointerdown", (e) => {
    if (!armed || e.button !== 0) return;
    const p = groundAt(e);
    if (p) drop(armed, p);
    if (!e.shiftKey) { armed = null; render(); }   // shift: keep dropping
    e.stopImmediatePropagation(); e.preventDefault();
  }, true);

  /** The smoke alone: five slow puffs across the middle (dust, then gun smoke). */
  function puffTest() {
    for (let i = 0; i < 5; i++) {
      const p = at(arena, 0, (i - 2) * 7);
      combat.fx.books.puff(p.x, H(p.x, p.z), p.z, { size: 6, duration: 9, delay: i * 0.25, grey: i === 4 ? 1 : 0 });
    }
  }

  // ── Time and camera ──────────────────────────────────────────────────────
  const setSpeed = (s) => { app.timeScale = s; render(); };
  const step = () => { if (app.timeScale === 0) app.timeStep = 1 / 60; };
  function frame(zoom = 0.3) {
    rtsCamera?.setYaw(VIEW_YAW);
    rtsCamera?.focusOn(arena.x, arena.z);
    rtsCamera?.setZoom(zoom);
  }
  function closeOn(k) {
    const u = squads[k].find((e) => e.alive) ?? squads[k][0];
    const c = u?.position ?? centreOf(k);
    rtsCamera?.focusOn(c.x, c.z);
    rtsCamera?.setZoom(0);
  }

  // ── Blood (the game's own switch is boot-only, ?blood=0: this wraps it) ─
  const blood = combat.blood, bloodHit = blood.hit, bloodPool = blood.pool;
  let bloodOn = true;
  const setBlood = (on) => { bloodOn = on; blood.hit = on ? bloodHit : () => {}; };
  // A pool under a man who fell, not under one Clear took off the field: the
  // renderer asks for it on his first dead frame, so a short window after a
  // Clear lets none through. (Paused, that frame never draws a corpse.)
  let clearedAt = -1e9;
  blood.pool = (...a) => { if (bloodOn && performance.now() - clearedAt > 200) bloodPool(...a); };

  // ── The panel ────────────────────────────────────────────────────────────
  const css = document.createElement("style");
  css.textContent = `
    #blab { position: fixed; top: 10px; left: 10px; z-index: 60; width: 268px; max-height: calc(100vh - 250px); overflow-y: auto;
      background: rgba(22, 17, 12, 0.9); border: 1px solid #4a3c2c; border-radius: 4px; padding: 10px 12px;
      color: #e8dcc4; font: 12px/1.45 "Segoe UI", system-ui, sans-serif; user-select: none; }
    #blab h1 { margin: 0 0 2px; font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #f0d9a8; }
    #blab .sub { color: #a8987c; font-size: 11px; }
    #blab h2 { margin: 10px 0 4px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #a8987c; font-weight: 600; }
    #blab .row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
    #blab .row > span:first-child { width: 58px; color: #c9b998; flex: none; }
    #blab select, #blab input[type=number] { flex: 1; min-width: 0; background: #2a2118; color: #eadfc8; border: 1px solid #4a3c2c; border-radius: 3px; padding: 2px 4px; font: inherit; }
    #blab input[type=number] { flex: 0 0 46px; }
    #blab input[type=range] { flex: 1; min-width: 0; }
    #blab b { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 34px; text-align: right; }
    #blab .btns { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
    #blab button { flex: 1 1 auto; padding: 4px 6px; font: 11px "Segoe UI", system-ui, sans-serif; cursor: pointer;
      background: #2f251b; color: #e2d4b6; border: 1px solid #54432f; border-radius: 3px; }
    #blab button:hover { background: #3c2f22; }
    #blab button.on { background: #8a3a22; border-color: #c8603c; color: #fff; }
    #blab button.go { background: #3b5a2a; border-color: #5f8a44; color: #fff; }
    #blab label { display: flex; align-items: center; gap: 6px; margin: 2px 0; cursor: pointer; }
    #blab .stat { display: flex; justify-content: space-between; font-variant-numeric: tabular-nums; }
    #blab .note { margin-top: 8px; padding-top: 6px; border-top: 1px solid #3a2e22; color: #8f8068; font-size: 11px; }
  `;
  document.head.appendChild(css);
  const el = document.createElement("div");
  el.id = "blab";
  document.body.appendChild(el);

  const opts = (sel) => GROUND.map((k) => `<option value="${k}"${k === sel ? " selected" : ""}>${ALG_UNIT_TYPES[k].buildLabel ?? ALG_UNIT_TYPES[k].name}</option>`).join("");
  const speeds = [[1, "×1"], [0.5, "×½"], [0.25, "×¼"], [0.1, "×0.1"], [0, "Pause"]];
  const W = combat.projectiles.weapons;
  const TRACER = [
    ["rifle", "tracerEvery", "Rifle: 1 in", 1, 12, 1], ["mg", "tracerEvery", "MG: 1 in", 1, 10, 1],
    ["rifle", "dim", "Rifle dim", 0.1, 1.5, 0.05], ["mg", "dim", "MG dim", 0.1, 1.5, 0.05],
    ["mg", "length", "MG length", 0.5, 8, 0.1], ["mg", "width", "MG width", 0.03, 0.4, 0.01],
    ["mg", "speed", "Speed m/s", 30, 400, 10],
  ];

  function render() {
    el.innerHTML = `
      <h1>Battle Lab</h1>
      <div class="sub">The game's own combat on a flat patch. Left: French · right: ALN.</div>
      <h2>Squads</h2>
      <div class="row"><span>French</span><select data-k="fr">${opts(S.fr)}</select><input type="number" data-n="frN" min="1" max="24" value="${S.frN}"></div>
      <div class="row"><span>ALN</span><select data-k="aln">${opts(S.aln)}</select><input type="number" data-n="alnN" min="1" max="24" value="${S.alnN}"></div>
      <div class="row"><span>Apart</span><input type="range" data-dist min="8" max="80" step="1" value="${S.dist}"><b>${S.dist} m</b></div>
      <label><input type="checkbox" data-cover="fr"${S.cover.fr ? " checked" : ""}> French behind sandbags</label>
      <label><input type="checkbox" data-cover="aln"${S.cover.aln ? " checked" : ""}> ALN behind sandbags</label>
      <div class="btns"><button class="go" data-act="spawn">Spawn</button><button data-act="clear">Clear</button></div>
      <h2>Fire</h2>
      <div class="btns">
        <button data-act="fire" class="${S.hold ? "" : "on"}">Open fire</button>
        <button data-act="hold" class="${S.hold ? "on" : ""}">Hold fire</button>
      </div>
      <h2>Explosives</h2>
      ${Object.entries(DROPS).map(([k, d]) => `<div class="row"><span>${d.label}</span><div class="btns" style="flex:1;margin:0">
        <button data-drop="${k}" data-on="fr">on FR</button><button data-drop="${k}" data-on="aln">on ALN</button>
        <button data-arm="${k}" class="${armed === k ? "on" : ""}" title="Then click the ground (shift-click: keep dropping)">click</button></div></div>`).join("")}
      <h2>Time</h2>
      <div class="btns">${speeds.map(([s, l]) => `<button data-speed="${s}" class="${app.timeScale === s ? "on" : ""}">${l}</button>`).join("")}
        <button data-act="step" title="One sim step (1/60 s) while paused · key: .">Step</button></div>
      <h2>Camera</h2>
      <div class="btns"><button data-act="frame">Frame</button><button data-act="play">Play zoom</button>
        <button data-act="closeFr">Close FR</button><button data-act="closeAln">Close ALN</button></div>
      <h2>Tracers (live)</h2>
      ${TRACER.map(([w, f, l, lo, hi, st]) => `<div class="row"><span>${l}</span><input type="range" data-w="${w}" data-f="${f}" min="${lo}" max="${hi}" step="${st}" value="${W[w]?.[f] ?? lo}"><b>${W[w]?.[f] ?? "–"}</b></div>`).join("")}
      <h2>Effects</h2>
      <label><input type="checkbox" data-blood${bloodOn ? " checked" : ""}> Blood</label>
      ${combat.fx.litSmoke !== null ? `<label><input type="checkbox" data-litsmoke${combat.fx.litSmoke ? " checked" : ""}> Lit smoke (off: the old book)</label>
      <div class="row"><span>Sun on it</span><input type="range" data-lit="uSunK" min="0" max="1.5" step="0.02" value="${combat.fx.lit.params.uSunK.value}"><b>${combat.fx.lit.params.uSunK.value}</b></div>
      <div class="row"><span>Sky on it</span><input type="range" data-lit="uSkyK" min="0" max="2" step="0.02" value="${combat.fx.lit.params.uSkyK.value}"><b>${combat.fx.lit.params.uSkyK.value}</b></div>` : ""}
      <div class="btns"><button data-act="puffs" title="A row of slow dust and gun-smoke puffs between the squads, to judge the smoke alone">Smoke test</button></div>
      <div class="row"><span>Blown apart</span><select data-gibs>${[["coh", "CoH: close hits"], ["always", "Every blast kill"], ["off", "Off"]].map(([k, l]) => `<option value="${k}"${GIBS.mode === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
      <h2>Now</h2>
      <div id="blab-stats"></div>
      <div class="note">P pause · . step. Tracer values reset on reload; tell me the ones you like and I'll bake them in. GPU ms: the stats overlay.</div>`;
    stats();
  }

  function stats() {
    const s = el.querySelector("#blab-stats");
    if (!s) return;
    const live = (k) => squads[k].filter((u) => u.alive).length;
    const t = firedAt ? ((performance.now() - firedAt) / 1000).toFixed(0) + " s" : "held";
    s.innerHTML = `<div class="stat"><span>French standing</span><b>${live("fr")} / ${squads.fr.length}</b></div>
      <div class="stat"><span>ALN standing</span><b>${live("aln")} / ${squads.aln.length}</b></div>
      <div class="stat"><span>Since open fire</span><b>${t}</b></div>
      <div class="stat"><span>Clock</span><b>${app.timeScale === 0 ? "paused" : "×" + app.timeScale}</b></div>`;
  }
  setInterval(stats, 500);

  el.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.k) S[t.dataset.k] = t.value;
    else if (t.dataset.n) S[t.dataset.n] = Math.max(1, Math.min(24, Number(t.value) || 1));
    else if (t.dataset.cover) S.cover[t.dataset.cover] = t.checked;
    else if ("blood" in t.dataset) setBlood(t.checked);
    else if ("gibs" in t.dataset) GIBS.mode = t.value;
    else if ("litsmoke" in t.dataset) combat.fx.setLitSmoke(t.checked);
  });
  el.addEventListener("input", (e) => {
    const t = e.target;
    if ("dist" in t.dataset) { S.dist = Number(t.value); t.nextElementSibling.textContent = `${S.dist} m`; }
    else if (t.dataset.lit) { combat.fx.lit.params[t.dataset.lit].value = Number(t.value); t.nextElementSibling.textContent = t.value; }
    else if (t.dataset.w && W[t.dataset.w]) { W[t.dataset.w][t.dataset.f] = Number(t.value); t.nextElementSibling.textContent = t.value; }
  });
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const d = b.dataset;
    if (d.act === "spawn") spawn().then(render);
    else if (d.act === "clear") { clear(); render(); }
    else if (d.act === "fire") { setHold(false); render(); }
    else if (d.act === "hold") { setHold(true); render(); }
    else if (d.act === "step") step();
    else if (d.act === "puffs") puffTest();
    else if (d.act === "frame") frame();
    else if (d.act === "play") frame(0.5);
    else if (d.act === "closeFr") closeOn("fr");
    else if (d.act === "closeAln") closeOn("aln");
    else if (d.drop) dropOn(d.drop, d.on);
    else if (d.arm) { armed = armed === d.arm ? null : d.arm; render(); }
    else if (d.speed != null) setSpeed(Number(d.speed));
  });
  // Keys (matched on the printed key: AZERTY).
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.target.matches?.("input, textarea, select")) return;
    const k = e.key?.toLowerCase();
    if (k === "p") setSpeed(app.timeScale === 0 ? 1 : 0);
    else if (k === ".") step();
  });

  render();
  frame();
  return { arena, spawn, clear, drop, dropOn, setHold, setSpeed, puffTest, squads: () => squads, S };
}
