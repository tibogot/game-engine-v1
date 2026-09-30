// RTS unit RENDERER — GAME code. Turns mesh-free unit data (units.js) into
// visuals: model, rotors, terrain tilt. Health bars and selection rings are each
// a single shared instanced draw (healthBar.js / selectionRingField.js) that this
// renderer just pushes one entry into per unit.
//
// Today: one cloned model per unit (clones share geometry/materials, so this is
// fine for dozens). To scale to hundreds, replace THIS FILE with an
// InstancedMesh version — the unit logic, orders and combat never change.
//
// Rotor handling (main = Y spin, tail = X spin ~2.4× faster) is ported from
// rts-chibs. Rotor meshes are RENAMED on the template so the tag survives
// clone(true) — userData refs would still point at the template's own nodes.
import * as THREE from "three";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { abs, attribute, floor, float, instanceIndex, materialColor, max, mix, mod, step, texture, varying, vec3 } from "three/tsl";
import { UNIT_ORDER, XRAY_ORDER, createXrayMaterial, xrayOn } from "./xraySilhouette.js";
import { teamTint, isUntinted } from "./teams.js";
import { createCrowdField } from "./crowdSkinning.js";
import { deathFrom, fadeFor } from "./soldierTransitions.js";
import {
  HEADGEAR, KIT, LOOKS, headgearMaterial, loadout, lookColorNode, markHeadwear, markHelmet, measureCrown, neckPlane,
} from "./soldierLooks.js";
import { TOOLS, WEAPONS, weaponMaterial } from "./procWeapons.js";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../v2/core/foliage/glbLoader.js";
import { bakeThumbnails } from "./thumbnails.js";
import { rtsRunningGearMaterial } from "../../v3/render/objects/rtsVehicles.js";
import { rtsObjectMaterial, rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { rtsAtlasReady } from "../../v3/render/objects/rtsTextures.js";
import { mayCastShadow, stencilMesh } from "../../v3/render/objects/rtsStencils.js";


// Mesh → owning unit, for selection raycasts. A WeakMap (not mesh.userData)
// keeps the link OUT of userData, which THREE deep-clones via JSON — a unit
// back-ref there would be circular and break clone(true) (thumbnail baking).
export const unitByMesh = new WeakMap();

const _UP = new THREE.Vector3(0, 1, 0);
const _n = new THREE.Vector3();
const _alignQ = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const _targetQ = new THREE.Quaternion();

// ── Rotor node detection (from rts-chibs) ──────────────────────────────────────
function isRotorMeshName(name) {
  const n = (name || "").toLowerCase();
  if (!n) return false;
  if (/tail/.test(n) && /rotor|prop|blade/.test(n)) return true;
  return /rotor|propeller|blade|\bprop\b|object_14\.001(?:_\d+)?$/.test(n);
}
function isTailRotorMeshName(name) {
  const n = (name || "").toLowerCase();
  return /tail/.test(n) && /rotor|prop|blade/.test(n);
}
function rotorKind(obj, root) {
  if (isTailRotorMeshName(obj.name)) return "tail";
  if (isRotorMeshName(obj.name)) return "main";
  let p = obj.parent;
  while (p && p !== root) {
    const pn = (p.name || "").toLowerCase();
    if (isTailRotorMeshName(p.name)) return "tail";
    if (pn === "rotor" || pn === "mainrotor" || isRotorMeshName(p.name)) return "main";
    if (pn === "tailrotor") return "tail";
    p = p.parent;
  }
  return null;
}

function loadGltf(url) {
  return new Promise((resolve, reject) => {
    getSharedGltfLoader().load(
      url,
      (gltf) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      undefined,
      reject,
    );
  });
}

/** Normalise a model into a reusable template and rename its rotor meshes. */
function buildTemplate(gltf, { targetLength, targetHeight, excludeRotorsFromBox, castShadow = true }) {
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.add(gltf);
  root.add(holder);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3();
  let hasBody = false;
  root.traverse((o) => {
    if (!o.isMesh) return;
    dequantizeGeometry(o.geometry);
    if (excludeRotorsFromBox && rotorKind(o, root)) return;
    box.expandByObject(o);
    hasBody = true;
  });
  if (!hasBody) box.setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  holder.position.set(-center.x, -box.min.y, -center.z);
  // Vehicles scale by horizontal length; humanoids by HEIGHT (their horizontal
  // footprint is shoulder width — meaningless as a size reference).
  const scale = targetHeight
    ? targetHeight / Math.max(size.y, 1e-4)
    : targetLength / Math.max(size.x, size.z, 1e-4);
  root.scale.setScalar(scale);

  let rotors = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    // Shadow-cast policy lives on the unit TYPE (unitTypes.js): the shadow pass
    // redraws every caster once per CSM cascade, so a caster nobody can see still
    // costs 3 draws.
    o.castShadow = castShadow;
    o.receiveShadow = true;
    const kind = rotorKind(o, root);
    if (kind === "main") { o.name = "MainRotor"; rotors++; }
    else if (kind === "tail") { o.name = "TailRotor"; rotors++; }
  });

  mergeTemplateParts(root);

  return { root, rotors };
}

// ── Template merging ─────────────────────────────────────────────────────────
// A GLB arrives split by MATERIAL, not by anything we care about: the soldier is
// 6 skinned meshes (bags / green / grey / mags / shirt / skin) and the heli's body
// is 4. Every one of those is a draw call PER UNIT, twice over once shadows are
// on — 36 draws for six soldiers.
//
// None of those parts is textured: they're flat colors. So we bake each part's
// color into a vertex-color attribute and merge them into ONE mesh per model.
// Textured parts keep their own mesh (they can't share a vertex-color material),
// and rotors are left alone — they spin about their own pivots, and baking their
// matrices into the merged geometry would move those pivots.

const _identity = new THREE.Matrix4();

/** Bake a flat material color into a `color` attribute so parts can merge. */
function paint(geo, color) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * Rewrite quantized GLB attributes (KHR_mesh_quantization int16) as Float32.
 * WebGPU requires arrayStride to be a multiple of 4; 3 × int16 = 6 bytes, which
 * breaks InstancedMesh / merged geometry that three does not pad for us.
 */
function dequantizeGeometry(g) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name];
    if (a.array instanceof Float32Array && !a.normalized) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
}

/**
 * One material for a merged model. `vertexColors` carries what used to be one
 * material per part, and MeshStandardMaterial replaces the GLB's
 * MeshPhysicalMaterial (the priciest shader in three — its clearcoat /
 * transmission / iridescence lobes buy us nothing on an RTS unit).
 */
function mergedMaterial(src) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff, // white: the vertex colors ARE the color
    roughness: src.roughness ?? 0.8,
    metalness: src.metalness ?? 0.1,
    vertexColors: true,
    side: src.side,
  });
}

/** Merge the flat-colored parts of a template into one mesh (skinned or not). */
function mergeTemplateParts(root) {
  const skinned = [];
  const statics = new Map(); // parent → meshes

  root.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === "MainRotor" || o.name === "TailRotor" || o.name === "Turret") return; // own pivots — leave them
    if (o.material.map) return;                                   // textured — can't share the material
    if (o.material.isNodeMaterial) return;                        // the parts kit's (atlas, rolling gear): kept apart
    if (o.isSkinnedMesh) {
      // Skinned geometry is in bind space; a non-identity mesh matrix would have
      // to be baked in, which would fight the bind matrix. GLTF skins are always
      // identity here, but bail rather than silently deform the model.
      if (!o.matrix.equals(_identity)) return;
      skinned.push(o);
    } else {
      const arr = statics.get(o.parent) ?? [];
      arr.push(o);
      statics.set(o.parent, arr);
    }
  });

  const merge = (meshes, { skinned: isSkinned }) => {
    if (meshes.length < 2) return;
    const geos = meshes.map((m) => {
      const g = m.geometry.clone();
      dequantizeGeometry(g);
      if (!isSkinned && !m.matrix.equals(_identity)) g.applyMatrix4(m.matrix);
      return paint(g, m.material.color);
    });
    // mergeGeometries returns null on ANY attribute mismatch — don't ship a model
    // with its body silently missing.
    const geo = mergeGeometries(geos, false);
    if (!geo) {
      console.warn("[rts-v3] template merge skipped: attribute mismatch");
      return;
    }

    const first = meshes[0];
    const mat = mergedMaterial(first.material);
    let merged;
    if (isSkinned) {
      merged = new THREE.SkinnedMesh(geo, mat);
      // The parts each carry their own Skeleton object, but those all reference
      // the SAME bones — the ones the AnimationMixer drives — so binding to the
      // first one animates the merged mesh exactly as before.
      merged.bind(first.skeleton, first.bindMatrix);
      merged.frustumCulled = false;
    } else {
      merged = new THREE.Mesh(geo, mat);
    }
    merged.castShadow = first.castShadow; // inherit the type's shadow policy
    merged.receiveShadow = true;

    const parent = first.parent;
    for (const m of meshes) m.removeFromParent();
    parent.add(merged);
  };

  merge(skinned, { skinned: true });
  for (const meshes of statics.values()) merge(meshes, { skinned: false });
}

