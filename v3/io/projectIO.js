/**
 * `.v3proj` — whole-project container (GLB-style layout):
 *
 *   u32 magic "V3PJ" · u32 version · u32 manifestByteLength
 *   manifest JSON (UTF-8)
 *   binary payload (blobs referenced by { offset, length } in the manifest)
 *
 * Manifest:
 *   terrain   { worldSize, heightmapSize, splatSize, maxHeight }
 *             splatSize is absent in files written before it was configurable —
 *             those used splatRes = min(2048, max(256, heightmapSize / 2)).
 *   blobs     { heightmap, splat, snow, grassDensity, grassHeight, susukiDensity,
 *               flowerDensity, cliffGrassDensity, cliffPaint }
 *             → { offset, length } into the payload
 *             grassHeight: painted blade height (RGBA 512², .r / 128 = multiplier,
 *             128 = 1x). Absent in older files = 1x everywhere.
 *             cliffGrassDensity: grass painted on cliff tops (RGBA 512², .r).
 *             The cliff-top SURFACE it grows on is not stored: it is baked
 *             again from the loaded cliffs.
 *             cliffPaint: terrain ground colour painted onto cliffs (RGBA 512²).
 *   grass     grass appearance (the Grass panel: blade, colour, wind, SSS,
 *             specular, slope, tint, LOD, interaction). Merged per key on load.
 *             `grass.system` picks WHICH grass system runs; revoGrass holds
 *             the other one's look, so switching back and forth keeps both.
 *   revoGrass the revo grass system's look (blade, tile, wind, colour, fade).
 *   snowParams snow surface / trail / glitter look (the Snow panel sliders).
 *   splatRes / snowRes
 *   trees     { slots: [...slot meta...], instances: [[x,z,y,rotY,scale,slotIdx],…] }
 *   foliage   { slots: [...slot meta...], instances: [[x,z,y,rotY,scale,slotIdx,nx,nz],…] }
 *   props     propStore.exportData()
 *   roads     roadSystem.exportData()
 *   splines   splineSystem.exportData()
 *   lakes     lakeSystem.exportData()
 *   decals    { slots: [{ name, albedoUrl, normalUrl }], decals: [{ px,py,pz, qx,qy,qz,qw,
 *             sx,sy,sz, slot, opacity, tint, roughness, normalStrength, angleFade,
 *             edgeFade, priority }] } — projected decals; null when there are none.
 *             An imported texture URL is an "asset:<hash>" reference.
 *   waterfalls { look: {...}, falls: [{ px,py,pz, yaw, width, speed, depth, spread,
 *             foam, friction }] } — waterfallSystem.exportData(); null when there are none.
 *   riversV2  riverV2System.exportData()    (River v2 — the heightmap blob is the
 *                                            UNCONFORMED base when it owns it)
 *   environment { worldOcean, look }  the world's LOOK, as opposed to its shape.
 *             look = worldEnvironment.exportLook(): sky, sun, clouds, fog, lens
 *             flare, Post FX, interior (tunnel/cave) lighting. Shadow quality
 *             (CSM) is deliberately absent: a game owns it at boot.
 *   paintLayers  7 ground-paint slots: name, per-map { name, url } references,
 *             tiling / normal / AO / roughness strengths and auto-paint rules.
 *             A map from /textures is a URL; one imported from disk is an
 *             "asset:<hash>" reference to the assets section.
 *   paintBlend { heightBlend, contrast, macroStrength, macroWarmth, macroScale }
 *             how painted layers mix at their edges, plus large-scale variation.
 *             Was saved nowhere, so a game never got the edge the editor showed.
 *   spawn     { x, z, yaw }                 player start; null when unplaced
 *   tunnels   { version, wallColor, floorColor, tunnels: [{ width, height, thickness,
 *             nodes: [{ x, z, y, pinned }] }] } — Tunnel mode. Their terrain
 *             openings are NOT in the splat: they are cut again on load.
 *   assets    [{ hash, name, type }] files imported from disk (textures, GLBs,
 *             material folders…), ORIGINAL bytes as blobs "asset:<hash>". Data
 *             elsewhere refers to them with "asset:<hash>" strings (see
 *             v3/io/projectAssets.js). Only referenced files are written.
 *   splatHoles true when the splat's slice-1 alpha is the terrain HOLE channel.
 *             Absent in older files, where that alpha was Meadow paint — the
 *             load zeroes it rather than cutting holes wherever Meadow was.
 *
 * Binary blobs stay raw (heightmap Float32, splat/snow Uint8) — no base64 bloat.
 * Unknown/absent sections are simply skipped on load, so the format can grow.
 * That is why `lakes` needed no VERSION bump: older files simply have none.
 */

