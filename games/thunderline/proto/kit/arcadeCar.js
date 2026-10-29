// THE ARCADE CAR (games/thunderline/PHYSICS_PLAN.md). A driving model designed for a stunt racer, not the old car with
// rescues — and, since 2026-10-29 (user: "the car rolls itself before the landing … in the loop I have NO controls"),
// built on what the game KNOWS rather than what a ray guesses: every track is made of known pieces, so the road's
// centre line, its forward and its UP are known at every point (the ride: stuntCar.js trackFromRide).
//   - SUSPENSION: four springs on the old car's own road probes, progressive, a BUMP STOP (a tyre never goes into the
//     road) and a stiff rebound (a big landing doesn't throw the car back up).
//   - ON THE ROAD = wheels down, OR the road just under them for a moment (`road.coyote` s): a wheel lifting for an
//     instant in a loop or over a crest is not "flying" — the car keeps its grip, steering and gravity.
//   - GRAVITY: the world's — but on a stunt surface (the road tilted past `wall.from`, or a road-hold piece: loops,
//     walls, tubes, steep tilted landings) toward the ROAD'S OWN UP (the track frame), so it holds upside down.
//   - GRIP IS A CURVE (the research: "a wheel turns hard at slight angles, but slips at more extreme angles"): the
//     sideways speed is taken away at up to `grip.g` g, most at a small slide angle, less once sliding — slides and
//     drifts are real (the handbrake lowers the curve) instead of deleted.
//   - STEERING SETS THE TURN RATE, high at low speed, gentle at top speed, eased (keyboards).
//   - THE CAR SITS ON THE ROAD: it turns WITH the road (the track frame's own rotation, fed forward) and its up is
//     kept on the road's up (on a track piece) or the wheels' surface (off it) while ≥ 2 wheels are down; with the body on the
//     road and the wheels not, it is righted on the ROLL axis only (the research: "stabilising multiple axes can be
//     unpredictable").
//   - IN THE AIR IT DOES ONLY WHAT YOU PRESS: a set rate while a key is held, the attitude held when released. No
//     assist turns it (the first one rolled a car flying straight: a ray hit a rail).
//   - the TAKE-OFF GUIDE and the LANDING CATCH of the stunt car (inherited), and a landing that stays landed.
// The collision code is the old car's, unchanged: rails, walls, props, the deck under the body, the floor.
import * as THREE from "three";
import { TIRE, WHEEL, CHASSIS, DECK, SOLID, AERO } from "../../../../v3/play/modularRoadVehicle.js";
import { StuntCar } from "./stuntCar.js";

