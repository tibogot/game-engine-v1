// ── Horse lab: on foot, mounting and dismounting ─────────────────────────────
// The rider has three lives besides riding:
//
//   ground     the robot on its own feet, driven by its UAL clips (idle / walk /
//              jog), tank controls like the horse; F near the horse mounts
//   approach   F pressed on foot: walks itself to the mounting spot at the
//              horse's shoulder (left side, or right if the left is blocked)
//              and turns to face it
//   mount /    a keyed performance around the SADDLE (so it fits the horse
//   dismount   wherever it stands): the pelvis, the facing, the lean, both feet
//              and both hands each follow their own smooth path, phases
//              overlapping like a real rider —
//                0.0–0.5  left hand to the withers (reins + mane), right hand
//                         to the cantle, left foot up into the stirrup
//                0.8–1.3  spring up on the stirrup leg, lying over the saddle
//                1.3–2.1  right leg swings high over the croup, hips turn
//                         forward
//                2.0–2.6  sit softly, right foot finds its stirrup, hands to
//                         the reins
//              Dismounting plays the same performance backwards (step down via
//              the stirrup), on whichever side is clear.
//
// Limbs reach their targets with the same two-bone IK as riding; the hand-overs
// (ground → mount → riding and back) blend the whole pose over a few tenths of
// a second, so nothing snaps.
import * as THREE from "three";
import { rotateWorld, solveTwoBone } from "./horse.js";
import { solveLeg, naturalFootDir, aimFoot, ridingFootDir, naturalKneeDir, RP, POSES } from "./rider.js";
import { stirrupGeom, BALL_TO_TREAD } from "./stirrups.js";

const V3 = THREE.Vector3;
const clamp = THREE.MathUtils.clamp;
const lerpK = (rate, dt) => 1 - Math.exp(-rate * dt);
const wpos = (o) => o.getWorldPosition(new V3());
const smooth = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };

export const MP = {
  duration: 2.6,          // s, the whole mount (dismount plays it backwards)
  walkSpeed: 1.35,        // m/s on foot
  jogSpeed: 3.2,
  turnRate: 2.6,          // rad/s on foot
  reach: 3.2,             // m: how close to the horse F mounts
  stand: 0.66,            // m (× k) out from the saddle centre: an arm's length from the horse — room for the left knee to come up
  standZ: -0.02,          // m (× k) forward of the saddle centre: beside the saddle, just behind the stirrup (reference)
  faceYaw: -0.95,         // rad in the saddle frame: turned toward the horse's head, beside its shoulder (back-view ref B1), turning to its side as the foot goes in
  letDown: false,
  pull: 0.07,             // m the foot draws the near iron out from the horse's side         // false = the stirrup stays at riding length; the foot must reach it
  mountDrop: 0.18,        // m below the hip the let-down stirrup is taken (natural up to ~10–20 cm below;
                          // at riding length it hung 23–31 cm ABOVE the hip and the hip spun 160°+)
  kneeUp: 1.0,
  kneeSide: 0.35,          // how far the stirrup leg's knee opens to the side as it rises (0 = straight up)
  stepLean: 0.2,          // rad the body leans into the horse while the foot goes into the iron
  crouch: 0,           // m the hips dip while the foot goes up (more dip = the stirrup is relatively higher)           // how much the stirrup leg's knee points UP (toward the chest) while the foot is raised
};

// A path of keys [t, value] evaluated with a smooth (Catmull-Rom) curve; values
// are numbers or [x, y, z] in the saddle frame.
function track(keys) {
  const vec = Array.isArray(keys[0][1]);
  const f = (t) => {
    if (t <= keys[0][0]) return vec ? new V3(...keys[0][1]) : keys[0][1];
    const n = keys.length;
    if (t >= keys[n - 1][0]) return vec ? new V3(...keys[n - 1][1]) : keys[n - 1][1];
    let i = 0;
    while (keys[i + 1][0] < t) i++;
    const [t1, a1] = keys[i], [t2, a2] = keys[i + 1];
    const a0 = keys[Math.max(0, i - 1)][1], a3 = keys[Math.min(n - 1, i + 2)][1];
    const u = (t - t1) / (t2 - t1);
    // monotone cubic (no overshoot): a key between two keys that do not both
    // rise (or both fall) gets a flat tangent — Catmull-Rom overshot here and
    // dipped a landing foot under the ground (the dismount bounce)
    const h0 = t1 - keys[Math.max(0, i - 1)][0] || 1, h1 = t2 - t1, h2 = keys[Math.min(n - 1, i + 2)][0] - t2 || 1;
    const tan = (pa, pb, pc, ha, hb) => { const d1 = (pb - pa) / ha, d2 = (pc - pb) / hb; return d1 * d2 <= 0 ? 0 : (d1 + d2) / 2; };
    const cr = (p0, p1, p2, p3) => {
      const m1 = tan(p0, p1, p2, h0, h1) * h1, m2 = tan(p1, p2, p3, h1, h2) * h1;
      const u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2;
    };
    if (!vec) return cr(a0, a1, a2, a3);
    return new V3(cr(a0[0], a1[0], a2[0], a3[0]), cr(a0[1], a1[1], a2[1], a3[1]), cr(a0[2], a1[2], a2[2], a3[2]));
  };
  f.keys = keys; f.type = vec ? "vec" : "num";
  return f;
}
// on/off channel: the value of the last key at or before t
function stepTrack(keys) {
  const f = (t) => { let v = keys[0][1]; for (const [kt, kv] of keys) if (kt <= t + 1e-6) v = kv; return v; };
  f.keys = keys; f.type = "step";
  return f;
}

// ── performances as DATA (the animation editor edits these) ─────────────────
// Every channel is a list of keys [t, value] in the saddle frame, for the
// LEFT side (the right side mirrors x and the yaw). vec = a point the IK
// reaches for; num = an amount; step = on / off.
export const CHANNELS = [
  { name: "pelvis", type: "vec", label: "pelvis", color: 0xffd23f },
  { name: "nearFoot", type: "vec", label: "near foot (stirrup leg)", color: 0x3fa9ff },
  { name: "farFoot", type: "vec", label: "far foot (swinging leg)", color: 0xff5ad1 },
  { name: "nearHand", type: "vec", label: "near hand", color: 0x59e08a },
  { name: "farHand", type: "vec", label: "far hand", color: 0xff8a3f },
  { name: "yaw", type: "num", label: "facing (rad)", min: -3.2, max: 3.2 },
  { name: "lean", type: "num", label: "lean forward (rad)", min: -0.6, max: 1.4 },
  { name: "elbowsOut", type: "num", label: "elbows out from the body", min: 0, max: 2.5 },
  { name: "nearGrip", type: "num", label: "near hand closed", min: 0, max: 1 },
  { name: "farGrip", type: "num", label: "far hand closed", min: 0, max: 1 },
  { name: "nearElbowBack", type: "num", label: "near elbow back", min: 0, max: 2.5 },
  { name: "nearFootTurn", type: "num", label: "near foot: into the horse → turned", min: 0, max: 1, def: 1 },
  { name: "farKneeUp", type: "num", label: "far knee UP", min: 0, max: 1 },
  { name: "tilt", type: "num", label: "tilt to his left (rad)", min: -0.8, max: 0.8 },
  { name: "handW", type: "num", label: "hands on targets", min: 0, max: 1 },
  { name: "nearTwist", type: "num", label: "near knee turn (+ out)", min: -1.6, max: 1.6 },
  { name: "farTwist", type: "num", label: "far knee turn (+ out)", min: -1.6, max: 1.6 },
  { name: "astride", type: "num", label: "astride (riding knees + feet)", min: 0, max: 1 },
  { name: "look", type: "num", label: "look down", min: 0, max: 1 },
  { name: "nearIn", type: "step", label: "near foot in iron" },
  { name: "farIn", type: "step", label: "far foot in iron" },
];
export function perfToData(M) {
  const channels = {};
  for (const c of CHANNELS) {
    const keys = M[c.name].keys.map(([t, v]) => [+t.toFixed(4), Array.isArray(v) ? v.map((x) => +x.toFixed(4)) : +(+v).toFixed(4)]);
    channels[c.name] = { type: c.type, keys: keys.filter((kk, i) => i === 0 || kk[0] > keys[i - 1][0] + 1e-4) };
  }
  return { version: 1, duration: M.duration, channels };
}
export function compilePerf(data) {
  const M = { duration: data.duration, data };
  for (const c of CHANNELS) {
    const ch = data.channels[c.name] ?? (data.channels[c.name] = { type: c.type, keys: [[0, c.def ?? 0]] });   // a channel added since the file was saved
    const keys = ch.keys.slice().sort((a, b) => a[0] - b[0]);
    M[c.name] = c.type === "step" ? stepTrack(keys) : track(keys);
  }
  return M;
}

