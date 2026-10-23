// THE MENU (DESIGN.md: the four modes). One page, screens by hash so the other pages can send the
// player back to the right one: #home, #play (Stunt tracks: campaign + my tracks), #build (the
// library: new, open, drive, rename, duplicate, delete), #settings.
import { library, campaign, lessons, settings, currentBest, builderUrl, driveUrl, campaignUrl } from "./library.js";
import { decodeTrack } from "./trackCode.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (t) => {
  if (t == null) return "—";
  const m = Math.floor(t / 60), s = (t % 60).toFixed(2);
  return m ? `${m}:${s.padStart(5, "0")}` : s;
};
const MEDAL = { author: "Author", gold: "Gold", silver: "Silver", bronze: "Bronze" };
const TIERS = [["White", "var(--white)"], ["Green", "var(--green)"], ["Blue", "var(--blue)"], ["Red", "var(--red)"], ["Black", "var(--black)"]];

// (the tab you were on: a lesson sends you back to the lessons)
let playTab = (() => { try { return sessionStorage.getItem("thunderline.playTab") ?? "campaign"; } catch { return "campaign"; } })();

function crumbs(list) {
  document.body.classList.toggle("at-home", list.length === 0); // the logo big on the home screen
  $("crumbs").innerHTML = list.map(([label, href]) => (href ? `<a href="${href}">${label}</a>` : `<span>${label}</span>`)).join(`<span class="sep">/</span>`);
}
function foot(html) { $("foot").innerHTML = html; }

// ---------- home ----------
function home() {
  crumbs([]);
  $("screen").innerHTML = `
    <div class="modes">
      <a class="mode main cut" href="#play"><div class="art"></div>
        <span class="tag">Main mode</span>
        <h2>Stunt<br>tracks</h2>
        <p>Air parkour. Jumps, drops, bowls and flips — land flat for a boost, chase the author time.</p>
        <span class="go">Play ▶</span></a>
      <a class="mode cut" href="#build"><span class="tag">Track builder</span>
        <h2>Build</h2><p>Make your own stunt tracks and race them.</p><span class="go">Open ▶</span></a>
      <div class="mode later cut" style="display:grid;grid-template-columns:1fr 1fr;gap:0;padding:0">
        <div style="padding:22px 26px;display:flex;flex-direction:column;justify-content:flex-end;border-right:1px solid var(--line)">
          <span class="tag" style="top:18px">Later</span><h2 style="font-size:34px">City</h2><p>Stunts inside a city.</p></div>
        <div style="padding:22px 26px;display:flex;flex-direction:column;justify-content:flex-end;position:relative">
          <span class="tag" style="top:18px">Later</span><h2 style="font-size:34px">Drift</h2><p>Small maps, a drift car.</p></div>
      </div>
    </div>
    <div class="home-row">
      <div class="mode later cut"><span class="tag" style="top:12px">Later</span><h2>Garage</h2></div>
      <a class="mode cut" href="#settings"><h2>Settings</h2></a>
    </div>`;
  foot(`<span>${library.list().length} track${library.list().length === 1 ? "" : "s"} in your library</span>`);
}

// ---------- a track card ----------
function trackCard(rec, { actions, best = currentBest(rec), badge: tag }) {
  const author = rec.track?.authorTime;
  const pieces = rec.track?.pieces?.length ?? 0;
  const pic = rec.thumb ? `<div class="pic" style="background-image:url(${rec.thumb})">` : `<div class="pic none">${pieces ? "no picture yet" : "empty"}`;
  const badge = tag ? `<span class="badge ok">${tag}</span>` : author ? `<span class="badge ok">Validated</span>` : `<span class="badge">${pieces ? "Not validated" : "Empty"}</span>`;
  return `<div class="card cut" data-id="${rec.id}">
    ${pic}${badge}</div>
    <div class="body">
      <div class="name">${esc(rec.name)}</div>
      ${rec.track?.description ? `<div class="desc">${esc(rec.track.description)}</div>` : ""}
      <div class="meta">
        <span>Author <b>${fmt(author)}</b></span>
        <span>${best ? `<i class="medal ${best.medal ?? ""}"></i>Best <b>${fmt(best.time)}</b>` : "No run yet"}</span>
        <span>${pieces} pieces</span>
      </div>
      ${actions ? `<div class="acts">${actions}</div>` : ""}
    </div></div>`;
}

