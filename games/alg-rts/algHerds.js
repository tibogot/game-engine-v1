// HERDS — the Aurès' flocks: sheep and goats grazing together round the mechtas,
// below the dechra and near the springs; and the villages' DONKEYS, tied up
// outside the walls and at the springs, a few of them loaded (blanket and two
// baskets) — working animals: they stay put and do not bolt from soldiers. GAME code (what grazes where); the
// animals come from the engine's builder (v3/props/animalMorph.js: the pack's
// donkey reshaped into a goat and a sheep, the lab is v3/sheep-lab.html), the
// behaviour from the shared herd (shared-rts/wildHerd.js: graze, wander, look
// up, BOLT from soldiers — one GPU crowd draw per kind).
//
// Mixed flocks, as they graze here: a pasture holds a dozen sheep and a
// handful of goats. The goats take steeper ground than the sheep. Nothing
// grazes inside a village's walls, in the wadi beds' water, or near the
// French post or the katiba.
//
// ON THE MOVE (2026-09-29): each flock has a moving home that walks a loop
// round its village — its pasture, other grazing ground, down to the well's
// troughs to drink — resting a minute or two at each; the flock follows in
// bursts, bunched, goats in front, and regroups after it bolts. And a DONKEY
// TRAIN on each ravine mule path (algTracks.js): a loaded donkey on the lead,
// a bare one behind, up to the gully mouth and back.
import * as THREE from "three";
import { getSharedGltfLoader } from "../../v2/core/foliage/glbLoader.js";
import { initAnimalMorph, createMorphTemplate } from "../../v3/props/animalMorph.js";
import { createWildHerd } from "../shared-rts/wildHerd.js";
import { LAYOUT } from "./layout.js";
import { TRACK_LINES } from "./algTracks.js";

// Algeria's breeds, as far as the low-poly style carries them: a HAMRA-like
// sheep (white fleece, red-brown face and legs) and a black-brown Arbia goat.
const SHEEP = { woolColor: "#ebe4d6", faceColor: "#6a3a24", legColor: "#5a3322" };
const GOAT = {};
// The donkeys: the Algerian donkey (ash grey, dorsal stripe and shoulder
// cross); about a third carry the load, the rest go bare.
const DONKEY_BARE = { load: "none" };
const DONKEY_LOADED = { load: "panniers" };
const LOADED_SHARE = 0.35;

/**
 * Builds the flocks and hooks their update. Returns { herds, pastures } or null.
 * @param {object} o.units  the game's units (their `list`), whom the flocks flee
 * @param {object} o.showroom  the placed pieces (the wells the flocks drink at)
 */
