import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRUNKS_DIR = path.join(__dirname, "public/models/trunks");

const TRUNK_NAME_OVERRIDES = {
  "customtree3_compressed.glb": "Custom Tree 3",
  "TREES6_compressed.glb": "Trees 6",
  "newtrunk_compressed.glb": "New Trunk",
  "trunk_seed2279.glb": "Seed 2279",
};

function trunkDisplayName(file) {
  if (TRUNK_NAME_OVERRIDES[file]) return TRUNK_NAME_OVERRIDES[file];
  return file
    .replace(/_compressed\.glb$/i, "")
    .replace(/\.(glb|gltf)$/i, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildTrunkManifest() {
  if (!fs.existsSync(TRUNKS_DIR)) return [];
  return fs
    .readdirSync(TRUNKS_DIR)
    .filter((f) => /\.(glb|gltf)$/i.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ file, name: trunkDisplayName(file) }));
}

function writeTrunkManifest() {
  const models = buildTrunkManifest();
  fs.mkdirSync(TRUNKS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TRUNKS_DIR, "manifest.json"),
    `${JSON.stringify(models, null, 2)}\n`,
  );
  return models;
}

function trunkManifestPlugin() {
  return {
    name: "trunk-manifest",
    configureServer(server) {
      server.middlewares.use("/models/trunks/manifest.json", (req, res, next) => {
        if (req.method !== "GET") return next();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(buildTrunkManifest()));
      });
    },
    buildStart() {
      writeTrunkManifest();
    },
  };
}

// Horse lab animation editor (dev only): POST /__horse-lab/anims?name=mount
// saves the keyed performance to v3/horse-lab/anims/<name>.json.
const HORSE_ANIMS_DIR = path.join(__dirname, "v3/horse-lab/anims");
function horseLabAnimsPlugin() {
  return {
    name: "horse-lab-anims",
    configureServer(server) {
      server.middlewares.use("/__horse-lab/anims", (req, res, next) => {
        if (req.method !== "POST") return next();
        const name = new URL(req.url, "http://x").searchParams.get("name") ?? "";
        if (!/^[a-z0-9_-]{1,40}$/i.test(name)) { res.statusCode = 400; return res.end("bad name"); }
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 2e6) req.destroy(); });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            fs.mkdirSync(HORSE_ANIMS_DIR, { recursive: true });
            fs.writeFileSync(path.join(HORSE_ANIMS_DIR, name + ".json"), `${JSON.stringify(data, null, 1)}\n`);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, file: "v3/horse-lab/anims/" + name + ".json" }));
          } catch (e) { res.statusCode = 400; res.end(String(e)); }
        });
      });
    },
  };
}

// The alg-rts lab's VERDICTS (dev only, 2026-10-25 — you judge every piece in the lab): GET /__alg-lab/verdicts reads
// games/alg-rts/labVerdicts.json; POST { key, v, note } sets one piece's (v null: cleared). The repo's record of the pass.
const ALG_VERDICTS = path.join(__dirname, "games/alg-rts/labVerdicts.json");
function algLabVerdictsPlugin() {
  return {
    name: "alg-lab-verdicts",
    configureServer(server) {
      server.middlewares.use("/__alg-lab/verdicts", (req, res, next) => {
        const read = () => (fs.existsSync(ALG_VERDICTS) ? JSON.parse(fs.readFileSync(ALG_VERDICTS, "utf8")) : {});
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        if (req.method === "GET") return res.end(JSON.stringify(read()));
        if (req.method !== "POST") return next();
        let body = "";
        req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on("end", () => {
          try {
            const { key, v, note } = JSON.parse(body);
            if (!/^[A-Za-z0-9_]{1,60}$/.test(key ?? "")) throw new Error("bad key");
            const all = read();
            if (v) all[key] = { v: String(v).slice(0, 20), note: String(note ?? "").slice(0, 500), at: new Date().toISOString().slice(0, 10) };
            else delete all[key];
            const sorted = Object.fromEntries(Object.keys(all).sort().map((k) => [k, all[k]]));
            fs.writeFileSync(ALG_VERDICTS, `${JSON.stringify(sorted, null, 1)}\n`);
            res.end(JSON.stringify(sorted));
          } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: String(e) })); }
        });
      });
    },
  };
}

