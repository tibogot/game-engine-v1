// GARRISONS — men INSIDE the houses (2026-10-06, after opening the villages; Company of
// Heroes' garrisons). Every house of the mechtas and the dechra, and the FLN camp's stone house,
// holds one squad (6 men, the mosque 8):
//   ENTER     right-click a house with infantry selected (the cursor turns to a house over a
//             free one): they run to its door and go in, to the WINDOWS on the side facing
//             the nearest enemy (re-chosen twice a second; algSight: the house's own roof
//             stops a shot through the far side). The FLN's village cells take a house too (algAI.js).
//   INSIDE    not drawn, not pushed, not steered (shared units.js / unitRenderer.js `inside`);
//             bullets hit them half as often (algAccuracy.js), on top of the walls' cover;
//             never pinned.
//   CLEARED   a grenade or a mortar bomb bursting on the house hurts everyone in it, and a
//             second within BAIL_WINDOW s throws the squad out — CoH's counter to a garrison.
//   LEAVE     any move order, RETRAITE, or SORTIR (K): out by the door.
// The badge over a held house: its holder's colour and the men in it (n / places).
import * as THREE from "three";
import { iconStyle } from "./ui/icons.js";

const P = {
  cap: 6, mosqueCap: 8,
  enterReach: 3.2,        // m from the door: in he goes
  // (a bullet's chance on a man inside: algAccuracy.js ACCURACY.inside)
  blastDamage: 0,         // extra to each man inside a burst lands on (its own splash does plenty: 30 killed 5 of 6 with one grenade)
  // ONE burst and they bail out (CoH; 2 let a fire-and-manoeuvre assault's grenades wipe a
  // wounded squad inside: 24 of 24 lost in the bench, 2026-10-06)
  bailBlasts: 1, bailWindow: 10,
  maxSuppression: 0.35,   // never pinned inside
  window: 0.55,           // m inside the wall a man stands at his window
};

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.units     the shared units
 * @param {object} o.squads    algSquads
 * @param {object} o.navGrid
 * @param {object} o.showroom  placed pieces
 * @param {object} [o.fogOfWar]
 */
