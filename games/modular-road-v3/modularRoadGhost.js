import * as THREE from "three";

/**
 * Best-lap ghost: record the car's chassis pose during a lap, then replay it as
 * a translucent car on later laps, synced to the live lap clock.
 *
 * Perf is intentionally tiny:
 *  - Recording = one sample (pos + quat) at a fixed low rate (default 20 Hz);
 *    a 15 s lap is ~300 samples (~7 KB packed). No GPU cost.
 *  - Playback = lerp/slerp between two samples + one extra mesh draw.
 *  - Persistence = compact rounded JSON (~20-30 KB / track) in localStorage.
 *
 * One instance owns BOTH the in-progress recording and the committed ghost, plus
 * a moving playback cursor so sampling is O(1) amortised (lap time is monotonic
 * within a lap and resets to 0 each lap, which we detect and rewind).
 */
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

export class GhostTrack {
  constructor({ sampleHz = 20 } = {}) {
    this.dtSample = 1 / sampleHz;
    // In-progress recording (plain arrays, cheap to push).
    this._recT = null;
    this._recP = null;
    this._recQ = null;
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
  }

  /** Sample the live car (call each frame while the lap clock runs). */
  record(lapT, pos, quat) {
    if (!this._recT) return;
    const n = this._recT.length;
    if (n === 0 || lapT - this._recT[n - 1] >= this.dtSample) {
      this._recT.push(lapT);
      this._recP.push(pos.x, pos.y, pos.z);
      this._recQ.push(quat.x, quat.y, quat.z, quat.w);
    }
  }

  /** Promote the in-progress recording to the active ghost (on a new best lap). */
  commit() {
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
    const r2 = (x) => Math.round(x * 100) / 100; // cm
    const r3 = (x) => Math.round(x * 1000) / 1000; // ms / quat
    return JSON.stringify({
      hz: Math.round(1 / this.dtSample),
      t: Array.from(this.times, r3),
      p: Array.from(this.pos, r2),
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

/** A translucent stand-in car for the ghost (same box as the chassis visual). */
export function createGhostMesh(width, height, length, color = 0x66ccff) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, length),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.32,
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
