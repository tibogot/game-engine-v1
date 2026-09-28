// MINES ON THE PISTE — the ALN's war on the roads (algAI.js "mine" mission
// lays them; algTracks.js is where the French have to drive).
//
//   LAID       a band walks to a stretch of piste far from the French, works
//              ~8 s, and leaves; the mine arms 3 s later. Nobody on the French
//              side sees it happen.
//   TRIGGERED  a French VEHICLE whose wheels pass over it (within its
//              radius) sets it off; so does a man on foot who walks onto one
//              he has not spotted. The blast is the shared splash (combat.js
//              splashAt: fx, crater, damage falling off over 6 m) — a jeep or a
//              truck dies, a half-track limps home.
//   SPOTTED    French infantry within 10 m for 1.2 s find it: a red stake goes
//              in beside it, and from then on men step round it (it no longer
//              triggers for them). Vehicles still set it off — the player has
//              to clear the road.
//   CLEARED    a man at a spotted mine (within 4 m) for 5 s lifts it.
//
// So the tracks ask for the old routine: sweep the piste with infantry before
// the convoy drives it.
import * as THREE from "three";

const P = {
  armTime: 3,
  spotRange: 10, spotTime: 1.2,   // a man walking in (5.5 m/s) finds it ~3 m short
  footR: 1.0,           // an unspotted mine under a man's boot
  wheelMul: 1.0,        // a vehicle over it: within its radius (nav paths stray 2-5 m off the line, measured)
  clearR: 4.0, clearTime: 5,   // a man sent to it stops 3-5 m short (measured)
  damage: 240, radius: 6, vehicleMul: 1.2,   // a GMC 3 m off it: 186 of its 160 (at 200 it limped away on 29, measured)
  max: 4,               // live mines on the map (the AI stops laying past it)
};

export function createAlgMines(app, { units, combat }) {
  const mines = [];
  const near = [];
  const ALN = { team: "enemy" };   // the blast's owner: hurts the French only

  // The stake: a pole and a red rag, shared geometry, one mesh per spotted mine.
  const poleGeo = new THREE.CylinderGeometry(0.03, 0.04, 1.3, 5).translate(0, 0.6, 0);
  const ragGeo = new THREE.BoxGeometry(0.34, 0.2, 0.02).translate(0.17, 1.12, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.9 });
  const ragMat = new THREE.MeshStandardMaterial({ color: 0xb3261e, roughness: 0.8 });

  function mark(m) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(poleGeo, poleMat), new THREE.Mesh(ragGeo, ragMat));
    // Beside the mine, not on it, leaning a little.
    g.position.set(m.x + 0.8, m.y - 0.1, m.z + 0.4);
    g.rotation.set(0.08, Math.random() * 6.28, 0.05);
    g.scale.setScalar(1.6);   // man-made x1.3, and more: at play zoom a real stake is a pixel
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    app.scene.add(g);
    m.marker = g;
  }
  function remove(m) {
    m.marker?.removeFromParent();
    mines.splice(mines.indexOf(m), 1);
  }

  return {
    params: P,
    get list() { return mines; },
    /** Live mines (the AI's cap). */
    get count() { return mines.length; },
    /** The ALN lays one at (x, z). */
    lay(x, z) {
      if (mines.length >= P.max) return null;
      const m = { x, z, y: app.getWorldHeight(x, z), arm: P.armTime, spotT: 0, spotted: false, clearT: 0, marker: null };
      mines.push(m);
      return m;
    },
    /** On the fixed sim clock. */
    step(dt) {
      for (let i = mines.length - 1; i >= 0; i--) {
        const m = mines[i];
        if (m.arm > 0) { m.arm -= dt; continue; }
        units.near(m.x, m.z, P.spotRange, near);
        let seen = false, clearing = false, boom = false;
        for (const u of near) {
          if (!u.alive || u.team !== "player" || u.isAir || u.ghost) continue;
          const d = Math.hypot(u.position.x - m.x, u.position.z - m.z);
          const foot = !!u.type?.foot;
          if (!foot) {
            if (d < (u.type?.radius ?? 3) * P.wheelMul) { boom = true; break; }
            continue;
          }
          if (!m.spotted && d < P.footR) { boom = true; break; }
          seen = true;
          if (m.spotted && d < P.clearR) clearing = true;
        }
        if (boom) {
          combat.splashAt({ x: m.x, y: m.y + 0.3, z: m.z }, P.damage, P.radius, ALN, { vehicleMul: P.vehicleMul });
          remove(m);
          continue;
        }
        if (!m.spotted) {
          m.spotT = seen ? m.spotT + dt : Math.max(0, m.spotT - dt);
          if (m.spotT >= P.spotTime) { m.spotted = true; mark(m); }
        } else {
          m.clearT = clearing ? m.clearT + dt : 0;
          if (m.clearT >= P.clearTime) remove(m);
        }
      }
    },
  };
}
