/**
 * Ground texture SCALE and Poly Haven sets for nam-valley's paint layers.
 *
 * WHY THIS EXISTS
 * ---------------
 * `uUVScale` is not a tile size — it is how many times a texture repeats
 * across the WHOLE WORLD (splatOverlayTsl samples
 * `positionWorld.mul(1/WORLD_SIZE).mul(uUVScale).xz`). So
 *
 *     tile size in metres = worldSize / uvScale
 *
 * nam-valley is 1024 m and its ground layers shipped at uvScale 28-42, i.e.
 * ONE TEXTURE TILE EVERY 24-37 METRES. The Poly Haven sets in those slots are
 * close-range photographs of roughly 1-2 m of ground, so every pebble, leaf
 * and clod was being drawn 15-35x oversized — which is what reads as "big soft
 * wash" instead of ground. It is not a resolution problem (1024 texels over
 * 34 m is already 3 cm a texel) and not the layer count.
 *
 * Changing the scale is FREE: a multiply on a UV, no extra taps, no draw calls.
 *
 * 1K, NOT 2K. textureLibrary resamples every slot map to SLOT_RES = 1024
 * (`canvas.drawImage(bitmap, 0, 0, SLOT_RES, SLOT_RES)`), so a 2K or 4K
 * download is thrown away on load. This tool always fetches 1k jpg.
 *
 * IT ALSO TAKES THE TEXTURES OUT OF THE LEVEL FILE. Four of the layers had
 * their maps embedded as `asset:<hash>` blobs — 16 assets, ~12.1 MB of a
 * 22.9 MB .v3proj. Written out to public/textures/ground/ they become plain
 * static files the browser can cache, and the level file roughly halves. The
 * bytes are copied out of the blob, not re-fetched, so they are identical.
 *
 *   node tools/namGroundTextures.mjs --dry        # show the plan, write nothing
 *   node tools/namGroundTextures.mjs              # apply PLAN below
 *   node tools/namGroundTextures.mjs --tile 0=5,4=3.5
 *   node tools/namGroundTextures.mjs --slug 0=forest_ground_05 --tile 0=6
 *   node tools/namGroundTextures.mjs --list       # curated Poly Haven candidates
 *
 * To sweep the scale live instead, without re-running anything, use the game
 * console: `__V3_DEBUG.paintTile(0, 5)` sets slot 0 to a 5 m tile.
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const LEVEL = "public/levels/nam-valley.v3proj";
const OUT_DIR = "public/textures/ground";
const RES = "1k";

/** Poly Haven's map name -> the paintLayer field that holds it. */
const MAPS = [
  ["Diffuse", "albedo"],
  ["nor_gl", "normal"],
  ["Rough", "rough"],
  ["AO", "ao"],
];

/**
 * THE PLAN — one entry per slot to touch. `tileM` is what one repeat of the
 * texture should cover, in metres of ground. `slug` swaps in a different Poly
 * Haven set (omit to keep the maps the slot already has).
 *
 * These metres are a FIRST PASS, deliberately conservative. Going straight from
 * 34 m to 3-4 m would show real detail but would also read as an obvious grid:
 * a 4 m tile is only ~50 screen pixels at RTS zoom. 5-8 m is a 4-6x improvement
 * that macro variation (already on at 0.35 / 80 m) can still hide. Push lower
 * with --tile once texture repetition is dealt with properly.
 *
 * Slot 6 (Snow) is not listed: it is painted on 0.00% of this map and is
 * compiled out of the game shader entirely by `splatFeatures.layerBudget: 6`.
 */
const PLAN = {
  0: { tileM: 7 },                              // Jungle floor  (forrest_ground_01)
  1: { tileM: 8 },                              // Dry ridge     (red_laterite_soil_stones)
  2: { tileM: 6, slug: "coast_sand_01" },       // Beach sand    — was a procedural bake
  3: { tileM: 7 },                              // Lowland floor (dry_mud_field_001)
  4: { tileM: 5 },                              // Dirt road     (red_dirt_mud_01)
  5: { tileM: 6 },                              // Cliff Rock    (already a server path)
};