export const ARCADE = {
  // N/m, N·s/m per wheel; `rebound` the damper extending; `prog` stiffens it as it compresses (N/m³); `clear` m of tyre
  // kept over the road by the bump stop
  // `stop` N/m: the bump stop is a very stiff spring AT EACH WHEEL (a push of the whole car out of the road, by the
  // deepest wheel, lifted the other axle off: in a loop's 9 g the front met the curve first and the rear wheels rode
  // 0.65 m off it — half the grip; the car drifted sideways); the whole car is moved out only past `deep` m
  ride: { k: 60000, c: 5200, rebound: 16000, prog: 900000, clear: 0.04, stop: 400000, deep: 0.08 },
  // `top` m/s: its own (user, 2026-10-29: "it should go faster, in Apex Rush it goes more than 300 km/h") — the engine stops pulling at 100 (360 km/h); with the air drag it tops ~315
  drive: { top: 100, accel: 11.5, brake: 20, reverseTop: 14, coast: 0.8, overspeed: 0.6 }, // m/s², m/s, /s
  // GRIP: up to `g` g of sideways grip, all of it at `peakDeg` of slide, `slide` of it once sliding past `slideDeg`;
  // `handbrake` scales it (a drift)
  // `aero`: the DOWNFORCE GRIPS — the grip × (1 + aero × downforce / g) (user, 2026-10-29, a real track: at 330 km/h
  // Sky Switchback's banked fast turn asked 6.7 g, the flat 2.2 g slid the car off it; a fast car turns harder fast)
  grip: { g: 2.2, peakDeg: 8, slideDeg: 30, slide: 0.7, handbrake: 0.35, aero: 1 },
  steer: { low: 2.2, high: 1.0, lowAt: 8, response: 9, handbrakeBoost: 1.5 }, // rad/s at lowAt m/s → at top speed
  align: { rate: 10, max: 4, rollOnly: 4 }, // /s, rad/s: up onto the wheels' surface; /s: the body-on-road roll righting
  // ON THE ROAD: `coyote` s after the last wheel contact the car still counts as on it, while the road (the track
  // frame) is within `reach` m of where its wheels would be
  road: { coyote: 0.25, reach: 1.5, agree: 0.94 }, // agree: cos of the wheels' normal ↔ the road's up (~20°)
  // THE STUNT GUIDE (user, 2026-10-29: "in the loop it's clearly uncontrollable" — measured: no input, the car turned
  // 85° off the road's direction inside the loop and wedged on the rail; the loop steps sideways as it goes round, so
  // a car holding its own heading on the surface drifts off it): on a stunt surface (× the stunt gravity), the turn
  // rate is drawn toward the ROAD'S direction at `rate` /s of heading error; beyond `maxDeg` the player meant it.
  // Your steering adds on top.
  // …and aimed back toward the middle by `centre` rad per m off it (at most `centreMaxDeg`): the loop's road steps
  // sideways under the car, which ended 6 m off-centre, beside the rail
  guide: { rate: 4, maxDeg: 50, centre: 0.06, centreMaxDeg: 10 },
  // STUNT SURFACE GRAVITY: the road's up below `from` (its y) → gravity starts turning toward it, fully by `full`;
  // it needs `minSpeed` m/s (a stopped car falls off a wall)
  wall: { from: 0.75, full: 0.45, minSpeed: 10 },
  stick: { k: 0.0028, max: 14, minSpeed: 15 }, // downforce ∝ v² while on the road
  land: { hold: 0.5 }, // s after a touchdown the car does not leave the surface
  // rad/s; /s to the asked rate; /s idle: stop; `follow` /s: with no pitch key the NOSE FOLLOWS THE FLIGHT (pitch only,
  // from the car's own velocity — never roll or yaw, never a ray: user 2026-10-23 "why doesn't the car go nose down when
  // falling … that's how it can land smoothly"; off a 45° ramp it flew nose-up and landed tail-first)
  // (follow ON again, 2026-10-29 — user: "in Apex Rush the car points nose down along the arc"; the old car does it too
  // since 10-23. Landing on FLAT ground off a big ramp it comes down nose-first: Thunderline's landings are shaped to
  // the arc. Your pitch keys override it)
  air: { roll: 3.6, pitch: 2.8, yaw: 2.4, response: 8, hold: 3, follow: 2 },
};

const G = 9.81, DEG = Math.PI / 180;
const _com = new THREE.Vector3(), _n = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const _up = new THREE.Vector3(), _tmp = new THREE.Vector3(), _axis = new THREE.Vector3(), _F = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _w = new THREE.Vector3(), _roadUp = new THREE.Vector3(), _rel = new THREE.Vector3();
const bump = { pen: 0, n: new THREE.Vector3() };

export class ArcadeCar extends StuntCar {
  constructor(opts) {
    super(opts);
    this.isArcadeCar = true;
    this._landHold = 0;
    this._sinceWheels = 9; // s since a wheel last touched
    this._ff = new THREE.Vector3(); // rad/s: the road's own rotation under the car (turned with it, not after it)
    this._prevRoadUp = null;
    /** (pos) → the track frame { P, T, U, d } or null — set per run (stuntCar.js trackFromRide) */
    this.trackAt = null;
    /** what the last step saw, for the lab's telemetry */
    this.arcade = { onRoad: false, stunt: 0, slideDeg: 0 };
  }
  // A LANDING IS A CAR LANDING (user, 2026-10-29: "the landing looks very weird, very smooth, not at all like a car that
  // lands"): not the stunt car's catch — that deleted the speed into the ground (the springs never compressed) and gave
  // the fall back as forward speed. Here the springs take it (progressive, the bump stop, a stiff rebound) and the
  // car only doesn't bounce back off (`land.hold`).
  _catchLanding() { this._landHold = ARCADE.land.hold; this.stuntEvents.caught = false; }
  respawn() { this._landHold = 0; this._sinceWheels = 9; this._ff?.set(0, 0, 0); this._prevRoadUp = null; return super.respawn(); }
  respawnAt(pos, quat) { this._landHold = 0; this._sinceWheels = 9; this._ff?.set(0, 0, 0); this._prevRoadUp = null; return super.respawnAt(pos, quat); }

