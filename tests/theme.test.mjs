// Interface skins (src/ui/theme.js): palette completeness, parity of 'dark' / 'light' with
// styles.css, WCAG contrast computed from every palette, the generated CSS, and the
// setSkin / getSkin / persistence / listener contract against a minimal fake document.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assert, rng } from './helpers.mjs';
import { COLOR_TOKENS, PALETTES, SKINS, SKIN_IDS, skinCss, skinRule, menuIndexForKey, menuPlacement, swatchBackground } from '../src/ui/theme.js';
import { STRINGS, LANGUAGES } from '../src/ui/i18n.js';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, '../src/ui/styles.css'), 'utf8');
const NON_COLOR = ['--font-ui', '--font-mono', '--r', '--r-lg'];

// --- color math (sRGB, WCAG 2.x relative luminance, CIELAB ΔE76) ---------------------------

function parseColor(c) {
  const s = String(c).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m && [m[1], m[2], m[3]].every((v) => +v <= 255) && (m[4] === undefined || +m[4] <= 1)) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

const col = (c) => {
  const p = typeof c === 'string' ? parseColor(c) : c;
  if (!p) throw new Error(`not a color: ${c}`);
  return p;
};

/** `top` (possibly translucent) composited over an opaque `bottom`. */
function over(top, bottom) {
  const f = col(top);
  const b = col(bottom);
  const mix = (x, y) => x * f.a + y * (1 - f.a);
  return { r: mix(f.r, b.r), g: mix(f.g, b.g), b: mix(f.b, b.b), a: 1 };
}

