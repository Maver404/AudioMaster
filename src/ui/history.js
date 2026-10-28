// Undo / redo ("Annulla" / "Ripeti"): one global history of the user's actions on the
// sound. Environment-neutral (no DOM, no timers: the caller passes `now`), so it is unit-
// tested in Node (tests/history.test.mjs); app.js owns the state, takes the snapshots and
// applies them.
// A step is { label, trackId, before, after, key, at, born, sealed }: `before` / `after` are
// snapshots of the undoable state (plain data, compared with sameValue), `label` an i18n
// descriptor (labelText) naming the action, `trackId` the song it belongs to (null =
// global). Undo hands the step back and the caller restores `before`; redo restores
// `after`. A new action after an undo clears the redo list; an action that changes
// nothing makes no step; the oldest step goes past `limit`.
// Coalescing: actions with the same `key` (e.g. one fader of one song) recorded within
// `windowMs` of each other merge into ONE step (a slider drag, a burst of arrow keys);
// seal() ends the merge (pointer released). A merge that lands back on the starting
// state removes the step and undoes its side effects on the lists too (the redo list its
// first action cleared, a step it pushed past the limit): a gesture that changes nothing
// overall is a no-op. `force` also merges into a sealed step that was born within the
// window (the double-click reset joins the step of the double-click's own clicks, never a
// longer drag before it).

/** Most steps kept (the oldest is dropped beyond it). */
export const HISTORY_LIMIT = 50;
/** Same-key actions closer than this (ms) merge into one step (debounce, not a fixed span). */
export const COALESCE_MS = 600;

/**
 * Structural equality of plain data: primitives (0 = −0, NaN = NaN), arrays, typed
 * arrays and plain objects (same own keys). Shared references compare in O(1).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a !== a && b !== b; // NaN
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const va = ArrayBuffer.isView(a);
  if (va !== ArrayBuffer.isView(b)) return false;
  if (va || Array.isArray(a) || Array.isArray(b)) {
    if (Array.isArray(a) !== Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !sameValue(a[k], b[k])) return false;
  return true;
}

/**
 * Create a history.
 * @param {{ limit?: number, equals?: (a: unknown, b: unknown) => boolean }} [o]
 */
export function createHistory({ limit = HISTORY_LIMIT, equals = sameValue } = {}) {
  const max = Math.max(1, Math.floor(limit) || HISTORY_LIMIT);
  let undos = [];
  let redos = [];
  let open = null; // the step the last record() created or merged into (undo / redo close it)
  // What adding `open` took from the lists (the redo list it cleared, the oldest steps it
  // pushed past the limit): given back if its gesture ends where it started.
  let openTook = null;
  const close = () => {
    open = null;
    openTook = null;
  };

  const top = () => undos[undos.length - 1] || null;

  return {
    /**
     * Record one action.
     * @param {{ label: unknown, trackId?: string|null, before: unknown, after: unknown }} step
     * @param {{ key?: string|null, now?: number, windowMs?: number, force?: boolean }} [o]
     * @returns {'added'|'merged'|'removed'|null} null: nothing changed, no step
     */
    record(step, { key = null, now = 0, windowMs = COALESCE_MS, force = false } = {}) {
      const t = top();
      const joinSealed = force && now - t?.born <= windowMs;
      if (key !== null && key !== undefined && t && t === open && t.key === key && (!t.sealed || joinSealed) && now - t.at <= windowMs) {
        t.after = step.after;
        t.label = step.label;
        t.at = now;
        if (equals(t.before, t.after)) {
          undos.pop();
          if (openTook) {
            redos = openTook.redos;
            undos.unshift(...openTook.dropped);
          }
          close();
          return 'removed';
        }
        return 'merged';
      }
      if (equals(step.before, step.after)) return null;
      const s = { label: step.label, trackId: step.trackId ?? null, before: step.before, after: step.after, key: key ?? null, at: now, born: now, sealed: false };
      undos.push(s);
      const dropped = undos.length > max ? undos.splice(0, undos.length - max) : [];
      openTook = key !== null && key !== undefined ? { redos, dropped } : null; // only a keyed step can merge back
      redos = [];
      open = s;
      return 'added';
    },

    /** End the merge window of the last step (a pointer gesture ended). */
    seal() {
      if (open) open.sealed = true;
    },

    /** Take the last step back: the caller restores its `before`. */
    undo() {
      const s = undos.pop();
      if (!s) return null;
      close();
      redos.push(s);
      return s;
    },

    /** Redo the last undone step: the caller restores its `after`. */
    redo() {
      const s = redos.pop();
      if (!s) return null;
      close();
      undos.push(s);
      return s;
    },

    peekUndo: () => top(),
    peekRedo: () => redos[redos.length - 1] || null,
    canUndo: () => undos.length > 0,
    canRedo: () => redos.length > 0,
    get size() {
      return { undo: undos.length, redo: redos.length };
    },
    /** Copies of both lists, oldest first (inspection, tests). */
    get steps() {
      return { undo: undos.slice(), redo: redos.slice() };
    },

    /**
     * Rewrite every snapshot with `map` and drop the steps for which `drop` is true or that
     * no longer change anything (e.g. a song was removed: its steps and its part of every
     * snapshot go).
     * @param {{ drop?: (step: object) => boolean, map?: (snap: unknown) => unknown }} o
     * @returns {number} steps removed
     */
    prune({ drop = () => false, map = null } = {}) {
      let removed = 0;
      const keep = (list, count = true) =>
        list.filter((s) => {
          if (map) {
            s.before = map(s.before);
            s.after = map(s.after);
          }
          const ok = !drop(s) && !equals(s.before, s.after);
          if (!ok) {
            if (count) removed++;
            if (s === open) close();
          }
          return ok;
        });
      undos = keep(undos);
      redos = keep(redos);
      if (openTook) openTook = { redos: keep(openTook.redos, false), dropped: keep(openTook.dropped, false) };
      return removed;
    },

    clear() {
      undos = [];
      redos = [];
      close();
    },
  };
}

