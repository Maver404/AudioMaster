// Cut bar ("Taglia"): select a part of the song on the waveform, listen to it, save it as
// a clip of the master, or edit the song before mastering. Pure helpers first (DOM-free,
// tested in Node); createCutBar() builds the bar (nothing touches the DOM at import time).
// Two kinds of action are kept visibly apart: "Salva la selezione" exports a piece of the
// MASTER (what gets published), "Modifica il brano" changes the song the master is made
// from (non-destructive: app.js keeps the edit list, src/audio/edit.js renders it; every
// edit and "Torna al brano completo" is a step of the app's one undo history, history.js).
// The selection lives on the player's timeline (master seconds); app.js converts it to the
// edited song's frames with selectionToEdited().
import { t, getLanguage, formatNumber, formatTime } from './i18n.js';
import { h, clear } from './controls.js';
import * as help from './help.js';
import { MIN_SELECTION_SEC, MIN_RESULT_SEC } from '../audio/edit.js';

const TEXT_INPUTS = new Set(['', 'text', 'search', 'number', 'email', 'url', 'tel', 'password', 'date', 'time', 'datetime-local', 'month', 'week']);

/**
 * Parse a timecode typed by the user: "m:ss.mmm", "m:ss", "h:mm:ss(.mmm)" or plain
 * seconds "ss.mmm"; comma or dot as the decimal mark, spaces around ignored.
 * @param {string} str
 * @returns {number|null} seconds, or null when the text is not a valid time
 */
export function parseTimecode(str) {
  const s = String(str ?? '').trim().replace(',', '.');
  if (!s || (s.match(/\./g) || []).length > 1) return null;
  const parts = s.split(':');
  if (parts.length > 3) return null;
  const last = parts[parts.length - 1];
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(last)) return null;
  for (let i = 0; i < parts.length - 1; i++) if (!/^\d+$/.test(parts[i])) return null;
  const sec = Number(last);
  if (parts.length > 1 && sec >= 60) return null;
  if (parts.length === 3 && Number(parts[1]) >= 60) return null;
  let total = sec;
  if (parts.length === 2) total += Number(parts[0]) * 60;
  if (parts.length === 3) total += Number(parts[0]) * 3600 + Number(parts[1]) * 60;
  return Number.isFinite(total) ? total : null;
}

/**
 * Seconds → "m:ss,mmm" (Italian decimal comma) or "m:ss.mmm".
 * @param {number} sec
 * @param {'it'|'en'} [lang]
 */
export function formatTimecode(sec, lang = 'it') {
  const ms = Math.max(0, Math.round((Number.isFinite(sec) ? sec : 0) * 1000));
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const f = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}${lang === 'it' ? ',' : '.'}${String(f).padStart(3, '0')}`;
}

const mmss = (sec) => {
  const t = Math.max(0, Math.floor(Number(sec) || 0));
  return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, '0')}s`;
};

/**
 * Default clip name: "<base> (Master) 0m12s-0m42s" (+ ".ext"), file-system safe.
 * @param {string} base song name
 * @param {number} startSec
 * @param {number} endSec
 * @param {string} [ext] extension without the dot
 */
export function clipFileName(base, startSec, endSec, ext) {
  const clean = cleanName(base) || 'AudioMaster';
  return `${clean} (Master) ${mmss(startSec)}-${mmss(endSec)}${ext ? `.${ext}` : ''}`;
}

/** Characters that break file systems removed, spaces collapsed. */
export function cleanName(name) {
  return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Selection on the player's timeline (master seconds) → frames of the edited song (the
 * original the master was made from): + lead (the head cut by trim). A selection that
 * starts at 0 / ends at the timeline's end reaches the edited song's ends, so "remove to
 * the end" also takes the trimmed tail.
 * @param {{ start: number, end: number }} sel
 * @param {{ lead: number, sampleRate: number, timelineDuration: number, editedFrames: number }} o
 * @returns {{ e0: number, e1: number }}
 */
export function selectionToEdited(sel, { lead = 0, sampleRate, timelineDuration, editedFrames }) {
  const clampF = (x) => Math.max(0, Math.min(editedFrames, x));
  const e0 = sel.start <= 1e-3 ? 0 : clampF(Math.round((sel.start + lead) * sampleRate));
  const e1 = sel.end >= timelineDuration - 1e-3 ? editedFrames : clampF(Math.round((sel.end + lead) * sampleRate));
  return { e0, e1 };
}

