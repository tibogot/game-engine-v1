// How many draw batches would survive if every PLAIN OPAQUE prop part collapsed
// onto one shared vertex-attribute material?
//
// A batch today is one distinct material per prop type (mergeByMaterial groups
// by what a material RENDERS as, not by identity). A part can only join a shared
// material if nothing about it needs its own shader or its own draw: no map, not
// transparent, same `side`, and the same `tintable` flag — instanceColor
// multiplies a whole InstancedMesh, so a liveried part cannot share with a
// non-liveried one.
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./threeWebgpuHook.mjs", import.meta.url);
const THREE = await import("three/webgpu");
const { PROP_CATALOG } = await import(
  pathToFileURL(join(ROOT, "games/modular-road-v3/modularRoadProps.js")).href);

/** What makes a part need its OWN draw, beyond colour/roughness/metalness. */
const hardKey = (m, tintable) => {
  const maps = ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "alphaMap"]
    .filter((k) => m?.[k]).join("+");
  const emissive = m?.emissive ? (m.emissive.r + m.emissive.g + m.emissive.b) : 0;
  return [
    m?.transparent ? "transparent" : "opaque",
    (m?.opacity ?? 1) < 1 ? "fade" : "solid",
    `side${m?.side ?? 0}`,
    maps || "nomap",
    emissive > 1e-6 ? "emissive" : "dark",
    tintable ? "tint" : "plain",
    m?.type,
  ].join("|");
};

let totalNow = 0, totalAfter = 0, totalAfterWithEmissive = 0;
const rows = [];
for (const def of PROP_CATALOG) {
  let root;
  try { root = def.make(); } catch (e) { rows.push({ id: def.id, err: e.message.slice(0, 40) }); continue; }
  root.updateMatrixWorld(true);
  const byRender = new Set();   // today's batches: distinct material "render key"
  const byHard = new Set();     // after: distinct HARD key
  const byHardNoEmis = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || o.userData.noRender) return;
    const m = o.material;
    const t = !!o.userData.tintable;
    // Today's grouping is essentially colour+params, i.e. per distinct material.
    byRender.add(`${m?.type}|${m?.color?.getHexString?.()}|${m?.roughness}|${m?.metalness}|${m?.emissive?.getHexString?.()}|${m?.transparent}|${m?.side}|${t}`);
    byHard.add(hardKey(m, t));
    // Variant: emissive also folded into a vertex attribute.
    byHardNoEmis.add(hardKey(m, t).replace("|emissive|", "|dark|"));
  });
  if (!byRender.size) continue;
  totalNow += byRender.size;
  totalAfter += byHard.size;
  totalAfterWithEmissive += byHardNoEmis.size;
  rows.push({ id: def.id, now: byRender.size, after: byHard.size, afterEmis: byHardNoEmis.size });
}

rows.sort((a, b) => (b.now ?? 0) - (a.now ?? 0));
console.log("prop".padEnd(16), "batches now".padStart(12), "after".padStart(7), "after+emissive".padStart(16));
for (const r of rows.slice(0, 18)) {
  if (r.err) { console.log(r.id.padEnd(16), "  ERR " + r.err); continue; }
  console.log(r.id.padEnd(16), String(r.now).padStart(12), String(r.after).padStart(7), String(r.afterEmis).padStart(16));
}
console.log("\nCATALOGUE TOTAL");
console.log("  batches today                :", totalNow);
console.log("  with a shared plain material :", totalAfter, `(-${(100 * (1 - totalAfter / totalNow)).toFixed(0)}%)`);
console.log("  ...emissive folded in too    :", totalAfterWithEmissive, `(-${(100 * (1 - totalAfterWithEmissive / totalNow)).toFixed(0)}%)`);

// And for the props actually on the audit track.
const onTrack = ["neongate", "cone", "boostpad", "boostdecal", "streetlamp", "floodlight", "roadblock"];
let tNow = 0, tAfter = 0, tEmis = 0;
console.log("\nON audittest.json");
for (const id of onTrack) {
  const r = rows.find((x) => x.id === id);
  if (!r || r.err) { console.log("  " + id.padEnd(14), "not found"); continue; }
  tNow += r.now; tAfter += r.after; tEmis += r.afterEmis;
  console.log("  " + id.padEnd(14), `${r.now} -> ${r.after} (${r.afterEmis} with emissive folded)`);
}
console.log(`  TOTAL          ${tNow} -> ${tAfter} (${tEmis} with emissive folded)`);
