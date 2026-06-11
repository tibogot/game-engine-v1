/**
 * Deterministic foliage placement from cluster definitions.
 * Uses LCG PRNG seeded per cluster for reproducible results.
 * Supports 3-tier LOD: full density, 50% at 1.414× size, 25% at 2× size.
 */
import * as THREE from "three";

function createLcg(seed) {
  let s = (seed * 1664525 + 1013904223) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xffffffff; };
}

function sampleCluster(c, seedOffset) {
  const rng = createLcg(seedOffset);
  const positions = [];
  const maxTry = c.count * 12;
  let tries = 0;

  while (positions.length < c.count && tries++ < maxTry) {
    const rx = rng() * 2 - 1;
    const ry = rng() * 2 - 1;
    const rz = rng() * 2 - 1;
    const d = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (d > 1.0) continue;
    const innerR = 1.0 - c.shellThick;
    if (d < innerR && rng() < c.shell) continue;

    positions.push({
      x: c.x + rx * c.rx,
      y: c.y + ry * c.ry,
      z: c.z + rz * c.rx,
      leafSize: c.leafSize,
      scaleVar: c.scaleVar,
      tiltMax: c.tiltMax,
    });
  }
  return positions;
}

/**
 * @param {Array} clusters - cluster definitions from preset
 * @param {number} trunkScale - the trunkScale from the preset (e.g. 0.18).
 *   Cluster positions in the editor are in world space with the trunk already
 *   scaled. We divide by trunkScale to convert to raw trunk-local space so
 *   the tree instance's world matrix (which re-applies the scale) produces
 *   the correct final positions.
 */
export function sampleAllClusters(clusters, trunkScale = 1) {
  const allPos = [];
  const allRands = [];
  const rng = createLcg(77777);
  const invS = trunkScale > 0.001 ? 1 / trunkScale : 1;
  clusters.forEach((c, ci) => {
    if (!c.enabled) return;
    sampleCluster(c, ci * 999983 + 12345).forEach(p => {
      p.x *= invS;
      p.y *= invS;
      p.z *= invS;
      p.leafSize *= invS;
      allPos.push(p);
      allRands.push(rng(), rng());
    });
  });
  return { allPos, allRands };
}

export function computeFoliageBounds(positions) {
  let yMin = Infinity, yMax = -Infinity;
  let xMin = Infinity, xMax = -Infinity;
  let zMin = Infinity, zMax = -Infinity;
  for (const p of positions) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.z < zMin) zMin = p.z;
    if (p.z > zMax) zMax = p.z;
  }
  const cx = (xMin + xMax) * 0.5;
  const cy = (yMin + yMax) * 0.5;
  const cz = (zMin + zMax) * 0.5;
  const ext = Math.max(xMax - xMin, yMax - yMin, zMax - zMin);
  return {
    yMin: yMin - 0.3,
    yMax: yMax + 0.5,
    canopyCenter: new THREE.Vector3(cx, cy, cz),
    aoRadius: ext * 0.62,
  };
}

/**
 * Build all 3 LOD tiers at once so LOD1/LOD2 are proper subsets of LOD0
 * with the same transforms, just scaled up to compensate for fewer leaves.
 *
 * LOD0: all leaves, base size
 * LOD1: every 2nd leaf, 1.414× size
 * LOD2: every 4th leaf, 2× size
 *
 * options.billboard — when true, per-leaf rotation/scale is NOT baked into the
 * instance matrix; instead the matrix is pure translation and the per-leaf
 * size is exposed on `scaleData` for the shader's billboard path. The chunked
 * renderer is responsible for skipping the tree's rotation/scale composition
 * in billboard mode and uploading aLeafScale per instance.
 *
 * RNG consumption is identical in both modes (rotY, tiltX, tiltZ, scale) so
 * the byte-for-byte determinism contract with arborist still holds.
 */
