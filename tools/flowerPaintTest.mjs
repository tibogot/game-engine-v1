// Flower mode (v3/render/grass/flowerSystem.js): the paint brush writes one
// flower type per density channel, erase clears every type, and each flower
// type is real geometry in a near and a far level of detail.
import { stampFlowerDensity, FLOWER_DENSITY_RES } from "../v3/render/grass/flowerDensity.js";
import { createFlowerTypeGeometry } from "../v3/render/grass/flowerGeometry.js";
import { createFlowerState, FLOWER_TYPE_COUNT, FLOWER_PRESETS, FLOWER_GEOMETRY_KEYS } from "../v3/app/state/flowerState.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};

// ── Paint ──
const res = 64, worldSize = 640;             // 10 m per texel
const data = new Uint8Array(res * res * 4);
const at = (x, z) => ((z + worldSize / 2) / worldSize * res | 0) * res + ((x + worldSize / 2) / worldSize * res | 0);
const px = (x, z) => Array.from(data.subarray(at(x, z) * 4, at(x, z) * 4 + 4));

stampFlowerDensity(data, res, { cx: 0, cz: 0, radius: 60, strength: 1, falloff: 1, worldSize, channel: 2, erase: false });
const centre = px(0, 0);
check("paint goes to the chosen type's channel only", centre[2] > 200 && centre[0] === 0 && centre[1] === 0 && centre[3] === 0, centre.join(","));
check("paint outside the brush is untouched", px(200, 200).every((v) => v === 0));
check("paint falls off toward the edge", px(40, 0)[2] < centre[2] && px(40, 0)[2] > 0, `${px(40, 0)[2]} < ${centre[2]}`);
stampFlowerDensity(data, res, { cx: 0, cz: 0, radius: 60, strength: 1, falloff: 1, worldSize, channel: 0, erase: false });
check("a second type mixes in without replacing the first", px(0, 0)[0] > 200 && px(0, 0)[2] > 200, px(0, 0).join(","));
stampFlowerDensity(data, res, { cx: 0, cz: 0, radius: 60, strength: 1, falloff: 0.2, worldSize, channel: 2, erase: true, onlyChannel: true });
check("erase this flower only leaves the other types", px(0, 0)[2] === 0 && px(0, 0)[0] > 200, px(0, 0).join(","));
stampFlowerDensity(data, res, { cx: 0, cz: 0, radius: 60, strength: 1, falloff: 1, worldSize, channel: 2, erase: false });
stampFlowerDensity(data, res, { cx: 0, cz: 0, radius: 60, strength: 1, falloff: 0.2, worldSize, channel: 3, erase: true });
check("erase clears every type", px(0, 0).every((v) => v === 0), px(0, 0).join(","));
check("a brush off the map changes nothing",
  stampFlowerDensity(data, res, { cx: 5000, cz: 5000, radius: 10, strength: 1, falloff: 1, worldSize, channel: 1, erase: false }) === false);
check("density is 1024² (2 m per texel on the default world)", FLOWER_DENSITY_RES === 1024);

// ── Geometry ──
const parts = (geo) => {
  const a = geo.getAttribute("aFlower");
  const n = [0, 0, 0, 0];
  for (let i = 0; i < a.count; i++) n[Math.round(a.getX(i))]++;
  return n;
};
for (const [name, preset] of Object.entries(FLOWER_PRESETS)) {
  const near = createFlowerTypeGeometry(preset, { lod: 0 });
  const far = createFlowerTypeGeometry(preset, { lod: 1 });
  const pn = parts(near.geometry), pf = parts(far.geometry);
  check(`${name}: near has petals, centre, stem${preset.leaves ? " and leaves" : ""}`,
    pn[0] > 0 && pn[1] > 0 && pn[2] > 0 && (preset.leaves ? pn[3] > 0 : pn[3] === 0), pn.join("/"));
  check(`${name}: far is much lighter and has no leaves`, far.triangles * 3 <= near.triangles && pf[3] === 0,
    `near ${near.triangles} tris, far ${far.triangles}`);
  check(`${name}: near stays under 400 triangles`, near.triangles < 400, `${near.triangles}`);

  const pos = near.geometry.getAttribute("position"), nrm = near.geometry.getAttribute("normal");
  let finite = true, unit = true;
  for (let i = 0; i < pos.count; i++) {
    if (![pos.getX(i), pos.getY(i), pos.getZ(i)].every(Number.isFinite)) finite = false;
    if (Math.abs(Math.hypot(nrm.getX(i), nrm.getY(i), nrm.getZ(i)) - 1) > 1e-3) unit = false;
  }
  check(`${name}: positions finite, normals unit length`, finite && unit);
}

// Petal count drives the mesh.
const five = createFlowerTypeGeometry({ ...FLOWER_PRESETS.poppy, petals: 5 }, { lod: 1 }).triangles;
const ten = createFlowerTypeGeometry({ ...FLOWER_PRESETS.poppy, petals: 10 }, { lod: 1 }).triangles;
check("more petals, more far triangles (2 per petal)", ten - five === 10, `${five} → ${ten}`);

// ── State ──
const s = createFlowerState();
check("one type per density channel", s.types.length === FLOWER_TYPE_COUNT && FLOWER_TYPE_COUNT === 4);
check("every default type starts from a preset with every shape key",
  s.types.every((t) => FLOWER_PRESETS[t.preset] && FLOWER_GEOMETRY_KEYS.every((k) => k in t)));

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
