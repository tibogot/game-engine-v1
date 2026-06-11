import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import {
  attribute,
  cameraPosition,
  cameraViewMatrix,
  dot,
  float,
  mix,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  smoothstep,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Drift-smoke LAB for v2/car-test.html.
 *
 * One shared emitter (slip/handbrake logic ported from
 * modularRoadDriftSmoke.js) + one shared CPU particle sim, feeding three
 * swappable renderer backends:
 *   "billboard" — the current modular-road look (CPU quads + sprite, alpha fade)
 *   "mesh"      — zelda-smoke instanced blobs, triplanar voronoi erosion,
 *                 posterized lighting (the BotW / Mario Kart drift puff)
 *   "hybrid"    — instanced camera-facing quads with the voronoi erosion
 *                 dissolve in the shader (cheap pixels, erosion death)
 *   "real"      — realistic flipbook smoke: 8x8 atlas with cross-faded frame
 *                 boil, fake spherical billboard lighting, density thinning
 *                 as puffs expand, ground fade (no hard terrain clip line)
 *
 * Nothing here touches modular-road.html; the winning backend gets ported
 * into modularRoadDriftSmoke.js once tuned.
 */

export const DRIFT_SMOKE_LAB_DEFAULTS = {
  mode: "real", // "billboard" | "mesh" | "hybrid" | "real"
  enabled: true,
  alwaysEmit: false, // debug: emit at rear wheels whenever grounded

  // ── Emitter / sim (shared by all modes) ──
  emitRate: 90,
  trigger: 0.04,
  lifeMin: 1.0,
  lifeMax: 2.0,
  sizeMin: 0.5,
  sizeMax: 0.9,
  sizeGrowth: 3.5,
  rise: 0.6,
  spread: 0.7,
  drag: 0.18,
  opacity: 0.55,
  spinSpeed: 0.5,
  turbulence: 0.8,

  // ── Billboard (current look) ──
  billboardColor: "#6a6c76",
  billboardOpacity: 0.55,

  // ── Zelda look (mesh + hybrid) ──
  tiling: 0.55,
  panSpeed: 0.12,
  holeDepth: 0.5,
  edgeNoise: 0.55,
  cutoff: 0.1,
  dissolveSoft: 0.16,
  erode: 1.15,
  fadeIn: 0.08,
  endFade: 0.18,
  lightStrength: 0.6,
  rimStrength: 0.22,
  rimPow: 3.0,
  posterize: true,
  steps: 3,
  normalRound: 0.85,
  colShadow: "#7b8492",
  colLit: "#f5f8fc",
  meshScale: 0.45,
  alphaTest: 0.05,

  // ── Hybrid only ──
  hybridTiling: 1.0,

  // ── Realistic flipbook (D) ──
  realTexture: "cloud", // "cloud" (single soft sprite) | "atlas" (flipbook boil)
  realBoil: 10, // atlas frames advanced over one particle life
  realFadeIn: 0.12,
  realHold: 0.35, // life fraction at full density before fade-out starts
  realFadeOutPow: 1.4,
  realThin: 1.2, // density loss as the puff expands
  realLight: 0.55,
  realGroundFade: 0.35,
  realColShadow: "#878e99",
  realColLit: "#ffffff",
};

const POOL_SIZE = 192;

// Emitter gates — same constants as modularRoadDriftSmoke.js.
const ENTRY_SPEED = 8;
const DRIFT_ANGLE_MIN = 0.1;
const MARK_Y_OFFSET = 0.045;

const VERTS_PER_PARTICLE = 6;
const FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 3;
const COLOR_FLOATS_PER_PARTICLE = VERTS_PER_PARTICLE * 4;
const _quadUvs = [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1];
const _quadCorners = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const _velHoriz = new THREE.Vector3();
const _chassisFwd = new THREE.Vector3();
const _rearContact0 = new THREE.Vector3();
const _rearContact1 = new THREE.Vector3();
const _scratchVel = new THREE.Vector3();
const _wheelFwd = new THREE.Vector3();
const _wheelRight = new THREE.Vector3();
const _rearPoints = [_rearContact0, _rearContact1];

const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _tint = new THREE.Color();
const _axis = new THREE.Vector3();

// Same 3-lump blob as zelda-smoke, but icosahedron detail 2 (not 3) — drift
// puffs are small on screen and we can have ~100 alive.
function makeBlobGeometry() {
  const a = new THREE.IcosahedronGeometry(1.0, 2);
  const b = new THREE.IcosahedronGeometry(0.8, 2).translate(0.95, 0.45, 0.15);
  const c = new THREE.IcosahedronGeometry(0.78, 2).translate(-0.7, 0.55, -0.35);
  const g = mergeGeometries([a, b, c]);
  g.deleteAttribute("uv");
  g.center();
  return g;
}

function makeUniforms(s, lightDir) {
  return {
    time: uniform(0),
    opacity: uniform(s.opacity),
    tiling: uniform(s.tiling),
    panSpeed: uniform(s.panSpeed),
    holeDepth: uniform(s.holeDepth),
    edgeNoise: uniform(s.edgeNoise),
    cutoff: uniform(s.cutoff),
    dissolveSoft: uniform(s.dissolveSoft),
    erode: uniform(s.erode),
    fadeIn: uniform(s.fadeIn),
    endFadeStart: uniform(1 - s.endFade),
    lightStrength: uniform(s.lightStrength),
    rimStrength: uniform(s.rimStrength),
    rimPow: uniform(s.rimPow),
    posterize: uniform(s.posterize ? 1 : 0),
    steps: uniform(s.steps),
    normalRound: uniform(s.normalRound),
    colShadow: uniform(new THREE.Color(s.colShadow)),
    colLit: uniform(new THREE.Color(s.colLit)),
    lightDir: uniform(lightDir.clone().normalize()),
    hybridTiling: uniform(s.hybridTiling),
    realBoil: uniform(s.realBoil),
    realFadeIn: uniform(s.realFadeIn),
    realHold: uniform(s.realHold),
    realFadeOutPow: uniform(s.realFadeOutPow),
    realThin: uniform(s.realThin),
    realLight: uniform(s.realLight),
    realGroundFade: uniform(s.realGroundFade),
    realColShadow: uniform(new THREE.Color(s.realColShadow)),
    realColLit: uniform(new THREE.Color(s.realColLit)),
  };
}

// ── Mode B material: zelda mesh smoke (triplanar voronoi PNG erosion) ──────
function buildMeshSmokeMaterial(voroTex, u) {
  const iSeed = attribute("iSeed", "float");
  const iLife = attribute("iLife", "float");
  const iCenter = attribute("iCenter", "vec3");

  const p = positionLocal.mul(u.tiling);
  const aN = normalLocal.abs();
  const bl = aN.div(aN.x.add(aN.y).add(aN.z).add(0.0001));
  const t = u.time.mul(u.panSpeed);
  const off = vec2(iSeed, iSeed.mul(1.7)).add(vec2(t.mul(0.3), t.negate()));
  const sX = texture(voroTex, p.yz.add(off)).r;
  const sY = texture(voroTex, p.xz.add(off)).r;
  const sZ = texture(voroTex, p.xy.add(off)).r;
  const V = sX.mul(bl.x).add(sY.mul(bl.y)).add(sZ.mul(bl.z));

  const N = normalWorld.normalize();
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const facing = dot(N, viewDir).clamp(0, 1);

  // Death by erosion: threshold climbs with particle age.
  const holed = facing.mul(mix(float(1), V, u.holeDepth));
  const edged = holed.add(V.sub(0.5).mul(u.edgeNoise));
  const thr = u.cutoff.add(iLife.mul(u.erode));
  const fadeIn = smoothstep(float(0), u.fadeIn, iLife);
  const endFade = float(1).sub(smoothstep(u.endFadeStart, float(1), iLife));
  const alpha = smoothstep(thr, thr.add(u.dissolveSoft), edged)
    .mul(fadeIn)
    .mul(endFade)
    .mul(u.opacity);

  // Blend mesh normal toward sphere-around-center for round puff shading.
  const sphN = positionWorld.sub(iCenter).normalize();
  const litN = mix(N, sphN, u.normalRound).normalize();
  const ndl = dot(litN, u.lightDir).clamp(0, 1);
  const lambert = mix(float(1), ndl, u.lightStrength);
  const banded = lambert.mul(u.steps).add(0.5).floor().div(u.steps);
  const litShade = mix(lambert, banded, u.posterize);
  const litCol = mix(u.colShadow, u.colLit, litShade);
  const rim = float(1).sub(facing).pow(u.rimPow).mul(u.rimStrength);

  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  });
  mat.colorNode = litCol.add(rim);
  mat.opacityNode = alpha;
  return mat;
}

