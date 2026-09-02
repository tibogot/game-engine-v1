import * as THREE from "three";

/**
 * Best-lap ghost: record the car's chassis pose during a lap, then replay it as
 * a translucent car on later laps, synced to the live lap clock.
 *
 * Perf is intentionally tiny:
 *  - Recording = one sample (pos + quat) at 60 Hz (the live car interpolates a
 *    120 Hz body; 20 Hz linear keys kink at every sample — visible jitter on
 *    jumps, landings, and tight corners). A 15 s lap is ~900 samples (~20 KB
 *    packed). No GPU cost.
 *  - Playback = lerp/slerp between two samples + one extra mesh draw. Callers
 *    should sample at the RENDER clock (last tick + leftover alpha), not the
 *    discrete `run.currentTime`, or the ghost hitch-steps against the camera.
 *  - Persistence = compact rounded JSON (~40-60 KB / track) in localStorage.
 *
 * One instance owns BOTH the in-progress recording and the committed ghost, plus
 * a moving playback cursor so sampling is O(1) amortised (lap time is monotonic
 * within a lap and resets to 0 each lap, which we detect and rewind).
 */
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

export class GhostTrack {
  constructor({ sampleHz = 60, maxSeconds = 300 } = {}) {
    this.dtSample = 1 / sampleHz;
    /**
     * A HARD CEILING ON ONE RECORDING, because nothing else ends it.
     *
     * `record()` only runs while the run clock is running, and that clock only
     * stops on a finish or a respawn — so a player who crosses START and then
     * just drives around records for as long as they keep driving. At 60 Hz and
     * eight numbers a sample that is a plain JS array growing ~3.8 KB/s, for
     * ever, with no upper bound at all.
     *
     * Five minutes is far past any real lap on an arcade track. Past it the
     * recording STOPS and is marked spoiled, rather than being truncated:
     * a half-recorded ghost would replay a car that stops dead mid-track, which
     * is worse than having no ghost.
     */
    this.maxSamples = Math.max(2, Math.round(maxSeconds * sampleHz));
    // In-progress recording (plain arrays, cheap to push).
    this._recT = null;
    this._recP = null;
    this._recQ = null;
    this._recOverflow = false;
    // Committed ghost (packed typed arrays) + playback cursor.
    this.times = null; // Float32Array(n)
    this.pos = null; // Float32Array(n*3)
    this.quat = null; // Float32Array(n*4)
    this._cur = 0;
  }

  get hasGhost() {
    return !!this.times && this.times.length > 1;
  }
  get duration() {
    return this.hasGhost ? this.times[this.times.length - 1] : 0;
  }

  /** Begin recording a fresh lap. */
  beginLap() {
    this._recT = [];
    this._recP = [];
    this._recQ = [];
    this._recOverflow = false;
  }

  /** Sample the live car (call each frame while the lap clock runs). */
  record(lapT, pos, quat) {
    if (!this._recT || this._recOverflow) return;
    const n = this._recT.length;
    if (n >= this.maxSamples) {
      // Stop growing, and remember that this take is no longer a whole lap.
      this._recOverflow = true;
      return;
    }
    if (n === 0 || lapT - this._recT[n - 1] >= this.dtSample) {
      this._recT.push(lapT);
      this._recP.push(pos.x, pos.y, pos.z);
      // Keep consecutive quats in the same hemisphere so serialized ghosts do
      // not store a sign flip (Three's slerp already takes the short path).
      let qx = quat.x, qy = quat.y, qz = quat.z, qw = quat.w;
      if (this._recQ.length >= 4) {
        const k = this._recQ.length - 4;
        if (this._recQ[k] * qx + this._recQ[k + 1] * qy + this._recQ[k + 2] * qz + this._recQ[k + 3] * qw < 0) {
          qx = -qx; qy = -qy; qz = -qz; qw = -qw;
        }
      }
      this._recQ.push(qx, qy, qz, qw);
    }
  }

