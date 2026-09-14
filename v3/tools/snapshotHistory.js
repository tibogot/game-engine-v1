/**
 * Undo/redo for a system whose whole editable state fits in a small snapshot
 * (a JSON string): road networks, lake rectangles.
 *
 * The history keeps the CURRENT snapshot. Call `commit()` after an edit has
 * finished; if the state really changed, the previous snapshot becomes one undo
 * step. That means:
 *   - a drag is one step when you commit on release, not on every move;
 *   - a panel slider that fires on every input can pass a `coalesce` key, and
 *     a burst of commits with that key (each < `coalesceMs` apart) is one step;
 *   - a click that changed nothing (select only) adds nothing, as long as the
 *     snapshot leaves selection out.
 *
 * Every edit must commit. An edit that doesn't would be silently rolled back
 * by the next undo (the restore goes to a snapshot taken before it).
 *
 * Call `reset()` after the state is replaced wholesale (a project load), so the
 * first undo cannot reach back into the previous scene.
 */
export function createSnapshotHistory({ capture, restore, max = 50, coalesceMs = 800, now = () => performance.now() }) {
  const undoStack = [];
  const redoStack = [];
  let current = capture();
  let coalesceKey = null;
  let coalesceAt = 0;

  function commit({ coalesce = null } = {}) {
    const next = capture();
    if (next === current) return false;
    const t = now();
    const merge = coalesce !== null && coalesce === coalesceKey && t - coalesceAt < coalesceMs;
    if (!merge) {
      undoStack.push(current);
      if (undoStack.length > max) undoStack.shift();
    }
    redoStack.length = 0;
    current = next;
    coalesceKey = coalesce;
    coalesceAt = t;
    return true;
  }

  function _step(from, to) {
    if (!from.length) return false;
    to.push(current);
    current = from.pop();
    coalesceKey = null;
    restore(current);
    return true;
  }

  return {
    commit,
    /** Run an edit and commit it. Returns what the edit returned. */
    record(edit, opts) {
      const result = edit();
      commit(opts);
      return result;
    },
    undo: () => _step(undoStack, redoStack),
    redo: () => _step(redoStack, undoStack),
    reset() {
      undoStack.length = 0;
      redoStack.length = 0;
      current = capture();
      coalesceKey = null;
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
  };
}
