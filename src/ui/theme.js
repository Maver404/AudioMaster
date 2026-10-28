// Interface skins ("Tema"): Automatico, Scuro, Chiaro, Fluo Techno, Analogico, Synthwave,
// Alto contrasto.
//
// Every color in the app is a CSS custom property (src/ui/styles.css). A skin is a full set
// of those color tokens, injected once as <style id="am-skins"> with one rule per skin:
//     html:root[data-am-skin="fluo"] { color-scheme: dark; --bg: …; … }
// (specificity 0,2,1: it beats `:root`, `:root[data-theme]` and the prefers-color-scheme
// block of styles.css whatever the order of the stylesheets, which an embedding host does
// not guarantee). 'auto' removes the attribute, so the page follows the host's data-theme /
// prefers-color-scheme exactly as before skins existed.
// setSkin() also swaps an `am-skin-<id>` class on <html>: the app's MutationObserver
// (attributeFilter ['data-theme', 'class']) then repaints the canvases, which read the
// tokens through getComputedStyle.
// The dark / light palettes here must equal styles.css (tests/theme.test.mjs fails on
// drift); every palette passes the WCAG checks of that test.
// Environment-neutral on import (Node tests import it): browser globals are touched only
// inside functions, behind guards and try/catch.

import { t as i18nT, onLanguageChange } from './i18n.js';

const STORAGE_KEY = 'am.skin';
const STYLE_ID = 'am-skins';
const CLASS_PREFIX = 'am-skin-';

/** Color tokens every skin defines (fonts and radii stay in styles.css). */
export const COLOR_TOKENS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--well', '--line', '--line-strong', '--grid',
  '--fg', '--fg-2', '--fg-3',
  '--accent', '--accent-hi', '--accent-ink', '--accent-soft', '--accent-text', '--on-lane',
  '--master', '--master-soft', '--orig', '--orig-soft',
  '--good', '--warn', '--crit', '--info', '--led-off',
  '--wave-dim', '--wave-ghost', '--glow', '--toast-shadow',
];

/**
 * Full palettes: { scheme: 'dark'|'light', tokens: { '--bg': …, … } }.
 * 'dark' and 'light' are copies of styles.css (kept in sync by a test).
 */
