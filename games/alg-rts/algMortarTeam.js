// THE FLN'S MORTAR TEAM (2026-10-13, A2 — the FLN's "armour" instead of tanks: TODO ROAD TO STEAM 4).
// A squad of three (algSquads `mortier`): the gunner carries a 60 mm tube, two loaders their rifles.
//   SET UP    stopped a moment, it sets up (~3.5 s): the tube on its bipod at the gunner's feet,
//             the gunner and his first loader kneel. It does not move while set.
//   PACK UP   any move order: ~2 s to pack (the order held meanwhile), then they go.
//   FIRES     by itself, every ~6.5 s, a bomb on the nearest Frenchman its side SEES between 25 and
//             110 m — no line of sight needed, it lobs over ridges and walls (projectiles.spawnArc:
//             the ring on the ground warns the target); right-clicking a target picks it.
//   TIR DE BARRAGE  five bombs on a point you click in its reach, ~1.5 s apart (supplies, a cooldown).
// The gunner never fires through combat.js (his kit's range is 0): this module aims and fires, so
// combat never walks him toward the enemy to get in range.
import * as THREE from "three";
import { buildMortarTube } from "../../v3/render/objects/rtsEnemyKit.js";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { FR_PAINT_TINT } from "../../v3/render/objects/rtsVehiclesFr.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { isHuman } from "../shared-rts/teams.js";
import { t } from "./i18n/i18n.js";

export const MORTAR_TEAM = {
  settle: 0.5,        // s stopped before it starts to set up
  setup: 3.5,         // s to set up
  pack: 2.2,          // s to pack up
  min: 25, max: 110,  // m: its reach
  every: 6.5,         // s between two bombs (by itself)
  damage: 40, splash: 6,
  scatter: 0.06,      // × the distance: where a bomb may land off its aim
  barrage: { cost: 35, shells: 5, every: 1.5, spread: 9, cooldown: 60 },
  key: "mortier",
};
const P = MORTAR_TEAM;

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.squads       algSquads
 * @param {object} o.projectiles  combat's (spawnArc)
 * @param {object} o.selection
 * @param {object} [o.fogOfWar]
 * @param {object} o.purse        the FLN's purse
 */