// ---------- Stunt tracks: campaign + my tracks ----------
let tiers = null; // campaign files, loaded once (campaign/<tier>.json)
let lessonList = null; // the stunt lessons (campaign/lessons.json), loaded once
function play() {
  crumbs([["Stunt tracks", null]]);
  if (playTab === "campaign" && !tiers) { campaign.tiers().then((t) => { tiers = t; if ((location.hash || "#home") === "#play") play(); }); }
  if (playTab === "lessons" && !lessonList) { lessons.list().then((l) => { lessonList = l; if ((location.hash || "#home") === "#play") play(); }); }
  const mine = library.list().filter((r) => r.track?.authorTime);
  const tierBlock = ([name, col], i) => {
    const tracks = tiers?.[i]?.tracks ?? [];
    const medals = tracks.filter((t) => campaign.best(t)?.medal).length;
    return `<div class="tier"><h3><i style="background:${col}"></i>${name}${tracks.length ? ` <span style="color:var(--dim);font-size:14px">${medals}/${tracks.length} medals</span>` : ""}</h3><div class="grid">${
      Array.from({ length: 5 }, (_, k) => tracks[k]
        ? trackCard(tracks[k], { actions: null, best: campaign.best(tracks[k]), badge: `${name} ${k + 1}` })
        : `<div class="card slot cut"><div class="pic none">${name} ${k + 1}</div><div class="body"><div class="name">Coming soon</div><div class="meta"><span>—</span></div></div></div>`).join("")
    }</div></div>`;
  };
  const body = playTab === "lessons"
    ? `<p class="note">Stunt lessons: one trick each, a short track. Read the card, drive it, pass the goal — then the campaign.</p>` +
      (lessonList ? `<div class="grid">${lessonList.map((r, k) => trackCard(r, { actions: null, best: campaign.best(r), badge: lessons.passed(r.id) ? "Passed ✓" : `Lesson ${k + 1}` })).join("")}</div>` : `<p class="note">Loading…</p>`)
    : playTab === "campaign"
    ? `<p class="note">The campaign: five tiers of five tracks, White to Black. Beat the author time for the author medal; gold ×1.06, silver ×1.2, bronze ×1.5.</p>` +
      (tiers ? TIERS.map(tierBlock).join("") : `<p class="note">Loading…</p>`)
    : (mine.length
      ? `<p class="note">Your validated tracks (driven to the finish in the builder). Medals: author, gold ×1.06, silver ×1.2, bronze ×1.5.</p><div class="grid">${mine.map((r) => trackCard(r, { actions: null })).join("")}</div>`
      : `<p class="note">No validated track yet. Build one, and let the builder's test lap finish: its time becomes the author time.</p><div class="grid"><a class="card new cut" href="#build">Build a track ▶</a></div>`);
  $("screen").innerHTML = `<div class="tabs"><button data-tab="lessons" class="${playTab === "lessons" ? "on" : ""}">Lessons</button><button data-tab="campaign" class="${playTab === "campaign" ? "on" : ""}">Campaign</button><button data-tab="mine" class="${playTab === "mine" ? "on" : ""}">My tracks <span style="color:var(--dim);font-size:14px">${mine.length}</span></button></div>${body}`;
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => { playTab = b.dataset.tab; try { sessionStorage.setItem("thunderline.playTab", playTab); } catch {} play(); };
  for (const c of document.querySelectorAll(".card[data-id]")) c.onclick = () => { location.href = playTab === "mine" ? driveUrl(c.dataset.id) : campaignUrl(c.dataset.id); };
  foot(`<span><kbd>Esc</kbd> back</span>`);
}

// ---------- Build: the library ----------
function build() {
  crumbs([["Build", null]]);
  const all = library.list();
  const cards = all.map((r) => trackCard(r, {
    actions: `<button data-act="open">Edit</button><button data-act="drive"${r.track?.pieces?.length ? "" : " disabled"}>Drive</button><button data-act="rename">Rename</button><button data-act="dup">Copy</button><button data-act="del" class="danger">Delete</button>`,
  })).join("");
  $("screen").innerHTML = `<p class="note">Your tracks. Edit one, or start a new one. A track is validated when the builder's test lap reaches the finish: that time is its author time and sets the medals.</p>
    <div class="grid"><div class="card new tut cut" id="tut">Builder tutorial ▶<small>10 short steps, on a new track</small></div><div class="card new cut" id="new">+ New track</div><div class="card new paste cut" id="paste">Paste a code<small>a track someone shared</small></div>${cards}</div>`;
  $("new").onclick = () => { location.href = builderUrl(library.create().id); };
  // THE BUILDER TUTORIAL (user, 2026-10-22: "shouldn't it be in the track builder menu?"): a new track,
  // the builder opens with the tutorial running (builderTutorial.js; also the builder's Tutorial button)
  $("tut").onclick = () => { location.href = `${builderUrl(library.create("Tutorial track").id)}&tutorial=1`; };
  // SHARE CODES (trackCode.js): a pasted code becomes one of your tracks
  $("paste").onclick = async () => {
    const code = prompt("Paste a Thunderline track code (it starts with TL1.)");
    if (!code) return;
    try {
      const { name, track } = await decodeTrack(code);
      const rec = library.create(name);
      library.saveTrack(rec.id, track);
      build();
    } catch (e) { alert(e.message); }
  };
  for (const c of document.querySelectorAll(".card[data-id]")) {
    const id = c.dataset.id;
    c.onclick = (e) => {
      const act = e.target.closest("button")?.dataset.act ?? "open";
      e.stopPropagation();
      if (act === "open") location.href = builderUrl(id);
      else if (act === "drive") location.href = driveUrl(id, "builder");
      else if (act === "rename") { const n = prompt("Track name", library.get(id).name); if (n) { library.rename(id, n); build(); } }
      else if (act === "dup") { library.duplicate(id); build(); }
      else if (act === "del") { if (confirm(`Delete "${library.get(id).name}"? This cannot be undone.`)) { library.remove(id); build(); } }
    };
  }
  foot(`<span><kbd>Esc</kbd> back</span><span>Tracks are kept in this browser for now</span>`);
}

