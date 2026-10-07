// ILLUMINATION FLARES — the French answer to the night (you, 2026-10-04: "go ahead with your
// flares suggestion").
//
//   select the MORTAR PIT → FUSÉE ÉCLAIRANTE on the command card → a ring the size of the area
//   it will light follows the cursor (green in range, red out of it) → left-click fires,
//   right-click / Esc cancels.
//
// A thump at the pit; ~2.5 s later the flare bursts ~140 m over the point and sinks under its
// parachute at ~5 m/s for ~26 s, drifting with the map's wind. Its light is one engine local
// light (app.localLights): strong enough to keep the centre of its circle at about ten times
// moonlight from any height, so as it sinks the lit circle TIGHTENS rather than dims. Inside
// the circle the ground is SEEN (a fog-of-war vision source, as the searchlight's pool) and
// concealment hides nobody (cover.reveal, every tick). The ALN avoids it (algAI.js: a band
// waiting or walking in the light moves out of it).
//
// NIGHT ONLY: by day the button is greyed (a flare in the sun lights nothing). The French pay
// MUNITIONS per flare (algEconomy.js), each pit has a cooldown. Nothing runs while no flare is
// up — no light, no draw (the glow mesh is hidden), no reveal loop.
import * as THREE from "three";
import { uniform, vec3 } from "three/tsl";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { BloomMRTNode } from "../shared-rts/bloom.js";
import { t } from "./i18n/i18n.js";

export const FLARE = {
  cost: { mun: 25 },
  cooldown: 45,      // s per pit
  range: 200,        // m from the pit
  minRange: 30,
  delay: 2.5,        // s from the thump to the burst
  height: 140,       // m over the ground at the burst
  sink: 5,           // m/s under the parachute
  life: 26,          // s it burns
  fade: 3,           // s it dies over at the end
  // the illuminance at the circle's centre: I = E h^2. Moonlit ground ~0.03; at 0.3 the frame read
  // only 2.4x brighter (MEASURED, 2026-10-04: 0.0057 vs 0.0023) — too timid for a flare, which
  // turns night into a grey day. 1.0 ~ 8x.
  litE: 1.0,
  radius: [35, 90],  // m: the circle that counts as lit, low / high
  nightMin: 0.3,     // app.sky.night under which the button is greyed
  max: 4,            // flares up at once (the glow's instance count)
};

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.units      the shared units (the ALN men a flare reveals)
 * @param {object} o.selection  the shared selection
 * @param {object} [o.purse]    the French purse (a flare costs munitions); none = free
 * @param {object} [o.cover]    the cover system (reveal: concealment beaten under the light)
 */
