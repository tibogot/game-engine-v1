// Editing operations on network DATA (the plain JSON that gets saved).
// Each op mutates `data` in place and returns what it created. Ops that need
// to know where a point falls along a road take the last build result.

import { projectToAlignment, evalAlignment } from "./roadAlignment.js";
import { profileAt } from "./roadProfile.js";

export function newId(data, prefix) {
  data.nextId = (data.nextId || 1) + 1;
  const used = new Set([...(data.nodes || []).map((n) => n.id), ...(data.roads || []).map((r) => r.id)]);
  let id = `${prefix}${data.nextId}`;
  while (used.has(id)) { data.nextId++; id = `${prefix}${data.nextId}`; }
  return id;
}

export function emptyNetwork(style = "eu") {
  return { version: 1, style, terrain: "flat", nodes: [], roads: [], nextId: 1 };
}

export function addNode(data, x, z, extra = {}) {
  const id = newId(data, "n");
  data.nodes.push({ id, x, z, ...extra });
  return id;
}

export function addRoad(data, a, b, type, pts = [], extra = {}) {
  const id = newId(data, "r");
  data.roads.push({ id, a, b, type, pts: pts.map((p) => ({ ...p })), sections: [], profile: { mode: "terrain" }, ...extra });
  return id;
}

export const findNode = (data, id) => data.nodes.find((n) => n.id === id);
export const findRoad = (data, id) => data.roads.find((r) => r.id === id);

export function nodeDegree(data, id) {
  let d = 0;
  for (const r of data.roads) { if (r.a === id) d++; if (r.b === id) d++; }
  return d;
}

/** Station of each authored PI along the built alignment. */
function piStations(built, road) {
  const out = [];
  const verts = built.al.vertices.filter((v) => !v.virtual);
  for (const p of road.pts) {
    const v = verts.find((q) => Math.hypot(q.x - p.x, q.z - p.z) < 0.01);
    out.push(v ? (v.sTS + v.sST) / 2 : projectToAlignment(built.al, p.x, p.z).s);
  }
  return out;
}

/** Split a road at the point nearest (x, z). Returns the new node id. */
export function splitRoadAt(data, roadId, x, z, result) {
  const road = findRoad(data, roadId);
  const built = result?.roadsById.get(roadId);
  if (!road || !built) return null;
  const pr = projectToAlignment(built.al, x, z);
  const s = Math.min(built.L - 1, Math.max(1, pr.s));
  const e = evalAlignment(built.al, s);
  const stations = piStations(built, road);
  const extra = {};
  if (road.profile?.mode && road.profile.mode !== "terrain") extra.y = profileAt(built.prof, s).y;
  const nid = addNode(data, e.x, e.z, extra);
  const first = [], second = [];
  road.pts.forEach((p, i) => (stations[i] < s ? first : second).push(p));
  const rid = newId(data, "r");
  const L = built.L;
  const remapVpis = (keepFirst) => (road.profile?.vpis || [])
    .filter((v) => (v.u * L < s) === keepFirst)
    .map((v) => ({ ...v, u: keepFirst ? (v.u * L) / s : (v.u * L - s) / (L - s) }));
  const second_ = {
    ...structuredClone(road), id: rid, a: nid, b: road.b, pts: second,
    sections: (road.sections || []).filter((sec) => sec.from === "end"),
    profile: { ...(road.profile || { mode: "terrain" }), vpis: remapVpis(false) },
  };
  road.b = nid;
  road.pts = first;
  road.sections = (road.sections || []).filter((sec) => sec.from !== "end");
  road.profile = { ...(road.profile || { mode: "terrain" }), vpis: remapVpis(true) };
  data.roads.push(second_);
  return nid;
}

export function mergeNodes(data, keepId, dropId) {
  if (keepId === dropId) return;
  for (const r of data.roads) {
    if (r.a === dropId) r.a = keepId;
    if (r.b === dropId) r.b = keepId;
  }
  data.nodes = data.nodes.filter((n) => n.id !== dropId);
  data.roads = data.roads.filter((r) => !(r.a === r.b && r.pts.length < 2));
}

/** Make a junction where two roads cross. */
export function insertJunction(data, aId, bId, x, z, result) {
  const n1 = splitRoadAt(data, aId, x, z, result);
  const n2 = splitRoadAt(data, bId, x, z, result);
  if (!n1 || !n2) return n1 || n2;
  mergeNodes(data, n1, n2);
  const n = findNode(data, n1);
  n.x = x; n.z = z;
  return n1;
}

export function deleteRoad(data, id) {
  const r = findRoad(data, id);
  if (!r) return;
  data.roads = data.roads.filter((q) => q.id !== id);
  for (const nid of [r.a, r.b]) if (nodeDegree(data, nid) === 0) data.nodes = data.nodes.filter((n) => n.id !== nid);
}

export function deleteNode(data, id) {
  const touching = data.roads.filter((r) => r.a === id || r.b === id).map((r) => r.id);
  for (const rid of touching) deleteRoad(data, rid);
  data.nodes = data.nodes.filter((n) => n.id !== id);
}

/** Turn a degree-2 node back into a bend of one road. */
export function dissolveNode(data, id) {
  const rs = data.roads.filter((r) => r.a === id || r.b === id);
  if (rs.length !== 2 || rs[0] === rs[1]) return false;
  const node = findNode(data, id);
  const [r1, r2] = rs;
  if (r1.b !== id) reverseRoad(data, r1.id);
  if (r2.a !== id) reverseRoad(data, r2.id);
  r1.pts = [...r1.pts, { x: node.x, z: node.z }, ...r2.pts];
  r1.b = r2.b;
  r1.sections = [...(r1.sections || []).filter((s) => s.from === "start"), ...(r2.sections || []).filter((s) => s.from === "end")];
  data.roads = data.roads.filter((r) => r !== r2);
  data.nodes = data.nodes.filter((n) => n.id !== id);
  return true;
}

export function reverseRoad(data, id) {
  const r = findRoad(data, id);
  if (!r) return;
  [r.a, r.b] = [r.b, r.a];
  r.pts.reverse();
  for (const s of r.sections || []) {
    s.from = s.from === "end" ? "start" : "end";
    for (const op of s.ops || []) if (op.side) op.side = op.side === "left" ? "right" : "left";
  }
  if (r.lanes) [r.lanes.left, r.lanes.right] = [r.lanes.right, r.lanes.left];
  if (r.profile?.vpis) r.profile.vpis = r.profile.vpis.map((v) => ({ ...v, u: 1 - v.u }));
}

/** Insert a PI where the user double-clicked, in the right order along the road. */
export function insertPI(data, roadId, x, z, result) {
  const road = findRoad(data, roadId);
  const built = result?.roadsById.get(roadId);
  if (!road || !built) return -1;
  const s = projectToAlignment(built.al, x, z).s;
  const stations = piStations(built, road);
  let idx = stations.findIndex((st) => st > s);
  if (idx < 0) idx = road.pts.length;
  road.pts.splice(idx, 0, { x, z });
  return idx;
}

export function removePI(data, roadId, index) {
  const road = findRoad(data, roadId);
  if (road) road.pts.splice(index, 1);
}
