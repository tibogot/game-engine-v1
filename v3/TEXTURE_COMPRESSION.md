# Texture compression (KTX2): use it in every game

Since 2026-10-19 every game should load its image textures through the shared loader, so they ship
compressed. That means 4× less GPU memory, mipmaps included, and no image decoding on the main thread.

## How

1. In code, load a texture with `loadTexture(url)` from `v3/render/textureLoad.js`, NOT
   `new THREE.TextureLoader()`. Call `initTextureLoader(renderer)` once at boot.
2. Run `npm run textures` (tools/compressTextures.mjs). It writes `public/ktx2/` and its manifest
   (generated, not in git). A release build runs it too.
3. Judge the look in `v3/ktx2-lab.html` (original vs compressed). Compare a game page with `?ktx2=0`.

Without step 2, the loader falls back to the original images, so nothing breaks.

**Models:** GLBs go through `tools/optimizeGlb.mjs` (KTX2 + meshopt) when they are made.

**Not compressed:**
- textures read on the CPU (terrain slots, brush stamps, getImageData);
- textures generated at run time;
- small UI images (`textures/ui/`).

## Per game: status

| Game | When | Status |
|---|---|---|
| Thunderline | now: every new texture through `loadTexture` | to start |
| Apocalypse (Vietnam RTS) | from day one | not started |
| alg-rts | at content freeze, with item 15 (perf + boot) in games/alg-rts/TODO.md: switch its TextureLoader calls, run the tool, measure boot and GPU MB before / after | waiting for the freeze |
| Terrain ground textures (all games) | later: a per-level "bake for the game" step (the 7-slot arrays are about 78 MB uncompressed) | not built |

Update this table when a game switches.
