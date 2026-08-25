import * as THREE from "three";
import {
  diffuseColor,
  directionToColor,
  emissive,
  mrt,
  normalView,
  output,
  renderOutput,
  texture,
  uniform,
  vec4,
} from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { fxaa } from "three/addons/tsl/display/FXAANode.js";
import { sharpen } from "three/addons/tsl/display/SharpenNode.js";
import { chromaticAberration } from "three/addons/tsl/display/ChromaticAberrationNode.js";
import { dof } from "three/addons/tsl/display/DepthOfFieldNode.js";
import {
  N8AONode,
  createN8AOScenePass,
  applyQualityMode,
  resolveDisplayMode,
} from "n8ao-webgpu";
import { createPolishUniforms, polish } from "./polishNode.js";

/**
 * Blend mode for the `emissive` MRT attachment: "blend this target exactly the
 * way the material blends its colour".
 *
 * r184 blends ONLY the `output` attachment by default (`MRTNode.blendModes`);
 * every other attachment falls back to `NoBlending`, i.e. the fragment REPLACES
 * whatever was there. That is right for an opaque surface and catastrophic for
 * a transparent one: a drift-smoke puff (`transparent`, `depthWrite:false`,
 * `depthTest:false`) contributes almost nothing to the beauty buffer, but it
 * still stamps its emissive — zero, since smoke does not glow — flat over the
 * emissive buffer. Selective bloom reads that buffer alone, so every glowing
 * thing behind the smoke silently stops blooming, however faint the smoke is.
 *
 * With `MaterialBlending` the attachment inherits the material's own blend
 * state, which for an opaque material is still "no blending" (three only emits
 * a blend state for `transparent` or non-normal blending materials), so opaque
 * geometry keeps overwriting the glow behind it exactly as before. A
 * transparent surface now composites instead: smoke OCCLUDES the glow in
 * proportion to its own opacity, and additive things (sparks) accumulate.
 *
 * The blend state is read from the render context's MRT node — the scene MRT
 * set here — and NOT from a material's own `mrtNode`, so setting it once here
 * covers every material in the scene, including the `applyBloomMRT` ones.
 * (`MRTNode.merge()` would drop it anyway: it writes the merged modes to a
 * `blendings` property that nothing reads.)
 */
const _emissiveBlend = /*@__PURE__*/ new THREE.BlendMode(THREE.MaterialBlending);

/**
 * v2 Post FX pipeline (WebGPU/TSL).
 *
 * Built on `THREE.RenderPipeline` (the r183 successor to the old
 * `THREE.PostProcessing` class — same API, just renamed).
 *
 * Design goals:
 *  - Zero cost when disabled. While `enabled === false`, the caller renders
 *    via `renderer.render(scene, camera)` as usual; this object does nothing.
 *  - Lazy first build. The `RenderPipeline`, scene pass, and bloom node are
 *    constructed the first time post-FX is enabled, so users who never turn
 *    it on pay no init cost.
 *  - Composable per-effect enable. Individual effects (bloom, FXAA, SSAO)
 *    are toggled at runtime by swapping `renderPipeline.outputNode` and
 *    setting `needsUpdate = true` (one shader rebuild, then stable).
 *
 * Effects shipped:
 *  - SSAO (n8ao-webgpu — TSL port of N8AO; clean at any zoom, half-res
 *    + denoise + temporal accumulation built in).
 *  - Bloom (additive, in linear HDR). Two modes: threshold (default —
 *    blooms the whole scene color above a luminance threshold, sky
 *    included) and selective (`setBloomSelective(true)` — adds an
 *    `emissive` MRT target and blooms ONLY that buffer, so lanterns/LEDs
 *    glow while the bright sky stays clean; same trick as the objects lab).
 *  - FXAA (cheap edge anti-aliasing, replaces MSAA which the renderer cannot
 *    apply once we render through a `RenderPipeline`).
 *
 * Color pipeline:
 *  Scene MRT (output / diffuseColor / normal) → optional N8AO (composites
 *  AO onto beauty in linear) → bloom (additive in linear) → renderOutput
 *  (tone map + sRGB encoding) → FXAA (sRGB; required by the FXAA node).
 *
 * Why bloom always reads from raw `scenePassColor` (not the SSAO output):
 *  - Emissive sources in dark crevices should still bloom even when AO
 *    darkens them.
 *  - Bloom keeps a stable input node, so toggling SSAO doesn't rebuild it.
 *  - Three's node framework dedupes `updateBefore` per frame, so referring
 *    to both `scenePassColor` and `n8aoNode.getTextureNode()` does not cause
 *    a double scene render.
 *
 * Cloud V3 integration:
 *  When volumetric clouds V3 and post-FX are both active, `renderWithClouds()`
 *  splits the frame into (1) cloud prepass, (2) solids-only linear beauty
 *  (layer 0, no cloud raymarch), (3) cloud composite onto that RT, (4)
 *  display chain to canvas. The standalone cloud path (`tryRenderFrame`) is
 *  unchanged when post-FX is off.
 */

