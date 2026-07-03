import { SMART_ROAD_DEFAULTS } from "../../../v2/tools/smartRoad/smartRoadLabSystem.js";

/**
 * Panel-editable Smart Road params. Geometry/marking keys are assigned into
 * SmartRoadLabSystem.params on change; terrain keys drive RoadConformSystem.
 */
export const DEFAULT_ROAD_STATE = {
  ...SMART_ROAD_DEFAULTS,
  // Terrain conform (v2 lab flatten)
  liveGrade: true,     // re-grade terrain to the road after every network edit
  flattenDepth: 0.35,  // deck embed: terrain under the road = surface − this
  shoulder: 6,         // blend band back to natural ground (m)
};

export const ROAD_AUTOSAVE_KEY = "v3.smartRoad.network";
