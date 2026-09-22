/**
 * Patch ONE top-level key of nam-valley's manifest in place, from a blob
 * exported off the live page — props from
 * `__V3_DEBUG.props.propStore.exportData(propSlots)`, decals from
 * `__V3_DEBUG.decalSystem.exportData()`, and so on.
 *
 * Why this rather than the editor's Save: Save DOWNLOADS a file, which then has
 * to be found and moved into public/levels. A .v3proj is
 *
 *     u32 "V3PJ" · u32 version · u32 manifestByteLength · manifest JSON · payload
 *
 * and props live entirely in the manifest, so this is a JSON patch: read the
 * header, swap one key, rewrite the length, concatenate the payload UNTOUCHED.
 * The 64 MB of embedded blobs is never parsed, copied or re-encoded.
 *
 *   node tools/patchNamValleyProps.mjs <blob.json> [--key props] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import { readProject, writeProject } from "./lib/v3proj.mjs";

const LEVEL = "public/levels/nam-valley.v3proj";
const src = process.argv[2];
const dry = process.argv.includes("--dry");
const ki = process.argv.indexOf("--key");
const KEY = ki > 0 ? process.argv[ki + 1] : "props";
if (!src) {
  console.error("usage: node tools/patchNamValleyProps.mjs <blob.json> [--key props] [--dry]");
  process.exit(1);
}

const blob = JSON.parse(fs.readFileSync(src, "utf8"));
/** The array inside each kind of blob whose length must never shrink. */
const COUNTED = { props: "instances", decals: "decals" };
const countKey = COUNTED[KEY];
if (countKey && !Array.isArray(blob[countKey])) {
  console.error(`that file does not look like a "${KEY}" export (need ${countKey}[])`);
  process.exit(1);
}

// Through tools/lib/v3proj.mjs: a v2 file's manifest and blobs are gzipped.
const { version, manifest, blobs, fileBytes } = await readProject(LEVEL);

const before = manifest[KEY] ?? {};
console.log(`${LEVEL}  v${version}  ${blobs.size} blobs  ${fileBytes} B`);
if (countKey) {
  console.log(`${KEY}  ${countKey} ${before[countKey]?.length ?? 0} -> ${blob[countKey].length}`);
  // A patch must never LOSE entries — the failure mode is a map that loads
  // clean and is simply missing its rocks, which nothing reports.
  if ((before[countKey]?.length ?? 0) > blob[countKey].length) {
    console.error(`REFUSING: that would drop `
      + `${before[countKey].length - blob[countKey].length} ${countKey}.`);
    process.exit(1);
  }
} else {
  console.log(`${KEY}  replacing`);
}

manifest[KEY] = blob;

if (dry) {
  console.log(`dry run — nothing written (file is ${fileBytes} B)`);
  process.exit(0);
}

// Keep the previous file next to it until the result has been opened once.
const bak = LEVEL + ".bak";
fs.copyFileSync(LEVEL, bak);
const written = await writeProject(LEVEL, { manifest, blobs });
console.log(`wrote ${written} B (was ${fileBytes} B); previous file kept at ${path.basename(bak)}`);
