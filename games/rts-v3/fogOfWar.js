// Fog of war — CoH-style vision grid → GPU texture → post-process ground overlay.
//
// Perf choices:
//   • Fixed 192×192 grid (~10 m cells on a 2048 map) — O(units × r²) stamp per frame,
//     no per-object scene queries.
//   • One RGBA DataTexture upload per frame (768 KB) — cheap vs re-rendering.
//   • Separable box blur (1 pass) softens circle stamps without a GPU blur pass.
//   • Post overlay ray-marches to the heightmap for ground + props (world-locked UVs).
//
// States per cell:
//   • unexplored — never seen (dark)
//   • explored   — seen before, currently hidden (desaturated shroud)
//   • visible    — in a friendly vision disk this frame (clear)
import * as THREE from "three";
import {
  Fn, float, max, mix, normalize, screenUV, step, texture, uniform, vec2, vec3, vec4,
} from "three/tsl";
import { drapeY } from "./terrainDrape.js";

const TEX_RES = 192;
const BLUR_R = 2;

/** Default sight radii (metres) when a type doesn't specify vision. */
export const DEFAULT_VISION = {
  unit: 40,
  structure: 52,
  base: 88,
  radio: 118,
  captureNode: 76,
};

function boxBlur(src, size, radius) {
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const cx = Math.min(size - 1, Math.max(0, x + k));
        sum += src[y * size + cx];
      }
      tmp[y * size + x] = sum / span;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const cy = Math.min(size - 1, Math.max(0, y + k));
        sum += tmp[cy * size + x];
      }
      dst[y * size + x] = sum / span;
    }
  }
  return dst;
}

