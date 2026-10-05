// ── Horse lab: rider check ───────────────────────────────────────────────────
// Steps a rider performance frame by frame (fixed 1/60 s, like the game) and
// measures what the eye catches late or not at all:
//
//   ground feet   (on the ground) sole under the floor · floating · not flat
//                 (ankle→ball pitch vs the standing foot's)
//   iron feet     (in a stirrup) the ball of the foot away from its tread
//   inside horse  thigh / shin points inside the barrel (skin from tack.js)
//   twist         hip twisted vs the bind pose · ankle twisted vs the shin
//   pops          a joint jumping in ONE frame (off the average of its neighbours)
//
// checkClip(H, "mount" | "dismount") and checkRiding(H, "idle" | …) return
// { frames, worst: {metric: {v, f}}, issues: [...] } — frame numbers match the
// editor's (f = t × 60).
import * as THREE from "three";
import { hipTwistDeg, footTwistDeg } from "./rider.js";
import { BALL_TO_TREAD } from "./stirrups.js";

const V3 = THREE.Vector3;
const DT = 1 / 60;
const wpos = (o) => o.getWorldPosition(new V3());
// closest distance between segments ab and cd
function segDist(a, b, c, d) {
  let best = Infinity;
  for (let i = 0; i <= 8; i++) { const p = a.clone().lerp(b, i / 8); const cd = d.clone().sub(c); const t = Math.max(0, Math.min(1, p.clone().sub(c).dot(cd) / Math.max(1e-9, cd.lengthSq()))); best = Math.min(best, p.distanceTo(c.clone().addScaledVector(cd, t))); }
  return best;
}
// kneeBack: the kneecap points BEHIND the hips (vs the pelvis forward) — the
// broken 'leg rotating at the hip' look. hipDeg (roll vs the bind pose) is kept as
// information only: a knee keyed to roll OUT over a folded leg reads ~150° there
// while looking right.
export const LIMITS = { handBack: 0.12, limbCross: 0.03,   // closer than 3 cm = through each other (a hand on the saddle beside the thigh sits ~4 cm off it)
  under: 0.015, float: 0.03, flatDeg: 12, ironGap: 0.06, inside: 0.03, kneeBack: 60, footDeg: 30, pop: 0.03 };

function measureFrame(H, f, extra) {
  const rd = H.rider, ms = rd.mountSys, S = rd.saddle, tack = H.tack;
  const out = { f };
  const up = new V3(0, 1, 0).applyQuaternion(S.getWorldQuaternion(new THREE.Quaternion()));
  const ground = H.ctrl.y;                                   // flat yard
  rd.B.legs.forEach((g, i) => {
    const A = wpos(g.tip), Bl = wpos(g.ball), K = wpos(g.l), Hp = wpos(g.u);
    const L = i === 0 ? "L" : "R";
    // ground feet: lowest of ankle-sole / ball-sole
    const soleBall = Bl.y - 0.035 - ground, soleHeel = A.y - ms.ankleUp - ground;
    out["sole" + L] = Math.min(soleBall, soleHeel);
    const pitch = Math.atan2(A.y - Bl.y, Math.hypot(Bl.x - A.x, Bl.z - A.z));
    out["pitch" + L] = (pitch - (ms.footPitch ?? pitch)) * 57.3;
    out["onGround" + L] = extra.onGround?.[i] ?? (out["sole" + L] < 0.05);
    // iron
    const sd = rd.stirrups.side[i];
    out["iron" + L] = sd.held ? S.worldToLocal(Bl.clone().addScaledVector(up, -BALL_TO_TREAD)).distanceTo(sd.p) : null;
    // inside the horse: points along thigh and shin, radial vs skin
    let inside = 0;
    if (tack?.skin) for (const [a, b] of [[Hp, K], [K, A]]) for (const u of [0.25, 0.5, 0.75, 1]) {
      const p = S.worldToLocal(a.clone().lerp(b, u));
      if (Math.abs(p.z) > 0.55 || p.y > 0.25) continue;      // only round the barrel
      const ang = Math.atan2(p.x, p.y - tack.axisY), r = Math.hypot(p.x, p.y - tack.axisY);
      inside = Math.max(inside, tack.skin(Math.round(p.z * 50) / 50, Math.round(ang * 20) / 20) - r);
    }
    out["inside" + L] = inside;
    out["hip" + L] = hipTwistDeg(rd, i);
    { const fr = g.frU.clone().applyQuaternion(g.u.getWorldQuaternion(new THREE.Quaternion())), pf = new V3(0, 0, 1).applyQuaternion(rd.B.pelvis.getWorldQuaternion(new THREE.Quaternion()));
      const fwdP = new V3(0, 0, 1).applyQuaternion(rd.r.rig.getWorldQuaternion(new THREE.Quaternion()));   // the body's forward
      const thighUp = K.clone().sub(Hp).normalize().y;   // > -0.2: the thigh is raised (near level or up) (leg raised): its front faces back by nature
      out["knee" + L] = thighUp > -0.2 ? 0 : Math.acos(Math.max(-1, Math.min(1, fr.normalize().dot(fwdP)))) * 57.3 - 90; }   // > 0: kneecap behind the body plane
    out["foot" + L] = footTwistDeg(g);
    out["pts" + L] = [A, K, wpos(rd.B.arms[i].tip)];
  });
  out.pel = wpos(rd.B.pelvis);
  // arms: a hand far BEHIND the shoulders (body frame) = an arm bent the wrong way
  { const q = rd.B.spine3.getWorldQuaternion(new THREE.Quaternion()), fwd = new V3(0, 0, 1).applyQuaternion(rd.r.rig.getWorldQuaternion(new THREE.Quaternion()));
    const ch = wpos(rd.B.spine3);
    out.handBack = Math.max(...rd.B.arms.map((a) => -wpos(a.tip).sub(ch).dot(fwd))) - 0.05; }
  // limbs through each other: each shin / thigh against each forearm and upper arm, and leg vs leg
  { const seg = (u, l, t) => [[wpos(u), wpos(l)], [wpos(l), wpos(t)]];
    const legs = rd.B.legs.map((g) => seg(g.u, g.l, g.tip)), arms = rd.B.arms.map((a) => seg(a.u, a.l, a.tip));
    let m = Infinity, what = "";
    legs.forEach((L, li) => arms.forEach((A, ai) => { for (const x of L) for (const y of A) { const d = segDist(x[0], x[1], y[0], y[1]); if (d < m) { m = d; what = `${li ? "R" : "L"} leg / ${ai ? "R" : "L"} arm`; } } }));
    { const d = segDist(legs[0][1][0], legs[0][1][1], legs[1][1][0], legs[1][1][1]); if (d < m) { m = d; what = "shin / shin"; } }
    out.cross = m; out.crossWhat = what;
    // arm through the TORSO: forearm / hand against the spine (pelvis → neck), minus the body's half-depth
    const sp0 = wpos(rd.B.pelvis), sp1 = wpos(rd.B.neck);
    out.armIn = Math.max(...arms.map((A) => 0.11 - segDist(A[1][0], A[1][1], sp0, sp1)));   // > 0: inside the chest
  }
  return out;
}

