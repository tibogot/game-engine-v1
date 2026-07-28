// Headless check of SplatMap.setCombinedResampled (default config → SPLAT_RES 512).
import { SplatMap, SPLAT_RES } from "../v3/terrain/splatMap.js";

let fails = 0;
const ok = (name, cond, extra = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${extra}`); fails++; }
};

const makeSlices = (res, fn) => {
  const b = new Uint8Array(res * res * 4 * 2);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    const [a, c, d, e, f, g, h, i] = fn(x, y);
    const o = (y * res + x) * 4;
    b[o] = a; b[o+1] = c; b[o+2] = d; b[o+3] = e;
    const o1 = res * res * 4 + o;
    b[o1] = f; b[o1+1] = g; b[o1+2] = h; b[o1+3] = i;
  }
  return b;
};

console.log(`SPLAT_RES = ${SPLAT_RES}`);

// 1. Upsample 256 -> 512, constant field must survive exactly.
{
  const sm = new SplatMap();
  sm.setCombinedResampled(makeSlices(256, () => [200, 55, 0, 0, 10, 20, 30, 40]), 256);
  let bad = null;
  for (let i = 0; i < sm.data0.length; i += 4) {
    if (sm.data0[i] !== 200 || sm.data0[i+1] !== 55 || sm.data1[i+3] !== 40) { bad = i; break; }
  }
  ok("upsample 256->512 preserves a constant field", bad === null, `first bad byte ${bad}`);
}

// 2. Weight sum preserved across a gradient (the property the shader relies on).
{
  const sm = new SplatMap();
  sm.setCombinedResampled(makeSlices(256, (x) => {
    const a = Math.round((x / 255) * 255);
    return [a, 255 - a, 0, 0, 0, 0, 0, 0];
  }), 256);
  let worst = 0;
  for (let i = 0; i < sm.data0.length; i += 4) {
    worst = Math.max(worst, Math.abs((sm.data0[i] + sm.data0[i+1]) - 255));
  }
  ok("upsample keeps L1+L2 summing to 255", worst <= 1, `max drift ${worst}`);
}

// 3. Downsample 1024 -> 512: a 1px checkerboard must average, not vanish.
{
  const sm = new SplatMap();
  sm.setCombinedResampled(
    makeSlices(1024, (x, y) => [((x + y) & 1) ? 255 : 0, 0, 0, 0, 0, 0, 0, 0]), 1024);
  let min = 255, max = 0;
  for (let i = 0; i < sm.data0.length; i += 4) {
    min = Math.min(min, sm.data0[i]); max = Math.max(max, sm.data0[i]);
  }
  ok("downsample box-averages a checkerboard (~128 everywhere)",
     min === 128 && max === 128, `range ${min}..${max}`);
}

// 4. Downsample must not lose a thin stroke entirely.
{
  const sm = new SplatMap();
  sm.setCombinedResampled(
    makeSlices(1024, (x, y) => [y === 500 ? 255 : 0, 0, 0, 0, 0, 0, 0, 0]), 1024);
  let sum = 0;
  for (let i = 0; i < sm.data0.length; i += 4) sum += sm.data0[i];
  ok("downsample retains a 1px stroke", sum > 0, `sum ${sum}`);
}

// 5. Equal resolution delegates to setCombined (exact copy, no filtering).
{
  const sm = new SplatMap();
  const src = makeSlices(SPLAT_RES, (x, y) => [(x * 7 + y) & 255, 0, 0, 0, 0, 0, 0, 0]);
  sm.setCombinedResampled(src, SPLAT_RES);
  let exact = true;
  for (let i = 0; i < src.length; i++) if (sm.combined[i] !== src[i]) { exact = false; break; }
  ok("equal resolution is a byte-exact copy", exact);
}

// 6. Undersized input is rejected rather than reading out of bounds.
{
  const sm = new SplatMap();
  let threw = false;
  try { sm.setCombinedResampled(new Uint8Array(64), 256); } catch { threw = true; }
  ok("undersized payload throws", threw);
}

// 7. Legacy fallback still reproduces the old hardwired value.
{
  const { legacySplatSize } = await import(
    "../v3/terrain/heightmapTexture.js");
  ok("legacySplatSize matches the old formula",
     legacySplatSize(1024) === 512 && legacySplatSize(4096) === 2048 && legacySplatSize(256) === 256,
     `${legacySplatSize(1024)} ${legacySplatSize(4096)} ${legacySplatSize(256)}`);
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
