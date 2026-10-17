# Desktop (Electron) — test wrapper, not the shipping app yet

Opens a game in Electron and times its boot to the moment it is playable (alg-rts: the HUD's
"WASD pan" hint, after the shader warm-up). Writes `boot-log.txt` (not committed).

    cd desktop && npm install
    # VS Code's terminals set ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node:
    env -u ELECTRON_RUN_AS_NODE node_modules/.bin/electron .
    GAME_URL=http://localhost:5190/games/alg-rts/alg.html?world=/levels/alg-aures.v3proj  # a production build via `vite preview`

Electron pinned at 44.6.0 (released 2026-10-06; includes electron#54113, the shader caches
persisted between launches). The GPU disk cache is raised from Chromium's 6 MB to 1 GB.

## Measured 2026-10-17 (alg-rts, alg-aures, this laptop)

| | boot to playable | shader warm-up step |
|---|---|---|
| dev server, cold | 78.6 s | 9.5 s |
| dev server, warm ×2 | 45.5 / 41.9 s | 9.8 / 8.3 s |
| **production build**, cold | **49.1 s** | 8.1 s |
| **production build**, warm ×2 | **40.6 / 34.1 s** | 5.8 / 6.7 s |

- **WebGPU works in Electron**; alg-rts runs from a production build.
- The caches ARE kept on disk between launches (`%APPDATA%/SandAndBloodDesktopTest`:
  DawnWebGPUCache 33 MB, GrShaderCache, Code Cache, HTTP cache).
- But the persistent shader cache is **not the big win** hoped for: the warm-up step only drops
  ~8 → ~6 s. Most of a warm boot (~28 s) happens BEFORE the warm-up — loading and building the
  world — so boot time is its own job (profile the stages), not something packaging fixes.
- Not tested yet: a custom app:// protocol instead of http (the shipping way to load files),
  saves to disk, Steamworks.
