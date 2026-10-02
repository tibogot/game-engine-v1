/**
 * GROUND CACHE — the terrain's paint, baked top-down into rings that follow the
 * camera, so the terrain shader reads TWO textures instead of blending seven
 * layers on every pixel of every frame.
 *
 * WHY. The paint blend is the dearest thing on screen (alg-rts: ~70% of every
 * view) and this backend charges for every texture tap COMPILED into it, not
 * for the ones a pixel uses (splatOverlayTsl.js: 4 layers instead of 7 was
 * −1.5 ms; branches around taps saved nothing). Company of Heroes 2 and Far
 * Cry 4 (GDC 2015, "Adaptive Virtual Texture Rendering") solved the same
 * problem the same way: draw the layers AND the decals into a texture cache
 * once, and let the ground read the cache. After that the ground's cost no
 * longer depends on how many layers, splats or decals the map has — which is
 * what lets a map carry CoH's hundreds of splats.
 *
 * LAYOUT. N rings, each a RES² layer of two texture arrays (colour, and
 * normal+roughness). Ring k has texels texel0·2^k metres wide, so it covers
 * RES·texel0·2^k metres: at the defaults 2 cm → 41 m, 4 cm → 82 m … 128 cm →
 * 2.6 km. Every ring is centred near the camera's look point; a pixel reads the
 * ring whose texel matches its own footprint on the ground (and the next one
 * up, blended — trilinear filtering without mips), so the near ground is sharp
 * and the far ground costs the same four taps.
 *
 * TOROIDAL. A ring is addressed by WORLD position (uv = world / ring size,
 * repeat wrap), so a texel never moves when the ring does: when the camera
 * pans, only the tiles that come into the window are baked, into the slots of
 * the ones that left. Each ring is TILES×TILES tiles; a tile is baked into a
 * small staging target (the paint blend + every decal over it) and copied into
 * its slot. A few tiles a frame; the boot bakes everything (bakeAll).
 *
 * WHAT A PIXEL MAY READ. Each ring publishes the box of world it holds
 * CORRECTLY (all its tiles current); a pixel outside a ring's box uses the
 * next ring out, so a ring that is still catching up after a fast pan is
 * never shown — the ground is only a little softer there for a few frames.
 *
 * ENCODING (RGBA8, both arrays):
 *   colour  rgb = sqrt(albedo)  (≈ gamma 2: 8 bits are not enough for linear
 *                                darks), a = 1
 *   normal  rg  = the paint's normal-map DETAIL — its part perpendicular to
 *                 the terrain's own normal, x and z, ×0.5+0.5. The shader adds
 *                 it back onto the live terrain normal, so the lighting keeps
 *                 the heightmap's full precision and only the detail is 8-bit.
 *           b   = roughness, a = 1
 *
 * The UV conventions are WebGPU's own (three flips nothing on this backend):
 * uv (0,0) is texel row 0, QuadMesh writes uv v=0 into row 0, and a clip-space
 * y of +1 is row 0. Row r of a ring holds world z rising with r. The WebGL
 * fallback flips render targets; the cache is WebGPU-only.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn, float, int, vec2, vec3, vec4, uv, uniform, texture, attribute, varying, positionGeometry,
  normalize, sqrt, max, min, dot, clamp, smoothstep, select, floor, fract, log2, exp2,
  length, dFdx, dFdy, abs, step, cross, mix, mx_noise_float,
} from "three/tsl";
import { WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";
import { hexSample } from "./splatOverlayTsl.js";
import { grassFieldAlbedo } from "../../v2/render/hybridGrass/grassFieldColor.js";
import { flatSurface, gridSurface } from "../render/materials/gridMaterial.js";

export const GROUND_CACHE_DEFAULTS = {
  /** Rings. The last one covers RES·texel0·2^(rings−1) metres. */
  rings: 7,
  /** Texels per ring side. */
  res: 2048,
  /** Tiles per ring side (a tile is the unit of baking). */
  tiles: 8,
  /** Metres per texel of the finest ring. */
  texel0: 0.02,
  /**
   * Tiles baked per frame while catching up (each: the paint twice, the
   * splats and decals twice, the cavity once — ~65k texels a pass). Kept low:
   * a pan only exposes a row of fine tiles at a time, and a fine ring that
   * lags shows the next ring's texels, not a hole.
   */
  tilesPerFrame: 3,
  /**
   * One render pass per target and tile (paint, splats, decals and the cavity
   * finish as meshes of one scene, in renderOrder) instead of up to four. Each
   * pass is a submit of its own: MEASURED ~0.08 ms apiece on the RTS laptop,
   * and panning bakes 3 tiles a frame. false = the old pass-per-layer path
   * (kept to A/B and to compare pixels).
   */
  mergedPasses: true,
  /**
   * Metres of ground one screen pixel covers per metre of distance, used to
   * turn the near/far paint fade (set in camera metres) into a ring's texel
   * size. ~6e-4 at the RTS camera (40° lens, ~1800 px tall, 40-60° down).
   */
  footPerMetre: 6e-4,
  /**
   * Hex tiling in the paint bake (no repeat grid). false = grid tiling.
   * MEASURED 2026-10-01 (alg, same view): hex keeps 72% of the live paint's
   * fine detail at the top of the screen, grid 77% — the three blended
   * windows soften a little. Kept on: the repeat grid was the complaint.
   */
  hexBake: true,
  /**
   * DETAIL (2026-10-01; you: "CoH has nice terrain detail"). The cache holds
   * the ground at 2-8 cm a texel where you look, filtered twice (baked, then
   * read): MEASURED it keeps 72-87% of the live paint's fine detail. At draw
   * time the terrain adds back the grain of the paint layer under the pixel
   * (the bake stores which, in the normal target's alpha): that layer's photo
   * read twice — full hardware sharpness (mips + anisotropic) and blurred to
   * the cache texel — and their ratio multiplies the cache colour. Only the
   * frequencies the cache lost; ~1 where it is already sharp. 0 = off.
   */
  detail: 0,
  /** Bake far grass where grass is painted (see FAR GRASS); needs the createGroundCache farGrass input. */
  farGrass: false,
  farGrassUrl: "/textures/grassfar/rocky_terrain_02_c.webp",
  /** Metres the far-grass photo spans (Poly Haven rocky_terrain_02: 90 m). */
  farGrassSize: 90,
};

const DECAL_STRIDE = 36;