// ── Mode C material: billboard quad + voronoi erosion dissolve ─────────────
function buildHybridMaterial(voroTex, u) {
  const iSeed = attribute("iSeed", "float");
  const iLife = attribute("iLife", "float");

  const st = uv();
  const d = st.sub(vec2(0.5, 0.5)).length().mul(2.0); // 0 center → 1 edge
  const radial = smoothstep(float(1.0), float(0.25), d);

  const t = u.time.mul(u.panSpeed);
  const off = vec2(iSeed, iSeed.mul(1.7)).add(vec2(t.mul(0.3), t.negate()));
  const V = texture(voroTex, st.mul(u.hybridTiling).add(off)).r;

  const edged = radial
    .mul(mix(float(1), V, u.holeDepth))
    .add(V.sub(0.5).mul(u.edgeNoise).mul(radial));
  const thr = u.cutoff.add(iLife.mul(u.erode));
  const fadeIn = smoothstep(float(0), u.fadeIn, iLife);
  const endFade = float(1).sub(smoothstep(u.endFadeStart, float(1), iLife));
  const alpha = smoothstep(thr, thr.add(u.dissolveSoft), edged)
    .mul(fadeIn)
    .mul(endFade)
    .mul(u.opacity);

  // Fake top-light: voronoi value + vertical gradient, optionally banded.
  const shade = smoothstep(float(0.15), float(0.85), V.mul(0.65).add(st.y.mul(0.35)));
  const banded = shade.mul(u.steps).add(0.5).floor().div(u.steps);
  const litShade = mix(shade, banded, u.posterize);

  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
  });
  mat.colorNode = mix(u.colShadow, u.colLit, litShade);
  mat.opacityNode = alpha;
  return mat;
}

