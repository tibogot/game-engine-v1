// THUNDERLINE'S TYRE MARKS (user, 2026-10-22: "of course we need some nice tyre marks too"). From the old
// game's modularRoadTireMarks.js (left as it is: the parts bin) — its ring buffer, its skid texture used
// as an alpha mask, its alpha ramped across segment joins — changed for a stunt track that is not flat:
//   - the ribbon lies ACROSS THE CONTACT NORMAL (the old one was laid horizontally, side = (dz, 0, −dx):
//     on a bank, a wall, a loop or in a tube it stood on edge or vanished);
//   - the slide is measured in the wheel's own frame (the old drift angle compared HORIZONTAL headings,
//     meaningless up a wall or upside down);
//   - all four wheels, and TOUCHDOWN SCUFFS: a short dark mark where a wheel hits the road hard after
//     a jump (the harder, the darker and longer).
// One mesh, one draw call; nothing allocated while driving.
import * as THREE from "three";
import { Fn, attribute, texture, uniform, float } from "three/tsl";
import { WHEEL } from "../../../../v3/play/modularRoadVehicle.js";

export const TYRE_MARKS = {
  color: 0x050506,
  lift: 0.045, // m off the road along its normal (+ a polygon offset): never in its plane
  widthFrac: 0.92, // of the tyre's width
  tile: 6, // m of road per repeat of the skid texture
  entrySpeed: 8, // m/s before a slide marks the road
  slipMin: 0.18, // lateral / longitudinal at the wheel: from here it marks…
  slipFull: 0.7, // …fully dark here
  brakeMark: 0.75, // a tyre past its grip lengthwise (braking, wheelspin) marks too, a little lighter
  touchSpeed: 3.5, // m/s into the road at touchdown before it scuffs
  touchFull: 11, // m/s for the darkest scuff
  touchTime: 0.14, // s a touchdown scuff lasts
};
export const SKID_TEXTURE_URL = "/textures/skid_mark01.png";

const MAX_SEGMENTS = 6144;
const VERTS = 6;
const POS_F = VERTS * 3, A_F = VERTS, UV_F = VERTS * 2;
const MIN_SEGMENT = 0.035;
const ATTRS = [["position", POS_F], ["aAlpha", A_F], ["uv", UV_F]];
const PREV_VERTS = [0, 1, 3]; // (pL, pR, cL, pR, cR, cL): the previous edge's vertices

const _dir = new THREE.Vector3(), _side = new THREE.Vector3(), _v = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _p = new THREE.Vector3();
const _pL = new THREE.Vector3(), _pR = new THREE.Vector3(), _cL = new THREE.Vector3(), _cR = new THREE.Vector3();
const QUAD = [_pL, _pR, _cL, _pR, _cR, _cL];

