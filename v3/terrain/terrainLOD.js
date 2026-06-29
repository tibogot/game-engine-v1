import * as THREE from "three";
import {
  float,
  vec2,
  vec3,
  vec4,
  normalize,
  mul,
  mix,
  sin,
  cos,
  smoothstep,
  step,
  length,
  texture,
  uniform,
  positionLocal,
  cameraViewMatrix,
} from "three/tsl";
import {
  createTileMaterial,
  setGridTextureUrl,
} from "../../v2/core/legacy/tileMaterial.js";
import { HEIGHTMAP_SIZE, WORLD_SIZE, MAX_HEIGHT } from "./heightmapTexture.js";

setGridTextureUrl("/textures/grid.png");

// ── LOD constants ─────────────────────────────────────────────────────────────
//
// Level 0 : full 128×128 grid  @  2 m/quad →  256 m radius
// Level 1 : ring               @  4 m/quad →  512 m radius
// Level 2 : ring               @  8 m/quad → 1024 m radius
// Level 3 : ring               @ 16 m/quad → 2048 m radius
// Level 4 : ring               @ 32 m/quad → 4096 m radius
//
// Rings have NO overlap with adjacent levels — no polygon offset needed.
// T-junction stitching on each ring's inner boundary eliminates cracks.

const LOD_LEVELS = 5;
const GRID_N     = 128;
const BASE_STEP  = 2;

// ── Full grid (level 0) ───────────────────────────────────────────────────────

