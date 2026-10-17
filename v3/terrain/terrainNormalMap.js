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
  Fn, float, vec2, vec3, vec4, normalize, texture, uv, sqrt, max,
} from "three/tsl";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

/** Cavity rings [radius m, weight]: a gully-sized one and a basin-sized one. */
const CAVITY_RADII_M = [[4, 1.0], [14, 0.35]];

/** The packed normal's Y, rebuilt from X and Z (terrain normals point up). */
const upY = (s) => sqrt(max(float(0), float(1).sub(s.x.mul(s.x)).sub(s.z.mul(s.z))));

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
  //
  // fragmentNode, NOT colorNode. A node material's colorNode is RGB only: the
  // vec4's .w was thrown away and written as 1, so until 2026-09-13 every
  // reader of the packed height saw 1.0 = MAX_HEIGHT everywhere (measured:
  // flat 0 m terrain and a 0–108 m generated one both baked .w = 1). That
  // silently put the auto-paint high-altitude rule and the procedural ground
  // height tint "above the line" on the whole map, and floated the snow deform
  // tile 500 m up. fragmentNode writes the vec4 verbatim; .xyz is unchanged.
  const bakeMat = new THREE.MeshBasicNodeMaterial();
  bakeMat.toneMapped = bakeMat.fog = false;
  bakeMat.depthTest  = bakeMat.depthWrite = false;
  bakeMat.fragmentNode = Fn(() => {
    const c     = uv();
    const texel = float(1.0 / HEIGHTMAP_SIZE);
    const hL  = texture(heightTexNode, vec2(c.x.sub(texel), c.y)).r;
    const hR  = texture(heightTexNode, vec2(c.x.add(texel), c.y)).r;
    const hD  = texture(heightTexNode, vec2(c.x, c.y.sub(texel))).r;
    const hUp = texture(heightTexNode, vec2(c.x, c.y.add(texel))).r;
    const flatScale = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
    const hC = texture(heightTexNode, c).r;
    const n = normalize(vec3(hL.sub(hR), flatScale, hD.sub(hUp)));
    // CAVITY (weathering, TEXTURING_PLAN step 3): how far this texel sits
    // BELOW the mean of a ring around it, in metres — + in a hollow or gully,
    // − on a ridge or crest. Two rings (CAVITY_RADII_M) so a narrow gully and
    // a wide basin both read; paid per height EDIT, not per frame.
    let cav = float(0);
    for (const [rM, wt] of CAVITY_RADII_M) {
      const rT = Math.max(1, rM / (WORLD_SIZE / HEIGHTMAP_SIZE)) / HEIGHTMAP_SIZE;
      let ring = float(0);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        ring = ring.add(texture(heightTexNode, c.add(vec2(Math.cos(a) * rT, Math.sin(a) * rT))).r);
      }
      cav = cav.add(ring.div(8).sub(hC).mul(MAX_HEIGHT * wt));
    }
    // Normal Y goes: a heightfield normal always points up, so surfaceAt()
    // rebuilds it from X and Z and the freed channel carries the cavity.
    return vec4(n.x, cav, n.z, hC);
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
    const s = normalTexNode.sample(uvNode);
    return vec4(s.x, upY(s), s.z, s.w);
  }

  /**
   * World-space terrain normal at a heightmap UV. Re-normalized because
   * bilinear interpolation between two unit normals is shorter than unit.
   */
  function normalAt(uvNode) {
    const s = normalTexNode.sample(uvNode);
    return normalize(vec3(s.x, upY(s), s.z));
  }

  /**
   * Cavity in metres at a heightmap UV: + below the ring around it (hollow,
   * gully), − above it (ridge). Same texel as surfaceAt — sample once and
   * pass it as `packed` when both are wanted.
   */
  function cavityAt(uvNode, packed = null) {
    return (packed ?? normalTexNode.sample(uvNode)).y;
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
    cavityAt,
    heightAt,
    bake,
    bakeIfNeeded,
    resolution: RES,
    dispose() { rt.dispose(); bakeMat.dispose(); },
  };
}
