import * as THREE from "three";
import { startNewLineDist, finishNewLineDist } from "./modularRoadKit.js";

/**
 * Sprint-course timing for drive mode.
 *
 * Course = rounded start (`start_new`) + rounded finish (`finish_new`) anywhere
 * in the track — they do NOT have to share a chain (jumps / N / snap-landing
 * put the finish on a later island). Optional `checkpoint_new` pieces sit
 * between them. Open start / finish pieces are ignored here — later circuit
 * / lap mode.
 *
 * Clock is simulation time: the page feeds FIXED_DT per physics tick, never
 * wall-clock. Slow-mo is then just `timeScale` on the accumulator; the HUD,
 * splits, and ghost stay locked to the world.
 *
 * Crossing is a forward plane-cross of ONLY the watched gate (plus the start
 * line while a run is live, so driving back through start retries). Lateral /
 * vertical windows keep a parallel piece from firing.
 *
 * Pure logic — never touches the vehicle. `update()` returns an event; the
 * page flashes HUD / records the ghost.
 */

const _v = new THREE.Vector3();
const _inPos = new THREE.Vector3();
const _outPos = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);

const START_ID = "start_new";
const FINISH_ID = "finish_new";
const CP_IDS = new Set(["checkpoint_new", "checkpoint"]);

const VERTICAL_WINDOW = 6; // metres off the gate plane's height

/** Format seconds as m:ss.mmm (or ss.mmm under a minute). */
export function formatRunTime(t) {
  if (!Number.isFinite(t)) return "--:--.---";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s.toFixed(3).padStart(6, "0");
  return m > 0 ? `${m}:${ss}` : ss;
}

/** @deprecated use formatRunTime */
export const formatLapTime = formatRunTime;

export class RunTracker {
  /** @param {{ roadWidth?: number }} [o] */
  constructor({ roadWidth = 16 } = {}) {
    this.defaultHalfWidth = roadWidth / 2 + 2;
    /** @type {Gate[]} */
    this.gates = [];
    this.startIndex = -1;
    this.finishIndex = -1;
    this.hasCourse = false;
    this.cpCount = 0;
    this.bestTime = NaN;
    this.bestSplits = null;
    this.subLabel = "";
    this.message = "";
    this.messageTimer = 0;
    this.reset();
  }

  /**
   * Rebuild gates from placed pieces. Call on entering drive mode.
   * @param {{id:string, chainId?:number, hw?:number, pp?:object, connectorIn:THREE.Matrix4, connectorOut:THREE.Matrix4}[]} pieces
   */
  buildGates(pieces) {
    this.gates.length = 0;
    this.startIndex = -1;
    this.finishIndex = -1;
    this.hasCourse = false;
    this.cpCount = 0;

    let startPiece = null;
    let finishPiece = null;
    const cps = [];
    for (let i = 0, n = pieces.length; i < n; i++) {
      const p = pieces[i];
      if (!startPiece && p.id === START_ID) startPiece = p;
      if (p.id === FINISH_ID) finishPiece = p; // last finish wins (the current end)
      else if (CP_IDS.has(p.id)) cps.push(p);
    }
    if (!startPiece || !finishPiece) {
      this.reset();
      return;
    }

    // Start → every CP (placement order, any chain) → finish. Chains are
    // islands (a jump is a new chain); the pieces array is the order the
    // course was built, which is the drive order.
    this.startIndex = 0;
    this.gates.push(makeGate(startPiece, "start", this.defaultHalfWidth));
    for (let i = 0; i < cps.length; i++) {
      this.gates.push(makeGate(cps[i], "checkpoint", this.defaultHalfWidth));
      this.cpCount++;
    }
    this.finishIndex = this.gates.length;
    this.gates.push(makeGate(finishPiece, "finish", this.defaultHalfWidth));

    this.hasCourse = this.startIndex >= 0 && this.finishIndex > this.startIndex;
    if (!this.hasCourse) {
      this.gates.length = 0;
      this.startIndex = -1;
      this.finishIndex = -1;
      this.cpCount = 0;
    }
    this.reset();
  }

  /** Full clear, including the in-memory best. Gates stay. */
  reset() {
    this.running = false;
    this.finished = false;
    this.currentTime = 0;
    this.passed = 0;
    this.nextIndex = this.hasCourse ? this.startIndex : -1;
    this.bestTime = NaN;
    this.bestSplits = null;
    this._splits = null;
    this.message = "";
    this.messageTimer = 0;
    this._resetSides();
    this._refreshSub();
  }

  /**
   * Back to armed without wiping the best / splits. R, void-respawn, or
   * driving through start again.
   */
  restart() {
    this.running = false;
    this.finished = false;
    this.currentTime = 0;
    this.passed = 0;
    this.nextIndex = this.hasCourse ? this.startIndex : -1;
    this._splits = null;
    this._resetSides();
    this._refreshSub();
  }

  applyStoredBest(t) {
    if (Number.isFinite(t)) this.bestTime = t;
    this._refreshSub();
  }

  applyStoredSplits(arr) {
    if (Array.isArray(arr) && arr.length) this.bestSplits = arr.slice();
  }

  clearBest() {
    this.bestTime = NaN;
    this.bestSplits = null;
    this._refreshSub();
  }

  /**
   * Stable id for the current course so a saved record only applies to the
   * same layout. 1 m / 0.01 rad resolution.
   */
  courseSignature() {
    if (!this.hasCourse) return "";
    const r = (n) => Math.round(n);
    let s = String(this.gates.length);
    for (let i = 0, n = this.gates.length; i < n; i++) {
      const g = this.gates[i];
      s += `|${g.role}:${r(g.pos.x)},${r(g.pos.y)},${r(g.pos.z)},${r(g.yaw * 100)}`;
    }
    return s;
  }

