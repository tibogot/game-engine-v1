import * as THREE from "three";

/**
 * Demo moving/kinematic platforms (translation-only: vertical elevator +
 * horizontal slider) for the on-foot capsule controller. Each platform is an
 * axis-aligned box, so it stays an AABB as it moves — collision + carry are
 * handled analytically by CapsuleController (these meshes are NOT baked into the
 * BVH). Call update(dt) BEFORE the controller so .box / .delta reflect the frame.
 *
 * `getGroundY(x,z)` (optional) sets each platform's base height from the terrain
 * so they sit at ground level wherever the demo positions land.
 *
 * Each platform exposes: .box { minX..maxZ }, .delta { x,y,z }, .mesh.
 */
export function createMovingPlatforms(scene, getGroundY = null) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd2a64a,
    roughness: 0.55,
    metalness: 0.1,
  });

  const groundAt = (x, z) => {
    const y = getGroundY ? getGroundY(x, z) : 0;
    return Number.isFinite(y) ? y : 0;
  };

  const defs = [
    // Vertical elevator — rises 0..2*amp above the ground at its spot.
    { id: "elevator", w: 4, hh: 0.4, l: 4, x: 0, z: 12, axis: "y", amp: 2.6, speed: 0.6, phase: 0, yLift: 0 },
    // Horizontal slider — glides along X just above the ground.
    { id: "slider", w: 4, hh: 0.4, l: 4, x: 0, z: -12, axis: "x", amp: 5.0, speed: 0.7, phase: 1.4, yLift: 0.6 },
  ];

  const platforms = defs.map((d) => {
    const baseY = groundAt(d.x, d.z) + d.yLift + d.hh * 0.5;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(d.w, d.hh, d.l), mat.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const p = {
      id: d.id,
      mesh,
      def: d,
      baseX: d.x,
      baseY,
      baseZ: d.z,
      _t: d.phase,
      prevX: 0,
      prevY: 0,
      prevZ: 0,
      delta: { x: 0, y: 0, z: 0 },
      box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      hx: d.w * 0.5,
      hy: d.hh * 0.5,
      hz: d.l * 0.5,
    };
    place(p);
    refreshBox(p);
    scene.add(mesh);
    return p;
  });

  function place(p) {
    const d = p.def;
    const off = Math.sin(p._t) * d.amp;
    let x = p.baseX;
    let y = p.baseY;
    let z = p.baseZ;
    if (d.axis === "y") y = p.baseY + off + d.amp; // stay above the base, never below
    else if (d.axis === "x") x = p.baseX + off;
    else if (d.axis === "z") z = p.baseZ + off;
    p.mesh.position.set(x, y, z);
  }

  function refreshBox(p) {
    const c = p.mesh.position;
    p.box.minX = c.x - p.hx;
    p.box.maxX = c.x + p.hx;
    p.box.minY = c.y - p.hy;
    p.box.maxY = c.y + p.hy;
    p.box.minZ = c.z - p.hz;
    p.box.maxZ = c.z + p.hz;
  }

  function update(dt) {
    for (const p of platforms) {
      p.prevX = p.mesh.position.x;
      p.prevY = p.mesh.position.y;
      p.prevZ = p.mesh.position.z;
      p._t += dt * p.def.speed;
      place(p);
      p.delta.x = p.mesh.position.x - p.prevX;
      p.delta.y = p.mesh.position.y - p.prevY;
      p.delta.z = p.mesh.position.z - p.prevZ;
      refreshBox(p);
    }
  }

  function setVisible(v) {
    for (const p of platforms) p.mesh.visible = v;
  }

  function dispose() {
    for (const p of platforms) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mesh.material.dispose();
    }
    platforms.length = 0;
  }

  return { platforms, update, setVisible, dispose };
}
