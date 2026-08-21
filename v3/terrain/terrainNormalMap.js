/**
 * Baked terrain normal map — one texture fetch per pixel instead of four.
 *
 * The terrain's lighting normal is a finite difference of the heightmap:
 * four neighbour taps plus a normalize, evaluated for EVERY terrain pixel of
 * EVERY frame — while the heightmap itself only changes when the user sculpts.
 * This bakes that finite difference into its own texture once per edit, so the
 * material samples a normal instead of deriving one.
 *
 * Cost moves from (pixels × 4 taps) per frame to (HEIGHTMAP_SIZE² × 4 taps)
 * per EDIT. At the shipped 1024² config the bake is a single fullscreen pass
 * over 1M texels; the main pass it replaces runs over every terrain pixel on
 * screen, several times that at 1440p, sixty times a second.
 *
 * QUALITY: this is not just cheaper, it is smoother. Deriving the normal
 * per-pixel differences a BILINEARLY FILTERED height, whose gradient is
 * piecewise-constant across each texel quad and flips at texel boundaries —
 * the classic diamond/chevron faceting on low-slope ground. Baking evaluates
 * the difference once per texel and then interpolates the NORMALS, which is
 * what Unity and Unreal both do with terrain normal maps.
 *
 * Storage is RGBA holding the world-space normal in .xyz and the NORMALIZED
 * HEIGHT in .w. Carrying the height is not a convenience: WebGPU caps a shader
 * stage at 16 samplers and the terrain material was already at exactly 16, so a
 * new texture had to REPLACE the heightmap in the fragment stage rather than
 * join it. Every fragment-side height read (procedural ground height bands, the
 * auto-paint height rule, the snow slope mask) now comes from here, and the
 * heightmap itself is only sampled by the VERTEX stage, which has its own
 * budget. Bilinear interpolation denormalizes the normal slightly, hence the
 * normalize() in normalAt().
 *
 * The element type mirrors the height RT's: half-float quantizes heights into
 * 5-25 cm steps, which reads as contour banding in anything shaded from them.
 */
import * as THREE from "three";
import { QuadMesh } from "three/webgpu";
import {
  Fn, float, vec2, vec3, vec4, normalize, texture, uv,
} from "three/tsl";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

/**
 * @param {object}  deps
 * @param {object}  deps.heightTexNode — the shared TSL height texture node
 * @param {THREE.WebGPURenderer} deps.renderer
 * @param {number} [deps.resolution]   — defaults to the heightmap resolution
 */
export function createTerrainNormalMap({ heightTexNode, renderer, resolution = HEIGHTMAP_SIZE }) {
  const RES = resolution;

  // Match sculptBrush's choice: full float wherever the GPU can filter it, so
  // the packed height is bit-comparable to the heightmap it mirrors.
  const rtType = renderer?.backend?.device?.features?.has("float32-filterable")
    ? THREE.FloatType
    : THREE.HalfFloatType;

  const rt = new THREE.RenderTarget(RES, RES, {
    format:          THREE.RGBAFormat,
    type:            rtType,
    minFilter:       THREE.LinearFilter,
    magFilter:       THREE.LinearFilter,
    wrapS:           THREE.ClampToEdgeWrapping,
    wrapT:           THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
    depthBuffer:     false,
    colorSpace:      THREE.NoColorSpace,
  });
  rt.texture.flipY = false;
  rt.texture.name  = "TerrainNormalMap";

  // ── Bake pass ─────────────────────────────────────────────────────────────
  // Identical maths to the per-pixel version it replaces, so the surface it
  // describes is the same one every other system already agrees on.
  const bakeMat = new THREE.MeshBasicNodeMaterial();
  bakeMat.toneMapped = bakeMat.fog = false;
  bakeMat.depthTest  = bakeMat.depthWrite = false;
  bakeMat.colorNode = Fn(() => {
    const c     = uv();
    const texel = float(1.0 / HEIGHTMAP_SIZE);
    const hL  = texture(heightTexNode, vec2(c.x.sub(texel), c.y)).r;
    const hR  = texture(heightTexNode, vec2(c.x.add(texel), c.y)).r;
    const hD  = texture(heightTexNode, vec2(c.x, c.y.sub(texel))).r;
    const hUp = texture(heightTexNode, vec2(c.x, c.y.add(texel))).r;
    const flatScale = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
    const hC = texture(heightTexNode, c).r;
    return vec4(normalize(vec3(hL.sub(hR), flatScale, hD.sub(hUp))), hC);
  })();
  const bakeQuad = new QuadMesh(bakeMat);

  /** TSL node for the baked texture — sample via normalAt(uv). */
  const normalTexNode = texture(rt.texture);

  /**
   * The whole packed texel: .xyz = world normal (unnormalized after filtering),
   * .w = normalized height. Callers needing both should sample ONCE through
   * this and split it, rather than calling normalAt + heightAt.
   */
  function surfaceAt(uvNode) {
    return normalTexNode.sample(uvNode);
  }

  /**
   * World-space terrain normal at a heightmap UV. Re-normalized because
   * bilinear interpolation between two unit normals is shorter than unit.
   */
  function normalAt(uvNode) {
    return normalize(normalTexNode.sample(uvNode).xyz);
  }

  /** Normalized terrain height (multiply by MAX_HEIGHT for metres). */
  function heightAt(uvNode) {
    return normalTexNode.sample(uvNode).w;
  }

  function bake() {
    const prevRT = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    bakeQuad.render(renderer);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAutoClear;
  }

  // Bake immediately: an unbaked RT is cleared to (0,0,0), and normalize() of a
  // zero vector is NaN — one frame of that turns the whole terrain black.
  bake();

  let _lastVersion = -1;

  /**
   * Re-bake only when the heightmap has actually changed. `version` comes from
   * sculptBrush.getHeightVersion(), which counts every write to the canonical
   * height RT — brushes, erosion, hydro, undo/redo, project load.
   */
  function bakeIfNeeded(version) {
    if (version === _lastVersion) return false;
    _lastVersion = version;
    bake();
    return true;
  }

  return {
    texture: rt.texture,
    normalTexNode,
    surfaceAt,
    normalAt,
    heightAt,
    bake,
    bakeIfNeeded,
    resolution: RES,
    dispose() { rt.dispose(); bakeMat.dispose(); },
  };
}