/** Whether the cut keys (I / O / L / Esc) may act while `el` has focus: never while typing. */
export function cutKeyAllowed(el) {
  if (!el) return true;
  if (el.isContentEditable) return false;
  const tag = String(el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return false;
  if (tag === 'INPUT') return !TEXT_INPUTS.has(String(el.type || '').toLowerCase());
  return true;
}

// --- The bar ---------------------------------------------------------------------------

const MIN_SEL_SEC = 0.01; // a drag shorter than this is a click, not a selection
const NUDGES = [-1, -0.1, 0.1, 1];
const DEFAULT_FADE_SEC = 0.01; // shown with the locale's decimal mark (re-localized until edited)

// (i) explanation cards (help.js; texts help.<id>.what / .when / .example in i18n.js).
// Namespace import: a missing export just means no button, never a broken bar.
const helpBtn = (id, label) => (typeof help.helpButton === 'function' ? help.helpButton(id, { label }) : null);
const withHelp = (el, btn, cls) => (btn && typeof help.withHelp === 'function' ? help.withHelp(el, btn, cls) : el);

/** Whether `el` shows at least partly inside the viewport (a focus ring there can be seen). */
export function inView(el) {
  const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 0;
  return !!r && r.height > 0 && r.bottom > 0 && r.top < vh;
}

function svgIcon(name) {
  const paths = {
    scissors: '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><path d="M8.2 7.6L20 18M8.2 16.4L20 6"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none"/>',
    loop: '<path d="M17 2.5l3 3-3 3"/><path d="M4 11.5v-1a5 5 0 015-5h11"/><path d="M7 21.5l-3-3 3-3"/><path d="M20 12.5v1a5 5 0 01-5 5H4"/>',
    save: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 20h14"/>',
  };
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false">${paths[name] || ''}</svg>`;
  return span;
}

/** Nudge button text: "−1 s", "−0,1", "+0,1", "+1 s" (locale decimal mark). */
function nudgeText(d) {
  return `${d > 0 ? '+' : '−'}${Math.abs(d) >= 1 ? `${formatNumber(Math.abs(d), 0)} s` : formatNumber(Math.abs(d), 1)}`;
}

/** "0,01" / "0.5" → seconds in [0, 60], or null. */
function parseSeconds(str) {
  const s = String(str ?? '').trim().replace(',', '.');
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) && v <= 60 ? v : null;
}

/**
 * Build the cut bar. app.js owns the song model and the export / edit pipelines and passes
 * them in; the bar owns the selection, zoom, loop and its form fields. Placement is up to
 * app.js: `toggle` (the "Taglia" button, paired with its (i) when help text exists) goes in
 * the tape toolbar, `bar` under the waveform (after the transport on a phone), `strip`
 * (the "Modificato" notice) under the tape head.
 * @param {{ waveform: object, player: object, getTrack: () => object|null, getFormat: () => string,
 *   canSave: () => boolean, isBusy: () => boolean,
 *   editState: () => { edited: boolean, sec: number, totalSec: number, busy: boolean },
 *   editProblem: (kind: 'keep'|'remove', sel: object|null) => string|null,
 *   applyEdit: (kind: 'keep'|'remove', sel: object) => boolean,
 *   resetEdit: () => void, focusUndo?: () => boolean,
 *   saveClip: (sel: object, opts: { fadeInSec: number, fadeOutSec: number, name: string }) => Promise<void> }} api
 * @returns {{ toggle: HTMLElement, bar: HTMLElement, strip: HTMLElement, refresh(): void, isOpen(): boolean,
 *   setOpen(on: boolean): void, getSelection(): object|null, setSelection(sel: object|null): void, destroy(): void }}
 */