// The performance, for the LEFT side (s = +1), in the saddle frame: x = the
// horse's left, y = up (0 = saddle surface), z = forward. `G` = the ground's
// height in that frame, `ph` = the robot's standing pelvis height, `st` = the
// stirrup point (same as riding), `seat` = the riding pelvis height.
function buildMount({ G, ph, st, seat, k, au, pull, farHang }) {
  // the riding idle hands (rider.js), so the get-on ends exactly on them
  const I = POSES.idle, rideHand = (sd) => [sd * I.handApart, I.handUp + RP.handUp, I.handFwd + RP.handFwd];
  const GA = G + au;                                           // ankle height when the foot is on the ground
  const D = MP.stand;                                         // how far out from the horse the rider stands (× k)
  // The reference game's get-on (same robot): BESIDE the saddle, just behind
  // the stirrup, facing the horse's side (a touch toward its head); left hand
  // on the withers, right hand on the front of the saddle; the left knee comes
  // UP toward the horse's shoulder with the shin hanging straight down into
  // the iron, the right leg straight under him; then he lies belly-down
  // ACROSS the saddle, the right leg bent and kicked up over the croup, and
  // only then turns to sit.
  const Z = MP.standZ;
  const bend = 0.06;                                          // knees soft, hips back: a natural stance, not bolt upright
  const stand = [D * k, G + ph - bend, Z * k];
  return {
    pelvis: track([
      [0.0, stand],
      // weight onto the RIGHT foot (his right = toward the tail) so the left knee comes up freely
      [0.3, [D * k, G + ph - bend - 0.01, (Z - 0.05) * k]],
      [0.5, [(D - 0.03) * k, G + ph - bend - 0.02, (Z - 0.07) * k]],   // weight on the right leg, a little toward the horse
      [0.72, [(D - 0.04) * k, G + ph - 0.04, (Z - 0.03) * k]],         // then over the stirrup foot
      [1.12, [0.42 * k, st.y + 0.62, 0.02 * k]],                // spring up: standing in the stirrup, hips at saddle height
      // lying FORWARD along the horse (the reference): chest on the withers, head by
      // the neck, hips over the near side of the saddle, left foot in its iron
      [1.3, [0.3 * k, 0.18, -0.05 * k]],                         // ref 4: hips HIGH over the near side, standing in the stirrup
      [1.6, [0.18 * k, 0.14, -0.1 * k]],
      [1.8, [0.1 * k, 0.13, -0.04 * k]],                        // the leg goes over (hips low: the near foot stays in its iron; lower flipped the knee)
      [2.15, [0.0, seat + 0.01, 0.0]],
      [2.6, [0.0, seat, 0.0]],                                  // seated
    ]),
    // facing the horse's side all the way up and while lying across; turns only to sit
    yaw: track([[0, MP.faceYaw], [0.25, MP.faceYaw], [0.55, -1.3], [0.8, -1.5], [1.12, -1.35], [1.3, -0.8], [1.6, -0.5], [1.85, -0.3], [2.2, -0.05], [2.6, 0]]),   // turns to face FORWARD as he goes over (lying along the neck)
    // upright while the knee comes up, then folded over the saddle (torso near flat), then up to sit
    lean: track([[0, 0.14], [0.3, 0.16], [0.5, 0.16], [0.75, 0.14],   // a natural forward bend toward the horse from the start
      [0.95, 0.4],   // ref 1–2: upright while the knee comes up
      [1.3, 0.75], [1.55, 0.95], [1.85, 0.8], [2.2, 0.5], [2.6, 0.05]]),   // ref 4: ~45° over the withers; ref 5–6: folded low over the neck; ref 7–8: sits down still leaning
    // the stirrup foot (rider's left on the left side)
    nearFoot: track([
      [0.0, [D * k, GA, (Z + 0.1) * k]],                         // his left: toward the horse's head
      [0.24, [D * k, GA, (Z + 0.1) * k]],
      // to where the near iron HANGS (barely pulled out): the foot goes to the stirrup
      [0.52, pull(MP.pull + 0.03)],                            // a slower lift (0.22 s was 12–17 cm per frame)
      [0.62, pull(MP.pull)],
      [0.72, pull(MP.pull)],
      [1.12, [st.x, st.y, st.z]],                               // in the iron (fixed strap) as he rises
      [2.6, [st.x, st.y, st.z]],
    ]),
    // the swinging leg (rider's right on the left side)
    farFoot: track([
      [0.0, [D * k, GA, (Z - 0.1) * k]],
      [0.8, [(D - 0.02) * k, GA, (Z - 0.1) * k]],               // pushes off the ground
      // (the reference) after the push it HANGS down behind the left leg, then
      // swings up BACK over the croup — thigh reaching back, knee bent ~90°, shin
      // hanging down — and over to the far side
      [1.05, [0.6 * k, GA + 0.3, -0.3 * k]],                   // pushed off: trailing BACK and to his right, heel up, knee bending (it hung beside the left foot)
      [1.24, [0.52 * k, -0.3, -0.48 * k]],                     // the KNEE comes up first (foot tucked up under him, out by the horse's side)…
      [1.34, [0.42 * k, -0.22, -0.56 * k]],                     // …then the leg reaches back toward the croup
      [1.4, [0.34 * k, 0.0, -0.84 * k]],                       // rises with the leg LONG (bent, the knee hung into the haunch)
      [1.5, [0.12 * k, 0.3, -0.86 * k]],                       // ref 5: stretched back over the croup, only slightly bent (a close foot folded the knee hard)
      [1.68, [-0.12 * k, 0.28, -0.8 * k]],
      [1.82, [-0.32 * k, 0.05, -0.5 * k]],
      [1.95, [-0.32 * k, -0.3, -0.2 * k]],                      // down the far side
      [2.15, farHang],                                          // finds the far iron WHERE IT HANGS
      [2.3, farHang],
      [2.6, [-st.x, st.y, st.z]],                               // and rises with it into the riding position
    ]),
    // hands: near (left) on the withers; far (right) on the front of the saddle,
    // then over to the FAR side of the seat while lying across, then the rein
    nearHand: track([[0.0, [(D - 0.05) * k, -0.25, (Z + 0.12) * k]], [0.3, [0.15, 0.12, 0.48 * k]], [0.8, [0.15, 0.12, 0.48 * k]], [1.1, [0.1 * k, 0.18, 0.3 * k]],   /* ref 1: left hand on the SIDE of the withers, chest high (on top it hunched him) */ [1.35, [0.1 * k, 0.2, 0.4 * k]], [1.85, [0.1 * k, 0.2, 0.4 * k]], [2.6, rideHand(1)]]),
    farHand: track([[0.0, [(D - 0.05) * k, -0.25, (Z - 0.12) * k]], [0.38, [0.12, 0.13, -0.18 * k]], [0.8, [0.12, 0.13, -0.18 * k]],   /* ref 2: right hand UP on the seat, forearm rising to it */ [1.1, [0.05 * k, 0.15, -0.25 * k]],   /* ref 1: right hand on the side of the cantle */ [1.35, [-0.06 * k, 0.2, 0.38 * k]], [1.85, [-0.06 * k, 0.2, 0.38 * k]], [2.6, rideHand(-1)]]),   // both hands on the neck while lying forward (the reference)
    handW: track([[0.0, 0], [0.3, 1], [2.6, 1]]),             // from hanging arms to IK
    // phase weights (knee directions, stirrups, gaze)
    astride: track([[2.0, 0], [2.4, 1]]),
    raised: track([[0.2, 0], [0.45, 1], [0.9, 1], [1.15, 0]]),
    swing: track([[1.05, 0], [1.35, 1], [1.95, 1], [2.25, 0]]),
    look: track([[0, 0.3], [0.9, 0.3], [1.6, 0]]),
    // ref 1–2: the left knee rolls OUT toward the horse's shoulder as it rises; the right knee a little out while it trails on the near side
    nearTwist: track([[0.2, 0], [0.5, 0.15], [0.8, 0.15], [1.1, 0.05], [1.3, 0]])   /* (rolling the knee toward the horse crossed the shins) */, farTwist: track([[0, 0]]),
    tilt: track([[0, 0]]), elbowsOut: track([[0, 0.6]]), nearElbowBack: track([[0, 0]]), farKneeUp: track([[0.78, 0], [0.98, 1], [1.33, 1], [1.45, 0]])   /* the right knee out to the EXTERIOR from the push-off (pointing in, it had to turn all the way round) */, nearFootTurn: track([[0, 0.3], [1.0, 0.3], [1.45, 1]]),   /* ref 1–2: foot (and iron) straight into the horse; they turn as he springs and swings over */
    nearGrip: track([[0, 1], [0.2, 0.15], [0.9, 0.15], [1.2, 1]]),   /* ref 1: left hand OPEN flat on the withers, forearm rising to it */ farGrip: track([[0, 1]]),
    nearIn: stepTrack([[0, 0], [0.56, 1]]), farIn: stepTrack([[0, 0], [2.17, 1]]),
    duration: 2.6,
    stand,
  };
}

