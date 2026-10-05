// ── Horse lab: motion audit ──────────────────────────────────────────────────
// Replays every horse action on flat ground with a FIXED time step, twice:
// once with hoof IK on (what we ship) and once with it off (the clip as
// authored, plus our procedural moves), and checks every frame:
//
//   under    a hoof's sole below the ground                         (> 2 cm)
//   slide    a planted hoof moving along the ground                 (> 1.5 cm/frame,
//            and more than the reference run slides — the clip's own skating
//            is a clip issue, reported separately as refSlide)
//   pop      a one-frame jump: position far from the average of the frames
//            around it, beyond what the reference run has            (> 3 cm extra)
//   height   a hoof higher above the ground than in the reference    (> 15 cm extra:
//            catches stacked lifts, like the jump arc on top of the clip's own jump)
//   joints   where IK has nothing to correct (< 1 cm), it must change nothing:
//            stifle / hock / knee angles vs the reference            (> 8°)
//            (skipped for the rear: its body placement is procedural)
//   blend    a crossfade between two clip poses more than 170° apart (summed
//            over legs/body/neck) — blending poses that far apart shows thin,
//            misplaced legs for a moment (gallop mid-stride → jump was ~470°)
//
// It drives the controller directly (the page loop pauses while it runs), so
// results do not depend on frame rate or on the window being visible.
import * as THREE from "three";

const V3 = THREE.Vector3;
const FEET = ["FFL", "FFR", "FFBL", "FFBR"];
const DT = 1 / 60;
const LIMITS = { under: 0.02, slide: 0.015, pop: 0.03, height: 0.15, joint: 8, blend: 170 };   // blend: Idle→Walk is 158° at best with this pack (no walk pose looks like standing)

// input over time: (t) => { fwd, turn, run }; actions: [[t, (ctrl) => …]]
export const SCENARIOS = {
  idle: { secs: 4, input: () => ({}) },
  walk: { secs: 4, input: () => ({ fwd: 1 }) },
  gallop: { secs: 5, input: () => ({ fwd: 1, run: true }) },
  trot: { secs: 4, input: (t) => ({ fwd: 1, gearUp: t === 0 }) },
  canter: { secs: 4.5, input: (t) => ({ fwd: 1, gearUp: t < 0.04 }) },
  "gear up and down": { secs: 9, input: (t) => ({ fwd: t < 8 ? 1 : 0, gearUp: [0.5, 2, 3.5].some((x) => Math.abs(t - x) < 0.008), gearDown: [5, 6.5].some((x) => Math.abs(t - x) < 0.008) }) },
  "walk back": { secs: 3, input: () => ({ fwd: -1 }) },
  "turn on spot": { secs: 3, input: () => ({ turn: 1 }) },
  "walk + turn": { secs: 3, input: () => ({ fwd: 1, turn: -1 }) },
  "gallop + turn": { secs: 4, input: () => ({ fwd: 1, run: true, turn: 1 }) },
  jump: { secs: 5, input: () => ({ fwd: 1, run: true }), actions: [[2.5, (c) => c.queueJump()]] },
  rear: { secs: 4.5, input: () => ({}), actions: [[0.5, (c) => c.startRear()]], procedural: true },
  buck: { secs: 2, input: () => ({}), actions: [[0.5, (c) => c.playOneShot("Attack_Kick")]] },
  "head toss": { secs: 4, input: () => ({}), actions: [[0.3, (c) => c.playOneShot("Idle_2")]] },
  eating: { secs: 6.5, input: () => ({}), actions: [[0.3, (c) => c.playOneShot("Eating")]] },
};

function angle(a, b, c) { return a.clone().sub(b).angleTo(c.clone().sub(b)) * 180 / Math.PI; }

