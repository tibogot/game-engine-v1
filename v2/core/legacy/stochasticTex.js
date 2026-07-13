/**
 * Stochastic (no-tile) texture sampling for TSL materials.
 *
 * Three optimisations over the naïve 4-sample square grid:
 *
 *  1. 3-sample triangular grid (Quilez-style)
 *     The unit square is split diagonally into two triangles; we sample
 *     the 3 corners of whichever triangle a fragment falls in.
 *     25% fewer texture taps than 4-corner square, and no diagonal bias.
 *
 *  2. Distance fade (colour crossfade)
 *     Beyond FADE_START the blended stochastic colour crossfades toward one
 *     plain-UV tap, reaching fully plain at FADE_END — kills stochastic
 *     cell-edge artifacts at distance. The hash offsets themselves stay
 *     world-anchored constants: scaling them by the camera-relative fade
 *     (the previous scheme) made the texture visibly SLIDE as the camera
 *     moved anywhere in the band — glaring on cliff faces, which sit at
 *     mid-distance and face the camera head-on. A colour dissolve has no
 *     slide.
 *
 *  3. Albedo-only (callers)
 *     ORM (roughness / AO / normals) is sampled with plain texture() by
 *     the callers — tiling in those channels is barely perceptible.
 *     Net cost: 4 albedo samples (3 stochastic + 1 plain for the crossfade)
 *     vs 1 before, ORM unchanged.
 *
 *  Toggle: a floating button is injected so you can compare perf / visuals.
 *  It saves to localStorage and reloads — the disabled path builds plain
 *  texture() nodes so there is truly zero stochastic overhead in the shader.
 */
import {
  vec2, float,
  floor, fract, max, min, mix, step, smoothstep,
  texture, cameraPosition, positionWorld, length,
} from "three/tsl";
import { hash22 } from "./tsl-utils.js";

// ── preference (read once at module load, drives node-graph construction) ──────
const _LS_KEY = "terrain_stochastic";
export const STOCHASTIC_ENABLED = localStorage.getItem(_LS_KEY) !== "false";

/** Flip the persisted stochastic preference and reload (shader graph is built at load). */
export function toggleStochastic() {
  localStorage.setItem(_LS_KEY, STOCHASTIC_ENABLED ? "false" : "true");
  location.reload();
}

// ── floating toggle button ─────────────────────────────────────────────────────
// Pages with their own UI opt out via <body data-stochastic-ui="custom"> and
// call toggleStochastic() from their own control (v3 editor does this).
function _injectToggleButton() {
  if (document.body?.dataset.stochasticUi === "custom") return;
  const btn = document.createElement("button");
  btn.textContent = `Stochastic tiling: ${STOCHASTIC_ENABLED ? "ON ✓" : "OFF ✗"}`;
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "12px",
    right: "12px",
    zIndex: "9999",
    padding: "6px 14px",
    background: STOCHASTIC_ENABLED ? "#1a4a1a" : "#4a1a1a",
    color: "#fff",
    border: "1px solid #666",
    borderRadius: "5px",
    cursor: "pointer",
    fontFamily: "monospace",
    fontSize: "12px",
  });
  btn.onclick = () => {
    localStorage.setItem(_LS_KEY, STOCHASTIC_ENABLED ? "false" : "true");
    location.reload();
  };
  if (document.body) {
    document.body.appendChild(btn);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      if (document.body.dataset.stochasticUi === "custom") return;
      document.body.appendChild(btn);
    });
  }
}
_injectToggleButton();

// ── distance fade node (created once, shared across all stochastic calls) ─────
// Evaluates per-fragment at runtime; TSL deduplicates the shared node reference.
//
// The fade is CAMERA-relative and drives a COLOUR crossfade (stochastic blend →
// one plain tap), never the hash offsets. Scaling the offsets by this fade — the
// original scheme — made the texture content slide/morph whenever the camera
// moved, because every fragment's UV offset changed per frame. Ground at grazing
// angle hid it after the band was pushed to 300–1200 m, but cliff faces sit at
// exactly that range, viewed head-on, and kept morphing. A dissolve between two
// world-stable samples has no slide at any distance or slope.
const _FADE_START = 300.0;
const _FADE_END   = 1200.0;
const _distFade = float(1).sub(
  smoothstep(_FADE_START, _FADE_END, length(positionWorld.sub(cameraPosition))),
);

