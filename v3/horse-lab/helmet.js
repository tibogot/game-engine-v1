// ── Horse lab: a knight's GREAT HELM (procedural) ─────────────────────────────
// After the 13th-century barrel helms: an oval shell fitted to the head (~1.8 cm
// off it — room for the padded arming cap), its face plate drawn to a slight
// central ridge (a keel, not a round bucket), a gently domed crown plate riveted
// on, an eye slit that is a real gap under the lip of the upper plate, a brass
// cross on the face, breathing holes set in a cross, a rolled rim, and hammered
// steel (its shine varies across the plates). Sized from the rider's own head (the
// skinned vertices that follow the head bone): fits the robot and Y Bot alike.
// Parented to the head bone; hidden until chosen (headgear: hat / helmet / none).
import * as THREE from "three";

const V3 = THREE.Vector3;
const PAD = 0.018;                                   // m between the head and the steel

// hammered steel: blotchy shine (roughness) and a faint tone variation
function hammeredTextures() {
  const n = 256, mk = () => { const c = document.createElement("canvas"); c.width = c.height = n; return [c, c.getContext("2d")]; };
  const [cr, gr] = mk(), [cc, gc] = mk();
  gr.fillStyle = "#6e6e6e"; gr.fillRect(0, 0, n, n); gc.fillStyle = "#e8e8e8"; gc.fillRect(0, 0, n, n);
  let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {                    // hammer marks: small soft dents
    const x = rnd() * n, y = rnd() * n, r = 3 + rnd() * 7, v = Math.floor(80 + rnd() * 70), t = Math.floor(205 + rnd() * 50);
    for (const [g, col] of [[gr, `rgba(${v},${v},${v},0.35)`], [gc, `rgba(${t},${t},${t},0.25)`]]) {
      const gd = g.createRadialGradient(x, y, 0, x, y, r); gd.addColorStop(0, col); gd.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = (c, srgb) => { const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1, 1); if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  return { rough: tex(cr, false), tone: tex(cc, true) };
}

export function addHelmet(rider) {
  const head = rider.B.head, r = rider.r;
  r.rig.updateMatrixWorld(true);
  // the head's extents in the rig's frame (x side, y up, z forward): its own vertices
  let skin = null; r.model.traverse((o) => { if (o.isSkinnedMesh && !skin) skin = o; });
  const hi = skin.skeleton.bones.indexOf(head), g = skin.geometry, sw = g.attributes.skinWeight, si = g.attributes.skinIndex;
  const box = new THREE.Box3(), p = new V3();
  for (let i = 0; i < g.attributes.position.count; i++) {
    let w = 0; for (let c = 0; c < 4; c++) if (si.getComponent(i, c) === hi) w += sw.getComponent(i, c);
    if (w < 0.6) continue;
    skin.getVertexPosition(i, p); p.applyMatrix4(skin.matrixWorld); box.expandByPoint(r.rig.worldToLocal(p));
  }
  const c = box.getCenter(new V3());
  const rx = (box.max.x - box.min.x) / 2 + PAD, rz = (box.max.z - box.min.z) / 2 + PAD;   // (oval: its own width and depth)
  const base = box.min.y - 0.02, H = box.max.y + PAD + 0.008 - base;

  const T = hammeredTextures();
  const steel = new THREE.MeshStandardMaterial({ color: 0x9da3a9, metalness: 0.85, roughness: 0.48, roughnessMap: T.rough });   // (the shine varies; no tone map — stretched round the shell it read as dirt)
  const brass = new THREE.MeshStandardMaterial({ color: 0xa8843f, metalness: 0.85, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 1 });
  const helm = new THREE.Group();
  const add = (geo, mat, shadow = true) => { const m = new THREE.Mesh(geo, mat); m.castShadow = shadow; m.receiveShadow = true; helm.add(m); return m; };

  // the shell's radius share by height (0 rim … 1 top): straight sides, a low domed crown
  const SL = new THREE.SplineCurve([[1.03, 0], [1.0, 0.02], [0.995, 0.45], [0.985, 0.8], [0.93, 0.9], [0.7, 0.965], [0.35, 0.993], [0, 1]].map(([k, u]) => new THREE.Vector2(k, u)));
  const prof = SL.getPoints(48).map((v) => [Math.max(1e-4, v.x), Math.min(1, v.y)]); prof[prof.length - 1] = [1e-4, 1];
  const kAt = (u) => prof.find(([, uu]) => uu >= u)?.[0] ?? 1;
  const RIDGE = 0.012, EYE = 0.62;                   // m the face's keel stands out; the eye slit's height share
  // a point on the shell: unit lathe (k, u, phi) → oval, the face drawn to its keel
  const shellAt = (k, u, phi, out = 0) => {
    const x = Math.sin(phi) * (k * rx + out), zc = Math.cos(phi), z = zc * (k * rz + out);
    const keel = zc > 0 ? RIDGE * k * Math.exp(-((x / (0.33 * rx)) ** 2)) * zc * (u < 0.86 ? 1 : Math.max(0, 1 - (u - 0.86) / 0.1)) : 0;
    return new V3(x, u * H, z + keel);
  };
  // a lathe-like surface from a profile [(k, u, out)] over [phi0, phi0+phiL]
  const surface = (pr, seg, phi0 = -Math.PI, phiL = Math.PI * 2) => {
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= seg; i++) for (let j = 0; j < pr.length; j++) {
      const phi = phi0 + (i / seg) * phiL, [k, u, o] = pr[j], v = shellAt(k, u, phi, o);
      pos.push(v.x, v.y, v.z); uv.push(phi * (rx + rz) / 2 / 0.12, v.y / 0.12);
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < pr.length - 1; j++) {
      const a = i * pr.length + j, b = (i + 1) * pr.length + j;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  };
  // the shell, outside then back down inside (a plate has a thickness), the eye slit cut in
  // the face: the face below the slit and the plate above it are separate pieces, and the
  // upper plate's lip overlaps the slit
  const SLIT = [EYE - 0.035, EYE];                   // height shares of the gap
  const shell = (u0, u1, inner = false) => prof.filter(([, u]) => u >= u0 && u <= u1).map(([k, u]) => [k, u, inner ? -0.004 : 0]);
  const both = (u0, u1) => shell(u0, u1).concat(shell(u0, u1, true).reverse());
  const FW = 1.25;                                   // rad each side of the face the slit runs
  add(surface(both(0, 1), 40, FW, Math.PI * 2 - 2 * FW), steel);                    // back and sides (rim → top)
  add(surface(both(0, SLIT[0]), 36, -FW, 2 * FW), steel);                           // face, below the slit
  add(surface(both(SLIT[1], 1), 36, -FW, 2 * FW), steel);                           // face, above the slit
  const ku = kAt(SLIT[1]);
  add(surface([[ku, SLIT[1] + 0.03, 0], [ku, SLIT[1] + 0.02, 0.006], [ku, SLIT[1], 0.006], [ku, SLIT[0] + 0.012, -0.002]], 36, -FW, 2 * FW), steel);   // the upper plate's lip
  add(surface([[kAt(SLIT[0]), SLIT[0] - 0.01, -0.006], [kAt(SLIT[1]), SLIT[1] + 0.01, -0.006]], 36, -FW, 2 * FW), dark, false);                      // the dark behind the slit
  // the rolled rim
  const rim = []; for (let a = 0; a <= 8; a++) { const t = (a / 8) * Math.PI; rim.push([kAt(0), 0.012 - Math.cos(t) * 0.012, 0.004 + Math.sin(t) * 0.004]); }
  add(surface(rim, 72), steel);
  // the brass cross: down the face (under the slit and above it) and across above the slit
  const strip = (u0, u1, phiW, out = 0.004) => add(surface([[kAt(u0), u0, out - 0.003], [kAt(u0), u0, out], [kAt(u1), u1, out], [kAt(u1), u1, out - 0.003]], 6, -phiW / 2, phiW), brass);
  strip(0.03, SLIT[0] - 0.005, 0.14); strip(SLIT[1] + 0.035, 0.84, 0.14);
  add(surface([[ku, SLIT[1] + 0.04, 0.005], [ku, SLIT[1] + 0.04, 0.0075], [ku, SLIT[1] + 0.07, 0.0075], [ku, SLIT[1] + 0.07, 0.005]], 36, -FW + 0.15, 2 * FW - 0.3), brass);
  // rivets: along the brow strip, the crown plate's seam, the side seams
  const rivet = new THREE.SphereGeometry(0.003, 10, 6);
  const rv = (phi, u, out = 0.004) => { const m = add(rivet, brass); m.position.copy(shellAt(kAt(u), u, phi, out)); };
  for (let i = 0; i <= 8; i++) rv(-FW + 0.2 + (i / 8) * (2 * FW - 0.4), SLIT[1] + 0.055, 0.0085);
  for (let i = 0; i < 18; i++) rv((i / 18) * Math.PI * 2, 0.8);
  for (const s of [-1, 1]) for (let j = 0; j < 4; j++) rv(s * Math.PI / 2, 0.12 + j * 0.16);
  // breathing holes in a cross, both cheeks
  const hole = new THREE.CircleGeometry(0.0045, 10);
  for (const s of [-1, 1]) for (const [dx, du] of [[0, -2], [0, -1], [0, 0], [0, 1], [0, 2], [-1, 0], [1, 0]]) {
    const phi = s * (0.5 + dx * 0.075), u = 0.33 + du * 0.045, m = add(hole, dark, false);
    const at = shellAt(kAt(u), u, phi, 0.0012), nrm = shellAt(kAt(u), u, phi, 0.02).sub(at).normalize();
    m.position.copy(at); m.lookAt(at.clone().add(nrm));
  }
  // on the head: placed in the rig's frame, then carried by the head bone
  r.rig.add(helm);
  helm.position.set(c.x, base, c.z);
  helm.updateMatrixWorld(true);
  head.attach(helm);
  helm.visible = false;
  helm.userData.side = rx;                           // (its reach out from the head's middle at the side — the bow anchors against it)
  helm.userData.shell = { rx, rz, H, pad: PAD, kAt };   // (kAt: the shell's radius share at a height share — the bow keeps the hand off it)
  rider.helmet = helm;
  return helm;
}
