// Pack a folder of soldiers into ONE .glb: one skeleton, the clips once, and
// every soldier mesh skinned to that skeleton.
//
//   node tools/packMixamo.mjs [folder] [--out file.glb] [--tex 512] [--height 1.8]
//
//   folder     default public/models/soldiers
//   --out      default <folder>/soldiers.glb
//   --tex      longest side for PNG textures (default 512; 0 = keep). KTX2
//              textures are copied as they are — resize those in the KTX tool.
//   --height   the soldiers' height in metres (default 1.8). The games rescale
//              to their own unit height anyway; this only makes the file sane.
//
// THE FOLDER
//   *.fbx  Mixamo downloads. ONE "With Skin" (the RIG: its skeleton and skin
//          weights are what every soldier gets) and any number "Without Skin"
//          (animation only, "In Place" ticked on anything that moves). Each clip
//          is NAMED AFTER ITS FILE: crouch_walk.fbx → clip "crouch_walk" —
//          Mixamo names every clip "mixamo.com". The rig's textures sit in the
//          folder as PNGs; the FBX material names which one is the colour map.
//   *.glb  More soldiers, UNRIGGED, the same kind of body in the same pose as
//          the rig (exported from Blender; Draco/quantised/KTX2 are fine).
//          Name = file name without "_compressed": soldier3_compressed.glb →
//          mesh "soldier3".
//
// HOW A GLB SOLDIER GETS THE SKELETON
//   It is scaled to the rig's height and laid over it (bounding boxes: same
//   height, same centre, feet together). Then every vertex takes its bone
//   weights from the NEAREST POINT ON THE RIG'S SURFACE, blended across that
//   triangle — Blender's "Data Transfer" in code. It is only as good as the fit:
//   the report prints how far each soldier's vertices sit from the rig's skin,
//   and a soldier in another pose or another build is refused, not guessed.
//
// WHAT IT DOES TO THE DATA
//   - vertex data cut to position/normal/uv/skinIndex/skinWeight, then welded
//   - clips: tracks checked against the skeleton, redundant keys removed
//   - ONE texture per soldier, the colour map. Normal and metal/roughness maps
//     are dropped: the crowd renderer (games/shared-rts/crowdSkinning.js) sets
//     its own normalNode, which makes three ignore any normal map, and a matte
//     uniform seen from an RTS camera shows nothing a roughness map adds.
//   - single-sided materials: a closed body never shows its inside.
//
// No dependencies beyond the project's: three's FBXLoader/GLTFExporter run in
// Node with a FileReader stub, Draco is decoded with three's own decoder,
// three-mesh-bvh finds the nearest surface points, and PNG is decoded/encoded
// here with node:zlib because the exporter wants a canvas for images.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