export function createGroundCache({
  renderer, splatOverlay, terrainNormals, heightTexNode = null, farTerrain = null,
  baseStyle = "flat", options = {}, splatTex = null, textureLib = null,
  // The live far-grass tint (grassFarTsl.js): its density and blade colours
  // feed the baked far grass when options.farGrass is on.
  farGrass = null,
}) {
  const O = { ...GROUND_CACHE_DEFAULTS, ...options };
  const N = O.rings, RES = O.res, T = O.tiles, TILE = RES / T;
  const texelOf = (k) => O.texel0 * 2 ** k;
  const extentOf = (k) => RES * texelOf(k);
  const tileOf = (k) => extentOf(k) / T;
  const W = WORLD_SIZE, HALF = W * 0.5;

  // ── Textures ──────────────────────────────────────────────────────────────
  const makeArray = (name) => {
    const rt = new THREE.RenderTarget(RES, RES, {
      depth: N, depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    rt.texture.wrapS = rt.texture.wrapT = THREE.RepeatWrapping;
    rt.texture.name = name;
    return rt;
  };
  const colRT = makeArray("GroundCacheColour");
  const nrmRT = makeArray("GroundCacheNormal");

  // Allocate every layer on the GPU (a copy into a texture that was never a
  // render target has nothing to land in).
  {
    const prev = renderer.getRenderTarget();
    for (const rt of [colRT, nrmRT]) {
      for (let k = 0; k < N; k++) { renderer.setRenderTarget(rt, k); renderer.clear(true, false, false); }
    }
    renderer.setRenderTarget(prev);
  }

  // ── Bake: the paint blend on a quad over one tile ───────────────────────
  // uTile = (minX, minZ, size, farFade). World position from the quad's uv.
  const uTile = uniform(new THREE.Vector4(0, 0, 1, 0));
  const edgeHeightAt = heightTexNode
    ? (x, z) => texture(heightTexNode, clamp(vec2(x.add(HALF).div(W), z.add(HALF).div(W)), 0, 1)).level(0).r.mul(MAX_HEIGHT)
    : null;

  /** The terrain's surface (world position, geometric normal) at world (x, z), as the clipmap draws it. */
  function surfaceAtXZ(x, z) {
    const mapUV = vec2(x.add(HALF).div(W), z.add(HALF).div(W));
    const inMap = step(0, mapUV.x).mul(step(mapUV.x, 1)).mul(step(0, mapUV.y)).mul(step(mapUV.y, 1));
    const surf = terrainNormals.surfaceAt(mapUV);
    let G = normalize(surf.xyz);
    let H = surf.w.mul(MAX_HEIGHT).mul(inMap);
    if (farTerrain && edgeHeightAt) {
      // Past the map's edge the clipmap stands the far grid up (farTerrain.js)
      // — the same functions, evaluated here per texel instead of per vertex.
      const out = float(1).sub(inMap).mul(farTerrain.u.uEnabled);
      const halfW = float(HALF);
      const farH = farTerrain.outsideHeight(x, z, halfW, edgeHeightAt(x, z));
      const farN = farTerrain.outsideNormal(x, z, halfW, edgeHeightAt);
      G = normalize(mix(G, farN, out));
      H = H.add(farH.mul(out));
    }
    return { P: vec3(x, H, z), G };
  }

  /*
   * CAVITY — the ground darkens in its hollows and lifts on its crests, the
   * way sky light and settled dust do. Company of Heroes' ground reads this
   * strongly (every gully and crater rim is legible from the RTS camera) and a
   * photo texture has no idea of the terrain it is laid on. The height here
   * minus the mean height on two rings around it (2.5 m and 9 m), in metres,
   * times a gain. Eight taps a texel — in the bake, so free at runtime.
   * uCavity = (gain per metre, max darkening, max lift, warmth of the hollows).
   */
  const uCavity = uniform(new THREE.Vector4(0.14, 0.38, 0.16, 0.35));
  function cavityAt(x, z, P) {
    const hAt = (dx, dz) => terrainNormals.surfaceAt(vec2(x.add(dx + HALF).div(W), z.add(dz + HALF).div(W))).w.mul(MAX_HEIGHT);
    const ring = (r) => hAt(r, 0).add(hAt(-r, 0)).add(hAt(0, r)).add(hAt(0, -r)).mul(0.25);
    const c = P.y.sub(ring(2.5)).mul(0.6).add(P.y.sub(ring(9)).mul(0.4));
    return clamp(c.mul(uCavity.x), uCavity.y.negate(), uCavity.z);
  }

  function bakeSurface() {
    const x = uTile.x.add(uv().x.mul(uTile.z));
    const z = uTile.y.add(uv().y.mul(uTile.z));
    const { P, G } = surfaceAtXZ(x, z);
    const base = baseStyle === "grid" ? gridSurface(vec2(x, z)) : flatSurface();
    const sb = splatOverlay.blend({
      baseColor: base.col, baseRough: base.rough, geomNormal: G,
      // Every layer, exactly: the bake is paid once, not per frame.
      // Top 4 of the 7 layers a texel: past that the weights are slivers
      // and the bake is ~40% cheaper for it.
      position: P, topK: 4, farFade: uTile.w,
      // No repeat grid on any layer (splatOverlayTsl hexSample): 3× the
      // layer taps, affordable only because this runs once per texel.
      hex: O.hexBake !== false,
    });
    return { sb, G, color: sb.color };
  }

  /**
   * The cavity as a colour FACTOR, applied last (the "finish" pass, multiply
   * blending) so it darkens the splats and decals in a hollow as well as the
   * paint. Hollows darken and lean warm (shade on ochre ground reads
   * red-brown, not grey); crests lift evenly.
   */
  function cavityFactor() {
    const x = uTile.x.add(uv().x.mul(uTile.z));
    const z = uTile.y.add(uv().y.mul(uTile.z));
    const { P } = surfaceAtXZ(x, z);
    const cav = cavityAt(x, z, P);
    const dark = min(cav, 0);
    const warm = vec3(1, float(1).add(dark.mul(0.18)), float(1).add(dark.mul(0.45)));
    return vec3(float(1).add(cav)).mul(mix(vec3(1), warm, uCavity.w));
  }

  /*
   * GROUND TONE — the paint's colour at a point with every layer reduced to
   * its MEAN: one splat-map tap, no layer textures. A splat is photographed in
   * its own light and soil; CoH's "colorize" sat each one on the map by hand.
   * Here a splat's colour is scaled by (ground tone / its material's mean), so
   * a pale cracked-mud photo laid on dark soil comes out as dark cracked mud.
   */
  const uLayerMeans = Array.from({ length: 7 }, () => uniform(new THREE.Vector3(0.2, 0.15, 0.1)));
  /** Each paint layer's mean colour (linear, × its tint), from the library's CPU copy. */
  let _meansVersion = -1;
  const _lin = Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  function syncLayerMeans() {
    const tex = textureLib?.albedoArrayTex, data = textureLib?._albedoData;
    if (!tex || !data) return;
    const tints = textureLib.getLayerUniforms().map((u) => u.uTint?.value);
    const key = tex.version + "|" + tints.map((t) => (t ? `${t.x ?? t.r},${t.y ?? t.g},${t.z ?? t.b}` : "")).join(";");
    if (key === _meansVersion) return;
    _meansVersion = key;
    const per = data.length / 7 / 4;
    for (let i = 0; i < 7; i++) {
      let r = 0, g = 0, b = 0, n = 0;
      const o = i * per * 4;
      for (let p = 0; p < per; p += 13) { const q = o + p * 4; r += _lin[data[q]]; g += _lin[data[q + 1]]; b += _lin[data[q + 2]]; n++; }
      const t = tints[i];
      const tr = t ? (t.x ?? t.r) : 1, tg = t ? (t.y ?? t.g) : 1, tb = t ? (t.z ?? t.b) : 1;
      // × ~0.9: the layer's AO darkens its mean a little in the real blend.
      uLayerMeans[i].value.set((r / n) * tr * 0.9, (g / n) * tg * 0.9, (b / n) * tb * 0.9);
    }
  }
  function groundToneAt(x, z) {
    const mapUV = vec2(x.add(HALF).div(W), z.add(HALF).div(W));
    const base = baseStyle === "grid" ? gridSurface(vec2(x, z)).col : flatSurface().col;
    if (!splatTex) return vec3(base);
    const inMap = step(0, mapUV.x).mul(step(mapUV.x, 1)).mul(step(0, mapUV.y)).mul(step(mapUV.y, 1));
    const t = texture(splatTex, mapUV);
    const s0 = t.depth(int(0)), s1 = t.depth(int(1));
    const w = [s0.r, s0.g, s0.b, s0.a, s1.r, s1.g, s1.b].map((v) => v.mul(inMap));
    const sum = w.reduce((a, b) => a.add(b));
    const w0 = max(float(0), float(1).sub(sum));
    let acc = vec3(base).mul(w0);
    for (let i = 0; i < 7; i++) acc = acc.add(vec3(uLayerMeans[i]).mul(w[i]));
    return acc.div(max(w0.add(sum), 1e-4));
  }

  /** Normal → the 2-channel detail the cache stores (see ENCODING). */
  const encodeDetail = (n, G) => {
    const d = n.sub(G.mul(dot(n, G)));
    return vec2(d.x, d.z).mul(0.5).add(0.5);
  };

/*
   * FAR GRASS (2026-10-01, alg-rts; you: "the tint looks like bad tiling
   * texture, not grass from far"). Past the grass blades' fade the ground used
   * to take a live tint (grassFarTsl.js): the bare ground's own photo shifted
   * green, patched with sine waves — read as a tiled texture. Here a real
   * top-down grass photo is baked into the cache where grass is painted, the
   * way Company of Heroes paints its far grass into the terrain texture:
   *   - colour: the blades' own average (grassFieldAlbedo, the live tint's
   *     uniforms) — so far grass is the blades' colour, by construction;
   *   - detail: the photo's LUMINANCE only (Poly Haven rocky_terrain_02,
   *     aerial, 90 m across — the scale this camera sees it at), hex-tiled
   *     (no repeat grid), against its own mean;
   *   - clumps: two octaves of noise (~3 m tufts, ~15 m patches), not sines;
   *   - where: the blades' density × their slope rule, on rings whose texel
   *     stands for a distance past the blades' fade (uGrassBake.x, per tile) —
   *     the near rings, under the blades, keep the bare ground.
   * Free at runtime: the cache is read anyway, and the live tint goes.
   */
  const farGrassOn = !!(farGrass && O.farGrass);
  const uGrassBake = uniform(new THREE.Vector4(0, 1, 0, 0));   // x = this tile's ring fade, y = detail strength
  let farGrassTex = null, farGrassNode = null;
  if (farGrassOn) {
    farGrassTex = new THREE.TextureLoader().load(O.farGrassUrl, () => markAllStale());
    farGrassTex.wrapS = farGrassTex.wrapT = THREE.RepeatWrapping;
    farGrassTex.colorSpace = THREE.SRGBColorSpace;
    farGrassTex.anisotropy = 8;
    farGrassNode = texture(farGrassTex);
  }
  /** { col, w }: the far-grass colour at world (x, z) and how much of it. */
  function farGrassAt(x, z, G, ground) {
    const u = farGrass.uniforms;
    const mapUV = vec2(x.add(HALF).div(W), z.add(HALF).div(W));
    const inMap = step(0, mapUV.x).mul(step(mapUV.x, 1)).mul(step(0, mapUV.y)).mul(step(mapUV.y, 1));
    const slopeK = mix(float(1), smoothstep(u.slopeMin, u.slopeMax, G.y), u.slopeOn);
    const cover = min(texture(farGrass.density, mapUV).r.mul(u.grassDensity), float(1)).mul(inMap).mul(slopeK);
    const field = grassFieldAlbedo(ground, {
      bladeCol: u.bladeCol, tipCol: u.tipCol,
      aoBase: u.aoBase, aoPower: u.aoPower, farAoMul: u.farAoMul,
      shadeVar: u.shadeVar, tintOn: u.tintOn, tintStrength: u.tintStrength, tintRootBias: u.tintRootBias,
    });
    const LUM = vec3(0.2126, 0.7152, 0.0722);
    const photo = hexSample(farGrassNode, vec2(x, z).div(O.farGrassSize), null).rgb;
    const mean = farGrassNode.sample(vec2(0.5, 0.5)).level(12).rgb;   // the 1×1 mip: the photo's mean
    const detail = clamp(dot(photo, LUM).div(max(dot(mean, LUM), 1e-3)), 0.45, 1.8);
    const tuft = mx_noise_float(vec3(x.mul(0.33), z.mul(0.33), 0.5));
    const patch = mx_noise_float(vec3(x.mul(0.067), z.mul(0.067), 3.1));
    const clump = float(1).add(tuft.mul(0.45).add(patch.mul(0.55)).mul(u.clumps));
    const col = field.mul(mix(float(1), detail, uGrassBake.y)).mul(u.gain).mul(clump);
    return { col, w: cover.mul(uGrassBake.x) };
  }

  const bakeMaterial = (which) => {
    const m = new THREE.MeshBasicNodeMaterial();
    m.toneMapped = false; m.fog = false;
    m.depthTest = m.depthWrite = false;
    m.fragmentNode = Fn(() => {
      const { sb, G, color } = bakeSurface();
      // DETAIL: which paint layer is under this texel ((idx + 1) / 8 in the
      // normal's alpha; 0 = the bare base, no grain) and how much of the texel
      // is that paint (colour alpha; splats and far grass take it down).
      let layerA = float(1);
      if (O.detail > 0) {
        const xw = uTile.x.add(uv().x.mul(uTile.z)), zw = uTile.y.add(uv().y.mul(uTile.z));
        layerA = splatOverlay.dominantLayer(vec3(xw, 0, zw)).idx.add(1).div(8);
      }
      if (farGrassOn) {
        const x = uTile.x.add(uv().x.mul(uTile.z)), z = uTile.y.add(uv().y.mul(uTile.z));
        const g = farGrassAt(x, z, G, color);
        // Grass hides the ground's bumps and is matte.
        if (which === "colour") return vec4(sqrt(max(mix(color, g.col, g.w), vec3(0))), float(1).sub(g.w));
        const n = normalize(mix(normalize(sb.nrm), G, g.w.mul(0.7)));
        return vec4(encodeDetail(n, G), clamp(mix(sb.rough, 0.95, g.w), 0, 1), layerA);
      }
      if (which === "colour") return vec4(sqrt(max(color, vec3(0))), 1);
      return vec4(encodeDetail(normalize(sb.nrm), G), clamp(sb.rough, 0, 1), layerA);
    })();
    splatOverlay.registerMaterial?.(m);
    return m;
  };
  const quadCol = new QuadMesh(bakeMaterial("colour"));
  const quadNrm = new QuadMesh(bakeMaterial("normal"));
  // The finish pass: dst × cavity. The colour is stored as sqrt, so is the
  // factor; and the blend is src·dst + dst·src = 2·src·dst with src = factor/2,
  // because a crest LIFTS (factor > 1) and a render target clamps src to 1.
  const finishMat = new THREE.MeshBasicNodeMaterial();
  finishMat.toneMapped = false; finishMat.fog = false;
  finishMat.depthTest = finishMat.depthWrite = false;
  finishMat.transparent = false;
  finishMat.blending = THREE.CustomBlending;
  finishMat.blendEquation = THREE.AddEquation;
  finishMat.blendSrc = THREE.DstColorFactor;
  finishMat.blendDst = THREE.SrcColorFactor;
  finishMat.blendSrcAlpha = THREE.ZeroFactor;
  finishMat.blendDstAlpha = THREE.OneFactor;
  finishMat.fragmentNode = Fn(() => vec4(sqrt(max(cavityFactor(), vec3(0))).mul(0.5), 1))();
  const quadFinish = new QuadMesh(finishMat);

  // The same three passes as MESHES over the tile, for the merged bake: a
  // world-space square (y = 0) whose uv runs 0..1 across the tile, so the
  // paint and finish shaders read exactly the uv the quads gave them
  // (x = minX + u·S, z = minZ + v·S), drawn by decalCam like the splats.
  const tileGeo = new THREE.BufferGeometry();
  tileGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1], 3));
  tileGeo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  tileGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const tilePosition = vec3(uTile.x.add(uv().x.mul(uTile.z)), 0, uTile.y.add(uv().y.mul(uTile.z)));
  const tileMesh = (mat, order) => {
    mat.positionNode = tilePosition;
    mat.side = THREE.DoubleSide;   // the top-down camera flips the winding (see the decals)
    const m = new THREE.Mesh(tileGeo, mat);
    m.frustumCulled = false;
    m.renderOrder = order;
    return m;
  };
  const finishPlaneMat = finishMat.clone();
  finishPlaneMat.fragmentNode = finishMat.fragmentNode;
  const tilePaint = { colour: tileMesh(bakeMaterial("colour"), 0), normal: tileMesh(bakeMaterial("normal"), 0) };
  const tileFinish = tileMesh(finishPlaneMat, 3);

  // ── Bake: decals, drawn over the tile after the paint ───────────────────
  // The decal system's own data (DecalSystem: boxes projecting along local −Y,
  // two texture arrays), rasterised top-down: each decal is the quad of its
  // box's XZ footprint, and every texel inside works out where the GROUND is
  // (the live heightmap, as DecalSystem glues its boxes) and paints what the
  // screen-space decal would have painted there.
  let decalSystem = null;
  let decalBuf = null, decalGeo = null, decalCount = 0, decalVersion = -1, decalTexVersion = -1;
  const decalMats = {};
  const decalMeshes = {};
  // Straight down over the tile being baked (bakeTile aims it), screen-up =
  // world −Z, so the top row — row 0 — is the tile's min z, as the paint quad
  // writes it (uv v = 0 → row 0 → min z).
  const decalCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  decalCam.up.set(0, 0, -1);
  const decalScene = new THREE.Scene();

  const groundYAt = (x, z) => terrainNormals.surfaceAt(vec2(x.add(HALF).div(W), z.add(HALF).div(W))).w.mul(MAX_HEIGHT);

  function buildDecalGeometry(capacity) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * DECAL_STRIDE), DECAL_STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    ["aM0", "aM1", "aM2", "aI0", "aI1", "aI2", "aP", "aC", "aE"].forEach((name, k) => {
      geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, 4, k * 4));
    });
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return { geo, buf };
  }

  function buildDecalMaterial(which, albedoTex, normalTex) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.toneMapped = false; m.fog = false;
    m.depthTest = m.depthWrite = false;
    m.transparent = false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    // The quad's winding flips once it is laid on world XZ and seen from
    // above: both sides, or every splat and decal is culled as a back face.
    m.side = THREE.DoubleSide;

    const m0 = attribute("aM0", "vec4"), m1 = attribute("aM1", "vec4"), m2 = attribute("aM2", "vec4");
    // The box's XZ footprint: centre ± half the summed |rows| of its matrix.
    const half = vec2(abs(m0.x).add(abs(m0.y)).add(abs(m0.z)), abs(m2.x).add(abs(m2.y)).add(abs(m2.z))).mul(0.5);
    const centre = vec2(m0.w, m2.w);
    const worldXZ = centre.add(positionGeometry.xy.mul(2).sub(1).mul(half));
    const vXZ = varying(worldXZ, "vGcDecalXZ");
    // Glue to the live ground, as DecalSystem does: the box moves with the
    // ground under its centre.
    const vShift = heightTexNode
      ? varying(texture(heightTexNode, vec2(m0.w.add(HALF).div(W), m2.w.add(HALF).div(W))).level(0).r.mul(MAX_HEIGHT).sub(m1.w), "vGcDecalShift")
      : float(0);
    // Clip space of the tile: x right, y = +1 at row 0 = the tile's min z.
    // Flat at y 0 under the tile camera (bakeTile): world XZ is all it needs.
    m.positionNode = vec3(worldXZ.x, 0, worldXZ.y);

    const i0 = attribute("aI0", "vec4"), i1 = attribute("aI1", "vec4"), i2 = attribute("aI2", "vec4");
    const P = attribute("aP", "vec4"), C = attribute("aC", "vec4"), E = attribute("aE", "vec4");
    const albedoNode = texture(albedoTex);
    const normalNode = texture(normalTex);
    m.userData.albedoNode = albedoNode;
    m.userData.normalNode = normalNode;

    m.fragmentNode = Fn(() => {
      const x = vXZ.x, z = vXZ.y;
      const mapUV = vec2(x.add(HALF).div(W), z.add(HALF).div(W));
      const surf = terrainNormals.surfaceAt(mapUV);
      const G = normalize(surf.xyz).toVar();
      const y = surf.w.mul(MAX_HEIGHT);
      const w4 = vec4(x, y.sub(vShift), z, 1);
      const local = vec3(dot(i0, w4), dot(i1, w4), dot(i2, w4)).toVar();
      const uvD = vec2(local.x.add(0.5), float(0.5).sub(local.z));
      const layer = int(P.x.add(0.5));
      const alb = albedoNode.sample(uvD).depth(layer);
      const axisX = normalize(vec3(m0.x, m1.x, m2.x));
      const axisY = normalize(vec3(m0.y, m1.y, m2.y));
      const inside = float(1).sub(smoothstep(0.5, 0.5001, max(max(abs(local.x), abs(local.y)), abs(local.z))));
      const edge = E.x.max(1e-3);
      const edgeFade = smoothstep(0, edge, float(0.5).sub(abs(local.x))).mul(smoothstep(0, edge, float(0.5).sub(abs(local.z))));
      const depthFade = float(1).sub(smoothstep(0.35, 0.5, abs(local.y)));
      const angle = smoothstep(P.w, P.w.add(0.15), dot(G, axisY));
      const a = alb.a.mul(P.y).mul(inside).mul(edgeFade).mul(depthFade).mul(angle);
      if (which === "colour") return vec4(sqrt(max(alb.rgb.mul(C.xyz), vec3(0))), a);
      const nTex = normalNode.sample(uvD).depth(layer).xyz.mul(2).sub(1);
      const Tn = normalize(axisX.sub(G.mul(dot(axisX, G))));
      const Bn = cross(G, Tn);
      const s = P.z;
      const n = normalize(Tn.mul(nTex.x.mul(s)).add(Bn.mul(nTex.y.mul(s))).add(G.mul(nTex.z)));
      return vec4(encodeDetail(n, G), C.w, a);
    })();
    return m;
  }

  const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _c = new THREE.Color();
  const _corner = new THREE.Vector3();
  /** Per decal: its XZ bounds, for invalidating the tiles under it. */
  let decalBounds = [];

  function syncDecals() {
    if (!decalSystem) return false;
    const texVersion = decalSystem.textures.version;
    const version = decalSystem.version ?? 0;
    if (version === decalVersion && texVersion === decalTexVersion) return false;
    const texChanged = texVersion !== decalTexVersion;
    decalVersion = version; decalTexVersion = texVersion;

    const list = [...decalSystem.decals].sort((a, b) => a.priority - b.priority || a.id - b.id);
    if (!decalGeo || list.length > decalBuf.count) {
      let cap = 256;
      while (cap < list.length) cap *= 2;
      decalGeo?.dispose();
      ({ geo: decalGeo, buf: decalBuf } = buildDecalGeometry(cap));
      for (const k of Object.keys(decalMeshes)) decalMeshes[k].geometry = decalGeo;
    }
    const layers = Math.max(1, decalSystem.textures.slots.length);
    const arr = decalBuf.array;
    decalBounds = [];
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      decalSystem.matrixOf(d, _m);
      _inv.copy(_m).invert();
      const me = _m.elements, ie = _inv.elements;
      const slot = Math.min(Math.max(0, d.slot | 0), layers - 1);
      _c.set(d.tint);
      arr.set([
        me[0], me[4], me[8], me[12], me[1], me[5], me[9], me[13], me[2], me[6], me[10], me[14],
        ie[0], ie[4], ie[8], ie[12], ie[1], ie[5], ie[9], ie[13], ie[2], ie[6], ie[10], ie[14],
        slot, d.opacity, d.normalStrength, Math.cos((d.angleFade * Math.PI) / 180),
        _c.r, _c.g, _c.b, d.roughness,
        d.edgeFade, 0, 0, 0,
      ], i * DECAL_STRIDE);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let c = 0; c < 8; c++) {
        _corner.set(c & 1 ? 0.5 : -0.5, c & 2 ? 0.5 : -0.5, c & 4 ? 0.5 : -0.5).applyMatrix4(_m);
        x0 = Math.min(x0, _corner.x); x1 = Math.max(x1, _corner.x);
        z0 = Math.min(z0, _corner.z); z1 = Math.max(z1, _corner.z);
      }
      decalBounds.push([x0, z0, x1, z1]);
    }
    decalBuf.clearUpdateRanges();
    decalBuf.addUpdateRange(0, Math.max(DECAL_STRIDE, list.length * DECAL_STRIDE));
    decalBuf.needsUpdate = true;
    decalGeo.instanceCount = list.length;
    decalCount = list.length;

    if (!decalMats.colour || texChanged) {
      for (const which of ["colour", "normal"]) {
        if (!decalMats[which]) {
          decalMats[which] = buildDecalMaterial(which, decalSystem.textures.albedo, decalSystem.textures.normal);
          decalMeshes[which] = new THREE.Mesh(decalGeo, decalMats[which]);
          decalMeshes[which].frustumCulled = false;
        } else {
          decalMats[which].userData.albedoNode.value = decalSystem.textures.albedo;
          decalMats[which].userData.normalNode.value = decalSystem.textures.normal;
        }
      }
    }
    return true;
  }

  // ── Bake: SPLATS, between the paint and the decals ──────────────────────
  /*
   * A splat is Company of Heroes' unit of ground detail: an oval patch of ONE
   * material (splatMaterials.js — cracked mud, gravel, rubble, a scorch) laid
   * over the base tiles, turned, scaled, tinted and faded. Its edge is not a
   * soft circle: the patch's falloff is pushed by the material's own HEIGHT
   * and warped by noise, so the stones of a gravel patch run out one by one
   * and cracked mud ends along its cracks.
   *
   * Instance (5 × vec4):
   *   aS0  x, z, half width, half length     (metres)
   *   aS1  cos yaw, sin yaw, material, opacity
   *   aS2  tint r, g, b, tile               (metres per material repeat)
   *   aS3  softness, height push, warp, normal strength
   *   aS4  the material's mean colour (linear), match (0 = the photo's own
   *        colour, 1 = scaled onto the ground tone — see groundToneAt)
   */
  const SPLAT_STRIDE = 20;
  let splatLib = null, splatBuf = null, splatGeo = null, splatCount = 0;
  const splatMats = {}, splatMeshes = {};
  let splatBounds = [];
  // Every splat's data (CPU). The GPU buffer holds only the splats of the
  // tile being baked — see splatsForTile.
  let splatSrc = new Float32Array(0);

  function buildSplatGeometry(capacity) {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * SPLAT_STRIDE), SPLAT_STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    ["aS0", "aS1", "aS2", "aS3", "aS4"].forEach((name, k) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(buf, 4, k * 4)));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    return { geo, buf };
  }

  function buildSplatMaterial(which) {
    const m = new THREE.MeshBasicNodeMaterial();
    m.toneMapped = false; m.fog = false;
    m.depthTest = m.depthWrite = false;
    m.transparent = false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    // Colour: the splat takes the texel from the paint under it (DETAIL reads
    // dst alpha as "how much paint"); normal: alpha (the layer) kept.
    m.blendDstAlpha = which === "colour" ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor;
    m.side = THREE.DoubleSide;   // see the decal material

    const s0 = attribute("aS0", "vec4"), s1 = attribute("aS1", "vec4");
    const s2 = attribute("aS2", "vec4"), s3 = attribute("aS3", "vec4"), s4 = attribute("aS4", "vec4");
    const corner = positionGeometry.xy;                    // −1..1
    const lx = corner.x.mul(s0.z), lz = corner.y.mul(s0.w);
    const wx = s0.x.add(lx.mul(s1.x)).sub(lz.mul(s1.y));
    const wz = s0.y.add(lx.mul(s1.y)).add(lz.mul(s1.x));
    const vLocal = varying(corner, "vGcSplatLocal");
    const vW = varying(vec2(wx, wz), "vGcSplatW");
    m.positionNode = vec3(wx, 0, wz);

    const albedoNode = texture(splatLib.albedo);
    const surfaceNode = texture(splatLib.surface);
    m.userData.albedoNode = albedoNode;
    m.userData.surfaceNode = surfaceNode;

    m.fragmentNode = Fn(() => {
      const c = s1.x, s = s1.y;
      const layer = int(s1.z.add(0.5));
      const tile = max(s2.w, 0.05);
      // The material turns with the splat, and every splat starts somewhere
      // else in it (its centre is the offset), so two never repeat.
      // RUT STRIP mode (warp < 0; 2026-10-02, alg-rts's pistes — CoH lays
      // roads as splines): a chain of strips down a road draws PROCEDURAL
      // wheel ruts — two (sometimes four: another vehicle's) packed grooves
      // that wander, narrow and widen, fade out and come back along the road.
      // Only the ruts draw (alpha), the road's own paint stays between them.
      //   s3.x rut width (m) · s3.y arc length at the strip's centre (m: the
      //   noise runs continuously from strip to strip) · −s3.z wander (m).
      // The material is sampled in WORLD axes (strips overlap seamlessly).
      const strip = s3.z.lessThan(0);
      const along = vW.y.mul(c).sub(vW.x.mul(s)).div(tile);
      const u = select(strip, vW.x.div(tile), vW.x.mul(c).add(vW.y.mul(s)).div(tile).add(s0.x.mul(0.137)));
      const v = select(strip, vW.y.div(tile), along.add(s0.y.mul(0.211)));
      const muv = vec2(u, v).toVar();
      const arc = s3.y.add(vLocal.y.mul(s0.w));
      const acrossM = vLocal.x.mul(s0.z);
      const nz1 = (f, k) => mx_noise_float(vec3(arc.mul(f), float(k), float(k * 1.7)));
      const wanderM = s3.z.negate();
      const off1 = nz1(0.013, 1.3).mul(wanderM).add(nz1(0.045, 2.1).mul(wanderM.mul(0.55))).add(nz1(0.16, 8.2).mul(wanderM.mul(0.12)));
      const off2 = off1.add(0.4).add(nz1(0.034, 7.0).mul(wanderM.mul(0.7)));
      const gauge = float(0.8).add(nz1(0.05, 3.3).mul(0.06));
      const pres1 = smoothstep(-0.5, -0.15, nz1(0.012, 4.4));
      const pres2 = smoothstep(0.05, 0.35, nz1(0.015, 9.1)).mul(0.65);
      const hwL = s3.x.mul(nz1(0.17, 5.5).mul(0.35).add(0.85)), hwR = s3.x.mul(nz1(0.17, 6.6).mul(0.35).add(0.85));
      // One groove's profile at distance d (m) from its axis: a flat-ish floor
      // easing up to the verge (no kink: a kink lights as a hard line, a rail)
      // and a low berm of pushed-out soil beside it.
      const groove = (d, hw) => {
        const dd = d.div(hw);
        return vec2(float(1).sub(smoothstep(0.25, 1.25, dd)), smoothstep(0.9, 1.4, dd).mul(float(1).sub(smoothstep(1.4, 2.3, dd))));
      };
      const rutsAt = (x) => {
        const g = groove(abs(x.sub(off1).add(gauge)), hwL).max(groove(abs(x.sub(off1).sub(gauge)), hwR)).mul(pres1);
        const g2 = groove(abs(x.sub(off2).add(gauge)), hwR).max(groove(abs(x.sub(off2).sub(gauge)), hwL)).mul(pres2);
        return g.max(g2);                                   // x = depth 0..1, y = berm 0..1
      };
      const rg = rutsAt(acrossM).toVar();
      const rSlope = rutsAt(acrossM.add(0.04)).sub(rutsAt(acrossM.sub(0.04))).toVar();   // d(berm − depth)/dx · 0.08
      const alb = albedoNode.sample(muv).depth(layer).toVar();
      // The outline: two octaves of noise, the coarse one in the splat's OWN
      // frame (so every splat, big or small, gets a lobed shape of its own)
      // and a fine one at a fixed ~1 m in the world (a ragged margin).
      const seed = s0.x.mul(0.0173).add(s0.y.mul(0.0291));
      const coarse = mx_noise_float(vec3(vLocal.x.mul(1.1), vLocal.y.mul(1.1), seed));
      const fine = mx_noise_float(vec3(vW.x.mul(0.8), vW.y.mul(0.8), seed.add(3.7)));
      const r = length(vLocal).add(coarse.mul(1.4).add(fine.mul(0.5)).mul(s3.z));
      const body = float(1).sub(r);
      // Holes: a patch of gravel or mud is never solid all the way through.
      const holes = mx_noise_float(vec3(vW.x.mul(0.35), vW.y.mul(0.35), seed.mul(2).add(9.1)));
      const interior = smoothstep(-0.55, 0.15, holes.add(body.mul(0.9)));
      let a = smoothstep(0, max(s3.x, 0.02), body.mul(1.2).add(alb.a.sub(0.5).mul(s3.y))).mul(interior).mul(s1.w);
      // A rut strip: the grooves and their berms only, broken by the world
      // noise (a rut is never one clean line), soft ends to overlap the next.
      const ends = smoothstep(0, 0.3, float(1).sub(abs(vLocal.y))).mul(float(1).sub(smoothstep(0.85, 1, abs(vLocal.x))));
      const rutA = smoothstep(0, 0.35, rg.x.add(rg.y.mul(0.5))).mul(fine.mul(0.7).add(0.8).clamp(0, 1));
      a = select(strip, rutA.mul(ends).mul(s1.w), a);
      // No splat inside painted GRASS (FAR GRASS): a patch of mud baked over a
      // meadow read as a tan hole in it. Everywhere, not only far, or splats
      // would vanish at the far-grass rings — a pop of their own.
      if (farGrassOn) {
        const gUV = vec2(vW.x.add(HALF).div(W), vW.y.add(HALF).div(W));
        a = a.mul(float(1).sub(min(texture(farGrass.density, gUV).r.mul(farGrass.uniforms.grassDensity), float(1))));
      }
      if (which === "colour") {
        const tone = groundToneAt(vW.x, vW.y);
        const ratio = mix(vec3(1), tone.div(max(s4.xyz, vec3(1e-3))), s4.w);
        // A rut's floor is fine packed dust (the material smoothed to its
        // mean); its berm loose, a little darker.
        const rutCol = mix(alb.rgb, s4.xyz, rg.x.mul(0.85)).mul(rg.x.mul(0.2).add(1).sub(rg.y.mul(0.15)));
        return vec4(sqrt(max(select(strip, rutCol, alb.rgb).mul(s2.xyz).mul(ratio), vec3(0))), a);
      }
      const sf = surfaceNode.sample(muv).depth(layer);
      const G = normalize(terrainNormals.surfaceAt(vec2(vW.x.add(HALF).div(W), vW.y.add(HALF).div(W))).xyz).toVar();
      // A rut: the material's relief smoothed on the packed floor, plus the
      // groove's own walls (~5 cm deep) across the strip.
      const smooth = select(strip, float(1).sub(rg.x.mul(0.7)), float(1));
      const wall = select(strip, rSlope.x.sub(rSlope.y.mul(0.3)).mul(0.625), float(0));
      const nx = sf.r.mul(2).sub(1).mul(s3.w).mul(smooth).add(wall.mul(s3.w)), ny = sf.g.mul(2).sub(1).mul(s3.w).mul(smooth);
      const nz = sqrt(max(float(0), float(1).sub(nx.mul(nx)).sub(ny.mul(ny))));
      const Tn = normalize(vec3(c, 0, s).sub(G.mul(dot(vec3(c, 0, s), G))));
      const Bn = cross(Tn, G);
      const n = normalize(Tn.mul(nx).add(Bn.mul(ny)).add(G.mul(nz)));
      return vec4(encodeDetail(n, G), select(strip, sf.b.mul(float(1).sub(rg.x.mul(0.6))), sf.b), a);
    })();
    return m;
  }

  /**
   * The splats, as plain objects:
   *   { x, z, w, l, yaw, mat, opacity=1, tint=[1,1,1], tile=3, soft=0.35,
   *     push=0.6, warp=0.25, normal=1 }
   * w and l are the FULL width and length in metres; mat is a material index
   * into the library handed to setSplatMaterials. Drawn in list order.
   * A RUT STRIP has warp < 0 (−warp = wander, m), soft = rut width (m) and
   * arc = the road's length at its centre (m); see the splat fragment.
   */
  function setSplats(list) {
    if (!splatGeo || list.length > splatBuf.count) {
      let cap = 1024;
      while (cap < list.length) cap *= 2;
      splatGeo?.dispose();
      ({ geo: splatGeo, buf: splatBuf } = buildSplatGeometry(cap));
      for (const k of Object.keys(splatMeshes)) splatMeshes[k].geometry = splatGeo;
    }
    splatSrc = new Float32Array(list.length * SPLAT_STRIDE);
    const arr = splatSrc;
    splatBounds = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const c = Math.cos(p.yaw ?? 0), s = Math.sin(p.yaw ?? 0);
      const t = p.tint ?? [1, 1, 1];
      const mean = splatLib?.means?.[p.mat | 0] ?? [0.2, 0.2, 0.2];
      arr.set([
        p.x, p.z, p.w * 0.5, p.l * 0.5,
        c, s, p.mat | 0, p.opacity ?? 1,
        t[0], t[1], t[2], p.tile ?? 3,
        p.soft ?? 0.35, (p.warp ?? 0.25) < 0 ? (p.arc ?? 0) : (p.push ?? 0.6), p.warp ?? 0.25, p.normal ?? 1,
        mean[0], mean[1], mean[2], p.match ?? 0.8,
      ], i * SPLAT_STRIDE);
      const r = Math.hypot(p.w, p.l) * 0.5;
      splatBounds.push([p.x - r, p.z - r, p.x + r, p.z + r]);
    }
    splatGeo.instanceCount = 0;
    splatCount = list.length;
    ensureSplatMeshes();
    markAllStale();
  }

  function ensureSplatMeshes() {
    if (!splatLib || !splatGeo) return;
    for (const which of ["colour", "normal"]) {
      if (!splatMats[which]) {
        splatMats[which] = buildSplatMaterial(which);
        splatMeshes[which] = new THREE.Mesh(splatGeo, splatMats[which]);
        splatMeshes[which].frustumCulled = false;
      } else {
        splatMats[which].userData.albedoNode.value = splatLib.albedo;
        splatMats[which].userData.surfaceNode.value = splatLib.surface;
      }
    }
  }

  /** The material library (splatMaterials.js loadSplatMaterials). */
  function setSplatMaterials(lib) {
    splatLib = lib;
    ensureSplatMeshes();
    markAllStale();
  }

  // ── Rings ─────────────────────────────────────────────────────────────────
  const EMPTY = new THREE.Vector4(1e9, 1e9, -1e9, -1e9);
  const rings = [];
  for (let k = 0; k < N; k++) {
    rings.push({
      k, S: tileOf(k),
      ox: null, oz: null,                          // target window origin (tile coords)
      slotTX: new Int32Array(T * T).fill(0x7fffffff),
      slotTZ: new Int32Array(T * T).fill(0x7fffffff),
      slotStale: new Uint8Array(T * T),
      uBox: uniform(EMPTY.clone()),
    });
  }
  const mod = (a, n) => ((a % n) + n) % n;
  const slotOf = (tx, tz) => mod(tx, T) + mod(tz, T) * T;

  // Near/far paint fade per ring (splatOverlay's uFarStart/uFarEnd are camera
  // metres; a ring's texel stands for the distance whose pixel it matches).
  function farFadeFor(k) {
    const d = texelOf(k) / O.footPerMetre;
    const a = splatOverlay.uFarStart.value, b = splatOverlay.uFarEnd.value;
    const t = Math.min(1, Math.max(0, (d - a) / Math.max(1e-3, b - a)));
    return t * t * (3 - 2 * t);
  }

  /**
   * PER-TILE SPLATS (2026-10-01): copy into the GPU buffer only the splats
   * whose quad overlaps this tile, in LIST ORDER (overlapping splats layer in
   * the order they were laid). Every tile used to draw all ~4200: MEASURED
   * 0.28 ms of a 0.78 ms tile bake on a 5 m tile that a handful touch, ~0.85
   * ms a frame while panning (3 tiles). queue.writeBuffer is ordered before
   * each later submit, so one buffer serves the tiles baked in one frame.
   * Returns how many.
   */
  function splatsForTile(x0, z0, x1, z1) {
    const arr = splatBuf.array;
    let n = 0;
    for (let i = 0; i < splatCount; i++) {
      const b = splatBounds[i];
      if (b[2] < x0 || b[0] > x1 || b[3] < z0 || b[1] > z1) continue;
      arr.set(splatSrc.subarray(i * SPLAT_STRIDE, (i + 1) * SPLAT_STRIDE), n * SPLAT_STRIDE);
      n++;
    }
    if (n) {
      splatBuf.clearUpdateRanges();
      splatBuf.addUpdateRange(0, n * SPLAT_STRIDE);
      splatBuf.needsUpdate = true;
    }
    splatGeo.instanceCount = n;
    return n;
  }

  // A ring stands for the distance whose pixel its texel matches (see
  // farFadeFor): far grass on the rings past the blades' fade band.
  function grassFadeFor(k) {
    const d = texelOf(k) / O.footPerMetre;
    const a = farGrass.uniforms.fadeStart.value, b = farGrass.uniforms.fadeEnd.value;
    const t = Math.min(1, Math.max(0, (d - a) / Math.max(1e-3, b - a)));
    return t * t * (3 - 2 * t);
  }

  function bakeTile(ring, tx, tz) {
    const S = ring.S;
    uTile.value.set(tx * S, tz * S, S, farFadeFor(ring.k));
    if (farGrassOn) uGrassBake.value.x = grassFadeFor(ring.k);
    const cx = (tx + 0.5) * S, cz = (tz + 0.5) * S;
    decalCam.left = -S / 2; decalCam.right = S / 2; decalCam.top = S / 2; decalCam.bottom = -S / 2;
    decalCam.position.set(cx, 10000, cz);
    decalCam.lookAt(cx, 0, cz);
    decalCam.updateProjectionMatrix();
    decalCam.updateMatrixWorld(true);
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    // STRAIGHT INTO THE RING's layer, through a viewport on the tile's slot
    // (WebGPU's viewport is top-left: row y = the tile's min z, as sampled).
    // It used to go through a staging target and two copyTextureToTexture —
    // each copy its own command submit, 20 a frame while panning.
    const vx = mod(tx, T) * TILE, vy = mod(tz, T) * TILE;
    const nSplats = splatCount > 0 ? splatsForTile(tx * S, tz * S, (tx + 1) * S, (tz + 1) * S) : 0;
    if (O.mergedPasses) {
      // ONE pass per target: paint (0) → splats (1) → decals (2) → finish (3).
      for (const [rt, which] of [[colRT, "colour"], [nrmRT, "normal"]]) {
        rt.viewport.set(vx, vy, TILE, TILE);
        renderer.setRenderTarget(rt, ring.k);
        const parts = [tilePaint[which]];
        if (nSplats > 0 && splatMeshes[which]) { splatMeshes[which].renderOrder = 1; parts.push(splatMeshes[which]); }
        if (decalCount > 0 && decalMeshes[which]) { decalMeshes[which].renderOrder = 2; parts.push(decalMeshes[which]); }
        if (which === "colour") parts.push(tileFinish);
        for (const p of parts) decalScene.add(p);
        renderer.render(decalScene, decalCam);
        for (const p of parts) decalScene.remove(p);
      }
    } else for (const [rt, quad, which] of [[colRT, quadCol, "colour"], [nrmRT, quadNrm, "normal"]]) {
      rt.viewport.set(vx, vy, TILE, TILE);
      renderer.setRenderTarget(rt, ring.k);
      quad.render(renderer);
      if (nSplats > 0 && splatMeshes[which]) {
        decalScene.add(splatMeshes[which]);
        renderer.render(decalScene, decalCam);
        decalScene.remove(splatMeshes[which]);
      }
      if (decalCount > 0 && decalMeshes[which]) {
        decalScene.add(decalMeshes[which]);
        renderer.render(decalScene, decalCam);
        decalScene.remove(decalMeshes[which]);
      }
      if (which === "colour") quadFinish.render(renderer);
    }
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    const s = slotOf(tx, tz);
    ring.slotTX[s] = tx; ring.slotTZ[s] = tz; ring.slotStale[s] = 0;
    stats.tilesBaked++;
  }

  /**
   * The largest box of the ring's current window whose tiles are all baked and
   * which contains the tile under the ring's centre — what a pixel may read.
   * 8×8 tiles: every box is tried through a prefix sum (≤ 1296 boxes).
   */
  const _ok = new Int32Array((T + 1) * (T + 1));
  function updateValidBox(ring) {
    if (ring.ox === null) { ring.uBox.value.copy(EMPTY); return; }
    const P = T + 1;
    _ok.fill(0);
    let all = true;
    for (let j = 0; j < T; j++) {
      for (let i = 0; i < T; i++) {
        const tx = ring.ox + i, tz = ring.oz + j, s = slotOf(tx, tz);
        const good = ring.slotTX[s] === tx && ring.slotTZ[s] === tz ? 1 : 0;
        if (!good) all = false;
        _ok[(j + 1) * P + (i + 1)] = good + _ok[j * P + (i + 1)] + _ok[(j + 1) * P + i] - _ok[j * P + i];
      }
    }
    const S = ring.S;
    if (all) {
      ring.uBox.value.set(ring.ox * S, ring.oz * S, (ring.ox + T) * S, (ring.oz + T) * S);
      return;
    }
    const ci = T / 2 - 1, cj = T / 2 - 1;   // a centre tile (the window is centred on the look point)
    let best = 0, bb = null;
    for (let i0 = 0; i0 <= ci; i0++) for (let i1 = ci + 1; i1 <= T; i1++) {
      for (let j0 = 0; j0 <= cj; j0++) for (let j1 = cj + 1; j1 <= T; j1++) {
        const area = (i1 - i0) * (j1 - j0);
        if (area <= best) continue;
        const sum = _ok[j1 * P + i1] - _ok[j0 * P + i1] - _ok[j1 * P + i0] + _ok[j0 * P + i0];
        if (sum === area) { best = area; bb = [i0, j0, i1, j1]; }
      }
    }
    if (!bb) { ring.uBox.value.copy(EMPTY); return; }
    ring.uBox.value.set((ring.ox + bb[0]) * S, (ring.oz + bb[1]) * S, (ring.ox + bb[2]) * S, (ring.oz + bb[3]) * S);
  }

  // ── What changes the paint: a key of every input's values ────────────────
  const _key = [];
  const _pushVal = (v) => {
    if (v == null) return;
    if (typeof v === "number" || typeof v === "boolean") _key.push(+v);
    else if (v.isVector2) _key.push(v.x, v.y);
    else if (v.isVector3) _key.push(v.x, v.y, v.z);
    else if (v.isVector4) _key.push(v.x, v.y, v.z, v.w);
    else if (v.isColor) _key.push(v.r, v.g, v.b);
    else if (v.isTexture) _key.push(v.id, v.version);
  };
  const _pushUniforms = (obj) => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const u = obj[k];
      if (u && typeof u === "object" && "value" in u && u.isNode) _pushVal(u.value);
    }
  };
  let _prevKey = null;
  const keySources = { heightVersion: 0, textures: [], uniformObjects: [] };
  function lookChanged(heightVersion) {
    syncLayerMeans();
    _key.length = 0;
    _key.push(heightVersion);
    for (const t of keySources.textures) _pushVal(typeof t === "function" ? t() : t);
    for (const o of keySources.uniformObjects) _pushUniforms(typeof o === "function" ? o() : o);
    _pushVal(uCavity.value);
    _pushUniforms(splatOverlay);
    _pushUniforms(splatOverlay.auto);
    _pushUniforms(splatOverlay.cliffRock);
    if (farTerrain) { _pushUniforms(farTerrain.u); _pushVal(farTerrain.tex); }
    if (farGrassOn) {
      // NOT the whole uniform set: its anchor follows the camera every frame.
      const u = farGrass.uniforms;
      for (const k of ["bladeCol", "tipCol", "aoBase", "aoPower", "farAoMul", "shadeVar", "tintOn", "tintStrength", "tintRootBias", "slopeOn", "slopeMin", "slopeMax", "grassDensity", "gain", "clumps", "fadeStart", "fadeEnd"]) _pushVal(u[k]?.value);
      _pushVal(farGrass.density.value);
      _pushVal(farGrassTex);
      _pushVal(uGrassBake.value.y);
    }
    let changed = !_prevKey || _prevKey.length !== _key.length;
    if (!changed) for (let i = 0; i < _key.length; i++) if (_key[i] !== _prevKey[i]) { changed = true; break; }
    if (changed) _prevKey = _key.slice();
    return changed;
  }

  function markAllStale() {
    for (const r of rings) r.slotStale.fill(1);
  }

  // ── Per frame ─────────────────────────────────────────────────────────────
  const stats = { tilesBaked: 0, pending: 0, lastFrameTiles: 0 };
  const _ray = new THREE.Vector3(), _centre = new THREE.Vector2();
  let enabled = true;
  let getGroundY = null;   // (x, z) → metres, for the look point
  let getFocus = null;     // () → {x, z}: a game camera's own focus, when it has one
  let getHeightVersion = () => 0;   // bumps on every heightmap write

  /**
   * The ground point the camera looks at — and ONLY that. It used to be pulled
   * a third of the way toward the camera, so turning (Q/E) or zooming swept it
   * round a circle tens of metres wide and re-baked whole rings with nothing
   * moving on the ground: the frame dropped every time the camera turned.
   */
  function lookPoint(camera) {
    if (getFocus) { const f = getFocus(); if (f) return _centre.set(f.x, f.z); }
    camera.getWorldDirection(_ray);
    const p = camera.position;
    const gy = getGroundY ? getGroundY(p.x, p.z) : 0;
    let x = p.x, z = p.z;
    if (_ray.y < -0.05) {
      const t = (p.y - gy) / -_ray.y;
      x = p.x + _ray.x * t; z = p.z + _ray.z * t;
    }
    return _centre.set(x, z);
  }

  function retarget(camera) {
    const c = lookPoint(camera);
    for (const r of rings) {
      const S = r.S;
      if (r.ox === null
        || Math.abs(c.x - (r.ox + T / 2) * S) > S * 0.75
        || Math.abs(c.y - (r.oz + T / 2) * S) > S * 0.75) {
        r.ox = Math.round(c.x / S) - T / 2;
        r.oz = Math.round(c.y / S) - T / 2;
      }
    }
    return c;
  }

  /** Every tile of every ring that is missing or stale, nearest to the look point first. */
  function pendingTiles(c) {
    const out = [];
    for (const r of rings) {
      const S = r.S;
      for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
        const tx = r.ox + i, tz = r.oz + j, s = slotOf(tx, tz);
        const missing = r.slotTX[s] !== tx || r.slotTZ[s] !== tz;
        if (!missing && !r.slotStale[s]) continue;
        const dx = (tx + 0.5) * S - c.x, dz = (tz + 0.5) * S - c.y;
        // Missing tiles first (they gate what may be read) and COARSE rings
        // first among them: a missing coarse tile shows bare base colour, a
        // missing fine one only the next ring's softer texels. Then stale
        // tiles, nearest first.
        const d = Math.hypot(dx, dz) / S;
        out.push({ r, tx, tz, pri: missing ? (N - r.k) * 1000 + d : 1e7 + d * S });
      }
    }
    out.sort((a, b) => a.pri - b.pri);
    return out;
  }

  function update(camera, heightVersion = getHeightVersion()) {
    if (!enabled) return;
    if (syncDecals()) markAllStale();
    if (lookChanged(heightVersion)) markAllStale();
    const c = retarget(camera);
    const todo = pendingTiles(c);
    const n = Math.min(todo.length, O.tilesPerFrame);
    for (let i = 0; i < n; i++) bakeTile(todo[i].r, todo[i].tx, todo[i].tz);
    stats.lastFrameTiles = n;
    stats.pending = todo.length - n;
    for (const r of rings) updateValidBox(r);
  }

  /**
   * Bake everything the current view needs, now (the boot, under a loading
   * screen). Returns a promise: ~450 tiles × 7 draws each take a GPU timestamp
   * query while the renderer tracks them, and the pool (drained once a frame by
   * the loop) overflowed and warned at boot. Its drain is a GPU readback, so it
   * can only empty the pool if we WAIT for it — every 32 tiles.
   */
  async function bakeAll(camera, heightVersion = getHeightVersion()) {
    syncDecals();
    lookChanged(heightVersion);
    const c = retarget(camera);
    const track = !!renderer.backend?.trackTimestamp;
    let n = 0;
    for (const t of pendingTiles(c)) {
      bakeTile(t.r, t.tx, t.tz);
      if (track && (++n % 32) === 0) await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER);
    }
    stats.pending = 0;
    for (const r of rings) updateValidBox(r);
  }

  // ── The terrain's read ────────────────────────────────────────────────────
  const colNode = texture(colRT.texture);
  const nrmNode = texture(nrmRT.texture);
  const uLodBias = uniform(0);
  /** DETAIL strength (0..1+), live. */
  const uDetail = uniform(O.detail);
  // The paint layers' albedo array (mips + anisotropic, as the live blend reads it).
  const detailArr = O.detail > 0 && textureLib?.albedoArrayTex ? texture(textureLib.albedoArrayTex) : null;
  const detailRes = textureLib?.albedoArrayTex?.image?.width ?? 1024;
  /** A per-layer uniform picked by a dynamic layer index (select chain). */
  const pickSlot = (li, get) => {
    const slots = textureLib.getLayerUniforms();
    let acc = get(slots[slots.length - 1]);
    for (let i = slots.length - 2; i >= 0; i--) acc = select(li.equal(i), get(slots[i]), acc);
    return acc;
  };
  const uDebug = uniform(0);

  /**
   * The cached surface at world XZ `p` over geometric normal `G` (TSL, call at
   * the top level of a fragment Fn — it takes screen derivatives).
   * Returns { col, rough, nrm, covered }: covered is 0 where no ring holds the
   * pixel (the caller keeps its own base there).
   */
  function sample(p, G) {
    const pv = vec2(p).toVar();
    const foot = max(length(dFdx(pv)), length(dFdy(pv))).max(1e-6).toVar();
    const lodF = clamp(log2(foot.div(O.texel0)).add(uLodBias), 0, N - 1).toVar();
    const want = floor(lodF).toVar();
    const edges = [];
    for (let k = 0; k < N; k++) {
      const b = rings[k].uBox;
      const m = texelOf(k) * 1.5;
      edges.push(min(min(pv.x.sub(b.x), b.z.sub(pv.x)), min(pv.y.sub(b.y), b.w.sub(pv.y))).sub(m).toVar());
    }
    let a = float(N);
    for (let k = N - 1; k >= 0; k--) a = select(edges[k].greaterThan(0).and(want.lessThanEqual(k)), float(k), a);
    a = a.toVar();
    let b = float(N);
    for (let k = N - 1; k >= 0; k--) b = select(edges[k].greaterThan(0).and(a.lessThan(k)), float(k), b);
    b = b.toVar();
    const pick = (arr, idx) => {
      let acc = arr[N - 1];
      for (let k = N - 2; k >= 0; k--) acc = select(idx.equal(k), arr[k], acc);
      return acc;
    };
    const edgeA = pick(edges, a);
    const fadeW = float(0.06 * extentOf(0)).mul(exp2(min(a, N - 1)));
    const edgeT = float(1).sub(smoothstep(0, fadeW, edgeA));
    const hasB = b.lessThan(N);
    const frac = select(a.equal(want), fract(lodF), float(0));
    const tB = select(hasB, max(frac, edgeT), float(0)).toVar();
    const covered = select(a.lessThan(N), select(hasB, float(1), float(1).sub(edgeT)), float(0)).toVar();

    const ia = min(a, N - 1), ib = min(b, N - 1);
    const uvA = pv.div(float(extentOf(0)).mul(exp2(ia)));
    const uvB = pv.div(float(extentOf(0)).mul(exp2(ib)));
    const cA = colNode.sample(uvA).depth(int(ia));
    const cB = colNode.sample(uvB).depth(int(ib));
    const nA = nrmNode.sample(uvA).depth(int(ia));
    const nB = nrmNode.sample(uvB).depth(int(ib));
    const c = mix(cA, cB, tB).toVar();
    const n = mix(nA, nB, tB).toVar();

    let col = c.rgb.mul(c.rgb);
    if (O.detail > 0 && detailArr) {
      // DETAIL (see the option): ring A's layer and paint fraction (a blend of
      // two rings' layer ids would be a third, wrong layer).
      const idx = nA.a.mul(8).round().sub(1).toVar();
      const has = idx.greaterThanEqual(0);
      const li = int(max(idx, 0));
      const scale = pickSlot(li, (s) => s.uUVScale);
      const uvL = pv.mul(1 / W).mul(scale);
      // Metres a photo texel covers (the layer repeats every W / scale m),
      // against the cache texel of ring A: the level the cache already holds.
      const photoTexel = float(W).div(scale).div(detailRes);
      const lc = max(log2(float(O.texel0).mul(exp2(ia)).div(photoTexel)).add(0.5), 0);
      const LUM = vec3(0.2126, 0.7152, 0.0722);
      const hi = dot(detailArr.sample(uvL).depth(li).rgb, LUM);
      const lo = dot(detailArr.sample(uvL).level(lc).depth(li).rgb, LUM);
      const grain = clamp(hi.div(max(lo, 1e-3)), 0.5, 1.7);
      const k = select(has, cA.a.mul(uDetail), float(0));
      col = col.mul(mix(float(1), grain, k));
    }
    // Debug (uDebug 1): tint each ring — which ring a pixel reads.
    const TINTS = [[1, 0.3, 0.3], [0.3, 1, 0.3], [0.3, 0.3, 1], [1, 1, 0.3], [1, 0.3, 1], [0.3, 1, 1], [0.6, 0.6, 0.6]];
    const tintOf = (c) => {
      let acc = float(TINTS[TINTS.length - 1][c]);
      for (let k = Math.min(N, TINTS.length) - 2; k >= 0; k--) acc = select(ia.equal(k), float(TINTS[k][c]), acc);
      return acc;
    };
    col = mix(col, col.mul(vec3(tintOf(0), tintOf(1), tintOf(2))), uDebug);

    const G3 = vec3(G);
    const dx = n.r.mul(2).sub(1), dz = n.g.mul(2).sub(1);
    const dy = dx.mul(G3.x).add(dz.mul(G3.z)).negate().div(max(G3.y, 0.2));
    const d = vec3(dx, dy, dz);
    const nrm = normalize(d.add(G3.mul(sqrt(max(float(0), float(1).sub(dot(d, d)))))));
    return { col, rough: n.b, nrm, covered };
  }

  return {
    sample,
    update,
    bakeAll,
    markAllStale,
    stats,
    rings,
    options: O,
    uLodBias,
    uDetail,
    uDebug,
    colourTexture: colRT.texture,
    normalTexture: nrmRT.texture,
    /** Decals are drawn into the cache from here on (the system's own draw is the caller's to switch off). */
    setSplats,
    setSplatMaterials,
    /** Internals, for console probes only. */
    _debug: { colRT, nrmRT, splatMeshes, decalMeshes, bakeTile, tileOf, get splatLib() { return splatLib; } },
    uCavity,
    get splatCount() { return splatCount; },
    setDecalSystem(sys) { decalSystem = sys; decalVersion = -1; decalTexVersion = -1; },
    /** Extra inputs that change the paint: textures (or getters) and objects of uniforms. */
    watch({ textures = [], uniformObjects = [] } = {}) {
      keySources.textures.push(...textures);
      keySources.uniformObjects.push(...uniformObjects);
    },
    setGroundHeightFn(fn) { getGroundY = fn; },
    /** A game camera's focus ({x, z}) to centre the rings on — steadier than the view ray. */
    setFocusFn(fn) { getFocus = fn; },
    setHeightVersionFn(fn) { getHeightVersion = fn; },
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; },
    /** Bytes of GPU memory the rings hold. */
    get bytes() { return 2 * N * RES * RES * 4; },
    dispose() {
      colRT.dispose(); nrmRT.dispose();
      quadCol.material.dispose(); quadNrm.material.dispose();
      tilePaint.colour.material.dispose(); tilePaint.normal.material.dispose(); finishPlaneMat.dispose(); tileGeo.dispose();
      decalGeo?.dispose();
      for (const m of Object.values(decalMats)) m.dispose();
    },
  };
}
