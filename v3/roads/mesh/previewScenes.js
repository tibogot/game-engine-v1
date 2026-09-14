// Test networks for the 3D road preview in the v3 editor (Lane Road mode).
//
// Flat ground only for now: every node sits at the same height and every road
// takes a straight (so level) grade between its nodes. The three small scenes
// isolate one feature each; the engine's own flat demo scenes are offered too,
// for a sense of scale and cost.

import { emptyNetwork, addNode, addRoad } from "../roadEdit.js";
import { SCENES } from "../roadScenes.js";

/** Straight avenue: lanes, parking, sidewalks, dead-end caps. */
function straight() {
  const d = emptyNetwork("eu");
  const a = addNode(d, -110, 0), b = addNode(d, 110, 0);
  addRoad(d, a, b, "avenue");
  return d;
}

/** 4-way: boulevard (raised median, bike lane, verge) across an avenue. */
function junction() {
  const d = emptyNetwork("eu");
  const c = addNode(d, 0, 0);
  const w = addNode(d, -120, 0), e = addNode(d, 120, 0), n = addNode(d, 0, -120), s = addNode(d, 0, 120);
  addRoad(d, w, c, "boulevard");
  addRoad(d, c, e, "boulevard");
  addRoad(d, n, c, "avenue");
  addRoad(d, c, s, "avenue");
  return d;
}

/** 4-arm roundabout: apron, grass island, splitter islands, flared entries. */
function roundabout() {
  const d = emptyNetwork("eu");
  const c = addNode(d, 0, 0, { kind: "roundabout" });
  const n = addNode(d, 0, -130), s = addNode(d, 0, 130), e = addNode(d, 130, 0), w = addNode(d, -130, 0);
  addRoad(d, n, c, "avenue");
  addRoad(d, c, s, "avenue");
  addRoad(d, c, e, "collector");
  addRoad(d, w, c, "local");
  return d;
}

/** Copy `src` into `dst` moved by (dx, dz), with its ids prefixed. */
function place(dst, src, prefix, dx, dz) {
  const id = (v) => `${prefix}${v}`;
  for (const n of src.nodes) dst.nodes.push({ ...n, id: id(n.id), x: n.x + dx, z: n.z + dz });
  for (const r of src.roads) {
    dst.roads.push({ ...r, id: id(r.id), a: id(r.a), b: id(r.b), pts: r.pts.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz })) });
  }
  return dst;
}

function allThree() {
  const d = emptyNetwork("eu");
  place(d, straight(), "s", 0, -200);
  place(d, junction(), "j", -170, 60);
  place(d, roundabout(), "r", 170, 60);
  return d;
}

const engine = (key) => () => SCENES[key].build();

export const PREVIEW_SCENES = {
  straight: { label: "Straight road", build: straight },
  junction: { label: "4-way junction", build: junction },
  roundabout: { label: "Roundabout", build: roundabout },
  all: { label: "All three", build: allThree },
  downtown: { label: "Downtown grid (engine)", build: engine("downtown") },
  boulevard: { label: "Boulevard & pockets (engine)", build: engine("boulevard") },
  roundabouts: { label: "Roundabouts (engine)", build: engine("roundabouts") },
  oldTown: { label: "Old town (engine)", build: engine("oldTown") },
};

/** Level every node at `y` and give every road a straight grade (flat ground). */
export function flattenNetwork(data, y) {
  for (const n of data.nodes) n.y = y;
  for (const r of data.roads) r.profile = { mode: "linear" };
  return data;
}
