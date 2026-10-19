// v3/render/textureLoad.js: the pieces that must stay in step with the rest of the repo.
//   1. The bundled KTX2 decoder (public/basis/) is byte-identical to three's own copy in node_modules —
//      a three upgrade that forgets to recopy it fails here instead of in a shipped game.
//   2. The loader's sRGB/linear rule by file name is the compressor's (tools/compressTextures.mjs).
//   3. manifestKey maps the url forms callers use to the manifest's "public-relative" key.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

for (const f of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
  const a = path.join(ROOT, "public/basis", f), b = path.join(ROOT, "node_modules/three/examples/jsm/libs/basis", f);
  const same = fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
  check(same, `public/basis/${f} matches three's copy${same ? "" : " — recopy it from node_modules/three/examples/jsm/libs/basis/"}`);
}

const { LINEAR_NAME, manifestKey } = await import("../v3/render/textureLoad.js");
const compressor = fs.readFileSync(path.join(ROOT, "tools/compressTextures.mjs"), "utf8");
const m = /const LINEAR = (\/.*\/i);/.exec(compressor);
check(m && m[1] === String(LINEAR_NAME), "linear-name rule identical in the loader and the compressor");

check(manifestKey("/textures/a b.png") === "textures/a b.png", "absolute url → key");
check(manifestKey("textures/a.png") === "textures/a.png", "relative url → key");
check(manifestKey("/textures/x%20y.png?v=2") === "textures/x y.png", "query dropped, escapes decoded");

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log("all ok");
