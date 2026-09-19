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
// crater-decal.png ships as RGB with a black surround; we derive alpha from
// luminance on load so the soft feathered edges blend into grass.
import * as THREE from "three";
import { Fn, attribute, texture, uv, positionLocal, sin, cos } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";

const TEXTURE_URL = "/textures/crater-decal.png";
const MAX_CRATERS = 96;
const SUBDIV = 28;
const HEIGHT_OFFSET = 0.15;
const DECAL_RENDER_ORDER = 42;

/** Black surround → transparent; crater interior stays opaque (lum-as-alpha made dark soil invisible). */
function alphaFromLum(lum) {
  if (lum < 6) return 0;
  if (lum > 40) return 255;
  const t = (lum - 6) / 34;
  return (t * t * (3 - 2 * t) * 255) | 0;
}

/** Black surround → transparent; coloured pixels keep their alpha for soft edges. */
function textureWithLuminanceAlpha(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.data.length; i += 4) {
        const lum = Math.max(data.data[i], data.data[i + 1], data.data[i + 2]);
        data.data[i + 3] = alphaFromLum(lum);
      }
      ctx.putImageData(data, 0, 0);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.needsUpdate = true;
      resolve(tex);
    };
    img.onerror = () => reject(new Error(`Failed to load crater texture: ${url}`));
    img.src = url;
  });
}

export async function createCraterSystem({ app }) {
  const { scene, heightTexNode } = app;

  const tex = await textureWithLuminanceAlpha(TEXTURE_URL);
  const texNode = texture(tex, uv());
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
  mat.opacityNode = texNode.a;

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
