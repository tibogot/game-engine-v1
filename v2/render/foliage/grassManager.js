import * as THREE from "three";
import { uniform } from "three/tsl";
import {
  createBladeGeometry,
  createFieldInstancedGeometry,
  createGrassMaterial,
  createGrassMaterialMega,
  setupGrassPatches,
} from "../../core/foliage/grassGemini.js";
import { createWindTexture, createSpecNoiseTexture } from "../../core/foliage/windTexture.js";

export class GrassManager {
  constructor({ scene, camera, config }) {
    this.scene = scene;
    this.camera = camera;
    this.config = config;
    this.group = new THREE.Group();
    this.group.name = "GeminiGrass";
    scene.add(this.group);

    this.patchSystem = null;
    this.uniforms = null;
    this.geosAndMats = null;
    this._currentGeos = null;
    this._initialized = false;
    this._enabled = false;

    this.densityRes = 512;
    const res = this.densityRes;
    const data = new Uint8Array(res * res * 4);
    this.densityTex = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    this.densityTex.wrapS = this.densityTex.wrapT = THREE.ClampToEdgeWrapping;
    this.densityTex.minFilter = THREE.LinearFilter;
    this.densityTex.magFilter = THREE.LinearFilter;
    this.densityTex.needsUpdate = true;

    // Terrain normal texture (Float32 RGBA — xyz = precomputed FD normal)
    const tnData = new Float32Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
      tnData[i * 4 + 1] = 1;
      tnData[i * 4 + 3] = 1;
    }
    this.terrainNormalTex = new THREE.DataTexture(tnData, res, res, THREE.RGBAFormat, THREE.FloatType);
    this.terrainNormalTex.wrapS = this.terrainNormalTex.wrapT = THREE.ClampToEdgeWrapping;
    this.terrainNormalTex.minFilter = THREE.LinearFilter;
    this.terrainNormalTex.magFilter = THREE.LinearFilter;
    this.terrainNormalTex.needsUpdate = true;

    // Cliff grass: height texture (Float32 RGBA — .x = cliff Y, -9999 where invalid)
    const chData = new Float32Array(res * res * 4);
    for (let i = 0; i < res * res; i++) {
      chData[i * 4] = chData[i * 4 + 1] = chData[i * 4 + 2] = -9999;
      chData[i * 4 + 3] = 1;
    }
    this.cliffHeightTex = new THREE.DataTexture(chData, res, res, THREE.RGBAFormat, THREE.FloatType);
    this.cliffHeightTex.wrapS = this.cliffHeightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.cliffHeightTex.minFilter = THREE.NearestFilter;
    this.cliffHeightTex.magFilter = THREE.NearestFilter;
    this.cliffHeightTex.needsUpdate = true;

    // Cliff grass: painted density (Uint8 RGBA)
    const cdData = new Uint8Array(res * res * 4);
    this.cliffDensityTex = new THREE.DataTexture(cdData, res, res, THREE.RGBAFormat);
    this.cliffDensityTex.wrapS = this.cliffDensityTex.wrapT = THREE.ClampToEdgeWrapping;
    this.cliffDensityTex.minFilter = THREE.LinearFilter;
    this.cliffDensityTex.magFilter = THREE.LinearFilter;
    this.cliffDensityTex.needsUpdate = true;

    this._hasCliffData = false;

