// CIVILIANS — the villages' people (2026-10-09, you: "civilians in the villages"). The war is
// over the population; until now the mechtas, the dechra and the ksar stood empty.
//
// THEY ARE PEOPLE, NOT PIECES (this game's rule, TODO "Decisions"): never a target, never hit,
// never selected, never counted in a capture. So they are not units of the battle at all: their
// own unit list and their own crowd renderer (shared unitRenderer, `unarmed: true` — the pack's
// unarmed idle / walk / run). Combat, the selection, the AI, the economy and the minimap never
// see them; nothing in the battle can aim at what it cannot find.
//
// THEIR DAY: each villager has a home door; he walks between the village's doors, its well and
// the open ground inside its ring, stops there a while — two of them often together, talking.
// THE FIGHTING: shooting within reach (a man of either side with a live target near), and they
// RUN to the nearest door and go in; out again once it has been quiet a while. A SHEPHERD walks
// behind each flock (algHerds' moving home).
//
// Their looks are the soldier lab's (shared-rts/soldierLooks.js civMan, civElder, civShepherd,
// civWomanHaik, civWomanMlaya). Fog of war: seen only where you see (the renderer hides a team
// that is not the player's). ?civ=0 = without.
//
// THE MOUSSEBEL (step 2, 2026-10-09 — you: "a shepherd's house, and when we come very close the
// shepherd fires at us"): at a few FARMSTEADS (algLandmarks' mechtaFarm pieces: one family's place
// out in the land, a pen for the goats) a "shepherd" idles in the yard — drawn as a civilian, a
// civilian to everything in the game. He is the FLN's: when French come within P.revealAt, he is
// gone from this list and a MOUSSEBEL (algUnitTypes: the same clothes, an old rifle) stands where he
// was, in the battle — an enemy from then on, firing from his yard (`noChase`). Which farms: drawn
// anew each game (not the same ones twice). ?moussebel=0 = none.
import { createUnits } from "../shared-rts/units.js";
import { createUnitRenderer } from "../shared-rts/unitRenderer.js";
import { ALG_UNIT_TYPES } from "./algUnitTypes.js";
import { t } from "./i18n/i18n.js";

const P = {
  // villagers out per village, by kind
  count: { hamlet: 4, dechra: 6, ksar: 8, oasis: 4 },
  women: 0.4,           // share of women (half in the white haïk, half in the black mlaya)
  walk: 1.9,            // m/s (a walk at the units' 1.3x scale)
  runMul: 2.4,          // running for a door
  wait: [8, 22],        // s standing at a spot
  pairChance: 0.45,     // a villager goes to stand with another (talking)
  danger: 75,           // m: a man of either side with a live target this near — run
  calm: 25,             // s of quiet before they come back out
  enter: 2.2,           // m from the door: inside
  check: 0.5,           // s between danger checks
  stuck: 3,             // s without getting anywhere (caught on a wall corner): another door, then in where he is
  shepherdBehind: 7,    // m behind the flock's home
  // the moussebel (step 2)
  farms: 2,             // farmsteads with a "shepherd" who is the FLN's (drawn each game)
  revealAt: 22,         // m: French this near (on foot or in a vehicle) — he takes up his rifle
};

/** The civilian types: the moudjahid's body and size, their own looks, no weapon. */
function civTypes() {
  const base = ALG_UNIT_TYPES.moudjahid;
  const civ = (typeKey, name, look, bodies) => ({
    ...base, typeKey, name, look, bodies, body: undefined, unarmed: true, weapon: null, grenade: false,
    range: 0, damage: 0, fireRate: 0, vision: 0, speed: P.walk, maxHp: 1, crowdMax: 24, castShadow: true,
  });
  return {
    civMan: civ("civMan", t("Villageois"), "civMan", ["aln1", "aln2"]),
    civElder: civ("civElder", t("Ancien"), "civElder", ["aln1", "aln2"]),
    civShepherd: civ("civShepherd", t("Berger"), "civShepherd", ["aln1", "aln2"]),
    civWomanHaik: civ("civWomanHaik", t("Villageoise"), "civWomanHaik", ["soldier1"]),
    civWomanMlaya: civ("civWomanMlaya", t("Villageoise"), "civWomanMlaya", ["soldier1"]),
  };
}

