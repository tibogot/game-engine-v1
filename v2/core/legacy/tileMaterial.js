/**
 * Tile material — TSL port of the R3F CustomShaderMaterial tile floor.
 * Uses grid.png for two-scale grid lines + procedural hash variation.
 * Exports createTileMaterial(options) and tile config constants.
 */
import * as THREE from "three";
import {
  Fn,
  uniform,
  vec3,
  mix,
  mul,
  add,
  sub,
  clamp,
  floor,
  abs,
  texture,
  negate,
  positionWorld,
  positionLocal,
  normalWorld,
  normalLocal,
} from "three/tsl";
import { hash12, remap } from "./tsl-utils.js";

// ─── Config (from tileMaterialConfig.ts) ───
export const TILE_REFERENCE_SIZE = 200;
export const TILE_REFERENCE_SCALE = 400;
export const TILE_DENSITY = TILE_REFERENCE_SCALE / TILE_REFERENCE_SIZE;

let gridTextureCache = null;
let gridTextureUrlOverride = null;

/** Override grid.png path when the page is not served from repo root (e.g. `/models/`). */
export function setGridTextureUrl(url) {
  gridTextureUrlOverride = url;
  gridTextureCache = null;
}

/** Shared grid.png used by tile terrain and cliff-blend flat tops. */
export function getTileGridTexture() {
  return getGridTexture();
}

function getGridTexture() {
  if (gridTextureCache) return gridTextureCache;
  const texLoader = new THREE.TextureLoader();
  gridTextureCache = texLoader.load(
    gridTextureUrlOverride || "textures/grid.png",
  );
  gridTextureCache.wrapS = gridTextureCache.wrapT = THREE.RepeatWrapping;
  gridTextureCache.anisotropy = 16;
  return gridTextureCache;
}

function srgbToLinear(hex) {
  const c = new THREE.Color(hex);
  c.convertSRGBToLinear();
  return c;
}

/**
 * Creates a MeshStandardNodeMaterial with tile floor appearance.
 * @param {object} options
 * @param {number} [options.textureScale=1.0]
 * @param {number} [options.gradientIntensity=0.5]
 * @param {number} [options.gradientBias=0.0]
 * @param {number} [options.tileColor=0x888888]
 * @param {number} [options.gridColor=0x202020]
 * @param {number} [options.gridLineColor=0x000000]
 * @param {number} [options.roughness=1.0]
 * @param {number} [options.metalness=0.0]
 * @param {boolean} [options.objectSpace=false] — when true, UVs use object space so each mesh has its own independent grid (no alignment across objects)
 * @param {[number,number,number]} [options.uvOffset=[0,0,0]] — offset added to position for UVs when objectSpace; use unique values per object to prevent grid alignment
 * @returns {THREE.MeshStandardNodeMaterial}
 */
