// HERDS — the Aurès' flocks: sheep and goats grazing together round the mechtas,
// below the dechra and near the springs; and the villages' DONKEYS, tied up
// outside the walls and at the springs, a few of them loaded (blanket and two
// baskets) — working animals: they stay put and do not bolt from soldiers. GAME code (what grazes where); the
// animals come from the engine's builder (v3/props/animalMorph.js: the pack's
// donkey reshaped into a goat and a sheep, the lab is v3/sheep-lab.html), the
// behaviour from the shared herd (shared-rts/wildHerd.js: graze, wander, look
// up, BOLT from soldiers — one GPU crowd draw per kind).
//
// Mixed flocks, as they graze here: a pasture holds a dozen sheep and a
// handful of goats. The goats take steeper ground than the sheep. Nothing
// grazes inside a village's walls, in the wadi beds' water, or near the
// French post or the katiba.
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { initAnimalMorph, createMorphTemplate } from "../../v3/props/animalMorph.js";
import { createWildHerd } from "../shared-rts/wildHerd.js";
import { LAYOUT } from "./layout.js";

// Algeria's breeds, as far as the low-poly style carries them: a HAMRA-like
// sheep (white fleece, red-brown face and legs) and a black-brown Arbia goat.
const SHEEP = { woolColor: "#ebe4d6", faceColor: "#6a3a24", legColor: "#5a3322" };
const GOAT = {};
// The donkeys: the Algerian donkey (ash grey, dorsal stripe and shoulder
// cross); about a third carry the load, the rest go bare.
const DONKEY_BARE = { load: "none" };
const DONKEY_LOADED = { load: "panniers" };
const LOADED_SHARE = 0.35;

/**
 * Builds the flocks and hooks their update. Returns { herds, pastures } or null.
 * @param {object} o.units  the game's units (their `list`), whom the flocks flee
 */
