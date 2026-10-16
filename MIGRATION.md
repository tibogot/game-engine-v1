# Clean-up plan: a game-first engine

Started 2026-10-16. Goal: make games fast and ship them on Steam; the editor exists to make games faster.
The state before the clean-up is frozen at tag `archive-2026-10` (commit fdf1a74): everything removed
here can be read back from it.

**Decision (2026-10-16): clean up IN PLACE, in this repo.** A separate `gamekit` repo was created and
then dropped: the user keeps working here every day, and a mirror repo would have meant porting every
change. (`C:\Users\tibog\Downloads\gamekit` and `github.com/tibogot/gamekit` hold only a skeleton; safe to delete.)

Numbers come from `tools/migrationTrace.mjs <root> <outDir>` (imports traced from every page).

## Steps

Each step is one commit: tests green (`npm run test:all` before committing), `vite build` passes,
the editor and the games still run.

1. ~~**Absorb the v2 files v3 uses into v3, then delete `v2/`.**~~ DONE 2026-10-16. 113 files moved
   (`git mv`, history kept), 225 paths rewritten in 114 files. The four authoring pages are in
   `v3/authoring/`: `arborist.html`, `pine-editor.html` (was `pine-editor33.html`),
   `objects-lab.html`, `masonry-lab.html`. v2's old stunt car files were renamed to avoid clashing
   with Apex Rush's: `v3/play/stuntVehicle.js`, `stuntVehicleGround.js`, `stuntRoadBvh.js`;
   v2's toolState is `v3/app/state/legacyToolState.js`. Then the 147 dead v2 files went, with the v2
   build entries, `dev:v2` and the home page links. `/v2/static/...` URLs still work: they are served
   from `public/v2/static/`.
2. **Remove the dead:** archived games (rts-v3, terrarium; nam-rts?), the dropped systems (old
   `worldOcean`, the sky modes other than Sky Pro + HDR), unused labs. Show the list, user confirms.
3. **Get the game code out of the engine:** `v3/render/objects/rts*.js` (~13k lines, alg-rts and
   nam-rts buildings and vehicles) → the games / shared-rts; `v3/play/` modes → kits or archive;
   `v3/props/animalMorph.js` (alg-rts only).
4. **Put the labs in one `labs/` folder.**
5. **Foundations:** runtime/editor split (and break up the 13,000-line `v3/app/main.js`), versioned
   level format, a cook step (pre-baked runtime data, KTX2), opt-in systems, generic
   markers/zones/paths.
6. **Editor improvements, in order of need:** terrain layers, one spline system (lane roads + river
   v3), rule-based texturing, biomes, play-in-editor, a scriptable editor API.
7. **Upgrade three.js r184 → r186** as its own commit (breaking: PCFSoftShadowMap removed, async
   `dispose()`, TSL renames such as `directionToFaceDirection` → `negateOnBackSide`, `not()` on
   vectors; gains: faster node building, `compile()` for node materials, CSM frame-late fix, clustered
   lighting, OIT). Then delete our workarounds it makes unnecessary.

Any time alongside: **a tiny new game that becomes the template** (level, camera, menu, options,
pause, save, FR/EN, shared audio from `games/shared-rts/rtsAudio.js`, Steam wrapper with Electron +
steamworks.js), then ship a small game to prove the pipeline.

## Editor systems: decisions (2026-10-16)

| System | Decision |
|---|---|
| Sky | **Sky Pro + the HDRI loader** (the HDR sky mode is in `v3/app/worldEnvironment.js`). Other sky modes go. Clouds: what Sky Pro uses. |
| Ocean | **Ocean Pro = default.** Old `worldOcean`: drop. `worldOceanV2`: undecided. alg-rts has its own ocean (game code). |
| Grass | **keep both** (hybrid + Revo) and flowers. |
| Roads | **decide later**, when the new lane road system is finished. |
| River | **drop River v2 as soon as River v3 is done.** |
| Play modes | proposal below, waiting for the user |
| Lakes, waterfall, decals, ambient FX, far terrain, erosion, scatter, foliage, trees, rocks | keep |
| Labs | archive; bring a lab back only when a game needs it |

### Play modes (proposal)

- Editor keeps **walk (capsule) + fly**: a quick preview for checking scale and paths.
- A **"Play" hook** lets the current game run its own play mode inside the editor (play-in-editor), later.
- **Human character + capsule controller** → a character kit (third-person games).
- **Apex car** → a vehicle kit.
- **Bruno car, fox, ball debug** → archive. **Collectibles** → a small kit if a game wants them.

## From v2, still to build new (v2 code readable in the archive tag)

Audio system (base: `games/shared-rts/rtsAudio.js`), gameplay markers + barrier zones (one
markers/zones mode), dialogue runner (a kit when a game needs it). See `v3/AUDIT.md` 87, 93-96.