export const PALETTES = {
  dark: {
    scheme: 'dark',
    tokens: {
      '--bg': '#0c0f13',
      '--surface': '#13181f',
      '--surface-2': '#19202a',
      '--surface-3': '#222b36',
      '--well': '#080b0e',
      '--line': '#232c37',
      '--line-strong': '#344152',
      '--grid': 'rgba(150, 175, 210, 0.08)',
      '--fg': '#e2e7ee',
      '--fg-2': '#a6b0be',
      '--fg-3': '#8a95a6',
      '--accent': '#f2a33a',
      '--accent-hi': '#ffbe60',
      '--accent-ink': '#1c1203',
      '--accent-soft': 'rgba(242, 163, 58, 0.14)',
      '--accent-text': '#f2a33a',
      '--on-lane': '#080b0e',
      '--master': '#39c9b3',
      '--master-soft': 'rgba(57, 201, 179, 0.16)',
      '--orig': '#8f99ab',
      '--orig-soft': 'rgba(143, 153, 171, 0.15)',
      '--good': '#5fc37f',
      '--warn': '#dcc24b',
      '--crit': '#f0625b',
      '--info': '#7e9dc9',
      '--led-off': '#2b3440',
      '--wave-dim': '0.42',
      '--wave-ghost': '0.22',
      '--glow': '0 0 7px',
      '--toast-shadow': '0 10px 30px rgba(0, 0, 0, 0.45)',
    },
  },
  light: {
    scheme: 'light',
    tokens: {
      '--bg': '#e6eaef',
      '--surface': '#f5f7f9',
      '--surface-2': '#ffffff',
      '--surface-3': '#e3e8ee',
      '--well': '#dce2e9',
      '--line': '#cdd5df',
      '--line-strong': '#aab6c4',
      '--grid': 'rgba(40, 60, 95, 0.09)',
      '--fg': '#111821',
      '--fg-2': '#434e5c',
      '--fg-3': '#566170',
      '--accent': '#ad5c06',
      '--accent-hi': '#924c03',
      '--accent-ink': '#fff8ef',
      '--accent-soft': 'rgba(173, 92, 6, 0.12)',
      '--accent-text': '#924c03',
      '--on-lane': '#ffffff',
      '--master': '#077c6b',
      '--master-soft': 'rgba(7, 124, 107, 0.14)',
      '--orig': '#5b6677',
      '--orig-soft': 'rgba(91, 102, 119, 0.15)',
      '--good': '#237a3f',
      '--warn': '#8a6d00',
      '--crit': '#c2372e',
      '--info': '#3a64a1',
      '--led-off': '#c3ccd7',
      '--wave-dim': '0.58',
      '--wave-ghost': '0.34',
      '--glow': '0 0 0',
      '--toast-shadow': '0 10px 28px rgba(30, 45, 70, 0.18)',
    },
  },
  // Fluo Techno: green-black club console; acid-lime actions, cyan master, magenta original.
  fluo: {
    scheme: 'dark',
    tokens: {
      '--bg': '#050706',
      '--surface': '#0b0e0d',
      '--surface-2': '#111614',
      '--surface-3': '#18201c',
      '--well': '#000000',
      '--line': '#1c2520',
      '--line-strong': '#2f3d36',
      '--grid': 'rgba(150, 255, 60, 0.08)',
      '--fg': '#effaf1',
      '--fg-2': '#b0bfb5',
      '--fg-3': '#8c9c92',
      '--accent': '#b6ff2e',
      '--accent-hi': '#d4ff7a',
      '--accent-ink': '#0b1400',
      '--accent-soft': 'rgba(182, 255, 46, 0.14)',
      '--accent-text': '#b6ff2e',
      '--on-lane': '#000000',
      '--master': '#20e3ff',
      '--master-soft': 'rgba(32, 227, 255, 0.16)',
      '--orig': '#ff4fd8',
      '--orig-soft': 'rgba(255, 79, 216, 0.15)',
      '--good': '#2dff9a',
      '--warn': '#ffae1a',
      '--crit': '#ff4433',
      '--info': '#9b8cff',
      '--led-off': '#1c2520',
      '--wave-dim': '0.4',
      '--wave-ghost': '0.22',
      '--glow': '0 0 12px',
      '--toast-shadow': '0 0 0 1px rgba(182, 255, 46, 0.2), 0 12px 32px rgba(0, 0, 0, 0.7)',
    },
  },
  // Analogico: 70s control room. Walnut and cream, amber VU light, oxide-brown original
  // tape; the master keeps the app's teal code as an aged sea-foam.
  analog: {
    scheme: 'dark',
    tokens: {
      '--bg': '#1b140e',
      '--surface': '#251b13',
      '--surface-2': '#2f2319',
      '--surface-3': '#3b2d20',
      '--well': '#120d08',
      '--line': '#3b2d20',
      '--line-strong': '#5c4733',
      '--grid': 'rgba(240, 210, 160, 0.08)',
      '--fg': '#f2e6cf',
      '--fg-2': '#d1be9e',
      '--fg-3': '#b39d7c',
      '--accent': '#ffab3a',
      '--accent-hi': '#ffc56e',
      '--accent-ink': '#201306',
      '--accent-soft': 'rgba(255, 171, 58, 0.15)',
      '--accent-text': '#ffab3a',
      '--on-lane': '#1a110a',
      '--master': '#7fc6ae',
      '--master-soft': 'rgba(127, 198, 174, 0.16)',
      '--orig': '#c0835a',
      '--orig-soft': 'rgba(192, 131, 90, 0.16)',
      '--good': '#9cc46a',
      '--warn': '#e6d25c',
      '--crit': '#ef5f45',
      '--info': '#8fb2c4',
      '--led-off': '#3b2d21',
      '--wave-dim': '0.45',
      '--wave-ghost': '0.24',
      '--glow': '0 0 9px',
      '--toast-shadow': '0 10px 30px rgba(0, 0, 0, 0.55)',
    },
  },
  // Synthwave: indigo night, hot-pink actions, cyan master, lavender original, pink grid.
  synthwave: {
    scheme: 'dark',
    tokens: {
      '--bg': '#120a24',
      '--surface': '#1a1033',
      '--surface-2': '#22163f',
      '--surface-3': '#2e1f53',
      '--well': '#0b0619',
      '--line': '#2f2254',
      '--line-strong': '#4b3a7c',
      '--grid': 'rgba(255, 70, 200, 0.1)',
      '--fg': '#f5edff',
      '--fg-2': '#c9bbec',
      '--fg-3': '#a897d4',
      '--accent': '#ff3cb8',
      '--accent-hi': '#ff74cc',
      '--accent-ink': '#1c0014',
      '--accent-soft': 'rgba(255, 60, 184, 0.16)',
      '--accent-text': '#ff74cc',
      '--on-lane': '#0b0619',
      '--master': '#2ee6e6',
      '--master-soft': 'rgba(46, 230, 230, 0.16)',
      '--orig': '#a98bff',
      '--orig-soft': 'rgba(169, 139, 255, 0.16)',
      '--good': '#6ff28a',
      '--warn': '#ffd23f',
      '--crit': '#ff6a3d',
      '--info': '#6fb0ff',
      '--led-off': '#2c2050',
      '--wave-dim': '0.42',
      '--wave-ghost': '0.22',
      '--glow': '0 0 12px',
      '--toast-shadow': '0 0 0 1px rgba(255, 60, 184, 0.22), 0 14px 36px rgba(5, 0, 20, 0.7)',
    },
  },
  // Alto contrasto: pure black and white, yellow actions, light borders, no glow.
  contrast: {
    scheme: 'dark',
    tokens: {
      '--bg': '#000000',
      '--surface': '#000000',
      '--surface-2': '#141414',
      '--surface-3': '#333333',
      '--well': '#000000',
      '--line': '#a3a3a3',
      '--line-strong': '#ffffff',
      '--grid': 'rgba(255, 255, 255, 0.18)',
      '--fg': '#ffffff',
      '--fg-2': '#f0f0f0',
      '--fg-3': '#d6d6d6',
      '--accent': '#ffe500',
      '--accent-hi': '#fff280',
      '--accent-ink': '#000000',
      '--accent-soft': 'rgba(255, 229, 0, 0.2)',
      '--accent-text': '#ffe500',
      '--on-lane': '#000000',
      '--master': '#00d9ff',
      '--master-soft': 'rgba(0, 217, 255, 0.2)',
      '--orig': '#d0d0d0',
      '--orig-soft': 'rgba(208, 208, 208, 0.18)',
      '--good': '#3dff6e',
      '--warn': '#ff9a1f',
      '--crit': '#ff4d4d',
      '--info': '#7ab8ff',
      '--led-off': '#3d3d3d',
      '--wave-dim': '0.55',
      '--wave-ghost': '0.35',
      '--glow': '0 0 0',
      '--toast-shadow': '0 0 0 1px #ffffff, 0 10px 30px rgba(0, 0, 0, 0.6)',
    },
  },
};

