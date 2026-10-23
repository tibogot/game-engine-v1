// KNOCKABLE PROPS (user, 2026-10-23: "the orange cones … I'm sure there were other things" — the old game's
// cones, tyres, oil barrels and swing gate). THE PHYSICS IS THE OLD GAME'S, unchanged
// (games/modular-road-v3/modularRoadPropPhysics.js: free rigid bodies on its contact solver, the gate a
// sprung hinge; ONE-WAY — the car shoves them, they never push the car, so the tuned driving, the test lap
// and the ghost's bit-for-bit replay are untouched). THE LOOK IS THUNDERLINE'S OWN, built for cost: the old
// make() gave every cone four meshes and four new materials; here each KIND is one geometry (its colours
// baked into the vertices) drawn as ONE InstancedMesh for all of that kind on the track, its matrices
// copied from the physics each frame. Sizes and pivots come from the old physics' own constants (CONE_SCALE,
// TIRE_*, BARREL_HEIGHT, GATE_*), so the body you see is the body that is simulated.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  PropPhysics, PHYSICS_PROP_TYPES, CONE_SCALE, TIRE_OUTER_R, TIRE_TUBE_R, BARREL_HEIGHT,
  GATE_WIDTH, GATE_HEIGHT, GATE_BASE_Y, GATE_POST_RADIUS, GATE_POST_HEIGHT,
} from "../../../modular-road-v3/modularRoadPropPhysics.js";

/** One colour into a geometry's vertices (and nothing but position / normal / color: mergeable). */
function paint(geo, hex) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}
const ORANGE = 0xf4581a, WHITE = 0xeef0f2, RUBBER = 0x1a1a1c, STEEL = 0x8f969e, RED = 0xe0242b, BOLT = 0x3fd2ff;

/** Each kind: its geometry (root at the BODY's pivot, as the old physics simulates it) and `lift`, the
 * pivot's height over the road when it stands as placed. */
function coneGeometry() {
  const S = CONE_SCALE, R = PHYSICS_PROP_TYPES.cone.radius;
  // the old cone's lathe: a truncated, slightly concave taper with a flat top, on a square flanged base
  const prof = [[0.278, 0], [0.263, 0.033], [0.198, 0.045], [0.177, 0.083], [0.15, 0.21], [0.119, 0.42], [0.083, 0.66], [0.057, 0.84], [0.051, 0.93], [0, 0.93]]
    .map(([x, y]) => new THREE.Vector2(x * S, y * S));
  const collar = (y0, h, rB, rT) => paint(new THREE.CylinderGeometry(rT * 1.012, rB * 1.012, h, 20, 1, true).translate(0, y0 + h / 2, 0), WHITE);
  return mergeGeometries([
    paint(new THREE.BoxGeometry(0.55 * S, 0.042 * S, 0.55 * S).translate(0, 0.021 * S, 0), RUBBER),
    paint(new THREE.LatheGeometry(prof, 20), ORANGE),
    collar(0.45 * S, 0.17 * S, 0.113 * S, 0.097 * S),
    collar(0.7 * S, 0.105 * S, 0.076 * S, 0.067 * S),
  ]).translate(0, -R, 0);
}
function tyreGeometry() {
  const outer = TIRE_OUTER_R, hw = TIRE_TUBE_R, inner = outer - hw * 1.55, s = TIRE_OUTER_R / 0.35;
  const prof = [[inner, -hw * 0.88], [inner + 0.02 * s, -hw], [outer - 0.07 * s, -hw], [outer - 0.012 * s, -hw * 0.5], [outer, -hw * 0.22], [outer - 0.01 * s, 0],
    [outer, hw * 0.22], [outer - 0.012 * s, hw * 0.5], [outer - 0.07 * s, hw], [inner + 0.02 * s, hw], [inner, hw * 0.88], [inner, -hw * 0.88]].map(([x, y]) => new THREE.Vector2(x, y));
  return mergeGeometries([
    paint(new THREE.LatheGeometry(prof, 28), RUBBER),
    // a bolt-blue band round the tread: Thunderline's mark, and it reads in the dark
    paint(new THREE.CylinderGeometry(outer * 1.004, outer * 1.004, hw * 0.34, 28, 1, true), BOLT),
  ]);
}
function barrelGeometry() {
  const H = BARREL_HEIGHT, r = H * 0.33;
  const parts = [paint(new THREE.CylinderGeometry(r, r, H, 24), RED)];
  // two rolling hoops and the lid ring
  for (const y of [-H * 0.22, H * 0.22]) parts.push(paint(new THREE.TorusGeometry(r * 1.01, 0.03, 6, 24).rotateX(Math.PI / 2).translate(0, y, 0), STEEL));
  parts.push(paint(new THREE.TorusGeometry(r * 0.98, 0.025, 6, 24).rotateX(Math.PI / 2).translate(0, H / 2, 0), STEEL));
  return mergeGeometries(parts);
}
function gateGeometry() {
  const W = GATE_WIDTH, H = GATE_HEIGHT;
  // the post on the hinge axis (its collision is a static solid: obstacles.js), the panel along +X;
  // a red panel with two white chevrons pointing the way it opens
  const parts = [
    paint(new THREE.CylinderGeometry(GATE_POST_RADIUS, GATE_POST_RADIUS, GATE_POST_HEIGHT, 10).translate(0, GATE_POST_HEIGHT / 2, 0), STEEL),
    paint(new THREE.BoxGeometry(W, H, 0.09).translate(W / 2, GATE_BASE_Y + H / 2, 0), RED),
  ];
  for (const x of [W * 0.33, W * 0.66]) {
    const chev = new THREE.Shape([new THREE.Vector2(-0.3, -0.45), new THREE.Vector2(0.05, 0), new THREE.Vector2(-0.3, 0.45), new THREE.Vector2(-0.1, 0.45), new THREE.Vector2(0.25, 0), new THREE.Vector2(-0.1, -0.45)]);
    for (const z of [0.05, -0.05]) parts.push(paint(new THREE.ShapeGeometry(chev).rotateY(z > 0 ? 0 : Math.PI).translate(x, GATE_BASE_Y + H / 2, z), WHITE));
  }
  return mergeGeometries(parts);
}
export const PHYS_KINDS = {
  cone: { geometry: coneGeometry, lift: PHYSICS_PROP_TYPES.cone.radius },
  tyre: { geometry: tyreGeometry, lift: TIRE_TUBE_R },
  barrel: { geometry: barrelGeometry, lift: BARREL_HEIGHT / 2 },
  gate: { geometry: gateGeometry, lift: 0 },
};
const geoCache = new Map();
export const physGeometry = (kind) => geoCache.get(kind) ?? geoCache.set(kind, PHYS_KINDS[kind].geometry()).get(kind);
let sharedMat = null;
export const physMaterial = () => (sharedMat ??= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.08 }));

