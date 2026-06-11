/**
 * Shared Lotus parkour test track — same geometry for BVH and Rapier builds.
 */
import * as THREE from "three";

export const LOTUS_PARKOUR_CONSTANTS = {
  TERRAIN_SIZE: 400,
  TERRAIN_HALF: 200,
  WORLD_LIMIT: 198,
  SPAWN: { x: 0, y: 0, z: -8, heading: 0 },
  RAMP_GROUND_LIFT: 0.025,
};

/**
 * @param {THREE.Scene} scene
 * @param {(seed?: number) => THREE.Material} createTileMat
 */
export function createLotusParkourTrack(scene, createTileMat) {
  const { TERRAIN_SIZE, TERRAIN_HALF, RAMP_GROUND_LIFT } = LOTUS_PARKOUR_CONSTANTS;
  const colliders = [];

  const parkourDebug = {
    ground: true,
    perimeterWalls: true,
    testWalls: true,
    slopeLab: true,
    bridgeStraight: true,
    bridgeCurved: true,
    jumpRamp: true,
  };

  const parkourGroupMeta = {
    ground: "Ground tile",
    perimeterWalls: "Perimeter walls",
    testWalls: "Test walls (near spawn)",
    slopeLab: "Slope lab (5°–55°)",
    bridgeStraight: "Bridge straight (west)",
    bridgeCurved: "Bridge curved (east)",
    jumpRamp: "Jump ramp (south)",
  };

  const parkourGroupObjects = Object.fromEntries(
    Object.keys(parkourDebug).map((id) => [id, []]),
  );

  function registerParkourObject(groupId, obj) {
    if (!obj || !parkourGroupObjects[groupId]) return obj;
    parkourGroupObjects[groupId].push(obj);
    obj.userData.parkourGroup = groupId;
    return obj;
  }

  function isParkourGroupEnabled(groupId) {
    return parkourDebug[groupId] !== false;
  }

  function applyParkourGroupVisibility(groupId) {
    const enabled = isParkourGroupEnabled(groupId);
    for (const obj of parkourGroupObjects[groupId] || []) {
      obj.visible = enabled;
    }
  }

  function applyAllParkourGroups() {
    for (const groupId of Object.keys(parkourGroupObjects)) {
      applyParkourGroupVisibility(groupId);
    }
  }

  function setParkourGroupEnabled(groupId, enabled, onRebuild) {
    if (!(groupId in parkourDebug)) return;
    parkourDebug[groupId] = enabled;
    applyParkourGroupVisibility(groupId);
    onRebuild?.();
  }

  function setAllParkourGroupsEnabled(enabled, onRebuild) {
    for (const groupId of Object.keys(parkourDebug)) {
      parkourDebug[groupId] = enabled;
    }
    applyAllParkourGroups();
    onRebuild?.();
  }

  function addCollider(mesh, { collidable = true, doubleSided = false, group = null } = {}) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (doubleSided) mesh.userData.bvhDoubleSided = true;
    if (group) registerParkourObject(group, mesh);
    scene.add(mesh);
    if (collidable) colliders.push(mesh);
    return mesh;
  }

  function addParkourVisual(group, mesh) {
    mesh.castShadow = mesh.castShadow ?? true;
    mesh.receiveShadow = mesh.receiveShadow ?? true;
    registerParkourObject(group, mesh);
    scene.add(mesh);
    return mesh;
  }

  function addVisualEndCap(parent, mat, halfW, z, topY) {
    if (topY < 0.02) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        new Float32Array([
          -halfW, RAMP_GROUND_LIFT, z,
           halfW, RAMP_GROUND_LIFT, z,
           halfW, topY, z,
          -halfW, topY, z,
        ]),
        3,
      ),
    );
    g.setIndex([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.userData.bvhIgnore = true;
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
  }

  function createFloorLabel(text, x, z, width = 4.2, group = null) {
    const cw = 320;
    const ch = 128;
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(8, 10, 14, 0.88)";
    ctx.fillRect(0, 0, cw, ch);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 5;
    ctx.strokeRect(6, 6, cw - 12, ch - 12);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${width > 5 ? 52 : 64}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, cw / 2, ch / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, width * 0.393),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.04, z);
    if (group) registerParkourObject(group, mesh);
    scene.add(mesh);
    return mesh;
  }

  function buildWedge(width, length, height, mat) {
    const w2 = width / 2;
    const y0 = RAMP_GROUND_LIFT;
    const positions = new Float32Array([
      -w2, y0, 0,
       w2, y0, 0,
      -w2, y0, length,
       w2, y0, length,
      -w2, height, length,
       w2, height, length,
    ]);
    const indices = [0, 1, 2, 1, 3, 2, 0, 4, 1, 1, 4, 5];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    const ramp = new THREE.Mesh(g, mat);

    function addVisualSide(a, b, c) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          new Float32Array([
            positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
            positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
            positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2],
          ]),
          3,
        ),
      );
      sg.setIndex([0, 1, 2]);
      sg.computeVertexNormals();
      const m = new THREE.Mesh(sg, mat);
      m.userData.bvhIgnore = true;
      m.castShadow = true;
      m.receiveShadow = true;
      ramp.add(m);
    }
    addVisualSide(0, 2, 4);
    addVisualSide(1, 5, 3);
    addVisualEndCap(ramp, mat, w2, length, height);
    return ramp;
  }

  function buildSplineRamp(centerX, centerZ, length, height, width, segments, yaw, mat, descend = false) {
    const halfW = width / 2;
    const curve = descend
      ? new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, height, 0),
          new THREE.Vector3(0, height * 0.96, length * 0.28),
          new THREE.Vector3(0, height * 0.5, length * 0.72),
          new THREE.Vector3(0, 0, length),
        ])
      : new THREE.CatmullRomCurve3([
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, height * 0.04, length * 0.28),
          new THREE.Vector3(0, height * 0.5, length * 0.72),
          new THREE.Vector3(0, height, length),
        ]);
    const points = [];
    for (let i = 0; i <= segments; i++) {
      points.push(curve.getPoint(i / segments));
    }

    const topPos = [];
    for (const p of points) {
      topPos.push(p.x - halfW, p.y, p.z);
      topPos.push(p.x + halfW, p.y, p.z);
    }
    const topIdx = [];
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      topIdx.push(a, c, b, b, c, d);
    }
    const topGeo = new THREE.BufferGeometry();
    topGeo.setAttribute("position", new THREE.Float32BufferAttribute(topPos, 3));
    topGeo.setIndex(topIdx);
    topGeo.computeVertexNormals();
    const ramp = new THREE.Mesh(topGeo, mat);

    function makeSidePanel(sign) {
      const pos = [];
      for (const p of points) {
        pos.push(p.x + sign * halfW, p.y, p.z);
        pos.push(p.x + sign * halfW, RAMP_GROUND_LIFT, p.z);
      }
      const idx = [];
      for (let i = 0; i < segments; i++) {
        const a = i * 2;
        const b = a + 1;
        const c = a + 2;
        const d = a + 3;
        if (sign < 0) idx.push(a, b, c, c, b, d);
        else idx.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.userData.bvhIgnore = true;
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    }
    ramp.add(makeSidePanel(-1));
    ramp.add(makeSidePanel(1));

    const tip = points[points.length - 1];
    const highZ = descend ? 0 : tip.z;
    const highY = descend ? height : tip.y;
    addVisualEndCap(ramp, mat, halfW, highZ, highY);

    ramp.rotation.y = yaw;
    ramp.position.set(centerX, 0, centerZ);
    return ramp;
  }

  function buildWedgeDescent(width, length, height, mat) {
    const w2 = width / 2;
    const y0 = RAMP_GROUND_LIFT;
    const positions = new Float32Array([
      -w2, y0, length,
       w2, y0, length,
      -w2, y0, 0,
       w2, y0, 0,
      -w2, height, 0,
       w2, height, 0,
    ]);
    const indices = [0, 1, 2, 1, 3, 2, 0, 4, 1, 1, 4, 5];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    const ramp = new THREE.Mesh(g, mat);

    function addVisualSide(a, b, c) {
      const sg = new THREE.BufferGeometry();
      sg.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          new Float32Array([
            positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2],
            positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2],
            positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2],
          ]),
          3,
        ),
      );
      sg.setIndex([0, 1, 2]);
      sg.computeVertexNormals();
      const m = new THREE.Mesh(sg, mat);
      m.userData.bvhIgnore = true;
      m.castShadow = true;
      m.receiveShadow = true;
      ramp.add(m);
    }
    addVisualSide(0, 2, 4);
    addVisualSide(1, 5, 3);
    addVisualEndCap(ramp, mat, w2, 0, height);
    return ramp;
  }

  function placeBridgePart(mesh, centerX, centerZ, localX, localZ, yaw, y = 0, group = null) {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    mesh.position.set(
      centerX + localX * c - localZ * s,
      y,
      centerZ + localX * s + localZ * c,
    );
    mesh.rotation.y = yaw;
    addCollider(mesh, { group });
  }

  function placeBridgeDeck(centerX, centerZ, deckLen, deckW, deckHeight, yaw, mat, group) {
    const deckTop = new THREE.Mesh(new THREE.PlaneGeometry(deckW, deckLen), mat);
    deckTop.rotation.x = -Math.PI / 2;
    placeBridgePart(deckTop, centerX, centerZ, 0, 0, yaw, deckHeight, group);

    const deckVisual = new THREE.Mesh(
      new THREE.BoxGeometry(deckW, 0.4, deckLen),
      mat,
    );
    deckVisual.position.set(centerX, deckHeight - 0.2, centerZ);
    deckVisual.rotation.y = yaw;
    deckVisual.userData.bvhIgnore = true;
    addParkourVisual(group, deckVisual);
  }

  function buildStraightBridge(centerX, centerZ, deckLen, deckW, rampLen, deckHeight, yaw, mat, group) {
    const rampUp = buildWedge(deckW, rampLen, deckHeight, mat);
    placeBridgePart(rampUp, centerX, centerZ, 0, -(deckLen / 2 + rampLen / 2), yaw, 0, group);
    placeBridgeDeck(centerX, centerZ, deckLen, deckW, deckHeight, yaw, mat, group);
    const rampDown = buildWedgeDescent(deckW, rampLen, deckHeight, mat);
    placeBridgePart(rampDown, centerX, centerZ, 0, deckLen / 2 + rampLen / 2, yaw, 0, group);
  }

  function buildCurvedBridge(centerX, centerZ, deckLen, deckW, rampLen, deckHeight, yaw, mat, group) {
    const rampUp = buildSplineRamp(0, 0, rampLen, deckHeight, deckW, 48, 0, mat, false);
    placeBridgePart(rampUp, centerX, centerZ, 0, -(deckLen / 2 + rampLen / 2), yaw, 0, group);
    placeBridgeDeck(centerX, centerZ, deckLen, deckW, deckHeight, yaw, mat, group);
    const rampDown = buildSplineRamp(0, 0, rampLen, deckHeight, deckW, 48, 0, mat, true);
    placeBridgePart(rampDown, centerX, centerZ, 0, deckLen / 2 + rampLen / 2, yaw, 0, group);
  }

  function buildPerimeterWalls(halfExtent, height, thickness, group) {
    const y = height / 2;
    const span = halfExtent * 2;
    const walls = [
      { sx: span + thickness, sy: height, sz: thickness, px: 0, pz: halfExtent + thickness / 2 },
      { sx: span + thickness, sy: height, sz: thickness, px: 0, pz: -(halfExtent + thickness / 2) },
      { sx: thickness, sy: height, sz: span, px: halfExtent + thickness / 2, pz: 0 },
      { sx: thickness, sy: height, sz: span, px: -(halfExtent + thickness / 2), pz: 0 },
    ];
    walls.forEach((w, i) => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w.sx, w.sy, w.sz),
        createTileMat(880 + i),
      );
      mesh.position.set(w.px, y, w.pz);
      addCollider(mesh, { group });
    });
  }

  function buildSlopeTestGrid() {
    const baseZ = 52;
    const rampLen = 20;
    const rampW = 8;
    const gap = rampW + 2.8;
    const angles = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
    const startX = -((angles.length - 1) * gap) / 2;

    angles.forEach((deg, i) => {
      const rise = rampLen * Math.tan(THREE.MathUtils.degToRad(deg));
      const x = startX + i * gap;
      const mat = createTileMat(i + 1);

      const approach = new THREE.Mesh(
        new THREE.PlaneGeometry(rampW, 8),
        createTileMat(i + 100),
      );
      approach.rotation.x = -Math.PI / 2;
      approach.position.set(x, 0.012, baseZ - rampLen / 2 - 7);
      addCollider(approach, { group: "slopeLab" });

      const ramp = buildWedge(rampW, rampLen, rise, mat);
      ramp.position.set(x, 0, baseZ - rampLen / 2);
      ramp.userData.slopeDeg = deg;
      addCollider(ramp, { group: "slopeLab" });

      const topZ = baseZ + rampLen / 2;
      if (deg >= 45) {
        const barrier = new THREE.Mesh(
          new THREE.BoxGeometry(rampW + 0.7, 4, 0.8),
          createTileMat(i + 300),
        );
        barrier.position.set(x, rise + 2, topZ + 8.4);
        addCollider(barrier, { group: "slopeLab" });
      }

      createFloorLabel(`${deg}°`, x, baseZ - rampLen / 2 - 13, 4.2, "slopeLab");
    });
  }

  function buildBridgeTests() {
    const deckLen = 16;
    const deckW = 10;
    const rampLen = 14;
    const deckHeight = 3.8;

    buildStraightBridge(
      -62, 6, deckLen, deckW, rampLen, deckHeight,
      Math.PI / 2, createTileMat(501), "bridgeStraight",
    );
    createFloorLabel("BRIDGE STRAIGHT", -62, -16, 6.5, "bridgeStraight");

    buildCurvedBridge(
      62, 6, deckLen, deckW, rampLen, deckHeight,
      -Math.PI / 2, createTileMat(502), "bridgeCurved",
    );
    createFloorLabel("BRIDGE CURVED", 62, -16, 6.5, "bridgeCurved");
  }

  function buildCircuit() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE),
      createTileMat(0),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.userData.bvhDoubleSided = true;
    ground.userData.rapierGroundCuboid = true;
    addCollider(ground, { group: "ground" });

    buildPerimeterWalls(TERRAIN_HALF - 3, 14, 1.1, "perimeterWalls");
    createFloorLabel("SPAWN", 0, -14, 4.2, "ground");

    const wallMat = createTileMat(42);
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(18, 2.6, 0.55),
      wallMat,
    );
    wall.position.set(14, 1.3, 4);
    addCollider(wall, { group: "testWalls" });

    const wall2 = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 2.6, 14),
      createTileMat(43),
    );
    wall2.position.set(4, 1.3, -14);
    addCollider(wall2, { group: "testWalls" });

    createFloorLabel("WALL", 14, 8, 4.2, "testWalls");
    createFloorLabel("WALL", 4, -10, 4.2, "testWalls");

    buildSlopeTestGrid();
    buildBridgeTests();

    const kicker = buildSplineRamp(0, -38, 16, 4.5, 11, 64, 0, createTileMat(77));
    addCollider(kicker, { group: "jumpRamp" });
    createFloorLabel("JUMP", -7, -52, 4.2, "jumpRamp");

    applyAllParkourGroups();
  }

  return {
    colliders,
    parkourDebug,
    parkourGroupMeta,
    parkourGroupObjects,
    buildCircuit,
    applyAllParkourGroups,
    isParkourGroupEnabled,
    setParkourGroupEnabled,
    setAllParkourGroupsEnabled,
    registerParkourObject,
  };
}
