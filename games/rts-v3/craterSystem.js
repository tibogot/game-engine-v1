// Scorched-earth crater decals — GAME code.
//
// When a unit or structure is destroyed, a terrain-conforming decal is stamped
// at the wreck site. The mesh is a subdivided plane whose vertices are lifted
// to the live terrain height each placement (same recipe as the editor's
// conform-to-terrain decals), so craters hug slopes instead of floating.
//
// crater-decal.png ships as RGB with a black surround; we derive alpha from
// luminance on load so the soft feathered edges blend into grass.
import * as THREE from "three";
import { texture, uv } from "three/tsl";

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
  const { scene } = app;
  const getH = app.getWorldHeight ?? (() => 0);

  const tex = await textureWithLuminanceAlpha(TEXTURE_URL);
  const texNode = texture(tex, uv());
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  mat.colorNode = texNode.rgb;
  mat.opacityNode = texNode.a;

  const group = new THREE.Group();
  group.name = "RtsCraters";
  scene.add(group);

  const craters = [];
  const _v = new THREE.Vector3();
  const _obj = new THREE.Object3D();

  function buildMesh(cx, cz, radius, rotation) {
    _obj.position.set(cx, 0, cz);
    _obj.rotation.set(0, rotation, 0);
    _obj.scale.set(radius * 2, 1, radius * 2);
    _obj.updateMatrixWorld(true);

    const geo = new THREE.PlaneGeometry(1, 1, SUBDIV, SUBDIV);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      _v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      _obj.localToWorld(_v);
      _v.y = getH(_v.x, _v.z) + HEIGHT_OFFSET;
      _obj.worldToLocal(_v);
      pos.setXYZ(i, _v.x, _v.y, _v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = DECAL_RENDER_ORDER;
    mesh.frustumCulled = false;
    _obj.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    return mesh;
  }

  /** Stamp a scorched crater centred at world X/Z. Radius is the decal radius in metres. */
  function addCrater(x, z, radius = 4) {
    const mesh = buildMesh(x, z, radius, Math.random() * Math.PI * 2);
    group.add(mesh);
    craters.push(mesh);

    while (craters.length > MAX_CRATERS) {
      const old = craters.shift();
      group.remove(old);
      old.geometry.dispose();
    }
  }

  function dispose() {
    scene.remove(group);
    for (const m of craters) m.geometry.dispose();
    craters.length = 0;
    mat.dispose();
    tex.dispose();
  }

  return { addCrater, dispose, group };
}
