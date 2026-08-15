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
// At the default 2048 m / 1024² config this reproduces the original layout:
// Level 0 : full 128×128 grid  @  2 m/quad →  256 m span
// Level 1 : ring               @  4 m/quad →  512 m span
// Level 2 : ring               @  8 m/quad → 1024 m span
// Level 3 : ring               @ 16 m/quad → 2048 m span
// Level 4 : ring               @ 32 m/quad → 4096 m span
//
// Rings have NO overlap with adjacent levels — no polygon offset needed.
// T-junction stitching on each ring's inner boundary eliminates cracks.
//
// BASE_STEP matches the heightmap texel size, so the finest ring always has
// one quad per height texel. LOD_LEVELS grows with world size so the outermost
// ring reaches past the world edge (~2× WORLD_SIZE span) at any config —
// each extra level doubles coverage for a fixed ~16k verts.

const GRID_N     = 128;
const BASE_STEP  = Math.max(1, WORLD_SIZE / HEIGHTMAP_SIZE);
export const LOD_LEVELS = Math.max(
  4,
  Math.ceil(Math.log2((2 * WORLD_SIZE) / (GRID_N * BASE_STEP))) + 1,
);

/**
 * Quantum the clipmap centre is snapped to — the COARSEST ring's grid step.
 * See the note on `update()` for why snapping is mandatory and why it has to be
 * this value rather than a constant. Derived, so it follows any change to
 * WORLD_SIZE / HEIGHTMAP_SIZE instead of going stale.
 * Shipped 2048/1024 config: steps are 2, 4, 8, 16, 32 → snap 32.
 */
export const LOD_CENTRE_SNAP = BASE_STEP * Math.pow(2, LOD_LEVELS - 1);

/**
 * COMPILE-TIME feature set for the terrain material.
 *
 * WHY THIS IS NOT A SET OF UNIFORMS. Every one of these was already switchable
 * — and switched off by multiplying its finished result by zero, through a
 * `mix()` or a `.mul(uOn)`. That skips nothing: the GPU evaluates both sides of
 * a mix, so a project with no snow, no lake and no procedural ground still ran
 * all three on every pixel of every frame, then threw the answers away.
 *
 * MEASURED (back-to-back A/B, immune to GPU clock drift): the terrain material
 * is ~87% of the editor's GPU frame, and ONE render pass is ~93% of the frame.
 * Within that, no single feature dominates — each removal is worth 3–8% — which
 * is the signature of a shader that is simply too big, so the win has to come
 * from removing SEVERAL at once rather than finding a hotspot.
 *
 * Defaults are ALL ON = bit-for-bit the previous shader; the editor keeps them.
 * A game passes only what its project actually uses. Uniforms are still created
 * regardless, so the dev panel, the save format and every caller keep working —
 * a disabled feature just stops being wired into the output.
 */
export const TERRAIN_FEATURES = {
  /** Brush ring + mask projection. EDITOR ONLY — a game cannot move the cursor. */
  cursor: true,
  /** v2 procedural ground TSL under the splat layers (groundProc.uOn). */
  groundProc: true,
  /** Painted snow: coverage, albedo, roughness and the sparkle emissive. */
  snow: true,
  /** Underwater lakebed tint + caustics. */
  lakebed: true,
};

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

