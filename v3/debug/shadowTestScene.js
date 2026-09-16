/**
 * SHADOW TEST SCENE — a ruler for judging the cascades with your own eyes.
 *
 * Shadow quality arguments are made of numbers that mean nothing until you look
 * at them: "1.15 cm per texel out to 10 m, 15.8 cm out to 150 m" only becomes
 * real when you can see a comb's shadow stay separate up close and smear into a
 * grey band far away. So this lays identical test stations along a line running
 * away from you, at distances chosen to straddle the cascade splits and the end
 * of the shadow map.
 *
 * Every station is the SAME physical size. That is the point: it shows the
 * degradation a player actually sees, not a normalised one.
 *
 * Each station carries four things, each answering a different question:
 *   pole    — a long thin shadow. Is the edge crisp or chewed?
 *   arch    — a bar held above the ground on two legs. Does its shadow stay
 *             attached to its legs (bias) or float free (peter-panning)?
 *   comb    — six thin bars 18 cm apart. The texel ruler: when a texel grows
 *             past the gap, six shadows become one grey smear. This is the
 *             control that makes cascade boundaries obvious.
 *   ball    — resting on the ground. The contact shadow, the thing maxFar 80
 *             was originally chosen to protect.
 *
 * Coloured strips lie across the line at each cascade split and a red one at
 * maxFar, and they MOVE when you change the split settings — so you can watch a
 * boundary slide through the stations, and watch shadows die at the red line.
 */
import * as THREE from "three";

/**
 * Where stations go. Chosen to bracket the default splits (10 / 39 / 150 m) and
 * to straddle maxFar, and spaced far enough apart that their pads never touch.
 */
const STATIONS = [3, 8, 15, 25, 40, 60, 85, 115, 145, 175];

/** One colour per cascade, plus red for the end of the shadow map. */
const CASCADE_COLORS = [0x4ea3ff, 0x46d17a, 0xffcc44, 0xc08bff];
const BEYOND_COLOR = 0xff5a5a;

/**
 * Labels do NOT shrink with distance (`sizeAttenuation: false`). A ruler whose
 * far end is unreadable is no ruler: the 175 m station needs its number just as
 * much as the 3 m one, and a distance-scaled sprite at 3 m fills the screen.
 */
function makeLabelSprite(text, sub, color = "#ffffff") {
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 112;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "rgba(10,12,16,0.78)";
  ctx.fillRect(0, 0, 256, 112);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 256, 6);
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 52px system-ui, sans-serif";
  ctx.fillText(text, 128, 62);
  if (sub) {
    ctx.fillStyle = "#9fb4c8";
    ctx.font = "28px system-ui, sans-serif";
    ctx.fillText(sub, 128, 98);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, sizeAttenuation: false,
  }));
  spr.renderOrder = 999;
  spr.scale.set(0.085, 0.037, 1);
  return spr;
}

/**
 * @param {object}   o
 * @param {THREE.Scene} o.scene
 * @param {(x:number,z:number)=>number} [o.getWorldHeight] drops the ruler onto the terrain
 */
