// THE TRACK LIBRARY: every track the player has (built ones now; campaign ones are read-only files
// later). One record per track, kept in the browser (localStorage) for now:
//   { id, name, created, updated, track: { pieces, nextUid, authorTime }, thumb, best: { time, medal } }
// The builder edits `track`; the drive page reads it and writes `best`. Ghosts and per-run bests are
// keyed by the track's CONTENT (drive.js trackKey), so editing a track starts its records over.
const KEY = "thunderline.library.v1";
const OLD_SINGLE = "thunderline.track.v1"; // the builder's one-slot save before the library
const CURRENT = "thunderline.library.current"; // the track the builder last worked on
/** A new track's world (worlds.js; user, 2026-10-20: the mountain valley by default). */
const NEW_TRACK_WORLD = "valley";

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}
function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); return true; } catch (e) { console.warn("[library] not saved", e); return false; }
}
/**
 * A track's identity for records: its pieces, links and flags (DESIGN.md §8 keys records by content,
 * never by name). Edit the track and its best times and ghost start over.
 */
export function contentKey(track) {
  // (a one-sided rail / a piece laid beside: appended only when present, so older tracks keep their key — their bests)
  const src = JSON.stringify((track?.pieces ?? []).map((p) => [p.id, !!p.open, p.M.map((x) => +x.toFixed(3)), p.parent, p.flightFrom, !!p.cp, ...(p.rail || p.sideOf != null ? [p.rail ?? null, p.sideOf ?? null] : [])]));
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
/** a record's best time, only if it was set on the track as it is now */
export const currentBest = (rec) => (rec?.best && rec.best.key === contentKey(rec.track) ? rec.best : null);
const newId = () => `t${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, "0")}`;

/** The one-slot track from before the library becomes the first library track (once). */
function migrate(all) {
  if (Object.keys(all).length) return all;
  let old = null;
  try { old = JSON.parse(localStorage.getItem(OLD_SINGLE)); } catch {}
  if (old?.pieces?.length) {
    const id = newId();
    all[id] = { id, name: "My first track", created: Date.now(), updated: Date.now(), track: old, thumb: null, best: null };
    writeAll(all);
  }
  return all;
}

/**
 * ONE-TIME CLEAN-UP (user, 2026-10-20: "delete the ones we don't need"): the working copies left from
 * building the campaign (it plays from its own files: campaign/*.json) and the builder's test tracks.
 * Exactly these names, once (a flag says it ran), never anything else.
 */
const CLEANUP_FLAG = "thunderline.library.cleanup.2026-10-20";
const CLEANUP_NAMES = [/^White [1-5] · /, /^W[1-5]b? · /, /^Gap test$/, /^Small pieces test( 2)?$/, /^Track 2$/, /^Track 24$/];
function cleanupOnce(all) {
  try { if (localStorage.getItem(CLEANUP_FLAG)) return false; localStorage.setItem(CLEANUP_FLAG, "1"); } catch { return false; }
  let removed = false;
  for (const [id, r] of Object.entries(all)) if (CLEANUP_NAMES.some((re) => re.test(r.name ?? ""))) { delete all[id]; removed = true; }
  return removed;
}

/*
 * SAVED ONLY WHEN YOU SAVE (user, 2026-10-29: "shouldn't it save a track only if I press a save button? that would
 * make me keep only the ones I choose"). The list holds the tracks you SAVED. What you are editing and haven't saved
 * — a new track, or changes to a saved one — lives in ONE draft slot, overwritten as you edit (never piling up), so a
 * crash or a closed tab loses nothing: the builder brings it back. The draft reads like a record under the id
 * DRAFT (get / saveTrack / recordFinish), with `base` = the saved track it changes, or null for a new one.
 */
export const DRAFT = "draft";
const DRAFT_KEY = "thunderline.library.draft";
const readDraft = () => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; } };
const writeDraft = (d) => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); return true; } catch (e) { console.warn("[library] draft not kept", e); return false; } };
const draftRecord = (d) => (d ? { id: DRAFT, name: d.name, created: d.updated, updated: d.updated, track: d.track, thumb: null, best: null, base: d.base ?? null } : null);
export const draft = {
  /** the draft as a record, or null */
  get() { return draftRecord(readDraft()); },
  /** a NEW track to build (nothing in the list until it is saved) */
  start(name = "New track") {
    return writeDraft({ base: null, name, updated: Date.now(), track: { pieces: [], nextUid: 1, world: NEW_TRACK_WORLD } }) && draft.get();
  },
  /** the builder's safety copy of what you are editing: `base` the saved track it changes (null: a new one) */
  keep(base, name, track) { return writeDraft({ base, name, updated: Date.now(), track }); },
  clear() { try { localStorage.removeItem(DRAFT_KEY); } catch {} },
};