function createLODMaterial(heightTexNode, uCenterXZ, uCursorUV, uCursorRadius, uBrushMaskNode, uMaskRotation, splatOverlay, snowShared = null, lakebed = null, groundProc = null, features = {}) {
  const F = { ...TERRAIN_FEATURES, ...features };
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
  //
  // hmInBounds = 0 for any vertex whose world position lies outside the heightmap
  // [0,1] UV range. Without this, ClampToEdgeWrapping would repeat the edge pixels
  // of the heightmap onto the far LOD ring, making non-circle procedural shapes
  // show terrain lines on the far flat terrain.
  const hmInBounds = step(float(0), hmU).mul(step(hmU, float(1)))
                    .mul(step(float(0), hmV)).mul(step(hmV, float(1)));
  const h = texture(heightTexNode, hmUV).r.mul(hmInBounds);

  // Painted snow displaces the terrain itself (snowShared.groundDepth is a
  // pure function of world XZ, so shared ring-boundary vertices across LOD
  // levels still land at identical Y — stitching stays crack-free). Inside
  // the deform tile's footprint groundDepth hands the surface over to the
  // high-res tile so footprint grooves are never covered by coarse terrain.
  const wxz = vec2(worldX, worldZ);
  const terrainY = h.mul(MAX_HEIGHT);
  const displacedY = snowShared ? terrainY.add(snowShared.groundDepth(wxz)) : terrainY;
  mat.positionNode = vec3(positionLocal.x, displacedY, positionLocal.z);

  // Per-pixel gradient normal (always from fine UV — stays smooth across levels)
  const hL  = texture(heightTexNode, vec2(hmU.sub(texel), hmV)).r;
  const hR  = texture(heightTexNode, vec2(hmU.add(texel), hmV)).r;
  const hD  = texture(heightTexNode, vec2(hmU, hmV.sub(texel))).r;
  const hUp = texture(heightTexNode, vec2(hmU, hmV.add(texel))).r;
  const flatScale   = float(2.0 * WORLD_SIZE / (HEIGHTMAP_SIZE * MAX_HEIGHT));
  const worldNormal = normalize(vec3(hL.sub(hR), flatScale, hD.sub(hUp)));
  const blendedWorldN = splatOverlay ? splatOverlay.blendNormal(worldNormal) : worldNormal;
  // Painted coverage × slope, from the same shared functions the deform tile
  // uses — snow can never look different on the two surfaces. Node reused
  // below for color/roughness/emissive, so it's evaluated once per pixel.
  const useSnow = !!snowShared && F.snow;
  const snowCov = useSnow ? snowShared.covBlend(wxz) : null;
  // Snow smooths the ground: ease the lighting normal toward up where covered.
  const litWorldN = useSnow
    ? normalize(mix(blendedWorldN, vec3(0, 1, 0), snowCov.mul(float(0.45))))
    : blendedWorldN;
  mat.normalNode = normalize(mul(cameraViewMatrix, vec4(litWorldN, 0)).xyz);
  const baseRoughness = splatOverlay ? splatOverlay.blendRoughness(float(0.95)) : float(0.95);

  // Cursor ring (boundary) + mask projection (filled shape preview).
  //
  // EDITOR-ONLY, and previously compiled into every shipped game: a texture
  // fetch, a smoothstep, two rotations and six steps per pixel, drawing a brush
  // cursor that a game has no way to move and no reason to show.
  let ring = null;
  let maskOverlay = null;
  if (F.cursor) {
    const d    = length(hmUV.sub(uCursorUV));
    ring = step(uCursorRadius.sub(float(0.003)), d)
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
    // Soft radial fade: clips the overlay to a smooth circle so non-circle brushes
    // (square, diamond, etc.) don't produce hard straight boundary lines on far LOD.
    const radialFade   = smoothstep(uCursorRadius, uCursorRadius.mul(float(0.8)), d);
    maskOverlay = texture(uBrushMaskNode, rotBrushUV).r.mul(inBoundsX).mul(inBoundsY).mul(radialFade);
  }

  // Splat overlay blends on top of base colour; painted snow shades on top
  // with the shared snow functions (compression = 0: only the deform tile
  // shows grooves; out here the trail RT doesn't exist).
  // groundProc (v2 procedural ground TSL, uniform-gated) replaces the grey
  // tile base when enabled — the splat layers still paint over it.
  // `mix(base, proc, uOn)` EVALUATES BOTH SIDES — a uniform at 0 does not skip
  // the procedural ground, it computes it and multiplies the result away. So a
  // project that never enables it still paid for it on every pixel.
  const tileBase = (groundProc && F.groundProc)
    ? mix(mat.colorNode, groundProc.colorAt(wxz, worldNormal.y, terrainY), groundProc.uOn)
    : mat.colorNode;
  let baseColor = splatOverlay ? splatOverlay.blendColor(tileBase) : tileBase;
  // Paintable meadow TSL (layer card 8): its splat-mask channel blends the
  // procedural meadow color over the image layers wherever it's painted.
  if (groundProc?.meadowAt && splatOverlay && F.groundProc) {
    baseColor = splatOverlay.blendMeadow(baseColor, groundProc.meadowAt);
  }
  let finalColor = baseColor;
  let finalRoughness = baseRoughness;
  if (useSnow) {
    const zeroComp = float(0);
    finalColor     = mix(baseColor, snowShared.snowAlbedo(zeroComp), snowCov);
    finalRoughness = mix(baseRoughness, snowShared.snowRoughness(zeroComp), snowCov);
    mat.emissiveNode = snowShared.snowSparkle(wxz, zeroComp).mul(snowCov);
  }

  // Underwater lakebed treatment (sand + depth tint + caustics) sits on top of
  // splat and snow — water covers everything — but under the cursor ring, which
  // is editor UI and must stay visible over a submerged brush target.
  if (lakebed && F.lakebed) finalColor = lakebed.apply(finalColor);

  // The cursor tint is the ONLY consumer of ring/maskOverlay, so with the
  // cursor compiled out the colour passes straight through.
  mat.colorNode = F.cursor
    ? mix(
        finalColor,
        vec3(float(1.0), float(0.95), float(0.2)),
        ring.mul(float(0.9)).add(maskOverlay.mul(float(0.28))),
      )
    : finalColor;
  mat.roughnessNode = finalRoughness;
  mat.needsUpdate = true;

  return mat;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createTerrainLOD(heightTexNode, uCursorUV, uCursorRadius, uBrushMaskNode, uMaskRotation, splatOverlay, snowShared = null, lakebed = null, groundProc = null, features = {}) {
  const group  = new THREE.Group();
  const levels = [];

  for (let lod = 0; lod < LOD_LEVELS; lod++) {
    const step = BASE_STEP * Math.pow(2, lod);
    // Level 0 = full grid; levels 1-4 = stitched rings (no overlap, no polygon offset needed).
    const geo     = lod === 0 ? buildFullGrid(GRID_N, step) : buildRingGrid(GRID_N, step);
    const uCenter = uniform(new THREE.Vector2(0, 0));
    const mat     = createLODMaterial(heightTexNode, uCenter, uCursorUV, uCursorRadius, uBrushMaskNode, uMaskRotation, splatOverlay, snowShared, lakebed, groundProc, features);
    const mesh    = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    levels.push({ mesh, uCenter });
  }

  /**
   * Re-centre the clipmap. Pass controls.target for orbit cameras,
   * camera.position for first-person.
   *
   * THE CENTRE IS SNAPPED TO THE GRID, AND THAT IS NOT OPTIONAL.
   *
   * Every ring vertex sits at a fixed offset from this centre, so if the centre
   * slides continuously each vertex lands somewhere slightly new every frame,
   * re-samples the heightmap there, and gets a slightly different height. The
   * mesh swims through the heightfield. On flat ground the height barely changes
   * and nobody notices; on a CLIFF the same few centimetres of slide is a large
   * height change, so the surface visibly ripples — and because the textures are
   * world-anchored (positionWorld.xz) while the geometry moves underneath them,
   * it reads as the texture crawling across the rock. Reported as "the terrain
   * texture really morphs", and mistaken for the stochastic-tiling artefact,
   * which swims the same way for an unrelated reason (its camera-distance
   * crossfade).
   *
   * Snapping fixes it because a jump of exactly one grid step puts every vertex
   * where its neighbour just was, so the sampled surface is IDENTICAL before and
   * after — the centre moves and the terrain does not budge.
   *
   * WHY THE COARSEST STEP AND NOT A CONSTANT. The levels use steps
   * BASE_STEP × 2^lod (2, 4, 8, 16, 32 at the shipped 2048/1024 config).
   * Snapping to the coarsest one lands EVERY level on its own grid, because each
   * finer step divides it, and keeps all the rings on a common lattice so no
   * seam can open between them. v3/app/main.js's play path had its own
   * `LOD_SNAP = 16`, which is a step too small — it left the outermost ring
   * sliding half a step — and only ran in playMode, so the modular-road game
   * (which uses its own vehicle, not playMode) fell through to the raw,
   * unsnapped call and got the full artefact.
   *
   * Doing it HERE rather than at the call sites means no caller can get it
   * wrong; snapping an already-snapped value is idempotent, so the play path's
   * own rounding is now simply redundant.
   */
  function update(center) {
    const q = LOD_CENTRE_SNAP;
    const cx = Math.round(center.x / q) * q;
    const cz = Math.round(center.z / q) * q;
    for (const { mesh, uCenter } of levels) {
      mesh.position.set(cx, 0, cz);
      uCenter.value.set(cx, cz);
    }
  }

  /**
   * Build a SECOND material set at a different feature level, without touching
   * the live one.
   *
   * Exists because a feature flag is compile-time, so comparing two of them
   * would otherwise need a page reload — and a reload cannot be compared
   * against the previous one on a laptop GPU whose clock moves between runs
   * (measured: the same scene ran 60 fps / 4 ms and later 1.3 fps / 64 ms with
   * no code change, purely from the GPU sitting at 15% clock). Pre-building
   * both sets and swapping them in the same second makes the A/B immune to
   * that: the two measurements share a clock.
   *
   * The uCenter uniform is SHARED with the live material rather than recreated,
   * so a swapped-in variant keeps following the camera exactly as before.
   *
   * @param {object} features see TERRAIN_FEATURES
   * @returns {THREE.Material[]} one per LOD level, index-aligned with `levels`
   */
  function buildVariant(features) {
    return levels.map(({ uCenter }) => createLODMaterial(
      heightTexNode, uCenter, uCursorUV, uCursorRadius, uBrushMaskNode,
      uMaskRotation, splatOverlay, snowShared, lakebed, groundProc, features,
    ));
  }

  /** Swap a set built by buildVariant() onto the live meshes. */
  function setVariant(mats) {
    if (!Array.isArray(mats) || mats.length !== levels.length) return false;
    for (let i = 0; i < levels.length; i++) levels[i].mesh.material = mats[i];
    return true;
  }

  return { group, update, levels, buildVariant, setVariant };
}
