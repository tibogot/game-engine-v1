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
 *  2. Distance fade
 *     Hash offsets are multiplied by a [1→0] fade factor that reaches 0
 *     beyond FADE_END world units from the camera. At fade=0 all three
 *     samples collapse to the same plain UV — graceful fallback with no
 *     extra texture tap, and no stochastic cell-edge artifacts at distance.
 *
 *  3. Albedo-only (callers)
 *     ORM (roughness / AO / normals) is sampled with plain texture() by
 *     the callers — tiling in those channels is barely perceptible.
 *     Net cost: 3 albedo samples vs 1 before = 2 extra taps per painted layer,
 *     ORM unchanged.
 *
 *  Toggle: a floating button is injected so you can compare perf / visuals.
 *  It saves to localStorage and reloads — the disabled path builds plain
 *  texture() nodes so there is truly zero stochastic overhead in the shader.
 */
import {
  vec2, float,
  floor, fract, max, min, step, smoothstep,
  texture, cameraPosition, positionWorld, length,
} from "three/tsl";
import { hash22 } from "./tsl-utils.js";

// ── preference (read once at module load, drives node-graph construction) ──────
const _LS_KEY = "terrain_stochastic";
export const STOCHASTIC_ENABLED = localStorage.getItem(_LS_KEY) !== "false";

// ── floating toggle button ─────────────────────────────────────────────────────
function _injectToggleButton() {
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
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(btn));
  }
}
_injectToggleButton();

// ── distance fade node (created once, shared across all stochastic calls) ─────
// Evaluates per-fragment at runtime; TSL deduplicates the shared node reference.
//
// The fade is CAMERA-relative, so wherever it transitions, the ground texture
// visibly slides/morphs as the camera moves. The original 50→80 m band put that
// morph right where the player looks (glaring once anisotropic filtering made
// mid-distance detail sharp). Pushed far out and stretched: at 300+ m ground
// texels are small and mip-blurred, and a 900 m-wide ramp changes offsets so
// slowly per frame that the transition is imperceptible. Tap count is
// unchanged — the fade only collapses the 3 sample UVs, not the sampling.
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

  // Multiply hash offsets by _distFade: at far distance all three UVs converge
  // to the plain UV, collapsing cost to effectively a single tap.
  return texture(texNode, uv.add(hash22(i).mul(_distFade))).mul(w00)
    .add(texture(texNode, uv.add(hash22(i.add(i1)).mul(_distFade))).mul(w1))
    .add(texture(texNode, uv.add(hash22(i.add(vec2(1, 1))).mul(_distFade))).mul(w11));
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

  return arrayTexNode.sample(uv.add(hash22(i).mul(_distFade))).depth(layerIndex).mul(w00)
    .add(arrayTexNode.sample(uv.add(hash22(i.add(i1)).mul(_distFade))).depth(layerIndex).mul(w1))
    .add(arrayTexNode.sample(uv.add(hash22(i.add(vec2(1, 1))).mul(_distFade))).depth(layerIndex).mul(w11));
}
