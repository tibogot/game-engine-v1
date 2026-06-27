import * as THREE from "three";

// ── Flag ──────────────────────────────────────────────────────────────────────

export function createFlag(params) {
  const p          = params;
  const poleH      = p.poleHeight    ?? 4;
  const clothW     = p.clothWidth    ?? 1.5;
  const clothH     = p.clothHeight   ?? 0.9;
  const flagColor  = p.flagColor     ?? "#dd2222";

  const poleGeo  = new THREE.CylinderGeometry(0.03, 0.03, poleH, 8);
  const poleMat  = new THREE.MeshStandardMaterial({ color: 0x999999, metalness: 0.6, roughness: 0.4 });
  const pole     = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = poleH / 2;
  pole.castShadow = true;

  const clothGeo = new THREE.PlaneGeometry(clothW, clothH, 10, 5);
  const clothMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(flagColor),
    side: THREE.DoubleSide,
    roughness: 0.95,
  });
  const cloth     = new THREE.Mesh(clothGeo, clothMat);
  cloth.castShadow = true;
  cloth.position.set(clothW * 0.5, poleH - clothH * 0.5, 0);

  const origPos = clothGeo.attributes.position.array.slice();

  const group = new THREE.Group();
  group.add(pole, cloth);
  let time = 0;

  return {
    group,
    update(dt) {
      time += dt;
      const windSpd = (p.windSpeed ?? 600) / 1000;
      const windStr = (p.windIntensity ?? 250) * 0.0015;
      const attr    = clothGeo.attributes.position;
      for (let i = 0; i < attr.count; i++) {
        const ox = origPos[i * 3];
        const t  = ((ox / clothW) + 0.5);    // 0 at pole edge, 1 at tip
        attr.setZ(i, Math.sin(time * windSpd + ox * 4 + origPos[i*3+1]) * t * t * windStr);
      }
      attr.needsUpdate = true;
      clothGeo.computeVertexNormals();
    },
    setParam(key, val) {
      if (key === "flagColor") clothMat.color.set(val);
    },
    dispose() { poleGeo.dispose(); clothGeo.dispose(); poleMat.dispose(); clothMat.dispose(); },
  };
}

// ── Coin ─────────────────────────────────────────────────────────────────────

export function createCoin(params) {
  const p    = params;
  const geo  = new THREE.CylinderGeometry(0.22, 0.22, 0.05, 20);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.8, roughness: 0.2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = Math.PI / 2;
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  let time = 0;
  return {
    group,
    update(dt) {
      time += dt;
      group.rotation.y = time * (p.spinSpeed ?? 2.0);
      group.position.y = Math.sin(time * (p.bobSpeed ?? 1.8)) * (p.bobAmp ?? 0.12);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ── Heart ─────────────────────────────────────────────────────────────────────

export function createHeart(params) {
  const p    = params;
  const geo  = new THREE.SphereGeometry(0.18, 10, 8);
  const mat  = new THREE.MeshStandardMaterial({ color: 0xff2244, roughness: 0.4, metalness: 0.05 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  let time = 0;
  return {
    group,
    update(dt) {
      time += dt;
      const pulse  = 1 + Math.sin(time * (p.bobSpeed ?? 2)) * 0.12;
      group.scale.setScalar(pulse);
      group.rotation.y = time * (p.spinSpeed ?? 0.8);
      group.position.y = Math.abs(Math.sin(time * (p.bobSpeed ?? 2))) * (p.bobAmp ?? 0.15);
    },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}

// ── Key ───────────────────────────────────────────────────────────────────────

export function createKey(params) {
  const p   = params;
  const mat = new THREE.MeshStandardMaterial({ color: 0xddaa00, metalness: 0.7, roughness: 0.3 });
  const group = new THREE.Group();

  const ringGeo  = new THREE.TorusGeometry(0.12, 0.03, 6, 20);
  const ring     = new THREE.Mesh(ringGeo, mat);
  ring.position.y = 0.12;
  ring.castShadow = true;
  group.add(ring);

  const shaftGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.28, 6);
  const shaft    = new THREE.Mesh(shaftGeo, mat);
  shaft.position.set(0, -0.08, 0);
  shaft.castShadow = true;
  group.add(shaft);

  const teethGeo = new THREE.BoxGeometry(0.07, 0.05, 0.025);
  for (let i = 0; i < 2; i++) {
    const tooth = new THREE.Mesh(teethGeo, mat);
    tooth.position.set(0.06, -0.12 - i * 0.07, 0);
    group.add(tooth);
  }

  let time = 0;
  return {
    group,
    update(dt) {
      time += dt;
      group.rotation.y = time * (p.spinSpeed ?? 1.5);
      group.position.y = Math.sin(time * (p.bobSpeed ?? 1.2)) * (p.bobAmp ?? 0.1);
    },
    dispose() { ringGeo.dispose(); shaftGeo.dispose(); teethGeo.dispose(); mat.dispose(); },
  };
}

// ── GLB Collectible (static animated wrapper) ─────────────────────────────────

export function createGlbCollectible(params, gltfScene) {
  const group = new THREE.Group();
  if (gltfScene) group.add(gltfScene.clone());
  const p = params;
  let time = 0;
  return {
    group,
    update(dt) {
      time += dt;
      group.rotation.y = time * (p.spinSpeed ?? 1.0);
      group.position.y = Math.sin(time * (p.bobSpeed ?? 1.0)) * (p.bobAmp ?? 0.1);
    },
  };
}
