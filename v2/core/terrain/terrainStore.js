import * as THREE from "three";
import {
  chunkKey,
  chunkMinWorldX,
  chunkMinWorldZ,
  getChunkCountPerAxis,
  getChunkDataIndex,
  isValidChunkCoord,
  worldHalf,
  worldToChunkIndex,
} from "./chunkMath.js";
import { terrainGenHeightAtWorld } from "./proceduralTerrainGen.js";
import { sculptFbm } from "./sculptNoiseFbm.js";

export class TerrainStore {
  constructor(config) {
    this.config = config;
    this.chunkDataMap = new Map();
  }

  ensureChunkData(cx, cz) {
    const key = chunkKey(cx, cz);
    const existing = this.chunkDataMap.get(key);
    if (existing) return existing;

    const res = this.config.world.dataResolution;
    const perAxis = res + 1;
    const heights = new Float32Array(perAxis * perAxis);
    const minX = chunkMinWorldX(cx, this.config);
    const minZ = chunkMinWorldZ(cz, this.config);
    const step = this.config.world.chunkSize / res;

    const flat = !!this.config.world.flatInitialTerrain;
    const flatY = this.config.world.initialHeight ?? 0;
    for (let iz = 0; iz <= res; iz++) {
      const wz = minZ + iz * step;
      for (let ix = 0; ix <= res; ix++) {
        const wx = minX + ix * step;
        heights[getChunkDataIndex(ix, iz, this.config)] = flat
          ? flatY
          : this.sampleInitialHeight(wx, wz);
      }
    }

    this.stitchNewChunkFromNeighbors(cx, cz, heights);
    this.chunkDataMap.set(key, heights);
    return heights;
  }

  getChunkHeightsByKey(key) {
    return this.chunkDataMap.get(key) ?? null;
  }

  restoreChunkHeightsFromMap(snapshotMap) {
    for (const [key, values] of snapshotMap) {
      this.chunkDataMap.set(key, new Float32Array(values));
    }
  }

  sampleInitialHeight(wx, wz) {
    const s = this.config.world.size;
    const nx = wx / s + 0.5;
    const nz = wz / s + 0.5;
    const base = fbm(nx * 2.1, nz * 2.1, 5) * 22;
    const ridge = fbmRidge(nx * 3.2 + 8.1, nz * 3.2 - 6.7, 5) * 14;
    return base + ridge - 10;
  }

