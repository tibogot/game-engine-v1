// Read-only dependency + asset tracer for the repo migration inventory.
// usage: node trace.mjs <repoRoot> <outDir>
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2]);
const OUT = path.resolve(process.argv[3]);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

const ASSET_EXT = /\.(glb|gltf|png|jpe?g|webp|ktx2|hdr|exr|v3proj|mp3|ogg|wav|bin|json|tga|svg|raw|r16|basis|csv|txt|ttf|woff2?)$/i;
const CODE_EXT = /\.(m?js|html|css|wgsl|glsl)$/i;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function resolveSpec(spec, fromFile) {
  if (/^(https?:|data:|blob:)/.test(spec)) return { ext: spec };
  let clean = spec.split("?")[0].split("#")[0];
  const cands = [];
  if (clean.startsWith("./") || clean.startsWith("../")) cands.push(path.resolve(path.dirname(fromFile), clean));
  else if (clean.startsWith("/")) { cands.push(path.join(ROOT, clean)); cands.push(path.join(ROOT, "public", clean)); }
  else if (/^(v2|v3|games|public|tools|src)\//.test(clean)) { cands.push(path.join(ROOT, clean)); }
  else if (/^[\w@][\w@.\-/]*$/.test(clean) && !clean.includes(".") || clean.startsWith("@") || /^three(\/|$)/.test(clean)) {
    const pkg = clean.startsWith("@") ? clean.split("/").slice(0, 2).join("/") : clean.split("/")[0];
    return { pkg };
  } else {
    cands.push(path.resolve(path.dirname(fromFile), clean));
    cands.push(path.join(ROOT, "public", clean));
    cands.push(path.join(ROOT, clean));
  }
  for (const c of cands) {
    if (exists(c)) return { file: c };
    if (exists(c + ".js")) return { file: c + ".js" };
    if (isDir(c) && exists(path.join(c, "index.js"))) return { file: path.join(c, "index.js") };
  }
  return { missing: clean };
}

function scan(file) {
  let src;
  try { src = fs.readFileSync(file, "utf8"); } catch { return { code: [], assets: [], dyn: [], pkgs: [] }; }
  const s = stripComments(src);
  const code = new Set(), assets = new Set(), dyn = new Set(), pkgs = new Set();
  const add = (spec, kind) => {
    const r = resolveSpec(spec, file);
    if (r.pkg) { pkgs.add(r.pkg); return; }
    if (r.ext) return;
    if (r.file) { (CODE_EXT.test(r.file) ? code : assets).add(r.file); return; }
    if (r.missing && kind !== "str") (CODE_EXT.test(r.missing) || kind === "import" ? dyn : assets).add("MISSING:" + r.missing);
  };
  const re = [
    [/\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, "import"],
    [/\bexport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g, "import"],
    [/\bimport\(\s*["']([^"']+)["']\s*\)/g, "import"],
    [/new\s+URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/g, "url"],
    [/<script[^>]*\bsrc=["']([^"']+)["']/g, "import"],
    [/<link[^>]*\bhref=["']([^"']+\.css)["']/g, "import"],
    [/@import\s+(?:url\()?["']([^"']+)["']/g, "import"],
  ];
  for (const [r, kind] of re) for (const m of s.matchAll(r)) add(m[1], kind);
  // template-literal dynamic imports we cannot resolve
  for (const m of s.matchAll(/\bimport\(\s*`([^`]+)`/g)) dyn.add("TEMPLATE:" + m[1]);
  for (const m of s.matchAll(/\bimport\(\s*([A-Za-z_$][\w$.]*)\s*\)/g)) dyn.add("VAR:" + m[1]);
  // string literals that name code paths (registries: "v3/props/objects/windmill.js")
  // (engine.js lists ALLOWED modules as strings; that list is not an import)
  if (!file.endsWith(path.join("v3", "engine.js")))
    for (const m of s.matchAll(/["'`]((?:\.{1,2}\/|\/)?(?:v2|v3|games)\/[\w\-./]+\.(?:m?js|html))["'`]/g)) add(m[1], "str");
  // asset string literals
  for (const m of s.matchAll(/["'`]([^"'`\s${}]+?\.(?:glb|gltf|png|jpe?g|webp|ktx2|hdr|exr|v3proj|mp3|ogg|wav|bin|json|tga|svg|raw|r16|basis|csv|ttf|woff2?))(?:\?[^"'`]*)?["'`]/gi)) add(m[1], "asset");
  // asset directory prefixes (fetched by name at runtime)
  for (const m of s.matchAll(/["'`](\/?(?:public\/)?(?:models|textures|sounds|games|levels|assets|brush-stamps|clouds|draco|tree-presets|city-ads|city-signs|city-totems|icons|v2)\/[\w\-./]*\/)["'`]/g)) {
    const d = m[1].replace(/^\/?(public\/)?/, "");
    if (isDir(path.join(ROOT, "public", d))) assets.add("DIR:" + d);
  }
  return { code: [...code], assets: [...assets], dyn: [...dyn], pkgs: [...pkgs] };
}

// Assets that are themselves JSON (levels, manifests): scan for nested asset paths.
function scanJsonAsset(file) {
  const out = new Set();
  let src; try { if (fs.statSync(file).size > 60e6) return []; src = fs.readFileSync(file, "utf8"); } catch { return []; }
  for (const m of src.matchAll(/"([^"\s]+?\.(?:glb|gltf|png|jpe?g|webp|ktx2|hdr|exr|mp3|ogg|wav|bin|tga|raw|r16))"/gi)) {
    const r = resolveSpec(m[1], file);
    if (r.file) out.add(r.file); else if (r.missing) out.add("MISSING:" + r.missing);
  }
  return [...out];
}

function trace(entries) {
  const seen = new Set(), assets = new Set(), dyn = new Set(), pkgs = new Set(), missingCode = new Set();
  const stack = entries.map((e) => path.join(ROOT, e)).filter(exists);
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const r = scan(f);
    r.pkgs.forEach((p) => pkgs.add(p));
    r.dyn.forEach((d) => dyn.add(rel(f) + " -> " + d));
    for (const c of r.code) if (!seen.has(c)) stack.push(c);
    for (const a of r.assets) {
      if (a.startsWith("MISSING:") || a.startsWith("DIR:")) { assets.add(a); continue; }
      assets.add(a);
      if (/\.(json|v3proj)$/i.test(a)) for (const n of scanJsonAsset(a)) assets.add(n);
    }
  }
  return { code: [...seen], assets: [...assets], dyn: [...dyn], pkgs: [...pkgs] };
}

const GROUPS = {
  editor: ["v3/editor.html"],
  "alg-rts": ["games/alg-rts/alg.html", "games/alg-rts/menu.html"],
  "stylized-lab": ["games/stylized-lab/index.html", "games/stylized-lab/blender-cliff.html"],
  "rock-lab": ["games/rock-lab/index.html"],
  "apex-rush": ["games/modular-road-v3/road.html"],
  "empty-game": ["games/empty-game/index.html"],
  "nam-rts": ["games/nam-rts/nam.html"],
  "rts-v3": ["games/rts-v3/rts.html"],
  terrarium: ["games/terrarium/terrarium-lab.html"],
};
// every lab page is its own group
const labPages = [];
for (const dir of ["v3", "v3/authoring", "games/alg-rts", "games/modular-road-v3", "games/shared-rts", "games/stylized-lab"]) {
  if (!isDir(path.join(ROOT, dir))) continue;
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (!f.endsWith(".html")) continue;
    const p = dir + "/" + f;
    if (Object.values(GROUPS).flat().includes(p)) continue;
    labPages.push(p);
  }
}
for (const p of labPages) GROUPS["lab:" + p] = [p];

const results = {};
for (const [g, entries] of Object.entries(GROUPS)) results[g] = trace(entries);

// all code files in the three trees
function walk(d, acc = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!["node_modules", "vendor-src"].includes(e.name)) walk(p, acc); }
    else if (/\.(m?js|html|css|wgsl)$/.test(e.name)) acc.push(p);
  }
  return acc;
}
const allCode = ["v2", "v3", "games"].filter((d) => isDir(path.join(ROOT, d))).flatMap((d) => walk(path.join(ROOT, d)));
const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n").length; } catch { return 0; } };

