// Fog of war — CoH-style vision grid → GPU texture → post-process ground overlay.
// SHARED machinery (games/shared-rts, moved from nam 2026-09-28): an entity
// can carry its own `vision` (metres); nam's building keys keep their defaults.
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
  Fn, float, max, mix, normalize, screenUV, smoothstep, step, texture, uniform, vec2, vec3, vec4,
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

/**
 * `look` (alg-rts opts in, 2026-10-04, you: "shouldn't it look like Company of Heroes?"):
 *   "shroud" (nam, as it was): fogged ground blends toward FIXED colours — a blue-grey shroud,
 *            near-black unexplored.
 *   "coh":   the ground keeps ITS colour, darkened and partly desaturated with a slight cool
 *            tint: unseen ~half as bright, never-explored a little darker still (CoH never
 *            blacks out the map — the land is known, what is on it is not). Multiplicative, so
 *            it follows the light by itself (night included).
 * `stage` "display" (alg-rts): the fog darkens the FINISHED frame (postFx.setDisplayModifier),
 *   after the exposure meter — darkening half the screen in the scene colour made the auto
 *   exposure brighten everything x2.5. A pre-modifier (the fog banks) stays in the scene colour.
 */
export function createFogOfWar({ app, units, structures, buildings, getRadioIntel = () => false, enabled: startEnabled = false, bounds = null, ridgeLOS = null, bakeHz = 0, look = "shroud", stage = "scene" }) {
  /** { eye, target } metres, or null: plain disks (nam). */
  const ridge = ridgeLOS;
  let bakeAcc = 0, baked = false;
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

  // OFF by default. The shroud hides the map you are building, and while this
  // game is being BUILT that is almost always the wrong trade — you want to see
  // the terrain, the vegetation and the props you just placed. It is one click
  // in the dev panel, and a match that wants it can ask for it at construction.
  let enabled = startEnabled;

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

  // RIDGES BLOCK SIGHT (opt-in `ridgeLOS`, alg-rts 2026-10-01): a cell is seen
  // only if the ground between the eye (`eye` m over the source) and the cell
  // (`target` m over it — a man's head) never rises above the line. The
  // ground is read from a height grid at the fog's own resolution, built once
  // (rebuildHeights() after the terrain changes) — array lookups, not
  // heightmap samples: ~20 sources × ~250 cells × ~8 steps a frame.
  let hgrid = null;
  function rebuildHeights() {
    hgrid = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const w = cellToWorld(c, r); hgrid[idx(c, r)] = app.getWorldHeight(w.x, w.z); }
  }
  function lineClear(cc, cr, c, r, eyeY, tgtY) {
    const dc = c - cc, dr = r - cr, n = Math.max(Math.abs(dc), Math.abs(dr));
    for (let k = 1; k < n; k++) {
      const f = k / n;
      const h = hgrid[idx(Math.round(cc + dc * f), Math.round(cr + dr * f))];
      if (h > eyeY + (tgtY - eyeY) * f) return false;
    }
    return true;
  }

  /** Stamp a circular vision disk. Marks explored + visible. */
  function stampVision(wx, wz, radius, eye = ridge?.eye ?? 2) {
    const rCells = Math.ceil(radius / cell);
    const { c: cc, r: cr } = worldToCell(wx, wz);
    const r2 = radius * radius;
    const los = ridge && inGrid(cc, cr);
    if (los && !hgrid) rebuildHeights();
    const eyeY = los ? hgrid[idx(cc, cr)] + eye : 0;
    for (let dr = -rCells; dr <= rCells; dr++) {
      for (let dc = -rCells; dc <= rCells; dc++) {
        const c = cc + dc;
        const r = cr + dr;
        if (!inGrid(c, r)) continue;
        const w = cellToWorld(c, r);
        const d2 = (w.x - wx) ** 2 + (w.z - wz) ** 2;
        if (d2 > r2) continue;
        const i = idx(c, r);
        if (los && Math.abs(dc) + Math.abs(dr) > 1 && !lineClear(cc, cr, c, r, eyeY, hgrid[i] + ridge.target)) continue;
        explored[i] = 1;
        visible[i] = 1;
      }
    }
  }

  function visionOfEntity(e) {
    if (e.vision) return e.vision;
    if (e.typeKey === "base") return DEFAULT_VISION.base;
    if (e.typeKey === "radio") return DEFAULT_VISION.radio;
    if (e.typeKey === "captureNode") return DEFAULT_VISION.captureNode;
    // A structure can see further by type — the guard tower does (buildings.js).
    if (e.isStructure) return e.type?.vision ?? DEFAULT_VISION.structure;
    return e.type?.vision ?? DEFAULT_VISION.unit;
  }

  function collectVisionSources() {
    const out = [];
    for (const u of units.list) {
      if (!u.alive || u.team !== "player") continue;
      out.push({ x: u.position.x, z: u.position.z, r: visionOfEntity(u), eye: u.isAir ? 40 : (u.type?.foot ? 2.2 : 3) });
    }
    for (const s of structures.list) {
      if (!s.alive || s.team !== "player") continue;
      if (s.constructing) continue;
      out.push({ x: s.position.x, z: s.position.z, r: visionOfEntity(s), eye: s.visionEye ?? 6 });
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
    for (const src of collectVisionSources()) stampVision(src.x, src.z, src.r, src.eye ?? 20);

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
    const uEnabled = uniform(1);
    const uHalf = float(half);
    const uMap = float(map);
    const uInvProj = uniform(new THREE.Matrix4());
    const uCamWorld = uniform(new THREE.Matrix4());
    const uCamPos = uniform(new THREE.Vector3());
    /* CONVERTED ONCE. `new THREE.Color(hex)` already runs sRGB->linear — setHex
     * defaults to SRGBColorSpace and calls toWorkingColorSpace, and nothing here
     * disables colour management — so the `.convertSRGBToLinear()` these used to
     * chain applied the curve a SECOND time and landed both about 12x darker
     * than their hex.
     *
     * That mattered most for the shroud. 0x3a4248 is a deliberate blue-grey, the
     * classic "explored but not currently visible" haze, and at 0.0034 linear it
     * rendered as near-black instead — so shroud and unexplored looked like the
     * same flat black and the distinction the two colours exist to draw was
     * invisible. Unlike the modular-road fix, the literals are NOT rebased here:
     * the authored intent is the point, and these are two easy numbers to taste.
     *
     * Shroud now reads ~0.042/0.055/0.066 linear rather than ~0.0034/0.0046/0.0056.
     * If it is too light, lower the hex — do not re-add the second conversion.
     */
    const uShroud = uniform(new THREE.Color(0x3a4248));
    const uUnexplored = uniform(new THREE.Color(0x06080c));
    const uDesat = float(0.55);
    const fowTexNode = texture(tex);

    const worldUv = (xz) => xz.add(vec2(uHalf, uHalf)).div(uMap);
    // THE PLAYABLE AREA (`bounds`, optional — alg-rts's box; nam has none):
    // outside it the ground (and what stands on it) is darkened and a little
    // desaturated, as in CoH — scenery, not ground you play on. Independent
    // of the fog of war's own on/off. uOut.w = 0: no box.
    const uOut = uniform(new THREE.Vector4(0, 0, 0, 0));      // x0, z0, x1, z1
    const uOutOn = uniform(bounds ? 1 : 0);
    // Style (setEdge): 0 = DARKEN (CoH), 1 = HAZE — the land fades into a dust
    // haze that thickens with distance past the edge (a fog wall; reads from
    // the free camera too). Strength 0-1; the haze's colour.
    const uOutMode = uniform(0), uOutStrength = uniform(1);
    const uOutColor = uniform(new THREE.Color(0xcdb58e));
    if (bounds) uOut.value.set(bounds.x0, bounds.z0, bounds.x1, bounds.z1);
    const outsideD = (xz) => max(max(uOut.x.sub(xz.x), xz.x.sub(uOut.z)), max(uOut.y.sub(xz.y), xz.y.sub(uOut.w)));
    const outsideDim = (xz) => smoothstep(float(0), float(14), outsideD(xz)).mul(uOutOn);
    edgeUniforms = { uOutOn, uOutMode, uOutStrength, uOutColor };

    // The CoH look's levels (live: fog.cohLook). 2026-10-07 (the AAA gap list: "unexplored = black-
    // brown, half the screen muddy"): was 0.34 / 0.5 brightness — CoH keeps fogged ground ~60-70%
    // and lets it read, desaturated. Now unexplored 0.6, seen-before 0.72, 55% of the colour gone.
    const uCohDark = uniform(0.6), uCohShroud = uniform(0.72), uCohDesat = uniform(0.55);
    cohLook = { dark: uCohDark, shroud: uCohShroud, desat: uCohDesat };
    const shadeRgb = look === "coh"
      // CoH: its own colour, darker, half desaturated, a touch cool (see `look` above).
      ? Fn(([rgb, fowUv]) => {
        const sample = texture(fowTexNode, fowUv);
        const strength = sample.r.mul(uEnabled);
        const isShroud = step(float(0.5), sample.g);
        const lum = rgb.dot(vec3(0.2126, 0.7152, 0.0722));
        const cool = mix(rgb, vec3(lum), uCohDesat).mul(vec3(0.9, 0.95, 1.04));
        const fogged = cool.mul(mix(uCohDark, uCohShroud, isShroud));
        return mix(rgb, fogged, strength);
      })
      : Fn(([rgb, fowUv]) => {
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
      // Outside the playable box. DARKEN: 45% darker, a third of its colour
      // gone. HAZE: toward the haze colour, 55% at the edge's end, ~90% 120 m out.
      const dim = outsideDim(groundXZ).mul(hitsGround).mul(uOutStrength);
      const lumO = shaded.dot(vec3(0.2126, 0.7152, 0.0722));
      const darkened = mix(shaded, vec3(lumO), float(0.35)).mul(0.55);
      const hazeK = mix(float(0.55), float(0.9), smoothstep(float(14), float(120), outsideD(groundXZ)));
      const hazed = mix(shaded, uOutColor, hazeK);
      const outside = mix(darkened, hazed, uOutMode);
      return mix(color, vec4(mix(shaded, outside, dim), color.a), hitsGround);
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
      /** The shroud's and the unexplored ground's colours x k (see setLightLevel below). */
      setLightLevel(k) {
        uShroud.value.setHex(0x3a4248).multiplyScalar(k);
        uUnexplored.value.setHex(0x06080c).multiplyScalar(k);
      },
    };
  }

  let post = null;
  let lightLevel = 1;               // setLightLevel: the fogged colours x this (1 = as authored)
  let edgeUniforms = null;         // the play-box edge's (set when the post pass is built)
  let cohLook = null;              // the "coh" look's level uniforms (set with the pass)
  const edge = { on: !!bounds, mode: "darken", strength: 1, color: "#cdb58e" };
  const pushEdge = () => {
    if (!edgeUniforms) return;
    edgeUniforms.uOutOn.value = bounds && edge.on ? 1 : 0;
    edgeUniforms.uOutMode.value = edge.mode === "haze" ? 1 : 0;
    edgeUniforms.uOutStrength.value = edge.strength;
    edgeUniforms.uOutColor.value.set(edge.color);
  };

  function update(_dt) {
    // The play-box dimming needs the camera even with the fog of war off.
    if (bounds) post?.syncCamera?.(app.camera);
    if (!enabled) return;
    // The vision grid at `bakeHz` (alg-rts 15: with ridge sight a bake is
    // ~1.2 ms of CPU, and a man walks under a metre in 1/15 s); 0 = every
    // frame (nam as it was).
    bakeAcc += _dt ?? 0;
    if (!bakeHz || bakeAcc >= 1 / bakeHz || !baked) { bakeAcc = 0; baked = true; bakeTexture(); }
    post?.syncCamera?.(app.camera);
  }

  // A modifier that runs BEFORE the fog of war in the same post hook (the
  // fog banks: mist over unexplored ground is darkened with it). Set later,
  // by whatever is built after the fog of war.
  let pre = null;
  let postApp = null;
  const hook = (color, ctx) => post.node(pre ? pre(color, ctx) : color);
  // stage "display": the fog on the finished frame, the pre-modifier alone in the scene colour.
  const displayStage = () => stage === "display" && !!postApp?.postFx?.setDisplayModifier;
  const preHook = (color, ctx) => (pre ? pre(color, ctx) : color);
  const fogHook = (color) => post.node(color);
  function hookUp() {
    if (displayStage()) {
      postApp.postFx.setSceneColorModifier?.(pre ? preHook : null);
      postApp.postFx.setDisplayModifier(fogHook);
    } else postApp?.postFx?.setSceneColorModifier?.(hook);
  }

  function installPostFx(appRef) {
    postApp = appRef;
    post = createPostModifier(appRef.camera);
    hookUp();
    post.syncCamera(appRef.camera);
    // The modifier is created enabled; it has to learn the state it missed,
    // because setEnabled may well have run before there was a `post` to tell.
    post.setEnabled(enabled);
    pushEdge();
    post.setLightLevel(lightLevel);
  }

  return {
    tex,
    miniCanvas,
    get enabled() { return enabled; },
    /** Re-read the ground for ridge sight (after the terrain changes: pads, craters). */
    rebuildHeights() { if (ridge) rebuildHeights(); },
    setEnabled(on) {
      enabled = !!on;
      post?.setEnabled(enabled);
    },
    update,
    installPostFx,
    /** The play-box edge (a game with `bounds`): { on, mode: "darken" | "haze", strength 0-1, color }. */
    get edge() { return { ...edge, available: !!bounds }; },
    /** The "coh" look's live levels { dark, shroud, desat } (uniforms; null before the pass is built). */
    get cohLook() { return cohLook; },
    setEdge(o = {}) { Object.assign(edge, o); pushEdge(); },
    /**
     * The fogged ground blends toward FIXED colours (the shroud's grey, the unexplored black): a
     * radiance, the same by night as by day — at night the shroud's grey glowed over the moonlit
     * land. A game scales them with its light: 1 by day (as before), ~0.02 at night.
     */
    setLightLevel(k) { lightLevel = k; post?.setLightLevel(k); },
    /** `(color, { scenePass }) => color`, run before the fog of war; null to drop it. */
    setPreModifier(fn) {
      pre = typeof fn === "function" ? fn : null;
      if (post) hookUp();   // rebuild the chain
    },
    isExplored,
    isVisible,
    canSeeEntity,
    hasRadioIntel: getRadioIntel,
    dispose() { tex.dispose(); },
  };
}
