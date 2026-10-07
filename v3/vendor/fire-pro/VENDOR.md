# Fire Pro (vendored)

Daniel Greenheck's volumetric fire, smoke and explosions for three.js WebGPU — MIT
(`LICENSE`, `THIRD_PARTY_NOTICES.md`). Upstream: https://github.com/dgreenheck/threejs-fire-pro
at `c284f0b13ed2234752087b8dce24f0cb38854147` (2026-10-07). Only `src/` is copied.

Used OFFLINE, by the fire-bake lab (`v3/fire-bake-lab.html`): too heavy to run in a
game, so it simulates once and the lab bakes six-way flipbooks from it. No game imports it.

## Patches (search `VENDOR PATCH`)

- `src/library/SceneLights.ts` — three 0.184 has no `ClusteredLighting` (it arrives in
  0.185, Fire Pro's peer version); a local empty class stands in, so the scene lights
  take their fixed-four path.
- `src/library/SceneVolumeRenderer.ts` — `release()`: three 0.184 DESTROYS an
  `ExternalTexture`'s source GPUTexture when the wrapper is disposed. The renderer drops
  wrappers of textures it stops reading, but velocity and curl swap roles every step, so
  that destroyed the solver's live curl: every later "Fluid step" submit failed
  ("Destroyed texture used in a submit") and the fire froze as a still ball. The GPU
  texture is detached from the wrapper before it is disposed.
- `src/library/options.ts`, `src/engine/shaders/scene-volume.wgsl` — a `motion` debug
  field: the velocity of what the camera sees, weighted as the beauty render's opacity.
  The lab projects it on the bake camera for the flipbook's motion vectors.
