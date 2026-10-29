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
import { TIRE, WHEEL, CHASSIS, DECK, SOLID, AERO, CRASH, WHEEL_LOCAL } from "../../../../v3/play/modularRoadVehicle.js";
import { StuntCar } from "./stuntCar.js";

export const ARCADE = {
  // N/m, N·s/m per wheel; `rebound` the damper extending; `prog` stiffens it as it compresses (N/m³); `clear` m of tyre
  // kept over the road by the bump stop
  // `stop` N/m: the bump stop is a very stiff spring AT EACH WHEEL (a push of the whole car out of the road, by the
  // deepest wheel, lifted the other axle off: in a loop's 9 g the front met the curve first and the rear wheels rode
  // 0.65 m off it — half the grip; the car drifted sideways); the whole car is moved out only past `deep` m
  ride: { k: 60000, c: 5200, rebound: 16000, prog: 900000, clear: 0.04, stop: 400000, deep: 0.08, visualDrop: 0.1 }, // visualDrop: see syncVisuals
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
  road: { coyote: 0.25, reach: 1.5, agree: 0.94, crestReach: 6, edge: 1.5 }, // edge: m past a road's side still on it (the kerb, a wheel over it) // crestReach: m over a road that still goes on and still pulls the car back // agree: cos of the wheels' normal ↔ the road's up (~20°)
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
  // `hold` s after a touchdown the car does not leave the surface. THE LANDING SETTLES THE ROLL (user, 2026-10-29: "we
  // need something to smooth the roll when landing — very often the car doesn't land perfectly right … that's how
  // Apex Rush works"): after `minAir` s of flight, for `roll` s from the first touch, the car's sideways tilt is
  // turned onto the road at `rollRate` /s and the wheels' kicks spin it only `spin` of what they would (no rocking
  // onto one wheel). PITCH stays the car's (rear first, the nose slams down), and so do its speed and springs. Not past
  // `maxDeg` of tilt: that is a crash.
  land: { hold: 0.5, minAir: 0.35, roll: 0.35, rollRate: 12, spin: 0.25, maxDeg: 45 },
  // A CRASH (_crashSolve): from `speed` m/s into a solid (a scrape along a rail stays under it: the corkscrew's press
  // peaked at 14.2), the hit bounces back `restitution` of it and may spin the car up to `maxSpin` rad/s
  // `loose` s after a crash the steering doesn't set the turn rate and the car sits flat on the road gently: the
  // hit's spin and tilt play out (the turn-rate control stopped a 5 rad/s corner-hit spin in one step)
  crash: { speed: 18, restitution: 0.25, maxSpin: 8, loose: 0.8, looseYawDecay: 1.5, looseAlign: 0.25 },
  // rad/s; /s to the asked rate; /s idle: stop; `follow` /s: with no pitch key the NOSE FOLLOWS THE FLIGHT (pitch only,
  // from the car's own velocity — never roll or yaw, never a ray: user 2026-10-23 "why doesn't the car go nose down when
  // falling … that's how it can land smoothly"; off a 45° ramp it flew nose-up and landed tail-first)
  // (follow ON again, 2026-10-29 — user: "in Apex Rush the car points nose down along the arc"; the old car does it too
  // since 10-23. Landing on FLAT ground off a big ramp it comes down nose-first: Thunderline's landings are shaped to
  // the arc. Your pitch keys override it)
  // `hold` /s: how fast a rotation stops once its key is released (3 let a spin run on ~40° — 9: it stops in ~0.15 s)
  air: { roll: 3.6, pitch: 2.8, yaw: 2.4, response: 8, hold: 9, follow: 2 },
  // THE LANDING MAGNET (user, 2026-10-29: "a small assist so the player doesn't have to do his barrel or spin perfectly
  // to land perfectly — not so big he feels it controls the car"): with NO air key held, a car already within
  // `rollDeg` of the landing surface's tilt (the road under the flight ahead; open ground: level) rolls onto it, and
  // within `yawDeg` of the flight's direction turns to face it — at `rate` /s of the angle left, never past `max`
  // rad/s (a slow ease, never a snap). Further off: nothing (a real miss stays one).
  magnet: { rollDeg: 35, yawDeg: 30, rate: 2.2, max: 1.2, ahead: 0.4 },
};

