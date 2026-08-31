// ============================================================================
// RAIN LAB — judge the full-screen droplet effect over a REAL game frame.
//
// The lab exists because the effect is a screen-space overlay: what it looks
// like depends entirely on what is behind it. Droplets are lenses, and a lens
// is only as interesting as the image it is bending — judged over a flat test
// pattern it tells you nothing, and worse, a flat backdrop FLATTERS a broken
// implementation, because a lens with no optical power and a lens with plenty
// both return the same grey.
//
// So the default backdrop is `assets/rain-lab-frame.jpg`: an actual frame from
// road.html, captured on a wet track under the neon gantry. Bright hard-edged
// sources on dark wet asphalt is the case that makes or breaks this, and it is
// the case the game actually has. Drop your own screenshot on the page to try
// another one; the test card is still there, one button away, but it is a
// fallback and not the test.
//
// Nothing here is the effect itself; that lives in modularRoadRainLens.js so
// the same node graph can go straight into the game's post pipeline via
// `setSceneColorModifier`. The lab only supplies a backdrop and some sliders.
// ============================================================================
import * as THREE from "three/webgpu";
import {
  Fn, texture, uniform, uv, vec2, vec3, float, mix, fract,
  smoothstep, length, saturate, oneMinus, time, pow,
} from "three/tsl";
import {
  createRainLensUniforms, rainLensColor, RAIN_LENS_NUMBERS,
} from "./modularRoadRainLens.js";

/** The captured game frame this lab judges against by default. */
const DEFAULT_FRAME = "./assets/rain-lab-frame.jpg";

/**
 * Taps in the blur kernel that softens what a drop gathers.
 *
 * Four, on a rotated square. Not many, and it does not need to be: what it is
 * blurring is already a wide, inverted gather, so it only has to take the edge
 * off. The lab measures this honestly only over the photo backdrop; over the
 * procedural test card each tap re-evaluates the card's arithmetic, so the cost
 * you would read is the card's, not a texture fetch's.
 */
const BLUR_TAPS = 4;

/**
 * The stand-in backdrop: a wet road at night, procedurally.
 *
 * Deliberately crude — it is a FALLBACK, not an attempt at the game, and not
 * the thing to tune against. Kept because it moves, and a still photograph
 * cannot show you whether the drops crawl, alias or shimmer.
 */
function proceduralBackdrop(uvNode, uAspect) {
  return Fn(() => {
    const p = vec2(uvNode.x.mul(uAspect), uvNode.y);
    const horizon = float(0.56);

    // Sky: a dim gradient, darkest overhead.
    const sky = mix(vec3(0.04, 0.055, 0.08), vec3(0.10, 0.12, 0.17),
      saturate(uvNode.y.sub(horizon).mul(3.0)));

    // Ground: dark wet asphalt, with a perspective-ish compression toward the
    // horizon so there is some structure for the drops to distort.
    const gy = saturate(horizon.sub(uvNode.y).mul(6.0));
    const road = mix(vec3(0.02, 0.025, 0.03), vec3(0.07, 0.08, 0.10), gy);

    // Lamps: a row of bright sources that drift, plus their reflections
    // smeared down the wet ground. This is the part that matters.
    const t = time.mul(0.06);
    const lampRow = Fn(([yPos, scale, bright]) => {
      const x = fract(p.x.mul(scale).add(t)).sub(0.5);
      const d = length(vec2(x, uvNode.y.sub(yPos).mul(3.0)));
      return pow(saturate(oneMinus(d.mul(9.0))), 3.0).mul(bright);
    });
    const lamps = lampRow(horizon.add(0.03), float(2.0), float(1.0))
      .add(lampRow(horizon.add(0.075), float(3.7), float(0.5)));

    // Their reflection: same row, mirrored below the horizon and stretched —
    // the vertical smear that a wet road always gives you.
    const rx = fract(p.x.mul(2.0).add(t)).sub(0.5);
    const refl = pow(saturate(oneMinus(absf(rx).mul(22.0))), 2.0)
      .mul(saturate(horizon.sub(uvNode.y).mul(2.2)))
      .mul(saturate(oneMinus(horizon.sub(uvNode.y).mul(1.6))));

    const ground = road.add(vec3(1.0, 0.85, 0.6).mul(refl).mul(0.5));
    const base = mix(ground, sky, smoothstep(horizon.sub(0.004), horizon.add(0.004), uvNode.y));
    return base.add(vec3(1.0, 0.9, 0.7).mul(lamps));
  })();
}
/** `abs` is shadowed by the DOM in this module's scope; alias it explicitly. */
const absf = (n) => n.abs();