  sampleChunkHeight(cx, cz, localX, localZ) {
    const res = this.config.world.dataResolution;
    const heights = this.ensureChunkData(cx, cz);
    const x = THREE.MathUtils.clamp(localX, 0, res);
    const z = THREE.MathUtils.clamp(localZ, 0, res);
    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const x1 = Math.min(res, x0 + 1);
    const z1 = Math.min(res, z0 + 1);
    const tx = x - x0;
    const tz = z - z0;

    const h00 = heights[getChunkDataIndex(x0, z0, this.config)];
    const h10 = heights[getChunkDataIndex(x1, z0, this.config)];
    const h01 = heights[getChunkDataIndex(x0, z1, this.config)];
    const h11 = heights[getChunkDataIndex(x1, z1, this.config)];
    return THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(h00, h10, tx),
      THREE.MathUtils.lerp(h01, h11, tx),
      tz,
    );
  }

  getWorldHeight(wx, wz) {
    const { cx, cz } = worldToChunkIndex(wx, wz, this.config);
    if (!isValidChunkCoord(cx, cz, this.config)) return 0;
    return this.getChunkHeightfieldHeight(wx, wz);
  }

  /**
   * Raw heightfield from chunk data only (matches `splatmap-chunks.html` getChunkHeightfieldHeight).
   * Clamped chunk indices keep boundary sampling — and FD normals — aligned with V1.
   */
  getChunkHeightfieldHeight(wx, wz) {
    const cs = this.config.world.chunkSize;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const half = worldHalf(this.config);
    let cx = Math.floor((wx + half) / cs);
    let cz = Math.floor((wz + half) / cs);
    cx = THREE.MathUtils.clamp(cx, 0, maxC);
    cz = THREE.MathUtils.clamp(cz, 0, maxC);
    const minX = chunkMinWorldX(cx, this.config);
    const minZ = chunkMinWorldZ(cz, this.config);
    const res = this.config.world.dataResolution;
    const u = ((wx - minX) / cs) * res;
    const v = ((wz - minZ) / cs) * res;
    return this.sampleChunkHeight(cx, cz, u, v);
  }

  /**
   * Iterates chunks in the brush AABB, loops local cells only inside the brush
   * circle, writes heights directly to each chunk's Float32Array, and tracks a
   * per-chunk dirty rect. Shared edge/corner verts are propagated inline to
   * neighboring chunks so seams stay consistent without post-pass stitching.
   *
   * @param {object} stroke
   * @param {Map<string, {minIx:number,maxIx:number,minIz:number,maxIz:number}>} dirtyChunks
   */
  applySculptStroke(stroke, dirtyChunks) {
    const res = this.config.world.dataResolution;
    const stride = res + 1;
    const cs = this.config.world.chunkSize;
    const step = cs / res;
    const worldHalfV = this.config.world.size * 0.5;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const cmin = this.config.sculpt.sculptClampMin;
    const cmax = this.config.sculpt.sculptClampMax;

    const minCX = Math.max(0, Math.floor((stroke.minX + worldHalfV) / cs));
    const maxCX = Math.min(maxC, Math.floor((stroke.maxX + worldHalfV) / cs));
    const minCZ = Math.max(0, Math.floor((stroke.minZ + worldHalfV) / cs));
    const maxCZ = Math.min(maxC, Math.floor((stroke.maxZ + worldHalfV) / cs));

    const r = stroke.radius;
    const r2 = r * r;
    const invR = 1 / r;
    const bcx = stroke.cx;
    const bcz = stroke.cz;

    // PNG stamp mask — modulates only "stamp" deltas (raise/lower, noise, fbmPeak,
    // terrace). Smooth/flatten ignore it because masking those produces splotchy,
    // half-applied averaging that is rarely what users want.
    const maskAllowedMode =
      stroke.mode === "raiseLower" ||
      stroke.mode === "noise" ||
      stroke.mode === "fbmPeak" ||
      stroke.mode === "terrace";
    const maskData = maskAllowedMode ? stroke.maskData ?? null : null;
    const maskSize = maskData ? stroke.maskSize ?? 0 : 0;
    const maskRot = stroke.maskRotation ?? 0;
    const maskCos = maskData ? Math.cos(maskRot) : 1;
    const maskSin = maskData ? Math.sin(maskRot) : 0;
    const invDiameter = 1 / (2 * r);

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const heights = this.ensureChunkData(cx, cz);
        const chunkMinX = chunkMinWorldX(cx, this.config);
        const chunkMinZ = chunkMinWorldZ(cz, this.config);

        // Local (ix,iz) window inside this chunk that overlaps the brush AABB.
        let lMinX = Math.floor((stroke.minX - chunkMinX) / step);
        let lMaxX = Math.ceil((stroke.maxX - chunkMinX) / step);
        let lMinZ = Math.floor((stroke.minZ - chunkMinZ) / step);
        let lMaxZ = Math.ceil((stroke.maxZ - chunkMinZ) / step);
        if (lMinX < 0) lMinX = 0;
        if (lMinZ < 0) lMinZ = 0;
        if (lMaxX > res) lMaxX = res;
        if (lMaxZ > res) lMaxZ = res;
        if (lMinX > lMaxX || lMinZ > lMaxZ) continue;

        for (let iz = lMinZ; iz <= lMaxZ; iz++) {
          const wz = chunkMinZ + iz * step;
          const dz = wz - bcz;
          const dz2 = dz * dz;
          for (let ix = lMinX; ix <= lMaxX; ix++) {
            const wx = chunkMinX + ix * step;
            const dx = wx - bcx;
            const d2 = dx * dx + dz2;
            if (d2 > r2) continue;
            const dist = Math.sqrt(d2);
            const t = 1 - dist * invR;
            if (t <= 0) continue;

            // Sample PNG mask in brush-local space (rotated). Zero-mask cells are
            // skipped entirely — matches the paint-side cull in splatStore.
            let maskMul = 1;
            if (maskData) {
              const rx = dx * maskCos - dz * maskSin;
              const rz = dx * maskSin + dz * maskCos;
              const mu = rx * invDiameter + 0.5;
              const mv = rz * invDiameter + 0.5;
              if (mu < 0 || mu > 1 || mv < 0 || mv > 1) continue;
              maskMul = _sampleSculptMask(maskData, maskSize, mu, mv);
              if (maskMul <= 0.001) continue;
            }
            let falloff = 1;
            if (stroke.mode === "noise") {
              // v1 `applyNoiseAt`: (1 - dist/r)^2, independent of brush falloff slider.
              falloff = t * t;
            } else if (stroke.mode === "raiseLower" && stroke.raiseLowerStamp === "plateau") {
              // v1 `applyRaiseLowerAt` + `brush === "plateau"`: td = dist/r, flat mesa, ×0.7 (ignores Shape slider).
              const td = dist * invR;
              const flat = Math.max(0, 1 - Math.pow(Math.max(0, td - 0.6) / 0.4, 2));
              falloff = flat * 0.7;
              if (falloff <= 0) continue;
            } else if (stroke.mode === "raiseLower" && stroke.raiseLowerStamp === "crater") {
              // v1 `applyRaiseLowerAt` + `brush === "crater"`: rim at td≈0.55 minus pit near center, ×0.8.
              // Signed delta (can be negative near the pit); keep it here and multiply by strength*sign in the stamp branch.
              // Stored in `falloff` for uniformity; stamp branch detects crater via raiseLowerStamp.
              const td = dist * invR;
              const rim = Math.exp(-Math.pow(td - 0.55, 2) / 0.04) * 1.2;
              const pit = Math.max(0, 1 - td * 4) * 0.6;
              falloff = (rim - pit) * 0.8;
              if (falloff === 0) continue;
            } else if (stroke.mode === "terrace") {
              // v1 `applyTerraceAt`: falloff = (1 - t^2)^2 ≈ (1 - (dist/r)^2)^2, independent of falloff slider.
              const tt = dist * invR;
              const one = 1 - tt * tt;
              falloff = one * one;
              if (falloff <= 0) continue;
            } else if (stroke.mode === "raiseLower") {
              // Default `smooth` stamp: v1 `brushFalloff(td)` enum — cosine / linear / sphere / hard.
              // v1 passes td = dist/radius (0 at center → 1 at edge); our `t` is the complement.
              falloff = evalBrushFalloff(1 - t, stroke.brushFalloff);
              if (falloff <= 0) continue;
            } else if (stroke.mode !== "fbmPeak") {
              falloff = Math.pow(t, stroke.falloff);
              if (falloff <= 0) continue;
            }

            // One world height sample can appear as multiple (chunk, ix, iz) cells.
            // Only the lexicographically smallest chunk among sharers may apply the
            // brush when that owner is also in this stroke's chunk window; otherwise
            // the same vertex would be displaced once per overlapping chunk.
            if (
              shouldSkipSculptBecauseOwnerInStroke(
                cx,
                cz,
                ix,
                iz,
                res,
                maxC,
                minCX,
                maxCX,
                minCZ,
                maxCZ,
              )
            ) {
              continue;
            }

            const idx = iz * stride + ix;
            const current = heights[idx];
            let next = current;
            if (stroke.mode === "raiseLower") {
              // Plateau / crater / default smooth all end here; `falloff` already baked in per-stamp.
              next = current + stroke.strength * stroke.sign * falloff;
            } else if (stroke.mode === "terrace") {
              // v1 `applyTerraceAt`: snap to floor(h/stepH)*stepH + S-curve inside the step, lerp by falloff*strength*3.
              const stepH = stroke.terrace?.step ?? 4;
              const sharp = THREE.MathUtils.clamp(stroke.terrace?.sharpness ?? 0.6, 0.05, 0.95);
              const floored = Math.floor(current / stepH) * stepH;
              const frac = (current - floored) / stepH;
              const curved =
                frac < sharp
                  ? (frac * (1 - sharp)) / sharp
                  : ((frac - sharp) / (1 - sharp)) * sharp + (1 - sharp);
              const snapped = floored + curved * stepH;
              next = current + (snapped - current) * falloff * stroke.strength * 3;
            } else if (stroke.mode === "fbmPeak") {
              // splatmap-chunks.html `fbm_peak` — ridge FBM in brush space + radial spike (v2: tunable).
              const fp = stroke.fbmPeak;
              const freqMul = fp?.freqMul ?? 1;
              const oct = THREE.MathUtils.clamp(Math.round(fp?.octaves ?? 6), 1, 8);
              const spikePow = fp?.spikePower ?? 2.5;
              const base = fp?.base ?? 0.35;
              const ridgeW = fp?.ridgeWeight ?? 1.8;
              const gain = fp?.gain ?? 2.0;
              const ridgeSc = (3.5 * freqMul) / r;
              const ridge = fbmRidge(
                dx * ridgeSc + stroke.seed,
                dz * ridgeSc + stroke.seed,
                oct,
              );
              const spike = Math.pow(Math.max(0, t), spikePow);
              const shape = spike * (base + ridge * ridgeW);
              const delta = stroke.sign * Math.max(0, shape) * stroke.strength * gain;
              next = current + delta;
            } else if (stroke.mode === "flatten") {
              next = current + (stroke.flattenTargetY - current) * (falloff * stroke.strength);
            } else if (stroke.mode === "noise") {
              // v1 `applyNoiseAt`: freq = noiseScale / radius, FBM octaves, delta = (fbm-0.5)*falloff*strength*4
              const freq = (stroke.noiseScale ?? 2.5) / Math.max(r, 1e-6);
              const oct = THREE.MathUtils.clamp(Math.round(stroke.noiseOctaves ?? 2), 1, 8);
              const n =
                sculptFbm(
                  wx * freq + stroke.seed,
                  wz * freq + stroke.seed * 1.3,
                  oct,
                ) - 0.5;
              const delta = n * falloff * stroke.strength * 4;
              next = current + delta;
            } else if (stroke.mode === "smooth") {
              const avg = this.sampleNeighborhood(wx, wz, step * 1.4);
              next = current + (avg - current) * (falloff * stroke.strength);
            }
            if (maskData) {
              next = current + (next - current) * maskMul;
            }
            if (next < cmin) next = cmin;
            else if (next > cmax) next = cmax;

            heights[idx] = next;
            markRect(dirtyChunks, cx, cz, ix, iz);

            // Shared-vertex propagation: edges and corners live in multiple
            // chunks. Write the twin slots inline so seams remain bit-equal.
            const onL = ix === 0;
            const onR = ix === res;
            const onT = iz === 0;
            const onB = iz === res;
            if (onL && cx > 0) {
              const h = this.ensureChunkData(cx - 1, cz);
              h[iz * stride + res] = next;
              markRect(dirtyChunks, cx - 1, cz, res, iz);
            }
            if (onR && cx < maxC) {
              const h = this.ensureChunkData(cx + 1, cz);
              h[iz * stride + 0] = next;
              markRect(dirtyChunks, cx + 1, cz, 0, iz);
            }
            if (onT && cz > 0) {
              const h = this.ensureChunkData(cx, cz - 1);
              h[res * stride + ix] = next;
              markRect(dirtyChunks, cx, cz - 1, ix, res);
            }
            if (onB && cz < maxC) {
              const h = this.ensureChunkData(cx, cz + 1);
              h[0 * stride + ix] = next;
              markRect(dirtyChunks, cx, cz + 1, ix, 0);
            }
            if (onL && onT && cx > 0 && cz > 0) {
              const h = this.ensureChunkData(cx - 1, cz - 1);
              h[res * stride + res] = next;
              markRect(dirtyChunks, cx - 1, cz - 1, res, res);
            }
            if (onL && onB && cx > 0 && cz < maxC) {
              const h = this.ensureChunkData(cx - 1, cz + 1);
              h[0 * stride + res] = next;
              markRect(dirtyChunks, cx - 1, cz + 1, res, 0);
            }
            if (onR && onT && cx < maxC && cz > 0) {
              const h = this.ensureChunkData(cx + 1, cz - 1);
              h[res * stride + 0] = next;
              markRect(dirtyChunks, cx + 1, cz - 1, 0, res);
            }
            if (onR && onB && cx < maxC && cz < maxC) {
              const h = this.ensureChunkData(cx + 1, cz + 1);
              h[0] = next;
              markRect(dirtyChunks, cx + 1, cz + 1, 0, 0);
            }
          }
        }
      }
    }
  }

  flattenUnderRoad(curve, width, segments, heightOffset, dirtyChunks) {
    const res = this.config.world.dataResolution;
    const stride = res + 1;
    const cs = this.config.world.chunkSize;
    const step = cs / res;
    const half = this.config.world.size * 0.5;
    const maxC = getChunkCountPerAxis(this.config) - 1;

    const halfW = width * 0.5;
    const margin = halfW * 1.5;
    const pts = curve.getSpacedPoints(segments);

    const minWX = Math.min(...pts.map(p => p.x)) - margin;
    const maxWX = Math.max(...pts.map(p => p.x)) + margin;
    const minWZ = Math.min(...pts.map(p => p.z)) - margin;
    const maxWZ = Math.max(...pts.map(p => p.z)) + margin;

    const minCX = Math.max(0, Math.floor((minWX + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((maxWX + half) / cs));
    const minCZ = Math.max(0, Math.floor((minWZ + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((maxWZ + half) / cs));

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const heights = this.ensureChunkData(cx, cz);
        const chunkMinX = chunkMinWorldX(cx, this.config);
        const chunkMinZ = chunkMinWorldZ(cz, this.config);

        const lMinX = Math.max(0, Math.floor((minWX - chunkMinX) / step));
        const lMaxX = Math.min(res, Math.ceil((maxWX - chunkMinX) / step));
        const lMinZ = Math.max(0, Math.floor((minWZ - chunkMinZ) / step));
        const lMaxZ = Math.min(res, Math.ceil((maxWZ - chunkMinZ) / step));
        if (lMinX > lMaxX || lMinZ > lMaxZ) continue;

        for (let iz = lMinZ; iz <= lMaxZ; iz++) {
          const wz = chunkMinZ + iz * step;
          for (let ix = lMinX; ix <= lMaxX; ix++) {
            const wx = chunkMinX + ix * step;

            let bestDist = Infinity;
            let bestY = 0;
            for (let k = 0; k < pts.length - 1; k++) {
              const ax = pts[k].x, az = pts[k].z;
              const bx = pts[k + 1].x, bz = pts[k + 1].z;
              const dx = bx - ax, dz = bz - az;
              const lenSq = dx * dx + dz * dz;
              let t = 0;
              if (lenSq > 1e-8) {
                t = ((wx - ax) * dx + (wz - az) * dz) / lenSq;
                t = Math.max(0, Math.min(1, t));
              }
              const px = ax + t * dx, pz = az + t * dz;
              const ex = wx - px, ez = wz - pz;
              const d = Math.sqrt(ex * ex + ez * ez);
              if (d < bestDist) {
                bestDist = d;
                bestY = pts[k].y * (1 - t) + pts[k + 1].y * t;
              }
            }

            if (bestDist > margin) continue;

            const idx = iz * stride + ix;
            const current = heights[idx];
            let next;
            if (bestDist <= halfW) {
              // Under the road: fully flatten to the spline height
              next = bestY - heightOffset;
            } else {
              // Margin zone: smoothly blend from spline height at road edge
              // back to the CURRENT terrain height (not spline Y) so the
              // transition doesn't carve deep corridors into hillsides.
              let blend = 1 - (bestDist - halfW) / (margin - halfW);
              blend = blend * blend * (3 - 2 * blend);
              const roadEdgeY = bestY - heightOffset;
              next = current + (roadEdgeY - current) * blend;
            }
            heights[idx] = next;

            const key = chunkKey(cx, cz);
            const existing = dirtyChunks.get(key);
            if (!existing) {
              dirtyChunks.set(key, { minIx: ix, maxIx: ix, minIz: iz, maxIz: iz });
            } else {
              if (ix < existing.minIx) existing.minIx = ix;
              if (ix > existing.maxIx) existing.maxIx = ix;
              if (iz < existing.minIz) existing.minIz = iz;
              if (iz > existing.maxIz) existing.maxIz = iz;
            }

            const onL = ix === 0, onR = ix === res;
            const onT = iz === 0, onB = iz === res;
            if (onL && cx > 0) {
              const h = this.ensureChunkData(cx - 1, cz);
              h[iz * stride + res] = next;
              const k2 = chunkKey(cx - 1, cz);
              const e2 = dirtyChunks.get(k2);
              if (!e2) dirtyChunks.set(k2, { minIx: res, maxIx: res, minIz: iz, maxIz: iz });
              else { if (res < e2.minIx) e2.minIx = res; if (res > e2.maxIx) e2.maxIx = res; if (iz < e2.minIz) e2.minIz = iz; if (iz > e2.maxIz) e2.maxIz = iz; }
            }
            if (onR && cx < maxC) {
              const h = this.ensureChunkData(cx + 1, cz);
              h[iz * stride + 0] = next;
              const k2 = chunkKey(cx + 1, cz);
              const e2 = dirtyChunks.get(k2);
              if (!e2) dirtyChunks.set(k2, { minIx: 0, maxIx: 0, minIz: iz, maxIz: iz });
              else { if (0 < e2.minIx) e2.minIx = 0; if (0 > e2.maxIx) e2.maxIx = 0; if (iz < e2.minIz) e2.minIz = iz; if (iz > e2.maxIz) e2.maxIz = iz; }
            }
            if (onT && cz > 0) {
              const h = this.ensureChunkData(cx, cz - 1);
              h[res * stride + ix] = next;
              const k2 = chunkKey(cx, cz - 1);
              const e2 = dirtyChunks.get(k2);
              if (!e2) dirtyChunks.set(k2, { minIx: ix, maxIx: ix, minIz: res, maxIz: res });
              else { if (ix < e2.minIx) e2.minIx = ix; if (ix > e2.maxIx) e2.maxIx = ix; if (res < e2.minIz) e2.minIz = res; if (res > e2.maxIz) e2.maxIz = res; }
            }
            if (onB && cz < maxC) {
              const h = this.ensureChunkData(cx, cz + 1);
              h[0 * stride + ix] = next;
              const k2 = chunkKey(cx, cz + 1);
              const e2 = dirtyChunks.get(k2);
              if (!e2) dirtyChunks.set(k2, { minIx: ix, maxIx: ix, minIz: 0, maxIz: 0 });
              else { if (ix < e2.minIx) e2.minIx = ix; if (ix > e2.maxIx) e2.maxIx = ix; if (0 < e2.minIz) e2.minIz = 0; if (0 > e2.maxIz) e2.maxIz = 0; }
            }
          }
        }
      }
    }
  }

  /**
   * Conform terrain to a road's SURFACE height, vertex by vertex (Smart Road 2).
   * Unlike `flattenUnderRoad` (which sets terrain to the spine centerline height),
   * each heightmap vertex is set to `getSurfaceH(vertexX, vertexZ) - embedDepth`,
   * so deck-minus-terrain is CONSTANT across the whole road and on slopes — no
   * clip on the downhill edge, no float on the uphill side.
   *
   * @param footprints [{ pts:[{x,z}…] }]  road spines (centerlines / junction spokes)
   * @param getSurfaceH (x,z)=>y           road surface height (deck minus clearance)
   * @param halfW       road half width
   * @param embedDepth  terrain sits this far below the surface under the road
   * @param shoulder    blend distance from full-flatten edge back to terrain
   * @param dirtyChunks Map filled with per-chunk dirty rects (for remeshing)
   */
  conformToRoadSurface(footprints, getSurfaceH, halfW, embedDepth, shoulder, dirtyChunks) {
    if (!Array.isArray(footprints) || footprints.length === 0) return;
    const res = this.config.world.dataResolution;
    const stride = res + 1;
    const cs = this.config.world.chunkSize;
    const step = cs / res;
    const half = this.config.world.size * 0.5;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    // Full-flatten reach: one terrain cell past the deck edge so no terrain
    // triangle can straddle the road edge (the lab's footprintInner rule).
    const inner = halfW + 1 + step;
    const outer = Math.max(0.01, shoulder);
    const reach = inner + outer;

    const segDistSq = (px, pz, ax, az, bx, bz) => {
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      let t = 0;
      if (lenSq > 1e-8) t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
      const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
      return ex * ex + ez * ez;
    };
    const nearestDist = (wx, wz) => {
      let best = Infinity;
      for (const fp of footprints) {
        const pts = fp.pts;
        for (let k = 0; k < pts.length - 1; k++) {
          const d = segDistSq(wx, wz, pts[k].x, pts[k].z, pts[k + 1].x, pts[k + 1].z);
          if (d < best) best = d;
        }
        if (pts.length === 1) {
          const ex = wx - pts[0].x, ez = wz - pts[0].z;
          const d = ex * ex + ez * ez;
          if (d < best) best = d;
        }
      }
      return Math.sqrt(best);
    };

    // Union bbox of all footprints.
    let minWX = Infinity, maxWX = -Infinity, minWZ = Infinity, maxWZ = -Infinity;
    for (const fp of footprints) {
      for (const p of fp.pts) {
        if (p.x < minWX) minWX = p.x;
        if (p.x > maxWX) maxWX = p.x;
        if (p.z < minWZ) minWZ = p.z;
        if (p.z > maxWZ) maxWZ = p.z;
      }
    }
    minWX -= reach; maxWX += reach; minWZ -= reach; maxWZ += reach;

    const minCX = Math.max(0, Math.floor((minWX + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((maxWX + half) / cs));
    const minCZ = Math.max(0, Math.floor((minWZ + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((maxWZ + half) / cs));

    // PASS 1 — compute target heights from the ORIGINAL terrain (getSurfaceH
    // disc-samples getWorldHeight, so no writes may happen yet or it feeds back).
    const targets = []; // { cx, cz, ix, iz, idx, d, target }
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        this.ensureChunkData(cx, cz);
        const chunkMinX = chunkMinWorldX(cx, this.config);
        const chunkMinZ = chunkMinWorldZ(cz, this.config);
        const lMinX = Math.max(0, Math.floor((minWX - chunkMinX) / step));
        const lMaxX = Math.min(res, Math.ceil((maxWX - chunkMinX) / step));
        const lMinZ = Math.max(0, Math.floor((minWZ - chunkMinZ) / step));
        const lMaxZ = Math.min(res, Math.ceil((maxWZ - chunkMinZ) / step));
        if (lMinX > lMaxX || lMinZ > lMaxZ) continue;
        for (let iz = lMinZ; iz <= lMaxZ; iz++) {
          const wz = chunkMinZ + iz * step;
          for (let ix = lMinX; ix <= lMaxX; ix++) {
            const wx = chunkMinX + ix * step;
            const d = nearestDist(wx, wz);
            if (d >= reach) continue;
            targets.push({ cx, cz, ix, iz, idx: iz * stride + ix, d, target: getSurfaceH(wx, wz) - embedDepth });
          }
        }
      }
    }

    // PASS 2 — write blended heights + shared-edge propagation + dirty rects.
    const bump = (key, ix, iz) => {
      const e = dirtyChunks.get(key);
      if (!e) dirtyChunks.set(key, { minIx: ix, maxIx: ix, minIz: iz, maxIz: iz });
      else {
        if (ix < e.minIx) e.minIx = ix; if (ix > e.maxIx) e.maxIx = ix;
        if (iz < e.minIz) e.minIz = iz; if (iz > e.maxIz) e.maxIz = iz;
      }
    };
    for (const tg of targets) {
      const heights = this.ensureChunkData(tg.cx, tg.cz);
      const current = heights[tg.idx];
      const s = tg.d <= inner ? 0 : (() => { const u = (tg.d - inner) / outer; return u * u * (3 - 2 * u); })();
      const next = tg.target + (current - tg.target) * s;
      heights[tg.idx] = next;
      bump(chunkKey(tg.cx, tg.cz), tg.ix, tg.iz);

      const onL = tg.ix === 0, onR = tg.ix === res, onT = tg.iz === 0, onB = tg.iz === res;
      if (onL && tg.cx > 0) { this.ensureChunkData(tg.cx - 1, tg.cz)[tg.iz * stride + res] = next; bump(chunkKey(tg.cx - 1, tg.cz), res, tg.iz); }
      if (onR && tg.cx < maxC) { this.ensureChunkData(tg.cx + 1, tg.cz)[tg.iz * stride + 0] = next; bump(chunkKey(tg.cx + 1, tg.cz), 0, tg.iz); }
      if (onT && tg.cz > 0) { this.ensureChunkData(tg.cx, tg.cz - 1)[res * stride + tg.ix] = next; bump(chunkKey(tg.cx, tg.cz - 1), tg.ix, res); }
      if (onB && tg.cz < maxC) { this.ensureChunkData(tg.cx, tg.cz + 1)[0 * stride + tg.ix] = next; bump(chunkKey(tg.cx, tg.cz + 1), tg.ix, 0); }
    }
  }

  /**
   * Lower-only carve along a pre-sampled polyline (tunnel-mouth trenches).
   * `pts` carry the desired floor Y in `.y`. Terrain inside `halfW` of the
   * polyline is pulled DOWN to that target (never raised); between `halfW`
   * and `margin` the pull blends out smoothly. Same chunk-write + shared-edge
   * propagation scheme as `flattenUnderRoad`, so no post-pass stitching is
   * needed. Fills `dirtyChunks` with per-chunk dirty rects.
   */
  lowerTerrainAlongPoints(pts, halfW, margin, dirtyChunks) {
    if (!Array.isArray(pts) || pts.length < 2) return;
    const res = this.config.world.dataResolution;
    const stride = res + 1;
    const cs = this.config.world.chunkSize;
    const step = cs / res;
    const half = this.config.world.size * 0.5;
    const maxC = getChunkCountPerAxis(this.config) - 1;

    const minWX = Math.min(...pts.map((p) => p.x)) - margin;
    const maxWX = Math.max(...pts.map((p) => p.x)) + margin;
    const minWZ = Math.min(...pts.map((p) => p.z)) - margin;
    const maxWZ = Math.max(...pts.map((p) => p.z)) + margin;

    const minCX = Math.max(0, Math.floor((minWX + half) / cs));
    const maxCX = Math.min(maxC, Math.floor((maxWX + half) / cs));
    const minCZ = Math.max(0, Math.floor((minWZ + half) / cs));
    const maxCZ = Math.min(maxC, Math.floor((maxWZ + half) / cs));

    const markDirty = (key, ix, iz) => {
      const e = dirtyChunks.get(key);
      if (!e) dirtyChunks.set(key, { minIx: ix, maxIx: ix, minIz: iz, maxIz: iz });
      else {
        if (ix < e.minIx) e.minIx = ix;
        if (ix > e.maxIx) e.maxIx = ix;
        if (iz < e.minIz) e.minIz = iz;
        if (iz > e.maxIz) e.maxIz = iz;
      }
    };

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const heights = this.ensureChunkData(cx, cz);
        const chunkMinX = chunkMinWorldX(cx, this.config);
        const chunkMinZ = chunkMinWorldZ(cz, this.config);

        const lMinX = Math.max(0, Math.floor((minWX - chunkMinX) / step));
        const lMaxX = Math.min(res, Math.ceil((maxWX - chunkMinX) / step));
        const lMinZ = Math.max(0, Math.floor((minWZ - chunkMinZ) / step));
        const lMaxZ = Math.min(res, Math.ceil((maxWZ - chunkMinZ) / step));
        if (lMinX > lMaxX || lMinZ > lMaxZ) continue;

        for (let iz = lMinZ; iz <= lMaxZ; iz++) {
          const wz = chunkMinZ + iz * step;
          for (let ix = lMinX; ix <= lMaxX; ix++) {
            const wx = chunkMinX + ix * step;

            let bestDist = Infinity;
            let bestY = 0;
            for (let k = 0; k < pts.length - 1; k++) {
              const ax = pts[k].x, az = pts[k].z;
              const bx = pts[k + 1].x, bz = pts[k + 1].z;
              const dx = bx - ax, dz = bz - az;
              const lenSq = dx * dx + dz * dz;
              let t = 0;
              if (lenSq > 1e-8) {
                t = ((wx - ax) * dx + (wz - az) * dz) / lenSq;
                t = Math.max(0, Math.min(1, t));
              }
              const px = ax + t * dx, pz = az + t * dz;
              const ex = wx - px, ez = wz - pz;
              const d = Math.sqrt(ex * ex + ez * ez);
              if (d < bestDist) {
                bestDist = d;
                bestY = pts[k].y * (1 - t) + pts[k + 1].y * t;
              }
            }
            if (bestDist > margin) continue;

            const idx = iz * stride + ix;
            const current = heights[idx];
            let next;
            if (bestDist <= halfW) {
              next = Math.min(current, bestY);
            } else {
              let blend = 1 - (bestDist - halfW) / (margin - halfW);
              blend = blend * blend * (3 - 2 * blend);
              next = Math.min(current, current + (bestY - current) * blend);
            }
            if (next === current) continue;
            heights[idx] = next;
            markDirty(chunkKey(cx, cz), ix, iz);

            const onL = ix === 0, onR = ix === res;
            const onT = iz === 0, onB = iz === res;
            if (onL && cx > 0) {
              this.ensureChunkData(cx - 1, cz)[iz * stride + res] = next;
              markDirty(chunkKey(cx - 1, cz), res, iz);
            }
            if (onR && cx < maxC) {
              this.ensureChunkData(cx + 1, cz)[iz * stride + 0] = next;
              markDirty(chunkKey(cx + 1, cz), 0, iz);
            }
            if (onT && cz > 0) {
              this.ensureChunkData(cx, cz - 1)[res * stride + ix] = next;
              markDirty(chunkKey(cx, cz - 1), ix, res);
            }
            if (onB && cz < maxC) {
              this.ensureChunkData(cx, cz + 1)[0 * stride + ix] = next;
              markDirty(chunkKey(cx, cz + 1), ix, 0);
            }
          }
        }
      }
    }
  }

  sampleNeighborhood(wx, wz, radius) {
    const taps = [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
      [radius * 0.7, radius * 0.7],
      [-radius * 0.7, radius * 0.7],
      [radius * 0.7, -radius * 0.7],
      [-radius * 0.7, -radius * 0.7],
    ];
    let sum = 0;
    for (const [ox, oz] of taps) sum += this.getWorldHeight(wx + ox, wz + oz);
    return sum / taps.length;
  }

  syncChunkEdgesAround(keys) {
    const expanded = new Set();
    for (const key of keys) {
      expanded.add(key);
      const [cx, cz] = key.split(",").map(Number);
      expanded.add(chunkKey(cx + 1, cz));
      expanded.add(chunkKey(cx - 1, cz));
      expanded.add(chunkKey(cx, cz + 1));
      expanded.add(chunkKey(cx, cz - 1));
    }
    for (const key of expanded) {
      const [cx, cz] = key.split(",").map(Number);
      this.syncChunkEdges(cx, cz, expanded);
    }
  }

  syncChunkEdges(cx, cz, allowedSet) {
    if (!isValidChunkCoord(cx, cz, this.config)) return;
    const res = this.config.world.dataResolution;
    const key = chunkKey(cx, cz);
    const h = this.chunkDataMap.get(key);
    if (!h) return;

    const rightKey = chunkKey(cx + 1, cz);
    if (allowedSet.has(rightKey) && this.chunkDataMap.has(rightKey)) {
      const r = this.chunkDataMap.get(rightKey);
      for (let iz = 0; iz <= res; iz++) {
        r[getChunkDataIndex(0, iz, this.config)] = h[getChunkDataIndex(res, iz, this.config)];
      }
    }
    const bottomKey = chunkKey(cx, cz + 1);
    if (allowedSet.has(bottomKey) && this.chunkDataMap.has(bottomKey)) {
      const b = this.chunkDataMap.get(bottomKey);
      for (let ix = 0; ix <= res; ix++) {
        b[getChunkDataIndex(ix, 0, this.config)] = h[getChunkDataIndex(ix, res, this.config)];
      }
    }
  }

  stitchNewChunkFromNeighbors(cx, cz, heights) {
    const res = this.config.world.dataResolution;
    const left = this.chunkDataMap.get(chunkKey(cx - 1, cz));
    if (left) {
      for (let iz = 0; iz <= res; iz++) {
        heights[getChunkDataIndex(0, iz, this.config)] =
          left[getChunkDataIndex(res, iz, this.config)];
      }
    }
    const right = this.chunkDataMap.get(chunkKey(cx + 1, cz));
    if (right) {
      for (let iz = 0; iz <= res; iz++) {
        heights[getChunkDataIndex(res, iz, this.config)] =
          right[getChunkDataIndex(0, iz, this.config)];
      }
    }
    const top = this.chunkDataMap.get(chunkKey(cx, cz - 1));
    if (top) {
      for (let ix = 0; ix <= res; ix++) {
        heights[getChunkDataIndex(ix, 0, this.config)] =
          top[getChunkDataIndex(ix, res, this.config)];
      }
    }
    const bottom = this.chunkDataMap.get(chunkKey(cx, cz + 1));
    if (bottom) {
      for (let ix = 0; ix <= res; ix++) {
        heights[getChunkDataIndex(ix, res, this.config)] =
          bottom[getChunkDataIndex(ix, 0, this.config)];
      }
    }
  }

  preloadChunksInRadius(centerWorldX, centerWorldZ, radiusInChunks) {
    const { cx, cz } = worldToChunkIndex(centerWorldX, centerWorldZ, this.config);
    const max = getChunkCountPerAxis(this.config);
    for (let dz = -radiusInChunks; dz <= radiusInChunks; dz++) {
      for (let dx = -radiusInChunks; dx <= radiusInChunks; dx++) {
        const x = cx + dx;
        const z = cz + dz;
        if (x < 0 || z < 0 || x >= max || z >= max) continue;
        this.ensureChunkData(x, z);
      }
    }
  }

  /**
   * Two-point height ramp — `splatmap-chunks.html` `applyRampAt`.
   * @param {{x:number,y:number,z:number}} ptA
   * @param {{x:number,y:number,z:number}} ptB
   * @param {number} radius — brush radius (corridor half-width in XZ)
   * @param {number} strength — v1 uses `PARAMS.brushStrength / 100`; pass same order (~0.02–1)
   * @param {{ crossExponent?: number, alongExponent?: number }} [rampOpts]
   * @returns {Set<string>} touched chunk keys
   */
  applyRampStroke(ptA, ptB, radius, strength, rampOpts = {}) {
    const dx = ptB.x - ptA.x;
    const dz = ptB.z - ptA.z;
    const lenSq = dx * dx + dz * dz;
    const touched = new Set();
    if (lenSq < 0.001) return touched;

    const crossExp = THREE.MathUtils.clamp(Number(rampOpts.crossExponent) || 2, 0.5, 12);
    const alongExp = THREE.MathUtils.clamp(Number(rampOpts.alongExponent) || 1, 0.2, 6);

    const radiusSq = radius * radius;
    const res = this.config.world.dataResolution;
    const stride = res + 1;
    const step = this.config.world.chunkSize / res;
    const cs = this.config.world.chunkSize;
    const cminH = this.config.sculpt.sculptClampMin;
    const cmaxH = this.config.sculpt.sculptClampMax;
    const worldHalfV = this.config.world.size * 0.5;
    const maxC = getChunkCountPerAxis(this.config) - 1;

    const minWX = Math.min(ptA.x, ptB.x) - radius;
    const maxWX = Math.max(ptA.x, ptB.x) + radius;
    const minWZ = Math.min(ptA.z, ptB.z) - radius;
    const maxWZ = Math.max(ptA.z, ptB.z) + radius;

    const minCX = THREE.MathUtils.clamp(Math.floor((minWX + worldHalfV) / cs), 0, maxC);
    const maxCX = THREE.MathUtils.clamp(Math.floor((maxWX + worldHalfV) / cs), 0, maxC);
    const minCZ = THREE.MathUtils.clamp(Math.floor((minWZ + worldHalfV) / cs), 0, maxC);
    const maxCZ = THREE.MathUtils.clamp(Math.floor((maxWZ + worldHalfV) / cs), 0, maxC);

    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const heights = this.ensureChunkData(cx, cz);
        const chunkMinX = chunkMinWorldX(cx, this.config);
        const chunkMinZ = chunkMinWorldZ(cz, this.config);
        let changed = false;

        for (let iz = 0; iz <= res; iz++) {
          const wz = chunkMinZ + iz * step;
          for (let ix = 0; ix <= res; ix++) {
            const wx = chunkMinX + ix * step;
            const t = THREE.MathUtils.clamp(
              ((wx - ptA.x) * dx + (wz - ptA.z) * dz) / lenSq,
              0,
              1,
            );
            const perpX = ptA.x + t * dx - wx;
            const perpZ = ptA.z + t * dz - wz;
            const perpSq = perpX * perpX + perpZ * perpZ;
            if (perpSq > radiusSq) continue;
            const u = Math.sqrt(perpSq) / radius;
            const falloff = Math.pow(Math.max(0, 1 - u), crossExp);
            const tH = Math.pow(t, alongExp);
            const targetY = ptA.y + tH * (ptB.y - ptA.y);
            const idx = iz * stride + ix;
            const current = heights[idx];
            const next = THREE.MathUtils.clamp(
              current + (targetY - current) * falloff * strength,
              cminH,
              cmaxH,
            );
            heights[idx] = next;
            changed = true;
          }
        }

        if (changed) {
          touched.add(chunkKey(cx, cz));
        }
      }
    }

    this.syncChunkEdgesAround(touched);
    return touched;
  }

  /** Chunk keys overlapping the ramp corridor AABB (for undo snapshots). */
  getChunkKeysInRampBounds(ptA, ptB, radius) {
    const keys = new Set();
    const dx = ptB.x - ptA.x;
    const dz = ptB.z - ptA.z;
    if (dx * dx + dz * dz < 0.001) return keys;
    const cs = this.config.world.chunkSize;
    const worldHalfV = this.config.world.size * 0.5;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const minWX = Math.min(ptA.x, ptB.x) - radius;
    const maxWX = Math.max(ptA.x, ptB.x) + radius;
    const minWZ = Math.min(ptA.z, ptB.z) - radius;
    const maxWZ = Math.max(ptA.z, ptB.z) + radius;
    const minCX = THREE.MathUtils.clamp(Math.floor((minWX + worldHalfV) / cs), 0, maxC);
    const maxCX = THREE.MathUtils.clamp(Math.floor((maxWX + worldHalfV) / cs), 0, maxC);
    const minCZ = THREE.MathUtils.clamp(Math.floor((minWZ + worldHalfV) / cs), 0, maxC);
    const maxCZ = THREE.MathUtils.clamp(Math.floor((maxWZ + worldHalfV) / cs), 0, maxC);
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        keys.add(chunkKey(cx, cz));
      }
    }
    return keys;
  }

  /**
   * Full-world procedural height — same as `splatmap-chunks.html` `applyProceduralTerrainToAllChunks`.
   * Overwrites every chunk heightfield; `additive` layers on previous heights per vertex.
   * @param {object} gen — same fields as v1 `PARAMS.gen`
   * @returns {Set<string>} all chunk keys written
   */
  applyProceduralTerrainToAllChunks(gen) {
    const worldSize = this.config.world.size;
    const maxC = getChunkCountPerAxis(this.config) - 1;
    const res = this.config.world.dataResolution;
    const count = (res + 1) * (res + 1);
    const step = this.config.world.chunkSize / res;
    const touched = new Set();

    for (let cz = 0; cz <= maxC; cz++) {
      for (let cx = 0; cx <= maxC; cx++) {
        const key = chunkKey(cx, cz);
        const prev = this.chunkDataMap.get(key) ?? null;
        const heights = new Float32Array(count);
        const minX = chunkMinWorldX(cx, this.config);
        const minZ = chunkMinWorldZ(cz, this.config);

        for (let iz = 0; iz <= res; iz++) {
          const wz = minZ + iz * step;
          for (let ix = 0; ix <= res; ix++) {
            const wx = minX + ix * step;
            const idx = getChunkDataIndex(ix, iz, this.config);
            const genH = terrainGenHeightAtWorld(wx, wz, gen, worldSize);
            heights[idx] = gen.additive && prev ? Math.max(0, prev[idx] + genH) : genH;
          }
        }

        this.chunkDataMap.set(key, heights);
        touched.add(key);
      }
    }

    this.syncChunkEdgesAround(touched);
    return touched;
  }
}

