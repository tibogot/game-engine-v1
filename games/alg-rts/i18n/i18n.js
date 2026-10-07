// LANGUAGES (2026-10-07, you: "friends want to play and they only read English"). French is the
// game's own language and the KEY: the code writes t("Ligne coupée !"), and a dictionary maps
// that French to the other languages (i18n/en/*.js, one part per area of the game). A line
// missing from a dictionary shows in French — never blank — and the test
// (tools/algI18nTest.mjs) lists every t("…") in the code that has no English yet.
//
//   t(fr, vars)     the text in the player's language; {name} placeholders filled from `vars`
//                   (the SAME placeholders in every language).
//   LANG            "fr" | "en" (Arabic later: right-to-left, its own font — TODO.md item 9).
//   setLang(key)    remembered, and the page reloads (most text is built once, at load).
//
// Chosen in the options menu (Échap) and on the briefing; ?lang=en|fr overrides. The first
// visit: the browser's language (French → fr, anything else → en). Perf: a Map lookup when a
// line is built — nothing per frame.
import EN from "./en/index.js";

export const LANGS = [
  { key: "fr", label: "Français" },
  { key: "en", label: "English" },
];
const STORE = "algrts.lang";
const DICTS = { en: EN };

function detect() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q && LANGS.some((l) => l.key === q)) return q;
    const s = localStorage.getItem(STORE);
    if (s && LANGS.some((l) => l.key === s)) return s;
  } catch { /* no window / private mode */ }
  const nav = (typeof navigator !== "undefined" && (navigator.languages?.[0] || navigator.language)) || "fr";
  return /^fr\b/i.test(nav) ? "fr" : "en";
}

export const LANG = detect();
const dict = DICTS[LANG] ?? null;
const missing = new Set();

/** The text in the player's language; `{key}` placeholders filled from `vars`. */
export function t(fr, vars = null) {
  let s = fr;
  if (dict) {
    const tr = dict[fr];
    if (tr != null) s = tr;
    else missing.add(fr);
  }
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Switch language: remembered, then the page reloads. */
export function setLang(key) {
  if (!LANGS.some((l) => l.key === key)) return;
  try { localStorage.setItem(STORE, key); } catch { /* ignore */ }
  const u = new URL(location.href);
  u.searchParams.delete("lang");
  location.href = u.toString();
}

// Dev: __ALG_I18N.missing() — the French lines met this session with no translation.
if (typeof window !== "undefined") window.__ALG_I18N = { LANG, missing: () => [...missing] };
if (typeof document !== "undefined") document.documentElement.lang = LANG;
