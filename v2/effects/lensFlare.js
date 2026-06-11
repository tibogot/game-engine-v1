/**
 * Sun-anchored lens flare (no post-processing), ported from `splatmap-chunks.html`.
 * Group follows the camera; quads in camera-local space. Uses TSL `MeshBasicNodeMaterial`.
 */
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three";
import { mul, texture, uniform, uv } from "three/tsl";

function makeRadialTex(size, power, innerWhite) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(size, size);
  const half = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - half) / half;
      const dy = (y - half) / half;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const a = Math.pow(1 - r, power);
      const core = innerWhite ? Math.pow(1 - r, power * 3) : 0;
      const v = Math.min(1, a + core);
      const idx = (y * size + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(v * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeStreakTex(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const hx = w * 0.5;
  const hy = h * 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x - hx) / hx;
      const v = (y - hy) / hy;
      const fx = Math.pow(1 - Math.min(1, Math.abs(u)), 1.4);
      const fy = Math.pow(1 - Math.min(1, Math.abs(v)), 3.5);
      const a = Math.max(0, fx * fy);
      const idx = (y * w + x) * 4;
      img.data[idx] = 255;
      img.data[idx + 1] = 255;
      img.data[idx + 2] = 255;
      img.data[idx + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeHexTex(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const cx = size * 0.5;
  const cy = size * 0.5;
  const r = size * 0.42;
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.6, "rgba(255,255,255,0.45)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grd;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeDirtTex(size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const rr = 6 + Math.random() * 60;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    const a = 0.05 + Math.random() * 0.22;
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 400; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const rr = 0.6 + Math.random() * 1.6;
    ctx.fillStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.6})`;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 20 + Math.random() * 80;
    const ang = Math.random() * Math.PI * 2;
    ctx.strokeStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.15})`;
    ctx.lineWidth = 0.5 + Math.random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeFlareMat(tex, colorHex) {
  const m = new MeshBasicNodeMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const uCol = uniform(new THREE.Color(colorHex).convertSRGBToLinear());
  const uInt = uniform(1.0);
  const sampled = texture(tex, uv());
  m.colorNode = mul(sampled.rgb, uCol);
  m.opacityNode = mul(sampled.a, uInt);
  m.fog = false;
  m.userData = { uCol, uInt };
  return m;
}

function swapFlareTexture(mesh, newTex, colorHex) {
  newTex.colorSpace = THREE.SRGBColorSpace;
  newTex.needsUpdate = true;
  const oldMat = mesh.material;
  const newMat = makeFlareMat(newTex, colorHex);
  newMat.userData.uCol.value.copy(oldMat.userData.uCol.value);
  newMat.userData.uInt.value = oldMat.userData.uInt.value;
  mesh.material = newMat;
  oldMat.dispose();
}

const GHOST_DEFS = [
  { t: 0.18, size: 0.1, color: "#ff8a66" },
  { t: 0.34, size: 0.06, color: "#ffd980" },
  { t: 0.5, size: 0.16, color: "#9ed4ff" },
  { t: 0.72, size: 0.08, color: "#b298ff" },
  { t: 1.1, size: 0.22, color: "#66d0ff" },
  { t: 1.45, size: 0.05, color: "#fff2a8" },
];

/**
 * @param {object} opts
 * @param {THREE.Scene} opts.scene
 * @param {THREE.PerspectiveCamera} opts.camera
 * @param {() => THREE.Vector3} opts.getSunDir — world-space sun direction (unit), same as v1 `sunDir`.
 * @param {() => object} opts.getParams — lens flare settings object (mutated by Tweakpane).
 * @param {{ halation?: string, ghosts?: string }} [opts.textureUrls] — optional PNG upgrades (v1 paths).
 */
export function createLensFlareSystem({
  scene,
  camera,
  getSunDir,
  getParams,
  textureUrls = {
    halation: "./textures/lensflare0.png",
    ghosts: "./textures/lensflare3.png",
  },
}) {
  const halationTex = makeRadialTex(256, 2.0, true);
  const ghostTex = makeHexTex(128);
  const streakTex = makeStreakTex(512, 32);
  const dirtTex = makeDirtTex(512);

  const group = new THREE.Group();
  group.renderOrder = 9999;
  scene.add(group);

  const params0 = getParams();
  const halationMat = makeFlareMat(halationTex, params0.halationColor);
  const halation = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), halationMat);
  halation.renderOrder = 9998;
  halation.frustumCulled = false;
  group.add(halation);

  const streakMat = makeFlareMat(streakTex, params0.streakColor);
  const streak = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), streakMat);
  streak.renderOrder = 9998;
  streak.frustumCulled = false;
  group.add(streak);

  const ghosts = GHOST_DEFS.map((def) => {
    const mat = makeFlareMat(ghostTex, def.color);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    mesh.renderOrder = 9998;
    mesh.frustumCulled = false;
    mesh.userData.def = def;
    group.add(mesh);
    return mesh;
  });

  const dirtMat = makeFlareMat(dirtTex, "#ffffff");
  const dirt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dirtMat);
  dirt.renderOrder = 9997;
  dirt.frustumCulled = false;
  group.add(dirt);

  const loader = new THREE.TextureLoader();
  if (textureUrls.halation) {
    loader.load(
      textureUrls.halation,
      (tex) => {
        swapFlareTexture(halation, tex, getParams().halationColor);
      },
      undefined,
      () => {},
    );
  }
  if (textureUrls.ghosts) {
    loader.load(
      textureUrls.ghosts,
      (tex) => {
        for (const g of ghosts) {
          swapFlareTexture(g, tex, g.userData.def.color);
        }
      },
      undefined,
      () => {},
    );
  }

  const sunLocal = new THREE.Vector3();
  const camQuatInv = new THREE.Quaternion();

  function update() {
    const p = getParams();
    if (!p.enabled) {
      group.visible = false;
      return;
    }
    group.position.copy(camera.position);
    group.quaternion.copy(camera.quaternion);

    const sunDir = getSunDir();
    camQuatInv.copy(camera.quaternion).invert();
    sunLocal.copy(sunDir).applyQuaternion(camQuatInv);

    if (sunLocal.z >= -0.001) {
      group.visible = false;
      return;
    }
    group.visible = true;

    const horizonVis = THREE.MathUtils.smoothstep(sunDir.y, -0.02, 0.18);

    const invZ = 1 / -sunLocal.z;
    const sxView = sunLocal.x * invZ;
    const syView = sunLocal.y * invZ;
    const fovRad = (camera.fov * Math.PI) / 180;
    const halfH = Math.tan(fovRad * 0.5);
    const halfW = halfH * camera.aspect;
    const ndcX = sxView / halfW;
    const ndcY = syView / halfH;

    const radius = Math.sqrt(ndcX * ndcX + ndcY * ndcY);
    const screenVis = 1 - THREE.MathUtils.smoothstep(radius, 0.4, 2.0);
    const offFrameVis = 1 - THREE.MathUtils.smoothstep(radius, 0.0, 3.0);

    const master = p.intensity * horizonVis;
    if (master < 0.001) {
      group.visible = false;
      return;
    }

    const Z = -1.0;
    const worldPerNdcX = halfW;
    const worldPerNdcY = halfH;
    const sunWX = ndcX * worldPerNdcX;
    const sunWY = ndcY * worldPerNdcY;

    halation.position.set(sunWX, sunWY, Z);
    const halScale = p.halationSize * halfH * 1.4;
    halation.scale.set(halScale, halScale, 1);
    halation.material.userData.uInt.value = master * screenVis * 1.4;
    halation.material.userData.uCol.value.set(p.halationColor).convertSRGBToLinear();

    streak.position.set(sunWX, sunWY, Z);
    streak.scale.set(p.streakLength * halfW * 4.0, halfH * 0.12, 1);
    streak.material.userData.uInt.value = master * screenVis * p.streakOpacity;
    streak.material.userData.uCol.value.set(p.streakColor).convertSRGBToLinear();

    for (let i = 0; i < ghosts.length; i++) {
      const g = ghosts[i];
      const def = g.userData.def;
      const t = def.t * p.ghostSpacing;
      const gx = sunWX * (1 - t * 2);
      const gy = sunWY * (1 - t * 2);
      g.position.set(gx, gy, Z);
      const s = def.size * halfH * 2.0;
      g.scale.set(s, s, 1);
      g.material.userData.uInt.value = master * offFrameVis * p.ghostOpacity;
    }

    dirt.position.set(0, 0, Z);
    dirt.scale.set(halfW * 2, halfH * 2, 1);
    dirt.material.userData.uInt.value = master * screenVis * p.dirtOpacity * 0.9;
  }

  function dispose() {
    scene.remove(group);
    halationTex.dispose();
    ghostTex.dispose();
    streakTex.dispose();
    dirtTex.dispose();
    halation.geometry.dispose();
    streak.geometry.dispose();
    dirt.geometry.dispose();
    halation.material.dispose();
    streak.material.dispose();
    dirt.material.dispose();
    for (const g of ghosts) {
      g.geometry.dispose();
      g.material.dispose();
    }
  }

  return { group, update, dispose };
}
