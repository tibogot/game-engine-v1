// THE MORTAR TEAMS (2026-10-13 the FLN's 60 mm, A2 — its "armour" instead of tanks; 2026-10-15 the French
// 81 mm and the CREW, you: "CoH's mortar squad places it, loads it, fires it").
// A squad of three (algSquads `mortier` — a human FLN's — and `mortierFr`): the gunner, the loader, a third man.
//   SET UP    stopped a moment, it sets up (~3.5 s): the gunner and the loader kneel and set the tube
//             down (mortar_setup), the tube rises on its bipod in front of the gunner, the loader takes
//             his place beside its mouth. It does not move while set.
//   FIRES     by itself, every few seconds, on the nearest enemy its side SEES in its reach — no line
//             of sight needed, it lobs over ridges and walls (projectiles.spawnArc: the ring on the
//             ground warns the target); right-clicking a target picks it. EACH ROUND IS THE CREW'S: the
//             gunner lays the piece (mortar_lay), the loader holds the next bomb (mortar_wait), raises it
//             over the mouth, drops it in (mortar_load) — the round leaves the tube as it slides home —
//             and ducks, hands to his ears.
//   PACK UP   any move order: ~2 s to pack (the order held meanwhile), then they go.
//   CARRIED   (2026-10-16, CoH) packed, the gunner carries the tube slung on his back and the loader
//             the baseplate: setting up, the plate goes down first, then the tube is lifted off his back
//             onto it; packing up, the reverse (soldierLooks KIT mortarTube / mortarPlate).
//   TIR DE BARRAGE  a salvo on a point you click in its reach, one round per load (a cost, a cooldown).
// The clips are made in tools/packMixamo.mjs (synthMortarClips): no Mixamo clip loads a mortar. The
// tube is scaled so its mouth is where the loader's hands drop the bomb (a kneeling man's chest).
// The gunner never fires through combat.js (his kit's range is 0): this module aims and fires, so
// combat never walks him toward the enemy to get in range. The crew hold their rifles while set.
import * as THREE from "three";
import { buildMortarTube, MORTAR_MUZZLE } from "../../v3/render/objects/rtsEnemyKit.js";
import { rtsObjectMaterialTinted } from "../../v3/render/objects/rtsObjectProps.js";
import { FR_PAINT_TINT } from "../../v3/render/objects/rtsVehiclesFr.js";
import { createSelectionRingField } from "../shared-rts/selectionRingField.js";
import { isHuman } from "../shared-rts/teams.js";
import { RTS_SCALE } from "./algUnitTypes.js";
import { t } from "./i18n/i18n.js";

export const MORTAR_TEAM = {
  settle: 0.5,        // s stopped before it starts to set up
  setup: 3.5,         // s to set up
  pack: 2.2,          // s to pack up
  min: 25, max: 110,  // m: its reach
  every: 6.5,         // s between two rounds (by itself; a load takes LOAD of it)
  // BALANCE (2026-10-16, battle lab: a team on a squad standing in the open at 80 m): at 40 dmg and
  // 0.06 scatter both teams wiped it in < 50 s (a man every 8-10 s) — CoH's mortar pins and harasses,
  // a man every ~20 s on men who stand still. Rounds wider (0.11 × the distance: ~9 m at 80) and lighter.
  damage: 34, splash: 6,
  scatter: 0.11,      // × the distance: where a bomb may land off its aim
  // (a round per load: 2.6 s apart — the loader's clip, LOAD; it was 1.5 with no one loading)
  barrage: { cost: 35, shells: 5, every: 2.6, spread: 9, cooldown: 60 },
  key: "mortier",
  kind: "mortar60",
  tube: 0.35,         // × the kit's 82 mm (drawn up 1.5×): the mouth at ~1.05 m, a kneeling loader's chest
};
// Per team type: the FLN's 60 mm (above), the French 81 mm — more reach and punch, slower.
const KINDS = {
  mortier: MORTAR_TEAM,
  mortierFr: {
    ...MORTAR_TEAM, key: "mortierFr", kind: "mortar81", tube: 0.39,
    // (the ATTACK piece: 110 m — the pit reaches 160; the team must go forward, escorted)
    min: 25, max: 110, every: 7.5, damage: 42, splash: 7,
    barrage: { cost: { mun: 40 }, shells: 6, every: 2.6, spread: 11, cooldown: 70 },
  },
};
const P = MORTAR_TEAM;
const kindOf = (s) => KINDS[s.typeKey];

