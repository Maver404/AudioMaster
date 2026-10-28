// Contextual help: a small (i) button beside a control's label opens ONE shared card with
// what the control does ("Cosa fa"), when to use it, a concrete example and, where useful,
// its values and what the automatic setting does. Wide screens with a fine pointer get a
// popover anchored to the button; phones and touch screens get a bottom sheet. One card at
// a time; Esc, a click outside, Tab past its end or scrolling the button out of view close
// it, and focus goes back to the button. Hovering the button with a mouse shows the first
// line as a tooltip after HOVER_MS; the full card opens on click / tap / Enter.
// Texts live in i18n.js as help.<id>.what / .when / .example (+ optional .range). A group
// (destination, character, cleanup, …) has an intro (help.<id>.what) and one entry per
// option, shown as tabs inside the card. Advanced-panel controls are looked up by labelKey
// (advancedHelpId), so a new or renamed control simply gets no button until its text
// exists (tests/help.test.mjs reports it). Nothing touches the DOM at import time.
import { t, STRINGS, onLanguageChange } from './i18n.js';
import { h, clear, icon } from './controls.js';

const POP_ID = 'am-help-pop';
const HOVER_MS = 400;
const LS_HINT = 'am.helpHint';
const PARTS = ['what', 'when', 'example'];
const EXPORT_FORMATS = ['wav24', 'wav16', 'mp3'];
const LEGEND = ['live', 'original', 'master', 'eq'];

const opts = (prefix, ids) => (ids || []).map((id) => ({ id: `${prefix}.${id}`, label: `${prefix}.${id}` }));

/**
 * Help topics placed by the UI (src/ui/app.js, src/ui/meters.js). `label` is the i18n key
 * (or a function returning the text) naming the control in the button's aria-label and
 * the card title; `options(P)` lists the entries of a group (P = params.js exports).
 * Advanced-panel controls are not listed here: see advancedHelpId().
 */
export const HELP_TOPICS = {
  'choice.destination': { label: 'choice.destination', options: (P) => opts('dest', P.DESTINATION_IDS) },
  'choice.character': { label: 'choice.character', options: (P) => opts('style', P.STYLE_IDS) },
  'choice.intensity': { label: 'choice.intensity' },
  'choice.cleanup': { label: 'choice.cleanup', options: (P) => opts('cleanup', P.CLEANUP_IDS) },
  'problems.title': { label: 'problems.title', options: (P) => opts('problem', P.PROBLEM_IDS) },
  ab: { label: () => `${t('ab.original')} / ${t('ab.master')}` },
  'ab.match': { label: 'ab.match' },
  'wave.curve': { label: 'wave.curve' },
  tracks: { label: 'drop.add' },
  'export.format': { label: 'export.format', options: () => opts('export', EXPORT_FORMATS) },
  'export.rate': { label: 'export.rate' },
  'export.download': { label: 'export.download' },
  'export.all': { label: 'export.all' },
  ref: { label: 'ref.title' },
  'meters.lufs': { label: 'meters.lufs' },
  'meters.tp': { label: 'meters.tp' },
  'meters.lra': { label: 'meters.lra' },
  'meters.plr': { label: 'meters.plr' },
  'meters.gr': { label: 'meters.gr' },
  'meters.live': { label: 'meters.live' },
  'spectrum.legend': { label: 'spectrum.title', options: () => opts('spectrum', LEGEND) },
  platforms: { label: 'platforms.title' },
  history: { label: () => `${t('history.undo')} / ${t('history.redo')}` },
  meta: { label: 'meta.title' },
  'meta.keep': { label: 'meta.keep' },
  // Cut tool (cut.js passes its own label keys).
  cut: { label: 'cut.toggle' },
  'cut.zoom': { label: 'cut.viewLabel' },
  'cut.selection': { label: 'cut.selTitle' },
  'cut.listen': { label: 'cut.listen' },
  'cut.save': { label: 'cut.saveTitle' },
  'cut.edit': { label: 'cut.editTitle' },
};

/** Advanced controls whose help lives under another id (the sample rate's home is the export panel). */
export const ADV_HELP_ALIAS = { 'output.sampleRate': 'export.rate' };

