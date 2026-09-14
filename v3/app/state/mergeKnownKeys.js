/**
 * Copy saved values onto a live state object, but only for keys the live
 * object already has. Nested plain objects merge the same way.
 *
 * So a project written before a param existed keeps today's default for it
 * (instead of `undefined`), and a param since retired is ignored rather than
 * resurrected. A value of a different kind than the default (a string where a
 * number lives) is ignored too. Arrays and null defaults take the saved value.
 */
export function mergeKnownKeys(dst, src) {
  if (!_isPlain(dst) || !_isPlain(src)) return dst;
  for (const key of Object.keys(dst)) {
    const from = src[key];
    if (from === undefined) continue;
    const to = dst[key];
    if (_isPlain(to)) {
      mergeKnownKeys(to, from);
    } else if (to === null || Array.isArray(to) || typeof to === typeof from) {
      dst[key] = from;
    }
  }
  return dst;
}

function _isPlain(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
