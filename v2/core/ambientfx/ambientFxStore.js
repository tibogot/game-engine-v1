import * as THREE from "three";
import {
  abs, cos, float, instanceIndex, max, min, mix, positionLocal, pow, sin, step,
  texture, time, uniform, uv, vec3,
} from "three/tsl";

const MAX_EMITTERS        = 200;
const MAX_PARTICLES_TOTAL = 800;
const RING_SEGMENTS       = 48;
const ACTIVATION_RADIUS   = 150;
const DEACTIVATION_RADIUS = 170;

// ── Wing geometry ──
function createWingGeo() {
  return new THREE.PlaneGeometry(1, 1, 2, 1);
}

// ── Pseudo-random from instanceIndex ──
function iHash(offset) {
  return float(instanceIndex).add(float(offset)).mul(127.1).sin().mul(43758.5453).fract();
}

// ── TSL material with asymmetric wing-fold + glide pauses ──
function createWingMaterial(tex, uFlapSpeed, uFlapAngle, uGlideRatio) {
  const phase    = iHash(0).mul(Math.PI * 2);
  const speedVar = iHash(17).mul(0.4).add(0.8);
  const glidePhase = iHash(33).mul(Math.PI * 2);
  const glideCycleVar = iHash(44).mul(0.5).add(0.75);

  const glideCycle = time.mul(float(0.4)).mul(glideCycleVar).add(glidePhase);
  const glideWave  = sin(glideCycle).add(sin(glideCycle.mul(1.7))).mul(0.5);
  const glideActive = step(float(1.0).sub(uGlideRatio), glideWave.mul(0.5).add(0.5));
  const flapMul = float(1.0).sub(glideActive.mul(0.85));

  const rawPhase = time.mul(uFlapSpeed).mul(speedVar).add(phase);
  const sinWave  = sin(rawPhase);
  const isUp     = step(float(0), sinWave);
  const sharpUp  = pow(abs(sinWave), float(0.5)).mul(isUp);
  const slowDown = abs(sinWave).mul(float(1).sub(isUp));
  const asymFlap = sharpUp.sub(slowDown);

  const flapA = asymFlap.mul(uFlapAngle).mul(flapMul);
  const glideRest = glideActive.mul(float(0.15));

  const px   = positionLocal.x;
  const sgnX = step(float(0), px).mul(2).sub(1);
  const angle = flapA.mul(sgnX).add(glideRest.mul(sgnX));

  const cosA = cos(angle);
  const sinA = sin(angle);
  const newPos = vec3(px.mul(cosA), positionLocal.y, px.mul(sinA));

  const texSample = texture(tex, uv());

  const mat = new THREE.MeshBasicNodeMaterial();
  mat.positionNode   = newPos;
  mat.colorNode      = texSample;
  mat.opacityNode    = texSample.a;
  mat.alphaTestNode  = float(0.3);
  mat.transparent    = true;
  mat.depthWrite     = true;
  mat.side           = THREE.DoubleSide;
  return mat;
}

// ── Per-particle data ──
function makeParticle(ex, ez, eRadius, groundY) {
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * eRadius;
  return {
    emitterX: ex, emitterZ: ez, emitterR: eRadius,
    x: ex + Math.cos(a) * r,
    z: ez + Math.sin(a) * r,
    baseY: groundY + 1.5 + Math.random() * 4.5,
    y: groundY + 2,
    vx: 0, vz: 0,
    yaw: Math.random() * Math.PI * 2,
    roll: 0,
    speed: 1.5 + Math.random() * 2.0,
    jitterTimer: Math.random() * 1.5,
    jitterInterval: 0.4 + Math.random() * 0.8,
    jitterYaw: 0,
    glideTimer: Math.random() * 5,
    glideCycle: 3 + Math.random() * 4,
    isGliding: false,
    glideDuration: 0,
    bobPhase: Math.random() * Math.PI * 2,
    bobFreq: 0.8 + Math.random() * 1.0,
    bobAmp: 0.3 + Math.random() * 0.8,
    flapLiftAccum: 0,
    scale: 0.4 + Math.random() * 0.5,
    variant: Math.random() < 0.3 ? 1 : 0,
  };
}

// ══════════════════════════════════════════════════════════════════════
//  Main system factory
// ══════════════════════════════════════════════════════════════════════

