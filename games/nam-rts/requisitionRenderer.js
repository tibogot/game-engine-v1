// Requisition point RENDERER — the masts, the flags and the zones.
//
//   · masts: the kit's relay mast (rtsBuildables), one InstancedMesh — every
//     point on the map is one draw, and one more for the red lights at the heads
//   · flags: the US flag and the NLF's (red over blue, the yellow star), one
//     InstancedMesh each. A flag CLIMBS its pole as a side captures — the
//     capture bar is on the map, where you are looking, not in a panel
//   · zones: a thin draped ring round each point, neutral khaki, yours blue,
//     theirs red; it pulses while the point is being taken or is contested
import * as THREE from "three";
import { makeBloomMaterial, BLOOM } from "./bloom.js";
import { drawUsFlagDataUrl } from "./baseFlag.js";
import { createSelectionRingField } from "./selectionRingField.js";
import { rtsObjectMaterial } from "../../v3/render/objects/rtsObjectProps.js";
import { buildRequisitionMast } from "../../v3/render/objects/rtsBuildables.js";

const FLAG_W = 3.0, FLAG_H = FLAG_W / 1.9 * 1.0;
const TINT = { neutral: 0xd8cfae, player: 0x6ab0ff, enemy: 0xff6a5a };

/** The National Liberation Front's flag: red over blue, a yellow star. */
function drawNlfFlag(h = 256) {
  const w = Math.round(h * 1.5);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#c8102e"; g.fillRect(0, 0, w, h / 2);
  g.fillStyle = "#0f6fc6"; g.fillRect(0, h / 2, w, h / 2);
  g.fillStyle = "#ffcd00";
  g.beginPath();
  const cx = w / 2, cy = h / 2, R = h * 0.3;
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5, r = k % 2 === 0 ? R : R * 0.382;
    g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  return c;
}

/** A flag's cloth: hoist at x = 0, flying along +X, a gentle ripple baked in. */
function flagGeometry() {
  const g = new THREE.PlaneGeometry(FLAG_W, FLAG_H, 12, 1).translate(FLAG_W / 2, 0, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    p.setZ(i, Math.sin((x / FLAG_W) * Math.PI * 2.2) * 0.18 * (x / FLAG_W));
  }
  g.computeVertexNormals();
  return g;
}

function flagMaterial(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return new THREE.MeshStandardNodeMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.85, metalness: 0 });
}

export function createRequisitionRenderer({ app, requisition, fogOfWar = null }) {
  const { scene } = app;
  const max = Math.max(1, requisition.points.length);
  const mastGeo = buildRequisitionMast();
  const pole = mastGeo.userData.pole;
  const [lx, ly, lz] = mastGeo.userData.light;

  const masts = new THREE.InstancedMesh(mastGeo, rtsObjectMaterial(), max);
  masts.castShadow = masts.receiveShadow = true;
  const lights = new THREE.InstancedMesh(new THREE.SphereGeometry(0.28, 10, 6),
    makeBloomMaterial({ color: 0xff3a2a, blending: THREE.NormalBlending, depthWrite: true, transparent: false }, BLOOM.beacon), max);
  const usTex = new THREE.TextureLoader().load(drawUsFlagDataUrl(256));
  const flags = {
    player: new THREE.InstancedMesh(flagGeometry(), flagMaterial(usTex), max),
    enemy: new THREE.InstancedMesh(flagGeometry(), flagMaterial(new THREE.CanvasTexture(drawNlfFlag())), max),
  };
  for (const m of [masts, lights, flags.player, flags.enemy]) { m.frustumCulled = false; m.count = 0; scene.add(m); }
  flags.player.castShadow = flags.enemy.castShadow = true;

  const zones = createSelectionRingField({ app, max: 32, inner: 0.965, segments: 96, opacity: 0.75 });

  const _m = new THREE.Matrix4();
  const _c = new THREE.Color();
  let t = 0;

  // The masts never move: written once (and again after a world reload).
  function placeMasts() {
    requisition.points.forEach((p, i) => {
      _m.makeTranslation(p.position.x, p.position.y, p.position.z);
      masts.setMatrixAt(i, _m);
      _m.makeTranslation(p.position.x + lx, p.position.y + ly, p.position.z + lz);
      lights.setMatrixAt(i, _m);
    });
    masts.count = lights.count = requisition.points.length;
    masts.instanceMatrix.needsUpdate = lights.instanceMatrix.needsUpdate = true;
  }
  placeMasts();

  function sync(dt) {
    t += dt;
    let nP = 0, nE = 0;
    zones.begin();
    for (const p of requisition.points) {
      // The flag: whichever side the capture leans to, at the height it has got to.
      const a = Math.abs(p.progress);
      if (a > 0.001) {
        const side = p.progress > 0 ? "player" : "enemy";
        const y = p.position.y + pole.bottom + (pole.top - pole.bottom - FLAG_H) * a + FLAG_H / 2;
        _m.makeTranslation(p.position.x + pole.x, y, p.position.z + pole.z);
        const im = flags[side];
        im.setMatrixAt(side === "player" ? nP++ : nE++, _m);
      }
      // The zone: the owner's colour, pulsing while it is being fought over.
      const seen = !fogOfWar?.enabled || fogOfWar.isExplored?.(p.position.x, p.position.z);
      if (!seen) continue;
      _c.set(TINT[p.owner ?? "neutral"]);
      if (p.contested || p.capturing) {
        const k = 0.6 + 0.4 * Math.sin(t * (p.contested ? 9 : 5));
        _c.lerp(new THREE.Color(p.contested ? 0xffffff : TINT[p.capturing > 0 ? "player" : "enemy"]), 1 - k);
      }
      zones.add(p.position.x, p.position.z, p.radius, _c.getHex());
    }
    zones.commit();
    flags.player.count = nP; flags.enemy.count = nE;
    flags.player.instanceMatrix.needsUpdate = flags.enemy.instanceMatrix.needsUpdate = true;
    // The head lights blink slowly, as aviation lights do.
    lights.visible = Math.sin(t * 2.2) > -0.3;
  }

  return { sync, placeMasts };
}
