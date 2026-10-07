// MACHINE-GUN TEAMS (2026-10-07, the AAA list's gameplay depth — Company of Heroes' heavy MG): a
// crew-served gun is a different animal from a rifleman.
//
//   STOPPED      it SETS UP (P.setup s, the gunner going prone), facing where it was going — or
//                the nearest enemy in reach, or where it was pointed (O) — and only then fires.
//   SET UP       it fires only inside its ARC (P.half each side of its facing: shared combat.js
//                `e.arc`), never chases (`noChase`), and PINS harder (`suppressOut`). An enemy
//                in reach outside the arc: the gun swings round slowly (P.pivot rad/s), not
//                firing while it does — that is the window a flank or smoke buys.
//   MOVE ORDER   it PACKS UP first (P.packUp s, the order held), then goes. Packed, it does
//                not fire.
//   RETREAT, GARRISON  packed at once.
//
// Who: the French "pièce FM" team's gunner (algSquads `piece`, slot 0) and the FLN's FM gunners
// (fmTeam). The arc shows on the ground (a draped wedge): your guns when selected or setting up,
// the enemy's set-up guns when you can see them.
import * as THREE from "three";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";

export const MG_TEAM = {
  setup: 2.5,          // s to set up once stopped
  packUp: 2.0,         // s to pack up before a move
  settle: 0.35,        // s stopped before it starts setting up
  half: (30 * Math.PI) / 180,   // the arc: 60°
  pivot: 0.45,         // rad/s the set-up gun swings round
  suppressOut: 1.6,    // its rounds' suppression, × (set up)
  scan: 0.5,           // s between looks for a target outside the arc
  stayWithin: 3,       // m: a move order nearer than this leaves it set up
  // THE SWEEP (CoH's beaten zone): a set-up gun firing suppresses EVERY enemy on foot within
  // sweepR m of its target and inside its arc, sweepRate a second — a spread-out rush is pinned
  // as a whole, not one man at a time (the round's own 6 m area pinned 2 of 5; the rest walked up).
  sweepR: 12, sweepRate: 0.85, suppressMax: 1.6,
  wedgeSegs: 18,
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * @param {object} o
 * @param {object} o.app
 * @param {object} o.units        (list, near)
 * @param {object} o.selection    (selected)
 * @param {(u) => boolean} o.isGunner
 * @param {object} [o.fogOfWar]
 */
export function createAlgMgTeams({ app, units, selection, isGunner, fogOfWar = null }) {
  const P = MG_TEAM;
  const near = [];
  const gunners = () => units.list.filter((u) => u.alive && isGunner(u));

  /** The nearest enemy within reach (no arc), or null. */
  function nearestEnemy(u, reach) {
    let best = null, bd = reach;
    for (const o of units.near(u.position.x, u.position.z, reach, near)) {
      if (!o.alive || o.team === u.team || o.isAir || o.passive || o.inside) continue;
      const d = Math.hypot(o.position.x - u.position.x, o.position.z - u.position.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  const angleTo = (u, o) => Math.atan2(o.position.x - u.position.x, o.position.z - u.position.z);
  const inArc = (st, a) => Math.abs(wrap(a - st.facing)) <= P.half;

  function packedNow(u, st) {
    st.state = "packed"; st.t = 0; st.still = 0;
    u.arc = null; u.noChase = false; u.suppressOut = 1; u.deploy = 0;
  }

  /** FIXED STEP, after posture and squads (it overrides posture and movement). */
  function step(dt) {
    for (const u of gunners()) {
      const st = (u._mg ??= { state: "packed", t: 0, still: 0, facing: u.heading, want: null, scanT: 0, held: null });
      // Retreating, in a house, holding fire to withdraw: packed, no ceremony.
      if (u.squad?.retreating || u.inside || u.holdFire) {
        if (st.state !== "packed") packedNow(u, st);
        if (st.held) st.held = null;
        u.deploy = u.inside ? 1 : 0;   // a gunner at a window still fires (algGarrison)
        continue;
      }
      switch (st.state) {
        case "packed": {
          u.deploy = 0; u.arc = null; u.noChase = false; u.suppressOut = 1;
          st.still = u.isMoving ? 0 : st.still + dt;
          if (st.still >= P.settle) {
            const e = nearestEnemy(u, u.range * 1.15);
            st.facing = st.want ?? (e ? angleTo(u, e) : u.heading);
            st.want = null;
            st.state = "setting"; st.t = 0;
          }
          break;
        }
        case "setting": {
          if (u.isMoving) { packedNow(u, st); break; }   // ordered on before it was set: just go
          st.t += dt;
          u.deploy = Math.min(0.99, st.t / P.setup);
          u.posture = "prone"; u.moveMul = 0;
          faceArc(u, st);
          if (st.t >= P.setup) { st.state = "set"; u.deploy = 1; }
          break;
        }
        case "set": {
          if (u.isMoving) {
            const r = u.route, end = r?.length ? r[r.length - 1] : null;
            // An order to where it already is (the AI re-issues its spots; a squad's formation
            // nudge): it stays set up.
            if (!end || Math.hypot(end.x - u.position.x, end.z - u.position.z) < P.stayWithin) { u.haltMovement?.(); break; }
            // A move order: hold it, pack up, then go.
            st.packs = (st.packs ?? 0) + 1;
            st.held = end ? { x: end.x, z: end.z, playerMove: !!u.playerMove } : null;
            u.haltMovement?.();
            st.state = "packing"; st.t = 0;
            u.arc = null; u.noChase = false; u.deploy = 0;
            break;
          }
          u.deploy = 1; u.noChase = true; u.suppressOut = P.suppressOut;
          u.posture = "prone"; u.moveMul = 0;
          // Swing round: toward where it was pointed, or (every scan) toward an enemy in reach
          // outside the arc when nothing is inside it.
          st.scanT -= dt;
          if (st.want == null && st.scanT <= 0) {
            st.scanT = P.scan;
            const e = nearestEnemy(u, u.range * 1.1);
            if (e && !inArc(st, angleTo(u, e)) && !(u.target?.alive && inArc(st, angleTo(u, u.target)))) st.want = angleTo(u, e);
          }
          if (st.want != null) {
            const d = wrap(st.want - st.facing), stepA = P.pivot * dt;
            if (Math.abs(d) <= stepA) { st.facing = st.want; st.want = null; }
            else st.facing = wrap(st.facing + Math.sign(d) * stepA);
            // Not firing while it swings more than a little.
            u.deploy = Math.abs(d) > P.half * 0.5 ? 0 : 1;
          }
          u.arc = { facing: st.facing, half: P.half };
          faceArc(u, st);
          // The sweep, while it is firing at someone in reach.
          const tg = u.target;
          if (u.deploy === 1 && tg?.alive && Math.hypot(tg.position.x - u.position.x, tg.position.z - u.position.z) <= u.range) {
            const k = P.sweepRate * dt * (u.fireMul ?? 1);
            for (const o of units.near(tg.position.x, tg.position.z, P.sweepR, near)) {
              if (!o.alive || o.team === u.team || !o.type?.foot || o.inside) continue;
              if (!inArc(st, angleTo(u, o)) || Math.hypot(o.position.x - u.position.x, o.position.z - u.position.z) > u.range * 1.1) continue;
              o.suppression = Math.min(P.suppressMax, (o.suppression ?? 0) + k * (o.suppressMul ?? 1));
              o.firedOnBy = u;
            }
          }
          break;
        }
        case "packing": {
          u.deploy = 0; u.arc = null; u.noChase = false; u.suppressOut = 1;
          u.posture = "kneel";
          if (u.isMoving) {   // a newer order while packing: hold that one instead
            const r = u.route, end = r?.length ? r[r.length - 1] : null;
            if (end) st.held = { x: end.x, z: end.z, playerMove: !!u.playerMove };
            u.haltMovement?.();
          }
          st.t += dt;
          if (st.t >= P.packUp) {
            const h = st.held;
            packedNow(u, st);
            st.held = null;
            if (h) { u.moveOrder(h.x, h.z); if (h.playerMove) u.playerMove = true; }
          }
          break;
        }
      }
    }
  }
  function faceArc(u, st) {
    u.faceToward?.(u.position.x + Math.sin(st.facing) * 10, u.position.z + Math.cos(st.facing) * 10);
  }

  // ── POINT THE ARC (O): the selected gunners face where you click ──────────
  const dom = app.renderer.domElement;
  let aiming = null;   // the gunners, while the cursor waits for a click
  const selectedGunners = (sel = selection.selected) => (sel ?? []).filter((u) => u.alive && u.team === "player" && isGunner(u));
  function ability(sel) {
    const g = selectedGunners(sel);
    if (!g.length) return null;
    return { key: "aimArc", label: "Orienter", hint: "Orienter la mitrailleuse : cliquez où elle doit tirer. En batterie, elle pivote (lentement) ; repliée, elle se mettra en batterie face à ce point. O.", ready: true };
  }
  function begin(sel = selection.selected) {
    const g = selectedGunners(sel);
    if (!g.length) return false;
    aiming = g; dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { aiming = null; dom.style.cursor = ""; }
  const onDown = (e) => {
    if (!aiming) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.button !== 0) { cancel(); return; }
    const hit = app.pickWorldAtClient?.(e.clientX, e.clientY);
    if (hit?.point) {
      for (const u of aiming) {
        const st = (u._mg ??= { state: "packed", t: 0, still: 0, facing: u.heading, want: null, scanT: 0, held: null });
        st.want = Math.atan2(hit.point.x - u.position.x, hit.point.z - u.position.z);
      }
    }
    cancel();
  };
  const onKey = (e) => {
    if (e.repeat || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? "")) return;
    if (e.key === "Escape" && aiming) { cancel(); return; }
  };
  const onContext = (e) => { if (aiming) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey);

  // ── THE ARC ON THE GROUND: a draped wedge per shown gun ───────────────────
  const N = P.wedgeSegs;
  const makeWedge = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * 2 * 3), 3));
    const idx = [];
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    const fill = new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    const edgeG = new THREE.BufferGeometry();
    edgeG.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 3) * 3), 3));
    const edge = new THREE.Line(edgeG, new THREE.LineBasicNodeMaterial({ transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
    fill.renderOrder = edge.renderOrder = RENDER_ORDER.COVER_VIEW;   // with the cover overlay: over the ground marks, under the units' smoke
    fill.frustumCulled = edge.frustumCulled = false;
    fill.castShadow = fill.receiveShadow = false;
    app.scene.add(fill, edge);
    return { fill, edge };
  };
  const pool = [];
  const H = (x, z) => (app.getWorldHeight?.(x, z) ?? 0) + 0.35;
  function drawWedge(w, u, st, colour, alpha) {
    const pos = w.fill.geometry.attributes.position, e = w.edge.geometry.attributes.position;
    const r0 = 1.6, r1 = u.range, x0 = u.position.x, z0 = u.position.z;
    for (let i = 0; i <= N; i++) {
      const a = st.facing - P.half + (2 * P.half * i) / N, sx = Math.sin(a), cz = Math.cos(a);
      const ax = x0 + sx * r0, az = z0 + cz * r0, bx = x0 + sx * r1, bz = z0 + cz * r1;
      pos.setXYZ(i * 2, ax, H(ax, az), az);
      pos.setXYZ(i * 2 + 1, bx, H(bx, bz), bz);
      e.setXYZ(i + 1, bx, H(bx, bz), bz);
    }
    const a0 = st.facing - P.half, a1 = st.facing + P.half;
    e.setXYZ(0, x0 + Math.sin(a0) * r0, H(x0 + Math.sin(a0) * r0, z0 + Math.cos(a0) * r0), z0 + Math.cos(a0) * r0);
    e.setXYZ(N + 2, x0 + Math.sin(a1) * r0, H(x0 + Math.sin(a1) * r0, z0 + Math.cos(a1) * r0), z0 + Math.cos(a1) * r0);
    pos.needsUpdate = e.needsUpdate = true;
    w.fill.material.color.set(colour); w.edge.material.color.set(colour);
    w.fill.material.opacity = 0.16 * alpha; w.edge.material.opacity = 0.85 * alpha;
    w.fill.visible = w.edge.visible = true;
  }

  /** Every frame (render side): the arcs. */
  function frame() {
    const sel = new Set(selection.selected ?? []);
    let k = 0;
    for (const u of gunners()) {
      const st = u._mg;
      if (!st || u.inside) continue;
      let colour = null, alpha = 1;
      if (u.team === "player") {
        if (!sel.has(u) && st.state !== "setting") continue;
        if (st.state === "packed" && st.want == null) continue;
        colour = st.state === "set" ? 0xffcc33 : 0xd8d2c0;
        alpha = st.state === "set" ? 1 : 0.6;
      } else {
        if (st.state !== "set") continue;
        if (fogOfWar?.enabled && !fogOfWar.isVisible(u.position.x, u.position.z)) continue;
        colour = 0xff5a3c; alpha = 0.7;
      }
      const show = st.state === "packed" ? { ...st, facing: st.want } : st;
      const w = pool[k] ?? (pool[k] = makeWedge());
      drawWedge(w, u, show, colour, alpha);
      k++;
    }
    for (let i = k; i < pool.length; i++) pool[i].fill.visible = pool[i].edge.visible = false;
  }

  return {
    params: P, step, frame, ability, begin, cancel,
    get aiming() { return !!aiming; },
    stateOf: (u) => u._mg?.state ?? "packed",
    /** Point a gunner's arc at (x, z) (the AI): set up, it swings round; packed, it will set up facing it. */
    aimAt(u, x, z) {
      const st = (u._mg ??= { state: "packed", t: 0, still: 0, facing: u.heading, want: null, scanT: 0, held: null });
      st.want = Math.atan2(x - u.position.x, z - u.position.z);
    },
    dispose() {
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
      for (const w of pool) { app.scene.remove(w.fill, w.edge); w.fill.geometry.dispose(); w.edge.geometry.dispose(); }
    },
  };
}