export function buildAllFoliageLods(positions, rands, options = {}) {
  const n = positions.length;
  if (n === 0) return [null, null, null];

  const billboard = !!options.billboard;
  const dummy = new THREE.Object3D();
  const DEG2RAD = Math.PI / 180;
  const rng = createLcg(42);

  const lod0Mats = new Float32Array(n * 16);
  const lod0Rands = new Float32Array(n * 2);
  const lod0Centers = new Float32Array(n * 3);
  const lod0Scales = new Float32Array(n);
  const baseSizes = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const p = positions[i];
    lod0Rands[i * 2] = rands[i * 2];
    lod0Rands[i * 2 + 1] = rands[i * 2 + 1];
    lod0Centers[i * 3]     = p.x;
    lod0Centers[i * 3 + 1] = p.y;
    lod0Centers[i * 3 + 2] = p.z;

    // Always consume 4 rng() in this order: rotY, tiltX, tiltZ, scale.
    const rotY  = rng() * Math.PI * 2;
    const tiltX = (rng() - 0.5) * p.tiltMax * DEG2RAD * 2;
    const tiltZ = (rng() - 0.5) * p.tiltMax * DEG2RAD * 2;
    const s = Math.max(0.05, p.leafSize * (1 + (rng() - 0.5) * 2 * p.scaleVar));
    baseSizes[i] = s;
    lod0Scales[i] = s;

    dummy.position.set(p.x, p.y, p.z);
    if (billboard) {
      // Pure translation; the shader builds a camera-facing quad sized by aLeafScale.
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(1, 1, 1);
    } else {
      dummy.rotation.order = "YXZ";
      dummy.rotation.y = rotY;
      dummy.rotation.x = tiltX;
      dummy.rotation.z = tiltZ;
      dummy.scale.setScalar(s);
    }
    dummy.updateMatrix();
    dummy.matrix.toArray(lod0Mats, i * 16);
  }

  const geo0 = new THREE.PlaneGeometry(1, 1);
  geo0.setAttribute("aRand", new THREE.InstancedBufferAttribute(lod0Rands, 2));
  geo0.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(lod0Centers, 3));
  geo0.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(lod0Scales, 1));
  // randData / centerData / scaleData are exposed so chunked renderers can
  // re-upload per-instance values when batching many trees into one InstancedMesh.
  const lod0 = {
    geometry: geo0,
    matrices: lod0Mats,
    count: n,
    randData: lod0Rands,
    centerData: lod0Centers,
    scaleData: lod0Scales,
    billboard,
  };

  const scaleMuls = [1.0, Math.SQRT2, 2.0];
  const steps = [1, 2, 4];
  const lods = [lod0, null, null];

  for (let tier = 1; tier < 3; tier++) {
    const step = steps[tier];
    const sMul = scaleMuls[tier];
    const indices = [];
    for (let i = 0; i < n; i += step) indices.push(i);
    const count = indices.length;
    if (count === 0) { lods[tier] = null; continue; }

    const mats = new Float32Array(count * 16);
    const rd = new Float32Array(count * 2);
    const cd = new Float32Array(count * 3);
    const sd = new Float32Array(count);
    const scaleRatio = sMul;

    for (let j = 0; j < count; j++) {
      const srcIdx = indices[j];
      const srcOff = srcIdx * 16;
      const dstOff = j * 16;

      for (let k = 0; k < 16; k++) mats[dstOff + k] = lod0Mats[srcOff + k];

      if (billboard) {
        // Matrices are pure translation in billboard mode — don't bake scale
        // into them; the bigger LOD leaf size goes on aLeafScale instead.
        sd[j] = lod0Scales[srcIdx] * scaleRatio;
      } else {
        const origS = baseSizes[srcIdx];
        const newS = origS * scaleRatio;
        const ratio = newS / origS;
        mats[dstOff + 0] *= ratio;
        mats[dstOff + 1] *= ratio;
        mats[dstOff + 2] *= ratio;
        mats[dstOff + 4] *= ratio;
        mats[dstOff + 5] *= ratio;
        mats[dstOff + 6] *= ratio;
        mats[dstOff + 8] *= ratio;
        mats[dstOff + 9] *= ratio;
        mats[dstOff + 10] *= ratio;
        sd[j] = lod0Scales[srcIdx]; // unused by non-billboard shader path
      }

      rd[j * 2] = lod0Rands[srcIdx * 2];
      rd[j * 2 + 1] = lod0Rands[srcIdx * 2 + 1];
      cd[j * 3]     = lod0Centers[srcIdx * 3];
      cd[j * 3 + 1] = lod0Centers[srcIdx * 3 + 1];
      cd[j * 3 + 2] = lod0Centers[srcIdx * 3 + 2];
    }

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.setAttribute("aRand", new THREE.InstancedBufferAttribute(rd, 2));
    geo.setAttribute("aLeafCenter", new THREE.InstancedBufferAttribute(cd, 3));
    geo.setAttribute("aLeafScale", new THREE.InstancedBufferAttribute(sd, 1));
    lods[tier] = {
      geometry: geo,
      matrices: mats,
      count,
      randData: rd,
      centerData: cd,
      scaleData: sd,
      billboard,
    };
  }

  return lods;
}
