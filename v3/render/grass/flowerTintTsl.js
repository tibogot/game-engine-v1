/**
 * Far-field flower colour on the terrain.
 *
 * The 3D flowers thin out and stop at the fade distance (~90 m) — a fixed
 * instance budget has to end somewhere. Past it a painted meadow would just
 * vanish, and from a hill a field of poppies would read as bare grass. So the
 * terrain paints the flowers' colour into its own albedo there, the way large
 * open-world games keep distant flower fields visible:
 *
 *   - the same painted density texture the flowers grow from (masked by
 *     "Blocks grass" layers and holes), one type per channel
 *   - the same clump noise (flowerNoise.js), so distant patches are the clumps
 *     the flowers really grow in
 *   - each type's visible colour and how much ground its blooms cover (from
 *     its size and the meadow density), mixed by the paint
 *   - faded IN across the same distance band the 3D flowers fade OUT in, so the
 *     hand-over has no seam
 *   - a fine speckle, so it reads as many small blooms, not a flat decal
 *
 * One If on a uniform keeps it out of the shader's work entirely while nothing
 * is painted (see the terrain branch-gate notes in terrainLOD.js).
 *
 * THE PAINT IS READ IN THE VERTEX STAGE. The terrain's fragment stage already
 * binds 16 samplers, WebGPU's per-stage maximum — one more texture there and
 * the whole terrain pipeline fails to build (the terrain disappears). The
 * vertex stage has room, and this only applies past ~60 m, where the clipmap's
 * vertices are already a few metres apart, finer than the paint needs.
 */
import * as THREE from "three";
import {
  Fn, If, uniform, float, vec3, vec4, mix, smoothstep, min, max, dot, length, texture,
  positionWorld, cameraPosition, varying,
} from "three/tsl";
import { flowerClump, flowerValueNoise } from "./flowerNoise.js";
import { FLOWER_TYPE_COUNT } from "../../app/state/flowerState.js";

export function createFlowerTintShading({ worldSize }) {
  // 1×1 "nothing painted" stand-in until the flower density exists.
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  blank.needsUpdate = true;
  const densityNode = texture(blank);

  const u = {
    active: uniform(0),
    strength: uniform(1),
    fadeStart: uniform(62),
    fadeEnd: uniform(88),
    density: uniform(0.55),
    clumping: uniform(0.7),
    clumpFreq: uniform(0.25),
    // Per type: visible colour (rgb) + ground coverage at full paint (a).
    types: Array.from({ length: FLOWER_TYPE_COUNT }, () => uniform(new THREE.Vector4(0, 0, 0, 0))),
    // Per type: the terrain height band it grows in (min, max) — same rule as the 3D flowers.
    bands: Array.from({ length: FLOWER_TYPE_COUNT }, () => uniform(new THREE.Vector2(-1e5, 1e5))),
  };

  // Sampled per vertex and interpolated (see the header note).
  const paintV = varying(texture(densityNode, positionWorld.xz.div(float(worldSize)).add(0.5)), "v_flowerPaint");

  const apply = (baseColor) => Fn(() => {
    const out = vec3(baseColor).toVar();
    If(u.active.greaterThan(0.5), () => {
      const wxz = positionWorld.xz;
      const dist = length(wxz.sub(cameraPosition.xz));
      // In where the 3D flowers go out.
      const far = smoothstep(u.fadeStart, u.fadeEnd, dist);
      If(far.greaterThan(0.001), () => {
        // Each type counts only inside its own height band, softened like the flowers'.
        const y = positionWorld.y;
        const inBand = (b) => smoothstep(b.x.sub(2), b.x.add(2), y).mul(float(1).sub(smoothstep(b.y.sub(2), b.y.add(2), y)));
        const paint = vec4(
          paintV.r.mul(inBand(u.bands[0])), paintV.g.mul(inBand(u.bands[1])),
          paintV.b.mul(inBand(u.bands[2])), paintV.a.mul(inBand(u.bands[3])),
        ).toVar();
        const total = paint.r.add(paint.g).add(paint.b).add(paint.a).toVar();
        If(total.greaterThan(0.004), () => {
          const t0 = u.types[0], t1 = u.types[1], t2 = u.types[2], t3 = u.types[3];
          const invT = float(1).div(max(total, 1e-4));
          // Paint-weighted colour and coverage of the types growing here.
          const colour = t0.xyz.mul(paint.r).add(t1.xyz.mul(paint.g)).add(t2.xyz.mul(paint.b)).add(t3.xyz.mul(paint.a)).mul(invT);
          const cover = t0.w.mul(paint.r).add(t1.w.mul(paint.g)).add(t2.w.mul(paint.b)).add(t3.w.mul(paint.a)).mul(invT);
          const clump = flowerClump(wxz, u.clumpFreq, u.clumping);
          // Many small blooms, not a flat wash: a speckle that coarsens with distance.
          const speckle = flowerValueNoise(wxz.mul(float(1.7).div(max(dist.mul(0.012), 1)))).mul(0.9).add(0.55);
          const amount = min(total, 1).mul(u.density).mul(clump).mul(cover).mul(speckle).mul(u.strength).mul(far).clamp(0, 0.85);
          // Keep the ground's light and shade: tint by colour, scaled to the ground's own brightness.
          const luma = dot(out, vec3(0.299, 0.587, 0.114));
          const lit = colour.mul(mix(float(0.45), float(1.05), luma.mul(2).clamp(0, 1)));
          out.assign(mix(out, lit, amount));
        });
      });
    });
    return out;
  })();

  /** Point at the masked flower density once it exists. */
  function setSource(tex) { if (tex) densityNode.value = tex; }
  function setActive(on) { u.active.value = on ? 1 : 0; }

  /**
   * @param fp flower state; strength comes from fp.farTint.
   * Coverage per type: how much of a square metre of full-strength paint its
   * blooms hide — bloom area × plants per m² (the 0.5 m plant grid = 4), capped.
   */
  function syncFromState(fp) {
    const c = new THREE.Color(), tip = new THREE.Color();
    u.strength.value = fp.farTint ?? 1;
    u.fadeStart.value = fp.fadeStart;
    u.fadeEnd.value = Math.max(fp.fadeEnd, fp.fadeStart + 1);
    u.density.value = fp.density;
    u.clumping.value = fp.clumping;
    u.clumpFreq.value = 1 / Math.max(0.5, fp.clumpSize);
    for (let i = 0; i < FLOWER_TYPE_COUNT; i++) {
      const t = fp.types[i];
      c.set(t.petalBase); tip.set(t.petalTip);
      // Most of a bloom seen from afar is its shaded base colour, not the bright tip.
      c.lerp(tip, 0.35);
      const bloomArea = Math.PI * (t.size * 0.5) ** 2;
      // Stemmed flowers stand up and fill more of a grazing view.
      const cover = Math.min(1, bloomArea * 4 * (t.stemHeight > 0 ? 1.6 : 1.1));
      u.types[i].value.set(c.r, c.g, c.b, cover);
      u.bands[i].value.set(t.heightMin ?? -1e5, t.heightMax ?? 1e5);
    }
  }

  return { apply, setSource, setActive, syncFromState, uniforms: u };
}