// ── Instancing (non-skinned types) ───────────────────────────────────────────
// Jeeps and helicopters are rigid models: every unit of a type draws the SAME
// geometry with the SAME material, only the transform differs. So instead of one
// cloned Group per unit (8 jeeps = 8 draws), each PART of the template becomes
// one InstancedMesh shared by every unit of that type — 8 jeeps = 1 draw, 40
// jeeps would still be 1 draw.
//
// Rotors stay their own instanced part: they spin per unit, so their instance
// matrix is composed with that unit's own rotor angle.
//
// Soldiers are skinned and keep a Group each — a skinned mesh can't be instanced
// without a GPU-skinning path, and each one is posed by its own AnimationMixer.

const MAX_PER_TYPE = 256; // instance buffer headroom for base production

const _mat = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _rock = new THREE.Matrix4();
const _kickPos = new THREE.Vector3();

/**
 * A plain three material carries no node, and three's NodeMaterialObserver only
 * re-uploads uniforms for materials that do (or whose mesh moved). An
 * InstancedMesh NEVER moves — the instances do — so its scene fog uniforms would
 * FREEZE, exactly like the static structures did. `materialColor` reads the
 * material's own color AND its map, so the model keeps its texture.
 */
function refreshingMaterial(src) {
  // The parts kit's own materials: the atlas material carries its colorNode
  // (which keeps its uniforms live) and is kept as it is; the stencil sheet
  // gets a copy with one, keeping its alpha test and polygon offset.
  if (src.isNodeMaterial) {
    if (src.colorNode) return src;
    const m = src.clone();
    m.colorNode = materialColor;
    // colorNode feeds RGB only — the cut-out would be lost and every stencil
    // drawn as a solid square. The alpha test reads opacity: give it the sheet's.
    if (src.map) m.opacityNode = texture(src.map).a;
    return m;
  }
  const m = new THREE.MeshStandardNodeMaterial({
    color: src.color,
    map: src.map ?? null,
    roughness: src.roughness ?? 0.8,
    metalness: src.metalness ?? 0.1,
    vertexColors: src.vertexColors,
    side: src.side,
    transparent: src.transparent,
    alphaTest: src.alphaTest,
  });
  m.colorNode = materialColor;
  return m;
}

/** Turn a rigid template into one InstancedMesh per part. */
function buildInstancedType(tpl, scene) {
  const root = tpl.root;
  root.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();

  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;

    const kind = o.name === "MainRotor" ? "main" : o.name === "TailRotor" ? "tail" : o.name === "Turret" ? "turret" : null;

    const geo = o.geometry.clone();
    dequantizeGeometry(geo);
    const im = new THREE.InstancedMesh(geo, refreshingMaterial(o.material), MAX_PER_TYPE);
    im.count = 0;
    // The type's shadow policy (unitTypes.js). Rotors included: the turning blade
    // shadow on the ground is half of what makes a helicopter read as a helicopter.
    // (They were briefly excluded as "visual noise" — but that call was made while
    // the sun direction was skewed and every shadow landed 62 m from its object,
    // so the rotor shadow never actually got a fair look.)
    // …except an alpha-tested part (the stencils): see mayCastShadow.
    im.castShadow = o.castShadow && mayCastShadow(o.material);
    im.receiveShadow = true;
    im.frustumCulled = false; // instances live anywhere; the shared bounds are meaningless
    im.renderOrder = UNIT_ORDER; // after the silhouettes (xraySilhouette.js)

    // Team color (teams.js). Allocated UP FRONT, not lazily via setColorAt: three
    // decides whether to compile `vInstanceColor` into the shader by looking at
    // object.instanceColor when the material is first built, so a buffer that
    // appears later would simply be ignored. White = untinted.
    im.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PER_TYPE * 3).fill(1), 3,
    );
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);

    scene.add(im);

    const part = { im, kind };
    if (kind) {
      // A rotor spins about ITS OWN pivot, so we rebuild its local matrix per
      // unit from the spin angle and compose it with the pivot's place in the model.
      part.parentRel = new THREE.Matrix4().multiplyMatrices(invRoot, o.parent.matrixWorld);
      part.basePos = o.position.clone();
      part.baseEuler = o.rotation.clone();
      part.baseScale = o.scale.clone();
    } else {
      // Rigid part: a fixed offset from the unit's own transform.
      part.rel = new THREE.Matrix4().multiplyMatrices(invRoot, o.matrixWorld);
    }
    parts.push(part);
  });

  // The template's own scale (buildTemplate normalises model size) is part of
  // every unit's transform, so instances carry it too.
  const odometer = parts.map((p) => p.im.material.userData?.odometer).find(Boolean) ?? null;

  // X-RAY (xraySilhouette.js): each part drawn a second time where the world
  // hides the unit, sharing the part's geometry and instance matrices; a
  // per-instance team flag picks blue or red.
  const team = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_TYPE), 1);
  team.setUsage(THREE.DynamicDrawUsage);
  const xrayMat = createXrayMaterial({ teamNode: attribute("iTeam", "float") });
  for (const part of parts) {
    part.im.geometry.setAttribute("iTeam", team);
    const x = new THREE.InstancedMesh(part.im.geometry, xrayMat, MAX_PER_TYPE);
    x.instanceMatrix = part.im.instanceMatrix;   // the SAME buffer: nothing extra to upload
    x.count = 0;
    x.frustumCulled = false;
    x.castShadow = x.receiveShadow = false;
    x.renderOrder = XRAY_ORDER;
    x.visible = false;
    x.name = "UnitXray";
    scene.add(x);
    part.xray = x;
  }
  return { parts, scale: root.scale.x, n: 0, unitAt: [], turret: parts.some((p) => p.kind === "turret"), odometer, team };
}

// ── Crowd (skinned types) ────────────────────────────────────────────────────
// Skinned units can't join an InstancedMesh, so they get the compute-skinning
// path instead: the clips are baked to a bone-matrix table, a compute pass skins
// every soldier into a storage buffer, and ONE Mesh draws the lot. Adding
// soldiers costs no draw calls and (measured in the lab) no CPU either.

const MAX_CROWD = 160; // soldiers a TYPE may field at once; a body's crowd holds the sum of its types

/**
 * One CROWD per BODY: every soldier type dressed on the same body (the pack's
 * soldier1: appelés, sapeurs, paras, légionnaires) shares ONE field — one
 * clip bake, one skinning dispatch, one skin buffer, one set of rigid pieces
 * (a MAS 49/56 is one draw whoever carries it), one x-ray. Each type keeps its
 * LOOK as a view: a mesh over its range of the crowd with its own shader
 * (crowdSkinning view()), so there is no per-pixel branching between looks.
 * `members`: [{ key, type }] (the unit type key and its definition).
 */
