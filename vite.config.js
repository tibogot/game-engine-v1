import fs from "node:fs";
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

export default defineConfig({
  plugins: [trunkManifestPlugin(), horseLabAnimsPlugin()],
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
        editor: "v2/editor.html",
        play: "v2/play.html",
        rtsV3: "games/rts-v3/rts.html",
        namRts: "games/nam-rts/nam.html",
        algRts: "games/alg-rts/alg.html",
        roadV3: "games/modular-road-v3/road.html",
        v3editor: "v3/editor.html",
      },
    },
  },
});