// ── Node shims for the three.js loader/exporter ─────────────────────────────
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(ab).toString("base64")}`;
      this.onloadend?.();
    });
  }
};

const THREE = await import("three");
const { FBXLoader } = await import("three/addons/loaders/FBXLoader.js");
const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
const { mergeVertices } = await import("three/addons/utils/BufferGeometryUtils.js");
const { MeshBVH } = await import("three-mesh-bvh");

// FBXLoader asks for every texture; Node can't decode them and we don't need
// it to — remember WHICH file each slot asked for and match it to the PNGs.
THREE.TextureLoader.prototype.load = function (url) {
  const t = new THREE.Texture();
  t.userData.src = url;
  return t;
};

// Mixamo meshes carry up to 8 weights a vertex; FBXLoader keeps the 4 biggest
// and says so once per mesh. Expected, so quiet it — along with the embedded
// .fbm images it can't read in Node (we use the loose PNGs instead).
const warn = console.warn;
console.warn = (...a) => {
  const s = String(a[0]);
  if (s.includes("more than 4 skinning weights") || s.includes("is not supported")) return;
  warn(...a);
};

// Fit limits for a GLB soldier laid over the rig (cm at 1.8 m). Soldier3 on the
// first rig measured median 0.7 / 99th percentile 4.2; a different pose or build
// lands far above these.
const FIT_MEDIAN_MAX_CM = 3;
const FIT_P99_MAX_CM = 12;

// Mixamo title (the downloaded file name, lower-case, without " (1)") → the
// clip's ROLE name, which is what the games look clips up by. A title not in
// here keeps a tidied version of itself and is flagged in the report. How the
// rifle is held is NOT read from these names — it is measured (addWeaponBone):
// only the "unarmed_" prefix and the words aim / firing / shoot matter.
const ROLES = {
  // The first test downloads, before the rifle set: no rifle in the hands.
  "idle": "unarmed_idle",
  "walking": "unarmed_walk",
  "running": "unarmed_run",
  // Rifle set.
  "rifle idle": "rifle_idle",
  "rifle aiming idle": "rifle_aim_idle",
  "rifle walk": "rifle_walk",
  "rifle run": "rifle_run",
  "rifle sprint": "rifle_sprint",
  "sprint": "rifle_sprint",
  "firing rifle": "rifle_firing",
  "rifle crouch walk": "rifle_crouch_walk",
  "crouch walk": "rifle_crouch_walk",
  "rifle crouch idle": "rifle_crouch_idle",
  "crouching idle": "rifle_crouch_idle",
  "kneeling idle": "rifle_crouch_idle",
  "kneeling firing": "rifle_crouch_firing",
  "crouch firing": "rifle_crouch_firing",
  "reloading": "rifle_reload",
  "reload": "rifle_reload",
  "prone idle": "rifle_prone_idle",
  "prone forward": "rifle_crawl",
  "crawling": "rifle_crawl",
  "crawl": "rifle_crawl",
  "prone firing": "rifle_prone_firing",
  "toss grenade": "grenade_throw",
  "throw grenade": "grenade_throw",
  "hit reaction": "hit",
  "dying": "death_forward",
  "death": "death_forward",
  "falling back death": "death_backward",
  "flying back death": "death_blown",
  "digging": "dig",
  "shoveling": "dig",
  "hammering": "hammer",
};

// Shouldered rifle (firing / aiming clips): the butt sits this far from the
// right arm joint toward the clavicle (the shoulder pocket), and the grip this
// far in front of the butt plate (the MAS 49/56's length of pull, 33 cm).
const BUTT_IN = 0.35;
const BUTT_TO_GRIP = 0.334;

// glTF accessor component types: [bytes, DataView getter, normalisation divisor].
const COMPONENT = {
  5120: [1, "getInt8", 127], 5121: [1, "getUint8", 255], 5122: [2, "getInt16", 32767],
  5123: [2, "getUint16", 65535], 5125: [4, "getUint32", 1], 5126: [4, "getFloat32", 1],
};
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const folder = path.resolve(positional[0] ?? "public/models/soldiers");
const outFile = path.resolve(flag("out", path.join(folder, "soldiers.glb")));
const texMax = Number(flag("tex", 512));
const height = Number(flag("height", 1.8));

// ── Load every FBX ──────────────────────────────────────────────────────────
const fbxFiles = fs.readdirSync(folder).filter((f) => /\.fbx$/i.test(f)).sort();
if (!fbxFiles.length) fail(`no .fbx files in ${folder}`);

const loaded = fbxFiles.map((file) => {
  const buf = fs.readFileSync(path.join(folder, file));
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), "");
  const meshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  return { file, clipName: path.basename(file, path.extname(file)), root, meshes };
});

const skins = loaded.filter((l) => l.meshes.length);
if (skins.length === 0) fail('no FBX has a mesh — download ONE clip "With Skin"');
if (skins.length > 1) {
  fail(`${skins.map((s) => s.file).join(", ")} all carry the mesh — keep "With Skin" on ONE of them`);
}
const skin = skins[0];
if (skin.meshes.length > 1) fail(`${skin.file}: ${skin.meshes.length} skinned meshes — the rig must be one mesh`);
const root = skin.root;
root.name = "soldiers";

// Every soldier in the file: { name, mesh, source, texture: { bytes, mimeType } | null, fit? }
const soldiers = [];

// ── The rig soldier (from the FBX) ──────────────────────────────────────────
const rigMesh = skin.meshes[0];
rigMesh.name = "soldier1";
let rigColorSrc = null;
{
  const g = rigMesh.geometry;
  keepAttrs(g);
  // glTF UVs start at the image's TOP-left; FBX (and three with flipY) at the
  // bottom-left. The PNGs are stored unflipped, so flip v here instead.
  const uv = g.attributes.uv;
  if (uv) for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  for (const m of Array.isArray(rigMesh.material) ? rigMesh.material : [rigMesh.material]) {
    rigColorSrc ??= m.map?.userData.src ?? null;
  }
  if (g.groups.length > 1) warn(`  ! ${skin.file}: ${g.groups.length} material groups merged into one material`);
  g.clearGroups();
  // FBXLoader hands back a triangle SOUP (3 verts a triangle). The crowd skins
  // every vertex of every soldier on the GPU each frame, so weld the duplicates.
  rigMesh.geometry = mergeVertices(g);
  rigMesh.material = soldierMaterial(rigMesh.name);
}

// ── Scale to --height, feet on the ground ───────────────────────────────────
root.updateMatrixWorld(true);
const rawBox = new THREE.Box3().setFromObject(root, true);
const rawHeight = rawBox.max.y - rawBox.min.y;
const s = height / rawHeight;
root.scale.multiplyScalar(s);
root.position.y -= rawBox.min.y * s;
root.updateMatrixWorld(true);

const pngs = listFiles(folder).filter((f) => /\.png$/i.test(f));
const rigPng = findPng(rigColorSrc);
if (!rigPng) warn(`  ! colour map ${rigColorSrc ? `"${path.basename(rigColorSrc)}" not found as a PNG` : "not referenced by the FBX"}`);
soldiers.push({
  name: rigMesh.name,
  mesh: rigMesh,
  source: skin.file,
  texture: rigPng ? pngTexture(rigPng) : null,
});

// ── GLB soldiers: lay over the rig, copy its skin weights ───────────────────
const glbFiles = fs.readdirSync(folder)
  .filter((f) => /\.glb$/i.test(f) && path.resolve(folder, f) !== outFile)
  .sort();
if (glbFiles.length) {
  // The rig's skin in its BIND pose, in the rig mesh's own space — the space
  // the new soldiers' vertices are converted into, so they bind with the same
  // bindMatrix and skeleton.
  const rigGeo = rigMesh.geometry.clone(); // MeshBVH reorders the index — keep the real one intact
  const bvh = new MeshBVH(rigGeo);
  const rigWorldBox = new THREE.Box3().setFromBufferAttribute(rigGeo.attributes.position).applyMatrix4(rigMesh.matrixWorld);
  const toRigLocal = rigMesh.matrixWorld.clone().invert();
  const cmPerLocal = rigMesh.matrixWorld.getMaxScaleOnAxis() * 100;
  const draco = await loadDraco();

  for (const file of glbFiles) {
    const name = path.basename(file, path.extname(file)).replace(/[_-]compressed$/i, "");
    const src = readGlbSoldier(path.join(folder, file), draco);
    if (src.skip) { warn(`  ! ${file}: ${src.skip} — skipped`); continue; }

    // Lay it over the rig: same height, same centre, feet together.
    const box = new THREE.Box3().setFromBufferAttribute(src.geometry.attributes.position);
    const k = (rigWorldBox.max.y - rigWorldBox.min.y) / (box.max.y - box.min.y);
    const cSrc = box.getCenter(new THREE.Vector3()), cRig = rigWorldBox.getCenter(new THREE.Vector3());
    const fit = new THREE.Matrix4()
      .makeTranslation(cRig.x, rigWorldBox.min.y, cRig.z)
      .multiply(new THREE.Matrix4().makeScale(k, k, k))
      .multiply(new THREE.Matrix4().makeTranslation(-cSrc.x, -box.min.y, -cSrc.z));
    src.geometry.applyMatrix4(toRigLocal.clone().multiply(fit));

    const { skinIndex, skinWeight, dist } = transferWeights(src.geometry, rigGeo, bvh);
    const cm = dist.map((d) => d * cmPerLocal).sort((a, b) => a - b);
    const pct = (f) => cm[Math.min(cm.length - 1, Math.floor(cm.length * f))];
    const fitReport = { median: pct(0.5), p99: pct(0.99), max: cm[cm.length - 1] };
    if (fitReport.median > FIT_MEDIAN_MAX_CM || fitReport.p99 > FIT_P99_MAX_CM) {
      warn(`  ! ${file}: doesn't line up with the rig (median ${fitReport.median.toFixed(1)} cm, 99% ${fitReport.p99.toFixed(1)} cm)` +
        " — another pose, facing or build? Skipped; it needs its own Mixamo rig.");
      continue;
    }

    const g = src.geometry;
    g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
    g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
    const mesh = new THREE.SkinnedMesh(mergeVertices(g), soldierMaterial(name));
    mesh.name = name;
    mesh.position.copy(rigMesh.position);
    mesh.quaternion.copy(rigMesh.quaternion);
    mesh.scale.copy(rigMesh.scale);
    rigMesh.parent.add(mesh);
    mesh.updateMatrixWorld(true);
    mesh.bind(rigMesh.skeleton, rigMesh.bindMatrix);
    soldiers.push({ name, mesh, source: file, texture: src.texture, dropped: src.dropped, fit: fitReport });
  }
}

