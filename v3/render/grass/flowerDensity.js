/**
 * Painted flower density — the shared scatter density layer (one type per
 * channel) at 1024², where grass and susuki use 512²: flowers are small and
 * read as patches, so the paint needs to hold a path's edge or a ring round a
 * tree. Everything else is in v3/render/scatter/scatterDensity.js.
 */
import { ScatterDensity, stampScatterDensity } from "../scatter/scatterDensity.js";

export const FLOWER_DENSITY_RES = 1024;

/** @deprecated name — the shared stamp, kept for the flower tests. */
export const stampFlowerDensity = stampScatterDensity;

export class FlowerDensity extends ScatterDensity {
  constructor() {
    super({ res: FLOWER_DENSITY_RES });
  }
}