/**
 * Text of a step label: { key, vars } translated with `t`; a var may be a { key, vars }
 * descriptor (translated too) or a function (called, e.g. a value formatted in the current
 * language), so labels follow a language switch. Strings pass through.
 * @param {string|{ key: string, vars?: object }|(() => string)|null} label
 * @param {(key: string, vars?: object) => string} t
 * @returns {string}
 */
export function labelText(label, t) {
  if (label === null || label === undefined) return '';
  if (typeof label === 'string') return label;
  if (typeof label === 'function') return String(label());
  if (typeof label !== 'object' || typeof label.key !== 'string') return String(label);
  if (!label.vars) return t(label.key);
  const vars = {};
  for (const [k, v] of Object.entries(label.vars)) {
    if (typeof v === 'function') vars[k] = String(v());
    else if (v && typeof v === 'object' && typeof v.key === 'string') vars[k] = labelText(v, t);
    else vars[k] = v;
  }
  return t(label.key, vars);
}

const TEXT_INPUTS = new Set(['', 'text', 'search', 'number', 'email', 'url', 'tel', 'password', 'date', 'time', 'datetime-local', 'month', 'week']);

/**
 * Whether Ctrl/⌘+Z may undo an action while `el` has focus: never in a text, number or
 * contenteditable field, where the browser's own text undo must keep working.
 * @param {{ tagName?: string, type?: string, isContentEditable?: boolean }|null} el
 */
export function undoKeyAllowed(el) {
  if (!el) return true;
  if (el.isContentEditable) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return false;
  if (tag === 'INPUT') return !TEXT_INPUTS.has(String(el.type || '').toLowerCase());
  return true;
}

/**
 * Keyboard event → 'undo' (Ctrl/⌘+Z), 'redo' (Shift+Ctrl/⌘+Z, Ctrl+Y) or null. Letters
 * are read from `key` (the layout's own Z), from `code` only on non-Latin layouts.
 * @param {{ key?: string, code?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 * @returns {'undo'|'redo'|null}
 */
export function historyKey(e) {
  if (!e || e.altKey || !(e.ctrlKey || e.metaKey)) return null;
  const k = String(e.key || '').toLowerCase();
  const latin = /^[a-z]$/.test(k);
  const is = (letter) => k === letter || (!latin && e.code === `Key${letter.toUpperCase()}`);
  if (is('z')) return e.shiftKey ? 'redo' : 'undo';
  if (is('y') && e.ctrlKey && !e.metaKey && !e.shiftKey) return 'redo';
  return null;
}
