// BUILDINGS AT WAR — every placed building of this game as a combat
// structure for the shared combat (combat.js treats structures and units
// alike: position, team, hp, range, damage, fireRate, weapon):
//
//   FRENCH  the post (its two tower MGs, each firing from the tower nearer its
//           target), the motor pool, the helipad, the mirador (an MG in the
//           cabin), the MG nest (the AA-52 traverses onto its target), the
//           81 mm MORTAR PIT (lobs bombs 25-120 m: splash, and cover does not
//           help — it comes down from above), the searchlight;
//   ALN     the cave (their spawn: destroy it and no band comes out of it),
//           the arms cache, the sangar (a captured FM, traversing).
//
// Hit, a building shows its bar; at 0 it goes up (combat.js: the blast, a
// fire, a crater) and stays as a WRECK: charred, its gun drooped, burning a
// while. A wrecked producer stops producing. Selectable: yours, with corner
// brackets; the ALN's can be right-clicked to attack.
import * as THREE from "three";
import { vec3 } from "three/tsl";

const S = 1.3;

/** Per building: who owns it and how it fights. Producers keep their own hp. */
const STATS = {
  // `vision`: how far it sees for the fog of war (the towers and the
  // watchtower furthest, over the valley).
  post: { weapon: "mg", range: 44, damage: 9, fireRate: 3.0, canHitAir: true, muzzles: "towerGuns", vision: 90 },
  motorPool: { vision: 45 },
  helipad: { vision: 50 },
  caveEntrance: { vision: 60 },
  mirador: { team: "player", name: "Mirador", hp: 500, weapon: "mg", range: 48, damage: 8, fireRate: 2.4, canHitAir: true, muzzleAt: [0, 6.2 * S + 1.4, 0], vision: 110 },
  // `arcGun`: an EMPLACED machine gun (algMgTeam.js) — it fires in an arc round the way it was
  // built facing (the gun's rest: its barrel, local −Z), swings slowly, never packs up.
  mgNest: { team: "player", name: "Nid de mitrailleuse", hp: 700, weapon: "mg", range: 44, damage: 10, fireRate: 3.0, canHitAir: true, vision: 55, arcGun: true },
  mortarPit: { team: "player", name: "Mortier de 81", hp: 600, mortar: { min: 25, max: 120, every: 7, damage: 45, splash: 7 }, vision: 45 },
  searchlight: { team: "player", name: "Projecteur", hp: 400, vision: 100 },
  armsCache: { team: "enemy", name: "Cache d'armes", hp: 500, vision: 30 },
  refuge: { team: "enemy", name: "Refuge", hp: 450, vision: 30 },
  lookout: { team: "enemy", name: "Guetteur", hp: 150, vision: 95 },
  sangar: { team: "enemy", name: "Sangar", hp: 500, weapon: "mg", range: 38, damage: 9, fireRate: 2.6, canHitAir: true, vision: 45 },
};

const _v = new THREE.Vector3();

