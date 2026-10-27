/**
 * ── ONE SHADOW BUILD FOR EVERY PLAIN SHADOW CASTER ────────────────────────────────────────────────
 *
 * three draws the shadow pass with ONE shared override material (ShadowMaterial), yet keys each
 * caster's node build on the caster's whole GEOMETRY LAYOUT (every attribute name, size, stride —
 * uv, uv1, color, tangent…) and its `receiveShadow` flag (RenderObject.getMaterialCacheKey). A
 * plain caster's shadow shader reads the POSITION only, so casters whose geometries merely carry
 * different extra attributes built the same shader again and again. MEASURED in alg (2026-10-27):
 * 268 of 562 node builds were exact duplicates of another (~6–7 s of the boot's 14 s of WGSL
 * generation); the shadow pass's families were the largest — 21, 16, 8, 6… identical builds.
 *
 * For a PLAIN caster only, the key sees the geometry as its position attribute alone (its format and
 * the index's presence) and `receiveShadow` as false. Plain = the source material gives the shadow
 * pass nothing of its own (what Renderer._getShadowNodes and the override setup read): no
 * castShadowNode / maskShadowNode / maskNode, no positionNode, no alphaMap, no alphaTest, no
 * displacementMap, not transparent — and the object is neither batched nor morphed (those keep three's
 * key). Instanced meshes join: their matrices / colours come from the object, not the geometry, and
 * their uuid in the key is sharedInstanceBuilds.js's business (kept wherever it cannot share). A map or a
 * colorNode is allowed: for such an opaque caster the shadow pass's map-alpha colorNode is dropped,
 * since a depth shadow map never uses it (opaqueSource below).
 * Everything else in the key is three's: the material's own properties (side…), skinning, the pass.
 * The builder's shader reads only `position`, and each draw reads its OWN geometry's attributes by
 * name, so sharing the build is exact.
 *
 * Installed once per page through the first render object (RenderObject is not exported).
 */
// OPAQUE for the shadow pass: nothing in it can cut the caster's shape (no alpha test, alpha map,
// transparency, transmission, cast / mask shadow nodes). three's shadow pass still reads its map's /
// colorNode's alpha (Renderer._getShadowNodes: colorNode = vec4(0, map.a · colorNode.a)), and that ties
// each caster's shadow build to its OWN material: the 21 identical shadow builds of alg's biggest
// family were all opaque materials with a map. See installShadowBuildSharing for why dropping it is right.
const opaqueSource = (m) => !!m
  && !(m.castShadowNode && m.castShadowNode.isNode) && !(m.maskShadowNode && m.maskShadowNode.isNode) && !(m.maskNode && m.maskNode.isNode)
  && !m.alphaMap && !(m.alphaTest > 0) && m.transparent !== true && !(m.transmission > 0) && !m.alphaToCoverage
  && !(m.transmissionNode && m.transmissionNode.isNode) && !(m.backdropNode && m.backdropNode.isNode);
// …and PLAIN: also nothing that moves its vertices, so its shadow reads the position only.
const plainSource = (m) => opaqueSource(m) && !(m.positionNode && m.positionNode.isNode) && !m.displacementMap;

const _posOnly = new WeakMap();   // geometry → a stand-in exposing only position + index
function positionOnly(geometry) {
  let g = _posOnly.get(geometry);
  if (!g || g.position !== geometry.attributes.position || g.index !== geometry.index) {
    g = { attributes: { position: geometry.attributes.position }, morphAttributes: {}, index: geometry.index, position: geometry.attributes.position };
    _posOnly.set(geometry, g);
  }
  return g;
}
const NO_RECEIVE = { get(t, p) { return p === "receiveShadow" ? false : Reflect.get(t, p, t); } };

export function installShadowBuildSharing(renderer) {
  const objects = renderer._objects;
  if (!objects || objects._v3ShadowShare) return false;
  objects._v3ShadowShare = true;

  // An opaque caster's shadow takes no colour / alpha from its material (see opaqueSource): three's
  // plain shadow colour vec4(0, 0, 0, 1) instead of vec4(0, map.a · colorNode.a). The same, wherever
  // the map's alpha is 1; where it is not, an opaque mesh — drawn SOLID — cast a partly see-through
  // shadow into the transmitted (coloured) shadow map (v3 turns it on: main.js), which was wrong.
  const getShadowNodes = renderer._getShadowNodes;
  if (typeof getShadowNodes === "function") {
    const colorless = new WeakMap();   // three's per-material cache entry → the same without colorNode
    renderer._getShadowNodes = function (material) {
      const nodes = getShadowNodes.call(this, material);
      if (!opaqueSource(material) || nodes?.colorNode == null) return nodes;
      let c = colorless.get(nodes);
      if (!c) colorless.set(nodes, (c = { ...nodes, colorNode: null }));
      return c;
    };
  }
  const create = objects.createRenderObject;
  objects.createRenderObject = function (...args) {
    const ro = create.apply(this, args);
    const P = Object.getPrototypeOf(ro);
    if (!P._v3ShadowShare) {
      P._v3ShadowShare = true;
      const getMaterialCacheKey = P.getMaterialCacheKey;
      P.getMaterialCacheKey = function () {
        const o = this.object, g = this.geometry;
        // the constructor keys the render object BEFORE it stores _sourceMaterial (r186): ask the renderer
        const source = this._sourceMaterial ?? this.renderer?._currentSourceMaterial;
        const shareable = this.material?.isShadowPassMaterial === true && plainSource(source)
          && o && !o.isBatchedMesh && g?.attributes?.position
          && Object.keys(g.morphAttributes || {}).length === 0;
        if (!shareable) return getMaterialCacheKey.call(this);
        this.geometry = positionOnly(g);
        this.object = new Proxy(o, NO_RECEIVE);
        try { return getMaterialCacheKey.call(this); } finally { this.geometry = g; this.object = o; }
      };
      ro.initialCacheKey = ro.getCacheKey();   // made before the patch
    }
    return ro;
  };
  return true;
}