export const PROJECT_MAGIC = 0x4a503356; // "V3PJ" little-endian
/**
 * 2: the manifest and every blob that gains by it are GZIPPED.
 *
 * The paint is raw pixels, and raw pixels are mostly the same pixel: MEASURED
 * on nam-valley, a 2048² splat is 33.6 MB and deflates to 3.9, the foliage
 * paint 8.4 → 2.4, the whole file 62 MB → 22. That mattered the day GitHub
 * warned about a 62 MB file, and it matters more in the git history, where
 * every save is another copy. Already-compressed blobs (imported JPEGs, PNGs)
 * gain nothing and are kept raw — `enc` says which is which, per blob.
 *
 * Version 1 files load unchanged (no `enc`, plain manifest).
 */
const VERSION      = 2;
const HEADER_BYTES = 12;
/** Keep the compressed copy only when it actually saves something. */
const GAIN = 0.9;

/** gzip / gunzip through the platform's own streams — no dependency, Chrome and Node both. */
async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isProjectFile(buffer) {
  return buffer.byteLength >= HEADER_BYTES
    && new DataView(buffer).getUint32(0, true) === PROJECT_MAGIC;
}

/** Async since version 2: the blobs and the manifest are gzipped on the way out. */
export async function encodeProjectFile({
  terrain,
  heightmap,            // Float32Array
  splat, splatRes,      // Uint8Array (both slices combined), texels per side
  snow, snowRes,        // Uint8Array, texels per side
  trees, foliage, props, roads, splines, lakes, riversV2,
  decals,               // decalSystem.exportData(): { slots, decals } or null
  waterfalls,           // waterfallSystem.exportData(): { look, falls } or null
  paintLayers,         // textureLibrary.exportData() — slot metadata, no pixels
  paintBlend,           // { heightBlend, contrast } — layer edge blending
  splatHoles,           // true: slice-1 alpha is terrain holes (see manifest)
  tunnels,              // tunnelSystem.exportData() or null
  environment,          // { worldOcean } — the world LOOK; see the manifest note
  spawn,                // { x, z, yaw } player start, or null
  grassDensity,         // Uint8Array (RGBA 512²) painted grass coverage
  grassHeight,          // Uint8Array (RGBA 512²) painted blade height, .r/128 = multiplier
  susukiDensity,        // Uint8Array (RGBA 512²) painted susuki coverage
  susuki,               // susuki appearance params (JSON)
  flowerDensity,        // Uint8Array (RGBA 1024²) painted flowers, one type per channel, or null
  flowers,              // flower look params (JSON)
  foliagePaint,         // Uint8Array (RGBA 1024²) painted foliage, one plant per channel, or null
  foliagePlants,        // the four plant types: shape, colour, where they grow (JSON)
  foliageField,         // field-wide foliage params: density, clumping, wind, distance (JSON)
  ambientPaint,         // Uint8Array (RGBA 1024²) painted ambient FX, one effect per channel, or null
  ambientEffects,       // the ambient effects: motion, art, colours, rules, budget (JSON)
  ambientField,         // field-wide ambient params: volume, tier, wind (JSON)
  cliffGrassDensity,    // Uint8Array (RGBA 512²) painted cliff-top grass coverage
  cliffPaint,           // Uint8Array (RGBA 512²) terrain colour painted onto cliffs
  grass,                // grass appearance params (JSON)
  revoGrass,            // the second grass system's own look params (JSON)
  snowParams,           // snow look params (JSON)
  groundTsl,           // procedural ground params (JSON)
  meadowTsl,            // paintable meadow TSL params (JSON)
  assets,               // [{ hash, name, type, bytes }] from projectAssets.collectFor()
}) {
  const blobs = {};
  const parts = [];
  const pending = [];
  let offset = 0;
  // Collected first, compressed together below: `addBlob` stays the plain call
  // every section makes, and the gzipping is one pass over what it gathered.
  const addBlob = (name, typedArray) => {
    if (!typedArray) return;
    pending.push({ name, bytes: new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength) });
  };
  addBlob("heightmap", heightmap);
  addBlob("splat", splat);
  addBlob("snow", snow);
  addBlob("grassDensity", grassDensity);
  addBlob("grassHeight", grassHeight);
  addBlob("susukiDensity", susukiDensity);
  addBlob("flowerDensity", flowerDensity);
  addBlob("foliagePaint", foliagePaint);
  addBlob("ambientPaint", ambientPaint);
  addBlob("cliffGrassDensity", cliffGrassDensity);
  addBlob("cliffPaint", cliffPaint);
  const assetList = [];
  for (const a of assets ?? []) {
    if (!a?.hash || !a.bytes) continue;
    addBlob(`asset:${a.hash}`, a.bytes);
    assetList.push({ hash: a.hash, name: a.name, type: a.type });
  }

  // Gzip what gains by it. `raw` is what it inflates back to, so a reader can
  // size the buffer before it starts.
  for (const p of pending) {
    const packed = await gzip(p.bytes);
    const worth = packed.byteLength < p.bytes.byteLength * GAIN;
    const bytes = worth ? packed : p.bytes;
    blobs[p.name] = worth
      ? { offset, length: bytes.byteLength, enc: "gzip", raw: p.bytes.byteLength }
      : { offset, length: bytes.byteLength };
    parts.push(bytes);
    offset += bytes.byteLength;
  }

  const manifest = {
    version: VERSION,
    terrain,
    blobs,
    splatRes: splatRes ?? null,
    snowRes:  snowRes ?? null,
    trees:    trees ?? null,
    foliage:  foliage ?? null,
    props:    props ?? null,
    roads:    roads ?? null,
    splines:  splines ?? null,
    lakes:    lakes ?? null,
    decals:   decals ?? null,
    waterfalls: waterfalls ?? null,
    riversV2: riversV2 ?? null,
    paintLayers: paintLayers ?? null,
    paintBlend: paintBlend ?? null,
    splatHoles: splatHoles ?? false,
    tunnels:  tunnels ?? null,
    environment: environment ?? null,
    spawn:    spawn ?? null,
    susuki:   susuki ?? null,
    flowers:  flowers ?? null,
    foliagePlants: foliagePlants ?? null,
    foliageField:  foliageField ?? null,
    ambientEffects: ambientEffects ?? null,
    ambientField:   ambientField ?? null,
    grass:    grass ?? null,
    revoGrass: revoGrass ?? null,
    snowParams: snowParams ?? null,
    groundTsl: groundTsl ?? null,
    meadowTsl: meadowTsl ?? null,
    assets:   assetList,
  };
  // The manifest carries every tree and prop instance — 2 MB on nam-valley,
  // and JSON gzips to a fifth of itself. Version 2 always gzips it.
  const manifestBytes = await gzip(new TextEncoder().encode(JSON.stringify(manifest)));

  const total = HEADER_BYTES + manifestBytes.byteLength + offset;
  const buf   = new ArrayBuffer(total);
  const view  = new DataView(buf);
  view.setUint32(0, PROJECT_MAGIC, true);
  view.setUint32(4, VERSION, true);
  view.setUint32(8, manifestBytes.byteLength, true);
  const out = new Uint8Array(buf);
  out.set(manifestBytes, HEADER_BYTES);
  let p = HEADER_BYTES + manifestBytes.byteLength;
  for (const part of parts) { out.set(part, p); p += part.byteLength; }
  return buf;
}

