/**
 * QUONSET HQ — the command base of a US firebase, built from the parts kit.
 *
 * The Quonset hut is THE building of the American war in Vietnam: a half-
 * cylinder of corrugated steel over arched ribs, shipped flat and bolted up
 * anywhere. As an HQ it is also the right SHAPE for an RTS: seen from above it
 * is a long ribbed barrel that no other building resembles.
 *
 * SCALE. Built at the game's RTS scale — real size x 1.3, the same factor as
 * its units (nam-rts unitTypes.js RTS_SCALE), so a 2.3 m soldier comes out of
 * a door in proportion. A 40 x 100 ft hangar Quonset (12.2 m across, 6.1 m to
 * the crown) at 1.3x is 15.8 m across and 7.9 m high; 20 m long (a 50 ft
 * hut) keeps it on the base's flattened ground and inside its nav circle. The door is 8 x 5.5 m: a 1.3x tank fits.
 *
 * CONTRACT with the game (structuresRenderer + structures.js), kept from the
 * hangar it replaces: origin at the ground centre, the door on +Z with its
 * mouth 8 m from the origin, everything inside a 24 m nav circle. What moves
 * is separate — the two door leaves, the beacon, the lamps — and setDoor(t)
 * swings the doors: 0 shut, 1 open.
 *
 * One material for all of it (rtsObjectMaterial: per-vertex matId into a
 * surface atlas), so the static shell is ONE draw and ONE shadow caster.
 */
import * as THREE from "three";
import {
  MAT, assemble, bakeContactAO, buildCorrugatedPanel, buildPost, buildSandbagWall, rng, triCount,
} from "./rtsParts.js";
import { rtsObjectMaterial } from "./rtsObjectProps.js";
import { mergeStencils, stencilMesh, stencilPatch } from "./rtsStencils.js";

export const QUONSET_DEFAULTS = {
  scale: 1.3,          // RTS scale: real size x this (sandbags, masts, trim)
  radius: 7.9,         // arch radius = half the width = crown height
  // along Z, back from the door gable. 20, not the 28 it shipped with: on
  // nam-valley the terraced hillside rises 3-12 m from 16 m behind the door,
  // and a 28 m barrel ran into the terrace wall with a megalith on its roof.
  length: 20,
  frontZ: 8,           // the door gable's plane (door mouth, structures.js DOOR_MOUTH)
  doorW: 8, doorH: 5.5,
  corrPitch: 0.6,      // corrugation wavelength along the length, m (RTS-readable)
  corrDepth: 0.07,
  ribEvery: 2.4,       // raised arch rib (a sheet joint) every this many metres
  seed: 11,
};

// ── The arch shell: a new part, a corrugated half-cylinder ───────────────────
/**
 * Outer skin corrugated ALONG THE LENGTH, so the ridges follow the arch over
 * the crown — which is how Quonset sheets are laid and what makes the ribbed
 * barrel read from above. The inner skin is plain and coarse: it is only ever
 * seen through the open door, but without it that view would look straight
 * through a single-sided sheet at the sky.
 *
 * UVs: u along the length (tiles every 4 m), v = height / radius — so the
 * metal texture's rust, which sits at v = 0, gathers at the foot of the arch
 * where water runs off, and never repeats up the wall.
 */