  /**
   * Advance one physics tick. `dt` MUST be the sim step (FIXED_DT), not wall dt.
   * @returns {null | {kind:"start"|"checkpoint"|"finish", gate:object, time:number, splitDelta?:number, isRecord?:boolean, prevBest?:number}}
   */
  update(dt, carPos, carVel) {
    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message = "";
    }
    if (!this.hasCourse) return null;
    if (this.running) this.currentTime += dt;

    // Retry: forward through start while a run is live or just finished.
    if (this.running || this.finished) {
      const start = this.gates[this.startIndex];
      if (this._crossed(start, carPos, carVel)) {
        this._beginRun();
        return { kind: "start", gate: start, time: 0 };
      }
    }
    if (this.finished) return null;

    const gate = this.gates[this.nextIndex];
    if (!gate || !this._crossed(gate, carPos, carVel)) return null;
    return this._onCross(gate);
  }

  _crossed(gate, carPos, carVel) {
    _v.copy(carPos).sub(gate.pos);
    const side = _v.dot(gate.fwd);
    const hit = gate._hasPrev
      && gate._prev < 0
      && side >= 0
      && Math.abs(_v.dot(gate.right)) <= gate.halfWidth
      && Math.abs(_v.y) <= VERTICAL_WINDOW
      && carVel.dot(gate.fwd) > 0;
    gate._prev = side;
    gate._hasPrev = true;
    return hit;
  }

  _onCross(gate) {
    if (gate.role === "start") {
      this._beginRun();
      return { kind: "start", gate, time: 0 };
    }
    const idx = this.nextIndex;
    if (gate.role === "checkpoint") {
      if (this._splits) this._splits[idx] = this.currentTime;
      let splitDelta = NaN;
      if (this.bestSplits && Number.isFinite(this.bestSplits[idx])) {
        splitDelta = this.currentTime - this.bestSplits[idx];
      }
      this.passed++;
      this.nextIndex = idx + 1;
      const next = this.gates[this.nextIndex];
      if (next) { next._hasPrev = false; next._prev = 0; }
      this._refreshSub();
      return { kind: "checkpoint", gate, time: this.currentTime, splitDelta, gateIndex: idx };
    }
    // Finish — only reachable as nextIndex, so every CP was hit.
    const time = this.currentTime;
    const prevBest = this.bestTime;
    const isRecord = !Number.isFinite(prevBest) || time < prevBest;
    this.running = false;
    this.finished = true;
    if (isRecord) {
      this.bestTime = time;
      this.bestSplits = this._splits ? this._splits.slice() : null;
      this._flash(`NEW BEST  ${formatRunTime(time)}`, 4);
    } else {
      this._flash(`FINISH  ${formatRunTime(time)}`, 4);
    }
    this._refreshSub();
    return { kind: "finish", gate, time, isRecord, prevBest };
  }

  _beginRun() {
    this.running = true;
    this.finished = false;
    this.currentTime = 0;
    this.passed = 0;
    this._splits = new Array(this.gates.length);
    for (let i = 0; i < this._splits.length; i++) this._splits[i] = NaN;
    this.nextIndex = this.startIndex + 1;
    this._resetSides();
    this._flash("GO!");
    this._refreshSub();
  }

  _resetSides() {
    for (let i = 0, n = this.gates.length; i < n; i++) {
      const g = this.gates[i];
      g._prev = 0;
      g._hasPrev = false;
    }
  }

  _flash(msg, secs = 2.6) {
    this.message = msg;
    this.messageTimer = secs;
  }

  _refreshSub() {
    if (!this.hasCourse) {
      this.subLabel = "";
      return;
    }
    const best = `Best ${formatRunTime(this.bestTime)}`;
    if (this.finished) {
      this.subLabel = `FINISHED  ·  ${best}`;
      return;
    }
    if (!this.running) {
      this.subLabel = this.cpCount > 0
        ? `Cross the START line  ·  ${this.cpCount} CP  ·  ${best}`
        : `Cross the START line  ·  ${best}`;
      return;
    }
    const next = this.gates[this.nextIndex];
    if (next && next.role === "checkpoint") {
      this.subLabel = `CP ${this.passed + 1}/${this.cpCount}  ·  ${best}`;
    } else {
      this.subLabel = `FINISH  ·  ${best}`;
    }
  }
}

/**
 * @typedef {{role:"start"|"checkpoint"|"finish", type:string, pos:THREE.Vector3, fwd:THREE.Vector3, right:THREE.Vector3, quat:THREE.Quaternion, yaw:number, halfWidth:number, _prev:number, _hasPrev:boolean}} Gate
 */

function makeGate(p, role, defaultHalfWidth) {
  _inPos.setFromMatrixPosition(p.connectorIn);
  _outPos.setFromMatrixPosition(p.connectorOut);
  const fwd = _outPos.sub(_inPos);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  else fwd.normalize();
  const hwPiece = p.hw ?? defaultHalfWidth - 2;
  let dist;
  if (role === "start") dist = startNewLineDist(p.pp ?? {}, hwPiece);
  else if (role === "finish") dist = finishNewLineDist(p.pp ?? {}, hwPiece);
  else dist = Math.max(2, (p.pp?.gameLineLength ?? 16) * 0.5);
  const pos = _inPos.clone().addScaledVector(fwd, dist);
  const yaw = Math.atan2(fwd.x, fwd.z);
  const right = new THREE.Vector3().crossVectors(_yAxis, fwd).normalize();
  return {
    role,
    type: p.id,
    pos,
    fwd: fwd.clone(),
    right,
    quat: new THREE.Quaternion().setFromAxisAngle(_yAxis, yaw),
    yaw,
    halfWidth: hwPiece + 2,
    _prev: 0,
    _hasPrev: false,
  };
}