// THE CREW'S CLIP (tools/packMixamo synthMortarClips): mortar_load is LOAD long, the bomb leaves his
// hands at DROP_AT and slides home in SLIDE — the round goes then. Distances in the clip are the pack's
// 1.8 m soldier: × RTS_SCALE in the game (the loader's palms drop at 0.58 m in front of him).
const DROP_AT = 1.3, LOAD = 2.4, SLIDE = 0.12;
const READY = 2.0;   // s before a round the loader takes up its bomb (mortar_wait)
const REACH = 0.64 * RTS_SCALE;     // the loader to the mouth (his palms' forward reach, arms out)
const GUNNER_GAP = 0.5 * RTS_SCALE; // where the baseplate goes: this far in front of the gunner as he stops
// THE CREW ROUND THE TUBE, seen from the RTS camera (2026-10-15: kneeling on the near side, their backs
// hid the mortar completely — you could not see it at all). A crew kneels either side of its piece, so
// the side is chosen at set-up for the CAMERA: the loader on the flank AWAY from it, the gunner behind
// the plate (his hands on the tube: mortar_lay reaches ~0.65 m), leaning a little to that far flank too.
// The tube stands in front of both men on screen.
// (0.6 m back: his hands on the crank at the plate, his head well behind the leaning tube's muzzle)
const GUNNER_BACK = 0.6 * RTS_SCALE, GUNNER_SIDE = 0.14 * RTS_SCALE;

/**
 * @param {object} app
 * @param {object} o
 * @param {object} o.squads       algSquads
 * @param {object} o.projectiles  combat's (spawnArc)
 * @param {object} o.selection
 * @param {object} [o.fogOfWar]
 * @param {object} o.purses       { player, enemy }: each side's purse (the barrage's price)
 */