/** Whether help.<id>.<part> exists and is not empty (Italian is the reference language). */
export function hasHelpText(id, part = 'what') {
  const s = STRINGS.it[`help.${id}.${part}`];
  return typeof s === 'string' && s.trim() !== '';
}

/** A complete entry: what + when + example. */
export function hasHelpEntry(id) {
  return PARTS.every((p) => hasHelpText(id, p));
}

/** Options of a group topic ([{ id, label }]), [] when P lacks the list, null for a single topic. */
export function topicOptions(id, P) {
  const tp = HELP_TOPICS[id];
  if (!tp || !tp.options) return null;
  try {
    return tp.options(P || {}) || [];
  } catch {
    return [];
  }
}

function parentToggle(ctl, sections) {
  if (!ctl || !ctl.dependsOn) return null;
  for (const s of sections || []) for (const c of s.controls || []) if (c.path === ctl.dependsOn && c.type === 'toggle') return c;
  return null;
}

/**
 * Help id of an ADVANCED_SECTIONS section (`ctl` null) or control, or null when no text
 * exists. A control is looked up as <parent toggle labelKey>.<own label> first (generic
 * labels such as adv.amount / adv.maxCut mean something different under each toggle),
 * then by its own labelKey.
 * @param {{ labelKey: string }} sec
 * @param {{ path: string, labelKey: string, dependsOn?: string }|null} ctl
 * @param {object[]} sections the full ADVANCED_SECTIONS (to find parent toggles)
 * @returns {string|null}
 */
export function advancedHelpId(sec, ctl, sections) {
  if (!ctl) return sec && sec.labelKey && hasHelpEntry(sec.labelKey) ? sec.labelKey : null;
  const parent = parentToggle(ctl, sections);
  const own = String(ctl.labelKey || '');
  const cands = [ADV_HELP_ALIAS[ctl.path], parent && own ? `${parent.labelKey}.${own.replace(/^adv\./, '')}` : null, own];
  return cands.find((id) => id && hasHelpEntry(id)) || null;
}

/** Every help id the UI can show for these params: full entries and group intros. */
export function helpIdsInUse(P) {
  const full = new Set();
  const intro = new Set();
  for (const id of Object.keys(HELP_TOPICS)) {
    const o = topicOptions(id, P);
    if (o) {
      intro.add(id);
      for (const x of o) full.add(x.id);
    } else full.add(id);
  }
  for (const sec of P.ADVANCED_SECTIONS || []) {
    const s = advancedHelpId(sec, null, P.ADVANCED_SECTIONS);
    if (s) full.add(s);
    for (const c of sec.controls || []) {
      const id = advancedHelpId(sec, c, P.ADVANCED_SECTIONS);
      if (id) full.add(id);
    }
  }
  return { full, intro };
}

// --- DOM ------------------------------------------------------------------------------

const entries = new WeakMap(); // help button → { id, labelOf, options, current }
const cur = { btn: null, entry: null, sel: null };
let pop = null;
let tip = null;
let tipTimer = 0;
let raf = 0;
let langHooked = false;

const canPopover = () => typeof HTMLElement !== 'undefined' && typeof HTMLElement.prototype.showPopover === 'function';
const media = (q) => {
  try {
    return !!(globalThis.matchMedia && globalThis.matchMedia(q).matches);
  } catch {
    return false;
  }
};
const sheetMode = () => media('(pointer: coarse), (max-width: 520px)');

function hookLanguage() {
  if (langHooked) return;
  langHooked = true;
  onLanguageChange(() => {
    for (const b of document.querySelectorAll('.help-btn')) {
      const e = entries.get(b);
      if (e) b.setAttribute('aria-label', t('help.ui.button', { label: e.labelOf() }));
    }
    hideTip();
    if (cur.btn) {
      render();
      position();
    }
  });
}

function show(el) {
  if (canPopover()) {
    try {
      if (!el.matches(':popover-open')) el.showPopover();
      return;
    } catch {
      /* not connected or not a popover: fall through */
    }
  }
  el.hidden = false;
}