export function createTileMaterial(options = {}) {
  const {
    textureScale = 1.0,
    gradientIntensity = 0.5,
    gradientBias = 0.0,
    tileColor = 0x888888,
    gridColor = 0x202020,
    gridLineColor = 0x000000,
    roughness = 1.0,
    metalness = 0.0,
    objectSpace = false,
    uvOffset = [0, 0, 0],
  } = options;

  const gridTex = getGridTexture();
  const uUvOffset = uniform(new THREE.Vector3(uvOffset[0], uvOffset[1], uvOffset[2]));
  const uTextureScale = uniform(textureScale);
  const uGradientIntensity = uniform(gradientIntensity);
  const uGradientBias = uniform(gradientBias);
  const uTileColor = uniform(srgbToLinear(tileColor));
  const uGridColor = uniform(srgbToLinear(gridColor));
  const uGridLineColor = uniform(srgbToLinear(gridLineColor));

  const mat = new THREE.MeshStandardNodeMaterial({
    roughness,
    metalness,
  });

  mat.colorNode = Fn(() => {
    // Tri-planar mapping: use world or object position projected by face normal.
    // objectSpace=true: each mesh has its own independent grid (no alignment across objects).
    // Use normalLocal with objectSpace so projection matches geometry orientation (fixes vertical walls showing lines instead of grid).
    const worldScale = mul(uTextureScale, 0.00125);
    const n = abs(objectSpace ? normalLocal : normalWorld);
    const weights = n.div(add(add(n.x, n.y), n.z));
    const pos = objectSpace ? add(positionLocal, uUvOffset) : positionWorld;
    const uvXZ = pos.xz.mul(worldScale);
    const uvXY = pos.xy.mul(worldScale);
    const uvYZ = pos.yz.mul(worldScale);

    const g1XZ = texture(gridTex, mul(uvXZ, 0.125)).r;
    const g2XZ = texture(gridTex, mul(uvXZ, 1.25)).r;
    const hXZ = hash12(floor(mul(uvXZ, 1.25)));
    const g1XY = texture(gridTex, mul(uvXY, 0.125)).r;
    const g2XY = texture(gridTex, mul(uvXY, 1.25)).r;
    const hXY = hash12(floor(mul(uvXY, 1.25)));
    const g1YZ = texture(gridTex, mul(uvYZ, 0.125)).r;
    const g2YZ = texture(gridTex, mul(uvYZ, 1.25)).r;
    const hYZ = hash12(floor(mul(uvYZ, 1.25)));

    const grid1 = add(
      add(mul(g1XZ, weights.y), mul(g1XY, weights.z)),
      mul(g1YZ, weights.x)
    );
    const grid2 = add(
      add(mul(g2XZ, weights.y), mul(g2XY, weights.z)),
      mul(g2YZ, weights.x)
    );
    const gridHash1 = add(
      add(mul(hXZ, weights.y), mul(hXY, weights.z)),
      mul(hYZ, weights.x)
    );
    const variationAmount = mul(uGradientIntensity, 0.2);

    const baseShade = clamp(
      add(
        0.45,
        remap(gridHash1, 0.0, 1.0, negate(variationAmount), variationAmount),
        uGradientBias
      ),
      0.0,
      1.0
    );

    const tileColour = mul(uTileColor, baseShade);
    let gridColour = mix(tileColour, uGridColor, grid2);
    gridColour = mix(gridColour, uGridLineColor, grid1);

    return gridColour;
  })();

  mat._tileUniforms = {
    uvOffset: uUvOffset,
    textureScale: uTextureScale,
    gradientIntensity: uGradientIntensity,
    gradientBias: uGradientBias,
    tileColor: uTileColor,
    gridColor: uGridColor,
    gridLineColor: uGridLineColor,
  };

  return mat;
}

/**
 * Tile grid colour at world XZ — matches flat terrain tops (normal ≈ up uses XZ projection).
 * @param {THREE.Texture} gridTex
 * @param {ReturnType<createTileMaterial>["_tileUniforms"]} uniforms
 * @param {import("three/tsl").Node} worldXZ
 */
export function tileColorAtWorldXZ(gridTex, uniforms, worldXZ) {
  const worldScale = mul(uniforms.textureScale, 0.00125);
  const uvXZ = worldXZ.mul(worldScale);
  const g1 = texture(gridTex, mul(uvXZ, 0.125)).r;
  const g2 = texture(gridTex, mul(uvXZ, 1.25)).r;
  const h = hash12(floor(mul(uvXZ, 1.25)));
  const variationAmount = mul(uniforms.gradientIntensity, 0.2);
  const baseShade = clamp(
    add(
      0.45,
      remap(h, 0.0, 1.0, negate(variationAmount), variationAmount),
      uniforms.gradientBias,
    ),
    0.0,
    1.0,
  );
  const tileColour = mul(uniforms.tileColor, baseShade);
  let gridColour = mix(tileColour, uniforms.gridColor, g2);
  gridColour = mix(gridColour, uniforms.gridLineColor, g1);
  return gridColour;
}
