// ── Horse: the SLOPE POSE layer ──────────────────────────────────────────────
// The pack has only flat-ground clips; bending them onto hills at run time took ~10 interacting
// correction layers and never looked right (LEG_IK_PLAN.md, 2026-10-24). This is the other way, the
// RDR2 one: POSES designed for uphill and downhill (in the pose editor's slope mode, J), played as a
// layer on the gait's clip and blended in by the hill — then the leg IK only plants the hooves.
//
// Data (anims/slope-poses.json): { Walk: { up: { BoneName: [[phase, [x, y, z, w]], …] }, down: { … } } }
// — a rotation OFFSET per bone (local, multiplied onto what the clip wrote), keyed by the stride's
// phase 0–1; a stride loops, so the keys wrap (the last eases into the first).
//
// Applied after the mixer and before the IK (HorseController.update): the bones it turns are restored
// every frame with the IK's (HorseController.touched), so an offset never piles up.
import * as THREE from "three";

const Q = THREE.Quaternion;
const sm = (u) => u * u * (3 - 2 * u);
export const SLOPE_GAITS = ["Walk"];
export const SLOPE_FILE = "slope-poses";

// a looping track's offset at phase p (0–1): eased between neighbouring keys, wrapping round
export function offsetAtPhase(keys, p) {
  if (!keys?.length) return null;
  if (keys.length === 1) return new Q(...keys[0][1]);
  p = ((p % 1) + 1) % 1;
  let i = keys.findIndex((k) => k[0] > p) - 1;
  if (i === -2) i = keys.length - 1;                         // (past the last key: towards the first, a stride later)
  if (i === -1) i = keys.length - 1;                         // (before the first key: from the last, a stride earlier)
  const a = keys[i], b = keys[(i + 1) % keys.length];
  let span = b[0] - a[0], d = p - a[0];
  if (span <= 0) span += 1;
  if (d < 0) d += 1;
  return new Q(...a[1]).slerp(new Q(...b[1]), sm(Math.min(1, d / span)));
}

export class SlopeLayer {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.data = {};                                          // the file's contents (the editor edits it in place)
    this.forceW = null;                                      // { up, down }: the editor shows a set at full strength
    this.load();
  }
  async load() {
    try {
      const r = await fetch(new URL(`./anims/${SLOPE_FILE}.json`, import.meta.url).href + `?${Date.now()}`);
      if (r.ok) this.data = await r.json();
    } catch { /* none saved yet */ }
    this.registerBones();
  }
  // every bone a set turns is restored each frame (the legs, neck, head already are)
  registerBones() {
    const c = this.ctrl, have = new Set(c.touched.map((t) => t.b));
    for (const gait of Object.values(this.data)) for (const set of Object.values(gait)) for (const name of Object.keys(set)) {
      const b = c.h.bone(name);
      if (b && !have.has(b)) { c.touched.push({ b, p: b.position.clone(), q: b.quaternion.clone() }); have.add(b); }
    }
  }
  // the gait's stride phase now (0–1), or null when it is not playing
  phaseOf(gait) {
    const a = this.ctrl.actions?.[gait];
    if (!a || !a.isRunning()) return null;
    const d = a.getClip().duration;
    return ((a.time / d) % 1 + 1) % 1;
  }
  // how much of each set: the hill (full at HP.hillFull) × the gait's share of the blend
  weights(gait) {
    if (this.forceW) return this.forceW;
    const a = this.ctrl.actions?.[gait], g = a ? a.getEffectiveWeight() : 0, hk = this.ctrl.hillK ?? 0;
    return { up: g * sm(Math.min(1, Math.max(0, hk))), down: g * sm(Math.min(1, Math.max(0, -hk))) };
  }
  apply() {
    let any = false;
    for (const gait of SLOPE_GAITS) {
      const sets = this.data[gait];
      if (!sets) continue;
      const p = this.phaseOf(gait);
      if (p === null) continue;
      const w = this.weights(gait);
      for (const dir of ["up", "down"]) {
        if (!(w[dir] > 1e-3) || !sets[dir]) continue;
        for (const [name, keys] of Object.entries(sets[dir])) {
          const b = this.ctrl.h.bone(name), off = offsetAtPhase(keys, p);
          if (!b || !off) continue;
          b.quaternion.multiply(new Q().slerp(off, w[dir]));
          any = true;
        }
      }
    }
    if (any) this.ctrl.glueHooves();                         // (the hooves hang on IK bones: back onto the turned legs)
    return any;
  }
}
