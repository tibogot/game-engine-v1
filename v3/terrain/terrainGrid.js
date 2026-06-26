import * as THREE from "three";
import {
  float,
  vec2,
  vec3,
  vec4,
  normalize,
  mul,
  texture,
  uv,
  positionLocal,
  cameraViewMatrix,
} from "three/tsl";
import {
  createTileMaterial,
  setGridTextureUrl,
} from "../../v2/core/legacy/tileMaterial.js";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

// grid.png lives in public/textures/ — served at /textures/ by Vite from any page.
setGridTextureUrl("/textures/grid.png");

const GRID_SEGMENTS = 512;

function buildFlatXZGrid(worldSize, segments) {
  const vertCount = (segments + 1) * (segments + 1);
  const positions = new Float32Array(vertCount * 3);
  const uvs      = new Float32Array(vertCount * 2);
  const indices  = new Uint32Array(segments * segments * 6);

  const step = worldSize / segments;
  const half = worldSize / 2;
  let vi = 0, ui = 0;

  for (let z = 0; z <= segments; z++) {
    for (let x = 0; x <= segments; x++) {
      positions[vi++] = x * step - half;
      positions[vi++] = 0;
      positions[vi++] = z * step - half;
      uvs[ui++] = x / segments;
      uvs[ui++] = z / segments;
    }
  }

  let ii = 0;
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const a = z * (segments + 1) + x;
      const b = a + 1;
      const c = a + (segments + 1);
      const d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("uv",       new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  const normals = new Float32Array(vertCount * 3);
  for (let i = 0; i < vertCount; i++) normals[i * 3 + 1] = 1;
  geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  return geo;
}

export function createTerrainGrid(initialTex) {
  const geo = buildFlatXZGrid(WORLD_SIZE, GRID_SEGMENTS);

  // Same defaults as v2 editor for a fair comparison.
  const mat = createTileMaterial({
    roughness:     0.95,
    textureScale:  400,
    tileColor:     0xe6e3e3,
    gridColor:     0x444444,
    gridLineColor: 0x111111,
  });

  // Shared texture node — sculptBrush swaps .value to the live render target.
  const heightTexNode = texture(initialTex);

  const uvCoord = uv();
  const texel   = float(1.0 / HEIGHTMAP_SIZE);

  // ── Vertex: displace Y from heightmap ─────────────────────────────────────
  const h = texture(heightTexNode, uvCoord).r;
  mat.positionNode = vec3(positionLocal.x, h.mul(MAX_HEIGHT), positionLocal.z);

  // ── Fragment: per-pixel normal from gradient → view space ─────────────────
  const hL = texture(heightTexNode, vec2(uvCoord.x.sub(texel), uvCoord.y)).r;
  const hR = texture(heightTexNode, vec2(uvCoord.x.add(texel), uvCoord.y)).r;
  const hD = texture(heightTexNode, vec2(uvCoord.x, uvCoord.y.sub(texel))).r;
  const hU = texture(heightTexNode, vec2(uvCoord.x, uvCoord.y.add(texel))).r;

  const flatScale  = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
  const worldNormal = normalize(vec3(hL.sub(hR), flatScale, hD.sub(hU)));
  mat.normalNode = normalize(mul(cameraViewMatrix, vec4(worldNormal, 0)).xyz);

  return { mesh: new THREE.Mesh(geo, mat), heightTexNode };
}