function analyse(frames) {
  const worst = {}, issues = [];
  const note = (k, v, f) => { if (v > (worst[k]?.v ?? -Infinity)) worst[k] = { v: +v.toFixed(3), f }; };
  for (let i = 0; i < frames.length; i++) {
    const F = frames[i];
    for (const L of ["L", "R"]) {
      if (F["onGround" + L]) {
        note("under", -F["sole" + L], F.f);
        note("float", F["sole" + L], F.f);
        note("flatDeg", Math.abs(F["pitch" + L]), F.f);
      }
      if (F["iron" + L] != null) note("ironGap", F["iron" + L], F.f);
      note("inside", F["inside" + L], F.f);
      note("hipDeg", Math.abs(F["hip" + L]), F.f);
      note("kneeBack", F["knee" + L], F.f);
      note("footDeg", Math.abs(F["foot" + L]), F.f);
      if (i > 0 && i < frames.length - 1) {
        const P = frames[i - 1]["pts" + L], N = frames[i + 1]["pts" + L];
        F["pts" + L].forEach((p, j) => note("pop", p.distanceTo(P[j].clone().add(N[j]).multiplyScalar(0.5)), F.f));
      }
    }
    if (i > 0 && i < frames.length - 1) note("pop", F.pel.distanceTo(frames[i - 1].pel.clone().add(frames[i + 1].pel).multiplyScalar(0.5)), F.f);
  }
  for (const F of frames) { note("handBack", F.handBack, F.f); note("limbCross", -F.cross, F.f); }
  for (const [k, w] of Object.entries(worst)) if (LIMITS[k] != null && w.v > LIMITS[k]) issues.push(`${k} ${w.v} at f${w.f}`);
  // per-frame list of the bad ones (for the editor)
  const bad = [];
  for (const F of frames) {
    if (F.handBack > LIMITS.handBack) bad.push(`f${F.f}: HAND BEHIND THE BACK ${(F.handBack * 100).toFixed(0)}cm`);
    if (F.armIn > 0.02) bad.push(`f${F.f}: ARM INSIDE THE TORSO ${(F.armIn * 100).toFixed(0)}cm`);
    if (F.cross < LIMITS.limbCross) bad.push(`f${F.f}: LIMBS THROUGH EACH OTHER (${F.crossWhat}, ${(F.cross * 100).toFixed(0)}cm apart)`);
  }
  for (const F of frames) for (const L of ["L", "R"]) {
    const why = [];
    if (F["onGround" + L] && -F["sole" + L] > LIMITS.under) why.push(`under ${(-F["sole" + L] * 100).toFixed(1)}cm`);
    if (F["onGround" + L] && Math.abs(F["pitch" + L]) > LIMITS.flatDeg) why.push(`not flat ${F["pitch" + L].toFixed(0)}°`);
    if (F["iron" + L] != null && F["iron" + L] > LIMITS.ironGap) why.push(`off iron ${(F["iron" + L] * 100).toFixed(0)}cm`);
    if (F["inside" + L] > LIMITS.inside) why.push(`inside horse ${(F["inside" + L] * 100).toFixed(0)}cm`);
    if (F["knee" + L] > LIMITS.kneeBack) why.push(`KNEE POINTS BACK ${F["knee" + L].toFixed(0)}°`);
    if (Math.abs(F["foot" + L]) > LIMITS.footDeg) why.push(`ankle twist ${F["foot" + L].toFixed(0)}°`);
    if (why.length) bad.push(`f${F.f} ${L}: ${why.join(", ")}`);
  }
  return { worst, issues, bad };
}