const fileGroups = {};
for (const f of allCode) fileGroups[rel(f)] = [];
for (const [g, r] of Object.entries(results)) for (const f of r.code) { const k = rel(f); (fileGroups[k] ||= []).push(g); }

const fileInfo = Object.entries(fileGroups).map(([f, gs]) => ({ f, lines: lines(path.join(ROOT, f)), groups: gs }));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "files.json"), JSON.stringify(fileInfo, null, 1));

// asset sizes
const size = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
function dirSize(d) { let s = 0; if (!isDir(d)) return 0; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); s += e.isDirectory() ? dirSize(p) : size(p); } return s; }
const assetSummary = {};
for (const [g, r] of Object.entries(results)) {
  const files = r.assets.filter((a) => !a.startsWith("MISSING:") && !a.startsWith("DIR:"));
  const dirs = r.assets.filter((a) => a.startsWith("DIR:")).map((a) => a.slice(4));
  assetSummary[g] = {
    files: files.map(rel).sort(),
    fileMB: +(files.reduce((s, f) => s + size(f), 0) / 1048576).toFixed(1),
    dirs: [...new Set(dirs)].sort(),
    dirMB: +([...new Set(dirs)].reduce((s, d) => s + dirSize(path.join(ROOT, "public", d)), 0) / 1048576).toFixed(1),
    missing: r.assets.filter((a) => a.startsWith("MISSING:")).map((a) => a.slice(8)).sort(),
    dynamic: r.dyn.sort(),
    pkgs: r.pkgs.sort(),
  };
}
fs.writeFileSync(path.join(OUT, "assets.json"), JSON.stringify(assetSummary, null, 1));

