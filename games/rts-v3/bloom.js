// Selective-bloom materials — GAME code, ported from rts-chibs/rts-bloom.js.
//
// v3 already runs SELECTIVE bloom off the emissive MRT buffer
// (worldEnvironment.js: postFxPipeline.setBloomSelective(true)). A material only
// glows if it writes to that buffer via `mrtNode`. Everything built here opts in.
import * as THREE from "three";
import { output, vec4, float, mul, uv, vec2, smoothstep, materialColor, materialOpacity } from "three/tsl";

/**
 * three r184: when a material with an `mrtNode` renders into a target that has
 * no matching attachment (offscreen bakes, env probes, some post prepasses),
 * MRTNode maps members to attachments BY TEXTURE NAME. With nothing named
 * "emissive", the stock mrt() emits a ZERO-MEMBER WGSL output struct —
 * "structures must have at least one member" → invalid pipeline → the renderer
 * dies. Same trap the LED boards hit (v2/objects/shared/ledMatrix.js).
 *
 * This subclass keeps the stock behaviour whenever an attachment name matches,
 * and otherwise collapses to the material's plain `output` like a normal
 * material.
 */
class BloomMRTNode extends THREE.MRTNode {
  static get type() { return "BloomMRTNode"; }

  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    // OutputStructNode defines no setup of its own — this is what MRTNode's own
    // super.setup() resolves to.
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

/** HDR multipliers into the emissive buffer (not display brightness). */
export const BLOOM = {
  muzzle: 2.6,   // brief muzzle flash
  tracer: 1.9,   // hitscan streak
  impact: 2.4,   // hit spark
  fire: 2.2,     // burning wreck
  beacon: 1.7,   // structure lights
};

/**
 * Basic (unlit) material that writes to the emissive buffer → blooms.
 *
 * `transparent` DEFAULTS TO TRUE, and that matters. With transparent:false the
 * object lands in the OPAQUE pass, which is sorted front-to-back. An additive FX
 * quad near the camera then draws first, writes NO depth (depthWrite:false), and
 * the terrain — drawn afterwards — passes the depth test and paints straight
 * over it. Result: the FX is completely invisible. Additive FX must render in
 * the TRANSPARENT pass (after all opaque geometry), so keep this true unless the
 * thing is a solid glowing object that writes depth (e.g. a beacon).
 */
export function makeBloomMaterial({
  color = 0xffffff,
  opacity = 1,
  transparent = true,
  depthWrite = false,
  depthTest = true,
  side = THREE.DoubleSide,
  blending = THREE.AdditiveBlending,
  // `soft` gives the quad a radial glow falloff (1 at centre → 0 at the edge) so
  // additive sprites read as a glow, not a hard rectangle. Turn OFF for solid
  // geometry (rocket body, beacons) that isn't a billboard quad.
  soft = false,
} = {}, bloomScale = BLOOM.tracer) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent, opacity, depthWrite, depthTest, side, blending,
  });
  mat.color.set(color);
  mat.opacity = opacity;

  let glow = mul(materialColor.rgb, float(bloomScale));
  let alpha = materialOpacity;

  if (soft) {
    // Radial falloff from the quad centre.
    const d = uv().sub(vec2(0.5)).length();      // 0 at centre, ~0.707 at corner
    const fall = smoothstep(float(0.5), float(0.0), d); // 1 centre → 0 edge
    glow = mul(glow, fall);
    alpha = mul(alpha, fall);
    mat.opacityNode = alpha; // fade the beauty-pass edge too
  }

  const emissive = transparent ? mul(glow, alpha) : glow;
  // BloomMRTNode, not mrt(), so plain-RT renders don't blow up (see above).
  mat.mrtNode = new BloomMRTNode({ emissive });
  return mat;
}
