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
import { isHuman, isHostile, SIDES, hostileSide } from "../shared-rts/teams.js";
import { vec3 } from "three/tsl";
import { t } from "./i18n/i18n.js";
import { pitCrewPlace, pitCrewShot, pitMouth } from "./algMortarPit.js";
import { setPieceState } from "./algSangar.js";

const S = 1.3;

/** Per building: who owns it and how it fights. Producers keep their own hp. */
/**
 * THE GUN CREWS (2026-10-22, you: "in the mg nest there is no soldiers firing … is it how it should be?"): an
 * emplacement's gun is worked by its men — figures of the side's crowd (the unit renderer's static figures, no draw
 * of their own), placed behind the gun and turning with it (`gun`: offsets from its pivot along the barrel, `back` m
 * behind it, `side` m to its right), or fixed in the piece's frame (`at`: local game metres); their clip at rest,
 * their firing clip while it has a target. `bare`: no rifle (the gunner holds the gun). Gone when it falls; the
 * mirador's (`intactOnly`) when its cabin is hit (the gun knocked off the rail).
 */
const CREWS = {
  mgNest: { look: "appele", gun: [{ back: 1.05, side: 0, rest: "crouchIdle", fire: "crouchFire", bare: true }, { back: 0.75, side: 0.95, rest: "crouchIdle" }] },
  sangar: { look: "moudjahid", gun: [{ back: 0.95, side: 0, rest: "crouchIdle", fire: "crouchFire", bare: true }, { back: 0.9, side: 1.05, rest: "crouchIdle" }] },
  // the post's tower guns (rtsFrenchPost userData.towerGuns: each AA-52's muzzle, the towers on the diagonal): a
  // gunner kneeling behind each, `back` m in from the muzzle toward the post's centre, facing out
  // (2026-10-23, you: "like they are not holding anything"): the gun's axis stands 1.6 m over the tower roof — a
  // STANDING man's shoulder — so he stands behind it, the AA-52's stock in his shoulder: the rifleman's aim (rest) and
  // fire, his rifle hidden (bare). `back` m from the muzzle along the barrel, `dy` the roof under the muzzle, `side`
  // the gun to his right
  post: { look: "appele", muzzles: { key: "towerGuns", back: 1.45, dy: -1.6, side: 0.05, rest: "aim", fire: "fire", bare: true },
    // and its MORTAR (rtsFrenchPost: the tube at (-2.6, 1.4) on its baseplate, firing toward +z): the mortar team's
    // rest — the gunner behind the plate, the loader beside the mouth (y: null — the floor under them)
    at: [{ x: -2.6 * S, y: null, z: (1.4 - 0.6) * S, yaw: 0, rest: "mortarRest", bare: true },
      { x: (-2.6 + 0.7) * S, y: null, z: (1.4 + 0.45) * S, yaw: -Math.PI / 2, rest: "mortarRest" }] },
  mirador: { look: "appele", intactOnly: true, at: [{ x: -0.6 * S, y: (6.2 + 0.13) * S, z: (-1.5 + 0.3 + 0.8) * S, yaw: Math.PI, rest: "aim", fire: "fire", bare: true }] },
};
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
  mgNest: { team: "player", name: t("Nid de mitrailleuse"), hp: 700, weapon: "mg", range: 44, damage: 10, fireRate: 3.0, canHitAir: true, vision: 55, arcGun: true },
  // THE PIT = DEFENCE, the mobile team = attack (2026-10-16, you: "both" — CoH's British have both): the pit
  // reaches FARTHER (90 m against the team's 80 — CoH 3's pit 100 against its team's 90; 160 until 2026-10-22) and
  // fires a little faster, but never moves.
  mortarPit: { team: "player", name: t("Mortier de 81"), hp: 600, mortar: { min: 25, max: 90, every: 6, damage: 42, splash: 7, scatter: 0.11 }, vision: 45 },
  searchlight: { team: "player", name: t("Projecteur"), hp: 400, vision: 100 },
  // FIELD WORKS (algFieldWorks.js)
  forwardPost: { team: "player", name: t("Poste avancé"), hp: 600, vision: 60 },
  aidStation: { team: "player", name: t("Poste de secours"), hp: 350, vision: 35 },
  fortPoint: { team: "player", name: t("Point fortifié"), hp: 500, vision: 40 },
  armsCache: { team: "enemy", name: t("Cache d'armes"), hp: 500, vision: 30 },
  refuge: { team: "enemy", name: "Refuge", hp: 450, vision: 30 },
  infirmary: { team: "enemy", name: t("Infirmerie"), hp: 300, vision: 30 },
  lookout: { team: "enemy", name: t("Guetteur"), hp: 150, vision: 95 },
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
    const rec = { s, mesh, gun, muzzles, fp, height: mesh.geometry.userData.height ?? 5, mortar: st.mortar ?? null, mortarT: Math.random() * 3, crewSpec: CREWS[key] ?? null, crew: null };
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
      const tp = s.target?.position;
      if (!tp) return rec.muzzles[0].clone();
      let best = rec.muzzles[0], bd = Infinity;
      for (const m of rec.muzzles) { const d = Math.hypot(m.x - tp.x, m.z - tp.z); if (d < bd) { bd = d; best = m; } }
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
      // Only what its side SEES (2026-10-16: the French AI's pit shelled FLN men none of his men could
      // see, 78 m from the nearest) — its fog, or its AI's eyes (algMortarTeam sees).
      if (app.algMortarTeams?.sees && !app.algMortarTeams.sees(s.team, u.position.x, u.position.z)) continue;
      best = u; bd = d;
    }
    if (!best) { rec.mortarT = 1; return; }
    rec.mortarT = m.every;
    s.target = best;
    // From the tube's mouth (the launch smoke and the trail start there).
    const from = rec.gun ? pitMouth(rec.mesh, rec.gun) : s.position.clone().add(new THREE.Vector3(0, 1.5, 0));
    // Aimed where he stands now; a bomb in the air ~3 s — men who keep moving live. It lands off its
    // aim as the teams' do (scatter × the distance; it had none, 2026-10-16: every round on a man).
    const to = best.position.clone(), a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * bd * (m.scatter ?? 0);
    to.x += Math.cos(a) * r; to.z += Math.sin(a) * r; to.y = app.getWorldHeight?.(to.x, to.z) ?? to.y;
    projectiles.spawnArc(from, to, { damage: m.damage, splash: m.splash, owner: s, kind: "mortar81" });
    pitCrewShot(app, rec.mesh);
  }

  // ── The gun crews (CREWS) ────────────────────────────────────────────────────────────────────────────────────
  const _ray = new THREE.Raycaster(), _down = new THREE.Vector3(0, -1, 0), _o = new THREE.Vector3(), _p = new THREE.Vector3();
  /** The floor under (x, z) in the piece (a nest's raised platform): a ray down onto its own mesh, the ground if none. */
  function floorAt(rec, x, z, top) {
    _ray.set(_o.set(x, top, z), _down);
    const hit = _ray.intersectObject(rec.mesh, false)[0];
    const g = app.getWorldHeight?.(x, z) ?? rec.mesh.position.y;
    return hit ? Math.max(hit.point.y, g) : g;
  }
  /** Fixed figures in the piece's frame (`at`; y null: the floor under them). */
  function atFigures(rec, C) {
    return app.algUnitRenderer.addStaticFigures(C.look, C.at.map((m, i) => {
      rec.mesh.localToWorld(_p.set(m.x, m.y ?? 0, m.z));
      const y = m.y == null ? floorAt(rec, _p.x, _p.z, _p.y + 6) : _p.y;
      return { x: _p.x, y, z: _p.z, yaw: rec.mesh.rotation.y + m.yaw, role: m.rest, slot: 4 + i, bare: m.bare };
    }));
  }
  function dropCrew(rec) {
    if (rec.crew) app.algUnitRenderer?.removeStaticFigures?.(rec.crew);
    rec.crew = null;
  }
  function stepCrew(rec) {
    const s = rec.s, C = rec.crewSpec, R = app.algUnitRenderer;
    if (!R?.addStaticFigures) return;
    const gone = !s.alive || !rec.mesh.parent || (C.intactOnly && (rec.mesh.userData.pieceState ?? "intact") !== "intact")
      || (rec.mesh.userData.pieceState === "ruin");
    if (gone) { if (rec.crew) dropCrew(rec); rec.crewGone = rec.crewGone || !s.alive; return; }
    if (rec.crewGone) return;
    rec.mesh.updateMatrixWorld(true);
    const firing = !!(s.target?.alive && s.range > 0 && Math.hypot(s.target.position.x - s.position.x, s.target.position.z - s.position.z) <= s.range + 2);
    if (C.gun && rec.gun) {
      // behind the gun along its barrel (local −Z), turning with it
      rec.gun.getWorldPosition(_p);
      const Y = rec.mesh.rotation.y + rec.gun.rotation.y, fx = -Math.sin(Y), fz = -Math.cos(Y), rx = -fz, rz = fx;
      if (!rec.crew) {
        rec.crew = R.addStaticFigures(C.look, C.gun.map((m, i) => ({ x: _p.x, y: _p.y, z: _p.z, yaw: 0, role: m.rest, slot: 3 + i, bare: m.bare })));   // (slots 0-2 are the section's leader / radioman / LMG — soldierLooks SECTION_ROLES: a gun crew is plain riflemen, no radio on the tower, 2026-10-23)
        rec.crewFloor = C.gun.map((m) => floorAt(rec, _p.x - fx * m.back + rx * m.side, _p.z - fz * m.back + rz * m.side, _p.y + 1));
      }
      C.gun.forEach((m, i) => {
        const f = rec.crew[i];
        f.x = _p.x - fx * m.back + rx * m.side; f.z = _p.z - fz * m.back + rz * m.side; f.y = rec.crewFloor[i];
        f.yaw = Math.atan2(fx, fz);
        const want = firing && m.fire ? m.fire : m.rest;
        if (f.role !== want) R.setStaticClip(f, want);
      });
    } else if (C.muzzles) {
      if (!rec.crew) {
        const M = C.muzzles, pts = rec.mesh.geometry.userData[M.key] ?? [];
        rec.crew = R.addStaticFigures(C.look, pts.map((q, i) => {
          const L = Math.hypot(q[0], q[2]) || 1, dx = q[0] / L, dz = q[2] / L;
          rec.mesh.localToWorld(_p.set(q[0] - dx * M.back - dz * (M.side ?? 0), q[1], q[2] - dz * M.back + dx * (M.side ?? 0)));
          return { x: _p.x, y: M.dy != null ? _p.y + M.dy : floorAt(rec, _p.x, _p.z, _p.y + 1), z: _p.z, yaw: rec.mesh.rotation.y + Math.atan2(dx, dz), role: M.rest, slot: 3 + i, bare: M.bare };
        }));
        rec.gunCrewN = rec.crew.length;
        if (C.at) rec.crew.push(...atFigures(rec, C));
      }
      const want = firing ? C.muzzles.fire : C.muzzles.rest;
      for (let i = 0; i < rec.gunCrewN; i++) if (rec.crew[i].role !== want) R.setStaticClip(rec.crew[i], want);
    } else if (C.at) {
      if (!rec.crew) rec.crew = atFigures(rec, C);
      C.at.forEach((m, i) => { const want = firing && m.fire ? m.fire : m.rest; if (rec.crew[i].role !== want) R.setStaticClip(rec.crew[i], want); });
    }
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
    // A Blender piece falls to its RUIN model (algSangar setPieceState: burnt, broken, down) — dust thrown up as it
    // goes; the old procedural pieces are charred in place as before.
    if (setPieceState(rec.mesh, "ruin")) {
      app.algCombat?.fx?.explosion?.(s.position.x, s.position.y + 0.5, s.position.z, { size: 9 + Math.min(10, rec.fp.hx), dust: true });
      app.algDamage?.coverChanged?.();
    } else rec.mesh.traverse((o) => { if (o.isMesh && o.material && !o.material.transparent) o.material = charMaterial(o.material); });
    // Its crew (a mortar pit's: algBuild.js) gone with it.
    dropCrew(rec); rec.crewGone = true;
    if (rec.mesh.userData.crewFigures) { app.algUnitRenderer?.removeStaticFigures?.(rec.mesh.userData.crewFigures); rec.mesh.userData.crewFigures = null; }
    if (rec.gun) rec.gun.rotation.x = 0.5;           // the barrel down
    s.range = 0; s.target = null;
    s.selected = false;
    // It burns a while, bigger for a big building.
    // (none here when the baked death drew it — algCombat fx.destroyed: the blast, then the wreck book burning on it)
    const big = rec.fp.hx * rec.fp.hz > 60;
    if (!app.algCombat?.fx?.destroyed) app.algCombat?.fire?.addFire(s.position.x, s.position.y + (big ? 3 : 1), s.position.z, big ? 8 : 3.5, big ? 60 : 30);
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
        if (isHostile(s.team)) {
          // One raised mid-game (a new arms cache, algAI.js) where the French
          // had already been: only once they actually SEE it — "explored"
          // would show it the moment it is finished.
          if (s.builtLate && !s.sighted && fow?.enabled && fow.canSeeEntity?.(s)) s.sighted = true;
          const seen = !fow?.enabled || (s.builtLate ? !!s.sighted : fow.isExplored(s.position.x, s.position.z));
          r.mesh.visible = seen;
          if (!seen) continue;
        }
        // An emplaced gun with nothing to shoot rests along its arc (where it is turning to).
        let turning = false;
        const aimAt = s.target?.alive ? s.target.position : s._mg ? { x: s.position.x + Math.sin(s._mg.facing) * 10, z: s.position.z + Math.cos(s._mg.facing) * 10 } : null;
        if (s.alive && r.gun && aimAt) {
          const dx = aimAt.x - s.position.x, dz = aimAt.z - s.position.z;
          // The gun's barrel is its local −Z; the building's yaw taken off.
          const want = Math.atan2(-dx, -dz) - r.mesh.rotation.y;
          let d = want - r.gun.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d));
          r.gun.rotation.y += d * Math.min(1, dt * 4);
          turning = Math.abs(d) > 0.08;
        }
        // A mortar pit's crew kneel where the turned piece needs them (algMortarPit.js).
        if (s.alive && r.mortar && r.gun) pitCrewPlace(app, r.mesh, r.gun, turning);
        if (r.crewSpec) stepCrew(r);
        if (s.alive && (s.hp < s.maxHp || s.selected)) {
          healthBars.add(s.position.x, s.position.y + Math.min(r.height, 12) + 2, s.position.z, Math.min(12, 4 + r.fp.hx * 0.3), s.hp / s.maxHp, isHostile(s.team), camera);
        }
        if (s.alive && s.selected) frames.add(s.position.x, s.position.z, r.fp.hx + 0.6, r.fp.hz + 0.6, r.mesh.rotation.y, undefined, r.mesh.position.y + 0.8);
      }
    },
  };
}
