/**
 * TSL foliage material for v2 — sphere normals, wind, SSS, rim, AO.
 * One material per tree preset (each has its own leaf texture + colors).
 */
import * as THREE from "three";
import {
  Fn, float, int, vec2, vec3, vec4,
  uniform, uniformArray, attribute,
  texture, uv,
  mix, step, smoothstep, clamp, fract, floor,
  sin, cos, abs, max, pow, dot, cross, normalize, length, sub, negate,
  mx_noise_float,
  positionLocal, positionWorld,
  normalLocal, normalWorld,
  cameraPosition, modelWorldMatrix,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three";

export function createFoliageMaterial(opts = {}) {
  const u = {
    time:         uniform(0.0),
    yMin:         uniform(opts.yMin ?? 0.0),
    yMax:         uniform(opts.yMax ?? 8.0),
    bottomColor:  uniform(new THREE.Color(opts.bottomColor ?? "#2d5a1b")),
    topColor:     uniform(new THREE.Color(opts.topColor ?? "#5aaa2a")),
    colorVar:     uniform(opts.colorVar ?? 0.12),
    alphaCutoff:  uniform(opts.alphaCutoff ?? 0.45),
    sssColor:     uniform(new THREE.Color(opts.sssColor ?? "#c8e070")),
    sssStr:       uniform(opts.sssStr ?? 0.0),
    sssPow:       uniform(opts.sssPow ?? 2.0),
    rimColor:     uniform(new THREE.Color(opts.rimColor ?? "#c8ffaa")),
    rimStr:       uniform(opts.rimStr ?? 0.07),
    rimPow:       uniform(opts.rimPow ?? 2.5),
    aoStr:        uniform(opts.aoStr ?? 0.70),
    sunDir:       uniform(new THREE.Vector3(5, 12, 4).normalize()),
    windSpeed:    uniform(opts.windSpeed ?? 0.9),
    windStr:      uniform(opts.windStr ?? 0.0),
    windMicro:    uniform(opts.windMicro ?? 0.0),
    canopyCenter: uniform(new THREE.Vector3(0, 4, 0)),
    aoRadius:     uniform(opts.aoRadius ?? 6.0),
    normalBias:   uniform(opts.normalBias ?? 1.0),
    leafWarp:     uniform(opts.leafWarp ?? 0.28),
    treeColorVar: uniform(opts.treeColorVar ?? 0.0),
    // 0 -> sample mask from .r (grayscale/RGB PNGs), 1 -> .a (RGBA PNGs).
    // setFoliageTexture() auto-detects and writes this on load.
    maskInAlpha:  uniform(0.0),
    // Billboard mode: 0 = use baked per-leaf rotation/scale (instance matrix),
    // 1 = camera-facing quad with size driven by aLeafScale.
    // Must match how the renderer composed the instance matrices for this preset.
    billboard:    uniform(opts.billboard ? 1.0 : 0.0),
    billboardYaw: uniform(opts.billboardYawOnly === false ? 0.0 : 1.0),
    // Shared leaf-mask atlas: remap the leaf quad's uv into one cell. Math is
    // byte-identical to arborist's (uUseAtlas / uAtlasGrid). Each v2 slot has ONE
    // cell, so the cell index is a uniform here (arborist uses a per-instance
    // attribute, but fills it with one constant per tree — same UV result).
    useAtlas:     uniform(opts.useAtlas ? 1.0 : 0.0),
    // (cols, cellStep = cellPx/size, gutterFrac = gutter/size, innerFrac = inner/size)
    atlasGrid:    uniform(new THREE.Vector4(
                    opts.atlasGrid?.[0] ?? 4,
                    opts.atlasGrid?.[1] ?? 0.25,
                    opts.atlasGrid?.[2] ?? 12 / 1024,
                    opts.atlasGrid?.[3] ?? 232 / 1024,
                  )),
    atlasCell:    uniform(opts.atlasCell ?? 0),
    // Pine-editor leaf atlas — a DIFFERENT convention from the arborist one
    // above: cols×rows (not square), no gutters, and cell 0 is the BOTTOM-left
    // (V origin), not the top-left. Rather than bend one into the other, pine
    // presets take their own branch. The cell is picked per card, so a single
    // tree shows every needle variant on the sheet.
    pineAtlas:     uniform(opts.pineAtlas ? 1.0 : 0.0),
    pineAtlasCols: uniform(opts.pineAtlasCols ?? 2),
    pineAtlasRows: uniform(opts.pineAtlasRows ?? 2),
    // Pine-editor shading model (pine-editor33): per-CARD bottom→top gradient
    // (uv.y, not tree height), trunk-radial normals/SSS/rim, hook-side pivot
    // AO and vein stripes. pineMode=0 leaves the arborist model untouched.
    pineMode:     uniform(opts.pineLayout ? 1.0 : 0.0),
    radialUp:     uniform(opts.radialUp ?? 0.35),
    pivotAo:      uniform(opts.pivotAo ?? 0.35),
    veinStrength: uniform(opts.veinStrength ?? 0.1),
  };

  // Per-slot parameter accessor: for a classic (one-preset) material every
  // entry is simply the slot's own uniform. createMergedFoliageMaterial()
  // builds the same node graph with these backed by uniform-array elements
  // indexed by a per-instance slot id instead.
  const P = {
    bottomColor: u.bottomColor, topColor: u.topColor,
    colorVar: u.colorVar, treeColorVar: u.treeColorVar,
    alphaCutoff: u.alphaCutoff,
    sssColor: u.sssColor, sssStr: u.sssStr, sssPow: u.sssPow,
    rimColor: u.rimColor, rimStr: u.rimStr, rimPow: u.rimPow,
    aoStr: u.aoStr, aoRadius: u.aoRadius,
    normalBias: u.normalBias, leafWarp: u.leafWarp,
    windSpeed: u.windSpeed, windStr: u.windStr, windMicro: u.windMicro,
    atlasCell: u.atlasCell, billboardYaw: u.billboardYaw,
  };
  return _buildFoliageMaterial(u, P, opts);
}

/**
 * Shared node-graph builder. `u` carries the global uniforms (time, sunDir,
 * billboard/atlas mode flags); `P` maps every per-slot parameter to a node —
 * plain uniforms for the classic material, uniform-array elements for the
 * merged one. `opts.merged` widens aLeafScale to vec3 (z = slot id).
 *
 * `opts.data` (optional) replaces the per-instance vertex attributes with
 * injected nodes — the GPU leaf field feeds the same graph from a compute-
 * written storage buffer: { rand: vec2, leafCenterW: vec3, treeCenterW: vec3,
 * leafSize: float, heightFrac: float, cardQuat?: vec4 } (world-space centers,
 * no model matrix). When `cardQuat` is present the card is ORIENTED: the
 * non-billboard path rotates card verts/normals by the per-instance
 * quaternion instead of relying on an instance matrix (field pines).
 */
function _buildFoliageMaterial(u, P, opts) {
  const D = opts.data ?? null;
  // v' = v + 2·q.xyz × (q.xyz × v + q.w·v) — standard quaternion rotate.
  const qRot = (q, v) => {
    const t = cross(q.xyz, v).add(v.mul(q.w));
    return v.add(cross(q.xyz, t).mul(2.0));
  };
  const aRand = D?.rand ?? attribute("aRand", "vec2");

  const leafTex = new THREE.Texture();
  // Atlas cell-UV remap (identical math to arborist). useAtlas=0 leaves uv() as-is.
  const _baseUv = uv();
  const _agCols = u.atlasGrid.x;
  const _agRow = floor(P.atlasCell.div(_agCols));
  const _agCol = P.atlasCell.sub(_agRow.mul(_agCols));
  const _agOx = _agCol.mul(u.atlasGrid.y).add(u.atlasGrid.z);
  const _agOy = _agCols.sub(1).sub(_agRow).mul(u.atlasGrid.y).add(u.atlasGrid.z);
  const _cellUv = _baseUv.mul(u.atlasGrid.w).add(vec2(_agOx, _agOy));

  // Per-card pine variant. The editor keys this off instanceIndex, which we
  // cannot reuse: our LOD1/LOD2 tiers are a stride-2 SUBSET of LOD0, so a card's
  // index — and therefore its needle cell — would change as the tree crosses a
  // LOD distance, popping the texture. aRand is baked per card and copied into
  // every tier, so it is stable across LODs. Hash it first: aRand.x drives the
  // wind phase and aRand.y the colour variation, and using either raw would
  // visibly tie "which needle sprite" to "how this card sways/shades".
  const _pineHash = fract(sin(aRand.x.mul(127.1).add(aRand.y.mul(311.7))).mul(43758.5453));
  const _pineIdx = floor(_pineHash.mul(u.pineAtlasCols.mul(u.pineAtlasRows)));
  const _pineRow = floor(_pineIdx.div(u.pineAtlasCols));
  const _pineCol = _pineIdx.sub(_pineRow.mul(u.pineAtlasCols));
  const _pineInvC = float(1).div(u.pineAtlasCols);
  const _pineInvR = float(1).div(u.pineAtlasRows);
  const _pineUv = vec2(
    _baseUv.x.mul(_pineInvC).add(_pineCol.mul(_pineInvC)),
    _baseUv.y.mul(_pineInvR).add(_pineRow.mul(_pineInvR)),
  );

  const _sampleUv = mix(mix(_baseUv, _cellUv, u.useAtlas), _pineUv, u.pineAtlas);
  const leafMapNode = texture(leafTex, _sampleUv);
  // Selects mask channel based on the loaded texture's format.
  const leafMaskCh = mix(leafMapNode.r, leafMapNode.a, u.maskInAlpha);
  // Per-instance leaf center (world space — written by the chunked renderer).
  const instanceCenterW = D?.leafCenterW
    ?? modelWorldMatrix.mul(vec4(attribute("aLeafCenter", "vec3"), 1)).xyz;
  // Per-instance tree canopy center (world space). Every leaf of one tree
  // shares this value; trees in different world positions get different ones.
  // Replaces the old u.canopyCenter (which was trunk-local and shared across
  // every tree of the slot — wrong once trees are placed away from origin).
  const treeCenterW = D?.treeCenterW
    ?? modelWorldMatrix.mul(vec4(attribute("aTreeCenter", "vec3"), 1)).xyz;
  // Per-leaf size; only consulted in billboard mode (instance matrices are
  // pure translation there, so the size lives on the attribute instead).
  // x = per-leaf size (billboard mode); y = canopy height fraction (0=bottom,
  // 1=top), computed in trunk-LOCAL space by the renderer so it's correct for
  // trees placed at terrain height / any scale. Packed into ONE vec2 because
  // WebGPU caps vertex buffers at 8 and the foliage geometry is already at the
  // limit — a separate aHeightFactor attribute overflowed it (9 > 8).
  let aLeafSize, heightFactor;
  if (D) {
    aLeafSize = D.leafSize;
    heightFactor = D.heightFrac;
  } else {
    const aLeafScale = attribute("aLeafScale", opts.merged ? "vec3" : "vec2");
    aLeafSize = aLeafScale.x;
    heightFactor = aLeafScale.y;
  }

  const positionNode = Fn(() => {
    const phase     = aRand.x.mul(6.2832);
    const tipFactor = positionLocal.y.add(0.5);
    const sway      = sin(u.time.mul(P.windSpeed).add(phase)).mul(P.windStr).mul(tipFactor);
    const micro     = sin(u.time.mul(3.1).add(phase.mul(2.6))).mul(P.windMicro).mul(tipFactor);
    const swayZ     = cos(u.time.mul(P.windSpeed.mul(0.8)).add(phase.mul(1.3))).mul(P.windStr.mul(0.5)).mul(tipFactor);
    // World-space wind delta (must NOT be projected into the camera basis or
    // it appears to rotate with the view).
    const wo = vec3(sway.add(micro), float(0), swayZ);

    // Camera basis around the per-instance leaf world center.
    const pivotW = instanceCenterW;
    const toCam = normalize(sub(cameraPosition, pivotW));
    const horiz = vec3(toCam.x, float(0), toCam.z);
    const hLen = length(horiz);
    const useH = step(float(0.0001), hLen);
    const yawDir = normalize(
      normalize(horiz).mul(useH).add(vec3(0, 0, float(1)).mul(float(1).sub(useH)))
    );
    const face = normalize(mix(toCam, yawDir, P.billboardYaw));
    const worldUp = vec3(0, 1, 0);
    // NaN-safe basis: pick non-degenerate cross BEFORE normalizing.
    const cA = cross(worldUp, face);
    const cB = cross(vec3(-1, 0, 0), face);
    const right = normalize(mix(cA, cB, step(float(0.99), abs(face.y))));
    const upv = normalize(cross(face, right));
    // Per-leaf 2D rotation of the camera-aligned quad around the face axis.
    // Breaks the "all billboards point the same way" tell. Uses aRand.x —
    // matches arborist exactly so the same preset produces the same texture
    // orientations in both editors.
    const ang = aRand.x.mul(6.2831853);
    const cosA = cos(ang);
    const sinA = sin(ang);
    const rRight = right.mul(cosA).add(upv.mul(sinA));
    const rUp = upv.mul(cosA).sub(right.mul(sinA));

    // Camera-aligned card from positionLocal; size comes from aLeafScale.
    // MATRIX-LESS billboards: the chunked renderer draws billboard leaves as
    // plain Meshes with InstancedBufferGeometry (no 64-byte instanceMatrix per
    // leaf — the only data it carried was the translation, which aLeafCenter
    // already holds). The billboard branch therefore outputs the final
    // position itself: card offset + wind + per-instance world center.
    const bbQuad = rRight.mul(positionLocal.x.mul(aLeafSize))
      .add(rUp.mul(positionLocal.y.mul(aLeafSize)));
    // World-space wind, scaled with leaf size.
    const windWorld = wo.mul(aLeafSize);
    const bb3 = bbQuad.add(windWorld).add(instanceCenterW);

    // Non-billboard branch: instance matrices carry rotation/scale, so keep
    // the local-space path (wind added locally — existing v2 behavior).
    // Field-injected ORIENTED cards have no instance matrix — rotate by the
    // per-instance quaternion, scale, place at the world center instead
    // (wind applied world-space, scaled with the card).
    const nonBB = D?.cardQuat
      ? qRot(D.cardQuat, positionLocal.mul(aLeafSize))
          .add(instanceCenterW)
          .add(wo.mul(aLeafSize))
      : positionLocal.add(wo);
    return mix(nonBB, bb3, u.billboard);
  })();

  // Stylized foliage lighting: every leaf uses world-up as its normal so the
  // entire canopy lights as one uniform "puff." Per-leaf sphereDir variation
  // produces visible per-leaf shading noise that swings as the camera orbits.
  // Uniform world-up gives a stable, angle-independent appearance; shape
  // comes from AO and the height gradient.
  const sphereDir = vec3(0, 1, 0);
  // SSS uses the per-leaf outward direction (not the uniform sphereDir) so
  // backlit leaves on the anti-sun hemisphere still glow with the SSS color.
  // Kept separate so Lambert stays uniform but SSS gives the stylized highlight.
  const sphereDirForSSS = normalize(instanceCenterW.sub(treeCenterW));
  // Pine (pine-editor33) model: cards light by their trunk-radial outward
  // direction (radialUp tilts it skyward) instead of the canopy-sphere dir —
  // that's what makes a pine read as stacked fronds, not a leaf ball.
  const _pineRadial = instanceCenterW.sub(treeCenterW);
  const trunkRadialDir = normalize(vec3(_pineRadial.x, u.radialUp, _pineRadial.z));
  const litDir = normalize(mix(sphereDirForSSS, trunkRadialDir, u.pineMode));
  const normalTargetDir = normalize(mix(sphereDir, trunkRadialDir, u.pineMode));
  // Non-billboard normal: local quad normal warped by UV (gives leaves a fake
  // curvature). Oriented field cards rotate it by the card quaternion first
  // (matrix-less mesh — object space IS world space).
  const _geoNormal = D?.cardQuat ? qRot(D.cardQuat, normalLocal) : normalLocal;
  const warpedNormal = normalize(_geoNormal.add(sin(uv().x.mul(10)).mul(P.leafWarp)));
  // Billboard normal: camera-facing (or yaw-facing) direction at the leaf's pivot.
  // Without this branch, billboarded leaves render with the UV-stripe warp from
  // warpedNormal — that's where the vertical "banding" gradient on the canopy comes from.
  const leafBillboardFace = Fn(() => {
    const pivotW = instanceCenterW;
    const toCam = normalize(sub(cameraPosition, pivotW));
    const horiz = vec3(toCam.x, float(0), toCam.z);
    const hLen = length(horiz);
    const useH = step(float(0.0001), hLen);
    const yawDir = normalize(
      normalize(horiz).mul(useH).add(vec3(0, 0, float(1)).mul(float(1).sub(useH)))
    );
    return normalize(mix(toCam, yawDir, P.billboardYaw));
  })();
  const geomForMix  = normalize(mix(warpedNormal, leafBillboardFace, u.billboard));
  const finalNormal = normalize(mix(geomForMix, normalTargetDir, P.normalBias));

  const colorNode = Fn(() => {
    const h1 = aRand.x;
    const h2 = aRand.y;
    // Gradient axis: arborist runs bottom→top over the TREE's height
    // (heightFactor); pine runs it along each CARD's uv.y (hook→tip), which
    // is why identical colors read totally differently between the models.
    const colorT = mix(heightFactor, uv().y, u.pineMode);
    let col = mix(P.bottomColor, P.topColor, colorT);
    // Pine vein stripes across the card (editor: sin(u.x·π) darkening).
    const vein = sin(uv().x.mul(3.14159)).mul(0.5).add(0.5);
    col = col.mul(mix(float(1.0), float(1.0).sub(u.veinStrength.mul(u.pineMode)), vein));
    const varMul = h1.mul(P.colorVar.mul(2.0)).add(float(1.0).sub(P.colorVar));
    col = col.mul(varMul);
    const hueShift = h2.sub(0.5).mul(P.colorVar.mul(0.4));
    col = vec3(col.x.add(hueShift.mul(0.3)), col.y, col.z.sub(hueShift.mul(0.2)));

    // Per-tree seed from the per-instance world canopy center (treeCenterW), NOT
    // modelWorldMatrix * origin: in the chunked InstancedMesh every tree shares the
    // same model matrix (sits at world origin), so the old origin hash gave every
    // tree the SAME seed -> a uniform "clone-army" forest. aTreeCenter is distinct
    // per tree, so this restores real per-tree colour variation.
    //
    // Gradient noise, NOT fract(sin(x)*43758): that hash overflows f32 for
    // trees far from the origin AND is discontinuous — wind jiggles the
    // interpolated varying by ±1 ulp per frame, which the hash amplified into
    // full-canopy per-pixel shimmer ("white noise when wind is on"). mx_noise
    // is smooth, so ulp jitter maps to invisible output jitter, and it's
    // precision-safe at any world position.
    const treeSeed = mx_noise_float(vec3(
      treeCenterW.x.mul(0.031), treeCenterW.z.mul(0.031), float(7.7),
    )).mul(0.5).add(0.5);
    const treeBright = treeSeed.sub(0.5).mul(P.treeColorVar);
    const treeHue = mx_noise_float(vec3(
      treeCenterW.x.mul(0.047), treeCenterW.z.mul(0.047), float(19.3),
    )).mul(0.5).mul(P.treeColorVar.mul(0.6));
    col = vec3(
      col.x.add(treeHue.mul(0.4)).add(treeBright),
      col.y.add(treeBright),
      col.z.sub(treeHue.mul(0.3)).add(treeBright)
    );

    // Whole-tree height AO is an arborist concept — pine skips it and darkens
    // the card's hook side instead (pivotAo, editor's smoothstep(0,0.38,uv.y)).
    const aoHeight = mix(float(1.0).sub(P.aoStr), float(1.0), heightFactor.mul(0.8).add(0.2));
    col = col.mul(mix(aoHeight, float(1.0), u.pineMode));
    const hookAo = mix(
      float(1.0),
      float(1.0).sub(u.pivotAo.mul(u.pineMode)),
      smoothstep(float(0.0), float(0.38), uv().y),
    );
    col = col.mul(hookAo);

    const distC = clamp(length(sub(positionWorld, treeCenterW)).div(max(P.aoRadius, float(0.001))), float(0), float(1));
    const aoSphere = mix(float(1.0).sub(P.aoStr), float(1.0), distC);
    col = col.mul(aoSphere);

    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const n = normalWorld;
    // SSS uses per-leaf sphere direction so backlit anti-sun leaves glow,
    // while Lambert (via normalWorld = uniform world-up) stays stable.
    const backDot = max(dot(negate(u.sunDir), litDir), float(0));
    const sss = pow(backDot, P.sssPow).mul(P.sssStr);
    col = col.add(P.sssColor.mul(sss));

    // Rim uses per-leaf sphere direction so it activates on leaves whose
    // outward direction is perpendicular to view — i.e. the canopy silhouette
    // from any camera angle, regardless of normalBias.
    const rimDot = float(1.0).sub(max(dot(litDir, viewDir), float(0)));
    const rim = pow(rimDot, P.rimPow).mul(P.rimStr);
    col = col.add(P.rimColor.mul(rim));

    return clamp(col, float(0), float(2));
  })();

  const opacityNode = Fn(() => {
    const camDist = length(cameraPosition.sub(positionWorld));
    const distFade = clamp(camDist.div(float(150.0)), float(0), float(1));
    const adaptiveCutoff = mix(P.alphaCutoff, float(0.15), distFade);
    return smoothstep(adaptiveCutoff.sub(0.05), adaptiveCutoff.add(0.05), leafMaskCh);
  })();

  const mat = new MeshStandardNodeMaterial({
    side:        THREE.DoubleSide,
    transparent: false,
    alphaTest:   0.3,
    roughness:   0.88,
    metalness:   0.0,
    depthWrite:  true,
  });
  mat.positionNode = positionNode;
  mat.normalNode   = finalNormal;
  mat.colorNode    = colorNode;
  mat.opacityNode  = opacityNode;
  mat.envMapIntensity = 0;

  mat.castShadowNode = Fn(() => {
    // Match the visible pass: same channel select and same alphaTest threshold (0.3),
    // so the shadow silhouette aligns with the leaf silhouette.
    const a = smoothstep(P.alphaCutoff.sub(0.05), P.alphaCutoff.add(0.05), leafMaskCh);
    a.lessThan(float(0.3)).discard();
    return vec4(0, 0, 0, 1);
  })();

  return { material: mat, uniforms: u, leafMapNode };
}

/** Max slots one merged material can carry (uniform-array size). */
export const MAX_MERGED_SLOTS = 16;

/**
 * One material for MANY atlas tree slots — the draw-call merger. Leaf
 * instances carry their group-local slot id in aLeafScale.z, and every
 * per-slot parameter (atlas cell, colors, wind, SSS/rim/AO…) lives in a
 * uniform array indexed by it, so the chunked renderer can draw all
 * atlas-sharing slots of a cell in ONE mesh. Merge groups are billboard-only
 * (u.billboard is constant 1); per-slot billboardYaw still works via the
 * wind array's .w lane. Writers mutate arrays.*.array[i] in place —
 * UniformArrayNode re-uploads every render.
 *
 * uniforms.time / uniforms.sunDir keep the same names as the per-slot
 * material so updateTime()/updateSunDirection() treat both alike.
 */
export function createMergedFoliageMaterial(opts = {}) {
  const u = {
    time:        uniform(0.0),
    sunDir:      uniform(new THREE.Vector3(5, 12, 4).normalize()),
    // The shared arborist atlas always stores the mask in RED (transparent
    // gutters fool alpha auto-detect — see loadFoliagePreset).
    maskInAlpha: uniform(0.0),
    billboard:   uniform(1.0),
    useAtlas:    uniform(1.0),
    atlasGrid:   uniform(new THREE.Vector4(
                   opts.atlasGrid?.[0] ?? 4,
                   opts.atlasGrid?.[1] ?? 0.25,
                   opts.atlasGrid?.[2] ?? 12 / 1024,
                   opts.atlasGrid?.[3] ?? 232 / 1024,
                 )),
    pineAtlas:     uniform(0.0),
    pineAtlasCols: uniform(2),
    pineAtlasRows: uniform(2),
    // Pine shading is per-slot-material only; inert in merged materials.
    pineMode:     uniform(0.0),
    radialUp:     uniform(0.35),
    pivotAo:      uniform(0.0),
    veinStrength: uniform(0.0),
  };

  // ONE uniform array for every per-slot parameter, laid out as
  // PARAM_ROWS vec4 rows per slot (index = slotId * PARAM_ROWS + row).
  // Seven separate uniformArrays each got their own uniform BUFFER binding,
  // which blew WebGPU's 12-per-stage limit (13) once the material's regular
  // buffers were counted — packed into one buffer it's a single binding.
  const rowDefaults = [
    [0.18, 0.35, 0.11, 0.12], // 0: bottomColor.rgb, colorVar
    [0.35, 0.67, 0.16, 0.0],  // 1: topColor.rgb, treeColorVar
    [0.78, 0.88, 0.44, 0.0],  // 2: sssColor.rgb, sssStr
    [0.78, 1.0, 0.67, 0.07],  // 3: rimColor.rgb, rimStr
    [0.45, 1.0, 0.28, 0.7],   // 4: alphaCutoff, normalBias, leafWarp, aoStr
    [2.0, 2.5, 6.0, 0.0],     // 5: sssPow, rimPow, aoRadius, atlasCell
    [0.9, 0.0, 0.0, 1.0],     // 6: windSpeed, windStr, windMicro, billboardYaw
  ];
  // opts.sharedArrays: a second material (the GPU leaf field's) can bind the
  // SAME packed param buffer as the chunked group material — one sync path
  // covers both.
  let arrays = opts.sharedArrays ?? null;
  if (!arrays) {
    const values = [];
    for (let s = 0; s < MAX_MERGED_SLOTS; s++) {
      for (const d of rowDefaults) values.push(new THREE.Vector4(...d));
    }
    arrays = { params: uniformArray(values), PARAM_ROWS: rowDefaults.length };
  }

  const sid = opts.data?.slotId ?? int(attribute("aLeafScale", "vec3").z.add(0.5));
  const base   = sid.mul(int(rowDefaults.length));
  const eColA  = arrays.params.element(base);
  const eColB  = arrays.params.element(base.add(int(1)));
  const eSss   = arrays.params.element(base.add(int(2)));
  const eRim   = arrays.params.element(base.add(int(3)));
  const eMisc  = arrays.params.element(base.add(int(4)));
  const eMisc2 = arrays.params.element(base.add(int(5)));
  const eWind  = arrays.params.element(base.add(int(6)));
  const P = {
    bottomColor: eColA.xyz,  colorVar: eColA.w,
    topColor: eColB.xyz,     treeColorVar: eColB.w,
    sssColor: eSss.xyz,      sssStr: eSss.w,
    rimColor: eRim.xyz,      rimStr: eRim.w,
    alphaCutoff: eMisc.x,    normalBias: eMisc.y,
    leafWarp: eMisc.z,       aoStr: eMisc.w,
    sssPow: eMisc2.x,        rimPow: eMisc2.y,
    aoRadius: eMisc2.z,      atlasCell: eMisc2.w,
    windSpeed: eWind.x,      windStr: eWind.y,
    windMicro: eWind.z,      billboardYaw: eWind.w,
  };

  const res = _buildFoliageMaterial(u, P, { ...opts, merged: true });
  return { ...res, arrays };
}

// Detects whether an image's alpha channel carries meaningful (<255) data.
// PNGs with the mask in the alpha channel (e.g. RGBA leaves) return true;
// grayscale or RGB-only PNGs return false.
export function detectAlphaChannel(image) {
  try {
    const w = image.width || image.naturalWidth;
    const h = image.height || image.naturalHeight;
    if (!w || !h) return false;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] < 255) return true;
    }
    return false;
  } catch (_) {
    // Cross-origin tainted canvas etc. — fall back to red-channel.
    return false;
  }
}

