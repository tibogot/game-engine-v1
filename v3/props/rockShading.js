/**
 * Stylized rock shading for the procedural rock & cliff kit — the painted
 * Genshin / Zelda look without a texture:
 *
 *   - vertical gradient: light top, cool blue-grey base (`rockShade.y`)
 *   - undersides (world normal facing down) darken further
 *   - chip edges catch light: a brighter band where `rockShade.x` (baked edge
 *     curvature, see proceduralRock.js _bakeShade) passes a threshold
 *   - soft world-space mottling so large facets are not flat colour
 *   - ambient occlusion toward the base (indirect light only)
 *
 * No samplers: everything is a baked vertex attribute or a noise node, so it
 * costs nothing against the terrain's 16-sampler budget and works on any prop
 * material (grey default or a triplanar library material — it multiplies the
 * existing colour). Apply BEFORE applyCliffTerrainBlend so grass tops cover it.
 *
 * Every knob is a uniform in `mat.userData.rockShading`, so the look can be
 * tuned live without regenerating a single rock.
 */
import * as THREE from "three";
import {
  attribute, clamp, float, materialColor, mix, mx_noise_float, normalWorld,
  positionWorld, smoothstep, uniform, vec3,
} from "three/tsl";

/** Default base colour for rocks on the "none" material: light cool grey. */
export const ROCK_BASE_COLOR = 0xd3d8df;

/**
 * Mutates `mat` (colorNode / aoNode) and returns it.
 * @param {THREE.MeshStandardNodeMaterial} mat
 */
export function applyRockShading(mat) {
  const u = {
    uEdgeLo:     uniform(0.012),                             // baked curvature where the band starts
    uEdgeHi:     uniform(0.06),                              // … and is full
    uEdgeBright: uniform(0.3),                               // edge brightening
    uBottomTint: uniform(new THREE.Color(0.52, 0.6, 0.76)),  // multiplies the base at the bottom
    uGradEnd:    uniform(0.75),                              // height (0..1) where the gradient reaches white
    uDownDark:   uniform(0.3),                               // extra darkening on faces pointing down
    uMottleScale: uniform(0.25),                             // world-space noise frequency (1/m)
    uMottle:     uniform(0.07),                              // noise amplitude
    uAoBottom:   uniform(0.5),                               // indirect-light AO at the base
  };

  const shade = attribute("rockShade", "vec2");
  const edge = smoothstep(u.uEdgeLo, u.uEdgeHi, shade.x);
  const h = smoothstep(float(0), u.uGradEnd, shade.y);

  const gradient = mix(u.uBottomTint, vec3(1), h);
  const down = float(1).sub(clamp(normalWorld.y.negate(), 0, 1).mul(u.uDownDark));
  const mottle = float(1).add(mx_noise_float(positionWorld.mul(u.uMottleScale)).mul(u.uMottle));
  const lift = float(1).add(edge.mul(u.uEdgeBright));

  const base = mat.colorNode ?? materialColor;
  mat.colorNode = base.mul(gradient).mul(down).mul(mottle).mul(lift);
  mat.aoNode = mix(u.uAoBottom, float(1), h);
  mat.userData.rockShading = u;
  return mat;
}
