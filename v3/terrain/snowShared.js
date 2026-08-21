/**
 * SnowShared — the single source of truth for the snow surface.
 *
 * Snow height is ONE continuous function of world XZ:
 *
 *   snowDepth(wxz) = coverage(paint mask) × slopeMask × (baseDepth + noise)
 *
 * Every material that renders snow (the terrain LOD rings and the high-res
 * deform tile in snowSystem.js) evaluates these exact TSL functions and shares
 * the same uniform/texture node objects, so the two surfaces can never drift
 * apart — the tile border lands on the terrain-snow surface to within
 * tessellation error and needs no alpha cross-fade.
 *
 * Division of labour:
 *   terrain: y = terrainH + snowDepth × (1 − tileMask)   (bare inside tile)
 *   tile:    y = terrainH + snowDepth × (1 − compression) + rim
 *
 * tile − terrain = depth·tileMask·(1−comp) ≥ 0 everywhere, so coarse terrain
 * can never poke up through footprint grooves.
 */
import * as THREE from "three";
import {
  Fn,
  cameraPosition,
  cross, float, floor, min, mix,
  positionWorld,
  reflect, smoothstep, step,
  texture, uniform,
  vec2, vec3,
  mx_noise_float,
} from "three/tsl";
import { WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

// Fade the vertex-displacement noise out with camera distance: far LOD rings
// sample at up to 32 m/vertex, which would alias the ~16 m noise into crawling
// lumps. A 0.12 m bump is invisible past 150 m anyway.
const NOISE_FADE_NEAR = 150;
const NOISE_FADE_FAR  = 350;

// Sun-crystal sparkle fade — the pow(1500) lobe turns into firefly shimmer at
// distance, so it only runs near the camera.
const SPARKLE_FADE_NEAR = 50;
const SPARKLE_FADE_FAR  = 130;

const SNOW_BASE   = vec3(0.88, 0.93, 0.98);   // pristine: cool blue-white
const SNOW_PACKED = vec3(0.60, 0.66, 0.76);   // compressed: blue-grey

export function createSnowShared(initialHeightTex, defaults) {
  const u = {
    uBaseDepth:        uniform(defaults.baseDepth),
    uNoiseFreq1:       uniform(defaults.noiseFreq1),
    uNoiseFreq2:       uniform(defaults.noiseFreq2),
    uNoiseAmp:         uniform(defaults.noiseAmp),
    uSlopeStartY:      uniform(defaults.slopeStartY),
    uSlopeRejectY:     uniform(defaults.slopeRejectY),
    uCavityStrength:   uniform(defaults.cavityStrength),
    uRoughnessDip:     uniform(defaults.roughnessDip),
    uGlitterIntensity: uniform(defaults.glitterIntensity),
    uGlitterScarcity:  uniform(defaults.glitterScarcity),
    uGlitterFreq:      uniform(defaults.glitterFreq),
    uSunDir:           uniform(new THREE.Vector3(0, 1, 0)),
    // Deform-tile window — snowSystem sets these; uTileOn = 0 whenever the
    // tile is hidden so the terrain renders the full surface everywhere.
    uAnchor:           uniform(new THREE.Vector2(0, 0)),
    uTileHalf:         uniform(25),
    uTileFeather:      uniform(10),
    uTileOn:           uniform(0),
    // 0 = the snow map is empty — the terrain material skips its whole snow
    // branch. Driven per frame from SnowMap.hasAnySnow() (cached CPU flag).
    uHasSnow:          uniform(0),
  };

  // Heightmap node — sculptBrush's rtMain is canonical and never swapped, but
  // setHeightTex stays available for save/load flows.
  const heightNode = texture(initialHeightTex);

  // Snow coverage paint mask — 1×1 black until setMaskTex(snowMap.tex).
  const _defMaskData = new Uint8Array([0]);
  const _defMaskTex  = new THREE.DataTexture(_defMaskData, 1, 1, THREE.RedFormat);
  _defMaskTex.needsUpdate = true;
  const maskNode = texture(_defMaskTex);

  // Terrain height (metres) from the GPU heightmap at world XZ
  const getTerrainH = Fn(([wxz]) => {
    const hUV = wxz.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE)).clamp(0, 1);
    // .sample() so setHeightTex/setMaskTex swaps keep working after the
    // shaders are built (texture(node, uv) bakes the build-time texture in).
    return heightNode.sample(hUV).r.mul(float(MAX_HEIGHT));
  });

  // Terrain-only normal (snow depth intentionally excluded: steep cliffs
  // reject snow before any deformation is applied).
  const terrainNormal = Fn(([wxz, eps]) => {
    const hA = getTerrainH(wxz);
    const hX = getTerrainH(wxz.add(vec2(eps, float(0))));
    const hZ = getTerrainH(wxz.add(vec2(float(0), eps.negate())));
    const pA = vec3(wxz.x, hA, wxz.y);
    const pX = vec3(wxz.x.add(eps), hX, wxz.y);
    const pZ = vec3(wxz.x, hZ, wxz.y.sub(eps));
    return cross(pX.sub(pA).normalize(), pZ.sub(pA).normalize()).normalize();
  });

  const slopeMask = Fn(([wxz]) =>
    smoothstep(u.uSlopeRejectY, u.uSlopeStartY, terrainNormal(wxz, float(2.0)).y)
  );

  // Painted coverage [0,1]; zero outside the heightmap so ClampToEdgeWrapping
  // can't smear edge texels onto the far LOD rings.
  const coverage = Fn(([wxz]) => {
    const mUV = wxz.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
    const inWorld = step(float(0), mUV.x).mul(step(mUV.x, float(1)))
      .mul(step(float(0), mUV.y)).mul(step(mUV.y, float(1)));
    return maskNode.sample(mUV.clamp(0, 1)).r.mul(inWorld);
  });

  const covBlend = Fn(([wxz]) => coverage(wxz).mul(slopeMask(wxz)));

  // Two-octave surface variation, distance-faded (see NOISE_FADE_* above)
  const snowNoise = Fn(([wxz]) => {
    const p1 = vec3(wxz.x.mul(u.uNoiseFreq1), float(0), wxz.y.mul(u.uNoiseFreq1));
    const p2 = vec3(wxz.x.mul(u.uNoiseFreq2), float(0), wxz.y.mul(u.uNoiseFreq2));
    const n  = mx_noise_float(p1).mul(0.5).add(0.5)
      .mul(mx_noise_float(p2).mul(0.5).add(0.5))
      .mul(u.uNoiseAmp);
    const camDist = wxz.distance(cameraPosition.xz);
    return n.mul(float(1).sub(smoothstep(float(NOISE_FADE_NEAR), float(NOISE_FADE_FAR), camDist)));
  });

  // The snow surface. Coverage scales depth, so painted edges thin out to
  // nothing like a real snow line — no cutoffs, no steps.
  const snowDepth = Fn(([wxz]) =>
    covBlend(wxz).mul(u.uBaseDepth.add(snowNoise(wxz))).max(0)
  );

  // 1 deep inside the deform tile, 0 at/outside its border (and 0 while off)
  const tileMask = Fn(([wxz]) => {
    const adx = wxz.x.sub(u.uAnchor.x).abs();
    const adz = wxz.y.sub(u.uAnchor.y).abs();
    const distToEdge = min(u.uTileHalf.sub(adx), u.uTileHalf.sub(adz));
    return smoothstep(float(0), u.uTileFeather, distToEdge).mul(u.uTileOn);
  });

  // Terrain vertex displacement: full surface, handed off to the tile inside
  // its footprint so grooves are never covered by the coarse terrain grid.
  const groundDepth = Fn(([wxz]) =>
    snowDepth(wxz).mul(float(1).sub(tileMask(wxz)))
  );

  // ── Fragment shading — identical on terrain and tile ──────────────────────
  // (plain JS helpers returning TSL expressions; compression = 0 on terrain)

  function snowAlbedo(comp) {
    const c = comp.mul(u.uCavityStrength).clamp(0, 1);
    return mix(SNOW_BASE, SNOW_PACKED, c).mul(float(1).sub(c));
  }

  function snowRoughness(comp) {
    return float(0.93).sub(comp.mul(u.uRoughnessDip)).clamp(0.65, 1.0);
  }

  // Micro-facet sun sparkle + soft ambient shimmer, camera-distance faded.
  function snowSparkle(wxz, comp) {
    const mfCell  = floor(wxz.mul(u.uGlitterFreq));
    const h1      = mx_noise_float(vec3(mfCell.x, float(0),    mfCell.y).mul(float(0.193)));
    const h2      = mx_noise_float(vec3(mfCell.x, float(17.3), mfCell.y).mul(float(0.251)));
    const mfN     = vec3(h1.sub(0.5).mul(0.6), float(1.0), h2.sub(0.5).mul(0.6)).normalize();
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const refl    = reflect(u.uSunDir.negate(), mfN);
    const specDot = refl.dot(viewDir).clamp(0, 1);
    const sparkle = specDot.pow(float(1500.0)).mul(u.uGlitterIntensity).mul(float(1).sub(comp));

    const gp      = wxz.mul(float(0.3));
    const gn      = mx_noise_float(vec3(gp.x, float(0), gp.y)).mul(0.5).add(0.5);
    const shimmer = gn.pow(u.uGlitterScarcity).mul(u.uGlitterIntensity.mul(0.4));

    const camDist  = positionWorld.xz.distance(cameraPosition.xz);
    const distFade = float(1).sub(smoothstep(float(SPARKLE_FADE_NEAR), float(SPARKLE_FADE_FAR), camDist));
    const s = sparkle.add(shimmer).mul(distFade);
    return vec3(s, s, s.mul(0.9));
  }

  function setHeightTex(tex) { heightNode.value = tex; }
  function setMaskTex(tex)   { maskNode.value = tex; }

  return {
    u,
    heightNode,
    maskNode,
    getTerrainH,
    terrainNormal,
    slopeMask,
    coverage,
    covBlend,
    snowNoise,
    snowDepth,
    tileMask,
    groundDepth,
    snowAlbedo,
    snowRoughness,
    snowSparkle,
    setHeightTex,
    setMaskTex,
  };
}
