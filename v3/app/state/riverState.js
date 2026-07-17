import { createDepthWaterState } from "./depthWaterState.js";

/** River / River+ toolState slices — same defaults as v2 createToolState(). */
export function createRiverToolState() {
  return {
    river: {
      width: 8,
      segments: 240,
      heightOffset: 0.12,
      selectedPointY: 0,
      showHandles: true,
      activeRiverIndex: 0,
      closed: false,
      shaderStyle: "Basic",
      shallowColor: "#5dbfaa",
      deepColor: "#1a4a6a",
      highlightColor: "#c8ecff",
      foamColor: "#ffffff",
      foamWidth: 0.18,
      opacity: 0.88,
      flowSpeed: 0.15,
    },
    river2: {
      width: 8,
      segments: 240,
      heightOffset: 0.08,
      carveDepth: 1.5,
      carveShoulder: 12,
      bedCurve: 0.5,
      /**
       * Metres the carve may cut below the LOCAL uncarved ground. Without it the
       * downhill-enforced water profile excavates a spline crossing a mountain all
       * the way down to valley level — a canyon through the summit. With it the
       * water rides up over the pass in a gorge no deeper than this.
       */
      maxGorgeDepth: 10,
      /**
       * Metres the whole water profile (bed AND surface together) is lifted —
       * the "bring the river up to a nice level" control. Clamped per station
       * under the local banks so raising it can never make the water spill.
       * Negative sinks the river deeper.
       */
      waterLevelOffset: 0,
      /**
       * When on, a river endpoint dropped near another river snaps onto its
       * centerline and becomes a tributary: its mouth inherits the parent's
       * water level so the confluence is seamless.
       */
      branchSnap: true,
      selectedPointY: 0,
      showHandles: true,
      activeRiverIndex: 0,
      closed: false,
      shaderStyle: "Depth",
      /**
       * Depth style only: metres the water surface sits BELOW the river's height
       * profile, i.e. down inside the carved trench. Kept under carveDepth, or the
       * water breaches the channel rim and floats on the surrounding ground.
       */
      waterFreeboard: 0.4,

      /**
       * Depth-style water. Same shape as the lake's `.water` (see depthWaterState.js)
       * — same shader, same panel controls — but its own values. A river is a couple
       * of metres deep and its banks are always close by and on screen, so it wants a
       * much shorter absorption distance and a shorter SSR ray than an open lake.
       * Everything below this line is inert when shaderStyle is Toon or Basic.
       */
      water: createDepthWaterState({
        depthDistance:  3,      // lake default is 20
        shoreFade:      0.05,
        normalTiling:   0.08,
        ssrMaxDistance: 60,     // lake default is 120
      }),

      // ── Toon / Basic only. Inert in Depth style. ────────────────────────────
      shallowColor: "#4fd8c2",
      deepColor: "#14526e",
      highlightColor: "#cdf3ff",
      foamColor: "#ffffff",
      foamWidth: 0.18,
      opacity: 0.9,
      flowSpeed: 2.5,       // metres/second (world-scaled U)
      bandCount: 3,
      depthAbsorb: 0.8,
      foamDepth: 0.6,
      foamScale: 1.5,
      streakScale: 6,
      streakStrength: 0.35,
      rapidsSlope: 0.08,
      rapidsBoost: 1.5,
      sparkleStrength: 0.25,
      rimStrength: 0.25,
    },
  };
}
