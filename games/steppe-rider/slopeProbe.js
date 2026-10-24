// ── Steppe rider: the SLOPE PROBE ────────────────────────────────────────────
// How the horse's legs do on the course's ramps, measured, not eyeballed. It rides
// the horse at a walk onto each ramp at a FIXED 1/60 s step (per rendered frame the
// numbers swung 2× between identical runs), from several points in the stride
// (where the stride is when the slope starts changed the result a lot), and pools:
//
//   hang     front hoof: its DRAWN sole above the ground while the clip has that
//            hoof planted (hA < 2 cm) — a front leg too short for the ground
//   knee     front knee bend (°) while its drawn sole is on the ground (< 1.5 cm)
//   reach    hind hoof vs hip (°, + = ahead), hock (°), stifle (°), stretch (hip→hoof
//            over the chain's length: 1 = a straight leg)
//   sink     deepest drawn sole into the ground (cm)
//   refused  share of the frames the slope gate held the horse back (it did not ride the ramp)
//
// Used by tools/horseSlopeCheck.mjs; from the console:
//   (await import('/games/steppe-rider/slopeProbe.js')).runSlopeProbe({ cases: ['down10'] })
import { SPOTS } from "./spots.js";

export const SLOPE_CASES = ["flat", "down5", "down10", "down15", "up10", "up15"];   // (the walk takes up to 15°: HP.slopeLimits)

export async function runSlopeProbe({ cases = SLOPE_CASES, phases = [0, 17, 34, 51], frames = 100, hp = {} } = {}) {
  const S = window.__STEPPE, K = S.kit, C = K.ctrl, HP = K.HP, V = S.app.camera.position.constructor;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const P = (o) => o.getWorldPosition(new V()), gY = (x, z) => S.app.getWorldHeight(x, z);
  const keep = { ...HP }, mode = K.RIDE.mode, upd = K.update;
  Object.assign(HP, hp);
  K.RIDE.mode = "classic";
  K.update = () => upd(1 / 60);
  const key = (type) => dispatchEvent(new KeyboardEvent(type, { code: "KeyW", key: "w" }));
  const ramp = (d) => SPOTS.pieces.find((q) => q.label === `Ramp ${d}°`);
  const spotOf = (c) => {
    if (c === "flat") return [SPOTS.spawn, () => true];
    const up = c.startsWith("up"), d = +c.slice(up ? 2 : 4), r = ramp(d), run = 6 / Math.tan(d * Math.PI / 180);
    return up ? [r, () => C.pitch * 57.3 < -d * 0.85] : [{ x: r.x, z: r.z - (25 + run + 3), yaw: r.yaw }, () => C.pitch * 57.3 > d * 0.85];
  };
  const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * f))].toFixed(1) : null; };
  const out = {};
  try {
    for (const c of cases) {
      const A = { hang: [], knee: [], reach: [], hock: [], stifle: [], stretch: [], sink: 0, refused: 0, n: 0 };
      for (const warm of phases) {
        const [spot, onSlope] = spotOf(c);
        K.placeAt(spot); for (let i = 0; i < 30; i++) await raf();
        C.gear = 0; key("keydown");
        for (let i = 0; i < warm; i++) await raf();   // (a different point in the stride when the slope starts)
        for (let n = 0; n < 4000; n++) { await raf(); if (n > 120 && onSlope()) break; }
        for (let i = 0; i < frames; i++) {
          await raf(); A.n++; if (C.blocked) A.refused++;
          const fw = new V(Math.sin(C.yaw), 0, Math.cos(C.yaw)), sag = (v) => Math.atan2(v.dot(fw), -v.y) * 57.3;
          for (const g of C.legs) {
            const m = g.ff.matrixWorld;
            const sole = Math.min(...C.solePoints(g).map((p) => { const w = p.clone().applyMatrix4(m); return w.y - gY(w.x, w.z); }));
            A.sink = Math.max(A.sink, -sole);
            if (!g.cannon) {
              if ((g.hA ?? 1) < 0.02) A.hang.push(sole * 100);
              if (sole < 0.015) { const sh = P(g.u), kp = P(g.l), fe = P(g.ik); A.knee.push(Math.abs(sag(fe.clone().sub(kp)) - sag(kp.clone().sub(sh)))); }
            } else {
              const hip = P(g.u), st = P(g.l), hk = P(g.cannon), fe = P(g.ik), hf = P(g.ff), v = hf.clone().sub(hip);
              A.reach.push(Math.atan2(v.dot(fw), -v.y) * 57.3);
              A.hock.push(st.clone().sub(hk).angleTo(fe.clone().sub(hk)) * 57.3);
              A.stifle.push(hip.clone().sub(st).angleTo(hk.clone().sub(st)) * 57.3);
              A.stretch.push(v.length() / (hip.distanceTo(st) + st.distanceTo(hk) + hk.distanceTo(fe) + fe.distanceTo(hf)));
            }
          }
        }
        key("keyup"); for (let i = 0; i < 20; i++) await raf();
      }
      out[c] = {
        hang: { p50: q(A.hang, 0.5), p95: q(A.hang, 0.95), max: q(A.hang, 1) },
        knee: { p50: q(A.knee, 0.5), p95: q(A.knee, 0.95), max: q(A.knee, 1), n: A.knee.length },
        hind: { reach: q(A.reach, 0.5), reachMin: q(A.reach, 0), reachMax: q(A.reach, 1), hock: q(A.hock, 0.5), hockMax: q(A.hock, 1), stifleMax: q(A.stifle, 1), stretchMax: +(Math.max(...A.stretch)).toFixed(2) },
        sink: +(A.sink * 100).toFixed(1),
        refused: +(A.refused / A.n).toFixed(2),   // (share of frames the slope gate held the horse back: then it measured the wrong ground)
      };
    }
  } finally {
    key("keyup"); C.gear = 0;
    for (const k of Object.keys(hp)) HP[k] = keep[k];
    K.update = upd; K.RIDE.mode = mode;
  }
  return out;
}