function hide(el) {
  if (canPopover()) {
    try {
      if (el.matches(':popover-open')) el.hidePopover();
    } catch {
      /* already hidden */
    }
  }
  if (!canPopover()) el.hidden = true;
}

function ensurePop() {
  if (pop) return pop;
  const el = h('div', { id: POP_ID, class: 'help-pop', role: 'dialog', 'aria-modal': 'false', tabindex: '-1', 'aria-labelledby': `${POP_ID}-title` });
  if (canPopover()) el.setAttribute('popover', 'manual');
  else el.hidden = true;
  const title = h('p', { class: 'help-title', id: `${POP_ID}-title` });
  const close = h('button', { type: 'button', class: 'help-close' }, icon('close'));
  const body = h('div', { class: 'help-body' });
  el.append(h('div', { class: 'help-head' }, title, close), body);
  close.addEventListener('click', () => closeHelp(true));
  el.addEventListener('keydown', onPopKey);
  document.body.append(el);
  pop = { el, title, close, body };
  return pop;
}

function ensureTip() {
  if (tip) return tip;
  tip = h('div', { class: 'help-tip', 'aria-hidden': 'true' });
  if (canPopover()) tip.setAttribute('popover', 'manual');
  else tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function entryList(id) {
  const dl = h('dl', { class: 'help-dl' });
  const row = (labelKey, part, cls = '') => {
    if (!hasHelpText(id, part)) return;
    dl.append(h('div', { class: `help-row ${cls}`.trim() }, h('dt', { text: t(labelKey) }), h('dd', { text: t(`help.${id}.${part}`) })));
  };
  row('help.ui.what', 'what');
  row('help.ui.when', 'when');
  row('help.ui.example', 'example', 'is-example');
  row('help.ui.range', 'range', 'is-range');
  return dl;
}

function tabId(optId) {
  return `${POP_ID}-tab-${String(optId).replace(/[^\w-]/g, '-')}`;
}

function render() {
  const e = cur.entry;
  if (!e || !pop) return;
  pop.title.textContent = e.labelOf();
  pop.close.setAttribute('aria-label', t('help.ui.close'));
  clear(pop.body);
  if (!e.options) {
    pop.body.append(entryList(e.id));
    return;
  }
  const list = h('div', { class: 'help-tabs', role: 'tablist', 'aria-label': t('help.ui.options') });
  const panel = h('div', { class: 'help-panel', role: 'tabpanel', id: `${POP_ID}-panel`, 'aria-labelledby': tabId(cur.sel) });
  for (const o of e.options) {
    const on = o.id === cur.sel;
    const b = h('button', { type: 'button', role: 'tab', class: 'help-tab', id: tabId(o.id), 'aria-selected': on ? 'true' : 'false', 'aria-controls': panel.id, tabindex: on ? '0' : '-1', text: t(o.label) });
    b.addEventListener('click', () => selectOption(o.id));
    list.append(b);
  }
  panel.append(entryList(cur.sel));
  pop.body.append(h('p', { class: 'help-intro', text: t(`help.${e.id}.what`) }), list, panel);
}

function selectOption(id) {
  if (!cur.entry || !cur.entry.options || !cur.entry.options.some((o) => o.id === id)) return;
  cur.sel = id;
  render();
  position();
  const b = document.getElementById(tabId(id));
  if (b) b.focus();
}

/** Place the card next to its button (popover) or at the bottom of the screen (sheet). */
function position() {
  if (!cur.btn || !pop) return;
  const btn = cur.btn;
  if (!btn.isConnected || !pop.el.isConnected || !btn.getClientRects().length) {
    closeHelp(false);
    return;
  }
  const sheet = sheetMode();
  pop.el.classList.toggle('is-sheet', sheet);
  const s = pop.el.style;
  if (sheet) {
    s.left = '';
    s.top = '';
    return;
  }
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || globalThis.innerWidth;
  const vh = globalThis.innerHeight || document.documentElement.clientHeight;
  // The button scrolled out of view: the card would float over unrelated controls.
  if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) {
    closeHelp(pop.el.contains(document.activeElement));
    return;
  }
  const M = 8;
  const G = 6;
  const w = pop.el.offsetWidth;
  const ph = pop.el.offsetHeight;
  const left = Math.max(M, Math.min(r.left + r.width / 2 - 26, vw - w - M));
  let top = r.bottom + G;
  if (top + ph > vh - M) top = r.top - G - ph >= M ? r.top - G - ph : Math.max(M, vh - M - ph);
  s.left = `${Math.round(left)}px`;
  s.top = `${Math.round(top)}px`;
}