// ── Clips ───────────────────────────────────────────────────────────────────
const nodeNames = new Set();
root.traverse((o) => nodeNames.add(o.name));
const clips = [];
const clipSource = new Map(); // clip → { file, mapped }
for (const l of loaded) {
  l.root.animations.forEach((clip, i) => {
    const title = l.clipName.replace(/\s*\(\d+\)$/, "").trim().toLowerCase(); // "Death (1)" → "death"
    const role = ROLES[title] ?? title.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const base = l.root.animations.length > 1 ? `${role}_${i + 1}` : role;
    clip.name = base;
    for (let k = 2; clips.some((c) => c.name === clip.name); k++) clip.name = `${base}_${k}`;
    clipSource.set(clip, { file: l.file, mapped: title in ROLES });
    const missing = clip.tracks.filter((t) => !nodeNames.has(t.name.split(".")[0]));
    if (missing.length) {
      warn(`  ! ${l.file}: ${missing.length} tracks target bones the soldier doesn't have — dropped`);
      clip.tracks = clip.tracks.filter((t) => !missing.includes(t));
    }
    clip.optimize();
    clips.push(clip);
  });
}
if (!clips.length) fail("no animation clips found");

const weapon = addWeaponBone();

// ── Export meshes + skeleton + clips ────────────────────────────────────────
const gltf = await new GLTFExporter().parseAsync(root, {
  binary: false,
  animations: clips,
  onlyVisible: false,
});
let bin = Buffer.from(gltf.buffers[0].uri.split(",")[1], "base64");
delete gltf.buffers[0].uri;

// ── Textures: one colour map per soldier ────────────────────────────────────
gltf.images = [];
gltf.textures = [];
gltf.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
for (const sd of soldiers) {
  const mat = gltf.materials.find((m) => m.name === sd.name);
  if (!mat || !sd.texture) continue;
  const view = appendBin(sd.texture.bytes);
  gltf.images.push({ bufferView: view, mimeType: sd.texture.mimeType, name: sd.name });
  const source = gltf.images.length - 1;
  if (sd.texture.mimeType === "image/ktx2") {
    gltf.textures.push({ sampler: 0, extensions: { KHR_texture_basisu: { source } } });
    for (const list of ["extensionsUsed", "extensionsRequired"]) {
      gltf[list] ??= [];
      if (!gltf[list].includes("KHR_texture_basisu")) gltf[list].push("KHR_texture_basisu");
    }
  } else {
    gltf.textures.push({ sampler: 0, source });
  }
  mat.pbrMetallicRoughness ??= {};
  mat.pbrMetallicRoughness.baseColorTexture = { index: gltf.textures.length - 1 };
}
if (!gltf.images.length) { delete gltf.images; delete gltf.textures; delete gltf.samplers; }

