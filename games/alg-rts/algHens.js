// THE HENS (you, 2026-10-01: "I made new chickens in a new page — use them in
// the game as the other animals"): your white, speckled and black hens from
// the bird lab (v3/props/birdMorph.js) round the village houses, in the
// farmsteads' yards. The shared herd machinery (wildHerd.js:
// peck, wander a few metres, look up, SCATTER from men and vehicles), one
// GPU crowd draw per plumage, at unit scale (1.3×, your rule for animals).
// The chicken's clips are its own (one 8 s idle with its pecking, walk, run):
// wildHerd's `clipNames` maps them to the behaviours. ?hens=0 = without.
import { initBirdMorph, createBirdTemplate } from "../../v3/props/birdMorph.js";
import { createWildHerd } from "../shared-rts/wildHerd.js";
import { RTS_SCALE } from "./algUnitTypes.js";

const S = RTS_SCALE;
const P = {
  perHouse: 0.35,         // hens per village house (a third of the yards keep some)
  perFarm: 4,             // a farmstead's yard
  kinds: [["hen", 0.4], ["henSpeckled", 0.35], ["henBlack", 0.25]],
  roam: 4,                // m round their spot: a hen keeps to her yard
};

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

export async function createAlgHens(app, { units = null, showroom = {}, navGrid = null } = {}) {
  const t0 = performance.now();
  await initBirdMorph();
  const tpls = Object.fromEntries(P.kinds.map(([k]) => [k, createBirdTemplate(k)]));
  const clipOf = (re) => tpls.hen.clips.find((c) => re.test(c.name))?.name;
  const idle = clipOf(/idle/i), walk = clipOf(/walk/i), run = clipOf(/run/i);
  const clipNames = { eat: idle, idle, look: idle, low: idle, walk, run };
  const R = rng(1954);

  // Ground a hen may stand on: dry, not steep, not inside a building (nav).
  const stand = (x, z) => {
    const y = app.getWorldHeight(x, z);
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.2) return null;
    if ((app.getWorldNormal?.(x, z)?.y ?? 1) < 0.8) return null;
    if (navGrid?.isBlockedAtWorld?.(x, z, true)) return null;
    return y;
  };
  const spots = Object.fromEntries(P.kinds.map(([k]) => [k, []]));
  const pick = () => { let u = R(); for (const [k, w] of P.kinds) { if ((u -= w) <= 0) return k; } return "hen"; };
  const put = (x, z, n) => {
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < 8; t++) {
        const a = R() * Math.PI * 2, r = R() * 3.5, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (stand(px, pz) == null) continue;
        spots[pick()].push({ x: px, z: pz, height: S * (tpls.hen.height ?? 0.42) * (0.9 + R() * 0.2) });
        break;
      }
    }
  };
  for (const [key, o] of Object.entries(showroom)) {
    if (!o?.isObject3D || !o.parent) continue;
    const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    const at = (lx, lz) => [o.position.x + lx * c + lz * s, o.position.z - lx * s + lz * c];
    if (/^mechtaFarm/.test(key)) {
      // In front of the house, in the yard (rtsAlgVillage buildFarmstead: the yard at -Z).
      const [x, z] = at(1.5 * S, -2.5 * S);
      put(x, z, P.perFarm);
      continue;
    }
    const houses = o.geometry?.userData?.houses;
    if (!houses?.length || !/^(mechta|dechra|ksar)/.test(key)) continue;
    for (const h of houses) {
      if (h.mosque || R() > P.perHouse) continue;
      // By the house's door side (its front, local -Z of the village frame), a few metres out.
      const [x, z] = at(h.x + (R() - 0.5) * 3, h.z - 4 - R() * 2);
      put(x, z, 2 + Math.floor(R() * 3));
    }
  }

  const threats = () => (units?.list ?? []).filter((u) => u.alive && !u.isAir && !u.isStructure).map((u) => u.position);
  const herds = P.kinds.map(([k]) => createWildHerd(app, tpls[k], spots[k], {
    canStand: stand, threats, name: `Hens (${k})`, clipNames,
    // A hen's pace: a pottering walk, a flapping dash from soldiers.
    walkSpeed: 0.45 * S, runSpeed: 3.2 * S, roam: P.roam * S,
  })).filter(Boolean);
  const step = (dt) => { dt = Math.min(dt, 0.1); for (const h of herds) h.update(dt); };
  app.addPreRenderHook(step);
  const count = Object.values(spots).reduce((n, l) => n + l.length, 0);
  console.log(`[hens] ${count} hens (${P.kinds.map(([k]) => `${k} ${spots[k].length}`).join(", ")}) in ${herds.length} draws, ${Math.round(performance.now() - t0)} ms`);
  return { herds, count, step };
}