function onViewport() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    position();
  });
}

function onDocPointer(e) {
  if (!cur.btn || !pop) return;
  const target = e.target;
  if (cur.btn.contains(target)) return; // the button's own click toggles the card
  if (target === pop.el) {
    // The sheet's ::backdrop reports the popover itself as the target.
    const r = pop.el.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
  } else if (pop.el.contains(target)) return;
  closeHelp(false);
}

function onDocKey(e) {
  if (e.key !== 'Escape' || !cur.btn) return;
  // Esc belongs to the card while it is open (the cut bar also listens for it).
  e.preventDefault();
  e.stopPropagation();
  closeHelp(pop.el.contains(document.activeElement) || document.activeElement === cur.btn);
}

function focusables() {
  return [...pop.el.querySelectorAll('button')].filter((b) => b.tabIndex >= 0 && !b.disabled);
}

function onPopKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeHelp(true);
    return;
  }
  const a = document.activeElement;
  if (e.key === 'Tab') {
    // Non-modal: tabbing past either end leaves the card and returns to its button.
    const f = focusables();
    if ((!e.shiftKey && a === f[f.length - 1]) || (e.shiftKey && (a === f[0] || a === pop.el))) {
      e.preventDefault();
      closeHelp(true);
    }
    return;
  }
  if (a && a.getAttribute('role') === 'tab' && cur.entry && cur.entry.options) {
    const ids = cur.entry.options.map((o) => o.id);
    const i = ids.indexOf(cur.sel);
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % ids.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = ids.length - 1;
    if (j !== null) {
      e.preventDefault();
      selectOption(ids[j]);
      return;
    }
  }
  // Keep the page's single-key shortcuts (window keydown: Space, B, the cut bar's I / O / L)
  // from acting behind the card; modified keys (browser shortcuts) pass.
  if (e.key && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
}

function listen(on) {
  const f = on ? 'addEventListener' : 'removeEventListener';
  document[f]('pointerdown', onDocPointer, true);
  document[f]('keydown', onDocKey, true);
  globalThis[f]('scroll', onViewport, true);
  globalThis[f]('resize', onViewport);
}

function openHelp(btn) {
  const e = entries.get(btn);
  if (!e) return;
  hideTip();
  if (cur.btn) closeHelp(false);
  const p = ensurePop();
  // Inside the app root so its tokens, resets and reduced-motion rules apply.
  const home = btn.closest('.am-root') || document.body;
  if (p.el.parentElement !== home) home.append(p.el);
  cur.btn = btn;
  cur.entry = e;
  let sel = null;
  if (e.options) {
    let want = null;
    try {
      want = e.current ? e.current() : null;
    } catch {
      want = null;
    }
    sel = e.options.some((o) => o.id === want) ? want : e.options[0].id;
  }
  cur.sel = sel;
  render();
  btn.setAttribute('aria-expanded', 'true');
  p.el.classList.toggle('is-sheet', sheetMode());
  show(p.el);
  position();
  if (!cur.btn) return; // position() closed it (button not visible)
  listen(true);
  p.el.focus({ preventScroll: true });
}

/**
 * Close the open card (if any).
 * @param {boolean} [returnFocus] move focus back to its button
 */
export function closeHelp(returnFocus = false) {
  const btn = cur.btn;
  if (!btn) return;
  cur.btn = null;
  cur.entry = null;
  cur.sel = null;
  btn.setAttribute('aria-expanded', 'false');
  if (pop) hide(pop.el);
  listen(false);
  if (returnFocus && btn.isConnected) btn.focus({ preventScroll: true });
}