  /** the whole driving step (the old car's _physicsStep, replaced) — collisions are the old car's */
  _physicsStep(dt) {
    const subDt = dt / this.SUBSTEPS, body = this.body;
    _com.set(CHASSIS.comX, CHASSIS.comY, CHASSIS.comZ);
    for (let s = 0; s < this.SUBSTEPS; s++) {
      // ---- the wheels: the old probes; progressive springs + rebound damping along the chassis' up at each hub
      _up.set(0, 1, 0).applyQuaternion(body.quat);
      _n.set(0, 0, 0);
      let down = 0, roadHold = false;
      bump.pen = 0;
      for (const t of this.tires) {
        t.worldPos.copy(t.localPos).sub(_com).applyQuaternion(body.quat).add(body.pos);
        t._up.copy(_up);
        t._fwd.set(0, 0, 1).applyQuaternion(body.quat);
        t._right.set(1, 0, 0).applyQuaternion(body.quat);
        t._wheelFwd.copy(t._fwd);
        t._wheelRight.copy(t._right);
        t._down.copy(_up).negate();
        const probe = t._probeGround(this._castGround, this._castSphereSweep, TIRE.rayPadAbove, TIRE.rayLength + TIRE.rayPadAbove);
        // (the probe's rays start rayPadAbove over the hub: its distance less that is the hub's height over the road)
        const fromHub = probe ? probe.dist - TIRE.rayPadAbove : Infinity;
        const comp = TIRE.restLength - Math.max(0, fromHub);
        if (!probe || comp <= 0) { t._clearContact(); continue; }
        t.grounded = true;
        t.hitDistance = fromHub;
        t.hitPoint.copy(probe.point);
        t._rawNormal.copy(t._bestN);
        if (t._rawNormal.dot(_up) < 0) t._rawNormal.negate();
        t._rawNormal.normalize();
        t.hitNormal.copy(t._rawNormal);
        t.hitRoadHold = probe.roadHold === true;
        t.hitFreeCarve = probe.freeCarve === true;
        const rate = t._prevCompValid ? (comp - t._prevComp) / subDt : 0;
        t._prevComp = comp; t._prevCompValid = true;
        t.compression = comp;
        const R = ARCADE.ride;
        const pen = WHEEL.radius + R.clear - fromHub; // (the bump stop: how far the tyre would be in the road)
        const f = Math.max(0, R.k * comp + R.prog * comp * comp * comp + (rate < 0 ? R.rebound : R.c) * rate) + R.stop * Math.max(0, pen);
        body.addForceAtPoint(_F.copy(_up).multiplyScalar(f), t.worldPos);
        t._bumpPen = pen;
        if (pen > bump.pen) { bump.pen = pen; bump.n.copy(t._rawNormal); }
        _n.add(t._rawNormal);
        roadHold ||= t.hitRoadHold;
        down++;
      }
      if (down) { _n.normalize(); this._sinceWheels = 0; } else this._sinceWheels += subDt;

      // ---- THE TRACK FRAME: the road's own up under the car (known, not guessed), and whether the car is on it
      const tr = this.trackAt?.(body.pos) ?? null;
      // near the road = over its deck (the ride's line is 0.7 m over it), anywhere across it (wide pieces: 24 m)
      let roadNear = false;
      if (tr) {
        _roadUp.copy(tr.U);
        const along = _rel.subVectors(body.pos, tr.P).dot(tr.U), across = Math.sqrt(Math.max(0, _rel.lengthSq() - along * along));
        roadNear = along > -1.5 && along < ARCADE.road.reach + 1 && across < 26;
      } else _roadUp.set(0, 1, 0);
      const onRoad = down > 0 || (this._sinceWheels < ARCADE.road.coyote && roadNear);
      // THE SURFACE IT IS ON: on a road, the road's own up at the car's middle (when the wheels roughly agree — not on
      // a kerb or an obstacle); else the wheels'. (The wheels' alone, in a loop, was the FRONT wheels' road: the car
      // sat 2.7° nose-down on the curve, its rear wheels 0.65 m off the road — half its grip, it drifted sideways.)
      const surf = !down ? _roadUp : roadNear && _n.dot(_roadUp) > ARCADE.road.agree ? _roadUp : _n;
      // THE ROAD'S ROTATION (feed-forward): the car turns WITH the road, the alignment only corrects what's left — a
      // catch-up alone trailed a loop's 1.6 rad/s by ~9°, nose down, the rear wheels off the road
      if (tr && roadNear && this._prevRoadUp) {
        _w.crossVectors(this._prevRoadUp, _roadUp).multiplyScalar(1 / subDt);
        this._ff.lerp(_w, 1 - Math.exp(-subDt / 0.04));
      } else this._ff.multiplyScalar(0.8);
      if (tr && roadNear) (this._prevRoadUp ??= new THREE.Vector3()).copy(_roadUp); else this._prevRoadUp = null;

      // ---- gravity: the world's, or on a stunt surface — tilted past wall.from, or a road-hold piece — the road's up
      const speed = body.vel.length();
      // PULLED ONTO THE ROAD only while the wheels are on it, or the car is coming back TO it (a wheel lifting for an
      // instant in a loop) — never while it LEAVES it: in the coyote time after a lip the downforce (≤ 1.4 g) and
      // the stunt gravity went on pulling the car down, ~6 m/s of its climb gone, every jump flew lower than its
      // take-off (and than the builder's arc: user, 2026-10-29, "there is no way I reach that landing")
      // (wheels off for an instant — a bank's exit, a crest, a loop — the road still pulls; but not past a LIP: there
      // the road does not go on under where the car is headed. Without the pull at all, the arcade car flew off the
      // Tilted landing test's 45° bank exit at 266 km/h)
      const pressed = down > 0 || (onRoad && this._roadAhead(body));
      let stunt = 0;
      if (pressed) {
        stunt = THREE.MathUtils.clamp((ARCADE.wall.from - surf.y) / (ARCADE.wall.from - ARCADE.wall.full), 0, 1);
        if (roadHold) stunt = Math.max(stunt, 0.6);
        stunt *= THREE.MathUtils.clamp((speed - ARCADE.wall.minSpeed) / 8, 0, 1);
      }
      _F.set(0, -G * body.mass * (1 - stunt), 0).addScaledVector(surf, -G * body.mass * stunt);
      this._stickAcc = pressed && speed > ARCADE.stick.minSpeed ? Math.min(ARCADE.stick.max, ARCADE.stick.k * speed * speed) : 0;
      if (this._stickAcc) _F.addScaledVector(surf, -this._stickAcc * body.mass);
      _F.addScaledVector(body.vel, -AERO.drag * speed); // air drag (the old car's AERO.drag)
      body.addForce(_F);

      if (onRoad) this._groundDrive(subDt, down, surf, stunt > 0 ? tr : null, stunt);
      else this._airControl(subDt);

      // ---- just landed: nothing carries it off the surface again
      if (this._landHold > 0) {
        this._landHold -= subDt;
        if (down > 0) { const vn = body.vel.dot(surf); if (vn > 0) body.vel.addScaledVector(surf, -vn); } // (wheels on: a kicker right after a landing still launches)
      }
      // ---- the bump stop: out of the road along its normal; the speed into it stopped AT THAT WHEEL — an impulse at
      // the tyre, not at the middle of the car, so a car landing on its rear wheels has its nose slam down onto the
      // front ones (it floated, pitched, for 0.4 s when the whole car's fall was stopped at once)
      if (bump.pen > 0) {
        if (bump.pen > ARCADE.ride.deep) body.pos.addScaledVector(bump.n, bump.pen - ARCADE.ride.deep);
        for (let pass = 0; pass < 2; pass++) for (const t of this.tires) {
          if (!t.grounded || !(t._bumpPen > 0)) continue;
          _r.subVectors(t.hitPoint, body.pos);
          const vn = _F.crossVectors(body.angVel, _r).add(body.vel).dot(t._rawNormal);
          if (vn >= 0) continue;
          const j = -vn / body.effectiveInvMass(_r, t._rawNormal);
          body.applyImpulseAtPoint(_F.copy(t._rawNormal).multiplyScalar(j), t.hitPoint);
        }
      }
      // ---- the old car's collisions: rails / walls / props, the body against the deck, the floor
      if (SOLID.enabled) this._resolveSolids(subDt);
      if (DECK.enabled && this.groundBvh && this.groundBvh.baked) this._applyDeckContact(subDt);
      this._applyChassisGroundContact(subDt);
      body.integrate(subDt);
      const wMax = TIRE.maxAngVel;
      if (body.angVel.lengthSq() > wMax * wMax) body.angVel.setLength(wMax);
      this.arcade.onRoad = onRoad; this.arcade.stunt = stunt;
    }
  }