// A movement, played as the game plays it (the editor's clock, 1/60 s steps).
export function checkClip(H, clip) {
  const E = H.editor, rd = H.rider, ms = rd.mountSys;
  const wasOpen = E.isOpen, wasClip = E.clip, wasMode = ms.mode;
  E.open(clip);
  const dur = E.data.duration, frames = [];
  ms.groundW = null; ms.ironW = null; ms.ikIronW = null; ms.polePrev = null; ms.armPolePrev = null; ms.tgtPrev = null;
  for (let i = 0; i <= Math.round(dur * 60); i++) {
    ms.edit = { clip, t: i * DT, playing: i > 0 };
    rd.update(i ? DT : 0, { lookYaw: 0, input: {} });
    rd.r.rig.updateMatrixWorld(true);
    const gw = ms.groundW ?? [1, 1], legsNear = ms.side > 0 ? [0, 1] : [1, 0];
    const onGround = [0, 1].map((li) => gw[legsNear.indexOf(li)] > 0.9);
    frames.push(measureFrame(H, i, { onGround }));
  }
  if (wasOpen) E.open(wasClip); else E.close();
  if (wasMode === "riding" && !wasOpen) { ms.edit = null; ms.mode = "riding"; ms.blend = null; rd.seatY = null; rd.sitAction.reset().play(); ms.cur?.stop(); ms.cur = null; }   // back on the horse, as before the check
  return { clip, frames: frames.length, ...analyse(frames) };
}

// A riding posture: the horse plays its gait in place for `secs`.
export function checkRiding(H, pose, secs = 3) {
  const E = H.editor, rd = H.rider, ctrl = H.ctrl;
  const wasOpen = E.isOpen, wasClip = E.clip;
  E.open(`ride:${pose}`);
  const frames = [];
  for (let i = 0; i < secs * 60; i++) {
    ctrl.update(DT, E.horseInput()); E.afterHorse();
    rd.update(DT, { lookYaw: 0, input: {} });
    rd.r.rig.updateMatrixWorld(true);
    if (i >= 60) frames.push(measureFrame(H, i, { onGround: [false, false] }));   // after a second of settling
  }
  ctrl.v = 0; ctrl.gear = 0; ctrl.turnRate = 0;               // leave the horse standing
  if (wasOpen) E.open(wasClip); else E.close();
  return { pose, frames: frames.length, ...analyse(frames) };
}

// A contact sheet of a movement: shots = [[frame, [camera offset], [look-at offset]], …]
// (offsets from the horse, metres). Shows it over the page (click to close).
export async function frameSheet(H, clip, shots, { cols = 4, size = 380 } = {}) {
  const E = H.editor, c = H.ctrl, R0 = H.renderer;
  E.open(clip);
  const cam = H.camera.clone(), hp = c.pos;
  const rows = Math.ceil(shots.length / cols);
  const sheet = document.createElement("canvas"); sheet.width = size * cols; sheet.height = size * rows;
  const g = sheet.getContext("2d");
  const helpers = [...Object.values(E.handles), ...Object.values(E.paths), E.tc.getHelper()];
  for (let i = 0; i < shots.length; i++) {
    const [f, off, look] = shots[i];
    E.setT(f / 60);
    for (let r = 0; r < 3; r++) {
      await new Promise((rr) => requestAnimationFrame(rr));
      cam.clearViewOffset();
      cam.position.set(hp.x + off[0], c.y + off[1], hp.z + off[2]);
      cam.lookAt(hp.x + look[0], c.y + look[1], hp.z + look[2]);
      cam.aspect = R0.domElement.width / R0.domElement.height; cam.updateProjectionMatrix();
      for (const h of helpers) h.visible = false;
      R0.render(H.scene, cam);
    }
    const cv = R0.domElement, s = cv.height * 0.8;
    g.drawImage(cv, (cv.width - s) / 2, cv.height * 0.05, s, s, (i % cols) * size, Math.floor(i / cols) * size, size, size);
    g.fillStyle = "#000"; g.font = "20px sans-serif"; g.fillText(`f${f}`, (i % cols) * size + 8, Math.floor(i / cols) * size + 24);
  }
  E.tc.getHelper().visible = true;
  E.close();
  document.getElementById("sheet")?.remove();
  const img = document.createElement("img"); img.id = "sheet"; img.src = sheet.toDataURL();
  img.style.cssText = "position:fixed;left:0;top:0;z-index:50;max-width:100vw;max-height:100vh;background:#888";
  img.onclick = () => img.remove();
  document.body.appendChild(img);
}
