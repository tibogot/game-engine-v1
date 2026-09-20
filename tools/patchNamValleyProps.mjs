/**
 * Patch nam-valley's PROPS in place, from a props blob exported off the live
 * page (`__V3_DEBUG.props.propStore.exportData(propSlots)`).
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
 *   node tools/patchNamValleyProps.mjs <props.json> [--dry]
 */
import fs from "node:fs";
import path from "node:path";

const LEVEL = "public/levels/nam-valley.v3proj";
const src = process.argv[2];
const dry = process.argv.includes("--dry");
if (!src) {
  console.error("usage: node tools/patchNamValleyProps.mjs <props.json> [--dry]");
  process.exit(1);
}

const props = JSON.parse(fs.readFileSync(src, "utf8"));
if (!Array.isArray(props.types) || !Array.isArray(props.instances)) {
  console.error("that file does not look like a propStore export (need types[] and instances[])");
  process.exit(1);
}

const buf = fs.readFileSync(LEVEL);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const magic = buf.toString("ascii", 0, 4);
if (magic !== "V3PJ") { console.error(`bad magic ${magic}`); process.exit(1); }
const version = dv.getUint32(4, true);
const manLen = dv.getUint32(8, true);
const manifest = JSON.parse(buf.toString("utf8", 12, 12 + manLen));
const payload = buf.subarray(12 + manLen);

const before = manifest.props ?? {};
console.log(`${LEVEL}  v${version}  manifest ${manLen} B  payload ${payload.length} B`);
console.log(`props  types ${before.types?.length ?? 0} -> ${props.types.length}`
  + `   instances ${before.instances?.length ?? 0} -> ${props.instances.length}`);

// A props patch must never LOSE instances — the failure mode is a map that
// loads clean and is simply missing its rocks, which nothing reports.
if ((before.instances?.length ?? 0) > props.instances.length) {
  console.error(`REFUSING: that would drop ${before.instances.length - props.instances.length} instances.`);
  process.exit(1);
}

manifest.props = props;

const manBuf = Buffer.from(JSON.stringify(manifest), "utf8");
const head = Buffer.alloc(12);
head.write("V3PJ", 0, "ascii");
head.writeUInt32LE(version, 4);
head.writeUInt32LE(manBuf.length, 8);
const out = Buffer.concat([head, manBuf, payload]);

if (dry) {
  console.log(`dry run — would write ${out.length} B (was ${buf.length} B)`);
  process.exit(0);
}

// Keep the previous file next to it until the result has been opened once.
const bak = LEVEL + ".bak";
fs.copyFileSync(LEVEL, bak);
fs.writeFileSync(LEVEL, out);
console.log(`wrote ${out.length} B (was ${buf.length} B); previous file kept at ${path.basename(bak)}`);
