// THE JOLT RECORDER (user, 2026-10-30: "something really shifts the car sometimes" — the bots drive clean, so the
// player's own moments are caught; "can we have it in the track builder also? that's where I will see most of the
// problems"). Every drive keeps its last 6 s, a frame each. J reads the last 3 s: the frames where the car or the camera
// turned hardest, or the car was knocked up / sideways, each with what happened then (drift on/off, a rail, a wheel
// leaving or landing, a crash, the handbrake) and the piece it was on. On screen and copied, to paste to Claude.
import * as THREE from "three";

const REC_S = 6;
const qAng = (a, c) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(c)))) * 180 / Math.PI;
const _u = new THREE.Vector3(), _s = new THREE.Vector3();

/**
 * @param o.getVehicle () => the car
 * @param o.isDriving () => boolean
 * @param o.getCamera () => the drive camera
 */
export function createJoltRecorder({ getVehicle, isDriving, getCamera }) {
  const rec = [];
  const toast = document.createElement("div");
  toast.style.cssText = "position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:40;font:500 12px Consolas, monospace;color:#e6edf6;background:rgba(13,20,36,.92);border:1px solid #233149;padding:8px 10px;white-space:pre;display:none;max-width:90vw;pointer-events:none";
  document.body.append(toast);
  let toastT = 0, last = performance.now();

  function record(v, dt) {
    const b = v.body, cam = getCamera?.();
    _u.set(0, 1, 0).applyQuaternion(b.quat); _s.set(1, 0, 0).applyQuaternion(b.quat);
    rec.push({ t: performance.now() / 1000, dt, q: b.quat.clone(), cq: cam?.quaternion.clone(), vUp: b.vel.dot(_u), vSide: b.vel.dot(_s), kmh: b.vel.length() * 3.6,
      yaw: b.angVel.dot(_u) * 180 / Math.PI, slide: v.arcade?.slideDeg ?? 0, drift: !!v.arcade?.drifting, rail: !!v._solidTouch, wheels: v.groundedCount,
      crash: (v._crashT ?? 0) > 0, hb: !!v.input?.handbrake, steer: +(v.input?.steer ?? 0), pos: b.pos.clone(), piece: v.trackAt?.(b.pos)?.id ?? null });
    while (rec.length && rec[rec.length - 1].t - rec[0].t > REC_S) rec.shift();
  }

  function report() {
    const end = rec.at(-1)?.t ?? 0, F = rec.filter((r) => r.t > end - 3);
    const rows = [];
    for (let i = 1; i < F.length; i++) {
      const a = F[i - 1], c = F[i], dt = Math.max(0.004, c.dt);
      if (c.pos.distanceTo(a.pos) > (c.kmh / 3.6) * dt + 3) continue; // (a respawn or a jump to a zone: not a jolt)
      const car = qAng(a.q, c.q) / dt, camR = a.cq && c.cq ? qAng(a.cq, c.cq) / dt : 0;
      const kick = Math.max(Math.abs(c.vUp - a.vUp), Math.abs(c.vSide - a.vSide)) / dt / 9.81; // g in one frame
      const why = [c.drift !== a.drift ? (c.drift ? "DRIFT ON" : "drift off") : "", c.rail && !a.rail ? "RAIL" : "", c.wheels !== a.wheels ? `wheels ${a.wheels}→${c.wheels}` : "", c.crash && !a.crash ? "CRASH" : "", c.hb !== a.hb ? (c.hb ? "handbrake" : "handbrake off") : ""].filter(Boolean);
      rows.push({ ago: end - c.t, car, camR, kick, dYaw: c.yaw - a.yaw, why, c });
    }
    const score = (r) => r.car / 60 + r.camR / 60 + r.kick / 3 + Math.abs(r.dYaw) / 40;
    const top = rows.slice().sort((p, q) => score(q) - score(p)).slice(0, 4).sort((p, q) => q.ago - p.ago);
    const lines = [`JOLT REPORT (the last 3 s, the hardest moments) — ${new Date().toLocaleTimeString()}`];
    for (const r of top) {
      const near = rows.filter((x) => Math.abs(x.ago - r.ago) < 0.15).flatMap((x) => x.why);
      lines.push(`${r.ago.toFixed(2)} s ago · ${r.c.piece ?? "off the road"} · ${Math.round(r.c.kmh)} km/h · car turned ${r.car.toFixed(0)}°/s · camera ${r.camR.toFixed(0)}°/s · knock ${r.kick.toFixed(1)} g · yaw rate ${r.dYaw >= 0 ? "+" : ""}${r.dYaw.toFixed(0)}°/s · slide ${r.c.slide.toFixed(0)}° · wheels ${r.c.wheels} · steer ${r.c.steer.toFixed(2)}${near.length ? ` · ${[...new Set(near)].join(", ")}` : ""} · at ${r.c.pos.toArray().map((x) => Math.round(x)).join(",")}`);
    }
    const txt = lines.join("\n");
    console.log(txt);
    navigator.clipboard?.writeText(txt).catch(() => {});
    toast.textContent = txt + "\n(copied — paste it to Claude)";
    toast.style.display = ""; toastT = performance.now() + 9000;
    return txt;
  }

  addEventListener("keydown", (e) => {
    if (e.code !== "KeyJ" || e.repeat || e.ctrlKey || e.altKey || !isDriving()) return;
    report();
  });

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (toastT && now > toastT) { toast.style.display = "none"; toastT = 0; }
    const v = isDriving() ? getVehicle() : null;
    if (!v) { rec.length = 0; return; }
    record(v, dt);
  }
  requestAnimationFrame(frame); // (not now: the page creating it may not have set itself up yet)

  return { report };
}
