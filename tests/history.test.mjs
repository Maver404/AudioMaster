// Undo / redo history (src/ui/history.js): push, undo, redo, the 50-step limit, coalescing
// of a slider drag into one step, no-op actions, a new action clearing the redo list,
// pruning a removed song, labels that follow the language, and the keyboard gating.
import { assert } from './helpers.mjs';
import { createHistory, sameValue, labelText, undoKeyAllowed, historyKey, HISTORY_LIMIT, COALESCE_MS } from '../src/ui/history.js';
import { STRINGS, LANGUAGES, t, setLanguage, getLanguage } from '../src/ui/i18n.js';

/** A tiny "app": state = { v, w }, actions recorded with before / after snapshots. */
function model() {
  const h = createHistory();
  const state = { v: 0, w: 'a' };
  const snap = () => ({ ...state });
  const act = (label, fn, o = {}) => {
    const before = snap();
    fn();
    return h.record({ label, trackId: o.trackId ?? null, before, after: snap() }, o);
  };
  const undo = () => {
    const s = h.undo();
    if (s) Object.assign(state, s.before);
    return s;
  };
  const redo = () => {
    const s = h.redo();
    if (s) Object.assign(state, s.after);
    return s;
  };
  return { h, state, act, undo, redo };
}

function withLang(lang, fn) {
  const prev = getLanguage();
  setLanguage(lang);
  try {
    return fn();
  } finally {
    setLanguage(prev);
  }
}