export function createAmbientFxStore(scene, sampleHeight, texBasePath) {
  const basePath = texBasePath || "../textures/";
  let emitters = [];
  const dummy = new THREE.Object3D();

  const uFlapSpeed  = uniform(float(8.0));
  const uFlapAngle  = uniform(float(0.8));
  const uGlideRatio = uniform(float(0.45));

  const loader = new THREE.TextureLoader();
  const texButterfly = loader.load(basePath + "butterfly.png");
  const texMoth      = loader.load(basePath + "moth.png");
  [texButterfly, texMoth].forEach(t => { t.colorSpace = THREE.SRGBColorSpace; });

  const wingGeo = createWingGeo();
  const matButterfly = createWingMaterial(texButterfly, uFlapSpeed, uFlapAngle, uGlideRatio);
  const matMoth      = createWingMaterial(texMoth, uFlapSpeed, uFlapAngle, uGlideRatio);

  let imButterfly = null, imMoth = null;
  let activeParticles = [];

  // Emitter ring visualization
  const ringMat = new THREE.LineBasicMaterial({ color: 0x00ffcc, opacity: 0.5, transparent: true });
  let ringLines = [];

  // Camera-based activation tracking
  let activeEmitterSet = new Set();

  // ── Rebuild InstancedMeshes from active particles ──
  function rebuildMeshes() {
    const bCount = activeParticles.filter(p => p.variant === 0).length;
    const mCount = activeParticles.filter(p => p.variant === 1).length;

    if (imButterfly) { scene.remove(imButterfly); imButterfly.dispose(); }
    if (bCount > 0) {
      imButterfly = new THREE.InstancedMesh(wingGeo, matButterfly, bCount);
      imButterfly.count = bCount;
      imButterfly.frustumCulled = false;
      scene.add(imButterfly);
    } else { imButterfly = null; }

    if (imMoth) { scene.remove(imMoth); imMoth.dispose(); }
    if (mCount > 0) {
      imMoth = new THREE.InstancedMesh(wingGeo, matMoth, mCount);
      imMoth.count = mCount;
      imMoth.frustumCulled = false;
      scene.add(imMoth);
    } else { imMoth = null; }
  }

  // ── Rebuild emitter ring overlays ──
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

  // ── Spawn particles for an emitter ──
  function spawnParticles(em) {
    const count = Math.max(1, Math.round(em.density * em.radius * 0.8));
    const groundY = sampleHeight(em.x, em.z);
    em.particles = [];
    for (let i = 0; i < count; i++) {
      em.particles.push(makeParticle(em.x, em.z, em.radius, groundY));
    }
  }

  // ── Activate/deactivate emitters based on camera ──
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
          if (!em.particles || em.particles.length === 0) {
            spawnParticles(em);
          }
          changed = true;
        }
      }
    }

    if (changed || newActive.size !== activeEmitterSet.size) {
      activeEmitterSet = newActive;
      activeParticles = [];
      let total = 0;
      for (const idx of activeEmitterSet) {
        const em = emitters[idx];
        for (const p of em.particles) {
          if (total < MAX_PARTICLES_TOTAL) {
            activeParticles.push(p);
            total++;
          }
        }
      }
      rebuildMeshes();
    }
  }

  // ── Add emitter via brush ──
  function addInBrush(cx, cz, radius, effectType, density) {
    if (emitters.length >= MAX_EMITTERS) return 0;

    const minDist = radius * 0.8;
    const minSq = minDist * minDist;
    for (const em of emitters) {
      if (em.effectType !== effectType) continue;
      const dx = em.x - cx, dz = em.z - cz;
      if (dx * dx + dz * dz < minSq) return 0;
    }

    const em = { x: cx, z: cz, radius, effectType, density, particles: [] };
    spawnParticles(em);
    emitters.push(em);
    rebuildRings();
    activeEmitterSet.clear();
    return 1;
  }

  // ── Remove emitters within brush ──
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

  // ── Per-frame update ──
  function update(focusPos, elapsed, windX, windZ, windStrength) {
    updateActivation(focusPos);
    if (activeParticles.length === 0) return;

    const dt = Math.min(0.05, 1 / 60);
    const wX = (windX || 0) * (windStrength || 0) * 0.3;
    const wZ = (windZ || 0) * (windStrength || 0) * 0.3;

    let bIdx = 0, mIdx = 0;

    for (let i = 0; i < activeParticles.length; i++) {
      const d = activeParticles[i];

      // Glide timing
      d.glideTimer += dt;
      if (d.glideTimer > d.glideCycle) {
        d.glideTimer = 0;
        d.glideCycle = 3 + Math.random() * 4;
        d.isGliding = !d.isGliding;
        if (d.isGliding) d.glideDuration = 0.8 + Math.random() * 1.5;
      }
      if (d.isGliding) {
        d.glideDuration -= dt;
        if (d.glideDuration <= 0) d.isGliding = false;
      }

      const speedMul = d.isGliding ? 0.4 : 1.0;
      const curSpeed = d.speed * speedMul;

      // Jitter
      d.jitterTimer -= dt;
      if (d.jitterTimer <= 0) {
        d.jitterTimer = d.jitterInterval * (0.7 + Math.random() * 0.6);
        const bigTurn = Math.random() < 0.15;
        d.jitterYaw = (Math.random() - 0.5) * (bigTurn ? 2.5 : 0.8);
      }
      d.yaw += d.jitterYaw * dt * 3;
      d.jitterYaw *= (1 - dt * 4);

      // Scalloped altitude
      if (d.isGliding) {
        d.flapLiftAccum -= dt * 1.2;
      } else {
        d.flapLiftAccum += dt * 0.6;
      }
      d.flapLiftAccum = Math.max(-1.5, Math.min(1.5, d.flapLiftAccum));

      const bobMul = d.isGliding ? 0.2 : 1.0;
      const bob = Math.sin(elapsed * d.bobFreq + d.bobPhase) * d.bobAmp * bobMul;
      const groundY = sampleHeight(d.emitterX, d.emitterZ);
      const targetY = d.baseY + bob + d.flapLiftAccum;
      d.y += (Math.max(targetY, groundY + 0.5) - d.y) * Math.min(dt * 4, 1);

      // Movement
      d.vx = Math.sin(d.yaw) * curSpeed;
      d.vz = Math.cos(d.yaw) * curSpeed;
      d.x += (d.vx + wX) * dt;
      d.z += (d.vz + wZ) * dt;

      // Contain within emitter zone
      const dx = d.x - d.emitterX, dz = d.z - d.emitterZ;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > d.emitterR * 0.9) {
        const toCenter = Math.atan2(-dx, -dz);
        let dYaw = toCenter - d.yaw;
        if (dYaw >  Math.PI) dYaw -= Math.PI * 2;
        if (dYaw < -Math.PI) dYaw += Math.PI * 2;
        d.yaw += dYaw * dt * 2.5;
      }

      // Banking
      const targetRoll = -d.jitterYaw * 0.6;
      d.roll += (targetRoll - d.roll) * Math.min(dt * 5, 1);
      const pitch = d.isGliding ? -0.25 : -0.08;

      dummy.position.set(d.x, d.y, d.z);
      dummy.rotation.set(pitch, d.yaw, d.roll);
      dummy.scale.setScalar(d.scale);
      dummy.updateMatrix();

      if (d.variant === 0 && imButterfly) {
        imButterfly.setMatrixAt(bIdx++, dummy.matrix);
      } else if (d.variant === 1 && imMoth) {
        imMoth.setMatrixAt(mIdx++, dummy.matrix);
      }
    }

    if (imButterfly) imButterfly.instanceMatrix.needsUpdate = true;
    if (imMoth) imMoth.instanceMatrix.needsUpdate = true;
  }

  // ── Ring visibility ──
  let ringsVisible = true;
  function setRingsVisible(v) {
    ringsVisible = v;
    for (const r of ringLines) r.visible = v;
  }

  // ── Sync heights after terrain sculpt ──
  function syncHeights() {
    for (const em of emitters) {
      const groundY = sampleHeight(em.x, em.z);
      for (const p of (em.particles || [])) {
        p.baseY = groundY + 1.5 + Math.random() * 4.5;
      }
    }
    rebuildRings();
  }

  // ── Save / Load ──
  function getEmitters() {
    return emitters.map(em => ({
      x: em.x, z: em.z, radius: em.radius,
      effectType: em.effectType, density: em.density,
    }));
  }

  function setEmitters(arr) {
    if (imButterfly) { scene.remove(imButterfly); imButterfly.dispose(); imButterfly = null; }
    if (imMoth) { scene.remove(imMoth); imMoth.dispose(); imMoth = null; }
    for (const r of ringLines) scene.remove(r);
    ringLines = [];
    activeParticles = [];
    activeEmitterSet.clear();

    emitters = (arr || []).map(e => ({
      x: e.x, z: e.z, radius: e.radius,
      effectType: e.effectType || "butterflies",
      density: e.density || 3,
      particles: [],
    }));
    rebuildRings();
  }

  function clear() {
    if (imButterfly) { scene.remove(imButterfly); imButterfly.dispose(); imButterfly = null; }
    if (imMoth) { scene.remove(imMoth); imMoth.dispose(); imMoth = null; }
    for (const r of ringLines) scene.remove(r);
    ringLines = [];
    activeParticles = [];
    activeEmitterSet.clear();
    emitters = [];
  }

  function getCount() { return emitters.length; }
  function getParticleCount() { return activeParticles.length; }

  function setFlapSpeed(v)  { uFlapSpeed.value = v; }
  function setFlapAngle(v)  { uFlapAngle.value = v; }
  function setGlideRatio(v) { uGlideRatio.value = v; }

  return {
    addInBrush, removeInBrush,
    update, syncHeights,
    setRingsVisible,
    getEmitters, setEmitters, clear,
    getCount, getParticleCount,
    setFlapSpeed, setFlapAngle, setGlideRatio,
  };
}