/**
 * v1 `brushFalloff(t)` — shape of the default raise/lower "smooth" stamp.
 * t = dist/radius. Returns 0..1.
 */
function evalBrushFalloff(t, kind) {
  if (t >= 1) return 0;
  if (t <= 0) return 1;
  switch (kind) {
    case "linear":
      return 1 - t;
    case "sphere":
      return Math.sqrt(1 - t * t);
    case "hard":
      return 1;
    case "smooth":
    default:
      return (1 + Math.cos(t * Math.PI)) * 0.5;
  }
}

function markRect(dirtyChunks, cx, cz, ix, iz) {
  const key = chunkKey(cx, cz);
  const existing = dirtyChunks.get(key);
  if (!existing) {
    dirtyChunks.set(key, { minIx: ix, maxIx: ix, minIz: iz, maxIz: iz });
    return;
  }
  if (ix < existing.minIx) existing.minIx = ix;
  if (ix > existing.maxIx) existing.maxIx = ix;
  if (iz < existing.minIz) existing.minIz = iz;
  if (iz > existing.maxIz) existing.maxIz = iz;
}

/**
 * Returns true if this (cx,cz,ix,iz) is not the canonical copy of the vertex
 * for sculpting, and the canonical chunk is part of the current stroke — so
 * this cell should not apply the brush (the owner will propagate here).
 */