export const tests = {
  'history: push, undo and redo restore the exact states in order': () => {
    const { h, state, act, undo, redo } = model();
    assert(!h.canUndo() && !h.canRedo() && h.undo() === null && h.redo() === null, 'empty history');
    assert(act('one', () => (state.v = 1)) === 'added');
    assert(act('two', () => (state.w = 'b')) === 'added');
    assert(act('three', () => (state.v = 3)) === 'added');
    assert(h.peekUndo().label === 'three' && h.size.undo === 3, 'top is the last action');
    assert(undo().label === 'three' && state.v === 1 && state.w === 'b', JSON.stringify(state));
    assert(undo().label === 'two' && state.w === 'a');
    assert(h.peekRedo().label === 'two' && h.size.redo === 2, 'redo holds the undone steps, newest first');
    assert(redo().label === 'two' && state.w === 'b');
    assert(redo().label === 'three' && state.v === 3 && !h.canRedo());
    while (undo());
    assert(state.v === 0 && state.w === 'a' && h.size.redo === 3, 'all the way back');
  },

  'history: a new action after an undo clears the redo list': () => {
    const { h, state, act, undo } = model();
    act('one', () => (state.v = 1));
    act('two', () => (state.v = 2));
    undo();
    assert(h.canRedo());
    act('other', () => (state.w = 'z'));
    assert(!h.canRedo() && h.peekUndo().label === 'other' && h.size.undo === 2, 'redo not cleared');
  },

  'history: an action that changes nothing makes no step and keeps the redo list': () => {
    const { h, state, act, undo } = model();
    act('one', () => (state.v = 1));
    act('two', () => (state.v = 2));
    undo();
    assert(act('same', () => (state.v = 1)) === null, 'no-op recorded');
    assert(h.size.undo === 1 && h.canRedo(), 'a no-op must not touch the lists');
    assert(h.record({ label: 'x', before: { a: [1, 2], b: { c: 3 } }, after: { b: { c: 3 }, a: [1, 2] } }) === null, 'deep-equal snapshots are a no-op');
  },

  [`history: at most ${HISTORY_LIMIT} steps, the oldest goes first`]: () => {
    const { h, state, act, undo } = model();
    for (let i = 1; i <= HISTORY_LIMIT + 7; i++) act(`#${i}`, () => (state.v = i));
    assert(h.size.undo === HISTORY_LIMIT, `${h.size.undo} steps`);
    let n = 0;
    while (undo()) n++;
    assert(n === HISTORY_LIMIT && state.v === 7, `undone ${n}, state ${state.v} (the 7 oldest steps are gone)`);
    const small = createHistory({ limit: 2 });
    for (let i = 0; i < 5; i++) small.record({ label: i, before: i, after: i + 1 });
    assert(small.size.undo === 2 && small.peekUndo().label === 4);
  },

  'history: a slider drag coalesces into one step; a pause, seal() or another key starts a new one': () => {
    const { h, state, act, undo, redo } = model();
    let now = 1000;
    const drag = (v, o = {}) => act('fader', () => (state.v = v), { key: 'int', now, ...o });
    assert(drag(0.1) === 'added');
    for (const v of [0.2, 0.3, 0.4]) {
      now += 50;
      assert(drag(v) === 'merged');
    }
    assert(h.size.undo === 1 && h.peekUndo().before.v === 0 && h.peekUndo().after.v === 0.4, 'one step for the drag');
    // Debounce: the window counts from the last merge, not from the first event.
    now += COALESCE_MS - 1;
    assert(drag(0.5) === 'merged', 'within the window of the last event');
    now += COALESCE_MS + 1;
    assert(drag(0.6) === 'added', 'a pause starts a new step');
    // Held pointer: no time limit until seal().
    now += 5000;
    assert(drag(0.7, { windowMs: Infinity }) === 'merged');
    h.seal();
    now += 10;
    assert(drag(0.8) === 'added', 'sealed: the next event is a new step');
    now += 10;
    assert(act('other fader', () => (state.w = 'q'), { key: 'other', now }) === 'added', 'another key: new step');
    now += 10;
    assert(drag(0.9) === 'added', 'back to the first key after another action: new step');
    assert(h.size.undo === 5, `${h.size.undo} steps`);
    undo();
    undo();
    undo();
    undo();
    assert(state.v === 0.5 && state.w === 'a', JSON.stringify(state));
    // After an undo nothing merges into the uncovered step.
    now += 10;
    assert(drag(0.55) === 'added' && !h.canRedo(), 'merged into a step uncovered by undo');
    undo();
    redo();
    now += 10;
    assert(drag(0.56) === 'added', 'merged into a step brought back by redo');
  },

  'history: a coalesced step that returns to its start is removed; force merges into a sealed step': () => {
    const { h, state, act } = model();
    let now = 0;
    act('base', () => (state.w = 'b'));
    act('toggle', () => (state.v = 1), { key: 'sw', now });
    now += 100;
    assert(act('toggle', () => (state.v = 0), { key: 'sw', now }) === 'removed', 'on + off within the window');
    assert(h.size.undo === 1 && h.peekUndo().label === 'base', 'no-op step left behind');
    // Double-click: click (sealed step) then reset within the window, forced into one step.
    now += 1000;
    act('fader', () => (state.v = 0.3), { key: 'f', now });
    h.seal();
    now += 200;
    assert(act('fader: auto', () => (state.v = 0), { key: 'f', now }) === 'added', 'a sealed step does not merge without force');
    const { h: h2, state: s2, act: act2 } = model();
    act2('fader', () => (s2.v = 0.3), { key: 'f', now: 0 });
    h2.seal();
    assert(act2('fader: auto', () => (s2.v = 0.7), { key: 'f', now: 200, force: true }) === 'merged' && h2.size.undo === 1, 'forced merge');
    assert(h2.peekUndo().label === 'fader: auto' && h2.peekUndo().before.v === 0, 'the merged step keeps the first before and the last label');
    assert(act2('fader: auto', () => (s2.v = 0), { key: 'f', now: 300, force: true }) === 'removed' && !h2.canUndo(), 'double-click back to the start leaves no step');
    assert(act2('late', () => (s2.v = 1), { key: 'f', now: 300 + COALESCE_MS + 1, force: true }) === 'added', 'force keeps the time window');
    // A long drag (born long ago) then a quick double-click reset: the drag stays its own step.
    const { h: h3, state: s3, act: act3 } = model();
    act3('drag', () => (s3.v = 0.2), { key: 'f', now: 0 });
    act3('drag', () => (s3.v = 0.4), { key: 'f', now: 1000, windowMs: Infinity });
    h3.seal();
    assert(act3('fader: auto', () => (s3.v = 0), { key: 'f', now: 1100, force: true }) === 'added' && h3.size.undo === 2, 'reset merged into a drag');
    assert(h3.steps.undo[0].after.v === 0.4 && h3.steps.undo[1].before.v === 0.4, 'the drag keeps its end state');
  },

  'history: a merged gesture that ends where it started gives the redo list (and a step pushed past the limit) back': () => {
    // H3: the first input of the gesture cleared the redo list; landing back on the start
    // is a no-op overall, and a no-op keeps the redo list.
    const { h, state, act, undo, redo } = model();
    act('A', () => (state.w = 'b'));
    undo();
    assert(h.canRedo() && h.peekRedo().label === 'A');
    assert(act('fader', () => (state.v = 5), { key: 'f', now: 1000 }) === 'added' && !h.canRedo(), 'a real change clears the redo list');
    assert(act('fader', () => (state.v = 0), { key: 'f', now: 1100 }) === 'removed');
    assert(h.canRedo() && h.peekRedo().label === 'A' && h.size.undo === 0 && h.size.redo === 1, JSON.stringify(h.size));
    assert(redo().label === 'A' && state.w === 'b', 'the kept redo step still works');
    // Same through a sealed step and a forced merge (click, then the double-click reset).
    undo();
    act('fader', () => (state.v = 0.3), { key: 'f', now: 5000 });
    h.seal();
    assert(act('fader: auto', () => (state.v = 0), { key: 'f', now: 5200, force: true }) === 'removed' && h.peekRedo() && h.peekRedo().label === 'A', 'double-click back to auto');
    // A gesture that merges into a real change, then comes back: still nothing changed.
    act('fader', () => (state.v = 1), { key: 'f', now: 9000 });
    act('fader', () => (state.v = 2), { key: 'f', now: 9100 });
    assert(!h.canRedo(), 'mid-gesture: a real change');
    assert(act('fader', () => (state.v = 0), { key: 'f', now: 9200 }) === 'removed' && h.canRedo(), 'back to the start');
    // Once the gesture is over (another step, an undo) the cleared list stays cleared.
    act('fader', () => (state.v = 7), { key: 'f', now: 20000 });
    act('other', () => (state.w = 'q'), { key: 'o', now: 20010 });
    assert(!h.canRedo() && h.size.undo === 2);
    undo();
    assert(act('fader', () => (state.v = 0), { key: 'f', now: 20020 }) === 'added' && !h.canRedo(), 'a later step does not resurrect an old redo list');
    // At the limit: the step the gesture pushed out comes back with the removal.
    const small = createHistory({ limit: 2 });
    small.record({ label: 'one', before: 0, after: 1 });
    small.record({ label: 'two', before: 1, after: 2 });
    small.record({ label: 'g', before: 2, after: 3 }, { key: 'g', now: 0 });
    assert(small.size.undo === 2 && small.steps.undo[0].label === 'two');
    assert(small.record({ label: 'g', before: 2, after: 2 }, { key: 'g', now: 50 }) === 'removed');
    assert(small.size.undo === 2 && small.steps.undo.map((s) => s.label).join() === 'one,two', small.steps.undo.map((s) => s.label).join());
  },

  'history: prune drops a removed song and the steps that no longer change anything': () => {
    const h = createHistory();
    const snap = (a, b) => ({ dest: 'x', tracks: [{ id: 't1', v: a }, { id: 't2', v: b }] });
    h.record({ label: 'a', trackId: 't1', before: snap(0, 0), after: snap(1, 0) });
    h.record({ label: 'b', trackId: 't2', before: snap(1, 0), after: snap(1, 5) });
    h.record({ label: 'all', trackId: null, before: snap(1, 5), after: snap(1, 1) }); // only t2 changes
    h.record({ label: 'c', trackId: 't1', before: snap(1, 1), after: snap(2, 1) });
    h.undo();
    const strip = (s) => ({ ...s, tracks: s.tracks.filter((x) => x.id !== 't2') });
    const n = h.prune({ drop: (s) => s.trackId === 't2', map: strip });
    assert(n === 2, `${n} removed (t2's own step and the global one that only touched t2)`);
    assert(h.size.undo === 1 && h.size.redo === 1 && h.peekUndo().label === 'a' && h.peekRedo().label === 'c', JSON.stringify(h.size));
    assert(h.peekUndo().after.tracks.length === 1, 'snapshots rewritten');
    h.clear();
    assert(!h.canUndo() && !h.canRedo());
  },

  'history: sameValue compares plain data structurally': () => {
    assert(sameValue(1, 1) && sameValue(0, -0) && sameValue(NaN, NaN) && !sameValue(1, '1') && !sameValue(null, {}) && sameValue(null, null));
    assert(sameValue([[0, 10], [20, 30]], [[0, 10], [20, 30]]) && !sameValue([[0, 10]], [[0, 11]]) && !sameValue([1], { 0: 1 }));
    assert(sameValue({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 }) && !sameValue({ a: 1 }, { a: 1, b: undefined }));
    assert(sameValue(Float32Array.from([1, 2]), Float32Array.from([1, 2])) && !sameValue(Float32Array.from([1]), [1]));
    const ref = { ltas: new Array(31).fill(-20), name: 'x' };
    assert(sameValue({ reference: ref }, { reference: ref }) && !sameValue({ reference: ref }, { reference: null }));
  },

  'history: labels translate with their vars and follow the language': () => {
    const label = { key: 'history.set', vars: { what: { key: 'choice.character' }, value: { key: 'style.warm' } } };
    withLang('it', () => {
      assert(labelText(label, t) === 'Carattere «Caldo»', labelText(label, t));
      assert(t('history.undoNamed', { action: labelText(label, t) }) === 'Annulla: Carattere «Caldo»');
      assert(t('history.redoNamed', { action: labelText({ key: 'cut.remove' }, t) }) === 'Ripeti: Elimina la selezione');
      assert(labelText({ key: 'history.set', vars: { what: () => 'Volume obiettivo', value: () => '−12,0 LUFS' } }, t) === 'Volume obiettivo «−12,0 LUFS»');
    });
    withLang('en', () => assert(labelText(label, t) === 'Character “Warm”', labelText(label, t)));
    assert(labelText('plain', t) === 'plain' && labelText(null, t) === '' && labelText(() => 'f', t) === 'f');
    const keys = ['history.undo', 'history.redo', 'history.undoNamed', 'history.redoNamed', 'history.undone', 'history.redone', 'history.onTrack', 'history.nothingUndo', 'history.nothingRedo', 'history.keyUndo', 'history.keyRedo', 'history.set', 'history.auto', 'history.sectionAuto', 'history.problemsReset', 'history.fadeRemove', 'history.refLoad'];
    for (const lang of LANGUAGES) for (const k of keys) assert(typeof STRINGS[lang][k] === 'string' && STRINGS[lang][k].trim(), `${lang}:${k} missing`);
    for (const lang of LANGUAGES) for (const k of ['history.undoNamed', 'history.redoNamed', 'history.undone', 'history.redone']) assert(STRINGS[lang][k].includes('{action}'), `${lang}:${k} needs {action}`);
    // The accessible name starts with the visible text (WCAG 2.5.3).
    for (const lang of LANGUAGES) {
      assert(STRINGS[lang]['history.undoNamed'].startsWith(STRINGS[lang]['history.undo']), `${lang}: undo name`);
      assert(STRINGS[lang]['history.redoNamed'].startsWith(STRINGS[lang]['history.redo']), `${lang}: redo name`);
    }
  },

  'history: Ctrl/⌘+Z undoes, Shift+Ctrl/⌘+Z and Ctrl+Y redo, never inside a text field': () => {
    const k = (key, o = {}) => historyKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
    assert(k('z', { ctrlKey: true }) === 'undo' && k('z', { metaKey: true }) === 'undo');
    assert(k('Z', { ctrlKey: true, shiftKey: true }) === 'redo' && k('z', { metaKey: true, shiftKey: true }) === 'redo');
    assert(k('y', { ctrlKey: true }) === 'redo' && k('y', { metaKey: true }) === null, 'Ctrl+Y only');
    assert(k('z') === null && k('z', { ctrlKey: true, altKey: true }) === null && k('x', { ctrlKey: true }) === null);
    assert(k('я', { ctrlKey: true, code: 'KeyZ' }) === 'undo', 'non-Latin layout: by key position');
    assert(k('w', { ctrlKey: true, code: 'KeyZ' }) === null, 'Latin layout: by letter (AZERTY Z is the letter Z)');
    const fake = (tagName, o = {}) => ({ tagName, type: o.type, isContentEditable: !!o.ce });
    assert(undoKeyAllowed(null) && undoKeyAllowed(fake('BUTTON')) && undoKeyAllowed(fake('INPUT', { type: 'range' })) && undoKeyAllowed(fake('SELECT')) && undoKeyAllowed(fake('BODY')), 'controls');
    for (const type of ['text', 'number', 'search', '']) assert(!undoKeyAllowed(fake('INPUT', { type })), `input ${type}`);
    assert(!undoKeyAllowed(fake('TEXTAREA')) && !undoKeyAllowed(fake('DIV', { ce: true })), 'textarea / contenteditable');
  },
};
