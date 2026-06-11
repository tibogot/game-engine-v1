import * as THREE from "three";

const DAMPING = 0.97;
const DRAG = 0.1;
const MASS = 0.1;
const INTERNAL_REST = 25;
const TIMESTEP_SQ = 0.018 * 0.018;

const _gravity = new THREE.Vector3(0, -981 * 1.4, 0).multiplyScalar(DRAG);
const _windForce = new THREE.Vector3();
const _tmpForce = new THREE.Vector3();
const _diff = new THREE.Vector3();

class Particle {
  constructor(x, y, z) {
    this.position = new THREE.Vector3(x, y, z);
    this.previous = new THREE.Vector3(x, y, z);
    this.original = new THREE.Vector3(x, y, z);
    this.a = new THREE.Vector3();
    this.invMass = 1 / MASS;
    this._t1 = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
  }

  addForce(f) {
    this.a.add(this._t2.copy(f).multiplyScalar(this.invMass));
  }

  integrate(tsq) {
    const newPos = this._t1.subVectors(this.position, this.previous);
    newPos.multiplyScalar(DAMPING).add(this.position);
    newPos.add(this.a.multiplyScalar(tsq));
    this.previous.copy(this.position);
    this.position.copy(newPos);
    this.a.set(0, 0, 0);
  }
}

function satisfyConstraint(p1, p2, rest) {
  _diff.subVectors(p2.position, p1.position);
  const d = _diff.length();
  if (d === 0) return;
  _diff.multiplyScalar((1 - rest / d) * 0.5);
  p1.position.add(_diff);
  p2.position.sub(_diff);
}

function buildCloth(xSegs, ySegs, clothWidth, clothHeight) {
  const aspect = clothWidth / clothHeight;
  const restY = 2 * INTERNAL_REST / (aspect * ySegs / xSegs + 1);
  const restX = aspect * restY * ySegs / xSegs;

  const w = restX * xSegs;
  const h = restY * ySegs;
  const particles = [];
  const constraints = [];
  const idx = (u, v) => u + v * (xSegs + 1);

  for (let v = 0; v <= ySegs; v++) {
    for (let u = 0; u <= xSegs; u++) {
      particles.push(new Particle(u * restX, v * restY, 0));
    }
  }

  for (let v = 0; v < ySegs; v++) {
    for (let u = 0; u < xSegs; u++) {
      constraints.push([particles[idx(u, v)], particles[idx(u, v + 1)], restY]);
      constraints.push([particles[idx(u, v)], particles[idx(u + 1, v)], restX]);
    }
  }
  for (let v = 0; v < ySegs; v++) {
    constraints.push([particles[idx(xSegs, v)], particles[idx(xSegs, v + 1)], restY]);
  }
  for (let u = 0; u < xSegs; u++) {
    constraints.push([particles[idx(u, ySegs)], particles[idx(u + 1, ySegs)], restX]);
  }

  const pins = [];
  for (let v = 0; v <= ySegs; v++) pins.push(idx(0, v));

  return { particles, constraints, pins, w, h, xSegs, ySegs, restX, restY };
}

