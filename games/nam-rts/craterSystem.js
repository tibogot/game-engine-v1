// Scorched-earth crater decals — GAME code.
//
// When a unit or structure is destroyed, a terrain-conforming decal is stamped at
// the wreck site, hugging slopes instead of floating.
//
// Every crater in the game is ONE instanced draw. Previously each crater built its
// own subdivided PlaneGeometry and lifted all 841 vertices to the terrain with CPU
// getWorldHeight() calls — so a stamp cost an 841-sample hitch plus a permanent
// draw call (two, actually: DoubleSide + transparent renders in two passes), up to
// 96 craters late game. Now they share one geometry and one instance buffer, and
// the draping happens in the vertex shader against the live heightmap
// (see terrainDrape.js). A stamp writes 4 floats; the whole field is 1 draw.
//
// crater-decal.png ships as RGB with a black surround; alpha comes from its
// brightness so the soft feathered edges blend into grass — in the SHADER.
// (It used to be derived on the CPU at load: a canvas readback and a loop over
// every pixel of a ~1400² image, ~0.9 s of main thread at every boot.)
import * as THREE from "three";
import { Fn, attribute, texture, uv, positionLocal, sin, cos, max, pow, smoothstep, float } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

const TEXTURE_URL = "/textures/crater-decal.png";
const MAX_CRATERS = 96;
const SUBDIV = 28;
const HEIGHT_OFFSET = 0.15;
const DECAL_RENDER_ORDER = 42;

async function loadCraterTexture(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export async function createCraterSystem({ app }) {
  const { scene, heightTexNode } = app;

  const tex = await loadCraterTexture(TEXTURE_URL);
  const texNode = texture(tex, uv());
  // Black surround → transparent, crater interior opaque (luminance-as-alpha
  // made dark soil invisible): the brightest channel, back in sRGB 0..1 (the
  // sampler hands us linear), smoothstepped 6/255 → 40/255 — the same rule
  // the CPU loop applied to the 8-bit sRGB bytes.
  const craterAlpha = smoothstep(
    float(6 / 255), float(40 / 255),
    pow(max(max(texNode.r, texNode.g), texNode.b), float(1 / 2.2)),
  );
  // depthTest ON so units and structures standing on a crater properly occlude it.
  // (It used to be off — a decal painted over the wreck sitting in it. That was safe
  // only because a CPU-conformed mesh could drift off the surface and z-fight; the
  // vertex-shader draping now tracks the ground exactly, so depth testing behaves.)
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // DoubleSide + transparent is drawn twice (back faces, then front) so overlapping
  // surfaces sort correctly. A flat decal on the ground never overlaps itself, so
  // that pass buys nothing — and the old per-crater meshes each paid for it.
  mat.forceSinglePass = true;
  mat.colorNode = texNode.rgb;
  mat.opacityNode = craterAlpha;

  // One subdivided plane, shared by every crater. Subdivision is what lets the
  // decal bend over slopes; the vertex shader does the bending.
  const src = new THREE.PlaneGeometry(1, 1, SUBDIV, SUBDIV).rotateX(-Math.PI / 2);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute("position", src.attributes.position);
  geo.setAttribute("uv", src.attributes.uv); // the decal texture rides on these

  // x, z, radius, rotation — one vec4 per crater.
  const craterAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CRATERS * 4), 4);
  craterAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aCrater", craterAttr);
  geo.instanceCount = 0;

  // The mesh sits at the origin with an identity transform, so the world position
  // we build here IS the local position three expects back.
  const craterVertex = Fn(() => {
    const aCrater = attribute("aCrater", "vec4");
    const s = sin(aCrater.w);
    const c = cos(aCrater.w);

    // PlaneGeometry(1,1) spans -0.5..0.5, so scaling by radius*2 gives a decal of
    // `radius` half-width — matching the old mesh's scale.
    const lx = positionLocal.x.mul(aCrater.z.mul(2));
    const lz = positionLocal.z.mul(aCrater.z.mul(2));
    // Y rotation, same as the old mesh's rotation.y (random per crater).
    const wx = lx.mul(c).add(lz.mul(s)).add(aCrater.x);
    const wz = lz.mul(c).sub(lx.mul(s)).add(aCrater.y);

    return drapedPosition(heightTexNode, wx, wz, HEIGHT_OFFSET);
  });
  mat.positionNode = craterVertex();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = DECAL_RENDER_ORDER;
  mesh.frustumCulled = false; // instances live anywhere; the bounds are meaningless
  mesh.visible = false;       // nothing to draw until the first crater is stamped

  const group = new THREE.Group();
  group.name = "RtsCraters";
  group.add(mesh);
  scene.add(group);

  let count = 0;  // craters stamped so far, capped at MAX_CRATERS
  let cursor = 0; // ring-buffer write slot — oldest crater is the one overwritten

  /** Stamp a scorched crater centred at world X/Z. Radius is the decal radius in metres. */
  function addCrater(x, z, radius = 4) {
    craterAttr.setXYZW(cursor, x, z, radius, Math.random() * Math.PI * 2);
    craterAttr.needsUpdate = true;

    cursor = (cursor + 1) % MAX_CRATERS;
    count = Math.min(count + 1, MAX_CRATERS);
    geo.instanceCount = count;
    mesh.visible = true;
  }

  function dispose() {
    scene.remove(group);
    geo.dispose();
    src.dispose();
    mat.dispose();
    tex.dispose();
  }

  return { addCrater, dispose, group };
}