export function createAlgMortarTeams(app, { units, squads, projectiles, selection, fogOfWar = null, purse }) {
  const dom = app.renderer.domElement;
  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const st = new Map();   // squad → { state, t, still, held, facing, cd, salvo, cool }
  let targeting = null;   // { s, at, ok }
  const _v = new THREE.Vector3(), _w = new THREE.Vector3();

  const teams = () => squads.list.filter((s) => s.typeKey === P.key && s.members.length);
  // The gunner: slot 0 — or, him dead, the first loader alive takes the tube (CoH: the weapon is picked up).
  const gunnerOf = (s) => s.slots.find((u) => u?.alive) ?? null;
  const stateOf = (s) => {
    let m = st.get(s);
    if (!m) { m = { state: "packed", t: 0, still: 0, held: null, facing: 0, cd: P.every * 0.5, salvo: null, cool: 0 }; st.set(s, m); }
    return m;
  };
  /** The side's eyes: what the FLN sees (the human's fog) — its AI side sees all (no fog of its own). */
  const sees = (team, x, z) => !fogOfWar?.enabled || !isHuman(team) || fogOfWar.isVisible(x, z);

  function pick(s, g) {
    const at = g.attackTarget;
    const inReach = (o) => { const d = Math.hypot(o.position.x - g.position.x, o.position.z - g.position.z); return d >= P.min && d <= P.max; };
    if (at?.alive && !at.isAir && inReach(at)) return at;
    let best = null, bd = Infinity;
    for (const o of units.near ? units.near(g.position.x, g.position.z, P.max, []) : units.list) {
      if (!o.alive || o.team === g.team || o.isAir || o.passive || o.inside || (o.team !== "player" && o.team !== "enemy")) continue;
      const d = Math.hypot(o.position.x - g.position.x, o.position.z - g.position.z);
      if (d < P.min || d > P.max || d >= bd || !sees(g.team, o.position.x, o.position.z)) continue;
      best = o; bd = d;
    }
    return best;
  }

  function fire(g, x, z) {
    const d = Math.hypot(x - g.position.x, z - g.position.z);
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * d * P.scatter;
    _w.set(x + Math.cos(a) * r, 0, z + Math.sin(a) * r);
    _w.y = groundY(_w.x, _w.z);
    _v.set(g.position.x, g.position.y + 1.3, g.position.z);
    projectiles.spawnArc(_v.clone(), _w.clone(), { damage: P.damage, splash: P.splash, owner: g });
    g.faceToward?.(x, z);
    app.algSounds?.audio?.play?.("cannon", g.position.x, g.position.y + 1, g.position.z, { volume: 0.5 });
  }

  function step(dt) {
    for (const s of teams()) {
      const m = stateOf(s), g = gunnerOf(s);
      m.cool = Math.max(0, m.cool - dt);
      if (!g) { m.state = "packed"; continue; }
      const moving = s.members.some((u) => u.isMoving);
      const crew = s.members.slice(0, 2);
      switch (m.state) {
        case "packed":
          m.still = moving ? 0 : m.still + dt;
          if (m.still >= P.settle && !s.retreating) {
            m.state = "setting"; m.t = 0;
            const tg = pick(s, g);
            m.facing = tg ? Math.atan2(tg.position.x - g.position.x, tg.position.z - g.position.z) : g.heading ?? 0;
          }
          break;
        case "setting":
          if (moving || s.retreating) { m.state = "packed"; m.still = 0; break; }
          m.t += dt;
          for (const u of crew) u.posture = "kneel";
          if (m.t >= P.setup) { m.state = "set"; m.t = 0; }
          break;
        case "set": {
          // RETREAT: the tube is left as it is — they run at once.
          if (s.retreating) { m.state = "packed"; m.still = 0; m.salvo = null; break; }
          // A move: hold it, pack up first.
          if (moving) {
            m.held = s.members.map((u) => ({ u, goal: u.goalPoint ? { x: u.goalPoint.x, z: u.goalPoint.z } : null }));
            for (const u of s.members) u.haltMovement?.();
            m.state = "packing"; m.t = 0; m.salvo = null;
            break;
          }
          for (const u of crew) u.posture = "kneel";
          m.cd -= dt;
          if (m.salvo) {
            if ((m.salvo.t -= dt) <= 0) {
              const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * P.barrage.spread;
              fire(g, m.salvo.x + Math.cos(a) * r, m.salvo.z + Math.sin(a) * r);
              m.salvo.t = P.barrage.every;
              if (--m.salvo.left <= 0) { m.salvo = null; m.cd = P.every; }
            }
            break;
          }
          if (m.cd > 0) break;
          const tg = pick(s, g);
          if (!tg) { m.cd = 1; break; }
          m.facing = Math.atan2(tg.position.x - g.position.x, tg.position.z - g.position.z);
          g.target = tg;
          fire(g, tg.position.x, tg.position.z);
          m.cd = P.every;
          break;
        }
        case "packing":
          if (s.retreating) { m.state = "packed"; m.still = 0; m.held = null; break; }
          m.t += dt;
          // A new order while packing: remember it, keep still.
          for (const u of s.members) if (u.isMoving && u.goalPoint) {
            m.held ??= [];
            const h = m.held.find((q) => q.u === u);
            if (h) h.goal = { x: u.goalPoint.x, z: u.goalPoint.z }; else m.held.push({ u, goal: { x: u.goalPoint.x, z: u.goalPoint.z } });
            u.haltMovement?.();
          }
          if (m.t >= P.pack) {
            m.state = "packed"; m.still = 0;
            for (const h of m.held ?? []) if (h.goal && h.u.alive) h.u.moveOrder(h.goal.x, h.goal.z);
            m.held = null;
          }
          break;
      }
    }
    for (const s of [...st.keys()]) if (!squads.list.includes(s)) st.delete(s);
  }

  // ── TIR DE BARRAGE (the human's mortar teams) ───────────────────────────────
  const mine = (sel) => squads.squadsIn(sel).filter((s) => s.typeKey === P.key && isHuman(s.team) && gunnerOf(s));
  function ability(sel) {
    const ss = mine(sel);
    if (!ss.length) return null;
    const s = ss[0], m = stateOf(s);
    const set = m.state === "set";
    return {
      key: "mortarBarrage", label: t("Tir de barrage"), cost: P.barrage.cost,
      ready: set && !m.salvo && m.cool <= 0 && purse.canAfford(P.barrage.cost),
      hint: !set ? t("Le mortier doit être en batterie : arrêtez l'équipe quelques secondes.")
        : m.cool > 0 ? t("Le tube refroidit encore ({n} s).", { n: Math.ceil(m.cool) })
          : t("Cinq obus sur un point que vous choisissez, entre 25 et 110 m du mortier."),
    };
  }
  function begin(sel) {
    const s = mine(sel).find((q) => stateOf(q).state === "set");
    if (!s) return false;
    targeting = { s, at: null, ok: false };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; dom.style.cursor = ""; }
  function aim(e) {
    const p = app.pickWorldAtClient?.(e.clientX, e.clientY)?.point;
    const g = gunnerOf(targeting.s);
    targeting.at = p ? { x: p.x, z: p.z } : null;
    if (!p || !g) { targeting.ok = false; return; }
    const d = Math.hypot(p.x - g.position.x, p.z - g.position.z);
    targeting.ok = d >= P.min && d <= P.max;
  }
  const onMove = (e) => { if (targeting) aim(e); };
  function onDown(e) {
    if (!targeting) return;
    if (e.button === 2) { cancel(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopImmediatePropagation();
    aim(e);
    const { s, at, ok } = targeting;
    if (!at || !ok) return;
    const m = stateOf(s);
    if (m.state === "set" && purse.spend(P.barrage.cost)) {
      m.salvo = { x: at.x, z: at.z, left: P.barrage.shells, t: 0.2 };
      m.cool = P.barrage.cooldown;
    }
    cancel();
  }
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  const onKey = (e) => { if (targeting && e.key === "Escape") cancel(); };
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey);

  // ── The tubes on the ground (one instanced draw), the reach rings ──────────
  const MAXT = 16;
  const tubes = new THREE.InstancedMesh(buildMortarTube(), rtsObjectMaterialTinted(FR_PAINT_TINT), MAXT);
  tubes.castShadow = true;
  tubes.frustumCulled = false;
  tubes.count = 0;
  tubes.name = "MortarTeamTubes";
  app.scene.add(tubes);
  const rings = createSelectionRingField({ app, inner: 0.94, segments: 72 });
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  function frame() {
    let n = 0;
    rings.begin();
    for (const s of teams()) {
      const m = stateOf(s), g = gunnerOf(s);
      if (!g) continue;
      const k = m.state === "set" ? 1 : m.state === "setting" ? Math.min(1, m.t / P.setup) : m.state === "packing" ? 1 - Math.min(1, m.t / P.pack) : 0;
      if (k > 0.02 && n < MAXT) {
        const fx = Math.sin(m.facing), fz = Math.cos(m.facing);
        _p.set(g.position.x + fx * 0.9, groundY(g.position.x + fx * 0.9, g.position.z + fz * 0.9), g.position.z + fz * 0.9);
        _q.setFromAxisAngle(_up, m.facing);
        _s.setScalar(Math.max(0.01, k) * 0.72);   // (the kit tube is the 82 mm; a 60 mm is shorter)
        tubes.setMatrixAt(n++, _m.compose(_p, _q, _s));
      }
      // The reach, for your selected teams: the outer ring, and the dead zone inside.
      if (isHuman(s.team) && s.members.some((u) => u.selected)) {
        rings.add(g.position.x, g.position.z, P.max, 0xe0a93a);
        rings.add(g.position.x, g.position.z, P.min, 0xe0574a);
      }
    }
    if (targeting?.at) rings.add(targeting.at.x, targeting.at.z, P.barrage.spread, targeting.ok ? 0x58e070 : 0xe0574a);
    rings.commit();
    tubes.count = n;
    tubes.instanceMatrix.needsUpdate = true;
  }

  return {
    params: P, step, frame, ability, begin, cancel,
    /** A squad's state (dev, tests): "packed" | "setting" | "set" | "packing". */
    stateOf: (s) => stateOf(s).state,
    dispose() {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
      app.scene.remove(tubes);
    },
  };
}