// ── Mode D materials: realistic smoke (atlas flipbook OR cloud sprite) ─────
const ATLAS_COLS = 8;
const ATLAS_FRAMES = ATLAS_COLS * ATLAS_COLS;

// Shared body: lighting, lifetime curves, ground fade. `sample` provides
// { density, colorMul } from whichever texture front-end is in use.
function buildRealMaterialCore(u, sample) {
  const iSeed = attribute("iSeed", "float");
  const iLife = attribute("iLife", "float");
  const iGround = attribute("iGround", "float");

  const uvC = uv().sub(vec2(0.5, 0.5));
  const distC = uvC.length().mul(2.0);
  const mask = smoothstep(float(1.0), float(0.7), distC); // corner safety
  const { density: rawDensity, colorMul } = sample({ iSeed, iLife });
  const density = rawDensity.mul(mask);

  // Fake spherical billboard normal lit by the sun (in view space) — gives
  // the puff a lit top / shadowed underside instead of a flat decal.
  const sphN = vec3(
    uvC.x.mul(2),
    uvC.y.mul(2),
    float(1).sub(distC.mul(distC)).max(0).sqrt(),
  ).normalize();
  const lightVS = cameraViewMatrix.mul(vec4(u.lightDir, 0)).xyz.normalize();
  const ndl = dot(sphN, lightVS).mul(0.5).add(0.5); // wrap lighting
  const shade = mix(float(1), ndl, u.realLight);
  const tintVar = mix(float(0.82), float(1.0), iSeed.mul(3.7).fract());
  const col = mix(u.realColShadow, u.realColLit, shade).mul(tintVar).mul(colorMul);

  // Alpha: quick fade-in, HOLD at full density, then dissipate (the
  // fade-in/hold/fade-out curve is what cloud-puff-loop's bezier did).
  // Density also thins as the puff expands, and fades near the local
  // ground height (no hard terrain clip line).
  const fadeIn = smoothstep(float(0), u.realFadeIn, iLife);
  const fadeOut = float(1).sub(smoothstep(u.realHold, float(1), iLife)).pow(u.realFadeOutPow);
  const thin = float(1).div(iLife.mul(u.realThin).add(1));
  const groundFade = smoothstep(iGround, iGround.add(u.realGroundFade), positionWorld.y);
  const alpha = density
    .mul(fadeIn)
    .mul(fadeOut)
    .mul(thin)
    .mul(groundFade)
    .mul(u.opacity);

  const mat = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
  });
  mat.colorNode = col;
  mat.opacityNode = alpha;
  return mat;
}