// The DISMOUNT, as the reference game does it (same robot):
//   1–2  seated, the far (right) foot leaves its iron, the right knee comes UP
//        high in front and the leg swings forward OVER THE HORSE'S NECK,
//        leaning back a little; the near foot stays in its iron
//   3–5  the leg comes down the near side: he SITS SIDEWAYS on the near side of
//        the saddle, both legs hanging that side, near hand on the back of the
//        saddle, far hand on the front
//   6    slides down and lands on both feet, BACK to the horse, knees soft
//   7–8  stands (and walks off — the on-foot controls)
// Facing: yaw 0 = the horse's forward; +π/2 = out of the near side (back to the horse).
function buildDismount({ G, ph, st, seat, k, au }) {
  const GA = G + au, D = MP.stand;
  const OUT = 1.5;                                           // facing out of the near side
  const sideSeat = [0.16 * k, seat - 0.02, 0.0];             // sitting sideways on the near edge of the seat
  const landX = 0.4 * k;                                     // ref 6: standing right against the horse's side, back to it
  return {
    pelvis: track([
      [0.0, [0.0, seat, 0.0]],
      [0.35, [0.0, seat + 0.01, -0.02]],
      [0.8, [0.1 * k, seat + 0.02, -0.03 * k]],              // ref 2–4: right leg over the neck, body leaning to his LEFT (the near side)
      [1.15, sideSeat],                                      // ref 5: sitting sideways
      [1.4, [sideSeat[0] + 0.05 * k, sideSeat[1] - 0.02, 0.0]],   // edging off the seat
      [1.75, [landX, G + ph - 0.17, 0.02 * k]],              // landed: the knees take the drop
      [2.05, [landX + 0.03 * k, G + ph - 0.07, 0.02 * k]],
      [2.4, [landX + 0.04 * k, G + ph, 0.02 * k]],           // stands: exactly the idle pose (the walk starts from it)
    ]),
    yaw: track([[0, 0], [0.35, 0.15], [0.7, 0.42], [0.9, 0.6], [1.15, 1.15], [1.45, OUT], [2.4, OUT]]),   // ref 4: facing mostly forward as the leg goes over; ref 5: still turned toward the horse's head (right shoulder forward); out as he slides
    lean: track([[0, 0.03], [0.35, -0.12], [0.6, -0.28], [0.85, -0.3], [1.15, -0.25],   /* ref 4: leaning BACK so the right leg can come up; ref 5: whole upper body still back, both shoulders */ [1.4, -0.12], [1.75, 0.18], [2.1, 0.08], [2.4, 0.0]]),
    // the near (left) foot: in its iron until he sits sideways, then out and down to the ground
    nearFoot: track([
      [0.0, [st.x, st.y, st.z]],
      [0.3, [st.x, st.y, st.z]],
      [0.5, [st.x + 0.04 * k, st.y - 0.02, st.z + 0.12 * k]],   // out of the iron: forward and a touch out, hanging beside it
      [1.05, [st.x + 0.06 * k, st.y - 0.06, st.z + 0.16 * k]],  // ref 4: the left leg hangs straight down
      [1.2, [0.3 * k, -0.72, -0.08 * k]],                    // ref 5: left leg hanging straight down
      [1.72, [landX + 0.02 * k, GA, -0.17 * k]],             // lands, feet apart (his left = toward the tail)
      [2.1, [landX + 0.04 * k, GA, -0.16 * k]],
      [2.4, [landX + 0.04 * k, GA, -0.1 * k]],              // a small step in to the idle stance
    ]),
    // the far (right) leg: up in front, over the neck, down the near side
    farFoot: track([
      [0.0, [-st.x, st.y, st.z]],
      [0.2, [-st.x + 0.04 * k, st.y + 0.05, st.z + 0.04]],   // out of its iron
      [0.45, [-0.2 * k, 0.25, 0.55 * k]],                    // back-view ref 2: knee HIGH in front of the right shoulder, shin FORWARD over the neck (measured knee y 0.51)
      [0.65, [-0.15 * k, 0.3, 0.62 * k]],
      [0.8, [0.0, 0.38, 0.62 * k]],                           // ref 4: leg more level, foot further forward on top of the neck                      // ref 4: thigh forward-up, foot out over the neck
      [1.0, [0.32 * k, 0.1, 0.45 * k]],                      // down the near side
      [1.15, [0.48 * k, -0.15, 0.42 * k]],                   // ref 5 (measured: knee 88°, thigh level, shin vertical): knee ~90°: thigh level and high, shin straight down                   // ref 5: right thigh forward toward the horse's head, shin hanging
      [1.4, [0.4 * k, -0.55, 0.32 * k]],
      [1.7, [landX + 0.06 * k, GA, 0.17 * k]],               // lands a beat before the left, a touch forward
      [2.4, [landX + 0.04 * k, GA, 0.1 * k]],
    ]),
    // hands: from the reins; while sideways near on the back of the saddle, far on the front
    // near (left) hand: rein → front of the saddle while the leg goes over → beside his hip when
    // sideways → pushes off and lets go BEFORE he lands (held behind him it bent the elbow backwards)
    // left hand: rein → front of the saddle → in front of him, elbow down (ref 4) → on the BACK of the seat, elbow out (ref 5) → pushes off, lets go
    nearHand: track([[0.0, [0.125, 0.25, 0.25]], [0.45, [0.06 * k, 0.2, 0.3 * k]], [0.8, [0.5, 0.36, -0.06]],
      [1.1, [0.25, 0.18, -0.34]],   /* ref 5: left hand by the hip on the cantle, elbow out */ [1.38, [0.27 * k, 0.15, -0.3]], [1.55, [landX + 0.04, G + 0.95, -0.34]], [1.8, [landX + 0.1, G + 0.8, -0.34]], [2.1, [landX + 0.06, G + 0.82, -0.3]]]),   /* sliding: elbow bent, then off the seat; landed: arm loose */
    // far (right) hand: lifts UP out of the leg's way as it swings over the neck (ref 3), then onto
    // the front of the seat beside his hip, pushes off, lets go
    // (keys worked out from his facing at each time: 'up beside the head' at shoulder height in the
    // middle of the body folded the arm across his chest)
    // right hand: rein → out to his right (ref B2) → down by his right hip (ref 4) → on the FRONT of the seat, elbow out (ref 5) → pushes off, lets go
    farHand: track([[0.0, [-0.125, 0.25, 0.25]], [0.3, [-0.5 * k, 0.45, 0.15 * k]], [0.55, [-0.45 * k, 0.45, 0.3 * k]], [0.8, [-0.09, 0.27, 0.09]],
      [1.1, [0.25, 0.2, 0.34]],    /* ref 5: right hand on the pommel, waist high, elbow out */ [1.38, [0.27 * k, 0.15, 0.3]], [1.55, [landX + 0.04, G + 0.95, 0.34]], [1.8, [landX + 0.1, G + 0.8, 0.34]], [2.1, [landX + 0.06, G + 0.82, 0.3]]]),
    handW: track([[0.0, 1], [2.05, 1], [2.4, 0]]),         // loose arms on landing, then handed back to the standing clip: the last frame IS the idle pose the walk starts from
    astride: track([[0, 1], [0.3, 1], [0.75, 0]]),
    raised: track([[0, 0]]), swing: track([[0, 0]]),
    look: track([[0, 0], [1.1, 0], [1.4, 0.3], [1.7, 0]]),   /* glances down at the ground, then ahead (ref 6) */
    // back-view ref 2: the right knee lifts up and OUT to his right (it pointed across his chest)
    nearTwist: track([[0, 0]]), farTwist: track([[0, 0], [0.3, 0.3], [0.85, 0.3], [1.1, 0]]),
    // ref 4: the left elbow BACK and out, low by the back of the saddle — an open triangle between arm and torso
    nearElbowBack: track([[0.5, 0], [0.8, 1.6], [1.0, 1.4], [1.15, 0]]),
    tilt: track([[0, 0], [0.3, 0.15], [0.55, 0.4], [0.8, 0.15], [1.15, 0.05], [1.5, 0]])   /* ref 4: upright again */,
    elbowsOut: track([[0, 1.6], [0.3, 1.9], [0.55, 1.9], [0.8, 1.1], [1.0, 1.0], [1.15, 3.2], [1.4, 2.2], [1.7, 0.9], [2.4, 0.9]]),   /* sliding: elbows out and bent; landed: a little out, soft */   // ref 4: left elbow out while leaning back; ref 5: elbows out WIDE, hands on the seat
    // fingers: the reins, then the right hand OPEN in the air (back-view ref 2), both on the saddle while sideways, open as he lets go
    nearGrip: track([[0, 1], [0.6, 1], [0.75, 0.3], [0.95, 0.3], [1.1, 0.45], [1.4, 0.45], [1.6, 0.25]]), farGrip: track([[0, 1], [0.25, 0.2], [0.6, 0.2], [0.95, 0.2], [1.1, 0.45], [1.4, 0.45], [1.6, 0.25]])   /* resting on the seat: fingers half closed (a full fist pushed the thumb through the hand) */,   // back-view refs: elbows wide, away from the torso   // back-view ref 2: tilted well to his left
    farKneeUp: track([[0, 0]]),
    nearFootTurn: track([[0, 1]]),
    nearIn: stepTrack([[0, 1], [0.35, 0]])   /* back-view ref 2: the left foot is already out of its iron */, farIn: stepTrack([[0, 0]])   /* the right foot leaves its iron as the get-off starts */,
    duration: 2.4,
    stand: [landX + 0.04 * k, G + ph, 0.02 * k],
  };
}