const G = 9.81, DEG = Math.PI / 180;
const _com = new THREE.Vector3(), _n = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3();
const _up = new THREE.Vector3(), _tmp = new THREE.Vector3(), _axis = new THREE.Vector3(), _F = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _w = new THREE.Vector3(), _roadUp = new THREE.Vector3(), _rel = new THREE.Vector3();
const _aP = new THREE.Vector3(), _aU = new THREE.Vector3(), _aF = new THREE.Vector3(), _aN = new THREE.Vector3();
const _bInv = new THREE.Matrix4(), _bRootQ = new THREE.Quaternion(), _bQ = new THREE.Quaternion(), _bP = new THREE.Vector3(), _bA = new THREE.Vector3(), _bY = new THREE.Vector3(0, 1, 0);
const bump = { pen: 0, n: new THREE.Vector3() };
// THE BODY'S CONTACTS (_bodyContact): m of skin, the bounce (and from what speed), friction, passes, the push out
const BODY = { skin: 0.02, restitution: 0.2, bounceMin: 3, friction: 0.45, iterations: 8, slop: 0.01, correct: 0.6, settle: 3 };
const _contacts = Object.assign([], { pool: [] });
const _cw = new THREE.Vector3(), _cn = new THREE.Vector3(), _bn = new THREE.Vector3(), _pv = new THREE.Vector3(), _pj = new THREE.Vector3();

