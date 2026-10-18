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
//
// THE COMMAND MINE (2026-10-18, you: "make the FLN more dangerous"): a charge in a culvert under the
// piste and a WIRE to a man lying hidden `wire` m off. Nobody's boot sets it off; HE does — under the
// first lorry or armour (a jeep only after he has waited `jeepAfter` s: the scout goes by, the
// half-track behind it goes up), and harder than a pressure mine. He slips away when French on foot
// come within `keepOff` m of him, after `wait` s, or when the charge has gone; then (him gone, dead or
// out of reach) it is a pressure mine like any other. Spotted and lifted as any mine.
import * as THREE from "three";

const P = {
  armTime: 3,
  spotRange: 10, spotTime: 1.2,   // a man walking in (5.5 m/s) finds it ~3 m short
  footR: 1.0,           // an unspotted mine under a man's boot
  wheelMul: 1.0,        // a vehicle over it: within its radius (nav paths stray 2-5 m off the line, measured)
  clearR: 4.0, clearTime: 5,   // a man sent to it stops 3-5 m short (measured)
  damage: 240, radius: 6, vehicleMul: 1.2,   // a GMC 3 m off it: 186 of its 160 (at 200 it limped away on 29, measured)
  max: 4,               // live mines on the map (the AI stops laying past it)
  // The command mine (a half-track's 240 hp: 340 at 7 m kills it; a pressure mine's 240 lamed it).
  command: { wire: 45, damage: 340, radius: 7, jeepAfter: 150, keepOff: 22, wait: 300, wheelMul: 1.3 },
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
    /** A COMMAND mine at (x, z), its wire held by `man`; `onDone(why)`: "boom" | "flee" | "wait" | "gone" —
     *  he lets go (his side sends him home). */
    layCommand(x, z, man, onDone = null) {
      const m = this.lay(x, z);
      if (m) { m.command = man; m.waitT = 0; m.onDone = onDone; }
      return m;
    },
    /** On the fixed sim clock. */
    step(dt) {
      const C = P.command;
      for (let i = mines.length - 1; i >= 0; i--) {
        const m = mines[i];
        if (m.arm > 0) { m.arm -= dt; continue; }
        // The WIRE: its man gone (dead, or out of its reach) — a pressure mine from now on.
        let w = m.command;
        if (w && (!w.alive || Math.hypot(w.position.x - m.x, w.position.z - m.z) > C.wire)) { m.command = w = null; m.onDone?.("gone"); }
        if (w) {
          m.waitT += dt;
          if (!w.isMoving) w.posture = "prone";   // (after infantryPosture: lying in the scrub, holding the wire)
          const pressed = units.near(w.position.x, w.position.z, C.keepOff, near).some((u) => u.alive && u.team === "player" && u.type?.foot && Math.hypot(u.position.x - w.position.x, u.position.z - w.position.z) < C.keepOff);
          if (pressed || m.waitT > C.wait) { m.command = null; m.onDone?.(pressed ? "flee" : "wait"); w = null; }
        }
        units.near(m.x, m.z, P.spotRange, near);
        let seen = false, clearing = false, boom = false;
        for (const u of near) {
          if (!u.alive || u.team !== "player" || u.isAir || u.ghost) continue;
          const d = Math.hypot(u.position.x - m.x, u.position.z - m.z);
          const foot = !!u.type?.foot;
          if (!foot) {
            // Held by its man: under the first lorry or armour (a jeep only once he has waited long).
            // (When it is OVER the charge: well inside its radius, or at its closest — a GMC set off at the
            // first 4.5 m walked away on 40 of 160, measured.)
            if (w) {
              const r = (u.type?.radius ?? 3);
              if (d < r * C.wheelMul && (u.typeKey !== "willys" || m.waitT > C.jeepAfter)) {
                if (d < r * 0.6 || (m.track?.u === u && d > m.track.d)) { boom = true; break; }
                if (m.track?.u !== u || d < m.track.d) m.track = { u, d };
              }
              continue;
            }
            if (d < (u.type?.radius ?? 3) * P.wheelMul) { boom = true; break; }
            continue;
          }
          if (!w && !m.spotted && d < P.footR) { boom = true; break; }   // (no boot sets off a wired charge)
          seen = true;
          if (m.spotted && d < P.clearR) clearing = true;
        }
        if (boom) {
          if (w) {
            combat.splashAt({ x: m.x, y: m.y + 0.3, z: m.z }, C.damage, C.radius, ALN, { vehicleMul: P.vehicleMul });
            m.onDone?.("boom");
          } else combat.splashAt({ x: m.x, y: m.y + 0.3, z: m.z }, P.damage, P.radius, ALN, { vehicleMul: P.vehicleMul });
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
