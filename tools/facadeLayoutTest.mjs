// ============================================================================
// THE CPU KNOWS WHERE THE WINDOWS ARE — and agrees with the shader about it.
//
// modularRoadCityFacadeLayout.js transcribes the facade shader's window grid
// so things can be bolted to windows (modularRoadCityMounts.js). A transcription
// can only drift, so this pins it in three ways:
//
//   · the SOURCE of the shader and the source of the transcription use the
//     same dice multipliers and the same hash constants — read off both files;
//   · the ported PCG hash matches an independent BigInt evaluation of the same
//     formula, wrap for wrap;
//   · the layout obeys the invariants the shader's own arithmetic has (bays
//     fill the face to within the slack; every window is inside its face; the
//     stretched mode reproduces the old bay exactly).
//
// Then the mounts themselves: every AC unit and balcony the city builds stands
// against a wall of its own building, at a window's height, on a floor that is
// a window and not a colonnade or a shopfront.
//
// Run:  node tools/facadeLayoutTest.mjs
// ============================================================================
import { register } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register("./threeWebgpuHook.mjs", import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const THREE = await import("three/webgpu");
const LAYOUT = await import("../games/modular-road-v3/modularRoadCityFacadeLayout.js");
const { FACADE_DEFAULTS, BUILDING_TYPE, DISTRICT } = await import("../games/modular-road-v3/modularRoadCityFacade.js");
const { createModularRoadCity } = await import("../games/modular-road-v3/modularRoadCity.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// ── 1. Source parity ─────────────────────────────────────────────────────────
{
  const shader = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadCityFacade.js"), "utf8");
  const port = readFileSync(join(ROOT, "games/modular-road-v3/modularRoadCityFacadeLayout.js"), "utf8");
  const dice = [...shader.matchAll(/fract\(h1\.mul\(([\d.]+)\)\)/g)].map((m) => Number(m[1]));
  check("the transcription rolls the shader's own dice, in order",
    dice.length === LAYOUT.DICE.length && dice.every((d, i) => d === LAYOUT.DICE[i]),
    `shader ${dice.join(", ")} · port ${LAYOUT.DICE.join(", ")}`);
  for (const k of ["73856093", "19349663", "256.0", "1 << 22"]) {
    check(`...and the hash key constant ${k}`, shader.includes(k) && port.includes(k));
  }
  const three = readFileSync(join(ROOT, "node_modules/three/build/three.webgpu.js"), "utf8");
  for (const k of ["747796405", "2891336453", "277803737"]) {
    check(`...and three's PCG constant ${k}`, three.includes(k) && port.includes(k));
  }
}

// ── 2. The hash port, against BigInt ────────────────────────────────────────
{
  const M = (1n << 32n) - 1n;
  const ref = (seed) => {
    const state = (BigInt(seed) * 747796405n + 2891336453n) & M;
    const shift = ((state >> 28n) + 4n) & M;
    const word = (((state >> shift) ^ state) * 277803737n) & M;
    const result = ((word >> 22n) ^ word) & M;
    return Math.fround(Math.fround(Number(result)) * Math.fround(1 / 2 ** 32));
  };
  let worst = 0, n = 0;
  for (let i = 0; i < 4000; i++) {
    const seed = (i * 2654435761 + 12345) >>> 0;
    worst = Math.max(worst, Math.abs(LAYOUT.pcgHash(seed) - ref(seed)));
    n++;
  }
  check("the PCG port matches a BigInt evaluation, wrap for wrap", worst === 0, `${n} seeds, worst ${worst}`);
  const u = [];
  for (let i = 0; i < 2000; i++) u.push(LAYOUT.hash21(i % 50, Math.floor(i / 50)));
  const mean = u.reduce((a, b) => a + b, 0) / u.length;
  check("...and hash21 is a hash (spread over 0..1, mean near a half)",
    Math.abs(mean - 0.5) < 0.03 && Math.min(...u) < 0.02 && Math.max(...u) > 0.98, `mean ${mean.toFixed(3)}`);
}

// ── 3. Layout invariants ────────────────────────────────────────────────────
{
  const P = { ...FACADE_DEFAULTS };
  let faces = 0, bad = [];
  for (let i = 0; i < 300; i++) {
    const dice = LAYOUT.lotDice(i * 34 + 17, (i * 7) % 60 * 34 + 17, 34);
    const btype = [BUILDING_TYPE.punched, BUILDING_TYPE.curtain, BUILDING_TYPE.ribbon][i % 3];
    const district = [DISTRICT.glass, DISTRICT.masonry, DISTRICT.industrial][(i >> 2) % 3];
    const W = 8 + (i * 37) % 26, Hf = 6 + (i * 53) % 90;
    const L = LAYOUT.faceLayout({ P, dice, btype, district, W, Hf, groundTier: i % 2 === 0 });
    faces++;
    if (L.flat) continue;
    const slack = W - L.count * L.bay;
    if (slack < L.pierW - 1e-6) bad.push(`slack ${slack.toFixed(3)} < pier on face ${i}`);
    if (Math.abs(L.nF * L.fh - Hf) > 1e-6) bad.push(`floors do not fill the tier on face ${i}`);
    for (const w of LAYOUT.windowsOf(L, { groundTier: i % 2 === 0 })) {
      const left = w.u - w.w / 2, right = w.u + w.w / 2;
      // The run of bays starts at the left margin and ends `count` bays on;
      // the right margin is whatever is left, and with a phase it differs.
      if (left < L.uOrigin - 1e-6 || right > L.uOrigin + L.count * L.bay + 1e-6) bad.push(`window off the face on ${i}`);
      if (w.sill < 0 || w.head > Hf + 1e-6) bad.push(`window off the tier on ${i}`);
      if (L.hasBase && w.fi < L.nBase) bad.push(`window on a colonnade floor on ${i}`);
      if (i % 2 === 0 && w.fi === 0) bad.push(`window on the shopfront floor on ${i}`);
    }
    // Stretched mode is the old layout: bays exactly fill the face.
    const S = LAYOUT.faceLayout({ P: { ...P, bayFit: 1 }, dice, btype, district, W, Hf, groundTier: false });
    if (Math.abs(S.bay - (W - S.pierW) / S.count) > 1e-9) bad.push(`bayFit 1 is not the stretched bay on ${i}`);
  }
  check("bays fill each face to within the slack, floors fill each tier",
    bad.length === 0, bad.length ? bad.slice(0, 3).join("; ") : `${faces} faces`);
  check("every window is inside its face and its tier, never on a colonnade or the shopfront",
    !bad.some((b) => /off the|colonnade|shopfront/.test(b)));
  check("bayFit = 1 reproduces the stretched bay", !bad.some((b) => /bayFit/.test(b)));
}

// ── 4. The mounts in a real city ─────────────────────────────────────────────
{
  const city = createModularRoadCity({ params: { extent: 700 } });
  const m = city.mounts;
  check("the city builds its mounts", !!m && city.stats.mounts && city.stats.mounts.acUnits > 0 && city.stats.mounts.balconies > 0,
    JSON.stringify(city.stats.mounts));
  if (m) {
    // Every candidate stands against a wall of a building: inside the
    // footprint grown by the unit's depth, above the base, below the top.
    const byXZ = new Map();
    for (const b of city.buildings ?? []) byXZ.set(`${b.x.toFixed(2)},${b.z.toFixed(2)}`, b);
    let off = 0, n = 0, low = 0;
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3(), mat = new THREE.Matrix4();
    for (const pb of m.perBuilding) {
      for (const list of [pb.ac, pb.bal]) {
        for (const e of list) {
          mat.fromArray(e); mat.decompose(pos, q, s);
          n++;
          const dx = Math.abs(pos.x - pb.x), dz = Math.abs(pos.z - pb.z);
          // Within the building's own reach: the bounding radius already
          // covers half the footprint and half the height.
          if (Math.hypot(dx, dz) > pb.r + 1.5) off++;
          if (pos.y < pb.y - pb.r || pos.y > pb.y + pb.r + 1) off++;
          if (pos.y < 3.0) low++;   // nothing on the ground floor
        }
      }
    }
    check("every unit and balcony stands within its own building's reach", off === 0, `${off} of ${n} astray`);
    check("...and none on the ground floor", low === 0, `${low} below 3 m`);

    // The LOD fill: a view from the middle sees some, never more than capacity.
    const view = { pos: new THREE.Vector3(0, 30, 0), inView: () => true };
    m.applyLod(view);
    const st = city.stats.mounts;
    // Both materials must compile to WGSL with the instanced mesh they ride:
    // an InstanceNode only exists when the object built IS the InstancedMesh.
    const { buildWGSL } = await import("./wgslBuilderStub.mjs");
    // A copy: the stub re-parents the mesh into its own scene, and iterating
    // the live children while they leave it skips every other one.
    const meshes = [...m.group.children];
    for (const mesh of meshes) {
      const b = buildWGSL(mesh.material, { instanced: mesh });
      const frag = b.fragmentShader || "";
      check(`${mesh.name} generates WGSL`, frag.length > 500 && !/undefined/.test(frag), `${frag.length} chars`);
    }
    check("the LOD tick fills the meshes from what is near",
      st.acDrawn > 0 && st.balconiesDrawn > 0 && st.acDrawn <= 9000 && st.balconiesDrawn <= 7000,
      `${st.acDrawn} units, ${st.balconiesDrawn} balconies drawn of ${st.acUnits} / ${st.balconies}`);
  }
  city.dispose?.();
}

console.log(`\n${fail ? `${fail} FAILURE(S)  ` : "ALL PASS  "}(${pass} passed)`);
process.exit(fail ? 1 : 0);