export class ArcadeCar extends StuntCar {
  constructor(opts) {
    super(opts);
    this.isArcadeCar = true;
    this._landHold = 0;
    this._crashT = 0; // s left of a crash's loose time (_crashSolve)
    this._landRollT = 0; // s left of a landing's roll settle (ARCADE.land)
    this._rollKey = 0; // the roll key as pressed (tick)
    this._visDrop = 0; // m the body is drawn lowered onto its wheels (syncVisuals)
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
  // THE ROLL KEY AS PRESSED (the old car smooths it: 90 % in 0.48 s, and as slowly back — released at 30° of roll
  // the car went on to 59°: user, 2026-10-29, "the player shouldn't have to do his barrel perfectly")
  tick(controls) {
    this._rollKey = controls && "rollTarget" in controls ? (controls.rollTarget ?? 0) : (this.input?.airSteer ?? 0);
    super.tick(controls);
  }
  // THE BODY ON ITS WHEELS (user, 2026-10-29: "the wheels and the chassis have a gap … it shows even more in the
  // shadows; in real life there's no big gap between wheels and chassis"): this car's springs hold the hub 0.47 m off
  // the road for a 0.37 m tyre, so the wheel hung ~10 cm under its arch. The BODY is drawn lowered by the gap of its
  // most compressed wheel (up to `ride.visualDrop`), eased: the tyres sit in the arches. Drawing only — physics,
  // collisions and the shadow proxy's place in the physics are unchanged.
  syncVisuals(dt, alpha) {
    super.syncVisuals(dt, alpha);
    let ext = Infinity;
    for (const t of this.tires) if (t.grounded && t.visualExt !== undefined) ext = Math.min(ext, t.visualExt);
    const want = THREE.MathUtils.clamp(ext === Infinity ? ARCADE.ride.visualDrop : ext - 0.01, 0, ARCADE.ride.visualDrop);
    this._visDrop += (want - this._visDrop) * (1 - Math.exp(-12 * Math.max(dt, 0)));
    if (this._visDrop > 0) this.chassisMesh.position.addScaledVector(_aU.set(0, -1, 0).applyQuaternion(this._renderQuat ?? this.body.quat), this._visDrop);
    this._placeBrakes();
  }
  /** Each brake (disc + caliper, thunderCar.js userData.brakes) at its wheel's centre, turned with its steering — not
   *  spun, not left on the body when the suspension moves the wheel */
  _placeBrakes() {
    const glb = this._chassisGlb, list = glb?.userData.brakes, root = glb?.userData.root;
    if (!list?.length || !root || !this.tireGroups?.length) return;
    this.group.updateMatrixWorld(true);
    root.updateWorldMatrix(true, false);
    _bInv.copy(root.matrixWorld).invert();
    _bRootQ.setFromRotationMatrix(root.matrixWorld).invert();
    if (!this._brakeMap) {
      // each brake's wheel: the tyre whose centre is nearest it now; its axle's rest heading (steering 0 at spawn)
      this._brakeMap = list.map((br) => {
        let best = 0, bd = Infinity;
        this.tireGroups.forEach((g, i) => { const d = g.getWorldPosition(_bP).applyMatrix4(_bInv).distanceToSquared(br.obj.position); if (d < bd) { bd = d; best = i; } });
        return { br, i: best, rest: null };
      });
    }
    for (const m of this._brakeMap) {
      const g = this.tireGroups[m.i];
      const centre = g.getWorldPosition(_bP).applyMatrix4(_bInv);
      // the steering: the wheel's axle heading in the root's frame, against its heading at rest
      const axle = _bA.set(1, 0, 0).applyQuaternion(g.getWorldQuaternion(_bQ)).applyQuaternion(_bRootQ);
      const yaw = Math.atan2(-axle.z, axle.x);
      m.rest ??= yaw;
      const steer = WHEEL_LOCAL[m.i]?.steer ? yaw - m.rest : 0;
      _bQ.setFromAxisAngle(_bY, steer);
      m.br.obj.position.copy(m.br.offset).applyQuaternion(_bQ).add(centre);
      m.br.obj.quaternion.copy(_bQ).multiply(m.br.quat);
    }
  }
  respawn() { this._landHold = 0; this._landRollT = 0; this._crashT = 0; this._sinceWheels = 9; this._ff?.set(0, 0, 0); this._prevRoadUp = null; return super.respawn(); }
  respawnAt(pos, quat) { this._landHold = 0; this._landRollT = 0; this._crashT = 0; this._sinceWheels = 9; this._ff?.set(0, 0, 0); this._prevRoadUp = null; return super.respawnAt(pos, quat); }

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
        // A WHEEL TOUCHES ONLY WHAT IS UNDER THE CAR: a hit below the hub, along the car's own up. On its roof, the probes found the floor too, and the springs — pushing along the car's
        // up, straight DOWN on a car on its lid — drove it into the floor and pinned it there (user, 2026-10-29: "if the
        // car falls on its roof it's jittering")
        // (by WHERE the hit is — the road's triangles are wound either way, their normals can't tell)
        if (_tmp.subVectors(t.worldPos, probe.point).dot(_up) < -0.1) { t._clearContact(); continue; }
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
      // a TOUCHDOWN after a flight: the roll settles for land.roll s (see ARCADE.land)
      if (down && this._sinceWheels >= ARCADE.land.minAir) this._landRollT = ARCADE.land.roll;
      if (down) { _n.normalize(); this._sinceWheels = 0; } else this._sinceWheels += subDt;
      const landing = this._landRollT > 0;

      // ---- THE TRACK FRAME: the road's own up under the car (known, not guessed), and whether the car is on it
      const tr = this.trackAt?.(body.pos) ?? null;
      // near the road = over its deck (the ride's line is 0.7 m over it), anywhere across it (wide pieces: 24 m)
      let roadNear = false;
      if (tr) {
        _roadUp.copy(tr.U);
        const along = _rel.subVectors(body.pos, tr.P).dot(tr.U), across = Math.sqrt(Math.max(0, _rel.lengthSq() - along * along));
        // (across: within THAT road's width, + a margin — "26 m" for every road made a car on the floor BESIDE a kicker
        // take the ramp's slope as its ground and tip up 14°: user, 2026-10-29, "it climbs something invisible")
        roadNear = along > -1.5 && along < ARCADE.road.reach + 1 && across < (tr.hw ?? 12) + ARCADE.road.edge;
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
      this.arcade.pressed = pressed; this.arcade.ahead = this._dbgAhead;
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
      if (landing) { this._settleRoll(subDt, surf); this._landRollT -= subDt; }
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
          const as = landing ? ARCADE.land.spin : 1; // (landing: the kick barely spins the car — the settle turns it)
          const j = -vn / body.effectiveInvMass(_r, t._rawNormal, as);
          body.applyImpulseAtPoint(_F.copy(t._rawNormal).multiplyScalar(j), t.hitPoint, as);
        }
      }
      // ---- the old car's collisions with rails / walls / props; the BODY against the road and the floor its own
      if (SOLID.enabled) this._crashSolve(() => this._resolveSolids(subDt));
      const touching = this._bodyContact(subDt);
      if (this._crashT > 0) this._crashT -= subDt;
      // a car on its lid or side (body down, no wheel): it settles — its spin and slide die out, it doesn't buzz
      if (touching && !down) {
        const k = Math.exp(-BODY.settle * subDt);
        body.angVel.multiplyScalar(k);
      }
      body.integrate(subDt);
      const wMax = TIRE.maxAngVel;
      if (body.angVel.lengthSq() > wMax * wMax) body.angVel.setLength(wMax);
      this.arcade.onRoad = onRoad; this.arcade.stunt = stunt;
    }
  }

  /** The landing's roll settle: the tilt about the car's own forward turned onto `surf` (ARCADE.land) */
  _settleRoll(dt, surf) {
    const body = this.body, L = ARCADE.land;
    _up.set(0, 1, 0).applyQuaternion(body.quat);
    if (_up.dot(surf) < Math.cos(L.maxDeg * DEG)) { this._landRollT = 0; return; } // (a crash, not a landing)
    _tmp.set(0, 0, 1).applyQuaternion(body.quat);
    const rollErr = Math.atan2(_axis.crossVectors(_tmp, _up).dot(surf), _up.dot(surf)); // (signed: which way it leans)
    _qi.copy(body.quat).invert();
    const local = _w.copy(body.angVel).applyQuaternion(_qi);
    local.z = rollErr * L.rollRate; // (the roll rate the settle wants — whatever the wheels kicked in)
    body.angVel.copy(local.applyQuaternion(body.quat));
  }

  /** Is there road under where the car will be in 0.15 s? (no: it is leaving a lip — a take-off, not a crest) */
  _roadAhead(body) {
    const ahead = _rel.copy(body.pos).addScaledVector(body.vel, 0.15);
    const tr = this.trackAt?.(ahead);
    if (!tr || tr.end) { this._dbgAhead = tr ? "end" : "none"; this.trackAt(body.pos); return false; }
    // (the road GOES ON there: a crest's road falls away under the car — "too far above it" called that a lip, and
    // at 200 km/h the slope-down piece threw the car 120 m: user's Tilted landing test, 2026-10-29. Only how far
    // ABOVE the road counts as a flight: past a few metres the car really has left it)
    const rel = ahead.sub(tr.P), along = rel.dot(tr.U), across = Math.sqrt(Math.max(0, rel.lengthSq() - along * along));
    this.trackAt(body.pos); // (back to where the car is: trackAt searches round its last match)
    this._dbgAhead = `${along.toFixed(1)}/${across.toFixed(1)}`;
    return along > -1.5 && along < ARCADE.road.crestReach && across < (tr.hw ?? 12) + ARCADE.road.edge;
  }

  /**
   * THE BODY AGAINST THE ROAD AND THE FLOOR (user, 2026-10-29: "if the car falls on its roof it's jittering … make
   * better realistic collisions"). The old car's body contact is PENALTY SPRINGS (220 kN/m on the deck, 180 on the
   * floor) wrapped in roof guards and crash states run by the old car's own step: on its lid the arcade car sank
   * through the floor and was thrown about at 100 m/s, or froze under a road. Here, the games' way (sequential
   * impulses, Box2D / Bullet): every body sample inside the surface is a CONTACT; a few passes stop each one's
   * speed into the surface (a little bounce on a hard hit only), with scraping friction bounded by its push, and the
   * body is moved out of the deepest one. Returns the number of contacts.
   */
  _bodyContact(dt) {
    const body = this.body, C = _contacts;
    C.length = 0;
    for (const lp of this.DECK_CONTACT_POINTS) {
      this._geomToWorld(lp, _cw);
      let sd = Infinity;
      if (DECK.enabled && this.groundBvh?.baked) {
        const res = this.groundBvh.closestPointWithNormal(_cw.x, _cw.y, _cw.z, 0.8, _cn);
        if (res) {
          const d = (_cw.x - res.x) * _cn.x + (_cw.y - res.y) * _cn.y + (_cw.z - res.z) * _cn.z;
          if (d < BODY.skin && d > -0.6) { sd = d; _bn.copy(_cn); }
        }
      }
      const fy = this.getFloorY?.(_cw.x, _cw.z);
      if (Number.isFinite(fy) && _cw.y - fy < BODY.skin && _cw.y - fy < sd) { sd = _cw.y - fy; _bn.set(0, 1, 0); }
      if (sd === Infinity) continue;
      const c = (C.pool[C.length] ??= { p: new THREE.Vector3(), n: new THREE.Vector3(), r: new THREE.Vector3(), t: new THREE.Vector3() });
      c.p.copy(_cw); c.n.copy(_bn); c.r.subVectors(_cw, body.pos); c.pen = BODY.skin - sd; c.jn = 0; c.jt = 0;
      C.push(c);
    }
    if (!C.length) return 0;
    for (const c of C) {
      const vn = _pv.crossVectors(body.angVel, c.r).add(body.vel).dot(c.n);
      if (-vn > 3) this.arcade.bodyHit = Math.max(this.arcade.bodyHit ?? 0, -vn); // (the sound: the body striking the ground)
      c.target = vn < -BODY.bounceMin ? -BODY.restitution * vn : 0; // (a bounce only off a real hit)
      c.mn = body.effectiveInvMass(c.r, c.n);
    }
    for (let it = 0; it < BODY.iterations; it++) for (const c of C) {
      c.r.subVectors(c.p, body.pos);
      _pv.crossVectors(body.angVel, c.r).add(body.vel);
      const vn = _pv.dot(c.n);
      const jn = Math.max(0, c.jn + (c.target - vn) / c.mn), dj = jn - c.jn;
      c.jn = jn;
      if (dj) body.applyImpulseAtPoint(_pj.copy(c.n).multiplyScalar(dj), c.p);
      // friction: the sliding part of the point's speed, stopped up to μ × its push
      _pv.crossVectors(body.angVel, c.r).add(body.vel);
      c.t.copy(_pv).addScaledVector(c.n, -_pv.dot(c.n));
      const vt = c.t.length();
      if (vt < 1e-4) continue;
      c.t.multiplyScalar(1 / vt);
      const want = vt / body.effectiveInvMass(c.r, c.t), room = BODY.friction * c.jn - c.jt;
      const jt = Math.min(want, Math.max(0, room));
      if (jt > 0) { c.jt += jt; body.applyImpulseAtPoint(_pj.copy(c.t).multiplyScalar(-jt), c.p); }
    }
    // out of the deepest contact (positions only: no speed added — the old projection's "pop")
    let deep = null;
    for (const c of C) if (!deep || c.pen > deep.pen) deep = c;
    if (deep.pen > BODY.slop) body.pos.addScaledVector(deep.n, (deep.pen - BODY.slop) * BODY.correct);
    this.arcade.contacts = C.length; this.arcade.deepest = deep.pen; // (the lab's telemetry, the tests)
    return C.length;
  }

  /**
   * A REAL HIT IS A CRASH (user, 2026-10-29: "more realistic crashes"; measured: 150 km/h head-on into a concrete
   * block stopped the car dead — no rebound, no pitch, no spin). The old car's solid contact is impulses with spin,
   * but Thunderline turned its crash threshold OFF (a rail never tumbles the car: carTune railCrashSpeed) — every hit
   * was a scrape, bounce 0.05, spin capped at 2.5 rad/s. For this car, during its solve only: a scrape stays a scrape
   * (a rail glanced off keeps its speed), and from `crash.speed` m/s into a solid the hit bounces and spins.
   */
  _crashSolve(solve) {
    const C = ARCADE.crash, keep = [CRASH.wallSpeed, CRASH.restitution, CRASH.maxSpin];
    CRASH.wallSpeed = C.speed; CRASH.restitution = C.restitution; CRASH.maxSpin = C.maxSpin;
    this._crashYield = 0;
    try { solve(); } finally { [CRASH.wallSpeed, CRASH.restitution, CRASH.maxSpin] = keep; }
    // (the old contact arms ITS crash timer on a real hit — the old car's step counts it down, not this one: the car's
    // own timer instead, and the old one cleared so nothing of the old car's reads it)
    if (this._crashYield > 0) {
      if (this._crashT <= 0) this.arcade.crashHit = Math.max(this.arcade.crashHit ?? 0, this._solidImpactSpeed ?? C.speed); // (the sound: one per crash)
      this._crashT = C.loose; this._crashYield = 0;
    }
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
    // (after a crash: the spin it was given winds down; the steering takes over again after crash.loose s)
    const loose = this._crashT > 0, Cr = ARCADE.crash;
    const yaw = loose ? cur * Math.exp(-Cr.looseYawDecay * dt) : cur + (want - cur) * (1 - Math.exp(-S.response * dt));
    // the up onto the surface: both axes on ≥ 2 wheels; on the roll axis only with the body on the road (no wheels)
    _up.set(0, 1, 0).applyQuaternion(body.quat);
    _w.set(0, 0, 0);
    if (down >= 2) {
      _axis.crossVectors(_up, surf);
      const s = _axis.length(), ang = Math.atan2(s, _up.dot(surf));
      if (s > 1e-6) _w.copy(_axis.multiplyScalar(1 / s)).multiplyScalar(Math.min(ARCADE.align.max, ang * ARCADE.align.rate * (loose ? Cr.looseAlign : 1)));
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
    const want = _tmp.set(-inP * A.pitch, (this.input.yaw ?? 0) * A.yaw, -this._rollKey * A.roll);
    _qi.copy(body.quat).invert();
    let follow = false;
    // (none while ANY air key is held, nor on a car rolled past ~35° — its "pitch" axis is then tilted, and the nose
    // follow mixed a sideways turn into the player's roll: user, 2026-10-29, "it's not only rolling, it does another
    // movement")
    const keys = inP !== 0 || (this.input.yaw ?? 0) !== 0 || this._rollKey !== 0;
    const side = _tmp.set(1, 0, 0).applyQuaternion(body.quat), upY = _w.set(0, 1, 0).applyQuaternion(body.quat).y;
    const level = !keys && Math.abs(side.y) < Math.sin(35 * DEG) && upY > 0;
    _tmp.set(-inP * A.pitch, (this.input.yaw ?? 0) * A.yaw, -this._rollKey * A.roll); // (the asked rates again: _tmp was borrowed)
    if (level && A.follow > 0 && body.vel.lengthSq() > 25) {
      // the nose's slope against the flight's, in the WORLD (user, 2026-10-29: "Q/E was supposed to be only on one axis,
      // it does weird rotation": measured in the car's own frame, a car spun 90° to its flight read a 90° pitch error
      // and was flipped over at 160°/s) — and only while the nose points along the flight: off by 60° sideways, none
      const v = body.vel, vh = Math.hypot(v.x, v.z), nose = _axis.set(0, 0, 1).applyQuaternion(body.quat), nh = Math.hypot(nose.x, nose.z);
      const along = vh > 1 && nh > 0.2 ? (v.x * nose.x + v.z * nose.z) / (vh * nh) : 0; // cos of the sideways angle
      const w = THREE.MathUtils.clamp((along - 0.5) / 0.5, 0, 1);
      if (w > 0) {
        const err = Math.atan2(v.y, vh) - Math.atan2(nose.y, nh); // + = the flight climbs more than the nose
        want.x = THREE.MathUtils.clamp(-err * A.follow * w, -A.pitch, A.pitch);
        follow = true;
      }
    }
    // the LANDING MAGNET (ARCADE.magnet): keys released, close to clean → eased the rest of the way
    let magnet = false;
    const M = ARCADE.magnet;
    if (!keys && M.rate > 0) {
      const v = body.vel;
      // the surface it will land on: the road under the flight, a moment ahead (else level ground)
      const tr = this.trackAt?.(_aP.copy(body.pos).addScaledVector(v, M.ahead));
      if (tr && tr.d < 40 && !tr.end) _aU.copy(tr.U); else _aU.set(0, 1, 0);
      this.trackAt?.(body.pos);
      const up = _aF.set(0, 1, 0).applyQuaternion(body.quat), nose = _aN.set(0, 0, 1).applyQuaternion(body.quat);
      // roll: the lean about the nose, against that surface
      const rollErr = Math.atan2(_aP.crossVectors(nose, up).dot(_aU), up.dot(_aU));
      if (Math.abs(rollErr) < M.rollDeg * DEG && Math.abs(rollErr) > 0.5 * DEG && up.dot(_aU) > 0) {
        want.z = THREE.MathUtils.clamp(rollErr * M.rate, -M.max, M.max); magnet = true;
      }
      // spin: the nose against the flight, about the surface's up (in the surface's plane)
      _aP.copy(v).addScaledVector(_aU, -v.dot(_aU));
      const nf = _aF.copy(nose).addScaledVector(_aU, -nose.dot(_aU));
      if (_aP.lengthSq() > 25 && nf.lengthSq() > 0.04) {
        const yawErr = Math.atan2(_aN.crossVectors(nf, _aP).dot(_aU), nf.dot(_aP));
        this.arcade.yawErr = yawErr;
        if (Math.abs(yawErr) < M.yawDeg * DEG && Math.abs(yawErr) > 0.5 * DEG) { want.y = THREE.MathUtils.clamp(yawErr * M.rate, -M.max, M.max); magnet = true; }
      }
    }
    this.arcade.magnet = magnet;
    const local = _w.copy(body.angVel).applyQuaternion(_qi);
    for (const c of ["x", "y", "z"]) {
      const k = want[c] !== 0 || (follow && c === "x") ? A.response : A.hold;
      local[c] += (want[c] - local[c]) * (1 - Math.exp(-k * dt));
    }
    body.angVel.copy(local.applyQuaternion(body.quat));
  }
}
