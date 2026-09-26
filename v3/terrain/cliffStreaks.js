/**
 * CLIFF WATER STREAKS on the terrain — the dark vertical stains rain leaves
 * down a limestone face, and its faint horizontal bedding. Steep ground only.
 *
 * Why: a cliff is a few heightmap texels wide and its rock texture tiles in
 * metres, so from an RTS camera a cliff mips to a smooth wall. Streaks run
 * the WHOLE height of a face at a scale that survives the distance, and they
 * are what makes a tropical limestone cliff read (nam-rts, 2026-09-26).
 *
 * All ALU (no texture), one If on `strength` — off by default, so every other
 * project renders exactly as before. A game switches it on with
 * app.setCliffStreaks({ strength: 0.5 }).
 */
import { Fn, If, abs, dot, float, fract, max, mix, normalize, sin, smoothstep, uniform, vec2, vec3 } from "three/tsl";

export const cliffStreakUniforms = {
  strength: uniform(0),      // 0 = off
  steepStart: uniform(0.82), // normal.y: streaks begin (≈35°)
  steepEnd: uniform(0.55),   //           full (≈57°)
  width: uniform(0.3),       // wide streak bands per metre across the face (x0.35: ~10 m cells)
  bedding: uniform(0.12),    // horizontal strata strength
};

/** Returns the colour with streaks applied. `wxz` world XZ, `y` world height, `nrm` world normal. */
export function applyCliffStreaks(col, wxz, y, nrm) {
  const u = cliffStreakUniforms;
  return Fn(() => {
    const out = vec3(col).toVar();
    If(u.strength.greaterThan(0), () => {
      // (Edges always low < high: a reversed smoothstep is undefined in WGSL.)
      const steep = float(1).sub(smoothstep(u.steepEnd, u.steepStart, nrm.y));
      If(steep.greaterThan(0.001), () => {
        // Along the face: the horizontal direction perpendicular to its
        // slope, so a streak is a line straight DOWN the wall.
        const h = vec2(nrm.x, nrm.z);
        const t = normalize(vec2(h.y.negate(), h.x).add(vec2(1e-4, 0)));
        const s = dot(wxz, t);
        // Streak bands: a few wide dark ones, many thin ones; each fades out
        // at its own height so they start and stop down the face.
        const hash = (v) => fract(sin(v.mul(127.1)).mul(43758.5453));
        const cellA = s.mul(u.width).mul(0.35), cellB = s.mul(u.width).mul(1.3);
        // Distance from each cell's centre line (0 centre .. 1 edge), each
        // cell's streak its own width; wide soft bands, not hairlines.
        const dA = abs(fract(cellA).sub(0.5)).mul(2), dB = abs(fract(cellB).sub(0.5)).mul(2);
        const wA = hash(cellA.floor()).mul(0.5).add(0.25), wB = hash(cellB.floor()).mul(0.35).add(0.15);
        const bandA = float(1).sub(smoothstep(wA.mul(0.4), wA, dA));
        const bandB = float(1).sub(smoothstep(wB.mul(0.4), wB, dB));
        const lenA = smoothstep(0.2, 0.9, sin(y.mul(0.09).add(hash(cellA.floor().add(3)).mul(6.28))).mul(0.5).add(0.5));
        const lenB = smoothstep(0.3, 0.9, sin(y.mul(0.21).add(hash(cellB.floor().add(7)).mul(6.28))).mul(0.5).add(0.5));
        const streak = max(bandA.mul(lenA).mul(0.9), bandB.mul(lenB).mul(0.55));
        // Bedding: faint light/dark layers across the face.
        const bed = sin(y.mul(1.7).add(sin(s.mul(0.11)).mul(1.4))).mul(u.bedding);
        const k = u.strength.mul(steep);
        const dark = float(1).sub(streak.mul(0.7).mul(k));
        out.assign(out.mul(dark).mul(float(1).add(bed.mul(k))));
        // Stains are cooler and greener (algae in the wet): tint them a touch.
        out.assign(mix(out, out.mul(vec3(0.85, 0.95, 0.9)), streak.mul(k).mul(0.6)));
      });
    });
    return out;
  })();
}