  /** Is there road under where the car will be in 0.15 s? (no: it is leaving a lip — a take-off, not a crest) */
  _roadAhead(body) {
    const ahead = _rel.copy(body.pos).addScaledVector(body.vel, 0.15);
    const tr = this.trackAt?.(ahead);
    if (!tr || tr.end) { this.trackAt(body.pos); return false; }
    const rel = ahead.sub(tr.P), along = rel.dot(tr.U), across = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
    this.trackAt(body.pos); // (back to where the car is: trackAt searches round its last match)
    return along > -1.5 && along < ARCADE.road.reach + 1 && across < 26;
  }

  /** ON THE ROAD: engine, brakes, the grip curve, the turn rate, the car kept on the surface */
  _groundDrive(dt, down, surf, tr, stunt) {
    const body = this.body, w = Math.max(down, 2) / 4; // (fewer wheels, less authority — never none: the coyote time)
    _f.set(0, 0, 1).applyQuaternion(body.quat).projectOnPlane(surf).normalize();
    _r.crossVectors(surf, _f).normalize(); // (the car's LEFT, as its +X)
    const vF = body.vel.dot(_f), vR = body.vel.dot(_r);
    const top = ARCADE.drive.top, th = this.input.throttle, hb = this.input.handbrake, D = ARCADE.drive;
    // engine / brakes / reverse along the nose
    let a = 0;
    if (th > 0) a = vF < -0.5 ? D.brake * th : D.accel * th * Math.max(0, 1 - (vF / top) ** 2);
    else if (th < 0) a = vF > 0.5 ? D.brake * th : D.accel * th * Math.max(0, 1 - (-vF / D.reverseTop) ** 2);
    else a = -Math.sign(vF) * Math.min(Math.abs(vF) / dt, D.coast);
    if (hb) a += -Math.sign(vF) * Math.min(Math.abs(vF) / dt, 3);
    if (Math.abs(vF) > top) a -= Math.sign(vF) * (Math.abs(vF) - top) * D.overspeed;
    body.vel.addScaledVector(_f, a * dt * w);
    // THE GRIP CURVE: the sideways speed taken away at up to grip.g g — all of it at a small slide, less once sliding
    const Gp = ARCADE.grip, slide = Math.atan2(Math.abs(vR), Math.max(1, Math.abs(vF))) / DEG;
    const curve = slide <= Gp.peakDeg ? 0.55 + 0.45 * (slide / Gp.peakDeg) : slide >= Gp.slideDeg ? Gp.slide : 1 - (1 - Gp.slide) * ((slide - Gp.peakDeg) / (Gp.slideDeg - Gp.peakDeg));
    const grip = Gp.g * G * curve * (hb ? Gp.handbrake : 1) * w * (1 + Gp.aero * (this._stickAcc ?? 0) / G);
    body.vel.addScaledVector(_r, -Math.sign(vR) * Math.min(Math.abs(vR), grip * dt));
    this.arcade.slideDeg = slide;
    // steering: the turn rate about the surface (positive steer = left, the old car's convention)
    const S = ARCADE.steer, sp = Math.abs(vF), tL = THREE.MathUtils.clamp((sp - S.lowAt) / Math.max(1, top - S.lowAt), 0, 1);
    let want = this.input.steer * THREE.MathUtils.lerp(S.low, S.high, tL) * Math.min(1, sp / 4) * Math.sign(vF || 1);
    if (hb) want *= S.handbrakeBoost;
    // the stunt guide: toward the road's own direction (its forward laid on the surface the wheels are on)
    if (tr && vF > 5) {
      _tmp.copy(tr.T).addScaledVector(surf, -tr.T.dot(surf));
      if (_tmp.lengthSq() > 1e-6) {
        _tmp.normalize();
        const Gd = ARCADE.guide, head = Math.atan2(_axis.crossVectors(_f, _tmp).dot(surf), _f.dot(_tmp));
        const side = _axis.subVectors(body.pos, tr.P).dot(_r); // (+ = left of the middle)
        const aim = head - THREE.MathUtils.clamp(side * Gd.centre, -Gd.centreMaxDeg * DEG, Gd.centreMaxDeg * DEG);
        if (Math.abs(head) < Gd.maxDeg * DEG) want += aim * Gd.rate * stunt;
      }
    }
    const cur = body.angVel.dot(surf);
    const yaw = cur + (want - cur) * (1 - Math.exp(-S.response * dt));
    // the up onto the surface: both axes on ≥ 2 wheels; on the roll axis only with the body on the road (no wheels)
    _up.set(0, 1, 0).applyQuaternion(body.quat);
    _w.set(0, 0, 0);
    if (down >= 2) {
      _axis.crossVectors(_up, surf);
      const s = _axis.length(), ang = Math.atan2(s, _up.dot(surf));
      if (s > 1e-6) _w.copy(_axis.multiplyScalar(1 / s)).multiplyScalar(Math.min(ARCADE.align.max, ang * ARCADE.align.rate));
      _w.add(this._ff).addScaledVector(surf, -this._ff.dot(surf)); // (+ the road's own pitch / roll rate)
      body.angVel.copy(_w).addScaledVector(surf, yaw);
    } else {
      // roll only: about the car's own forward
      _tmp.set(0, 0, 1).applyQuaternion(body.quat);
      const rollErr = Math.atan2(_tmp.clone().cross(_up).dot(surf), _up.dot(surf)); // (signed: which way it leans)
      _qi.copy(body.quat).invert();
      const local = _w.copy(body.angVel).applyQuaternion(_qi);
      local.z += (rollErr * ARCADE.align.rollOnly - local.z) * (1 - Math.exp(-6 * dt));
      body.angVel.copy(local.applyQuaternion(body.quat));
      body.angVel.addScaledVector(surf, yaw - body.angVel.dot(surf));
    }
  }