export async function startRainLab() {
  const canvas = document.getElementById("rain-canvas");

  // `trackTimestamp` is a BACKEND CONSTRUCTION option — setting it on the
  // renderer afterwards does nothing except make resolveTimestampsAsync warn
  // and return undefined, which is how the GPU panel ends up reporting
  // "timestamp pool unavailable" on a device that supports it perfectly well.
  // Same setup as cloudLab/skyLab; this lab's whole reason to exist is a
  // trustworthy millisecond, so it cannot be left to the default.
  if (!navigator.gpu) throw new Error("WebGPU not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("No WebGPU adapter.");
  const device = await adapter.requestDevice({ requiredFeatures: [...adapter.features] });
  const renderer = new THREE.WebGPURenderer({
    canvas, antialias: false, device,
    trackTimestamp: device.features.has("timestamp-query"),
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  await renderer.init();

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const u = createRainLensUniforms();
  const uAspect = uniform(innerWidth / Math.max(1, innerHeight));
  /** Wipes the effect away from the left so you can A/B against the raw frame. */
  const uWipe = uniform(0);

  /**
   * Which backdrop the graph samples — and a BUILD-TIME choice, not a uniform.
   *
   * It was a `mix(procedural, photo, uUsePhoto)` at first, which is wrong for
   * the only reason this lab exists: every tap then evaluates the test card's
   * arithmetic AS WELL AS the texture fetch, even in photo mode. The effect
   * takes three taps and the blur four more, so a uniform switch here inflates
   * the measured per-tap cost several-fold over what a tap costs in the game,
   * where it is one read of the scene colour. Off has to mean absent.
   */
  let photoMode = false;

  // A 1x1 placeholder until the frame arrives, so the graph is complete from
  // the first build and loading an image is a `.value` swap, not a rebuild.
  const placeholder = new THREE.DataTexture(new Uint8Array([20, 22, 28, 255]), 1, 1);
  placeholder.needsUpdate = true;
  const photoTex = texture(placeholder);

  /**
   * What the effect samples. The lab decides where pixels come from; the effect
   * does not know and must not care — that is what lets the same graph run in
   * the game against the scene colour instead.
   */
  const sampleScene = (uvIn) => {
    const clamped = uvIn.clamp(vec2(0.001, 0.001), vec2(0.999, 0.999));
    return photoMode ? photoTex.sample(clamped).rgb : proceduralBackdrop(clamped, uAspect);
  };

  /**
   * A blurred read of the backdrop: BLUR_TAPS on a rotated square of the given
   * screen-uv radius. Only built when the blur gate is on.
   *
   * The radius is a node rather than a constant because the effect drives it —
   * a drop's out-of-focus smear and the dry glass's haze want very different
   * amounts from the same kernel.
   */
  const sampleBlur = (uvIn, radiusNode) => {
    const rx = radiusNode.div(uAspect);
    let sum = null;
    for (let i = 0; i < BLUR_TAPS; i++) {
      const a = (i + 0.5) * (Math.PI * 2 / BLUR_TAPS);
      const o = vec2(rx.mul(Math.cos(a)), radiusNode.mul(Math.sin(a)));
      const s = sampleScene(uvIn.add(o));
      sum = sum ? sum.add(s) : s;
    }
    return sum.mul(1 / BLUR_TAPS);
  };

  const mat = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });

  /**
   * The film blur is a BUILD-TIME gate, not a uniform: off has to mean the taps
   * are absent from the shader, or the switch measures nothing. Toggling it
   * rebuilds the node graph, which is why this is a function.
   */
  let blurOn = true;
  /**
   * The honest zero for a perf A/B: a plain blit of the backdrop, with the
   * effect's node graph absent rather than turned down.
   *
   * `amount = 0` is NOT a baseline. It fades the effect out visually, but the
   * field maths, the lens tap and the rim tap all still run — nothing here is
   * branched on it. Measuring against `amount = 0` would report the effect as
   * nearly free, which is exactly the kind of flattering non-measurement this
   * lab is supposed to prevent.
   */
  let bypass = false;
  let trailOn = true;
  function buildColorNode() {
    mat.colorNode = Fn(() => {
      const uvn = uv();
      if (bypass) return sampleScene(uvn);
      const rained = rainLensColor(sampleScene, u, uvn, uAspect, {
        ...(blurOn ? { blur: sampleBlur } : {}),
        trail: trailOn,
      });
      // Hard wipe: left of the line is the untouched frame. A/B beats memory.
      return mix(rained, sampleScene(uvn), smoothstep(uWipe, uWipe.sub(0.002), uvn.x));
    })();
    mat.needsUpdate = true;
  }
  buildColorNode();

  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));

  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    uAspect.value = innerWidth / Math.max(1, innerHeight);
  });

  // ── THE BACKDROP ───────────────────────────────────────────────────────
  const nameEl = document.getElementById("backdrop-name");
  const useImage = (img, label) => {
    const t = new THREE.Texture(img);
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    photoTex.value = t;
    photoMode = true;
    buildColorNode();
    if (nameEl) nameEl.textContent = label;
  };
  const loadFile = (file) => {
    const img = new Image();
    img.onload = () => useImage(img, file.name);
    img.src = URL.createObjectURL(file);
  };
  // The captured game frame, loaded at boot. If it is missing the lab still
  // runs — it just falls back to the test card and says so, rather than
  // failing on an asset that is only ever a convenience.
  const boot = new Image();
  boot.onload = () => useImage(boot, "captured game frame");
  boot.onerror = () => { if (nameEl) nameEl.textContent = "test card (frame missing)"; };
  boot.src = DEFAULT_FRAME;

  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => {
    e.preventDefault();
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /^image\//.test(x.type));
    if (f) loadFile(f);
  });
  document.getElementById("backdrop-file")?.addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
  });
  document.getElementById("backdrop-reset")?.addEventListener("click", () => {
    photoMode = false;
    buildColorNode();
    if (nameEl) nameEl.textContent = "procedural test card";
  });
  document.getElementById("backdrop-frame")?.addEventListener("click", () => {
    if (photoTex.value === placeholder) return;
    photoMode = true;
    buildColorNode();
    if (nameEl) nameEl.textContent = "captured game frame";
  });

  // ── SLIDERS ────────────────────────────────────────────────────────────
  const rows = document.getElementById("rows");
  const RANGE = {
    amount: [0, 1, 0.01],
    beadDensity: [4, 24, 0.5], beadSize: [0.05, 0.5, 0.01], beadFill: [0, 1, 0.02],
    beadDrift: [0, 1, 0.01], beadWobble: [0, 1.2, 0.02],
    beadLife: [0.5, 20, 0.1], beadSplash: [0.002, 0.3, 0.002],
    beadFade: [0.02, 0.9, 0.01], beadPop: [0, 1.5, 0.02],
    runnerDensity: [2, 20, 0.5], runnerFill: [0, 1, 0.02], runnerSize: [0.05, 0.6, 0.01],
    runnerSpeed: [0, 2, 0.02], runnerTrail: [0, 0.8, 0.01],
    trailDensity: [6, 60, 1], trailFill: [0, 1, 0.02], trailSize: [0.05, 0.9, 0.01],
    invert: [0, 1, 0.01], magnify: [0, 0.5, 0.005], rim: [0, 1, 0.02],
    rimPower: [0.5, 8, 0.1], density: [0, 1, 0.02], edgeSoft: [0.02, 0.6, 0.01],
    dropBlur: [0, 0.05, 0.001], film: [0, 1, 0.02],
    lean: [-1.5, 1.5, 0.02], streak: [0, 3, 0.02],
  };
  const rowFor = {};
  for (const k of RAIN_LENS_NUMBERS) {
    const [lo, hi, st] = RANGE[k] ?? [0, 1, 0.01];
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<label>${k}</label>`
      + `<input type="range" min="${lo}" max="${hi}" step="${st}" value="${u[k].value}">`
      + `<span class="v">${(+u[k].value).toFixed(2)}</span>`;
    const [input, out] = [row.querySelector("input"), row.querySelector(".v")];
    input.addEventListener("input", () => {
      u[k].value = +input.value;
      out.textContent = (+input.value).toFixed(2);
    });
    rows.appendChild(row);
    rowFor[k] = { input, out };
  }
  const setParam = (k, v) => {
    u[k].value = v;
    const r = rowFor[k];
    if (r) { r.input.value = v; r.out.textContent = (+v).toFixed(2); }
  };

  const wipeInput = document.getElementById("wipe");
  wipeInput.addEventListener("input", () => { uWipe.value = +wipeInput.value; });

  document.getElementById("blur-toggle")?.addEventListener("change", (e) => {
    blurOn = e.target.checked;
    buildColorNode();
  });
  document.getElementById("trail-toggle")?.addEventListener("change", (e) => {
    trailOn = e.target.checked;
    buildColorNode();
  });

  document.getElementById("preset-parked").addEventListener("click", () => {
    setParam("lean", 0); setParam("streak", 0.6);
  });
  document.getElementById("preset-fast").addEventListener("click", () => {
    // Restrained on purpose. `streak` at 1.6 turns every drop into the same
    // diagonal capsule — the field stops reading as water and starts reading as
    // a hatch pattern, because the elongation is uniform while real tearing is
    // not. The lean carries the speed cue; the stretch only has to hint at it.
    setParam("lean", 0.70); setParam("streak", 0.80);
  });

  // ── COST ───────────────────────────────────────────────────────────────
  //
  // The number this lab exists to produce, and it MUST be GPU time rather than
  // wall-clock frame interval.
  //
  // The first version timed `performance.now()` between frames and reported
  // 1000 ms — on a trivial material, at quarter resolution, with the effect
  // switched off. It was measuring `requestAnimationFrame` being throttled to
  // ~1.4 Hz, which Chrome does whenever the window is not actually being
  // composited (an automated or occluded window reports `visibilityState:
  // "visible"` and `hasFocus: true` the whole time, so neither of those catches
  // it). A frame-interval timer cannot tell "the effect is slow" from "nobody
  // is drawing this window", and it will happily report the second as the first.
  //
  // The WebGPU timestamp pool measures the work actually submitted, so it is
  // right regardless of how often the page is asked to draw. Same panel the
  // game uses; see v3/render/gpuStatsPanel.js for why the naive
  // `renderer.info.render.timestamp` is not usable either.
  const { createGpuStatsPanel } = await import("../../v3/render/gpuStatsPanel.js");
  const gpuPanel = createGpuStatsPanel(renderer, {});
  const msEl = document.getElementById("ms");
  const fpsEl = document.getElementById("fps");
  let frames = 0, acc = 0, last = performance.now();

  /**
   * Measure one configuration.
   *
   * The panel keeps a rolling window of the last 30 complete frames, so a
   * config change washes out of it in half a second at 60 Hz. Waiting several
   * times that — and then CHECKING that at least a full window of frames really
   * closed — is what makes the number belong to what is on screen now.
   *
   * Two traps this deliberately avoids:
   *  • Sampling too soon after `buildColorNode`, which blends the old config's
   *    frames with the new one's. Do that with a short enough wait and two
   *    different configs come back byte-identical, which is exactly how an
   *    earlier round of measurements on this project produced three "identical"
   *    results and a wrong conclusion.
   *  • Disposing and recreating the panel between configs to force a reset —
   *    tried, and it returns frames: 0. The pool is a backend singleton; a new
   *    panel clears it out from under itself and closes nothing.
   */
  async function measure({ blur = true, trail = true, off = false, settle = 2000 } = {}) {
    blurOn = blur; trailOn = trail; bypass = off;
    buildColorNode();
    const before = gpuPanel.sample().frames;
    await new Promise((r) => setTimeout(r, settle));
    const s = gpuPanel.sample();
    const closed = s.frames - before;
    return {
      median: +s.median.toFixed(4),
      p95: +s.p95.toFixed(4),
      // Below ~30 and the window still holds frames from the previous config,
      // so the median is a blend and the comparison is worthless. Surfaced
      // rather than asserted, because the caller is the one comparing.
      closed,
      trustworthy: closed >= 30,
    };
  }

  /** Console handle — tune from devtools, and diagnose when it misbehaves. */
  window.__rainLab = {
    renderer, scene, camera, u, uAspect, uWipe, mat, gpuPanel,
    setParam, measure,
    setBlur: (on) => { blurOn = on; buildColorNode(); },
    setTrail: (on) => { trailOn = on; buildColorNode(); },
    setBypass: (on) => { bypass = on; buildColorNode(); },
  };

  document.getElementById("boot")?.remove();
  renderer.setAnimationLoop(() => {
    renderer.render(scene, camera);
    const now = performance.now();
    acc += now - last; last = now; frames++;
    if (acc >= 500) {
      const s = gpuPanel.sample();
      // GPU median once the pool has closed frames; a dash rather than a lie
      // while it is still filling.
      msEl.textContent = s.frames > 2 ? s.median.toFixed(3) : "…";
      // Wall-clock rate is still worth showing, clearly labelled as such — it
      // is what tells you the WINDOW is throttled rather than the effect.
      fpsEl.textContent = (1000 * frames / acc).toFixed(0);
      frames = 0; acc = 0;
    }
  });
}