export function createAlgStructures({ app, showroom, producers, units }) {
  const list = [];
  const byMesh = new Map();
  // LIVE arrays: combat, the fog and the selection keep these very arrays,
  // and buildings the sappers raise mid-game are pushed into them (addBuilt).
  const pub = [], roots = [];

  /** A building's frame: local (scaled m) → world. */
  const frameOf = (mesh) => {
    const c = Math.cos(mesh.rotation.y), s = Math.sin(mesh.rotation.y);
    return (lx, ly, lz) => new THREE.Vector3(mesh.position.x + lx * c + lz * s, mesh.position.y + ly, mesh.position.z - lx * s + lz * c);
  };

  function add(key, mesh, base = null) {
    const st = STATS[key];
    if (!st || !mesh) return;
    const fp = mesh.geometry.userData.footprint ?? { cx: 0, cz: 0, hx: 4, hz: 4 };
    const toW = frameOf(mesh);
    const centre = toW(fp.cx, 0, fp.cz);
    const s = base ?? {
      isStructure: true, typeKey: key, name: st.name, team: st.team, alive: true, selected: false,
      hp: st.hp, maxHp: st.hp, type: { typeKey: key, name: st.name },
      setSelected(v) { s.selected = !!v; },
    };
    // Combat reads these. `position` is the footprint's centre (a 40 m post
    // measured from its gate corner shot at nothing).
    Object.assign(s, {
      position: centre, radius: Math.hypot(fp.hx, fp.hz),
      range: st.weapon ? st.range : 0, damage: st.damage ?? 0, fireRate: st.fireRate ?? 1,
      weapon: st.weapon ?? null, canHitAir: !!st.canHitAir, cooldown: 0, vision: st.vision ?? 50,
      // Its eye over the ground for the fog's ridge sight (a mirador sees over a crest a man can't).
      visionEye: Math.min(14, (mesh.geometry.userData.height ?? 5) * 0.9),
    });
    const gun = mesh.children.find((c) => c.name === "Gun") ?? null;
    if (st.arcGun) {
      s.arcGun = true;
      const y = mesh.rotation.y;
      s._mg = { state: "set", t: 0, still: 0, facing: Math.atan2(-Math.sin(y), -Math.cos(y)), want: null, scanT: 0, held: null };
    }
    const muzzles = st.muzzles ? (mesh.geometry.userData[st.muzzles] ?? []).map((p) => toW(...p))
      : st.muzzleAt ? [toW(...st.muzzleAt)] : [];
    const rec = { s, mesh, gun, muzzles, fp, height: mesh.geometry.userData.height ?? 5, mortar: st.mortar ?? null, mortarT: Math.random() * 3 };
    list.push(rec);
    pub.push(s);
    roots.push(mesh);
    byMesh.set(mesh, rec);
    return s;
  }

  // The producers are structures already (algProducer.js): they get their
  // combat fields here. The rest are the showroom's placed pieces.
  for (const p of producers) add(p.structure.typeKey, p.mesh, p.structure);
  for (const key of ["mirador", "mgNest", "mortarPit", "searchlight", "armsCache", "sangar"]) add(key, showroom?.[key]);
  // The hidden caches in the hills (algLandmarks.js: armsCache2, 3 …).
  // … and the refuges and lookouts (algLandmarks.js: refuge1, lookout2 …).
  for (const [key, mesh] of Object.entries(showroom ?? {})) {
    const m = /^(armsCache|refuge|lookout)\d+$/.exec(key);
    if (m) add(m[1], mesh);
  }

  /** Where a building's shot leaves from: its gun, or the tower nearer the target. */
  function muzzleOf(s) {
    const rec = list.find((r) => r.s === s);
    if (!rec) return s.position.clone();
    if (rec.gun) { rec.gun.getWorldPosition(_v); return _v.clone().add(new THREE.Vector3(0, 0.3, 0)); }
    if (rec.muzzles.length) {
      const t = s.target?.position;
      if (!t) return rec.muzzles[0].clone();
      let best = rec.muzzles[0], bd = Infinity;
      for (const m of rec.muzzles) { const d = Math.hypot(m.x - t.x, m.z - t.z); if (d < bd) { bd = d; best = m; } }
      return best.clone();
    }
    return s.position.clone().add(new THREE.Vector3(0, 3, 0));
  }

  /** The mortar: every few seconds a bomb on the nearest enemy in its band. */
  function stepMortar(rec, dt, projectiles) {
    const m = rec.mortar, s = rec.s;
    if (!s.alive) return;
    rec.mortarT -= dt;
    if (rec.mortarT > 0) return;
    let best = null, bd = Infinity;
    for (const u of units.list) {
      if (!u.alive || u.team === s.team || u.isAir) continue;
      const d = Math.hypot(u.position.x - s.position.x, u.position.z - s.position.z);
      if (d < m.min || d > m.max || d >= bd) continue;
      best = u; bd = d;
    }
    if (!best) { rec.mortarT = 1; return; }
    rec.mortarT = m.every;
    s.target = best;
    const from = rec.gun ? rec.gun.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.2, 0)) : s.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    // Aimed where he stands now; a bomb in the air ~3 s — men who keep moving live.
    projectiles.spawnArc(from, best.position.clone(), { damage: m.damage, splash: m.splash, owner: s });
  }

  /** Charred and still: the building is a wreck (its own darkened material). */
  const charred = new Map();
  function charMaterial(src) {
    if (charred.has(src)) return charred.get(src);
    const m = src.clone();
    if (src.colorNode) m.colorNode = src.colorNode.mul(vec3(0.24, 0.22, 0.2));
    else if (m.color) m.color.multiplyScalar(0.24);
    charred.set(src, m);
    return m;
  }
  function wreck(s) {
    const rec = list.find((r) => r.s === s);
    if (!rec) return;
    rec.mesh.traverse((o) => { if (o.isMesh && o.material && !o.material.transparent) o.material = charMaterial(o.material); });
    if (rec.gun) rec.gun.rotation.x = 0.5;           // the barrel down
    s.range = 0; s.target = null;
    s.selected = false;
    // It burns a while, bigger for a big building.
    const big = rec.fp.hx * rec.fp.hz > 60;
    app.algCombat?.fire?.addFire(s.position.x, s.position.y + (big ? 3 : 1), s.position.z, big ? 8 : 3.5, big ? 60 : 30);
  }

  return {
    list: pub,
    records: list,
    muzzleOf,
    wreck,
    /** A building a sapper finished (algBuild.js): it fights, is seen, is picked. */
    addBuilt: (key, mesh) => { const s = add(key, mesh); if (s) s.builtLate = true; return s; },
    /** For the shared selection: every building (the dead can't be picked). */
    renderer: {
      roots,
      structureFromHit(h) {
        for (let o = h.object; o; o = o.parent) {
          const r = byMesh.get(o);
          if (r) return r.s.alive ? r.s : null;
        }
        return null;
      },
    },
    /** Fixed clock: the mortars. */
    step(dt, projectiles) { for (const r of list) if (r.mortar) stepMortar(r, dt, projectiles); },
    /** Every frame: guns follow their targets; bars when hurt or selected; brackets. */
    frame(dt, camera, healthBars, frames) {
      const fow = app.fogOfWar;
      for (const r of list) {
        const s = r.s;
        // The ALN's buildings: hidden under the fog until first seen (then
        // they stay, as a last-known position does).
        if (s.team === "enemy") {
          // One raised mid-game (a new arms cache, algAI.js) where the French
          // had already been: only once they actually SEE it — "explored"
          // would show it the moment it is finished.
          if (s.builtLate && !s.sighted && fow?.enabled && fow.canSeeEntity?.(s)) s.sighted = true;
          const seen = !fow?.enabled || (s.builtLate ? !!s.sighted : fow.isExplored(s.position.x, s.position.z));
          r.mesh.visible = seen;
          if (!seen) continue;
        }
        // An emplaced gun with nothing to shoot rests along its arc (where it is turning to).
        const aimAt = s.target?.alive ? s.target.position : s._mg ? { x: s.position.x + Math.sin(s._mg.facing) * 10, z: s.position.z + Math.cos(s._mg.facing) * 10 } : null;
        if (s.alive && r.gun && aimAt) {
          const dx = aimAt.x - s.position.x, dz = aimAt.z - s.position.z;
          // The gun's barrel is its local −Z; the building's yaw taken off.
          const want = Math.atan2(-dx, -dz) - r.mesh.rotation.y;
          let d = want - r.gun.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
          r.gun.rotation.y += d * Math.min(1, dt * 4);
        }
        if (s.alive && (s.hp < s.maxHp || s.selected)) {
          healthBars.add(s.position.x, s.position.y + Math.min(r.height, 12) + 2, s.position.z, Math.min(12, 4 + r.fp.hx * 0.3), s.hp / s.maxHp, s.team === "enemy", camera);
        }
        if (s.alive && s.selected) frames.add(s.position.x, s.position.z, r.fp.hx + 0.6, r.fp.hz + 0.6, r.mesh.rotation.y, undefined, r.mesh.position.y + 0.8);
      }
    },
  };
}
