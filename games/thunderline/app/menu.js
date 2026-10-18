// THE MENU (DESIGN.md: the four modes). One page, screens by hash so the other pages can send the
// player back to the right one: #home, #play (Stunt tracks: campaign + my tracks), #build (the
// library: new, open, drive, rename, duplicate, delete), #settings.
import { library, settings, currentBest, builderUrl, driveUrl } from "./library.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (t) => {
  if (t == null) return "—";
  const m = Math.floor(t / 60), s = (t % 60).toFixed(2);
  return m ? `${m}:${s.padStart(5, "0")}` : s;
};
const MEDAL = { author: "Author", gold: "Gold", silver: "Silver", bronze: "Bronze" };
const TIERS = [["White", "var(--white)"], ["Green", "var(--green)"], ["Blue", "var(--blue)"], ["Red", "var(--red)"], ["Black", "var(--black)"]];

let playTab = "campaign";

function crumbs(list) {
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
function trackCard(rec, { actions }) {
  const best = currentBest(rec);
  const author = rec.track?.authorTime;
  const pieces = rec.track?.pieces?.length ?? 0;
  const pic = rec.thumb ? `<div class="pic" style="background-image:url(${rec.thumb})">` : `<div class="pic none">${pieces ? "no picture yet" : "empty"}`;
  const badge = author ? `<span class="badge ok">Validated</span>` : `<span class="badge">${pieces ? "Not validated" : "Empty"}</span>`;
  return `<div class="card cut" data-id="${rec.id}">
    ${pic}${badge}</div>
    <div class="body">
      <div class="name">${esc(rec.name)}</div>
      <div class="meta">
        <span>Author <b>${fmt(author)}</b></span>
        <span>${best ? `<i class="medal ${best.medal ?? ""}"></i>Best <b>${fmt(best.time)}</b>` : "No run yet"}</span>
        <span>${pieces} pieces</span>
      </div>
      ${actions ? `<div class="acts">${actions}</div>` : ""}
    </div></div>`;
}

// ---------- Stunt tracks: campaign + my tracks ----------
function play() {
  crumbs([["Stunt tracks", null]]);
  const mine = library.list().filter((r) => r.track?.authorTime);
  const body = playTab === "campaign"
    ? `<p class="note">The campaign: five tiers of five tracks, White to Black. Its tracks are built in the builder and validated with an author time; the slots fill as they are made.</p>` +
      TIERS.map(([name, col]) => `<div class="tier"><h3><i style="background:${col}"></i>${name}</h3><div class="grid">${
        Array.from({ length: 5 }, (_, i) => `<div class="card slot cut"><div class="pic none">${name} ${i + 1}</div><div class="body"><div class="name">Coming soon</div><div class="meta"><span>—</span></div></div></div>`).join("")
      }</div></div>`).join("")
    : (mine.length
      ? `<p class="note">Your validated tracks (driven to the finish in the builder). Medals: author, gold ×1.06, silver ×1.2, bronze ×1.5.</p><div class="grid">${mine.map((r) => trackCard(r, { actions: null })).join("")}</div>`
      : `<p class="note">No validated track yet. Build one, and let the builder's test lap finish: its time becomes the author time.</p><div class="grid"><a class="card new cut" href="#build">Build a track ▶</a></div>`);
  $("screen").innerHTML = `<div class="tabs"><button data-tab="campaign" class="${playTab === "campaign" ? "on" : ""}">Campaign</button><button data-tab="mine" class="${playTab === "mine" ? "on" : ""}">My tracks <span style="color:var(--dim);font-size:14px">${mine.length}</span></button></div>${body}`;
  for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => { playTab = b.dataset.tab; play(); };
  for (const c of document.querySelectorAll(".card[data-id]")) c.onclick = () => { location.href = driveUrl(c.dataset.id); };
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
    <div class="grid"><div class="card new cut" id="new">+ New track</div>${cards}</div>`;
  $("new").onclick = () => { location.href = builderUrl(library.create().id); };
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
    <div class="keys">
      <span><kbd>W</kbd><kbd>S</kbd> / <kbd>↑</kbd><kbd>↓</kbd></span><span>throttle / brake</span>
      <span><kbd>A</kbd><kbd>D</kbd> / <kbd>←</kbd><kbd>→</kbd></span><span>steer</span>
      <span><kbd>Shift</kbd> <kbd>Ctrl</kbd></span><span>pitch in the air (nose up / down)</span>
      <span><kbd>Q</kbd> <kbd>E</kbd></span><span>spin in the air</span>
      <span><kbd>Z</kbd> <kbd>X</kbd></span><span>roll in the air</span>
      <span><kbd>Space</kbd></span><span>handbrake</span>
      <span><kbd>Backspace</kbd></span><span>last checkpoint, keeping your speed (twice: standing)</span>
      <span><kbd>R</kbd> <kbd>Delete</kbd></span><span>restart</span>
      <span><kbd>Esc</kbd></span><span>back</span>
    </div></div>`;
  for (const t of document.querySelectorAll(".toggle")) t.onclick = () => { settings.set({ [t.dataset.key]: !settings.get()[t.dataset.key] }); settingsScreen(); };
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