// Fire-bake lab (dev only): POST /__fire-bake/save?name=fp_blast_a&w=1536&h=1536&q=92
// with raw RGBA bytes writes public/textures/fx/firepro/<name>.webp (PIL, as
// tools/bakeSixWaySmoke.mjs: q=-1 lossless); a JSON body (?name=…&json=1) writes <name>.json.
const FIRE_BAKE_DIR = path.join(__dirname, "public/textures/fx/firepro");
function fireBakePlugin() {
  return {
    name: "fire-bake",
    configureServer(server) {
      // The books are served from disk here: the folder is out of the watcher (below), and
      // Vite only serves the public files its watcher has seen — a book baked after the
      // server started came back as index.html.
      server.middlewares.use("/textures/fx/firepro", (req, res, next) => {
        const name = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
        if (req.method !== "GET" || !/^[a-z0-9_-]{1,48}\.(webp|json)$/i.test(name)) return next();
        const file = path.join(FIRE_BAKE_DIR, name);
        if (!fs.existsSync(file)) return next();
        res.setHeader("Content-Type", name.endsWith(".json") ? "application/json" : "image/webp");
        res.setHeader("Cache-Control", "no-store");
        res.end(fs.readFileSync(file));
      });
      server.middlewares.use("/__fire-bake/save", (req, res, next) => {
        if (req.method !== "POST") return next();
        const q = new URL(req.url, "http://x").searchParams;
        const name = q.get("name") ?? "";
        if (!/^[a-z0-9_-]{1,48}$/i.test(name)) { res.statusCode = 400; return res.end("bad name"); }
        const chunks = [];
        let size = 0;
        req.on("data", (c) => { chunks.push(c); size += c.length; if (size > 64e6) req.destroy(); });
        req.on("end", () => {
          try {
            fs.mkdirSync(FIRE_BAKE_DIR, { recursive: true });
            const body = Buffer.concat(chunks);
            let file;
            if (q.get("json")) {
              file = path.join(FIRE_BAKE_DIR, name + ".json");
              fs.writeFileSync(file, `${JSON.stringify(JSON.parse(body.toString("utf8")), null, 1)}\n`);
            } else {
              const w = Number(q.get("w")), h = Number(q.get("h")), quality = Number(q.get("q") ?? 92);
              if (!(w > 0 && h > 0) || body.length !== w * h * 4) throw new Error(`expected ${w}x${h} RGBA, got ${body.length} bytes`);
              const tmp = path.join(os.tmpdir(), `firebake-${process.pid}-${name}.raw`);
              fs.writeFileSync(tmp, body);
              file = path.join(FIRE_BAKE_DIR, name + ".webp");
              const py = [
                "import sys",
                "from PIL import Image",
                "w, h, src, out, q = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4], int(sys.argv[5])",
                "im = Image.frombytes('RGBA', (w, h), open(src, 'rb').read())",
                "im.save(out, 'WEBP', **({'lossless': True} if q < 0 else {'quality': q, 'method': 6, 'exact': True}))",
              ].join("\n");
              const r = spawnSync("python", ["-c", py, String(w), String(h), tmp, file, String(quality)], { encoding: "utf8" });
              fs.rmSync(tmp, { force: true });
              if (r.status !== 0) throw new Error(`python/PIL failed: ${r.stderr || r.error}`);
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, file: path.relative(__dirname, file).replace(/\\/g, "/"), bytes: fs.statSync(file).size }));
          } catch (e) { res.statusCode = 400; res.end(String(e)); }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [trunkManifestPlugin(), horseLabAnimsPlugin(), fireBakePlugin(), algLabVerdictsPlugin()],
  // The fire-bake lab writes its books there: a watched write reloaded the lab between
  // the atlases and their .json (the json went stale against the new images).
  // games/thunderline: worked on in parallel from its OWN dev server (hot reload off, port 5187, its
  // scratch config re-enables the watch there), so its edits never reload this server's pages.
  // (the lab's verdicts file: written while the lab is open — a watched write would reload it)
  server: { watch: { ignored: ["**/public/textures/fx/firepro/**", "**/games/thunderline/**", "**/games/alg-rts/labVerdicts.json"] } },
  resolve: {
    alias: [
      {
        find: /^three$/,
        replacement: "three/webgpu",
      },
    ],
  },
  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        rtsV3: "games/rts-v3/rts.html",
        namRts: "games/nam-rts/nam.html",
        algRts: "games/alg-rts/alg.html",
        algMenu: "games/alg-rts/menu.html",
        roadV3: "games/modular-road-v3/road.html",
        v3editor: "v3/editor.html",
      },
    },
  },
});