  /** Promote the in-progress recording to the active ghost (on a new best lap). */
  commit() {
    // An overflowed take is not a lap — see maxSamples.
    if (this._recOverflow) {
      this.discard();
      return false;
    }
    if (!this._recT || this._recT.length < 2) {
      this._recT = this._recP = this._recQ = null;
      return false;
    }
    this.times = Float32Array.from(this._recT);
    this.pos = Float32Array.from(this._recP);
    this.quat = Float32Array.from(this._recQ);
    this._recT = this._recP = this._recQ = null;
    this._cur = 0;
    return true;
  }

  /** Throw away the in-progress recording (lap wasn't a record). */
  discard() {
    this._recT = this._recP = this._recQ = null;
    this._recOverflow = false;
  }

  /** Drop the committed ghost too (e.g. on "clear record"). */
  clear() {
    this.times = this.pos = this.quat = null;
    this.discard();
  }

  /**
   * Read the ghost pose at lap time `t` into out vectors. Returns false if there
   * is no ghost. Clamps to the ends (so a slower live lap leaves the ghost parked
   * at the finish).
   */
  sampleAt(t, outPos, outQuat) {
    if (!this.hasGhost) return false;
    const T = this.times;
    const n = T.length;
    if (t <= T[0]) return this._read(0, outPos, outQuat);
    if (t >= T[n - 1]) return this._read(n - 1, outPos, outQuat);
    if (t < T[this._cur]) this._cur = 0; // lap reset → rewind cursor
    while (this._cur < n - 1 && T[this._cur + 1] <= t) this._cur++;
    const i = this._cur;
    const j = i + 1;
    const span = T[j] - T[i];
    const a = span > 1e-6 ? (t - T[i]) / span : 0;
    const P = this.pos;
    outPos.set(
      P[i * 3] + (P[j * 3] - P[i * 3]) * a,
      P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * a,
      P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * a,
    );
    _qa.fromArray(this.quat, i * 4);
    _qb.fromArray(this.quat, j * 4);
    outQuat.slerpQuaternions(_qa, _qb, a);
    return true;
  }

  _read(i, outPos, outQuat) {
    outPos.set(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    outQuat.fromArray(this.quat, i * 4);
    return true;
  }

  /** Compact, rounded JSON for localStorage (returns null if there's no ghost). */
  serialize() {
    if (!this.hasGhost) return null;
    const r3 = (x) => Math.round(x * 1000) / 1000; // mm / ms / quat
    return JSON.stringify({
      hz: Math.round(1 / this.dtSample),
      t: Array.from(this.times, r3),
      p: Array.from(this.pos, r3),
      q: Array.from(this.quat, r3),
    });
  }

  /** Load a serialized ghost. Returns true on success. */
  load(json) {
    try {
      const o = typeof json === "string" ? JSON.parse(json) : json;
      if (!o || !Array.isArray(o.t) || o.t.length < 2) return false;
      this.times = Float32Array.from(o.t);
      this.pos = Float32Array.from(o.p);
      this.quat = Float32Array.from(o.q);
      this._cur = 0;
      return true;
    } catch (e) {
      return false;
    }
  }
}

/**
 * Translucent lap-ghost mesh. Boots as a box so a record can play before the
 * chassis GLB bakes; roadGame then swaps `mesh.geometry` to the shared
 * silhouette (body + rest-pose wheels, one draw). Pose is chassis-anchor space,
 * same as GhostTrack's samples — no extra spawn lift.
 */
export function createGhostMesh(width, height, length, color = 0x66ccff) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, length),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      // 0.32 read as a second solid car (unlit cyan + overlapping wheel/body
      // tris). 0.20 is still a clear silhouette without competing with the live car.
      opacity: 0.20,
      depthWrite: false,
    }),
  );
  mesh.name = "GhostCar";
  mesh.renderOrder = 2;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.visible = false;
  return mesh;
}
