// CONSTRUCTION STAGES (2026-10-13, you: "a building animation like Company of Heroes — and very
// optimised"). A building the sappers raise is shown going up PIECE BY PIECE in its own order, not
// stretched out of the ground:
//   THE ORDER    baked in the geometry by its builder (rtsParts assemble: `build` / `drop` per part —
//                the helipad: the earth graded, the corner cairns, the edge stones, the H and its circle
//                PAINTED on in lime (rtsPaint.js), the mast raised, the fuel point and the radio corner;
//                the tyre marks of the first landing last).
//   THE MATERIAL the kit's photo material with a progress uniform (algKitPhoto `build`): a part is
//                hidden until its moment, then falls or rises into place. GPU only, nothing per frame
//                on the CPU but the uniform; the same program for every site.
//   THE SITE     its dressing while it stands open: stakes at the corners and the string between,
//                a heap of whitewashed stones that shrinks as they are laid. Gone when it is done.
//   DONE         the caller puts the shared material back (`material: null`): a finished building
//                costs exactly what it did.
import * as THREE from "three";
import { uniform } from "three/tsl";
import { kitPhotoMaterial } from "./algKitPhoto.js";

const S = 1.3;   // the kit's scale (its geometry is in real metres × 1.3)

let _mats = null;
const mats = () => (_mats ??= {
  stake: new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 }),
  string: new THREE.MeshStandardMaterial({ color: 0xd9cdb0, roughness: 0.95 }),
  stone: new THREE.MeshStandardMaterial({ color: 0xe9e4d8, roughness: 0.85, flatShading: true }),
});
let _stoneGeo = null;

/**
 * A construction site for the kit geometry `geo` (built with a build order).
 * @returns {{ material, progress, dressing: THREE.Group, set(p:number):void, stencilShown(p:number):boolean }}
 */
export function createConstruction(geo, { paintTint }) {
  const progress = uniform(0);
  const material = kitPhotoMaterial(paintTint, { build: progress });
  const c = geo.userData.construction ?? {};
  const dressing = new THREE.Group();
  dressing.name = "SiteDressing";
  const M = mats();
  // STAKES and STRING round the footprint (or c.stakes, half a side, kit metres).
  const fp = geo.userData.footprint ?? { cx: 0, cz: 0, hx: 4, hz: 4 };
  const h = c.stakes != null ? c.stakes * S : Math.max(fp.hx, fp.hz);
  const corners = [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, z]) => new THREE.Vector3(x, 0, z));
  const stakeGeo = new THREE.CylinderGeometry(0.035, 0.045, 0.9, 5).translate(0, 0.45, 0);
  for (const p of corners) { const m = new THREE.Mesh(stakeGeo, M.stake); m.position.copy(p); m.castShadow = true; dressing.add(m); }
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], len = a.distanceTo(b);
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, len, 3).rotateZ(Math.PI / 2), M.string);
    s.position.set((a.x + b.x) / 2, 0.75, (a.z + b.z) / 2);
    s.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    dressing.add(s);
  }
  // THE HEAP of whitewashed stones, beside the site: it shrinks as they are laid.
  const heap = new THREE.Group();
  _stoneGeo ??= new THREE.IcosahedronGeometry(0.2, 0);
  const R = mulberry(17);
  for (let k = 0; k < 26; k++) {
    const a = R() * Math.PI * 2, r = Math.sqrt(R()) * 0.9, y = (0.9 - r) * 0.55 + R() * 0.1;
    const m = new THREE.Mesh(_stoneGeo, M.stone);
    m.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    m.rotation.set(R() * 3, R() * 3, R() * 3);
    m.scale.set(1.1 + R() * 0.5, 0.75, 1 + R() * 0.4);
    m.castShadow = true;
    heap.add(m);
  }
  const [hx, hz] = c.heap ?? [fp.hx / S + 1, 0];
  heap.position.set(hx * S, 0, hz * S);
  dressing.add(heap);
  // THE PAINT (rtsPaint.js, 2026-10-19 — the helipad's lime H and circle): painted on along its strokes
  // over its window; the LIME BUCKET goes along with the brush (where a sapper will walk, in the game).
  const paint = geo.userData.paint ?? null;
  const paintU = uniform(2);
  let bucket = null;
  if (paint) {
    paint.progress = paintU;   // (read by paintMesh when the piece is drawn)
    bucket = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.3, 10).translate(0, 0.15, 0), M.stone);
    bucket.castShadow = true;
    bucket.visible = false;
    dressing.add(bucket);
  }
  const along = (s) => {
    const P = paint.path;
    let i = 1;
    while (i < P.length - 1 && P[i][3] < s) i++;
    const a = P[i - 1], b = P[i], f = b[3] > a[3] ? Math.min(1, Math.max(0, (s - a[3]) / (b[3] - a[3]))) : 0;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  return {
    material, progress, dressing,
    /** The site's progress, 0..1 (the material's uniform; the heap; the paint; the dressing gone at 1). */
    set(p) {
      progress.value = p;
      const k = Math.max(0, 1 - Math.max(0, p - 0.33) / 0.3);         // the stones go as the edge is laid
      heap.scale.setScalar(Math.max(0.001, k));
      heap.visible = k > 0.02;
      dressing.visible = p < 1;
      if (paint) {
        const [w0, w1] = paint.window;
        const s = (p - w0) / (w1 - w0);
        paintU.value = s >= 1 ? 2 : Math.max(-0.05, s);
        bucket.visible = s > 0 && s < 1;
        if (bucket.visible) { const [x, y, z] = along(s); bucket.position.set(x + 0.35, y, z + 0.35); }
      }
    },
    /** Where the brush is at site progress p (kit-local, scaled), or null outside the paint's window —
     *  the painter's spot. */
    painterAt(p) {
      if (!paint) return null;
      const [w0, w1] = paint.window, s = (p - w0) / (w1 - w0);
      return s > 0 && s < 1 ? along(s) : null;
    },
    /** The paint (stencils) goes down at its moment (c.stencilAt). */
    stencilShown: (p) => p >= (c.stencilAt ?? 0.9),
  };
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