export class PostFxPipeline {
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.enabled = false;

    /** Lazily created on first enable. */
    this._renderPipeline = null;
    /** Split pipelines for Cloud V3 integration (linear beauty + display). */
    this._linearPipeline = null;
    this._displayPipeline = null;
    this._linearRT = null;
    this._linearTextureNode = null;
    this._scenePass = null;
    this._scenePassColor = null;

    /** Bloom (lazy). */
    this._bloomPass = null;
    // Second bloom for the cloud path — reads the linear RT AFTER clouds are
    // composited, so bloom covers scene + clouds together (the solids-only
    // `_bloomPass` can't reach the clouds; they land after it).
    this._cloudBloomPass = null;
    this._bloomEnabled = true;
    /**
     * Selective bloom: adds an `emissive` MRT target to the scene pass and
     * blooms only that buffer, so emissive objects glow but the bright sky
     * cannot. Off by default — the v2 editor keeps threshold bloom until it
     * opts in.
     */
    this._bloomSelective = false;
    /** Optional `(sceneColorNode) => sceneColorNode` before bloom (RTS fog of war). */
    this._sceneColorModifier = null;
    this._bloomParams = {
      strength: 0.3,
      threshold: 0.9,
      radius: 0.4,
      smoothWidth: 1.0,
    };

    /** FXAA enable flag — node is built lazily inside `_refreshOutputNode`. */
    this._fxaaEnabled = true;

    /**
     * SSAO (n8ao-webgpu). Lazy: the `N8AONode` is built on first enable
     * (one-time shader compile cost). After that, toggling on/off just
     * swaps the output node — no rebuild.
     */
    this._ssaoNode = null;
    this._ssaoEnabled = false;
    /** Cached non-color SSAO params; pushed to `n8ao.configuration` lazily. */
    this._ssaoParams = {
      quality: "Medium",
      aoRadius: 5,
      distanceFalloff: 1,
      intensity: 3,
      color: "#000000",
      halfRes: false,
      depthAwareUpsampling: true,
      screenSpaceRadius: false,
      displayMode: "Combined",
      transparencyAware: false,
    };
    /** Reused `THREE.Color` so we don't allocate per-update. */
    this._ssaoColor = new THREE.Color(0, 0, 0);

    /**
     * Color & Polish (Tier 1 polish bundle: grading + vignette + grain).
     * Single fullscreen pass, runs LAST in the chain so the grain isn't
     * smoothed by FXAA and the vignette tints the final pixel.
     *
     * Uniforms are built lazily on first enable so this object pays nothing
     * if the user never turns it on.
     */
    this._polishEnabled = false;
    this._polishUniforms = null;
    this._polishParams = {
      brightness: 0,
      contrast: 1,
      saturation: 1,
      temperature: 0,
      tint: 0,
      vignetteStrength: 0,
      vignetteFalloff: 0.5,
      vignetteRoundness: 1,
      vignetteColor: "#000000",
      grainStrength: 0,
      grainSize: 1,
    };
    /** Reused `THREE.Color` for vignette uniform. */
    this._vignetteColor = new THREE.Color(0, 0, 0);