/** Skin ids in menu order. 'auto' has no palette: it follows the viewer / system. */
export const SKIN_IDS = ['auto', 'dark', 'light', 'fluo', 'analog', 'synthwave', 'contrast'];

const swatchOf = (p) => ({ bg: p.tokens['--bg'], line: p.tokens['--line-strong'], accent: p.tokens['--accent'], master: p.tokens['--master'], orig: p.tokens['--orig'] });

/**
 * Skins for the picker: id, i18n keys (label + one-line description), color scheme and the
 * swatch colors. 'auto' shows the dark and light backgrounds split diagonally.
 */
export const SKINS = SKIN_IDS.map((id) => {
  const p = PALETTES[id];
  const swatch = p ? swatchOf(p) : { ...swatchOf(PALETTES.dark), split: [PALETTES.dark.tokens['--bg'], PALETTES.light.tokens['--bg']] };
  return Object.freeze({ id, labelKey: `skin.${id}`, descKey: `skin.${id}.desc`, scheme: p ? p.scheme : null, swatch: Object.freeze(swatch) });
});

/** @param {string} id @returns {boolean} */
export const isSkin = (id) => SKIN_IDS.includes(id);

// --- CSS ---------------------------------------------------------------------------------

/** One skin's rule. */
export function skinRule(id) {
  const p = PALETTES[id];
  if (!p) return '';
  const decls = COLOR_TOKENS.map((k) => `  ${k}: ${p.tokens[k]};`).join('\n');
  return `html:root[data-am-skin="${id}"] {\n  color-scheme: ${p.scheme};\n${decls}\n}`;
}