// Atlas front-end: cross-faded flipbook "boil" — random start frame per
// particle, advancing realBoil frames over the particle's life.
function buildRealAtlasMaterial(atlasTex, u) {
  return buildRealMaterialCore(u, ({ iSeed, iLife }) => {
    const frame = iSeed.mul(ATLAS_FRAMES).add(iLife.mul(u.realBoil)).mod(ATLAS_FRAMES);
    const f0 = frame.floor();
    const blend = frame.fract();
    const f1 = f0.add(1).mod(ATLAS_FRAMES);
    // flipY: v=0 is the bottom row of the image, so invert the row index.
    const cellUv = (f) => {
      const col = f.mod(ATLAS_COLS);
      const row = f.div(ATLAS_COLS).floor();
      return uv().add(vec2(col, float(ATLAS_COLS - 1).sub(row))).div(ATLAS_COLS);
    };
    const d0 = texture(atlasTex, cellUv(f0)).r;
    const d1 = texture(atlasTex, cellUv(f1)).r;
    return { density: mix(d0, d1, blend), colorMul: float(1) };
  });
}

// Cloud front-end: single soft sprite (cloud-puff-loop's cloud.webp). Its RGB
// modulates the lit color so the texture's internal detail survives tinting.
function buildRealCloudMaterial(cloudTex, u) {
  return buildRealMaterialCore(u, () => {
    const samp = texture(cloudTex, uv());
    return { density: samp.a, colorMul: samp.rgb };
  });
}