export function createAlgMortarTeams(app, { units, squads, projectiles, selection, fogOfWar = null, purses }) {
  const dom = app.renderer.domElement;
  const groundY = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const st = new Map();   // squad → { state, t, still, held, facing, cd, salvo, cool, load, crew }
  let targeting = null;   // { s, at, ok }
  const _v = new THREE.Vector3(), _w = new THREE.Vector3();
  const purseOf = (s) => purses?.[s.team] ?? null;

  const teams = () => squads.list.filter((s) => KINDS[s.typeKey] && s.members.length);
  // The gunner: slot 0 — or, him dead, the first man alive takes the tube (CoH: the weapon is picked up).
  const gunnerOf = (s) => s.slots.find((u) => u?.alive) ?? null;
  // The loader: the next man alive (none: the gunner loads it himself).
  const loaderOf = (s, g) => s.slots.find((u) => u?.alive && u !== g) ?? g;
  const stateOf = (s) => {
    let m = st.get(s);
    if (!m) { m = { state: "packed", t: 0, still: 0, held: null, facing: 0, cd: kindOf(s).every * 0.5, salvo: null, cool: 0, load: null, crew: [] }; st.set(s, m); }
    return m;
  };
  /** The side's eyes: what a human's side sees (its fog) — an AI side sees all (no fog of its own),
   *  unless its AI gives its own (setSight: the French commander sees only what his men see). */
  const sight = {};
  const sees = (team, x, z) => (sight[team] ? sight[team](x, z) : !fogOfWar?.enabled || !isHuman(team) || fogOfWar.isVisible(x, z));

  // Where the piece stands: the baseplate in front of the gunner, the mouth leaning toward the target.
  const mouthH = (K) => MORTAR_MUZZLE.y * K.tube, mouthF = (K) => MORTAR_MUZZLE.z * K.tube;
  function basePoint(g, m, out) {
    return out.set(m.base.x, 0, m.base.z);
  }
  /** The gunner's place, and the tube's middle he faces. */
  const flankOf = (m) => { const k = m.far ?? 1; return [Math.cos(m.facing) * k, -Math.sin(m.facing) * k]; };
  function gunnerSpot(m) {
    const fx = Math.sin(m.facing), fz = Math.cos(m.facing), [rx, rz] = flankOf(m);
    return { x: m.base.x - fx * GUNNER_BACK + rx * GUNNER_SIDE, z: m.base.z - fz * GUNNER_BACK + rz * GUNNER_SIDE, mx: m.base.x + fx * 0.3, mz: m.base.z + fz * 0.3 };
  }
  /** Which flank of the tube is away from the camera (+1 / -1 on the gunner's right vector). */
  const _cd = new THREE.Vector3();
  function farFlank(facing) {
    app.camera?.getWorldDirection?.(_cd);
    return Math.cos(facing) * _cd.x - Math.sin(facing) * _cd.z >= 0 ? 1 : -1;
  }
  function mouthPoint(s, g, m, out) {
    const K = kindOf(s);
    basePoint(g, m, out);
    out.x += Math.sin(m.facing) * mouthF(K); out.z += Math.cos(m.facing) * mouthF(K);
    out.y = groundY(out.x, out.z) + mouthH(K);
    return out;
  }
  /** The loader's place: beside the mouth on the far flank, facing it. */
  function loaderSpot(s, g, m) {
    const M = mouthPoint(s, g, m, new THREE.Vector3());
    const [rx, rz] = flankOf(m);
    return { x: M.x + rx * REACH, z: M.z + rz * REACH, mx: M.x, mz: M.z };
  }

  function pick(s, g) {
    const K = kindOf(s), at = g.attackTarget;
    const inReach = (o) => { const d = Math.hypot(o.position.x - g.position.x, o.position.z - g.position.z); return d >= K.min && d <= K.max; };
    if (at?.alive && !at.isAir && inReach(at)) return at;
    let best = null, bd = Infinity;
    for (const o of units.near ? units.near(g.position.x, g.position.z, K.max, []) : units.list) {
      if (!o.alive || o.team === g.team || o.isAir || o.passive || o.inside || (o.team !== "player" && o.team !== "enemy")) continue;
      const d = Math.hypot(o.position.x - g.position.x, o.position.z - g.position.z);
      if (d < K.min || d > K.max || d >= bd || !sees(g.team, o.position.x, o.position.z)) continue;
      best = o; bd = d;
    }
    return best;
  }

  /** The round leaves the tube (its mouth) for (x, z). */
  function fire(s, g, m, x, z) {
    const K = kindOf(s);
    const d = Math.hypot(x - g.position.x, z - g.position.z);
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * d * K.scatter;
    _w.set(x + Math.cos(a) * r, 0, z + Math.sin(a) * r);
    _w.y = groundY(_w.x, _w.z);
    mouthPoint(s, g, m, _v);
    projectiles.spawnArc(_v.clone(), _w.clone(), { damage: K.damage, splash: K.splash, owner: g, kind: K.kind });
    app.algSounds?.audio?.play?.("cannon", _v.x, _v.y, _v.z, { volume: 0.5 });
  }

  /** The chef de pièce: walking to his place (no part), then kneeling there with his binoculars toward
   *  the target (mortar_spot; the binoculars he wears on his chest put away meanwhile). [] if none. */
  function spotter(m, u, dt) {
    if (!u || !m.spot3) return [];
    const d = Math.hypot(u.position.x - m.spot3.x, u.position.z - m.spot3.z);
    if (d > 0.6 && u.isMoving) return [[u, null]];
    if (u.isMoving) u.haltMovement?.();
    settle(u, m.spot3, dt);
    const tx = m.base.x + Math.sin(m.facing) * 40, tz = m.base.z + Math.cos(m.facing) * 40;
    u.faceToward?.(tx, tz);
    if (!u._binosAway) { setKit(u, "binoculars", false); u._binosAway = true; }
    return [[u, "mortarSpot"]];
  }

  /** A crewman onto his exact place: the walk's arrival stops ~0.4 m short (on the tube) — the last
   *  decimetres a shuffle on his knees (no order: nothing reads it as a move). Each shuffle is his new
   *  standing point (haltMovement): a halted unit walks back to where it was halted — the two pulled
   *  him to and fro every step, the man shaking at the tube (you, 2026-10-15). */
  function settle(u, sp, dt) {
    const dx = sp.x - u.position.x, dz = sp.z - u.position.z, d = Math.hypot(dx, dz);
    if (d < 0.01) return;
    const k = Math.min(1, (dt * 1.2) / d);
    u.position.x += dx * k; u.position.z += dz * k;
    u.haltMovement?.();
  }

  /** A round: the loader starts his load; the round goes as the bomb slides home (step). */
  function load(s, m, x, z) {
    m.load = { t: 0, x, z, fired: false };
    m.seen = kindOf(s).every + 2;   // engaged until the round after next would be due
  }

  /** Who works the piece, and his part (null: walking to his place; "idle": kneeling at rest by it,
   *  the game's own crouch idle); everyone else back to himself.
   *  The crew are not pushed apart (units noPush): the loader's place beside the mouth is closer to the
   *  gunner than two men's radii — separation kept him walking at it forever. */
  function setCrew(m, parts) {
    for (const u of m.crew) if (!parts.some(([v]) => v === u)) {
      u.mortarClip = null; u.noPush = false;
      if (u._binosAway) { setKit(u, "binoculars", true); u._binosAway = false; }
      if (u._mortarHold !== undefined) { u.holdFire = u._mortarHold; delete u._mortarHold; }
    }
    m.crew = parts.map(([u]) => u);
    for (const [u, clip] of parts) {
      u.mortarClip = clip === "idle" ? null : clip;
      u.noPush = true;
      if (u._mortarHold === undefined) u._mortarHold = !!u.holdFire;
      u.holdFire = true; u.target = null;
      if (clip) u.posture = "kneel";
    }
  }
  const release = (m) => setCrew(m, []);

  // ── CARRIED: who has the tube and the plate on his back, by the state's progress ──
  // (setting: the plate down at PLATE_AT of the set-up, the tube at TUBE_AT; packing: the reverse)
  const PLATE_AT = 0.3, TUBE_AT = 0.62;
  function onGround(m) {
    if (m.state === "set") return { plate: true, tube: true };
    if (m.state === "setting") { const k = m.t / P.setup; return { plate: !m.placing && k >= PLATE_AT, tube: !m.placing && k >= TUBE_AT }; }
    if (m.state === "packing") { const k = m.t / P.pack; return { plate: k < 1 - PLATE_AT, tube: k < 1 - TUBE_AT }; }
    return { plate: false, tube: false };
  }
  const setKit = (u, name, on) => app.algUnitRenderer?.setKit?.(u, name, on);
  function carry(s, m, g, ld) {
    const down = onGround(m);
    const want = { tube: down.tube ? null : g, plate: down.plate ? null : ld ?? g };
    for (const k of ["tube", "plate"]) {
      const name = k === "tube" ? "mortarTube" : "mortarPlate";
      const had = m.carry?.[k] ?? null;
      if (had === want[k]) continue;
      if (had) setKit(had, name, false);
      if (want[k]) setKit(want[k], name, true);
      (m.carry ??= {})[k] = want[k];
    }
    // the men with a load on their back run with it, rifle slung (unitRenderer carryRun)
    for (const u of s.members) u.carrying = !!m.carry && (u === m.carry.tube || u === m.carry.plate);
  }

  function step(dt) {
    for (const s of teams()) {
      const m = stateOf(s), g = gunnerOf(s), K = kindOf(s);
      m.cool = Math.max(0, m.cool - dt);
      if (!g) { m.state = "packed"; release(m); continue; }
      // A mortar team never goes after a target (combat's noChase): it shoots back at what comes in
      // its rifles' reach, it does not walk off its piece toward an enemy 80 m away.
      for (const u of s.members) { u.noChase = true; u.noSmallArms = true; }   // (CoH: the piece is their only weapon)
      const ld = loaderOf(s, g);
      carry(s, m, g, ld);
      // THE CHEF DE PIÈCE (the third man): spots for the piece once it is going up (spotter below)
      const sp3 = s.slots.find((u) => u?.alive && u !== g && u !== ld) ?? null;
      // (the loader walking to his place is part of the set-up, not a move order)
      // (his walk's goal is the nav's, near his spot — a goal metres away is a new order)
      // An ORDER has a goal; a man shuffled by a nudge (or halted on his spot) has none — not a move.
      // (the chef de pièce walking to HIS place is part of it too)
      const toOwnSpot = (u) => (u === m.placing && m.spot && Math.hypot(u.goalPoint.x - m.spot.x, u.goalPoint.z - m.spot.z) < 2.5)
        || (u === sp3 && m.spot3 && Math.hypot(u.goalPoint.x - m.spot3.x, u.goalPoint.z - m.spot3.z) < 2.5);
      const moving = s.members.some((u) => u.isMoving && u.goalPoint && !toOwnSpot(u));
      switch (m.state) {
        case "packed":
          release(m);
          m.still = moving ? 0 : m.still + dt;
          if (m.still >= P.settle && !s.retreating) {
            m.state = "setting"; m.t = 0;
            const tg = pick(s, g);
            m.facing = tg ? Math.atan2(tg.position.x - g.position.x, tg.position.z - g.position.z) : g.heading ?? 0;
            // The baseplate goes down in front of him; he and the loader take their places round it.
            m.base = { x: g.position.x + Math.sin(m.facing) * GUNNER_GAP, z: g.position.z + Math.cos(m.facing) * GUNNER_GAP };
            m.far = farFlank(m.facing);
            // the chef de pièce's place: 2.5 m out on the far flank, a little back — clear of the crew
            if (sp3) {
              const [rx, rz] = flankOf(m), fx = Math.sin(m.facing), fz = Math.cos(m.facing);
              m.spot3 = { x: m.base.x + rx * 2.5 - fx * 0.8, z: m.base.z + rz * 2.5 - fz * 0.8 };
              sp3.moveOrder(m.spot3.x, m.spot3.z);
            }
            // The loader to his place beside the mouth.
            if (ld !== g) {
              const sp = loaderSpot(s, g, m);
              m.spot = sp;
              if (Math.hypot(ld.position.x - sp.x, ld.position.z - sp.z) > 0.35) { ld.moveOrder(sp.x, sp.z); m.placing = ld; }
            }
          }
          break;
        case "setting":
          if (moving || s.retreating) { m.state = "packed"; m.still = 0; m.placing = null; break; }
          m.t += dt;
          // The loader at his place: close enough (the walk's arrival is looser than the spot), or he has
          // tried long enough — halted there.
          if (m.placing && (!m.placing.isMoving || Math.hypot(m.placing.position.x - m.spot.x, m.placing.position.z - m.spot.z) < 0.5 || m.t > 4)) {
            m.placing.haltMovement?.();
            m.placing = null;
          }
          setCrew(m, [[g, "mortarSetup"], ...(ld !== g ? [[ld, ld === m.placing ? null : "mortarSetup"]] : []), ...spotter(m, sp3, dt)]);
          if (ld !== g && !m.placing && m.spot) { settle(ld, m.spot, dt); ld.faceToward?.(m.spot.mx, m.spot.mz); }
          { const gs = gunnerSpot(m); settle(g, gs, dt); g.faceToward?.(gs.mx, gs.mz); }
          if (m.t >= P.setup && !m.placing) { m.state = "set"; m.t = 0; }
          break;
        case "set": {
          // RETREAT: the tube is left as it is — they run at once.
          if (s.retreating) { m.state = "packed"; m.still = 0; m.salvo = null; m.load = null; break; }
          // A move: hold it, pack up first.
          if (moving) {
            m.held = s.members.map((u) => ({ u, goal: u.goalPoint ? { x: u.goalPoint.x, z: u.goalPoint.z } : null }));
            for (const u of s.members) u.haltMovement?.();
            m.state = "packing"; m.t = 0; m.salvo = null; m.load = null;
            break;
          }
          // The crew at the piece: the gunner lays it, the loader waits with a bomb or loads it.
          const sp = loaderSpot(s, g, m);
          m.spot = sp;
          if (ld !== g) { settle(ld, sp, dt); ld.faceToward?.(sp.mx, sp.mz); }
          { const gs = gunnerSpot(m); settle(g, gs, dt); g.faceToward?.(gs.mx, gs.mz); }
          if (m.load) {
            m.load.t += dt;
            if (!m.load.fired && m.load.t >= DROP_AT + SLIDE) { m.load.fired = true; fire(s, g, m, m.load.x, m.load.z); }
            if (m.load.t >= LOAD) m.load = null;
          }
          // AT REST between the work (you, 2026-10-15: "when not firing they should idle crouched"): the
          // gunner lays the piece while it is ENGAGED (a round in the last few seconds, a salvo), else he
          // kneels at rest; the loader kneels at rest after each round and takes up the next bomb only
          // shortly before it goes (mortar_wait: READY s ahead), then loads it.
          const loading = !!m.load;
          m.seen = Math.max(0, (m.seen ?? 0) - dt);
          const engaged = loading || !!m.salvo || m.seen > 0;
          // (at rest: mortar_rest — kneeling, rifle slung; the game's kneeling idle put it back in his hands)
          const gPart = engaged ? "mortarLay" : "mortarRest";
          const ldPart = loading ? "mortarLoad" : engaged && (m.salvo || m.cd < READY) ? "mortarWait" : "mortarRest";
          setCrew(m, [...(ld !== g ? [[g, gPart], [ld, ldPart]] : [[g, loading ? "mortarLoad" : gPart]]), ...spotter(m, sp3, dt)]);
          m.cd -= dt;
          if (m.salvo) {
            if (!loading && (m.salvo.t -= dt) <= 0) {
              const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * K.barrage.spread;
              load(s, m, m.salvo.x + Math.cos(a) * r, m.salvo.z + Math.sin(a) * r);
              m.salvo.t = K.barrage.every - LOAD;
              if (--m.salvo.left <= 0) { m.salvo = null; m.cd = K.every; }
            }
            break;
          }
          if (m.cd > 0 || loading) break;
          const tg = pick(s, g);
          if (!tg) { m.cd = 1; break; }
          m.facing = Math.atan2(tg.position.x - g.position.x, tg.position.z - g.position.z);
          g.target = null;
          load(s, m, tg.position.x, tg.position.z);
          m.cd = K.every;
          break;
        }
        case "packing":
          if (s.retreating) { m.state = "packed"; m.still = 0; m.held = null; break; }
          m.t += dt;
          setCrew(m, [[g, "mortarSetup"], ...(ld !== g ? [[ld, "mortarSetup"]] : [])]);
          // A new order while packing: remember it, keep still.
          for (const u of s.members) if (u.isMoving && u.goalPoint) {
            m.held ??= [];
            const h = m.held.find((q) => q.u === u);
            if (h) h.goal = { x: u.goalPoint.x, z: u.goalPoint.z }; else m.held.push({ u, goal: { x: u.goalPoint.x, z: u.goalPoint.z } });
            u.haltMovement?.();
          }
          if (m.t >= P.pack) {
            m.state = "packed"; m.still = 0;
            release(m);
            for (const h of m.held ?? []) if (h.goal && h.u.alive) h.u.moveOrder(h.goal.x, h.goal.z);
            m.held = null;
          }
          break;
      }
    }
    for (const s of [...st.keys()]) if (!squads.list.includes(s)) { release(st.get(s)); st.delete(s); }
  }

  // ── TIR DE BARRAGE (the human's mortar teams) ───────────────────────────────
  const mine = (sel) => squads.squadsIn(sel).filter((s) => KINDS[s.typeKey] && isHuman(s.team) && gunnerOf(s));
  function ability(sel) {
    const ss = mine(sel);
    if (!ss.length) return null;
    const s = ss[0], m = stateOf(s), K = kindOf(s), purse = purseOf(s);
    const set = m.state === "set";
    return {
      key: "mortarBarrage", label: t("Tir de barrage"), cost: K.barrage.cost,
      ready: set && !m.salvo && m.cool <= 0 && !!purse?.canAfford(K.barrage.cost),
      hint: !set ? t("Le mortier doit être en batterie : arrêtez l'équipe quelques secondes.")
        : m.cool > 0 ? t("Le tube refroidit encore ({n} s).", { n: Math.ceil(m.cool) })
          : t("{n} obus sur un point que vous choisissez, entre {min} et {max} m du mortier.", { n: K.barrage.shells, min: K.min, max: K.max }),
    };
  }
  function begin(sel) {
    const s = mine(sel).find((q) => stateOf(q).state === "set");
    if (!s) return false;
    targeting = { s, at: null, ok: false };
    dom.style.cursor = "crosshair";
    return true;
  }
  function cancel() { targeting = null; dom.style.cursor = ""; }
  function aim(e) {
    const p = app.pickWorldAtClient?.(e.clientX, e.clientY)?.point;
    const g = gunnerOf(targeting.s), K = kindOf(targeting.s);
    targeting.at = p ? { x: p.x, z: p.z } : null;
    if (!p || !g) { targeting.ok = false; return; }
    const d = Math.hypot(p.x - g.position.x, p.z - g.position.z);
    targeting.ok = d >= K.min && d <= K.max;
  }
  const onMove = (e) => { if (targeting) aim(e); };
  function onDown(e) {
    if (!targeting) return;
    if (e.button === 2) { cancel(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.button !== 0) return;
    e.preventDefault(); e.stopImmediatePropagation();
    aim(e);
    const { s, at, ok } = targeting;
    if (!at || !ok) return;
    const m = stateOf(s), K = kindOf(s), purse = purseOf(s);
    if (m.state === "set" && purse?.spend(K.barrage.cost)) {
      m.salvo = { x: at.x, z: at.z, left: K.barrage.shells, t: 0 };
      m.cool = K.barrage.cooldown;
    }
    cancel();
  }
  const onContext = (e) => { if (targeting) { e.preventDefault(); e.stopImmediatePropagation(); cancel(); } };
  const onKey = (e) => { if (targeting && e.key === "Escape") cancel(); };
  dom.addEventListener("pointermove", onMove);
  dom.addEventListener("pointerdown", onDown, true);
  dom.addEventListener("contextmenu", onContext, true);
  window.addEventListener("keydown", onKey);

  // ── The tubes on the ground (one instanced draw), the reach rings ──────────
  const MAXT = 24;
  const tubes = new THREE.InstancedMesh(buildMortarTube(), rtsObjectMaterialTinted(FR_PAINT_TINT), MAXT);
  tubes.castShadow = true;
  tubes.frustumCulled = false;
  tubes.count = 0;
  tubes.visible = false;
  tubes.name = "MortarTeamTubes";
  app.scene.add(tubes);
  const plates = new THREE.InstancedMesh(new THREE.BoxGeometry(0.38, 0.035, 0.34), rtsObjectMaterialTinted(FR_PAINT_TINT), MAXT);
  plates.castShadow = true; plates.frustumCulled = false; plates.count = 0; plates.visible = false;
  plates.name = "MortarTeamPlates";
  app.scene.add(plates);
  const rings = createSelectionRingField({ app, inner: 0.94, segments: 72 });
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  // A tube's recoil: a round driven back into the baseplate (s since it fired → a short kick).
  const kickOf = (m) => (m.load?.fired ? Math.max(0, 1 - (m.load.t - DROP_AT - SLIDE) / 0.25) : 0);
  function frame() {
    let n = 0, np = 0;
    rings.begin();
    for (const s of teams()) {
      const m = stateOf(s), g = gunnerOf(s), K = kindOf(s);
      if (!g) continue;
      // The plate, then the tube, on the ground once set down (carried before: CARRIED above).
      const down = m.base ? onGround(m) : { plate: false, tube: false };
      if (down.plate && np < MAXT) {
        basePoint(g, m, _p);
        _p.y = groundY(_p.x, _p.z) + 0.012;
        _q.setFromAxisAngle(_up, m.facing);
        plates.setMatrixAt(np++, _m.compose(_p, _q, _s.setScalar(1)));
      }
      if (down.tube && n < MAXT) {
        basePoint(g, m, _p);
        const kick = kickOf(m) ** 2 * 0.06;
        _p.y = groundY(_p.x, _p.z) - kick;
        _q.setFromAxisAngle(_up, m.facing);
        _s.setScalar(K.tube);
        tubes.setMatrixAt(n++, _m.compose(_p, _q, _s));
      }
      // The reach, for your selected teams: the outer ring, and the dead zone inside.
      if (isHuman(s.team) && s.members.some((u) => u.selected)) {
        rings.add(g.position.x, g.position.z, K.max, 0xe0a93a);
        rings.add(g.position.x, g.position.z, K.min, 0xe0574a);
      }
    }
    if (targeting?.at) rings.add(targeting.at.x, targeting.at.z, kindOf(targeting.s).barrage.spread, targeting.ok ? 0x58e070 : 0xe0574a);
    rings.commit();
    tubes.count = n;
    tubes.visible = n > 0;
    if (n) tubes.instanceMatrix.needsUpdate = true;
    plates.count = np;
    plates.visible = np > 0;
    if (np) plates.instanceMatrix.needsUpdate = true;
  }

  return {
    params: P, kinds: KINDS, step, frame, ability, begin, cancel,
    /** A squad's state (dev, tests): "packed" | "setting" | "set" | "packing". */
    stateOf: (s) => stateOf(s).state,
    /** An AI's eyes for its side's teams: (x, z) => true when it knows an enemy there. */
    setSight(team, fn) { sight[team] = fn; },
    /** What `team` sees at (x, z) — its fog, or its AI's eyes (the mortar pits ask it too). */
    sees,
    /**
     * AN AI'S BARRAGE (the player's is the ability's click): `s` set up, cool, the price paid from its
     * side's purse, (x, z) in reach. True when the salvo is ordered.
     */
    fireBarrage(s, x, z) {
      const m = st.get(s), g = gunnerOf(s), K = kindOf(s), purse = purseOf(s);
      if (!m || !g || !K || m.state !== "set" || m.salvo || m.cool > 0) return false;
      const d = Math.hypot(x - g.position.x, z - g.position.z);
      if (d < K.min || d > K.max || !purse?.spend(K.barrage.cost)) return false;
      m.salvo = { x, z, left: K.barrage.shells, t: 0 };
      m.cool = K.barrage.cooldown;
      return true;
    },
    /** A team's reach (m): { min, max }. */
    reachOf: (s) => { const K = kindOf(s); return K ? { min: K.min, max: K.max } : null; },
    /** A squad's whole record (dev, tests). */
    recordOf: (s) => st.get(s) ?? null,
    dispose() {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerdown", onDown, true);
      dom.removeEventListener("contextmenu", onContext, true);
      window.removeEventListener("keydown", onKey);
      app.scene.remove(tubes);
      app.scene.remove(plates);
    },
  };
}
