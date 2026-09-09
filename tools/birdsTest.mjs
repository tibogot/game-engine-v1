// ============================================================================
// BIRDS: one draw, no compute, and nothing that shimmers.
//
// The whole argument for building these analytically rather than porting
// three.js's compute boids is that the cost stays trivial. So the checks are
// about cost and about the two failure modes that look fine in a still frame:
//
//   · a bird smaller than a pixel does not fade, it CRAWLS — the same thing
//     that made this game's starfield invisible;
//   · everything happens in the vertex stage, so the CPU has no idea where any
//     bird is, and a bounding sphere that does not contain them all means the
//     flock vanishes when the camera looks slightly away.
// ============================================================================
import { buildWGSL, THREE } from "./wgslBuilderStub.mjs";

const { createBirdFlock, BIRD_DEFAULTS } =
  await import("../games/modular-road-v3/modularRoadBirds.js");

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass++; console.log(`PASS  ${name}${extra ? `  — ${extra}` : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  — ${extra}` : ""}`); }
};

// Deterministic, so the numbers below mean something between runs.
let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const flock = createBirdFlock({ center: { x: 0, z: 0 }, groundY: 0, rand });
check("a flock is built", !!flock);
check("it is ONE draw", flock.stats.draws === 1, JSON.stringify(flock.stats));
check("and three triangles a bird", flock.stats.tris === flock.stats.birds * 3,
  `${flock.stats.tris} triangles for ${flock.stats.birds} birds`);

// ── COST, STATED AGAINST THE THING IT REPLACED ──────────────────────────────
// three.js's webgpu_compute_birds runs 8192 birds each reading all 8192 others
// inside computeVelocity — 67 million neighbour interactions every frame, plus
// two compute pipelines. This has none.
{
  const g = flock.mesh.geometry;
  check("no compute pass, no storage buffers", !flock.compute && !flock.storage,
    "closed form in the vertex stage");
  check("the geometry is instanced, not one mesh a bird",
    g.isInstancedBufferGeometry === true && g.instanceCount === BIRD_DEFAULTS.count,
    `instanceCount ${g.instanceCount}`);
  // Per-instance data is 8 floats. Anything per-VERTEX per-bird would mean the
  // shape had been duplicated instead of instanced.
  const perInstance = ["aFlock", "aBird"]
    .reduce((a, k) => a + g.getAttribute(k).itemSize, 0);
  check("eight floats of state a bird, and no more", perInstance === 8, `${perInstance}`);
}

// ── IT MUST ACTUALLY COMPILE ────────────────────────────────────────────────
// positionNode with instanced attributes, a nested Fn called twice, and a
// cross product — all of it generates WGSL or none of it does, and finding out
// in the browser costs a round trip.
{
  let b = null, err = null;
  try { b = buildWGSL(flock.mesh.material, { instanced: flock.mesh }); } catch (e) { err = e; }
  check("the bird material generates WGSL", err === null, err ? err.message : "");
  if (b) {
    const vert = b.vertexShader || "";
    const frag = b.fragmentShader || "";
    const LF = String.fromCharCode(10);
    console.log(`       ${(vert.length / 1024).toFixed(1)} kB vertex · ${(frag.length / 1024).toFixed(1)} kB fragment`);
    check("no 'undefined' leaked into the generated WGSL",
      !/\bundefined\b/.test(vert) && !/\bundefined\b/.test(frag),
      (vert.match(/.{0,50}undefined.{0,50}/) || [""])[0]);
    check("no NaN literals", !/\bNaN\b/.test(vert) && !/\bNaN\b/.test(frag));
    // The flight path is evaluated TWICE — once at t, once a moment later, to
    // get a heading. If that ever collapsed to one evaluation the birds would
    // still fly and would all face the same way forever.
    check("the flight path is evaluated twice, for the heading",
      (vert.match(/aFlock/g) || []).length >= 2, "two samples of the path");
    check("the whole thing is a vertex-stage job",
      vert.length > frag.length, `${vert.length} vs ${frag.length} bytes`);
  }
}

// ── THE SUB-PIXEL FLOOR ─────────────────────────────────────────────────────
// A three-triangle bird 200 m out is smaller than a pixel, and a sub-pixel
// triangle crawls and sparkles rather than fading. `setViewport` feeds the
// shader the real pixels-per-metre so the floor tracks resizes and FOV changes
// instead of being a constant that silently stops being right.
{
  check("there is a pixel floor at all", BIRD_DEFAULTS.minPixels >= 1.5,
    `${BIRD_DEFAULTS.minPixels} px`);
  let threw = null;
  try { flock.setViewport(1080, 60); flock.setViewport(0, 0); } catch (e) { threw = e; }
  check("setViewport survives a degenerate viewport", threw === null,
    threw ? threw.message : "0 x 0 and a 0 degree FOV");

  // The arithmetic the shader does, checked here where it can be read:
  // pixelsPerMetre(d) = height / (2 tan(fovY/2)) / d.
  const px = (h, fov, d) => h / (2 * Math.tan((fov * Math.PI) / 360)) / d;
  const size = BIRD_DEFAULTS.size;
  // The floor must NOT bite up close, or every near bird is the same size and
  // the flock loses its depth.
  check("a near bird is drawn at its real size",
    px(1080, 60, 120) * size > BIRD_DEFAULTS.minPixels,
    `${(px(1080, 60, 120) * size).toFixed(2)} px at 120 m`);
  // And it MUST bite by the far edge of the flocks' own spread, which is where
  // most of them are: 1.5 m at 900 m is well under two pixels.
  check("and the far edge of the spread is where the floor takes over",
    px(1080, 60, BIRD_DEFAULTS.spreadMax) * size < BIRD_DEFAULTS.minPixels,
    `${(px(1080, 60, BIRD_DEFAULTS.spreadMax) * size).toFixed(2)} px at ${BIRD_DEFAULTS.spreadMax} m`);
}

// ── THE CPU DOES NOT KNOW WHERE THEY ARE ────────────────────────────────────
// Every position comes out of the vertex stage, so the bounding sphere is a
// promise rather than a measurement — and if it is too small, or culling is on,
// the flock disappears when the camera turns.
{
  const B = BIRD_DEFAULTS;
  const s = flock.mesh.geometry.boundingSphere;
  const reach = B.spreadMax + B.wander + B.orbitMax;
  check("frustum culling is off", flock.mesh.frustumCulled === false);
  check("the bounding sphere contains every place a bird can be",
    s && s.radius >= reach, `radius ${s?.radius} vs reach ${reach}`);
  check("birds cast no shadows", flock.mesh.castShadow === false,
    "a 3-triangle shadow at 150 m is a shadow pass for nothing");
}

// ── FLOCKS, NOT A CLOUD OF SINGLES ──────────────────────────────────────────
// Every bird in a flock must share a centre EXACTLY, or the group reads as
// scattered individuals that happen to be nearby — which is the one thing a
// flock must not look like.
{
  const g = flock.mesh.geometry.getAttribute("aFlock");
  const centres = new Map();
  for (let i = 0; i < g.count; i++) {
    const key = `${g.getX(i)},${g.getY(i)},${g.getZ(i)}`;
    centres.set(key, (centres.get(key) ?? 0) + 1);
  }
  check("there are exactly as many centres as flocks",
    centres.size === BIRD_DEFAULTS.flocks, `${centres.size} distinct centres`);
  const counts = [...centres.values()];
  check("and the birds are shared out evenly",
    Math.max(...counts) - Math.min(...counts) <= 1, counts.join("/"));
  // Some flocks must wheel the other way, or the sky is a mechanism.
  const spin = flock.mesh.geometry.getAttribute("aBird");
  let cw = 0, ccw = 0;
  for (let i = 0; i < spin.count; i++) (spin.getZ(i) < 0 ? cw++ : ccw++);
  check("they do not all wheel the same way", cw > 0 && ccw > 0, `${cw} vs ${ccw}`);
}

flock.dispose();
console.log(`\n${fail === 0 ? "ALL PASS" : `${fail} FAILURE(S)`}  (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
