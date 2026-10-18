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
//
// THE 12.7 (the FLN's DShK, `mitrailleuse` — 2026-10-19, CoH: a team weapon reads at a glance): packed,
// the gun rides on the gunner's back and its tripod on the loader's (soldierLooks KIT dshkBack /
// dshkTripod), both with their rifles; set up, the gun stands on its TRIPOD on the ground before the
// gunner, prone on its spade grips, his hands empty (one instanced draw for every team, below).
import * as THREE from "three";
import { assemble, bakeContactAO, buildBox, MAT, wirePart } from "../../v3/render/objects/rtsParts.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";
import { RENDER_ORDER } from "../shared-rts/renderOrder.js";
import { RTS_SCALE } from "./algUnitTypes.js";
import { t } from "./i18n/i18n.js";

/**
 * The DShK on its low tripod, origin on the ground under the tripod's head, +Z the way it fires: the
 * finned barrel and its muzzle brake, the box receiver, the anti-aircraft ring sight, the spade grips
 * behind (where the gunner's hands are), the belt box on its left. ~1.6 m, the axis 0.56 m up.
 */
function buildDshkMount() {
  const S = MAT.steel, axisY = 0.56, alongZ = [Math.PI / 2, 0, 0];
  const parts = [
    wirePart([0, 0.37, 0.03], [-0.36, 0.0, 0.42], 0.02, { tone: 0.3 }),   // the front legs
    wirePart([0, 0.37, 0.03], [0.36, 0.0, 0.42], 0.02, { tone: 0.3 }),
    wirePart([0, 0.37, -0.03], [0, 0.0, -0.64], 0.02, { tone: 0.3 }),     // the trail leg
    { geo: buildBox(0.08, 0.1, 0.08), pos: [0, 0.41, 0], mat: S, tone: 0.22 },          // the pintle
    { geo: buildBox(0.1, 0.05, 0.42), pos: [0, 0.47, 0.03], mat: S, tone: 0.24 },       // the cradle
    { geo: buildBox(0.13, 0.15, 0.5), pos: [0, axisY, -0.06], mat: S, tone: 0.18 },     // the receiver
    { geo: buildBox(0.11, 0.03, 0.21), pos: [0, axisY + 0.088, 0.0], mat: S, tone: 0.28 },   // the feed cover
    { geo: buildBox(0.15, 0.06, 0.02), pos: [0, axisY, -0.322], mat: S, tone: 0.16 },   // the back plate
    { geo: buildBox(0.03, 0.11, 0.03), pos: [0.062, axisY - 0.01, -0.36], mat: S, tone: 0.12 },   // the spade grips
    { geo: buildBox(0.03, 0.11, 0.03), pos: [-0.062, axisY - 0.01, -0.36], mat: S, tone: 0.12 },
    { geo: new THREE.CylinderGeometry(0.024, 0.024, 0.96, 8), pos: [0, axisY, 0.67], rot: alongZ, mat: S, tone: 0.2 },   // the barrel
    { geo: new THREE.CylinderGeometry(0.04, 0.037, 0.11, 10), pos: [0, axisY, 1.17], rot: alongZ, mat: S, tone: 0.14 },  // the muzzle brake
    { geo: new THREE.TorusGeometry(0.085, 0.007, 4, 18), pos: [0, axisY + 0.21, 0.2], mat: S, tone: 0.2 },   // the AA ring sight
    { geo: buildBox(0.012, 0.13, 0.012), pos: [0, axisY + 0.13, 0.2], mat: S, tone: 0.2 },                    // its post
    { geo: buildBox(0.12, 0.17, 0.27), pos: [-0.16, axisY - 0.06, -0.05], mat: MAT.paint, tone: 0.3 },        // the belt box
    { geo: buildBox(0.06, 0.014, 0.1), pos: [-0.085, axisY + 0.035, -0.03], mat: S, tone: 0.45, rot: [0, 0, -0.5] },   // the belt
  ];
  for (let k = 0; k < 8; k++) parts.push({ geo: new THREE.CylinderGeometry(0.049, 0.049, 0.016, 10), pos: [0, axisY, 0.25 + k * 0.044], rot: alongZ, mat: S, tone: 0.1 });   // the radiator's fins
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.05, radius: 1, strength: 0.3, groundFade: 0.15, floor: 0.6 });
  return geo;
}

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
  // The 12.7 set up: its tripod this far before the prone gunner's origin (m, before the unit scale) —
  // the spade grips at his hands; the gun down at this share of the set-up, up at this of the pack-up.
  dshk: { ahead: 1.15, downAt: 0.5, upAt: 0.5, max: 16, loaderSide: 1.1, loaderAhead: 0.5 },
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
export function createAlgMgTeams({ app, units, selection, isGunner, fogOfWar = null, emplacements = () => [] }) {
  const P = MG_TEAM;
  const near = [];
  // EMPLACED GUNS (the MG nest, algStructures `arcGun`): always set up, their facing where they
  // were built — the same arc, sweep and slow swing, never packed.
  const gunners = () => [...units.list.filter((u) => u.alive && isGunner(u)), ...emplacements().filter((s) => s.alive && s.arcGun)];

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

  /** THE 12.7's GUN: on the gunner's back (and the tripod on his loader's) or down on its tripod. */
  const isHmg = (u) => u.typeKey === "mitrailleuse";
  const gunDown = (st) => st.state === "set" || (st.state === "setting" && st.t >= P.setup * P.dshk.downAt) || (st.state === "packing" && st.t < P.packUp * P.dshk.upAt);
  function hmgKit(u, st) {
    const R = app.algUnitRenderer;
    if (!R) return;
    const down = gunDown(st), ld = u.squad?.members.find((m) => m !== u && m.alive) ?? null;
    // (Recorded only once the renderer took it: a man spawned this tick has no view to dress yet.)
    if (u._dshkDown !== down && R.setKit(u, "dshkBack", !down)) {
      R.setWeapon(u, down ? null : "mas36");   // his hands on the grips / his rifle back
      u._dshkDown = down;
    }
    if (u._dshkLoader !== ld || u._dshkLoaderDown !== down) {
      if (u._dshkLoader && u._dshkLoader !== ld) R.setKit(u._dshkLoader, "dshkTripod", false);
      if (!ld || R.setKit(ld, "dshkTripod", !down)) { u._dshkLoader = ld; u._dshkLoaderDown = down; }
    }
    // A load on their backs: they run with it, rifles slung (unitRenderer carryRun).
    u.carrying = !down;
    if (ld) ld.carrying = !down;
    // THE LOADER'S PLACE (CoH's crew slots): the gun down, he lies by its belt box, beside the gunner —
    // not across him (both were sent to one point: he lay over the gun).
    if (down && ld && !ld.isMoving && !ld.inside && st.state === "set") {
      const f = st.facing, k = RTS_SCALE;
      const sx = u.position.x - Math.cos(f) * P.dshk.loaderSide * k + Math.sin(f) * P.dshk.loaderAhead * k;
      const sz = u.position.z + Math.sin(f) * P.dshk.loaderSide * k + Math.cos(f) * P.dshk.loaderAhead * k;
      if ((ld._slotTries ?? 0) < 3 && Math.hypot(ld.position.x - u.position.x, ld.position.z - u.position.z) < 8 && Math.hypot(ld.position.x - sx, ld.position.z - sz) > 0.7) {
        ld.orderTo(sx, sz);
        ld._slotTries = (ld._slotTries ?? 0) + 1;   // (three goes: a blocked spot is not chased every tick)
      }
    }
    if (!down && ld) ld._slotTries = 0;
  }

  /** FIXED STEP, after posture and squads (it overrides posture and movement). */
  function step(dt) {
    for (const u of gunners()) {
      const st = (u._mg ??= { state: "packed", t: 0, still: 0, facing: u.heading, want: null, scanT: 0, held: null });
      if (isHmg(u)) hmgKit(u, st);
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
          // An AA gun on its tripod (the FLN's 12.7, type.prefersAir) traverses ALL ROUND: no arc — it
          // only had to set up. (Its 60° arc left a helicopter beside it untouched: the lab, 2026-10-13.)
          u.arc = u.type?.prefersAir ? null : { facing: st.facing, half: P.half };
          if (u.type?.prefersAir && u.target?.alive) st.facing = angleTo(u, u.target);
          faceArc(u, st);
          // THE CREW lies down with the gun (CoH): his squad mates standing by him, not moving.
          for (const m of u.squad?.members ?? []) {
            if (m === u || m.isMoving || m.inside) continue;
            if (Math.hypot(m.position.x - u.position.x, m.position.z - u.position.z) < 6) m.posture = "prone";
          }
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
  const selectedGunners = (sel = selection.selected) => (sel ?? []).filter((u) => u.alive && isHuman(u.team) && (u.arcGun || isGunner(u)));
  function ability(sel) {
    const g = selectedGunners(sel);
    if (!g.length) return null;
    return { key: "aimArc", label: t("Orienter"), hint: t("Orienter la mitrailleuse : cliquez où elle doit tirer. En batterie, elle pivote (lentement) ; repliée, elle se mettra en batterie face à ce point. O."), ready: true };
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
  // RADIAL rings too (2026-10-07, the audit: a 42 m wedge sampled only at its two ends floated
  // over the dips and painted across the SAS post's yard and walls): DRAPED every ~6 m out.
  const M = 7;
  const makeWedge = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array((N + 1) * (M + 1) * 3), 3));
    const idx = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j, b = a + M + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    g.setIndex(idx);
    const fillMat = new THREE.MeshBasicNodeMaterial({ transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, fog: false });
    fillMat.forceSinglePass = true;   // flat on the ground: the back-face pass only doubled it
    const fill = new THREE.Mesh(g, fillMat);
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
  function drawWedge(w, u, st, colour, alpha, fillK = 0.16) {
    const pos = w.fill.geometry.attributes.position, e = w.edge.geometry.attributes.position;
    const r0 = 1.6, r1 = u.range, x0 = u.position.x, z0 = u.position.z;
    for (let i = 0; i <= N; i++) {
      const a = st.facing - P.half + (2 * P.half * i) / N, sx = Math.sin(a), cz = Math.cos(a);
      for (let j = 0; j <= M; j++) {
        const r = r0 + (r1 - r0) * (j / M), x = x0 + sx * r, z = z0 + cz * r;
        pos.setXYZ(i * (M + 1) + j, x, H(x, z), z);
      }
      const bx = x0 + sx * r1, bz = z0 + cz * r1;
      e.setXYZ(i + 1, bx, H(bx, bz), bz);
    }
    const a0 = st.facing - P.half, a1 = st.facing + P.half;
    e.setXYZ(0, x0 + Math.sin(a0) * r0, H(x0 + Math.sin(a0) * r0, z0 + Math.cos(a0) * r0), z0 + Math.cos(a0) * r0);
    e.setXYZ(N + 2, x0 + Math.sin(a1) * r0, H(x0 + Math.sin(a1) * r0, z0 + Math.cos(a1) * r0), z0 + Math.cos(a1) * r0);
    pos.needsUpdate = e.needsUpdate = true;
    w.fill.material.color.set(colour); w.edge.material.color.set(colour);
    w.fill.material.opacity = fillK * alpha; w.edge.material.opacity = 0.85 * alpha;
    w.fill.visible = w.edge.visible = true;
  }

  // THE 12.7s DOWN on their tripods: one instanced draw for them all.
  const dshks = new THREE.InstancedMesh(buildDshkMount(), rtsObjectMaterial(), P.dshk.max);
  dshks.castShadow = true; dshks.receiveShadow = true;
  dshks.frustumCulled = false; dshks.count = 0; dshks.visible = false;
  dshks.name = "DShKMounts";
  app.scene.add(dshks);
  const _dm = new THREE.Matrix4(), _dq = new THREE.Quaternion(), _dp = new THREE.Vector3(), _ds = new THREE.Vector3(), _dy = new THREE.Vector3(0, 1, 0);
  function drawDshks() {
    let n = 0;
    for (const u of units.list) {
      if (!u.alive || !isHmg(u) || !u._dshkDown || !u._mg || n >= P.dshk.max) continue;
      // Under the fog: the enemy's gun no more than its crew (algMortarTeam's rule).
      if (fogOfWar?.enabled && !isHuman(u.team) && !fogOfWar.canSeeEntity?.(u)) continue;
      const f = u._mg.facing, ahead = P.dshk.ahead * RTS_SCALE;
      _dp.set(u.position.x + Math.sin(f) * ahead, 0, u.position.z + Math.cos(f) * ahead);
      _dp.y = app.getWorldHeight(_dp.x, _dp.z) - 0.02;
      dshks.setMatrixAt(n++, _dm.compose(_dp, _dq.setFromAxisAngle(_dy, f), _ds.setScalar(RTS_SCALE)));
    }
    dshks.count = n;
    dshks.visible = n > 0;
    if (n) dshks.instanceMatrix.needsUpdate = true;
  }

  /** Every frame (render side): the arcs, the 12.7s on their tripods. */
  function frame() {
    drawDshks();
    const sel = new Set(selection.selected ?? []);
    let k = 0;
    for (const u of gunners()) {
      const st = u._mg;
      if (!st || u.inside || u.type?.prefersAir) continue;   // (an all-round AA gun: no wedge)
      let colour = null, alpha = 1;
      if (isHuman(u.team)) {
        if (!sel.has(u) && st.state !== "setting") continue;
        if (st.state === "packed" && st.want == null) continue;
        colour = st.state === "set" ? 0xffcc33 : 0xd8d2c0;
        alpha = st.state === "set" ? 1 : 0.6;
      } else {
        if (st.state !== "set") continue;
        if (fogOfWar?.enabled && !fogOfWar.isVisible(u.position.x, u.position.z)) continue;
        colour = 0xff5a3c; alpha = 0.7;
      }
      // THE FILL IS A TINT, the edge carries the arc (2026-10-07, the audit: the enemy's read as a
      // solid red field over the SAS post). The fill is unlit, so the scene's EXPOSURE scales it
      // many times before it blends: 0.05 read as ~40% red, 0 → none, 0.012 → a light warm tint
      // (measured in the game, Sky Pro day). Yours a little stronger: you placed it.
      const fillK = isHuman(u.team) ? 0.03 : 0.015;
      const show = st.state === "packed" ? { ...st, facing: st.want } : st;
      const w = pool[k] ?? (pool[k] = makeWedge());
      drawWedge(w, u, show, colour, alpha, fillK);
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