// ── Write the .glb ──────────────────────────────────────────────────────────
gltf.buffers[0].byteLength = bin.length;
const glb = writeGlb(gltf, bin);
fs.writeFileSync(outFile, glb);

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${path.relative(process.cwd(), outFile)}  ${kb(glb.length)}`);
console.log(`  skeleton ${rigMesh.skeleton.bones.length} bones, from ${skin.file} (raw height ${rawHeight.toFixed(0)} → ${height} m)`);
for (const sd of soldiers) {
  const g = sd.mesh.geometry;
  const tris = (g.index?.count ?? g.attributes.position.count) / 3;
  const tex = sd.texture ? `${sd.texture.mimeType.split("/")[1]} ${sd.texture.size} ${kb(sd.texture.bytes.length)}` : "NO TEXTURE";
  console.log(`  soldier  ${sd.name.padEnd(10)} ${tris} tris, ${g.attributes.position.count} verts, ${tex}   (${sd.source})`);
  if (sd.fit) {
    console.log(`           fit to the rig: median ${sd.fit.median.toFixed(1)} cm, 99% ${sd.fit.p99.toFixed(1)} cm, worst ${sd.fit.max.toFixed(1)} cm`);
  }
  if (sd.dropped?.length) console.log(`           dropped: ${sd.dropped.join(", ")}`);
}
for (const c of clips) {
  const keys = c.tracks.reduce((n, t) => n + t.times.length, 0);
  const hips = c.tracks.find((t) => /Hips\.position$/.test(t.name));
  let travel = "";
  if (hips) {
    const v = hips.values, n = v.length / 3;
    const d = Math.hypot(v[(n - 1) * 3] - v[0], v[(n - 1) * 3 + 2] - v[2]) * s;
    if (d > 0.05) travel = `  ! hips travel ${d.toFixed(2)} m — was "In Place" ticked?`;
  }
  const grip = weapon?.perClip.get(c);
  const hold = !grip ? "" : c.name.startsWith("unarmed") ? "unarmed clip (rifle on the average grip)" : grip.shouldered
    ? `SHOULDERED, aims ${grip.yaw.toFixed(0)}° off forward`
    : grip.held ? `both hands (left ±${grip.spread.toFixed(1)} cm)` : "average grip (left hand lets go)";
  const src = clipSource.get(c);
  const lying = hips && hips.values[1] * s + root.position.y < 0.4 ? " · lying" : "";
  console.log(`  clip     ${c.name.padEnd(20)} ${c.duration.toFixed(2).padStart(5)} s  ${String(keys).padStart(5)} keys  ${hold}${lying}${travel}`
    + `   ← ${src.file}${src.mapped ? "" : "  (title not in the role table)"}`);
}
if (!weapon) console.log("  no weapon bone: only unarmed clips in the folder");
const used = new Set(soldiers.map((sd) => sd.texture?.file).filter(Boolean));
for (const f of pngs) if (!used.has(f)) console.log(`  skipped  ${path.basename(f)} (not the rig's colour map)`);

// ════════════════════════════════════════════════════════════════════════════

/**
 * Add a WEAPON bone under the right hand, animated per clip, so a rifle skinned
 * to it sits in BOTH hands in every clip.
 *
 * Why a bone and not a fixed offset on the hand: Mixamo's rifle clips hold the
 * rifle at a different angle in the right hand from clip to clip — measured on
 * Rifle Idle / Rifle Run / Firing Rifle, the left hand lands up to ~15 cm apart
 * in the right hand's frame — while WITHIN a clip it stays put to ~1 cm. So
 * each clip gets its own constant grip: from the palm (between the wrist and
 * the index knuckle) toward the left hand, up = the world's up squared against
 * it. A clip where the left hand leaves the rifle (reload, a throw) or that
 * isn't a rifle clip gets the average grip of the steady ones.
 *
 * The bone's world scale is 1, so a weapon hung on it is modelled in metres
 * (games/shared-rts/procWeapons.js frame: origin at the grip, +Z to the
 * muzzle, +Y up). The crowd renderer bakes every skeleton bone, so it costs
 * the game one extra bone, nothing else.
 */
function addWeaponBone() {
  // Every clip but the first unarmed test downloads is a rifle clip; whether
  // the LEFT hand is on the rifle is measured below, not read from the name.
  const isRifleClip = (c) => !c.name.startsWith("unarmed");
  if (!clips.some(isRifleClip)) return null;
  const byName = (suffix) => {
    let b = null;
    root.traverse((o) => { if (o.isBone && o.name.endsWith(suffix)) b = o; });
    return b;
  };
  const rh = byName("RightHand"), lh = byName("LeftHand"), ri = byName("RightHandIndex1"), li = byName("LeftHandIndex1");
  const ra = byName("RightArm"), rf = byName("RightForeArm"), rsh = byName("RightShoulder");
  if (!rh || !lh || !ri || !li || !ra || !rf || !rsh) {
    warn("  ! the rig is missing arm/hand bones — no weapon bone");
    return null;
  }

  // Sampling poses the skeleton; the export must see the rest pose again.
  const rest = [];
  root.traverse((o) => { if (o.isBone) rest.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]); });

  const UP = new THREE.Vector3(0, 1, 0);
  const hp = new THREE.Vector3(), hq = new THREE.Quaternion(), hs = new THREE.Vector3(), inv = new THREE.Quaternion();
  const mixer = new THREE.AnimationMixer(root);
  const fits = new Map();
  for (const clip of clips) {
    const action = mixer.clipAction(clip).play();
    const sumB = new THREE.Vector3(), sumU = new THREE.Vector3(), sumP = new THREE.Vector3(), lefts = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      mixer.setTime((i / N) * clip.duration);
      root.updateMatrixWorld(true);
      rh.matrixWorld.decompose(hp, hq, hs);
      inv.copy(hq).invert();
      const lp = lh.getWorldPosition(new THREE.Vector3());
      const grip = ri.getWorldPosition(new THREE.Vector3()).add(hp).multiplyScalar(0.5);
      const b = lp.clone().sub(grip).normalize();
      const u = UP.clone().addScaledVector(b, -b.y).normalize();
      sumB.add(b.applyQuaternion(inv));
      sumU.add(u.applyQuaternion(inv));
      sumP.add(grip.sub(hp).applyQuaternion(inv));
      lefts.push(lp.sub(hp).applyQuaternion(inv));
    }
    action.stop();
    const mean = lefts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / N);
    const spread = Math.max(...lefts.map((p) => p.distanceTo(mean))) * 100;
    fits.set(clip, { b: sumB.normalize(), u: sumU, p: sumP.multiplyScalar(1 / N), spread, held: isRifleClip(clip) && spread < 3 });
  }
  mixer.stopAllAction();
  for (const [o, p, q, sc] of rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); }
  root.updateMatrixWorld(true);

  const frame = (b, u) => {
    const z = b.clone().normalize();
    const y = u.clone().addScaledVector(z, -u.dot(z)).normalize();
    const x = new THREE.Vector3().crossVectors(y, z);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  };
  const held = [...fits.values()].filter((f) => f.held);
  const steady = held.length ? held : [...fits].filter(([c]) => isRifleClip(c)).map(([, f]) => f);
  const avg = {
    b: steady.reduce((s, f) => s.add(f.b), new THREE.Vector3()),
    u: steady.reduce((s, f) => s.add(f.u), new THREE.Vector3()),
    p: steady.reduce((s, f) => s.add(f.p), new THREE.Vector3()).multiplyScalar(1 / steady.length),
  };

  // The bone: child of the right hand, world scale 1 (metres).
  const handScale = rh.getWorldScale(new THREE.Vector3()).x;
  const bone = new THREE.Bone();
  bone.name = "mixamorigWeapon";
  bone.position.copy(avg.p).divideScalar(handScale);
  bone.quaternion.copy(frame(avg.b, avg.u));
  bone.scale.setScalar(1 / handScale);
  rh.add(bone);
  bone.updateMatrix();

  // Append it to the shared skeleton. Its bind inverse follows the hand's:
  // world(weapon) = world(hand) · local, so inverse = local⁻¹ · inverse(hand).
  const old = rigMesh.skeleton;
  const handInv = old.boneInverses[old.bones.indexOf(rh)];
  const skeleton = new THREE.Skeleton(
    [...old.bones, bone],
    [...old.boneInverses, bone.matrix.clone().invert().multiply(handInv)],
  );
  for (const sd of soldiers) sd.mesh.bind(skeleton, sd.mesh.bindMatrix);

  const perClip = new Map();
  for (const clip of clips) {
    const f = fits.get(clip);
    if (isAimClip(clip)) {
      perClip.set(clip, { held: true, spread: f.spread, ...shoulderRifle(clip, bone) });
      continue;
    }
    const use = f.held ? f : avg;
    const pos = use.p.clone().divideScalar(handScale), q = frame(use.b, use.u);
    clip.tracks.push(
      new THREE.VectorKeyframeTrack(`${bone.name}.position`, [0], pos.toArray()),
      new THREE.QuaternionKeyframeTrack(`${bone.name}.quaternion`, [0], q.toArray()),
    );
    perClip.set(clip, { held: f.held, spread: f.spread });
  }
  for (const [o, p, q, sc] of rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); }
  root.updateMatrixWorld(true);
  return { bone, perClip };

  /**
   * FIRING / AIMING clips: the rifle goes where a shouldered rifle is — butt
   * in the right shoulder pocket, forestock in the left palm — and the right
   * arm is bent (two-bone IK) so the right hand closes on the grip.
   *
   * Why: on this body Mixamo's "Firing Rifle" puts the right hand ~15 cm
   * outside where a real grip would be, so a rifle laid hand-to-hand pointed
   * 38° off to the side with the butt 31 cm from the shoulder. Shoulder→left
   * palm points 12° off, where the soldier looks. Baked per frame at the crowd's
   * 30 Hz: the right arm's three rotation tracks are replaced, and the weapon
   * bone gets its own position/rotation tracks.
   */
  function shoulderRifle(clip, weaponBone) {
    const mixer2 = new THREE.AnimationMixer(root);
    const action = mixer2.clipAction(clip).play();
    const frames = Math.max(2, Math.round(clip.duration * 30));
    const times = [], qArm = [], qFore = [], qHand = [], wPos = [], wQuat = [];
    let reach = 0, yaw = 0;
    for (let i = 0; i <= frames; i++) {
      const t = (i / frames) * clip.duration;
      mixer2.setTime(t);
      root.updateMatrixWorld(true);
      const pocket = wp(ra).lerp(wp(rsh), BUTT_IN);
      const palmL = wp(lh).add(wp(li)).multiplyScalar(0.5);
      const d = palmL.sub(pocket).normalize();
      const grip = pocket.clone().addScaledVector(d, BUTT_TO_GRIP);
      const q = frame(d, UP.clone().addScaledVector(d, -d.y));

      // Right hand onto the grip, keeping the hand's animated orientation.
      const handQ = rh.getWorldQuaternion(new THREE.Quaternion());
      const wristToPalm = wp(ri).sub(wp(rh)).multiplyScalar(0.5);
      const target = grip.clone().sub(wristToPalm);
      twoBoneIK(ra, rf, rh, target);
      setWorldQuaternion(rh, handQ);
      root.updateMatrixWorld(true);
      reach = Math.max(reach, wp(rh).distanceTo(target));
      yaw += Math.atan2(d.x, d.z);

      // Weapon bone, local to the (moved) hand; its world scale stays 1.
      const local = rh.matrixWorld.clone().invert()
        .multiply(new THREE.Matrix4().compose(grip, q, new THREE.Vector3(1, 1, 1)));
      const lp = new THREE.Vector3(), lq = new THREE.Quaternion();
      local.decompose(lp, lq, new THREE.Vector3());
      times.push(t);
      qArm.push(...ra.quaternion.toArray());
      qFore.push(...rf.quaternion.toArray());
      qHand.push(...rh.quaternion.toArray());
      wPos.push(...lp.toArray());
      wQuat.push(...lq.toArray());
    }
    action.stop();
    mixer2.stopAllAction();
    mixer2.uncacheRoot(root);
    const replaced = new Set([ra, rf, rh].map((b) => `${b.name}.quaternion`));
    clip.tracks = clip.tracks.filter((tr) => !replaced.has(tr.name));
    clip.tracks.push(
      new THREE.QuaternionKeyframeTrack(`${ra.name}.quaternion`, times, qArm),
      new THREE.QuaternionKeyframeTrack(`${rf.name}.quaternion`, times, qFore),
      new THREE.QuaternionKeyframeTrack(`${rh.name}.quaternion`, times, qHand),
      new THREE.VectorKeyframeTrack(`${weaponBone.name}.position`, times, wPos),
      new THREE.QuaternionKeyframeTrack(`${weaponBone.name}.quaternion`, times, wQuat),
    );
    return { shouldered: true, reach: reach * 100, yaw: (yaw / (frames + 1)) * 180 / Math.PI };
  }
}