export function createShadowTestScene({ scene, getWorldHeight }) {
  const group = new THREE.Group();
  group.name = "ShadowTestScene";
  group.visible = false;
  scene.add(group);

  // One material for everything that casts: a shadow reads best off plain
  // matte white, and sharing it keeps this to a handful of pipelines.
  // The pad stays near-white whatever cascade it is in: a shadow judged against
  // a saturated colour is not judged at all. The cascade colour goes on a thin
  // ring round its edge instead, well clear of where the shadows land.
  const white = new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.92, metalness: 0 });
  const padMat = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.95, metalness: 0 });
  const owned = [white, padMat];

  // Everything is kept SHORT relative to the pad so that at a normal sun angle
  // each shadow lands on its own white disc instead of running off onto the
  // terrain. A shadow read against flat white is a shadow you can actually
  // judge; the same shadow crossing painted ground is guesswork.
  const geo = {
    pad: new THREE.CylinderGeometry(2.0, 2.0, 0.04, 32),
    ring: new THREE.TorusGeometry(2.02, 0.07, 6, 34),
    pole: new THREE.BoxGeometry(0.12, 1.6, 0.12),
    leg: new THREE.BoxGeometry(0.1, 0.9, 0.1),
    bar: new THREE.BoxGeometry(1.1, 0.1, 0.12),
    tooth: new THREE.BoxGeometry(0.06, 0.7, 0.06),
    ball: new THREE.SphereGeometry(0.35, 20, 14),
    strip: new THREE.BoxGeometry(26, 0.03, 0.35),
  };
  for (const g of Object.values(geo)) owned.push(g);

  const stations = [];   // { distance, group, label }
  const markers = [];    // { mesh, mat }
  let origin = new THREE.Vector3();
  let dirX = 1, dirZ = 0;

  function addMesh(parent, geometry, material, x, y, z) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  function buildStation(distance) {
    const g = new THREE.Group();

    // The pad receives; it does not cast, or it would shadow itself at grazing
    // sun angles and muddy every contact shadow above it.
    const pad = new THREE.Mesh(geo.pad, padMat);
    pad.position.y = 0.02;
    pad.receiveShadow = true;
    pad.castShadow = false;
    g.add(pad);

    const ringMat = new THREE.MeshBasicMaterial({ color: 0x4ea3ff });
    owned.push(ringMat);
    const ring = new THREE.Mesh(geo.ring, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    g.add(ring);

    addMesh(g, geo.pole, white, -1.15, 0.82, 0);             // long thin shadow
    addMesh(g, geo.leg, white, 0.05, 0.47, -0.42);           // arch: gap under it
    addMesh(g, geo.leg, white, 0.05, 0.47, 0.42);
    addMesh(g, geo.bar, white, 0.05, 0.97, 0).rotation.y = Math.PI / 2;
    for (let i = 0; i < 6; i++) {                            // the texel ruler
      addMesh(g, geo.tooth, white, 1.0, 0.37, -0.45 + i * 0.18);
    }
    addMesh(g, geo.ball, white, -0.5, 0.35, 0.95);           // contact shadow

    const label = makeLabelSprite(`${distance} m`, "");
    label.position.set(0, 2.3, 0);
    g.add(label);

    return { group: g, label, ring: ringMat };
  }

  function build() {
    if (stations.length) return;
    for (const d of STATIONS) {
      const { group: g, label, ring } = buildStation(d);
      group.add(g);
      stations.push({ distance: d, group: g, label, ring });
    }
    for (let i = 0; i < CASCADE_COLORS.length + 1; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
      owned.push(mat);
      const m = new THREE.Mesh(geo.strip, mat);
      m.visible = false;
      group.add(m);
      markers.push({ mesh: m, mat });
    }
    place();
  }

  /** Lay the ruler out from `origin` along (dirX, dirZ), sitting on the ground. */
  function place() {
    const h = (x, z) => (getWorldHeight ? getWorldHeight(x, z) : 0);
    for (const st of stations) {
      const x = origin.x + dirX * st.distance;
      const z = origin.z + dirZ * st.distance;
      st.group.position.set(x, h(x, z), z);
      st.group.rotation.y = Math.atan2(dirX, dirZ);
    }
    for (const mk of markers) {
      const d = mk.mesh.userData.distance ?? 0;
      const x = origin.x + dirX * d;
      const z = origin.z + dirZ * d;
      mk.mesh.position.set(x, h(x, z) + 0.06, z);
      mk.mesh.rotation.y = Math.atan2(dirX, dirZ);
    }
  }

  /**
   * Put the ruler in front of the camera and point it away, so "stand here and
   * look down the line" is one click rather than a minute of orbiting.
   */
  function layOutFrom(camera, controls) {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    dirX = fwd.x;
    dirZ = fwd.z;
    const t = controls?.target;
    origin.set(t ? t.x : camera.position.x, 0, t ? t.z : camera.position.z);
    place();
  }

  /**
   * Stand near the start of the line looking along it — but OFFSET to one side
   * and a little above. Dead on the axis every station hides the one behind it,
   * which is exactly the comparison the scene exists to make.
   */
  function focus(camera, controls) {
    const h = (x, z) => (getWorldHeight ? getWorldHeight(x, z) : 0);
    const px = dirZ, pz = -dirX;                        // left of the line
    const cx = origin.x - dirX * 12 + px * 10;
    const cz = origin.z - dirZ * 12 + pz * 10;
    // High enough to look DOWN onto the pads. From eye height the discs are
    // edge-on and their shadows are the first thing you lose.
    camera.position.set(cx, h(cx, cz) + 9, cz);
    if (controls) {
      const t = 45;
      const tx = origin.x + dirX * t, tz = origin.z + dirZ * t;
      controls.target.set(tx, h(tx, tz) + 1.0, tz);
      controls.update();
    }
  }

  /**
   * Recolour the stations by the cascade they fall in and move the split
   * markers. `desc` is worldEnvironment.describeCsm(); pass null to grey out.
   */
  function syncFromCsm(desc) {
    if (!group.visible) return;
    const bands = desc?.cascades ?? [];
    for (const st of stations) {
      const i = bands.findIndex((c) => st.distance <= c.far);
      const inRange = i >= 0;
      const col = inRange ? CASCADE_COLORS[i % CASCADE_COLORS.length] : BEYOND_COLOR;
      const texel = inRange ? bands[i].texel * 100 : 0;
      const sub = inRange ? `C${i} · ${texel >= 10 ? Math.round(texel) : texel.toFixed(1)} cm` : "no shadow";
      const key = `${st.distance}|${sub}`;
      if (st.group.userData.labelKey !== key) {
        st.group.userData.labelKey = key;
        const old = st.label;
        const next = makeLabelSprite(`${st.distance} m`, sub, `#${col.toString(16).padStart(6, "0")}`);
        next.position.copy(old.position);
        st.group.remove(old);
        old.material.map.dispose();
        old.material.dispose();
        st.group.add(next);
        st.label = next;
      }
      st.ring.color.setHex(col);
    }
    for (let i = 0; i < markers.length; i++) {
      const mk = markers[i];
      const band = bands[i];
      const last = i === bands.length;
      if (!band && !last) { mk.mesh.visible = false; continue; }
      const d = last ? (bands[bands.length - 1]?.far ?? 0) : band.far;
      mk.mesh.visible = d > 0;
      mk.mesh.userData.distance = d;
      mk.mat.color.setHex(last ? BEYOND_COLOR : CASCADE_COLORS[i % CASCADE_COLORS.length]);
      mk.mat.opacity = last ? 0.95 : 0.7;
    }
    place();
  }

  function setVisible(on) {
    if (on) build();
    group.visible = !!on;
  }

  function dispose() {
    scene.remove(group);
    group.traverse((o) => {
      if (o.isSprite) { o.material.map?.dispose(); o.material.dispose(); }
    });
    for (const r of owned) r.dispose?.();
    stations.length = 0;
    markers.length = 0;
  }

  return {
    get visible() { return group.visible; },
    setVisible,
    layOutFrom,
    focus,
    syncFromCsm,
    dispose,
  };
}
