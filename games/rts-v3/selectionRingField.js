// Selection rings — ONE instanced, terrain-conforming ring for the whole game.
//
// Previously every unit owned its own RingGeometry + its own MeshBasicMaterial,
// added to the scene at spawn and toggled by `visible`. That cost a draw call per
// SELECTED unit (separate geometry AND separate material, so nothing could batch),
// and — the expensive half — a per-frame CPU loop that called app.getWorldHeight()
// for all 96 ring vertices and re-uploaded the position buffer. Selecting 100
// units meant ~9,600 CPU terrain samples and 100 buffer uploads every frame.
//
// Now: one unit-radius ring geometry, one material, one draw call regardless of
// how many units are selected, and the terrain draping happens in the VERTEX
// SHADER by sampling the same heightmap texture the terrain itself displaces
// with (app.heightTexNode). CPU cost per frame is 6 floats per selected unit.
//
// Like healthBar.js this is a per-frame pool: begin(), one add() per selected
// entity, commit(). Deselected units simply aren't re-added.
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import { Fn, attribute, positionLocal } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

const INNER = 0.82; // inner/outer radius ratio — matches the old per-unit ring
const SEGMENTS = 48;
const LIFT = 0.25;  // metres above the ground, so the ring never z-fights it

const _col = new THREE.Color();

/**
 * A pool of terrain-conforming selection rings drawn in a single instanced call.
 *
 * @param {{ scene: THREE.Scene, heightTexNode: object }} app — the v3 app handle
 */
export function createSelectionRingField({ app, max = 512, color = 0x6ab0ff }) {
  const { scene, heightTexNode } = app;

  // Unit-radius ring in the XZ plane; the per-instance radius scales it.
  const src = new THREE.RingGeometry(INNER, 1, SEGMENTS).rotateX(-Math.PI / 2);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute("position", src.attributes.position);

  // Two instance attributes (+ position) stays far under WebGPU's 8-buffer cap.
  const ringAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); // x, z, radius
  const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  ringAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aRing", ringAttr);
  geo.setAttribute("aRingColor", colorAttr);
  geo.instanceCount = 0;

  // The mesh sits at the origin with an identity transform, so the world-space
  // position we build below IS the local position three expects back.
  const ringVertex = Fn(() => {
    const aRing = attribute("aRing", "vec3");
    const wx = positionLocal.x.mul(aRing.z).add(aRing.x);
    const wz = positionLocal.z.mul(aRing.z).add(aRing.y);
    return drapedPosition(heightTexNode, wx, wz, LIFT);
  });

  // Ground-hugging decal, so depthTest stays ON — the unit standing on the ring
  // properly occludes it, which depthTest:false would break.
  const mat = new MeshBasicNodeMaterial({
    transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    depthWrite: false, depthTest: true, fog: false, // selection UI — never fogged
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  // A double-sided TRANSPARENT material is normally drawn twice (back faces, then
  // front) so overlapping surfaces sort correctly. A flat ring lying on the ground
  // never overlaps itself, so that second pass buys nothing and literally doubles
  // the draw calls — the old per-unit rings paid it once per selected unit.
  mat.forceSinglePass = true;
  mat.positionNode = ringVertex();
  mat.colorNode = attribute("aRingColor", "vec3");

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // instances live anywhere; the bounds are meaningless
  scene.add(mesh);

  let n = 0;

  return {
    mesh,

    begin() { n = 0; },

    /** Queue one ring. `radius` is the ring's OUTER radius in world units. */
    add(x, z, radius, tint = color) {
      if (n >= max) return;
      ringAttr.setXYZ(n, x, z, radius);
      _col.set(tint);
      colorAttr.setXYZ(n, _col.r, _col.g, _col.b);
      n++;
    },

    commit() {
      geo.instanceCount = n;
      ringAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
    },

    dispose() {
      scene.remove(mesh);
      geo.dispose();
      src.dispose();
      mat.dispose();
    },
  };
}