export class DriftSmokeLab {
  /**
   * @param {object} opts
   * @param {THREE.Scene} opts.scene
   * @param {THREE.Vector3} opts.lightDir world-space dir toward the sun
   * @param {string} opts.spriteUrl  smoke sprite for billboard mode
   * @param {string} opts.voronoiUrl T_Voronoi01-style tiling voronoi PNG
   * @param {string} opts.atlasUrl   8x8 grayscale smoke flipbook atlas
   * @param {string} opts.cloudUrl   single soft cloud sprite (RGBA)
   * @param {typeof DRIFT_SMOKE_LAB_DEFAULTS} [opts.settings]
   */
  constructor({ scene, lightDir, spriteUrl, voronoiUrl, atlasUrl, cloudUrl, settings }) {
    this.settings = settings ?? structuredClone(DRIFT_SMOKE_LAB_DEFAULTS);
    const s = this.settings;

    // ── Shared particle pool ──
    this.particles = Array.from({ length: POOL_SIZE }, () => ({
      life: 0,
      maxLife: 1,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      size: 1,
      rotation: 0,
      spin: 0,
      seed: 0,
      axisX: 0,
      axisY: 1,
      axisZ: 0,
      groundY: 0,
    }));
    this.emitIndex = 0;
    this.emitAccum = [0, 0];

    const loader = new THREE.TextureLoader();
    const spriteTex = loader.load(spriteUrl, undefined, undefined, (err) =>
      console.warn("[driftSmokeLab] sprite failed:", spriteUrl, err),
    );
    spriteTex.colorSpace = THREE.SRGBColorSpace;
    const voroTex = loader.load(voronoiUrl, undefined, undefined, (err) =>
      console.warn("[driftSmokeLab] voronoi failed:", voronoiUrl, err),
    );
    voroTex.wrapS = voroTex.wrapT = THREE.RepeatWrapping;
    const atlasTex = loader.load(atlasUrl, undefined, undefined, (err) =>
      console.warn("[driftSmokeLab] smoke atlas failed:", atlasUrl, err),
    );
    const cloudTex = loader.load(cloudUrl, undefined, undefined, (err) =>
      console.warn("[driftSmokeLab] cloud sprite failed:", cloudUrl, err),
    );
    cloudTex.colorSpace = THREE.SRGBColorSpace;

    this.u = makeUniforms(s, lightDir ?? new THREE.Vector3(0.4, 1.0, 0.35));

    // ── Mode A: current billboard renderer (CPU quads) ──
    {
      const positions = new Float32Array(POOL_SIZE * FLOATS_PER_PARTICLE);
      const colors = new Float32Array(POOL_SIZE * COLOR_FLOATS_PER_PARTICLE);
      const uvs = new Float32Array(POOL_SIZE * VERTS_PER_PARTICLE * 2);
      for (let i = 0; i < POOL_SIZE; i++) uvs.set(_quadUvs, i * VERTS_PER_PARTICLE * 2);
      const geo = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(positions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("position", posAttr);
      const colAttr = new THREE.BufferAttribute(colors, 4);
      colAttr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute("color", colAttr);
      geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geo.setDrawRange(0, 0);
      const mat = new THREE.MeshBasicMaterial({
        map: spriteTex,
        color: 0xffffff,
        transparent: true,
        vertexColors: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      mesh.visible = false;
      scene.add(mesh);
      this.billboard = { mesh, geo, positions, colors };
    }

    // ── Mode B: zelda mesh smoke ──
    {
      const geo = makeBlobGeometry();
      this.meshSeed = new Float32Array(POOL_SIZE);
      this.meshLife = new Float32Array(POOL_SIZE).fill(1);
      this.meshCenter = new Float32Array(POOL_SIZE * 3);
      this.meshSeedAttr = new THREE.InstancedBufferAttribute(this.meshSeed, 1);
      this.meshLifeAttr = new THREE.InstancedBufferAttribute(this.meshLife, 1);
      this.meshCenterAttr = new THREE.InstancedBufferAttribute(this.meshCenter, 3);
      geo.setAttribute("iSeed", this.meshSeedAttr);
      geo.setAttribute("iLife", this.meshLifeAttr);
      geo.setAttribute("iCenter", this.meshCenterAttr);
      this.meshMat = buildMeshSmokeMaterial(voroTex, this.u);
      this.meshMat.alphaTest = s.alphaTest;
      const mesh = new THREE.InstancedMesh(geo, this.meshMat, POOL_SIZE);
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      mesh.count = 0;
      mesh.visible = false;
      scene.add(mesh);
      this.meshSmoke = { mesh, dummy: new THREE.Object3D() };
    }

    // ── Mode C: hybrid erosion billboard ──
    {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.deleteAttribute("normal");
      this.hybSeed = new Float32Array(POOL_SIZE);
      this.hybLife = new Float32Array(POOL_SIZE).fill(1);
      this.hybSeedAttr = new THREE.InstancedBufferAttribute(this.hybSeed, 1);
      this.hybLifeAttr = new THREE.InstancedBufferAttribute(this.hybLife, 1);
      geo.setAttribute("iSeed", this.hybSeedAttr);
      geo.setAttribute("iLife", this.hybLifeAttr);
      this.hybridMat = buildHybridMaterial(voroTex, this.u);
      const mesh = new THREE.InstancedMesh(geo, this.hybridMat, POOL_SIZE);
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      mesh.count = 0;
      mesh.visible = false;
      scene.add(mesh);
      this.hybrid = { mesh, dummy: new THREE.Object3D() };
    }

    // ── Mode D: realistic flipbook smoke ──
    {
      const geo = new THREE.PlaneGeometry(1, 1);
      geo.deleteAttribute("normal");
      this.realSeed = new Float32Array(POOL_SIZE);
      this.realLife = new Float32Array(POOL_SIZE).fill(1);
      this.realGround = new Float32Array(POOL_SIZE);
      this.realSeedAttr = new THREE.InstancedBufferAttribute(this.realSeed, 1);
      this.realLifeAttr = new THREE.InstancedBufferAttribute(this.realLife, 1);
      this.realGroundAttr = new THREE.InstancedBufferAttribute(this.realGround, 1);
      geo.setAttribute("iSeed", this.realSeedAttr);
      geo.setAttribute("iLife", this.realLifeAttr);
      geo.setAttribute("iGround", this.realGroundAttr);
      this.realAtlasMat = buildRealAtlasMaterial(atlasTex, this.u);
      this.realCloudMat = buildRealCloudMaterial(cloudTex, this.u);
      this.realMat = s.realTexture === "atlas" ? this.realAtlasMat : this.realCloudMat;
      const mesh = new THREE.InstancedMesh(geo, this.realMat, POOL_SIZE);
      mesh.frustumCulled = false;
      mesh.renderOrder = 22;
      mesh.count = 0;
      mesh.visible = false;
      scene.add(mesh);
      this.real = { mesh, dummy: new THREE.Object3D() };
    }

    this.applyLook();
  }

  applyLook() {
    const s = this.settings;
    const u = this.u;
    u.opacity.value = s.opacity;
    u.tiling.value = s.tiling;
    u.panSpeed.value = s.panSpeed;
    u.holeDepth.value = s.holeDepth;
    u.edgeNoise.value = s.edgeNoise;
    u.cutoff.value = s.cutoff;
    u.dissolveSoft.value = s.dissolveSoft;
    u.erode.value = s.erode;
    u.fadeIn.value = s.fadeIn;
    u.endFadeStart.value = 1 - THREE.MathUtils.clamp(s.endFade, 0.01, 0.9);
    u.lightStrength.value = s.lightStrength;
    u.rimStrength.value = s.rimStrength;
    u.rimPow.value = s.rimPow;
    u.posterize.value = s.posterize ? 1 : 0;
    u.steps.value = s.steps;
    u.normalRound.value = s.normalRound;
    u.colShadow.value.set(s.colShadow);
    u.colLit.value.set(s.colLit);
    u.hybridTiling.value = s.hybridTiling;
    u.realBoil.value = s.realBoil;
    u.realFadeIn.value = s.realFadeIn;
    u.realHold.value = s.realHold;
    u.realFadeOutPow.value = s.realFadeOutPow;
    u.realThin.value = s.realThin;
    u.realLight.value = s.realLight;
    u.realGroundFade.value = s.realGroundFade;
    u.realColShadow.value.set(s.realColShadow);
    u.realColLit.value.set(s.realColLit);
    if (this.meshMat.alphaTest !== s.alphaTest) {
      this.meshMat.alphaTest = s.alphaTest;
      this.meshMat.needsUpdate = true;
    }
    const wantedRealMat =
      s.realTexture === "atlas" ? this.realAtlasMat : this.realCloudMat;
    if (this.real && this.real.mesh.material !== wantedRealMat) {
      this.real.mesh.material = wantedRealMat;
      this.realMat = wantedRealMat;
    }
  }

  reset() {
    for (const p of this.particles) p.life = 0;
    this.emitAccum[0] = 0;
    this.emitAccum[1] = 0;
    this.billboard.geo.setDrawRange(0, 0);
    this.billboard.mesh.visible = false;
    this.meshSmoke.mesh.count = 0;
    this.meshSmoke.mesh.visible = false;
    this.hybrid.mesh.count = 0;
    this.hybrid.mesh.visible = false;
    this.real.mesh.count = 0;
    this.real.mesh.visible = false;
  }

  /**
   * Emitter — same slip/handbrake logic as modularRoadDriftSmoke.js, plus an
   * alwaysEmit debug bypass for tuning while parked.
   * @param {import("./modularRoadVehicle.js").Vehicle} vehicle
   */
  update(vehicle, camera, dt, keys = {}) {
    const s = this.settings;
    let emitSmoke = false;
    let smokeIntensity = 0;
    let velX = 0;
    let velZ = 0;
    let hasRear = false;

    if (vehicle?.enabled) {
      const body = vehicle.body;
      _velHoriz.copy(body.vel);
      _velHoriz.y = 0;
      const speed = _velHoriz.length();

      _chassisFwd.set(0, 0, 1).applyQuaternion(body.quat);
      _chassisFwd.y = 0;
      if (_chassisFwd.lengthSq() > 1e-8) _chassisFwd.normalize();

      let driftAngle = 0;
      if (speed > 0.5 && _chassisFwd.lengthSq() > 1e-8) {
        driftAngle = Math.acos(
          THREE.MathUtils.clamp(_velHoriz.dot(_chassisFwd) / speed, -1, 1),
        );
      }
      const driftAmount = THREE.MathUtils.clamp(
        (driftAngle - DRIFT_ANGLE_MIN) / 0.5,
        0,
        1,
      );
      const handbrake = !!keys.Space || !!vehicle.input?.handbrake;
      const handbrakeAmount = handbrake
        ? THREE.MathUtils.smoothstep(speed, ENTRY_SPEED, ENTRY_SPEED * 2.2)
        : 0;

      let rearSlip = 0;
      let rearIdx = 0;
      for (const tire of vehicle.tires) {
        if (tire.canSteer) continue;
        const contact = rearIdx === 0 ? _rearContact0 : _rearContact1;
        if (tire.grounded) {
          hasRear = true;
          contact.copy(tire.hitPoint).addScaledVector(tire.hitNormal, MARK_Y_OFFSET);
          body.getVelocityAtPoint(tire.worldPos, _scratchVel);
          _wheelFwd.set(0, 0, 1).applyQuaternion(body.quat);
          _wheelRight.set(1, 0, 0).applyQuaternion(body.quat);
          const vLat = Math.abs(_scratchVel.dot(_wheelRight));
          const vLong = Math.abs(_scratchVel.dot(_wheelFwd));
          rearSlip = Math.max(rearSlip, vLat / Math.max(vLong, 3.5));
        } else {
          contact.set(0, -9999, 0);
        }
        rearIdx++;
      }

      const slipAmount = THREE.MathUtils.clamp(rearSlip * 0.85, 0, 1);
      const driftIntensity = Math.max(driftAmount, handbrakeAmount, slipAmount);
      const inAir = vehicle.groundedCount === 0;
      if (s.alwaysEmit) {
        emitSmoke = hasRear;
        smokeIntensity = Math.max(driftIntensity, 0.7);
      } else {
        emitSmoke =
          hasRear &&
          !inAir &&
          speed > ENTRY_SPEED * 0.55 &&
          (driftIntensity > s.trigger ||
            (handbrake && speed > ENTRY_SPEED * 0.55));
        smokeIntensity = Math.max(driftIntensity, handbrake ? 0.45 : 0);
      }
      velX = body.vel.x;
      velZ = body.vel.z;
    }

    if (s.enabled === false) emitSmoke = false;

    if (emitSmoke) {
      const emitRate = s.emitRate * THREE.MathUtils.clamp(smokeIntensity, 0, 1);
      for (let i = 0; i < _rearPoints.length; i++) {
        const point = _rearPoints[i];
        if (!point || point.y < -9000) continue;
        this.emitAccum[i] += emitRate * dt;
        while (this.emitAccum[i] >= 1) {
          this._emitAt(point, smokeIntensity, velX, velZ);
          this.emitAccum[i] -= 1;
        }
      }
    } else {
      this.emitAccum[0] = 0;
      this.emitAccum[1] = 0;
    }

    // ── Shared sim integration ──
    const time = this.u.time.value;
    const turb = s.turbulence ?? 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      p.velocity.multiplyScalar(Math.max(0, 1 - dt * 0.85));
      if (turb > 0) {
        const k = p.seed * 12.9898;
        p.velocity.x += Math.sin(time * 2.3 + k) * turb * dt;
        p.velocity.z += Math.cos(time * 1.7 + k * 1.3) * turb * dt;
        p.velocity.y += (Math.sin(time * 2.9 + k * 0.7) * 0.5 + 0.25) * turb * dt * 0.5;
      }
      p.position.addScaledVector(p.velocity, dt);
      p.rotation += p.spin * s.spinSpeed * dt;
    }

    this.u.time.value += dt;

    // ── Render through the active backend only ──
    this.billboard.mesh.visible = false;
    this.meshSmoke.mesh.visible = false;
    this.hybrid.mesh.visible = false;
    this.real.mesh.visible = false;
    if (s.mode === "billboard") this._syncBillboard(camera);
    else if (s.mode === "hybrid") this._syncHybrid(camera);
    else if (s.mode === "real") this._syncReal(camera);
    else this._syncMesh();
  }

  _emitAt(point, intensity, velocityX, velocityZ) {
    const s = this.settings;
    const p = this.particles[this.emitIndex];
    this.emitIndex = (this.emitIndex + 1) % POOL_SIZE;

    const speed = Math.hypot(velocityX, velocityZ);
    const dirX = speed > 1e-4 ? velocityX / speed : 0;
    const dirZ = speed > 1e-4 ? velocityZ / speed : 0;
    const sideJitter = (Math.random() - 0.5) * s.spread;
    p.position.set(
      point.x - dirX * (0.12 + Math.random() * 0.25) + sideJitter * dirZ,
      point.y + 0.02 + Math.random() * 0.1,
      point.z - dirZ * (0.12 + Math.random() * 0.25) - sideJitter * dirX,
    );
    p.velocity.set(
      -dirX * speed * s.drag + (Math.random() - 0.5) * 0.45,
      s.rise * (0.65 + Math.random() * 0.7),
      -dirZ * speed * s.drag + (Math.random() - 0.5) * 0.45,
    );

    const lifeMin = Math.max(0.05, s.lifeMin);
    const lifeMax = Math.max(lifeMin, s.lifeMax);
    p.maxLife = THREE.MathUtils.lerp(lifeMin, lifeMax, Math.random());
    p.life = p.maxLife;

    const sizeMin = Math.max(0.01, s.sizeMin);
    const sizeMax = Math.max(sizeMin, s.sizeMax);
    p.size =
      THREE.MathUtils.lerp(sizeMin, sizeMax, Math.random()) *
      THREE.MathUtils.lerp(0.75, 1.25, THREE.MathUtils.clamp(intensity, 0, 1));
    p.rotation = Math.random() * Math.PI * 2;
    p.spin = (Math.random() - 0.5) * 1.7;
    p.seed = Math.random() * 10;
    p.groundY = point.y - MARK_Y_OFFSET;
    _axis
      .set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)
      .normalize();
    p.axisX = _axis.x;
    p.axisY = _axis.y;
    p.axisZ = _axis.z;
  }

  _syncBillboard(camera) {
    const s = this.settings;
    const { mesh, geo, positions, colors } = this.billboard;
    camera.updateMatrixWorld();
    _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _camUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    _tint.set(s.billboardColor);

    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      const age = 1 - p.life / p.maxLife;
      const size = p.size * (1 + age * s.sizeGrowth);
      const alpha = s.billboardOpacity * (1 - age) * (1 - age);

      const half = size * 0.5;
      const cosR = Math.cos(p.rotation);
      const sinR = Math.sin(p.rotation);
      const po = alive * FLOATS_PER_PARTICLE;
      const co = alive * COLOR_FLOATS_PER_PARTICLE;
      for (let i = 0; i < VERTS_PER_PARTICLE; i++) {
        const x = _quadCorners[i][0];
        const y = _quadCorners[i][1];
        const rx = (x * cosR - y * sinR) * half;
        const ry = (x * sinR + y * cosR) * half;
        _corner
          .copy(p.position)
          .addScaledVector(_camRight, rx)
          .addScaledVector(_camUp, ry);
        positions[po + i * 3] = _corner.x;
        positions[po + i * 3 + 1] = _corner.y;
        positions[po + i * 3 + 2] = _corner.z;
        colors[co + i * 4] = _tint.r;
        colors[co + i * 4 + 1] = _tint.g;
        colors[co + i * 4 + 2] = _tint.b;
        colors[co + i * 4 + 3] = alpha;
      }
      alive++;
    }

    geo.setDrawRange(0, alive * VERTS_PER_PARTICLE);
    mesh.visible = alive > 0;
    if (alive > 0) {
      const posAttr = geo.attributes.position;
      posAttr.addUpdateRange(0, alive * FLOATS_PER_PARTICLE);
      posAttr.needsUpdate = true;
      const colAttr = geo.attributes.color;
      colAttr.addUpdateRange(0, alive * COLOR_FLOATS_PER_PARTICLE);
      colAttr.needsUpdate = true;
    }
  }