export class MountSystem {
  constructor(rider) {
    this.rd = rider;
    this.MP = MP;                // the settings THIS page uses (a test importing the module again gets a separate copy)
    const r = rider.r, hc = rider.hc;
    this.mode = "riding";
    this.t = 0;
    this.side = 1;
    // On-foot clips and their measured ground speed.
    const mixer = rider.mixer;
    this.acts = {};
    for (const [key, name] of [["idle", "Idle_Loop_Armature"], ["walk", "Walk_Loop_Armature"], ["jog", "Jog_Fwd_Loop_Armature"]]) {
      const c = r.clips[name];
      if (c) this.acts[key] = mixer.clipAction(c);
    }
    this.measure();
    this.gpos = new V3(); this.gyaw = 0; this.gv = 0;
    this.blend = null;           // { snap, t, dur } pose to blend away from
    this.cur = null;             // current on-foot action
    this.hc = hc;
    this.anims = {};             // clip → keyed data (anims/<clip>.json, or the editor's)
    this.compiled = {};
    this.animVer = 0;
    this.edit = null;            // { clip, t, playing } while the animation editor drives it
  }

  // Saved performances: v3/horse-lab/anims/<clip>.json (written by the editor).
  async loadAnims() {
    for (const clip of ["mount", "dismount"]) {
      try {
        const r = await fetch(`/v3/horse-lab/anims/${clip}.json?${Date.now()}`);
        if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) { this.anims[clip] = await r.json(); (this.savedFrom ??= {})[clip] = true; }
      } catch { /* none saved: the code-built one plays */ }
    }
  }
  // where (saddle frame, left side) and which way the get-on starts
  startPose() {
    const d = this.anims.mount, k = this.rd.k;
    if (d) { const p = d.channels.pelvis.keys[0][1]; return { x: p[0], z: p[2], yaw: d.channels.yaw.keys[0][1] }; }
    return { x: MP.stand * k, z: MP.standZ * k, yaw: MP.faceYaw };
  }
  // the keyed data of a clip, made from the code-built performance the first time
  dataFor(clip) {
    if (!this.anims[clip]) {
      if (!this.codePerf) return null;
      this.anims[clip] = perfToData(this.codePerf[clip]);
    }
    return this.anims[clip];
  }

  // Standing pelvis height and walk / jog speeds, from the clips (like the
  // horse's gaits): a planted foot slides back at exactly the ground speed.
  measure() {
    const r = this.rd.r, rig = r.rig;
    const saveP = rig.position.clone(), saveQ = rig.quaternion.clone();
    rig.position.set(0, 0, 0); rig.quaternion.identity();
    const m = new THREE.AnimationMixer(r.model);
    const sole = () => { let lo = 1e9; for (const f of ["ball_l", "ball_r", "foot_l", "foot_r"]) lo = Math.min(lo, wpos(r.bone(f)).y); return lo; };
    const idle = m.clipAction(this.acts.idle.getClip()); idle.play(); m.setTime(0); rig.updateMatrixWorld(true);
    this.ankleUp = wpos(r.bone("foot_l")).y - sole() + 0.035;   // ankle above the sole (+ ball height)
    this.pelvisH = wpos(r.bone("pelvis")).y - sole() + 0.035;
    // a flat foot's ankle→ball line points DOWN (the ankle is above the ball):
    // levelling that line tipped the toes up like a foot in an iron
    { const a = wpos(r.bone("foot_l")), b = wpos(r.bone("ball_l")); this.footPitch = Math.atan2(a.y - b.y, Math.hypot(b.x - a.x, b.z - a.z)); }
    idle.stop();
    this.speed = {};
    for (const key of ["walk", "jog"]) {
      const a = this.acts[key]; if (!a) continue;
      const clip = a.getClip(), ac = m.clipAction(clip); ac.play();
      const N = 60, dt = clip.duration / N, zs = [], ys = [];
      for (let i = 0; i < N; i++) { m.setTime(i * dt); rig.updateMatrixWorld(true); const p = wpos(r.bone("foot_l")); zs.push(p.z); ys.push(p.y); }
      ac.stop();
      const lo = Math.min(...ys), v = [];
      for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (ys[i] < lo + 0.02 && ys[j] < lo + 0.02) v.push(-(zs[j] - zs[i]) / dt); }
      v.sort((a, b) => a - b);
      this.speed[key] = Math.abs(v[v.length >> 1] ?? 1.3) || 1.3;
      if (key === "jog") this.speed.jog = clamp(this.speed.jog, 2.5, 4);   // (the jog measures oddly: keep it sane)
    }
    m.stopAllAction(); m.uncacheRoot(r.model);
    rig.position.copy(saveP); rig.quaternion.copy(saveQ); rig.updateMatrixWorld(true);
  }

  play(key, fade = 0.25) {
    const a = this.acts[key];
    if (!a || this.cur === a) return;
    a.reset().play();
    if (this.cur) this.cur.crossFadeTo(a, fade, false);
    else { this.rd.sitAction.crossFadeTo(a, fade, false); }
    this.cur = a;
  }

  // ── pose snapshots for the hand-overs ─────────────────────────────────────
  snapshot() {
    const rig = this.rd.r.rig;
    return { p: rig.position.clone(), q: rig.quaternion.clone(), bones: this.rd.touched.map((t) => t.b.quaternion.clone()), pel: this.rd.B.pelvis.position.clone() };
  }
  applyBlend(dt) {
    const b = this.blend;
    if (!b) return;
    b.t += dt;
    const w = 1 - smooth(b.t / b.dur);
    if (w <= 0) { this.blend = null; return; }
    const rig = this.rd.r.rig;
    rig.position.lerp(b.snap.p, w);
    rig.quaternion.slerp(b.snap.q, w);
    this.rd.touched.forEach((t, i) => t.b.quaternion.slerp(b.snap.bones[i], w));
    this.rd.B.pelvis.position.lerp(b.snap.pel, w);
    rig.updateMatrixWorld(true);
  }
  startBlend(dur = 0.3) { this.blend = { snap: this.snapshot(), t: 0, dur }; this.footPrev = null; this.groundW = null; this.ironW = null; this.ikIronW = null; this.polePrev = null; this.armPolePrev = null; this.tgtPrev = null; this.poleTurn = null; }

  // ── saddle frame helpers ──────────────────────────────────────────────────
  frame() {
    const S = this.rd.saddle, hc = this.hc;
    hc.h.rig.updateMatrixWorld(true);
    const q = S.getWorldQuaternion(new THREE.Quaternion());
    const toW = (v) => S.localToWorld(v.clone());
    // ground height in the saddle frame, under the saddle
    const a = wpos(S);
    const G = S.worldToLocal(new V3(a.x, hc.y, a.z)).y;
    return { S, q, toW, G };
  }
  // the riding ankle position (left side), where the fixed strap holds the tread
  stirrup() {
    const k = this.rd.k, g = stirrupGeom(k), H = g.hang(1);
    const x = POSES.idle.footW * k / 1.07,   // the riding foot's width (an old fixed 0.38 put the sitting knee into the barrel)
      z = 0.12, dx = x - H.x, dz = z - H.z;
    return new V3(x, H.y - Math.sqrt(g.len * g.len - dx * dx - dz * dz) + g.ankleAboveTread, z);
  }
  // an ankle in the near stirrup with the iron pulled out sideways by `out` m
  // The strap is LET DOWN for mounting (what riders do on a tall horse) so
  // the foot goes in a little below the hip; mountExtra = how much longer.
  stirrupPulled(out, fwd = 0.06) {
    const g = stirrupGeom(this.rd.k), H = g.hang(1), { G } = this.frame();
    if (!MP.letDown) { this.mountExtra = 0; return [H.x + out, H.y - Math.sqrt(Math.max(0, g.len * g.len - out * out - fwd * fwd)) + g.ankleAboveTread, H.z + fwd]; }
    const ankleY = G + this.pelvisH - MP.mountDrop, dy = H.y + g.ankleAboveTread - ankleY;
    this.mountExtra = Math.max(this.mountExtra ?? 0, Math.sqrt(dy * dy + out * out + fwd * fwd) - g.len);
    return [H.x + out, ankleY, H.z + fwd];
  }
  // how far the near strap is let down at mount time T: lowered while walking
  // up, back to riding length once seated
  strapExtra(T) { return (this.mountExtra ?? 0) * smooth((T - 0.02) / 0.3) * (1 - smooth((T - 2.1) / 0.45)); }
  // Which side can the rider get on/off: left first (tradition), else right.
  clearSide(prefer = 1) {
    const { toW } = this.frame(), hc = this.hc, k = this.rd.k;
    for (const s of [prefer, -prefer]) {
      const spot = toW(new V3(s * 0.75 * k, 0, 0.15 * k));
      const g = hc.sampleGround(spot.x, spot.z, hc.y, 3);
      if (g === null || Math.abs(g - hc.y) > 0.35) continue;
      const o = toW(new V3(s * 0.3 * k, -0.5, 0.1 * k)), d = toW(new V3(s * 1.2 * k, -0.5, 0.1 * k)).sub(o);
      hc.ray.set(o, d.clone().normalize()); hc.ray.far = d.length();
      if (hc.ray.intersectObjects(hc.world.blockers, false).length) continue;
      return s;
    }
    return 0;
  }

  // ── controls ──────────────────────────────────────────────────────────────
  // F: dismount when riding (standing still), mount when on foot near the horse.
  toggle() {
    if (this.mode === "riding") {
      if (Math.abs(this.hc.v) > 0.3 || this.hc.oneShot || this.hc.rearT >= 0) return "moving";
      const s = this.clearSide(1);
      if (!s) return "blocked";
      this.side = s;
      this.mode = "dismount"; this.t = 0;
      this.rd.dismountBlendFrom = this.snapshot();
      this.startBlend(0.25);
      this.play("idle", 0.4);
      return "ok";
    }
    if (this.mode === "ground") {
      const d = Math.hypot(this.gpos.x - this.hc.pos.x, this.gpos.z - this.hc.pos.z);
      if (d > MP.reach) return "far";
      // the side the rider is on (if clear), else the other
      const { toW } = this.frame();
      const lft = toW(new V3(1, 0, 0)).sub(toW(new V3(0, 0, 0)));
      const onLeft = (this.gpos.x - this.hc.pos.x) * lft.x + (this.gpos.z - this.hc.pos.z) * lft.z >= 0;
      const s = this.clearSide(onLeft ? 1 : -1);
      if (!s) return "blocked";
      this.side = s;
      this.mode = "approach";
      return "ok";
    }
    return "busy";
  }

  // ── per frame ─────────────────────────────────────────────────────────────
  // input: { fwd, turn, run }; returns true when it drove the rider this frame.
  update(dt, input) {
    if (this.mode === "riding") return false;
    if (this.mode === "ground" || this.mode === "approach") this.updateFoot(dt, input);
    else this.updatePerformance(dt);
    return true;
  }

  updateFoot(dt, input) {
    const rd = this.rd, r = rd.r, rig = r.rig, hc = this.hc;
    let fwd = input.fwd, turn = input.turn, run = input.run;
    if (this.mode === "approach") {
      // walk to the mounting spot, then turn to face the horse, then mount
      const { toW, q } = this.frame(), k = rd.k, s = this.side;
      const st0 = this.startPose();
      const spot = toW(new V3(s * st0.x, 0, st0.z));
      const dx = spot.x - this.gpos.x, dz = spot.z - this.gpos.z, dist = Math.hypot(dx, dz);
      const faceYaw = new THREE.Euler().setFromQuaternion(q, "YXZ").y + s * st0.yaw;   // as the get-on starts (saved or built-in)
      let want;
      if (dist > 0.08) want = Math.atan2(dx, dz); else want = faceYaw;
      const dy = Math.atan2(Math.sin(want - this.gyaw), Math.cos(want - this.gyaw));
      turn = clamp(dy * 3, -1, 1);
      fwd = dist > 0.08 && Math.abs(dy) < 1.2 ? clamp(dist * 1.5, 0.25, 1) : 0;
      run = false;
      if (dist <= 0.08 && Math.abs(dy) < 0.05) {
        this.mode = "mount"; this.t = 0;
        this.startBlend(0.3);
        this.play("idle", 0.3);
        return this.updatePerformance(0);
      }
    }
    // tank controls; speed from the clip that is playing so the feet do not slide
    const target = fwd > 0 ? (run ? this.speed.jog : this.speed.walk) * fwd : fwd < 0 ? -0.5 : 0;   // the clips' own speeds: no sliding feet
    this.gv += clamp(target - this.gv, -6 * dt, 4 * dt);
    this.gyaw += turn * MP.turnRate * dt;
    this.gpos.x += Math.sin(this.gyaw) * this.gv * dt;
    this.gpos.z += Math.cos(this.gyaw) * this.gv * dt;
    // keep out of the horse (a capsule along its spine)
    {
      const f = new V3(Math.sin(hc.yaw), 0, Math.cos(hc.yaw));
      const rel = new V3(this.gpos.x - hc.pos.x, 0, this.gpos.z - hc.pos.z);
      const along = clamp(rel.dot(f), -1.1, 1.3);
      const c = new V3(hc.pos.x, 0, hc.pos.z).addScaledVector(f, along);
      const off = new V3(this.gpos.x - c.x, 0, this.gpos.z - c.z), L = off.length(), R = 0.55 * rd.k;
      if (L < R && L > 1e-4) { this.gpos.x = c.x + off.x / L * R; this.gpos.z = c.z + off.z / L * R; }
    }
    const gy = hc.sampleGround(this.gpos.x, this.gpos.z, hc.y + 1, 3) ?? 0;
    const sp = Math.abs(this.gv);
    if (sp < 0.08 && Math.abs(turn) < 0.1) this.play("idle");
    else if (run && sp > this.speed.walk * 1.3) { this.play("jog"); this.cur.setEffectiveTimeScale(clamp(sp / this.speed.jog, 0.5, 1.5)); }
    else { this.play("walk"); this.cur.setEffectiveTimeScale(Math.sign(this.gv || 1) * clamp(Math.max(sp, 0.4) / this.speed.walk, 0.4, 1.5)); }
    rd.mixer.update(dt);
    for (const t of rd.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }
    rig.position.set(this.gpos.x, gy, this.gpos.z);
    rig.quaternion.setFromAxisAngle(new V3(0, 1, 0), this.gyaw);
    rig.updateMatrixWorld(true);
    this.applyBlend(dt);
    rd.stirrups.update(dt, [{ in: 0 }, { in: 0 }]);
    rd.restReins(dt);
  }

  updatePerformance(dt) {
    const rd = this.rd, r = rd.r, rig = r.rig, B = rd.B, s = this.side, k = rd.k;
    const isMount = this.mode === "mount";
    for (const t of rd.touched) { t.b.position.copy(t.p); t.b.quaternion.copy(t.q); }
    rd.mixer.update(dt);
    for (const t of rd.touched) { t.p.copy(t.b.position); t.q.copy(t.b.quaternion); }

    const { q: sq, toW, G } = this.frame();
    const st = this.stirrup();
    const seat = RP.pelvisUp + 0.035;                          // pelvis above the saddle frame when seated
    this.perf ??= {};
    const key = `${s}:${G.toFixed(2)}`;
    if (!this.perf[key]) this.mountExtra = 0;
    if (!this.perf[key]) this.perf[key] = { mount: null, dismount: null };
    const P0 = this.perf[key];
    if (!P0.mount) P0.mount = buildMount({ G, ph: this.pelvisH, st, seat, k, au: this.ankleUp, pull: (o) => this.stirrupPulled(o), farHang: this.stirrupPulled(0.12).map((v, i) => (i === 0 ? -v : v)) });
    if (!P0.dismount) P0.dismount = buildDismount({ G, ph: this.pelvisH, st, seat, k, au: this.ankleUp });
    // keyed data (saved from the animation editor) wins over the code-built one
    const clip = isMount ? "mount" : "dismount";
    this.codePerf = P0;
    let M = isMount ? P0.mount : P0.dismount;
    const data = this.anims[clip];
    if (data) {
      const c = this.compiled[clip];
      if (!c || c.data !== data || c.ver !== this.animVer) { this.compiled[clip] = compilePerf(data); this.compiled[clip].ver = this.animVer; }
      M = this.compiled[clip];
    }
    this.M = M;
    // editor: time is set by the timeline; scrubbing snaps the smoothed feet
    const ed = this.edit;
    if (ed) this.t = clamp(ed.t, 0, M.duration); else this.t = clamp(this.t + dt, 0, M.duration);
    const ds = ed && !ed.playing ? 0 : dt;
    const T = this.t;
    const mir = (v) => (v.x *= s, v);                          // the right side is the mirror image
    // Root: facing (yaw in the saddle frame), part of the lean; pelvis on its path.
    const yaw = M.yaw(T) * s, lean = M.lean(T);
    const up = new V3(0, 1, 0).applyQuaternion(sq);
    const yawQ = new THREE.Quaternion().setFromAxisAngle(new V3(0, 1, 0), yaw);
    const leanQ = new THREE.Quaternion().setFromAxisAngle(new V3(1, 0, 0), lean * 0.4);
    rig.quaternion.copy(sq).multiply(yawQ).multiply(leanQ);
    rig.position.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    const pel = toW(mir(M.pelvis(T)));
    rig.position.copy(pel.sub(wpos(B.pelvis)));
    rig.updateMatrixWorld(true);
    // the rest of the lean in the spine
    const rq = rig.quaternion;
    const lftR = new V3(1, 0, 0).applyQuaternion(rq), fwdR = new V3(0, 0, 1).applyQuaternion(rq);
    const qq = new THREE.Quaternion();
    rotateWorld(B.spine1, qq.setFromAxisAngle(lftR, lean * 0.35));
    rotateWorld(B.spine2, qq.setFromAxisAngle(lftR, lean * 0.25));
    // sideways tilt (+ = toward his LEFT), in the spine
    const tilt = M.tilt(T);
    rotateWorld(B.spine1, qq.setFromAxisAngle(fwdR, -tilt * 0.55));
    rotateWorld(B.spine2, qq.setFromAxisAngle(fwdR, -tilt * 0.45));
    // Feet: near = the leg on the horse's side of the mount (left on the left)
    const legs = s > 0 ? [B.legs[0], B.legs[1]] : [B.legs[1], B.legs[0]];
    // a foot on the ground aims its ANKLE above the sole; in the stirrup the
    // ankle is the target. Fade between the two over the first 10 cm of lift
    // (it used to switch in one frame and bounced the landing foot).
    // (the foot keys ARE ankle positions — on the ground that is ankle height
    // above the floor — so no offset switches or fades: that bounced the foot)
    const footTarget = (p) => toW(mir(p));
    // ── Knees: the NATURAL direction (no roll at the hip) + a keyed TURN ──
    // Phase rules (knee up / along the horse / never inward / turn limits)
    // fought each other and rolled the hip 120–180° — the leg 'rotating at the
    // hip'. Now each knee points where the leg's own anatomy puts it
    // (naturalKneeDir), turned by the nearTwist / farTwist channels (rad, + =
    // the knee rolls OUT), and blended to the riding knees once astride.
    const astride = M.astride(T);
    const nearT = M.nearFoot(T), farT = M.farFoot(T);
    // A foot IN its iron: the BALL of the foot is on the tread, at the strap's
    // fixed length from the bar — the key only gives the direction (as riding
    // does). Keys aiming the ankle at the iron left the foot 9–18 cm off it.
    const sg = stirrupGeom(k);
    this.ikIronW ??= [M.nearIn(T), M.farIn(T)];
    const inIronTarget = (key, li, ironSide) => {
      const g = legs[li], local = mir(key.clone());
      const want = [M.nearIn(T), M.farIn(T)][li];
      if (ds > 0) this.ikIronW[li] += (want - this.ikIronW[li]) * (1 - Math.exp(-ds / 0.12)); else this.ikIronW[li] = want;
      const w = this.ikIronW[li];
      if (w > 0.001) {
        const Hb = sg.hang(ironSide), off = g.ballOffL ?? new V3(0, -0.06, 0);
        // same constraints as the iron itself (stirrups.js): strap length, and
        // outside the horse's side — the toe points in, so the ball sat inside
        // the barrel and the iron (held out) was 9 cm away
        const tread = local.clone().add(off);
        for (let it = 0; it < 2; it++) {
          tread.sub(Hb).setLength(sg.len).add(Hb);
          if (tread.x * ironSide < sg.barrel && tread.y < -0.05) tread.x = ironSide * sg.barrel;
        }
        // until the iron is caught, the foot goes to where the iron REALLY hangs (the feet go to
        // the iron, not the iron to the feet); once held, the iron follows the leg as before
        const sd = rd.stirrups.side[ironSide > 0 ? 0 : 1];
        if (sd?.p && !sd.held) tread.copy(sd.p);
        local.lerp(tread.sub(off), w);
      }
      return toW(local);
    };
    // Limb targets are eased over time (a few hundredths of a second, in the saddle frame): sharp
    // turns in the key paths jolted knees / elbows 4–5 cm in one frame. Scrubbing (dt 0) snaps.
    // never a locked, fully straight limb: reach is softly capped at ~97% (a straight arm / leg read
    // as stiff, and snapped the elbow / knee when it started to bend again)
    const soft = (root, mid, tip, tgt) => {
      const R = wpos(root), L = R.distanceTo(wpos(mid)) + wpos(mid).distanceTo(wpos(tip));
      const d = tgt.clone().sub(R), x = d.length() / L;
      if (x <= 0.88) return tgt;
      const y = 0.88 + 0.09 * (1 - Math.exp(-(x - 0.88) / 0.09));
      return R.addScaledVector(d.normalize(), y * L);
    };
    this.tgtPrev ??= {};
    const ease = (name, wTgt, tc = 0.05) => {
      const S = rd.saddle, l = S.worldToLocal(wTgt.clone()), p = this.tgtPrev[name];
      if (p && ds > 0) l.copy(p.lerp(l, 1 - Math.exp(-ds / tc)));
      this.tgtPrev[name] = l.clone();
      return S.localToWorld(l);
    };
    const nearTgt0 = ease('nf', inIronTarget(nearT, 0, s), 0.07), farTgt0 = ease('ff', inIronTarget(farT, 1, -s), 0.07);   // (a faster ease for a held foot let the catch jump)
    // (a foot standing on the ground keeps its straight leg: the soft cap lifted the planted foot off the floor)
    // eased in over the first 12 cm of lift (switching it on at lift-off jolted the knee 8 cm)
    const capW = (key) => smooth((key.y - (G + this.ankleUp + 0.02)) / 0.12);
    const nearTgt = nearTgt0.clone().lerp(soft(legs[0].u, legs[0].l, legs[0].tip, nearTgt0), capW(nearT)), farTgt = farTgt0.clone().lerp(soft(legs[1].u, legs[1].l, legs[1].tip, farTgt0), capW(farT));
    // A knee is stopped by the horse: if the natural knee would put the thigh
    // or shin inside the barrel, it rolls round the hip→foot line by the
    // SMALLEST angle that clears the skin (+3 cm) — like a real knee sliding
    // along the horse's side instead of going through it.
    const tack = rd.tack, S0 = rd.saddle;
    const insideBy = (g, target, pole) => {
      if (!tack) return 0;
      const H0 = wpos(g.u), a = H0.distanceTo(wpos(g.l)), b = wpos(g.l).distanceTo(wpos(g.tip));
      const d = target.clone().sub(H0), c = clamp(d.length(), Math.abs(a - b) + 1e-3, a + b - 1e-3); d.normalize();
      const q = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
      const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
      const K = H0.clone().addScaledVector(d, cosA * a).addScaledVector(q, Math.sqrt(1 - cosA * cosA) * a), F = H0.clone().addScaledVector(d, c);
      let worst = 0;
      for (const [A, B] of [[H0, K], [K, F]]) for (const u of [0.5, 1]) {
        const pL = S0.worldToLocal(A.clone().lerp(B, u));
        if (Math.abs(pL.z) > 0.55 || pL.y > 0.2) continue;
        const ang = Math.atan2(pL.x, pL.y - tack.axisY), rr = Math.hypot(pL.x, pL.y - tack.axisY);
        worst = Math.max(worst, tack.skin(Math.round(pL.z * 25) / 25, Math.round(ang * 12) / 12) + 0.03 - rr);
      }
      return worst;
    };
    this.polePrev ??= [null, null];
    const kneePole = (i, g, target, twist) => {
      const p0 = naturalKneeDir(rd, g, target, this.polePrev[i]);
      // the far knee lifted UP and to the rider's own RIGHT, away from the left leg (legs spread; it hung pointing down)
      if (i === 1 && M.farKneeUp) { const w = M.farKneeUp(T) * (1 - astride); if (w > 0.001) { const side = lftR.clone().multiplyScalar(g.side); p0.lerp(up.clone().multiplyScalar(0.8).addScaledVector(side, 0.55).addScaledVector(fwdR, 0.25).normalize(), w).normalize();   /* up and to HIS right: the legs spread apart */ } }
      // climbing on the near iron: the knee points like a knee on a high step — toward the horse's
      // shoulder (forward along it, a little in toward it, a little up). The 'natural' direction
      // swung it across the other leg as he pushed up.
      if (i === 0 && this.ikIronW?.[0] > 0) {
        const fH = new V3(0, 0, 1).applyQuaternion(sq), inH = new V3(1, 0, 0).applyQuaternion(sq).multiplyScalar(-s);
        const climb = fH.multiplyScalar(0.75).addScaledVector(inH, 0.55).addScaledVector(up, 0.25).normalize();
        p0.lerp(climb, this.ikIronW[0] * (1 - astride)).normalize();
      }
      const d = target.clone().sub(wpos(g.u)).normalize();
      p0.applyAxisAngle(d, -g.side * twist);                     // + twist = knee rolls OUT (away from the body's centre)
      let p = p0;
      if (astride < 0.99 && insideBy(g, target, p0) > 0) {
        for (let k = 1; k <= 16; k++) {
          const tries = [p0.clone().applyAxisAngle(d, -g.side * 0.1 * k), p0.clone().applyAxisAngle(d, g.side * 0.1 * k)];
          const ok = tries.find((t) => insideBy(g, target, t) <= 0);
          if (ok) { p = ok; break; }
        }
      }
      const ride = fwdR.clone().multiplyScalar(0.85).addScaledVector(lftR, g.side * 0.55).normalize();
      p = p.clone().lerp(ride, astride).normalize();
      // and it turns, it does not jump (≤ 6 rad/s)
      // keep it square to hip→foot (a pole along that line is no direction at
      // all: the knee flipped 55 cm through the horse in one frame)
      p.addScaledVector(d, -p.dot(d)).normalize();
      // and it turns ROUND the hip→foot line, it does not jump (≤ 6 rad/s)
      const prev = this.polePrev[i];
      if (prev && ds > 0) {
        const pp = prev.clone().addScaledVector(d, -prev.dot(d));
        if (pp.lengthSq() > 0.01) {
          pp.normalize();
          let ang = Math.atan2(new V3().crossVectors(pp, p).dot(d), pp.dot(p)), mx = 6 * ds;
          // nearly opposite: keep turning the way it started (deciding afresh each frame flipped the
          // direction every frame and the knee never got there — it stayed pointing in)
          this.poleTurn ??= [0, 0];
          if (Math.abs(ang) > 2.6 && this.poleTurn[i]) ang = this.poleTurn[i] * (2 * Math.PI - Math.abs(ang)) * (Math.sign(ang) === this.poleTurn[i] ? 0 : 1) + (Math.sign(ang) === this.poleTurn[i] ? ang : 0);
          this.poleTurn[i] = Math.abs(ang) > 0.05 ? Math.sign(ang) : 0;
          // eased (time constant 0.07 s) as well as speed-limited: the slide-along-the-horse search
          // picks in 0.1 rad steps and stepped the knee 3 cm every few frames
          const eased = ang * (1 - Math.exp(-ds / 0.07));
          p = pp.applyAxisAngle(d, clamp(eased, -mx, mx));
        }
      }
      this.polePrev[i] = p.clone();
      return p;
    };
    this.kneeDbg = [kneePole(0, legs[0], nearTgt, M.nearTwist(T)), kneePole(1, legs[1], farTgt, M.farTwist(T))];
    solveLeg(legs[0], nearTgt, this.kneeDbg[0]);
    solveLeg(legs[1], farTgt, this.kneeDbg[1]);
    // a foot in its iron is levelled like riding (near / far by the phase)
    {
      // the foot points the way the RIDER faces (its knee) — facing the horse
      // while mounting — and only turns to the horse's forward once astride
      // (aiming it along the horse twisted the ankle ~90° in the iron)
      // Every foot follows its SHIN like a natural ankle; flat when on the
      // ground; blended (never switched) to the riding foot once astride.
      // (Forcing a horizontal foot onto an angled shin the moment the foot
      // entered the iron twisted the ankle 84°.)
      const fwS = new V3(0, 0, 1).applyQuaternion(sq), lfS = new V3(1, 0, 0).applyQuaternion(sq);
      this.footPrev ??= [null, null];
      // a foot in its iron is held level; a foot hanging free (neither on the
      // ground nor in an iron) relaxes, toes DOWN — the getting-off feet stayed
      // flat as if still in the irons
      const inIron = [M.nearIn(T), M.farIn(T)];
      this.ironW ??= [...inIron];
      [[legs[0], nearT], [legs[1], farT]].forEach(([g, tgt], fi) => {
        if (ds > 0) this.ironW[fi] += (inIron[fi] - this.ironW[fi]) * (1 - Math.exp(-ds / 0.15)); else this.ironW[fi] = inIron[fi];
        const gw0 = 1 - smooth((tgt.y - (G + this.ankleUp)) / 0.3);
        const dangle = (1 - gw0) * (1 - this.ironW[fi]);
        let dir = naturalFootDir(g, 0.25 + 0.6 * dangle);
        // the near foot turns toward the iron while it RISES, so it arrives lined up (it pivoted at the catch)
        if (fi === 0 && M.nearFootTurn) {
          const lift = 1 - (this.groundW?.[0] ?? 1);                 // 0 standing on the ground → 1 lifted
          const wPre = clamp(lift, 0, 1) * (1 - M.nearFootTurn(T)) * (1 - astride);
          if (wPre > 0.001) {
            const into = new V3(1, 0, 0).applyQuaternion(sq).multiplyScalar(-s), pitch = this.footPitch;
            const pre = into.multiplyScalar(Math.cos(pitch)).addScaledVector(up, -Math.sin(pitch)).normalize();
            dir.lerp(pre, wPre).normalize();
          }
        }
        const flat = fwdR.clone().addScaledVector(up, -fwdR.dot(up)).normalize().multiplyScalar(Math.cos(this.footPitch)).addScaledVector(up, -Math.sin(this.footPitch)).normalize();
        // ground contact weight, smoothed over TIME (it flipped within a few
        // frames at lift-off and flicked the foot 25°)
        const gw = 1 - smooth((tgt.y - (G + this.ankleUp)) / 0.3);
        this.groundW ??= [gw, gw];
        if (ds > 0) this.groundW[fi] += (gw - this.groundW[fi]) * (1 - Math.exp(-ds / 0.12)); else this.groundW[fi] = gw;
        const groundW = this.groundW[fi];
        dir.lerp(flat, groundW).normalize();
        const ride = ridingFootDir(fwS, up, lfS, g.side, this.footPitch);
        // the riding foot (level in the iron) while the foot is IN its iron — by 'astride' it twisted a
        // foot leaving its iron 42° and moved the ball of a foot still in its iron 8 cm off the tread
        // in its iron: the SHIN'S heading (forcing the horse's heading on an angled shin twisted the
        // ankle 40–49°) with the iron's level pitch; the full riding foot only once seated
        const ironLv = this.ironW[fi] * smooth((tgt.y - (G + this.ankleUp)) / 0.4);
        if (ironLv > 0.001) {
          let h = dir.clone().addScaledVector(up, -dir.dot(up)); if (h.lengthSq() > 1e-6) h.normalize(); else h.copy(fwS);
          // the near foot goes in STRAIGHT, toe toward the horse, and stays so (the iron with it)
          // until footTurn lets it rotate — smoothly — to its natural / riding heading
          if (fi === 0) { const intoHorse = lfS.clone().multiplyScalar(-s); h = intoHorse.lerp(h, M.nearFootTurn(T)).normalize(); }
          const pa = this.footPitch - 0.06;   // stepping in / standing in the iron: sole level, heel a touch down (the riding toe-down comes with astride)
          const level = h.multiplyScalar(Math.cos(pa)).addScaledVector(up, -Math.sin(pa)).normalize();
          dir.lerp(level, ironLv).normalize();
        }
        dir.lerp(ride, astride * this.ironW[fi]).normalize();
        aimFoot(g, dir);
        // ankle → tread (the ball, 3.5 cm under it) in the saddle frame, for next frame's iron target
        const S0 = this.rd.saddle;
        // smoothed: it feeds next frame's foot target, which moves the knee, which turns the foot —
        // taken raw, that loop made the knee shake 3.5 cm every frame
        const offNow = S0.worldToLocal(wpos(g.ball).addScaledVector(up, -BALL_TO_TREAD)).sub(S0.worldToLocal(wpos(g.tip)));
        if (g.ballOffL && ds > 0) g.ballOffL.lerp(offNow, 1 - Math.exp(-ds / 0.15)); else g.ballOffL = offNow;
      });
    }
    // Hands: from the hanging clip pose to their targets (weight), elbows out-down
    const w = M.handW(T);
    const arms = s > 0 ? [B.arms[0], B.arms[1]] : [B.arms[1], B.arms[0]];
    [[arms[0], M.nearHand(T)], [arms[1], M.farHand(T)]].forEach(([g, tgt]) => {
      const cur = wpos(g.tip);
      const T3 = cur.clone().lerp(soft(g.u, g.l, g.tip, ease(g === arms[0] ? 'nh' : 'fh', toW(mir(tgt)))), w);
      const back = g === arms[0] ? M.nearElbowBack(T) : 0;      // the near elbow pushed BACK (propping, body turning with it)
      const pole = lftR.clone().multiplyScalar(g.side * M.elbowsOut(T)).addScaledVector(up, -0.35).addScaledVector(fwdR, -0.3 - back).normalize()   // elbows out from the body (keyed)
        .lerp(lftR.clone().multiplyScalar(g.side * RP.elbowsOut).addScaledVector(up, -0.15).addScaledVector(fwdR, -0.2).normalize(), astride).normalize();   // seated: the riding elbows (they snapped at the hand-over)
      // the elbow TURNS, it does not jump (≤ 5 rad/s) — key and rule changes snapped it 4–5 cm in a frame
      this.armPolePrev ??= [null, null];
      const ai = g === arms[0] ? 0 : 1, pp = this.armPolePrev[ai];
      if (pp && ds > 0) { const ang = Math.acos(clamp(pp.dot(pole), -1, 1)), mx = 5 * ds; if (ang > mx) { const ax = new V3().crossVectors(pp, pole); if (ax.lengthSq() > 1e-10) pole.copy(pp).applyAxisAngle(ax.normalize(), mx); } }
      this.armPolePrev[ai] = pole.clone();
      solveTwoBone(g.u, g.l, cur, T3, pole, new V3(), true);
    });
    // head looks at what it's doing: the stirrup early, forward late
    const look = M.look(T);
    rotateWorld(B.head, qq.setFromAxisAngle(lftR, 0.35 * look));
    // fists close on the reins / saddle as the hands arrive
    const q2 = new THREE.Quaternion();
    // fingers: closed only on what the hand holds (nearGrip / farGrip); relaxed in the air
    const grips = s > 0 ? [M.nearGrip(T), M.farGrip(T)] : [M.farGrip(T), M.nearGrip(T)];
    // wrists, blended (never switched — a switch snapped the wrist 70–125° in one frame):
    // in the air the hand continues the forearm; resting / holding on the seat it lies palm
    // down with the fingers the way HE faces; astride it takes the rein grip
    {
      const fH = new V3(0, 0, 1).applyQuaternion(sq), lH = new V3(1, 0, 0).applyQuaternion(sq);
      const faceFlat = fwdR.clone().addScaledVector(up, -fwdR.dot(up)).normalize();
      rd.hands.forEach((hd, hi) => {
        const g = rd.B.arms[hi], fore = wpos(g.tip).sub(wpos(g.l)).normalize();
        const dir = fore.clone().lerp(faceFlat, grips[hi]).normalize();
        rd.orientHandTo(hd, dir, up.clone().negate(), w);
        rd.orientHand(hd, fH, up, lH, w * astride);
      });
    }
    rd.hands.forEach((hd, hi) => { for (const c of hd.curl) c.b.quaternion.multiply(q2.setFromAxisAngle(c.axis, c.angle * w * 0.85 * grips[hi])); });
    rig.updateMatrixWorld(true);
    this.applyBlend(dt);
    // the near foot takes its iron as it arrives (0.4 s); the far foot finds
    // its own as the rider sits (2.3 s)
    const nearIn = M.nearIn(T), farIn = M.farIn(T);
    const nearIdx = s > 0 ? 0 : 1;
    const fw = new V3(0, 0, 1).applyQuaternion(sq);
    const ex = this.strapExtra(T);
    rd.stirrups.update(dt, [0, 1].map((i) => ({ in: i === nearIdx ? nearIn : farIn, ankle: wpos(B.legs[i].tip), ball: wpos(B.legs[i].ball), fwd: fw, extra: i === nearIdx ? ex : 0 })));
    rd.restReins(dt);
    // ends
    if (ed) return;                                            // the editor holds the performance open
    if (this.mode === "mount" && T >= M.duration) {
      this.mode = "riding";
      rd.seatY = null;                                         // re-seed the seat spring
      rd.sitAction.reset().play();
      this.cur?.crossFadeTo(rd.sitAction, 0.3, false);
      this.cur = null;
      rd.pendingBlend = this.snapshot();                       // riding blends away from this pose
    }
    if (this.mode === "dismount" && T >= M.duration) {
      this.mode = "ground";
      const p = wpos(rd.B.pelvis);
      this.gpos.set(p.x, 0, p.z);
      this.gyaw = new THREE.Euler().setFromQuaternion(rig.quaternion, "YXZ").y;
      this.gv = 0;
      this.startBlend(0.3);
    }
  }
}
