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
import { getSharedGltfLoader } from "../../../../v3/render/foliage/glbLoader.js";
import { loadTexture } from "../../../../v3/render/textureLoad.js";

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
const kindMats = new Map(); // a kind with its own (textured) material: its Blender model
/** A kind's material: its model's own once loaded (loadPhysAssets), else the shared vertex-colour one. */
export const physMaterial = (kind) => kindMats.get(kind) ?? (sharedMat ??= new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.08 }));

// THE BLENDER MODELS (2026-10-28, user: "the oil barrel, swing gates, tyre stacks look kind of cheap … better AAA assets";
// real motorsport, the tyre first — tools/blender/thunderTyre.py): a kind listed here takes its model's geometry and
// textured material once loadPhysAssets() is done (each page awaits it before it builds a track); until then, or if a
// file is missing, the procedural look above. The model is built round the physics' own body (same radius, thickness,
// pivot), so nothing about the simulation changes. Textures through loadTexture (KTX2 when compressed: npm run textures).
const MODELS = {
  tyre: { glb: "/models/thunderline/obstacles/tyre.glb", lods: ["TyreLOD0", "TyreLOD1", "TyreLOD2"], tex: "/textures/thunderline/obstacles/tyre" },
  barrel: { glb: "/models/thunderline/obstacles/barrel.glb", lods: ["BarrelLOD0", "BarrelLOD1", "BarrelLOD2"], tex: "/textures/thunderline/obstacles/barrel", metal: true },
};
const kindLods = new Map(); // kind → its model's levels [near … far] (the game draws [0]; the asset lab all of them)
let assetsLoad = null;
/** The asset lab's view of a kind: its model (levels + material) once loaded, or null; and the procedural old look. */
export const physModel = (kind) => (kindLods.has(kind) ? { lods: kindLods.get(kind), material: kindMats.get(kind), files: MODELS[kind] } : null);
export const physOldLook = (kind) => ({ geometry: PHYS_KINDS[kind].geometry(), material: physMaterial(null) });
export function loadPhysAssets() {
  return (assetsLoad ??= Promise.all(Object.entries(MODELS).map(async ([kind, m]) => {
    try {
      const [gltf, map, normalMap, orm] = await Promise.all([
        getSharedGltfLoader().loadAsync(m.glb),
        loadTexture(`${m.tex}_color.png`, { colorSpace: THREE.SRGBColorSpace }),
        loadTexture(`${m.tex}_normal.png`, { colorSpace: THREE.NoColorSpace }),
        loadTexture(`${m.tex}_arm.png`, { colorSpace: THREE.NoColorSpace }), // (AO, roughness, metal: "_arm" keeps it linear in KTX2)
      ]);
      gltf.scene.updateMatrixWorld(true);
      const byName = new Map();
      gltf.scene.traverse((o) => { if (o.isMesh) byName.set(o.name, o); });
      const lods = m.lods.map((n) => {
        const mesh = byName.get(n);
        if (!mesh) throw new Error(`no mesh ${n} in ${m.glb}`);
        return mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      });
      const geo = lods[0];
      kindLods.set(kind, lods);
      // (u is a quarter turn, repeated: a lug straddling a quarter's edge reads past 1)
      for (const t of [map, normalMap, orm]) { t.wrapS = THREE.RepeatWrapping; t.anisotropy = 8; }
      geoCache.set(kind, geo);
      // ARM: R occlusion, G roughness, B metalness
      // (a model with bare metal — the drum's chips — reads its metalness from B too)
      kindMats.set(kind, new THREE.MeshStandardNodeMaterial({ map, normalMap, roughnessMap: orm, aoMap: orm, roughness: 1, ...(m.metal ? { metalnessMap: orm, metalness: 1 } : { metalness: 0 }) }));
    } catch (e) {
      console.warn(`[physProps] the ${kind} model is not loaded: the procedural look stays`, e?.message ?? e);
    }
  })));
}