  /** IN THE AIR: a set rate while a key is held, the attitude held when released — nothing else turns it */
  _airControl(dt) {
    const body = this.body, A = ARCADE.air;
    // the asked rates in the car's own frame: x pitch (nose up = −x, the old car's convention), y yaw, z roll
    const inP = this.input.pitch ?? 0;
    const want = _tmp.set(-inP * A.pitch, (this.input.yaw ?? 0) * A.yaw, -(this.input.airSteer ?? 0) * A.roll);
    _qi.copy(body.quat).invert();
    let follow = false;
    if (inP === 0 && A.follow > 0 && body.vel.lengthSq() > 25) {
      const vl = _axis.copy(body.vel).applyQuaternion(_qi); // (the flight in the car's frame: z forward, y up)
      const err = Math.atan2(vl.y, Math.hypot(vl.z, 1e-6) * Math.sign(vl.z || 1)); // + = the flight is above the nose
      want.x = THREE.MathUtils.clamp(-err * A.follow, -A.pitch, A.pitch);
      follow = true;
    }
    const local = _w.copy(body.angVel).applyQuaternion(_qi);
    for (const c of ["x", "y", "z"]) {
      const k = want[c] !== 0 || (follow && c === "x") ? A.response : A.hold;
      local[c] += (want[c] - local[c]) * (1 - Math.exp(-k * dt));
    }
    body.angVel.copy(local.applyQuaternion(body.quat));
  }
}