// ---------- Settings ----------
function settingsScreen() {
  crumbs([["Settings", null]]);
  const s = settings.get();
  const row = (key, title, desc) => `<div class="set cut"><div><div class="t">${title}</div><div class="d">${desc}</div></div><div class="toggle ${s[key] ? "on" : ""}" data-key="${key}"></div></div>`;
  $("screen").innerHTML = `<div class="settings">
    ${row("ghost", "Ghost", "Race your best run on every track (G toggles it while driving).")}
    <div class="set cut"><div><div class="t">Volume</div><div class="d">The engine's loudness. Every drive starts silent: <b>M</b> or the speaker button turns the sound on.</div></div><input type="range" id="s-vol" min="0" max="100" value="${Math.round(s.volume * 100)}" style="width:220px;accent-color:#3fd2ff" /></div>
    <div class="set cut"><div><div class="t">Car</div><div class="d">The new Thunderline car, or the Lotus (the dev car). <a href="./proto/carview.html" style="color:var(--bolt)">See them side by side ▶</a></div></div>
      <div style="display:flex;gap:4px">${[["thunder", "New car"], ["lotus", "Lotus"]].map(([k, n]) => `<button class="carb" data-c="${k}" style="background:var(--panel2);border:1px solid ${s.car === k ? "var(--bolt)" : "var(--line)"};color:${s.car === k ? "var(--bolt)" : "var(--dim)"};padding:6px 12px;cursor:pointer;font:700 14px 'Barlow Condensed';text-transform:uppercase">${n}</button>`).join("")}</div></div>
    <div class="set cut"><div><div class="t">Engine</div><div class="d">Which engine you hear. <a href="./proto/engine-lab.html" style="color:var(--bolt)">Listen in the engine lab ▶</a></div></div>
      <div style="display:flex;gap:4px">${[["gen6", "Four (loops)"], ["v8", "Synth V8"], ["i6", "Synth I6"], ["v10", "Synth V10"]].map(([k, n]) => `<button class="eng" data-e="${k}" style="background:var(--panel2);border:1px solid ${s.engine === k ? "var(--bolt)" : "var(--line)"};color:${s.engine === k ? "var(--bolt)" : "var(--dim)"};padding:6px 12px;cursor:pointer;font:700 14px 'Barlow Condensed';text-transform:uppercase">${n}</button>`).join("")}</div></div>
    <div class="keys">
      <span><kbd>W</kbd><kbd>S</kbd> / <kbd>↑</kbd><kbd>↓</kbd></span><span>throttle / brake</span>
      <span><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd></span><span>steer</span>
      <span><kbd>Shift</kbd> <kbd>C</kbd></span><span>pitch in the air (nose up / down)</span>
      <span><kbd>Q</kbd> <kbd>E</kbd></span><span>spin in the air</span>
      <span><kbd>Z</kbd> <kbd>X</kbd></span><span>roll in the air</span>
      <span><kbd>Space</kbd></span><span>handbrake</span>
      <span><kbd>Backspace</kbd></span><span>last checkpoint, keeping your speed (twice: standing)</span>
      <span><kbd>R</kbd> <kbd>Delete</kbd></span><span>restart</span>
      <span><kbd>M</kbd></span><span>sound on / off</span>
      <span><kbd>F</kbd></span><span>free camera: drag to orbit the car, wheel to zoom, <kbd>T</kbd> slow motion / pause</span>
      <span><kbd>Esc</kbd></span><span>back</span>
    </div></div>`;
  for (const t of document.querySelectorAll(".toggle")) t.onclick = () => { settings.set({ [t.dataset.key]: !settings.get()[t.dataset.key] }); settingsScreen(); };
  $("s-vol").onchange = () => settings.set({ volume: $("s-vol").value / 100 });
  for (const b of document.querySelectorAll(".eng")) b.onclick = () => { settings.set({ engine: b.dataset.e }); settingsScreen(); };
  for (const b of document.querySelectorAll(".carb")) b.onclick = () => { settings.set({ car: b.dataset.c }); settingsScreen(); };
  foot(`<span><kbd>Esc</kbd> back</span>`);
}

// ---------- routing ----------
function route() {
  const h = location.hash.replace("#", "") || "home";
  ({ home, play, build, settings: settingsScreen }[h] ?? home)();
  window.scrollTo(0, 0);
}
addEventListener("hashchange", route);
addEventListener("keydown", (e) => { if (e.key === "Escape" && location.hash && location.hash !== "#home") location.hash = "#home"; });
route();
window.__menu = { library, route };
