// Heightmap import/export formats (v3/io/heightmapFormats.js): 16-bit PNG and
// RAW must round-trip EXACTLY, RAW layout must be inferred from the byte count,
// and resampling must keep edges and linear ramps.
import {
  isPng, decodePngHeights, encodeGray16Png,
  inferRawLayout, decodeRawHeights, encodeRaw16,
  flipRows, resampleHeights, heightsToUint16,
} from "../v3/io/heightmapFormats.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

// A non-symmetric terrain so a flipped or transposed image cannot pass.
const W = 129, H = 97;
const heights = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  heights[y * W + x] = 0.5 + 0.3 * Math.sin(x * 0.11) * Math.cos(y * 0.07) + 0.15 * (x / W) - 0.1 * (y / H);
}
const { samples } = heightsToUint16(heights, 250);

// ── PNG ──
const png = await encodeGray16Png(samples, W, H);
check("encoded PNG has the PNG signature", isPng(png));
const decoded = await decodePngHeights(png);
check("PNG keeps its size", decoded.width === W && decoded.height === H, `${decoded.width}×${decoded.height}`);
check("PNG reports 16 bits", decoded.bitDepth === 16);
let pngMismatch = 0;
for (let i = 0; i < samples.length; i++) if (Math.round(decoded.data[i] * 65535) !== samples[i]) pngMismatch++;
check("16-bit PNG round trip is exact", pngMismatch === 0, `${pngMismatch} of ${samples.length} differ`);
check("PNG row 0 is the first row written", Math.round(decoded.data[5] * 65535) === samples[5]
  && Math.round(decoded.data[(H - 1) * W + 7] * 65535) === samples[(H - 1) * W + 7]);

// ── RAW ──
const S = 65;
const sq = new Uint16Array(S * S);
for (let i = 0; i < sq.length; i++) sq[i] = (i * 7919) % 65536;
for (const littleEndian of [true, false]) {
  const raw = encodeRaw16(sq, { littleEndian });
  const back = decodeRawHeights(raw, { littleEndian });
  let mm = 0;
  for (let i = 0; i < sq.length; i++) if (Math.round(back.data[i] * 65535) !== sq[i]) mm++;
  check(`16-bit RAW round trip is exact (${littleEndian ? "little" : "big"}-endian)`, mm === 0 && back.width === S, `${mm} differ`);
}
const wrongOrder = decodeRawHeights(encodeRaw16(sq, { littleEndian: true }), { littleEndian: false });
check("reading RAW with the wrong byte order gives different heights", Math.round(wrongOrder.data[1] * 65535) !== sq[1]);

check("RAW 1025²×2 bytes is 16-bit 1025", JSON.stringify(inferRawLayout(1025 * 1025 * 2)) === JSON.stringify({ size: 1025, bits: 16 }));
check("RAW 513² bytes is 8-bit 513", JSON.stringify(inferRawLayout(513 * 513)) === JSON.stringify({ size: 513, bits: 8 }));
check("RAW of a non-square size is rejected", inferRawLayout(1000 * 999 * 2 + 1) === null);
let threw = false;
try { decodeRawHeights(new ArrayBuffer(12345)); } catch { threw = true; }
check("decodeRawHeights throws on an impossible size", threw);

// ── Conversions ──
const f = new Float32Array(heights);
flipRows(f, W, H);
check("flipRows moves row 0 to the bottom", f[(H - 1) * W + 3] === heights[3] && f[3] === heights[(H - 1) * W + 3]);
flipRows(f, W, H);
check("flipRows twice is the identity", f.every((v, i) => v === heights[i]));

const same = resampleHeights(heights, W, H, W, H);
check("resampling to the same size is a copy", same.every((v, i) => v === heights[i]));

const rampN = 2049;
const ramp = new Float32Array(rampN * rampN);
for (let y = 0; y < rampN; y++) for (let x = 0; x < rampN; x++) ramp[y * rampN + x] = x / (rampN - 1);
const small = resampleHeights(ramp, rampN, rampN, 1024, 1024);
let rampErr = 0;
for (let y = 0; y < 1024; y += 17) for (let x = 0; x < 1024; x++) rampErr = Math.max(rampErr, Math.abs(small[y * 1024 + x] - x / 1023));
check("2049² → 1024² keeps a linear ramp (corner-aligned)", rampErr < 1e-5, `max error ${rampErr.toExponential(2)}`);
check("resampling keeps the four corners", small[0] === ramp[0] && small[1023] === ramp[rampN - 1]
  && small[1023 * 1024] === ramp[(rampN - 1) * rampN] && small[1024 * 1024 - 1] === ramp[rampN * rampN - 1]);

const clip = heightsToUint16(new Float32Array([-0.1, 0, 0.5, 1, 1.2]), 250);
check("heightsToUint16 clips and counts both ends", clip.clippedLow === 1 && clip.clippedHigh === 1
  && clip.samples[0] === 0 && clip.samples[3] === 65535 && clip.samples[4] === 65535 && clip.samples[2] === 32768);
const scaled = heightsToUint16(new Float32Array([0.5]), 250, 125); // 125 m in a 250 m terrain = top of a 125 m range
check("a custom top height rescales", scaled.samples[0] === 65535 && scaled.clippedHigh === 0);

console.log(fail ? `\n${fail} FAILED` : "\nall good");
process.exit(fail ? 1 : 0);