// public files referenced by the kept groups vs everything
const KEEP = ["editor", "alg-rts", "stylized-lab", "rock-lab", "apex-rush", "empty-game"];
const keptPublic = new Set();
for (const g of KEEP) {
  for (const f of assetSummary[g].files) if (f.startsWith("public/")) keptPublic.add(f);
  for (const d of assetSummary[g].dirs) keptPublic.add("DIR:public/" + d);
}
fs.writeFileSync(path.join(OUT, "keptPublic.json"), JSON.stringify([...keptPublic].sort(), null, 1));

// console summary
const sumLines = (pred) => fileInfo.filter(pred).reduce((s, x) => s + x.lines, 0);
const isLab = (g) => g.startsWith("lab:");
console.log("groups:", Object.keys(GROUPS).length, "labs:", labPages.length);
for (const g of Object.keys(GROUPS).filter((g) => !isLab(g))) {
  const r = results[g];
  console.log(g.padEnd(14), "code files", String(r.code.length).padStart(4), "| assets", assetSummary[g].fileMB, "MB files +", assetSummary[g].dirMB, "MB dirs | missing", assetSummary[g].missing.length, "| dyn", assetSummary[g].dynamic.length);
}
for (const tree of ["v2/", "v3/", "games/"]) {
  const inTree = fileInfo.filter((x) => x.f.startsWith(tree));
  const byEditor = inTree.filter((x) => x.groups.includes("editor"));
  const byKeptGame = inTree.filter((x) => !x.groups.includes("editor") && x.groups.some((g) => KEEP.includes(g)));
  const labOnly = inTree.filter((x) => x.groups.length && x.groups.every((g) => isLab(g) || !KEEP.includes(g)));
  const none = inTree.filter((x) => !x.groups.length);
  const L = (a) => a.reduce((s, x) => s + x.lines, 0);
  console.log(tree.padEnd(7), "total", inTree.length, "files", L(inTree), "lines | editor", byEditor.length, L(byEditor), "| kept-games-only", byKeptGame.length, L(byKeptGame), "| labs/dropped-only", labOnly.length, L(labOnly), "| unreached", none.length, L(none));
}
