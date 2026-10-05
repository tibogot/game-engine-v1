// ── Horse lab: the rider's cowboy hat (low-poly, procedural) ─────────────────
// A crown with a pinched top and a brim curled up at the sides, sized to the
// robot's head and parented to its head bone, so it follows every move.
import * as THREE from "three";

const V3 = THREE.Vector3;

function hatGeometry(r) {
  // brim: a lathe profile, then the sides bent up (x = across the head)
  const brimProfile = [];
  const R0 = r * 0.9, R1 = r * 2.05;
  for (let i = 0; i <= 6; i++) { const u = i / 6, x = R0 + (R1 - R0) * u; brimProfile.push(new THREE.Vector2(x, u * u * 0.04 * r)); }
  for (let i = 6; i >= 0; i--) { const u = i / 6, x = R0 + (R1 - R0) * u; brimProfile.push(new THREE.Vector2(x, u * u * 0.04 * r - 0.06 * r)); }
  const brim = new THREE.LatheGeometry(brimProfile, 24);
  const p = brim.attributes.position, v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const d = Math.hypot(v.x, v.z), side = Math.abs(v.x) / Math.max(d, 1e-6);   // 1 at the sides, 0 front / back
    const out = Math.max(0, (d - R0) / (R1 - R0));
    v.y += out * out * side * side * 0.75 * r;                                    // sides curl up
    v.z *= 1.12;                                                                  // a little longer than wide
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // crown: tapered, a crease along the top
  const crownProfile = [
    new THREE.Vector2(r * 0.95, 0), new THREE.Vector2(r * 0.92, r * 0.5), new THREE.Vector2(r * 0.86, r * 1.0),
    new THREE.Vector2(r * 0.55, r * 1.12), new THREE.Vector2(0.001, r * 1.05),
  ];
  const crown = new THREE.LatheGeometry(crownProfile, 20);
  const q = crown.attributes.position;
  for (let i = 0; i < q.count; i++) {
    v.fromBufferAttribute(q, i);
    v.z *= 1.15;
    if (v.y > r * 0.9) v.y -= Math.exp(-(v.x * v.x) / (r * r * 0.05)) * r * 0.18;   // the crease
    q.setXYZ(i, v.x, v.y, v.z);
  }
  // band
  const band = new THREE.CylinderGeometry(r * 0.955, r * 0.97, r * 0.2, 20, 1, true);
  band.scale(1, 1, 1.15); band.translate(0, r * 0.1, 0);
  for (const g of [brim, crown, band]) { g.deleteAttribute("uv"); g.deleteAttribute("normal"); }
  return { brim: brim.toNonIndexed(), crown: crown.toNonIndexed(), band: band.toNonIndexed() };
}

export function addHat(rider) {
  const head = rider.B.head, r = rider.r;
  r.rig.updateMatrixWorld(true);
  // the head's size and top from the skinned mesh around the head bone
  const hp = head.getWorldPosition(new V3());
  let top = -Infinity, w = 0;
  r.model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const pos = o.geometry.attributes.position, p = new V3();
    for (let i = 0; i < pos.count; i++) {
      o.getVertexPosition(i, p); p.applyMatrix4(o.matrixWorld);
      if (Math.hypot(p.x - hp.x, p.z - hp.z) < 0.16 && p.y > hp.y && p.y < hp.y + 0.35) { top = Math.max(top, p.y); w = Math.max(w, Math.hypot(p.x - hp.x, p.z - hp.z)); }   // the head only (a wider sphere took in the shoulders)
    }
  });
  const R = Math.min(0.11, Math.max(0.08, w * 0.9));
  const G = hatGeometry(R);
  const mat = (c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true });
  const hat = new THREE.Group();
  for (const [g, c] of [[G.brim, 0x3a2416], [G.crown, 0x3a2416], [G.band, 0x1c120c]]) {
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat(c)); m.castShadow = true; hat.add(m);
  }
  // sit it on the head: world placement (level, facing the rider's forward), then parent to the bone
  r.rig.add(hat);
  hat.position.copy(r.rig.worldToLocal(new V3(hp.x, top - R * 0.75, hp.z)));
  hat.rotation.x = -0.08;                                    // brim tipped a touch down at the front
  hat.updateMatrixWorld(true);
  head.attach(hat);
  rider.hat = hat;
  return hat;
}