function buildClothGeometry(xSegs, ySegs, restX, restY) {
  const count = (xSegs + 1) * (ySegs + 1);
  const pos = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices = [];

  for (let v = 0; v <= ySegs; v++) {
    for (let u = 0; u <= xSegs; u++) {
      const i = u + v * (xSegs + 1);
      pos[i * 3] = u * restX;
      pos[i * 3 + 1] = v * restY;
      pos[i * 3 + 2] = 0;
      uvs[i * 2] = u / xSegs;
      uvs[i * 2 + 1] = v / ySegs;
    }
  }

  for (let v = 0; v < ySegs; v++) {
    for (let u = 0; u < xSegs; u++) {
      const a = u + v * (xSegs + 1);
      const b = a + 1;
      const c = a + (xSegs + 1);
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export const FLAG_DEFAULTS = {
  clothWidth: 2.0,
  clothHeight: 1.4,
  poleHeight: 4.0,
  poleRadius: 0.04,
  xSegs: 10,
  ySegs: 8,
  textureUrl: "",
  flagColor: "#cc0000",
  windIntensity: 300,
  windSpeed: 1000,
  windDirection: 0,
  showPole: true,
};

export function flagBoundingBox(params) {
  const p = { ...FLAG_DEFAULTS, ...params };
  return new THREE.Box3(
    new THREE.Vector3(-p.poleRadius, 0, -p.clothWidth * 0.5),
    new THREE.Vector3(p.clothWidth + p.poleRadius, p.poleHeight, p.clothWidth * 0.5),
  );
}

export function createFlagProp(params = {}) {
  const p = { ...FLAG_DEFAULTS, ...params };

  const cloth = buildCloth(p.xSegs, p.ySegs, p.clothWidth, p.clothHeight);
  const geometry = buildClothGeometry(p.xSegs, p.ySegs, cloth.restX, cloth.restY);

  const uniformScale = p.clothWidth / cloth.w;

  const group = new THREE.Group();

  // Pole
  const poleGeo = new THREE.CylinderGeometry(p.poleRadius, p.poleRadius, p.poleHeight, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.5, metalness: 0.4 });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = p.poleHeight * 0.5;
  pole.castShadow = true;
  pole.receiveShadow = true;
  pole.visible = p.showPole;
  group.add(pole);

  // Cloth mesh
  const clothMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(p.flagColor),
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0.0,
  });
  const clothMesh = new THREE.Mesh(geometry, clothMat);
  clothMesh.scale.setScalar(uniformScale);
  clothMesh.position.set(0, p.poleHeight - p.clothHeight, 0);
  clothMesh.castShadow = true;
  group.add(clothMesh);

  // Texture
  if (p.textureUrl) _loadTexture(clothMat, p.textureUrl);

  // State
  let windIntensity = p.windIntensity;
  let windSpeed = p.windSpeed;
  let windDirection = p.windDirection;
  let elapsed = Math.random() * 5000;

  function update(dt) {
    elapsed += dt * 1000;

    const osc = Math.sin(elapsed / windSpeed);
    const rad = windDirection * (Math.PI / 180);
    _windForce.set(Math.cos(rad) * 100, 0, Math.sin(rad) * 100 + osc).normalize().multiplyScalar(windIntensity);

    const particles = cloth.particles;
    const normals = geometry.attributes.normal;
    const indices = geometry.index;

    const normal = new THREE.Vector3();
    for (let i = 0, il = indices.count; i < il; i += 3) {
      for (let j = 0; j < 3; j++) {
        const idx = indices.getX(i + j);
        normal.fromBufferAttribute(normals, idx);
        _tmpForce.copy(normal).normalize().multiplyScalar(normal.dot(_windForce));
        particles[idx].addForce(_tmpForce);
      }
    }

    for (const pt of particles) {
      pt.addForce(_gravity);
      pt.integrate(TIMESTEP_SQ);
    }

    for (const c of cloth.constraints) satisfyConstraint(c[0], c[1], c[2]);

    for (const pin of cloth.pins) {
      particles[pin].position.copy(particles[pin].original);
      particles[pin].previous.copy(particles[pin].original);
    }

    const posAttr = geometry.attributes.position;
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      posAttr.setXYZ(i, pt.position.x, pt.position.y, pt.position.z);
    }
    posAttr.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  function setParam(key, value) {
    if (key === "windIntensity") windIntensity = value;
    else if (key === "windSpeed") windSpeed = value;
    else if (key === "windDirection") windDirection = value;
    else if (key === "flagColor") clothMat.color.set(value);
    else if (key === "textureUrl") _loadTexture(clothMat, value);
    else if (key === "showPole") pole.visible = value;
  }

  function getParams() {
    return {
      clothWidth: p.clothWidth,
      clothHeight: p.clothHeight,
      poleHeight: p.poleHeight,
      poleRadius: p.poleRadius,
      xSegs: p.xSegs,
      ySegs: p.ySegs,
      textureUrl: p.textureUrl,
      flagColor: p.flagColor,
      windIntensity,
      windSpeed,
      windDirection,
      showPole: pole.visible,
    };
  }

  function dispose() {
    geometry.dispose();
    clothMat.dispose();
    if (clothMat.map) clothMat.map.dispose();
    poleGeo.dispose();
    poleMat.dispose();
  }

  return { group, update, dispose, setParam, getParams };
}

function _loadTexture(mat, url) {
  if (!url) {
    if (mat.map) { mat.map.dispose(); mat.map = null; }
    mat.needsUpdate = true;
    return;
  }
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    if (mat.map) mat.map.dispose();
    mat.map = tex;
    mat.needsUpdate = true;
  });
}