export function buildArchShell({ radius, length, thickness = 0.12, pitch, depth, segArc = 44 } = {}) {
  const segLen = Math.max(8, Math.round((length / pitch) * 3));
  const pos = [], uvs = [], idx = [];
  const ring = segArc + 1;

  // Outer skin: (segLen + 1) x (segArc + 1) vertices.
  for (let j = 0; j <= segLen; j++) {
    const z = (j / segLen) * length;
    const r = radius + Math.sin((z / pitch) * Math.PI * 2) * depth;
    for (let i = 0; i <= segArc; i++) {
      const th = (i / segArc) * Math.PI;           // 0 = +X foot, PI = -X foot
      const x = Math.cos(th) * r, y = Math.sin(th) * r;
      pos.push(x, y, -z);
      uvs.push(z / 4, Math.min(0.999, y / radius));
    }
  }
  for (let j = 0; j < segLen; j++) {
    for (let i = 0; i < segArc; i++) {
      const a = j * ring + i, b = a + 1, c = a + ring, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }

  // Inner skin, coarse: 2 rows along the length, facing inward.
  const inner0 = pos.length / 3;
  const ri = radius - thickness;
  for (let j = 0; j <= 1; j++) {
    const z = j * length;
    for (let i = 0; i <= segArc; i++) {
      const th = (i / segArc) * Math.PI;
      pos.push(Math.cos(th) * ri, Math.sin(th) * ri, -z);
      uvs.push(z / 4, Math.min(0.999, (Math.sin(th) * ri) / radius));
    }
  }
  for (let i = 0; i < segArc; i++) {
    const a = inner0 + i, b = a + 1, c = a + ring, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }

  // End rims at z = 0 and z = -length: close the gap between the skins, so the
  // edge of the sheet has thickness where the gables meet it.
  for (const [jOuter, jInner] of [[0, 0], [segLen, 1]]) {
    const base = pos.length / 3;
    for (let i = 0; i <= segArc; i++) {
      const o = (jOuter * ring + i) * 3, n = (inner0 + jInner * ring + i) * 3;
      pos.push(pos[o], pos[o + 1], pos[o + 2], pos[n], pos[n + 1], pos[n + 2]);
      uvs.push(0, 0.5, 0, 0.5);
    }
    for (let i = 0; i < segArc; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (jOuter === 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A raised strip over the arch — a sheet joint / external rib. */
function buildArchRib(radius, width = 0.18, proud = 0.09, segArc = 36) {
  return buildArchShell({ radius: radius + proud, length: width, thickness: proud + 0.04, pitch: 10, depth: 0, segArc });
}

// ── Gables: vertical timber planks, clipped to the arch ──────────────────────
/**
 * Planks instead of an extruded shape with a hole: every part stays an indexed
 * box (mergeGeometries needs one attribute layout), and a plank gable is what
 * these were — and it reads as timber from above, where a flat face would not.
 * Each plank is cut to the arch at its OUTER edge, so the stepped top tucks
 * under the shell's rim instead of poking through it.
 */
function gablePlanks({ radius, z, door = null, plank = 0.7, thick = 0.22, R }) {
  const parts = [];
  const n = Math.ceil((radius * 2) / plank);
  const w = (radius * 2) / n;
  for (let k = 0; k < n; k++) {
    const x0 = -radius + k * w, x1 = x0 + w;
    const xc = (x0 + x1) / 2;
    const outer = Math.max(Math.abs(x0), Math.abs(x1));
    const top = Math.sqrt(Math.max(0, radius * radius - outer * outer)) + 0.05;
    if (top < 0.3) continue;
    const tone = 0.35 + R() * 0.4;
    if (door && Math.abs(xc) < door.w / 2) {
      // Above the door only: the header.
      const h = top - door.h;
      if (h > 0.05) parts.push({ geo: new THREE.BoxGeometry(w * 0.96, h, thick), pos: [xc, door.h + h / 2, z], mat: MAT.timber, tone });
    } else {
      parts.push({ geo: new THREE.BoxGeometry(w * 0.96, top, thick), pos: [xc, top / 2, z], mat: MAT.timber, tone });
    }
  }
  return parts;
}

// ── The door leaf (a separate, moving mesh) ──────────────────────────────────
export function buildDoorLeaf(w, h, seed) {
  const R = rng(seed);
  const parts = [];
  // Corrugated cladding on a timber frame: the frame is what reads when the
  // leaf swings open edge-on to the camera.
  parts.push({ geo: buildCorrugatedPanel({ width: w - 0.2, height: h - 0.2, thickness: 0.05, ribs: 9, ribDepth: 0.06 }),
    pos: [0, 0.1, 0], mat: MAT.metal, tone: 0.5 + R() * 0.2 });
  const t = 0.26;
  for (const x of [-(w / 2 - t / 2), w / 2 - t / 2]) parts.push({ geo: new THREE.BoxGeometry(t, h, t), pos: [x, h / 2, 0.02], mat: MAT.timber, tone: 0.4 });
  // Rails fit BETWEEN the stiles (1 cm into each) and sit 2 cm back, as framed
  // joinery does: run full width at full depth, their ends and faces were
  // flush with the stiles' and z-fought. The top rail stops 1 cm under the top.
  for (const y of [t / 2, h / 2, h - t / 2 - 0.01]) {
    parts.push({ geo: new THREE.BoxGeometry(w - 2 * t + 0.02, t, t * 0.85), pos: [0, y, 0.02 - t * 0.075], mat: MAT.timber, tone: 0.45 });
  }
  // The diagonal brace every barn door has — a Z you can see from the air.
  const diag = Math.hypot(w - t, h / 2 - t);
  const ang = Math.atan2(h / 2 - t, w - t);
  for (const yc of [h * 0.25, h * 0.75]) {
    parts.push({ geo: new THREE.BoxGeometry(diag, t * 0.8, t * 0.8), pos: [0, yc, 0.04], rot: [0, 0, ang], mat: MAT.timber, tone: 0.5 });
  }
  const geo = assemble(parts);
  bakeContactAO(geo, { cell: 0.5, radius: 1, strength: 0.25, groundFade: 0.2 });
  return geo;
}

// ── The whole HQ ─────────────────────────────────────────────────────────────
/**
 * @returns {{ group, shell, doors: THREE.Mesh[], beacon: THREE.Object3D, lamps: THREE.Object3D,
 *             setDoor(t:number):void, tris:number }}
 * `emissive(color)` builds the glowing material for beacon and lamps (the game
 * passes its bloom material); without it they are plain.
 */
/**
 * The static shell as ONE merged geometry — pad, arch, ribs, gables, door
 * frame, windows, cowls, sandbags, masts — with no material and no renderer,
 * so it can be built (and checked) anywhere, Node included. buildQuonsetHQ
 * adds the moving parts and the lights around it.
 */
export function buildQuonsetShellGeometry(opts = {}) {
  const o = { ...QUONSET_DEFAULTS, ...opts };
  const R = rng(o.seed);
  const Rr = o.radius, L = o.length, F = o.frontZ;
  const parts = [];

  // Earth pad: the building sits on a scraped, raised platform.
  parts.push({ geo: new THREE.BoxGeometry(Rr * 2 + 3, 0.35, L + 3), pos: [0, 0.175, F - L / 2], mat: MAT.earth, tone: 0.45 });

  // Shell, lifted onto the pad.
  const shell = buildArchShell({ radius: Rr, length: L, pitch: o.corrPitch, depth: o.corrDepth });
  parts.push({ geo: shell, pos: [0, 0.3, F], mat: MAT.metal, tone: 0.55 });
  // Joint ribs along the length — the lines that make it a Quonset from above.
  const ribs = Math.floor(L / o.ribEvery);
  for (let k = 0; k <= ribs; k++) {
    // Kept 3 cm inside each end: a rib flush with the shell's end put its rim
    // in the same plane as the shell's, and the two z-fought at the door arch.
    const z = F - Math.min(L - 0.21, Math.max(0.03, k * o.ribEvery));
    parts.push({ geo: buildArchRib(Rr), pos: [0, 0.3, z], mat: MAT.metal, tone: 0.3 + R() * 0.2 });
  }

  // Gables. Front with the door opening and two windows, back solid.
  const door = { w: o.doorW, h: o.doorH };
  parts.push(...gablePlanks({ radius: Rr - 0.05, z: F - 0.2, door, R }).map((p) => ({ ...p, pos: [p.pos[0], p.pos[1] + 0.3, p.pos[2]] })));
  parts.push(...gablePlanks({ radius: Rr - 0.05, z: F - L + 0.2, R }).map((p) => ({ ...p, pos: [p.pos[0], p.pos[1] + 0.3, p.pos[2]] })));
  // Door frame: posts and a lintel, proud of the planks.
  for (const x of [-door.w / 2 - 0.2, door.w / 2 + 0.2]) {
    parts.push({ geo: new THREE.BoxGeometry(0.45, door.h + 0.6, 0.45), pos: [x, 0.3 + (door.h + 0.6) / 2, F - 0.05], mat: MAT.timber, tone: 0.3 });
  }
  // Lintel top 3 cm clear of the gable planks' row: 1 mm apart, the two tops shimmered.
  parts.push({ geo: new THREE.BoxGeometry(door.w + 1.3, 0.5, 0.5), pos: [0, 0.3 + door.h + 0.28, F - 0.05], mat: MAT.timber, tone: 0.3 });
  // Windows in the gable either side of the door: dark glass in timber frames.
  for (const sx of [-1, 1]) {
    const x = sx * (door.w / 2 + 1.6);
    parts.push({ geo: new THREE.BoxGeometry(1.4, 1.1, 0.1), pos: [x, 3.6, F - 0.02], mat: MAT.metal, tone: 0.0 });
    parts.push({ geo: new THREE.BoxGeometry(1.7, 0.16, 0.3), pos: [x, 3.0, F + 0.02], mat: MAT.timber, tone: 0.6 });
    parts.push({ geo: new THREE.BoxGeometry(1.7, 0.16, 0.3), pos: [x, 4.2, F + 0.02], mat: MAT.timber, tone: 0.6 });
  }

  // Vent cowls along the crown.
  for (let k = 0; k < 3; k++) {
    const z = F - L * (0.25 + k * 0.25);
    parts.push({ geo: new THREE.CylinderGeometry(0.45, 0.55, 1.1, 10), pos: [0, 0.3 + Rr + 0.45, z], mat: MAT.metal, tone: 0.35 });
    parts.push({ geo: new THREE.CylinderGeometry(0.75, 0.75, 0.12, 10), pos: [0, 0.3 + Rr + 1.05, z], mat: MAT.metal, tone: 0.3 });
  }

  // Sandbag skirt along both long sides, two courses, hugging the foot of the arch.
  const bag = { length: 0.52 * o.scale, width: 0.30 * o.scale, height: 0.19 * o.scale };
  for (const sx of [-1, 1]) {
    const wall = buildSandbagWall({ length: L - 1, courses: 2, seed: 20 + (sx > 0 ? 1 : 0), bag });
    parts.push({ geo: wall, pos: [sx * (Rr + 0.45), 0.35, F - L / 2], rot: [0, Math.PI / 2, 0], mat: null });
  }
  // L-shaped blast walls off the front corners: they shield the door.
  for (const sx of [-1, 1]) {
    const a = buildSandbagWall({ length: 5.5, courses: 3, seed: 30 + (sx > 0 ? 1 : 0), bag });
    parts.push({ geo: a, pos: [sx * (Rr + 2.2), 0, F + 2.2], rot: [0, Math.PI / 2, 0], mat: null });
    const b = buildSandbagWall({ length: 3.5, courses: 3, seed: 40 + (sx > 0 ? 1 : 0), bag });
    parts.push({ geo: b, pos: [sx * (Rr + 0.8), 0, F + 4.8], rot: [0, 0, 0], mat: null });
  }

  // Radio masts at the back: the tall one carries the beacon.
  const mastH = 16 * o.scale, mast2H = 11 * o.scale;
  // Beside the rear corners, not behind the building: whatever stands behind
  // an HQ is outside the ground its site flattened (on nam-valley, a terrace).
  const mastPos = [-(Rr + 2.6), F - L + 2.5], mast2Pos = [Rr + 2.4, F - L + 4.5];
  parts.push({ geo: buildPost({ height: mastH, width: 0.42, depth: 0.42, taper: 0.5, round: true }), pos: [mastPos[0], 0, mastPos[1]], mat: MAT.metal, tone: 0.25 });
  parts.push({ geo: buildPost({ height: mast2H, width: 0.34, depth: 0.34, taper: 0.5, round: true }), pos: [mast2Pos[0], 0, mast2Pos[1]], mat: MAT.metal, tone: 0.25 });
  // Cross-arms: the silhouette that says "antenna", not "pole".
  parts.push({ geo: new THREE.BoxGeometry(3.2, 0.14, 0.14), pos: [mastPos[0], mastH * 0.82, mastPos[1]], mat: MAT.metal, tone: 0.2 });
  parts.push({ geo: new THREE.BoxGeometry(2.2, 0.12, 0.12), pos: [mast2Pos[0], mast2H * 0.85, mast2Pos[1]], mat: MAT.metal, tone: 0.2 });

  const shellGeo = assemble(parts);
  shell.dispose();
  bakeContactAO(shellGeo, { cell: 0.6, radius: 2, strength: 0.4, groundFade: 0.3, floor: 0.5 });
  shellGeo.userData.stencil = quonsetStars(o, ribs);
  return { shellGeo, o, door, F, mastPos, mastH };
}

/**
 * The Army star in its ring, white, on each flank of the arch — what makes the
 * barrel read as AMERICAN from the air. Painted ON the sheet: the patch follows
 * the corrugation and rides up over the joint ribs, with a station either side
 * of every rib edge so no rib pokes through the paint.
 */
function quonsetStars(o, ribs) {
  const Rr = o.radius, L = o.length, F = o.frontZ, lift = 0.02;
  const ribW = 0.18, ribProud = 0.09;
  const ribZ = [];
  for (let k = 0; k <= ribs; k++) ribZ.push(F - Math.min(L - 0.21, Math.max(0.03, k * o.ribEvery)));
  // Outer radius of the roof at local z: the corrugated sheet, or a rib on it.
  const radiusAt = (z) => {
    for (const zr of ribZ) if (z <= zr + 1e-4 && z >= zr - ribW - 1e-4) return Rr + ribProud;
    return Rr + Math.sin(((F - z) / o.corrPitch) * Math.PI * 2) * o.corrDepth;
  };
  const size = 4.6;                     // the ring's diameter, m
  const zc = F - L / 2;                 // centred along the barrel
  const arc = size / Rr;                // its angular height on the arch
  const thC = 0.62;                     // centre, radians down from the crown
  const out = [];
  for (const sx of [-1, 1]) {
    // s runs along the barrel (the viewer's right), t up the flank to the crown.
    // Seen from outside the +X flank, the viewer's right is -Z.
    const zAt = (s) => zc - sx * (s - 0.5) * size;
    const sList = [];
    for (let i = 0; i <= 60; i++) sList.push(i / 60);
    for (const zr of ribZ) for (const z of [zr + 0.004, zr - 0.004, zr - ribW + 0.004, zr - ribW - 0.004]) {
      const s = (zc - z) / (sx * size) + 0.5;
      if (s > 0 && s < 1) sList.push(s);
    }
    sList.sort((a, b) => a - b);
    out.push(stencilPatch("star", (s, t) => {
      const z = zAt(s);
      const th = Math.PI / 2 - sx * (thC + (0.5 - t) * arc);   // angle from +X foot
      const r = radiusAt(z) + lift;
      const n = new THREE.Vector3(Math.cos(th), Math.sin(th), 0);
      return { p: new THREE.Vector3(Math.cos(th) * r, 0.3 + Math.sin(th) * r, z), n };
    }, { segT: 16, sList, lift: 0 }));
  }
  return mergeStencils(out);
}

export function buildQuonsetHQ(opts = {}, emissive = null) {
  const { shellGeo, door, F, mastPos, mastH } = buildQuonsetShellGeometry(opts);
  const mat = rtsObjectMaterial();
  const group = new THREE.Group();
  group.name = "QuonsetHQ";
  const shellMesh = new THREE.Mesh(shellGeo, mat);
  shellMesh.castShadow = shellMesh.receiveShadow = true;
  group.add(shellMesh);
  const stars = stencilMesh(shellGeo.userData.stencil);
  if (stars) shellMesh.add(stars);

  // Doors: hinged at the outer edge of the opening, swinging OUT toward +Z.
  const leafW = door.w / 2, leafH = door.h;
  const doors = [];
  for (const sx of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(sx * door.w / 2, 0.3, F + 0.05);
    const leaf = new THREE.Mesh(buildDoorLeaf(leafW - 0.06, leafH - 0.05, 50 + sx), mat);
    // The leaf's own origin is its centre-bottom; put its outer edge on the hinge.
    leaf.position.set(-sx * leafW / 2, 0, 0.14);
    leaf.castShadow = leaf.receiveShadow = true;
    hinge.add(leaf);
    hinge.userData.side = sx;
    group.add(hinge);
    doors.push(hinge);
  }
  const OPEN = THREE.MathUtils.degToRad(100);
  const setDoor = (t) => {
    const k = THREE.MathUtils.smoothstep(Math.max(0, Math.min(1, t)), 0, 1);
    for (const h of doors) h.rotation.y = h.userData.side * k * OPEN;
  };
  setDoor(0);

  // Beacon: a red aviation light atop the tall mast.
  const beaconMat = emissive ? emissive(0xff3a2a) : new THREE.MeshBasicMaterial({ color: 0xff3a2a });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), beaconMat);
  beacon.position.set(mastPos[0], mastH + 0.3, mastPos[1]);
  group.add(beacon);

  // Work lamps over the door: amber, brighter while the base is producing.
  const lampMat = emissive ? emissive(0xffb14a) : new THREE.MeshBasicMaterial({ color: 0xffb14a });
  const lampGeo = new THREE.BoxGeometry(0.55, 0.3, 0.3);
  const lamps = new THREE.Group();
  for (const sx of [-1, 1]) {
    const l = new THREE.Mesh(lampGeo, lampMat);
    l.position.set(sx * (door.w / 2 + 0.2), 0.3 + door.h + 0.75, F + 0.25);
    lamps.add(l);
  }
  group.add(lamps);

  const tris = triCount(shellGeo) + doors.reduce((n, h) => n + triCount(h.children[0].geometry), 0);
  return { group, shell: shellMesh, doors, beacon, lamps, setDoor, tris };
}