const lin = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const luminance = (c) => {
  const p = col(c);
  return 0.2126 * lin(p.r) + 0.7152 * lin(p.g) + 0.0722 * lin(p.b);
};
const ratio = (a, b) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
function lab(c) {
  const p = col(c);
  const R = lin(p.r);
  const G = lin(p.g);
  const B = lin(p.b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const deltaE = (a, b) => {
  const p = lab(a);
  const q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
};

// --- styles.css parsing -------------------------------------------------------------------

/** Declarations of the first block opened by `selector` (exact text before '{'). */
function cssBlock(selector) {
  const i = CSS.indexOf(selector + ' {');
  assert(i >= 0, `styles.css: block "${selector}" not found`);
  const s = CSS.indexOf('{', i);
  const e = CSS.indexOf('}', s);
  const body = CSS.slice(s + 1, e).replace(/\/\*[\s\S]*?\*\//g, '');
  const out = {};
  for (const m of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const norm = (v) => String(v).trim().toLowerCase().replace(/\s+/g, ' ');

/** Split on commas outside parentheses (`:is(.a, .b)` stays whole). */
function splitTop(s, sep = ',') {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Every rule of styles.css, at top level or inside @media: { sels, decl }. */
function cssRules() {
  const src = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim().replace(/\s+/g, ' ');
    if (head.startsWith('@')) continue;
    const decl = {};
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)) decl[d[1]] = norm(d[2]);
    out.push({ sels: splitTop(head), decl });
  }
  return out;
}

/** The compound selector a selector styles (after its last top-level combinator). */
function subject(sel) {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
  }
  return sel.slice(cut);
}

function assertSameAsCss(id, block, where) {
  const p = PALETTES[id];
  const bad = [];
  if (norm(block['color-scheme']) !== p.scheme) bad.push(`color-scheme ${block['color-scheme']} ≠ ${p.scheme}`);
  for (const k of COLOR_TOKENS) if (norm(block[k]) !== norm(p.tokens[k])) bad.push(`${k}: styles.css ${block[k]} ≠ theme.js ${p.tokens[k]}`);
  assert(!bad.length, `${id} vs ${where}: ${bad.join('; ')}`);
}

// --- WCAG checks ----------------------------------------------------------------------------

/** Every failed check of a palette, as readable strings. */
function contrastFailures(id) {
  const p = PALETTES[id].tokens;
  const strict = id === 'contrast';
  const text = strict ? 7 : 4.5;
  const fails = [];
  const need = (label, v, min) => {
    if (!(v >= min)) fails.push(`${label} ${v.toFixed(2)} < ${min}`);
  };
  for (const bg of ['--bg', '--surface', '--surface-2']) need(`--fg on ${bg}`, ratio(p['--fg'], p[bg]), text);
  for (const fg of ['--fg-2', '--fg-3']) {
    need(`${fg} on --surface`, ratio(p[fg], p['--surface']), strict ? 7 : 4.5);
    need(`${fg} on --surface-2`, ratio(p[fg], p['--surface-2']), 4.5);
    need(`${fg} on --well`, ratio(p[fg], p['--well']), 4.5);
  }
  need('--accent-text on --surface', ratio(p['--accent-text'], p['--surface']), text);
  need('--accent-text on --accent-soft/--surface', ratio(p['--accent-text'], over(p['--accent-soft'], p['--surface'])), 4.5);
  need('--fg on --accent-soft/--well (lit segment)', ratio(p['--fg'], over(p['--accent-soft'], p['--well'])), 4.5);
  need('--fg-2 on --accent-soft/--surface-2 (chosen skin row)', ratio(p['--fg-2'], over(p['--accent-soft'], p['--surface-2'])), 4.5);
  need('--fg on --surface-3 (hover)', ratio(p['--fg'], p['--surface-3']), 4.5);
  need('--accent-ink on --accent', ratio(p['--accent-ink'], p['--accent']), 4.5);
  need('--accent-ink on --accent-hi (hover)', ratio(p['--accent-ink'], p['--accent-hi']), 4.5);
  need('--accent on --surface (text buttons)', ratio(p['--accent'], p['--surface']), 4.5);
  // .btn-text sits on --well too (help hint "Ho capito") and on --surface-2 (toast actions);
  // its hover color is --accent-hi.
  for (const bg of ['--well', '--surface-2']) need(`--accent-text on ${bg} (text buttons)`, ratio(p['--accent-text'], p[bg]), 4.5);
  for (const bg of ['--surface', '--surface-2', '--well']) need(`--accent-hi on ${bg} (text-button hover)`, ratio(p['--accent-hi'], p[bg]), 4.5);
  need('--fg on --accent-soft/--surface (drop overlay)', ratio(p['--fg'], over(p['--accent-soft'], p['--surface'])), 4.5);
  for (const bg of ['--bg', '--surface', '--surface-2']) need(`--accent-hi focus ring on ${bg}`, ratio(p['--accent-hi'], p[bg]), 3);
  need('--on-lane on --orig', ratio(p['--on-lane'], p['--orig']), 4.5);
  need('--on-lane on --master', ratio(p['--on-lane'], p['--master']), 4.5);
  for (const s of ['--good', '--warn', '--crit', '--info']) need(`${s} on --surface`, ratio(p[s], p['--surface']), 3);
  for (const s of ['--orig', '--master']) need(`${s} on --well`, ratio(p[s], p['--well']), 3);
  need('ΔE --orig / --master (lanes distinct)', deltaE(p['--orig'], p['--master']), 25);
  need('ΔE --accent / --crit', deltaE(p['--accent'], p['--crit']), 20);
  need('ΔE --accent / --warn', deltaE(p['--accent'], p['--warn']), 20);
  need('--line-strong on --surface (visible border)', ratio(p['--line-strong'], p['--surface']), 1.5);
  if (strict) {
    need('--line on --surface (non-text 3:1)', ratio(p['--line'], p['--surface']), 3);
    need('--glow is none', p['--glow'].split(/\s+/).every((x) => parseFloat(x) === 0) ? 1 : 0, 1);
  }
  return fails;
}

// --- fake DOM -------------------------------------------------------------------------------

function fakeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    contains: (c) => set.has(c),
    [Symbol.iterator]: () => set.values(),
    get length() {
      return set.size;
    },
  };
}

