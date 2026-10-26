// STYLIZED TREES — broadleaf trees in the "cauliflower" style of stylized Unreal scenes, as a lab
// prototype (it draws its own instanced meshes; nothing in the engine's tree stack is touched).
//
// Why the arborist trees look flat next to that style: their whole canopy is ONE sphere of leaf
// cards shaded with ONE sphere normal, so the crown reads as a single soft ball with no light and
// dark side of its own. Their LEAF is right (the branch mask on big camera-facing cards gives the
// soft, full silhouette) and is kept. What changes is the crown, 9-12 CLUMPS:
//  - each card's shading normal is its clump's sphere normal (blended a little toward the
//    crown's), curving across the card, so each clump is a lit dome with a dark underside;
//  - a baked occlusion per card: deep inside a clump, low in the crown, under another clump;
//  - the scene's sun shadows land on the cards, so clumps shadow the clumps below them (the
//    cards face the LIGHT in the shadow pass, so the shadows do not move as the camera orbits);
//  - light through the leaves toward the sun (thin outer leaves glow, the core stays dark);
//  - per-tree tint.
// Three LODs (fewer, larger cards with distance; the far one casts no shadow), picked per tree by
// distance when the camera moves.
//
// Use: const trees = createStylizedTrees({ scene, trees: [[x, z, y, rotY, scale], ...] });
//      per frame: trees.update(camera, { sunDir, sunColor })

import * as THREE from "three/webgpu";
import {
  Fn, attribute, uniform, texture, vec2, vec3, float, mix, pow, saturate, dot, normalize, smoothstep,
  positionWorld, cameraPosition, instanceIndex, hash, transformNormalToView,
  positionLocal, cameraViewMatrix, cross, select,
} from "three/tsl";
import { applyAlphaCutout } from "../render/materials/alphaCutout.js";

export const STYLIZED_TREE_DEFAULTS = {
  topColor: "#7cc63c",
  bottomColor: "#1f5418",
  /** how much the baked occlusion darkens the albedo (not only the ambient) */
  aoColor: 0.5,
  /** metres the sun-shadow lookup moves toward the sun: ~ a clump's radius (see the material) */
  shadowLift: 1.4,
  /** light through the leaves when looking toward the sun */
  translucency: 0.35,
  translucencyColor: "#b8e05a",
  /** per-tree brightness spread */
  tintVar: 0.18,
  /** metres the crown (and the branches) sit higher than built: a longer bare trunk */
  crownLift: 1.5,
  /** 1 = every card faces the camera (soft, full crown from any side; the leaves turn as you
   *  orbit), 0 = cards fixed on their clump like real foliage (still, but edge-on at grazing
   *  angles); between = a blend */
  faceCamera: 1,
  /** smooth leaf edges with MSAA (see render/materials/alphaCutout.js); pass renderer.samples > 1 */
  alphaToCoverage: true,
  lodDist: 150,
  /** past this the trees are the far LOD and cast no shadow (the sun's cascades end near here) */
  farDist: 450,
  maxDist: 1600,
};

// ------------------------------------------------------------------ seeded random
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