export async function createAlgHerds(app, { units = null } = {}) {
  const t0 = performance.now();
  const gltf = await getSharedGltfLoader().loadAsync("/models/Donkey_compressed.glb");
  await initAnimalMorph(gltf);
  const sheepTpl = createMorphTemplate("sheep", SHEEP);
  const goatTpl = createMorphTemplate("goat", GOAT);
  const donkeyTpl = createMorphTemplate("donkey", DONKEY_BARE);
  const loadedTpl = createMorphTemplate("donkey", DONKEY_LOADED);

  const sites = LAYOUT.sites;
  const keepOut = sites.filter((s) => ["french", "aln"].includes(s.kind)).map((s) => ({ x: s.x, z: s.z, r: 90 }));
  const walls = sites.filter((s) => ["dechra", "hamlet", "koubba", "cemetery"].includes(s.kind)).map((s) => ({ x: s.x, z: s.z, r: s.r + 6 }));
  const inAny = (list, x, z) => list.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < c.r * c.r);
  /** Ground a sheep (or, with `minUp` lower, a goat) can stand on → its y, or null. */
  const standable = (minUp) => (x, z) => {
    if (Math.abs(x) > 500 || Math.abs(z) > 500) return null;
    const y = app.getWorldHeight(x, z);
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.3) return null;
    if (app.getWorldNormal(x, z).y < minUp) return null;
    if (app.navGrid?.isBlockedAtWorld?.(x, z)) return null;
    if (inAny(walls, x, z) || inAny(keepOut, x, z)) return null;
    return y;
  };
  const sheepStand = standable(0.9), goatStand = standable(0.8);

  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Pastures: just outside each mechta and the dechra, and near the springs.
  const homes = sites.filter((s) => ["hamlet", "dechra", "oasis"].includes(s.kind));
  const pastures = [];
  for (const s of homes) {
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2, d = s.r + 18 + rnd() * 30;
      const x = s.x + Math.sin(a) * d, z = s.z + Math.cos(a) * d;
      if (sheepStand(x, z) == null || pastures.some((p) => Math.hypot(p.x - x, p.z - z) < 50)) continue;
      pastures.push({ x, z, site: s.name });
      break;
    }
  }
  const around = (c, n, r, stand) => {
    const out = [];
    for (let k = 0; k < 80 && out.length < n; k++) {
      const a = rnd() * Math.PI * 2, d = 1.5 + rnd() * r;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (stand(x, z) != null) out.push({ x, z });
    }
    return out;
  };
  const sheepSpots = [], goatSpots = [];
  for (const p of pastures) {
    // a dozen sheep, a few of them lambs; five or six goats, one or two kids
    for (const q of around(p, 10 + Math.floor(rnd() * 5), 10, sheepStand)) {
      sheepSpots.push({ ...q, height: sheepTpl.height * (rnd() < 0.2 ? 0.62 : 0.9 + rnd() * 0.2) });
    }
    for (const q of around(p, 5 + Math.floor(rnd() * 2), 14, goatStand)) {
      goatSpots.push({ ...q, height: goatTpl.height * (rnd() < 0.2 ? 0.62 : 0.9 + rnd() * 0.18) });
    }
  }
  // Donkeys: 3-4 tied just outside each village's walls, 2 at each spring.
  const donkeySpots = [], loadedSpots = [];
  for (const s of homes) {
    const n = s.kind === "oasis" ? 2 : 3 + Math.floor(rnd() * 2);
    let placed = 0;
    for (let k = 0; k < 60 && placed < n; k++) {
      const a = rnd() * Math.PI * 2, d = s.kind === "oasis" ? s.r * 0.6 + rnd() * 10 : s.r + 8 + rnd() * 8;
      const x = s.x + Math.sin(a) * d, z = s.z + Math.cos(a) * d;
      if (sheepStand(x, z) == null) continue;
      if ([...donkeySpots, ...loadedSpots].some((q) => Math.hypot(q.x - x, q.z - z) < 4)) continue;
      const loaded = rnd() < LOADED_SHARE;
      const tpl = loaded ? loadedTpl : donkeyTpl;
      (loaded ? loadedSpots : donkeySpots).push({ x, z, height: tpl.height * (0.92 + rnd() * 0.12) });
      placed++;
    }
  }
  const threats = () => (units?.list ?? []).filter((u) => u.alive && !u.isAir && !u.isStructure).map((u) => u.position);
  const herds = [
    createWildHerd(app, sheepTpl, sheepSpots, { canStand: sheepStand, threats, name: "Sheep", walkSpeed: sheepTpl.walkSpeed, runSpeed: sheepTpl.runSpeed }),
    createWildHerd(app, goatTpl, goatSpots, { canStand: goatStand, threats, name: "Goats", walkSpeed: goatTpl.walkSpeed, runSpeed: goatTpl.runSpeed }),
    // working animals: tied up (a few metres of rope), never bolting
    createWildHerd(app, donkeyTpl, donkeySpots, { canStand: sheepStand, name: "Donkeys", walkSpeed: donkeyTpl.walkSpeed, runSpeed: donkeyTpl.runSpeed, bolt: false, roam: 3 }),
    createWildHerd(app, loadedTpl, loadedSpots, { canStand: sheepStand, name: "Donkeys (loaded)", walkSpeed: loadedTpl.walkSpeed, runSpeed: loadedTpl.runSpeed, bolt: false, roam: 3 }),
  ].filter(Boolean);
  app.addPreRenderHook((dt) => { for (const h of herds) h.update(dt); });
  console.log(`[herds] ${sheepSpots.length} sheep + ${goatSpots.length} goats on ${pastures.length} pastures (${pastures.map((p) => p.site).join(", ")}), ${donkeySpots.length + loadedSpots.length} donkeys (${loadedSpots.length} loaded) in ${Math.round(performance.now() - t0)} ms`,
    { sheep: sheepTpl.health, goat: goatTpl.health, donkey: donkeyTpl.health, loaded: loadedTpl.health });
  return { herds, pastures, sheep: sheepSpots.length, goats: goatSpots.length, donkeys: donkeySpots.length, loaded: loadedSpots.length };
}
