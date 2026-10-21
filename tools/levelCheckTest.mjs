// tools/levelCheck.mjs: it must CATCH a broken level, and every shipped level must pass.
//   1. A copy of alg-base broken five ways (a missing texture, a decal on a slot that doesn't exist,
//      a NaN height, a prop outside the world, a prop slot that can't be restored) reports each one.
//   2. Every level in public/levels has 0 errors — so a level that would break in a game fails here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { readProject, writeProject } = await import(pathToFileURL(path.join(ROOT, "tools/lib/v3proj.mjs")).href);
const { checkLevel } = await import(pathToFileURL(path.join(ROOT, "tools/levelCheck.mjs")).href);
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "levelcheck-"));
try {
  const p = await readProject(path.join(ROOT, "public/levels/alg-base.v3proj"));
  const m = structuredClone(p.manifest);
  const half = m.terrain.worldSize / 2;
  m.decals = { slots: [{ albedoUrl: "/textures/decals/__missing__.webp" }], decals: [{ px: 0, py: 0, pz: 0, slot: 3 }] };
  m.props = {
    slots: [{ name: "Rock: Boulder A", builtin: true }, { name: "my_import.glb", builtin: false }],
    instances: [{ typeIdx: 0, px: half + 50, py: 0, pz: 0 }],
  };
  const blobs = new Map(p.blobs);
  const hb = Buffer.from(blobs.get("heightmap"));
  new Float32Array(hb.buffer, hb.byteOffset, hb.byteLength >> 2)[123] = NaN;
  blobs.set("heightmap", hb);
  const broken = path.join(dir, "broken.v3proj");
  await writeProject(broken, { manifest: m, blobs });

  const r = await checkLevel(broken);
  const all = [...r.errors, ...r.warnings].join("\n");
  check(/missing file \/textures\/decals\/__missing__\.webp/.test(all), "a missing texture is an error");
  check(/decals point at a slot that doesn't exist/.test(all), "a decal on a missing slot is an error");
  check(/NaN/.test(all), "a NaN height is an error");
  check(/props outside/.test(all), "a prop outside the world is a warning");
  check(/my_import\.glb.*can't be restored/.test(all), "an unrestorable prop slot is an error");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

const levels = fs.readdirSync(path.join(ROOT, "public/levels")).filter((f) => f.endsWith(".v3proj"));
for (const f of levels) {
  const r = await checkLevel(path.join(ROOT, "public/levels", f));
  check(r.errors.length === 0, `${f}: 0 errors${r.errors.length ? ` — ${r.errors[0]}` : ""}`);
}
if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all ok");
