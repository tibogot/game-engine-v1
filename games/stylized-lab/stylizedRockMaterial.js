// THE GENSHIN-STYLE ROCK MATERIAL — for the cliff blocks (genshinKit.js).
//
// 2026-10-09, you: "the slope mountain texture should really blend perfectly
// with the rocks texture". So the blocks no longer have a look of their own:
// they run the TERRAIN'S paint-layer maths (v3/terrain/splatOverlayTsl.js) on
// the SAME layer the steep ground uses (tools/stylizedLabLevel.mjs "Rock":
// cliff_stylized, de-tiled, tint, normal / AO strength):
//   - triplanar weights |n|^4 normalised; projections top = P.xz, X-facing
//     wall = P.zy, Z-facing wall = P.xy, all at P * uvScale / worldSize — in
//     WORLD space, so the stone's pattern runs on across the block / slope edge
//   - albedo x tint, x mix(1, ao, aoStr)
//   - the normal map decoded like the terrain's and applied in its frame:
//     normalize((nx, 0, ny) + N * nz), then mix(N, that, normalStr)
//   - roughness mix(0.88, rough, 1)
// On top, only what makes a block read as a block: a little light on convex
// edges and a little dark in the crevasses (the generator's baked `rockShade`),
// and moss / grass colour on what faces up — read from a SMOOTHED normal
// (`nSmooth`, before the creases are split), else the rim's alternating facets
// flip between green and grey: the saw-tooth along the cliff tops.
// Every knob is a uniform in `material.userData.rock`.
import * as THREE from "three";
import {
  abs, attribute, cross, float, max, mix, mx_noise_float, normalGeometry, normalize, positionWorld,
  pow, smoothstep, sqrt, texture, transformNormalToView, uniform, vec2, vec3, vec4,
} from "three/tsl";

export const ROCK_LOOK_DEFAULTS = {
  tex: "cliff_stylized",
  worldSize: 512,
  uvScale: 21,             // = the terrain layer's uvScale (W / 24)
  tint: "#f0f0f2",         // = the terrain layer's tint
  normalStr: 1.2,          // = the terrain layer's normalStr
  aoStr: 0.4,              // = the terrain layer's aoStr
  edgeLo: 0.01, edgeHi: 0.06, edgeBright: 0.1,
  creaseDark: 0.3,
  moss: "#5a9a30", mossDark: "#3e7a26",   // the revo grass root / mid colours
  mossStart: 0.8, mossFull: 0.9, mossNoise: 0.22, mossScale: 0.15,
  ground: "#4f8a2c",       // the meadow paint: the foot fades into it
  groundSteep: null,       // null = the stone itself (the steep ground IS this stone now)
  contact: 1.0, contactDark: 0.45,
};