function isAimClip(c) { return /firing|shoot|aim/i.test(c.name); }

function wp(o) { return o.getWorldPosition(new THREE.Vector3()); }

/** Set a bone's WORLD rotation (writes its local quaternion). */
function setWorldQuaternion(bone, q) {
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parentQ.invert().multiply(q));
  bone.updateMatrixWorld(true);
}

/** Turn a bone (in world space) so direction `from` points along `to`. */
function turnBone(bone, from, to) {
  const delta = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  setWorldQuaternion(bone, delta.multiply(bone.getWorldQuaternion(new THREE.Quaternion())));
}

/**
 * Analytic two-bone IK: move `end` (the wrist) to `target` by turning `upper`
 * (the upper arm) and `lower` (the forearm), keeping the elbow on the side it
 * already bends to.
 */
function twoBoneIK(upper, lower, end, target) {
  const S = wp(upper), E = wp(lower), W = wp(end);
  const a = S.distanceTo(E), b = E.distanceTo(W);
  const toT = target.clone().sub(S);
  const dist = THREE.MathUtils.clamp(toT.length(), Math.abs(a - b) + 1e-4, a + b - 1e-4);
  const dir = toT.normalize();
  const cosA = THREE.MathUtils.clamp((a * a + dist * dist - b * b) / (2 * a * dist), -1, 1);
  const pole = E.clone().sub(S);
  pole.addScaledVector(dir, -pole.dot(dir));
  if (pole.lengthSq() < 1e-10) pole.set(0, -1, 0).addScaledVector(dir, -dir.y);
  pole.normalize();
  const newE = S.clone().addScaledVector(dir, a * cosA).addScaledVector(pole, a * Math.sqrt(1 - cosA * cosA));
  turnBone(upper, E.clone().sub(S), newE.clone().sub(S));
  const E2 = wp(lower), W2 = wp(end);
  turnBone(lower, W2.clone().sub(E2), S.clone().addScaledVector(dir, dist).sub(E2));
}

