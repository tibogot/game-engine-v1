import * as THREE from "three";

/**
 * Simple roadside lamp from the wet-road lab: a tapered post, a straight arm,
 * a sodium box head. Not the cartoon lantern in streetLamp.js.
 *
 * One unit at a point. Arm hangs along local +X so you rotate the prop to hang
 * it over the road. No PointLight by default — same reason the scenery street
 * lamp turns its light off: you line a straight with these, and a real light
 * each is the cost that scales. The emissive head plus bloom is the look.
 */

export const ROAD_LAMP_DEFAULTS = {
  postHeight: 7.2,
  postRadiusTop: 0.09,
  postRadiusBase: 0.13,
  armLength: 1.7,
  armThickness: 0.12,
  headWidth: 0.75,
  headHeight: 0.16,
  headDepth: 0.34,
  colorPost: 0x2b3038,
  colorHead: 0x140d05,
  emissive: 0xffb54a,
  glow: 7,
  roughness: 0.55,
  metalness: 0.6,
  castLight: false,
  lightIntensity: 95,
  lightDistance: 30,
};

/**
 * One lamp, base at y = 0, arm along +X.
 * @param {Partial<typeof ROAD_LAMP_DEFAULTS>} [params]
 * @returns {THREE.Group}
 */
export function buildRoadLampUnit(params = {}) {
  const p = { ...ROAD_LAMP_DEFAULTS, ...params };
  const H = Math.max(2, p.postHeight);
  const armLen = Math.max(0.4, p.armLength);
  const armT = Math.max(0.04, p.armThickness);

  const unit = new THREE.Group();
  unit.name = "RoadLampUnit";

  const postMat = new THREE.MeshStandardMaterial({
    color: p.colorPost,
    roughness: p.roughness,
    metalness: p.metalness,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: p.colorHead,
    emissive: new THREE.Color(p.emissive),
    emissiveIntensity: Math.max(0, p.glow),
    roughness: 0.4,
    metalness: 0.2,
  });

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(p.postRadiusTop, p.postRadiusBase, H, 8),
    postMat,
  );
  post.position.y = H * 0.5;
  post.castShadow = true;
  unit.add(post);

  // Arm centred at armLen/2 so it starts at the post and hangs +X.
  const arm = new THREE.Mesh(new THREE.BoxGeometry(armLen, armT, armT), postMat);
  arm.position.set(armLen * 0.5, H - 0.2, 0);
  arm.castShadow = true;
  unit.add(arm);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(p.headWidth, p.headHeight, p.headDepth),
    headMat,
  );
  // Lab: head centre is 1.65 m out on a 1.7 m arm — slightly past the arm end.
  head.position.set(armLen - p.headWidth * 0.07, H - 0.3, 0);
  head.castShadow = true;
  unit.add(head);

  if (p.castLight) {
    const light = new THREE.PointLight(
      p.emissive,
      p.lightIntensity,
      p.lightDistance,
      2,
    );
    light.position.set(head.position.x, head.position.y - 0.2, 0);
    unit.add(light);
  }

  return unit;
}

/**
 * @param {object} opts
 * @param {THREE.Vector3[]|{x:number,y:number,z:number}[]} [opts.points]
 * @param {object} [opts.params]
 * @param {(x:number,z:number)=>number} [opts.getWorldHeight]
 * @returns {THREE.Group}
 */
export function buildRoadLampMesh({
  points = [{ x: 0, y: 0, z: 0 }],
  params = {},
  getWorldHeight = () => 0,
} = {}) {
  const group = new THREE.Group();
  group.name = "RoadLamp";
  const pt = points[0] ?? { x: 0, y: 0, z: 0 };
  const unit = buildRoadLampUnit(params);
  const x = pt.x ?? 0;
  const z = pt.z ?? 0;
  unit.position.set(x, getWorldHeight(x, z), z);
  group.add(unit);
  return group;
}

export const ROAD_LAMP_HERO_POINTS = [{ x: 0, y: 0, z: -8 }];
