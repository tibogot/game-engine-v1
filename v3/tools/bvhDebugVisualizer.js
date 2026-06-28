import * as THREE from "three";

const CLIFF_COLOR = 0x44ff88;
const TREE_COLOR = 0xff8844;

function _wireframeFromGeometry(geo, color) {
  if (!geo) return null;
  const edges = new THREE.EdgesGeometry(geo);
  const lines = new THREE.LineSegments(
    edges,
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
    }),
  );
  lines.frustumCulled = false;
  lines.renderOrder = 999;
  return lines;
}

/**
 * Draws wireframe overlays for CliffBvh (props/cliffs) and TreeBvh (trunk cylinders).
 * Green = props/cliffs, orange = tree trunks.
 */
export function createBvhDebugVisualizer(scene, {
  getCliffBvh,
  getTreeBvh,
  rebakeCliff = null,
} = {}) {
  const group = new THREE.Group();
  group.name = "BvhDebug";
  scene.add(group);

  let enabled = false;
  let cliffLines = null;
  let treeLines = null;
  let _stamp = "";

  function _disposeLines(lines) {
    if (!lines) return;
    lines.geometry.dispose();
    lines.material.dispose();
  }

  function _buildStamp(cliff, tree) {
    const cGeo = cliff?.getCollisionGeometry?.();
    const tGeo = tree?.getCollisionGeometry?.();
    return [
      cliff?.baked ? 1 : 0,
      cGeo?.attributes?.position?.count ?? 0,
      tree?.baked ? 1 : 0,
      tree?.store?.globalGen ?? -1,
      tGeo?.attributes?.position?.count ?? 0,
    ].join("|");
  }

  function rebuild() {
    _disposeLines(cliffLines);
    _disposeLines(treeLines);
    cliffLines = treeLines = null;
    group.clear();

    if (!enabled) {
      _stamp = "";
      return;
    }

    const cliff = getCliffBvh?.();
    const tree = getTreeBvh?.();
    tree?.ensureBaked?.();

    cliffLines = _wireframeFromGeometry(cliff?.getCollisionGeometry?.(), CLIFF_COLOR);
    treeLines = _wireframeFromGeometry(tree?.getCollisionGeometry?.(), TREE_COLOR);
    if (cliffLines) group.add(cliffLines);
    if (treeLines) group.add(treeLines);

    _stamp = _buildStamp(cliff, tree);
  }

  function update() {
    if (!enabled) return;

    const tree = getTreeBvh?.();
    tree?.ensureBaked?.();

    const stamp = _buildStamp(getCliffBvh?.(), tree);
    if (stamp !== _stamp) rebuild();
  }

  return {
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      if (enabled) {
        getTreeBvh?.()?.ensureBaked?.();
        const cliff = getCliffBvh?.();
        if (cliff && !cliff.baked && rebakeCliff) rebakeCliff();
      }
      rebuild();
    },
    rebuild,
    update,
    group,
  };
}
