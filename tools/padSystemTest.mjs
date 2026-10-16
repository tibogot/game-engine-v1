/**
 * Headless checks for pads (v3/terrain/padSystem.js) on the height stack.
 * Run: node tools/padSystemTest.mjs   (picked up by npm test)
 */
import { createHeightLayers } from "../v3/terrain/heightLayers.js";
import { createPadSystem } from "../v3/terrain/padSystem.js";

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

const S = 128, W = 128, MAXH = 100;            // 1 m texels, heights in metres / 100
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
const idx = (x, z) => Math.floor(z + W / 2) * S + Math.floor(x + W / 2);   // world metres → texel

/** Ground that rises 0.5 m per metre in x: 30 m at x = 0. */
function slope() {
  const g = new Float32Array(S * S);
  for (let tz = 0; tz < S; tz++) for (let tx = 0; tx < S; tx++) g[tz * S + tx] = (30 + 0.5 * (tx + 0.5 - S / 2)) / MAXH;
  return g;
}

function setup(resolveProp) {
  const final = new Float32Array(S * S);
  const L = createHeightLayers({ final, size: S });
  L.reset(slope());
  const P = createPadSystem({ heightLayers: L, worldSize: W, heightmapSize: S, maxHeight: MAXH, resolveProp });
  const h = (x, z) => final[idx(x, z)] * MAXH;
  return { final, L, P, h };
}

// ── 1. A "follow" pad levels to the ground's average under it ───────────────
{
  const { P, h } = setup();
  const p = P.add({ x: 0, z: 0, halfX: 6, halfZ: 6, rim: 4 });
  ok("follow: flat inside", near(h(-5, 0), h(5, 0), 1e-3) && near(h(0, -5), h(0, 5), 1e-3), `${h(-5, 0)} ${h(5, 0)}`);
  ok("follow: at the ground's average (30 m)", near(h(0, 0), 30, 0.3), String(h(0, 0)));
  ok("follow: back to the ground past the rim", near(h(15, 0), 30 + 0.5 * 15, 0.3), String(h(15, 0)));
  ok("follow: eases inside the rim", h(8, 0) > 30 && h(8, 0) < 30 + 0.5 * 8, String(h(8, 0)));

  // Edit: fixed height and an offset.
  P.edit(p.id, { heightMode: "fixed", height: 40, offset: 2 });
  ok("fixed: at height + offset", near(h(0, 0), 42, 1e-3), String(h(0, 0)));
  P.edit(p.id, { enabled: false });
  ok("disabled: no effect", near(h(0, 0), 30, 0.3), String(h(0, 0)));
  P.edit(p.id, { enabled: true });
  ok("re-enabled", near(h(0, 0), 42, 1e-3));
  P.remove(p.id);
  ok("removed: ground is back", near(h(0, 0), 30, 0.3) && P.pads.length === 0);
}

// ── 2. "Follow" re-measures when the ground under it changes ────────────────
{
  const { final, L, P, h } = setup();
  P.add({ x: 0, z: 0, halfX: 6, halfZ: 6, rim: 4 });
  const before = h(0, 0);
  // A sculpt stroke the way the GPU makes one: FINAL raised by 10 m around the pad, absorbed.
  for (let tz = 40; tz <= 88; tz++) for (let tx = 40; tx <= 88; tx++) final[tz * S + tx] += 10 / MAXH;
  L.absorb({ x0: 40, z0: 40, x1: 88, z1: 88 });
  ok("ground raised: the pad still holds its old level until update()", near(h(0, 0), before, 1e-3));
  P.update();
  ok("update(): the pad re-levels to the new ground (+10 m)", near(h(0, 0), before + 10, 0.05), `${before} -> ${h(0, 0)}`);
  const v = L.version;
  P.update();
  ok("update() again with nothing changed does nothing", L.version === v);
}