export function createAlgFlares({ app, units, selection, purse = null, cover = null }) {
  const P = FLARE;
  const dom = app.renderer.domElement;
  const rings = createSelectionRingField({ app, max: 4, inner: 0.94, opacity: 0.7 });
  let targeting = null;    // { pit, at, ok } while the player aims
  const flares = [];       // { x, z, y, ground, t, h (light), r }
  const sources = [];      // the fog of war's vision sources (one per burning flare)

  const night = () => app.sky?.night ?? 0;
  const isPit = (s) => s?.alive && s.isStructure && s.typeKey === "mortarPit" && s.team === "player";

  // ── The command card's button ────────────────────────────────────────────
  function ability(sel) {
    if (sel.length !== 1 || !isPit(sel[0])) return null;
    const s = sel[0], cd = Math.max(0, s.flareCd ?? 0), dark = night() >= P.nightMin;
    return {
      key: "flare", label: t("Fusée éclairante"), cost: purse ? P.cost : undefined,
      hint: dark
        ? t("Une fusée à parachute au-dessus d'un point jusqu'à {range} m : ~{life} s de lumière, le terrain dessous VU et personne n'y reste caché. L'ALN l'évite.", { range: P.range, life: P.life })
        : t("De nuit seulement : une fusée en plein soleil n'éclaire rien."),
      ready: dark && cd <= 0 && (!purse || purse.canAfford(P.cost)), cooldown: Math.ceil(cd),
    };
  }

  // ── Aiming (as the grenade: algGrenades.js) ─────────────────────────────
  function begin(sel = selection.selected) {
    const pit = (sel ?? []).find(isPit);
    if (!pit || (pit.flareCd ?? 0) > 0 || night() < P.nightMin || (purse && !purse.canAfford(P.cost))) return false;
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
  // Capture: ahead of the selection's own handlers (a click here is not a select).
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("keydown", onKey);

  /** The pit fires a flare over (x, z). */
  function fire(pit, x, z) {
    if (flares.length >= P.max) return false;
    if (purse && !purse.spend(P.cost)) return false;
    pit.flareCd = P.cooldown;
    const p = pit.position;
    app.algSounds?.audio?.play?.("cannon", p.x, p.y + 1, p.z, { gain: 0.45, rate: 0.7 });
    const ground = app.getWorldHeight?.(x, z) ?? 0;
    flares.push({ x, z, ground, y: ground + P.height, t: -P.delay, h: null, r: P.radius[1], pos: new THREE.Vector3(x, ground, z) });
    return true;
  }

  // ── The glow: a small white-hot sphere that blooms (one draw, hidden while none is up) ─
  const uGlow = uniform(0);
  const glowMat = new THREE.MeshBasicNodeMaterial({ fog: false });
  glowMat.name = "FlareGlow";
  const hot = vec3(1.0, 0.95, 0.82);
  glowMat.colorNode = hot.mul(uGlow);
  glowMat.mrtNode = new BloomMRTNode({ emissive: hot.mul(uGlow).mul(0.8) });
  const glow = new THREE.InstancedMesh(new THREE.SphereGeometry(1.4, 10, 8), glowMat, P.max);
  glow.name = "Flares";
  glow.count = 0;
  glow.frustumCulled = false;
  glow.visible = false;
  app.scene.add(glow);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3();

  // ── The fixed sim clock: cooldowns, the flares' flight, the reveal ──────
  let simT = 0;
  function step(dt) {
    simT += dt;
    for (const s of app.algStructures?.list ?? []) if (s.flareCd > 0) s.flareCd -= dt;
    if (!flares.length) { sources.length = 0; return; }
    const w = app.showroom?.wind;
    let wx = 0, wz = 0;
    if (w) { const d = w.dirRad(simT), v = w.speed(simT) * 1.5; wx = Math.cos(d) * v; wz = Math.sin(d) * v; }
    sources.length = 0;
    for (let i = flares.length - 1; i >= 0; i--) {
      const f = flares[i];
      f.t += dt;
      if (f.t < 0) continue;
      if (!f.h) {
        // the burst: its light, a pop
        f.h = app.localLights?.add({ position: { x: f.x, y: f.y, z: f.z }, color: 0xfff2dc, intensity: 0, range: 10, flicker: 0.12, importance: 4 }) ?? null;
        app.algSounds?.audio?.play?.("impact", f.x, f.y, f.z, { gain: 0.25, rate: 0.6 });
      }
      if (f.t > P.life) { f.h?.remove(); flares.splice(i, 1); continue; }
      // sinking, drifting with the wind
      f.y = Math.max(f.ground + 12, f.y - P.sink * dt);
      f.x += wx * dt; f.z += wz * dt;
      const h = f.y - (app.getWorldHeight?.(f.x, f.z) ?? f.ground);
      const k = Math.min(1, (P.life - f.t) / P.fade);   // dying down at the end
      // I = E h^2: the circle's centre as bright from any height; the circle tightens as it sinks
      f.h?.set({ position: _p.set(f.x, f.y, f.z), intensity: P.litE * h * h * k, range: h * 1.7 + 25 });
      f.r = THREE.MathUtils.clamp(h * 0.65, P.radius[0], P.radius[1]) * Math.max(0.3, k);
      f.pos.set(f.x, f.y - h, f.z);
      sources.push({ alive: true, team: "player", built: 1, position: f.pos, vision: f.r });
      // concealment beaten for everyone under it (the searchlight's reveal)
      if (cover) for (const u of units.list) {
        if (u.alive && u.team === "enemy" && Math.hypot(u.position.x - f.x, u.position.z - f.z) < f.r) cover.reveal?.(u);
      }
    }
  }

  // ── Every frame: the aim rings, the glow ─────────────────────────────────
  function frame() {
    rings.begin();
    if (targeting?.at) {
      const p = targeting.pit.position;
      rings.add(targeting.at.x, targeting.at.z, P.radius[1] * 0.75, targeting.ok ? 0x58e070 : 0xe05050);
      rings.add(p.x, p.z, P.range, 0x6ab0ff);
    }
    rings.commit();
    let n = 0;
    for (const f of flares) {
      if (f.t < 0) continue;
      glow.setMatrixAt(n++, _m.compose(_p.set(f.x, f.y, f.z), _q, _s));
    }
    glow.count = n;
    glow.visible = n > 0;
    if (n) { glow.instanceMatrix.needsUpdate = true; uGlow.value = 40; }
  }

  return {
    params: P, ability, begin, cancel, fire, step, frame,
    get targeting() { return !!targeting; },
    /** The fog of war's vision sources: the ground under each burning flare. */
    get sources() { return sources; },
    /** Is (x, z) under a flare's light? { x, z, r } of the first that lights it, else null (algAI.js). */
    litAt(x, z) {
      for (const f of flares) if (f.t >= 0 && Math.hypot(x - f.x, z - f.z) < f.r) return { x: f.x, z: f.z, r: f.r };
      return null;
    },
    get count() { return flares.length; },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
    },
  };
}