export function createFogOfWar({ app, units, structures, buildings, getRadioIntel = () => false }) {
  const map = app.worldSize ?? 2048;
  const half = map * 0.5;
  const cell = map / TEX_RES;
  const cols = TEX_RES;
  const rows = TEX_RES;
  const heightTexNode = app.heightTexNode;

  const explored = new Uint8Array(cols * rows);
  const visible = new Uint8Array(cols * rows);
  const strengths = new Float32Array(cols * rows);

  const texData = new Uint8Array(TEX_RES * TEX_RES * 4);
  const tex = new THREE.DataTexture(texData, TEX_RES, TEX_RES, THREE.RGBAFormat);
  tex.flipY = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;

  // Minimap shroud layer — separate canvas so the tactical map can reuse it.
  const miniCanvas = document.createElement("canvas");
  miniCanvas.width = miniCanvas.height = TEX_RES;
  const miniCtx = miniCanvas.getContext("2d");

  let enabled = true;

  const idx = (c, r) => r * cols + c;
  const inGrid = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows;

  const worldToCell = (wx, wz) => ({
    c: Math.floor((wx + half) / cell),
    r: Math.floor((wz + half) / cell),
  });

  const cellToWorld = (c, r) => ({
    x: -half + (c + 0.5) * cell,
    z: -half + (r + 0.5) * cell,
  });

  /** Stamp a circular vision disk. Marks explored + visible. */
  function stampVision(wx, wz, radius) {
    const rCells = Math.ceil(radius / cell);
    const { c: cc, r: cr } = worldToCell(wx, wz);
    const r2 = radius * radius;
    for (let dr = -rCells; dr <= rCells; dr++) {
      for (let dc = -rCells; dc <= rCells; dc++) {
        const c = cc + dc;
        const r = cr + dr;
        if (!inGrid(c, r)) continue;
        const w = cellToWorld(c, r);
        const d2 = (w.x - wx) ** 2 + (w.z - wz) ** 2;
        if (d2 > r2) continue;
        const i = idx(c, r);
        explored[i] = 1;
        visible[i] = 1;
      }
    }
  }

  function visionOfEntity(e) {
    if (e.typeKey === "base") return DEFAULT_VISION.base;
    if (e.typeKey === "radio") return DEFAULT_VISION.radio;
    if (e.typeKey === "captureNode") return DEFAULT_VISION.captureNode;
    if (e.isStructure) return DEFAULT_VISION.structure;
    return e.type?.vision ?? DEFAULT_VISION.unit;
  }

  function collectVisionSources() {
    const out = [];
    for (const u of units.list) {
      if (!u.alive || u.team !== "player") continue;
      out.push({ x: u.position.x, z: u.position.z, r: visionOfEntity(u) });
    }
    for (const s of structures.list) {
      if (!s.alive || s.team !== "player") continue;
      if (s.constructing) continue;
      out.push({ x: s.position.x, z: s.position.z, r: visionOfEntity(s) });
    }
    for (const b of buildings.list) {
      if (!b.alive || b.team !== "player") continue;
      if (b.constructing || b.built < 1) continue;
      out.push({ x: b.position.x, z: b.position.z, r: visionOfEntity(b) });
    }
    return out;
  }

  function bakeTexture() {
    visible.fill(0);
    for (const src of collectVisionSources()) stampVision(src.x, src.z, src.r);

    for (let i = 0; i < strengths.length; i++) {
      if (visible[i]) strengths[i] = 0;
      else if (explored[i]) strengths[i] = 0.58;
      else strengths[i] = 0.94;
    }

    const blurred = boxBlur(strengths, TEX_RES, BLUR_R);

    for (let i = 0; i < blurred.length; i++) {
      const p = i * 4;
      texData[p] = Math.round(Math.min(1, Math.max(0, blurred[i])) * 255);
      texData[p + 1] = explored[i] ? 255 : 0;
      texData[p + 2] = 0;
      texData[p + 3] = 255;
    }
    tex.needsUpdate = true;

    if (miniCtx) {
      const img = miniCtx.createImageData(TEX_RES, TEX_RES);
      const md = img.data;
      // Grid (c,r) uses +X→high c, +Z→high r. The minimap uses the same axes as
      // bakeTerrain / worldToMini (+X left, +Z top) — mirror both when copying.
      for (let r = 0; r < TEX_RES; r++) {
        for (let c = 0; c < TEX_RES; c++) {
          const i = idx(c, r);
          const s = blurred[i];
          const cx = TEX_RES - 1 - c;
          const cy = TEX_RES - 1 - r;
          const p = (cy * TEX_RES + cx) * 4;
          if (s < 0.04) {
            md[p] = md[p + 1] = md[p + 2] = 255;
            md[p + 3] = 0;
          } else if (explored[i]) {
            md[p] = 58; md[p + 1] = 64; md[p + 2] = 74;
            md[p + 3] = Math.round(s * 210);
          } else {
            md[p] = 10; md[p + 1] = 12; md[p + 2] = 18;
            md[p + 3] = Math.round(s * 255);
          }
        }
      }
      miniCtx.putImageData(img, 0, 0);
    }
  }

  function isExplored(wx, wz) {
    const { c, r } = worldToCell(wx, wz);
    if (!inGrid(c, r)) return false;
    return explored[idx(c, r)] === 1;
  }

  function isVisible(wx, wz) {
    const { c, r } = worldToCell(wx, wz);
    if (!inGrid(c, r)) return false;
    return visible[idx(c, r)] === 1;
  }

  /** Should an enemy entity render this frame? Player stuff is always shown. */
  function canSeeEntity(e) {
    if (!enabled) return true;
    if (e.team === "player") return true;
    return isVisible(e.position.x, e.position.z);
  }

  /** Post-process modifier — shades ground pixels using world-locked FoW UVs. */
  function createPostModifier(camera) {
    const uEnabled = float(1);
    const uHalf = float(half);
    const uMap = float(map);
    const uInvProj = uniform(new THREE.Matrix4());
    const uCamWorld = uniform(new THREE.Matrix4());
    const uCamPos = uniform(new THREE.Vector3());
    const uShroud = uniform(new THREE.Color(0x3a4248).convertSRGBToLinear());
    const uUnexplored = uniform(new THREE.Color(0x06080c).convertSRGBToLinear());
    const uDesat = float(0.55);
    const fowTexNode = texture(tex);

    const worldUv = (xz) => xz.add(vec2(uHalf, uHalf)).div(uMap);

    const shadeRgb = Fn(([rgb, fowUv]) => {
      const sample = texture(fowTexNode, fowUv);
      const strength = sample.r.mul(uEnabled);
      const isShroud = step(float(0.5), sample.g);
      const lum = rgb.dot(vec3(0.2126, 0.7152, 0.0722));
      const desat = mix(vec3(lum), rgb, float(1).sub(uDesat));
      const shrouded = mix(desat, uShroud, strength.mul(float(0.78)));
      const hidden = mix(rgb, uUnexplored, strength);
      const fogged = mix(hidden, shrouded, isShroud);
      return mix(rgb, fogged, strength);
    });

    const apply = Fn(([color]) => {
      const ndc = vec2(screenUV.x, float(1).sub(screenUV.y)).mul(2).sub(1);
      const near4 = uInvProj.mul(vec4(ndc.x, ndc.y, float(-1), float(1)));
      const far4 = uInvProj.mul(vec4(ndc.x, ndc.y, float(1), float(1)));
      const nearView = near4.xyz.div(near4.w);
      const farView = far4.xyz.div(far4.w);
      const worldNear = uCamWorld.mul(vec4(nearView, float(1))).xyz;
      const worldFar = uCamWorld.mul(vec4(farView, float(1))).xyz;
      const rayDir = normalize(worldFar.sub(worldNear));
      const camPos = uCamPos;
      const hitsGround = rayDir.y
        .lessThan(float(-0.0001))
        .select(float(1), float(0));
      let groundXZ;
      if (heightTexNode) {
        const t0 = float(0).sub(camPos.y).div(rayDir.y);
        const hit0 = camPos.add(rayDir.mul(max(t0, float(0))));
        const t1 = drapeY(heightTexNode, hit0.x, hit0.z).sub(camPos.y).div(rayDir.y);
        const hit1 = camPos.add(rayDir.mul(max(t1, float(0))));
        const t2 = drapeY(heightTexNode, hit1.x, hit1.z).sub(camPos.y).div(rayDir.y);
        const hit2 = camPos.add(rayDir.mul(max(t2, float(0))));
        groundXZ = vec2(hit2.x, hit2.z);
      } else {
        const t = float(0).sub(camPos.y).div(rayDir.y);
        const hit = camPos.add(rayDir.mul(max(t, float(0))));
        groundXZ = vec2(hit.x, hit.z);
      }
      const shaded = shadeRgb(color.rgb, worldUv(groundXZ));
      return mix(color, vec4(shaded, color.a), hitsGround);
    });

    function syncCamera(cam) {
      uInvProj.value.copy(cam.projectionMatrixInverse);
      uCamWorld.value.copy(cam.matrixWorld);
      uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    }

    if (camera) syncCamera(camera);

    return {
      node: apply,
      syncCamera,
      setEnabled(on) { uEnabled.value = on ? 1 : 0; },
    };
  }

  let post = null;

  function update(_dt) {
    if (!enabled) return;
    bakeTexture();
    post?.syncCamera?.(app.camera);
  }

  function installPostFx(appRef) {
    post = createPostModifier(appRef.camera);
    appRef.postFx?.setSceneColorModifier?.((color) => post.node(color));
    post.syncCamera(appRef.camera);
  }

  return {
    tex,
    miniCanvas,
    get enabled() { return enabled; },
    setEnabled(on) {
      enabled = !!on;
      post?.setEnabled(enabled);
    },
    update,
    installPostFx,
    isExplored,
    isVisible,
    canSeeEntity,
    hasRadioIntel: getRadioIntel,
    dispose() { tex.dispose(); },
  };
}