const TEX = (id, m) => `/textures/ground/${id}/${id}_${m}_1k.jpg`;
function photo(url, srgb) {
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** v rotated by quaternion q (vec4). */
const qrot = (q, v) => v.add(cross(q.xyz, cross(q.xyz, v).add(v.mul(q.w))).mul(2));

/**
 * @param {object} [overrides]  ROCK_LOOK_DEFAULTS keys, plus optionally
 *   `terrain: { heightTexNode, worldSize, maxHeight }` for the ground contact band.
 */
export function createStylizedRockMaterial({ terrain = null, ...overrides } = {}) {
  const P = { ...ROCK_LOOK_DEFAULTS, ...overrides };
  const u = {
    tint: uniform(new THREE.Color(P.tint)), uvScale: uniform(P.uvScale), invWS: uniform(1 / P.worldSize),
    normalStr: uniform(P.normalStr), aoStr: uniform(P.aoStr),
    edgeLo: uniform(P.edgeLo), edgeHi: uniform(P.edgeHi), edgeBright: uniform(P.edgeBright), creaseDark: uniform(P.creaseDark),
    moss: uniform(new THREE.Color(P.moss)), mossDark: uniform(new THREE.Color(P.mossDark)),
    mossStart: uniform(P.mossStart), mossFull: uniform(P.mossFull), mossNoise: uniform(P.mossNoise), mossScale: uniform(P.mossScale),
    mossOn: uniform(1),
    ground: uniform(new THREE.Color(P.ground)), contact: uniform(P.contact), contactDark: uniform(P.contactDark),
  };
  const diff = photo(TEX(P.tex, "diff"), true), nor = photo(TEX(P.tex, "nor_gl")), rough = photo(TEX(P.tex, "rough")), ao = photo(TEX(P.tex, "ao"));

  // World space: the cliff meshes are merged in world space (identity model matrix).
  const Pw = positionWorld;
  const N = normalize(normalGeometry);
  const nAbs = abs(N);
  const n4 = vec3(pow(nAbs.x, float(4)), pow(nAbs.y, float(4)), pow(nAbs.z, float(4)));
  const triW = n4.div(max(n4.x.add(n4.y).add(n4.z), float(1e-5)));
  const p = Pw.mul(u.invWS).mul(u.uvScale);
  const tri = (tex) => texture(tex, p.xz).mul(triW.y).add(texture(tex, p.zy).mul(triW.x)).add(texture(tex, p.xy).mul(triW.z));

  const albedo = tri(diff).rgb.mul(u.tint);
  const aoV = tri(ao).r;
  const roughV = mix(float(0.88), tri(rough).r, float(1));
  const nrmS = tri(nor);
  const nx = nrmS.r.mul(2).sub(1), ny = nrmS.g.mul(2).sub(1);
  const nz = sqrt(max(float(0), float(1).sub(nx.mul(nx)).sub(ny.mul(ny))));
  const mapped = normalize(vec3(nx, float(0), ny).add(N.mul(nz)));
  const nOut = normalize(mix(N, mapped, u.normalStr));

  // the block's own definition: worn edges, crevasses
  const shade = attribute("rockShade", "vec2");
  const edge = smoothstep(u.edgeLo, u.edgeHi, shade.x);
  const crease = smoothstep(float(0), float(0.08), shade.x.negate());
  const stone = albedo.mul(mix(float(1), aoV, u.aoStr))
    .mul(float(1).add(edge.mul(u.edgeBright)))
    .mul(float(1).sub(crease.mul(u.creaseDark)));

  // moss / grass on what faces up — from the SMOOTHED normal, turned with the piece
  const q = attribute("rockQuat", "vec4");
  const nUp = normalize(qrot(q, attribute("nSmooth", "vec3"))).y;
  const mn = mx_noise_float(Pw.mul(u.mossScale)).mul(u.mossNoise);
  const top = smoothstep(u.mossStart, u.mossFull, nUp.add(mn)).mul(u.mossOn);
  const mossCol = mix(u.mossDark, u.moss, smoothstep(float(0.4), float(1), top));
  let col = mix(stone, vec3(mossCol), top);

  if (terrain?.heightTexNode) {
    // Ground contact: the foot darkens into the meadow over the last metre —
    // only where the ground there is gentle (on the steep ground the stone
    // simply continues into the terrain's own stone).
    const uWS = uniform(terrain.worldSize), uMH = uniform(terrain.maxHeight);
    const hAt = (o) => texture(terrain.heightTexNode, Pw.xz.add(o).div(uWS).add(0.5)).r.mul(uMH);
    const groundY = hAt(vec2(0, 0));
    const grad = vec2(hAt(vec2(1.5, 0)).sub(groundY), hAt(vec2(0, 1.5)).sub(groundY)).length().div(1.5);
    const gentle = float(1).sub(smoothstep(float(0.75), float(1.05), grad));
    const above = Pw.y.sub(groundY).add(mx_noise_float(Pw.mul(0.6)).mul(0.35));
    const c = float(1).sub(smoothstep(float(0), u.contact.max(1e-3), above)).mul(gentle);
    const foot = u.ground.mul(float(1).sub(u.contactDark));
    col = mix(col, mix(foot, u.ground, smoothstep(float(0.2), float(1), c.oneMinus()).mul(0.6)), c.mul(0.85));
  }

  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  mat.name = "GenshinRock";
  mat.colorNode = vec4(col, 1).rgb;
  mat.roughnessNode = roughV;
  // normalNode is VIEW space (three r184); the meshes are world space.
  mat.normalNode = transformNormalToView(nOut).normalize();
  mat.userData.rock = u;
  return mat;
}