export function setFoliageTexture(foliageMat, tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  foliageMat.leafMapNode.value = tex;
  // Auto-select mask channel based on the loaded texture's format.
  if (tex.image && foliageMat.uniforms && foliageMat.uniforms.maskInAlpha) {
    foliageMat.uniforms.maskInAlpha.value = detectAlphaChannel(tex.image) ? 1.0 : 0.0;
  }
}

export function applyPresetMaterial(foliageMat, preset) {
  const u = foliageMat.uniforms;
  const m = preset.material || {};
  const w = preset.wind || {};

  if (m.bottomColor) u.bottomColor.value.set(m.bottomColor);
  if (m.topColor)    u.topColor.value.set(m.topColor);
  if (m.colorVar != null)    u.colorVar.value    = m.colorVar;
  if (m.treeColorVar != null) u.treeColorVar.value = m.treeColorVar;
  if (m.alphaCutoff != null) u.alphaCutoff.value  = m.alphaCutoff;
  if (m.roughness != null)   foliageMat.material.roughness = m.roughness;
  if (m.sssColor)            u.sssColor.value.set(m.sssColor);
  if (m.sssStr != null)      u.sssStr.value       = m.sssStr;
  if (m.sssPow != null)      u.sssPow.value       = m.sssPow;
  if (m.rimColor)            u.rimColor.value.set(m.rimColor);
  if (m.rimStr != null)      u.rimStr.value        = m.rimStr;
  if (m.rimPow != null)      u.rimPow.value        = m.rimPow;
  if (m.aoStr != null)       u.aoStr.value         = m.aoStr;
  if (m.normalBias != null)  u.normalBias.value    = m.normalBias;
  if (m.leafWarp != null)    u.leafWarp.value      = m.leafWarp;
  // Pine-editor shading params (only meaningful when pineMode is on).
  if (m.radialUp != null && u.radialUp)         u.radialUp.value     = m.radialUp;
  if (m.pivotAo != null && u.pivotAo)           u.pivotAo.value      = m.pivotAo;
  if (m.veinStrength != null && u.veinStrength) u.veinStrength.value = m.veinStrength;
  // Billboard mode (matches arborist preview).
  if (m.billboardLeaves != null)  u.billboard.value    = m.billboardLeaves ? 1.0 : 0.0;
  if (m.billboardYawOnly != null) u.billboardYaw.value = m.billboardYawOnly ? 1.0 : 0.0;

  if (w.windSpeed != null) u.windSpeed.value = w.windSpeed;
  if (w.windStr != null)   u.windStr.value   = w.windStr;
  if (w.windMicro != null) u.windMicro.value = w.windMicro;
}

export function updateFoliageBounds(foliageMat, yMin, yMax, canopyCenter, aoRadius) {
  const u = foliageMat.uniforms;
  u.yMin.value = yMin;
  u.yMax.value = yMax;
  u.canopyCenter.value.copy(canopyCenter);
  u.aoRadius.value = aoRadius;
}
