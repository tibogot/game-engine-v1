// THE HELIBORNE LIFT (2026-10-12, you: "the helicopter should be able to pick up and disembark units").
// The H-21 "Banane" carries two squads (algTransports.js). It only takes men on, and lets them off,
// ON THE GROUND — as in Algeria, where the H-21s set the paras down on a crest and lifted off again:
//   PICK UP   right-click the H-21 with infantry selected: it comes down on open, flat ground beside
//             them; they run to the door and climb in.
//   SET DOWN  DÉBARQUER on the flying H-21: it lands under itself (the nearest open, flat ground big
//             enough for its rotors) and the men jump out at the door. ATTERRIR lands it empty.
//   TAKE OFF  any move order: the rotors already turning, it lifts, then flies on.
// ON THE GROUND IT IS A TARGET: grounded, it is no longer an aircraft (`isAir` off), and every rifle
// can hit it — the landing zone is the dangerous minute. A crash in the air kills everyone aboard.
import { t } from "./i18n/i18n.js";
import { isHuman } from "../shared-rts/teams.js";

const P = {
  types: new Set(["h21"]),
  down: 3.4,          // s from the hover to the wheels on the ground
  up: 2.8,            // s back up to the hover
  arrive: 2.5,        // m from the landing spot: start down
  clear: 9,           // m round the spot that must be open ground (the rotors, scaled, ~8.7 m)
  slope: 1.8,         // m: the most the ground may rise or fall over that ring
  apart: 22,          // m between two helicopters' spots
  search: 80,         // m: how far out a spot is looked for
  besideMen: 16,      // m from the men's centre, toward the helicopter: where it comes down for them
};
const ease = (k) => k * k * (3 - 2 * k);

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units
 * @param {object} [o.navGrid]
 */
export function createAlgHeliLift(app, { units, navGrid = null }) {
  const state = new Map();   // helicopter → { mode, k, spot, then, goal }
  const handles = (v) => !!v && P.types.has(v.typeKey);
  const st = (v) => {
    let s = state.get(v);
    if (!s) { s = { mode: "air", k: 1, spot: null, then: null, goal: null }; state.set(v, s); }
    return s;
  };
  const ground = (x, z) => app.getWorldHeight(x, z);

  /** Open, flat ground for a helicopter near (x, z), clear of the other helicopters' spots. */
  function findSpot(x, z, self) {
    const taken = [...state].filter(([v, s]) => v !== self && v.alive && s.spot && s.mode !== "air").map(([, s]) => s.spot);
    const ok = (cx, cz) => {
      if (navGrid?.isBlockedAtWorld(cx, cz, false)) return false;
      if (taken.some((p) => Math.hypot(p.x - cx, p.z - cz) < P.apart)) return false;
      const h0 = ground(cx, cz);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, px = cx + Math.sin(a) * P.clear, pz = cz + Math.cos(a) * P.clear;
        if (navGrid?.isBlockedAtWorld(px, pz, false)) return false;
        if (Math.abs(ground(px, pz) - h0) > P.slope) return false;
      }
      return true;
    };
    for (let r = 0; r <= P.search; r += 4) {
      const n = r ? Math.max(8, Math.round((2 * Math.PI * r) / 5)) : 1;
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, cx = x + Math.sin(a) * r, cz = z + Math.cos(a) * r;
        if (ok(cx, cz)) return { x: cx, z: cz };
      }
    }
    return null;
  }

  /** Bring `v` down near (x, z); `then()` once its wheels are on the ground. False: nowhere to land. */
  function landNear(v, x, z, then = null) {
    if (!handles(v) || !v.alive) return false;
    const s = st(v);
    if (s.mode === "landed") { then?.(); return true; }
    const spot = findSpot(x, z, v);
    if (!spot) {
      if (isHuman(v.team)) app.algBattle?.say?.(t("<b>Pas de zone d'atterrissage</b> ici : il faut un terrain plat et dégagé."), v.position.x, v.position.z, "bad");
      return false;
    }
    s.spot = spot; s.then = then; s.goal = null;
    s.mode = "toSpot";
    v.orderTo(spot.x, spot.z);
    return true;
  }

  function step(dt) {
    for (const v of units.list) {
      if (!handles(v)) continue;
      if (!v.alive) { state.delete(v); continue; }
      const s = st(v);
      const goal = v.goalPoint;
      // A new order away from the spot (the player's, or the AI's): the landing is off.
      const ordered = goal && (!s.spot || Math.hypot(goal.x - s.spot.x, goal.z - s.spot.z) > 3);
      switch (s.mode) {
        case "toSpot":
          if (ordered) { s.mode = "air"; s.spot = null; s.then = null; break; }
          if (Math.hypot(v.position.x - s.spot.x, v.position.z - s.spot.z) < P.arrive) { v.haltMovement(); s.mode = "down"; }
          break;
        case "down":
          if (ordered) { s.goal = { x: goal.x, z: goal.z }; v.haltMovement(); s.mode = "up"; break; }
          s.k = Math.max(0, s.k - dt / P.down);
          if (s.k <= 0) {
            s.mode = "landed";
            v.isAir = false;           // on the ground: anyone can hit it
            const f = s.then; s.then = null; f?.();
          }
          break;
        case "landed":
          if (ordered) { s.goal = { x: goal.x, z: goal.z }; v.haltMovement(); v.isAir = true; s.spot = null; s.mode = "up"; }
          break;
        case "up":
          // Further orders while lifting: the latest wins; it flies there once up.
          if (goal && Math.hypot(goal.x - v.position.x, goal.z - v.position.z) > 3) { s.goal = { x: goal.x, z: goal.z }; v.haltMovement(); }
          v.isAir = true;
          s.k = Math.min(1, s.k + dt / P.up);
          if (s.k >= 1) {
            s.mode = "air";
            if (s.goal) v.orderTo(s.goal.x, s.goal.z);
            s.goal = null;
          }
          break;
      }
      v.altScale = ease(s.k);
    }
  }

  return {
    params: P, handles, landNear, step, findSpot,
    /** On the ground now (men may board or leave). */
    landed: (v) => state.get(v)?.mode === "landed",
    /** Coming down (or flying to its spot to). */
    landing: (v) => ["toSpot", "down"].includes(state.get(v)?.mode),
    /** Come down near the men told to board it, between them and it. */
    pickUp(v, men) {
      const s = st(v);
      if (s.mode !== "air") return;
      let cx = 0, cz = 0;
      for (const u of men) { cx += u.position.x; cz += u.position.z; }
      cx /= men.length; cz /= men.length;
      const dx = v.position.x - cx, dz = v.position.z - cz, d = Math.hypot(dx, dz) || 1;
      const k = Math.min(P.besideMen, d);
      landNear(v, cx + (dx / d) * k, cz + (dz / d) * k);
    },
    /** ATTERRIR on the command card: selected helicopters in the air. */
    ability(sel) {
      const hs = sel.filter((u) => handles(u) && u.alive && isHuman(u.team) && st(u).mode === "air");
      if (!hs.length) return null;
      return { key: "heliLand", label: t("Atterrir"), hint: t("Se poser sur le terrain plat et dégagé le plus proche. Au sol, l'hélicoptère peut être touché par toutes les armes. Un ordre de mouvement le fait redécoller."), ready: true };
    },
    land(sel) { for (const u of sel) if (handles(u) && st(u).mode === "air") landNear(u, u.position.x, u.position.z); },
  };
}
