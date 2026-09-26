/**
 * Far-field grass colour on the terrain — Ghost of Tsushima's last grass LOD.
 *
 * The blade rings end (a fixed blade budget has to). Past the last ring GoT
 * replaces the field with a texture on the terrain; here the terrain paints
 * the colour the blades average to wherever grass is painted:
 *
 *   - the same masked density the blades grow from ("Blocks grass" layers and
 *     holes respected)
 *   - the same colour maths as the blades (grassFieldColor.js), fed with the
 *     ground colour at this pixel exactly as the blade tint is
 *   - faded IN across the SAME band the far blades converge to that colour,
 *     measured from the same anchor the rings follow (camera in the editor,
 *     player in play mode). Converging the ground together with the blades,
 *     not after them, is what hides the seam: from above you see the ground
 *     between blades, so a pixel is blades AND ground, and it only settles
 *     into one colour once both have arrived. The last ring then thins and
 *     shrinks away over ground that already matches.
 *
 * THE DENSITY IS READ IN THE VERTEX STAGE, like flowerTintTsl.js: the terrain's
 * fragment stage is at WebGPU's sampler limit. The hand-over sits 200-400 m out,
 * where paint resolution (2 m) is already finer than anyone can see.
 *
 * One If on a uniform keeps it out of the shader's work while no grass shows.
 */
import * as THREE from "three";
import { Fn, If, uniform, float, vec3, mix, min, max, dot, clamp, sin, smoothstep, length, texture, positionWorld, varying } from "three/tsl";
import { grassFieldAlbedo } from "../../../v2/render/hybridGrass/grassFieldColor.js";

export function createGrassFarShading({ worldSize }) {
  // 1×1 "nothing painted" stand-in until the grass density exists.
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  blank.needsUpdate = true;
  const densityNode = texture(blank);

  const u = {
    active: uniform(0),
    anchor: uniform(new THREE.Vector3()),
    fadeStart: uniform(360),
    fadeEnd: uniform(398),
    grassDensity: uniform(1),
    bladeCol: uniform(new THREE.Color()),
    tipCol: uniform(new THREE.Color()),
    aoBase: uniform(0.25),
    aoPower: uniform(2),
    farAoMul: uniform(0.55),
    shadeVar: uniform(1),
    tintOn: uniform(0),
    tintStrength: uniform(0.5),
    tintRootBias: uniform(0.35),
    // The blades' SLOPE rule (grassState.slopeMin/Max: normal.y where the
    // grass fades out / is full). Without it the far colour painted grass
    // over cliffs where no blade grows (seen in nam-rts, 2026-09-26).
    slopeOn: uniform(0),
    slopeMin: uniform(0.65),
    slopeMax: uniform(0.85),
    // How much of the ground's own light/dark pattern the field keeps: the
    // flat average read as a painted lime sheet, nothing like grass.
    detail: uniform(0.55),
    // The field against the BLADES as seen (measured in nam-rts at the RTS
    // camera, 2026-09-26): the flat average was ~1.3x brighter than the
    // blades (whose sides and gaps are in their own shade) and had half their
    // variation. `gain` pulls it down; `clumps` adds the blades' patchiness —
    // tufts ~3 m, patches ~15 m, in world space so it holds still.
    gain: uniform(0.76),
    clumps: uniform(0.35),
  };

  const vUV = positionWorld.xz.div(float(worldSize)).add(0.5);
  const paintV = varying(texture(densityNode, vUV).r, "v_grassFarPaint");

  /** `normalNode`: the ground's normal (world), for the slope rule; optional. */
  const apply = (baseColor, normalNode = null) => Fn(() => {
    const out = vec3(baseColor).toVar();
    If(u.active.greaterThan(0.5), () => {
      const dist = length(positionWorld.xz.sub(u.anchor.xz));
      const far = smoothstep(u.fadeStart, u.fadeEnd, dist);
      If(far.greaterThan(0.001), () => {
        // Blades keep with probability density × grassDensity, so that is
        // how much of the ground the field covers.
        let cover = min(paintV.mul(u.grassDensity), float(1));
        if (normalNode) {
          const slopeK = smoothstep(u.slopeMin, u.slopeMax, normalNode.y);
          cover = cover.mul(mix(float(1), slopeK, u.slopeOn));
        }
        const field = grassFieldAlbedo(out, {
          bladeCol: u.bladeCol, tipCol: u.tipCol,
          aoBase: u.aoBase, aoPower: u.aoPower, farAoMul: u.farAoMul,
          shadeVar: u.shadeVar, tintOn: u.tintOn, tintStrength: u.tintStrength, tintRootBias: u.tintRootBias,
        });
        // The ground's own pattern kept in the field: its luminance against a
        // typical ground's (~0.12 linear), clamped, blended by `detail`.
        const lumG = dot(out, vec3(0.2126, 0.7152, 0.0722));
        const pattern = clamp(lumG.div(0.12), 0.6, 1.5);
        const wp = positionWorld;
        const tuft = sin(wp.x.mul(2.1).add(wp.z.mul(1.3))).mul(sin(wp.z.mul(1.9).sub(wp.x.mul(0.7))));
        const patch = sin(wp.x.mul(0.37).add(wp.z.mul(0.23))).mul(sin(wp.z.mul(0.41).sub(wp.x.mul(0.17))));
        const clump = float(1).add(tuft.mul(0.55).add(patch.mul(0.45)).mul(u.clumps));
        const fieldD = field.mul(mix(float(1), pattern, u.detail)).mul(u.gain).mul(clump);
        out.assign(mix(out, fieldD, cover.mul(far)));
      });
    });
    return out;
  })();

  /** Point at the masked grass density once it exists. */
  function setSource(tex) { if (tex) densityNode.value = tex; }
  function setActive(on) { u.active.value = on ? 1 : 0; }
  /** The point the grass rings follow (camera, or the player in play mode). */
  function setAnchor(p) { u.anchor.value.copy(p); }
  /** The hand-off band — syncHybridGrassLod's return value; the ground converges with the blades. */
  function setBand({ convStart, convEnd }) {
    u.fadeStart.value = convStart;
    u.fadeEnd.value = Math.max(convEnd, convStart + 0.5);
  }

  /** The blade look the field colour is built from (grassState). */
  function syncFromState(gp) {
    // Same colour handling as HybridGrassSystem (no extra sRGB conversion).
    u.bladeCol.value.set(gp.bladeColor ?? "#0e300e");
    u.tipCol.value.set(gp.tipColor ?? "#004d05");
    u.aoBase.value = gp.aoBase ?? 0.25;
    u.aoPower.value = gp.aoPower ?? 2;
    u.farAoMul.value = gp.farAoMul ?? 0.55;
    u.shadeVar.value = gp.shadeVariation ?? 1;
    u.grassDensity.value = gp.grassDensity ?? 1;
    u.tintOn.value = gp.terrainTintEnabled ? 1 : 0;
    u.tintStrength.value = gp.terrainTintStrength ?? 0.5;
    u.tintRootBias.value = gp.terrainTintRootBias ?? 0.35;
    u.slopeOn.value = gp.slopeEnabled ? 1 : 0;
    u.slopeMin.value = gp.slopeMin ?? 0.65;
    u.slopeMax.value = gp.slopeMax ?? 0.85;
  }

  return { apply, setSource, setActive, setAnchor, setBand, syncFromState, uniforms: u };
}