/** Async since version 2: gzipped blobs and manifest are inflated on the way in. */
export async function decodeProjectFile(buffer) {
  if (!isProjectFile(buffer)) throw new Error("Not a V3 project file (bad magic).");
  const view = new DataView(buffer);
  const version = view.getUint32(4, true);
  if (version > VERSION) {
    throw new Error(`Project file version ${version} is newer than this editor supports (${VERSION}).`);
  }
  const manifestLen = view.getUint32(8, true);
  if (HEADER_BYTES + manifestLen > buffer.byteLength) {
    throw new Error("Corrupt project file (manifest length exceeds file size).");
  }
  const manifestBytes = new Uint8Array(buffer, HEADER_BYTES, manifestLen);
  const manifest = JSON.parse(new TextDecoder().decode(
    version >= 2 ? await gunzip(manifestBytes) : manifestBytes,
  ));
  const payloadStart = HEADER_BYTES + manifestLen;
  // Every blob is read (and inflated) up front: the rest of this function is
  // synchronous, and a blob is small next to the file it came out of.
  const raw = new Map();
  for (const [name, b] of Object.entries(manifest.blobs ?? {})) {
    if (!b) continue;
    if (payloadStart + b.offset + b.length > buffer.byteLength) {
      throw new Error(`Corrupt project file (blob "${name}" out of range).`);
    }
    const bytes = new Uint8Array(buffer, payloadStart + b.offset, b.length);
    raw.set(name, b.enc === "gzip" ? await gunzip(bytes) : bytes);
  }
  const blob = (name) => raw.get(name) ?? null;

  const hmBytes = blob("heightmap");
  return {
    version,
    terrain:   manifest.terrain,
    // Float32Array view needs 4-byte alignment — copy via slice to be safe.
    heightmap: hmBytes ? new Float32Array(hmBytes.slice().buffer) : null,
    splat:     blob("splat"),
    splatRes:  manifest.splatRes,
    snow:      blob("snow"),
    snowRes:   manifest.snowRes,
    trees:     manifest.trees,
    foliage:   manifest.foliage,
    props:     manifest.props,
    roads:     manifest.roads,
    splines:   manifest.splines,
    lakes:     manifest.lakes,
    decals:    manifest.decals ?? null,
    waterfalls: manifest.waterfalls ?? null,
    riversV2:  manifest.riversV2 ?? null,
    paintLayers: manifest.paintLayers ?? null,
    paintBlend: manifest.paintBlend ?? null,
    splatHoles: manifest.splatHoles === true,
    tunnels:   manifest.tunnels ?? null,
    environment: manifest.environment ?? null,
    spawn:     manifest.spawn ?? null,
    grassDensity:  blob("grassDensity"),
    grassHeight:   blob("grassHeight"),
    susukiDensity: blob("susukiDensity"),
    susuki:    manifest.susuki ?? null,
    flowerDensity: blob("flowerDensity"),
    flowers:   manifest.flowers ?? null,
    foliagePaint:  blob("foliagePaint"),
    foliagePlants: manifest.foliagePlants ?? null,
    foliageField:  manifest.foliageField ?? null,
    ambientPaint:   blob("ambientPaint"),
    ambientEffects: manifest.ambientEffects ?? null,
    ambientField:   manifest.ambientField ?? null,
    cliffGrassDensity: blob("cliffGrassDensity"),
    cliffPaint: blob("cliffPaint"),
    grass:     manifest.grass ?? null,
    revoGrass: manifest.revoGrass ?? null,
    snowParams: manifest.snowParams ?? null,
    groundTsl: manifest.groundTsl ?? null,
    meadowTsl: manifest.meadowTsl ?? null,
    assets: (manifest.assets ?? [])
      .map((a) => ({ ...a, bytes: blob(`asset:${a.hash}`) }))
      .filter((a) => a.bytes),
  };
}

/** File picker accepting both whole projects and bare heightmaps. */
export function pickProjectFile() {
  return new Promise((resolve) => {
    const input  = document.createElement("input");
    input.type   = "file";
    input.accept = ".v3proj,.v3height,.png,.raw,.r16,application/octet-stream";
    input.style.display = "none";
    const cleanup = (file) => { resolve(file); input.remove(); };
    input.addEventListener("change", () => cleanup(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => cleanup(null));
    document.body.appendChild(input);
    input.click();
  });
}
