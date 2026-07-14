// RTS unit RENDERER — GAME code. Turns mesh-free unit data (units.js) into
// visuals: model, rotors, terrain tilt, health bar, selection ring.
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
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { materialColor } from "three/tsl";
import { teamTint, isUntinted } from "./teams.js";
import { createCrowdField } from "./crowdSkinning.js";
import { getSharedGltfLoader, initGlbLoaderRenderer } from "../../v2/core/foliage/glbLoader.js";
import { bakeThumbnails } from "./thumbnails.js";
import { UNIT_TYPES, UNIT_TYPE_KEYS } from "./unitTypes.js";

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
    if (o.name === "MainRotor" || o.name === "TailRotor") return; // own pivots — leave them
    if (o.material.map) return;                                   // textured — can't share the material
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

/**
 * A plain three material carries no node, and three's NodeMaterialObserver only
 * re-uploads uniforms for materials that do (or whose mesh moved). An
 * InstancedMesh NEVER moves — the instances do — so its scene fog uniforms would
 * FREEZE, exactly like the static structures did. `materialColor` reads the
 * material's own color AND its map, so the model keeps its texture.
 */
function refreshingMaterial(src) {
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

    const im = new THREE.InstancedMesh(o.geometry, refreshingMaterial(o.material), MAX_PER_TYPE);
    im.count = 0;
    im.castShadow = o.castShadow; // the type's shadow policy, set on the template
    im.receiveShadow = true;
    im.frustumCulled = false; // instances live anywhere; the shared bounds are meaningless

    // Team color (teams.js). Allocated UP FRONT, not lazily via setColorAt: three
    // decides whether to compile `vInstanceColor` into the shader by looking at
    // object.instanceColor when the material is first built, so a buffer that
    // appears later would simply be ignored. White = untinted.
    im.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PER_TYPE * 3).fill(1), 3,
    );
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);

    scene.add(im);

    const kind = o.name === "MainRotor" ? "main" : o.name === "TailRotor" ? "tail" : null;
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
  return { parts, scale: root.scale.x, n: 0, unitAt: [] };
}

// ── Crowd (skinned types) ────────────────────────────────────────────────────
// Skinned units can't join an InstancedMesh, so they get the compute-skinning
// path instead: the clips are baked to a bone-matrix table, a compute pass skins
// every soldier into a storage buffer, and ONE Mesh draws the lot. Adding
// soldiers costs no draw calls and (measured in the lab) no CPU either.

const MAX_CROWD = 128; // soldiers renderable at once; sizes the skin buffer

/** Wire a skinned template up to a crowd field. */
function buildCrowdType(tpl, type, app, scene) {
  const root = tpl.root;
  root.updateMatrixWorld(true);

  let source = null;
  root.traverse((o) => { if (!source && o.isSkinnedMesh) source = o; });
  if (!source) {
    console.warn("[rts-v3] skinned template has no SkinnedMesh — crowd disabled.");
    return null;
  }

  const byName = (re) => tpl.animations.find((a) => re.test(a.name));
  const idle = byName(/idle/i) ?? tpl.animations[0];
  const run = byName(/run|walk/i) ?? idle;
  if (!idle) {
    console.warn("[rts-v3] skinned template has no clips — crowd disabled.");
    return null;
  }

  const field = createCrowdField({
    scene,
    renderer: app.renderer,
    source,
    animRoot: root,
    clips: { idle, run },
    max: MAX_CROWD,
    // The shadow pass picks up the compute-skinned positions for free: it renders
    // the object with an override material but keeps the material's `positionNode`
    // (Renderer._getShadowNodes), so the crowd casts its real animated silhouette.
    // Costs 3 draws (one per CSM cascade) for the ENTIRE crowd, 6 soldiers or 106.
    castShadow: type.castShadow !== false,
  });

  // The compute pass emits vertices in the TEMPLATE MESH's local space, which
  // knows nothing about buildTemplate's normalisation (the centring offset and
  // the scale that makes the model targetHeight tall). Fold that in, exactly like
  // the rigid instanced parts do: rel = root⁻¹ · mesh, applied inside the unit's
  // own transform.
  const rel = new THREE.Matrix4()
    .copy(root.matrixWorld).invert()
    .multiply(source.matrixWorld);

  return { field, rel, scale: root.scale.x };
}

