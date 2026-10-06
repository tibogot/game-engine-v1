// Pack a folder of soldiers into ONE .glb: one skeleton, the clips once, and
// every soldier mesh skinned to that skeleton.
//
//   node tools/packMixamo.mjs [folder] [--out file.glb] [--tex 512] [--height 1.8]
//                             [--skip soldier3,...] [--unarmed]
//
//   folder     default assets-src/soldiers — the SOURCES live outside public/
//              (only the packed file ships; ~12 MB of FBX/PNG/GLB did, unread)
//   --out      default public/models/soldiers/soldiers.glb
//   --tex      longest side for PNG textures (default 512; 0 = keep). KTX2
//              textures are copied as they are — resize those in the KTX tool.
//   --height   the soldiers' height in metres (default 1.8). The games rescale
//              to their own unit height anyway; this only makes the file sane.
//   --skip     bodies to leave out (comma list of mesh names). The Algeria pack
//              leaves out soldier3, the Vietnam game's body (see ALG below).
//   --unarmed  keep the "unarmed_" test clips (idle / walk / run without a
//              rifle): no game plays them — 150 KB of keys, dropped by default.
//   --rig-texture NAME
//              the RIG's colour map from the GLB soldier NAME — the same body
//              Mixamo was given, exported and KTX2-compressed like the others
//              (the FBX only brings a PNG). It must BE that body: laid over the
//              rig, its shape must fit AND its UVs must match the rig's at every
//              point, or the PNG stays (the report says why). It is not added
//              as a soldier: the rig keeps Mixamo's own mesh and weights.
//
// THE ALGERIA PACK (alg-rts, 2026-09-30):
//   node tools/packMixamo.mjs --skip soldier3 --rig-texture originalsoldier
//
// THE FOLDER
//   *.fbx  Mixamo downloads. ONE "With Skin" (the RIG: its skeleton and skin
//          weights are what every soldier gets) and any number "Without Skin"
//          (animation only, "In Place" ticked on anything that moves). Each clip
//          is NAMED AFTER ITS FILE: crouch_walk.fbx → clip "crouch_walk" —
//          Mixamo names every clip "mixamo.com". The rig's textures sit in the
//          folder as PNGs; the FBX material names which one is the colour map.
//          A .ktx2 of the SAME NAME beside that PNG is used instead (made with
//          the KTX tool, like the GLB soldiers' own maps), as it is.
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
//     are dropped: the crowd renderer (v3/render/crowdSkinning.js) sets
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
// The hand-placed weapon corrections (the soldier lab's grip editor): per
// clip into the weapon bone, the sling into its bone — baked here, free in game.
const { GRIPS, gripMatrix, isZeroGrip } = await import("../games/shared-rts/soldierGrips.js");

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
  // "Rifle Crouch Walk" came as Mixamo's "Rifle Walking RIGHT Crouched" — a
  // strafe (matched by length, and it side-steps: the transition lab,
  // 2026-09-30). The forward crouched walk is "Crouch Walking" ("Crouched
  // Walking While Aiming Rifle"), lower too (hips 0.67 m against 0.79).
  "rifle crouch walk": "rifle_crouch_strafe",
  "crouch walking": "rifle_crouch_walk",
  "crouch walk": "rifle_crouch_walk",
  "rifle crouch idle": "rifle_crouch_idle",
  "crouching idle": "rifle_crouch_idle",
  "kneeling idle": "rifle_crouch_idle",
  "rifle kneel idle": "rifle_crouch_idle",
  "kneeling firing": "rifle_crouch_firing",
  "crouch firing": "rifle_crouch_firing",
  "crouch rapid fire": "rifle_crouch_firing",
  "reloading": "rifle_reload",
  "reload": "rifle_reload",
  "prone idle": "rifle_prone_idle",
  "prone forward": "rifle_crawl",
  "crawling": "rifle_crawl",
  "crawl": "rifle_crawl",
  "prone firing": "rifle_prone_firing",
  "prone firing rifle": "rifle_prone_firing",
  // Transitions (Mixamo's rifle set): see TRANSITIONS below.
  "rifle stand to kneel": "rifle_stand_to_kneel",
  "rifle kneel to stand": "rifle_kneel_to_stand",
  "rifle kneel to prone": "rifle_kneel_to_prone",
  "rifle prone to kneel": "rifle_prone_to_kneel",
  "prone death": "death_prone",
  // Killed kneeling: "Crouch Death" ("Dying From A Crouched Position"); the
  // headshot one jerks him up to standing first (the lab, 2026-09-30).
  "crouch death": "death_kneeling",
  "death crouching headshot front": "death_kneeling_headshot",
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
const folder = path.resolve(positional[0] ?? "assets-src/soldiers");
const outFile = path.resolve(flag("out", "public/models/soldiers/soldiers.glb"));
const skipBodies = new Set(String(flag("skip", "")).split(",").map((x) => x.trim()).filter(Boolean));
const keepUnarmed = argv.includes("--unarmed");
const rigTextureFrom = flag("rig-texture", null);
const UV_MEDIAN_MAX = 0.004, UV_P95_MAX = 0.02;   // UV units: the same UV layout, seams aside
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
// A KTX2 of the same name beside the PNG wins (see THE FOLDER).
const rigKtx = rigPng && [".ktx2", ".KTX2"].map((e) => rigPng.replace(/\.png$/i, e)).find((f) => fs.existsSync(f));
soldiers.push({
  name: rigMesh.name,
  mesh: rigMesh,
  source: skin.file,
  texture: rigKtx ? ktx2Texture(rigKtx) : rigPng ? pngTexture(rigPng) : null,
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
    if (skipBodies.has(name)) { console.log(`  ${file}: left out (--skip)`); continue; }
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

    // --rig-texture: this GLB only lends the rig its colour map — IF it is the
    // rig's own body (shape and UVs), checked here, and is not a soldier itself.
    if (name === rigTextureFrom) {
      const uv = uvMatch(src.geometry, rigGeo, bvh, 0.05 / cmPerLocal);   // within half a millimetre
      const shapeOk = fitReport.median <= FIT_MEDIAN_MAX_CM && fitReport.p99 <= FIT_P99_MAX_CM;
      const uvOk = uv && uv.median <= UV_MEDIAN_MAX && uv.p95 <= UV_P95_MAX;
      const texOk = src.texture?.mimeType === "image/ktx2";
      console.log(`  ${file}: the rig's colour map? shape median ${fitReport.median.toFixed(2)} cm, 99% ${fitReport.p99.toFixed(2)} cm; ` +
        (uv ? `UV median ${uv.median.toFixed(4)}, 95% ${uv.p95.toFixed(4)}, worst ${uv.max.toFixed(4)}` : "no UVs") + `; texture ${src.texture?.mimeType ?? "none"}`);
      if (shapeOk && uvOk && texOk) {
        soldiers[0].texture = { ...src.texture, file };
        console.log(`  → soldier1 takes ${file}'s KTX2 colour map (${kb(src.texture.bytes.length)})`);
      } else {
        warn(`  ! ${file}: NOT used for the rig's colour map (${!shapeOk ? "the shape doesn't fit" : !uvOk ? "the UVs don't match" : "no KTX2 colour map"}) — the PNG stays`);
      }
      continue;
    }
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
    if (role.startsWith("unarmed") && !keepUnarmed) { console.log(`  ${l.file}: unarmed clip left out (--unarmed keeps it)`); return; }
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

// ── The hips: in place, and transitions that land where the next clip starts ──
// "In Place" can't be ticked for a transition on Mixamo, and one download
// forgot it. MEASURED 2026-09-30 (the hips at each clip's first and last key):
// Kneel To Prone starts on the kneel idle's hips and ends on the prone idle's
// to the millimetre (one family); Stand To Kneel / Kneel To Stand start right
// and end ~21 cm off (the man steps); Prone To Kneel 9 cm; "Crouch Walking"
// walks 1.29 m. A clip left like that SLIDES the man, then snaps him back when
// the next clip starts. So:
//   LOOPS that travel → the drift ramped out (what In Place does);
//   TRANSITIONS → ramped so they start on the FROM clip's hips and end on the
//   TO clip's (horizontal only — the height IS the move).
const TRANSITIONS = {
  rifle_stand_to_kneel: ["rifle_idle", "rifle_crouch_idle"],
  rifle_kneel_to_stand: ["rifle_crouch_idle", "rifle_idle"],
  rifle_kneel_to_prone: ["rifle_crouch_idle", "rifle_prone_idle"],
  rifle_prone_to_kneel: ["rifle_prone_idle", "rifle_crouch_idle"],
};
const LOOPS_IN_PLACE = /^rifle_(walk|run|sprint|crouch_walk|crouch_strafe|crawl)$/;
{
  const hipsOf = (c) => c?.tracks.find((t) => /Hips\.position$/.test(t.name));
  const firstXZ = (c) => { const h = hipsOf(c); return h ? [h.values[0], h.values[2]] : null; };
  /** Shift the hips so the clip starts at `a` and ends at `b` (x, z), linearly in time. */
  const ramp = (c, a, b) => {
    const h = hipsOf(c);
    if (!h || !a || !b) return false;
    const v = h.values, t = h.times, n = t.length, T = t[n - 1] || 1;
    const dsx = a[0] - v[0], dsz = a[1] - v[2];
    const dex = b[0] - v[(n - 1) * 3], dez = b[1] - v[(n - 1) * 3 + 2];
    for (let k = 0; k < n; k++) {
      const u = t[k] / T;
      v[k * 3] += dsx + (dex - dsx) * u;
      v[k * 3 + 2] += dsz + (dez - dsz) * u;
    }
    return true;
  };
  const byName = (name) => clips.find((c) => c.name === name);
  for (const c of clips) {
    const tr = TRANSITIONS[c.name];
    if (tr) {
      if (!ramp(c, firstXZ(byName(tr[0])), firstXZ(byName(tr[1])))) warn(`  ! ${c.name}: ${tr.join(" / ")} not in the pack — its hips left as downloaded`);
    } else if (LOOPS_IN_PLACE.test(c.name)) {
      const s0 = firstXZ(c);
      if (s0) ramp(c, s0, s0);
    }
  }
}

const weapon = addWeaponBone();

// ── Export meshes + skeleton + clips ────────────────────────────────────────
const gltf = await new GLTFExporter().parseAsync(root, {
  binary: false,
  animations: clips,
  onlyVisible: false,
});
// What was baked: the lab's grip editor previews changes on top of it.
gltf.asset.extras = { ...(gltf.asset.extras ?? {}), grips: { clips: GRIPS.clips, sling: GRIPS.sling, hand: GRIPS.hand ?? null, handLeft: GRIPS.handLeft ?? null, tool: GRIPS.tool ?? null } };
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
  // posture from the hips' mean height (standing ~0.84 m, running 0.75, prone 0.14)
  let posture = "";
  if (hips && !/^death/.test(c.name)) { // a death averages standing and fallen
    let sum = 0;
    for (let k = 1; k < hips.values.length; k += 3) sum += hips.values[k] * s + root.position.y;
    const hy = sum / (hips.values.length / 3);
    posture = hy < 0.3 ? " · lying" : hy < 0.62 ? " · kneeling" : "";
  }
  if (/^death/.test(c.name)) travel = travel.replace(/ ! hips travel ([\d.]+) m.*$/, " · falls $1 m (a death travels — expected)");
  const stow = weapon?.stowed.has(c) ? " · rifle slung" + (weapon.tool.has(c) ? ", shovel in hand" : "") : "";
  console.log(`  clip     ${c.name.padEnd(20)} ${c.duration.toFixed(2).padStart(5)} s  ${String(keys).padStart(5)} keys  ${hold}${posture}${stow}${travel}`
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
  // THE HAND POINT (soldierGrips.js GRIPS.hand): where the fist really
  // closes, as a shift from the point fitted above (halfway from the wrist to
  // the index knuckle), in metres along the hand bone's own axes. Every clip
  // takes it: a carry hangs the rifle from it, an aim/fire clip bends the arm
  // so it lands on the grip, the crawl drags from it. Zero = as fitted.
  const HAND = new THREE.Vector3(...(GRIPS.hand?.p ?? [0, 0, 0])).multiplyScalar(0.01);
  // The LEFT hand's point, the same way in the left hand bone's frame (the
  // shovel's lower fist).
  const HAND_L = new THREE.Vector3(...(GRIPS.handLeft?.p ?? GRIPS.hand?.p ?? [0, 0, 0])).multiplyScalar(0.01);
  const TOOL_OFF = gripMatrix(GRIPS.tool);   // the shovel's correction (identity when none)
  if (HAND.lengthSq() > 0) console.log(`  hand point: shifted ${JSON.stringify(GRIPS.hand.p)} cm in the hand`);
  const bone = new THREE.Bone();
  bone.name = "mixamorigWeapon";
  bone.position.copy(avg.p).divideScalar(handScale);
  bone.quaternion.copy(frame(avg.b, avg.u));
  bone.scale.setScalar(1 / handScale);
  rh.add(bone);
  bone.updateMatrix();

  // SLING: the rifle slung diagonally across the back (muzzle up over the
  // right shoulder), for clips whose hands are busy — digging, a grenade
  // throw. TOOL: a shovel in both hands for digging, aimed per frame below.
  // Each clip shows or hides the three by SCALE (1 or ~0), which the crowd
  // renderer bakes with the rest — no extra draw, no mesh swap.
  const sp2 = byName("Spine2");
  const inFrameOf = (parent, pos, quat) => {
    const m = parent.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(pos, quat, new THREE.Vector3(1, 1, 1)));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    m.decompose(p, q, sc);
    return { p, q, sc };
  };
  const sling = new THREE.Bone();
  sling.name = "mixamorigSling";
  {
    const d = new THREE.Vector3(-0.4, 0.92, 0).normalize();           // up and to his right
    const q = frame(d, new THREE.Vector3(0, 0, -1));                    // sights facing away from the back
    const t = inFrameOf(sp2, new THREE.Vector3(0.05, 1.05, -0.225), q);
    sling.position.copy(t.p); sling.quaternion.copy(t.q); sling.scale.copy(t.sc);
    // The hand-placed correction (soldierGrips.js), in the slung rifle's own frame.
    if (!isZeroGrip(GRIPS.sling)) {
      new THREE.Matrix4().compose(sling.position, sling.quaternion, sling.scale).multiply(gripMatrix(GRIPS.sling))
        .decompose(sling.position, sling.quaternion, sling.scale);
      console.log(`  sling: grip correction ${JSON.stringify(GRIPS.sling)}`);
    }
  }
  sp2.add(sling);
  sling.updateMatrix();
  const tool = new THREE.Bone();
  tool.name = "mixamorigTool";
  tool.position.copy(bone.position); tool.quaternion.copy(bone.quaternion); tool.scale.copy(bone.scale);
  rh.add(tool);
  tool.updateMatrix();
  // Sampling clips animates these too (their scale tracks): restore them with the rest.
  for (const b of [bone, sling, tool]) rest.push([b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);

  // Append them to the shared skeleton. A child's bind inverse follows its
  // parent's: world(child) = world(parent) · local, so inverse = local⁻¹ · inverse(parent).
  const old = rigMesh.skeleton;
  const invOf = (child, parent) => child.matrix.clone().invert().multiply(old.boneInverses[old.bones.indexOf(parent)]);
  const skeleton = new THREE.Skeleton(
    [...old.bones, bone, sling, tool],
    [...old.boneInverses, invOf(bone, rh), invOf(sling, sp2), invOf(tool, rh)],
  );
  for (const sd of soldiers) sd.mesh.bind(skeleton, sd.mesh.bindMatrix);

  const isStowed = (c) => /^(dig|hammer|grenade_throw|unarmed)/.test(c.name);
  const usesShovel = (c) => /^dig/.test(c.name);
  const shown = (b, on) => b.scale.clone().multiplyScalar(on ? 1 : 1e-4).toArray();
  const stowed = new Set(), withTool = new Set();
  for (const clip of clips) {
    const st = isStowed(clip), sh = usesShovel(clip);
    if (st) stowed.add(clip);
    if (sh) withTool.add(clip);
    clip.tracks.push(
      new THREE.VectorKeyframeTrack(`${bone.name}.scale`, [0], shown(bone, !st)),
      new THREE.VectorKeyframeTrack(`${sling.name}.scale`, [0], shown(sling, st)),
      new THREE.VectorKeyframeTrack(`${tool.name}.scale`, [0], shown(tool, sh)),
    );
    if (sh) aimTool(clip, tool);
  }

  const perClip = new Map();
  for (const clip of clips) {
    const f = fits.get(clip);
    if (isAimClip(clip)) {
      perClip.set(clip, { held: true, spread: f.spread, ...shoulderRifle(clip, bone) });
      continue;
    }
    // The CRAWL drags the rifle in the right hand along the forearm: the
    // average grip (from the standing clips) pointed it into the ground, a
    // brown stub at the hand (the transition lab, 2026-09-30).
    if (/^rifle_crawl/.test(clip.name)) {
      alongForearm(clip, bone);
      perClip.set(clip, { held: false, spread: f.spread });
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
  // The hand-placed corrections (soldierGrips.js) on the clips the IK above
  // did not take them in: right-multiplied into every key of the weapon
  // bone, in the weapon's own frame (the bone's world scale is 1: metres).
  const sBone = 1 / handScale, _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _t = new THREE.Vector3(), _r = new THREE.Quaternion();
  // The hand point on the same clips: the weapon bone sits in the hand's
  // frame, so the shift is one constant (hand units = metres / handScale).
  const handLocal = HAND.clone().multiplyScalar(1 / handScale);
  for (const clip of clips) {
    const g = GRIPS.clips[clip.name];
    const hasG = !isZeroGrip(g), hasH = handLocal.lengthSq() > 0;
    if (!hasG && !hasH) continue;
    if (!isAimClip(clip)) {
      gripMatrix(g).decompose(_t, _r, new THREE.Vector3());
      const P = clip.tracks.find((tr) => tr.name === `${bone.name}.position`);
      const Q = clip.tracks.find((tr) => tr.name === `${bone.name}.quaternion`);
      if (!P || !Q || P.times.length !== Q.times.length) { warn(`  ! ${clip.name}: no weapon keys to correct`); continue; }
      for (let k = 0; k < P.times.length; k++) {
        _p.fromArray(P.values, k * 3); _q.fromArray(Q.values, k * 4);
        _p.add(handLocal);
        if (hasG) { _p.add(_t.clone().multiplyScalar(sBone).applyQuaternion(_q)); _q.multiply(_r); }
        _p.toArray(P.values, k * 3); _q.toArray(Q.values, k * 4);
      }
    }
    if (hasG) console.log(`  ${clip.name}: grip correction ${JSON.stringify(g)}`);
  }
  for (const [o, p, q, sc] of rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc); }
  root.updateMatrixWorld(true);
  return { bone, perClip, stowed, tool: withTool };

  /**
   * The rifle ALONG THE RIGHT FOREARM, per frame at 30 Hz: the grip in the
   * right palm, the barrel on the elbow → hand line (forward), sights up.
   * For a clip that carries the rifle one-handed low — the crawl.
   */
  function alongForearm(clip, weaponBone) {
    const mixer4 = new THREE.AnimationMixer(root);
    const action = mixer4.clipAction(clip).play();
    const frames = Math.max(2, Math.round(clip.duration * 30));
    const times = [], pos = [], quat = [];
    for (let i = 0; i <= frames; i++) {
      const t = (i / frames) * clip.duration;
      mixer4.setTime(t);
      root.updateMatrixWorld(true);
      const palm = wp(rh).add(wp(ri)).multiplyScalar(0.5);
      const d = palm.clone().sub(wp(rf)).normalize();
      const q = frame(d, UP.clone().addScaledVector(d, -d.y));
      const local = rh.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(palm, q, new THREE.Vector3(1, 1, 1)));
      const lp = new THREE.Vector3(), lq = new THREE.Quaternion();
      local.decompose(lp, lq, new THREE.Vector3());
      times.push(t);
      pos.push(...lp.toArray());
      quat.push(...lq.toArray());
    }
    action.stop();
    mixer4.stopAllAction();
    mixer4.uncacheRoot(root);
    clip.tracks.push(
      new THREE.VectorKeyframeTrack(`${weaponBone.name}.position`, times, pos),
      new THREE.QuaternionKeyframeTrack(`${weaponBone.name}.quaternion`, times, quat),
    );
  }

  /**
   * The shovel, per frame at 30 Hz: from the right palm toward the left palm
   * (both hands are on the handle while digging, and they slide), up = the
   * world's up squared against it. Same frame as a weapon: origin at the right
   * grip, +Z toward the left hand.
   */
  function aimTool(clip, toolBone) {
    const mixer3 = new THREE.AnimationMixer(root);
    const action = mixer3.clipAction(clip).play();
    const frames = Math.max(2, Math.round(clip.duration * 30));
    const times = [], pos = [], quat = [];
    for (let i = 0; i <= frames; i++) {
      const t = (i / frames) * clip.duration;
      mixer3.setTime(t);
      root.updateMatrixWorld(true);
      // From the right FIST to the left one (each hand's point — the middle
      // of the fist's mesh, soldierGrips.js), then GRIPS.tool. The top fist
      // wraps the SHAFT in Mixamo's dig, so the D-grip sits on top of it;
      // its crossbar stays level (world up squared).
      const palmR = wp(rh).add(wp(ri)).multiplyScalar(0.5).add(HAND.clone().applyQuaternion(rh.getWorldQuaternion(new THREE.Quaternion())));
      const palmL = wp(lh).add(wp(li)).multiplyScalar(0.5).add(HAND_L.clone().applyQuaternion(lh.getWorldQuaternion(new THREE.Quaternion())));
      const d = palmL.clone().sub(palmR).normalize();
      const q = frame(d, UP.clone().addScaledVector(d, -d.y));
      const local = rh.matrixWorld.clone().invert().multiply(new THREE.Matrix4().compose(palmR, q, new THREE.Vector3(1, 1, 1)).multiply(TOOL_OFF));
      const lp = new THREE.Vector3(), lq = new THREE.Quaternion();
      local.decompose(lp, lq, new THREE.Vector3());
      times.push(t);
      pos.push(...lp.toArray());
      quat.push(...lq.toArray());
    }
    action.stop();
    mixer3.stopAllAction();
    mixer3.uncacheRoot(root);
    clip.tracks.push(
      new THREE.VectorKeyframeTrack(`${toolBone.name}.position`, times, pos),
      new THREE.QuaternionKeyframeTrack(`${toolBone.name}.quaternion`, times, quat),
    );
  }

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
    const off = isZeroGrip(GRIPS.clips[clip.name]) ? null : gripMatrix(GRIPS.clips[clip.name]);
    const ONE = new THREE.Vector3(1, 1, 1);
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
      // The hand-placed correction moves the rifle; the IK below brings the
      // right hand onto its grip wherever it went.
      if (off) new THREE.Matrix4().compose(grip, q, ONE).multiply(off).decompose(grip, q, new THREE.Vector3());

      // Right hand onto the grip, keeping the hand's animated orientation.
      const handQ = rh.getWorldQuaternion(new THREE.Quaternion());
      const wristToPalm = wp(ri).sub(wp(rh)).multiplyScalar(0.5).add(HAND.clone().applyQuaternion(handQ));
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

/** A KTX2 colour map, as it is (resize it in the KTX tool). */
function ktx2Texture(file) {
  const bytes = fs.readFileSync(file);
  return { bytes, mimeType: "image/ktx2", size: `${bytes.readUInt32LE(20)}²`, file };
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

/**
 * How far `geo`'s UVs are from the rig's at the same place on the skin.
 * { median, p95 } in UV units, or null without UVs.
 *
 * A vertex ON a rig vertex (the same body: within `tol`, rig-local units)
 * takes the BEST of the UVs of every rig vertex there — on a UV seam the rig
 * has two vertices in one spot, one per side, and the nearest face can be on
 * the wrong one (the first check read 5 % of an identical body as 0.44 off).
 * Anywhere else: the rig's UV at the nearest surface point (barycentric).
 */
function uvMatch(geo, rig, bvh, tol) {
  const pos = geo.attributes.position, uv = geo.attributes.uv, rUv = rig.attributes.uv;
  if (!uv || !rUv) return null;
  const rIdx = rig.index.array, rPos = rig.attributes.position;
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const bary = new THREE.Vector3(), hit = {};
  const d = new Float32Array(pos.count);
  const tol2 = tol * tol;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const gu = uv.getX(i), gv = uv.getY(i);
    let best = Infinity;
    for (let r = 0; r < rPos.count; r++) {
      const dx = rPos.getX(r) - p.x, dy = rPos.getY(r) - p.y, dz = rPos.getZ(r) - p.z;
      if (dx * dx + dy * dy + dz * dz > tol2) continue;
      best = Math.min(best, Math.hypot(rUv.getX(r) - gu, rUv.getY(r) - gv));
    }
    if (best === Infinity) {
      bvh.closestPointToPoint(p, hit);
      const ia = rIdx[hit.faceIndex * 3], ib = rIdx[hit.faceIndex * 3 + 1], ic = rIdx[hit.faceIndex * 3 + 2];
      a.fromBufferAttribute(rPos, ia); b.fromBufferAttribute(rPos, ib); c.fromBufferAttribute(rPos, ic);
      THREE.Triangle.getBarycoord(hit.point, a, b, c, bary);
      const u = rUv.getX(ia) * bary.x + rUv.getX(ib) * bary.y + rUv.getX(ic) * bary.z;
      const v = rUv.getY(ia) * bary.x + rUv.getY(ib) * bary.y + rUv.getY(ic) * bary.z;
      best = Math.hypot(u - gu, v - gv);
    }
    d[i] = best;
  }
  d.sort();
  return { median: d[d.length >> 1], p95: d[Math.floor(d.length * 0.95)], max: d[d.length - 1] };
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