export function createCutBar(api) {
  const { waveform, player } = api;
  let open = false;
  let sel = null;
  let loop = false;
  let nameTouched = false;
  let seen = { audio: null, id: null, lead: 0 };
  const hasRange = typeof player.playRange === 'function';

  // Toggle in the tape toolbar
  const toggle = h('button', { type: 'button', class: 'btn btn-ghost btn-sm cut-toggle', id: 'am-cut-toggle', 'aria-expanded': 'false', 'aria-controls': 'am-cut', 'i18n-title': 'cut.tip.toggle' }, svgIcon('scissors'), h('span', { i18n: 'cut.toggle' }));
  toggle.addEventListener('click', () => setOpen(!open));
  const toggleEl = withHelp(toggle, helpBtn('cut', 'cut.toggle'));

  // View: zoom and scroll
  const iconBtn = (id, name, labelKey, tipKey) => h('button', { type: 'button', class: 'btn btn-sm cut-icon', id, 'i18n-aria-label': labelKey, 'i18n-title': tipKey || labelKey }, svgIcon(name));
  const zoomOut = iconBtn('am-cut-zoom-out', 'minus', 'cut.zoomOut', 'cut.tip.zoom');
  const zoomIn = iconBtn('am-cut-zoom-in', 'plus', 'cut.zoomIn', 'cut.tip.zoom');
  const zoomAll = h('button', { type: 'button', class: 'btn btn-sm', id: 'am-cut-zoom-all', i18n: 'cut.zoomAll', 'i18n-title': 'cut.tip.zoomAll' });
  const zoomSel = h('button', { type: 'button', class: 'btn btn-sm', id: 'am-cut-zoom-sel', i18n: 'cut.zoomSel', 'i18n-title': 'cut.tip.zoomSel' });
  const scroll = h('input', { type: 'range', class: 'range-input cut-scroll', id: 'am-cut-scroll', min: '0', max: '1000', step: '1', value: '0', 'i18n-aria-label': 'cut.scroll' });
  zoomOut.addEventListener('click', () => waveform.zoomBy(2, focusSec()));
  zoomIn.addEventListener('click', () => waveform.zoomBy(0.5, focusSec()));
  zoomAll.addEventListener('click', () => waveform.setView(0, Infinity));
  zoomSel.addEventListener('click', () => {
    if (!sel) return;
    const pad = Math.max(0.05, (sel.end - sel.start) * 0.06);
    waveform.setView(sel.start - pad, sel.end + pad);
  });
  scroll.addEventListener('input', () => {
    const v = waveform.getView();
    const len = v.end - v.start;
    waveform.scrollTo((Number(scroll.value) / 1000) * Math.max(0, v.duration - len));
  });
  const viewRow = h('div', { class: 'cut-row cut-view', role: 'group', 'i18n-aria-label': 'cut.viewLabel' }, h('div', { class: 'cut-zoom' }, zoomOut, zoomIn, zoomAll, zoomSel, helpBtn('cut.zoom', 'cut.viewLabel')), scroll);

  // Selection: IN / OUT fields, nudges, from the playhead
  const howTo = h('p', { class: 'hint cut-howto', id: 'am-cut-howto', i18n: 'cut.howTo' });
  const edges = {};
  const edgeRow = (which) => {
    const isIn = which === 'start';
    const id = isIn ? 'am-cut-in' : 'am-cut-out';
    const errId = `${id}-err`;
    // No inputmode="decimal": the iOS decimal pad has no ':' for "1:23,500". The default
    // keyboard's number layer has both ':' and the decimal mark (plain seconds work too).
    const input = h('input', { type: 'text', class: 'cut-time', id, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': errId, 'i18n-title': isIn ? 'cut.tip.in' : 'cut.tip.out' });
    const err = h('p', { class: 'cut-err', id: errId, i18n: 'cut.invalid', hidden: true });
    const label = h('label', { class: 'lbl cut-edge-lbl', for: id, i18n: isIn ? 'cut.in' : 'cut.out' });
    const nudges = NUDGES.map((d) => {
      const b = h('button', { type: 'button', class: 'btn btn-sm cut-nudge', dataset: { delta: String(d) }, 'i18n-title': 'cut.tip.nudge', text: nudgeText(d) });
      b.addEventListener('click', () => nudge(which, d));
      return b;
    });
    const cursorBtn = h('button', { type: 'button', class: 'btn btn-sm cut-from', 'i18n-aria-label': isIn ? 'cut.fromCursorIn' : 'cut.fromCursorOut', 'i18n-title': 'cut.tip.fromCursor' }, h('span', { i18n: 'cut.fromCursor' }));
    cursorBtn.addEventListener('click', () => fromCursor(which));
    input.addEventListener('input', () => {
      edges[which].typing = true;
      const ok = input.value.trim() === '' || parseTimecode(input.value) !== null;
      flag(input, err, !ok);
    });
    input.addEventListener('change', () => {
      edges[which].typing = false;
      applyField(which);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        edges[which].typing = false;
        applyField(which);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        edges[which].typing = false;
        flag(input, err, false);
        renderFields(true);
      }
    });
    // typing: the user has unsaved keystrokes in the field; until then a focused field
    // still follows the selection (e.g. when a new trim shifts it), so blur never
    // re-applies a stale value
    edges[which] = { input, err, nudges, cursorBtn, typing: false };
    return h('div', { class: 'cut-edge' }, h('div', { class: 'cut-edge-main' }, label, input, cursorBtn), h('div', { class: 'cut-nudges', role: 'group', 'i18n-aria-label': isIn ? 'cut.nudgeInGroup' : 'cut.nudgeOutGroup' }, ...nudges), err);
  };
  const durEl = h('p', { class: 'cut-dur', 'aria-live': 'off' });
  const allBtn = h('button', { type: 'button', class: 'btn btn-sm', id: 'am-cut-all', i18n: 'cut.all', 'i18n-title': 'cut.tip.all' });
  allBtn.addEventListener('click', () => {
    const d = waveform.duration;
    if (d > 0) setSel({ start: 0, end: d });
  });
  const listenBtn = h('button', { type: 'button', class: 'btn btn-sm cut-listen', id: 'am-cut-listen', 'i18n-title': 'cut.tip.listen' });
  listenBtn.addEventListener('click', () => listen());
  const loopBtn = h('button', { type: 'button', class: 'btn btn-sm cut-loop', id: 'am-cut-loop', 'aria-pressed': 'false', 'i18n-title': 'cut.tip.loop' }, svgIcon('loop'), h('span', { i18n: 'cut.loop' }));
  loopBtn.addEventListener('click', () => toggleLoop());
  const selBlock = h(
    'div',
    { class: 'cut-sel', role: 'group', 'aria-labelledby': 'am-cut-sel-title' },
    h('div', { class: 'cut-sel-head' }, h('h3', { class: 'lbl', id: 'am-cut-sel-title', i18n: 'cut.selTitle' }), helpBtn('cut.selection', 'cut.selTitle'), durEl),
    howTo,
    h('div', { class: 'cut-edges' }, edgeRow('start'), edgeRow('end')),
    h('div', { class: 'cut-row cut-play' }, listenBtn, loopBtn, helpBtn('cut.listen', 'cut.listen'), allBtn),
  );

  // Action A: save the selection (a clip of the master)
  const fadeField = (id, labelKey, tipKey) => {
    const input = h('input', { type: 'text', class: 'cut-num', id, inputmode: 'decimal', autocomplete: 'off', value: formatNumber(DEFAULT_FADE_SEC, 2), 'aria-describedby': 'am-cut-fade-hint', 'i18n-title': tipKey });
    const f = { input, touched: false, el: h('div', { class: 'cut-field' }, h('label', { class: 'lbl lbl-sub', for: id, i18n: labelKey }), input) };
    input.addEventListener('input', () => {
      f.touched = true; // the user's own value: no longer re-localized
      input.setAttribute('aria-invalid', parseSeconds(input.value) === null ? 'true' : 'false');
    });
    return f;
  };
  const fadeIn = fadeField('am-cut-fade-in', 'cut.fadeIn', 'cut.tip.fade');
  const fadeOut = fadeField('am-cut-fade-out', 'cut.fadeOut', 'cut.tip.fade');
  const nameInput = h('input', { type: 'text', class: 'cut-name', id: 'am-cut-name', autocomplete: 'off', spellcheck: 'false', 'i18n-title': 'cut.tip.name' });
  const extEl = h('span', { class: 'cut-ext', 'aria-hidden': 'true' });
  nameInput.addEventListener('input', () => {
    nameTouched = nameInput.value.trim() !== '';
  });
  nameInput.addEventListener('blur', () => {
    if (!nameTouched) renderName(true);
  });
  const saveBtn = h('button', { type: 'button', class: 'btn btn-primary cut-save-btn', id: 'am-cut-save', 'i18n-title': 'cut.tip.save' }, svgIcon('save'), h('span', { i18n: 'cut.save' }));
  saveBtn.addEventListener('click', () => save());
  const saveWhy = h('p', { class: 'hint cut-why', id: 'am-cut-save-why' });
  const saveCard = h(
    'div',
    { class: 'cut-card cut-card-save', role: 'group', 'aria-labelledby': 'am-cut-save-title' },
    h('div', { class: 'cut-card-head' }, h('h3', { class: 'lbl', id: 'am-cut-save-title', i18n: 'cut.saveTitle' }), helpBtn('cut.save', 'cut.saveTitle')),
    h('p', { class: 'hint', i18n: 'cut.saveHint' }),
    // fades and file name have good defaults: folded so the card (and, on phones, the edit
    // card below it) stays short
    h(
      'details',
      { class: 'cut-opts' },
      h('summary', { class: 'cut-opts-sum', i18n: 'cut.options' }),
      h(
        'div',
        { class: 'cut-opts-body' },
        h('div', { class: 'cut-fades' }, fadeIn.el, fadeOut.el),
        h('p', { class: 'hint cut-small', id: 'am-cut-fade-hint', i18n: 'cut.fadeHint' }),
        h('div', { class: 'cut-field' }, h('label', { class: 'lbl lbl-sub', for: 'am-cut-name', i18n: 'cut.name' }), h('div', { class: 'cut-name-row' }, nameInput, extEl)),
      ),
    ),
    saveBtn,
    saveWhy,
  );
  saveBtn.setAttribute('aria-describedby', 'am-cut-save-why');

  // Action B: edit the song before mastering
  const keepBtn = h('button', { type: 'button', class: 'btn cut-edit-btn', id: 'am-cut-keep', 'aria-describedby': 'am-cut-edit-why', 'i18n-title': 'cut.tip.keep' }, h('span', { i18n: 'cut.keep' }));
  const removeBtn = h('button', { type: 'button', class: 'btn cut-edit-btn', id: 'am-cut-remove', 'aria-describedby': 'am-cut-edit-why', 'i18n-title': 'cut.tip.remove' }, h('span', { i18n: 'cut.remove' }));
  keepBtn.addEventListener('click', () => edit('keep'));
  removeBtn.addEventListener('click', () => edit('remove'));
  const editWhy = h('p', { class: 'hint cut-why', id: 'am-cut-edit-why' });
  // tabindex -1: after a cut its two buttons are off (no selection); on a phone, where the
  // header's Annulla is scrolled far away, focus stays here (moveFocus).
  const editCard = h(
    'div',
    { class: 'cut-card cut-card-edit', id: 'am-cut-edit', role: 'group', 'aria-labelledby': 'am-cut-edit-title', tabindex: '-1' },
    h('div', { class: 'cut-card-head' }, h('h3', { class: 'lbl', id: 'am-cut-edit-title', i18n: 'cut.editTitle' }), helpBtn('cut.edit', 'cut.editTitle')),
    h('p', { class: 'hint', i18n: 'cut.editHint' }),
    h('div', { class: 'cut-row cut-edit-row' }, keepBtn, removeBtn),
    editWhy,
  );

  const bar = h(
    'section',
    { class: 'cutbar', id: 'am-cut', 'i18n-aria-label': 'cut.region', hidden: true },
    h('div', { class: 'cut-grid' }, viewRow, selBlock, h('div', { class: 'cut-cards' }, saveCard, editCard), h('p', { class: 'keys-hint cut-keys', i18n: 'cut.keys' })),
  );

  // "Modificato" strip: shown whenever the song on screen is an edit, cut bar open or not.
  // Undoing a cut is the app's global Annulla (header, Ctrl/⌘+Z): no second undo here.
  const stripBadge = h('span', { class: 'badge badge-edit', i18n: 'cut.edited' });
  const stripInfo = h('span', { class: 'cut-strip-info' });
  const resetBtn = h('button', { type: 'button', class: 'btn-text', id: 'am-cut-reset', i18n: 'cut.reset', 'i18n-title': 'cut.tip.reset' });
  resetBtn.addEventListener('click', () => api.resetEdit());
  const strip = h('div', { class: 'cut-strip', id: 'am-edit-strip', hidden: true }, stripBadge, stripInfo, h('span', { class: 'cut-strip-actions' }, resetBtn));

  waveform.onSelect = (s, final) => setSel(s, { final, fromWave: true });
  waveform.onView = () => renderView();

  // --- behaviour ---------------------------------------------------------------------

  function focusSec() {
    if (sel) return (sel.start + sel.end) / 2;
    const t = Number(player.currentTime) || 0;
    const v = waveform.getView();
    return t >= v.start && t <= v.end ? t : (v.start + v.end) / 2;
  }

  function setOpen(on) {
    const v = !!on;
    if (v === open) return;
    open = v;
    bar.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('is-on', open);
    waveform.setCutMode(open);
    waveform.setSelection(open ? sel : null);
    if (open) waveform.canvas.setAttribute('aria-describedby', 'am-cut-howto');
    else {
      waveform.canvas.removeAttribute('aria-describedby');
      if (hasRange && player.range) player.clearRange();
    }
    refresh();
  }

  function clampSel(s) {
    const d = waveform.duration;
    if (!s || !(d > 0)) return null;
    const a = Math.max(0, Math.min(d, Math.min(s.start, s.end)));
    const b = Math.max(0, Math.min(d, Math.max(s.start, s.end)));
    return b - a >= MIN_SEL_SEC ? { start: a, end: b } : null;
  }

  /** New selection (null clears). final: the gesture or the edit is complete. */
  function setSel(s, { final = true, fromWave = false } = {}) {
    if (!final && fromWave) {
      sel = s ? { start: s.start, end: s.end } : null; // live drag: shown as is
    } else sel = clampSel(s);
    if (!fromWave || final) waveform.setSelection(sel);
    renderFields(false);
    renderName(false);
    renderButtons();
    if (final) syncRange();
  }

  /** A playing range follows the selection; a stale paused range is dropped. */
  function syncRange() {
    if (!hasRange || !player.range) return;
    if (!sel) player.clearRange();
    else if (player.playing) player.playRange(sel.start, sel.end, { loop, from: player.currentTime });
    else player.clearRange();
  }

  function edgeValue(which, v) {
    const d = waveform.duration;
    if (!(d > 0) || !Number.isFinite(v)) return null;
    const x = Math.max(0, Math.min(d, v));
    if (which === 'start') return sel && x < sel.end - MIN_SEL_SEC ? { start: x, end: sel.end } : { start: x, end: d };
    return sel && x > sel.start + MIN_SEL_SEC ? { start: sel.start, end: x } : { start: 0, end: x };
  }

  function fromCursor(which) {
    const s = edgeValue(which, Number(player.currentTime) || 0);
    if (s && s.end - s.start >= MIN_SEL_SEC) setSel(s);
  }

  function nudge(which, delta) {
    if (!sel) return;
    const d = waveform.duration;
    if (which === 'start') setSel({ start: Math.max(0, Math.min(sel.end - MIN_SEL_SEC, sel.start + delta)), end: sel.end });
    else setSel({ start: sel.start, end: Math.min(d, Math.max(sel.start + MIN_SEL_SEC, sel.end + delta)) });
  }

  function flag(input, err, bad) {
    input.setAttribute('aria-invalid', bad ? 'true' : 'false');
    err.hidden = !bad;
  }

  function applyField(which) {
    const { input, err } = edges[which];
    const raw = input.value.trim();
    if (!raw) {
      flag(input, err, false);
      renderFields(true);
      return;
    }
    const v = parseTimecode(raw);
    if (v === null) {
      flag(input, err, true);
      return;
    }
    flag(input, err, false);
    const s = edgeValue(which, v);
    if (s) setSel(s);
    renderFields(true);
  }

  async function listen() {
    if (!hasRange) return;
    if (player.range && player.playing) {
      player.pause();
      return;
    }
    if (!sel) return;
    try {
      await player.playRange(sel.start, sel.end, { loop });
    } catch (e) {
      console.error('range playback failed', e);
    }
    refresh();
  }

  function toggleLoop() {
    loop = !loop;
    loopBtn.setAttribute('aria-pressed', loop ? 'true' : 'false');
    if (!hasRange) return;
    if (player.range) player.setRangeLoop(loop);
    else if (loop && sel && player.playing) player.playRange(sel.start, sel.end, { loop: true, from: Number(player.currentTime) || 0 });
    refresh();
  }

  function readFade(input) {
    const v = parseSeconds(input.value);
    input.setAttribute('aria-invalid', v === null ? 'true' : 'false');
    return v;
  }

  async function save() {
    if (!sel || !api.canSave()) return;
    const fi = readFade(fadeIn.input);
    const fo = readFade(fadeOut.input);
    if (fi === null || fo === null) {
      (fi === null ? fadeIn.input : fadeOut.input).focus();
      return;
    }
    const tr = api.getTrack();
    const name = cleanName(nameInput.value) || clipFileName(trackBase(tr), sel.start, sel.end);
    await api.saveClip({ ...sel }, { fadeInSec: fi, fadeOutSec: fo, name });
    refresh();
  }

  function edit(kind) {
    if (!sel || api.editProblem(kind, sel)) return;
    const hadFocus = bar.contains(document.activeElement);
    if (api.applyEdit(kind, { ...sel })) {
      setSel(null);
      refresh();
      // The pressed button is now disabled (no selection): focus goes to the global
      // Annulla, which names this cut, so Enter takes it back at once; when it is out of
      // sight (phone: the bar sits after the transport), the edit card keeps the focus.
      if (hadFocus) moveFocus([editCard, toggle]);
    }
  }

  function trackBase(tr) {
    return tr ? (tr.info && tr.info.baseName) || tr.name : '';
  }

  // --- rendering -----------------------------------------------------------------------

  function renderView() {
    const v = waveform.getView();
    const len = v.end - v.start;
    const zoomed = v.duration > 0 && len < v.duration - 1e-6;
    scroll.disabled = !zoomed;
    scroll.value = String(zoomed ? Math.round((v.start / Math.max(1e-9, v.duration - len)) * 1000) : 0);
    scroll.style.setProperty('--fill', `${zoomed ? Math.round(((v.start + len / 2) / v.duration) * 1000) / 10 : 0}%`);
    scroll.setAttribute('aria-valuetext', `${formatTime(v.start, true)} – ${formatTime(v.end, true)}`);
    zoomOut.disabled = !zoomed;
    zoomAll.disabled = !zoomed;
    zoomIn.disabled = !(v.duration > 0) || len <= 0.05 + 1e-6;
    zoomSel.disabled = !sel;
  }

  function renderFields(force) {
    const lang = getLanguage();
    for (const which of ['start', 'end']) {
      const { input, err, nudges, cursorBtn, typing } = edges[which];
      if (force || document.activeElement !== input || !typing) {
        input.value = sel ? formatTimecode(sel[which], lang) : '';
        if (!force) flag(input, err, false);
      }
      input.placeholder = formatTimecode(0, lang);
      for (const b of nudges) {
        const d = Number(b.dataset.delta);
        b.textContent = nudgeText(d);
        b.disabled = !sel;
        b.setAttribute('aria-label', t(which === 'start' ? 'cut.nudgeIn' : 'cut.nudgeOut', { delta: `${d > 0 ? '+' : '−'}${formatNumber(Math.abs(d), Math.abs(d) >= 1 ? 0 : 1)}` }));
      }
      cursorBtn.disabled = !(waveform.duration > 0);
    }
    durEl.textContent = sel ? t('cut.duration', { time: formatTimecode(sel.end - sel.start, lang) }) : t('cut.none');
    // Fades the user has not edited follow the language's decimal mark ("0,01" / "0.01").
    for (const f of [fadeIn, fadeOut]) {
      if (!f.touched && document.activeElement !== f.input) {
        f.input.value = formatNumber(DEFAULT_FADE_SEC, 2);
        f.input.setAttribute('aria-invalid', 'false');
      }
    }
  }

  function renderName(force) {
    const tr = api.getTrack();
    if (!nameTouched || force) {
      if (document.activeElement !== nameInput || force) nameInput.value = sel && tr ? clipFileName(trackBase(tr), sel.start, sel.end) : '';
    }
    nameInput.placeholder = tr ? clipFileName(trackBase(tr), 0, waveform.duration) : '';
    extEl.textContent = api.getFormat() === 'mp3' ? '.mp3' : '.wav';
  }

  function whyText(kind, problem) {
    if (!problem) return '';
    if (problem === 'tiny') return t('cut.why.tiny', { sec: formatNumber(MIN_SELECTION_SEC, 2) });
    if (problem === 'tooShort') return t('cut.why.tooShort', { sec: formatNumber(MIN_RESULT_SEC, 0) });
    if (problem === 'noop') return t(kind === 'keep' ? 'cut.why.noop' : 'cut.why.tooShort', { sec: formatNumber(MIN_RESULT_SEC, 0) });
    if (problem === 'busy') return t('cut.why.busy');
    return '';
  }

  function renderButtons() {
    const busy = api.isBusy();
    const playingRange = hasRange && !!player.range && !!player.playing;
    clear(listenBtn).append(svgIcon(playingRange ? 'stop' : 'play'), h('span', { text: t(playingRange ? 'cut.stop' : 'cut.listen') }));
    listenBtn.disabled = !hasRange || (!sel && !playingRange);
    loopBtn.disabled = !hasRange;
    allBtn.disabled = !(waveform.duration > 0);
    zoomSel.disabled = !sel;
    // Save
    const canSave = api.canSave();
    saveBtn.disabled = !sel || !canSave;
    saveWhy.textContent = !sel ? t('cut.needSel') : busy ? t('export.working') : !canSave ? t('cut.why.saveOff') : '';
    saveWhy.hidden = !saveWhy.textContent;
    // Edit
    const pk = sel ? api.editProblem('keep', sel) : 'none';
    const pr = sel ? api.editProblem('remove', sel) : 'none';
    keepBtn.disabled = !!pk;
    removeBtn.disabled = !!pr;
    let why = '';
    if (!sel) why = t('cut.needSel');
    else if (pk === 'busy' || pr === 'busy') why = t('cut.why.busy');
    else {
      const a = whyText('keep', pk);
      const b = whyText('remove', pr);
      why = a && b && a !== b ? `${a} ${b}` : a || b;
    }
    editWhy.textContent = why;
    editWhy.hidden = !why;
  }

  function renderStrip() {
    const st = api.editState();
    strip.hidden = !st.edited;
    stripInfo.textContent = st.edited ? t('cut.editedInfo', { time: formatTime(st.sec), total: formatTime(st.totalSec) }) : '';
    resetBtn.disabled = !!st.busy;
  }

  /**
   * Focus after an edit or a reset took the focused control away, always on something in
   * sight (WCAG 2.4.7 / 2.4.11): the global Annulla when it is on screen (api.focusUndo
   * declines otherwise), else the first of `places` on screen (where the user was), else
   * the first one, scrolled into view.
   * @param {HTMLElement[]} places
   */
  function moveFocus(places) {
    if (api.focusUndo && api.focusUndo()) return;
    const usable = places.filter((el) => el && !el.disabled && el.getClientRects().length && !(el === editCard && !open));
    const inSight = usable.find(inView);
    if (inSight) inSight.focus({ preventScroll: true });
    else if (usable[0]) usable[0].focus();
  }

  /** The focused strip control went away (strip hidden with the edit): never leave focus on <body>. */
  function keepStripFocus(f) {
    if (!f || !strip.hidden) return;
    moveFocus([toggle, editCard]);
  }

  /** Re-sync with the app (track, timeline, export state, language). Cheap: call freely. */
  function refresh() {
    const focused = strip.contains(document.activeElement) ? document.activeElement : null;
    const tr = api.getTrack();
    const audio = tr && tr.audio ? tr.audio : null;
    const id = tr ? tr.id : null;
    const lead = waveform.lead;
    if (audio !== seen.audio || id !== seen.id) {
      // Another song, or this one was edited: the old selection points at other music.
      seen = { audio, id, lead };
      sel = null;
      nameTouched = false;
      nameInput.value = '';
      waveform.setSelection(null);
      waveform.setView(0, Infinity);
      if (hasRange && player.range) player.clearRange();
    } else if (Math.abs(lead - seen.lead) > 1e-9) {
      // The master's trim moved the timeline: keep the selection on the same music (a
      // zoomed view follows it in Waveform.setAudio).
      const shift = seen.lead - lead;
      seen.lead = lead;
      if (sel) {
        sel = clampSel({ start: sel.start + shift, end: sel.end + shift });
        waveform.setSelection(open ? sel : null);
      }
    }
    toggle.disabled = !audio;
    if (!audio && open) setOpen(false);
    renderStrip();
    if (open) {
      renderView();
      renderFields(false);
      renderName(false);
      renderButtons();
    }
    keepStripFocus(focused);
  }

  function onKey(e) {
    if (!open || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (!cutKeyAllowed(e.target)) return;
    const k = e.key;
    if (k === 'i' || k === 'I') fromCursor('start');
    else if (k === 'o' || k === 'O') fromCursor('end');
    else if (k === 'l' || k === 'L') toggleLoop();
    else if (k === 'Escape' && sel) setSel(null);
    else return;
    e.preventDefault();
  }
  window.addEventListener('keydown', onKey);

  refresh();

  return {
    toggle: toggleEl,
    bar,
    strip,
    refresh,
    isOpen: () => open,
    setOpen,
    getSelection: () => (sel ? { ...sel } : null),
    setSelection: (s) => setSel(s),
    destroy() {
      window.removeEventListener('keydown', onKey);
      waveform.onSelect = null;
      waveform.onView = null;
    },
  };
}
