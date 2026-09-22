// Selection frames — the square buildings' counterpart of the unit rings
// (selectionRingField.js): four CORNER BRACKETS around a selected building's
// footprint, draped on the terrain in the vertex shader. One instanced draw for
// every selected building. Round buildings (helipad, turrets) use the rings.
//
// Brackets, not a full outline: a 28 m HQ outlined all round is a fence drawn
// on the ground; four corners say "this, selected" and leave the ground alone.
// The arms and their thickness are in METRES (not a fraction of the frame), so
// a small hut and the HQ carry the same weight of line.
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import { Fn, attribute } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

const LIFT = 0.25;       // off the ground, as the rings
const PAD = 1.2;         // metres outside the footprint

const _col = new THREE.Color();

/**
 * Corner brackets. Every vertex carries its corner (sx, sz) and four
 * coefficients: its offset from that corner, inward, is
 * (ax·arm + tx·thick, az·arm + tz·thick) — so one geometry serves any size.
 */
function bracketGeometry() {
  const pos = [], corner = [], coef = [], idx = [];
  let v = 0;
  const quad = (sx, sz, c00, c10, c01, c11) => {
    for (const c of [c00, c10, c01, c11]) { pos.push(0, 0, 0); corner.push(sx, sz); coef.push(...c); }
    idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
    v += 4;
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // Arm along X: from the corner inward by `arm`, `thick` deep.
    quad(sx, sz, [0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1], [1, 0, 0, 1]);
    // Arm along Z.
    quad(sx, sz, [0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 1, 1, 0]);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute("aCoef", new THREE.Float32BufferAttribute(coef, 4));
  g.setIndex(idx);
  return g;
}

export function createSelectionFrameField({ app, max = 64, color = 0x6ab0ff }) {
  const { scene, heightTexNode } = app;
  const geo = bracketGeometry();
  const frameA = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); // x, z, halfX, halfZ
  const frameB = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4); // cos, sin, arm, thick
  const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  for (const a of [frameA, frameB, colorAttr]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aFrameA", frameA);
  geo.setAttribute("aFrameB", frameB);
  geo.setAttribute("aFrameColor", colorAttr);
  geo.instanceCount = 0;

  const vertex = Fn(() => {
    const A = attribute("aFrameA", "vec4"), B = attribute("aFrameB", "vec4");
    const c = attribute("aCorner", "vec2"), k = attribute("aCoef", "vec4");
    // Corner of the padded footprint, then inward along each arm.
    const lx = c.x.mul(A.z.add(PAD)).sub(c.x.mul(k.x.mul(B.z).add(k.z.mul(B.w))));
    const lz = c.y.mul(A.w.add(PAD)).sub(c.y.mul(k.y.mul(B.z).add(k.w.mul(B.w))));
    // Turn to the building (three's Y rotation) and move to it.
    const wx = A.x.add(lx.mul(B.x)).add(lz.mul(B.y));
    const wz = A.y.sub(lx.mul(B.y)).add(lz.mul(B.x));
    return drapedPosition(heightTexNode, wx, wz, LIFT);
  });

  const mat = new MeshBasicNodeMaterial({
    transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    depthWrite: false, depthTest: true, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  mat.forceSinglePass = true;
  mat.positionNode = vertex();
  mat.colorNode = attribute("aFrameColor", "vec3");

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  let n = 0;
  return {
    mesh,
    begin() { n = 0; },
    /**
     * Queue one frame: footprint centre (x, z), half extents (halfX, halfZ) in
     * metres, `rotY` the building's yaw.
     */
    add(x, z, halfX, halfZ, rotY = 0, tint = color) {
      if (n >= max) return;
      const arm = Math.max(1.5, Math.min(halfX, halfZ) * 0.45);
      frameA.setXYZW(n, x, z, halfX, halfZ);
      frameB.setXYZW(n, Math.cos(rotY), Math.sin(rotY), arm, 0.45);
      _col.set(tint);
      colorAttr.setXYZ(n, _col.r, _col.g, _col.b);
      n++;
    },
    commit() {
      geo.instanceCount = n;
      frameA.needsUpdate = frameB.needsUpdate = colorAttr.needsUpdate = true;
    },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