function fakeElement(tag) {
  const attrs = new Map();
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentNode: null,
    textContent: '',
    classList: fakeClassList(),
    style: {},
    get id() {
      return attrs.get('id') || '';
    },
    set id(v) {
      attrs.set('id', String(v));
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    hasAttribute: (k) => attrs.has(k),
    removeAttribute: (k) => attrs.delete(k),
    get lastElementChild() {
      return node.children[node.children.length - 1] || null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.children.splice(child.parentNode.children.indexOf(child), 1);
      node.children.push(child);
      child.parentNode = node;
      return child;
    },
  };
  return node;
}

function fakeDocument() {
  const html = fakeElement('html');
  const head = fakeElement('head');
  html.appendChild(head);
  head.appendChild(fakeElement('link'));
  const metas = ['#0c0f13', '#e6eaef'].map((c) => {
    const m = fakeElement('meta');
    m.setAttribute('name', 'theme-color');
    m.setAttribute('content', c);
    head.appendChild(m);
    return m;
  });
  html.classList.add('host-class');
  const all = () => [head, ...head.children];
  return {
    documentElement: html,
    head,
    metas,
    createElement: (tag) => fakeElement(tag),
    getElementById: (id) => all().find((e) => e.id === id) || null,
    querySelectorAll: (sel) => (sel === 'meta[name="theme-color"]' ? metas : []),
  };
}

function fakeStorage(init = {}, { throws = false } = {}) {
  const map = new Map(Object.entries(init));
  const guard = () => {
    if (throws) throw new Error('SecurityError');
  };
  return {
    map,
    getItem: (k) => (guard(), map.has(k) ? map.get(k) : null),
    setItem: (k, v) => (guard(), map.set(k, String(v))),
    removeItem: (k) => (guard(), map.delete(k)),
  };
}

/** Run `fn` with fake document / localStorage globals and a fresh theme.js instance. */
async function withFakes({ doc, storage }, tag, fn) {
  const saved = {};
  for (const k of ['document', 'localStorage']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  try {
    if (doc !== undefined) def('document', doc);
    if (storage !== undefined) def('localStorage', storage);
    const m = await import(`../src/ui/theme.js?${tag}`);
    return await fn(m);
  } finally {
    for (const [k, d] of Object.entries(saved)) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete globalThis[k];
    }
  }
}

const skinClasses = (html) => [...html.classList].filter((c) => c.startsWith('am-skin-'));

// --- tests ------------------------------------------------------------------------------------