function buildCrowdGroup(tpl, members, app, scene) {
  const root = tpl.root;
  root.updateMatrixWorld(true);

  let source = null;
  root.traverse((o) => { if (!source && o.isSkinnedMesh) source = o; });
  if (!source) {
    console.warn("[rts-v3] skinned template has no SkinnedMesh — crowd disabled.");
    return null;
  }

  const byName = (re) => tpl.animations.find((a) => re.test(a.name));
  const exact = (name) => tpl.animations.find((a) => a.name === name) ?? null;
  // The soldier pack's ROLE names (tools/packMixamo.mjs) first, else the old
  // stand-in's idle / run.
  const idle = exact("rifle_idle") ?? byName(/idle/i) ?? tpl.animations[0];
  const run = exact("rifle_run") ?? byName(/run|walk/i) ?? idle;
  if (!idle) {
    console.warn("[rts-v3] skinned template has no clips — crowd disabled.");
    return null;
  }
  // Bake EVERY clip but the pack's first unarmed test downloads (they would
  // only cost table memory); the per-soldier state picks among them.
  const clips = {};
  for (const a of tpl.animations) if (!/^unarmed_/.test(a.name)) clips[a.name] = a;
  clips[idle.name] = idle;
  clips[run.name] = run;
  const roles = {
    idle: idle.name,
    run: run.name,
    aim: exact("rifle_aim_idle")?.name ?? null,
    fire: exact("rifle_firing")?.name ?? null,
    deaths: ["death_forward", "death_backward"].filter((n) => exact(n)),
    // postures and work (infantryPosture.js, algBuild.js): null when the body lacks the clip
    crouchIdle: exact("rifle_crouch_idle")?.name ?? null,
    crouchFire: exact("rifle_crouch_firing")?.name ?? null,
    crouchWalk: exact("rifle_crouch_walk")?.name ?? null,
    prone: exact("rifle_prone_idle")?.name ?? null,
    dig: exact("dig")?.name ?? null,
    grenade: exact("grenade_throw")?.name ?? null,
  };

  // The faction LOOKS in the crowd shader (soldierLooks.js): the body's colour
  // map repainted by hue, per-soldier variation from the crowd's extra buffer.
  // The helmet recolour reads a per-vertex helmet mark — set it before the
  // crowd clones the geometry.
  const looks = members.map(({ type }) => (type.look ? LOOKS[type.look] : null));
  const marked = looks.some(Boolean);
  if (marked) { markHelmet(source); markHeadwear(source); }
  // SKINNED KIT (soldierLooks KIT[k].skinned — the kachabia) any of the
  // group's looks can roll: merged into the crowd's geometry (skinned by the
  // same pass, no draw of its own), hidden per soldier (skinnedKitNodes).
  const kitSkinned = [...new Set(looks.filter(Boolean).flatMap((l) => [
    ...(l.kit ?? []), ...Object.keys(l.extras ?? {}), ...Object.values(l.roles ?? {}).flatMap((r) => r.kit ?? []),
  ]))].filter((k) => KIT[k]?.skinned);
  const crowdGeometry = kitSkinned.length ? withSkinnedKit(source, root, kitSkinned) : null;

  const cap = members.reduce((n, { type }) => n + (type.crowdMax ?? MAX_CROWD), 0);
  const field = createCrowdField({
    scene,
    renderer: app.renderer,
    source,
    animRoot: root,
    clips,
    aliases: { idle: idle.name, run: run.name },
    max: cap,
    // The shadow pass picks up the compute-skinned positions for free: it renders
    // the object with an override material but keeps the material's `positionNode`
    // (Renderer._getShadowNodes), so the crowd casts its real animated silhouette.
    // Costs 3 draws (one per CSM cascade) per look on screen, 6 soldiers or 106.
    castShadow: members.some(({ type }) => type.castShadow !== false),
    drawMesh: false,
    geometry: crowdGeometry,
  });

  // A VIEW per type: its range of the crowd, drawn in its look.
  const views = new Map();
  members.forEach(({ key, type }, i) => {
    const look = looks[i];
    const material = source.material.clone();
    // `crowdTint` [r, g, b]: a whole TYPE's clothing colour (it multiplies the
    // model's) — how a second side on the same stand-in model reads as
    // another army at a glance.
    if (type.crowdTint && material.color) material.color.multiply(new THREE.Color(...type.crowdTint));
    const view = field.view(material, `Crowd:${key}`);
    view.mesh.castShadow = type.castShadow !== false;
    view.mesh.renderOrder = UNIT_ORDER;
    const ex = field.extraNode.element(view.index);
    if (look && source.material.map) {
      material.colorNode = lookColorNode(source.material.map, look, neckPlane(source), varying(ex.xyz));
      // the skinned kit in its own (vertex) colours
      if (crowdGeometry) material.colorNode = mix(material.colorNode, attribute("kitColor", "vec3"), step(0.5, attribute("kitPiece", "float")));
    }
    if (look) {
      // HEADWEAR OFF PER SOLDIER: one geometry for the whole crowd, so a man in a
      // beret or a chèche collapses the body's own headwear (helmet, straps, a
      // hat — markHeadwear) to a point: zero-area triangles, nothing drawn —
      // and so does skinned kit he isn't wearing. The flags are his `extra.w`
      // (see soldierFlags). The shadow pass uses the same node.
      material.positionNode = mix(material.positionNode, vec3(0, 0, 0), hiddenNode(ex.w, kitSkinned.length));
    }
    views.set(key, { ...view, key, look, living: [], dead: [] });
  });

  // Ground speed of the run clip (the planted foot slides back at exactly that
  // speed), in the WORLD — the template is scaled to the type's height — so
  // the run plays at the unit's own pace and the feet don't skate.
  const runSpeed = measureGroundSpeed(root, run) || 0;

  // The compute pass emits vertices in the TEMPLATE MESH's local space, which
  // knows nothing about buildTemplate's normalisation (the centring offset and
  // the scale that makes the model targetHeight tall). Fold that in, exactly like
  // the rigid instanced parts do: rel = root⁻¹ · mesh, applied inside the unit's
  // own transform.
  const rel = new THREE.Matrix4()
    .copy(root.matrixWorld).invert()
    .multiply(source.matrixWorld);

  // X-RAY for the whole crowd, every look: the same compute-skinned vertices.
  // The anim record's spare lane is the team (0 ours, 1 theirs) for a living
  // soldier, 2 + team for a corpse or a static figure: those collapse (no
  // silhouette — the temple watchers' pink ones showed through its stone).
  const lane = field.animNode.element(instanceIndex).w;
  const gone = step(1.5, lane);
  const own = field.skinnedAt(instanceIndex);
  let hidden = gone;
  if (marked) hidden = max(gone, hiddenNode(field.extraNode.element(instanceIndex).w, kitSkinned.length));
  const xray = new THREE.Mesh(field.mesh.geometry, createXrayMaterial({
    teamNode: lane.sub(gone.mul(2)),
    positionNode: mix(own.positionNode, vec3(0, 0, 0), hidden),
    normalNode: own.normalNode,
  }));
  // Its own program, as the crowd's (crowdSkinning.js): it reads that crowd's buffer.
  const xrayKey = `crowdXray:${xray.material.uuid}`;
  xray.material.customProgramCacheKey = () => xrayKey;
  xray.count = 0;
  xray.frustumCulled = false;
  xray.castShadow = xray.receiveShadow = false;
  xray.renderOrder = XRAY_ORDER;
  xray.visible = false;
  xray.name = "UnitXrayCrowd";
  scene.add(xray);

  const pieces = marked ? buildPieces(field, source, rel, looks.filter(Boolean), scene, root, cap) : null;

  return { field, rel, scale: root.scale.x, xray, roles, runSpeed, pieces, views, cap, kitSkinned };
}

/**
 * A soldier's `extra.w` FLAGS: 1 = bare head (his body's own headwear hidden),
 * + 2^(i+1) for each skinned kit piece i (the group's `kitSkinned` order) he
 * wears.
 */
function soldierFlags(bare, worn, kitSkinned) {
  let w = bare ? 1 : 0;
  kitSkinned.forEach((k, i) => { if (worn.includes(k)) w += 2 ** (i + 1); });
  return w;
}

/** 1 where this vertex is hidden for a soldier with flags `w` (see soldierFlags). */
function hiddenNode(w, kitCount) {
  let hide = step(0.5, attribute("headwear", "float").mul(mod(w, 2)));
  for (let i = 0; i < kitCount; i++) {
    const mine = step(abs(attribute("kitPiece", "float").sub(i + 1)), float(0.5));
    const worn = mod(floor(w.div(2 ** (i + 1))), 2);
    hide = max(hide, mine.mul(float(1).sub(worn)));
  }
  return hide;
}

/**
 * The body's crowd geometry with its SKINNED KIT merged in (the kachabia: an
 * open wool cloak that must bend with the walk). Each piece is built at rest in
 * the pack's world (soldierLooks), welded (smooth cloth, and the crowd skins
 * every vertex of every soldier each frame — the flat-shaded build was four
 * times the vertices), weighted per vertex by its `weights` onto the body's
 * bones, and moved into the soldier mesh's own space (as the rigid kit is).
 * Marks: `kitPiece` (0 body, i+1 piece i), `kitColor` (its vertex colour).
 */
function withSkinnedKit(source, root, names) {
  root.updateMatrixWorld(true);
  const glbScene = root.children[0].children[0]; // buildTemplate: root → holder → the GLB's scene
  const toMesh = new THREE.Matrix4().copy(glbScene.matrixWorld).invert().multiply(source.matrixWorld).invert();
  const bones = source.skeleton.bones.map((b) => b.name.replace("mixamorig", ""));
  const body = source.geometry.clone();
  const n0 = body.attributes.position.count;
  // One type per attribute across the parts (mergeGeometries refuses any mismatch).
  const asFloat = (g, name) => {
    const a = g.getAttribute(name), out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let j = 0; j < a.itemSize; j++) out[i * a.itemSize + j] = a.getComponent(i, j);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  };
  const si = body.getAttribute("skinIndex");
  body.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(Uint16Array.from({ length: si.count * 4 }, (_, k) => si.getComponent(k >> 2, k & 3)), 4));
  asFloat(body, "skinWeight");
  body.setAttribute("kitPiece", new THREE.Float32BufferAttribute(new Float32Array(n0), 1));
  body.setAttribute("kitColor", new THREE.Float32BufferAttribute(new Float32Array(n0 * 3), 3));
  const parts = [body];
  names.forEach((name, i) => {
    const def = KIT[name];
    let g = def.build();
    g.deleteAttribute("normal");
    g = mergeVertices(g);
    g.computeVertexNormals();
    const pos = g.attributes.position, n = pos.count;
    const sIdx = new Uint16Array(n * 4), sW = new Float32Array(n * 4), p = new THREE.Vector3();
    for (let v = 0; v < n; v++) {
      p.fromBufferAttribute(pos, v);
      def.weights(p).filter(([, w]) => w > 1e-4).slice(0, 4).forEach(([bone, w], j) => {
        sIdx[v * 4 + j] = Math.max(0, bones.indexOf(bone)); sW[v * 4 + j] = w;
      });
    }
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(sIdx, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sW, 4));
    g.applyMatrix4(toMesh);
    g.setAttribute("kitPiece", new THREE.Float32BufferAttribute(new Float32Array(n).fill(i + 1), 1));
    g.setAttribute("kitColor", g.getAttribute("color"));
    // every attribute the body has, zero where the piece has none; nothing else
    for (const [key, a] of Object.entries(body.attributes)) {
      if (!g.getAttribute(key)) g.setAttribute(key, new THREE.BufferAttribute(new a.array.constructor(n * a.itemSize), a.itemSize, a.normalized));
    }
    for (const key of Object.keys(g.attributes)) if (!body.getAttribute(key)) g.deleteAttribute(key);
    for (const key of Object.keys(body.attributes)) {
      const a = body.getAttribute(key), b = g.getAttribute(key);
      if (b.array.constructor !== a.array.constructor) {
        g.setAttribute(key, new THREE.BufferAttribute(new a.array.constructor(b.array), b.itemSize, a.normalized));
      }
    }
    parts.push(g);
  });
  const merged = mergeGeometries(parts, false);
  if (!merged) { console.warn("[rts] skinned kit: the merge failed — no kachabia"); return null; }
  return merged;
}