export async function createAlgHerds(app, { units = null, showroom = null } = {}) {
  const t0 = performance.now();
  const gltf = await getSharedGltfLoader().loadAsync("/models/Donkey_compressed.glb");
  await initAnimalMorph(gltf);
  const sheepTpl = createMorphTemplate("sheep", SHEEP);
  const goatTpl = createMorphTemplate("goat", GOAT);
  const donkeyTpl = createMorphTemplate("donkey", DONKEY_BARE);
  const loadedTpl = createMorphTemplate("donkey", DONKEY_LOADED);

  const sites = LAYOUT.sites;
  const keepOut = sites.filter((s) => ["french", "aln"].includes(s.kind)).map((s) => ({ x: s.x, z: s.z, r: 90 }));
  // The villages' cores (80% of their radius — their buildings block the nav
  // grid anyway): at r + 6 the wells at the village edge were out of reach.
  const walls = sites.filter((s) => ["dechra", "hamlet", "koubba", "cemetery"].includes(s.kind)).map((s) => ({ x: s.x, z: s.z, r: s.r * 0.8 }));
  const inAny = (list, x, z) => list.some((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < c.r * c.r);
  /** Ground a sheep (or, with `minUp` lower, a goat) can stand on → its y, or null. */
  const standable = (minUp) => (x, z) => {
    if (Math.abs(x) > 500 || Math.abs(z) > 500) return null;
    const y = app.getWorldHeight(x, z);
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.3) return null;
    if (app.getWorldNormal(x, z).y < minUp) return null;
    if (app.navGrid?.isBlockedAtWorld?.(x, z)) return null;
    if (inAny(walls, x, z) || inAny(keepOut, x, z)) return null;
    return y;
  };
  const sheepStand = standable(0.9), goatStand = standable(0.8);

  let seed = 4242;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Pastures: just outside each mechta and the dechra, and near the springs.
  const homes = sites.filter((s) => ["hamlet", "dechra", "oasis"].includes(s.kind));
  const pastures = [];
  for (const s of homes) {
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2, d = s.r + 18 + rnd() * 30;
      const x = s.x + Math.sin(a) * d, z = s.z + Math.cos(a) * d;
      if (sheepStand(x, z) == null || pastures.some((p) => Math.hypot(p.x - x, p.z - z) < 50)) continue;
      pastures.push({ x, z, site: s.name });
      break;
    }
  }
  const around = (c, n, r, stand) => {
    const out = [];
    for (let k = 0; k < 80 && out.length < n; k++) {
      const a = rnd() * Math.PI * 2, d = 1.5 + rnd() * r;
      const x = c.x + Math.cos(a) * d, z = c.z + Math.sin(a) * d;
      if (stand(x, z) != null) out.push({ x, z });
    }
    return out;
  };
  const sheepSpots = [], goatSpots = [];
  // Each pasture's flock has a MOVING HOME (an anchor, wildHerd.js): the
  // animals hold their places round it, the goats out in FRONT (they lead a
  // flock), and it drifts over the day (flockRoutes below).
  const flocks = [];
  for (const p of pastures) {
    const anchor = { x: p.x, z: p.z, yaw: rnd() * Math.PI * 2, moving: false };
    flocks.push({ anchor, site: sites.find((s) => s.name === p.site) });
    const place = (q, fwd = 0) => ({ ...q, anchor, follow: "loose", off: { x: (q.x - p.x), z: (q.z - p.z) * 0.8 + fwd } });
    // a dozen sheep, a few of them lambs; five or six goats, one or two kids
    for (const q of around(p, 10 + Math.floor(rnd() * 5), 8, sheepStand)) {
      sheepSpots.push({ ...place(q), height: sheepTpl.height * (rnd() < 0.2 ? 0.62 : 0.9 + rnd() * 0.2) });
    }
    for (const q of around(p, 5 + Math.floor(rnd() * 2), 7, goatStand)) {
      goatSpots.push({ ...place(q, 8), height: goatTpl.height * (rnd() < 0.2 ? 0.62 : 0.9 + rnd() * 0.18) });
    }
  }
  // Donkeys: 3-4 tied just outside each village's walls, 2 at each spring.
  const donkeySpots = [], loadedSpots = [];
  for (const s of homes) {
    const n = s.kind === "oasis" ? 2 : 3 + Math.floor(rnd() * 2);
    let placed = 0;
    for (let k = 0; k < 60 && placed < n; k++) {
      const a = rnd() * Math.PI * 2, d = s.kind === "oasis" ? s.r * 0.6 + rnd() * 10 : s.r + 8 + rnd() * 8;
      const x = s.x + Math.sin(a) * d, z = s.z + Math.cos(a) * d;
      if (sheepStand(x, z) == null) continue;
      if ([...donkeySpots, ...loadedSpots].some((q) => Math.hypot(q.x - x, q.z - z) < 4)) continue;
      const loaded = rnd() < LOADED_SHARE;
      const tpl = loaded ? loadedTpl : donkeyTpl;
      (loaded ? loadedSpots : donkeySpots).push({ x, z, height: tpl.height * (0.92 + rnd() * 0.12) });
      placed++;
    }
  }
  // ── THE FLOCKS' DAY: a loop round the village — the pasture, other grazing
  // ground, down to the well to drink (at its troughs), back. The home walks
  // at a flock's pace and stops a minute or two at each place; the animals
  // catch up in bursts and graze as they go (wildHerd.js "loose").
  // Each well as a ring of places to drink, 9 m round it (clear of its
  // footprint, the troughs within reach): the flock takes whichever it can
  // walk to — a single spot in front was walled off from every pasture by a
  // house, a garden or the SAS post (measured: no flock reached a well).
  const wells = Object.entries(showroom ?? {}).filter(([k, o]) => k.startsWith("well") && o?.isObject3D).map(([, o]) =>
    Array.from({ length: 8 }, (_, k) => ({ x: o.position.x + Math.sin((k * Math.PI) / 4) * 9, z: o.position.z + Math.cos((k * Math.PI) / 4) * 9, well: true, at: o.position })));
  const legal = (a, b, stand = sheepStand) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 3));
    for (let k = 1; k <= n; k++) if (stand(a.x + ((b.x - a.x) * k) / n, a.z + ((b.z - a.z) * k) / n) == null) return false;
    return true;
  };
  for (const f of flocks) {
    const s = f.site, route = [{ x: f.anchor.x, z: f.anchor.z }];
    const ring = wells.find((w) => Math.hypot(w[0].at.x - s.x, w[0].at.z - s.z) < 90) ?? [];
    // The home walks between these on a FOOT PATH (the nav grid's, round the
    // houses and gardens — see step()), so a place need only be reachable:
    // straight lines put a mechta between every pasture and its well.
    // A leg is good only if a SHEEP can stand on every 2 m of the foot path:
    // the nav grid lets a man pass near the post, on steeper ground and at
    // the oasis's edge where the flock may not go, and a home that walked
    // there left its whole flock behind (measured: 18 animals 100 m back).
    const way = (a, b) => {
      const path = app.navGrid?.findPath?.(a.x, a.z, b.x, b.z, { foot: true });
      const pts = path?.length ? [a, ...path.slice(0, -1).map((p) => ({ x: p.x, z: p.z })), b] : [a, b];
      for (let i = 1; i < pts.length; i++) if (!legal(pts[i - 1], pts[i])) return null;
      return pts.slice(1);
    };
    for (let k = 0; k < 80 && route.length < 3; k++) {
      const a = rnd() * Math.PI * 2, d = s.r + 20 + rnd() * 45;
      const q = { x: s.x + Math.sin(a) * d, z: s.z + Math.cos(a) * d };
      if (sheepStand(q.x, q.z) == null || route.some((r) => Math.hypot(r.x - q.x, r.z - q.z) < 30)) continue;
      if (!way(route[route.length - 1], q) || !way(q, route[0])) continue;
      route.push(q);
    }
    // The well, mid-loop: the first place round it the flock can reach and leave.
    const at = Math.min(2, route.length);
    const well = ring.find((w) => sheepStand(w.x, w.z) != null && way(route[at - 1], w) && way(w, route[at % route.length]));
    if (well) route.splice(at, 0, well);
    // Each leg's way, found once (route[i] → route[i + 1], round the loop).
    f.ways = route.map((r, i) => way(r, route[(i + 1) % route.length]) ?? [route[(i + 1) % route.length]]);
    f.route = route;
    f.leg = 0;
    f.wait = 20 + rnd() * 60;
  }
  const FLOCK_PACE = 0.45;   // m/s: a flock grazing its way along

  // ── DONKEY TRAINS on the mule paths (algTracks.js): a loaded donkey on the
  // lead, a bare one behind, from the village up to the gully mouth and back,
  // a rest at each end. Working animals: they do not bolt.
  const trailStand = (x, z) => {
    const y = app.getWorldHeight(x, z);
    if ((app.getWaterLevelAt?.(x, z) ?? -Infinity) > y - 0.3) return null;
    return app.getWorldNormal(x, z).y < 0.72 ? null : y;
  };
  const trains = [];
  const trainLoaded = [], trainBare = [];
  for (const name of ["Sentier du ravin ouest", "Sentier du ravin est"]) {
    const t = TRACK_LINES.find((q) => q.name === name);
    if (!t) continue;
    const arc = [0];
    for (let i = 1; i < t.line.length; i++) arc.push(arc[i - 1] + Math.hypot(t.line[i].x - t.line[i - 1].x, t.line[i].z - t.line[i - 1].z));
    const tr = { line: t.line, arc, total: arc[arc.length - 1], s: rnd() * arc[arc.length - 1], dir: rnd() < 0.5 ? 1 : -1, wait: 0, anchor: { x: 0, z: 0, yaw: 0, moving: true } };
    placeTrain(tr, 0);
    trains.push(tr);
    const at = (off) => { const c = Math.cos(tr.anchor.yaw), s = Math.sin(tr.anchor.yaw); return { x: tr.anchor.x + off.x * c + off.z * s, z: tr.anchor.z - off.x * s + off.z * c }; };
    trainLoaded.push({ ...at({ x: 0, z: 0 }), anchor: tr.anchor, off: { x: 0, z: 0 }, follow: "tight", height: loadedTpl.height * (0.95 + rnd() * 0.08) });
    trainBare.push({ ...at({ x: 0.3, z: -3.4 }), anchor: tr.anchor, off: { x: 0.3, z: -3.4 }, follow: "tight", height: donkeyTpl.height * (0.92 + rnd() * 0.1) });
  }
  const TRAIN_PACE = Math.min(loadedTpl.walkSpeed ?? 1, donkeyTpl.walkSpeed ?? 1) * 0.8;
  /** A train's anchor at arc position s, facing its way of travel. */
  function placeTrain(tr, dt) {
    tr.s = Math.max(0, Math.min(tr.total, tr.s));
    let i = 1;
    while (i < tr.arc.length - 1 && tr.arc[i] < tr.s) i++;
    const f = (tr.s - tr.arc[i - 1]) / Math.max(1e-6, tr.arc[i] - tr.arc[i - 1]);
    const a = tr.line[i - 1], b = tr.line[i];
    tr.anchor.x = a.x + (b.x - a.x) * f;
    tr.anchor.z = a.z + (b.z - a.z) * f;
    const want = Math.atan2((b.x - a.x) * tr.dir, (b.z - a.z) * tr.dir);
    const d = Math.atan2(Math.sin(want - tr.anchor.yaw), Math.cos(want - tr.anchor.yaw));
    tr.anchor.yaw = dt ? tr.anchor.yaw + Math.max(-dt, Math.min(dt, d)) : want;   // turns at ~1 rad/s, not snapping at every bend
  }

  const threats = () => (units?.list ?? []).filter((u) => u.alive && !u.isAir && !u.isStructure).map((u) => u.position);
  const herds = [
    // roam 7: bunched round their places in the flock (a lone sheep 20 m out
    // read as strays, not a flock).
    createWildHerd(app, sheepTpl, sheepSpots, { canStand: sheepStand, threats, name: "Sheep", walkSpeed: sheepTpl.walkSpeed, runSpeed: sheepTpl.runSpeed, roam: 7 }),
    createWildHerd(app, goatTpl, goatSpots, { canStand: goatStand, threats, name: "Goats", walkSpeed: goatTpl.walkSpeed, runSpeed: goatTpl.runSpeed, roam: 7 }),
    // the trains: on the lead, on the mule paths' steeper ground
    createWildHerd(app, loadedTpl, trainLoaded, { canStand: trailStand, name: "Donkeys (train, loaded)", walkSpeed: loadedTpl.walkSpeed, runSpeed: loadedTpl.runSpeed, bolt: false, roam: 1.5 }),
    createWildHerd(app, donkeyTpl, trainBare, { canStand: trailStand, name: "Donkeys (train)", walkSpeed: donkeyTpl.walkSpeed, runSpeed: donkeyTpl.runSpeed, bolt: false, roam: 1.5 }),
    // working animals: tied up (a few metres of rope), never bolting
    createWildHerd(app, donkeyTpl, donkeySpots, { canStand: sheepStand, name: "Donkeys", walkSpeed: donkeyTpl.walkSpeed, runSpeed: donkeyTpl.runSpeed, bolt: false, roam: 3 }),
    createWildHerd(app, loadedTpl, loadedSpots, { canStand: sheepStand, name: "Donkeys (loaded)", walkSpeed: loadedTpl.walkSpeed, runSpeed: loadedTpl.runSpeed, bolt: false, roam: 3 }),
  ].filter(Boolean);
  /** Move the homes (flocks, trains), then the animals. */
  function step(dt) {
    dt = Math.min(dt, 0.1);
    for (const f of flocks) {
      const A = f.anchor;
      if (!A.moving) {
        f.wait -= dt;
        if (f.wait > 0 || f.route.length < 2) continue;
        // The way to the next place (found when the route was built).
        f.path = [...f.ways[f.leg]];
        f.leg = (f.leg + 1) % f.route.length;
        A.moving = true;
      }
      let g = f.path[0], dx = g.x - A.x, dz = g.z - A.z, d = Math.hypot(dx, dz);
      if (d < 1.5 && f.path.length > 1) {
        f.path.shift();
        g = f.path[0]; dx = g.x - A.x; dz = g.z - A.z; d = Math.hypot(dx, dz);
      }
      if (d < 1 && f.path.length === 1) {
        A.moving = false;
        f.wait = g.well ? 25 + rnd() * 15 : 60 + rnd() * 60;   // a drink; a graze
        continue;
      }
      const st = Math.min(d, FLOCK_PACE * dt);
      A.x += (dx / d) * st; A.z += (dz / d) * st;
      // Breadcrumbs every 3 m, the last 200 m: stragglers follow the home's
      // own way round the houses (wildHerd.js).
      A.trail ??= [];
      const last = A.trail[A.trail.length - 1];
      if (!last || Math.hypot(A.x - last.x, A.z - last.z) > 3) { A.trail.push({ x: A.x, z: A.z }); if (A.trail.length > 67) A.trail.shift(); }
      const want = Math.atan2(dx, dz), turn = Math.atan2(Math.sin(want - A.yaw), Math.cos(want - A.yaw));
      A.yaw += Math.max(-0.5 * dt, Math.min(0.5 * dt, turn));
    }
    for (const tr of trains) {
      if (tr.wait > 0) {
        tr.wait -= dt;
        tr.anchor.moving = tr.wait <= 0;
        continue;
      }
      tr.s += tr.dir * TRAIN_PACE * dt;
      if (tr.s <= 0 || tr.s >= tr.total) {
        // The end of the path: unload / load, then back.
        tr.dir = -tr.dir;
        tr.wait = 20 + rnd() * 15;
        tr.anchor.moving = false;
      }
      placeTrain(tr, dt);
    }
    for (const h of herds) h.update(dt);
  }
  app.addPreRenderHook(step);
  console.log(`[herds] ${sheepSpots.length} sheep + ${goatSpots.length} goats on ${pastures.length} pastures (${pastures.map((p) => p.site).join(", ")}), ${donkeySpots.length + loadedSpots.length} donkeys (${loadedSpots.length} loaded), ${trains.length} donkey trains, ${flocks.filter((f) => f.route.length > 1).length}/${flocks.length} flocks on the move (routes of ${flocks.map((f) => f.route.length).join("/")}, ${flocks.filter((f) => f.route.some((r) => r.well)).length} by a well) in ${Math.round(performance.now() - t0)} ms`,
    { sheep: sheepTpl.health, goat: goatTpl.health, donkey: donkeyTpl.health, loaded: loadedTpl.health });
  return { herds, pastures, flocks, trains, step, sheep: sheepSpots.length, goats: goatSpots.length, donkeys: donkeySpots.length, loaded: loadedSpots.length };
}