export async function createAlgCivilians(app, { economy, garrison, herds = null, navGrid = null, showroom = {}, fogOfWar = null, battleUnits = null }) {
  const TYPES = civTypes();
  const people = createUnits({ app, navGrid, types: TYPES, spawn: {}, origin: { x: 0, z: 0 } });
  const renderer = await createUnitRenderer({
    app, units: people, healthBars: { add() {} }, selectionRings: null, barFor: () => false, fogOfWar,
    types: TYPES, unarmed: true, thumbnailFor: () => false,
    // No x-ray silhouette through the walls: that is how you find YOUR men and the enemy, not them.
    noXray: true,
  });

  // ── The villages: their doors, their well, their ground ───────────────────
  const wells = Object.entries(showroom).filter(([k, o]) => k.startsWith("well") && o?.isObject3D).map(([, o]) => o.position);
  let seed = 9173;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const open = (x, z) => navGrid?.nearestOpenWorld?.(x, z, true) ?? { x, z };
  // Every house of the placed village pieces (the garrison's mechtas and dechra, and the ksar's,
  // which have no door of their own: the open ground nearest the house stands for it).
  const houseDoors = [];
  for (const o of Object.values(showroom)) {
    const hs = o?.isObject3D ? o.geometry?.userData?.houses : null;
    if (!hs?.length) continue;
    const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
    const W = (x, z) => ({ x: o.position.x + x * c + z * s, z: o.position.z - x * s + z * c });
    for (const h of hs) {
      const at = W(h.x, h.z), d = h.door ? W(h.door[0], h.door[1]) : at;
      houseDoors.push({ x: at.x, z: at.z, door: open(d.x, d.z) });
    }
  }
  const villages = [];
  for (const v of economy.points) {
    const r = v.radius ?? 40;
    const doors = houseDoors.filter((h) => Math.hypot(h.x - v.position.x, h.z - v.position.z) < r).map((h) => h.door);
    if (!doors.length) continue;
    const well = wells.find((w) => Math.hypot(w.x - v.position.x, w.z - v.position.z) < r + 25);
    villages.push({ point: v, r, doors, well: well ? open(well.x + 3, well.z + 3) : null, people: [] });
  }
  /** A place to stand in village `vg`: by a door, at the well, or out in its ground. */
  function spot(vg) {
    const k = rnd();
    if (k < 0.5) { const d = vg.doors[Math.floor(rnd() * vg.doors.length)]; return open(d.x + (rnd() - 0.5) * 4, d.z + (rnd() - 0.5) * 4); }
    if (k < 0.7 && vg.well) return open(vg.well.x + (rnd() - 0.5) * 3, vg.well.z + (rnd() - 0.5) * 3);
    const a = rnd() * Math.PI * 2, d = vg.r * (0.2 + 0.55 * rnd());
    return open(vg.point.position.x + Math.cos(a) * d, vg.point.position.z + Math.sin(a) * d);
  }

  // ── The people ─────────────────────────────────────────────────────────────
  const folk = [];   // { u, vg, home, state: "wait" | "walk" | "run" | "in", t, calm }
  for (const vg of villages) {
    const n = P.count[vg.point.kind] ?? 4;
    for (let i = 0; i < n; i++) {
      const type = i === 0 ? "civElder" : rnd() < P.women ? (rnd() < 0.5 ? "civWomanHaik" : "civWomanMlaya") : "civMan";
      const home = vg.doors[i % vg.doors.length];
      const at = spot(vg);
      const u = people.spawn(type, at.x, at.z, { team: "civil", lookRole: Math.floor(rnd() * 12) });
      if (!u) continue;
      { const a = rnd() * Math.PI * 2; u.faceToward?.(at.x + Math.cos(a), at.z + Math.sin(a)); }
      const f = { u, vg, home, state: "wait", t: P.wait[0] + rnd() * (P.wait[1] - P.wait[0]), calm: 0, lag: rnd() * 8 };
      folk.push(f);
      vg.people.push(f);
    }
  }
  // A shepherd behind each flock that walks.
  const shepherds = [];
  for (const fl of herds?.flocks ?? []) {
    if (!fl.anchor) continue;
    const at = open(fl.anchor.x + 4, fl.anchor.z + 4);
    const u = people.spawn("civShepherd", at.x, at.z, { team: "civil", lookRole: Math.floor(rnd() * 12) });
    if (u) shepherds.push({ u, flock: fl, t: rnd() });
  }

  // The MOUSSEBEL's farms: a few farmsteads, drawn anew each game; a "shepherd" in each yard.
  const auxes = [];
  if (new URLSearchParams(location.search).get("moussebel") !== "0") {
    const own = (k) => /^mechtaFarmMap/.test(k);
    const entries = Object.entries(showroom).filter(([k, o]) => /^mechtaFarm/.test(k) && o?.isObject3D);
    for (let i = entries.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [entries[i], entries[j]] = [entries[j], entries[i]]; }
    // A map's own farmsteads first (the training's lesson needs its one).
    entries.sort(([a], [b]) => (own(b) ? 1 : 0) - (own(a) ? 1 : 0));
    const farms = entries.map(([, o]) => o);
    for (const o of farms.slice(0, P.farms)) {
      // the yard: in front of the house (the farmstead's front, its gate, is at local -Z)
      const c = Math.cos(o.rotation.y), s = Math.sin(o.rotation.y);
      const yard = (lx, lz) => open(o.position.x + lx * c + lz * s, o.position.z - lx * s + lz * c);
      const spots = [yard(0, -4), yard(-4, -7), yard(4, -8), yard(0, -11)];
      const at = spots[0];
      const u = people.spawn("civShepherd", at.x, at.z, { team: "civil", lookRole: Math.floor(rnd() * 12) });
      if (u) auxes.push({ u, farm: o, spots, t: 4 + rnd() * 10, revealed: false, fighter: null });
    }
  }
  /** The moussebel: French close — the civilian is gone, the FLN's man stands there with his rifle. */
  function reveal(a, by) {
    a.revealed = true;
    const { x, z } = a.u.position;
    a.u.inside = true;   // out of this list's drawing for good
    a.u.haltMovement?.();
    const m = battleUnits?.spawn?.("moussebel", x, z, { team: "enemy", lookRole: a.u.lookRole ?? null });
    if (!m) return;
    m.noChase = true;    // he holds his yard
    m.faceToward?.(by.position.x, by.position.z);
    a.fighter = m;
    app.algBattle?.say?.(t("<b>Le berger ouvre le feu !</b> Un moussebel du FLN, à la ferme."), x, z, "bad", "hq_contact");
  }

  // ── Their sound (2026-10-09): voices in a village while its people are out (a loop at the middle
  // of those out, louder the more there are); a shout as the first runs for a door; the door shut
  // behind each, and opened as they come back out. (algSounds' slots murmur, shout, door.)
  const audio = () => app.algSounds?.audio ?? null;
  const yAt = (x, z) => app.getWorldHeight?.(x, z) ?? 0;
  const loopsOn = audio()?.addLoopProvider;
  if (loopsOn) audio().addLoopProvider(() => {
    const out = [];
    for (const vg of villages) {
      let n = 0, x = 0, z = 0;
      for (const f of vg.people) if (f.state === "wait" || f.state === "walk") { n++; x += f.u.position.x; z += f.u.position.z; }
      if (n < 2) continue;
      x /= n; z /= n;
      out.push({ slot: "murmur", key: vg, x, y: yAt(x, z) + 1.6, z, level: Math.min(1, n / 5) });
    }
    return out;
  });
  const shoutAt = new Map();   // village → when its last shout was
  function shout(f) {
    const now = performance.now() / 1000;
    if (now - (shoutAt.get(f.vg) ?? -99) < 6 || rnd() > 0.6) return;
    shoutAt.set(f.vg, now);
    audio()?.play?.("shout", f.u.position.x, yAt(f.u.position.x, f.u.position.z) + 1.7, f.u.position.z, { gain: 0.9 });
  }
  const door = (p, gain = 1) => audio()?.play?.("door", p.x, yAt(p.x, p.z) + 1.2, p.z, { gain, delay: rnd() * 0.15 });

  // ── Their day ──────────────────────────────────────────────────────────────
  const fighting = (x, z) => {
    for (const m of battleUnits?.list ?? []) {
      if (!m.alive || m.isStructure || !m.target?.alive) continue;
      if (Math.abs(m.position.x - x) < P.danger && Math.abs(m.position.z - z) < P.danger && Math.hypot(m.position.x - x, m.position.z - z) < P.danger) return true;
    }
    return false;
  };
  const near = (u, p, r) => Math.hypot(u.position.x - p.x, u.position.z - p.z) < r;
  function goIn(f, avoid = null) {
    // the nearest door of his village (his own if it is as near); `avoid`: the one he could not reach
    let best = null, bd = Infinity;
    for (const d of [f.home, ...f.vg.doors]) {
      if (d === avoid) continue;
      const dd = Math.hypot(d.x - f.u.position.x, d.z - f.u.position.z) - (d === f.home ? 4 : 0);
      if (dd < bd) { bd = dd; best = d; }
    }
    if (!best) return;
    if (f.state !== "run" && f.state !== "duck") shout(f);   // (a duck shouted already)
    f.stuck = 0; f.best = Infinity;
    f.door = best;
    f.state = "run";
    f.u.running = true;
    f.u.moveMul = P.runMul;
    f.u.orderTo(best.x, best.z);
  }
  let checkT = 0;
  function step(dt) {
    people.update(dt);
    checkT -= dt;
    const check = checkT <= 0;
    if (check) checkT = P.check;
    for (const f of folk) {
      const u = f.u;
      // STUCK (a wall corner the path rounds too tight — he jitters on the spot): no nearer his
      // goal for P.stuck s.
      if (check && (f.state === "run" || f.state === "walk")) {
        const g = f.state === "run" ? f.door : f.goal;
        const d = g ? Math.hypot(u.position.x - g.x, u.position.z - g.z) : 0;
        if (d < (f.best ?? Infinity) - 0.5) { f.best = d; f.stuck = 0; } else f.stuck = (f.stuck ?? 0) + P.check;
      }
      if (f.stuck >= (f.state === "walk" ? P.stuck * 2 : P.stuck)) {   // (a walk round a house moves away a while)
        f.stuck = 0;
        if (f.state === "walk") { u.haltMovement?.(); f.state = "wait"; f.t = 3 + rnd() * 5; }
        else if (f.state === "run" && !f.retried) { f.retried = true; goIn(f, f.door); }
        else if (f.state === "run") { f.state = "in"; f.calm = 0; u.inside = true; u.running = false; u.moveMul = 1; u.haltMovement?.(); f.door = { x: u.position.x, z: u.position.z }; }
        continue;
      }
      // THE FIGHTING: the first shots, he DUCKS where he is (Mixamo "Terrified", 2026-10-17) — a second
      // or two — then runs for a door.
      if (f.state === "duck") { if ((f.t -= dt) <= 0) goIn(f); continue; }
      if (check && f.state !== "in" && f.state !== "run" && fighting(u.position.x, u.position.z)) {
        f.state = "duck"; f.t = 1.2 + rnd() * 0.8;
        u.haltMovement?.();
        u.playOnce = "cower";
        shout(f);
        continue;
      }
      if (f.state === "run") {
        if (near(u, f.door, P.enter) || (!u.isMoving && near(u, f.door, 6))) {
          door(f.door);
          f.state = "in"; f.calm = 0; f.retried = false; u.inside = true; u.running = false; u.moveMul = 1;
          u.haltMovement?.();
        } else if (!u.isMoving) u.orderTo(f.door.x, f.door.z);
        continue;
      }
      if (f.state === "in") {
        if (check) f.calm = fighting(f.door.x, f.door.z) ? 0 : f.calm + P.check;
        if (f.calm >= P.calm + f.lag) {   // not all at once
          u.inside = false; u.position.x = f.door.x; u.position.z = f.door.z;
          door(f.door, 0.6);
          f.state = "wait"; f.t = 2 + rnd() * 6; f.retried = false;
        }
        continue;
      }
      // THEIR DAY
      if (f.state === "walk") {
        if (!u.isMoving) { f.state = "wait"; f.t = P.wait[0] + rnd() * (P.wait[1] - P.wait[0]); if (f.face) u.faceToward?.(f.face.x, f.face.z); }
        continue;
      }
      if ((f.t -= dt) > 0) continue;
      // Next: alone somewhere, or to stand with another villager (talking).
      const other = rnd() < P.pairChance ? f.vg.people.find((o) => o !== f && o.state === "wait" && o.t > 6) : null;
      if (other) {
        const a = rnd() * Math.PI * 2, p = open(other.u.position.x + Math.cos(a) * 1.4, other.u.position.z + Math.sin(a) * 1.4);
        f.face = other.u.position;
        other.t = Math.max(other.t, 10);
        other.u.faceToward?.(p.x, p.z);
        u.orderTo(p.x, p.z);
        f.goal = p;
      } else {
        const p = spot(f.vg);
        f.face = null;
        u.orderTo(p.x, p.z);
        f.goal = p;
      }
      f.state = "walk"; f.stuck = 0; f.best = Infinity;
    }
    // The shepherds: behind their flock's home, a few metres back.
    for (const s of shepherds) {
      if ((s.t -= dt) > 0) continue;
      s.t = 1 + rnd();
      const A = s.flock.anchor, u = s.u;
      const d = Math.hypot(A.x - u.position.x, A.z - u.position.z);
      if (d > P.shepherdBehind + 4) {
        const k = (d - P.shepherdBehind) / d;
        u.orderTo(u.position.x + (A.x - u.position.x) * k, u.position.z + (A.z - u.position.z) * k);
      }
    }
    // The moussebel: about his yard, until the French come.
    for (const a of auxes) {
      if (a.revealed) continue;
      const u = a.u;
      if (check) {
        const by = (battleUnits?.list ?? []).find((m) => m.alive && m.team === "player" && !m.isAir && !m.inside && !m.isStructure
          && Math.abs(m.position.x - u.position.x) < P.revealAt && Math.abs(m.position.z - u.position.z) < P.revealAt
          && Math.hypot(m.position.x - u.position.x, m.position.z - u.position.z) < P.revealAt);
        if (by) { reveal(a, by); continue; }
      }
      if (u.isMoving || (a.t -= dt) > 0) continue;
      a.t = 8 + rnd() * 14;
      const p = a.spots[Math.floor(rnd() * a.spots.length)];
      u.orderTo(p.x, p.z);
    }
  }

  return {
    params: P, people, renderer, folk, shepherds, villages, auxes, step,
    /** Draw them (each frame). */
    frame(dt, camera) { renderer.sync(dt, camera); },
    get stats() { return { villages: villages.length, people: folk.length, shepherds: shepherds.length, moussebels: auxes.length, inside: folk.filter((f) => f.state === "in").length }; },
  };
}
