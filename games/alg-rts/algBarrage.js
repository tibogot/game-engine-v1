// THE MORTAR BARRAGE (you, 2026-10-04: "veterancy + smoke + the LMG upgrade + the mortar
// barrage") — CoH's call-in from a mortar team, here the 81 mm MORTAR PIT the sappers build:
//
//   select the MORTAR PIT → TIR DE BARRAGE (M) on the command card → a ring the size of the
//   beaten zone follows the cursor (green in range, red out of it) → left-click fires,
//   right-click / Esc cancels.
//
// Six bombs on the zone, one every 1.4 s, each landing somewhere in a 12 m circle round the
// point: what the pit's own fire (algStructures stepMortar: one bomb on the nearest enemy every
// 7 s) can't do — clear an MG nest, break up a band dug in behind a wall (a bomb from above:
// cover doesn't help, combat.splashAt), shell a village street before the infantry goes in.
// The pit's own fire waits while it shoots the barrage. Day or night. The French pay
// MUNITIONS; each pit has a cooldown. Friendly bombs don't hurt the French (splashAt skips the
// owner's team) — but they do wreck the village they land in (algDamage).
import * as THREE from "three";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";

export const BARRAGE = {
  cost: { mun: 45 },
  cooldown: 75,     // s per pit
  range: 150,       // m from the pit (its own fire reaches 120)
  minRange: 30,
  bombs: 6,
  every: 1.4,       // s between two bombs
  spread: 12,       // m: the beaten zone's radius
  damage: 45,       // per bomb, as the pit's own (algStructures mortar)
  splash: 7,
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.selection    the shared selection
 * @param {object} o.projectiles  (spawnArc)
 * @param {object} o.structures   algStructures (records: the pit's gun, its own fire timer)
 * @param {object} [o.purse]      the French purse (munitions); none = free
 */
export function createAlgBarrage({ app, selection, projectiles, structures, purse = null }) {
  const P = BARRAGE;
  const dom = app.renderer.domElement;
  const rings = createSelectionRingField({ app, max: 4, inner: 0.93, opacity: 0.75 });
  let targeting = null;    // { pit, at, ok }
  const fires = [];        // { pit, x, z, left, t }
  const isPit = (s) => s?.alive && s.isStructure && s.typeKey === "mortarPit" && s.team === "player";
  const recOf = (pit) => structures.records?.find((r) => r.s === pit) ?? null;

  // ── The command card's button ────────────────────────────────────────────
  function ability(sel) {
    if (sel.length !== 1 || !isPit(sel[0])) return null;
    const s = sel[0], cd = Math.max(0, s.barrageCd ?? 0), busy = fires.some((f) => f.pit === s);
    return {
      key: "barrage", label: busy ? "Tir en cours" : "Tir de barrage", cost: purse ? P.cost : undefined,
      hint: `${P.bombs} bombs on a zone up to ${P.range} m away, ${P.spread} m across, over ~${Math.round(P.bombs * P.every)} s: from above, so cover saves nobody. Clears an MG nest or a dug-in band. M.`,
      ready: !busy && cd <= 0 && (!purse || purse.canAfford(P.cost)), cooldown: Math.ceil(cd),
    };
  }

  // ── Aiming (as the flares: algFlares.js) ────────────────────────────────
  function begin(sel = selection.selected) {
    const pit = (sel ?? []).find(isPit);
    if (!pit || (pit.barrageCd ?? 0) > 0 || fires.some((f) => f.pit === pit) || (purse && !purse.canAfford(P.cost))) return false;
    targeting = { pit, at: null, ok: false };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; dom.style.cursor = ""; }
  function aimAt(e) {
    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    targeting.at = hit?.point ? { x: hit.point.x, z: hit.point.z } : null;
    const p = targeting.pit.position;
    const d = targeting.at ? Math.hypot(targeting.at.x - p.x, targeting.at.z - p.z) : Infinity;
    targeting.ok = d >= P.minRange && d <= P.range;
  }
  const onMove = (e) => { if (targeting) aimAt(e); };
  const onDown = (e) => {
    if (!targeting) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) { cancel(); return; }
    aimAt(e);
    const { pit, at, ok } = targeting;
    cancel();
    if (at && ok) fire(pit, at.x, at.z);
  };
  const onKey = (e) => { if (e.key === "Escape" && targeting) cancel(); };
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKey);

  /** The pit lays a barrage on (x, z). */
  function fire(pit, x, z) {
    if (purse && !purse.spend(P.cost)) return false;
    pit.barrageCd = P.cooldown;
    fires.push({ pit, x, z, left: P.bombs, t: 0 });
    return true;
  }

  const _from = new THREE.Vector3(), _to = new THREE.Vector3(), _up = new THREE.Vector3(0, 1.2, 0);
  /** Fixed clock: the cooldowns, the bombs going out one by one. */
  function step(dt) {
    for (const s of app.algStructures?.list ?? []) if (s.barrageCd > 0) s.barrageCd -= dt;
    for (let i = fires.length - 1; i >= 0; i--) {
      const f = fires[i];
      if (!f.pit.alive) { fires.splice(i, 1); continue; }
      const rec = recOf(f.pit);
      if (rec) rec.mortarT = Math.max(rec.mortarT, P.every + 1);   // its own fire waits
      f.t -= dt;
      if (f.t > 0) continue;
      f.t = P.every;
      // Somewhere in the beaten zone (uniform over the disc).
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * P.spread;
      const tx = f.x + Math.cos(a) * r, tz = f.z + Math.sin(a) * r;
      if (rec?.gun) rec.gun.getWorldPosition(_from).add(_up);
      else _from.copy(f.pit.position).add(_up);
      _to.set(tx, app.getWorldHeight?.(tx, tz) ?? 0, tz);
      projectiles.spawnArc(_from.clone(), _to.clone(), { damage: P.damage, splash: P.splash, owner: f.pit });
      if (--f.left <= 0) fires.splice(i, 1);
    }
  }

  /** Every frame: the aim ring and the pit's reach; the zone under fire. */
  function frame() {
    rings.begin();
    if (targeting?.at) {
      const p = targeting.pit.position;
      rings.add(targeting.at.x, targeting.at.z, P.spread, targeting.ok ? 0x58e070 : 0xe05050);
      rings.add(p.x, p.z, P.range, 0x6ab0ff);
    }
    for (const f of fires) rings.add(f.x, f.z, P.spread, 0xffb020);
    rings.commit();
  }

  return {
    params: P, ability, begin, cancel, fire, step, frame,
    get targeting() { return !!targeting; },
    get firing() { return fires.length; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    },
  };
}
