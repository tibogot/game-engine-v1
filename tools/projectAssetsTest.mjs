// Files imported from disk are kept inside the .v3proj (v3/io/projectAssets.js +
// projectIO.js): stored once per content, written only when referenced, and
// read back byte-for-byte.
import { ProjectAssets, isAssetRef } from "../v3/io/projectAssets.js";
import { encodeProjectFile, decodeProjectFile } from "../v3/io/projectIO.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

const bytesOf = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const png = new File([bytesOf(5000, 1)], "grass_albedo.png", { type: "image/png" });
const pngCopy = new File([bytesOf(5000, 1)], "same_bytes.png", { type: "image/png" });
const glb = new File([bytesOf(12345, 7)], "rock.glb");
const unused = new File([bytesOf(900, 3)], "replaced.png");

const store = new ProjectAssets();
const texRef = await store.addRef(png);
const copyRef = await store.addRef(pngCopy);
const glbRef = await store.addRef(glb);
await store.addRef(unused);
check("a reference looks like asset:<sha1>", isAssetRef(texRef) && /^asset:[0-9a-f]{40}$/.test(texRef), texRef);
check("same bytes are stored once", texRef === copyRef && store.size === 3, `size ${store.size}`);
check("other strings pass through resolveUrl", store.resolveUrl("/textures/a.png") === "/textures/a.png");
check("an unknown asset resolves to null", store.resolveUrl(`asset:${"0".repeat(40)}`) === null);
check("the type is guessed from the name when missing", store._byHash.get(glbRef.slice(6)).type === "model/gltf-binary");

const data = {
  paintLayers: { slots: [{ albedo: { name: "grass_albedo.png", url: texRef } }] },
  props: { slots: [{ name: "rock", glbFile: "rock.glb", glbRef }] },
};
const assets = store.collectFor(data);
check("only referenced assets are written", assets.length === 2, `${assets.length}`);

const buf = await encodeProjectFile({
  terrain: { worldSize: 100, heightmapSize: 4, splatSize: 4, maxHeight: 10 },
  heightmap: new Float32Array(16).fill(2.5),
  paintLayers: data.paintLayers,
  props: data.props,
  assets,
});
const d = await decodeProjectFile(buf instanceof ArrayBuffer ? buf : buf.buffer);
check("the manifest lists the assets", d.assets?.length === 2);
check("heights still decode next to the assets", d.heightmap?.[5] === 2.5);

const loaded = new ProjectAssets();
loaded.load(d.assets);
const f = loaded.fileFor(glbRef);
const back = f ? new Uint8Array(await f.arrayBuffer()) : null;
const orig = bytesOf(12345, 7);
check("a GLB comes back byte-for-byte with its name", !!back && back.length === orig.length && back.every((v, i) => v === orig[i]) && f.name === "rock.glb");
check("the texture reference resolves after load", loaded.has(d.paintLayers.slots[0].albedo.url) && loaded.nameOf(texRef) === "grass_albedo.png");
check("the replaced texture was not carried", !loaded.has(`asset:${[...store._byHash.keys()].find((h) => store._byHash.get(h).name === "replaced.png")}`));

// load() must copy: the decoded buffer can be dropped after the load.
const entry = d.assets[0];
entry.bytes.fill(0);
const again = loaded.fileFor(`asset:${entry.hash}`);
check("loaded bytes do not alias the file buffer", new Uint8Array(await again.arrayBuffer()).some((v) => v !== 0));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