export function createTyreMarks(scene, settings = TYRE_MARKS) {
  const s = settings;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(MAX_SEGMENTS * POS_F), alphas = new Float32Array(MAX_SEGMENTS * A_F), uvs = new Float32Array(MAX_SEGMENTS * UV_F);
  const attr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", attr(positions, 3));
  geometry.setAttribute("aAlpha", attr(alphas, 1));
  geometry.setAttribute("uv", attr(uvs, 2));
  geometry.setDrawRange(0, 0);

  // colour from a uniform; the skid PNG (pure black, its detail in ALPHA) only masks; the fade per vertex
  const tint = uniform(new THREE.Color(s.color));
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const setMask = (tex) => {
    const a = attribute("aAlpha", "float");
    material.colorNode = tint;
    material.opacityNode = Fn(() => (tex ? a.mul(texture(tex).a) : a.mul(float(0.8))))();
    material.needsUpdate = true;
  };
  setMask(null); // a plain ribbon for the frame or two before the PNG arrives
  new THREE.TextureLoader().load(SKID_TEXTURE_URL, (tex) => {
    tex.wrapS = THREE.MirroredRepeatWrapping; // it does not tile: mirrored, each repeat meets itself
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8; // seen at a grazing angle
    setMask(tex);
  }, undefined, () => console.warn("[tyreMarks] skid texture failed: plain ribbons"));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 20;
  mesh.visible = false;
  mesh.receiveShadow = false;
  scene.add(mesh);

  let seg = 0, drawn = 0, dirtyLo = -1, dirtyHi = -1;
  /** Upload the segments written this frame: one range per attribute (two if the ring wrapped). */
  function flush() {
    if (dirtyLo < 0) return;
    const ranges = dirtyHi >= dirtyLo ? [[dirtyLo, dirtyHi]] : [[dirtyLo, MAX_SEGMENTS - 1], [0, dirtyHi]];
    for (const [name, per] of ATTRS) {
      const a = geometry.attributes[name];
      for (const [lo, hi] of ranges) a.addUpdateRange(lo * per, (hi - lo + 1) * per);
      a.needsUpdate = true;
    }
    dirtyLo = dirtyHi = -1;
  }
  const states = [0, 1, 2, 3].map(() => ({ prev: new THREE.Vector3(), prevN: new THREE.Vector3(), active: false, dist: 0, prevAlpha: 0, wasGrounded: true, touch: 0, touchK: 0 }));

  function addSegment(st, curr, n, alpha) {
    _dir.subVectors(curr, st.prev);
    const len = _dir.length();
    if (len < MIN_SEGMENT) return false;
    _dir.multiplyScalar(1 / len);
    // across the road: ⊥ the travel AND the contact normal
    _side.crossVectors(_dir, n);
    if (_side.lengthSq() < 1e-8) return false;
    _side.normalize().multiplyScalar(WHEEL.thickness * s.widthFrac * 0.5);
    _pL.copy(st.prev).add(_side); _pR.copy(st.prev).sub(_side);
    _cL.copy(curr).add(_side); _cR.copy(curr).sub(_side);
    const o = seg * POS_F;
    for (let i = 0; i < VERTS; i++) { const q = QUAD[i]; positions[o + i * 3] = q.x; positions[o + i * 3 + 1] = q.y; positions[o + i * 3 + 2] = q.z; }
    // the alpha ramps across the segment (no step at the joins: a ladder of patches otherwise)
    const ao = seg * A_F;
    for (let i = 0; i < VERTS; i++) alphas[ao + i] = PREV_VERTS.includes(i) ? st.prevAlpha : alpha;
    st.prevAlpha = alpha;
    // u along the mark by real distance, v across
    const u0 = st.dist / s.tile;
    st.dist += len;
    const u1 = st.dist / s.tile;
    const uo = seg * UV_F;
    uvs[uo] = u0; uvs[uo + 1] = 0; uvs[uo + 2] = u0; uvs[uo + 3] = 1; uvs[uo + 4] = u1; uvs[uo + 5] = 0;
    uvs[uo + 6] = u0; uvs[uo + 7] = 1; uvs[uo + 8] = u1; uvs[uo + 9] = 1; uvs[uo + 10] = u1; uvs[uo + 11] = 0;
    // the segments written this frame, uploaded together at its end (flush): one range per attribute
    if (dirtyLo < 0) dirtyLo = seg;
    dirtyHi = seg;
    seg = (seg + 1) % MAX_SEGMENTS;
    if (drawn < MAX_SEGMENTS * VERTS) { drawn += VERTS; geometry.setDrawRange(0, drawn); }
    mesh.visible = true;
    return true;
  }

  function track(st, point, n, alpha) {
    if (!point || alpha <= 0) { st.active = false; return; }
    // a new mark — or a jump of over 2 m in one frame (a respawn): start again there, no bridge across
    if (!st.active || st.prev.distanceToSquared(point) > 4) { st.dist = 0; st.prevAlpha = 0; st.prev.copy(point); st.prevN.copy(n); st.active = true; return; }
    if (addSegment(st, point, n, alpha)) { st.prev.copy(point); st.prevN.copy(n); }
  }

  return {
    mesh, settings: s,
    reset() {
      seg = 0; drawn = 0; dirtyLo = dirtyHi = -1;
      geometry.setDrawRange(0, 0);
      mesh.visible = false;
      for (const st of states) { st.active = false; st.dist = 0; st.touch = 0; st.wasGrounded = true; }
    },
    /** Each frame, after the car moved (its tyres' contacts are this frame's). */
    update(vehicle, dt) {
      if (!vehicle?.enabled) { for (const st of states) st.active = false; return; }
      const body = vehicle.body;
      _fwd.set(0, 0, 1).applyQuaternion(body.quat);
      _right.set(1, 0, 0).applyQuaternion(body.quat);
      const handbrake = !!vehicle.input?.handbrake;
      for (let i = 0; i < vehicle.tires.length && i < states.length; i++) {
        const tire = vehicle.tires[i], st = states[i];
        if (!tire.grounded) { st.active = false; st.wasGrounded = false; continue; }
        body.getVelocityAtPoint(tire.worldPos, _v);
        // TOUCHDOWN: the wheel was in the air, it meets the road fast → a short dark scuff
        if (!st.wasGrounded) {
          const into = -_v.dot(tire.hitNormal);
          if (into > s.touchSpeed) { st.touch = s.touchTime; st.touchK = THREE.MathUtils.clamp((into - s.touchSpeed) / (s.touchFull - s.touchSpeed), 0.35, 1); }
        }
        st.wasGrounded = true;
        // the slide, in the wheel's frame on the road's plane
        _v.addScaledVector(tire.hitNormal, -_v.dot(tire.hitNormal));
        const speed = _v.length();
        const vLat = Math.abs(_v.dot(_right)), vLong = Math.abs(_v.dot(_fwd));
        const slip = vLat / Math.max(vLong, 3.5);
        const gate = THREE.MathUtils.smoothstep(speed, s.entrySpeed, s.entrySpeed * 2);
        let k = THREE.MathUtils.clamp((slip - s.slipMin) / (s.slipFull - s.slipMin), 0, 1) * gate;
        k = Math.max(k, THREE.MathUtils.clamp((tire.overDemand ?? 0) * s.brakeMark, 0, 1) * gate);
        if (handbrake && !tire.canSteer) k = Math.max(k, 0.6 * gate);
        if (st.touch > 0) { k = Math.max(k, st.touchK); st.touch -= dt; }
        _p.copy(tire.hitPoint).addScaledVector(tire.hitNormal, s.lift);
        track(st, k > 0.02 ? _p : null, tire.hitNormal, k);
      }
      flush();
    },
  };
}
