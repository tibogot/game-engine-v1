import * as THREE from "three";
import { output, vec4 } from "three/tsl";

/**
 * `mrtNode` that is safe to use on a material which may also be rendered into a plain
 * render target (thumbnail bakes, env probes, offscreen previews).
 *
 * three r184: when no renderer-level MRT is set, a material's mrtNode becomes the ENTIRE
 * fragment output, and MRTNode maps its members to attachments BY TEXTURE NAME. On a plain
 * RT nothing is named "emissive", so the stock mrt() emits a zero-member WGSL output struct
 * ("structures must have at least one member") → invalid pipeline → the renderer dies.
 *
 * This keeps the stock behaviour whenever an attachment name matches, and otherwise collapses
 * to the material's regular `output` like any normal material.
 *
 * Selective bloom (worldEnvironment.js: postFxPipeline.setBloomSelective(true)) blooms ONLY
 * the emissive MRT buffer, so a material glows only if it writes to it — unlit
 * (MeshBasicNodeMaterial) materials must opt in through this node.
 */
export class BloomMRTNode extends THREE.MRTNode {
  static get type() { return "BloomMRTNode"; }

  setup(builder) {
    const textures = builder.renderer.getRenderTarget()?.textures;
    const anyNamed = !!textures && textures.some((t) => this.outputNodes[t.name] !== undefined);
    if (anyNamed) return super.setup(builder);
    this.members = [vec4(output)];
    // OutputStructNode defines no setup of its own — this is what MRTNode's super.setup() resolves to.
    return THREE.Node.prototype.setup.call(this, builder);
  }
}

/** Write `emissiveNode` into the emissive MRT buffer so this material blooms. */
export function applyBloomMRT(material, emissiveNode) {
  material.mrtNode = new BloomMRTNode({ emissive: emissiveNode });
  return material;
}
