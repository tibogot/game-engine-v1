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
  const src = JSON.stringify((track?.pieces ?? []).map((p) => [p.id, !!p.open, p.M.map((x) => +x.toFixed(3)), p.parent, p.flightFrom, !!p.cp]));
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

export const library = {
  /** all tracks, most recently edited first */
  list() {
    // EMPTY TRACKS DON'T STAY: "New track" makes a record at once, so every unused one left an "Empty"
    // card behind. An empty track goes, except the one the builder is working on.
    const all = migrate(readAll());
    const cur = localStorage.getItem(CURRENT);
    let pruned = cleanupOnce(all);
    for (const [id, r] of Object.entries(all)) if (!r.track?.pieces?.length && id !== cur) { delete all[id]; pruned = true; }
    if (pruned) writeAll(all);
    return Object.values(all).sort((a, b) => b.updated - a.updated);
  },
  get(id) { return migrate(readAll())[id] ?? null; },
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
    const all = readAll();
    const rec = all[id];
    if (!rec) return false;
    rec.track = track;
    rec.updated = Date.now();
    if (thumb !== undefined) rec.thumb = thumb;
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
const readCampaignBests = () => { try { return JSON.parse(localStorage.getItem(CAMPAIGN_BEST)) ?? {}; } catch { return {}; } };
export const campaign = {
  /** every tier: { tier, tracks } (tracks [] when the tier has no file yet) */
  async tiers() {
    return Promise.all(CAMPAIGN_TIERS.map(async (tier) => ({ tier, tracks: (await campaignTier(tier))?.tracks ?? [] })));
  },
  async get(id) {
    const tier = CAMPAIGN_TIERS.find((t) => id?.startsWith(`${t}-`));
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
export const SETTINGS_DEFAULTS = { ghost: true, hud: true, sound: false, volume: 0.7, engine: "v8", car: "thunder" };
export const settings = {
  get() {
    try { return { ...SETTINGS_DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {}) }; } catch { return { ...SETTINGS_DEFAULTS }; }
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