    /**
     * Sharpen (RCAS — FidelityFX). Has its own RT (auto-baked input). Sits
     * AFTER FXAA so AA softening doesn't undo the sharpening.
     */
    this._sharpenEnabled = false;
    this._sharpenNode = null;
    /** Second sharpen node for the Cloud V3 display pipeline (separate graph). */
    this._sharpenNodeDisplay = null;
    this._sharpenParams = {
      sharpness: 0.5,
      denoise: false,
    };

    /**
     * Chromatic Aberration. TempNode that auto-bakes its input, so chained
     * after Sharpen and before Polish (so grain/vignette stay on top).
     */
    this._chromaticAberrationEnabled = false;
    this._chromaticAberrationNode = null;
    this._chromaticAberrationParams = {
      strength: 1.0,
      scale: 1.1,
    };
    /**
     * The CA addon's docstring says `center=null` defaults to screen center,
     * but the implementation blindly calls `nodeObject(center)` which yields
     * a null node and crashes the builder ("Cannot read properties of null
     * (reading 'build')"). Pass an explicit Vector2 every time. Reused so
     * rebuilds don't allocate.
     */
    this._caCenter = new THREE.Vector2(0.5, 0.5);

    /**
     * Depth of Field (Bokeh — three.js TSL `DepthOfFieldNode`). Heavy: owns
     * 6 internal RTs and runs CoC + 64-tap + 16-tap blurs in half-res. Sits
     * AFTER bloom in linear HDR so OOF bright objects produce real bokeh
     * (the bloom on top of them gets blurred along with them, like a real
     * lens). Built lazily on first enable.
     *
     * Uniforms are persistent so slider drags don't recompile. The DoF node
     * itself IS rebuilt whenever the upstream linear chain changes (bloom or
     * SSAO toggle), because three's DoF stores its input texture node at
     * construction time. Every rebuild disposes the prior 6-RT chain.
     */
    this._dofEnabled = false;
    this._dofNode = null;
    this._dofUniforms = null;
    this._dofParams = {
      /** World-space distance from camera to focal plane. */
      focusDistance: 50,
      /** World-space range over which objects fully blur. */
      focalLength: 30,
      /** Artistic blur size scalar. 0 = no blur, ~5 = subtle, ~15 = strong. */
      bokehScale: 5,
    };
  }

  /**
   * Returns true when this frame's render should go through the post
   * pipeline. Master switch must be on AND at least one effect must be
   * enabled — when everything is off we fall back to a direct render to
   * avoid paying for an empty pipeline pass.
   */
  isActive() {
    if (!this.enabled || this._renderPipeline === null) return false;
    return this._anyEffectEnabled();
  }

  _anyEffectEnabled() {
    return (
      this._bloomEnabled ||
      this._fxaaEnabled ||
      this._ssaoEnabled ||
      this._polishEnabled ||
      this._sharpenEnabled ||
      this._chromaticAberrationEnabled ||
      this._dofEnabled
    );
  }

  setEnabled(enabled) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) this._ensureBuilt();
    // When toggled off we keep the pipeline allocated for cheap re-enable;
    // the caller falls back to `renderer.render(scene, camera)` for free.
  }

  setBloomEnabled(enabled) {
    if (this._bloomEnabled === enabled) return;
    this._bloomEnabled = enabled;
    if (this._renderPipeline) this._refreshOutputNode();
  }

  /**
   * Switch between threshold bloom (whole frame, sky included) and selective
   * bloom (emissive MRT buffer only — sky can never bloom). Costs one extra
   * thin RT write in the scene pass; the bloom chain itself gets cheaper
   * because its input is mostly black. The threshold param still applies,
   * but on the emissive buffer alone.
   *
   * Cloud-path note: in selective mode the solids' bloom is baked into the
   * linear RT BEFORE the cloud composite, so clouds occlude glow correctly
   * and never bloom themselves (threshold mode blooms scene+clouds together).
   */
  setBloomSelective(enabled) {
    if (this._bloomSelective === enabled) return;
    this._bloomSelective = enabled;
    if (!this._renderPipeline) return;
    this._applySceneMRT();
    this._rebuildBloomPasses();
    this._refreshOutputNode();
  }

  setSceneColorModifier(fn) {
    this._sceneColorModifier = typeof fn === "function" ? fn : null;
    if (this._renderPipeline) this._refreshOutputNode();
  }

  setFxaaEnabled(enabled) {
    if (this._fxaaEnabled === enabled) return;
    this._fxaaEnabled = enabled;
    if (this._renderPipeline) this._refreshOutputNode();
  }

  setSsaoEnabled(enabled) {
    if (this._ssaoEnabled === enabled) return;
    this._ssaoEnabled = enabled;
    if (enabled && this._renderPipeline) this._ensureSsaoBuilt();
    if (this._renderPipeline) this._refreshOutputNode();
  }

  setBloomParams({ strength, threshold, radius, smoothWidth } = {}) {
    if (strength != null) this._bloomParams.strength = strength;
    if (threshold != null) this._bloomParams.threshold = threshold;
    if (radius != null) this._bloomParams.radius = radius;
    if (smoothWidth != null) this._bloomParams.smoothWidth = smoothWidth;
    if (this._bloomPass) this._applyBloomUniforms();
  }

  /**
   * Update SSAO parameters. Cheap params (radius, intensity, distance
   * falloff, color, screenSpaceRadius, displayMode) are uniform updates.
   * Expensive ones (quality, halfRes, depthAwareUpsampling, transparencyAware)
   * trigger an internal shader rebuild inside the n8ao node — fine to do
   * occasionally but avoid every frame.
   */
  setSsaoParams(partial = {}) {
    Object.assign(this._ssaoParams, partial);
    if (this._ssaoNode) this._applySsaoConfig();
  }

  setPolishEnabled(enabled) {
    if (this._polishEnabled === enabled) return;
    this._polishEnabled = enabled;
    if (enabled && this._polishUniforms === null) {
      this._polishUniforms = createPolishUniforms();
      this._applyPolishUniforms();
    }
    if (this._renderPipeline) this._refreshOutputNode();
  }

  /**
   * Update polish parameters — purely uniform updates, no shader rebuild.
   * Safe to call every frame from a slider drag.
   */
  setPolishParams(partial = {}) {
    Object.assign(this._polishParams, partial);
    if (this._polishUniforms) this._applyPolishUniforms();
  }

  setSharpenEnabled(enabled) {
    if (this._sharpenEnabled === enabled) return;
    this._sharpenEnabled = enabled;
    if (this._renderPipeline) this._refreshOutputNode();
  }

  /**
   * Sharpen params. `sharpness` 0 = max sharpen, 2 = none. We expose 0..1
   * to the user and remap inside `_refreshOutputNode` (1 - userValue).
   */
  setSharpenParams(partial = {}) {
    Object.assign(this._sharpenParams, partial);
    if (this._sharpenEnabled && this._renderPipeline) {
      // Sharpen is structural (it owns an RT). Param changes only need an
      // outputNode rebuild because we pass values as JS numbers, not uniforms.
      this._refreshOutputNode();
    }
  }

  setChromaticAberrationEnabled(enabled) {
    if (this._chromaticAberrationEnabled === enabled) return;
    this._chromaticAberrationEnabled = enabled;
    if (this._renderPipeline) this._refreshOutputNode();
  }

  setChromaticAberrationParams(partial = {}) {
    Object.assign(this._chromaticAberrationParams, partial);
    if (this._chromaticAberrationEnabled && this._renderPipeline) {
      this._refreshOutputNode();
    }
  }

  setDofEnabled(enabled) {
    if (this._dofEnabled === enabled) return;
    this._dofEnabled = enabled;
    if (enabled && this._dofUniforms === null) {
      // Lazy uniform creation — never allocate until first enable.
      this._dofUniforms = {
        focusDistance: uniform(this._dofParams.focusDistance),
        focalLength: uniform(this._dofParams.focalLength),
        bokehScale: uniform(this._dofParams.bokehScale),
      };
    }
    if (this._renderPipeline) this._refreshOutputNode();
  }

  /**
   * DoF params — pure uniform updates, no node rebuild. Safe to call
   * every frame from a slider drag.
   */
  setDofParams(partial = {}) {
    Object.assign(this._dofParams, partial);
    this._applyDofUniforms();
  }

  /**
   * The scene pass's depth texture, or null before the pipeline is built.
   *
   * ADDITIVE ACCESSOR, no behaviour change. A cloud system compositing through
   * `renderWithClouds()` needs scene depth to occlude clouds behind geometry. Without this
   * it has to render the whole scene a second time just to produce a depth buffer — which
   * is exactly what the older cloud path does in its `prepareFrame()`. Handing out the
   * depth the scene pass already wrote lets a cloud system march AFTER the solids pass and
   * skip that duplicate render entirely.
   */
  getSceneDepthTexture() {
    return this._scenePass?.renderTarget?.depthTexture ?? null;
  }

  /** Resize the linear HDR RT used by `renderWithClouds()`. */
  setSize(/* w, h */) {
    this._resizeLinearRT();
  }

  /** Render the post-processed frame. Caller must check `isActive()` first. */
  render() {
    if (!this._renderPipeline) return;
    this._renderPipeline.render();
  }

  /**
   * Cloud V3 + post-FX: prepass → solids linear chain → cloud composite →
   * display chain. Caller must check `isActive()` first.
   *
   * @param {{ prepareFrame: Function, compositeOntoLinearHDR: Function }} cloudSystem
   * @param {THREE.Vector3} anchorXZ
   * @param {number} dtSec
   */
  renderWithClouds(cloudSystem, anchorXZ, dtSec) {
    if (!this._renderPipeline || !cloudSystem) return;
    this._ensureBuilt();

    if (!cloudSystem.prepareFrame(anchorXZ, dtSec)) {
      this.render();
      return;
    }

    const { renderer, camera } = this;
    const prevLayerMask = camera.layers.mask;
    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    try {
      // Solids-only scene pass — exclude cloud layer 13 (raymarch happens once).
      camera.layers.set(0);

      this._resizeLinearRT();
      renderer.setRenderTarget(this._linearRT);
      renderer.clear();
      this._linearPipeline.render();

      cloudSystem.compositeOntoLinearHDR(renderer, this._linearRT);

      renderer.setRenderTarget(null);
      this._displayPipeline.render();
    } finally {
      camera.layers.mask = prevLayerMask;
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    }
  }

  dispose() {
    if (this._ssaoNode?.dispose) this._ssaoNode.dispose();
    if (this._bloomPass?.dispose) this._bloomPass.dispose();
    if (this._cloudBloomPass?.dispose) this._cloudBloomPass.dispose();
    if (this._sharpenNode?.dispose) this._sharpenNode.dispose();
    if (this._sharpenNodeDisplay?.dispose) this._sharpenNodeDisplay.dispose();
    if (this._dofNode?.dispose) this._dofNode.dispose();
    this._linearRT?.dispose();
    this._renderPipeline = null;
    this._linearPipeline = null;
    this._displayPipeline = null;
    this._linearRT = null;
    this._linearTextureNode = null;
    this._scenePass = null;
    this._scenePassColor = null;
    this._bloomPass = null;
    this._cloudBloomPass = null;
    this._ssaoNode = null;
    this._sharpenNode = null;
    this._sharpenNodeDisplay = null;
    this._chromaticAberrationNode = null;
    this._dofNode = null;
    this._dofUniforms = null;
    this._polishUniforms = null;
  }

  _ensureBuilt() {
    if (this._renderPipeline) return;

    const { renderer, scene, camera } = this;

    this._renderPipeline = new THREE.RenderPipeline(renderer);
    // We apply tone mapping + sRGB conversion manually via `renderOutput()`
    // so FXAA (which requires sRGB input) can sit at the very end of the
    // chain. Disabling the auto color transform avoids double-encoding.
    this._renderPipeline.outputColorTransform = false;

    // Always use the n8ao-style MRT scene pass once post-FX is on. The
    // additional fill rate for diffuse + normal RTs is small (~0.3 ms at
    // 1080p) and lets us drop in SSAO later with no graph rebuild.
    this._scenePass = createN8AOScenePass(scene, camera);
    this._scenePassColor = this._scenePass.getTextureNode("output");
    if (this._bloomSelective) this._applySceneMRT();

    if (this._ssaoEnabled) this._ensureSsaoBuilt();

    this._linearRT = new THREE.RenderTarget(1, 1, {
      depthBuffer: false,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this._linearTextureNode = texture(this._linearRT.texture);

    this._rebuildBloomPasses();

    this._linearPipeline = new THREE.RenderPipeline(renderer);
    this._linearPipeline.outputColorTransform = false;

    this._displayPipeline = new THREE.RenderPipeline(renderer);
    this._displayPipeline.outputColorTransform = false;

    this._resizeLinearRT();
    this._refreshOutputNode();
  }

  _resizeLinearRT() {
    if (!this._linearRT || !this.renderer) return;
    const size = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(size);
    this._linearRT.setSize(size.x, size.y);
  }

  _ensureSsaoBuilt() {
    if (this._ssaoNode) return;
    if (!this._scenePass) return;

    const { scene, camera } = this;
    const sp = this._scenePass;

    this._ssaoNode = new N8AONode({
      beautyNode: sp.getTextureNode("output"),
      beautyTexture: sp.getTexture("output"),
      depthNode: sp.getTextureNode("depth"),
      depthTexture: sp.getTexture("depth"),
      normalNode: sp.getTextureNode("normal"),
      normalTexture: sp.getTexture("normal"),
      scenePassNode: sp,
      scene,
      camera,
    });

    // n8ao defaults to walking the entire scene every frame to auto-detect
    // transparent materials. We manage `transparencyAware` ourselves, so
    // suppress that traversal directly. (The Proxy setter would only flip
    // this internal flag if the public value actually CHANGED, and our
    // default already matches n8ao's, so we set it manually.)
    this._ssaoNode.autoDetectTransparency = false;

    // n8ao defaults to `gammaCorrection: true`, which sRGB-encodes its
    // composite output. Our pipeline runs the result through `renderOutput()`
    // (tonemap + sRGB) afterwards, so leaving it on causes double-encoding —
    // ACES then squashes the already-encoded values into a flat grey range
    // and the intensity slider's effect becomes invisible. Pin it off here.
    this._ssaoNode.configuration.gammaCorrection = false;

    this._applySsaoConfig();
  }

  /**
   * (Re)apply the scene pass MRT layout. Mirrors n8ao's own layout
   * (output/diffuse/normal, byte-typed where possible) and appends the
   * `emissive` target in selective-bloom mode. Emissive stays HalfFloat —
   * lantern/LED intensities live well above 1 in linear HDR.
   */
  _applySceneMRT() {
    const targets = {
      output,
      diffuseColor,
      normal: directionToColor(normalView),
    };
    // The emissive member carries the fragment's OWN coverage in .a, and the
    // attachment is told to blend like the material does. Both halves are
    // needed, and only together — see `_emissiveBlend` at the top of the file.
    if (this._bloomSelective) targets.emissive = vec4(emissive, output.a);
    const sceneMRT = mrt(targets);
    if (this._bloomSelective) sceneMRT.setBlendMode("emissive", _emissiveBlend);
    this._scenePass.setMRT(sceneMRT);
    this._scenePass.getTexture("diffuseColor").type = THREE.UnsignedByteType;
    this._scenePass.getTexture("normal").type = THREE.UnsignedByteType;
  }

  /**
   * (Re)create the bloom passes for the current mode. Threshold mode blooms
   * the scene color (and, on the cloud path, the post-composite linear RT so
   * clouds bloom too). Selective mode blooms only the emissive MRT buffer;
   * the cloud path then needs NO second bloom pass because the solids' glow
   * is baked into the linear RT before the clouds composite on top.
   */
  _rebuildBloomPasses() {
    if (this._bloomPass?.dispose) this._bloomPass.dispose();
    if (this._cloudBloomPass?.dispose) this._cloudBloomPass.dispose();
    const bp = this._bloomParams;
    const solidsInput = this._bloomSelective
      ? this._scenePass.getTextureNode("emissive")
      : this._scenePassColor;
    this._bloomPass = bloom(solidsInput, bp.strength, bp.radius, bp.threshold);
    this._cloudBloomPass = this._bloomSelective
      ? null
      : bloom(this._linearTextureNode, bp.strength, bp.radius, bp.threshold);
    this._applyBloomUniforms();
  }

  _applyBloomUniforms() {
    const bp = this._bloomParams;
    for (const p of [this._bloomPass, this._cloudBloomPass]) {
      if (!p) continue;
      p.strength.value = bp.strength;
      p.threshold.value = bp.threshold;
      p.radius.value = bp.radius;
      if (p.smoothWidth) p.smoothWidth.value = bp.smoothWidth;
    }
  }

  _applyDofUniforms() {
    const u = this._dofUniforms;
    if (!u) return;
    u.focusDistance.value = this._dofParams.focusDistance;
    u.focalLength.value = this._dofParams.focalLength;
    u.bokehScale.value = this._dofParams.bokehScale;
  }

  _applyPolishUniforms() {
    const u = this._polishUniforms;
    if (!u) return;
    const p = this._polishParams;
    u.brightness.value = p.brightness;
    u.contrast.value = p.contrast;
    u.saturation.value = p.saturation;
    u.temperature.value = p.temperature;
    u.tint.value = p.tint;
    u.vignetteStrength.value = p.vignetteStrength;
    u.vignetteFalloff.value = p.vignetteFalloff;
    u.vignetteRoundness.value = p.vignetteRoundness;
    u.grainStrength.value = p.grainStrength;
    u.grainSize.value = p.grainSize;
    // Vignette uniform is a Vector3 (sRGB stays linear-interpreted in display
    // space, no convertSRGBToLinear here — we already operate on tonemapped
    // sRGB pixels and want the picked color to appear as-is).
    this._vignetteColor.set(p.vignetteColor);
    u.vignetteColor.value.set(
      this._vignetteColor.r,
      this._vignetteColor.g,
      this._vignetteColor.b,
    );
  }

  _applySsaoConfig() {
    const n = this._ssaoNode;
    if (!n) return;
    const c = n.configuration;
    const p = this._ssaoParams;

    // Pin transparencyAware first so the n8ao node's internal
    // `autoDetectTransparency` flag flips to false — otherwise it would
    // walk the entire scene every frame looking for transparent materials.
    if (c.transparencyAware !== p.transparencyAware) {
      c.transparencyAware = p.transparencyAware;
    }

    // Quality preset rebuilds samplers; only re-apply when changed.
    // `applyQualityMode` mutates the configuration in place, which trips
    // the n8ao Proxy setters and rebuilds the AO + denoise passes once.
    applyQualityMode(c, p.quality);

    // Cheap uniform updates.
    c.aoRadius = p.aoRadius;
    c.distanceFalloff = p.distanceFalloff;
    c.intensity = p.intensity;
    c.screenSpaceRadius = p.screenSpaceRadius;
    c.renderMode = resolveDisplayMode(p.displayMode);

    // Slightly more expensive (RT resize / shader rebuild on change), but
    // still fine to set every time the user touches a slider.
    if (c.halfRes !== p.halfRes) c.halfRes = p.halfRes;
    if (c.depthAwareUpsampling !== p.depthAwareUpsampling) {
      c.depthAwareUpsampling = p.depthAwareUpsampling;
    }

    // Color via reused THREE.Color so we don't allocate per change.
    this._ssaoColor.set(p.color);
    if (!c.color.equals(this._ssaoColor)) {
      // Assign a fresh Color so the Proxy setter sees a different reference
      // and the equality check inside it triggers a uniform update.
      c.color = this._ssaoColor.clone();
    }
  }

  // Solids (+ SSAO) with DOF applied, but NOT bloom. DOF goes before bloom now
  // (a lens effect after focus — arguably more correct), and keeping it as one
  // node lets both the no-cloud path (adds solids bloom) and the cloud path
  // (adds bloom after clouds) share it. Bloom is added by `_refreshOutputNode`.
  _buildDofBaseNode() {
    let sceneInput =
      this._ssaoEnabled && this._ssaoNode
        ? this._ssaoNode.getTextureNode()
        : this._scenePassColor;

    if (this._sceneColorModifier) {
      sceneInput = this._sceneColorModifier(sceneInput);
    }

    if (this._dofEnabled && this._dofUniforms) {
      const viewZ = this._scenePass.getViewZNode();
      this._dofNode = dof(
        sceneInput,
        viewZ,
        this._dofUniforms.focusDistance,
        this._dofUniforms.focalLength,
        this._dofUniforms.bokehScale,
      );
      return this._dofNode;
    }

    return sceneInput;
  }

  _buildDisplayChain(inputNode) {
    let node = renderOutput(inputNode);
    let sharpenNode = null;

    if (this._fxaaEnabled) node = fxaa(node);

    if (this._sharpenEnabled) {
      const userSharpness = this._sharpenParams.sharpness;
      const remapped = 1.0 - Math.max(0, Math.min(1, userSharpness));
      sharpenNode = sharpen(node, remapped, this._sharpenParams.denoise);
      node = sharpenNode;
    }

    if (this._chromaticAberrationEnabled) {
      this._chromaticAberrationNode = chromaticAberration(
        node,
        this._chromaticAberrationParams.strength,
        this._caCenter,
        this._chromaticAberrationParams.scale,
      );
      node = this._chromaticAberrationNode;
    }

    if (this._polishEnabled && this._polishUniforms) {
      node = polish(node, this._polishUniforms);
    }

    return { node, sharpenNode };
  }

  _refreshOutputNode() {
    if (!this._renderPipeline) return;

    if (this._dofNode?.dispose) this._dofNode.dispose();
    this._dofNode = null;
    if (this._sharpenNode?.dispose) this._sharpenNode.dispose();
    if (this._sharpenNodeDisplay?.dispose) this._sharpenNodeDisplay.dispose();
    this._sharpenNode = null;
    this._sharpenNodeDisplay = null;
    this._chromaticAberrationNode = null;

    const dofBase = this._buildDofBaseNode();

    // No-cloud path (`render()`): solids + bloom(solids), full display chain.
    const noCloudBeauty =
      this._bloomEnabled && this._bloomPass
        ? dofBase.add(this._bloomPass)
        : dofBase;
    const mainDisplay = this._buildDisplayChain(noCloudBeauty);
    this._sharpenNode = mainDisplay.sharpenNode;
    this._renderPipeline.outputNode = mainDisplay.node;
    this._renderPipeline.needsUpdate = true;

    // Cloud path (`renderWithClouds()`). Threshold mode: the linear pass
    // renders solids WITHOUT bloom → linear RT; clouds composite onto it;
    // the display pass blooms the COMBINED buffer via `_cloudBloomPass`.
    // Selective mode: the emissive bloom is baked into the linear RT HERE
    // (same pipeline as the scene pass — no double render), clouds composite
    // on top (occluding glow correctly), and the display pass adds no bloom.
    if (this._linearPipeline) {
      this._linearPipeline.outputNode =
        this._bloomSelective && this._bloomEnabled && this._bloomPass
          ? dofBase.add(this._bloomPass)
          : dofBase;
      this._linearPipeline.needsUpdate = true;
    }
    if (this._displayPipeline && this._linearTextureNode) {
      const cloudInput =
        this._bloomEnabled && this._cloudBloomPass
          ? this._linearTextureNode.add(this._cloudBloomPass)
          : this._linearTextureNode;
      const cloudDisplay = this._buildDisplayChain(cloudInput);
      this._sharpenNodeDisplay = cloudDisplay.sharpenNode;
      this._displayPipeline.outputNode = cloudDisplay.node;
      this._displayPipeline.needsUpdate = true;
    }
  }
}