// Clips whose hands are busy: the rifle is slung on the back (tools/packMixamo.mjs).
const STOWED = /^(dig|hammer|grenade_throw|unarmed)/;
const USES_TOOL = /^dig/;

/**
 * The RIGID pieces a soldier type carries — its look's weapons in the hand
 * and slung on the back, the shovel — each ONE InstancedMesh for every
 * soldier carrying it (not merged into the body: rigid parts need no skinning,
 * and only the soldiers who carry a piece pay for it).
 *
 * A piece rides a bone. Its instance matrix per soldier is
 *   unit · rel · bindInverse · B(bone, this soldier's pose) · K
 * where B is the baked skinning matrix (crowdSkinning boneMatrix, the same
 * table the GPU skins with) and K = the bone's rest world (inverse of its bind
 * inverse) · the piece's own offset on the bone — the chain a vertex skinned
 * 100 % to that bone goes through, so the piece sits exactly in the hands.
 */
// soldier1's crown at rest in the pack's frame (the lab measured it): the
// kit's face and neck pieces were modelled on that face, so another body
// shifts them by its own crown's offset (aln1's head sits ~4 cm higher).
const SOLDIER1_CROWN = new THREE.Vector3(0, 1.754, 0.032);

function buildPieces(field, source, rel, looks, scene, root, cap) {
  const skel = source.skeleton;
  const pre = new THREE.Matrix4().multiplyMatrices(rel, source.bindMatrixInverse);
  const boneOf = (name) => field.boneIndex(`mixamorig${name}`);
  const restOf = (i) => skel.boneInverses[i].clone().invert();
  if (boneOf("Weapon") < 0) return null;
  // THREE FRAMES. The skin works in the soldier MESH's own space (bind =
  // identity: the pack's mesh is ~8 units a metre, upside down). The kit and
  // hats were modelled in the PACK's world (the lab: metres, feet at 0). So a
  // piece goes pack world → mesh space through `toMesh` = inverse of the mesh's
  // transform inside the GLB (the first try skipped it: hats and packs came out
  // 1/8 size). The weapons ride bones whose rest already carries it.
  root.updateMatrixWorld(true);
  const glbScene = root.children[0].children[0]; // buildTemplate: root → holder → the GLB's scene
  const meshInPack = new THREE.Matrix4().copy(glbScene.matrixWorld).invert().multiply(source.matrixWorld);
  const toMesh = meshInPack.clone().invert();
  // This body's crown in the pack's world (measureCrown reads the template's world).
  const crown = measureCrown(source).applyMatrix4(source.matrixWorld.clone().invert()).applyMatrix4(meshInPack);
  const faceShift = crown.clone().sub(SOLDIER1_CROWN);

  const registry = new Map(); // key → { im, n, bone, K }
  const add = (key, geo, mat, bone, K) => {
    if (registry.has(key) || bone < 0) return;
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = false; // small kit: 3 more draws per piece type for next to nothing
    im.renderOrder = UNIT_ORDER;
    im.receiveShadow = true;
    im.count = 0;
    im.visible = false;
    scene.add(im);
    registry.set(key, { im, n: 0, bone, K, cap });
  };

  // WEAPONS in the hand and slung, the SHOVEL: modelled in their bone's frame.
  // Every look's (a key already made is shared: one MAS 49/56 for all).
  const weaponMat = weaponMaterial();
  const weaponKeys = new Set(looks.flatMap((look) => [
    ...(look.weaponMix ? Object.keys(look.weaponMix) : [look.weapon]),
    ...Object.values(look.roles ?? {}).map((r) => r.weapon).filter(Boolean),
  ]));
  for (const key of weaponKeys) {
    if (!WEAPONS[key]) continue;
    const geo = WEAPONS[key].build();
    add(`w:${key}`, geo, weaponMat, boneOf("Weapon"), restOf(boneOf("Weapon")));
    if (boneOf("Sling") >= 0) add(`s:${key}`, geo, weaponMat, boneOf("Sling"), restOf(boneOf("Sling")));
  }
  if (boneOf("Tool") >= 0) add("shovel", TOOLS.shovel.build(), weaponMat, boneOf("Tool"), restOf(boneOf("Tool")));

  // HATS: every headgear the look's variants can roll, modelled from the crown.
  const hatK = toMesh.clone().multiply(new THREE.Matrix4().makeTranslation(crown));
  for (const v of looks.flatMap((look) => [look, ...(look.variants ?? []).map((x) => ({ ...look, ...x }))])) {
    if (!v.headgear || !HEADGEAR[v.headgear]) continue;
    add(`h:${hatKey(v)}`, HEADGEAR[v.headgear](v), headgearMaterial(v), boneOf("Head"), hatK);
  }

  // KIT and EXTRAS: modelled in the pack's world around soldier1 at rest, so
  // their bone's rest cancels out and only the pack → mesh step is left
  // (K = toMesh) — after the face shift for the head and neck pieces. The
  // skinned kachabia isn't a rigid piece.
  const kitMat = headgearMaterial();
  const kitNames = new Set(looks.flatMap((look) => [
    ...(look.kit ?? []), ...Object.values(look.roles ?? {}).flatMap((r) => r.kit ?? []), ...Object.keys(look.extras ?? {}),
  ]));
  for (const name of kitNames) {
    const def = KIT[name];
    if (!def || def.skinned) continue;
    const K = (def.bone === "Head" || def.bone === "Neck")
      ? toMesh.clone().multiply(new THREE.Matrix4().makeTranslation(faceShift)) : toMesh;
    add(`k:${name}`, def.build(), kitMat, boneOf(def.bone), K);
  }
  return { pre, registry, all: [...registry.values()] };
}

/** The key of a headgear piece: its builder and its colour. */
const hatKey = (look) => `${look.headgear}|${look.hatColor ?? ""}|${look.badge ?? ""}`;

const _B = new THREE.Matrix4();
const _P = new THREE.Matrix4();

// One soldier's bone matrices, computed once per bone his pieces ride —
// preallocated and stamped (no garbage per soldier per frame).
const _bonePool = Array.from({ length: 64 }, () => new THREE.Matrix4());
const _boneStamp = new Int32Array(64);
let _stamp = 0;
const _base = new THREE.Matrix4();

/**
 * Write one soldier's rigid pieces for this frame: his weapon (in the hand, or
 * slung while a clip needs his hands), the shovel while digging, his hat, his
 * kit and extras. Pieces on the same bone share one bone-matrix lookup.
 */
function writePieces(crd, v, unitMatrix, holdA = false, holdB = false) {
  const P = crd.pieces;
  if (!P) return;
  const a = v.prev.clip, b = v.cur.clip;
  _stamp++;
  _base.multiplyMatrices(unitMatrix, P.pre);
  const put = (key) => {
    const piece = P.registry.get(key);
    if (!piece || piece.n >= piece.cap) return;
    const B = _bonePool[piece.bone];
    if (_boneStamp[piece.bone] !== _stamp) {
      crd.field.boneMatrix(a, v.prev.t, b, v.cur.t, v.fade, piece.bone, B, { holdA, holdB });
      _boneStamp[piece.bone] = _stamp;
    }
    _B.multiplyMatrices(_base, B).multiply(piece.K);
    piece.im.setMatrixAt(piece.n++, _B);
  };
  // A piece that CHANGES PLACE between the two clips (the rifle from the hands
  // to the back for a dig or a throw, the shovel out) swaps cleanly at the
  // fade's midpoint, placed from the dominant clip's pose alone: the pack
  // stows it by scaling its bone to ~0, and a blend of those scales showed a
  // shrinking rifle in the hands AND a growing one on the back for the whole
  // fade (the transition lab's strips, 2026-09-30).
  const dom = v.fade < 0.5 ? a : b, domT = v.fade < 0.5 ? v.prev.t : v.cur.t;
  const domHold = v.fade < 0.5 ? holdA : holdB;
  const putDom = (key) => {
    const piece = P.registry.get(key);
    if (!piece || piece.n >= piece.cap) return;
    crd.field.boneMatrix(dom, domT, dom, domT, 0, piece.bone, _P, { holdA: domHold, holdB: domHold });
    _B.multiplyMatrices(_base, _P).multiply(piece.K);
    piece.im.setMatrixAt(piece.n++, _B);
  };
  if (v.weapon) {
    const sa = STOWED.test(a), sb = STOWED.test(b);
    if (sa === sb) put(sa ? `s:${v.weapon}` : `w:${v.weapon}`);
    else putDom(STOWED.test(dom) ? `s:${v.weapon}` : `w:${v.weapon}`);
  }
  const ta = USES_TOOL.test(a), tb = USES_TOOL.test(b);
  if (ta && tb) put("shovel");
  else if ((ta || tb) && USES_TOOL.test(dom)) putDom("shovel");
  if (v.hat) put(`h:${v.hat}`);
  for (const k of v.kit) put(`k:${k}`);
}

