// Scorched-earth crater decals — GAME code.
//
// When a unit or structure is destroyed, a terrain-conforming decal is stamped at
// the wreck site, hugging slopes instead of floating.
//
// Every crater in the game is ONE instanced draw. Previously each crater built its
// own subdivided PlaneGeometry and lifted all 841 vertices to the terrain with CPU
// getWorldHeight() calls — so a stamp cost an 841-sample hitch plus a permanent
// draw call (two, actually: DoubleSide + transparent renders in two passes), up to
// 96 craters late game. Now they share one geometry and one instance buffer, and
// the draping happens in the vertex shader against the live heightmap
// (see terrainDrape.js). A stamp writes 4 floats; the whole field is 1 draw.
//
// crater-decal.png ships as RGB with a black surround; alpha comes from its
// brightness so the soft feathered edges blend into grass — in the SHADER.
// (It used to be derived on the CPU at load: a canvas readback and a loop over
// every pixel of a ~1400² image, ~0.9 s of main thread at every boot.)
import * as THREE from "three";
import { Fn, attribute, texture, uv, positionLocal, positionWorld, sin, cos, max, pow, smoothstep, float, vec3, uniform, length, atan, exp, mix, normalize, clamp, select, mx_noise_float } from "three/tsl";
import { drapedPosition } from "./terrainDrape.js";
import { RENDER_ORDER } from "./renderOrder.js";

const TEXTURE_URL = "/textures/crater-decal.png";
const MAX_CRATERS = 96;
const SUBDIV = 28;
const HEIGHT_OFFSET = 0.15;
const DECAL_RENDER_ORDER = RENDER_ORDER.CRATERS;

/**
 * THE PROCEDURAL LOOK (alg-rts, 2026-10-07 — "the battle leaves marks"): the texture decal is
 * unlit, so it read as a flat black blot whatever the sun did. This one is a shell hole drawn
 * from its PROFILE — a bowl (r < 0.48 of the decal) with a raised rim (0.56) — and it does not
 * paint a colour: it MULTIPLIES the ground under it (the ground's own photo shows through, so it
 * has the ground's grain; a painted colour read as smooth plastic beside the photo). Per pixel,
 * the ground is darkened or lightened by
 *   · its EARTH: fresh dark earth in the bowl, a scorched pit, pale dug earth on the rim, a blast
 *     ring scorched round it with darker rays, pale clods thrown out — noise breaks every edge,
 *     each crater's own (its rotation seeds the noise);
 *   · its LIGHT: the profile's slope bends the normal, and the sun on that normal over the sun
 *     on flat ground shades the near wall and lights the far one (`sunDir`, set every frame).
 * Still one instanced draw.
 */
function proceduralCraterMaterial(sunDir) {
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthTest: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    // dst × src: what the shader outputs is a factor on the ground already drawn.
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.forceSinglePass = true;
  mat.fog = false;   // a factor, not a colour: fog would tint it
  const a = attribute("aCrater", "vec4");
  const d = positionWorld.xz.sub(a.xy).div(a.z);   // decal radii from the centre, world axes
  const r = length(d);
  const ang = atan(d.y, d.x);
  const clod = mx_noise_float(vec3(positionWorld.x.mul(1.1), a.w.mul(7.3), positionWorld.z.mul(1.1)));     // ~1 m lumps
  const grain = mx_noise_float(vec3(positionWorld.x.mul(5.0), a.w, positionWorld.z.mul(5.0)));            // ~20 cm
  const streakN = mx_noise_float(vec3(cos(ang).mul(3.2), sin(ang).mul(3.2), a.w.mul(3.1)));               // rays
  const rr = r.add(streakN.mul(0.09)).add(clod.mul(0.05));   // a ragged rim, not a circle
  // The profile's slope dh/dr (height and r both in decal radii) → the normal.
  const B = 0.48, RIM = 0.56, W = 0.09, DEPTH = 0.32, RH = 0.1;
  const sBowl = select(rr.lessThan(B), rr.mul(2 * DEPTH / (B * B)), float(0));
  const g = exp(rr.sub(RIM).div(W).pow(2).negate());
  const sRim = g.mul(rr.sub(RIM).mul(-2 * RH / (W * W)));
  const slope = sBowl.add(sRim);
  const dir = d.div(max(r, float(1e-3)));
  const n = normalize(vec3(slope.mul(dir.x).negate(), float(1), slope.mul(dir.y).negate()));
  // The sun on this normal over the sun on flat ground; part of the light is the sky's (unchanged).
  const L = sunDir;
  const rel = clamp(n.dot(L), 0.05, 2).div(max(L.y, float(0.25)));
  const shade = mix(float(1), clamp(rel, 0.1, 2.0), 0.9);
  // The earth, as a factor on the ground's colour.
  const inBowl = float(1).sub(smoothstep(B - 0.1, B + 0.02, rr));
  const pit = clamp(float(1).sub(smoothstep(0.04, 0.32, rr)).mul(clod.mul(0.3).add(0.8)), 0, 1);
  const streak = smoothstep(0.05, 0.55, streakN);
  const rimF = mix(float(1.3), float(1.0), clamp(clod.add(0.3), 0, 1));
  const inside = mix(mix(rimF, float(0.5), inBowl), float(0.14), pit);
  const blast = float(1).sub(smoothstep(RIM, 0.85, r)).mul(0.6).add(streak.mul(0.35));
  const clods = smoothstep(0.18, 0.32, clod).mul(float(1).sub(smoothstep(RIM + 0.05, 0.9, r)));
  const outside = mix(float(1).sub(clamp(blast, 0, 0.75)), float(1.2), clods);
  const innerA = float(1).sub(smoothstep(RIM + 0.02, RIM + 0.1, rr.add(clod.mul(0.04))));
  const earth = mix(outside, inside, innerA).mul(grain.mul(0.16).add(1));
  // The shading only where the ground is shaped (the bowl and the rim), not on the flat ring.
  const f = earth.mul(mix(float(1), shade, max(innerA, g)));
  // Its reach: the bowl and rim whole, the ring fading to the decal's edge.
  const ejA = float(1).sub(smoothstep(RIM + 0.04, 1.0, r.add(clod.mul(0.1)))).pow(0.8);
  const alpha = max(innerA, ejA);
  mat.colorNode = vec3(mix(float(1), f, alpha));
  return mat;
}