// The picker's own look, built only from tokens so it fits every skin (and 'auto').
// Scoped class names 'skin-*'. Selectors carry two classes where the app's
// `.am-root :focus-visible` (0,2,0) would otherwise compete on order.
const PICKER_CSS = `
.skin-pick { position: relative; display: inline-flex; flex: none; }
.skin-btn {
  display: inline-flex; align-items: center; gap: 7px;
  min-height: 28px; padding: 3px 8px 3px 4px; margin: 0;
  background: var(--well); color: var(--fg-2);
  border: 1px solid var(--line); border-radius: var(--r, 4px);
  font: 600 11.5px/1.2 var(--font-mono, ui-monospace, monospace);
  cursor: pointer; transition: color 0.12s, border-color 0.12s;
}
.skin-btn:hover { color: var(--fg); border-color: var(--line-strong); }
.skin-pick .skin-btn[aria-expanded="true"] { color: var(--fg); border-color: var(--accent); }
.skin-pick .skin-btn:focus-visible { outline: 2px solid var(--accent-hi); outline-offset: 2px; }
.skin-btn-label { white-space: nowrap; }
.skin-chev { display: inline-flex; color: var(--fg-3); transition: transform 0.15s ease; }
.skin-chev svg { display: block; }
.skin-btn[aria-expanded="true"] .skin-chev { transform: rotate(180deg); }
.skin-sw {
  display: inline-block; flex: none; width: 20px; height: 20px; border-radius: 3px;
  box-shadow: inset 0 0 0 1px var(--sw-line, var(--line-strong));
}
.skin-menu {
  position: fixed; z-index: 80; box-sizing: border-box;
  width: min(300px, calc(100vw - 16px)); overflow: auto;
  max-height: calc(100vh - 16px); max-height: calc(100dvh - 16px);
  overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 6px;
  background: var(--surface-2); color: var(--fg);
  border: 1px solid var(--line-strong); border-radius: var(--r-lg, 6px);
  box-shadow: var(--toast-shadow);
  font-family: var(--font-ui, system-ui, sans-serif);
  animation: skin-pop 0.12s ease-out;
}
.skin-menu[hidden] { display: none !important; }
.skin-menu-title {
  margin: 0; padding: 4px 8px 6px;
  font-size: 10.5px; font-weight: 650; letter-spacing: 0.16em; line-height: 1.3;
  text-transform: uppercase; color: var(--fg-3);
}
.skin-item {
  display: grid; grid-template-columns: 28px minmax(0, 1fr) 16px; align-items: center; gap: 10px;
  width: 100%; min-height: 44px; margin: 0; padding: 7px 8px;
  border: 0; border-radius: var(--r, 4px); background: transparent; color: var(--fg);
  font: inherit; text-align: left; cursor: pointer;
}
.skin-item:hover { background: var(--surface-3); }
.skin-menu .skin-item:focus-visible { outline: 2px solid var(--accent-hi); outline-offset: -2px; }
.skin-menu .skin-item:focus-visible:not([aria-checked="true"]) { background: var(--surface-3); }
.skin-item[aria-checked="true"] { background: var(--accent-soft); box-shadow: inset 0 0 0 1.5px var(--accent); }
.skin-item .skin-sw { width: 28px; height: 28px; border-radius: 4px; }
.skin-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.skin-name { font-size: 13px; font-weight: 600; line-height: 1.2; }
.skin-desc { font-size: 11.5px; line-height: 1.3; color: var(--fg-2); }
.skin-check { display: inline-flex; color: var(--accent-text); visibility: hidden; }
.skin-check svg { display: block; }
.skin-item[aria-checked="true"] .skin-check { visibility: visible; }
@keyframes skin-pop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@media (pointer: coarse) {
  .skin-btn { min-height: 40px; min-width: 40px; padding: 4px 10px 4px 6px; }
  .skin-item { min-height: 48px; }
}
@media (prefers-reduced-motion: reduce) {
  .skin-menu { animation: none; }
  .skin-btn, .skin-chev { transition: none; }
}
@media (forced-colors: active) {
  .skin-item[aria-checked="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
}
/* Alto contrasto: heavier focus rings and doubled panel / well borders (inset rings, so
   nothing moves). */
html:root[data-am-skin="contrast"] .am-root :focus-visible { outline-width: 3px; }
html:root[data-am-skin="contrast"] :is(.panel, .seg, .pbar, .skin-btn) { box-shadow: inset 0 0 0 1px var(--line); }
`;

