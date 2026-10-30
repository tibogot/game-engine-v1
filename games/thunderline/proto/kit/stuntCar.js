// THE STUNT CAR (games/thunderline/PHYSICS_PLAN.md; user, 2026-10-28: "very hard to land on the rotated pieces … in
// Apex Rush it's part of the game … any time we want a good landing we have to be well centred before the jump …
// rethink the physics", and "keep the old car's physics so we don't touch the old one, build a new one so we can
// compare side by side").
//
// The old car (v3/play/modularRoadVehicle.js) is INHERITED, not edited: its tyres, collisions, loops, tubes, walls,
// rails, the model and the lights stay what they are. This car changes what happens AROUND the air — never in it
// (no air steering: rejected 2026-10-23, "completely unnatural"):
//   - THE RAMP GUIDES THE TAKE-OFF: as the wheels leave a ramp, the car's heading is drawn onto the road's own
//     direction there (≤ STUNT.takeoff.maxDeg) — a car a few degrees crooked on the ramp flies straight, as if the
//     ramp were a groove. Measured before (10-23): 1° crooked = 3 m off at the landing, 2° fell off 1 time in 3.
//   - THE LANDING CATCHES THE CAR: touching down roughly lined up with the surface (≤ STUNT.catch.maxDeg), the speed
//     INTO the surface goes (no bounce), the speed ALONG it stays, and the car settles flat on it over
//     STUNT.catch.settle s. The landing judge (landing.js) still grades the touchdown as it came.
// Everything else is the old car, so a track drives the same up to the lip and after the landing.
import * as THREE from "three";
import { Vehicle, FIXED_DT } from "../../../../v3/play/modularRoadVehicle.js";

export const STUNT = {
  takeoff: {
    maxDeg: 8, // the most the heading is turned at a take-off (beyond that, the car meant it: left alone)
    minUp: 3, // m/s of upward speed as the wheels leave: a take-off, not a crest or falling off an edge
  },
  catch: {
    maxDeg: 35, // the car's up within this of the surface's normal = caught
    minAir: 0.35, // s of air before a touchdown is a landing
    settle: 0.15, // s to sit flat on the surface (and line up with the way it slides)
    alignYawDeg: 25, // the nose is lined up with the velocity along the surface when within this
  },
};

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3();
const _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export class StuntCar extends Vehicle {
  constructor(opts) {
    super(opts);
    this.isStuntCar = true;
    /** (pos) → the road's direction at pos (a unit Vector3), or null — set per run (driveSession / the builder) */
    this.roadDirAt = null;
    this._air = 0;
    this._wasDown = false;
    this._settle = null; // { up, t } while the car is being settled onto the surface it was caught by
    /** the last catch / guide, for the tests and the HUD */
    this.stuntEvents = { takeoffDeg: 0, caught: false };
  }

  _loaded() {
    let k = 0;
    _n.set(0, 0, 0);
    for (const t of this.tires) if (t.grounded && t.compression > 0) { k++; _n.add(t._rawNormal); }
    if (k) _n.normalize();
    return k;
  }

  respawn() { this._air = 0; this._wasDown = false; this._settle = null; return super.respawn(); }
  respawnAt(pos, quat) { this._air = 0; this._wasDown = false; this._settle = null; return super.respawnAt(pos, quat); }

  tick(controls) {
    if (!this.enabled) return;
    super.tick(controls);
    const down = this._loaded() > 0;
    if (this._wasDown && !down) this._guideTakeoff();
    if (!down) this._air += FIXED_DT;
    else {
      if (this._air >= STUNT.catch.minAir) this._catchLanding();
      this._air = 0;
    }
    if (this._settle) this._settleStep();
    this._wasDown = down;
  }

  /** the wheels just left the road: turn the flight onto the road's own direction, if the car was close to it */
  _guideTakeoff() {
    const body = this.body;
    if (!this.roadDirAt || body.vel.y < STUNT.takeoff.minUp) return;
    const dir = this.roadDirAt(body.pos);
    if (!dir) return;
    const hv = Math.hypot(body.vel.x, body.vel.z), hd = Math.hypot(dir.x, dir.z);
    if (hv < 5 || hd < 0.2) return;
    const a = Math.atan2(body.vel.x, body.vel.z), b = Math.atan2(dir.x, dir.z);
    const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    if (Math.abs(d) > STUNT.takeoff.maxDeg * THREE.MathUtils.DEG2RAD || Math.abs(d) < 1e-4) return;
    // the velocity, the body and its spin turned together about world up: the car flies as if it had left straight
    _q.setFromAxisAngle(UP, d);
    body.vel.applyQuaternion(_q);
    body.quat.premultiply(_q);
    body.angVel.applyQuaternion(_q);
    this.stuntEvents.takeoffDeg = d * THREE.MathUtils.RAD2DEG;
  }

  /** first touchdown after a flight: if lined up enough, no bounce, the speed kept along the surface */
  _catchLanding() {
    const body = this.body;
    _u.set(0, 1, 0).applyQuaternion(body.quat);
    const err = Math.acos(THREE.MathUtils.clamp(_u.dot(_n), -1, 1)) * THREE.MathUtils.RAD2DEG;
    this.stuntEvents.caught = err <= STUNT.catch.maxDeg;
    if (!this.stuntEvents.caught) return;
    const speed = body.vel.length();
    const into = body.vel.dot(_n);
    if (into < 0) body.vel.addScaledVector(_n, -into); // what drove it into the surface: gone
    if (body.vel.lengthSq() > 1e-6) body.vel.setLength(speed); // …and the speed carried along it
    body.angVel.multiplyScalar(0.3); // the flight's spin mostly absorbed
    this._settle = { up: _n.clone(), t: STUNT.catch.settle };
  }

  /** sit the car flat on the surface it was caught by (and line its nose up with its slide, if close) */
  _settleStep() {
    const body = this.body, s = this._settle;
    s.t -= FIXED_DT;
    if (s.t <= 0 || !this.tires.some((t) => t.grounded)) { this._settle = null; return; }
    // target: up = the surface normal; forward = the velocity along the surface if within alignYawDeg of the nose,
    // else the nose itself, flattened onto the surface
    _f.set(0, 0, 1).applyQuaternion(body.quat).addScaledVector(s.up, -_f.dot(s.up)).normalize();
    _v.copy(body.vel).addScaledVector(s.up, -body.vel.dot(s.up));
    if (_v.lengthSq() > 1 && _v.normalize().dot(_f) > Math.cos(STUNT.catch.alignYawDeg * THREE.MathUtils.DEG2RAD)) _f.copy(_v);
    const right = new THREE.Vector3().crossVectors(s.up, _f).normalize();
    _m.makeBasis(right, s.up, new THREE.Vector3().crossVectors(right, s.up));
    _q.setFromRotationMatrix(_m);
    const k = 1 - Math.exp(-FIXED_DT / (STUNT.catch.settle / 3));
    body.quat.slerp(_q, k).normalize();
    // the spin that would fight the settle: only the turn about the surface normal (steering) is kept
    const yawRate = body.angVel.dot(s.up);
    body.angVel.multiplyScalar(1 - k).addScaledVector(s.up, yawRate * k);
  }
}

