// Health bars — ONE instanced quad for every bar in the game.
//
// Previously every unit and structure owned a 2-mesh bar Group (backing + fill),
// so 29 entities cost 58 draw calls to push 116 triangles. Now every bar is one
// INSTANCE of a single quad: backing, fill and the fill's left anchor are all
// done in the fragment shader, so the whole HUD is 1 draw call no matter how many
// units are alive.
//
// Bars are HUD drawn over the world (depthTest off, fog off) — see
// structuresRenderer.js for why `fog: false` also matters for static entities.
import * as THREE from "three";
import { attribute, uv, step, mix, vec3, float } from "three/tsl";

const BG = new THREE.Color(0x0b0e13);
const OK = new THREE.Color(0x3ddc60);
const WARN = new THREE.Color(0xf5c542);
const LOW = new THREE.Color(0xe4483a);
const HOSTILE = new THREE.Color(0xe4483a);

const BORDER = 0.09; // world units of backing visible around the fill (all sides)

const _obj = new THREE.Object3D();
const _col = new THREE.Color();

/**
 * A pool of camera-facing health bars drawn in a single instanced draw call.
 *
 * Per frame: `begin()`, one `add()` per live entity, then `commit()`. Bars that
 * aren't re-added simply fall out of the instance count — nothing to hide.
 */
export function createHealthBarField({ scene, max = 512, height = 0.55 }) {
  const geo = new THREE.PlaneGeometry(1, 1); // unit quad; instance matrix sizes it

  const fracAttr = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
  const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  // Border width in UV space. It varies per bar because bars differ in world
  // width, and we want a constant-thickness border, not a proportional one.
  const marginAttr = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2);
  geo.setAttribute("barFrac", fracAttr);
  geo.setAttribute("barColor", colorAttr);
  geo.setAttribute("barMargin", marginAttr);

  const frac = attribute("barFrac", "float");
  const color = attribute("barColor", "vec3");
  const margin = attribute("barMargin", "vec2");

  const p = uv();
  const one = float(1);
  // Inside the border? (a 2D box test, branch-free)
  const inside = step(margin.x, p.x)
    .mul(step(p.x, one.sub(margin.x)))
    .mul(step(margin.y, p.y))
    .mul(step(p.y, one.sub(margin.y)));
  // How far across the FILL AREA this pixel is, 0 at its left edge → 1 at right.
  const acrossFill = p.x.sub(margin.x).div(one.sub(margin.x.mul(2)));
  const filled = inside.mul(step(acrossFill, frac)); // left-anchored, like the old mesh

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthTest: false, depthWrite: false, fog: false,
  });
  mat.colorNode = mix(vec3(BG), color, filled);
  mat.opacityNode = mix(float(0.85), one, filled); // backing is translucent, fill is solid

  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.count = 0;
  mesh.frustumCulled = false; // instances live anywhere; the bounding box is meaningless
  mesh.renderOrder = 1001;
  scene.add(mesh);

  let n = 0;

  return {
    mesh,

    begin() { n = 0; },

    /** Queue one bar. `width` is the bar's world width; `frac` is hp/maxHp. */
    add(x, y, z, width, frac, hostile, camera) {
      if (n >= max) return;

      const w = width + BORDER * 2;
      const h = height + BORDER * 2;

      _obj.position.set(x, y, z);
      if (camera) _obj.quaternion.copy(camera.quaternion); // billboard
      _obj.scale.set(w, h, 1);
      _obj.updateMatrix();
      mesh.setMatrixAt(n, _obj.matrix);

      const f = THREE.MathUtils.clamp(frac, 0, 1);
      fracAttr.setX(n, f);

      _col.copy(hostile ? HOSTILE : f > 0.6 ? OK : f > 0.3 ? WARN : LOW);
      colorAttr.setXYZ(n, _col.r, _col.g, _col.b);

      marginAttr.setXY(n, BORDER / w, BORDER / h);

      n++;
    },

    commit() {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      fracAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      marginAttr.needsUpdate = true;
    },

    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}