/** Poly Haven sets worth trying in these slots, by what they are for. */
const CANDIDATES = {
  "jungle floor": [
    "forrest_ground_01", "forest_ground_05", "forest_ground_06",
    "leaves_forest_ground", "brown_mud_leaves_01", "forest_floor",
  ],
  "red / laterite ridge": [
    "red_laterite_soil_stones", "red_mud_stones", "red_dirt_mud_01",
    "brown_mud_rocks_01",
  ],
  "paddy / field / lowland": [
    "dry_mud_field_001", "mud_cracked_dry_03", "brown_mud_dry", "dirt_floor",
  ],
  "track / road / apron": [
    "red_dirt_mud_01", "gravel_ground_01", "grass_path_2", "rocky_trail",
  ],
  "grass": ["grass_ground", "grass_path_3"],
  "sand / shore": ["coast_sand_01", "coast_sand_03", "coast_sand_04", "aerial_beach_03"],
  "rock / cliff": ["rock_ground_02", "rocks_ground_05", "gray_rocks", "lichen_rock"],
};

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const force = argv.includes("--force");

function pairArg(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return {};
  const out = {};
  for (const part of String(argv[i + 1] ?? "").split(",")) {
    const [k, v] = part.split("=");
    if (k !== undefined && v !== undefined) out[k.trim()] = v.trim();
  }
  return out;
}

if (argv.includes("--list")) {
  for (const [what, slugs] of Object.entries(CANDIDATES)) {
    console.log(`\n${what}`);
    for (const s of slugs) console.log(`  ${s.padEnd(28)} https://polyhaven.com/a/${s}`);
  }
  console.log("\n  node tools/namGroundTextures.mjs --slug 0=forest_ground_05 --tile 0=6");
  process.exit(0);
}

const plan = structuredClone(PLAN);
for (const [slot, m] of Object.entries(pairArg("--tile"))) {
  const t = Number(m);
  if (!Number.isFinite(t) || t <= 0) throw new Error(`--tile ${slot}=${m}: not a positive number of metres`);
  (plan[slot] ??= {}).tileM = t;
}
for (const [slot, s] of Object.entries(pairArg("--slug"))) {
  if (!/^[a-z0-9_]+$/i.test(s)) throw new Error(`--slug ${slot}=${s}: not a Poly Haven slug`);
  (plan[slot] ??= {}).slug = s;
}

// ── Poly Haven ──────────────────────────────────────────────────────────────
/** `<slug>_nor_gl_1k.jpg` -> `slug`. Used to file an embedded asset by set. */
function slugFromMapName(name) {
  const m = String(name).match(/^(.*?)_(diffuse|diff|nor_gl|nor_dx|nor|rough|ao|arm|disp)_\d+k\.[a-z0-9]+$/i);
  return m ? m[1] : null;
}

const phCache = new Map();
async function phFiles(slug) {
  if (phCache.has(slug)) return phCache.get(slug);
  const resp = await fetch(`https://api.polyhaven.com/files/${encodeURIComponent(slug)}`);
  if (!resp.ok) throw new Error(`polyhaven ${slug}: HTTP ${resp.status} (is the slug right?)`);
  const json = await resp.json();
  phCache.set(slug, json);
  return json;
}

/**
 * Put a Poly Haven set on disk under public/textures/ground/<slug>/ and return
 * `{ albedo: {name,url}, ... }` refs pointing at it. A map the set does not
 * publish is returned as null rather than failing the whole slot.
 */
async function fetchSet(slug) {
  const files = await phFiles(slug);
  const dir = path.join(OUT_DIR, slug);
  const refs = {};
  for (const [phName, field] of MAPS) {
    const entry = files[phName]?.[RES]?.jpg;
    if (!entry?.url) { refs[field] = null; console.log(`      ${field.padEnd(7)} — not published at ${RES} jpg, skipped`); continue; }
    const name = entry.url.split("/").pop();
    const dest = path.join(dir, name);
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size === entry.size) {
      console.log(`      ${field.padEnd(7)} ${name} (already on disk)`);
    } else if (dry) {
      console.log(`      ${field.padEnd(7)} ${name} — would download ${Math.round(entry.size / 1024)} KB`);
    } else {
      const r = await fetch(entry.url);
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, bytes);
      console.log(`      ${field.padEnd(7)} ${name} — ${Math.round(bytes.length / 1024)} KB`);
    }
    refs[field] = { name, url: `/${path.posix.join("textures/ground", slug, name)}` };
  }
  return refs;
}