function showTip(btn) {
  const e = entries.get(btn);
  if (!e || cur.btn === btn || !btn.isConnected) return;
  const el = ensureTip();
  const home = btn.closest('.am-root') || document.body;
  if (el.parentElement !== home) home.append(el);
  el.textContent = t(`help.${e.id}.what`);
  show(el);
  const r = btn.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || globalThis.innerWidth;
  const w = el.offsetWidth;
  const th = el.offsetHeight;
  let top = r.top - 6 - th;
  if (top < 8) top = r.bottom + 6;
  el.style.left = `${Math.round(Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8)))}px`;
  el.style.top = `${Math.round(top)}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = 0;
  if (tip) hide(tip);
}

/**
 * The (i) button for a help topic, or null when its text does not exist (yet).
 * @param {string} id a HELP_TOPICS id, or an advanced id with `label`
 * @param {{ P?: object, label?: string|(() => string), current?: () => string }} [o]
 *   P: params.js exports (group options); label: i18n key or text function naming the
 *   control; current: id of the option to show first (e.g. the selected destination)
 * @returns {HTMLButtonElement|null}
 */
export function helpButton(id, { P, label, current } = {}) {
  if (typeof document === 'undefined') return null;
  const topic = HELP_TOPICS[id];
  const all = topicOptions(id, P);
  const options = all ? all.filter((o) => hasHelpEntry(o.id)) : null;
  if (options ? !(options.length && hasHelpText(id, 'what')) : !hasHelpEntry(id)) return null;
  hookLanguage();
  const lab = label ?? (topic && topic.label) ?? id;
  const labelOf = typeof lab === 'function' ? lab : () => t(lab);
  ensurePop();
  const btn = h('button', { type: 'button', class: 'help-btn', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': POP_ID, dataset: { helpId: id } }, icon('info'));
  btn.setAttribute('aria-label', t('help.ui.button', { label: labelOf() }));
  entries.set(btn, { id, labelOf, options, current });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (cur.btn === btn) closeHelp(true);
    else openHelp(btn);
  });
  btn.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || cur.btn === btn || !media('(hover: hover) and (pointer: fine)')) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(btn), HOVER_MS);
  });
  btn.addEventListener('pointerleave', hideTip);
  btn.addEventListener('pointerdown', hideTip);
  return btn;
}

/**
 * The (i) button of an Advanced-panel section (`ctl` null) or control, or null.
 * A control under a switch is named "<switch> · <control>" ("Calore analogico · Quantità").
 */
export function advancedHelp(sec, ctl, sections) {
  const id = advancedHelpId(sec, ctl, sections);
  if (!id) return null;
  const parent = parentToggle(ctl, sections);
  const label = !ctl ? sec.labelKey : parent ? () => `${t(parent.labelKey)} · ${t(ctl.labelKey)}` : ctl.labelKey;
  return helpButton(id, { label });
}

/** `el` and its help button side by side (just `el` without a button). */
export function withHelp(el, helpEl, className = '') {
  if (!helpEl) return el;
  return h('div', { class: `help-pair ${className}`.trim() }, el, helpEl);
}

function hintDismissed() {
  try {
    return globalThis.localStorage?.getItem(LS_HINT) === '1';
  } catch {
    return false;
  }
}

/**
 * One-time tip under the Advanced heading ("Tocca (i) accanto a ogni comando…"); null once
 * dismissed (remembered in localStorage when it is available).
 * @returns {HTMLElement|null}
 */
export function advancedHint() {
  if (typeof document === 'undefined' || hintDismissed()) return null;
  const close = h('button', { type: 'button', class: 'btn-text help-hint-close', i18n: 'help.ui.hintClose' });
  const el = h('div', { class: 'help-hint', role: 'note' }, icon('info'), h('p', { class: 'help-hint-text', i18n: 'help.ui.hint' }), close);
  close.addEventListener('click', () => {
    try {
      globalThis.localStorage?.setItem(LS_HINT, '1');
    } catch {
      /* storage blocked: the tip just comes back next time */
    }
    // The button disappears with the tip: keep keyboard focus on the panel's heading.
    const summary = el.closest('details')?.querySelector('summary');
    el.remove();
    if (summary) summary.focus();
  });
  return el;
}