async function loadCraterTexture(url) {
  const tex = await new THREE.TextureLoader().loadAsync(url);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * @param {object} o
 * @param {object} o.app
 * @param {"texture"|"procedural"} [o.look]  "procedural": lit, profiled shell holes (above)
 * @param {number} [o.max]  craters kept (the oldest overwritten)
 */
export async function createCraterSystem({ app, look = "texture", max: maxCraters = MAX_CRATERS }) {
  const { scene, heightTexNode } = app;
  const MAX = maxCraters;
  const sunDir = uniform(new THREE.Vector3(0.4, 0.8, 0.4).normalize());
  if (look === "procedural") return assemble(proceduralCraterMaterial(sunDir), null);

  const tex = await loadCraterTexture(TEXTURE_URL);
  const texNode = texture(tex, uv());
  // Black surround → transparent, crater interior opaque (luminance-as-alpha
  // made dark soil invisible): the brightest channel, back in sRGB 0..1 (the
  // sampler hands us linear), smoothstepped 6/255 → 40/255 — the same rule
  // the CPU loop applied to the 8-bit sRGB bytes.
  const craterAlpha = smoothstep(
    float(6 / 255), float(40 / 255),
    pow(max(max(texNode.r, texNode.g), texNode.b), float(1 / 2.2)),
  );
  // depthTest ON so units and structures standing on a crater properly occlude it.
  // (It used to be off — a decal painted over the wreck sitting in it. That was safe
  // only because a CPU-conformed mesh could drift off the surface and z-fight; the
  // vertex-shader draping now tracks the ground exactly, so depth testing behaves.)
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // DoubleSide + transparent is drawn twice (back faces, then front) so overlapping
  // surfaces sort correctly. A flat decal on the ground never overlaps itself, so
  // that pass buys nothing — and the old per-crater meshes each paid for it.
  mat.forceSinglePass = true;
  mat.colorNode = texNode.rgb;
  mat.opacityNode = craterAlpha;
  return assemble(mat, tex);

  function assemble(mat, tex) {

  // One subdivided plane, shared by every crater. Subdivision is what lets the
  // decal bend over slopes; the vertex shader does the bending.
  const src = new THREE.PlaneGeometry(1, 1, SUBDIV, SUBDIV).rotateX(-Math.PI / 2);

  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute("position", src.attributes.position);
  geo.setAttribute("uv", src.attributes.uv); // the decal texture rides on these

  // x, z, radius, rotation — one vec4 per crater.
  const craterAttr = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4);
  craterAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aCrater", craterAttr);
  geo.instanceCount = 0;

  // The mesh sits at the origin with an identity transform, so the world position
  // we build here IS the local position three expects back.
  const craterVertex = Fn(() => {
    const aCrater = attribute("aCrater", "vec4");
    const s = sin(aCrater.w);
    const c = cos(aCrater.w);

    // PlaneGeometry(1,1) spans -0.5..0.5, so scaling by radius*2 gives a decal of
    // `radius` half-width — matching the old mesh's scale.
    const lx = positionLocal.x.mul(aCrater.z.mul(2));
    const lz = positionLocal.z.mul(aCrater.z.mul(2));
    // Y rotation, same as the old mesh's rotation.y (random per crater).
    const wx = lx.mul(c).add(lz.mul(s)).add(aCrater.x);
    const wz = lz.mul(c).sub(lx.mul(s)).add(aCrater.y);

    return drapedPosition(heightTexNode, wx, wz, HEIGHT_OFFSET);
  });
  mat.positionNode = craterVertex();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = DECAL_RENDER_ORDER;
  mesh.frustumCulled = false; // instances live anywhere; the bounds are meaningless
  mesh.visible = false;       // nothing to draw until the first crater is stamped
  // The procedural look shades by the sun: its direction, every frame it is drawn.
  if (look === "procedural") mesh.onBeforeRender = () => { const v = app.light?.getDirection?.(); if (v) sunDir.value.copy(v).normalize(); };

  const group = new THREE.Group();
  group.name = "RtsCraters";
  group.add(mesh);
  scene.add(group);

  let count = 0;  // craters stamped so far, capped at MAX
  let cursor = 0; // ring-buffer write slot — oldest crater is the one overwritten

  /** Stamp a scorched crater centred at world X/Z. Radius is the decal radius in metres. */
  function addCrater(x, z, radius = 4) {
    craterAttr.setXYZW(cursor, x, z, radius, Math.random() * Math.PI * 2);
    craterAttr.needsUpdate = true;

    cursor = (cursor + 1) % MAX;
    count = Math.min(count + 1, MAX);
    geo.instanceCount = count;
    mesh.visible = true;
  }

  function dispose() {
    scene.remove(group);
    geo.dispose();
    src.dispose();
    mat.dispose();
    tex?.dispose();
  }

  return { addCrater, dispose, group, get count() { return count; } };
  }
}
