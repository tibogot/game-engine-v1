# three.js upgrades — workarounds, checks, what to try

We ship three **r184** (`package.json` `"three": "^0.184.0"`, one version for the whole repo).
Started 2026-10-17 from the r185 + r186 release notes.
What WebGPU offers that three does not expose (render bundles, device limits, f16, subgroups…):
[WEBGPU_BEYOND_THREE.md](WEBGPU_BEYOND_THREE.md).

## The habit

- Upgrade at a break point, about every 2-3 releases: between games or after a milestone, never
  while shipping. A shipped game's build is frozen and keeps its version.
- Each time:
  1. Read the release notes and add what matters to the "To try" and "Breaks" lists here.
  2. Upgrade.
  3. Run `npm run test:all`.
  4. Open every game and the main labs; the console must stay clean.
  5. Compare boot s, CPU ms and GPU ms with the old version (`__V3_DEBUG.gpuAB`, same scene, same camera).
  6. Retest every workaround below, delete the ones the upgrade made unnecessary, and update this file.
  7. Recopy the bundled decoders from three's examples: `node_modules/three/examples/jsm/libs/basis/*`
     → `public/basis/` (KTX2; `textureLoadTest` fails until done) and the Draco files → `public/draco/`.
- Next: a MEASURE-ONLY r186 trial for alg-rts (games/alg-rts/TODO.md, item 15), then the real
  upgrade of the whole repo after alg-rts ships, before the Apocalypse game's code starts.

## Workarounds for r184 quirks (retest each one after an upgrade)

| Quirk | Where we work around it | Maybe fixed in |
|---|---|---|
| InstancedMesh matrices upload one frame late; re-packed lists flash | `render/instanceMatrixSync.js` | r185 (InstanceNode update range sync), r186 (update range clear, previous instance data) |
| Every InstancedMesh gets its own shader build (uuid in the cache key) | `render/sharedInstanceBuilds.js`, `render/instancePipeline.js` | ? |
| A shared build refreshes only its first mesh; the rest froze | needsRefresh per render object (`sharedInstanceBuilds.js`) | r186 ("refresh types for render objects") |
| Unstable uniform names → shaders recompiled from scratch | `render/stableShaderNames.js` | r185 (function nodes cached per backend)? |
| `uniform()` defaults to the per-object group → every draw re-uploads | globals in `frameGroup`, arrays in `renderGroup` | r185 (pooled, garbage-free UBO updates); keep our grouping anyway |
| MRT blends only the `output` attachment; transparents wipe emissive/normal | opaque or alpha-test markers; `render/bloomMRT.js`, `post/postFxPipeline.js`, city signs, headlight beam | ? |
| Scene rendered to a target with no renderer MRT: `mrtNode` becomes the whole output | `render/bloomMRT.js`, `sky/dayNightSky.js`, `ledMatrix.js`, shared-rts and rts-v3 `bloom.js` | ? |
| Each `.sample()` on a viewportSharedTexture clones it and copies the frame again | copy-once subclass (lake) | ? |
| `NodeMaterial.clone()` drops `map` | copy `map` after clone (`shared-rts/unitRenderer.js`) | r185 (`copy()` copies properties dynamically) |
| `light.colorNode` read only when the light node is first made | set it at light creation | ? |
| `Light.visible` toggles rebuild every shader | switch lights by intensity | ? |
| CSM cascade count is boot-only (the old pipeline keeps its node) | `app/main.js`, `worldEnvironment.js`, `namGame.js`, `rtsGame.js`, `roadGame.js` | r185/r186 CSM fixes? |
| CubeCamera aims its faces only in `update()` | always go through `update()` | ? |
| 3D textures can't upload mip levels | `render/skypro/skyproClouds.js` (three internals, flagged) | ? |
| ExternalTexture destroys its source GPUTexture on dispose | Fire Pro `release()` patch (`v3/vendor/fire-pro`, VENDOR.md) | r185 ("ExternalTexture fully supported") |
| TiledLighting creates a new lights node per material term | `render/lighting/localLights.js`, `lights-lab/lab.js` | replaced: see Breaks |
| Static non-node materials freeze the scene's fog uniforms | a colorNode (or `fog: false` for HUD) | ? |
| The terrain sits at WebGPU's 16 fragment samplers | ring height as a varying; no texture added to every lit material | a device limit, not three |

These aren't bugs, just how three works; keep them in mind:
- `a.mix(b, t)` means `mix(b, t, a)`: always call `mix(a, b, t)`.
- `colorNode` drops alpha; use `fragmentNode` for exact RGBA.
- `normalNode` is in VIEW space.
- `screenUV` Y is flipped compared with `ndc*0.5+0.5`.
- In a post pass, the camera nodes are the quad's camera, not the scene camera.
- Identical node materials reading different storage buffers share one program; give each its own `customProgramCacheKey`.
- Inside-out DoubleSide geometry renders black.

## Breaks in r185 + r186 (checked against our code 2026-10-17)

- **TiledLighting removed from the addons (r185); clustered lighting replaces it.** Our local lights
  (`localLights.js`, built on `TiledLightsNode`; installed only when local lights are on) and the
  lights lab must move to `ClusteredLightsNode`. This is the biggest job in the upgrade.
- **`PCFSoftShadowMap` removed (r186): 23 files use it**, mostly labs, plus `games/modular-road-v3/cityLab.js`
  and `games/terrarium/terrariumLab.js`. Replace it with `PCFShadowMap` plus our radius.
- **Render-target viewports are no longer scaled by pixel ratio (r186).** Check renderScale and every post pass.
- **Shadow maps are no longer drawn during precompile (r186).** Check the shader warm-up: the first frame may still compile shadow shaders.
- `PostProcessing` is a deprecated alias (2 files); use `RenderPipeline`.
- Vector `not()` is now per component; texture sampling respects the texture format.
- Not used by us (checked with grep): `directionToFaceDirection`, `modInt`, `THREE.Source`,
  `renderer.dispose()`, the Sky's `up` uniform, `LightProbeGrid`, `determinant3x3`, `setDecoderConfig`.

## To try after the upgrade

- **CPU per frame:** pooled UBO updates, faster `submit()`, descriptor and pipeline caching,
  bind groups compared by handle. The RTS games are CPU-bound; measure first.
- **Boot and warm-up:** shader functions cached per backend, faster node-builder paths.
- **Clustered lighting:** many cheap local lights. For night maps (the Apocalypse game's Do Lung
  bridge: flares, fires).
- **Cascade fixes:** split mismatch (r185), a one-frame-late cascade (r186). For fast-camera games
  (racing, flight); the RTS games use one fitted frustum and don't need them.
- **Debugging:** GPU errors and WGSL diagnostics show up in the console.
- **Engine features:**
  - `textureGather` / `textureGatherCompare` (cheaper 4-tap reads);
  - `compileComputeAsync()` (warm-up for compute);
  - read-write storage buffers in vertex/fragment shaders (crowd skinning);
  - better occlusion queries (the Hi-Z lab);
  - BatchedMesh fixes;
  - `textureSize()` / mip fixes.
- **Not for us now:** the new `SunLight` (2 cascades; our RTS fit is sharper), Sky clouds (we have
  Sky Pro), Gaussian splats, OIT, VXGI, WebXR.