function reset(ctrl, startZ) {
  ctrl.pos.set(0, 0, startZ); ctrl.yaw = 0; ctrl.v = 0; ctrl.turnRate = 0; ctrl.y = 0;
  ctrl.pitch = 0; ctrl.roll = 0; ctrl.oneShot = null; ctrl.rearT = -1; ctrl.landT = -1;
  ctrl.idleT = -1e9; ctrl.lift = 0; ctrl.ikW = 1; ctrl.bodyOff = 0; ctrl.gear = 0;
  ctrl.mixer.stopAllAction();
  ctrl.cur = null; ctrl.gaitName = "";
  ctrl.switchTo("Idle", 0);
}

export function record(ctrl, rider, sc, ik, HP, startZ) {
  const h = ctrl.h, bone = h.bone;
  const saved = HP.ik;
  HP.ik = ik;
  reset(ctrl, startZ);
  for (let i = 0; i < 60; i++) { ctrl.update(DT, { fwd: 0, turn: 0, run: false }); ctrl.idleT = -1e9; rider?.update(DT, {}); }   // settle 1 s
  ctrl.blendLog.length = 0;
  const frames = [];
  const acts = [...(sc.actions ?? [])];
  const n = Math.round(sc.secs / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    while (acts.length && acts[0][0] <= t) acts.shift()[1](ctrl);
    const inp = sc.input(t);
    ctrl.update(DT, { fwd: inp.fwd ?? 0, turn: inp.turn ?? 0, run: !!inp.run, gearUp: !!inp.gearUp, gearDown: !!inp.gearDown });
    ctrl.idleT = -1e9;
    rider?.update(DT, {});
    h.rig.updateMatrixWorld(true);
    const P = (b) => bone(b).getWorldPosition(new V3());
    const feet = FEET.map(P);
    const ground = feet.map((p) => ctrl.sampleGround(p.x, p.z, p.y, 1.5) ?? 0);
    const j = [];
    for (const s of ["L", "R"]) {
      j.push(angle(P("BackLeg" + s), P("BackUpperLeg" + s), P("BackLowerLeg" + s)));
      j.push(angle(P("BackUpperLeg" + s), P("BackLowerLeg" + s), P("IKBackLeg" + s)));
      j.push(angle(P("FrontUpperLeg" + s), P("FrontLowerLeg" + s), P("IKFrontLeg" + s)));
    }
    frames.push({ t, feet, ground, joints: j, ikCorr: ik ? (ctrl.ikCorr ?? 0) : 0, state: ctrl.rearT >= 0 ? "Rear" : ctrl.oneShot ? ctrl.oneShotName : ctrl.gaitName });
  }
  HP.ik = saved;
  frames.blends = [...ctrl.blendLog];
  return frames;
}

// ref: the IK-off run of the same action — a hoof only counts as PLANTED where
// the clip itself has it down (a swinging hoof skimming the ground, lowered a
// cm by the body sinking in a turn, is not "sliding")
export function analyse(frames, sole, ref = null) {
  const r = { under: 0, slide: 0, pop: 0, height: 0, at: {} };
  const note = (k, v, f) => { if (v > r[k]) { r[k] = v; r.at[k] = `${f.state} t=${f.t.toFixed(2)}`; } };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    for (let k = 0; k < 4; k++) {
      const h = f.feet[k].y - sole - f.ground[k];
      note("under", -h, f);
      note("height", h, f);
      if (i > 0) {
        const p = frames[i - 1];
        const hp = p.feet[k].y - sole - p.ground[k];
        const refDown = !ref || (ref[i] && ref[i - 1] && ref[i].feet[k].y - sole - ref[i].ground[k] < 0.02 && ref[i - 1].feet[k].y - sole - ref[i - 1].ground[k] < 0.02);
        if (h < 0.02 && hp < 0.02 && refDown) note("slide", Math.hypot(f.feet[k].x - p.feet[k].x, f.feet[k].z - p.feet[k].z), f);
      }
      if (i > 0 && i < frames.length - 1) {
        const mid = frames[i - 1].feet[k].clone().add(frames[i + 1].feet[k]).multiplyScalar(0.5);
        note("pop", f.feet[k].distanceTo(mid), f);
      }
    }
  }
  return r;
}

