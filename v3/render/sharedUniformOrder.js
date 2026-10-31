/**
 * ── r187: A SHARED UNIFORM GROUP IS LAID OUT IN ONE ORDER, IN THE SHADER AND IN ITS BUFFER ──────────
 *
 * A shared uniform group (three's renderGroup, frameGroup, our own sharedUniformGroup("render")) is one
 * buffer for every draw of a render context. r187 finds that buffer by its uniforms' node ids, SORTING
 * the group's uniform list in place to make the key (Bindings.getSharedBindGroup) — after the shader was
 * written. The shader's struct follows the order the build met the uniforms in; the buffer's offsets and
 * size follow the sorted order. Wherever the two differ every value lands at the wrong offset, and when
 * the padding differs too the pipeline asks for more bytes than the buffer has (alg-rts on r187: "bound
 * with size 464 … requires … at least 480 bytes" on the haystacks, 272 / 288 on the foliage depth pass —
 * the frame lost). Our engine meets it because it puts its own uniforms in the render group (shared
 * arrays, per-pass values) next to three's camera ones, made at other times, so their ids interleave.
 *
 * r186 sorted the list while building (NodeBuilder.getBindings), before the code: shader and buffer
 * agreed. Restored here: each shared group's uniforms sorted by node id just before the code is written.
 * The sort is the one three's key makes, so it changes nothing afterwards.
 *
 * Side effect on import, once per page, for every renderer in it (main.js imports it; so does any page
 * making its own WebGPU renderer). Retest at every three upgrade (v3/THREE_UPGRADES.md): when three
 * writes the struct in its key's order itself, this does nothing and should go.
 */
import { WGSLNodeBuilder } from "three/webgpu";

const byNodeId = (a, b) => a.nodeUniform.node.id - b.nodeUniform.node.id;

const P = WGSLNodeBuilder?.prototype;
if (P && !P._v3SharedUniformOrder && typeof P.buildCode === "function") {
  P._v3SharedUniformOrder = true;
  const buildCode = P.buildCode;
  P.buildCode = function () {
    for (const name in this.uniformGroups) {
      const group = this.uniformGroups[name];
      if (group?.groupNode?.shared === true && group.uniforms.length > 1) group.uniforms.sort(byNodeId);
    }
    return buildCode.call(this);
  };
}

export const SHARED_UNIFORM_ORDER = true;