    this._cliffOccRes = 32;
    this._cliffOccupancy = new Uint8Array(32 * 32);
  }

  /**
   * Serialize the painted grass density (main + cliff) for the project file.
   * Same base64 scheme the paint masks use. Returns null-able B64 strings so an
   * unpainted cliff layer costs nothing.
   */
  exportDensity() {
    const enc = (bytes) => {
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(binary);
    };
    return {
      res: this.densityRes,
      densityB64: enc(this.densityTex.image.data),
      cliffDensityB64: this._hasCliffData
        ? enc(this.cliffDensityTex.image.data)
        : null,
    };
  }

  /** Restore painted density saved by exportDensity(). */
  importDensity(payload) {
    if (!payload?.densityB64) return false;
    const dec = (b64, target) => {
      const binary = atob(b64);
      if (binary.length !== target.length) return false;
      for (let i = 0; i < binary.length; i++) target[i] = binary.charCodeAt(i);
      return true;
    };
    const okMain = dec(payload.densityB64, this.densityTex.image.data);
    if (okMain) this.densityTex.needsUpdate = true;
    if (payload.cliffDensityB64) {
      if (dec(payload.cliffDensityB64, this.cliffDensityTex.image.data)) {
        this.cliffDensityTex.needsUpdate = true;
        this._hasCliffData = true;
      }
    }
    return okMain;
  }

  init(heightTex, sunDir, grassState, { groundColorAtWorldXZ } = {}) {
    if (this._initialized) return;
    this._initialized = true;
    this._heightTex = heightTex;

    const gp = grassState;
    const ws = this.config.world.size;

    const col = (hex) => new THREE.Color(hex).convertSRGBToLinear();

    this.uniforms = {
      uTerrainSize: uniform(ws),
      uSunDir: uniform(sunDir.clone()),
      uPlayerPos: uniform(new THREE.Vector3(0, 0, 0)),
      uBladeHeight: uniform(gp.bladeHeight),
      uGrassDensity: uniform(gp.grassDensity),
      uWindSpeed: uniform(gp.windSpeed),
      uWindStrength: uniform(gp.windStrength),
      uMaxAngle: uniform(gp.maxAngle),
      uNaturalLean: uniform(gp.naturalLean),
      uWindDirX: uniform(Math.cos(gp.windAngle * Math.PI / 180)),
      uWindDirZ: uniform(Math.sin(gp.windAngle * Math.PI / 180)),
      uWindWaveScale: uniform(gp.windWaveScale),
      uWindGust: uniform(gp.windGust),
      uBendFocus: uniform(gp.bendFocus),
      uStiffness: uniform(gp.stiffness),
      uClumpScale: uniform(gp.clumpScale),
      uClumpStrength: uniform(gp.clumpStrength),
      uCrossed: uniform(gp.crossed ? 1 : 0),
      uBladeCol: uniform(col(gp.bladeColor)),
      uTipCol: uniform(col(gp.tipColor)),
      uSkyBlend: uniform(gp.skyBlend),
      uCylindrical: uniform(gp.cylindrical),
      uViewThicken: uniform(gp.viewThicken),
      uAoBase: uniform(gp.aoBase),
      uAoPower: uniform(gp.aoPower),
      uColorVar: uniform(gp.colorVariation ? 1 : 0),
      uCvHueSpread: uniform(gp.cvHueSpread),
      uCvSatSpread: uniform(gp.cvSatSpread),
      uCvDryAmount: uniform(gp.cvDryAmount),
      uCvDryCol: uniform(col(gp.cvDryColor)),
      uBssCol: uniform(col(gp.bssColor)),
      uBssIntensity: uniform(gp.bssIntensity),
      uBssPower: uniform(gp.bssPower),
      uFrontScatter: uniform(gp.frontScatter),
      uRimSSS: uniform(gp.rimSSS),
      uSpecV1Enabled: uniform(gp.specV1Enabled ? 1 : 0),
      uSpecV1Intensity: uniform(gp.specV1Intensity),
      uSpecV1Col: uniform(col(gp.specV1Color)),
      uSpecV1Dir: uniform(new THREE.Vector3(gp.specV1DirX, gp.specV1DirY, gp.specV1DirZ).normalize()),
      uSpecV1Power: uniform(gp.specV1Power),
      uSpecV2Enabled: uniform(gp.specV2Enabled ? 1 : 0),
      uSpecV2Intensity: uniform(gp.specV2Intensity),
      uSpecV2Col: uniform(col(gp.specV2Color)),
      uSpecV2Dir: uniform(new THREE.Vector3(gp.specV2DirX, gp.specV2DirY, gp.specV2DirZ).normalize()),
      uSpecV2NoiseScale: uniform(gp.specV2NoiseScale),
      uSpecV2NoiseStr: uniform(gp.specV2NoiseStr),
      uSpecV2Power: uniform(gp.specV2Power),
      uSpecV2TipBias: uniform(gp.specV2TipBias),
      uLodEnabled: uniform(gp.lodEnabled ? 1 : 0),
      uLodMidDist: uniform(gp.lodMidDistance),
      uLodFarDist: uniform(gp.lodFarDistance),
      uLodMaxDist: uniform(Math.max(gp.lodMaxDistance, gp.lodMegaMaxDistance)),
      uLodFadeStart: uniform(gp.lodFadeStart),
      uLodDebug: uniform(gp.lodDebug ? 1 : 0),
      uInteractionEnabled: uniform(0),
      uInteractionRadius: uniform(gp.interactionRadius),
      uInteractionStrength: uniform(gp.interactionStrength),
      uTerrainTintMode: uniform(0),
      uTerrainTintStrength: uniform(gp.terrainTintStrength ?? 0.5),
      uTerrainTintRootBias: uniform(gp.terrainTintRootBias ?? 0.35),
      uSlopeEnabled: uniform(gp.slopeEnabled ? 1 : 0),
      uSlopeMin: uniform(gp.slopeMin ?? 0.65),
      uSlopeMax: uniform(gp.slopeMax ?? 0.85),
    };

    this.windTex = createWindTexture();
    this.specNoiseTex = createSpecNoiseTexture();

    const baseCtx = {
      ...this.uniforms,
      heightTex,
      terrainNormalTex: this.terrainNormalTex,
      grassDensityTex: this.densityTex,
      cliffHeightTex: this.cliffHeightTex,
      cliffDensityTex: this.cliffDensityTex,
      windTex: this.windTex,
      specNoiseTex: this.specNoiseTex,
      terrainRes: 512,
      groundColorAtWorldXZ: groundColorAtWorldXZ ?? undefined,
    };

    // Terrain grass layer (ignores cliff entirely)
    const material = createGrassMaterial({ ...baseCtx, cliffMode: false });
    const materialMega = createGrassMaterialMega({ ...baseCtx, cliffMode: false });

    // Cliff grass layer (only renders on cliff surfaces)
    const materialCliff = createGrassMaterial({ ...baseCtx, cliffMode: true });
    const materialMegaCliff = createGrassMaterialMega({ ...baseCtx, cliffMode: true });

    this._currentGeos = this._buildGeos(gp);
    this.geosAndMats = {
      ...this._currentGeos,
      material,
      materialMega,
    };

    const patchOpts = {
      patchSize: gp.fieldSize,
      patchSizeMid: gp.lodMidPatchSize,
      patchSizeFar: gp.lodFarPatchSize,
      patchSizeMega: gp.lodMegaPatchSize,
      lodMidDistance: gp.lodMidDistance,
      lodFarDistance: gp.lodFarDistance,
      maxDistance: gp.lodMaxDistance,
      megaMaxDistance: gp.lodMegaMaxDistance,
      lodHysteresis: 2,
      lodEnabled: gp.lodEnabled,
      grassReceiveShadow: gp.receiveShadow,
      mapWorldHalf: ws * 0.5,
    };

    this.patchSystem = setupGrassPatches(
      this.scene, this.camera, this.group, this.geosAndMats, patchOpts,
    );

    // Second independent patch system for cliff grass (shares geometries)
    this.cliffGroup = new THREE.Group();
    this.cliffGroup.name = "GeminiCliffGrass";
    this.scene.add(this.cliffGroup);
    this.cliffGeosAndMats = {
      ...this._currentGeos,
      material: materialCliff,
      materialMega: materialMegaCliff,
    };
    this.cliffPatchSystem = setupGrassPatches(
      this.scene, this.camera, this.cliffGroup, this.cliffGeosAndMats,
      { ...patchOpts, patchHasData: (minX, maxX, minZ, maxZ) => this.cliffPatchHasData(minX, maxX, minZ, maxZ) },
    );

    this._enabled = gp.enabled;
    this.group.visible = this._enabled;
    this.cliffGroup.visible = this._enabled;
  }

  _buildGeos(gp) {
    const highBase = createBladeGeometry(gp.bladeHeight, gp.bladeWidth, Math.round(gp.bladeYSegments), gp.tipTaperStart);
    const geoHigh = createFieldInstancedGeometry(highBase, gp.fieldSize, Math.round(gp.grassCount), gp.bladeHeight, true);
    highBase.dispose();

    const midBase = createBladeGeometry(gp.bladeHeight, gp.bladeWidth, Math.round(gp.lodMidSegments), gp.tipTaperStart);
    const geoMid = createFieldInstancedGeometry(midBase, gp.lodMidPatchSize, Math.round(gp.lodMidGrassCount), gp.bladeHeight, true);
    midBase.dispose();

    const farBase = createBladeGeometry(gp.bladeHeight, gp.lodFarBladeWidth ?? gp.bladeWidth, Math.round(gp.lodFarSegments), gp.tipTaperStart);
    const geoFar = createFieldInstancedGeometry(farBase, gp.lodFarPatchSize, Math.round(gp.lodFarGrassCount), gp.bladeHeight, false);
    farBase.dispose();

    const megaBase = createBladeGeometry(gp.bladeHeight, gp.lodMegaBladeWidth ?? gp.bladeWidth, Math.round(gp.lodMegaSegments), gp.tipTaperStart);
    const geoMega = createFieldInstancedGeometry(megaBase, gp.lodMegaPatchSize, Math.round(gp.lodMegaGrassCount), gp.bladeHeight, false);
    megaBase.dispose();

    return { geoHigh, geoMid, geoFar, geoMega };
  }

  syncUniforms(gp, sunDir) {
    if (!this.uniforms) return;
    const u = this.uniforms;
    u.uBladeHeight.value = gp.bladeHeight;
    u.uGrassDensity.value = gp.grassDensity;
    u.uWindSpeed.value = gp.windSpeed;
    u.uWindStrength.value = gp.windStrength;
    u.uMaxAngle.value = gp.maxAngle;
    u.uNaturalLean.value = gp.naturalLean;
    const wr = gp.windAngle * Math.PI / 180;
    u.uWindDirX.value = Math.cos(wr);
    u.uWindDirZ.value = Math.sin(wr);
    u.uWindWaveScale.value = gp.windWaveScale;
    u.uWindGust.value = gp.windGust;
    u.uBendFocus.value = gp.bendFocus;
    u.uStiffness.value = gp.stiffness;
    u.uClumpScale.value = gp.clumpScale;
    u.uClumpStrength.value = gp.clumpStrength;
    u.uCrossed.value = gp.crossed ? 1 : 0;
    u.uBladeCol.value.set(gp.bladeColor);
    u.uTipCol.value.set(gp.tipColor);
    u.uSkyBlend.value = gp.skyBlend;
    u.uCylindrical.value = gp.cylindrical;
    u.uViewThicken.value = gp.viewThicken;
    u.uAoBase.value = gp.aoBase;
    u.uAoPower.value = gp.aoPower;
    u.uColorVar.value = gp.colorVariation ? 1 : 0;
    u.uCvHueSpread.value = gp.cvHueSpread;
    u.uCvSatSpread.value = gp.cvSatSpread;
    u.uCvDryAmount.value = gp.cvDryAmount;
    u.uCvDryCol.value.set(gp.cvDryColor);
    u.uBssCol.value.set(gp.bssColor);
    u.uBssIntensity.value = gp.bssIntensity;
    u.uBssPower.value = gp.bssPower;
    u.uFrontScatter.value = gp.frontScatter;
    u.uRimSSS.value = gp.rimSSS;
    u.uSpecV1Enabled.value = gp.specV1Enabled ? 1 : 0;
    u.uSpecV1Intensity.value = gp.specV1Intensity;
    u.uSpecV1Col.value.set(gp.specV1Color);
    u.uSpecV1Dir.value.set(gp.specV1DirX, gp.specV1DirY, gp.specV1DirZ).normalize();
    u.uSpecV1Power.value = gp.specV1Power;
    u.uSpecV2Enabled.value = gp.specV2Enabled ? 1 : 0;
    u.uSpecV2Intensity.value = gp.specV2Intensity;
    u.uSpecV2Col.value.set(gp.specV2Color);
    u.uSpecV2Dir.value.set(gp.specV2DirX, gp.specV2DirY, gp.specV2DirZ).normalize();
    u.uSpecV2NoiseScale.value = gp.specV2NoiseScale;
    u.uSpecV2NoiseStr.value = gp.specV2NoiseStr;
    u.uSpecV2Power.value = gp.specV2Power;
    u.uSpecV2TipBias.value = gp.specV2TipBias;
    u.uLodEnabled.value = gp.lodEnabled ? 1 : 0;
    u.uLodMidDist.value = gp.lodMidDistance;
    u.uLodFarDist.value = gp.lodFarDistance;
    u.uLodMaxDist.value = Math.max(gp.lodMaxDistance, gp.lodMegaMaxDistance);
    u.uLodFadeStart.value = gp.lodFadeStart;
    u.uLodDebug.value = gp.lodDebug ? 1 : 0;
    u.uInteractionRadius.value = gp.interactionRadius;
    u.uInteractionStrength.value = gp.interactionStrength;
    if (gp.terrainTintEnabled) {
      if (gp.terrainTintAutoSource) {
        u.uTerrainTintMode.value = 1;
      } else {
        u.uTerrainTintMode.value = Math.max(0, Math.min(2, gp.terrainTintManualMode | 0));
      }
    } else {
      u.uTerrainTintMode.value = 0;
    }
    u.uTerrainTintStrength.value = gp.terrainTintStrength ?? 0.5;
    u.uTerrainTintRootBias.value = gp.terrainTintRootBias ?? 0.35;
    u.uSlopeEnabled.value = gp.slopeEnabled ? 1 : 0;
    u.uSlopeMin.value = gp.slopeMin ?? 0.65;
    u.uSlopeMax.value = gp.slopeMax ?? 0.85;
    if (sunDir) u.uSunDir.value.copy(sunDir);
  }

  rebuildGeometries(gp) {
    if (!this.patchSystem) return;
    const old = this._currentGeos;
    this._currentGeos = this._buildGeos(gp);
    this.patchSystem.updateGeometries(this._currentGeos);
    if (this.cliffPatchSystem) {
      this.cliffPatchSystem.updateGeometries(this._currentGeos);
    }
    if (old) {
      old.geoHigh?.dispose();
      old.geoMid?.dispose();
      old.geoFar?.dispose();
      old.geoMega?.dispose();
    }
  }

  update(grassState, focusPoint) {
    if (!this._initialized || !this.patchSystem) return;
    const enabled = grassState.enabled;
    if (enabled !== this._enabled) {
      this._enabled = enabled;
      this.group.visible = enabled;
      if (this.cliffGroup) this.cliffGroup.visible = enabled && this._hasCliffData;
    }
    if (!enabled) return;

    const gp = grassState;
    const updateOpts = {
      patchSize: gp.fieldSize,
      patchSizeMid: gp.lodMidPatchSize,
      patchSizeFar: gp.lodFarPatchSize,
      patchSizeMega: gp.lodMegaPatchSize,
      lodMidDistance: gp.lodMidDistance,
      lodFarDistance: gp.lodFarDistance,
      maxDistance: gp.lodMaxDistance,
      megaMaxDistance: gp.lodMegaMaxDistance,
      lodEnabled: gp.lodEnabled,
      grassReceiveShadow: gp.receiveShadow,
      focusPoint,
    };
    this.patchSystem.update(updateOpts);
    if (this.cliffPatchSystem) {
      if (this._hasCliffData) {
        this.cliffGroup.visible = true;
        this.cliffPatchSystem.update(updateOpts);
      } else {
        this.cliffGroup.visible = false;
      }
    }
  }

  async precompile(renderer, camera) {
    if (!this._initialized) return;
    const wasVisible = this.group.visible;
    const wasCliffVisible = this.cliffGroup?.visible;
    this.group.visible = true;
    if (this.cliffGroup) this.cliffGroup.visible = true;
    try {
      await renderer.compileAsync(this.scene, camera);
    } catch (_) {}
    this.group.visible = wasVisible;
    if (this.cliffGroup) this.cliffGroup.visible = wasCliffVisible;
  }

  stampDensity({ cx, cz, radius, strength, falloff, worldSize, erase }) {
    const res = this.densityRes;
    const data = this.densityTex.image.data;
    const half = worldSize * 0.5;
    const rPx = (radius / worldSize) * res;
    const cxPx = ((cx + half) / worldSize) * res;
    const czPx = ((cz + half) / worldSize) * res;
    const r2 = rPx * rPx;
    const minX = Math.max(0, Math.floor(cxPx - rPx));
    const maxX = Math.min(res - 1, Math.ceil(cxPx + rPx));
    const minZ = Math.max(0, Math.floor(czPx - rPx));
    const maxZ = Math.min(res - 1, Math.ceil(czPx + rPx));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cxPx;
        const dz = z - czPx;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const t = Math.sqrt(d2) / rPx;
        const falloffWeight = Math.pow(Math.max(0, 1 - t), falloff);
        const idx = (z * res + x) * 4;
        if (erase) {
          const sub = strength * falloffWeight * 255;
          data[idx] = Math.max(0, data[idx] - sub);
        } else {
          const add = strength * falloffWeight * 255;
          data[idx] = Math.min(255, data[idx] + add);
        }
        data[idx + 1] = data[idx];
        data[idx + 2] = data[idx];
        data[idx + 3] = 255;
      }
    }
    this.densityTex.needsUpdate = true;
  }

  getDensitySnapshot() {
    return new Uint8Array(this.densityTex.image.data);
  }

  restoreDensitySnapshot(snapshot) {
    this.densityTex.image.data.set(snapshot);
    this.densityTex.needsUpdate = true;
  }

  fillDensity() {
    this.densityTex.image.data.fill(255);
    this.densityTex.needsUpdate = true;
  }

  clearDensity() {
    this.densityTex.image.data.fill(0);
    this.densityTex.needsUpdate = true;
  }

  rebuildTerrainNormalTex(worldSize) {
    if (!this._heightTex) return;
    const res = this.densityRes;
    const hData = this._heightTex.image.data;
    const nData = this.terrainNormalTex.image.data;
    const ws2 = (worldSize / res) * 2;
    const getH = (x, z) => hData[(Math.max(0, Math.min(res - 1, z)) * res + Math.max(0, Math.min(res - 1, x))) * 4];
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const hL = getH(ix - 1, iz);
        const hR = getH(ix + 1, iz);
        const hD = getH(ix, iz - 1);
        const hU = getH(ix, iz + 1);
        const nx = hL - hR;
        const nz = hD - hU;
        const len = Math.sqrt(nx * nx + ws2 * ws2 + nz * nz);
        const i4 = (iz * res + ix) * 4;
        nData[i4]     = nx / len;
        nData[i4 + 1] = ws2 / len;
        nData[i4 + 2] = nz / len;
        nData[i4 + 3] = 1;
      }
    }
    this.terrainNormalTex.needsUpdate = true;
  }

  rebuildCliffHeightTex(cliffBvh, terrainStore, worldSize) {
    if (!cliffBvh?.baked) return;
    const res = this.densityRes;
    const data = this.cliffHeightTex.image.data;
    const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const wx = worldSize * ((ix + 0.5) / res - 0.5);
        const wz = worldSize * ((iz + 0.5) / res - 0.5);
        const terrainY = terrainStore.getWorldHeight(wx, wz);
        ray.origin.set(wx, 99999, wz);
        const hit = cliffBvh._bvh.raycastFirst(ray);
        const i4 = (iz * res + ix) * 4;
        let h = -9999;
        if (
          hit && hit.face && hit.face.normal &&
          hit.face.normal.y > 0.3 &&
          hit.point.y > terrainY + 0.08
        ) {
          h = hit.point.y;
        }
        data[i4] = h;
        data[i4 + 1] = 0;
        data[i4 + 2] = 1;
        data[i4 + 3] = 0;
      }
    }
    const ws2 = (worldSize / res) * 2;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const i4 = (iz * res + ix) * 4;
        const h = data[i4];
        if (h < -9000) continue;
        const getH = (x, z) => {
          const cx = Math.max(0, Math.min(res - 1, x));
          const cz = Math.max(0, Math.min(res - 1, z));
          const val = data[(cz * res + cx) * 4];
          return val > -9000 ? val : h;
        };
        const hL = getH(ix - 1, iz);
        const hR = getH(ix + 1, iz);
        const hD = getH(ix, iz - 1);
        const hU = getH(ix, iz + 1);
        const nx = hL - hR;
        const nz = hD - hU;
        const len = Math.sqrt(nx * nx + ws2 * ws2 + nz * nz);
        data[i4 + 1] = nx / len;
        data[i4 + 2] = ws2 / len;
        data[i4 + 3] = nz / len;
      }
    }
    this.cliffHeightTex.needsUpdate = true;
  }

  _rebuildCliffOccupancy() {
    const occ = this._cliffOccupancy;
    const occRes = this._cliffOccRes;
    const res = this.densityRes;
    const data = this.cliffDensityTex.image.data;
    const blockSize = res / occRes;
    occ.fill(0);
    this._hasCliffData = false;
    for (let oz = 0; oz < occRes; oz++) {
      for (let ox = 0; ox < occRes; ox++) {
        const pxMinX = Math.floor(ox * blockSize);
        const pxMaxX = Math.floor((ox + 1) * blockSize);
        const pxMinZ = Math.floor(oz * blockSize);
        const pxMaxZ = Math.floor((oz + 1) * blockSize);
        let found = false;
        for (let z = pxMinZ; z < pxMaxZ && !found; z++) {
          for (let x = pxMinX; x < pxMaxX; x++) {
            if (data[(z * res + x) * 4] > 0) { found = true; break; }
          }
        }
        if (found) {
          occ[oz * occRes + ox] = 1;
          this._hasCliffData = true;
        }
      }
    }
  }

  _updateCliffOccupancyRegion(pxMinX, pxMaxX, pxMinZ, pxMaxZ) {
    const occ = this._cliffOccupancy;
    const occRes = this._cliffOccRes;
    const res = this.densityRes;
    const data = this.cliffDensityTex.image.data;
    const blockSize = res / occRes;
    const oMinX = Math.max(0, Math.floor(pxMinX / blockSize));
    const oMaxX = Math.min(occRes - 1, Math.floor(pxMaxX / blockSize));
    const oMinZ = Math.max(0, Math.floor(pxMinZ / blockSize));
    const oMaxZ = Math.min(occRes - 1, Math.floor(pxMaxZ / blockSize));
    for (let oz = oMinZ; oz <= oMaxZ; oz++) {
      for (let ox = oMinX; ox <= oMaxX; ox++) {
        const bxMin = Math.floor(ox * blockSize);
        const bxMax = Math.floor((ox + 1) * blockSize);
        const bzMin = Math.floor(oz * blockSize);
        const bzMax = Math.floor((oz + 1) * blockSize);
        let found = false;
        for (let z = bzMin; z < bzMax && !found; z++) {
          for (let x = bxMin; x < bxMax; x++) {
            if (data[(z * res + x) * 4] > 0) { found = true; break; }
          }
        }
        occ[oz * occRes + ox] = found ? 1 : 0;
      }
    }
    this._hasCliffData = occ.includes(1);
  }

  cliffPatchHasData(worldMinX, worldMaxX, worldMinZ, worldMaxZ) {
    const ws = this.config.world.size;
    const half = ws * 0.5;
    const occRes = this._cliffOccRes;
    const oMinX = Math.max(0, Math.floor(((worldMinX + half) / ws) * occRes));
    const oMaxX = Math.min(occRes - 1, Math.floor(((worldMaxX + half) / ws) * occRes));
    const oMinZ = Math.max(0, Math.floor(((worldMinZ + half) / ws) * occRes));
    const oMaxZ = Math.min(occRes - 1, Math.floor(((worldMaxZ + half) / ws) * occRes));
    const occ = this._cliffOccupancy;
    for (let oz = oMinZ; oz <= oMaxZ; oz++) {
      for (let ox = oMinX; ox <= oMaxX; ox++) {
        if (occ[oz * occRes + ox]) return true;
      }
    }
    return false;
  }

  stampCliffDensity({ cx, cz, radius, strength, falloff, worldSize, erase }) {
    const res = this.densityRes;
    const data = this.cliffDensityTex.image.data;
    const half = worldSize * 0.5;
    const rPx = (radius / worldSize) * res;
    const cxPx = ((cx + half) / worldSize) * res;
    const czPx = ((cz + half) / worldSize) * res;
    const r2 = rPx * rPx;
    const minX = Math.max(0, Math.floor(cxPx - rPx));
    const maxX = Math.min(res - 1, Math.ceil(cxPx + rPx));
    const minZ = Math.max(0, Math.floor(czPx - rPx));
    const maxZ = Math.min(res - 1, Math.ceil(czPx + rPx));

    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - cxPx;
        const dz = z - czPx;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2) continue;
        const t = Math.sqrt(d2) / rPx;
        const falloffWeight = Math.pow(Math.max(0, 1 - t), falloff);
        const idx = (z * res + x) * 4;
        if (erase) {
          const sub = strength * falloffWeight * 255;
          data[idx] = Math.max(0, data[idx] - sub);
        } else {
          const add = strength * falloffWeight * 255;
          data[idx] = Math.min(255, data[idx] + add);
        }
        data[idx + 1] = data[idx];
        data[idx + 2] = data[idx];
        data[idx + 3] = 255;
      }
    }
    this.cliffDensityTex.needsUpdate = true;
    this._updateCliffOccupancyRegion(minX, maxX, minZ, maxZ);
  }

  getCliffDensitySnapshot() {
    return new Uint8Array(this.cliffDensityTex.image.data);
  }

  restoreCliffDensitySnapshot(snapshot) {
    this.cliffDensityTex.image.data.set(snapshot);
    this.cliffDensityTex.needsUpdate = true;
    this._rebuildCliffOccupancy();
  }

  fillCliffDensity() {
    this.cliffDensityTex.image.data.fill(255);
    this.cliffDensityTex.needsUpdate = true;
    this._cliffOccupancy.fill(1);
    this._hasCliffData = true;
  }

  clearCliffDensity() {
    this.cliffDensityTex.image.data.fill(0);
    this.cliffDensityTex.needsUpdate = true;
    this._cliffOccupancy.fill(0);
    this._hasCliffData = false;
  }

  dispose() {
    if (this._currentGeos) {
      this._currentGeos.geoHigh?.dispose();
      this._currentGeos.geoMid?.dispose();
      this._currentGeos.geoFar?.dispose();
      this._currentGeos.geoMega?.dispose();
    }
    if (this.geosAndMats) {
      this.geosAndMats.material?.dispose();
      this.geosAndMats.materialMega?.dispose();
    }
    if (this.cliffGeosAndMats) {
      this.cliffGeosAndMats.material?.dispose();
      this.cliffGeosAndMats.materialMega?.dispose();
    }
    this.densityTex.dispose();
    this.terrainNormalTex.dispose();
    this.cliffHeightTex.dispose();
    this.cliffDensityTex.dispose();
    this.windTex?.dispose();
    this.specNoiseTex?.dispose();
    this.scene.remove(this.group);
    if (this.cliffGroup) this.scene.remove(this.cliffGroup);
  }
}
