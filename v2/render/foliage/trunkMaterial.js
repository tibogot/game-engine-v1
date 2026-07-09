/**
 * Procedural bark material for trunks (port of arborist's trunkMat). A cheap
 * vertical 2-colour gradient up the trunk + roughness, metalness 0. Applied to
 * a slot's trunk submeshes when the preset's `trunkMaterial.useGlb` is false, so
 * trunks get the bark colour authored in arborist without needing a texture.
 *
 * Gradient runs over the trunk's LOCAL Y bounds (positionLocal space) so it's
 * 0 at the base / 1 at the top regardless of where the tree sits on the terrain
 * or how the GLB was scaled — unlike a world-Y gradient, which would break on
 * hills. yMin/yMax are the raw geometry bounds (which is what positionLocal is).
 */
import * as THREE from "three";
import {
  Fn, float, vec2, vec3,
  uniform, mix, smoothstep, clamp,
  sin, max, pow, dot, normalize, sub, add, mul, div,
  mx_noise_float, mx_atan2,
  positionLocal, positionWorld, normalWorld, cameraPosition,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three";

export function createTrunkMaterial(opts = {}) {
  const u = {
    botColor:  uniform(new THREE.Color(opts.botColor ?? "#4a2f17")),
    topColor:  uniform(new THREE.Color(opts.topColor ?? "#6b4a2b")),
    yMin:      uniform(opts.yMin ?? 0),
    yMax:      uniform(opts.yMax ?? 6),
    roughness: uniform(opts.roughness ?? 0.9),
  };
  const mat = new MeshStandardNodeMaterial({ metalness: 0 });
  const grad = smoothstep(u.yMin, u.yMax, positionLocal.y);
  mat.colorNode = mix(u.botColor, u.topColor, grad);
  mat.roughnessNode = u.roughness;
  return { material: mat, uniforms: u };
}

/**
 * Full procedural bark for pine-editor trunks: 3-colour vertical ramp, angular
 * stripes, two-octave grain, crack mask, base AO, moss at the foot, and a
 * view-dependent rim. Port of pine-editor33.html's trunkColorNode.
 *
 * The editor evaluates the pattern in WORLD space, which is identical to trunk
 * space there (one tree, at the origin, unscaled). In game the same trunk is
 * instanced across the terrain, so world space would slide the grain/stripes
 * across every instance and break yNorm on hills — the pattern is evaluated in
 * `positionLocal` instead. Every pine instance therefore shares one bark
 * pattern, which is what the editor preview shows. Only the rim stays in world
 * space, since it is genuinely view-dependent.
 *
 * @param {object} trunk The preset's `pine.trunk` block.
 */
export function createPineBarkMaterial(trunk = {}) {
  const yOffset = trunk.yOffset ?? 0;
  const height = Math.max(0.15, trunk.height ?? 5);
  const u = {
    barkDark:       uniform(new THREE.Color(trunk.barkDark ?? "#2a1f18")),
    barkMid:        uniform(new THREE.Color(trunk.barkMid ?? "#4a3528")),
    barkLight:      uniform(new THREE.Color(trunk.barkLight ?? "#6b5240")),
    barkHighlight:  uniform(new THREE.Color(trunk.barkHighlight ?? "#8a7058")),
    yMin:           uniform(yOffset),
    yMax:           uniform(yOffset + height),
    stripeFreq:     uniform(trunk.stripeFreq ?? 9),
    stripeStrength: uniform(trunk.stripeStrength ?? 0.22),
    noiseScale:     uniform(trunk.noiseScale ?? 2.4),
    noiseStrength:  uniform(trunk.noiseStrength ?? 0.14),
    crackStrength:  uniform(trunk.crackStrength ?? 0.1),
    baseAo:         uniform(trunk.baseAo ?? 0.4),
    mossStrength:   uniform(trunk.mossStrength ?? 0.12),
    rimColor:       uniform(new THREE.Color(trunk.rimColor ?? "#a09078")),
    rimStrength:    uniform(trunk.rimStrength ?? 0.11),
    rimPower:       uniform(trunk.rimPower ?? 2.2),
    roughness:      uniform(trunk.roughness ?? 0.94),
  };

  const colorNode = Fn(() => {
    const p = positionLocal;
    const ySpan = max(sub(u.yMax, u.yMin), float(0.001));
    const yNorm = clamp(div(sub(p.y, u.yMin), ySpan), float(0), float(1));

    let col = mix(u.barkDark, u.barkMid, yNorm);
    col = mix(col, u.barkLight, mul(yNorm, yNorm));

    const ang = mx_atan2(p.z, p.x);
    const stripe = sin(add(mul(ang, u.stripeFreq), mul(yNorm, float(3.2))))
      .mul(float(0.5))
      .add(float(0.5));
    col = mix(col, mul(col, float(0.86)), mul(stripe, u.stripeStrength));

    const n1 = mx_noise_float(mul(p, u.noiseScale));
    const n2 = mx_noise_float(
      mul(p, mul(u.noiseScale, float(2.7))).add(vec3(17.3, 4.1, 9.8)),
    );
    const grain = n1.mul(float(0.6)).add(n2.mul(float(0.4)));
    col = mul(col, add(float(1), mul(sub(grain, float(0.5)), u.noiseStrength)));

    const crack = mx_noise_float(
      mul(vec2(p.x, p.z), mul(u.noiseScale, float(4.5))),
    );
    const crackMask = smoothstep(float(0.52), float(0.58), crack);
    col = mix(mul(col, float(0.78)), col, sub(float(1), mul(crackMask, u.crackStrength)));

    const hi = smoothstep(float(0.55), float(0.92), grain);
    col = add(col, mul(u.barkHighlight, mul(hi, float(0.18))));

    const baseShade = mix(
      sub(float(1), u.baseAo),
      float(1),
      smoothstep(float(0), float(0.22), yNorm),
    );
    col = mul(col, baseShade);

    const moss = smoothstep(float(0.14), float(0), yNorm);
    col = mix(mul(col, float(0.62)), col, sub(float(1), mul(moss, u.mossStrength)));

    const viewDir = normalize(sub(cameraPosition, positionWorld));
    const rimDot = sub(float(1), max(dot(normalWorld, viewDir), float(0)));
    col = add(col, mul(u.rimColor, mul(pow(rimDot, u.rimPower), u.rimStrength)));

    return clamp(col, float(0), float(2));
  })();

  const mat = new MeshStandardNodeMaterial({
    color: 0xffffff,
    metalness: trunk.metalness ?? 0,
  });
  mat.colorNode = colorNode;
  mat.roughnessNode = u.roughness;
  return { material: mat, uniforms: u };
}