// ── go ──────────────────────────────────────────────────────────────────────
const { version, manifest, blobs, fileBytes } = await readProject(LEVEL);
const layers = manifest.paintLayers;
if (!Array.isArray(layers)) throw new Error("paintLayers is not an array — wrong file?");
const worldSize = manifest.terrain?.worldSize;
if (!Number.isFinite(worldSize)) throw new Error("no terrain.worldSize in the manifest");

console.log(`${LEVEL}  v${version}  ${blobs.size} blobs  ${(fileBytes / 1e6).toFixed(1)} MB`);
console.log(`world ${worldSize} m — tile metres = ${worldSize} / uvScale\n`);

for (const [slotKey, spec] of Object.entries(plan)) {
  const i = Number(slotKey);
  const L = layers[i];
  if (!L) { console.log(`slot ${i}: not in this project, skipped`); continue; }

  const wasUV = L.uvScale;
  const uv = Math.max(1, Math.round(worldSize / spec.tileM));
  console.log(`slot ${i}  ${String(L.name)}`);
  console.log(`   uvScale ${wasUV} -> ${uv}   (tile ${(worldSize / wasUV).toFixed(1)} m -> ${(worldSize / uv).toFixed(1)} m)`);

  if (spec.slug) {
    const from = slugFromMapName(L.albedo?.name) ?? L.procedural?.preset ?? L.albedo?.name ?? "(nothing)";
    console.log(`   set     ${from} -> ${spec.slug}`);
    const refs = await fetchSet(spec.slug);
    for (const [, field] of MAPS) if (refs[field] !== undefined) L[field] = refs[field];
    if (L.procedural) {
      console.log(`   procedural bake "${L.procedural.preset ?? "custom"}" dropped — the images own the pixels now`);
      L.procedural = null;
    }
  } else {
    // Keep the maps, but lift any embedded copy out to a static file.
    for (const [, field] of MAPS) {
      const ref = L[field];
      if (!ref?.url?.startsWith("asset:")) continue;
      const slug = slugFromMapName(ref.name);
      if (!slug) { console.log(`   ${field}: "${ref.name}" is not a Poly Haven map name — left embedded`); continue; }
      const bytes = blobs.get(ref.url);
      if (!bytes) { console.log(`   ${field}: blob ${ref.url} missing — left as is`); continue; }
      const dest = path.join(OUT_DIR, slug, ref.name);
      if (!dry) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, bytes);
      }
      L[field] = { name: ref.name, url: `/${path.posix.join("textures/ground", slug, ref.name)}` };
      console.log(`   ${field.padEnd(7)} unembedded -> ${L[field].url}  (${Math.round(bytes.length / 1024)} KB)`);
    }
  }
  L.uvScale = uv;
  console.log("");
}

// ── drop assets nothing refers to any more ──────────────────────────────────
// Scan the manifest with the asset TABLE and the BLOB INDEX removed, so an
// entry does not count as its own reference: `assets` holds the hash and
// `blobs` is keyed by "asset:<hash>", so leaving either in makes every asset
// look alive. writeProject rebuilds `blobs` from the Map, so dropping it here
// costs nothing. Anything still named — by a prop, a decal, a spline — stays.
const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
const probe = JSON.stringify({ ...manifest, assets: undefined, blobs: undefined });
const keep = assets.filter((a) => probe.includes(`asset:${a.hash}`));
const dropped = assets.filter((a) => !keep.includes(a));
let freed = 0;
for (const a of dropped) {
  const key = `asset:${a.hash}`;
  freed += blobs.get(key)?.length ?? 0;
  blobs.delete(key);
}
manifest.assets = keep;
console.log(`assets ${assets.length} -> ${keep.length}  (${(freed / 1e6).toFixed(1)} MB of blobs dropped)`);

if (dry) {
  console.log("\ndry run — nothing written");
  process.exit(0);
}

const bak = `${LEVEL}.bak`;
fs.copyFileSync(LEVEL, bak);
const written = await writeProject(LEVEL, { manifest, blobs });
console.log(`\nwrote ${(written / 1e6).toFixed(1)} MB (was ${(fileBytes / 1e6).toFixed(1)} MB); previous file kept at ${path.basename(bak)}`);
