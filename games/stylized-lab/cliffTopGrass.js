// GRASS ON THE CLIFF TOPS (2026-10-09, you: "keep using revo, and for that
// game make a way to have that same grass on the cliff top").
//
// The terrain's Revo grass only grows on the heightmap; the cliff blocks' flat
// tops sit above it. So: a SECOND RevoGrassSystem (the engine's, public) with
// the level's own revo settings (app.revoGrassState / app.grassState) — the
// same blades, colours, wind — standing on a CLIFF-TOP SURFACE baked here:
//   - every up-facing triangle of the cliff meshes (normal.y >= minUp) is
//     rasterised into a world grid (1 m at 512 over 512 m), keeping the
//     highest top in each cell
//   - only cells above the terrain count (where the terrain itself shows, its
//     own grass is already there)
//   - the mask is eroded `inset` cells, so blades stop short of the rim
//     instead of hanging over it
// The engine's own "cliff grass" mode does this for solid props on the Hybrid
// rings; this is the Revo version, for meshes a game builds itself.
import * as THREE from "three";
import { RevoGrassSystem } from "../../v3/render/grass/revoGrassSystem.js";

const NONE = -1e4;

/** Bake the cliff-top height grid from world-space meshes. */
export function bakeCliffTops(meshes, { worldSize, res = 512, minUp = 0.75, terrainHeight, above = 0.15, inset = 1 }) {
  const H = new Float32Array(res * res).fill(NONE);
  const cell = worldSize / res, half = worldSize / 2;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const mesh of meshes) {
    mesh.updateMatrixWorld();
    const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
    const triCount = (idx ? idx.count : pos.count) / 3;
    for (let t = 0; t < triCount; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
      n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
      const len = n.length();
      if (len < 1e-9 || Math.abs(n.y) / len < minUp) continue;
      // cells whose centre falls inside the triangle (XZ), height by barycentrics
      const ix0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) + half) / cell));
      const ix1 = Math.min(res - 1, Math.floor((Math.max(a.x, b.x, c.x) + half) / cell));
      const iz0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) + half) / cell));
      const iz1 = Math.min(res - 1, Math.floor((Math.max(a.z, b.z, c.z) + half) / cell));
      const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(d) < 1e-9) continue;
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
        const px = (ix + 0.5) * cell - half, pz = (iz + 0.5) * cell - half;
        const w0 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
        const w1 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const y = w0 * a.y + w1 * b.y + w2 * c.y;
        const k = iz * res + ix;
        if (y > H[k]) H[k] = y;
      }
    }
  }
  // only above the terrain (its own grass covers the rest), then erode
  let valid = new Uint8Array(res * res);
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) {
    const k = iz * res + ix;
    if (H[k] > NONE + 1 && H[k] > terrainHeight((ix + 0.5) * cell - half, (iz + 0.5) * cell - half) + above) valid[k] = 1;
  }
  for (let it = 0; it < inset; it++) {
    const next = new Uint8Array(res * res);
    for (let iz = 1; iz < res - 1; iz++) for (let ix = 1; ix < res - 1; ix++) {
      const k = iz * res + ix;
      next[k] = valid[k] & valid[k - 1] & valid[k + 1] & valid[k - res] & valid[k + res];
    }
    valid = next;
  }
  let cells = 0;
  for (let k = 0; k < valid.length; k++) cells += valid[k];
  return { H, valid, res, cells };
}

/**
 * The cliff-top Revo field. Call once the cliff meshes are in the scene and
 * the level is loaded; it updates itself before every render.
 * @returns {Promise<{ system: RevoGrassSystem, cells: number, rebake(meshes): void, dispose(): void }>}
 */
export async function createCliffTopGrass(app, meshes, opts = {}) {
  const worldSize = app.worldSize;
  const res = opts.res ?? 512;
  const heightData = new Float32Array(res * res * 4);
  const heightTex = new THREE.DataTexture(heightData, res, res, THREE.RGBAFormat, THREE.FloatType);
  heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;
  heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
  const densityData = new Uint8Array(res * res * 4);
  const densityTex = new THREE.DataTexture(densityData, res, res, THREE.RGBAFormat);
  densityTex.minFilter = densityTex.magFilter = THREE.NearestFilter;
  densityTex.wrapS = densityTex.wrapT = THREE.ClampToEdgeWrapping;
  // flat-up normal (the slope rule reads .y) and the painted blade height at 1x (128)
  const one = (r, g, bl) => { const t = new THREE.DataTexture(new Uint8Array([r, g, bl, 255]), 1, 1, THREE.RGBAFormat); t.needsUpdate = true; return t; };
  const normalTex = one(128, 255, 128);
  const bladeHeightTex = one(128, 128, 128);

  let cells = 0;
  const rebake = (ms) => {
    const bake = bakeCliffTops(ms, { worldSize, res, terrainHeight: (x, z) => app.getWorldHeight(x, z), ...opts });
    for (let k = 0; k < res * res; k++) {
      heightData[k * 4] = bake.valid[k] ? bake.H[k] : NONE;
      heightData[k * 4 + 2] = 1;
      const v = bake.valid[k] ? 255 : 0;
      densityData[k * 4] = densityData[k * 4 + 1] = densityData[k * 4 + 2] = v;
      densityData[k * 4 + 3] = 255;
    }
    heightTex.needsUpdate = true;
    densityTex.needsUpdate = true;
    cells = bake.cells;
  };
  rebake(meshes);

  const system = new RevoGrassSystem({
    scene: app.scene, renderer: app.renderer, name: "CliffTopRevoGrass", worldSize,
    heightTex, terrainNormalTex: normalTex, densityTex, bladeHeightTex,
    rp: app.revoGrassState, gp: app.grassState,
  });
  await system.init(app.camera);
  system.syncFromState(app.revoGrassState, app.grassState, app.light?.getDirection?.());
  system.setEnabled(true);
  const hook = () => {
    // the level's revo settings, live (a panel edit or a level load shows here too)
    system.syncFromState(app.revoGrassState, app.grassState, app.light?.getDirection?.());
    system.update(app.camera.position, app.camera);
  };
  app.addPreRenderHook(hook);
  return {
    system,
    get cells() { return cells; },
    rebake,
    dispose() { app.removePreRenderHook?.(hook); system.dispose(); },
  };
}
