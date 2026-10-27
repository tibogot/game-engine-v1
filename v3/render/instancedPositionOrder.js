/**
 * ── r186: A MATERIAL'S positionNode RUNS IN THE INSTANCE'S OWN FRAME AGAIN ──────────────────────
 *
 * three r184 built an InstancedMesh's vertex as
 *     positionLocal = position → positionNode (the object's own frame) → × instanceMatrix
 * r186 (instancing rewritten as the `instance()` TSL function) builds it as
 *     positionLocal = position → × instanceMatrix → positionNode (on the PLACED position)
 * so every instanced vertex effect written for the first order runs its maths in the wrong space —
 * the birds' wing beat (abs(positionLocal.x) is the wing span: you saw "the birds' wings doing
 * something completely wrong", 2026-10-27), the haystack's wind, the plant sway, the billboard
 * leaf cards, the units' kit pieces… Proven on the generated WGSL (headless builder, same
 * material): r184 scales x BEFORE the instance matrix, r186 after.
 *
 * Every vertex effect in this repo is written for r184's order, so the order is restored here, for
 * instanced meshes with a positionNode only: NodeMaterial.setupPosition is r186's own, with the
 * positionNode moved ahead of the instancing. Everything else (morph, skin, displacement, batch,
 * meshes without a positionNode) builds exactly as r186 does.
 *
 * Side effect on import, once per page (main.js imports it; so do the shared modules whose effects
 * need it, for labs that make their own renderer). Retest at every three upgrade
 * (v3/THREE_UPGRADES.md): if three restores the order itself, this does nothing harmful but
 * should go.
 */
import * as THREE from "three";
import {
  batch, instancedMesh, materialReference, morphReference, normalLocal, positionLocal, skinning, subBuild,
} from "three/tsl";

const NM = THREE.NodeMaterial?.prototype;
if (NM && !NM._v3InstancedPositionOrder && Number(THREE.REVISION) >= 186) {
  NM._v3InstancedPositionOrder = true;
  const setupPosition = NM.setupPosition;
  NM.setupPosition = function (builder) {
    const { object, geometry } = builder;
    const instanced = object.isInstancedMesh === true && object.instanceMatrix?.isInstancedBufferAttribute === true;
    if (!instanced || this.positionNode === null) return setupPosition.call(this, builder);

    if (geometry.morphAttributes.position || geometry.morphAttributes.normal || geometry.morphAttributes.color) {
      morphReference(object);
    }
    if (object.isSkinnedMesh === true) skinning(object);
    if (this.displacementMap) {
      const displacementMap = materialReference("displacementMap", "texture");
      const displacementScale = materialReference("displacementScale", "float");
      const displacementBias = materialReference("displacementBias", "float");
      positionLocal.addAssign(normalLocal.normalize().mul(displacementMap.x.mul(displacementScale).add(displacementBias)));
    }
    if (object.isBatchedMesh) batch(object);
    // r184's order: the material's own vertex effect in the object's frame, THEN the instance's matrix
    positionLocal.assign(subBuild(this.positionNode, "POSITION", "vec3"));
    instancedMesh(object);
    return positionLocal;
  };
}

export const INSTANCED_POSITION_ORDER_R184 = true;