/** The builder's look of a body set: [{kind, local Matrix4}] in the obstacle's frame (static, plain meshes). */
export function physLook(bodies) {
  const g = new THREE.Group();
  for (const b of bodies) {
    const m = new THREE.Mesh(physGeometry(b.kind), physMaterial());
    m.matrixAutoUpdate = false;
    m.matrix.copy(b.local);
    g.add(m);
  }
  return g;
}
/** The same set as one merged geometry (the placement preview). */
export function physGhost(bodies) {
  return mergeGeometries(bodies.map((b) => physGeometry(b.kind).clone().applyMatrix4(b.local)));
}
/** A body standing on the road at (x, z) of the obstacle's frame, turned `yaw` (rad), `up` m higher. */
export const body = (kind, x = 0, z = 0, yaw = 0, up = 0) => ({ kind, local: new THREE.Matrix4().makeRotationY(yaw).setPosition(x, PHYS_KINDS[kind].lift + up, z) });

/**
 * The drive page's props: the old physics over Thunderline's instanced look.
 * @param scene
 * @param bodies [{kind, M}] world matrices of each body's pivot as placed (obstacles.js buildObstacleSet)
 * @param getGroundBvh () => the car's deck BVH (props rest on and slide over the road)
 * @param layer the shadow layer for moving things (sunShadows DYNAMIC_LAYER)
 */
export function createPhysProps(scene, bodies, getGroundBvh, layer = null) {
  const instances = [], meshes = new Map();
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const byKind = new Map();
  for (const b of bodies) (byKind.get(b.kind) ?? byKind.set(b.kind, []).get(b.kind)).push(b);
  for (const [kind, list] of byKind) {
    const im = new THREE.InstancedMesh(physGeometry(kind), physMaterial(), list.length);
    im.name = `props:${kind}`;
    im.castShadow = true;
    im.receiveShadow = true;
    im.frustumCulled = false; // (bodies fly: the instanced bounds would go stale)
    if (layer != null) im.layers.enable(layer);
    scene.add(im);
    meshes.set(kind, im);
    list.forEach((b, i) => {
      b.M.decompose(_p, _q, _s);
      const root = new THREE.Object3D();
      root.position.copy(_p);
      root.quaternion.copy(_q);
      instances.push({ id: kind, root, authoredPos: _p.clone(), authoredQuat: _q.clone(), im, i });
      im.setMatrixAt(i, b.M);
    });
    im.instanceMatrix.needsUpdate = true;
  }
  const physics = new PropPhysics({ props: { instances }, getGroundBvh });
  physics.sync();
  const _m = new THREE.Matrix4(), _one = new THREE.Vector3(1, 1, 1);
  let moved = false;
  return {
    count: instances.length,
    /** One physics tick (the drive's fixed step), after the car's. */
    tick(dt, vehicle) { if (!instances.length) return; physics.tick(dt, vehicle); moved = true; },
    /** Each frame: the bodies' poses into their instances (only after ticks). */
    sync() {
      if (!moved) return;
      moved = false;
      const dirty = new Set();
      for (const s of physics.sims) {
        if (s.asleep && !s.wasAwake && s.profile.kind !== "hinge") continue;
        s.wasAwake = !s.asleep;
        const inst = s.inst;
        inst.im.setMatrixAt(inst.i, _m.compose(inst.root.position, inst.root.quaternion, _one));
        dirty.add(inst.im);
      }
      for (const im of dirty) im.instanceMatrix.needsUpdate = true;
    },
    /** Everything back where it was placed (a restart). */
    reset() {
      physics.reset();
      for (const inst of instances) inst.im.setMatrixAt(inst.i, _m.compose(inst.authoredPos, inst.authoredQuat, _one));
      for (const im of meshes.values()) im.instanceMatrix.needsUpdate = true;
    },
    get awake() { return physics.awakeCount; },
    dispose() { for (const im of meshes.values()) { scene.remove(im); im.dispose(); } meshes.clear(); },
  };
}
