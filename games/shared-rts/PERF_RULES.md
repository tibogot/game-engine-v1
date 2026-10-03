# RTS performance rules

Rules for building an RTS game on the v3 engine so that it starts fast and stays fast. They are distilled from the alg-rts / nam-rts audits of 2026-10-03; the numbers are in `games/alg-rts/TODO.md` ("PERF + LOAD AUDIT 2"). Each rule says what breaks when you ignore it and how to check it. The checks use `app.perfCheck()` (see the end).

## Start from the defaults

1. **Boot with the shared defaults.** Spread `rtsEngineOptions(params)` into `startV3App({...})` first, so the game's own options win. Right after it, call `beginRtsPerfBoot(app, …)`. After the warm-up, call `perfBoot.endPipelines()`; when the boot is done, call `perfBoot.releaseMemory()`. All three live in `shared-rts/rtsPerfBoot.js`, and each switch keeps its `?flag` for A/B tests.
2. **Measure `bootFrames` for your game.** nam-rts booted ~5 s faster with no engine frames under the loading screen; alg-rts booted ~5 s slower without them. Compare `?bootframes=0` and `?bootframes=1` on a cool machine before you choose.

## Materials (most of the shader builds and the batching)

3. **One material per family, not one per type.** three builds a shader per material, and draws can only be batched within one material. Put per-type differences (photos, tints, card textures) in a texture array or a uniform table, and pick the entry per vertex or per instance (alg stones: 23 meshes → 9, −14 draws). nam's six card materials per plant field are why its plant batching did little.
4. **Make shared materials once and reuse them.** Two `new` materials with identical settings still build twice, because the cache key holds their node ids. Cache them the way `kitMaterialFor` in main.js does. Never dispose a shared one on a swap.
5. **Instanced meshes on one material share one build** (`shareInstanceBuilds`). They do not when they carry `instanceColor` or morphs. Avoid those on large families.
6. **An indirect-drawn mesh gets `count = 1`.** Leave `count > 1` and its uuid enters the shader key, so every mesh builds its own shader (alg: 579 → 402 builds).

## Uniforms (uploads every frame)

7. **A value that is the same for every draw goes in a shared group.** `uniform()` and `uniformArray()` default to the PER-OBJECT group: every draw of every pass gets its own copy.
   - A `uniformArray` re-uploads on every draw.
   - A uniform that changes each frame (time, camera, wind) forces every draw's whole block to be re-sent.
   - Use `.setGroup(frameGroup)` for per-frame globals and `.setGroup(renderGroup)` for tables.
   - alg: 1,067 → 110 uploads a frame, 1.1 MB → 37 KB.
8. **Anything attached to every material** (fog, sun or light colour nodes, interior hooks) must use shared groups. One per-object uniform there costs once per draw, every frame.

## Draws and culling

9. **Many small types of one material → one batched object.** Use `geometry.setIndirect(buffer, [offsets])` with merged geometry, the way `ScatterField._syncBatches` does (alg: 194 → 112 render objects, −0.7 ms of CPU). three spends ~25 µs of CPU per object, whatever its size.
10. **Hide draws that cannot contain anything.** An empty indirect draw still costs its submission (`plantCpuCull`).
11. **Cut-out (alpha-tested) cards need the depth pre-pass.** `discard` turns off early-z: the alg cedars went 19 → 6 ms.

## Boot

12. **No main-thread work during the boot that a worker could do.** Deterministic generators (rocks: 3.4 s) run in workers (`prewarmRockGeometries`), started as early as the inputs are known.
13. **Never `await` one compile after another.** Start them all, then wait for all of them together. Each wait is a GPU-process round trip of ~0.5 s or more.
14. **Release CPU copies of GPU-only data** (`markGpuOnly` + `releaseGpuOnly`): ~260 MB in alg.

## Checking: `app.perfCheck()`

Run it in the console (or over MCP) in a typical view. It prints the counters these rules move, and a `⚠` next to any that is out of line:

| Counter | Healthy |
|---|---|
| shader builds ÷ distinct shaders | < 1.6 (rule 3-6) |
| uniform uploads per render object | < 1 (rule 7-8) |
| render objects ÷ GPU draws | as low as batching allows (rule 9) |
| per-object array uploads | 0 (rule 7) |

A new feature that moves one of these numbers gets fixed before it is committed, not found by the next audit.
