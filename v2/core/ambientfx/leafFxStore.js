import * as THREE from "three";

const MAX_EMITTERS        = 200;
const MAX_PER_TYPE        = 600;
const RING_SEGMENTS       = 48;
const ACTIVATION_RADIUS   = 150;
const DEACTIVATION_RADIUS = 170;
const LEAF_TYPES          = 3;

function makeLeafParticle(ex, ez, eRadius, groundY, spawnHeight) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * eRadius;
  return {
    emitterX: ex, emitterZ: ez, emitterR: eRadius,
    x: ex + Math.cos(a) * r,
    z: ez + Math.sin(a) * r,
    y: groundY + 2 + Math.random() * spawnHeight,
    vx: 0, vy: 0, vz: 0,
    rx: Math.random() * Math.PI * 2,
    ry: Math.random() * Math.PI * 2,
    rz: Math.random() * Math.PI * 2,
    scale: 0.8 + Math.random() * 0.4,
    phase: Math.random() * Math.PI * 2,
    swayFreq: 0.3 + Math.random() * 0.4,
    swayAmp: 0.4 + Math.random() * 0.6,
    spiralFreq: 0.15 + Math.random() * 0.25,
    spiralAmp: 0.2 + Math.random() * 0.5,
    tumbleX: (0.5 + Math.random() * 0.5) * (Math.random() < 0.5 ? 1 : -1),
    tumbleZ: (0.3 + Math.random() * 0.4) * (Math.random() < 0.5 ? 1 : -1),
    gustSeed: Math.random() * 100,
  };
}