// Selection ring: a flat ring in the XZ plane whose vertices are displaced to
// the terrain height each frame (a conforming decal). Because it hugs the
// ground we keep depthTest ON, so the unit properly occludes it — depthTest:false
// would draw the ring *over* the unit.
function makeSelectionRing(radius, color = 0x6ab0ff) {
  const geo = new THREE.RingGeometry(radius * 0.82, radius, 48).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    depthWrite: false, depthTest: true, fog: false, // selection UI — never fogged
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const ring = new THREE.Mesh(geo, mat);
  ring.visible = false;
  ring.frustumCulled = false;
  return ring;
}

export async function createUnitRenderer({ app, units, healthBars }) {
  const { scene } = app;
  initGlbLoaderRenderer(app.renderer); // idempotent; wires KTX2 support

  // One template per type.
  const loaded = await Promise.all(UNIT_TYPE_KEYS.map((k) => loadGltf(UNIT_TYPES[k].url)));
  const templates = {};
  UNIT_TYPE_KEYS.forEach((k, i) => {
    const t = UNIT_TYPES[k];
    templates[k] = {
      ...buildTemplate(loaded[i].scene, {
        targetLength: t.targetLength,
        targetHeight: t.targetHeight,
        excludeRotorsFromBox: t.excludeRotorsFromBox,
        castShadow: t.castShadow !== false,
      }),
      animations: loaded[i].animations,
      skinned: !!t.skinned,
    };
  });
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
  // GPU-skinned CROWD field (crowdSkinning.js) — also one draw for all of them.
  // `instanced[key]` / `crowd[key]` is null for the type that doesn't apply.
  const instanced = {};
  const crowd = {};
  for (const k of UNIT_TYPE_KEYS) {
    instanced[k] = templates[k].skinned ? null : buildInstancedType(templates[k], scene);
    crowd[k] = templates[k].skinned ? buildCrowdType(templates[k], UNIT_TYPES[k], app, scene) : null;
  }

  // Per-unit visuals.
  const views = new Map(); // unit → view
  const roots = [];        // raycast targets for selection
  const crowdUnits = [];   // crowd soldiers written this frame (they have no mesh)

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
    const crd = crowd[t.typeKey];

    const ring = makeSelectionRing(t.ringRadius);
    const ringPos = ring.geometry.attributes.position;
    const ringBase = Float32Array.from(ringPos.array); // flat XZ offsets (y = 0)
    scene.add(ring);

    // An instanced unit owns NO scene objects — just an off-scene Object3D we use
    // to compose its transform (and to hold the slerped terrain tilt between frames).
    if (inst) {
      const xform = new THREE.Object3D();
      xform.scale.setScalar(inst.scale);
      views.set(unit, {
        inst, xform, ring, ringPos, ringBase,
        bob: Math.random() * 6, mainAngle: Math.random() * 6, tailAngle: 0,
      });
      return;
    }

    // Same for a crowd soldier: no mesh, no mixer. Just a transform, its own
    // animation clock (so the squad isn't in lockstep) and an idle⇄run blend the
    // compute shader crossfades.
    if (crd) {
      const xform = new THREE.Object3D();
      xform.scale.setScalar(crd.scale);
      views.set(unit, {
        crowd: crd, xform, ring, ringPos, ringBase,
        animTime: Math.random() * 3, blend: 0, bob: 0,
      });
      return;
    }

    const root = cloneTemplateRoot(t.typeKey);
    root.traverse((o) => { if (o.isMesh) unitByMesh.set(o, unit); });

    // Skinned units can't carry an instanceColor, so a non-player team takes a
    // tinted clone of the shared material. Player units keep sharing the
    // template's material — no clone, no extra pipeline, for the common case.
    if (!isUntinted(unit.team)) {
      const tint = teamTint(unit.team);
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

    scene.add(root);
    roots.push(root);
    views.set(unit, {
      root, xform: root, ring, ringPos, ringBase,
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
  const thumbnails = await bakeThumbnails({
    renderer: app.renderer,
    items: UNIT_TYPE_KEYS.map((k) => ({ key: k, make: () => cloneTemplateRoot(k) })),
  });

  /** Push unit data into the meshes. Called once per frame by the game loop. */
  function sync(dt, camera) {
    // Instanced and crowd types are rebuilt from scratch each frame, so spawns and
    // deaths need no bookkeeping — a dead unit simply isn't written.
    for (const k of UNIT_TYPE_KEYS) {
      if (instanced[k]) instanced[k].n = 0;
      if (crowd[k]) crowd[k].field.begin();
    }
    crowdUnits.length = 0;

    for (const unit of units.list) {
      const v = views.get(unit);
      if (!v) continue;

      if (!unit.alive) {
        if (v.root) v.root.visible = false;
        v.ring.visible = false;
        continue;
      }

      const t = unit.type;
      const p = unit.position;
      const x = v.xform; // the unit's transform: its Group, or an off-scene proxy

      const bobY = t.isAir ? Math.sin((v.bob += dt) * 1.6) * 0.25 : 0;
      x.position.set(p.x, p.y + bobY, p.z);

      const yaw = unit.heading + (t.facingOffset ?? 0);
      if (t.isAir || !app.getWorldNormal) {
        x.rotation.y = yaw; // air stays level
      } else {
        // Ground units tilt to the terrain: align local up to the surface
        // normal, then yaw around it. Slerp so it eases over bumps.
        const gn = app.getWorldNormal(p.x, p.z);
        _n.set(gn.x, gn.y, gn.z);
        _alignQ.setFromUnitVectors(_UP, _n);
        _yawQ.setFromAxisAngle(_UP, yaw);
        _targetQ.copy(_alignQ).multiply(_yawQ);
        x.quaternion.slerp(_targetQ, Math.min(1, dt * 12));
      }

      v.mainAngle += dt * 28;
      v.tailAngle += dt * 28 * 2.4;

      // Instanced unit: write one matrix per template part and move on.
      if (v.inst) {
        const inst = v.inst;
        const i = inst.n;
        if (i < MAX_PER_TYPE) {
          x.updateMatrix(); // off-scene: nothing else will do this for us
          const tint = teamTint(unit.team);
          for (const part of inst.parts) {
            if (part.kind) {
              _euler.copy(part.baseEuler);
              if (part.kind === "main") _euler.y = v.mainAngle;
              else _euler.x = v.tailAngle;
              _local.compose(part.basePos, _quat.setFromEuler(_euler), part.baseScale);
              _mat.multiplyMatrices(part.parentRel, _local).premultiply(x.matrix);
            } else {
              _mat.multiplyMatrices(x.matrix, part.rel);
            }
            part.im.setMatrixAt(i, _mat);
            part.im.setColorAt(i, tint); // same material, different side
          }
          inst.unitAt[i] = unit; // so a raycast on instanceId finds this unit
          inst.n = i + 1;
        }
      }

      // Crowd soldier: no mesh and no mixer — just a transform, an animation
      // clock, and a blend weight the compute shader crossfades idle⇄run with.
      if (v.crowd) {
        v.animTime += dt;
        const want = unit.isMoving ? 1 : 0;
        v.blend += (want - v.blend) * Math.min(1, dt * 8); // ~0.15 s crossfade
        x.updateMatrix(); // off-scene: nothing else will do this for us
        _mat.multiplyMatrices(x.matrix, v.crowd.rel);
        v.crowd.field.add(_mat, v.animTime, v.blend);
        crowdUnits.push(unit); // instance order = pick order (see pickCrowdUnit)
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

      // Health bar — one instance in the shared field (see healthBar.js).
      healthBars.add(
        p.x, p.y + (t.barY ?? 6) + bobY, p.z,
        t.barWidth,
        unit.hp / unit.maxHp,
        unit.team === "enemy",
        camera,
      );

      // Selection ring — drape over the terrain, only while shown.
      v.ring.visible = unit.selected;
      if (unit.selected) {
        v.ring.position.set(p.x, 0, p.z);
        for (let i = 0; i < v.ringPos.count; i++) {
          const bx = v.ringBase[i * 3], bz = v.ringBase[i * 3 + 2];
          v.ringPos.setY(i, app.getWorldHeight(p.x + bx, p.z + bz) + 0.25);
        }
        v.ringPos.needsUpdate = true;
      }
    }

    for (const k of UNIT_TYPE_KEYS) {
      const inst = instanced[k];
      if (inst) {
        for (const part of inst.parts) {
          part.im.count = inst.n;
          part.im.instanceMatrix.needsUpdate = true;
          part.im.instanceColor.needsUpdate = true;
        }
      }
      // Uploads the per-soldier buffers and dispatches the skinning compute pass.
      crowd[k]?.field.commit();
    }
  }

  return {
    thumbnails,
    roots,          // raycast targets for selection (instanced meshes + skinned groups)
    unitByMesh,
    unitFromHit,    // resolves a raycast hit, instanced or not
    pickCrowdUnit,  // crowd soldiers have no mesh — pick them by screen proximity
    addUnit,
    sync,
    dispose() {
      for (const v of views.values()) {
        if (v.root) scene.remove(v.root);
        scene.remove(v.ring);
      }
      for (const k of UNIT_TYPE_KEYS) {
        for (const part of instanced[k]?.parts ?? []) scene.remove(part.im);
      }
      views.clear();
    },
  };
}