// ── 3. A pad attached to a prop follows it ───────────────────────────────────
{
  const prop = { x: -20, z: 0, rot: 0, halfX: 3, halfZ: 2 };
  const { P, h } = setup((id) => (id === 7 ? prop : null));
  const p = P.add({ attach: 7, margin: 1, rim: 3, heightMode: "fixed", height: 50 });
  ok("attached: at the prop", near(h(-20, 0), 50, 1e-3) && near(h(-16.5, 0), 50, 1e-3), `${h(-20, 0)} ${h(-16.5, 0)}`);
  ok("attached: footprint = prop + margin", near(P.footprintOf(p.id).halfX, 4) && near(P.footprintOf(p.id).halfZ, 3));
  prop.x = 20;
  P.update();
  ok("prop moved: the pad moved with it", near(h(20, 0), 50, 1e-3), String(h(20, 0)));
  ok("…and the old place is ground again", near(h(-20, 0), 30 - 10, 0.3), String(h(-20, 0)));
}

// ── 4. Circle, rotation, picking ─────────────────────────────────────────────
{
  const { P, h } = setup();
  P.add({ shape: "circle", x: 0, z: 0, halfX: 5, rim: 2, heightMode: "fixed", height: 60 });
  ok("circle: flat within the radius", near(h(3.5, 3.5), 60, 1e-3), String(h(3.5, 3.5)));
  ok("circle: not in the corner of its square", !near(h(4.8, 4.8), 60, 0.5), String(h(4.8, 4.8)));
  const r = P.add({ x: 30, z: 30, halfX: 8, halfZ: 1, rot: Math.PI / 2, rim: 0, heightMode: "fixed", height: 70 });
  ok("rotated 90°: long along Z now", near(h(30, 36), 70, 1e-3) && !near(h(36, 30), 70, 0.5), `${h(30, 36)} ${h(36, 30)}`);
  ok("pick: inside", P.pick(30, 35)?.id === r.id);
  ok("pick: outside", P.pick(45, 45) === null);
}

// ── 5. Save / load and undo snapshots ────────────────────────────────────────
{
  const { P, h } = setup();
  P.add({ x: 0, z: 0, heightMode: "fixed", height: 45 });
  P.add({ shape: "circle", x: 25, z: -25, halfX: 4, heightMode: "follow", offset: -1 });
  const data = P.exportData();
  const json = JSON.parse(JSON.stringify(data));
  const b = setup();
  b.P.importData(json);
  ok("load: same pads", b.P.pads.length === 2 && b.P.pads[1].shape === "circle");
  ok("load: same heights", near(b.h(0, 0), h(0, 0), 1e-4) && near(b.h(25, -25), h(25, -25), 1e-4));
  const snap = P.snapshot();
  P.remove(P.pads[0].id);
  P.restore(snap);
  ok("snapshot / restore brings a deleted pad back", P.pads.length === 2 && near(h(0, 0), 45, 1e-3));
  const id = P.add({ x: -30, z: 30 }).id;
  ok("new ids never reuse a restored one", !snap.some((s) => s.id === id));
}

// ── 6. A pad survives a river operator and a reset re-applies cleanly ───────
{
  const { L, P, h } = setup();
  P.add({ x: 0, z: 0, heightMode: "fixed", height: 55, rim: 0 });
  // An operator that cuts 5 m everywhere (a stand-in for a river).
  L.setOperator("cut", { rect: { x0: 0, z0: 0, x1: S - 1, z1: S - 1 }, apply: (out, g, r) => {
    for (let tz = r.z0; tz <= r.z1; tz++) for (let tx = r.x0; tx <= r.x1; tx++) out[tz * S + tx] -= 5 / MAXH;
  } });
  ok("a pad sits above operators", near(h(0, 0), 55, 1e-3));
  L.reset(slope());
  ok("after a reset the stamps are gone", near(h(0, 0), 30, 0.3));
  P.reapplyAll();
  ok("reapplyAll puts the pad back", near(h(0, 0), 55, 1e-3));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