/** The builder's look of a body set: [{kind, local Matrix4}] in the obstacle's frame (static, plain meshes). */
export function physLook(bodies) {
  const g = new THREE.Group();
  for (const b of bodies) {
    const m = new THREE.Mesh(physGeometry(b.kind), physMaterial(b.kind));
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
// THE LEVELS OF DETAIL by distance (2026-10-28, user: "hope they are optimized enough"): a model's levels drawn from
// here (m) — the asset lab's "By distance" shows the same. A tyre stack 200 m off was 3 × 5.2k triangles; now 3 × 0.45k.
export const PROP_LOD_FAR = [26, 70];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export function createPhysProps(scene, bodies, getGroundBvh, layer = null) {
  const instances = [], groups = [];
  const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const byKind = new Map();
  for (const b of bodies) (byKind.get(b.kind) ?? byKind.set(b.kind, []).get(b.kind)).push(b);
  for (const [kind, list] of byKind) {
    // ONE instanced mesh per level (a kind without a model: its one procedural look), refilled each frame by distance
    const lods = physModel(kind)?.lods ?? [physGeometry(kind)];
    const levels = lods.map((geo, li) => {
      const im = new THREE.InstancedMesh(geo, physMaterial(kind), list.length);
      im.name = `props:${kind}:lod${li}`;
      im.castShadow = true;
      im.receiveShadow = true;
      im.frustumCulled = false; // (bodies fly: the instanced bounds would go stale)
      if (layer != null) im.layers.enable(layer);
      scene.add(im);
      return im;
    });
    const group = { levels, list: [] };
    for (const b of list) {
      b.M.decompose(_p, _q, _s);
      const root = new THREE.Object3D();
      root.position.copy(_p);
      root.quaternion.copy(_q);
      const inst = { id: kind, root, authoredPos: _p.clone(), authoredQuat: _q.clone(), M: b.M.clone(), group };
      instances.push(inst);
      group.list.push(inst);
    }
    groups.push(group);
  }
  const physics = new PropPhysics({ props: { instances }, getGroundBvh });
  physics.sync();
  const _one = new THREE.Vector3(1, 1, 1);
  let moved = false;
  /** Every body into the level its distance asks for. A level left empty keeps ONE zero-size instance: still drawn,
   *  so its shader is compiled behind the loading screen with the rest, not when a prop first comes near mid-race. */
  function place(camera) {
    const cam = camera?.position;
    for (const g of groups) {
      const L = g.levels.length;
      for (const im of g.levels) im.count = 0;
      for (const inst of g.list) {
        let li = 0;
        if (L > 1 && cam) {
          const d = _p.setFromMatrixPosition(inst.M).distanceTo(cam);
          li = d > PROP_LOD_FAR[1] ? Math.min(2, L - 1) : d > PROP_LOD_FAR[0] ? 1 : 0;
        }
        const im = g.levels[li];
        im.setMatrixAt(im.count++, inst.M);
      }
      for (const im of g.levels) {
        im.userData.empty = im.count === 0;
        if (im.userData.empty) { im.setMatrixAt(0, ZERO); im.count = 1; }
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }
  place(null);
  return {
    count: instances.length,
    /** One physics tick (the drive's fixed step), after the car's. */
    tick(dt, vehicle) { if (!instances.length) return; physics.tick(dt, vehicle); moved = true; },
    /** Each frame: the bodies' poses (after ticks), then each into its level by the camera's distance. */
    sync(camera = null) {
      if (!instances.length) return;
      if (moved) {
        moved = false;
        for (const s of physics.sims) {
          if (s.asleep && !s.wasAwake && s.profile.kind !== "hinge") continue;
          s.wasAwake = !s.asleep;
          s.inst.M.compose(s.inst.root.position, s.inst.root.quaternion, _one);
        }
      }
      place(camera);
    },
    /** Everything back where it was placed (a restart). */
    reset() {
      physics.reset();
      for (const inst of instances) inst.M.compose(inst.authoredPos, inst.authoredQuat, _one);
      place(null);
    },
    get awake() { return physics.awakeCount; },
    /** (tests, the lab) how many bodies each level draws now: { kind: [n0, n1, n2] } (a lone zero-size one counts 0) */
    levelCounts() {
      const out = {};
      for (const g of groups) out[g.list[0].id] = g.levels.map((im) => (im.userData.empty ? 0 : im.count));
      return out;
    },
    dispose() { for (const g of groups) for (const im of g.levels) { scene.remove(im); im.dispose(); } groups.length = 0; },
  };
}