/** THE PHYSICS LAB's own track (PHYSICS_LAB.md): a record under a fixed id, marked `lab`, never in the list. */
export const LAB_ID = "physics-lab";
// (a NEW LAYOUT of the lab — zones added in physicsLab.js — replaces the stored one by itself, unless you Saved
// changes to it: then only "Reset lab" does)
export function ensureLabTrack(make, { reset = false } = {}) {
  const all = migrate(readAll());
  const track = make(), gen = JSON.stringify(track), rec = all[LAB_ID];
  if (!rec || reset || (rec.gen !== gen && !rec.edited)) {
    all[LAB_ID] = { id: LAB_ID, name: "Physics lab", lab: true, gen, created: Date.now(), updated: Date.now(), track, thumb: null, best: null };
    writeAll(all);
  }
  return all[LAB_ID];
}

export const library = {
  /** all tracks, most recently edited first */
  list() {
    // EMPTY TRACKS DON'T STAY: "New track" makes a record at once, so every unused one left an "Empty"
    // card behind. An empty track goes, except the one the builder is working on.
    const all = migrate(readAll());
    const cur = localStorage.getItem(CURRENT);
    let pruned = cleanupOnce(all);
    for (const [id, r] of Object.entries(all)) if (!r.track?.pieces?.length && id !== cur && !r.lab) { delete all[id]; pruned = true; }
    if (pruned) writeAll(all);
    // (the PHYSICS LAB's track is a record too, but not one of "your tracks": never listed)
    return Object.values(all).filter((r) => !r.lab).sort((a, b) => b.updated - a.updated);
  },
  get(id) { return id === DRAFT ? draft.get() : migrate(readAll())[id] ?? null; },
  create(name) {
    const all = migrate(readAll());
    const n = Object.keys(all).length + 1;
    const id = newId();
    all[id] = { id, name: name ?? `Track ${n}`, created: Date.now(), updated: Date.now(), track: { pieces: [], nextUid: 1, world: NEW_TRACK_WORLD }, thumb: null, best: null };
    writeAll(all);
    return all[id];
  },
  /** the builder saves its track (and, now and then, a thumbnail) */
  saveTrack(id, track, thumb) {
    if (id === DRAFT) { const d = readDraft(); return !!d && writeDraft({ ...d, updated: Date.now(), track }); }
    const all = readAll();
    const rec = all[id];
    if (!rec) return false;
    rec.track = track;
    rec.updated = Date.now();
    if (thumb !== undefined) rec.thumb = thumb;
    else if (rec.lab) rec.edited = true; // (your Save: the lab's layout is now yours — see ensureLabTrack)
    return writeAll(all);
  },
  rename(id, name) {
    const all = readAll();
    if (!all[id]) return;
    all[id].name = name.trim() || all[id].name;
    all[id].updated = Date.now();
    writeAll(all);
  },
  duplicate(id) {
    const all = readAll();
    const src = all[id];
    if (!src) return null;
    const nid = newId();
    all[nid] = { ...JSON.parse(JSON.stringify(src)), id: nid, name: `${src.name} copy`, created: Date.now(), updated: Date.now(), best: null };
    writeAll(all);
    return all[nid];
  },
  remove(id) {
    const all = readAll();
    delete all[id];
    writeAll(all);
    if (localStorage.getItem(CURRENT) === id) localStorage.removeItem(CURRENT);
  },
  /** the drive page records a finished run: keeps the best time and its medal, for THIS content */
  recordFinish(id, time, medal) {
    const all = readAll();
    const rec = all[id];
    if (!rec) return null;
    const key = contentKey(rec.track);
    if (!rec.best || rec.best.key !== key || time < rec.best.time) rec.best = { time, medal, key };
    writeAll(all);
    return rec.best;
  },
  get current() { return localStorage.getItem(CURRENT); },
  set current(id) { if (id) localStorage.setItem(CURRENT, id); },
};

/**
 * THE CAMPAIGN (DESIGN.md §8): read-only track files in the repo, campaign/<tier>.json
 * ({ tier, name, tracks: [{ id, name, tier, track, thumb }] }), built and validated in the builder like
 * any player track. A tier with no file yet shows "coming soon". Bests are kept per track id and, like
 * the library's, only count for the content they were set on.
 */
