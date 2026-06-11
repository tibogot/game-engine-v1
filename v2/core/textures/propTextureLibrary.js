/**
 * Prop texture library — PBR material catalog for primitive + GLB props.
 *
 * Separate from `textureLibrary.js` (which serves terrain paint with its custom
 * ORM+normal packing). This one stores the 4 PBR maps as plain THREE.Textures so
 * a simple `MeshStandardNodeMaterial`-style TSL material can read them directly.
 *
 * Each material owns stable Textures + TSL uniforms so a per-material control
 * (UV tile, strengths) updates every prop using that material instantly.
 *
 * Folder import (PolyHaven / AmbientCG / FreePBR conventions) — `addMaterialFromFiles`
 * classifies map kinds by filename suffix and falls back to neutral textures for
 * any missing channel.
 */
import * as THREE from "three";
import { uniform } from "three/tsl";

const _loader = new THREE.TextureLoader();

function makeTex(url, isColor) {
  const tex = _loader.load(url);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function makeTexFromFile(file, isColor) {
  const url = URL.createObjectURL(file);
  const tex = makeTex(url, isColor);
  tex.userData.objectUrl = url;
  return tex;
}

/** 1×1 RGBA DataTexture used as a neutral fallback when a map is missing from an import. */
function makeNeutralTex(r, g, b, a = 255, isColor = false) {
  const tex = new THREE.DataTexture(
    new Uint8Array([r, g, b, a]),
    1,
    1,
    THREE.RGBAFormat,
  );
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Classify a filename into 'albedo' | 'normal' | 'rough' | 'ao' | null. */
function classifyFile(filename) {
  const lower = filename.toLowerCase();
  if (!/\.(jpe?g|png|webp)$/.test(lower)) return null;
  if (/_arm[._]/.test(lower)) return null;
  if (/normaldx/.test(lower) || /_nor_?dx[._]/.test(lower)) return null;
  if (/_(disp|displacement|height)[._]/.test(lower)) return null;

  if (/_(diff|diffuse|color|basecolor|albedo)[._]/.test(lower)) return "albedo";
  if (/_(nor_?gl|normalgl|normal|nor)[._]/.test(lower)) return "normal";
  if (/_(rough|roughness)[._]/.test(lower)) return "rough";
  if (/_(ao|ambient_?occlusion|ambientocclusion|ambient)[._]/.test(lower)) return "ao";
  return null;
}

const DEFAULT_MATERIALS = [
  {
    id: "cobblestone",
    name: "Cobblestone",
    uvScale: 2.0,
    paths: {
      albedo: "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_basecolor.png",
      normal: "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_normal.png",
      rough: "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_roughness.png",
      ao: "/textures/pbr_materials/Cobblestone_Irregular_Floor_001_SD/Cobblestone_Irregular_Floor_001_ambientOcclusion.png",
    },
  },
  {
    id: "concrete_030",
    name: "Concrete 030",
    uvScale: 2.0,
    paths: {
      albedo: "/textures/pbr_materials/Concrete030_1K-JPG/Concrete030_1K-JPG_Color.jpg",
      normal: "/textures/pbr_materials/Concrete030_1K-JPG/Concrete030_1K-JPG_NormalGL.jpg",
      rough: "/textures/pbr_materials/Concrete030_1K-JPG/Concrete030_1K-JPG_Roughness.jpg",
      ao: "/textures/pbr_materials/Concrete030_1K-JPG/Concrete030_1K-JPG_AmbientOcclusion.jpg",
    },
  },
  {
    id: "ground_tiles_01",
    name: "Ground Tiles 01",
    uvScale: 2.0,
    paths: {
      albedo: "/textures/pbr_materials/ground_tiles_01_2k/ground_tiles_01_color_2k.png",
      normal: "/textures/pbr_materials/ground_tiles_01_2k/ground_tiles_01_normal_gl_2k.png",
      rough: "/textures/pbr_materials/ground_tiles_01_2k/ground_tiles_01_roughness_2k.png",
      ao: "/textures/pbr_materials/ground_tiles_01_2k/ground_tiles_01_ambient_occlusion_2k.png",
    },
  },
];

function createDefaultPbrMaterial({ id, name, uvScale = 1.0, paths }) {
  return {
    type: "pbr",
    id,
    name,
    uvScale,
    normalStrength: 1.0,
    aoStrength: 1.0,
    roughStrength: 1.0,
    paths: { ...paths },
    albedoTex: makeTex(paths.albedo, true),
    normalTex: makeTex(paths.normal, false),
    roughnessTex: makeTex(paths.rough, false),
    aoTex: makeTex(paths.ao, false),
    uUVScale: uniform(uvScale),
    uNormalStr: uniform(1.0),
    uAOStr: uniform(1.0),
    uRoughStr: uniform(1.0),
  };
}

/** Built-in non-PBR entries that live at the top of the library list. */
const BUILTIN_NONE = { type: "none", id: "__none__", name: "None" };
const BUILTIN_TILE = {
  type: "tile",
  id: "__tile__",
  name: "Tile (grid)",
  config: {
    // Tuned for unit-sized primitives. `tileMaterial` internally multiplies by 0.00125,
    // so this gives worldScale ≈ 2 → a few grid lines visible per face on a 1m cube.
    // For much larger meshes, dial this down (or expose a slider later).
    textureScale: 1600,
    tileColor: 0xe6e3e3,
    gridColor: 0x444444,
    gridLineColor: 0x111111,
    roughness: 0.95,
    metalness: 0.0,
    objectSpace: true,
  },
};

export function createPropTextureLibrary() {
  const materials = [
    BUILTIN_NONE,
    BUILTIN_TILE,
    ...DEFAULT_MATERIALS.map(createDefaultPbrMaterial),
  ];

  function syncUniforms(mat) {
    if (mat.type !== "pbr") return;
    mat.uUVScale.value = mat.uvScale;
    mat.uNormalStr.value = mat.normalStrength;
    mat.uAOStr.value = mat.aoStrength;
    mat.uRoughStr.value = mat.roughStrength;
  }
  for (const m of materials) syncUniforms(m);

  let _nextId = 1;

  /**
   * Classify a list of File objects (from `<input type="file" webkitdirectory>`),
   * create a new material from them, and return it. Returns `null` when no albedo
   * map was found. Missing normal/rough/ao channels fall back to neutral 1×1 textures.
   */
  function addMaterialFromFiles(files) {
    const picked = { albedo: null, normal: null, rough: null, ao: null };
    let folderName = null;

    for (const f of files) {
      const kind = classifyFile(f.name);
      if (!kind) continue;
      if (!picked[kind]) picked[kind] = f;
      if (!folderName && f.webkitRelativePath) {
        const head = f.webkitRelativePath.split("/")[0];
        if (head) folderName = head;
      }
    }

    if (!picked.albedo) return null;

    const name = folderName ?? picked.albedo.name.replace(/\.[^.]+$/, "");
    const id = `custom_${Date.now()}_${_nextId++}`;
    const uvScale = 2.0;

    const mat = {
      type: "pbr",
      id,
      name,
      uvScale,
      normalStrength: 1.0,
      aoStrength: 1.0,
      roughStrength: 1.0,
      paths: {
        albedo: picked.albedo?.name ?? null,
        normal: picked.normal?.name ?? null,
        rough: picked.rough?.name ?? null,
        ao: picked.ao?.name ?? null,
      },
      albedoTex: makeTexFromFile(picked.albedo, true),
      normalTex: picked.normal ? makeTexFromFile(picked.normal, false) : makeNeutralTex(128, 128, 255),
      roughnessTex: picked.rough ? makeTexFromFile(picked.rough, false) : makeNeutralTex(153, 153, 153),
      aoTex: picked.ao ? makeTexFromFile(picked.ao, false) : makeNeutralTex(255, 255, 255),
      uUVScale: uniform(uvScale),
      uNormalStr: uniform(1.0),
      uAOStr: uniform(1.0),
      uRoughStr: uniform(1.0),
    };

    materials.push(mat);
    return mat;
  }

  return {
    materials,
    getById(id) {
      return materials.find((m) => m.id === id) || null;
    },
    getByIndex(i) {
      return materials[i] || null;
    },
    /** `{ "Display Name": "id" }` map for the custom-UI `_dropdown` helper. */
    getMaterialOptionsForUi() {
      const opts = {};
      for (const m of materials) opts[m.name] = m.id;
      return opts;
    },
    addMaterialFromFiles,
    /**
     * Capture user-tweakable per-PBR-material values (uvScale, *Strength) as a plain object
     * keyed by material id — for serialization. Non-PBR entries are skipped.
     */
    snapshotOverrides() {
      const out = {};
      for (const m of materials) {
        if (m.type !== "pbr") continue;
        out[m.id] = {
          uvScale: m.uvScale,
          normalStrength: m.normalStrength,
          aoStrength: m.aoStrength,
          roughStrength: m.roughStrength,
        };
      }
      return out;
    },
    /** Apply an overrides snapshot back onto matching PBR entries. Unknown ids are skipped. */
    applyOverrides(overrides) {
      if (!overrides) return;
      for (const [id, s] of Object.entries(overrides)) {
        const m = materials.find((mm) => mm.id === id);
        if (!m || m.type !== "pbr") continue;
        if (s.uvScale != null) { m.uvScale = s.uvScale; m.uUVScale.value = s.uvScale; }
        if (s.normalStrength != null) { m.normalStrength = s.normalStrength; m.uNormalStr.value = s.normalStrength; }
        if (s.aoStrength != null) { m.aoStrength = s.aoStrength; m.uAOStr.value = s.aoStrength; }
        if (s.roughStrength != null) { m.roughStrength = s.roughStrength; m.uRoughStr.value = s.roughStrength; }
      }
    },
  };
}
