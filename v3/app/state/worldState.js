import { createToolState } from "../../../v2/app/state/toolState.js";
import { OCEAN2_DEFAULTS } from "../../render/water/oceanSurface.js";
import { SKY_DEFAULTS as ATMOSPHERE_SKY_DEFAULTS } from "../../render/sky/atmosphereSkyDome.js";
import { CLOUD_DEFAULTS } from "../../render/clouds/volumetricCloudDeck.js";
import { PAINTED_CLOUD_DEFAULTS } from "../../render/clouds/paintedCloudDeck.js";
import { GRID_DEFAULTS } from "../../render/materials/gridMaterial.js";

/**
 * World-tab toolState slice — same defaults as v2 createToolState().
 *
 * @param {object} [opts]
 * @param {boolean} [opts.editor] true on the editor page. Only affects the default SKY
 *   MODE; see `skyMode` below for why a game must not inherit it.
 * @param {string}  [opts.skyMode] an explicit mode, for a game that wants one.
 */
export function createWorldToolState({ editor = false, skyMode } = {}) {
  const ts = createToolState();
  return {
    light: ts.light,
    /*
     * THE EDITOR BOOTS INTO THE ATMOSPHERE SKY.
     *
     * The physically-scattered dome with its painted cloud deck, the same pair the racing
     * game ships — so a new world opens under the sky the games actually use instead of
     * under a mode you have to go and find. The other three (`physical`, `hdr`,
     * `procedural`) are unchanged and one dropdown away.
     *
     * A saved project keeps whatever IT saved: `skyMode` rides in the look block, so this
     * default only applies to a world that has never chosen one.
     *
     * COSTS ~0.6 s AT BOOT, once: three LUT bakes and a large shader compile that used to
     * be paid lazily on the first switch into the mode. The editor makes that trade
     * deliberately, so the build lands inside boot rather than as a hitch later.
     *
     * THE EDITOR ONLY, and that is not a detail. A game that draws its OWN sky — as
     * modular-road does — hides the engine's dome the moment it boots, so defaulting to
     * this mode everywhere made the engine build a whole second atmosphere dome and cloud
     * deck, pay the LUT bakes and the shader compile, and then hide the result. Caught by
     * counting meshes: the game's scene had TWO `AtmosphereSkyDome`s. A game that wants
     * this sky asks for it (`startV3App({ skyMode: "atmosphere" })`); a game that does not
     * keeps the old default and pays nothing.
     */
    skyMode: skyMode ?? (editor ? "atmosphere" : ts.skyMode),
    skyExposureByMode: ts.skyExposureByMode,
    physicalSky: ts.physicalSky,
    // V3 optimized sky (lab dayNightSky.js): astronomical arc + sky-view LUT +
    // smooth-horizon band fix. These params don't exist in v2's frozen toolState.
    proceduralSky: {
      ...ts.proceduralSky,
      /*
       * THE CLOCK IS SHARED BY BOTH DOMES, and it is set to the racing game's boot hour
       * (GAME_TIME_OF_DAY) rather than v2's 9.5, so the editor and the game open on the
       * SAME sky and can be compared side by side without first dialling one to match the
       * other. Everything else that places the sun — latitude, day of year, moon age —
       * already agreed; the hour was the only thing that did not.
       */
      timeOfDay: 10.5,
      /** Matches the sky module's own default, so the two advance at the same rate. */
      daySpeed: 0.4,
      latitude: 45, // observer latitude (°) — tilts the sun/moon arc
      dayOfYear: 172, // 1..365 → solar declination (172 ≈ N summer solstice)
      moonAge: 0.55, // synodic age 0=new .5=full 1=new → moon position + phase
      useLut: true, // sample the pre-baked sky-view LUT (perf)
      atmoHorizonSoft: 0.05, // soft terminator width — kills twilight banding
      // v2's additive multi-scatter hack washed the day sky toward white at 1.0;
      // v3's sky replaced it with an energy-conserving Ψms LUT (Hillaire), so
      // 1.0 now means "the physical amount" and stays the default.
      msAmount: 1.0,
      // Sun disc → emissive MRT scale (selective bloom; needs Post FX on).
      sunBloom: 1.0,
      // v2 ships βM×1.0 = 21e-6 — a HAZY day; the Mie aureole washed a third of
      // the sky white around the sun. 0.4 ≈ 8.4e-6 = clear day (verified in
      // browser: deep blue zenith, tight natural aureole).
      mie: 0.4,
      // With the haze gone the extra artistic glow reads doubled — v2's 0.55
      // was tuned to punch through βM 21e-6. Keep a modest kiss of it.
      sunGlowStrength: 0.25,
    },
    /*
     * The "Atmosphere" sky mode (v3/render/sky/atmosphereSkyDome.js) — the second dome,
     * here to be judged against `proceduralSky` in a real world rather than in a lab.
     * Both are Hillaire; they use different constants, so they will NOT agree at the same
     * hour. That is the comparison, not a bug. See v3/AUDIT.md, "Sky".
     *
     * Its own `timeOfDay` deliberately is NOT kept here: time of day is one world fact and
     * `proceduralSky.timeOfDay` already owns it, so switching modes does not teleport the
     * sun. Everything else is the dome's own look.
     */
    atmosphereSky: {
      ...ATMOSPHERE_SKY_DEFAULTS,
      /*
       * PHYSICAL, NOT THE GRADIENT FALLBACK. `uAtmoMix` is born at 0 inside the module,
       * which is the authored gradient — measured saturation 0.17 against the physical
       * path's 0.45 in the same frame. The racing game hit exactly this: its A/B showed
       * the FALLBACK and made the new sky look grey next to the engine's.
       */
      atmosphereMix: 1,
      /*
       * NO FAKE CLOUD SEA. The dome can paint a "sea of clouds seen from above" below the
       * horizon, on at 0.55 by default, gated on cloudBase + cloudThickness = 480 m — a
       * lab altitude. In an editor you fly past 480 m all the time, and it drops a band of
       * mottled grey value-noise below the horizon that reads as choppy water, even with
       * the cloud deck off. The knob stays for sky-lab.
       */
      cloudSea: 0,
      /**
       * Which cloud deck this sky draws: "volumetric" | "painted" | "off".
       *
       * PAINTED BY DEFAULT, the same boot tier the racing game ships and for the reason it
       * gives: the fallback became the shipping look. It was written as the cheap tier and
       * stayed opt-in while it looked like one, and it no longer does — it marches a slab
       * so its clouds have real thickness and self-occlusion, curves with the planet so
       * the deck ends at a horizon instead of smearing, casts ground shadows, and carries
       * a second cirrus layer for depth, at ~0.29 ms against the volumetric deck's
       * ~1.07 ms.
       *
       * Volumetric is NOT retired — it is the one you can fly THROUGH (the painted deck is
       * camera-relative, so you can never get inside or above it) and it is one click away
       * in the Clouds panel.
       *
       * Whether the painted deck exists is a SHADER difference rather than a uniform — its
       * texture fetches are either compiled into the dome or they are not — so changing to
       * or from it rebuilds the dome (~0.7 s). That is why it is a tier and not a
       * checkbox, and why whichever tier is not selected is genuinely absent rather than
       * merely hidden.
       */
      cloudTier: "painted",
      /** How much of the sky's colour the clouds take. See cloudSkyLight.js. */
      cloudSkyTint: 0.6,
    },

    /*
     * The two cloud decks that came over from the racing game with its sky
     * (v3/render/clouds/). Seeded from each module's defaults plus the GAME's art
     * direction, not the lab's — the module defaults are a tuning ground (coverage 0.9 is
     * a total whiteout), and the point of this mode is to look like the game.
     */
    atmosphereClouds: {
      ...CLOUD_DEFAULTS,
      enabled: true,
      /**
       * COVERAGE IS THE WHOLE LOOK. 0.9 (the module default) is a solid sheet from horizon
       * to zenith with no sky left; 0.55 reads as broken cumulus with real blue between
       * the masses. Not a small window — it is the difference between "clouds" and
       * "overcast".
       */
      coverage: 0.55,
      /** Halved from the module default: at full strength everything past ~2 km washes
       *  into a structureless fog wall against the bright horizon. */
      aerialDensity: 0.0001,
      /** Slightly harder mass edges than the module default — crisper cumulus. */
      coverageSoft: 0.12,
      sunIntensity: 3.8,
      emptyStepMul: 5,
    },
    atmospherePaintedClouds: {
      ...PAINTED_CLOUD_DEFAULTS,
      /*
       * 0.60, NOT the module's 0.46 — because 0.60 is what the racing game actually shows.
       *
       * The game never authors this number: when it builds the painted deck it seeds the
       * coverage from the VOLUMETRIC deck's (0.55 + 0.05), so that switching tier changes
       * the COST and not the art direction. That seeding rule only exists because the game
       * switches tiers at runtime; the editor boots straight into painted, so it takes the
       * value the rule produces instead of re-deriving it. Measured live in the game to be
       * sure: 0.6000000000000001.
       */
      coverage: 0.6,
    },
    volumetricCloudDayNight: ts.volumetricCloudDayNight,
    cloudShadows: ts.cloudShadows,
    cloudGodRays: {
      ...ts.cloudGodRays,
      // Occlusion luminance gate (v3 god-rays pass) — see godRaysPass.js.
      occLumThreshold: 0.45,
    },
    cloudBloom: ts.cloudBloom,
    lensFlare: { ...ts.lensFlare, enabled: false },
    postFx: ts.postFx,
    /*
     * SHADOWS — v3 diverges from v2 here, see AUDIT #108.
     *
     * v2 ships `practical` splits with maxFar 80. That pairing was tuned when
     * the editor ran FOUR cascades: practical anchors its logarithmic half on
     * camera.near (0.5 m), which flattens it to nearly uniform, so the first
     * split lands at about maxFar/3 and shadow RANGE and contact-shadow
     * sharpness end up fighting over one number. Dropping to 3 cascades — forced
     * by the Windows WebGPU 16-samplers-per-stage cap — quietly made the near
     * cascade ~35% coarser (11 m → 15 m first split) without anyone re-picking
     * the 80.
     *
     * v3 anchors the splits instead: cascade 0 ends at `nearSplit`, the rest are
     * spaced logarithmically out to maxFar (csmSplits.js). At 3 cascades that
     * gives 0.5–10 / 10–39 / 39–150 m and 1.2 / 4.5 / 17 cm per texel at 2048 —
     * a SHARPER near cascade than practical@80 managed (1.7 cm) with nearly
     * double the reach.
     *
     * 150 is not arbitrary: prop LOD tiers start at 60 / 150 / 500 m and a tier
     * casts only while its start distance is inside maxFar. At 80 the LOD1 props
     * from 80–150 m were drawn into shadow maps that stopped short of them; at
     * 150 that work becomes visible shadow, and LOD2 still never casts. Going
     * past 150 would switch a whole tier of casters on.
     */
    csm: {
      ...ts.csm,
      maxFar: 150,
      /** "custom" = nearSplit-anchored; "practical"/"logarithmic"/"uniform" are three's own. */
      splitMode: "custom",
      /** Where cascade 0 ends (m) — the distance past which contact shadows stop mattering. */
      nearSplit: 10,
      /**
       * Mountains shade valleys at ANY distance, not just inside maxFar: a
       * per-vertex march toward the sun through the heightmap
       * (render/lighting/terrainSunShadow.js). Uniform-driven, so toggling and
       * softness never recompile.
       */
      terrainShadows: true,
      /** 0 = crisp edge, 1 = very soft. */
      terrainShadowSoftness: 0.5,
      /**
       * Brightness left on vegetation that does not receive shadows (far grass
       * rings, far foliage, susuki) when it stands in a mountain's shade.
       */
      terrainShadeFloor: 0.45,
    },
    fog: ts.fog,
    interior: ts.interior,
    /*
     * TWO OCEANS, ONE SLICE.
     *
     * `mode` picks which shader draws: "classic" is oceanShader.js exactly as it
     * has always been, "v2" is oceanSurface.js (shoreline distance field,
     * travelling surf, transparent shallows). Default is classic, so nothing
     * about an existing project changes until the switch is thrown.
     *
     * The v2 params live in their own `v2` bag rather than beside the classic
     * ones because several names collide with DIFFERENT meanings — `foamCutoff`
     * is a 0..1 threshold in classic and a gain-normalised one in v2, and mixing
     * them would have each shader quietly corrupting the other's tuning. The
     * genuinely shared quantities (sea level, wind, swell, the clipmap LOD) stay
     * at the top level and are forwarded to whichever ocean is active.
     */
    worldOcean: {
      ...ts.worldOcean,
      mode: "classic",
      v2: structuredClone(OCEAN2_DEFAULTS),
    },
    /*
     * BARE GROUND — the greybox surface under the painted layers, and the
     * default material on primitives and grey-box kit pieces.
     *
     * `style` is compile-time (terrainLOD rebuilds its variant); everything else
     * is a shared uniform in render/materials/gridMaterial.js and is live on the
     * terrain and on every prop at once.
     *
     * Persisted in localStorage, not in the .v3proj: it describes how this
     * EDITOR draws un-authored surface, the same way render scale describes the
     * machine. A game pins it instead through `terrainFeatures.baseStyle` at
     * boot, which is the path that ships.
     */
    groundBase: {
      /** "grid" | "tile" | "flat" — see TERRAIN_FEATURES.baseStyle. */
      style: "grid",
      /** Gizmo Shift-snap, in metres. Also the fine grid cell when followSnap. */
      moveSnap: 1,
      /** Opt-in: fine cell = moveSnap / majorRatio. Off so it cannot override. */
      followSnap: false,
      ...structuredClone(GRID_DEFAULTS),
    },
    audio: ts.audio,
  };
}
