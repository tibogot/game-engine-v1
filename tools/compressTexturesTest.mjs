// compressTextures.mjs: what the KTX2 copy must keep, checked by decoding it back.
//   1. ORIENTATION: the KTX2 is stored flipped, so with flipY = false it samples like the image does with
//      flipY = true. An image whose top is red and bottom is blue must come back with BLUE in row 0.
//   2. SIZE: rounded to a multiple of 4 (10×6 → 12×8), mipmaps generated.
//   3. COLOUR SPACE: names like *_NormalGL / *_Roughness are linear, colour maps sRGB.
// Skips (passes) when KTX-Software or sharp is not installed on this machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { encodeFile, isLinearName, loadSharp, KTX_TOOL } from "./compressTextures.mjs";

const run = promisify(execFile);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

let sharp;
try { sharp = loadSharp(); } catch { console.log("skip: sharp not installed"); process.exit(0); }
if (!fs.existsSync(KTX_TOOL)) { console.log("skip: KTX-Software not installed"); process.exit(0); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ktx2test-"));
try {
  // 10×6: top 3 rows red, bottom 3 rows blue.
  const W = 10, H = 6, px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    px[i] = y < H / 2 ? 255 : 0; px[i + 1] = 0; px[i + 2] = y < H / 2 ? 0 : 255; px[i + 3] = 255;
  }
  const src = path.join(dir, "probe.png"), dst = path.join(dir, "probe.ktx2"), back = path.join(dir, "back.png");
  await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png().toFile(src);
  const r = await encodeFile(sharp, src, dst, { srgb: true, tmpDir: dir });

  check(r.w === 12 && r.h === 8, `size rounded to ×4: 10×6 → ${r.w}×${r.h}`);
  const info = (await run(KTX_TOOL, ["info", dst])).stdout;
  check(/levelCount:\s*4/.test(info), `mipmaps: levelCount ${(/levelCount:\s*(\d+)/.exec(info) ?? [])[1]} (12×8 → 4 levels)`);
  check(/SRGB/i.test(info), "colour map stored sRGB");

  await run(KTX_TOOL, ["extract", "--transcode", "rgba8", "--level", "0", dst, back]);
  const { data, info: bi } = await sharp(back).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const at = (x, y) => { const i = (y * bi.width + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const top = at(6, 0), bottom = at(6, bi.height - 1);
  check(top[2] > 200 && top[0] < 60, `row 0 is the image's BOTTOM (blue): rgb ${top}`);
  check(bottom[0] > 200 && bottom[2] < 60, `last row is the image's TOP (red): rgb ${bottom}`);

  check(isLinearName("Grass005_1K-JPG_NormalGL.jpg") && isLinearName("x_Roughness.jpg") && isLinearName("Rock_AmbientOcclusion.png"),
    "normal / roughness / AO names are linear");
  check(!isLinearName("Grass005_1K-JPG_Color.jpg") && !isLinearName("betoum_clusters.png"), "colour names are sRGB");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all ok");