/**
 * THE TRACK FRAME at a point (the arcade car, PHYSICS_PLAN.md: "use what we KNOW, not what a ray guesses"): the
 * nearest point of the road's centre line — { P, T (forward), U (the road's up), d (m from it) } or null. Searched
 * around the last match first (called every physics step), the whole ride only when that is far.
 */
export function trackFromRide(ride) {
  // THE FRAME FOLLOWS THE ROAD'S MIDDLE AS IT CLIMBS (user, 2026-10-29: "a banked-in shape — the car behaved very
  // weirdly"): a bank rolls the deck about its edge, so the middle climbs ~5° and levels again, but a ride point's T and
  // U are its ring's, without that climb — the car held to U ran nose into the rising deck, the rear wheels in the air.
  // T: the middle's own direction (from its neighbours, along the road); U: square to it, the roll kept.
  // (a JOIN between two pieces is the same point twice — a zero step read as "no road on from here": every join was
  // taken for a lip, and the road glue let go at it. One of each kept.)
  // (…and a piece's LAST ring a few dm from the next piece's first — 0.4 m after a 16 m step at a banked turn's end:
  // the T from its neighbours then read the middle of the turn behind, the frame tipped 1.2° within 0.4 m and the car was
  // jolted at every bank out — user, 2026-10-30, "it's shifting the car in one short instant". Under 1 m across a join,
  // the next piece's point goes.)
  // (the gaps: a piece starting > 2 m from where the one before it ended — marked before the joins are thinned below)
  ride.forEach((r, i) => { const q = ride[i - 1]; if (q && !r.air && (q.air || ((r.piece ?? r.uid) !== undefined && (r.piece ?? r.uid) !== (q.piece ?? q.uid) && q.P.distanceToSquared(r.P) > 4))) r._gapBefore = true; }); // (…and a hole INSIDE a piece — the Gap jump's: road after flight points; read as road, the glue pulled the car into it at the lip)
  const src = ride.filter((r) => !r.air && r.U).filter((r, i, all) => {
    if (i === 0) return true;
    const d2 = all[i - 1].P.distanceToSquared(r.P);
    return d2 > 1e-4 && !(d2 < 1 && (r.piece ?? r.uid) !== (all[i - 1].piece ?? all[i - 1].uid) && all[i + 1]);
  });
  const pts = src.map((r, i) => {
    const a = src[i - 1], c = src[i + 1];
    const A = a && isRoad(a, r, _v.subVectors(r.P, a.P), _v.lengthSq()) ? a : r, C = c && isRoad(r, c, _v.subVectors(c.P, r.P), _v.lengthSq()) ? c : r;
    if (A === C) return r;
    const T = new THREE.Vector3().subVectors(C.P, A.P).normalize();
    const side = new THREE.Vector3().crossVectors(r.U, T).normalize(); // (the road's sideways, from its roll)
    const U = new THREE.Vector3().crossVectors(T, side).normalize();
    return { ...r, T, U };
  });
  let last = 0;
  const near = (pos, from, to) => {
    let best = -1, bd = Infinity;
    for (let i = Math.max(0, from); i < Math.min(pts.length, to); i++) {
      const d = pts[i].P.distanceToSquared(pos);
      if (d < bd) { bd = d; best = i; }
    }
    return { best, bd };
  };
  return (pos) => {
    if (!pts.length) return null;
    let { best, bd } = near(pos, last - 40, last + 40);
    if (bd > 15 * 15) ({ best, bd } = near(pos, 0, pts.length));
    if (best < 0) return null;
    last = best;
    // INTERPOLATED between the two ride points around the car (the nearest point alone stepped every ~1 m: the arcade
    // car turns with the road's rotation, measured from this — steps were spikes)
    const r = pts[best];
    for (const j of [best + 1, best - 1]) {
      const q = pts[j];
      if (!q) continue;
      const a = j > best ? r : q, c = j > best ? q : r;
      const seg = _v.subVectors(c.P, a.P), L2 = seg.lengthSq();
      if (L2 < 1e-9 || !isRoad(a, c, seg, L2)) continue;
      const u = _f.subVectors(pos, a.P).dot(seg) / L2;
      if (u < 0 || u > 1) continue;
      const P = a.P.clone().lerp(c.P, u), T = a.T.clone().lerp(c.T, u).normalize(), U = a.U.clone().lerp(c.U, u).normalize();
      return { P, T, U, d: P.distanceTo(pos), hw: r.hw ?? 12, id: r.id };
    }
    // past the END of a stretch of road (a lip: no road segment on from here, the car beyond it along the road)
    const next = pts[best + 1];
    const end = (!next || !isRoad(r, next, _v.subVectors(next.P, r.P), _v.lengthSq())) && _f.subVectors(pos, r.P).dot(r.T) > 0.5;
    // …and BEFORE THE START of one (the landing across a gap, the car still short of it): not over its deck — read as
    // "near the road", the glue pulled a car 13 m short of the landing down at 3.5 g and it hit the deck's front edge
    const prev = pts[best - 1];
    const start = (!prev || !isRoad(prev, r, _v.subVectors(r.P, prev.P), _v.lengthSq())) && _f.subVectors(pos, r.P).dot(r.T) < -0.5;
    return { P: r.P, T: r.T, U: r.U, d: Math.sqrt(bd), end, start, hw: r.hw ?? 12, id: r.id }; // id: the piece; hw: the road's half width there
  };
}
// Two ride points are joined by ROAD when the chord between them runs along both their directions (within ~15°) —
// not a jump's flight (a lip to its landing: the ride's next point, but no road between)
const COS15 = Math.cos(15 * Math.PI / 180);
// (A GAP between two pieces is never road, however straight: a road ended, a gap, the next road 40 m on and 4 m lower read
// as one gentle slope — the glue pulled the car down onto it, the nose followed it, the car fell under the landing,
// user 2026-10-30 "instead of landing on it, it's putting its nose very down". Pieces that join sit within centimetres.)
function isRoad(a, c, seg, L2) {
  if (c._gapBefore) return false; // (marked by trackFromRide on the ride as built, before its joins are thinned)
  const L = Math.sqrt(L2);
  return seg.dot(a.T) / L > COS15 && seg.dot(c.T) / L > COS15;
}
/** The road's direction at a point: the nearest ride point's tangent (a take-off happens rarely: a plain scan). */
export function roadDirFromRide(ride) {
  return (pos) => {
    let best = null, bd = Infinity;
    for (const r of ride) {
      if (r.air) continue;
      const d = r.P.distanceToSquared(pos);
      if (d < bd) { bd = d; best = r; }
    }
    return best && bd < 30 * 30 ? best.T : null;
  };
}