/**
 * Ground speed (world m/s) a walk/run clip is animated for: sample the clip,
 * and at each step the LOWER foot is the planted one — its horizontal speed is
 * the ground speed. Median over the cycle. 0 when the rig has no toe bones.
 */
function measureGroundSpeed(root, clip) {
  const probe = SkeletonUtils.clone(root);
  const feet = ["LeftToeBase", "RightToeBase"].map((n) => {
    let b = null;
    probe.traverse((o) => { if (o.isBone && o.name.endsWith(n)) b = o; });
    return b;
  });
  if (!feet[0] || !feet[1]) return 0;
  const mixer = new THREE.AnimationMixer(probe);
  mixer.clipAction(clip).play();
  const N = 40, dt = clip.duration / N, speeds = [], d = new THREE.Vector3();
  let last = null;
  for (let i = 0; i <= N; i++) {
    mixer.setTime(i * dt);
    probe.updateMatrixWorld(true);
    const p = feet.map((f) => f.getWorldPosition(new THREE.Vector3()));
    const low = p[0].y < p[1].y ? 0 : 1;
    if (last && last.low === low) speeds.push(Math.hypot(d.subVectors(p[low], last.p[low]).x, d.z) / dt);
    last = { p, low };
  }
  mixer.stopAllAction();
  speeds.sort((a, b) => a - b);
  return speeds[speeds.length >> 1] ?? 0;
}

/**
 * Pick a crowd soldier's clip for this frame from the unit's state:
 *   at work (a sapper raising a site, algBuild.js) → dig;
 *   moving → run, or the crouched walk while suppressed / pinned;
 *   PRONE (pinned, infantryPosture.js) → lying;
 *   a live target in range → aim (the firing clip for a moment after each
 *   shot), KNEELING when his posture says so (in cover, suppressed);
 *   otherwise idle, kneeling in cover.
 * A body without a clip falls back to the standing one (the old stand-in:
 * idle + run only).
 */
function soldierClip(unit, v, roles) {
  if (unit.throwing && roles.grenade) return roles.grenade;   // algGrenades.js
  if (unit.working && roles.dig) return roles.dig;
  const low = unit.posture;   // "stand" | "kneel" | "prone"; undefined = stand
  if (unit.isMoving) return low && low !== "stand" && roles.crouchWalk ? roles.crouchWalk : roles.run;
  if (low === "prone" && roles.prone) return roles.prone;
  const kneel = low === "kneel" && roles.crouchIdle;
  const tg = unit.target;
  if (tg?.alive && roles.aim) {
    const range = unit.range ?? unit.type?.range ?? 0;
    const dx = tg.position.x - unit.position.x, dz = tg.position.z - unit.position.z;
    if (dx * dx + dz * dz <= (range * 1.05) ** 2) {
      if (kneel) return v.firing > 0 && roles.crouchFire ? roles.crouchFire : roles.crouchIdle;
      return v.firing > 0 && roles.fire ? roles.fire : roles.aim;
    }
  }
  return kneel ? roles.crouchIdle : roles.idle;
}

// The crossfade between two clips: per pair, soldierTransitions.js (judged in
// transition-lab.html). Each switch stores its own (`fadeS`).
// The view, once a frame: a soldier outside it skips his pieces (they cast no
// shadow) and his health bar (12 terrain taps for the hill test).
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const STATIC_SEED = [0.5, 0.5, 0.5, 0]; // a static figure's look variation: the middle, own headwear
const CORPSE_SECONDS = 14;  // a body stays this long after its death clip, then goes

/**
 * `types` / `typeKeys`: the game's unit list. `procedural`: { key: () => geometry }
 * for the types built in code (a type's `procedural` field names its builder).
 * `paint`: [r, g, b] painted-surface tint for those vehicles (a game's own
 * army colour, rtsObjectMaterialTinted); null = the kit's colours.
 */