export const tests = {
  'theme: skins in menu order, auto first, one palette per skin': () => {
    assert(SKIN_IDS.join() === 'auto,dark,light,fluo,analog,synthwave,contrast', SKIN_IDS.join());
    assert(SKINS.map((s) => s.id).join() === SKIN_IDS.join());
    assert(!PALETTES.auto, "'auto' has no palette: it follows the viewer");
    for (const id of SKIN_IDS.slice(1)) assert(PALETTES[id] && (PALETTES[id].scheme === 'dark' || PALETTES[id].scheme === 'light'), `${id}: palette / scheme`);
    for (const s of SKINS) {
      for (const k of ['bg', 'accent', 'master', 'orig', 'line']) assert(parseColor(s.swatch[k]), `${s.id}: swatch.${k}`);
      assert(swatchBackground(s.swatch).includes(s.swatch.accent), `${s.id}: swatch background`);
    }
    assert(SKINS[0].swatch.split.length === 2, 'auto swatch shows dark and light');
  },

  'theme: COLOR_TOKENS = every color token of styles.css :root': () => {
    const root = Object.keys(cssBlock(':root')).filter((k) => k.startsWith('--') && !NON_COLOR.includes(k));
    const missing = root.filter((k) => !COLOR_TOKENS.includes(k));
    const extra = COLOR_TOKENS.filter((k) => !root.includes(k));
    assert(!missing.length && !extra.length, `add to theme.js: ${missing.join(', ') || '—'} · not in styles.css: ${extra.join(', ') || '—'}`);
    assert(new Set(COLOR_TOKENS).size === COLOR_TOKENS.length, 'duplicate token');
    return `${COLOR_TOKENS.length} tokens`;
  },

  'theme: every skin defines every token with a valid value': () => {
    const bad = [];
    for (const [id, p] of Object.entries(PALETTES)) {
      const keys = Object.keys(p.tokens);
      for (const k of keys) if (!COLOR_TOKENS.includes(k)) bad.push(`${id}: unknown ${k}`);
      for (const k of COLOR_TOKENS) {
        const v = p.tokens[k];
        if (typeof v !== 'string' || !v.trim()) bad.push(`${id}: missing ${k}`);
        else if (k === '--wave-dim' || k === '--wave-ghost') {
          if (!(Number(v) > 0 && Number(v) <= 1)) bad.push(`${id}: ${k} ${v}`);
        } else if (k === '--glow') {
          if (!/^0 0 \d+(\.\d+)?(px)?$/.test(v)) bad.push(`${id}: ${k} ${v}`);
        } else if (k === '--toast-shadow') {
          if (!/\d/.test(v) || /;|\}/.test(v)) bad.push(`${id}: ${k} ${v}`);
        } else if (!parseColor(v)) bad.push(`${id}: ${k} not a color: ${v}`);
      }
      // Solid colors must be opaque (contrast is computed on them); only these are tints.
      for (const k of COLOR_TOKENS) {
        const c = parseColor(p.tokens[k]);
        if (c && c.a < 1 && !['--grid', '--accent-soft', '--master-soft', '--orig-soft'].includes(k)) bad.push(`${id}: ${k} must be opaque`);
      }
    }
    assert(!bad.length, bad.join('; '));
  },

  'theme: dark / light palettes equal styles.css (no drift)': () => {
    assertSameAsCss('dark', cssBlock(':root'), ':root');
    assertSameAsCss('light', cssBlock(':root[data-theme="light"]'), ':root[data-theme="light"]');
    assertSameAsCss('light', cssBlock('  :root:not([data-theme="dark"])'), '@media (prefers-color-scheme: light)');
  },

  'theme: WCAG contrast of every palette': () => {
    const all = [];
    for (const id of Object.keys(PALETTES)) for (const f of contrastFailures(id)) all.push(`${id}: ${f}`);
    assert(!all.length, all.join('\n      '));
    const p = PALETTES.contrast.tokens;
    return `alto contrasto: fg/bg ${ratio(p['--fg'], p['--bg']).toFixed(1)}:1`;
  },

  'theme: generated CSS, one rule per palette that outranks styles.css': () => {
    const css = skinCss();
    for (const id of Object.keys(PALETTES)) {
      const rule = skinRule(id);
      // html:root[attr] = (0,2,1) > :root[data-theme] / :root:not([data-theme]) = (0,2,0)
      assert(rule.startsWith(`html:root[data-am-skin="${id}"] {`), `${id}: selector`);
      assert(rule.includes(`color-scheme: ${PALETTES[id].scheme};`), `${id}: color-scheme`);
      for (const k of COLOR_TOKENS) assert(rule.includes(`  ${k}: ${PALETTES[id].tokens[k]};`), `${id}: ${k}`);
      assert(css.includes(rule), `${id}: rule in skinCss()`);
    }
    assert(skinRule('auto') === '' && !css.includes('data-am-skin="auto"'), 'auto adds no rule');
    assert(!/data-am-skin/.test(CSS), 'styles.css must not style data-am-skin itself');
    // Braces balanced (a stray one would swallow the app stylesheet's rules after it).
    assert(css.split('{').length === css.split('}').length, 'unbalanced braces');
    assert(/@media \(prefers-reduced-motion: reduce\)/.test(css) && /@media \(pointer: coarse\)/.test(css), 'picker media queries');
    // 100vh fallback first, then 100dvh (iOS: the visible viewport, toolbars included).
    assert(/max-height: calc\(100vh - 16px\); max-height: calc\(100dvh - 16px\);/.test(css), 'menu max-height: 100vh then 100dvh');
  },

  // Readability fixes that live in styles.css: .btn-text on --well (help hint "Ho capito")
  // and the drop overlay text on the accent tint were --accent (light: 3.73 and 3.24:1);
  // placeholders had no rule (Chrome's #757575 on --well: 3.53 to 4.32:1 in four skins).
  // The tokens they move to are checked in every palette by the WCAG test above
  // (--accent-text on --well, --fg on the tint, --fg-3 on --well).
  'theme: styles.css text colors on --well and on the accent tint (lint)': () => {
    const rules = cssRules();
    const styled = (cls) => rules.filter((r) => r.sels.some((s) => new RegExp(`\\.${cls}(?![\\w-])`).test(subject(s))));
    const base = (sel) => rules.find((r) => r.sels.length === 1 && r.sels[0] === sel);
    const ph = rules.filter((r) => r.sels.some((s) => /::placeholder$/.test(s)));
    const btn = base('.btn-text');
    const drop = base('.drop-overlay');
    assert(btn && drop, 'styles.css: .btn-text / .drop-overlay rules not found');
    const bad = [];
    for (const cls of ['btn-text', 'drop-overlay']) for (const r of styled(cls)) if (r.decl.color === 'var(--accent)') bad.push(`${r.sels.join(', ')} { color: var(--accent) }`);
    if (btn.decl.color !== 'var(--accent-text)') bad.push(`.btn-text color ${btn.decl.color} (want var(--accent-text))`);
    if (drop.decl.color !== 'var(--fg)') bad.push(`.drop-overlay color ${drop.decl.color} (want var(--fg))`);
    const scoped = ph.find((r) => r.sels.some((s) => /\.am-root\)? ::placeholder$/.test(s)));
    if (!scoped) bad.push('no `:where(.am-root) ::placeholder` rule');
    else if (scoped.decl.color !== 'var(--fg-3)' || scoped.decl.opacity !== '1') bad.push(`::placeholder { color: ${scoped.decl.color}; opacity: ${scoped.decl.opacity} } (want var(--fg-3), 1)`);
    assert(!bad.length, bad.join('; '));
  },

  'theme: i18n keys for the picker and every skin (it + en)': () => {
    const keys = ['skin.label', 'skin.menu', 'skin.button', ...SKINS.flatMap((s) => [s.labelKey, s.descKey])];
    const missing = [];
    for (const lang of LANGUAGES) for (const k of keys) if (typeof STRINGS[lang][k] !== 'string' || !STRINGS[lang][k].trim()) missing.push(`${lang}:${k}`);
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    for (const lang of LANGUAGES) {
      assert(STRINGS[lang]['skin.button'].includes('{name}'), `${lang}: skin.button needs {name}`);
      assert(STRINGS[lang]['skin.button'].includes(STRINGS[lang]['skin.label']), `${lang}: accessible name must contain the visible label`);
      for (const s of SKINS) assert(STRINGS[lang][s.descKey].length <= 48, `${lang}: ${s.descKey} is one short line`);
    }
    assert(STRINGS.it['skin.fluo'] === 'Fluo Techno' && STRINGS.it['skin.fluo.desc'] === 'Neon su nero, per le sessioni notturne');
  },

  'theme: menu keyboard navigation wraps': () => {
    assert(menuIndexForKey('ArrowDown', -1, 7) === 0);
    assert(menuIndexForKey('ArrowDown', 6, 7) === 0);
    assert(menuIndexForKey('ArrowUp', 0, 7) === 6);
    assert(menuIndexForKey('ArrowUp', -1, 7) === 6);
    assert(menuIndexForKey('Home', 4, 7) === 0 && menuIndexForKey('End', 1, 7) === 6);
    assert(menuIndexForKey('Enter', 2, 7) === null && menuIndexForKey('a', 2, 7) === null);
    assert(menuIndexForKey('ArrowDown', 0, 0) === null);
  },

  'theme: menu placement stays inside short viewports (menuPlacement)': () => {
    const W = 300;
    const H = 388; // natural menu height with a coarse pointer (7 items × 48 px + title)
    const end = (p, h = H) => p.top + (p.maxHeight === null ? h : Math.min(h, p.maxHeight));
    const s = (p) => JSON.stringify(p);
    // Phone landscape 667×375 (reported: menu 148..507, last three skins unreachable).
    let p = menuPlacement({ top: 105.75, bottom: 145.75, right: 107.6 }, W, H, 667, 375);
    assert(p && !p.up && p.top >= 151, `below the button: ${s(p)}`);
    assert(p.maxHeight >= 120 && end(p) <= 367, `capped to the room below: ${s(p)}`);
    assert(p.left === 8, 'clamped to the left margin');
    // 426×362, button bottom 74 (reported: 'Alto contrasto' entirely below the viewport).
    p = menuPlacement({ top: 34, bottom: 74, right: 418 }, W, H, 426, 362);
    assert(p && !p.up && end(p) <= 354 && p.left + W <= 418, s(p));
    // Fits below: no cap, right-aligned with the button.
    p = menuPlacement({ top: 10, bottom: 38, right: 900 }, W, H, 1280, 800);
    assert(!p.up && p.maxHeight === null && p.top === 44 && p.left === 600, s(p));
    // Fits only above: flips, uncapped.
    p = menuPlacement({ top: 700, bottom: 728, right: 900 }, W, H, 1280, 800);
    assert(p.up && p.maxHeight === null && end(p) <= 694 && p.top >= 8, s(p));
    // Fits on neither side, more room above: up, capped to the room above.
    p = menuPlacement({ top: 300, bottom: 340, right: 600 }, W, H, 800, 400);
    assert(p.up && p.maxHeight === 286 && p.top === 8 && end(p) <= 294, s(p));
    // Tiny viewport: as tall as the viewport allows, still inside it.
    p = menuPlacement({ top: 20, bottom: 50, right: 300 }, W, H, 320, 100);
    assert(p.maxHeight === 84 && p.top === 8, s(p));
    // Button scrolled out of view (reported: the menu stayed open at top 8): null = close.
    assert(menuPlacement({ top: -366, bottom: -326, right: 600 }, W, H, 667, 375) === null, 'scrolled above');
    assert(menuPlacement({ top: 375, bottom: 415, right: 600 }, W, H, 667, 375) === null, 'scrolled below');
    assert(menuPlacement({ top: -20, bottom: 10, right: 600 }, W, H, 667, 375) !== null, 'partly visible: placed');
    // No layout (hidden frame): finite, uncapped.
    p = menuPlacement({ top: 0, bottom: 0, right: 0 }, 0, 0, 0, 0);
    assert(p && Number.isFinite(p.left) && Number.isFinite(p.top) && p.maxHeight === null, s(p));

    // Sweep: both edges inside the 8 px margin; never over the button while one side has
    // the minimum room (120 px).
    const rnd = rng(7);
    for (let k = 0; k < 3000; k++) {
      const vw = 320 + Math.floor(rnd() * 1600);
      const vh = 140 + Math.floor(rnd() * 1000);
      const w = Math.min(W, vw - 16);
      const h = 300 + Math.floor(rnd() * 120);
      const bh = 28 + Math.floor(rnd() * 13);
      const top = -bh + 1 + rnd() * (vh + bh - 2);
      const r = { top, bottom: top + bh, right: w + rnd() * (vw - w) };
      const q = menuPlacement(r, w, h, vw, vh);
      const ctx = `${s(r)} ${w}×${h} in ${vw}×${vh} → ${s(q)}`;
      assert(q, `visible button → placed: ${ctx}`);
      assert(q.top >= 8 && end(q, h) <= vh - 8, `vertical: ${ctx}`);
      assert(q.left >= 8 && q.left + w <= vw - 8, `horizontal: ${ctx}`);
      if (Math.max(vh - 8 - (r.bottom + 6), r.top - 14) >= 120) assert(q.up ? end(q, h) <= r.top - 5 : q.top >= r.bottom + 5, `covers the button: ${ctx}`);
    }
  },

  'theme: initSkin / setSkin / getSkin / persistence / onSkinChange (fake DOM)': async () => {
    const doc = fakeDocument();
    const storage = fakeStorage({ 'am.skin': 'fluo' });
    await withFakes({ doc, storage }, 'fake-dom', (m) => {
      const html = doc.documentElement;
      assert(m.getSkin() === 'auto', 'auto before init');
      assert(m.initSkin() === 'fluo' && m.getSkin() === 'fluo', 'stored skin applied at boot');
      assert(html.getAttribute('data-am-skin') === 'fluo', 'data-am-skin');
      assert(skinClasses(html).join() === 'am-skin-fluo' && html.classList.contains('host-class'), 'class swapped, host classes kept');
      const styles = doc.head.children.filter((e) => e.id === 'am-skins');
      assert(styles.length === 1 && doc.head.lastElementChild === styles[0], 'one <style id="am-skins">, after the app stylesheet');
      assert(styles[0].textContent.includes('html:root[data-am-skin="fluo"]'), 'style text');
      assert(doc.metas.every((x) => x.getAttribute('content') === PALETTES.fluo.tokens['--bg']), 'theme-color follows the skin');

      const seen = [];
      const off = m.onSkinChange((id, prev) => seen.push(`${prev}>${id}`));
      assert(m.setSkin('synthwave') === 'synthwave', 'setSkin returns the id');
      assert(storage.map.get('am.skin') === 'synthwave', 'persisted');
      assert(skinClasses(html).join() === 'am-skin-synthwave', 'one am-skin-* class');
      m.setSkin('synthwave');
      assert(seen.join() === 'fluo>synthwave', `notified once per change: ${seen}`);
      assert(m.setSkin('nope') === 'synthwave' && m.getSkin() === 'synthwave', 'unknown id ignored');

      m.setSkin('light', { persist: false });
      assert(storage.map.get('am.skin') === 'synthwave', 'persist: false');
      m.setSkin('auto');
      assert(html.getAttribute('data-am-skin') === null, 'auto removes the attribute');
      assert(skinClasses(html).join() === 'am-skin-auto', 'auto class (repaint signal)');
      assert(!storage.map.has('am.skin'), 'auto clears the stored choice');
      assert(doc.metas.map((x) => x.getAttribute('content')).join() === '#0c0f13,#e6eaef', 'theme-color restored');
      assert(seen.join() === 'fluo>synthwave,synthwave>light,light>auto', seen.join());

      off();
      m.setSkin('contrast');
      assert(seen.length === 3, 'unsubscribed');
      m.onSkinChange(() => {
        throw new Error('listener bug');
      });
      const err = console.error;
      console.error = () => {};
      try {
        m.setSkin('analog');
      } finally {
        console.error = err;
      }
      assert(m.getSkin() === 'analog', 'a throwing listener does not break setSkin');
      m.initSkin();
      assert(doc.head.children.filter((e) => e.id === 'am-skins').length === 1, 'initSkin twice: still one style');
      assert(m.getSkin() === 'analog', 'stored analog re-applied');
    });
  },

  'theme: storage blocked, invalid value, no document — never throws': async () => {
    await withFakes({ doc: fakeDocument(), storage: fakeStorage({}, { throws: true }) }, 'blocked', (m) => {
      assert(m.initSkin() === 'auto', 'blocked storage → auto');
      assert(m.setSkin('fluo') === 'fluo', 'still applies in memory');
      assert(globalThis.document.documentElement.getAttribute('data-am-skin') === 'fluo');
    });
    await withFakes({ doc: fakeDocument(), storage: fakeStorage({ 'am.skin': 'purple' }) }, 'invalid', (m) => {
      assert(m.initSkin() === 'auto', 'unknown stored id → auto');
    });
    await withFakes({ doc: null, storage: fakeStorage({ 'am.skin': 'light' }) }, 'no-doc', (m) => {
      assert(m.initSkin() === 'light' && m.setSkin('dark') === 'dark', 'no DOM: state only');
      assert(m.ensureSkinStyles() === null);
    });
  },
};