/** Bilinear sample of a Float32 grayscale brush mask — mirrors splatStore._sampleMask. */
function _sampleSculptMask(data, size, u, v) {
  const fx = u * (size - 1);
  const fy = v * (size - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, size - 1);
  const y1 = Math.min(y0 + 1, size - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  return (
    data[y0 * size + x0] * (1 - tx) * (1 - ty) +
    data[y0 * size + x1] * tx * (1 - ty) +
    data[y1 * size + x0] * (1 - tx) * ty +
    data[y1 * size + x1] * tx * ty
  );
}

function shouldSkipSculptBecauseOwnerInStroke(
  cx,
  cz,
  ix,
  iz,
  res,
  maxC,
  minCX,
  maxCX,
  minCZ,
  maxCZ,
) {
  let ownerCx = cx;
  let ownerCz = cz;
  const consider = (nx, nz) => {
    if (nx < ownerCx || (nx === ownerCx && nz < ownerCz)) {
      ownerCx = nx;
      ownerCz = nz;
    }
  };

  consider(cx, cz);
  if (ix === 0 && cx > 0) consider(cx - 1, cz);
  if (ix === res && cx < maxC) consider(cx + 1, cz);
  if (iz === 0 && cz > 0) consider(cx, cz - 1);
  if (iz === res && cz < maxC) consider(cx, cz + 1);
  if (ix === 0 && iz === 0 && cx > 0 && cz > 0) consider(cx - 1, cz - 1);
  if (ix === res && iz === 0 && cx < maxC && cz > 0) consider(cx + 1, cz - 1);
  if (ix === 0 && iz === res && cx > 0 && cz < maxC) consider(cx - 1, cz + 1);
  if (ix === res && iz === res && cx < maxC && cz < maxC) consider(cx + 1, cz + 1);

  if (ownerCx === cx && ownerCz === cz) return false;
  const ownerInStroke =
    ownerCx >= minCX &&
    ownerCx <= maxCX &&
    ownerCz >= minCZ &&
    ownerCz <= maxCZ;
  return ownerInStroke;
}

function hashNoise(x, y) {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function smoothNoise(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hashNoise(ix, iy);
  const b = hashNoise(ix + 1, iy);
  const c = hashNoise(ix, iy + 1);
  const d = hashNoise(ix + 1, iy + 1);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, ux), THREE.MathUtils.lerp(c, d, ux), uy);
}

function fbm(x, y, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += smoothNoise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function fbmRidge(x, y, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = smoothNoise(x * freq, y * freq);
    sum += (1 - Math.abs(n * 2 - 1)) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum / norm;
}