export const CAMPAIGN_TIERS = ["white", "green", "blue", "red", "black"];
const campaignFiles = new Map();
async function campaignTier(tier) {
  if (!campaignFiles.has(tier)) {
    campaignFiles.set(tier, fetch(`/games/thunderline/campaign/${tier}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return campaignFiles.get(tier);
}
const CAMPAIGN_BEST = "thunderline.campaign.v1";
/**
 * THE STUNT LESSONS (user, 2026-10-22): campaign/lessons.json, the same record shape as a tier plus a
 * `lesson` ({ how: the card's text, goal: { perfect: n } — perfect landings needed — and the finish }).
 * Passed lessons are remembered per id.
 */
const LESSONS_PASSED = "thunderline.lessons.v1";
const readPassed = () => { try { return JSON.parse(localStorage.getItem(LESSONS_PASSED)) ?? {}; } catch { return {}; } };
export const lessons = {
  async list() { return (await campaignTier("lessons"))?.tracks ?? []; },
  passed(id) { return !!readPassed()[id]; },
  markPassed(id) { const all = readPassed(); all[id] = true; try { localStorage.setItem(LESSONS_PASSED, JSON.stringify(all)); } catch {} },
};
const readCampaignBests = () => { try { return JSON.parse(localStorage.getItem(CAMPAIGN_BEST)) ?? {}; } catch { return {}; } };
export const campaign = {
  /** every tier: { tier, tracks } (tracks [] when the tier has no file yet) */
  async tiers() {
    return Promise.all(CAMPAIGN_TIERS.map(async (tier) => ({ tier, tracks: (await campaignTier(tier))?.tracks ?? [] })));
  },
  async get(id) {
    const tier = [...CAMPAIGN_TIERS, "lessons"].find((t) => id?.startsWith(`${t}-`));
    return tier ? (await campaignTier(tier))?.tracks.find((t) => t.id === id) ?? null : null;
  },
  /** the best run on this campaign track as it is now, or null */
  best(rec) {
    const b = readCampaignBests()[rec.id];
    return b && b.key === contentKey(rec.track) ? b : null;
  },
  recordFinish(rec, time, medal) {
    const all = readCampaignBests();
    const key = contentKey(rec.track), b = all[rec.id];
    if (!b || b.key !== key || time < b.time) all[rec.id] = { time, medal, key };
    try { localStorage.setItem(CAMPAIGN_BEST, JSON.stringify(all)); } catch {}
    return all[rec.id];
  },
};

/** Settings shared by every page (menu → Settings). */
const SETTINGS_KEY = "thunderline.settings.v1";
// sound OFF by default (user, 2026-10-19: it disturbs work on the game) — Settings or M turns it on
// engine "gen6": the recorded-style loops the user picked (2026-10-20, engineLoops.js) over the synth
// car "thunder": the NEW CAR is the default (user, 2026-10-28: "lets use the not lotus car as default"; it was
// the Lotus from 2026-10-21) — the Lotus (dev only, trademark) stays in Settings
// physics "old" | "stunt" | "arcade": the old game's car, the STUNT car built on it (proto/kit/stuntCar.js), or the
// ARCADE car, a new driving model (arcadeCar.js) — PHYSICS_PLAN.md
// — side by side to compare (user, 2026-10-28); the old one stays the default until it is judged
export const SETTINGS_DEFAULTS = { ghost: true, hud: true, sound: false, volume: 0.7, engine: "gen6", car: "thunder", physics: "old" };
export const settings = {
  get() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
      // once: settings saved before the loops kept the synth's "v8" default — move them to gen6
      if (!saved.engineV) { saved.engine = SETTINGS_DEFAULTS.engine; saved.engineV = 2; }
      // once: settings saved while the Lotus was the default carry "lotus" — over to the new car (carV 3)
      if (!(saved.carV >= 3)) { saved.car = SETTINGS_DEFAULTS.car; saved.carV = 3; }
      return { ...SETTINGS_DEFAULTS, ...saved };
    } catch { return { ...SETTINGS_DEFAULTS }; }
  },
  set(patch) {
    const s = { ...settings.get(), ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
    return s;
  },
};

/** Where the pages live (one place to change when the prototypes move into app/). */
export const PAGES = {
  menu: "/games/thunderline/index.html",
  builder: "/games/thunderline/proto/builder3.html",
  drive: "/games/thunderline/proto/kit/drive.html",
};
export const builderUrl = (id) => `${PAGES.builder}?track=${encodeURIComponent(id)}`;
export const driveUrl = (id, from) => `${PAGES.drive}?track=${encodeURIComponent(id)}${from ? `&from=${from}` : ""}`;
export const campaignUrl = (id) => `${PAGES.drive}?campaign=${encodeURIComponent(id)}`;