function fail(msg) {
  console.error(`packMixamo: ${msg}`);
  process.exit(1);
}

function kb(n) { return n > 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${(n / 1e3).toFixed(0)} KB`; }

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

function findPng(src) {
  if (!src) return null;
  const want = path.basename(src).replace(/\.[a-z]+$/i, "").toLowerCase();
  return pngs.find((f) => path.basename(f, path.extname(f)).toLowerCase() === want) ?? null;
}

/** The rig's PNG colour map, down-sampled to --tex and re-encoded. */
function pngTexture(file) {
  let img = decodePng(fs.readFileSync(file));
  if (texMax > 0) while (Math.max(img.w, img.h) > texMax) img = halve(img);
  return { bytes: encodePng(img), mimeType: "image/png", size: `${img.w}²`, file };
}

function keepAttrs(g) {
  const KEEP = new Set(["position", "normal", "uv", "skinIndex", "skinWeight"]);
  for (const name of Object.keys(g.attributes)) if (!KEEP.has(name)) g.deleteAttribute(name);
}

function soldierMaterial(name) {
  return new THREE.MeshStandardMaterial({ name, roughness: 0.85, metalness: 0, side: THREE.FrontSide });
}

/**
 * Each vertex of `geo` takes the rig's skin weights at the nearest point on the
 * rig's surface: the closest triangle's three vertex weights, blended by the
 * barycentric coordinates of that point, then cut back to the 4 strongest bones.
 */
function transferWeights(geo, rig, bvh) {
  const pos = geo.attributes.position, n = pos.count;
  const rIdx = rig.index.array, rPos = rig.attributes.position;
  const rSkinI = rig.attributes.skinIndex, rSkinW = rig.attributes.skinWeight;
  const skinIndex = new Uint16Array(n * 4), skinWeight = new Float32Array(n * 4), dist = new Float32Array(n);
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const bary = new THREE.Vector3(), hit = {};
  const acc = new Map();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    bvh.closestPointToPoint(p, hit);
    dist[i] = hit.distance;
    const ia = rIdx[hit.faceIndex * 3], ib = rIdx[hit.faceIndex * 3 + 1], ic = rIdx[hit.faceIndex * 3 + 2];
    a.fromBufferAttribute(rPos, ia); b.fromBufferAttribute(rPos, ib); c.fromBufferAttribute(rPos, ic);
    THREE.Triangle.getBarycoord(hit.point, a, b, c, bary);
    acc.clear();
    [[ia, bary.x], [ib, bary.y], [ic, bary.z]].forEach(([v, t]) => {
      for (let j = 0; j < 4; j++) {
        const w = rSkinW.getComponent(v, j) * t;
        if (w > 0) { const bone = rSkinI.getComponent(v, j); acc.set(bone, (acc.get(bone) ?? 0) + w); }
      }
    });
    const top = [...acc].sort((x, y) => y[1] - x[1]).slice(0, 4);
    const sum = top.reduce((t, [, w]) => t + w, 0) || 1;
    top.forEach(([bone, w], j) => { skinIndex[i * 4 + j] = bone; skinWeight[i * 4 + j] = w / sum; });
  }
  return { skinIndex, skinWeight, dist };
}

// ── GLB soldier reader (static meshes; Draco + KHR_mesh_quantization ok) ────

async function loadDraco() {
  // three's Draco decoder is an emscripten script that defines a global; run it
  // as CommonJS so it takes Node's `require`, and hand back its factory.
  const require = createRequire(import.meta.url);
  const file = require.resolve("three/examples/jsm/libs/draco/gltf/draco_decoder.js");
  const mod = { exports: {} };
  new Function("module", "exports", "require", "__dirname", "__filename",
    `${fs.readFileSync(file, "utf8")}\nmodule.exports = DracoDecoderModule;`)(mod, mod.exports, require, path.dirname(file), file);
  return mod.exports();
}

/**
 * Read every mesh in a static .glb into ONE world-space BufferGeometry
 * (position/normal/uv/index) plus its colour texture bytes.
 */
function readGlbSoldier(file, draco) {
  const b = fs.readFileSync(file);
  let json = null, bin = null;
  for (let off = 12; off < b.length;) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
    else if (type === 0x004e4942) bin = data;
    off += 8 + len;
  }
  if (!json) return { skip: "not a .glb" };
  if (json.skins?.length) return { skip: "already has a skeleton (only unrigged soldiers are supported)" };
  const view = (i) => {
    const v = json.bufferViews[i];
    return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  };

  // World matrix of every node, from the default scene down.
  const world = new Map();
  const walk = (i, parent) => {
    const nd = json.nodes[i];
    const m = nd.matrix ? new THREE.Matrix4().fromArray(nd.matrix) : new THREE.Matrix4().compose(
      new THREE.Vector3(...(nd.translation ?? [0, 0, 0])),
      new THREE.Quaternion(...(nd.rotation ?? [0, 0, 0, 1])),
      new THREE.Vector3(...(nd.scale ?? [1, 1, 1])));
    const w = parent.clone().multiply(m);
    world.set(i, w);
    for (const c of nd.children ?? []) walk(c, w);
  };
  for (const i of json.scenes[json.scene ?? 0].nodes) walk(i, new THREE.Matrix4());

  const parts = [];
  const materials = new Set();
  for (const [ni, w] of world) {
    const nd = json.nodes[ni];
    if (nd.mesh === undefined) continue;
    for (const prim of json.meshes[nd.mesh].primitives) {
      if ((prim.mode ?? 4) !== 4) continue;
      const draco_ = prim.extensions?.KHR_draco_mesh_compression;
      const get = draco_ ? decodeDraco(draco, view(draco_.bufferView), draco_, json, prim) : {
        position: readAccessor(json, bin, prim.attributes.POSITION),
        normal: prim.attributes.NORMAL !== undefined ? readAccessor(json, bin, prim.attributes.NORMAL) : null,
        uv: prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(json, bin, prim.attributes.TEXCOORD_0) : null,
        index: prim.indices !== undefined ? readAccessor(json, bin, prim.indices) : null,
      };
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(get.position, 3));
      if (get.normal) g.setAttribute("normal", new THREE.Float32BufferAttribute(get.normal, 3));
      else g.computeVertexNormals();
      g.setAttribute("uv", new THREE.Float32BufferAttribute(get.uv ?? new Float32Array((get.position.length / 3) * 2), 2));
      if (get.index) g.setIndex(Array.from(get.index));
      g.applyMatrix4(w); // also rotates + renormalises the normals
      parts.push(g.index ? g : g.setIndex([...Array(g.attributes.position.count).keys()]));
      if (prim.material !== undefined) materials.add(prim.material);
    }
  }
  if (!parts.length) return { skip: "no triangle meshes" };

  // One geometry: offset each part's indices into the merged vertex list.
  let vtx = 0;
  const posA = [], nrmA = [], uvA = [], idxA = [];
  for (const g of parts) {
    posA.push(...g.attributes.position.array);
    nrmA.push(...g.attributes.normal.array);
    uvA.push(...g.attributes.uv.array);
    for (const i of g.index.array) idxA.push(i + vtx);
    vtx += g.attributes.position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(posA, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nrmA, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvA, 2));
  geometry.setIndex(idxA);

  // The colour map (first material that has one), copied as-is; list what's dropped.
  let texture = null;
  const dropped = [];
  const imageOf = (texIndex) => {
    const t = json.textures[texIndex];
    const src = t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.source;
    return json.images[src];
  };
  for (const mi of materials) {
    const m = json.materials[mi];
    const base = m.pbrMetallicRoughness?.baseColorTexture;
    if (base && !texture) {
      const img = imageOf(base.index);
      if (img.bufferView === undefined) return { skip: "colour texture is an external file — export it embedded" };
      const bytes = Buffer.from(view(img.bufferView));
      texture = { bytes, mimeType: img.mimeType, size: imageSize(bytes, img.mimeType) };
    }
    if (m.normalTexture) dropped.push("normal map");
    if (m.pbrMetallicRoughness?.metallicRoughnessTexture) dropped.push("metal/roughness map");
    if (m.occlusionTexture) dropped.push("occlusion map");
    if (m.emissiveTexture) dropped.push("emissive map");
    if (m.doubleSided) dropped.push("double-sided");
  }
  if (materials.size > 1) warn(`  ! ${path.basename(file)}: ${materials.size} materials — merged, using the first colour map`);
  return { geometry, texture, dropped: [...new Set(dropped)] };
}

function readAccessor(json, bin, index) {
  const a = json.accessors[index];
  const n = WIDTH[a.type];
  const [size, getter, max] = COMPONENT[a.componentType];
  const out = new Float32Array(a.count * n);
  if (a.bufferView === undefined) return out; // sparse-only accessors aren't used by soldiers
  const v = json.bufferViews[a.bufferView];
  const base = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = v.byteStride ?? n * size;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < a.count; i++) {
    for (let c = 0; c < n; c++) {
      let x = dv[getter](base + i * stride + c * size, true);
      if (a.normalized) x = Math.max(x / max, -1);
      out[i * n + c] = x;
    }
  }
  return out;
}

function decodeDraco(draco, bytes, ext, json, prim) {
  const decoder = new draco.Decoder();
  const buffer = new draco.DecoderBuffer();
  buffer.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes.byteLength);
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok()) throw new Error(`Draco: ${status.error_msg()}`);

  const attribute = (gltfName) => {
    const id = ext.attributes[gltfName];
    if (id === undefined) return null;
    const accessor = json.accessors[prim.attributes[gltfName]];
    const attr = decoder.GetAttributeByUniqueId(mesh, id);
    const arr = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, arr);
    const out = new Float32Array(arr.size());
    for (let i = 0; i < out.length; i++) out[i] = arr.GetValue(i);
    draco.destroy(arr);
    // With KHR_mesh_quantization the decoded values are the stored INTEGERS;
    // a normalized accessor still needs mapping to [-1, 1] / [0, 1].
    if (accessor.normalized) {
      const max = COMPONENT[accessor.componentType][2];
      for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i] / max, -1);
    }
    return out;
  };
  const faces = mesh.num_faces();
  const index = new Uint32Array(faces * 3);
  const face = new draco.DracoInt32Array();
  for (let f = 0; f < faces; f++) {
    decoder.GetFaceFromMesh(mesh, f, face);
    index[f * 3] = face.GetValue(0); index[f * 3 + 1] = face.GetValue(1); index[f * 3 + 2] = face.GetValue(2);
  }
  const result = { position: attribute("POSITION"), normal: attribute("NORMAL"), uv: attribute("TEXCOORD_0"), index };
  draco.destroy(face); draco.destroy(mesh); draco.destroy(buffer); draco.destroy(decoder);
  return result;
}

function imageSize(bytes, mimeType) {
  if (mimeType === "image/ktx2") return `${bytes.readUInt32LE(20)}²`;
  if (mimeType === "image/png") return `${bytes.readUInt32BE(16)}²`;
  return "?";
}

/** Append bytes to the binary chunk as a new bufferView (4-byte aligned). */
function appendBin(bytes) {
  const pad = (4 - (bin.length % 4)) % 4;
  const offset = bin.length + pad;
  bin = Buffer.concat([bin, Buffer.alloc(pad), bytes]);
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
  return gltf.bufferViews.length - 1;
}

function writeGlb(json, binary) {
  const pad4 = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad4(binary, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHead = (len, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  return Buffer.concat([
    header,
    chunkHead(jsonChunk.length, 0x4e4f534a), jsonChunk, // "JSON"
    chunkHead(binChunk.length, 0x004e4942), binChunk,  // "BIN\0"
  ]);
}

// ── PNG (8-bit, non-interlaced; decoded to RGB — the soldier needs no alpha) ─

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, palette = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (tag === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (tag === "PLTE") palette = data;
    else if (tag === "IDAT") idat.push(data);
    else if (tag === "IEND") break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (depth !== 8 || interlace !== 0 || !ch) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = new Uint8Array(h * stride);
  let prev = new Uint8Array(stride), rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const cur = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = raw[rp + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      cur[x] = v;
    }
    rp += stride;
    prev = cur;
  }

  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    if (type === 2 || type === 6) {
      rgb[o] = px[i * ch]; rgb[o + 1] = px[i * ch + 1]; rgb[o + 2] = px[i * ch + 2];
    } else if (type === 3) {
      const p = px[i] * 3;
      rgb[o] = palette[p]; rgb[o + 1] = palette[p + 1]; rgb[o + 2] = palette[p + 2];
    } else {
      rgb[o] = rgb[o + 1] = rgb[o + 2] = px[i * ch];
    }
  }
  return { w, h, rgb };
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 2x2 box down-sample. */
function halve({ w, h, rgb }) {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1);
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
      for (let c = 0; c < 3; c++) {
        out[(y * W + x) * 3 + c] = (rgb[(y0 * w + x0) * 3 + c] + rgb[(y0 * w + x1) * 3 + c]
          + rgb[(y1 * w + x0) * 3 + c] + rgb[(y1 * w + x1) * 3 + c] + 2) >> 2;
      }
    }
  }
  return { w: W, h: H, rgb: out };
}

function encodePng({ w, h, rgb }) {
  const stride = w * 3;
  const raw = Buffer.alloc(h * (stride + 1));
  const trial = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const cur = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgb.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    // Per row, keep the filter with the smallest sum of |residual| (the usual
    // heuristic: small residuals deflate best).
    let best = 0, bestCost = Infinity;
    for (let f = 0; f <= 4; f++) {
      let cost = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? cur[x - 3] : 0, b = prev[x], c = x >= 3 ? prev[x - 3] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const r = (cur[x] - pred) & 255;
        cost += r < 128 ? r : 256 - r;
      }
      if (cost < bestCost) { bestCost = cost; best = f; }
    }
    const o = y * (stride + 1);
    raw[o] = best;
    for (let x = 0; x < stride; x++) {
      const a = x >= 3 ? cur[x - 3] : 0, b = prev[x], c = x >= 3 ? prev[x - 3] : 0;
      const pred = best === 0 ? 0 : best === 1 ? a : best === 2 ? b : best === 3 ? (a + b) >> 1 : paeth(a, b, c);
      trial[x] = (cur[x] - pred) & 255;
    }
    raw.set(trial, o + 1);
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