export async function createUnitRenderer({ app, units, healthBars, selectionRings, fogOfWar = null, types, typeKeys = null, procedural = {}, paint = null, onCorpse = null }) {
  const UNIT_TYPES = types;
  const UNIT_TYPE_KEYS = typeKeys ?? Object.keys(types);
  const PROCEDURAL_VEHICLES = procedural;
  const { scene } = app;
  initGlbLoaderRenderer(app.renderer); // idempotent; wires KTX2 support

  // A vehicle built in code on the parts kit (`procedural`: rtsVehicles.js) —
  // built at its true size, so its targetLength is its own length and the
  // template scale comes out at 1.
  const buildProcedural = (k) => {
    const t = UNIT_TYPES[k];
    const geo = PROCEDURAL_VEHICLES[t.procedural]();
    const kitMat = paint ? rtsObjectMaterialTinted(paint) : rtsObjectMaterial();
    const body = new THREE.Mesh(geo, kitMat);
    const st = stencilMesh(geo.userData.stencil);
    if (st) body.add(st);
    const scene = new THREE.Group();
    scene.add(body);
    // A turret that turns to its target (instanced as kind "turret", like a
    // rotor), and running gear that rolls in its own shader.
    const tur = geo.userData.turret;
    if (tur) {
      const m = new THREE.Mesh(tur.geo, kitMat);
      m.name = "Turret";
      m.position.set(tur.pivot[0], tur.pivot[1], tur.pivot[2]);
      // The turret's own markings turn with it: named "Turret" too, so the
      // instancer treats them as a pivoted part (their origin IS the pivot).
      const tst = stencilMesh(tur.stencil);
      if (tst) { tst.name = "Turret"; m.add(tst); }
      scene.add(m);
    }
    // Its own odometer per type (the channel): see rtsRunningGearMaterial.
    if (geo.userData.gear) scene.add(new THREE.Mesh(geo.userData.gear, rtsRunningGearMaterial(paint, t.typeKey ?? k)));
    // Rotors: named so the instancer spins them round their own pivots
    // (MainRotor about Y, TailRotor about X).
    const rot = geo.userData.rotors;
    if (rot) {
      for (const [name, r] of [["MainRotor", rot.main], ["TailRotor", rot.tail]]) {
        const m = new THREE.Mesh(r.geo, kitMat);
        m.name = name;
        m.position.set(r.pivot[0], r.pivot[1], r.pivot[2]);
        scene.add(m);
      }
    }
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    t.targetLength = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    return { scene, animations: [] };
  };
  // `body` / `bodies`: a pack of soldiers on one skeleton (public/models/
  // soldiers/soldiers.glb holds several bodies). A template keeps ONE body —
  // the others are dropped before it is measured and scaled. A type with
  // several `bodies` (the ALN: aln1 + aln2) has a template per body, its
  // soldiers shared out between their crowds.
  const keepBody = (sceneRoot, body) => {
    const drop = [];
    sceneRoot.traverse((o) => { if (o.isSkinnedMesh && o.name !== body) drop.push(o); });
    for (const o of drop) o.removeFromParent();
  };
  const templateOf = (t, gltf) => ({
    ...buildTemplate(gltf.scene, {
      targetLength: t.targetLength,
      targetHeight: t.targetHeight,
      excludeRotorsFromBox: t.excludeRotorsFromBox,
      castShadow: t.castShadow !== false,
    }),
    animations: gltf.animations,
    skinned: !!t.skinned,
  });
  const bodiesOf = (t) => t.bodies ?? (t.body ? [t.body] : [null]);
  // ONE TEMPLATE PER MODEL: a type's own, or — for soldiers on a pack body —
  // one per (pack, body, height), shared by every type dressed on it: the GLB
  // is fetched and parsed once per body, not once per type (four soldier1
  // types parsed the 2.6 MB pack four times).
  const tplKey = (k, body) => {
    const t = UNIT_TYPES[k];
    return t.skinned && body ? `${t.url}|${body}|${t.targetHeight}` : `type:${k}`;
  };
  const loading = new Map(); // template key → Promise<template>
  const loadTemplate = (k, body) => {
    const key = tplKey(k, body);
    if (!loading.has(key)) {
      loading.set(key, (async () => {
        const t = UNIT_TYPES[k];
        const gltf = t.procedural ? buildProcedural(k) : await loadGltf(t.url);
        if (body) keepBody(gltf.scene, body);
        return { ...templateOf(t, gltf), body, key };
      })());
    }
    return loading.get(key);
  };
  const bodyTemplates = {}; // k → [its template per body]
  await Promise.all(UNIT_TYPE_KEYS.map(async (k) => {
    bodyTemplates[k] = await Promise.all(bodiesOf(UNIT_TYPES[k]).map((b) => loadTemplate(k, b)));
  }));
  const templates = {};     // k → its first body's template (thumbnails, the fallback path)
  for (const k of UNIT_TYPE_KEYS) templates[k] = bodyTemplates[k][0];
  if (!templates.helicopter?.rotors) {
    console.info("[rts-v3] no rotor node found in heli5.glb — rotors won't spin.");
  }

  // Skinned templates MUST clone via SkeletonUtils — a plain clone(true) leaves
  // the copy's SkinnedMeshes bound to the TEMPLATE's skeleton, so every clone
  // silently deforms with (or stays frozen at) the original's pose.
  const cloneTemplateRoot = (key) => {
    const tpl = templates[key];
    return tpl.skinned ? SkeletonUtils.clone(tpl.root) : tpl.root.clone(true);
  };

  // Rigid types render through shared InstancedMeshes; skinned types go through a
  // GPU-skinned CROWD (crowdSkinning.js) — ONE per body, every type dressed on
  // that body a view of it (buildCrowdGroup).
  const instanced = {};
  for (const k of UNIT_TYPE_KEYS) instanced[k] = templates[k].skinned ? null : buildInstancedType(templates[k], scene);
  const members = new Map(); // template key → { tpl, members: [{ key, type }] }
  for (const k of UNIT_TYPE_KEYS) {
    if (!templates[k].skinned) continue;
    for (const tpl of bodyTemplates[k]) {
      if (!members.has(tpl.key)) members.set(tpl.key, { tpl, members: [] });
      members.get(tpl.key).members.push({ key: k, type: UNIT_TYPES[k] });
    }
  }
  const groups = [];
  const groupOf = new Map(); // template key → group
  for (const [key, m] of members) {
    const g = buildCrowdGroup(m.tpl, m.members, app, scene);
    if (g) { groups.push(g); groupOf.set(key, g); }
  }
  /** Every crowd a type's soldiers go into: one per body. */
  const crowdByType = {};
  for (const k of UNIT_TYPE_KEYS) crowdByType[k] = templates[k].skinned ? bodyTemplates[k].map((t) => groupOf.get(t.key)).filter(Boolean) : [];
  const crowdsOf = (k) => crowdByType[k] ?? [];
  // The nth soldier of each type (spawn order): its ROLE in the look's section
  // (leader, radio, LMG, flag — soldierLooks.js) comes from n mod 12.
  const spawned = {};

  // Per-unit visuals.
  const views = new Map(); // unit → view
  const roots = [];        // raycast targets for selection
  const crowdUnits = [];   // crowd soldiers written this frame (they have no mesh)
  // STATIC FIGURES (addStaticFigures): people who are not units — Kurtz's
  // watchers on the temple steps. Written into a type's crowd AFTER its units,
  // so they cost no draw of their own, and they are not in crowdUnits, so
  // nothing can pick them. Each idles on its own clock, facing its own way.
  const statics = [];
  const _st = new THREE.Object3D();

  // Instanced units have no mesh of their own, so a raycast hit lands on the
  // shared InstancedMesh and identifies the unit by instanceId. This maps the
  // mesh back to the type whose per-frame instance list holds the units.
  const typeOfInstancedMesh = new Map();
  for (const k of UNIT_TYPE_KEYS) {
    const inst = instanced[k];
    if (!inst) continue;
    for (const p of inst.parts) {
      typeOfInstancedMesh.set(p.im, inst);
      roots.push(p.im);
    }
  }

  /** Build the visuals for one unit. Also used for units spawned at runtime. */
  function addUnit(unit) {
    const t = unit.type;
    const tpl = templates[t.typeKey];
    const inst = instanced[t.typeKey];
    // a type with several bodies shares its soldiers out between their crowds
    const crds = crowdsOf(t.typeKey);
    const crd = crds.length ? crds[Math.floor(Math.random() * crds.length)] : null;

    // An instanced unit owns NO scene objects — just an off-scene Object3D we use
    // to compose its transform (and to hold the slerped terrain tilt between frames).
    if (inst) {
      const xform = new THREE.Object3D();
      xform.scale.setScalar(inst.scale);
      views.set(unit, {
        inst, xform,
        bob: Math.random() * 6, mainAngle: Math.random() * 6, tailAngle: 0,
        turretAngle: 0, odo: 0, lastX: unit.position.x, lastZ: unit.position.z,
      });
      return;
    }

    // Same for a crowd soldier: no mesh, no mixer. Just a transform, its own
    // animation clock (so the squad isn't in lockstep) and an idle⇄run blend the
    // compute shader crossfades.
    if (crd) {
      const xform = new THREE.Object3D();
      xform.scale.setScalar(crd.scale);
      const t0 = Math.random() * 8;
      // His place in the look's section (spawn order, mod 12) and what he
      // wears and carries: soldierLooks.loadout — a headgear variant, his
      // role's weapon (or one from the look's mix), kit, rolled extras.
      const n = (spawned[t.typeKey] = (spawned[t.typeKey] ?? -1) + 1);
      const view = crd.views.get(t.typeKey);
      const load = view.look ? loadout(view.look, n % 12, () => Math.random()) : null;
      views.set(unit, {
        crowd: crd, view, xform, bob: 0,
        // the clip it's on, the one it's fading from, and how far the fade is
        cur: { clip: crd.roles.idle, t: t0 }, prev: { clip: crd.roles.idle, t: t0 }, fade: 1,
        firing: 0, lastCd: 0, lastX: unit.position.x, lastZ: unit.position.z, speed: 0,
        // his stable look variation (soldierLooks: cloth, sun-fade, skin) and,
        // in .w, "bare head": his body's own headwear hidden (a hat instead)
        seed: [Math.random(), Math.random(), Math.random(), soldierFlags(load && !load.look.helmet, load?.kit ?? [], crd.kitSkinned)],
        deadT: -1,
        weapon: load?.weapon ?? null,
        hat: load?.look.headgear ? hatKey(load.look) : null,
        kit: (load?.kit ?? []).filter((k) => KIT[k] && !KIT[k].skinned),
      });
      return;
    }

    const root = cloneTemplateRoot(t.typeKey);
    root.traverse((o) => { if (o.isMesh) unitByMesh.set(o, unit); });

    // Skinned units can't carry an instanceColor, so a non-player team takes a
    // tinted clone of the shared material. Player units keep sharing the
    // template's material — no clone, no extra pipeline, for the common case.
    if (!isUntinted(unit.team, t)) {
      const tint = teamTint(unit.team, t);
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.color.multiply(tint);
      });
    }

    // Skinned units get their own AnimationMixer (idle ⇄ run driven in sync()).
    let mixer = null, actions = null;
    if (tpl.skinned && tpl.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      actions = {};
      for (const clip of tpl.animations) actions[clip.name] = mixer.clipAction(clip);
      (actions.idle ?? Object.values(actions)[0])?.play();
      // Animated bones walk out of the bind-pose bounding sphere → the whole
      // unit vanishes at screen edges. Standard fix for crowds: don't cull.
      root.traverse((o) => { if (o.isSkinnedMesh) o.frustumCulled = false; });
    }

    root.traverse((o) => { if (o.isMesh) o.renderOrder = UNIT_ORDER; });
    scene.add(root);
    roots.push(root);
    views.set(unit, {
      root, xform: root,
      mixer, actions, currentAction: actions ? (actions.idle ? "idle" : Object.keys(actions)[0]) : null,
      bob: Math.random() * 6, mainAngle: Math.random() * 6, tailAngle: 0,
    });
  }

  /** Resolve a raycast hit to the unit it belongs to (instanced or not). */
  function unitFromHit(hit) {
    const inst = typeOfInstancedMesh.get(hit.object);
    if (inst) return inst.unitAt[hit.instanceId];
    let o = hit.object;
    while (o && !unitByMesh.get(o)) o = o.parent;
    return o ? unitByMesh.get(o) : null;
  }

  const _proj = new THREE.Vector3();

  // HOVER: the unit under the pointer, found in SCREEN space while the units
  // are written (sync) — crowd soldiers have no mesh to raycast, and a man at
  // RTS zoom is a few pixels tall. Used by the health bars (CoH: a bar shows
  // on a selected, hovered or damaged unit). One frame late; nobody can tell.
  const dom = app.renderer.domElement;
  let pointer = null;         // { x, y } client px, null off the canvas
  let hovered = null;
  const onPointerMove = (e) => { pointer = { x: e.clientX, y: e.clientY }; };
  const onPointerLeave = () => { pointer = null; };
  dom.addEventListener("pointermove", onPointerMove);
  dom.addEventListener("pointerleave", onPointerLeave);

  /**
   * Pick a crowd soldier by SCREEN PROXIMITY, not by raycast.
   *
   * Crowd soldiers exist only inside a compute buffer — there is no mesh under
   * the cursor to hit. Projecting them and taking the nearest within a few pixels
   * is both simpler and kinder than raycasting: a 1.9 m man at RTS zoom is a
   * miserable click target.
   */
  function pickCrowdUnit(clientX, clientY, camera, rect, maxPx = 22) {
    let best = null;
    let bestD = maxPx;
    for (const unit of crowdUnits) {
      if (!unit.alive) continue;
      const p = unit.position;
      _proj.set(p.x, p.y + 1, p.z).project(camera);
      if (_proj.z > 1) continue; // behind the camera
      const sx = rect.left + (_proj.x * 0.5 + 0.5) * rect.width;
      const sy = rect.top + (-_proj.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD) { bestD = d; best = unit; }
    }
    return best;
  }

  for (const unit of units.list) addUnit(unit);
  // Units built by the base at runtime get their visuals through this.
  units.setOnSpawn(addUnit);

  // UI thumbnails (clones share template geometry — safe; never dispose them).
  // The surface atlas is built in a worker (rtsTextures.rtsAtlas): a portrait
  // baked before its pixels land would show the neutral placeholder for good.
  await rtsAtlasReady();
  const thumbnails = await bakeThumbnails({
    renderer: app.renderer,
    items: UNIT_TYPE_KEYS.map((k) => ({ key: k, make: () => cloneTemplateRoot(k) })),
  });

  /** A crowd soldier just killed plays a death clip, then lies there a while. */
  function drawCorpse(unit, v, dt) {
    const r = v.crowd.roles;
    if (v.deadT < 0) {
      v.deadT = 0;
      v.prev = v.cur;
      // From the posture he was in (soldierTransitions.js): a man lying or
      // kneeling does not get up to fall.
      const d = deathFrom(v.prev.clip, r.deaths[Math.floor(v.seed[0] * 97) % r.deaths.length], r.deaths, (c) => v.crowd.field.duration(c));
      v.cur = { clip: d.clip, t: d.t };
      v.fade = 0;
      v.fadeS = d.fade;
      // Where his TORSO will lie (a game lays blood there — alg-rts): the
      // pack's deaths travel (tools/packMixamo.mjs report: forward 0.30 m,
      // backward 0.83 m), the chest ~0.45 m on from the hips.
      if (onCorpse) {
        const h = unit.heading + (unit.type.facingOffset ?? 0);
        const off = /backward/.test(v.cur.clip) ? -1.25 : 0.75;
        onCorpse(unit, unit.position.x + Math.sin(h) * off, unit.position.z + Math.cos(h) * off, h);
      }
    }
    v.deadT += dt;
    if (v.deadT > v.crowd.field.duration(v.cur.clip) + CORPSE_SECONDS) return;
    v.cur.t += dt;
    v.prev.t += dt;
    v.fade = Math.min(1, v.fade + dt / (v.fadeS ?? 0.2));
    v.view.dead.push(unit);   // written after his view's living (sync)
  }

  /** Push unit data into the meshes. Called once per frame by the game loop. */
  function sync(dt, camera) {
    // Instanced and crowd types are rebuilt from scratch each frame, so spawns and
    // deaths need no bookkeeping — a dead unit simply isn't written.
    for (const k of UNIT_TYPE_KEYS) if (instanced[k]) instanced[k].n = 0;
    for (const g of groups) {
      g.field.begin();
      for (const piece of g.pieces?.all ?? []) piece.n = 0;
      for (const view of g.views.values()) { view.living.length = 0; view.dead.length = 0; }
    }
    if (camera) _frustum.setFromProjectionMatrix(_viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const rect = pointer && camera ? dom.getBoundingClientRect() : null;
    // px a metre at unit distance: a vehicle's pick circle grows with its size on screen
    const pxPerM = rect ? rect.height / (2 * Math.tan(THREE.MathUtils.degToRad((camera.fov ?? 50) / 2))) : 0;
    let nextHovered = null, hoverD = Infinity;
    crowdUnits.length = 0;

    for (const unit of units.list) {
      const v = views.get(unit);
      if (!v) continue;

      if (!unit.alive) {
        if (v.root) v.root.visible = false;
        // A crowd soldier with death clips falls, then lies there a while.
        if (v.crowd?.roles.deaths.length && !(fogOfWar?.enabled && unit.team !== "player" && !fogOfWar.canSeeEntity(unit))) {
          drawCorpse(unit, v, dt);
        }
        continue;
      }

      if (fogOfWar?.enabled && unit.team !== "player" && !fogOfWar.canSeeEntity(unit)) {
        if (v.root) v.root.visible = false;
        continue;
      }

      const t = unit.type;
      const p = unit.position;
      const x = v.xform; // the unit's transform: its Group, or an off-scene proxy
      // On screen (a sphere round the unit, its bar included)? Off it, a soldier
      // skips his pieces and every unit its health bar — in a match most of the
      // army is off screen.
      _sphere.center.set(p.x, p.y + (t.barY ?? 3) * 0.5, p.z);
      _sphere.radius = (t.radius ?? 1) + (t.barY ?? 3);
      v.onScreen = !camera || _frustum.intersectsSphere(_sphere);

      const bobY = t.isAir ? Math.sin((v.bob += dt) * 1.6) * 0.25 : 0;
      x.position.set(p.x, p.y + bobY, p.z);

      const yaw = unit.heading + (t.facingOffset ?? 0);
      if (t.isAir || !app.getWorldNormal) {
        x.rotation.y = yaw; // air stays level
      } else {
        // Ground units tilt to the terrain: align local up to the surface
        // normal, then yaw around it. Slerp so it eases over bumps.
        // On a bridge deck: upright — the terrain under it is the river bank,
        // and its slope would tip a jeep crossing a flat deck.
        const onDeck = app.bridgeDecks?.heightAt(p.x, p.z) != null;
        const gn = onDeck ? _UP : app.getWorldNormal(p.x, p.z);
        _n.set(gn.x, gn.y, gn.z);
        // VEHICLES SIT ON THEIR WHEELS: the normal at one point (the centre)
        // ignored a bump or dip under a wheel, which sank up to ~0.5 m. Sample
        // the ground under the four wheels (the wheelbase from the unit's
        // radius: ~2:1 long), fit the body to them, and lift it until no wheel
        // is under the ground (on a twist one floats a little instead).
        const R = t.radius ?? 1;
        if (!onDeck && R > 1.5 && app.getWorldHeight) {
          const hl = R * 0.8, hw = R * 0.42, s = Math.sin(yaw), c = Math.cos(yaw);
          const H = (fx, rx) => app.getWorldHeight(p.x + s * fx + c * rx, p.z + c * fx - s * rx);
          const fl = H(hl, -hw), fr = H(hl, hw), rl = H(-hl, -hw), rr = H(-hl, hw);
          const sF = (fl + fr - rl - rr) / (4 * hl), sR = (fr + rr - fl - rl) / (4 * hw);
          const h0 = (fl + fr + rl + rr) / 4, twist = Math.abs(fl + rr - fr - rl) / 4;
          x.position.y = h0 + twist + bobY;
          _n.set(-sF * s - sR * c, 1, -sF * c + sR * s).normalize();
        }
        _alignQ.setFromUnitVectors(_UP, _n);
        _yawQ.setFromAxisAngle(_UP, yaw);
        _targetQ.copy(_alignQ).multiply(_yawQ);
        // First frame: SNAP to the spawn heading. A fresh xform is identity
        // (facing +Z), so slerping would make the unit visibly pivot from +Z to
        // its real heading as it leaves the hangar — the "quick shift". After
        // that, ease so it rolls smoothly over terrain bumps.
        if (v.oriented) x.quaternion.slerp(_targetQ, Math.min(1, dt * 12));
        else { x.quaternion.copy(_targetQ); v.oriented = true; }
      }

      // rotorSpin: a helicopter spooling up on its pad turns slower (units.js launch).
      const spin = unit.rotorSpin ?? 1;
      v.mainAngle += dt * 28 * spin;
      v.tailAngle += dt * 28 * 2.4 * spin;
      if (v.inst?.turret) {
        // The cupola turns to its target, in the hull's frame, eased; with no
        // target it comes back to the front.
        let want = 0;
        const tg = unit.target;
        if (tg?.alive) want = Math.atan2(tg.position.x - p.x, tg.position.z - p.z) - yaw;
        let d = want - v.turretAngle;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        v.turretAngle += d * Math.min(1, dt * 5);
        // RECOIL: a gun shot (projectiles.js counts them) throws the turret
        // back and rocks the hull nose-up; both ease home over half a second.
        // Visual only — the sim never sees it.
        if ((unit.gunShots ?? 0) !== (v.gunShots ?? 0)) { v.gunShots = unit.gunShots; v.recoil = 1; }
        v.recoil = Math.max(0, (v.recoil ?? 0) - dt * 2);
      }
      if (v.inst?.odometer) {
        // Distance travelled along the hull's own forward: reversing rolls back.
        const mx = p.x - v.lastX, mz = p.z - v.lastZ;
        v.odo += mx * Math.sin(yaw) + mz * Math.cos(yaw);
        v.lastX = p.x; v.lastZ = p.z;
      }

      // Instanced unit: write one matrix per template part and move on.
      if (v.inst) {
        const inst = v.inst;
        const i = inst.n;
        if (i < MAX_PER_TYPE) {
          x.updateMatrix(); // off-scene: nothing else will do this for us
          const kick = (v.recoil ?? 0) ** 2;   // snaps back at once, returns slowly
          if (kick > 0) x.matrix.multiply(_rock.makeRotationX(-0.035 * kick));
          const tint = teamTint(unit.team, unit.type);
          for (const part of inst.parts) {
            if (part.kind) {
              _euler.copy(part.baseEuler);
              if (part.kind === "main") _euler.y = v.mainAngle;
              else if (part.kind === "turret") _euler.y = part.baseEuler.y + v.turretAngle;
              else _euler.x = v.tailAngle;
              _kickPos.copy(part.basePos);
              if (part.kind === "turret" && kick > 0) {
                // Back along the gun's line, 0.45 m in the world (the template is scaled).
                const back = 0.45 * kick / inst.scale;
                _kickPos.x -= Math.sin(v.turretAngle) * back;
                _kickPos.z -= Math.cos(v.turretAngle) * back;
              }
              _local.compose(_kickPos, _quat.setFromEuler(_euler), part.baseScale);
              _mat.multiplyMatrices(part.parentRel, _local).premultiply(x.matrix);
            } else {
              _mat.multiplyMatrices(x.matrix, part.rel);
            }
            part.im.setMatrixAt(i, _mat);
            part.im.setColorAt(i, tint); // same material, different side
          }
          inst.team.setX(i, unit.team === "player" ? 0 : 1);
          if (inst.odometer) inst.odometer.setX(i, v.odo);
          inst.unitAt[i] = unit; // so a raycast on instanceId finds this unit
          inst.n = i + 1;
        }
      }

      // Crowd soldier: no mesh and no mixer — a transform, and two clips (the
      // one it's on, the one it's fading from) the compute shader crossfades.
      if (v.crowd) {
        const r = v.crowd.roles;
        // A shot: the sim resets the cooldown upward (combat.js) — play the
        // firing clip for its length, from its start.
        const cd = unit.cooldown ?? 0;
        if (r.fire && cd > v.lastCd + 1e-6) {
          v.firing = v.crowd.field.duration(r.fire);
          if (v.cur.clip === r.fire || v.cur.clip === r.crouchFire) v.cur.t = 0;
        }
        v.lastCd = cd;
        v.firing = Math.max(0, v.firing - dt);
        // measured ground speed (smoothed) → the run plays at the unit's pace
        const moved = Math.hypot(p.x - v.lastX, p.z - v.lastZ) / Math.max(dt, 1e-4);
        v.lastX = p.x; v.lastZ = p.z;
        v.speed += (moved - v.speed) * Math.min(1, dt * 6);

        const want = soldierClip(unit, v, r);
        if (want !== v.cur.clip) {
          v.prev = v.cur;
          // a shot / a throw from its start (a throw from its own offset: algGrenades.js)
          const t0 = want === r.grenade ? unit.throwing?.start ?? 0
            : want === r.fire || want === r.crouchFire ? 0 : Math.random() * v.crowd.field.duration(want);
          v.cur = { clip: want, t: t0 };
          v.fade = 0;
          v.fadeS = fadeFor(v.prev.clip, want);
        }
        const rate = v.cur.clip === r.run && v.crowd.runSpeed > 0
          ? THREE.MathUtils.clamp(v.speed / v.crowd.runSpeed, 0.6, 1.6) : 1;
        v.cur.t += dt * rate;
        v.prev.t += dt;
        v.fade = Math.min(1, v.fade + dt / (v.fadeS ?? 0.2));

        x.updateMatrix(); // off-scene: nothing else will do this for us
        v.view.living.push(unit); // into the crowd after the loop, grouped by view
        if (v.onScreen) writePieces(v.crowd, v, x.matrix);
        crowdUnits.push(unit);
      }

      // Skinned units on the fallback path: run while moving, idle while holding.
      if (v.mixer) {
        const want = unit.isMoving && v.actions.run
          ? "run"
          : (v.actions.idle ? "idle" : v.currentAction);
        if (want !== v.currentAction) {
          v.actions[v.currentAction]?.fadeOut(0.15);
          v.actions[want]?.reset().fadeIn(0.15).play();
          v.currentAction = want;
        }
        v.mixer.update(dt);
      }

      // Under the pointer? The nearest unit within its pick circle on screen.
      if (rect && v.onScreen) {
        _proj.set(p.x, p.y + 1, p.z).project(camera);
        if (_proj.z < 1) {
          const sx = rect.left + (_proj.x * 0.5 + 0.5) * rect.width;
          const sy = rect.top + (-_proj.y * 0.5 + 0.5) * rect.height;
          const d = Math.hypot(sx - pointer.x, sy - pointer.y);
          const dist = Math.max(1, camera.position.distanceTo(p));
          const reach = Math.max(22, (t.radius ?? 1) * pxPerM / dist);
          if (d < reach && d < hoverD) { hoverD = d; nextHovered = unit; }
        }
      }

      // Health bar — one instance in the shared field (see healthBar.js). As in
      // Company of Heroes, only on a unit that is SELECTED, HOVERED or DAMAGED
      // (your call, 2026-09-30): a bar over every man was a sea of green at 600.
      if (v.onScreen && (unit.selected || unit === hovered || unit.hp < unit.maxHp)) healthBars.add(
        p.x, p.y + (t.barY ?? 6) + bobY, p.z,
        t.barWidth,
        unit.hp / unit.maxHp,
        unit.team === "enemy",
        camera,
      );

      // Selection ring — one instance in the shared field. The draping over the
      // terrain happens in its vertex shader, so all we push is centre + radius.
      if (unit.selected) selectionRings?.add(p.x, p.z, t.ringRadius);
    }

    for (const k of UNIT_TYPE_KEYS) {
      const inst = instanced[k];
      if (inst) {
        for (const part of inst.parts) {
          part.im.count = inst.n;
          // A count-0 InstancedMesh still costs a draw in every pass it's in
          // (beauty + each shadow cascade) — hide the field when the type has
          // no live units (builders at boot, or a type wiped out).
          part.im.visible = inst.n > 0;
          part.im.instanceMatrix.needsUpdate = true;
          part.im.instanceColor.needsUpdate = true;
          part.xray.count = inst.n;
          part.xray.visible = inst.n > 0 && xrayOn();
        }
        if (inst.n) {
          inst.team.clearUpdateRanges();
          inst.team.addUpdateRange(0, inst.n);
          inst.team.needsUpdate = true;
        }
        if (inst.odometer && inst.n) {
          inst.odometer.needsUpdate = true;
          inst.odometer.clearUpdateRanges?.();
          inst.odometer.addUpdateRange?.(0, inst.n);   // only the live units' slots
        }
      }
    }
    hovered = nextHovered;

    // THE CROWDS: each view's soldiers in one contiguous range — its living,
    // then its corpses, then the static figures of its type — then the pieces
    // uploaded, the skinning dispatched, the x-ray sized. Lane (the anim
    // record's .w): the team for the living, 2 + team for the rest (no
    // silhouette).
    for (const g of groups) {
      const f = g.field;
      for (const view of g.views.values()) {
        const start = f.count;
        for (const unit of view.living) {
          const v = views.get(unit);
          _mat.multiplyMatrices(v.xform.matrix, g.rel);
          f.addPose(_mat, v.prev.clip, v.prev.t, v.cur.clip, v.cur.t, v.fade,
            unit.team === "player" ? 0 : 1, { extra: v.seed });
        }
        for (const unit of view.dead) {
          const v = views.get(unit);
          _mat.multiplyMatrices(v.xform.matrix, g.rel);
          const dying = (clip) => g.roles.deaths.includes(clip);
          f.addPose(_mat, v.prev.clip, v.prev.t, v.cur.clip, v.cur.t, v.fade,
            unit.team === "player" ? 2 : 3, { holdA: dying(v.prev.clip), holdB: true, extra: v.seed });
          _sphere.center.copy(v.xform.position);
          _sphere.radius = 3;
          if (!camera || _frustum.intersectsSphere(_sphere)) writePieces(g, v, v.xform.matrix, dying(v.prev.clip), true);
        }
        for (const st of statics) {
          if (st.typeKey !== view.key) continue;
          // Skinned every frame they are drawn: only when the camera is near.
          if (camera && (st.x - camera.position.x) ** 2 + (st.z - camera.position.z) ** 2 > 350 * 350) continue;
          st.t += dt;
          _st.position.set(st.x, st.y, st.z);
          _st.rotation.set(0, st.yaw + (UNIT_TYPES[view.key].facingOffset ?? 0), 0);
          _st.scale.setScalar(g.scale);
          _st.updateMatrix();
          _mat.multiplyMatrices(_st.matrix, g.rel);
          f.addPose(_mat, g.roles.idle, st.t, g.roles.idle, st.t, 0, 2, { extra: STATIC_SEED });
        }
        view.setRange(start, f.count - start);
      }
      for (const piece of g.pieces?.all ?? []) {
        piece.im.count = piece.n;
        piece.im.visible = piece.n > 0;
        if (piece.n) piece.im.instanceMatrix.needsUpdate = true;
      }
      // Uploads the per-soldier buffers and dispatches the skinning compute pass.
      f.commit();
      g.xray.count = f.count;
      g.xray.visible = f.count > 0 && xrayOn();
    }
  }

  return {
    /** People who are not units: [{ x, y, z, yaw }] drawn idle in `typeKey`'s crowd, every frame. */
    addStaticFigures(typeKey, list) {
      for (const f of list) statics.push({ typeKey, x: f.x, y: f.y, z: f.z, yaw: f.yaw, t: Math.random() * 10 });
      return statics.length;
    },
    thumbnails,
    roots,          // raycast targets for selection (instanced meshes + skinned groups)
    unitByMesh,
    unitFromHit,    // resolves a raycast hit, instanced or not
    pickCrowdUnit,  // crowd soldiers have no mesh — pick them by screen proximity
    addUnit,
    sync,
    /** The unit under the pointer (screen space, as of the last sync), or null. */
    get hovered() { return hovered; },
    dispose() {
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerleave", onPointerLeave);
      for (const v of views.values()) {
        if (v.root) scene.remove(v.root);
      }
      for (const k of UNIT_TYPE_KEYS) {
        for (const part of instanced[k]?.parts ?? []) scene.remove(part.im);
      }
      views.clear();
    },
  };
}