// ── triangular-grid weights ───────────────────────────────────────────────────
// Split the unit square on its diagonal into two triangles:
//   Lower-right (f.x >= f.y): corners (0,0), (1,0), (1,1)
//   Upper-left  (f.y >  f.x): corners (0,0), (0,1), (1,1)
// Both triangles always share (0,0) and (1,1); only the middle corner differs.
// Barycentric weights: w00 + w1 + w11 = 1.
function _triWeights(f) {
  const mainF  = max(f.x, f.y);
  const crossF = min(f.x, f.y);
  const w00 = float(1).sub(mainF);   // corner (0,0)
  const w11 = crossF;                // corner (1,1)
  const w1  = mainF.sub(crossF);    // middle corner
  const cond = step(f.y, f.x);      // 1 if f.x >= f.y, else 0
  const i1   = vec2(cond, float(1).sub(cond)); // (1,0) or (0,1)
  return { w00, w1, w11, i1 };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Stochastic drop-in for texture(texNode, uv). Use for albedo textures.
 * When STOCHASTIC_ENABLED is false, returns a plain texture() node.
 *
 * @param {THREE.Texture}              texNode
 * @param {import("three/tsl").Node}   uv        vec2, world-space tiled UV
 * @returns {import("three/tsl").Node}            vec4
 */
export function stochasticSample(texNode, uv) {
  if (!STOCHASTIC_ENABLED) return texture(texNode, uv);

  const i = floor(uv);
  const f = fract(uv);
  const { w00, w1, w11, i1 } = _triWeights(f);

  // World-anchored constant offsets; the camera-relative fade only crossfades
  // the resulting colour toward a plain tap (see _distFade comment).
  const stoch = texture(texNode, uv.add(hash22(i))).mul(w00)
    .add(texture(texNode, uv.add(hash22(i.add(i1)))).mul(w1))
    .add(texture(texNode, uv.add(hash22(i.add(vec2(1, 1))))).mul(w11));
  return mix(texture(texNode, uv), stoch, _distFade);
}

/**
 * Stochastic drop-in for arrayTexNode.sample(uv).depth(layerIndex).
 * For DataArrayTexture (paint-layer splat system). Use for albedo layers.
 * When STOCHASTIC_ENABLED is false, returns a plain .sample().depth() node.
 *
 * @param {import("three/tsl").Node}   arrayTexNode  texture(dataArrayTex) node
 * @param {import("three/tsl").Node}   uv            vec2, world-space tiled UV
 * @param {import("three/tsl").Node}   layerIndex    int node (e.g. int(i))
 * @returns {import("three/tsl").Node}               vec4
 */
export function stochasticSampleArray(arrayTexNode, uv, layerIndex) {
  if (!STOCHASTIC_ENABLED) return arrayTexNode.sample(uv).depth(layerIndex);

  const i = floor(uv);
  const f = fract(uv);
  const { w00, w1, w11, i1 } = _triWeights(f);

  // World-anchored constant offsets; the camera-relative fade only crossfades
  // the resulting colour toward a plain tap (see _distFade comment).
  const stoch = arrayTexNode.sample(uv.add(hash22(i))).depth(layerIndex).mul(w00)
    .add(arrayTexNode.sample(uv.add(hash22(i.add(i1)))).depth(layerIndex).mul(w1))
    .add(arrayTexNode.sample(uv.add(hash22(i.add(vec2(1, 1))))).depth(layerIndex).mul(w11));
  return mix(arrayTexNode.sample(uv).depth(layerIndex), stoch, _distFade);
}