  _syncMesh() {
    const s = this.settings;
    const { mesh, dummy } = this.meshSmoke;
    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      const age = 1 - p.life / p.maxLife;
      const scale = p.size * (1 + age * s.sizeGrowth) * s.meshScale;
      dummy.position.copy(p.position);
      _axis.set(p.axisX, p.axisY, p.axisZ);
      dummy.quaternion.setFromAxisAngle(_axis, p.rotation);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(alive, dummy.matrix);
      this.meshSeed[alive] = p.seed;
      this.meshLife[alive] = age;
      this.meshCenter[alive * 3] = p.position.x;
      this.meshCenter[alive * 3 + 1] = p.position.y;
      this.meshCenter[alive * 3 + 2] = p.position.z;
      alive++;
    }
    mesh.count = alive;
    mesh.visible = alive > 0;
    if (alive > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      this.meshSeedAttr.needsUpdate = true;
      this.meshLifeAttr.needsUpdate = true;
      this.meshCenterAttr.needsUpdate = true;
    }
  }

  _syncHybrid(camera) {
    const s = this.settings;
    const { mesh, dummy } = this.hybrid;
    camera.updateMatrixWorld();
    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      const age = 1 - p.life / p.maxLife;
      const size = p.size * (1 + age * s.sizeGrowth);
      dummy.position.copy(p.position);
      dummy.quaternion.copy(camera.quaternion);
      dummy.rotateZ(p.rotation);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(alive, dummy.matrix);
      this.hybSeed[alive] = p.seed;
      this.hybLife[alive] = age;
      alive++;
    }
    mesh.count = alive;
    mesh.visible = alive > 0;
    if (alive > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      this.hybSeedAttr.needsUpdate = true;
      this.hybLifeAttr.needsUpdate = true;
    }
  }

  _syncReal(camera) {
    const s = this.settings;
    const { mesh, dummy } = this.real;
    camera.updateMatrixWorld();
    let alive = 0;
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      const age = 1 - p.life / p.maxLife;
      const size = p.size * (1 + age * s.sizeGrowth);
      dummy.position.copy(p.position);
      dummy.quaternion.copy(camera.quaternion);
      dummy.rotateZ(p.rotation);
      dummy.scale.setScalar(size);
      dummy.updateMatrix();
      mesh.setMatrixAt(alive, dummy.matrix);
      this.realSeed[alive] = p.seed;
      this.realLife[alive] = age;
      this.realGround[alive] = p.groundY;
      alive++;
    }
    mesh.count = alive;
    mesh.visible = alive > 0;
    if (alive > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      this.realSeedAttr.needsUpdate = true;
      this.realLifeAttr.needsUpdate = true;
      this.realGroundAttr.needsUpdate = true;
    }
  }
}