// ------------------------------------------------------------------ leaf mask
// The arborist preset's own branch mask (tree110: Leaf-Billboard-Texture-1, the shape is in .r).
const LEAF_MASK_URL = "/textures/leaves/Leaf-Billboard-Texture-1.png";
function loadLeafMask() {
  const tex = new THREE.TextureLoader().load(LEAF_MASK_URL);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------------------------ one tree's geometry
function buildTree(seed, lod) {
  const r = rng(seed);
  const crown = new THREE.Vector3(0, 5.2 + r() * 0.7, 0);
  const rad = new THREE.Vector3(3.1 + r() * 0.5, 2.9 + r() * 0.5, 3.1 + r() * 0.5);

  // clumps: one on top, a ring round the crown, one filling the core
  const clumps = [{ c: crown.clone().add(new THREE.Vector3(0, rad.y * 0.62, 0)), r: 1.9 + r() * 0.3 }];
  const ring = 8 + Math.floor(r() * 4);
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 + r() * 0.5;
    const el = -0.25 + r() * 0.85;
    const d = new THREE.Vector3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    clumps.push({ c: crown.clone().add(d.multiply(rad).multiplyScalar(0.68)), r: 1.45 + r() * 0.55 });
  }
  clumps.push({ c: crown.clone(), r: 2.3 });

  // Camera-facing cards (the arborist look: the branch mask on big billboards gives the soft,
  // full silhouette). Every vertex of a card sits at the card's CENTRE; the material pushes it
  // out to its corner along the camera's axes. `cardO` = that corner (metres, in-plane spin
  // baked in), `clumpInvR` lets the shading normal curve across the card over its clump.
  const pos = [], nrm = [], uvs = [], ao = [], hgt = [], corner = [], idx = [];
  const tmp = new THREE.Vector3();
  // near: many cards; mid: a few large ones; far: two per clump (no shadow at that range)
  const cards = [11, 4, 2][lod];
  const sizeK = [1, 1.35, 1.7][lod];
  const yLo = crown.y - rad.y, yHi = crown.y + rad.y * 1.25;

  for (let ci = 0; ci < clumps.length; ci++) {
    const { c, r: cr } = clumps[ci];
    const core = ci === clumps.length - 1;
    const n = core ? Math.ceil(cards * 0.5) : cards;
    const outward = c.clone().sub(crown).normalize();
    for (let k = 0; k < n; k++) {
      // a point in the clump, leaning out of the crown (the inside is never seen)
      tmp.set(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
      if (!core) tmp.addScaledVector(outward, 0.6).normalize();
      const p = c.clone().addScaledVector(tmp, cr * (0.3 + r() * 0.45));
      // shading normal at the centre: the clump's sphere, a little of the crown's ellipsoid
      const nc = p.clone().sub(c).normalize();
      const ne = p.clone().sub(crown).divide(rad).normalize();
      const nn = nc.multiplyScalar(0.7).addScaledVector(ne, 0.3).normalize();
      // occlusion: depth in the clump x height in the crown x clumps overhead
      const depth = Math.min(1, p.distanceTo(c) / cr);
      let a = (0.4 + 0.6 * smooth01((depth - 0.2) / 0.8)) * (0.5 + 0.5 * smooth01((p.y - yLo) / (yHi - yLo)));
      for (let j = 0; j < clumps.length - 1; j++) {
        if (j === ci) continue;
        const o = clumps[j];
        if (o.c.y > p.y + 0.4 && Math.hypot(o.c.x - p.x, o.c.z - p.z) < o.r) a *= 0.8;
      }
      if (core) a *= 0.6;
      a *= 0.92 + r() * 0.12; // a little value spread per card
      const s = cr * (0.8 + r() * 0.3) * sizeK; // half size
      const spin = r() * Math.PI * 2, cs = Math.cos(spin), sn = Math.sin(spin);
      const base = pos.length / 3;
      for (const [ox, oy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        pos.push(p.x, p.y, p.z);
        nrm.push(nn.x, nn.y, nn.z);
        corner.push(ox, oy);
        uvs.push(cs * s, sn * s, 1 / cr); // spin x half size, clump radius
        ao.push(a);
        hgt.push(Math.min(1, Math.max(0, (p.y - yLo) / (yHi - yLo))));
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  leaves.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  // packed: WebGPU allows 8 vertex buffers and the instancing takes several of them (no uv: the
  // unit corner is the uv)
  const card = new Float32Array(ao.length * 4);
  for (let i = 0; i < ao.length; i++) card.set([corner[i * 2], corner[i * 2 + 1], ao[i], hgt[i]], i * 4);
  leaves.setAttribute("card", new THREE.Float32BufferAttribute(card, 4)); // (unit corner xy, occlusion, height in crown)
  leaves.setAttribute("cardSpin", new THREE.Float32BufferAttribute(uvs, 3)); // (cos, sin) x half size, 1 / clump radius
  leaves.setIndex(idx);
  // the cards reach past their centres: a generous bound (frustum culling is off anyway)
  leaves.boundingSphere = new THREE.Sphere(crown.clone(), Math.max(rad.x, rad.y, rad.z) + 4);

  // trunk + a branch to each ring clump (thin tubes; the crown hides most of them)
  const segs = [];
  const trunkTop = crown.clone().add(new THREE.Vector3(0, -0.6, 0));
  segs.push([new THREE.Vector3(0, -0.4, 0), trunkTop, 0.34, 0.2]);
  for (let ci = 1; ci < clumps.length - 1; ci++) {
    if (lod === 2 || (lod === 1 && ci % 2)) continue;
    const from = new THREE.Vector3(0, 2.6 + r() * 1.6, 0);
    const to = from.clone().lerp(clumps[ci].c, 0.75);
    segs.push([from, to, 0.13, 0.05]);
  }
  const trunk = tubeGeometry(segs, [7, 5, 4][lod]);
  return { leaves, trunk, height: yHi, radius: Math.max(rad.x, rad.z) + 2 };
}

function smooth01(x) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function tubeGeometry(segs, sides) {
  const pos = [], nrm = [], idx = [];
  const up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3();
  for (const [a, c, r0, r1] of segs) {
    d.subVectors(c, a).normalize();
    t.crossVectors(Math.abs(d.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : up, d).normalize();
    b.crossVectors(d, t);
    const base = pos.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const center = ring ? c : a, rr = ring ? r1 : r0;
      for (let i = 0; i < sides; i++) {
        const ang = (i / sides) * Math.PI * 2;
        const n = t.clone().multiplyScalar(Math.cos(ang)).addScaledVector(b, Math.sin(ang));
        pos.push(center.x + n.x * rr, center.y + n.y * rr, center.z + n.z * rr);
        nrm.push(n.x, n.y, n.z);
      }
    }
    // counter-clockwise seen from OUTSIDE: the other order faced inward, so the near wall was
    // culled and the inside of the far wall drawn — the trunk looked hollow on one side
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      idx.push(base + i, base + j, base + sides + i, base + j, base + sides + j, base + sides + i);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

// ------------------------------------------------------------------ materials
function makeLeafMaterial(P, U) {
  const leafTex = loadLeafMask();
  const m = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
  const card = attribute("card", "vec4");
  const spin = attribute("cardSpin", "vec3");
  const unit = card.xy, aoA = card.z, hA = card.w, invR = spin.z;
  const tex = texture(leafTex, unit.mul(0.5).add(0.5));
  // the corner in the card's plane: the unit corner turned by the card's spin, x its half size
  const cardO = vec2(unit.x.mul(spin.x).sub(unit.y.mul(spin.y)), unit.x.mul(spin.y).add(unit.y.mul(spin.x)));
  const xf = attribute("treeXf", "vec3"); // per instance: cos, sin of the tree's Y turn, its scale
  // the card's corner along the VIEWING camera's axes (in the shadow pass: the light's), world
  // space and unscaled; the view matrix's rows are the camera's right and up
  const cornerWorld = Fn(() => {
    const V = cameraViewMatrix;
    const right = vec3(V.element(0).x, V.element(1).x, V.element(2).x);
    const up = vec3(V.element(0).y, V.element(1).y, V.element(2).y);
    return right.mul(cardO.x).add(up.mul(cardO.y));
  });
  // positionNode runs BEFORE the instance transform (in the tree's own space), which then turns
  // and scales it: turn the corner back by the tree's Y rotation so it ends up facing the camera
  // (the scale is wanted: a bigger tree, bigger cards)
  const toTree = (w) => vec3(xf.x.mul(w.x).sub(xf.y.mul(w.z)), w.y, xf.y.mul(w.x).add(xf.x.mul(w.z)));
  const toWorld = (l) => vec3(xf.x.mul(l.x).add(xf.y.mul(l.z)), l.y, xf.x.mul(l.z).sub(xf.y.mul(l.x)));
  // FIXED cards (faceCamera 0): the card lies across its shading normal (the clump's sphere,
  // pointing out), in the tree's own space — it turns with the tree, never with the camera
  const fixedCorner = Fn(() => {
    const n = normalize(attribute("normal", "vec3"));
    const axis = select(n.y.abs().greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
    const t = normalize(cross(axis, n));
    const b = cross(n, t);
    return t.mul(cardO.x).add(b.mul(cardO.y));
  });
  // the corner actually used, tree space: fixed, camera-facing, or a blend
  const cornerTree = mix(fixedCorner(), toTree(cornerWorld()), U.faceCamera);
  m.positionNode = positionLocal.add(cornerTree).add(vec3(0, U.crownLift, 0));
  // one value per tree (instance), the same in the shadow pass and the colour pass
  const tint = hash(instanceIndex.add(17)).sub(0.5).mul(U.tintVar).add(1);
  m.colorNode = Fn(() => {
    const base = mix(U.bottom, U.top, smoothstep(0.0, 1.0, hA));
    return base.mul(tint).mul(mix(float(1), aoA, U.aoColor));
  })();
  // the leaf shape: smooth edges with MSAA, the hard cut in the shadow map (without the shadow
  // mask each card cast its whole square: the crown's shadow was a hard-edged slab)
  applyAlphaCutout(m, tex.r, { threshold: 0.5, coverage: P.alphaToCoverage });
  // The cards face the camera here and the sun in the shadow pass, so a card's corners reach up to
  // its half size toward or away from the sun and it shadowed ITSELF in stripes. The shadow is
  // looked up at the card's CENTRE (a little toward the sun): one value per card, and clumps still
  // shadow each other card by card.
  // The lift toward the sun is about a clump's radius: a card is not shadowed by its own clump's
  // outer cards (the clump's lit side stays lit), only by OTHER clumps and trees.
  m.receivedShadowPositionNode = positionWorld.sub(toWorld(cornerTree).mul(xf.z)).add(U.sunDir.mul(U.shadowLift));
  m.aoNode = aoA;
  // the clump's sphere normal, curving across the card (the corner leans the normal out over the
  // clump); the same for both faces (DoubleSide would flip the back face's)
  // (from the raw attribute, in the tree's space, turned into the world here: normalNode is not
  // instanced for us)
  m.normalNode = Fn(() => {
    const nTree = normalize(attribute("normal", "vec3").add(cornerTree.mul(invR).mul(0.7)));
    return transformNormalToView(toWorld(nTree)).normalize();
  })();
  // light through the leaves: looking toward the sun, outer leaves glow, the core does not
  m.emissiveNode = Fn(() => {
    const V = normalize(positionWorld.sub(cameraPosition));
    const back = pow(saturate(dot(V, U.sunDir)), 4.0);
    return U.transColor.mul(U.sunColor).mul(back).mul(aoA.mul(aoA)).mul(U.translucency);
  })();
  return m;
}

function makeTrunkMaterial(U) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  m.colorNode = vec3(0.16, 0.1, 0.06);
  // crownLift: everything above the root ring rises with the crown — the trunk stretches, the
  // branches move up with their clumps
  m.positionNode = positionLocal.add(vec3(0, select(positionLocal.y.greaterThan(0), U.crownLift, float(0)), 0));
  return m;
}

// ------------------------------------------------------------------ the forest
export function createStylizedTrees({ scene, trees, variants = 3, params = {} }) {
  const P = { ...STYLIZED_TREE_DEFAULTS, ...params };
  const U = {
    top: uniform(new THREE.Color(P.topColor)),
    bottom: uniform(new THREE.Color(P.bottomColor)),
    aoColor: uniform(P.aoColor),
    translucency: uniform(P.translucency),
    transColor: uniform(new THREE.Color(P.translucencyColor)),
    tintVar: uniform(P.tintVar),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Vector3(1, 1, 1)),
    shadowLift: uniform(P.shadowLift),
    crownLift: uniform(P.crownLift),
    faceCamera: uniform(P.faceCamera),
  };
  const leafMat = makeLeafMaterial(P, U);
  const trunkMat = makeTrunkMaterial(U);
  const group = new THREE.Group();
  group.name = "StylizedTrees";
  scene.add(group);

  // per variant x LOD: an instanced leaf mesh and an instanced trunk mesh
  const n = trees.length;
  const kinds = [];
  for (let v = 0; v < variants; v++) {
    for (let lod = 0; lod < 3; lod++) {
      const g = buildTree(1000 + v * 97, lod);
      const mk = (geo, mat) => {
        const im = new THREE.InstancedMesh(geo, mat, n);
        im.count = 0;
        im.castShadow = lod < 2;
        im.receiveShadow = true;
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        group.add(im);
        return im;
      };
      // the billboards undo the tree's turn on their corners (cos, sin, scale per instance)
      const xfAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      xfAttr.setUsage(THREE.DynamicDrawUsage);
      g.leaves.setAttribute("treeXf", xfAttr);
      kinds.push({ v, lod, leaves: mk(g.leaves, leafMat), trunk: mk(g.trunk, trunkMat), xfAttr });
    }
  }
  const variantOf = trees.map((_, i) => Math.floor(rng(i * 7919 + 13)() * variants));
  const mats = trees.map(([x, z, y, rot, s]) => {
    const m = new THREE.Matrix4().makeRotationY(rot);
    m.scale(new THREE.Vector3(s, s, s));
    m.setPosition(x, y - 0.25, z);
    return m;
  });

  const lastCam = new THREE.Vector3(Infinity, 0, 0);
  let lastKey = "";
  function relod(camPos) {
    for (const k of kinds) { k.leaves.count = 0; k.trunk.count = 0; }
    const near2 = P.lodDist * P.lodDist, far2 = P.farDist * P.farDist, max2 = P.maxDist * P.maxDist;
    for (let i = 0; i < n; i++) {
      const [x, z, y] = trees[i];
      const dx = x - camPos.x, dy = y - camPos.y, dz = z - camPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > max2) continue;
      const k = kinds[variantOf[i] * 3 + (d2 < near2 ? 0 : d2 < far2 ? 1 : 2)];
      k.xfAttr.array.set([Math.cos(trees[i][3]), Math.sin(trees[i][3]), trees[i][4]], k.leaves.count * 3);
      k.leaves.setMatrixAt(k.leaves.count++, mats[i]);
      k.trunk.setMatrixAt(k.trunk.count++, mats[i]);
    }
    for (const k of kinds) {
      k.leaves.instanceMatrix.needsUpdate = true;
      k.trunk.instanceMatrix.needsUpdate = true;
      k.xfAttr.needsUpdate = true;
    }
  }

  function update(camera, light = {}) {
    if (light.sunDir) U.sunDir.value.copy(light.sunDir);
    if (light.sunColor) U.sunColor.value.set(light.sunColor[0], light.sunColor[1], light.sunColor[2]);
    U.top.value.set(P.topColor);
    U.bottom.value.set(P.bottomColor);
    U.transColor.value.set(P.translucencyColor);
    U.aoColor.value = P.aoColor;
    U.translucency.value = P.translucency;
    U.tintVar.value = P.tintVar;
    U.shadowLift.value = P.shadowLift;
    U.crownLift.value = P.crownLift;
    U.faceCamera.value = P.faceCamera;
    // LOD re-bucketing only when the camera has moved a few metres (or the distances changed)
    const key = `${P.lodDist},${P.farDist},${P.maxDist}`;
    if (camera.position.distanceToSquared(lastCam) > 25 || key !== lastKey) {
      lastCam.copy(camera.position);
      lastKey = key;
      relod(camera.position);
    }
  }

  return {
    params: P,
    group,
    /** the placements drawn, [x, z, y, rotY, scale] */
    placements: trees,
    update,
    setVisible(v) { group.visible = !!v; },
    stats() {
      let tris = 0;
      for (const k of kinds) {
        tris += k.leaves.count * k.leaves.geometry.index.count / 3 + k.trunk.count * k.trunk.geometry.index.count / 3;
      }
      return { trees: n, tris: Math.round(tris) };
    },
    dispose() {
      for (const k of kinds) { k.leaves.geometry.dispose(); k.trunk.geometry.dispose(); }
      leafMat.dispose(); trunkMat.dispose();
      scene.remove(group);
    },
  };
}