function buildFullGrid(N, step) {
  const verts = (N + 1) * (N + 1);
  const positions = new Float32Array(verts * 3);
  const normals   = new Float32Array(verts * 3);
  const indices   = new Uint32Array(N * N * 6);
  const half = (N * step) / 2;

  let vi = 0;
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      positions[vi++] = ix * step - half;
      positions[vi++] = 0;
      positions[vi++] = iz * step - half;
    }
  }
  for (let i = 0; i < verts; i++) normals[i * 3 + 1] = 1;

  let ii = 0;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * (N + 1) + ix;
      const b = a + 1, c = a + (N + 1), d = c + 1;
      indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
      indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(normals,   3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ── Ring grid with T-junction stitching (levels 1-4) ─────────────────────────
//
// The ring is a full NxN vertex grid with the inner N/2×N/2 quads removed.
// Along the inner boundary (the 4 edges of the hole) we insert one extra
// "fine" midpoint vertex per coarse segment.  These fine vertices sit at the
// same world XZ as the inner level's outer boundary vertices, so when both
// meshes displace from the same heightmap they end up at exactly the same Y.
// The adjacent quads are split into 3 triangles (fan) to use those midpoints,
// eliminating T-junctions and the sky-gap seams they caused.

function buildRingGrid(N, step) {
  const inner = N / 4;          // hole spans [inner, 3*inner) per axis
  const half  = (N * step) / 2;
  const vidx  = (ix, iz) => iz * (N + 1) + ix;

  // ── Vertices ─────────────────────────────────────────────────────────────
  // Base (N+1)² coarse grid + 4 × (N/2) fine midpoints on the inner boundary.
  const finePerEdge = N / 2;            // = 64
  const baseCount   = (N + 1) * (N + 1); // = 16641
  const totalVerts  = baseCount + 4 * finePerEdge; // = 16897

  const positions = new Float32Array(totalVerts * 3);
  const normals   = new Float32Array(totalVerts * 3);

  let vi = 0;
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      positions[vi++] = ix * step - half;
      positions[vi++] = 0;
      positions[vi++] = iz * step - half;
    }
  }

  // Bottom inner boundary: z = inner, x midpoints between [inner, 3*inner)
  const fineBot = (i) => baseCount + i;
  for (let i = 0; i < finePerEdge; i++) {
    positions[vi++] = (inner + i + 0.5) * step - half;
    positions[vi++] = 0;
    positions[vi++] = inner * step - half;
  }
  // Top inner boundary: z = 3*inner
  const fineTop = (i) => baseCount + finePerEdge + i;
  for (let i = 0; i < finePerEdge; i++) {
    positions[vi++] = (inner + i + 0.5) * step - half;
    positions[vi++] = 0;
    positions[vi++] = 3 * inner * step - half;
  }
  // Left inner boundary: x = inner, z midpoints between [inner, 3*inner)
  const fineLeft = (i) => baseCount + 2 * finePerEdge + i;
  for (let i = 0; i < finePerEdge; i++) {
    positions[vi++] = inner * step - half;
    positions[vi++] = 0;
    positions[vi++] = (inner + i + 0.5) * step - half;
  }
  // Right inner boundary: x = 3*inner
  const fineRight = (i) => baseCount + 3 * finePerEdge + i;
  for (let i = 0; i < finePerEdge; i++) {
    positions[vi++] = 3 * inner * step - half;
    positions[vi++] = 0;
    positions[vi++] = (inner + i + 0.5) * step - half;
  }

  for (let i = 0; i < totalVerts; i++) normals[i * 3 + 1] = 1;

  // ── Index buffer ──────────────────────────────────────────────────────────
  const inHole    = (ix, iz) => ix >= inner && ix < 3 * inner && iz >= inner && iz < 3 * inner;
  const isBotAdj  = (ix, iz) => iz === inner - 1       && ix >= inner && ix < 3 * inner;
  const isTopAdj  = (ix, iz) => iz === 3 * inner       && ix >= inner && ix < 3 * inner;
  const isLeftAdj = (ix, iz) => ix === inner - 1       && iz >= inner && iz < 3 * inner;
  const isRightAdj= (ix, iz) => ix === 3 * inner       && iz >= inner && iz < 3 * inner;

  // Count triangles
  let triCount = 0;
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      if (inHole(ix, iz)) continue;
      triCount += (isBotAdj(ix,iz) || isTopAdj(ix,iz) || isLeftAdj(ix,iz) || isRightAdj(ix,iz))
        ? 3  // fan (T-junction stitch)
        : 2; // normal quad
    }
  }

  const indices = new Uint32Array(triCount * 3);
  let ii = 0;

  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      if (inHole(ix, iz)) continue;

      const A = vidx(ix,     iz    ); // bottom-left
      const B = vidx(ix + 1, iz    ); // bottom-right
      const C = vidx(ix,     iz + 1); // top-left
      const D = vidx(ix + 1, iz + 1); // top-right

      if (isBotAdj(ix, iz)) {
        // M on TOP edge — fan from A (bottom-left)
        const M = fineBot(ix - inner);
        indices[ii++]=A; indices[ii++]=C; indices[ii++]=M;
        indices[ii++]=A; indices[ii++]=M; indices[ii++]=D;
        indices[ii++]=A; indices[ii++]=D; indices[ii++]=B;
      } else if (isTopAdj(ix, iz)) {
        // M on BOTTOM edge — fan from C (top-left)
        const M = fineTop(ix - inner);
        indices[ii++]=C; indices[ii++]=M; indices[ii++]=A;
        indices[ii++]=C; indices[ii++]=B; indices[ii++]=M;
        indices[ii++]=C; indices[ii++]=D; indices[ii++]=B;
      } else if (isLeftAdj(ix, iz)) {
        // M on RIGHT edge — fan from A (bottom-left)
        const M = fineLeft(iz - inner);
        indices[ii++]=A; indices[ii++]=M; indices[ii++]=B;
        indices[ii++]=A; indices[ii++]=D; indices[ii++]=M;
        indices[ii++]=A; indices[ii++]=C; indices[ii++]=D;
      } else if (isRightAdj(ix, iz)) {
        // M on LEFT edge — fan from B (bottom-right)
        const M = fineRight(iz - inner);
        indices[ii++]=B; indices[ii++]=A; indices[ii++]=M;
        indices[ii++]=B; indices[ii++]=M; indices[ii++]=C;
        indices[ii++]=B; indices[ii++]=C; indices[ii++]=D;
      } else {
        // Normal quad
        indices[ii++]=A; indices[ii++]=C; indices[ii++]=B;
        indices[ii++]=B; indices[ii++]=C; indices[ii++]=D;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("normal",   new THREE.BufferAttribute(normals,   3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  return geo;
}

// ── Material ──────────────────────────────────────────────────────────────────

function createLODMaterial(heightTexNode, uCenterXZ, uCursorUV, uCursorRadius, uBrushMaskNode, uMaskRotation, splatOverlay, snowMaskTex = null) {
  const mat = createTileMaterial({
    roughness:     0.95,
    textureScale:  400,
    tileColor:     0xe6e3e3,
    gridColor:     0x444444,
    gridLineColor: 0x111111,
  });

  const texel = float(1.0 / HEIGHTMAP_SIZE);

  const worldX = positionLocal.x.add(uCenterXZ.x);
  const worldZ = positionLocal.z.add(uCenterXZ.y);
  const hmU    = worldX.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  const hmV    = worldZ.add(float(WORLD_SIZE * 0.5)).div(float(WORLD_SIZE));
  const hmUV   = vec2(hmU, hmV);

  // No CDLOD morphing: every vertex samples the heightmap at its exact world UV.
  // This guarantees that shared vertices between ring levels land at identical Y,
  // so the T-junction stitching stays crack-free even on sculpted terrain.
  const h = texture(heightTexNode, hmUV).r;

  mat.positionNode = vec3(positionLocal.x, h.mul(MAX_HEIGHT), positionLocal.z);

  // Per-pixel gradient normal (always from fine UV — stays smooth across levels)
  const hL  = texture(heightTexNode, vec2(hmU.sub(texel), hmV)).r;
  const hR  = texture(heightTexNode, vec2(hmU.add(texel), hmV)).r;
  const hD  = texture(heightTexNode, vec2(hmU, hmV.sub(texel))).r;
  const hUp = texture(heightTexNode, vec2(hmU, hmV.add(texel))).r;
  const flatScale   = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
  const worldNormal = normalize(vec3(hL.sub(hR), flatScale, hD.sub(hUp)));
  const blendedWorldN = splatOverlay ? splatOverlay.blendNormal(worldNormal) : worldNormal;
  mat.normalNode = normalize(mul(cameraViewMatrix, vec4(blendedWorldN, 0)).xyz);
  const baseRoughness = splatOverlay ? splatOverlay.blendRoughness(float(0.95)) : float(0.95);

  // Cursor ring (boundary) + mask projection (filled shape preview)
  const d    = length(hmUV.sub(uCursorUV));
  const ring = step(uCursorRadius.sub(float(0.003)), d)
             .mul(step(d, uCursorRadius.add(float(0.003))));

  const brushLocalUV = hmUV.sub(uCursorUV).div(uCursorRadius.mul(float(2))).add(float(0.5));
  const mc           = brushLocalUV.sub(float(0.5));
  const cosR         = cos(uMaskRotation);
  const sinR         = sin(uMaskRotation);
  const rotBrushUV   = vec2(
    mc.x.mul(cosR).sub(mc.y.mul(sinR)).add(float(0.5)),
    mc.x.mul(sinR).add(mc.y.mul(cosR)).add(float(0.5)),
  );
  const inBoundsX    = step(float(0), rotBrushUV.x).mul(step(rotBrushUV.x, float(1)));
  const inBoundsY    = step(float(0), rotBrushUV.y).mul(step(rotBrushUV.y, float(1)));
  const maskOverlay  = texture(uBrushMaskNode, rotBrushUV).r.mul(inBoundsX).mul(inBoundsY);

  // Splat overlay blends on top of base colour; optional snow overlay sits above terrain.
  const baseColor = splatOverlay ? splatOverlay.blendColor(mat.colorNode) : mat.colorNode;
  let finalColor = baseColor;
  let finalRoughness = baseRoughness;
  if (snowMaskTex) {
    const snowMaskNode = texture(snowMaskTex);
    const inWorld = step(float(0), hmU).mul(step(hmU, float(1)))
      .mul(step(float(0), hmV)).mul(step(hmV, float(1)));
    const paintedSnow = texture(snowMaskNode, hmUV.clamp(0, 1)).r.mul(inWorld);
    // Terrain-material snow uses the same conservative slope rejection as SnowSystem.
    const slopeSnow = smoothstep(float(0.55), float(0.78), worldNormal.y);
    const snowCover = paintedSnow.mul(slopeSnow).clamp(0, 1);
    finalColor = mix(baseColor, vec3(float(0.88), float(0.93), float(0.98)), snowCover);
    finalRoughness = mix(baseRoughness, float(0.93), snowCover);
  }

  mat.colorNode = mix(
    finalColor,
    vec3(float(1.0), float(0.95), float(0.2)),
    ring.mul(float(0.9)).add(maskOverlay.mul(float(0.28))),
  );
  mat.roughnessNode = finalRoughness;
  mat.needsUpdate = true;

  return mat;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createTerrainLOD(heightTexNode, uCursorUV, uCursorRadius, uBrushMaskNode, uMaskRotation, splatOverlay, snowMaskTex = null) {
  const group  = new THREE.Group();
  const levels = [];

  for (let lod = 0; lod < LOD_LEVELS; lod++) {
    const step = BASE_STEP * Math.pow(2, lod);
    // Level 0 = full grid; levels 1-4 = stitched rings (no overlap, no polygon offset needed).
    const geo     = lod === 0 ? buildFullGrid(GRID_N, step) : buildRingGrid(GRID_N, step);
    const uCenter = uniform(new THREE.Vector2(0, 0));
    const mat     = createLODMaterial(heightTexNode, uCenter, uCursorUV, uCursorRadius, uBrushMaskNode, uMaskRotation, splatOverlay, snowMaskTex);
    const mesh    = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    levels.push({ mesh, uCenter });
  }

  // Pass controls.target for orbit cameras; camera.position for first-person.
  function update(center) {
    for (const { mesh, uCenter } of levels) {
      mesh.position.set(center.x, 0, center.z);
      uCenter.value.set(center.x, center.z);
    }
  }

  return { group, update };
}