/** The whole stylesheet text of #am-skins. */
export function skinCss() {
  return SKIN_IDS.filter((id) => PALETTES[id]).map(skinRule).join('\n') + '\n' + PICKER_CSS;
}

function doc() {
  try {
    return globalThis.document || null;
  } catch {
    return null;
  }
}

/** Inject (once) or move <style id="am-skins"> to the end of <head>. */
export function ensureSkinStyles() {
  const d = doc();
  if (!d || typeof d.createElement !== 'function') return null;
  try {
    let el = d.getElementById ? d.getElementById(STYLE_ID) : null;
    if (!el) {
      el = d.createElement('style');
      el.id = STYLE_ID;
      el.textContent = skinCss();
    }
    const parent = d.head || d.documentElement;
    if (parent && parent.lastElementChild !== el) parent.appendChild(el);
    return el;
  } catch {
    return null;
  }
}

// --- State -------------------------------------------------------------------------------

let current = 'auto';
const listeners = new Set();

function readStored() {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isSkin(v) ? v : null;
  } catch {
    return null;
  }
}

function writeStored(id) {
  try {
    if (id === 'auto') globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

function applyToDocument(id) {
  const d = doc();
  const root = d && d.documentElement;
  if (!root) return;
  try {
    ensureSkinStyles();
    if (id === 'auto') root.removeAttribute('data-am-skin');
    else root.setAttribute('data-am-skin', id);
    // Exactly one am-skin-* class: a class change is what the app's observer repaints on.
    const cl = root.classList;
    if (cl) {
      for (const c of Array.from(cl)) if (c.startsWith(CLASS_PREFIX) && c !== CLASS_PREFIX + id) cl.remove(c);
      cl.add(CLASS_PREFIX + id);
    }
    const metas = d.querySelectorAll ? d.querySelectorAll('meta[name="theme-color"]') : [];
    for (const m of Array.from(metas)) {
      if (!m.hasAttribute('data-am-orig')) m.setAttribute('data-am-orig', m.getAttribute('content') || '');
      const p = PALETTES[id];
      m.setAttribute('content', p ? p.tokens['--bg'] : m.getAttribute('data-am-orig'));
    }
  } catch {
    /* a broken DOM must not break the app */
  }
}

/** @returns {string} the active skin id ('auto' until initSkin / setSkin). */
export function getSkin() {
  return current;
}

/**
 * Apply a skin, persist it (best effort) and notify listeners when it changed.
 * Unknown ids are ignored. Never throws.
 * @param {string} id
 * @param {{ persist?: boolean }} [opts]
 * @returns {string} the active skin id
 */
export function setSkin(id, opts = {}) {
  if (!isSkin(id)) return current;
  const prev = current;
  current = id;
  applyToDocument(id);
  if (opts.persist !== false) writeStored(id);
  if (prev !== id) for (const fn of [...listeners]) {
    try {
      fn(id, prev);
    } catch (e) {
      try {
        console.error(e);
      } catch {
        /* no console */
      }
    }
  }
  return current;
}

/**
 * Subscribe to skin changes.
 * @param {(id: string, prev: string) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onSkinChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Boot: inject the skin styles and apply the stored skin ('auto' when none). Call it as
 * early as possible (before createApp) so the first paint already has the right colors.
 * @returns {string} the active skin id
 */
export function initSkin() {
  ensureSkinStyles();
  return setSkin(readStored() || 'auto', { persist: false });
}

// --- Picker ------------------------------------------------------------------------------

/** CSS background of a swatch: the skin's background, an accent LED, master over original. */
export function swatchBackground(sw) {
  const base = sw.split ? `linear-gradient(135deg, ${sw.split[0]} 0 50%, ${sw.split[1]} 50% 100%)` : `linear-gradient(${sw.bg}, ${sw.bg})`;
  return [
    `radial-gradient(circle at 32% 50%, ${sw.accent} 0 17%, transparent 19%)`,
    `linear-gradient(${sw.master} 0 50%, ${sw.orig} 50% 100%) 70% 50% / 22% 56% no-repeat`,
    base,
  ].join(', ');
}

/**
 * Index the menu focus moves to for a key, or null when the key is not a navigation key.
 * @param {string} key KeyboardEvent.key
 * @param {number} i current index (-1 = none)
 * @param {number} n number of items
 */
export function menuIndexForKey(key, i, n) {
  if (!(n > 0)) return null;
  if (key === 'ArrowDown') return i < 0 ? 0 : (i + 1) % n;
  if (key === 'ArrowUp') return i < 0 ? n - 1 : (i - 1 + n) % n;
  if (key === 'Home' || key === 'PageUp') return 0;
  if (key === 'End' || key === 'PageDown') return n - 1;
  return null;
}

/**
 * Where the menu goes, in viewport pixels (it is position: fixed). Below the button and
 * right-aligned with it; above when it does not fit below and there is more room above.
 * When it fits on neither side it is capped to the room on the chosen side (and scrolls),
 * never under 120 px nor over the viewport. Both edges stay 8 px inside the viewport.
 * null when the button is outside the viewport: the caller closes the menu instead of
 * leaving it floating over the page, detached from its button.
 * @param {{ top: number, bottom: number, right: number }} r the button's client rect
 * @param {number} w menu width
 * @param {number} h menu height without any max-height
 * @param {number} vw viewport width
 * @param {number} vh viewport height
 * @returns {{ left: number, top: number, maxHeight: number | null, up: boolean } | null}
 *   maxHeight null = no cap needed
 */
export function menuPlacement(r, w, h, vw, vh) {
  const M = 8; // viewport margin
  const GAP = 6; // between button and menu
  const MIN = 120; // smallest capped height that still shows two items
  if (vh > 0 && (r.bottom <= 0 || r.top >= vh)) return null;
  const left = Math.floor(Math.max(M, Math.min(r.right - w, vw - M - w)));
  if (!(vh > 0)) return { left, top: Math.floor(r.bottom + GAP), maxHeight: null, up: false }; // no layout
  const below = vh - M - (r.bottom + GAP);
  const above = r.top - GAP - M;
  const up = h > below && above > below;
  const room = Math.floor(up ? above : below);
  const maxHeight = h > room ? Math.max(1, Math.min(Math.max(MIN, room), vh - 2 * M)) : null;
  const mh = maxHeight === null ? h : Math.min(h, maxHeight);
  const top = Math.floor(Math.max(M, Math.min(up ? r.top - GAP - mh : r.bottom + GAP, vh - M - mh)));
  return { left, top, maxHeight, up };
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(d, size) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function el(tag, cls, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

let pickerSeq = 0;

/**
 * The "Tema" control: a compact button (current swatch + label) that opens a menu of
 * skins (role=menu, menuitemradio items). Keyboard: Enter / Space / ↓ / ↑ open it on the
 * current skin; ↑ ↓ Home End move; Enter / Space choose; Esc closes; focus returns to the
 * button. Closes on outside click, Tab, choice, and when the page scrolls the button out of
 * view. On short viewports the menu is capped to the room beside the button and scrolls
 * (menuPlacement). Relabels itself on language change.
 * @param {{ t?: (key: string, vars?: object) => string, onChange?: (id: string) => void }} [opts]
 * @returns {HTMLElement & { relabel(): void, close(focus?: boolean): void, destroy(): void }}
 */
export function createSkinPicker(opts = {}) {
  const tr = typeof opts.t === 'function' ? opts.t : i18nT;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  ensureSkinStyles();
  const uid = `am-skin-${++pickerSeq}`;

  const wrap = el('div', 'skin-pick');
  const btn = el('button', 'skin-btn', { type: 'button', id: `${uid}-btn`, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': `${uid}-menu` });
  const btnSw = el('span', 'skin-sw', { 'aria-hidden': 'true' });
  const btnLabel = el('span', 'skin-btn-label');
  const chev = el('span', 'skin-chev', { 'aria-hidden': 'true' });
  chev.append(svgIcon('M4 6l4 4 4-4', 12));
  btn.append(btnSw, btnLabel, chev);

  const menu = el('div', 'skin-menu', { id: `${uid}-menu`, role: 'menu', 'aria-labelledby': `${uid}-title` });
  menu.hidden = true;
  const title = el('p', 'skin-menu-title', { id: `${uid}-title` });
  menu.append(title);
  const items = SKINS.map((s) => {
    const item = el('button', 'skin-item', { type: 'button', role: 'menuitemradio', tabindex: '-1', 'data-skin': s.id, 'aria-checked': 'false', 'aria-describedby': `${uid}-${s.id}-d` });
    const sw = el('span', 'skin-sw', { 'aria-hidden': 'true' });
    sw.style.background = swatchBackground(s.swatch);
    sw.style.setProperty('--sw-line', s.swatch.line);
    const text = el('span', 'skin-text');
    const name = el('span', 'skin-name');
    const desc = el('span', 'skin-desc', { id: `${uid}-${s.id}-d` });
    text.append(name, desc);
    const check = el('span', 'skin-check', { 'aria-hidden': 'true' });
    check.append(svgIcon('M3.5 8.5l3 3 6-7', 14));
    item.append(sw, text, check);
    item.addEventListener('click', () => choose(s.id));
    menu.append(item);
    return { s, item, name, desc };
  });
  wrap.append(btn, menu);

  function relabel() {
    const cur = SKINS.find((s) => s.id === current) || SKINS[0];
    btnLabel.textContent = tr('skin.label');
    btn.setAttribute('aria-label', tr('skin.button', { name: tr(cur.labelKey) }));
    title.textContent = tr('skin.menu');
    for (const { s, item, name, desc } of items) {
      name.textContent = tr(s.labelKey);
      desc.textContent = tr(s.descKey);
      item.setAttribute('aria-label', tr(s.labelKey));
    }
  }

  function sync() {
    const cur = SKINS.find((s) => s.id === current) || SKINS[0];
    btnSw.style.background = swatchBackground(cur.swatch);
    btnSw.style.setProperty('--sw-line', cur.swatch.line);
    wrap.setAttribute('data-skin', cur.id);
    for (const { s, item } of items) item.setAttribute('aria-checked', String(s.id === cur.id));
    relabel();
  }

  const isOpen = () => !menu.hidden;

  // Smaller of the two heights: innerHeight counts a horizontal scrollbar, and on iOS
  // clientHeight is the viewport with the toolbars shown.
  const viewportH = () => {
    const hs = [window.innerHeight, document.documentElement.clientHeight].filter((v) => v > 0);
    return hs.length ? Math.min(...hs) : 0;
  };

  // On open, resize and any scroll (capture). The menu's own scrolling is ignored: it moves
  // nothing, and re-measuring would reset its scroll position.
  function place(e) {
    const tgt = e && e.target;
    if (tgt && tgt.nodeType === 1 && menu.contains(tgt)) return;
    const r = btn.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth || 0;
    const st = menu.scrollTop;
    menu.style.maxHeight = 'none'; // measure the natural height
    const p = menuPlacement(r, menu.offsetWidth, menu.offsetHeight, vw, viewportH());
    if (!p) {
      // The button scrolled out of view: close, keeping keyboard focus on the button
      // without scrolling the page back.
      const hadFocus = menu.contains(document.activeElement);
      menu.style.maxHeight = '';
      close(false);
      if (hadFocus) {
        try {
          btn.focus({ preventScroll: true });
        } catch {
          /* old engines: focus stays where it was */
        }
      }
      return;
    }
    menu.style.maxHeight = p.maxHeight === null ? '' : `${p.maxHeight}px`;
    menu.style.left = `${p.left}px`;
    menu.style.top = `${p.top}px`;
    if (st) menu.scrollTop = st;
  }

  function focusItem(i) {
    const it = items[i];
    if (it) it.item.focus();
  }

  function open(focusIndex) {
    if (!isOpen()) {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onOutside, true);
      window.addEventListener('resize', place);
      window.addEventListener('scroll', place, true);
      place();
      if (!isOpen()) return; // the button is off-screen: place() closed the menu again
    }
    const cur = items.findIndex((x) => x.s.id === current);
    focusItem(focusIndex === 'last' ? items.length - 1 : focusIndex === 'first' ? 0 : Math.max(0, cur));
  }

  function close(focusButton = true) {
    if (!isOpen()) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    if (focusButton) btn.focus();
  }

  function choose(id) {
    setSkin(id);
    close(true);
    if (onChange) {
      try {
        onChange(id);
      } catch (e) {
        console.error(e);
      }
    }
  }

  function onOutside(e) {
    if (!wrap.contains(e.target)) close(false);
  }

  btn.addEventListener('click', () => (isOpen() ? close(true) : open()));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open(e.key === 'ArrowUp' ? 'last' : undefined);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close(true);
    }
  });
  menu.addEventListener('keydown', (e) => {
    const i = items.findIndex((x) => x.item === document.activeElement);
    const next = menuIndexForKey(e.key, i, items.length);
    if (next !== null) {
      e.preventDefault();
      focusItem(next);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close(false);
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Type-ahead: next skin whose name starts with the letter.
      const ch = e.key.toLowerCase();
      for (let k = 1; k <= items.length; k++) {
        const j = (Math.max(i, 0) + k) % items.length;
        if (items[j].name.textContent.trim().toLowerCase().startsWith(ch)) {
          e.preventDefault();
          focusItem(j);
          break;
        }
      }
      // Global single-key shortcuts (B = A/B) must not fire while the menu has focus.
      e.stopPropagation();
    }
  });

  const offSkin = onSkinChange(sync);
  const offLang = onLanguageChange(relabel);
  sync();

  wrap.relabel = relabel;
  wrap.close = close;
  wrap.destroy = () => {
    close(false);
    offSkin();
    offLang();
  };
  return wrap;
}
