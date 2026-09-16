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
import { Fn, If, uniform, float, vec3, mix, min, smoothstep, length, texture, positionWorld, varying } from "three/tsl";
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
    tintOn: uniform(0),
    tintStrength: uniform(0.5),
    tintRootBias: uniform(0.35),
  };

  const vUV = positionWorld.xz.div(float(worldSize)).add(0.5);
  const paintV = varying(texture(densityNode, vUV).r, "v_grassFarPaint");

  const apply = (baseColor) => Fn(() => {
    const out = vec3(baseColor).toVar();
    If(u.active.greaterThan(0.5), () => {
      const dist = length(positionWorld.xz.sub(u.anchor.xz));
      const far = smoothstep(u.fadeStart, u.fadeEnd, dist);
      If(far.greaterThan(0.001), () => {
        // Blades keep with probability density × grassDensity, so that is
        // how much of the ground the field covers.
        const cover = min(paintV.mul(u.grassDensity), float(1));
        const field = grassFieldAlbedo(out, {
          bladeCol: u.bladeCol, tipCol: u.tipCol,
          aoBase: u.aoBase, aoPower: u.aoPower, farAoMul: u.farAoMul,
          tintOn: u.tintOn, tintStrength: u.tintStrength, tintRootBias: u.tintRootBias,
        });
        out.assign(mix(out, field, cover.mul(far)));
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
    u.grassDensity.value = gp.grassDensity ?? 1;
    u.tintOn.value = gp.terrainTintEnabled ? 1 : 0;
    u.tintStrength.value = gp.terrainTintStrength ?? 0.5;
    u.tintRootBias.value = gp.terrainTintRootBias ?? 0.35;
  }

  return { apply, setSource, setActive, setAnchor, setBand, syncFromState, uniforms: u };
}