export function runAudit(objs, opts = {}) {
  const rows = Object.keys(SCENARIOS).map((name) => auditOne(objs, name, opts));
  reset(objs.ctrl, opts.startZ ?? -25);
  return rows;
}

// Same, one action per task so the page keeps drawing (the button used to
// freeze the scene for seconds).
export async function runAuditAsync(objs, { onProgress, ...opts } = {}) {
  const rows = [], names = Object.keys(SCENARIOS);
  for (const [i, name] of names.entries()) {
    onProgress?.(name, i, names.length);
    await new Promise((r) => setTimeout(r, 0));
    rows.push(auditOne(objs, name, opts));
  }
  reset(objs.ctrl, opts.startZ ?? -25);
  return rows;
}

function auditOne({ ctrl, rider, HP }, name, { startZ = -25 } = {}) {
  const sole = ctrl.h.foot.sole;
  const sc = SCENARIOS[name];
  {
    const on = record(ctrl, rider, sc, true, HP, startZ);
    const off = record(ctrl, rider, sc, false, HP, startZ);
    const a = analyse(on, sole, off), b = analyse(off, sole);
    let joint = 0, jointAt = "";
    if (!sc.procedural) for (let i = 0; i < Math.min(on.length, off.length); i++) {
      for (let k = 0; k < on[i].joints.length; k++) {
        // IK had a real correction to make in the last 0.25 s (lean, slope; the
        // body sink is smoothed so it lingers a few frames): changing joints is its job
        if (on.slice(Math.max(0, i - 15), i + 1).some((f) => f.ikCorr >= 0.01)) continue;
        const d = Math.abs(on[i].joints[k] - off[i].joints[k]);
        if (d > joint) { joint = d; jointAt = `${on[i].state} t=${on[i].t.toFixed(2)}`; }
      }
    }
    const fails = [];
    if (a.under > LIMITS.under) fails.push(`hoof ${(a.under * 100).toFixed(1)} cm under the ground (${a.at.under})`);
    if (a.slide > LIMITS.slide && a.slide > b.slide + 0.005) fails.push(`planted hoof slides ${(a.slide * 100).toFixed(1)} cm/frame (${a.at.slide})`);
    if (a.pop > b.pop + LIMITS.pop) fails.push(`one-frame pop ${(a.pop * 100).toFixed(1)} cm vs clip ${(b.pop * 100).toFixed(1)} (${a.at.pop})`);
    if (a.height > b.height + LIMITS.height) fails.push(`hoof ${(a.height * 100).toFixed(0)} cm up vs clip ${(b.height * 100).toFixed(0)} (${a.at.height})`);
    const worstBlend = on.blends.reduce((b, x) => (x.deg > (b?.deg ?? -1) ? x : b), null);
    if (worstBlend && worstBlend.deg > LIMITS.blend) fails.push(`blend ${worstBlend.from} → ${worstBlend.to} across ${worstBlend.deg}° of pose`);
    if (joint > LIMITS.joint) fails.push(`IK bends a joint ${joint.toFixed(0)}° on flat ground (${jointAt})`);
    return {
      action: name, ok: fails.length === 0, fails,
      underCm: +(a.under * 100).toFixed(1), slideCm: +(a.slide * 100).toFixed(1), refSlideCm: +(b.slide * 100).toFixed(1),
      popCm: +(a.pop * 100).toFixed(1), refPopCm: +(b.pop * 100).toFixed(1), maxHoofCm: +(a.height * 100).toFixed(0), refMaxHoofCm: +(b.height * 100).toFixed(0),
      jointDeg: sc.procedural ? null : +joint.toFixed(1),
      worstBlendDeg: worstBlend ? worstBlend.deg : 0, blends: on.blends.map((b) => `${b.from}→${b.to} ${b.deg}°`).join(", "),
    };
  }
}