export function createLeafFxStore(scene, sampleHeight, texBasePath) {
  const basePath = texBasePath || "../textures/";
  let emitters = [];
  const dummy = new THREE.Object3D();

  const params = {
    spawnHeight: 20,
    leafSize: 0.25,
    gravity: 0.002,
    terminalVelocity: 0.02,
    rotationSpeed: 0.0015,
    airResistance: 0.99,
    windInfluence: 1.0,
    opacity: 0.85,
    globalScale: 1.0,
    terrainFloorOffset: 1.5,
    leafTextures: [
      basePath + "leaf1-tiny.png",
      basePath + "leaf1-tiny.png",
      basePath + "leaf1-tiny.png",
    ],
    leafTints: ["#ff6b35", "#8B4513", "#2d7a2d"],
  };

  const loader = new THREE.TextureLoader();
  const textures = [];
  const materials = [];
  const meshes = [null, null, null];

  const leafGeo = new THREE.PlaneGeometry(params.leafSize, params.leafSize);

  for (let t = 0; t < LEAF_TYPES; t++) {
    const tex = loader.load(params.leafTextures[t]);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    textures.push(tex);

    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      opacity: params.opacity,
      side: THREE.DoubleSide,
      alphaTest: 0.1,
      color: new THREE.Color(params.leafTints[t]),
    });
    materials.push(mat);

    const im = new THREE.InstancedMesh(leafGeo, mat, MAX_PER_TYPE);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = true;
    scene.add(im);
    meshes[t] = im;
  }

  // activeParticles[t] = array of particles for leaf type t
  let activeByType = [[], [], []];
  let activeEmitterSet = new Set();

  const ringMat = new THREE.LineBasicMaterial({ color: 0x88cc44, opacity: 0.5, transparent: true });
  let ringLines = [];

  function rebuildRings() {
    for (const r of ringLines) scene.remove(r);
    ringLines = [];
    for (const em of emitters) {
      const pts = [];
      for (let s = 0; s <= RING_SEGMENTS; s++) {
        const a = (s / RING_SEGMENTS) * Math.PI * 2;
        const rx = em.x + Math.cos(a) * em.radius;
        const rz = em.z + Math.sin(a) * em.radius;
        const ry = sampleHeight(rx, rz) + 0.3;
        pts.push(new THREE.Vector3(rx, ry, rz));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, ringMat);
      line.frustumCulled = false;
      scene.add(line);
      ringLines.push(line);
    }
  }

  function spawnParticles(em) {
    const count = Math.max(1, Math.round(em.density * em.radius * 0.6));
    const groundY = sampleHeight(em.x, em.z);
    em.particles = [];
    for (let i = 0; i < count; i++) {
      em.particles.push(makeLeafParticle(em.x, em.z, em.radius, groundY, params.spawnHeight));
    }
  }

  function rebuildActiveList() {
    activeByType = [[], [], []];
    for (const idx of activeEmitterSet) {
      const em = emitters[idx];
      const t = em.leafType || 0;
      for (const p of em.particles) {
        if (activeByType[t].length < MAX_PER_TYPE) {
          activeByType[t].push(p);
        }
      }
    }
    for (let t = 0; t < LEAF_TYPES; t++) {
      meshes[t].count = activeByType[t].length;
    }
  }

  function updateActivation(focusPos) {
    let changed = false;
    const newActive = new Set();

    for (let i = 0; i < emitters.length; i++) {
      const em = emitters[i];
      const dx = em.x - focusPos.x;
      const dz = em.z - focusPos.z;
      const distSq = dx * dx + dz * dz;

      if (activeEmitterSet.has(i)) {
        if (distSq < DEACTIVATION_RADIUS * DEACTIVATION_RADIUS) {
          newActive.add(i);
        } else {
          changed = true;
        }
      } else {
        if (distSq < ACTIVATION_RADIUS * ACTIVATION_RADIUS) {
          newActive.add(i);
          if (!em.particles || em.particles.length === 0) spawnParticles(em);
          changed = true;
        }
      }
    }

    if (changed || newActive.size !== activeEmitterSet.size) {
      activeEmitterSet = newActive;
      rebuildActiveList();
    }
  }

  function addInBrush(cx, cz, radius, density, leafType) {
    if (emitters.length >= MAX_EMITTERS) return 0;

    const minDist = radius * 0.8;
    const minSq = minDist * minDist;
    for (const em of emitters) {
      const dx = em.x - cx, dz = em.z - cz;
      if (dx * dx + dz * dz < minSq) return 0;
    }

    const em = { x: cx, z: cz, radius, density, leafType: leafType || 0, particles: [] };
    spawnParticles(em);
    emitters.push(em);
    rebuildRings();
    activeEmitterSet.clear();
    return 1;
  }

  function removeInBrush(cx, cz, radius) {
    const rSq = radius * radius;
    const before = emitters.length;
    emitters = emitters.filter(em => {
      const dx = em.x - cx, dz = em.z - cz;
      return dx * dx + dz * dz > rSq;
    });
    if (emitters.length !== before) {
      rebuildRings();
      activeEmitterSet.clear();
    }
  }

  function update(focusPos, elapsed, windX, windZ, windStrength) {
    updateActivation(focusPos);

    const dt = Math.min(0.05, 1 / 60);
    const wInfluence = params.windInfluence;
    const baseWindX = (windX || 0) * (windStrength || 0) * wInfluence;
    const baseWindZ = (windZ || 0) * (windStrength || 0) * wInfluence;

    for (let lt = 0; lt < LEAF_TYPES; lt++) {
      const arr = activeByType[lt];
      const im = meshes[lt];
      if (arr.length === 0) { im.count = 0; continue; }

      for (let i = 0; i < arr.length; i++) {
        const d = arr[i];
        const t = elapsed + d.phase;

        d.vy -= params.gravity * dt * 60;
        if (d.vy < -params.terminalVelocity) d.vy = -params.terminalVelocity;

        const drag = Math.pow(params.airResistance, dt * 60);
        d.vx *= drag;
        d.vz *= drag;

        const swayDelta = Math.cos(t * d.swayFreq * Math.PI * 2) * d.swayAmp * d.swayFreq * Math.PI * 2;
        const sway = Math.sin(t * d.swayFreq * Math.PI * 2) * d.swayAmp;
        const spiral = Math.sin(t * d.spiralFreq * Math.PI * 2) * d.spiralAmp;
        const spiralC = Math.cos(t * d.spiralFreq * Math.PI * 2) * d.spiralAmp;

        const gustPhase = d.gustSeed + elapsed * 0.15;
        const gustX = Math.sin(gustPhase) * 0.3 + Math.sin(gustPhase * 2.3) * 0.15;
        const gustZ = Math.cos(gustPhase * 1.1) * 0.3 + Math.cos(gustPhase * 1.9) * 0.15;

        const windForceX = (baseWindX * 0.5 + gustX * baseWindX * 0.3) * dt;
        const windForceZ = (baseWindZ * 0.5 + gustZ * baseWindZ * 0.3) * dt;
        d.vx += windForceX;
        d.vz += windForceZ;

        d.x += d.vx * dt * 60 + swayDelta * dt * 0.3;
        d.y += d.vy * dt * 60;
        d.z += d.vz * dt * 60 + spiral * dt * 0.3;

        const rotSpeed = params.rotationSpeed * dt * 60;
        d.rx += rotSpeed * d.tumbleX + sway * dt * 0.5;
        d.ry += rotSpeed * 0.7;
        d.rz += rotSpeed * d.tumbleZ + spiralC * dt * 0.3;

        const groundY = sampleHeight(d.x, d.z);
        if (d.y < groundY + params.terrainFloorOffset) {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * d.emitterR;
          d.x = d.emitterX + Math.cos(a) * r;
          d.z = d.emitterZ + Math.sin(a) * r;
          const topY = sampleHeight(d.x, d.z);
          d.y = topY + params.spawnHeight * 0.5 + Math.random() * params.spawnHeight;
          d.vx = 0;
          d.vy = 0;
          d.vz = 0;
          d.phase = Math.random() * Math.PI * 2;
        }

        const dx = d.x - d.emitterX, dz = d.z - d.emitterZ;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > d.emitterR * 1.2) {
          const pull = Math.min((dist - d.emitterR * 1.2) * 0.02, 0.5) * dt * 60;
          d.x -= dx / dist * pull;
          d.z -= dz / dist * pull;
        }

        const s = d.scale * params.globalScale;
        dummy.position.set(d.x, d.y, d.z);
        dummy.rotation.set(d.rx, d.ry, d.rz);
        dummy.scale.setScalar(s);
        dummy.updateMatrix();
        im.setMatrixAt(i, dummy.matrix);
      }

      im.count = arr.length;
      im.instanceMatrix.needsUpdate = true;
    }
  }

  let ringsVisible = true;
  function setRingsVisible(v) {
    ringsVisible = v;
    for (const r of ringLines) r.visible = v;
  }

  function syncHeights() {
    for (const em of emitters) {
      for (const p of (em.particles || [])) {
        const groundY = sampleHeight(p.emitterX, p.emitterZ);
        if (p.y < groundY + params.terrainFloorOffset) {
          p.y = groundY + params.spawnHeight * 0.5 + Math.random() * params.spawnHeight;
        }
      }
    }
    rebuildRings();
  }

  function getEmitters() {
    return emitters.map(em => ({
      x: em.x, z: em.z, radius: em.radius,
      density: em.density, leafType: em.leafType,
    }));
  }

  function setEmitters(arr) {
    for (const r of ringLines) scene.remove(r);
    ringLines = [];
    activeByType = [[], [], []];
    activeEmitterSet.clear();
    for (let t = 0; t < LEAF_TYPES; t++) meshes[t].count = 0;

    emitters = (arr || []).map(e => ({
      x: e.x, z: e.z, radius: e.radius,
      density: e.density || 3,
      leafType: e.leafType || 0,
      particles: [],
    }));
    rebuildRings();
  }

  function clear() {
    for (const r of ringLines) scene.remove(r);
    ringLines = [];
    activeByType = [[], [], []];
    activeEmitterSet.clear();
    for (let t = 0; t < LEAF_TYPES; t++) meshes[t].count = 0;
    emitters = [];
  }

  function dispose() {
    clear();
    for (let t = 0; t < LEAF_TYPES; t++) {
      scene.remove(meshes[t]);
      meshes[t].dispose();
      meshes[t] = null;
    }
  }

  function setOpacity(v) {
    params.opacity = v;
    for (const m of materials) m.opacity = v;
  }

  function setLeafTint(idx, hex) {
    if (idx >= 0 && idx < LEAF_TYPES) {
      params.leafTints[idx] = hex;
      materials[idx].color.set(hex);
    }
  }

  function setLeafTexture(idx, url) {
    if (idx < 0 || idx >= LEAF_TYPES) return;
    params.leafTextures[idx] = url;
    loader.load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = true;
      textures[idx] = tex;
      materials[idx].map = tex;
      materials[idx].needsUpdate = true;
    });
  }

  function respawnAll() {
    activeEmitterSet.clear();
    for (const em of emitters) {
      spawnParticles(em);
    }
  }

  function getCount() { return emitters.length; }
  function getParticleCount() {
    return activeByType[0].length + activeByType[1].length + activeByType[2].length;
  }

  return {
    params,
    addInBrush, removeInBrush,
    update, syncHeights,
    setRingsVisible,
    getEmitters, setEmitters, clear, dispose,
    getCount, getParticleCount,
    setOpacity, setLeafTint, setLeafTexture,
    respawnAll,
  };
}
