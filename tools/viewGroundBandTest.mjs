// v3/render/viewGroundBand.js is the single answer to "how far away is the
// ground I can see" — the grass tile, the foliage LOD steps and the sun's
// shadow frustum all read it, so it is worth pinning down.
import * as THREE from "three";
import { groundBand, groundPatch } from "../v3/render/viewGroundBand.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

/** A camera `height` above the origin, pitched `pitchDeg` below horizontal. */
function cam({ height = 30, pitchDeg = 40, fov = 60, aspect = 16 / 9 } = {}) {
  const c = new THREE.PerspectiveCamera(fov, aspect, 0.5, 4000);
  const p = THREE.MathUtils.degToRad(pitchDeg);
  c.position.set(0, height, 0);
  // Look along +Z... at `pitch` below the horizon.
  c.lookAt(new THREE.Vector3(0, height - Math.sin(p), Math.cos(p)));
  c.updateMatrixWorld(true);
  return c;
}

// ── The band matches the closed form h / tan(pitch ± halfFov) ───────────────
{
  const h = 30, pitchDeg = 40, fov = 60;
  const c = cam({ height: h, pitchDeg, fov });
  const b = groundBand(c, 0);
  const p = THREE.MathUtils.degToRad(pitchDeg);
  const hv = THREE.MathUtils.degToRad(fov) / 2;
  check("near edge = h / tan(pitch + halfFov)", near(b.near, h / Math.tan(p + hv), 0.05),
        `${b.near.toFixed(2)} vs ${(h / Math.tan(p + hv)).toFixed(2)}`);
  check("far edge = h / tan(pitch - halfFov)", near(b.far, h / Math.tan(p - hv), 0.5),
        `${b.far.toFixed(2)} vs ${(h / Math.tan(p - hv)).toFixed(2)}`);
  check("near is closer than far", b.near < b.far);
}

// ── Steeper pitch sees LESS ground; shallower sees more ────────────────────
{
  const steep = groundBand(cam({ pitchDeg: 58 }), 0);
  const shallow = groundBand(cam({ pitchDeg: 32 }), 0);
  check("a steeper camera sees a shorter band", steep.far < shallow.far,
        `${steep.far.toFixed(0)} < ${shallow.far.toFixed(0)}`);
}

// ── Looking at/above the horizon must not return the far plane ─────────────
{
  const b = groundBand(cam({ pitchDeg: 20, fov: 60 }), 0);   // pitch < halfFov
  check("a horizon view falls back to a multiple of near, not camera.far",
        Number.isFinite(b.far) && b.far < 4000 && b.far > b.near, b.far.toFixed(1));
}

// ── The patch CONTAINS the visible trapezoid ────────────────────────────────
{
  const c = cam({ height: 32, pitchDeg: 38 });
  const b = groundBand(c, 0);
  const p = groundPatch(c, 0);
  // Project the four ground corners and check each is inside the circle.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
  const len = Math.hypot(fwd.x, fwd.z);
  const ux = fwd.x / len, uz = fwd.z / len;
  const rx = -uz, rz = ux;                      // right, on the ground plane
  let worst = 0;
  for (const [d, hw] of [[b.near, Math.hypot(b.near, b.height) * b.tanHalfH],
                         [b.far, Math.hypot(b.far, b.height) * b.tanHalfH]]) {
    for (const s of [-1, 1]) {
      const x = c.position.x + ux * d + rx * hw * s;
      const z = c.position.z + uz * d + rz * hw * s;
      worst = Math.max(worst, Math.hypot(x - p.cx, z - p.cz));
    }
  }
  check("every visible ground corner is inside the patch", worst <= p.radius + 1e-6,
        `worst ${worst.toFixed(2)} vs radius ${p.radius.toFixed(2)}`);
  check("the patch is not absurdly loose", worst > p.radius * 0.6,
        `worst ${worst.toFixed(2)} of ${p.radius.toFixed(2)}`);
}

// ── A wider screen needs a wider patch ─────────────────────────────────────
{
  const wide = groundPatch(cam({ aspect: 21 / 9 }), 0);
  const square = groundPatch(cam({ aspect: 1 }), 0);
  check("a wider aspect gives a bigger patch", wide.radius > square.radius,
        `${wide.radius.toFixed(0)} > ${square.radius.toFixed(0)}`);
}

// ── The patch tracks the camera, not the origin ────────────────────────────
{
  const c = cam();
  c.position.x += 500; c.position.z -= 300;
  c.updateMatrixWorld(true);
  const p = groundPatch(c, 0);
  check("the patch follows the camera in world space",
        Math.abs(p.cx - 500) < 200 && Math.abs(p.cz + 300) < 300,
        `(${p.cx.toFixed(0)}, ${p.cz.toFixed(0)})`);
}

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