export function createAlgGarrison(app, { units, squads, navGrid, showroom, fogOfWar = null }) {
  const dom = app.renderer.domElement;
  let clock = 0;

  // ── The houses, in the world ──────────────────────────────────────────────
  const houses = [];
  for (const [key, o] of Object.entries(showroom ?? {})) {
    const hs = o?.isObject3D ? o.geometry?.userData?.houses : null;
    if (!hs?.length || !/^(mechta|dechra|alnCamp)/.test(key)) continue;
    const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    const W = (x, z) => ({ x: o.position.x + x * c + z * s, z: o.position.z - x * s + z * c });
    for (const h of hs) {
      if (!h.w || !h.door) continue;
      const p = W(h.x, h.z), dr = W(h.door[0], h.door[1]);
      const yaw = (h.yaw ?? 0) + o.rotation.y;
      const house = {
        key, piece: o, x: p.x, z: p.z, yaw, hw: h.w / 2, hd: h.d / 2,
        door: navGrid?.nearestOpenWorld?.(dr.x, dr.z, true) ?? dr,
        cap: h.mosque ? P.mosqueCap : P.cap, mosque: !!h.mosque,
        men: [], team: null, blasts: [], slots: [], badge: null,
      };
      house.slots = windowSlots(house);
      houses.push(house);
    }
  }
  /** House-local (lx, lz) → world. */
  function toWorld(h, lx, lz) {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw);
    return { x: h.x + lx * c + lz * s, z: h.z - lx * s + lz * c };
  }
  function toLocal(h, x, z) {
    const c = Math.cos(h.yaw), s = Math.sin(h.yaw), dx = x - h.x, dz = z - h.z;
    return { lx: dx * c - dz * s, lz: dx * s + dz * c };
  }
  const contains = (h, x, z, pad = 0) => { const l = toLocal(h, x, z); return Math.abs(l.lx) <= h.hw + pad && Math.abs(l.lz) <= h.hd + pad; };
  /** A window for each man: the front and the back first, then the ends. */
  function windowSlots(h) {
    const out = [], inX = h.hw - P.window, inZ = h.hd - P.window;
    const front = Math.ceil(h.cap / 3), back = Math.ceil((h.cap - front) / 2), ends = h.cap - front - back;
    const along = (n, half) => Array.from({ length: n }, (_, i) => (n === 1 ? 0 : -half * 0.7 + (1.4 * half * i) / (n - 1)));
    for (const lx of along(front, inX)) out.push({ lx, lz: -inZ, face: [0, -1] });
    for (const lx of along(back, inX)) out.push({ lx, lz: inZ, face: [0, 1] });
    for (let i = 0; i < ends; i++) out.push({ lx: i % 2 ? inX : -inX, lz: 0, face: [i % 2 ? 1 : -1, 0] });
    return out.map((sl) => ({ ...sl, ...toWorld(h, sl.lx, sl.lz), out: toWorld(h, sl.lx + sl.face[0] * 3, sl.lz + sl.face[1] * 3) }));
  }

  // ── In and out ────────────────────────────────────────────────────────────
  const pending = new Map();   // man → house he is walking to
  const room = (h) => h.cap - h.men.length - [...pending.values()].filter((x) => x === h).length;
  /** Send men into `h` (as many as it has room for). The rest: no change. Returns how many go. */
  function order(men, h, { ai = false } = {}) {
    const team = men[0]?.team;
    if (!h || (h.team && h.team !== team)) return 0;
    let n = 0;
    for (const u of men) {
      if (!u?.alive || !u.type?.foot || u.inside || u.team !== team) continue;
      if (room(h) <= 0) break;
      if (navGrid?.isBlockedAtWorld?.(h.door.x, h.door.z, true)) h.door = navGrid.nearestOpenWorld(h.door.x, h.door.z, true);
      pending.set(u, h);
      u._garT = 0; u._garRetry = 0;
      if (ai) u.orderTo(h.door.x, h.door.z); else u.moveOrder(h.door.x, h.door.z);
      n++;
    }
    return n;
  }
  function enter(u, h) {
    const slot = h.slots[h.men.length] ?? h.slots[0];
    h.men.push(u);
    h.team = u.team;
    u.inside = true;
    u.garrison = h;
    u.haltMovement?.();
    u.position.set(slot.x, app.getWorldHeight(slot.x, slot.z), slot.z);
    u.faceToward?.(slot.out.x, slot.out.z);
    u.inCover = true;
    u.playerMove = false;
  }
  function exit(u, spread = 0) {
    const h = u.garrison;
    if (!h) return;
    const i = h.men.indexOf(u);
    if (i >= 0) h.men.splice(i, 1);
    if (!h.men.length) h.team = null;
    u.inside = false;
    u.garrison = null;
    u.inCover = false;
    const a = spread * 2.39996, r = spread ? 1.6 : 0;
    const p = navGrid?.nearestOpenWorld?.(h.door.x + Math.cos(a) * r, h.door.z + Math.sin(a) * r, true) ?? h.door;
    u.position.set(p.x, app.getWorldHeight(p.x, p.z), p.z);
  }
  const exitAll = (list) => { let k = 0; for (const u of list) if (u.inside) exit(u, k++); };

  /** A burst (grenade, mortar bomb) at `at` with `radius`: the houses it lands on. */
  function onSplash(at, radius) {
    for (const h of houses) {
      if (!h.men.length || !contains(h, at.x, at.z, radius * 0.5 + 0.5)) continue;
      for (const u of [...h.men]) u.takeDamage?.(P.blastDamage * (0.7 + Math.random() * 0.6));
      h.blasts.push(clock);
    }
  }

  /**
   * THE WINDOWS TOWARD THE THREAT (CoH: the whole squad fires from the side under attack —
   * a man fixed to his own window left four of six facing a wall: measured, 0 kills from a
   * house against 4 from the street): the walls whose outside faces the nearest enemy (one,
   * or two at a corner), the men spread along them, 1.4 m apart. No enemy near: as they are.
   */
  function faceThreat(h) {
    let best = null, bd = 48;
    for (const u of units.list) {
      if (!u.alive || u.team === h.team || u.isAir || u.isStructure || !u.team) continue;
      const d = Math.hypot(u.position.x - h.x, u.position.z - h.z);
      if (d < bd) { bd = d; best = u; }
    }
    if (!best) return;
    const t = toLocal(h, best.position.x, best.position.z), tl = Math.hypot(t.lx, t.lz) || 1;
    const dir = [t.lx / tl, t.lz / tl];
    const faces = [[0, -1, h.hw], [0, 1, h.hw], [-1, 0, h.hd], [1, 0, h.hd]]
      .map(([nx, nz, half]) => ({ nx, nz, half, dot: nx * dir[0] + nz * dir[1] }))
      .filter((f) => f.dot > 0.25).sort((a, b) => b.dot - a.dot);
    const spots = [];
    for (const f of faces) {
      const n = Math.max(1, Math.floor((2 * f.half - 1.2) / 1.4) + 1);
      for (let i = 0; i < n; i++) {
        const a = n === 1 ? 0 : -f.half + 0.6 + ((2 * f.half - 1.2) * i) / (n - 1);
        const lx = f.nx ? f.nx * (h.hw - P.window) : a, lz = f.nz ? f.nz * (h.hd - P.window) : a;
        spots.push({ ...toWorld(h, lx, lz), out: toWorld(h, lx + f.nx * 3, lz + f.nz * 3) });
      }
    }
    // The men to the spots nearest the enemy first.
    spots.sort((p, q) => Math.hypot(p.x - best.position.x, p.z - best.position.z) - Math.hypot(q.x - best.position.x, q.z - best.position.z));
    h.men.forEach((u, i) => {
      const sp = spots[i % spots.length];
      u.position.set(sp.x, app.getWorldHeight(sp.x, sp.z), sp.z);
      u.faceToward?.(sp.out.x, sp.out.z);
    });
  }

  // ── The sim step ──────────────────────────────────────────────────────────
  let faceT = 0;
  function step(dt) {
    clock += dt;
    for (const [u, h] of pending) {
      if (!u.alive || u.inside || (h.team && h.team !== u.team)) { pending.delete(u); continue; }
      if (Math.hypot(u.position.x - h.door.x, u.position.z - h.door.z) < P.enterReach) {
        pending.delete(u);
        if (h.men.length < h.cap) enter(u, h);
        continue;
      }
      if (u.isMoving) continue;
      // Stopped short. The player's man: given up (the player sees it). The AI's: the door
      // re-found on open ground (props placed after the houses can cover it) and the walk
      // retried every 3 s, for 40 s (measured: FLN cells stood 12-25 m off, no route).
      if (u.team === "player") { pending.delete(u); continue; }
      u._garT = (u._garT ?? 0) + dt;
      if (u._garT > 40) { pending.delete(u); u._garT = 0; continue; }
      if ((u._garRetry = (u._garRetry ?? 0) - dt) > 0) continue;
      u._garRetry = 3;
      if (navGrid?.isBlockedAtWorld?.(h.door.x, h.door.z, true)) h.door = navGrid.nearestOpenWorld(h.door.x, h.door.z, true);
      u.orderTo(h.door.x, h.door.z);
    }
    const reRetreat = new Set();
    const face = (faceT -= dt) <= 0;
    if (face) faceT = 0.5;
    for (const h of houses) {
      if (!h.men.length) continue;
      if (face) faceThreat(h);
      for (const u of [...h.men]) {
        if (!u.alive) {
          // The dead fall in the doorway (a corpse inside a wall reads wrong).
          const i = h.men.indexOf(u); if (i >= 0) h.men.splice(i, 1);
          u.inside = false; u.garrison = null;
          u.position.set(h.door.x, app.getWorldHeight(h.door.x, h.door.z), h.door.z);
          continue;
        }
        u.suppression = Math.min(u.suppression ?? 0, P.maxSuppression);
        u.pinned = false;
        if (u.squad?.retreating) { exit(u, h.men.length); reRetreat.add(u.squad); }
      }
      if (!h.men.length) h.team = null;
      // Two bursts on the house in a few seconds: they bail out, away from the door.
      while (h.blasts.length && clock - h.blasts[0] > P.bailWindow) h.blasts.shift();
      if (h.blasts.length >= P.bailBlasts && h.men.length) {
        const men = [...h.men];
        exitAll(men);
        h.blasts.length = 0;
        const out = toWorld(h, 0, -(h.hd + 9));
        men.forEach((u, k) => u.orderTo(out.x + (k % 3 - 1) * 2.5, out.z + Math.floor(k / 3) * 2.5));
        if (men[0]?.team === "player") app.algBattle?.say?.(`<b>${men[0].squad?.name ?? "Le groupe"}</b> chassé de sa maison !`, h.x, h.z, "bad", null, "alertAttack");
      }
    }
    for (const s of reRetreat) squads?.retreat?.(s);
  }

  // ── The player's order: right-click a house; the cursor over a free one ──
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const pieces = [...new Set(houses.map((h) => h.piece))];
  /** The house under the cursor (its roof or walls, or the ground inside it). */
  function pickAt(clientX, clientY) {
    const r = dom.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, app.camera);
    const hits = ray.intersectObjects(pieces, false);
    const pts = hits.slice(0, 2).map((x) => x.point);
    const g = app.pickWorldAtClient?.(clientX, clientY)?.point;
    if (g) pts.push(g);
    for (const p of pts) {
      let best = null, bd = Infinity;
      for (const h of houses) {
        if (!contains(h, p.x, p.z, 0.8)) continue;
        const d = Math.hypot(p.x - h.x, p.z - h.z);
        if (d < bd) { bd = d; best = h; }
      }
      if (best) return best;
    }
    return null;
  }
  const infantry = () => (app.selection?.selected ?? []).filter((u) => u.alive && u.team === "player" && u.type?.foot && !u.isStructure);
  function onContext(e) {
    const men = infantry();
    if (!men.length || app.renderer.domElement.style.cursor === "crosshair") return;
    const h = pickAt(e.clientX, e.clientY);
    if (!h || (h.team && h.team !== "player")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    // Men already in it stay; the others go in (the first squad fills it).
    const going = order(men.filter((u) => u.garrison !== h), h);
    if (going) {
      app.algOrderMarks?.order?.(h.door.x, app.getWorldHeight(h.door.x, h.door.z), h.door.z, men, "move");
      app.algVoices?.order?.("move", men);
    }
  }
  const HOUSE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30"><path d="M4 14 15 5l11 9v11H4z" fill="#000" fill-opacity=".55" stroke="#000" stroke-width="3.5"/><path d="M4 14 15 5l11 9v11H4z" fill="none" stroke="#7fc3ff" stroke-width="2"/><path d="M12 25v-6h6v6" fill="none" stroke="#7fc3ff" stroke-width="2"/></svg>')}") 15 15, pointer`;
  let hoverT = 0, hoverOn = false;
  function onHover(e) {
    const now = performance.now();
    if (now - hoverT < 90) return;
    hoverT = now;
    if (dom.style.cursor && !hoverOn) return;   // another mode owns it (a sight, a crosshair)
    const h = infantry().length ? pickAt(e.clientX, e.clientY) : null;
    const on = !!h && (!h.team || h.team === "player") && room(h) > 0;
    if (on !== hoverOn) { hoverOn = on; dom.style.cursor = on ? HOUSE_CURSOR : ""; }
  }
  dom.addEventListener("contextmenu", onContext, true);   // capture: before the move order
  dom.addEventListener("pointermove", onHover);

  // ── The badges: over each held house its holder's colour and its men ─────
  const style = document.createElement("style");
  style.textContent = `
.alg-gar { position: fixed; left: 0; top: 0; z-index: 41; display: flex; align-items: center; gap: 3px; padding: 2px 6px 2px 3px;
  background: rgba(12,16,22,0.88); border: 1px solid rgba(90,174,255,0.8); border-radius: 3px; font: 700 10px/14px var(--hud-sans, sans-serif);
  color: #dfe9f2; pointer-events: auto; cursor: pointer; will-change: transform; white-space: nowrap; }
.alg-gar.enemy { border-color: rgba(255,95,78,0.85); }
.alg-gar i { width: 14px; height: 14px; background: #5aaeff; -webkit-mask-size: contain; mask-size: contain; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
.alg-gar.enemy i { background: #ff5f4e; }`;
  document.head.appendChild(style);
  const v = new THREE.Vector3();
  function frame(camera) {
    const r = dom.getBoundingClientRect();
    for (const h of houses) {
      const show = h.men.length > 0 && (h.team === "player" || !fogOfWar?.enabled || fogOfWar.isVisible(h.x, h.z));
      if (!show) { if (h.badge) h.badge.el.style.display = "none"; continue; }
      if (!h.badge) {
        const el = document.createElement("div");
        el.className = "alg-gar";
        el.innerHTML = `<i style="${iconStyle("garrison")}"></i><span></span>`;
        el.addEventListener("click", (e) => { e.stopPropagation(); if (h.team === "player") app.selection?.select(h.men.filter((u) => u.alive)); });
        el.addEventListener("pointerdown", (e) => e.stopPropagation());
        document.body.appendChild(el);
        h.badge = { el, txt: el.querySelector("span"), last: "" };
      }
      v.set(h.x, app.getWorldHeight(h.x, h.z) + 6.5, h.z).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      h.badge.el.style.display = on ? "" : "none";
      if (!on) continue;
      h.badge.el.style.transform = `translate(${Math.round(r.left + (v.x * 0.5 + 0.5) * r.width)}px, ${Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height)}px) translate(-50%, -100%)`;
      const key = `${h.team}|${h.men.length}`;
      if (key !== h.badge.last) {
        h.badge.last = key;
        h.badge.el.classList.toggle("enemy", h.team === "enemy");
        h.badge.txt.textContent = `${h.men.length}/${h.cap}`;
        h.badge.el.title = h.team === "player" ? "Maison occupée — clic : sélectionner · Sortir (K)" : "Maison tenue par le FLN — grenades et mortier les en chassent";
      }
    }
  }

  return {
    params: P, houses, pending,
    order, enter, exit, exitAll, onSplash, step, frame, pickAt,
    /** A free (or own) house near (x, z) within r m, for `team` (the AI's cells). */
    houseNear(x, z, r, team, need = 1) {
      let best = null, bd = r;
      for (const h of houses) {
        if (h.team && h.team !== team) continue;
        if (room(h) < need) continue;
        const d = Math.hypot(h.x - x, h.z - z);
        if (d < bd) { bd = d; best = h; }
      }
      return best;
    },
    /** The command card's SORTIR for a selection with men inside (null: none). */
    ability(sel) {
      if (!sel.some((u) => u.inside && u.team === "player")) return null;
      return { key: "unload", label: "Sortir", hint: "Sortir de la maison par la porte.", ready: true };
    },
    dispose() {
      dom.removeEventListener("contextmenu", onContext, true);
      dom.removeEventListener("pointermove", onHover);
      for (const h of houses) h.badge?.el.remove();
      style.remove();
    },
  };
}
